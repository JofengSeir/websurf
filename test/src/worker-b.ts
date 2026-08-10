/**
 * WorkerB — three.js 第一人称 BSP 渲染（OffscreenCanvas + WebGL；WAKEUP 唤醒驱动）。
 *
 * 对齐点（README 最新时序图 阶段3：渲染采样）：
 * - 握手：{type:'init-shared', shared: SAB}（main 已 transfer）+ {type:'init-canvas', canvas}
 *   （main 在 transferControlToOffscreen() 后 transfer 控制权）；顺序无关；
 *   消息回退模式（无 SAB）：{type:'init-msg', renderPort}——WorkerA 状态直连端口，
 *   shared-state 到达即缓存（readState 消费，"仅状态更新时重绘"语义与 SAB 一致）
 * - 场景：{type:'glb', bytes:ArrayBuffer}（主线程 BspProcessor export_glb_with_pakfile_models
 *   产物，transfer）→ GLTFLoader.parse 异步回调挂载；GLB 内嵌纹理在 Worker 内经
 *   createImageBitmap 解码（无需 DOM），外部 URL 贴图由 FileLoader(fetch) 加载——
 *   纹理异步就绪后首帧 renderer.render 上传，个别贴图报错不影响场景挂载
 * - 帧循环（自驱，**发布驱动**——渲染率 = WorkerA 物理发布率，不受显示刷新率限制）：
 *   MessageChannel 自投递续环 + waitRenderWakeup(RENDER_WAKEUP)：
 *   ① **主驱动** = WorkerA 每发布状态后的 notify（writeStateRaw → V++ → notify）——
 *      无 BSP 轻负载全速 1kHz 渲染（HUD 重绘/s 显示真实发布率）；有 BSP 重场景时
 *      渲染耗时自然节流（渲染期间错过的 notify 不积压，醒后只渲染最新状态）
 *   ② 主线程 wake() 的 store+notify 为帧对齐冗余（无等待者时无操作）
 *   ③ 超时兜底（**自适应**）：有数据（重绘）→ 20ms；无数据/重复参数（V 未变不重绘）
 *      → 100ms 长超时（降低无效唤醒/空转——性能优化；**发布 notify 不受超时影响**，
 *      数据源源不断更新时立即唤醒全力渲染）；消息回退模式无数据 → 100ms 低频自检
 *      （shared-state 到达时立即触发循环——响应及时）
 * - 采样与重绘（用户核心定调：渲染参数必须唯一来源于 WorkerA 的 1ms 无限制物理真理源——
 *   本地副本**只被 readState 更新**（无其他来源），Draw 只消费本地副本 → 渲染参数零污染）：
 *   ① shared.readState() 非阻塞 acquire 读 V：已更新 → 读最新槽 S[V&1]（double-check
 *      防撕裂）→ 刷新本地副本；未变 → 不重绘（状态未更新，上一帧画面保持——
 *      高频屏不再重复提交相同相机状态的无效 Draw Calls）
 *   ② 本地副本更新后 → 相机映射 → renderer.render(scene, camera)（渲染帧率不被
 *      TICK_RATE 限制，仅受物理发布率约束——物理 1kHz 发布时每帧都是新状态）
 * - readState 防撕裂：读 V → 读当前槽 S[V&1] 全部字段（pos/vel/yaw/pitch）→
 *   重读 V 校验（double-check），不一致以新版本重读一次
 *
 * 相机：第一人称（FPS 约定，与 game renderer-main.ts 一致）——
 *   camera.rotation.set(pitch*DEG2RAD, yaw*DEG2RAD, 0, 'YXZ')
 *   camera.position.set(pos.x, pos.y + EYE_STAND, pos.z)
 *   EYE_STAND = 64.09 固定站立眼高（与 game EYE_STAND 一致；状态槽无 eyeHeight，不处理蹲伏）
 *
 * HUD：OffscreenCanvas 只能挂一个 context（此处被 WebGL 占用）→ 状态摘要改为每秒一次
 *   postMessage {type:'status'} 回传 main，由 main 更新页面 DOM 文本（轻量，无 TextGeometry）。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TestShared, type SharedStateMsg, type SharedStateData } from './shared-state.js';

// ── 消息握手（与 main.ts 约定）──────────────────────────────────
interface InitSharedMessage {
  type: 'init-shared';
  shared: SharedArrayBuffer;
}
/** 消息回退模式初始化（无 SAB）：renderPort 为 WorkerA→WorkerB 状态发布直连端口。 */
interface InitMsgMessage {
  type: 'init-msg';
  renderPort: MessagePort;
}
interface InitCanvasMessage {
  type: 'init-canvas';
  canvas: OffscreenCanvas;
}
interface ResizeMessage {
  type: 'resize';
  width: number;
  height: number;
}
/** 场景 GLB（主线程 BspProcessor export_glb_with_pakfile_models 产物，transfer 到达）。 */
interface GlbMessage {
  type: 'glb';
  bytes: ArrayBuffer;
}
/** PVS 数据（主线程 BspProcessor parse_pvs_data 产物；先于 GLB 发送——同信道保序）。 */
interface PvsMessage {
  type: 'pvs';
  pvsJson: string;
}
/** trace 路径节点（main 转发 WorkerA——3D 世界坐标，场景中画两条线）。 */
interface TracePointMessage {
  type: 'trace-point';
  baseX: number;
  baseY: number;
  baseZ: number;
  tickX: number;
  tickY: number;
  tickZ: number;
}
/** trace 清除（按钮"删除"——清空路径线）。 */
interface TraceClearMessage {
  type: 'trace-clear';
}
type WorkerBMessage =
  | InitSharedMessage
  | InitMsgMessage
  | InitCanvasMessage
  | ResizeMessage
  | GlbMessage
  | PvsMessage
  | TracePointMessage
  | TraceClearMessage;

