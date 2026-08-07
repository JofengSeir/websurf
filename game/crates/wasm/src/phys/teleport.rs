//! 传送检测（Rust 移植自 TS TeleportManager，仅保留 start-touch 模式）。
//!
//! 触发检测：trigger_teleport 的几何范围由 model *N 指向的 brush 凸包平面定义
//! （WASM parse_teleports 已输出 model_planes，法线朝外 Y-up）；优先凸包精确判定，
//! 无 planes 回退 AABB，再回退 origin 球形。StartTouch 边沿触发（CS:S 原生）：
//! 仅 false→true 跳变触发；传送后重置 inside 状态避免立即误触发。
//! 死亡判定并入：玩家 Y < death_y 阈值 → 回退到初始出生点。

use super::world::V3;

/// 触发冷却时间（秒），防止同一触发器连续 tick 反复触发。
const TRIGGER_COOLDOWN: f64 = 0.5;

/// 球形检测半径（HU），仅无 model AABB 时回退。
const TRIGGER_RADIUS: f64 = 64.0;

/// BSP yaw（方位角，顺时针）→ cs-movement yaw（逆时针）。cs_yaw = (270 - BSP_yaw) % 360。
fn bsp_yaw_to_cs_yaw(bsp_yaw: f64) -> f64 {
    let v = (270.0 - bsp_yaw) % 360.0;
    if v < 0.0 {
        v + 360.0
    } else {
        v
    }
}

/// 传送目标点。
#[derive(Clone, Debug)]
#[allow(dead_code)] // index/targetname 为 parse_teleports JSON 契约字段
pub struct TeleportDestination {
    pub index: usize,
    pub targetname: String,
    pub origin: V3,
    /// 转换后的 cs-movement yaw（度，逆时针，0 = 朝 -Z）。
    pub yaw: f64,
}

/// 传送触发器。
#[derive(Clone, Debug)]
#[allow(dead_code)] // index/classname/target/model 为 parse_teleports JSON 契约字段
pub struct TeleportTrigger {
    pub index: usize,
    pub classname: String,
    pub target: String,
    pub origin: V3,
    /// 凸包平面（法线朝外 Y-up；内部 dot(n,p) - dist <= 0）。空 = 无凸包。
    pub planes: Vec<[f64; 4]>, // [nx, ny, nz, dist] 紧凑 4 元组
    pub mins: Option<V3>,
    pub maxs: Option<V3>,
    pub dest_index: i32,
    pub spawnflags: u32,
    pub start_disabled: bool,
    pub inside: bool,
}

/// 传送管理器（start-touch 模式）。
#[derive(Clone, Debug, Default)]
pub struct TeleportManager {
    pub triggers: Vec<TeleportTrigger>,
    pub destinations: Vec<TeleportDestination>,
    cooldown: f64,
    /// 上一帧是否已过落地稳定门槛（用于跨门槛时重置 inside 边沿跟踪）。
    was_grounded: bool,
}

