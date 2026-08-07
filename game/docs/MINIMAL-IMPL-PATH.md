# WebSurf 最小化实现路径 v4（物理下沉 WASM + 主线程位置预测）

> 编制日期：2026-08-07（v4：**删除 Worker-B 预测，预测移入主线程渲染循环**，权威只同步角度/速度）。
> 依据 `docs/project-overview.md`、`docs/bsp-architecture.md`、`docs/bsp-export-status.md`、
> `docs/项目时序图.md`（v4 版），已对照 `src/`（79 .ts / 11,844 行）、`crates/wasm/src/`（30 .rs）核实。
>
> **v4 相对 v3 的变化**（2026-08-07 架构决策）：
> 1. **删除 Worker-B 预测预计算**——双 Worker 同步复杂且实测易卡；预测改在主线程渲染循环内
>    与渲染同频进行（rAF 内位置速度积分外推 + 角度 LERP）
> 2. **权威只同步基本信息**——SAB 权威区仅含 yaw/pitch/vel/eyeHeight/onGround，
>    **位置不同步**（渲染帧通常高于物理帧，位置由主线程按速度积分，接受无碰撞误差）
> 3. **物理不设上限**——固定步长累积器无步数封顶（低帧率不丢物理时间）
> 4. respawn/teleport 位置突变事件回传一次（player-respawn 消息），主线程预测归零
>
> **v3 相对 v2 的变化**（保留记录）：基本面板保留但不常驻——初始化常驻（必须加载地图）、
> 锁定后 ESC 弹出、游玩中隐藏。面板收敛为六块：物理参数（含 tickRate）、
> 人物体型、操作（灵敏度/Q-E）、准星、速度面板（0.25s 低频）、自由视角切换。
>
> **本文为设计蓝图**。实现后的三方差异对照（时序图 / 蓝图 / 实现现状）见
> `IMPLEMENTATION-STATUS.md` §3——其中 D1-D6 为本蓝图在实现时的偏离
> （Int32 定点 SAB、noclip 入 Rust、build_world JSON 通道、config 统一消息、
> tickRate 不清累积器、wasm-opt=false），T1-T6 为相对时序图的工程化取舍。

---

## 0. 一句话结论

**TS 11,844 → ≈ 4,300 行（-64%）**；Rust 新增 `phys` 模块 ≈ 2,000 行（自 TS 3,048 迁移，总代码净减）；
scene-data 从「GLB + 几十 MB JSON」瘦身为「GLB + spawn/pvs 小 JSON」（-95%）；物理世界 Rust 内直建、零 JSON；
物理 tick 60Hz 每帧仅跨边界传 ~8 个 f64；**面板为 ESC 弹出式，速度/参数/体型/视角全部保留精简版**。

---

## 1. 迁移决策原则（不变，v2 结论）

| 进 WASM | 留 TS |
|---|---|
| 高频纯计算：物理 tick / 碰撞查询 / 传送检测 | 数据已在目标线程零通讯成本：PVS 位图 / LOD |
| 大数据跨线程：物理世界构建（几十 MB JSON 消失） | 低频事件：输入清洗 / Pointer Lock / UI |
| 状态与物理耦合：死亡判定、传送（并 tick） | 控制逻辑：三源决策 / 序列号 / Worker 编排 |
| | three.js 强绑定：GLTFLoader / 渲染循环 |
| | **noclip 自由视角（调试态，逻辑简单留 TS，不进 wasm）** |

---

## 2. 基本面板设计（v3 新增，重点）

### 2.1 显示逻辑（与 Pointer Lock 状态机耦合）

```
状态机：
  初始化（未加载地图）──→ 面板【必须显示】（加载地图入口）
  加载完成 ───────────→ 面板隐藏，显示「点击画布锁定」
  锁定中 ── 按 ESC（浏览器自动退锁）──→ 面板【弹出】（pointerlockchange 事件驱动）
  面板打开时：点击「关闭并锁定」→ 请求 Pointer Lock → 面板隐藏
  任意时刻（含锁定中）按 M 或菜单键 → 手动开关面板（兜底，防 ESC 被拦截）
```

- 实现：面板可见性 = `!pointerLocked || !sceneReady`；`pointerlockchange` 事件里
  `locked=false` 时显示面板、`locked=true` 时隐藏面板。**无需额外"ESC 监听"**——ESC 退锁
  是浏览器原生行为，面板响应退锁事件即可。
- 面板打开期间指针可见（`document.exitPointerLock` 由 ESC 触发），交互全部走 DOM。

### 2.2 面板分区与控件清单（收敛后）