/** WorkerB → main 状态摘要（每秒一次；main 更新 DOM HUD）。 */
interface StatusMessage {
  type: 'status';
  v: number;
  pos: { x: number; y: number; z: number } | null;
  vel: { x: number; y: number; z: number } | null;
  yaw: number | null;
  pitch: number | null;
  glbReady: boolean;
  fps: number;
  repaintSec: number;
}

// ── 相机常量（视距优化 2026-08-09：far 20000→8192、near 0.1→0.5、pixelRatio 限 1、雾拉近）
// far 过大会：①深度缓冲精度差（远处闪烁/抖动）②单 mesh 大几何（surf_666 GLB 数十万三角）
// frustum culling 无效——远处全几何仍参与光栅化 → 卡顿。8192 覆盖 surf_666 主要视野，
// 配合雾（0.4×far~0.9×far 淡出）消除远处细节；pixelRatio 限 1（高 dpr 屏像素 4 倍是卡顿主因）。
const FOV = 75;
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 8192;
const PIXEL_RATIO_MAX = 1;
const DEG2RAD = Math.PI / 180;
/** 固定站立眼高（readState 无 eyeHeight 槽；与 game EYE_STAND 一致，不处理蹲伏）。 */
const EYE_STAND = 64.09;
/** 背景/雾色（沿用旧 top-down 深蓝背景）。 */
const BG_COLOR = 0x0d1b2a;

// ── PVS 类型（parse_pvs_data JSON，camelCase；与 game types.ts WasmPvsData 同构）──
interface PvsVec3 {
  x: number;
  y: number;
  z: number;
}
interface WasmPvsNode {
  normal: [number, number, number];
  dist: number;
  children: [number, number];
}
interface WasmPvsLeaf {
  cluster: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  isSolid: boolean;
}
interface WasmPvsData {
  rootNode: number;
  nodes: WasmPvsNode[];
  leaves: WasmPvsLeaf[];
  faceClusters: number[];
  pvsBitsBase64: string;
  clusterCount: number;
  bytesPerRow: number;
}

// ── PvsManager（复刻 game/src/world/pvs-manager.ts 完整逻辑——Worker 中 atob 可用）──
/**
 * PVS 可见性管理器。
 * 职责：维护 BSP 树节点 + 叶子（cluster 定位）、预解码 PVS 位图（Base64 → Uint8Array）、
 * update(pos) 找相机所在 leaf → 取 cluster → 解码可见集、isVisible(clusterId) 查询、
 * getClusterAt(pos) 包围盒采样定位 cluster。
 * 算法：findLeaf 递归比较分割平面；decodePvsRow 解码可见行；仅 cluster 变化时重算。
 */
