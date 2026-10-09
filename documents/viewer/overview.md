# WebSurf-viewer：工程总览

> 本文只覆盖 `apps/viewer`。所有结论来自源码、构建脚本与配置的实测；锚点格式为「相对仓库根路径:行号」。

---

## 工程定位

`apps/viewer` 是受控范围（`apps/debug` + `apps/game` + `apps/viewer` + `src/`）里的**只读查看器**：把 `.bsp` 地图解析成 GLB 场景供自由飞行观察，并把 Shavit 原生 `.replay` 记录（按帧自身坐标、可多轨道对齐比较）与 Source `.dem` 录像（整场长会话、按录像内绝对时刻）**各按一条独立的回放会话**播放出来——两条链路各持自己的播放器 / 3D 呈现 / 底部时间轴，互不影响（见 `documents/viewer/replay-vs-dem.md`）。

它与其他两个工程的定位差别由三处实测界定：

- **没有物理**：WASM 侧只暴露 BSP 解析与 GLB 导出（`apps/viewer/crates/wasm/src/lib.rs:427` 的 `BspProcessor::new` 之后是 `metadata` / `parse_spawn_points` / `parse_entities` / `parse_pvs_data` / `read_pakfile_file` / `decompress_mtz` / `decode_vtf_to_png` 与两个 `export_glb_*`），crate 依赖里没有 `websurf-phys`（`apps/viewer/crates/wasm/Cargo.toml:18`）。
- **不参与共享状态通道**：入口只打印 `crossOriginIsolated` 供核对，不建 `SharedArrayBuffer`、不选通道（`apps/viewer/src/app.ts:54`）。
- **有独立的解析 Worker**：Worker 只做 `.replay` 字节 → 结构化帧的解码（`apps/viewer/src/worker/main.ts:53` 的 `handle`），不做物理、不常驻状态机。

依据：`apps/viewer/package.json:7` 的 scripts（`build:wasm` / `typecheck` / `test:replay` / `test:sessions` / `local:smoke` / `build:worker` / `build:app` / `build:ts` / `build` / `build:dist` / `check:api` / `dev`），以及运行时依赖**已清空**、`three` 由仓库根 `package.json:6` 单实例承载（2026-10-02 上收，本工程 `package.json` 不再声明）。

## 目录职责

