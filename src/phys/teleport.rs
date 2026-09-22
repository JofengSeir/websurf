//! 传送触发检测 + 掉落死亡判定：本 crate 里唯一会把玩家瞬移走的判定来源。
//!
//! 上下游位置：
//! - 上游（建表）：`src/phys/mod.rs` 的 `PhysWorld::build_world` 调 `TeleportManager::from_json`，
//!   吃的是各工程 wasm 层 `BspProcessor::parse_teleports`
//!   （`apps/game/crates/wasm/src/lib.rs`）产出的 JSON —— trigger 的凸包平面与
//!   AABB 都在那段 JSON 里。
//! - 下游（每步消费）：`src/phys/mod.rs` 的 `PhysWorld::step_core` 在非 noclip 分支里先调
//!   `check`，命中后组装事件并依次走 `apply_teleport`、`on_teleported`、`reset_cooldown`；
//!   随后是 `check_death`。`check` 自己**不移动玩家**，落点由调用方写入。
//!
//! 触发几何：`TeleportTrigger.planes` 是 `[nx, ny, nz, dist]` 四元组，法线朝外、Y-up，
//! 凸包内部 = `dot(n, p) - dist <= 0`；`planes` 为空时判定回退到 `mins` / `maxs` 的 AABB。
//! 一个 trigger 对应模型的一个 brush 区域，`from_json` 把 `dest_index` 指向
//! `destinations` 的**数组下标**（没有同名目标则为 -1）。
//!
//! 检测语义（三条，都在 `check` 里）：
//! - **A 路径**（`in_trigger_zone`，任何状态）：玩家竖直线段
//!   `[pos.y, pos.y + body_top]` 与凸包相交 —— XZ 由凸包的竖直平面约束
//!   （`|ny| < 1e-9` 的那些），Y 方向解出交区间 `[lo, hi]`；**仅"落地且斜面"时**脚底
//!   允许高于凸包顶 `TRIGGER_FACE_GAP`（64），其余 gap = 0。凸包全由竖直平面组成时
//!   `[lo, hi]` 是 `[-inf, +inf]`，即该 trigger 在 Y 方向不设限。
//! - **B 路径**（`probe_below_foot`，只有 `grounded` 才走）：脚底往下
//!   `FOOT_PROBE_DEPTH`（8）的区间 `[pos.y - 8, pos.y]` 与凸包区间相交；它不加 gap。
//! - 命中即写 `TRIGGER_COOLDOWN`（0.5 s）并返回目标点；冷却期内每 tick 递减 `dt`
//!   后直接返回 `None`。
//!
//! 三个容易读错的地方：
//! - 形参 `_gate_ticks` **完全不被使用**：`player::PhysParams::teleport_gate_ticks`
//!   字段存在（默认 3）、`src/phys/mod.rs` 的 `PhysWorld::set_params` 可写该键、
//!   同一文件的 `PhysWorld::step_core` 也确实把它传了进来，但函数体内零引用
//!   —— 改这个键不改变任何行为。
//! - `TeleportTrigger.inside` 不参与触发判定：它只在种子面接口里被读写。
//! - `spawnflags` 为 0 的 trigger **不被跳过**（跳过条件要求"值非 0 且 0x01 / 0x40 两位
//!   都不含"）；上游在字段缺失时给的是 1（`apps/game/crates/wasm/src/lib.rs` 的
//!   `BspProcessor::parse_teleports`）。
//!
//! 其它导出面：`on_teleported`（把各 trigger 的 `inside` 清回 false，只有步内触发路径调）、
//! `reset_cooldown`（冷却清零）、`check_death`（掉落死亡），以及给 `phys::seed` 的四个
//! 通道（`seed_cooldown` / `cooldown_value` / `seed_trigger_inside` / `trigger_inside_vec`，
//! 调用点都在 `src/phys/seed.rs` 的 `extract_seed` / `apply_seed`）。文件私有的 `in_aabb` 无调用点。
//!
//! 边界：不做 BSP 解析、不发事件（`PhysEvent` 由 `PhysWorld` 组装）、不写玩家状态、
//! 不判落点是否悬空、不参与碰撞。
//!
//! 测试归属：本文件无 `#[test]`；`cargo test -p websurf-phys` 的 10 项来自
//! `p2_gate_tests`（4）与 `duck_surf_tests`（6），都不覆盖本文件。

