# implementation：input

主题对应 `apps/debug/src/input/**`，共三个模块：键盘采集 `keyboard.ts`、消息桥 `input-bridge.ts`、录制与回放 `input-recorder.ts`。

## 模块职责

**`apps/debug/src/input/keyboard.ts`**

导出 `KeyboardInput`（`apps/debug/src/input/keyboard.ts:56`）：`bind`（`:82`）、`unbind`（`:90`）、`getState`（`:99`）、`getMask`（`:104`）、`reset`（`:109`）。键位映射表 `KEY_MAP` 是模块私有常量（`apps/debug/src/input/keyboard.ts:19`），把 `KeyboardEvent.code` 映到 `KeyState` 字段；`createEmptyKeyState`（`:39`）产出全假初值。

**`apps/debug/src/input/input-bridge.ts`**

导出 `InputBridge`（`apps/debug/src/input/input-bridge.ts:16`），每个方法只做一次 `worker.postMessage`、一个方法对应一种 `type`：

| 方法 | 消息 `type` | 锚点 |
|---|---|---|
| `sendInit` | `init` | `apps/debug/src/input/input-bridge.ts:20` |
| `sendWorldJson` | `world-json` | `:25` |
| `sendSetSpawnPoints` | `set-spawn-points` | `:35` |
| `sendConfig` | `config` | `:42` |
| `sendRespawn` | `respawn` | `:50` |
| `sendTeleport` | `teleport` | `:55` |
| `sendTeleportToPos` | `teleport-to-pos` | `:60` |
| `sendSetPhysicsParam` | `set-physics-param` | `:65` |
| `sendResetPhysicsParam` | `reset-physics-param` | `:70` |
| `sendSetHull` | `set-hull` | `:75` |
| `sendResetHull` | `reset-hull` | `:80` |
| `sendSetAutoRestoreHull` | `set-auto-restore-hull` | `:85` |
| `sendSetCullDistance` | `set-cull-distance` | `:90` |
| `sendSetDeathThreshold` | `set-death-threshold` | `:95` |

**`apps/debug/src/input/input-recorder.ts`**

导出 8 个类型与 4 个值：

- 类型 / 接口：`InputFrame`（`apps/debug/src/input/input-recorder.ts:53`）、`InputReplayInitialState`（`:65`）、`InputReplayHull`（`:79`）、`InputReplayMeta`（`:89`）、`InputReplayPayload`（`:132`）、`RecorderCounts`（`:142`）、`PlayerState`（`:486`）。
- 值：`INPUT_REPLAY_SCHEMA`（`:50`，取值 `websurf-debug/input-replay@1`）、`InputRecorder`（`:166`）、`InputPlayer`（`:511`）、`keysFromMask`（`:772`）、`compareFrames`（`:797`）。
- 两个告警水位常量：`WARN_FRAMES`（`:152`）、`WARN_STEP`（`:154`）。

`InputRecorder` 公开面：`isRecording`（`:199`）、`start`（`:204`）、`startWithState`（`:215`）、`stop`（`:246`）、`setAlwaysOn`（`:254`）、`clear`（`:259`）、`record`（`:297`）、`counts`（`:316`）、`frames`（`:321`）、`toPayload`（`:334`）、`toJson`（`:348`）、`toCompactPayload`（`:365`）、`load`（`:397`）、`fromJson`（`:442`）。

`InputPlayer` 公开面：`load`（`:539`）、`fromJson`（`:546`）、`adopt`（`:573`）、`isPlaying`（`:578`）、`getMeta`（`:583`）、`start`（`:588`）、`playRealtime`（`:595`）、`playDeterministic`（`:601`）、`isSampleClock`（`:607`）、`setRealtime`（`:612`）、`sampleNow`（`:624`）、`stop`（`:633`）、`seekTo`（`:638`）、`state`（`:645`）、`next`（`:665`）、`stepReplay`（`:699`）、`step`（`:720`）、`frameDt`（`:735`）、`counts`（`:751`）、`isExhausted`（`:756`）。

## 关键流程与不变量

**键盘映射**：只认 `KeyboardEvent.code`；命中映射表时 `preventDefault()`，未命中不改状态也不拦默认行为（`apps/debug/src/input/keyboard.ts:4` 起）。`KeyState.wheelJump` 不在映射表里，它由 `apps/debug/src/app.ts` 的滚轮监听置位（`apps/debug/src/input/keyboard.ts:9`）。

**输入桥只承载低频控制消息**：逐帧输入不走本类——鼠标与按键增量由渲染帧写共享内存输入槽，回退通道才由 `MsgState` 发 `input` 消息（`apps/debug/src/input/input-bridge.ts:4`）。

**录制的存储形态**：热路径不建对象，每样本写五个并行数组（`Float64Array` 的 t / dx / dy / dt 与 `Int32Array` 的 keys）；满则 `grow` 整体翻倍（`apps/debug/src/input/input-recorder.ts:29`、`:265`）。`{t,dx,dy,keys}` 对象只在 `frames` / `toPayload` 里物化（`apps/debug/src/input/input-recorder.ts:31`、`:321`、`:334`）。

