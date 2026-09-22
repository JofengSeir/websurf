# implementation：scripts

主题对应 `apps/debug/scripts/**`（18 个 `.mjs` + 两个资产文件）与工程根三个 `.cmd` 手工入口。这些脚本不参与运行时，只承担构建、门禁与无头验收。

## 模块职责

**构建与契约门**

| 脚本 | 入口 | 职责 |
|---|---|---|
| `apps/debug/scripts/build-dist.mjs` | `npm run build:dist`（`apps/debug/package.json:13`） | 出 `single 产物`（默认，`apps/debug/scripts/build-dist.mjs:88` 起）或 `multi 产物`（`--multi`，`apps/debug/scripts/build-dist.mjs:75`）；`KEEP_SINGLE` 见 `apps/debug/scripts/build-dist.mjs:63`，`KEEP_MULTI` 见 `:64`；输入前置检查要求 `apps/debug/pkg/websurf_wasm_bg.wasm` 与仓库纹理包都存在（`apps/debug/scripts/build-dist.mjs:77`） |
| `apps/debug/scripts/check-wasm-api.mjs` | `npm run check:api`（`apps/debug/package.json:16`） | 三层校验：声明面（`pkg` 的 `.d.ts` 必须有 `BspProcessor` 与 `PhysWorld`）、导入面（`src` 下全部 `.ts` 对 pkg 的导入符号必须是 pkg 导出面的子集）、不变量（导入面不得为空）。薄配置：检查引擎在共享层 `src/scripts/lib/wasm-api-contract.mjs` |
| `apps/debug/scripts/pages-index.html` | 无（资产） | 部署站入口页模板，被 `.github/workflows/deploy-pages.yml:176` 复制成 `deploy/index.html` |

**无头验收与度量**

| 脚本 | 入口 | 职责 |
|---|---|---|
| `apps/debug/scripts/optimize-scene-verify.mjs` | `npm run test:optimize-scene`（`apps/debug/package.json:19`） | 先由 npm script 把 `RendererMain` 打成 ESM bundle，再直接调其 `optimizeScene` 做真实代码验证 |
| `apps/debug/scripts/auth-clock-verify.mjs` | `npm run test:auth-clock`（`apps/debug/package.json:23`） | 权威时钟验证（确定性 Node 测试）：`auth-loop` 的 `reset()` 语义与 `worker-dispatch` 只在步长真变化时 `reset()` |
| `apps/debug/scripts/path-acceptance.mjs` | `npm run test:path-acceptance`（`apps/debug/package.json:22`） | tick 点到渲染折线的垂距验收门：逐 tick 点取到所有合格线段的最短距离，按 `--jump-hu` 过滤跳变段 |
| `apps/debug/scripts/phys-surf-crouch-smoke.mjs` | `npm run test:surf-crouch`（`apps/debug/package.json:20`） | 直接对 `apps/debug/pkg` 的 wasm 产物跑三条贴坡/蹲姿用例，任一失败即 `FAIL` 并以 1 退出 |
| `apps/debug/scripts/input-replay-verify.mjs` | 无 npm script（手工 / 无头驱动） | 输入录制与确定性回放的无头验收：逐帧输入一致、逐帧位置差、帧数一致三组判据，经 `globalThis.__wsInput` 驱动真实页面 |
| `apps/debug/scripts/frame-bench.mjs` | `npm run bench:frames`（`apps/debug/package.json:18`） | headless 逐帧耗时实测：取 400 个帧间隔样本并打印分位数，另给一行 `RESULT_JSON` |
| `apps/debug/scripts/glb-mesh-count.mjs` | `npm run count:glb-meshes`（`apps/debug/package.json:17`） | 用 `apps/debug/pkg` 的 wasm 产物解析 BSP、导出 GLB、就地解析 GLB 的 JSON chunk 统计规模 |
| `apps/debug/scripts/plot-path.mjs` | `npm run plot:path`（`apps/debug/package.json:21`） | 把面板导出的物理路径 JSON 画成 2D 正交投影 PNG 并做折角分析 |

**jump-apex 采样链（六个脚本，互为上下游）**

