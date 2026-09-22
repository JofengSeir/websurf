# implementation：根级装配模块

主题对应 `apps/debug/src` 根目录下的六个模块：`app.ts`、`config.ts`、`game-state.ts`、`default-pack.ts`、`main-wasm.ts`、`wasm.d.ts`。

## 模块职责

**`apps/debug/src/app.ts`（无导出，纯副作用入口模块）**

主线程装配入口。它不导出任何符号，全部接线在模块顶层完成：

- 全局状态：`config`（`apps/debug/src/app.ts:59`）、DOM 句柄表 `dom`（`apps/debug/src/app.ts:61`）、`keyboard` / `mouseBuffer` / `pointerLock`（`apps/debug/src/app.ts:180` 起）、`worker` / `inputBridge` / `sharedState`（`apps/debug/src/app.ts:184` 起）、`rendererMain`（`apps/debug/src/app.ts:194`）、计时状态机 `game`（`apps/debug/src/app.ts:198`）。
- 录制 / 回放三件套：用户录制器 `inputRecorder`（`apps/debug/src/app.ts:217`）、回放捕获器 `replayCapture`（`apps/debug/src/app.ts:219`，随即 `setAlwaysOn(true)`）、回放器 `inputPlayer`（`apps/debug/src/app.ts:222`）。
- 主流程函数：`main`（`apps/debug/src/app.ts:278`）、`handleWorkerMessage`（`apps/debug/src/app.ts:389`）、`handleBspFile` / `handleLoadBsp`（`apps/debug/src/app.ts:1881` / `apps/debug/src/app.ts:1916`）、`bindInput`（`apps/debug/src/app.ts:1191`）、`bindUI`（`apps/debug/src/app.ts:1386`）、`startInputLoop`（`apps/debug/src/app.ts:2337`）、`syncFullConfig`（`apps/debug/src/app.ts:2470`）。
- 永久调试 API：`globalThis.__wsInput`（`apps/debug/src/app.ts:1044`），契约清单写在同一文件 `apps/debug/src/app.ts:984` 起。
- 面板侧辅助：HUD 刷新（`apps/debug/src/app.ts:555`、`apps/debug/src/app.ts:618`、`apps/debug/src/app.ts:1149`）、路径点计数（`apps/debug/src/app.ts:636`）、物理面板初始化（`apps/debug/src/app.ts:2137`）、快照渲染与镜像（`apps/debug/src/app.ts:2257`、`apps/debug/src/app.ts:2311`）、权威健康控制台（`apps/debug/src/app.ts:2499`）。

**`apps/debug/src/config.ts`（配置树的唯一定义处）**

导出 13 个接口 / 类型 + 3 个值：

- 段接口：`PhysicsConfig`（`apps/debug/src/config.ts:12`）、`PlayerConfig`（`apps/debug/src/config.ts:41`）、`MovementConfig`（`apps/debug/src/config.ts:53`）、`SmoothingConfig`（`apps/debug/src/config.ts:61`）、`TeleportConfig`（`apps/debug/src/config.ts:67`）、`LodConfig`（`apps/debug/src/config.ts:75`）、`LightingConfig`（`apps/debug/src/config.ts:84`）、`InputConfig`（`apps/debug/src/config.ts:110`）、`CrosshairConfig`（`apps/debug/src/config.ts:123`）、`HudConfig`（`apps/debug/src/config.ts:138`）、`DebugConfig`（`apps/debug/src/config.ts:147`）、`TextureConfig`（`apps/debug/src/config.ts:173`）、`RuntimeConfig`（`apps/debug/src/config.ts:179`）。
- 值：`DEFAULT_CONFIG`（`apps/debug/src/config.ts:205`）、`createConfig`（`apps/debug/src/config.ts:299`，`structuredClone` 深拷贝）、`applyConfigPatch`（`apps/debug/src/config.ts:304`，按段 `Object.assign`）。

**`apps/debug/src/game-state.ts`（计时挑战状态机）**

导出 `GamePhase`（`apps/debug/src/game-state.ts:16`）、`Checkpoint`（`apps/debug/src/game-state.ts:19`）、`GameSnapshot`（`apps/debug/src/game-state.ts:31`）、`GameState`（`apps/debug/src/game-state.ts:60`）、`formatTime`（`apps/debug/src/game-state.ts:187`）。全仓唯一实例是 `apps/debug/src/app.ts:198` 的 `game`。

**`apps/debug/src/default-pack.ts`**