**`record` 的五个入参全由调用方给**：本模块不自行采样；`dx` / `dy` 是合并后的鼠标像素增量，`keys` 是按键位掩码，`dtS` 大于 0 才写入、否则写 0（`apps/debug/src/input/input-recorder.ts:19` 起、`:297`）。

**丢帧只发生在墙钟路径**：`next` 按时间戳跳过样本并把跨过的帧数累加进 `skippedFrames`；`step` / `stepReplay` 每次只前进一帧、不跳样本（`apps/debug/src/input/input-recorder.ts:35`、`:665`、`:699`、`:720`）。

**载入失败的语义分两档**：载荷非对象、schema 不符、紧凑格式缺字段、四数组长度不齐、某帧含非有限数、`frameCount` 与实际帧数不符，全部抛错；`InputRecorder.load` 抛出前已把新样本写进数组，`InputPlayer.load` 先解析进临时录制器、成功后才接管（`apps/debug/src/input/input-recorder.ts:42`、`:397`、`:539`）。

**帧序列比对**：`compareFrames` 逐帧比 `t` / `dx` / `dy` / `keys`，返回首个不一致下标与是否全等（`apps/debug/src/input/input-recorder.ts:797`）。

**不变量**：

- schema 字符串是载入侧的硬门：`InputRecorder.load` 与 `loadPlaybackFromJson` 都要求载荷 `schema` 严格等于 `INPUT_REPLAY_SCHEMA`（`apps/debug/src/input/input-recorder.ts:49`、`apps/debug/src/app.ts:967`）。
- 同一 `InputRecorder` 实例的 `alwaysOn` 为真时 `record` 无视 `recording` 落样本；本工程只对 `replayCapture` 置真（`apps/debug/src/input/input-recorder.ts:254`、`apps/debug/src/app.ts:220`）。
- `InputPlayer` 的确定性与实时两条起点互斥，由 `playDeterministic` / `playRealtime` 择一设置（`apps/debug/src/input/input-recorder.ts:594`、`:600`）。
- 步长缺省时 `frameDt` 回落到调用方给的默认值（`apps/debug/src/input/input-recorder.ts:735`）。

## 已知缺口

1. **录制链路未接通（唯一调用点是回放捕获器）**：`InputRecorder.record`（`apps/debug/src/input/input-recorder.ts:297`）在 `apps/debug/src` 内只有一个调用点——`apps/debug/src/app.ts:2395` 的 `replayCapture.record(now, finalDx, finalDy, finalKeys)`，而 `replayCapture` 与 `inputRecorder` 是同文件里的两个不同实例（`apps/debug/src/app.ts:217`、`apps/debug/src/app.ts:219`）。因此用户录制器 `inputRecorder` 永不落样本。
2. **依赖该链路的消费点全部取到 0 帧**：
   - 面板状态行只会显示「未开始」（`apps/debug/src/app.ts:756`），因为 `inputRecorder.counts()` 的 `frames` 恒 0（`apps/debug/src/app.ts:741`）。
   - 导出按钮与 `__wsInput.exportJson()` 导出的 `frames` 恒为空数组（`apps/debug/src/app.ts:924`、`apps/debug/src/app.ts:1057`）。
   - `__wsInput.counts().frames` 恒 0（`apps/debug/src/app.ts:1068`）。
   - 无头验收脚本 `apps/debug/scripts/input-replay-verify.mjs` 的录制相位依赖 `__wsInput.exportJson()`（`apps/debug/scripts/input-replay-verify.mjs:297`）与 `counts().frames`（`apps/debug/scripts/input-replay-verify.mjs:470`、`apps/debug/scripts/input-replay-verify.mjs:510`），两者都取到空载荷；该脚本还直接查询 `#inputRecStatus`（`apps/debug/scripts/input-replay-verify.mjs:461`），而该 id 在页面上不存在。
3. **`dtS` 在本仓调用点被省略**：唯一的 `record` 调用（`apps/debug/src/app.ts:2395`）没有传第 5 个实参，因此写进样本的 `dt` 恒为 0（`apps/debug/src/input/input-recorder.ts:289`、`apps/debug/src/input/input-recorder.ts:305`）。`InputFrame` 也没有 `dt` 字段（`apps/debug/src/input/input-recorder.ts:53`）；步长只存在于并行数组与 `toCompactPayload` 的 `dt` 数组里（`apps/debug/src/input/input-recorder.ts:370`）。
4. **`keysFromMask` 无调用点**：`apps/debug/src/input/input-recorder.ts:772` 的导出在 `apps/debug/src` 与 `src` 内零调用点。
5. **`set-cull-distance` 无接收方**：`sendSetCullDistance`（`apps/debug/src/input/input-bridge.ts:90`）发出的消息在 Worker 侧无人处理。
6. **`InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄**：`adopt` 只被 `load` / `fromJson` 走内部路径（`apps/debug/src/input/input-recorder.ts:541`），`seekTo` 与 `setRealtime` 在 `apps/debug/src` 内无调用点。
