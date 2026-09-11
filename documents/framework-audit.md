# 框架现状审计（事实基线）

> 审计对象：`apps/debug/`、`apps/game/`、`apps/viewer/`、`test/dual-mode-harness/` 四个模块工程，与共享层 `src/`。
> 审计方式：只读实测（`git ls-files`、读源码、跑命令），**不修改任何代码或配置**。
> 审计时间：2026-09-12。所有行号与字节数均为本次实测值。
> 定位：本文是后续启动/结构规范与解耦方案的**唯一事实基线**；文中每条事实都给出 `文件:行号` 或 `命令 + 实测输出`。
> 读完本文你应该知道：三工程现在到底哪里不一致、哪些既有约定已被违反、以及规范必须闭环哪些条款。

## 1. 审计范围与方法

### 1.1 证据约定

- 形如 `apps/game/play.cmd:8` 的锚点表示该文件的第 8 行；`git ls-files` 输出的文件路径均来自版本库实测。
- 命令行证据统一写成 `$ 命令` 后接实测输出（截取关键行），退出码以 `exit=N` 标注。
- 任何与我实测不符的既有说法，都在正文中显式标注 **「更正」** 并给出反证。

### 1.2 覆盖范围与实测工具链

| 项 | 实测值 | 证据 |
|---|---|---|
| 版本库文件总数 | 318 | `git ls-files` 逐行计数 → `318` |
| 分支 / HEAD | `main` / `a4ed66f` | `$ git branch --show-current` → `main`；`$ git log --oneline -1` → `a4ed66f refactor: 输入层上提共享层 + AGENTS.md 协作规范 + 文档重编纂收尾`（上一条 `2cd80f3 fix(apps): 补齐迁移遗漏的相对路径 +1 层（46 文件）`） |
| 工作区状态 | 干净 | `$ git status --short` → 空输出 |
| Node / npm | `v25.8.0` / `11.11.0` | `$ node -v` / `$ npm -v` |
| Python | `Python 3.11.9` | `$ python --version` |
| Rust / wasm-pack | `cargo 1.97.1` / `wasm-pack 0.13.1` | `$ cargo --version` / `$ wasm-pack --version` |

### 1.3 本次审计的环境能力边界（重要）

本会话运行在只读沙箱里，有两类命令**无法**复现，本文对此如实记录，不冒充已通过：

1. `$ node src/scripts/check-doc-drift.mjs [任意参数]` → `spawnSync git EPERM`（errno `-4048`），退出码 1。原因是该脚本在 `src/scripts/check-doc-drift.mjs:31` 用 `execFileSync` 起子进程取 `git ls-files`，而沙箱禁止 node → 外部进程 spawn；**与是否传参数无关**（传单文件参数同样失败）。**这不是仓库缺陷，也不可作为文档验收失败的判据**。
2. `$ npm run build:wasm`（wasm-pack）→ `Error: failed to start cargo metadata: 拒绝访问。 (os error 5)`；`$ npm run build:dist`（esbuild JS API）→ `Error: spawn EPERM`。同属沙箱对子进程 spawn 的限制：esbuild **CLI**（`npm run build:ts`）可正常跑通，JS API（`scripts/build-dist.mjs`）不可。

因此本文的验收分两条腿，互不替代：

- **单文件铁律自查**（本节审计员负责，沙箱内可跑、纯 `fs`，命令见 §7.4）；
- **全仓 doc-drift 体检**（需能 spawn 子进程的环境负责，例如 t6 集成阶段用可直接跑 pwsh 的会话执行 `node src/scripts/check-doc-drift.mjs`）。

对第 1 项的替代实测（可复现）：先执行 `git ls-files --cached --others --exclude-standard > .tmp-filelist.txt`，再把 `src/scripts/check-doc-drift.mjs:31` 那一行 git 调用整体替换为 `const tracked = fs.readFileSync('.tmp-filelist.txt','utf16le').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);`，其余逻辑逐字不改地跑一次，得到等价的 A/B/C/D 四类结果（见 §4.4 与 §7.4）。第 2 项的替代实测：`pkg/`、`web/`、`dist/` 三处产物都在磁盘上真实存在，本文只描述**已存在的产物**，不声称本次重建过它们。

## 2. 三工程入口对照

### 2.1 启动/构建入口清单（实测）

`$ git ls-files | Where-Object { $_ -match '\.(cmd|sh|py)$' }` 实测输出（逐字节数）：

| 文件 | debug | game | viewer | harness |
|---|---|---|---|---|
| `apps/<app>/play.cmd` | 有（2431 B） | 有（2276 B） | 有（3183 B） | 有（2860 B） |
| `apps/<app>/start-dev.cmd` | 有（3293 B） | **无** | **无** | **无** |
| `apps/<app>/build-dist.cmd` | 有（3936 B） | 有（4799 B） | 有（5213 B） | **无** |
| `apps/<app>/scripts/ensure-node-deps.cmd` | 有（1267 B） | 有（1267 B） | **无** | **无** |
| `apps/<app>/scripts/install-wasm-bindgen.cmd` | 有（5033 B） | **无** | **无** | **无** |
| `src/scripts/cargo-env.cmd` | 四工程共用（1598 B） | 共用 | 共用 | 共用 |
| `src/serve.py` | 共用（2529 B） | 共用 | 共用 | 共用 |

`:37` 明确宣称三个应用工程的 Windows 双击入口是 `play.cmd / build-dist.cmd / start-dev.cmd` 三件套，而 game/viewer 实测无 `start-dev.cmd`（见 I-06）。

### 2.2 端口与目标页（实测）

| 工程 | `play.cmd` 端口 | `play.cmd` 目标页 | 是否支持 `[port]` 传参 | `start-dev.cmd` 端口与目标页 | `npm run dev` 端口 |
|---|---|---|---|---|---|
| debug | 8081（`apps/debug/play.cmd:6`） | `dist/index.html`（`apps/debug/play.cmd:63`） | 否 | 8080，`web/index.html`（`apps/debug/start-dev.cmd:11`、`:85`） | 8080 |
| game | 8137（`apps/game/play.cmd:6`） | `dist/index.html`（`apps/game/play.cmd:61`） | 否 | 无此入口 | 8080 |
| viewer | 8090（`apps/viewer/play.cmd:13`） | `index.html`（由 `dist/play.cmd` 服务；本工程 `apps/viewer/play.cmd:60` 调用它） | **是**（`apps/viewer/play.cmd:14`） | 无此入口 | 8080 |
| harness | 8080（`test/dual-mode-harness/play.cmd:6`） | `index.html`（`test/dual-mode-harness/play.cmd:63`） | 否 | 无此入口 | 8080 |

`$ grep -n 'set PORT=' apps/*/play.cmd` 实测（按未匹配内容原样抄录）：`apps/debug/play.cmd` 第 6 行 `set PORT=8081`、`apps/game/play.cmd` 第 6 行 `set PORT=8137`、`apps/viewer/play.cmd` 第 13 行 `set PORT=8090`、`test/dual-mode-harness/play.cmd` 第 6 行 `set PORT=8080`。

两个直接后果：

- 四个 `npm run dev` 全部写死 8080（`apps/debug/package.json:15`、`apps/game/package.json:15`、`apps/viewer/package.json:17`、`test/dual-mode-harness/package.json` 的 `dev`），与 harness 的 `play.cmd` 抢同一端口；谁先起谁赢，后来者报错。
- debug 的 dev 目标页是 `web/index.html`（`apps/debug/start-dev.cmd:85` 打印并打开），而 `src/serve.py:58` 打印的是 `App: http://localhost:{PORT}/web/index.html`——两者一致；但 game/viewer 的 `npm run dev` 只能靠 README 手写提示，各写各的（`apps/viewer/README.md:30` 写 `http://localhost:8080/web/`，缺少 `index.html`）。

### 2.3 `package.json` scripts 对照（实测）

`$ node -e "…逐工程读 package.json 求 scripts 键的并集…"` 实测矩阵（`YES` = 该工程有此脚本）：

| script | debug | game | viewer | harness | 语义 |
|---|---|---|---|---|---|
| `build` | YES | YES | YES | YES | 均为 `build:wasm && build:ts` |
| `build:wasm` | YES | YES | YES | YES | 实现不同，见下 |
| `build:worker` | YES | YES | YES | **缺** | esbuild worker 入口 |
| `build:app` | YES | YES | YES | **缺** | esbuild app 入口 |
| `build:ts` | YES | YES | YES | YES | 实现不同，见下 |
| `build:dist` | YES | YES | YES | YES | `node scripts/build-dist.mjs` |
| `typecheck` | YES | YES | YES | YES | 均为 `tsc --noEmit` |
| `dev` | YES | YES | YES | YES | 均为 `python ../../src/serve.py 8080 .` |
| `check:api` | YES | YES | **无** | YES | 三种不同实现 |
| `test:*` / `bench:*` / `plot:*` / `count:*` | 9 个 | 2 个 | 2 个 | 1 个 | 命名混乱，见 §3.2 |

`build:ts` 的实现实测有 3 种形态：

- debug/game/viewer：`npm run typecheck && npm run build:worker && npm run build:app`（`apps/debug/package.json:12`、`apps/game/package.json:12`、`apps/viewer/package.json:14`）。
- harness：一条 `npm run typecheck && esbuild src/main.ts … && esbuild src/worker-a.ts … && esbuild src/worker-b.ts …`（`test/dual-mode-harness/package.json` 的 `build:ts`），**没有** `build:worker` / `build:app` 两个子脚本。

