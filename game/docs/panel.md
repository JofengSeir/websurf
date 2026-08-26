# game 面板与操作模块

> 最后核对：2026-08-24。以实际代码为准（`game/src/panel/`、`game/src/input/`、`game/web/index.html`）。

## 1. ESC 弹出面板（`panel-controller.ts`）

**显示状态机**（与 Pointer Lock 耦合 + Escape 兜底监听）：

```
初始化（未加载地图）→ 面板【必须显示】（加载地图入口）
选择地图 → panel.hide() 强制隐藏 → #loadingOverlay 进度覆盖层接管
覆盖层：阶段→百分比（LOAD_STAGE_PCT）+ rAF 平滑补间；失败 → .error 红态不自动消失
加载完成 → 覆盖层隐藏 → 面板 updateVisibility(true) → 点击画布请求指针锁定
锁定中 ── ESC（浏览器原生退锁）──→ 面板【弹出】（pointerlockchange 事件驱动）
面板内「关闭」→ 仅隐藏面板（重新锁定由点击画布触发）
未锁定时按 Escape → 面板展开；按 M 键 → 手动开关（兜底）
```

实现：`visible = !pointerLocked || !sceneReady`；`pointerlockchange` 驱动显示/隐藏；另有显式 Escape keydown（未锁定时展开面板）与 KeyM 监听。
初始可见性留白补充：构造函数不调用 `updateVisibility`（panel-controller.ts:53-67）——未加载地图时的「必须显示」由 HTML 默认样式（面板初始可见）保证，首次 `updateVisibility` 在场景就绪后触发。
加载覆盖层实现：`app.ts` `showLoading` / `advanceLoading`（onProgress 阶段映射 LOAD_STAGE_PCT：WASM 解析 8 → … → 物理世界 92）/ `tickLoading`（ease-out 补间 + 区间伪漂移）/ `finishLoading`（冲 100 后延迟隐藏）/ `failLoading`（红态 + 错误信息，d55593a）。

## 2. 面板分区（左导航 `data-mod` + 右 pane `data-pane`）

| Pane | 内容 |
|---|---|
| 通用（general） | 加载地图、出生点下拉、重生、**存点列表**（序号+坐标+速度摘要，每项可读/删；见 §8） |
| 物理 | tickRate（48-128；lockTickRate=true 时锁 64 只读并 disable）、gravity/accelerate/airAccel/friction/maxSpeed/walkSpeed/crouchSpeed/stopSpeed/jumpSpeed、autobhop/bhopSpeedClamp/noPrestrafe、teleportGateTicks |
| 体型 | hull 半宽/站高/蹲高（默认 16/72/54——半宽演变链 **16→15→16**：b16a1c3 曾改 15，961b867「默认值对齐面板」改回 16）+ 恢复默认（滑块与数值框同步刷新） |
| 按键 | 键位列表 + 录制（点击 → 按新键 → 保存 localStorage `websurf-game.keymap.v1`） |
| 操作（look） | 灵敏度、Q/E 旋转速度 |
| 显示 | 准星（显示/颜色/线长/粗细/间隙/描边/中心点）、视野 FOV（60-110，默认 73.6）、速度面板模式（横向/横+竖/综合）、**纹理画质**（原始/压缩低清）、近平面参数 |
| 视角（view） | 自由视角（noclip）切换、noclip 移动速度 |

**绑定**：`bindSlider` / `bindCheckbox`（自动保存 prefs）/ 原生 select/button 监听。
**持久化**：`collectPrefs` → `savePanelPrefs`（localStorage `vbsp:panelPrefs`）→ 构造时 `loadPanelPrefs` → `syncControlsFromConfig` 回写控件 → `sendAllPrefs` 双端推送。

## 3. 键位（`input/keymap.ts` + `keyboard.ts`）

- 默认：WASD 移动、空格跳、Ctrl 蹲（ControlLeft/Right 双绑）、Shift 慢走（ShiftLeft/Right 双绑）、R 重生、Q/E 转向、M 菜单、滚轮连跳；方向键 ↑↓←→ 为移动等价绑定（keymap.ts:29-32）。
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

## 8. 存点系统（`savepoint.ts` + `app.ts` + `renderer-main.ts`）

b16a1c3 引入，e86eb7b 改造读点交互：

- **X 键存点**（仅指针锁定时响应）：`getFullState()` 采完整状态（pos/yaw/pitch/vel/onGround + 时间戳）→ `SavePointStore.add` 追加。
- **C 键读最近存点 = 按住冻结语义**（e86eb7b）：**按住** C 定在最近存点——位置/朝向取存点、**速度强制 0**（空中悬停/地面站定）；**松开**解除冻结并恢复存点速度（走 `loadSavepoint` 全量恢复 + `sync-render-state` 反向同步权威）。冻结的每帧执行在渲染循环里：`tick()` 后检测到 holdPoint 非空即强制 `set_state(..., 速度 0)` 持续覆盖物理与权威。
- **面板列表**（通用 pane 底部）：序号 + 坐标 + 速度摘要，每项「读」（等价 `loadSavepoint`）/「删」（无确认）。
- **按地图持久化**：localStorage key = `websurf-game.savepoints.{mapName}`（mapName 为去 `.bsp` 后缀文件名）；上限 50 条，超出 shift 遗弃最早。

时序影响：存点读点与 holdPoint 是 e86eb7b/b16a1c3 新增的两条**主线程 → 权威状态注入路径**（详见 `./timing-game.md` 第三/六阶段标注）。
