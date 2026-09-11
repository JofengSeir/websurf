# WebSurf 启动方式、文件结构与产物统一规范

> 定位：`apps/{debug,game,viewer}` 三个应用工程与验证工程 `test/dual-mode-harness` 的**启动方式 / 文件结构 / 构建产物 / 控制台输出**统一规范。照本文件可以从零搭出一个符合规范的新子工程（§7）。
> 事实基线：[framework-audit.md](framework-audit.md)（t1 审计，含实测证据与 R-01…R-21 需求条款）。本文件逐条闭合 R-01…R-17，并对 R-18…R-21 给出交接口径（§9）。
> 本轮边界：**只写规范，未改任何代码 / `package.json` / `.cmd` / `Cargo.toml` / CI**。§10 的文件级动作是**待执行**清单，不代表仓库已改。 **【落地状态（收口 `t9` 追加，2026-09-12）】**：§10.1 的 24 项与 §10.3 的三步排期**已由批 1–4 全部执行完毕**，各批提交为 批 1 `6da49ae`/`fa5552e`/`4523ef1`、批 2 `fc3de84`、批 3 `32c2ddb` + `2135056`、批 4 `b5be059` ∪ `3b16366` 内的 TS/许可产物 ∪ `32c2ddb` 内的 2 篇文档；逐条处置表（含 C 类旧路径与未落地项）见 [rollout-status.md](rollout-status.md) §1–§5。未落地项**保持「待执行」**，不得据此认为已全部完成：§4.3 的 `test:smoke` 改名 `local:smoke`、harness 端口 `8110`（§2.3 判据④）与 §6.2 的 CI 收敛中的 viewer 侧改动属 `test/dual-mode-harness` 与本轮外范围，见该文档 R-1/R-2/R-11。
> 记号：**【必须】** 违反即缺陷；**【禁止】** 出现即缺陷；**【豁免】** 允许不同，但本文件必须有对应条目与理由。每条条文都带「判据」（可执行命令或 `文件:行号`）。

## 1. 定位、记号与边界

### 1.1 适用范围

| 类别 | 工程 | 本规范覆盖 |
|---|---|---|
| 应用工程 | `apps/debug/`、`apps/game/`、`apps/viewer/` | R-01…R-17 全部条文，三件套入口、端口表、输出模板、产物清单 |
| 验证工程 | `test/dual-mode-harness/` | §2.2 入口集合【豁免】；§2.3 端口、§2.4/§2.5 骨架与词表、§3.1 结构、§4.2 脚本键、§5 产物的适用条文 |
| 共享层 | `src/` | 只规定**调用点、命名与相对路径层数**（§3.3）；内容归属见 §1.3 |

### 1.2 记号与占位符

| 记号 | 含义 | 取值 |
|---|---|---|
| `<app>` | 应用工程名 | `debug`、`game`、`viewer` |
| `<seg>` | 工程端口段基址 | §2.3 表，`8080`/`8090`/`8100`/`8110` |
| `<wasm>` | 该工程 wasm 产物文件名（`pkg/<crate>_bg.wasm` 的 basename） | `websurf_wasm_bg.wasm`（debug、game）、`websurf_viewer_wasm_bg.wasm`（viewer） |
| `[N/M]` | 步骤进度行 | `N` = 该入口的最后一步号 |

### 1.3 与解耦文档的边界

- `src/` 共享层「什么该上提、什么必须留在工程内」由 [framework-decoupling.md](framework-decoupling.md)（t3 产出，**已落盘**）裁决，即 R-18…R-21；其 §1.3 列出与本文的 4 处冲突（C-1…C-4）及逐条处置。
- 本文件只固定共享工具的**调用点与命名**（例如「`package.json` 必须存在 `check:api`」）与**相对路径层数规则**（§3.3），不规定共享文件的物理落点；落点按解耦文档的裁决执行（本文已据此回改 §2.5.6、§3.1、§3.6、§5.3、§7.1、§7.2、§10.1 第 10/11/12/13/19/20 条）。
- 冲突时的优先级：共享层**内容归属**以解耦文档为准；**入口 / 结构 / 端口 / 输出**以本文件为准。任一冲突处必须在两份文档中各写一条交叉引用；本文件侧的交叉引用即上一条列出的 7 处，对应 [framework-decoupling.md](framework-decoupling.md) §1.3 C-1…C-4、§3.2 D-01/D-02/D-03/D-04/D-06、§6.2 T-01/T-02。

## 2. 统一启动入口（R-01、R-02、R-03、R-04、R-05、R-06、R-16）

### 2.1 现状（实测）

| 入口 | debug | game | viewer | harness |
|---|---|---|---|---|
| `play.cmd` | 有，端口 `8081`，`[1/4]`…`[4/4]` | 有，端口 `8137`，`[1/4]`…`[4/4]` | 有，端口 `8090`，支持 `[port]`，`[1/3]`…`[3/3]` | 有，端口 `8080`，`[1/3]`…`[3/3]` |
| `start-dev.cmd` | 有，端口 `8080`，`[1/3]`…`[3/3]` | **无** | **无** | **无** |
| `build-dist.cmd` | 有，`[1/3]`…`[3/3]`，无工具链检查 | 有，`[0/5]`…`[5/5]` | 有，`[0/4]`…`[4/4]` | **无** |
| `npm run dev` 端口 | `8080` | `8080` | `8080` | `8080` |
| 端口占用行为 | 不检测（`play`）／复用+`cmd /k`（`start-dev`） | 不检测 | 复用并 `exit /b 0` | 不检测 |
| 失败前缀 | `[ERROR]` | `[ERROR]` + `*** ERROR: ***` | `.cmd` 为 `[ERROR]`（文件纯 ASCII，>127 字节计数 0）；`[错误]`/`[提示]` 仅出现在其 `scripts/build-dist.mjs` 的生成物模板内（7 处） | `[ERROR]`（`.cmd` 纯 ASCII） |

证据：各 `.cmd` 实测文本（`apps/*/play.cmd`、`apps/*/build-dist.cmd`、`apps/debug/start-dev.cmd`）与 [framework-audit.md](framework-audit.md) §2、§3.3；三工程 `npm run dev` 逐字为 `python ../../src/serve.py 8080 .`（`apps/debug/package.json:15`、`apps/game/package.json:15`、`apps/viewer/package.json:17`、`test/dual-mode-harness/package.json:13`）。

### 2.2 入口集合与语义（R-01）

每个应用工程**【必须】**提供且仅提供三个双击入口，文件名逐字固定：

| 入口 | 语义 | 服务目标 | 成功退出码 | 失败退出码 |
|---|---|---|---|---|
| `play.cmd [port]` | 补齐缺失产物（deps → wasm → ts → dist）后，服务 **dist** 页面并打开浏览器 | `dist/index.html`（viewer 为 `dist/` 根的 `index.html`） | 0 | 1 |
| `start-dev.cmd [port]` | 只构建 TS（不产 dist），服务 **web/** 源页面并打开浏览器 | `web/index.html` | 0 | 1 |
| `build-dist.cmd [single\|multi]` | 只构建 dist，**不**启动服务 | 无 | 0 | 1 |

- **【禁止】**第四个 `.cmd` 入口；multi 形态只能由 `build-dist.cmd multi` 表达，**禁止**新增 `build-dist-multi.cmd`、`play-dev.cmd` 之类平行入口。
- **【禁止】**收到不支持的参数时静默忽略：必须打印 `[ERROR]` 行并以退出码 1 结束（例如 viewer 的 `build-dist.cmd multi`）。
- `start-dev.cmd` 的必要性判据（**不是**「默认都加」）：同时满足三条才要求提供——① `web/index.html` 入库且为 dev 目标页；② dev 与 dist 的 WASM 加载路径**不同**（dev 外置文件、dist 内嵌 base64）；③ 工程有 `build:ts` 产出 `web/app.js`。
  实测：三工程 ①③ 均成立；② 逐工程成立（debug 走 `../pkg/websurf_wasm_bg.wasm`、game 走 `./websurf_wasm_bg.wasm`、viewer 走 `import.meta.url`，而三者 dist 均为 base64 内嵌）→ **三工程都必须提供 `start-dev.cmd`**。若某工程未来让 dev 与 dist 复用同一加载路径（② 不成立），必须先在本文件 §3.2 登记豁免，才允许删除该入口。
- **【豁免】**验证工程 `test/dual-mode-harness/`：无 `web/` 目录（实测 `Test-Path test/dual-mode-harness/web` → `False`），其 `play.cmd` 服务工程根 `index.html`（`test/dual-mode-harness/play.cmd:72`），**不要求** `start-dev.cmd` 与 `build-dist.cmd`，也不得新增（避免为验证工程制造双份入口）。
- 判据：`git ls-files '*.cmd'` 去重后，每个应用工程恰好含 `play.cmd`、`start-dev.cmd`、`build-dist.cmd` 三个工程根入口（`scripts/*.cmd` 为子脚本，不计入）。

### 2.3 端口与路由分配表（R-02、R-03、R-05）

端口按「每个模块工程占一个 10 端口段」确定性分配，段内槽位固定：

| 工程 | 段基址 `<seg>` | `start-dev.cmd` / `npm run dev`（槽位 +0） | `play.cmd`（槽位 +1） | 预留（槽位 +2） |
|---|---|---|---|---|
| `apps/debug/` | `8080` | `8080` → `http://localhost:8080/web/index.html` | `8081` → `http://localhost:8081/dist/index.html` | `8082` |
| `apps/game/` | `8090` | `8090` → `http://localhost:8090/web/index.html` | `8091` → `http://localhost:8091/dist/index.html` | `8092` |
| `apps/viewer/` | `8100` | `8100` → `http://localhost:8100/web/index.html` | `8101` → `http://localhost:8101/index.html` | `8102` |
| `test/dual-mode-harness/` | `8110` | `8110`（与 `play` 共用，【豁免】见下） | `8110` → `http://localhost:8110/index.html` | `8111` |

新旧对照（本表**取代**现行的无文档分配）：

| 入口 | 现行 | 规范值 | 变化 |
|---|---|---|---|
| debug `start-dev` / `npm run dev` | `8080` | `8080` | 不变 |
| debug `play` | `8081` | `8081` | 不变 |
| game `play` | `8137` | `8091` | **改** |
| game `npm run dev` | `8080` | `8090` | **改** |
| viewer `play` | `8090` | `8101` | **改**（`8090` 让位给 game 段） |
| viewer `npm run dev` | `8080` | `8100` | **改** |
| harness `play` | `8080` | `8110` | **改**（解除与 debug dev 的抢占） |

条文：

- **【必须】**`npm run dev` 与 `start-dev.cmd` 使用同一端口、同一目标页（`web/index.html`）；`dev` 的值逐字为 `python ../../src/serve.py <seg> .`。
- **【必须】**`play.cmd` 与 `start-dev.cmd` 接受可选首参 `[port]` 覆盖默认端口，逐字为 `if not "%~1"=="" set PORT=%~1`；覆盖后走同一套端口占用检测。
- **【必须】**服务型入口在启动前检测端口占用，检测命令逐字固定为 `netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1`，失败分支为 `goto :start_server`。
- **【必须】**端口已被监听时的统一行为：打印 §2.5.5 的 `[SKIP]` 行 → 打开浏览器 → `exit /b 0`（不 `pause`、不重复启动服务）。
- **【禁止】**同一工程的两个默认入口使用同一默认端口。**【豁免】**harness 的 `dev` 与 `play` 同为 `8110`（同一页面、互斥运行，且该工程不部署）。
- **【必须】**新增工程按「未被占用的最小 10 端口段」取 `<seg>`，并在本表登记。
- 判据（全部用精确匹配，**禁止**用 `localhost:80` 这类会命中全部 80xx 端口的前缀）：① `git grep -nE "set PORT=[0-9]+" -- apps test/dual-mode-harness` 的取值集合必须逐条等于本表；② `git grep -nE "serve\.py [0-9]+" -- apps test/dual-mode-harness` 同上；③ `git grep -nE "localhost:(8081|8082|8090|8091|8092|8100|8101|8102|8110|8111)([^0-9]|$)" -- apps test README.md` 只允许出现本表端口；④ **已退役端口 `8137` 零命中**：`git grep -n "8137" -- apps test README.md .github ':!apps/debug/fixtures'` 空输出（本文件 §2.3 的新旧对照表与 §10 改造清单不在判据范围内；**必须排除测试夹具** `apps/debug/fixtures/path/tick-on-render-prefix.json` —— 该文件为**单行 783,985 B（约 784 KB）**的录制夹具，含 **29 处浮点尾数子串 `8137`**（无 `"port"` 键，与端口无关）；不排除则本判据无法字面达成：排除前 **1 行命中（该行内含 29 处 `8137`）**，排除后 **0 命中、`git grep` 退出码 1**）。

### 2.4 `.cmd` 骨架、共享调用与工具链检查（R-04）

#### 2.4.1 统一头部（逐字，文件前 5 行）

```bat
@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-<app> - <Play|Dev Server|Build dist>
cd /d "%~dp0"
```

- **【必须】**所有 `.cmd`：行尾 CRLF、纯 ASCII（无 >127 字节）、无 BOM。`chcp 65001` 保留的理由：`.mjs` 子进程的中文输出需要 UTF-8 代码页，`.cmd` 自身仍保持纯 ASCII。
- **【必须】**`title` 逐字为 `WebSurf-<app> - Play`、`WebSurf-<app> - Dev Server`、`WebSurf-<app> - Build dist`（debug/game/viewer 三份同名同形）。
- **【禁止】**`.cmd` 内出现非 ASCII 字符（含中文注释、中文提示）；【禁止】`.cmd` 行尾为 LF。

#### 2.4.2 共享层调用（逐字）

```bat
call "%~dp0..\..\src\scripts\cargo-env.cmd"
```

- **【必须】**每个服务/构建入口在第一次构建动作之前调用一次 `cargo-env.cmd`（唯一例外：`build-dist.cmd` 的调用点在其 WASM 步骤之前）。
- 工程根入口用 `%~dp0..\..\`（工程根 → 仓库根）；`apps/<app>/scripts/` 下的子脚本必须用 `%~dp0..\..\..\`——层数规则与全层级对照见 §3.3。
- **【必须】**调用工程脚本用 `call node "%~dp0scripts\<name>.mjs"`（不经 npm）；调用 npm 官方脚本用 `call npm run <name>`；两种情况都必须带 `call`（缺 `call` 会终止父批处理）。
- **【必须】**`package.json` 的 `build:dist` 值与 `.cmd` 调用的脚本同源，逐字为 `node scripts/build-dist.mjs`。
- 判据：`git grep -nE "^\s*(npm run|node )" -- 'apps/*/*.cmd' 'apps/*/scripts/*.cmd'` 的输出全部带 `call ` 前缀。

#### 2.4.3 工具链检查

| 入口 | 必须检查 | 成功时的逐字输出 | 失败处理 |
|---|---|---|---|
| `play.cmd`、`start-dev.cmd` | `python`（服务器依赖） | 无输出（静默通过） | `where python >nul 2>nul` 失败 → §2.5.2 的 python 失败块 |
| `build-dist.cmd` | `npm`、`wasm-pack`、`node`（顺序固定） | `  npm: OK` / `  wasm-pack: OK` / `  node: OK` | 逐项 `  [!] <tool> not found. <安装提示>`，随后 `[ERROR] Toolchain incomplete.` 块 |

- **【必须】**`build-dist.cmd` 的 `[0/N] Checking toolchain...` 段必须先于任何安装/构建动作。
- **【禁止】**`play.cmd`、`start-dev.cmd` 检查 `wasm-pack`（WASM 缺失时才需要，已有独立失败分支）。
- 判据：`git grep -n "where wasm-pack" -- 'apps/*/play.cmd' 'apps/*/start-dev.cmd'` 空输出——只检测**命令调用**是否出现，不检测文本出现；`[HINT]` 文案中出现 `wasm-pack` 字样（§2.5.2、§2.5.4 的强制文案）**不算违反**。另一半：`git grep -n "Checking toolchain" -- 'apps/*/build-dist.cmd'` 三份命中。