只导出 `loadDefaultTexturePack`（`apps/debug/src/default-pack.ts:22`）：取内嵌 base64 或按 `DEFAULT_TEXTURE_PACK_URL` fetch，再调 `decompress_mtz` 解出「材质名 → mosaic 字节码」表并缓存。唯一消费点是缺失纹理弹窗（`apps/debug/src/app.ts:509`）。

**`apps/debug/src/main-wasm.ts`**

导出 `mainWasmUrl`（`apps/debug/src/main-wasm.ts:20`）、`ensureMainWasm`（`apps/debug/src/main-wasm.ts:28`），并转发 `mosaic_decode` 与 `decompress_mtz`（`apps/debug/src/main-wasm.ts:47`）。

**`apps/debug/src/wasm.d.ts`（手写环境声明）**

两条 `declare module` 通配声明：`*/pkg/websurf_wasm.js`（`apps/debug/src/wasm.d.ts:19`，含 `initSync`、`BspProcessor`、`PhysWorld` 与四个自由函数）与 `*/pkg/websurf_wasm_bg.js`（`apps/debug/src/wasm.d.ts:137`，只有默认导出）。

## 关键流程与不变量

**面板接线（`bindUI`）**：所有控件都先判空再绑（`dom.X?.addEventListener`），因此页面缺某个 id 只表现为该控件失效，不抛错。例：路径记录五个复选框分别绑到 `setPathVisible` / `setPathRenderVisible` / `setPathTickVisible` / `setPathDeviVisible` / `setPathDotsVisible`（`apps/debug/src/app.ts:693` 起），录制面板四个按钮与一个文件输入分别绑到 `startRecording` / `stopRecording` / `clear` / `toJson` / `loadPlaybackFromJson`（`apps/debug/src/app.ts:909` 起）。

**配置双份与反向同步**：主线程与 Worker 各持一份 `createConfig()` 深拷贝（`apps/debug/src/config.ts:3`）。主线程改配置时先 `applyConfigPatch` 就地改自己的副本，再用 `sendConfig(section, patch)` 下发同一份 patch（`apps/debug/src/input/input-bridge.ts:42`）；`syncFullConfig` 一次性把全部段发给 Worker（`apps/debug/src/app.ts:2470`）。

**面板偏好持久化**：键 `vbsp:uiPrefs`、版本常量 `UI_PREFS_VERSION` 为 2，版本不符即丢弃旧持久化（`apps/debug/src/app.ts:1265`、`apps/debug/src/app.ts:1271`、`apps/debug/src/app.ts:1297`）。

**权威健康控制台**：日志用 `unshift` 置顶、上限 30 条，同时刷新 `#health-log` 与 `#health-count`；清空按钮在 `apps/debug/src/app.ts:2508` 就地查询并绑定。

**不变量**：

- `DEFAULT_CONFIG` 是冻结前的唯一真值源，任何调用方拿到的是深拷贝（`apps/debug/src/config.ts:299`），改自己的副本不会污染默认值。
- `applyConfigPatch` 只做段级浅合并，段不存在或非对象时直接返回（`apps/debug/src/config.ts:309`）。
- 主线程 wasm 初始化的 Promise 只在成功时保留；失败时置回 `null` 以便重试（`apps/debug/src/main-wasm.ts:38`）。
- `game` 的状态迁移只由两处驱动：输入循环里速度平方大于 1 时 `onPlayerMove`（`apps/debug/src/app.ts:2448`），以及渲染物理事件回调里的 `onTeleport` / `onDeath`（`apps/debug/src/app.ts:2098` 起）。

## 已知缺口

1. **`dom` 表里被查询的 id 有九个在页面上不存在**。`apps/debug/src/app.ts:61` 起的 `dom` 表通过 `document.getElementById` 取句柄，实测页面 `apps/debug/web/index.html` 共 106 个 id，其中缺以下九个（全部标了 `| null`，故只表现为控件失效）：
   - 录制面板七个：`inputRecStatus`（`apps/debug/src/app.ts:119`）、`inputRecToggleBtn`（`apps/debug/src/app.ts:120`）、`inputRecClearBtn`（`apps/debug/src/app.ts:121`）、`inputRecExportBtn`（`apps/debug/src/app.ts:122`）、`inputRecLoadBtn`（`apps/debug/src/app.ts:123`）、`inputRecStopPlayBtn`（`apps/debug/src/app.ts:124`）、`inputRecFile`（`apps/debug/src/app.ts:125`）。这七个句柄的消费者是 `updateInputRecUi`（`apps/debug/src/app.ts:740`）、四个按钮监听（`apps/debug/src/app.ts:909` 起）、`__wsInput.status()`（`apps/debug/src/app.ts:1106`）与 `__wsInput.clear()`（`apps/debug/src/app.ts:1050`）。
   - `pathVisibleChk`（`apps/debug/src/app.ts:112`）：唯一的消费者是 `apps/debug/src/app.ts:710` 的 change 监听，因此该监听永不触发；页面上的路径显隐实际由另外四个复选框承担（`apps/debug/web/index.html:410`、`apps/debug/web/index.html:413`、`apps/debug/web/index.html:417`、`apps/debug/web/index.html:421`）。
   - `pvsEnabled`（`apps/debug/src/app.ts:95`）：三个消费者分别是初始同步（`apps/debug/src/app.ts:376`）、场景就绪同步（`apps/debug/src/app.ts:457`）与 change 监听（`apps/debug/src/app.ts:1481`）。页面「渲染与视距」区不提供该开关（`apps/debug/web/index.html:333`）；`config.lod.pvsEnabled` 的默认值在 `apps/debug/src/config.ts:243`。
