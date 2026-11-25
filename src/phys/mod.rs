//! `PhysWorld` —— 共享物理层（crate `websurf-phys`）的 wasm-bindgen 绑定层。
//!
//! 组装：`world::World`（brush/tri 双空间索引碰撞）+ `player::Player`（全套 CS 移动语义）
//! + `teleport::TeleportManager`（传送触发与冷却）。
//!
//! 上下游位置：
//! - 上游（建世界）：各工程 `crates/wasm` 的 `BspProcessor::export_brushes_planes`
//!   （`apps/game/crates/wasm/src/lib.rs` 与 `apps/debug/crates/wasm/src/lib.rs` 各一处）
//!   产出 `WasmBrush[]` JSON；tri / teleport 同为 TS 侧 `buildWorldBundle` 产出的 JSON。
//!   三者一并交给 `build_world`，由 `parse_brushes` / `parse_tri_meshes`
//!   反序列化后建索引 —— **brush 与 tri 都走 JSON 中转**，没有任何内存直传通道。
//! - 下游（消费状态）：主线程渲染线在 `RendererMain.tick` 里调 `tick` + `state`
//!   （`apps/game/src/renderer/renderer-main.ts`）；权威 Worker 侧同样用
//!   `tick`（`src/ts-shared/auth/auth-loop.ts` 的 `phys.tick`），再把结果按定标写进 SAB
//!   （`src/ts-shared/auth/shared-state.ts` 的 `writeAuthoritative`）。
//! - 每个工程运行时恰有 2 个实例：主线程预测实例（`apps/game/src/renderer/renderer-main.ts`、
//!   `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.buildPredictionWorld`）
//!   与 Worker 权威实例（`apps/game/src/worker/main.ts`、`apps/debug/src/worker/main.ts`
//!   注入的 `createPhysWorld`）。`src/ts-shared/auth/worker-dispatch.ts` 只在宿主注入
//!   `tickPhys` / `scratch` 时才另建实例，当前三个工程均未注入。
//! - 本 crate 只被 `apps/debug` 与 `apps/game` 依赖：两者的 `crates/wasm/src/lib.rs`
//!   各有一行 `pub use websurf_phys::phys::PhysWorld;`，两边的 `crates/wasm/Cargo.toml`
//!   都以 `path = "../../../../src"` 指到本目录。`apps/viewer` 是纯查看器，
//!   其 `crates/wasm` 只依赖 `websurf-wasm-core`，不含 `websurf-phys`。
//!
//! 导出面：本文件 `#[wasm_bindgen] impl PhysWorld`共 **42 个 `pub fn`**（含 `new`）；默认构建
//! （不开 `phys-debug`）**30 个**（T-D135 新增 `build_world_binary`，与 `build_world` 共用装配）。
//! 另外 12 个仅 debug 的导出放在文件末尾的
//! `#[cfg(feature = "phys-debug")] impl` 块里（`set_state_ex` / `state_full_json` /
//! `gate_veto_count` / `debug_trace` / `debug_position_probe` / `debug_collide_attrib` /
//! `debug_tri_mesh_name` / `debug_stuck_probe` / `debug_hull_stats` / `debug_hull` /
//! `debug_free_table` / `debug_normal_escape`）：只有 `apps/debug` 经 `websurf-wasm-bindings`
//! 的 `debug-tools` 打开，`apps/game` / `apps/viewer` 的产物不含这 12 个。
//! 其中 `set_jump_height`只由 debug 宿主在「跳跃增幅区」（surf_null 的 `autohop_zone`）内调用；
//! `debug_line_trace`（env_laser 射线截断）是 `apps/game` 运行期唯一使用的 `debug_` 导出，
//! 因此无条件保留在公共块；`debug_hull_stats`是 `.phy` 凸体转 brush 的统计出口（核对接线量级，只读）。
//!
//! 边界：本模块只做状态推进与读取。不做 BSP 解析、不导出 GLB、不碰渲染；
//! 实例与实例之间不共享可变状态，唯一跨实例可变量是诊断计数器
//! `world::GATE_VETO_COUNT`（`src/phys/world.rs`，只增不减、无复位入口）。
//!
//! 测试归属：`p2_gate_tests`（门校验）、`duck_surf_tests`（surf/蹲姿）、`ridge_contact_tests`、
//! `step_gate_tests`、`stuck_gate_tests`、`spawn_deembed_tests`、`contact_push_tests`、
//! `bevel_rest_tests`、`hull_bevel_tests`、`phy_hull_gate_tests`、`slope_speed_tests`、
//! `tri_surface_tests`、`jump_height_tests`（起跳高度）；`cargo test -p websurf-phys` 全绿。

pub mod player;
pub mod teleport;
pub mod world;

/// WSBW 二进制世界格式（brush / tri 两份 buffer 的唯一编解码实现）。
pub mod world_bin;

/// VBSP `AddBrushBevels` 的移植：给单块凸体补齐「盒体扩张」所需的 box / edge bevel 平面
/// （`.phy` 凸体要走 brush 平面表追踪器时的平面表来源）。
pub mod hull_bevels;

/// `.phy` 网格 → 凸体 brush：按连通分量拆块、逐块生成补面、转成 `Brush`（走 brush 追踪器）。
pub mod phy_hulls;

/// 种子面 v2：实例状态的可序列化投影（`src/phys/seed.rs` 的 `SEED_SCHEMA_VERSION = 2`），
/// 供 scratch 实例从权威实例单向播种，不做任何反向写入。
#[cfg(feature = "phys-debug")]
mod seed;

/// 门校验回归（4 项）：端帽 / 起始实心 / 悬浮滑行三类幽灵面被否决，贴地落地被保留。
#[cfg(test)]
mod p2_gate_tests;
/// surf 坡面与蹲姿释放回归（6 项）：含地面/空中起立判定与蹲姿限速。
#[cfg(test)]
mod duck_surf_tests;
/// 棱线接触回归（4 项）：凸棱上多张面同时接触时的平均法线与逐面最陡判据。
#[cfg(test)]
mod ridge_contact_tests;
/// 台阶移动抬升闸门回归（2 项）：头顶无障碍时不得把玩家抬起来。
#[cfg(test)]
mod step_gate_tests;
/// 卡死判据着地门回归（2 项）：前方地面更高时不得原地抖动。
#[cfg(test)]
mod stuck_gate_tests;
/// 出生点去嵌入回归（3 项，T-731/F1）：嵌入 relocate / 全封闭保持 / 空闲零位移。
#[cfg(test)]
mod spawn_deembed_tests;
/// 贴面推开的步长无关性回归（2 项）：高刷屏步长下贴墙不得被"每次撞面都推"推着走。
#[cfg(test)]
mod contact_push_tests;
/// BSP 原生 bevel 承担「刀刃脊可站」的回归（2 项）：停靠面由 bevel 决定，撤掉即楔进斜面。
#[cfg(test)]
mod bevel_rest_tests;
/// `.phy` 凸体补面（`hull_bevels`）回归（3 项）：VBSP 两代 bevel 生成后盒停在脊线上，
/// 撤掉生成即回到「按斜面扩张提前触停」的虚浮停位。
#[cfg(test)]
mod hull_bevel_tests;
/// `.phy` 网格拆块 + 转凸体 brush 的门回归（3 项）：多块并集拆开后脊可站、非凸块退回三角形路径。
#[cfg(test)]
mod phy_hull_gate_tests;

#[cfg(test)]
mod slope_speed_tests;

#[cfg(test)]
mod tri_surface_tests;

/// 起跳高度回归（2 项）：「跳跃增幅区」的 `set_jump_height` 只改后续起跳初速。
#[cfg(test)]
mod jump_height_tests;

/// brush 实体运行期碰撞开关（`World::set_entity_solid` / `PhysWorld::set_brush_solid`）。
#[cfg(test)]
mod brush_solid_tests;

/// 移动 brush（`World::set_entity_offset` / `PhysWorld::set_brush_offset` + 载客）。
#[cfg(test)]
mod brush_offset_tests;
/// 梯子回归（朝向选面、攀爬速度、实体梯子启停、随实体平移）。
#[cfg(test)]
mod ladder_tests;

#[cfg(test)]
mod teleport_switch_tests;

/// WSBW 编解码与「JSON 世界 ≡ 二进制世界」等价性。
#[cfg(test)]
mod world_bin_tests;

use player::{create_player, player_tick, PhysParams, Player};
use teleport::{check_death, TeleportManager};
use world::{Brush, LadderVolume, TriMesh, World};

use wasm_bindgen::prelude::*;

/// brush 碰撞体在 Rust 侧的形态，由 `parse_brushes`解析产出。
/// 字段与各工程 wasm 层 `BspProcessor::export_brushes_planes` 输出的 `WasmBrush[]`
/// JSON 一一对应；坐标为 Y-up、法线朝外。
#[derive(Clone, Debug)]
pub struct PhysBrush {
    pub planes: Vec<PhysPlane>,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub is_ladder: bool,
    pub is_solid: bool,
    /// 所属实体下标（实体枚举顺序，与 GLB extras `vbsp_entity_index` 同序）；-1 = worldspawn。
    pub entity: i32,
    /// 出生时是否实心（实体层 `START_OFF` / `StartDisabled` ⇒ false）。
    pub start_solid: bool,
}

/// brush 的一个面：`normal` 为单位外法线，`dist` 为面到原点的有符号距离（HU）。
#[derive(Clone, Copy, Debug)]
pub struct PhysPlane {
    pub normal: [f32; 3],
    pub dist: f32,
}

/// 物理事件，经 `take_event`一次性取走。
/// 消费方：`apps/debug` 渲染线的事件循环（`apps/debug/src/renderer/renderer-main.ts` 的
/// `RendererMain.consumePhysEvents`，驱动计时挑战）；`apps/game` 侧未消费。
#[derive(Clone, Debug)]
pub enum PhysEvent {
    /// 传送触发（目标点信息）。
    Teleport {
        targetname: String,
        origin: [f64; 3],
        yaw: f64,
    },
    /// 掉落死亡重生。
    Death,
}

