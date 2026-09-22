/**
 * `apps/debug` 侧 WASM 导出 JSON 的类型面：标注 `BspProcessor`
 *（`apps/debug/crates/wasm/src/lib.rs`）的 `export_brushes_planes` /
 * `export_model_tri_colliders` / `export_model_phy_colliders` / `parse_spawn_points` /
 * `parse_teleports` / `metadata` 的返回值形状。
 *
 * ## 命名与坐标
 * - 除 PVS 外全部是 snake_case：这些 Rust 结构体没有 `#[serde(rename_all)]`，字段名与 Rust 侧一致。
 *   PVS 走 camelCase，且其三个类型的**定义**在共享层 `src/ts-shared/world/types.ts`，本文件只转出。
 * - 所有向量的导出路径都做了 `[x,y,z] → [y,z,x]` 循环置换（行列式 +1），JSON 里已是 Y-up；
 *   `dist` 类标量在正交变换下不变，但上游对 brush 平面额外取负（见 `WasmBrushPlane`）。
 *
 * ## 消费面（grep 实测，范围 `apps/debug/src` 与 `src`）
 * - `WasmBrush` / `WasmBrushPlane` → `apps/debug/src/world/collider-adapter.ts` 的 `adaptBrushes`。
 * - `WasmTeleportReport` → `apps/debug/src/world/teleport-manager.ts` 的构造器
 *  （只读 `teleports` 与 `triggers` 两个键）。
 * - `WasmSpawnReport` / `WasmSpawnPoint` → `apps/debug/src/world/spawn-loader.ts`（该模块零调用点）。
 * - `WasmTriMesh` / `WasmTeleportLink` / `WasmBspMetadata` / `ColliderFilter` /
 *   `DEFAULT_COLLIDER_FILTER` 与本文件末尾的 PVS 转出行：本工程与共享层内**零引用**。
 *   `triJson` 的实际消费方 `apps/debug/src/renderer/collider-debug.ts` 用的是
 *   `apps/debug/src/physics/physics/Collision/Collision.types.ts` 的 `TriMesh`
 *  （比 `WasmTriMesh` 多一个可选 `surfaceprop`）。
 *
 * 本文件只有类型与一个常量，无运行期副作用，不做任何解析或校验。
 */

// ---------------------------------------------------------------------------
// brush 平面与 brush（export_brushes_planes）
// ---------------------------------------------------------------------------

/** 一个放置实例的三角形碰撞网格（`export_model_tri_colliders` 与
 * `export_model_phy_colliders` 共用的形状；后者每个条目多一个 `surfaceprop` 字段，
 * 本接口未声明它）。 */
export interface WasmTriMesh {
  /** 模型名（上游写 `m.name`；同一次导出里模型的多个放置实例共用同一个名字）。 */
  name: string;
  /** 世界空间顶点（Y-up；上游把局部顶点经根变换与放置变换后写出）。 */
  vertices: [number, number, number][];
  /** 三角形索引 `[a, b, c]`，引用 `vertices`。 */
  indices: [number, number, number][];
  /** 该实例顶点集的 AABB 下界（世界空间）。 */
  min: [number, number, number];
  /** 该实例顶点集的 AABB 上界（世界空间）。 */
  max: [number, number, number];
}

/** brush 的一个平面（对应上游 `WasmBrushPlane`）。 */
export interface WasmBrushPlane {
  /** 单位法线 `[x, y, z]`，Y-up 且**朝外**：上游先做 `rotate_yup`，再对三个分量取负。 */
  normal: [number, number, number];
  /** 平面常数项 `dot(normal, pointOnPlane)`；上游对原值取负，与 `normal` 的取负配合，
   * 把半空间约定从「内部 `dot(n, p) - dist >= 0`」翻成「内部 `dot(n, p) - dist <= 0`」。 */
  dist: number;
}