| 脚本 | 角色 |
|---|---|
| `apps/debug/scripts/jump-apex-serve.mjs` | 在 OS 临时目录里镜像 `apps/debug/src`、`apps/debug/pkg` 与仓库 `src`，给副本注入只读探针 `globalThis.__jumpProbe` 与按键掩码覆盖槽 `globalThis.__jumpMask`，**不改仓库源文件** |
| `apps/debug/scripts/jump-apex-measure.mjs` | 真实页面实测：驱动 headless Chromium + CDP，注入 BSP、轮询就绪、按帧采样并落 `.tmp/jump-apex/<label>.json` |
| `apps/debug/scripts/jump-apex-auth-diag.mjs` | 对 measure 落盘的样本做权威/渲染线统计 |
| `apps/debug/scripts/jump-apex-report.mjs` | 顶高分布分析：以「发射冲量」为分段锚点算顶高 |
| `apps/debug/scripts/jump-apex-trace.mjs` | 从给定时刻向前回溯定位「超限跳」的起始帧并打印逐帧表 |
| `apps/debug/scripts/jump-apex-window.mjs` | 打印某时刻附近窗口的逐帧采样表 |
| `apps/debug/scripts/jump-apex-smoke.mjs` | 冒烟采样：按住跳键一段时间后打印 3 秒窗口的读数，不落盘、不断言 |
| `apps/debug/scripts/jump-apex-verify.mjs` | 确定性 node 镜像实验：自造时钟与虚拟权威帧队列，跑两组接线 × 多个渲染帧率的对照矩阵 |

**资产**

`apps/debug/scripts/path-baseline.md` 是路径垂距的基线记录（含 CI 夹具语义与历史基线数值），属脚本资产而非文档树。

**三个 `.cmd` 手工入口**（与 npm script 并行，互不转发）

| 文件 | 职责 |
|---|---|
| `apps/debug/start-dev.cmd` | 工具链守卫 → wasm 过期门（`node src/scripts/wasm-stale-check.mjs`，`:28`）→ 必要时重建 wasm 与 TS → 起 dev 服务器（默认端口 8080，`:7`） |
| `apps/debug/play.cmd` | 依赖 → wasm（缺 `pkg/websurf_wasm_bg.wasm` 才建，`:32`）→ TS → `scripts/build-dist.mjs`（`:54`）→ 起服务器（默认端口 8081，`:7`） |
| `apps/debug/build-dist.cmd` | 工具链自检（npm / wasm-pack / node，`:20` 起）→ 依赖 → wasm → `npm run check:api`（`:69`）→ TS → `build-dist.mjs [single\|multi]`（`:89`） |

## 关键流程与不变量

**single 与 multi 的分岔**：`build-dist.mjs` 先删后建目标目录，再按 `multi` 开关选择保留清单（`apps/debug/scripts/build-dist.mjs:220`）。`single 产物` 把 WASM、Worker 源码与默认纹理包全部 base64 内嵌进 `app.js` 前导（`apps/debug/scripts/build-dist.mjs:111`），页面从内嵌全局键建 Blob URL 起 Worker；`multi 产物` 保留外置文件与 module script。

**无头验收的共同前提**：需要真实页面的脚本都依赖 dev 服务器（`jump-apex-serve.mjs` 默认监视 8080）或以 CDP 连已有页面；开关与探针都通过 `globalThis` 注入，不修改仓库源文件。

**门禁脚本的失败语义**：`phys-surf-crouch-smoke.mjs` 任一用例失败即打印 `FAIL` 并以 1 退出、全过则打印计数后正常退出；`build-dist.mjs` 的输入缺失直接抛错；`check-wasm-api.mjs` 的三层任一层失败即非零退出。

**不变量**：

- `build-dist.mjs` 的 `KEEP_*` 清单是「目标目录里允许保留的文件」白名单，未列入的旧文件会被清掉（`apps/debug/scripts/build-dist.mjs:220`）。
- 需要读 wasm 产物的脚本一律取 `apps/debug/pkg`（例：`apps/debug/scripts/glb-mesh-count.mjs`、`apps/debug/scripts/phys-surf-crouch-smoke.mjs`），与 dev 页面实际取用的 `apps/debug/web/websurf_wasm_bg.wasm` 是两个不同路径。
- `jump-apex-verify.mjs` 用脚本自带时钟替换 `performance`，结果与真实墙钟无关（`apps/debug/scripts/jump-apex-verify.mjs:80`）。

## 已知缺口

