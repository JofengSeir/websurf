# WebSurf-viewer：工程总览

> 本文只覆盖 `apps/viewer`。所有结论来自源码、构建脚本与配置的实测；锚点格式为「相对仓库根路径:行号」。

---

## 工程定位

`apps/viewer` 是受控范围（`apps/debug` + `apps/game` + `apps/viewer` + `src/`）里的**只读查看器**：把 `.bsp` 地图解析成 GLB 场景供自由飞行观察，并把 Shavit 原生 `.replay` 录像按帧自身坐标播放出来做对比。

它与其他两个工程的定位差别由三处实测界定：

- **没有物理**：WASM 侧只暴露 BSP 解析与 GLB 导出（`apps/viewer/crates/wasm/src/lib.rs:339` 的 `BspProcessor::new` 之后只有 `metadata` / `parse_spawn_points` / `export_glb_with_pakfile_models` 三个方法），crate 依赖里没有 `websurf-phys`（`apps/viewer/crates/wasm/Cargo.toml:18`）。
- **不参与共享状态通道**：入口只打印 `crossOriginIsolated` 供核对，不建 `SharedArrayBuffer`、不选通道（`apps/viewer/src/app.ts:39`）。
- **有独立的解析 Worker**：Worker 只做 `.replay` 字节 → 结构化帧的解码（`apps/viewer/src/worker/main.ts:53` 的 `handle`），不做物理、不常驻状态机。

依据：`apps/viewer/package.json:7` 的 scripts（`build:wasm` / `typecheck` / `test:replay` / `local:smoke` / `build:worker` / `build:app` / `build:ts` / `build` / `build:dist` / `check:api` / `dev`），以及 `apps/viewer/package.json:29` 的运行时依赖只有 `three`。

## 目录职责

| 路径 | 职责 | 关键锚点 |
|---|---|---|
| `apps/viewer/src/app.ts` | 主线程装配入口：画布、场景、飞行相机、面板、拖拽与 URL 深链、帧循环、`globalThis.viewer` 接口 | `apps/viewer/src/app.ts:33`、`apps/viewer/src/app.ts:478` |
| `apps/viewer/src/core/` | BSP 加载与 WASM 懒初始化、three 场景与光照模式、自由飞行相机、位姿、常量、DOM 构件、出生点解析 | `apps/viewer/src/core/bsp.ts:74`、`apps/viewer/src/core/scene.ts:356`、`apps/viewer/src/core/fly.ts:84`、`apps/viewer/src/core/spawn.ts:96` |
| `apps/viewer/src/replay/` | `.replay` 原生解析、导入与 Worker 协议、播放器与采样、多轨道容器、3D 呈现、录像面板、轨迹列表、时间轴、人工变换 | `apps/viewer/src/replay/shavit-replay.ts:284`、`apps/viewer/src/replay/player.ts:193`、`apps/viewer/src/replay/timeline.ts:276` |
| `apps/viewer/src/ui/` | HUD 与引导层、地图信息与出生点导航、录像信息条、遥测 HUD | `apps/viewer/src/ui/hud.ts:21`、`apps/viewer/src/ui/mapinfo.ts:129`、`apps/viewer/src/ui/telemetry.ts:103` |
| `apps/viewer/src/renderer/` | 离线烘焙静态光照的 three 侧落地（RGBExp32 图集解码注入 + prop 三级光照路由） | `apps/viewer/src/renderer/lightmap-shader.ts:482`、`apps/viewer/src/renderer/lightmap-shader.ts:374` |
| `apps/viewer/src/worker/` | 录像解析 Worker 源码（esbuild 打成 `web/worker.js`） | `apps/viewer/src/worker/main.ts:46` |
| `apps/viewer/src/wasm.d.ts` | 把 `pkg/websurf_viewer_wasm.js` 的导出整体转出，供 `./wasm.js` 引用类型；本工程内零导入点 | `apps/viewer/src/wasm.d.ts:13` |
| `apps/viewer/crates/wasm/` | WASM 薄导出层（Rust）：`BspProcessor` 类 | `apps/viewer/crates/wasm/src/lib.rs:327` |
| `apps/viewer/scripts/` | 打包（single / multi）与 WASM 契约检查 | `apps/viewer/scripts/build-dist.mjs:221`、`apps/viewer/scripts/check-wasm-api.mjs:38` |
| `apps/viewer/test/` | Node 侧录像管线自检、CDP 冒烟、最小 Node 类型面 | `apps/viewer/test/replay-selftest.ts:31`、`apps/viewer/test/smoke-cdp.mjs:122` |
| `apps/viewer/web/` | 页面骨架、样式、dev 运行产物（`app.js` / `worker.js` / `websurf_viewer_wasm_bg.wasm`）、`coi-serviceworker.js` | `apps/viewer/web/index.html:111`、`apps/viewer/web/styles.css:30` |
| `apps/viewer/pkg/` | wasm-pack 产物（gitignore 覆盖，`apps/viewer/package.json:8` 生成） | `apps/viewer/src/core/bsp.ts:17` |
| `apps/viewer/dist/` | 打包产物目录（`apps/viewer/scripts/build-dist.mjs:44`） | `apps/viewer/scripts/build-dist.mjs:223` |

