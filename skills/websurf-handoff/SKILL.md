---
name: websurf-handoff
description: WebSurf 仓库的多卡/跨档次 Agent 接力规范：单源三件套、并发 worktree/共享工作树隔离、熔断红线与终审 5 点跨卡清单。只在批量委派、多卡并发或跨模型接力时使用；日常单卡小修跳过本文。
user-invocable: false
---

本技能规范「高阶设计 / 中阶执行 / 高阶终审」的批量接力协作；**日常单卡小修不要加载本文**（直接改代码 → `npm run verify:fast` 或 `verify:ts` → `git commit`）。

## 1. `.tmp/<主题>/` 单源三件套（禁双写进度）

| 文件 | 维护者 | 规则 |
|---|---|---|
| `PLAN.md`（及可选 `WAVE*.md`） | 高阶规划者（写一次） | 执行期**只读**，不在里面维护第二份进度表。每张卡包含 8 段：元数据 / 目标 / 前置自检（用 `git grep`，禁用 `rg`）/ IN-OUT 边界 / 蓝图 / 门禁预警 / `npm run verify:*` 验收 / 熔断条件 / 提交模板 |
| `PROGRESS.md` | 中阶 Lead（唯一活台账） | 记录总进度、提交 SHA、跳过的子步与遗留项；收工时在顶部填好 `Closeout for Reviewer` 信封 |
| `progress/<卡号>.md` | 各执行 Agent（只追加） | 按时间追加流水：`开始` / `里程碑` / `验收` / `提交` / `交付或熔断`，互不修改别人文件 |

### `PROGRESS.md` 顶部 `Closeout for Reviewer` 模板

```markdown
## Closeout for Reviewer
- 提交区间：`base..HEAD`（共 N 笔，卡→SHA 见下表）
- 最终验证：`npm run verify:full` -> exit 0（含单测数 / 三端 wasm 字节数）
- 跳过/熔断项：无（或列出卡号、原因、progress 链接）
- 门禁白名单新增：无（或列出文件名与条目，如 NUMERIC_RENAME_ALLOW / KNOWN_CONTENT_DIFF_ALLOW）
- 范围外附带文件：无（或说明如 Cargo.lock / TODO.md）
- 未测盲区与待拍板 `D-###`：列出未跑真机场景及 `OWNER.md` 候选编号
```

## 2. 并发协作：Worktree 优先，共享树从严

1. **优先 `git worktree`**（推荐）：
   - `git worktree add ../websurf-wt-<卡号> dev`；
   - 通过共享环境变量 `CARGO_TARGET_DIR` 与目录 junction 复用 `node_modules`，磁盘开销极低且彻底隔离 git index 与 `tsc`。
2. **若不得不在同一工作树分 lane 并行**，必须满足两条硬约束：
   - **严格互斥归属**：同一文件同一波次只能由 1 个 lane 持有；跨模块枢纽文件（如 `render-session.ts`、`world.rs`）串行排队，禁止两方同时改；
   - **提交闸门串行化**：严禁 `git add .` / `git add -A` / `git commit -a`，必须 `git add -- <本卡文件>` + `git commit -- <本卡文件>`；**若因另一 lane 在途改动导致全局 `typecheck` 红灯，严禁带红提交**（等待对方落盘或由 Lead 统一集成后再提交）。

## 3. 中阶熔断红线（遇之即停，禁止硬过）

- 任意 `npm run verify:*` 或门禁红灯且无法归因到自身小笔误；
- `.wasm` 体积超出 `±3%` 或 `PKG_EXPORT_BASELINE` 导出名变动；
- 同图 GLB `sha256` 出现非预期字节差异；
- 发现任务卡未预见的跨端语义分叉，或需要改动 `OWNER.md`（`D-###`）级别架构边界；
- **严禁**：修改 `~/.cargo/registry` 绕过工具链问题、擅改基线白名单、删测试断言、`git checkout -- <file>` 或 `git commit --no-verify`。

## 4. 高阶终审 5 点跨卡清单

执行方宣布收工后，终审 Agent 按序核查这 5 项（专抓「单卡各自全绿、合起来出缝」的漏网 Bug）：

1. **跨模块边界交互**：新数据结构 × 既有生命周期 / 缓存 / PVS / 懒初始化（例如纯动态梯子分支、移动后动态实体组 PVS 剔除、多端重复解析）；
2. **构建产物新鲜度**：核对 `apps/*/pkg/*.wasm` 与 `apps/*/web/*.js` 是否晚于对应最后一次 Rust/TS 提交（`npm run dev:check` 可辅助查过期提示）；
3. **白名单与锁文件净度**：审查所有新增白名单是否必要且精准，确认根 `Cargo.lock` 与三端锁文件无残余；
4. **独立复跑全量验证**：亲自执行 `npm run verify:full`（或至少 `verify:rust` + `verify:ts` + `check-lock-consistency` + `check-glb-parity`）；
5. **就地闭环收尾**：小范围边界 Defect 就地修成 1 笔干净补刀提交并复跑 `verify:full`；跨线语义或不可逆架构抉择登记回 `OWNER.md` 交 Owner 拍板。
