/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Derived from @unsurf/cs-movement; added by WebSurf — see src/physics/NOTICE.


/**
 * 均匀网格空间索引（Broadphase）。
 *
 * 地图碰撞体数量可达 2.7 万（surf_nsz_fix：4923 地图 brush + 22017 模型碰撞体），
 * `traceBox` 若每帧线性遍历全部 brush 会造成明显卡顿。本类把 brush 按 AABB
 * 分桶到均匀网格，trace 时只查询扫描体覆盖的 cell，候选集从 2.7 万降到数百。
 *
 * 设计要点：
 * - **大 brush**（跨 cell 数超过 `BIG_CELL_LIMIT`，如世界地面 8192²）单独存 list，
 *   query 时始终参与——避免大 brush 把成千上万个 cell 都填满，插入/查询爆炸。
 * - **去重**：跨 cell 的 brush 会被多个 cell 引用，用 epoch 计数避免重复返回，
 *   不分配 Set（高频 trace 场景的 GC 压力）。
 * - **正确性**：query 返回的是超集（cell 覆盖 + 大 brush），调用方 `traceBox`
 *   内部还有精确 AABB 过滤兜底，结果与全量遍历完全一致。
 */
import type { Brush } from './Collision.types.js';
export class BrushGrid {
  private cellSize: number;
  private brushes: Brush[] = [];
  /** cell → brush 索引列表。key = "cx,cy,cz"。 */
  private cells = new Map<string, number[]>();
  /** 跨 cell 过多的大 brush 索引（query 时始终参与）。 */
  private big: number[] = [];
  /** epoch 去重标记数组。 */
  private visited: Int32Array = new Int32Array(0);
  private queryEpoch = 0;

  constructor(cellSize = 512) {
    this.cellSize = cellSize;
  }

  /** 当前索引的 brush 数组（用于调用方判断是否需要重建）。 */
  get indexedBrushes(): Brush[] {
    return this.brushes;
  }

  /** 网格 cell 大小（HU）。 */
  get cellSizePx(): number {
    return this.cellSize;
  }

  /**
   * 重建索引（O(N) 插入）。
   *
   * @param brushes 全部 brush（含 solids/ladders 合并后的列表）。
   * @param cellSize 网格 cell 大小（HU），默认 512。
   */
  build(brushes: Brush[], cellSize = 512): void {
    this.brushes = brushes;
    this.cellSize = cellSize;
    this.cells.clear();
    this.big.length = 0;
    this.visited = new Int32Array(brushes.length);
    this.queryEpoch = 0;

    const inv = 1 / cellSize;
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      const cx0 = Math.floor(b.min.x * inv);
      const cx1 = Math.floor(b.max.x * inv);
      const cy0 = Math.floor(b.min.y * inv);
      const cy1 = Math.floor(b.max.y * inv);
      const cz0 = Math.floor(b.min.z * inv);
      const cz1 = Math.floor(b.max.z * inv);
      const spanX = cx1 - cx0 + 1;
      const spanY = cy1 - cy0 + 1;
      const spanZ = cz1 - cz0 + 1;
      if (spanX * spanY * spanZ > BIG_CELL_LIMIT) {
        // 大 brush：不进 cell，query 时始终参与
        this.big.push(i);
        continue;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const key = cx + ',' + cy + ',' + cz;
            let arr = this.cells.get(key);
            if (!arr) {
              arr = [];
              this.cells.set(key, arr);
            }
            arr.push(i);
          }
        }
      }
    }
  }

  /**
   * 查询与 AABB [min, max] 相交的所有 brush（超集，已去重）。
   *
   * 返回的数组为内部复用的临时数组——调用方应立即使用，
   * 下一次 query 会覆盖其内容。
   */
  query(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }): Brush[] {
    this.queryEpoch++;
    const out = this.tmp;
    out.length = 0;
    const visit = (i: number): void => {
      if (this.visited[i] !== this.queryEpoch) {
        this.visited[i] = this.queryEpoch;
        out.push(this.brushes[i]);
      }
    };

    // 大 brush 始终参与（覆盖范围大，进 cell 会填满网格）
    for (let i = 0; i < this.big.length; i++) visit(this.big[i]);

    const inv = 1 / this.cellSize;
    const cx0 = Math.floor(min.x * inv);
    const cx1 = Math.floor(max.x * inv);
    const cy0 = Math.floor(min.y * inv);
    const cy1 = Math.floor(max.y * inv);
    const cz0 = Math.floor(min.z * inv);
    const cz1 = Math.floor(max.z * inv);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const arr = this.cells.get(cx + ',' + cy + ',' + cz);
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) visit(arr[k]);
        }
      }
    }
    return out;
  }

  /** 复用查询结果数组（避免高频 trace 的分配）。 */
  private readonly tmp: Brush[] = [];
}

/** 单个 brush 可覆盖的最大 cell 数（超过则按"大 brush"处理）。 */
const BIG_CELL_LIMIT = 512;