/// 物理世界（wasm-bindgen 导出类）：一个实例 = 一份独立世界 + 一个玩家 + 一组参数。
/// 实例之间不共享可变状态；同一 wasm 模块里的多个实例各自持有自己的 `World` / `Player`。
#[wasm_bindgen]
pub struct PhysWorld {
    world: World,
    player: Player,
    params: PhysParams,
    teleport: TeleportManager,
    /// 初始出生点（`respawn`、掉落死亡重生、`reset` 键都回到这里）。
    spawn: [f64; 3],
    /// 全部出生点列表（`[x,y,z,yaw]`）：`set_spawn_points` 写、`teleport_to_spawn` 按索引取。
    spawn_points: Vec<[f64; 4]>,
    /// 死亡 Y 阈值：`origin.y` 低于它即判掉落死亡。由宿主经 `set_death_y` 设定。
    death_y: f64,
    /// noclip 自由视角开关。置位后 `step_core`改走 `noclip_step`：
    /// **位置由本实例自行推进**，不走碰撞、不触发传送与死亡。
    noclip: bool, auto_restore_hull: bool, // 后者：卡死（离地判定）时自动恢复默认碰撞箱，debug 面板开关（T-310）
    /// 是否已成功执行过 `build_world`。为 false 时 `tick` 直接返回现状。
    ready: bool,
    /// `build_world` 里 `.phy` 凸体转 brush 的统计（只读诊断，`debug_hull_stats` 出口）：
    /// `[转成 brush 的块数, 生成的 box bevel 张数, 生成的 edge bevel 张数, 退回三角形路径的块数]`。
    ///
    /// 关闭 `phys-debug` 时没有读取方（`debug_hull_stats` 被门控掉），但 `build_world` 照常
    /// 记账 —— 成本是 4 个 `usize`，换来返回 `debug_hull_stats` 时无需重扫；此处只消告警。
    #[cfg_attr(not(feature = "phys-debug"), allow(dead_code))]
    hull_stats: [usize; 4],
    /// 最近一次物理事件（传送/死亡）。一次 `step_core` 至多产生一个，
    /// 由 `take_event` 取走后置空；不取则被下一次事件覆盖。
    event: Option<PhysEvent>,
    /// 水平速度上限（HU/s，**不含竖直分量**）：对应 Source 的 `sv_maxvelocity`。
    ///
    /// 只钳水平模长 `hypot(vx, vz)`，竖直速度不受限（surf 语义：竖直方向的冲量
    /// 与重力需要保留，否则板子/斜坡的抛射会被整个削平）。构造默认 5000 HU/s，与
    /// `src/ts-shared/phys/param-defaults.ts` 的 `PHYSICS_PARAM_DEFAULTS.maxHorizontalSpeed`
    /// 单源（owner 2026-11-20 定的产品默认；生效值 = min(地图 `sv_maxvelocity`, 用户值)）。
    /// 地图 `logic_auto` 的 `sv_maxvelocity` 经 `set_max_horizontal_speed` 覆盖（surf_666 写的是 10000）。
    /// `<= 0` 表示关闭钳制（调试用）。
    max_horizontal_speed: f64,
}

/// `PhysWorld::new` 的对偶：与构造函数的空实例逐字段相同（不加载任何地图数据、
/// `ready = false`）。
impl Default for PhysWorld {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl PhysWorld {
    /// 构造空实例：全默认参数、空世界（`ready = false`）、出生点 `[0, 100, 0]`、
    /// 死亡线 `-100000`。
    ///
    /// **不加载任何地图数据** —— 世界由随后的 `build_world` 建立。在 `build_world`
    /// 之前 `tick` 只返回当前（默认）状态，不做物理推进。
    #[wasm_bindgen(constructor)]
    pub fn new() -> PhysWorld {
        PhysWorld {
            world: World::new(),
            player: create_player([0.0, 100.0, 0.0], &PhysParams::default()),
            params: PhysParams::default(),
            teleport: TeleportManager::default(),
            spawn: [0.0, 100.0, 0.0],
            spawn_points: Vec::new(),
            death_y: -100_000.0,
            noclip: false, auto_restore_hull: false,
            ready: false,
            hull_stats: [0; 4],
            event: None,
            max_horizontal_speed: 5000.0,
        }
    }

    /// 加载世界：解析 brush / tri / teleport 三段 JSON，建碰撞索引，再按 spawn 重置玩家。
    ///
    /// 步骤与顺序：① brush 按 `is_ladder` / `is_solid` 分流进
    /// `world.ladders` / `world.solids`；② 装 `world.tri_meshes`；③ `build_index()`
    /// 一次性建空间索引；④ 解析 teleport；⑤ 写 spawn、重建玩家（`yaw = spawn_yaw`、
    /// `prev_origin = spawn`）、置 `ready = true`。
    ///
    /// **约束**：本方法只追加不清空（直接 `push`），对同一实例重复调用会把
    /// brush 再入一份；调用方按"每次 `world-json` 丢弃旧实例、建新实例再调用"使用
    /// （`src/ts-shared/auth/worker-dispatch.ts` 先 `free` 再 `createPhysWorld`）。
    ///
    /// 参数：`brush_json` 为 `WasmBrush[]`（Y-up、法线朝外）；`tri_json` 为空串等价于
    /// 无三角形碰撞；`teleport_json` 解析失败返回 `Err`，此时 `ready` 不变。
    ///
    /// 不做：不解析 BSP、不生成 GLB、不做坐标变换（传入数据必须已是 Y-up）。
    // 7 个入参是 wasm-bindgen 导出的 JS 契约（调用方在 src/wasm-bindings：JSON 三段 +
    // 出生点 x/y/z/yaw）；函数体只是解析后顺序转交，参数个数不反映内部复杂度。
    #[allow(clippy::too_many_arguments)]
    pub fn build_world(
        &mut self,
        brush_json: &str,
        tri_json: &str,
        teleport_json: &str,
        spawn_x: f64,
        spawn_y: f64,
        spawn_z: f64,
        spawn_yaw: f64,
    ) -> Result<(), JsValue> {
        let brushes = parse_brushes(brush_json)?;
        let tri_meshes = parse_tri_meshes(tri_json)?;
        self.build_world_from_parts(
            brushes, tri_meshes, teleport_json, spawn_x, spawn_y, spawn_z, spawn_yaw,
        )
    }

    /// WSBW 二进制入口：与 `build_world` 走同一套建世界逻辑，只是 brush/tri
    /// 由 `world_bin` 直接解码，绕过 JSON 文本与 serde_json。
    ///
    /// 两个 buffer 都先完整解码（纯函数、不碰 self）再进入建世界流程：任一 buffer
    /// 损坏时实例保持原状，不会出现一半世界。
    #[allow(clippy::too_many_arguments)]
    pub fn build_world_binary(
        &mut self,
        brush_bin: &[u8],
        tri_bin: &[u8],
        teleport_json: &str,
        spawn_x: f64,
        spawn_y: f64,
        spawn_z: f64,
        spawn_yaw: f64,
    ) -> Result<(), JsValue> {
        self.build_world_binary_checked(
            brush_bin, tri_bin, teleport_json, spawn_x, spawn_y, spawn_z, spawn_yaw,
        )
        .map_err(|e| JsValue::from_str(&e))
    }

    /// `build_world_binary` 的宿主可测版本：解码失败返回普通字符串，**不构造
    /// `JsValue`**（宿主机上 `JsValue::from_str` 会 panic）。wasm 边界只做一次
    /// 错误串转换，语义不变。
    #[allow(clippy::too_many_arguments)]
    fn build_world_binary_checked(
        &mut self,
        brush_bin: &[u8],
        tri_bin: &[u8],
        teleport_json: &str,
        spawn_x: f64,
        spawn_y: f64,
        spawn_z: f64,
        spawn_yaw: f64,
    ) -> Result<(), String> {
        let brushes = world_bin::decode_brushes(brush_bin)
            .map_err(|e| format!("brush binary: {e}"))?;
        let tri_meshes = world_bin::decode_tri_meshes(tri_bin)
            .map_err(|e| format!("tri binary: {e}"))?;
        self.build_world_from_parts(
            brushes, tri_meshes, teleport_json, spawn_x, spawn_y, spawn_z, spawn_yaw,
        )
        .map_err(|e| {
            e.as_string()
                .unwrap_or_else(|| "build_world_binary: 世界装配失败".to_string())
        })
    }

