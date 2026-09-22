# apps/debug 工程总览

## 工程定位

`apps/debug` 是三工程里唯一暴露完整调试面板与永久无头调试 API 的工程：它把「解析 BSP → 双线物理（Worker 权威物理 + 主线程渲染物理）→ Three.js 渲染 → 参数面板 / 路径记录 / 输入录制回放」全部装在一个页面里，供开发者在不改代码的前提下复现与定位物理问题。

依据：

- 入口是主线程装配函数 `apps/debug/src/app.ts:278` 的 `main`：它按固定顺序建共享缓冲、起 Worker、装渲染器、绑面板与输入循环。
- `apps/debug/package.json:15` 的 `dev` 脚本把工程根目录交给共享静态服务器（端口 8080），页面入口是 `apps/debug/web/index.html`。
- 调试 API 注册在 `apps/debug/src/app.ts:1044` 的 `globalThis.__wsInput`，注释面写明的契约见 `apps/debug/src/app.ts:984` 起的清单；同一份 API 在 `apps/game` 内不注册。
- 工程自带一份 WASM 绑定层 `apps/debug/crates/wasm/src/lib.rs`（crate `websurf-wasm`），与 `apps/game`、`apps/viewer` 各自独立。

## 目录职责

| 路径 | 职责 | 关键锚点 |
|---|---|---|
| `apps/debug/src/`（根级模块） | 主线程装配（`app.ts`）、运行时配置树（`config.ts`）、计时挑战状态机（`game-state.ts`）、默认纹理包（`default-pack.ts`）、主线程 wasm 懒初始化（`main-wasm.ts`）、手写 wasm 类型声明（`wasm.d.ts`） | `apps/debug/src/app.ts:278`、`apps/debug/src/config.ts:205`、`apps/debug/src/main-wasm.ts:28` |
| `apps/debug/src/renderer/` | 主线程渲染器 `RendererMain` 与七个子管理器：相机、光照、雾、LOD 剔除、碰撞可视化、路径记录、准星射线；另有 lightmap 着色器注入模块 | `apps/debug/src/renderer/renderer-main.ts:219`、`apps/debug/src/renderer/lod-manager.ts:87`、`apps/debug/src/renderer/lightmap-shader.ts:482` |
| `apps/debug/src/worker/` | Worker 入口装配（权威物理循环、消息分发、渲染轨迹采样、健康守护）、线程间消息类型面、物理面板协调器、内嵌纹理包暂存 | `apps/debug/src/worker/main.ts:455`、`apps/debug/src/worker/worker-types.ts:342`、`apps/debug/src/worker/physics-worker.ts:28` |
| `apps/debug/src/input/` | 键盘采集、主线程→Worker 消息桥、输入录制/回放器（含回放捕获与丢帧语义） | `apps/debug/src/input/keyboard.ts:56`、`apps/debug/src/input/input-bridge.ts:16`、`apps/debug/src/input/input-recorder.ts:166` |
| `apps/debug/src/world/` | WASM 导出 JSON 的类型面、brush 映射层、传送点数据层、自定义传送点 localStorage 层、出生点加载器（零调用点参考实现） | `apps/debug/src/world/types.ts:34`、`apps/debug/src/world/collider-adapter.ts:182`、`apps/debug/src/world/teleport-manager.ts:135` |
| `apps/debug/src/physics/` | 面板参数定义表、参数管理器（写 `set_params` / `set_hull`）、config → Rust 参数映射、向量工具与 cs-movement 碰撞类型 | `apps/debug/src/physics/param-defs.ts:47`、`apps/debug/src/physics/physics-params.ts:54`、`apps/debug/src/physics/prediction-params.ts:23` |
| `apps/debug/web/` | 页面骨架与全部 DOM id、样式、COOP/COEP 补丁脚本，以及构建产物落点（`app.js` / `worker.js` / `websurf_wasm_bg.wasm` / `textures.mtz`） | `apps/debug/web/index.html:283`、`apps/debug/web/styles.css:2`、`apps/debug/package.json:10` |
| `apps/debug/scripts/` | 构建 dist、WASM API 契约门、无头验收与度量脚本、部署站入口页模板、路径基线资产 | `apps/debug/scripts/build-dist.mjs:63`、`apps/debug/scripts/check-wasm-api.mjs:1`、`apps/debug/scripts/input-replay-verify.mjs:1` |
| `apps/debug/crates/wasm/` | 本工程的 WASM 绑定层：`BspProcessor` 全导出面 + 原样再导出共享层 `PhysWorld` | `apps/debug/crates/wasm/src/lib.rs:487`、`apps/debug/crates/wasm/src/lib.rs:55` |
| `apps/debug/fixtures/` | 门禁脚本的输入夹具（不参与运行时） | `apps/debug/package.json:22` |

