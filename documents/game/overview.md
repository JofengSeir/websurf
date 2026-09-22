# WebSurf-game 工程总览

## 工程定位

`apps/game` 是受控范围内三个可运行工程之一，定位是**可玩闭环**：一张画布上跑「主线程渲染物理（`predPhys`）+ Worker 权威物理 + ESC 控制面板 + 存点 + 地图加载进度」。

- 工程自述与入口脚本：`apps/game/package.json:4` 的 `description`、`apps/game/package.json:7` 的 `scripts`。
- 唯一入口模块：`apps/game/src/app.ts` 的 `main`（`apps/game/src/app.ts:94`），文件末 `void main()`（`apps/game/src/app.ts:832`）触发；画布缺失时直接返回（`apps/game/src/app.ts:95`）。
- 两条物理线同时存在：Worker 侧由 `createAuthLoop` 驱动（`apps/game/src/worker/main.ts:451`），主线程侧由 `RendererMain.buildPredictionWorld` 建实例（`apps/game/src/renderer/renderer-main.ts:683`）并在每帧 `tick` 推进（`apps/game/src/renderer/renderer-main.ts:938`）。
- 交互面：页面 `apps/game/web/index.html` 声明的挂载点由 `apps/game/src/app.ts` 的 `dom` 表（`apps/game/src/app.ts:43`）与 `PanelController`（`apps/game/src/panel/panel-controller.ts:37`）绑定；本次实测 `apps/game/src` 下 45 个 `getElementById` 字面量 id 在 `apps/game/web/index.html` 中全部存在，8 个选择器查询也各自有对应结构。
- dev 端口 8090：`apps/game/package.json:15`。

## 目录职责

| 路径 | 职责 | 关键锚点 |
|---|---|---|
| `apps/game/src/` | 主线程与 Worker 的 TypeScript 源码（`apps/game/src/app.ts`、`apps/game/src/config.ts`、`apps/game/src/savepoint.ts`、`apps/game/src/wasm.d.ts` 四个根文件） | `apps/game/src/app.ts:94` 的 `main` |
| `apps/game/src/input/` | 键位表与持久化、键盘状态、面板参数下发桥 | `apps/game/src/input/input-bridge.ts:41` 的 `sendConfig` |
| `apps/game/src/panel/` | ESC 面板控制器：导航切换、控件接线、偏好持久化、存点列表 | `apps/game/src/panel/panel-controller.ts:37` 的 `PanelController` |
| `apps/game/src/renderer/` | 主线程渲染物理与场景：GLB 装载、光照注入、分块合并、剔除、出帧探针 | `apps/game/src/renderer/renderer-main.ts:116` 的 `RendererMain` |
| `apps/game/src/worker/` | Worker 权威物理入口与消息协议类型声明 | `apps/game/src/worker/main.ts:451` 的 `createAuthLoop` |
| `apps/game/src/world/` | 向量与 PVS 类型出口（转出共享层类型） | `apps/game/src/world/types.ts:12` 的类型转出 |
| `apps/game/web/` | 手写页面资产（`index.html`、`styles.css`、`coi-serviceworker.js`）与 esbuild 产物落点 | `apps/game/web/index.html:27` 的 `canvas#preview` |
| `apps/game/scripts/` | 构建脚本与物理冒烟脚本（`build-dist.mjs`、`check-wasm-api.mjs`、`phys-*.mjs`） | `apps/game/scripts/build-dist.mjs:60` 的 `KEEP_SINGLE` |
| `apps/game/crates/wasm/` | 本工程唯一的 Rust crate：BSP 解析 / GLB 导出 / 物理的 wasm 绑定 | `apps/game/crates/wasm/Cargo.toml:22` 的 path 依赖 |
| `apps/game/pkg/` | wasm-pack 产物目录（`--out-dir ../../pkg`），被 `.gitignore` 排除 | `apps/game/package.json:8` |
| `apps/game/dist/` | 发行产物目录，由 `scripts/build-dist.mjs` 先删后建 | `apps/game/scripts/build-dist.mjs:215` 的 `cleanDist` |
| `apps/game/temp/` | 构建日志文本（非代码、非文档树） | 无（不参与构建） |

`.gitignore` 的排除面：`dist/`、`pkg/`、`target/`、`web/app.js`、`web/worker.js`、`web/websurf_wasm_bg.wasm`（`apps/game/.gitignore:4`）。

## 依赖方向

本工程依赖共享层 `src/**`，并自带一个 `crates/wasm`：

