/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

import type { Vec3 } from '../../math/vec3.js';
import { traceBox, traceBoxTriEntries, boxInBrush } from '../Collision/Collision.js';
import { BrushGrid } from '../Collision/brush-grid.js';
import { TriangleGrid } from '../Collision/triangle-grid.js';
import type { Brush, LadderVolume, TraceResult, TriMesh } from '../Collision/Collision.types.js';

/**
 * 世界碰撞容器。
 *
 * 用均匀网格（BrushGrid）做 brush 的 broadphase；模型三角形碰撞（`triMeshes`）
 * 用独立网格（TriangleGrid）做 broadphase——模型可视网格三角形可达数万~数十万个，
 * 必须索引后才能每帧多次 trace，否则物理线程被拖死。
 *
 * 索引**惰性构建** + 引用/长度变化检测。
 */
export class World {
  solids: Brush[] = [];
  ladders: LadderVolume[] = [];
  /** 模型可视网格碰撞（三角形，世界空间，与显示逐位一致）。 */
  triMeshes: TriMesh[] = [];

  /** brush 空间索引（惰性构建）。 */
  private readonly grid = new BrushGrid();
  /** brush grid 构建时的 solids 引用（引用变化 = 需要重建）。 */
  private gridBuiltFor: Brush[] | null = null;
  /** brush grid 构建时的 solids 长度（push 等原地修改也能检测）。 */
  private gridBuiltLen = -1;

  /** 三角形空间索引（惰性构建）。 */
  private readonly triGrid = new TriangleGrid();

  trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): TraceResult {
    this.ensureGrid();
    this.ensureTriGrid();

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
    const brushResult = traceBox(start, end, mins, maxs, candidates);

    // 模型三角形碰撞：网格候选 + 三角形 clip，取更早命中者
    if (this.triMeshes.length > 0) {
      const triCandidates = this.triGrid.query(
        { x: sMinX, y: sMinY, z: sMinZ },
        { x: sMaxX, y: sMaxY, z: sMaxZ },
      );
      const triResult = traceBoxTriEntries(start, end, mins, maxs, triCandidates);
      if (triResult.fraction < brushResult.fraction) {
        return triResult;
      }
    }
    return brushResult;
  }

  /** mins/maxs 碰撞箱在 origin 处能否不与世界相交。 */
  isPositionFree(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
    this.ensureGrid();
    this.ensureTriGrid();
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
    if (tr.startSolid) return false;
    if (this.triMeshes.length > 0) {
      const triCandidates = this.triGrid.query(
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
      const triTr = traceBoxTriEntries(origin, origin, mins, maxs, triCandidates);
      if (triTr.startSolid) return false;
    }
    return true;
  }

  /** 惰性构建 brush 空间索引（引用或长度变化时重建）。 */
  private ensureGrid(): void {
    if (this.gridBuiltFor !== this.solids || this.gridBuiltLen !== this.solids.length) {
      this.grid.build(this.solids);
      this.gridBuiltFor = this.solids;
      this.gridBuiltLen = this.solids.length;
    }
  }

  /** 惰性构建三角形空间索引（引用或长度变化时重建）。 */
  private ensureTriGrid(): void {
    if (this.triGrid.needsRebuild(this.triMeshes)) {
      this.triGrid.build(this.triMeshes);
    }
  }

  ladderAt(origin: Vec3, mins: Vec3, maxs: Vec3): LadderVolume | null {
    for (const ladder of this.ladders) {
      if (boxInBrush(origin, mins, maxs, ladder)) return ladder;
    }
    return null;
  }
}