## 依赖方向

| 依赖 | 声明处 | 本工程的消费点 |
|---|---|---|
| 共享解析层 `websurf-wasm-core`（`src/wasm-core/**`） | `apps/viewer/crates/wasm/Cargo.toml:19` 的路径依赖 | `apps/viewer/crates/wasm/src/lib.rs:26` 一次 `use` 覆盖 `bsp_to_gltf_core` / `model_integrator` / `pakfile_models` / `texture_utils` / `vbsp` |
| 共享物理层 `websurf-phys`（`src/phys/**`） | **无声明**：本工程两份 `Cargo.toml` 都不引用它 | 无消费点（无物理、无碰撞） |
| 共享 TS 运行时 `src/ts-shared/wasm/loader.ts` | 相对路径 import | `apps/viewer/src/core/bsp.ts:18` 取 `base64ToBytes` 与 `readEmbeddedWasmB64` |
| 共享 TS 角度实现 `src/ts-shared/phys/angles.ts` | 相对路径再导出 | `apps/viewer/src/core/pose.ts:22` 再导出 `wrapDeg` / `bspYawToCsYaw`，再由 `apps/viewer/src/replay/helpers.ts:10` 与 `apps/viewer/src/core/spawn.ts:27` 消费 |
| 共享眼高常量 `src/ts-shared/phys/constants.ts` | 相对路径再导出 | `apps/viewer/src/core/constants.ts:35` 再导出 `EYE_STAND` |
| `three` 运行时 | `apps/viewer/package.json:29` | 场景、相机、材质、`GLTFLoader`、`mergeGeometries`（`apps/viewer/src/core/scene.ts:26`） |
| TypeScript 程序面 | `apps/viewer/tsconfig.json:15` 的 `include` 含 `../../src/ts-shared/**/*.ts` | 共享层 TS 文件参与本工程 `tsc --noEmit` |
| vendored `vmdl` | `apps/viewer/Cargo.toml:12` 的 `[patch.crates-io]` | `apps/viewer/crates/wasm/Cargo.toml:30` 的 `vmdl = "0.2"`（PAKFILE 内嵌模型解析） |

依赖方向单向：`apps/viewer → src/**` 与 `apps/viewer → three`；本工程不引另外两个工程的任何文件（三份 `lightmap-shader.ts` 是同构副本，彼此不 import，见 `apps/viewer/src/renderer/lightmap-shader.ts:7`）。

## 构建产物与脚本

`apps/viewer/package.json:7` 的 11 个 script 逐条：

