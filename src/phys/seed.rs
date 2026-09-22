//! 种子面 v2：`PhysWorld` 整实例状态的可序列化投影（`SEED_SCHEMA_VERSION = 2`）。
//!
//! 位置：本模块是 `mod.rs` 三个导出方法的实现体 —— `set_state_ex` 走 JSON 写、
//! `state_full_json` 走 JSON 读、`seed_from` 走进程内的逐字段直拷（不经 JSON 文本）。
//! 本文件的 `extract_seed` / `apply_seed` 都是 `pub(crate)`，不进 wasm 导出面。
//!
//! 一对互逆方法的契约：
//! - `extract_seed(&self, include_event)` 只读：新建一份 `SeedState`，逐字段取
//!   `self.player` 的同名字段，另加 `self.teleport` 的两个私有值
//!   （`cooldown_value()` / `trigger_inside_vec()`）；`event` 只在 `include_event` 为真时带上。
//! - `apply_seed(&mut self, s)` 只写 `self`：先三项校验（`v` / `triggers_inside` 长度 /
//!   `on_ladder` 上界），再逐字段写 `Player`，再写 `teleport` 的两个隐藏值与事件槽，
//!   最后把 `state_out` 预填成与状态一致（0-7 槽直写，8-21 槽交 `super::fill_state_out`）。
//!   三项校验全部排在第一次赋值之前 —— 任一 `Err` 返回时本实例零改动。
//!
//! 覆盖面：`SeedState` 共 32 字段 = `Player` 的 28 个字段逐项镜像 + `v`
//! + `teleport_cooldown` + `triggers_inside` + `event`。抽取与写回都是**逐字段枚举**，
//! 没有自动映射：`Player` 新增字段不会自动进入种子面，必须在本文件补一行。
//!
//! **不在种子面**的 `PhysWorld` 字段（构建期或宿主配置）：`world` / `params` /
//! `spawn` / `spawn_points` / `death_y` / `noclip` / `ready`。
//! 其中 `world` 不可播种决定了播种前提：`triggers_inside` 的长度必须等于本实例
//! `teleport.triggers` 的数量，`on_ladder` 必须落在本实例 `world.ladders` 下标范围内；
//! 两条都是硬校验，超界返回 `Err` 而不夹取。`on_ladder` 只校验上界 —— 它指向本实例的
//! 第几把梯子，由两实例的地图决定，故种子只在同图构建的实例之间有意义。
//! `params` 侧的 `teleport_gate_ticks` 同样没有镜像字段：该键在 `TeleportManager::check`
//! 内不被读取（形参名为 `_gate_ticks`），与 `mod.rs` 的 `set_params` 文档同一口径。
//!
//! 版本纪律：`apply_seed` 要求 `v == SEED_SCHEMA_VERSION`，不等即 `Err`。
//! 容器级 `#[serde(default)]` 让缺省字段回退到 `Default for SeedState`，而该 `Default`
//! 把 `v` 置成 `SEED_SCHEMA_VERSION` —— 故**缺 `v` 键的 JSON 按 v2 接受**，
//! 只有显式写出 `v != 2` 才被拒。
//!
//! 数值保真：f64 全部走 serde_json 往返，`src/Cargo.toml` 给 serde_json 开了
//! `float_roundtrip` feature（parse↔print 位级精确）。非有限值在导出侧被写成 `null`，
//! 写回侧 `null → f64` 反序列化失败即报错，不做静默夹取。
//!
//! 字段在下一步的落点（逐条按源码核过，明细见各字段注）：
//! 运动主态与蹲伏态是下一步的输入；`ground_normal` 在模拟内无读取点（摘取它的只有 `extract_seed`）；
//! `input` 的 10 个布尔在 `tick` / `tick_into` / `predict` 入口被 `apply_input` 按键位掩码
//! 整组覆写，故播种值不影响这三个入口的下一步；`prev_origin` / `prev_speed` 在 `player_tick`
//! 开头被就地重赋，故播种值不跨 tick 存活；`contact_ticks` 与 `surfing` 的跨 tick 读取点都在
//! 传送门（`TeleportManager::check` 的 grounded 判据与滑行早退）；`teleport_cooldown` 被同一个
//! `check` 的冷却早退分支读取；`triggers_inside` 只经 `trigger_inside_vec()` 读出。
//!
//! 消费形态：`set_state_ex`（JSON 文本）或 `seed_from`（零序列化直拷）。
//! 方向恒为 `src` → `self`：`extract_seed` 借 `&self`，`apply_seed` 只改 `self`。

