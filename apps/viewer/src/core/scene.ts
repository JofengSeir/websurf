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
import {
  fullbrightUnlitLitMaterials,
  setAmbientScale,
  setExposure,
  setLightGamma,
  setLightingMode as setLightingModeInShader,
  setPropVertexFlatten,
  setPropVertexRelax,
  getLightingMode,
  type LightingMode,
} from '../../../../src/renderer-shared/shader/lightmap-shader.js';
import { applyLightmap, buildMapScene } from '../../../../src/renderer-shared/scene/scene-builder.js';
import { mergeIntoChunks, padBoundingSpheres } from '../../../../src/renderer-shared/scene/scene-optimizer.js';
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

    // 静态光照（预烘焙）参数：与 `apps/game/src/renderer/renderer-main.ts` 初始化装配同值
    // —— exposure 2.3 / lightGamma 2.2 / ambientScale 1 / propVertexRelax 1 / propVertexFlatten 0.85。
    // 数值出处是 `apps/game/src/config.ts` 的 `DEFAULT_CONFIG.lighting`：本工程没有面板持久化，
    // 直接取同一组默认值，使同一张地图在两端观感一致。
    // 注意 `setLightGamma` 只接受 (0, 1] 的入参 ⇒ 这里的 2.2 会被它忽略、共享 uniform 保持初值 1；
    // 其余四项都落在各自接受窗口内（`setPropVertexFlatten` 另会把值钳到上限 1）。
    setExposure(2.3);
    setLightGamma(2.2);
    setAmbientScale(1);
    setPropVertexRelax(1);
    setPropVertexFlatten(0.85);
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

  /** 已挂载的地图根节点（拾取 / 量测用；无地图时为 null）。 */
  get model(): THREE.Object3D | null {
    return this.modelRoot;
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
    this.renderer.render(this.scene, this.camera);
  }

  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  remove(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }

  /** 挂载 GLB（替换旧地图）：解析 → 施加静态光照 → 分块合并 → 合并后终扫 → `fitCamera`。 */
  async mountGlb(glbBytes: ArrayBuffer): Promise<void> {
    // 共享装配核（2026-10-03 起与 game 同一条链路）：GLB 字节 → 子场景（isBspModel 标记 +
    // 清根 rotation + 世界包围盒 + 摘 punctual 灯，顺序约束见 buildMapScene 文档）
    const { gltf, scene: mapRoot, maxDim } = await buildMapScene(glbBytes);

    if (this.modelRoot) {
      disposeObject(this.modelRoot);
      this.scene.remove(this.modelRoot);
      this.modelRoot = null;
    }
    this.scene.add(mapRoot);
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
    const swept = fullbrightUnlitLitMaterials(this.modelRoot);
    if (swept > 0) {
      console.info(`[viewer][lightmap] 装配后终扫：${swept} 个 mesh 收敛为 fullbright 贴图原色`);
    }

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

/**
 * 释放模型几何 / 材质 / 纹理（换图前先调它，防显存泄漏）。
 * 每个材质释放 `map` 与 `lightMap` 两张纹理（dispose 后再次加载会重新上传），再 dispose
 * 材质本身；非 Mesh 节点跳过。本仓当前只在 `mountGlb` 换图时调用。
 */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const holder = mat as unknown as { map?: THREE.Texture | null; lightMap?: THREE.Texture | null };
      const map = holder.map;
      if (map?.isTexture) map.dispose();
      // lightmap 图集同样要释放：viewer 是反复换图的工具，漏掉它每张图都会多留一份图集
      // 纹理占用显存（与 map 同为 GLTF 纹理，dispose 后再次加载会重新上传）。
      const lightMap = holder.lightMap;
      if (lightMap?.isTexture) lightMap.dispose();
      mat.dispose();
    }
  });
}
