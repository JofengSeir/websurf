//! 玩家移动语义：`Player` 的运动状态机 + 全套 CS 风格步进
//! （地面/空中移动、扫掠碰撞与平面剪裁、台阶、蹲伏、梯子、卡死挤出）。
//!
//! 上下游位置：
//! - 上游（驱动）：`src/phys/mod.rs` 的 `PhysWorld::step_core` 每步调一次 `player_tick`；
//!   轻量预测路径 `PhysWorld::predict` 直调同一函数。`player::create_player`（`PhysWorld::new`
//!   与 `PhysWorld::build_world` 两处调用）建玩家、`player::apply_hull`（`PhysWorld::set_hull`
//!   调用）改碰撞箱，是本模块仅有的构造与改箱入口。
//! - 下游（几何查询）：所有碰撞问题都交给 `world::World` —— 扫掠追踪 `World::trace`、
//!   位置空闲判定 `World::is_position_free`、梯子相交 `World::ladder_at` 与 `World::ladders`
//!   索引。前两者的签名带 `&mut self`（内部走网格查询），所以本文件的移动函数一律收
//!   `&mut World`，但本模块**从不改动 `World` 的内容**：不 push 几何、不调 `build_index`。
//! - 单位：HU（距离）/ HU/s（速度）/ 度（yaw、pitch）/ 秒（dt）。坐标系 Y-up。
//!
//! 职责（按 `player_tick` 的推进顺序）：① `update_duck` 姿态；② `check_stuck` 卡死挤出；
//! ③ 梯子 `check_ladder` / `ladder_move`；④ 起跳 `check_jump`；
//! ⑤ 移动 `walk_move`（内含 `step_move` / `stay_on_ground`）或 `air_move`；
//! ⑥ 落地判定 `categorize_position`；⑦ `detect_blocked_move` 冻结检测；
//! ⑧ `duck_frac` 视角插值。
//!
//! 关键不变量与坑：
//! - `player_tick` 是**单步直线流程**：全文件只有 5 处循环（`try_player_move` 3 处、
//!   `check_stuck` 2 处），没有物理子步循环 —— 一次调用 = 一步，要子步就多调几次。
//! - 碰撞箱是**瞬时**的：`mins()` / `maxs()` 按 `ducked` 现取现用，蹲/起当帧即换箱；
//!   只有**视角** `duck_frac` 在地面站/蹲之间按 `DUCK_LERP_TIME`（0.2 s）线性过渡，
//!   空中与落地当帧直接置位。
//! - 空中蹲下把 origin 抬高 `stand_maxs[1] − duck_maxs[1]`（默认箱 72 − 54 = 18 HU，
//!   收脚、头顶不动），**且只有抬升后的蹲箱空闲时才抬**（被挡则 `ducked` 已为 true、
//!   origin 不动）；空中起立需要 18 HU 净空，判据是站立箱扫掠 `fraction == 1.0`
//!   且非 `start_solid` / `all_solid`，不满足就保持蹲姿。
//! - 可站面判据统一是 `normal.y >= STANDABLE_NORMAL`（0.7）；surf 区间是
//!   `0.05 < normal.y < 0.7`（0.05 在两处硬编码），它同时决定 `surfing` 置位与
//!   `OVERBOUNCE_SURF`(1.0) / `OVERBOUNCE_DEFAULT`(1.001) 的选择。
//! - `contact_ticks` **只计可站面接触**（`normal.y >= 0.7`）：贴坡滑行（surfing）不计，
//!   且 `velocity.y > NON_JUMP_VELOCITY`（180）时直接清零。
//! - 蹲姿降速只在地面生效：`current_max_speed` 在 `on_ground && ducked` 时给
//!   `crouch_speed`(85)，空中（含贴坡无法起立的蹲姿）按 walk/run 取动量。
//! - 地面步进**不施加竖直重力**，贴地靠 `stay_on_ground` 沿 `STEP_HEIGHT`(18) 下探吸附；
//!   空中步进在 `try_player_move` 前后各施加半重力，合计 `−gravity × dt`。
//! - `check_jump` 排在 `if p.on_ground` 分支判断之前：起跳当帧走的是 `air_move`，不吃地面摩擦。
//!   起跳初速 `sqrt(2 × gravity × jump_height)`，默认参数下 ≈ 302.0 HU/s（顶点恰为 57 HU）。
//! - `check_stuck` 返回 true 的那一帧**不做任何移动**（梯子/起跳/walk/air/categorize 全跳过），
//!   且速度已被清零。
//!
//! 边界：本模块不做传送检测、不判掉落死亡、不处理 `reset` 键重生、不写 SAB、不碰
//! wasm-bindgen —— 这些都在 `mod.rs` 的 `PhysWorld::step_core` 里，并且排在 `player_tick`
//! **之前**。也不解析 BSP、不建空间索引、不持有世界数据、不读时钟（时间只来自 `dt` 参数）。
//!
//! 测试归属：本文件**无 `#[test]`**。语义回归在 `duck_surf_tests.rs` 的 6 项
//! （`surf_ramp_release_keeps_crouch` / `grounded_release_stands_up` /
//! `air_release_with_clearance_stands_up` / `slope_sweep_release_keeps_crouch` /
//! `air_crouch_momentum_uses_standing_params` / `ground_crouch_uses_crouch_speed`），
//! 其中后两项直接 `use` 本文件的 `AIR_ACCELERATE` 与 `CROUCH_SPEED`。
//! `p2_gate_tests.rs` 的 4 项针对 `world` 的盒-AABB 门校验，不覆盖本文件。

use super::world::{V3, World};

// ---------------------------------------------------------------------------
// 常量：物理标定的全部数值来源（`PhysParams::default` 直接取其中 9 项）
// ---------------------------------------------------------------------------

/// 可站面判据：平面法线 `normal.y >= 0.7` 即算地面（`categorize_position`、`stay_on_ground`、
/// `step_move` 的陡坡判定都用它）。它同时是 surf 区间的上界：`0.05 < normal.y < 0.7` 的平面
/// 不可站，`try_player_move` 命中它就置 `surfing`。
pub const STANDABLE_NORMAL: f64 = 0.7; // normal.y >= 0.7 即地面；更陡 = surf
/// 重力加速度（HU/s²）。只被 `air_move` 的两段半重力与 `check_jump` 的起跳初速使用；
/// 地面步进不带重力项，贴地由 `stay_on_ground` 的下探吸附完成。
pub const GRAVITY: f64 = 800.0;
/// 默认跑速（HU/s）：`PhysParams::run_speed` 的默认值，也是不按 walk 位时的地面动量上限。
pub const RUN_SPEED: f64 = 250.0;
/// 减速走速度（HU/s）：按住 walk 位（掩码 0x40）时的地面动量上限。
pub const WALK_SPEED: f64 = 130.0;
/// 地面蹲姿速度（HU/s）。**只在地面生效**（`current_max_speed` 要求 `on_ground && ducked`），
/// 空中蹲姿仍按 walk/run 取动量。
pub const CROUCH_SPEED: f64 = 85.0;

/// 空中加速系数（与 dt 相乘后无量纲）。
pub const AIR_ACCELERATE: f64 = 150.0;
/// 空中加速里 **addspeed 一侧**的 wishspeed 钳制（HU/s）：`air_accelerate` 用它算 `addspeed`，
/// 算 `accelspeed` 时却仍用未钳制的 wishspeed —— 这处不对称是高速下还能继续加速
/// （bhop / surf）的来源。
pub const AIR_SPEED_CAP: f64 = 30.0;

/// 平面剪裁的过冲系数（surf 用）：命中面法线的 y 落在 surf 区间（`0.05 < n.y < 0.7`）时取 1.0，
/// 即完全保留沿面速度、不做任何回弹。
pub const OVERBOUNCE_SURF: f64 = 1.0;
/// 平面剪裁的过冲系数（默认）：1.001 让剪裁后的速度略微离开平面，抵消浮点残差、
/// 避免下一帧再次命中同一面。可站面与墙面都走这一支。
pub const OVERBOUNCE_DEFAULT: f64 = 1.001;

/// 每像素鼠标的偏航角（度/像素）。**本文件不读它** —— `src/phys/mod.rs` 的 `step_core` / `predict`
/// 用它乘 `params.sensitivity` 把鼠标增量折算成角度。
pub const M_YAW: f64 = 0.022;
/// pitch 的绝对值上限（度）。**本文件不读它** —— 钳制发生在 `src/phys/mod.rs` 的
/// `step_core` / `predict`，本模块收到的 pitch 已是钳制后的值。
pub const PITCH_CLAMP: f64 = 89.0;

/// 默认碰撞箱半宽（HU），x/z 两轴共用；`PhysParams::hull_half_width` 的默认值。
pub const DEFAULT_HULL_HALF_WIDTH: f64 = 16.0;
/// 默认站立箱高（HU）。除作 `PhysParams::hull_stand_height` 的默认值外，
/// 还是 `eye_height()` 缩放 `EYE_STAND` 的比例基准。
pub const DEFAULT_HULL_STAND_HEIGHT: f64 = 72.0;
/// 默认蹲箱高（HU）。除作 `PhysParams::hull_duck_height` 的默认值外，
/// 还是 `eye_height()` 缩放 `EYE_DUCK` 的比例基准。
pub const DEFAULT_HULL_DUCK_HEIGHT: f64 = 54.0;
/// 默认箱下的站立眼高（HU，**相对 origin/脚底**的偏移，不是世界坐标）。
pub const EYE_STAND: f64 = 64.09;
/// 默认箱下的蹲姿眼高（HU，同样相对 origin）。
pub const EYE_DUCK: f64 = 46.04;
/// 地面**站 ⇄ 蹲的视角**过渡时长（秒）。碰撞箱是瞬时切换的，只有 `duck_frac` 按它走；
/// 生效条件是"在地面、且本 tick 不是落地当帧"（`player_tick` 末尾）：空中与落地当帧直接置 0/1。
/// 推进方式是线性的 `dt / DUCK_LERP_TIME`，且不超过剩余距离，故全程恰好 0.2 s 走完。
pub const DUCK_LERP_TIME: f64 = 0.2;
/// 空中蹲的**视角抬升量**（HU，纯视角，不动物理）。
///
/// 空中蹲下时 origin 会上移 `stand_maxs[1] − duck_maxs[1]`（默认箱 18 HU，收脚、头顶世界位置
/// 不动），于是 `origin + EYE_DUCK`(46.04) ≈ 站立眼高 64.09 —— 不加抬升就几乎分不出站还是蹲。
/// 这里给 `ducked && !on_ground` 的 `eye_height()` 返回值加 9 HU（= 收脚高度的一半）：
/// 默认箱下空中蹲的返回值是 46.04 + 9 = 55.04，而 origin 已抬高 18，世界眼位 ≈ 原 origin + 73.04。
///
/// 只加在返回值上：不改碰撞箱、不改 origin、不参与任何碰撞判定。
pub const AIR_DUCK_VIEW_LIFT: f64 = 9.0;