### 2.5 控制台输出逐字模板（R-16）

#### 2.5.1 标记词表（唯一允许）

| 标记 | 用途 | 允许出现的输出源 |
|---|---|---|
| `[<n>/N] ` | 步骤进度行（`n` 从 0 或 1 起连续，`N` = 最后一步号） | `.cmd`、被 `.cmd` 调用的 `.mjs`/`.py` |
| `[ERROR] ` | 顶层失败 | 同上 |
| `[HINT] ` | 失败后的可执行动作 | 同上 |
| `[WARN] ` | 不阻断的异常 | 同上 |
| `[INFO] ` | 补充信息 | 同上 |
| `[SKIP] ` | 跳过动作（端口复用等） | 同上 |
| `  [!] ` | 工具链逐项缺失（两空格缩进，**仅** §2.4.3 的 `[0/N]` 段） | `build-dist.cmd` |

- **【登记例外（补 §2.5.1 词表）】**上表声明「唯一允许」，但共享脚本现有两组前缀未入表（批 2 产物，属 F-2 跟踪项）。本文件**只登记例外并扩展判据，不改 `src/scripts/*.cmd`**：
  - `[deps] …` —— 来自 `src/scripts/ensure-node-deps.cmd`（文件内 **11 处** `echo [deps]`）。实测：`tsc` 已存在的常见路径向六个入口**各注入 5 行**（2 行 `[deps] ` + 60 个 `=` 分隔线、3 行文本）；`npm install` 分支另注入 4 行。**【更正】**t11 报告记为「6 行」，本轮实跑复测为 **5 行**（命令与输出见提交说明），以实测为准。
  - `[wasm-bindgen] …` —— 来自 `src/scripts/install-wasm-bindgen.cmd`（**18 处发射点** = 16 × `echo` + 2 × PowerShell `Write-Host`）。仅 debug 的 WASM 步骤执行时注入（`pkg/<wasm>` 已存在则不调用）；已装路径输出 **2 行**（按代码分支判定，未实跑以避免触发网络下载）。
  - **【约定方向】**按词表应归一为 `[INFO]`（`deps`/`wasm-bindgen` 保留为正文前缀、去掉方括号形式）；归一落地后**必须同时**把下方判据白名单里的 `deps|wasm-bindgen` 删除——例外自闭合，不留长期豁免。
  - **【影响面：诉求④（输出一致）】**`[deps]` 的 5 行直接进入三工程六个入口的真实控制台输出，`t11` 的逐字比对确认它与 §2.5.2/§2.5.3/§2.5.4 逐字模板的**差异清单只有这 1 项** —— 即「输出一致」当前唯一的未闭合点；`[wasm-bindgen]` 仅在该步骤执行时出现，属同族但触发面更小。

- **【禁止】**词表外标记：`*** ERROR: ***`、裸 `ERROR:`、`[错误]`、`[提示]`、`[warn]`、`[!]`（无缩进）等。
- **【禁止】**`.cmd` 输出非 ASCII；由 `.cmd` 调用的 `.mjs`/`.py` 正文可用中文，但标记必须取自词表。
- **【必须】**分隔线统一为 60 个 `=`，逐字为 `============================================================`。
- **【必须】**每个 `[ERROR]` 后紧跟**恰好一条** `[HINT]`（诊断动作必须是可执行的单行命令或单步操作）。
- 判据（**白名单式**，取代原先的黑名单列举——黑名单永远追不上新增项；白名单 = 词表 ∪ 上面的两个登记例外）：
  - ① **`.cmd` echo 侧（可即时运行）**：`git grep -hoE 'echo[[:space:]]+\[[^]]+\]' -- 'apps/*/*.cmd' 'apps/*/scripts/*.cmd' 'src/scripts/*.cmd' | sed -E 's/.*(\[[^]]+\])/\1/' | sort -u | grep -vE '^\[([0-9]+/[0-9]+|ERROR|HINT|WARN|INFO|SKIP|!|deps|wasm-bindgen)\]$'` **空输出**即通过（注意：`grep -v` 无匹配时退出码为 1，故以**输出是否为空**为准、不看退出码；无可用 bash 时按同一规则用 node 按字节读实现等价判据）。实测（当前树）：抽出标记 **20 个 = 词表 18 + 登记例外 2**，**词表外 0**；把 `deps|wasm-bindgen` 从白名单移除后立即报 2 个 → 证明例外确实在判据中生效、而非静默放行。
  - ② **入口输出侧（行首标记，白名单）**：对三工程六个入口的**真实控制台输出**逐行取行首标记 `^\s*\[[^]]+\]`（含两空格缩进的 `  [!]`），必须落在同一白名单内，否则为缺陷；采集法见 §3.5（本机实跑，或「进程内 PATH 桩 + 忠实副本」）。`t11` 实测：**唯一表外标记 = 5 行 `[deps] …`**（已登记为例外），其余**全部**命中词表——即诉求④的未闭合点，详见上面的【影响面】。
  - ③ 旧标记清零（保留为防回归）：`git grep -nE "\*\*\* ERROR|\[错误\]|\[提示\]|\[warn\]" -- apps src` 空输出（**目标：全仓 0 命中**；批 3 `32c2ddb`/`2135056` 后实测**已 0 命中**——判据保留为防回归；改造前为 `apps/viewer/scripts/build-dist.mjs` 7 处 + `src/serve.py` 2 处，处置见 §2.7 与 §10.1 第 10 条；`apps/*/play.cmd` 零命中）。
- **【必须】**块内 echo 的括号转义校验必须以块深度追踪或探针实跑为准，不得用「行内是否含未转义括号」的静态判据（对 9 个 .cmd 会给出 11 处误报，命中行块深度均为 0）。

#### 2.5.2 `play.cmd` 输出清单（逐字，N=4）

```text
[1/4] Ensuring Node build dependencies (auto npm install if missing)...
[2/4] WASM missing - building (release, slow on first run; Rust toolchain required)...
[2/4] WASM ready.
[3/4] Building TypeScript (worker.js + app.js)...
[4/4] Building dist package (single, embedded WASM - always fresh)...
============================================================
  WebSurf-<app> - Local Play (dist)
  Server:  http://localhost:%PORT%/
  App:     http://localhost:%PORT%/dist/index.html
  Close this window to stop the server.
============================================================
```

- **【必须】**`App:` 行按 §2.3 表：debug/game 为 `http://localhost:%PORT%/dist/index.html`，viewer 为 `http://localhost:%PORT%/index.html`。
- **【必须】**`[2/4]` 步骤整体可跳过：`pkg/<wasm>` 已存在时只打印 `[2/4] WASM ready.`（不得打印半截进度行）。
- 失败分支（逐字两行 + `pause` + `exit /b 1`）：

