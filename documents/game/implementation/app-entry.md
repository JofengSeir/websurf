# implementation / app-entry（`apps/game/src/app.ts`）

## 模块职责

主线程入口模块：装配 Worker、共享状态通道、渲染器、输入桥与面板，并把 DOM 事件接到这些对象上。模块内没有运行时导出，唯一的 `export` 是一条类型转出（`apps/game/src/app.ts:71` 的 `BindableAction`），装配入口是文件末的 `void main()`（`apps/game/src/app.ts:832`）。

内部函数与常量清单（按出现顺序，全部为本文件私有）：

| 名称 | 职责 | 锚点 |
|---|---|---|
| `dom` | 一次性取到的挂载点表（画布、文件输入、状态行、速度读数、键簇、出生点下拉、重生按钮、FPS、近平面四个控件、加载覆盖层五件） | `apps/game/src/app.ts:43` |
| `handleLoadBsp` | 主线程唯一的加载入口：解析 → 建场景 → 建双端物理世界 → 发 `world-json` → 收尾 UI | `apps/game/src/app.ts:495` |
| `bindInput` | 绑 DOM 事件：鼠标、点击锁视角、存点/读点快捷键、锁定状态、窗口尺寸与失焦、滚轮跳、加载地图按钮、出生点下拉、近平面参数 | `apps/game/src/app.ts:224` |
| `startInputLoop` | rAF 输入循环：FPS、掩码、滚轮跳、Q/E 转向、速度面板节流 | `apps/game/src/app.ts:383` |
| `updateSpeedHud` | 速度读数的三种显示模式（横向 / 横+竖 / 综合） | `apps/game/src/app.ts:424` |
| `initKeyHud` / `syncKeyHudLabels` / `updateKeyHud` | 键簇标签初始化、改写与高亮（标签同源于 `loadKeymap`，高亮只在掩码变化时写 DOM） | `apps/game/src/app.ts:448`、`apps/game/src/app.ts:462`、`apps/game/src/app.ts:481` |
| `savePoint` / `startHoldPoint` / `endHoldPoint` | X 存点、按住 C 冻结、松开 C 恢复（后两者经渲染器的 `setHoldPoint` / `releaseHoldPoint`） | `apps/game/src/app.ts:607`、`apps/game/src/app.ts:617`、`apps/game/src/app.ts:630` |
| `syncFullConfig` | 按四段（`physics` / `input` / `player` / `hud`）各发一条 `config`；`lockTickRate` 为真时先把 tickRate 写死 64 | `apps/game/src/app.ts:637` |
| `pushHealthLog` | 权威健康消息缓冲（最新在顶、上限 30 条），写 `#health-log` 与 `#health-count` | `apps/game/src/app.ts:650` |
| 加载进度族 | `LOAD_STAGE_PCT` 阶段映射、`tickLoading` 补间、`showLoading` / `advanceLoading` / `finishLoading` / `failLoading` / `hideLoading` | `apps/game/src/app.ts:679`、`apps/game/src/app.ts:727`、`apps/game/src/app.ts:753`、`apps/game/src/app.ts:780`、`apps/game/src/app.ts:793`、`apps/game/src/app.ts:803`、`apps/game/src/app.ts:814` |
| `setStatus` / `setError` | 状态行与错误行的唯一写入口 | `apps/game/src/app.ts:667`、`apps/game/src/app.ts:823` |

## 关键流程与不变量