| script | 锚点 | 做什么 | 产物 |
|---|---|---|---|
| `build:wasm` | `apps/viewer/package.json:8` | `wasm-pack build --release --target web` 后把 `pkg/websurf_viewer_wasm_bg.wasm` 复制到 `web/` | `apps/viewer/pkg/**`、`apps/viewer/web/websurf_viewer_wasm_bg.wasm` |
| `typecheck` | `apps/viewer/package.json:9` | `tsc --noEmit`（含 `test/**/*.ts` 与共享层 TS） | 无 |
| `test:replay` | `apps/viewer/package.json:10` | esbuild 打包 `apps/viewer/test/replay-selftest.ts` 到 `.tmp/replay-selftest/` 后交 node 执行 | `.tmp/replay-selftest/replay-selftest.mjs` |
| `local:smoke` | `apps/viewer/package.json:11` | 用 CDP 驱动本机 Edge 跑页面链路冒烟 | 无（控制台断言） |
| `build:worker` | `apps/viewer/package.json:12` | esbuild 打包 `apps/viewer/src/worker/main.ts` | `apps/viewer/web/worker.js` |
| `build:app` | `apps/viewer/package.json:13` | esbuild 打包 `apps/viewer/src/app.ts` | `apps/viewer/web/app.js` |
| `build:ts` | `apps/viewer/package.json:14` | 依次跑 `typecheck` → `build:worker` → `build:app` | 同上两个 `.js` |
| `build` | `apps/viewer/package.json:15` | `build:wasm` + `build:ts` | 全量 dev 产物 |
| `build:dist` | `apps/viewer/package.json:16` | `node scripts/build-dist.mjs`（默认 single 产物） | `apps/viewer/dist/**` |
| `check:api` | `apps/viewer/package.json:17` | `node scripts/check-wasm-api.mjs`（`pkg/*.d.ts` 契约 + TS 导入反向覆盖） | 无 |
| `dev` | `apps/viewer/package.json:18` | `python ../../src/serve.py 8100 .`（**端口 8100**，服务根 = 工程根） | 无 |

产物落点与形态：

- dev 侧产物在 `apps/viewer/web/`，三个文件都被 `apps/viewer/.gitignore:2` 到 `apps/viewer/.gitignore:4` 覆盖。
- 分发包在 `apps/viewer/dist/`，形态由 `apps/viewer/scripts/build-dist.mjs:46` 的 `--multi` 开关决定：默认 **single 产物**（依据 `apps/viewer/scripts/build-dist.mjs:51` 的 `KEEP_SINGLE`），加 `--multi` 出 **multi 产物**（依据 `apps/viewer/scripts/build-dist.mjs:61` 的 `KEEP_MULTI`）。两种形态都写同一个 `dist/`，后跑的那次覆盖前一次（`apps/viewer/scripts/build-dist.mjs:223` 的 `cleanDist`）。
- single 产物内嵌 WASM(base64) 与录像 Worker 代码，`index.html` 被改写成 classic `<script>`（`apps/viewer/scripts/build-dist.mjs:335`）；multi 产物另写外置 wasm、`wasm-embedded.js` 与注入了预缓存清单的 `coi-serviceworker.js`（`apps/viewer/scripts/build-dist.mjs:274`）。

## 启动链

1. `npm run dev` 起静态服务（`apps/viewer/package.json:18`，端口 8100），页面路径是 `/web/index.html`。
2. `apps/viewer/web/index.html:111` 以 `<script type="module" src="./app.js">` 加载 esbuild 产物；`apps/viewer/web/index.html:94` 的捕获阶段 `error` 监听在资源 404 时显示 `#fatal` 卡片。
3. `apps/viewer/src/app.ts:33` 取 `canvas#game`，取不到即抛错（`apps/viewer/src/app.ts:34`）。
4. `apps/viewer/src/app.ts:50` 建 `ViewerScene`（WebGL 渲染器 + 相机 + 三点光），失败时经 `Hud.showFatal` 提示后重抛（`apps/viewer/src/app.ts:52`）。
5. `apps/viewer/src/app.ts:59` 建 `FlyCam` 并 `attach` 到画布（注册 pointer lock、mousemove、keydown/keyup、blur）。
6. 侧栏标签页与 dock 取句柄并绑事件（`apps/viewer/src/app.ts:64` 到 `apps/viewer/src/app.ts:99`）；`MapPanel`（`apps/viewer/src/app.ts:111`）、`ReplayPanel`（`apps/viewer/src/app.ts:140`）、`ReplayMetaPanel` / `Timeline` / `TelemetryHud`（`apps/viewer/src/app.ts:170` 到 `apps/viewer/src/app.ts:176`）依次装配。
7. 对外接口挂到 `globalThis.viewer`（`apps/viewer/src/app.ts:352`）；URL 深链 `?bsp=` / `?replay=` 在启动末尾异步加载（`apps/viewer/src/app.ts:470`）。
8. `requestAnimationFrame(frame)` 起主循环（`apps/viewer/src/app.ts:524`）；WASM 直到用户真的选地图时才初始化（`apps/viewer/src/core/bsp.ts:116` 的 `await ensureWasm()`）。

