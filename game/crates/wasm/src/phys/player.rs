//! 玩家移动语义（Rust 移植自 @unsurf/cs-movement 的 PlayerController 及全部移动子模块）。
//!
//! 将原 16 个 TS 文件（PlayerController / WalkMove / AirMove / Accelerate / AirAccelerate /
//! Friction / ClipVelocity / Jump / Duck / Ladder / StepMove / StuckCheck / BlockedMove /
//! CategorizePosition / StayOnGround / WishDir / CurrentMaxSpeed / TryPlayerMove / MouseInput）
//! 合并为单文件。默认配置下 Stamina/PerfBonus 恒为 disabled（代码路径永不进入），故省略其实现。
//!
//! 与 TS 版语义逐字一致（Y-up，Source 单位）。纯计算，无 wasm-bindgen 依赖。

use super::world::{LadderVolume, V3, World};

// ---------------------------------------------------------------------------
// 常量（原 constants.ts + 各 .config.ts）
// ---------------------------------------------------------------------------

pub const STANDABLE_NORMAL: f64 = 0.7; // normal.y >= 0.7 即地面；更陡 = surf
pub const GRAVITY: f64 = 800.0;
pub const RUN_SPEED: f64 = 250.0;
pub const WALK_SPEED: f64 = 130.0;
pub const CROUCH_SPEED: f64 = 85.0;

pub const AIR_ACCELERATE: f64 = 100.0;
pub const AIR_SPEED_CAP: f64 = 30.0;

pub const OVERBOUNCE_SURF: f64 = 1.0;
pub const OVERBOUNCE_DEFAULT: f64 = 1.001;

pub const M_YAW: f64 = 0.022;
pub const PITCH_CLAMP: f64 = 89.0;

pub const DEFAULT_HULL_HALF_WIDTH: f64 = 16.0;
pub const DEFAULT_HULL_STAND_HEIGHT: f64 = 72.0;
pub const DEFAULT_HULL_DUCK_HEIGHT: f64 = 54.0;
pub const EYE_STAND: f64 = 64.09;
pub const EYE_DUCK: f64 = 46.04;
pub const DUCK_LERP_TIME: f64 = 0.2;

pub const JUMP_HEIGHT: f64 = 57.0;
pub const BHOP_MAX_SPEED_FACTOR: f64 = 1.1;

pub const LADDER_SPEED: f64 = 200.0;
pub const LADDER_JUMP_OFF_SPEED: f64 = 270.0;

pub const STEP_HEIGHT: f64 = 18.0;

pub const MAX_CLIP_PLANES: usize = 8;
pub const PUSH_OUT: f64 = 0.1;

pub const NON_JUMP_VELOCITY: f64 = 180.0;
pub const GROUND_TRACE_DIST: f64 = 2.0;

const DEG2RAD: f64 = std::f64::consts::PI / 180.0;

// ---------------------------------------------------------------------------
// 设置（原 Settings，收敛为物理必需项）
// ---------------------------------------------------------------------------

/// 可运行时调节的物理参数（面板 set_params / set_hull 写入）。
#[derive(Clone, Debug)]
pub struct PhysParams {
    pub gravity: f64,
    pub accelerate: f64,
    pub friction: f64,
    pub stop_speed: f64,
    pub jump_height: f64,
    pub air_accelerate: f64,
    pub run_speed: f64,
    pub walk_speed: f64,
    pub crouch_speed: f64,
    pub autobhop: bool,
    pub bhop_speed_clamp: bool,
    pub no_prestrafe: bool,
    pub sensitivity: f64,
    pub yaw_bind_speed: f64,
    /// noclip 自由视角移动速度（HU/s；默认 800 = 200×4 原行为，sprint 再 ×4）。
    pub noclip_speed: f64,
    /// 碰撞箱体型。
    pub hull_half_width: f64,
    pub hull_stand_height: f64,
    pub hull_duck_height: f64,
}

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
            no_prestrafe: true,
            sensitivity: 1.5,
            yaw_bind_speed: 210.0,
            noclip_speed: 800.0,
            hull_half_width: DEFAULT_HULL_HALF_WIDTH,
            hull_stand_height: DEFAULT_HULL_STAND_HEIGHT,
            hull_duck_height: DEFAULT_HULL_DUCK_HEIGHT,
        }
    }
}

// ---------------------------------------------------------------------------
// 输入与上下文
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
pub struct InputState {
    pub forward: bool,
    pub back: bool,
    pub left: bool,
    pub right: bool,
    pub jump: bool,
    pub duck: bool,
    pub walk: bool,
    pub reset: bool,
}

