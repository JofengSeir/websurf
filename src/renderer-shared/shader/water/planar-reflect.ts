/**
 * 平面反射：镜像相机 + 斜裁剪/纹理矩阵 + 每层水面一张 RT。
 *
 * 从 ../water.ts 拆出；行为与拆分前逐字一致。范围内所有模块级可变状态
 * （mirrorPlanes / mirrorMeshes / mirrorRendering / mirrorUniform / textureMatrix）
 * 都只在本文件声明，由 water.ts 门面通过 resetMirrorState 复位。
 *
 * 本文件不 import refract-underwater（避免环形依赖）：renderMirrorPlane 需要的
 * 水面材质集合由调用方（门面）作为参数传入。
 */
import * as THREE from 'three';
import { optimizeFlag } from '../../config/optimize-flags.js';

const g = globalThis as {
  __vbspWaterMeshes?: () => unknown;
  __vbspWaterReflectOff?: unknown;
};

// ── 平面反射（three `examples/jsm/objects/Water.js` 的手法：镜像相机 + RT + 法线扭曲） ──
//
// Water.js 是"一个 mesh 一个 RT + 在 `onBeforeRender` 里渲染一遍场景"。本工程的水面是**世界面
// 合并块**（surf_666 上 286 个槽、分散在几十个块里），逐块渲染不可行 ⇒ 改成**每帧共享一张**：
// 取"离相机最近的水面块"的高度当**水平镜像平面**（BSP 水面法线本来就是竖直的；45° 的
// 瀑布/河流走 `Refract` 通路、没有 `vbsp_water`，不在本通路里），整帧只渲一次 RT。
export const MIRROR_SIZE = 1024;
/**
 * 每个**水面高度**一张镜像 RT。
 *
 * 为什么不能共用一张：surf_666 同时有 -16064 / -11968 / -11071 / 15296 / 15312 五层水面。
 * 水平镜面 = 相机关于该层 y 镜像；用“离相机最近的那层”的 RT 去投另一层，UV 投影会随视角
 * 绕一个点放射（owner 报的“放射反射倒影”），因为镜面相机与像素所在平面不是同一个。
 * 现在按 mesh 自己的高度取对应 RT；每帧只为**实际被绘制到的层**渲一次（视锥外自然不渲）。
 */
export interface MirrorPlane {
  height: number;
  rt: THREE.WebGLRenderTarget | null;
  /** 当前 RT 的边长（像素）。`mirrorLowRes` 开关切换时据此重建。 */
  rtSize: number;
  texture: THREE.Texture | null;
  matrix: THREE.Matrix4;
  camera: THREE.PerspectiveCamera;
  done: boolean;
  /** 最近一次重渲的全局序号（用于每帧最多渲 1 层镜面时轮流挑最陈旧的层）。 */
  lastRenderedSeq: number;
}
export const mirrorPlanes = new Map<number, MirrorPlane>();
export const textureMatrix = new THREE.Matrix4();
export const mirrorMeshes = new Map<THREE.Mesh, number>(); // mesh → 世界高度（包围球中心 y）
// 取证口：列出已注册的水面网格（名字 + 水面高度 + 世界包围盒中心），用于挑机位看水。
// 例：`__vbspWaterMeshes()`；`{name, y, center:[x,y,z]}`。
(g as { __vbspWaterMeshes?: () => unknown }).__vbspWaterMeshes = () =>
  [...mirrorMeshes].map(([m, h]) => {
    const b = new THREE.Box3().setFromObject(m);
    const c = b.getCenter(new THREE.Vector3());
    return { name: m.name, y: h, center: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)] };
  });
export let mirrorRendering = false;
export const reflOnUniform = { value: 1 };
export const mirrorUniform = { value: null as THREE.Texture | null };
export const textureMatrixUniform = { value: textureMatrix };
const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _mirrorDir = new THREE.Vector3();
const _mirrorLook = new THREE.Vector3();
const _mirrorUp = new THREE.Vector3();
const _mirrorHidden: THREE.Material[] = [];

export function mirrorPlaneOf(height: number): MirrorPlane {
  const key = Math.round(height * 100) / 100;
  let p = mirrorPlanes.get(key);
  if (!p) {
    p = {
      height: key,
      rt: null,
      rtSize: 0,
      texture: null,
      matrix: new THREE.Matrix4(),
      camera: new THREE.PerspectiveCamera(),
      done: false,
      lastRenderedSeq: 0,
    };
    mirrorPlanes.set(key, p);
  }
  return p;
}

export function reflectOff(): boolean {
  return (g as { __vbspWaterReflectOff?: unknown }).__vbspWaterReflectOff === true;
}

/** 换图/卸载：释放每层镜像 RT 与本地登记，避免旧图平面表污染新图。 */
export function resetMirrorState(): void {
  for (const p of mirrorPlanes.values()) p.rt?.dispose();
  mirrorPlanes.clear();
  mirrorMeshes.clear();
  mirrorUniform.value = null;
  textureMatrix.identity();
  mirrorRendering = false;
}

/**
 * 镜面 RT 的边长：默认 `MIRROR_SIZE`（1024）。面板「优化处理」里的 `mirrorLowRes` 打开时减半
 * （512²，GPU 填充与带宽约 1/4，倒影会明显变糊——这是有画面代价的开关，默认关）。
 */
export function mirrorSizeNow(): number {
  return optimizeFlag('mirrorLowRes') ? Math.max(256, Math.round(MIRROR_SIZE / 2)) : MIRROR_SIZE;
}