`build:wasm` 的实现实测也有 3 种形态：

- debug（`apps/debug/package.json:8`）：`cd crates/wasm && wasm-pack build --release --target web --out-dir ../../pkg`，**不把 wasm 拷进 `web/`**。
- game（`apps/game/package.json:8`）：同上再 `&& node -e "…copyFileSync('../../pkg/websurf_wasm_bg.wasm','../../web/websurf_wasm_bg.wasm')"`。
- viewer（`apps/viewer/package.json:8`）：同上但拷贝 `websurf_viewer_wasm_bg.wasm`。

`devDependencies` 实测也不齐：`apps/viewer/package.json:23` 比 debug/game 多一个 `ws`（供 `test:smoke` 的 CDP 通路用）；harness 与 debug/game 一致。

### 2.4 三个 `build-dist.cmd` 的步骤骨架对照（实测）

| 工程 | 步骤号范围 | 工具链检查 | WASM 契约检查 | Node 依赖引导 | CRLF / 纯 ASCII | `chcp 65001` |
|---|---|---|---|---|---|---|
| debug | `[1/3]`…`[3/3]` | 无（只查 python，`:5-12`） | `call node "%~dp0scripts\check-wasm-api.mjs"`（`:47`） | `call scripts\ensure-node-deps.cmd nopause`（`:54`） | 是 / 是 | **无** |
| game | `[0/5]`…`[5/5]` | npm + wasm-pack + node（`:31-49`，`[0/5]` 在 `:23`） | `call node "%~dp0scripts\check-wasm-api.mjs"`（`:75`） | `call scripts\ensure-node-deps.cmd nopause`（`:48`） | 是 / 是 | `:2` |
| viewer | `[0/4]`…`[4/4]` | npm + wasm-pack + node（`:32-50`，`[0/4]` 在 `:30`） | **无** | 内联 `if exist "node_modules\esbuild" goto :deps_done`（`:60`） | 是 / 是 | `:2` |

实测证据：`$ foreach (f in *.cmd) { Select-String -Pattern 'chcp' }` →
`apps/debug/play.cmd chcp=no`、`apps/game/play.cmd chcp=no`、`apps/viewer/play.cmd chcp=YES (line 2)`、`apps/debug/start-dev.cmd chcp=YES (line 2)`、`apps/debug/build-dist.cmd chcp=no`、`apps/game/build-dist.cmd chcp=YES (line 2)`、`apps/viewer/build-dist.cmd chcp=YES (line 2)`、`test/dual-mode-harness/play.cmd chcp=no`。
`$ node -e "…逐文件统计 >127 的字节数与 BOM…"` → 12 个 `.cmd` 全部 `nonASCIIbytes=0`、`BOM=false`（符合「`.cmd` 保持纯 ASCII」的既有实践）；`$ node -e "…统计 LF 与 CRLF…"` → 12 个 `.cmd` 全部 `LF == CRLF`、`loneCR=false`。

### 2.5 退出码与暂停行为对照（实测）

| 入口 | 成功退出码 | 失败时的暂停行为 | 失败段锚点 |
|---|---|---|---|
| debug `play.cmd` | 由 `python serve.py` 决定 | 每个失败分支 `pause` + `exit /b 1` | `apps/debug/play.cmd` 的 4 个内联失败块（`:27-31`、`:36-40`、`:46-50`、`:54-58`） |
| game `play.cmd` | 同上 | 同上 | `apps/game/play.cmd` 的 4 个内联失败块（`:26-31`、`:35-40`、`:45-50`、`:53-58`） |
| viewer `play.cmd` | `exit /b 0`（复用已运行实例时，`:66`） | 三处失败分支 `pause` + `exit /b 1` | `:68-74`、`:76-81`、`:83-89` |
| debug `start-dev.cmd` | `cmd /k` + `exit /b 0`（`:73-74`） | 失败分支 `pause` | `:76-82`、`:84-88` |
| debug `build-dist.cmd` | `exit /b 0` | 4 个失败分支 `pause` | `:82-88`、`:90-96`、`:98-102`、`:104-108` |
| game `build-dist.cmd` | `exit /b 0` | 5 个失败分支 `pause` | `apps/game/build-dist.cmd:118-124`、`:126-133`、`:135-141`、`:142-148`、`:150-155` |
| viewer `build-dist.cmd` | `exit /b 0` | 5 个失败分支 `pause` | `apps/viewer/build-dist.cmd:120-126`、`:128-135`、`:137-143`、`:145-151`、`:153-158` |

**退出码传递形态不一致（实测）**：游戏侧与 viewer 侧的 dist 步骤都用 `call node "%~dp0scripts\build-dist.mjs"`（直接调 node），viewer 还在注释里写明理由——「Direct node call（same as game\build-dist.cmd）：bypasses npm run so the exit code flows straight through」（`apps/viewer/build-dist.cmd:84-88`）；而 debug 侧第 3 步是 `call npm run build:dist`（`apps/debug/build-dist.cmd:63-64`）。同一仓库里「`npm run` 会吞退出码」这条经验只在 viewer 侧被写进注释并绕开，debug 未跟进。

### 2.6 `play.cmd` 正文重复度（实测）

`$ git diff --no-index --numstat apps/debug/play.cmd apps/game/play.cmd` → `3  5  apps/{debug => game}/play.cmd`（仅 8 行 != ）。逐行 diff 差异全文：

```text
@@ -3 +3 @@ -title WebSurf - Play                          +title WebSurf-game - Play
@@ -6 +6 @@ -set PORT=8081                               +set PORT=8137
@@ -22,2 +21,0 @@ -REM Role alignment: game/play.cmd + viewer/play.cmd …
                  -REM Note: 8080 belongs to start-dev.cmd (dev server for web/), play uses 8081.
@@ -62 +60 @@ -echo  WebSurf  Local Play (dist)            +echo  WebSurf-game  Local Play
```

**更正**：任务描述给的既有事实称「`apps/debug/play.cmd` 与 `apps/game/play.cmd` 的正文几乎逐字相同（除 PROJECT 名与 PORT）」——实测**成立**（仅 4 处、8 行差异），此处只是把差异收到可复现的 diff 输出。但要注意第三个文件 `apps/viewer/play.cmd` 走的是完全不同的实现路径（`call "dist\play.cmd"` 而非内联 `python serve.py`），文案与步骤编号也不同。

## 3. 产物与输出对照

### 3.1 `web/` 目录实况

`$ Get-ChildItem apps/<app>/web` 实测（数值单位是字节）。已标注「入库」的行是受版本库跟踪的源文件；其余为构建产物（`web/app.js`、`web/worker.js`、`web/*.wasm` 全部由 `.gitignore` 覆盖，不入库）：

| 产物种类（位于各工程 `web/`） | debug | game | viewer |
|---|---|---|---|
| esbuild 应用包（app.js） | 1367049 | 1178855 | 1162810 |
| esbuild Worker 包（worker.js） | 115560 | 88332 | 18464 |
| index.html（入库） | 34586 | 15630 | 6050 |
| styles.css（入库） | **无** | 23874 | 19586 |
| textures.mtz（入库） | 5942995 | 5942995 | **无** |
| websurf_wasm_bg.wasm | **无** | 3710792 | **无** |
| websurf_viewer_wasm_bg.wasm | **无** | **无** | 3316194 |

debug 没有 `web/styles.css`，样式内联在 `apps/debug/web/index.html:7`（`<style>` 起始于第 7 行）。

**运行时 wasm 加载路径三工程各不相同（实测）**：

| 工程 | dev 时的 wasm URL | multi dist 时的 URL | single dist 时的来源 | 证据 |
|---|---|---|---|---|
| debug | `../pkg/websurf_wasm_bg.wasm`（相对 `web/`） | `__VBSP_WASM_URL__` 注入 | `__VBSP_WASM_B64__` 内嵌 | `apps/debug/src/main-wasm.ts:16-21`、`:27-35` |
| game | `./websurf_wasm_bg.wasm`（相对 `web/`） | 同左（`build:wasm` 已拷进 `web/`） | `__VBSP_WASM_B64__` 内嵌 | `apps/game/src/app.ts:120`、`:139` |
| viewer | `new URL('./websurf_viewer_wasm_bg.wasm', import.meta.url)` | 无 multi | `__VBSP_WASM_B64__` 内嵌 | `apps/viewer/src/core/bsp.ts:44-52` |

这是「三工程产物形态不一致」最硬的一条：**同一个 `web/app.js` 在 debug 下依赖 `../pkg/`，在 game 下依赖同目录拷贝，在 viewer 下依赖 `import.meta.url` 解析**。它解释了为什么只有 game/viewer 的 `build:wasm` 需要那条 `copyFileSync`。

### 3.2 `dist/` 产物实况（构建产物，不入库）

| 工程 | 已有产物（实测字节） | 形态 | 附带文件 |
|---|---|---|---|
| debug | `app.js` 13747371、`index.html` 34572、`LICENSE.cs-movement` 11560、`NOTICE.cs-movement` 625 | single（IIFE + WASM/Worker/MTZ base64 内嵌） | 上游许可证两份 |
| game | `app.js` 13531715、`index.html` 15616、`styles.css` 23874 | single | 无许可证文件 |
| viewer | `app.js` 5082436、`index.html` 6036、`styles.css` 19586、`play.cmd` 1528、`play.sh` 1634、`serve.py` 1985、`README.md` 4016、`.nojekyll` 0、`assets/maps/surf_null_4.replay` 53365 | single（唯一形态） | 自带启动脚本 + 自带服务器 + 自带说明 + 示例录像 |

