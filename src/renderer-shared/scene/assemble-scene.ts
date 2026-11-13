/**
 * 三端唯一的**装配核**：GLB 字节 → 可渲染场景（T-454 P3b-2）。
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
import { buildSpotBeams, type PunctualSpot } from './spot-beams.js';
import { mergeIntoChunks, padBoundingSpheres } from './scene-optimizer.js';
import { extractSkyArea, SKY_LAYER, type SkyCameraParams } from '../environment/miniature-sky.js';
import { applyWorldTransitionShaders, collectWorldTransitionTextures } from '../shader/world-transition.js';
import { applyBumpShaders, collectBumpTextures } from '../shader/bumpmap.js';
import { applyWaterShaders } from '../shader/water.js';
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
  /** spot 光源的可见光柱（无 spot 时为 null）；未挂进任何场景，由调用方决定挂载。 */
  spotBeams: THREE.Group | null;
}

/** 三端唯一的装配序列；顺序即契约（见文件头）。 */
/**
 * 河流水面的兜底着色。
 *
 * `Refract`（河流 / 瀑布 / 冰面）在 Source 里折射背景，本身没有 albedo：
 * - 拿不到贴图时上游给「白 + 占位 alpha 0.2」，隔着玻璃看是黑洞 ⇒ 补可见水色；
 * - 拿到的是它的水面纹理（多半是法线/流动图，RGB 偏蓝）⇒ 压暗成深水色，避免像蓝塑料。
 * 只动 river，瀑布/水下层的占位白是刻意的泡沫色，不碰。
 */
/**
 * 河流/折射水面的自研兜底材质。
 *
 * `Refract` 在 Source 里没有 albedo，靠折射背景成色；我们用 three.js 直接渲染，
 * 既没有 refraction pass，也不能把流水法线图当 albedo（会发蓝塑料）。
 * 这里给一个便宜、可控的透明水体：深水底色 + 掠射角菲涅尔提亮/加不透明度，
 * 贴图只作为轻微流动扰动。观感目标是「能看穿的水」，不是镜面。
 */
const RIVER_SHADER_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RIVER_SHADER_FRAG = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uAlpha;
uniform float uTime;
uniform sampler2D uMap;
uniform float uHasMap;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  float ndv = abs(dot(normalize(vNormalW), normalize(vViewW)));
  float fres = pow(1.0 - ndv, 3.0);
  vec3 col = mix(uDeep, uShallow, clamp(fres * 0.85, 0.0, 1.0));
  if (uHasMap > 0.5) {
    vec2 flow = vec2(sin(uTime * 0.08 + vUv.y * 7.0), cos(uTime * 0.06 + vUv.x * 5.0)) * 0.012;
    vec3 tex = texture2D(uMap, vUv + flow).rgb;
    col = mix(col, col * 1.15 + tex * 0.06, 0.6);
  }
  float alpha = mix(uAlpha, min(1.0, uAlpha + 0.4), fres);
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

function makeRiverFallbackMaterial(src: THREE.MeshBasicMaterial): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uDeep: { value: new THREE.Color(0x3d6b78) },
      uShallow: { value: new THREE.Color(0xc2e2e8) },
      uAlpha: { value: 0.58 },
      uTime: { value: 0 },
      uMap: { value: src.map ?? null },
      uHasMap: { value: src.map ? 1 : 0 },
    },
    vertexShader: RIVER_SHADER_VERT,
    fragmentShader: RIVER_SHADER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.name = src.name;
  // 用 onBeforeRender 推进时间，避免依赖渲染循环改动
  mat.onBeforeRender = () => {
    mat.uniforms.uTime.value = performance.now() / 1000;
  };
  return mat;
}

function seedRiverWater(root: THREE.Object3D): number {
  const done = new Set<THREE.Material>();
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (let i = 0; i < mats.length; i++) {
      const mat = mats[i] as THREE.MeshBasicMaterial;
      if (!mat || !mat.transparent || done.has(mat)) continue;
      if (!/river/i.test(mat.name || '')) continue;
      const repl = makeRiverFallbackMaterial(mat);
      done.add(mat);
      if (Array.isArray(mesh.material)) mesh.material[i] = repl;
      else mesh.material = repl;
      n++;
    }
  });
  return n;
}

function tintTexturelessWater(root: THREE.Object3D): number {
  const tinted = new THREE.Color(0x5f7f86);
  const graded = new THREE.Color(0x222c30);
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshBasicMaterial;
      if (!mat || !mat.transparent) continue;
      // 已经被水面兜底 shader 接管的，不再改色（ShaderMaterial 没有 color/opacity）。
      if ((mat as unknown as { isShaderMaterial?: boolean }).isShaderMaterial) continue;
      // 只认平流水面（river）：瀑布/水下层的白是刻意的泡沫色，染成水蓝会画成蓝墙。
      if (mat.opacity > 0.95 || !/river/i.test(mat.name || '')) continue;
      if (mat.map) {
        mat.color.copy(graded);
        mat.opacity = 0.55;
      } else {
        mat.color.copy(tinted);
        mat.opacity = Math.max(mat.opacity, 0.55);
      }
      mat.needsUpdate = true;
      n++;
    }
  });
  return n;
}

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
    // 天空区整片一次可见、不做逐块剔除，块数只影响天空遍的 draw 数（实测水平线 160+ 块 = 1.7ms）；
    // 目标给 16 块，天空是静态远景，合并粒度粗一点也不会有可见差异。
    const skyMerged = mergeIntoChunks(skyGroup, { targetCells: 16 });
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
  // 水面材质整槽替换：必须在**合并之后**（合并按材质实例分组，早替换会被合并丢掉），
  // 也要**早于** bump（bump 会把水面着色器改写成法线注入）。
  const seededRiver = seedRiverWater(root);
  applyWaterShaders(root);
  tintTexturelessWater(root);
  if (seededRiver > 0) console.info('[' + opts.logPrefix + '][water] 河道补水面参数：' + seededRiver + ' 槽');
  // 反射扰动注入必须在**合并之后**：合并按材质实例分组，早注入会漏掉合并新建的实例。
  applyBumpShaders(root);
  let skyConverged = 0;
  if (skyGroup) {
    skyConverged = fullbrightUnlitLitMaterials(skyGroup);
    applyWorldTransitionShaders(skyGroup);
    seedRiverWater(skyGroup);
    applyWaterShaders(skyGroup);
    tintTexturelessWater(skyGroup);
    applyBumpShaders(skyGroup);
  }
  if (converged > 0) {
    console.info(
      '[' + opts.logPrefix + '][lightmap] 装配后终扫：' + converged + ' 个 mesh 仍为受光材质 ⇒ 收敛为 fullbright 贴图原色' +
        '（默认不加灯，受光材质恒黑；unlit 图元不吃 ambient cube）',
    );
  }
  // 合并**之后**才建可见光柱：它属于「运行时效果」，不能参与块合并。
  const spotBeams = buildSpotBeams((mapRoot.userData.punctualSpots as PunctualSpot[] | undefined) ?? []);
  return { gltf, root, bbox, maxDim, skyGroup, skyCluster, applied, converged, skyConverged, spotBeams };
}
