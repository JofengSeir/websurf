/**
 * 两遍法（主世界 + 3D 天空层）与地图雾的**唯一实现**（T-454 P7；任务书 `.tmp/task-unify-render/TASK.md` §2/L6、§3 P7）。
 *
 * 为什么有这一层：三端此前各写一遍同一段骨架（`apps/{debug,game}/src/renderer/renderer-main.ts` 的
 * `renderFrame`、`apps/viewer/src/core/scene.ts` 的 `render`），逐行同构、差异只在字段名与注释；
 * 天空行为回归无人守（分叉点 B11），雾上限也因此出现三条路径（B16）。
 *
 * 顺序即契约（起源 `CSkyboxView::DrawInternal`）：
 *   ① 同步天空相机（`syncSkyCamera`）→ 天空遍的雾换成 `sky_camera` 自己的参数
 *      （start/end × 1/scale，引擎 `Enable3dSkyboxFog`；`fogenable` 为假时天空区一点雾都不吃）
 *      → `renderer.clear()` 清后台缓冲 → 天空相机画「2D 天空盒背景 + 天空层图元」；
 *   ② `clearDepth()` 后摘掉 `scene.background`，主相机画主世界——**必须**摘背景，否则 three 的
 *      背景 pass 会把第 ① 遍整片盖掉；画完还原背景与主图雾。无 3D 天空盒时退回单遍。
 *
 * 边界：
 *   - 本模块不认识 BSP/PVS，也不管天空层怎么合并（那是 `scene/assemble-scene.ts` 的事）；
 *     三端只把自己的天空状态传进来，`skyFog` 由本模块惰性建并回传，调用方存回自己的字段。
 *   - 雾上限（`setFogMaxDensity`）的唯一调用入口在本模块：`createMapFog` / `applyMapFog`
 *     统一「建雾 + 设上限」的取值口径（缺省 1），`environment/light-manager.ts` 的 `setFog`
 *     也走 `createMapFog`，故 `apps/**` 不得再直接 import 该函数。
 */
import * as THREE from 'three';
import { setFogMaxDensity } from '../shader/lightmap-shader.js';
import { syncSkyCamera, type SkyCameraParams } from './miniature-sky.js';

/** 地图线性雾参数（`env_fog_controller`）；三端 `fogParams` 的结构同形。 */
export interface MapFogParams {
  color: number;
  start: number;
  end: number;
  /** 雾因子上限（0..1）；缺省 1 = 不加夹取。 */
  maxDensity: number;
}

/** 一帧两遍法所需的全部状态：渲染器/场景/主相机 + 本端自己的天空层引用。 */
export interface SkyPassInput {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  /** 天空相机（`createSkyCamera`）；为 null 表示无 3D 天空盒。 */
  skyCamera: THREE.PerspectiveCamera | null;
  /** 天空层组（`assembleScene` 的 `skyGroup`）；为 null 表示无 3D 天空盒。 */
  skyGroup: THREE.Object3D | null;
  /** `sky_camera` 参数（origin/scale/雾）；为 null 表示无 3D 天空盒。 */
  skyParams: SkyCameraParams | null;
  /** 上一次本函数回传的天空遍雾实例（无则传 null，本函数按需新建）。 */
  skyFog: THREE.Fog | null;
}

/**
 * 建地图线性雾并设置雾上限（**不**挂场景）：雾上限的唯一取值口径在这里。
 * 返回新建的雾实例（无参数时为 null），供 `LightManager` 之类需要自己持有实例的调用方使用。
 */
export function createMapFog(params: MapFogParams | null | undefined): THREE.Fog | null {
  setFogMaxDensity(params?.maxDensity ?? 1);
  return params ? new THREE.Fog(params.color, params.start, params.end) : null;
}

/** 装配期的地图雾入口：建雾（含上限）并挂到 `scene.fog`，返回实例供调用方留档。 */
export function applyMapFog(scene: THREE.Scene, params: MapFogParams | null | undefined): THREE.Fog | null {
  const fog = createMapFog(params);
  scene.fog = fog;
  return fog;
}

/**
 * 画一帧：有 3D 天空盒走两遍法，否则单遍。渲染器/场景/主相机任一缺失即整帧不画。
 * 返回本帧使用的天空遍雾实例（惰性新建），调用方应存回自己的字段供下一帧复用。
 */
export function renderSkyPass(input: SkyPassInput): THREE.Fog | null {
  const { renderer, scene, camera, skyCamera, skyGroup, skyParams } = input;
  let skyFog = input.skyFog;
  if (!renderer || !scene || !camera) return skyFog;
  if (!skyCamera || !skyGroup || !skyParams) {
    renderer.autoClear = true;
    renderer.render(scene, camera);
    return skyFog;
  }
  syncSkyCamera(skyCamera, camera, skyParams);
  const background = scene.background;
  const mapFog = scene.fog;
  const skyFogParams = skyParams.fog;
  if (skyFogParams?.enable) {
    if (!skyFog) skyFog = new THREE.Fog(0xffffff, 0, 1);
    skyFog.color.setHex(skyFogParams.color);
    skyFog.near = skyFogParams.start / skyParams.scale;
    skyFog.far = skyFogParams.end / skyParams.scale;
    scene.fog = skyFog;
  } else {
    scene.fog = null;
  }
  renderer.autoClear = false;
  renderer.clear();
  renderer.render(scene, skyCamera);
  scene.fog = mapFog;
  renderer.clearDepth();
  scene.background = null;
  renderer.render(scene, camera);
  scene.background = background;
  return skyFog;
}