三种 single 产物的「内嵌什么」也不一致（实测源码）：

- debug（`apps/debug/scripts/build-dist.mjs:110-116`）：内嵌 `__VBSP_WASM_B64__` + `__VBSP_WORKER_JS__` + `__VBSP_TEXTURES_MTZ_B64__`（三个全局）。
- game（`apps/game/scripts/build-dist.mjs:93-97`）：同样三个全局，但 MTZ 在 `:91` 直接从 `../../src/materials/textures.mtz` 读，且 `index.html` 用 `web/styles.css` 外置。
- viewer（`apps/viewer/scripts/build-dist.mjs:219-223`）：只内嵌 `__VBSP_WASM_B64__` + `__VBSP_WORKER_JS__`（**无** MTZ），并在 `:182` 先 `rm -rf dist` 全量重建。

只有 debug 的 single 会拷贝上游 Apache-2.0 许可证到 dist（`apps/debug/scripts/build-dist.mjs:136-137`），game 不会（`apps/game/scripts/build-dist.mjs` 无 `LICENSE.cs-movement` 写入）——但两家的 single 产物里都包含同一份 `@unsurf/cs-movement` 代码（debug 在 `:102-109` 显式拼上游许可证头，game 在 `:94` 只写自己的横幅）。

### 3.3 控制台输出模板对照（实测源码文案）

| 场景 | debug | game | viewer |
|---|---|---|---|
| 启动横幅 | `echo  WebSurf  Local Play (dist)`（`apps/debug/play.cmd:61`） | `echo  WebSurf-game  Local Play`（`apps/game/play.cmd:59`） | `echo  WebSurf-viewer local preview ^(close this window to stop^)`（`dist/play.cmd`，由 `apps/viewer/scripts/build-dist.mjs:130` 生成） |
| 步骤编号 | `[1/4]`…`[4/4]`（`apps/debug/play.cmd:25`、`:34`、`:44`、`:52`） | `[1/4]`…`[4/4]`（`apps/game/play.cmd:23`、`:32`、`:42`、`:50`） | 本工程自己的 `[N/M]` 编号是 `[1/3]`…`[3/3]`（`apps/viewer/play.cmd:26`、`:37`、`:59`），而它要调用的 `dist/play.cmd` 没有任何编号 |
| 服务地址行 | `Server:  http://localhost:%PORT%/` + `App:     http://localhost:%PORT%/dist/index.html`（`apps/debug/play.cmd:62-63`） | 同结构（`apps/game/play.cmd:60-61`） | `page    http://localhost:%PORT%/index.html` + `demo    …?replay=assets/maps/surf_null_4.replay`（`apps/viewer/scripts/build-dist.mjs:131-132`） |
| 失败前缀 | `[ERROR] …` | `[ERROR] …` / `*** ERROR: … ***`（`apps/game/build-dist.cmd:144`、`apps/viewer/build-dist.cmd:147`） | `[错误] …` / `[提示] …`（`apps/viewer/scripts/build-dist.mjs:77-78`、`apps/viewer/build-dist.cmd:70`） |
| 失败提示格式 | 英文短句 | 英文短句 | 中文长句 + 英文 `[WARN]`/`[INFO]` 混排（`apps/viewer/scripts/build-dist.mjs:114-118`） |

同一仓库里同时存在 `[ERROR]` / `*** ERROR: ***` / `[错误]` 三种失败前缀，且 viewer 的 `play.cmd` 混排中英文——这就是「启动文件的输出内容不一致」的直接来源。

### 3.4 `dist` 形态与 CI 的对齐（实测）

CI 的构建命令（`.github/workflows/deploy-pages.yml`）：

| 工程 | CI 构建命令 | 行号 |
|---|---|---|
| debug | `node scripts/build-dist.mjs --multi` | `:91` |
| game | `node scripts/build-dist.mjs --multi` | `:137` |
| viewer | `npm run build:dist`（single） | `:155` |

而三个 `build-dist.cmd` 全部只调 `node scripts/build-dist.mjs` / `call npm run build:dist`（默认 single），没有任何一处传 `--multi`，也没有 PowerShell/`.sh` 的 multi 入口。**结论**：本地一键脚本与 CI 产出的是两种不同形态的 dist，且 `--multi` 只能靠手敲 `node scripts/build-dist.mjs --multi`。

viewer 是 single-only 并不只是「没实现 multi」：它的 `dist/index.html` 走 classic `<script>`（`apps/viewer/scripts/build-dist.mjs:227-230` 把 `type="module"` 去掉），`dist/README.md` 与 `.nojekyll` 也是为静态托管/file:// 双击设计的。这条差异是**真实需求**，规范必须容纳而不是抹平。

## 4. 文件结构对照

### 4.1 目录级差异（实测）

| 目录/文件 | debug | game | viewer | harness | 证据 |
|---|---|---|---|---|---|
| `crates/wasm/` | 有 | 有 | 有 | 有 | `git ls-files apps/*/crates/wasm` |
| `src/` | 有 | 有 | 有 | 有 | 同上 |
| `scripts/` | 有（17 个 `.mjs`） | 有（17 个 `.mjs`） | 有（1 个 `.mjs` + `dist-README.md`） | 有（12 个 `.mjs`） | `git ls-files apps/*/scripts` |
| `web/` | 有（无 `styles.css`） | 有 | 有（无 `textures.mtz`） | 有（`index.html` 在工程根，非 `web/`） | §3.1 |
| `test/` | 无 | 无 | 有（`replay-selftest.ts`、`smoke-cdp.mjs`、`node-shims.d.ts`） | 无 | `git ls-files apps/viewer/test` |
| `fixtures/` | 有（1 个 784 KB 夹具） | 无 | 无 | 无 | `git ls-files apps/debug/fixtures` |
| `Cargo.toml` / `Cargo.lock` | 有 | 有 | 有 | 有 | 4 份模块 workspace |
| `package.json` / `package-lock.json` / `tsconfig.json` | 有 | 有 | 有 | 有 | 4 份 |
| `README.md` | 有（2967 B） | 有（6934 B） | 有（18504 B） | 有（13967 B） | `Get-ChildItem */README.md` |
| `pages-index.html` | 有（`scripts/` 下，1842 B） | 无 | 无 | 无 | 由 `.github/workflows/deploy-pages.yml:187` 拷为 `deploy/index.html` |

**两处约定违反（实测）**：

1. `apps/debug/tsconfig.json:26` 的 `include` 里含 `web/vendor`，而 `apps/debug/web/vendor` **不存在**（`$ Test-Path apps/debug/web/vendor` → `False`），是一处失效 include。
   **更正（2026-09-12，captain 实测）**：本条初稿写作「`apps/viewer/tsconfig.json:15` 与 `apps/game/tsconfig.json:15` 均把 `../../src/ts-shared/**/*.ts` 纳入 `include`；viewer 却零引用，于是白列一整套文件」——**上半句不成立**。逐文件实测：`apps/viewer/tsconfig.json:15` = `["src/**/*.ts","src/wasm.d.ts","test/**/*.ts"]`，**不含共享层**，与「零引用」自洽，属合规；`apps/game/tsconfig.json:15` 与 `apps/debug/tsconfig.json:26` 确实含 `../../src/ts-shared/**/*.ts`，且两者都有真实 import（口径 1：game 5 / debug 6），属正确配置。故「失效 include」在本仓库只有 `apps/debug/tsconfig.json:26` 的 `web/vendor` 一处，viewer 无配置冲突。
2. `apps/viewer/README.md:45` 写「本地地图副本放仓库根 `maps/`（gitignored）」，而 `$ Test-Path maps` → `False`，根 `README.md:43` 已明确写「本地地图统一放入 **`test/maps/`**（仓库根 `maps/` 已废弃）」——属遗留路径未清理。

### 4.2 同名文件的近重复度（实测）

`$ git diff --no-index --numstat <debug 文件> <game 文件>`：

| 同名文件 | 差异行（增/删） | 判定 |
|---|---|---|
| `src/world/pvs-manager.ts` | `2 2` | 仅 2 行 import 差异，**近全等** |
| `src/config.ts` | `79 157` | 大幅分叉 |
| `src/worker/worker-types.ts` | `97 244` | 大幅分叉 |
| `src/world/types.ts` | `6 203` | game 侧只留 685 B |
| `src/input/keyboard.ts` | `39 34` | 中等分叉 |
| `src/input/input-bridge.ts` | `53 71` | 中等分叉（debug v7 面板双端同步版 vs game 主线程→Worker 消息桥） |
| `src/worker/main.ts` | `35 88` | 中等分叉 |
| `src/renderer/renderer-main.ts` | `573 1192` | 大幅分叉 |
| `src/app.ts` | `639 2438` | 大幅分叉 |
| `src/wasm.d.ts` | `3 121` | debug 是手写契约桩（5622 B），game 只有 230 B re-export |

`src/world/pvs-manager.ts` 的完整差异（`$ git diff --no-index apps/debug/src/world/pvs-manager.ts apps/game/src/world/pvs-manager.ts`）：

```text
-import type { Vec3 } from '../physics/math/vec3.js';
-import { type WasmPvsData, type WasmPvsNode, type WasmPvsLeaf } from './types.js';
+import type { Vec3, WasmPvsData, WasmPvsNode, WasmPvsLeaf } from './types.js';
```