| 触发 | 逐字输出 |
|---|---|
| `where python` 失败 | `[ERROR] Python not found.` / `[HINT] Install Python 3 and make sure "python" is on PATH.` |
| `ensure-node-deps.cmd` 失败 | `[ERROR] npm install failed.` / `[HINT] Check network connectivity and package-lock.json, then retry.` |
| `npm run build:wasm` 失败 | `[ERROR] WASM build failed.` / `[HINT] Install Rust and wasm-pack ^(rustup + cargo install wasm-pack^), then retry.` |
| `npm run build:ts` 失败 | `[ERROR] TypeScript build failed.` / `[HINT] Fix the tsc/esbuild errors printed above, then retry.` |
| `scripts/build-dist.mjs` 失败 | `[ERROR] dist build failed.` / `[HINT] See the build-dist.mjs errors printed above, then retry.` |

#### 2.5.3 `start-dev.cmd` 输出清单（逐字，N=3）

```text
[1/3] Building WASM (release)...
[1/3] WASM ready.
[2/3] Ensuring Node build dependencies (auto npm install if missing)...
[2/3] Building TypeScript (worker.js + app.js)...
[3/3] Starting HTTP server...
============================================================
  WebSurf-<app> - Dev Server (web/)
  Server:  http://localhost:%PORT%/
  App:     http://localhost:%PORT%/web/index.html
  Close this window to stop the server.
============================================================
```

- 失败分支：与 §2.5.2 相同四条（python / npm / WASM / TS），**不含** dist 分支；`[1/3]` 步骤在 `pkg/<wasm>` 已存在时同样只打印就绪行。
- 服务必须前台运行（§2.6）；**【禁止】**`start "" python …` + `cmd /k` 组合。

#### 2.5.4 `build-dist.cmd` 输出清单（逐字，N=5）

```text
[0/5] Checking toolchain...
  npm: OK
  wasm-pack: OK
  node: OK
[1/5] Ensuring Node build dependencies (auto npm install if missing)...
[1/5] Node dependencies ready.
[2/5] Building WASM (release)...
[2/5] WASM ready (release).
[3/5] Checking WASM API contract...
[4/5] Building TypeScript (worker.js + app.js)...
[5/5] Building dist package...
============================================================
  WebSurf-<app> - Build dist package: complete
  Output:  dist/ (mode: <single|multi>)
  Run:     play.cmd
============================================================
```

- **【必须】**末行按形态二选一（逐字）：single → `  Note:    file:// double-click works (WASM embedded).`；multi → `  Note:    multi mode needs the local HTTP server (play.cmd).`
- 失败分支（逐字两行 + `pause` + `exit /b 1`），括号内为触发点：

| 触发 | 逐字输出 |
|---|---|
| 工具链（§2.4.3） | `[ERROR] Toolchain incomplete.` / `[HINT] Install Node.js ^(npm + node^) and wasm-pack, then retry.` |
| `ensure-node-deps.cmd` 失败 | `[ERROR] npm install failed.` / `[HINT] Check network connectivity and package-lock.json, then retry.` |
| `npm run build:wasm` 失败 | `[ERROR] WASM build failed.` / `[HINT] Delete crates\wasm\target\wasm32-unknown-unknown and retry ^(antivirus locks are the usual cause^).` |
| `npm run check:api` 失败 | `[ERROR] WASM API contract check failed.` / `[HINT] Run npm run check:api, fix src/wasm.d.ts vs crates/wasm, then retry.` |
| `npm run build:ts` 失败 | `[ERROR] TypeScript build failed.` / `[HINT] Fix the tsc/esbuild errors printed above, then retry.` |
| `scripts/build-dist.mjs` 失败 | `[ERROR] dist build failed.` / `[HINT] See the build-dist.mjs errors printed above, then retry.` |

#### 2.5.5 端口复用块（`play.cmd`/`start-dev.cmd` 共用，逐字）

```text
[SKIP] Port %PORT% is already in use - opening the browser to the running server.
```

#### 2.5.6 可直接复制的 `build-dist.cmd` 全文（ASCII，CRLF）

```bat
@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WebSurf-<app> - Build dist
cd /d "%~dp0"

set "DIST_MODE=single"
if /i "%~1"=="multi" set "DIST_MODE=multi"
if /i "%~1"=="" goto :mode_ok
if /i "%~1"=="single" goto :mode_ok
if /i "%~1"=="multi" goto :mode_ok
echo [ERROR] Unsupported argument: %~1
echo [HINT] Usage: build-dist.cmd [single^|multi]
pause
exit /b 1
:mode_ok

echo [0/5] Checking toolchain...
set "TOOLCHAIN_OK=1"
where npm >nul 2>nul
if errorlevel 1 (echo   [!] npm not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   npm: OK)
where wasm-pack >nul 2>nul
if errorlevel 1 (echo   [!] wasm-pack not found. Install with: cargo install wasm-pack& set "TOOLCHAIN_OK=0") else (echo   wasm-pack: OK)
where node >nul 2>nul
if errorlevel 1 (echo   [!] node not found. Install Node.js and add it to PATH.& set "TOOLCHAIN_OK=0") else (echo   node: OK)
if not "%TOOLCHAIN_OK%"=="1" (
  echo [ERROR] Toolchain incomplete.
  echo [HINT] Install Node.js ^(npm + node^) and wasm-pack, then retry.
  pause
  exit /b 1
)

call "%~dp0..\..\src\scripts\cargo-env.cmd"

echo [1/5] Ensuring Node build dependencies (auto npm install if missing)...
call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause
if errorlevel 1 (
  echo [ERROR] npm install failed.
  echo [HINT] Check network connectivity and package-lock.json, then retry.
  pause
  exit /b 1
)
echo [1/5] Node dependencies ready.

if exist "pkg\<wasm>" goto :wasm_done
echo [2/5] Building WASM (release)...
call npm run build:wasm
if errorlevel 1 (
  echo [ERROR] WASM build failed.
  echo [HINT] Delete crates\wasm\target\wasm32-unknown-unknown and retry ^(antivirus locks are the usual cause^).
  pause
  exit /b 1
)
:wasm_done
echo [2/5] WASM ready (release).

echo [3/5] Checking WASM API contract...
call npm run check:api
if errorlevel 1 (
  echo [ERROR] WASM API contract check failed.
  echo [HINT] Run npm run check:api, fix src/wasm.d.ts vs crates/wasm, then retry.
  pause
  exit /b 1
)

echo [4/5] Building TypeScript (worker.js + app.js)...
call npm run build:ts
if errorlevel 1 (
  echo [ERROR] TypeScript build failed.
  echo [HINT] Fix the tsc/esbuild errors printed above, then retry.
  pause
  exit /b 1
)

echo [5/5] Building dist package...
set "DIST_ARG="
if /i "%DIST_MODE%"=="multi" set "DIST_ARG=--multi"
call node "%~dp0scripts\build-dist.mjs" %DIST_ARG%
if errorlevel 1 (
  echo [ERROR] dist build failed.
  echo [HINT] See the build-dist.mjs errors printed above, then retry.
  pause
  exit /b 1
)

echo ============================================================
echo   WebSurf-<app> - Build dist package: complete
echo   Output:  dist/ (mode: %DIST_MODE%)
echo   Run:     play.cmd
if /i "%DIST_MODE%"=="multi" echo   Note:    multi mode needs the local HTTP server (play.cmd).
if /i "%DIST_MODE%"=="single" echo   Note:    file:// double-click works (WASM embedded).
echo ============================================================
exit /b 0
```

- `play.cmd` / `start-dev.cmd` 由同一组块组合：§2.4.1 头部 + §2.4.2 共享调用 + §2.5.2／§2.5.3 的步骤与失败块 + §2.5.5 复用块 + 前台服务行 `python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."`。
- **【必须】**single-only 工程（viewer）在 `build-dist.mjs` 内对 `--multi` 显式 `[ERROR]` + `process.exit(1)`，不得静默降级为 single。
- **【必须】**`<wasm>`、`<app>` 为占位符，落地时必须替换为 §1.2 的实际值（本文件内的占位符不得原样进入仓库文件）。

### 2.6 退出码与暂停行为（R-06）

| 场景 | 退出码 | `pause` | 依据 |
|---|---|---|---|
| 双击入口成功（服务已前台运行，关窗即止） | 0 | **禁止** | 服务窗口本身即交互面 |
| 双击入口失败 | 1 | **必须** | 防双击闪退 |
| 端口复用（复用了已运行实例） | 0 | **禁止** | 服务已在运行，`pause` 会让用户误判为出错 |
| `npm run *`（含 CI） | 原样传递 | **禁止** | 非交互场景会挂死流水线 |

- **【必须】**`.cmd` 调用的子脚本接受首参 `nopause` 并据此跳过自身的 `pause`（逐字：`if /i "%~1"=="nopause" set "NO_PAUSE=1"`）；`package.json` 脚本内**禁止**出现 `pause`。
- **【必须】**服务型入口在前台运行服务器（`python "%~dp0..\..\src\serve.py" %PORT% "%~dp0."`）；**【禁止】**`start "" python …` 或 `cmd /k` 兜住窗口（服务器崩溃时窗口仍停在提示符，用户看不到失败——`apps/debug/start-dev.cmd:63` 现用此法，属待改项）。
- 判据：`git grep -nE "pause" -- 'apps/*/*.cmd'` 中每个 `pause` 都必须能追溯到某个 `[ERROR]` 分支；`git grep -n "cmd /k" -- apps` 空输出。

### 2.7 本章文件级补齐清单（真实路径）