- **装配顺序不可换**：通道选择 → Worker → `init` / `wasm-init` → 通道对象 → 渲染器 `init`/`start` → 探针 → 主线程 wasm → 桥 → 面板 → 输入（`apps/game/src/app.ts:102`、`apps/game/src/app.ts:117`、`apps/game/src/app.ts:158`、`apps/game/src/app.ts:162`、`apps/game/src/app.ts:173`、`apps/game/src/app.ts:176`、`apps/game/src/app.ts:181`、`apps/game/src/app.ts:185`、`apps/game/src/app.ts:219`）。`PanelController` 构造期就会下发全量偏好，因此它必须晚于 `InputBridge` 与渲染器。
- **键簇与面板同源**：键簇覆盖 8 个动作（`apps/game/src/app.ts:442`），与页面 `data-action` 一一对应（`apps/game/web/index.html:45` 起 8 个 `span`）；标签取 `loadKeymap()` 的首个绑定键，键位删空时显示占位符并加 `off` 类（`apps/game/src/app.ts:466`）。
- **输入只走一条通道**：鼠标增量经 `layerMouseDelta` 乘灵敏度后交 `renderer.feedInput`（`apps/game/src/app.ts:235`），Q/E 转向经 `qeEquivalentDx` 后走同一入口（`apps/game/src/app.ts:413`）；键位掩码在未锁定时强制为 0（`apps/game/src/app.ts:400`）。
- **加载链的关键判据**：`buildWorldBundle` 的 `onProgress` 直达 `advanceLoading`（`apps/game/src/app.ts:516`）；世界建完后先发 `world-json`（`apps/game/src/app.ts:558`）再设双端出生点（`apps/game/src/app.ts:570`），最后重发一次全量配置（`apps/game/src/app.ts:573`）。
- **进度覆盖层状态机**：`showLoading` 起补间并清残留错误态（`apps/game/src/app.ts:753`）；`failLoading` 把覆盖层转错误态并停补间（`apps/game/src/app.ts:803`）；成功路径由 `finishLoading` 延迟隐藏（`apps/game/src/app.ts:799`）。
- **DOM 契约**：本次实测本文件引用的 45 个 `getElementById` 字面量 id 在 `apps/game/web/index.html` 中全部存在；选择器查询共 8 个（`.nav`、`.nav .mod`、`.mod-pane`、`.ch-line`、`.ch-dot`、`.key-chip`、`.key-chip .x`、`.key-add`，后四个由面板模块使用）。

## 已知缺口

- **加载阶段表里有一个没有生产者的键**：`LOAD_STAGE_PCT` 含 `'正在加载地图': 0`（`apps/game/src/app.ts:680`），而实际会传给 `advanceLoading` 的阶段名只有四个来自 `buildWorldBundle` 的 `onProgress`（`src/ts-shared/phys/world-builder.ts:155`、`:172`、`:177`、`:207`）与两个由本文件直接给出（`apps/game/src/app.ts:520`、`apps/game/src/app.ts:535`）。该键永远不会命中，进度条的 0% 展示由 `showLoading` 复位承担（`apps/game/src/app.ts:764`）。
- **未在表内的阶段只改文字、不推进百分比**：`advanceLoading` 对未识别的阶段名只写 `#loadingStage`（`apps/game/src/app.ts:787`），此时进度停在上一阶段的目标值上。
- **主线程 wasm 失败不阻断加载**：`initPrediction` 的 rejection 只被转成错误行（`apps/game/src/app.ts:176`），随后 `handleLoadBsp` 用 `.catch(() => undefined)` 吞掉同一个 promise 继续走（`apps/game/src/app.ts:507`），此时的后果是默认纹理包解压不可用、缺失纹理降级为占位色（`src/ts-shared/phys/world-builder.ts:243`）。
- **可选的 DOM 依赖静默降级**：`#loadMapBtn`、`#bspFile`、`#respawnBtn`、`#spawnSelect` 全部走可选链（`apps/game/src/app.ts:317`、`apps/game/src/app.ts:321`、`apps/game/src/app.ts:329`、`apps/game/src/app.ts:342`），元素缺失时既无报错也无提示，只是点击无反应。
- **未锁定前不请求指针锁定**：`document` 的点击处理器在 `!sceneReady` 时直接返回（`apps/game/src/app.ts:249`），因此选图前点击画布没有任何反馈；只有 `requestLock` 返回失败的 promise 时才写状态行（`apps/game/src/app.ts:255`）。
- **速度读数用 `innerHTML` 写入**：`updateSpeedHud` 通过 `dom.statsEl.innerHTML` 写值（`apps/game/src/app.ts:437`），其中竖线分隔符是写死的 `<span class="vsep">` 片段（`apps/game/src/app.ts:435`）；数值本身来自本端物理速度与 `config.hud.speedMode` 分支。
- **`syncFullConfig` 对 `hud` 段下发的载荷不是 hud 段**：段表列出四段（`apps/game/src/app.ts:642`），而 `InputBridge.sendConfig` 对非 `player` 段一律下发全量物理参数、`section` 名原样保留（`apps/game/src/input/input-bridge.ts:57`、`apps/game/src/input/input-bridge.ts:65`）；Worker 侧不读 `hud` 段，故静态看无行为影响，但 Worker 的 `config.hud` 会被并入物理参数键（`src/ts-shared/auth/worker-dispatch.ts:351`）。
- **`lockTickRate` 的强制值依赖调用时机**：`syncFullConfig` 每次调用都会把 `config.physics.tickRate` 覆写为 64（`apps/game/src/app.ts:639`），面板在锁定模式下也写死 64 并禁用控件（`apps/game/src/panel/panel-controller.ts:284`）；两处必须同时生效，否则面板显示值与下发值会分叉。