即：**同一份算法实现，只因 `Vec3` 与 WASM 类型在两个工程里分别来自不同模块**而各存一份。这是解耦裁决表必须覆盖的第一优先级候选（`Vec3` 在 `apps/debug/src/physics/math/vec3.ts` 也有 101 行私有实现，同一概念在仓库里有 3 处定义：`apps/debug/src/physics/math/vec3.ts`、`apps/debug/src/world/types.ts`、`apps/game/src/world/types.ts`）。

### 4.3 完全同字节的被追踪重复（实测）

`$ Get-FileHash -Algorithm SHA256` 实测：

| 文件对 | SHA256 前 16 位 | 字节 | 处置判定 |
|---|---|---|---|
| `apps/debug/Cargo.toml` vs `apps/game/Cargo.toml` | `E49CF9E3955D4F7F` 相同 | 各 925 | 各工程独立 workspace 清单，**建议保持** |
| `apps/debug/scripts/ensure-node-deps.cmd` vs `apps/game/scripts/ensure-node-deps.cmd` | `EAB3496C3F1EE6FB` 相同 | 各 1267 | 需裁决（见 I-15） |

`AGENTS.md` §7.2.1 把这两对记为「设计使然，建议保持现状」。实测复核：`Cargo.toml` 那一对**确实应保持**（`vmdl` 的 `[patch.crates-io]` 只对声明它的 workspace 生效，见 `Cargo.toml:17-18`）；`ensure-node-deps.cmd` 那一对**建议重新裁决**——它是纯自举逻辑（38 行、零工程特征），且 `src/scripts/` 已有 `cargo-env.cmd` 这个「共享构建工具」先例，与 Cargo workspace 清单的性质不同。

### 4.4 临时区实况（实测）

| 路径 | 实测状态 | 依据 |
|---|---|---|
| `apps/debug/.tmp/` | 不存在（本次跑完 `test:optimize-scene` 仍未留存，脚本自行创建并清理） | `$ Test-Path apps/debug/.tmp` → `False` |
| `apps/game/.tmp/` | 存在但**空** | `$ (Get-ChildItem apps/game/.tmp -Recurse).Count` → `0` |
| `apps/viewer/temp/` | 存在且含 1 个文件 `replay-selftest.mjs` | `$ (Get-ChildItem apps/viewer/temp -Recurse).Count` → `1` |
| 仓库根 `.tmp/`、`.cargo-home/`、`.wasm-pack-cache/` | 均不存在 | `$ Test-Path` → `False` 三次 |

`AGENTS.md` §3.3 的「常态应为空」与 `apps/viewer/temp/replay-selftest.mjs` 的**事实不符**（该文件是 `npm run test:replay` 的必然产物，且已被 `.gitignore` 覆盖：`$ git check-ignore -v apps/viewer/temp/x` → `apps/viewer/.gitignore:7:/temp/`）。这条不是规范违反（`viewer/temp/` 确属允许的临时区），而是「常态为空」这句话本身需要修正。

`$ git ls-files -- '**/temp/**' '**/.tmp/**'` → 空输出（临时区零入库，符合 AGENTS.md §3.4 检查清单）。

## 5. `src/` 共享层现状与消费矩阵

### 5.1 `src/` 顶层构成（实测）

| 路径 | 内容 | 文件数 | 字节（仅整文件者） |
|---|---|---|---|
| `src/phys/` | `mod.rs`、`world.rs`、`player.rs`、`teleport.rs`、`seed.rs`、`p2_gate_tests.rs` | 6 | 744（`mod.rs` 行数） |
| `src/wasm-core/` | `lib.rs`、`vbsp/`、`bsp_to_gltf_core/`、`model_integrator/`、`texture_utils/`、`mosaic/`、`pakfile_models.rs`、`phyfile.rs` | 25 | — |
| `src/ts-shared/` | `auth/`(8)、`decoupled/`(1)、`input/`(3)、`phys/`(3)、`tick/`(3) | 18（见 §5.2） | 6664（行） |
| `src/materials/` | `textures.mtz`（默认纹理包） | 1 | 5942995 |
| `src/vendor/vmdl/` | vendored 单副本（含 `Cargo.toml`、`LICENSE`） | 17 | — |
| `src/scripts/` | `cargo-env.cmd`、`check-doc-drift.mjs` | 2 | 1598 / 6803 |
| `src/` 根 | `Cargo.toml`（websurf-phys）、`lib.rs`、`.gitignore` | 3 | — |
| — | **合计** | **73** | — |

`src/scripts/` 里只有 2 个文件，却是全仓唯一的「共享构建工具」落点——这是判定「`ensure-node-deps.cmd` 该不该上提」时最直接的先例依据。

### 5.2 `src/ts-shared/` 文件与行数（实测）

行数口径与仓库体检工具一致（`src/scripts/check-doc-drift.mjs:35` 的 `wc`：按 `\n` 计数，即 `文件总行数 - 1`）：

| 模块 | 行数 | 说明 |
|---|---|---|
| `auth/auth-loop.ts` | 483 | 权威帧循环 |
| `auth/compute-mode.ts` | 128 | 三模式解析 |
| `auth/compute-mode.test.ts` | 116 | 测试 |
| `auth/shared-state.ts` | 1033 | 512B SAB 布局与 ShmState/MsgState |
| `auth/shared-state.protocol.test.ts` | 344 | 测试 |
| `auth/tick-authority.ts` | 618 | tick 权威 |
| `auth/tick-authority.test.ts` | 774 | 测试 |
| `auth/worker-dispatch.ts` | 489 | Worker 消息派发 |
| `decoupled/decoupled-loop.ts` | 448 | 解耦循环 |
| `input/input-layer.ts` | 40 | 灵敏度/等效鼠标量 |
| `input/mouse-buffer.ts` | 128 | 鼠标缓冲 |
| `input/pointer-lock.ts` | 154 | 指针锁定 |
| `phys/authority-calibrator.ts` | 668 | 权威校准 |
| `phys/params.ts` | 64 | 物理参数映射 |
| `phys/world-builder.ts` | 261 | world bundle 组装 |
| `tick/ordering-gate.ts` | 173 | 顺序门 |
| `tick/ordering-gate.test.ts` | 289 | 测试 |
| `tick/tick-consumer.ts` | 454 | 渲染侧消费 |
| — | **6664**（18 个文件） | 与既有事实「18 个文件」一致 |

### 5.3 共享层消费矩阵（实测，含 **更正**）

`$ node -e "…扫描 apps/{debug,game,viewer}/src 下全部 .ts：先剔除行首注释行，再只保留含 import/export … from '…ts-shared/…' 的语句行…"` 实测。**统计口径必须先声明，否则两个数字都对、却互相打架**——本节给三级口径，规范与复核一律引用 **口径 1**：

| 口径 | 定义 | 测量方式 | debug | game | viewer |
|---|---|---|---|---|---|
| **1（默认，规范用）** | 含 `import … from '…ts-shared/…'`（或 `export … from`）**语句**的文件 | 逐行剔除行首 `//`、`*`、`/*` 后再匹配 import 语句 | **6** | **5** | **0** |
| 2 | 文件正文任何位置出现 `ts-shared` 字面量（含纯注释） | 文件级 `includes('ts-shared')` | 10 | 6 | 0 |
| 3（已废弃，勿引用） | 正则 `from '…src/ts-shared/…'` 跨行贪婪匹配 | 早期草稿口径，会把多行 import 块拆成多个"文件" | 9 | 5 | 0 |

**更正**：任务描述给的既有事实是「引用共享层的 TS 文件数：debug 9、game 6、viewer 0」，其中 debug 9 与 game 6 都不对应任何自洽口径（9 来自口径 3 的跨行误匹配，6 来自口径 2 把注释算进去）。以口径 1 为准：**debug 6 / game 5 / viewer 0**。

口径 1 的完整消费清单（逐条实测，行号为该文件内的 import 行）：

| 工程 | 文件 | 行数 | 从 ts-shared 引入的模块 |
|---|---|---|---|
| debug | `apps/debug/src/app.ts` | 2487 | `input/mouse-buffer`(:9)、`input/pointer-lock`(:10)、`auth/shared-state`(:32,:33)、`input/input-layer`(:34)、`phys/world-builder`(:35,:36) |
| debug | `apps/debug/src/input/input-recorder.ts` | 759 | `auth/shared-state`(:45) |
| debug | `apps/debug/src/input/keyboard.ts` | 108 | `auth/shared-state`(:18) |
| debug | `apps/debug/src/physics/prediction-params.ts` | 48 | `phys/params`(:13) |
| debug | `apps/debug/src/renderer/renderer-main.ts` | 1710 | `auth/shared-state`(:19)、`phys/authority-calibrator`(:20) |
| debug | `apps/debug/src/worker/main.ts` | 497 | `auth/shared-state`(:27)、`auth/worker-dispatch`(:33)、`phys/params`(:34) |
| game | `apps/game/src/app.ts` | 688 | `input/mouse-buffer`(:18)、`input/pointer-lock`(:19)、`auth/shared-state`(:20)、`input/input-layer`(:21)、`phys/world-builder`(:22) |
| game | `apps/game/src/config.ts` | 181 | `phys/params`(:5) |
| game | `apps/game/src/input/keyboard.ts` | 113 | `auth/shared-state`(:11) |
| game | `apps/game/src/renderer/renderer-main.ts` | 1091 | `auth/shared-state`(:20)、`phys/authority-calibrator`(:21) |
| game | `apps/game/src/worker/main.ts` | 444 | `auth/shared-state`(:21)、`auth/worker-dispatch`(:27)、`phys/params`(:28) |

口径 2 比口径 1 多算的文件（全部是**纯注释提及**，不产生编译期依赖，规范不得据此判定「已接入共享层」）：

