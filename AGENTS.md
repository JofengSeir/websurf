# AGENTS.md — 当前任务行为规范与进度纪要（文档/注释重编）

> **本文件是当前唯一生效的 Agent 工作规范**，取代 2026-09-22 之前的旧 `AGENTS.md`。
> **当前任务**：以**源码为唯一事实来源**，重写本仓库当前工况的全部文档与代码注释。
> **控制文件已退役（2026-09-23 owner 裁决）**：原 plan 目录下三篇控制文件（project-survey 事实基线 / doc-rewrite-taskbook 任务书 / progress-log 进度台账）随重编任务完结删除，仅存 git 历史（最后一次完整版本为 commit `9dbdc58`）。**此后任务待办只记录于本文件**；注释书写规范与陷阱沉淀见 `documents/norms/annotation-and-verification.md`。
>
> **工况基线（owner 定调）**：受控工程 = `apps/debug` + `apps/game` + `apps/viewer` + 共享层 `src/`。
> `test/dual-mode-harness/` **已退役**：已从工作区移除（39 个文件，含 `src/**`、`crates/wasm/**`、`scripts/**`、`package.json`、`Cargo.toml`、`Cargo.lock`、`tsconfig.json`），**不恢复、不重编、不作事实来源**。

---

## 1. 三条硬禁令（违反即返工）

| # | 禁令 | 含义 |
|---|---|---|
| **B1** | 禁以旧注释为依据 | 不得摘抄、复述、沿用任何现有代码注释——它们正是重写对象。语义只能从实现、调用点、测试取得 |
| **B2** | 禁以旧文档为依据 | 旧文档已从工作区删除（仅存于 git 历史，**不得读取、不得引用、不得当作回滚依据**）；任务必须能在文档树为空时从源码重建 |
| **B3** | 禁推测 | 无法在代码中定位的结论标 `[待确认]` 并停下上报；禁止"应该/可能/大概是/历史上" |

**取证手段**：源码行、构建脚本、配置、以及 `cargo check` / `cargo test` / `npm run typecheck` / 漂移体检的**实际输出**。代码历史（`git log`/`blame`）可作线索，但最终以当前代码为准。

---

## 2. 目录现状（最后一次修订时复核）

| 位置 | 状态 |
|---|---|
| 仓库根 `*.md` | 本文件 + `README.md` + `CHANGELOG.md` + `CONTRIBUTING.md` + `SECURITY.md`。后四篇于 2026-09-22 由 `.archive/` 归档原文**合并重建**（可读性改写：README 为总入口，CHANGELOG 分「当前状态 / 归档历史」两段，贡献与安全各一篇），细节源头仍是 `.archive/` |
| `documents/` | **46 篇**（2026-09-23 删 plan 后实测）：architecture / phys / wasm-core / ts-shared / materials / debug / game / viewer / norms 九棵子树；原 plan/ 三篇控制文件已随任务完结删除（owner 裁决）。**实测删除面**：`documents/` 下原 **47 篇** `.md`、根级 **4 篇** `.md`、退役 harness **39** 个路径（含 5 篇 `.md`）、apps/game 的 favicon.ico 1 个，合计 **91** 个路径（`git status` 实测） |
| `test/` | 仅 `test/maps/`（BSP 夹具）与 `test/replay/`（录像样例），两者均 gitignore；`test/dual-mode-harness/` 已退役 |
| `.archive/` | **存在**：旧文档归档区（根 5 篇 + `documents/**` 45 篇 + 退役 harness `docs/` 5 篇 ≈ 57 篇，保留相对路径）。**不作事实来源**，只用于历史追溯与本次根文档合并的素材；owner 定名 `.archive`（本文件早期写的 `.ak/` 为误记，以实际目录为准） |
| `test/` | 仅 `test/maps/`（BSP 夹具）与 `test/replay/`（录像样例），两者均 gitignore；`test/dual-mode-harness/` 已退役 |
| `apps/debug/scripts/path-baseline.md`、`apps/viewer/scripts/dist-README.md` | **保留**（构建脚本资产，非文档树；其中 dist-README 被 `build-dist.mjs` 消费，不可删） |
| `.github/**/*.md` | **保留**（PR / Issue 模板，功能性配置，不属本次重编范围） |
| `.workbuddy/memory/**` | Agent 工作记忆（非文档树、不重编；仅作过程线索，不作事实来源） |

---

## 3. 执行流程（六步法）

| 步 | 动作 | 产出 | 验收 |
|---|---|---|---|
| **S0** | 骨架定位：确认文件在架构与时序骨架中的位置（骨架原存 `project-survey.md` §12，该文件已退役） | 骨架标注 | 能给出上下游各一个调用点（带行号） |
| **S1** | 读码（按入口清单逐个打开；清单原存 `project-survey.md` §13，该文件已退役） | 读码笔记（临时区） | 覆盖每个导出项、常量、分支语义 |
| **S2** | 记录事实：事实 → 证据（`文件:行号`） | 事实表 | 每条有锚点；无法定位标 `[待确认]` 并上报 |
| **S3** | 重写（原地覆盖，禁止 `xxx-v2.md`） | 新稿 | 无推测措辞；术语统一；CRLF + UTF-8 无 BOM；**代码注释内一律不写行号**——同文件用符号名，跨文件用「相对仓库根路径 + 符号名」；文档的锚点写法不变，仍按重编期任务书 §11 的约定写 `` `文件:行号` `` |
| **S4** | 自检：漂移体检 + 来源审查 + 编译/类型检查 | 自检记录 | 见 §5 |
| **S5** | 提交（单文件/单模块一次提交） | 一个 commit | 提交信息含事实来源、自检命令、遗留 `[待确认]` |

**阶段 A0（强制第一步）**：任何文件重写前，先产出本范围的"架构与时序骨架"（数据流 / 时序 / 模块边界 / 关键不变量，全带锚点），通过主控评审才准动笔。

---

## 4. 范围与优先级

| 级 | 内容 |
|---|---|
| P0 | `src/phys/**`、`src/wasm-core/**` 注释（共享层，起点注释密度最低：phys 16% / wasm-core 11%；phys 经 WG1 首件已升至 19%） |
| P1 | `src/ts-shared/**`、三工程 `src/**` 与各 `crates/wasm/src/lib.rs` 注释 |
| P2 | 共享层文档：phys / wasm-core / ts-shared / materials / architecture |
| P3 | 三工程子树：overview / sequences / implementation / differences / README |
| P4 | 根 README / CHANGELOG / 规范类篇 / **index 导航（最后按实际文件重建）** |