    /// build_world / build_world_binary 的共同实现：入参已是 Rust 侧解析结果。
    /// 只做世界装配与实例状态写入，顺序与旧 build_world 完全一致。
    #[allow(clippy::too_many_arguments)]
    fn build_world_from_parts(
        &mut self,
        brushes: Vec<PhysBrush>,
        tri_meshes: Vec<TriMesh>,
        teleport_json: &str,
        spawn_x: f64,
        spawn_y: f64,
        spawn_z: f64,
        spawn_yaw: f64,
    ) -> Result<(), JsValue> {
        // 1. brush → World.solids/ladders
        // 实体 brush 的初始碰撞状态（下标 = 实体枚举下标）：先按最大实体下标开表，
        // 再让 start_solid=false 的 brush 所属实体置 false。世界几何没有该项。
        let max_entity = brushes
            .iter()
            .filter(|b| b.entity >= 0)
            .map(|b| b.entity as usize + 1)
            .max()
            .unwrap_or(0);
        self.world.entity_solid = vec![true; max_entity];
        for b in &brushes {
            if b.entity >= 0 && !b.start_solid {
                self.world.entity_solid[b.entity as usize] = false;
            }
        }
        for b in brushes {
            let planes: Vec<world::Plane> = b
                .planes
                .iter()
                .map(|p| world::Plane {
                    normal: [p.normal[0] as f64, p.normal[1] as f64, p.normal[2] as f64],
                    dist: p.dist as f64,
                })
                .collect();
            let min = [b.min[0] as f64, b.min[1] as f64, b.min[2] as f64];
            let max = [b.max[0] as f64, b.max[1] as f64, b.max[2] as f64];
            if b.is_ladder {
                let facing = compute_ladder_facing(&planes);
                self.world.ladders.push(LadderVolume {
                    planes,
                    min,
                    max,
                    facing,
                    entity: b.entity,
                });
            } else if b.is_solid {
                self.world.solids.push(Brush {
                    planes,
                    min,
                    max,
                    entity: b.entity,
                });
            }
        }

        // 2. tri → World.tri_meshes（入参已解析；紧凑数组 [x,y,z]）

        // 2.5 `.phy` 凸体块 → brush：按连通分量把「一只模型的全部凸体块拼成一个 mesh」拆回块，
        //     逐块生成 VBSP 补面（box / edge bevel）后走既有 brush 平面表追踪器 —— 这样模型尖脊
        //     与 brush 刀脊同构：盒被过脊的补面接住，而不是被两侧斜面的外推面架在空中。
        //     凸性不达标 / 面数 < 4 的块保持走三角形路径（把它的三角形原样留下）。
        let mut leftover_meshes: Vec<TriMesh> = Vec::new();
        let mut hull_brushes = 0usize;
        let mut hull_box_bevels = 0usize;
        let mut hull_edge_bevels = 0usize;
        let mut hull_non_convex = 0usize;
        for mesh in tri_meshes {
            let mut brushes: Vec<Brush> = Vec::new();
            let mut leftover_tris: Vec<[u32; 3]> = Vec::new();
            for piece in phy_hulls::pieces_of_mesh(&mesh) {
                if piece.convex {
                    hull_brushes += 1;
                    hull_box_bevels += piece.box_added;
                    hull_edge_bevels += piece.edge_added;
                    brushes.push(Brush {
                        planes: piece.planes,
                        min: piece.min,
                        max: piece.max,
                        entity: -1,
                    });
                } else {
                    hull_non_convex += 1;
                    leftover_tris.extend_from_slice(&piece.tris);
                }
            }
            self.world.solids.extend(brushes);
            if !leftover_tris.is_empty() {
                leftover_meshes.push(TriMesh {
                    name: mesh.name.clone(),
                    vertices: mesh.vertices.clone(),
                    indices: leftover_tris,
                    min: mesh.min,
                    max: mesh.max,
                });
            }
        }
        if hull_brushes > 0 || hull_non_convex > 0 {
            #[cfg(not(target_arch = "wasm32"))]
            eprintln!(
                "[phys] .phy 凸体 → brush: 块={hull_brushes}（box bevel={hull_box_bevels} edge bevel={hull_edge_bevels}）；非凸/开集/退化退回三角形={hull_non_convex}",
            );
        }
        self.hull_stats = [
            hull_brushes,
            hull_box_bevels,
            hull_edge_bevels,
            hull_non_convex,
        ];
        self.world.tri_meshes = leftover_meshes;

        // 3. 空间索引
        self.world.build_index();
        // 3.5 记下 brush 几何基准：运行期移动 brush（电梯/移动平台）按实体整体平移，
        //     每次从这份快照重算，避免逐帧累加漂移（见 World::set_entity_offset）。
        self.world.capture_base_solids();

        // 4. teleport
        self.teleport = TeleportManager::from_json(teleport_json)
            .map_err(|e| JsValue::from_str(&format!("teleport: {e}")))?;

        // 5. 出生点 + 玩家
        self.spawn = [spawn_x, spawn_y, spawn_z];
        self.player = create_player(self.spawn, &self.params);
        // T-731/F1：出生点通用去嵌入。create_player 只落位不判嵌入（本文件 build_world
        // 原注释与 player.rs 的 create_player 文档一致：出生点是否悬空由第一个 tick 决定），
        // 而出生盒一旦与几何相交，后续每个 tick 的 check_stuck 都走"全候选失败 → 清速 +
        // 整帧跳过"链 = 永久悬空（T-731 实测：非默认体型进 surf_666 即全程冻结）。
        // 这里按 check_stuck 同一套候选集（player::find_free_origin，方向/距离/顺序同源）
        // 找最近空闲位；找到就把 spawn 字段一并搬过去（respawn 与死亡重生都回这个点），
        // 找不到保持原位并留日志。不用纯 +Y 上搜：surf_666 出生间顶部 12 HU 即实心，
        // +Y 方向在 1~34 全堵，只有全候选集才有解。
        {
            let mins = self.player.mins();
            let maxs = self.player.maxs();
            if !self.world.is_position_free(&self.spawn, &mins, &maxs) {
                match player::find_free_origin(&mut self.world, &self.spawn, &mins, &maxs) {
                    Some(free) => {
                        #[cfg(not(target_arch = "wasm32"))]
                        eprintln!(
                            "[phys] 出生点嵌入 {:?}，已搬到最近空闲位 {:?}（候选集内首个空闲点）",
                            self.spawn, free
                        );
                        self.spawn = free;
                        self.player.origin = free;
                    }
                    None => {
                        #[cfg(not(target_arch = "wasm32"))]
                        eprintln!(
                            "[phys] 出生点嵌入 {:?} 且候选集（34 HU 内 60 候选）无空闲位，保持原位；\
                             该体型在近邻空间放不下，后续 tick 将持续判卡死",
                            self.spawn
                        );
                    }
                }
            }
        }
        self.player.yaw = spawn_yaw;
        self.player.prev_origin = self.spawn;
        self.ready = true;
        Ok(())
    }

    /// 推进一个步长，返回**新构造的状态对象**（经 `state_js` 写 10 个字段）。
    /// 本方法不累加时间、不补步、不做固定步长节流——`dt` 完全由调用方给出。
    ///
    /// 未 `build_world` 时直接返回当前状态，不推进物理。
    pub fn tick(
        &mut self,
        dt: f64,
        keys_mask: u32,
        dx: f64,
        dy: f64,
    ) -> Result<JsValue, JsValue> {
        if !self.ready {
            return Ok(self.state_js());
        }
        self.step_core(dt, keys_mask, dx, dy);
        Ok(self.state_js())
    }

    /// 诊断/表现用**零体积线段**扫掠（等价源引擎 `UTIL_TraceLine` + `MASK_SOLID`），
    /// 返回 `[fraction, normal_x, normal_y, normal_z]`；未命中时法线回填 `[0,0,0]`。
    ///
    /// 与 [`PhysWorld::debug_trace`] 的区别：那个用玩家碰撞箱做盒扫，贴墙时会把线提前截断；
    /// 这里盒半径 0，只判断线段本身是否碰到实体 brush（触发体/水面不在物理世界里，
    /// 天然被忽略）。用途：`env_laser` 的静态截断。
    pub fn debug_line_trace(&mut self, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64) -> Vec<f64> {
        let zero = [0.0, 0.0, 0.0];
        let r = self.world.trace(&[sx, sy, sz], &[ex, ey, ez], &zero, &zero);
        let n = r.normal.unwrap_or([0.0, 0.0, 0.0]);
        vec![r.fraction, n[0], n[1], n[2]]
    }

    /// `tick` 的核心步进：
    /// 输入 → 角度 → （noclip 分支 ｜ 传送/死亡/reset → 碰撞移动）。
    ///
    /// 角度写入必须排在 `player_tick` 之前 —— 移动方向由玩家 yaw 决定，
    /// 顺序反过来会让本步移动用上一帧的朝向。
    fn step_core(&mut self, dt: f64, keys_mask: u32, dx: f64, dy: f64) {
        // 输入：键位掩码 → InputState；鼠标增量 → yaw/pitch
        apply_input(&mut self.player, keys_mask);
        self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
        self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
        self.player.pitch = clamp_pitch(self.player.pitch);
        // Q/E 已由 JS 输入层生成等效鼠标量（yaw_bind_speed/M_YAW 像素/秒，与鼠标同通道，
        // 双端消费同源输入 → 角度天然一致），物理不再内部旋转
        if self.noclip {
            noclip_step(&mut self.player, dt, &self.params);
        } else {
            // 传送检测（surfing 滑行不触发）
            if let Some(dest) = self.teleport.check(
                &self.player.origin,
                self.player.contact_ticks,
                dt,
                false,
                // 滑行（surfing）不触发传送
                self.player.surfing,
                // 身体高度（站立 72 / 蹲伏蹲箱高）——A 路径身体线段判定
                self.player.maxs()[1],
            ) {
                self.event = Some(PhysEvent::Teleport {
                    targetname: dest.targetname.clone(),
                    origin: dest.origin,
                    yaw: dest.yaw,
                });
                self.apply_teleport(&dest.origin, dest.yaw);
                self.teleport.on_teleported();
                // 不重置冷却：check 命中时已置 0.5 s，保留它可避免「落点仍在触发区内」
                // 时每 tick 重复传送（surf_666 起点回卷点的实测症状）。
            }
            // 死亡判定
            if let Some(sp) = check_death(&self.player.origin, self.death_y, &self.spawn) {
                self.event = Some(PhysEvent::Death);
                self.player.respawn(&sp);
                self.teleport.reset_cooldown();
            }
            // reset 键 → respawn
            if self.player.input.reset {
                self.player.input.reset = false;
                self.player.respawn(&self.spawn);
            }
            // Source 的 `sv_maxvelocity` 在加速前与移动（含碰撞）后再各钳一次；只钳水平，
            // 竖直分量保留（板子/斜坡/传送的抛射需要它）。
            self.clamp_horizontal_speed();
            player_tick(&mut self.world, &mut self.player, &self.params, dt); self.maybe_restore_hull();
            self.clamp_horizontal_speed();
        }
    }

    /// 把玩家放回初始出生点 `spawn`，并复位传送冷却。
    /// 具体复位哪些状态（速度/着地/蹲伏等）由 `Player::respawn` 决定，本方法不加额外判断。
    pub fn respawn(&mut self) {
        self.player.respawn(&self.spawn);
        self.teleport.reset_cooldown();
    }

    /// 立即传送到指定坐标，`yaw` 单位为度。
    ///
    /// 经 `apply_teleport`：清零速度、`on_ground` 置 false、同步 `prev_origin`；
    /// 之后清传送冷却（外部重定位不应继承步内命中留下的冷却）。
    /// **不做落地探测**——落点是否悬空由调用方负责。
    pub fn teleport_to(&mut self, x: f64, y: f64, z: f64, yaw: f64) {
        self.apply_teleport(&[x, y, z], yaw);
        self.teleport.reset_cooldown();
    }

    /// 覆盖出生点列表，JSON 形如 `[[x,y,z,yaw], ...]`（`yaw` 单位为度）。
    ///
    /// 只影响 `teleport_to_spawn` 的可选目标；**不改** `spawn` 字段，
    /// 所以 `respawn` 与掉落死亡重生仍然回到 `build_world` 时给定的那个出生点。
    /// 解析失败返回 `Err`，此时旧列表保持不变。
    pub fn set_spawn_points(&mut self, json: &str) -> Result<(), JsValue> {
        let list: Vec<[f64; 4]> =
            serde_json::from_str(json).map_err(|e| to_js_err(e, "set_spawn_points"))?;
        self.spawn_points = list;
        Ok(())
    }

