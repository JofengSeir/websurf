/**
 * 三端唯一的**渲染会话**：GLB 字节 → 可渲染场景 → 每帧绘制（T-650 收口，2026-10-23）。
 *
 * 为什么有这一层：`assembleScene` 只统一了 GLB→终扫的 7 步；`loadScene` 之后的接线仍是三份
 * （viewer `core/scene.ts`、game/debug `renderer-main.ts`）——环境/天空/相机/可见性/画质/预编译/
 * 每帧 draw 的注册顺序与更新频率各写一遍。后果不是编译错误，而是「改一处只有某个端看起来有效果」：
 * 2026-10-22 回退 VMT 表只装在 viewer 的 `bsp.ts`，debug/game 没装 ⇒ debug 水层 alpha=0 不绘制。
 *
 * 本模块把**所有端共用的渲染接线**收成一份（顺序即契约）：
 *
 *   ① `init`：`createRenderer` + `applyRenderPrefs` + 场景/相机 + 只读探针；
 *   ② `loadScene`：`assembleScene`（含主模型合并）→ 挂根/天空层 → 预编译 → 相机 near/far
 *      → 可见性收集与剔除距离 → 环境（背景/反射/雾）→ 贴图画质；
 *   ③ `frame`：可见性判定 → 近平面贴墙（隔帧）→ 起源两遍法天空/主世界绘制；
 *   ④ `disposeScene`：根/天空/环境/渲染列表释放。
 *
 * 三端只保留自己的**数据源**（viewer 本地 BSP / game/debug worker 或主线程 wasm）与
 * **特有功能**（debug 可视网格/排查开关、viewer 回放/浏览、game 物理/面板/HUD）。这些特有
 * 功能只能往 `session.scene` 里加自己的对象，**不得**再重写本文件的步骤。
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createRenderer, precompileScene } from '../render/create-renderer.js';
import { installRenderProbe } from '../render/render-probe.js';
import { assembleScene } from './assemble-scene.js';
import { mergeIntoNewRoot, mergeStatsOf, type MergeStats } from './scene-optimizer.js';
import { disposeObject } from './dispose.js';
import { resetWaterShaders } from '../shader/water.js';
import {
  clearSceneEnvironment,
  setSceneBackgroundColor,
  setSceneEnvironment,
} from '../environment/scene-environment.js';
import { renderSkyPass, type MapFogParams } from '../environment/render-sky-pass.js';
import { createSkyCamera, SKY_LAYER, type SkyCameraParams } from '../environment/miniature-sky.js';
import { VisibilityController, type VisibilityUpdateResult } from './visibility-controller.js';
import { applySceneCamera, shrinkNearPlane } from '../camera/scene-camera.js';
import { NearPlaneController } from '../camera/near-plane.js';
import {
  applySceneTextureQuality,
  type MosaicDeps,
  type TextureQualityResult,
} from './texture-quality.js';
import { applyRenderPrefs, readRenderPrefs } from '../config/render-prefs.js';
import { getLightingMode, setLightingMode as setLightingModeInShader, type LightingMode } from '../shader/lightmap-shader.js';
import { PvsManager } from '../../ts-shared/world/pvs-manager.js';
import type { PoseScope } from '../camera/pose-entry.js';

/** 三端标识（同时用于探针 `scope` 与日志前缀）。 */
export type RenderSessionApp = 'viewer' | 'debug' | 'game';

/** 会话构造参数：只保留「创建一次」的东西；每张图的数据走 `loadScene`。 */
export interface RenderSessionOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr?: number;
  app: RenderSessionApp;
  /** 无天空盒时的清屏回落色（三端默认 0x222222）。 */
  backgroundColor?: number;
  /** mosaic 解码依赖（各端自己的 wasm 产物）；不传则贴图画质切换空跑。 */
  mosaic?: MosaicDeps | null;
  /** 探针视口声明：debug 的画布在布局内，viewer/game 整窗。 */
  viewportSource?: 'layout-canvas' | 'full-window';
  /** 探针读画布的回调；缺省用构造时传入的 canvas。 */
  canvasProvider?: () => HTMLCanvasElement | null;
  /** 是否安装只读渲染探针（默认 true；自动化/单测可关）。 */
  probe?: boolean;
  /** 根对象的 `userData.isBspModel` 标记（game/debug 的旧释放路径按它识别；默认 true）。 */
  markBspModel?: boolean;
}

