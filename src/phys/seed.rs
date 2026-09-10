//! 种子面 v2 — F4-C scratch 单向写入（t3；t6 §11.1 全量字段表 + t1 事实表修正）。
//!
//! 纪律（任务契约 + captain 背书范围校正：生效范围 = 仓库根 `src/phys/**` +
//! `game/crates` 构建胶水 + web wasm 产物三件套）：
//! - **Rust 只增不改**：本模块全部为新增代码；step_core / player_tick / teleport
//!   检查链 / set_state(9 参) 等既有物理语义逐行不动。
//! - **单向写入**：`apply_seed` 只写 self（scratch 实例），从不读自身状态做决策、
//!   从不写权威实例；`extract_seed` 只读（`&self`）。
//! - **t1 事实表收编**（plan/field-fidelity.md，22 相位 / rig 自检 22/22）：
//!   · MUST 增补（行为级活性缺口，实证量化）：`ground_normal`(3×f64，nopre 钳制
//!     唯一消费点 player.rs:907) / `contact_ticks`(u32，teleport B 路径 grounded 门) /
//!     `ducked`(bool)+`duck_frac`(f64，半蹲态不可播种缺口)；
//!   · 9 基础字段不动（平地/60°坡/跳跃/空中/预传送全域 EXACT 实证）；
//!   · schema 覆盖 §11.1 全量表（惰性位照入：1 槽成本换未来语义保护，逐字段注记）；
//!   · `teleport.cooldown` = 自 erase 死位（t1 §4：check 置 0.5 → 同 step 内
//!     apply_teleport reset + fire 后 reset 归零，armed 态不跨 tick 存活）；
//!     `teleport_gate_ticks` 不存在（check 形参 `_gate_ticks` 未接线）——勿找；
//!   · **event 槽默认不入种子**（t1 §5 设计级裁定：F4-C scratch 自排空、authority
//!     pending 事件走权威通道）；保留可选 event 键（F4-R / bench 审计能力）。
//! - **位级保真**：f64 经 serde_json 往返精确——**依赖 `float_roundtrip` feature**
//!   （t3 实测前提修复：serde_json 默认 fast parser 对部分 f64 有 1-ULP 往返偏差，
//!   复现值 origin[2]=10.478655362066775 播种后变 …776；启用 feature 后 parse↔print
//!   位级往返保证，见 src/Cargo.toml）。非有限值（NaN/Inf）在反序列化侧 FAIL LOUD
//!   （`null`→f64 失败）——种子面拒绝非有限态，绝不静默损坏。
//!
//! schema 版本 v=2；字段名与 Rust 命名一致（snake_case），与 t1 事实表口径对齐。
//! 消费形态（t4 worker 集成）：`scratch.set_state_ex(authority.state_full_json(false))`
//! 直通字符串，或零序列化 `scratch.seed_from(&authority)`。

use super::{PhysEvent, PhysWorld};
use serde::{Deserialize, Serialize};

/// 种子 schema 版本（set_state_ex 校验，防版本漂移静默错种）。
pub(crate) const SEED_SCHEMA_VERSION: u32 = 2;