use super::{PhysEvent, PhysWorld};
use serde::{Deserialize, Serialize};

/// 种子 schema 版本（`apply_seed` 校验；不等即 `Err`）。
pub(crate) const SEED_SCHEMA_VERSION: u32 = 2;

/// 整实例状态的镜像（与 `state_full_json` 导出、`set_state_ex` 写回同一 schema）。
/// 字段顺序与 `Player` 的声明顺序一致，仅 `blocked_ticks` / `stuck_ticks` 次序互换。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct SeedState {
    /// schema 版本；`v != SEED_SCHEMA_VERSION` → `Err`。缺键时由 `Default` 补成当前版本。
    v: u32,

    // ---- 运动主态 ----
    origin: [f64; 3],
    velocity: [f64; 3],
    yaw: f64,
    pitch: f64,
    on_ground: bool,
    /// 着地面法线。写点只有 `categorize_position`（不可站面时该字段保持旧值），
    /// 而模拟内没有读取点 —— `create_player` 只给初值 `[0, 1, 0]`，摘取它的只有
    /// 本文件的 `extract_seed`。播种本字段不改动任何行为，属字段镜像完整性。
    ground_normal: [f64; 3],

    // ---- 蹲伏 ----
    /// 蹲姿开关。`mins()` / `maxs()` 按它二选一，这决定了后续碰撞箱；地面动量上限也看它。
    /// `update_duck` 每个 tick 依据蹲键与站立箱可用性改写本字段。
    ducked: bool,
    /// 蹲伏视角插值系数（0 站立 / 1 蹲下）。唯一读取点是 `eye_height()`：
    /// 地面按 `DUCK_LERP_TIME`（0.2s）线性趋近，空中与落地 tick 直接置位。
    /// 碰撞箱不看它 —— 箱体随 `ducked` 瞬时切换。
    duck_frac: f64,

    // ---- 梯子 / surf ----
    /// 当前梯子（`world.ladders` 下标；None = 不在梯上）。
    /// `check_ladder` 每 tick 重推导，并读旧值判断"已在梯上则保持"；
    /// `ladder_move` 写 Some，跳离梯面时写回 None。播种时只校验上界。
    on_ladder: Option<usize>,
    /// surf 滑行标志。`try_player_move` 在每次调用起点清零，撞到法线 y ∈ (0.05, 0.7) 的面时置位；
    /// 本实例内不读它做分支，跨 tick 的读取点是传送门（滑行不触发传送）。
    surfing: bool,
    /// 本次离地以来是否滑行过。写点：`air_move` 在 `surfing` 时置位，起跳与 `respawn` 清零。
    /// 模拟内没有读取点，摘取它的只有 `extract_seed`。
    surfed_since_grounded: bool,
    /// 落地冲击量。`player_tick` 末尾按 `(1 - 10·dt).max(0)` 指数衰减，没有分支读它；
    /// 导出侧不进 `state_out`，只进种子面。
    land_punch: f64,
    /// 上一 tick 的跳跃键（`player_tick` 末尾由 `input.jump` 重赋）。
    /// 两个读点：地面起跳的边沿判定（该读点只在 `params.autobhop == false` 时改变分支结果）
    /// 与梯上跳离的边沿判定（不看 `autobhop`）。
    old_jump: bool,
    /// 离梯冷却（秒）。大于 0 时 `check_ladder` 直接返回 None；每个 tick 递减 `dt`，
    /// 梯上跳离时置 0.25。
    ladder_cooldown: f64,
    /// 下落速度（离地分支写入 `-velocity[1]`，上梯与着地时清零）。
    /// crate 内没有分支读它；`fill_state_out` 把它写进 `state_out` 第 15 槽。
    fall_velocity: f64,
    /// 落地后经过的 tick 数。写点：落地瞬间清零、地面 tick 自增、`respawn` 清零。
    /// 读点：`duck_frac` 的"落地 tick 即时置位"判据与 `state_out` 第 10 槽。
    ground_ticks_since_landing: u32,
    /// 接触帧计数。只在 `categorize_position` 判定为可站面（法线 y ≥ `STANDABLE_NORMAL`
    /// 的实心命中）时自增，上升（`velocity[1] > NON_JUMP_VELOCITY`）与离地时清零。
    /// 跨 tick 读取点是传送门：`check` 以 `ground_ticks > 0` 判 grounded，
    /// A 路径的斜面 gap 与 B 路径的脚底下探都依赖它；`step_core` 传入的正是本字段，
    /// 另外 `state_js` 的 `contactTicks` 与 `state_out` 第 11 槽也各导出一次。
    contact_ticks: u32,
    /// 是否起跳过。起跳置位、`respawn` 清零；crate 内没有分支读它，
    /// 导出侧只进 `state_out` 第 19 槽。
    has_jumped_before: bool,
    /// 落地瞬间的速度快照。crate 内没有分支读它；导出侧进 `state_out` 第 16-18 槽。
    landing_velocity: [f64; 3],
    /// 冻结计数。`detect_blocked_move` 在"离地 + 速度 > 150 + 位移 < 0.05"时自增，
    /// 累到 6 即清零速度并复位，任一条件不满足也清零。
    /// 读点：该 `>= 6` 判据与 `state_out` 第 13 槽。
    blocked_ticks: u32,
    /// 卡死计数。`check_stuck` 三处写：位置本就空闲清零、挤出成功清零、彻底卡死自增。
    /// 除上述自增与 `extract_seed` 外没有读取点，也不进 `state_out`。
    stuck_ticks: u32,

    /// `InputState` 的 10 个布尔镜像（与 `player.rs` 的 `InputState` 同名同序）。
    /// **时效**：`tick` / `tick_into` / `predict` 都在步进前用 `apply_input` 按键位掩码
    /// 整组覆写这 10 个值，故播种值不影响这三个入口的下一步；
    /// 其中 `reset` 位在 `step_core` 内被消费为重生命令，`yaw_left` / `yaw_right`
    /// 只被 `noclip_step` 读取。
    input: SeedInput,

    // ---- 碰撞箱（`apply_hull` 由 `params.hull_*` 派生）----
    /// 四组 mins/maxs。`mins()` / `maxs()` 按 `ducked` 二选一，故播种值直接决定后续碰撞判定
    /// 与 `eye_height()` 的基准（眼高按 `stand_maxs[1]` / `duck_maxs[1]` 与默认箱高的比值缩放）。
    stand_mins: [f64; 3],
    stand_maxs: [f64; 3],
    duck_mins: [f64; 3],
    duck_maxs: [f64; 3],

    // ---- 诊断位（`player_tick` 开头就地重赋，播种值不跨 tick 存活）----
    /// 本 tick 起点位置。`player_tick` 开头重赋后在 `detect_blocked_move` 里与当前位置比较；
    /// `mod.rs` 的 `apply_teleport` / `set_state` 也会把它同步到新位置。
    prev_origin: [f64; 3],
    /// 本 tick 起点 3D 速度。`player_tick` 开头重赋；模拟内无读取点（`extract_seed` 会摘取它），
    /// 导出侧也不进 `state_out`。
    prev_speed: f64,

    // ---- `PhysWorld` 隐藏面（不属于 `Player`）----
    /// `TeleportManager::cooldown`（私有字段，只能经 `cooldown_value()` / `seed_cooldown()` 进出）。
    /// `check` 在它大于 0 时先扣一个 `dt` 再返回 None；触发时置 `TRIGGER_COOLDOWN`（0.5）。
    /// `step_core` 的触发分支在同一 step 内就调 `reset_cooldown` 归零，因此产生过触发的实例
    /// 导出值恒为 0.0；播种一个正值会让后续 tick 继续走冷却早退分支。
    teleport_cooldown: f64,
    /// 每个 trigger 的 `inside` 位，顺序与 `teleport.triggers` 一致。
    /// `teleport.rs` 内对 `inside` 只有写（构造置 false、`on_teleported()` 复位、
    /// `seed_trigger_inside()` 写入），读出点只有 `trigger_inside_vec()`，调用者是本模块。
    /// 长度必须等于本实例触发器数量，否则 `Err`。
    triggers_inside: Vec<bool>,
    /// 可选事件槽。缺省 / `null` → 写回时把本实例事件槽清空；显式给出 → 装入该事件。
    /// 常规种子链（`state_full_json(false)` 与 `seed_from`）取 `extract_seed(false)`，
    /// `event` 恒为 None，故链上不携带事件、且写入端会清空目标实例的事件槽；
    /// `include_event = true` 才导出当前待取事件。
    event: Option<SeedEvent>,
}