/** 一张图的全部渲染输入；数据来源由各端自己解析，形状统一在这里。 */
export interface RenderSceneInput {
  /** BSP 导出的 GLB 字节。 */
  glb: ArrayBuffer;
  /** PVS 载荷 JSON；缺省/空串时不做 PVS（天空区也不建）。 */
  pvsJson?: string | null;
  /** `sky_camera` 参数；无 3D 天空盒时 null。 */
  skyCamera?: SkyCameraParams | null;
  /** 地图线性雾（`env_fog_controller`）；null = 无雾。 */
  fogParams?: MapFogParams | null;
  /** 2D 天空盒立方体贴图（同时作背景与 `$envmap` 反射源）；null = 纯色回落。 */
  skyboxTexture?: THREE.CubeTexture | null;
  /** mosaic 清单（纹理名小写 → 字节码）；null = 本图无画质切换数据。 */
  mosaicManifest?: Record<string, string> | null;
  /** 载入后立即应用的画质档；缺省取本端呈现档 `textureQuality`。 */
  quality?: 'original' | 'mini';
  /** 半透明是否单独成块（debug 的 A/B 开关）；缺省 true。 */
  translucentSplit?: boolean;
  /** 是否做空间分块合并（debug 的 `OPTIMIZE_SCENE_ENABLED`）；缺省 true。 */
  merge?: boolean;
  /** 装配核在 lightmap 之前回调（debug 的 `collectMetadata` 用它）。 */
  onRootReady?: (root: THREE.Scene, gltf: GLTF) => void;
}

/** 一次场景装载的结果（三端共用；各端只取自己需要的字段）。 */
export interface RenderSceneResult {
  root: THREE.Object3D;
  skyGroup: THREE.Group | null;
  bbox: THREE.Box3;
  maxDim: number;
  /** lightmap 是否施加成功。 */
  applied: boolean;
  /** 终扫收敛的受光 mesh 数（主根 / 天空组）。 */
  converged: number;
  skyConverged: number;
  /** 场景对角线长度（主根；debug 的滑槽量程用它）。 */
  diagonal: number;
  /** 生效剔除距离（档值 0 时 = 自动值 `maxDim × 0.5`）。 */
  defaultCull: number;
  /** 剔除距离滑槽上限（`ceil(diagonal × 4 / 100) × 100`）。 */
  maxCull: number;
  /** 主模型合并统计（未合并 / 无输入时为 null）。 */
  merge: MergeStats | null;
}

/** `frame()` 的每帧开关（只在端特有路径上关，默认都开）。 */
export interface RenderFrameOptions {
  /** 本帧是否做距离/PVS 判定（默认 true）。 */
  updateVisibility?: boolean;
  /** 本帧是否做近平面贴墙探测（默认 true；debug 的 noclip 关掉）。 */
  updateNearPlane?: boolean;
}

/** 可见性统计（形状与 debug 的 `LodStats` 兼容）。 */
export interface RenderSessionStats {
  visible: number;
  total: number;
  near: number;
  far: number;
  pvsHidden: number;
  cullDistance: number;
  diagonal: number;
  maxCull: number;
}

/**
 * 三端唯一的渲染会话。
 *
 * 生命周期：`new`（建 renderer/scene/camera + 探针）→ `loadScene`（可多次换图）→
 * `frame`（每帧）→ `disposeScene`（换图/卸载）/ `dispose`（页面卸载）。
 */
export class RenderSession {
  readonly app: RenderSessionApp;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly nearPlane = new NearPlaneController();

  /** 可见性判定本体（距离优先、PVS 可选；天空层不参与）。 */
  private readonly visibility = new VisibilityController();
  /** 探针读的「上一帧判定结果」。 */
  private lastVisibility: VisibilityUpdateResult | null = null;
  /** PVS 查询器（`loadScene` 按 `pvsJson` 建；无 PVS 时 null）。 */
  private pvs: PvsManager | null = null;
  /** 主模型根（`mergeIntoNewRoot` 的产物；未合并时是 `assembleScene` 的 mapRoot）。 */
  private root: THREE.Object3D | null = null;
  /** 主根里的半透明块（每帧按相机距离重排 `renderOrder`，见 `sortTransparentChunks`）。 */
  private transparentChunks: THREE.Mesh[] = [];
  private readonly transparentSortPos = new THREE.Vector3();
  /** 天空层：第二相机 + 只挂 `SKY_LAYER` 的图元组。 */
  private skyCamera: THREE.PerspectiveCamera | null = null;
  private skyGroup: THREE.Group | null = null;
  private skyParams: SkyCameraParams | null = null;
  private skyFog: THREE.Fog | null = null;

