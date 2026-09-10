# game 差异对照（D）

> 核对基准：当前工作区代码；对照对象为 `debug/`、`viewer/`、`test/dual-mode-harness/` 与共享层 `src/`（关键论断均经 grep/read 核对，标注两侧路径）。总览见 [overview.md](overview.md)。
> debug 侧细节文档：[`../../debug/docs/overview.md`](../../debug/docs/overview.md)；共享层：[`../../docs/ts-shared.md`](../../docs/ts-shared.md)。

## 1. 四工程定位一句话

| 工程 | 定位 | 物理线 | 通道 | 来源 |
|---|---|---|---|---|
| debug | 主工程（全功能调试台：物理参数实验室/渲染调试/计时挑战） | 双线同构（主线程渲染 + Worker 权威） | SAB 512B / MsgState | `debug/package.json` description、`debug/src/renderer/renderer-main.ts:138-139,441-447` |
| game | 激进最小化游戏化（可玩优先） | 双线同构（同一套 ts-shared auth）+ **双模式热切**（耦合=v7 现行 / 解耦=物理整体 Worker 全托管，默认耦合） | 同 debug | `game/package.json:4`、本文 §2.1/§2.3、[overview.md](overview.md) §2.3 |
| viewer | BSP 游览 + 录像回放，仅解析层 | **无物理**（crate 不依赖 websurf-phys） | 无 SAB、无 ts-shared | `viewer/crates/wasm/Cargo.toml`（注释"无物理"）、grep `viewer/src` 无 PhysWorld/SharedArrayBuffer（仅 pose.ts:11 注释提到与 ts-shared 同款 yaw 公式） |
| dual-mode-harness | 双物理时序验证台 | 双物理实例 + 速度校准（协议独立） | **SAB 192B 专属布局** | `test/dual-mode-harness/src/shared-state.ts:3,109-110`（`SHARED_BUFFER_SIZE=192`，头注明示"不是 ts-shared 那套"） |

## 2. game vs debug（同构中的最小化）

### 2.1 完全同构的部分（共享层保证）

- **Worker 权威线逐组件相同**：`auth-loop`（setTimeout 4ms + 固定步长累积器 + land/blocked 事件）、`worker-dispatch`（同一套消息分支）、`params`（sensitivity=1）、`shared-state`（512B 布局/MsgState）——两侧 import 同一批文件（`game/src/worker/main.ts:33-44` 与 `debug/src/worker/main.ts` 同款；phys-mode-port 后 game 额外 import `decoupled/decoupled-loop.ts`，debug 未 import）。
- **主线程渲染物理线同构（耦合模式）**：debug `renderer-main.ts:441-447` 的 tick 与 game `renderer-main.ts:947-978` 耦合分支六步一一对应（addInput → correctFromAuthority → calibrateVelocity → predPhys.tick → …→ render），权威校准都收敛 `src/ts-shared/phys/authority-calibrator.ts`；解耦消费分支（T7'）为 game 独有（§2.3）。
- **地图加载管线同构**：两侧都用 `buildWorldBundle`（`src/ts-shared/phys/world-builder.ts:103`），game 传 `{decompressMtz, onProgress}`（`game/src/app.ts:450-454`），debug 另有 colliderSource 面板档位。
- **渲染子系统同源**：game 的 optimizeScene/近平面自适应/纹理画质切换注释明示"同步自主项目/主项目同法"（`game/src/renderer/renderer-main.ts:127,808-816`）。

### 2.2 game 砍掉的（debug 特有，均经文件存在性核实）

