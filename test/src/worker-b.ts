/**
 * WorkerB — three.js 第一人称 BSP 渲染（OffscreenCanvas + WebGL；帧信号驱动）。
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
 * - 帧循环（自驱，**帧信号驱动**——渲染节奏 = 主线程 rAF（vsync 对齐，平滑呈现））：
 *   MessageChannel 自投递续环 + waitRenderWakeup(RENDER_WAKEUP)：
 *   ① **主驱动 = 主线程 rAF 的 wake()**（store+notify RENDER_WAKEUP——渲染/呈现与
 *      显示器刷新对齐，消除"1kHz 随机相位唤醒 → 画面呈现时间不规则"的观感抖动；
 *      每 rAF 一帧，呈现平滑）——
 *   ② WorkerA 发布**不** notify（只写槽 + V++；醒后读最新槽，V 未变不重绘）
 *   ③ 超时兜底（50ms）：主线程 rAF 停摆（隐藏标签页/主线程卡顿）时自驱，渲染不冻结
 * - 采样与重绘（用户核心定调：渲染参数必须唯一来源于 WorkerA 的 1ms 无限制物理真理源——
 *   本地副本**只被 readState 更新**（无其他来源），Draw 只消费本地副本 → 渲染参数零污染）：
 *   ① shared.readState() 非阻塞 acquire 读 V：已更新 → 读最新槽 S[V&1]（double-check
 *      防撕裂）→ 刷新本地副本；未变 → 不重绘（状态未更新，上一帧画面保持——
 *      高频屏不再重复提交相同相机状态的无效 Draw Calls）
 *   ② 本地副本更新后 → 相机映射 → renderer.render(scene, camera)（渲染帧率 =
 *      min(显示器刷新率, GPU 渲染耗时)；rAF 信号每帧唤醒、每帧只重绘一次）
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
 *
 * 渲染减负（optimizeScene，GLB 挂载后执行）：surf_666 GLB 117 meshes / 34409 primitives /
 *   377385 顶点——GLTFLoader 每 primitive 一个 THREE.Mesh → ~3.4 万 Mesh 对象：每帧遍历/剔除
 *   开销使渲染耗时接近 vsync 帧间隔（120Hz=8.3ms）→ 合成器错过取帧 → 视觉帧率减半。空间分块
 *   合并（cell 大小自适应，目标 ~300~800 块；块内按材质子合并——draw call = 材质数而非 mesh
 *   数）→ 每帧对象遍历 ~几百 → 渲染耗时 < 5ms → vsync 边界安全。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TestShared, type SharedStateMsg, type SharedStateData } from './shared-state.js';
import { TraceRenderer } from '../../src/ts-shared/trace/trace-renderer.js';
import type { TracePoint } from '../../src/ts-shared/trace/trace-types.js';

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
  | TraceClearMessage
  | SetFovMessage;

/** FOV 面板调节消息（main → WorkerB；相机透视矩阵即时更新）。 */
interface SetFovMessage {
  type: 'set-fov';
  fov: number;
}

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

// ── 相机常量（视距优化 2026-08-09：far 20000→8192、near 0.1→0.5、pixelRatio 限 1、雾拉近；
//    视野扩展 2026-08-11：FOV 75→90、far 8192→12288——surf_666 世界 ~16320，扩大视锥后
//    旁边/远处不空白；配合距离 LOD（LOD_DIST=far×0.75≈9200 隐藏远处块）与雾承接视觉；
//    FOV 面板可调 2026-08-12：默认 73.6，面板 60-110 滑块 set-fov 消息即时生效）
// far 过大会：①深度缓冲精度差（远处闪烁/抖动）②单 mesh 大几何（surf_666 GLB 数十万三角）
// frustum culling 无效——远处全几何仍参与光栅化 → 卡顿。12288 覆盖 surf_666 世界大部分，
// 配合雾（0.4×far~0.9×far 淡出）消除远处细节；pixelRatio 限 1（高 dpr 屏像素 4 倍是卡顿主因）。
/** 当前 FOV（度；默认 73.6，面板 set-fov 消息可调）。 */
let fov = 73.6;
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 12288;
const PIXEL_RATIO_MAX = 1;
const DEG2RAD = Math.PI / 180;
/** 固定站立眼高（readState 无 eyeHeight 槽；与 game EYE_STAND 一致，不处理蹲伏）。 */
const EYE_STAND = 64.09;
/** 背景/雾色（沿用旧 top-down 深蓝背景）。 */
const BG_COLOR = 0x0d1b2a;

