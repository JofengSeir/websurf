# implementation：根级装配模块

主题对应 `apps/debug/src` 根目录下的六个模块：`app.ts`、`config.ts`、`game-state.ts`、`default-pack.ts`、`main-wasm.ts`、`wasm.d.ts`。

## 模块职责

**`apps/debug/src/app.ts`（无导出，纯副作用入口模块）**

主线程装配入口。它不导出任何符号，全部接线在模块顶层完成：

- 全局状态：`config`（`apps/debug/src/app.ts:59`）、DOM 句柄表 `dom`（`apps/debug/src/app.ts:61`）、`keyboard` / `mouseBuffer` / `pointerLock`（`apps/debug/src/app.ts:171` 起）、`worker` / `inputBridge` / `sharedState`（`apps/debug/src/app.ts:175` 起）、`rendererMain`（`apps/debug/src/app.ts:185`）、计时状态机 `game`（`apps/debug/src/app.ts:189`）。
- 回放两件套（2026-09-26 起）：回放捕获器 `replayCapture`（`apps/debug/src/app.ts:211`，随即 `setAlwaysOn(true)`）、回放器 `inputPlayer`（`apps/debug/src/app.ts:214`）。原「用户录制器 `inputRecorder`」已随死链删除——它全仓没有 `record` 调用点，导出恒为空载荷。
- 主流程函数：`main`（`apps/debug/src/app.ts:266`）、`handleWorkerMessage`（`apps/debug/src/app.ts:374`）、`handleBspFile` / `handleLoadBsp`（`apps/debug/src/app.ts:1728` / `apps/debug/src/app.ts:1763`）、`bindInput`（`apps/debug/src/app.ts:1055`）、`bindUI`（`apps/debug/src/app.ts:1248`）、`startInputLoop`（`apps/debug/src/app.ts:2183`）、`syncFullConfig`（`apps/debug/src/app.ts:2310`）。
- 永久调试 API：`globalThis.__wsInput`（`apps/debug/src/app.ts:910`），删除清单与契约写在同一文件 `apps/debug/src/app.ts:914` 起的注释。2026-09-26 移除的成员：`start` / `stop` / `clear` / `isRecording` / `exportJson` / `status` 与 `counts()` 的 `recording` / `frames`（原 `status` 改名为 `progress`，返回回放进度）。
- 面板侧辅助：HUD 刷新（`apps/debug/src/app.ts:540`、`apps/debug/src/app.ts:603`、`apps/debug/src/app.ts:1015`）、路径点计数（`apps/debug/src/app.ts:621`）、物理面板初始化（`apps/debug/src/app.ts:1997`）、快照回填与镜像（`apps/debug/src/app.ts:2117`、`apps/debug/src/app.ts:2171`）、权威健康控制台（`apps/debug/src/app.ts:2350`）。

**`apps/debug/src/config.ts`（配置树的唯一定义处）**

导出 10 个接口 + 3 个值：

- 段接口：`PhysicsConfig`（`apps/debug/src/config.ts:12`）、`PlayerConfig`（`apps/debug/src/config.ts:40`）、`LodConfig`（`apps/debug/src/config.ts:59`）、`LightingConfig`（`apps/debug/src/config.ts:66`）、`InputConfig`（`apps/debug/src/config.ts:92`）、`CrosshairConfig`（`apps/debug/src/config.ts:105`）、`HudConfig`（`apps/debug/src/config.ts:120`）、`DebugConfig`（`apps/debug/src/config.ts:129`）、`TextureConfig`（`apps/debug/src/config.ts:161`）、`RuntimeConfig`（`apps/debug/src/config.ts:167`）。原 `MovementConfig` / `SmoothingConfig` / `TeleportConfig` 三段已随 2026-09-26 的死链清理整体删除（删除说明见 `LodConfig` 上方 `apps/debug/src/config.ts:51` 起的注释）。
- 值：`DEFAULT_CONFIG`（`apps/debug/src/config.ts:187`）、`createConfig`（`apps/debug/src/config.ts:268`，`structuredClone` 深拷贝）、`applyConfigPatch`（`apps/debug/src/config.ts:273`，按段 `Object.assign`）。