| 路径 | 职责 | 关键锚点 |
|---|---|---|
| `apps/viewer/src/app.ts` | 主线程装配入口：画布、场景、飞行相机、面板、按内容的导入分派 `routeFile`、URL 深链、帧循环、`globalThis.viewer` 接口 | `apps/viewer/src/app.ts:48`、`apps/viewer/src/app.ts:612`、`apps/viewer/src/app.ts:750` |
| `apps/viewer/src/core/` | BSP 加载与 WASM 懒初始化、three 场景与光照模式、自由飞行相机、位姿、常量、DOM 构件、出生点解析、导入文件的类型识别 | `apps/viewer/src/core/bsp.ts:87`、`apps/viewer/src/core/scene.ts:38`（ViewerScene，装配/光照/合并/近平面 2026-10-03 起走渲染共享层）、`apps/viewer/src/core/fly.ts:84`、`apps/viewer/src/core/spawn.ts:96`、`apps/viewer/src/core/filekind.ts:62` |
| `apps/viewer/src/replay/` | 记录（`.replay`）/ 录像（`.dem`）两条链路各持一份**独立回放会话**（`session.ts` 的 `ReplaySession`）、`.replay` 原生解析、导入与 Worker 协议、播放器与采样、多轨道容器、3D 呈现、记录 / 录像面板、轨迹列表、时间轴、人工变换 | `apps/viewer/src/replay/shavit-replay.ts:284`、`apps/viewer/src/replay/session.ts:62`、`apps/viewer/src/replay/player.ts:17`、`apps/viewer/src/replay/timeline.ts:52` |
| `apps/viewer/src/ui/` | HUD 与引导层、地图信息与出生点导航、记录信息条、**录像信息条**、遥测 HUD | `apps/viewer/src/ui/hud.ts:21`、`apps/viewer/src/ui/mapinfo.ts:124`、`apps/viewer/src/ui/demometa.ts:33`、`apps/viewer/src/ui/telemetry.ts:64` |
| `src/renderer-shared/`（仓库根，跨工程共享层） | 静态光照着色器单实例：RGBExp32 图集解码注入 + prop 三级光照路由（2026-10-02 由三工程各自的 `apps/<app>/src/renderer/lightmap-shader.ts` 合并而来，viewer 的 `src/renderer/` 目录因此清空） | `src/renderer-shared/shader/lightmap-shader.ts:472`、`src/renderer-shared/shader/lightmap-shader.ts:369` |
| `apps/viewer/src/worker/` | 记录解析 Worker 源码（esbuild 打成 `web/worker.js`） | `apps/viewer/src/worker/main.ts:46` |
| `apps/viewer/src/wasm.d.ts` | 把 `pkg/websurf_viewer_wasm.js` 的导出整体转出，供 `./wasm.js` 引用类型；本工程内零导入点 | `apps/viewer/src/wasm.d.ts:13` |
| `apps/viewer/crates/wasm/` | WASM 薄导出层（Rust）：`BspProcessor` 类 | `apps/viewer/crates/wasm/src/lib.rs:413` |
| `apps/viewer/scripts/` | 打包（single / multi）与 WASM 契约检查 | `apps/viewer/scripts/build-dist.mjs:223`、`apps/viewer/scripts/check-wasm-api.mjs:62` |
| `apps/viewer/test/` | Node 侧记录管线自检、CDP 冒烟、最小 Node 类型面 | `apps/viewer/test/replay-selftest.ts:45`、`apps/viewer/test/smoke-cdp.mjs:122` |
| `apps/viewer/web/` | 页面骨架、样式、dev 运行产物（`app.js` / `worker.js` / `websurf_viewer_wasm_bg.wasm`）、`coi-serviceworker.js` | `apps/viewer/web/index.html:12`、`apps/viewer/web/styles.css:24` |
| `apps/viewer/pkg/` | wasm-pack 产物（gitignore 覆盖，`apps/viewer/package.json:8` 生成） | `apps/viewer/src/core/bsp.ts:23` |
| `apps/viewer/dist/` | 打包产物目录（`apps/viewer/scripts/build-dist.mjs:44`） | `apps/viewer/scripts/build-dist.mjs:225` |

## 依赖方向