// ── 距离 LOD（仿 game renderer-main lodItems 距离剔除语义）──
// 块 mesh 中心距相机 > LOD_DIST → visible=false（远处隐藏）；<= LOD_DIST 时由 PVS/视锥
// 决定（three.js frustum culling 自动——"保留视锥内渲染"指不干预视锥剔除，LOD 是
// 视锥/PVS 之上的距离粗筛）。LOD_DIST = far×0.75 ≈ 9200：落在雾（0.4~0.9×far）深处，
// 隐藏时已淡化为背景色，视觉平滑不突兀。与 game 语义关系：game LOD_FAR（距离 >
// cullDistance → 隐藏）即此一档的对应——块粒度下无需多级 LOD，这里只分 可见/隐藏；
// game LOD_NEAR（<= 距离 → 按 PVS/视锥决定）同理。far×0.75 比例沿用本工程惯例
// （game cullDistance 12800 / far 20000 = 0.64 同数量级），雾深处淡出。
const LOD_DIST = CAMERA_FAR * 0.75;
/**
 * PVS 剔除开关：**当前禁用**（实证 surf_666 PVS 数据不可用：8269 cluster 平均可见率
 * 仅 1.6%（中位 1.3%、最大 5.1%）、spawn 点 cluster=-1——开放 surf 图 BSP leaf/PVS
 * 划分失效，可见集几乎为空 → 相邻区域被错误全剔（"必须穿过连接处才能看到"）+ 晃动
 * 穿越 cluster 边界时边缘消失）。分块合并后渲染量已由视锥剔除（FRUSTUM_PAD 膨胀）+
 * 距离 LOD（LOD_DIST）控制，PVS 为负收益。PVS 数据修复后可置 true 恢复。
 */
const ENABLE_PVS = false;

// ── 空间分块合并参数（optimizeScene：GLB 挂载后渲染减负）──
// surf_666 GLB：117 meshes / 34409 primitives / 377385 顶点（mesh 12 含 34043 primitive，
// 32.2 万顶点，85%）——GLTFLoader 每个 primitive 生成一个 THREE.Mesh → scene 有 ~3.4 万
// Mesh 对象：每帧 three.js 遍历 3.4 万对象做剔除 + 可见 mesh 逐个 draw call → 渲染耗时接近
// vsync 帧间隔（120Hz = 8.3ms）→ 合成器错过取帧 → 视觉帧率减半。分块合并把 3.4 万对象 →
// ~300~800 空间块（块内按材质子合并，draw call = 材质数而非 mesh 数）→ 渲染耗时 < 5ms。
/** 目标 cell 数（cell 大小 = 世界包围盒对角线 / cbrt(目标块数)，自适应微调区间 [300,800]）。 */
const OPT_TARGET_CELLS = 512;
/** 非空 cell 数目标下限/上限（自适应微调）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 大小钳制（world units；surf_666 世界 ~16320 → cell ≈ 512~1024 数量级）。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈（frustum culling 包围球膨胀系数）：three.js 每帧按 geometry.boundingSphere
 * 判定剔除——半径 ×FRUSTUM_PAD 后，视锥外约 (FRUSTUM_PAD-1)×半径 的块仍渲染（疯狂晃动/快速
 * 转动时，新进入视锥的几何上一帧已预渲染 → 边缘不空白；块包围球大者膨胀量自然大，覆盖一帧
 * 相机移动量）。膨胀只作用于 renderer 剔除，LOD/PVS（userData.center/radius、clusterIds）
 * 是独立数据不受影响。
 */
const FRUSTUM_PAD = 1.6;

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

// ── trace 路径线（公共模块 TraceRenderer：绿=无限制基准 / 红=tick 实际）──
/** 3D 路径线渲染器（scene 挂载后惰性创建；addPoint/clear 即时更新）。 */
let traceRenderer: TraceRenderer | null = null;

/** 本地副本：唯一渲染参数源（只被 readState 更新——WorkerA 1ms 无限制物理真理源；
 * 一旦非 null 永不回落 null——首帧竞争保护）。 */
