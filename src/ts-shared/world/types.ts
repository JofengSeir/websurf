/**
 * PVS 共享类型：`parse_pvs_data` 输出的 JSON 形状。
 *
 * 三类型的**唯一定义点**在此；两个消费工程各自 `export type { … } from` 转出以保持
 * 工程内既有 import 路径：`apps/debug/src/world/types.ts`、`apps/game/src/world/types.ts`
 * （`apps/viewer` 无 PVS 通路，不存在对应文件）。
 *
 * 字段名来自 Rust 侧的 `#[serde(rename_all = "camelCase")]`，故 JSON 为 camelCase
 * （与同一导出层的 `parse_spawn_points` / `parse_teleports` 的 snake_case 不同）。
 *
 * 坐标：本组向量在 Rust 侧已旋转为 Y-up（`[x,y,z] → [y,z,x]`，det = +1），TS 侧不再重映射。
 *
 * 本模块**不**引入共享 `Vec3` 类型：消费方 `PvsManager` 的入参只要求结构等价的 `{x;y;z}`，
 * 因此各工程继续传自己的类型——`apps/debug/src/physics/math/vec3.ts` 的 `Vec3`、
 * `apps/game/src/world/types.ts` 的 `Vec3Like` / `Vec3`，无编译期耦合。
 */

/** BSP 树内部节点（用于 cluster 定位）。 */
export interface WasmPvsNode {
  /** 分割平面法线（已旋转为 Y-up）。`plane_index` 越界时 Rust 侧回落到默认平面 `{0,0,1}`。 */
  normal: [number, number, number];
  /** 分割平面 dist（标量，旋转不变；默认平面时为 0）。 */
  dist: number;
  /** 子节点索引 `[front, back]`，负值表示 leaf（`~index` 取 leaf 索引）。 */
  children: [number, number];
}

/** BSP 叶子节点。 */
export interface WasmPvsLeaf {
  /** 所属 cluster id（负值表示固体 leaf）。 */
  cluster: number;
  /** AABB min（已旋转为 Y-up，i16 精度）。 */
  mins: [number, number, number];
  /** AABB max（已旋转为 Y-up，i16 精度）。 */
  maxs: [number, number, number];
  /** 是否为固体 leaf（cluster < 0）。 */
  isSolid: boolean;
}

/** `parse_pvs_data` 返回的 JSON 顶层结构。 */
export interface WasmPvsData {
  /** 根节点索引（Rust 侧硬编码为 `0`）。**TS 侧无消费点**：`PvsManager` 一律从索引 0 起步。 */
  rootNode: number;
  /** BSP 树内部节点列表。 */
  nodes: WasmPvsNode[];
  /** 叶子节点列表（保持原始 BSP 顺序，与 node.children 索引对应）。 */
  leaves: WasmPvsLeaf[];
  /**
   * face → cluster 映射，长度 = face 总数，初值全为 `-1`。
   * Rust 侧由**非固体 leaf** 的 `first_leaf_face` / `leaf_face_count` 区间回填，同一 face 只取
   * **首个**命中的非固体 cluster（`face_clusters[face] < 0` 时才写）。固体 face 与未被任何
   * leaf 覆盖的 face 保持 `-1`。
   */
  faceClusters: number[];
  /**
   * 预解码的 PVS 位图，标准 base64，解出长度 = `clusterCount × bytesPerRow`。
   * 可见性判据：`bits[cluster * bytesPerRow + target / 8]` 的第 `target % 8` 位为 1
   * ⇒ 从 `cluster` 可见 `target`。`clusterCount == 0` 时为空串。
   * 边界：`clusterCount > 0` 而 Rust 侧 `pvs_offsets` 为空时不解码，位图保持全 0
   * ⇒ base64 仍非空（消费方的「有 PVS」判据只看串长，见 `PvsManager` 的 `hasPvs`）。
   */
  pvsBitsBase64: string;
  /** cluster 总数（`u32`）。 */
  clusterCount: number;
  /** 每个 cluster 行的字节数 = `ceil(clusterCount / 8)`。 */
  bytesPerRow: number;
}