/** 一个 BSP brush（对应上游 `WasmBrush`）。 */
export interface WasmBrush {
  /** 平面数组。上游在收集 brush_sides 后剔除平面少于 4 个的 brush，并追加运行时生成的
   * 棱边 chamfer 平面，故其产物至少 4 项；消费端 `adaptBrushes` 仍再判一次空与 `< 4`。 */
  planes: WasmBrushPlane[];
  /** brush 凸包顶点的 AABB 下界（Y-up）。 */
  min: [number, number, number];
  /** brush 凸包顶点的 AABB 上界（Y-up）。 */
  max: [number, number, number];
  /** `BrushFlags::LADDER`（0x20000000）置位。与 `is_solid` 可同时为真。 */
  is_ladder: boolean;
  /** playersolid 掩码置位：上游判的是 `SOLID | WINDOW | GRATE | PLAYERCLIP | MOVEABLE`
   * 五位（0x1 / 0x2 / 0x8 / 0x10000 / 0x4000）中任一位，不只是 `SOLID`。 */
  is_solid: boolean;
}

// ---------------------------------------------------------------------------
// 出生点（parse_spawn_points）— snake_case（Rust 无 rename_all）
// ---------------------------------------------------------------------------

/** `parse_spawn_points` 收集到的一个出生点实体。 */
export interface WasmSpawnPoint {
  /** 实体 classname。上游的采集面 = 内置 classname 白名单（含 `info_player_start`、
   * 各队伍出生点与 `info_teleport_destination`）并集 classname 以 `info_player_` 开头的实体。 */
  classname: string;
  /** 出生坐标 `[x, y, z]`（Y-up，上游已旋转）。 */
  origin: [number, number, number];
  /** BSP 原始角度 `[pitch, yaw, roll]`（未旋转）；两个消费点都只取 `angles[1]` 做 yaw 换算。
   * 实体缺 `angles` 键、或该键不足三个数时上游写 `[0, 0, 0]`。 */
  angles: [number, number, number];
  /** 实体 `origin` 键的原串（上游对 `origin` 解析失败的实体会整条跳过，故这里一定是可解析的串）。 */
  origin_raw: string;
  /** 实体 `angles` 键的原串；缺该键时为 null。 */
  angles_raw: string | null;
}

/** `parse_spawn_points` 返回的 JSON 顶层结构。 */
export interface WasmSpawnReport {
  /** 出生点列表，顺序 = BSP 实体遍历顺序。 */
  spawn_points: WasmSpawnPoint[];
  /** `spawn_points.length`。 */
  total: number;
  /** 推荐出生点下标：首个 `info_player_start` 的位置；没有该 classname 但列表非空时为 0；
   * 列表为空时为 null（上游写的是 `Option<usize>`）。 */
  primary: number | null;
}

// ---------------------------------------------------------------------------
// 传送点（parse_teleports）— snake_case（Rust 无 rename_all）
// ---------------------------------------------------------------------------

/** 一个传送目的地实体（`info_teleport_destination` 及其带后缀的同族 classname）。 */
export interface WasmTeleportDest {
  /** BSP 实体编号（上游取 `bsp.entities` 的 enumerate 下标，跳跃、非连续），
   * **不是** `teleports` 数组下标。 */
  index: number;
  /** 实体 `targetname`；缺该键的实体不入表。 */
  targetname: string;
  /** 目标坐标 `[x, y, z]`（Y-up）。 */
  origin: [number, number, number];
  /** BSP 原始角度 `[pitch, yaw, roll]`（未旋转）。 */
  angles: [number, number, number];
  /** 实体 `origin` 键的原串；该键缺失或解析失败时上游把 `origin` 兜成 `[0, 0, 0]` 并照常入表
   *  （与出生点的「解析失败即跳过实体」不同）。 */
  origin_raw: string;
  /** 实体 `angles` 键的原串；缺该键时为 null。 */
  angles_raw: string | null;
}