/// 玩家状态（每 tick 推进；tick 输出由调用方写入 SAB）。
#[derive(Clone, Debug)]
pub struct Player {
    pub origin: V3,
    pub velocity: V3,
    pub yaw: f64,   // 度；0 时面向 -Z
    pub pitch: f64, // 度

    pub on_ground: bool,
    pub ground_normal: V3,
    pub ducked: bool,
    pub duck_frac: f64, // 0 站立，1 蹲下（驱动视角插值）
    pub on_ladder: Option<LadderVolume>,
    pub surfing: bool,
    pub surfed_since_grounded: bool,

    pub land_punch: f64,
    pub old_jump: bool,
    pub ladder_cooldown: f64,
    pub fall_velocity: f64,
    pub ground_ticks_since_landing: u32,
    pub has_jumped_before: bool,
    pub landing_velocity: V3,
    pub stuck_ticks: u32,
    pub blocked_ticks: u32,

    pub input: InputState,

    // 碰撞箱（由 params.hull 派生）
    pub stand_mins: V3,
    pub stand_maxs: V3,
    pub duck_mins: V3,
    pub duck_maxs: V3,

    // 诊断（最小化：仅保留速度面板所需字段）
    pub prev_origin: V3,
    pub prev_speed: f64,
    pub contacts: Vec<String>,
}

impl Player {
    /// 当前姿态碰撞箱（ducked 用蹲箱）。
    pub fn mins(&self) -> V3 {
        if self.ducked {
            self.duck_mins
        } else {
            self.stand_mins
        }
    }
    pub fn maxs(&self) -> V3 {
        if self.ducked {
            self.duck_maxs
        } else {
            self.stand_maxs
        }
    }

    /// 视角高度（站立/蹲下按 duck_frac 插值）。
    pub fn eye_height(&self) -> f64 {
        let stand = EYE_STAND * (self.stand_maxs[1] / DEFAULT_HULL_STAND_HEIGHT);
        let duck = EYE_DUCK * (self.duck_maxs[1] / DEFAULT_HULL_DUCK_HEIGHT);
        stand + (duck - stand) * self.duck_frac
    }

    /// 水平速度（速度面板横向模式）。
    pub fn horizontal_speed(&self) -> f64 {
        (self.velocity[0] * self.velocity[0] + self.velocity[2] * self.velocity[2]).sqrt()
    }

    /// 3D 合速度（速度面板综合模式）。
    pub fn speed_3d(&self) -> f64 {
        (self.velocity[0] * self.velocity[0]
            + self.velocity[1] * self.velocity[1]
            + self.velocity[2] * self.velocity[2])
            .sqrt()
    }

    pub fn respawn(&mut self, spawn: &V3) {
        self.origin = *spawn;
        self.velocity = [0.0, 0.0, 0.0];
        self.on_ground = false;
        self.on_ladder = None;
        self.ducked = false;
        self.ground_ticks_since_landing = 0;
        self.has_jumped_before = false;
        self.surfed_since_grounded = false;
        self.landing_velocity = [0.0, 0.0, 0.0];
        self.prev_origin = *spawn;
        self.duck_frac = 0.0;
    }
}

// ---------------------------------------------------------------------------
// 移动语义（原各子模块函数，内联为自由函数，ctx = &mut Player + params）
// ---------------------------------------------------------------------------

