/**
 * PVS 可见性管理器：把 `parse_pvs_data` 的 JSON 变成运行时可查询的可见集。
 *
 * ## 定位
 * 上游：`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 调 `proc.parse_pvs_data()`
 * 取出 `pvsJson`（坐标已由 Rust 侧旋转为 Y-up）。
 * 构造点：`apps/debug/src/renderer/renderer-main.ts` 与
 * `apps/game/src/renderer/renderer-main.ts` 各持一个实例。
 *
 * ## 成员的实际消费面（实测调用点）
 * - `getClusterAt`：debug 的 `apps/debug/src/renderer/lod-manager.ts` `assignClusterIds`
 *   与 game 的 mesh 采样循环，把 mesh 的采样点映射成 cluster 集合
 * - `update` / `isVisible` / `enabled`：**只有 game** 调用（`ENABLE_PVS` 为真时每帧刷新，
 *   再按「任一 cluster 可见即整块可见」剔除）
 * - `currentClusterId` / `getStats`：debug 的 HUD 读数
 * - **零调用点**：`getFaceCluster`、`visibleClusterCount`
 *
 * ## 关键不变量
 * - `update(pos)` 只在「新 cluster 有效且与当前不同」时返回 `true`，其余分支一律 `false`
 * - 落在固体 leaf（`cluster < 0`）时**保留上次可见集**，不清空——避免穿墙瞬间闪变
 * - 可见集恒含自身 cluster（`decodePvsRow` 先加自身）
 * - debug 侧不调 `update`，故那边 `currentClusterId` 恒为 -1、`getStats().visibleCount` 恒为 0
 *
 * ## 边界与容错
 * - `findLeaf` 有深度上限，遇环 / 坏索引 / 空节点表一律返回 -1
 * - `decodePvsRow` 行越界时退化为「只可见自身」
 * - `isVisible` 在无 PVS 或 `clusterId < 0` 时一律返回 `true`（取保守方向）
 * - 本文件无测试文件
 */

import type { WasmPvsData, WasmPvsNode, WasmPvsLeaf } from './types.js';
import { base64ToBytes } from '../wasm/loader.js';

/**
 * 相机位置入参。只要求结构等价 `{x;y;z}`，故不引入共享向量类型——各工程传自己的
 * `Vec3`（`apps/debug/src/physics/math/vec3.ts`）/ `Vec3Like`（`apps/game/src/world/types.ts`）。
 */
interface PvsVec3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// PvsManager
// ---------------------------------------------------------------------------

/** `getStats()` 的返回形状（纯数据快照，不含方法）。 */
export interface PvsStats {
  /** 当前 cluster id；-1 表示尚未成功更新过，或相机落在固体 leaf。 */
  currentCluster: number;
  /** 当前可见集的元素个数（含自身 cluster）。 */
  visibleCount: number;
  /** 地图的 cluster 总数（取自 JSON 的 `clusterCount`）。 */
  totalClusters: number;
  /** 是否持有可用 PVS 位图；为 false 时 `update` / `getClusterAt` 直接短路。 */
  hasPvs: boolean;
  /** 最近一次 `update` 入参的副本（每次进入 `update` 都刷新，含未生效的分支）。 */
  lastCheckPos: PvsVec3;
}

/**
 * PVS 可见性管理器。典型用法分两步：
 * 1. 装载后把每个 mesh 的包围盒采样点交给 `getClusterAt`，得到 `clusterIds` 集合；
 * 2. 每帧用相机位置调 `update(pos)`，再以 `isVisible(clusterId)` 判定某个 cluster 是否可见
 *    （`clusterIds` 中任一命中即整块可见）。
 */