**排除**：本文件与两篇控制文件、`node_modules/`、`target/`、`pkg/`、`dist/`、`web/app.js`、`web/worker.js`、`web/*.wasm`、`test/maps/`、`test/replay/`、`apps/debug/fixtures/**`、`Cargo.lock`、`package-lock.json`、`.github/**` 模板、`.workbuddy/`。

---

## 5. 自检命令（每个文件提交前必跑）

```bash
node src/scripts/check-doc-drift.mjs [文件]       # 0 漂移 / 0 越界
grep -n -E "据文档|据注释|原设计|历史上|应该|可能|大概|似乎|推测" <新稿>   # 0 命中
grep -n -E "test/game-core|dual-mode-harness" <新稿>   # 0 命中（两者均已不在工作区）
cargo check -p websurf-phys                       # 或工程内 cargo check
cd apps/<app> && npm run typecheck                # TS 侧
```

**全量闸门（WG11）**：全仓漂移体检 0 越界；`cargo test -p websurf-phys` 通过；三工程 `npm run typecheck` 通过；README ↔ index ↔ 工程 README 口径一致。

---

## 6. 上报约定

**六类必须停下上报**（不得"先写着"）：① 代码自相矛盾；② 疑似代码缺陷（只记录不修）；③ 文档断言无法在代码中定位；④ 锚点越界且无法判断指向；⑤ 需改代码/构建配置才能让文档成立；⑥ 涉及夹具、依赖锁、CI 配置。第七类：注释与代码冲突时按代码写，**不得把旧注释内容记入新稿**。

上报后文件保持**未提交**；不得带 `[待确认]` 进入提交。升级路径：工作组 → 主控 → 仓库 owner。

---

## 7. 进度纪要

> 规则：每次提交/阶段性完成后，**由执行者就地更新本节**（追加一行，不改历史行；已知错误记录另起一行更正）。状态取值：`未开始 / 进行中 / 已完成 / 阻塞 / 已撤销`。

### 7.1 已完成 / 已发生

> **历史台账已退役（2026-09-23 owner 裁决）**：重编任务完结，原 plan 目录三篇控制文件（事实基线 / 任务书 / 进度台账）已从工作区删除，仅存 git 历史（最后一次完整版本为 commit `9dbdc58`）。
> **此后规则**：进展与待办**只追加到本文件**（§7.1 摘要 / §7.3 索引），不再写入 plan/ 台账；历史规范与陷阱沉淀在 `documents/norms/annotation-and-verification.md`。本文件各处「台账」均指该历史台账（git 历史 commit `9dbdc58`）。

| 日期 | 最近进展（摘要；文中「台账」均指上述已退役的历史台账） |
|---|---|
| 2026-09-22 | WG1 `src/phys/**` **7/7**、WG2 `src/wasm-core/**` **26/26**、WG3 `src/ts-shared/**` **非测试件 19/19 + 测试件 4/4 全部完成**，均已通过主控独立复验 |
| 2026-09-22 | WG4 `apps/debug`：**19 件经主控独立复验通过**；复验中修掉 8 处失败（5 件禁用词、3 件 bareLF 行尾）；新增两条**内容审查手段**与一条**新陷阱**（详见历史台账与 §7.3 #41/#42） |
| 2026-09-23 | **重编成果验收审查（主控自做）：六面体检全绿、无返工项**——漂移越界 0 / 路径失效 0 / 源码禁用词 0 违规 / 受控面行尾 BOM 全合规 / `cargo check` + 三工程 typecheck 全绿 / 口径一致（`src/phys/mod.rs` 头注「24 个 pub fn」与代码一致）；**新发现 1 处措辞漂移 → §7.3 #71**；**口径更正**：#68①（check-shared-sync 四门禁恒失败）经核实**已于 2026-09-22 结案**（上轮审查答复误判为开放项、已在本轮更正；判读遗留项状态以本文件 §7.3 索引行为准，原台账小节已随 plan 目录退役） |
| 2026-09-23 | **plan 目录退役（owner 裁决）**：原 `documents/plan/` 三篇控制文件（事实基线 / 任务书 / 进度台账）随重编任务完结删除，仅存 git 历史；全仓 9 个文件的引用同步清理（本文件 / README / CHANGELOG / CONTRIBUTING / documents 的 index·norms·architecture·ts-shared / src/scripts/check-doc-drift.mjs 注释），漂移体检复跑 0 失效。**此后任务待办只记录于本文件，不再写入 plan/ 台账** | AGENTS.md 等 9 个文件 |


### 7.2 工作组状态

