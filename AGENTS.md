# AGENTS.md — 项目文件结构与 Agent 协作规范

> 面向在本仓库工作的 **AI / 自动化 Agent**。人类贡献者请看 [CONTRIBUTING.md](CONTRIBUTING.md)；
> 本文件只回答三件事：**东西该放哪、什么不能动、改完怎么验**。
>
> 事实基准：2026-09-12 全量核对（`git ls-files` + `git check-ignore` + 相对链接校验脚本）。
> 与代码/配置不一致时以实际为准，并回改本文件（同 [documents/index.md](documents/index.md) 的「文档铁律」）。

---

## 1. 仓库布局（唯一权威）

### 1.1 顶层

| 路径 | 定位 | 说明 |
|---|---|---|
| `apps/{debug,game,viewer}/` | 三个应用工程 | 各含完整前端与打包链，**互不引用** |
| `src/` | 共享层 | Rust 物理（`phys/` = `websurf-phys`）、BSP 解析（`wasm-core/` = `websurf-wasm-core`）、TS 物理渲染共享（`ts-shared/`）、`materials/`、`vendor/vmdl/`、`serve.py`、`scripts/`（cargo 环境 + 文档漂移体检 `check-doc-drift.mjs`） |
| `test/dual-mode-harness/` | 验证工程 | 三模式物理 + 渲染时序验证，**不参与 Pages 部署** |
| `documents/` | 文档树 | 根级 6 篇 + `debug/`、`game/`、`viewer/` 子树 |
| `.github/` | CI 与模板 | `workflows/deploy-pages.yml`、Issue / PR 模板 |
| 根级 `.md` | 仓库级元文档 | `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`AGENTS.md`（本文件） |

### 1.2 每个工程的标准布局

三个应用工程与验证工程遵循同一约定（细节略有差异）：

```
apps/<app>/
├─ crates/wasm/         # wasm 导出层 crate（唯一保留的 Rust 侧，命名 websurf-wasm / websurf-viewer-wasm 等）
├─ src/                 # TypeScript 源码（含 src/wasm.d.ts 手写契约桩）
├─ scripts/             # 构建与验证脚本（*.mjs；build-dist.mjs 各工程必有一份）
├─ web/                 # dev 页面：index.html / styles.css（入库）；app.js、worker.js、*.wasm（产物，不入库）
├─ Cargo.toml/.lock     # 模块 workspace（各自独立，target/ 留在本工程目录内）
├─ package.json         # scripts 为唯一入口：build:wasm / build:ts / build:dist / typecheck / check:api / test:*
├─ tsconfig.json
├─ play.cmd / build-dist.cmd / start-dev.cmd   # Windows 双击入口
└─ README.md            # 工程说明（已入库，四个工程均有）
```

`apps/viewer/` 另有 `test/`（TS 自检源码，如 `replay-selftest.ts`）；`apps/debug/` 另有 `fixtures/`（见 §4）。

---

## 2. 新增文件的归属（决策表）

| 你要放的东西 | 位置 | 备注 |
|---|---|---|
| 产品代码（TS） | `apps/<app>/src/` | 三个工程共用或应共用的逻辑 → 上提到 `src/ts-shared/` |
| WASM 导出层 | `apps/<app>/crates/wasm/src/lib.rs` | 只做导出；实现放 `src/`（共享层 crate） |
| Rust 物理 / 解析实现 | `src/phys/`、`src/wasm-core/` | **禁止**在工程内复制共享实现 |
| 验证 / 回归脚本 | 该工程 `scripts/`，并在 `package.json` 注册 `test:*` | 跨工程复现 → `test/dual-mode-harness/scripts/` |
| 编译器 / 环境脚本 | `src/scripts/` | 如 `cargo-env.cmd` |
| 自动化夹具（必须入库） | `apps/debug/fixtures/<主题>/` | 唯一允许入库的"数据"目录，见 §4 |
| 架构 / 实现文档 | `documents/<app>/{overview,sequences,implementation/*,differences}.md` | 命名固定，见 §5 |
| 历史归档文档 | 保持原处 + 标注 `superseded` | **新文档不得写入归档目录** |
| 一次性实验产物 | 该工程临时区（§3） | **结论必须提升，产物不得入库** |

---

## 3. 临时文件规范（重点）

### 3.1 允许的临时区（唯一）

仓库只认两类临时区，均已被 `.gitignore` 覆盖（`**/temp/`、`**/.tmp/`）：

- `apps/<app>/temp/` —— 工程内实验、量测、中间产物
- `apps/<app>/.tmp/` 或仓库根 `.tmp/` —— 构建/验证的中间产物

**根目录不得新开临时目录**（除 `.tmp/`）；不得在 `src/`、`test/`、`documents/` 下散落临时文件。

### 3.2 五条铁律

1. **产物不入库**：临时区的任何内容都不得 `git add`。若 `git status` 显示临时区被追踪，视为缺陷并移除追踪。
2. **临时区不是知识资产的存放地**：实验结论、验证数据、复现步骤必须提升到受控位置——
   结论 → `documents/` 对应篇章或 `CHANGELOG.md`；脚本 → 工程 `scripts/` 或 `test/`；夹具 → `apps/debug/fixtures/`。
3. **不得引用临时区路径**：任何入库文件（代码 / 文档 / 配置）都不允许把 `temp/`、`.tmp/` 当作事实来源或依赖。
   脚本若需读写中间产物，路径必须由其自身在同一次运行内创建并在结束时清理。
4. **临时区随时可被清空**：任何流程不得依赖临时区"已经存在"或"历史留存"。删除后 `npm run build` + 验证脚本必须仍能通过。
5. **清理前先做提升检查**：删除临时区前，逐项确认没有未提升的结论或数据（对照 §3.4）。

### 3.3 临时区实况（2026-09-12 清理后核对）

**已清理**（清理前 105 文件 / 约 25 MB；全部先备份到仓库外 `D:\code\projects\websurf-cleanup-backup-2026-09-12\`）：

| 路径 | 清理前 | 内容 | 判定依据 |
|---|---|---|---|
| `apps/debug/.tmp/` | 52 文件 / 12.5 MB | `test:*` 脚本的 esbuild 中间产物 | 由脚本按需重建 |
| `apps/game/temp/` | 43 文件 / 11.8 MB | 物理实验全量产物（含 2 份 3.7 MB wasm 备份） | 结论与仪器已提升入库（`documents/phys.md` §3.5 + `apps/game/scripts/` 5 个脚本） |
| `apps/viewer/temp/` | 7 文件 / 0.08 MB | 自检中间 bundle + 已废弃的一次性量测脚本 | `npm run test:replay` 可重建；量测已被 `apps/viewer/test/smoke-cdp.mjs` 取代 |
| `.tmp/`（仓库根） | 1 文件 / 0.6 MB | `e2e-fixed.json` 一次性数据 | 无引用 |
| `apps/debug/npm-ci-test.log` | 1 文件 | CI 排查日志 | 日志不入库 |

**保留**（正常产物，可由构建再生）：`apps/*/{dist,pkg}/`、`test/dual-mode-harness/{pkg,app.js,worker-a.js,worker-b.js,websurf_test_wasm_bg.wasm}`、各工程 `web/{app.js,worker.js,*.wasm}`、`node_modules/`、仓库根 `target/`。

**常态应为空**：清理后临时区只在需要时「按需创建」——`test:*` 脚本自建 `apps/debug/.tmp/`，`apps/game/scripts/wasm-hash-pin.mjs` 自建 `apps/game/temp/`（脚本内已 `mkdirSync`）。用完即删，不要留档。

### 3.4 清理临时区前的检查清单

```bash
git status --ignored --short apps/          # 确认待删内容确实未入库
git ls-files -- '**/temp/**' '**/.tmp/**'   # 期望输出为空
```

再逐条确认：**结论已写进 `documents/` 或 `CHANGELOG.md`？脚本已移入 `scripts/`？夹具已移入 `fixtures/`？**
四项都确认后才可删除。

---

## 4. 生成物与「勿手改 / 勿清理」清单

**不要手改**（改源码后重建）：

- `apps/*/web/app.js`、`apps/*/web/worker.js`、`apps/*/web/websurf_*_wasm_bg.wasm`、`test/dual-mode-harness/{app.js,worker-a.js,worker-b.js,*.wasm}`
- `apps/*/{pkg,dist}/`、`test/dual-mode-harness/pkg/`、`target/`、`node_modules/`
- `apps/viewer/dist/README.md`（由 `apps/viewer/scripts/dist-README.md` 生成）

**不要清理**（看似临时但是资产）：

- `test/maps/` —— 本地地图与录像（`*.bsp` / `*.dem` / `*.replay` 一律不入库，仅本地留存）
- `apps/debug/fixtures/path/tick-on-render-prefix.json`（784 KB，已入库）—— CI 门禁 `test:path-acceptance` 的**故意失败**基线夹具。保留 `!apps/debug/fixtures/path/` 的 `.gitignore` 例外
- 仓库根 `target/` —— 根 workspace（共享层两个 crate）的编译缓存
- 各工程 `Cargo.lock` / `package-lock.json` —— 依赖锁定，必须入库

---

## 5. 文档编写规范

### 5.1 位置与命名

- **仓库级 / 共享层** → `documents/` 顶层：`architecture.md`、`phys.md`、`wasm-core.md`、`ts-shared.md`、`materials.md`、`index.md`
- **工程文档** → `documents/<app>/`，四维度固定命名：
  `overview.md`（总览）、`sequences.md`（时序）、`implementation/<主题>.md`（细分实现）、`differences.md`（与其他工程的差异对照）
- 一个主题一篇，**文件名用 kebab-case**；不要新建 `xxx-v2.md`、`xxx-new.md`，就地更新并在 CHANGELOG 记录
- 新增 / 移动文档后，必须同步 `documents/index.md` 的导航与篇数统计

### 5.2 结构与格式

- 一级标题唯一且等于文件名主题；**标题层级不得跳级**（`#` → `##` → `###`）
- 表格列数保持一致；代码块用围栏并标注语言
- 长行不强制换行（与现有文档一致），但单行不要塞入两个以上并列主题
- 行尾统一 **CRLF**、UTF-8 **无 BOM**（Windows 仓库约定，`core.autocrlf=true`）；不要引入行尾空白
- **禁止 `CR CR LF`（多 CR）行尾**：2026-09-12 已清理 30 个此类文件（会误导按行解析的工具与编辑器）。体检（无输出即合规）：

```bash
node -e "const{execFileSync:e}=require(\"child_process\"),f=require(\"fs\");for(const p of e(\"git\",[\"ls-files\",\"*.md\",\"*.cmd\",\"*.ts\",\"*.mjs\",\"*.json\",\"*.rs\",\"*.py\",\"*.yml\"],{encoding:\"utf8\"}).split(\"\\n\").filter(Boolean)){let b;try{b=f.readFileSync(p)}catch{continue}for(let i=0;i<b.length;i++)if(b[i]===13&&b[i+1]!==10){console.log(\"多/孤立 CR: \"+p);break}}"
```
- 正文用中文；代码 / 路径 / 命令中的引号一律用 ASCII 直引号

### 5.3 引用与链接（迁移后必查）

**文档漂移体检**：`node src/scripts/check-doc-drift.mjs`（可在仓库根直接运行；可传单文件参数）

- 校验 **A 行数声明**（`path`(NNN) / `| path | NNN |` 是否等于实测 `wc -l`）与 **B `文件:行号` 锚点是否越界**，A/B 非空即 `exit 1`（可接 CI）；同时列出 C 路径失效（告警，历史叙述里的旧路径属刻意保留）与 D 无法消歧的裸文件名（计数）。
- **能力边界**：锚点只查「是否越界」，不查「该行内容是否与描述相符」——文件在锚点之前增删代码会造成「在范围内但错位」（2026-09-12 实测到一例：`apps/game/src/worker/main.ts:86` 实际已迁到 `:429`）。因此**改动被文档引用的文件后，必须回看该文件相关的锚点**，不能只依赖脚本。

- 代码锚点统一写作 `` `文件:行号` ``，且**必须能在仓库内定位**；与代码不一致时以代码为准并回改文档
- 所有相对链接必须指向真实存在的文件或目录；**移动目录（如工程迁入 `apps/`）后必须全量复校**
- 提交前跑一次链接校验（本仓库已验证可用的脚本）：

```js
// node scripts 之外的一次性检查：校验指定 md 的相对链接是否可达
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
for (const rel of process.argv.slice(2)) {
  const abs = path.resolve(ROOT, rel);
  const miss = [...fs.readFileSync(abs, 'utf8').matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((t) => !/^(https?:|mailto:|#)/.test(t))
    .filter((t) => t.split('#')[0])
    .filter((t) => !fs.existsSync(path.resolve(path.dirname(abs), decodeURIComponent(t.split('#')[0]))));
  console.log(`${rel}: ${miss.length ? '❌ ' + [...new Set(miss)].join(', ') : '✅'}`);
}
```

---

## 6. Agent 工作流

**改前**：读 [CONTRIBUTING.md](CONTRIBUTING.md) 的规范条款 → 确认目标文件归属（§2）→ 共享层改动先确认 `src/` 而非工程内。

**改中**：

- 涉及物理 / 时序 / 渲染的改动同步补验证脚本，不靠肉眼判断
- 移动或改名文件后，同步：`package.json` / `.cmd` / CI `working-directory` / 文档链接 / 各工程相对依赖路径（`crates/wasm` → `../../../../src` 一类，**层数易错**）

**改后**（缺一不可）：

```bash
npm run typecheck                     # 在受影响的工程目录
npm run <对应 test:* 脚本>            # 见 CONTRIBUTING §4 的验证脚本表
git status --short                    # 确认只有预期文件变动，无临时产物混入
git ls-files -- '**/temp/**'          # 期望为空
git status --short --untracked-files=all   # ?? 即「未追踪且未被忽略」→ 会被误提交，须逐条确认
```

**提交信息**：Conventional Commits（`type(scope): 摘要`），scope 用 `repo` / `apps` / `ci` / `debug` / `game` / `viewer` / `dual-mode-harness` / `phys` / `wasm-core`。

**汇报要求**：结论给证据（命令、输出、`文件:行号`），不要只给判断；发现自己上一轮的结论有误时主动更正。

---

## 7. 问题台账（核对于 2026-09-12）

### 7.1 已闭环（2026-09-12 清理批次）

| # | 问题 | 处置 |
|---|---|---|
| 1 | `apps/debug/README.md` 2 处失效链接 | `../../documents/debug/archive/` → 「已移出版本库」表述；`../README.md` → `../../README.md`；头部「独立工程 `debug/`」→ `apps/debug/` |
| 2 | `apps/game/README.md` 3 处失效链接 + `..\src\serve.py` 少一层 | 链接与路径全部修正（`../../test/...`、`..\..\src\serve.py`） |
| 3 | `documents/index.md`：8 处失效链接、篇数 29→24、根 5→6 篇、2 张指向已删目录的表 | 链接修正、计数更新、死表替换为「已移出版本库」说明 |
| 4 | 另有 7 处失效链接（`documents/game/overview.md`、`documents/viewer/{overview,replay-rule-ai}.md`、`test/dual-mode-harness/docs/sequences.md` 等） | 全部修正 → **全仓 md 相对链接 100% 可达** |
| 5 | 实验结论留在忽略目录（`apps/game/temp/phys-t13/t13-conclusion.md`） | 结论入库为 `documents/phys.md` §3.5；仪器提升为 `apps/game/scripts/{phys-seed-smoke,wasm-hash-pin,t13-input-surface-probe,t13-literal-sweep,t13-ulp-sensitivity-control}.mjs`——5 个脚本均实测可运行，种子面回归 **7/7 通过** |
| 6 | 入库文档引用忽略目录（`architecture.md` 把 `apps/game/temp/` 列为产物位置） | 引用改为 `documents/game/`、`apps/game/web/`；pathspec 补 `apps/`；`materials.md` 的归档承接表述同步更新 |
| 7 | 遗留重复文件 `apps/game/serve.py` | 删除（共享 `src/serve.py` 为超集：支持 `root_dir` 参数、`SO_REUSEADDR` 与友好报错） |
| 8 | 30 个已入库文件存在 `CR CR LF` / `CR CR CR LF` 行尾 | 规范化为标准 CRLF；逐文件验证「去掉 CR 后与 HEAD 字节全等」，内容零变化 |
| 9 | 临时区堆积 105 文件 / 约 25 MB | 清理并更新 §3.3；备份留存 `D:\code\projects\websurf-cleanup-backup-2026-09-12\` |
| 11 | 文档「文件地图」漂移：10 处行数声明过期、2 处锚点越界、10 处遗留 `game/` / `debug/` / `viewer/` 前缀、1 处因删除 `apps/game/serve.py` 而失效的引用 | 全部按实测代码修正（行数取 `wc -l`、锚点定位到现行行号、前缀补 `apps/`、`serve.py` 引用改为共享 `src/serve.py:31-36`）；并新增体检工具 `src/scripts/check-doc-drift.mjs`（A/B 失败退出码 1），当前 117 条行数声明与 1428 个锚点**零漂移/零越界**（383 处跨工程裸文件名属固有歧义，脚本给出计数供人工判读） |
| 10 | 被追踪的内容重复：`apps/{debug,game}/src/input/{mouse-buffer,pointer-lock}.ts` 字节全等（违反「勿在工程内复制共享实现」） | 上提为共享单份 `src/ts-shared/input/`，两端 `app.ts` 导入同源；文档与注释同步（`documents/{game/overview,game/implementation/panel-and-input,debug/sequences,debug/overview,debug/differences}` + `test/dual-mode-harness/src/main.ts`）；验证：两端 `typecheck` 与 `build:ts` 均 exit 0，产物 `web/app.js` 内含共享模块特征串 |

### 7.2 仍需处理

| # | 问题 | 证据 / 建议 |
|---|---|---|
| 7.2.1 | 被追踪的内容重复（余 2 组，判定为**设计使然**） | ① `apps/debug/Cargo.toml` == `apps/game/Cargo.toml`（各工程独立 workspace 清单）、② `apps/debug/scripts/ensure-node-deps.cmd` == `apps/game/scripts/ensure-node-deps.cmd`（fresh-clone 自举脚本按工程各存一份）——**建议保持现状**；输入层的重复已于 §7.1 第 10 项闭环 |
| 7.2.2 | 代码注释引用已移出的规划文档 | `src/ts-shared/{auth,tick}/*.ts` 共 3 处引用 `temp/phys-plan-discuss/…`，均**已自带「2026-09 清理」标注**，属诚实记载，无需修改 |
| 7.2.3 | `.agent-teams/` 工具状态目录留在工作区 | 已被 `.gitignore` 忽略；如不再使用可删除，删除前确认无运行中的编排流程 |

> 处理本表任一问题后，请同步更新本表并（如涉及）补 `CHANGELOG.md` 条目。
