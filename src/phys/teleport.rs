//! 传送检测（Rust 移植自 TS TeleportManager）。
//!
//! 触发检测：trigger_teleport 的几何范围由 model *N 指向的 brush 凸包平面定义
//! （WASM parse_teleports 已输出 model_planes，法线朝外 Y-up）；凸包平面夹取
//! 判定，无 planes 回退 AABB。
//!
//! **检测语义（2026-08-09 用户定调，最终版）**：
//! - **A 路径**（任意状态：落地/空中/半空）：玩家竖直线段 [脚底, 脚底+身高]
//!   与 trigger 凸包区间相交（XZ 受凸包竖直平面约束；**仅"落地 && 斜面"时
//!   脚底允许高于凸包顶 64**——跨斜面 origin 提升，其余 gap=0）；
//! - **B 路径**（仅落地启用）：脚底往下 **8** 单位区间与凸包相交；
//! - **滑行（surfing）不触发**；冷却 0.5s 防重复。
//! 死亡判定并入：玩家 Y < death_y 阈值 → 回退到初始出生点。

use super::world::V3;

/// 触发冷却时间（秒），防止同一触发器连续 tick 反复触发。
const TRIGGER_COOLDOWN: f64 = 0.5;

/// 落地后脚底往下探测深度（units）：**8**——传送区域贴合玩家所站表面
/// （2067 凸包贴表面 0.5、1240 贴 0.2——A 路径直接触发）；8 仅作浮点/
/// 微小 gap 容差，防"传送区域埋在表面下方深处"的深下探误触。
const FOOT_PROBE_DEPTH: f64 = 8.0;

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

/// 传送管理器（A 进入区域 + B 落地脚底 8 下探双路径检测）。
#[derive(Clone, Debug, Default)]
pub struct TeleportManager {
    pub triggers: Vec<TeleportTrigger>,
    pub destinations: Vec<TeleportDestination>,
    cooldown: f64,
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
        })
    }

    /// 每 tick 检测：返回触发目标（若触发），否则 None。
    /// `predict` 模式不检测传送（预测只填充中间帧，权威每帧校正）。
    ///
    /// **双路径检测（2026-08-09 用户定调，最终版）**：
    /// - **A. 进入传送区域**（任何状态：落地/空中/半空/走过）：`in_trigger_zone`
    ///   竖直线段 [脚底, 脚底+身高] 与凸包区间相交（XZ 受凸包竖直平面约束；
    ///   **gap = 落地 && 斜面 ? 64 : 0**——跨斜面 origin 提升，空中/平面 0）→ 触发；
    /// - **B. 落地脚底检测**（**落地才启用**，非触发事件本身）：落地时检测
    ///   **脚底往下 8 单位区间**（`probe_below_foot`）与 trigger 相交 → 触发。
    /// **滑行（surfing）不触发**；触发后 0.5s 冷却防重复。
    pub fn check(
        &mut self,
        pos: &V3,
        ground_ticks: u32,
        _gate_ticks: u32,
        dt: f64,
        predict: bool,
        surfing: bool,
        body_top: f64,
    ) -> Option<TeleportDestination> {
        if predict {
            return None;
        }
        if self.cooldown > 0.0 {
            self.cooldown -= dt;
            return None;
        }
        // 滑行（surfing）不触发传送（贴坡滑行不算进入传送区域）
        if surfing {
            return None;
        }
        let grounded = ground_ticks > 0;

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
            // A. 进入传送区域：身体线段与凸包相交（gap 仅斜面+落地生效；
            //    空中严格相交——跳入区域才触发）
            if in_trigger_zone(pos, body_top, t, grounded) {
                self.cooldown = TRIGGER_COOLDOWN;
                return self.destinations.get(t.dest_index as usize).cloned();
            }
            // B. 落地时脚底往下探测（落地是检测启用条件，非触发本身）
            if grounded && probe_below_foot(pos, t) {
                self.cooldown = TRIGGER_COOLDOWN;
                return self.destinations.get(t.dest_index as usize).cloned();
            }
        }
        None
    }

    /// 传送后重置（cooldown 由调用方 reset_cooldown 处理；无 inside 边沿状态）。
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