| debug 特有 | 证据 | game 处置 |
|---|---|---|
| 物理参数定义库 + 物理面板 Worker | `debug/src/physics/param-defs.ts`、`debug/src/worker/physics-worker.ts`（存在） | 不存在；参数直接 `PanelController` → InputBridge 双写（`game/src/input/input-bridge.ts:30-56`） |
| 计时挑战系统（game-state） | `debug/src/game-state.ts`（存在） | 无计时系统（grep `game/src` 仅 `lockTickRate` 注释提及"计时玩法"预留，`game/src/config.ts:81-93`；详见 [implementation/gameplay.md](implementation/gameplay.md) §6） |
| 自定义传送编辑 | `debug/src/world/custom-teleports.ts`（存在） | 仅用 BSP 内建 trigger_teleport（`src/phys/teleport.rs`） |
| 默认纹理包运行时装配 | `debug/src/default-pack.ts`、`debug/src/worker/mtz-data.ts`（存在） | mtz 只作为 `buildWorldBundle` 回退入参（`game/src/app.ts:451` 注入 `decompress_mtz`） |
| Worker 面板消息钩子 | debug `worker/main.ts:110-119`（mtzB64 钩子/onWorldBuilt/onConfigApplied/onExtraMessage） | game `worker/main.ts:210-232` 不传工程特有副作用钩子（onInit/onWasmInit/onWorldBuilt/onConfigApplied/onExtraMessage 均 grep 无），面板消息走共享 `config` 通道；但传**双模式装配钩子**（`tickPhys`/`decoupledLoop` 槽 + `getComputeMode`/`onSetMode`/`onSetHold`）——debug 侧全部未注入（grep 无命中，可选钩子缺省 = 解耦面整体不激活，v7 行为零变化） |
| 渲染调试器 | `debug/src/renderer/{collider-debug,plane-inspector,light-manager,lightmap-shader,fog-manager,lod-manager}.ts`（存在） | game 用固定三点光（`renderer-main.ts:245-252`）+ LOD 距离剔除内联（`:994-1012`），PVS 整体禁用（`:86`） |
| 面板偏好分域更细的 config | debug `config.ts:147-230` 共 11 段（physics/player/movement/smoothing/teleport/lod/lighting/input/hud/debug/texture） | game 5 段 + lockTickRate（`game/src/config.ts:92-143`）；`lockTickRate` 为 game 特有公平性预留（grep debug 无此字段） |

### 2.3 game 独有的（debug 没有）

| game 特有 | 证据 |
|---|---|
| `PanelController` 独立类（七模块 + 偏好持久化 + 存点列表渲染 + 计算模式控件） | `game/src/panel/panel-controller.ts`（722 行）；debug 无 panel/ 目录（`ls debug/src` 无 panel/ui，面板逻辑在 `debug/src/app.ts` 直绑 HTML） |
| 存点系统（X 存 / C 按住冻结 / 面板任意读点；解耦模式 C 键走 worker 侧 set-hold） | `game/src/savepoint.ts`、`game/src/renderer/renderer-main.ts:786-829`（holdPoint 每帧 set_state 冻结语义）、`game/src/app.ts:543-568`（解耦分支） |
| 键位录制重绑面板 | `game/src/input/keymap.ts:42-65`（`websurf-game.keymap.v1`）+ `panel-controller.ts` 按键模块 |
| TICK_RATE_OFFSET=3 隐藏偏移 | `game/src/worker/main.ts:49-53,222`（面板显示原值，权威实际 +3；解耦 tickPhys 走 raw 原值）；grep `debug/src` 无此常量 |
| 双模式热切（耦合/解耦） | `game/src/panel/panel-controller.ts:430-440`（面板控件）+ `game/src/input/input-bridge.ts:94-129`（sendSetMode/resendSetMode/sendSetHold）+ `game/src/worker/main.ts:125-208`（decoupledLoop 装配/applyModeSwitch/applySetHold）；debug 无 `computeMode` 配置、无双模式注入（grep 无命中） |
| lockTickRate 公平锁 | `game/src/config.ts:92,102`、`panel-controller.ts:238-241` |

> 近平面自适应（含面板参数）两侧同有：debug 同样面板化 nearProbeDist/nearRatio（`debug/src/app.ts:116-119`），不算 game 特有——机制注释明示"同步自主项目"（`game/src/renderer/renderer-main.ts:127`）。

## 3. game vs test/dual-mode-harness（协议不同族）