2. **`clearTeleportsBtn` 不是缺失 id**：它在 `renderCustomTeleports` 里由 `innerHTML` 动态生成（`apps/debug/src/app.ts:2059`），随后才被查询并绑定（`apps/debug/src/app.ts:2075`）。列表为空时该函数提前返回（`apps/debug/src/app.ts:2051`），因此该按钮在无传送点时不存在。
3. **录制链路未接通**：`InputRecorder.record`（`apps/debug/src/input/input-recorder.ts:297`）在 `apps/debug/src` 内只有一个调用点——回放分支里的 `replayCapture.record(...)`（`apps/debug/src/app.ts:2395`）。用户录制器 `inputRecorder` 从不落样本，因此 `inputRecorder.counts().frames` 恒为 0（`apps/debug/src/app.ts:741`、`apps/debug/src/app.ts:1068`），`__wsInput.exportJson()` 导出的载荷 `frames` 恒为空（`apps/debug/src/app.ts:1057`），「开始录制」后状态行只会停在 0 帧（`apps/debug/src/app.ts:750`）。
4. **`wasm.d.ts` 的 `PhysWorld` 声明落后于源码**：声明里只有 17 个成员（`apps/debug/src/wasm.d.ts:80` 起），而 `src/phys/mod.rs` 的 `impl` 有 24 个 `pub fn`。缺 `tick_into`、`state_out_ptr`、`set_state_ex`、`state_full_json`、`seed_from`、`gate_veto_count`、`debug_trace` 七项。因此调用 `state_full_json` / `set_state_ex` 只能先做运行时收窄（`apps/debug/src/renderer/renderer-main.ts:1272`、`apps/debug/src/renderer/renderer-main.ts:1289`）。
5. **`tick_into` / `state_out_ptr` / `seed_from` 在本工程无装配点**：三者在 `apps/debug/src` 内零出现；全仓唯一的调用方是共享层 `src/ts-shared/auth/tick-authority.ts` 与 `src/ts-shared/decoupled/decoupled-loop.ts`，而这两个控制器在三个工程内都没有装配点。本工程的零分配路径未接线，实际走 `tick()` 返回对象。
6. **`set_yaw_pitch` 零调用点**：`apps/debug/src/wasm.d.ts:120` 只有一行类型声明，`apps/debug/src` 与 `src` 内都没有调用点（`src/phys/mod.rs` 的该导出同样无调用方）。
7. **`MovementConfig` / `SmoothingConfig` / `TeleportConfig` 三个段在本仓无读取点**：`config.movement`、`config.smoothing`、`config.teleport` 在 `apps/debug/src` 与 `src` 内零命中；三段仍随 `syncFullConfig` 下发到 Worker。相关说明见 `apps/debug/src/config.ts:52`、`apps/debug/src/config.ts:60`、`apps/debug/src/config.ts:66`。
8. **`tsconfig.json` 的五个路径别名零导入点**：`apps/debug/tsconfig.json:19` 起声明 `@physics/*` / `@world/*` / `@renderer/*` / `@input/*` / `@worker/*`，而 `apps/debug/src` 内全部内部引用都写成相对路径。
9. **`PhysicsConfig.teleportGateTicks` 不改变行为**：该键经参数映射写进 `set_params` 的 `teleport_gate_ticks`，但 `src/phys/teleport.rs` 的判定函数形参带下划线且函数体不读它；本工程侧的相关说明见 `apps/debug/src/config.ts:34`。
10. **`pvsEnabled` 的语义与面板不同步**：即使该 id 存在，剔除路径也不读它——`apps/debug/src/renderer/lod-manager.ts` 的 `update` 只有距离判据，PVS 开关只落进 config 与发往 Worker 的 `config` 消息（`apps/debug/src/config.ts:76`）。
