/**
 * WebSurf — 主线程渲染器（阶段 1：主线程解析/物理接管，LERP 删除、渲染直读）
 * 主线程 PhysWorld 每 rAF tick 推进（真实物理模拟 + 碰撞），state() 直读渲染——
 * 相机同步 → LOD/PVS 剔除 → 雾/碰撞箱可视化/准星射线 → Draw Call。
 * 场景数据由主线程（app.ts handleLoadBsp）解析后本地传入（GLB + 碰撞体/PVS/出生点/传送点 JSON），
 * 本类承担 GLTFLoader 建场景及 LOD/PVS/雾/碰撞箱/准星/lightmap 等子管理器。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
// mosaic 画质切换：主线程懒初始化同一 wasm 模块（与 worker 实例互不影响）
import { ensureMainWasm, mosaic_decode } from '../main-wasm.js';
// 主线程唯一物理线：PhysWorld 与 BspProcessor 同模块（main-wasm 已 initSync）
import { PhysWorld } from '../../pkg/websurf_wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { PlaneInfo, SceneDataMessage } from '../worker/worker-types.js';
import type { SharedState } from '../../../src/ts-shared/auth/shared-state.js';
import { AuthorityCalibrator } from '../../../src/ts-shared/phys/authority-calibrator.js';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import { PvsManager } from '../world/pvs-manager.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';
import { TeleportManager } from '../world/teleport-manager.js';
import { adaptBrushes } from '../world/collider-adapter.js';
import { CameraController } from './camera-controller.js';
import { ColliderDebug } from './collider-debug.js';
import { FogManager } from './fog-manager.js';
import { LightManager } from './light-manager.js';
import { LodManager } from './lod-manager.js';
import { PlaneInspector } from './plane-inspector.js';
import { applyLightmapToMeshes, loadLightmapAtlas } from './lightmap-shader.js';

/** 视场角（度）。 */
const FOV = 73.6;
/** 准星射线检测限流（每 N 帧一次）。 */
const PLANE_INSPECT_INTERVAL = 6;
/** 近裁剪面下限（HU）：贴墙时近平面动态收缩到最近几何距离的 80%（不低于此值），
 * 防近平面裁剪穿墙；相机位置不动，只改投影矩阵。 */
const CAMERA_NEAR_MIN = 0.05;
/** 近平面收缩探测距离（HU）默认值：相机距墙最小距离 = 碰撞箱半宽（默认 16，
 * 蹲下/半宽缩放后更近），射线必须能覆盖该距离才能探测到面前的墙——
 * 原值 4 永远够不到 16 单位外的墙，贴墙时 near 保持默认大值，墙被近平面
 * 裁剪 → 透视看到地图外面。
 * 48 = 3×最小贴墙距离：配合 8 个水平探测方向（相邻夹角 45°），任意贴墙
 * 角度下最近方向与墙面夹角 ≥ 22.5°，斜距 ≤ 16/sin22.5° ≈ 41.8 < 48，
 * 垂直墙全角度可探测（原 32 + 仅 4 个正交方向时，斜贴墙掠射角 < 30°
 * 会漏检，minD 落到地面 ≈64 → near 收缩不足 → 垂直墙仍透视）。
 *
 * 运行时可调：面板「显示设置 → 近平面探测距离/收缩系数」实时生效
 * （setNearParams）。
 */
const NEAR_PROBE_DIST_DEFAULT = 100;
/** near 收缩系数默认值：near = 最近几何距离 × 此值。 */
const NEAR_RATIO_DEFAULT = 0.3;

/** 剔除统计回调（主线程直接更新 UI）。 */
export interface CullStatsLike {
  visible: number;
  total: number;
  cullDist: number;
  pvs: {
    cluster: number;
    visibleClusters: number;
    totalClusters: number;
    pvsHidden: number;
    near: number;
    far: number;
  };
}

/** 主线程渲染物理事件（Rust take_event 消费：计时挑战检查点/死亡）。 */
export interface RenderPhysEvent {
  kind: string;
  /** teleport 目标名。 */
  targetname?: string;
  /** teleport 目标位置（Y-up）。 */
  origin?: number[];
  /** teleport 目标 yaw（度）。 */
  yaw?: number;
}

