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
//! 导出面：本文件 `#[wasm_bindgen] impl PhysWorld`共 **24 个 `pub fn`**（含 `new`）。
//! 其中 `set_yaw_pitch`在 `apps/**` 与 `src/**` 内无任何调用点；
//! `predict`只被 `apps/game/scripts` 的两个验证脚本调用；
//! `gate_veto_count`与 `debug_trace`同样只服务脚本。
//!
//! 零分配支路（**当前未装配**）：`tick_into` 把状态写进本实例固定缓冲 `state_out`，
//! JS 侧经 `state_out_ptr`在 wasm 线性内存上建 `Float64Array` 视图直读，不构造
//! wasm→JS 对象。视图长度有两个口径：`tick-authority` 用满 22 槽
//! （`src/ts-shared/auth/tick-authority.ts` 的 `authorityView` / `scratchView`），
//! 解耦线只取前 8 槽（`src/ts-shared/decoupled/decoupled-loop.ts` 的 `outView`）
//! ——因此 9-11 与 15-19 槽目前没有 TS 读取方。
//! 该支路的唯一调用者是 `src/ts-shared/` 内两个控制器
//! （`src/ts-shared/auth/tick-authority.ts` 的 `authority.tick_into` 与
//! `src/ts-shared/decoupled/decoupled-loop.ts` 的 `phys.tick_into`），
//! 而这两个控制器在三个工程内都没有装配点
//! （`createTickAuthority` 仅被其单测调用），故线上路径走的是 `tick()` 返回对象。
//! wasm 内存增长后 `memory.buffer` 会更换，视图必须按 `state_out_ptr` 重建。
//!
//! 边界：本模块只做状态推进与读取。不做 BSP 解析、不导出 GLB、不碰渲染；
//! 实例与实例之间不共享可变状态，唯一跨实例可变量是诊断计数器
//! `world::GATE_VETO_COUNT`（`src/phys/world.rs`，只增不减、无复位入口）。
//!
//! 测试归属：`p2_gate_tests`（4 项，盒-AABB 门校验回归）、`duck_surf_tests`（6 项，surf/蹲姿）；
//! 其余四个模块文件无 `#[test]`。`cargo test -p websurf-phys` 实测 10 passed / 0 failed。

pub mod player;
pub mod teleport;
pub mod world;

/// 种子面 v2：实例状态的可序列化投影（`src/phys/seed.rs` 的 `SEED_SCHEMA_VERSION = 2`），
/// 供 scratch 实例从权威实例单向播种，不做任何反向写入。
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
/// 贴面推开的步长无关性回归（2 项）：高刷屏步长下贴墙不得被"每次撞面都推"推着走。
#[cfg(test)]
mod contact_push_tests;

#[cfg(test)]
mod slope_speed_tests;

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
}

/// brush 的一个面：`normal` 为单位外法线，`dist` 为面到原点的有符号距离（HU）。
#[derive(Clone, Copy, Debug)]
pub struct PhysPlane {
    pub normal: [f32; 3],
    pub dist: f32,
}