| 依赖 | 声明处 | 本工程的消费点 |
|---|---|---|
| 共享解析层 `websurf-wasm-core`（`src/wasm-core/**`） | `apps/viewer/crates/wasm/Cargo.toml:19` 的路径依赖 | `apps/viewer/crates/wasm/src/lib.rs:31` 一次 `use` 覆盖 `bsp_to_gltf_core` / `model_integrator` / `pakfile_models` / `texture_utils` / `vbsp` |
| 共享物理层 `websurf-phys`（`src/phys/**`） | **无声明**：本工程两份 `Cargo.toml` 都不引用它 | 无消费点（无物理、无碰撞） |
| 共享 TS 运行时 `src/ts-shared/wasm/loader.ts` | 相对路径 import | `apps/viewer/src/core/bsp.ts:24` 取 `base64ToBytes` 与 `readEmbeddedWasmB64` |
| 共享 TS 角度实现 `src/ts-shared/phys/angles.ts` | 相对路径再导出 | `apps/viewer/src/core/pose.ts:21` 再导出 `wrapDeg` / `bspYawToCsYaw`，再由 `apps/viewer/src/replay/helpers.ts:10` 与 `apps/viewer/src/core/spawn.ts:27` 消费 |
| 共享眼高常量 `src/ts-shared/phys/constants.ts` | 相对路径再导出 | `apps/viewer/src/core/constants.ts:34` 再导出 `EYE_STAND` |
| 共享渲染层 `src/renderer-shared/{shader,scene,camera,config}/` | tsconfig include 跨目录收编 + 深层相对路径 import（2026-10-03 起 viewer 消费 shader + scene-builder/scene-optimizer + near-plane；2026-10-09 增 `config/render-prefs`，呈现档改由共享层唯一来源提供） | `apps/viewer/src/core/scene.ts:12` 到 `apps/viewer/src/core/scene.ts:29`（导入面）与 `apps/viewer/src/ui/mapinfo.ts:23`（仅 `LightingMode` 类型）；three 依赖由根级 `package.json:6` 声明 |
| `three` 运行时 | 仓库根 `package.json:6`（单实例，2026-10-02 上收） | 场景、相机、材质、`GLTFLoader`（viewer 场景面：`apps/viewer/src/core/scene.ts:13`；`mergeGeometries` 已随合并下沉共享 scene-optimizer） |
| TypeScript 程序面 | `apps/viewer/tsconfig.json:15` 的 `include` 含 `../../src/ts-shared/**/*.ts` 与 `../../src/renderer-shared/**/*.ts` | 共享层 TS 文件参与本工程 `tsc --noEmit` |
| vendored `vmdl` | `apps/viewer/Cargo.toml:12` 的 `[patch.crates-io]` | `apps/viewer/crates/wasm/Cargo.toml:33` 的 `vmdl = "0.2"`（PAKFILE 内嵌模型解析） |

依赖方向单向：`apps/viewer → src/**`（含共享渲染层 `src/renderer-shared/**`）与 `apps/viewer → three`（依赖声明在仓库根 `package.json`）；本工程不引另外两个工程的任何文件（静态光照着色器是共享单实例，三工程经 tsconfig include 收编同一文件，见 `src/renderer-shared/shader/lightmap-shader.ts:6`）。

## 构建产物与脚本

`apps/viewer/package.json:7` 的 12 个 script 逐条：

| script | 锚点 | 做什么 | 产物 |
|---|---|---|---|
| `build:wasm` | `apps/viewer/package.json:8` | `wasm-pack build --release --target web` 后把 `pkg/websurf_viewer_wasm_bg.wasm` 复制到 `web/` | `apps/viewer/pkg/**`、`apps/viewer/web/websurf_viewer_wasm_bg.wasm` |
| `typecheck` | `apps/viewer/package.json:9` | `tsc --noEmit`（含 `test/**/*.ts` 与共享层 TS） | 无 |
| `test:replay` | `apps/viewer/package.json:10` | esbuild 打包 `apps/viewer/test/replay-selftest.ts` 到 `.tmp/replay-selftest/` 后交 node 执行 | `.tmp/replay-selftest/replay-selftest.mjs` |
| `test:sessions` | `apps/viewer/package.json:11` | `node test/session-sep.mjs`：自带静态服务器 + headless Edge + CDP 的**记录 / 录像链路分离**回归（拖入合成 `.replay` 只落记录会话且录像侧轨道数为 0，反之亦然；两边时长不互相撑长；切 tab 后非活动一侧停表）；缺夹具 / 浏览器时 loud skip | 无（控制台断言） |
| `local:smoke` | `apps/viewer/package.json:12` | 用 CDP 驱动本机 Edge 跑页面链路冒烟 | 无（控制台断言） |
| `build:worker` | `apps/viewer/package.json:13` | esbuild 打包 `apps/viewer/src/worker/main.ts` | `apps/viewer/web/worker.js` |
| `build:app` | `apps/viewer/package.json:14` | esbuild 打包 `apps/viewer/src/app.ts` | `apps/viewer/web/app.js` |
| `build:ts` | `apps/viewer/package.json:15` | 依次跑 `typecheck` → `build:worker` → `build:app` | 同上两个 `.js` |
| `build` | `apps/viewer/package.json:16` | `build:wasm` + `build:ts` | 全量 dev 产物 |
| `build:dist` | `apps/viewer/package.json:17` | `node scripts/build-dist.mjs`（默认 single 产物） | `apps/viewer/dist/**` |
| `check:api` | `apps/viewer/package.json:18` | `node scripts/check-wasm-api.mjs`（`pkg/*.d.ts` 契约 + TS 导入反向覆盖 + `BspMetadata`↔`BspMeta` 键名对齐） | 无 |
| `dev` | `apps/viewer/package.json:19` | `python ../../src/serve.py 8100 .`（**端口 8100**，服务根 = 工程根） | 无 |