class PvsManager {
  private readonly nodes: WasmPvsNode[];
  private readonly leaves: WasmPvsLeaf[];
  private readonly faceClusters: number[];
  private readonly pvsBits: Uint8Array;
  private readonly clusterCount: number;
  private readonly bytesPerRow: number;
  private readonly hasPvs: boolean;

  private currentCluster = -1;
  private visibleSet: Set<number> = new Set();
  private lastCheckPos: PvsVec3 = { x: 0, y: 0, z: 0 };

  constructor(wasmJson: string) {
    const data: WasmPvsData = JSON.parse(wasmJson);

    this.nodes = data.nodes;
    this.leaves = data.leaves;
    this.faceClusters = data.faceClusters;
    this.clusterCount = data.clusterCount;
    this.bytesPerRow = data.bytesPerRow;
    this.hasPvs = data.clusterCount > 0 && data.pvsBitsBase64.length > 0;

    // Base64 解码 → Uint8Array（Worker 全局 atob 可用）
    this.pvsBits = this.hasPvs ? base64ToUint8Array(data.pvsBitsBase64) : new Uint8Array(0);
  }

  /**
   * 通过 BSP 树遍历找到 pos 所在的 leaf 索引。
   * 从根开始：dot(n, pos) - dist > 0 进 children[0]（front），<= 0 进 children[1]（back）；
   * 负数子节点表示 leaf（~index 取 leaf 索引）。
   * @param pos 世界坐标（Y-up）。
   * @returns leaf 索引，遍历失败返回 -1。
   */
  private findLeaf(pos: PvsVec3): number {
    if (this.nodes.length === 0) {
      return -1;
    }

    let nodeIdx = 0;
    // 防止无限循环（损坏的 BSP 树可能有环）
    let maxDepth = 0;
    const MAX_DEPTH = 256;

    while (nodeIdx >= 0 && maxDepth < MAX_DEPTH) {
      maxDepth++;
      const node = this.nodes[nodeIdx];
      if (!node) {
        return -1;
      }

      // 点到平面的有向距离
      const d =
        node.normal[0] * pos.x +
        node.normal[1] * pos.y +
        node.normal[2] * pos.z -
        node.dist;

      // front（d > 0）→ children[0]，back（d <= 0）→ children[1]
      const childIdx = d > 0 ? node.children[0] : node.children[1];

      if (childIdx < 0) {
        // 负数表示 leaf：~childIdx 取 leaf 索引
        return ~childIdx;
      }
      nodeIdx = childIdx;
    }

    return -1;
  }

