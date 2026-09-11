/**
 * 世界（PVS）共享类型（D-10）。
 *
 * 三类型原为 debug / game 两工程各一份重复声明
 * （`apps/debug/src/world/types.ts` 与 `apps/game/src/world/types.ts`），
 * 字段名、类型、顺序全等，仅注释多寡不同。上提后两份工程文件改为
 * `export type { … } from` re-export，工程内调用方路径不变。
 *
 * **Vec3**：本模块**不**引入共享 `Vec3`（D-07 判「保留」——TS 结构化类型下
 * 两份 `{x;y;z}` 互相赋值合法，无编译期耦合）。`PvsManager` 只消费结构等价的
 * `{x;y;z}`，故各工程可继续传自己的 `Vec3` / `Vec3Like`。
 */

/** BSP 树内部节点（用于 cluster 定位）。 */
export interface WasmPvsNode {
  /** 分割平面法线（已旋转为 Y-up）。 */
  normal: [number, number, number];
  /** 分割平面 dist（标量，旋转不变）。 */
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
  /** 根节点索引（始终为 0）。 */
  rootNode: number;
  /** BSP 树内部节点列表。 */
  nodes: WasmPvsNode[];
  /** 叶子节点列表（保持原始 BSP 顺序，与 node.children 索引对应）。 */
  leaves: WasmPvsLeaf[];
  /** face → cluster 映射（-1 = 无 cluster / 固体）。 */
  faceClusters: number[];
  /** 预解码的 PVS 位图（Base64 编码）。 */
  pvsBitsBase64: string;
  /** cluster 总数。 */
  clusterCount: number;
  /** 每个 cluster 行的字节数。 */
  bytesPerRow: number;
}