/// 起跳高度（HU）。`check_jump` 由它反推初速 `sqrt(2 × gravity × jump_height)`：
/// 默认重力 800 下 ≈ 302.0 HU/s，顶点高度恰为 57。
pub const JUMP_HEIGHT: f64 = 57.0;
/// 连跳水平速度钳制系数：`params.bhop_speed_clamp` 为真时，起跳前若水平速度超过
/// `current_max_speed × 1.1` 就按该比例等比压缩 x/z 分量（默认跑速下上限 275 HU/s）。
pub const BHOP_MAX_SPEED_FACTOR: f64 = 1.1;

/// 梯子攀爬基准速度（HU/s）：**每个输入轴各自乘它**再合成（不是先合成再乘），
/// 因此，前进 + 横移同时按时合速度可达 `LADDER_SPEED × √2` ≈ 282.84 HU/s，并按此上限钳制。
pub const LADDER_SPEED: f64 = 200.0;
/// 梯上跳离速度（HU/s），方向取梯子的 `facing`；跳离后置 `ladder_cooldown` 0.25 秒。
pub const LADDER_JUMP_OFF_SPEED: f64 = 270.0;

/// 台阶高（HU）：`step_move` 的"上抬 / 下探"距离，也是 `stay_on_ground` 的贴地下探距离。
pub const STEP_HEIGHT: f64 = 18.0;

/// 单个 tick 内累积的剪裁平面上限。`try_player_move` 在推入新平面**之前**检查：
/// 已满 8 个就把速度整体清零并结束本次移动。
pub const MAX_CLIP_PLANES: usize = 8;
/// 每次命中后沿命中法线的推开距离（HU），用于贴面解死锁。
/// 推开发生在平面上限检查**之前** —— 即使这一帧随后把速度清零，位置也已经推开。
pub const PUSH_OUT: f64 = 0.1;

/// 上升速阈值（HU/s）：`categorize_position` 里 `velocity.y` 高于它就判为"正在上升"，
/// 直接置 `on_ground = false` 并把 `contact_ticks` 清零、不做下探。
/// 默认起跳初速 ≈ 302 高于它，所以跳跃上升段不会被误判成落地。
pub const NON_JUMP_VELOCITY: f64 = 180.0;
/// `categorize_position` 的下探距离（HU）：从 origin 向下扫这么远找可站面。
pub const GROUND_TRACE_DIST: f64 = 2.0;

/// 度 → 弧度。本文件所有 yaw / pitch 的三角函数都经它换算（`compute_wish`、`noclip_step`、
/// `check_ladder`、`ladder_move`）。
const DEG2RAD: f64 = std::f64::consts::PI / 180.0;

// ---------------------------------------------------------------------------
// 设置：可运行时覆盖的物理参数（`PhysWorld::set_params` / `set_hull` 的写入面）
// ---------------------------------------------------------------------------

/// 可运行时覆盖的物理参数（18 个字段，全部 `pub`；`player_tick` 全程只按引用读）。
///
/// 写入方是 `src/phys/mod.rs` 的 `PhysWorld::set_params`（15 个标量键）与
/// `PhysWorld::set_hull`（三项箱体尺寸）；本模块自身不写任何字段。
///
/// 唯一会被复制走的是三项 `hull_*`：`create_player` 把它们写进 `Player` 的四组箱，
/// 之后单独改 `PhysParams.hull_*` 不会影响已存在的 `Player`（`set_hull` 是显式再调一次
/// `apply_hull` 才生效）。
#[derive(Clone, Debug)]
pub struct PhysParams {
    /// 重力加速度（HU/s²）。仅空中移动与起跳读取。
    pub gravity: f64,
    /// 地面加速系数（喂给 `accelerate`）。
    pub accelerate: f64,
    /// 地面摩擦系数（喂给 `apply_friction`）。
    pub friction: f64,
    /// 摩擦的"控制速度"下限（HU/s）：当前速度低于它时按它算摩擦量，
    /// 使低速下的每步减速量不至于趋近 0。
    pub stop_speed: f64,
    /// 起跳高度（HU），初速 = `sqrt(2 × gravity × jump_height)`。
    pub jump_height: f64,
    /// 空中加速系数（喂给 `air_accelerate`）。
    pub air_accelerate: f64,
    /// 跑速上限（HU/s）：不按 walk 位时的地面动量上限。
    pub run_speed: f64,
    /// 走速上限（HU/s）：按住 walk 位（0x40）时的地面动量上限。
    pub walk_speed: f64,
    /// 地面蹲姿上限（HU/s）：只在 `on_ground && ducked` 时取代 `walk_speed` / `run_speed`。
    pub crouch_speed: f64,
    /// true = 按住跳跃键即可连续起跳（跳过 `old_jump` 的重复抑制）。
    pub autobhop: bool,
    /// true = 起跳前把水平速度钳到 `current_max_speed × BHOP_MAX_SPEED_FACTOR`。
    pub bhop_speed_clamp: bool,
    /// 鼠标灵敏度倍率。**本文件不读它** —— `src/phys/mod.rs` 的 `step_core` / `predict` 用它乘 `M_YAW`。
    pub sensitivity: f64,
    /// Q/E 转向速度（度/秒）。**只有 `noclip_step` 读它**：常规移动的 `compute_wish` 与
    /// `ladder_move` 都不看 `input.yaw_left` / `yaw_right`。
    pub yaw_bind_speed: f64,
    /// noclip 单步位移的基准速度（HU/s）。实际位移 = 本值 ×（按住 walk 位 0x40 时 ×4）× dt，
    /// 默认 800 时即 800 / 3200 HU/s 两档。
    pub noclip_speed: f64,
    /// 传送触发的落地稳定门槛（帧）。**当前不改变任何行为**：字段确实被 `src/phys/mod.rs` 的
    /// `step_core` 传进 `TeleportManager::check`，但该形参名为 `_gate_ticks`
    /// （`src/phys/teleport.rs`）且函数体从不读它 —— `check` 只用 `ground_ticks`（`> 0` 即算落地）。
    pub teleport_gate_ticks: u32,
    /// 碰撞箱半宽（HU），x/z 两轴共用。
    pub hull_half_width: f64,
    /// 站立箱高（HU）。同时是 `eye_height()` 缩放 `EYE_STAND` 的比例基准。
    pub hull_stand_height: f64,
    /// 蹲箱高（HU）。同时是 `eye_height()` 缩放 `EYE_DUCK` 的比例基准。
    pub hull_duck_height: f64,
}

/// 默认值：9 项直接取模块常量（gravity / jump_height / air_accelerate / run_speed /
/// walk_speed / crouch_speed / hull_half_width / hull_stand_height / hull_duck_height），
/// 另 9 项是字面量：accelerate 10.0、friction 4.0、stop_speed 100.0、sensitivity 1.5、
/// yaw_bind_speed 210.0、noclip_speed 800.0、teleport_gate_ticks 3，
/// 以及两个默认打开的开关 autobhop / bhop_speed_clamp。
///
/// 本 crate 内参数默认值的唯一来源：`src/phys/mod.rs` 的 `PhysWorld::new` 用它建实例参数，
/// `PhysWorld::build_world` 再拿同一份实例参数重建玩家（两处都经 `create_player`）。
impl Default for PhysParams {
    fn default() -> Self {
        PhysParams {
            gravity: GRAVITY,
            accelerate: 10.0,
            friction: 4.0,
            stop_speed: 100.0,
            jump_height: JUMP_HEIGHT,
            air_accelerate: AIR_ACCELERATE,
            run_speed: RUN_SPEED,
            walk_speed: WALK_SPEED,
            crouch_speed: CROUCH_SPEED,
            autobhop: true,
            bhop_speed_clamp: true,
            sensitivity: 1.5,
            yaw_bind_speed: 210.0,
            noclip_speed: 800.0,
            teleport_gate_ticks: 3,
            hull_half_width: DEFAULT_HULL_HALF_WIDTH,
            hull_stand_height: DEFAULT_HULL_STAND_HEIGHT,
            hull_duck_height: DEFAULT_HULL_DUCK_HEIGHT,
        }
    }
}

// ---------------------------------------------------------------------------
// 输入与上下文
// ---------------------------------------------------------------------------

/// 一步的按键位状态：由 `src/phys/mod.rs` 的 `apply_input` 从 `keys_mask` 逐位覆盖写，
/// `player_tick` 全程只读。
///
/// 位定义与 TS 侧 `KEY_MASK` 逐位对应（`src/ts-shared/auth/shared-state.ts` 的 `KEY_MASK`）：
/// 0x01 forward / 0x02 back / 0x04 left / 0x08 right / 0x10 jump / 0x20 duck / 0x40 walk /
/// 0x80 reset / 0x100 wheelJump / 0x200 yawLeft / 0x400 yawRight。
///
/// 两处语义变体：`jump` 同时收 0x10 与 0x100（滚轮跳与空格等价）；
/// `walk` 在常规移动里是"减速走"（`WALK_SPEED` 130 HU/s），在 `noclip_step` 里却是"加速 sprint"
/// （×4）—— 同一位、两种含义。
#[derive(Clone, Copy, Debug, Default)]
pub struct InputState {
    /// 前进（W）。
    pub forward: bool,
    /// 后退（S）。
    pub back: bool,
    /// 左移（A）。
    pub left: bool,
    /// 右移（D）。
    pub right: bool,
    /// 跳跃（0x10 或滚轮跳 0x100）。
    pub jump: bool,
    /// 蹲（0x20）。
    pub duck: bool,
    /// 走/冲刺位（0x40）：常规移动里减速，noclip 里加速。
    pub walk: bool,
    /// 重生请求位（0x80）。本模块只负责清标志，实际重生在 `mod.rs` 的 `step_core` 里。
    pub reset: bool,
    /// Q/E 转向位（0x200 / 0x400）。**只有 `noclip_step` 读它们**：常规步进的 `compute_wish`
    /// 与 `ladder_move` 只看 WASD，所以走常规路径时这两位不产生任何旋转。
    pub yaw_left: bool,
    pub yaw_right: bool,
}