/// 落地脚底检测（B 路径）：**脚底往下 FOOT_PROBE_DEPTH（8）的区间**
/// [pos.y-8, pos.y] 与 trigger 相交（**区间夹取，不依赖离散采样**）。
/// 凸包平面夹取 > AABB 回退。
fn probe_below_foot(pos: &V3, t: &TeleportTrigger) -> bool {
    let mut lo = f64::NEG_INFINITY;
    let mut hi = f64::INFINITY;
    let mut has_planes = false;
    for p in &t.planes {
        has_planes = true;
        // 竖直线 x,z 固定：n1*y = d - n0*x - n2*z
        let rhs = p[3] - p[0] * pos[0] - p[2] * pos[2];
        if p[1].abs() < 1e-9 {
            // 竖直平面：XZ 必须在内侧（rhs = d-n0*x-n2*z ≥ 0）
            if rhs < -0.001 {
                return false;
            }
            continue;
        }
        let yc = rhs / p[1];
        if p[1] > 0.0 {
            hi = hi.min(yc);
        } else {
            lo = lo.max(yc);
        }
    }
    if !has_planes {
        // AABB 回退：下探区间与 AABB y 相交 + XZ 在 AABB 内
        let (Some(min), Some(max)) = (&t.mins, &t.maxs) else {
            return false;
        };
        return pos[0] >= min[0]
            && pos[0] <= max[0]
            && pos[2] >= min[2]
            && pos[2] <= max[2]
            && pos[1] - FOOT_PROBE_DEPTH <= max[1]
            && pos[1] >= min[1];
    }
    // 下探区间 [pos.y - FOOT_PROBE_DEPTH, pos.y] 与凸包区间 [lo, hi] 相交
    pos[1] - FOOT_PROBE_DEPTH <= hi && pos[1] >= lo
}

/// 玩家原点是否在 trigger 的 model AABB（mins/maxs）内。
/// **当前未用于传送触发判定**（历史遗留：AABB 判定曾把触发位置抬高到
/// "凸包与 AABB 之间的空区域"，已被凸包精确判定取代；保留供调试/回退）。
#[allow(dead_code)]
fn in_aabb(pos: &V3, t: &TeleportTrigger) -> bool {
    let (Some(min), Some(max)) = (&t.mins, &t.maxs) else {
        return false;
    };
    pos[0] >= min[0]
        && pos[0] <= max[0]
        && pos[1] >= min[1]
        && pos[1] <= max[1]
        && pos[2] >= min[2]
        && pos[2] <= max[2]
}

/// 贴面/跨斜面容差（units，**仅斜面 trigger + 落地状态生效**）：玩家物理
/// origin（碰撞箱底中心）在斜面上因跨斜面效应高出表面 8~44（半宽 16 ×
/// tan(坡角)）。落地时斜面传送允许脚底高于凸包顶 64（"站在斜面上"）；
/// **空中不因容差触发**（严格身体相交——跳入区域才触发）；**平面传送
/// 无容差**（不做任何抬高）。
const TRIGGER_FACE_GAP: f64 = 64.0;

/// trigger 是否为斜面传送（planes 中存在倾斜面，|ny| ∈ (0.05, 0.95)）。
fn is_sloped(t: &TeleportTrigger) -> bool {
    t.planes
        .iter()
        .any(|p| p[1].abs() > 0.05 && p[1].abs() < 0.95)
}

/// **A 路径区域判定**（"碰到传送区域才触发"）：玩家竖直线段
/// （[pos.y, pos.y+body_top]）与 trigger **凸包**相交——XZ 受凸包竖直平面
/// 约束（凸包 XZ 投影内）+ 垂直凸包区间相交。**gap 仅斜面 + 落地生效**
/// （落地站在斜面上允许脚底高于凸包顶 64，覆盖跨斜面 origin 提升）；
/// **空中 gap=0**（严格身体相交——跳入区域才触发，不因容差触发）；
/// **平面传送 gap=0**（不做抬高）。
fn in_trigger_zone(pos: &V3, body_top: f64, t: &TeleportTrigger, grounded: bool) -> bool {
    let mut lo = f64::NEG_INFINITY;
    let mut hi = f64::INFINITY;
    let mut has_planes = false;
    for p in &t.planes {
        has_planes = true;
        // 竖直线 x,z 固定：n1*y = d - n0*x - n2*z
        let rhs = p[3] - p[0] * pos[0] - p[2] * pos[2];
        if p[1].abs() < 1e-9 {
            // 竖直平面：XZ 必须在内侧（rhs = d-n0*x-n2*z ≥ 0）
            if rhs < -0.001 {
                return false;
            }
            continue;
        }
        let yc = rhs / p[1];
        if p[1] > 0.0 {
            hi = hi.min(yc);
        } else {
            lo = lo.max(yc);
        }
    }
    // gap：仅斜面 + 落地（跨斜面 origin 提升）；其余（平面/空中）= 0
    let gap = if grounded && is_sloped(t) {
        TRIGGER_FACE_GAP
    } else {
        0.0
    };
    if !has_planes {
        // AABB/球形回退：玩家竖直线段与 AABB 相交（含 gap）
        let (Some(min), Some(max)) = (&t.mins, &t.maxs) else {
            return false;
        };
        return pos[0] >= min[0]
            && pos[0] <= max[0]
            && pos[2] >= min[2]
            && pos[2] <= max[2]
            && pos[1] <= max[1] + gap
            && pos[1] + body_top >= min[1];
    }
    // 身体线段与凸包区间相交（脚底允许高于凸包顶 gap）
    pos[1] <= hi + gap && pos[1] + body_top >= lo
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