## 不变量

| 不变量 | 由什么保证 | 锚点 |
|---|---|---|
| GLB 导出必须是 `BspProcessor` 的最后一次调用 | `export_glb_with_pakfile_models` 取走内部 `Bsp`，之后再调另两个方法返回错误 | `apps/viewer/crates/wasm/src/lib.rs:496`、`apps/viewer/crates/wasm/src/lib.rs:351` |
| `loadBspFile` 的三步顺序固定为 metadata → spawn → GLB | 前两步是借用方法、第三步消耗实例 | `apps/viewer/src/core/bsp.ts:122` 到 `apps/viewer/src/core/bsp.ts:125` |
| 静态光照必须早于空间分块合并 | 合并按材质实例分组，换过材质后再合并会失配；顺序写在 `mountGlb` 里 | `apps/viewer/src/core/scene.ts:200`、`apps/viewer/src/core/scene.ts:203` |
| 地图只有一个根句柄 | `modelRoot` 是 `worldBox` / `updateNearPlane` / `optimizeScene` / 换图释放的唯一范围 | `apps/viewer/src/core/scene.ts:77`、`apps/viewer/src/core/scene.ts:146` |
| 相机每帧只被一个写者写 | 回放第一人称段把 `fly.drivesCamera` 与 `fly.allowMove` 置假并用 `applyToWithRoll` 写相机；其余情况由 `FlyCam.update` + `applyTo` 写 | `apps/viewer/src/app.ts:488` 到 `apps/viewer/src/app.ts:503`、`apps/viewer/src/core/fly.ts:196` |
| 位姿角一律用度、弧度只在 `FlyCam` 内部 | `Pose.ang` 是度；`setPose` / `setWorld` 在边界处换算 | `apps/viewer/src/core/pose.ts:27`、`apps/viewer/src/core/fly.ts:207` |
| 采样二分要求时间轴单调不减 | `.replay` 路径由 `t(i) = (i − preFrames) / tickrate` 与 `tickrate > 0` 保证（解析期校验） | `apps/viewer/src/replay/sampling.ts:26`、`apps/viewer/src/replay/shavit-replay.ts:350` |
| 「Worker 坏掉」是单向的 | `ensureWorker` 一旦置 `workerBroken` 就不再重试，后续全部走主线程 | `apps/viewer/src/replay/importer.ts:78`、`apps/viewer/src/replay/importer.ts:104` |
| Worker 回传后本地 buffer 失效 | `t` / `pos` / `ang` 的 buffer 必进 transfer 列表，`vel` / `buttons` 存在才加 | `apps/viewer/src/worker/main.ts:88` 到 `apps/viewer/src/worker/main.ts:90` |
| 录像播放基准 = 帧自身坐标 | 解码只做轴序/朝向映射，平移与旋转只在 `RuleConfig.transform` 存在且非恒等时叠加 | `apps/viewer/src/replay/build.ts:29`、`apps/viewer/src/replay/types.ts:55` |
| 光照模式切换不重建场景 | 两种模式共用同一批注入材质，只改共享 uniform | `apps/viewer/src/renderer/lightmap-shader.ts:436`、`apps/viewer/src/core/scene.ts:245` |