| 维度 | game | dual-mode-harness |
|---|---|---|
| SAB 布局 | ts-shared 512B（`src/ts-shared/auth/shared-state.ts:109-130`；含解耦帧 S_D/V_D/WAKEUP 扩展槽，两模式互斥复用同槽位） | harness 专属 192B（`test/dual-mode-harness/src/shared-state.ts:109-110`；头注 `:3` 明示"专属布局、键位掩码位复用 ts-shared"——唯一借用的共享件就是 KEY_MASK，与 scout 矩阵一致） |
| 物理线模型 | 耦合（默认）= 单 Worker 权威 + 主线程渲染线 + 外推校准；解耦 = harness 模式A/模式B 编排整体移植（Worker 内 1ms 无限制真理源 + 64t tickPhys 校准 + 锚定拉回，`src/ts-shared/decoupled/decoupled-loop.ts`），主线程纯消费 | 双物理实例（权威 + Worker-B 预测）+ 速度校准、双槽唤醒；game 移植其 WorkerA 编排（decoupled-loop.ts:10-15 全序）而 **WorkerB/OffscreenCanvas 渲染不移植** |
| 渲染位置 | 主线程 Three.js（`renderer-main.ts:693-768`） | Worker-B 内 OffscreenCanvas |
| wasm 包 | game/pkg（全量导出 + mosaic） | harness/pkg 运行时最小集仅 5 API（metadata/export_brushes_planes/export_model_phy_colliders|tri 回退/parse_spawn_points/export_glb_with_pakfile_models）；`parse_teleports/parse_pvs_data` 保留但导出流程不调用、mosaic/缺失纹理未导出（`test/dual-mode-harness/crates/wasm/src/lib.rs:14-20` 头注） |
| 用途 | 可玩游戏 | 时序验证/回归（phys-rate-parity 等脚本对拍对象） |

## 4. game vs viewer（有/无物理的分界）

- viewer crate 不依赖 websurf-phys（`viewer/crates/wasm/Cargo.toml` 注释"无物理"），TS 侧零 SAB、零 ts-shared import（grep 证实；`viewer/src/core/pose.ts:11` 仅注释复用同一 yaw 换算公式）。
- viewer 走薄导出（解析/游览/录像），dist 为 single-only；game 依赖完整物理 + 双通道（SAB 高性能/MsgState 降级）。
- 共同点：地图解析管线同源（websurf-wasm-core）、mosaic 纹理体系共享（viewer 无画质切换需求故不导出 mosaic API——导出面差异见根 [`../../docs/wasm-core.md`](../../docs/wasm-core.md)）。
- **UI 风格语言同源（本轮迁移，r1 评审放行）**：game/web 视觉层整体采纳 viewer S10 令牌体系——样式自 index.html 内联迁出为独立 `game/web/styles.css`（571 行），:root 令牌对照 `viewer/web/styles.css` 逐一同值（`--panel/--panel-solid/--border/--border-strong/--text/--muted/--accent/--accent-dim/--gold` + `--r-sm..lg` + `--ctrl-bg(.hover)` 交互态；`--bg-app/--success/--danger/--warn` 均系旧表同名令牌重赋值（#1f1f1f/#4ade80/#ff7b83/#f5b93d → #0f1115/#9bd4a6/#ffb4a8/#ffd9a0；--danger 同 viewer 值，--success 为 viewer 无语义绿下的派生绿，--warn = viewer note-warn 文本色令牌化，--bg-app 在 viewer 侧为硬编码 #0f1115 的令牌化）；`--sidebar-w` 无侧栏 N/A），卡片化面板 + 悬停/激活配方对齐；DOM/ID/类名零改动（id 80/80、data-* 14/14、class 30/30 集合零差异）；迁移本体为纯视觉层换血，后续完善轮将 12 处 display/width 状态绑定收编为 class 切换（8 处：#panel.hidden×5/#error.show/.key-rec-hint.show×2/#crosshair.no-dot）+ `--load-pct` 自定义属性驱动（×3，复位走 `removeProperty`）——行为等价，`--ch-*` ×4 令牌写入口径不变；`#fatalOverlay` 历史死元素全清（HTML 注释字样 + styles.css 9 条规则连同节注释 `/* 致命错误覆盖层（Win11 对话框样式） */` 一并清除 + 全仓 JS hook 零残留；对照 git HEAD index.html:575-607）。物理/键位/功能零改动——迁移是纯视觉层换血。

## 5. 与共享层的取舍