产物落点与形态：

- dev 侧产物在 `apps/viewer/web/`，三个文件都被 `apps/viewer/.gitignore:2` 到 `apps/viewer/.gitignore:4` 覆盖。
- 分发包在 `apps/viewer/dist/`，形态由 `apps/viewer/scripts/build-dist.mjs:47` 的 `--multi` 开关决定：默认 **single 产物**（依据 `apps/viewer/scripts/build-dist.mjs:52` 的 `KEEP_SINGLE`），加 `--multi` 出 **multi 产物**（依据 `apps/viewer/scripts/build-dist.mjs:62` 的 `KEEP_MULTI`）。两种形态都写同一个 `dist/`，后跑的那次覆盖前一次（`apps/viewer/scripts/build-dist.mjs:225` 的 `cleanDist`）。
- single 产物内嵌 WASM(base64) 与记录 Worker 代码，`index.html` 被改写成 classic `<script>`（`apps/viewer/scripts/build-dist.mjs:342`）；multi 产物另写外置 wasm、`wasm-embedded.js` 与注入了预缓存清单的 `coi-serviceworker.js`（`apps/viewer/scripts/build-dist.mjs:280`）。

## 启动链

1. `npm run dev` 起静态服务（`apps/viewer/package.json:19`，端口 8100），页面路径是 `/web/index.html`。
2. `apps/viewer/web/index.html:153` 以 `<script type="module" src="./app.js">` 加载 esbuild 产物；`apps/viewer/web/index.html:136` 起的捕获阶段 `error` 监听在资源 404 时显示 `#fatal` 卡片。
3. `apps/viewer/src/app.ts:48` 取 `canvas#game`，取不到即抛错（`apps/viewer/src/app.ts:48`）。
4. `apps/viewer/src/app.ts:64` 建 `ViewerScene`（WebGL 渲染器 + 相机 + 三点光），失败时经 `Hud.showFatal` 提示后重抛（`apps/viewer/src/app.ts:65` 到 `apps/viewer/src/app.ts:70`）。
5. `apps/viewer/src/app.ts:74` 建 `FlyCam` 并挂共享位姿入口（T-454 P3a 起同一行的 `installPoseEntry(...)`，宿主用 `FlyCam.setPose`），`:75` `attach` 到画布（注册 pointer lock、mousemove、keydown/keyup、blur）。
6. 侧栏 / dock / 标签页取句柄并绑事件（`apps/viewer/src/app.ts:79` 到 `apps/viewer/src/app.ts:90`），tab 点击统一进唯一的切换点 `switchTab`（`apps/viewer/src/app.ts:175`）；随后两个回放会话各自构造（`apps/viewer/src/app.ts:100`），各自建自己的时间轴与信息条 —— 记录条在会话内建（`apps/viewer/src/replay/session.ts:86`），录像条由 `apps/viewer/src/app.ts:135` 单独建；两条各占 dock 的一层（记录层 = `#replayMeta` + `#timeline`，录像层 = `#demoInfo` + `#timelineDemo`，DOM 见 `apps/viewer/web/index.html:132`、`apps/viewer/web/index.html:136`），再按遥测 `TelemetryHud`（`apps/viewer/src/app.ts:127`）、`MapPanel`（`apps/viewer/src/app.ts:212`）、`ReplayPanel`（`apps/viewer/src/app.ts:283` 到 `apps/viewer/src/app.ts:314`）依次装配。
7. 对外接口挂到 `globalThis.viewer`（`apps/viewer/src/app.ts:750`）；URL 深链 `?bsp=` / `?replay=` 在启动末尾异步加载（`apps/viewer/src/app.ts:788` 到 `apps/viewer/src/app.ts:825`）。
8. `requestAnimationFrame(frame)` 起主循环（`apps/viewer/src/app.ts:1020`）；WASM 直到用户真的选地图时才初始化（`apps/viewer/src/core/bsp.ts:129` 的 `await ensureWasm()`）。