| 组 | 范围 | 状态 | 依赖 |
|---|---|---|---|
| WG-A0 | 全局架构与时序骨架（Q1–Q8） | **进行中**（骨架落在 survey §12/§13；已按三工程工况重划） | — |
| WG1 | `src/phys/**` 注释 | **已完成（7/7）**：全部文件通过主控复验（代码逐行一致、来源审查 0 命中）。**本轮补做「去行号」**：该组 7 件的 `文件:行号` 锚点已全部改为符号引用，复扫锚点 0、复验 0/7 失败、`cargo test` 10 passed | A0 |
| WG2 | `src/wasm-core/**` 注释 | **已完成（26/26）**：`src/wasm-core` 下 26 个 `.rs` **全部已改动、无一遗漏**；全量复验 26/26 exit 0（`stripTrail` 逐行 d0；`strict` 的 d4/d6/d8 经新判据确认为行尾注释改写）、禁用词 0、CRLF 无 BOM、`cargo check` exit 0、锚点扫描 0 违规。**遗留 3 项均已登记**：`lightmap.rs` 错误消息字符串里的 1 处外部引用（§7.3 #28）、`materials.rs` 空白行尾随空格归一（#33）、`convert.rs` 约 500 行死代码（#34）。**本轮补做「去行号」**：26 件的 `文件:行号` 锚点已全部改为符号引用，复扫锚点 0、复验 0/26 失败、`cargo check` exit 0 | A0 |
| WG3 | `src/ts-shared/**` 注释 | **已完成（非测试件 19/19 + 测试件 4/4）**：非测试件 19 件一次跑 `verify.ps1` 0 失败；4 个 `*.test.ts` 由主控自做 3 件（`auth/compute-mode`、`tick/ordering-gate`、`auth/shared-state.protocol`）、子代理 1 件（`auth/tick-authority`），**全部经主控独立复验**：`stripTrail` 逐行 d0（89 / 193 / 268 / 636 行）、`anchor-scan` 违规 0、**esbuild + node 实跑 45 / 46 / 75 / 19 例全绿 exit 0**、三工程 typecheck exit 0。骨架 `.tmp/wg3/skeleton.md` | A0 |
| WG4 | `apps/debug`（33 件源码 + 18 个脚本） | **已完成（源码 33/33 + 脚本 18/18）**。四道门全绿：`verify.ps1` **0 失败**（`stripTrail` 全 d0）、`anchor-scan` **锚点 0 / 违规 0**、`template-proof` **158 个模板字符串逐字节相同**、`apps/debug` typecheck **exit 0**、`cargo check`（`apps/debug/crates/wasm`）**exit 0**。**过程与 A/B/C 明细逐行见历史台账（已退役删除，git 历史 commit `9dbdc58`）**（19 件子代理批、15 件小文件批、8 件脚本批、4 件脚本批、`renderer/lightmap-shader.ts` 三工程同构副本、脚本 5 件主控自做） | A0 + WG1–3 |
| WG5 | `apps/game`（14 件源码 + 20 个脚本） | **源码已完成（14/14）**；脚本进度见 WG5b 行。四道门：`verify.ps1` **0 失败**（`stripTrail` 全 d0）、`anchor-scan` 锚点 0、`template-proof` 30 模板逐字节相同、`content-review` 全命中、`apps/game` typecheck **exit 0**、`cargo check`（`apps/game/crates/wasm`）**exit 0**。**A/B/C 明细与主控开箱复核记录逐行见历史台账（已退役删除，git 历史）**（含「`extras.faceIndex` 假断言」「γ 接受窗口」等） | 同上 |
| WG6 | `apps/viewer`（29 件 + WG6b 5 件） | **已完成（29/29 + WG6b 5/5）**：`verify.ps1` **0 失败**（除 `dist-README.md` 这一 prose 资产按陷阱第 13 条判）、`stripTrail` 全 d0、`anchor-scan` 锚点 0、`template-proof` 全同、`content-review` 全命中、`apps/viewer` typecheck **exit 0**、`cargo check`（`websurf-viewer-wasm`）**exit 0**。**A/B/C 明细与独立审查员记录逐行见历史台账（已退役删除，git 历史）**；待决项见 §7.3 #54/#55/#58/#59/#61/#64 | 同上 |
| WG4b | `apps/debug/scripts/**` 剩余脚本与资产 | **已完成（18/18）**：`pages-index.html` **已完成**（主控自做；实测为 `deploy-pages.yml` 消费的部署站入口页模板，按脚本资产处理——改写 2 处事实错误、删 1 处不可定位断言，四道门 + 新增「标签序列」结构门全绿，详见台账）；**4 件批已完成并复验（17/18）**：`jump-apex-measure`、`jump-apex-verify`、`plot-path`、`path-acceptance`（四件代码行与 HEAD 逐行相同、78 模板全同、`node --check` 4/4；其中 `jump-apex-verify` 的 `禁用路径=3/基线3` 促成 `verify.ps1` 判据升级为基线判，详见台账）；**末件 `input-replay-verify.mjs` 已完成并复验**（1228 → 1256 行；代码行 1061 逐行同 HEAD、2 处行尾注释改写、**126 个模板字符串逐字节相同**、`node --check` exit 0；**登记疑似缺陷 6 条 → §7.3 #66**，最重一条为**链路级**：全仓只有 `apps/debug/src/app.ts` 的 `replayCapture.record` 一处录制入口，本脚本等的却是 `inputRecorder` 的产物 ⇒ 录制载荷恒为 0 帧、A 段必然失败、脚本最终只打印「回放未能开始」）。`path-baseline.md` 按 §2 属**保留的脚本资产**（是否按源码校对待 owner 定） | WG4 |
| WG5b | `apps/game/scripts/**`（20 件） | **已完成（20/20）**：`check-wasm-api.mjs` 已改；主控自做并复验 **`t13-literal-sweep` / `t13-ulp-sensitivity-control` / `t13-input-surface-probe`**；**11 件批已完成并复验**（`_dbg_keys`/`_dbg_floor`/`phys-p2-trace`/`wasm-hash-pin`/`phys-diag-flat`/`phys-gate-probe2`/`phys-p2-ground`/`phys-p2-regression`/`phys-teleport-gate`/`phys-surf-crouch-smoke`/`phys-smoke`）——tracked 9 件 `verify.ps1` **0/9**、锚点 0、30 模板逐字节相同、`content-review` 57 路径 + 30 符号全命中、`node --check` 11/11；两件 gitignored（`_dbg_*`）改用**编辑前快照比对**（`strict`/`stripTrail` 双 d0；规则见规范篇陷阱第 12 条）；**A 18 / B 3 / C 6**。**主控又完成 1 件**（`phys-rate-parity.mjs`：四道门 + `node --check` 全绿，A 类含「混合分区」时长/结果与 `flatTop` 的 AABB 覆盖不一致，见 §7.3 #62）⇒ **16/20**；**末批 4 件已完成并复验**（`phys-seed-smoke` 361→377、`build-dist` 220→237、`phys-rate-parity-v2` 202→219、`phys-dual-pipe` 199→209：`verify.ps1` **0/4**、`stripTrail` 全 d0、锚点 0、**76 个模板字符串逐字节相同**（9 件合跑）、`content-review` 33 路径 + 12 符号全命中、`node --check` 9/9；主控抽查「掩码 30 = 24+6」与「`KEEP_SINGLE` 缺 `coi-serviceworker.js`」两条断言均成立；**登记疑似缺陷 15 条 → §7.3 #67**） | WG5 |
| WG6b | `apps/viewer/scripts/**` + `apps/viewer/test/**` | **已完成（5/5）**：`scripts/build-dist.mjs`（352 → 356）、`scripts/dist-README.md`（86 → 94，prose 资产，判据见规范篇陷阱第 13 条）、`apps/viewer/test/replay-selftest.ts`（837）、`apps/viewer/test/smoke-cdp.mjs`（875 → 880）、`apps/viewer/test/node-shims.d.ts`（9 → 10）；代码同一性判据 verify.ps1 **0/4**（四件 `strict`/`stripTrail` 全 d0）、`anchor-scan` 0、`template-proof` 80 模板逐字节相同、`content-review` 6 路径 + 1 符号全命中、`node --check` 2/2。**A 15 / B 3 / C 11 / X 14**；`replay-selftest.ts` 的已删文档引用已清；**登记疑似缺陷 5 条（→ §7.3 #64）**，最重一条是 `test/maps/surf_null_4.replay` 路径失效（跨 3 文件） | WG6 |
| WG7 | ~~`test/dual-mode-harness`~~ | **已撤销**（工程已退役，不再重编） | — |
| WG8 | 共享层文档 5 篇 | **已完成（5/5）+ 规范篇 1 篇**：已落 `documents/architecture/overview.md`（受控范围 / 共享层构成 / 依赖方向 / 入口锚点 / 启动链与帧链 / 不变量 / 构建产物）与 `documents/ts-shared/overview.md`（目录职责 / 接口锚点 / 主流程 / 不变量 / **未接线与零调用点清单** / 测试与门禁）。两篇均通过 `check-doc-drift`（**12 篇 md / 锚点 131 / 越界 0 / 路径失效 0 / exit 0**）。**另落规范篇 1 篇**：`documents/norms/annotation-and-verification.md`（事实来源与三条禁令 / 注释书写规范 / **四道门** / 内容审查两手段 / 7 条已验证陷阱 / 记录约定）。**5 篇全部落盘**：`documents/architecture/overview.md`、`documents/phys/overview.md`、`documents/wasm-core/overview.md`、`documents/ts-shared/overview.md`、`documents/materials/overview.md`。**主控逐篇开箱抽查锚点**（phys 11 个、materials 6 个、wasm-core 8 个）全部指向所述符号；体检实测 **16 篇 md / 锚点 193 / 越界 0 / 路径失效 0 / exit 0**；三篇新稿禁用词全 0。**另记一处自查踩坑**：`documents/phys/overview.md` 初稿把「测试模块 + 项数」写成表格行，被体检判为**行数声明漂移**（裸文件名 + 数字），已改为行文表述——这与 §7.3 #47 同源 | WG1–3（已具备） |
| WG9 | 三工程子树 | **已完成（debug 13/13、game 14/14、viewer 12/12 共 39 篇，全部经主控独立复验）**：统一模板与验收口径在 `.tmp/wg9/TEMPLATE.md`（节标题固定 / 锚点格式 / 禁止跨工程类推 / 6 道门 / 报告六节），行尾归一器 `.tmp/wg9/normalize-crlf.mjs`。**viewer 复验实测**：12 篇全 `CRLF` 无 BOM、`content-review` **101 路径 + 11 符号全命中**、`anchor-scan` 违规 0、`link-check` 0 缺失、禁用词 0；抽样 **44 条**锚点逐条开箱全部命中所述符号（另复核 3 条实质断言）。**game 复验实测**：14 篇全 `CRLF` 无 BOM、`content-review` **90 路径 + 25 符号全命中**、`anchor-scan` 违规 0、`link-check` 0 缺失、禁用词 0；抽样 **45 条**锚点全部命中；**交付方另实跑 `cargo check --manifest-path apps/game/crates/wasm/Cargo.toml` exit 0** 与 `phys-p2-regression.mjs`（12 组 5 组发散、**exit 0** ⇒ 与 #63③ 一致）。**debug 复验实测**：13 篇全 `CRLF` 无 BOM、`content-review` **147 路径 + 17 符号全命中**、`anchor-scan` **75 锚点 / 20 完整路径目标 / 违规 0**、`link-check` 0 缺失、禁用词 0；抽样 **65 条**锚点全部命中。**⚠ 交付面须记**：三棵子树的 12 篇顶层文档（`{README,overview,sequences,differences}.md` ×3）落在 **HEAD 里存在旧文档的同名路径**上（`git status` 报 `M`），而旧 `implementation/*` 共 **17 个路径仍为 `D`（未重建，符合 B2）**、新增 `implementation/*` **27 篇为未跟踪**；**主控做了 B2 合规实测**（`.tmp/cap/b2-check.mjs`）：把 12 个路径的 HEAD 旧文实质行（共 **789 行**）与新稿逐行比对，**逐字命中 0 / 复用率 0.0%** ⇒ `B2-CLEAN`（新稿确为按代码重写，未复用旧文档）。**新增工具**：`.tmp/tools/anchor-open.mjs`（锚点开箱）、`.tmp/tools/link-check.mjs`（markdown 相对链接完整性，补上「没有任何门查链接」的缺口；首轮全仓 52 篇仅 1 处坏链已修）、`.tmp/tools/config-proof.mjs`（配置面判据） | WG4–6（代码已冻结） |
| WG10 | 根 README / CHANGELOG / 规范类 / **index 重建** | **已完成**：根 `README.md`、`CHANGELOG.md`、`documents/index.md` 三篇落地并过门（漂移体检 **0 越界 / 0 路径失效**、`content-review` 全命中、`link-check` 全绿、行尾与禁用词全绿；三篇的 `文件:行号` 锚点已用 `.tmp/tools/anchor-open.mjs` 逐条开箱复核）。**`documents/index.md` 已按 WG9 落地后的实际文件树重建**：覆盖 `documents/` 下全部 **49 篇** md（共享层 5 篇 + 三棵应用子树 39 篇 + 规范篇 + 计划三篇 + 本页），**51 条相对链接全部可解析**；旧索引未沿用。**台账口径**：本表不再写这些文件的行数（行数会随修订漂移，写死必然被漂移体检判失败——本轮即因此修掉一次） | WG8 + WG9（已完成） |
| WG11 | 全量复检 | **已完成（判定通过）**：静止期一次跑满四类判据 —— ① **代码 179 件**（`.ts`+`.mjs`+`.rs`，`verify.ps1` 分 5 批）**失败 0**（`strict` 差异全为行尾注释改写、`stripTrail` 全 `d0`）；② **文档**：`check-doc-drift` **58 篇 ｜ 行数声明 2（漂移 0）｜锚点 2909（越界 0）｜路径失效 0 ｜歧义 27**、`anchor-scan` 77 锚点 / 违规 0、`content-review` 401 路径 + 54 符号 `bad=0`、`link-check` 0 缺失；③ **资产**：`py-proof` / `cmd-proof` 9/9 / `html-struct-proof` 4/4 / `css-proof` 2/2 全绿；④ **编译**：`cargo check` + `cargo test -p websurf-phys` exit 0（**10 passed**）、三工程 typecheck 3/3 exit 0；⑤ **行尾**：新建 `.tmp/tools/eol-sweep.mjs` 全量 `scanned=249 problems=2`（两处为 HEAD 既有尾空白，按基线保留）。**过程中的一处假绿已更正**：首轮清单取自 `git status --porcelain`（不带 `-uall`），git 把 7 个完全未跟踪的目录折叠成目录路径 ⇒ 既产出 `EISDIR` 假失败行，又使这些目录内的全部 `.md` 整轮漏扫；已改用 `-uall` + 目录递归（即上述新工具），该坑记为规范篇陷阱第 **16** 条；同轮实修 `documents/phys/overview.md` 1 处新稿尾空白。**补检（同一盲区的第二个后果）**：历史台账（原 plan 目录进度台账）也因此整篇没被 `content-review` 查过——直接跑后抓出 **30 条路径 + 6 条符号**不合格，逐条判读后**修掉 13 处路径文本与 2 处实测不存在的符号名**（`#64②` 的 `KEY_DEFS` → 真实标识符 `KEYS`；`keyboard.ts` 的 `control` → `ControlLeft`/`ControlRight`），另把 `#69④` 一处证据句写实；残余 17 路径 + 4 符号判为「已删文件的历史引用 / 引用的错误写法样本 / 工具名误配」三类非断言，判读口径已入规范篇 §4。**静止期末轮（含配置面 14 件与 owner 授权的代码/CI 处置）在冻结态重跑**：**265** 个落盘路径、漂移 **58 篇 ｜ 0 越界 ｜ 0 路径失效**、`anchor-scan` 79 锚点 / 违规 0、`link-check` 89 篇 / 63 链接 / 0 缺失、`content-review` 874（24 bad）+ 154（5 bad）**全部**落在台账三类非断言、四项资产证明全绿、`cargo check`/`cargo test` exit 0、三工程 typecheck 3/3 exit 0、`verify.ps1` 失败 **3 件**＝授权改动的三个 `.mjs`、行尾扫描 265 件 `problems=2`（HEAD 既有尾空白）。**文档/注释重编范围至此全部完成**，余下只有按「只记录不修」保留的疑似缺陷待裁决项。明细见台账 WG11 四行 | 全部 |
| WG12 | **范围补漏**（`src/` 根与工具层、`apps/*/web` 资产、`.cmd`、配置面） | **已完成（21 件代码/资产 + 14 件配置面）**：① `src/scripts/cargo-env.cmd` **已完成**（注释按该文件自带的「pure ASCII」约束改写为英文，`cmd-proof` 命令行 14 = 14、`nonASCII=0`）；② `apps/viewer/web/index.html` **已完成**（8 条注释；`html-struct-proof` 标签 154 = 154）；③ `apps/game/web/index.html` **已完成**（6 条；标签 577 = 577；favicon 注释已如实写明该文件不在工作区 ⇒ 两条声明都 404，见 §7.3 #5）；④ `apps/viewer/web/styles.css` **已完成**（16 个块；新建 `.tmp/tools/css-proof.mjs` 证明规则文本 17198 = 17198 逐字符相同）；⑤ `apps/game/web/styles.css` **已完成**（44 块中 26 个纯分节标签核对无误后保留、18 个改写；修正一处事实错误——旧注称隐藏文件控件样式由 `#loadMapBtn` 承担，实测本文件无该 id 规则、外观是 `#panel .map-btn`；规则文本 21310 = 21310、代码行 521 = 521）；⑥ **`src/` 侧 8 件已完成并经主控独立复验**（`src/lib.rs` 12→19、`src/serve.py` 64→73、`src/scripts/{check-doc-drift,check-shared-sync,wasm-stale-check}.mjs` 117→127 / 229→238 / 69→77、`src/scripts/lib/{dist-pack,wasm-api-contract}.mjs` 194→210 / 203→213、`src/scripts/install-wasm-bindgen.cmd` 105→114）：`verify.ps1` **10/12**，唯二两件失败（`src/serve.py`、`install-wasm-bindgen.cmd`）**纯属工具盲区**——它只把 `//` 当注释，于是 Python 的 `#`/docstring 与 cmd 的 `REM` 被计入「代码行」；**主控自建替代判据** `.tmp/tools/py-proof.py`（`ast` 抹 docstring 后 `ast.dump` 相同 + `tokenize` 码流相同 + 真实代码行 41/41 相同）⇒ `PY-CODE-IDENTICAL`，cmd 复用 `cmd-proof` ⇒ `命令行 78 = 78 diff=0 nonASCII=0`；其余门全绿（锚点 0、76 模板逐字节相同、`content-review` 33 路径 + 12 符号全命中、`node --check` 9/9）；**登记疑似缺陷 10 条 → §7.3 #68**；⑦ `apps/debug/web/index.html` **已完成**（689 → 699 行；35 个注释块中 13 处改写、22 个纯分节标签核对后保留、**新增 2 条**（把 `lightingModeHint` 与 `pathBuildTag` 这两个**无任何代码读写的死 id** 如实标注）；删掉变更史式 PVS 说明与不可定位实测数字，折角着色按 `turnColor` 改为**两档**（旧注的「绿 ≤5°」在实现里不存在）；判据：`anchor-scan` 0 / `content-review` **9 路径 + 8 符号全命中** / `html-struct-proof` 标签 518 = 518 / **主控自建 `html-markup-proof.mjs`：标记+文本逐字符相同、属性值多重集 580 = 580** / `verify.ps1` 结构计数全绿；**另修掉该结构门的行尾陷阱**（属性值含 `>` 的标签被切成跨行记号，`git show` 是 LF 而工作区 CRLF ⇒ 曾误报 DIFF 4，已加行尾归一）；**登记待裁决 1 条**：同件 `title` 属性（代码字符串，未改）仍写三档着色，与实现不符）；⑧ **口径更正后已完成**：原先记「9 个工程 `.cmd` 实测 0 条注释」**是错的**——实测 7 件共 **48 条** `REM`/`::` 注释（`apps/debug/{start-dev,play,build-dist}` = 11/6/2、`apps/game/{start-dev,play}` = 9/6、`apps/viewer/{start-dev,play}` = 9/5），只有 `apps/{game,viewer}/build-dist.cmd` **确为 0 条**。7 件已改写并经主控复验（`cmd-proof` 9/9 `diff=0 nonASCII=0`；`git diff` **增删各 48 行、非 `REM` 行 = 0**；两件 0 注释件无 diff 行）；**主控裁决：两件 0 注释件不补头注**（原无则不加，禁止在注释改写之外增删结构）。**真正无对象**：`apps/debug/web/styles.css`（全文仅 `.health-log` 一条规则、无注释）、`src/scripts/ensure-node-deps.cmd`、三个 `package.json`；⑨ **配置面已完成（owner 裁决纳入）**：`Cargo.toml` **9 个** + `.gitignore` **5 个**（根、三工程、**外加 `src/.gitignore`**——此前记「4 个」时漏掉它）+ `tsconfig.json` **3 个（0 注释 ⇒ 无对象）**，本组共 **14 个文件**；判据 `config-proof.mjs`（行尾归一 + 剥 `#` 注释后逐字符比对配置文本）⇒ 9 个 `Cargo.toml` 全部**配置文本逐字符相同**（配置字符 187/173/173/173/1595/1595/517/382/1317 前后一致），根 `.gitignore` 的 DIFF **仍是本轮之前既有的 `+.ak/` 一行**（该文件规则 **52 行**经编辑前快照比对未变），`eol-sweep` 14 件 `problems=0`。**实测推翻的旧注**：「四个模块 wasm crate」→ **3 个**且都不在根 workspace；三工程 wasm crate 的「模块结构」头注列的 `src/vbsp/` 等**实际全在 `src/wasm-core/`**（那些 crate 目录下只有 `Cargo.toml` 与 `src/lib.rs`）；viewer 不依赖 `websurf-phys`（该包不在其 lock 内）；viewer 无 `load_vmdl`。**刻意保留**：根 `.gitignore` 的 `test/game-core/` 规则（配置项，按「只改注释」口径保留）。**本轮补做（配置面计 15 个文件）**：`src/vendor/vmdl/Cargo.toml` 的注释也在内——原写 patch 由「两端工程」引用且路径为 `../src/vendor/vmdl`，实测 **4 处**声明、路径是仓库根 `Cargo.toml` 的 `src/vendor/vmdl` 与三工程各自的 `../../src/vendor/vmdl`；并据上游 `vmdl-0.2.0.crate` 解包逐文件比对，把「副本差异」补全为 **2 个文件**（`src/vendor/vmdl/src/vtx/mod.rs` 的 `Strip::indices` + `src/vendor/vmdl/src/lib.rs` 的 2 处返回类型生命周期标注），5 个 manifest（vendored + 根 + 三工程）注释一并改写，`config-proof` 5/5、`content-review` 10 路径 + 4 符号全命中。明细见台账配置面行；⑪ **`.cmd` 实测出的 5 条疑似缺陷**（门/消费方 wasm 路径错配、viewer python 守卫使兜底不可达、端口占用分支的 dist 假定、`start-dev.cmd` 缺工具链守卫）→ §7.3 #69；⑫ **另实测**：这 9 个 `.cmd` **没有任何 `package.json` script 或 `.cmd` 转发**（`dev`/`build:dist`/`check:api` 是并行路径）⇒ 属手工/双击入口；⑩ **明确排除**：`src/vendor/vmdl/**`、`apps/game/temp/*.txt`、三个 `web/{app.js,worker.js}`、`web/coi-serviceworker.js`、`src/phys/{LICENSE,NOTICE}`、`package-lock.json` ×3。**盘点工具**：`.tmp/tools/coverage-scan.mjs`（未改动数已由 95 降到 77，余项均为上述 ⑧⑨⑩ 类） | WG4–6 |

