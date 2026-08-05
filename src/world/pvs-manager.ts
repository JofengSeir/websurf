/**
 * PVS 可见性管理器
 *
 * 将 WASM `parse_pvs_data` 输出的 JSON 转换为运行时 PVS 管理器。
 * 坐标已在 Rust 端旋转为 Y-up（`[x,y,z]→[y,z,x]`），TS 端不再二次重映射。
 *
 * **职责**：
 * - 维护 BSP 树节点 + 叶子节点（用于 cluster 定位）
 * - 维护预解码的 PVS 位图（Base64 → Uint8Array）
 * - `update(pos)`：通过 BSP 树遍历找到相机所在 leaf → 取其 cluster → 解码可见集
 * - `isVisible(clusterId)`：查询某 cluster 是否在当前可见集内
 * - `getFaceCluster(faceIndex)`：查询 face 所属 cluster
 *
 * **算法**：
 * 1. `findLeaf(pos)`：从根节点开始，递归比较 pos 与分割平面，
 *    进入 front/back 子节点，直到到达 leaf。
 * 2. `decodePvsRow(cluster)`：从 PVS 位图中读取该 cluster 的可见行，
 *    转换为 Set<number>。
 * 3. 仅当 cluster 变化时重新解码可见集（避免每帧重算）。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import { type WasmPvsData, type WasmPvsNode, type WasmPvsLeaf } from './types.js';

// ---------------------------------------------------------------------------
// PvsManager
// ---------------------------------------------------------------------------

/** PVS 管理器状态。 */
export interface PvsStats {
  /** 当前 cluster id（-1 = 未初始化 / 固体 leaf）。 */
  currentCluster: number;
  /** 可见 cluster 数量。 */
  visibleCount: number;
  /** 总 cluster 数量。 */
  totalClusters: number;
  /** 是否启用 PVS（地图无 PVS 数据时为 false）。 */
  hasPvs: boolean;
  /** 上次 cluster 变化时的检测坐标。 */
  lastCheckPos: Vec3;
}

/**
 * PVS 可见性管理器。
 *
 * @example
 * ```typescript
 * const wasmJson = await processor.parse_pvs_data();
 * const pvs = new PvsManager(wasmJson);
 *
 * // 在渲染循环中
 * pvs.update(camera.position);
 * for (const mesh of meshes) {
 *   const cluster = pvs.getFaceCluster(mesh.userData.faceIndex);
 *   mesh.visible = pvs.isVisible(cluster);
 * }
 * ```
 */
export class PvsManager {
  private readonly nodes: WasmPvsNode[];
  private readonly leaves: WasmPvsLeaf[];
  private readonly faceClusters: number[];
  private readonly pvsBits: Uint8Array;
  private readonly clusterCount: number;
  private readonly bytesPerRow: number;
  private readonly hasPvs: boolean;

  private currentCluster = -1;
  private visibleSet: Set<number> = new Set();
  private lastCheckPos: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(wasmJson: string) {
    const data: WasmPvsData = JSON.parse(wasmJson);

    this.nodes = data.nodes;
    this.leaves = data.leaves;
    this.faceClusters = data.faceClusters;
    this.clusterCount = data.clusterCount;
    this.bytesPerRow = data.bytesPerRow;
    this.hasPvs = data.clusterCount > 0 && data.pvsBitsBase64.length > 0;

    // Base64 解码 → Uint8Array
    this.pvsBits = this.hasPvs
      ? base64ToUint8Array(data.pvsBitsBase64)
      : new Uint8Array(0);
  }

  // -------------------------------------------------------------------------
  // BSP 树遍历：找到 pos 所在的 leaf
  // -------------------------------------------------------------------------

  /**
   * 通过 BSP 树遍历找到 pos 所在的 leaf 索引。
   *
   * 算法：从根节点开始，对每个内部节点：
   * - 计算 `dot(plane.normal, pos) - plane.dist`
   * - 若 > 0：pos 在平面前侧 → 进入 children[0]（front）
   * - 若 <= 0：pos 在平面后侧 → 进入 children[1]（back）
   * - 子节点为负数表示 leaf：`~children[i]` 取 leaf 索引
   *
   * @param pos 世界坐标（Y-up）。
   * @returns leaf 索引，若遍历失败返回 -1。
   */
  private findLeaf(pos: Vec3): number {
    if (this.nodes.length === 0) {
      return -1;
    }

    let nodeIdx = 0;
    // 防止无限循环（损坏的 BSP 树可能有环）
    let maxDepth = 0;
    const MAX_DEPTH = 256;

    while (nodeIdx >= 0 && maxDepth < MAX_DEPTH) {
      maxDepth++;
      const node = this.nodes[nodeIdx];
      if (!node) {
        return -1;
      }

      // 点到平面的有向距离
      const d =
        node.normal[0] * pos.x +
        node.normal[1] * pos.y +
        node.normal[2] * pos.z -
        node.dist;

      // front（d > 0）→ children[0]，back（d <= 0）→ children[1]
      const childIdx = d > 0 ? node.children[0] : node.children[1];

      if (childIdx < 0) {
        // 负数表示 leaf：~childIdx 取 leaf 索引
        return ~childIdx;
      }
      nodeIdx = childIdx;
    }

    return -1;
  }

