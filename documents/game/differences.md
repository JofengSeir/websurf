# game 差异对照（D）

> 核对基准：当前工作区代码；对照对象为 `debug/`、`viewer/`、`test/dual-mode-harness/` 与共享层 `src/`（关键论断均经 grep/read 核对，标注两侧路径）。总览见 [overview.md](overview.md)。
> debug 侧细节文档：[`../debug/overview.md`](../debug/overview.md)；共享层：[`../ts-shared.md`](../ts-shared.md)。

## 1. 四工程定位一句话

| 工程 | 定位 | 物理线 | 通道 | 来源 |
|---|---|---|---|---|
| debug | 主工程（全功能调试台：物理参数实验室/渲染调试/计时挑战） | 双线同构（主线程渲染 + Worker 权威） | SAB 512B / MsgState | `apps/debug/package.json` description、`apps/debug/src/renderer/renderer-main.ts:138-139,441-447` |
| game | 激进最小化游戏化（可玩优先） | 双线同构（同一套 ts-shared auth） | 同 debug | `apps/game/package.json:4`、本文 §2 |
| viewer | BSP 游览 + 录像回放，仅解析层 | **无物理**（crate 不依赖 websurf-phys） | 无 SAB；**3 个共享单点 import**（批 4 D-08/D-09/D-16：angles / constants / loader，无 auth 通道） | `apps/viewer/crates/wasm/Cargo.toml`（注释"无物理"）、grep `apps/viewer/src` 无 PhysWorld/SharedArrayBuffer；`grep -lE "from .*ts-shared" apps/viewer/src` → 3 文件 |
| dual-mode-harness | 双物理时序验证台 | 双物理实例 + 速度校准（协议独立） | **SAB 192B 专属布局** | `test/dual-mode-harness/src/shared-state.ts:3,109-110`（`SHARED_BUFFER_SIZE=192`，头注明示"不是 ts-shared 那套"） |

## 2. game vs debug（同构中的最小化）

### 2.1 完全同构的部分（共享层保证）

- **Worker 权威线逐组件相同**：`auth-loop`（setTimeout 4ms + 固定步长累积器 + land/blocked 事件）、`worker-dispatch`（同一套消息分支）、`params`（sensitivity=1）、`shared-state`（512B 布局/MsgState）——两侧 import 同一批文件（`apps/game/src/worker/main.ts:21-24` 与 `apps/debug/src/worker/main.ts` 同款）。
- **主线程渲染物理线同构**：debug `renderer-main.ts:441-447` 的 tick 与 game `renderer-main.ts:693-734` 六步一一对应（addInput → correctFromAuthority → calibrateVelocity → predPhys.tick → …→ render），权威校准都收敛 `src/ts-shared/phys/authority-calibrator.ts`。
- **地图加载管线同构**：两侧都用 `buildWorldBundle`（`src/ts-shared/phys/world-builder.ts:90`），game 传 `{decompressMtz, onProgress}`（`apps/game/src/app.ts:406-409`），debug 另有 colliderSource 面板档位。
- **渲染子系统同源**：game 的 optimizeScene/近平面自适应/纹理画质切换注释明示"同步自主项目/主项目同法"（`apps/game/src/renderer/renderer-main.ts:127,808-816`）。

### 2.2 game 砍掉的（debug 特有，均经文件存在性核实）

| debug 特有 | 证据 | game 处置 |
|---|---|---|
| 物理参数定义库 + 物理面板 Worker | `apps/debug/src/physics/param-defs.ts`、`apps/debug/src/worker/physics-worker.ts`（存在） | 不存在；参数直接 `PanelController` → InputBridge 双写（`apps/game/src/input/input-bridge.ts:30-56`） |
| 计时挑战系统（game-state） | `apps/debug/src/game-state.ts`（存在） | 无计时系统（grep `apps/game/src` 仅 `lockTickRate` 注释提及"计时玩法"预留，`apps/game/src/config.ts:81-93`；详见 [implementation/gameplay.md](implementation/gameplay.md) §6） |
| 自定义传送编辑 | `apps/debug/src/world/custom-teleports.ts`（存在） | 仅用 BSP 内建 trigger_teleport（`src/phys/teleport.rs`） |
| 默认纹理包运行时装配 | `apps/debug/src/default-pack.ts`、`apps/debug/src/worker/mtz-data.ts`（存在） | mtz 只作为 `buildWorldBundle` 回退入参（`apps/game/src/app.ts:407` 注入 `decompress_mtz`） |
| Worker 面板消息钩子 | debug `worker/main.ts:110-119`（mtzB64 钩子/onWorldBuilt/onConfigApplied/onExtraMessage） | game `worker/main.ts:80-93` **不传任何 onXxx 钩子**（grep 证实），面板消息走共享 `config` 通道 |
| 渲染调试器 | `apps/debug/src/renderer/{collider-debug,plane-inspector,light-manager,lightmap-shader,fog-manager,lod-manager}.ts`（存在） | game 用固定三点光（`renderer-main.ts:197-204`）+ LOD 距离剔除内联（`:738-764`），PVS 整体禁用（`:82`） |
| 面板偏好分域更细的 config | debug `config.ts:147-230` 共 11 段（physics/player/movement/smoothing/teleport/lod/lighting/input/hud/debug/texture） | game 5 段 + lockTickRate（`apps/game/src/config.ts:92-143`）；`lockTickRate` 为 game 特有公平性预留（grep debug 无此字段） |