#[inline]
fn dot(a: &V3, b: &V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross(a: &V3, b: &V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

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

#[inline]
fn length_sq(v: &V3) -> f64 {
    v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
}

// -- Accelerate / AirAccelerate / Friction / ClipVelocity --------------------

/// 地面加速（addspeed = wishspeed - dot(vel, wishdir) 决定地速上限）。
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

/// 空气加速（bhop/surf 核心公式，刻意不对称：addspeed 用钳制 wishspeed，
/// accelspeed 用未钳制 wishspeed）。
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

/// 地面摩擦（只消耗水平分量）。
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

/// 沿平面滑行速度（surf 用 1.0 保留速度，普通 1.001 防重穿）。
#[inline]
fn clip_velocity(vel: &mut V3, normal: &V3, overbounce: f64) {
    let backoff = dot(vel, normal) * overbounce;
    vel[0] -= normal[0] * backoff;
    vel[1] -= normal[1] * backoff;
    vel[2] -= normal[2] * backoff;
    // CS:GO 修正步：overbounce 1.0 时浮点误差残留垂直分量 → 再清一次
    let adjust = dot(vel, normal);
    if adjust < 0.0 {
        vel[0] -= normal[0] * adjust;
        vel[1] -= normal[1] * adjust;
        vel[2] -= normal[2] * adjust;
    }
}

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

fn current_max_speed(p: &Player, params: &PhysParams) -> f64 {
    let speed = if p.ducked {
        params.crouch_speed
    } else if p.input.walk {
        params.walk_speed
    } else {
        params.run_speed
    };
    speed
}

/// 由 WASD + yaw 计算水平期望方向写入 wish_dir，返回 wishspeed。
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

/// Source 的 TryPlayerMove：扫掠，对本 tick 触及的每个平面剪裁速度，最多 4 次 bump。
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
        p.contacts.push(format!(
            "{:.2},{:.2},{:.2}@{:.2}",
            n[0], n[1], n[2], tr.fraction
        ));

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
            // 单平面剪裁均无效：≥3 用平均法线，2 沿交线，退化回退单平面
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

fn check_jump(p: &mut Player, params: &PhysParams) {
    if !p.on_ground {
        return;
    }
    if !p.input.jump {
        return;
    }
    // 原版行为：必须落地时按下；Autobhop 跳过该检查
    if !params.autobhop && p.old_jump {
        return;
    }

    // sv_enablebunnyhopping 0：起跳速度钳制为 1.1 × maxspeed
    if params.bhop_speed_clamp {
        let max_scaled = current_max_speed(p, params) * BHOP_MAX_SPEED_FACTOR;
        let speed = p.horizontal_speed();
        if speed > max_scaled {
            let fraction = max_scaled / speed;
            p.velocity[0] *= fraction;
            p.velocity[2] *= fraction;
        }
    }

    // 完美连跳继承（perf.enabled 恒 false → 不进入；保留语义注释）
    let jump_velocity = (2.0 * params.gravity * params.jump_height).sqrt();
    p.velocity[1] = jump_velocity;
    p.on_ground = false;
    p.has_jumped_before = true;
    p.surfed_since_grounded = false;
}

// -- Duck --------------------------------------------------------------------

fn update_duck(world: &mut World, p: &mut Player) {
    let want = p.input.duck;
    if want && !p.ducked {
        p.ducked = true;
        if !p.on_ground {
            // 空中蹲下把脚收起、头部不动
            let delta = p.stand_maxs[1] - p.duck_maxs[1];
            let tmp = [p.origin[0], p.origin[1] + delta, p.origin[2]];
            if world.is_position_free(&tmp, &p.duck_mins, &p.duck_maxs) {
                p.origin[1] += delta;
            }
        }
    } else if !want && p.ducked {
        // tryUnduck
        if p.on_ground {
            if world.is_position_free(&p.origin, &p.stand_mins, &p.stand_maxs) {
                p.ducked = false;
            }
            return;
        }
        let delta = p.stand_maxs[1] - p.duck_maxs[1];
        let tmp = [p.origin[0], p.origin[1] - delta, p.origin[2]];
        if world.is_position_free(&tmp, &p.stand_mins, &p.stand_maxs) {
            p.origin[1] -= delta;
            p.ducked = false;
        } else if world.is_position_free(&p.origin, &p.stand_mins, &p.stand_maxs) {
            p.ducked = false;
        }
    }
}

// -- Ladder ------------------------------------------------------------------

fn check_ladder(world: &World, p: &Player) -> Option<LadderVolume> {
    if p.ladder_cooldown > 0.0 {
        return None;
    }
    let mins = p.mins();
    let maxs = p.maxs();
    let ladder = world.ladder_at(&p.origin, &mins, &maxs);
    let ladder = ladder?;
    if p.on_ladder.is_some() {
        return Some(ladder.clone()); // 已在梯上——保持
    }
    // 仅在空中、或主动走向梯子时抓住
    if !p.on_ground {
        return Some(ladder.clone());
    }
    let yaw_rad = p.yaw * DEG2RAD;
    let facing_dot = (-yaw_rad.sin()) * (-ladder.facing[0]) + (-yaw_rad.cos()) * (-ladder.facing[2]);
    if p.input.forward && facing_dot > 0.3 {
        return Some(ladder.clone());
    }
    None
}

fn ladder_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64, ladder: &LadderVolume) {
    p.on_ladder = Some(ladder.clone());
    p.on_ground = false;
    p.fall_velocity = 0.0;

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

    // 每个输入轴贡献其完整的攀爬速度（不归一化，同 Source——fastclimb 原理）
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
        // 保留抬升结果，但采用直接移动的垂直速度（同 Source）
        p.velocity[1] = down_vel[1];
    }
}

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