  private bbox = new THREE.Box3();
  private maxDim = 0;
  private diagonal = 0;
  private maxCull = 0;

  private readonly backgroundColor: THREE.Color;
  private readonly mosaic: MosaicDeps | null;
  private mosaicManifest: Record<string, string> | null = null;
  private quality: 'original' | 'mini' = 'original';
  /** 切 mini 前的原图缓存（键 = 纹理对象；换图时清空）。 */
  private readonly origTextureImages = new Map<THREE.Texture, unknown>();

  private translucentSplit = true;
  private readonly markBspModel: boolean;
  private nearCheckToggle = false;

  constructor(opts: RenderSessionOptions) {
    this.app = opts.app;
    this.backgroundColor = new THREE.Color(opts.backgroundColor ?? 0x222222);
    this.mosaic = opts.mosaic ?? null;
    this.markBspModel = opts.markBspModel !== false;

    // 三端唯一渲染器构造点（上下文/输出链参数都在 create-renderer 里定死）
    this.renderer = createRenderer({
      canvas: opts.canvas,
      width: opts.width,
      height: opts.height,
      dpr: opts.dpr,
    });
    // 静态光照呈现参数：共享层唯一呈现档（含本端作用域）
    applyRenderPrefs(readRenderPrefs());

    this.scene = new THREE.Scene();
    setSceneBackgroundColor(this.scene, this.backgroundColor);

    const w = Math.max(opts.width, 1);
    const h = Math.max(opts.height, 1);
    this.camera = new THREE.PerspectiveCamera(readRenderPrefs().camera.fov, w / h, 0.1, 100000);
    this.camera.position.set(0, 0, 0);
    // 天空层只由第二相机渲染：主相机显式关掉 SKY_LAYER（三端同一个口径）
    this.camera.layers.disable(SKY_LAYER);

    if (opts.probe !== false) {
      installRenderProbe({
        scope: this.app as PoseScope,
        viewportSource: opts.viewportSource ?? (this.app === 'debug' ? 'layout-canvas' : 'full-window'),
        canvas: opts.canvasProvider ?? (() => opts.canvas),
        cull: () => ({
          distance: this.visibility.cullDistance,
          auto: this.visibility.autoCullDistance,
          configured: readRenderPrefs().culling.distance,
        }),
        pvs: () => ({
          enabled: this.visibility.enablePvs,
          pvsHidden: this.lastVisibility?.culledByPvs ?? 0,
          clusters: this.pvs?.getStats().visibleCount ?? 0,
        }),
        merge: () => mergeStatsOf(this.root),
        sky: () => ({ hasGroup: !!this.skyGroup, children: this.skyGroup?.children.length ?? 0 }),
      });
    }
  }

  /** 当前主模型根（供端特有功能挂射线/碰撞/拾取用；不要在这里改材质/可见性）。 */
  get rootObject(): THREE.Object3D | null {
    return this.root;
  }

  /** 当前天空组（没有 3D 天空盒时为 null）。 */
  get skyGroupObject(): THREE.Group | null {
    return this.skyGroup;
  }

  /** 当前 PVS（探针/端特有统计用）。 */
  get pvsManager(): PvsManager | null {
    return this.pvs;
  }

  /** 上一帧可见性判定结果（只读）。 */
  get visibilityResult(): VisibilityUpdateResult | null {
    return this.lastVisibility;
  }

  /** 是否有地图。 */
  hasModel(): boolean {
    return this.root !== null;
  }

  /** 当前主模型的世界包围盒（无图时为 null）。 */
  worldBox(): THREE.Box3 | null {
    if (!this.root) return null;
    return new THREE.Box3().setFromObject(this.root);
  }

  /** 相机 near/far/fov 按地图尺寸重算（共享口径；`loadScene` 末尾自动调一次）。 */
  fitCamera(maxDim: number = this.maxDim): void {
    applySceneCamera(this.camera, this.nearPlane, maxDim, readRenderPrefs().camera.fov);
  }

