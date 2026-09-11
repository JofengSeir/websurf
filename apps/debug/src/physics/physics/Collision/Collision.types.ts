/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { Vec3 } from '../../math/vec3.js';

export interface Plane {
  normal: Vec3; // 朝外的单位法线
  dist: number; // dot(normal, pointOnPlane)；dot(n, p) <= dist 即在内侧
}

export interface Brush {
  planes: Plane[];
  min: Vec3; // AABB 边界（宽阶段用）
  max: Vec3;
}

export interface LadderVolume extends Brush {
  /** 可攀爬面的朝向（远离墙面，水平）。 */
  facing: Vec3;
}

/** 紧凑三元组（与 Rust `[f32; 3]` 的 serde_json 序列化一致）：`[x, y, z]`。 */
export type V3Tuple = [number, number, number];

/** 三角形网格碰撞体（模型可视网格原样导出，不做任何转化）。 */
export interface TriMesh {
  /** 世界空间顶点（与 GLB 显示网格逐位一致；紧凑数组 `[x, y, z]`）。 */
  vertices: V3Tuple[];
  /** 三角形索引 `[a, b, c]`（引用 vertices）。 */
  indices: Array<[number, number, number]>;
  /** AABB（宽阶段用；紧凑数组）。 */
  min: V3Tuple;
  max: V3Tuple;
  /** 仅 .phy 来源（模型自带碰撞体）存在：引擎碰撞材质名（如 `no_decal`/`grass`）。 */
  surfaceprop?: string;
}

export interface TraceResult {
  fraction: number; // 移动完成比例 0..1
  endPos: Vec3;
  normal: Vec3 | null; // 命中平面；fraction === 1 时为 null
  startSolid: boolean;
  allSolid: boolean;
}