/** 一个传送触发器区域。上游对「一个 trigger 实体绑定的每个 brush 区域」各产出一条记录，
 * 故同一实体的多条记录共享 `index` / `classname` / `target` / `origin` / `spawnflags` /
 * `start_disabled`，只有几何三字段不同。 */
export interface WasmTeleportTrigger {
  /** BSP 实体编号（同上，非本数组下标）；同一实体的多个区域取同一个值。 */
  index: number;
  /** 上游只收三种 classname：`trigger_teleport`、`trigger_teleport_random`、
   * `trigger_teleport_relative`。 */
  classname: string;
  /** 实体 `target`；缺该键的实体不入表。链接由 `TeleportManager` 用它与目的地的
   * `targetname` 逐字符比较，不经 `links`。 */
  target: string;
  /** 实体 origin（Y-up）。区域几何不由它决定，它只在无区域信息时充当球形回退的球心。 */
  origin: [number, number, number];
  /** 实体 `model` 键原串（如 `*5`）；上游按它取 `bsp.models[N]`，不以 `*` 开头或下标非法时
   * 区域为空。 */
  model: string | null;
  /** 该 brush 区域的世界空间 AABB 下界（Y-up）；`null` = 无区域信息或 model 解析失败。 */
  model_mins: [number, number, number] | null;
  /** 该 brush 区域的世界空间 AABB 上界（Y-up）；`null` 同上。 */
  model_maxs: [number, number, number] | null;
  /** 触发区域凸包平面（世界坐标 Y-up，`[nx, ny, nz, dist]`，法线朝外、内部
   * `dot(n, p) - dist <= 0`）；上游在区域无平面时写 `null`，
   * 消费端把它当「无凸包信息，回退 AABB」。 */
  model_planes?: [number, number, number, number][] | null;
  /** 实体 `spawnflags` 解析出的位掩码；键缺失或解析失败时上游写 1。 */
  spawnflags: number;
  /** 上游用 `.prop("StartDisabled")` 取该键，而实体文本已被整体转成小写
   *（`src/wasm-core/vbsp/reader.rs` 的 `read_entities`）且 `RawEntity::prop` 逐字节比较键名，
   * 故这次取值必然报缺键、`unwrap_or(false)` 兜成 false —— 本字段在当前工况下恒为 false。 */
  start_disabled: boolean;
  /** 实体 `origin` 键的原串。TS 侧无读取点。 */
  origin_raw: string;
  /** 实体 `model` 键的原串；缺该键时为 null。TS 侧无读取点。 */
  model_raw: string | null;
}

/** trigger → dest 链接（由 targetname 与 target 的逐字符比较得到）。 */
export interface WasmTeleportLink {
  /** `triggers` 数组下标（上游的 enumerate 下标，不是实体的 `index`）。 */
  trigger_idx: number;
  /** `teleports` 数组下标。 */
  dest_idx: number;
}

/** `parse_teleports` 返回的 JSON 顶层结构。 */
export interface WasmTeleportReport {
  /** 目的地表。 */
  teleports: WasmTeleportDest[];
  /** 触发器区域表（一个实体可占多条）。 */
  triggers: WasmTeleportTrigger[];
  /** 链接表；上游对每个 trigger × dest 命中各写一条，故同一对可出现多条。
   *  本工程 TS 侧零引用（`TeleportManager` 直接用 targetname 建映射）。 */
  links: WasmTeleportLink[];
  /** `triggers.length`。 */
  total_triggers: number;
  /** `teleports.length`。 */
  total_dests: number;
  /** `links.length`。 */
  total_links: number;
  /** 未被任何链接命中的 trigger 条目数（`triggers.length - 命中集合大小`）。 */
  orphan_triggers: number;
  /** 未被任何链接命中的目的地数。 */
  orphan_dests: number;
}

// ---------------------------------------------------------------------------
// PVS（parse_pvs_data）— camelCase（Rust 使用 #[serde(rename_all = "camelCase")]）
// ---------------------------------------------------------------------------