- debug 多 3 个：`apps/debug/src/game-state.ts:153`、`apps/debug/src/world/spawn-loader.ts:9,12,62,96`、`apps/debug/src/world/teleport-manager.ts:39`。
- game 多 1 个：`apps/game/src/worker/worker-types.ts:181`。

harness 侧（`test/dual-mode-harness/`，目录层级为 `src/` + `src/panel/` + `src/renderer/` + `src/worker/` 四层，统计必须递归否则会漏层）：

| 范围 | 口径 2（含 `ts-shared` 字面量） | 口径 1（真实 import 语句） |
|---|---|---|
| `src/**/*.ts`（共 11 个 `.ts`） | **8** | **7** |
| `scripts/**/*.mjs`（共 12 个 `.mjs`） | **5** | 不适用（脚本用注释与路径字符串引用） |
| `docs/**/*.md`（共 10 篇 md，含 `archive/` 5 篇） | **8** | 不适用 |

- 口径 1 的 7 个（`src/` 内）：`main.ts`、`shared-state.ts`、`renderer/tick-consumer.ts`、`renderer/tick-consumer.test.ts`、`worker-a.ts`、`worker-b.ts`、`worker/t4-chain.test.ts`。
- 口径 2 比口径 1 多 1 个：`panel/tick-telemetry-format.ts`（只有注释提及，不构成编译期依赖）。
- 口径 2 的 5 个脚本：`scripts/flicker-debug.mjs`、`scripts/perf-bench.mjs`、`scripts/phys-smoke.mjs`、`scripts/surf-e2e-verify.mjs`、`scripts/three-mode-verify.mjs`。
- 对照其他工程 `scripts/`：debug 4 个 `.mjs` 含该字面量（`auth-clock-verify.mjs`、`jump-apex-measure.mjs`、`jump-apex-serve.mjs`、`jump-apex-verify.mjs`），game 与 viewer 各 0 个。

viewer 为 0 这一条三级口径一致，且是**全工程级**的（`apps/viewer/README.md`、`apps/viewer/tsconfig.json`、`apps/viewer/package.json` 均无 `ts-shared`；`apps/viewer/tsconfig.json:15` 的 `include` 亦**不含**共享层，与零引用自洽）——**更正**：本条初稿称「viewer `tsconfig.json:15` 却把共享层纳入编译范围」，经逐文件实测不成立（见 §4.1 第 1 条更正）；viewer 属「正当隔离」，不存在失效配置。

### 5.4 Rust 侧共享消费（实测）

| 消费方 | 依赖 | 证据 |
|---|---|---|
| `apps/debug/crates/wasm` | `websurf-phys` + `websurf-wasm-core` | `apps/debug/crates/wasm/Cargo.toml:22,24` |
| `apps/game/crates/wasm` | `websurf-phys` + `websurf-wasm-core` | `apps/game/crates/wasm/Cargo.toml:22,24` |
| `apps/viewer/crates/wasm` | **仅** `websurf-wasm-core` | `apps/viewer/crates/wasm/Cargo.toml:19`（无 `websurf-phys`） |
| `test/dual-mode-harness/crates/wasm` | `websurf-phys` + `websurf-wasm-core` | `test/dual-mode-harness/crates/wasm/Cargo.toml:19,21` |

Rust 侧的解耦**已经完成**：解析层与物理层都是单副本共享，四个模块 crate 只留导出层。TS 侧只完成了一半（`src/ts-shared/` 覆盖 auth/input/phys/tick/decoupled，但 `pvs-manager`、`Vec3`、`config`、`worker-types`、渲染与打包逻辑仍在工程内各存一份）。

`vmdl` 的 vendored patch 在 5 个 `Cargo.toml` 里各声明一次（根 `Cargo.toml` 的第 28 行、`apps/{debug,game,viewer}/Cargo.toml` 的第 14 行、`test/dual-mode-harness/Cargo.toml`），这是 Cargo 语义决定的（`[patch]` 只对声明它的 workspace 生效），不可合并——规范应把这条写成**明示例外**，避免后续被当作重复实现清理。

### 5.5 依赖锁步（实测）

`$ Select-String '^name = "wasm-bindgen"$' -Context 0,2 <每份 Cargo.lock>`：

| lock | wasm-bindgen 版本 | 字节 |
|---|---|---|
| `Cargo.lock`（根） | `0.2.128` | 53280 |
| `apps/debug/Cargo.lock` | `0.2.128` | 54343 |
| `apps/game/Cargo.lock` | `0.2.128` | 54341 |
| `apps/viewer/Cargo.lock` | `0.2.128` | 52862 |
| `test/dual-mode-harness/Cargo.lock` | `0.2.128` | 53218 |

五份 lock 的 `wasm-bindgen` 版本锁步成立，与 CI 安装的 `wasm-bindgen-cli 0.2.128`（`.github/workflows/deploy-pages.yml:67`）一致。注意 `apps/debug` 与 `apps/game` 的 lock 字节数不同（54343 vs 54341），尽管 `Cargo.toml` 全等——说明两工程的实际解析结果**已经分叉**，锁步是「版本号一致」而不是「文件一致」。

## 6. 不一致清单

下表每行给出：现象、证据、判定（违反既有约定 / 需规范裁决 / 真实差异需豁免）。共 **22** 条（`I-01`..`I-22`），超出「至少 12 条」的要求。

### 6.1 违反 AGENTS.md 既有约定与待修缺陷（8 条）