/// 物理事件，经 `take_event`一次性取走。
/// 消费方：`apps/debug` 渲染线的事件循环（`apps/debug/src/renderer/renderer-main.ts` 的
/// `RendererMain.consumePhysEvents`，驱动计时挑战）与
/// `src/ts-shared/auth/tick-authority.ts`（`publishMeta` / `onWake` 两处取走）；
/// `apps/game` 侧未消费。
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
    noclip: bool,
    /// 是否已成功执行过 `build_world`。为 false 时 `tick` / `tick_into` / `predict` 直接返回现状。
    ready: bool,
    /// 最近一次物理事件（传送/死亡）。一次 `step_core` 至多产生一个，
    /// 由 `take_event` 取走后置空；不取则被下一次事件覆盖。
    event: Option<PhysEvent>,
    /// 零分配输出缓冲：`tick_into` 的唯一状态出口，JS 侧经 `state_out_ptr` 在 wasm
    /// 线性内存上建 `Float64Array` 视图直读，不构造 wasm→JS 对象。
    ///
    /// 槽位（定长 22；只追加不改既有槽序，故 0-7 的老消费方不受影响）：
    /// - 0-2 `origin` x/y/z（HU）；3-5 `velocity` x/y/z（HU/s）；6 `yaw`、7 `pitch`（度）
    /// - 8 `ducked`(0/1)；9 `duck_frac`；10 `ground_ticks_since_landing`(tick)；
    ///   11 `contact_ticks`(tick)；12 `surfing`(0/1)；13 `blocked_ticks`(tick)；
    ///   14 `on_ladder` 的梯子索引（不在梯子上为 -1）；15 `fall_velocity`(HU/s)；
    ///   16-18 `landing_velocity` x/y/z（HU/s）；19 `has_jumped_before`(0/1)
    /// - 20 `eye_height()`（HU）；21 `on_ground`(0/1)
    ///
    /// 当前消费口径：解耦线只建 8 槽视图
    /// （`src/ts-shared/decoupled/decoupled-loop.ts` 的 `outView`）；
    /// `tick-authority` 建 22 槽视图但只读 0-8、12-14、20、21
    /// （`src/ts-shared/auth/tick-authority.ts` 的 `fillPoseFromView`）——
    /// 因此 9-11 与 15-19 目前没有 TS 读取方。
    state_out: [f64; 22],
}