  /**
   * 装载一张图：三端唯一顺序（见文件头）。重复调用会先释放上一张图。
   *
   * @returns 主根/天空组/包围盒与合并、可见性统计；各端只取自己需要的字段。
   */
  async loadScene(input: RenderSceneInput): Promise<RenderSceneResult> {
    this.disposeScene();
    const rp = readRenderPrefs();
    this.pvs = input.pvsJson ? new PvsManager(input.pvsJson) : null;
    this.translucentSplit = input.translucentSplit !== false;

    const asm = await assembleScene({
      glb: input.glb,
      logPrefix: this.app,
      pvs: this.pvs,
      skyCamera: input.skyCamera ?? null,
      meshInCluster: (m, c) => this.meshInCluster(m, c),
      onRootReady: input.onRootReady,
      mergeMain: input.merge === false ? undefined : (root) => this.mergeMain(root),
    });

    this.root = asm.root;
    if (this.markBspModel) this.root.userData.isBspModel = true;
    this.bbox = asm.bbox;
    this.maxDim = asm.maxDim;
    this.scene.add(this.root);
    this.collectTransparentChunks();

    this.skyGroup = asm.skyGroup;
    this.skyParams = asm.skyGroup && input.skyCamera ? input.skyCamera : null;
    this.skyCamera = createSkyCamera();
    if (this.skyGroup) {
      this.scene.add(this.skyGroup);
      console.info(
        `[${this.app}][skybox] 3D 天空盒：天空区 ${this.skyGroup.children.length} 个图元挂第 ${SKY_LAYER} 层，由第二相机渲染`,
      );
    } else {
      console.info(`[${this.app}][skybox] 无可用 3D 天空盒（无 sky_camera 或天空区不可分离）⇒ 不加天空层`);
    }

    // 预编译必须在 scene.add(root) 之后：早于它编译的是空场景（game/debug 旧注释的同一约束）。
    precompileScene(this.renderer, this.scene, this.camera);

    // 相机 near/far/fov：共享口径（viewer 原 far 下限已取消，三端同一个 maxDim×100）
    applySceneCamera(this.camera, this.nearPlane, this.maxDim, rp.camera.fov);

    // 可见性：收集主根块 → 补 PVS cluster → 定剔除距离（天空层在收集阶段跳过）
    this.visibility.enablePvs = rp.culling.pvs;
    this.visibility.collect(this.root, this.pvs);
    const box = this.worldBox();
    const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3();
    this.diagonal = size.length();
    this.maxCull = Math.ceil((this.diagonal * 4) / 100) * 100;
    const defaultCull = this.visibility.setCullDistance(this.maxDim * 0.5, rp.culling.distance);

    // 环境：背景/反射源/雾逐字段登记（无天空盒时用纯色回落）
    setSceneEnvironment(this.scene, {
      background: input.skyboxTexture ?? this.backgroundColor.clone(),
      skyboxReflection: input.skyboxTexture ?? null,
      fog: input.fogParams ?? null,
    });

    // 贴图画质：manifest 就位后按当前档立即应用一次
    this.mosaicManifest = input.mosaicManifest ?? null;
    this.quality = input.quality ?? rp.textureQuality;
    if (this.mosaicManifest && this.mosaic) void this.applyTextureQuality(this.quality);

    return {
      root: this.root,
      skyGroup: this.skyGroup,
      bbox: this.bbox,
      maxDim: this.maxDim,
      applied: asm.applied,
      converged: asm.converged,
      skyConverged: asm.skyConverged,
      diagonal: this.diagonal,
      defaultCull,
      maxCull: this.maxCull,
      merge: mergeStatsOf(this.root),
    };
  }

  /** 换图/卸载：释放根、天空组、环境与渲染列表；renderer/scene/camera 本身复用。 */
  disposeScene(): void {
    if (this.root) {
      disposeObject(this.root);
      this.scene.remove(this.root);
      this.root = null;
    }
    if (this.skyGroup) {
      disposeObject(this.skyGroup);
      this.scene.remove(this.skyGroup);
      this.skyGroup = null;
    }
    resetWaterShaders();
    this.transparentChunks = [];
    clearSceneEnvironment(this.scene, { disposeBackground: true });
    this.renderer.renderLists.dispose();
    this.pvs = null;
    this.skyCamera = null;
    this.skyParams = null;
    this.skyFog = null;
    this.bbox.makeEmpty();
    this.maxDim = 0;
    this.diagonal = 0;
    this.maxCull = 0;
    this.mosaicManifest = null;
    this.origTextureImages.clear();
    this.visibility.clear();
    this.lastVisibility = null;
    this.nearCheckToggle = false;
  }

  /** 只做可见性判定（debug 的按需渲染需要在决定是否出帧前先知道有无变化）。 */
  updateVisibility(): VisibilityUpdateResult {
    // 档即开关：面板/深链改 `culling.pvs` 后下一帧生效
    this.visibility.enablePvs = readRenderPrefs().culling.pvs;
    this.lastVisibility = this.visibility.update(this.camera, this.pvs);
    return this.lastVisibility;
  }