  // -------------------------------------------------------------------------
  // PVS 位图解码
  // -------------------------------------------------------------------------

  /**
   * 解码指定 cluster 的 PVS 行，返回可见 cluster 集合。
   *
   * PVS 位图布局：`pvsBits[cluster * bytesPerRow + (target / 8)]` 的第
   * `(target % 8)` 位为 1 表示从 `cluster` 可见 `target`。
   *
   * @param cluster 源 cluster id。
   * @returns 可见 cluster 集合（包含自身）。
   */
  private decodePvsRow(cluster: number): Set<number> {
    const visible = new Set<number>();
    if (cluster < 0 || cluster >= this.clusterCount) {
      return visible;
    }

    // 自身总是可见
    visible.add(cluster);

    const rowStart = cluster * this.bytesPerRow;
    if (rowStart + this.bytesPerRow > this.pvsBits.length) {
      return visible; // 边界保护
    }

    // 遍历该行的每个字节
    for (let byteIdx = 0; byteIdx < this.bytesPerRow; byteIdx++) {
      const byte = this.pvsBits[rowStart + byteIdx];
      if (byte === 0) {
        continue;
      }
      // 检查每个位
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (1 << bit)) !== 0) {
          const targetCluster = byteIdx * 8 + bit;
          if (targetCluster < this.clusterCount) {
            visible.add(targetCluster);
          }
        }
      }
    }

    return visible;
  }

  // -------------------------------------------------------------------------
  // 公共 API
  // -------------------------------------------------------------------------

  /**
   * 更新 PVS 状态（基于相机位置）。
   *
   * 仅当 cluster 变化时重新解码可见集（避免每帧重算）。
   *
   * @param pos 相机世界坐标（Y-up）。
   * @returns true 表示 cluster 发生变化（需要重新应用可见性）。
   */
  update(pos: Vec3): boolean {
    this.lastCheckPos = { x: pos.x, y: pos.y, z: pos.z };

    if (!this.hasPvs) {
      return false;
    }

    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) {
      return false;
    }

    const leaf = this.leaves[leafIdx];
    const newCluster = leaf.cluster;

    if (newCluster === this.currentCluster) {
      return false; // cluster 未变，无需重算
    }

    // 激进模式：相机落在固体 leaf（cluster < 0）时保持上次有效可见集，
    // 而不是清空后全量回退到距离 LOD（穿墙/贴墙瞬间不闪变）。
    // 仅当从未有过有效 cluster 时维持 -1（此时上层会跳过 PVS）。
    if (newCluster < 0) {
      return false;
    }

    this.currentCluster = newCluster;
    this.visibleSet = this.decodePvsRow(newCluster);
    return true;
  }

  /**
   * 查询世界坐标点所在的 cluster（用于 mesh 包围盒采样定位）。
   *
   * 激进剔除的核心：mesh 不再依赖 face → cluster 静态映射
   * （历史上 faceIndex 从未写入，导致 clusterId 恒为 -1、PVS 永不生效），
   * 而是按 mesh 包围盒多个采样点定位其覆盖的 cluster 集合。
   *
   * @param pos 世界坐标（Y-up）。
   * @returns cluster id（-1 = 固体/地图外）。
   */
  getClusterAt(pos: Vec3): number {
    if (!this.hasPvs) {
      return -1;
    }
    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) {
      return -1;
    }
    return this.leaves[leafIdx].cluster;
  }

  /**
   * 查询某 cluster 是否在当前可见集内。
   *
   * @param clusterId 目标 cluster id。
   * @returns true 表示可见（或 PVS 未启用时总是 true）。
   */
  isVisible(clusterId: number): boolean {
    if (!this.hasPvs || clusterId < 0) {
      return true; // 无 PVS 或无效 cluster → 全部可见
    }
    return this.visibleSet.has(clusterId);
  }

  /**
   * 查询 face 所属 cluster。
   *
   * @param faceIndex face 索引。
   * @returns cluster id（-1 = 无 cluster / 固体）。
   */
  getFaceCluster(faceIndex: number): number {
    if (faceIndex < 0 || faceIndex >= this.faceClusters.length) {
      return -1;
    }
    return this.faceClusters[faceIndex];
  }

  /** 获取当前状态（用于 UI 显示）。 */
  getStats(): PvsStats {
    return {
      currentCluster: this.currentCluster,
      visibleCount: this.visibleSet.size,
      totalClusters: this.clusterCount,
      hasPvs: this.hasPvs,
      lastCheckPos: { ...this.lastCheckPos },
    };
  }

  /** 是否启用 PVS。 */
  get enabled(): boolean {
    return this.hasPvs;
  }

  /** 当前 cluster id（-1 = 未初始化）。 */
  get currentClusterId(): number {
    return this.currentCluster;
  }

  /** 可见 cluster 数量。 */
  get visibleClusterCount(): number {
    return this.visibleSet.size;
  }
}

// ---------------------------------------------------------------------------
// Base64 解码辅助
// ---------------------------------------------------------------------------

/**
 * 将 Base64 字符串解码为 Uint8Array。
 *
 * 使用浏览器原生 `atob` + 手动字节拷贝（比 TextEncoder 更快）。
 * 在 Worker 环境中 `atob` 可用。
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