#[wasm_bindgen]
impl PhysWorld {
    /// 构造空实例：全默认参数、空世界（`ready = false`）、出生点 `[0, 100, 0]`、
    /// 死亡线 `-100000`。
    ///
    /// **不加载任何地图数据** —— 世界由随后的 `build_world` 建立。在 `build_world`
    /// 之前 `tick` / `tick_into` 只返回当前（默认）状态，不做物理推进。
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
            noclip: false,
            ready: false,
            event: None,
            state_out: [0.0; 22],
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
        // 1. brush → World.solids/ladders
        let brushes = parse_brushes(brush_json)?;
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
                });
            } else if b.is_solid {
                self.world.solids.push(Brush { planes, min, max });
            }
        }

        // 2. tri → World.tri_meshes（紧凑数组 [x,y,z]）
        let tri_meshes = parse_tri_meshes(tri_json)?;
        self.world.tri_meshes = tri_meshes;

        // 3. 空间索引
        self.world.build_index();

        // 4. teleport
        self.teleport = TeleportManager::from_json(teleport_json)
            .map_err(|e| JsValue::from_str(&format!("teleport: {e}")))?;

        // 5. 出生点 + 玩家
        self.spawn = [spawn_x, spawn_y, spawn_z];
        self.player = create_player(self.spawn, &self.params);
        self.player.yaw = spawn_yaw;
        self.player.prev_origin = self.spawn;
        self.ready = true;
        Ok(())
    }

    /// 推进一个步长，返回**新构造的状态对象**。
    ///
    /// 与 `tick_into` 完全同语义（同一个 `step_core`），差别只在出口：本方法经
    /// `state_js` 写 JS 对象（10 个字段），`tick_into` 写固定缓冲。
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

    /// 零分配推进：与 `tick` 完全同语义（同一个 `step_core`），但状态写进本实例的
    /// `state_out` 固定缓冲，**不构造任何 wasm→JS 对象**。
    ///
    /// JS 侧用法：`new Float64Array(memory.buffer, phys.state_out_ptr(), n)` 后按槽读；
    /// 槽位表见 `state_out` 字段文档。写入分两段：0-7 由本方法直写，
    /// 8-21 由 `fill_state_out` 写。
    ///
    /// wasm 内存增长后 `memory.buffer` 会换新对象、旧视图 detach，视图须按
    /// `state_out_ptr` 重建。未 `build_world` 时直接返回、不写缓冲。
    pub fn tick_into(&mut self, dt: f64, keys_mask: u32, dx: f64, dy: f64) {
        if !self.ready {
            return;
        }
        self.step_core(dt, keys_mask, dx, dy);
        let p = &self.player;
        let o = &mut self.state_out;
        o[0] = p.origin[0];
        o[1] = p.origin[1];
        o[2] = p.origin[2];
        o[3] = p.velocity[0];
        o[4] = p.velocity[1];
        o[5] = p.velocity[2];
        o[6] = p.yaw;
        o[7] = p.pitch;
        fill_state_out(p, o);
    }

    /// `state_out` 在 wasm 线性内存中的字节地址，供 JS 建 `Float64Array` 视图。
    /// 地址在实例存活期内不变；wasm 线性内存增长时 `memory.buffer` 会被替换成新对象，
    /// 故视图重建的判据是"重新取一次本地址"，而不是复用旧 buffer 对象。
    pub fn state_out_ptr(&self) -> usize {
        self.state_out.as_ptr() as usize
    }

    // -----------------------------------------------------------------------
    // 种子面 v2：整实例状态的可序列化投影，实现在 `phys::seed`
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
    /// 同模块内的零序列化复制请改用 `seed_from`（无 JSON 文本往返）。
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

    /// 零序列化种子通道：把 `src` 的全部种子字段逐字段拷进本实例（f64 直接拷贝，
    /// 位级精确，不经过 JSON 文本）。事件不复制——事件不可播种。
    ///
    /// 种子覆盖面即 `seed::SeedState` 的字段集：运动主态（origin/velocity/yaw/pitch/
    /// on_ground/ground_normal）、蹲伏态（ducked/duck_frac）、梯子与 surf 态、
    /// 计时器与诊断位、InputState、四组碰撞箱、传送冷却与 `triggers_inside`。
    /// **不在种子面**：`world` / `params` / `spawn` / `spawn_points` / `death_y` /
    /// `ready` / `noclip` —— 这些属构建期或宿主配置，要求两实例同图构建后才天然一致。
    ///
    /// 方向是 `src` → `self`，`src` 只读借用，不会被本方法改动。
    pub fn seed_from(&mut self, src: &PhysWorld) -> Result<(), JsValue> {
        let s = src.extract_seed(false);
        self.apply_seed(&s).map_err(|e| JsValue::from_str(&e))
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
    /// 不推进物理、不改任何状态。消费方只有 `apps/game/scripts/phys-gate-probe2.mjs`。
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
    /// 用途：`documents/open-issues/07` 的待裁决第 ① 条 —— 查明把玩家判成实心的到底是
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
            None => out.extend(std::iter::repeat(0.0).take(6)),
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
    /// 使 `documents/open-issues/07` §7 第 ④ 条（判据是否选错盒）可裁决。
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

    /// 「沿指定方向能否脱身」的扫描：`documents/open-issues/07` §8 修法 **E** 的实测入口。
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
    /// （`documents/open-issues/07` §7 实测：卡死点沿 +y 抬 1~8 HU 全部仍不空闲）。
    /// 只有终点空闲也不够 —— 终点可能恰好在实体的另一侧，中间隔着材料。
    /// **两个同时成立**才等于「这一步真的能脱身」。
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

    /// `tick` / `tick_into` 共用的核心步进：
    /// 输入 → 角度 → （noclip 分支 ｜ 传送/死亡/reset → 碰撞移动）。
    ///
    /// 角度写入必须排在 `player_tick` 之前 —— 移动方向由玩家 yaw 决定，
    /// 顺序反过来会让本步移动用上一帧的朝向。
    fn step_core(&mut self, dt: f64, keys_mask: u32, dx: f64, dy: f64) {
        // 输入：键位掩码 → InputState；鼠标增量 → yaw/pitch
        apply_input(&mut self.player, keys_mask);
        self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
        self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
        self.player.pitch = self
            .player
            .pitch
            .max(-player::PITCH_CLAMP)
            .min(player::PITCH_CLAMP);
        // Q/E 已由 JS 输入层生成等效鼠标量（yaw_bind_speed/M_YAW 像素/秒，与鼠标同通道，
        // 双端消费同源输入 → 角度天然一致），物理不再内部旋转
        if self.noclip {
            noclip_step(&mut self.player, dt, &self.params);
        } else {
            // 传送检测（权威才检测；predict 禁用；surfing 滑行不触发；
            // gate_ticks 参数已无效——check 内不使用，仅保留签名兼容）
            if let Some(dest) = self.teleport.check(
                &self.player.origin,
                self.player.contact_ticks,
                self.params.teleport_gate_ticks,
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
                self.teleport.reset_cooldown();
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
            player_tick(&mut self.world, &mut self.player, &self.params, dt);
        }
    }

    /// 轻量预测步：走一次 `player_tick`（**一次调用 = 一个子步**），但不经 `step_core`——
    /// 即不检测传送、不判死亡、不处理 `reset` 键；noclip 下直接返回现状。
    ///
    /// 需要多个子步就调用多次（`apps/game/scripts/phys-smoke.mjs` 的 `predict` 即连调两次）；
    /// 本方法内部不再细分 `dt`。返回新构造的状态对象。
    ///
    /// 当前无生产调用方：只有 `apps/game/scripts/phys-smoke.mjs` 与 `phys-dual-pipe.mjs` 在用。
    pub fn predict(
        &mut self,
        dt: f64,
        keys_mask: u32,
        dx: f64,
        dy: f64,
    ) -> Result<JsValue, JsValue> {
        if !self.ready || self.noclip {
            return Ok(self.state_js());
        }
        apply_input(&mut self.player, keys_mask);
        self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
        self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
        self.player.pitch = self
            .player
            .pitch
            .max(-player::PITCH_CLAMP)
            .min(player::PITCH_CLAMP);
        player_tick(&mut self.world, &mut self.player, &self.params, dt);
        Ok(self.state_js())
    }

    /// 把玩家放回初始出生点 `spawn`，并复位传送冷却。
    /// 具体复位哪些状态（速度/着地/蹲伏等）由 `Player::respawn` 决定，本方法不加额外判断。
    pub fn respawn(&mut self) {
        self.player.respawn(&self.spawn);
        self.teleport.reset_cooldown();
    }

    /// 立即传送到指定坐标，`yaw` 单位为度。
    ///
    /// 经 `apply_teleport`：清零速度、`on_ground` 置 false、同步 `prev_origin`、
    /// 复位传送冷却。**不做落地探测**——落点是否悬空由调用方负责。
    pub fn teleport_to(&mut self, x: f64, y: f64, z: f64, yaw: f64) {
        self.apply_teleport(&[x, y, z], yaw);
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
    /// 传送路径与 `teleport_to` 相同（都走 `apply_teleport`）。
    pub fn teleport_to_spawn(&mut self, idx: usize) {
        if let Some(sp) = self.spawn_points.get(idx) {
            self.apply_teleport(&[sp[0], sp[1], sp[2]], sp[3]);
        }
    }

    /// 用 9 个标量覆盖玩家的位置 / 朝向 / 速度 / 着地，并把 `prev_origin` 同步到新位置。
    ///
    /// 用途是"把权威状态写回某实例、再从该点继续推进"（重锚）。只改这 9 项：
    /// 不改蹲伏态、不改计时器、不改传送冷却、不产生事件。
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
    /// `correctFromAuthority` / `calibrateVelocity`，
    /// 与 `src/ts-shared/decoupled/decoupled-loop.ts` 的 `alignTickPhys`。
    pub fn set_velocity(&mut self, vx: f64, vy: f64, vz: f64) {
        self.player.velocity = [vx, vy, vz];
    }

    /// 只覆盖 yaw / pitch（度）：位置、速度、着地均不动。
    ///
    /// **当前无调用方**：`apps/**` 与 `src/**` 内都没有 `set_yaw_pitch` 调用点，
    /// 只在 `apps/debug/src/wasm.d.ts` 的 `PhysWorld.set_yaw_pitch` 有一行类型声明。是否保留在导出契约内需 owner 决定。
    pub fn set_yaw_pitch(&mut self, yaw: f64, pitch: f64) {
        self.player.yaw = yaw;
        self.player.pitch = pitch;
    }

    /// 设置死亡 Y 阈值（HU）：`origin.y` 低于该值即在下一个非 noclip 步被判掉落死亡。
    /// 权威侧在 world 重建后会重放最近一次设定值（`src/ts-shared/auth/worker-dispatch.ts` 的 `set_death_y` 重放）。
    pub fn set_death_y(&mut self, y: f64) {
        self.death_y = y;
    }

    /// 按 JSON patch 覆盖物理参数：**只处理出现过的键**，未出现的键保持原值。
    ///
    /// 可接受的键（与下方 `Patch` 结构逐字对应，共 17 个）：`gravity` / `accelerate` /
    /// `friction` / `stop_speed` / `jump_height` / `air_accelerate` / `run_speed` /
    /// `walk_speed` / `crouch_speed` / `autobhop` / `bhop_speed_clamp` / `sensitivity` /
    /// `yaw_bind_speed` / `noclip_speed` / `teleport_gate_ticks` / `push_out` /
    /// `push_out_only_when_solid`。
    ///
    /// 三项碰撞箱尺寸不在这里，走 `set_hull`。
    /// `teleport_gate_ticks` 会被写进 `params`，但 `src/phys/teleport.rs` 的
    /// `TeleportManager::check` 形参是 `_gate_ticks` 且函数体从不读它——**该键当前不改变任何行为**。
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
            teleport_gate_ticks: Option<u32>,
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
        if let Some(v) = p.teleport_gate_ticks {
            self.params.teleport_gate_ticks = v;
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
    /// **不含时间戳**——帧时间由调用方自行记录；也不含蹲伏/滑行等扩展位（那些只在
    /// `state_out` 的 8-19 槽里）。每次调用都新建对象，热路径请改用 `tick_into`。
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
    /// （`apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.consumePhysEvents`）
    /// 与 `src/ts-shared/auth/tick-authority.ts` 的 `publishMeta`。
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

impl PhysWorld {
    /// 把 `player` 的当前值写成一个**新建**的 JS 对象，是 `tick` / `predict` / `state`
    /// 三个导出方法的共同出口。字段集固定 11 项（含调试用的 `contactTicks`），见 `state`
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

    /// 传送的唯一写入口：落点、清零速度、离地、朝向、同步 `prev_origin`，并复位传送冷却。
    /// `teleport_to` / `teleport_to_spawn` / 步内触发传送三条路径都汇聚到这里，
    /// 以保证"传送后字段集"始终一致。
    fn apply_teleport(&mut self, origin: &[f64; 3], yaw: f64) {
        self.player.origin = *origin;
        self.player.velocity = [0.0, 0.0, 0.0];
        self.player.on_ground = false;
        self.player.yaw = yaw;
        self.player.prev_origin = *origin;
        self.teleport.reset_cooldown();
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
        vertices: Vec<[f64; 3]>,
        indices: Vec<[u32; 3]>,
        min: [f64; 3],
        max: [f64; 3],
    }
    let data: Vec<WasmTriMesh> =
        serde_json::from_str(json).map_err(|e| to_js_err(e, "tri JSON 解析"))?;
    Ok(data
        .into_iter()
        .map(|m| TriMesh {
            name: m.name,
            vertices: m.vertices,
            indices: m.indices,
            min: m.min,
            max: m.max,
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

/// 写 `state_out` 的 8-21 槽（槽位含义见 `PhysWorld::state_out` 字段文档）。
/// 槽 0-7 不在这里写 —— `tick_into` 自己直写那 8 个槽。
/// 只读 `player`、不推进物理、不改任何状态。
fn fill_state_out(p: &Player, o: &mut [f64; 22]) {
    o[8] = if p.ducked { 1.0 } else { 0.0 };
    o[9] = p.duck_frac;
    o[10] = p.ground_ticks_since_landing as f64;
    o[11] = p.contact_ticks as f64;
    o[12] = if p.surfing { 1.0 } else { 0.0 };
    o[13] = p.blocked_ticks as f64;
    o[14] = p.on_ladder.map(|i| i as f64).unwrap_or(-1.0);
    o[15] = p.fall_velocity;
    o[16] = p.landing_velocity[0];
    o[17] = p.landing_velocity[1];
    o[18] = p.landing_velocity[2];
    o[19] = if p.has_jumped_before { 1.0 } else { 0.0 };
    o[20] = p.eye_height();
    o[21] = if p.on_ground { 1.0 } else { 0.0 };
}
