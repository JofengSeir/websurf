# game 实现：面板与输入系统（I）

> 核对基准：当前 `apps/game/src/input/*`、`apps/game/src/panel/panel-controller.ts`、`apps/game/src/app.ts` 与共享 `src/ts-shared/input/input-layer.ts`、`src/ts-shared/auth/shared-state.ts`。总览见 [../overview.md](../overview.md)，时序见 [../sequences.md](../sequences.md)。

## 1. 输入采集链（mousemove → 物理）

```
window.mousemove（仅锁定时）
  → MouseBuffer.process(movementX, movementY)          src/ts-shared/input/mouse-buffer.ts:56
      ① discardNext：lock 变化后丢弃首个事件（Pointer Lock 初始跳变 2000-5000+ px）  :59-61
      ② 单事件绝对削平 |dx|>MAX_DELTA(1000) → ±1000（保留方向）                      :40,123-126
  → layerMouseDelta(dx, dy, sensitivity)               src/ts-shared/input/input-layer.ts
      灵敏度乘入角度增量（物理两端 sensitivity 恒 1，src/ts-shared/phys/params.ts:57-59）
  → renderer.feedInput(dx, dy, keyboard.getMask())     apps/game/src/app.ts:182-191
      存入 pendingDx/pendingDy/pendingKeys，由 RendererMain.tick 每帧消费
      （apps/game/src/renderer/renderer-main.ts:106-109,506-511,704,710-712）
```

要点：
- MouseBuffer `process()` 是唯一活跃路径，**不缓存**：过滤后立即返回增量；`push()/drain()` 为遗留未用路径（grep `apps/game/src` 无调用点，`mouse-buffer.ts:73-99` 注释自述面向 Worker 旧架构）。
- 键位掩码不随 mousemove 变化重取的问题不存在——`getMask()` 每次实时读取 `KeyboardInput` 状态（`apps/game/src/input/keyboard.ts:105-108`）。
- RendererMain.tick 消费后清空 pending，并**同帧写 SAB 输入槽**（`renderer-main.ts:703-712`），保证权威 Worker 消费与主线程完全相同的输入流。

## 2. 键位系统（录制重绑 + 双层持久化）

### 2.1 键位数据

- `KeyState`（`src/ts-shared/auth/shared-state.ts:36-53`）：forward/back/left/right/jump/duck/sprint/reset/wheelJump/yawLeft/yawRight；`KEY_MASK`（`:56-68`）：forward=1 backward=2 left=4 right=8 jump=16 duck=32 sprint=64 reset=128 wheelJump=256（与 Rust `apply_input` 逐位一致，`src/phys/mod.rs:544` 注释"与 TS KEY_MASK 一致"）。
- `keysToMask(KeyState)` / `maskToKeys(mask)`（`shared-state.ts:70-107`）：rAF 每帧把按键状态折算成掩码写入 SAB。

### 2.2 默认键位与录制（`apps/game/src/input/keymap.ts`）

- `BindableAction = Exclude<keyof KeyState,'wheelJump'>`（`:10-11`）——滚轮跳不可绑定（wheel 事件直接置位 `wheelJumpPending`，`apps/game/src/app.ts:255-257`）。
- `DEFAULT_KEYMAP`（`:28`）与 cs-movement 契约一致；`loadKeymap/saveKeymap/resetKeymap` 走 localStorage `websurf-game.keymap.v1`（`STORAGE_KEY` `:42`，加载时逐字段校验防脏数据 `:45-61`）。
- 面板「按键」模块录制：`KeyboardInput.setKeymap` 热更新（`apps/game/src/input/keyboard.ts:53-56`），`panel-controller.ts:12` 头注；`keyList/keyRecHint/keyReset` 控件（`apps/game/web/index.html` 80 个 id 之列）。录制提示 `keyRecHint` 显隐：初始隐藏由 CSS 基础规则承担（`.key-rec-hint{display:none}`，`apps/game/web/styles.css:552`，原 HTML 行内 `style="display:none"` 已摘除，index.html 零行内样式）；JS 现行 class 切换（`panel-controller.ts:162` `add('show')` / `:182` `remove('show')`）驱动 `.key-rec-hint.show` 钩子（`styles.css:553`）。

### 2.3 按键门控（`apps/game/src/input/keyboard.ts:41-113`）

- `setEnabled(false)` 即 `reset()`（`:58-60`）——退锁/失焦清空状态；`bind(target)` 监听 keydown/keyup，仅 `enabled` 时记账。
- 双保险：退锁后 rAF 输入循环 mask 恒 0（`app.ts:342`），面板内按键不进物理。

## 3. PointerLock（`src/ts-shared/input/pointer-lock.ts`）

- 标准路径：`requestPointerLock(target, {unadjustedMovement:true})` 禁用 OS 鼠标加速（Chromium 114+，`:83-87`，头注引 Three.js r175 PR #30687 同法）。
- 旧浏览器 void 返回 → 依赖 pointerlockchange 事件判定（`:73` 注释降级路径）。
- 3s 超时兜底 `setTimeout(done(false), 3000)`（`:71`）；锁定失败 UI 提示"再次点击画布"（`app.ts:196-200`）。
- 锁定状态变化回调 → `mouseBuffer.onLockChange` + `keyboard.setEnabled` + 面板状态机（`app.ts:222-237`）。