| 文件 | 现状 | 动作 | 依据 | 判据 |
|---|---|---|---|---|
| `apps/game/start-dev.cmd` | **不存在** | 按 §2.5.3 模板新建（端口 `8090`） | R-01、§2.2 | `Test-Path` = `True` 且含 `[3/3]` 与 `[SKIP]` 行 |
| `apps/viewer/start-dev.cmd` | **不存在** | 按 §2.5.3 模板新建（端口 `8100`） | R-01、§2.2 | 同上 |
| `apps/debug/play.cmd` | 端口复用未检测、无 `[port]`、横幅 `WebSurf  Local Play (dist)` | 补复用检测 + `[port]` + 横幅改 `WebSurf-debug - Local Play (dist)` | R-03、R-05、R-16 | §2.3/§2.5 判据 |
| `apps/game/play.cmd` | 端口 `8137`、无 `[port]`、无复用检测 | 端口改 `8091` + `[port]` + 复用检测 | R-02、R-03、R-05 | 同上 |
| `apps/viewer/play.cmd` | 端口 `8090`；步骤骨架与模板不同（`[1/3]`…`[3/3]`，且含端口复用分支）；文件本身**纯 ASCII**（>127 字节计数 0，BOM=false），**无中英混排** | 端口改 `8101` + 步骤骨架改 `[1/4]`…`[4/4]` + 文案按 §2.5.2 统一 | R-02、R-16 | 同上 |
| `apps/debug/start-dev.cmd` | `start "" python` + `cmd /k`、无 `[port]`、`[1/3]` 文案与模板不同 | 改前台服务 + `[port]` + 按 §2.5.3 统一文案 | §2.6、R-03、R-16 | `git grep -n "cmd /k"` 空 |
| `apps/debug/build-dist.cmd` | `[1/3]`…`[3/3]`、无工具链检查、`call npm run build:dist` | 改 `[0/5]`…`[5/5]` + 工具链检查 + 契约检查 + `call node "%~dp0scripts\build-dist.mjs"` | R-16、§2.4.2 | 与 §2.5.6 逐行比对 |
| `apps/game/build-dist.cmd` | `[0/5]`…`[5/5]`、失败前缀 `*** ERROR: ***` | 词表统一（`*** ERROR: ***` → `[ERROR]`）、端口文案 `8137` → `8091` | R-16 | `git grep -n "\*\*\* ERROR"` 空 |
| `apps/viewer/build-dist.cmd` | `[0/4]`…`[4/4]`、缺契约检查步骤 | 改 `[0/5]`…`[5/5]`、补 `[3/5]` 契约检查、端口文案改 `8101` | R-16 | 同上 |
| `apps/viewer/scripts/build-dist.mjs` | 词表外标记 `[错误]`/`[提示]` 共 7 处（`:77`、`:78`、`:161`、`:163`、`:164`、`:168`、`:169`；其中 `:77`/`:78` 属内嵌 `serve.py` 模板、`:161`–`:169` 属生成的 `play.sh` 模板）；生成 `dist/play.cmd` 用另一套横幅 | 词表改 `[ERROR]`/`[HINT]`；并在 `--multi` 时显式报错退出 1 | R-16、§2.2 | `git grep -n "\[错误\]" -- apps/viewer` 与 `git grep -n "\[提示\]" -- apps/viewer` 均空输出 |
| `src/serve.py` | `:52`、`:53` 用词表外前缀 `[错误]`/`[提示]`（`apps/viewer/scripts/build-dist.mjs` 的内嵌副本同源） | 改为 `[ERROR]`/`[HINT]`（共享文件，与上一行同批；见 §10.1 第 10 条） | R-16 | `git grep -n "\[错误\]" -- src` 与 `git grep -n "\[提示\]" -- src` 均空输出 |
| `apps/debug/scripts/build-dist.mjs`、`apps/game/scripts/build-dist.mjs` | 进度行与横幅未统一；仅 viewer 全量重建 `dist/` | 进度行前缀对齐 §2.5.4；`dist/` 必须全量重建 | R-16、R-15 | 见 §5.3 判据 |
| `apps/*/package.json` 的 `dev` | 三份写死 `8080` | 改为 `<seg>`（§2.3） | R-02 | §2.3 判据 |
| `test/dual-mode-harness/play.cmd` | 端口 `8080`；步骤为 `[1/3]`…`[3/3]`（与三工程模板的步骤语义不同，但**有**编号） | 端口改 `8110`；步骤编号保留 `[1/3]`…`[3/3]`（豁免见 §8.2，不强制改 `[1/4]`…`[4/4]`） | R-02 | §2.3 判据 |

## 3. 统一文件结构（R-07、R-08、R-09、R-10、R-11）

### 3.1 必备目录与文件清单（R-07）

| 条目 | 职责 | debug | game | viewer | 动作 |
|---|---|---|---|---|---|
| `apps/<app>/play.cmd` | 一键跑 dist | 有 | 有 | 有 | 统一文案（§2.5.2） |
| `apps/<app>/start-dev.cmd` | 一键跑 web/ 源页面 | 有 | **缺** | **缺** | 补齐（§2.7） |
| `apps/<app>/build-dist.cmd` | 一键构建 dist | 有 | 有 | 有 | 骨架统一（§2.5.6） |
| `apps/<app>/scripts/build-dist.mjs` | dist 生成实现（唯一） | 有 | 有 | 有 | 保持；补许可证与全量重建 |
| `apps/<app>/scripts/check-wasm-api.mjs` | `check:api` 薄配置（引擎 `src/scripts/lib/wasm-api-contract.mjs`，D-03） | 有（动态比对） | 有（硬编码清单） | **缺** | viewer 补薄配置；三工程逐步改为引用共享引擎（D-03），工程内只留本工程的 API 清单 |
| `src/scripts/ensure-node-deps.cmd`（共享，D-01） | Node 依赖自举 | 工程内副本有 | 工程内副本有 | **缺**（内联判断） | 按 D-01 上提为共享单份；三工程（含 viewer 的 2 处内联点）统一改为 `call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause`，工程内**不得**再存副本 |
| `apps/<app>/crates/wasm/Cargo.toml`、`src/lib.rs` | wasm 导出层（只导出） | 有 | 有 | 有 | 保持 |
| `apps/<app>/src/`、`src/wasm.d.ts` | 产品代码 + 手写契约桩 | 有 | 有 | 有 | 保持 |
| `apps/<app>/web/index.html` | dev/dist 共用页面 | 有 | 有 | 有 | 保持 |
| `apps/<app>/web/styles.css` | 页面样式（入库） | **缺**（内联） | 有 | 有 | 【豁免】见 §3.2 |
| `apps/<app>/web/textures.mtz` | 默认纹理包副本（入库） | 有 | 有 | **缺** | 【豁免】见 §3.2 |
| `apps/<app>/Cargo.toml`、`Cargo.lock` | 模块 workspace 清单与锁 | 有 | 有 | 有 | 保持（独立 workspace，R-21） |
| `apps/<app>/package.json`、`package-lock.json`、`tsconfig.json` | Node 工程与 TS 配置 | 有 | 有 | 有 | 保持；脚本键见 §4.2 |
| `apps/<app>/README.md` | 工程说明（入库） | 有 | 有 | 有 | 端口引用需随 §2.3 更新 |
| `apps/<app>/.gitignore` | 工程特有排除 | 有 | 有 | 有 | 见 §3.5 |

- **【必须】**上表每个「有」的行在三工程中都必须存在；「缺」的行按「动作」列补齐或按 §3.2 登记豁免。
- **【必须】**工程内**禁止**出现共享实现副本（Rust 实现只在 `src/phys/`、`src/wasm-core/`；TS 共享逻辑只在 `src/ts-shared/`），判定阈值与裁决归 R-18（解耦文档）。
- 判据：逐工程 `Test-Path` 上表路径 + `git ls-files` 对照。

### 3.2 一致性豁免表（**【豁免】** 条目必须在这里登记，才允许与统一清单不同）

| 工程 | 偏差 | 理由 | 判据（现状成立） |
|---|---|---|---|
| debug | `web/` 无 `styles.css`，样式内联 | 单文件调试页，`web/index.html` 的 `<style>` 起始于第 7 行，dev 与 dist 复用同一页面，内联可少一次请求 | `apps/debug/web/index.html:7` 为 `<style>`，且全文件无 `rel="stylesheet"` |
| viewer | `web/` 无 `textures.mtz` | viewer 不做 MTZ 纹理包路径（只有 BSP→GLB + 录像回放），不需要该资产 | `Test-Path apps/viewer/web/textures.mtz` = `False`，且 `apps/viewer/src` 无 mtz 引用 |
| viewer | `dist/` 多出 `play.cmd`、`play.sh`、`serve.py`、`README.md`、`.nojekyll`、`assets/` | 定位是「纯静态产物 + `file://` 双击可用」，产物自带启动器与说明（I-14） | `apps/viewer/scripts/build-dist.mjs:182` 起全量重建并写入这些文件 |
| viewer | `crates/wasm/` 不依赖 `websurf-phys` | 无物理需求（I-18）；硬加会白增体积 | `apps/viewer/crates/wasm/Cargo.toml:19` 只有 `websurf-wasm-core` |
| harness | 无 `web/` 目录、无 `start-dev.cmd`/`build-dist.cmd` | 验证工程，不部署；页面在工程根 | `Test-Path test/dual-mode-harness/web` = `False` |
| harness | `build:wasm` 把 wasm 拷到工程根 | 页面在工程根，无 `web/` | `test/dual-mode-harness/package.json:8` |
| harness | 无 `build:worker`/`build:app` | 三个入口（`main`/`worker-a`/`worker-b`）由单条 `build:ts` 打包 | `test/dual-mode-harness/package.json:10` |
| 三工程 | wasm 文件名不同（`<crate>_bg.wasm`） | 名称随 crate 名（`websurf-wasm` / `websurf-viewer-wasm`） | `pkg/` 产物名与 `crates/wasm/Cargo.toml` 的 `name` 一致 |

- **【禁止】**新增未登记的一致性豁免；**【禁止】**为「整齐」把上表任一项改成与另两个工程相同。

### 3.3 共享层相对路径层数规则

**规则（【必须】）**：引用共享层的相对路径 = 由**所在文件相对仓库根的深度**推导——深度 `D` 就用 `D` 组 `..`，命令/批处理用反斜杠，TS/JSON/Cargo 用正斜杠。层数错一位即缺陷（历史事故：`c29…` 类迁移后 46 文件少一层，见 [AGENTS.md](../AGENTS.md) §6；本轮又实测到一处，见下）。