## 不变量

| 不变量 | 由什么保证 | 锚点 |
|---|---|---|
| GLB 导出必须是 `BspProcessor` 的最后一次调用 | `export_glb_with_pakfile_models` 取走内部 `Bsp`，之后再调另两个方法返回错误 | `apps/viewer/crates/wasm/src/lib.rs:586`、`apps/viewer/crates/wasm/src/lib.rs:441` |
| `loadBspFile` 的顺序固定为 metadata → spawn → 默认纹理包 → GLB（主导出，失败回退裸导出） | 前两步是借用方法、导出会取走实例 | `apps/viewer/src/core/bsp.ts:135` 到 `apps/viewer/src/core/bsp.ts:131` |
| 静态光照必须早于空间分块合并 | 合并按材质实例分组，换过材质后再合并会失配；顺序由共享 buildMapScene/applyLightmap 与 mountGlb 的编排共同固定 | `apps/viewer/src/core/scene.ts:187`、`apps/viewer/src/core/scene.ts:193` |
| | 地图只有一个根句柄 | `modelRoot` 是 `worldBox` / 近平面候选 / 分块合并 / 换图释放的唯一范围（2026-10-03 起根仍是 Scene（共享 buildMapScene 产物），替换走 `mountGlb`） | `apps/viewer/src/core/scene.ts:44`、`apps/viewer/src/core/scene.ts:182` 到 `apps/viewer/src/core/scene.ts:183` |
| 相机每帧只被一个写者写 | 只有**上场会话**给得出第一人称采样（`ReplaySession.cameraSample()` 对下场的会话恒返回 `null`，`apps/viewer/src/replay/session.ts:161`）：有采样时把 `fly.drivesCamera` 与 `fly.allowMove` 置假并用 `applyToWithRoll` 写相机；否则由 `FlyCam.update` + `applyTo` 写 | `apps/viewer/src/app.ts:974` 到 `apps/viewer/src/app.ts:993`、`apps/viewer/src/core/fly.ts:196` |
| 位姿角一律用度、弧度只在 `FlyCam` 内部 | `Pose.ang` 是度；`setPose` / `setWorld` 在边界处换算 | `apps/viewer/src/core/pose.ts:26`、`apps/viewer/src/core/fly.ts:207` |
| 采样二分要求时间轴单调不减 | `.replay` 路径由 `t(i) = (i − preFrames) / tickrate` 与 `tickrate > 0` 保证（解析期校验） | `apps/viewer/src/replay/sampling.ts:26`、`apps/viewer/src/replay/shavit-replay.ts:350` |
| 「Worker 坏掉」是单向的 | `ensureWorker` 一旦置 `workerBroken` 就不再重试，后续全部走主线程 | `apps/viewer/src/replay/importer.ts:71`、`apps/viewer/src/replay/importer.ts:91` |
| Worker 回传后本地 buffer 失效 | `t` / `pos` / `ang` 的 buffer 必进 transfer 列表，`vel` / `buttons` 存在才加 | `apps/viewer/src/worker/main.ts:88` 到 `apps/viewer/src/worker/main.ts:90` |
| 记录播放基准 = 帧自身坐标 | 解码只做轴序/朝向映射，平移与旋转只在 `RuleConfig.transform` 存在且非恒等时叠加 | `apps/viewer/src/replay/build.ts:29`、`apps/viewer/src/replay/types.ts:55` |
| 光照模式切换不重建场景 | 两种模式共用同一批注入材质，只改共享 uniform | `src/renderer-shared/shader/lightmap-shader.ts:431`、`apps/viewer/src/core/scene.ts:222` |