/// 单个玩家的全部可推进状态（字段全 `pub`：`mod.rs` 的 `step_core` 直接读写，
/// `state_js` / `fill_state_out` 直接读，`seed.rs` 逐字段收发）。
///
/// 没有 `Default`：唯一构造入口是 `create_player`，且它返回前一定调过 `apply_hull`，
/// 所以不存在箱体未初始化的 `Player`。`yaw` / `pitch` 不在构造参数里，
/// 由调用方事后赋（`src/phys/mod.rs` 的 `PhysWorld::build_world`）。
#[derive(Clone, Debug)]
pub struct Player {
    /// 脚底位置（HU，Y-up）。碰撞箱 = origin + `mins()` / `maxs()`，即箱底贴 origin。
    pub origin: V3,
    /// 速度（HU/s）。地面/空中步进与碰撞剪裁都直接改写它。
    pub velocity: V3,
    pub yaw: f64,   // 度；0 时面向 -Z
    pub pitch: f64, // 度

    /// 是否站在可站面上。每 tick 由 `categorize_position` 重算（上升速超过
    /// `NON_JUMP_VELOCITY` 时直接判否），不是"上一帧结果"的缓存；`check_jump` /
    /// `ladder_move` / `respawn` 也会改写它。
    pub on_ground: bool,
    /// 最近一次可站落地的平面法线。只在 `categorize_position` 的落地分支里写；
    /// 没落地时保留旧值（构造为 `[0,1,0]`）。
    pub ground_normal: V3,
    /// 当前是否为蹲姿 —— 碰撞箱的选择位：`mins()` / `maxs()` 立刻按它取值。
    /// 与视角插值 `duck_frac` 解耦，可以出现 `ducked == true` 而 `duck_frac == 0` 的一帧。
    pub ducked: bool,
    pub duck_frac: f64, // 0 站立，1 蹲下（驱动视角插值）
    /// 当前梯子（世界 ladders 索引；None = 不在梯上）。
    /// 用索引而非克隆的 LadderVolume——热路径（每 tick check_ladder）零克隆。
    pub on_ladder: Option<usize>,
    /// 本 tick 是否贴着 surf 区间（`0.05 < normal.y < 0.7`）的平面滑行。
    /// `try_player_move` 每次进入时先清零、再按命中法线置位，所以它总是"本 tick"的口径；
    /// `air_move` 读它来累加 `surfed_since_grounded`。
    pub surfing: bool,
    /// 自上次离开地面以来是否发生过贴坡滑行。只在 `air_move` 里置 true，起跳与 `respawn`
    /// 清 false；本文件内**无读取方**（只进 `seed.rs` 的种子面抽取）。
    pub surfed_since_grounded: bool,

    /// 落地冲击量。本文件内**没有写入非零值的语句**：构造为 0，之后每 tick 乘
    /// `(1 − 10 × dt).max(0)` 衰减 —— 除种子通道外恒为 0。
    pub land_punch: f64,
    /// 上一 tick 的跳跃位，用于两处沿检测：`autobhop == false` 时抑制按住连跳，
    /// `ladder_move` 用 `jump && !old_jump` 判定跳离梯子。
    pub old_jump: bool,
    /// 跳离梯子后的抓梯冷却（秒）：`ladder_move` 跳离时置 0.25，`player_tick` 每 tick 减 dt
    /// （仅在 > 0 时），`check_ladder` 在 > 0 期间直接返回 None。`respawn` **不复位**它。
    pub ladder_cooldown: f64,
    /// 下落速度（HU/s，正 = 下落）：空中分支每 tick 写 `−velocity.y`，落地与上梯清零。
    /// 本文件内无读取方，唯一消费点是 `state_out` 第 15 槽（`src/phys/mod.rs` 的 `fill_state_out`）。
    pub fall_velocity: f64,
    /// 落地后经过的地面 tick 数：落地当帧由 `categorize_position` 清 0，地面分支每 tick 自增。
    /// `player_tick` 末尾的 `duck_frac` 更新用 `== 0` 识别"落地当帧"（该帧视角瞬时置位）。
    pub ground_ticks_since_landing: u32,
    /// 可站面接触帧计数：判据与落地一致（`normal.y >= STANDABLE_NORMAL` 且 `fraction < 1.0`
    /// 且非 `start_solid`），**贴坡滑行不算接触** —— surfing 期间该值恒为 0。
    /// 未接触可站面、或上升速超过 `NON_JUMP_VELOCITY` 时清零；累加用 `saturating_add`。
    /// 消费点：`src/phys/mod.rs` 的 `step_core` 传送检测（作 `grounded` 判据）
    /// 与 `fill_state_out` 第 11 槽。
    pub contact_ticks: u32,
    /// 自上次重生以来是否起跳过（`check_jump` 置 true、`respawn` 清 false，**落地不复位**）。
    /// 本文件内无读取方，只进 `state_out` 第 19 槽（`src/phys/mod.rs` 的 `fill_state_out`）。
    pub has_jumped_before: bool,
    /// 落地瞬间的速度快照：仅在 `categorize_position` 的"上一 tick 还在空中"分支里写。
    /// 只进 `state_out` 第 16-18 槽（`src/phys/mod.rs` 的 `fill_state_out`），本文件内不消费。
    pub landing_velocity: V3,
    /// 连续"位置处于实心内"的 tick 数：`check_stuck` 里挤出成功即清零，彻底卡死才自增。
    /// 本文件内无读取方（只进种子面）。
    pub stuck_ticks: u32,
    /// 连续"有速度却几乎没位移"的 tick 数（`detect_blocked_move`）：到 6 就把速度清零并归零。
    /// 进 `state_out` 第 13 槽（`src/phys/mod.rs` 的 `fill_state_out`）。
    pub blocked_ticks: u32,

    /// 本步的按键状态。`src/phys/mod.rs` 的 `apply_input` 每步覆盖写一次。
    pub input: InputState,

    // 碰撞箱（apply_hull 按 params.hull_* 派生）
    /// 四组碰撞箱，**只由 `apply_hull` 写入**（入口是 `create_player` 与 `PhysWorld::set_hull`）。
    /// 站立与蹲的 mins 内容相同（都是 `[−half_width, 0, −half_width]`，箱底贴 origin），
    /// 只有 maxs 的高度不同；读取一律经 `mins()` / `maxs()` 按 `ducked` 二选一。
    pub stand_mins: V3,
    pub stand_maxs: V3,
    pub duck_mins: V3,
    pub duck_maxs: V3,

    // 记录位（prev_origin 供 detect_blocked_move 比对位移；prev_speed 无读取方）
    /// 上一 tick 的 origin：`player_tick` 开头快照，供 `detect_blocked_move` 比对位移。
    /// 但 `respawn`、`mod.rs` 的 `apply_teleport` 与 `noclip_step` 都会直接把它改写成当前
    /// origin —— 走过这些路径之后，"上一 tick 位置"的口径不再成立。
    pub prev_origin: V3,
    /// `player_tick` 开头写入的 3D 合速度（HU/s）。本文件内**无读取方**（只进 `seed.rs` 的
    /// 种子面抽取），即该字段当前不参与任何判定。
    pub prev_speed: f64,
}

impl Player {
    /// 当前姿态的箱体下界（相对 origin 的偏移，HU）：`ducked` 时取蹲箱，否则取站立箱。
    /// **瞬时**：同一 tick 内 `ducked` 一变，下一次调用就换箱。
    pub fn mins(&self) -> V3 {
        if self.ducked {
            self.duck_mins
        } else {
            self.stand_mins
        }
    }
    /// 当前姿态的箱体上界（相对 origin 的偏移，HU）：`maxs()[1]` 即身体高度
    /// （默认箱站立 72 / 蹲 54），`src/phys/mod.rs` 的 `step_core` 传送身体线段判定用的就是它。
    pub fn maxs(&self) -> V3 {
        if self.ducked {
            self.duck_maxs
        } else {
            self.stand_maxs
        }
    }

    /// 眼高（HU）：**相对 origin/脚底**的偏移，不是世界坐标。
    ///
    /// 计算分三步：`stand = EYE_STAND × (stand_maxs[1] / DEFAULT_HULL_STAND_HEIGHT)`、
    /// `duck = EYE_DUCK × (duck_maxs[1] / DEFAULT_HULL_DUCK_HEIGHT)`，
    /// 再按 `duck_frac` 线性插值 `stand + (duck − stand) × duck_frac`；
    /// 若 `ducked && !on_ground`，返回值再加 `AIR_DUCK_VIEW_LIFT`。
    ///
    /// 默认箱下的数值：stand 64.09、duck 46.04，插值区间 [46.04, 64.09]；
    /// 空中蹲再加 9 → 最高 73.09（= 64.09 + 9，对应 `duck_frac == 0` 的空中蹲）。
    /// 改箱高是**等比缩放**这两个眼高，而不是只改碰撞。
    ///
    /// **不做钳制**：`duck_frac` 超出 [0, 1] 时线性外推（种子通道可以给出越界值）。
    /// 纯读函数：不写任何状态、不推进 `duck_frac`（推进在 `player_tick` 末尾）。
    /// 消费方是 `src/phys/mod.rs` 的 `state_js`（`eyeHeight` 字段）与 `fill_state_out` 第 20 槽。
    pub fn eye_height(&self) -> f64 {
        let stand = EYE_STAND * (self.stand_maxs[1] / DEFAULT_HULL_STAND_HEIGHT);
        let duck = EYE_DUCK * (self.duck_maxs[1] / DEFAULT_HULL_DUCK_HEIGHT);
        let base = stand + (duck - stand) * self.duck_frac;
        if self.ducked && !self.on_ground {
            base + AIR_DUCK_VIEW_LIFT
        } else {
            base
        }
    }