| 文件位置 | 示例 | 深度 `D` | 反斜杠写法 | 正斜杠写法 | 实测 |
|---|---|---|---|---|---|
| 仓库根 | `.github/workflows/deploy-pages.yml` | 0 | `apps/<app>/…` | `apps/<app>/…` | CI 用 `working-directory`，禁止手写深度 |
| `src/` 内 | `src/scripts/cargo-env.cmd` | 1 | `..\serve.py` | — | — |
| `apps/<app>/` 工程根 | `play.cmd`、`start-dev.cmd`、`build-dist.cmd`、`package.json` | 2 | `..\..\src\…` | `../../src/…` | 正例：`apps/debug/play.cmd:17`、`apps/debug/build-dist.cmd:21`、`apps/viewer/build-dist.cmd:54`、`apps/game/package.json:8`、`apps/viewer/package.json:17` |
| `apps/<app>/scripts/` | `install-wasm-bindgen.cmd`、`*.mjs` | 3 | `..\..\..\src\…` | `../../../src/…` | **反例（历史：`fa5552e` 已修层、`fc3de84` 已上提，该文件现位于 `src/scripts/`）**：`apps/debug/scripts/install-wasm-bindgen.cmd:19` 写 `..\..\` → 实际解析为 `apps/src/scripts/cargo-env.cmd`（不存在） |
| `apps/<app>/src/` | `app.ts`、`worker/main.ts` | 3 | — | `../../../src/ts-shared/…` | 正例：`apps/game/src/app.ts:18` |
| `apps/<app>/crates/wasm/` | `Cargo.toml` | 4 | — | `../../../../src/…` | 正例：`apps/debug/crates/wasm/Cargo.toml:22`、`apps/viewer/crates/wasm/Cargo.toml:19` |
| `apps/<app>/test/` | `replay-selftest.ts` | 3 | — | `../../../src/…` | — |
| `test/dual-mode-harness/` | `play.cmd`、`package.json` | 2 | `..\..\src\…` | `../../src/…` | 正例：`test/dual-mode-harness/play.cmd:72` |
| `test/dual-mode-harness/scripts/` | `*.mjs` | 3 | — | `../../../src/…` | — |
| `test/dual-mode-harness/crates/wasm/` | `Cargo.toml` | 4 | — | `../../../../src/…` | 正例：`test/dual-mode-harness/crates/wasm/Cargo.toml:19` |
| `documents/**` | `*.md` | 3+ | — | 相对当前 md 的路径（[AGENTS.md](../AGENTS.md) §5.3） | 链接必须真实可达 |

- **【必须】**`%~dp0` 形式的共享调用必须写成 `call "%~dp0..\..\src\scripts\cargo-env.cmd"`（工程根）或 `call "%~dp0..\..\..\src\scripts\cargo-env.cmd"`（工程 `scripts/` 下）；**【禁止】**用绝对路径或 `cd` 跳出工程目录后再引用。
- **【必须】**新增文件前先数自己在第几层；新增/移动目录后必须重算所有引用它的文件的深度（[AGENTS.md](../AGENTS.md) §6）。
- 判据（逐文件解析并验证可达）：

```bash
git grep -nE "\.\.[\\/]" -- 'apps/*/*.cmd' 'apps/*/scripts/*.cmd' 'apps/*/package.json' 'test/**/*.cmd' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const fs=require('fs'),path=require('path');let bad=0;for(const l of s.split(/\r?\n/).filter(Boolean)){const i=l.indexOf(':');const f=l.slice(0,i);const rest=l.slice(i+1);const m=rest.match(/\"?([^\"]*?\.(cmd|py|mjs|ts|json))\"/);if(!m)continue;const rel=(m[1].match(/[\\/]\.\.[\\/].*$/)||[])[0];if(!rel)continue;const p=path.resolve(path.dirname(f),rel.replace(/\\\\/g,'/'));if(!fs.existsSync(p)){console.log('BAD '+f+':'+rest.slice(0,60)+' -> '+p);bad++;}}console.log('broken='+bad);})"
```

### 3.4 `tsconfig.json` 与验证脚本位置（R-08、R-09、R-10）

- **【必须】**`tsconfig.json` 的 `include`/`exclude` 每项都指向真实存在的路径（glob 的静态前缀必须存在）。判据：`Test-Path apps/debug/web/vendor`【当前 = `False`，违反】→ 待执行动作：删除 `apps/debug/tsconfig.json:26` 的 `web/vendor`。
- **【必须】**`include` 含 `../../src/ts-shared/**/*.ts` **当且仅当**该工程 `src/` 内存在实际 `import … from '…ts-shared/…'`。实测按 **import 语句口径**：debug **6**、game **5**、viewer **0**（同工程按**字面量口径**为 9 / 6 / 0，差异来自纯注释文件，见 §10.2 第 2 行）→ debug/game 必须 include 且已 include（`apps/debug/tsconfig.json:26`、`apps/game/tsconfig.json:15`）；viewer **不得** include，当前 `apps/viewer/tsconfig.json:15` 不含共享层 ✓。
  判据：`git grep -lE "from .*ts-shared" -- 'apps/*/src'` 的文件数与该工程 `tsconfig.json` 是否列入共享层比对。
  【更正】[framework-audit.md](framework-audit.md) §4.1 称 viewer 的 `tsconfig.json` 把 `ts-shared` 纳入 `include`（并据此判 R-09/R-20 违反），实测不成立：`apps/viewer/tsconfig.json:15` 为 `["src/**/*.ts", "src/wasm.d.ts", "test/**/*.ts"]`。viewer 的 include 与其「零引用」一致。
- **【必须】**工程有 `test/*.ts` 时 `include` 必须含 `test/**/*.ts`（viewer ✓）。
- **【必须】**验证脚本位置二选一：工程 `scripts/*.mjs`（Node 直跑）或工程 `test/*.ts`（需要类型/被 bundle）；同类脚本不得在两个工程用不同位置。判据：`git ls-files 'apps/*/scripts/*.mjs' 'apps/*/test/*.mjs' 'apps/*/test/*.ts'` 与 §4.3 的注册闭包对照。

### 3.5 临时区（R-11）

- **【必须】**`package.json` 里写死输出路径的脚本，输出必须是**本工程内**的 `.tmp/<主题>/`。
  【当前违反】`apps/viewer/package.json:10`（`test:replay` 的 outfile 为 `temp/replay-selftest.mjs`）→ 待执行动作：改为 `.tmp/replay-selftest/`。
  【更正】[framework-audit.md](framework-audit.md) §7.3 把 R-11 记为「当前合规」，与 R-11 条文本身（写死 outfile 必须用 `.tmp/`）及实测不符；按条文口径，viewer 该处是待修项。这条同时解释了该审计 §4.4 记录的「`apps/viewer/temp/` 常驻文件」——改为 `.tmp/` 后，`temp/` 恢复「常态为空」。
- **【必须】**脚本自建中间目录只能是 `apps/<app>/.tmp/` 或 `apps/<app>/temp/`（[AGENTS.md](../AGENTS.md) §3.1），且必须在同一次运行内创建、结束前清理；任何入库文件不得把临时区当事实来源。
- **【必须】**`git ls-files -- '**/temp/**' '**/.tmp/**'` 恒为空输出。

### 3.6 本章文件级补齐清单

| 文件 | 现状 | 动作 | 依据 |
|---|---|---|---|
| `apps/debug/tsconfig.json` | `include` 含不存在的 `web/vendor` | 删除该项 | R-08 |
| `apps/viewer/package.json` | `test:replay` outfile 指向 `temp/` | 改为 `.tmp/replay-selftest/`（并同步脚本内清理逻辑） | R-11 |
| `apps/debug/scripts/install-wasm-bindgen.cmd` | 第 19 行 `..\..\` 少一层，且归属错位（共享 `cargo-env.cmd` 反向引用工程内路径） | **上提**至 `src/scripts/install-wasm-bindgen.cmd`（D-02 定稿）；移动后内部调用改同目录 `call "%~dp0cargo-env.cmd"`，调用方改为 `call "%~dp0..\..\src\scripts\install-wasm-bindgen.cmd"`。**禁止**先就地补 `..` 再移动 | §3.3、D-02 |
| `apps/viewer/scripts/check-wasm-api.mjs` | **不存在** | 新建**薄配置**，引擎取共享 `src/scripts/lib/wasm-api-contract.mjs`（D-03；与 §10.1 第 20 条合并为一次动作，避免先造出第 4 份副本） | R-07/R-12、D-03 |
| `apps/debug/scripts/jump-apex-verify.mjs`、`apps/debug/scripts/jump-apex-serve.mjs` | 仓库根算成 `apps/`（少一层），`test:jump-apex` 在干净检出必然失败 | 按 §3.3 各补一层 `..` | §3.3、审计 §7.5 第 1 条 |

## 4. `package.json` 脚本集合（R-12、R-13）

### 4.1 现状（实测）

| 键 | debug | game | viewer | harness |
|---|---|---|---|---|
| `typecheck` | 有 | 有 | 有 | 有 |
| `build:wasm` | 有（**不**拷贝 wasm 到 `web/`） | 有（拷贝） | 有（拷贝） | 有（拷贝到工程根） |
| `build:worker` / `build:app` | 有 | 有 | 有 | **无** |
| `build:ts` | `typecheck && build:worker && build:app` | 同左 | 同左 | 单条三入口 esbuild |
| `build:dist` | 有 | 有 | 有 | 有 |
| `build` | `build:wasm && build:ts` | 同左 | 同左 | 同左 |
| `dev` | `python ../../src/serve.py 8080 .` | 同左 | 同左 | 同左 |
| `check:api` | 有 | 有 | **无** | 有 |
| `test:*` 数量 | 4（`test:optimize-scene`、`test:path-acceptance`、`test:auth-clock`、`test:jump-apex`） | 2（`test:phys`、`test:seed-smoke`） | 2（`test:replay`、`test:smoke`） | 1（`test:three-mode`） |
| 未被任何脚本引用的 `scripts/*.mjs` | 8 | 13 | 0 | — |

### 4.2 必备键与固定语义（R-12）

三应用工程**【必须】**具备以下键，值逐字固定（`<seg>` 见 §2.3）：

| 键 | 固定值 |
|---|---|
| `typecheck` | `tsc --noEmit` |
| `build:wasm` | `cd crates/wasm && wasm-pack build --release --target web --out-dir ../../pkg` **并且**把 `pkg/<wasm>` 拷入 `web/<wasm>` |
| `build:worker` | `esbuild src/worker/main.ts --bundle --outfile=web/worker.js --format=esm --target=es2022` |
| `build:app` | `esbuild src/app.ts --bundle --outfile=web/app.js --format=esm --target=es2022` |
| `build:ts` | `npm run typecheck && npm run build:worker && npm run build:app` |
| `build:dist` | `node scripts/build-dist.mjs` |
| `build` | `npm run build:wasm && npm run build:ts` |
| `dev` | `python ../../src/serve.py <seg> .` |
| `check:api` | `node scripts/check-wasm-api.mjs` |

- **【必须】**`build` 的语义恒为「wasm + ts」，**禁止**在任何工程里把 `build` 定义成含 `build:dist`（本地产物形态由 `build-dist.cmd` / `build:dist` 显式表达）。
- **【必须】**凡链接了 `websurf-phys`/`websurf-wasm-core` 的工程都必须有 `check:api` 且被 `build-dist.cmd` 的 `[3/5]` 步骤调用。
- compare 判据：`node -e "for(const a of ['debug','game','viewer'])console.log(a,require('./apps/'+a+'/package.json').scripts)"` 的输出与上表逐字比对。
- 偏差：viewer 缺 `check:api`（待补）；harness 的 `build:worker`/`build:app`【豁免】（§3.2）。

### 4.3 脚本可达性规则（R-13）

- **【必须】**每个 `apps/<app>/scripts/*.mjs` 必须落在「`package.json` 脚本键 → 其直接调用的 `.mjs` → 该 `.mjs` 静态 `import` 的本地 `.mjs`」闭包内；闭包外的文件视为孤儿。
- 孤儿只能二选一处置：① 在 `package.json` 注册脚本键；② 从 `scripts/` 移出（移入工程 `.tmp/` 或删除，且不得入库）。
- 命名规则（【必须】）：`test:*` = 无需外部前置条件的断言门禁（CI 必须调用）；`local:*` = 需要人工前置（浏览器、另起服务器、本地地图）；`bench:*`/`count:*`/`plot:*` = 只输出度量不成断言。
- 注册名规则（【必须】）：`test:<域>-<名字>`（如 `test:phys-teleport-gate`）、`bench:<名字>`、`local:<名字>`；同一名字跨工程可重名但语义必须相同。
- 当前孤儿（实测）：`apps/game/scripts/` 13 个（`phys-diag-flat`、`phys-dual-pipe`、`phys-gate-probe2`、`phys-p2-ground`、`phys-p2-regression`、`phys-p2-trace`、`phys-rate-parity`、`phys-rate-parity-v2`、`phys-teleport-gate`、`t13-input-surface-probe`、`t13-literal-sweep`、`t13-ulp-sensitivity-control`、`wasm-hash-pin`）；`apps/debug/scripts/` 8 个（`input-replay-verify`、`jump-apex-auth-diag`、`jump-apex-measure`、`jump-apex-report`、`jump-apex-serve`、`jump-apex-smoke`、`jump-apex-trace`、`jump-apex-window`）。每条按上面的命名规则落成 `test:*`（有断言）或 `bench:*`/`local:*`（无断言或需人工）。
- 判据：求差集脚本（`scripts/*.mjs` 与其注册键的引用关系）输出为空。

### 4.4 本章文件级补齐清单

| 文件 | 现状 | 动作 | 依据 |
|---|---|---|---|
| `apps/viewer/package.json` | 无 `check:api` | 增 `check:api` 键 | R-12 |
| `apps/game/package.json` | 13 个 `scripts/*.mjs` 未注册 | 逐个注册 `test:*`/`bench:*`/`local:*` | R-13 |
| `apps/debug/package.json` | 8 个 `scripts/*.mjs` 未注册；`test:jump-apex` 在干净检出必失败 | 注册 + 先修 §3.6 的层数缺陷 | R-13 |
| `apps/viewer/package.json` | `test:smoke` 需浏览器 + 已运行 dev 服务器 | 改名 `local:smoke`（`test:*` 只能是无外部前置的门禁） | §4.3、§6.2 |
| `apps/game/package.json` | `test:phys`、`test:seed-smoke` 未进 CI | 保留 `test:*` 并补进 CI（§6.2） | §6.2 |

## 5. 产物与输出一致性（R-14、R-15、R-17）

### 5.1 现状（实测）

| 项 | debug | game | viewer |
|---|---|---|---|
| `dist/` 形态 | single + multi | single + multi | single only |
| 本地 multi 入口 | 无（CI 直接 `node scripts/build-dist.mjs --multi`） | 无（同左） | 不适用 |
| `dist/` 全量重建 | 未确认有 `rm` | 未确认有 `rm` | 有（`apps/viewer/scripts/build-dist.mjs:182`） |
| single 内嵌内容 | wasm + worker + mtz | wasm + worker + mtz | wasm + worker（无 mtz） |
| 许可证文件 | `LICENSE.cs-movement` + `NOTICE.cs-movement` | **无** | 无（不需要） |
| `web/` 是否含 wasm 拷贝 | **无**（dev 走 `../pkg/`） | 有 | 有 |

### 5.2 `dist` 形态选定规则（R-15）

| 工程 | 声明形态 | 默认（`build-dist.cmd`） | multi 入口 | 理由 |
|---|---|---|---|---|
| `apps/debug/` | `{single, multi}` | single | `build-dist.cmd multi` | 本地双击用 single；Pages 部署用 multi |
| `apps/game/` | `{single, multi}` | single | `build-dist.cmd multi` | 同左 |
| `apps/viewer/` | `{single}`（**声明为 single-only**） | single | **禁止**（收到 `multi` 必须 `[ERROR]` + 退出码 1） | 定位是 `file://` 双击 + 静态托管：classic `<script>`、wasm base64 内嵌、无 SAB/COOP 依赖（I-17、审计 §3.4） |
| `test/dual-mode-harness/` | 无 `dist` 交付要求 | — | — | 不部署 |

- **【必须】**`build-dist.cmd` 默认 single；`build-dist.cmd multi` 传 `--multi` 给 `scripts/build-dist.mjs`；单工程内的两种形态必须由同一脚本实现（禁止两份实现）。
- **【必须】**`scripts/build-dist.mjs` 必须先删除再重建 `dist/`（禁止增量残留）；判据：三份脚本均含 `rm(`/`rmSync` 且目标为 `dist`。
- **【禁止】**CI 与本地用不同形态：CI 的形态必须来自上表「声明形态」（§6.2）。
- 判据：`build-dist.cmd multi` 后 `dist/` 内 `app.js`、`worker.js`、`<wasm>`、`textures.mtz` 均为独立文件；`build-dist.cmd`（默认）后 `dist/app.js` 内联 `__VBSP_WASM_B64__`。

### 5.3 `dist` 产物清单与许可证（R-17）

| 工程 | single 必备 | multi 必备 |
|---|---|---|
| `apps/debug/` | `index.html`、`app.js`、`LICENSE.cs-movement`、`NOTICE.cs-movement` | 同上 + `worker.js`、`<wasm>`、`textures.mtz` |
| `apps/game/` | `index.html`、`app.js`、`styles.css`、`LICENSE.cs-movement`、`NOTICE.cs-movement` | 同上 + `worker.js`、`<wasm>`、`textures.mtz` |
| `apps/viewer/` | `index.html`、`app.js`、`styles.css`、`play.cmd`、`play.sh`、`serve.py`、`README.md`、`.nojekyll`、`assets/`（存在示例录像时） | 不适用（single-only） |

- **【必须】**凡 dist 内包含 Apache-2.0 许可代码（`@unsurf/cs-movement` 的 Rust 移植位于 `src/phys/`）的工程，dist 内必须同时含 `LICENSE.cs-movement` 与 `NOTICE.cs-movement`；判据为 `Get-ChildItem dist` 清单。
- **【必须】**许可证的**唯一源**为共享层 `src/phys/LICENSE` 与 `src/phys/NOTICE`（captain 于 t7 按 F-01 裁定：许可证作为共享资产与它所约束的 `src/phys/` 物理实现同址）。现状暂存于 `apps/debug/src/physics/LICENSE`、`NOTICE`（两者**已被 git 跟踪**，各 11560 B / 625 B），迁移时上提为上述唯一源，三工程 dist 一律从该唯一源拷贝。
- **【必须】**`dist/LICENSE.cs-movement`、`dist/NOTICE.cs-movement` 是**产物级副本**：各工程 dist 内允许且必须各存一份（法律要求随产物分发，不违反「禁止复制共享实现」）；**【禁止】**在工程 `src/` 内再复制源码级许可证副本（第二份源码副本）。
- 与解耦文档的关系：vendored **代码**子树的落点由 [framework-decoupling.md](framework-decoupling.md) §3.2 D-06 判**保留**在 `apps/debug/src/physics/`（本文件不改动该结论）；本条的裁定只迁移**许可证文件**，vendored 代码的许可头（`apps/debug/src/physics/math/vec3.ts:2-7`）不变，故两份文档不互斥；`build-dist.mjs` 的许可证拷贝改造归 D-04 共享内核（见 C-3）。
- 判据：`git ls-files src/phys` 含 `LICENSE`、`NOTICE`；`git grep -n "LICENSE.cs-movement" -- 'apps/*/scripts/build-dist.mjs'` 的源路径全部指向 `src/phys/`。
- **【必须】**dist 内不得含 `.map`、源码、`node_modules`、开发脚本；viewer 的 `dist/README.md` 由 `apps/viewer/scripts/dist-README.md` 生成（生成源的唯一事实来源是后者）。
- 判据：`git status --short` 在构建后不含 `dist/` 下的入库文件（`.gitignore` 已覆盖 `**/dist/`）。