---

## 阅读顺序与事实来源（并入原 README.md）

> 本子树只覆盖 `apps/viewer`（BSP 地图预览 + Shavit `.replay` 记录 / Source `.dem` 录像两条链路的回放查看器）。全部结论以当前源码、构建脚本与配置为唯一来源；引用代码一律写成「相对仓库根路径:行号」并同时给出符号名。
> 术语：本工程**无权威物理**，只有「离线解析（`websurf-wasm-core`）」；不含「Worker 权威物理」与「主线程渲染物理（`predPhys`）」。
主题划分取自代码目录本身：`apps/viewer/src` 下实际存在 `core/`、`replay/`、`ui/`、`renderer/`、`worker/` 五个子目录，另有入口文件 `app.ts` 与类型入口 `wasm.d.ts`（合为一篇 `app.md`），工程级资产 `crates/wasm/`、`scripts/`、`test/`、`web/`、`*.cmd` 各成一节或独立成篇。
## 事实来源

本子树用到的入口文件（读码起点，全部实测读过）：

| 入口 | 锚点 | 提供了什么 |
|---|---|---|
| 工程清单 | `apps/viewer/package.json:7` | 12 个 script（含 `test:sessions` → `npm run test:sessions`：`apps/viewer/test/session-sep.mjs` 驱动的记录 / 录像两条链路**分离**端到端 CDP 回归，缺夹具 / 浏览器时 loud skip）、依赖面、引擎要求、dev 端口 8100 |
| 主线程入口 | `apps/viewer/src/app.ts:48` | 画布获取、装配顺序、帧循环、对外 `globalThis.viewer` 接口 |
| 地图加载 | `apps/viewer/src/core/bsp.ts:87` | `ensureWasm` 三条取值路径、`loadBspFile` 三步顺序 |
| 记录面板 | `apps/viewer/src/replay/panel.ts:311` | 导入入口 `runImport`、规则持久化、映射切换与变换微调 |
| 解析 Worker | `apps/viewer/src/worker/main.ts:46` | `ctx.onmessage` → `handle` → 带 transfer 列表回包 |
| WASM 导出层 | `apps/viewer/crates/wasm/src/lib.rs:427` | `BspProcessor::new` 与三个方法 |
| 打包脚本 | `apps/viewer/scripts/build-dist.mjs:223` | single / multi 两种产物形态与保留清单 |
| 页面骨架 | `apps/viewer/web/index.html:12` | 全部 DOM id 与脚本标签形态 |

共享层只被本工程**消费**（不修改）：`src/ts-shared/wasm/loader.ts`、`src/ts-shared/phys/angles.ts`、`src/ts-shared/phys/constants.ts`、`src/wasm-core/**`——消费点见 `documents/viewer/overview.md` 的「依赖方向」。

## 阅读顺序

1. `documents/viewer/overview.md` —— 先建立工程边界与构建面的整体认识。
2. `documents/viewer/sequences.md` —— 再看「谁在什么时候调用谁、数据落在哪个结构上」。
3. `documents/viewer/implementation/*.md` —— 逐主题看模块职责、导出清单与已知缺口；`replay.md` 是本工程体量最大的一条链路，建议在 `core.md` 之后读。
4. `documents/viewer/replay-vs-dem.md` —— 若要改「导入产物 → 展示」这一段（新增展示项、拆链路、动 `Clip` 契约），先读它：它把两条链路各自的产物与消费面、以及当前缝合点逐条钉死。
5. `documents/viewer/differences.md` —— 最后读，用于把本工程与另两个工程区分开（每条差异都带两侧锚点，不做跨工程类推）。