impl TeleportManager {
    /// 从 WASM parse_teleports JSON 构建（数组结构见 bsp-export-status.md §5）。
    pub fn from_json(json: &str) -> Result<Self, String> {
        // 复用 serde_json 解析；WasmTeleportReport 结构在此内联定义
        #[derive(serde::Deserialize)]
        struct WasmTeleport {
            index: usize,
            targetname: String,
            origin: [f64; 3],
            angles: [f64; 3],
        }
        #[derive(serde::Deserialize)]
        struct WasmTrigger {
            index: usize,
            classname: String,
            target: String,
            origin: [f64; 3],
            // model 字段不读（serde 默认忽略多余字段）；仅用 model_mins/maxs/planes
            model_mins: Option<[f64; 3]>,
            model_maxs: Option<[f64; 3]>,
            model_planes: Option<Vec<[f64; 4]>>,
            spawnflags: Option<u32>,
            start_disabled: Option<bool>,
        }
        #[derive(serde::Deserialize)]
        struct WasmTeleportReport {
            teleports: Vec<WasmTeleport>,
            triggers: Vec<WasmTrigger>,
        }

        let data: WasmTeleportReport =
            serde_json::from_str(json).map_err(|e| format!("teleport JSON 解析失败: {e}"))?;

        let mut destinations = Vec::with_capacity(data.teleports.len());
        for t in &data.teleports {
            destinations.push(TeleportDestination {
                index: t.index,
                targetname: t.targetname.clone(),
                origin: t.origin,
                yaw: bsp_yaw_to_cs_yaw(t.angles[1]),
            });
        }
        // 注意：值必须是数组下标（enumerate），不能用 d.index——后者是 BSP 实体
        // 原始编号（可能跳跃/非连续），当数组下标用会越界 → destinations.get 返回
        // None → 触发但不传送（check 已设 cooldown 但返回 None）。
        let dest_by_name: std::collections::HashMap<&str, usize> = destinations
            .iter()
            .enumerate()
            .map(|(i, d)| (d.targetname.as_str(), i))
            .collect();

        let mut triggers = Vec::with_capacity(data.triggers.len());
        for t in &data.triggers {
            let dest_idx = dest_by_name
                .get(t.target.as_str())
                .map(|&i| i as i32)
                .unwrap_or(-1);
            triggers.push(TeleportTrigger {
                index: t.index,
                classname: t.classname.clone(),
                target: t.target.clone(),
                origin: t.origin,
                planes: t
                    .model_planes
                    .clone()
                    .unwrap_or_default()
                    .iter()
                    .map(|p| [p[0], p[1], p[2], p[3]])
                    .collect(),
                mins: t.model_mins.map(|m| [m[0], m[1], m[2]]),
                maxs: t.model_maxs.map(|m| [m[0], m[1], m[2]]),
                dest_index: dest_idx,
                spawnflags: t.spawnflags.unwrap_or(1),
                start_disabled: t.start_disabled.unwrap_or(false),
                inside: false,
            });
        }

        Ok(TeleportManager {
            triggers,
            destinations,
            cooldown: 0.0,
            was_grounded: false,
        })
    }

    /// 每 tick 检测：返回触发目标（若触发），否则 None。
    /// `predict` 模式（Worker-B）不检测传送（预测只填充中间帧，权威每帧校正）。
    ///
    /// 落地稳定门槛（严格化）：`ground_ticks` 为"落地帧计数"——仅真正落地
    /// （可站面，法线 y >= STANDABLE_NORMAL，见 categorize_position）才累加；
    /// 斜面滑行（surfing）不算落地，滑行中 gate 恒不通过 → 不判定传送，避免
    /// 坡底 trigger 被多点下探命中而误传送。仅当落地持续 ≥ gate_ticks 帧后
    /// 才开始判定是否位于传送平面上；防止跳跃/下落轨迹"穿过"触发面瞬间误触。
    pub fn check(&mut self, pos: &V3, ground_ticks: u32, gate_ticks: u32, dt: f64, predict: bool) -> Option<TeleportDestination> {
        if predict {
            return None;
        }
        if self.cooldown > 0.0 {
            self.cooldown -= dt;
            // 冷却期间仍需更新 inside 状态，否则冷却结束后误触发 start-touch
            for t in &mut self.triggers {
                t.inside = probe_inside(pos, t); // 同主判定（多点下探）
            }
            return None;
        }

        // 落地稳定门槛：ground_ticks >= gate_ticks 才算"站定"（gate 默认 1）
        let grounded = ground_ticks >= gate_ticks;
        if grounded && !self.was_grounded {
            // 刚跨过门槛：重置全部 inside，重新从"未触碰"开始边沿跟踪——
            // 否则跳跃轨迹穿过触发面时 inside 已被置 true，落地后永不触发
            for t in &mut self.triggers {
                t.inside = false;
            }
        }
        self.was_grounded = grounded;
        if !grounded {
            // 未站定：不判定（也不污染 inside 状态）
            return None;
        }

        for t in &mut self.triggers {
            if t.start_disabled {
                continue;
            }
            // 跳过非玩家触发器（spawnflags 不含 Clients 0x01 且非 Everything 0x40）；
            // **显式 0 不跳过**——BSP 实体未配置 spawnflags 时导出为 0，应视为默认全客户端
            if t.spawnflags != 0 && (t.spawnflags & 0x01) == 0 && (t.spawnflags & 0x40) == 0 {
                continue;
            }
            if t.dest_index < 0 {
                continue; // 孤儿触发器
            }
            if (t.dest_index as usize) >= self.destinations.len() {
                continue; // 越界防御（dest_by_name 已用数组下标，正常不会触发）
            }
            // 多点下探（0~48）：覆盖落地瞬间脚底尚未完全贴合的 gap 与薄片 trigger；
            // gate（落地帧 ≥ gate_ticks）兜底——滑行/飞行中 ground_ticks=0 恒不判定
            let now_inside = probe_inside(pos, t);
            // StartTouch 边沿触发：仅 false→true 跳变
            let should_fire = now_inside && !t.inside;
            t.inside = now_inside;
            if should_fire {
                self.cooldown = TRIGGER_COOLDOWN;
                return self.destinations.get(t.dest_index as usize).cloned();
            }
        }
        None
    }

