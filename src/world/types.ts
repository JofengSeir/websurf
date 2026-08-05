/**
 * 世界适配层类型定义：对应 Rust WASM 端 export_brushes_planes / parse_spawn_points /
 * parse_teleports / parse_pvs_data 输出的 JSON 结构。
 * 坐标约定：Rust 端已旋转为 Y-up（[x,y,z]→[y,z,x]，det=+1），TS 端不再二次重映射。
 */

// ---------------------------------------------------------------------------
// §7.2 WasmBrush JSON Schema（核心契约）
// ---------------------------------------------------------------------------

/** WASM 导出的 brush 平面（对应 Rust `WasmBrushPlane`）。 */
export interface WasmBrushPlane {
  /** 法线 `[x, y, z]`，已在 Rust 端旋转为 Y-up，朝外。 */
  normal: [number, number, number];
  /** `dot(normal, pointOnPlane)`，标量，旋转不变（正交变换）。 */
  dist: number;
}

/** WASM 导出的 brush（对应 Rust `WasmBrush`）。 */
export interface WasmBrush {
  /** 平面列表（至少 4 个）。 */
  planes: WasmBrushPlane[];
  /** brush AABB min，已在 Rust 端旋转。 */
  min: [number, number, number];
  /** brush AABB max，已在 Rust 端旋转。 */
  max: [number, number, number];
  /** `BrushFlags::LADDER` 标志。 */
  is_ladder: boolean;
  /** `BrushFlags::SOLID` 标志。 */
  is_solid: boolean;
}

// ---------------------------------------------------------------------------
// 出生点（parse_spawn_points）— snake_case（Rust 无 rename_all）
// ---------------------------------------------------------------------------

/** WASM 导出的出生点实体。 */
export interface WasmSpawnPoint {
  /** classname（如 `info_player_start`）。 */
  classname: string;
  /** 出生坐标 `[x, y, z]`，已在 Rust 端旋转为 Y-up（`[x,y,z]→[y,z,x]`）。 */
  origin: [number, number, number];
  /** 角度 `[pitch, yaw, roll]`，BSP 原始（yaw 在 BSP/Three.js 中都是绕 up 轴）。 */
  angles: [number, number, number];
  /** 原始 origin 字符串（调试用）。 */
  origin_raw: string;
  /** 原始 angles 字符串（调试用，可能为 null）。 */
  angles_raw: string | null;
}

/** `parse_spawn_points` 返回的 JSON 顶层结构。 */
export interface WasmSpawnReport {
  spawn_points: WasmSpawnPoint[];
  total: number;
  /** 推荐的出生点索引（优先 `info_player_start`），可能为 null。 */
  primary: number | null;
}

// ---------------------------------------------------------------------------
// 传送点（parse_teleports）— snake_case（Rust 无 rename_all）
// ---------------------------------------------------------------------------

/** 传送目标点。 */
export interface WasmTeleportDest {
  index: number;
  targetname: string;
  /** 已在 Rust 端旋转为 Y-up。 */
  origin: [number, number, number];
  /** BSP 原始 `[pitch, yaw, roll]`。 */
  angles: [number, number, number];
  origin_raw: string;
  angles_raw: string | null;
}

/** 传送触发器（trigger_teleport）。 */
export interface WasmTeleportTrigger {
  index: number;
  classname: string;
  target: string;
  /** 已在 Rust 端旋转为 Y-up。 */
  origin: [number, number, number];
  model: string | null;
  /** model brush AABB min（Y-up，已旋转）。null = 无 model 或解析失败。 */
  model_mins: [number, number, number] | null;
  /** model brush AABB max（Y-up，已旋转）。null = 无 model 或解析失败。 */
  model_maxs: [number, number, number] | null;
  /**
   * 触发区域凸包平面（世界坐标 Y-up，法线朝外 [nx,ny,nz,dist]）。
   * null/undefined = 无凸包信息（回退 AABB 判定）。
   */
  model_planes?: [number, number, number, number][] | null;
  /**
   * spawnflags（bitfield）：bit1=Clients、bit2=NPCs、bit8=PhysicsObjects、
   * bit16=Only players、bit64=Everything；默认 1=Clients。
   * 不含 Clients 且非 Everything 时触发器不对玩家生效（checkTeleport 跳过）。
   */
  spawnflags: number;
  /** StartDisabled（true=禁用，不会触发传送）。 */
  start_disabled: boolean;
  origin_raw: string;
  model_raw: string | null;
}

/** trigger → dest 链接。 */
export interface WasmTeleportLink {
  trigger_idx: number;
  dest_idx: number;
}

/** `parse_teleports` 返回的 JSON 顶层结构。 */
export interface WasmTeleportReport {
  teleports: WasmTeleportDest[];
  triggers: WasmTeleportTrigger[];
  links: WasmTeleportLink[];
  total_triggers: number;
  total_dests: number;
  total_links: number;
  orphan_triggers: number;
  orphan_dests: number;
}

// ---------------------------------------------------------------------------
// PVS（parse_pvs_data）— camelCase（Rust 使用 #[serde(rename_all = "camelCase")]）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 元数据（metadata）
// ---------------------------------------------------------------------------

/** `BspProcessor.metadata()` 返回的 JSON 顶层结构。 */
export interface WasmBspMetadata {
  schema_version: number;
  /** BSP 魔术字（如 "VBSP"）。 */
  magic: string;
  map_name: string;
  num_models: number;
  num_faces: number;
  num_original_faces: number;
  num_vertices: number;
  num_edges: number;
  num_textures_data: number;
  num_textures_info: number;
  num_displacements: number;
  num_entities: number;
  num_static_props: number;
  num_brushes: number;
  num_leaves: number;
  num_nodes: number;
  packed_files: number;
}

// ---------------------------------------------------------------------------
// ColliderFilter（export_brushes_planes 输入）
// ---------------------------------------------------------------------------

/** `export_brushes_planes(filter_json)` 的过滤参数。 */
export interface ColliderFilter {
  /** 是否导出 LADDER brush（默认 true）。 */
  include_ladder?: boolean;
  /** 是否导出 SOLID brush（默认 true）。 */
  include_solid?: boolean;
  /** 跳过 AABB 体积小于此值的 brush（默认 0，不过滤）。 */
  min_brush_volume?: number;
  /** 跳过含 SKY 纹理的 brush（默认 true）。 */
  skip_sky?: boolean;
  /** 跳过含 NODRAW 纹理的 brush（默认 false）。 */
  skip_nodraw?: boolean;
}

/** 默认过滤参数（与 Rust 端 `ColliderFilter::default()` 一致）。 */
export const DEFAULT_COLLIDER_FILTER: Required<ColliderFilter> = {
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
};