**`apps/debug/src/game-state.ts`（计时挑战状态机）**

导出 `GamePhase`（`apps/debug/src/game-state.ts:16`）、`Checkpoint`（`apps/debug/src/game-state.ts:19`）、`GameSnapshot`（`apps/debug/src/game-state.ts:31`）、`GameState`（`apps/debug/src/game-state.ts:60`）、`formatTime`（`apps/debug/src/game-state.ts:187`）。全仓唯一实例是 `apps/debug/src/app.ts:199` 的 `game`。

**`apps/debug/src/default-pack.ts`**

只导出 `loadDefaultTexturePack`（`apps/debug/src/default-pack.ts:22`）：取内嵌 base64 或按 `DEFAULT_TEXTURE_PACK_URL` fetch，再调 `decompress_mtz` 解出「材质名 → mosaic 字节码」表并缓存。唯一消费点是缺失纹理弹窗（`apps/debug/src/app.ts:494`）。

**`apps/debug/src/main-wasm.ts`**

导出 `mainWasmUrl`（`apps/debug/src/main-wasm.ts:20`）、`ensureMainWasm`（`apps/debug/src/main-wasm.ts:28`），并转发 `mosaic_decode` 与 `decompress_mtz`（`apps/debug/src/main-wasm.ts:47`）。

**`apps/debug/src/wasm.d.ts`（手写环境声明）**

两条 `declare module` 通配声明：`*/pkg/websurf_wasm.js`（`apps/debug/src/wasm.d.ts:19`，含 `initSync`、`BspProcessor`、`PhysWorld` 与四个自由函数）与 `*/pkg/websurf_wasm_bg.js`（`apps/debug/src/wasm.d.ts:143`，只有默认导出）。

## 关键流程与不变量

**面板接线（`bindUI`）**：所有控件都先判空再绑（`dom.X?.addEventListener`），因此页面缺某个 id 只表现为该控件失效，不抛错。例：路径记录四个分量复选框分别绑到 `setPathRenderVisible` / `setPathTickVisible` / `setPathDeviVisible` / `setPathDotsVisible`（`apps/debug/src/app.ts:695` 起）；录制面板已随死链删除（见已知缺口第 3 项），回放没有面板按钮，唯一入口是 `__wsInput`（`apps/debug/src/app.ts:915` 起）的 `load` / `play` / `stopPlay`。

**配置双份与反向同步**：主线程与 Worker 各持一份 `createConfig()` 深拷贝（`apps/debug/src/config.ts:3`）。主线程改配置时先 `applyConfigPatch` 就地改自己的副本，再用 `sendConfig(section, patch)` 下发同一份 patch（`apps/debug/src/input/input-bridge.ts:42`）；`syncFullConfig` 一次性把全部段发给 Worker（`apps/debug/src/app.ts:2324`）。

**面板偏好持久化**：键 `vbsp:uiPrefs`、版本常量 `UI_PREFS_VERSION` 为 2，版本不符即丢弃旧持久化（`apps/debug/src/app.ts:1131`、`apps/debug/src/app.ts:1137`、`apps/debug/src/app.ts:1168`）。

**权威健康控制台**：日志用 `unshift` 置顶、上限 30 条，同时刷新 `#health-log` 与 `#health-count`（`apps/debug/src/app.ts:2350`）；清空按钮在 `apps/debug/src/app.ts:2359` 就地查询并绑定。

**不变量**：