  /**
   * 解码指定 cluster 的 PVS 行，返回可见 cluster 集合。
   * 位图布局：pvsBits[cluster * bytesPerRow + target/8] 的第 (target%8) 位为 1 = 可见。
   * @param cluster 源 cluster id。
   * @returns 可见 cluster 集合（包含自身）。
   */
  private decodePvsRow(cluster: number): Set<number> {
    const visible = new Set<number>();
    if (cluster < 0 || cluster >= this.clusterCount) {
      return visible;
    }

    // 自身总是可见
    visible.add(cluster);

    const rowStart = cluster * this.bytesPerRow;
    if (rowStart + this.bytesPerRow > this.pvsBits.length) {
      return visible; // 边界保护
    }

    // 遍历该行的每个字节
    for (let byteIdx = 0; byteIdx < this.bytesPerRow; byteIdx++) {
      const byte = this.pvsBits[rowStart + byteIdx];
      if (byte === 0) {
        continue;
      }
      // 检查每个位
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (1 << bit)) !== 0) {
          const targetCluster = byteIdx * 8 + bit;
          if (targetCluster < this.clusterCount) {
            visible.add(targetCluster);
          }
        }
      }
    }

    return visible;
  }

  /**
   * 基于相机位置更新 PVS 状态；仅当 cluster 变化时重解码可见集（避免每帧重算）。
   * @param pos 相机世界坐标（Y-up）。
   * @returns true 表示 cluster 发生变化（需要重新应用可见性）。
   */
  update(pos: PvsVec3): boolean {
    this.lastCheckPos = { x: pos.x, y: pos.y, z: pos.z };

    if (!this.hasPvs) {
      return false;
    }

    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) {
      return false;
    }

    const leaf = this.leaves[leafIdx];
    const newCluster = leaf.cluster;

    if (newCluster === this.currentCluster) {
      return false; // cluster 未变，无需重算
    }

    // 激进模式：落在固体 leaf（cluster < 0）时保持上次有效可见集，避免穿墙瞬间闪变；
    // 仅当从未有过有效 cluster 时维持 -1（此时上层会跳过 PVS）。
    if (newCluster < 0) {
      return false;
    }

    this.currentCluster = newCluster;
    this.visibleSet = this.decodePvsRow(newCluster);
    return true;
  }

  /**
   * 查询世界坐标点所在的 cluster（mesh 包围盒采样定位用）。
   * 激进剔除核心：不依赖 face → cluster 静态映射，而是按采样点定位覆盖的 cluster 集合。
   * @param pos 世界坐标（Y-up）。
   * @returns cluster id（-1 = 固体/地图外）。
   */
  getClusterAt(pos: PvsVec3): number {
    if (!this.hasPvs) {
      return -1;
    }
    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) {
      return -1;
    }
    return this.leaves[leafIdx].cluster;
  }

  /**
   * 查询某 cluster 是否在当前可见集内。
   * @param clusterId 目标 cluster id。
   * @returns true 表示可见（或 PVS 未启用时总是 true）。
   */
  isVisible(clusterId: number): boolean {
    if (!this.hasPvs || clusterId < 0) {
      return true; // 无 PVS 或无效 cluster → 全部可见
    }
    return this.visibleSet.has(clusterId);
  }

  /** 是否启用 PVS（地图无 PVS 数据时为 false）。 */
  get enabled(): boolean {
    return this.hasPvs;
  }

  /** 当前 cluster id（-1 = 未初始化 / 固体 leaf）。 */
  get currentClusterId(): number {
    return this.currentCluster;
  }

  /** 可见 cluster 数量。 */
  get visibleClusterCount(): number {
    return this.visibleSet.size;
  }
}

/** Base64 解码为 Uint8Array（Worker 全局 atob + 手动字节拷贝，比 TextEncoder 快）。 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── 运行时状态 ──────────────────────────────────────────────────
let shared: TestShared | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
/** 已挂载的 BSP 模型根（重复 loadGlb 时先 dispose 旧的）。 */
let modelRoot: THREE.Object3D | null = null;
let gltfLoader: GLTFLoader | null = null;
/** GLB 是否已成功挂载（状态摘要回传 main 显示加载进度）。 */
let glbReady = false;

// ── trace 路径线（3D 场景显示：无限制基准[绿] vs tick 实际[红]——记录路径可视化）──
let traceBasePts: THREE.Vector3[] = [];
let traceTickPts: THREE.Vector3[] = [];
let traceBaseLine: THREE.Line | null = null;
let traceTickLine: THREE.Line | null = null;
/** 路径节点滚动窗口上限（防内存溢出；按钮删除时清空）。 */
const TRACE_MAX_POINTS = 2000;

/** 首次 trace-point 时创建两条 3D 路径线（挂 scene；初始隐藏）。 */
function ensureTraceLines(): void {
  if (traceBaseLine || !scene) return;
  traceBaseLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x4ade80 }), // 绿 = 无限制基准
  );
  traceTickLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xf87171 }), // 红 = tick 实际
  );
  traceBaseLine.visible = false;
  traceTickLine.visible = false;
  scene.add(traceBaseLine, traceTickLine);
}

/** 更新路径线几何（节点 < 2 时隐藏；每次重建 BufferGeometry）。 */
function updateTraceLine(line: THREE.Line | null, pts: THREE.Vector3[]): void {
  if (!line) return;
  if (pts.length < 2) {
    line.visible = false;
    return;
  }
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  line.visible = true;
}