  /**
   * 每帧绘制：可见性 → 近平面贴墙（隔帧）→ 起源两遍法（天空相机 + 主相机）。
   *
   * 调用方负责先把相机位姿写好（game/debug 从物理状态、viewer 从自由飞行）。
   */
  frame(opts: RenderFrameOptions = {}): VisibilityUpdateResult | null {
    if (opts.updateVisibility !== false) this.updateVisibility();
    this.nearCheckToggle = !this.nearCheckToggle;
    if (opts.updateNearPlane !== false && this.nearCheckToggle && this.root) {
      shrinkNearPlane(
        this.nearPlane,
        this.camera,
        this.scene,
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z,
        [this.root],
      );
    }
    this.sortTransparentChunks(this.camera);
    this.skyFog = renderSkyPass({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      skyCamera: this.skyCamera,
      skyGroup: this.skyGroup,
      skyParams: this.skyParams,
      skyFog: this.skyFog,
    });
    return this.lastVisibility;
  }

  /** 端特有动画/叠加层用：重画一帧但不重复可见性/近平面（只做天空+主世界 draw）。 */
  redraw(): void {
    this.frame({ updateVisibility: false, updateNearPlane: false });
  }

  /** 画布尺寸变化：renderer 尺寸 + 相机宽高比（高为 0 按 1 处理）。 */
  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /** 面板/配置改剔除距离（0 = 自动 `maxDim×0.5`）；返回生效值。 */
  setCullDistance(dist: number): number {
    return this.visibility.setCullDistance(this.visibility.autoCullDistance, dist);
  }

  /** 面板/配置改 FOV（度）：写相机并刷新投影矩阵。 */
  setFov(fov: number): void {
    if (!Number.isFinite(fov) || fov <= 0) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** 切换光照模式（共享 uniform；三端同一入口）。 */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[${this.app}][lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 读当前光照模式。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  /** 近平面探测参数（debug/game 面板的「探测距离 + 收缩系数」）。 */
  setNearParams(probeDist?: number, ratio?: number): void {
    this.nearPlane.setParams(probeDist, ratio);
  }

  /** 贴图画质切换（manifest 缺失时返回 null）；算法本体在 `texture-quality.ts`。 */
  async applyTextureQuality(quality: 'original' | 'mini'): Promise<TextureQualityResult | null> {
    this.quality = quality;
    if (!this.mosaicManifest || !this.root || !this.mosaic) return null;
    return applySceneTextureQuality({
      mainRoot: this.root,
      skyRoot: this.skyGroup,
      manifest: this.mosaicManifest,
      quality,
      origImages: this.origTextureImages,
      deps: this.mosaic,
    });
  }

  /** 当前画质档（探针/诊断）。 */
  get textureQuality(): 'original' | 'mini' {
    return this.quality;
  }

  /** 可见性统计（形状与 debug 的 `LodStats` 兼容）。 */
  stats(): RenderSessionStats {
    const r = this.lastVisibility;
    return {
      visible: r?.visible ?? this.visibility.items.length,
      total: this.visibility.items.length,
      near: r?.visible ?? this.visibility.items.length,
      far: r?.culledByDistance ?? 0,
      pvsHidden: r?.culledByPvs ?? 0,
      cullDistance: this.visibility.cullDistance,
      diagonal: this.diagonal,
      maxCull: this.maxCull,
    };
  }

  /** PVS 统计（`currentCluster` / `visibleCount` / `totalClusters`）；无 PVS 时全 0/-1。 */
  pvsStats(): { currentCluster: number; visibleCount: number; totalClusters: number } {
    const s = this.pvs?.getStats();
    return {
      currentCluster: s?.currentCluster ?? -1,
      visibleCount: s?.visibleCount ?? 0,
      totalClusters: s?.totalClusters ?? 0,
    };
  }

  /** 页面卸载：释放当前图 + renderer。 */
  dispose(): void {
    this.disposeScene();
    this.renderer.dispose();
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 收集主根里的半透明块。
   *
   * 为什么需要：合并后的块 `position` 都是 `(0,0,0)`，three 的半透明排序在
   * `groupOrder/renderOrder` 相同后按对象 z（这里全为 0）再按 id ⇒ **退化成创建顺序**。
   * surf_666 的模型容器里，玻璃块 id 比水面块小 ⇒ 玻璃先画、水后画；水的 alpha 随视角
   * 变化，就把玻璃“盖淡”甚至盖没（owner 2026-10-24 报的“玻璃板有时像消失”）。
   */
  private collectTransparentChunks(): void {
    this.transparentChunks = [];
    this.root?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!mats.some((m) => m && m.transparent === true)) return;
      if (mesh.userData.__vbspTransparentBaseOrder === undefined) {
        mesh.userData.__vbspTransparentBaseOrder = mesh.renderOrder;
      }
      this.transparentChunks.push(mesh);
    });
  }

