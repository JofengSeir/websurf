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
import { lookupMergeSource, mergeIntoNewRoot, mergeStatsOf, type MergeStats } from './scene-optimizer.js';
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
 * 排查「现象还在」时先看它——不一致就说明浏览器跑的是旧包（Service Worker / 磁盘缓存），
 * 别在旧构建上做判断。改渲染语义时顺手递增。
 */
export const RENDER_REV = '2026-11-13.9-face-normal-cluster';

/** 泄漏采样时沿面法线外推的距离（HU）：面本身是边界，重心必然贴着 brush。 */
const CLUSTER_LEAK_PROBE_PUSH = [4, 16, 64, 192] as const;
import {
	getLightingMode,
	setLightingMode as setLightingModeInShader,
	smoothVertexLighting,
	setVhvLinear as setVhvLinearInShader,
	getVhvLinear,
	setSpotLights,
	setDLights,
	type SpotLightInput,
	type LightingMode,
} from '../shader/lightmap-shader.js';
import { PvsManager } from '../../ts-shared/world/pvs-manager.js';
import { subdivideVertexLit } from './vlight-subdivide.js';
import { collectTextureScrolls, updateTextureScrolls, type TextureScrollEntry } from '../shader/texture-scroll.js';
import { setupRotButtons, updateRotButtons, type RotButtonPivot } from './rot-buttons.js';
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
  /** 主模型根（`mergeIntoNewRoot` 的产物；未合并时是 `assembleScene` 的 mapRoot）。 */
  private root: THREE.Object3D | null = null;
  /** 声明了 Source `TextureScroll` 的共享贴图（装配后收集一次，见 `frame()`）。 */
  private textureScrolls: TextureScrollEntry[] = [];
  /** 上一帧时间戳（毫秒）：给 `TextureScroll` 算 `dt`。 */
  private lastFrameAt = 0;
  /** `momentary_rot_button` 实体（符文盘等）的 pivot；空 = 本图没有旋转实体。 */
  private rotButtons: RotButtonPivot[] = [];
  /** 主根里的半透明块（每帧按相机距离重排 `renderOrder`，见 `sortTransparentChunks`）。 */
  private transparentChunks: THREE.Mesh[] = [];
  private readonly transparentSortBox = new THREE.Box3();
  private readonly transparentSortPoint = new THREE.Vector3();
  /** 上次半透明排序时的相机位置与可见集指纹；用于「没动就别排」。 */
  private readonly transparentSortLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private transparentSortLastHash = 0;
  private transparentSortLastVisible = -1;
  /** 天空层：第二相机 + 只挂 `SKY_LAYER` 的图元组。 */
  private skyCamera: THREE.PerspectiveCamera | null = null;
  private skyGroup: THREE.Group | null = null;
  /** spot 光源的可见光柱（`point_spotlight`）；null = 本图没有 spot。 */
  private spotBeams: THREE.Group | null = null;
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
  /** 上一帧标进泛光层的加色 mesh（供 `renderGlow` 的深度预渲跳过它们）。 */
  private readonly glowMeshes: THREE.Object3D[] = [];
  /**
   * bloom 光效层的**静态深度代理**：建图后把实体几何合并成一张网格（1 次 draw），
   * 替代每帧「整场景只写深度」的 400+ 次 draw。null = 退回旧的整场景预渲。
   */
  private glowDepthProxy: THREE.Mesh | null = null;

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
    // 合并后的块把顶点烘焙成世界坐标、local 矩阵清成单位阵，但 `matrixWorld` 要等一次
    // updateMatrixWorld 才会跟上（mergeIntoChunks 里只调了 `m.updateMatrix()`，从未刷新
    // matrixWorld；`renderer.compile` 也不刷）。PVS 采样按 `mesh.matrixWorld` 把几何点变换到
    // 世界空间，这里若拿到旧矩阵就是**二次变换**：cluster 非空但全错，且因为「非空」连
    // 「空集合补算」都救不回来 —— 2026-11-13 owner 报的「冰坡透明材质消失 / 666 窗外又露出
    // 别区结构」就是这一条（同一个错映射既可能误剔、也可能误留）。必须先刷矩阵再收集。
    this.root.updateMatrixWorld(true);
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

    // 静态矩阵冻结：到这一步场景里的对象（世界块、天空盒、光柱）已经全部挂好、矩阵已刷新，
    // 之后只有「旋钮 pivot 每帧转」和运行期才挂的粒子/激光会动。逐帧 `scene.updateMatrixWorld()`
    // 是 tick 的第二大 JS 开销（飞行回放 CPU 采样 9.6%）：把不再移动的对象置
    // `matrixAutoUpdate=false`，每帧只遍历、不做矩阵乘；pivot 的 rotation 变化仍会以 force
    // 传给子节点，位置照常生效。
    this.scene.updateMatrixWorld(true);
    this.freezeStaticMatrices();

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
      ? prepareClusterIndex(this.visibility.items, this.pvs, 64)
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
    this.scene.traverse((obj) => {
      if (obj.userData.vbspRotPivot === true) return;
      obj.matrixAutoUpdate = false;
      frozen++;
    });
    (globalThis as { __vbspStaticFrozen?: number }).__vbspStaticFrozen = frozen;
    return frozen;
  }

  /** 换图/卸载：释放根、天空组、环境与渲染列表；renderer/scene/camera 本身复用。 */
  disposeScene(): void {
    // 滚动贴图是旧根的贴图对象，disposeScene 后不能再推进（会写已释放的贴图）。
    this.textureScrolls = [];
    // pivot 是旧根的子树（mesh 已被 disposeObject 释放），清空引用即可。
    this.rotButtons = [];
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
    this.pvsOverlay.reset();
    this.lastVisibility = null;
    this.nearCheckToggle = false;
    // 深度代理是主根的合并副本，换图后必须释放（几何可能几十 MB）。
    this.applyGlowDepthProxy(null);
  }

  /** 只做可见性判定（debug 的按需渲染需要在决定是否出帧前先知道有无变化）。 */
  updateVisibility(): VisibilityUpdateResult {
    // 档即开关：面板/深链改 `culling.pvs` 后下一帧生效。
    // 区域着色开启时强制关掉 PVS 剔除——否则「不可见的区域」根本不会被画出来，就看不到对照。
    this.visibility.enablePvs = this.pvsOverride ?? (!this.pvsOverlay.enabled && readRenderPrefs().culling.pvs);
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
      this.clusterIndex = prepareClusterIndex(this.visibility.items, this.pvs, 64);
      this.visibility.chunkIndexActive = this.clusterIndex.prepared > 0;
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
      if (camClusterValid && camCluster >= 0 && !camInSolid) {
        applyClusterIndex(this.visibility.items, this.pvs, camCluster);
        this.pvsIndexActive = true;
      } else if (this.pvsIndexActive) {
        // 相机嵌在实体里（或根本定位不到房间）：这一帧不按任何 PVS 行裁三角形，先还原全量。
        // 穿透视角下隔壁房间的 PVS 行不包含「隔墙可见」的面，按它裁就会切出一块块三角破洞。
        restoreClusterIndex(this.visibility.items);
        this.pvsIndexActive = false;
      }
    } else if (this.pvsIndexActive) {
      // 关 PVS（面板/深链/区域着色）后必须把裁过的 index 还原：`applyClusterIndex` 只认相机 cluster，
      // 不会因为开关关掉就把墙补回来；不还原就是「PVS 关了、缺的那块还在」。
      restoreClusterIndex(this.visibility.items);
      this.visibility.chunkIndexActive = false;
      this.pvsIndexActive = false;
    }
    this.updateSpotLights();
    return this.lastVisibility;
  }

  /**
   * 每帧挑选「离相机最近的 8 盏 spot」送进 lightmap 注入的 uniform。
   *
   * 为什么不是全部：世界材质共享同一套 uniform，`KHR_lights_punctual` 在本图有 57 盏 spot
   * （其余 2000+ 是 point，不参与这里）；只按距离取前 8 盏，既够覆盖视野，又不会让
   * uniform 数组无限膨胀。
   */
  private updateSpotLights(): void {
    const spots = this.spotBeams?.userData.spots as
      | {
          position: [number, number, number];
          direction: [number, number, number];
          color: [number, number, number];
          intensity: number;
          range: number;
          innerConeAngle: number;
          outerConeAngle: number;
        }[]
      | undefined;
    if (!spots || spots.length === 0) {
      setSpotLights([]);
      return;
    }
    const cam = this.camera.position;
    const ranked = spots
      .map((s) => {
        const dx = s.position[0] - cam.x;
        const dy = s.position[1] - cam.y;
        const dz = s.position[2] - cam.z;
        return { s, d2: dx * dx + dy * dy + dz * dz };
      })
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, 8)
      .map(({ s }) => ({
        position: s.position,
        direction: s.direction,
        color: s.color,
        intensity: s.intensity,
        range: s.range,
        cosOuter: Math.cos(s.outerConeAngle),
        cosInner: Math.cos(s.innerConeAngle),
      }) satisfies SpotLightInput);
    setSpotLights(ranked);
    // 命中点的 dlight：宽而软的光斑，按距离取最近 2 个。
    const dlights = this.spotBeams?.userData.dlights as
      | { position: [number, number, number]; color: [number, number, number]; range: number }[]
      | undefined;
    if (dlights && dlights.length > 0) {
      const rankedD = dlights
        .map((d) => {
          const dx = d.position[0] - cam.x;
          const dy = d.position[1] - cam.y;
          const dz = d.position[2] - cam.z;
          return { d, d2: dx * dx + dy * dy + dz * dz };
        })
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, 2)
        .map(({ d }) => d);
      setDLights(rankedD);
    } else {
      setDLights([]);
    }
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
    // Source `TextureScroll` / `momentary_rot_button`：按真实时间推进。
    // 放在可见性之前：滚动/旋转不影响剔除，但它们要吃到本帧的 dt，越早算越准。
    if (this.textureScrolls.length > 0 || this.rotButtons.length > 0) {
      const now = performance.now();
      const dt = this.lastFrameAt > 0 ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 0;
      this.lastFrameAt = now;
      if (this.textureScrolls.length > 0) updateTextureScrolls(this.textureScrolls, dt);
      if (this.rotButtons.length > 0) updateRotButtons(this.rotButtons, dt);
    }
    // 动态对象（旋钮 pivot 等）刚改过变换：本帧在这里刷新一次世界矩阵，后面 6~9 趟
    // `renderer.render` 直接复用（`scene.matrixWorldAutoUpdate` 在构造函数里关掉了）。
    this.scene.updateMatrixWorld();
    mark('mat');
    if (opts.updateVisibility !== false) this.updateVisibility();
    mark('vis');
    if (this.pvsOverlay.enabled) this.pvsOverlay.update(this.root, this.pvs, this.camera.position);
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
    mark('near');
    this.sortTransparentChunks(this.camera);
    mark('sort');
    // 水面折射/深度 RT：必须在主渲染**之前**的干净上下文渲染（T-650 v4：原先嵌套在
    // 水面 onBeforeRender 里，嵌套 render 状态被外层半途状态污染且随视角变化，§12.9）。
    renderWaterFramePasses(this.renderer, this.scene, this.camera);
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
      // 粒子/激光由各端在装配之后挂进 scene（晚于载图），所以每帧幂等标记一次。
      // 深度预渲需要知道哪些 mesh 是光效本身（避免透明层互相写深度），故同时收集到数组。
      this.glowMeshes.length = 0;
      const marked = markGlowMeshes(this.scene, this.glowMeshes);
      if (marked !== this.glowMarked) {
        this.glowMarked = marked;
        (globalThis as { __vbspGlowMarked?: number }).__vbspGlowMarked = marked;
        console.info(`[${this.app}][bloom] 加色光效 mesh：${marked} 个`);
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
    const p = this.camera.position;
    const items = this.visibility.items;
    const pvsActive = !!(this.visibility.enablePvs && this.pvs?.enabled);
    const all: Array<{ name: string; d: number; r: number; boxD: number | null; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number }> = [];
    const nearCulled: Array<{ idx: number; name: string; d: number; r: number; clusters: number; pvsVisible: boolean | null; tris: number }> = [];
    let drawn = 0;
    let noCluster = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
      const tris = g?.index ? g.index.count / 3 : (g?.getAttribute('position')?.count ?? 0) / 3;
      const d = item.center.distanceTo(p);
      if (item.clusterIds.length === 0) noCluster++;
      const pvsVisible = item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => this.pvs?.isVisible(c) ?? false);
      if (!item.mesh.visible) {
        // 近处被剔的块 = 「本该出现在眼前却没了」的头号嫌疑（缺墙 / 玻璃消失）。
        if (d < 8000) {
          nearCulled.push({ idx: i, name: item.mesh.name || '(anon)', d: Math.round(d), r: Math.round(item.radius), clusters: item.clusterIds.length, pvsVisible, tris: Math.round(tris) });
        }
        continue;
      }
      drawn++;
      all.push({
        name: item.mesh.name || '(anon)',
        d: Math.round(d),
        r: Math.round(item.radius),
        boxD: item.box ? Math.round(item.box.distanceToPoint(p)) : null,
        clusters: item.clusterIds.length,
        pvsVisible,
        visible: true,
        tris: Math.round(tris),
      });
    }
    all.sort((a, b) => b.d - a.d);
    nearCulled.sort((a, b) => a.d - b.d);
    return { cull: this.visibility.cullDistance, total: items.length, drawn, noCluster, pvsActive, far: all.slice(0, limit), nearCulled: nearCulled.slice(0, limit) };
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
    const empty = { pvsActive: false, sampled: 0, leaked: 0, farLeaked: 0, chunks: [] };
    const pvs = this.pvs;
    if (!this.visibility.enablePvs || !pvs) return empty;
    const out = { pvsActive: true, sampled: 0, leaked: 0, farLeaked: 0, chunks: [] as Array<{ name: string; tris: number; sampled: number; leaked: number; farLeaked: number; clusters: number }> };
    const cam = this.camera.position;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const item of this.visibility.items) {
      if (!item.mesh.visible) continue;
      // 单 cluster 的块过去被跳过（那时它不可能「半块泄漏」）。拆分之后正好相反：绝大多数
      // 画着的块都是单 cluster 片，必须一起采样，否则这个指标看不出「拆分是否真的精确」。
      if (item.clusterIds.length === 0) continue;
      const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
      const pos = g?.getAttribute('position') as THREE.BufferAttribute | undefined;
      const index = g?.index ?? null;
      if (!pos) continue;
      // 合并块有两种：带 index 的（多材质 groups）与不带 index 的（单材质）。两种都要能采样。
      // 逐三角形过滤的块只画 `drawRange` 里的三角形：采样必须跟着 drawRange，否则会把
      // 「已经裁掉、根本没画」的三角形算成泄漏，指标直接失真（曾把 15% 的精确过滤读成 89%）。
      const total = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
      const drawnTris = g && g.drawRange.count !== Infinity
        ? Math.min(total, Math.floor(g.drawRange.count / 3))
        : total;
      const tris = drawnTris;
      if (tris === 0) continue;
      const matrix = item.mesh.matrixWorld;
      const stride = Math.max(1, Math.ceil(tris / 48));
      let sampled = 0;
      let leaked = 0;
      let farLeaked = 0;
      for (let t = 0; t < tris; t += stride) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);
        // 面法线：三角形重心**落在表面上**，直接查 leaf 会经常落进 brush 内部（cluster -1），
        // 那是判据噪声不是泄漏。按法线往外推几档再查，才是「这个面朝向的那间房」。
        a.add(b).add(c).multiplyScalar(1 / 3);
        const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
        const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        a.applyMatrix4(matrix);
        let cluster = -1;
        for (const push of CLUSTER_LEAK_PROBE_PUSH) {
          const px = a.x + nx * push, py = a.y + ny * push, pz = a.z + nz * push;
          cluster = pvs.getClusterAt({ x: px, y: py, z: pz });
          if (cluster >= 0) break;
          const bx = a.x - nx * push, by = a.y - ny * push, bz = a.z - nz * push;
          cluster = pvs.getClusterAt({ x: bx, y: by, z: bz });
          if (cluster >= 0) break;
        }
        if (cluster < 0) continue; // 两侧都采不到房间（纯内部面），不参与判定
        sampled++;
        if (pvs.isVisible(cluster)) continue;
        leaked++;
        if (a.distanceTo(cam) > 12000) farLeaked++;
      }
      out.sampled += sampled;
      out.leaked += leaked;
      out.farLeaked += farLeaked;
      if (leaked > 0) out.chunks.push({ name: item.mesh.name || '(anon)', tris, sampled, leaked, farLeaked, clusters: item.clusterIds.length });
    }
    out.chunks.sort((x, y) => y.leaked - x.leaked);
    out.chunks.splice(limit);
    return out;
  }

  /**
   * 诊断：几何真值——从相机朝该块的最近顶点射一条线，看**第一个挡住它的是谁**。
   * `sameChunk: true` 就说明「这块肉眼可见却被剔了」＝PVS 判错（先用它区分 PVS 误剔与单纯背对相机）。
   */
  rayCheck(idx: number): { name: string; chunkVisible: boolean; sameChunk: boolean; hitName: string; hitDist: number; targetDist: number } | null {
    const item = this.visibility.items[idx];
    if (!item || !this.root) return null;
    const cam = this.camera.position;
    const g = item.mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const m = new THREE.Matrix4();
    item.mesh.updateWorldMatrix(true, false);
    m.copy(item.mesh.matrixWorld);
    const v = new THREE.Vector3();
    const best = new THREE.Vector3();
    let bestD = Infinity;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const d = v.distanceToSquared(cam);
      if (d < bestD) { bestD = d; best.copy(v); }
    }
    if (!Number.isFinite(bestD)) return null;
    const dir = best.clone().sub(cam);
    const targetDist = dir.length();
    if (targetDist < 1e-3) return null;
    dir.divideScalar(targetDist);
    const rc = new THREE.Raycaster(cam.clone(), dir, 0.1, targetDist + 50);
    const hits = rc.intersectObject(this.root!, true);
    const first = hits.find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
    return {
      name: item.mesh.name || '(anon)',
      chunkVisible: item.mesh.visible,
      sameChunk: !!first && first.object === item.mesh,
      hitName: first ? ((first.object as THREE.Mesh).name || '(anon)') : '(nothing)',
      hitDist: first ? Math.round(first.distance) : -1,
      targetDist: Math.round(targetDist),
    };
  }

  /**
   * 诊断：视锥网格射线审计——「眼前这一片，第一眼看到的东西里有多少是被剔掉的块」。
   * 这是 PVS 误剔的**像素级真值**：`culledFirst` 就是「本该画却没了」的采样点，
   * 比看截图快，也不需要知道相机朝向。
   */
  frustumAudit(sx = 40, sy = 24): { rays: number; hits: number; culledFirst: number; samples: Array<{ name: string; d: number; clusters: number; pvsVisible: boolean | null }> } {
    const out = { rays: 0, hits: 0, culledFirst: 0, samples: [] as Array<{ name: string; d: number; clusters: number; pvsVisible: boolean | null }> };
    if (!this.root) return out;
    const byMesh = new Map<THREE.Object3D, number>();
    for (let i = 0; i < this.visibility.items.length; i++) byMesh.set(this.visibility.items[i].mesh, i);
    const cam = this.camera;
    const rc = new THREE.Raycaster();
    rc.far = 60000;
    const ndc = new THREE.Vector2();
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        ndc.set(((x + 0.5) / sx) * 2 - 1, -(((y + 0.5) / sy) * 2 - 1));
        rc.setFromCamera(ndc, cam);
        out.rays++;
        const hits = rc.intersectObject(this.root, true);
        const first = hits.find((h) => (h.object as THREE.Mesh).isMesh);
        if (!first) continue;
        out.hits++;
        const obj = first.object as THREE.Mesh;
        if (obj.visible) continue;
        const idx = byMesh.get(obj);
        if (idx === undefined) continue;
        const item = this.visibility.items[idx];
        out.culledFirst++;
        if (out.samples.length < 12) {
          out.samples.push({
            name: obj.name || '(anon)',
            d: Math.round(first.distance),
            clusters: item.clusterIds.length,
            pvsVisible: item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => this.pvs?.isVisible(c) ?? false),
          });
        }
      }
    }
    return out;
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
    if (!this.pvs) return null;
    const p = this.camera.position;
    const at = this.pvs.getClusterAt({ x: p.x, y: p.y, z: p.z });
    const st = this.pvs.getStats();
    const near = this.visibility.items
      .map((it) => ({ it, d: it.center.distanceTo(p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ it, d }) => ({
        name: it.mesh.name || '(anon)',
        d: Math.round(d),
        clusters: it.clusterIds.slice(0, 8),
        hasCamera: it.clusterIds.includes(at),
        visible: it.mesh.visible,
      }));
    return {
      camera: [p.x, p.y, p.z].map(Math.round),
      clusterAtCamera: at,
      current: st.currentCluster,
      visible: st.visibleCount,
      total: st.totalClusters,
      selfVisible: at >= 0 ? this.pvs.isVisible(at) : null,
      nearest: near,
    };
  }

  /** 诊断：屏幕某点（NDC）射线打中的第一个块，及其 cluster / 可见性——「眼前这面墙到底被谁剔了」。 */
  pickAt(ndcX = 0, ndcY = 0): { idx: number; name: string; d: number; clusters: number[]; cameraCluster: number; hasCamera: boolean; pvsVisible: boolean | null; visible: boolean; mat: string; matTransparent: boolean; matMap: string; matWater: boolean; srcMesh: string; srcFace: number | null; srcTri: number } | null {
    if (!this.root) return null;
    const rc = new THREE.Raycaster();
    rc.far = 60000;
    rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hits = rc.intersectObject(this.root, true);
    const first = hits.find((h) => (h.object as THREE.Mesh).isMesh);
    if (!first) return null;
    const obj = first.object as THREE.Mesh;
    const idx = this.visibility.items.findIndex((it) => it.mesh === obj);
    const item = idx >= 0 ? this.visibility.items[idx] : null;
    const p = this.camera.position;
    const camCluster = this.pvs ? this.pvs.getClusterAt({ x: p.x, y: p.y, z: p.z }) : -1;
    const clusters = item ? item.clusterIds : [];
    // 材质名 + 是否透明：用来区分「被剔了」和「画了但材质/贴图不对」（两种现象看起来都是「空的」）。
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const g = first.face?.materialIndex ?? 0;
    const mat = mats[Math.min(g, mats.length - 1)] as THREE.Material | undefined;
    // 来源面：合并块本身无名，按 faceIndex 反查区间表 → 来源 glTF 网格名 + BSP 面号（extras.faceIndex）。
    const src = lookupMergeSource(obj.geometry, first.faceIndex);
    const srcTri = src && first.faceIndex != null ? Math.floor((first.faceIndex * 3 - src.start) / 3) : -1;
    return {
      idx,
      name: obj.name || '(anon)',
      d: Math.round(first.distance),
      clusters: clusters.slice(0, 12),
      cameraCluster: camCluster,
      hasCamera: clusters.includes(camCluster),
      pvsVisible: item ? (clusters.length === 0 ? null : clusters.some((c) => this.pvs?.isVisible(c) ?? false)) : null,
      visible: obj.visible,
      mat: mat?.name || '(unnamed)',
      matTransparent: mat?.transparent ?? false,
      matMap: (mat as THREE.MeshBasicMaterial | undefined)?.map?.name || '(nomap)',
      matWater: (mat?.userData as { vbsp_water?: unknown } | undefined)?.vbsp_water != null,
      srcMesh: src?.meshName || '(unknown)',
      srcFace: src?.faceIndex ?? null,
      srcTri,
    };
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
    const item = this.visibility.items[idx];
    if (!item || !this.pvs) return null;
    const mesh = item.mesh;
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const nrm = geom.attributes.normal;
    const cam = this.camera.position;
    const counts = new Map<number, number>();
    const nearVerts: Array<{ d: number; c: number }> = [];
    const v = new THREE.Vector3();
    let solid = 0;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nrm) v.addScaledVector(new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)), 4);
      v.applyMatrix4(mesh.matrixWorld);
      const c = this.pvs.getClusterAt({ x: v.x, y: v.y, z: v.z });
      if (c < 0) solid++;
      else counts.set(c, (counts.get(c) ?? 0) + 1);
      const d = v.distanceTo(cam);
      if (d <= nearHU) nearVerts.push({ d: Math.round(d), c });
    }
    const clusters = [...counts.entries()].map(([c, n]) => ({ c, n })).sort((a, b) => b.n - a.n).slice(0, 12);
    nearVerts.sort((a, b) => a.d - b.d);
    const m = mesh.matrixWorld.elements;
    const matrixBaked = m[12] === 0 && m[13] === 0 && m[14] === 0 && m[0] === 1 && m[5] === 1 && m[10] === 1;
    return {
      name: mesh.name || '(anon)',
      tris: pos.count / 3,
      verts: pos.count,
      solid,
      clusters,
      nearVerts: nearVerts.slice(0, 16),
      center: [item.center.x, item.center.y, item.center.z].map(Math.round) as [number, number, number],
      radius: Math.round(item.radius),
      matrixBaked,
    };
  }

  /** 诊断：按名字查块级可见性（「这个模型到底是被剔了还是没画」）。 */  probeChunk(name: string): { name: string; found: number; d: number; r: number; clusters: number; pvsVisible: boolean | null; visible: boolean; tris: number; collider: boolean } | null {
    const key = name.trim();
    for (const item of this.visibility.items) {
      const n = item.mesh.name || '';
      if (n !== key) continue;
      const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
      const tris = g?.index ? g.index.count / 3 : (g?.getAttribute('position')?.count ?? 0) / 3;
      return {
        name: n,
        found: 1,
        d: Math.round(item.center.distanceTo(this.camera.position)),
        r: Math.round(item.radius),
        clusters: item.clusterIds.length,
        pvsVisible: item.clusterIds.length === 0 ? null : item.clusterIds.some((c) => this.pvs?.isVisible(c) ?? false),
        visible: item.mesh.visible,
        tris: Math.round(tris),
        collider: false,
      };
    }
    return null;
  }

  /** 诊断：主根内「当前被绘制」的块按距离分桶（判断 PVS 是否把很远的东西也留着）。 */
  drawnChunkStats(): { drawn: number; buckets: Record<string, number>; far: string[] } {
    const p = this.camera.position;
    const v = new THREE.Vector3();
    const buckets: Record<string, number> = { '0-2k': 0, '2-5k': 0, '5-10k': 0, '10-20k': 0, '>20k': 0 };
    const far: string[] = [];
    let drawn = 0;
    if (!this.root) return { drawn, buckets, far };
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      drawn++;
      const g = m.geometry as THREE.BufferGeometry | undefined;
      if (!g) return;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      if (!bs) return;
      // 合并块的几何已烘焙世界坐标、mesh 自身矩阵通常是单位阵 ⇒ 必须用包围球心，不能取 matrixWorld 平移。
      v.copy(bs.center).applyMatrix4(m.matrixWorld);
      const d = v.distanceTo(p);
      if (d < 2000) buckets['0-2k']++;
      else if (d < 5000) buckets['2-5k']++;
      else if (d < 10000) buckets['5-10k']++;
      else if (d < 20000) buckets['10-20k']++;
      else {
        buckets['>20k']++;
        if (far.length < 5) far.push(`${m.name || '(anon)'}@${Math.round(d)}`);
      }
    });
    return { drawn, buckets, far };
  }

  /** 可见性统计（形状与 debug 的 `LodStats` 兼容）。 */
  stats(): RenderSessionStats {    const r = this.lastVisibility;
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
    this.disposeScene();
    this.bloomFx?.dispose();
    this.bloomFx = null;
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
   * 半透明网格内部的**逐三角形**前后排序（通用口径，不依赖材质/水面分组）。
   *
   * three 只能按 object 排 `renderOrder`；同一块里的重叠玻璃面仍会按索引顺序画。
   * 这里直接按三角形中心到相机的距离重写 index buffer（远→近），组内保持材质组
   * 边界不变；非索引几何先补一条顺序 index。来源位置用几何原生 position，不重采样。
   */
  private sortTransparentFaces(mesh: THREE.Mesh, camera: THREE.Camera): void {
    const geom = mesh.geometry;
    const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    type Tri = { a: number; b: number; c: number; group: number };
    type Cache = { positionCount: number; indexCount: number; tris: Tri[]; dists: Float64Array; prevIdx: number[] | null };
    let cache = mesh.userData.__vbspFaceSort as Cache | undefined;
    let idx = geom.index;
    if (!idx) {
      const n = pos.count;
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      geom.setIndex(new THREE.BufferAttribute(arr, 1));
      idx = geom.index;
    }
    if (!idx) return;
    if (!cache || cache.positionCount !== pos.count || cache.indexCount !== idx.count) {
      const groups = geom.groups.length > 0
        ? geom.groups
        : [{ start: 0, count: idx.count, materialIndex: 0 }];
      const tris: Tri[] = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
          tris.push({ a: idx.getX(i), b: idx.getX(i + 1), c: idx.getX(i + 2), group: gi });
        }
      }
      cache = { positionCount: pos.count, indexCount: idx.count, tris, dists: new Float64Array(tris.length), prevIdx: null };
      mesh.userData.__vbspFaceSort = cache;
    }
    const c = cache;
    const cam = camera.position;
    const p = this.transparentSortPoint;
    for (let i = 0; i < c.tris.length; i++) {
      const t = c.tris[i];
      p.set(
        (pos.getX(t.a) + pos.getX(t.b) + pos.getX(t.c)) / 3,
        (pos.getY(t.a) + pos.getY(t.b) + pos.getY(t.c)) / 3,
        (pos.getZ(t.a) + pos.getZ(t.b) + pos.getZ(t.c)) / 3,
      ).applyMatrix4(mesh.matrixWorld);
      c.dists[i] = p.distanceToSquared(cam);
    }
    const idxArr = idx.array as unknown as number[];
    const order: number[] = [];
    for (let i = 0; i < c.tris.length; i++) order.push(i);
    order.sort((a, b) => c.dists[b] - c.dists[a]);
    // 组内写回：每组 `start/count` 不变，组顺序仍是材质组顺序。
    const groups = geom.groups.length > 0
      ? geom.groups
      : [{ start: 0, count: idx.count, materialIndex: 0 }];
    // 先把排序结果按材质组分桶（一次 O(tris)），再逐组连续写回；
    // 原写法对每个组都把 order 全扫一遍（O(groups×tris)），多材质大块时是纯浪费。
    const buckets: number[][] = groups.map(() => []);
    for (const oi of order) buckets[c.tris[oi].group].push(oi);
    let changed = false;
    const prevIdx = c.prevIdx;
    if (!prevIdx || prevIdx.length !== idxArr.length) {
      changed = true;
    }
    let k = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      let cursor = groups[gi].start;
      for (const oi of buckets[gi]) {
        const t = c.tris[oi];
        if (!changed && (prevIdx![k] !== t.a || prevIdx![k + 1] !== t.b || prevIdx![k + 2] !== t.c)) changed = true;
        idxArr[cursor] = t.a;
        idxArr[cursor + 1] = t.b;
        idxArr[cursor + 2] = t.c;
        cursor += 3;
        k += 3;
      }
    }
    // 只有排列真的变了才重传（three 的 WebGLAttributes.update 会整块 bufferSubData）。
    if (changed) {
      c.prevIdx = Array.from(idxArr as ArrayLike<number>);
      idx.needsUpdate = true;
    }
  }

  /**
   * 每帧把半透明块按**相机到该块最近表面**的距离远→近重排 `renderOrder`（three 升序绘制）。
   *
   * 之前按“材质/水位归组”是补丁；通用口径应该来自几何本身：对每块取世界 AABB，
   * 把相机点 clamp 到盒内得到最近点，用这个距离决定前后。这样不猜材质，也不受
   * 合并后 `position=(0,0,0)`、three 退化成 id 顺序的影响。地图解析侧的
   * `faceIndex` 已随来源区间表保留，后续要升级到逐面排序时可直接用。
   */
  /** 上次逐面排序时的相机位置；位置没动就不必重算三角形距离（转视角不改距离）。 */
  private readonly faceSortLastPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private sortTransparentChunks(camera: THREE.Camera): void {
    const list = this.transparentChunks;
    if (list.length === 0) return;
    const box = this.transparentSortBox;
    const point = this.transparentSortPoint;
    const cameraPos = camera.position;
    // 早退：排序结果只取决于「相机位置」和「这帧哪些半透明块可见」。原地转视角（Q/E）相机位置不变，
    // 可见集不变时重排是纯浪费 —— pose3 实测 sortTransparentFaces 占整帧 CPU 的 7%（≈0.22ms），
    // 而它算的三角形-相机距离一个都没变。哈希用 id 的加权和，碰撞只会让顺序不变时多做一次排序。
    let visHash = 0;
    let visCount = 0;
    for (const mesh of list) {
      if (!mesh.visible) continue;
      visCount++;
      visHash = (visHash * 31 + mesh.id) | 0;
    }
    // 逐面排序（每块逐三角形算距离 + 重排 + index 重传）只在相机位置真的变了才做：
    // 转视角时相机位置不变 ⇒ 距离不变 ⇒ 排序结果与上一帧逐位相同（实测占整帧 7%）。
    const moved = cameraPos.distanceToSquared(this.faceSortLastPos) > 0.0625;
    if (moved) this.faceSortLastPos.copy(cameraPos);
    if (
      visCount === this.transparentSortLastVisible &&
      visHash === this.transparentSortLastHash &&
      !moved
    ) {
      return;
    }
    this.transparentSortLastVisible = visCount;
    this.transparentSortLastHash = visHash;
    this.transparentSortLastPos.copy(cameraPos);
    for (const mesh of list) {
      const geom = mesh.geometry;
      if (!geom) continue;
      if (!mesh.visible) continue; // 被剔除的块不排序：省掉它的逐三角形重排
      if (!geom.boundingBox) geom.computeBoundingBox();
      const local = geom.boundingBox;
      if (!local) {
        mesh.userData.__vbspTransparentDist = 0;
        continue;
      }
      box.copy(local).applyMatrix4(mesh.matrixWorld);
      box.clampPoint(cameraPos, point);
      mesh.userData.__vbspTransparentDist = point.distanceToSquared(cameraPos);
      if (moved && (globalThis as { __vbspNoFaceSort?: unknown }).__vbspNoFaceSort !== true) {
        this.sortTransparentFaces(mesh, camera);
      }
    }
    list.sort((a, b) => {
      const da = (a.userData.__vbspTransparentDist as number | undefined) ?? 0;
      const db = (b.userData.__vbspTransparentDist as number | undefined) ?? 0;
      return db - da;
    });
    for (let i = 0; i < list.length; i++) {
      const base = (list[i].userData.__vbspTransparentBaseOrder as number | undefined) ?? 0;
      list[i].renderOrder = base + i;
    }
  }

  /** 主模型分块合并：三端唯一包装（新根口径；旧的 game/debug 原地挂回已废弃）。 */
  private mergeMain(root: THREE.Scene): THREE.Object3D {
    // 不透明块细分粒度：512 的一半（半透明/水面块不受影响，见 MergeOptions.opaqueTargetCells 注释）。
    // 实测开阔路段 344~503 draw ⇒ 主遍 3~4.4ms，不透明桶砍半是能进 320fps 预算的杠杆。
    // 再往细分（160）反而更差：同机位 route1 t=7000 311fps / t=12000 309fps（256 是 314 / 316），
    // 因为单块三角形变多、视锥裁剪变粗 ⇒ 顶点着色与填充反而上涨。256 是这里的最优点。
    // `exclude`：`momentary_rot_button`（符文盘）这类要单独挂 pivot 转的实体不并进块，
    // 否则顶点被烘焙到世界空间后找不回模型边界（见 `rot-buttons.ts`）。
    const optRoot = mergeIntoNewRoot(root, {
      translucentSplit: this.translucentSplit,
      // 视距 18000 时主遍是「可见块数 × 单 draw 提交」的瓶颈（实测 5µs/draw、GPU 只忙 24%）。
      // 不透明桶再压一档（256→128）换 draw 数：`OPT_CELL_MIN = 128 HU` 会把 cell 边长夹住，
      // 所以 128 与更小的取值等价，这里写 128 表示「已到最粗」。半透明/水面桶不受影响，
      // 几何与材质不变 ⇒ cand_c 同机位截图与改前逐像素一致（diff 0 px）。
      opaqueTargetCells: 128,
      exclude: (m) => Boolean((m.userData as { vbspRot?: unknown }).vbspRot),
    });
    // 逐顶点烘焙的 prop 曲面（`s1_ramp1_b` / `s1_window01_1` 这类）在 merged chunk 上仍带
    // `_vbsp_vlight`；vhv 的条带采样不连续，Gouraud 会把跳变画成硬边（见 shader 侧
    // `smoothVertexLighting` 的说明）。放在合并之后：`applyLightmapToMeshes` 在建场景时
    // 早于这些 prop 挂载，扫不到它们。
    // 先按网格尺度均匀细分：地板/坡道这类只有 2~3 列顶点的面，靠改原顶点的值去不掉
    // 「逐行线性插值」的条带（见 vlight-subdivide.ts 的说明）；细分把插值带压到视觉以下，
    // 再做拓扑平滑收敛中点值。顺序不能反：细分后平滑才有足够的顶点可用。
    let smoothed = 0;
    let subdivided = 0;
    optRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.getAttribute('_vbsp_vlight')) return;
      subdivided += subdivideVertexLit(mesh.geometry);
      smoothed += smoothVertexLighting(mesh.geometry);
    });
    if (smoothed > 0) console.info(`[optimizeScene] 逐顶点光照去接缝: 细分 ${subdivided} 层, 改写 ${smoothed} 个空间格子`);
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
