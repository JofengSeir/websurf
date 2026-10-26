/**
 * 三端唯一的**场景相机装配**与**近平面收缩口径**（T-454 P3b）。
 *
 * 为什么有这一层：`near` / `far` / `fov` 此前三端各写一遍（debug `renderer-main.ts`、game 同文件、viewer
 * `core/scene.ts` 的 `fitCamera`），三处口径已有实测分叉——viewer 的 `far` 多一档 `CAMERA_INIT_FAR`
 * 下限、且它的近平面收缩带 `vertical: true`（自由飞行要贴地/贴顶），debug/game 不带 ⇒ **同一相机位姿下
 * 三端 `camera.near` 读数不同**（实测 viewer 19.1207 vs debug/game 32.6502）。本模块把两件事定死：
 *
 *   1. `applySceneCamera()`：`near = NearPlaneController.defaultNearForScene(maxDim)`、
 *      `far = maxDim × CAMERA_FAR_SCALE`（原 viewer 的 `CAMERA_INIT_FAR` 下限取消，§12.2）、
 *      `fov` 由呈现档提供，并落账 `nearPlane.setDefaultNear()`；
 *   2. `shrinkNearPlane()`：近平面贴墙收缩的**唯一调用口径**（`roots` 由调用方给本端的模型根，
 *      `vertical` 三端统一为开——贴地/贴顶同样需要收缩，这是共享核里更完整的探测口径）。
 */
import type * as THREE from 'three';
import { NearPlaneController } from './near-plane.js';
import { readRenderPrefs } from '../config/render-prefs.js';

/** `far = maxDim × 此值`（§12.2 默认取值表；三端同一常数）。 */
export const CAMERA_FAR_SCALE = 100;

/** 近平面收缩的垂直探测口径（三端统一为「开」）。 */
export const NEAR_PLANE_VERTICAL = true;

/** 装配结果（供调用方记日志/断言用）。 */
export interface SceneCameraApplied {
  near: number;
  far: number;
  fov: number;
}

/**
 * 近裁面缩放（\`extras.nearPlaneScale\`，默认 1 = 不变）。
 *
 * 读本端渲染档：debug 与 game 各有「探测距离 + 收缩系数」两项，只有 viewer 用这个缩放系数，
 * 所以另外两端的值恒为默认 1 ⇒ 装配行为与加这个系数之前逐位一致。
 */
function nearScale(): number {
  const v = readRenderPrefs().extras.nearPlaneScale;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** 三端唯一的场景相机装配：near / far / fov 一次定死并刷新投影矩阵。 */
export function applySceneCamera(
  camera: THREE.PerspectiveCamera,
  nearPlane: NearPlaneController,
  maxDim: number,
  fov: number,
): SceneCameraApplied {
  const near = NearPlaneController.defaultNearForScene(maxDim) * nearScale();
  const far = maxDim * CAMERA_FAR_SCALE;
  nearPlane.setDefaultNear(near);
  camera.near = near;
  camera.far = far;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  console.info('[scene-camera] 生效：near=' + near + ' far=' + far + ' fov=' + fov + '（maxDim=' + maxDim + '）');
  return { near, far, fov };
}

/** 三端唯一的近平面收缩调用：口径 = （可选）本端模型根子树 + 垂直探测。 */
export function shrinkNearPlane(
  nearPlane: NearPlaneController,
  camera: THREE.PerspectiveCamera,
  scene: THREE.Object3D | null,
  x: number,
  y: number,
  z: number,
  roots?: THREE.Object3D[],
): void {
  nearPlane.update(camera, scene, x, y, z, roots ? { roots, vertical: NEAR_PLANE_VERTICAL } : { vertical: NEAR_PLANE_VERTICAL });
  // 命中几何时的自适应结果也按同一系数缩放（1 = 原样；只有 viewer 会调这个值）
  const scale = nearScale();
  if (scale !== 1) {
    camera.near = Math.max(camera.near * scale, 1e-4);
    camera.updateProjectionMatrix();
  }
}