- `buildPhysicsParams` 单点下发：game `config.ts:166-180` 与 `worker/main.ts:78-101` 各自映射同一参数集，`sensitivity:1` 固定（`src/ts-shared/phys/params.ts:57-59`）——灵敏度分叉在结构上不可能（对照 [panel-and-input.md](implementation/panel-and-input.md) §6）。
- `buildWorldBundle` 的 `missingTextures/默认纹理包`：game 只传 `decompressMtz`；debug 额外维护运行时纹理包装配。game 侧 `bundle.missingTextures` 未消费（renderer 仅用 `mosaicManifest`，`game/src/renderer/renderer-main.ts:331-333`）。
- `PhysWorld` 高级 API（tick_into 零分配热路径/state_out_ptr/set_velocity）：耦合模式全走 `tick/state` 对象路径（grep `game/src` 无高级 API 引用）；**解耦模式**经 `src/ts-shared/decoupled/decoupled-loop.ts` 消费 `tick_into/state_out_ptr/set_velocity`（1ms 真理源零分配发布，`:215-238,372,395`；wasm 内存注入 `game/src/worker/main.ts:63-64,227-230`）——`predict/debug_trace/gate_veto_count/take_event/set_yaw_pitch/teleport_to` 仍无 game 引用（API 清单见 `game/scripts/check-wasm-api.mjs:17-53` 与 [overview.md](overview.md) §6）。
- `worker-types.ts` 的 `teleport-to-pos` 协议位：共享 dispatch 支持但 game 不发送（grep `game/src` 无调用方；`src/ts-shared/auth/worker-dispatch.ts:305-313` 分支空转）；`set-death-threshold` 已接线（W-GAP-2：`game/src/input/input-bridge.ts:76` + `game/src/app.ts:142-145`）。

## 6. 已知历史残留（写文档时勿引用）

