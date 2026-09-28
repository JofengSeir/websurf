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
| 2026-09-24 | **三工程 `.cmd` 入口统一为 `dev` / `build` / `start`（owner 定调）**：`apps/{debug,game,viewer}` 各新建 `dev.cmd`（全链条：工具链自检 → 依赖 → **强制** 重编译 wasm 与 TS → 跑本工程测试门 → 起服务并开浏览器）/ `build.cmd`（重编译 + 契约检查 + dist 打包，参数 `[single\|multi]`，viewer 为 single-only）/ `start.cmd`（只启动，服务已打包的 `dist/`，缺 `dist/` 报错并提示先跑 `build.cmd`）；旧 `start-dev.cmd` / `play.cmd` / `build-dist.cmd` 九个文件删除。端口沿用槽位：dev 8080 / 8090 / 8100，start 8081 / 8091 / 8101。**文档同步**：README §2 与已知缺口、debug `overview.md` / `implementation/scripts.md`（表 + 已知缺口 8–11）/ `differences.md`、viewer `README.md` / `implementation/scripts-and-test.md`（表 + 已知缺口 8–11/13）、`src/serve.py` 头注、`Cargo.toml` 头注、本文件 §7.3 #69 | dev/build/start ×3 + 文档 9 处 |
| 2026-09-29 | **接手另一个 agent 的 game 界面「莱茵风格化」（owner 转交）**：目标工程 `apps/game/web`；参考 `LBEILC/RhineLabUI` 与其 `DESIGN.md`（`RhineLabUI-Workflow` 是流程复盘文档、非风格库）。该 agent 留了未提交半成品（`styles.css` 已从「深海冲浪」换成「莱茵精工」）。**已修三处**：① 顶边黄块被 `.win` 的 `overflow:hidden` 裁掉（`::before` 的 `top:-3px` → `top:0`）；② `#panel` / `#fps` 段旧「竞技」注释改莱茵语彙、头注阴影口径按实测重写；③ 螺丝的硬色标 gradient 与「无渐变」口径在注释里统一。**已产出计划**：`documents/game/implementation/ui-style-plan.md`（六条廉价感诊断 + 可迁移语彙 + P1–P4 分期 + D1–D4 待裁决：字体 / 微动效 / 是否同步另两工程 / 按钮高度），并登记进 `documents/index.md`。**未提交**，等 owner 定 D1–D4 后开工 | 分析 + plan |
| 2026-09-29 | **game UI 莱茵精工 P1–P4 落地（owner 审查 plan 后指示「继续你的计划」）**：**P1** 令牌（琥珀 `#c5a16b` 替换塑料黄；底/正文/辅助/分隔换 RhineLabUI 暗色规格 `#0d1113`/`#11181b`/`#e0e3dc`/`#a6b0b1`/`#536166`，`--bg` 按计划再暗一档）+ 排版（面板正文 14px、读数 12px 等宽、h4 12px/600 + 0.06em、`#stats`/`#hud` 统一 var(--mono)）；**P2** 控件自绘（range `appearance:none` + 2px 细线轨道 + 12px 节距刻度 + 琥珀方角嵌件游标（webkit/moz 双轨，accent-color 留作回落）；checkbox 16px 方框 + checked 琥珀内嵌方块；color 细线小方框 + 内嵌 swatch；select 保留原生下拉但外观自绘（data-URI 刻度箭头 + 聚焦琥珀边）；`.map-btn` `min-height:40px` + 切角内侧 1px 刻线 `::after`）；**P3** 壳体材质（`.win` 顶缘压槽 = `inset 0 2px 0` 暗线 + `0 3px 0` 亮线 + 内周边 `inset 0 0 0 1px` 发丝，顶边黄块改嵌在压槽里的 32×3px 短嵌片；`.nav`/`.row` 去 hover 色块改左缘刻度条与行间 1px 刻线；螺丝改 9px 十字凹槽 + 齐平垫圈，第二颗移到加载卡**左下**；`.load-card` 同壳体 + 磨砂 + 进度轨道 12px 节距刻线）；**P4** HUD（`#fps`/`#status` 12px 铭牌、`#stats` mono + 速度单位 u/s（`updateSpeedHud` 显示文本加 `.unit` span，CSS 12px 辅助色）、`#keys` 细线键帽 + 激活态琥珀内嵌 1px 暗线）。**D1–D4 取默认并记录**（owner「继续你的计划」视为放行）：D1① 字体栈零依赖（不引 MiSans）；D2① 保持全静态（b55b871 刻意去动效）；D3① 只做 game（debug owner 已明示维持现状、viewer 刚落地自己的语彙）；D4② 40px + 说明（44px 会挤压 760×580 窗口）。**验收**：game typecheck exit 0（TS 仅 updateSpeedHud 显示文本加单位）、app.js 重建（新于 app.ts）、漂移体检 0/0/0 exit 0、EOL 双净；浏览器实测面板（琥珀/自绘控件/压槽壳体/磨砂）渲染正常；JS 契约零改动（五变量/全部 id/JS 生成类名原样） | styles.css 全量重写、app.ts ±3、plan 文档 +进度行、本文件 |
| 2026-09-29 | **game UI 第二轮返工立项（R1，owner 复核截图后）**：P1–P4 已由另一执行者落地（`92dd487`：琥珀暗色令牌 + 控件自绘 + 壳体压槽/螺丝 + HUD 铭牌），owner 判定「仍不够菱角分明、装饰堆砌没有设计语言、布局怪」。**已把 R1 验收口径补进 `documents/game/implementation/ui-style-plan.md` §八**：七条病症（圆角遍地 / 装饰各出现一次 / 滑块点状虚线 / 同值双控件 / 窗口固定 580px 造成空白 / 孤立按钮与全宽关闭按钮 / 缺档案元信息）、几何规范（圆角一律 0、切角唯一种 10px 右上）、档案元素成套表（编号 / 字段引导线 / 单位读数 / 分组刻度尺 / 状态标签条 / 页脚署名 / 硬件件计数）、布局修正（高度内容驱动、三列网格 168/1fr/88、取消双控件、按钮归位）、**设计语言收敛规则（元素分三层 + 同屏 ≥2 次 + 琥珀 ≤5 处）**、七条禁止项、九条验收清单 | 计划文档 §八（待返工） |
| 2026-09-29 | **R1 返工落地 + R1.1 修正（owner「审查后继续」+ 复核三处反馈）**：**R1** 按 §八 全条执行——圆角清零（border-radius 仅剩螺丝共享规则 ×1 与服务孔 ×1 的 50% 声明）、切角 10px 右上 ×3 成组（.map-btn/激活标签条/.win 右上与螺丝同位）、线宽 2px 结构/1px 分隔/1px 点线引导线（checkbox/color 行中列填充）、档案元素成套（8 pane 编号 GN-01..MO-08 + 页脚署名 ×8 + h4 分组刻度尺）、硬件件计数固定（螺丝 2 + 服务孔 1 对角）、布局（高度内容驱动 460px、行网格 168/1fr/88、.val 去边框为读数区 + index.html 16 单位 span、导航 168/36px、关闭钮文字项）、状态去色块（checkbox 琥珀 1px 内嵌刻线、chips 标签条）。**R1.1**（owner 复核三处反馈）：① 高度改回**固定 580px**（「老是变来变去」——8.4-1 内容驱动方案作废，稀疏页空白为固定高度的已知代价，页脚署名收尾界定）；② 切角斜边补 1px 边线（`#panel::before`，固定 760×580 居中几何内偏 1px，rotate 45°——.win 两伪元素已被嵌片与螺丝占用，借宿主层画线）；③ 服务孔对齐页脚文字行（bottom 13/left 12）。**验收**：typecheck exit 0、漂移体检 0/0/0、EOL 净、浏览器实测三处修正渲染正常（螺丝十字+切角同位可见） | styles.css R1 重写、index.html +16 单位 span、app.ts 单位、本文件 ×2 |
| 2026-09-27 | **清理不应入库的脚本（owner 提出「scripts 相关不该上传」）**：以「被引用面」为判据做全仓实测（脚本 `.tmp/audit/script-refs.mjs`：package.json / `.cmd` / CI yml / 文档 / 脚本间 import 五类语料），筛出 **20 个一次性实验/诊断脚本**——debug 的 jump-apex 七件（`serve` / `measure` / `auth-diag` / `report` / `trace` / `window` / `smoke`；CI 的 `test:jump-apex` 只跑 `jump-apex-verify.mjs`）、game 的 13 件（`phys-teleport-gate` / `phys-p2-regression` / `phys-p2-ground` / `phys-p2-trace` / `phys-gate-probe2` / `phys-diag-flat` / `phys-rate-parity` / `phys-rate-parity-v2` / `phys-dual-pipe` / `wasm-hash-pin` 与三个 `t13-*`）。已加入根 `.gitignore` 并 `git rm --cached`（**本地文件保留**），另补三条 OS 噪声规则（`.DS_Store` / `Thumbs.db` / `desktop.ini`）。文档同步：debug `scripts.md`（入库口径 11/18 + ⚑ 标注）、game `scripts.md`（5/20 + ⚑）、`debug/differences.md` 计数 | 排除 20 个脚本 + 3 篇文档 |
| 2026-09-27 | **补漏第二轮（v5 面板绑定生效 + 人工复核 G）**：v5 命中 11 个「回调无下发」的绑定，逐个开箱证实**全部是间接下发**（`ch()` → `applyCrosshair` + `savePanelPrefs`；`onSyncFov/RenderDistance/Exposure/LightGamma/AmbientScale` 五个钩子在 `apps/game/src/app.ts:193-197` 接到渲染器 setter）⇒ **不是断链**。人工复核 G：`keyboard.ts` 的 bind/unbind 与 `panel-controller.ts` 录制监听（`{capture:true}` 成对）**配对均正确**，脚本那段输出是正则假象。**结论：两轮补漏未发现新的断链**；本轮只删 1 个孤儿 `RendererMain.isPathVisible`（debug），余下 #78–#80 三条待裁决 | 补漏第二轮 |
| 2026-09-26 | **审计补漏（v4：回向消息 / 公开方法零调用点 / 监听解绑配对 / 类选择器）**：新增四项检查后确认——**无新的断链**：worker→主线程在用的六类消息（game：`health-log` / `error` / `phys-frame` / `phys-event` / `world-build-ms` / `world-parse-ms`）与 viewer 的 `done`/`error`/`progress` 均有处理分支；监听解绑未见 options 不一致（此前修复的 capture 配对仍在）；类选择器命中全为动态生成（误报）。**新登记 4 项**：#78 `getLightingMode` 零调用点、#79 game `resetTo`/`stop` 零调用点（`start` 有调用、`stop` 无）、#80 消息联合类型与实际收发不符（仅类型面）、#81 工具边界。**已删 1 项**：debug `RendererMain.isPathVisible`（随上一轮 `setPathVisible` 删除后成为孤儿）。debug typecheck exit 0 | 补漏审计 |
| 2026-09-26 | **P3 输入录制链路删链（owner 裁定 B）**：删除用户录制器 `inputRecorder` 与其面板七个控件、`updateInputRecUi`、`startRecording`/`stopRecording`、`buildReplayMeta`、`__wsInput` 六个录制成员（`status` → 新增 `progress`）；回放侧（`replayCapture` / `inputPlayer` / `load`/`play`/`stopPlay`/`captureText`）**全部保留**。debug typecheck exit 0、`web/app.js` 已重打包；审计 A1 仅剩动态生成的 `clearTeleportsBtn`。文档同步：debug `app.md` / `input.md` / `web.md` / `scripts.md` / `overview.md` / `differences.md`；本文件 §7.3 #72 结案。**遗留**：`apps/debug/scripts/input-replay-verify.mjs` 依赖已删除 API，需改写或删除 | 删链（含 6 篇文档同步） |
| 2026-09-26 | **页面功能链路全量审计（脚本提取 + 逐条开箱）**：三工程跑 A（DOM id 契约）/ B（主线程↔Worker 消息分支）/ C（wasm 导出面调用点）+ 配置字段读取审计。结论：viewer 三项全清；game 除 `pitchLimit` 死字段外无断链；**debug 断链集中**——输入录制面板 6~7 个控件不存在（#72）、路径可见开关不存在（#73）、PVS 开关控件不存在且字段不参与判定（#74）、`set-cull-distance` 消息无接收（已登记）、4 个配置字段纯死（#75）。证据脚本与原始报告在 `.tmp/audit/` | 审计（只记录不修） |
| 2026-09-28 | **风格化追加（owner：viewer 加导演板/媒体元素突出看录像、game 突出游戏感但忌科幻重元素——简单高端似莱茵生命但不照搬、debug 维持现状）**：**game「冲浪」+25 行竞技面板元素**——ESC 窗口顶部 2px 强调沿边 + 左上/右下两只 1px L 形内嵌角标（`::before/::after`，细线非科幻描边）、导航激活项左缘 2px 强调条、`#fps` 左缘强调条（apps/game/web/styles.css 482→507 行，括号 134/134 平衡）；**viewer「审片室」+19 行媒体元素**——引导卡顶部**场记板斜纹**（`#guide .card::before`，铜金/深色 `-45deg` 硬停重复条纹 12px/24px 相间，上圆角与卡片同径）+ 时间轴上下缘**胶片齿孔**（`#timeline::before/::after`，90deg 硬停镂空孔条 5px/13px，`position:relative` + padding 7→13px 让位；apps/viewer/web/styles.css 431→450 行，括号 164/164 平衡）；**debug 未动**（git diff HEAD 为空）。**审查**：三工程 typecheck 全绿、漂移体检 0/0/0 exit 0、两文件 EOL 净、浏览器实测 viewer 场记板斜纹渲染确认（game 角标为 1px 细线、截图中克制不显眼属预期）。**会话异常记录**：本轮工具回显多次严重错乱（命令与结果均被改写、出现不存在的令牌与文件），已全程改为磁盘 grep/git show 落地核验后采信——途中一次误写（debug 两文件曾被错乱轮写入杂烩）经 `git diff HEAD` 判定为幻象（HEAD 早已含全部主题分化，worktree 与 HEAD 逐字节一致），未落任何坏内容 | 2 个样式文件 + 本文件 |
| 2026-09-28 | **三工程主题分化（owner：配色更精致、忌浮夸阴影、按名称各配主题、全量链路审查——原三兄弟同款灰蓝不行）**：三套单色系令牌互不共用色值——**debug「仪表」**：石墨青黑底 + 示波器天青 `#5bc0e8`（apps/debug/web/index.html 内联块 13 令牌 + 头注改写 + `.mt-modal-box` 软投影，行数中和 795 不变）；**game「冲浪」**：深海黑绿底 + 浪尖青 `#3fd0ad`（apps/game/web/styles.css 整文件重写 482 行）；**viewer「审片室」**：暖炭底 + 放映铜金 `#c9a15e`（styles.css 重写 431 行 + favicon/帮助文本随主题、A-B 区间带并入金族）；精致化 = 浮层（game `.win`/`.load-card`、debug 弹窗、viewer 引导/致命卡）各加一层 `0 6px 20px rgba(0,0,0,0.35)` 软投影（全站唯一允许的阴影），无动画无渐变不变；`SOURCE_LABEL` 三色随 debug 令牌。**全量链路审查**：14 项旧色残留全仓审计 = 0、三强调色归属审计互不串色（debug 3 文件含构建产物、game/viewer 各 1）、三工程 typecheck 全绿、漂移体检 0/0/0 exit 0、8 文件 EOL/BOM 全净、浏览器三 app 截图审查（debug 侧栏/读数块、game 面板、viewer 引导/侧栏）主题渲染正常；viewer 文档 4 处 styles.css 锚点重指（overview :19→:24、scripts-and-test :19/:372→:24/:378、ui.md :345-352→:351-358） | 5 个源文件 + 3 篇文档 + 本文件 |
| 2026-09-28 | **debug 右上参数读数重做（owner：位置自拟、不用现位）**：`#hud` 读数块从预览区右上角移到**左上角**（与 game 的 FPS、viewer 的 HUD 同侧），内容从等宽 `pre` 文本块改为**四行「标签 + 数值」读数**——`updateStatsUI` / `updateCullStatsUI` / `updateGameStatsUI` 改写 `.label`（灰）/ `.v`（亮）span 并落 `innerHTML`（检查点名含地图数据，经 `escapeHtml` 转义；`planeInfo` 保持 `textContent` 纯文本，避免地图派生串入 HTML）；旧 `.v` 的 accent 色改素色。**改动刻意行数中和**（样式块 16→16 行、app.ts 净 0 行），故 9 篇文档 60 余处锚点零波及、文档零改动。**验证**：debug typecheck exit 0、`build:app` exit 0、漂移体检 0/0/0 exit 0（锚点数 2721 不变）、2 文件 noBOM + CRLF、禁用词 0；浏览器实测读数块位置与标签/数值配色渲染正常（未加载地图时四行占位符与旧行为一致） | 2 个源文件 + 本文件 |
| 2026-09-28 | **debug 页面观感重做（owner 追加：debug 也做，修「不通」+ 美观）**：`apps/debug/web/index.html` 的内联 `<style>` 块整体重写为与 game/viewer 同一套扁平素色语言（699→795 行），并修掉一批「样式不通」：`.row` / `.hint` / `.ctrl-radio-group` / `.ctrl-radio` 四个页面在用却无定义的类补齐（权威健康行、光照说明、纹理/光照单选组此前裸奔）；`.health-log` 样式改由内联块承担（外置 styles.css 仍零引用，web.md 缺口 1/4 已改写）；HTML 里约 20 处硬编码旧配色的内联样式改为类（路径图例/构建标签/计数行/按钮行/复选框行/来源徽记/传送点表单）；`app.ts` 的 `renderCustomTeleports` 模板同步改类并重建 `web/app.js`，`SOURCE_LABEL` 与 gameStats 死亡闪烁两处 JS 硬编码色换 `--ok` / `--accent` / `--err` 令牌值（路径图例三色点是 3D 线色数据语义，保留）；传送点表单起始 `style="display:none"` 是 JS 显隐契约（app.ts 读 `style.display` 判态），保留。文档：9 篇 43 处 `index.html` 行号锚点全部重锚（web.md 区段表整表重排、缺口 1/4 改写），另修 app.ts 位移（净 −1、分段）波及的 24 处锚点。**验证**：debug typecheck exit 0、`build:app` exit 0、漂移体检 0 越界 / 0 路径失效 / 0 漂移、exit 0；13 文件 noBOM + CRLF、禁用词 0；浏览器实测侧栏各区 / 传送点表单 / 健康日志渲染正常 | 2 个源文件 + 11 篇文档 + 本文件 |
| 2026-09-28 | **漂移体检 CI 失败修复（[B] 24 + [C] 5 归零）**：#72–#76 删链后 `apps/debug/src/{app.ts,config.ts,renderer/renderer-main.ts,renderer/path-recorder.ts}` 与 `apps/game/src/config.ts` 变短，文档锚点未跟 ⇒ 体检报 [B] 锚点越界 24（exit 1）、[C] 路径失效 5（两个未入库脚本）。逐锚点开箱重定位，修 10 篇 md：README 已知缺口第 1 条改写为「只有回放、无用户录制」；两篇 `differences.md`（debug `config.ts` 205/299→181/259、game `config.ts` 176/239/209→173/235/205、debug `app.ts` 325/286/1934→314/277/1788、debug `renderer-main.ts` 1133→1126）；`app.md`（config 接口清单 13→10、`bindUI` 例句随录制面板删除改写、健康控制台 2508→2352、缺口 1 的九个死 id 改符号留档、缺口 2/3 重锚、缺口 7 改判已处置）；`input.md`（967→833、220→211、2395→2248）；`renderer.md`（RendererMain 约 930 行以下整体 −7（`setPathVisible`/`isPathVisible` 删除所致）、path-recorder 五开关→四开关（687 起））；`web.md`（5 处锚点 + 「五个复选框」→四个）；`sequences.md`（启动表 23 行、消息表、异常表 17 行、时间耦合；B 段重写——「回放中与录制中 100ms 节流状态行」已随 #72 删除，改为 `isExhausted` 自动收尾）；两篇 `scripts.md` 对未入库脚本（debug `jump-apex-measure` / game `phys-p2-regression`）的行号引用改为符号描述——脚本体已不在版本库，行号锚点对库内读者不可验证（与 ⚑「锚点仅在本地有效」口径一致），入库对照物改引 `phys-seed-smoke.mjs` 的 import/initSync 两行与 `renderer-main.ts` 的 `getCurrentState`。**自检**：`check-doc-drift` 越界 0 / 路径失效 0 / 漂移 0 / exit 0；禁用词 0；10 篇 CRLF 无 BOM。**未入库脚本未被推送、未改任何源码**；[D] 歧义 2 处为既有非阻塞项（其一为 README 里裸写 `Cargo.toml` 加行号的引用，同名 manifest 多候选） | 10 篇 md + 本文件 |
| 2026-09-28 | **game / viewer 页面观感重做（owner 要求：朴素、无花哨效果、不得参考现有样式；debug 酌情保留、本轮未动）**：两份 `web/styles.css` 全部重写为同一套扁平素色语言——实色面板 + 1px 边框 + 单强调色 `--accent`，**零 animation / transition / 渐变 / 装饰性 box-shadow / backdrop-filter**（game 614→478 行、viewer 399→423 行）；JS 钩子全覆盖（`hidden` / `show` / `active` / `on` / `off` / `recording` / `outline` / `no-dot` / `busy` / `invalid` / `full` 等状态类与 `--ch-*`、`--load-pct` 两个行内变量契约不变）；滑块 / 开关 / 下拉改走原生控件 + `accent-color`（不再自绘）；准星几何与「淡蓝带 / 金色框」A-B 语义色保留（页面帮助文本按此描述）；game 的状态 LED 呼吸灯改为常亮三态圆点。`index.html` 只改 game 注释两处与 viewer favicon 配色（行数 293 / 113 不变 ⇒ 文档锚点全部有效）；文档同步 3 处 `styles.css` 锚点（viewer `overview.md` :30→:19、`scripts-and-test.md` :30/:278→:19/:372、`ui.md` 八键网格 :326-333→:345-352）。**验证**：game / viewer typecheck exit 0；漂移体检 0 越界 / 0 路径失效 / 0 漂移、exit 0；7 个改动文件 noBOM + CRLF；浏览器实测（dev 服务 + 截图）game 面板两页与 viewer 引导层 / 侧栏渲染正常、WASM 无致命错误 | 4 个 web 资产 + 3 篇文档 + 本文件 |
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
| 69 | ~~9 个 `.cmd` 5 条~~ **部分已消除（2026-09-24）**：三工程入口已统一改为 `dev.cmd` / `build.cmd` / `start.cmd`（旧的 `start-dev` / `play` / `build-dist` 九个文件删除）；`dev` / `build` 改为**无条件** `build:wasm` ⇒ 「门/消费方 wasm 路径错配」与「工具链守卫不全」两类已消除（见 `documents/debug/implementation/scripts.md` 已知缺口 8–10 与 `documents/viewer/implementation/scripts-and-test.md` 9/11）。**仍待裁决**：viewer `start.cmd` 的 python 守卫使 `dist/play.cmd` 的 Node 兜底不可达（viewer 已知缺口 10）、`build.cmd` single-only 与底层 `--multi` 不一致（viewer 已知缺口 8）、端口占用分支假定占用者服务的是 `dist/`（viewer 已知缺口 13） | 待裁决（3 条） |
| 70 | **依赖表「本 crate 无引用点」清单**（两法一致：源码引用面扫描 + `cargo check` 的 `-W unused-crate-dependencies`）：debug `websurf-wasm` **26 项**、game **29 项**、viewer **1 项**（`gltf`）；另 `websurf-wasm-core` **3 项**、vendored `vmdl` **1 项**（`tracing`，上游 manifest 同样声明）。判读：**无引用点 ≠ 可删**（`getrandom` / `getrandom_03` / `path_dedot` 是 **feature 开关**），故未动任何配置行；如需瘦身建议**逐项删 + 每次跑 `cargo check` 与 `npm run build:wasm`** 验证 | 待裁决（本轮只测不改） |
| 71 | debug `renderer-main.ts` optimizeScene 调用链注释「其又源自 harness worker-b」与 game 侧同构注释措辞不一致（2026-09-23 验收审查新发现；字面判据 0 违规——未写完整工程名，完整记录见 2026-09-23 验收审查行——原台账已退役删除，git 历史 commit `9dbdc58` 可查） | 待处理（1 行注释对齐，属注释重编范围） |
| 72 | ~~debug 输入录制/回放面板整组控件不存在~~ **已处置（2026-09-26，owner 裁定删链）**：删除 `inputRecorder` 与七个 `#inputRec*` 句柄、`updateInputRecUi`、`startRecording` / `stopRecording`、`buildReplayMeta`、面板六个按钮监听、`__wsInput` 的 `start` / `stop` / `clear` / `isRecording` / `exportJson` / `status`（新增 `progress`），以及 `loadedSpawnList`。**回放能力保留**（`load` / `play` / `stopPlay` / `captureText` / `progress`）。debug typecheck exit 0；审计 A1 只剩 `clearTeleportsBtn`（动态生成，非缺陷）。**遗留**：`apps/debug/scripts/input-replay-verify.mjs` 依赖已删除 API ⇒ 脚本不可用（本就必然失败） | **已结案**（附 1 项脚本遗留） |
| 73 | ~~debug 路径可见开关不存在~~ **已处置（2026-09-26，删链）**：删除 `dom.pathVisibleChk` 绑定与其 change 监听、`RendererMain.setPathVisible`、`PathRecorder.setVisible`——页面无该 id，且四个分量开关（`index.html:410`、`:413`、`:417`、`:421`）已覆盖其语义。debug typecheck exit 0 | **已结案** |
| 74 | ~~debug PVS 开关双断~~ **已处置（2026-09-26，删链）**：删除 `dom.pvsEnabledChk` 绑定 + 三处消费者（初始同步 / 场景就绪同步 / change 监听）+ `config.lod.pvsEnabled` 字段与其默认值；`syncFullConfig` 段清单收敛。剔除行为不变（只按距离判据）。debug typecheck exit 0；`documents/debug/implementation/{app,web}.md`、`documents/architecture/overview.md` 已同步 | **已结案** |
| 75 | ~~debug 四个配置字段纯死~~ **已处置（2026-09-26，删字段）**：`physics.duckScale` 与三个整段 `MovementConfig` / `SmoothingConfig` / `TeleportConfig`（`speed` / `sprintMultiplier` / `triggerRadius` / `cooldownMs`）已从 `RuntimeConfig` 与 `DEFAULT_CONFIG` 移除，`syncFullConfig` 不再下发；传送判定仍用 `teleport-manager.ts` 的模块常量。debug typecheck exit 0 | **已结案** |
| 76 | ~~game `pitchLimit` 死字段~~ **已处置（2026-09-26，删字段）**：已从 `InputConfig` 与 `DEFAULT_CONFIG` 移除（pitch 限幅由 Rust 承担）；`documents/game/implementation/{config,panel}.md` 已同步。game typecheck exit 0 | **已结案** |
| 78 | **debug / game 的 `RendererMain.getLightingMode()` 零调用点**：debug 与 game 各有一份（转发给 `renderer/lightmap-shader.ts` 的 `getLightingMode`），`apps/<app>/src` + `src/ts-shared` + 工程 `scripts` 内均无调用者（同族的 `setLightingMode` 有调用）。属"有实现未接线"——保留还是删除未定 | 待裁决 |
| 79 | **game `RendererMain.resetTo()` 与 `stop()` 零调用点**：`start()` 由 `apps/game/src/app.ts:170` 调用、`stop()` 无人调用 ⇒ rAF 循环启动后没有停止路径（换图走 `disposeScene`，循环照跑；页面卸载才自然结束）。对比 debug 的 `resetTo` 有 7 处调用（传送/重置/检查点回退） | 待裁决 |
| 80 | **worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）**：debug/game 的 `worker-types.ts` 里 `ready` / `bsp-metadata` / `stats` / `player-respawn` 等成员既无发送方也无接收方；分发层的 `set-mode` / `mode-ack` 在本仓无发送/接收点（harness 退役后）。明细见 `documents/debug/implementation/worker.md`、 `documents/game/implementation/worker.md`、 `documents/debug/sequences.md:127`、 `documents/game/sequences.md:99` | 待裁决（仅类型面，无运行时影响） |
| 82 | **v5 面板绑定审计：命中全为间接下发（非缺陷）**：`apps/game/src/panel/panel-controller.ts` 有 11 个绑定（`showCrosshair` / `chSize` / `chThickness` / `chGap` / `chOutline` / `chDot` / `fov` / `renderDistance` / `exposure` / `lightGamma` / `ambientScale`）的回调不含显式下发动词，但都走 `ch()` → `applyCrosshair` + `savePanelPrefs`，或 `this.onSyncXxx?.(v)`；五个 `onSync*` 钩子在 `apps/game/src/app.ts:193-197` 全部接到 `renderer.setFov` / `setRenderDistance` / `setExposure` / `setLightGamma` / `setAmbientScale` ⇒ 面板改动确实生效。**初筛正则（`.tmp/audit/page-chain-audit5.mjs`）认不出间接下发，判读必须追到被调函数** | 已知（工具边界，非缺陷） |
| 81 | **v4 审计工具边界（留档）**：`.tmp/audit/page-chain-audit4.mjs` 会误报两类 —— ① 动态生成的 class（game 的 `.key-chip` / `.key-add` 由 `renderKeyList` 的 innerHTML 产出，H 会判"页面不存在"）；② `worker-types.ts` 里的**联合类型声明**（`type: 'x'` 字面量不是发出点，E 会判"无处理分支"）。均需回源码确认 | 已知（工具边界，非缺陷） |
| 77 | **审计脚本的口径边界（留档）**：`.tmp/audit/page-chain-audit3.mjs` 的 id 提取不覆盖 `qs<T>('x')` 泛型写法与事件委托 ⇒ viewer 的 `#guideBtn` / `#helpBtn` / `#sidebarToggle` 等被误报为死 id（实测均由 `qs<T>()` 正常取用，`apps/viewer/src/app.ts:68`、`:228`、`apps/viewer/src/ui/hud.ts:31`）；同类漏检方向也适用于 debug/game | 已知（工具边界，非缺陷） |

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
