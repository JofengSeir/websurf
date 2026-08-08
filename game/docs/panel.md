# game 面板与操作模块

## 1. ESC 弹出面板（`panel-controller.ts`）

**显示状态机**（与 Pointer Lock 耦合 + Escape 兜底监听）：

```
初始化（未加载地图）→ 面板【必须显示】（加载地图入口）
加载完成 → 面板隐藏，锁定后显示"点击画布锁定"提示
锁定中 ── ESC（浏览器原生退锁）──→ 面板【弹出】（pointerlockchange 事件驱动）
面板打开：点击「关闭」→ 仅隐藏面板（重新锁定由点击画布触发）
未锁定时按 Escape → 面板展开；按 M 键 → 手动开关（兜底）
```

实现：`visible = !pointerLocked || !sceneReady`；`pointerlockchange` 驱动显示/隐藏；另有显式 Escape keydown（未锁定时展开面板）与 KeyM 监听。

## 2. 面板分区（左导航 `data-mod` + 右 pane `data-pane`）

| Pane | 内容 |
|---|---|
| 通用（general） | 加载地图、状态、出生点下拉、重生 |
| 物理 | tickRate（48-128）、gravity/accelerate/airAccel/friction/maxSpeed/walkSpeed/crouchSpeed/stopSpeed/jumpSpeed、autobhop/bhopSpeedClamp/noPrestrafe、teleportGateTicks |
| 体型 | hull 半宽/站高/蹲高 + 恢复默认 |
| 按键 | 键位列表 + 录制（点击 → 按新键 → 保存 localStorage `websurf-game.keymap.v1`） |
| 操作（look） | 灵敏度、Q/E 旋转速度 |
| 显示 | 准星（显示/颜色/线长/粗细/间隙/描边/中心点）、速度面板模式（横向/横+竖/综合）、**纹理画质**（原始/压缩低清）、近平面参数 |
| 视角（view） | 自由视角（noclip）切换、noclip 移动速度 |

**绑定**：`bindSlider` / `bindCheckbox`（自动保存 prefs）/ 原生 select/button 监听。
**持久化**：`collectPrefs` → `savePanelPrefs`（localStorage `vbsp:panelPrefs`）→ 构造时 `loadPanelPrefs` → `syncControlsFromConfig` 回写控件 → `sendAllPrefs` 双端推送。

## 3. 键位（`input/keymap.ts` + `keyboard.ts`）

- 默认：WASD 移动、空格跳、Ctrl 蹲、Shift 慢走、R 重生、Q/E 转向、M 菜单、滚轮连跳。
- **录制**：面板按键区点选动作 → 按键 → 写入 keymap（localStorage 持久化）→ `KeyboardInput.setKeymap` 即时生效。
- 掩码：forward/back/left/right/jump/duck/sprint/reset/wheelJump/yawLeft/yawRight（与共享层 `apply_input` 位定义一致）。

## 4. noclip（自由视角）

- 面板「自由视角」切换 → `bridge.sendConfig('physics', { mode })`（config 消息；Worker 对 mode patch 调 `set_noclip`，Rust 侧 noclip_step）。
- noclip 速度：面板「视角」pane 可调（200-3000，sprint ×4）。

## 5. 速度面板（HUD，8Hz）

- 数据源：主线程渲染物理 `PhysWorld.state()` 的 vel（零消息）。
- 三模式：横向 `hypot(vx,vz)` / 横+竖 / 综合 `|v|`；0.125s 墙钟门控防闪烁。

## 6. 准星

CSS 变量驱动 4 线 + 中心点（颜色/线长/粗细/间隙/描边/中心点），面板即时生效 + 持久化。

## 7. 物理参数（面板 ↔ 双端）

面板所有"改参数"动作统一走 `config` 消息（`input-bridge.ts`）——主线程渲染物理 `set_params` 即时生效 + Worker 权威 `applyConfigPatch`（v7 隐藏 bug：Worker 必须应用 patch，否则权威永远用默认参数）。