## 依赖方向

本工程的依赖分三层，全部是单向：`apps/debug` → 共享层，没有反向引用。

| 依赖对象 | 声明处 | 消费点 |
|---|---|---|
| `websurf-phys`（`src/phys/**`） | `apps/debug/crates/wasm/Cargo.toml:22` 的 path 依赖 | 由 `apps/debug/crates/wasm/src/lib.rs:55` 的 `pub use websurf_phys::phys::PhysWorld` 原样再导出，JS 侧从 `apps/debug/pkg/websurf_wasm.js` 取 |
| `websurf-wasm-core`（`src/wasm-core/**`） | `apps/debug/crates/wasm/Cargo.toml:24` 的 path 依赖 | `apps/debug/crates/wasm/src/lib.rs:49` 引入 `vbsp` / `bsp_to_gltf_core` / `model_integrator` / `pakfile_models` / `texture_utils` |
| `src/ts-shared/**`（TypeScript 共享层） | `apps/debug/tsconfig.json:26` 的 `include` 把共享层的 `.ts` 纳入同一程序 | 主线程：`apps/debug/src/app.ts:33`（`shared-state`）、`apps/debug/src/app.ts:35`（`input-layer`）、`apps/debug/src/app.ts:36`（`world-builder`）；Worker：`apps/debug/src/worker/main.ts:27`（`auth-loop`）、`apps/debug/src/worker/main.ts:32`（`worker-dispatch`）、`apps/debug/src/worker/main.ts:33`（`phys/params`） |
| 渲染侧三方库 `three` | `apps/debug/package.json:27` 的 dependencies | `apps/debug/src/renderer/renderer-main.ts:23` 起的 `THREE` 与 `examples/jsm` 引入 |

两点与依赖面有关的事实：

- 本工程自带 `crates/wasm`，因此共享层的 Rust 代码通过 path 依赖进入本工程的 wasm 产物，而不是通过 npm 包。
- `apps/debug/tsconfig.json:19` 起的五个路径别名（`@physics/*` / `@world/*` / `@renderer/*` / `@input/*` / `@worker/*`）在 `apps/debug/src` 内**零导入点**：全部内部引用都写成相对路径（例：`apps/debug/src/app.ts:38` 的 `'./renderer/renderer-main.js'`）。

## 构建产物与脚本

`apps/debug/package.json:7` 的 `scripts` 共 15 条，逐条作用：