    /// 水平合速度 `sqrt(vx² + vz²)`（HU/s）。本文件内唯一的读取方是 `check_jump` 的连跳钳制；
    /// 不看 `vy`，所以跳跃上升/下落段也照常计入。
    pub fn horizontal_speed(&self) -> f64 {
        (self.velocity[0] * self.velocity[0] + self.velocity[2] * self.velocity[2]).sqrt()
    }

    /// 3D 合速度（HU/s）。本文件内只有一处使用：`player_tick` 开头把它写进 `prev_speed`，
    /// 而 `prev_speed` 没有读取方 —— 该值当前不参与任何判定。
    pub fn speed_3d(&self) -> f64 {
        (self.velocity[0] * self.velocity[0]
            + self.velocity[1] * self.velocity[1]
            + self.velocity[2] * self.velocity[2])
            .sqrt()
    }

    /// 放回出生点并复位运动态：`origin`、速度、`on_ground`、`on_ladder`、`ducked`、`duck_frac`、
    /// `ground_ticks_since_landing`、`contact_ticks`、`has_jumped_before`、`surfed_since_grounded`、
    /// `landing_velocity`、`prev_origin`。
    ///
    /// **不复位**：`yaw` / `pitch`（朝向沿用）、`surfing`（下次 `try_player_move` 开头自会重算）、
    /// `fall_velocity`、`ladder_cooldown`（跳离梯子后 0.25 s 内死亡重生，剩余冷却继续递减）、
    /// `stuck_ticks` / `blocked_ticks`、`land_punch`、`old_jump`、`prev_speed`、`input`（按键状态）
    /// 与四组碰撞箱。
    ///
    /// 只写本玩家的字段：不碰 `World`、不复位传送冷却 —— 传送冷却是 `src/phys/mod.rs` 的
    /// 调用点各自处理的，且并不齐：传送、掉落死亡与 `PhysWorld::respawn` 都会复位，
    /// 而 `reset` 键那条分支只调本函数、不复位冷却。
    pub fn respawn(&mut self, spawn: &V3) {
        self.origin = *spawn;
        self.velocity = [0.0, 0.0, 0.0];
        self.on_ground = false;
        self.on_ladder = None;
        self.ducked = false;
        self.ground_ticks_since_landing = 0;
        self.contact_ticks = 0;
        self.has_jumped_before = false;
        self.surfed_since_grounded = false;
        self.landing_velocity = [0.0, 0.0, 0.0];
        self.prev_origin = *spawn;
        self.duck_frac = 0.0;
    }
}

// ---------------------------------------------------------------------------
// 移动语义（自由函数；上下文 = &mut Player + &PhysParams，几何查询交给 World）
// ---------------------------------------------------------------------------

