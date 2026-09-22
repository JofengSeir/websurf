# apps/debug 与其它两工程的实测差异

本篇每条差异都**两侧各自实测**，证据给两侧锚点。凡未实测出差异的维度，条目里显式写明「本维度两工程实现一致」，同样给两侧锚点。

## 差异总表

| 维度 | 本工程 | 对比工程 | 证据（两侧锚点） |
|---|---|---|---|
| 渲染库 | three.js + `GLTFLoader` + `BufferGeometryUtils` 的 `mergeGeometries` | `apps/game`：同一套引入 | 本工程 `apps/debug/src/renderer/renderer-main.ts:23`；game `apps/game/src/renderer/renderer-main.ts:33` |
| 渲染库 | 同上 | `apps/viewer`：同一套引入 | 本工程 `apps/debug/src/renderer/renderer-main.ts:24`；viewer `apps/viewer/src/core/scene.ts:26` |
| 页面布局 | 左侧边栏（多个 `<details>` 分区）＋ 右侧预览区 | `apps/game`：全屏画布 + 单块 `#panel` 覆盖层 | 本工程 `apps/debug/web/index.html:292`（侧边栏）、`apps/debug/web/index.html:659`（预览区）；game `apps/game/web/index.html:72`（`#panel`）、`apps/game/web/index.html:27`（画布） |
| 页面布局 | 同上 | `apps/viewer`：顶栏 + 侧栏标签页（`#tabs` / `#pane-map` / `#pane-replay`）+ 底部 `#dock` | 本工程 `apps/debug/web/index.html:292`；viewer `apps/viewer/web/index.html:52`（顶栏）、`apps/viewer/web/index.html:76`（侧栏）、`apps/viewer/web/index.html:86`（dock） |
| 物理运行位置 | **Worker 权威物理** + **主线程渲染物理（`predPhys`）** 双线 | `apps/game`：同构双线（Worker 权威 + 主线程渲染物理） | 本工程 `apps/debug/src/worker/main.ts:455`、`apps/debug/src/renderer/renderer-main.ts:709`；game `apps/game/src/worker/main.ts:451`、`apps/game/src/renderer/renderer-main.ts:938` |
| 物理运行位置 | 同上 | `apps/viewer`：**无物理**（离线解析 + 纯视觉），Worker 只做录像解析 | 本工程 `apps/debug/src/renderer/renderer-main.ts:30`（引入 `PhysWorld`）；viewer `apps/viewer/src/app.ts:6`（定位为纯视觉、不引入物理与碰撞） |
| 共享状态通道 | `createMainSharedState`：SAB 通道优先，缺 `SharedArrayBuffer` 时落 postMessage 回退 | `apps/game`：同一函数、同一分支条件 | 本工程 `apps/debug/src/app.ts:325`、`apps/debug/src/app.ts:286`；game `apps/game/src/app.ts:158`、`apps/game/src/app.ts:102` |
| 共享状态通道 | 同上 | `apps/viewer`：不做通道选择（无物理，不需要共享内存） | 本工程 `apps/debug/src/app.ts:325`；viewer `apps/viewer/src/app.ts:37` |
| 配置来源 | 工程自带 `apps/debug/src/config.ts`：`DEFAULT_CONFIG` + `createConfig()` 深拷贝 | `apps/game`：同样自带 `apps/game/src/config.ts`（结构不同、字段集不同） | 本工程 `apps/debug/src/config.ts:205`、`apps/debug/src/config.ts:299`；game `apps/game/src/config.ts:176`、`apps/game/src/config.ts:239` |
| 配置来源 | 同上 | `apps/viewer`：**无 config.ts**，常量集中在 `core/constants.ts`，且注释面逐值对齐另两工程的同名列 | 本工程 `apps/debug/src/config.ts:205`；viewer `apps/viewer/src/core/constants.ts:24`、`apps/viewer/src/core/constants.ts:11` |
| 构建产物形态 | 两种形态同一入口，`--multi` 切换；`KEEP_SINGLE` **不含** `styles.css` | `apps/game`：同样两形态，但 `KEEP_SINGLE` **含** `styles.css` | 本工程 `apps/debug/scripts/build-dist.mjs:63`、`apps/debug/scripts/build-dist.mjs:75`；game `apps/game/scripts/build-dist.mjs:60` |
| 构建产物形态 | 同上 | `apps/viewer`：`KEEP_SINGLE` 额外含 `.nojekyll` / `README.md` / `serve.py` / `play.cmd` / `play.sh`，`KEEP_MULTI` 额外含 `wasm-embedded.js` | 本工程 `apps/debug/scripts/build-dist.mjs:63`；viewer `apps/viewer/scripts/build-dist.mjs:51`、`apps/viewer/scripts/build-dist.mjs:61` |
| 面板与 UI 结构 | 106 个页面 id，参数面板行由 `PARAM_DEFS` 动态渲染 | `apps/game`：93 个页面 id，面板由 `PanelController` 统一绑定 | 本工程 `apps/debug/web/index.html:494`（`#physicsParamList`）、`apps/debug/src/physics/param-defs.ts:47`；game `apps/game/web/index.html:72`、`apps/game/src/panel/panel-controller.ts:37` |
| 面板与 UI 结构 | 同上 | `apps/viewer`：26 个页面 id，面板拆成标签页与 dock | 本工程 `apps/debug/web/index.html:292`；viewer `apps/viewer/web/index.html:77`（`#tabs`）、`apps/viewer/web/index.html:89`（`#timeline`） |
| 测试与门禁脚本 | `package.json` 共 15 条 script，其中门禁类 7 条；`scripts/` 下另有 18 个 `.mjs` | `apps/game`：`package.json` 门禁类 4 条（`check:api` / `test:phys` / `test:seed-smoke` / `test:surf-crouch`），`scripts/` 下另有 20 个 `.mjs` | 本工程 `apps/debug/package.json:16`、`apps/debug/package.json:24`；game `apps/game/package.json:16`、`apps/game/package.json:19` |
| 测试与门禁脚本 | 同上 | `apps/viewer`：门禁类 3 条（`test:replay` / `local:smoke` / `check:api`），另有独立 `test/` 目录 | 本工程 `apps/debug/package.json:16`；viewer `apps/viewer/package.json:10`、`apps/viewer/package.json:17` |
| dev 端口 | `npm run dev` 监听 8080；`play.cmd` 默认 8081 | `apps/game`：`npm run dev` 监听 8090 | 本工程 `apps/debug/package.json:15`、`apps/debug/play.cmd:7`；game `apps/game/package.json:15` |
| dev 端口 | 同上 | `apps/viewer`：`npm run dev` 监听 8100 | 本工程 `apps/debug/package.json:15`；viewer `apps/viewer/package.json:18` |
| WASM 绑定层 | 自带 `crates/wasm`，crate 名 `websurf-wasm`，产物 `websurf_wasm_bg.wasm` | `apps/game`：自带 `crates/wasm`，产物同名 `websurf_wasm_bg.wasm` | 本工程 `apps/debug/package.json:8`；game `apps/game/package.json:8` |
| WASM 绑定层 | 同上 | `apps/viewer`：自带 `crates/wasm`，产物名 `websurf_viewer_wasm_bg.wasm`（不同名） | 本工程 `apps/debug/package.json:8`；viewer `apps/viewer/package.json:8` |
| 调试 API | 注册 `globalThis.__wsInput`（永久保留的无头驱动 API，20 余个方法） | `apps/game`：不注册同名 API（全仓 `__wsInput` 只在 debug 侧定义） | 本工程 `apps/debug/src/app.ts:1044`；game 侧零命中（`apps/game/src` 内无 `__wsInput`） |

