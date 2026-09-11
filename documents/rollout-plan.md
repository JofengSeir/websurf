# 批 2/3/4 施工计划（文件级动作表）

> 定位：把三份**已冻结规范**（[framework-audit.md](framework-audit.md)、[framework-launch-structure.md](framework-launch-structure.md)、[framework-decoupling.md](framework-decoupling.md)）翻译成**逐文件的施工清单**，作为批 2/3/4 的唯一施工依据与验收基准。
> 状态：**本文件是计划，不是已执行状态**。§4/§5/§6 的每一条在落库前都必须视为「待执行」；任何执行批次完成后须回来标注提交号。
> 记录时点：HEAD = `4523ef1`（批 1 已落地：`6da49ae` / `fa5552e` / `4523ef1`）。§3 的全部实测输出取自该时点。
> 记号：`B<n>-<m>` = 本文件的动作编号；`D-nn` / `T-nn` / `R-nn` / `I-nn` / `E-nn` 沿用三份规范的定义；`【裁定】` = 本文件对规范或任务卡歧义给出的可执行结论；`【缺口】` = 现有任务卡 inScope 未覆盖、须 captain 处置的项（汇总见 §9.1）。
> 与规范冲突时以规范为准；与代码实测冲突时**以代码为准**（[AGENTS.md](../AGENTS.md) §5.3），并在 §9 登记。

## 1. 计划定位与边界

### 1.1 本文件是什么 / 不是什么

- **是**：批 2/3/4 的逐文件动作表（动作 / 源路径 / 目标路径 / 同步改动 / 验收命令与判据 / 依据条目），以及两条硬约束的实测冻结值、esbuild 注入方案定稿、文件冲突面与串并建议、每批回滚方式、需更正的规范锚点清单。
- **不是**：不是规范（规范以三份 `framework-*.md` 为准）；不是变更记录（见 [CHANGELOG.md](../CHANGELOG.md)）；不是执行结果（本文件落库时仓库代码与批 1 后完全一致）。

### 1.2 施工边界（硬）

- 本文件只新增一个文件；**不执行任何搬迁**，不改代码 / 配置 / CI，不改三份已冻结规范，不改 [AGENTS.md](../AGENTS.md)。
- 后续批次的执行者若发现本文件与实测不符，**以实测为准**并在任务报告中标注「更正」，同时把该条反馈给 captain 登记到 §9。

### 1.3 动作表的可验收性规则

每条动作必须满足：①有唯一的源与目标（或唯一的「改文本」位置，精确到 `文件:行号`）；②有可执行的验收命令与二值判据；③判据不依赖沙箱不可跑的命令（见 §3.1），否则必须给出等价口径。

## 2. 批 1 已完成项与对规范锚点的影响

### 2.1 批 1 三个提交（实测：`git show --stat`）

| 提交 | 改动文件 | 对规范锚点的影响 |
|---|---|---|
| `6da49ae` | `.github/workflows/deploy-pages.yml`（+13 行，插在 game 段之后） | **纯行号顺延**：viewer 段、harness 段及其内部锚点整体后移（§9.2 第 5–7 项） |
| `fa5552e` | `apps/debug/scripts/{install-wasm-bindgen.cmd,jump-apex-verify.mjs,jump-apex-serve.mjs}`、`src/scripts/check-doc-drift.mjs` | **事实失效**：`I-03`/`I-22` 两处「真缺陷」已修复；规范中把 `install-wasm-bindgen.cmd:19` 与 `jump-apex-*.mjs` 列为**当前**缺陷的段落变成历史叙述（§9.2 第 3/4/8/9/14/15/22/23/24 项） |
| `4523ef1` | 三份规范 + `documents/{index.md,architecture.md}` + `CHANGELOG.md` | `architecture.md:22` 的 `src/ts-shared` 计数已更正为「18 源文件五域，共 6664 行」（[framework-decoupling.md](framework-decoupling.md) §9.2 第 5 项的更正**已落地**，勿重复执行） |

### 2.2 批 1 后的实测基线（本计划的比对基准）

| 项 | 实测值 | 命令 |
|---|---|---|
| `.cmd` 文件数 | 12（全部纯 ASCII、CRLF、无 BOM） | `git ls-files '*.cmd'` + 逐文件字节统计 |
| `ensure-node-deps.cmd` 副本 | 2 份，各 1267 B，SHA256 前 16 位同为 `EAB3496C3F1EE6FB`（字节全等） | `node -e` 逐文件哈希 |
| `install-wasm-bindgen.cmd` | 105 行 / 5044 B / 单份（`apps/debug/scripts/`），`:19` 现为三层上溯 `..\..\..\` | 同上 |
| `check-wasm-api.mjs` 副本 | 3 份：debug 127 行 / game 80 行 / harness 56 行（**无 viewer**） | 同上 |
| `pvs-manager.ts` 副本 | 2 份，各 281 行（debug 9098 B / game 9042 B） | 同上 |
| `src/ts-shared` | 18 文件 / 6664 行（`\n` 计数口径） | `wc` 等价：逐文件统计 `0x0A` |
| 许可证源 | `apps/debug/src/physics/{LICENSE,NOTICE}` 存在（11560 / 625 B）；`src/phys/{LICENSE,NOTICE}` **不存在** | `Test-Path` |
| doc-drift 基线 | 49 篇 md ｜ 行数声明 138（漂移 0）｜锚点 1679（越界 0）｜路径失效 1 ｜歧义 389，退出码 0 | §3.5 的等价口径 |

## 3. 硬约束核验（实测）

### 3.1 沙箱能力矩阵（决定全部验收口径）

`node` 无法 spawn 外部进程（`EPERM`，errno `-4048`）。实测结论：

| 命令 | 可跑 | 实测输出 / 证据 | 影响 |
|---|---|---|---|
| `npm run typecheck`（三工程） | ✅ | `tsc --noEmit`，退出码 0 | 可用作验收 |
| `npm run build:ts`（三工程） | ✅ | esbuild **CLI** 以 `stdio: inherit` 起子进程，`web\app.js 1.3mb`，退出码 0 | 可用作验收；也证明三工程 esbuild 二进制完好 |
| `npm run check:api`（debug/game） | ✅ | `WASM 导出符号 (12) … TS 导入符号 (6) … ✅ F4 通过`，退出码 0 | 可用作验收 |
| `npm run test:jump-apex`（debug） | ✅ | 25 块分析输出，退出码 0（批 1 修复生效） | 可用作回归 |
| `npm run build:dist` / `node scripts/build-dist.mjs` | ❌ | `构建失败: Error: spawn EPERM`（esbuild JS API 的 `ensureServiceIsRunning` 处 `spawn`，调用栈 `build-dist.mjs:85`），退出码 1 | **三份 `build-dist.mjs` 走 esbuild JS API**，服务进程起不来；凡以「build:dist 退出码 0」为判据的验收项（t2/t4/t6 卡片中均有）**在本沙箱不可达**，必须改用 §3.5 的等价口径 |
| `node src/scripts/check-doc-drift.mjs` | ❌ | `spawnSync git EPERM`（环境限制，非缺陷） | 用 §3.5 的等价口径 |
| `.cmd` 端到端（`play.cmd` / `build-dist.cmd`） | ❌ | 内部依赖 `build:dist`，同上 | 用「`cmd /c` 块探针 + 静态逐行比对」替代 |

> **【更正】** 任务卡中的「`build:dist` 通常可用」不成立（反证见上表第 5 行）。t2 验收第 7 条、t4 `verify` 的三条 `npm run build:dist`、t6 `verify` 的三条 `npm run build:dist` 都必须按 §3.5 改写为等价证据，否则会给出假失败。

### 3.2 硬约束①：共享构建内核不得 `import esbuild`

```text
$ node -e "for(const p of ['src/scripts/lib','src/scripts','.']){try{console.log(p,'-> OK',require.resolve('esbuild',{paths:[p]}))}catch(e){console.log(p,'-> FAIL',e.code)}}"
src/scripts/lib -> FAIL MODULE_NOT_FOUND
src/scripts -> FAIL MODULE_NOT_FOUND
. -> FAIL MODULE_NOT_FOUND

$ Test-Path package.json / node_modules   → False / False
$ node -e "require.resolve('esbuild',{paths:['apps/debug']})"  → apps/debug/node_modules/esbuild/lib/main.js
$ node -e "require.resolve('esbuild',{paths:['apps/game']})"   → apps/game/node_modules/esbuild/lib/main.js
$ node -e "require.resolve('esbuild',{paths:['apps/viewer']})" → apps/viewer/node_modules/esbuild/lib/main.js
```

- **结论**：仓库根与 `src/scripts/**` 均无法解析 `esbuild`；三工程各自可解析（`devDependencies.esbuild = "^0.23.0"`）。硬约束①**成立**，且与 [framework-decoupling.md](framework-decoupling.md) D-04 的实测一致。
- **判据（批 2/3 落地后回跑）**：`git grep -n "from 'esbuild'" -- src/scripts` 空输出（规范 §10.2 第 4 条）。

### 3.3 硬约束②：共享层不得 `import` 各工程 `pkg/*`

```text
apps/debug/pkg   → websurf_wasm.js / websurf_wasm.d.ts / websurf_wasm_bg.wasm / websurf_wasm_bg.wasm.d.ts
apps/game/pkg    → websurf_wasm.js / websurf_wasm.d.ts / websurf_wasm_bg.wasm / websurf_wasm_bg.wasm.d.ts
apps/viewer/pkg  → websurf_viewer_wasm.js / …_bg.wasm / …
harness/pkg      → websurf_test_wasm.js / …_bg.wasm / …

wasm.d.ts 模块名：apps/debug/src/wasm.d.ts:6 → '*/pkg/websurf_wasm.js'
                  apps/game/src/wasm.d.ts:6 → export * from '../pkg/websurf_wasm.js'
                  apps/viewer/src/wasm.d.ts:6 → export * from '../pkg/websurf_viewer_wasm.js'
                  test/dual-mode-harness/src/wasm.d.ts:6 → export * from '../pkg/websurf_test_wasm.js'