### 5.4 `web/` 文件集合与 dev 模式 WASM 路径（R-14）

| `web/` 文件 | 归属 | debug | game | viewer | 规范 |
|---|---|---|---|---|---|
| `index.html` | 入库 | 有 | 有 | 有 | 【必须】 |
| `styles.css` | 入库 | 缺 | 有 | 有 | 【豁免】debug（§3.2） |
| `textures.mtz` | 入库 | 有 | 有 | 缺 | 【豁免】viewer（§3.2）；使用时【必须】入库（`.gitignore` 不得排除 `**/web/textures.mtz`） |
| `app.js` | 产物 | 有 | 有 | 有 | 【必须】（`build:app`） |
| `worker.js` | 产物 | 有 | 有 | 有 | 【必须】（`build:worker`） |
| `<wasm>` | 产物 | **缺** | 有 | 有 | 【必须】（`build:wasm` 拷贝；debug 待补） |

- **【必须】**dev 模式三工程统一从 `web/<wasm>` 加载：运行时表达式只允许 `new URL('./<wasm>', import.meta.url)` 或相对页面目录的 `./<wasm>`；**【禁止】**debug 现行的 `../pkg/<wasm>`。
- **【必须】**`build:wasm` 负责把 `pkg/<wasm>` 拷入 `web/`（game/viewer 已具备；debug 待补），因此 `web/` 三产物集合三工程一致。
- **【必须】**dist 形态与加载路径的对应关系唯一：single = base64 内嵌（`__VBSP_WASM_B64__`）；multi = 外置 `<wasm>` + 注入 URL；**【禁止】**第三种形态。
- 判据：`git grep -nE "websurf_wasm_bg\.wasm|websurf_viewer_wasm_bg\.wasm" -- 'apps/*/src' 'apps/*/package.json'` 的输出只含 `./`、`copyFileSync('../../pkg/…','../../web/…')` 与 `__VBSP_WASM_B64__`/`__VBSP_WASM_URL__` 三类形态。

### 5.5 本章文件级补齐清单

| 文件 | 现状 | 动作 | 依据 |
|---|---|---|---|
| `apps/debug/package.json` | `build:wasm` 不拷贝 wasm 到 `web/` | 补拷贝步骤 | R-14 |
| `apps/debug/src/main-wasm.ts` | dev 路径 `../pkg/websurf_wasm_bg.wasm`（`:19`） | 改为 `./websurf_wasm_bg.wasm` | R-14 |
| `apps/game/scripts/build-dist.mjs` | 无许可证拷贝 | 补 `LICENSE.cs-movement`、`NOTICE.cs-movement` 拷贝，源取唯一源 `src/phys/{LICENSE,NOTICE}`（§5.3、captain 的 F-01 裁定） | R-17 |
| `apps/debug/scripts/build-dist.mjs`、`apps/game/scripts/build-dist.mjs` | `dist/` 未确认全量重建 | 补 `rm(dist,{recursive:true,force:true})` | R-15 |
| `apps/viewer/scripts/build-dist.mjs` | `--multi` 静默忽略 | 显式 `[ERROR]` + `process.exit(1)` | §2.2 |
| `apps/game/package.json`、`apps/viewer/package.json` | 无 multi 本地入口 | 由 `build-dist.cmd multi` 提供（`build-dist.mjs` 已支持 `--multi`） | R-15 |

## 6. CI 对齐（只写规范，不改 CI 文件）

### 6.1 现状（实测）

- 每个工程用 `working-directory` 分别执行：debug 段（`.github/workflows/deploy-pages.yml` 的 `:76-119`）、game 段（`:121-137`）、viewer 段（`:139-159`）、harness 段（`:161-178`）。
- dist 形态：debug `node scripts/build-dist.mjs --multi`（`:91`）、game 同（`:137`）、viewer `npm run build:dist`（`:155`）。
- 测试：debug 在 CI 跑 3 个 `test:*`（`test:optimize-scene`、`test:auth-clock`、`test:path-acceptance`；第 4 个 `test:jump-apex` 未进 CI 且当前有层数缺陷，见 §3.6）；viewer 只跑 `test:replay`；**game 段无任何 test 步骤**；viewer 的 `test:smoke` 从未进 CI。

### 6.2 收敛规则

- **【必须】**CI 每个工程的步骤序列固定为：`npm ci` → `npm run build:wasm` → `npm run build:ts` → `npm run build:dist`（multi 用 `npm run build:dist -- --multi`）→ 该工程**全部** `test:*`。
- **【禁止】**CI 直接调用 `node scripts/*.mjs`（绕过 `package.json` 唯一入口）——现行 `node scripts/build-dist.mjs --multi` 必须改写为 `npm run build:dist -- --multi`。
- **【必须】**CI 的 dist 形态与 §5.2 声明一致（debug/game multi、viewer single）。
- **【必须】**`test:*` ⊆ CI、`local:*` ∩ CI = ∅。因此：game 的 `test:phys`、`test:seed-smoke` 必须补进 CI；viewer 的 `test:smoke` 改为 `local:smoke`；debug 的 `test:jump-apex` 修好层数缺陷后补进 CI。
- **【禁止】**CI 通过 `working-directory` 之外的方式跨工程取文件（例如根目录 `npm ci`）；根目录**没有** `package.json`，也不得为统一而新增根工程（会破坏「各工程独立 workspace + 独立 lock」的既有结构）。
- 判据：`git grep -nE "node scripts/" -- .github/workflows` 空输出；CI 内 `npm run test:` 的键集合 ⊇ 各 `package.json` 的 `test:*` 键集合（可用脚本比对）。

## 7. 新子工程脚手架清单

### 7.1 文件树（`<new>` 为新工程名；`(产物)` 不入库）

