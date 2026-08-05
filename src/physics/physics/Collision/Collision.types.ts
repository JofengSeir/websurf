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

export interface TraceResult {
  fraction: number; // 移动完成比例 0..1
  endPos: Vec3;
  normal: Vec3 | null; // 命中平面；fraction === 1 时为 null
  startSolid: boolean;
  allSolid: boolean;
}