## 维度覆盖核对

模板要求覆盖的七个维度与上表的对应关系：

1. **渲染后端与布局** —— 上表第 1–4 行覆盖：渲染库三工程一致（两侧锚点已给）；布局三工程各不相同。
2. **物理运行位置（主线程/Worker）** —— 上表第 5–6 行覆盖：debug 与 game 同构双线；viewer 无物理。
3. **共享状态通道** —— 上表第 7–8 行覆盖：debug 与 game 同一函数同一分支；viewer 不做通道选择。
4. **配置来源（默认值写在哪）** —— 上表第 9–10 行覆盖：debug 与 game 各有一份工程自带的 config.ts（`apps/debug/src/config.ts`、`apps/game/src/config.ts`）；viewer 用 `apps/viewer/src/core/constants.ts`。
5. **构建产物形态（single/multi）** —— 上表第 11–12 行覆盖：三工程都支持两形态，`KEEP_SINGLE` 集合不同。
6. **面板与 UI 结构** —— 上表第 13–14 行覆盖：三工程页面 id 数量与组织方式不同。
7. **测试与门禁脚本** —— 上表第 15–16 行覆盖：三工程 `package.json` 的门禁脚本名与数量不同。

## 与 game 的实现一致项（显式声明）

- 渲染库与加载器一致：两侧都从 `three` 取 `THREE`、从 `three/examples/jsm/loaders/GLTFLoader.js` 取 `GLTFLoader`，并从 `BufferGeometryUtils` 取 `mergeGeometries`（本工程 `apps/debug/src/renderer/renderer-main.ts:24`、`apps/debug/src/renderer/renderer-main.ts:26`；game `apps/game/src/renderer/renderer-main.ts:34`、`apps/game/src/renderer/renderer-main.ts:36`）。
- 通道选择条件一致：都以 `crossOriginIsolated === true` 且存在 `SharedArrayBuffer` 为建 SAB 的前提，否则落消息回退（本工程 `apps/debug/src/app.ts:286`；game `apps/game/src/app.ts:102`）。
- 权威物理的装配方式一致：两侧 Worker 都用共享层 `createAuthLoop` 推进权威实例、都用 `createWorkerDispatch` 处理消息（本工程 `apps/debug/src/worker/main.ts:455`、`apps/debug/src/worker/main.ts:470`；game `apps/game/src/worker/main.ts:451`、`apps/game/src/worker/main.ts:462`）。

## 与 viewer 的实现一致项（显式声明）

- 三工程的 `web/index.html` 都由构建脚本改写成 `single 产物` 的 classic script 形态，`multi 产物` 保留 module script；改写实现收敛在共享层 `src/scripts/lib/dist-pack.mjs`（本工程 `apps/debug/scripts/build-dist.mjs:43` 与 viewer `apps/viewer/scripts/build-dist.mjs:39` 都从该模块引入同一组打包辅助函数）。
- 三工程的 dev 服务器都是共享的 `src/serve.py`，只是端口与服务根不同（本工程 `apps/debug/package.json:15`；viewer `apps/viewer/package.json:18`）。
