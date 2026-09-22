# implementation/core：地图、场景、相机与位姿

> 覆盖 `apps/viewer/src/core/` 下的七个模块：`bsp.ts`（BSP 加载与 WASM 懒初始化）、`scene.ts`（three 场景与光照片段装配）、`fly.ts`（自由飞行相机）、`pose.ts`（位姿与角度再导出）、`constants.ts`（常量单点）、`dom.ts`（面板 DOM 构件）、`spawn.ts`（出生点解析）。

---

## 模块职责

| 模块 | 职责 | 导出清单 |
|---|---|---|
| `apps/viewer/src/core/bsp.ts` | 字节 → 结构化结果：WASM 懒初始化、`BspProcessor` 三次调用、错误人话化；不碰 UI、不碰相机 | 类型 `BspMeta`（`apps/viewer/src/core/bsp.ts:20`）、`SpawnPoint`（`apps/viewer/src/core/bsp.ts:32`）、`BspLoadResult`（`apps/viewer/src/core/bsp.ts:38`）；函数 `ensureWasm`（`apps/viewer/src/core/bsp.ts:74`）、`loadBspFile`（`apps/viewer/src/core/bsp.ts:115`）、`humanizeBspError`（`apps/viewer/src/core/bsp.ts:148`） |
| `apps/viewer/src/core/scene.ts` | WebGL 渲染器 / 场景 / 相机 / 三点光；GLB 挂载、静态光照施加、空间分块合并、near-far 自适应、换图释放 | 类 `ViewerScene`（`apps/viewer/src/core/scene.ts:71`）；函数 `disposeObject`（`apps/viewer/src/core/scene.ts:510`） |
| `apps/viewer/src/core/fly.ts` | 自由飞行相机：位姿状态、pointer lock、键鼠输入、写相机 | 类 `FlyCam`（`apps/viewer/src/core/fly.ts:41`） |
| `apps/viewer/src/core/pose.ts` | 位姿契约（脚底 + 度）与角度工具再导出 | 接口 `Pose`（`apps/viewer/src/core/pose.ts:25`）；函数 `pitchClampedRad`（`apps/viewer/src/core/pose.ts:36`）、`eyeHeight`（`apps/viewer/src/core/pose.ts:47`）；再导出 `wrapDeg` 与 `bspYawToCsYaw`（`apps/viewer/src/core/pose.ts:22`） |
| `apps/viewer/src/core/constants.ts` | 本工程常量单点（`EYE_STAND` 从共享层再导出） | `DEG2RAD`（`apps/viewer/src/core/constants.ts:24`）、`RAD2DEG`（`apps/viewer/src/core/constants.ts:25`）、`EYE_STAND`（`apps/viewer/src/core/constants.ts:35`）、`FOV`（`apps/viewer/src/core/constants.ts:38`）、`CAMERA_INIT_NEAR` / `CAMERA_INIT_FAR`（`apps/viewer/src/core/constants.ts:40`）、`CAMERA_FAR_SCALE`（`apps/viewer/src/core/constants.ts:43`）、`CAMERA_NEAR_MIN`（`apps/viewer/src/core/constants.ts:45`）、`NEAR_PROBE_DIST`（`apps/viewer/src/core/constants.ts:47`）、`NEAR_RATIO`（`apps/viewer/src/core/constants.ts:49`）、`BG_COLOR`（`apps/viewer/src/core/constants.ts:50`）、`FLY_SPEED` / `FLY_SPEED_FAST`（`apps/viewer/src/core/constants.ts:53`）、`MOUSE_SENS`（`apps/viewer/src/core/constants.ts:57`）、`PITCH_LIMIT`（`apps/viewer/src/core/constants.ts:58`）、`MOUSE_MAX_DELTA`（`apps/viewer/src/core/constants.ts:64`）、`PITCH_LIMIT_DEG`（`apps/viewer/src/core/constants.ts:67`） |
| `apps/viewer/src/core/dom.ts` | 面板 DOM 构件：查询、建元素、分区、折叠组、数字/勾选输入行、按钮行、提示行 | `qs`（`apps/viewer/src/core/dom.ts:23`）、`el`（`apps/viewer/src/core/dom.ts:29`）、`section`（`apps/viewer/src/core/dom.ts:48`）、`foldBox`（`apps/viewer/src/core/dom.ts:64`）、`numField`（`apps/viewer/src/core/dom.ts:97`）、`checkField`（`apps/viewer/src/core/dom.ts:118`）、`buttonRow`（`apps/viewer/src/core/dom.ts:137`）、`noteLine`（`apps/viewer/src/core/dom.ts:157`） |
| `apps/viewer/src/core/spawn.ts` | 出生点实体 → 初始视角（四级优先级），并与面板 ★ 标记同源 | 类型 `Box3Like`（`apps/viewer/src/core/spawn.ts:31`）、`SpawnSource`（`apps/viewer/src/core/spawn.ts:36`）、`ResolvedSpawn`（`apps/viewer/src/core/spawn.ts:38`）；函数 `spawnPointAng`（`apps/viewer/src/core/spawn.ts:57`）、`bboxVantagePos`（`apps/viewer/src/core/spawn.ts:65`）、`resolveInitialSpawn`（`apps/viewer/src/core/spawn.ts:96`） |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| WASM 三条取值路径 | ① `globalThis.__VBSP_WASM_B64__` 命中（single 产物内嵌）→ `initSync`；② `fetch` 同目录 `websurf_viewer_wasm_bg.wasm`（multi 部署主路径）；③ 动态插 `<script>` 加载 `wasm-embedded.js` 后重读同一全局键；三条都不通才抛错 | `apps/viewer/src/core/bsp.ts:78`、`apps/viewer/src/core/bsp.ts:86`、`apps/viewer/src/core/bsp.ts:99`、`apps/viewer/src/core/bsp.ts:107` |
| 内嵌判定口径 | 走共享层 `readEmbeddedWasmB64`：非空字符串才算命中 | `apps/viewer/src/core/bsp.ts:78`、`src/ts-shared/wasm/loader.ts:63` |
| 解析三步顺序 | `metadata()` → `parse_spawn_points()`（都是借用方法）→ `export_glb_with_pakfile_models()`（消耗内部 `Bsp`，必须最后） | `apps/viewer/src/core/bsp.ts:122` 到 `apps/viewer/src/core/bsp.ts:125` |
| 导出前让出一帧 | `loadBspFile` 在同步解析前 `await new Promise(r => setTimeout(r, 0))`，让浏览器有机会画出「正在解析」状态 | `apps/viewer/src/core/bsp.ts:118` |
| 错误分类 | `humanizeBspError` 依次匹配「解析类 → WASM/网络类 → 内存类」，全不中给通用文案；第二返回值始终是原始信息 | `apps/viewer/src/core/bsp.ts:150` 到 `apps/viewer/src/core/bsp.ts:159` |
| 挂载顺序 | `mountGlb`：GLTFLoader 解析 → 换图前释放旧根 → 施加静态光照 → 分块合并 → `fitCamera` | `apps/viewer/src/core/scene.ts:181`、`apps/viewer/src/core/scene.ts:186`、`apps/viewer/src/core/scene.ts:200` 到 `apps/viewer/src/core/scene.ts:204` |
| 静态光照失败不阻断 | `applyStaticLighting` 整段包在 `try/catch` 里；无图集时只打日志 | `apps/viewer/src/core/scene.ts:218`、`apps/viewer/src/core/scene.ts:231` |
| 近平面自适应 | 每 2 帧一次（`nearCheckToggle` 交替）：先按包围球粗筛 `modelRoot` 子树，再沿相机局部系的 6 个方向各打一条射线；命中则 `near = max(距离 × NEAR_RATIO, CAMERA_NEAR_MIN)`，全空则复位 `defaultNear` | `apps/viewer/src/core/scene.ts:158`、`apps/viewer/src/core/scene.ts:290`、`apps/viewer/src/core/scene.ts:332` |
| far 按地图尺寸 | `fitCamera` 取包围盒最大边长：`far = max(maxDim × 100, CAMERA_INIT_FAR)`、`near = max(maxDim / 1000, CAMERA_NEAR_MIN)` | `apps/viewer/src/core/scene.ts:266` 到 `apps/viewer/src/core/scene.ts:269` |
| 分块合并 | 只遍历 `modelRoot` 子树；块边长从 `diag / 立方根(OPT_TARGET_CELLS)` 起步，最多迭代 6 次逼近 `[OPT_MIN_CELLS, OPT_MAX_CELLS]`；块内按材质实例子合并；合并后逐块重算包围球并把半径乘 `FRUSTUM_PAD` | `apps/viewer/src/core/scene.ts:364`、`apps/viewer/src/core/scene.ts:401`、`apps/viewer/src/core/scene.ts:407`、`apps/viewer/src/core/scene.ts:440`、`apps/viewer/src/core/scene.ts:491` |
| 光照模式运行期切换 | `setLightingMode` 与当前值相同时提前返回，否则只改共享 uniform，不重建场景、不重编译材质 | `apps/viewer/src/core/scene.ts:246`、`apps/viewer/src/renderer/lightmap-shader.ts:436` |
| 显存释放 | `disposeObject` 逐个 Mesh 释放几何、材质、`map` 与 `lightMap` 两张纹理；非 Mesh 节点跳过 | `apps/viewer/src/core/scene.ts:510` 到 `apps/viewer/src/core/scene.ts:527` |
| 相机单写者 | `FlyCam` 只在 `drivesCamera` 为真时写相机（`applyTo`），`applyToWithRoll` 不检查该开关（回放第一人称专用） | `apps/viewer/src/core/fly.ts:196`、`apps/viewer/src/core/fly.ts:222` |
| 位移键集合 | 只有 `MOVE_KEYS` 内的键会被 `preventDefault` 并记入状态；左右 Shift 决定速度档，Space 升、C 与左右 Ctrl 降 | `apps/viewer/src/core/fly.ts:119`、`apps/viewer/src/core/fly.ts:176` 到 `apps/viewer/src/core/fly.ts:188`、`apps/viewer/src/core/fly.ts:236` |
| pointer lock 失败降级 | 先试 `requestPointerLock({unadjustedMovement:true})`；返回 Promise 被拒或同步抛出时回退无参调用；`pointerlockerror` 触发 `onLockError` | `apps/viewer/src/core/fly.ts:144`、`apps/viewer/src/core/fly.ts:146`、`apps/viewer/src/core/fly.ts:91` |
| 位姿单位约定 | `Pose.ang` 是度；弧度只在 `FlyCam` 内部；`setPose` 用 `DEG2RAD` 换算并把 pitch 夹到 `PITCH_LIMIT` | `apps/viewer/src/core/pose.ts:27`、`apps/viewer/src/core/fly.ts:209` |
| 出生点四级优先级 | ① primary 下标指向的 `info_player_start`；② 实体序第一个 `info_player_start`；③ 实体序第一个 `info_player_*`；④ bbox 内的第一个 `info_teleport_destination`；都不可用时回落 bbox 中心高位俯瞰（`index = −1`）；`box` 为 null 时第 ④⑤ 步不执行并返回 null | `apps/viewer/src/core/spawn.ts:102` 到 `apps/viewer/src/core/spawn.ts:117` |
| 出生点角度换算 | `yaw = bspYawToCsYaw(angles[1])`、`pitch = −angles[0]`（wasm 的 `angles` 保持 BSP 原始 `[pitch, yaw, roll]` 次序） | `apps/viewer/src/core/spawn.ts:58`、`apps/viewer/crates/wasm/src/lib.rs:369` |
| `EYE_STAND` 单点 | 本工程不持有该字面量，从共享层再导出；相机 y = `pos.y + EYE_STAND` | `apps/viewer/src/core/constants.ts:35`、`apps/viewer/src/core/fly.ts:203` |