| 分区 | 控件 | 走线 | 备注 |
|---|---|---|---|
| **物理** | tickRate 滑块 48–128（默认 64） | config → Worker-A（驱动步长） | 见 2.4 |
| | autobhop 开关 | config → wasm `set_params` | surf 核心玩法 |
| | gravity / jumpSpeed / accelerate / airAccel / friction（5 个数值滑块） | config → wasm `set_params` | 手感核心，来源 badge 简化版（默认/手动） |
| **体型** | hull 半宽 / 站高 / 蹲高 + 一键恢复 | config → wasm `set_hull` | 恢复默认按钮 |
| **操作** | 灵敏度 0.1–5.0 | config → Worker-A（视角系数） | 有效灵敏度 = sens × m_yaw |
| | Q/E 旋转速度 0–720 °/s | config → Worker-A | turn bind |
| **准星** | 显示/隐藏 + 中心点尺寸 | 主线程本地（渲染） | 纯渲染态，无 Worker 消息 |
| **速度面板** | 模式选择：横向 / 横+竖 / 综合 | 主线程本地（HUD 渲染） | 0.25s 低频，见 2.3 |
| **视角** | 自由视角（noclip）开关 | `set-physics-mode` → Worker-A | 见 2.5 |

**仍删除（v1/v2 判定不变）**：物理面板的碰撞箱缩放倍率联动、卡住自动恢复、
15 项全参数列表、传送触发模式 radio、碰撞来源选择、自定义传送点、计时挑战、
碰撞可视化、准星射线检测、HUD 开关、cullStats/gameStats 显示。

### 2.3 速度面板规格（低频 0.25s）

- 数据源：**S_used 权威/预测状态的 `vel`（已在 SAB，零消息、零额外开销）**，主线程三源决策
  后随手可得。
- 更新频率：**4Hz（0.25s 墙钟门控）**，与渲染循环解耦，防 HUD 闪烁。
- 三种模式：
  - 横向：`hypot(v.x, v.z)`（surf 滑行速度，默认）
  - 横+竖：`横向 XX ｜ 竖向 ±YY`（两行/两段显示）
  - 综合：`|v| = sqrt(v.x²+v.y²+v.z²)`（含竖向的合速度）
- 显示位置：HUD 角落（与 FPS/位置同区），面板内切换模式即时生效（主线程本地状态）。

### 2.4 tickRate 变更的时序适配（v4 简化）

权威物理固定步长，tickRate 可调后：

```
面板 tickRate 48–128
  └─ config 消息 → Worker-A：fixedDt = 1/tickRate（JS 驱动层更新，wasm tick 只吃 dt，不感知速率）
  └─ Worker-A 防穿墙上限随步长缩放：MAX_INPUT_PER_STEP ∝ dt（快 tick 每步输入上限同比缩小）
  └─ 渲染侧位置预测使用权威速度（单位 u/s），与 tickRate 无关，无需适配
```

> 关键点：**tickRate 只影响"步长"**——渲染预测（位置积分 + 角度 LERP）与步长解耦，
> 权威速度本身已是每秒单位，任何 tickRate 下外推一致。

### 2.5 自由视角（noclip）的处理

```
noclip 模式（调试/观赏用）：
  - Worker-A：Rust noclip_step（无碰撞，20 行纯数学），与 physics 同一状态机
  - 主线程预测：noclip 下位置同样按权威速度积分（noclip 速度由面板可调）
  - 模式切换（noclip ↔ physics）：respawn 语义 → player-respawn 事件回传位置归零
  - 双向继承：physics→noclip 继承位置朝向；noclip→physics 从当前位置重新起跑（清速度着地）
```

---

## 3. 删除清单（v3 修正版）

### 3.1 TS 整目录删除（物理下沉，不变）

```
src/physics/                      # 3,353 行 → Rust phys 模块（迁移）
src/world/collider-adapter.ts     # 287 → 并入 Rust build_world()
src/world/teleport-manager.ts     # 333 → 并入 Rust tick
src/world/spawn-loader.ts         # 123 → spawn 类型内联
```

### 3.2 文件删除（调试/冗余，不变）

```
src/renderer/collider-debug.ts(716) / plane-inspector.ts(376) / lightmap-shader.ts(224)
src/renderer/fog-manager.ts(102) / light-manager.ts(390→内联 ~30)
src/world/custom-teleports.ts(98) / src/game/game-state.ts(216)
src/worker/physics-loop.ts        # 355 → 循环并入 Worker-A 驱动
MsgState 回退 / 环形缓冲 / LERP+外推 / colliderSource 三方案 / 传送三模式
crates/wasm/src/debug_probe.rs / 9 个未用导出 API / 薄壳方案
```

### 3.3 消息与 UI（v3 修正：面板相关恢复保留）