    /// 传送到出生点列表中的第 `idx` 项。越界时静默忽略——不报错、不移动。
    /// 传送路径与 `teleport_to` 相同（都走 `apply_teleport` + 清冷却）。
    pub fn teleport_to_spawn(&mut self, idx: usize) {
        if let Some(sp) = self.spawn_points.get(idx) {
            self.apply_teleport(&[sp[0], sp[1], sp[2]], sp[3]);
            self.teleport.reset_cooldown();
        }
    }

    /// 用 9 个标量覆盖玩家的位置 / 朝向 / 速度 / 着地，并把 `prev_origin` 同步到新位置。
    ///
    /// 用途是"把权威状态写回某实例、再从该点继续推进"（重锚）。只改这 9 项：
    /// 不改蹲伏态、不改计时器、不改传送冷却、不产生事件。
    // 9 个标量是跨端重锚契约（TS 侧按位置传方位/朝向/速度/着地），改签名会跨端漂移；
    // 函数体只有逐项赋值。
    #[allow(clippy::too_many_arguments)]
    pub fn set_state(
        &mut self,
        pos_x: f64,
        pos_y: f64,
        pos_z: f64,
        yaw: f64,
        pitch: f64,
        vel_x: f64,
        vel_y: f64,
        vel_z: f64,
        on_ground: bool,
    ) {
        self.player.origin = [pos_x, pos_y, pos_z];
        self.player.yaw = yaw;
        self.player.pitch = pitch;
        self.player.velocity = [vel_x, vel_y, vel_z];
        self.player.on_ground = on_ground;
        self.player.prev_origin = self.player.origin;
    }

    /// 只覆盖速度（HU/s）：位置、朝向、着地均不动。
    /// 供"位置不覆盖、仅用速度渐进对齐"的校准路径使用，避免改写位置造成视觉跳变。
    /// 消费方：`src/ts-shared/phys/authority-calibrator.ts` 的
    /// `correctFromAuthority` / `calibrateVelocity`。
    pub fn set_velocity(&mut self, vx: f64, vy: f64, vz: f64) {
        self.player.velocity = [vx, vy, vz];
    }

    /// 给玩家叠加一个速度冲量（HU/s，Y-up），对应 Source 的
    /// `CBaseEntity::ApplyAbsVelocityImpulse`（surf_666 的 4 块加速板就是
    /// `trigger_push` + `SF_TRIG_PUSH_ONCE` 走这条路径，见 `triggers.cpp:2269-2278`）。
    ///
    /// 语义：`velocity += (vx, vy, vz)`；当 `vy > 0`（向上弹）时同时脱地——否则
    /// `stay_on_ground` 会把玩家按回地面、向上冲量被吃掉（对应 SDK 里
    /// `vecAbsDir.z > 0 ⇒ SetGroundEntity(NULL)`）。
    ///
    /// 不改位置/朝向，不产生事件；由实体层 `host.addPlayerVelocity` 事件驱动。
    pub fn add_velocity(&mut self, vx: f64, vy: f64, vz: f64) {
        self.player.velocity[0] += vx;
        self.player.velocity[1] += vy;
        self.player.velocity[2] += vz;
        if vy > 0.0 {
            self.player.on_ground = false;
        }
    }

    /// 把玩家速度**设成**给定向量（HU/s，Y-up），对应 `trigger_push` 非 `SF_TRIG_PUSH_ONCE`
    /// 分支的「设置速度」语义：玩家在触发区内时把水平速度置为该方向/大小。
    ///
    /// **已弃用（2026-11-20）**：Source SDK 的 `CTriggerPush::Touch` 并不直接改速度，而是
    /// `SetBaseVelocity(push)` + `AddFlag(FL_BASEVELOCITY)`；`CPlayerMove::CheckMovingGround()`
    /// （player_command.cpp:93-125）只在 flag 未置位时才 `ApplyAbsVelocityImpulse((1+dt/2)*basevelocity)`，
    /// 所以玩家**留在区内时速度不变**，**离开后的下一帧**才把 `≈pushdir*speed` 叠加到当前速度上
    /// （进入越快、离开越快，且保留原有动量与方向）。实体层已改为「touch 记下待施加值、endTouch
    /// 调 `add_velocity` 一次性叠加」（见 `src/ts-shared/entity/classes/triggers.ts`），本函数仅留作
    /// 旧回放/兼容通道，常规路径不再调用。保留原实现避免 wasm 导出面与消息协议一起改动。
    ///
    /// 旧语义（历史）：水平方向取 pushdir 方向、大小取 `max(当前水平速度, |dir|*speed)`，`vy` 为 0 时保留当前 vy。
    /// **竖直分量特殊处理**：`pushdir` 的 vy 为 0 时**保留玩家当前 vy**——板子/斜坡上
    /// 由碰撞投影积累起来的上升速度不能被每帧清零（旧实现 `velocity = [vx,vy,vz]`
    /// 会把它归零，导致「过了斜坡垂直速度没了」，surf_666 起点实测）。只有地图真的
    /// 给了竖直推送分量（`vy != 0`）时才覆盖竖直速度，并按需脱地。
    ///
    /// **竖直分量完全不动**：Source 里 base velocity 的竖直分量只在 `StartGravity` 加一次，
    /// 不该被每帧 touch 覆盖——旧实现 `velocity = [vx, vy, vz]` 会把斜坡上积累的上升速度
    /// 抹掉（surf_666 lane1 顶部板 `pushdir.vy≈-15` 即触发该 bug，task-50 实测 vy 1191→-15）。
    /// 只有地图真的给了**明显竖直**推送分量（|vy| > 25 HU/s）时才把 `vy*dt` 叠进竖直速度，
    /// 并按需脱地。
    ///
    /// 水平大小取 `max(当前水平速度, |pushdir|*speed)`：进板不丢已有动量；斜坡把速度投影成
    /// 水平+竖直后，下一帧仍接触板时还能把水平补回 push 值（「过斜坡掉 600」的可感知来源）。
    /// 水平模长另受 `max_horizontal_speed` 钳制（Source `sv_maxvelocity`）。
    ///
    /// 不改位置/朝向，不产生事件；由实体层 `host.setPlayerBaseVelocity` 事件驱动。
    pub fn set_push_velocity(&mut self, vx: f64, vy: f64, vz: f64) {
        let speed = (vx * vx + vz * vz).sqrt();
        if speed <= 1e-9 {
            return;
        }
        let cur_h = (self.player.velocity[0] * self.player.velocity[0]
            + self.player.velocity[2] * self.player.velocity[2])
            .sqrt();
        let target = speed.max(cur_h);
        let inv = 1.0 / speed;
        self.player.velocity[0] = vx * inv * target;
        self.player.velocity[2] = vz * inv * target;
        if vy.abs() > 25.0 {
            self.player.velocity[1] += vy / 64.0;
            if vy > 0.0 {
                self.player.on_ground = false;
            }
        }
    }

    /// 设置水平速度上限（HU/s，**不含竖直分量**）：`<= 0` 表示关闭钳制。
    ///
    /// 对应 Source 的 `sv_maxvelocity`。宿主在实体装载后按「地图 `logic_auto` 的
    /// `servercommand sv_maxvelocity <n>` ∩ 用户面板限速」下发（见共享 `EntityGameplay`）；
    /// 构造默认 5000 与 TS `PHYSICS_PARAM_DEFAULTS.maxHorizontalSpeed` 单源（owner 2026-11-20
    /// 产品默认；Source 的 3500 不再作为兜底值）。surf_666 写的是 10000。
    /// 只钳水平模长：板子/斜坡/传送带来的竖直速度需要保留。
    pub fn set_max_horizontal_speed(&mut self, cap: f64) {
        self.max_horizontal_speed = cap;
    }

    /// 运行期切换某个实体 brush 的碰撞（`solid = true` 实心、`false` 可穿过）。
    ///
    /// `entity` 是实体枚举下标（与 GLB extras `vbsp_entity_index`、实体 I/O 事件下标同序）。
    /// 世界几何（worldspawn，`entity < 0`）不可切换，传负数直接返回 `false`。
    /// 世界未 `build_world` 时调用无效果（状态表为空，越界按实心处理）。
    ///
    /// 只更新 `World::entity_solid` 状态表，不重建空间索引，下一次碰撞查询立即生效。
    /// 返回切换前的状态（`true` = 之前实心）。消费方：TS `EntityGameplay` 把
    /// `brush` 事件（`func_wall_toggle` / `func_door` Open/Close）落到物理与渲染两侧。
    pub fn set_brush_solid(&mut self, entity: i32, solid: bool) -> bool {
        if entity < 0 {
            return false;
        }
        self.world.set_entity_solid(entity as usize, solid)
    }

    /// 查询某个实体 brush 当前是否实心（诊断 / 断言用）。
    pub fn brush_solid(&self, entity: i32) -> bool {
        if entity < 0 {
            return true;
        }
        self.world
            .entity_solid
            .get(entity as usize)
            .copied()
            .unwrap_or(true)
    }

    /// 运行期平移某个实体的全部 brush（电梯 / 移动平台 / 可移动门）。
    ///
    /// `entity` 是实体枚举下标；`x` / `y` / `z` 是相对**基准几何**的位移（绝对量）。
    /// 世界几何（`entity < 0`）不可移动；世界未 `build_world` 时无效果。
    ///
    /// 只动该实体的 brush 并重建 brush 空间索引（`BrushGrid` 是按值副本），三角网格不变。
    /// 返回命中的 brush 数（0 = 该实体没有实心 brush）。消费方：TS 移动 brush 驱动
    /// （`EntityGameplay` → 主线程预测物理）每帧下发；权威 Worker 侧是否跟随见宿主接线。
    pub fn set_brush_offset(&mut self, entity: i32, x: f64, y: f64, z: f64) -> usize {
        if entity < 0 || !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return 0;
        }
        let previous = self
            .world
            .entity_offsets
            .get(entity as usize)
            .copied()
            .unwrap_or([0.0; 3]);
        let delta = [x - previous[0], y - previous[1], z - previous[2]];
        let moved = self.world.set_entity_offset(entity, [x, y, z]);
        if moved > 0 && (delta[0] != 0.0 || delta[1] != 0.0 || delta[2] != 0.0) {
            self.carry_player_on_moved_brush(entity, previous, delta);
        }
        moved
    }