### 7.3 当前阻塞与待决

> **已结案项与已解决项原存放于历史台账**（原 plan 目录进度台账的「§7.3 已结案 / 规则与工具」小节；该台账已于 2026-09-23 退役删除、仅存 git 历史），已结案共 **19** 条：#6、#12、#13、#14、#15、#16、#20、#22、#24、#29、#32、#33、#34、#37、#39、#45、#47、#48、#49。移出仅换存放位置、**内容未改**；本表只保留「仍生效的规则」与「待 owner 裁决项」。 **另**：以下 **11 条规则 / 工具说明 / 已解决项**——#17、#18、#19、#21、#23、#25、#35、#42、#44、#46、#56——同样**逐行原样**移入该文件的「§7.3 规则与工具（逐行原样移出）」小节；它们是**规则与工具文档**，不是待决项，本表只保留「仍生效的短规则」与「待 owner 裁决项」。

| # | 事项 | 状态 |
|---|---|---|
| 1 | ~~根 README 已删除，仓库暂无 README~~ **已处置（2026-09-22）**：WG10 已重建 `README.md`；随后 owner 要求「根文档不齐全」⇒ 由 `.archive/` 合并重建四篇根文档（README / CHANGELOG / CONTRIBUTING / SECURITY），均已过漂移体检（锚点越界 0、路径失效 0） | **已结案** |
| 2 | ~~导航 index 已删除~~ **已处置**：`documents/index.md` 已由 WG10 按实际文件树重建（49 篇、51 条链接全可解析） | **已结案** |
| 3 | 旧 `AGENTS.md` 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）**未在本文件复述** —— 重编期间以任务书为准；是否重建由 owner 在 WG10 决定 | **待 owner 裁决** |
| 4 | ~~CI 与共享脚本仍引用已退役的 harness~~ **已处置（owner 裁决「清掉这些残留引用」）**：**6 个文件**全部清完 —— `ci-gates.yml` 删 4 步并把 job 改名为 `debug-gates`（steps 35→31、YAML 实测可解析）、`deploy-pages.yml` 去掉不可复核的旧实测数字、`PULL_REQUEST_TEMPLATE.md` 范围/测试项改写、`apps/debug/scripts/jump-apex-verify.mjs` 改读**本工程** `apps/debug/pkg/`（该门由「必然 SKIP 空转」变为**实跑**：`npm run test:jump-apex` exit 0、198 行、`[SKIP]` 0 次、跑满 25 格）、`src/scripts/{check-doc-drift,check-shared-sync}.mjs` 去掉退役路径（后者门禁由**恒失败转为四项全过**）。**全仓复扫 321 个文件**后仅剩根 `.gitignore` 的 `test/game-core/` 规则（配置项而非注释，按「只改注释」口径**刻意保留**） | **已结案**（本轮唯一的代码 / CI 改动，均经 owner 授权；逐件判据见台账两行） |
| 5 | **apps/game 的 favicon.ico 被同一批删除波及**：该文件在库中唯一，而 `apps/game/web/index.html:22-23` 仍声明 `./favicon.ico` 与 `/favicon.ico` 两条链接（行号本轮实测复校）（同处注释承诺"两条路径都不 404"），现两条均落空 | **待 owner 裁决**是否恢复（与 harness 退役无逻辑关联，仅同批被删） |
| 7 | **零分配支路已实现但未接线**：`tick_into` / `state_out_ptr` / `seed_from` 只被 `src/ts-shared/` 的 `tick-authority.ts`、`decoupled-loop.ts` 调用，而这两个控制器在三个工程内均无装配点（`createTickAuthority` 仅被其单测调用）→ 线上路径实际走 `tick()` 返回对象 | 已知，须在文档中如实写"已实现、未接线"，不得写成线上热路径 |
| 8 | `apps/debug/src/wasm.d.ts:67-119` 的 `PhysWorld` 类型落后源码 7 个方法（缺 `tick_into` / `state_out_ptr` / `set_state_ex` / `state_full_json` / `seed_from` / `gate_veto_count` / `debug_trace`），debug 侧只能运行时 cast（`renderer-main.ts:1268`、`:1285`） | **待 owner 裁决**（改 .d.ts 属代码改动，未擅改） |
| 9 | `apps/game/scripts/check-wasm-api.mjs:52-70` 的 `PHYS_API` 只列 **17 项**，缺 `new` / `state_full_json` / `set_state_ex` / `seed_from` / `gate_veto_count` / `debug_trace` → 对 24 个导出的契约覆盖不完整 | **待 owner 裁决**（门禁脚本改动，未擅改） |
| 10 | `set_yaw_pitch` 在 `apps/**` 与 `src/**` 内**零调用点**；`predict` 仅被 `apps/game/scripts` 两个脚本调用 | 已知；注释已如实标注，是否保留导出由 owner 决定 |
| 11 | `teleport_gate_ticks` 参数链已死：`set_params` 的 JSON 键可写、`player.rs` 有该字段（默认 3）、`step_core` 的传送检测调用点确实传入，但 `teleport.rs` 的 `check` 形参名为 `_gate_ticks` 且函数体从不读它 | 已知；注释已标注"该键不改变行为"，是否删字段由 owner 决定 |