use super::world::V3;

/// 触发后的冷却时长（秒）：命中时把 `cooldown` 置成它，之后每 tick 递减 `dt`。
/// 两个读点都在 `check` 的命中分支里；`reset_cooldown`（写 0.0）与 `seed_cooldown`
/// （写任意值）都不经它。
const TRIGGER_COOLDOWN: f64 = 0.5;

/// B 路径的下探深度（HU）：判定区间是 `[pos.y - FOOT_PROBE_DEPTH, pos.y]`，
/// 即"脚底往下 8 单位内碰到传送区就算踩上"。
/// 两个读点都在 `probe_below_foot`（凸包分支与 AABB 回退分支各一处）；A 路径不读它。
const FOOT_PROBE_DEPTH: f64 = 8.0;

/// BSP 实体 yaw（Source 角度）→ 本物理口径的 yaw：`wrap(bsp_yaw + 180)`。
///
/// 结果落在 `[0, 360)`：`%` 对负被除数保留负号，故再补一次 `+ 360`。
/// 例：180 → 0，270 → 90，-90 → 90。
///
/// 换算依据：BSP 导出走的轴映射 `[x, y, z] → [y, z, x]` 行列式为 +1，Source 前向
/// `(cos yaw, sin yaw)` 置换后是 `(sin yaw, cos yaw)`；而本物理里 `yaw = 0` 指 −Z
/// （移动与 noclip 的前向基都是 `(-sin, -cos)` 的 x/z 分量），恒等式即 +180。
/// 同一换算在 TS 侧有一份独立实现：`src/ts-shared/phys/angles.ts` 的 `bspYawToCsYaw`
/// （同样 `+ 180` 后归一到 `[0, 360)`）。
fn bsp_yaw_to_cs_yaw(bsp_yaw: f64) -> f64 {
    let v = (bsp_yaw + 180.0) % 360.0;
    if v < 0.0 {
        v + 360.0
    } else {
        v
    }
}

/// 传送落点（`teleports[]` 的一项）：`origin` 已是 Y-up 世界坐标，`yaw` 已换算成本
/// 物理口径。`targetname` 供 `src/phys/mod.rs` 的 `PhysWorld::step_core` 填传送事件；
/// `index`（BSP 实体编号）当前工作区内无读取方。
#[derive(Clone, Debug)]
#[allow(dead_code)] // index/targetname 为 parse_teleports JSON 契约字段
pub struct TeleportDestination {
    pub index: usize,
    pub targetname: String,
    pub origin: V3,
    /// 换算后的 yaw（度，`[0, 360)`，0 = 朝 −Z），来源是 JSON 的 `angles[1]`。
    pub yaw: f64,
}

/// 传送触发器（`triggers[]` 的一项）：一条 = 模型的一个 brush 区域。
/// `planes` 非空时用凸包判定，为空时回退 `mins` / `maxs` 的 AABB。
#[derive(Clone, Debug)]
#[allow(dead_code)] // index/classname/target/model 为 parse_teleports JSON 契约字段
pub struct TeleportTrigger {
    /// BSP 实体编号：同一实体的多个区域共享同一个 `index`。当前无读取方。
    pub index: usize,
    /// 实体 classname。当前无读取方。
    pub classname: String,
    /// 目标实体名：`from_json` 用它查 `dest_index`，之后不再被读。
    pub target: String,
    /// 实体 origin（Y-up、HU）：当前无读取方（判定用的是 `planes` / `mins` / `maxs`）。
    pub origin: V3,
    /// 凸包平面（法线朝外、Y-up；内部 `dot(n,p) - dist <= 0`）。空 = 无凸包，
    /// 判定回退 AABB。
    /// 两处法线阈值：`|ny| < 1e-9` 视为竖直平面（只约束 XZ），
    /// `|ny| ∈ (0.05, 0.95)` 视为斜面（`is_sloped`，A 路径 gap 的启用条件）。
    pub planes: Vec<[f64; 4]>, // [nx, ny, nz, dist] 紧凑 4 元组
    /// 世界空间 AABB 下界（JSON 的 `model_mins`；缺失为 `None`）。
    pub mins: Option<V3>,
    /// 世界空间 AABB 上界（JSON 的 `model_maxs`；缺失为 `None`）。
    pub maxs: Option<V3>,
    /// `destinations` 的数组下标；-1 = 没有同名目标（孤儿 trigger，`check` 直接跳过）。
    pub dest_index: i32,
    /// 客户端位掩码：`check` 在"值非 0，且 0x01 与 0x40 两位都不含"时跳过该 trigger；
    /// JSON 缺该字段时 `from_json` 取 1。
    pub spawnflags: u32,
    /// true = 该 trigger 从不参与判定（`check` 的第一道 `continue`）；
    /// JSON 缺该字段时取 false。
    pub start_disabled: bool,
    /// 是否已进入过该区域。**没有任何判定读它**：写入点只有 `from_json` 的初值 false、
    /// `on_teleported` 的统一清零、以及种子面 `seed_trigger_inside`。
    pub inside: bool,
}

