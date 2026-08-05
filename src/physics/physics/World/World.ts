/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { Vec3 } from '../../math/vec3.js';
import { traceBox, boxInBrush } from '../Collision/Collision.js';
import { BrushGrid } from '../Collision/brush-grid.js';
import type { Brush, LadderVolume, TraceResult } from '../Collision/Collision.types.js';

/**
 * 世界碰撞容器。
 *
 * 用均匀网格（BrushGrid）做 broadphase：碰撞体可达 2.7 万个时，
 * `trace`/`isPositionFree` 只查询扫描体覆盖的 cell，候选集从全量降到数百。
 *
 * 索引**惰性构建** + 长度变化检测：
 * - 生产路径一次性 `solids = [...]` 后只 build 一次；
 * - 测试/运行时直接 `world.solids.push(...)` 也能自动失效重建（长度变化即重建）。
 */
export class World {
  solids: Brush[] = [];
  ladders: LadderVolume[] = [];

  /** 空间索引（惰性构建）。 */
  private readonly grid = new BrushGrid();
  /** grid 构建时的 solids 引用（引用变化 = 需要重建）。 */
  private gridBuiltFor: Brush[] | null = null;
  /** grid 构建时的 solids 长度（push 等原地修改也能检测）。 */
  private gridBuiltLen = -1;

  trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): TraceResult {
    this.ensureGrid();

    // 扫描体 AABB（与 traceBox 内部一致），交给网格缩小候选集
    const pad = 1;
    const sMinX = Math.min(start.x, end.x) + mins.x - pad;
    const sMinY = Math.min(start.y, end.y) + mins.y - pad;
    const sMinZ = Math.min(start.z, end.z) + mins.z - pad;
    const sMaxX = Math.max(start.x, end.x) + maxs.x + pad;
    const sMaxY = Math.max(start.y, end.y) + maxs.y + pad;
    const sMaxZ = Math.max(start.z, end.z) + maxs.z + pad;

    const candidates = this.grid.query(
      { x: sMinX, y: sMinY, z: sMinZ },
      { x: sMaxX, y: sMaxY, z: sMaxZ },
    );
    return traceBox(start, end, mins, maxs, candidates);
  }

  /** Can a hull of mins/maxs exist at origin without intersecting the world? */
  isPositionFree(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
    this.ensureGrid();
    const candidates = this.grid.query(
      {
        x: origin.x + mins.x - 1,
        y: origin.y + mins.y - 1,
        z: origin.z + mins.z - 1,
      },
      {
        x: origin.x + maxs.x + 1,
        y: origin.y + maxs.y + 1,
        z: origin.z + maxs.z + 1,
      },
    );
    const tr = traceBox(origin, origin, mins, maxs, candidates);
    return !tr.startSolid;
  }

  ladderAt(origin: Vec3, mins: Vec3, maxs: Vec3): LadderVolume | null {
    for (const ladder of this.ladders) {
      if (boxInBrush(origin, mins, maxs, ladder)) return ladder;
    }
    return null;
  }

  /**
   * 惰性构建空间索引（引用或长度变化时重建）。
   */
  private ensureGrid(): void {
    if (this.gridBuiltFor !== this.solids || this.gridBuiltLen !== this.solids.length) {
      this.grid.build(this.solids);
      this.gridBuiltFor = this.solids;
      this.gridBuiltLen = this.solids.length;
    }
  }
}