/** trace 节点（main 转发 WorkerA）：3D 世界坐标累积 → 更新两条线。 */
function onTracePoint(msg: { baseX: number; baseY: number; baseZ: number; tickX: number; tickY: number; tickZ: number }): void {
  ensureTraceLines();
  traceBasePts.push(new THREE.Vector3(msg.baseX, msg.baseY, msg.baseZ));
  traceTickPts.push(new THREE.Vector3(msg.tickX, msg.tickY, msg.tickZ));
  if (traceBasePts.length > TRACE_MAX_POINTS) traceBasePts.shift();
  if (traceTickPts.length > TRACE_MAX_POINTS) traceTickPts.shift();
  updateTraceLine(traceBaseLine, traceBasePts);
  updateTraceLine(traceTickLine, traceTickPts);
}

/** trace 清除（按钮"删除"）：清空节点 + 隐藏线。 */
function onTraceClear(): void {
  traceBasePts = [];
  traceTickPts = [];
  if (traceBaseLine) traceBaseLine.visible = false;
  if (traceTickLine) traceTickLine.visible = false;
}

/** 本地副本：唯一渲染参数源（只被 readState 更新——WorkerA 1ms 无限制物理真理源；
 * 一旦非 null 永不回落 null——首帧竞争保护）。 */
let localCopy: SharedStateData | null = null;

/** PVS 管理器（{type:'pvs'} 消息构建；null = 地图无 PVS 数据 → 全部可见）。 */
let pvsManager: PvsManager | null = null;

/** 渲染统计（帧循环内自结算，无独立定时器）。 */
const stats = { frames: 0, repaints: 0, fps: 0, repaintSec: 0, t0: performance.now() };

self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as WorkerBMessage;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.init(msg.shared);
      break;
    case 'init-msg':
      // 消息回退模式（无 SAB）：renderPort 直连 WorkerA——shared-state 到达即缓存
      // （本地副本唯一来源；readState 消费，"仅状态更新时重绘"语义与 SAB 模式一致）
      shared = TestShared.initMessagingRender();
      msg.renderPort.onmessage = (ev: MessageEvent<SharedStateMsg>) => {
        const d = ev.data;
        if (shared && d && d.type === 'shared-state') {
          shared.onStateMessage(d);
          // 数据到达立即触发帧循环（绕过无数据节流——消息回退模式响应及时，
          // 不等待 MSG_IDLE_INTERVAL_MS 自检）
          resumeChannel.port2.postMessage(null);
        }
      };
      break;
    case 'init-canvas':
      initRenderer(msg.canvas);
      break;
    case 'resize':
      resize(msg.width, msg.height);
      break;
    case 'glb':
      loadGlb(msg.bytes);
      break;
    case 'pvs':
      // PVS 数据（先于 GLB 到达；若 GLB 已挂载——异常时序——补一次 cluster 分配）
      pvsManager = new PvsManager(msg.pvsJson);
      if (glbReady && scene) {
        assignClusterIds();
        applyPvsVisibility(true);
      }
      break;
    case 'trace-point':
      // trace 路径节点（3D 场景两条线：绿=无限制基准 / 红=tick 实际）
      onTracePoint(msg);
      break;
    case 'trace-clear':
      // 按钮"删除"：清空路径线
      onTraceClear();
      break;
  }
});

/** init-canvas 后初始化 three.js 渲染器（WebGLRenderer + OffscreenCanvas，Worker 内可用）。 */
function initRenderer(canvas: OffscreenCanvas): void {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(Math.max(1, canvas.width), Math.max(1, canvas.height), false);
  // 像素比限制（高 dpr 屏像素 4 倍是卡顿主因；OffscreenCanvas 无 devicePixelRatio，
  // 主线程 resize 消息可按需带 dpr——固定 1 性能优先）
  renderer.setPixelRatio(PIXEL_RATIO_MAX);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 帧循环自驱启动：发布驱动（MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)）——
  // 主驱动 = WorkerA 每发布状态 notify（渲染率 = 物理发布率，无 BSP 全速 1kHz）；
  // 主线程 wake 冗余帧对齐；20ms 超时兜底（WorkerA/主线程停摆渲染不冻结）
  resumeChannel.port2.postMessage(null);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  // 雾（视距优化）：0.4×far 起淡出、0.9×far 全雾——远处细节淡化（消除远处闪烁/降低感知负荷）
  scene.fog = new THREE.Fog(BG_COLOR, CAMERA_FAR * 0.4, CAMERA_FAR * 0.9);

  camera = new THREE.PerspectiveCamera(
    FOV,
    canvas.width / Math.max(canvas.height, 1),
    CAMERA_NEAR,
    CAMERA_FAR,
  );
  // 相机初始：无本地副本（WorkerA 首帧未到）时位于 (0,64.09,0) 望默认方向
  camera.position.set(0, EYE_STAND, 0);

  // 光照（参照 game 默认：ambient 0xffffff 0.6 + directional 0.8）
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(100, 200, 100);
  scene.add(dir);
}

