# implementation/app：主线程装配入口

> 覆盖 `apps/viewer/src/app.ts`（主线程唯一装配入口）与 `apps/viewer/src/wasm.d.ts`（wasm 类型入口）。

---

## 模块职责

`apps/viewer/src/app.ts` 是 viewer 的入口文件，被 `apps/viewer/package.json:13` 的 `build:app` 用 esbuild 打成 `web/app.js`。它没有 `export`：全部工作是模块顶层的装配与事件绑定，对外只暴露 `globalThis.viewer`。

装配顺序（自上而下）：画布 → HUD → `ViewerScene` → `FlyCam` → 侧栏/标签页 → `MapPanel` → 导入器/播放器/可视化 → `ReplayPanel` → 信息条/时间轴/遥测 → BSP 输入与拖拽 → `globalThis.viewer` → URL 深链 → 帧循环。

对外接口清单（`apps/viewer/src/app.ts:540` 起）：

| 成员 | 含义 | 锚点 |
|---|---|---|
| `viewer.map.pose()` | 相机脚底位姿（度）+ 本次地图初始视角来源 | `apps/viewer/src/app.ts:545` |
| `viewer.map.mapBox()` | 当前地图几何包围盒（无地图为 null） | `apps/viewer/src/app.ts:555` |
| `viewer.replay.trackCount` / `duration` / `time` / `playing` / `speed` / `mode` / `followId` / `sceneObjects` | 只读内省快照 | `apps/viewer/src/app.ts:562` 到 `apps/viewer/src/app.ts:570` |
| `viewer.replay.tracks()` | 各轨道只读信息（id / 名 / 帧数 / 时长 / 偏移 / 显隐 / 配色 / 首帧坐标） | `apps/viewer/src/app.ts:572` |
| `viewer.replay.meta()` | 跟随轨道的 `.replay` 头部元信息 | `apps/viewer/src/app.ts:587` |
| `viewer.replay.play()` / `pause()` / `seek(sec)` / `setSpeed(x)` | 播放控制（时间单位秒；`setSpeed` 钳到 [0.1, 16]） | `apps/viewer/src/app.ts:589` 到 `apps/viewer/src/app.ts:594` |
| `viewer.replay.setMode(m)` | 只有 `'third'` 按第三人称处理，其余入参一律落到 `'first'` | `apps/viewer/src/app.ts:596` |
| `viewer.replay.follow(trackId \| null)` | 切换跟随目标（null = 回到第一条轨道），并按需刷新信息条与轨迹列表 | `apps/viewer/src/app.ts:600` |