    /// 玩家站在本次被移动的 brush 上时，把玩家一起带走（Source 的 `CBaseEntity` 载客语义
    /// 的等价近似）：只做平移，不改速度/视角；不在其上或悬空则不动。
    ///
    /// 判定用**移动前**的几何（`dynamic_base_solids + previous`）：脚底 y 与 brush 顶面差 ≤ 2 HU、
    /// 水平位置落在 brush AABB 外扩 2 HU 内即视为「站在上面」。命中第一个这样的 brush 就
    /// 整段位移，不再重复叠加。
    fn carry_player_on_moved_brush(&mut self, entity: i32, previous: [f64; 3], delta: [f64; 3]) {
        if !self.player.on_ground {
            return;
        }
        let feet = self.player.origin;
        for (_, base) in &self.world.dynamic_base_solids {
            if base.entity != entity {
                continue;
            }
            let min = [
                base.min[0] + previous[0],
                base.min[1] + previous[1],
                base.min[2] + previous[2],
            ];
            let max = [
                base.max[0] + previous[0],
                base.max[1] + previous[1],
                base.max[2] + previous[2],
            ];
            let on_top = (feet[1] - max[1]).abs() <= 2.0;
            let inside_x = feet[0] >= min[0] - 2.0 && feet[0] <= max[0] + 2.0;
            let inside_z = feet[2] >= min[2] - 2.0 && feet[2] <= max[2] + 2.0;
            if on_top && inside_x && inside_z {
                self.player.origin[0] += delta[0];
                self.player.origin[1] += delta[1];
                self.player.origin[2] += delta[2];
                return;
            }
        }
    }

    /// 查询某个实体 brush 当前的位移（诊断 / 断言用；未登记返回 `[0,0,0]`）。
    pub fn brush_offset(&self, entity: i32) -> Vec<f64> {
        if entity < 0 {
            return vec![0.0; 3];
        }
        self.world
            .entity_offsets
            .get(entity as usize)
            .map(|offset| offset.to_vec())
            .unwrap_or_else(|| vec![0.0; 3])
    }

    /// 设置起跳高度（HU）：下一步起跳的初速按 `sqrt(2·gravity·height)` 反推。
    /// 默认值来自 `set_params` 的 `jump_height`（config 的 `jumpSpeed²/(2·gravity)`，
    /// debug 默认 302 HU/s / 800 → 57 HU）。用途是「跳跃增幅区」：surf_null 的
    /// `autohop_zone` 触发体积包围着一片比地面高 64 HU 的水泥台，标准 57 HU 跳不上去，
    /// 原服由服务器插件在区内抬高跳跃高度；本引擎没有插件层，改由宿主在区内下发更大的
    /// 跳高、离开时发回默认值（见 `apps/debug/src/renderer/renderer-main.ts`）。
    ///
    /// 只影响**之后**的起跳初速，不改当前速度/位置/姿态；`<= 0` 或非有限值忽略。
    /// 不在种子面里（`set_state_ex` / `state_full_json` 不携带）——它属于宿主配置，世界重建后由宿主重放。
    pub fn set_jump_height(&mut self, height: f64) {
        if height.is_finite() && height > 0.0 {
            self.params.jump_height = height;
        }
    }

    /// 把水平速度模长钳到 `max_horizontal_speed`（竖直分量原样保留）。
    fn clamp_horizontal_speed(&mut self) {
        let cap = self.max_horizontal_speed;
        if cap <= 0.0 {
            return;
        }
        let vx = self.player.velocity[0];
        let vz = self.player.velocity[2];
        let h = (vx * vx + vz * vz).sqrt();
        if h > cap && h > 1e-9 {
            let scale = cap / h;
            self.player.velocity[0] = vx * scale;
            self.player.velocity[2] = vz * scale;
        }
    }

    /// 设置玩家当前 targetname（实体层 `!activator AddOutput targetname` 改名后由宿主推送）。
    ///
    /// 只影响传送 trigger 的 `filter_activator_name` 门控（`TeleportManager::player_name`），
    /// 不写 `state` 输出、不触发事件、不改位置/速度。宿主每帧检测到名字变化才推即可，
    /// 相同名字重复调用无副作用（幂等、字符串覆盖）。
    pub fn set_teleport_player_name(&mut self, name: &str) {
        self.teleport.player_name = name.to_string();
    }

    /// 运行期开关某个实体（BSP 实体编号）名下的全部传送触发区域。
    ///
    /// 地图 `trigger_teleport` 的 `StartDisabled` 在建表时只决定**初始**开关（见
    /// `TeleportManager::from_json`）；实体 I/O 的 `Enable` / `Disable` 由 TS 宿主
    /// 推到本方法切换（同名实体的多个 brush 区域一起切换）。
    /// 返回是否有状态变化（实体不存在 / 状态未变 = false）。
    pub fn set_teleport_enabled(&mut self, entity: i32, enabled: bool) -> bool {
        self.teleport.set_trigger_enabled(entity, enabled) > 0
    }

    /// 某个实体的传送触发区域当前是否启用（诊断 / 宿主回读用）。
    pub fn teleport_enabled(&self, entity: i32) -> bool {
        self.teleport.trigger_enabled(entity)
    }

    /// 名门控总开关（默认开，`from_json` 置 true）。`false` = 忽略所有 `filter_name`，
    /// 退回「碰到就传」的旧行为；供 `__vbspTeleportFilterOff` 逃生舱使用。
    pub fn set_teleport_filter_enabled(&mut self, enabled: bool) {
        self.teleport.filter_enabled = enabled;
    }

    /// 设置死亡 Y 阈值（HU）：`origin.y` 低于该值即在下一个非 noclip 步被判掉落死亡。
    /// 权威侧在 world 重建后会重放最近一次设定值（`src/ts-shared/auth/worker-dispatch.ts` 的 `set_death_y` 重放）。
    pub fn set_death_y(&mut self, y: f64) {
        self.death_y = y;
    }

    /// 按 JSON patch 覆盖物理参数：**只处理出现过的键**，未出现的键保持原值。
    ///
    /// 可接受的键（与下方 `Patch` 结构逐字对应，共 16 个）：`gravity` / `accelerate` /
    /// `friction` / `stop_speed` / `jump_height` / `air_accelerate` / `run_speed` /
    /// `walk_speed` / `crouch_speed` / `autobhop` / `bhop_speed_clamp` / `sensitivity` /
    /// `yaw_bind_speed` / `noclip_speed` / `push_out` /
    /// `push_out_only_when_solid`。
    ///
    /// 三项碰撞箱尺寸不在这里，走 `set_hull`。
    /// JSON 解析失败返回 `Err`；逐字段赋值在解析之后，故失败时参数保持原值。
    pub fn set_params(&mut self, json: &str) -> Result<(), JsValue> {
        #[derive(serde::Deserialize)]
        struct Patch {
            gravity: Option<f64>,
            accelerate: Option<f64>,
            friction: Option<f64>,
            stop_speed: Option<f64>,
            jump_height: Option<f64>,
            air_accelerate: Option<f64>,
            run_speed: Option<f64>,
            walk_speed: Option<f64>,
            crouch_speed: Option<f64>,
            autobhop: Option<bool>,
            bhop_speed_clamp: Option<bool>,
            sensitivity: Option<f64>,
            yaw_bind_speed: Option<f64>,
            noclip_speed: Option<f64>,
            push_out: Option<f64>,
            push_out_only_when_solid: Option<bool>,
        }
        let p: Patch = serde_json::from_str(json).map_err(|e| to_js_err(e, "set_params"))?;
        if let Some(v) = p.gravity {
            self.params.gravity = v;
        }
        if let Some(v) = p.accelerate {
            self.params.accelerate = v;
        }
        if let Some(v) = p.friction {
            self.params.friction = v;
        }
        if let Some(v) = p.stop_speed {
            self.params.stop_speed = v;
        }
        if let Some(v) = p.jump_height {
            self.params.jump_height = v;
        }
        if let Some(v) = p.air_accelerate {
            self.params.air_accelerate = v;
        }
        if let Some(v) = p.run_speed {
            self.params.run_speed = v;
        }
        if let Some(v) = p.walk_speed {
            self.params.walk_speed = v;
        }
        if let Some(v) = p.crouch_speed {
            self.params.crouch_speed = v;
        }
        if let Some(v) = p.autobhop {
            self.params.autobhop = v;
        }
        if let Some(v) = p.bhop_speed_clamp {
            self.params.bhop_speed_clamp = v;
        }
        if let Some(v) = p.sensitivity {
            self.params.sensitivity = v;
        }
        if let Some(v) = p.yaw_bind_speed {
            self.params.yaw_bind_speed = v;
        }
        if let Some(v) = p.noclip_speed {
            self.params.noclip_speed = v;
        }
        if let Some(v) = p.push_out {
            self.params.push_out = v;
        }
        if let Some(v) = p.push_out_only_when_solid {
            self.params.push_out_only_when_solid = v;
        }
        Ok(())
    }

    /// 设置碰撞箱三围（HU）：半宽、站立高、蹲伏高。同时写回 `params` 的 `hull_*` 三项
    /// 并调用 `player::apply_hull` 重建四组 mins/maxs。
    /// 箱体改变是即时的——蹲伏过程中改尺寸，后续碰撞就按新箱体判定。
    pub fn set_hull(&mut self, half_width: f64, stand_height: f64, duck_height: f64) {
        self.params.hull_half_width = half_width;
        self.params.hull_stand_height = stand_height;
        self.params.hull_duck_height = duck_height;
        player::apply_hull(&mut self.player, half_width, stand_height, duck_height);
    }

    /// 开关 noclip。开启后 `step_core` 改走 `noclip_step`：位置由 Rust 侧直接推进
    /// （每步位移 = `params.noclip_speed`，按住 sprint 位再 ×4），
    /// 不参与碰撞，也不触发传送与死亡判定。
    /// 关闭后位置保留——不会回到开启前的位置。
    pub fn set_noclip(&mut self, enabled: bool) {
        self.noclip = enabled;
    }