/** 主线程渲染器。 */
export class RendererMain {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cameraController: CameraController | null = null;
  private pvsManager: PvsManager | null = null;
  private teleportManager: { getTriggers(): readonly TeleportTrigger[] } | null = null;
  /** 实体碰撞体列表（碰撞箱可视化，solids + ladders 合并）。 */
  private colliders: Brush[] = [];
  /** solids 列表（准星射线检测区分 brushType）。 */
  private solids: Brush[] = [];
  /** ladders 列表（准星射线检测区分 brushType）。 */
  private ladders: Brush[] = [];
  /** 传送触发器列表（准星射线检测 trigger）。 */
  private triggers: TeleportTrigger[] = [];
  /** BSP 模型场景组（准星射线检测 mesh）。 */
  private bspModelScene: THREE.Object3D | null = null;

  private readonly lightManager = new LightManager();
  private readonly fogManager = new FogManager();
  private readonly lodManager = new LodManager();
  private readonly colliderDebug = new ColliderDebug();
  private readonly planeInspector = new PlaneInspector();

  private planeInfoEnabled = false;
  private planeInspectCounter = 0;
  private lastPlaneInfo: PlaneInfo | null = null;

  // ── 近平面贴墙自适应（面板可实时调节）────────────────────
  /** 探测距离（HU）；↑ 更斜掠射也能命中，粗筛候选略增。 */
  private nearProbeDist = NEAR_PROBE_DIST_DEFAULT;
  /** near 收缩系数：near = 最近几何距离 × 此值；↓ 更保守更不易裁墙。 */
  private nearRatio = NEAR_RATIO_DEFAULT;

  private config: RuntimeConfig = null as unknown as RuntimeConfig;
  private needsRender = true;
  private rafId = 0;
  private running = false;

  // ── 主线程唯一物理线（阶段 1：LERP 删除、渲染直读 state()）──
  /** 主线程 PhysWorld 实例（唯一物理渲染线：世界+碰撞+输入；每帧 tick 推进）。 */
  private predPhys: PhysWorld | null = null;
  /** 主线程物理就绪（buildPredictionWorld 完成）。 */
  private predReady = false;
  /** 待喂给物理实例的输入（app 事件回调累积）。 */
  private pendingDx = 0;
  private pendingDy = 0;
  private pendingKeys = 0;
  /** noclip 模式（Rust set_noclip，tick 走 noclip_step 无碰撞纯移动）。 */
  private noclipActive = false;
  /** 渲染帧推进（dt 上限防异常）。 */
  private lastTickMs = 0;
  /** 死亡阈值 Y（loadScene 回调记录；buildPredictionWorld 时应用）。 */
  private deathY: number | null = null;

  // ── 权威帧校准（阶段 2，公共化：AuthorityCalibrator 收敛到 ts-shared）──
  /** 权威校准（correctFromAuthority 三条件 OR + 250ms 冷却 + syncInFlight 回滚、
   * calibrateVelocity 外推、applyCollisionCorrection <60 微调、resetTo 归零）。 */
  private readonly calibrator: AuthorityCalibrator;

  // ── 近平面自适应（防穿墙：不移动相机，动态收缩 near）────────
  private readonly _nearRaycaster = new THREE.Raycaster();
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private nearCheckToggle = false;
  /** 场景默认 near（maxDim/1000 下限 NEAR_MIN）。 */
  private defaultNear = CAMERA_NEAR_MIN;

  /** 剔除统计回调（主线程更新 UI）。 */
  onCullStats: ((stats: CullStatsLike) => void) | null = null;
  /** 场景加载完成回调（携带死亡阈值 Y 下限，主线程回传 Worker）。 */
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

  /** 渲染物理事件回调（Rust take_event 消费：计时挑战检查点/死亡统计）。 */
  onPhysEvent: ((ev: RenderPhysEvent) => void) | null = null;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest：{ 纹理名(小写 basetexture): mosaic 字节码 }。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原始贴图图像缓存（切换回 original 时恢复）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  constructor(
    private readonly shared: SharedState,
  ) {
    // config 在 init() 中赋值
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

  // ── 生命周期 ───────────────────────────────────────────────

  /** 初始化渲染器/场景/相机与子管理器。 */
  init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: RuntimeConfig): void {
    this.config = config;
    // 阶段 1：SharedState 注入保留（后续阶段接 SAB 权威帧通道）；本阶段渲染直读本地物理，不再读其输出
    console.log(`[renderer] 跨线程通道: ${this.shared.isShared ? 'SAB' : 'MsgState'}（阶段 1 渲染直读本地物理）`);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();

    const aspect = width / Math.max(height, 1);
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 100000);
    this.camera.position.set(2000, 2000, 2000);