/// 点积（三个分量全参与，没有"只算水平"的变体）。
#[inline]
fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// 叉积：`try_player_move` 用它求两面交线（接缝方向），`ladder_move` 用它从梯面法线导出
/// 梯面内的水平/向上方向。
#[inline]
fn cross(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// 原地归一化，返回**归一化前**的模长；模长为 0 时向量原样返回。
/// 调用方都靠这个返回值判退化（`compute_wish` 判有无输入、`ladder_move` 判零 wish、
/// `try_player_move` 判交线是否退化）。
#[inline]
fn normalize(v: &mut V3) -> f64 {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 0.0 {
        v[0] /= len;
        v[1] /= len;
        v[2] /= len;
    }
    len
}

/// 模长平方（`try_player_move` 与 `detect_blocked_move` 用它避开开方）。
#[inline]
fn length_sq(v: &V3) -> f64 {
    v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
}

// -- Accelerate / AirAccelerate / Friction / ClipVelocity --------------------

/// 地面加速：`addspeed = wishspeed − dot(velocity, wishdir)`，`<= 0` 直接返回（已达上限）；
/// 否则沿 `wishdir` 加上 `min(accel × dt × wishspeed, addspeed)`。
///
/// 上限同时受调用方给的 `wishspeed`（`compute_wish` 已按 `current_max_speed` 算好）与
/// `addspeed` 约束。不读 `params`：系数由调用方传入。
/// 唯一调用点 `walk_move` 传的 wishdir 是水平的（y = 0），所以实际只改水平速度。
#[inline]
fn accelerate(vel: &mut V3, wishdir: &V3, wishspeed: f64, accel: f64, dt: f64) {
    let currentspeed = dot(vel, wishdir);
    let addspeed = wishspeed - currentspeed;
    if addspeed <= 0.0 {
        return;
    }
    let mut accelspeed = accel * dt * wishspeed;
    if accelspeed > addspeed {
        accelspeed = addspeed;
    }
    vel[0] += accelspeed * wishdir[0];
    vel[1] += accelspeed * wishdir[1];
    vel[2] += accelspeed * wishdir[2];
}

/// 空气加速：addspeed 一侧把 wishspeed 钳到 `AIR_SPEED_CAP`(30 HU/s)，
/// accelspeed 一侧却用**未钳制**的 wishspeed × `AIR_ACCELERATE` × dt —— 这处刻意的不对称
/// 让高速下 `addspeed` 仍为正，是 bhop / surf 能持续加速的来源。
///
/// 与 `accelerate` 一样按 `addspeed` 截断单步增量，且同样只被水平 wishdir 调用。
#[inline]
fn air_accelerate(vel: &mut V3, wishdir: &V3, wishspeed: f64, airaccel: f64, dt: f64) {
    let wishspd = if wishspeed > AIR_SPEED_CAP {
        AIR_SPEED_CAP
    } else {
        wishspeed
    };
    let currentspeed = dot(vel, wishdir);
    let addspeed = wishspd - currentspeed;
    if addspeed <= 0.0 {
        return;
    }
    let mut accelspeed = airaccel * wishspeed * dt;
    if accelspeed > addspeed {
        accelspeed = addspeed;
    }
    vel[0] += accelspeed * wishdir[0];
    vel[1] += accelspeed * wishdir[1];
    vel[2] += accelspeed * wishdir[2];
}

/// 地面摩擦：只缩放水平分量（`velocity.y` 完全不动）。
/// 水平速度 < 0.1 直接返回；否则控制速度取 `max(speed, stop_speed)`，每步扣
/// `control × friction × dt`，扣到 0 为止（不会反向）。只在 `newspeed != speed` 时做等比缩放。
#[inline]
fn apply_friction(vel: &mut V3, friction: f64, stopspeed: f64, dt: f64) {
    let speed = (vel[0] * vel[0] + vel[2] * vel[2]).sqrt();
    if speed < 0.1 {
        return;
    }
    let control = if speed < stopspeed { stopspeed } else { speed };
    let drop = control * friction * dt;
    let newspeed = if speed - drop < 0.0 { 0.0 } else { speed - drop };
    if newspeed != speed {
        let ratio = newspeed / speed;
        vel[0] *= ratio;
        vel[2] *= ratio;
    }
}

/// 去掉速度沿 `normal` 方向的侵入分量：`backoff = dot(velocity, normal) × overbounce`，
/// 再从速度里减去 `normal × backoff`；随后做一次残差修正 —— 若仍有 `dot(velocity, normal) < 0`
/// （`overbounce = 1.0` 时的浮点残差）就再减一次，使剪裁后的速度真正落在平面内。
///
/// 本函数**不含 surf 判定**：overbounce 由调用方经 `overbounce_for` 给出（surf 面 1.0，
/// 其余 1.001）；传 1.0 时保留全部沿面速度，传 1.001 时速度会略微离开平面。
#[inline]
fn clip_velocity(vel: &mut V3, normal: &V3, overbounce: f64) {
    let backoff = dot(vel, normal) * overbounce;
    vel[0] -= normal[0] * backoff;
    vel[1] -= normal[1] * backoff;
    vel[2] -= normal[2] * backoff;
    // 残差修正：overbounce 1.0 时剪裁后仍会残留指向平面的分量 → 再清一次
    let adjust = dot(vel, normal);
    if adjust < 0.0 {
        vel[0] -= normal[0] * adjust;
        vel[1] -= normal[1] * adjust;
        vel[2] -= normal[2] * adjust;
    }
}

/// 按命中平面法线的 y 分量选过冲系数：`0.05 < normal.y < STANDABLE_NORMAL`（surf 区间）取
/// `OVERBOUNCE_SURF`(1.0，保留全部沿面速度)；可站面（y ≥ 0.7）、近垂直面（y ≤ 0.05）与
/// 恰好等于 0.7 的边界值取 `OVERBOUNCE_DEFAULT`(1.001，略微离面以防重复命中)。
#[inline]
fn overbounce_for(normal: &V3) -> f64 {
    let ny = normal[1];
    if ny > 0.05 && ny < STANDABLE_NORMAL {
        OVERBOUNCE_SURF
    } else {
        OVERBOUNCE_DEFAULT
    }
}

// -- WishDir / CurrentMaxSpeed -----------------------------------------------

/// 动量速度上限（喂给 `compute_wish` → `accelerate` / `air_accelerate`，以及 `check_jump`
/// 的连跳钳制）。
///
/// 取值优先级：`on_ground && ducked` → `crouch_speed`(85)；否则按 `input.walk` 取
/// `walk_speed`(130) 或 `run_speed`(250)。
///
/// **蹲姿降速只在地面生效**：空中即使 `ducked == true`（含贴坡松蹲键却无法起立的蹲姿），
/// 也按 walk/run 给动量 —— 姿态保持蹲姿，但空中加速的上限不被 85 拖低。
///
/// 只读 `Player` 与 `params`，不改状态。回归见 `duck_surf_tests.rs` 的
/// `air_crouch_momentum_uses_standing_params` 与 `ground_crouch_uses_crouch_speed`。
fn current_max_speed(p: &Player, params: &PhysParams) -> f64 {
    let speed = if p.on_ground && p.ducked {
        params.crouch_speed
    } else if p.input.walk {
        params.walk_speed
    } else {
        params.run_speed
    };
    speed
}

/// 由 WASD 与 yaw 算水平期望方向（单位向量，y 恒为 0）写入 `wish_dir`，返回本 tick 的
/// wishspeed（HU/s）。
///
/// yaw 约定：前进 = `(−sin yaw, 0, −cos yaw)`，右移 = `(cos yaw, 0, −sin yaw)`（yaw = 0 面向 −Z）。
/// pitch **不参与** —— 地面与空中移动都是纯水平的。
///
/// 返回值：`normalize` 给出的是归一化**前**的模长，而输入分量只取 −1 / 0 / 1，故模长只有
/// 0、1、√2 三种；乘 `current_max_speed` 后再与该上限取小，于是斜向按两键不会超速 ——
/// 只要有输入，wishspeed 就等于 `current_max_speed`，无输入时 `wish_dir` 被写成零向量且返回 0。
fn compute_wish(p: &Player, params: &PhysParams, wish_dir: &mut V3) -> f64 {
    let fmove = (if p.input.forward { 1.0 } else { 0.0 }) - (if p.input.back { 1.0 } else { 0.0 });
    let smove = (if p.input.right { 1.0 } else { 0.0 }) - (if p.input.left { 1.0 } else { 0.0 });
    let yaw_rad = p.yaw * DEG2RAD;
    let fx = -yaw_rad.sin();
    let fz = -yaw_rad.cos();
    let rx = yaw_rad.cos();
    let rz = -yaw_rad.sin();
    *wish_dir = [fx * fmove + rx * smove, 0.0, fz * fmove + rz * smove];
    let maxspeed = current_max_speed(p, params);
    let len = normalize(wish_dir);
    if len > 0.0 {
        let s = len * maxspeed;
        if s > maxspeed {
            maxspeed
        } else {
            s
        }
    } else {
        0.0
    }
}

// -- TryPlayerMove -----------------------------------------------------------

/// 扫掠位移 + 平面剪裁（本文件最复杂的一步，也是 `surfing` 的唯一置位点）。
///
/// 至多 4 次 bump（`for _bump in 0..4`），每次用剩余时间 `time_left` 从 `origin` 扫到
/// `origin + velocity × time_left`：
/// - 速度为零：直接跳出；
/// - `all_solid`：速度清零并**立即返回**（位置不动）；
/// - `fraction > 0.0`：origin 推进到 `end_pos`，并清空累积平面表（`fraction == 0` 时两者都不做）；
/// - `fraction == 1.0`：本 tick 走完，跳出；
/// - 否则处理命中面：若已有平面与该法线相对（`dot < −0.5`，V 形槽/墙缝）则沿两面交线滑出，
///   否则沿法线推开 `PUSH_OUT`(0.1 HU)、按 `fraction` 折算剩余时间，接着
///   `MAX_CLIP_PLANES`(8) 已满就清零速度返回，未满则去重（`dot > 0.99` 视为同面）后记入平面表；
///   法线 y 落在 `0.05 .. 0.7` 时置 `surfing = true`。
///
/// 剪裁：先逐个平面试"原速度 + `clip_velocity`"，取第一个不再侵入其余平面的结果；
/// 全都不行时按平面数分支 —— ≥3 用平均法线（取向还需通过全部平面校验），
/// 恰好 2 用两面交线，其余整体清零返回。
///
/// 末尾还有一层兜底：若剪裁后速度与入口速度反向（`dot(velocity, primal_vel) <= 0`），
/// 不整体归零，而是沿接缝（≥2 个平面）或最后一个平面滑出后返回。
///
/// 两个速度快照都在入口取（此刻两者相等）：`original_vel` 供反复重裁，`primal_vel` 只用于
/// 上面那层反向判定。
///
/// 副作用：写 `p.origin` / `p.velocity` / `p.surfing`。`_params` 未使用（剪裁只需要几何）。
fn try_player_move(world: &mut World, p: &mut Player, _params: &PhysParams, dt: f64) {
    let mut time_left = dt;
    let mut planes: Vec<V3> = Vec::new();
    let original_vel = p.velocity;
    let primal_vel = p.velocity;
    p.surfing = false;

    for _bump in 0..4 {
        if length_sq(&p.velocity) == 0.0 {
            break;
        }
        let move_end = [
            p.origin[0] + p.velocity[0] * time_left,
            p.origin[1] + p.velocity[1] * time_left,
            p.origin[2] + p.velocity[2] * time_left,
        ];
        let mins = p.mins();
        let maxs = p.maxs();
        let tr = world.trace(&p.origin, &move_end, &mins, &maxs);

        if tr.all_solid {
            p.velocity = [0.0, 0.0, 0.0];
            return;
        }
        if tr.fraction > 0.0 {
            p.origin = tr.end_pos;
            let _ = original_vel; // 语义保留：original_vel 为碰撞前速度，剪裁用
            planes.clear();
        }
        if tr.fraction == 1.0 {
            break;
        }

        let n = tr.normal.unwrap_or([0.0, 0.0, 1.0]);

        // 夹缝检测：已有平面与当前法线相对（V 形槽/墙缝）→ 沿交线滑出
        let wedge = planes.iter().find(|pl| dot(pl, &n) < -0.5).copied();
        if let Some(wedge_plane) = wedge {
            let mut w = cross(&n, &wedge_plane);
            let wlen = normalize(&mut w);
            if wlen > 1e-6 {
                let along = dot(&w, &p.velocity);
                p.velocity = [w[0] * along, w[1] * along, w[2] * along];
            } else {
                let backoff = dot(&p.velocity, &n);
                p.velocity[0] -= n[0] * backoff;
                p.velocity[1] -= n[1] * backoff;
                p.velocity[2] -= n[2] * backoff;
            }
            time_left -= time_left * tr.fraction;
            continue;
        }

        // 撞击后沿法线推开（贴面解死锁）
        p.origin[0] += n[0] * PUSH_OUT;
        p.origin[1] += n[1] * PUSH_OUT;
        p.origin[2] += n[2] * PUSH_OUT;

        time_left -= time_left * tr.fraction;

        if planes.len() >= MAX_CLIP_PLANES {
            p.velocity = [0.0, 0.0, 0.0];
            return;
        }
        if !planes.iter().any(|pl| dot(pl, &n) > 0.99) {
            planes.push(n);
        }
        if n[1] > 0.05 && n[1] < STANDABLE_NORMAL {
            p.surfing = true;
        }

        // 找出一种不重新进入任何平面的原速度剪裁
        let mut i = 0usize;
        while i < planes.len() {
            p.velocity = original_vel;
            clip_velocity(&mut p.velocity, &planes[i], overbounce_for(&planes[i]));
            let ok = planes.iter().enumerate().all(|(j, pl)| {
                j == i || dot(&p.velocity, pl) >= 0.0
            });
            if ok {
                break;
            }
            i += 1;
        }

        if i == planes.len() {
            // 单平面剪裁全部无效：≥3 个平面时先试平均法线；仍不通过且平面数 ≠ 2 就整体清零；
            // 恰好 2 个时沿两面交线滑动（交线退化则改用第一个平面剪裁）
            let mut avg_ok = false;
            if planes.len() >= 3 {
                let mut sum = [0.0, 0.0, 0.0];
                for pl in &planes {
                    sum[0] += pl[0];
                    sum[1] += pl[1];
                    sum[2] += pl[2];
                }
                let avg_len = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
                if avg_len > 1e-6 {
                    let mut avg = [sum[0] / avg_len, sum[1] / avg_len, sum[2] / avg_len];
                    let _ = &mut avg;
                    p.velocity = original_vel;
                    clip_velocity(&mut p.velocity, &avg, overbounce_for(&avg));
                    avg_ok = planes.iter().all(|pl| dot(&p.velocity, pl) >= 0.0);
                }
            }
            if !avg_ok {
                if planes.len() != 2 {
                    p.velocity = [0.0, 0.0, 0.0];
                    return;
                }
                let mut crease = cross(&planes[0], &planes[1]);
                let clen = normalize(&mut crease);
                if clen < 1e-6 {
                    p.velocity = original_vel;
                    clip_velocity(&mut p.velocity, &planes[0], overbounce_for(&planes[0]));
                } else {
                    let along = dot(&crease, &p.velocity);
                    p.velocity = [crease[0] * along, crease[1] * along, crease[2] * along];
                }
            }
        }

        // 若被反弹回原方向：不整体归零，沿接缝/平面滑动
        if dot(&p.velocity, &primal_vel) <= 0.0 {
            if planes.len() >= 2 {
                let mut crease = cross(&planes[0], &planes[1]);
                let clen = normalize(&mut crease);
                if clen > 1e-6 {
                    let along = dot(&crease, &p.velocity);
                    p.velocity = [crease[0] * along, crease[1] * along, crease[2] * along];
                } else {
                    let last = planes[planes.len() - 1];
                    let backoff = dot(&p.velocity, &last);
                    p.velocity[0] -= last[0] * backoff;
                    p.velocity[1] -= last[1] * backoff;
                    p.velocity[2] -= last[2] * backoff;
                }
            } else if let Some(&last) = planes.last() {
                let backoff = dot(&p.velocity, &last);
                p.velocity[0] -= last[0] * backoff;
                p.velocity[1] -= last[1] * backoff;
                p.velocity[2] -= last[2] * backoff;
            }
            return;
        }
    }
}

// -- Jump --------------------------------------------------------------------

/// 起跳。前置条件：`on_ground`、`input.jump` 为真；`autobhop == false` 时还要求上一 tick
/// 没按着跳跃（否则视为"按住不放"，不起跳）。
///
/// `bhop_speed_clamp == true` 时先做连跳钳制：水平速度超过 `current_max_speed × 1.1`
/// 就等比压缩 x/z（默认跑速下上限 275 HU/s）。此刻 `on_ground` 仍为 true，所以蹲姿起跳
/// 用的是 `crouch_speed × 1.1` = 93.5。
///
/// 初速 `sqrt(2 × gravity × jump_height)`（默认 800 / 57 → ≈ 302.0 HU/s）**覆盖** `velocity.y`，
/// 不是叠加；随后置 `on_ground = false`、`has_jumped_before = true`、`surfed_since_grounded = false`。
///
/// 顺序上本函数在 `player_tick` 的 `if p.on_ground` 分支判断**之前**执行，所以起跳当帧走的
/// 是 `air_move`（不吃地面摩擦）。
fn check_jump(p: &mut Player, params: &PhysParams) {
    if !p.on_ground {
        return;
    }
    if !p.input.jump {
        return;
    }
    // autobhop 关闭时：上一 tick 已按着跳跃就不起跳（必须松开再按）
    if !params.autobhop && p.old_jump {
        return;
    }

    // 连跳速度钳制：把水平速度压到 current_max_speed × 1.1 以内（等比缩放 x/z）
    if params.bhop_speed_clamp {
        let max_scaled = current_max_speed(p, params) * BHOP_MAX_SPEED_FACTOR;
        let speed = p.horizontal_speed();
        if speed > max_scaled {
            let fraction = max_scaled / speed;
            p.velocity[0] *= fraction;
            p.velocity[2] *= fraction;
        }
    }

    // 初速由 jump_height 反推（v² / 2g = jump_height），直接覆盖 y 分量而非叠加
    let jump_velocity = (2.0 * params.gravity * params.jump_height).sqrt();
    p.velocity[1] = jump_velocity;
    p.on_ground = false;
    p.has_jumped_before = true;
    p.surfed_since_grounded = false;
}

// -- Duck --------------------------------------------------------------------

/// 蹲伏状态机（`player_tick` 的第一步）。输入只有 `input.duck` 与当前姿态/几何：
///
/// - **按下蹲**：`ducked` 立即置 true（碰撞箱当帧就换）。此刻若在空中，还要把 origin 抬高
///   `stand_maxs[1] − duck_maxs[1]`（默认箱 18 HU，收脚、头顶世界位置不动）——
///   但**仅当抬升后的蹲箱空闲**（`is_position_free`）：被挡时 `ducked` 已为 true、origin 不动。
/// - **松开蹲且在地面**：站立箱与蹲箱的 mins 相同，所以只需在**原地**用站立箱判定可行性，
///   可行才清 `ducked`；随后**直接返回**（地面分支不做任何 origin 位移）。
/// - **松开蹲且在空中**：把 origin 下移同一个 delta（放脚、头顶不动），用**站立箱**从当前
///   origin 向目标扫掠，要求 `!start_solid && !all_solid && fraction == 1.0`，
///   不满足就保持蹲姿。
///
/// 于是贴坡滑行（脚下那点净空放不进站立箱）时松开蹲键会一直保持蹲姿，直到离坡或落地。
///
/// 副作用：写 `p.ducked`，并在两条空中分支里改写 `p.origin[1]`；每条分支各读 `World` 一次
/// （`is_position_free` 或 `trace`）。
/// `duck_frac`（视角）**不在这里**推进，它在 `player_tick` 末尾按地面/空中分别渐变或瞬时置位。
/// 不做：不看 `input.duck` 之外的键、不碰速度、不判落地。
fn update_duck(world: &mut World, p: &mut Player) {
    let want = p.input.duck;
    if want && !p.ducked {
        p.ducked = true;
        if !p.on_ground {
            // 空中蹲下：从脚部往上缩（origin 上移 = 收脚，头顶世界位置不动）。
            // 收脚后 origin + 蹲姿眼高(46.04) ≈ 站立眼高(64.09)，光靠收脚很难看出差别；
            // 可感知的抬升由 eye_height() 的 AIR_DUCK_VIEW_LIFT(+9) 提供。
            // 前提是抬升后的蹲箱空闲：被挡时 ducked 已置 true，origin 停在本来的位置。
            let delta = p.stand_maxs[1] - p.duck_maxs[1];
            let tmp = [p.origin[0], p.origin[1] + delta, p.origin[2]];
            if world.is_position_free(&tmp, &p.duck_mins, &p.duck_maxs) {
                p.origin[1] += delta;
            }
        }
    } else if !want && p.ducked {
        if p.on_ground {
            // 地面起立：站立箱与蹲箱的 mins 相同 → origin 不动，只用站立箱在原地判定；
            // 头顶被挡则保持蹲。判定完直接返回，不做任何位移。
            if world.is_position_free(&p.origin, &p.stand_mins, &p.stand_maxs) {
                p.ducked = false;
            }
            return;
        }
        // 空中起立：**放脚** —— origin 下移 (stand_hull − duck_hull)，头顶位置不变。
        // 以**站立箱**从当前 origin 扫掠到目标 origin，命中（start_solid / all_solid /
        // fraction != 1）即**不起立**，保持蹲姿。
        //
        // 贴坡滑行时脚下放不下这 18 HU 的站立箱，松开蹲键会一直保持蹲姿，直到离坡或落地。
        // 此处没有「原地长高（脚不动、头顶 +18）」的兜底分支：
        // 判据就是站立箱扫掠的结果，多面交界处的取舍完全由几何决定。
        let delta = p.stand_maxs[1] - p.duck_maxs[1];
        let target = [p.origin[0], p.origin[1] - delta, p.origin[2]];
        let tr = world.trace(&p.origin, &target, &p.stand_mins, &p.stand_maxs);
        if !tr.start_solid && !tr.all_solid && tr.fraction == 1.0 {
            p.origin[1] -= delta;
            p.ducked = false;
        }
    }
}

// -- Ladder ------------------------------------------------------------------

/// 找当前该抓住的梯子索引（`World::ladder_at`）；None = 不在梯上。
///
/// 判定顺序：`ladder_cooldown > 0` 直接 None（跳离后 0.25 s 的保护期）→ 碰撞箱与某个梯子体
/// 相交（用**当前姿态**箱，蹲着就是蹲箱）→ 已在梯上则保持（直接接受新索引，含换梯）→
/// 空中直接抓住 → 地面则要求按住前进且面朝梯子：`dot(前进方向, −facing) > 0.3`
/// （0.3 是硬编码阈值，与 `params` 无关）。
///
/// 纯读：不改 `Player`、不改 `World`。
fn check_ladder(world: &World, p: &Player) -> Option<usize> {
    if p.ladder_cooldown > 0.0 {
        return None;
    }
    let mins = p.mins();
    let maxs = p.maxs();
    let ladder_idx = world.ladder_at(&p.origin, &mins, &maxs)?;
    if p.on_ladder.is_some() {
        return Some(ladder_idx); // 已在梯上——保持
    }
    // 仅在空中、或主动走向梯子时抓住
    if !p.on_ground {
        return Some(ladder_idx);
    }
    let ladder = &world.ladders[ladder_idx];
    let yaw_rad = p.yaw * DEG2RAD;
    let facing_dot = (-yaw_rad.sin()) * (-ladder.facing[0]) + (-yaw_rad.cos()) * (-ladder.facing[2]);
    if p.input.forward && facing_dot > 0.3 {
        return Some(ladder_idx);
    }
    None
}

/// 梯上移动。进入时先把 `on_ladder` 置位、`on_ground = false`、`fall_velocity = 0`。
///
/// 两条出口：
/// - **跳离**：`input.jump && !old_jump`（沿检测，按住不放只触发一次）时速度直接设为
///   `facing × LADDER_JUMP_OFF_SPEED`(270 HU/s)，置 `ladder_cooldown` 0.25 秒、清 `on_ladder`，
///   再走一次 `try_player_move` 后返回；
/// - **攀爬**：由 `facing` 与 pitch 组成完整 3D 基，每个输入轴各自乘 `LADDER_SPEED`(200) 后合成
///   （先归一化再乘会削弱斜向），合成后按 `LADDER_SPEED × √2` ≈ 282.84 HU/s 钳制；
///   再把 wish 拆成沿梯面横向分量与垂直梯面分量，后者取 `−normal_vel` 重定向到 `climb_dir`
///   （梯面内的向上方向）—— 于是仰视 + 前进向上爬、俯视下降。
///
/// 无输入（wish 模长为 0）时速度清零并**提前返回**，不做位移。
///
/// 副作用：写 `on_ladder` / `on_ground` / `fall_velocity` / `velocity` / `origin`
/// （后两者主要经 `try_player_move`）；跳离分支还写 `ladder_cooldown`。
fn ladder_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64, ladder_idx: usize) {
    p.on_ladder = Some(ladder_idx);
    p.on_ground = false;
    p.fall_velocity = 0.0;
    let ladder = &world.ladders[ladder_idx];

    // 跳离：推离梯面
    if p.input.jump && !p.old_jump {
        p.velocity = [
            ladder.facing[0] * LADDER_JUMP_OFF_SPEED,
            ladder.facing[1] * LADDER_JUMP_OFF_SPEED,
            ladder.facing[2] * LADDER_JUMP_OFF_SPEED,
        ];
        p.ladder_cooldown = 0.25;
        p.on_ladder = None;
        try_player_move(world, p, params, dt);
        return;
    }

    let fmove = (if p.input.forward { 1.0 } else { 0.0 }) - (if p.input.back { 1.0 } else { 0.0 });
    let smove = (if p.input.right { 1.0 } else { 0.0 }) - (if p.input.left { 1.0 } else { 0.0 });

    // 完整 3D 视角基——仰视 + 前进向上爬，俯视下降
    let yaw_rad = p.yaw * DEG2RAD;
    let pitch_rad = p.pitch * DEG2RAD;
    let cp = pitch_rad.cos();
    let fwd = [
        -yaw_rad.sin() * cp,
        pitch_rad.sin(),
        -yaw_rad.cos() * cp,
    ];
    let right = [yaw_rad.cos(), 0.0, -yaw_rad.sin()];

    // 每个输入轴贡献其完整的攀爬速度（不先归一化，斜向两键因此能超过单轴速度）
    let mut wish = [
        (fwd[0] * fmove + right[0] * smove) * LADDER_SPEED,
        (fwd[1] * fmove + right[1] * smove) * LADDER_SPEED,
        (fwd[2] * fmove + right[2] * smove) * LADDER_SPEED,
    ];
    let wlen = normalize(&mut wish);
    if wlen == 0.0 {
        p.velocity = [0.0, 0.0, 0.0];
        return;
    }
    let max_wish = LADDER_SPEED * std::f64::consts::SQRT_2;
    if wlen > max_wish {
        let scale = max_wish / wlen;
        wish[0] *= scale;
        wish[1] *= scale;
        wish[2] *= scale;
    }

    // 将 wish 拆分为沿梯面横向与垂直墙面两部分；垂直部分重定向到攀爬方向
    let n = ladder.facing;
    let normal_vel = dot(&wish, &n);
    let lateral = [
        wish[0] - n[0] * normal_vel,
        wish[1] - n[1] * normal_vel,
        wish[2] - n[2] * normal_vel,
    ];
    let up = [0.0, 1.0, 0.0];
    let mut along = cross(&n, &up); // 水平、沿墙方向
    normalize(&mut along);
    let mut climb_dir = cross(&along, &n); // 垂直于梯面向上
    normalize(&mut climb_dir);

    p.velocity = [
        lateral[0] + climb_dir[0] * -normal_vel,
        lateral[1] + climb_dir[1] * -normal_vel,
        lateral[2] + climb_dir[2] * -normal_vel,
    ];

    try_player_move(world, p, params, dt);
}