  /**
   * 每帧把半透明块按相机距离**远→近**重排 `renderOrder`（three 升序绘制）。
   *
   * ⚠️ 必须按**组**排，不能逐块排：同一块玻璃板会被合并成多个重叠的 chunk，它们共享
   * 同一材质；逐块给不同 renderOrder 会让 chunk 重叠处的混合顺序随视角变化，出现
   * 1024 HU 的方格/某块突然变淡。水面同理按**水位**归组（同一层的水 chunk 一起画）。
   */
  private sortTransparentChunks(camera: THREE.Camera): void {
    const list = this.transparentChunks;
    if (list.length === 0) return;
    const p = this.transparentSortPos;
    const n = list.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      while (parent[i] !== i) {
        const next = parent[i];
        parent[i] = r;
        i = next;
      }
      return r;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const byMaterial = new Map<number, number>();
    const byWaterHeight = new Map<string, number>();
    const dists = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const mesh = list[i];
      const geom = mesh.geometry;
      if (!geom) continue;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const center = geom.boundingSphere?.center;
      if (!center) continue;
      p.copy(center).applyMatrix4(mesh.matrixWorld);
      dists[i] = p.distanceToSquared(camera.position);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const water = mats.find((m) => m && (m.userData as { vbsp_water?: unknown }).vbsp_water);
      if (water) {
        // 水面：同层（同世界 y）的水 chunk 一起画；不同层不能合并，否则层间排序错。
        const key = (center.y + mesh.position.y).toFixed(1);
        const prev = byWaterHeight.get(key);
        if (prev !== undefined) union(i, prev);
        else byWaterHeight.set(key, i);
        continue;
      }
      // 非水面（玻璃等）：**共享任一材质**的 chunk 归为同一组（并查集）。
      // 不能按材质 id 集合相等：同一块玻璃板的不同 chunk 可能一个带框材质、一个不带。
      for (const m of mats) {
        if (!m) continue;
        const prev = byMaterial.get(m.id);
        if (prev !== undefined) union(i, prev);
        else byMaterial.set(m.id, i);
      }
    }

    const groups = new Map<number, { dist: number; meshes: number[] }>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const g = groups.get(root);
      if (g) {
        g.meshes.push(i);
        if (dists[i] < g.dist) g.dist = dists[i];
      } else {
        groups.set(root, { dist: dists[i], meshes: [i] });
      }
    }
    const ordered = [...groups.values()].sort((a, b) => b.dist - a.dist);
    for (let i = 0; i < ordered.length; i++) {
      for (const idx of ordered[i].meshes) {
        const mesh = list[idx];
        const base = (mesh.userData.__vbspTransparentBaseOrder as number | undefined) ?? 0;
        mesh.renderOrder = base + i;
      }
    }
  }

  /** 主模型分块合并：三端唯一包装（新根口径；旧的 game/debug 原地挂回已废弃）。 */
  private mergeMain(root: THREE.Scene): THREE.Object3D {
    const optRoot = mergeIntoNewRoot(root, { translucentSplit: this.translucentSplit });
    const stats = mergeStatsOf(optRoot);
    if (stats) {
      console.log(
        `[optimizeScene] 分块合并: ${stats.meshes} mesh → ${stats.chunks} 块（${this.app}）` +
          ` | draw call 估算 ${stats.drawCallEst}`,
      );
    }
    return optRoot;
  }

  /** 判某个 mesh 是否落在指定 BSP cluster（包围盒中心 + 6 个 ±r 轴点；全仓唯一实现）。 */
  private meshInCluster(mesh: THREE.Mesh, cluster: number): boolean {
    if (!this.pvs) return false;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return false;
    const center = box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    if (this.pvs.getClusterAt(center) === cluster) return true;
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(1, Math.max(size.x, size.y, size.z) * 0.25);
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const sign of [1, -1]) {
        const probe = center.clone();
        probe[axis] += sign * r;
        if (this.pvs.getClusterAt(probe) === cluster) return true;
      }
    }
    return false;
  }
}