impl Default for SeedState {
    /// 全字段取零值 / 空值；两处例外：`v` 取 `SEED_SCHEMA_VERSION`，
    /// `ground_normal` 取 `[0.0, 1.0, 0.0]`（与 `create_player` 的初值一致）。
    fn default() -> Self {
        SeedState {
            v: SEED_SCHEMA_VERSION,
            origin: [0.0; 3],
            velocity: [0.0; 3],
            yaw: 0.0,
            pitch: 0.0,
            on_ground: false,
            ground_normal: [0.0, 1.0, 0.0],
            ducked: false,
            duck_frac: 0.0,
            on_ladder: None,
            surfing: false,
            surfed_since_grounded: false,
            land_punch: 0.0,
            old_jump: false,
            ladder_cooldown: 0.0,
            fall_velocity: 0.0,
            ground_ticks_since_landing: 0,
            contact_ticks: 0,
            has_jumped_before: false,
            landing_velocity: [0.0; 3],
            blocked_ticks: 0,
            stuck_ticks: 0,
            input: SeedInput::default(),
            stand_mins: [0.0; 3],
            stand_maxs: [0.0; 3],
            duck_mins: [0.0; 3],
            duck_maxs: [0.0; 3],
            prev_origin: [0.0; 3],
            prev_speed: 0.0,
            teleport_cooldown: 0.0,
            triggers_inside: Vec::new(),
            event: None,
        }
    }
}