// -- StepMove / StayOnGround / CategorizePosition / StuckCheck / BlockedMove --

/// 台阶移动：跑两次 `try_player_move` 再择优。
///
/// ① **直接移动**：从当前 origin 走一次，结果存为 `down_origin` / `down_vel`；
/// ② **上-移-下**：回到起点，先沿 `+STEP_HEIGHT`(18 HU) 扫掠抬升（`start_solid` / `all_solid`
///    时不抬），再走一次，随后沿 `−STEP_HEIGHT` 扫掠落回。
///
/// 落回时若命中不可站面（`fraction < 1.0` 且 `normal.y < STANDABLE_NORMAL`）即判
/// `stepped_onto_steep`：整体回退到直接移动的结果并返回。
/// 否则比较两条路径的**水平位移**（只算 x/z 的 `dx² + dz²`），取更大的那一条；
/// 若保留的是抬升路径，则把 `down_vel[1]` 借过来当竖直速度。
///
/// 副作用：写 `p.origin` / `p.velocity`（`surfing` 也随之更新，经 `try_player_move`）。
fn step_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64) {
    let start_origin = p.origin;
    let start_vel = p.velocity;

    // 尝试 1：直接
    try_player_move(world, p, params, dt);
    let down_origin = p.origin;
    let down_vel = p.velocity;

    // 尝试 2：上、移、下
    p.origin = start_origin;
    p.velocity = start_vel;
    let mins = p.mins();
    let maxs = p.maxs();
    let mut tr = world.trace(
        &p.origin,
        &[p.origin[0], p.origin[1] + STEP_HEIGHT, p.origin[2]],
        &mins,
        &maxs,
    );
    if !tr.start_solid && !tr.all_solid {
        p.origin = tr.end_pos;
    }
    try_player_move(world, p, params, dt);

    let mins = p.mins();
    let maxs = p.maxs();
    tr = world.trace(
        &p.origin,
        &[p.origin[0], p.origin[1] - STEP_HEIGHT, p.origin[2]],
        &mins,
        &maxs,
    );
    let stepped_onto_steep =
        tr.fraction < 1.0 && tr.normal.map_or(false, |n| n[1] < STANDABLE_NORMAL);
    if !tr.start_solid && !tr.all_solid && !stepped_onto_steep {
        p.origin = tr.end_pos;
    }

    if stepped_onto_steep {
        p.origin = down_origin;
        p.velocity = down_vel;
        return;
    }

    let dx_up = p.origin[0] - start_origin[0];
    let dz_up = p.origin[2] - start_origin[2];
    let dx_down = down_origin[0] - start_origin[0];
    let dz_down = down_origin[2] - start_origin[2];
    if dx_down * dx_down + dz_down * dz_down > dx_up * dx_up + dz_up * dz_up {
        p.origin = down_origin;
        p.velocity = down_vel;
    } else {
        // 保留抬升结果，但竖直速度借直接移动那一次的
        p.velocity[1] = down_vel[1];
    }
}

