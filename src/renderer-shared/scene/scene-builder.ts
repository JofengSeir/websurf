/**
 * 场景装配前置段（scene builder）：GLB 字节 → three 场景子树。
 *
 * 2026-10-02 自 apps/game/src/renderer/renderer-main.ts 的 loadScene 前置段与三个私有成员抽出、
 * 原样抽出（逻辑零改动；applyLightmap 由「写 this.pendingInjectReport」改为返回布尔值，由
 * 现居渲染共享层（game 经 tsconfig include 收编）。逻辑零改动；applyLightmap 由「写 this.pendingInjectReport」改为返回布尔值，由调用方落账。导出两个能力：
 * - buildMapScene：GLB → 子场景（新建 Scene + isBspModel 标记 + 清根 rotation + 包围盒 + 摘 punctual 灯）；
 * - applyLightmap：施加离线烘焙静态光照（lightmap atlas），返回是否施加到 mesh；
 * 装配顺序约束见 buildMapScene 文档与 renderer-main.loadScene 的编排注释。
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadLightmapAtlas, applyLightmapToMeshes, getLightingMode } from '../shader/lightmap-shader.js';

/** 复用的 GLTFLoader（buildMapScene 每次 loadAsync）。 */
const gltfLoader = new GLTFLoader();

/** GLB 字节 → GLTF：先把字节拷进新的 `Uint8Array` 再交给 Blob URL，`finally` 里注销该 URL。 */
async function loadGlb(glbBytes: ArrayBuffer): Promise<GLTF> {
  const buffer = new Uint8Array(glbBytes.byteLength);
  buffer.set(new Uint8Array(glbBytes));
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  try {
    return await gltfLoader.loadAsync(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 清零 GLB 根子节点的 rotation（有非零分量才写并立即刷新该子树的矩阵），最后整体更新 matrixWorld。
 *  在包围盒与分块计算之前调用，保证后面的世界变换基准一致。 */
function resetRootRotations(gltf: GLTF): void {
  for (const child of gltf.scene.children) {
    if (child.rotation.x !== 0 || child.rotation.y !== 0 || child.rotation.z !== 0) {
      child.rotation.set(0, 0, 0);
      child.updateMatrixWorld();
    }
  }
  gltf.scene.updateMatrixWorld(true);
}

/**
 * GLB 字节 → 装配好的地图子场景（尚未挂进主场景）。
 *
 * 步骤与顺序（与抽取前 loadScene 的 1./1.1 两段逐行一致）：
 * 1. loadGlb → 新建 Scene（标记 `userData.isBspModel`，disposeScene 与 updateNearPlane 都按它识别）
 *    → 清零 GLB 根子节点 rotation → 挂载 → 刷新 matrixWorld → 算世界包围盒与最大边长；
 * 2. 中和 GLTFLoader 解析出的 KHR_lights_punctual 光源（渲染面不施加这些灯：烘焙 lightmap 已含
 *    这些实体的贡献，运行时再打就是重复计光）。
 *
 * 两处都必须对，缺一个就是整批几何不渲染：
 *   (1) 位置：必须在调用方把子场景挂进主场景之前做完。rAF 渲染循环此刻已在跑，若先挂进
 *       场景再中和，中间那一帧就会带着这批灯去编译材质，超出片元 uniform 上限后该批 mesh
 *       一个像素都不画（本函数内的 console.info 文案记录了该后果）。
 *   (2) 手段：用 `removeFromParent()` 真正摘掉，而不是只置 `visible = false`——后者仍留在
 *       场景树里被反复 traverse（后续的 traverse 与 optimizeScene 都会遍历到），
 *       且任何一处把 visible 置回 true 就会让受光材质的程序失效。
 */
export async function buildMapScene(glb: ArrayBuffer): Promise<{
  gltf: GLTF;
  scene: THREE.Scene;
  bbox: THREE.Box3;
  maxDim: number;
}> {
  const gltf = await loadGlb(glb);
  const scene = new THREE.Scene();
  scene.userData.isBspModel = true;
  resetRootRotations(gltf);
  scene.add(gltf.scene);
  scene.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(scene);
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // 中和 GLTFLoader 解析出的 KHR_lights_punctual 光源（**必须在挂进主场景之前**）。
  //     渲染面不施加这些灯：烘焙 lightmap 已含这些实体的贡献，运行时再打就是重复计光。
  //
  //     两处都必须对，缺一个就是整批几何不渲染（判据见本函数文档）：
  const lightsToRemove: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if ((obj as THREE.Light).isLight) lightsToRemove.push(obj);
  });
  for (const l of lightsToRemove) l.removeFromParent();
  if (lightsToRemove.length > 0) {
    console.info(
      `[lights] GLB 携带 punctual 光源 ${lightsToRemove.length} 盏 → **已从场景树摘除**（不是仅 visible=false）。` +
        '烘焙 lightmap 已含其贡献（VRAD），运行时再打会重复计光；' +
        '且 2000+ 盏会把受光材质的 uniform 推到 1024 上限 ⇒ program 无效 ⇒ 该批 mesh 一个像素都不画。',
    );
  }

  return { gltf, scene, bbox, maxDim };
}

/**
 * 施加离线烘焙静态光照（lightmap atlas）。
 *
 * 契约：图集纹理由 `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 写进 GLB，位置由
 * `src/renderer-shared/shader/lightmap-shader.ts` 的 `loadLightmapAtlas` 解析（`asset.extras.lightmap`
 * 或 `scene.userData.extras.lightmap` 的 `textureIndex`）；图元侧带 `TEXCOORD_1` 与
 * `extras.hasLightmap`（落在 geometry.userData）。
 * 没有图集时只打日志返回 false；施加数与 atlas 尺寸打日志；返回「是否施加到 mesh」
 * （调用方用它置 pendingInjectReport，把生效性统计留给首帧之后的 `tick`）。异常只告警，
 * 不阻断场景加载，返回 false。
 */
export async function applyLightmap(scene: THREE.Scene, gltf: GLTF): Promise<boolean> {
  try {
    // atlas 在两种光照模式下都要加载：模式只是片元里的共享 uniform 分支（`vbspBakedMix`），
    // 纯纹理模式下若不带 atlas，面板切回预烘焙就得重建场景
    const atlas = await loadLightmapAtlas(gltf.parser, gltf);
    if (!atlas) {
      console.info('[lightmap] GLB 未携带 atlas（asset.extras.lightmap 缺失），跳过静态光照');
      return false;
    }
    const applied = applyLightmapToMeshes(scene, atlas);
    const image = atlas?.image as { width?: number; height?: number } | undefined;
    // 这里不做注入生效性统计：本函数在建场景时调用，three 还没编译材质，onBeforeCompile 尚未
    // 回填注入记录 ⇒ 统计只会得到全 0。统计放到首帧渲染之后，见 renderer-main 的 tick 里的
    // reportInjectStatsOnce，口径与 __vbspFrameProbe.lightmapState() 一致。
    console.info(
      `[lightmap] 光照模式=${getLightingMode()}，atlas ${image?.width ?? 0}×${image?.height ?? 0}，施加 mesh=${applied}`,
    );
    if (applied === 0) {
      console.warn('[lightmap] atlas 存在但未施加到任何 mesh（无 TEXCOORD_1 或 hasLightmap 全为 false）');
    }
    // 首帧后统一统计（幂等；由 renderer-main 的 tick 调用）：这里只回报施加结果
    return applied > 0;
  } catch (err) {
    console.error('[lightmap] 施加离线烘焙光照失败:', err);
    return false;
  }
}
