/**
 * WebSurf — 主线程渲染器（渲染从 Worker 搬回主线程）
 * 每帧安全读取物理快照（锁占用→复用缓存，锁释放→读取+seq 校验）、
 * LERP 插值（渲染/物理帧率解耦）、相机同步 → LOD/PVS 剔除 → 雾/碰撞箱可视化/准星射线 → Draw Call。
 * 场景数据由 Worker 一次性传输（GLB + 碰撞体/PVS/出生点/传送点 JSON），
 * 本类承担 GLTFLoader 建场景及 LOD/PVS/雾/碰撞箱/准星/lightmap 等子管理器。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
// mosaic 画质切换：主线程懒初始化同一 wasm 模块（与 worker 实例互不影响）
import { ensureMainWasm, mosaic_decode } from '../main-wasm.js';
import type { RuntimeConfig } from '../config.js';
import type { FrameSnapshot, PlaneInfo, SceneDataMessage } from '../worker/worker-types.js';
import type { SharedState } from '../worker/shared-state.js';
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
const FOV = 75;
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
/**
 * 外推插帧上限（秒）：物理快照过期（alpha>1）时用速度一阶外推填充中间渲染帧。
 * 上限约一个物理固定步（1/64s）——覆盖 64Hz 物理与高刷渲染之间的空窗，
 * 同时防止物理真卡时外推跑飞穿墙。
 */
const EXTRAPOLATE_MAX_S = 1 / 64;
/**
 * 外推插帧最低速度（unit/s）：横向（x/z）与竖向（y）速度**均**低于此值时不外推。
 * 起步拉地速阶段运动不可预测（加速/转向/起跳），外推会产生误导性位移；
 * 高速滑行阶段运动方向稳定，外推才可靠。
 */