- 共享物理层 `websurf-phys`（`src/phys/**`）：`apps/game/crates/wasm/Cargo.toml:22` 的 path 依赖 `../../../../src`，由 `apps/game/crates/wasm/src/lib.rs:35` 的 `pub use websurf_phys::phys::PhysWorld` 转出。
- 共享解析层 `websurf-wasm-core`（`src/wasm-core/**`）：`apps/game/crates/wasm/Cargo.toml:24`。
- 共享 TS 层 `src/ts-shared/**`：`apps/game/tsconfig.json:15` 把 `../../src/ts-shared/**/*.ts` 列入 `include`。实际 import 面：
  - `apps/game/src/app.ts:32-36`：`MouseBuffer`、`PointerLockController`、`createMainSharedState`/`SHARED_BUFFER_SIZE`/`keysToMask`/`KEY_MASK`、`layerMouseDelta`/`qeEquivalentDx`、`buildWorldBundle`。
  - `apps/game/src/renderer/renderer-main.ts:40-44`：`ShmState`/`MsgState` 类型、`AuthorityCalibrator`、`PvsManager`、`base64ToBytes`、`EYE_STAND`。
  - `apps/game/src/worker/main.ts:66-73`：`ShmState`/`MsgState`/`RenderSample` 类型、`createAuthLoop`、`createWorkerDispatch`、`buildPhysicsParams`。
  - `apps/game/src/input/keyboard.ts:17` 与 `apps/game/src/input/keymap.ts:17`：`keysToMask` 与 `KeyState` 类型。
- wasm 胶水：`apps/game/src/app.ts:27`、`apps/game/src/worker/main.ts:65`、`apps/game/src/renderer/renderer-main.ts:37` 三处直接 import `../pkg/websurf_wasm.js` 或 `../../pkg/websurf_wasm.js`；`apps/game/src/wasm.d.ts:16` 用一条 `export *` 转出同一声明，供类型检查兜底。
- workspace 与补丁：`apps/game/Cargo.toml:7` 的 `members = ["crates/wasm"]`、`apps/game/Cargo.toml:13-14` 把 `vmdl` patch 到 `src/vendor/vmdl`。

依赖方向是单向的：本工程 import 共享层，共享层不 import 本工程。

## 构建产物与脚本

| script | 做什么 | 产物落点 | 锚点 |
|---|---|---|---|
| `build:wasm` | wasm-pack release 构建（`--target web`）并把 wasm 复制到 `web/` | `apps/game/pkg/`、`apps/game/web/websurf_wasm_bg.wasm` | `apps/game/package.json:8` |
| `typecheck` | `tsc --noEmit`（`noEmit: true`） | 无 | `apps/game/package.json:9`、`apps/game/tsconfig.json:8` |
| `build:worker` | esbuild 打包 Worker 入口为 ESM | `apps/game/web/worker.js` | `apps/game/package.json:10` |
| `build:app` | esbuild 打包主线程入口为 ESM | `apps/game/web/app.js` | `apps/game/package.json:11` |
| `build:ts` | `typecheck` → `build:worker` → `build:app` | 同三行 | `apps/game/package.json:12` |
| `build:dist` | 发行打包（缺省 single、`--multi` 走 multi） | `apps/game/dist/` | `apps/game/package.json:13`、`apps/game/scripts/build-dist.mjs:74` |
| `build` | `build:wasm` → `build:ts` | 同上 | `apps/game/package.json:14` |
| `dev` | 起本地 HTTP 服务（`src/serve.py`，带 COOP/COEP 头） | 服务根 = 本工程目录 | `apps/game/package.json:15`、`src/serve.py:39` |
| `check:api` | wasm 契约检查（声明面 + 导入面两级） | stdout + 退出码 | `apps/game/package.json:16`、`apps/game/scripts/check-wasm-api.mjs:81` |
| `test:phys` | 物理冒烟（九段） | stdout + 退出码 | `apps/game/package.json:17` |
| `test:seed-smoke` | 种子面 v2 回归 | stdout + 退出码 | `apps/game/package.json:18` |
| `test:surf-crouch` | surf 蹲伏冒烟 | stdout + 退出码 | `apps/game/package.json:19` |

产物形态（`apps/game/scripts/build-dist.mjs:60` 与 `:62` 两份保留名单）：

- **single 产物**：`index.html`（改写成 classic script）、`app.js`（IIFE，前置 `__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` / `__VBSP_TEXTURES_MTZ_B64__` 三个内嵌全局）、`styles.css`、许可证两份。本次实测磁盘上的 `apps/game/dist/` 正是这 5 个文件。
- **multi 产物**：额外产出 `worker.js`、`websurf_wasm_bg.wasm`、`textures.mtz`、`coi-serviceworker.js`（注入预缓存清单与内容哈希缓存名）。
- 许可证副本的唯一来源是 `src/phys` 目录下的 `LICENSE` / `NOTICE`（`apps/game/scripts/build-dist.mjs:221-226`），缺源即抛错。

## 启动链