```text
apps/<new>/
├─ .gitignore                      # 工程特有排除（§7.2）
├─ Cargo.toml                      # 模块 workspace 清单（独立，含 vmdl [patch.crates-io]）
├─ Cargo.lock                      # 入库
├─ package.json                    # 唯一入口脚本集合（§4.2）
├─ package-lock.json               # 入库
├─ tsconfig.json                   # include 只列真实存在且被引用的路径（§3.4）
├─ README.md                       # 工程说明（端口、目标页、验证脚本）
├─ play.cmd                        # 一键跑 dist（§2.5.2）
├─ start-dev.cmd                   # 一键跑 web/（§2.5.3）
├─ build-dist.cmd                  # 一键构建 dist（§2.5.6）
├─ crates/wasm/
│  ├─ Cargo.toml                   # 依赖共享 crate 用 ../../../../src/...（§3.3）
│  └─ src/lib.rs                   # 只做 #[wasm_bindgen] 导出
├─ scripts/
│  ├─ build-dist.mjs               # dist 生成（薄入口 → src/scripts/lib/dist-pack.mjs，D-04）
│  └─ check-wasm-api.mjs           # check:api 薄配置（引擎在 src/scripts/lib/wasm-api-contract.mjs，D-03）
│  （Node 依赖自举与 wasm-bindgen 预装**不落工程内**：调用 src/scripts/ensure-node-deps.cmd、
│    src/scripts/install-wasm-bindgen.cmd —— D-01/D-02）
├─ src/
│  ├─ app.ts                       # 主线程入口
│  ├─ worker/main.ts               # Worker 入口
│  └─ wasm.d.ts                    # 手写契约桩（与 crates/wasm 导出集一致）
├─ web/
│  ├─ index.html                   # dev/dist 共用页面（入库）
│  ├─ styles.css                   # 外置样式（入库）
│  ├─ textures.mtz                 # 默认纹理包副本（入库；不使用则省略并登记豁免）
│  ├─ app.js                       # (产物)
│  ├─ worker.js                    # (产物)
│  └─ <wasm>                       # (产物，build:wasm 拷贝)
└─ (pkg/、dist/、.tmp/、node_modules/、target/ 均为产物或缓存，不入库)
```

### 7.2 每个文件的职责与来源

| 文件 | 职责 | 参考实现 |
|---|---|---|
| `play.cmd` | 补齐 deps/WASM/TS/dist 后前台服务 dist 并打开浏览器 | 按 §2.5.2 模板组装（含 `[port]`、`[SKIP]` 复用块） |
| `start-dev.cmd` | 只构建 TS，前台服务 `web/index.html` | 按 §2.5.3 模板组装 |
| `build-dist.cmd` | 工具链检查 → 依赖 → WASM → 契约 → TS → dist | 直接复制 §2.5.6 全文并替换占位符 |
| `scripts/build-dist.mjs` | 生成 single（base64 内嵌）与 multi（外置）两种 dist；先删后建；写许可证 | 移植 `apps/viewer/scripts/build-dist.mjs` 的全量重建 + `apps/game/scripts/build-dist.mjs` 的 multi 分支 |
| `scripts/check-wasm-api.mjs` | 校验 `pkg/` 导出集与 `src/wasm.d.ts` 一致 | 薄配置：引擎取共享 `src/scripts/lib/wasm-api-contract.mjs`（D-03），工程内只保留本工程 API 清单 |
| （共享）`src/scripts/ensure-node-deps.cmd` | 检测 `node_modules/.bin/tsc`，缺失则 `npm install`；支持 `nopause` | **不在工程内新建**：按 D-01 上提为共享单份，工程以 `call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause` 调用 |
| `package.json` | 唯一脚本入口（§4.2 九键） | 以 `apps/game/package.json` 为基准 |
| `tsconfig.json` | `include` = `src` + `web`（若需要）+ 实际引用的共享层 | 以 `apps/debug/tsconfig.json` 为基准（去掉失效项） |
| `crates/wasm/src/lib.rs` | 只导出，不实现 | 任一现有 `crates/wasm/src/lib.rs` |
| `web/index.html`、`web/styles.css` | dev/dist 共用页面与样式 | 以 `apps/viewer/web/` 为基准 |
| `.gitignore` | 追加工程特有产物（`dist/`、`pkg/`、`target/`、`web/app.js`、`web/worker.js`、`web/<wasm>`） | 以 `apps/game/.gitignore` 为基准 |
| `README.md` | 端口、目标页、脚本清单、验证命令 | 以 `apps/game/README.md` 为基准 |

### 7.3 脚手架验收判据（新工程建成后逐条执行）

1. `git ls-files 'apps/<new>/*.cmd'` 恰好 3 个（§2.2）。
2. `npm run typecheck`、`npm run build:wasm`、`npm run build:ts`、`npm run build:dist` 退出码全 0。
3. `build-dist.cmd` 的 stdout 与 §2.5.4 逐行一致（步骤号连续、词表合法）。
4. `build-dist.cmd multi` 产出外置 `<wasm>`；默认产出 `dist/app.js` 内嵌 `__VBSP_WASM_B64__`（§5.2）。
5. `play.cmd` 二次点击走 `[SKIP]` 复用分支且退出码 0（§2.3）。
6. `web/` 产物集合为 `{app.js, worker.js, <wasm>}`（§5.4）。
7. `git ls-files -- 'apps/<new>/{temp,.tmp}/**'` 为空（§3.5）。

## 8. 统一项与工程特有能力边界

### 8.1 统一项（三应用工程必须一致）

| 统一项 | 条款 |
|---|---|
| 三件套入口名与语义、`[port]`/`[single\|multi]` 参数 | §2.2 |
| 端口段规则、槽位、占用检测与复用行为 | §2.3 |
| `.cmd` 头部 5 行、纯 ASCII、CRLF/无 BOM、`call` 前缀 | §2.4 |
| 输出词表、`[N/M]` 骨架（play N=4、start-dev N=3、build-dist N=5）、60 字符分隔线、失败块两行制 | §2.5 |
| 退出码与 `pause` 矩阵、子脚本 `nopause` 接口 | §2.6 |
| 必备目录/文件清单（除 §3.2 豁免） | §3.1 |
| 共享层相对路径层数规则 | §3.3 |
| `package.json` 九键与固定语义、脚本命名与可达性 | §4.2、§4.3 |
| `web/` 三产物集合、dev 加载路径、dist 形态与加载路径的对应 | §5.4 |
| CI 步骤序列与「npm 唯一入口」 | §6.2 |

### 8.2 各工程特有能力（允许不同，必须声明）

| 工程 | 特有能力 | 为何保留 |
|---|---|---|
| viewer | single-only dist；`dist/` 自带 `play.cmd`/`play.sh`/`serve.py`/`README.md`/`.nojekyll`/示例录像；`play.cmd` 复用 `dist/play.cmd` 实现；`App:` 行为 `http://localhost:%PORT%/index.html` | `file://` 双击 + 静态托管是其交付形态；`dist` 必须自包含 |
| viewer | 不依赖 `websurf-phys`、无 `web/textures.mtz`、`test/` 目录与 `test/**/*.ts` include | 无物理/纹理需求；自检脚本需要类型 |
| debug | WASM 步骤内自动确保 `wasm-bindgen-cli 0.2.128`（作为 `[2/5]` 的子步骤，输出用 `[INFO]`，不占独立步骤号）；`check:api` 用导出/导入动态比对；`web/` 无 `styles.css`；`fixtures/`、`scripts/pages-index.html`（Pages 入口页） | 本机 Windows 首次构建体验；单文件调试页；CI 夹具与 Pages 首页 |
| game | 无（本规范对 game 不产生任何豁免），但 `build-dist.mjs` 的 multi 分支是唯一 multi 参考实现 | — |
| harness | 无 `web/`、无 `start-dev.cmd`/`build-dist.cmd`、wasm 拷到工程根、单条 `build:ts` 打三入口、`dev` 与 `play` 共用 `8110` | 验证工程不部署、页面在工程根 |
| 三工程共有 | 每工程独立 `Cargo.toml` workspace 与 `Cargo.lock`；5 份 `[patch.crates-io] vmdl` 声明；4 份 `src/wasm.d.ts` | Cargo/TS 语义决定，不可合并（R-21） |

### 8.3 禁止清单（不得以「统一」或「上提」为名改动）

- **【禁止】**给 viewer 加 multi dist 分支，或把 `dist/play.cmd` 换成统一的工程根启动器（会破坏 `file://` 交付形态）。
- **【禁止】**删除 viewer 的 `dist-README.md` 生成步骤与 `.nojekyll`。
- **【禁止】**删除 debug 的 `wasm-bindgen` 自动安装、动态契约比对、`fixtures/`、`pages-index.html`。
- **【禁止】**给 viewer 的 `crates/wasm` 加 `websurf-phys`；给 debug 强加 `web/styles.css`；给 viewer 强加 `web/textures.mtz`。
- **【禁止】**把 `.cmd` 文案改成中文（词表与 ASCII 约束优先于「文案友好」）。
- **【禁止】**把 `ensure-node-deps.cmd`、`install-wasm-bindgen.cmd` 的内容在工程内留副本（R-19；落点见 D-01/D-02）；**【禁止】**合并 5 份 `Cargo.toml` 的 `[patch.crates-io]`（R-21）。
- **【禁止】**为统一端口而新增根级 `package.json` 或跨工程共享的端口配置文件（端口表以本文件为唯一事实来源）。

## 9. R-n 条款落点映射（R-01…R-21）

| 条款 | 落点 | 本文件给出的判据 |
|---|---|---|
| R-01 | §2.2（三件套 + start-dev 必要性判据 + 验证工程豁免） | `git ls-files '*.cmd'` 去重计数 |
| R-02 | §2.3（端口段表 + 新旧对照 + 新增工程规则） | 端口表逐条比对 |
| R-03 | §2.3（`[port]` 逐字实现） | `git grep -n 'if not "%~1"==""'` 三份命中 |
| R-04 | §2.4.1（CRLF/纯 ASCII/无 BOM/头部 5 行） | 字节统计（>127 计数、LF 与 CRLF 相等） |
| R-05 | §2.3（占用检测命令 + 复用行为） | 三份 `play.cmd` 的 `[SKIP]` 分支文本比对 |
| R-06 | §2.6（退出码与 `pause` 矩阵 + `nopause` 接口） | `pause` 逐分支追溯、`npm run *` 无 `pause` |
| R-07 | §3.1（必备清单表）+ §3.2（豁免表） | 逐工程 `Test-Path` + `git ls-files` |
| R-08 | §3.4（include 只列真实存在的路径） | 解析 tsconfig 后逐项 `Test-Path` |
| R-09 | §3.4（include 与 import 双向一致；含 viewer 更正） | `git grep -lE "from .*ts-shared" -- 'apps/*/src'` |
| R-10 | §3.4 + §4.3（脚本位置与注册） | `git ls-files 'apps/*/{scripts,test}/*'` 与注册键对照 |
| R-11 | §3.5（`.tmp/` 用于写死 outfile；temp 只放人工实验） | `Select-String 'outfile=' apps/*/package.json` |
| R-12 | §4.2（九键与固定值） | `package.json` scripts 逐字比对 |
| R-13 | §4.3（可达性闭包 + 命名规则 + 孤儿清单） | 差集脚本输出为空 |
| R-14 | §5.4（web/ 三产物 + dev 加载路径统一） | `web/` 清单一致 + 加载表达式唯一 |
| R-15 | §5.2（形态声明表 + multi 入口 + 全量重建） | `build-dist.cmd multi` 产物清单 |
| R-16 | §2.5（词表 + 三份逐字模板 + 失败块） | 词表 grep 与逐行 diff |
| R-17 | §5.3（dist 清单 + 许可证唯一源） | `Get-ChildItem dist` 清单（三个 dist 均含 `LICENSE.cs-movement`/`NOTICE.cs-movement`）+ `git grep -n "LICENSE.cs-movement" -- 'apps/*/scripts/build-dist.mjs'` 的源路径全部指向 `src/phys/` |
| R-18 | `documents/framework-decoupling.md`（上提阈值与裁决表）；本文件 §3.1「工程内禁止共享实现副本」为结构侧落点 | 该文档给出 |
| R-19 | `documents/framework-decoupling.md`（共享 shell 脚本落点）；本文件 §2.4.2/§3.3 固定**调用点与相对路径层数** | 该文档给出 + 本文件 §3.3 判据 |
| R-20 | `documents/framework-decoupling.md`（viewer 隔离/欠债的定性）；本文件 §3.4 已给出实测事实（viewer 零引用且未 include → 配置自洽） | 该文档给出 |
| R-21 | `documents/framework-decoupling.md`（例外表）；本文件 §8.2 已把「5 份 `[patch.crates-io]`、4 份 workspace 清单、4 份 `wasm.d.ts`」列为不可合并项 | 该文档给出 |