/// `InputState` 的 10 个布尔镜像（与 `player.rs` 的 `InputState` 同名同序）。
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct SeedInput {
    forward: bool,
    back: bool,
    left: bool,
    right: bool,
    jump: bool,
    duck: bool,
    walk: bool,
    reset: bool,
    yaw_left: bool,
    yaw_right: bool,
}

/// 事件槽的可序列化形态，与 `PhysEvent` 的两个变体一一对应。
/// 只在 `extract_seed(true)` 时导出；写回时由 `apply_seed` 还原成 `PhysEvent`。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) enum SeedEvent {
    Teleport {
        targetname: String,
        origin: [f64; 3],
        yaw: f64,
    },
    Death,
}

impl PhysWorld {
    /// 只读抽取：本实例 → 种子。不改任何状态。
    /// `v` 恒为 `SEED_SCHEMA_VERSION`；`event` 按 `include_event` 决定是否带上。
    /// `Player` 的 28 个字段逐一镜像，`teleport` 的两个私有值经
    /// `cooldown_value()` / `trigger_inside_vec()` 取出。
    pub(crate) fn extract_seed(&self, include_event: bool) -> SeedState {
        let p = &self.player;
        SeedState {
            v: SEED_SCHEMA_VERSION,
            origin: p.origin,
            velocity: p.velocity,
            yaw: p.yaw,
            pitch: p.pitch,
            on_ground: p.on_ground,
            ground_normal: p.ground_normal,
            ducked: p.ducked,
            duck_frac: p.duck_frac,
            on_ladder: p.on_ladder,
            surfing: p.surfing,
            surfed_since_grounded: p.surfed_since_grounded,
            land_punch: p.land_punch,
            old_jump: p.old_jump,
            ladder_cooldown: p.ladder_cooldown,
            fall_velocity: p.fall_velocity,
            ground_ticks_since_landing: p.ground_ticks_since_landing,
            contact_ticks: p.contact_ticks,
            has_jumped_before: p.has_jumped_before,
            landing_velocity: p.landing_velocity,
            blocked_ticks: p.blocked_ticks,
            stuck_ticks: p.stuck_ticks,
            input: SeedInput {
                forward: p.input.forward,
                back: p.input.back,
                left: p.input.left,
                right: p.input.right,
                jump: p.input.jump,
                duck: p.input.duck,
                walk: p.input.walk,
                reset: p.input.reset,
                yaw_left: p.input.yaw_left,
                yaw_right: p.input.yaw_right,
            },
            stand_mins: p.stand_mins,
            stand_maxs: p.stand_maxs,
            duck_mins: p.duck_mins,
            duck_maxs: p.duck_maxs,
            prev_origin: p.prev_origin,
            prev_speed: p.prev_speed,
            teleport_cooldown: self.teleport.cooldown_value(),
            triggers_inside: self.teleport.trigger_inside_vec(),
            event: if include_event {
                self.event.as_ref().map(|e| match e {
                    PhysEvent::Teleport {
                        targetname,
                        origin,
                        yaw,
                    } => SeedEvent::Teleport {
                        targetname: targetname.clone(),
                        origin: *origin,
                        yaw: *yaw,
                    },
                    PhysEvent::Death => SeedEvent::Death,
                })
            } else {
                None
            },
        }
    }