`apps/viewer/src/wasm.d.ts` 只有一行 `export * from '../pkg/websurf_viewer_wasm.js'`（`apps/viewer/src/wasm.d.ts:13`），用途是让本工程可按 `./wasm.js` 引用 wasm 侧类型；它在 `apps/viewer/src` 内**零导入点**（真正导入 wasm 的是 `apps/viewer/src/core/bsp.ts:17` 的 `BspProcessor` 与 `initSync`）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 地图加载三步顺序 | `loadBsp` 内：`loadBspFile` → `scene.mountGlb` → 包围盒与初始视角 | `apps/viewer/src/app.ts:420` 到 `apps/viewer/src/app.ts:444` |
| 初始视角单点解析 | `resolveInitialSpawn` 同时决定相机初始位姿与面板 ★ 标记，避免两处各判一次 | `apps/viewer/src/app.ts:442`、`apps/viewer/src/core/spawn.ts:96` |
| 换图失败不丢旧图 | 失败时若无地图则显示引导层错误，若有地图则还原旧摘要并临时提示 5 s | `apps/viewer/src/app.ts:460` 到 `apps/viewer/src/app.ts:464` |
| 轨道同步单点 | `syncTracks` 一次同步 3D 可视化、时间轴、信息条、遥测 HUD 四个消费者 | `apps/viewer/src/app.ts:215` 到 `apps/viewer/src/app.ts:222` |
| 重导入替换语义 | `onClip` 拿到 `replaceId` 时替换该轨道（保留配色/显隐/偏移/名字），否则追加；导入后默认切第一人称 | `apps/viewer/src/app.ts:320` 到 `apps/viewer/src/app.ts:333` |
| 地图贴合检查 | 轨道 `Clip.bbox` 与地图包围盒在三轴全部分离且间隙超过 512 HU 时判「完全落在地图包围盒外」，只写 `#replayStatus` | `apps/viewer/src/app.ts:364` 到 `apps/viewer/src/app.ts:390` |
| 相机单一写者 | 回放第一人称段把 `drivesCamera` / `allowMove` 置假并用 `applyToWithRoll` 写相机，其余帧由 `FlyCam` 写 | `apps/viewer/src/app.ts:725` 到 `apps/viewer/src/app.ts:739` |
| 帧间隔上限 | dt 取 `min(now - lastNow, 0.05)`，避免切标签页回来时时间跳变 | `apps/viewer/src/app.ts:718` |
| HUD 节流 | 位姿行、时间轴、遥测按 ≥ 80 ms 的间隔刷新，不每帧重排 DOM | `apps/viewer/src/app.ts:748` |
| 拖拽分派 | `.bsp` → 地图；`.replay` → 切到记录页并交给面板；`.dem` → 切到录像页交给 `DemoPanel.load`；其余提示只支持这三种 | `apps/viewer/src/app.ts:505` 到 `apps/viewer/src/app.ts:536` |
| URL 深链 | `?bsp=` 与 `?replay=` 可任意组合；记录先按魔数嗅探再交给面板，非 Shavit 直接报错 | `apps/viewer/src/app.ts:620` 到 `apps/viewer/src/app.ts:658` |
| `crossOriginIsolated` 只读不选路 | viewer 无物理、不需要 `SharedArrayBuffer`，该标志只打印供部署核对 | `apps/viewer/src/app.ts:41` 到 `apps/viewer/src/app.ts:46` |

## 已知缺口

1. **面板容器缺失时静默降级为脱离文档的元素**（本次读码发现）：`mapPanel` 在 `#pane-map` 取不到时为 `null`（`apps/viewer/src/app.ts:170`），`replayPanel` 同理（`apps/viewer/src/app.ts:318`）；而 `ReplayMetaPanel` / `Timeline` / `TelemetryHud` 在句柄缺失时改用 `document.createElement('div')` 兜底（`apps/viewer/src/app.ts:349`、`apps/viewer/src/app.ts:350`、`apps/viewer/src/app.ts:352`）。后果是页面缺 id 时既不报错也不显示，时间轴与信息条落到脱离文档的容器里，而 `Timeline` 注册的全局快捷键仍然生效（`apps/viewer/src/replay/timeline.ts:195`）。
2. **贴合检查的文案与数据不同源**（本次读码发现）：判据收集了全部越界轨道，提示串里也列出全部名字，但括号里的 bbox 只取 `outside[0]` 一条（`apps/viewer/src/app.ts:374` 到 `apps/viewer/src/app.ts:390`），多条越界时读数只对应第一条。
3. **`wasm.d.ts` 是零导入点的类型面**：`apps/viewer/src/wasm.d.ts:13` 只做整体转出，本工程内无引用，仅被 `apps/viewer/tsconfig.json:15` 的 `include` 收进编译程序。
4. **`viewer.replay.setSpeed` 的钳制下限在正常入参下不可达**：表达式 `Math.max(0.1, Math.min(16, Number(x) || 1))`（`apps/viewer/src/app.ts:593`）先用 `|| 1` 把 0 / NaN 归成 1，只有传负数才会落到 0.1 下限；时间轴下拉的档位下限是 0.1（`apps/viewer/src/replay/timeline.ts:19`），两者不冲突，但接口文档化的下半区实际只有负数能触发。
5. **`updateReplayMapStatus` 只在 `currentBox` 非空时做检查**：`?replay=` 深链先导入记录而地图尚未加载时该函数直接跳过检查（`apps/viewer/src/app.ts:364`），贴合问题要等地图加载后由 `loadBsp` 末尾再次调用才会被报出（`apps/viewer/src/app.ts:444`）。
