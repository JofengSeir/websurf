/**
 * 三端唯一的**装配核**：GLB 字节 → 可渲染场景（T-454 P3b-2；任务书 `.tmp/task-unify-render/TASK.md` §2/L3）。
 *
 * 为什么有这一层：三端此前各写一遍同一串步骤，**顺序靠注释互指**（「必须晚于 applyLightmap」
 * 「必须早于分块合并」在 debug/game/viewer 各写一次），且实测已出现顺序分叉（debug 是先合并主模型
 * 再合并天空区，game/viewer 相反）。顺序本身就是渲染链路的契约，故收进本模块一条固定序列：
 *
 *   ① `buildMapScene()`：GLB → 子场景（isBspModel 标记 + 清根旋转 + 世界包围盒 + **摘 punctual 灯**）
 *   ② `collectWorldTransitionTextures()`：登记「第一贴图 → 第二贴图」（必须早于 lightmap：lightmap 会另建材质）
 *   ③ `applyLightmap()`：施加离线烘焙静态光照（必须早于分块合并：合并按材质实例分组）
 *   ④ `extractSkyArea()`：把天空区图元摘出主世界（必须**晚于** lightmap、**早于**任何合并——合并后跨区大块无法再拆）
 *   ⑤ `mergeMain()`（各端提供自己的合并实现）：主模型分块合并
 *   ⑥ 天空区 `mergeIntoChunks()` + `padBoundingSpheres()` + 重贴 `SKY_LAYER`
 *   ⑦ 终扫 `fullbrightUnlitLitMaterials()` + `applyWorldTransitionShaders()`（主根、再天空组；必须**晚于**合并）
 *
 * 各端只保留自己的「装配后接线」：挂进主场景、天空相机与雾、碰撞/LOD/PVS 注册、贴图画质档、
 * 相机口径（`camera/scene-camera.ts`）与预编译。**不得**再在 `apps/**` 里各写这七步。
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyLightmap, buildMapScene } from './scene-builder.js';
import { mergeIntoChunks, padBoundingSpheres } from './scene-optimizer.js';
import { extractSkyArea, SKY_LAYER, type SkyCameraParams } from '../environment/miniature-sky.js';
import { applyWorldTransitionShaders, collectWorldTransitionTextures } from '../shader/world-transition.js';
import { applyBumpShaders, collectBumpTextures } from '../shader/bumpmap.js';
import { fullbrightUnlitLitMaterials } from '../shader/lightmap-shader.js';

/** PVS 查询面（只用到 cluster 查询；各端的 PvsManager 结构兼容）。 */
export interface SkyClusterQuery {
  getClusterAt(p: { x: number; y: number; z: number }): number;
}

export interface AssembleSceneOptions {
  /** BSP 导出的 GLB 字节。 */
  glb: ArrayBuffer;
  /** 日志前缀（`debug` / `game` / `viewer`），仅用于把三端日志对上号。 */
  logPrefix: string;
  /** sky_camera 的 cluster 采样判据（各端的 `meshInCluster`）。 */
  meshInCluster: (mesh: THREE.Mesh, cluster: number) => boolean;
  /** PVS（用于 sky_camera cluster 查询）；无则天空区不建。 */
  pvs?: SkyClusterQuery | null;
  /** 天空相机参数；无 3D 天空盒时为 null。 */
  skyCamera?: SkyCameraParams | null;
  /** 步骤 ⑤：本端的主模型分块合并；返回合并后的主根（不返回则沿用原根）。 */
  mergeMain?: (root: THREE.Scene, gltf: GLTF) => THREE.Object3D | void;
  /** 合并前对待合并几何数组的归一钩子（debug 的 `normalizeMergeGroup`；其余端不传）。 */
  normalizeGroup?: (geometries: THREE.BufferGeometry[]) => THREE.BufferGeometry[];
  /** 步骤 ② 之后、③ 之前的钩子（debug 用它收元数据——必须早于合并，合并会 dispose 原 mesh）。 */
  onRootReady?: (root: THREE.Scene, gltf: GLTF) => void;
}