/** resize：更新 renderer 尺寸 + 相机 aspect（updateStyle=false——OffscreenCanvas 无样式）。 */
function resize(width: number, height: number): void {
  if (!renderer || !camera) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

/** GLB 加载（GLTFLoader.parse 无需 DOM；纹理错误仅贴图缺失，场景仍挂载）。 */
function loadGlb(bytes: ArrayBuffer): void {
  if (!scene) return;
  if (!gltfLoader) gltfLoader = new GLTFLoader();
  gltfLoader.parse(
    bytes,
    '',
    (gltf) => {
      if (!scene) return;
      if (modelRoot) {
        disposeObject(modelRoot);
        scene.remove(modelRoot);
      }
      const root = new THREE.Group();
      root.userData.isBspModel = true;
      resetRootRotations(gltf);
      root.add(gltf.scene);
      scene.add(root);
      modelRoot = root;
      glbReady = true;

      // GLB 挂载后：为每个 mesh 分配 clusterIds（包围盒 7 点采样）并应用一次可见性
      assignClusterIds();
      applyPvsVisibility(true);
    },
    (err) => {
      console.error('[worker-b] GLB 解析失败:', err);
    },
  );
}

/** 释放模型几何/材质/纹理（防重复加载泄漏）。 */
function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const map = (mat as unknown as { map?: THREE.Texture | null }).map;
      if (map?.isTexture) map.dispose();
      mat.dispose();
    }
  });
}

/** 清除 GLB 根子节点旋转（与 game renderer-main resetRootRotations 同法）。 */
function resetRootRotations(gltf: GLTF): void {
  for (const child of gltf.scene.children) {
    if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
      child.rotation.set(0, 0, 0);
      child.updateMatrixWorld();
    }
  }
  gltf.scene.updateMatrixWorld(true);
}

/**
 * PVS：为场景中每个 mesh 建立 cluster 集合（渲染减负核心——GLB 挂载后执行一次）。
 *
 * 按 mesh 世界包围盒（Box3.setFromObject）取中心 ± 半径采样 7 点（中心 + 6 面中点），
 * 逐点用 getClusterAt 定位 cluster 并去重（参照 debug lod-manager assignClusterIds）。
 * mesh 横跨多个 cluster 时全部收录，PVS 判定"任一 cluster 可见即可见"（保守，不误剔大 mesh）。
 * 无 PVS（pvsManager null）或空包围盒 → 不设 clusterIds（全部可见）。
 */
function assignClusterIds(): void {
  if (!scene || !pvsManager) return;
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  const p = { x: 0, y: 0, z: 0 };
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ud = mesh.userData as { clusterIds?: number[] };
    if (ud.clusterIds) return; // 已分配（重复挂载防重）
    box.setFromObject(mesh);
    if (box.isEmpty()) return; // 无几何 → 保持可见
    box.getCenter(center);
    // 半径 = 包围球半径（对角线一半），采样点覆盖整个包围盒
    const r = Math.max(box.getSize(size).length() / 2, 1);
    const set = new Set<number>();
    const samples: [number, number, number][] = [
      [center.x, center.y, center.z],
      [center.x + r, center.y, center.z],
      [center.x - r, center.y, center.z],
      [center.x, center.y + r, center.z],
      [center.x, center.y - r, center.z],
      [center.x, center.y, center.z + r],
      [center.x, center.y, center.z - r],
    ];
    for (const [x, y, z] of samples) {
      p.x = x;
      p.y = y;
      p.z = z;
      const cl = pvsManager!.getClusterAt(p);
      if (cl >= 0) set.add(cl);
    }
    ud.clusterIds = [...set];
  });
}

