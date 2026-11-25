---
name: websurf-handoff
description: WebSurf 仓库的多卡委派与跨档次 Agent 接力规范：角色分工、.tmp/<主题>/ 单源三件套、标准派单模板、worktree/共享工作树并发隔离、熔断红线与终审 5 点跨卡清单。只在批量改造、多卡并行或高阶↔中阶跨模型接力时加载；日常单卡小修跳过本文。
user-invocable: false
---

本技能规范「高阶规划 / 中阶执行 / 高阶终审」的批量接力协作；**日常单卡小修跳过本文**（直接改代码 → `npm run verify:fast` 或 `verify:ts` → `git commit`）。

## 0. 角色分工与接力主链路

```text
Owner 提需求
   │
   ├─ 单卡小修 ──► Agent 直接修改 ─► npm run verify:fast|ts ─► git commit (dev)
   │
   └─ 多卡/跨模块批量任务
        │
        ▼
  高阶 Planner（只读设计）──► .tmp/<主题>/PLAN.md + WAVE*.md + 标明 OWNER 闸门 (D-###)
        │
        ▼
  中阶 Lead / Worker 团队 ──► 领卡 ─► 前置自检 ─► 改代码 ─► verify:* ─► 1 卡 1 commit
        │                                                       │
        │ （遇熔断红线：写 progress/<卡号>.md 停手上报）          │ （全部完成：Lead 填 Closeout 信封）
        ▼                                                       ▼
  高阶 Reviewer（终审）◄────────────────────────────────────────┘
        │
        ├──► 跑 5 点跨卡复核 + 独立 npm run verify:full
        ├──► 小范围边界 Defect：就地 1 笔补刀提交 + verify:full
        └──► 向 Owner 交付结论 + 待拍板 D-### 清单（不自行 push）
```

## 1. `.tmp/<主题>/` 单源三件套（禁双写进度）

| 文件 | 维护者 | 职责与规则 |
|---|---|---|
| `PLAN.md`（或 `README.md` + `WAVE*.md`） | 高阶规划者（写一次） | 执行期**只读**，不在规划文档里重复维护实时进度表。每张卡固定 8 段：元数据 / 目标与背景 / 前置自检（用 `git grep`，禁用 `rg`）/ IN-OUT 边界 / 逐文件蓝图 / 门禁预警 / `npm run verify:*` 验收 / 熔断条件与提交模板 |
| `PROGRESS.md` | 中阶 Lead（唯一活台账） | 记录总进度、卡→提交 SHA、跳过子步与遗留项；收工时在顶部填好 `Closeout for Reviewer` 交接信封 |
| `progress/<卡号>.md` | 各执行 Agent（只追加） | 按时间追加：`开始` / `里程碑` / `验收` / `提交` / `交付或熔断`，互不修改他人卡日志 |

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

## 2. 给派活人的标准派单 Prompt 模板

```text
请严格按 AGENTS.md 的红线与 .tmp/<主题>/<分册>.md 中的任务卡 <卡号> 执行改进：
1. 先执行「前置自检命令」（用 git grep，不用 rg），前提不符立即停止并回报，严禁猜测继续；
2. 严禁修改「OUT-OF-SCOPE」以外的文件，严禁顺手重构无关代码或修改 OWNER.md 级别待决边界；
3. 严禁修改 PKG_EXPORT_BASELINE / WASM_SIZE_BASELINE 或使用 --no-verify / PRECHECK_BYPASS=1；
4. 用 npm run verify:fast|rust|ts|full 执行验收（避开 PowerShell 5.1 无 && 的坑），日志较长先落 .tmp/ 再核对；
5. 验证全绿后按模板在 dev 分支生成单个 pathspec 原子提交（git add -- <files>），不要 git push；
6. 将开始/验收/提交 SHA/遗留追加写入 progress/<卡号>.md。
```

## 3. 并发协作：Worktree 优先，共享树从严

1. **优先 `git worktree`**（推荐）：
   - `git worktree add ../websurf-wt-<卡号> dev`；
   - 通过共享 `CARGO_TARGET_DIR` 与目录 junction 挂接 `node_modules` 省磁盘，彻底隔离 git index 与 `typecheck`。
2. **若必须共用主工作树分 lane 并行**，强制遵守两条底线：
   - **严格互斥归属**：同一文件在同一波次只能由 1 个 lane 持有；跨模块枢纽文件（如 `render-session.ts`、`world.rs`）只能串行排队，禁止两方同时编辑；
   - **提交闸门串行化**：严禁 `git add .` / `git add -A` / `git commit -a`，一律 `git add -- <本卡文件>` + `git commit -- <本卡文件>`；**工作区若因他方在途改动导致 `typecheck` 红灯，严禁带红提交**，等对方落盘或由 Lead 统一集成后再提交。

## 4. 中阶熔断红线（遇之即停，禁止硬过）

- 任意 `npm run verify:*` 或仓库门禁红灯且无法归因到自身小笔误；
- `.wasm` 体积超出基线 `±3%` 或 `PKG_EXPORT_BASELINE` 导出名发生增删；
- 同图 GLB `sha256` 出现非预期字节差异；
- 发现任务卡未预见的跨端语义分叉，或需要触发 `OWNER.md`（`D-###`）决策；
- **严禁**：修改 `~/.cargo/registry` 绕过工具链问题、擅改门禁基线/白名单、删改既有测试断言、`git checkout -- <file>`、`git commit --no-verify`。

## 5. 高阶终审 5 点跨卡清单

执行团队通过 `Closeout for Reviewer` 交接后，终审 Agent 按序重点排查单卡测试最易漏掉的问题：

1. **跨模块边界交互**：新数据结构 × 既有生命周期 / 缓存 / PVS 剔除 / 懒初始化 / 多端重复解析（例如纯动态梯子分支、移动后动态组 PVS 过时 `clusterIds`、双次 `JSON.parse`）；
2. **构建产物新鲜度**：核对 `apps/*/pkg/*.wasm` 与 `apps/*/web/*.js` 是否晚于对应最后一次 Rust/TS 提交（`npm run dev:check` 自动检查 `STALE`）；
3. **白名单与锁文件净度**：审查所有新增白名单是否精准必要，确认根 `Cargo.lock` 与三端锁文件无残余；
4. **独立复跑全量验证**：亲自运行 `npm run verify:full`（或至少 `verify:rust` + `verify:ts` + `check:api` + `check-lock-consistency` + `check-glb-parity`）；
5. **就地闭环收尾**：小范围边界缺陷就地修成 1 笔干净补刀提交并复跑验证；跨线语义或不可逆架构抉择写入 `OWNER.md` 交 Owner 拍板。