    this.cameraController = new CameraController(this.camera, config.input);

    this.lightManager.applyLights(this.scene, config);
    this.colliderDebug.init(this.scene);
    this.colliderDebug.setDebugFlags(
      config.debug.showSolids,
      config.debug.showTriggers,
      config.debug.triggerViewDistance,
      config.debug.brushViewDistance,
    );
    this.colliderDebug.setTriDebugFlags(
      config.debug.showPhy,
      config.debug.showVis,
      config.debug.phyViewDistance,
      config.debug.visViewDistance,
    );
    this.planeInfoEnabled = config.debug.showPlaneInfo;

    this.needsRender = true;
  }

  /**
   * 卸载当前地图的全部渲染资源（触发文件输入/加载新地图时调用）。
   *
   * three.js 的 `scene.remove()` 只摘除场景图，geometry/material/纹理等
   * GPU 侧资源不会自动释放——多次加载地图会累积显存与 JS 堆，导致
   * 帧率逐步下降。本方法递归 dispose 全部 BSP 模型资源，并清空
   * LOD/PVS/碰撞可视化/插值缓存等子管理器状态。
   *
   * 保留：灯光、雾（由 LightManager/FogManager 独立管理，替换式更新）。
   */
  disposeScene(): void {
    // 1. BSP 模型：递归释放 geometry/material/纹理（GPU 真正释放）
    if (this.scene) {
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData?.isBspModel) {
          this.disposeObject(child);
          this.scene.remove(child);
        }
      }
    }
    this.bspModelScene = null;

    // 2. three.js 渲染列表（GPU 侧 draw-call 缓存）
    this.renderer?.renderLists?.dispose();

    // 3. 子管理器状态清零
    this.lodManager.dispose();
    this.pvsManager = null;
    this.teleportManager = null;
    this.colliders = [];
    this.solids = [];
    this.ladders = [];
    this.triggers = [];
    // 碰撞可视化清空（保留 group/scene 引用，新地图 rebuild 直接复用）
    this.colliderDebug.clearAll();

    // 4. 主线程物理渲染线状态清零（防跨地图残留输入）
    this.predPhys = null;
    this.predReady = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    this.pendingKeys = 0;
    this.noclipActive = false;
    this.lastTickMs = 0;
    this.deathY = null;
    // 权威帧校准状态清零（防跨地图残留权威帧注入新地图）
    this.calibrator.clear();
    this.needsRender = true;
  }

  /** 递归释放 Object3D 子树的 geometry/material/纹理（GPU 侧真正释放）。 */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // 释放材质引用的纹理（map/lightMap/emissive 等；重复 dispose 幂等安全）
        for (const key of [
          'map',
          'lightMap',
          'emissiveMap',
          'normalMap',
          'roughnessMap',
          'metalnessMap',
          'aoMap',
          'alphaMap',
          'bumpMap',
          'specularMap',
          'envMap',
        ]) {
          const tex = (mat as unknown as Record<string, unknown>)[key] as
            | THREE.Texture
            | undefined;
          if (tex?.isTexture) tex.dispose();
        }
        mat.dispose();
      }
    });
  }

  /** 加载场景数据（GLB + PVS + 碰撞体 + 传送点 + lightmap + 雾；主线程本地数据）。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.scene || !this.camera) return null;
    this.disposeScene();

    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    gltf.scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    this.collectMetadata(scene);

    // lightmap（存在时应用；主线程 GLB 解析期生成）
    const atlasTexture = await loadLightmapAtlas(gltf.parser, gltf);
    if (atlasTexture) {
      applyLightmapToMeshes(scene, atlasTexture);
    }
    scene.updateMatrixWorld(true);
    const boundingBox = new THREE.Box3().setFromObject(scene);
    const size = boundingBox.getSize(new THREE.Vector3());
    const diagonal = size.length();

    // 移除旧 BSP 模型子树（disposeScene 已处理旧资源，此处摘除引用防叠加）
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const child = this.scene.children[i];
      if (child.userData?.isBspModel) {
        this.scene.remove(child);
      }
    }
    scene.userData.isBspModel = true;
    this.bspModelScene = scene;
    this.scene.add(scene);

    const maxDim = Math.max(size.x, size.y, size.z);
    this.defaultNear = Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // LOD/PVS 注册（主线程本地数据源）
    const diagInfo = this.lodManager.setup(scene, this.config);
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodManager.assignClusterIds(this.pvsManager);

    // 传送触发器（本地解析；碰撞箱可视化 + 准星射线）
    this.teleportManager = new TeleportManager(data.teleportJson);
    this.triggers = [...this.teleportManager.getTriggers()];
    this.colliderDebug.setTriggers(this.triggers);
    if (data.triJson) {
      this.colliderDebug.setTriMeshes(JSON.parse(data.triJson));
    }

    // 纹理画质 manifest + 按当前画质应用（mosaic 切换数据源）
    this.mosaicManifest = data.mosaicManifest
      ? (JSON.parse(data.mosaicManifest) as Record<string, string>)
      : null;
    void this.applyTextureQuality(this.config.texture.quality);

    // 实体碰撞体（碰撞箱可视化 + 准星射线；主线程本地 adaptBrushes）
    const adaptResult = adaptBrushes(data.brushJson);
    this.colliders = [...adaptResult.solids, ...adaptResult.ladders];
    this.solids = adaptResult.solids;
    this.ladders = adaptResult.ladders;

    // 雾（按场景包围球初始化）
    const center = boundingBox.getCenter(new THREE.Vector3());
    const radius = diagonal / 2;
    this.fogManager.init(this.scene, radius, center);
    this.fogManager.setColor(this.config.lighting.bgColor);

    // 剔除距离校准（场景加载后）
    this.config.lod.cullDistance = this.lodManager.cullDistance;

    this.needsRender = true;
    this.onSceneLoaded?.(boundingBox.min.y);
    this.emitCullStats();
    return {
      diagonal: diagInfo.diagonal,
      defaultCull: diagInfo.defaultCull,
      maxCull: diagInfo.maxCull,
    };
  }

  /** 启动 rAF 渲染循环。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  /** 停止渲染循环。 */
  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  // ── 渲染循环（阶段 1：主线程物理渲染线）──────────────────────

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera || !this.cameraController) return;

    // 1. 主线程渲染物理线 + Worker 权威帧校准（阶段 2，game 同序）：
    //    写输入 SAB（Worker 权威模拟同输入）→ 读权威帧 → 外推校准 → tick → 渲染
    if (this.predReady && this.predPhys) {
      const dt = this.lastTickMs === 0 ? 1 / 64 : Math.min((now - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = now;
      // 输入 → SAB 输入槽（Worker 权威帧模拟消费；与主线程同输入）
      this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
      // 权威帧到达 → 记录（只读）；首次 set_state 起点；大偏差异常兜底
      this.correctFromAuthority();
      // 权威速度外推校准（考虑中途地图碰撞后的正确速度；位置不覆盖）
      this.calibrateVelocity(now);
      // 完整物理推进：physics = 碰撞/传送/死亡/reset；noclip = noclip_step（无碰撞）
      this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
      this.pendingDx = 0;
      this.pendingDy = 0;
      // 物理事件消费（计时挑战：teleport 检查点 / death 回退，回调 app.ts）
      this.consumePhysEvents();
      // 渲染 = 主线程物理状态（Rust 输出角度为度 → 弧度）
      const st = this.predPhys.state() as {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        eyeHeight: number;
      };
      const cc = this.cameraController;
      cc.setYawPitch(st.yaw * DEG2RAD, st.pitch * DEG2RAD, false);
      cc.update();
      // 相机位置 = 眼睛（origin + eyeHeight），不做位置修正——防穿墙靠近平面自适应
      const camY = st.posY + st.eyeHeight;
      cc.setPosition(st.posX, camY, st.posZ);

      // 近平面自适应（每 2 帧）：贴墙收缩 near 防近平面裁剪透视；
      // noclip 位置不受碰撞约束，跳过探测
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle && !this.noclipActive && this.bspModelScene) {
        this.updateNearPlane(st.posX, camY, st.posZ);
      }
    }

    const camPos = this.camera.position;

    // 2. LOD/PVS 剔除
    if (this.lodManager.itemCount > 0) {
      if (this.lodManager.update(camPos, this.config, this.pvsManager)) {
        this.needsRender = true;
      }
    }

    // 3. 雾
    this.fogManager.update(camPos, this.fogManager.currentSceneRadius);

    // 4. 碰撞箱可视化
    if (this.colliderDebug.hasDebugWork) {
      if (this.colliderDebug.update(camPos, this.colliders, this.config)) {
        this.needsRender = true;
      }
    }

    // 5. 准星射线检测（限流）
    if (this.planeInfoEnabled) {
      this.planeInspectCounter++;
      if (this.planeInspectCounter >= PLANE_INSPECT_INTERVAL) {
        this.planeInspectCounter = 0;
        this.inspectPlane();
      }
    } else if (this.lastPlaneInfo !== null) {
      this.lastPlaneInfo = null;
    }

    // 6. 渲染：物理就绪后每帧无条件渲染（帧率跟随 rAF，不降频/限流）。
    //    needsRender 仅用于强制刷新（加载场景、LOD 变化等）。
    const shouldRender = this.predReady || this.needsRender;
    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }

    // 7. 周期剔除统计（主线程本地计算）
    if (now - this.lastStatsAt > 100) {
      this.lastStatsAt = now;
      this.emitCullStats();
    }
  }

  private lastStatsAt = 0;

  /** 准星射线检测（从相机正前方发射，与 mesh/碰撞体/触发器求交）。 */
  private inspectPlane(): void {
    if (!this.camera || !this.bspModelScene) return;
    this._fwdDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.lastPlaneInfo = this.planeInspector.cast(
      this.camera.position,
      this._fwdDir,
      this.bspModelScene,
      this.solids,
      this.ladders,
      this.triggers,
    );
  }

  /**
   * 近平面自适应：检测相机 4 方向（相机局部系，4 水平正交）NEAR_PROBE_DIST 内最近的 mesh，动态设置 camera.near。
   * - 贴墙 → near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)，墙面不被裁剪（相机不动，仅改投影）
   * - 空旷 → 恢复场景默认
   * 性能：包围球粗筛候选后做 4 方向 raycaster，每 2 帧一次。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    const scene = this.bspModelScene;
    if (!camera || !scene) return;
    this._nearOrigin.set(px, py, pz);
    const probe = this.nearProbeDist;

    // 1. 包围球粗筛
    const candidates: THREE.Mesh[] = [];
    scene.traverse((obj) => {
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
        ? Math.max(minD * this.nearRatio, CAMERA_NEAR_MIN)
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
    this.needsRender = true;
  }

  // ── 外部接口 ───────────────────────────────────────────────

  /** 最近一次准星检测结果（HUD 读取）。 */
  getPlaneInfo(): PlaneInfo | null {
    return this.lastPlaneInfo;
  }

  /** 调整渲染器与相机尺寸。 */
  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** 设置视距剔除距离。 */
  setCullDistance(dist: number): void {
    this.lodManager.setCullDistance(dist);
    this.config.lod.cullDistance = this.lodManager.cullDistance;
    this.needsRender = true;
  }

  /** 应用配置 patch（config 消息同步：lighting/debug 段在主线程生效）。 */
  applyConfigPatch(section: keyof RuntimeConfig, patch: Record<string, unknown>): void {
    const target = this.config[section];
    if (!target || typeof target !== 'object') return;
    Object.assign(target, patch);
    if (section === 'lighting') {
      this.lightManager.syncFromConfig(this.config);
      this.fogManager.setColor(this.config.lighting.bgColor);
      this.needsRender = true;
    } else if (section === 'debug') {
      this.colliderDebug.setDebugFlags(
        this.config.debug.showSolids,
        this.config.debug.showTriggers,
        this.config.debug.triggerViewDistance,
        this.config.debug.brushViewDistance,
      );
      this.colliderDebug.setTriDebugFlags(
        this.config.debug.showPhy,
        this.config.debug.showVis,
        this.config.debug.phyViewDistance,
        this.config.debug.visViewDistance,
      );
      this.planeInfoEnabled = this.config.debug.showPlaneInfo;
      this.needsRender = true;
    } else if (section === 'input' && this.cameraController) {
      this.cameraController.applyInputConfig(this.config.input);
    } else if (section === 'lod') {
      this.needsRender = true;
    } else if (section === 'texture') {
      void this.applyTextureQuality(this.config.texture.quality);
    }
  }

  // ── 纹理画质切换（原始 / mosaic 压缩低清）────────────────────

  /**
   * 按画质档位替换场景全部贴图：mini = mosaic 字节码还原低清 PNG；
   * original = 恢复缓存的原图。即时生效（替换 texture.image），无需重载地图。
   */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
    const manifest = this.mosaicManifest;
    console.log(
      `[renderer] 画质切换 → ${quality}，manifest ${manifest ? Object.keys(manifest).length : 0} 条，bspModelScene=${!!this.bspModelScene}`,
    );
    if (!manifest || !this.bspModelScene) return;
    const maps = new Set<THREE.Texture>();
    this.bspModelScene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        const map = (m as unknown as { map?: THREE.Texture | null }).map;
        if (map) maps.add(map);
      }
    });
    console.log(`[renderer] 场景贴图 ${maps.size} 个`);
    const jobs: Promise<void>[] = [];
    let matched = 0;
    const noMatch: string[] = [];
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
      if (!code) {
        noMatch.push(map.name ?? '(无名)');
        continue;
      }
      matched++;
      if (!this.origTextureImages.has(map)) this.origTextureImages.set(map, map.image);
      jobs.push(this.replaceMapWithMosaic(map, code));
    }
    console.log(`[renderer] mini 匹配 ${matched}/${maps.size}；未匹配:`, noMatch.slice(0, 12));
    await Promise.all(jobs);
    this.needsRender = true;
  }

  /** 单个贴图：mosaic 字节码 → 低清 PNG → ImageBitmap 替换 image。
   * 替换前必须 dispose()：three.js r152+ 对同一 texture 的 image 替换走增量
   * glTexSubImage2D（allocateMemory 仅首次为 true）——新 image 尺寸与原 GPU
   * 纹理不符会 GL_INVALID_VALUE 越界、上传失败（纹理保持旧内容 = "没生效"）。
   * dispose 后下次渲染重建 GPU 纹理（按新尺寸 texStorage2D）。 */
  private async replaceMapWithMosaic(map: THREE.Texture, code: string): Promise<void> {
    try {
      await ensureMainWasm();
      const png = mosaic_decode(code, 8);
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      map.dispose();
      map.image = bitmap;
      map.needsUpdate = true;
    } catch (e) {
      console.warn('[renderer] mosaic 贴图替换失败:', e);
    }
  }

  // ── 缺失材质纹理回退 ───────────────────────────────────────
  // 已在 GLB 导出期完成（export_glb_with_pakfile_models_with_defaults）：
  // Rust 侧对缺失材质直接嵌入默认纹理包的低清纹理，渲染端零后期处理。

  // ── 主线程唯一物理线（app.ts 接线入口）────────────────────

  /** 主线程构建 PhysWorld（唯一物理：世界+碰撞+输入+渲染）。 */
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
    if (this.deathY !== null) {
      phys.set_death_y(this.deathY);
    }
    this.predPhys = phys;
    this.predReady = true;
    this.noclipActive = false;
    this.lastTickMs = 0;
    // 权威帧校准状态清零（首帧权威帧将作为新起点）
    this.calibrator.clear();
    this.clearPendingInput();
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

  /** 物理参数（主线程实例直接 set_params；面板参数阶段 4 迁主线程）。 */
  setPredictionParams(params: Record<string, unknown>): void {
    try {
      this.predPhys?.set_params(JSON.stringify(params));
    } catch (err) {
      console.error('[renderer] set_params 失败:', err);
    }
  }

  /** 碰撞箱体型（立即生效）。 */
  setPredictionHull(halfWidth: number, standHeight: number, duckHeight: number): void {
    this.predPhys?.set_hull(halfWidth, standHeight, duckHeight);
  }

  /** noclip 模式（Rust set_noclip：tick 走 noclip_step 无碰撞纯移动）。 */
  setPredictionNoclip(active: boolean): void {
    this.noclipActive = active;
    try {
      this.predPhys?.set_noclip(active);
    } catch (err) {
      console.error('[renderer] set_noclip 失败:', err);
    }
    this.clearPendingInput();
  }

  /** 重生（主线程物理直接 respawn；与 Worker 双端同步）。 */
  respawn(): void {
    this.predPhys?.respawn();
  }

  /** 传送至指定出生点索引（spawn 下拉；与 Worker 双端同步）。 */
  teleportToSpawn(idx: number): void {
    this.predPhys?.teleport_to_spawn(idx);
  }

  /** 传送到任意坐标（自定义传送点；yaw 缺省 = 保持当前朝向）。 */
  teleportToPos(pos: number[], yawDeg?: number): void {
    const phys = this.predPhys;
    if (!phys) return;
    const cur = phys.state() as { yaw: number };
    phys.teleport_to(pos[0], pos[1], pos[2], yawDeg ?? cur.yaw);
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
    this.deathY = y;
    this.predPhys?.set_death_y(y);
  }

  /** 当前物理速度（HUD/计时挑战采样用）。 */
  getCurrentVel(): { x: number; y: number; z: number } {
    if (!this.predPhys) return { x: 0, y: 0, z: 0 };
    const st = this.predPhys.state() as { velX: number; velY: number; velZ: number };
    return { x: st.velX, y: st.velY, z: st.velZ };
  }

  // ── 权威帧校准四件套（阶段 2，公共化：实现收敛到 ts-shared AuthorityCalibrator）──

  /**
   * 权威帧到达（A2）处理 —— **只读权威，绝不反写**。
   *
   * Worker 是权威帧计算器（加载地图碰撞、独立固定步长模拟）；本方法仅记录
   * 权威帧（速度供外推校准、位置/角度供异常兜底）。
   *
   * **兜底方向（用户定调）**：渲染主线（144Hz 预测物理）精度高于权威
   * （64Hz + 消息延迟），大偏差时**以渲染主线为准反向同步权威**——
   * 同步内容 = 渲染主线帧那一刻的完整状态，同步瞬间清空主线程与权威侧
   * 未消费的鼠标/按键增量（onSyncRenderState 回调 → Worker；权威侧 resetInput）。
   * - 首次权威帧（或重载后）：仍以权威全状态作为渲染物理起点（无渲染历史）
   * - 触发条件（三条件 OR）：
   *   - 位置差 > 500 → **强制**同步（绝对异常，不看朝向）
   *   - 位置差 > 300 **且** 水平朝向一致（yaw 最小角差 ≤ 3° + 转动方向相同）→ 同步
   *   - 位置差 ≤ 300 但视角偏差 > 45° → 同步（位置接近但视角大幅分叉）
   * - 同步在途（syncInFlight）期间不重复触发，直到权威追平（dist < 300）
   */
  private correctFromAuthority(): void {
    this.calibrator.correctFromAuthority();
  }

  /** 逐帧速度校准（权威速度外推反馈；实现见 ts-shared AuthorityCalibrator）。 */
  private calibrateVelocity(now: number): void {
    this.calibrator.calibrateVelocity(now);
  }

  /**
   * 位置突变归零（显式重置允许覆盖：respawn/teleport/noclip 切换/检查点回退）。
   * 清空权威校准状态，防止旧权威帧把突变位置拉回。
   */
  resetTo(pos: number[], yawDeg: number, pitchDeg = 0): void {
    this.calibrator.resetTo(pos, yawDeg, pitchDeg);
  }

  /**
   * 权威碰撞事件 → 位置微调 + 角度同步（权威仅在碰撞判断时可影响渲染角度；
   * 实现见 ts-shared AuthorityCalibrator）。
   */
  applyCollisionCorrection(kind: 'land' | 'blocked', pos: number[], yawDeg: number, pitchDeg: number, vel?: number[]): void {
    this.calibrator.applyCollisionCorrection(kind, pos, yawDeg, pitchDeg, vel);
  }

  /** 消费 Rust 物理事件（每帧 tick 后）：teleport/death → onPhysEvent 回调
   * （app.ts 计时挑战状态机：检查点记录 / 死亡统计 + 检查点回退）。 */
  private consumePhysEvents(): void {
    if (!this.predPhys) return;
    for (;;) {
      const ev = this.predPhys.take_event() as RenderPhysEvent | null;
      if (!ev) break;
      this.onPhysEvent?.(ev);
    }
  }

  /** 当前物理全状态（自定义传送点保存位置 / HUD 采样用）。 */
  getCurrentState(): {
    pos: { x: number; y: number; z: number };
    yaw: number;
    pitch: number;
    vel: { x: number; y: number; z: number };
    onGround: boolean;
  } {
    if (!this.predPhys) return { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, vel: { x: 0, y: 0, z: 0 }, onGround: false };
    const st = this.predPhys.state() as {
      posX: number; posY: number; posZ: number;
      yaw: number; pitch: number;
      velX: number; velY: number; velZ: number;
      onGround: boolean;
    };
    return {
      pos: { x: st.posX, y: st.posY, z: st.posZ },
      yaw: st.yaw,
      pitch: st.pitch,
      vel: { x: st.velX, y: st.velY, z: st.velZ },
      onGround: st.onGround,
    };
  }

  /** 当前 PVS cluster（HUD cluster 显示用；无 PVS = -1）。 */
  getPvsCluster(): number {
    return this.pvsManager?.currentClusterId ?? -1;
  }

  // ── GLB 加载（SceneBuilder 主线程版）──────────────────────

  private readonly gltfLoader = new GLTFLoader();

  private async loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
    const buffer = new Uint8Array(glbBytes.byteLength);
    buffer.set(new Uint8Array(glbBytes));
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await this.gltfLoader.loadAsync(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  /** 重置 GLB 根节点旋转，统一坐标系（与 Worker 侧碰撞体一致）。 */
  private resetRootRotations(gltf: GLTF): void {
    for (const child of gltf.scene.children) {
      const r = child.rotation;
      if (r.x !== 0 || r.y !== 0 || r.z !== 0) {
        console.log(
          `[renderer-main] 重置根节点 "${child.name || '(unnamed)'}" 旋转: ` +
            `(${r.x.toFixed(3)}, ${r.y.toFixed(3)}, ${r.z.toFixed(3)}) → (0, 0, 0)`,
        );
        child.rotation.set(0, 0, 0);
        child.updateMatrixWorld();
      }
    }
    gltf.scene.updateMatrixWorld(true);
  }

  /** 遍历 mesh 存储 userData 元数据（材质/纹理分类，供调试/剔除）。 */
  private collectMetadata(scene: THREE.Scene): void {
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[];
      const firstMat = Array.isArray(mat) ? mat[0] : mat;
      if (!firstMat) return;
      const materialName = (firstMat.name ?? '').toLowerCase();
      const basicMat = firstMat as THREE.MeshBasicMaterial;
      const map = (basicMat as unknown as { map?: THREE.Texture | null }).map;
      const textureName = map?.name ? map.name.toLowerCase() : '';
      const combined = `${materialName} ${textureName}`;
      mesh.userData.vbsp = {
        isTools: combined.includes('tools/') || combined.includes('tools\\'),
        isNodraw: combined.includes('nodraw'),
        hasTexture: !!map,
        isWater: combined.includes('water'),
        isTrans: !!firstMat.transparent,
        isLightEmissive:
          combined.includes('light') ||
          combined.includes('emit') ||
          combined.includes('glow') ||
          combined.includes('sky'),
        textureName: map?.name ?? '',
        materialName: firstMat.name ?? '',
      };
    });
  }

  /** 回传剔除统计（主线程本地 LOD/PVS 数据）。 */
  private emitCullStats(): void {
    if (!this.onCullStats) return;
    if (this.lodManager.itemCount <= 0) return;
    const lodStats = this.lodManager.getStats();
    const pvsStats = this.pvsManager?.getStats();
    this.onCullStats({
      visible: lodStats.visible,
      total: lodStats.total,
      cullDist: lodStats.cullDistance,
      pvs: {
        cluster: pvsStats?.currentCluster ?? -1,
        visibleClusters: pvsStats?.visibleCount ?? 0,
        totalClusters: pvsStats?.totalClusters ?? 0,
        pvsHidden: lodStats.pvsHidden,
        near: lodStats.near,
        far: lodStats.far,
      },
    });
  }

  // 复用向量
  private readonly _fwdDir = new THREE.Vector3();
}

const DEG2RAD = Math.PI / 180;