/// 一张地图的全部 trigger / destination，加一个共享的冷却计时器。
/// `triggers` / `destinations` 公开可读；`cooldown` 私有，写路径只有 `check`（置 0.5
/// 或递减）、`reset_cooldown`（写 0.0）、`seed_cooldown`（写任意值）三条。
#[derive(Clone, Debug, Default)]
pub struct TeleportManager {
    pub triggers: Vec<TeleportTrigger>,
    pub destinations: Vec<TeleportDestination>,
    /// 冷却剩余时间（秒）。负数也会出现：`check` 只在 `> 0.0` 时递减，越过后就一直保持
    /// 那个负值，直到下一次命中或 `reset_cooldown`。
    cooldown: f64,
}

impl TeleportManager {
    /// 从 wasm 层 `parse_teleports` 的 JSON 构建 trigger / destination 两张表。
    ///
    /// 输入顶层两个键：`teleports[]`（`index` / `targetname` / `origin` / `angles`）与
    /// `triggers[]`（`index` / `classname` / `target` / `origin` / `model_mins?` /
    /// `model_maxs?` / `model_planes?` / `spawnflags?` / `start_disabled?`）。
    /// 反序列化结构在此内联定义，**多余字段被 serde 忽略**（例如 trigger 的 `model`）；
    /// 缺字段的默认值：`model_planes` → 空（判定回退 AABB）、`spawnflags` → 1、
    /// `start_disabled` → false。
    ///
    /// 链接规则：`dest_by_name` 的键是 `targetname`、值是**数组下标**（`enumerate` 得到，
    /// 不是 BSP 实体的 `index` —— 后者是跳跃、非连续的编号，当数组下标会越界）；
    /// trigger 用 `target` 查表，查不到则 `dest_index = -1`。
    /// 同一个 `targetname` 出现多次时后者覆盖前者（HashMap 收集语义）。
    ///
    /// 参数：`json` 解析失败返回 `Err(String)`。返回值：两张表的顺序与 JSON 一致，
    /// `cooldown = 0.0`、所有 `inside = false`。
    /// 不做几何校验（凸包退化、AABB 颠倒都会按原值收下），也不校验 `target` 是否为空。
    pub fn from_json(json: &str) -> Result<Self, String> {
        // serde_json 直接解析；WasmTeleportReport 的字段结构在此内联定义
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
            // `model` 不出现在这里 = 不读该字段（serde 默认忽略多余键）；
            // 几何只认 model_mins / model_maxs / model_planes 三项
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
        // 值必须是数组下标（enumerate 得到），不能用 d.index —— 那是 BSP 实体原始编号，
        // 跳跃、非连续；当数组下标用会取到别的落点或越界。
        // 缺目标名的 trigger 在下面落到 dest_index = -1，由 check 直接跳过。
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

    /// 单步检测：命中就返回目标点（克隆），否则 `None`。**本函数不移动玩家**。
    ///
    /// 三道早退按固定顺序发生，顺序本身会影响可观测行为：
    /// ① `predict == true` → `None`（预测步不做传送判定）；
    /// ② `cooldown > 0.0` → 先 `cooldown -= dt` 再 `None` —— 冷却刚到期的那一 tick 同样
    ///    返回 `None`，且递减后可以为负；此后 `cooldown` 不再被本函数改动（`≤ 0` 不进该
    ///    分支），下一次命中或 `reset_cooldown` 才会改写它；
    /// ③ `surfing == true` → `None`（贴坡滑行不算进入传送区）。
    /// 随后取 `grounded = ground_ticks > 0`：它不是早退，只作 B 路径与 gap 的启用条件。
    ///
    /// 再逐个 trigger 过滤：`start_disabled`、`spawnflags` 非 0 且 0x01 / 0x40 两位都
    /// 不含、`dest_index < 0`（孤儿）、`dest_index` 越界；四道过滤都没跳过它，才试 A 路径
    /// （`in_trigger_zone`）、再试 B 路径（`grounded && probe_below_foot`）。
    /// 命中即写 `cooldown = TRIGGER_COOLDOWN`（0.5 s）并返回目标点克隆。
    ///
    /// 参数语义：`pos` 是玩家 origin（HU、Y-up），A / B 两条路径都读它；
    /// `ground_ticks` 唯一用途是算 `grounded`（调用方 `src/phys/mod.rs` 的
    /// `PhysWorld::step_core` 传的是 `Player::contact_ticks`）；`dt` 只用于递减冷却
    /// （秒，与调用方步长同单位）；
    /// `body_top` 是碰撞箱上沿相对 origin 的高度（站立 72 / 蹲伏 54，调用方传
    /// `Player::maxs()[1]`，同一处 `step_core`）。
    /// **`_gate_ticks` 是惰性形参**：函数体内零引用，详见模块头。
    ///
    /// 命中时 `destinations.get(...)` 恒为 `Some`：越界已在过滤阶段排除。
    /// 本函数不写 trigger 的 `inside`，不清速度、不改位置。
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
        // 滑行中不算进入传送区（`surfing` 由 player 侧碰撞法线 0.05 < n.y < 0.7 置位）
        if surfing {
            return None;
        }
        // 唯一的"落地"口径：调用方传进来的接触计数 > 0
        let grounded = ground_ticks > 0;

        for t in &mut self.triggers {
            if t.start_disabled {
                continue;
            }
            // 客户端掩码过滤：值非 0 且 0x01、0x40 两位都不含 → 该 trigger 对玩家不生效。
            // **值恰为 0 时不跳过**（0 绕过这一道过滤）；上游在键缺失或无法解析时给的是 1，
            // 所以 0 只来自实体上显式配置的 spawnflags=0。
            if t.spawnflags != 0 && (t.spawnflags & 0x01) == 0 && (t.spawnflags & 0x40) == 0 {
                continue;
            }
            if t.dest_index < 0 {
                continue; // 孤儿触发器
            }
            if (t.dest_index as usize) >= self.destinations.len() {
                continue; // 越界防御（dest_by_name 已用数组下标，正常不会触发）
            }
            // A 路径：整条身体线段与凸包相交（gap 只在"落地 + 斜面"时生效）
            if in_trigger_zone(pos, body_top, t, grounded) {
                self.cooldown = TRIGGER_COOLDOWN;
                return self.destinations.get(t.dest_index as usize).cloned();
            }
            // B 路径：落地才探测脚底下方（落地是启用条件，不是触发事件本身）
            if grounded && probe_below_foot(pos, t) {
                self.cooldown = TRIGGER_COOLDOWN;
                return self.destinations.get(t.dest_index as usize).cloned();
            }
        }
        None
    }