```

- **【更正】** 任务卡 t1 验收第 3 条写的「三工程 pkg 名互异」**不成立**：`apps/debug` 与 `apps/game` 的 pkg 入口文件名**完全相同**（`websurf_wasm.js` / `websurf_wasm_bg.wasm`），互异只发生在「应用工程 vs viewer vs harness」之间（`websurf_wasm` / `websurf_viewer_wasm` / `websurf_test_wasm`）。
- 这不削弱硬约束②，反而**加强**它：若共享层直接 `import` pkg 路径，debug 与 game 的模块名相同却分属两个目录，静态导入无法在共享层消歧，只能由工程侧注入（与 D-09 的「只共享取字节、`initSync` 留工程内」完全一致）。
- **判据**：`git grep -nE "apps/|\.\./\.\./\.\." -- src` 只允许出现在注释（规范 §10.2 第 3 条）。

### 3.4 批 3 的 esbuild 注入方案（T-04 内核抽取与产物改造同批，定稿形态）

**形态**：共享内核为 **ESM（`.mjs`）**，由工程侧把 esbuild 的 `build` 函数**作为参数**传入；内核自身只 import `node:` 内建，**零裸模块说明符**。

```js
// src/scripts/lib/dist-pack.mjs —— 内核（import 图内无任何裸说明符）
export function commonEsbuildOptions({ logLevel = 'warning' } = {}) {
  return { bundle: true, target: 'es2022', minify: true, sourcemap: false, write: false, legalComments: 'eof', define: { 'import.meta.url': '"about:blank"' }, logLevel };
}
export async function bundleIife({ build, entry, options }) { /* 调 build(...)，返回 outputFiles[0].text */ }
export async function bundleEsm({ build, entry, outfile, options }) { /* 写盘 */ }
export function writeEmbeddedPreamble({ distDir, appFile, wasmB64, workerJs, mtzB64 }) { /* 唯一拼装 __VBSP_* 处 */ }
export function rewriteIndexToClassicScript({ webIndex, distIndex }) { /* … */ }
export function cleanDist(distDir) { /* rm -rf dist */ }
export function cleanStale(distDir, keep) { /* 删未列名文件 */ }
export function copyLicensePair({ repoRoot, distDir, names = ['LICENSE', 'NOTICE'] }) { /* 从 src/phys 拷产物级副本 */ }
export function printTree(dir) { /* … */ }
```

```js
// apps/<app>/scripts/build-dist.mjs —— 薄入口（D=3，与 §6.3 层数表一致）
import { build } from 'esbuild';                                   // 工程侧解析，不在共享层
import { bundleIife, writeEmbeddedPreamble, cleanDist, copyLicensePair } from '../../../src/scripts/lib/dist-pack.mjs';
import { fileURLToPath } from 'node:url';
const REPO = new URL('../../..', import.meta.url);                  // apps/<app>/scripts → 仓库根
await cleanDist(distDir);
const workerJs = await bundleIife({ build, entry: join(HERE, '../src/worker/main.ts') });
```

**为何该形态在三工程各自的 esbuild 版本下都工作（三条，含实测）**：

1. **模块形态**：三工程 `package.json` 均为 `"type": "module"`，`build-dist.mjs` 现用 `import { build } from 'esbuild'`（debug `:20`、game `:22`、viewer `:23`）。内核用 `.mjs` + 具名导出，与调用方一致，无需 CJS 桥。
2. **解析方向**：`import ... from '../../../src/scripts/lib/dist-pack.mjs'` 是**相对文件说明符**，Node 按「导入方所在目录」解析为绝对路径，**不查 `node_modules`**；内核文件自身的 import 图只有 `node:fs` / `node:path`，因此 `src/scripts/lib/` 处「无法解析 esbuild」这一事实**不再进入执行路径**。这正是 D-04「必须由调用方注入」的落地方式。
3. **版本无关**：传入的是**函数对象**而非版本号或模块名。三工程各自从自己的 `node_modules` 解析（实测三处均可解析，版本 `^0.23.0`），即使未来版本分叉也无需共享层改动。

**注入方案实测（探针，落库前已跑并清理）**：在 `.tmp/probe/` 内按上表结构建 `src/scripts/lib/dist-pack.mjs` + `apps/debug/scripts/entry.mjs`（相对说明符三步上溯），实跑输出：

```text
[内核落点] resolve('esbuild') -> FAIL MODULE_NOT_FOUND
[注入 stub] bundleIife -> /*STUB-BUNDLE*/
[负对照：未注入] -> dist-pack: build 未注入
[preamble] -> …\app.preamble.js
EXIT=0
```

- **正对照**：内核落点解析 esbuild 失败（MODULE_NOT_FOUND）→ 证明「不注入就跑不动」，注入后正常工作。
- **负对照**：不传 `build` 时内核**显式报错**（`dist-pack: build 未注入`），不会静默产出空产物。
- 探针跑完即删（`Remove-Item .tmp/probe -Recurse -Force`），`.tmp/` 已被 `.gitignore:20` 覆盖，`git status` 无残留。

### 3.5 沙箱内等价验收口径（三条，批 2/3/4 通用）

| 原判据 | 等价口径 | 判据 |
|---|---|---|
| `npm run build:dist` 退出码 0 / `node scripts/build-dist.mjs` | ①`npm run build:ts` 退出码 0（证明 esbuild 二进制与 TS 链完好）②内核以注入 stub `build` 直调（§3.4 探针），断言 `__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` / `__VBSP_TEXTURES_MTZ_B64__` 三行的**值域与前缀**与 `git show <批 2 提交前>:apps/<app>/scripts/build-dist.mjs` 的对应拼接逐字一致 ③`node --check apps/<app>/scripts/build-dist.mjs` 通过 | 三者全绿 |
| `node src/scripts/check-doc-drift.mjs` | `pwsh` 预生成 **LF** 清单（`git ls-files --cached --others --exclude-standard`，用 node 归一为 LF），把 `src/scripts/check-doc-drift.mjs:31` 那一行临时替换为 `fs.readFileSync(path.join(ROOT,'.tmp-gitfiles.txt'),'utf8')`（**其余逐字不改**，`:32` 的 `.toString('utf8')` 对字符串是恒等变换故整行只剩一处改动），跑完**必须还原**并 `git diff --exit-code -- src/scripts/check-doc-drift.mjs` = 0，再删清单文件 | A/B 两类非空即失败；跑完 `git status --short` 无该文件 |
| `.cmd` 端到端（双击入口） | ①字节口径：12 个 `.cmd` 全部 `>127 计数 = 0`、`LF == CRLF`、无 BOM ②块探针：对每个 `if ... (` 块内的 `echo` 行做 `cmd /c` 最小探针，断言输出非空且退出码符合预期（批 1 的静默 no-op 只在此口径下暴露） | 两条全绿 |

## 4. 批 2 动作表（构建链收敛，t2 / buildchain-owner）

| # | ①动作 | ②源路径 → ③目标路径 | ④同步改动 | ⑤验收命令与判据 | ⑥依据 |
|---|---|---|---|---|---|
| B2-1 | 上提 + 改写首段（去 `cd /d "%~dp0.."`，加「调用方必须先 `cd` 到工程根」契约与 `package.json` 守卫） | `apps/debug/scripts/ensure-node-deps.cmd` → `src/scripts/ensure-node-deps.cmd`；删 `apps/game/scripts/ensure-node-deps.cmd`（与 debug 版字节全等，任选其一为源） | 5 处调用点改 `call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause`：`apps/debug/build-dist.cmd:54`、`apps/debug/play.cmd:26`、`apps/debug/start-dev.cmd:41`、`apps/game/build-dist.cmd:48`、`apps/game/play.cmd:24`；**viewer 2 处内联**（`apps/viewer/build-dist.cmd:60`、`apps/viewer/play.cmd:35` 的 `if exist "node_modules\esbuild"`）改为同一调用 | `git ls-files -- 'apps/*/scripts/ensure-node-deps.cmd'` → 空；`Test-Path src/scripts/ensure-node-deps.cmd` → True；逐条 `Test-Path` 解析 6 个调用点 → 全 True | D-01、T-01、R-19、I-12、I-15、[framework-launch-structure.md](framework-launch-structure.md) §3.1 |
| B2-2 | 上提 + 同目录化（`call "%~dp0..\..\..\src\scripts\cargo-env.cmd"` → `call "%~dp0cargo-env.cmd"`） | `apps/debug/scripts/install-wasm-bindgen.cmd` → `src/scripts/install-wasm-bindgen.cmd`；删原文件 | `apps/debug/build-dist.cmd:27` 与 `apps/debug/start-dev.cmd:26` 改 `call "%~dp0..\..\src\scripts\install-wasm-bindgen.cmd" nopause`；`:85`、`:79` 两处提示文案同步；`src/scripts/cargo-env.cmd:24` 注释改指同目录 | `Test-Path src/scripts/install-wasm-bindgen.cmd` → True；`Test-Path apps/debug/scripts/install-wasm-bindgen.cmd` → False；`git grep -n "install-wasm-bindgen" -- 'apps/**'` 无工程内路径；哈希仅一处 | D-02、T-02、R-19、I-22、§1.3 C-1、§3.3 |
| B2-3 | 新建引擎（纯函数 + 参数、零工程依赖、零 esbuild） | 新建 `src/scripts/lib/wasm-api-contract.mjs`（导出 `extractExportsFromPkgJs` / `assertDtsExports` / `assertTsImportsCoveredByExports`） | 三份 `check-wasm-api.mjs` 改薄配置：`apps/debug/scripts/check-wasm-api.mjs`（批 1 基线 127 行）、`apps/game/scripts/check-wasm-api.mjs`（批 1 基线 80 行）改写；**新建** `apps/viewer/scripts/check-wasm-api.mjs`（薄配置，批 1 基线约 20 行）；`package.json` 的 `check:api` 路径不变，viewer 新增 `check:api` 键 | `cd apps/<app> && npm run check:api` 三工程均退出码 0；`git ls-files '*check-wasm-api.mjs'` 恰 4 份（1 引擎调用方 ×3 + harness 1，harness 不动）；三份薄配置均含 `../../../src/scripts/lib/wasm-api-contract.mjs` | D-03、T-03、R-12、R-13、I-10、§7.5 第 3 条 |
| B2-4 | **不做内核抽取**（captain 2026-09-12 裁定：以规范 §7.5 / §7.1 批 3 行 / §1.3 C-3 为准，`T-04` 归批 3、由 t4 承接；批 2 范围**不含** `src/scripts/lib/dist-pack.mjs`） | —（三份 `build-dist.mjs` 与 `src/scripts/lib/` 在批 2 **零改动**） | 若 t2 报告把内核抽取算作已完成项 → **越界**，判 needs_revision（§9.1-G-1） | 本批提交内 `git diff --stat -- 'apps/*/scripts/build-dist.mjs' src/scripts/lib` **空输出**；`Test-Path src/scripts/lib` → False | §7.5、§1.3 C-3、§7.1 批 3 行、§9.1-G-1 |
| B2-5 | `.cmd` 括号块与编码全文扫描（本批触及的全部 `.cmd`） | — | 12 份 `.cmd` 逐份扫描；块内 `echo` 的半角括号未转义即改 `^(` / `^)` | `>127 计数 = 0`、`LF == CRLF`、无 BOM；块探针输出非空；无新增词表外标记 | 批 1 教训（`install-wasm-bindgen.cmd` 4 处）、§2.4.1、§2.5.1 |
| B2-6 | 沙箱不可跑项的等价证据（§3.5） | — | 在报告中给出 `npm run build:ts` ×3、`npm run check:api` ×3、`test:jump-apex` 的真实退出码 | 退出码全 0；`git status --short` 只含本批预期文件 | t2 验收第 7/10 条 |
| B2-7 | **文档自洽修复：修平本批自己造成的锚点越界**（G-9 裁定）。`documents/framework-audit.md:432`（I-10）按 **T-03 之后的实际形态**改写：debug 已从「127 行动态比对实现」实收缩为「**薄配置 + 共享引擎 `src/scripts/lib/wasm-api-contract.mjs`**」，并**如实反映 I-10 的问题陈述已改变**（不再是「谁提供契约检查有三样」，而是「同一引擎 + 三份工程契约薄配置」）——**不是只把行号改小**。**I-10 涉及的全部锚点须一次核完**：除 debug 那处（已越界）外，还有 game 那份（`apps/game/scripts/check-wasm-api.mjs`）的 `:25-64`，该引用**当前未越界但内容已失真**（`check-doc-drift.mjs` 只查越界不查错位，`:18-20` 自述），D-03 后该文件同样变薄、`:25-64` 会一起失效；两处同批改完。**批 2 中间态实测**（落地时须重新实测，勿照抄）：game 那份的 `EXPORT_API` 数组已后移到第 30 行一带、`PHYS_API` 在第 51 行一带、合并与输出在第 77/86 行一带（原 `:25-64` 区间「在范围内但错位」）；debug 那份的 `WASM 导出符号 (N)` 输出行已从 `:109-126` 一带移到第 41 行一带 | 改文本：`documents/framework-audit.md`（**只此一篇**；t2 `inScope` 新增该路径，**不要放开整个 `documents/`**） | 与 B2-3 **同一次提交**（同批自洽，不留红门禁给下一批）；C 类路径失效 8 处**本批不修**（§9.2 C 表已列清单），但须在 t2 报告中列出「旧路径引用待回改」清单 | **【硬判据（captain，2026-09-12）】** ① 全仓 doc-drift 等价口径（§3.5）→ **exit 0、零漂移零越界**；② `documents/framework-audit.md` 中**全部** `check-wasm-api.mjs:<行号>` 形式的锚点，其行号必须落在被引文件**当前**行数之内，并**列出该条目下的全部锚点供人工确认内容不失真**；③ I-10 的文字描述与新形态一致（**不再称「三样实现」**）。判据命令：`git grep -n "check-wasm-api.mjs:" -- documents/framework-audit.md` 列出该条目下的全部锚点，逐个人工确认内容不失真（把输出贴进报告）。**「不越界」是必要不充分条件**：脚本只查越界不查错位——若 game 那份收敛到 30 行而锚点写成不越界却指向错误内容的区间，`check-doc-drift.mjs` 会**静默放行**，故 ② 的人工确认不可省 | G-9 裁定、§9.1-G-9、§9.2 C 表、[AGENTS.md](../AGENTS.md) §5.3 |

**批 2 的行为差异点（须在报告中显式记录，不得静默）**：

1. 依赖自举**探针语义统一**为 `node_modules\.bin\tsc`（现 `ensure-node-deps.cmd:13`）；viewer 原内联探针是 `node_modules\esbuild`。二者在「node_modules 存在但缺 tsc」时新探针更安全（会触发 `npm install`），反向情形（有 tsc 无 esbuild）两版都漏 —— 属可接受的语义归一，须写入 CHANGELOG。
2. `ensure-node-deps.cmd` 上提后**不再自己推导工程根**，改由调用方契约提供（`set "APP_ROOT=%CD%"` + `package.json` 守卫）；守卫失败必须 `[ERROR]` + `exit /b 1`（可诊断），不得静默 `npm install` 到错误目录。

## 5. 批 3 动作表（启动与产物收敛，t4 / launch-artifact-owner）

> 范围裁定（captain，2026-09-12）：端口/输出的**判据范围 = `apps/`**；`test/dual-mode-harness/` 本轮显式排除（D-22、§9.1-G-3），其 8080 → 8110 的端口差异登记为遗留项（§10 第 3 条）。**`T-04` 内核抽取在本批内新建并当批消费**（§9.1-G-1/G-2）。

| # | ①动作 | ②源路径 → ③目标路径 | ④同步改动 | ⑤验收命令与判据 | ⑥依据 |
|---|---|---|---|---|---|
| B3-0 | **`T-04` 内核抽取（纯重构）**：新建 `src/scripts/lib/dist-pack.mjs`（形态见 §3.4），三份 `build-dist.mjs` 收敛为薄入口，esbuild 由工程侧注入 | 新建 `src/scripts/lib/dist-pack.mjs`；`apps/{debug,game,viewer}/scripts/build-dist.mjs`（`wc` 口径 205 / 179 / 256 行）→ 三份薄入口 | 与 B3-5/B3-6 **同批同一次动作**（产物行为改造直接写进内核，禁止先抽骨架再改一轮）；`src/scripts/lib/dist-pack.mjs` 须 captain 先加入 t4 `inScope`（§9.1-G-2）；批 3 与批 4 并行时不得同时构建同一工程（§7.3） | 内核：`git grep -n "from 'esbuild'" -- src/scripts` 空；入口：`git grep -n "from 'esbuild'" -- 'apps/*/scripts/build-dist.mjs'` 恰 3 命中（注入点在工程侧）；`git grep -nE "apps/\|\.\./\.\./\.\." -- src/scripts/lib` 只允许出现在注释；§3.5 等价口径全绿；三份 `build-dist.mjs` 在本批**只被改一轮**（`git diff --numstat` 一次成型） | D-04、T-04、R-18、§7.5、§1.3 C-3 |
| B3-1 | 端口重编号为 10 段固定槽位（debug 8080/8081 不变；**判据 = `apps/` 下的「可执行端口面」**） | 改文本：`apps/game/package.json:15`（`dev` 8080→8090）、`apps/viewer/package.json:17`（→8100）、`apps/game/play.cmd:6`（8137→8091）、`apps/game/build-dist.cmd` 原 `:97-98`（文案 8137→8091；**批 3 模板重写后该文案已整段移除**——现文件仅 93 行且不再打印端口，故此锚点为**历史**，端口文案只余 `play.cmd`）、`apps/viewer/play.cmd:12,15`（8090→8101）、`apps/viewer/scripts/build-dist.mjs:104,108`（内嵌 `dist/play.cmd` 模板 8090→8101） | 可执行面之外**无同步项**：README 与 `documents/` 的文字同步**显式排除本批**，统一移入收口项 §7.4 S-1（G-6 裁定） | **【裁定（captain，2026-09-12）：可执行面 = `.cmd` / `package.json` / CI】** ① `git grep -nE "set PORT=[0-9]+" -- apps` 取值集合 = {8080, 8081, 8091} ∪ {8101}（8101 来自 `apps/viewer/scripts/build-dist.mjs:108` 的内嵌模板，必须一并收敛否则判据①永假）；② `git grep -nE "serve\.py [0-9]+" -- apps` ∈ 表；③ `localhost:<表内端口>` 无表外；④ `git grep -n "8137" -- apps .github` **空**；⑤ **显式排除**：`test/dual-mode-harness/`（G-3 裁定）与全部 `README`/`documents/` 文字（G-6 裁定 → §7.4 S-1）——本判据**不代表**「全仓一切一致」 | R-02、R-03、R-05、§2.3、§10.1 第 3/4/5 条；§9.1-G-3 / G-6 裁定 |
| B3-2 | `.cmd` 输出模板收敛（`play` N=4、`start-dev` N=3、`build-dist` N=5）+ 词表统一 | 改文本：`apps/debug/play.cmd`（批 1 基线 71 行）、`apps/game/play.cmd`（批 1 基线 69 行）、`apps/viewer/play.cmd`（批 1 基线 89 行）、`apps/debug/start-dev.cmd`（批 1 基线 88 行）、`apps/debug/build-dist.cmd`（批 1 基线 108 行）、`apps/game/build-dist.cmd`（批 1 基线 155 行）、`apps/viewer/build-dist.cmd`（批 1 基线 158 行，补 `[3/5]` 契约检查）、`apps/viewer/scripts/build-dist.mjs`（词表 7 处 + `:242` 的 `[warn]`）、`src/serve.py:52-53` | `apps/*/package.json` 的 `pause` 禁令、`nopause` 子脚本接口、`cmd /k` 清零；**【人工回看提醒（captain 2026-09-12，本项不得在后续修订中删除）】**`documents/framework-audit.md:110`/`:111`（§2.4 表）含 `（`:47`）`/`（`:75`）` 形态的**裸行号**，指向 `build-dist.cmd` 的调用行——它们不参与 doc-drift 的 A/B 判定，但本批重写 `.cmd` 后会「在范围内但错位」，须在收口时人工回看（§7.4） | 词表：`git grep -nE "\*\*\* ERROR\|\[错误\]\|\[提示\]\|\[warn\]" -- apps src` **空**（当前 21 处：game/build-dist.cmd 6 + viewer/build-dist.cmd 5 + viewer/scripts/build-dist.mjs 8 + src/serve.py 2）；`git grep -n "cmd /k" -- apps` **空**（当前 `apps/debug/start-dev.cmd:73`）；逐行 diff §2.5.6 全文；`[ERROR]` 后恰好一条 `[HINT]` | R-16、§2.5、§2.6、§2.7、I-08、I-09、I-11 |
| B3-3 | 新建 `start-dev.cmd`（三条件判据成立） | 新建：`apps/game/start-dev.cmd`（端口 8090）、`apps/viewer/start-dev.cmd`（端口 8100） | 按 §2.5.3 模板 + §2.4.1 头部 + §2.4.2 共享调用 | `Test-Path` 两者 True；含 `[3/3]`、`[SKIP]` 复用块、`if not "%~1"=="" set PORT=%~1`；纯 ASCII/CRLF/无 BOM；`git ls-files 'apps/*/*.cmd'` 每工程恰 3 个 | R-01、§2.2、§2.7 |
| B3-4 | `web/` 三产物与 dev wasm 路径统一 | `apps/debug/package.json:8` 的 `build:wasm` 补 `copyFileSync('../../pkg/websurf_wasm_bg.wasm','../../web/websurf_wasm_bg.wasm')` | `apps/debug/src/main-wasm.ts:19` 的 `'../pkg/websurf_wasm_bg.wasm'` → `'./websurf_wasm_bg.wasm'`（**归属见 §9.1-G-5**） | `Test-Path apps/debug/web/websurf_wasm_bg.wasm` → True；`git grep -nE "websurf_wasm_bg\.wasm" -- 'apps/*/src'` 只含 `./` 与 `new URL('./…', import.meta.url)` 形态；`git grep -n "websurf_wasm_bg" -- 'apps/debug/*.cmd'` 无 `pkg/` 前缀 | R-14、§5.4、§5.5 |
| B3-5 | `dist` 全量重建 + viewer `--multi` 显式报错 | 三份 `build-dist.mjs`（含内核 `cleanDist`）先删后建；viewer 入口对 `--multi` 打印 `[ERROR]` + `process.exit(1)` | `package.json` 的 `build:dist` 值保持 `node scripts/build-dist.mjs`（§2.4.2） | 静态：`git grep -n "rm(dist" -- 'apps/*/scripts/build-dist.mjs' src/scripts/lib` 三处命中；行为不可跑则用 §3.5 等价口径；viewer `--multi` 分支字面量断言 | R-15、§2.2、§5.2 |
| B3-6 | 许可证唯一源 `src/phys/{LICENSE,NOTICE}` + 产物级拷贝 | `apps/debug/src/physics/{LICENSE,NOTICE}` → `src/phys/{LICENSE,NOTICE}`（删原文件） | `git mv` 语义；`apps/debug/scripts/build-dist.mjs:136-137`、`:191-192`（由本批 B3-0 创建的内核 `copyLicensePair` 承接）源改 `src/phys/`；`apps/game/scripts/build-dist.mjs` 补同款（single + multi）；`apps/debug/src/physics/math/vec3.ts:7` 与 `apps/debug/src/physics/physics/Collision/Collision.types.ts:7` 的 `src/physics/NOTICE` 指针改 `src/phys/NOTICE`；`NOTICE` 第 16-20 行「Files added by WebSurf」清单核正（含 2 个不存在文件与旧前缀）；viewer **不加** | `git ls-files src/phys` 含 `LICENSE`、`NOTICE`；`Test-Path apps/debug/src/physics/LICENSE` → False；`git grep -n "LICENSE.cs-movement" -- 'apps/*/scripts/build-dist.mjs' src/scripts/lib` 源路径全部指向 `src/phys/`；`Get-FileHash` 唯一源与 dist 副本前 16 位相等 | D-23、E-08、R-17、§5.3、I-21、§9.2 第 9 项 |
**批 3 必须保留的豁免（禁止抹平，逐条实测）**：viewer single-only（`--multi` 报错，不产 multi）、viewer `dist/` 资产（`play.cmd`/`play.sh`/`serve.py`/`README.md`/`.nojekyll`/`assets/`）、viewer 不依赖 `websurf-phys`、viewer 无 `web/textures.mtz`、debug 无 `web/styles.css`（内联样式）、harness 无 `web/` 与 `start-dev.cmd`/`build-dist.cmd`、harness 的 `dev` 与 `play` 共用 8110、`dist` 内 `LICENSE.cs-movement` 属产物级副本（**不是**第二份源副本）。判据：`git grep -n "SharedArrayBuffer" -- apps/viewer` 空；`Test-Path apps/viewer/web/textures.mtz` → False；`Test-Path apps/debug/web/styles.css` → False。

## 6. 批 4 动作表（共享层上提，t5 / shared-layer-owner）

| # | ①动作 | ②源路径 → ③目标路径 | ④同步改动 | ⑤验收命令与判据 | ⑥依据 |
|---|---|---|---|---|---|
| B4-1 | 上提 `bspYawToCsYaw`（级别 A′，语义取 viewer 版：`wrapDeg` **带 `\|\| 0`**） | 新建 `src/ts-shared/phys/angles.ts`；删 `apps/debug/src/world/spawn-loader.ts:65`、`apps/debug/src/world/teleport-manager.ts:42` 两处私有副本 | `src/ts-shared/phys/world-builder.ts:99` 改 import；`apps/viewer/src/core/pose.ts:23` 改 re-export（保留 `apps/viewer/src/core/spawn.ts:22` 等 20 余处内部 import 不动） | `git grep -n "function bspYawToCsYaw" -- apps src` 恰 1 命中（= angles.ts）；三工程 `typecheck` 退出码 0；`git grep -ln "bspYawToCsYaw" -- apps/*/src` 只剩 import/re-export 行。**【口径】**判据按 `apps` + `src`；`test/dual-mode-harness/src/main.ts:244` 是**第 5 份**副本（D-22 保留，**只要求登记为后续项、不要求消除**），若把 `test/` 计入则判据永假（§9.2 第 18 项） | D-08、§2.3 边界 4、§4.3、R-18、R-20 |
| B4-2 | 上提 base64 解码（级别 A，8 处 → 1 处） | 新建 `src/ts-shared/wasm/loader.ts`（导出 `base64ToBytes` / `readEmbeddedWasmB64` / `wasmBytesFrom`） | 8 处改 import：`apps/viewer/src/core/bsp.ts:46`、`apps/game/src/renderer/renderer-main.ts:518`、`apps/game/src/world/pvs-manager.ts:274`、`apps/debug/src/main-wasm.ts:30`、`apps/debug/src/default-pack.ts:26`、`apps/debug/src/world/pvs-manager.ts:274`、`src/ts-shared/auth/worker-dispatch.ts:164`、`src/ts-shared/phys/world-builder.ts:196`；**硬约束**：loader 不得 import 任何 `pkg/*`，`initSync`/`init` 留工程内且按 pkg 名分支 | `git grep -n "atob(" -- apps src` **恰 1 命中**（= loader.ts 自身）。**【口径】**必须写 `-- apps src`；`test/dual-mode-harness/scripts/phys-smoke.mjs:582` 是第 9 处（outOfScope，**只要求登记、不要求消除**；captain 2026-09-12 已确认该口径），用「全仓」口径则永假（§9.2 第 19 项） | D-09、§3.3、§7.7 批 1 验证、R-18（**批 4 已执行**：`apps/{debug,game}/src/world/pvs-manager.ts` 已删、解码改调共享 loader，故上列两处 pvs-manager 路径现已不存在） |
| B4-3 | 上提标定常量 `EYE_STAND = 64.09` | 新建 `src/ts-shared/phys/constants.ts` | TS 侧 7 处改 import：`apps/viewer/src/core/constants.ts:7`、`apps/game/src/renderer/renderer-main.ts:647`、`src/ts-shared/decoupled/decoupled-loop.ts:164`、`src/ts-shared/tick/tick-consumer.ts:182`、`src/ts-shared/auth/shared-state.protocol.test.ts:100`、`:139`（**精确断言**）、`apps/game/scripts/phys-smoke.mjs:118,122,123`（**±0.5 容差断言**）；Rust `src/phys/player.rs:34` **不动** | `git grep -n "64\.09" -- '*.ts' '*.mjs' '*.rs' :!apps/debug/fixtures` 在 `apps` + `src` 内只剩 constants.ts 1 处定义 + 断言引用；`cd apps/game && npm run test:phys` 与 debug `typecheck` 退出码 0；**禁止**把 Rust 常量改成 TS 可注入参数。**【口径】**与 D-09 同：判据按 `apps` + `src`；`test/dual-mode-harness/src/worker-b.ts:124`（`const EYE_STAND = 64.09`）是第 9 处，同文件 `:33`/`:272`/`:813` 与 `test/dual-mode-harness/src/renderer/tick-consumer.test.ts` 另有符号级引用，均属 **outOfScope（D-22 保留）**，只要求**已登记为后续项**，不要求消除 | D-16、E-06、§2.3 边界 3、R-18 |
| B4-4 | 上提 PVS 管理器（级别 A，`numstat 2 2`） | 新建 `src/ts-shared/world/{types.ts,pvs-manager.ts}`；删 `apps/debug/src/world/pvs-manager.ts`、`apps/game/src/world/pvs-manager.ts` | `apps/debug/src/world/types.ts:141` 与 `apps/game/src/world/types.ts:5` 的 PVS 三类改 `export type { … } from` re-export；pvs-manager 的解码改调 B4-2 的 loader（D-09 是 D-10 的前置） | `git ls-files -- 'apps/*/src/world/pvs-manager.ts'` 空；`git ls-files src/ts-shared/world` 恰 2；两工程 `typecheck` 退出码 0；D-07 的 `Vec3` **不上提**（保留各工程） | D-10、D-07、D-17、§2.4 反例库、R-18（**批 4 已执行**：两份工程内 `pvs-manager.ts` 已删并上提 `src/ts-shared/world/{pvs-manager,types}.ts`；实测 `git ls-files -- 'apps/*/src/world/pvs-manager.ts'` 空） |
| B4-5 | `tsconfig.json` 的 include 规则与失效项 | 改文本：`apps/viewer/tsconfig.json:15` 加 `../../src/ts-shared/**/*.ts`（**因为 B4-1/B4-2/B4-3 使 viewer 出现真实 import**）；`apps/debug/tsconfig.json:26` 删 `web/vendor` | debug/game 已 include 共享层，保持不变；`Test-Path apps/debug/web/vendor` → False | `git grep -lE "from .*ts-shared" -- 'apps/*/src'` 的文件数与各 `tsconfig.json` 是否 include 双侧一致（当且仅当）；三工程 `typecheck` 退出码 0 | §3.4（t2）、R-08、R-09、§4.4 |
| B4-6 | 文档锚点与共享层计数回看（**人工**，脚本只查越界） | 改文本：`documents/ts-shared.md` §1.1 文件清单与行数（18 → 22 文件）；[documents/architecture.md](architecture.md):22 计数、`:34`/`:63` 消费矩阵（viewer 由「零 import」变为 3 处 import）；`documents/{debug,game,viewer}/**` 中因搬迁而错位的 `文件:行号`。**本批不改** `architecture.md` 的 `check-wasm-api` 三处断言与 `documents/index.md` 篇数（G-7/G-8 裁定留 t8 收口） | `src/scripts/check-doc-drift.mjs` **只查越界不查错位**（`:18-20` 自述），必须人工逐条回看；被搬迁文件相关锚点：`world-builder.ts`（`:93`/`:99`/`:238`/`:245`）、`spawn-loader.ts`、`teleport-manager.ts`、`pose.ts`、`renderer-main.ts`、`pvs-manager.ts`、`constants.ts` | doc-drift 等价口径 A/B 均为 0；人工抽查 ≥5 处锚点内容与描述相符（给出文件:行号与行内容） | §7.6、[AGENTS.md](../AGENTS.md) §5.3、§9.2 第 5 项 |
| B4-7 | 新建门禁 `src/scripts/check-shared-sync.mjs`（纯 `fs`，四项子检查 `mtz`/`vmdl-patch`/`eye-stand`/`license-src`）并接入 CI | 新建：`src/scripts/check-shared-sync.mjs` | **【裁定（captain，2026-09-12）：`T-05` 并入批 4（t5）】** 其 `eye-stand` 子检查要求与 `src/ts-shared/phys/constants.ts` 逐位相等，而该文件由 B4-3 创建（原属批次依赖倒置），故必须在 B4-3/B4-4 落地后接入；须先加入 t5 `inScope`（§9.1-G-4） | `node src/scripts/check-shared-sync.mjs` 退出码 0（纯 `fs` + `node:crypto`，零 `child_process`，本沙箱可跑）；`git grep -n "child_process" -- src/scripts/check-shared-sync.mjs` 空；`eye-stand` 子检查对 `src/ts-shared/phys/constants.ts` **确实生效**（负对照：把该常量改一位应使其失败） | T-05、D-11、D-16、E-02、E-08、R-21、§9.1-G-4 |
| B4-8 | R-14 的 dev wasm 路径与 D-23 ③ 的 NOTICE 指针（三处均在 `apps/debug/src/` 下） | 改文本：`apps/debug/src/main-wasm.ts:19` 的 `'../pkg/websurf_wasm_bg.wasm'` → `'./websurf_wasm_bg.wasm'`；`apps/debug/src/physics/math/vec3.ts:7` 与 `apps/debug/src/physics/physics/Collision/Collision.types.ts:7` 的 `src/physics/NOTICE` 指针 → `src/phys/NOTICE` | **【裁定】**三处归批 4（t5 `inScope` 已含 `apps/debug/src/`；t4 的 `inScope` 不含 `apps/*/src/`，若改判批 3 需把 `apps/debug/src/` 加入 t4，会与批 4 在 `apps/debug/src/` 上重叠——不推荐）；`src/phys/{LICENSE,NOTICE}` 由 B3-6 建立，故本项须在批 3 之后落地 | `git grep -nE "pkg/websurf_(viewer_)?wasm_bg\.wasm" -- apps` **零命中**；`git grep -n "src/physics/NOTICE" -- apps` **空**；debug `typecheck` 退出码 0 | R-14、D-23③、§5.5、§9.1-G-5 |

**批 4 的例外（禁止上提，逐条实测保持原状）**：`E-01` 四份 `wasm.d.ts`、`E-02` 五份 `[patch.crates-io] vmdl`（实测 5 份：根 + 三工程 + harness）、`E-03` 四份模块 workspace `Cargo.toml`+`Cargo.lock`、`E-04` 三处 `textures.mtz`、`E-05` `src/serve.py` 与 viewer 内嵌 `SERVE_PY`、`E-06` `EYE_STAND` 的 Rust 权威 + TS 单点、`E-07` 三份 `.gitignore`、`E-08` 许可证源 + 产物级副本；以及 `D-05`/`D-06`/`D-07`/`D-12`/`D-14`/`D-15`/`D-17`/`D-19`/`D-20`/`D-21`/`D-22` 的「保留」项。判据：`git ls-files 'apps/*/src/wasm.d.ts'` 4 份；三处 `textures.mtz` SHA256 前 16 位全等；`Test-Path apps/debug/src/physics/math/vec3.ts` → True。

## 7. 执行顺序与文件冲突面

### 7.1 顺序（依赖关系决定）

```text
批 1（已完成）
   ↓
批 2（t2：D-01/D-02/D-03；**不含 T-04**）
   ↓                    ↓
批 3（t4：T-04 内核抽取 + 端口/输出/web/dist/许可证）   批 4（t5：D-08/D-09/D-16/D-10）
   └──────────┬─────────┘
              ↓
   t6 独立验证 → t7 复核 → t8 收口
```

- 批 3 与批 4 任务卡均只依赖 t2，**允许并行**，但须遵守 §7.2 的所有权划分与 §7.3 的构建互斥。
- **【裁定（captain，2026-09-12）】** `T-04` 归**批 3**：以规范为准（§7.5 排序约束 + §7.1 批 3 行 + §1.3 C-3 三处一致），t2 卡原写「T-04 排在产物改造之前」系笔误，**批 2 不含内核抽取**。受益：`apps/*/scripts/build-dist.mjs` 全程**只被改一轮**（由批 3 一次完成骨架抽取 + 产物行为改造），完全满足 §7.5 的意图。

### 7.2 文件冲突面（同一文件被两批改）

| 文件 | 批 2 | 批 3 | 批 4 | 处置 |
|---|---|---|---|---|
| `apps/*/scripts/build-dist.mjs` | —（批 2 不改） | **B3-0** 抽取为薄入口 + 许可证/全量重建/词表/`--multi` | — | **只由批 3 改一轮**（规范 §7.5 的意图即此）；批 2 提交内对该文件零改动 |
| `src/scripts/lib/dist-pack.mjs` | —（批 2 不建） | B3-0 新建（行为改造一并写入） | — | 归属批 3；须先加入 t4 `inScope`（§9.1-G-2） |
| `apps/*/package.json` | `check:api` 薄配置（viewer 新增键） | `dev` 端口、`build:wasm` 拷贝、`test:smoke`→`local:smoke`、`test:replay` outfile 改 `.tmp/` | — | **必须串行**（批 2 先） |
| `apps/debug/start-dev.cmd`、`apps/*/play.cmd`、`apps/*/build-dist.cmd` | 共享脚本调用点改层数/路径 | 按 §2.5 模板重写（覆盖批 2 的调用行） | — | **必须串行**（批 2 先），批 3 的重写必须使用批 2 落地后的调用形态 `%~dp0..\..\src\scripts\…` |
| `.github/workflows/deploy-pages.yml` | 若涉及（t2 inScope 含） | §6.2 收敛（`npm run build:dist -- --multi`、补 `test:*`） | — | **必须串行**（批 2 先） |
| `apps/debug/src/main-wasm.ts` | — | `apps/debug/package.json:8` 的 `build:wasm` 拷贝（B3-4） | **B4-2**（`:30` `atob`）+ **B4-8**（`:19` dev 路径） | **【裁定】**整文件归**批 4**（t5 的 inScope 已含 `apps/debug/src/`；t4 不含 `apps/*/src/`） |
| `apps/debug/src/physics/**` | — | —（B3-6 只动 `src/phys/{LICENSE,NOTICE}` 与构建脚本） | **B4-8**：NOTICE 指针 2 行 | **【裁定】**归**批 4**（同上：t4 不含 `apps/*/src/`）；D-06 判「保留」的是 vendored 子树本体，注释指针按 D-23③ 更新；批 4 不得搬迁该子树 |
| `apps/viewer/src/**`、`apps/game/src/**` | — | —（批 3 不改工程 `src/`） | D-08/D-09/D-16 的 import 改写 | 归**批 4** |
| `documents/**` | **B2-7**：`documents/framework-audit.md`（只此一篇，G-9 裁定新增 inScope） | —（文档面移入收口项 §7.4 S-1/S-2/S-3） | B4-6（共享层相关行；**不含** `architecture.md:105` 与 `documents/game/overview.md` 的端口文字） | 文件不重叠：批 2 只修 `framework-audit.md` 的 I-10 锚点与陈述；批 4 改 `ts-shared.md`/`architecture.md` 的**共享层计数与消费矩阵**/`documents/{debug,viewer}`；端口等文档面统一收口 |

### 7.3 并行执行约束（批 3 ∥ 批 4 时）

1. **不并发构建同一工程**：两批都会触发 `npm run build:ts` / `build:dist`，产物写同一 `web/` 与 `.tmp/`。任一批开始构建前须确认另一批不在同一工程目录内跑构建。
2. **批 4 会改变 `web/app.js` 内容**（源码变了），批 3 的 dist 验收若比对产物需在批 4 静止时进行；建议批 3 的 dist 验收以**批 2 提交（内核抽取前）的 `build-dist.mjs` 产物**为参照（`git show <批 2 提交>:apps/<app>/scripts/build-dist.mjs`），并声明批 4 后的产物差异属预期。
3. **`T-05` 已裁定并入批 4（§9.1-G-4）**，不再构成跨批依赖；批 3 的 CI 改动只做 §6.2 的 `npm run build:dist -- --multi` 与 `test:*` 补齐，**不新增** `check-shared-sync` 步骤（该步骤随 B4-7 在批 4 接入）。

### 7.4 收口项（t8，与本轮三批解耦）

G-6/G-7/G-8 裁定的**文档面**统一并入 t8 收口（`documents/` 与 README 不在批 2/3/4 的 `inScope` 内，且拆开会出现「半份在批内、半份在收口」）：

| # | 收口项 | 具体对象 | 判据 |
|---|---|---|---|
| S-1 | **端口文档同步**（G-6 裁定：文档面收口） | 根 `README.md:32`、`apps/debug/README.md:21-22,31`、`apps/game/README.md:58`、`apps/viewer/README.md:30,202`、[documents/game/overview.md](game/overview.md):107、`test/dual-mode-harness/README.md`、`test/dual-mode-harness/docs/overview.md:100` | `git grep -nE "\b(8080\|8081\|8090\|8091\|8100\|8101\|8110\|8137)\b" -- README.md apps documents test` 的每条命中都等于规范 §2.3 表值；`8137` **零命中**（harness 文件的 8080→8110 随 harness 另案，见 §10 第 3 条） |
| S-2 | `architecture.md` 的 `check-wasm-api` 三处断言（G-7 裁定） | [documents/architecture.md](architecture.md):105 | 断言与批 2 后的实际形态一致（「薄配置 + 共享引擎 `src/scripts/lib/wasm-api-contract.mjs`」，**不是**「三处各自实现」） |
| S-3 | `documents/index.md` 篇数（G-8 裁定） | 根 9 → 11、全量 27 → 29，并把 `rollout-plan.md`、`rollout-status.md` 纳入导航 | 篇数与 `Get-ChildItem documents -Filter *.md` 实测一致 |

- **【必须】** S-1/S-2/S-3 与「三份规范的待执行清单状态同步」同为 t8 的一次收口动作；**禁止**在批 3/批 4 内顺手改（会造成同一文件被两轮修改）。
- **【人工回看（必留，captain 2026-09-12）】** `documents/framework-audit.md` §2.4 表（`:110`/`:111`）的**裸行号** `:47`/`:75` 指向 `build-dist.cmd` 的调用行；不参与 doc-drift 的 A/B 判定，但批 3 重写 `.cmd` 后会「在范围内但错位」——收口时**必须**人工回看该表（与 §9.2 的「人工回看」要求同源，本项不得删除）。
- **【注意】** `documents/game/overview.md:107` 原被我排在 t5 `inScope` 内，现按 G-6 裁定**移出 t5、并入 S-1**（t5 不得再改该行）。

## 8. 每批回滚

| 批次 | 最小回滚 | 回滚验收点 | 前置条件 |
|---|---|---|---|
| 批 2 | `git revert <批 2 提交>`（D-01/D-02/D-03 建议压在一次提交内，**不含 T-04**，规范 §7.7「每批独立提交」） | 三工程 `typecheck` + `build:ts` 退出码 0；`Test-Path apps/debug/scripts/ensure-node-deps.cmd` → True；`Test-Path src/scripts/lib` → False | 必须在批 3/批 4 开始**之前**回滚（批 3 的 `.cmd` 重写与批 4 的 import 都建立在批 2 产物上） |
| 批 3 | `git revert <批 3 提交>` | 三工程 `dist/` 产物清单与 `__VBSP_*` 前缀与**批 2 提交的 `build-dist.mjs`（内核抽取前，`git show <批 2 提交>:apps/<app>/scripts/build-dist.mjs`）**逐字节一致；`Test-Path src/scripts/lib` → False；端口引用回到现状集合；豁免项仍在 | 回滚批 3 前须确认批 4 的 B4-7（依赖批 3 建立的 `src/phys/{LICENSE,NOTICE}`）与 B4-8（依赖 `src/phys/NOTICE` 的新位置）尚未落地，否则须连带回滚批 4；`T-05` 已并入批 4，不再构成跨批依赖 |
| 批 4 | `git revert <批 4 提交>` | `git grep -n "atob(" -- apps src` 回到 8 处；`git ls-files -- 'apps/*/src/world/pvs-manager.ts'` 回到 2 份；三工程 `typecheck` 退出码 0；`Test-Path src/ts-shared/wasm/loader.ts` → False；`Test-Path src/scripts/check-shared-sync.mjs` → False（B4-7）；`git grep -n "src/physics/NOTICE" -- apps` 非空（B4-8 回退） | 若批 3 的 dist 验收已按批 4 后产物记录，回滚批 4 后须重跑批 3 的 dist 验收点 |

- **禁止**把三批压在同一个提交里；**禁止**用 `git checkout .` 之类整树回滚（会连带丢弃他人在写的文件）。

## 9. 需更正的锚点与需 captain 裁定的问题

### 9.1 任务卡 / 规范之间的冲突与 inScope 缺口（**必须 captain 处置**）

| # | 问题（实测） | 影响 | requiredFix（建议） |
|---|---|---|---|
| G-1 | **`T-04` 顺序矛盾（已裁定）**：规范 §7.5 / §7.1 批 3 行 / §1.3 C-3 三处一致要求「T-04 排在 §10.3 第 3 步（产物改造）**之后**」；任务卡 t2 原写「T-04 必须排在产物改造**之前**」（笔误） | 若按 t2 卡原文字执行：同一文件被两批改，且与规范三处条文冲突 | **captain 已于 2026-09-12 裁定：以规范为准，`T-04` 归批 3、由 t4 承接；批 2 范围不含内核抽取**。本计划 §4 B2-4（批 2 不做）、§5 B3-0（批 3 执行）、§7.1/§7.2/§8 已按此改写。**判据**：若 t2 报告把内核抽取算作已完成项 → **越界**，判 needs_revision |
| G-2 | t4 的 `inScope` **不含** `src/scripts/lib/dist-pack.mjs`，而 B3-0/B3-5/B3-6 的宿主代码（内核新建 + `cleanDist` / `copyLicensePair`）全在该文件 | 批 3 无法完成 T-04 与产物改造，只能把三份副本写回去 → 与 D-04 回流 | **【captain 2026-09-12 裁定：同意，但依据随 G-1 改变】** 内核在批 3 内**新建并当批消费**（不再是「回流」而是「批内自建自用」）；把 `src/scripts/lib/dist-pack.mjs` 加入 t4 `inScope` |
| G-3 | t4 的 `inScope` **不含** `test/dual-mode-harness/{play.cmd,package.json}`，而规范 §2.3 与 §10.1 第 21 条要求把 harness 端口改为 8110 | 若把 harness 计入判据，t4 的「端口逐条一致」验收**必然失败**（现 `test/dual-mode-harness/play.cmd:6` 为 8080） | **【captain 2026-09-12 裁定：采纳「显式排除 harness」，不扩大 inScope】** harness 本轮不在范围（D-22 + `test/` 不在任何任务 inScope）；判据改为「**`apps/` 下**全部 `set PORT=` / `serve.py` 调用 / `npm run dev` / CI 引用逐条一致」，harness 的 8080 → 8110 差异登记为遗留项（§10 第 3 条）。已落到 §5 B3-1⑤ / B3-7 |
| G-4 | `T-05`（`src/scripts/check-shared-sync.mjs`）**无归属**：t2/t4/t5 的 `inScope` 均不含该文件；且其 `eye-stand` 子检查需要批 4 才创建的 `src/ts-shared/phys/constants.ts` | 门禁缺失（D-11/D-16/E-02/E-08 退回「靠文档记载」），或批 3 落地即红 | **【captain 2026-09-12 裁定：采纳，`T-05` 并入 t5（批 4）】** 把 `src/scripts/check-shared-sync.mjs` 加入 t5 `inScope`，并要求该门禁在**批 4 完成后可跑、`eye-stand` 子检查对 `src/ts-shared/phys/constants.ts` 生效**（负对照须能使其失败）。已落到 §6 B4-7；§7.3 第 3 条的跨批依赖随之消解 |
| G-5 | `apps/debug/src/main-wasm.ts`（R-14 的 `:19`）与 `apps/debug/src/physics/math/vec3.ts:7`、`apps/debug/src/physics/physics/Collision/Collision.types.ts:7`（D-23 ③ 的 NOTICE 指针）**都不在 t4 inScope**（t4 不含 `apps/*/src/`）；t5 虽含 `apps/debug/src/` 但其目标是 D-n 搬迁 | R-14 与 D-23 ③ 落不了地 | **【captain 2026-09-12 裁定：采纳本计划的落点 —— 三处全归批 4（t5），不扩 t4 `inScope`】** 理由：为它们扩 t4 会让批 3/批 4 在 `apps/debug/src/` 上重叠（与 G-3 避免的形态同构）。已落为 **§6 B4-8**；`src/phys/{LICENSE,NOTICE}` 唯一源与构建期拷贝仍由 t4 的 B3-6 负责 |
| G-6 | **端口/文案的文档同步无归属**：根 `README.md:32`、`apps/{debug,game,viewer}/README.md`、[documents/game/overview.md](game/overview.md):107 —— 均不在 t2/t4/t5 任一 `inScope`；t8 的 `inScope` 也不含根 `README.md` 与 `apps/*/README.md` | R-02 的文档面长期不一致（`git grep "8137" -- documents` 仍命中）；若拆到批 3 会造成「半份文档在批内、半份在收口」 | **【captain 2026-09-12 裁定：按「可执行面 vs 文档面」二分】** ① **可执行端口面 → t4（批 3）**：`apps/*/{play,start-dev,build-dist}.cmd`、`apps/*/package.json`、CI —— 已落为 §5 B3-1（判据收窄为「`apps/` 下可执行引用逐条一致」并显式声明排除项）；② **文档面 → t8 收口**：统一登记为 **§7.4 S-1「端口文档同步」**，与 G-7/G-8 同一批处理；③ `documents/game/overview.md:107` **从 t5 移出**并入 S-1（t5 不得再改该行）。**原 B3-7 已删除** |
| G-7 | [documents/architecture.md](architecture.md):105 的断言「`check-wasm-api.mjs` 存在于 debug / game / harness **三处**」在批 2 后**失真**（三处仍在，但实现变为「薄配置 + 共享引擎」） | 读者按旧断言排查会走错 | **captain 2026-09-12 裁定：留到 t8 收口，现在不提前改** —— 已并入 **§7.4 S-2**（与 G-6 的文档面、G-8 同批）；§6 B4-6 明确本批不改该项 |
| G-8 | **`documents/index.md` 篇数已漂移**：根 `documents/` 实测 10 篇（含 captain 的 `rollout-status.md`），index 声明「根 9 篇 / 全量 27 篇」；本文件落库后为 11 篇 | `AGENTS.md` §5.1 的「新增文档必须同步 index」被违反；doc-drift 的篇数口径对不上 | **captain 2026-09-12 裁定：留到 t8 收口** —— 已并入 **§7.4 S-3**：根 9 → 11、全量 27 → 29，并把 `rollout-plan.md`、`rollout-status.md` 纳入导航 |
| G-9 | **批 2 落地即让全仓 doc-drift 门禁变红且无归属**：`T-03` 把 `apps/debug/scripts/check-wasm-api.mjs` 从 127 行削到 55 行，而 [documents/framework-audit.md](framework-audit.md):432（I-10）仍引 `:109-126` → **B 类锚点越界**，`check-doc-drift.mjs` 退出码 1（等价口径实测：`锚点 1769（越界 1）｜路径失效 8`） | t3/t6 的验收都写「全仓 doc-drift 等价口径退出码 0、零漂移零越界」——不处置就会判 t2/t4/t6 needs_revision | **【captain 2026-09-12 裁定：采纳方案①，由 t2 自己修它改坏的锚点】** 理由 = 自洽性（每批结束时仓库保持 doc-drift 绿）；②会把红门禁跨批传递、③会让 CI 永久红，均不采纳。**执行细则已落为 §4 B2-7**：t2 `inScope` 精确新增 `documents/framework-audit.md`（**只此一篇**）；改写须反映新形态（薄配置 + 共享引擎）与新问题陈述，**不是只把行号改小**；**I-10 涉及的全部锚点一次核完** —— 除 debug 那处（已越界）外，game 那份（`apps/game/scripts/check-wasm-api.mjs`）的 `:25-64` **未越界但内容已失真**，D-03 后同样失效，两处同批改完（正好印证「只查越界不查错位」）。C 类 8 处本批不修、只列清单 |

### 9.2 需更正的锚点清单（规范锚点在 HEAD `4523ef1` 上已失真）

**A. [framework-launch-structure.md](framework-launch-structure.md)**（规范性文档，优先）

| 行 | 现锚点 / 陈述 | 实测（HEAD） | 更正建议 |
|---|---|---|---|
| 155 | §2.5.1 判据括注「当前命中：`apps/viewer/scripts/build-dist.mjs` 7 处、`src/serve.py` 2 处」 | **21 处**：`apps/game/build-dist.cmd` 6 + `apps/viewer/build-dist.cmd` 5 + `apps/viewer/scripts/build-dist.mjs` **8** + `src/serve.py` 2 | 补齐三类漏计；`:242` 的 `[warn]` 必须登记（见下行） |
| 371 | §2.7 行：viewer `build-dist.mjs` 词表外标记「共 7 处（`:77`、`:78`、`:161`、`:163`、`:164`、`:168`、`:169`）」 | 该 7 处命中无误，但**漏 `:242`**（`console.warn` 的 `[warn]`） | 改为「8 处」并补 `:242`；否则批 3 会按 7 处收敛、判据 ① 仍无法清空 |
| 427 | §3.3 表末「**反例**：`apps/debug/scripts/install-wasm-bindgen.cmd:19` 写 `..\..\`」 | `:19` 现为 `call "%~dp0..\..\..\src\scripts\cargo-env.cmd"`（`fa5552e` 已修） | 改为「历史反例（`fa5552e` 已修复）」 |
| 468 | §3.6 行「第 19 行 `..\..\` 少一层」+「禁止先就地补 `..` 再移动」 | 层数已就地修好（批 1）；上提动作仍未执行，D-02 的「归属错位」理由仍成立 | 保留上提动作，删除「少一层」现状描述；补一句「批 1 已就地修层，顺序倒置不可逆，按上提执行」 |
| 603 | §6.1「game 段（`:121-137`）」「viewer 段（`:139-159`）」「harness 段（`:161-178`）」 | game 段 **`:121-150`**、viewer 段 **`:152-172`**、harness 段 **`:174-191`** | 三处顺延（`6da49ae` 在 `:139-150` 插入两条 game test 步骤） |
| 604 | 「viewer `npm run build:dist`（`:155`）」 | **`:168`** | 顺延 |
| 605 | 「viewer 只跑 `test:replay`」（`:159`）；「**game 段无任何 test 步骤**」；「`test:jump-apex` 未进 CI 且当前有层数缺陷」 | `test:replay` 现 **`:172`**；game 段**已有** `test:phys`（`:144`）与 `test:seed-smoke`（`:150`）（`6da49ae`）；层数缺陷已修（`fa5552e`，实测 `test:jump-apex` 退出码 0），**仍未进 CI** | 三处更正；`test:jump-apex` 只剩「未进 CI」这一半 |
| 355 | §2.6「（`apps/debug/start-dev.cmd:63` 现用此法，属待改项）」 | `:63` 是 `start "" python …`；`cmd /k` 在 **`:73`** | 改为 `:63`（`start ""`）＋ `:73`（`cmd /k`） |
| 764/786 | §10.1 第 14 条与 §10.3 第 1 步列「`jump-apex-{verify,serve}.mjs` 补一层」为待执行 | **已由 `fa5552e` 完成** | 标为已执行（附提交号），从待执行清单移除；§10.3 第 1 步只剩 `tsconfig` 与 `viewer/package.json` 两项 |

**B. [framework-decoupling.md](framework-decoupling.md)**

| 行 | 现锚点 / 陈述 | 实测（HEAD） | 更正建议 |
|---|---|---|---|
| 118 | D-02 依据③「它当前带 I-22 层数缺陷」 | 层数已在 `fa5552e` 修正 | 删该理由或标「已修（`fa5552e`）」；上提理由 ①②仍成立 |
| 368 | §6.3「层数反例（历史 + 本轮实测）：`…install-wasm-bindgen.cmd:19` 少一层」 | 同上，已是三层 | 标为**历史**（批 1 已修） |
| 137 | D-21「`.github/workflows/deploy-pages.yml:187` 拷为 `deploy/index.html`」 | 现为 **`:200`** | 顺延（`:58` 那条 D-20 锚点实测仍正确，无需改） |
| 124 | D-08「4 处」 | `apps`+`src` 内 4 处成立；**第 5 份**在 `test/dual-mode-harness/src/main.ts:244`（范围外） | 在 D-08 与 §7.7 判据行显式写明口径 `-- apps src`，否则「只剩共享单份」类判据永假 |
| 125 | D-09 清单中 `apps/debug/src/world/pvs-manager.ts:273` 与 `apps/game/src/world/pvs-manager.ts:273` | `atob` 实际在 **`:274`**（`:273` 是函数签名行）；另 `test/dual-mode-harness/scripts/phys-smoke.mjs:582` 是第 9 处（outOfScope） | 行号改 `:274`；「全仓恰好剩 1 处」改述为「`apps` + `src` 恰好剩 1 处」。**captain 已于 2026-09-12 确认该口径**（t6 验收第 5 条的「全仓」为笔误）：`test/` 内副本只要求登记为后续项、**不要求消除**（**批 4 已执行**：两份工程内副本已删、上提 `src/ts-shared/world/pvs-manager.ts`） |
| 132 | D-16 的 8 处计数 | 在 `apps`+`src`（`*.ts`/`*.mjs`/`*.rs`，排除 `fixtures/`）口径下**成立**；`test/dual-mode-harness/**` 另有 30+ 处，其中 `test/dual-mode-harness/src/worker-b.ts:124` 是 captain 登记的**第 9 处**（outOfScope，只要求登记） | 在 T-05 `eye-stand` 与 §10.2 判据行显式写口径 `-- apps src` |

**C. [framework-audit.md](framework-audit.md)**（审计快照；只登记状态变化，不建议改条文）

| 行 | 现陈述 | 实测（HEAD） |
|---|---|---|
| 519/521 | I-03、I-22 列为「真缺陷」 | 均已由 `fa5552e` 修复；`npm run test:jump-apex` 实测退出码 0 |
| 417 | I-02「game 的 2 个、viewer 的 1 个验证脚本从未进 CI」 | `6da49ae` 已把 game 两条补进 CI；viewer `test:smoke` 仍未进（且按 §4.3 应改名 `local:smoke`） |
| 495 | §7.4 表「`npm run test:jump-apex`（debug）→ **1**」 | 现为 **0** |
| 435 | I-13 引 `.github/workflows/deploy-pages.yml:91,137,155` | `:91`/`:137` 仍正确（两条 `node scripts/build-dist.mjs --multi` 未动，也是 §6.2 待收敛项）；`:155` → **`:168`** |
| 231/137 | `:187` 拷为 `deploy/index.html` | → **`:200`** |
| 64/65/66 | debug `play.cmd:63`、game `play.cmd:61`、viewer `play.cmd:13`/`:14` | debug `App:` 行在 **`:64`**、game 在 **`:62`**、viewer `set PORT=` 在 **`:15`**、`[port]` 在 **`:16`**（`:60` 的 `call "dist\play.cmd"` 正确） |
| 406 | `.github/workflows/deploy-pages.yml:67`（wasm-bindgen-cli 0.2.128） | `:67` = `VERSION=0.2.128`，仍落在 `:63-73` 步骤内，**可接受** |

**C 类（路径失效，告警不失败）—— 批 2 之后须回改的旧路径清单（本批不修，t2 报告须逐条列出）**：`install-wasm-bindgen.cmd` 移走后共 8 处引用旧工程内路径（**收口 `t9` 已逐条处置：历史叙述加注、当前事实改写**；完整 15 处含 `pvs-manager` 类的处置表见 [rollout-status.md](rollout-status.md) §4）：

| # | 文件:行 | 旧路径 |
|---|---|---|
| 1 | `documents/framework-audit.md:521` | `apps/debug/scripts/install-wasm-bindgen.cmd` |
| 2 | `documents/framework-decoupling.md:118` | 同上 |
| 3 | `documents/framework-decoupling.md:368` | 同上 |
| 4 | `documents/framework-launch-structure.md:427` | 同上 |
| 5 | `CHANGELOG.md:11` | 同上 |
| 6 | `CHANGELOG.md:86` | 同上 |
| 7 | `documents/framework-audit.md:434` | `apps/debug/scripts/ensure-node-deps.cmd`（D-01 上提后失效） |
| 8 | `documents/rollout-plan.md`（本文件 §9.2 A 表，引用规范原文） | `apps/debug/scripts/install-wasm-bindgen.cmd`（**已上提**：`src/scripts/install-wasm-bindgen.cmd`） |

判据：`git grep -n "apps/debug/scripts/install-wasm-bindgen.cmd\|apps/debug/scripts/ensure-node-deps.cmd" -- '*.md'`；C 类不影响 `check-doc-drift.mjs` 退出码（`:16` 自述），处置口径见 [AGENTS.md](../AGENTS.md) §7.1 第 11 项（历史叙述可刻意保留，须标注）。

## 10. 不做清单（本轮与三批之内都不做）

1. **本轮（本文件对应的任务）不执行任何搬迁**：只新增 `documents/rollout-plan.md`；不改代码 / 配置 / CI / 三份规范 / [AGENTS.md](../AGENTS.md)。
2. **不修改三份已冻结规范**：§9.2 的锚点更正由 captain 在收口时统一处置。**唯一例外**：批 2（t2）的 `inScope` 经 G-9 裁定新增 `documents/framework-audit.md`，只用于修平 B2-7 那一处**自己造成**的锚点越界（C 类 8 处仍不修）。
3. **不动 `test/dual-mode-harness/`**：D-22 判「保留（本轮）」；其 `check-wasm-api.mjs` 与 `build-dist.mjs` 是共享工具的**第二轮**可选消费方。**G-3 已裁定：harness 端口本轮显式排除**（不扩 t4 `inScope`）——现状 `set PORT=8080`（`test/dual-mode-harness/play.cmd:6`）与 `dev`（`test/dual-mode-harness/package.json:13`）对照规范目标 8110 的差异，连同 `test/dual-mode-harness/README.md`、`test/dual-mode-harness/docs/overview.md:100` 的端口文案，**统一登记为 harness 另案的遗留项**。
4. **不新增根级 `package.json` / npm workspace / 跨工程端口配置文件**（§6.4、§8.3）。
5. **不合并**：五份 `[patch.crates-io] vmdl`、四份模块 workspace `Cargo.toml`+`Cargo.lock`、四份 `src/wasm.d.ts`、三份 `package.json`/`package-lock.json`/`tsconfig.json`、`src/serve.py` 与 viewer 内嵌 `SERVE_PY`（E-01…E-05）。
6. **不上提**：`play.cmd`/`start-dev.cmd`/`build-dist.cmd` 三件套入口本体、`apps/debug/fixtures/`、`pages-index.html`、`web/{index.html,styles.css,textures.mtz}`、`apps/debug/src/physics/` 的 vendored 子树与面板模型、viewer 的 `dist-README.md` 与 `test/`（§8.1 第 5–9 条、D-05/D-06/D-21）。
7. **不在 `src/` 顶层新建** `decoupled/`、`auth/`、`input/`、`tick/`、`phys/`（TS 侧）之类与 `src/ts-shared/` 子目录同名的目录（§5.3）。
8. **不为「消除重复」把 Rust `EYE_STAND` 改成 TS 可注入参数**（D-16 明文禁止）。
9. **不为整齐抹平真实差异**：viewer single-only 与 `file://` 双击、viewer 不依赖 `websurf-phys`、debug 无 `web/styles.css`、viewer 无 `web/textures.mtz`、harness 无 `web/`（§8.2、§3.2 豁免表）。
10. **不把 `.cmd` 文案改成中文**（词表与 ASCII 约束优先，§8.3）。
11. **不新增未登记的豁免**（§3.2 末条）。