/// §11.1 全量字段 + t1 修正的种子 schema（与 `state_full_json` 导出对称）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct SeedState {
    /// schema 版本；`v != 2` → Err（版本纪律）。
    v: u32,

    // ---- 运动主态（9 基础字段域；t1 全域 EXACT）----
    origin: [f64; 3],
    velocity: [f64; 3],
    yaw: f64,
    pitch: f64,
    on_ground: bool,
    /// **MUST（t1 §3.1 物理承重）**：坡面着地带速态播种；fresh 默认 [0,1,0] 会
    /// 误触发 nopre 钳制（player.rs:907）→ 单 tick 掉沿坡速 19-21% 持续发散。
    ground_normal: [f64; 3],

    // ---- 蹲伏（**MUST**，t1 §3.3）----
    /// 半蹲态不可播种缺口：fresh 恒从站立起步，持蹲键 ~6.4 tick 才追平；
    /// 窗口内 hull 语义分歧（蹲箱 36 vs 站箱 72），顶低天花板有卡体风险。
    ducked: bool,
    duck_frac: f64,

    // ---- 其余 §11.1 全量字段（惰性位照入，逐字段注记 t1 证据）----
    /// 梯子索引（check_ladder 每 tick 重推导 :1024；播种为完整性；须与本实例
    /// ladders 数量一致，错索引由后续 tick 路径消费——种子契约=同图构建）。
    on_ladder: Option<usize>,
    /// 每 tick :392 入口重置 + :455 几何重推导 = 派生态；跨 tick 仅 teleport 门
    /// （mod.rs:246）读前值——触发器邻近 surf 态为与 s4b 同构风险，播种保真。
    surfing: bool,
    /// 仅写无读（t1 §4）。
    surfed_since_grounded: bool,
    /// Rust 内仅 :1043 指数衰减（t1 §4 无行为效应）。
    land_punch: f64,
    /// 跳沿缓存（条件性活位：默认 autobhop=true 短路 :544；=false 时恢复活性，
    /// t1 §4 / s3 jump-edge EXACT）。
    old_jump: bool,
    ladder_cooldown: f64,
    /// 仅写（:631/:827/:1034，t1 §4）。
    fall_velocity: f64,
    /// 读点 :909/:1051 在；t1 实测域内「两侧自 tick1 起 >0 → 分支同向」无行为
    /// 分歧（t1 §4）——条件性活位，播种保真。
    ground_ticks_since_landing: u32,
    /// **MUST（t1 §3.2）**：teleport B 路径 grounded 门（mod.rs:241 传参；
    /// fresh=0 时首 tick check 在自增前 → B 路径恰晚 1 tick）。
    contact_ticks: u32,
    /// 全仓无 read（t1 §4）。
    has_jumped_before: bool,
    /// 落地快照，:824 注释明示不消费（t1 §4）。
    landing_velocity: [f64; 3],
    /// 卡体中态灰区（t1 未探测）：blocked ≥6 清零判定 :885-888（静态读点在，
    /// 预测活性）；schema 当日即含，bench 可后补卡体类回归。
    blocked_ticks: u32,
    /// check_stuck :848-872 全为写（t1 §4 / 未探测）。
    stuck_ticks: u32,

    /// InputState 十字段（player.rs:116-128）：tick 边界播种后即被 apply_input
    /// 掩码重推导（t1 全域 EXACT 隐证）；入 schema 为全量表完整性。
    input: SeedInput,

    // ---- 碰撞箱（apply_hull 派生；同参构建恒等；播种为全量表完整性）----
    stand_mins: [f64; 3],
    stand_maxs: [f64; 3],
    duck_mins: [f64; 3],
    duck_maxs: [f64; 3],

    // ---- 诊断位（player_tick :1010-1011 每 tick 起点重赋 → 永不跨边界消费）----
    prev_origin: [f64; 3],
    prev_speed: f64,

    // ---- PhysWorld 隐藏面（t6 §11.1 + t1 修正）----
    /// teleport.cooldown（私有字段；t1 §4 自 erase 死位，播种为完整性）。
    teleport_cooldown: f64,
    /// triggers[].inside 逐位（t1 §4 仅复位写、全文件无读取点；播种为完整性；
    /// 长度必须与本实例 triggers 一致，否则 Err）。
    triggers_inside: Vec<bool>,
    /// 可选 event 槽（**F4-C 默认不传**，t1 §5；导出面 include_event=true 才输出）。
    event: Option<SeedEvent>,
}

impl Default for SeedState {
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

/// InputState 十字段镜像（player.rs:116-128）。
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

/// 可选事件槽（F4-R / bench 审计用；F4-C 种子链默认 None，t1 §5）。
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
    /// 只读抽取：本实例 → 种子 schema（不改任何状态；event 按 include_event 决定）。
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

    /// 单向写入：seed schema → 本实例（scratch）。只写 self；校验前置（Err 时
    /// 实例零改动）。event 键缺省 = None（F4-C 语义，t1 §5）。
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
        // PhysWorld 隐藏面（teleport.rs 种子通道，additive）
        self.teleport.seed_cooldown(s.teleport_cooldown);
        self.teleport.seed_trigger_inside(&s.triggers_inside)?;
        // 可选 event 槽（F4-C 种子链不传 → None；t1 §5：事件不可播种的默认语义）
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
        // state_out 预填：种子时刻输出缓冲即刻与状态一致（tick_into 每 tick 全量覆写）。
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