## 已知缺口

1. **构造期 γ 写入落在着色器接受窗口之外**：`ViewerScene` 构造时调用 `setLightGamma(2.2)`（`apps/viewer/src/core/scene.ts:111`），而 `setLightGamma` 在 `value <= 0 || value > 1` 时直接返回（`apps/viewer/src/renderer/lightmap-shader.ts:1789`）⇒ 这次写入被忽略，γ 共享 uniform 保持自身初值 1；同一组五参数里其余四项都落在各自窗口内（`apps/viewer/src/core/scene.ts:110` 到 `apps/viewer/src/core/scene.ts:114`）。`apps/game/src/config.ts:228` 的默认 `lightGamma` 同为 2.2，是同一码值来源。
2. **`ensureWasm` 把首次失败永久缓存**：模块级 `wasmReady` 只在为 null 时创建（`apps/viewer/src/core/bsp.ts:75`），被 reject 后没有任何重置点，之后每次调用都返回同一个 rejected Promise（`apps/viewer/src/core/bsp.ts:112`）⇒ 一次瞬时 fetch 失败后本次页面会话无法自愈，只能刷新。
3. **`allowPointerLock` 是无写无读的字段**：声明在 `apps/viewer/src/core/fly.ts:68`，`attach` 的 click 处理只判 `locked`（`apps/viewer/src/core/fly.ts:88`），`apps/viewer/src` 内既无写入点也无读取点。
4. **`onLockChange` 无赋值点**：字段声明与调用都在 `apps/viewer/src/core/fly.ts:80` 与 `apps/viewer/src/core/fly.ts:104`，本工程只给 `FlyCam` 赋过 `onLockError`（`apps/viewer/src/app.ts:61`）⇒ 锁定状态变化回调永不触发。
5. **`core/pose.ts` 的两个函数零调用点**：`pitchClampedRad`（`apps/viewer/src/core/pose.ts:36`）与 `eyeHeight`（`apps/viewer/src/core/pose.ts:47`）在 `apps/viewer/src` 内无调用者——限幅与眼高分别由 `FlyCam.update` / `setPose` / `setWorld` 与 `FlyCam.writeCamera` / `applyToWithRoll` 各自实现（`apps/viewer/src/core/fly.ts:172`、`apps/viewer/src/core/fly.ts:203`）。
6. **`RAD2DEG` 在 `apps/viewer/src` 内零调用点**：`apps/viewer/src/core/constants.ts:25` 导出后无人消费（本工程只有度→弧度的单向换算需求）。
7. **`ViewerScene.model` getter 零调用点**：`apps/viewer/src/core/scene.ts:141` 暴露的只读地图根在本工程内没有读取者（`worldBox` 走内部 `modelRoot`，回放可视化走 `add` / `remove`）。
8. **`numField` 把空串当合法 0**：`Number('')` 得 0 且 `Number.isFinite(0)` 为真（`apps/viewer/src/core/dom.ts:107`），于是清空输入框会走有效分支把 0 写进变换；两个消费点都只在非有限值时提前返回（`apps/viewer/src/replay/panel.ts:334`），因此空串的语义等同「把该分量设为 0」。
9. **`optimizeScene` 的选块包围盒只统计部分 Mesh**：`worldBox` 只累计「材质不是数组且存在、有 `position` 属性」的 Mesh（`apps/viewer/src/core/scene.ts:368`、`apps/viewer/src/core/scene.ts:384`），被搬进 `keptMeshes` 的数组材质 / 缺失材质 Mesh 不参与统计（`apps/viewer/src/core/scene.ts:377`）⇒ 块边长由子集推出，极端地图（大量数组材质 Mesh）下块数与目标区间会有偏差。
10. **回退脚本加载没有超时**：第 ③ 条取值路径用 `loadScript` 动态插 `<script>` 并等 `onload` / `onerror`（`apps/viewer/src/core/bsp.ts:52` 到 `apps/viewer/src/core/bsp.ts:60`）；两个事件都没发生时该 Promise 不结算，`ensureWasm` 的 await 会一直挂着（没有超时分支），且插入的 `<script>` 标签在成功路径上也不移除（`apps/viewer/src/core/bsp.ts:58`）。