- `DEFAULT_CONFIG` 是冻结前的唯一真值源，任何调用方拿到的是深拷贝（`apps/debug/src/config.ts:268`），改自己的副本不会污染默认值。
- `applyConfigPatch` 只做段级浅合并，段不存在或非对象时直接返回（`apps/debug/src/config.ts:278`）。
- 主线程 wasm 初始化的 Promise 只在成功时保留；失败时置回 `null` 以便重试（`apps/debug/src/main-wasm.ts:38`）。
- `game` 的状态迁移只由两处驱动：输入循环里速度平方大于 1 时 `onPlayerMove`（`apps/debug/src/app.ts:2303`），以及渲染物理事件回调 `onRenderPhysEvent` 里的 `onTeleport` / `onDeath`（`apps/debug/src/app.ts:1957`）。

## 已知缺口（状态见 TODO.md）

1. ~~**`dom` 表里被查询的 id 有九个在页面上不存在**~~ **已全部处置（2026-09-26）**：`pathVisibleChk`、`pvsEnabled` 与录制面板七个 id 三条死链均已删除（见本节已知缺口第 10–12 项）。`apps/debug/src/app.ts:61` 起的 `dom` 表通过 `document.getElementById` 取句柄，实测页面 `apps/debug/web/index.html` 共 106 个 id；原缺的九个查询（全部标了 `| null`，故只表现为控件失效）连同句柄与消费者一并删除，以下按删除时的符号留档（代码已不在，行号从略）：
   - 录制面板七个：`inputRecStatus` / `inputRecToggleBtn` / `inputRecClearBtn` / `inputRecExportBtn` / `inputRecLoadBtn` / `inputRecStopPlayBtn` / `inputRecFile`，其消费者 `updateInputRecUi`、四个按钮监听与 `__wsInput.status()` / `__wsInput.clear()` 同步删除。
   - `pathVisibleChk`：唯一的消费者是其 change 监听（永不触发）；页面上的路径显隐实际由四个分量复选框承担（`apps/debug/web/index.html:607`、`apps/debug/web/index.html:610`、`apps/debug/web/index.html:614`、`apps/debug/web/index.html:618`）。
   - `pvsEnabled`：三个消费者（初始同步 / 场景就绪同步 / change 监听）与 `config.lod.pvsEnabled` 字段及其默认值一并删除；页面「渲染与视距」区不提供该开关（`apps/debug/web/index.html:531`）。