/// 贴地吸附：从 origin 沿 `−STEP_HEIGHT`(18 HU) 下探一次，若 `0 < fraction < 1`、非
/// `start_solid`、且命中面可站（`normal.y >= STANDABLE_NORMAL`）就把 origin 落到 `end_pos`。
///
/// 这是地面步进唯一的"贴地"手段（地面分支不施加重力）。`fraction > 0.0` 是硬条件：
/// 完全被挡（fraction == 0）时什么都不做。不写 `on_ground`、不碰速度。
fn stay_on_ground(world: &mut World, p: &mut Player) {
    let mins = p.mins();
    let maxs = p.maxs();
    let tr = world.trace(
        &p.origin,
        &[p.origin[0], p.origin[1] - STEP_HEIGHT, p.origin[2]],
        &mins,
        &maxs,
    );
    if tr.fraction > 0.0
        && tr.fraction < 1.0
        && !tr.start_solid
        && tr.normal.map_or(false, |n| n[1] >= STANDABLE_NORMAL)
    {
        p.origin = tr.end_pos;
    }
}

/// 落地判定（每 tick 一次，是 `on_ground` 与 `contact_ticks` 的唯一重算点）。
///
/// 先看上升：`velocity.y > NON_JUMP_VELOCITY`(180 HU/s) 时直接判为空中、`contact_ticks` 清零
/// 并返回 —— 正在上升就站不住任何东西（默认起跳初速 ≈ 302 会走这一支）。
///
/// 否则沿 `−GROUND_TRACE_DIST`(2 HU) 下探，命中可站面
/// （`fraction < 1.0 && !start_solid && normal.y >= STANDABLE_NORMAL`）时：
/// 置 `on_ground = true`、`contact_ticks` 自增、记下 `ground_normal`、把 origin 吸附到 `end_pos`、
/// 移除速度中指向地面的分量（`dot(velocity, n) < 0`）、`fall_velocity` 清零；
/// 若上一 tick 还在空中，再把 `ground_ticks_since_landing` 清 0 并快照 `landing_velocity`。
/// 没命中时置 `on_ground = false` 并把 `contact_ticks` 清零。
///
/// **贴坡滑行不算落地**：surf 面（`0.05 < n.y < 0.7`）不满足可站判据，滑行期间 `on_ground`
/// 为 false、`contact_ticks` 为 0 —— 这两个值正是传送检测的启用条件。
///
/// 副作用：写 `on_ground` / `contact_ticks` / `ground_normal` / `origin` / `velocity` /
/// `fall_velocity` / `ground_ticks_since_landing` / `landing_velocity`。
fn categorize_position(world: &mut World, p: &mut Player) {
    // 上升速度快于此值时不判落地（正在上升就站不住任何东西）
    if p.velocity[1] > NON_JUMP_VELOCITY {
        p.on_ground = false;
        p.contact_ticks = 0; // 上升 = 脱离接触（传送 gate 防跳跃误触）
        return;
    }
    let mins = p.mins();
    let maxs = p.maxs();
    let tr = world.trace(
        &p.origin,
        &[p.origin[0], p.origin[1] - GROUND_TRACE_DIST, p.origin[2]],
        &mins,
        &maxs,
    );
    // 接触计数：仅真正落地（可站面，normal.y >= STANDABLE_NORMAL）才累加。
    // 贴坡滑行的命中法线落在 0.05~0.7，不计接触——两个消费方（传送检测的 grounded 判据、
    // state_out 第 11 槽）要的都是"站在可站面上"，而不是"碰到任何面"。
    if tr.fraction < 1.0
        && !tr.start_solid
        && tr.normal.map_or(false, |n| n[1] >= STANDABLE_NORMAL)
    {
        let was_airborne = !p.on_ground;
        p.on_ground = true;
        p.contact_ticks = p.contact_ticks.saturating_add(1);
        p.ground_normal = tr.normal.unwrap_or([0.0, 1.0, 0.0]);
        p.origin = tr.end_pos;
        // 贴地投影：把速度中指向地面的分量（dot < 0）移掉。平地（n = (0,1,0)）等价于只清 vy；
        // 坡面则保留沿坡分量，于是贴坡加速不会被泄压、出坡瞬间速度仍带斜上分量。
        // 投影只发生在贴地判定的这一支里，try_player_move 的剪裁不碰它。
        let n = tr.normal.unwrap_or([0.0, 1.0, 0.0]);
        let ground_dot = p.velocity[0] * n[0] + p.velocity[1] * n[1] + p.velocity[2] * n[2];
        if ground_dot < 0.0 {
            p.velocity[0] -= n[0] * ground_dot;
            p.velocity[1] -= n[1] * ground_dot;
            p.velocity[2] -= n[2] * ground_dot;
        }
        if was_airborne {
            p.ground_ticks_since_landing = 0;
            // 落地瞬间的速度快照（只在 was_airborne 时写；对外只经 state_out 16-18 槽）
            p.landing_velocity = p.velocity;
        }
        p.fall_velocity = 0.0;
    } else {
        p.on_ground = false;
        p.contact_ticks = 0;
    }
}

/// `check_stuck` 的挤出探测方向（10 个），数组顺序就是优先级：
/// 先上（+y），再 ±x / ±z，再四个水平对角，最后才是向下（−y）。
/// 四个对角向量**没有归一化**（模长 √2），所以同一 `dist` 下它们的实际位移比轴向大 41%。
const STUCK_DIRS: [[f64; 3]; 10] = [
    [0.0, 1.0, 0.0],
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
    [1.0, 0.0, 1.0],
    [-1.0, 0.0, 1.0],
    [1.0, 0.0, -1.0],
    [-1.0, 0.0, -1.0],
    [0.0, -1.0, 0.0],
];

/// 卡死挤出：位置已处于实心内时就近找一个空闲点，返回"是否彻底卡死"。
///
/// 先用**当前姿态**箱判定 origin 是否空闲（空闲即 `stuck_ticks = 0`、返回 false）；
/// 否则按 `dist ∈ {1, 2, 4, 8, 16, 34}`（先近后远）× `STUCK_DIRS`（顺序见其文档）共 60 个
/// 候选点逐个试 `is_position_free`，命中即把 origin 挪过去并返回 false。
///
/// 全部失败才算卡死：`stuck_ticks` 自增、速度清零、返回 true —— 调用方（`player_tick`）
/// 据此跳过本 tick 的全部移动与落地判定。
///
/// 副作用：写 `p.origin`（挤成功时）、`p.stuck_ticks`、`p.velocity`（失败时）。
fn check_stuck(world: &mut World, p: &mut Player) -> bool {
    let mins = p.mins();
    let maxs = p.maxs();
    if world.is_position_free(&p.origin, &mins, &maxs) {
        p.stuck_ticks = 0;
        return false;
    }
    for dist in [1, 2, 4, 8, 16, 34] {
        for dir in STUCK_DIRS {
            let tmp = [
                p.origin[0] + dir[0] * dist as f64,
                p.origin[1] + dir[1] * dist as f64,
                p.origin[2] + dir[2] * dist as f64,
            ];
            if world.is_position_free(&tmp, &mins, &maxs) {
                p.origin = tmp;
                p.stuck_ticks = 0;
                return false;
            }
        }
    }
    p.stuck_ticks += 1;
    p.velocity = [0.0, 0.0, 0.0];
    true
}