    /// 传送后重置全部 inside 状态（CS:S 行为：传送后须先离开再进入才触发）。
    pub fn on_teleported(&mut self) {
        for t in &mut self.triggers {
            t.inside = false;
        }
    }

    /// 重置冷却（手动传送 / respawn 时）。
    pub fn reset_cooldown(&mut self) {
        self.cooldown = 0.0;
    }
}

/// trigger 探测深度列表（units）：落地判定时玩家 origin 已被吸附贴地（GROUND_TRACE_DIST），
/// 点 0 即脚底、正常情况下已在 trigger 体积内；多下探点覆盖落地瞬间贴合前的微小 gap
/// 与薄片 trigger（surf_666 大量 h≤8 薄片）。滑行/飞行中不触发任何探测（gate 基于
/// 落地帧计数，滑行 surfing 不算落地——修复正常滑翔图坡底 trigger 滑行中被下探命中误传）。
const TRIGGER_PROBES: [f64; 7] = [0.0, 8.0, 16.0, 24.0, 32.0, 40.0, 48.0];

/// 多点探测：任一深度点在 trigger 内即视为 inside（覆盖滑行 gap 与薄片 trigger）。
fn probe_inside(pos: &V3, t: &TeleportTrigger) -> bool {
    for drop in TRIGGER_PROBES {
        let mut probe = *pos;
        probe[1] -= drop;
        if is_in_trigger(&probe, t) {
            return true;
        }
    }
    false
}

/// 玩家是否在 trigger 区域内：凸包平面精确判定 > AABB > 球形回退。
fn is_in_trigger(pos: &V3, t: &TeleportTrigger) -> bool {
    if !t.planes.is_empty() {
        for p in &t.planes {
            let d = p[0] * pos[0] + p[1] * pos[1] + p[2] * pos[2] - p[3];
            if d > 0.001 {
                return false;
            }
        }
        return true;
    }
    if let (Some(min), Some(max)) = (&t.mins, &t.maxs) {
        return pos[0] >= min[0]
            && pos[0] <= max[0]
            && pos[1] >= min[1]
            && pos[1] <= max[1]
            && pos[2] >= min[2]
            && pos[2] <= max[2];
    }
    let dx = pos[0] - t.origin[0];
    let dy = pos[1] - t.origin[1];
    let dz = pos[2] - t.origin[2];
    dx * dx + dy * dy + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS
}

/// 死亡判定：玩家 Y 低于阈值 → 返回重生到初始出生点。
/// 返回 Some(初始出生点) 表示死亡重生；None = 存活。
pub fn check_death(pos: &V3, death_y: f64, spawn: &V3) -> Option<V3> {
    if pos[1] < death_y {
        Some(*spawn)
    } else {
        None
    }
}