export interface AssembleSceneResult {
  gltf: GLTF;
  /** 主根（若 `mergeMain` 换了根，这里是**换后**的根）。 */
  root: THREE.Object3D;
  bbox: THREE.Box3;
  maxDim: number;
  /** 天空组（无 sky_camera / 摘不到图元时为 null）；**未**挂进任何场景，由调用方决定挂载。 */
  skyGroup: THREE.Group | null;
  /** sky_camera 所在 cluster（无则 −1）。 */
  skyCluster: number;
  /** lightmap 是否施加成功。 */
  applied: boolean;
  /** 终扫收敛的受光 mesh 数（主根 / 天空组）。 */
  converged: number;
  skyConverged: number;
}

/** 三端唯一的装配序列；顺序即契约（见文件头）。 */
export async function assembleScene(opts: AssembleSceneOptions): Promise<AssembleSceneResult> {
  const { gltf, scene: mapRoot, bbox, maxDim } = await buildMapScene(opts.glb);
  await collectWorldTransitionTextures(gltf, mapRoot);
  // `$bumpmap`（T-627/P8）登记必须同样早于 lightmap：lightmap 会另建材质、不搬 userData，
  // 但第一贴图实例被沿用（注册表以它为键），所以要在建材质之前把贴图实例取到手。
  await collectBumpTextures(gltf, mapRoot);
  opts.onRootReady?.(mapRoot, gltf);

  const applied = await applyLightmap(mapRoot, gltf);
  if (!applied) {
    console.info('[' + opts.logPrefix + '][lightmap] 未施加静态光照（无 atlas 或施加失败），地图为贴图原色');
  }

  const skyCluster = opts.skyCamera && opts.pvs
    ? opts.pvs.getClusterAt({ x: opts.skyCamera.origin[0], y: opts.skyCamera.origin[1], z: opts.skyCamera.origin[2] })
    : -1;
  const skyGroup = opts.skyCamera && skyCluster >= 0
    ? extractSkyArea(mapRoot, (m) => opts.meshInCluster(m, skyCluster))
    : null;

  const mergedRoot = opts.mergeMain?.(mapRoot, gltf);
  const root = mergedRoot ?? mapRoot;

  if (skyGroup) {
    const skyMerged = mergeIntoChunks(skyGroup, opts.normalizeGroup ? { normalizeGroup: opts.normalizeGroup } : undefined);
    skyGroup.clear();
    for (const m of skyMerged.chunks) skyGroup.add(m);
    for (const m of skyMerged.keptMeshes) skyGroup.add(m);
    padBoundingSpheres(skyGroup);
    skyGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.layers.set(SKY_LAYER);
    });
    console.info('[skybox] 天空区合并：' + (skyMerged.infos.length + skyMerged.keptMeshes.length) + ' mesh → ' + skyMerged.chunkCount + ' 块');
  }

  const converged = fullbrightUnlitLitMaterials(root);
  applyWorldTransitionShaders(root);
  // 反射扰动注入必须在**合并之后**：合并按材质实例分组，早注入会漏掉合并新建的实例。
  applyBumpShaders(root);
  let skyConverged = 0;
  if (skyGroup) {
    skyConverged = fullbrightUnlitLitMaterials(skyGroup);
    applyWorldTransitionShaders(skyGroup);
    applyBumpShaders(skyGroup);
  }
  if (converged > 0) {
    console.info(
      '[' + opts.logPrefix + '][lightmap] 装配后终扫：' + converged + ' 个 mesh 仍为受光材质 ⇒ 收敛为 fullbright 贴图原色' +
        '（默认不加灯，受光材质恒黑；unlit 图元不吃 ambient cube）',
    );
  }
  return { gltf, root, bbox, maxDim, skyGroup, skyCluster, applied, converged, skyConverged };
}