### 2.3 game 独有的（debug 没有）

| game 特有 | 证据 |
|---|---|
| `PanelController` 独立类（七模块 + 偏好持久化 + 存点列表渲染） | `apps/game/src/panel/panel-controller.ts`（684 行）；debug 无 panel/ 目录（`ls apps/debug/src` 无 panel/ui，面板逻辑在 `apps/debug/src/app.ts` 直绑 HTML） |
| 存点系统（X 存 / C 按住冻结 / 面板任意读点） | `apps/game/src/savepoint.ts`、`apps/game/src/renderer/renderer-main.ts:601-633`（holdPoint 每帧 set_state 冻结语义） |
| 键位录制重绑面板 | `apps/game/src/input/keymap.ts:42-65`（`websurf-game.keymap.v1`）+ `panel-controller.ts` 按键模块 |
| TICK_RATE_OFFSET=3 隐藏偏移 | `apps/game/src/worker/main.ts:28-32,86`（面板显示原值，权威实际 +3）；grep `apps/debug/src` 无此常量 |
| lockTickRate 公平锁 | `apps/game/src/config.ts:81-93`、`panel-controller.ts:222` |

> 近平面自适应（含面板参数）两侧同有：debug 同样面板化 nearProbeDist/nearRatio（`apps/debug/src/app.ts:116-119`），不算 game 特有——机制注释明示"同步自主项目"（`apps/game/src/renderer/renderer-main.ts:127`）。

## 3. game vs test/dual-mode-harness（协议不同族）

| 维度 | game | dual-mode-harness |
|---|---|---|
| SAB 布局 | ts-shared 512B（`shared-state.ts:104-117`） | harness 专属 192B（`test/dual-mode-harness/src/shared-state.ts:109-110`；头注 `:3` 明示"专属布局、键位掩码位复用 ts-shared"——唯一借用的共享件就是 KEY_MASK，与 scout 矩阵一致） |
| 物理线模型 | 单 Worker 权威 + 主线程渲染线 + 外推校准 | 双物理实例（权威 + Worker-B 预测）+ 速度校准、双槽唤醒 |
| 渲染位置 | 主线程 Three.js（`renderer-main.ts:693-768`） | Worker-B 内 OffscreenCanvas |
| wasm 包 | game/pkg（全量导出 + mosaic） | harness/pkg 运行时最小集仅 5 API（metadata/export_brushes_planes/export_model_phy_colliders\|tri 回退/parse_spawn_points/export_glb_with_pakfile_models）；`parse_teleports/parse_pvs_data` 保留但导出流程不调用、mosaic/缺失纹理未导出（`test/dual-mode-harness/crates/wasm/src/lib.rs:14-20` 头注） |
| 用途 | 可玩游戏 | 时序验证/回归（phys-rate-parity 等脚本对拍对象） |

## 4. game vs viewer（有/无物理的分界）