    /// 传送后的状态复位：把所有 trigger 的 `inside` 清回 false。
    /// **不碰 `cooldown`** —— 冷却清零由 `reset_cooldown` 负责，步内触发时两个都会被调到
    /// （同一处 `src/phys/mod.rs` 的 `PhysWorld::step_core`）。
    ///
    /// 唯一调用点是步内触发路径；`PhysWorld::teleport_to` / `teleport_to_spawn` 不走这里
    /// （它们只经 `apply_teleport` → `reset_cooldown`）。
    pub fn on_teleported(&mut self) {
        for t in &mut self.triggers {
            t.inside = false;
        }
    }

    /// 冷却清零（直接写 0.0，不做递减）。
    /// 调用点：步内触发传送后、掉落死亡后、`src/phys/mod.rs` 的 `PhysWorld::respawn` 与
    /// `PhysWorld::apply_teleport`。
    pub fn reset_cooldown(&mut self) {
        self.cooldown = 0.0;
    }

    // ======================================================================
    // 种子面通道：给 phys::seed 的整实例投影用（scratch 实例单向写入）。
    // 这里读写的两个字段都不参与 check 的判定，通道存在只为让状态投影完整。
    // ======================================================================

    /// 种子面：直接写私有字段 `cooldown`，不做范围校验（负值、超过 0.5 的值都原样收下）。
    /// 读取方是 `cooldown_value`，进出通道是 `seed::SeedState.teleport_cooldown`。
    ///
    /// **步进过程里这个值不会跨 tick 存活**：命中当 tick 就置 0.5，同一个 `step_core` 内
    /// `apply_teleport` 又会 `reset_cooldown` 写回 0.0；下一步 `check` 只在 `> 0.0` 时递减，
    /// 于是实例在两次 tick 之间读到的恒为 0。播种它只服务全量投影的字段完整性。
    pub fn seed_cooldown(&mut self, v: f64) {
        self.cooldown = v;
    }

