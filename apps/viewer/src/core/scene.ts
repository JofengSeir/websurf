/**
 * ViewerScene：three 渲染器 + 主场景 + 相机的装配与地图挂载。
 *
 * 2026-10-03 Phase 3c 对齐渲染共享层：GLB→子场景装配（摘 punctual 灯）、lightmap 施加、
 * 空间分块合并、近平面自适应全部改用 `src/renderer-shared/{scene,camera}/` 的共享实现
 * （owner 裁决：光照纪律全盘采纳 game——GLB 自带灯摘除、合并后终扫、不自带运行时灯）。
 * viewer 自己保留的只有：装配编排、相机 near/far 的 viewer 公式（far 多一档 INIT_FAR 下限）、
 * modelRoot 的换图生命周期与拾取/量测接口。
 */
import * as THREE from 'three';
import { renderSkyPass } from '../../../../src/renderer-shared/environment/render-sky-pass.js'; import { setSceneEnvironment, setSceneBackgroundColor, clearSceneEnvironment } from '../../../../src/renderer-shared/environment/scene-environment.js';
import {
  fullbrightUnlitLitMaterials,
  setLightingMode as setLightingModeInShader,
  getLightingMode,
  type LightingMode,
} from '../../../../src/renderer-shared/shader/lightmap-shader.js'; import { applyWorldTransitionShaders, collectWorldTransitionTextures } from '../../../../src/renderer-shared/shader/world-transition.js';
import { applyRenderPrefs, readRenderPrefs } from '../../../../src/renderer-shared/config/render-prefs.js'; import { createRenderer, precompileScene } from '../../../../src/renderer-shared/render/create-renderer.js'; import { applySceneCamera, shrinkNearPlane } from '../../../../src/renderer-shared/camera/scene-camera.js'; import { VisibilityController, type VisibilityUpdateResult } from '../../../../src/renderer-shared/scene/visibility-controller.js'; import { installRenderProbe } from '../../../../src/renderer-shared/render/render-probe.js'; import { applySceneTextureQuality } from '../../../../src/renderer-shared/scene/texture-quality.js'; import { mosaic_decode } from './bsp.js';
import { assembleScene } from '../../../../src/renderer-shared/scene/assemble-scene.js';
import { mergeIntoNewRoot, mergeStatsOf } from '../../../../src/renderer-shared/scene/scene-optimizer.js';
import { createSkyCamera, SKY_LAYER, type SkyCameraParams } from '../../../../src/renderer-shared/environment/miniature-sky.js';
import { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';
import { disposeObject } from '../../../../src/renderer-shared/scene/dispose.js';
import { NearPlaneController } from '../../../../src/renderer-shared/camera/near-plane.js';
import {
  BG_COLOR,
  CAMERA_FAR_SCALE,
  CAMERA_INIT_FAR,
  CAMERA_INIT_NEAR,
  FOV,
} from './constants.js';

const DEFAULT_LIGHTING_MODE: LightingMode = readRenderPrefs().lighting.mode;

export class ViewerScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  /** 已挂载的 BSP 模型根（换图时先 `disposeObject` 再挂新的）。 */
  private modelRoot: THREE.Object3D | null = null;

  /** 3D 天空盒（`miniature-sky.ts`，与 debug/game 同款）：第二相机 + 只挂 `SKY_LAYER` 层的天空区组。 */
  private skyCamera: THREE.PerspectiveCamera | null = null;
  private skyGroup: THREE.Group | null = null;
  private skyParams: SkyCameraParams | null = null;
  /** 天空遍专用雾（`sky_camera` 自己的参数，start/end 乘 1/scale）。 */
  private skyFog: THREE.Fog | null = null;
  /** PVS（`parse_pvs_data` 载荷）：天空区判据按「图元采样点所在 cluster」取。 */
  private pvs: PvsManager | null = null;

  /** 近平面贴墙自适应：实现在渲染共享层 `src/renderer-shared/camera/near-plane.ts`。 */
  private readonly nearPlane = new NearPlaneController(); /** 可见性控制器（T-454 P4b：收集/判定在共享层；天空层不参与剔除）。 */ private readonly visibility = new VisibilityController(); /** 最近一次可见性判定结果（三端一致性探针读 `pvsHidden`）。 */ private lastVisibility: VisibilityUpdateResult | null = null;
  private nearCheckToggle = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = createRenderer({ canvas, width: canvas.clientWidth, height: canvas.clientHeight });







	// 静态光照呈现参数：取自共享层唯一呈现档（`vbsp:renderPrefs`）
	applyRenderPrefs(readRenderPrefs());
    setLightingModeInShader(DEFAULT_LIGHTING_MODE);

    this.scene = new THREE.Scene();
    setSceneBackgroundColor(this.scene, BG_COLOR);

    this.camera = new THREE.PerspectiveCamera(
      FOV,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      CAMERA_INIT_NEAR,
      CAMERA_INIT_FAR,
    );
    this.camera.position.set(0, 0, 0);

    // 运行时灯：不加（2026-10-03 起 viewer 与 game 同一光照纪律）。GLB 自带的 punctual 光源
    // 在共享 buildMapScene 里摘除（VRAD 烘焙已含其贡献，运行时再打会重复计光，且 2000+ 盏
    // 会把受光材质的 uniform 推到上限 ⇒ program 无效 ⇒ 整批 mesh 一个像素都不画）。

    // 只读渲染状态探针（T-460 WP7）：三端一致性门禁的唯一读入口，只读状态、不改渲染行为
    installRenderProbe({
      scope: 'viewer',
      viewportSource: 'full-window',
      canvas: () => this.renderer.domElement,
      cull: () => ({ distance: this.visibility.cullDistance, auto: this.visibility.autoCullDistance, configured: readRenderPrefs().culling.distance }),
      pvs: () => ({ enabled: this.visibility.enablePvs, pvsHidden: this.lastVisibility?.culledByPvs ?? 0, clusters: this.pvs?.getStats().visibleCount ?? 0 }),
      merge: () => mergeStatsOf(this.modelRoot),
      sky: () => ({ hasGroup: !!this.skyGroup, children: this.skyGroup?.children.length ?? 0 }),
    });
  }

  hasModel(): boolean {
    return this.modelRoot !== null;
  }

  /** 当前地图的世界包围盒（由 `modelRoot` 现算；无地图时为 null）。 */
  worldBox(): THREE.Box3 | null {
    if (!this.modelRoot) return null;
    return new THREE.Box3().setFromObject(this.modelRoot);
  }

  resize(canvas: HTMLCanvasElement): void {
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    // 可见性（T-454 P4b）：距离优先 + 可选 PVS，判定与写回在共享控制器里；天空层不参与
    this.lastVisibility = this.visibility.update(this.camera, this.pvs);
    // 近平面贴墙自适应：每 2 帧做一次（`nearCheckToggle` 交替），贴墙 / 贴地 / 贴顶时收缩 near；
    // 候选收集只取 modelRoot 子树，且开 vertical（自由飞行要贴地/贴顶——game 只探水平四向）
    this.nearCheckToggle = !this.nearCheckToggle;
    if (this.nearCheckToggle && this.modelRoot) { shrinkNearPlane(this.nearPlane, this.camera, this.scene, this.camera.position.x, this.camera.position.y, this.camera.position.z, [this.modelRoot]); }
    // 两遍法唯一实现：共享环境模块 `environment/render-sky-pass.ts`（主世界 + 天空层，含天空遍雾）
    this.skyFog = renderSkyPass({ renderer: this.renderer, scene: this.scene, camera: this.camera, skyCamera: this.skyCamera, skyGroup: this.skyGroup, skyParams: this.skyParams, skyFog: this.skyFog });
  }

  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }

  /** 挂载 GLB（替换旧地图）：解析 → 施加静态光照 → 分块合并 → 合并后终扫 → `fitCamera`。 */
  async mountGlb(
    glbBytes: ArrayBuffer,
    skyboxTexture?: import('three').CubeTexture | null,
    sky?: { fogParams?: { color: number; start: number; end: number; maxDensity: number } | null; skyCamera?: SkyCameraParams | null; pvsJson?: string; mosaicManifest?: Record<string, string> | null },
  ): Promise<void> {
    // 换图：上一张图的天空层与雾先释放（下面的摘取会覆盖 this.skyGroup 引用）
    if (this.skyGroup) { disposeObject(this.skyGroup); this.scene.remove(this.skyGroup); this.skyGroup = null; }
    this.skyParams = null; this.skyFog = null; this.pvs = null;
    // 换图：先释放上一张图（必须在装配核之前——装配核里的 `optimizeScene` 会改写 `this.modelRoot`，
    // 放到后面就会把**新**图当成旧图释放）
    if (this.modelRoot) {
      disposeObject(this.modelRoot);
      this.scene.remove(this.modelRoot);
      this.modelRoot = null;
      // three.js 渲染列表缓存按旧地图几何缓存条目，换图后清掉（2026-10-04 自 debug 对齐）
      clearSceneEnvironment(this.scene, { disposeBackground: true }); this.renderer.renderLists.dispose();
    }
    // 共享装配核（T-454 P3b-2 起三端同一条链路）：GLB → 摘 punctual 灯 → 双贴图登记 → lightmap
    // → 摘天空区 → 主模型合并 → 天空区合并 → 终扫，顺序即契约（见 `scene/assemble-scene.ts` 文件头）。
    this.pvs = sky?.pvsJson ? new PvsManager(sky.pvsJson) : null;
    const asm = await assembleScene({
      glb: glbBytes,
      logPrefix: 'viewer',
      pvs: this.pvs,
      skyCamera: sky?.skyCamera ?? null,
      meshInCluster: (m, c) => this.meshInCluster(m, c),
      // 实参必须透传：装配核第 ⑤ 步把 `(root, gltf)` 传进来，丢弃就会让主模型合并整体早退
      // （`this.modelRoot` 此刻为 null ⇒ `optimizeScene` 返回 undefined ⇒ 回落未合并的 mapRoot）。
      mergeMain: (root) => this.optimizeScene(root),
    });

    setSceneEnvironment(this.scene, { background: skyboxTexture ?? new THREE.Color(BG_COLOR), skyboxReflection: skyboxTexture ?? null }); this.scene.add(asm.root);
    this.modelRoot = asm.root;
    this.skyGroup = asm.skyGroup;
    this.skyParams = asm.skyGroup && sky?.skyCamera ? sky.skyCamera : null;
    const maxDim = asm.maxDim;
    // 可见性（T-454 P4b：本工程此前全量绘制，见 TODO.md T-624）：收集可剔除块 + 按呈现档设剔除距离。
    // 天空层（SKY_LAYER）由共享控制器在收集阶段跳过 ⇒ 第二相机那一遍不受影响。
    const rpCull = readRenderPrefs();
    this.visibility.enablePvs = rpCull.culling.pvs;
    this.visibility.collect(asm.root, this.pvs);
    this.visibility.setCullDistance(maxDim * 0.5, rpCull.culling.distance);

    // 预编译着色器程序（2026-10-04 起与 game/debug 同款）：把「首次可见才编译」的卡顿挪到加载期。
    // 失败不致命（three 仍按需编译），故只告警。
    precompileScene(this.renderer, this.scene, this.camera);

    // 挂天空层 + 地图雾（与 debug/game 同款：天空图元只在第 1 层、由第二相机渲染）
    this.skyCamera = createSkyCamera();
    if (this.skyGroup) {
      this.scene.add(this.skyGroup);
      console.info(`[viewer][skybox] 3D 天空盒：天空区 ${this.skyGroup.children.length} 个图元挂第 ${SKY_LAYER} 层，由第二相机渲染`);
    } else {
      console.info('[viewer][skybox] 无可用 3D 天空盒（无 sky_camera 或天空区不可分离）⇒ 不加天空层');
    }
    // 地图线性雾（`env_fog_controller`）：建雾 + 雾上限的唯一入口（共享环境模块，三端同值）
    setSceneEnvironment(this.scene, { fog: sky?.fogParams ?? null }); await applyViewerTextureQuality(this.scene, this.modelRoot, this.skyGroup, sky?.mosaicManifest ?? null, readRenderPrefs().textureQuality);
    this.fitCamera(maxDim);
  }

  /**
   * 切换光照模式（面板「预烘焙 / 纯纹理」）：只改共享 uniform，下一次绘制即生效。
   *
   * 语义与 `src/renderer-shared/shader/lightmap-shader.ts` 的 `LightingMode` 一致：
   * 预烘焙 = 每像素采图集并算逐顶点 / 环境盒烘焙项（有明暗关系，每帧开销更大）；
   * 纯纹理 = 只上漫反射贴图（不采图集、不算烘焙项，移动时更平稳）。
   * 两种模式共用同一条加载路径 ⇒ 切换不重建场景、不重编译材质、不打断视角；
   * 传入与当前相同的模式时提前返回，不重复写 uniform。
   */
  setLightingMode(mode: LightingMode): void {
    if (getLightingMode() === mode) return;
    setLightingModeInShader(mode);
    console.info(`[viewer][lighting] 光照模式 → ${mode}（运行期 uniform 切换，未重建场景）`);
  }

  /** 当前光照模式（面板回填 / 诊断用）。 */
  getLightingMode(): LightingMode {
    return getLightingMode();
  }

  /**
   * 相机 near / far / fov 按地图尺寸自适应：T-454 P3b 起**委托共享** `camera/scene-camera.ts` 的
   * `applySceneCamera()`（near = `NearPlaneController.defaultNearForScene(maxDim)`、far = maxDim × 100、
   * fov 取呈现档；无地图时不调用，保持构造值）。
   * `maxDim` 取自地图装配返回的尺寸；改完由共享入口调用 `updateProjectionMatrix`。
   */
  fitCamera(maxDim: number): void {
    applySceneCamera(this.camera, this.nearPlane, maxDim, readRenderPrefs().camera.fov);
  }

  /**
   * 空间分块合并（共享核 `mergeIntoChunks` + viewer 自己的 root 重建口径）：把 GLTFLoader
   * 逐 primitive 建出来的 Mesh 按空间网格并块，块内再按材质实例子合并，把上万级绘制批次
   * 压到块的数量级。
   *
   * 与 game 的差异只在 root 处理（算法同一份）：game 原地挂回 bspRoot；本工程把块挂到
   * **新的 Group 根**并整体替换 `modelRoot`（`model` getter / 拾取 / `worldBox` 都按根切换），
   * 收集与合并算法、失败回退、包围球垫圈（`padBoundingSpheres`）全部与 game 同一份代码。
   * 副作用：旧 `modelRoot` 从场景移除、由新根节点接管；被合并掉的原始几何会 dispose。
   */
  /** 判某个 mesh 是否落在指定 BSP cluster（与 debug/game 同一采样口径：包围盒中心 + 6 个 ±r 轴点）。 */
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

  private optimizeScene(modelRoot?: THREE.Object3D): THREE.Object3D | void {
    const src = modelRoot ?? this.modelRoot;
    if (!src) return;
    // 合并算法与垫球口径在共享核（`mergeIntoNewRoot` = mergeIntoChunks + 新 Group 挂块 + padBoundingSpheres）
    // 日志与另两端同口径（`[optimizeScene] 分块合并:` 只由 `optimizeScene` 打印，本端走新根包装故自带一行）：
    // 三端都要能答「多少 mesh → 多少块」，否则「主模型到底合没合并」无从对号。
    let before = 0;
    src.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) before++;
    });
    const optRoot = mergeIntoNewRoot(src);
    console.info(`[viewer][optimize] 主模型分块合并：${before} mesh → ${optRoot.children.length} 个合并块`);
    this.scene.remove(src);
    this.scene.add(optRoot);
    this.modelRoot = optRoot;
    return optRoot;
  }
}