| 脚本（行号） | 作用与产物 |
|---|---|
| `build:wasm`（`apps/debug/package.json:8`） | 进 `crates/wasm` 跑 `wasm-pack build --release --target web --out-dir ../../pkg`，再把 `pkg/websurf_wasm_bg.wasm` 复制成 `apps/debug/web/websurf_wasm_bg.wasm` |
| `typecheck`（`apps/debug/package.json:9`） | `tsc --noEmit`，按 `apps/debug/tsconfig.json` 把 `src` 与共享层 `.ts` 一起检查 |
| `build:worker`（`apps/debug/package.json:10`） | esbuild 把 `apps/debug/src/worker/main.ts` 打成 `apps/debug/web/worker.js`（ESM） |
| `build:app`（`apps/debug/package.json:11`） | esbuild 把 `apps/debug/src/app.ts` 打成 `apps/debug/web/app.js`（ESM） |
| `build:ts`（`apps/debug/package.json:12`） | 依次跑 `typecheck` → `build:worker` → `build:app` |
| `build:dist`（`apps/debug/package.json:13`） | `node scripts/build-dist.mjs`，产出 `apps/debug/dist/`；带 `--multi` 时出 `multi 产物` |
| `build`（`apps/debug/package.json:14`） | `build:wasm` + `build:ts` |
| `dev`（`apps/debug/package.json:15`） | `python ../../src/serve.py 8080 .`，服务根 = 工程根目录，页面在 `/web/index.html` |
| `check:api`（`apps/debug/package.json:16`） | `node scripts/check-wasm-api.mjs`：wasm 导出面 ↔ TS 导入面契约门 |
| `count:glb-meshes`（`apps/debug/package.json:17`） | `node scripts/glb-mesh-count.mjs`：解析 BSP 导出的 GLB 并统计规模 |
| `bench:frames`（`apps/debug/package.json:18`） | `node scripts/frame-bench.mjs`：headless 逐帧耗时实测 |
| `test:optimize-scene`（`apps/debug/package.json:19`） | 先 esbuild 打包 `apps/debug/src/renderer/renderer-main.ts` 到 `.tmp/opt-verify/`，再 `node scripts/optimize-scene-verify.mjs` |
| `test:surf-crouch`（`apps/debug/package.json:20`） | `node scripts/phys-surf-crouch-smoke.mjs`：直接对 `apps/debug/pkg` 的 wasm 产物跑贴坡蹲姿用例 |
| `plot:path`（`apps/debug/package.json:21`） | `node scripts/plot-path.mjs`：把面板导出的物理路径 JSON 画成 PNG |
| `test:path-acceptance`（`apps/debug/package.json:22`） | `node scripts/path-acceptance.mjs fixtures/path/tick-on-render-prefix.json --assert --expect fail` |
| `test:auth-clock`（`apps/debug/package.json:23`） | 先打包 `src/ts-shared/auth/auth-loop.ts` 到 `.tmp/auth-clock/`，再 `node scripts/auth-clock-verify.mjs` |
| `test:jump-apex`（`apps/debug/package.json:24`） | 先打包 `src/ts-shared/phys/authority-calibrator.ts` 到 `.tmp/jump-apex/`，再 `node scripts/jump-apex-verify.mjs` |

产物落点：

- `apps/debug/web/`：`app.js` 与 `worker.js` 是 esbuild 产物，`websurf_wasm_bg.wasm` 是 `build:wasm` 的副本（`apps/debug/package.json:8`），`textures.mtz` 是默认纹理包（离线资产）。
- `apps/debug/pkg/`：wasm-pack 的输出目录，`apps/debug/scripts/build-dist.mjs:50` 从该目录取 wasm 文件名常量。
- `apps/debug/dist/`：`apps/debug/scripts/build-dist.mjs:48` 定义的目标目录。`single 产物` 保留的清单是 `apps/debug/scripts/build-dist.mjs:63` 的 `KEEP_SINGLE`；`multi 产物` 的清单是 `apps/debug/scripts/build-dist.mjs:64` 的 `KEEP_MULTI`（多出 `worker.js` / wasm / `textures.mtz` / `coi-serviceworker.js`）。
- 三个 `.cmd` 是并行的手工入口：`apps/debug/start-dev.cmd:7` 默认端口 8080 并自带工具链与 wasm 过期门，`apps/debug/play.cmd:7` 默认端口 8081 且先构建 `single 产物` 再服务，`apps/debug/build-dist.cmd:7` 默认 `single`、接受 `multi` 参数。

## 启动链

从 `npm run dev` 到页面可交互的链路（参与者 → 动作）：