export class PvsManager {
  /** BSP 树内部节点（来自 JSON，构造后只读）。 */
  private readonly nodes: WasmPvsNode[];
  /** 叶子列表（原始 BSP 顺序；`findLeaf` 的返回值直接作下标）。 */
  private readonly leaves: WasmPvsLeaf[];
  /** face → cluster 映射（只被 `getFaceCluster` 读；该方法是零调用点成员）。 */
  private readonly faceClusters: number[];
  /** 解码后的 PVS 位图；`hasPvs` 为 false 时是长度 0 的空数组（此时不会被读）。 */
  private readonly pvsBits: Uint8Array;
  /** cluster 总数，同时是位图位索引的上界。 */
  private readonly clusterCount: number;
  /** 每行字节数，用于把 cluster 映射到 `pvsBits` 的行首。 */
  private readonly bytesPerRow: number;
  /** `clusterCount > 0` 且 base64 串非空；两者缺一即视为无 PVS。 */
  private readonly hasPvs: boolean;

  /** 当前 cluster；只在 `update` 走到「有效且变化」分支时改写。 */
  private currentCluster = -1;
  /** 当前可见集；`update` 的失败分支不会清空它（见 `update` 的固体 leaf 分支）。 */
  private visibleSet: Set<number> = new Set();
  /** 最近一次 `update` 的入参副本（无论该次更新是否生效）。 */
  private lastCheckPos: PvsVec3 = { x: 0, y: 0, z: 0 };

  /**
   * 解析 JSON 并预解码位图。
   * 只做一次 `base64ToBytes`；`hasPvs` 为 false 时跳过解码并留空数组，后续查询走短路分支。
   * @param wasmJson `parse_pvs_data` 的原始 JSON 字符串。
   */
  constructor(wasmJson: string) {
    const data: WasmPvsData = JSON.parse(wasmJson);

    this.nodes = data.nodes;
    this.leaves = data.leaves;
    this.faceClusters = data.faceClusters;
    this.clusterCount = data.clusterCount;
    this.bytesPerRow = data.bytesPerRow;
    this.hasPvs = data.clusterCount > 0 && data.pvsBitsBase64.length > 0;

    // Base64 解码 → Uint8Array（共享单点：src/ts-shared/wasm/loader.ts 的 base64ToBytes）
    this.pvsBits = this.hasPvs
      ? base64ToBytes(data.pvsBitsBase64)
      : new Uint8Array(0);
  }

  // -------------------------------------------------------------------------
  // BSP 树遍历：找到 pos 所在的 leaf
  // -------------------------------------------------------------------------

