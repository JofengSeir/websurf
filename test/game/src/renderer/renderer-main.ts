/**
 * 主线程渲染器（最小化版）— 客户端预测渲染。
 *
 * 架构（2026-08-07 v4.1）：
 * - 主线程持 wasm `PhysWorld` 预测实例：每 rAF 调 `tick(dt, keys, dx, dy)`
 *   做**真实物理模拟**（移动语义 + 碰撞），渲染预测结果（输入零延迟）
 * - Worker-A 权威物理每帧写全状态到 SAB → 主线程 `set_state` 修正预测基线
 *   （标准客户端预测：本地模拟即时响应，权威定期纠偏）
 * - respawn/teleport 位置突变：player-respawn 事件 → set_state 归零
 * - 无 lightmap/雾/碰撞可视化/准星射线。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PhysWorld, mosaic_decode, initSync } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { SceneDataMessage } from '../worker/worker-types.js';
import type { ShmState, MsgState } from '../ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../ts-shared/phys/authority-calibrator.js';
import { PvsManager } from '../world/pvs-manager.js';

/** FOV 默认值（73.6；面板 hud.fov 可调，60-110）。 */
const FOV_DEFAULT = 73.6;
const DEG2RAD = Math.PI / 180;

// ── 空间分块合并参数（optimizeScene：GLB 挂载后渲染减负）──────────
// surf_666 GLB：117 meshes / 34409 primitives / 377385 顶点——GLTFLoader 每个 primitive
// 生成一个 THREE.Mesh → 场景 ~3.4 万 Mesh 对象：每帧 three.js 遍历 3.4 万对象做剔除 +
// 可见 mesh 逐个 draw call → 渲染耗时接近 vsync 帧间隔（120Hz=8.3ms）→ 合成器错过取帧 →
// 视觉帧率减半。分块合并把 3.4 万对象 → ~300~800 空间块（块内按材质子合并，draw call =
// 材质数而非 mesh 数）→ 渲染耗时 < 5ms。逻辑移植自 test/dual-mode-harness/src/worker-b.ts optimizeScene
// （已验证 34409 mesh → 300~800 块），主线程差异见方法注释。
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
 * 相机移动量）。同 test worker-b FRUSTUM_PAD。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集的 mesh + 世界包围盒中心（分块键用；同 worker-b OptMeshInfo）。 */
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

/** LOD 级别。 */
const LOD_NEAR = 0;
const LOD_FAR = 2;
const LOD_PVS_HIDDEN = -1;
/**
 * PVS 剔除开关：**当前禁用**（实证 surf_666 PVS 数据不可用：8269 cluster 平均可见率
 * 仅 1.6%（中位 1.3%、最大 5.1%）、spawn 点 cluster=-1——开放 surf 图 BSP leaf/PVS
 * 划分失效，可见集几乎为空 → 相邻区域被错误全剔（"必须穿过连接处才能看到"）+ 晃动
 * 穿越 cluster 边界时边缘消失）。分块合并后渲染量已由视锥剔除（FRUSTUM_PAD 膨胀）+ 
 * 距离 LOD（cullDistance）控制，PVS 为负收益。PVS 数据修复后可置 true 恢复。
 */
const ENABLE_PVS = false;