| # | 现象 | 证据 | 被违反的约定 |
|---|---|---|---|
| I-01 | game 有 15 个脚本文件未被任何 npm script 引用（`phys-diag-flat`、`phys-dual-pipe`、`phys-gate-probe2`、`phys-p2-ground`、`phys-p2-regression`、`phys-p2-trace`、`phys-rate-parity`、`phys-rate-parity-v2`、`phys-teleport-gate`、`t13-input-surface-probe`、`t13-literal-sweep`、`t13-ulp-sensitivity-control`、`wasm-hash-pin`、`input-replay-verify` 等） | 实测：`apps/game/scripts/` 有 17 个 `.mjs`，`apps/game/package.json:17-18` 只注册 `test:phys`、`test:seed-smoke` 两个 | AGENTS.md §2「验证/回归脚本：该工程 `scripts/`，并**在 `package.json` 注册 `test:*`**」 |
| I-02 | 「验证脚本 = CI 门禁组成部分」这一定义与实现脱节：game 的 2 个、viewer 的 1 个验证脚本从未进 CI | `apps/game/package.json:17-18` 定义 `test:phys`、`test:seed-smoke`；`apps/viewer/package.json:11` 定义 `test:smoke`；`.github/workflows/deploy-pages.yml` 的 game 段落（`:121-137`）与 viewer 段落（`:139-159`）实测只有 `npm run test:replay`（`:159`），无任何 game 测试步骤、无 `test:smoke`。而 `CONTRIBUTING.md:38` 声称「以上脚本同为 CI 门禁的组成部分」，`README.md:59` 列举的 CI 门禁也只含 `test:replay` 与 `test:three-mode` | 二者必须改一个：或把未进 CI 的脚本从「门禁」表述中移出（仅本地可用），或把脚本补进 CI |
| I-03 | 两处脚本把仓库根算成 `apps/`（少一层 `..`） | `apps/debug/scripts/jump-apex-verify.mjs:36-39`：`DEBUG_DIR = join(HERE,'..')`、`REPO = join(DEBUG_DIR,'..')` → `REPO` 实际是 `apps/`；`apps/debug/scripts/jump-apex-serve.mjs:29-30,53` 同一处错误（`mirror(join(REPO,'src'), …)` 指向 `apps/src`） | AGENTS.md §6「移动或改名文件后……各工程相对依赖路径（`crates/wasm` → `../../../../src` 一类，**层数易错**）」 |
| I-04 | 失效配置：`include` 指向不存在的目录 | `apps/debug/tsconfig.json:26` 的 `include` 含 `web/vendor`；`$ Test-Path apps/debug/web/vendor` → `False` | AGENTS.md §5.3「所有相对链接必须指向真实存在的文件或目录」的同类原则（配置路径同罪） |
| I-05 | 文档遗留已废弃路径 | `apps/viewer/README.md:45`「本地地图副本放仓库根 `maps/`（gitignored）」；`$ Test-Path maps` → `False`；根 `README.md:43` 已声明根 `maps/` 废弃 | AGENTS.md §5.3「与代码不一致时以代码为准并回改文档」 |
| I-06 | `AGENTS.md:37` 的工程标准布局声称三工程都有 `start-dev.cmd`，实测 game/viewer/harness 均无 | `$ git ls-files "\*.cmd"` 实测结果中 `start-dev.cmd` 只出现一次：`apps/debug/start-dev.cmd`（§2.1 清单） | AGENTS.md §1.2 布局表 |
| I-22 | 共享工具的相对路径层数写错：`apps/debug/scripts/install-wasm-bindgen.cmd` 位于 `scripts/` 下，却只用两层上溯（`..\..\` 落在 `apps/`），`src/scripts/cargo-env.cmd` 永远调不到，该脚本内的 `CARGO_HOME` / `WASM_PACK_CACHE` / `WASM_BINDGEN` **全部为空** | 该文件第 19 行 `call "%~dp0..\..\src\scripts\cargo-env.cmd"`；全仓 `%~dp0` 路径逐条实测：本条解析为 `apps/src/scripts/cargo-env.cmd`（`$ Test-Path` → `False`），其余 12 条同款调用（`apps/debug/build-dist.cmd:21`、`apps/debug/play.cmd:17,71`、`apps/debug/start-dev.cmd:20,63`、`apps/game/play.cmd:17,69`、`apps/viewer/build-dist.cmd:54`、`apps/viewer/play.cmd:19`、`test/dual-mode-harness/play.cmd:37,72`）全部解析成功——它们都位于工程根，`..\..\` 层数正确。正确写法是 `..\..\..\src\scripts\cargo-env.cmd`（三层） | AGENTS.md §6「移动或改名文件后……各工程相对依赖路径（`crates/wasm` → `../../../../src` 一类，**层数易错**）」；与 I-03 同类 |
| I-21 | 上游 Apache-2.0 许可合规缺口：只有 debug 的 dist 拷贝许可证，game 的 dist（single 与 multi 皆然）不含任何 `LICENSE.*` / `NOTICE.*` | `apps/debug/scripts/build-dist.mjs:136-137` 拷贝 `LICENSE`/`NOTICE` → `dist/LICENSE.cs-movement`、`dist/NOTICE.cs-movement`（实测存在，11560 / 625 B）；`apps/game/dist/` 实测 3 项、无许可证文件，`apps/game/scripts/build-dist.mjs` 无对应代码，而 game 同样链接 `@unsurf/cs-movement` | 许可证合规是硬要求，不属「真实差异」，也不可豁免——按 §4.3 的分组应归入本节的**待修缺陷** |

### 6.2 需统一规范裁决（10 条）

| # | 现象 | 证据 | 需裁决的问题 |
|---|---|---|---|
| I-07 | 端口分配无文档且互相冲突：8080 被「三处 dev + harness play」同时占用 | 见 §2.2；`apps/debug/start-dev.cmd:11`（8080）、`test/dual-mode-harness/play.cmd:6`（8080）、四个 `npm run dev`（8080） | 是否建立固定端口表 + 冲突处理规则 |
| I-08 | `[N/M]` 步骤编号与横幅文案不一致（`[1/4]`/`[0/5]`/`[0/4]`/`[1/3]`）——**更正**：本条初稿末项写「无编号」，实测 `test/dual-mode-harness/play.cmd` **有**编号 `[1/3]`(:26)、`[2/3]`(:40)、`[3/3]`(:50)，五个入口的编号各写各的（`apps/debug/play.cmd` `/4`、`apps/debug/start-dev.cmd` `/3`、`apps/debug/build-dist.cmd` `/3`、`apps/game/build-dist.cmd` `/5`、`apps/viewer/build-dist.cmd` `/4`） | 见 §3.3 表 | 是否统一输出模板（含成功/失败逐字文案） |
| I-09 | 失败前缀三套：`[ERROR]` / `*** ERROR: ***` / `[错误]`——**更正**：本条初稿写「viewer 中英文混排」，实测 `apps/viewer/play.cmd` 为**纯 ASCII**（bytes >127 计数 = 0），中英混排实际出现在 `apps/viewer/scripts/build-dist.mjs` 与 `src/serve.py`，故问题性质是「**中文标记散落在构建脚本与共享脚本中**」，不是「viewer 入口中英混排」 | `apps/debug/play.cmd:31`（`[ERROR]`）、`apps/game/build-dist.cmd:144`（`*** ERROR: ***`）、`apps/viewer/build-dist.cmd:70`（`[ERROR]`）；中文标记实测 **9 处**：`apps/viewer/scripts/build-dist.mjs` **7 处**（:77、:78、:161、:163、:164、:168、:169）+ `src/serve.py` **2 处**（:52、:53）。**更正**：初稿把 `apps/viewer/build-dist.cmd:70` 列为 `[错误]` 出处——实测该文件 **0 处** `[错误]`/`[提示]` | 是否统一前缀与语言 |
| I-10 | 「谁提供 WASM 契约检查」四样（**批 2 已收敛**：执行记录见 [rollout-plan.md](rollout-plan.md) §4 的 B2-3）：debug「导出符号 vs TS 导入动态比对」（**薄配置 55 行 + 共享引擎**）、game「硬编码 16 + 17 个 API 名字」（**薄配置 99 行 + 共享引擎**）、viewer 缺失、harness「硬编码 12 个方法」（未收敛） | `apps/debug/scripts/check-wasm-api.mjs:40-42` 输出 `WASM 导出符号 (12)`（原 `:109-126`，D-03 收敛后该文件由 127 行削至 55 行）；`apps/game/scripts/check-wasm-api.mjs:30-69` 的 `EXPORT_API`（`:30-48`）/`PHYS_API`（`:51-69`）两数组（D-03 收敛后由 `:25-64` 移到 `:30-69`）；共享引擎 `src/scripts/lib/wasm-api-contract.mjs`（203 行，纯函数：`:54` `extractExportNames`、`:77` `extractExportsFromPkgJs`、`:88` `extractExportsFromDts`、`:102` `readDtsApiNames`、`:127` `assertDtsExports`、`:152` `assertTsImportsCoveredByExports`） | 是统一为一个共享脚本，还是承认「导出集不同 → 检查项天然不同」（**已裁定并与 D-03 一致**：共享引擎 + 各工程薄配置；引擎不 import 任何工程 `pkg/*`） |
| I-11 | `chcp 65001` 有无不一致 | §2.4 实测表 | 是否统一（`play.cmd` 两者无、`viewer/play.cmd` 有……实测：debug/game 的 play 无 `chcp`，viewer 的 play 有） |
| I-12 | Node 依赖引导三套：`ensure-node-deps.cmd`×2（字节全等）/ 内联 `if exist node_modules\esbuild` / 检测 `node_modules\.bin\tsc` | `apps/debug/build-dist.cmd:54`、`apps/viewer/build-dist.cmd:60`、`apps/debug/scripts/ensure-node-deps.cmd:13`、harness `play.cmd` 用 `node_modules\.bin\tsc` | 是否上提为 `src/scripts/ensure-node-deps.cmd` |
| I-13 | dist 形态（single/multi）在本地与 CI 不一致，且无 `--multi` 的本地入口 | §3.4；`.github/workflows/deploy-pages.yml:91,137,155` vs 三个 `build-dist.cmd` | 是否补 `build-dist-multi.cmd` / 参数化入口 |
| I-14 | viewer 的 `dist/` 自带 `play.cmd`+`play.sh`+`serve.py`+`README.md`+`.nojekyll`，debug/game 的 dist 都没有 | `apps/viewer/dist/` 实测 9 项 vs debug 4 项 / game 3 项（§3.2） | 这是否是规范要求（可交付产物自带启动器）还是工程特例 |
| I-15 | `ensure-node-deps.cmd` 字节全等重复两份（AGENTS.md §7.2.1 判「保持现状」） | SHA256 前 16 位均为 `EAB3496C3F1EE6FB`，各 1267 B | 需重新裁决：纯自举逻辑 + `src/scripts/` 已有先例 |
| I-16 | 端口占用行为不一致：viewer 的 `play.cmd` 检测到端口已监听就「复用已运行实例」并 `exit /b 0`，debug/game 不检测、直接起 `python serve.py` 撞端口报错 | `apps/viewer/play.cmd:51-56` 与 `:66`；`apps/debug/play.cmd:68-70` | 端口占用的统一行为是什么 |

### 6.3 真实差异（需规范显式豁免，4 条）

| # | 现象 | 证据 | 为何不能抹平 |
|---|---|---|---|
| I-17 | viewer 的 dist 只有 single（IIFE + base64 内嵌），无 `--multi` | `apps/viewer/scripts/build-dist.mjs:13` 注释「dist-multi / --multi / --bsp 分支已移除（2026-09：单一 dist 策略）」 | viewer 的定位是「纯观察 + file:// 双击可用」，无需 SAB/COOP，single 即最优 |
| I-18 | viewer 的 WASM 导出层不含 `websurf-phys` | `apps/viewer/crates/wasm/Cargo.toml:19` 只有 `websurf-wasm-core` | 无物理就无需求，硬加会白增体积与依赖 |
| I-19 | `apps/debug/web/` 无 `styles.css`（样式内联在 `index.html`） | `apps/debug/web/index.html:7` 起为 `<style>` | debug 页面是单文件调试页，内联反而更少请求 |
| I-20 | 三个工程 `web/` 的 wasm 存放位置不同（debug 无、game 有、viewer 有且异名） | §3.1 + §3.1 下的运行时 URL 表 | 由运行时加载路径决定（`../pkg/` vs `./` vs `import.meta.url`），需先统一加载路径才能统一产物位置 |

## 7. 既有约定覆核（AGENTS.md §1.2 / §2 / §3 / §6）

### 7.1 §1.2 标准布局覆核

| §1.2 条目 | debug | game | viewer | harness | 结论 |
|---|---|---|---|---|---|
| `crates/wasm/`（含 `Cargo.toml` + `src/lib.rs`） | 有 | 有 | 有 | 有 | 合规 |
| `src/`（含 `wasm.d.ts`） | 有 | 有 | 有 | 有 | 合规 |
| `scripts/`（含 `build-dist.mjs`） | 有 | 有 | 有 | 有 | 合规 |
| `web/`（`index.html`/`styles.css` 入库） | 缺 `styles.css` | 合规 | 合规 | 无 `web/` 目录 | **违反**（I-19、harness 例外） |
| `Cargo.toml`/`.lock` + `package.json` + `tsconfig.json` | 有 | 有 | 有 | 有 | 合规 |
| `play.cmd` / `build-dist.cmd` / `start-dev.cmd` 三件套 | 全有 | 缺 `start-dev.cmd` | 缺 `start-dev.cmd` | 缺 `build-dist.cmd`、`start-dev.cmd` | **违反**（I-06） |
| `README.md` | 有 | 有 | 有 | 有 | 合规 |

### 7.2 §2 新增文件归属覆核

| 条目 | 实测 | 结论 |
|---|---|---|
| 产品代码 TS 在 `apps/<app>/src/`；应共用逻辑上提 `src/ts-shared/` | `pvs-manager.ts` 两工程近全等（§4.2）、`Vec3` 三处定义 | **违反**（欠债，待 t3 裁决） |
| WASM 导出层只做导出，实现放共享 crate | 四个 `crates/wasm/src/lib.rs` 只做 `#[wasm_bindgen]` 导出 + re-export | 合规 |
| **禁止**在工程内复制共享实现 | Rust 侧合规；TS 侧 `pvs-manager.ts` | **部分违反** |
| 验证/回归脚本在本工程 `scripts/` 且注册 `test:*` | game 15 个未注册 | **违反**（I-01） |
| 编译器/环境脚本在 `src/scripts/` | `cargo-env.cmd` 在 `src/scripts/`，但 `ensure-node-deps.cmd` 复制两份在工程内 | **部分违反**（I-12、I-15） |
| 自动化夹具在 `apps/debug/fixtures/` | 唯一夹具 `apps/debug/fixtures/path/tick-on-render-prefix.json`（784 KB）在正确位置 | 合规 |

### 7.3 §3 临时区覆核

| 条目 | 实测 | 结论 |
|---|---|---|
| 只认 `**/temp/` 与 `**/.tmp/` | `git check-ignore` 实测两者都被覆盖 | 合规 |
| 产物不入库 | `git ls-files -- '**/temp/**' '**/.tmp/**'` → 空 | 合规 |
| 不得引用临时区路径 | `src/ts-shared/{auth,tick}/*.ts` 3 处引用 `temp/phys-plan-discuss/…`，均自带「2026-09 清理」标注（AGENTS.md §7.2.2 已记录） | 已记录，暂不判违反 |
| 临时区随时可被清空 | `apps/viewer/temp/` 现存 1 文件，`npm run test:replay` 可重建（本次实测 exit=0） | 合规 |
| 「常态应为空」 | `apps/viewer/temp/replay-selftest.mjs` 常驻 | **表述需修正**（§4.4） |

### 7.4 §6 工作流覆核（本次实跑的验证命令与退出码）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run typecheck`（四个工程各一次） | 全 `0` | 仅 `tsc --noEmit` 无输出 |
| `npm run build:ts`（debug / game / viewer） | 全 `0` | `web\worker.js 112.9kb` / `web\app.js 1.3mb`（debug）；`86.3kb`/`1.1mb`（game）；`18.0kb`/`1.1mb`（viewer） |
| `npm run check:api`（debug） | `0` | `WASM 导出符号 (12): …` / `TS 导入符号 (6): …` / `✅ F4 通过` |
| `npm run check:api`（game） | `0` | `✓ WASM 契约通过：导出 16 + 物理 17 API 全部存在。` |
| `npm run test:path-acceptance`（debug） | `0` | `门禁结果: FAIL（3 项）　期望: FAIL　→ 与期望一致`（刻意失败基线） |
| `npm run test:optimize-scene`（debug） | `0` | 通过 |
| `npm run test:auth-clock`（debug） | **`1`** | `[FAIL] dispatch 接线层覆盖（createWorkerDispatch 桩构造） — 无法构造依赖：Error: spawn EPERM`；其余 6 项 `[PASS]`；汇总 `6 passed, 1 failed`。该失败源于沙箱禁止子进程管道（§1.3），**不是仓库缺陷** |
| `npm run test:jump-apex`（debug） | **`1`** | `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\code\projects\websurf\apps\test\dual-mode-harness\pkg\websurf_test_wasm.js'` → **仓库真实缺陷**（I-03），CI 未覆盖该脚本故未被发现 |
| `npm run test:phys`（game） | `0` | 通过 |
| `npm run test:seed-smoke`（game） | `0` | 通过 |
| `npm run test:replay`（viewer） | `0` | 全部断言通过（含 V2/v6/v11 版本护栏） |
| `npm run test:smoke`（viewer） | **`1`** | `skip  dist/ 未构建（先 npm run build:dist）；跳过静态断言` + `执行中断：Runtime.enable 超时`：需要另开 `npm run dev` 与 Edge/Chromium（`apps/viewer/README.md:40-41` 已声明前提），本次未满足前置条件 |
| `npm run test:three-mode`（harness） | `0` | 通过 |
| `node src/scripts/check-doc-drift.mjs [任意参数]` | **`1`（沙箱限制，与参数无关）** | `Error: spawnSync git EPERM`（§1.3） |
| 单文件铁律自查（纯 `fs`，沙箱内可跑，**本文的正式验收命令**） | `0` | 见本节末尾的三行输出 |
| 等价替代（改读预生成文件列表，其余逻辑逐字不变） | `0` | `文档漂移体检：45 篇 md ｜ 行数声明 117（漂移 0）｜锚点 1431（越界 0）｜路径失效 1 ｜歧义未判 383`（首次全仓跑、本文尚未落盘时的结果）；唯一路径失效项是既有的 `documents/architecture.md:202` 引用的 `debug/docs/overview.md`。本文落盘后全仓复跑为 46 篇 / 135 声明 / 1533 锚点 / 漂移 0 / 越界 0 / 路径失效 1（同一条既有项）/ 歧义 387（新文档引入 4 处） |

`AGENTS.md` §7.1 第 11 项记录的基线是「117 条行数声明与 1428 个锚点零漂移/零越界（383 处跨工程裸文件名歧义）」。仅替换 git 调用后的本次实测（未含本审计文档）为 **117 声明 / 0 漂移**、**1431 锚点 / 0 越界**、**383 歧义**——声明数与歧义数完全一致，锚点数 +3 属本轮新增文档引用所致，零漂移结论**成立**。

单文件铁律自查实测（这是本文的正式验收命令，纯 `fs`、不 spawn 子进程，任何沙箱都能跑）：

```text
$ node -e "const fs=require('fs');const s=fs.readFileSync('documents/framework-audit.md','utf8');const bom=s.charCodeAt(0)===0xFEFF;const cr=/\r(?!\n)/.test(s);const tw=/\r?\n[ \t]+\r?\n/.test(s);console.log('BOM:',bom,'loneCR:',cr,'trailingWS:',tw);process.exit(bom||cr||tw?1:0)"
BOM: false loneCR: false trailingWS: false
exit=0
```

三项之外另行实测（同一纯 `fs` 思路）：`LF = CRLF = 567`、标题跳级 `0`、一级标题 `1`、代码围栏 `4`（成对）、表格列数异常 `0`、全部 `文件:行号` 锚点越界 `0`、相对链接 `0` 条故失效 `0`。

### 7.5 本次审计发现的**新增**失败（不在 AGENTS.md 台账中）

1. **I-03（真缺陷）**：`npm run test:jump-apex` 在干净检出上必然失败。该脚本未被 CI 运行（`.github/workflows/deploy-pages.yml` 无 `test:jump-apex`），因此 CI 绿不代表它可用。修复方向明确：`apps/debug/scripts/jump-apex-verify.mjs:36-39` 与 `apps/debug/scripts/jump-apex-serve.mjs:29-30,53` 各补一层 `..`。
2. **I-02（门禁缺口）**：game 有 `test:phys` / `test:seed-smoke` 两个注册脚本，`.github/workflows/deploy-pages.yml` 的 game 段落（`:121-137`）**完全没有** test 步骤；viewer 的 `test:smoke` 同样未进 CI。
3. **I-22（真缺陷，同 I-03 一类）**：`apps/debug/scripts/install-wasm-bindgen.cmd:19` 的 `%~dp0..\..\` 少一层，该脚本只能作为 `build-dist.cmd` / `start-dev.cmd` 的子步骤工作（父脚本已先设好环境），一旦按父脚本错误提示「run: scripts\install-wasm-bindgen.cmd」单独双击，下载与安装会落到盘根（`CACHE_DIR` = `\.wasm-bindgen-cargo-install-0.2.128\bin`）而不是仓库根的 `.wasm-pack-cache`，同时 `CARGO_HOME` 为空使 `copy` 静默失败——而该脚本第 101-104 行还会让用户 pause 后以为成功。
4. **I-21（合规缺口）**：game 的 single/multi dist 都不含 `LICENSE.cs-movement` / `NOTICE.cs-movement`，而它同样链接了 `@unsurf/cs-movement`（Apache-2.0）。

## 8. 规范需求条款

编号规则：`R-<n>`。每条都写成**能二值判定**的命题（判定方法给出可执行命令或 `文件:行号` 依据）。分组对应后续两份规范文档：启动方式 → `R-01..R-06`；文件结构 → `R-07..R-11`；产物与输出 → `R-12..R-17`；共享层解耦 → `R-18..R-21`。

### 8.1 启动方式（R-01 … R-06）

| 条款 | 命题（二值可判定） | 判定方法 |
|---|---|---|
| R-01 | 每个模块工程提供且仅提供三个 Windows 双击入口：`play.cmd`（跑已构建产物）、`start-dev.cmd`（跑 dev 源）、`build-dist.cmd`（构建 dist，不启动服务）；缺失者必须补，不允许「只有两个」或「多一个第四入口」 | `$ git ls-files 'apps/*/*.cmd'` 去重后每个工程恰好这 3 个 |
| R-02 | 端口按固定表分配且互不冲突：debug `start-dev`=8080、debug `play`=8081、game `play`=8137、viewer `play`=8090、harness `play`=8080（与 debug dev 同端口属刻意复用，须在规范中写明） | 逐文件 `Select-String 'set PORT='` 与固定表比对 |
| R-03 | 所有 `play.cmd` 接受可选首参 `[port]` 覆盖默认端口（当前仅 viewer 支持） | `apps/<app>/play.cmd` 含 `if not "%~1"=="" set PORT=%~1` |
| R-04 | 所有 `.cmd` 满足：行尾 CRLF、纯 ASCII（无 >127 字节）、无 BOM | `$ node -e "…统计 LF/CRLF 与 >127 字节…"` 全绿（当前 12/12 合规，见 §2.4） |
| R-05 | 端口被占用时行为统一为「复用已运行实例并打开浏览器，退出码 0」；若要改为「报错退出」，三工程必须一致 | 三份 `play.cmd` 的端口检查分支逐行比对 |
| R-06 | 双击入口的失败分支必须 `pause`（防闪退），非交互入口（`npm run *`）必须不 `pause` | 逐失败分支 `Select-String 'pause'`；`package.json` scripts 内无 `pause` |