    /// 返回当前状态的 JS 对象。字段固定 11 项：`posX/posY/posZ`（HU）、
    /// `yaw`/`pitch`（度）、`velX/velY/velZ`（HU/s）、`onGround`、`contactTicks`、`eyeHeight`（HU）。
    ///
    /// **不含时间戳**——帧时间由调用方自行记录；不含蹲伏/滑行等扩展位。每次调用都新建对象。
    pub fn state(&self) -> JsValue {
        self.state_js()
    }

    /// 取走最近一次物理事件并清空槽位；无事件时返回 `null`。
    ///
    /// 一次性消费：同一事件不会被取到两次；未被取走的事件会被后续事件覆盖。
    /// 返回结构：
    /// - `{ kind: 'teleport', targetname: string, origin: [x, y, z], yaw: number }`
    /// - `{ kind: 'death' }`
    ///
    /// `apps/game` 侧不消费本方法；调用方是 debug 渲染线
    /// （`apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.consumePhysEvents`）。
    pub fn take_event(&mut self) -> JsValue {
        match self.event.take() {
            Some(PhysEvent::Teleport {
                targetname,
                origin,
                yaw,
            }) => {
                let obj = js_sys::Object::new();
                let _ = js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("kind"),
                    &JsValue::from_str("teleport"),
                );
                let _ = js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("targetname"),
                    &JsValue::from_str(&targetname),
                );
                let arr = js_sys::Array::new();
                for v in origin {
                    arr.push(&JsValue::from_f64(v));
                }
                let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("origin"), &arr);
                let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("yaw"), &JsValue::from_f64(yaw));
                obj.into()
            }
            Some(PhysEvent::Death) => {
                let obj = js_sys::Object::new();
                let _ = js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("kind"),
                    &JsValue::from_str("death"),
                );
                obj.into()
            }
            None => JsValue::NULL,
        }
    }
}

// ---------------------------------------------------------------------------
// phys-debug 专属导出（feature = "phys-debug"）
//
// 只有 apps/debug 经 websurf-wasm-bindings 的 debug-tools 打开本 feature；apps/game 与
// apps/viewer 的产物里没有下面这 12 个导出。apps/game 运行期唯一用到的 debug_ 导出是
// PhysWorld::debug_line_trace（env_laser 射线截断），它留在上面的公共 impl 里。
// ---------------------------------------------------------------------------
#[cfg(feature = "phys-debug")]
#[wasm_bindgen]
impl PhysWorld {
    // -----------------------------------------------------------------------
    // 种子面 v2：整实例状态的可序列化投影，实现在 `phys::seed`（phys-debug 专属）
    // （`extract_seed` / `apply_seed` 互逆一对）。本文件只负责 JSON 边界与借用规则。
    // -----------------------------------------------------------------------

    /// 用一份种子 JSON 覆盖本实例状态（scratch 实例的单向写入入口）。
    ///
    /// `v` 必须等于 `seed::SEED_SCHEMA_VERSION`（= 2），否则 `Err`；
    /// NaN / Inf 一律拒绝（FAIL LOUD），不做静默夹取。
    /// `triggers_inside` 的长度必须与本实例的触发器数量一致，否则 `Err`。
    /// 事件槽不参与播种——事件不可播种。
    ///
    /// 只写本实例：不读自身其余状态做决策、不触碰其他实例。
    /// 9 参 `set_state`的签名与语义不受本方法影响。
    pub fn set_state_ex(&mut self, json: &str) -> Result<(), JsValue> {
        let s: seed::SeedState =
            serde_json::from_str(json).map_err(|e| to_js_err(e, "set_state_ex"))?;
        self.apply_seed(&s).map_err(|e| JsValue::from_str(&e))
    }

    /// 导出本实例的全量状态 JSON，与 `set_state_ex` 同一 schema。
    ///
    /// `include_event = false`：不导出事件槽。种子链必须用 `false`，因为事件不可播种。
    /// `include_event = true`：附带当前待取事件，供审计/调试导出。
    ///
    /// f64 经 serde_json 往返位级精确，因此"导出 → 写回"不引入数值漂移。
    /// 非有限值会被序列化成 `null` 且**不在此报错**，由写回侧 `set_state_ex` 拒绝。
    pub fn state_full_json(&self, include_event: bool) -> Result<String, JsValue> {
        serde_json::to_string(&self.extract_seed(include_event))
            .map_err(|e| to_js_err(e, "state_full_json"))
    }