let localCopy: SharedStateData | null = null;

// ── 渲染插值窗口（物理状态间平滑：渲染帧率 = 屏幕刷新率，观感平滑）──
/** 上一物理状态（插值起点）。 */
let interpLast: SharedStateData | null = null;
/** 收到 interpLast 的时间戳（performance.now）。 */
let interpLastT = 0;
/** 当前物理状态（插值终点）。 */
let interpCur: SharedStateData | null = null;
/** 收到 interpCur 的时间戳。 */
let interpCurT = 0;

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
    case 'set-fov':
      // FOV 面板调节（默认 73.6；60-110 可调，透视矩阵即时更新）
      if (typeof (msg as { fov?: unknown }).fov === 'number') {
        fov = (msg as { fov: number }).fov;
        if (camera) {
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
      }
      break;
    case 'resize':
      resize(msg.width, msg.height);
      break;
    case 'glb':
      loadGlb(msg.bytes);
      break;
    case 'pvs':
      // PVS 数据（先于 GLB 到达；若 GLB 已挂载——异常时序——补一次 LOD/PVS 数据分配）
      pvsManager = new PvsManager(msg.pvsJson);
      if (glbReady && scene) {
        assignMeshCullingData(); // LOD 数据已就绪，仅补 clusterIds
        applyCulling(true);
      }
      break;
    case 'trace-point':
      // trace 路径节点（公共 TraceRenderer：绿=无限制基准 / 红=tick 实际）
      if (traceRenderer) {
        const p = msg as { baseX: number; baseY: number; baseZ: number; tickX: number; tickY: number; tickZ: number };
        const pt: TracePoint = {
          base: { x: p.baseX, y: p.baseY, z: p.baseZ },
          tick: { x: p.tickX, y: p.tickY, z: p.tickZ },
        };
        traceRenderer.addPoint(pt);
      }
      break;
    case 'trace-clear':
      // 按钮"删除"：清空路径线
      traceRenderer?.clear();
      break;
  }
});