## 10. 待执行改造清单（本轮未执行）

### 10.1 文件级动作总表

| # | 文件 | 动作 | 依据 |
|---|---|---|---|
| 1 | `apps/game/start-dev.cmd` | 新建（§2.5.3） | R-01 |
| 2 | `apps/viewer/start-dev.cmd` | 新建（§2.5.3） | R-01 |
| 3 | `apps/debug/play.cmd` | 端口复用 + `[port]` + 横幅/词表 | R-03、R-05、R-16 |
| 4 | `apps/game/play.cmd` | 端口 `8091` + `[port]` + 复用 | R-02、R-03、R-05 |
| 5 | `apps/viewer/play.cmd` | 端口 `8101` + `[1/4]` 骨架 + 词表 | R-02、R-16 |
| 6 | `apps/debug/start-dev.cmd` | 前台服务 + `[port]` + 文案 | §2.6、R-03、R-16 |
| 7 | `apps/debug/build-dist.cmd` | `[0/5]`…`[5/5]` + 工具链 + 契约 + `call node` | R-16、§2.4.2 |
| 8 | `apps/game/build-dist.cmd` | 词表 + 端口文案 | R-16 |
| 9 | `apps/viewer/build-dist.cmd` | `[0/5]`…`[5/5]` + 契约检查 + 端口文案 | R-16 |
| 10 | `apps/viewer/scripts/build-dist.mjs` | 词表（7 处）+ `--multi` 显式报错；同批把共享 `src/serve.py:52-53` 的 `[错误]`/`[提示]` 改为 `[ERROR]`/`[HINT]` | R-16、§2.2 |
| 11 | `apps/debug/scripts/build-dist.mjs` | 全量重建 + 进度行前缀 | R-15、R-16 |
| 12 | `apps/game/scripts/build-dist.mjs` | 全量重建 + 许可证拷贝（源为唯一源 `src/phys/{LICENSE,NOTICE}`；含把 `apps/debug/src/physics/{LICENSE,NOTICE}` 上提为 `src/phys/{LICENSE,NOTICE}` 并同步第 11 条的 debug 拷贝源；与第 11 条同批，随 D-04 共享内核） | R-15、R-17 |
| 13 | `apps/debug/scripts/install-wasm-bindgen.cmd` | **上提**至 `src/scripts/install-wasm-bindgen.cmd`（D-02 定稿）并把内部调用改为同目录 `%~dp0cargo-env.cmd`；`apps/debug/build-dist.cmd`、`apps/debug/start-dev.cmd` 的调用点同步改为 `%~dp0..\..\src\scripts\install-wasm-bindgen.cmd`。**不得就地补 `..`**（该动作已被 [framework-decoupling.md](framework-decoupling.md) §6.2 T-02 否决） | §3.3、D-02 |
| 14 | `apps/debug/scripts/jump-apex-{verify,serve}.mjs` | 仓库根少一层 → 各补一层 | §3.3 |
| 15 | `apps/debug/tsconfig.json` | 删失效 `web/vendor` | R-08 |
| 16 | `apps/debug/src/main-wasm.ts` | dev wasm 路径改 `./<wasm>` | R-14 |
| 17 | `apps/debug/package.json` | 补 wasm 拷贝；注册 8 个孤儿脚本 | R-14、R-13 |
| 18 | `apps/game/package.json` | 端口；注册 13 个孤儿脚本 | R-02、R-13 |
| 19 | `apps/viewer/package.json` | 端口；补 `check:api`；`test:smoke`→`local:smoke`；`test:replay` outfile 改 `.tmp/` | R-02、R-12、R-11、§4.3 |
| 20 | `apps/viewer/scripts/check-wasm-api.mjs` | 新建薄配置，引擎取共享 `src/scripts/lib/wasm-api-contract.mjs`（D-03；与 §3.6 同一次动作，禁止先造出第 4 份副本） | R-12、D-03 |
| 21 | `test/dual-mode-harness/play.cmd`、`package.json` | 端口 `8110` | R-02 |
| 22 | `.github/workflows/deploy-pages.yml` | `npm run build:dist -- --multi`；补 game/viewer 的 `test:*` 步骤 | §6.2 |
| 23 | `apps/*/README.md`、`documents/**/*.md` | 端口引用随 §2.3 更新 | §2.3 |
| 24 | `CHANGELOG.md` | 记录本轮规范与后续改造 | [AGENTS.md](../AGENTS.md) §6 |

### 10.2 对 framework-audit.md 的三处更正

| # | 审计说法 | 实测更正 | 证据 |
|---|---|---|---|
| 1 | §4.1 称 `apps/viewer/tsconfig.json` 把 `../../src/ts-shared/**/*.ts` 纳入 `include`（并据此判 R-09/R-20 不成立） | viewer **未** include 共享层：`apps/viewer/tsconfig.json:15` = `["src/**/*.ts", "src/wasm.d.ts", "test/**/*.ts"]`；与其「零引用」自洽 | `apps/viewer/tsconfig.json:15` 全文 |
| 2 | 审计把「字面量」与「实际 import」两个口径混为一句，本文原表又误把 9 标成「实际 import 口径」 | 两种口径并列（captain 独立复测一致）：**字面量口径**（文件含 `ts-shared` 字样，含注释）debug **9** / game **6** / viewer **0**；**import 语句口径**（含 `import … from '…ts-shared/…'`）debug **6** / game **5** / viewer **0**。差异来自 4 个**纯注释**文件：debug 的 `game-state.ts`、`world/spawn-loader.ts`、`world/teleport-manager.ts`（9−6）与 game 的 `worker/worker-types.ts`（6−5） | 字面量：`git grep -l ts-shared -- apps/<app>/src` → 9 / 6 / 0；import：`git grep -lE "from .*ts-shared" -- apps/<app>/src` → 6 / 5 / 0。`apps/debug/src/world/types.ts` **不含** `ts-shared`（不参与任一计数）；debug 的 import 6 个 = `app.ts`、`input/keyboard.ts`、`input/input-recorder.ts`、`renderer/renderer-main.ts`、`worker/main.ts`、`physics/prediction-params.ts` |
| 3 | §7.3 把 R-11 记为「当前合规」 | 按 R-11 条文（写死 outfile 必须用 `.tmp/`）实测**不合规**：`apps/viewer/package.json:10` 的 outfile 为 `temp/replay-selftest.mjs` | `apps/viewer/package.json:10` 全文 |

### 10.3 执行顺序

1. 先做 §3.3 的层数修复与 §3.6 的配置修复（零行为变化，独立可验）：`apps/debug/scripts/jump-apex-{verify,serve}.mjs` 补一层、`apps/debug/tsconfig.json` 删失效 include、`apps/viewer/package.json` 的 outfile 改 `.tmp/`。`install-wasm-bindgen.cmd` 的层数问题**不单独修**——随第 13 条的 D-02 上提在同一次动作内消除（见下条）。
   - 与解耦方案的排期耦合（[framework-decoupling.md](framework-decoupling.md) §7.5 的硬约束）：D-01/D-02 的脚本上提属该文档「批 2」，与本文第 13 条**只执行一次**（禁止先就地补 `..` 再移动）；D-04 的 `build-dist.mjs` 内核抽取属「批 3」，必须排在本文第 3 步（§5 产物改造）之后，否则同一文件被两轮修改。
2. 再做 §2 的入口与端口改造（同一次提交内改 `.cmd` + `package.json dev` + 三份 README 端口）。
3. 最后做 §5 的产物改造（`build-dist.mjs` 三份）与 §6 的 CI 收敛（需与 §4.3 的脚本注册一起做，否则 CI 会引用不存在的键）。
4. 每批完成后执行 §11.2 的验收命令；`documents/` 内被引用的锚点行号若因改造漂移，按 [AGENTS.md](../AGENTS.md) §5.3 回改。

## 11. 验证方法

### 11.1 本文件自身的体检

- **行尾/编码**（纯 `fs`，任何沙箱可跑）：

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('documents/framework-launch-structure.md','utf8');const bom=s.charCodeAt(0)===0xFEFF;const cr=/\r(?!\n)/.test(s);const tw=/\r?\n[ \t]+\r?\n/.test(s);console.log('BOM:',bom,'loneCR:',cr,'trailingWS:',tw);process.exit(bom||cr||tw?1:0)"
```

- **锚点/行数声明**：`node src/scripts/check-doc-drift.mjs documents/framework-launch-structure.md`。该脚本在 `src/scripts/check-doc-drift.mjs:31` 用 `execFileSync` 起 `git` 子进程；在禁止子进程 spawn 的沙箱里会 `spawnSync git EPERM`（errno -4048）——这是环境限制而非文档缺陷，此时改用同样规则、纯 `fs` 的替代检查（把预生成的 `git ls-files` 列表喂给同一套 A/B 正则）。
- **相对链接**：本文件只链接真实存在的文件（[framework-audit.md](framework-audit.md)、[framework-decoupling.md](framework-decoupling.md)、[AGENTS.md](../AGENTS.md)），t7 实测链接失效 0。
- **冻结声明（t7）**：本文件在 t7 修复提交后**冻结**；后续任何改动必须另开修复任务，并在改动后重跑本节编码检查与 §11.1 的锚点检查（避免 t4 的哈希快照在验证中途失效，见 t4 的 F-12）。

### 11.2 规范落地后的验收命令

```bash
git ls-files '*.cmd'                                  # §2.2：每个应用工程恰好三件套
git grep -nE "set PORT=[0-9]+" -- apps test/dual-mode-harness   # §2.3：端口表逐条比对（精确匹配）
git ls-files src/phys                                   # §5.3：含 LICENSE / NOTICE（许可证唯一源）
git grep -nE "\*\*\* ERROR|\[错误\]|\[提示\]|\[warn\]" -- apps src   # §2.5.1：词表外标记为空
git grep -n "cmd /k" -- apps                           # §2.6：空输出
git grep -nE "node scripts/" -- .github/workflows      # §6.2：空输出
git ls-files -- '**/temp/**' '**/.tmp/**'              # §3.5：空输出
node src/scripts/check-doc-drift.mjs                   # 全仓文档体检（须在允许子进程的环境执行）
```