/**
 * PVS 三类型的唯一定义在共享层 `src/ts-shared/world/types.ts`（字段名 camelCase）。
 * 本行只做转出，使本工程内沿用 `from './types.js'` 的既有 import 路径；
 * 本工程与 `apps/debug/src` 内无引用点，`PvsManager` 直接从共享层引入。
 */
export type { WasmPvsNode, WasmPvsLeaf, WasmPvsData } from '../../../../src/ts-shared/world/types.js';

// ---------------------------------------------------------------------------
// 元数据（metadata）
// ---------------------------------------------------------------------------

/** `BspProcessor.metadata()` 返回的 JSON 顶层结构（对应上游 `BspMetadata`）。 */
export interface WasmBspMetadata {
  /** 结构版本号；上游 `BspMetadata::from_bsp` 写死 1。 */
  schema_version: number;
  /** BSP 头四个标识字节拼成的串（如 `VBSP`）。 */
  magic: string;
  /** 地图名。上游 `BspMetadata::from_bsp` 写死空串且此后无处改写，
   *  故本字段在当前工况下恒为 `''`（UI 显示名取自加载的文件名）。 */
  map_name: string;
  /** `bsp.models.len()`。 */
  num_models: number;
  /** `bsp.faces.len()`。 */
  num_faces: number;
  /** `bsp.original_faces.len()`。 */
  num_original_faces: number;
  /** `bsp.vertices.len()`。 */
  num_vertices: number;
  /** `bsp.edges.len()`。 */
  num_edges: number;
  /** `bsp.textures_data.len()`。 */
  num_textures_data: number;
  /** `bsp.textures_info.len()`。 */
  num_textures_info: number;
  /** `bsp.displacements.len()`。 */
  num_displacements: number;
  /** 实体条数（`bsp.entities` 的迭代计数）。 */
  num_entities: number;
  /** 静态道具条数（`bsp.static_props()` 的迭代计数）。 */
  num_static_props: number;
  /** `bsp.brushes.len()`。 */
  num_brushes: number;
  /** `bsp.leaves.len()`。 */
  num_leaves: number;
  /** `bsp.nodes.len()`。 */
  num_nodes: number;
  /** pakfile 内条目数（构造 `BspProcessor` 时算一次并缓存）。 */
  packed_files: number;
}

// ---------------------------------------------------------------------------
// ColliderFilter（export_brushes_planes 输入）
// ---------------------------------------------------------------------------

/** `export_brushes_planes(filter_json)` 的过滤参数。上游五个字段都带 `#[serde(default)]`，
 * 但整串 JSON 用 `serde_json::from_str(...).unwrap_or_default()` 解析，
 * 故**任一字段类型不合法**都会让五个键一起落回默认值，而不是只回退该字段。 */
export interface ColliderFilter {
  /** 是否导出 LADDER brush（默认 true）。 */
  include_ladder?: boolean;
  /** 是否导出 playersolid 掩码命中的 brush（默认 true）。 */
  include_solid?: boolean;
  /** 跳过 AABB 体积小于此值的 brush（默认 0 = 不过滤）。 */
  min_brush_volume?: number;
  /** 跳过含 SKY / SKY2D 纹理的 brush（默认 true）。 */
  skip_sky?: boolean;
  /** 跳过含 NODRAW 纹理的 brush（默认 false）。 */
  skip_nodraw?: boolean;
}

/** 与上游 `ColliderFilter` 五个默认值逐字段同值的常量。
 *  注意生产路径不读它：`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle`
 *  用的是该文件自己的 `DEFAULT_BRUSH_FILTER`（同样五个键、同样取值），
 *  本工程只在需要显式传过滤 JSON 时才会用到这里的对象。 */
export const DEFAULT_COLLIDER_FILTER: Required<ColliderFilter> = {
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
};