1. **jump-apex 采样链的就绪判据与读数口径不符**：`apps/debug/scripts/jump-apex-measure.mjs:237` 的就绪判据取 `diag.posY`（`apps/debug/scripts/jump-apex-measure.mjs:228`），而探针 `state()` 的来源是 `RendererMain.getCurrentState`，其返回结构是嵌套的 `pos` / `yaw` / `pitch` / `vel` / `onGround`（`apps/debug/src/renderer/renderer-main.ts:1429`）⇒ 扁平字段恒为 `undefined`，轮询必然走到 `LOAD_TIMEOUT_MS` 上限后 `finish(1)`（`apps/debug/scripts/jump-apex-measure.mjs:251`）。
2. **同一链路的采样表达式读的字段同样不存在**：静置判据读 `s.posY` / `s.velY`（`apps/debug/scripts/jump-apex-measure.mjs:264`），落盘样本读 `s.posX/posY/posZ/velX/velY/velZ` 与 `au.frame.posY/velY/velX/velZ`（`apps/debug/scripts/jump-apex-measure.mjs:297` 起）——两处前缀在嵌套结构下都不存在。
3. **`jump-apex-verify.mjs` 的内嵌复刻依赖已不在源码中的行为**：脚本自带一份「修复前行为」的 land 处理复刻作为对照面（`apps/debug/scripts/jump-apex-verify.mjs:27`）；`jump-apex-serve.mjs` 另用源码文本切片生成回退版，因此两处源码文本形态被脚本依赖。
4. **`frame-bench.mjs` 的缺省地图路径不在工作区**：第 4 个参数缺省时取 `<仓库根>/maps/surf_666.bsp`（`apps/debug/scripts/frame-bench.mjs:37`），而该路径下没有文件，脚本随即打印「地图不存在」并以 2 退出（`apps/debug/scripts/frame-bench.mjs:54`）。地图实际位于 `test/maps/` 下，须显式传第 4 个参数。
5. **`optimize-scene-verify.mjs` 用合成场景、不对当前 GLB 规模**：场景按固定常量合成（`MESH_COUNT` 个 primitive 装进若干容器，坐标由确定性随机数在 `WORLD` 尺度内生成），断言锚定脚本自身的可复现性；要复核当前 `apps/debug/pkg` 产物的真实规模须改用 `apps/debug/scripts/glb-mesh-count.mjs`（`apps/debug/scripts/optimize-scene-verify.mjs:15`、`:19`）。
7. **`input-replay-verify.mjs` 依赖的录制载荷恒为空**：脚本从 `__wsInput.exportJson()` 取录制载荷（`apps/debug/scripts/input-replay-verify.mjs:297`），而该载荷在本页恒为空帧（原因见 `documents/debug/implementation/app.md` 的已知缺口）；脚本还查询页面上不存在的 `#inputRecStatus`（`apps/debug/scripts/input-replay-verify.mjs:461`）。
8. **`start-dev.cmd` 的 wasm 过期门与被服务的 wasm 不是同一路径**：门检查 `apps/debug/pkg/websurf_wasm_bg.wasm`（`apps/debug/start-dev.cmd:28`），而页面实际加载 `apps/debug/web/websurf_wasm_bg.wasm`（`apps/debug/src/main-wasm.ts:23`）⇒ `web/` 缺失或陈旧而 `pkg/` 新鲜时会跳过重建。
9. **`play.cmd` 的 wasm 存在性门只看 `pkg/`**：`apps/debug/play.cmd:32` 判断 `pkg\websurf_wasm_bg.wasm` 存在即跳过 `build:wasm`，而 `build-dist.mjs` 读的正是该路径（`apps/debug/scripts/build-dist.mjs:78`），因此两者一致；但 `web/` 侧的副本仍需 `build:wasm` 才会更新（`apps/debug/package.json:8`），单独跑 `play.cmd` 时 dev 页面用的那份不会刷新。
10. **`start-dev.cmd` 只守 `python`**：只有 python 工具链守卫（`apps/debug/start-dev.cmd:11`），没有 npm / wasm-pack 守卫；后两者缺失要到各自的构建步骤才暴露，而 `build-dist.cmd` 有完整的三项工具链自检（`apps/debug/build-dist.cmd:20`）。
11. **三个 `.cmd` 没有任何 npm script 或相互转发**：`dev` / `build:dist` / `check:api` 是与它们并行的独立入口，因此双击入口与命令行入口的环境准备步骤各写一套。