2. **`clearTeleportsBtn` 不是缺失 id**：它在 `renderCustomTeleports` 里由 `innerHTML` 动态生成（`apps/debug/src/app.ts:1920`），随后才被查询并绑定（`apps/debug/src/app.ts:1934`）。列表为空时该函数提前返回（`apps/debug/src/app.ts:1915`），因此该按钮在无传送点时不存在。
3. ~~**录制链路未接通**~~ **已处置（2026-09-26，删链）**：`InputRecorder.record` 在 `apps/debug/src` 内唯一的调用点始终是回放分支的 `replayCapture.record(...)`（`apps/debug/src/app.ts:2255`），用户录制器 `inputRecorder` 从不落样本 ⇒ 随链路一并删除（连同 `updateInputRecUi`、`startRecording` / `stopRecording`、`buildReplayMeta`、面板六个按钮监听、`__wsInput` 的 `start` / `stop` / `clear` / `isRecording` / `exportJson` / `status`）。**现状**：录制产物只能由外部工具生成，本页只承担**回放**（`__wsInput.load` → `play` → `stopPlay`，进度看 `__wsInput.progress()`）；回放捕获器 `replayCapture` 仍由回放分支落样本，供确定性自检比对。
4. **`wasm.d.ts` 的 `PhysWorld` 声明落后于源码**：声明里只有 17 个成员（`apps/debug/src/wasm.d.ts:86` 起），而 `src/phys/mod.rs` 的 `impl` 有 24 个 `pub fn`。缺 `tick_into`、`state_out_ptr`、`set_state_ex`、`state_full_json`、`seed_from`、`gate_veto_count`、`debug_trace` 七项。因此调用 `state_full_json` / `set_state_ex` 只能先做运行时收窄（`apps/debug/src/renderer/renderer-main.ts:1234`、`apps/debug/src/renderer/renderer-main.ts:1251`）。**已消除（2026-10-09）**：T-007 —— 声明已补齐 16 项（33 个成员与产物逐名一致），两处运行时收窄已删。
5. **`tick_into` / `state_out_ptr` / `seed_from` 在本工程无装配点**：三者在 `apps/debug/src` 内零出现；全仓唯一的调用方是共享层 `src/ts-shared/auth/tick-authority.ts` 与 `src/ts-shared/decoupled/decoupled-loop.ts`，而这两个控制器在三个工程内都没有装配点。本工程的零分配路径未接线，实际走 `tick()` 返回对象。（见 TODO.md T-006）
6. **`set_yaw_pitch` 零调用点**：`apps/debug/src/wasm.d.ts:126` 只有一行类型声明，`apps/debug/src` 与 `src` 内都没有调用点（`src/phys/mod.rs` 的该导出同样无调用方）。（见 TODO.md T-009）
7. ~~**`MovementConfig` / `SmoothingConfig` / `TeleportConfig` 三个段在本仓无读取点**~~ **已处置（2026-09-26，删字段）**：三段当时在 `apps/debug/src` 与 `src` 内零读取点、页面也无控件，已从 `apps/debug/src/config.ts` 整体删除（接口定义与 `DEFAULT_CONFIG` 条目一并移除），`syncFullConfig` 不再下发它们；删除说明见 `LodConfig` 上方 `apps/debug/src/config.ts:51` 起的注释。传送判定实际用的半径与冷却见第 11 项。
8. **`tsconfig.json` 的五个路径别名零导入点**：`apps/debug/tsconfig.json:19` 起声明 `@physics/*` / `@world/*` / `@renderer/*` / `@input/*` / `@worker/*`，而 `apps/debug/src` 内全部内部引用都写成相对路径。 （见 TODO.md T-312）
9. **`PhysicsConfig.teleportGateTicks` 不改变行为**：该键经参数映射写进 `set_params` 的 `teleport_gate_ticks`，但 `src/phys/teleport.rs` 的判定函数形参带下划线且函数体不读它；本工程侧的相关说明见 `apps/debug/src/config.ts:34`。（见 TODO.md T-010）
10. ~~**`pvsEnabled` 的语义与面板不同步**~~ **已处置（2026-09-26，删链）**：剔除路径只有距离判据（`apps/debug/src/renderer/lod-manager.ts` 的 `update`），该字段既不参与判定、页面也无控件 ⇒ 整条链删除：`dom.pvsEnabledChk` 绑定与三处消费者（初始同步 / 场景就绪同步 / change 监听）、`config.lod.pvsEnabled` 字段与其默认值一并移除，`syncFullConfig` 的段清单同步收敛。**剔除行为的现状不变**：只按「块中心到相机距离 > `cullDistance`」判定。
11. ~~**`MovementConfig` / `SmoothingConfig` / `TeleportConfig` / `physics.duckScale` 无读取点**~~ **已处置（2026-09-26，删字段）**：见上方第 7 项；四个段/字段已从 `RuntimeConfig` 与 `DEFAULT_CONFIG` 移除，`syncFullConfig` 不再下发它们。传送判定实际用的半径与冷却仍是 `apps/debug/src/world/teleport-manager.ts` 的模块常量 `TRIGGER_RADIUS`（64 HU）与 `TRIGGER_COOLDOWN`（0.5 s）；地面速度上限仍由 `PhysicsConfig.maxSpeed` 经 `set_params` 的 `run_speed` 决定。
12. ~~**`setPathVisible` / `#pathVisibleChk` 死链**~~ **已处置（2026-09-26，删链）**：页面不存在该 id，且路径显隐已由四个分量复选框承担 ⇒ 删除 `dom.pathVisibleChk` 绑定与其 change 监听、`RendererMain.setPathVisible`、`PathRecorder.setVisible`。四个分量开关保留（`apps/debug/web/index.html:607`、`:610`、`:614`、`:618`）。
- 看板另有登记项：`TODO.md` 的 T-064 —— **状态与结论只在那登记**，本文件不复述。
