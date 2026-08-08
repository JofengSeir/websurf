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

/// 传送管理器（start-touch + 落地脚底检测）。
#[derive(Clone, Debug, Default)]
pub struct TeleportManager {
    pub triggers: Vec<TeleportTrigger>,
    pub destinations: Vec<TeleportDestination>,
    cooldown: f64,
    /// 上一 tick 是否着地（落地边沿检测用：0→≥1 的上升沿 = 刚落地）。
    was_landed: bool,
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
            was_landed: false,
        })
    }

    /// 每 tick 检测：返回触发目标（若触发），否则 None。
    /// `predict` 模式（Worker-B）不检测传送（预测只填充中间帧，权威每帧校正）。
    ///
    /// **StartTouch 外→内边沿 + 落地脚底检测（2026-08-08 用户定调，双条件 OR）**：
    /// - **A. StartTouch 外→内边沿**：任何状态（空中/滑行/落地），玩家从
    ///   trigger 体积外跨入（false→true 跳变）即传送（CS:S 原生语义）
    /// - **B. 落地脚底检测**：刚落地（ground_ticks 0→≥1 上升沿）且脚底 2 单位
    ///   范围内存在传送区域 → 传送。注意这是"落地动作本身触发"，**不是**
    ///   "传送区域内落地后才触发"（后者是 start-touch-grounded 的停留语义，
    ///   会导致与斜面重合/位置相差不大的 trigger 不触发——玩家可能从区域
    ///   内部起飞再落地，StartTouch 无边沿可走）
    /// 探测点收窄到脚底 2 单位（TRIGGER_PROBES [0,2]）：只有脚底真正贴合
    /// trigger 才算 inside——高处/trigger 上方不误置 inside。
    pub fn check(&mut self, pos: &V3, ground_ticks: u32, _gate_ticks: u32, dt: f64, predict: bool) -> Option<TeleportDestination> {
        if predict {
            return None;
        }
        if self.cooldown > 0.0 {
            self.cooldown -= dt;
            // 冷却期间仍需更新 inside 状态，否则冷却结束后误触发 start-touch
            for t in &mut self.triggers {
                t.inside = probe_inside(pos, t); // 同主判定（脚底 2 单位）
            }
            return None;
        }

        // B. 落地脚底检测：刚落地（上升沿）且脚底贴 trigger → 传送
        let just_landed = ground_ticks > 0 && !self.was_landed;
        self.was_landed = ground_ticks > 0;
        if just_landed {
            for t in &mut self.triggers {
                if t.start_disabled {
                    continue;
                }
                if t.spawnflags != 0 && (t.spawnflags & 0x01) == 0 && (t.spawnflags & 0x40) == 0 {
                    continue;
                }
                if t.dest_index < 0 {
                    continue;
                }
                if (t.dest_index as usize) >= self.destinations.len() {
                    continue;
                }
                if probe_inside(pos, t) {
                    self.cooldown = TRIGGER_COOLDOWN;
                    return self.destinations.get(t.dest_index as usize).cloned();
                }
            }
        }

        // A. StartTouch 外→内边沿（任何状态）
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
            // 脚底 2 单位探测（0 点即 origin/脚底，2 点给贴合容差）
            let now_inside = probe_inside(pos, t);
            // StartTouch 边沿触发：仅 false→true 跳变（外→内）
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

/// trigger 探测深度列表（units）：**脚底 24 单位**（用户定调 2026-08-08）——
/// 覆盖与斜面重合/薄片 trigger 场景（trigger 顶面可能低于脚底 2~24 单位）。
/// 0 点即 origin/脚底，24 点给深度容差。
/// 注：StartTouch inside 判定加深后，高处/trigger 上方可能误置 inside——
/// 但落地脚底检测 B（落地边沿 + 脚底探测）兜底触发，不会漏。
const TRIGGER_PROBES: [f64; 2] = [0.0, 24.0];

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