fn categorize_position(world: &mut World, p: &mut Player) {
    // 上升速度快于此值，不可能"站"在任何物体上
    if p.velocity[1] > NON_JUMP_VELOCITY {
        p.on_ground = false;
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
    if tr.fraction < 1.0
        && !tr.start_solid
        && tr.normal.map_or(false, |n| n[1] >= STANDABLE_NORMAL)
    {
        let was_airborne = !p.on_ground;
        p.on_ground = true;
        p.ground_normal = tr.normal.unwrap_or([0.0, 1.0, 0.0]);
        p.origin = tr.end_pos;
        if was_airborne {
            p.ground_ticks_since_landing = 0;
            // 落地瞬间速度快照（完美重跳继承；perf.enabled=false 时不消费，保留语义）
            p.landing_velocity = p.velocity;
        }
        p.fall_velocity = 0.0;
    } else {
        p.on_ground = false;
    }
}

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

/// Source 风格 CheckStuck：就近挤出到空闲位置；彻底卡死才返回 true（清零速度）。
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

/// 冻结检测：大速度而位置逐 tick 无变化 → 卡在 clip 循环，清空速度。
fn detect_blocked_move(p: &mut Player) {
    let speed = length_sq(&p.velocity).sqrt();
    let dx = p.origin[0] - p.prev_origin[0];
    let dy = p.origin[1] - p.prev_origin[1];
    let dz = p.origin[2] - p.prev_origin[2];
    let moved = (dx * dx + dy * dy + dz * dz).sqrt();

    // Blocked = 真正钉死：连续 6 tick 归零（贴面推开留收敛时间）
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

fn walk_move(world: &mut World, p: &mut Player, params: &PhysParams, dt: f64) {
    let mut wish_dir = [0.0, 0.0, 0.0];
    p.velocity[1] = 0.0;
    apply_friction(&mut p.velocity, params.friction, params.stop_speed, dt);

    let wishspeed = compute_wish(p, params, &mut wish_dir);
    accelerate(&mut p.velocity, &wish_dir, wishspeed, params.accelerate, dt);
    p.velocity[1] = 0.0;

    // nopre：落地速度硬钳到 runSpeed
    if params.no_prestrafe {
        let cap = current_max_speed(p, params);
        if wishspeed > 0.0 && p.ground_ticks_since_landing > 0 {
            let proj = p.velocity[0] * wish_dir[0] + p.velocity[2] * wish_dir[2];
            if proj > cap {
                let scale = cap / proj;
                p.velocity[0] *= scale;
                p.velocity[2] *= scale;
            }
        } else {
            let speed = p.horizontal_speed();
            if speed > cap {
                let scale = cap / speed;
                p.velocity[0] *= scale;
                p.velocity[2] *= scale;
            }
        }
    }

    if length_sq(&p.velocity) < 1e-6 {
        p.velocity = [0.0, 0.0, 0.0];
        return;
    }

    step_move(world, p, params, dt);
    stay_on_ground(world, p);
}

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
    // perf.enabled 恒 false → 无空中速度上限
}

// -- 主 tick ----------------------------------------------------------------

/// 更新碰撞箱体型（set_hull 调用；立即生效）。
pub fn apply_hull(p: &mut Player, half_width: f64, stand_height: f64, duck_height: f64) {
    p.stand_mins = [-half_width, 0.0, -half_width];
    p.stand_maxs = [half_width, stand_height, half_width];
    p.duck_mins = [-half_width, 0.0, -half_width];
    p.duck_maxs = [half_width, duck_height, half_width];
}

/// 创建玩家（按 params 初始化碰撞箱）。
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
        contacts: Vec::new(),
    };
    apply_hull(
        &mut p,
        params.hull_half_width,
        params.hull_stand_height,
        params.hull_duck_height,
    );
    p
}

/// 单个固定步长物理 tick（权威 Worker-A 与预测 Worker-B 共用；predict 仅需禁用传送副作用，
/// 本函数不含传送逻辑——传送由 PhysWorld 层在 tick 之间执行）。
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
            ladder_move(world, p, params, dt, &l);
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

    // 蹲下视角高度插值
    let target = if p.ducked { 1.0 } else { 0.0 };
    let rate = dt / DUCK_LERP_TIME;
    let delta = (target - p.duck_frac).signum() * rate.min((target - p.duck_frac).abs());
    p.duck_frac += delta;

    p.contacts.clear();
}