| 残留 | 位置 | 现实 |
|---|---|---|
| "v5 Worker=纯速度修正器"头注 | `game/src/app.ts:4,7` | 代码为 v7 权威帧计算器（`game/src/worker/main.ts:1-16`） |
| predictor-worker 引用 | `game/src/worker/worker-types.ts:6` | 该文件不存在（grep `game/src` 与 `debug/src` 均无 predictor-worker 文件）；v3 双 Worker 预测已废 |
| 协议类型缺项 | `game/src/worker/worker-types.ts` | 未收录 `set-spawn-points/sync-render-state/teleport-to-pos` 等现行消息（set-mode/set-hold/mode-ack 已补 `:58-70,193`）；运行时协议以 `src/ts-shared/auth/worker-dispatch.ts:97-348` 为准 |
| `player-respawn` 死消息（**record-only 待办，终审⑥**） | `game/src/worker/worker-types.ts:141` | 协议定义存在但 game 全链路无发送方/无处理方（grep 无命中）——phys-mode-port 范围纪律**本轮不清理**，留待后续决定删除或接线 |
| SAB 布局头注字节量（**docs 已勘误**） | `src/ts-shared/auth/shared-state.ts:128` | 注释「实际使用至 416B」与逐槽计算不符——t2/t3 实测：耦合槽区用至 288B（b64[35] 止于字节 287），S_D 扩展占用 288-447（160B 双缓冲）后实际用至 448B、余量 64B；t7 docs 已按实测勘误（ts-shared §3.1），代码注释留待后续清理 |
| web/*.js、dist/* 旧产物 | `game/web/`、`game/dist/` | 可能是 v3 时代构建产物，运行前先 `npm run build:ts` / `build-dist.cmd`（`game/README.md` 明示） |

## 7. phys-mode-port 修复链与披露（t13/t15 双 pass 记录）

### 7.1 修复链（r1a/r1b 评审闭环 → t13/t15 复审双 pass）

| 修复 | 内容 | 落点 |
|---|---|---|
| r1a-F1 时钟锚 | 解耦外推时钟原点差吸收：`extrapClockAnchorMs = now − frame.timeMs` 首帧建锚（误差 ≤ 一个发布周期），重发/回滚/handleModeAck 三处置 null 重锚；dt = clamp((now − frame.timeMs) − anchor, 0, 250) | `renderer-main.ts:129,631,639,664,1023-1035`；**基准档案** `temp/t6-review/t11-evidence/anchor-test.mjs`（方向修正版），t12 脚本为历史存档勿引用为现行事实 |
| r1a-F2 在途禁用双保险 | 面板源侧 change 即锁 `#computeMode`（恢复点 = `onComputeModeSettled`/回滚）+ bridge 在途守卫 pending ack 期间禁止二次发送（查询 `hasPendingModeSwitch`） | `panel-controller.ts:436-438` + `input-bridge.ts:95` + `renderer-main.ts:645` |
| r1a-F3 hold 清除 | 解耦→耦合切换时清 worker 侧在途 hold——冻结不跨模式存活（残留 hold 会在再次进入解耦时复活死冻结；主线程 holdPoint 照常由 keyup 收尾） | `worker/main.ts:169-171`（applyModeSwitch coupled 分支 `hold = null`） |
| r1b-G1 双实例同参（t14） | **player fast-path 在位**（halfWidth/radius 归一 + partial-patch 三字段守卫保留，磁盘取证 `:215-226`）+ 相邻行 additive 补 `env.tickPhys?.current?.set_hull`——G3「tickPhys 与 phys 同建同参」全链闭合（world-json/physics-input/player 三路径），解耦会话内 64t 校准线不再以旧 hull 算校准速度 | `worker-dispatch.ts:215-226`（additive 补行 `:223-224`；注释「G1 终裁定案 option 2 · 议题已关闭」`:219`；dist worker.js 65.0kb 同形态） |
| B1 校准增量落点 | authority-calibrator.ts 增量 +46 行（385→431）= 设计件 §3.5「外推算式冻结」条款落地：新增 `extrapolateAuthPose` 纯函数 + `EXTRAP_MAX_MS=250` 定格常量；校准四件套本体语义零改（终审③：外推数学复用、反向同步链解耦期废弃） | `authority-calibrator.ts:101,110-121` |
| B2 W-GAP-1 归一落点 | snake→camel 键归一 `normalizeConfigPatchKeys` 单点修（终审①+⑤，勿在 dispatch/config 两处各打补丁）——11 参数权威侧首次生效 | `worker-dispatch.ts:186-196` |
| t13/t15 | 修复后 review r2 双 pass（t12→t13、t14→t15）；r1a（t6）与 r1b（t11）needs_revision 均已闭环 | 团队任务记录 |

### 7.2 披露清单（与终报告一致，向用户知情披露）

1. **W-GAP-1 = 有意行为变更**（非回归）：11 物理参数权威侧首次生效——此前 `Object.assign` 直入仅 gravity/accelerate/friction/autobhop/tickRate 五键同构生效，其余 11 键在权威侧永远陈旧（`worker-dispatch.ts:186-196` 注释明示）。
2. **P7 已知热切跳变四项**（设计件量化定案：合同线 = 位置/朝向/速度连续，全达标）：① ducked/duck_frac 姿态缺口——眼高差一档视角瞬变，自纠于下次 duck 输入或 respawn（代码锚 `renderer-main.ts:582,656`，耦合→解耦向因 worker 实例并行模拟偏差更小）；② on_ladder/surfing/surfed_since_grounded 自愈 ≤1 tick（1ms）；③ contact_ticks/ground_ticks 良性 ≤3ms；④ teleport.cooldown 0.5s 冷却窗内热切可能瞬触二次传送，概率极低（跨层管线成本 > 收益，保留不修）。
3. **可选后续轮两档**（本轮未做，v1 接受）：档 1 = `set_posture` 蹲伏交接导出（终审②「采纳」→终审⑧「收回」，Rust 零改动维持；设计/导出式存档于设计件 §3.4.F）；档 2 = `calibrateVelocity` 同源时钟（耦合线 `authority-calibrator.ts:348` 裸 `dt = now − timeMs` 钳 0.1s 沿用 v7 语义，解耦线已由 F1 锚修正——两线时钟源统一为可选项）。
4. **G1 叙述口径（captain 基准更正落稿）**：docs 一律锚定磁盘终态——player fast-path **在位**（`:215-226`，halfWidth/radius 归一 + partial-patch 三字段守卫保留）+ 相邻行 additive 补 tickPhys 同参（`:223-224`，代码注释「G1 终裁定案 option 2 · 议题已关闭」，dist worker.js 65.0kb 同形态）。
5. **自启动 ≤500ms 窗口**：持久化解耦偏好自启动 `sendSetMode('decoupled')` 无预测交接态直发（`app.ts:213-216`，predPhys 未建 → state 省略，worker 用自己初始态），不挂 ack 定时器（`armModeAckTimeout` 仅热切路径 `renderer-main.ts:610,617`）；send→ack 往返窗口内解耦消费分支未激活、无相机/无输入，用户无感。
6. **C 按住跨双热切边沿**：耦合→解耦向 = 主线程冻结丢失至 keyup（keyup 仍走 `set-hold(null, savePoint)` worker 全量恢复，`app.ts:559-566`）；解耦→耦合向 = F3 清 worker hold + 主线程 holdPoint 逐帧冻结无缝续接（`worker/main.ts:169-171` + `renderer-main.ts:959-962`）。