/** init-canvas 后初始化 three.js 渲染器（WebGLRenderer + OffscreenCanvas，Worker 内可用）。 */
function initRenderer(canvas: OffscreenCanvas): void {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(Math.max(1, canvas.width), Math.max(1, canvas.height), false);
  // 像素比限制（高 dpr 屏像素 4 倍是卡顿主因；OffscreenCanvas 无 devicePixelRatio，
  // 主线程 resize 消息可按需带 dpr——固定 1 性能优先）
  renderer.setPixelRatio(PIXEL_RATIO_MAX);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 帧循环自驱启动：帧信号驱动（MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)）——
  // 主驱动 = 主线程 rAF 的 wake()（store+notify RENDER_WAKEUP：vsync 对齐——渲染节奏 =
  // 显示器刷新，呈现平滑）；WorkerA 发布不 notify（1kHz 随机相位唤醒 → 呈现抖动）；
  // 50ms 超时兜底（主线程 rAF 停摆时自驱，渲染不冻结）
  resumeChannel.port2.postMessage(null);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  // 雾（视距优化）：0.4×far 起淡出、0.9×far 全雾——远处细节淡化（消除远处闪烁/降低感知
  // 负荷；far=12288 → 雾 4915.2~11059.2；LOD_DIST 9200 恰在雾深处——隐藏块已融入背景色）
  scene.fog = new THREE.Fog(BG_COLOR, CAMERA_FAR * 0.4, CAMERA_FAR * 0.9);
  // trace 路径线（公共 TraceRenderer，惰性创建线）
  traceRenderer = new TraceRenderer(scene);

  camera = new THREE.PerspectiveCamera(
    fov,
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

      // GLB 挂载后：空间分块合并（3.4 万 Mesh → ~数百空间块——渲染减负核心）
      optimizeScene();
      // 为每个（合并后）mesh 分配 LOD 数据（世界包围盒中心/半径）+ clusterIds（7 点采样）
      assignMeshCullingData();
      applyCulling(true);
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

// ── 空间分块合并（optimizeScene：GLB 挂载后执行一次）─────────────
// 渲染减负核心：3.4 万 Mesh（每帧遍历/剔除开销）→ ~300~800 空间块。
// ① 收集：scene.traverse 收集所有 THREE.Mesh（含 isBspModel 组内；trace 线是 Line 非
//    Mesh 自动排除）——先 updateMatrixWorld(true) 使其 matrixWorld 为世界变换基准；
// ② 分块：世界空间网格分块——cell 大小自适应（世界包围盒对角 / cbrt(目标块数)，
//    再按非空 cell 数微调落 [300,800]）；每 mesh 世界包围盒中心归 cell（横跨多 cell 归中心）；
// ③ 合并：顶点先 applyMatrix4(matrixWorld) 烘焙到世界空间（clone 后变换，勿动原 geometry）；
//    单 mesh cell 保留原 mesh（烘焙后移除原父变换）；多 mesh cell 块内按材质（实例恒等）
//    子合并（draw call = 块内材质数而非 mesh 数）→ mergeGeometries(useGroups=true) 最终
//    合并——groups 保留材质索引：材质去重收集 + 块内材质索引重映射；
// ④ 替换：移除原 mesh（旧 geometry 逐个 dispose）加入块 mesh；重建 modelRoot；
//    调用方随后重新 assignMeshCullingData() + applyCulling(true)；
// ⑤ console.log 统计：原 mesh 数 → 块数、每块平均顶点、前向视锥（fov 当前值）内可见块估算
//    （块包围盒中心与相机方向点积粗估——仅诊断）。

/** 收集的 mesh + 世界包围盒中心（分块键用）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标 / cellSize 取整（字符串键；一次性分桶，无性能要求）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/** 非空 cell 计数（cell 大小自适应循环用）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/** GLB 挂载后执行：空间分块合并（见上方流程注释）。失败时保持场景原状（计算先行、后替换）。 */
function optimizeScene(): void {
  if (!scene) return;

  // ① 收集：matrixWorld 更新后作为世界变换基准；多材质 mesh（GLB primitive 恒单材质，
  //    防御性路径）与无材质 mesh 单独烘焙保留，不参与分块
  scene.updateMatrixWorld(true);
  const infos: OptMeshInfo[] = [];
  const keptMeshes: THREE.Mesh[] = [];
  const worldBox = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.geometry || !m.geometry.attributes.position) return;
    if (Array.isArray(m.material) || !m.material) {
      // 多材质/无材质：烘焙到世界空间后整体保留（不参与分块合并）
      if (Array.isArray(m.material)) {
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        keptMeshes.push(m);
      }
      return;
    }
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
    worldBox.union(box);
    box.getCenter(center);
    infos.push({ mesh: m, cx: center.x, cy: center.y, cz: center.z });
  });
  if (infos.length === 0) return;

  // ② cell 大小自适应：cell = 世界包围盒对角线 / cbrt(目标块数)，再按非空 cell 数微调
  //    （非空 cell 偏少 → 缩小 cell，偏多 → 放大 cell，收敛到 300~800）
  const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
  let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
  for (let i = 0; i < 6; i++) {
    const n = optCountCells(infos, cellSize);
    if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
    const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
    cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
  }

  // ③ 分桶：每 mesh 世界包围盒中心归 cell（横跨多 cell 归中心所在 cell）
  const cells = new Map<string, OptMeshInfo[]>();
  for (const it of infos) {
    const key = optCellKey(it.cx, it.cy, it.cz, cellSize);
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(it);
  }

  // ④ 合并 + 替换：单 mesh cell 保留原 mesh（烘焙世界变换、移除原父变换）；
  //    多 mesh cell 块内按材质子合并 → 最终 mergeGeometries(useGroups=true)（groups 保留
  //    材质索引：材质去重收集 + 块内索引重映射）→ 每块一个 THREE.Mesh(mergedGeom, materials)
  const optRoot = new THREE.Group();
  optRoot.userData.isBspModel = true;
  let chunkCount = 0;
  let drawCallEst = 0;
  let vertsTotal = 0;
  for (const arr of cells.values()) {
    if (arr.length === 1) {
      const m = arr[0].mesh;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      m.geometry.dispose();
      m.geometry = baked;
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.updateMatrix();
      optRoot.add(m); // 自动脱离原父节点
      chunkCount++;
      drawCallEst++;
      vertsTotal += baked.attributes.position.count;
      continue;
    }

    // 多 mesh cell：块内按材质（实例恒等）分组 → 同材质子合并 → 每材质一个几何
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const it of arr) {
      const m = it.mesh;
      const mat = m.material as THREE.Material;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      let list = byMat.get(mat);
      if (!list) {
        list = [];
        byMat.set(mat, list);
      }
      list.push(baked);
    }
    const mergedGeoms: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    for (const [mat, geoms] of byMat) {
      let merged: THREE.BufferGeometry[];
      if (geoms.length === 1) {
        merged = geoms;
      } else {
        const mg = mergeGeometries(geoms, false);
        if (mg) {
          for (const g of geoms) g.dispose();
          merged = [mg];
        } else {
          merged = geoms; // 属性不一致（防御）：保留单独几何，材质索引各自映射
        }
      }
      for (const g of merged) {
        mergedGeoms.push(g);
        mats.push(mat);
      }
    }
    if (mergedGeoms.length === 0) {
      for (const it of arr) it.mesh.geometry.dispose();
      continue;
    }
    let chunk: THREE.Mesh;
    if (mergedGeoms.length === 1) {
      chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
      drawCallEst++;
    } else {
      const final = mergeGeometries(mergedGeoms, true);
      if (final) {
        for (const g of mergedGeoms) if (g !== final) g.dispose();
        chunk = new THREE.Mesh(final, mats);
        drawCallEst += final.groups.length;
      } else {
        // 最终合并失败（极端防御）：每个材质单独一块
        chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
        for (let i = 1; i < mergedGeoms.length; i++) {
          optRoot.add(new THREE.Mesh(mergedGeoms[i], mats[i]));
          chunkCount++;
          drawCallEst++;
        }
      }
    }
    for (const it of arr) it.mesh.geometry.dispose();
    chunkCount++;
    for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
    optRoot.add(chunk);
  }
  for (const m of keptMeshes) optRoot.add(m);

  // ④b 视锥外保一圈：块 geometry.boundingSphere 半径 ×FRUSTUM_PAD。
  //    必须强制 computeBoundingSphere（非 null 检查）：烘焙路径是 geometry.clone() +
  //    applyMatrix4(matrixWorld)——克隆残留 GLB 局部空间的旧球（非 null 会被跳过）→
  //    剔除按错误位置判定 → 眼前块被误剔不渲染。顶点已烘焙世界空间 → 重算球正确。
  //    只影响剔除判定，不改变几何/包围盒；LOD/PVS（userData 数据）不受影响。
  for (const child of optRoot.children) {
    const g = (child as THREE.Mesh).geometry;
    if (!g) continue;
    g.computeBoundingSphere();
    (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
  }

  // ④c 替换：移除原 modelRoot（旧 mesh 几何已逐个 dispose），加入块 mesh 根
  const totalMeshes = infos.length;
  if (modelRoot) scene.remove(modelRoot);
  scene.add(optRoot);
  modelRoot = optRoot;

  // ⑤ 统计 + 前向视锥可见块估算（仅诊断：块包围盒中心与相机方向点积粗估，fov 当前值）
  const chunkBox = new THREE.Box3();
  const chunkCenter = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  let visibleEst = -1;
  if (camera) {
    camera.updateMatrixWorld(true);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const cosHalfFov = Math.cos((fov / 2) * DEG2RAD);
    visibleEst = 0;
    for (const child of optRoot.children) {
      const mesh = child as THREE.Mesh;
      chunkBox.setFromObject(mesh);
      if (chunkBox.isEmpty()) continue;
      chunkBox.getCenter(chunkCenter);
      toCam.subVectors(chunkCenter, camera.position);
      const dist = toCam.length();
      if (dist < CAMERA_FAR && toCam.dot(camDir) / dist > cosHalfFov) visibleEst++;
    }
  }
  console.log(
    `[optimizeScene] 分块合并: ${totalMeshes} mesh → ${chunkCount} 块` +
      `（cellSize=${cellSize.toFixed(1)}、非空 cell=${cells.size}）| ` +
      `平均顶点/块 ${(vertsTotal / Math.max(chunkCount, 1)).toFixed(0)}（总顶点 ${vertsTotal}）| ` +
      `draw call 估算 ${drawCallEst} | ` +
      `前向视锥可见块估算 ${visibleEst >= 0 ? `${visibleEst}/${chunkCount}` : 'N/A（camera 未就绪）'}`,
  );
}

