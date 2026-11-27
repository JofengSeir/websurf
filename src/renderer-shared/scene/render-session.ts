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
import { detectDxtCapabilities, type VbspDxtStats } from './dxt-texture.js';
import { mergeStatsOf, type MergeStats } from './scene-optimizer.js';
import { disposeObject } from './dispose.js';
import { resetWaterShaders, renderWaterFramePasses } from '../shader/water.js';
import {
  clearSceneEnvironment,
  setSceneBackgroundColor,
  setSceneEnvironment,
} from '../environment/scene-environment.js';
import { renderSkyPass, type MapFogParams } from '../environment/render-sky-pass.js';
import { BloomPostFx, DEFAULT_BLOOM_PARAMS, buildDepthProxy, markGlowMeshes, type BloomParams } from '../environment/post-fx.js';
import { createSkyCamera, SKY_LAYER, type SkyCameraParams } from '../environment/miniature-sky.js';
import {
  CULL_DISTANCE_PVS_DEFAULT,
  VisibilityController,
  type VisibilityUpdateResult,
} from './visibility-controller.js';
import { PvsRegionOverlay } from './pvs-region-overlay.js';
import { applyClusterIndex, prepareClusterIndex, restoreClusterIndex, type ClusterIndexStats } from './cluster-filter.js';
import { applySceneCamera, shrinkNearPlane } from '../camera/scene-camera.js';
import { NearPlaneController } from '../camera/near-plane.js';
import {
  applySceneTextureQuality,
  type MosaicDeps,
  type TextureQualityResult,
} from './texture-quality.js';
import { applyRenderPrefs, readRenderPrefs } from '../config/render-prefs.js';

/**
 * 渲染代码版本标记：`__vbspCulling.state().rev` 会带出来。
 * 构建期由 `build-app.mjs` / `dist-pack.mjs` 自动注入 `__WEBSURF_BUILD_REV__`
 * （基于 git 提交与工作树指纹），未注入时回退 `'dev'`。
 */
declare const __WEBSURF_BUILD_REV__: string | undefined;
export const RENDER_REV: string =
  typeof __WEBSURF_BUILD_REV__ === 'string' && __WEBSURF_BUILD_REV__.length > 0
    ? __WEBSURF_BUILD_REV__
    : 'dev';

