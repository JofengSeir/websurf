# implementation / input（`apps/game/src/input/**`）

## 模块职责

本目录三个文件，分别负责键位表、键盘状态与面板参数下发桥。

| 文件 | 导出清单 | 锚点 |
|---|---|---|
| `apps/game/src/input/keymap.ts` | `BindableAction` 类型、`ACTION_LABELS`、`DEFAULT_KEYMAP`、`loadKeymap`、`saveKeymap`、`resetKeymap`、`codeLabel`、`isBindableCode` | `apps/game/src/input/keymap.ts:20`、`:23`、`:37`、`:56`、`:75`、`:84`、`:95`、`:130` |
| `apps/game/src/input/keyboard.ts` | `KeyboardInput` 类（`bind` / `unbind` / `getState` / `getMask` / `reset` / `setEnabled` / `setKeymap` / `onKeymapChange`） | `apps/game/src/input/keyboard.ts:48`、`:100`、`:108`、`:117`、`:122`、`:127`、`:75`、`:69`、`:64` |
| `apps/game/src/input/input-bridge.ts` | `InputBridge` 类（`addInput` / `sendConfig` / `sendRespawn` / `sendTeleport` / `sendSetDeathThreshold`） | `apps/game/src/input/input-bridge.ts:19`、`:30`、`:41`、`:69`、`:75`、`:83` |

`InputBridge.sendSetDeathThreshold`（`apps/game/src/input/input-bridge.ts:83`）在本工程内**零调用点**：死亡阈值实际由渲染器回调链设定（`apps/game/src/app.ts:163` 注册 `onSceneLoaded` → `apps/game/src/renderer/renderer-main.ts:745` 的 `setDeathY` 只写主线程物理）。

## 关键流程与不变量

- **键位表是单一事实来源**：`BindableAction` = `KeyState` 的字段去掉 `wheelJump`（`apps/game/src/input/keymap.ts:20`）；`DEFAULT_KEYMAP` 给每个动作至少一个 code（`apps/game/src/input/keymap.ts:37`）；面板、HUD 与键盘实例读的是同一份 `loadKeymap()`（`apps/game/src/app.ts:65`、`apps/game/src/app.ts:464`、`apps/game/src/panel/panel-controller.ts:80`）。
- **持久化容错**：读失败或字段不是数组都回落到默认表深拷贝，且**允许某动作的空数组**（等于禁用该动作）（`apps/game/src/input/keymap.ts:56`、`apps/game/src/input/keymap.ts:64`）；写失败静默忽略（`apps/game/src/input/keymap.ts:78`）。
- **反查表方向**：`buildCodeMap` 把 `action → code[]` 反转成 `code → action`，同一 code 绑多个动作时**后写者胜**（`apps/game/src/input/keyboard.ts:20`）。
- **启用门**：`setEnabled(false)` 顺带清空键位状态（`apps/game/src/input/keyboard.ts:77`）；`bind` 会先解绑旧目标，重复调用不会重复挂钩（`apps/game/src/input/keyboard.ts:101`）。
- **位掩码只在共享层换算**：`getMask` 转调 `keysToMask`（`apps/game/src/input/keyboard.ts:123`），位常量定义在 `src/ts-shared/auth/shared-state.ts:67`。
- **两段钳制**：设备原始增量先由共享层的 `MouseBuffer` 削平到 ±1000 像素（`src/ts-shared/input/mouse-buffer.ts:34`），乘灵敏度后再由 `layerMouseDelta` 削平一次（`src/ts-shared/input/input-layer.ts:19`、`src/ts-shared/input/input-layer.ts:31`）。
- **首事件丢弃**：锁定状态变化无条件置丢弃标志，锁定后的第一个 `mousemove` 不产生增量（`src/ts-shared/input/mouse-buffer.ts:124`、`src/ts-shared/input/mouse-buffer.ts:61`）。
- **`sendConfig` 的固定顺序**：① 写本端 config 副本；② `patch` 带 `mode` 时单发一条只含 `mode` 的 `physics` 段消息；③ `player` 段改走 `set_hull` 并返回；④ 其余段构造全量物理参数、写渲染端后以 `config` 消息发出（`apps/game/src/input/input-bridge.ts:42`、`:46`、`:49`、`:58`、`:64`、`:65`）。
- **tickRate 必须显式带**：`physics` 段额外附加 `params.tickRate`，它是 JS 驱动层参数、不进 Rust `set_params`（`apps/game/src/input/input-bridge.ts:62`）。

## 已知缺口

- **`sendConfig` 对非 `player` 段下发的载荷不是该段的内容**：段名原样保留，但 `patch` 是全量物理参数（`apps/game/src/input/input-bridge.ts:57`、`apps/game/src/input/input-bridge.ts:65`）。对 `hud` 段的后果是 Worker 侧 `applyConfigPatch('hud', …)` 把 `gravity` 等键并入 `config.hud`（`src/ts-shared/auth/worker-dispatch.ts:346`、`:351`），而 Worker 不读 `hud` 段，静态看无行为影响；调用方四处段名见 `apps/game/src/app.ts:642`。
- **`addInput` 是显式空实现**：三个实参全部被丢弃（`apps/game/src/input/input-bridge.ts:30`、`:31`），本工程唯一调用点在退锁处理里（`apps/game/src/app.ts:288`）；真正清权威键位的两处是同一函数里的 `sharedState?.addInput(0, 0, 0)`（`apps/game/src/app.ts:306`）与下一帧输入循环写入的掩码（`apps/game/src/app.ts:400`）。
- **`sendSetDeathThreshold` 零调用点**：方法完整实现（`apps/game/src/input/input-bridge.ts:83`），但 `apps/game/src` 内没有调用者；权威侧的死亡阈值因此不会被主动下发，权威保持 `PhysWorld` 构造时的初值 `-100_000.0`（`src/phys/mod.rs:165`）。
- **`requestLock` 的返回值类型检查恒真**：`requestLock` 的签名固定返回 `Promise<boolean>`（`src/ts-shared/input/pointer-lock.ts:63`，已锁定时也在 `src/ts-shared/input/pointer-lock.ts:65` 立即解析），而调用方用 `p instanceof Promise` 判门（`apps/game/src/app.ts:253`）——该判断在当前类型下恒为真，失败提示恒挂 promise 回调而不是走 else 分支。
- **共享层的累积路径无消费方**：`MouseBuffer` 的 `push` / `drain` 在本仓 `apps/**` 与 `src/**` 内零调用点（`src/ts-shared/input/mouse-buffer.ts:81`、`:102`），本工程用的是不累积的 `process`（`apps/game/src/app.ts:230`）。
- **键位表的三份内存副本**：键盘实例（`apps/game/src/input/keymap.ts:56` 的调用点 `apps/game/src/app.ts:65`）、HUD 标签刷新（`apps/game/src/app.ts:464`）、面板控制器（`apps/game/src/panel/panel-controller.ts:80`）各持一份；提交改键后靠 `setKeymap` 与 `onKeymapChange` 回调同步（`apps/game/src/panel/panel-controller.ts:256`、`apps/game/src/app.ts:70`），三者一致由这条回调链维持。
- **不可绑定的 code 只有三个**：`Escape` 与左右 Meta（`apps/game/src/input/keymap.ts:127`）；修饰键都可绑定，因此把蹲绑到 Shift 这类组合是允许的（默认表即如此，`apps/game/src/input/keymap.ts:43`）。