/**
 * LOD/PVS：为场景中每个 mesh 分配 LOD 数据与 cluster 集合（GLB 挂载后执行一次；
 * PVS 消息后到时补一次——见 message 处理器）。
 *
 * ① LOD 数据（无条件分配）：mesh 世界包围盒（Box3.setFromObject）中心 → userData.center、
 *    包围球半径（对角线一半）→ userData.radius——距离 LOD 每帧距离判定用。
 * ② clusterIds（仅 PVS 存在时分配）：中心 ± 半径采样 7 点（中心 + 6 面中点），逐点用
 *    getClusterAt 定位 cluster 并去重（参照 debug lod-manager assignClusterIds）。
 *    mesh 横跨多个 cluster 时全部收录，PVS 判定"任一 cluster 可见即可见"（保守，不误剔大 mesh）。
 * 无 PVS（pvsManager null）→ 不设 clusterIds（全部可见，仅距离 LOD 生效）；
 * 空包围盒 → 无任何数据（保持可见）。
 */
function assignMeshCullingData(): void {
  if (!scene) return;
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  const p = { x: 0, y: 0, z: 0 };
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ud = mesh.userData as { center?: THREE.Vector3; radius?: number; clusterIds?: number[] };
    if (ud.clusterIds) return; // 已分配（重复挂载防重；LOD 数据已随同写入）
    box.setFromObject(mesh);
    if (box.isEmpty()) return; // 无几何 → 保持可见
    box.getCenter(center);
    // LOD 数据：世界包围盒中心 + 包围球半径（距离剔除用）
    ud.center = center.clone();
    ud.radius = Math.max(box.getSize(size).length() / 2, 1);
    if (!pvsManager) return; // 无 PVS → 仅 LOD 数据（PVS 后到时补 clusterIds）
    const set = new Set<number>();
    const r = ud.radius;
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
 * LOD + PVS：渲染前合并应用 mesh 可见性（与 game renderer-main LOD/PVS 剔除同法；
 * three.js frustum culling 在 renderer.render 内自动执行，本函数不干预——视锥内渲染保留）。
 *
 * - 距离 LOD（每帧）：块中心距相机 > LOD_DIST → visible=false（远处隐藏——雾 0.9×far
 *   已全雾，淡出平滑不突兀）；<= LOD_DIST → 交 PVS/视锥决定。块数数百、每帧距离计算
 *   亚毫秒，无需增量——相机移动即距离变化，每帧重算。
 * - PVS：每帧只调 pvsManager.update（findLeaf 轻量；cluster 变化才重解码可见集）。
 *   相机不在任何 cluster（固体/地图外，currentClusterId < 0）时跳过 PVS 仅按距离 LOD
 *   （game 同法——避免可见集为空时 cluster 网格被错误全剔）。
 * - 由 onFrame 节流：仅渲染时调用（每次唤醒渲染，相机位置 = 插值/权威渲染状态）。
 * - force=true（GLB 刚挂载）：GLB/PVS 到达后强制重应用一次（首帧初始化场景）。
 * @param camState 渲染相机状态（插值或权威）；缺省回退 localCopy（兼容旧调用）。
 */
function applyCulling(force = false, camState?: SharedStateData): void {
  if (!scene || !localCopy) return;
  const ref = camState ?? localCopy;
  // 相机眼位（与 render 中 camera.position 一致：pos + EYE_STAND）
  const cam = { x: ref.pos.x, y: ref.pos.y + EYE_STAND, z: ref.pos.z };
  const pvsActive = ENABLE_PVS && !!pvsManager && pvsManager.enabled;
  if (pvsActive) {
    pvsManager!.update(cam);
  }
  // 相机 cluster 无效（固体/地图外/未初始化）→ PVS 不可信，跳过（仅距离 LOD）
  const pvsClusterValid = pvsActive && pvsManager!.currentClusterId >= 0;
  const lodDistSq = LOD_DIST * LOD_DIST;
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const ud = mesh.userData as { center?: THREE.Vector3; radius?: number; clusterIds?: number[] };
    // ① 距离 LOD：块中心距相机 > LOD_DIST → 隐藏（雾已淡化为背景色，视觉平滑）
    if (ud.center) {
      const ax = ud.center.x - cam.x;
      const ay = ud.center.y - cam.y;
      const az = ud.center.z - cam.z;
      if (ax * ax + ay * ay + az * az > lodDistSq) {
        mesh.visible = false;
        return;
      }
    }
    // ② PVS：clusterIds 非空 → 任一 cluster 可见即可见；空集合/未分配（无 PVS、无几何）
    //    跳过——保持可见；PVS 未激活或相机 cluster 无效 → 全部跳过（保持可见）
    if (pvsClusterValid) {
      const ids = ud.clusterIds;
      if (Array.isArray(ids) && ids.length > 0) {
        mesh.visible = ids.some((c) => pvsManager!.isVisible(c));
      }
    }
  });
}

