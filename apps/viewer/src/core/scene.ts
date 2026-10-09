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
import { setFogMaxDensity } from '../../../../src/renderer-shared/shader/lightmap-shader.js';
import {
  fullbrightUnlitLitMaterials,
  applyLightingPresentationDefaults,
  setLightingMode as setLightingModeInShader,
  getLightingMode,
  type LightingMode,
} from '../../../../src/renderer-shared/shader/lightmap-shader.js'; import { applyWorldTransitionShaders, collectWorldTransitionTextures } from '../../../../src/renderer-shared/shader/world-transition.js';
import { applyLightmap, buildMapScene } from '../../../../src/renderer-shared/scene/scene-builder.js';
import { mergeIntoChunks, padBoundingSpheres } from '../../../../src/renderer-shared/scene/scene-optimizer.js';
import { createSkyCamera, extractSkyArea, SKY_LAYER, syncSkyCamera, type SkyCameraParams } from '../../../../src/renderer-shared/environment/miniature-sky.js';
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

const DEFAULT_LIGHTING_MODE: LightingMode = 'baked';

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
  private readonly nearPlane = new NearPlaneController();
  private nearCheckToggle = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;







	// 静态光照呈现参数：取自共享层唯一默认档；本工程无面板持久化，直接用同一组值
	applyLightingPresentationDefaults();
    setLightingModeInShader(DEFAULT_LIGHTING_MODE);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

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
    // 近平面贴墙自适应：每 2 帧做一次（`nearCheckToggle` 交替），贴墙 / 贴地 / 贴顶时收缩 near；
    // 候选收集只取 modelRoot 子树，且开 vertical（自由飞行要贴地/贴顶——game 只探水平四向）
    this.nearCheckToggle = !this.nearCheckToggle;
    if (this.nearCheckToggle && this.modelRoot) {
      this.nearPlane.update(
        this.camera,
        this.scene,
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z,
        { roots: [this.modelRoot], vertical: true },
      );
    }
    // 有 3D 天空盒时按起源的两遍法（与 debug/game 同款）：① 天空相机画 2D 天空盒背景 + 天空层；
    // ② 清深度、摘掉背景后主相机画主世界（不摘背景的话 three 的背景 pass 会盖掉第 ① 遍）。
    const skyCamera = this.skyCamera;
    if (!skyCamera || !this.skyGroup || !this.skyParams) {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    syncSkyCamera(skyCamera, this.camera, this.skyParams);
    const background = this.scene.background;
    const mapFog = this.scene.fog;
    // 天空遍的雾走 sky_camera 自己的参数，start/end 乘 1/scale（引擎 Enable3dSkyboxFog）
    const skyFogParams = this.skyParams.fog;
    if (skyFogParams?.enable) {
      if (!this.skyFog) this.skyFog = new THREE.Fog(0xffffff, 0, 1);
      this.skyFog.color.setHex(skyFogParams.color);
      this.skyFog.near = skyFogParams.start / this.skyParams.scale;
      this.skyFog.far = skyFogParams.end / this.skyParams.scale;
      this.scene.fog = this.skyFog;
    } else {
      this.scene.fog = null;
    }
    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.scene, skyCamera);
    this.scene.fog = mapFog;
    this.renderer.clearDepth();
    this.scene.background = null;
    this.renderer.render(this.scene, this.camera);
    this.scene.background = background;
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
    sky?: { fogParams?: { color: number; start: number; end: number; maxDensity: number } | null; skyCamera?: SkyCameraParams | null; pvsJson?: string },
  ): Promise<void> {
    // 换图：上一张图的天空层与雾先释放（下面的摘取会覆盖 this.skyGroup 引用）
    if (this.skyGroup) { disposeObject(this.skyGroup); this.scene.remove(this.skyGroup); this.skyGroup = null; }
    this.skyParams = null; this.skyFog = null; this.pvs = null;
    // 共享装配核（2026-10-03 起与 game 同一条链路）：GLB 字节 → 子场景（isBspModel 标记 +
    // 清根 rotation + 世界包围盒 + 摘 punctual 灯，顺序约束见 buildMapScene 文档）
    const { gltf, scene: mapRoot, maxDim } = await buildMapScene(glbBytes); await collectWorldTransitionTextures(gltf, mapRoot);

    // 3D 天空盒（起源做法，与 debug/game 同款）：把天空区图元摘出主世界、交第二相机单独渲染。
    // 判据 =「图元采样点落在 `sky_camera` 所在 cluster」；必须早于分块合并——合并后跨区的大块
    // 无法再拆。无 `sky_camera` / 无 PVS / 摘不到图元时不建，末尾不挂天空层。
    this.pvs = sky?.pvsJson ? new PvsManager(sky.pvsJson) : null;
    const skyCluster = sky?.skyCamera && this.pvs
      ? this.pvs.getClusterAt({ x: sky.skyCamera.origin[0], y: sky.skyCamera.origin[1], z: sky.skyCamera.origin[2] })
      : -1;
    this.skyGroup = sky?.skyCamera && skyCluster >= 0 ? extractSkyArea(mapRoot, (m) => this.meshInCluster(m, skyCluster)) : null;
    this.skyParams = this.skyGroup && sky?.skyCamera ? sky.skyCamera : null;

    if (this.modelRoot) {
      disposeObject(this.modelRoot);
      this.scene.remove(this.modelRoot);
      this.modelRoot = null;
      // three.js 渲染列表缓存按旧地图几何缓存条目，换图后清掉（2026-10-04 自 debug 对齐）
      if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose(); this.renderer.renderLists.dispose();
    }
    this.scene.background = skyboxTexture ?? new THREE.Color(BG_COLOR); this.scene.add(mapRoot);
    this.modelRoot = mapRoot;

    // 静态光照（预烘焙，默认）必须赶在 optimizeScene 之前：分块合并按材质实例分组，
    // 换过材质的图元一旦留到合并之后才处理，分组与逐 primitive 的 UV1 映射都会失配。
    const applied = await applyLightmap(mapRoot, gltf);
    if (!applied) {
      console.info('[viewer][lightmap] 未施加静态光照（无 atlas 或施加失败），地图为贴图原色');
    }

    // 渲染减负：空间分块合并（GLTFLoader 逐 primitive 建 Mesh，这里按空间块归并）
    this.optimizeScene();

    // 合并后终扫（2026-10-03 起与 game 同序：终扫必须晚于合并——合并会重建 mesh/材质数组）：
    // 把仍是 GLTF 原 Standard 材质的图元收敛为贴图原色（本工程不加灯，受光材质恒黑）
    const swept = fullbrightUnlitLitMaterials(this.modelRoot); applyWorldTransitionShaders(this.modelRoot);
    // 天空区图元已摘出主根，同两道装配要在天空组上再跑一次（全亮收敛 + WorldTransition 雪盖）
    if (this.skyGroup) { fullbrightUnlitLitMaterials(this.skyGroup); applyWorldTransitionShaders(this.skyGroup); }
    if (swept > 0) {
      console.info(`[viewer][lightmap] 装配后终扫：${swept} 个 mesh 收敛为 fullbright 贴图原色`);
    }

    // 预编译着色器程序（2026-10-04 起与 game/debug 同款）：把「首次可见才编译」的卡顿挪到加载期。
    // 失败不致命（three 仍按需编译），故只告警。
    try {
      const compileT0 = performance.now();
      this.renderer.compile(this.scene, this.camera);
      console.info(`[viewer][render] 着色器程序预编译耗时 ${(performance.now() - compileT0).toFixed(0)}ms`);
    } catch (err) {
      console.warn('[viewer][render] 预编译着色器失败（不影响按需编译）:', err);
    }

    // 挂天空层 + 地图雾（与 debug/game 同款：天空图元只在第 1 层、由第二相机渲染）
    this.skyCamera = createSkyCamera();
    if (this.skyGroup) {
      this.scene.add(this.skyGroup);
      console.info(`[viewer][skybox] 3D 天空盒：天空区 ${this.skyGroup.children.length} 个图元挂第 ${SKY_LAYER} 层，由第二相机渲染`);
    } else {
      console.info('[viewer][skybox] 无可用 3D 天空盒（无 sky_camera 或天空区不可分离）⇒ 不加天空层');
    }
    // 地图线性雾（`env_fog_controller`）：与 debug/game 同值
    this.scene.fog = sky?.fogParams ? new THREE.Fog(sky.fogParams.color, sky.fogParams.start, sky.fogParams.end) : null;
    setFogMaxDensity(sky?.fogParams?.maxDensity ?? 1);
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
   * 相机 near / far 按地图尺寸自适应；无地图时直接返回（保持构造值）。
   * - near = `NearPlaneController.defaultNearForScene(maxDim)`（= max(maxDim / 1000, CAMERA_NEAR_MIN)，
   *   同时经 `setDefaultNear` 落账供贴墙收缩后复位
   * - far = max(maxDim × CAMERA_FAR_SCALE, CAMERA_INIT_FAR)（viewer 比 game 多一档 INIT_FAR 下限）
   * 两个尺寸都取自地图装配返回的 maxDim，改完调用 `updateProjectionMatrix`。
   */
  fitCamera(maxDim: number): void {
    const defaultNear = NearPlaneController.defaultNearForScene(maxDim);
    this.nearPlane.setDefaultNear(defaultNear);
    this.camera.near = defaultNear;
    this.camera.far = Math.max(maxDim * CAMERA_FAR_SCALE, CAMERA_INIT_FAR);
    this.camera.updateProjectionMatrix();
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

  private optimizeScene(): void {
    if (!this.modelRoot) return;
    const r = mergeIntoChunks(this.modelRoot);
    const optRoot = new THREE.Group();
    for (const m of r.chunks) optRoot.add(m);
    for (const m of r.keptMeshes) optRoot.add(m);
    padBoundingSpheres(optRoot);
    this.scene.remove(this.modelRoot);
    this.scene.add(optRoot);
    this.modelRoot = optRoot;
  }
}