    /// 单向写入：种子 → 本实例（只写 `self`，不读自身其余状态做决策）。
    /// 顺序：① `v` 校验 → ② `triggers_inside` 长度校验 → ③ `on_ladder` 上界校验 →
    /// ④ 逐字段写 `Player` → ⑤ 写 `teleport` 的 cooldown 与 inside 位 →
    /// ⑥ 事件槽（缺省即清空）→ ⑦ 预填 `state_out`。
    /// ①②③ 都在第一次赋值之前，故任一 `Err` 返回时本实例零改动。
    pub(crate) fn apply_seed(&mut self, s: &SeedState) -> Result<(), String> {
        if s.v != SEED_SCHEMA_VERSION {
            return Err(format!(
                "set_state_ex: schema v={} 不受支持（期望 v={})",
                s.v, SEED_SCHEMA_VERSION
            ));
        }
        if s.triggers_inside.len() != self.teleport.triggers.len() {
            return Err(format!(
                "set_state_ex: triggers_inside 长度 {} != 本实例 triggers {}",
                s.triggers_inside.len(),
                self.teleport.triggers.len()
            ));
        }
        if let Some(idx) = s.on_ladder {
            if idx >= self.world.ladders.len() {
                return Err(format!(
                    "set_state_ex: on_ladder 索引 {} 越界（ladders={})",
                    idx,
                    self.world.ladders.len()
                ));
            }
        }
        let p = &mut self.player;
        p.origin = s.origin;
        p.velocity = s.velocity;
        p.yaw = s.yaw;
        p.pitch = s.pitch;
        p.on_ground = s.on_ground;
        p.ground_normal = s.ground_normal;
        p.ducked = s.ducked;
        p.duck_frac = s.duck_frac;
        p.on_ladder = s.on_ladder;
        p.surfing = s.surfing;
        p.surfed_since_grounded = s.surfed_since_grounded;
        p.land_punch = s.land_punch;
        p.old_jump = s.old_jump;
        p.ladder_cooldown = s.ladder_cooldown;
        p.fall_velocity = s.fall_velocity;
        p.ground_ticks_since_landing = s.ground_ticks_since_landing;
        p.contact_ticks = s.contact_ticks;
        p.has_jumped_before = s.has_jumped_before;
        p.landing_velocity = s.landing_velocity;
        p.blocked_ticks = s.blocked_ticks;
        p.stuck_ticks = s.stuck_ticks;
        p.input.forward = s.input.forward;
        p.input.back = s.input.back;
        p.input.left = s.input.left;
        p.input.right = s.input.right;
        p.input.jump = s.input.jump;
        p.input.duck = s.input.duck;
        p.input.walk = s.input.walk;
        p.input.reset = s.input.reset;
        p.input.yaw_left = s.input.yaw_left;
        p.input.yaw_right = s.input.yaw_right;
        p.stand_mins = s.stand_mins;
        p.stand_maxs = s.stand_maxs;
        p.duck_mins = s.duck_mins;
        p.duck_maxs = s.duck_maxs;
        p.prev_origin = s.prev_origin;
        p.prev_speed = s.prev_speed;
        // PhysWorld 隐藏面：teleport 的 cooldown 与逐 trigger 的 inside 位（长度已在上方校验）
        self.teleport.seed_cooldown(s.teleport_cooldown);
        self.teleport.seed_trigger_inside(&s.triggers_inside)?;
        // 事件槽：Some → 装入该事件，None → 清空（本模块的种子链恒为后者）
        self.event = s.event.as_ref().map(|e| match e {
            SeedEvent::Teleport {
                targetname,
                origin,
                yaw,
            } => PhysEvent::Teleport {
                targetname: targetname.clone(),
                origin: *origin,
                yaw: *yaw,
            },
            SeedEvent::Death => PhysEvent::Death,
        });
        // 预填 state_out：写入完成即让输出缓冲与状态一致（0-7 槽直写，8-21 槽交 fill_state_out）。
        // tick_into 每 tick 全量覆写这 22 个槽。
        let o = &mut self.state_out;
        o[0] = p.origin[0];
        o[1] = p.origin[1];
        o[2] = p.origin[2];
        o[3] = p.velocity[0];
        o[4] = p.velocity[1];
        o[5] = p.velocity[2];
        o[6] = p.yaw;
        o[7] = p.pitch;
        super::fill_state_out(p, o);
        Ok(())
    }
}