/**
 * PVS：按相机位置更新并重应用 mesh 可见性（渲染前调用）。
 *
 * - 每帧只调 pvsManager.update（findLeaf 轻量）；**仅 update 返回 true（cluster 变化）
 *   时才 scene.traverse 重应用可见性**——mesh 数量多时避免每帧全遍历开销。
 * - clusterIds 非空：任一 cluster 可见即可见；空集合/未分配（无 PVS、无几何）跳过——
 *   保持可见（参照 debug：空集合跳过 PVS 判定）。
 * - force=true（GLB 刚挂载）：跳过 update 判断强制重应用一次（首帧 cluster 初始化场景）。
 * - 相机位置用 localCopy.pos（无本地副本——WorkerA 物理首帧未到——跳过 PVS 应用）。
 */
function applyPvsVisibility(force = false): void {
  if (!pvsManager || !pvsManager.enabled || !scene || !localCopy) return;
  const changed = pvsManager.update({
    x: localCopy.pos.x,
    y: localCopy.pos.y,
    z: localCopy.pos.z,
  });
  if (!changed && !force) return;
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ids = (mesh.userData as { clusterIds?: number[] }).clusterIds;
    if (Array.isArray(ids) && ids.length > 0) {
      mesh.visible = ids.some((c) => pvsManager!.isVisible(c));
    }
  });
}

/**
 * 帧循环超时兜底（ms）：WorkerA/主线程停摆时 WorkerB 自检节奏（渲染不冻结）。
 * 主驱动 = WorkerA 每发布状态的 notify（writeStateRaw → notify(RENDER_WAKEUP)）——
 * 渲染率 = 物理发布率（无 BSP 轻负载全速 1kHz；重场景渲染耗时自然节流）。
 * 主线程 wake 的 store+notify 为帧对齐冗余（无等待者时无操作）。
 */
const RENDER_TIMEOUT_MS = 20;
/** 无数据/重复参数时的长超时（ms）：V 未变（readState null）→ 下次 wait 用此值——
 * 降低无效唤醒/空转（性能优化）；**发布 notify 不受超时影响**（数据到来立即唤醒），
 * 因此长超时不影响"数据源源不断更新时的全力渲染"。 */
const RENDER_IDLE_TIMEOUT_MS = 100;
/** 消息回退模式无数据时的自检间隔（ms）：无阻塞原语 + 消息自旋会 2-10kHz 空转——
 * V 未变时降为低频自检（10Hz）；shared-state 到达时立即触发循环（数据响应及时）。 */
const MSG_IDLE_INTERVAL_MS = 100;
/** 自适应超时（SAB 模式）：有数据（重绘）→ RENDER_TIMEOUT_MS；无数据 → RENDER_IDLE_TIMEOUT_MS。 */
let renderTimeout = RENDER_TIMEOUT_MS;

/**
 * 自驱续环通道：port2 每轮末 postMessage(null) → port1 onmessage →
 * waitRenderWakeup(自适应超时) → 采样/重绘 → 自投递续环。消息任务无 setTimeout 嵌套
 * 4ms 钳制，唤醒到采样/重绘的延时可忽略。主驱动 = WorkerA 发布 notify（发布驱动）。
 */
const resumeChannel = new MessageChannel();

/**
 * 单帧处理：采样（非阻塞）→ 状态更新才重绘。
 * @returns 是否发生重绘（V 更新并提交 Draw——用于自适应超时判定）。
 * try/catch 保护：单帧渲染异常（GPU 驱动/几何错误）不中断循环。
 */
function frameTick(): boolean {
  if (!renderer || !scene || !camera || !shared) return false;
  try {
    return onFrame();
  } catch (err) {
    console.error('[worker-b] 渲染帧异常（已跳过，循环继续）:', err);
    return false;
  }
}

/** 发布驱动帧循环：waitRenderWakeup(自适应超时)——WorkerA 发布 notify 为主驱动 /
 *  主线程 wake 冗余对齐 / 超时兜底（无数据时长超时降空转，数据不断时 notify 立即
 *  唤醒全力渲染）；未就绪（异常时序）时自投递续环，就绪后立即生效。 */