    /// 种子面：读私有字段 `cooldown` 的当前值（`src/phys/seed.rs` 的 `extract_seed` 导出用）。
    /// 不做任何加工，冷却是负值也照样返回。
    pub fn cooldown_value(&self) -> f64 {
        self.cooldown
    }

    /// 种子面：按顺序逐 trigger 写 `inside` 位。`bits.len()` 必须等于 `self.triggers.len()`，
    /// 否则返回 `Err(String)` 且**一位都不写**（防错位播种）。
    /// 长度校验在调用链上出现两次：`src/phys/seed.rs` 的 `apply_seed` 先校验一次，
    /// 这里是第二次。
    pub fn seed_trigger_inside(&mut self, bits: &[bool]) -> Result<(), String> {
        if bits.len() != self.triggers.len() {
            return Err(format!(
                "set_state_ex: triggers_inside 长度 {} != 本实例 triggers {}",
                bits.len(),
                self.triggers.len()
            ));
        }
        for (t, &v) in self.triggers.iter_mut().zip(bits.iter()) {
            t.inside = v;
        }
        Ok(())
    }

    /// 种子面：按 `triggers` 的数组顺序导出全部 `inside` 位（`src/phys/seed.rs` 的
    /// `extract_seed` 用）。只读，不改任何状态。
    pub fn trigger_inside_vec(&self) -> Vec<bool> {
        self.triggers.iter().map(|t| t.inside).collect()
    }
}