/**
 * 帧循环超时兜底（ms）：主线程 rAF 停摆（隐藏标签页/主线程卡顿）时 WorkerB 自检
 * 节奏（渲染不冻结）。**主驱动 = 主线程 rAF 的 wake()**（store+notify RENDER_WAKEUP——
 * vsync 对齐，渲染节奏 = 显示器刷新，呈现平滑）；WorkerA 发布不 notify（1kHz 随机
 * 相位唤醒 → 渲染完成时刻与显示器 BeginFrame 错位 → 呈现时间不规则 → 观感抖动）。
 * 超时只作兜底：正常由 rAF 信号即时唤醒，50ms 超时在可见页面下不会命中。
 */
const RENDER_TIMEOUT_MS = 50;
/** 消息回退模式无数据时的自检间隔（ms）：无阻塞原语 + 消息自旋会 2-10kHz 空转——
 * V 未变时降为低频自检（10Hz）；shared-state 到达时立即触发循环（数据响应及时）。 */
const MSG_IDLE_INTERVAL_MS = 100;

/**
 * 自驱续环通道：port2 每轮末 postMessage(null) → port1 onmessage →
 * waitRenderWakeup(超时兜底) → 采样/重绘 → 自投递续环。消息任务无 setTimeout 嵌套
 * 4ms 钳制，唤醒到采样/重绘的延时可忽略。主驱动 = 主线程 rAF 帧信号（vsync 对齐）。
 */