## 4. InputBridge（面板 → 双端物理的参数桥，`apps/game/src/input/input-bridge.ts`）

| 方法 | 行为 | 代码 |
|---|---|---|
| `sendConfig(section, patch)` | 双写：主线程 `renderer.setPredictionParams/hull` + Worker `config` 消息；`player` 段转 `set_hull`、`mode` 只发 Worker | `:30-56`、`worker-dispatch.ts:118-150` |
| `sendRespawn()` | 双端 `respawn()` | `:57-61` |
| `sendTeleport(target)` | 双端 `teleport_to_spawn(idx)`（主线程 `teleportToSpawn` + Worker `teleport`） | `:62-67`、`renderer-main.ts:525-528` |
| `sendSetDeathThreshold(v)` | **已定义未被 game 调用**（grep 全 src 无调用点） | `:68-71` |

## 5. PanelController（ESC 两栏面板，`apps/game/src/panel/panel-controller.ts` 690 行）

> 视觉层在 `apps/game/web/styles.css`（viewer S10 令牌体系）：`#panel` 遮罩 + `.win` 卡片窗口、左导航 `.nav`/`.mod` 悬停/激活交互态、右侧 `.body` 设置体——本节只写 JS 行为；DOM/类名与样式钩子对码见 [../overview.md](../overview.md) §3/§5。

### 5.1 显示状态机

`visible = !pointerLocked || !sceneReady`（`:5,70-75`）：
- 初始（未加载地图）→ 面板必显（提供"加载地图"入口）；
- 选地图 → `panel.hide()` → 加载覆盖层接管（`app.ts:396-397`）；
- 点击画布锁定 → 隐藏；ESC 退锁 → 弹出；
- 加载完成 → `panel.updateVisibility(true)`（`app.ts:472`）；面板「关闭」仅隐藏（M 键手动开关同 `updateVisibility`）。

### 5.2 七模块与绑定

通用（加载地图/重生/出生点）、物理（tickRate 48-128、重力/加速/空加/摩擦/autobhop 等）、体型（半宽 16 / 站高 72 / 蹲高 54，`bindSlider` → `sendConfig('player')` + 主线程 `setPredictionHull`）、按键（录制重绑）、操作（灵敏度/Q-E yawBindSpeed）、显示（准星尺寸/间隙/描边/颜色、速度模式、纹理画质、近平面两参数）、视角（noclip 切换按钮 + noclipSpeed 200-3000）。
- 滑条/输入框双向同步 `bindSlider/bindNearParam`（`apps/game/src/app.ts:293-323`近平面专用绑定）。
- `lockTickRate=true` 时 tickRate 滑条只读锁定 64Hz（`panel-controller.ts:222`，公平性预留）。

### 5.3 持久化（面板偏好，localStorage）

`loadPanelPrefs()`（构造时 `:57-58`）/ `savePanelPrefs()`（各控件 change 调用 `:340-488` 多处）；「体型/物理/操作/显示/视角」偏好保存后即时重放到双端物理。

### 5.4 noclip 切换链

按钮 toggle active → `bridge.sendConfig('physics',{mode:'noclip'|'physics'})`（`:415-423`）→ Worker `set_noclip`（`worker-dispatch.ts:144-147`）+ 主线程 `renderer.setPredictionNoclip`（`renderer-main.ts:662-669`，Rust tick 走 `noclip_step` 无碰撞纯移动，`src/phys/mod.rs:234-235`）。

### 5.5 存点列表

`renderSavePoints(list)` 渲染每行 + 删除/读取按钮（`:651`）；删除回调无确认直接 `savePointStore.delete(i)`（`app.ts:158-161`）；读取回调 `renderer.loadSavepoint(sp)`（`app.ts:162-170`）。

## 6. 面板回调 → 双端落点总表

| 面板回调（app.ts:148-171 注册） | 主线程落点 | Worker 落点 |
|---|---|---|
| onSyncPrediction(params) | `renderer.setPredictionParams` → `predPhys.set_params` | `config` → `syncParamsToWasm` |
| onSyncHull(hw,sh,dh) | `setPredictionHull` → `set_hull` | `config('player')` → `set_hull` |
| onNoclipChange(active) | `setPredictionNoclip` | `config('physics',{mode})` |
| onTextureQualityChange(q) | `renderer.applyTextureQuality(q)`（无 Worker 参与） | — |
| onSyncFov(fov) | `renderer.setFov` | — |
| onSavePointDelete/Load | savePointStore + `loadSavepoint` | — |

> 灵敏度一致性：`sendConfig('input')` 会把 sensitivity 也发 Worker，但物理端参数里 sensitivity 恒 1（`src/ts-shared/phys/params.ts:57-59`）——真实灵敏度在输入层已乘入 dx/dy，双端消费同一份已缩放输入，改灵敏度永不造成双端角度分叉（`apps/game/src/app.ts:187-189` 注释）。