/// B 路径：脚底往下 `FOOT_PROBE_DEPTH` 的**闭区间** `[pos.y - 8, pos.y]` 是否与 trigger
/// 相交。落地与否由调用方判定（`check` 只在 `grounded` 时调进来），本函数不看落地状态、
/// 也不加 `gap`。
///
/// 凸包分支：对每条平面解 `n1 * y = d - n0 * x - n2 * z`（竖直线段在 x / z 上是常数）。
/// `|n1| < 1e-9` 的竖直平面只约束 XZ —— `rhs < -0.001` 直接 `false`，否则 `continue`；
/// 其余平面收窄 Y 区间：`n1 > 0` 收 `hi`，`n1 < 0` 收 `lo`。初始 `lo = -inf`、`hi = +inf`，
/// 全为竖直平面时区间不设限。判定式 `pos.y - 8 <= hi && pos.y >= lo`，是纯区间夹取，
/// 不对线段做离散采样。
///
/// AABB 回退分支：`planes` 为空时用 `mins` / `maxs`（任一为 `None` 即 `false`）——
/// XZ 必须落在盒内（含边界），且下探区间与盒的 Y 区间相交。
///
/// 只读参数与 trigger：不写状态、不看 `spawnflags` / `start_disabled` / `inside`
/// （那些过滤在 `check`）。
fn probe_below_foot(pos: &V3, t: &TeleportTrigger) -> bool {
    let mut lo = f64::NEG_INFINITY;
    let mut hi = f64::INFINITY;
    let mut has_planes = false;
    for p in &t.planes {
        has_planes = true;
        // 竖直线段上 x、z 固定：n1 * y = d - n0*x - n2*z
        let rhs = p[3] - p[0] * pos[0] - p[2] * pos[2];
        if p[1].abs() < 1e-9 {
            // 竖直平面：只约束 XZ，必须在内侧（rhs = d - n0*x - n2*z ≥ 0），容差 0.001
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
        // 无凸包 → AABB 回退：XZ 落在盒内（含边界）且下探区间与盒的 Y 区间相交
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
    // 下探区间 [pos.y - FOOT_PROBE_DEPTH, pos.y] 与凸包 Y 区间 [lo, hi] 是否相交
    pos[1] - FOOT_PROBE_DEPTH <= hi && pos[1] >= lo
}

/// 点（玩家 origin）是否落在 trigger 的 model AABB 内（三轴均为闭区间，含边界；
/// `mins` / `maxs` 任一为 `None` 即 `false`）。
///
/// **当前工作区内零调用点**：`check` 的两条路径分别用 `in_trigger_zone` 与
/// `probe_below_foot`，两者都带凸包优先、AABB 回退的逻辑，本函数不在链路上；
/// `#[allow(dead_code)]` 就是为它挂的。
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

/// A 路径的贴面容差（HU，**只有"落地 + 斜面"才取这个值**，否则 gap = 0）：
/// 命中判据的上界放宽为 `hi + 64`，即脚底允许高于凸包顶 64。
///
/// 唯一读点在 `in_trigger_zone`；"是不是斜面"由 `is_sloped` 判定（凸包中存在
/// `|ny| ∈ (0.05, 0.95)` 的平面）。平面 trigger 与空中状态都不吃这个容差；
/// B 路径也不读它。
///
/// 需要它的原因：判据里的 Y 是玩家 origin（盒底中心，`mins[1] = 0`），站在斜面上时
/// origin 高于实际接触点；gap 固定为 0 时这类"已踩到区域"的落地判定会落空。
const TRIGGER_FACE_GAP: f64 = 64.0;

/// trigger 的凸包里是否含倾斜面：存在平面满足 `0.05 < |ny| < 0.95`。
/// 竖直平面（`|ny| ≈ 0`）与水平面（`|ny| ≈ 1`）都不算。
/// 只看 `planes`，不看 AABB 回退路径；唯一调用点是 `in_trigger_zone` 的 gap 条件。
fn is_sloped(t: &TeleportTrigger) -> bool {
    t.planes
        .iter()
        .any(|p| p[1].abs() > 0.05 && p[1].abs() < 0.95)
}

/// A 路径：玩家竖直线段 `[pos.y, pos.y + body_top]` 是否与 trigger 相交。
///
/// 凸包夹取与 `probe_below_foot` 共用同一套解法（竖直平面约束 XZ、其余平面收窄
/// Y 区间 `[lo, hi]`），差别只有两处：这里用整条身体线段（下界是
/// `pos.y + body_top`），并且按 `grounded && is_sloped(t)` 决定是否加
/// `TRIGGER_FACE_GAP` 的 gap。
///
/// gap **只加在判据上界**（`pos.y <= hi + gap`）；下界 `pos.y + body_top >= lo` 不加。
/// 因此"落地 + 斜面"时脚底能高于凸包顶 64，空中与平面 trigger 都是严格相交。
///
/// `planes` 为空时回退 AABB：XZ 在盒内（含边界）+ 身体线段与盒的 Y 区间相交
/// （上界同样含 gap）；`mins` / `maxs` 缺失返回 `false`。
///
/// 只读参数与 trigger：不写状态、不看 `spawnflags` / `start_disabled` / `inside`。
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
    // gap：只有"落地 + 斜面"两点同时成立才抬高；平面 trigger 与空中都是 0
    let gap = if grounded && is_sloped(t) {
        TRIGGER_FACE_GAP
    } else {
        0.0
    };
    if !has_planes {
        // 无凸包 → AABB 回退：XZ 落在盒内（含边界）且身体线段与盒的 Y 区间相交
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
    // 身体线段与凸包 Y 区间相交：gap 只放宽上界（脚底可高于凸包顶），下界不放松
    pos[1] <= hi + gap && pos[1] + body_top >= lo
}

/// 掉落死亡判定：`pos[1] < death_y` 时返回 `Some(*spawn)`，否则 `None`。
///
/// 严格小于（恰好等于阈值不算死亡）；返回的就是传进来的那个出生点。
/// 本函数不移动玩家、不改冷却、不发事件 —— `src/phys/mod.rs` 的 `PhysWorld::step_core`
/// 拿到 `Some` 之后自己置 `PhysEvent::Death`、调 `Player::respawn` 并复位冷却。
pub fn check_death(pos: &V3, death_y: f64, spawn: &V3) -> Option<V3> {
    if pos[1] < death_y {
        Some(*spawn)
    } else {
        None
    }
}