const EXTRAPOLATE_MIN_SPEED = 500;

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

  // ── LERP 插值状态 ─────────────────────────────────────────
  private prevSnap: FrameSnapshot | null = null;
  private curSnap: FrameSnapshot | null = null;
  private lastSeq = -1;

  // ── 近平面自适应（防穿墙：不移动相机，动态收缩 near）────────
  private readonly _nearRaycaster = new THREE.Raycaster();
  private readonly _nearOrigin = new THREE.Vector3();
  private readonly _nearDirF = new THREE.Vector3();
  private readonly _nearDirR = new THREE.Vector3();
  private readonly _nearDirU = new THREE.Vector3();
  private readonly _nearSphere = new THREE.Sphere();
  private nearCheckToggle = false;
  /** 场景默认 near（maxDim/1000 下限 NEAR_MIN）。 */
  private defaultNear = CAMERA_NEAR_MIN;

  /** 剔除统计回调（主线程更新 UI）。 */
  onCullStats: ((stats: CullStatsLike) => void) | null = null;
  /** 场景加载完成回调（携带死亡阈值 Y 下限，主线程回传 Worker）。 */
  onSceneLoaded: ((deathThresholdY: number) => void) | null = null;

  // ── 纹理画质切换（mosaic）──────────────────────────────────
  /** 画质 manifest：{ 纹理名(小写 basetexture): mosaic 字节码 }。 */
  private mosaicManifest: Record<string, string> | null = null;
  /** 原始贴图图像缓存（切换回 original 时恢复）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  constructor(
    private readonly shared: SharedState,
  ) {
    // config 在 init() 中赋值
  }

  // ── 生命周期 ───────────────────────────────────────────────

  /** 初始化渲染器/场景/相机与子管理器。 */
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

    // 4. 插值缓存重置（避免跨地图 LERP 瞬移）+ 强制下一帧重绘
    this.resetInterpolation();
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

  /** 加载 Worker 传来的场景数据（GLB + PVS + 碰撞体 + 传送点）。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.scene || !this.camera) return null;

    // 0. 防御：加载前先卸载旧地图资源（正常流程 handleBspFile 已调用）
    this.disposeScene();

    // 1. GLB → Scene（SceneBuilder 逻辑主线程版）
    const gltf = await this.loadGlb(data.glb);
    const scene = new THREE.Scene();
    gltf.scene.userData.isBspModel = true;
    this.resetRootRotations(gltf);
    scene.add(gltf.scene);
    this.collectMetadata(scene);
    const atlasTexture = await loadLightmapAtlas(gltf.parser, gltf);
    if (atlasTexture) {
      applyLightmapToMeshes(scene, atlasTexture);
    }
    scene.updateMatrixWorld(true);
    const boundingBox = new THREE.Box3().setFromObject(scene);
    const size = boundingBox.getSize(new THREE.Vector3());
    const diagonal = size.length();

    // 2. 移除旧模型（保留灯光）
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const child = this.scene.children[i];
      if (child.userData?.isBspModel) {
        this.scene.remove(child);
      }
    }
    scene.userData.isBspModel = true;
    this.bspModelScene = scene;
    this.scene.add(scene);

    // 3. 相机 near/far（near 自适应：默认 maxDim/1000，贴墙由 updateNearPlane 收缩防穿墙）
    const maxDim = Math.max(size.x, size.y, size.z);
    this.defaultNear = Math.max(maxDim / 1000, CAMERA_NEAR_MIN);
    this.camera.near = this.defaultNear;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();

    // 4. LOD 注册 + PVS cluster 分配
    const diagInfo = this.lodManager.setup(scene, this.config);
    this.pvsManager = new PvsManager(data.pvsJson);
    this.lodManager.assignClusterIds(this.pvsManager);

    // 5. 传送触发器（可视化 + 准星检测）
    this.teleportManager = new TeleportManager(data.teleportJson);
    this.triggers = [...this.teleportManager.getTriggers()];
    this.colliderDebug.setTriggers(this.triggers);

    // 5.5 模型「可视网格」三角形碰撞（零转化；调试可视化 + 准星检测）
    if (data.triJson) {
      this.colliderDebug.setTriMeshes(JSON.parse(data.triJson));
    }

    // 5.6 纹理画质 manifest（mosaic 切换数据源）+ 按当前画质应用
    // （缺失纹理回退已在 GLB 导出期完成——默认纹理包低清直接嵌入 GLB，渲染端零后期处理）
    this.mosaicManifest = data.mosaicManifest ? (JSON.parse(data.mosaicManifest) as Record<string, string>) : null;
    void this.applyTextureQuality(this.config.texture.quality);

    // 6. 碰撞体（可视化 + 准星检测）
    const adaptResult = adaptBrushes(data.brushJson);
    this.colliders = [...adaptResult.solids, ...adaptResult.ladders];
    this.solids = adaptResult.solids;
    this.ladders = adaptResult.ladders;

    // 7. 雾初始化（基于场景半径）
    const center = boundingBox.getCenter(new THREE.Vector3());
    const radius = diagonal / 2;
    this.fogManager.init(this.scene, radius, center);
    this.fogManager.setColor(this.config.lighting.bgColor);

    // 8. 同步 LOD 配置（scene-data 中 maxCull/diagonal 为占位，此处校准）
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

  // ── 渲染循环（阶段三）──────────────────────────────────────

  private readonly boundTick = this.tick.bind(this);

  private tick(now: number): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.boundTick);
    if (!this.renderer || !this.scene || !this.camera || !this.cameraController) return;

    // 1. 安全检查：读取物理快照（锁占用 → 复用上一帧缓存）
    const snap = this.shared.readFrame();
    if (snap && snap.seq !== this.lastSeq) {
      this.prevSnap = this.curSnap;
      this.curSnap = snap;
      this.lastSeq = snap.seq;
    }

    // 2. LERP 时间插值 + 相机同步
    // 相机位置 = 眼睛（origin + eyeHeight），不做位置修正——防穿墙靠近平面自适应
    if (this.curSnap) {
      const render = this.interpolate(now);
      const cc = this.cameraController;
      cc.setYawPitch(render.yaw * DEG2RAD, render.pitch * DEG2RAD, false);
      cc.update();
      const camX = render.pos.x;
      const camY = render.pos.y + render.eyeHeight;
      const camZ = render.pos.z;
      cc.setPosition(camX, camY, camZ);

      // 近平面自适应（每 2 帧）：NEAR_PROBE_DIST 内有几何则 near 收缩到最近距离 80%，
      // 否则恢复默认；只改投影矩阵，相机位置/视角零影响。
      this.nearCheckToggle = !this.nearCheckToggle;
      if (this.nearCheckToggle && render.mode === 'physics' && this.bspModelScene) {
        this.updateNearPlane(camX, camY, camZ);
      }
    }

    const camPos = this.camera.position;

    // 3. LOD/PVS 剔除
    if (this.lodManager.itemCount > 0) {
      if (this.lodManager.update(camPos, this.config, this.pvsManager)) {
        this.needsRender = true;
      }
    }

    // 4. 雾
    this.fogManager.update(camPos, this.fogManager.currentSceneRadius);

    // 5. 碰撞箱可视化
    if (this.colliderDebug.hasDebugWork) {
      if (this.colliderDebug.update(camPos, this.colliders, this.config)) {
        this.needsRender = true;
      }
    }

    // 6. 准星射线检测（限流）
    if (this.planeInfoEnabled) {
      this.planeInspectCounter++;
      if (this.planeInspectCounter >= PLANE_INSPECT_INTERVAL) {
        this.planeInspectCounter = 0;
        this.inspectPlane();
      }
    } else if (this.lastPlaneInfo !== null) {
      this.lastPlaneInfo = null;
    }

    // 7. 渲染：快照就绪后每帧无条件渲染（帧率跟随 rAF，不降频/限流）。
    //    LERP 负责物理帧与渲染帧解耦，渲染帧率更高时中间帧饱和显示最新位置。
    //    needsRender 仅用于强制刷新（加载场景、LOD 变化等）。
    const shouldRender = this.curSnap !== null || this.needsRender;
    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }

    // 8. 周期剔除统计（主线程本地计算）
    if (now - this.lastStatsAt > 100) {
      this.lastStatsAt = now;
      this.emitCullStats();
    }
  }

  private lastStatsAt = 0;

  /**
   * LERP 插值 + 外推插帧（物理面与渲染面解耦的核心）。
   *
   * 物理 64Hz 固定步但快照随渲染频率写入，存在"空快照"（位置不变、时间
   * 前进）窗口；且 Worker 写帧/消息传递有延迟抖动。两因素叠加导致
   * alpha 间歇性 >1 —— 旧实现 clamp 到 1 停等，画面"停-动-停"微卡顿。
   *
   * 修复：alpha > 1 时用快照真实速度一阶外推（dead-reckoning），中间渲染
   * 帧保持连续运动；外推上限 EXTRAPOLATE_MAX_S（约一物理步），物理新快照
   * 到达后 LERP 自然接管。yaw/pitch 由输入驱动、外推无意义，保持 cur。
   */
  private interpolate(now: number): FrameSnapshot {
    const cur = this.curSnap!;
    const prev = this.prevSnap;
    if (!prev || cur.timeMs <= prev.timeMs) return cur;
    // alpha = (渲染时刻 - 旧帧时间) / (新帧时间 - 旧帧时间)；>1 = 物理帧过期
    const alpha = (now - prev.timeMs) / (cur.timeMs - prev.timeMs);

    if (alpha > 1) {
      // 低速门限：横向(xz)与竖向(y)速度**均** < 500 时不外推——起步拉地速
      // 阶段运动不可预测（加速/转向/起跳），外推会产生误导性位移；
      // 退回最新物理快照位置停等（等价旧实现 clamp 到 1）。
      // 任一方 ≥ 500（坡上高速滑行等方向稳定阶段）时启用一阶外推。
      const speedXZ = Math.hypot(cur.vel.x, cur.vel.z);
      const speedY = Math.abs(cur.vel.y);
      if (speedXZ < EXTRAPOLATE_MIN_SPEED && speedY < EXTRAPOLATE_MIN_SPEED) {
        return cur;
      }
      // 外推插帧：超过最新物理快照的部分按速度积分（钳制上限防穿墙跑飞）
      const extSec = Math.min((now - cur.timeMs) / 1000, EXTRAPOLATE_MAX_S);
      return {
        pos: {
          x: cur.pos.x + cur.vel.x * extSec,
          y: cur.pos.y + cur.vel.y * extSec,
          z: cur.pos.z + cur.vel.z * extSec,
        },
        yaw: cur.yaw,
        pitch: cur.pitch,
        vel: { ...cur.vel },
        onGround: cur.onGround,
        mode: cur.mode,
        eyeHeight: cur.eyeHeight,
        timeMs: now,
        seq: cur.seq,
      };
    }

    return {
      pos: {
        x: lerp(prev.pos.x, cur.pos.x, alpha),
        y: lerp(prev.pos.y, cur.pos.y, alpha),
        z: lerp(prev.pos.z, cur.pos.z, alpha),
      },
      yaw: lerp(prev.yaw, cur.yaw, alpha),
      pitch: lerp(prev.pitch, cur.pitch, alpha),
      vel: { ...cur.vel },
      onGround: cur.onGround,
      mode: cur.mode,
      eyeHeight: lerp(prev.eyeHeight, cur.eyeHeight, alpha),
      timeMs: now,
      seq: cur.seq,
    };
  }

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
   * 近平面自适应：检测相机 6 方向（相机局部系）NEAR_PROBE_DIST 内最近的 mesh，动态设置 camera.near。
   * - 贴墙 → near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)，墙面不被裁剪（相机不动，仅改投影）
   * - 空旷 → 恢复场景默认
   * 性能：包围球粗筛候选后做 6 方向 raycaster，每 2 帧一次。
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

    let minD = Infinity;
    if (candidates.length > 0) {
      // 2. 相机局部基向量（YXZ euler 四元数）+ 6 方向（4 水平正交 + 上下）：
      //    用户定调 2026-08-08——距离 90 下方向数收益递减，4 水平正交 + 上下
      //    覆盖绝大多数贴墙角度（斜贴 <10.2° 掠射才漏检）；上下保坡面/地面
      const q = camera.quaternion;
      this._nearDirF.set(0, 0, -1).applyQuaternion(q);
      const right = this._nearDirR.set(1, 0, 0).applyQuaternion(q);
      const up = this._nearDirU.set(0, 1, 0).applyQuaternion(q);
      const dirs = [
        this._nearDirF,
        this._nearDirF.clone().negate(),
        right.clone(),
        right.clone().negate(),
        up.clone(),
        up.clone().negate(),
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
    // 强制下一帧重算 near（当前值可能已不匹配新参数）
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
  private async applyTextureQuality(quality: 'original' | 'mini'): Promise<void> {
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
      // mini：按贴图名（basetexture 小写）查 manifest
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
   * 纹理不符会 GL_INVALID_VALUE 越界、上传失败（纹理保持旧内容 = "没应用"）。
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

  /** 清除插值缓存（传送/重生/模式切换后调用，避免跨状态插值）。 */
  resetInterpolation(): void {
    this.prevSnap = null;
    this.curSnap = null;
    this.lastSeq = -1;
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

/** 线性插值。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 度 → 弧度。 */
const DEG2RAD = Math.PI / 180;