### 8.2 文件结构（R-07 … R-11）

| 条款 | 命题 | 判定方法 |
|---|---|---|
| R-07 | 每个模块工程必含：`crates/wasm/{Cargo.toml,src/lib.rs}`、`src/`、`scripts/`、`web/{index.html,styles.css}`、`Cargo.toml`、`Cargo.lock`、`package.json`、`package-lock.json`、`tsconfig.json`、`README.md`。豁免项必须逐条列明（harness 无 `web/`；debug 无 `web/styles.css`） | 逐工程 `Test-Path` 清单比对，豁免项在规范中有条目 |
| R-08 | `tsconfig.json` 的 `include`/`exclude` 只允许指向真实存在的路径 | 解析 `tsconfig.json` 后逐个 `Test-Path`（当前 `apps/debug/tsconfig.json:26` 的 `web/vendor` 违反 → I-04） |
| R-09 | 引用共享层的工程必须在 `tsconfig.json` 里 `include` `../../src/ts-shared/**/*.ts`；**引用为 0 的工程不得 include** | 交叉核对「tsconfig include」与 §5.3 的消费矩阵（当前 viewer 违反） |
| R-10 | 验证脚本源码位置统一：工程内 `scripts/`（`.mjs`）或 `test/`（`.ts`，如需类型）；同一类脚本不得在两个工程用不同位置 | `git ls-files 'apps/*/scripts/*.mjs' 'apps/*/test/*.mjs'` 与类别清单比对 |
| R-11 | 临时区只允许 `apps/<app>/.tmp/`、`apps/<app>/temp/`、根 `.tmp/`；`package.json` 里写死输出路径的脚本必须用 `.tmp/`，且路径必须指向本工程内 | `Select-String 'outfile=' apps/*/package.json` 逐条解析目录归属 |