resumeChannel.port1.onmessage = () => {
  let repainted = false;
  if (shared) {
    shared.waitRenderWakeup(renderTimeout);
    repainted = frameTick();
    // 自适应超时：无数据/重复参数（V 未变不重绘）→ 延长超时降空转；有数据 → 恢复短超时
    renderTimeout = repainted ? RENDER_TIMEOUT_MS : RENDER_IDLE_TIMEOUT_MS;
  }
  if (shared && shared.isMessageMode && !repainted) {
    // 消息回退模式节流：无新状态 → 低频自检（setTimeout 100ms 不受嵌套 4ms 钳制），
    // 降 2-10kHz 消息自旋空转；shared-state 到达时 onStateMessage 立即触发循环
    setTimeout(() => resumeChannel.port2.postMessage(null), MSG_IDLE_INTERVAL_MS);
  } else {
    resumeChannel.port2.postMessage(null);
  }
};

/**
 * 帧处理：采样（非阻塞）→ 状态更新才重绘。
 * ① readState：V 更新 → 读最新槽（无撕裂）→ 刷新本地副本；未变 → 不重绘
 *   （状态未更新，保持上一帧画面——高频屏不再重复提交相同相机状态的无效 Draw，
 *   且 HUD「重绘/s」反映真实渲染帧率而非唤醒频率）
 * ② 本地副本更新 → PVS 应用 + renderer.render 提交 GPU
 * @returns 是否发生重绘（V 更新——自适应超时/消息节流判定用）。
 */
function onFrame(): boolean {
  stats.frames++; // 唤醒次数（主线程帧对齐度）
  const state = shared!.readState(); // ① 非阻塞；V 更新→读最新槽（无撕裂），未变→null
  if (state) {
    // 本地副本只被 readState 更新（无其他来源——渲染参数零污染；首帧竞争保护：
    // localCopy 一旦非 null 永不回落 null）
    localCopy = state;
    stats.repaints++;
    // PVS 剔除：渲染前应用可见性（cluster 变化时才重遍历；renderer.render 只提交可见 mesh）
    applyPvsVisibility(false);
    render();
    return true;
  }
  return false;
}

/** 重绘：相机映射（FPS 约定）→ renderer.render 提交 GPU。 */
function render(): void {
  if (!renderer || !scene || !camera || !localCopy) return;
  const t = localCopy;
  // 度 → 弧度，'YXZ' 欧拉（yaw 绕 Y / pitch 绕 X；与 game renderer-main.ts 一致）
  camera.rotation.set(t.pitch * DEG2RAD, t.yaw * DEG2RAD, 0, 'YXZ');
  // 眼高：pos.y + EYE_STAND（64.09 固定站立，不处理蹲伏——状态槽无 eyeHeight）
  camera.position.set(t.pos.x, t.pos.y + EYE_STAND, t.pos.z);
  renderer.render(scene, camera);
  updateStats();
}

/** 渲染统计结算（每秒一次，仅用帧循环自计时，无独立定时器）+ 状态摘要回传 main。 */
function updateStats(): void {
  const now = performance.now();
  if (now - stats.t0 < 1000) return;
  const fps = Math.round((stats.frames * 1000) / (now - stats.t0));
  const repaintSec = Math.round((stats.repaints * 1000) / (now - stats.t0));
  stats.frames = 0;
  stats.repaints = 0;
  stats.fps = fps;
  stats.repaintSec = repaintSec;
  stats.t0 = now;
  const msg: StatusMessage = {
    type: 'status',
    v: localCopy ? localCopy.v : -1,
    pos: localCopy ? localCopy.pos : null,
    vel: localCopy ? localCopy.vel : null,
    yaw: localCopy ? localCopy.yaw : null,
    pitch: localCopy ? localCopy.pitch : null,
    glbReady,
    fps,
    repaintSec,
  };
  self.postMessage(msg);
}

// ── 入口：帧循环由 initRenderer 启动自驱（waitWakeup 对齐主线程 rAF，见 initRenderer）──

export function startWorkerB(): void {
  // 消息监听已在模块顶层注册；帧循环由 init-canvas（initRenderer）自驱启动
}

startWorkerB();
