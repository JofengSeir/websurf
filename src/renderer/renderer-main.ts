/**
 * WebSurf — 主线程渲染器（渲染从 Worker 搬回主线程）
 *
 * 对应重构时序图阶段三（安全检查与视觉渲染）：
 * - 每帧安全读取物理快照：锁占用（Worker 写中）→ 复用上一帧缓存；
 *   锁释放 → 读取 + seq 版本校验
 * - LERP 时间插值：prev/cur 双快照按渲染时刻插值（渲染帧率与物理帧率解耦）
 * - 相机同步 → LOD/PVS 剔除 → 雾/碰撞箱可视化/准星射线 → Draw Call
 *
 * 场景数据由 Worker 一次性传输（GLB 字节 + 碰撞体/PVS/出生点/传送点 JSON），
 * 本类承担：GLTFLoader 建场景、PvsManager/LodManager/FogManager/ColliderDebug/
 * PlaneInspector/TeleportManager（可视化与准星检测）、lightmap 注入。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
/** 近裁剪面下限（HU）：近平面自适应的下限。
 * 贴墙时动态收缩到最近几何距离的 80%（不低于此值）→ 墙面不被近平面裁掉 → 不穿墙。
 * 相机位置完全不动（只改投影矩阵）。 */
const CAMERA_NEAR_MIN = 0.05;
/** 近距几何检测半径（HU）：检测相机周围 N 内是否有渲染几何（贴脸判定）。 */
const NEAR_PROBE_DIST = 4;

/** 剔除统计回调（与旧 CullStatsMessage 同构，主线程直接更新 UI）。 */
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

/**
 * 主线程渲染器。
 */
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

  private config: RuntimeConfig = null as unknown as RuntimeConfig;
  private needsRender = true;
  private rafId = 0;
  private running = false;

  // ── LERP 插值状态（阶段三步骤 11）─────────────────────────
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

  /** 加载 Worker 传来的场景数据（GLB + PVS + 碰撞体 + 传送点）。 */
  async loadScene(data: SceneDataMessage): Promise<{ diagonal: number; defaultCull: number; maxCull: number } | null> {
    if (!this.scene || !this.camera) return null;

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

    // 3. 相机 near/far（near 自适应：默认 = maxDim/1000 下限 CAMERA_NEAR_MIN，
    //    贴墙时由 updateNearPlane 动态收缩，防近平面裁剪穿墙）
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

    // 8. 同步当前 LOD 配置（scene-data 中 maxCull/diagonal 由 Worker 占位，此处校准）
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
    // 2. LERP 时间插值 + 相机同步
    // 相机位置 = 眼睛（origin + eyeHeight），【完全不做位置修正】——
    // 防穿墙靠"近平面自适应"：贴墙时动态收缩 near，墙面不被近平面裁掉。
    if (this.curSnap) {
      const render = this.interpolate(now);
      const cc = this.cameraController;
      cc.setYawPitch(render.yaw * DEG2RAD, render.pitch * DEG2RAD, false);
      cc.update();
      const camX = render.pos.x;
      const camY = render.pos.y + render.eyeHeight;
      const camZ = render.pos.z;
      cc.setPosition(camX, camY, camZ);

      // 近平面自适应（每 2 帧）：相机周围 NEAR_PROBE_DIST 内若有渲染几何，
      // near 收缩到最近距离的 80%（下限 CAMERA_NEAR_MIN）；否则恢复场景默认。
      // 只改投影矩阵，相机位置/视角零影响。
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

    // 7. 渲染：物理快照就绪后每帧无条件渲染 —— 渲染帧率跟随 rAF
    //    （浏览器 vsync 提供的最高帧率：60/120/144/240Hz，取决于显示器），
    //    不做任何人为降频/限流。LERP 插值负责物理帧（默认 64Hz）与渲染帧解耦：
    //    渲染帧率高于物理帧率时中间帧饱和显示最新物理位置。
    //    needsRender 仅用于初始/强制刷新（加载场景、LOD 变化等）。
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

  /** LERP：在 prev/cur 双快照间按渲染时刻插值。 */
  private interpolate(now: number): FrameSnapshot {
    const cur = this.curSnap!;
    const prev = this.prevSnap;
    if (!prev || cur.timeMs <= prev.timeMs) return cur;
    // alpha = (渲染时刻 - 旧帧时间) / (新帧时间 - 旧帧时间) ∈ [0,1]
    const alpha = THREE.MathUtils.clamp(
      (now - prev.timeMs) / (cur.timeMs - prev.timeMs),
      0,
      1,
    );
    return {
      pos: {
        x: lerp(prev.pos.x, cur.pos.x, alpha),
        y: lerp(prev.pos.y, cur.pos.y, alpha),
        z: lerp(prev.pos.z, cur.pos.z, alpha),
      },
      yaw: lerp(prev.yaw, cur.yaw, alpha),
      pitch: lerp(prev.pitch, cur.pitch, alpha),
      vel: { x: 0, y: 0, z: 0 },
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
   * 近平面自适应：检测相机 6 方向（前/后/左/右/上/下，相机局部系）
   * NEAR_PROBE_DIST 内最近的渲染 mesh 距离，动态设置 camera.near。
   *
   * - 贴墙/贴坡（近距几何存在）→ near = max(最近距离 × 0.8, CAMERA_NEAR_MIN)
   *   —— 墙面落在近平面之外 → 不被裁剪 → 不穿墙（相机位置完全不动，仅改投影）。
   * - 周围空旷 → near 恢复场景默认（maxDim/1000 下限 CAMERA_NEAR_MIN）。
   *
   * 性能：包围球粗筛（只收集距相机 < 2×NEAR_PROBE_DIST + 半径 的 mesh）→
   * 仅对候选做 6 方向 raycaster（far = NEAR_PROBE_DIST）。每 2 帧一次。
   */
  private updateNearPlane(px: number, py: number, pz: number): void {
    const camera = this.camera;
    const scene = this.bspModelScene;
    if (!camera || !scene) return;
    this._nearOrigin.set(px, py, pz);
    const probe = NEAR_PROBE_DIST;

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
      // 2. 相机局部基向量（YXZ euler 四元数）
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
        ? Math.max(minD * 0.8, CAMERA_NEAR_MIN)
        : this.defaultNear;
    if (Math.abs(camera.near - target) > 0.001) {
      camera.near = target;
      camera.updateProjectionMatrix();
    }
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
    }
  }

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