/**
 * 水平镜面斜近裁剪平面（Lengyel Oblique Frustum Clipping）：
 * 把镜像相机 `vcam` 的近裁剪面直接对齐到水面高度 `planeHeight`（在 `camera` 所在一侧），
 * 让硬件光栅化阶段直接剔除水面以下的全部几何——既省一半无效片元填充，又消除水下实体穿透倒影。
 * 必须在 `plane.matrix`（投影采样矩阵）算完之后调用，避免影响反射 UV 投影。
 */
export function applyObliqueWaterClip(
  vcam: THREE.PerspectiveCamera,
  planeHeight: number,
  camY: number,
  clipBias = 0.25,
): boolean {
  const side = camY >= planeHeight ? 1 : -1;
  const m = vcam.matrixWorld.elements;
  const cx = m[1] * side;
  const cy = m[5] * side;
  const cz = m[9] * side;
  const cw = (m[13] - planeHeight) * side + clipBias;
  // 相机几乎贴着水面时平面对相机退化，回退普通近平面
  if (cw >= -0.5) return false;
  const pe = vcam.projectionMatrix.elements;
  if (Math.abs(pe[0]) < 1e-8 || Math.abs(pe[5]) < 1e-8 || Math.abs(pe[14]) < 1e-8) return false;
  const qx = (Math.sign(cx) + pe[8]) / pe[0];
  const qy = (Math.sign(cy) + pe[9]) / pe[5];
  const qz = -1;
  const qw = (1 + pe[10]) / pe[14];
  const dot = cx * qx + cy * qy + cz * qz + cw * qw;
  if (!Number.isFinite(dot) || Math.abs(dot) < 1e-6) return false;
  const scale = 2 / dot;
  pe[2] = cx * scale;
  pe[6] = cy * scale;
  pe[10] = cz * scale + 1;
  pe[14] = cw * scale;
  return true;
}

/** 渲染某一层水面的镜像 RT（每层每帧一次；在该层第一个水面 mesh 的 `onBeforeRender` 里调用）。 */
export function renderMirrorPlane(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  plane: MirrorPlane,
  waterMaterials: ReadonlySet<THREE.MeshBasicMaterial>,
): void {
  const size = mirrorSizeNow();
  if (!plane.rt || plane.rtSize !== size) {
    // 开关切换时重建；旧 RT 显式释放，避免 GPU 内存堆积。
    plane.rt?.dispose();
    plane.rt = new THREE.WebGLRenderTarget(size, size);
    plane.rtSize = size;
    plane.texture = plane.rt.texture;
  }
  const height = plane.height;
  const vcam = plane.camera;
  // 水平镜面：相机关于 y=height 镜像，看向对称点，up 取反
  vcam.position.set(camera.position.x, 2 * height - camera.position.y, camera.position.z);
  camera.getWorldDirection(_mirrorDir);
  _mirrorLook.copy(camera.position).add(_mirrorDir);
  _mirrorLook.y = 2 * height - _mirrorLook.y;
  // ⚠️ up 必须是**主相机自身 up 关于水平面的镜像**，不能写死 `(0,-1,0)`：
  // 写死时俯视/仰视（如 pitch -80°）下 up 与镜像视线接近平行，lookAt 会退化/滚转，
  // 反射图随视角绕一个点旋转——owner 报的“放射反射倒影”就是这个。
  _mirrorUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _mirrorUp.y = -_mirrorUp.y;
  vcam.up.copy(_mirrorUp);
  vcam.lookAt(_mirrorLook);
  vcam.near = (camera as THREE.PerspectiveCamera).near;
  vcam.far = (camera as THREE.PerspectiveCamera).far;
  vcam.fov = (camera as THREE.PerspectiveCamera).fov ?? vcam.fov;
  vcam.aspect = (camera as THREE.PerspectiveCamera).aspect ?? vcam.aspect;
  vcam.updateMatrixWorld();
  vcam.projectionMatrix.copy((camera as THREE.PerspectiveCamera).projectionMatrix);
  // 纹理矩阵：**不含 modelMatrix**（各水面块的 modelMatrix 在顶点着色器里乘）
  plane.matrix.copy(BIAS).multiply(vcam.projectionMatrix).multiply(vcam.matrixWorldInverse);
  if ((g as { __vbspWaterObliqueClip?: boolean }).__vbspWaterObliqueClip !== false) {
    applyObliqueWaterClip(vcam, height, camera.position.y);
  }

  const prevTarget = renderer.getRenderTarget();
  mirrorRendering = true;
  // 水面在镜像 pass 里必须隐藏：否则水面会采样"上一帧的镜面纹理"形成**自反馈**。
  _mirrorHidden.length = 0;
  for (const m of waterMaterials) {
    if (m.visible) {
      m.visible = false;
      _mirrorHidden.push(m);
    }
  }
  try {
    renderer.setRenderTarget(plane.rt);
    renderer.clear();
    renderer.render(scene, vcam);
  } finally {
    // ⚠️ 必须 finally：中途抛错会让水面材质永远停在 `visible=false` ⇒ 水面直接消失。
    renderer.setRenderTarget(prevTarget);
    for (let i = 0; i < _mirrorHidden.length; i++) _mirrorHidden[i].visible = true;
    _mirrorHidden.length = 0;
    mirrorRendering = false;
  }
  (globalThis as { __vbspWaterMirrorRenders?: number }).__vbspWaterMirrorRenders =
    ((globalThis as { __vbspWaterMirrorRenders?: number }).__vbspWaterMirrorRenders ?? 0) + 1;
}