export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private pvsManager: PvsManager | null = null;
  /** 运行时配置（init 时注入；纹理画质等渲染侧配置读取）。 */
  private config!: RuntimeConfig;

  private rafId = 0;
  private running = false;

  // ── 主线程唯一物理线 ───────────────────────────────────────
  /** 主线程 PhysWorld 实例（唯一物理：完整世界+碰撞+输入；每帧 tick 推进并渲染）。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理就绪（world-json 构建完成）。 */
  private predReady = false;
  /** 待喂给物理实例的输入（app 事件回调累积）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  private pendingKeys = 0;
  /** 权威校准（公共化：correctFromAuthority 三条件 OR + 63ms 冷却 + 位置兜底驳回、
   * calibrateVelocity 外推、applyCollisionCorrection 反向同步、resetTo 收敛到
   * ts-shared AuthorityCalibrator）。 */
  private readonly calibrator: AuthorityCalibrator;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;
  /** mesh → { center, radius, clusterIds }（LOD/PVS 用；clusterIds 空间采样分配）。 */
  private lodItems: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; clusterIds: number[] }> = [];
  /** 剔除距离（场景加载后校准）。 */
  private cullDistance = 12800;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest：{ 纹理名(小写 basetexture): mosaic 字节码 }。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原始贴图图像缓存（切换回 original 时恢复）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  // ── 近平面贴墙自适应（防贴墙透视；同步自主项目 renderer-main）─────────
  /** 近平面收缩探测距离默认（HU）：相机距墙最小距离 = 碰撞箱半宽 16，射线必须
   * 能覆盖该距离才能探测到面前的墙——原固定 near=maxDim/1000（大地图 50+）
   * 贴墙时墙被近平面裁剪 → 透视看到地图外面。
   * 48 = 3×最小贴墙距离：配合 4 个水平探测方向（前/后/左/右），贴墙角度下
   * 最近方向与墙面夹角足够小时斜距 ≤ 16/sinθ，垂直墙主要角度可探测。 */
  private static readonly NEAR_PROBE_DIST_DEFAULT = 100;
  private static readonly CAMERA_NEAR_MIN = 0.05;
  /** near 收缩系数默认：near = 最近几何距离 × 此值。 */
  private static readonly NEAR_RATIO_DEFAULT = 0.3;
  /** 探测距离（HU）；↑ 更斜掠射也能命中，粗筛候选略增。面板可实时调。 */
  private nearProbeDist = RendererMain.NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数；↓ 更保守更不易裁墙。面板可实时调。 */
  private nearRatio = RendererMain.NEAR_RATIO_DEFAULT;
  private defaultNear = 0.1;
  private nearCheckToggle = false;
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearRaycaster = new THREE.Raycaster();


  constructor(private readonly shared: ShmState | MsgState) {
    this.calibrator = new AuthorityCalibrator({
      readAuth: () => this.shared.readAuthoritative(),
      getPhys: () => this.predPhys,
      clearPendingInput: () => {
        this.pendingDx = 0;
        this.pendingDy = 0;
        this.pendingKeys = 0;
      },
      onSyncRenderState: (s) => this.onSyncRenderState?.(s),
    });
  }

  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  /**
   * 渲染主线 → 权威同步回调（兜底触发时携带渲染主线帧完整状态；app.ts
   * 注册后发 `sync-render-state` 消息给 Worker 权威物理，并清双端输入增量）。
   */
  onSyncRenderState: ((s: {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  }) => void) | null = null;

  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.config?.hud?.fov ?? FOV_DEFAULT,
      width / Math.max(height, 1),
      0.1,
      100000,
    );
    this.camera.position.set(0, 100, 0);

    // 固定三点光（替代原 LightManager）
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const hemi = new THREE.HemisphereLight(0xb0c4de, 0x404030, 0.4);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff4e0, 0.5);
    dir.position.set(100, 200, 100);
    this.scene.add(dir);

    // 背景
    this.scene.background = new THREE.Color(0x222222);
  }

  /** 加载 Worker 传来的场景（GLB + spawn + pvs）。 */
  async loadScene(data: SceneDataMessage): Promise<void> {
    if (!this.scene || !this.camera) return;
    this.disposeScene();

    // 1. GLB → Scene
    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    scene.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(scene);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    this.scene.add(scene);

    // 1.5 空间分块合并（GLB 挂载后、PVS/LOD 注册前）：3.4 万 mesh → ~300~800 空间块。
    //    必须在下方 traverse（lodItems 收集 + clusterIds 分配 = lodManager.setup/
    //    assignClusterIds 的主线程等价物）之前执行——setup 收集分块后的块 mesh。
    this.optimizeScene(scene, gltf.scene);

    // 2. 相机 near/far（near 自适应：默认 maxDim/1000，贴墙由 updateNearPlane 收缩）
    this.defaultNear = Math.max(maxDim / 1000, RendererMain.CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // 3. PVS + LOD 注册
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodItems.length = 0;
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const bs = geom.boundingSphere!;
      mesh.userData.lodLevel = LOD_NEAR;
      // clusterIds：空间采样分配（与主项目 lodManager.assignClusterIds 同法；
      // 不依赖 GLB extras.faceIndex——WASM 导出未写入该字段，原 getFaceCluster 恒 -1）
      const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      const set = new Set<number>();
      const r = Math.max(bs.radius, 1);
      const samples: Array<[number, number, number]> = [
        [center.x, center.y, center.z],
        [center.x + r, center.y, center.z],
        [center.x - r, center.y, center.z],
        [center.x, center.y + r, center.z],
        [center.x, center.y - r, center.z],
        [center.x, center.y, center.z + r],
        [center.x, center.y, center.z - r],
      ];
      for (const [x, y, z] of samples) {
        const cl = this.pvsManager!.getClusterAt({ x, y, z });
        if (cl >= 0) set.add(cl);
      }
      this.lodItems.push({
        mesh,
        center,
        radius: bs.radius,
        clusterIds: [...set],
      });
    });

    // 4. 视距剔除距离：对角线 × 0.5
    this.cullDistance = Math.max(maxDim * 0.5, 1000);


    // 5. 回传死亡阈值（场景最低 Y - 1000；P5 修复：按注释语义传
    //    bbox.min.y - 1000，此前误传 bbox.min.y 本身——玩家贴最低几何
    //    处浮点抖动即被判定坠落重生）
    this.onSceneLoaded?.(bbox.min.y - 1000);

    // 6. 纹理画质 manifest + 按当前画质应用（mosaic 切换数据源）
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);
  }

  // ── 纹理画质切换（原始 / mosaic 压缩低清）────────────────────

  /**
   * 按画质档位替换场景全部贴图：mini = mosaic 字节码还原低清 PNG；
   * original = 恢复缓存的原图。即时生效（替换 texture.image），无需重载地图。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    const manifest = this.mosaicManifest;
    if (!manifest || !this.scene) return;
    const maps = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        const map = (m as unknown as { map?: THREE.Texture | null }).map;
        if (map) maps.add(map);
      }
    });
    const jobs: Promise<void>[] = [];
    for (const map of maps) {
      if (quality === 'original') {
        const orig = this.origTextureImages.get(map);
        if (orig !== undefined) {
          map.dispose(); // 尺寸可能变化（512 低清 → 原始），强制重建 GPU 纹理
          map.image = orig;
          map.needsUpdate = true;
          this.origTextureImages.delete(map);
        }
        continue;
      }
      const code = manifest[(map.name ?? '').toLowerCase()];
      if (!code) continue;
      if (!this.origTextureImages.has(map)) this.origTextureImages.set(map, map.image);
      jobs.push(this.replaceMapWithMosaic(map, code));
    }
    await Promise.all(jobs);
  }

  /** 单个贴图：mosaic 字节码 → 低清 PNG → ImageBitmap 替换 image。
   * 替换前必须 dispose()：three.js r152+ 对同一 texture 的 image 替换走增量
   * glTexSubImage2D——新 image 尺寸与原 GPU 纹理不符会 GL_INVALID_VALUE 越界、
   * 上传失败（纹理保持旧内容）。dispose 后重建 GPU 纹理（按新尺寸分配）。 */
  private async replaceMapWithMosaic(map: THREE.Texture, code: string): Promise<void> {
    try {
      const png = mosaic_decode(code, 8);
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      map.dispose();
      map.image = bitmap;
      map.needsUpdate = true;
    } catch (e) {
      console.warn('[renderer] mosaic 贴图替换失败:', e);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  disposeScene(): void {
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isBspModel) {
          this.disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    this.pvsManager = null;
    this.lodItems.length = 0;
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    // 权威帧校准状态清零（防跨地图残留权威帧注入新地图）
    this.calibrator.clear();
  }

  /**
   * 近平面自适应（同步自主项目）：检测相机 4 方向（相机局部系，4 水平正交）
   * NEAR_PROBE_DIST 内最近的 mesh，动态设置 camera.near。
   * - 贴墙 → near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)，墙面不被裁剪
   * - 空旷 → 恢复场景默认
   * 性能：包围球粗筛候选后做 6 方向 raycaster，每 2 帧一次。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    if (!camera || !this.scene) return;
    const probe = this.nearProbeDist;
    this._nearOrigin.set(px, py, pz);

    // 1. 包围球粗筛（BSP 模型子树）
    const candidates: THREE.Mesh[] = [];
    for (const root of this.scene.children) {
      if (!root.userData?.isBspModel) continue;
      root.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry as THREE.BufferGeometry | null;
        if (!geom) return;
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const bs = geom.boundingSphere;
        if (!bs) return;
        this._nearSphere.copy(bs).applyMatrix4(mesh.matrixWorld);
        if (this._nearSphere.center.distanceTo(this._nearOrigin) < probe * 2 + this._nearSphere.radius) {
          candidates.push(mesh);
        }
      });
    }

    // 2. 相机局部基向量 + 4 方向（4 水平正交）探测最近几何
    let minD = Infinity;
    if (candidates.length > 0) {
      const q = camera.quaternion;
      this._nearDirF.set(0, 0, -1).applyQuaternion(q);
      const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
      const dirs = [
        this._nearDirF,
        this._nearDirF.clone().negate(),
        right.clone(),
        right.clone().negate(),
      ];
      for (const dir of dirs) {
        this._nearRaycaster.set(this._nearOrigin, dir);
        this._nearRaycaster.near = 0;
        this._nearRaycaster.far = probe;
        const hits = this._nearRaycaster.intersectObjects(candidates, false);
        if (hits.length > 0 && hits[0].distance < minD) {
          minD = hits[0].distance;
        }
      }
    }

    // 3. 设定 near（贴墙收缩，空旷恢复默认）
    const target =
      isFinite(minD)
        ? Math.max(minD * this.nearRatio, RendererMain.CAMERA_NEAR_MIN)
        : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
  }

  /** 实时调整近平面自适应参数（面板调用；下一帧探测即生效）。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    if (probeDist !== undefined && probeDist > 0) {
      this.nearProbeDist = probeDist;
    }
    if (ratio !== undefined && ratio > 0 && ratio <= 1) {
      this.nearRatio = ratio;
    }
  }

  /** 设置视野角 FOV（度，面板调用；相机透视矩阵即时更新）。 */
  setFov(fov: number): void {
    if (!this.camera) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  // ── 主线程唯一物理线 ───────────────────────────────────────

  /** 主线程初始化 wasm（PhysWorld 模块）。dist 内嵌模式传 wasmB64（file:// 无法 fetch）。
   * 注意：用 initSync({module})——async init() 解构 {module_or_path}，传 {module} 会
   * 解构出 undefined 走 new URL(import.meta.url) 路径（dist 下 import.meta.url 被
   * define 为 about:blank → "Failed to construct 'URL'"，dev 下多余一次 fetch）。 */
  async initPrediction(wasmUrl: string, wasmB64?: string): Promise<void> {
    if (wasmB64) {
      const bin = atob(wasmB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      initSync({ module: bytes.buffer as ArrayBuffer });
      return;
    }
    const resp = await fetch(wasmUrl);
    const buf = await resp.arrayBuffer();
    initSync({ module: buf });
  }

  /** world-json 到达：主线程构建 PhysWorld（唯一物理：世界+碰撞+输入+渲染）。 */
  buildPredictionWorld(world: {
    brushJson: string;
    triJson: string;
    teleportJson: string;
    spawn: { x: number; y: number; z: number; yawDeg: number };
  }): void {
    const phys = new PhysWorld();
    phys.build_world(
      world.brushJson,
      world.triJson,
      world.teleportJson,
      world.spawn.x,
      world.spawn.y,
      world.spawn.z,
      world.spawn.yawDeg,
    );
    this.predPhys = phys;
    this.predReady = true;
    // 权威帧校准状态清零（首帧权威帧将作为新起点）
    this.calibrator.clear();
  }

  /** 物理实例输入（app 事件回调喂入；唯一输入通道）。 */
  feedInput(dx: number, dy: number, keysMask: number): void {
    this.pendingDx += dx;
    this.pendingDy += dy;
    this.pendingKeys = keysMask;
  }

  /** 清空待喂输入（Pointer Lock 退锁/重锁时调用，防残留输入污染）。 */
  clearPendingInput(): void {
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
  }

  /** 重生（面板/按键；主线程物理直接 respawn，不经 Worker）。 */
  respawn(): void {
    this.predPhys?.respawn();
  }

  /** 传送至指定出生点索引（面板 spawn 下拉）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
  }

  /** 设置出生点列表（[[x,y,z,yaw], ...]，spawn 下拉切换用）。 */
  setSpawnPoints(list: Array<[number, number, number, number]>): void {
    try {
      this.predPhys?.set_spawn_points(JSON.stringify(list));
    } catch (err) {
      console.error('[renderer] set_spawn_points 失败:', err);
    }
  }

  /** 设置死亡 Y 阈值（loadScene 后由 onSceneLoaded 回调传入）。 */
  setDeathY(y: number): void {
    this.predPhys?.set_death_y(y);
  }

  /** 当前物理速度（速度面板 8Hz 采样）。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  /** 渲染线当前完整状态（P4-B1 恢复对齐：后台回前台时权威 set_state 用）。
   * 与 sync-render-state 消息 payload 同构；无物理实例时返回 null。 */
  getRenderSyncState(): {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
    eyeHeight: number;
  } | null {
    if (!this.predPhys) return null;
    const st = this.predPhys.state() as {
      posX: number; posY: number; posZ: number;
      yaw: number; pitch: number;
      velX: number; velY: number; velZ: number;
      onGround: boolean;
      eyeHeight: number;
    };
    return {
      posX: st.posX, posY: st.posY, posZ: st.posZ,
      yaw: st.yaw, pitch: st.pitch,
      velX: st.velX, velY: st.velY, velZ: st.velZ,
      onGround: st.onGround, eyeHeight: st.eyeHeight,
    };
  }

  /** 清空权威校准状态（P4-B1 恢复时调用：旧权威帧不把恢复后的新状态拉回）。 */
  clearCalibrator(): void {
    this.calibrator.clear();
  }

  /** 调试/验证：返回当前渲染物理状态快照（未就绪返回 null）。 */
  getDebugState(): Record<string, number | boolean> | null {
    if (!this.predPhys) return null;
    const st = this.predPhys.state() as Record<string, number | boolean>;
    return { ...st, ready: this.predReady };
  }

  /** 调试/验证：返回校准器统计（反向同步/碰撞驳回等）。 */
  getDebugStats(): { syncCount: number; collisionRejectCount: number; lastSyncAt: number } {
    return {
      syncCount: this.calibrator.debugSyncCount,
      collisionRejectCount: this.calibrator.debugCollisionRejectCount,
      lastSyncAt: this.calibrator.debugLastSyncAt,
    };
  }

  /**
   * 权威帧到达（A2）处理 / 速度外推校准 / 碰撞事件位置兜底驳回 / 位置突变归零。
   * 公共化：实现收敛到 ts-shared AuthorityCalibrator（correctFromAuthority
   * 三条件 OR + 63ms 冷却 + syncInFlight 持续拉回权威、calibrateVelocity 外推、
   * applyCollisionCorrection <60 反向同步、resetTo 归零）。
   */
  private correctFromAuthority(): void {
    this.calibrator.correctFromAuthority();
  }

  /** 逐帧速度校准（权威速度外推反馈；实现见 ts-shared AuthorityCalibrator）。 */
  private calibrateVelocity(now: number): void {
    this.calibrator.calibrateVelocity(now);
  }

  /** 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换）。 */
  resetTo(pos: number[], yawDeg: number): void {
    this.calibrator.resetTo(pos, yawDeg);
  }

  /**
   * 权威碰撞事件 → 位置兜底驳回（不再把权威位置写回渲染；改为反向同步权威，
   * 实现见 ts-shared AuthorityCalibrator）。
   */
  applyCollisionCorrection(kind: 'land' | 'blocked', pos: number[], yawDeg: number, pitchDeg: number, vel?: number[]): void {
    this.calibrator.applyCollisionCorrection(kind, pos, yawDeg, pitchDeg, vel);
  }

  /** 面板参数实时同步到主线程物理实例（与 set_params 同字段）。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /**
   * noclip 模式同步到主线程物理。
   * Rust tick 在 noclip 下走 noclip_step（无碰撞纯移动 + Q/E 转向），
   * 物理实例内部切换，无需额外渲染分支。
   */
  setPredictionNoclip(active: boolean): void {
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    this.clearPendingInput();
  }

  /** 面板体型实时同步到主线程物理实例。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        const tex = (mat as unknown as Record<string, unknown>).map as THREE.Texture | undefined;
        if (tex?.isTexture) tex.dispose();
        mat.dispose();
      }
    });
  }

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera) return;

    // 1. 主线程渲染物理线 + Worker 权威帧校准（v7）：
    //    写输入 SAB（Worker 权威模拟同输入）→ 读权威帧 → 外推校准 → tick → 渲染
    if (this.predReady && this.predPhys) {
      const dt = this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = now;
      // 输入 → SAB 输入槽（Worker 权威帧模拟消费；与主线程同输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧到达 → 记录（只读）；首次 set_state 起点；>200 异常兜底
      this.correctFromAuthority();
      // 权威速度外推校准（考虑中途地图碰撞后的正确速度；位置不覆盖）
      this.calibrateVelocity(now);
      // 完整物理推进：physics = 碰撞/传送/死亡/reset；noclip = noclip_step（无碰撞）
      // 风险5：卡顿恢复首帧 dt 最大 0.1s，单步 100ms 在高速 surf 下可穿薄墙。
      // 拆成 ≤1/64s 子步（与权威 tick 对齐），输入按时间比例分摊，保持总输入量不变。
      const MAX_PRED_STEP = 1 / 64;
      let remaining = dt;
      while (remaining > 1e-9) {
        const step = Math.min(remaining, MAX_PRED_STEP);
        const inputScale = step / dt;
        this.predPhys.tick(step, this.pendingKeys, this.pendingDx * inputScale, this.pendingDy * inputScale);
        remaining -= step;
      }
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 渲染 = 主线程物理状态（连续无屏闪）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      // Rust 输出角度为度 → 弧度
      this.camera.rotation.set(st.pitch * DEG2RAD, st.yaw * DEG2RAD, 0, 'YXZ');
      this.camera.position.set(st.posX, st.posY + st.eyeHeight, st.posZ);

      // 近平面贴墙自适应（每 2 帧）：贴墙收缩 near 防近平面裁剪透视
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle) {
        this.updateNearPlane(st.posX, st.posY + st.eyeHeight, st.posZ);
      }
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除
    if (this.lodItems.length > 0) {
      const pvs = this.pvsManager;
      if (ENABLE_PVS && pvs) pvs.update(camPos);
      // PVS 安全保护（主项目同法）：相机不在任何 cluster（出生在固体/地图外）时
      // 可见集为空，有 cluster 的 mesh 会被错误全剔 → 跳过 PVS，仅按距离 LOD
      const pvsActive = ENABLE_PVS && pvs !== null && pvs.enabled;
      const pvsClusterValid = pvs !== null && pvs.currentClusterId >= 0;
      for (const item of this.lodItems) {
        const dist = item.center.distanceTo(camPos);
        let level = LOD_NEAR;
        if (dist > this.cullDistance) {
          level = LOD_FAR;
        } else if (
          pvsActive &&
          pvsClusterValid &&
          item.clusterIds.length > 0 &&
          !item.clusterIds.some((c) => pvs!.isVisible(c))
        ) {
          level = LOD_PVS_HIDDEN;
        }
        if (item.mesh.userData.lodLevel !== level) {
          item.mesh.userData.lodLevel = level;
          item.mesh.visible = level === LOD_NEAR;
        }
      }
    }

    // 3. 渲染（快照就绪后无条件渲染，帧率跟随 rAF）
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  setCullDistance(dist: number): void {
    this.cullDistance = dist;

  }

  // ── GLB 加载 ───────────────────────────────────────────────

  private readonly gltfLoader = new GLTFLoader();

  private async loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
    const buffer = new Uint8Array(glbBytes.byteLength);
    buffer.set(new Uint8Array(glbBytes));
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    try {
      return await this.gltfLoader.loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private resetRootRotations(gltf: GLTF): void {
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
  // 移植自 test/dual-mode-harness/src/worker-b.ts optimizeScene（已验证：34409 mesh → 300~800 块）。
  // 与 test 的差异（Worker → 主线程）：
  // - 载体：test 重建 modelRoot 组替换；本实现直接在 BSP 根（bspRoot，userData.isBspModel
  //   保留不变）内替换内容——移除 gltf.scene、块 mesh 直接挂 BSP 根；
  // - 时序：loadScene 中场景挂载（this.scene.add）之后、PVS/LOD 注册 traverse 之前执行——
  //   下方 traverse 收集分块后的 mesh（lodItems + clusterIds 对块生效）；
  // - 统计：前向视锥估算用 this.camera（非 Worker 模块级 camera）。
  // 流程：① scene.updateMatrixWorld(true) → traverse 收集 Mesh（世界包围盒中心）
  // ② cell 自适应（世界对角 / cbrt(目标块数)，微调落 [300,800]）
  // ③ 顶点 applyMatrix4(matrixWorld) 烘焙世界空间（clone 后变换，勿动原 geometry）
  // ④ 单 mesh cell 保留原 mesh（变换清零重挂）；多 mesh cell 块内按材质（实例恒等）子
  //    合并 → mergeGeometries(useGroups=true) 最终合并（groups 保留材质索引）；多材质/
  //    无材质 mesh 防御性烘焙保留；失败保持场景原状（计算先行、后替换）
  // ⑤ console.log 统计：原 mesh 数 → 块数、平均顶点、draw call 估算、前向视锥可见块
  private optimizeScene(bspRoot: THREE.Scene, gltfScene: THREE.Object3D): void {
    // ① 收集：matrixWorld 更新后作为世界变换基准；多材质 mesh（GLB primitive 恒单材质，
    //    防御性路径）与无材质 mesh 单独烘焙保留，不参与分块
    bspRoot.updateMatrixWorld(true);
    const infos: OptMeshInfo[] = [];
    const keptMeshes: THREE.Mesh[] = [];
    const worldBox = new THREE.Box3();
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    bspRoot.traverse((obj) => {
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
    const chunks: THREE.Mesh[] = [];
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
        chunks.push(m);
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
            chunks.push(new THREE.Mesh(mergedGeoms[i], mats[i]));
            chunkCount++;
            drawCallEst++;
          }
        }
      }
      for (const it of arr) it.mesh.geometry.dispose();
      chunkCount++;
      for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
      chunks.push(chunk);
    }

    // ④b 替换：移除原 GLB 子树（旧 mesh 几何已逐个 dispose），块 mesh 直接挂 BSP 根
    //    （bspRoot.userData.isBspModel 保留——disposeScene/updateNearPlane 依赖）；add()
    //    自动使块 mesh 脱离原父节点
    const totalMeshes = infos.length;
    for (const m of chunks) bspRoot.add(m);
    for (const m of keptMeshes) bspRoot.add(m);
    bspRoot.remove(gltfScene);

    // ④c 视锥外保一圈：块 geometry.boundingSphere 半径 ×FRUSTUM_PAD。
    //    必须强制 computeBoundingSphere（非 null 检查）：烘焙路径是 geometry.clone() +
    //    applyMatrix4(matrixWorld)——克隆残留 GLB 局部空间的旧球（非 null 会被跳过）→
    //    剔除按错误位置判定 → 眼前块被误剔不渲染。顶点已烘焙世界空间 → 重算球正确。
    //    只影响剔除判定，不改变几何/包围盒；LOD/PVS（userData 数据）不受影响。
    for (const child of bspRoot.children) {
      const g = (child as THREE.Mesh).geometry;
      if (!g) continue;
      g.computeBoundingSphere();
      (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
    }

    // ⑤ 统计 + 前向视锥可见块估算（仅诊断：块包围盒中心与相机方向点积粗估，FOV 73.6°）
    const chunkBox = new THREE.Box3();
    const chunkCenter = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    let visibleEst = -1;
    const camera = this.camera;
    if (camera) {
      camera.updateMatrixWorld(true);
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      const cosHalfFov = Math.cos(((this.config?.hud?.fov ?? FOV_DEFAULT) / 2) * DEG2RAD);
      visibleEst = 0;
      for (const child of bspRoot.children) {
        const mesh = child as THREE.Mesh;
        chunkBox.setFromObject(mesh);
        if (chunkBox.isEmpty()) continue;
        chunkBox.getCenter(chunkCenter);
        toCam.subVectors(chunkCenter, camera.position);
        const dist = toCam.length();
        if (dist < camera.far && toCam.dot(camDir) / dist > cosHalfFov) visibleEst++;
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
}