**删消息**：`set-hull`×4 组（hull 缩放/自动恢复）、`set-auto-restore-hull`、`get-player-pos`、
`teleport-to-pos`、`physics-snapshot`（改为精简 source 回显或本地 badge）、`game-stats`、
`cull-stats`、`player-pos`、`input`（回退）、`resize`。

**保留/恢复消息**：
```
Main→Worker: wasm-init / init / load-bsp / config（含 tickRate/autobhop/5 参数/hull/sens/yawSpeed）/
             set-physics-mode（noclip↔physics，恢复）/ respawn / teleport / set-death-threshold
Worker→Main: ready / bsp-metadata / scene-data（GLB+spawn+pvs）/ stats（FPS/位置/速度 4Hz）/ error
```
> 面板所有"改参数"动作统一走 `config`（携带 section+patch），Worker-A 把物理类 patch 转发给
> wasm `set_params`/`set_hull`，时序类（tickRate）按 §2.4 适配。**不新增专用消息类型**。

**面板 HTML**：独立 `<div id="panel">` 覆盖层（初始 `display:flex`，加载地图后隐藏；
退锁显示；含"关闭并锁定"按钮）。保留 bspFile/status/metadata/spawnSelect/respawnBtn
（初始化必需）；灵敏度/Q-E/准星/速度模式控件从原侧边栏迁入面板。

---

## 4. 目标架构（物理 WASM 版 + 面板交互）

### 4.1 Rust phys 模块（不拆细，4 文件 ≈ 2,000 行）

```
crates/wasm/src/phys/
  mod.rs        # PhysWorld 组装 + wasm-bindgen 导出
  world.rs      # World + 双 Grid + traceBox + clipBoxToTriangle
  player.rs     # PlayerController 全套移动语义（16 TS 文件 → 1 Rust 文件）
  teleport.rs   # TeleportManager（start-touch）+ 死亡判定
```

API：`build_world()` / `tick(dt, dx, dy, keys)` / `predict(dt, dx, dy, keys)` /
`respawn()` / `teleport_to()` / `set_death_y()` / **`set_params(json)` / `set_hull(json)`**（新增，面板用）。

### 4.2 单 Worker 世界数据 + 主线程预测

Worker-A 持 wasm 模块的 `PhysWorld` 实例（BSP bytes 主线程单次转发，Rust 内 build_world 毫秒级）。
预测在主线程渲染循环内进行（rAF 同频）：
- 位置：`pos += vel × dt`（权威速度线性积分外推，无碰撞，接受误差）
- 角度：权威帧间 LERP（最短角距）
- respawn/teleport：`player-respawn` 消息回传位置归零

### 4.3 SAB 布局（v4：权威基本信息，无位置）

| 偏移 | 区 | 内容 | 内存序 |
|---|---|---|---|
| 0–63 | 控制区 | V_A + gen_A + keys + onGround | release 写 / acquire 读 |
| 64–127 | 输入槽 | dxAcc/dyAcc（BigInt64 原子累加） | 主线程 add；Worker exchange 消耗 |
| 128–415 | 权威基本信息双缓冲 | yaw/pitch/vel/eyeHeight（每槽 7 值 ×1000/×100 定点） | Worker-A release 写 + V_A++ |

主线程渲染帧：V_A 刷新 → 更新角度基线/速度 → 位置积分外推 → 渲染。零等待。
**速度面板从权威 vel 直接取（4Hz 采样），零消息。**

---

## 5. 分阶段实施路径

> 原则：先删后改、每阶段可编译可运行、Rust 物理 golden 差分验证后切换。

### Phase 0 — 基线冻结（0.5 天）
- [ ] `git tag websurf-debug-20260807`；确认 pkg 同步；
- [ ] 建立物理回归 golden：固定输入序列（WASD+跳+转向）记录逐 tick pos/vel/yaw。

### Phase 1 — 删除 + 面板改造（1.5–2 天）
- [ ] 删 §3.2 调试/冗余文件 + UI 绑定；
- [ ] 侧边栏 → ESC 弹出式面板：重排为 §2.2 六分区，实现 §2.1 显示状态机；
- [ ] 消息协议按 §3.3 收敛（恢复 set-physics-mode，面板动作统一走 config）；
- [ ] 速度面板 §2.3（主线程本地 4Hz）；
- [ ] **验证**：初始化常驻 → 加载后隐藏 → 锁定 → ESC 弹出 → 关闭再锁定，全链路正确。

### Phase 2 — Rust phys 移植（3–5 天，最大块）
- [ ] world.rs / player.rs / teleport.rs（对照 TS 逐函数移植）；
- [ ] set_params / set_hull 导出；tickRate 步长适配 §2.4；
- [ ] **差分验证**：Rust tick vs golden 逐 tick 误差 < 1e-6。