> **三次瘦身（2026-09-22）**：§7.3 的累积待裁决行 **#26–#69 共 28 条曾逐行原样移入历史台账**（该台账属 plan 目录三篇，2026-09-23 已退役删除，仅存 git 历史 commit `9dbdc58`）。
> 本表只保留上方 #1–#11 的短规则与下方**一行一条的索引**（索引是为便于定位；台账原文见 git 历史，索引与原文冲突时以原文为准）。

| # | 事项（一行摘要；**完整原文曾逐行原样移入历史台账**的「§7.3 待裁决项」小节——该台账已退役删除，git 历史 commit `9dbdc58` 可查） | 状态 |
|---|---|---|
| 26 | BSP 导出未把 `KHR_texture_transform` 登记进 `extensionsUsed` | 只记录不修 |
| 27 | `vtf.rs` 4 条读写不一致 + 5 处死代码 | 只记录不修 |
| 28 | `lightmap.rs` 错误串含外部实现引用 `Lightmap.cs:64` | 待裁决（改文案属代码） |
| 30 | `mosaic/mtz.rs` 8 条编解码不一致 | 只记录不修 |
| 31 | `vbsp/data/entity.rs` 6 条（含 `start_disabled` 恒 false 的跨工程实锤） | 待裁决（第①条） |
| 36 | `compute-mode.ts` 的 `summary` 字面量含已删文档编号 | 待裁决（改字面量属代码） |
| 38 | `jump-apex-verify.mjs` 内嵌「修复前行为」复刻；`jump-apex-serve.mjs` 依赖两处代码文本切片锚点 | 已知（切片锚点已实测未破坏） |
| 40 | `tick-authority.test.ts` 断言标签含 `Q1` / `§8.5` | 待裁决（属代码） |
| 41 | owner 指令：子代理并发 ≤3（含 19 并发被掐断的复盘） | 已生效 |
| 43 | 旧文档篇数口径对撞（68 篇 vs 实测 56 篇） | 待终审 |
| 50 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 待裁决 |
| 51 | 规范篇里的禁用词是「引用对象」（全仓唯一允许出现处） | 已说明，非缺陷 |
| 52 | `check-wasm-api.mjs` 输出标签 `F4` 无出处 | 待裁决 |
| 53 | game 类型面/配置面 3 条（`worker-types.ts` 落后实际载荷等） | 待裁决 |
| 54 | viewer `timeline.ts` 的 `title` 文案与 prerun 负段口径矛盾 | 待裁决（属代码） |
| 55 | viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度） | 待裁决 |
| 58 | viewer `core` + `ui` 9 条（含 `ensureWasm` 永久缓存失败） | 待裁决 |
| 59 | viewer `replay/` 10 条（含 GPU 资源不释放、blob URL 泄漏） | 待裁决 |
| 60 | debug 脚本 10 条（**jump-apex 采样链链路级**仍待裁决；其中「`test:jump-apex` 空转」**已于本轮处置**——该脚本改读本工程 `apps/debug/pkg/`，门由空转变实跑：exit 0 / 198 行 / 0 SKIP） | 待裁决（①属代码） |
| 61 | viewer `crates/wasm` 6 条（`.MDL` 三件套替换隐患等） | 待裁决 |
| 62 | game `phys-rate-parity` 4 条（混合分区时长/结果、`flatTop` AABB） | 待裁决 |
| 63 | game 脚本 11 件 7 条（`_dbg_floor` 的 `onGround` 恒 undefined 等） | 待裁决（④属代码） |
| 64 | WG6b 6 条（`test/maps/surf_null_4.replay` 跨 3 文件失效等） | 待裁决 |
| 65 | 范围盘点（coverage-scan）+ **配置面口径冲突（已结案）**：件数实测更正为 **9 `Cargo.toml` / 5 `.gitignore`**（含 `src/.gitignore`，此前记 4 个时漏了它）、`tsconfig.json` 3 个 0 注释＝无对象；配置面 14 件已按 owner 裁决纳入并完成（`config-proof` 全部「配置文本逐字符相同」，见台账）。另：根 `.gitignore` 的 `.ak/` 规则注释已改写为「当前工作区无该目录，规则保留作归档位」（原注释声称旧 md 已移入该目录，而该目录不存在） | **已结案** |
| 66 | `input-replay-verify.mjs` 5 条（`inputRecorder` 永不落样本、`f.dt` 字段不存在、页面缺 7 个 id 等） | 待裁决 |
| 67 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 `coi-serviceworker.js` 等） | 待裁决 |
| 68 | WG12 `src/` 侧 10 条（`check-shared-sync` 门禁恒失败**已于本轮处置**：退役路径出清单后四项子检查全过；余 `bytes=text.length` 等 9 条仍待裁决） | 待裁决（①已结案） |
| 69 | 9 个 `.cmd` 5 条（门/消费方 wasm 路径错配、viewer python 守卫使兜底不可达等） | 待裁决 |
| 70 | **依赖表「本 crate 无引用点」清单**（两法一致：源码引用面扫描 + `cargo check` 的 `-W unused-crate-dependencies`）：debug `websurf-wasm` **26 项**、game **29 项**、viewer **1 项**（`gltf`）；另 `websurf-wasm-core` **3 项**、vendored `vmdl` **1 项**（`tracing`，上游 manifest 同样声明）。判读：**无引用点 ≠ 可删**（`getrandom` / `getrandom_03` / `path_dedot` 是 **feature 开关**），故未动任何配置行；如需瘦身建议**逐项删 + 每次跑 `cargo check` 与 `npm run build:wasm`** 验证 | 待裁决（本轮只测不改） |
| 71 | debug `renderer-main.ts` optimizeScene 调用链注释「其又源自 harness worker-b」与 game 侧同构注释措辞不一致（2026-09-23 验收审查新发现；字面判据 0 违规——未写完整工程名，完整记录见 2026-09-23 验收审查行——原台账已退役删除，git 历史 commit `9dbdc58` 可查） | 待处理（1 行注释对齐，属注释重编范围） |