    /// 诊断计数：盒-AABB 门校验被否决的次数（进程内单调递增，无复位入口）。
    /// 计数点在 `src/phys/world.rs` 的 `clip_planes` 的两个否决分支，
    /// 计数器是 `world::GATE_VETO_COUNT` —— **同一 wasm 模块内所有实例共享一份**，
    /// 因此它不是"本实例的"统计。消费方只有 `apps/game/scripts` 的三个排查脚本。
    pub fn gate_veto_count(&self) -> u32 {
        world::GATE_VETO_COUNT.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 诊断：对给定线段做一次扫掠，返回 `[fraction, normal_x, normal_y, normal_z]`。
    ///
    /// 扫掠盒取玩家**当前**碰撞箱（`self.player.mins()` / `maxs()`）——
    /// 蹲伏时用的是蹲箱，所以同一线段在站/蹲两态下结果不同。未命中时法线回填 `[0,0,0]`。
    /// 不推进物理、不改任何状态。消费方只有 `apps/game/scripts/phys-gate-probe2.mjs`（已移除）。
    pub fn debug_trace(&mut self, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64) -> Vec<f64> {
        let mins = self.player.mins();
        let maxs = self.player.maxs();
        let r = self.world.trace(
            &[sx, sy, sz],
            &[ex, ey, ez],
            &mins,
            &maxs,
        );
        let n = r.normal.unwrap_or([0.0, 0.0, 0.0]);
        vec![r.fraction, n[0], n[1], n[2]]
    }

    /// 诊断：**在给定点上并置两种碰撞查询**，判定它们是否一致。
    ///
    /// 返回 6 个数：
    /// `[0] is_position_free（true=1 / false=0）`、
    /// `[1] 原地向下扫掠 1 HU 的 fraction`、
    /// `[2..4] 该扫掠命中的法线`、
    /// `[5] stuck_ticks`。
    ///
    /// 为什么要并置：移动走 `World::trace`，而 `player::check_stuck` 走
    /// `World::is_position_free` —— **两个不同的查询**。若某处 `is_position_free` 说
    /// 「不空」而 `trace` 说「通畅」，`check_stuck` 就会把玩家判成卡死：60 个挤出候选
    /// 全失败 → `stuck_ticks` 自增、速度清零、返回 true → `player_tick` **跳过本 tick
    /// 全部移动与落地判定**，表现为「有速度、周围无障碍、却完全不动」。
    ///
    /// 实测触发场景（`surf_666`，`models/props/666/s1_ramp1b.mdl` 的 .phy 三角网格）：
    /// 玩家在 `(x=-13536.41, y=14560.03, z=-9786.37)` 卡住 3.5 秒，同位置 60 HU 的水平
    /// 扫掠 `debug_trace` 全部 `fraction = 1.0`（畅通），但本方法会报
    /// `is_position_free = 0` ⇒ 卡死分支。
    ///
    /// 扫掠盒取玩家**当前**碰撞箱，与 [`PhysWorld::debug_trace`] 同口径。不推进物理、
    /// 不改任何状态。
    #[wasm_bindgen]
    pub fn debug_position_probe(&mut self, x: f64, y: f64, z: f64) -> Vec<f64> {
        let mins = self.player.mins();
        let maxs = self.player.maxs();
        let free = self.world.is_position_free(&[x, y, z], &mins, &maxs);
        let r = self.world.trace(&[x, y, z], &[x, y - 1.0, z], &mins, &maxs);
        let n = r.normal.unwrap_or([0.0, 0.0, 0.0]);
        vec![
            if free { 1.0 } else { 0.0 },
            r.fraction,
            n[0],
            n[1],
            n[2],
            self.player.stuck_ticks as f64,
        ]
    }

    /// 归属诊断：报"哪些碰撞体把这个盒体判成实心"。
    ///
    /// 返回 18 个数：
    ///
    /// ```text
    /// [0]     空闲（1）/ 不空闲（0）—— 与 debug_position_probe[0] 同义，便于单看本表
    /// [1]     brush 命中数
    /// [2]     三角形命中数
    /// [3..5]  第一个实心 brush 的 AABB min xyz；无 brush 命中时全为 0
    /// [6..8]  第一个实心 brush 的 AABB max xyz；无 brush 命中时全为 0
    /// [9]     有三角形命中（1/0）
    /// [10]    三角形所属网格在 tri_meshes 的下标（`TriEntry::mesh_index`）；无命中时为 -1
    /// [11..13] 第一个实心三角形的 AABB min xyz
    /// [14..16] 第一个实心三角形的 AABB max xyz
    /// [17]    该三角形在网格 indices 里的首个顶点下标（b / c 未导出，定位靠 AABB）
    /// ```
    ///
    /// 两个计数都是**逐个候选**判实心的数量，不是 broadphase 候选数。
    /// 碰撞箱取玩家**当前**箱，与 [`PhysWorld::debug_trace`] 同口径；不推进物理、不改状态。
    /// 名字经 [`PhysWorld::debug_tri_mesh_name`] 按下标 10 取。
    ///
    /// 用途：看板 `T-065` 的待裁决第 ① 条 —— 查明把玩家判成实心的到底是
    /// 世界 brush 还是某个模型的 .phy 三角网格，以及是哪一个模型。
    #[wasm_bindgen]
    pub fn debug_collide_attrib(&mut self, x: f64, y: f64, z: f64) -> Vec<f64> {
        let mins = self.player.mins();
        let maxs = self.player.maxs();
        let a = self.world.collide_attrib(&[x, y, z], &mins, &maxs);
        let mut out = vec![if a.free { 1.0 } else { 0.0 }, a.brush_hits as f64, a.tri_hits as f64];
        match a.first_brush_aabb {
            Some((lo, hi)) => {
                out.extend_from_slice(&lo);
                out.extend_from_slice(&hi);
            }
            // 无 brush 命中：补 6 个 0（与 Some 分支的 3+3 等长，保持返回长度恒为 18）
            None => out.extend(std::iter::repeat_n(0.0, 6)),
        }
        match a.first_tri {
            Some(t) => {
                out.push(1.0);
                out.push(t.mesh_index as f64);
                out.extend_from_slice(&t.aabb.0);
                out.extend_from_slice(&t.aabb.1);
                out.push(t.verts[0] as f64);
            }
            // 同上：9 个占位（1 + 1 + 3 + 3 + 1）
            None => out.extend_from_slice(&[0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        }
        out
    }

    /// 取 `World::tri_meshes` 第 `index` 个网格的模型名；下标越界返回空串。
    ///
    /// 供 [`PhysWorld::debug_collide_attrib`] 的下标 12 配套使用。名字来自 tri JSON 的
    /// `name` 字段（形如 `models/props/666/s1_ramp1b.mdl`）。
    #[wasm_bindgen]
    pub fn debug_tri_mesh_name(&self, index: usize) -> String {
        self.world
            .tri_meshes
            .get(index)
            .map(|m| m.name.clone())
            .unwrap_or_default()
    }

    /// 卡死挤出的只读重放（见 [`player::stuck_probe`] 的完整文档）。
    ///
    /// 返回 13 个数：`[0]` 该点是否空闲；`[1..4]` 会选中候选的位移 dx/dy/dz
    /// （无胜出为 -999）；`[5]` 该候选的 dist（无胜出为 -1）；`[6]` 该候选在
    /// `STUCK_DIRS` 里的下标（无胜出为 -1）；`[7]` 试了几个候选才成功；
    /// `[8..12]` dist=1 时 +y / +x / -x / +z / -z 各自是否空闲（1/0）。
    ///
    /// 三个坐标就是试探点，**不需要先把玩家挪过去**；碰撞箱仍取玩家**当前**箱。
    /// 省略三个坐标则等价于用玩家当前 `origin`（与 `check_stuck` 的输入一致）。
    ///
    /// **纯诊断，不改任何状态** —— 不挪 `origin`、不写 `stuck_ticks`、不动 `velocity`，
    /// 因此可以在任意 tick 上反复调用。它复用的枚举顺序与 `check_stuck` 完全一致，
    /// 所以它选中什么就是 `check_stuck` 会选中什么。
    #[wasm_bindgen]
    pub fn debug_stuck_probe(&mut self, x: Option<f64>, y: Option<f64>, z: Option<f64>) -> Vec<f64> {
        let at = match (x, y, z) {
            (Some(a), Some(b), Some(c)) => Some([a, b, c]),
            _ => None,
        };
        player::stuck_probe(&mut self.world, &self.player, at).to_vec()
    }

    /// `.phy` 凸体转 brush 的只读诊断：JSON 数组 `[块数, box bevel, edge bevel, 退回三角形路径的块数]`。
    ///
    /// 数据源是 `build_world` 第 2.5 步的统计（每次 `build_world` 覆盖）。存在的理由：`eprintln!`
    /// 在 wasm 侧不落到 JS 控制台，而"接线后到底有多少块走了 brush 平面表、补面量级多大"需要可查。
    #[wasm_bindgen]
    pub fn debug_hull_stats(&self) -> String {
        format!(
            "[{},{},{},{}]",
            self.hull_stats[0], self.hull_stats[1], self.hull_stats[2], self.hull_stats[3]
        )
    }

    /// 取玩家**当前**碰撞箱的六个分量：`[min_x, min_y, min_z, max_x, max_y, max_z]`。
    ///
    /// 只读诊断。存在的理由：`set_hull(half_width, stand_height, duck_height)` 的**第三个
    /// 参数是蹲下高度，不是 z 向伸长** —— `player::apply_hull` 把 z 半伸直接取成
    /// `half_width`，所以 `set_hull(16, 72, 54)` 的站立盒是 **32 × 72 × 32**（x × y × z），
    /// 蹲下盒是 32 × 54 × 32。这个参数含义容易被误读成「向前探 54 HU」，本绑定给出真值。
    #[wasm_bindgen]
    pub fn debug_hull(&self) -> Vec<f64> {
        let mins = self.player.mins();
        let maxs = self.player.maxs();
        vec![
            mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2],
        ]
    }

    /// 卡死判据的盒尺寸敏感性扫描：给定脚底位置，把盒高与 z 半伸扫成一张表。
    ///
    /// 每个格子是一次独立的 `World::is_position_free`。盒的**底面**钉在 `feet_y`：
    /// `origin` 取 `[x, feet_y, z]`，`mins = [-half_x, 0, -hz]`、`maxs = [half_x, h, hz]`，
    /// 于是盒恰好跨 y 从 `feet_y` 到 `feet_y + h`。**不推进物理、不改任何状态。**
    ///
    /// 返回 `(max_h + 1) * (max_hz + 1)` 个 0/1，**行优先**：
    /// 第 `hi * (max_hz + 1) + zi` 格 = 盒高 `hi`、z 半伸 `zi` 时是否空闲（1 = 空）。
    /// JS 侧按下式还原坐标轴：`hi = floor(i / (max_hz + 1))`、`zi = i % (max_hz + 1)`。
    ///
    /// **为什么需要它**：`player::check_stuck` 判"卡住"用的是**整个身体盒**
    /// （`set_hull(16, 72, 54)` ⇒ 高 72、z 半伸 54）。而玩家盒 z 半伸 54 意味着身体向前
    /// 探出 54 HU —— 在任何一个"前方地面比脚下高"的坡上，那 54 HU 内的坡面都会落进身体盒，
    /// 于是判据必然报"卡在实体里"。本表把"多小的盒才不误报"直接量出来，
    /// 使看板 `T-065` §7 第 ④ 条（判据是否选错盒）可裁决。
    #[wasm_bindgen]
    pub fn debug_free_table(
        &mut self,
        x: f64,
        feet_y: f64,
        z: f64,
        half_x: f64,
        max_h: usize,
        max_hz: usize,
    ) -> Vec<f64> {
        let cols = max_hz + 1;
        let mut out = Vec::with_capacity((max_h + 1) * cols);
        for hi in 0..=max_h {
            let h = hi as f64;
            let mins = [-half_x, 0.0, 0.0];
            let maxs = [half_x, h, 0.0];
            for zi in 0..=max_hz {
                let hz = zi as f64;
                let mut mm = mins;
                let mut xx = maxs;
                mm[2] = -hz;
                xx[2] = hz;
                let ok = self
                    .world
                    .is_position_free(&[x, feet_y, z], &mm, &xx);
                out.push(if ok { 1.0 } else { 0.0 });
            }
        }
        out
    }

    /// 「沿指定方向能否脱身」的扫描：看板 `T-065` §8 修法 **E** 的实测入口。
    ///
    /// 对 `d = 1 ..= max_d` 每个整数距离，逐步做两件事并各记一个数：
    /// ① 用 `World::trace` 把当前盒体沿 `(nx,ny,nz)` 扫 `d` HU，取 `fraction`；
    /// ② 扫掠终点用 `World::is_position_free` 判是否空闲（1/0）。
    ///
    /// 返回 `2 * max_d` 个数，成对存放：**第 `2*(d-1)` 项是 fraction、第 `2*(d-1)+1` 项是
    /// 终点空闲标记**。`fraction = 1.0` 表示这一步**没被任何东西挡住**。
    ///
    /// 盒取玩家**当前**箱；不推进物理、不改任何状态。
    ///
    /// **为什么两个数都要**：只有 fraction = 1 不够 —— 沿法线抬起来可能仍落在实体里
    /// （看板 `T-065` §7 实测：卡死点沿 +y 抬 1~8 HU 全部仍不空闲）。
    /// 只有终点空闲也不够 —— 终点可能恰好在实体的另一侧，中间隔着材料。
    /// **两个同时成立**才等于「这一步真的能脱身」。
    // 7 个入参是调试探针的 JS 契约（坐标 3 + 法线 3 + 步数），收成结构体反而让
    // 控制台/测试调用点全部改写；函数体是纯循环，没有内部复杂度。
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen]
    pub fn debug_normal_escape(
        &mut self,
        x: f64,
        y: f64,
        z: f64,
        nx: f64,
        ny: f64,
        nz: f64,
        max_d: usize,
    ) -> Vec<f64> {
        let mins = self.player.mins();
        let maxs = self.player.maxs();
        let start = [x, y, z];
        let mut out = Vec::with_capacity(2 * max_d);
        for d in 1..=max_d {
            let end = [x + nx * d as f64, y + ny * d as f64, z + nz * d as f64];
            let tr = self.world.trace(&start, &end, &mins, &maxs);
            let free = self.world.is_position_free(&end, &mins, &maxs);
            out.push(tr.fraction);
            out.push(if free { 1.0 } else { 0.0 });
        }
        out
    }
}

impl PhysWorld {
    /// 把 `player` 的当前值写成一个**新建**的 JS 对象，是 `tick` / `state`
    /// 两个导出方法的共同出口。字段集固定 11 项（含调试用的 `contactTicks`），见 `state`
    /// （`pub fn state`）的文档。
    fn state_js(&self) -> JsValue {
        let p = &self.player;
        let obj = js_sys::Object::new();
        set_f64(&obj, "posX", p.origin[0]);
        set_f64(&obj, "posY", p.origin[1]);
        set_f64(&obj, "posZ", p.origin[2]);
        set_f64(&obj, "yaw", p.yaw);
        set_f64(&obj, "pitch", p.pitch);
        set_f64(&obj, "velX", p.velocity[0]);
        set_f64(&obj, "velY", p.velocity[1]);
        set_f64(&obj, "velZ", p.velocity[2]);
        set_bool(&obj, "onGround", p.on_ground);
        set_f64(&obj, "contactTicks", p.contact_ticks as f64); // 传送 gate 计数（调试/回归测试用）
        set_f64(&obj, "eyeHeight", p.eye_height());
        obj.into()
    }