1. `npm run dev`（`apps/game/package.json:15`）→ `python ../../src/serve.py 8090 .`，服务根为工程目录；响应带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`（`src/serve.py:39`），这是页面拿到 `crossOriginIsolated`、进而拿到 `SharedArrayBuffer` 的前提。
2. 浏览器加载 `web/index.html`；页面先加载 `./coi-serviceworker.js`，再以 module script 加载构建产物 `./app.js`（`apps/game/web/index.html:290` 与 `:291`）。因此 dev 链路要求先跑过 `npm run build:ts`（`apps/game/package.json:12`）。
3. `main()` 判通道：`crossOriginIsolated` 为真且 `SharedArrayBuffer` 存在才新建共享缓冲（`apps/game/src/app.ts:108`、`apps/game/src/app.ts:112`），否则该实参传 `null`（`apps/game/src/app.ts:112`）。
4. 建 Worker 并立即发两条引导消息：`init`（`apps/game/src/app.ts:148`）与 `wasm-init`（`apps/game/src/app.ts:152` 内嵌 base64 分支、`apps/game/src/app.ts:154` URL 分支）。
5. 建共享状态通道：`createMainSharedState(sharedBuffer, fixWorker)`（`apps/game/src/app.ts:158`）。
6. 建 `RendererMain`（`apps/game/src/app.ts:162`）→ `init`（`apps/game/src/app.ts:169`）→ `start`（`apps/game/src/app.ts:170`，起 rAF 循环）→ `installFrameProbe`（`apps/game/src/app.ts:173`）→ 主线程 wasm 初始化 promise（`apps/game/src/app.ts:176`）。
7. 建 `InputBridge`（`apps/game/src/app.ts:181`）并按四段下发一次全量配置（`apps/game/src/app.ts:182` 调 `syncFullConfig`，段表见 `apps/game/src/app.ts:642`）。
8. 建 `PanelController`（`apps/game/src/app.ts:185`）：构造期依次 `loadPanelPrefs` → `bindEvents` → `bindModuleNav` → `renderKeyList` → `syncControlsFromConfig` → `sendAllPrefs` → `applyCrosshair`（`apps/game/src/panel/panel-controller.ts:82-90`）。
9. 输入就位：`initKeyHud` → `bindInput` → `startInputLoop`（`apps/game/src/app.ts:219-221`）。此时页面可交互，但直到用户选图并解析完成前 `sceneReady` 仍为假（`apps/game/src/app.ts:80` 声明、`apps/game/src/app.ts:575` 置真）。
10. 选图：`#loadMapBtn` 触发隐藏的 `#bspFile`（`apps/game/src/app.ts:317`），`change` 事件把文件字节交给 `handleLoadBsp`（`apps/game/src/app.ts:321` 与 `apps/game/src/app.ts:326`）。

## 不变量

- **单写者（输入）**：每帧只有 `RendererMain.tick` 一处写共享输入槽（`apps/game/src/renderer/renderer-main.ts:932`）；`InputBridge.addInput` 是显式空实现（`apps/game/src/input/input-bridge.ts:30`），不退化成第二条写入路径。
- **同源输入**：真实鼠标增量先经 `layerMouseDelta` 乘灵敏度（`apps/game/src/app.ts:235`，实现在 `src/ts-shared/input/input-layer.ts:25`），Q/E 转向经 `qeEquivalentDx`（`apps/game/src/app.ts:411`）；物理参数里的 `sensitivity` 恒为 1（`src/ts-shared/phys/params.ts:67`），因此改灵敏度不会让两条物理线拿到不同参数。
- **固定步长**：Worker 权威物理的步长由 `setFixedDt` 按 tickRate 折算，初值 1/64 秒（`src/ts-shared/auth/auth-loop.ts:252`），步长未变时 `setFixedDt` 返回 false、调用方据此跳过累积器清零（`src/ts-shared/auth/worker-dispatch.ts:359`）。
- **权威是速度之主**：主线程每帧依次调 `correctFromAuthority` 与 `calibrateVelocity`（`apps/game/src/renderer/renderer-main.ts:934`、`apps/game/src/renderer/renderer-main.ts:936`），稳态下权威只改渲染速度、不改渲染位置（`src/ts-shared/phys/authority-calibrator.ts:33` 的口径说明）。
- **世代单调（渲染采样）**：位置突变时失效世代 +1（`apps/game/src/renderer/renderer-main.ts:235` 的 `bumpSampleEpoch`），换图与重建物理世界时索引空间重启（`apps/game/src/renderer/renderer-main.ts:241`），世代槽由共享层独占维护、调用方不传值（`apps/game/src/renderer/renderer-main.ts:955`）。
- **装配顺序**：GLB 挂载 → 摘除 punctual 光源 → 施加 lightmap → 分块合并 → 受光材质终扫 → 预编译（`apps/game/src/renderer/renderer-main.ts:344`、`:358`、`:366`、`:372`、`:387`）；顺序被注释与实现共同固定，例如光源必须在 `scene.add` 之前摘除（`apps/game/src/renderer/renderer-main.ts:340`）。
- **加载进度单调**：阶段名到百分比的映射是常量表（`apps/game/src/app.ts:679`），覆盖层用补间朝目标逼近（`apps/game/src/app.ts:727`）；失败时覆盖层转错误态而非直接消失（`apps/game/src/app.ts:803`）。
- **键位单一来源**：HUD 标签与面板读同一份 `loadKeymap()`（`apps/game/src/app.ts:70` 注册刷新、`apps/game/src/app.ts:462` 写标签），改键后两边同步变化。