  /**
   * 从索引 0 起沿 BSP 树下行，返回命中 leaf 的下标。
   *
   * 每步以 `dot(normal, pos) - dist` 定侧：`> 0` 走 `children[0]`（front），`<= 0` 走
   * `children[1]`（back）。子索引为负表示到达 leaf，`~childIdx` 还原出 leaf 下标
   * （`-1 → 0`、`-2 → 1`）。
   *
   * 以下情况返回 -1：节点表为空；当前下标取不到节点（稀疏数组）；循环次数触到
   * `MAX_DEPTH`（防损坏 BSP 形成环时死循环）。
   *
   * @param pos 世界坐标（Y-up）。
   * @returns leaf 下标；-1 表示未能定位。
   */
  private findLeaf(pos: PvsVec3): number {
    if (this.nodes.length === 0) {
      return -1;
    }

    let nodeIdx = 0;
    // 深度上限：损坏的 BSP 树若自成环，靠它跳出循环
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
   * 解出 `cluster` 这一行的可见集。
   *
   * 先把 `cluster` 自身加入结果（PVS 行不含自身位时也可见）；再做行越界检查——
   * `rowStart + bytesPerRow` 超出位图长度即直接返回「只可见自身」。逐字节跳过 0 值字节，
   * 其余按位取出目标 cluster，并丢弃 `>= clusterCount` 的越界位（行尾填充位）。
   *
   * @param cluster 源 cluster id。
   * @returns 可见 cluster 集合（至少含 `cluster`）；入参越界时返回空集。
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
   * 用相机位置推进 PVS 状态。
   *
   * `lastCheckPos` **无条件**刷新（含后面所有失败分支）。只有走到最后两行才会改写
   * `currentCluster` 与 `visibleSet`，此时返回 `true`。返回 `false` 的分支：
   * ① 无 PVS；② leaf 下标无效（-1 或越界）；③ 新 cluster 与当前相同；④ 新 cluster < 0
   * （落在固体 leaf）——该分支**保留**上次可见集与 `currentCluster`，使穿墙瞬间不闪变。
   *
   * 消费方需按返回值决定是否重新应用可见性；仅靠 `isVisible` 查询的调用方也应先调本方法，
   * 否则可见集恒为空（`apps/debug` 即属此情形）。
   *
   * @param pos 相机世界坐标（Y-up）。
   * @returns true 表示 cluster 已变化且可见集已重算。
   */
  update(pos: PvsVec3): boolean {
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

    // 激进模式：落在固体 leaf（cluster < 0）时保持上次有效可见集，避免穿墙瞬间闪变；
    // 仅当从未有过有效 cluster 时维持 -1（此时上层会跳过 PVS）。
    if (newCluster < 0) {
      return false;
    }

    this.currentCluster = newCluster;
    this.visibleSet = this.decodePvsRow(newCluster);
    return true;
  }

  /**
   * 取世界坐标点所在 leaf 的 cluster，不做可见性判定。
   *
   * 用于把 mesh 的包围盒采样点批量映射成 cluster 集合（debug 的 `assignClusterIds`、
   * game 的采样循环都是这个用法）。无 PVS、或 leaf 定位失败时返回 -1；命中固体 leaf 时
   * 返回该 leaf 的负值 cluster 原样（调用方按 `>= 0` 过滤）。
   *
   * @param pos 世界坐标（Y-up）。
   * @returns cluster id（-1 = 固体 / 地图外 / 无 PVS）。
   */
  getClusterAt(pos: PvsVec3): number {
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
   * 查 cluster 是否在**当前**可见集内。
   *
   * 三个返回 `true` 的短路分支（取保守方向，宁可多画不可误剔）：无 PVS；
   * `clusterId < 0`；以及集合命中。注意首次成功 `update` 之前可见集为空，
   * 此时有效 cluster 会得到 `false`。
   *
   * @param clusterId 目标 cluster id。
   * @returns true 表示可见（或无法判定时的保守可见）。
   */
  isVisible(clusterId: number): boolean {
    if (!this.hasPvs || clusterId < 0) {
      return true; // 无 PVS 或无效 cluster → 全部可见
    }
    return this.visibleSet.has(clusterId);
  }

  /**
   * 查 face 所属的 cluster（静态映射，与相机位置无关）。
   *
   * 越界（`faceIndex < 0` 或超过映射长度）返回 -1；表内值为 -1 表示该 face 属固体或
   * 未被任何非固体 leaf 覆盖。**本仓 `src/**` 与 `apps/**` 内零调用点**：消费方改用品
   * 包围盒空间采样 + `getClusterAt` 分配 cluster。
   *
   * @param faceIndex face 索引。
   * @returns cluster id（-1 = 无 cluster / 固体 / 越界）。
   */
  getFaceCluster(faceIndex: number): number {
    if (faceIndex < 0 || faceIndex >= this.faceClusters.length) {
      return -1;
    }
    return this.faceClusters[faceIndex];
  }

  /**
   * 取状态快照。
   *
   * `lastCheckPos` 以展开运算符复制，调用方改返回值不会影响内部记录；其余字段为值类型。
   *
   * @returns 供 HUD / 日志读取的纯数据对象。
   */
  getStats(): PvsStats {
    return {
      currentCluster: this.currentCluster,
      visibleCount: this.visibleSet.size,
      totalClusters: this.clusterCount,
      hasPvs: this.hasPvs,
      lastCheckPos: { ...this.lastCheckPos },
    };
  }

  /**
   * 是否持有可用 PVS。
   * 消费点：`apps/game/src/renderer/renderer-main.ts` 的剔除前置条件（与
   * `currentClusterId >= 0` 一起用）。
   */
  get enabled(): boolean {
    return this.hasPvs;
  }

  /**
   * 当前 cluster id。
   * 消费点：debug 的 HUD cluster 显示、game 的剔除前置条件。未成功更新过时为 -1。
   */
  get currentClusterId(): number {
    return this.currentCluster;
  }

  /** 当前可见集的元素个数。**本仓零调用点**（同数据可从 `getStats().visibleCount` 取）。 */
  get visibleClusterCount(): number {
    return this.visibleSet.size;
  }
}