1. `npm run dev`（`apps/debug/package.json:15`）→ `src/serve.py` 以 8080 为端口、以工程根为服务根启动；浏览器打开 `/web/index.html`。
2. 页面加载 COOP/COEP 补丁脚本（`apps/debug/web/index.html:695`）与打包后的 `app.js`（`apps/debug/web/index.html:696`）。
3. `app.js` 执行到 `apps/debug/src/app.ts:278` 的 `main`：先取画布句柄，取不到直接返回（`apps/debug/src/app.ts:279`）。
4. 通道选择：`crossOriginIsolated === true` 且存在 `SharedArrayBuffer` 时建 `SHARED_BUFFER_SIZE` 的共享缓冲，否则置 `null`（`apps/debug/src/app.ts:286`）。
5. 建 Worker：有内嵌 Worker 源码（构建注入的 `__VBSP_WORKER_JS__`）则走 Blob URL，否则 `new Worker('./worker.js', { type: 'module' })`（`apps/debug/src/app.ts:298`）。
6. 下发 wasm：内嵌时把 `wasmB64` 放进 `wasm-init`，否则改用 `wasmUrl`；两条分支都带 `mtzB64`（构建未注入该全局键时其值为 `undefined`）（`apps/debug/src/app.ts:315`）。
7. 建共享状态与消息桥：`createMainSharedState(sharedBuffer, worker)`（`apps/debug/src/app.ts:325`）、`new InputBridge(worker)`（`apps/debug/src/app.ts:327`）并 `sendInit`（`apps/debug/src/app.ts:328`）。
8. 建渲染器并注册四个回调：`onCullStats` / `onSceneLoaded` / `onSyncRenderState` / `onPhysEvent`，随后 `init` 与 `start`（`apps/debug/src/app.ts:336` 起）。
9. 主线程 wasm 懒初始化 `ensureMainWasm()` 的结果存进 `mainWasmReady`（`apps/debug/src/app.ts:362`）。
10. 绑输入与面板：`bindInput`（`apps/debug/src/app.ts:367`）、`loadUiPrefs` → `syncPrefsControls` → `applyCrosshairStyle` → `sendPrefsToWorker` → `bindUI`（`apps/debug/src/app.ts:369` 起）。
11. 起输入循环 `startInputLoop`（`apps/debug/src/app.ts:380`），并刷新录制面板状态（`apps/debug/src/app.ts:382`）。
12. Worker 侧 `init` 处理完后回 `ready`（`apps/debug/src/worker/main.ts:483`），主线程在 `apps/debug/src/app.ts:393` 的 `ready` 分支把状态栏改成「Worker 已就绪。请加载 .bsp 文件。」。
13. 用户通过 `#bspFile` 选图 → `apps/debug/src/app.ts:1881` 的 `handleBspFile` → 主线程解析并装载世界。

## 不变量

以下不变量由本工程代码保证，改动前需连带检查：

1. **权威物理只有 Worker 一个推进者**：Worker 侧权威实例由 `apps/debug/src/worker/main.ts:455` 装配的 `createAuthLoop` 独占推进；主线程收到 `phys-frame` 只做缓存（`apps/debug/src/app.ts:397`），不 tick 权威实例。
2. **固定步长来自面板 tickRate，且不进 Rust**：`tickRate` 变更经 `apps/debug/src/worker/main.ts:466` 的 `onTickRateChange` 调 `authLoop.setFixedDt`，仅在步长真的变化时才 `reset()`。
3. **主线程每个渲染帧最多推进 1 个物理步**：`apps/debug/src/renderer/renderer-main.ts:709` 是 `tick` 内唯一的 `predPhys.tick` 调用点；单步闸门打开时每帧配额再减一（`apps/debug/src/renderer/renderer-main.ts:672`）。
4. **回放步长是一次性载荷**：`apps/debug/src/renderer/renderer-main.ts:680` 在读走 `replayDtS` 后立即置 `null`，输入循环用 `replayDtS === null` 作为「上一帧已被消费」的握手信号（`apps/debug/src/app.ts:2372`）。
5. **输入增量是累加语义、按键掩码是覆盖语义**：`apps/debug/src/renderer/renderer-main.ts:1175` 的 `feedInput` 对 `dx`/`dy` 累加、对 `keys` 直接赋值，消费后清零增量（`apps/debug/src/renderer/renderer-main.ts:710`）。
6. **双端物理参数同源**：主线程与 Worker 都从同一份 config 出发，映射实现收敛在 `src/ts-shared/phys/params.ts`（`apps/debug/src/physics/prediction-params.ts:23`、`apps/debug/src/worker/main.ts:62`）。
7. **主线程与 Worker 各持独立 wasm 实例**：主线程由 `apps/debug/src/main-wasm.ts:28` 的 `ensureMainWasm` 初始化，Worker 在自己的作用域内独立 `initSync`（`apps/debug/src/worker/main.ts:479`）。
8. **剔除距离由场景对角线唯一确定**：`apps/debug/src/renderer/lod-manager.ts:155` 起三行给出上限、下限与默认值的算式，面板滑块只能在该上限内改写（`apps/debug/src/renderer/lod-manager.ts:276`）。
9. **渲染轨迹采样与渲染节点一一对应**：同一帧同一三元组先落 `PathRecorder` 渲染节点、再写共享内存采样槽，`i0` 取同一次自增（`apps/debug/src/renderer/renderer-main.ts:721` 与 `apps/debug/src/renderer/renderer-main.ts:725`）。
10. **权威帧版本号单调**：`va` 由发布方单调递增（`apps/debug/src/worker/worker-types.ts:248`），主线程按它去重（`apps/debug/src/renderer/renderer-main.ts:699`）。
