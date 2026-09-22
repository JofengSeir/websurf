/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/phys/NOTICE for modification details.

// 轻量可变向量工具：`{x, y, z}` 普通对象，写入型函数把结果写进第一个参数 `out` 并返回它。
// 坐标约定 Y 轴朝上（Source 的 z 轴映射到 y）。
// 本文件 13 个函数在本仓无调用点；被引用的是 `Vec3` 接口，5 个文件以 `import type` 取用：
// `apps/debug/src/game-state.ts`、`apps/debug/src/world/collider-adapter.ts`、
// `apps/debug/src/world/spawn-loader.ts`、`apps/debug/src/world/teleport-manager.ts`、
// `apps/debug/src/physics/physics/Collision/Collision.types.ts`。

/** 三维向量（可变、无方法）。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 新建向量；三个分量默认 0。 */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** 逐分量拷贝 `a` 到 `out`。 */
export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

/** 逐分量写入三个标量。 */
export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** 逐分量相加 `a + b`。 */
export function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

/** 逐分量相减 `a − b`。 */
export function sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

/** `a + b × s`（累加缩放）。 */
export function addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

/** 逐分量缩放 `a × s`。 */
export function scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** 点积。 */
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** 叉积 `a × b`；先把三个分量算进局部变量再写 `out`，故 `out` 与 `a` / `b` 同引用也安全。 */
export function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return set(out, x, y, z);
}

/** 模长。 */
export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** 模长平方（省一次开方）。 */
export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

/** 水平模长：Y 轴朝上，故只取 x / z 两个分量。 */
export function length2D(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

/** 原地归一化 `a`，返回归一化前的模长；模长为 0 时不改 `a`，返回 0。 */
export function normalize(a: Vec3): number {
  const len = length(a);
  if (len > 0) {
    const inv = 1 / len;
    a.x *= inv;
    a.y *= inv;
    a.z *= inv;
  }
  return len;
}

/** 新建一份分量拷贝。 */
export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}