/**
 * 纹理画质档（T-454 P6）：viewer 此前**没有**画质切换（debug / game 都有）⇒ 三端画质档不同源。
 *
 * 数据源是 `BspProcessor::export_mosaic_manifest()`（本阶段补齐的导出）；切换算法在共享核
 * `renderer-shared/scene/texture-quality.ts`，本函数只负责「读档 → 调共享核 → 打印与另两端同形的
 * 诊断行 → 挂 A/B 钩子」。`globalThis.__vbspTextureQuality(q)` 供脚本与无头仪器在同一会话内
 * A/B（与 `globalThis.__vbspPose` 同风格）；`original` 用缓存的原图还原，`mini` 用 mosaic 字节码。
 */
const origTextureImages = new Map<THREE.Texture, unknown>();

async function applyViewerTextureQuality(
  scene: THREE.Scene,
  root: THREE.Object3D | null,
  skyRoot: THREE.Object3D | null,
  manifest: Record<string, string> | null,
  quality: 'original' | 'mini',
): Promise<void> {
  const count = manifest ? Object.keys(manifest).length : 0;
  console.log(`[renderer] 画质切换 → ${quality}，manifest ${count} 条，modelRoot=${!!root} sky=${!!skyRoot}`);
  (globalThis as unknown as { __vbspTextureQuality?: (q: 'original' | 'mini') => Promise<void> }).__vbspTextureQuality =
    (q) => applyViewerTextureQuality(scene, root, skyRoot, manifest, q);
  if (!manifest || !root || count === 0) return;
  const stats = await applySceneTextureQuality({
    mainRoot: root, skyRoot, manifest, quality, origImages: origTextureImages, deps: { decode: mosaic_decode },
  });
  console.log(`[renderer] 场景贴图 ${stats.mapCount} 个`);
  console.log(`[renderer] mini 匹配 ${stats.matched}/${stats.mapCount}；未匹配:`, stats.noMatch.slice(0, 12));
}