/// 冻结检测：有速度却没位移时按 tick 累计，连续 6 tick 才把速度清零。
///
/// 判据（三条同时成立）：不在可站面上（`!on_ground`）、3D 速率 > 150 HU/s、
/// 相对 `prev_origin` 的位移 < 0.05 HU。任一不成立就把 `blocked_ticks` 归零。
///
/// 位移是"本 tick 开头快照的 `prev_origin`"与"当前 origin"之差，所以 `respawn` /
/// `apply_teleport` / `noclip_step` 改写 `prev_origin` 的那一帧，这里的位移口径会跟着变。
/// 副作用：写 `p.blocked_ticks`，累计到 6 时再写 `p.velocity`（清零）。
fn detect_blocked_move(p: &mut Player) {
    let speed = length_sq(&p.velocity).sqrt();
    let dx = p.origin[0] - p.prev_origin[0];
    let dy = p.origin[1] - p.prev_origin[1];
    let dz = p.origin[2] - p.prev_origin[2];
    let moved = (dx * dx + dy * dy + dz * dz).sqrt();

    // 连续 6 tick 才归零：给贴面推开（PUSH_OUT）留收敛时间，避免单帧误清速度
    if !p.on_ground && speed > 150.0 && moved < 0.05 {
        p.blocked_ticks += 1;
        if p.blocked_ticks >= 6 {
            p.velocity = [0.0, 0.0, 0.0];
            p.blocked_ticks = 0;
        }
    } else {
        p.blocked_ticks = 0;
    }
}

// -- WalkMove / AirMove ------------------------------------------------------

/// 地面移动：摩擦 → 加速 → 位移 → 吸附。
///
/// 顺序固定：`apply_friction` → `compute_wish` → `accelerate` →（速度几乎为零时，
/// `length_sq < 1e-6`，直接清零并返回，跳过位移与吸附）→ `step_move` → `stay_on_ground`。
///
/// **不含竖直重力**：贴地完全靠 `stay_on_ground` 的下探吸附维持；
/// 也不判落地（那是 `player_tick` 之后的 `categorize_position`）。
fn walk_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64) {
    let mut wish_dir = [0.0, 0.0, 0.0];
    apply_friction(&mut p.velocity, params.friction, params.stop_speed, dt);

    let wishspeed = compute_wish(p, params, &mut wish_dir);
    accelerate(&mut p.velocity, &wish_dir, wishspeed, params.accelerate, dt);

    if length_sq(&p.velocity) < 1e-6 {
        p.velocity = [0.0, 0.0, 0.0];
        return;
    }

    step_move(world, p, params, dt);
    stay_on_ground(world, p);
}

/// 空中移动：加速 → 前后各半重力 → 扫掠位移。
///
/// 重力在 `try_player_move` **前后各施加 `−0.5 × gravity × dt`**，合计每 tick `−gravity × dt`；
/// 分成两半是为了让竖直分量在碰撞剪裁之后立刻被修正。
/// 加速走 `air_accelerate`（addspeed 一侧的 30 HU/s 钳制是 bhop 的核心）。
///
/// 若位移中置位了 `surfing`，就把 `surfed_since_grounded` 置 true。
/// 不做：不调 `stay_on_ground` / `step_move`、不判落地、不设空中速度总上限。
fn air_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64) {
    let mut wish_dir = [0.0, 0.0, 0.0];
    let wishspeed = compute_wish(p, params, &mut wish_dir);
    air_accelerate(
        &mut p.velocity,
        &wish_dir,
        wishspeed,
        params.air_accelerate,
        dt,
    );

    p.velocity[1] -= 0.5 * params.gravity * dt; // 移动前先施加半重力
    try_player_move(world, p, params, dt);
    p.velocity[1] -= 0.5 * params.gravity * dt; // 移动后再施加半重力

    if p.surfing {
        p.surfed_since_grounded = true;
    }
    // 本函数不设速度总上限：唯一的钳制来自 air_accelerate 的 AIR_SPEED_CAP（addspeed 一侧）
}

// -- 主 tick ----------------------------------------------------------------

/// 覆盖四组碰撞箱（HU）：站立与蹲的 mins 相同（`[−half_width, 0, −half_width]`，箱底贴 origin），
/// 只有 maxs 的高度不同（`stand_height` / `duck_height`）。
///
/// 调用点两处：`create_player`（按 `params.hull_*` 初始化）与 `src/phys/mod.rs` 的
/// `PhysWorld::set_hull`。**立即生效且不做校验**：不移动 origin、不检查新箱是否与几何相交 ——
/// 若新箱体侵入实体，要等下一 tick 的 `check_stuck` 把玩家挤出来。
/// 当前姿态（`ducked`）不影响本函数：它总是把四组箱一起写好。
pub fn apply_hull(p: &mut Player, half_width: f64, stand_height: f64, duck_height: f64) {
    p.stand_mins = [-half_width, 0.0, -half_width];
    p.stand_maxs = [half_width, stand_height, half_width];
    p.duck_mins = [-half_width, 0.0, -half_width];
    p.duck_maxs = [half_width, duck_height, half_width];
}

/// 按 `params.hull_*` 造一个玩家：位置取 `origin`，速度 / yaw / pitch 全 0，
/// `on_ground = false`、`ground_normal = [0,1,0]`、`ducked = false`、`duck_frac = 0`、
/// `on_ladder = None`，各计时器与计数器归零；四组箱先置 `[0.0; 3]` 再由 `apply_hull` 写入；
/// `prev_origin = origin`。
///
/// `yaw` / `pitch` **不在参数里**：出生朝向由调用方事后赋（`src/phys/mod.rs` 的
/// `PhysWorld::build_world`）。
/// 只读 `params`，不碰世界、不判落地 —— 出生点是否悬空由第一个 tick 的 `categorize_position`
/// 决定。
pub fn create_player(origin: V3, params: &PhysParams) -> Player {
    let mut p = Player {
        origin,
        velocity: [0.0, 0.0, 0.0],
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
        landing_velocity: [0.0, 0.0, 0.0],
        stuck_ticks: 0,
        blocked_ticks: 0,
        input: InputState::default(),
        stand_mins: [0.0; 3],
        stand_maxs: [0.0; 3],
        duck_mins: [0.0; 3],
        duck_maxs: [0.0; 3],
        prev_origin: origin,
        prev_speed: 0.0,
    };
    apply_hull(
        &mut p,
        params.hull_half_width,
        params.hull_stand_height,
        params.hull_duck_height,
    );
    p
}

/// 单个固定步长的物理推进（主线程预测实例与 Worker 权威实例共用这一条）。
///
/// 顺序（**无循环、无子步** —— 一次调用 = 一步）：
/// ① 快照 `prev_origin` / `prev_speed`；② 清 `input.reset` 标志；③ `ladder_cooldown` 递减；
/// ④ `update_duck`；⑤ `check_stuck` —— **返回 true 就跳过 ⑥⑦⑧**；
/// ⑥ 梯子分支（`check_ladder` → `ladder_move`），否则 `check_jump` + 地面（`walk_move`）或
/// 空中（`air_move`）+ `categorize_position`；⑦ `detect_blocked_move`；
/// ⑧ `land_punch` 衰减、`old_jump` 记录、`duck_frac` 更新。
///
/// `dt` 由调用方给定：本函数不累加时间、不补步、不做固定步长节流；调用方按固定步长
/// 反复调用（`src/phys/mod.rs` 的 `step_core` 每步一次）。
///
/// **不含**传送检测、掉落死亡与 `reset` 键重生 —— 三者在 `src/phys/mod.rs` 的 `step_core`
/// 里执行，且排在调用本函数**之前**；`PhysWorld::predict` 路径没有这三步，
/// 所以按 `reset` 在预测线上只清标志、不重生。
///
/// 副作用：几乎整个 `Player` 都会被写（位置、速度、姿态、各计时器与计数器）；
/// `World` 只被读取（`trace` / `is_position_free` / `ladder_at`）。
pub fn player_tick(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64) {
    p.prev_origin = p.origin;
    p.prev_speed = p.speed_3d();

    if p.input.reset {
        // reset 由 PhysWorld 处理（需要 spawn 位置），此处仅清标志
        p.input.reset = false;
    }

    if p.ladder_cooldown > 0.0 {
        p.ladder_cooldown -= dt;
    }
    update_duck(world, p);

    if !check_stuck(world, p) {
        let ladder = check_ladder(world, p);
        if let Some(l) = ladder {
            ladder_move(world, p, params, dt, l);
        } else {
            p.on_ladder = None;
            check_jump(p, params);
            if p.on_ground {
                walk_move(world, p, params, dt);
                p.ground_ticks_since_landing += 1;
            } else {
                p.fall_velocity = -p.velocity[1];
                air_move(world, p, params, dt);
            }
            categorize_position(world, p);
        }
    }

    detect_blocked_move(p);

    p.land_punch *= (1.0 - 10.0 * dt).max(0.0);
    p.old_jump = p.input.jump;

    // 蹲下视角高度插值：**空中与落地当帧即时置位**（收脚 18 HU 与眼高变化同帧完成，轨迹
    // 无台阶；落地当帧直接给蹲姿视角）。**仅地面持续站/蹲**按 DUCK_LERP_TIME 线性渐变：
    // 每 tick 走 dt / DUCK_LERP_TIME，且不超过剩余距离。
    let target = if p.ducked { 1.0 } else { 0.0 };
    if !p.on_ground || p.ground_ticks_since_landing == 0 {
        p.duck_frac = target;
    } else {
        let rate = dt / DUCK_LERP_TIME;
        let delta = (target - p.duck_frac).signum() * rate.min((target - p.duck_frac).abs());
        p.duck_frac += delta;
    }
}
