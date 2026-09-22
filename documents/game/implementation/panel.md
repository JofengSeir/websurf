# implementation / panel（`apps/game/src/panel/**`）

## 模块职责

`apps/game/src/panel/panel-controller.ts` 只有一个导出：`PanelController` 类（`apps/game/src/panel/panel-controller.ts:37`）。它把页面静态声明在 `apps/game/web/index.html` 里的控件接到 config、渲染器、桥与存点存储上。

| 成员 | 职责 | 锚点 |
|---|---|---|
| `constructor` | 取 `#panel` 根、读键位表、加载偏好、绑事件与导航、渲染键位列表、回写控件、全量下发、应用准星 | `apps/game/src/panel/panel-controller.ts:45`、`:78`、`:82`、`:88`、`:89`、`:90` |
| `updateVisibility` / `hide` | 可见性状态机：未锁定或场景未就绪时显示；加载地图时强制隐藏 | `apps/game/src/panel/panel-controller.ts:94`、`:100` |
| `bindModuleNav` | 在 `.nav` 上事件委托，按 `data-mod` 切 `.mod-pane` 的 `active` | `apps/game/src/panel/panel-controller.ts:106` |
| `renderKeyList` / `bindKeyEvents` / `startRecording` / `stopRecording` / `cancelRecording` / `finishRecording` / `commitKeymap` | 键位模块：列表渲染、录制重绑、删除键位、恢复默认、提交落盘 | `:122`、`:150`、`:192`、`:217`、`:225`、`:234`、`:252` |
| `bindEvents` | 通用控件绑定：物理滑块、体型、操作、准星、FOV、渲染距离、光照三项、速度模式、光照模式、画质、noclip、键位恢复、关闭按钮、窗口失焦 | `apps/game/src/panel/panel-controller.ts:262` |
| `sendHull` / `pushPhysicsParams` | 体型走 `player` 段；参数走 `buildPhysicsParams` 交主线程预测实例 | `:543`、`:555` |
| `bindSlider` / `bindCheckbox` | 滑块（含 `${id}Num` 数值框双向）与复选框的通用绑定 | `:559`、`:585` |
| 偏好持久化 | `PREFS_KEY` / `PREFS_VERSION` / `collectPrefs` / `savePanelPrefs` / `loadPanelPrefs` | `:596`、`:603`、`:606`、`:636`、`:646` |
| `syncControlsFromConfig` / `sendAllPrefs` | 回写全部控件；按 physics / player / input 三条 `sendConfig` + 渲染侧六个 setter 下发 | `:676`、`:737` |
| `applyCrosshair` / `renderSavePoints` | 准星行内 CSS 变量与三个类；存点列表每行两个按钮 | `:759`、`:780` |

## 关键流程与不变量

- **构造顺序固定**：`loadPanelPrefs`（合并 localStorage 存档）→ `bindEvents` → `bindModuleNav` → `renderKeyList` → `syncControlsFromConfig`（把合并后的值写回控件）→ `sendAllPrefs` → `applyCrosshair`（`apps/game/src/panel/panel-controller.ts:82`、`:88`、`:90`）。回写放在绑定之后，控件显示的是加载后的 config 值。
- **偏好版本门**：存档版本不等于 `PREFS_VERSION` 时不合并内容，直接以当前 config 写回新版本档（`apps/game/src/panel/panel-controller.ts:651`、`:657`）。
- **偏好只收集六段**：`collectPrefs` 写 `physics` / `player` / `input` / `hud` / `texture` / `lighting` 与 `__version`（`apps/game/src/panel/panel-controller.ts:606`）；`lighting` 段只写曝光、γ、模型光照与模式四项（`:626`），逐顶点重建两档不持久化。
- **录制监听的注册与解绑标志必须一致**：注册用 `{ capture: true }`（`apps/game/src/panel/panel-controller.ts:213`），解绑也用同一标志（`:219`）；标志不匹配时监听器会留在捕获阶段吞掉全部 keydown。
- **键位提交链路**：`saveKeymap` 落盘 → 经 `globalThis.__keyboardInput` 调 `setKeymap` → 重渲染列表（`apps/game/src/panel/panel-controller.ts:253`、`:256`、`:257`）。
- **两个渲染侧 setter 与 config 各自下发**：FOV / 渲染距离 / 曝光 / γ / 模型光照 / 光照模式只走渲染器回调（`apps/game/src/panel/panel-controller.ts:451`、`:458`、`:465`、`:473`、`:480`、`:497`），不进 `config` 消息段表。
- **控件 id 与页面一一对应**：本次实测 `apps/game/src` 内 45 个 `getElementById` 字面量 id 在 `apps/game/web/index.html` 中全部存在（含 `${id}Num` 之外的滑块、复选框、select 与列表容器）。
- **导航分栏是静态声明**：八个 `data-mod` 与八个 `data-pane` 全在页面里（`apps/game/web/index.html:77` 起、`apps/game/web/index.html:93` 起），控制器只切 `active` 类。