### Phase 3 — 物理切换 + 世界构建下沉（1–2 天）
- [ ] Worker-A 驱动 wasm tick（删 physics-loop.ts / collider-adapter / teleport-manager）；
- [ ] build_world() 直建；scene-data 去 brush/tri/teleport JSON；
- [ ] noclip 恢复：JS 侧自由视角 + Worker-B 禁用预测（§2.5）；
- [ ] **验证**：加载提速、手感一致（差分已保证）、noclip↔physics 切换无闪跳。

### Phase 4 — 主线程预测渲染（1 天）
- [ ] 渲染循环内：读权威基本信息（角度/速度/眼高/着地）→ 位置速度积分外推 + 角度 LERP；
- [ ] 位置突变事件（respawn/teleport）回传归零；初始位置 = scene-data spawn；
- [ ] **验证**：144Hz 屏权威帧间无停等/闪跳；角度无错乱（Rust 度为弧度转换正确）；
      穿墙/漂移在可接受范围（位置无碰撞积分的既定取舍）。

### Phase 5 — WASM 导出瘦身 + 契约收缩（1 天）
- [ ] lib.rs 删未用导出 + 薄壳常量；删 debug_probe.rs；
- [ ] `check-wasm-api.mjs` 收缩（导出 9 + phys 9）；
- [ ] 全量重建 + 12/12 冒烟 + 差分回归；dist file:// 验证。

### Phase 6 — 收尾审计（0.5–1 天）
- [ ] grep 残留：`colliderAdapter|TeleportManager|showSolids|planeInfo|game-stats|customTeleport|physics-loop`；
- [ ] docs 同步（新协议/文件结构/面板状态机）；记忆更新；打勾。

---

## 6. 目标文件结构（v3）

```
src/                                          # ≈ 22 文件 ≈ 4,100 行
  app.ts                    # ~520：面板状态机 + 预测渲染循环 + 速度面板 4Hz
  config.ts                 # ~90：收敛段（physics/tickRate/input/hud 精简）
  panel/                    # panel-controller.ts（显示状态机 + 六分区绑定，~250）
  input/                    # pointer-lock / keyboard / mouse-buffer / input-bridge（~530）
  worker/                   # main.ts（权威物理）/ shared-state.ts（SAB 双区）/ worker-types.ts
  renderer/                 # renderer-main.ts（主线程预测 + LERP）/ camera-controller.ts / lod-manager.ts
  world/                    # pvs-manager.ts / types.ts
crates/wasm/src/
  lib.rs                    # 导出 9 API + phys 12 API
  phys/                     # mod.rs / world.rs / player.rs / teleport.rs（≈2,000）
  vbsp/ bsp_to_gltf_core/ model_integrator/ pakfile_models.rs phyfile.rs texture_utils/
web/index.html              # 极简：加载区 + canvas + ESC 面板覆盖层 + 极简 HUD
```

**规模预算**：TS 11,844 → ≈ 4,300（-64%）；Rust +2,000（自 TS 3,048 迁移，净 -1,000+）；
消息 7+5；scene-data -95%；面板从 ~1,300 行侧边栏收敛为 ~250 行弹出式控制器。

---

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| Rust 物理移植工作量大（3–5 天） | 周期长 | golden 差分锁定等价性；world/碰撞先行 |
| tickRate 变更影响 Worker-B 预测节奏 | 预测错位 | §2.4 统一子步 dt；切换瞬间清累积器 + 清 seq_pred |
| noclip 与预测共存 | 预测无意义 | noclip 下禁用 Worker-B + 清 V_A/seq_pred |
| 面板状态机边界（初始化/退锁/手动开关） | UX 混乱 | §2.1 状态机单一事实源（visible = !locked ∥ !sceneReady）+ M 键兜底 |
| 强制 SAB 非 COOP/COEP 不可用 | 兼容收窄 | serve.py 已配；dist file:// 验证 |
| 删 parse-progress 长解析无反馈 | UX | 保留 status 文本消息 |

---

## 8. 验收清单（最终）

- [ ] `npm run build` 零错误；`check-wasm-api.mjs` 通过（9+9）；
- [ ] Rust 物理 vs golden：逐 tick 误差 < 1e-6；
- [ ] 面板状态机全链路：初始化常驻 → 加载隐藏 → 锁定 → ESC 弹出 → 关闭再锁定；
- [ ] tickRate 48/64/128 三档：手感、Worker-B 预测、防穿墙上限均正常；
- [ ] 速度面板三模式（横向/横+竖/综合）4Hz 更新正确；
- [ ] noclip ↔ physics 切换无闪跳、无穿墙；预测在 noclip 下禁用；
- [ ] surf_666 加载 < 2s；144Hz 无停等/闪跳；dist 双击可玩；
- [ ] 全仓无 §6 残留关键词。
