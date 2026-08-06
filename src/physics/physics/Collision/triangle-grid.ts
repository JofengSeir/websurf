/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — 三角形网格碰撞的空间索引（broadphase）。

import type { TriMesh } from './Collision.types.js';

/** 索引中的一个三角形条目（引用所属 mesh 与索引）。 */
export interface TriEntry {
  mesh: TriMesh;
  a: number;
  b: number;
  c: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * 均匀网格空间索引（模型三角形碰撞的 broadphase）。
 *
 * 模型可视网格三角形可达数万~数十万个，线性遍历会让每帧多次的 trace 卡死物理线程。
 * 按三角形 AABB 分桶到网格后，trace 只查询扫描体覆盖的 cell，候选集降到数百。
 *
 * - **大三角形**（跨 cell 超 `BIG_CELL_LIMIT`）单独存 big 列表、query 始终参与；
 * - **去重**：跨 cell 条目被多个 cell 引用，用 epoch 计数去重，不分配 Set（避免 GC）；
 * - **正确性**：query 返回超集，`clipBoxToTriangle` 内部精确过滤，结果与全量一致。
 */
export class TriangleGrid {
  private cellSize = 256;
  private entries: TriEntry[] = [];
  /** cell → entry 索引列表。key = "cx,cy,cz"。 */
  private cells = new Map<string, number[]>();
  /** 跨 cell 过多的大三角形索引（query 时始终参与）。 */
  private big: number[] = [];
  /** epoch 去重标记数组。 */
  private visited: Int32Array = new Int32Array(0);
  private queryEpoch = 0;

  /** 最近一次 build 的 meshes 引用（调用方判断是否需重建）。 */
  private builtFor: TriMesh[] | null = null;
  private builtLen = -1;

  /** meshes 引用或长度变化 → 需要重建。 */
  needsRebuild(meshes: TriMesh[]): boolean {
    return this.builtFor !== meshes || this.builtLen !== meshes.length;
  }

  /**
   * 重建索引（O(N) 插入）。
   * @param meshes 全部模型三角形网格。
   * @param cellSize 网格 cell 大小（HU），默认 256（模型三角形远小于地图 brush）。
   */
  build(meshes: TriMesh[], cellSize = 256): void {
    this.builtFor = meshes;
    this.builtLen = meshes.length;
    this.cellSize = cellSize;
    this.cells.clear();
    this.big.length = 0;
    this.entries.length = 0;

    const inv = 1 / cellSize;
    for (const mesh of meshes) {
      const v = mesh.vertices;
      for (const [a, b, c] of mesh.indices) {
        const va = v[a];
        const vb = v[b];
        const vc = v[c];
        // 顶点是紧凑数组 `[x, y, z]`（Rust serde 序列化格式）
        const minX = Math.min(va[0], vb[0], vc[0]);
        const maxX = Math.max(va[0], vb[0], vc[0]);
        const minY = Math.min(va[1], vb[1], vc[1]);
        const maxY = Math.max(va[1], vb[1], vc[1]);
        const minZ = Math.min(va[2], vb[2], vc[2]);
        const maxZ = Math.max(va[2], vb[2], vc[2]);
        const idx = this.entries.length;
        this.entries.push({ mesh, a, b, c, minX, minY, minZ, maxX, maxY, maxZ });

        const cx0 = Math.floor(minX * inv);
        const cx1 = Math.floor(maxX * inv);
        const cy0 = Math.floor(minY * inv);
        const cy1 = Math.floor(maxY * inv);
        const cz0 = Math.floor(minZ * inv);
        const cz1 = Math.floor(maxZ * inv);
        const span = (cx1 - cx0 + 1) * (cy1 - cy0 + 1) * (cz1 - cz0 + 1);
        if (span > BIG_CELL_LIMIT) {
          this.big.push(idx);
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
              arr.push(idx);
            }
          }
        }
      }
    }
    this.visited = new Int32Array(this.entries.length);
    this.queryEpoch = 0;
  }

  /** 总索引三角形数。 */
  get count(): number {
    return this.entries.length;
  }

  /**
   * 查询与 AABB [min, max] 相交的所有三角形（超集，已去重）。
   * 返回内部复用数组——调用方应立即使用，下次 query 会覆盖内容。
   */
  query(
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
  ): TriEntry[] {
    this.queryEpoch++;
    const out = this.tmp;
    out.length = 0;
    const visit = (i: number): void => {
      if (this.visited[i] !== this.queryEpoch) {
        this.visited[i] = this.queryEpoch;
        out.push(this.entries[i]);
      }
    };

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
  private readonly tmp: TriEntry[] = [];
}

/** 单个三角形可覆盖的最大 cell 数（超过则按"大三角形"处理）。 */
const BIG_CELL_LIMIT = 512;