const resumeChannel = new MessageChannel();

/**
 * 单帧处理：采样（非阻塞）→ 状态更新才重绘。
 * @returns 是否发生重绘（V 更新并提交 Draw——消息回退模式节流判定用）。
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

/**
 * 帧信号驱动帧循环：waitRenderWakeup(RENDER_TIMEOUT_MS)——主线程 rAF 的 wake()
 * 为主驱动（Atomics.add RENDER_WAKEUP 计数 + notify：vsync 对齐，每 rAF 一帧，
 * 呈现平滑）；超时兜底（主线程停摆时自驱，渲染不冻结）；未就绪（异常时序）时
 * 自投递续环，就绪后立即生效。**帧率上限 = 刷新率**：渲染完成后 absorbRenderWake
 * 吸收渲染期间到达的信号（合并丢弃）→ 渲染快时不会忙循环超过刷新率（重复释放）。
 */
resumeChannel.port1.onmessage = () => {
  let repainted = false;
  if (shared) {
    shared.waitRenderWakeup(RENDER_TIMEOUT_MS); // 主驱动 = 主线程 rAF 帧信号；超时 = 停摆兜底
    repainted = frameTick();
    shared.absorbRenderWake(); // 渲染期间新到的唤醒 → 合并丢弃（严格 = 刷新率上限）
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
 * 帧处理：采样（非阻塞）→ 每次唤醒都渲染（物理状态间插值平滑）。
 * ① readState：V 更新 → 读最新槽（无撕裂）→ 刷新本地副本（权威状态）；未变 → 用插值
 *   （物理发布 ~50Hz 但渲染 320Hz：两状态间线性插值相机位置/角度 → 观感 = 刷新率；
 *   不再"V 未变不重绘"——那是观感 ~50fps 的根因）
 * ② 渲染参数 = 插值状态（readState 成功时推进插值窗口；失败时按时间比例插值）
 * ③ PVS 应用 + renderer.render 提交 GPU；stats.frames 仅在实际渲染时递增
 * @returns 是否渲染（消息回退模式节流判定用：状态未更新也渲染 → 恒 true）。
 */
function onFrame(): boolean {
  const now = performance.now();
  const state = shared!.readState(); // ① 非阻塞；V 更新→读最新槽（无撕裂），未变→null
  const newState = state !== null;
  if (state) {
    // 推进插值窗口：last ← cur（旧），cur ← 新权威状态（时间戳 = 收到时刻）
    if (interpCur) {
      interpLast = interpCur;
      interpLastT = interpCurT;
    } else {
      // 首帧：无 prev，直接用权威状态（无插值）
      interpLast = null;
      interpLastT = 0;
    }
    interpCur = state;
    interpCurT = now;
    // 本地副本只被 readState 更新（无其他来源——渲染参数零污染；首帧竞争保护：
    // localCopy 一旦非 null 永不回落 null）
    localCopy = state;
    stats.repaints++;
  }
  if (!localCopy || !interpCur) return false; // 首帧未就绪
  // 消息回退模式：仅新状态到达时渲染（无 SAB 高频帧信号；状态即节奏，
  // 节流防自旋——resumeChannel 自投递由 onStateMessage 触发，无新状态时降频）
  if (shared!.isMessageMode && !newState) return false;
  // ② 渲染参数：状态间插值（线性；yaw/pitch 角度环绕处理）——
  //    独立 renderState，不污染 localCopy 权威语义（权威源仍只被 readState 更新）。
  //    插值窗口 = 两次权威状态"到达时刻"之间：状态到达帧 now===interpCurT → alpha=1
  //    （直接用最新权威，无中间帧）；仅当物理发布 < 刷新率时，状态到达间的后续 rAF
  //    帧 now 落入窗口内 → alpha<1 产生中间帧（观感平滑）。现役 surf_666 物理 ~1kHz
  //    发布 > 刷新率，每次唤醒都有新状态 → alpha 恒 1（正确：直接取最新权威）。
  let renderState: SharedStateData;
  if (interpLast && interpCurT > interpLastT) {
    const span = interpCurT - interpLastT;
    const alpha = Math.min(Math.max((now - interpLastT) / span, 0), 1);
    renderState = interpolateState(interpLast, interpCur, alpha);
  } else {
    renderState = interpCur; // 首帧 / 窗口未建立：直接权威状态
  }
  stats.frames++; // 实际渲染提交（fps = 真实渲染帧率，非唤醒次数）
  // LOD+PVS 剔除：渲染前应用可见性（距离 LOD 每帧 + cluster 变化时 PVS——单次遍历
  // 合并；renderer.render 只提交可见 mesh，three.js frustum culling 自动执行）
  applyCulling(false, renderState);
  render(renderState);
  return true;
}

/** 两状态线性插值（位置/角度；yaw 最短路径环绕）。 */
function interpolateState(a: SharedStateData, b: SharedStateData, alpha: number): SharedStateData {
  // yaw 最短路径：d ∈ [-180, 180]
  let dy = (b.yaw - a.yaw) % 360;
  if (dy > 180) dy -= 360;
  else if (dy < -180) dy += 360;
  const yaw = a.yaw + dy * alpha;
  // 归一化到 [-180, 180)：防止 350°→10° 插值出现 360/540 等越界值
  const yawNorm = ((yaw + 180) % 360 + 360) % 360 - 180;
  return {
    pos: {
      x: a.pos.x + (b.pos.x - a.pos.x) * alpha,
      y: a.pos.y + (b.pos.y - a.pos.y) * alpha,
      z: a.pos.z + (b.pos.z - a.pos.z) * alpha,
    },
    vel: {
      x: a.vel.x + (b.vel.x - a.vel.x) * alpha,
      y: a.vel.y + (b.vel.y - a.vel.y) * alpha,
      z: a.vel.z + (b.vel.z - a.vel.z) * alpha,
    },
    yaw: yawNorm,
    pitch: a.pitch + (b.pitch - a.pitch) * alpha,
    v: b.v,
  };
}

/** 重绘：相机映射（FPS 约定）→ renderer.render 提交 GPU。@param t 渲染状态（权威或插值）。 */
function render(t: SharedStateData): void {
  if (!renderer || !scene || !camera) return;
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