import {
	getLightingMode,
	setLightingMode as setLightingModeInShader,
	setVhvLinear as setVhvLinearInShader,
	getVhvLinear,
	type LightingMode,
} from '../shader/lightmap-shader.js';
import { PvsManager } from '../../ts-shared/world/pvs-manager.js';
import { collectTextureScrolls, updateTextureScrolls, type TextureScrollEntry } from '../shader/texture-scroll.js';
import { setupRotButtons, updateRotButtons, type RotButtonPivot } from './rot-buttons.js';
import {
  collectDynamicEntityGroups,
  markDynamicEntities,
  parseDynamicEntityIndices,
} from './dynamic-entities.js';
import { createRenderFrameContext, mirrorFrameContext, type RenderFrameContext } from './render-context.js';
import { TransparentSorter } from './transparent-sorter.js';
import { SpotLightSelector } from './spot-light-selector.js';
import type { SpotBeamRig } from './spot-beams.js';
import { DynamicAmbientTracker } from './dynamic-ambient.js';
import { mergeMainRoots } from './merge-main.js';
import { FrameBudgetController } from './frame-budget.js';
import { runPrewarmPasses } from './prewarm.js';
import { resetWorldTransitionTextures } from '../shader/world-transition.js';
import { resetBumpTextures } from '../shader/bumpmap.js';
import { collectLaserBeams, LaserBeams } from './lasers.js';
import { collectParticleEntities, parseEntityIoBlocks, ParticleSystems, type EntityBlockRecords } from './particles.js';
import {
  emptyEntityExtrasStats,
  EntityExtras,
  type EntityExtrasStats,
} from './entity-extras/index.js';
import type { PoseScope } from '../camera/pose-entry.js';
import {
  auditChunks,
  auditFrustum,
  chunkClusterSample,
  drawnChunkStats,
  leakChunks,
  pickChunkAt,
  probeChunkByName,
  pvsSnapshot,
  rayCheckChunk,
  type ChunkDiagnosticsHost,
} from './chunk-diagnostics.js';

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
  /**
   * 实体 lump 原文（`export_entity_io()` 的 `entities_text`）：`env_laser` 光束与 Source
   * 粒子（PCF）等「实体副产物」图元的数据源，由本会话统一装配（三端同一份）。
   * 缺省/空串 = 本图没有实体数据，跳过这两类图元（与旧行为一致）。
   */
  entityIoJson?: string | null;
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
  /** 渲染代码版本（见 `RENDER_REV`）：HUD/控制台都能直接看到，用来识别「浏览器还在跑旧包」。 */
  rev: string;
  /** 可见块「凭什么被画」的分项计数：`pvs` = PVS 判可见、`distance` = 只有距离档（PVS 关）。 */
  reasons: { pvs: number; distance: number };
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
  /** PVS 区域着色（debug 诊断）：按 cluster 给块上色。 */
  private readonly pvsOverlay = new PvsRegionOverlay();
  /** 诊断覆盖：`__vbspCulling.pvs()` 设的值优先于 prefs（null = 跟随 prefs）。 */
  private pvsOverride: boolean | null = null;
  /** 上一帧「PVS 是开还是关」，用来在开关变化时重算自动距离档（`null` = 还没算过）。 */
  private pvsAutoCull: boolean | null = null;
  /** 探针读的「上一帧判定结果」。 */
  private lastVisibility: VisibilityUpdateResult | null = null;
  /** PVS 查询器（`loadScene` 按 `pvsJson` 建；无 PVS 时 null）。 */
  private pvs: PvsManager | null = null;
  /** 装载期按 cluster 拆分合并块的统计（`state().split` 可读）。 */
  private clusterIndex: ClusterIndexStats | null = null;
  /** 逐三角形 index 当前是否处于「按房间裁过」的状态（关 PVS 时要还原）。 */
  private pvsIndexActive = false;
  /** 高速擦过固体 leaf 接缝的去抖计数（≥2 帧才触发全量 restoreClusterIndex）。 */
  private solidSeamFrames = 0;
  /** debug 在 frame() 外单独调用 updateVisibility() 时的耗时（ms），用于填充 __vbspFrameLog.vis。 */
  private lastVisMs = 0;
  /** 主模型根（`mergeIntoNewRoot` 的产物；未合并时是 `assembleScene` 的 mapRoot）。 */
  private root: THREE.Object3D | null = null;
  /** 声明了 Source `TextureScroll` 的共享贴图（装配后收集一次，见 `frame()`）。 */
  private textureScrolls: TextureScrollEntry[] = [];
  /** 上一帧时间戳（毫秒）：给 `TextureScroll` 算 `dt`。 */
  private lastFrameAt = 0;
  /** `momentary_rot_button` 实体（符文盘等）的 pivot；空 = 本图没有旋转实体。 */
  private rotButtons: RotButtonPivot[] = [];
  /** 动态实体组（`dynamic-entities.ts` 收集）；`__vbspDynamicEntityGroups === false` 时恒为空 Map。 */
  private dynGroups: Map<number, THREE.Group> = new Map();
  /** 本图待脱静态合并的实体下标；`loadScene` 按开关决定，关闭时为 null（零执行路径）。 */
  private pendingDynamicEntityIndices: ReadonlySet<number> | null = null;
  /** 主根里的半透明块（每帧按相机距离重排 `renderOrder`，见 `TransparentSorter`）。 */
  private readonly sorter = new TransparentSorter();
  /** 天空层：第二相机 + 只挂 `SKY_LAYER` 的图元组。 */
  private skyCamera: THREE.PerspectiveCamera | null = null;
  private skyGroup: THREE.Group | null = null;
  /** spot 光源的可见光柱（`point_spotlight`）；null = 本图没有 spot。 */
  private spotBeams: THREE.Group | null = null;
  /** 每帧 Top-8 spot / Top-2 dlight 筛选（见 `SpotLightSelector`，零分配）。 */
  private readonly spots = new SpotLightSelector();
  /** 动态实体实时光照：节流重采 BSP leaf ambientCube + 平滑插值。 */
  private readonly dynamicAmbient = new DynamicAmbientTracker();
  /**
   * 场景扩展图元：`env_laser` 光束、PCF 粒子系统，以及「有数据、零消费者」的地图资产实体
   * （`env_sprite` / `env_sprite_clientside`、`point_worldtext`、`move_rope`+`keyframe_rope`、
   * `env_beam`）。它们不是 GLB 的一部分，而是实体 lump 的副产物
   * （`lasers.ts` / `particles.ts` / `entity-extras/`）。三端都在 `loadScene` 里装配这一份，
   * 避免「只在 debug 装」再次造成端间画面不一致。
   */
  private laserBeams: LaserBeams | null = null;
  private particleSystems: ParticleSystems | null = null;
  private entityExtras: EntityExtras | null = null;
  /**
   * 物理线扫掠（`debug_line_trace` 包装）：物理世界就绪后由宿主调 `setLaserPhysicsTrace`
   * 重截断光束——只认实体 brush，触发体/nodraw/水面被忽略（渲染网格 Raycaster 会误截）。
   */
  private laserPhysTrace: ((start: THREE.Vector3, end: THREE.Vector3) => number) | null = null;
  private skyParams: SkyCameraParams | null = null;
  private skyFog: THREE.Fog | null = null;
  /**
   * 屏幕泛光（HDR 亮部软晕）。起源的「光效看起来更亮」大半来自 bloom：我们把场景画进
   * 半浮点缓冲再提取亮部做两级模糊，最后合成回画布（见 `environment/post-fx.ts`）。
   * 懒建于首帧（要等 renderer 尺寸确定）；`setBloom` 可运行期开关。
   */
  private bloomFx: BloomPostFx | null = null;
  /** 上一次标记到 `GLOW_LAYER` 的加色光效 mesh 数（变化时打日志，便于核对）。 */
  private glowMarked = 0;
  /** 场景结构变更或子节点数变化时才重新扫描 `GLOW_LAYER`，避免每帧全树遍历。 */
  private glowDirty = true;
  private glowSceneChildCount = -1;
  /** 上一帧标进泛光层的加色 mesh（供 `renderGlow` 的深度预渲跳过它们）。 */
  private readonly glowMeshes: THREE.Object3D[] = [];
  /**
   * bloom 光效层的**静态深度代理**：建图后把实体几何合并成一张网格（1 次 draw），
   * 替代每帧「整场景只写深度」的 400+ 次 draw。null = 退回旧的整场景预渲。
   */
  private glowDepthProxy: THREE.Mesh | null = null;
  /**
   * 帧预算控制器（task-33 C1）：0=不降级，1=bloom 光晕降频，2=再叠加镜面降频。
   * 采样窗口 / 恢复判据 / 档位决策全在 `frame-budget.ts`（T-P2-2c 搬出，逻辑零改动）；
   * 等级经 `frameCtx` 显式下传（T-P2-1），末梢镜像到 `globalThis.__vbspBudgetLevel` /
   * `__vbspDebug` 供外部诊断读取（只写）。
   */
  private readonly budget = new FrameBudgetController();
  /**
   * 帧运行期上下文（T-P2-1）：预算等级 / 上一帧 dt / 水面强制 pass 的显式载体。
   * 构造后传给 `renderWaterFramePasses(..., this.frameCtx)` 与 `BloomPostFx.setFrameContext`；
   * 每帧末 `mirrorFrameContext` 只写镜像，生产逻辑不再从 globalThis 读回。
   */
  private readonly frameCtx: RenderFrameContext = createRenderFrameContext();
  /**
   * 后台/前台切换的软重置（审查 P1-4）：只清采样窗口/稳定计数，**保留档位与粘滞**。
   * 隐藏期间不采样由 `FrameBudgetController.update()` 的 `document.hidden` 守卫兜底；
   * 切回后的第一帧间隔跨越整个隐藏期（可达秒级），必须丢弃，否则一次切页就能把控制器推到 L1/L2。
   */
  private readonly onVisibilityChange = (): void => {
    this.budget.softResetWindow();
  };

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
    // 一帧内会调 6~9 次 `renderer.render(scene, …)`（水面折射/深度/镜像、天空两遍、光效 glow
    // 深预渲、合成），每次 render 都会 `scene.updateMatrixWorld()`。这里关掉自动更新，改由
    // `frame()` 每帧刷新一次：动态对象（旋钮 pivot / 粒子 / 激光）在 frame 前已经摆好，
    // 多次 pass 复用同一份矩阵，实测省掉重复遍历与矩阵乘（见 `frame()` 里的手动刷新）。
    this.scene.matrixWorldAutoUpdate = false;
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

    // 切后台会暂停 rAF；切回后的首帧间隔不可信（可达秒级）。挂一个软重置，
    // 只在浏览器环境注册，`dispose()` 里对称摘掉。
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /** 当前主模型根（供端特有功能挂射线/碰撞/拾取用；不要在这里改材质/可见性）。 */
  get rootObject(): THREE.Object3D | null {
    return this.root;
  }

  /**
   * 动态 brush 实体组（实体下标 → 独立 `THREE.Group`）。
   * 默认开启；`globalThis.__vbspDynamicEntityGroups === false` 可关闭（A/B 逃生舱）。
   */
  get dynamicEntityGroups(): ReadonlyMap<number, THREE.Group> {
    return this.dynGroups;
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
    // 换图先把控制器打回干净状态（审查 P1-3）：旧图的 60 帧窗口/稳定计数只会误导新图，
    // 而载图前后的长帧也不该算进新图的预算；档位清零让新图从默认画质起评。
    this.budget.reset();
    this.disposeScene();
    // T-P1-5b：动态 brush 实体脱静态合并默认开启（`__vbspDynamicEntityGroups === false` 可关闭做 A/B）。
    // 关闭时 pending 为 null：mark / exclude / collect / 矩阵冻结豁免全都不执行，行为与旧版一致。
    // 只在 loadScene 入口解析一次 entityIoJson，同时喂给动态实体筛查与 setupSceneExtras。
    const entityBlocks = input.entityIoJson ? parseEntityIoBlocks(input.entityIoJson) : null;
    const dynamicGroupsOn = (globalThis as Record<string, unknown>).__vbspDynamicEntityGroups !== false;
    this.pendingDynamicEntityIndices = dynamicGroupsOn && entityBlocks
      ? parseDynamicEntityIndices(entityBlocks)
      : null;
    const rp = readRenderPrefs();
    this.pvs = input.pvsJson ? new PvsManager(input.pvsJson) : null;
    this.translucentSplit = input.translucentSplit !== false;

    const dxtCaps = detectDxtCapabilities(this.renderer);
    const asm = await assembleScene({
      glb: input.glb,
      logPrefix: this.app,
      pvs: this.pvs,
      skyCamera: input.skyCamera ?? null,
      dxtCaps,
      meshInCluster: (m, c) => this.meshInCluster(m, c),
      onRootReady: input.onRootReady,
      mergeMain: input.merge === false ? undefined : (root) => this.mergeMain(root),
    });
    const dxtStats = (globalThis as { __vbspDxtStats?: VbspDxtStats }).__vbspDxtStats;
    if (dxtStats && (dxtStats.compressed > 0 || dxtStats.fallback > 0)) {
      console.info(
        `[${this.app}][dxt] 原生压缩贴图=${dxtStats.compressed} CPU回退=${dxtStats.fallback} mips=${dxtStats.mipCountTotal} 载荷=${(dxtStats.totalBytes / 1048576).toFixed(1)}MB`,
      );
    }

    this.root = asm.root;
    // T-N6（T-P1-5b 遗留）：`merge === false` 时装配阶段不走 `mergeMain`，动态实体因此既没打标
    // 也没收组，`dynGroups` 恒空 ⇒ 动态 brush 的矩阵冻结豁免与 docs 里的「动态组」全部失效。
    // 这里在装配后补同一份 mark/collect；A/B 关闭（pending 为 null）时整段不执行。
    if (input.merge === false && this.pendingDynamicEntityIndices && this.pendingDynamicEntityIndices.size > 0) {
      const marked = markDynamicEntities(this.root, this.pendingDynamicEntityIndices);
      this.dynGroups = collectDynamicEntityGroups(this.root);
      if (marked > 0) {
        console.info(`[${this.app}][dynamic] merge=false：补标动态实体 ${marked} 个，收组 ${this.dynGroups.size} 个`);
      }
    }
    // Source `TextureScroll` proxy（烟幕/水面流动）：装配后收集一次「共享贴图 + 每秒 UV 周期」，
    // 之后每帧在 `frame()` 里推进（见 `shader/texture-scroll.ts`）。
    this.textureScrolls = collectTextureScrolls(asm.root);
    this.lastFrameAt = 0;
    // Source `momentary_rot_button`（符文盘这类会转的 brush 实体）：装配时已在合并阶段被
    // 保留下来（`rot-buttons.ts` 打标 + `mergeMain` 的 exclude），这里把它们挂到各自 pivot 上。
    this.rotButtons = setupRotButtons(asm.root);
    if (this.rotButtons.length > 0) {
      console.info(`[${this.app}][rot] 旋转实体 ${this.rotButtons.length} 个 pivot`);
    }
    // 诊断口：主根之外的可见 mesh（道具/实体）统计——PVS 只覆盖主根，这些不受它约束。
    (globalThis as { __vbspSceneStats?: unknown }).__vbspSceneStats = () => this.drawnChunkStats();
    // 诊断：Source `TextureScroll` 的收集结果与当前 offset（验证烟幕真的在滚）。
    (globalThis as { __vbspTextureScroll?: unknown }).__vbspTextureScroll = () =>
      this.textureScrolls.map((entry) => ({
        uuid: entry.map.uuid,
        rate: entry.rate,
        offset: [+entry.map.offset.x.toFixed(4), +entry.map.offset.y.toFixed(4)],
        wrap: entry.map.wrapS,
      }));
    // 诊断：泛光参数读写/开关（实例懒建于第一次传参时；无参读当前参数）。
    (globalThis as { __vbspBloom?: (p?: Partial<BloomParams> | null) => BloomParams | null }).__vbspBloom = (p) =>
      p === undefined ? this.bloom : this.setBloom(p);
    // 诊断：`momentary_rot_button` 的 pivot 清单与当前角度（验证符文盘真的在转）。
    (globalThis as { __vbspRotButtons?: unknown }).__vbspRotButtons = () =>
      this.rotButtons.map((entry) => ({
        id: entry.meta.id,
        speed: entry.meta.speed,
        distance: entry.meta.distance,
        angleDeg: +(entry.angle * (180 / Math.PI)).toFixed(2),
        origin: entry.meta.origin.map((v) => +v.toFixed(1)),
        pivot: entry.pivot.position.toArray().map((v) => +v.toFixed(1)),
      }));
    (globalThis as { __vbspChunkAudit?: unknown }).__vbspChunkAudit = (limit?: number) => this.chunkAudit(limit);
    // 诊断：块级并集泄漏量（逐三角形质心查 cluster，统计「画了但不可见」的比例）。
    (globalThis as { __vbspChunkLeak?: unknown }).__vbspChunkLeak = (limit?: number) => this.chunkLeak(limit);
    (globalThis as { __vbspProbeChunk?: unknown }).__vbspProbeChunk = (name: string) => this.probeChunk(name);
    (globalThis as { __vbspRayCheck?: unknown }).__vbspRayCheck = (idx: number) => this.rayCheck(idx);
    (globalThis as { __vbspFrustumAudit?: unknown }).__vbspFrustumAudit = (sx?: number, sy?: number) => this.frustumAudit(sx, sy);
    (globalThis as { __vbspPvsInfo?: unknown }).__vbspPvsInfo = (limit?: number) => this.pvsInfo(limit);
    (globalThis as { __vbspPickAt?: unknown }).__vbspPickAt = (x?: number, y?: number) => this.pickAt(x, y);
    (globalThis as { __vbspChunkDetail?: unknown }).__vbspChunkDetail = (idx: number, near?: number) => this.chunkClusterDetail(idx, near);
    // 诊断：世界坐标 → BSP leaf 的 cluster（-1 = 固体），以及两个 cluster 的 PVS 互见性。
    (globalThis as { __vbspClusterAt?: unknown }).__vbspClusterAt = (x: number, y: number, z: number) =>
      this.pvs ? this.pvs.getClusterAt({ x, y, z }) : -1;
    // 诊断：相机世界坐标与朝向（沿视线采样 leaf/cluster 用）
    (globalThis as { __vbspCam?: unknown }).__vbspCam = () => {
      const p = this.camera.position;
      const d = this.camera.getWorldDirection(new THREE.Vector3());
      return { pos: [p.x, p.y, p.z], dir: [d.x, d.y, d.z] };
    };
    // 诊断：cluster 的空间范围 / 任意 cluster 的 PVS 行（判断「块↔cluster 映射错」还是「PVS 行错」）
    (globalThis as { __vbspClusterBounds?: unknown }).__vbspClusterBounds = (c: number) =>
      this.pvs ? this.pvs.clusterBounds(c) : null;
    (globalThis as { __vbspPvsRow?: unknown }).__vbspPvsRow = (c: number, target?: number) => {
      if (!this.pvs) return null;
      const ids = this.pvs.visibleClustersOf(c);
      return { cluster: c, count: ids.length, sample: ids.slice(0, 20), hasTarget: target === undefined ? null : ids.includes(target) };
    };
    // 诊断：地图世界包围盒（min/max），网格采样找「室内」机位用。
    (globalThis as { __vbspBounds?: unknown }).__vbspBounds = () => {
      const box = this.worldBox();
      return box ? { min: box.min.toArray(), max: box.max.toArray() } : null;
    };
    // 诊断：运行期切剔除档（0 = 自动 maxDim×0.5），用于 A/B「这面墙是被距离剔除吃掉的吗」。
    // 注意：`pvs()` 必须写 override，`updateVisibility()` 每帧都会用 prefs 覆盖 `enablePvs`。
    (globalThis as { __vbspCulling?: unknown }).__vbspCulling = {
      distance: (v: number) => this.setCullDistance(v),
      pvs: (on: boolean) => {
        this.pvsOverride = on;
        this.visibility.enablePvs = on;
        return this.visibility.enablePvs;
      },
      /** 仅取证用：关掉距离场（无限远），得到「只按 PVS」或「全画」的对照图。 */
      full: () => {
        this.visibility.setCullDistance(Number.POSITIVE_INFINITY, 0);
        return this.visibility.cullDistance;
      },
      state: () => ({
        cull: this.visibility.cullDistance,
        auto: this.visibility.autoCullDistance,
        pvs: this.visibility.enablePvs,
        pvsOverride: this.pvsOverride,
        maxDim: this.maxDim,
        rev: RENDER_REV,
        index: this.clusterIndex,
        /** 本帧用于可见性判定的相机 cluster（-1 = 定位不到房间，此时不做三角级裁剪）。 */
        clusterAtCamera: this.lastVisibility?.clusterAtCamera ?? -1,
        clusterValid: this.lastVisibility?.pvsClusterValid === true,
        cameraInSolid: this.lastVisibility?.cameraInSolid === true,
      }),
    };
    // 诊断：按 cluster 拆分后的分片体检（块数、每片记的 cluster 数、几何三角形数）。
    (globalThis as { __vbspPieceAudit?: unknown }).__vbspPieceAudit = (limit = 12) => {
      const rows = this.visibility.items
        .filter((it) => Array.isArray((it.mesh.userData as { splitClusters?: number[] }).splitClusters))
        .map((it) => {
          const g = it.mesh.geometry as THREE.BufferGeometry;
          const tris = (g.index ? g.index.count : (g.getAttribute('position') as THREE.BufferAttribute).count) / 3;
          return {
            name: it.mesh.name,
            tris: Math.round(tris),
            clusters: it.clusterIds.length,
            declared: ((it.mesh.userData as { splitClusters?: number[] }).splitClusters ?? []).length,
            visible: it.mesh.visible,
          };
        });
      return { pieces: rows.length, rows: rows.slice(0, limit) };
    };
    // 诊断：天空层内容体检。`extractSkyArea` 的判据是「任一采样点落在 sky_camera 所在 cluster」，
    // 一个跨区的合并 mesh 只要有一个采点命中就整块搬去天空层（主相机永远不画）。
    // 这里报出天空层每块的世界包围盒大小，与主根包围盒对比即可看出是否「误摘」。
    (globalThis as { __vbspSkyDiag?: unknown }).__vbspSkyDiag = () => {
      const g = this.skyGroup;
      if (!g) return { hasGroup: false };
      const world = this.worldBox();
      const mainSize = world ? world.getSize(new THREE.Vector3()) : null;
      const items = g.children
        .filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh)
        .map((m) => {
          const b = new THREE.Box3().setFromObject(m);
          const s = b.getSize(new THREE.Vector3());
          const tris = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
          return {
            name: m.name,
            tris,
            size: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)],
            diag: +Math.max(s.x, s.y, s.z).toFixed(1),
            min: b.min.toArray().map((v) => +v.toFixed(0)),
            max: b.max.toArray().map((v) => +v.toFixed(0)),
          };
        })
        .sort((a, b) => b.diag - a.diag);
      return {
        hasGroup: true,
        children: g.children.length,
        mainSize: mainSize ? [+mainSize.x.toFixed(0), +mainSize.y.toFixed(0), +mainSize.z.toFixed(0)] : null,
        largest: items.slice(0, 8),
        totalTris: items.reduce((s, i) => s + i.tris, 0),
      };
    };
    if (this.markBspModel) this.root.userData.isBspModel = true;
    this.bbox = asm.bbox;
    this.maxDim = asm.maxDim;
    this.scene.add(this.root);
    // spot 光源的可见光柱（起源 point_spotlight 的锥面/光斑观感）：不参与剔块，单独挂场景。
    this.spotBeams = asm.spotBeams;
    if (this.spotBeams) this.scene.add(this.spotBeams);
    if (entityBlocks && entityBlocks.length > 0) {
      (this.spotBeams?.userData.rig as SpotBeamRig | undefined)?.attachEntityHierarchy(entityBlocks);
    }
    if (this.dynGroups.size > 0) {
      this.dynamicAmbient.collect(this.dynGroups);
    }
    // 合并后的块把顶点烘焙成世界坐标、local 矩阵清成单位阵，但 `matrixWorld` 要等一次
    // updateMatrixWorld 才会跟上（mergeIntoChunks 里只调了 `m.updateMatrix()`，从未刷新
    // matrixWorld；`renderer.compile` 也不刷）。PVS 采样按 `mesh.matrixWorld` 把几何点变换到
    // 世界空间，这里若拿到旧矩阵就是**二次变换**：cluster 非空但全错，且因为「非空」连
    // 「空集合补算」都救不回来 —— 2026-11-13 owner 报的「冰坡透明材质消失 / 666 窗外又露出
    // 别区结构」就是这一条（同一个错映射既可能误剔、也可能误留）。必须先刷矩阵再收集。
    this.root.updateMatrixWorld(true);
    this.sorter.collect(this.root);

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

    // 静态矩阵冻结：到这一步场景里的对象（世界块、天空盒、光柱）已经全部挂好、矩阵已刷新，
    // 之后只有「旋钮 pivot 每帧转」和运行期才挂的粒子/激光会动。逐帧 `scene.updateMatrixWorld()`
    // 是 tick 的第二大 JS 开销（飞行回放 CPU 采样 9.6%）：把不再移动的对象置
    // `matrixAutoUpdate=false`，每帧只遍历、不做矩阵乘；pivot 的 rotation 变化仍会以 force
    // 传给子节点，位置照常生效。
    this.scene.updateMatrixWorld(true);
    this.freezeStaticMatrices();

    // 场景扩展（env_laser / PCF 粒子）：实体 lump 的副产物，三端统一在这里装配。
    // 必须早于 `precompileScene`，且先推一拍 `update()`——粒子的网格/材质是在第一次
    // update 里才建出来的；晚于预编译就会在首帧现编 program（debug 实测单帧 84ms）。
    this.setupSceneExtras(entityBlocks);

    // 预编译必须在 scene.add(root) 之后：早于它编译的是空场景（game/debug 旧注释的同一约束）。
    precompileScene(this.renderer, this.scene, this.camera);

    // bloom 的遮挡预渲：把实体几何合并成一张静态深度代理（1 次 draw）。旧做法是每帧把
    // 整场景用 overrideMaterial 再画一遍，视距 18000、可见 400+ 块时单独 1.94ms/帧。
    this.applyGlowDepthProxy(buildDepthProxy(this.root));

    // 相机 near/far/fov：共享口径（viewer 原 far 下限已取消，三端同一个 maxDim×100）
    applySceneCamera(this.camera, this.nearPlane, this.maxDim, rp.camera.fov);

    // 可见性：收集主根块 → 补 PVS cluster → 定剔除距离（天空层在收集阶段跳过）
    this.visibility.enablePvs = rp.culling.pvs;
    this.visibility.collect(this.root, this.pvs);
    // PVS 粒度下沉：合并块经常横跨多个房间，而运行期只能判「块里有没有一个 cluster 可见」，
    // 于是「任一分区可见 ⇒ 整块画」会把别的房间的三角形一起画出来（666 隔着窗看到别处关卡结构）。
    // PVS 粒度下沉（不拆 mesh）：合并块常横跨多个房间，运行期只能判「块里有没有一个 cluster
    // 可见」，于是「任一分区可见 ⇒ 整块画」会把别的房间的三角形一起画出来（666 隔窗看到别处
    // 关卡结构、boreas 冰坡时隐时现都源自此）。这里给跨房间的块建「逐三角形 → cluster」表，
    // 相机换房间时按可见集重建 index，只留可见三角形：draw 数不变、精度到三角形。
    this.clusterIndex = this.visibility.enablePvs && this.pvs
      ? prepareClusterIndex(this.visibility.items, this.pvs, 2)
      : null;
    if (!this.clusterIndex) this.visibility.chunkIndexActive = false;
    else this.visibility.chunkIndexActive = this.clusterIndex.prepared > 0;
    this.pvsIndexActive = false;
    const box = this.worldBox();
    const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3();
    this.diagonal = size.length();
    this.maxCull = Math.ceil((this.diagonal * 4) / 100) * 100;
    // 默认剔除距离：**距离场 + PVS 两层同时生效**（用户 2026-11-12 定的运行模型）——
    // 以玩家为球心、半径 `CULL_DISTANCE_PVS_DEFAULT`（18000 HU）的距离场先判一次：场外的块直接不画、
    // **也不参与 PVS 判定**（省掉这部分的 `isVisible` 查询与提交）；场内的块再交给 PVS 决定画不画。
    // PVS 关 = 纯距离档，退回最大边 × 0.25（旧默认全量绘制 2789 draw / 53fps，那一档靠距离兜底）。
    // 面板显式设的「视距」照常覆盖默认值（两层都按 `setCullDistance` 的同一口径）。
    const autoCull = rp.culling.pvs ? CULL_DISTANCE_PVS_DEFAULT : this.maxDim * 0.25;
    const defaultCull = this.visibility.setCullDistance(autoCull, this.cullConfigValue(rp.culling.distance));

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

    // 走到这里相机/可见性/环境/贴图档都已就位，可以做「整帧预热」：
    // 把场景全部对象临时置可见并关掉视锥剔除，跑一帧真实 frame()（主遍 + 水面折射/镜像 +
    // 天空 + 泛光 pas 全部执行），让每个材质在**每种 pass 的 render target 形态**下都编译一次。
    // 冷启动实测（`.tmp/flight-195645.json`）：不做这一步时首飞途中才编译 31 个 program，
    // 单帧 159~200ms；做完后飞行途中应为 0 新增。
    this.glowDirty = true;
    this.prewarmPasses();

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

  /**
   * 冻结静态对象的本地矩阵（`matrixAutoUpdate = false`）。
   *
   * 只跳过自己每帧改变换的对象：旋钮 pivot（`userData.vbspRotPivot`，`updateRotButtons`
   * 每帧写 `rotation`）、Sprite（billboard 走 shader，但飞行回放里 smoke sprite 不移动，
   * 冻结同样安全）以外的全部对象。子节点在父节点矩阵变化时会收到 `force=true`，
   * 所以 pivot 旋转后其下 mesh 的 `matrixWorld` 仍会正确刷新。
   *
   * @returns 冻结的对象数（诊断口 `__vbspStaticFrozen`）。
   */
  private freezeStaticMatrices(): number {
    let frozen = 0;
    // `__vbspDynamicEntityGroups=false` 时 dynGroups 恒为空：下面的组检查整段跳过，冻结循环与旧版一致。
    const groupNodes = new Set<THREE.Object3D>();
    const groupAncestors = new Set<THREE.Object3D>();
    for (const group of this.dynGroups.values()) {
      groupNodes.add(group);
      // 蓝图只要求豁免「组及其祖先」；组内 mesh 的几何已世界烘焙、局部矩阵恒等，
      // 冻结后仍会随 group.matrixWorld 移动，不能因为祖先带标记就把整棵子树留在
      // matrixAutoUpdate=true（77 组约 1804 mesh，实测会让帧时间翻倍）。
      for (let node = group.parent; node; node = node.parent) groupAncestors.add(node);
    }
    this.scene.traverse((obj) => {
      if (obj.userData.vbspRotPivot === true) return;
      if (obj.userData.vbspDynamicSpot === true) return;
      // T-P1-5a/5b：组节点运行期要改 `position`，祖先也要保持可更新；组内子节点照常冻结。
      if (groupNodes.has(obj) || groupAncestors.has(obj)) return;
      obj.matrixAutoUpdate = false;
      frozen++;
    });
    (globalThis as { __vbspStaticFrozen?: number }).__vbspStaticFrozen = frozen;
    return frozen;
  }

  /** 载图期整帧预热：实现见 `prewarm.ts`（T-P2-2c 搬出，逻辑零改动）。 */
  prewarmPasses(): void {
    runPrewarmPasses({
      app: this.app,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      nearPlane: this.nearPlane,
      visibility: this.visibility,
      frameCtx: this.frameCtx,
      budget: this.budget,
      getRoot: () => this.root,
      getPvsOverride: () => this.pvsOverride,
      setPvsOverride: (v) => { this.pvsOverride = v; },
      getPvsAutoCull: () => this.pvsAutoCull,
      setPvsAutoCull: (v) => { this.pvsAutoCull = v; },
      updateVisibility: () => this.updateVisibility(),
      frame: (o) => this.frame(o),
    });
  }

  /** 换图/卸载：释放根、天空组、环境与渲染列表；renderer/scene/camera 本身复用。 */
  disposeScene(): void {
    // 滚动贴图是旧根的贴图对象，disposeScene 后不能再推进（会写已释放的贴图）。
    this.textureScrolls = [];
    // pivot 是旧根的子树（mesh 已被 disposeObject 释放），清空引用即可。
    this.rotButtons = [];
    // T-P1-5a：动态实体组属于旧根（mesh 随 root 一起 dispose），引用与待标记集合都要清，
    // 否则下一张图会沿用旧图的下标集合。
    this.dynGroups = new Map();
    this.dynamicAmbient.clear();
    this.pendingDynamicEntityIndices = null;
    this.lastFrameAt = 0;
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
    if (this.spotBeams) {
      disposeObject(this.spotBeams);
      this.scene.remove(this.spotBeams);
      this.spotBeams = null;
    }
    resetWaterShaders();
    // 自定义注入的贴图（双贴图过渡 / $bumpmap）不挂在材质标准槽位上，disposeObject 扫不到；
    // 这两个注册表是模块级强引用，不在这里清就会把上一张图的整批贴图留在显存里。
    resetWorldTransitionTextures();
    resetBumpTextures();
    this.sorter.clear();
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
    this.pvsOverlay.reset();
    this.lastVisibility = null;
    this.solidSeamFrames = 0;
    this.lastVisMs = 0;
    // 深度代理是主根的合并副本，换图后必须释放（几何可能几十 MB）。
    this.applyGlowDepthProxy(null);
    // 场景扩展（激光 / 粒子）也属于旧图，换图时一起释放。
    this.disposeSceneExtras();
    this.glowDirty = true;
  }

  /**
   * 装配 `env_laser` 光束、PCF 粒子与地图资产实体图元（实体 lump 的副产物），并先推一拍
   * `update()`。
   *
   * 三端共用：数据同源（`entityIoJson`），装配顺序固定为「建 → 挂场景 → 先截断 → 推一拍」，
   * 这样预编译与整帧预热都能覆盖它们的材质（旧实现只在 debug 装配，且晚于预热帧）。
   * 装配失败只告警并清空，不影响主场景（这些图元是观感增强，不是必需）。
   */
  private setupSceneExtras(entityBlocks?: EntityBlockRecords | null): void {
    this.disposeSceneExtras();
    if (!entityBlocks || entityBlocks.length === 0) return;
    try {
      const beams = collectLaserBeams(entityBlocks);
      if (beams.length > 0) {
        this.laserBeams = new LaserBeams(beams);
        this.scene.add(this.laserBeams.root);
        // 先用渲染网格 Raycaster 截断（无物理时的等价行为）；物理就绪后宿主会调
        // `setLaserPhysicsTrace` 用 MASK_SOLID 扫掠重截断。
        this.laserBeams.trace(this.root, this.laserPhysTrace ?? undefined);
      }
      const entities = collectParticleEntities(entityBlocks);
      if (entities.length > 0) {
        const systems = new ParticleSystems(entities);
        // 有实体但没有可渲染效果（配置未覆盖的效果）时不建组、不挂场景（零开销）。
        if (systems.root.children.length > 0) {
          this.particleSystems = systems;
          this.scene.add(systems.root);
        } else {
          systems.dispose();
        }
      }
      const g = globalThis as {
        __vbspParticles?: ParticleSystems | null;
        __vbspLasers?: LaserBeams | null;
        __vbspEntityExtras?: EntityExtras | null;
        __vbspEntityExtrasStats?: EntityExtrasStats;
      };
      g.__vbspParticles = this.particleSystems;
      g.__vbspLasers = this.laserBeams;
      // 地图资产实体（env_sprite / point_worldtext / move_rope+keyframe_rope / env_beam）：
      // 实体 lump 里有数据但此前没有消费者。A/B 逃生：`globalThis.__vbspEntityExtrasOff = true`
      // 时整类不装配；四类实体总数为 0 时 `fromBlocks` 返回 null，不建对象/贴图、零新增 draw。
      const extrasOff =
        (globalThis as { __vbspEntityExtrasOff?: boolean }).__vbspEntityExtrasOff === true;
      this.entityExtras = extrasOff
        ? null
        : EntityExtras.fromBlocks(entityBlocks, (label, err) => {
            console.warn(`[${this.app}][extras] ${label} 装配失败（跳过该类）：`, err);
          });
      if (this.entityExtras) {
        this.scene.add(this.entityExtras.root);
        // 与激光/粒子同口径：挂上场景后先推一拍，让预编译与整帧预热都能覆盖其材质。
        // 相机矩阵可能还没刷新过（装载顺序不保证），这里先推一次再摆 quad。
        this.camera.updateMatrixWorld();
        this.entityExtras.update(this.camera);
      }
      g.__vbspEntityExtras = this.entityExtras;
      g.__vbspEntityExtrasStats = this.entityExtras
        ? this.entityExtras.stats
        : emptyEntityExtrasStats();
      if (!this.laserBeams && !this.particleSystems && !this.entityExtras) return;
      // 粒子的网格/材质在第一次 update 才创建：预热与预编译之前必须先建出来。
      const t = 1 / 64;
      this.laserBeams?.update(t, this.camera);
      this.particleSystems?.update(t, this.camera);
      const extrasStats = this.entityExtras?.stats;
      console.info(
        `[${this.app}][extras] env_laser ${beams.length} 条 / PCF 粒子 ${entities.length} 组 / ` +
          `资产实体 sprite ${extrasStats?.sprite ?? 0} · worldtext ${extrasStats?.worldtext ?? 0} · ` +
          `rope ${extrasStats?.rope ?? 0} · beam ${extrasStats?.beam ?? 0} ` +
          `（新增 draws ${extrasStats?.draws ?? 0}）已挂入场景`,
      );
    } catch (err) {
      console.warn(`[${this.app}][extras] 场景扩展装配失败（跳过）：`, err);
      this.disposeSceneExtras();
    } finally {
      this.glowDirty = true;
    }
  }

  // ── 实体图元的运行期显隐/启停（T-N6）────────────────────────────────────────
  // 三端都能用：源实体 I/O 的 ShowSprite/HideSprite/ToggleSprite（CSprite，Sprite.cpp:77-79）
  // 与 Start/Stop（CParticleSystem，particle_system.cpp:117-118）落到这里；装配期初态门控
  // 也走同一条路径（见 `entity-state.ts` 的逐类口径）。点实体没有图元时返回 false。

  /** 运行期 `ShowSprite` / `HideSprite`；未知下标（不是 env_sprite）返回 false。 */
  setSpriteVisible(entityIndex: number, visible: boolean): boolean {
    return this.entityExtras ? this.entityExtras.setSpriteVisible(entityIndex, visible) : false;
  }

  /** 当前 sprite 可见性；null = 没有该实体的图元。 */
  spriteVisible(entityIndex: number): boolean | null {
    return this.entityExtras ? this.entityExtras.spriteVisible(entityIndex) : null;
  }

  /** 运行期 `Start` / `Stop`；未知/未覆盖的 effect 返回 false。 */
  setParticleActive(entityIndex: number, active: boolean): boolean {
    return this.particleSystems ? this.particleSystems.setEntityActive(entityIndex, active) : false;
  }

  /** 当前粒子门控状态；null = 该实体没有可门控的粒子对象。 */
  particleActive(entityIndex: number): boolean | null {
    return this.particleSystems ? this.particleSystems.isEntityActive(entityIndex) : null;
  }

  /**
   * 把一条源实体输入事件（`EntityEvent.kind === 'input'` 的 `detail` = `classname.InputName`）
   * 映射到图元显隐/启停。**只覆盖本层有图元的三类**：env_sprite、info_particle_system；
   * prop_dynamic 的 TurnOn/TurnOff 走 brush 可见性链（brush_/prop_ 区间），point_worldtext 的
   * SDK datadesc 里没有显隐输入（恒可见）。未覆盖的输入返回 false，调用方可继续自己的分派。
   */
  applyEntityInput(event: { classname: string; entityIndex: number; detail?: string }): boolean {
    const detail = event.detail ?? '';
    const dot = detail.lastIndexOf('.');
    const input = dot >= 0 ? detail.slice(dot + 1) : detail;
    if (event.classname === 'env_sprite' || event.classname === 'env_sprite_clientside') {
      if (input === 'ShowSprite') return this.setSpriteVisible(event.entityIndex, true);
      if (input === 'HideSprite') return this.setSpriteVisible(event.entityIndex, false);
      if (input === 'ToggleSprite') {
        const current = this.spriteVisible(event.entityIndex);
        return current === null ? false : this.setSpriteVisible(event.entityIndex, !current);
      }
      return false;
    }
    if (event.classname === 'info_particle_system') {
      if (input === 'Start') return this.setParticleActive(event.entityIndex, true);
      if (input === 'Stop') return this.setParticleActive(event.entityIndex, false);
      return false;
    }
    return false;
  }

  /** 更新实体平移偏移：同步随 parentname 挂载的 point_spotlight 与动态实体实时光照采样。 */
  setEntityOffset(entityIndex: number, offset: readonly [number, number, number]): void {
    (this.spotBeams?.userData.rig as SpotBeamRig | undefined)?.setEntityOffset(entityIndex, offset);
    this.dynamicAmbient.markMoved(entityIndex);
    this.nearPlane.invalidateCache();
  }

  /** 更新实体旋转角度（Source pitch/yaw/roll）：同步随 parentname 挂载的 point_spotlight。 */
  setEntityRotation(entityIndex: number, angles: readonly [number, number, number]): void {
    (this.spotBeams?.userData.rig as SpotBeamRig | undefined)?.setEntityRotation(entityIndex, angles);
    this.dynamicAmbient.markMoved(entityIndex);
    this.nearPlane.invalidateCache();
  }

  /** 释放场景扩展图元（激光束 / PCF 粒子 / 地图资产实体）及其根节点；幂等。 */
  private disposeSceneExtras(): void {
    if (this.laserBeams) {
      this.scene.remove(this.laserBeams.root);
      this.laserBeams.dispose();
      this.laserBeams = null;
    }
    if (this.particleSystems) {
      this.scene.remove(this.particleSystems.root);
      this.particleSystems.dispose();
      this.particleSystems = null;
    }
    if (this.entityExtras) {
      this.scene.remove(this.entityExtras.root);
      this.entityExtras.dispose();
      this.entityExtras = null;
    }
    const g = globalThis as {
      __vbspParticles?: ParticleSystems | null;
      __vbspLasers?: LaserBeams | null;
      __vbspEntityExtras?: EntityExtras | null;
      __vbspEntityExtrasStats?: EntityExtrasStats;
    };
    g.__vbspParticles = null;
    g.__vbspLasers = null;
    g.__vbspEntityExtras = null;
    g.__vbspEntityExtrasStats = emptyEntityExtrasStats();
    this.glowDirty = true;
  }

  /**
   * 物理世界就绪后重截断 `env_laser`（三端在 buildPredictionWorld / 物理注入之后调一次）。
   *
   * 物理扫掠只认实体 brush：触发体 / nodraw / 水面天然被忽略，坡上该有的光线不会被误截
   * （旧实现 debug 端在物理就绪后用同一口径重截过一次，这里收进会话，避免各端再写一遍）。
   * 传 null = 回到渲染网格 Raycaster 口径。
   */
  setLaserPhysicsTrace(trace: ((start: THREE.Vector3, end: THREE.Vector3) => number) | null): void {
    this.laserPhysTrace = trace;
    this.laserBeams?.trace(null, trace ?? undefined);
  }

  /** 只做可见性判定（debug 的按需渲染需要在决定是否出帧前先知道有无变化）。 */
  updateVisibility(): VisibilityUpdateResult {
    const dbgVis = !!(globalThis as { __vbspDrawDebug?: { on?: boolean } }).__vbspDrawDebug?.on;
    const tVis = dbgVis ? performance.now() : 0;
    const cullAll = (globalThis as { __vbspPvsCullAll?: boolean }).__vbspPvsCullAll === true;
    // 档即开关：面板/深链改 `culling.pvs` 后下一帧生效。
    // 区域着色开启时强制关掉 PVS 剔除——否则「不可见的区域」根本不会被画出来，就看不到对照。
    this.visibility.enablePvs = this.pvsOverride ?? (!this.pvsOverlay.enabled && (cullAll || readRenderPrefs().culling.pvs));
    // PVS 开关一变，自动距离档跟着换：PVS 开 ⇒ 距离场半径 `CULL_DISTANCE_PVS_DEFAULT`（18000）；
    // PVS 关 ⇒ `maxDim × 0.25` 的纯距离档。两层同时生效时**距离场先判**（场外不画、也不进 PVS），
    // 面板显式「视距」始终覆盖默认值。
    if (this.pvsAutoCull !== this.visibility.enablePvs) {
      this.pvsAutoCull = this.visibility.enablePvs;
      const rp = readRenderPrefs();
      this.visibility.setCullDistance(
        this.pvsAutoCull ? CULL_DISTANCE_PVS_DEFAULT : this.maxDim * 0.25,
        this.cullConfigValue(rp.culling.distance),
      );
    }
    // PVS 是**装载之后**才被打开的（面板勾选、或存档里上次是关的）时补建逐三角形 cluster 表：
    // 装载期那条快路径会跳过（`enablePvs` 当时还是 false），不补建就一直停在块级并集上。
    // `prepared === 0` 也要重试：装载期那趟可能因为 clusterIds 还没算出来而整批跳过，
    // 只记下一个 prepared=0 的统计对象；不重试就永远停在块级并集上（踩过）。
    if (this.visibility.enablePvs && (!this.clusterIndex || this.clusterIndex.prepared === 0) && this.pvs) {
      // 先补算 cluster：PVS 打开前 `collect()` 没采样过，空 clusterIds 会让过滤没有候选。
      this.visibility.ensureClusters(this.pvs);
      this.clusterIndex = prepareClusterIndex(this.visibility.items, this.pvs, 2);
      this.visibility.chunkIndexActive = this.clusterIndex.prepared > 0;
    }
    if (this.visibility.enablePvs && this.clusterIndex && this.clusterIndex.prepared > 0) {
      this.visibility.chunkIndexActive = true;
    }
    this.lastVisibility = this.visibility.update(this.camera, this.pvs);
    // 相机换房间才重建 index（PVS 与视角无关）：可见三角形集合一次算好，逐帧零成本。
    // ⚠ 必须用本帧**真正定位到**的 `clusterAtCamera`，不能用 `pvs.currentClusterId`：相机嵌进
    // 实体（穿墙/贴脸）时后者保留的是上一个房间，拿它裁三角形会把眼前可见的面整片裁掉——
    // 表现就是「相机穿透状态下坡面缺一块块三角形」。
    const camCluster = this.lastVisibility?.clusterAtCamera ?? -1;
    const camClusterValid = this.lastVisibility?.pvsClusterValid === true;
    const camInSolid = this.lastVisibility?.cameraInSolid === true;
    if (this.visibility.enablePvs && this.clusterIndex && this.clusterIndex.prepared > 0 && this.pvs) {
      if (cullAll) {
        this.solidSeamFrames = 0;
        applyClusterIndex(this.visibility.items, this.pvs, -999);
        this.pvsIndexActive = true;
      } else if (camClusterValid && camCluster >= 0 && !camInSolid) {
        this.solidSeamFrames = 0;
        applyClusterIndex(this.visibility.items, this.pvs, camCluster);
        this.pvsIndexActive = true;
      } else if (this.pvsIndexActive) {
        if (camInSolid) {
          this.solidSeamFrames++;
          if (this.solidSeamFrames >= 2) {
            restoreClusterIndex(this.visibility.items);
            this.pvsIndexActive = false;
          }
        } else {
          restoreClusterIndex(this.visibility.items);
          this.pvsIndexActive = false;
        }
      }
    } else if (this.pvsIndexActive) {
      // 关 PVS（面板/深链/区域着色）后必须把裁过的 index 还原：`applyClusterIndex` 只认相机 cluster，
      // 不会因为开关关掉就把墙补回来；不还原就是「PVS 关了、缺的那块还在」。
      restoreClusterIndex(this.visibility.items);
      this.visibility.chunkIndexActive = false;
      this.pvsIndexActive = false;
    }
    this.spots.update(this.spotBeams, this.camera);
    if (dbgVis) this.lastVisMs = +(performance.now() - tVis).toFixed(2);
    return this.lastVisibility;
  }

  /** PVS 区域着色开关（debug 面板用；开启期间不按 PVS/距离剔除，只上色，才能看清「不可见的区域」）。 */
  setPvsRegionOverlay(on: boolean): boolean {
    this.pvsOverlay.setEnabled(on, this.root, this.pvs);
    if (on) {
      // 暂时关掉距离剔除：否则远处块根本不画，看不到「存在但从当前簇不可见」的灰区
      this.visibility.setCullDistance(Number.POSITIVE_INFINITY, 0);
      // 立刻按当前相机算一遍，避免第一帧全是「不可见」灰
      this.pvsOverlay.update(this.root, this.pvs, this.camera.position);
    } else {
      const rp = readRenderPrefs();
      this.visibility.setCullDistance(
        rp.culling.pvs ? CULL_DISTANCE_PVS_DEFAULT : this.maxDim * 0.25,
        this.cullConfigValue(rp.culling.distance),
      );
    }
    return this.pvsOverlay.enabled;
  }

  /** 泛光诊断/调参口（debug HUD、CDP A/B 用）。 */
  get bloom(): BloomParams | null {
    return this.bloomFx?.currentParams ?? null;
  }

  /**
   * 运行期开关/调参泛光：`null` 关闭（回到直画），对象则按参数启用并更新。
   * 关闭后再打开需要重建，故这里只改参数、不销毁实例（强度 0 = 关闭）。
   */
  setBloom(params: Partial<BloomParams> | null): BloomParams | null {
    if (params === null) {
      this.bloomFx?.setParams({ strength: 0 });
      return this.bloomFx?.currentParams ?? null;
    }
    const fx = this.getOrCreateBloomFx();
    fx?.setParams(params);
    return fx?.currentParams ?? null;
  }

  /** 懒建泛光实例（首次 setBloom 时；上下文不支持时返回 null）。 */
  private getOrCreateBloomFx(): BloomPostFx | null {
    if (this.bloomFx) return this.bloomFx;
    try {
      this.bloomFx = new BloomPostFx(this.renderer, DEFAULT_BLOOM_PARAMS);
      this.bloomFx.setDepthProxy(this.glowDepthProxy);
      // T-P2-1：泛光降级点从上下文读预算/dt，不再自己读 globalThis。
      this.bloomFx.setFrameContext(this.frameCtx);
      return this.bloomFx;
    } catch (err) {
      console.warn('[render] 泛光初始化失败，回退直画：', err);
      this.bloomFx = null;
      return null;
    }
  }

  /**
   * 安装/替换 bloom 光效层的静态深度代理（建图后一次）。实例可能还没懒建，
   * 所以先存到 session 上，等 `getOrCreateBloomFx` 时再挂过去。
   */
  private applyGlowDepthProxy(
    proxy: { mesh: THREE.Mesh; vertices: number; triangles: number } | null,
  ): void {
    const mesh = proxy?.mesh ?? null;
    if (this.glowDepthProxy === mesh) return;
    // bloom 实例不存在时没人替我们释放旧代理。
    if (this.glowDepthProxy && !this.bloomFx) {
      this.glowDepthProxy.geometry.dispose();
      (this.glowDepthProxy.material as THREE.Material).dispose();
    }
    this.glowDepthProxy = mesh;
    this.bloomFx?.setDepthProxy(mesh);
    if (proxy) {
      (globalThis as { __vbspDepthProxy?: { vertices: number; triangles: number } }).__vbspDepthProxy = {
        vertices: proxy.vertices,
        triangles: proxy.triangles,
      };
      console.info(
        `[${this.app}][bloom] 深度代理：${proxy.triangles.toFixed(0)} 三角 / ${proxy.vertices} 顶点，预渲由整场景改为 1 次 draw`,
      );
    }
  }

  /** 当前可用的泛光实例（强度 0 时返回 null ⇒ 走直画路径）。 */
  private ensureBloomFx(): BloomPostFx | null {
    // 默认参数是开启的，所以实例在首帧懒建；`setBloom({strength:0})` 之后为 null。
    const fx = this.getOrCreateBloomFx();
    if (!fx) return null;
    fx.ensureSize();
    return fx.enabled ? fx : null;
  }

  /**
   * 每帧绘制：可见性 → 近平面贴墙（隔帧）→ 起源两遍法（天空相机 + 主相机）。
   *
   * 调用方负责先把相机位姿写好（game/debug 从物理状态、viewer 从自由飞行）。
   */
  frame(opts: RenderFrameOptions = {}): VisibilityUpdateResult | null {
    // 帧预算控制器（task-33 方案 C1）：rAF 只有 320Hz 一档（3.125ms/帧），一帧渲染提交
    // 只要超过 3.125ms 就会被推到 6.25ms 槽 ⇒ 观感「320/160 交替」。这里用「渲染段实测
    // 毫秒数」做滞回：连续 3 帧超预算升一级，连续 20 帧低于 T−0.2ms 降一级；等级通过
    // `globalThis.__vbspBudgetLevel` 暴露给各降级点（bloom 光晕 cadence、水面镜面 cadence 等）。
    // 采样用渲染段而不是整帧 tick：物理/粒子抖动不应触发画质降级。
    const tBudget = performance.now();
    const budgetDt = this.budget.lastStart > 0 ? tBudget - this.budget.lastStart : 0;
    this.budget.lastStart = tBudget;
    // 分阶段耗时采样：默认关闭（只在每帧多几次 performance.now()），排查「某一帧突然变长」
    // 时在控制台执行 `__vbspDrawDebug = { on: true }`，帧末可从 `__vbspDraws.times` 读到
    // vis/near/sort/water/sky 各段的毫秒数（2026-11 定位「人一动就掉帧」用的就是它）。
    const dbgOn = !!(globalThis as { __vbspDrawDebug?: { on?: boolean } }).__vbspDrawDebug?.on;
    const tFrame = dbgOn ? performance.now() : 0;
    const times: Record<string, number> = {};
    let tLast = dbgOn ? performance.now() : 0;
    const mark = (n: string): void => {
      if (!dbgOn) return;
      const now = performance.now();
      times[n] = +(now - tLast).toFixed(2);
      tLast = now;
    };
    const frameNow = performance.now();
    const cullAll = (globalThis as { __vbspPvsCullAll?: boolean }).__vbspPvsCullAll === true;
    const activePvs =
      this.visibility.enablePvs && this.pvs && this.pvs.enabled && (cullAll || this.lastVisibility?.pvsClusterValid !== false)
        ? this.pvs
        : null;
    // Source `TextureScroll` / `momentary_rot_button` / 激光 UV / 粒子：按真实时间推进。
    // 放在可见性之前：这些动画不影响剔除，但它们要吃到本帧的 dt，越早算越准；
    // 后面 6~9 趟 `renderer.render` 复用同一份矩阵与顶点。
    // 先刷新相机世界矩阵：保证后续 entityExtras、spotBeams、可见性与排序读到本帧最新位姿
    // （`scene.matrixWorldAutoUpdate` 在构造函数里已关闭）。
    this.camera.updateMatrixWorld();
    const extrasAnimating =
      this.laserBeams !== null || this.particleSystems !== null || this.entityExtras !== null;
    if (this.textureScrolls.length > 0 || this.rotButtons.length > 0 || extrasAnimating) {
      const dt = this.lastFrameAt > 0 ? Math.min(0.1, (frameNow - this.lastFrameAt) / 1000) : 0;
      this.lastFrameAt = frameNow;
      // 首帧给一个固定小步长（与旧 debug 实现一致：1/64 秒），避免 dt=0 时激光/粒子不推进。
      const animDt = dt > 0 ? dt : 1 / 64;
      if (this.textureScrolls.length > 0) updateTextureScrolls(this.textureScrolls, dt);
      if (this.rotButtons.length > 0) updateRotButtons(this.rotButtons, dt);
      if (this.laserBeams) this.laserBeams.update(animDt, this.camera);
      if (this.particleSystems) this.particleSystems.update(animDt, this.camera);
      // 资产实体图元（sprite/文字/beam）是屏幕朝向的：相机一动就要重写四边形顶点。
      if (this.entityExtras) {
        this.entityExtras.update(this.camera, activePvs);
      }
    }
    this.dynamicAmbient.update(this.pvs, frameNow);
    (this.spotBeams?.userData.rig as SpotBeamRig | undefined)?.updateOcclusion(this.camera, this.laserPhysTrace, frameNow, activePvs);
    // 动态对象（旋钮 pivot 等）刚改过变换：本帧在这里刷新一次世界矩阵，后面 6~9 趟
    // `renderer.render` 直接复用（`scene.matrixWorldAutoUpdate` 在构造函数里关掉了）。
    this.scene.updateMatrixWorld();
    mark('mat');
    if (opts.updateVisibility !== false) {
      this.updateVisibility();
      mark('vis');
    } else if (dbgOn) {
      times.vis = this.lastVisMs;
      this.lastVisMs = 0;
      tLast = performance.now();
    }
    if (this.pvsOverlay.enabled) this.pvsOverlay.update(this.root, this.pvs, this.camera.position);
    if (opts.updateNearPlane !== false && this.root) {
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
    mark('near');
    const sorterPvs =
      this.visibility.enablePvs && this.pvs && this.pvs.enabled && (cullAll || this.lastVisibility?.pvsClusterValid !== false)
        ? this.pvs
        : null;
    this.sorter.update(this.camera, sorterPvs, cullAll ? -999 : (this.lastVisibility?.clusterAtCamera ?? -1));
    mark('sort');
    // 水面折射/深度 RT：必须在主渲染**之前**的干净上下文渲染（T-650 v4：原先嵌套在
    // 水面 onBeforeRender 里，嵌套 render 状态被外层半途状态污染且随视角变化，§12.9）。
    renderWaterFramePasses(this.renderer, this.scene, this.camera, this.frameCtx);
    mark('water');
    // 泛光：场景先画进半浮点缓冲（天空两遍法也画进去），再统一合成到画布。
    // 没有 bloomFx（强度 0 / 上下文不支持）时走原来的直画路径。
    this.skyFog = renderSkyPass({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      skyCamera: this.skyCamera,
      skyGroup: this.skyGroup,
      skyParams: this.skyParams,
      skyFog: this.skyFog,
    });
    const bloom = this.ensureBloomFx();
    if (bloom) {
      // 主画面已直画完；这里只把加色光效单独渲到黑底缓冲，模糊后**加法叠加**回去。
      // 粒子/激光由各端在装配之后挂进 scene（晚于载图），仅在场景结构变更时重扫。
      if (this.glowDirty || this.scene.children.length !== this.glowSceneChildCount) {
        this.glowDirty = false;
        this.glowSceneChildCount = this.scene.children.length;
        this.glowMeshes.length = 0;
        const marked = markGlowMeshes(this.scene, this.glowMeshes);
        if (marked !== this.glowMarked) {
          this.glowMarked = marked;
          (globalThis as { __vbspGlowMarked?: number }).__vbspGlowMarked = marked;
          console.info(`[${this.app}][bloom] 加色光效 mesh：${marked} 个`);
        }
      }
      bloom.renderGlow(this.scene, this.camera, this.glowMeshes);
      bloom.overlay();
    }
    mark('sky');
    if (dbgOn) {
      times.frame = +(performance.now() - tFrame).toFixed(2);
      (globalThis as { __vbspDraws?: unknown }).__vbspDraws = {
        total: this.renderer.info.render.calls,
        tris: this.renderer.info.render.triangles,
        programs: this.renderer.info.programs?.length ?? 0,
        textures: this.renderer.info.memory.textures,
        geometries: this.renderer.info.memory.geometries,
        times,
      };
      // 逐帧环形日志（最近 600 帧）：抓「偶发长帧」用——轮询只会看到中位数，看不到尖峰。
      // 用法：`__vbspDrawDebug={on:true}` 跑一段，之后在控制台读 `__vbspFrameLog`。
      const g = globalThis as { __vbspFrameLog?: Array<Record<string, number>> };
      const log = g.__vbspFrameLog ?? (g.__vbspFrameLog = []);
      log.push(times);
      if (log.length > 600) log.splice(0, log.length - 600);
    }
    const frameCpuMs = performance.now() - tBudget;
    // 供水面 RT 的「按预算跳过」判断用：上一帧的整帧 CPU 成本与 rAF 帧间隔（都含本帧之前的信息）。
    // 每帧都写，不依赖调试开关。`__vbspLastFrameDtMs` = 上一帧起点到本帧起点的墙钟间隔，
    // >4.8ms 说明上一帧漏了槽（单槽 3.125ms），这一帧适合把可选的整场景 pass 让出来。
    // `__vbspLastFrameMs` 不在本卡收口范围（预算兜底的基准成本，只此一处写、只此一处读）。
    const gLast = globalThis as { __vbspLastFrameMs?: number };
    gLast.__vbspLastFrameMs = frameCpuMs;
    // T-P2-1：dt 与等级走上下文（updateFrameBudget 的 write() 更新 `frameCtx.budgetLevel`），
    // 帧末再镜像旧的全局键 + `__vbspDebug` 供外部诊断（只写）。
    this.frameCtx.lastFrameDtMs = budgetDt;
    this.budget.update(frameCpuMs, budgetDt, this.frameCtx);
    mirrorFrameContext(this.frameCtx);
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

  /**
   * 存档/面板给的「视距」有效值：0、非有限值、或超过地图对角线（`maxDim`）都按「自动档」处理。
   *
   * 超过地图尺寸的距离物理上等价于「不按距离剔除」，但旧版本会把它当显式值直接采用；
   * 早前 A/B 留下的 200000 / 8156 就会一直压着默认距离场（表现为默认档不是 18000）。
   */
  cullConfigValue(dist: number): number {
    return Number.isFinite(dist) && dist > 0 && dist <= this.maxDim ? dist : 0;
  }

  /**
   * 面板/配置改剔除距离（0 = 自动：PVS 开时为 `CULL_DISTANCE_PVS_DEFAULT`（18000）的距离场，
   * PVS 关时为 `maxDim×0.25`）；返回生效值。
   *
   * 距离场与 PVS **同时生效**：场外的块不画、也不进 PVS 判定；场内的块由 PVS 决定。
   */
  setCullDistance(dist: number): number {
    const auto = this.visibility.enablePvs ? CULL_DISTANCE_PVS_DEFAULT : this.maxDim * 0.25;
    this.visibility.autoCullDistance = auto;
    return this.visibility.setCullDistance(auto, this.cullConfigValue(dist));
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

  /**
   * 调试面板「vhv 线性（去伽马）」：决定 prop 逐顶点烘焙项是否先 `pow(2.2)`。
   * 只改共享 uniform，下一次绘制即生效（不重编译材质）。
   */
  setVhvLinear(on: boolean): void {
    if (getVhvLinear() === on) return;
    setVhvLinearInShader(on);
    console.info(`[${this.app}][lighting] vhv 伽马处理 → ${on ? 'gamma-space（直接乘）' : 'linear（pow 2.2）'}`);
  }

  /** 读 vhv 伽马处理。 */
  getVhvLinear(): boolean {
    return getVhvLinear();
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

  /** 诊断：主根（PVS 作用域）之外的可见 mesh 数 / 最远距离 / 前几个名字。 */
  sceneOutsideRootStats(): { meshes: number; maxDist: number; sample: string[] } {
    return { meshes: 0, maxDist: 0, sample: [] };
  }

  /** 诊断集合的只读现场（T-P2-2c：诊断实现已搬到 `chunk-diagnostics.ts`）。 */
  private diagHost(): ChunkDiagnosticsHost {
    return { camera: this.camera, root: this.root, pvs: this.pvs, visibility: this.visibility };
  }

  /**
   * 诊断：逐块审计（谁在画、离多远、有几个 cluster、PVS 怎么判的）。
   * `clusters === 0` 的块**不参与 PVS 剔除**（`update` 里要求 `clusterIds.length > 0` 才剔），
   * 只要落在距离档内就无条件画——「PVS 区域外还有东西」先查这一类。
   */
  chunkAudit(limit = 40): {
    cull: number;
    total: number;
    drawn: number;
    noCluster: number;
    pvsActive: boolean;
    far: Array<{ name: string; d: number; r: number; boxD: number | null; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number }>;
    nearCulled: Array<{ idx: number; name: string; d: number; r: number; clusters: number; pvsVisible: boolean | null; tris: number }>;
  } {
    return auditChunks(this.diagHost(), limit);
  }

  /**
   * 诊断：块级并集到底放进来多少「来自不可见 cluster」的三角形。
   *
   * 语义背景：一个合并块可以横跨多个房间（`clusterIds` 有多个），运行期只要**任一个**
   * cluster 在可见集里就整块画 ⇒ 别的房间的三角形跟着出来，这是「看得见才画」的粒度上限。
   * 这里逐三角形质心 → BSP leaf → cluster，统计每块里 PVS 判不可见的占比，
   * 给出「块级并集」实际泄漏量的直接证据（质心采样，不是精确面积）。
   */
  chunkLeak(limit = 20): {
    pvsActive: boolean;
    sampled: number;
    leaked: number;
    farLeaked: number;
    chunks: Array<{ name: string; tris: number; sampled: number; leaked: number; farLeaked: number; clusters: number }>;
  } {
    return leakChunks(this.diagHost(), limit);
  }

  /**
   * 诊断：几何真值——从相机朝该块的最近顶点射一条线，看**第一个挡住它的是谁**。
   * `sameChunk: true` 就说明「这块肉眼可见却被剔了」＝PVS 判错（先用它区分 PVS 误剔与单纯背对相机）。
   */
  rayCheck(idx: number): { name: string; chunkVisible: boolean; sameChunk: boolean; hitName: string; hitDist: number; targetDist: number } | null {
    return rayCheckChunk(this.diagHost(), idx);
  }

  /**
   * 诊断：视锥网格射线审计——「眼前这一片，第一眼看到的东西里有多少是被剔掉的块」。
   * 这是 PVS 误剔的**像素级真值**：`culledFirst` 就是「本该画却没了」的采样点，
   * 比看截图快，也不需要知道相机朝向。
   */
  frustumAudit(sx = 40, sy = 24): { rays: number; hits: number; culledFirst: number; samples: Array<{ name: string; d: number; clusters: number; pvsVisible: boolean | null }> } {
    return auditFrustum(this.diagHost(), sx, sy);
  }

  /**
   * 诊断：PVS 判定链路的现场快照——相机在哪个 leaf/cluster、可见集多大、
   * 最近 N 个块的 cluster 集合里是否含相机 cluster（不含才是「看不见自己所在房间」的真因）。
   */
  pvsInfo(limit = 8): {
    camera: number[];
    clusterAtCamera: number;
    current: number;
    visible: number;
    total: number;
    selfVisible: boolean | null;
    nearest: Array<{ name: string; d: number; clusters: number[]; hasCamera: boolean; visible: boolean }>;
  } | null {
    return pvsSnapshot(this.diagHost(), limit);
  }

  /** 诊断：屏幕某点（NDC）射线打中的第一个块，及其 cluster / 可见性——「眼前这面墙到底被谁剔了」。 */
  pickAt(ndcX = 0, ndcY = 0): { idx: number; name: string; d: number; clusters: number[]; cameraCluster: number; hasCamera: boolean; pvsVisible: boolean | null; visible: boolean; mat: string; matTransparent: boolean; matMap: string; matWater: boolean; srcMesh: string; srcFace: number | null; srcTri: number } | null {
    return pickChunkAt(this.diagHost(), ndcX, ndcY);
  }

  /**
   * 诊断：某个块（按索引）的 cluster 采样明细——每个顶点落到哪个 cluster、多少落进固体、
   * 以及**离相机最近的顶点们**分别落在哪个 cluster。
   *
   * 用途：缺墙时判断「块里靠相机那部分的顶点根本没采到房间 cluster」还是「采到了但 PVS 不认」。
   */
  chunkClusterDetail(idx: number, nearHU = 600): {
    name: string;
    tris: number;
    verts: number;
    solid: number;
    clusters: Array<{ c: number; n: number }>;
    nearVerts: Array<{ d: number; c: number }>;
    center: [number, number, number];
    radius: number;
    matrixBaked: boolean;
  } | null {
    return chunkClusterSample(this.diagHost(), idx, nearHU);
  }

  /** 诊断：按名字查块级可见性（「这个模型到底是被剔了还是没画」）。 */
  probeChunk(name: string): { name: string; found: number; d: number; r: number; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number; collider: boolean } | null {
    return probeChunkByName(this.diagHost(), name);
  }

  /** 诊断：主根内「当前被绘制」的块按距离分桶（判断 PVS 是否把很远的东西也留着）。 */
  drawnChunkStats(): { drawn: number; buckets: Record<string, number>; far: string[] } {
    return drawnChunkStats(this.diagHost());
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
      rev: RENDER_REV,
      reasons: r?.reasons ?? { pvs: 0, distance: 0 },
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
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.disposeScene();
    this.bloomFx?.dispose();
    this.bloomFx = null;
    this.renderer.dispose();
  }

  /** 主模型分块合并：三端唯一包装（新根口径；旧的 game/debug 原地挂回已废弃）。 */
  private mergeMain(root: THREE.Scene): THREE.Object3D {
    // T-P2-2c：合并流水线搬到 `merge-main.ts`（顺序即契约，详见该文件头）。
    const res = mergeMainRoots(root, {
      translucentSplit: this.translucentSplit,
      dynamicEntityIndices: this.pendingDynamicEntityIndices,
      app: this.app,
    });
    // 开关关闭时 `dynGroups` 为 null：保持会话里原有的表（原实现同样不改写）。
    if (res.dynGroups) this.dynGroups = res.dynGroups;
    return res.root;
  }

  /** 判某个 mesh 是否落在指定 BSP cluster（包围盒中心 + 6 个 ±r 轴点；全仓唯一实现）。 */
  private meshInCluster(mesh: THREE.Mesh, cluster: number): boolean {
    if ((mesh.userData as { __vbspSkyInstanced?: boolean }).__vbspSkyInstanced === true) return true;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return false;
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