### 7.4 下一步（建议顺序）

1. **WG4 / WG5 / WG6 / WG6b 全部收尾**：四组均已 100% 完成并经主控独立复验（代码类走 13 项四道门；资产/配置类按各自专用判据——HTML 标签序列、CSS 规则文本、cmd 命令行、prose 按 §13 判）。
2. **WG12 已完成**：21 件代码 / 资产已完成并复验（`src/` 侧 8 件、`apps/debug/web/index.html`、三工程 `web/{index.html,styles.css}` 6 件、`src/scripts/cargo-env.cmd`、7 个工程 `.cmd`）；**配置面 15 件（10 `Cargo.toml`（含 vendored `src/vendor/vmdl/Cargo.toml`）+ 5 `.gitignore`）已按 owner 裁决纳入并完成**（`config-proof` 全部「配置文本逐字符相同」）。余下只剩 §7.3 索引里各工作组登记的**疑似缺陷待裁决项**（按「只记录不修」口径保留）。
3. **WG9（已完成）**：三工程子树文档（`documents/<app>/{README,overview,sequences,differences}.md` + `implementation/*.md`）共 **39 篇**已交付并经主控逐棵独立复验（统一模板与 6 道门见 `.tmp/wg9/TEMPLATE.md`）：`check-doc-drift` 0 漂移 / 0 越界 / 0 路径失效、`anchor-scan` 0 违规、`content-review` 全命中、行尾与禁用词全绿、三棵共 **154 条**锚点抽样开箱全部命中所述符号。**另做 B2 合规实测**：12 篇同名路径新稿与 HEAD 旧文逐行比对，复用率 **0.0%**。
4. **WG10（已完成）**：根 `README.md`、`CHANGELOG.md`、`documents/index.md` 已落并过门；索引按 WG9 落地后的实际文件树重建（49 篇 md、51 条相对链接全可解析）。**口径一致性已完成**：`README.md` 的「文档地图」段已补入三棵应用子树的入口与 `documents/index.md` 本身，与索引口径一致。
5. **WG11 全量复检（已完成）**：全仓四道门已跑满（`.tmp/tools/wg11-check.ps1` 五段：资产族证明 → 行尾/BOM 全扫 → 文档门 → 编译门 → `verify.ps1` 分批）；`check-doc-drift.mjs` 0 漂移 / 0 越界 / 0 路径失效；README ↔ index ↔ 工程文档口径一致。结论与计数见 §7.2 WG11 行，明细见台账。
6. **静止期已跑完全量闸门并归档日志**（WG11 证据：`.tmp/gate/`）；**工具坑三条**：① 脚本末尾的 `exit` 会终止整个 pwsh 进程，用 `*>` 重定向时末行汇总可能丢失 ⇒ 判读改为过滤 `--- failing chunk` 与 `★代码部分不同`；② `git status --porcelain` 会折叠完全未跟踪的目录 ⇒ 清单必须带 `-uall`（规范篇陷阱 #16）；③ 管道截断（`| Select-Object -First`）会把 `$LASTEXITCODE` 变成 `-1`，取退出码前先重定向到文件（#7）。
7. **验收审查（2026-09-23，已完成）**：六面体检全绿、无返工项（漂移 / 禁用词 / 退役引用 / 行尾 BOM / 门禁 / 口径；明细见历史台账 2026-09-23 行——台账已退役，git 历史可查）。余下动作：① §7.3 #71 措辞对齐（1 行注释）；② §7.3 各「待裁决」项清账（建议从 #31① 跨工程实锤开始）。
8. **plan 目录退役（2026-09-23，owner 裁决）**：原 `documents/plan/` 三篇控制文件已删（重编任务完结、任务待办只留本文件——owner 原因：「不是每个 agent 都会翻 plan 看」）；全仓引用已同步清理、漂移体检 0 失效。**后续新增任务/待办一律只写本文件 §7**。
---

## 附录 A：仓库构建与验证速查

| 用途 | 命令 |
|---|---|
| 共享物理 | `cargo check -p websurf-phys`、`cargo test -p websurf-phys`（实测 10 项全过） |
| 工程构建 | 各工程 `npm run typecheck` / `build:ts` / `build:dist`；改 Rust 后需 `npm run build:wasm` |
| 文档体检 | `node src/scripts/check-doc-drift.mjs [文件]` |
| dev 端口 | debug 8080 / game 8090 / viewer 8100 |