    /// 传送的唯一写入口：落点、清零速度、离地、朝向、同步 `prev_origin`。
    /// `teleport_to` / `teleport_to_spawn` / 步内触发传送三条路径都汇聚到这里，
    /// 以保证"传送后字段集"始终一致。**不碰冷却**：是否清冷却由调用方决定
    /// （步内命中保留 `check` 置的 0.5 s，外部重定位显式清零）。
    fn apply_teleport(&mut self, origin: &[f64; 3], yaw: f64) {
        self.player.origin = *origin;
        self.player.velocity = [0.0, 0.0, 0.0];
        self.player.on_ground = false;
        self.player.yaw = yaw;
        self.player.prev_origin = *origin;
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 把 Rust 侧错误格式化成 `"<上下文>: <Debug>"` 形式的 JS 异常值。
/// `ctx` 由调用点自报（方法名或数据结构名），用于区分同类解析失败的来源。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

/// 往 JS 对象写一个 number 属性；`Reflect::set` 的返回值被显式忽略。
fn set_f64(obj: &js_sys::Object, key: &str, v: f64) {
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_f64(v));
}

/// 往 JS 对象写一个 boolean 属性；`Reflect::set` 的返回值同样被忽略。
fn set_bool(obj: &js_sys::Object, key: &str, v: bool) {
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_bool(v));
}

/// 把俯仰角收进 `[-PITCH_CLAMP, PITCH_CLAMP]`。
///
/// 与直接写 `pitch.clamp(-C, C)` 的差别在 NaN：`f64::max` / `min` 遇到 NaN 返回另一
/// 个操作数，所以 `pitch.max(-C).min(C)` 把 NaN 收敛为 `-C`；`f64::clamp` 会传播 NaN，
/// `pitch` 由 TS 鼠标增量累加而来，不允许 NaN 漏进后续三角运算。其余取值两者逐位相同。
fn clamp_pitch(pitch: f64) -> f64 {
    if pitch.is_nan() {
        -player::PITCH_CLAMP
    } else {
        pitch.clamp(-player::PITCH_CLAMP, player::PITCH_CLAMP)
    }
}

/// 键位掩码 → `InputState`。位定义与 TS 侧 `KEY_MASK` 逐位对应
/// （`src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK`），两侧无单边位：
/// `0x01` forward / `0x02` back / `0x04` left / `0x08` right / `0x10` jump /
/// `0x20` duck / `0x40` walk（TS 侧叫 `sprint`）/ `0x80` reset /
/// `0x100` wheelJump / `0x200` yawLeft / `0x400` yawRight。
///
/// 两处合并语义：`0x10` 与 `0x100` 一起并入 `input.jump`（滚轮跳等价空格）；
/// `yaw_left` / `yaw_right` 只被 `noclip_step` 消费，常规步进不读它们
/// —— Q/E 转向在 TS 输入层已折算成等效鼠标增量。
fn apply_input(p: &mut Player, mask: u32) {
    p.input.forward = mask & 0x01 != 0;
    p.input.back = mask & 0x02 != 0;
    p.input.left = mask & 0x04 != 0;
    p.input.right = mask & 0x08 != 0;
    // wheelJump（0x100）并入 jump：滚轮跳与空格跳等价
    p.input.jump = mask & 0x10 != 0 || mask & 0x100 != 0;
    p.input.duck = mask & 0x20 != 0;
    p.input.walk = mask & 0x40 != 0;
    p.input.reset = mask & 0x80 != 0;
    p.input.yaw_left = mask & 0x200 != 0;
    p.input.yaw_right = mask & 0x400 != 0;
}

/// noclip 单步：先按 Q/E 位转 yaw，再沿输入方向推进位置，全程不做碰撞。
/// 位移 = `params.noclip_speed × (sprint ? 4 : 1) × dt`；前进方向含 pitch 分量
/// （可上下飞），右移只在水平面内。
/// 无输入时提前返回，此时**不更新 `prev_origin`**。
fn noclip_step(p: &mut Player, dt: f64, params: &PhysParams) {
    // Q/E 转向在 noclip 下同样生效
    if p.input.yaw_left {
        p.yaw += params.yaw_bind_speed * dt;
    }
    if p.input.yaw_right {
        p.yaw -= params.yaw_bind_speed * dt;
    }
    let fmove = (if p.input.forward { 1.0 } else { 0.0 }) - (if p.input.back { 1.0 } else { 0.0 });
    let smove = (if p.input.right { 1.0 } else { 0.0 }) - (if p.input.left { 1.0 } else { 0.0 });
    if fmove == 0.0 && smove == 0.0 {
        return;
    }
    // noclip_speed 基准；sprint（Shift）再 ×4 加速
    let speed = params.noclip_speed * if p.input.walk { 4.0 } else { 1.0 } * dt;
    let yaw_rad = p.yaw * (std::f64::consts::PI / 180.0);
    let pitch_rad = p.pitch * (std::f64::consts::PI / 180.0);
    let cp = pitch_rad.cos();
    let fwd = [-yaw_rad.sin() * cp, pitch_rad.sin(), -yaw_rad.cos() * cp];
    let right = [yaw_rad.cos(), 0.0, -yaw_rad.sin()];
    p.origin[0] += (fwd[0] * fmove + right[0] * smove) * speed;
    p.origin[1] += fwd[1] * fmove * speed;
    p.origin[2] += (fwd[2] * fmove + right[2] * smove) * speed;
    p.prev_origin = p.origin;
}

/// 解析 `WasmBrush[]` JSON 为 `PhysBrush` 列表（Y-up、法线朝外）。
/// 字段名与 wasm 层输出严格一致：`planes[{normal, dist}]` / `min` / `max` /
/// `is_ladder` / `is_solid` —— 多出的字段被忽略，缺失的字段直接解析失败。
fn parse_brushes(json: &str) -> Result<Vec<PhysBrush>, JsValue> {
    #[derive(serde::Deserialize)]
    struct WasmBrushPlane {
        normal: [f32; 3],
        dist: f32,
    }
    #[derive(serde::Deserialize)]
    struct WasmBrush {
        planes: Vec<WasmBrushPlane>,
        min: [f32; 3],
        max: [f32; 3],
        is_ladder: bool,
        is_solid: bool,
        /// 实体枚举下标（-1 = worldspawn）。旧产物没有该字段时按 worldspawn 处理。
        #[serde(default = "default_brush_entity")]
        entity: i32,
        /// 出生时是否实心。缺省 true（旧产物 = 载图即实心，行为不变）。
        #[serde(default = "default_brush_start_solid")]
        start_solid: bool,
    }
    fn default_brush_entity() -> i32 {
        -1
    }
    fn default_brush_start_solid() -> bool {
        true
    }
    let data: Vec<WasmBrush> =
        serde_json::from_str(json).map_err(|e| to_js_err(e, "brush JSON 解析"))?;
    Ok(data
        .into_iter()
        .map(|b| PhysBrush {
            planes: b
                .planes
                .into_iter()
                .map(|p| PhysPlane {
                    normal: p.normal,
                    dist: p.dist,
                })
                .collect(),
            min: b.min,
            max: b.max,
            is_ladder: b.is_ladder,
            is_solid: b.is_solid,
            entity: b.entity,
            start_solid: b.start_solid,
        })
        .collect())
}

/// 解析 `TriMesh[]` JSON（`name` / `vertices` / `indices` / `min` / `max`）。
/// 空串或纯空白按"无三角形碰撞"处理，返回空列表而非错误。
fn parse_tri_meshes(json: &str) -> Result<Vec<TriMesh>, JsValue> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    #[derive(serde::Deserialize)]
    struct WasmTriMesh {
        /// 模型名，**可选**：`export_model_tri_colliders` 之类的生产者若不带该字段，
        /// serde 按 `default` 填空串而不是整批解析失败 —— 归属诊断读不到名字时只会
        /// 看到空串，碰撞判定不受影响。
        #[serde(default)]
        name: String,
        // 生产侧就是 f32；这里按 f32 接收再升 f64，保证与 WSBW 二进制解码逐位一致。
        vertices: Vec<[f32; 3]>,
        indices: Vec<[u32; 3]>,
        min: [f32; 3],
        max: [f32; 3],
    }
    let data: Vec<WasmTriMesh> =
        serde_json::from_str(json).map_err(|e| to_js_err(e, "tri JSON 解析"))?;
    Ok(data
        .into_iter()
        .map(|m| TriMesh {
            name: m.name,
            vertices: m
                .vertices
                .into_iter()
                .map(|v| [v[0] as f64, v[1] as f64, v[2] as f64])
                .collect(),
            indices: m.indices,
            min: [m.min[0] as f64, m.min[1] as f64, m.min[2] as f64],
            max: [m.max[0] as f64, m.max[1] as f64, m.max[2] as f64],
        })
        .collect())
}

/// 求梯子 brush 的朝向：取水平分量最大的那个面，把其法线的 x/z 归一化作为 facing，
/// y 恒为 0。退化情形统一回退 `[0,0,1]` —— 无面，或水平分量近似为零。
/// 结果由 `build_world` 写进 `LadderVolume.facing`。
fn compute_ladder_facing(planes: &[world::Plane]) -> [f64; 3] {
    if planes.is_empty() {
        return [0.0, 0.0, 1.0];
    }
    let mut best = &planes[0];
    let mut best_horiz = -1.0f64;
    for p in planes {
        let horiz = (p.normal[0] * p.normal[0] + p.normal[2] * p.normal[2]).sqrt();
        if horiz > best_horiz {
            best_horiz = horiz;
            best = p;
        }
    }
    let mut fx = best.normal[0];
    let mut fz = best.normal[2];
    let len = (fx * fx + fz * fz).sqrt();
    if len > 1e-6 {
        fx /= len;
        fz /= len;
    } else {
        fx = 0.0;
        fz = 1.0;
    }
    [fx, 0.0, fz]
}

/// 卡死时自动恢复默认碰撞箱：`set_auto_restore_hull` 置位后，`step_core` 每步末尾检查
/// `player::stuck_ticks`（>0 即本步判为卡死），命中就把三围写回 `DEFAULT_HULL_*`。
/// 判据本身的着地门（`on_ground` 为真不判卡死）保持不变，故只有**离地**卡死会触发。
#[wasm_bindgen]
impl PhysWorld {
    /// 开关：卡死（离地判定）时自动把碰撞箱恢复成默认三围。
    pub fn set_auto_restore_hull(&mut self, enabled: bool) {
        self.auto_restore_hull = enabled;
    }
}

impl PhysWorld {
    /// `step_core` 末尾的钩子；开关关闭或本步未判卡死时什么都不做。
    fn maybe_restore_hull(&mut self) {
        if self.auto_restore_hull && self.player.stuck_ticks > 0 {
            self.set_hull(
                player::DEFAULT_HULL_HALF_WIDTH,
                player::DEFAULT_HULL_STAND_HEIGHT,
                player::DEFAULT_HULL_DUCK_HEIGHT,
            );
        }
    }
}