### 8.3 产物与输出（R-12 … R-17）

| 条款 | 命题 | 判定方法 |
|---|---|---|
| R-12 | 每个工程的 `package.json` 必备脚本名固定为：`build:wasm`、`build:ts`、`build:dist`、`typecheck`、`build`、`dev`；`build` 语义固定为 `build:wasm && build:ts` | 四份 `package.json` 的 scripts 键名与 `build` 值逐条比对（harness 缺 `build:app`/`build:worker` 须裁决：补或写豁免） |
| R-13 | 所有验证/回归脚本必须由某个 `test:*` 脚本可调用（`test:<名字>`），且名字在四工程内不冲突或冲突时语义相同 | `scripts/*.mjs` 清单与 scripts 键的引用关系求差集（当前 game 15 个、debug 若干未注册 → I-01） |
| R-14 | dev 模式下 WASM 的加载路径三工程统一（建议 `./websurf_*_wasm_bg.wasm` 相对页面目录，即把 wasm 拷进 `web/`）；统一后 `web/` 的产物清单也必须一致 | 三工程 `web/` 目录清单一致；运行时加载表达式在 `apps/*/src` 中只有一种形态（当前三种 → I-20） |
| R-15 | dist 形态按工程显式声明：调试/游戏工程必须同时提供 single 与 multi 的本地入口（`build-dist.cmd` 与 `--multi` 形式各一），viewer 声明为 single-only 并写豁免理由 | 每个工程存在可执行的 multi 入口（`node scripts/build-dist.mjs --multi` 或专用 `.cmd`）；viewer 在规范中有 explicit 豁免条目 |
| R-16 | 控制台输出模板逐字统一：启动横幅、`[N/M]` 步骤编号、地址行、成功横幅、失败提示前缀与语言。`[N/M]` 的 `M` 必须是该入口真实步骤数 | 按模板逐行 diff 三个 `play.cmd` 与三个 `build-dist.cmd` |
| R-17 | 任何打包进 dist 的第三方受许可证约束的代码，必须在 dist 内附对应 `LICENSE.*` / `NOTICE.*` | 逐工程 single/multi 产物清单均含对应许可证文件（当前仅 debug 有 → I-21） |

### 8.4 共享层解耦（R-18 … R-21）

| 条款 | 命题 | 判定方法 |
|---|---|---|
| R-18 | 同一算法/常量在仓库内只允许一份实现；判定「重复」的阈值为：两文件在剔除以工程为单位的 import 行后内容全等，或差异行数 ≤ 5 行 | 对候选对跑 `git diff --no-index --numstat`（当前 `pvs-manager.ts` 为 `2 2` → 必须上提） |
| R-19 | 纯自举/环境准备类 shell 脚本（不含工程特有产物名的）必须在 `src/scripts/` 单份提供，工程内不得存副本 | `git ls-files 'apps/*/scripts/*.cmd'` 中不得出现 `ensure-node-deps.cmd`、`cargo-env.cmd` 之类通用名（当前两份 `ensure-node-deps.cmd` 违反 → I-15） |
| R-20 | viewer 与共享层的关系必须显式声明为「正当隔离」或「欠债」：若为隔离，`tsconfig.json` 不得 include `ts-shared`；若为欠债，必须列出接入清单 | 交叉核对（**更正**：实测 `apps/viewer/tsconfig.json:15` 既未 include 共享层也无引用，条件互斥不成立 → viewer 现状**满足「正当隔离」分支**，R-20 判定为**当前合规**；初稿「既 include 又不引用」经实测不成立，见 §4.1 第 1 条更正、§5.3） |
| R-21 | 共享层的「不可合并重复」必须列为明示例外并给出理由：五份 `Cargo.toml` 的 `[patch.crates-io] vmdl`、四份 `Cargo.toml` 模块 workspace 清单、四份 `src/wasm.d.ts` | 规范中列出例外表，且每一项都有 Cargo/TS 语义级理由 |

条款与不一致项的覆盖关系：`R-01→I-06`、`R-02/R-05→I-07/I-16`、`R-03→I-16`、`R-04→（当前合规，防回归）`、`R-07→I-19`、`R-08→I-04`、`R-09/R-20→（**更正**：viewer 经逐文件实测为「正当隔离」且 `tsconfig.json:15` 未 include 共享层，两条均**当前合规**，改列为防回归）`、`R-10→I-14`、`R-11→（**更正**：`apps/viewer/package.json:10` 的 `test:replay` outfile 指向 `temp/`，而 `apps/viewer/.gitignore:7` 仅忽略 `/temp/`，实测 `apps/viewer/temp` 目录存在 → **违反**，须改 `.tmp/`；初稿「当前合规」不成立）`、`R-12→I-11`、`R-13→I-01/I-02`、`R-14→I-20`、`R-15→I-13/I-17`、`R-16→I-08/I-09/I-11`、`R-17→I-21`、`R-18→I-15/§4.2`、`R-19→I-12/I-15/I-22`、`R-21→I-18`。`I-03`、`I-10`、`I-22`（脚本相对路径层数与实现分叉）、`I-05`（文档遗留路径）不直接映射到 R 条款，属**本轮待修缺陷**与**待裁决项**，应由规范给出处置口径（`R-19` 已把 I-22 纳入——共享工具上提时必须同时修正调用方的上溯层数）。

## 9. 对下游任务的事实指引

1. `launch-standardizer`（启动/结构规范）：直接消费 §2、§3、§4 的表与 `R-01..R-17`；`R-04`、`R-11` 当前已合规，规范里应写成「防回归」而非「待修」。
2. `decoupling-architect`（解耦方案）：直接消费 §4.2、§4.3、§5；`pvs-manager.ts` 是唯一「近乎全等的 TS 重复实现」，`ensure-node-deps.cmd` 是唯一「近乎全等的 shell 重复实现」，两者判定依据不同（前者是算法重复，后者是自举逻辑重复），不要合并论证。`R-21` 的例外表必须先写，否则执行者会去动不该动的 Cargo 文件。
3. `framework-reviewer`（验证/复核）：`R-n` 的判定方法列已给出可执行命令；`npm run test:jump-apex` 的失败是本轮实测基线，复核时不要把它当作「新引入的回归」。
4. 本轮**只出规范、未改任何代码**：§6 的 22 条不一致（`I-01..I-22`）与 §7.5 的 4 项新增失败都仍是**待执行改造清单**，仓库代码状态与审计前一致（`$ git status --short` → 仅 `?? documents/framework-audit.md`）。