- viewer crate 不依赖 websurf-phys（`apps/viewer/crates/wasm/Cargo.toml` 注释"无物理"），TS 侧零 SAB、零 ts-shared import（grep 证实；`apps/viewer/src/core/pose.ts:11` 仅注释复用同一 yaw 换算公式）。
- viewer 走薄导出（解析/游览/录像），dist 为 single-only；game 依赖完整物理 + 双通道（SAB 高性能/MsgState 降级）。
- 共同点：地图解析管线同源（websurf-wasm-core）、mosaic 纹理体系共享（viewer 无画质切换需求故不导出 mosaic API——导出面差异见根 [`../wasm-core.md`](../wasm-core.md)）。
- **UI 风格语言同源（本轮迁移，r1 评审放行）**：apps/game/web 视觉层整体采纳 viewer S10 令牌体系——样式自 index.html 内联迁出为独立 `apps/game/web/styles.css`（581 行），:root 令牌对照 `apps/viewer/web/styles.css` 逐一同值（`--panel/--panel-solid/--border/--border-strong/--text/--muted/--accent/--accent-dim/--gold` + `--r-sm..lg` + `--ctrl-bg(.hover)` 交互态；`--bg-app/--success/--danger/--warn` 均系旧表同名令牌重赋值（#1f1f1f/#4ade80/#ff7b83/#f5b93d → #0f1115/#9bd4a6/#ffb4a8/#ffd9a0；--danger 同 viewer 值，--success 为 viewer 无语义绿下的派生绿，--warn = viewer note-warn 文本色令牌化，--bg-app 在 viewer 侧为硬编码 #0f1115 的令牌化）；`--sidebar-w` 无侧栏 N/A），卡片化面板 + 悬停/激活配方对齐；DOM/ID/类名零改动（id 80/80、data-* 14/14、class 30/30 集合零差异）；迁移本体为纯视觉层换血，后续完善轮将 12 处 display/width 状态绑定收编为 class 切换（8 处：#panel.hidden×5/#error.show/.key-rec-hint.show×2/#crosshair.no-dot）+ `--load-pct` 自定义属性驱动（×3，复位走 `removeProperty`）——行为等价，`--ch-*` ×4 令牌写入口径不变；`#fatalOverlay` 历史死元素全清（HTML 注释字样 + styles.css 9 条规则连同节注释 `/* 致命错误覆盖层（Win11 对话框样式） */` 一并清除 + 全仓 JS hook 零残留；对照 git HEAD index.html:575-607）。物理/键位/功能零改动——迁移是纯视觉层换血。

## 5. 与共享层的取舍

- `buildPhysicsParams` 单点下发：game `config.ts:158` 与 `worker/main.ts:42-69` 各自映射同一参数集，`sensitivity:1` 固定（`src/ts-shared/phys/params.ts:57-59`）——灵敏度分叉在结构上不可能（对照 [panel-and-input.md](implementation/panel-and-input.md) §6）。
- `buildWorldBundle` 的 `missingTextures/默认纹理包`：game 只传 `decompressMtz`；debug 额外维护运行时纹理包装配。game 侧 `bundle.missingTextures` 未消费（renderer 仅用 `mosaicManifest`，`apps/game/src/renderer/renderer-main.ts:282-286`）。
- `PhysWorld` 高级 API（tick_into 零分配热路径/state_out_ptr/predict/debug_trace/gate_veto_count）：为 harness/诊断设计，game 全部走 `tick/state` 对象路径（grep `apps/game/src` 无引用；API 清单见 `apps/game/scripts/check-wasm-api.mjs:17-53` 与 [overview.md](overview.md) §6）。
- `worker-types.ts` 的 `teleport-to-pos/set-death-threshold` 协议位：共享 dispatch 支持但 game 不发送（`apps/game/src/input/input-bridge.ts:68` 定义未用；`src/ts-shared/auth/worker-dispatch.ts:198-216` 分支空转）。

## 6. 已知历史残留（写文档时勿引用）

| 残留 | 位置 | 现实 |
|---|---|---|
| "v5 Worker=纯速度修正器"头注 | `apps/game/src/app.ts:4,7` | 代码为 v7 权威帧计算器（`apps/game/src/worker/main.ts:1-16`） |
| predictor-worker 引用 | `apps/game/src/worker/worker-types.ts:6` | 该文件不存在（grep `apps/game/src` 与 `apps/debug/src` 均无 predictor-worker 文件）；v3 双 Worker 预测已废 |
| 协议类型缺项 | `apps/game/src/worker/worker-types.ts` | 未收录 `set-spawn-points/sync-render-state/teleport-to-pos` 等现行消息；运行时协议以 `src/ts-shared/auth/worker-dispatch.ts:79-216` 为准 |
| web/*.js、dist/* 旧产物 | `apps/game/web/`、`apps/game/dist/` | 可能是 v3 时代构建产物，运行前先 `npm run build:ts` / `build-dist.cmd`（`apps/game/README.md` 明示） |