## 已知缺口

- **γ 滑块量程大于着色器接受窗口**：滑块量程 0.5..6（`apps/game/src/panel/panel-controller.ts:471`、`apps/game/web/index.html:228`），而渲染端 `setLightGamma` 只接受 `(0, 1]`（`apps/game/src/renderer/lightmap-shader.ts:1789`）；拖到大于 1 时 config 已被写（`apps/game/src/panel/panel-controller.ts:472`）、画面不变。
- **数值框路径不回写自身文本**：滑块输入会把值同步到数值框（`apps/game/src/panel/panel-controller.ts:568`），但数值框输入只把**钳制结果写回滑块**（`:577`），数值框自身文本保持用户输入的越界值；被写入 config 的是钳制后的值（`:578`）。
- **`applyCrosshair` 有一个死变量**：`const dot = el.querySelector('.ch-dot')` 声明后未被使用（`apps/game/src/panel/panel-controller.ts:773`），中心点显隐实际由 `no-dot` 类承担（`:774`）。
- **渲染侧初值写两次**：`RendererMain.init` 先按 config 当时的值写一遍光照与 FOV（`apps/game/src/renderer/renderer-main.ts:266`、`:268`、`:270`、`:272`、`:274`、`:275`），`sendAllPrefs` 再用加载偏好后的 config 覆盖一次（`apps/game/src/panel/panel-controller.ts:750`、`:752`、`:753`、`:754`、`:755`）；两次都走共享 uniform，第二次对 γ 同样受接受窗口限制。
- **只持久化部分输入段字段**：`collectPrefs` 的 `input` 段只写 `sensitivity` / `yawBindSpeed` / `noclipSpeed`（`apps/game/src/panel/panel-controller.ts:612`），`pitchLimit` 从不进存档（该字段在本工程也无读取点，见 `documents/game/implementation/config.md`）。
- **面板不校验 DOM 是否存在**：`bindSlider` / `bindCheckbox` 在取不到元素时静默返回（`apps/game/src/panel/panel-controller.ts:561`、`:587`），控件缺失不会报错；`#panel` 缺失时构造期即抛出（`apps/game/src/panel/panel-controller.ts:78` 的断言）。
- **存点列表形参含不参与渲染的字段**：`renderSavePoints` 的形参类型带 `yaw`（`apps/game/src/panel/panel-controller.ts:780`），方法体只渲染序号、坐标与速率（`:796`），`yaw` 未被使用。
- **M 键与 ESC 两条全局监听不校验场景状态**：M 键的判据只有 `e.code === 'KeyM'`（`apps/game/src/panel/panel-controller.ts:265`），ESC 分支只判 `!getLocked()`（`:273`）；两者都不读 `sceneReady`，因此加载进度覆盖层显示期间这两条分支同样会被触发。
