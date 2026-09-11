# 共享层解耦与上提规范

> 定位：`apps/{debug,game,viewer}` 三个应用工程与 `src/` 共享层之间「**什么该上提、什么必须留在工程内**」的判定准则、逐项裁决、目标结构与分批迁移顺序。逐条闭合 R-18…R-21。
> 事实基线：[framework-audit.md](framework-audit.md)（t1 审计：实测证据与 R-01…R-21 条款）。结构/入口/端口/输出基线：[framework-launch-structure.md](framework-launch-structure.md)（t2 规范）。
> 本轮边界：**只写规范，未搬迁任何代码或文件，未改 `package.json` / `tsconfig.json` / `Cargo.toml` / CI**。§3.3、§6、§7 的文件级动作全部是**待执行**清单，不代表仓库已改。
> 记号：**【必须】** 违反即缺陷；**【禁止】** 出现即缺陷；**【豁免】** 允许不同，但必须有对应条目与理由；【更正】/【补充】 表示对 t1 或 t2 文档的修正。
> 每条裁决都带「依据」与「反向否决理由」（为什么**不**做相反的选择），不允许两边都说得通。

## 1. 定位、记号与边界

### 1.1 适用范围

- 对象：`apps/debug/`、`apps/game/`、`apps/viewer/` 与共享层 `src/`；`test/dual-mode-harness/` 作为共享工具的**受益方**登记（其文件改造不在本轮 inScope）。
- 覆盖：共享**工具/脚本**（`.cmd` / `.mjs`）、共享 **TS 实现**、构建链公共部分、类型契约、常量与数据副本。
- 不覆盖：启动入口与端口的条文（t2 §2）、目录必备清单（t2 §3.1）、`package.json` 九键（t2 §4.2）、dist 形态规则（t2 §5.2）。

### 1.2 记号与占位符

| 记号 | 含义 |
|---|---|
| `D-nn` | 本文件的**解耦候选裁决编号**（§3.2 总表） |
| `E-nn` | **不可合并例外编号**（§8.2 例外表） |
| `T-nn` | 共享构建/校验**工具提案编号**（§6.1） |
| 批 1 / 批 2 / 批 3 | 迁移批次（§7.1） |
| R-nn | [framework-audit.md](framework-audit.md) §8 的规范需求条款 |
| `<app>` | 取 `debug` / `game` / `viewer` |

### 1.3 与 framework-launch-structure.md 的优先级与冲突登记

[t2 §1.3](framework-launch-structure.md) 已约定：**共享层内容归属以本文件为准；入口 / 结构 / 端口 / 输出以 t2 为准；任一冲突处必须在两份文档中各写一条交叉引用。** 本文件对 t2 的处置如下（t2 若有异议，按其 §1.3 于双方各补一条交叉引用）：

| # | t2 条文 | 本文件裁决 | 性质 |
|---|---|---|---|
| C-1 | §3.6、§10.1 第 13 条：`apps/debug/scripts/install-wasm-bindgen.cmd` 第 19 行**就地**补一层 `..` | 判**上提**到 `src/scripts/install-wasm-bindgen.cmd`（D-02），移动后该调用变为同目录 `%~dp0cargo-env.cmd`，层数问题随之消失。**captain 已裁定采纳本节裁决**：t2 §3.6/§10.1 的「就地补层」**降级**，t2 侧改为「上提 + 调用方同步」——冲突已消解，读者不必再按未决冲突处理 | **冲突 → 已裁定**（物理落点由本文件定稿） |
| C-2 | §3.6、§10.1 第 20 条：`apps/viewer/scripts/check-wasm-api.mjs`「新建（**或改为引用共享实现**）」 | 取**引用共享实现**分支：引擎落 `src/scripts/lib/wasm-api-contract.mjs`，工程内为薄配置（D-03） | 一致（t2 已给出该选项） |
| C-3 | §10.1 第 11/12 条：三份 `build-dist.mjs` 的产物/许可证改造 | 由 D-04 的共享内核承接；**排序要求**：内核抽取（批 3）必须排在 t2 §10.3 第 3 步**之后**，否则同一文件被两轮修改 | 一致 + 排序约束（§7.5） |
| C-4 | §3.6：viewer 的 `ensure-node-deps` 未列入动作清单 | 本文件**补充**：viewer 的 2 处内联依赖判断（`apps/viewer/build-dist.cmd`、`apps/viewer/play.cmd`）改为调用共享脚本（D-01） | 补充（非冲突） |
| C-5 | §8.2/§8.3：viewer 的 single-only、debug 的 `fixtures/` 与 `pages-index.html`、5 份 `[patch.crates-io]`、4 份 `wasm.d.ts` | 本文件与之一致，并升级为 §8 禁止清单的硬条目 | 一致 |

**【必须】** 本节 C-1 落库时，t2 文件内同步补一条指向本节的交叉引用（由 t6 集成任务执行）。
- 文件级待执行动作的**总表以 [t2 §10.1](framework-launch-structure.md) 的 24 项为准**，本文件**不重列**；本文件只补 t2 未列或落点不同的项（C-1、C-4），其余直接引用该表：viewer 补 `check:api`（第 20 项）、两个待建 `start-dev.cmd`（第 1、2 项）、21 个孤儿脚本注册（第 17 项 8 个 + 第 18 项 13 个）、CI 收敛（第 22 项）。
- **端口不在本文件定义**：端口段与槽位以 [t2 §2.3](framework-launch-structure.md) 为唯一事实来源；本文件提到端口处均为**脚本默认参数或现状事实**的引用，不构成第二套端口表。

### 1.4 边界声明（本轮未执行任何搬迁）

- 本文出现的所有「新增 / 删除 / 移动 / 改 import」都是**待执行动作**，仓库代码状态与审计前一致。
- 本文件引用的行号是**改造前**的实测行号；批 1/2/3 落库后必须按 [AGENTS.md](../AGENTS.md) §5.3 回改被引用的锚点（§7.6 列出具体清单）。
- **许可证实物搬迁属待执行改造**：`apps/debug/src/physics/{LICENSE,NOTICE}` → `src/phys/` 的移动、game 侧 dist 拷贝步骤的补齐（D-23 / E-08），截至本文件落盘**均未执行**——许可源当前仍在 `apps/debug/src/physics/` 下（`Test-Path` → `True`），而 `src/phys/LICENSE`、`src/phys/NOTICE` **尚不存在**（`Test-Path` → `False`）。

## 2. 上提判定准则

### 2.1 五个维度与判定阈值

【必须】一条候选只有**至少命中一个维度**且**不触发任何维度的否决条件**时，才允许上提。

| 维度 | 判据（可判定） | 阈值 / 检验方法 | 否决条件 |
|---|---|---|---|
| ① 重复度 | 同一实现/契约在仓库内的副本数 | **比对单位（先看这条）**：整份文件用 `git diff --no-index --numstat A B`；**非文件对候选**（函数级 / 代码块级 / 常量级多副本）改用「**语义等价的最小实现单元**」（该函数体 / 那段循环块 / 那个常量字面量），抽取与分级步骤见 §2.3 边界 4。**级别 A**：比对单位归一化（标识符重命名、内联 vs 具名函数、缩进与注释**均不计为差异**）后**全等** → **必须上提**；**级别 A′**（**非文件对候选专用**）：归一化后仅剩 **≤ 2 个语义 token**（运算符 / 字面量 / 默认值 / 边界条件）不同 → **必须上提**，且单点实现**必须**声明取哪一支语义并给出不回归理由（口径见 §2.3 边界 4 末条）；**级别 B**：算法骨架逐句同构、差异仅在数据表/路径常量 → **上提引擎、数据留在工程**；**级别 C**：归一化行重合 < 0.6 且无同构骨架 → 不上提 | 副本数 = 1（无第二消费方） |
| ② 变更耦合 | 改动一处是否**必须**同时改另一处，否则产生静默不一致 | 查 `git log --follow -- <A> <B>`：同一提交内成对出现 ≥ 2 次 → 必然同步；仅因同名/同模板而相似 → 偶然相似 | 差异由「每工程参数」决定（工程名/端口/目录） |
| ③ 依赖方向 | 依赖是否单向、共享层是否会被迫知道工程细节 | 见 §2.2 的「依赖方向」命令（用 `git grep` 检出共享层内的工程路径）——命中只允许出现在注释；上提后若共享层需要知道 pkg 名/端口/工程名 → 改为**参数注入**，否则不上提 | 上提会使共享层反向依赖 `apps/` |
| ④ 构建可行性 | 上提后的落点能否解析其依赖 | 从目标落点实测解析：`node -e "require.resolve('<dep>',{paths:['<落点>']})"` 必须成功；失败则该依赖**必须**由调用方注入 | 依赖无法解析且不能参数化 |
| ⑤ 平台/运行时约束 | 差异是否由浏览器/Node、single/multi、SAB（COOP/COEP）能力决定 | 把两侧差异逐条归类为「参数」或「偶然」；**参数条目 > 差异总数一半 → 不上提** | 参数化成本高于重复成本 |

### 2.2 判据的检验方法（可执行）

```bash
# 级别 A/B：重复度
git diff --no-index --numstat apps/debug/scripts/ensure-node-deps.cmd apps/game/scripts/ensure-node-deps.cmd
git diff --no-index --numstat apps/debug/src/world/pvs-manager.ts apps/game/src/world/pvs-manager.ts

# ③ 依赖方向：共享层不得出现工程路径
git grep -nE "apps/|\\.\\./\\.\\./\\.\\." -- src

# ④ 构建可行性：从候选落点解析依赖（本文件已实测，见 D-04）
node -e "try{require.resolve('esbuild',{paths:['<落点>']});console.log('OK')}catch(e){console.log('FAIL '+e.code)}"

# ⑤ 平台约束：两侧差异逐条归类
git diff --no-index apps/debug/scripts/build-dist.mjs apps/game/scripts/build-dist.mjs
```

### 2.3 R-18 的适用边界（四条细化，不改变 R-18 命题）

R-18 原文：同一算法/常量在仓库内只允许一份实现；阈值为「剔除以工程为单位的 import 行后内容全等，或差异行数 ≤ 5 行」。为避免执行者机械套用阈值，本文件做四点**适用面细化**：

- **边界 1（载体）**：R-18 的对象是**实现载体**（算法、数据转换、标定常量、协议结构），**不**覆盖入口编排脚本、编译器配置、依赖清单与上游许可文件。这些文件的差异是「每工程参数/环境」的函数，统一手段是 t2 的模板条文（§2.4/§2.5/§3.4），不是文件合并。→ 对应 D-05、D-15、D-19、D-20。
- **边界 2（阈值分两级）**：数值阈值（全等 / `numstat ≤ 5`）只覆盖**近乎全等的文件对**（级别 A）；**同算法不同数据表**（级别 B）不命中数值阈值，但受 R-18 前半句约束，判定依据 = 按语句对齐后除数据字面量/路径常量外无结构差异。→ 对应 D-03。
- **边界 3（数学恒等式）**：`Math.PI / 180` 这类**数学恒等式**的重复定义不计入「常量重复」；R-18 的「常量」指**会变更的标定常量**（`EYE_STAND`、`TICK_PERIOD_MS`、`DELTA_*` 一类）。→ 对应 D-16；`DEG2RAD` 在三处出现（`apps/viewer/src/core/constants.ts:3`、`apps/debug/src/renderer/renderer-main.ts:1710`、`apps/game/src/renderer/renderer-main.ts:26`）判**不上提**。
- **边界 4（非文件对候选的分级 —— 即「A/B 边界」档位的定义）**：当重复发生在**同一个符号**（函数 / 常量 / 代码块）而非整份文件时，`numstat` 不适用（它衡量整份文件的差异）。此时**必须**先抽取「语义等价的最小实现单元」再比对，四步法如下（可复现）：
  1. **定位全部副本**：分别执行 `git grep -n "function <符号名>" -- apps src/ts-shared` 与 `git grep -n "const <符号名> =" -- apps src/ts-shared`（**禁止**用文件对 diff 代替——那会把两个文件的无关差异算进来）；
  2. **抽取实现单元**：取该符号的函数体、该段循环/赋值块或该常量字面量；`export` / `function` / `const` / 类型标注等**外壳不计入**比对；若某副本写成**委派**形式（如 `return wrapDeg(x + 180)`），**先内联被委派函数**再比对，否则会把「委派 vs 内联」的形式差异误判为级别 C；
  3. **归一化**：去注释、trim 缩进，并把**标识符重命名**（`bin` / `binary`、`bytes` / `mtzBytes`）、**`len` 常量提升**、**内联 vs 具名函数**、**`{}` 块有无**统统视为**非差异**；
  4. **定级**：归一化后**全等** → **级别 A**；仅剩 **≤ 2 个语义 token**（运算符 / 字面量 / 默认值 / 边界条件）不同 → **级别 A′**；差异为数据表 / 路径常量 → 级别 B；其余 → 级别 C。
  **语义归一口径（A′ 专用）**：【必须】A′ 档的单点实现写明采纳哪一支语义，并说明该选择不引入行为回归——例：`|| 0` 把 `-0` 归一为 `0`，两者数值相等、仅符号位不同，故取「带 `|| 0`」一支可覆盖两支的取值域。→ 对应 D-08（级别 A′）、D-09（级别 A，代码块级）。

### 2.4 反例库：五种不该上提的形状

| 形状 | 实例 | 为何不是解耦候选 |
|---|---|---|
| 同名不同责 | `apps/{debug,game}/src/input/input-bridge.ts`（D-14） | 名字巧合，职责正交 |
| 结构类型可互换 | `Vec3`（D-07） | TS 结构化类型下两份 `{x,y,z}` 互相赋值合法，无编译期耦合 |
| 阈值命中但语义不同 | 两份 `tsconfig.json`（`numstat 2 2`，D-15） | 数值阈值不足以判定「同一算法」 |
| 唯一消费方 | `apps/debug/src/physics/` 子树（D-06） | 复制一份的收益是零 |
| 数据/二进制派生物 | `web/textures.mtz`（D-11） | 需要「保留副本 + 一致性门禁」，不是「合并实现」 |

## 3. 逐项裁决表

### 3.1 候选来源

候选 = t1 审计 §4.2（同名文件近重复度）、§4.3（同字节重复）、§5.3（消费矩阵）、§6（不一致清单 I-15/I-10/I-12/I-21 等），**加上本次补充实测**（D-08、D-09、D-10、D-11、D-16）。

### 3.2 裁决总表

裁决取值：**上提** / **保留** / **合并到统一工具** / **保留副本 + 门禁**。

| # | 候选（真实路径） | 实测重复度 | 裁决 | 依据 | 反向否决理由（为什么不反过来） |
|---|---|---|---|---|---|
| D-01 | `apps/debug/scripts/ensure-node-deps.cmd`、`apps/game/scripts/ensure-node-deps.cmd` | **级别 A**：字节全等（各 1267 B，SHA256 前 16 位 `EAB3496C3F1EE6FB`） | **上提** → `src/scripts/ensure-node-deps.cmd` | ①重复度级别 A；②变更耦合：npm 引导逻辑任何修复必须双改；③R-19 直接命中；④先例：`src/scripts/cargo-env.cmd` 已是同类共享脚本；⑤t2 §8.3 已禁止两份并存 | 保留两份 → R-19 命题永久不成立，且出现「一半共享（`cargo-env.cmd`）一半复制（`ensure-node-deps.cmd`）」的认知负担；再遇第三工程即第三份 |
| D-02 | `apps/debug/scripts/install-wasm-bindgen.cmd`（105 行，全仓单份） | 副本数 1，但**归属错位** | **上提** → `src/scripts/install-wasm-bindgen.cmd` | ①依赖方向：它已 `call` 共享 `src/scripts/cargo-env.cmd`（`apps/debug/scripts/install-wasm-bindgen.cmd:19`），而共享文件 `src/scripts/cargo-env.cmd:24` 的注释反向指向 `debug/scripts/install-wasm-bindgen.cmd`——共享层反向依赖工程内文件；②内容零工程特征（固定版本 `0.2.128`、固定 URL、缓存目录来自共享 env）；③它当前带 I-22 层数缺陷 | 保留在 debug → ①共享文件注释将永久指向工程内路径；②game/viewer 若需预装 wasm-bindgen 只能再复制一份（正是 R-19 要防的情形）；③就地补 `..`（t2 §10.1 第 13 条）只是修症状，归属仍错位 |
| D-03 | `apps/debug/scripts/check-wasm-api.mjs`、`apps/game/scripts/check-wasm-api.mjs`、`test/dual-mode-harness/scripts/check-wasm-api.mjs` | **级别 B**：game(80 行) vs harness(56 行) `numstat 16 40`，除 dts 名与 API 表外逐句同构（存在性检查 → 正则 `\bname\s*\(` → missing 报告 → 退出码） | **合并到统一工具** → 引擎 `src/scripts/lib/wasm-api-contract.mjs` + 各工程薄配置 | ①重复度级别 B；②变更耦合：错误文案/提示语/退出码三处各自演化；③t2 §3.6、§10.1 第 20 条已要求 viewer 补该脚本——不统一则副本数 3→4 | **整份上提（含 API 清单）**：三工程契约面本就不同（debug 动态比对 12 个导出符号、game 16+17 项、harness 12 项），清单属**工程契约**；塞进共享层会让共享层必须按工程分支，且 Rust 导出层增删 API 时要改共享层。t2 §8.2 明确把 debug 的「导出/导入动态比对」列为工程特有能力，不得删除 |
| D-04 | `apps/{debug,game,viewer}/scripts/build-dist.mjs`（7996 / 7351 / 11191 B；harness 第 4 份） | **级别 B**：debug vs game `numstat 145 171`，归一化行重合 0.58（`commonOptions`、preamble 注入、stale 清理、tree 打印四段同构） | **合并到统一工具** → 内核 `src/scripts/lib/dist-pack.mjs` + 各工程薄入口 | ①重复度级别 B；②变更耦合最强：`globalThis.__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` / `__VBSP_TEXTURES_MTZ_B64__` / `__VBSP_WASM_URL__` 是**跨工程构建契约**，现由 3 份实现各自拼装，改一个名字要改 3 处，写错只在运行时暴露 | **整份上提为单一构建器 → 构建可行性否决**：实测 `require.resolve('esbuild', {paths:['src/scripts/lib']})` → `MODULE_NOT_FOUND`（仓库根无 `package.json`、无 `node_modules`；而 `apps/debug/scripts/` 能解析到 `apps/debug/node_modules/esbuild`）。故共享内核**不得 import esbuild**，必须由工程侧注入 `build` 函数。整份上提必然失败 |
| D-05 | `apps/debug/play.cmd`、`apps/game/play.cmd` | **级别 A 形状**：`numstat 3 5`（命中数值阈值） | **保留**（不上提） | ①R-18 边界 1：入口编排不是实现载体；②差异恰好是每工程参数（工程名横幅、端口、目标页 `dist/index.html`）；③t2 §2.2 定义其为「三件套入口」、§2.5 给出逐字模板，落点由 t2 定稿（t2 §1.3） | 上提为共享脚本 + 3 行转发 → ①双击入口的自我描述性消失（打开 `apps/game/play.cmd` 只见一行 `call`，排查时无法就地读出端口与目标页）；②与 t2 §2.5 的模板落点冲突；③工程参数仍需以参数传入，参数解析比 5 行差异更脆弱。**统一手段是模板，不是共享文件** |
| D-06 | `apps/debug/src/physics/` 的 **5 文件**：`math/vec3.ts`、`param-defs.ts`、`physics-params.ts`、`prediction-params.ts`、`physics/Collision/Collision.types.ts`（该子树原有的 `LICENSE`/`NOTICE` 已从本条**剥离**并改判**上提** → 见 D-23） | 副本数 1（消费方仅 debug） | **保留**（5 文件） | ①`param-defs.ts`/`physics-params.ts` 是 debug 物理面板特性；②`math/vec3.ts`、`Collision.types.ts` 是 **vendored Apache-2.0 上游代码**，头部带 `@license`（`apps/debug/src/physics/math/vec3.ts:2-7`） | 上提 → ①与 `src/vendor/vmdl/` 已确立的「vendored 代码集中 `src/vendor/`」范式冲突；②`param-defs.ts` 默认值须与 Rust `PhysParams::default` 对齐，上提后 debug 面板改动变成共享层改动。**注**：本条「保留」**不含**许可证——`LICENSE`/`NOTICE` 的唯一源已由 captain 裁定上提到 `src/phys/`（D-23 / E-08），故清单由 7 文件收窄为 5 文件。**升级触发**：若第二工程需要这里的 vendored 源码/面板模型，改判为 `src/vendor/cs-movement/` + `src/ts-shared/phys/panel-params.ts` |
| D-07 | `Vec3`：`apps/debug/src/physics/math/vec3.ts:11`（vendored）、`apps/game/src/world/types.ts:28,34`（`Vec3Like` + 别名） | 2 处定义（**级别 C**） | **保留** | ①TS 结构化类型下两份 `{x;y;z}` **互相赋值合法**，无编译期耦合（判据：两工程 `npm run typecheck` 均 exit 0）；②debug 那份属 vendored 上游（见 D-06） | 上提单一 `Vec3` → ①需改写 debug 侧 8 处 import（`pvs-manager`、`spawn-loader`、`teleport-manager`、`collider-adapter`、`game-state` 等）；②收益仅 3 行类型定义；③破坏 vendored 边界。【更正】t1 §4.2 记 `Vec3` 有 3 处定义（含 `apps/debug/src/world/types.ts`）；实测该文件不含 `Vec3` 字样（`Select-String 'Vec3' apps/debug/src/world/types.ts` 零命中），是从 `../physics/math/vec3.js` 导入 → 实为 **2 处** |
| D-08 | `bspYawToCsYaw` 4 处：`src/ts-shared/phys/world-builder.ts:99`（私有）、`apps/debug/src/world/spawn-loader.ts:65`、`apps/debug/src/world/teleport-manager.ts:42`、`apps/viewer/src/core/pose.ts:23`（经 `wrapDeg`） | 4 处实现，**已出现行为分叉** | **上提**（导出单点） → `src/ts-shared/phys/angles.ts` | ①重复度：4 处；②变更耦合：四处注释互相声明「同口径」，靠人工维持；③**实测分叉**：viewer 的 `wrapDeg` 带 `\|\| 0`（把 `-0` 归一为 `0`），debug 两处不带；④跨工程契约：同一地图出生朝向在 viewer 与 debug/game 必须同值 | 保留 4 处 + 注释声明 → ①已实测到 `-0` 差异，证明「注释声明」不是门禁；②该转换是 BSP 实体 yaw → cs-movement yaw 的跨工程契约，4 处任一被「修正」都会静默改变另一工程语义 |
| D-09 | base64 → `Uint8Array` 解码 **8 处 / 4 处落点**——三工程 6 处：`apps/viewer/src/core/bsp.ts:46`、`apps/game/src/renderer/renderer-main.ts:518`、`apps/game/src/world/pvs-manager.ts:273`、`apps/debug/src/main-wasm.ts:30`、`apps/debug/src/default-pack.ts:26`、`apps/debug/src/world/pvs-manager.ts:273`；**共享层 2 处**：`src/ts-shared/auth/worker-dispatch.ts:164`、`src/ts-shared/phys/world-builder.ts:196` | **全仓 TS 侧重复度最高的候选**：8 处 / 4 处落点（三工程 + 共享层） | **上提** → `src/ts-shared/wasm/loader.ts` | ①重复度（8 处同算法；原判 6 处**漏计共享层 2 处**，见 §9.2 更正 7）；②依赖方向：全部只依赖 `atob`/`fetch`/`globalThis`，零工程内部依赖；③变更耦合：配套的「内嵌 or fetch」判定分支写法三工程不同（`if (embedded)` / `if (typeof g.x==='string' && g.x.length>0)`）→ 空串/非字符串注入的容错行为不一致；④是 D-10 的前置（上提后的 `pvs-manager` 必须选一处解码实现） | 不上提、各工程自带 3 行 → ①8 处同算法 + 3 种判定写法属「变更必然同步」；②`globalThis.__VBSP_WASM_B64__` 是构建期写入的全局契约，判定口径不一致会让 single 模式在某些工程静默退回 fetch（file:// 下失败的正是这条路径）。**硬约束**：共享模块**不得 import 任何工程的 `pkg/*`**（三工程 pkg 名不同：`websurf_wasm` / `websurf_viewer_wasm` / `websurf_test_wasm`）→ 只共享「取字节」，`initSync`/`init` 留在工程内。**收敛目标：全仓恰好剩 1 处 `atob`**（= `src/ts-shared/wasm/loader.ts` 自身），判据见 §7.7。反向否决「连 initSync 一起上提」：需在共享层编码三套 pkg 名，违反依赖方向 |
| D-10 | `apps/debug/src/world/pvs-manager.ts` vs `apps/game/src/world/pvs-manager.ts`（均 281 行）+ 依赖的 `WasmPvsNode`/`WasmPvsLeaf`/`WasmPvsData` | **级别 A**：`numstat 2 2`（仅 2 行 import 差） | **上提** → `src/ts-shared/world/pvs-manager.ts` + `src/ts-shared/world/types.ts` | ①R-18 数值阈值直接命中；②t1 §4.2 判定「必须上提」；③算法 101 行 × 2 份，差异是**类型来源**而非算法：debug 从 `../physics/math/vec3.js` 取 `Vec3`，game 从 `./types.js` 同取；④变更耦合：PVS 位图读取/缺面类修复必须双改；⑤PVS 类型本身也重复声明（`apps/debug/src/world/types.ts:141` 与 `apps/game/src/world/types.ts:5`，字段名/类型/顺序全等，仅注释多寡不同） | 保留两份 → ①R-18 命题直接不成立；②保留等于承认「同一算法复制两份」，与 [AGENTS.md](../AGENTS.md) §2「禁止在工程内复制共享实现」冲突。（**注意**：本条与 D-07 不矛盾——上提的是**算法**，`Vec3` 这类结构类型留在各工程合法，共享实现只声明结构等价类型） |
| D-11 | `apps/debug/web/textures.mtz`、`apps/game/web/textures.mtz`、`src/materials/textures.mtz` | **字节全等 ×3**（各 5,942,995 B，SHA256 前 16 位 `A87F36F591CB…`） | **保留副本 + 新增门禁** | ①`web/` 是 dev 页面的服务目录，运行期 `fetch('./textures.mtz')` 必需（`apps/debug/src/default-pack.ts:10`）；②仓库根 `.gitignore` 有显式设计声明：「`**/web/textures.mtz` 不在此列——该文件是公共默认纹理包的副本（跟踪，服务运行必需）」；③`documents/materials.md` 记为「三处同步副本」 | 改为构建期拷贝 + 取消跟踪 → ①fresh clone 后不构建就跑 `npm run dev` 直接 404，破坏「克隆即可运行」；②与 `.gitignore` 的显式声明冲突；③该文件来自共享层数据，无法由 `build:ts` 再生，取消跟踪等于新增一个必须记住的预构建步骤。**但一致性门禁缺失**（目前只靠文档记载）→ 由 T-05 补。【补充】t1 §4.3 的「同字节被追踪重复」表只列了 2 对，未列本条三处副本，属 §4.3 覆盖缺口 |
| D-12 | `src/scripts/check-doc-drift.mjs:48` 的 `SHARED_EXTRA` 候选目录表 | 工具约束（非重复） | **保留**（不改） | 本方案新增 `src/ts-shared/wasm/`、`src/ts-shared/world/`、`src/scripts/lib/` 三个目录，而 `SHARED_EXTRA` 当前只列 `''`、`src`、`phys`、`wasm-core/src`、`ts-shared/{auth,phys,input,tick,decoupled}`、`vendor/vmdl/src` | 不动它即可工作：本文件的所有锚点写**仓库根相对全路径**，命中 `live.includes(clean)` 分支（脚本第 61 行），不依赖 `SHARED_EXTRA`。**但**后续文档若改用裸文件名引用新目录内文件，必须把新目录加入该表，否则会被解析到别处或计入 D（歧义）——列入 §7.6 风险清单 |
| D-13 | `apps/viewer/scripts/build-dist.mjs` 内嵌 `SERVE_PY`（60 行文本）与 `src/serve.py`（64 行） | 同源两份，**合理分叉** | **保留双份（豁免 E-05）** | ①dist 必须自包含（交付形态 = 可打包给他人）；②实测差异合理：`src/serve.py` 设 COOP/COEP（`src/serve.py:33-34`）而 viewer 内嵌版不设（`git grep -n "SharedArrayBuffer" -- apps/viewer` 零命中，无 SAB 需求）；脚本默认端口 8090 vs 8080（指两份 serve 脚本各自的**默认参数**，非工程入口端口；入口端口由 [t2 §2.3](framework-launch-structure.md) 定稿）；Demo 深链打印 viewer 专属 | 上提单份 + 构建期内嵌 → 需把 3 处 viewer 专属差异参数化，侵入 `src/serve.py`——它是 debug/game/harness 的 dev 服务依赖；若 COOP/COEP 因参数化改错，debug/game 会静默从 SAB 回退到 `MsgState`（表现为性能下降而非报错，极难发现）。收益 60 行 < 回归风险。**升级触发**：先给 `src/serve.py` 加 `--no-coop` / `--demo` / 默认端口参数并在 harness 验证 SAB 仍生效，再改 builder 内嵌 |
| D-14 | `apps/debug/src/input/input-bridge.ts` vs `apps/game/src/input/input-bridge.ts` | **级别 C**：`numstat 53 71`，归一化行重合 0.13 | **保留**（建议改名，落点由 t2 定） | ①职责正交：debug 版是「主线程 → Worker 控制消息 + world 下发」，game 版是「面板 ↔ 双端参数同步 + 立即生效语义」；②game 版依赖工程内类型 `RendererMain`（`apps/game/src/input/input-bridge.ts:14`） | 合并为共享 `InputBridge` → 会把「控制消息派发」与「参数双端同步」两套生命周期合成一个类，并让共享层依赖渲染器类型。**建议**（非本文件裁决）：改名消歧（debug → `worker-bridge.ts`；game → `panel-sync.ts`），命名与落点由 t2 §3 定稿 |
| D-15 | `apps/{debug,game,viewer}/tsconfig.json` | game vs viewer `numstat 2 2`（**形状命中阈值**） | **保留** | ①R-18 边界 1：编译器配置不是实现载体；②`include`/`paths`/`types` 是「本工程源码树的声明」，差异是工程结构的函数（viewer 有 `test/**/*.ts`、debug 有 `paths` 别名、game 有 `types: []`）；③TS 的 `include`/`exclude` 基准是 tsconfig 自身目录，`extends` 只能共享 `compilerOptions` | 上提 `src/ts-shared/tsconfig.base.json` + `extends` → ①共享收益 ≈ 8 行 `compilerOptions`；②成本 = 三工程 typecheck 的隐式耦合（改一处同时影响三工程）；③配置混入「共享源码」目录；④与 t2 §3.4 的既有条文冲突。**本条是「阈值命中但语义不命中」的判别示范**：数值阈值必须叠加「是否为同一算法的实现」这一语义前提 |
| D-16 | `EYE_STAND = 64.09`：Rust 权威 1 处（`src/phys/player.rs:34`）+ **TS 侧 7 处引用位点**——`apps/viewer/src/core/constants.ts:7`、`apps/game/src/renderer/renderer-main.ts:647`、`src/ts-shared/decoupled/decoupled-loop.ts:164`、`src/ts-shared/tick/tick-consumer.ts:182`、`src/ts-shared/auth/shared-state.protocol.test.ts:100`（夹具值）、`src/ts-shared/auth/shared-state.protocol.test.ts:139`（**精确断言** `dstF[8] === 64.09`）、`apps/game/scripts/phys-smoke.mjs:122`（**±0.5 容差断言** `Math.abs(eStand.eyeHeight - 64.09) > 0.5`） | **8 处计数**（1 Rust 定义 + 7 TS 引用）；其中**共享层内部 3 处**；原判 6 处**漏计** `:139` 与 `phys-smoke.mjs`，见 §9.2 更正 8 | **TS 侧上提单点** → `src/ts-shared/phys/constants.ts`；Rust 侧不动 | ①R-18 边界 3：是会变更的**标定常量**；②变更耦合最强：渲染眼高必须等于物理眼高，否则渲染位置整体偏移；③当前 Rust 侧改动无任何检查会失败 | 保持字面量散落 → Rust `EYE_STAND` 改动后 TS 侧 7 处引用静默分叉（其中 **2 处是断言**：`src/ts-shared/auth/shared-state.protocol.test.ts:139` 精确相等、`apps/game/scripts/phys-smoke.mjs:122` ±0.5 容差——断言会「按旧值失败」而不提示常量已变）。**同口径漏项已复核**：`64.09` 字面量在 `apps/` 与 `src/`（排除 `node_modules`）已全树扫描，除上列 8 处外**无其他命中**；`shared-state.protocol.test.ts:237,238,281,282,309` 的 `eyeHeight: 64` 是夹具占位值（**非**标定值）不计入，viewer `fly.ts:176,195`、`pose.ts:34` 是**符号级消费**（import 常量）而非字面量复制，同样不计入。**禁止**为「消除重复」把 Rust 常量改成 TS 可注入参数（会改变物理层语义与 wasm 导出面）。跨语言一致性由 T-05 子检查 `eye-stand` 保证 |
| D-17 | `apps/debug/src/world/types.ts`（231 行）vs `apps/game/src/world/types.ts`（34 行） | **级别 C**：`numstat 6 203` | **保留**（除 D-10 的 PVS 三类） | ①真实差异：debug 有 `WasmTriMesh`/`WasmBrush`/`WasmSpawnReport`/`WasmTeleport*`/`WasmBspMetadata`/`ColliderFilter`，game 只余 PVS 类型；②新管线的世界契约已由 `src/ts-shared/phys/world-builder.ts` 承载（`BspProcessorLike`/`WorldMetadata`/`WorldBundle`） | 把 `types.ts` 整体上提为共享「WASM JSON 契约」→ 与 `world-builder.ts` 已消费的契约形成**两套并存契约类型**（正是 D-18/§8.3 要避免的形状） |
| D-18 | `apps/debug/src/wasm.d.ts`（5622 B 手写桩）vs `apps/game/src/wasm.d.ts`（230 B）、`apps/viewer/src/wasm.d.ts`（244 B）、`test/dual-mode-harness/src/wasm.d.ts` | R-21 明示例外 | **保留 4 份**（豁免 E-01） | ①R-21 直接列为不可合并重复；②三工程 pkg 模块名与导出集不同，单份必须按工程分支；③game/viewer 的形态是 `export * from '../pkg/*.js'`（复用 wasm-bindgen 生成类型），debug 是手写契约桩，**目的不同**不构成重复实现 | 上提单份 → 必然在共享层里编码三套 pkg 名与导出集，违反依赖方向；且 t2 §8.3 已禁止删除 debug 的桩。是否把 debug 改为 re-export 属 t2 §3.4 范畴，本文件只登记「不得以解耦为名删除 debug 的手写桩」 |
| D-19 | `apps/debug/.gitignore`（498 B）、`apps/game/.gitignore`（574 B）、`apps/viewer/.gitignore`（266 B） | 各自不同 | **保留** | 每工程忽略集不同（viewer 额外 `/temp/`；debug 涉及 `fixtures/` 例外的路径上下文） | 上提为单一根 `.gitignore` → 让「工程级例外」与「仓库级产物规则」混在一处，且根 `.gitignore` 已声明「各工程另有自身 `.gitignore` 补充特有排除」 |
| D-20 | 三份 `package-lock.json`（17670 / 17808 / 17728 B） | 各自不同 | **保留** | ①各工程独立依赖闭包（viewer 独有 `ws`，debug 独有 `@types/node` 用法）；②CI 用 `cache-dependency-path: '**/package-lock.json'`（`.github/workflows/deploy-pages.yml:58`）已依赖四份独立锁 | 合并为根 lock → 要求重构为 npm workspace（新增根级 `package.json`），属架构级决策；与 t2 §8.3「不为统一而新增根级 `package.json`」同一口径 |
| D-21 | `apps/debug/scripts/pages-index.html`（1842 B）、`apps/debug/fixtures/path/tick-on-render-prefix.json`（784 KB） | 单份 | **保留** | ①`pages-index.html` 的消费方是 **CI**（`.github/workflows/deploy-pages.yml:187` 拷为 `deploy/index.html`），不是工程内代码；②`fixtures/` 是 `test:path-acceptance` 的**故意失败**基线，根 `.gitignore` 有显式例外 `!apps/debug/fixtures/path/` | 上提 → ①CI 路径需同步改动，收益 1.8 KB；②`fixtures/` 上提到 `test/` 会破坏 `.gitignore` 例外路径与 [AGENTS.md](../AGENTS.md) §2 的既定归属「自动化夹具 → `apps/debug/fixtures/<主题>/`」。与 t2 §8.2/§8.3 一致 |
| D-22 | `test/dual-mode-harness/scripts/*.mjs`（12 个） | — | **保留**（本轮） | 验证工程不参与部署（`.github/workflows/deploy-pages.yml` 头注）；其 `check-wasm-api.mjs` 与 `build-dist.mjs` 是 D-03/D-04 的**受益方** | 本轮不改造：`test/` 不在本任务 inScope。登记为共享工具上线后的第二轮接入对象（§6.2 T-03/T-04 的「可选消费方」） |

### 3.3 上提项执行清单（真实路径）

| # | 新增（真实落点） | 删除 / 改写的工程内文件 | 同步动作 |
|---|---|---|---|
| D-01 | `src/scripts/ensure-node-deps.cmd` | 删 `apps/debug/scripts/ensure-node-deps.cmd`、`apps/game/scripts/ensure-node-deps.cmd` | 改 5 处调用点 + viewer 2 处内联判断（§6.2 T-01） |
| D-02 | `src/scripts/install-wasm-bindgen.cmd` | 删 `apps/debug/scripts/install-wasm-bindgen.cmd` | 改 `apps/debug/build-dist.cmd:27`、`apps/debug/start-dev.cmd:26` 调用与 `:85`、`:79` 两处提示文案；改 `src/scripts/cargo-env.cmd:24` 注释 |
| D-03 | `src/scripts/lib/wasm-api-contract.mjs` | 三份 `scripts/check-wasm-api.mjs` 收敛为薄配置（viewer 新建） | `package.json` 的 `check:api` 保持指向工程内薄配置（路径不变，CI 无需改） |
| D-04 | `src/scripts/lib/dist-pack.mjs` | 三份 `apps/<app>/scripts/build-dist.mjs` 收敛为薄入口 | 与 t2 §10.1 第 10/11/12 条合并执行（§7.5 排序约束） |
| D-08 | `src/ts-shared/phys/angles.ts` | `bspYawToCsYaw` 三处副本；`src/ts-shared/phys/world-builder.ts:99` 改为 import | viewer `apps/viewer/src/core/pose.ts` 保留 re-export 以不动其余 20 余处内部 import |
| D-09 | `src/ts-shared/wasm/loader.ts` | **8 处**内联解码——三工程 6 处（`apps/viewer/src/core/bsp.ts`、`apps/game/src/renderer/renderer-main.ts`、`apps/game/src/world/pvs-manager.ts`、`apps/debug/src/main-wasm.ts`、`apps/debug/src/default-pack.ts`、`apps/debug/src/world/pvs-manager.ts`）+ 共享层 2 处（`src/ts-shared/auth/worker-dispatch.ts`、`src/ts-shared/phys/world-builder.ts`） | 各工程 `wasm` 初始化分支改为「共享 loader 取字节 + 本工程 `initSync`」；收敛后全仓仅 loader 自身保留 1 处 `atob` |
| D-10 | `src/ts-shared/world/pvs-manager.ts`、`src/ts-shared/world/types.ts` | 删两份 `apps/<app>/src/world/pvs-manager.ts` | `apps/debug/src/world/types.ts:141` 与 `apps/game/src/world/types.ts:5` 的 PVS 三类改 `export type { … } from` re-export |
| D-16 | `src/ts-shared/phys/constants.ts` | TS 侧 **7 处**引用（含 1 处精确断言 `shared-state.protocol.test.ts:139` + 1 处 ±0.5 容差断言 `apps/game/scripts/phys-smoke.mjs:122`） | Rust `src/phys/player.rs:34` 不动 |
| D-23 | `src/phys/LICENSE`、`src/phys/NOTICE`（cs-movement 许可**唯一源**） | 删 `apps/debug/src/physics/LICENSE`、`apps/debug/src/physics/NOTICE`（禁止保留第二份**源副本**） | **待执行**：①`apps/debug/scripts/build-dist.mjs:136-137`、`:191-192` 的源路径改指 `src/phys/`；②`apps/game/scripts/build-dist.mjs` 补同款拷贝（single + multi，承接 t2 §10.1 第 12 条）；③改 `apps/debug/src/physics/math/vec3.ts:7` 与 `apps/debug/src/physics/physics/Collision/Collision.types.ts:7` 的 NOTICE 指针为 `src/phys/NOTICE`；④viewer **不加**（其 wasm 无 `websurf-phys`）。批次：**批 3**（与 T-04 同批，因同改三份 `build-dist.mjs`） |
| T-05 | `src/scripts/check-shared-sync.mjs` | — | 接入 CI（t2 §6.2 收敛时一并加步骤） |

### 3.4 保留项与例外（汇总）

- 保留（不上提）：D-05、D-06、D-07、D-12、D-14、D-15、D-17、D-19、D-20、D-21、D-22。
- 保留 + 门禁：D-11。
- 保留双份（豁免）：D-13 / E-05、D-18 / E-01。
- 完整例外表见 §8.2。

## 4. viewer 解耦专项（闭合 R-20）

### 4.1 现状（实测）

| 事实 | 数值 / 证据 |
|---|---|
| viewer 引用共享层的文件数（口径 1：含 `import … from '…ts-shared/…'` 语句） | **0** |
| viewer 的 `tsconfig.json` 是否 include 共享层 | **否**（`["src/**/*.ts","src/wasm.d.ts","test/**/*.ts"]`），与其零引用**自洽** |
| viewer 的 WASM 依赖 | 仅 `websurf-wasm-core`（`apps/viewer/crates/wasm/Cargo.toml:19`），**无 `websurf-phys`** |
| viewer 是否使用 SAB / `SharedState` | **否**（`git grep -n "SharedArrayBuffer" -- apps/viewer` 与 `-n "SharedState"` 均零命中） |
| viewer 是否使用 `web/textures.mtz` | **否**（`git ls-files apps/viewer/web` 无该文件；t2 §8.2 已豁免） |
| viewer 与共享层唯一的实质重叠 | `bspYawToCsYaw` 第 4 份副本（D-08）与 `EYE_STAND` 字面量（D-16） |

### 4.2 判据：什么算「欠债」

【必须】viewer 的某模块算「欠债」当且仅当**至少满足一条**：

1. 该模块在 viewer 内存在**与共享层同算法的实现**（重复度级别 A/B）；或
2. 该模块承载**跨工程契约**（同一实体在 viewer 与 debug/game 必须同值/同构）；或
3. viewer 缺失它会导致**运行期或构建期的静默不一致**（而非功能缺失）。

不满足任一条即为「正当隔离」——**不得因为「共享层里有这个模块」就要求 viewer 接入**。

### 4.3 逐模块裁决

| 共享层模块 | 对 viewer 是否有意义 | 裁决 | 依据 |
|---|---|---|---|
| `input/`（`input-layer`、`mouse-buffer`、`pointer-lock`） | 无 | **正当隔离** | viewer 是自由飞行相机（`apps/viewer/src/core/fly.ts` 的 `FlyCam`），无「玩家移动输入折算」语义；`layerMouseDelta`/`qeEquivalentDx` 服务的是 CS 移动物理的灵敏度折算，viewer 用 `MOUSE_SENS` 直接乘角度 |
| `auth/`（`shared-state`、`auth-loop`、`worker-dispatch`、`tick-authority`、`compute-mode`） | 无 | **正当隔离** | `auth/*` 是「Worker 权威帧 + SAB 域布局」协议；viewer 无物理权威帧、无 SAB（§4.1），且其 Worker 只做录像解析（`apps/viewer/src/worker/main.ts`） |
| `tick/`（`ordering-gate`、`tick-consumer`） | 无 | **正当隔离** | 面向「权威帧到达顺序」与「渲染帧插值」；viewer 的回放时间轴是**离线数据**（`apps/viewer/src/replay/timeline.ts`），不存在乱序压力 |
| `decoupled/decoupled-loop.ts` | 无 | **正当隔离** | 解耦物理自驱循环，需注入 `PhysWorld`；viewer 无物理 |
| `phys/params.ts`、`phys/authority-calibrator.ts` | 无 | **正当隔离** | 参数映射与权威校准均以 PhysWorld 为前提 |
| `phys/world-builder.ts`（`buildWorldBundle`） | **部分有** | **保留现状**（不强制接入） | 它与 viewer 的 `apps/viewer/src/core/bsp.ts` 做同一段「metadata → spawn → GLB」消费序列，但 viewer 的版本只取 `glb + spawn + primary`（111 行），而 `buildWorldBundle` 面向「碰撞体三档 + 定义表 + 缺材质比对」（261 行），需要 viewer 不使用的 `colliderSource` 语义。判定：**不属于欠债**（不是同算法重复，是同一 WASM 导出面的两个不同消费面）；若未来 viewer 需要缺材质比对，再接入 |
| `phys/angles.ts`（**待新增**，D-08） | **有** | **必须接入** | `bspYawToCsYaw` 是跨工程契约（同一地图出生朝向），viewer 现有第 4 份副本已出现 `-0` 行为分叉 |
| `phys/constants.ts`（**待新增**，D-16） | **有** | **必须接入** | `EYE_STAND` 是物理标定常量，viewer 的 `apps/viewer/src/core/constants.ts:7` 拷贝必须与 Rust 权威同值 |
| `wasm/loader.ts`（**待新增**，D-09） | **有** | **必须接入** | viewer 有 1 处内联解码（`apps/viewer/src/core/bsp.ts:46`），属 8 处重复之一（三工程 6 + 共享层 2，见 D-09） |
| `world/pvs-manager.ts`（**待新增**，D-10） | 无 | **正当隔离** | viewer 不做 PVS 剔除（无 SAB/无物理，场景是静态 GLB） |

### 4.4 R-20 的闭合结论

**【必须】** R-20 的裁判定为：**viewer = 正当隔离**（不是欠债）。据此：

1. **现状合规，无需立即改动**：viewer 当前 `tsconfig.json` **不含**共享层 include，与其 0 处 import 自洽（R-09 现状**合规**、R-20 **无标的**）。批 1 落库后 viewer 将出现 3 处 `import … from '…ts-shared/…'`（angles / constants / loader），届时按 [t2 §3.4](framework-launch-structure.md) 的「当且仅当」条文，viewer **必须**把 `../../src/ts-shared/**/*.ts` 加入 `include`；判据：`git grep -lE "from .*ts-shared" -- apps/viewer/src` 非空。本条判定权在 t2 §3.4，本文件只要求「声明必须与实测 import 一致」。
2. viewer **不接入** `input/`、`auth/`、`tick/`、`decoupled/`、`phys/params`、`phys/authority-calibrator`、`world/pvs-manager`（§4.3）。
3. viewer 的正当隔离**必须**在文档中显式声明（本条即声明），避免后续执行者按「共享层有的都接」批量接入。

## 5. src/ 目标结构

### 5.1 目标目录树（新增项标注来源裁决号）

```text
src/
├─ Cargo.toml                     # 既有：根 workspace（websurf-phys）
├─ lib.rs                         # 既有
├─ .gitignore                     # 既有
├─ phys/                          # 既有：Rust 物理（mod.rs / world.rs / player.rs / teleport.rs / seed.rs）
├─ wasm-core/                     # 既有：BSP 解析与 GLB/纹理导出（websurf-wasm-core）
├─ materials/textures.mtz         # 既有：默认纹理包**单源**
├─ vendor/vmdl/                   # 既有：vendored 单副本（含 LICENSE）
├─ serve.py                       # 既有：dev 静态服务器（COOP/COEP）
├─ scripts/                       # 既有：共享构建/校验工具（Node/批处理，**不进产物**）
│  ├─ cargo-env.cmd               # 既有
│  ├─ check-doc-drift.mjs         # 既有
│  ├─ ensure-node-deps.cmd        # 新增（D-01）
│  ├─ install-wasm-bindgen.cmd    # 新增（D-02）
│  ├─ check-shared-sync.mjs       # 新增（T-05）
│  └─ lib/                        # 新增目录（D-03/D-04）
│     ├─ wasm-api-contract.mjs    # 新增（D-03）
│     └─ dist-pack.mjs            # 新增（D-04）
└─ ts-shared/                     # 既有：被编译进产物的 TS 共享源码
   ├─ auth/                       # 既有（8 文件）
   ├─ decoupled/                  # 既有（decoupled-loop.ts）
   ├─ input/                      # 既有（3 文件）
   ├─ tick/                       # 既有（3 文件）
   ├─ phys/                       # 既有 + 新增 2
   │  ├─ authority-calibrator.ts  # 既有
   │  ├─ params.ts                # 既有
   │  ├─ world-builder.ts         # 既有
   │  ├─ angles.ts                # 新增（D-08）
   │  └─ constants.ts             # 新增（D-16）
   ├─ wasm/                       # 新增目录（D-09）
   │  └─ loader.ts                # 新增（D-09）
   └─ world/                      # 新增目录（D-10）
      ├─ types.ts                 # 新增（D-10）
      └─ pvs-manager.ts           # 新增（D-10）
```

### 5.2 与既有目录的职责边界

| 目录 | 职责 | 与新增项的分界判据 |
|---|---|---|
| `src/phys/`（Rust） | 物理计算本体（`websurf-phys`） | 与 `src/ts-shared/phys/` 是**同名不同语言**：TS 侧只做参数映射、权威校准、角度/常量，物理积分仍在 Rust。**禁止**新增 `src/ts-shared/physics/`（第三种拼写） |
| `src/wasm-core/`（Rust） | BSP 解析、GLB/纹理导出 | 与 `src/ts-shared/wasm/loader.ts` 的分界：loader **只做浏览器侧字节获取**（base64/URL），**不 import 任何 `pkg/*`**、不做解析 |
| `src/materials/` | 数据**单源** | 与工程内 `web/textures.mtz` 的分界：单源在 `src/`，运行副本在工程 `web/`，一致性由 T-05 校验（D-11） |
| `src/vendor/` | 第三方 vendored 代码 | **禁止**把 vendored 上游代码放进 `src/ts-shared/`（D-06/D-07）；未来上提 cs-movement 的**源码**时落 `src/vendor/cs-movement/`。**注意**：cs-movement 的**许可证**不落此处，而是 `src/phys/`（与它所约束的 Apache-2.0 Rust 移植同址，属自有 `src/phys` 实现的许可，见 D-23） |
| `src/scripts/` | 可执行工具（`.cmd`/`.mjs`），**不参与打包** | 与 `src/ts-shared/` 的**唯一分界判据**：该文件是否会被 esbuild 打包进 `dist/`。会 → `ts-shared/`；不会 → `src/scripts/` |

### 5.3 「`src/decoupled/` 与 `src/ts-shared/decoupled/` 命名混淆」的裁决

**【更正】前提不成立**：仓库中**不存在** `src/decoupled/`（`Test-Path src/decoupled` → `False`；`src/` 顶层实测只有 `materials/`、`phys/`、`scripts/`、`ts-shared/`、`vendor/`、`wasm-core/` 六个子目录）。全仓唯一名为 `decoupled` 的目录是 `src/ts-shared/decoupled/`（内含 `decoupled-loop.ts`）。

因此不存在**当前**混淆。但存在**前瞻性**混淆风险：[AGENTS.md](../AGENTS.md) §2 的决策表要求「三个工程共用或应共用的逻辑 → 上提到 `src/ts-shared/`」，若执行者按「领域名」而非按「是否共享」建目录，就可能新建 `src/decoupled/`。裁决：

- **【禁止】**在 `src/` 顶层新建 `decoupled/`、`auth/`、`input/`、`tick/`、`phys/`（TS 侧）这类与 `src/ts-shared/` 子目录同名的目录——会造成两个同名目录，且 `src/` 顶层已有 Rust 的 `phys/`。
- **【必须】**TS 共享源码的落点只有一处：`src/ts-shared/<域>/`。领域名与既有五域（`auth`/`decoupled`/`input`/`phys`/`tick`）一致时并入既有目录，不一致时新建 `src/ts-shared/<域>/`。

### 5.4 落点规则（三条）

1. **【必须】**被 esbuild 打包进产物的 TS → `src/ts-shared/<域>/`；Node/批处理工具 → `src/scripts/`（判据见 §5.2）。
2. **【必须】**共享层文件**不得 import `apps/` 下任何路径**（含 `pkg/*`）；需要工程侧信息时以**参数/回调**注入（D-03/D-04/D-09 均据此设计）。
3. **【必须】**新增 `src/` 子目录时同步评估 `src/scripts/check-doc-drift.mjs:48` 的 `SHARED_EXTRA`（D-12）。

## 6. 共享构建与校验工具提案

### 6.1 提案总表

| # | 文件（真实落点） | 类型 | 被谁调用 | 批次 |
|---|---|---|---|---|
| T-01 | `src/scripts/ensure-node-deps.cmd` | 上提（D-01） | 4 个 `.cmd` + viewer 2 处内联点 | 批 2 |
| T-02 | `src/scripts/install-wasm-bindgen.cmd` | 上提（D-02） | `apps/debug/build-dist.cmd`、`apps/debug/start-dev.cmd` | 批 2 |
| T-03 | `src/scripts/lib/wasm-api-contract.mjs` | 新建引擎（D-03） | 三工程 +（可选）harness 的 `scripts/check-wasm-api.mjs` | 批 2 |
| T-04 | `src/scripts/lib/dist-pack.mjs` | 新建内核（D-04） | 三工程 +（可选）harness 的 `scripts/build-dist.mjs` | 批 3 |
| T-05 | `src/scripts/check-shared-sync.mjs` | 新建门禁（D-11/D-16/E-01…） | CI（仓库根直接调用）+ 本地 | 批 3 |

### 6.2 逐项规格

#### T-01 `src/scripts/ensure-node-deps.cmd`

- 职责：检测工程 `node_modules`，缺失时在**工程根**执行 `npm install`；支持 `nopause` 首参。
- **关键约束（原实现依赖文件位置）**：现副本第 4 行是 `cd /d "%~dp0.."`（相对**脚本自身位置**推导工程根），移动后该语义会指向 `src/`。因此改为**调用方契约 + 守卫**：

```bat
REM 【必须】调用方在此之前已 cd /d "%~dp0"（三件套入口第 4 行即如此）
set "APP_ROOT=%CD%"
if not exist "%APP_ROOT%\package.json" (
  echo [ERROR] ensure-node-deps: 当前目录不是工程根 ^(缺 package.json^): %APP_ROOT%
  exit /b 1
)
```

- 依据：③依赖方向（共享脚本不得假设工程位置）；防错：守卫把「在错误目录跑 npm install」从静默错误转为可诊断失败。
- 反向否决（保留副本并就地修）：R-19 直接禁止；且两份未来必然分叉。

#### T-02 `src/scripts/install-wasm-bindgen.cmd`

- 职责：幂等安装 `wasm-bindgen-cli 0.2.128` 预编译包（curl → PowerShell 回退、tar → PowerShell 回退），设置 `WASM_BINDGEN`。
- **关键变化**：原第 19 行 `call "%~dp0..\..\src\scripts\cargo-env.cmd"` 在 `apps/<app>/scripts/` 下少一层（解析为 `apps/src/scripts/…`，`Test-Path` → `False`，即 I-22）。移动后与 `cargo-env.cmd` **同目录**，改为 `call "%~dp0cargo-env.cmd"`，层数问题从根上消失。
- 同步：`src/scripts/cargo-env.cmd:24` 的注释「installed by debug/scripts/install-wasm-bindgen.cmd」改为指向同目录 `install-wasm-bindgen.cmd`。
- 反向否决（就地补 `..`，即 t2 §10.1 第 13 条）：只修症状不改归属——共享 env 文件仍反向引用工程内路径，且第三工程需要时仍要复制（§1.3 C-1）。

#### T-03 `src/scripts/lib/wasm-api-contract.mjs`

- 职责（**纯函数 + 参数**，零工程依赖）：导出三个函数
  1. `extractExportsFromPkgJs(pkgJsPath)` → `Set<string>`（现有 debug 的 6 类导出形态：`function`/`class`/`const`/命名 `export {}`/`as` 别名/`default`）；
  2. `assertDtsExports({ dtsPath, apiNames, extraClasses })` → `{ missing: string[] }`（现有 game/harness 的算法：存在性 → `\bname\s*\(`）；
  3. `assertTsImportsCoveredByExports({ tsRoot, pkgBasename, exports })` → `{ missing: string[] }`（debug 的动态比对）。
- 被谁调用：`apps/<app>/scripts/check-wasm-api.mjs`（薄配置，约 20 行：声明本工程模式与 API 表 → 调用 → 打印并 `process.exit`）。`package.json` 的 `check:api` **路径不变**，因此 **CI 无需改动**。
- 反向否决（把引擎放进 `src/ts-shared/`）：它不被 esbuild 打包（§5.2 判据），且 `src/ts-shared/` 被各工程 `tsconfig.include` 拉入编译范围——`.mjs` 混进去会污染 typecheck 范围。

#### T-04 `src/scripts/lib/dist-pack.mjs`

- 职责（内核，**esbuild 由调用方注入**）：
  1. `commonEsbuildOptions({ logLevel })`（`bundle/target:'es2022'/minify/sourcemap:false/write:false/legalComments:'eof'/define:{'import.meta.url':'about:blank'}`）；
  2. `bundleIife({ build, entry, ...common })` 与 `bundleEsm({ build, entry, outfile })`；
  3. `writeEmbeddedPreamble({ distDir, appFile, wasmB64, workerJs, mtzB64? })`——**唯一**拼装 `globalThis.__VBSP_WASM_B64__` / `__VBSP_WORKER_JS__` / `__VBSP_TEXTURES_MTZ_B64__` 的位置；
  4. `rewriteIndexToClassicScript({ webIndex, distIndex })`；`cleanStale(distDir, names)`；`printTree(dir)`。
- 调用签名示例（工程薄入口）：

```js
import { build } from 'esbuild';                                  // 工程侧解析，不在共享层
import { bundleIife, writeEmbeddedPreamble } from '../../../src/scripts/lib/dist-pack.mjs';
```

- **硬约束**：内核**不得**出现 `import … from 'esbuild'`（实测从 `src/scripts/lib/` 解析 `MODULE_NOT_FOUND`，见 D-04），也不得 import 任何工程路径。
- 边界：viewer 的 `dist/` 附加物（`serve.py`/`play.cmd`/`play.sh`/`README.md`/`.nojekyll`/示例录像）与 single-only 由 `extraAssets` 参数容纳；`--multi` 在 viewer 必须**显式报错退出 1**（t2 §2.2/§10.1 第 10 条）。

#### T-05 `src/scripts/check-shared-sync.mjs`

- 职责：把「**不可合并的重复**」变成可判定门禁，**四项**子检查，任一失败 `exit 1`：

| 子检查 | 断言 | 对应 |
|---|---|---|
| `mtz` | `src/materials/textures.mtz`、`apps/debug/web/textures.mtz`、`apps/game/web/textures.mtz` 三者 sha256 全等；`apps/viewer/web/textures.mtz` **不得存在** | D-11、E-04、t2 §8.2 |
| `vmdl-patch` | 五份 `Cargo.toml`（根 + 三工程 + harness）均含 `[patch.crates-io]` 且 `vmdl` 指向 `src/vendor/vmdl` | E-02、R-21 |
| `eye-stand` | 从 `src/phys/player.rs` 解析 `pub const EYE_STAND`，与 `src/ts-shared/phys/constants.ts` 的 TS 单点数值**逐位相等** | D-16 |
| `license-src` | `src/phys/LICENSE`、`src/phys/NOTICE` 均存在，且全仓 `apps/` 下**不存在**第二份 cs-movement 许可**源**（\`apps/\*\*/{LICENSE,NOTICE}\` 形式的许可源零命中；`dist/` 产物副本不计） | D-23、E-08、R-17 |

- **必须为纯 `fs` 实现（禁止 `child_process`）**：`src/scripts/check-doc-drift.mjs:31` 用 `execFileSync` 起 `git` 子进程，在禁止子进程 spawn 的环境（file sandbox）会 `spawnSync git EPERM`（errno -4048）。本工具改用 `node:fs` 直接读文件与 `node:crypto` 计算摘要，从而**在任何沙箱可跑**——这是它相对 `check-doc-drift.mjs` 的改进点。
- 被谁调用：与 `check-doc-drift.mjs` **同一模式**（根级共享体检，不经任何 `package.json` 注册）：CI 在仓库根 `node src/scripts/check-shared-sync.mjs`；本地手动同命令。
- 反向否决（不做这个门禁）：D-11 / E-01 / E-02 / E-08 / D-16 **五组**重复**因语义原因不可合并**，若同时没有门禁，它们就是「靠文档记载维持的一致性」——t1 §4.4 与 §5.3 已实测到同类漂移（`viewer/tsconfig` 被两处文档误记、`Vec3` 定义数被误记为 3 处）。**门禁是「不可合并重复」的唯一可验收替代品。**
- 反向否决（把**四项**检查分别注册到各工程 `package.json` 的 `test:*`）：`mtz` 与 `eye-stand` 是**跨工程/跨语言**断言，挂在任一工程下都会让其余工程无法独立验证；`vmdl-patch` 覆盖 harness（不属任何应用工程）；`license-src` 覆盖仓库根与三工程（无单一归属工程）。

### 6.3 各工程调用点与相对路径层数

【必须】层数规则以 [t2 §3.3](framework-launch-structure.md) 的对照表为唯一事实来源（本文件不另立）。落到本提案的具体写法：

| 调用方（位置） | 示例真实路径 | 深度 `D` | **必须**写法 |
|---|---|---|---|
| 工程根三件套入口 | `apps/<app>/play.cmd`、`apps/<app>/build-dist.cmd`、`apps/<app>/start-dev.cmd` | `D=2` | `call "%~dp0..\..\src\scripts\ensure-node-deps.cmd" nopause` |
| 工程 `scripts/` 下的校验薄配置 | `apps/<app>/scripts/check-wasm-api.mjs` | `D=3` | `../../../src/scripts/lib/wasm-api-contract.mjs` |
| 工程 `scripts/` 下的构建薄入口 | `apps/<app>/scripts/build-dist.mjs` | `D=3` | `../../../src/scripts/lib/dist-pack.mjs` |
| harness 入口（可选接入） | `test/dual-mode-harness/play.cmd` | `D=2` | `..\..\src\scripts\ensure-node-deps.cmd` |
| harness 脚本（可选接入） | `test/dual-mode-harness/scripts/three-mode-verify.mjs` | `D=3` | `../../../src/scripts/lib/…` |
| CI workflow | `.github/workflows/deploy-pages.yml` | `D=0` | **禁止**手写深度：用 `working-directory` |

- **【禁止】**用绝对路径或 `cd` 跳出工程目录后再引用（t2 §3.3 同款条文）。
- 层数反例（历史 + 本轮实测）：`apps/debug/scripts/install-wasm-bindgen.cmd:19` 少一层 → 解析为 `apps/src/scripts/cargo-env.cmd`（不存在）。本提案通过「共享脚本调用共享脚本写同目录」消除这一类错误面。

### 6.4 不提案的工具（拒绝项）

| 被拒提案 | 拒绝理由 |
|---|---|
| 根级 `package.json` + npm workspace | 会改变安装/锁文件/CI 缓存模型（`.github/workflows/deploy-pages.yml:58` 的 `**/package-lock.json` glob）；收益与 D-20 相同层面的架构决策，不属解耦范围。与 t2 §8.3 同口径 |
| 跨工程共享的**端口配置文件** | t2 §2.3 是端口表的唯一事实来源，t2 §8.3 已明确禁止 |
| 统一的 `serve.py` 单份 | 见 D-13（dist 自包含 + COOP/COEP 回归风险） |
| 统一的三工程 `tsconfig.base.json` | 见 D-15（收益 8 行，成本为三工程 typecheck 隐式耦合） |
| 把 `build-dist.mjs` 整份上提 | 见 D-04（构建可行性硬约束） |

## 7. 迁移顺序与风险

### 7.1 分批总览

| 批次 | 内容 | 行为变化 | 前置条件 | 触发文档漂移体检 |
|---|---|---|---|---|
| 批 1 | D-08、D-09、D-16 的共享单点建立 + 工程侧改 import | **无**（纯代码等价搬迁） | 无 | 是（改到 `world-builder.ts` 等被引用文件） |
| 批 2 | D-01、D-02 脚本上提 + D-03 引擎抽取 + 调用点切换 | 无（但改 6 个 `.cmd`） | 批 1；t2 §10.3 第 2 步（入口/端口）已冻结 | 是（`.cmd` 文案与 `package.json` 被文档引用） |
| 批 3 | D-04 构建内核 + T-05 门禁 + D-10 pvs-manager | 无（产物应逐字节同构） | 批 2；**t2 §10.3 第 3 步已完成** | 是（三份 `build-dist.mjs` 行数变化最大） |

### 7.2 批 1：共享单点建立（零行为变化）

1. 新建 `src/ts-shared/phys/angles.ts`（导出 `wrapDeg`、`bspYawToCsYaw`；`wrapDeg` 语义取 viewer 版，**带 `|| 0`** 以保证 `-0` 归一）；`src/ts-shared/phys/world-builder.ts:99` 改为 import；删除 `apps/debug/src/world/spawn-loader.ts:65`、`apps/debug/src/world/teleport-manager.ts:42` 的私有副本；`apps/viewer/src/core/pose.ts:23` 改为 re-export（保留其余内部 import 不变）。
2. 新建 `src/ts-shared/wasm/loader.ts`（导出 `base64ToBytes(b64)`、`readEmbeddedWasmB64()`、`wasmBytesFrom({ embeddedB64, url })`）；**8 处**解码点改 import（三工程 6 + 共享层 2：`src/ts-shared/auth/worker-dispatch.ts`、`src/ts-shared/phys/world-builder.ts`；清单见 §3.3）——收敛后全仓仅 loader 自身保留 1 处 `atob`。
3. 新建 `src/ts-shared/phys/constants.ts`（导出 `EYE_STAND = 64.09`）；TS 侧 **7 处**改 import（含 2 处断言：`src/ts-shared/auth/shared-state.protocol.test.ts:139`、`apps/game/scripts/phys-smoke.mjs:122`）。
4. 与 t2 §10.3 第 1 步（层数/配置修复）同批或紧邻提交，避免同一批被拆两次回归。

### 7.3 批 2：共享原语上提与调用点切换

见 §6.2 T-01/T-02/T-03 与 §3.3 清单。**风险集中点**：`.cmd` 的调用行与提示文案（改错会让「一键入口」在 fresh clone 上静默走错分支）。

### 7.4 批 3：构建内核与门禁

见 §6.2 T-04/T-05 与 §3.3 清单（含 D-10）。**风险集中点**：注入名（`__VBSP_*`）与产物清单的逐字节回归。

### 7.5 与 framework-launch-structure.md 的执行顺序耦合

- 【必须】批 3 的 T-04 **必须**排在 [t2 §10.3](framework-launch-structure.md) 第 3 步之后，否则 `apps/*/scripts/build-dist.mjs` 会被两轮修改（t2 §10.1 第 10/11/12 条 + 本文件 T-04）。
- 【必须】批 2 的 T-01/T-02 与 t2 §10.1 第 13 条的**同一处文件**（`install-wasm-bindgen.cmd`）只能由本文件的落点结论执行，**不得**先按 t2 就地补 `..` 再移动（会产生一次无谓提交，且中间态共享 env 仍指向工程内）。
- 【必须】批 2 的 T-03 与 t2 §10.1 第 20 条（viewer 补 `check-wasm-api.mjs`）**合并为一次动作**，否则会先造出第 4 份副本再收敛。

### 7.6 会破坏文档锚点 / CI 的动作（逐条）

| 动作 | 受影响对象 | 处置 |
|---|---|---|
| 三份 `build-dist.mjs` 收敛为薄入口（行数显著变化） | `documents/debug/overview.md`、`documents/game/overview.md`、`documents/viewer/overview.md`、`documents/viewer/differences.md`、`documents/debug/implementation/loading-pipeline.md`、`documents/architecture.md`、`documents/materials.md` 中指向 `build-dist.mjs` 的 **`文件:行号` 锚点与行数声明** | 落库后跑 `node src/scripts/check-doc-drift.mjs`（**须在允许子进程的环境**）并按 [AGENTS.md](../AGENTS.md) §5.3 回改 |
| `check-wasm-api.mjs` 收敛为薄配置 | `documents/architecture.md` 明文断言「`check-wasm-api.mjs` 存在于 **debug / game / harness 三处**」 | 该断言在批 2 后**失真**（三处仍在，但实现变为薄配置 + 共享引擎）；`documents/architecture.md` 不在本轮 inScope → 登记为**待办**，交后续任务修改 |
| `install-wasm-bindgen.cmd` 移动 | `documents/*` 中对该路径的引用（若有）、`src/scripts/cargo-env.cmd:24` 注释 | 全仓 `git grep -n "install-wasm-bindgen"` 后逐条改 |
| 新增 `src/ts-shared/{wasm,world}/` 与 `src/scripts/lib/` | `src/scripts/check-doc-drift.mjs:48` 的 `SHARED_EXTRA` 候选表未含这些目录 | 本文件锚点用仓库根相对全路径，不依赖该表（D-12）；**若后续文档改用裸文件名引用新目录内文件**，必须把新目录加入 `SHARED_EXTRA`，否则会被解析到别处或计入「歧义未判」 |
| CI | `working-directory` 机制不受相对路径层数影响；`check:api` 的 `package.json` 路径不变 | 批 2 **无需改 CI**；唯二需要 CI 的动作 = T-05 新增门禁步骤、t2 §6.2 的 CI 收敛 |
| 先例照抄 | [AGENTS.md](../AGENTS.md) §7.1 第 10 项（输入层上提）：当时同步改了 6 处文档 + 1 处 harness 源码 | 批 1/2/3 逐批按同一粒度列「代码 + 文档 + 注释」同步清单 |

### 7.7 批间验证命令与回滚

**批 1 验证**

```bash
cd apps/debug && npm run typecheck && npm run build:ts
cd apps/game && npm run typecheck && npm run build:ts
cd apps/viewer && npm run typecheck && npm run build:ts
git grep -n "bspYawToCsYaw" -- apps          # 期望只剩 re-export / import 行
git grep -n "atob(" -- apps src                  # 期望恰好 1 处（= src/ts-shared/wasm/loader.ts）
```

**批 2 验证**

```bash
# 三工程一键构建（脚本上提 + 调用点切换的端到端回归）
apps/debug/build-dist.cmd ; echo %errorlevel%      # 期望 0
apps/game/build-dist.cmd ; echo %errorlevel%
apps/viewer/build-dist.cmd ; echo %errorlevel%
cd apps/debug && npm run check:api ; cd ../game && npm run check:api ; cd ../viewer && npm run check:api
# %CD% 契约回归：删掉 node_modules 后跑引导分支，必须成功且失败路径可诊断
```

**批 3 验证**

```bash
node src/scripts/check-shared-sync.mjs            # 期望 exit 0（纯 fs，任何沙箱可跑）
cd apps/debug && node scripts/build-dist.mjs && node scripts/build-dist.mjs --multi
# 注入名回归：dist/app.js 首行的 __VBSP_* 前缀与改造前逐字节相同
apps/viewer/build-dist.cmd multi                   # 期望显式 [ERROR] + exit 1
node src/scripts/check-doc-drift.mjs               # 文档体检（须允许子进程）
```

**回滚方式（每批通用）**

1. 每批**独立提交**（Conventional Commits：`refactor(phys|ci|apps): …`），回滚 = `git revert <batch-commit>`；禁止把三批压在同一个提交里。
2. 批 2 的回滚面最大（6 个 `.cmd` + 3 个 `package.json` 可能 + 2 个删除），回滚前先确认 `.cmd` 未被 t2 的其他改造叠加——因此**批 2 必须晚于 t2 §10.3 第 2 步**（§7.5）。
3. 批 3 的回滚验收点 = 「三工程 `dist/` 产物清单与注入名前缀与改造前一致」；若不一致，回滚整批而不是逐文件修补。
4. 任一批落库后**必须**执行对应批的验证命令并保存退出码（[AGENTS.md](../AGENTS.md) §6 的「改后四件套」）。

## 8. 禁止清单（不可上提）

### 8.1 硬禁止（以「解耦」为名的动作）

| # | 【禁止】 | 理由 |
|---|---|---|
| 1 | 合并五份 `Cargo.toml` 的 `[patch.crates-io] vmdl` 声明 | Cargo 语义：`[patch]` 只对声明它的 workspace 生效（E-02 / R-21） |
| 2 | 合并四份模块工程 `Cargo.toml` 与 `Cargo.lock`（含 `apps/{debug,game}/Cargo.toml` 字节全等那一对） | 各工程独立 workspace（target/ 留在本工程内）；且两工程 lock 实测已分叉（54343 vs 54341 B，`wasm-bindgen` 版本号一致但解析结果不同）→ 「文件全等」不代表「可合并」 |
| 3 | 合并四份 `src/wasm.d.ts` | 三工程 pkg 名与导出集不同（E-01 / R-21） |
| 4 | 合并三份 `package.json` / `package-lock.json` / `tsconfig.json` | 见 D-15、D-20；且会要求根级 `package.json` / npm workspace |
| 5 | 上提 `play.cmd` / `start-dev.cmd` / `build-dist.cmd` 三件套入口本体 | D-05；入口统一由 t2 §2.4/§2.5 的模板承担 |
| 6 | 上提 `apps/debug/fixtures/`、`apps/debug/scripts/pages-index.html`、`apps/debug/scripts/path-baseline.md` | D-21；消费方分别是 CI 与「故意失败」验收，路径变更会连带改 CI 与 `.gitignore` 例外 |
| 7 | 上提 `web/index.html`、`web/styles.css`、`web/textures.mtz` | 运行期必需副本；`web/textures.mtz` 已由 `.gitignore` 显式声明为跟踪副本（D-11） |
| 8 | 上提 `apps/debug/src/physics/` 的 vendored 子树与 `param-defs.ts` 面板模型 | D-06（vendored 上游 + 唯一消费方）。**许可证除外**：`LICENSE`/`NOTICE` 的唯一源**按裁定上提** `src/phys/`（D-23 / E-08），不适用本条禁止 |
| 9 | 上提 `apps/viewer/scripts/dist-README.md`、`apps/viewer/test/` | dist 自包含交付物 + 自检源码属工程内验证面（t2 §8.2 已声明） |
| 10 | 在 `src/` 顶层新建 `decoupled/`、`auth/`、`input/`、`tick/`（TS 侧）等与 `src/ts-shared/` 子目录同名的目录 | §5.3（前瞻性命名混淆） |
| 11 | 把 `src/serve.py` 与 viewer 内嵌 `SERVE_PY` 合并为单份 | D-13（COOP/COEP 回归风险） |
| 12 | 为「消除重复」把 Rust `EYE_STAND` 改成 TS 可注入参数 | D-16（会改变物理层语义与 wasm 导出面） |
| 13 | 为解耦新增根级 `package.json` / npm workspace / 共享端口配置文件 | §6.4；（与 t2 §8.3 同口径） |
| 14 | 在共享层里 import `apps/` 下任何路径（含各工程 `pkg/*`） | §5.4 规则 2；D-04/D-09 的设计前提 |

### 8.2 不可合并重复的明示例外表（R-21 闭合）

| # | 例外（不可合并的重复） | 副本数 | 语义级理由 | 门禁 |
|---|---|---|---|---|
| E-01 | 四份 `src/wasm.d.ts` | 4 | pkg 模块名与导出集不同；debug 为手写契约桩、game/viewer 为 `export * from '../pkg/*.js'` | 无（形态差异由 t2 §3.4 约束） |
| E-02 | 五份 `Cargo.toml` 的 `[patch.crates-io] vmdl` | 5 | `[patch]` 只对声明它的 workspace 生效（Cargo 语义） | T-05 `vmdl-patch` |
| E-03 | 四份模块 workspace `Cargo.toml` + 四份 `Cargo.lock` | 4+4 | 独立 workspace / target 目录留在本工程；lock 已实测分叉 | 无（版本锁步由 CI 安装 `wasm-bindgen-cli 0.2.128` 间接约束） |
| E-04 | 三处 `textures.mtz`（`src/materials/` + `apps/{debug,game}/web/`） | 3 | 数据单源 + 运行期必需副本；`.gitignore` 显式声明跟踪 | T-05 `mtz` |
| E-05 | `src/serve.py` 与 viewer 内嵌 `SERVE_PY` | 2 | dist 自包含；COOP/COEP 与默认端口按工程形态分叉 | 文档交叉引用（升级触发见 D-13） |
| E-06 | `EYE_STAND` 的 Rust 权威 + TS 单点 | 2 | 跨语言无法共享符号 | T-05 `eye-stand` |
| E-07 | 三工程 `.gitignore` | 3 | 工程级例外与仓库级规则分层（根 `.gitignore` 已声明该分层） | 无 |
| E-08 | `cs-movement` 许可证：唯一**源** `src/phys/{LICENSE,NOTICE}` + 三工程 `dist/` 内的 `LICENSE.cs-movement`/`NOTICE.cs-movement` | 1 源 + 2 产物 | **许可源**全仓仅一份，落 `src/phys/`（与它所约束的 Apache-2.0 `src/phys` Rust 移植同址）；`dist/` 内的同名文件是**产物级拷贝**（法律要求随产物分发），由构建脚本从唯一源生成、且被 `**/dist/` 忽略不入库。**判据**：①禁止在任一工程内保留第二份许可**源副本**（即不得再出现 `apps/<app>/…/{LICENSE,NOTICE}` 形式的许可源）；②产物级拷贝**合法且必需**——被禁止的是**源码副本**，不是随产物分发 | T-05 `license-src` |

### 8.3 常见过度上提的错误形状（防错）

1. **「共享层里有同名模块就要求接入」**——违反 §4.2 判据；viewer 的七项正当隔离即为反例。
2. **「数值阈值命中就上提」**——`tsconfig.json`（`2 2`）与 `play.cmd`（`3 5`）是反例（§2.3 边界 1、D-15）。
3. **「同名就合并」**——`input-bridge.ts`（D-14）、`types.ts`（D-17）是反例。
4. **「共享层做通用框架」**——把 esbuild 直接 import 进共享层是反例（D-04），共享层必须可被任意调用方**注入**依赖。

## 9. R-18…R-21 落点映射

### 9.1 条款闭合表

| 条款 | 本文件落点 | 闭合结论 |
|---|---|---|
| R-17（dist 必须随附第三方许可证） | D-23、§8.2 E-08、§6.2 T-05、§9.2 更正 9 | **由「无法判定」变为可判定**：许可**唯一源** = `src/phys/{LICENSE,NOTICE}`（captain 裁定，**非** `src/vendor/cs-movement/`）。三条判据：①源存在且全仓 `apps/` 下无第二份许可源；②`apps/debug/dist/` 与 `apps/game/dist/` 均含 `LICENSE.cs-movement` + `NOTICE.cs-movement`，且与唯一源逐字节相等（`Get-ChildItem dist` + 哈希比对）；③`apps/viewer/` **豁免**（`apps/viewer/crates/wasm/Cargo.toml` 无 `websurf-phys`，dist 无需许可证）。落点与 [t2 §5.3](framework-launch-structure.md)（第 563 行，该条已把许可源落点交本文件裁决）一致 |
| R-18（同一算法/常量只允许一份实现） | §2.1 维度①、§2.3 边界 1–4、D-01/D-02/D-03/D-04/D-08/D-09/D-10/D-16 | **已给出裁决 + 分级统计（覆盖全部「上提」项，无未定义档位）**：**级别 A 4 组**——D-01（`ensure-node-deps` 字节全等）、D-09（`atob` 解码块 8 处，归一化后全等，仅标识符与内联/具名形式差异）、D-10（`pvs-manager` `numstat 2 2`）、D-16（常量 `64.09` 在 7 处 TS 引用中逐字符全等）。**级别 A′ 1 组**——D-08（`bspYawToCsYaw` 算术核 4 处：3 处归一后全等，viewer 处多 1 个语义 token `\|\| 0`，按 §2.3 边界 4 第 4 步归 A′，语义归一口径见该边界末条）。**级别 B 2 组（引擎 / 内核范围）**——D-03（`check-wasm-api` 骨架同构、差异仅数据表）、D-04（三份 `build-dist.mjs` 的**文件对**为级别 C：`numstat 145 171`、归一化重合 0.58，故**不**上提整份；其 `commonOptions`/preamble/stale/tree 四段骨架同构属级别 B → 只上提内核）。**不适用分级 2 项**——D-02（副本数 = 1，未命中维度①；裁决依据为维度③依赖方向）、D-23（属 R-17 合规项，非维度①重复度）。`play.cmd`/`tsconfig`/`DEG2RAD` 明文判**不属于** R-18 对象（§2.3 边界 1 / 边界 3） |
| R-19（纯自举/环境准备脚本必须 `src/scripts/` 单份） | D-01、D-02、§6.2 T-01/T-02 | **已给出裁决 + 执行清单**：两份 `ensure-node-deps.cmd` 与单份 `install-wasm-bindgen.cmd` 全部上提；viewer 的 2 处内联判断一并改为调用（§1.3 C-4） |
| R-20（viewer 与共享层关系必须显式声明） | §4 全章、§4.4 | **裁判定为「正当隔离」（裁决 = 保留）**：7 个模块不接入（含理由），3 个新共享单点（`phys/angles.ts`、`phys/constants.ts`、`wasm/loader.ts`）必须接入。**R-20 无标的**：审计 §4.1「viewer 既 include 共享层又不引用」的前提不成立（§9.2 更正 6），R-09 现状**合规**；`tsconfig` include 与实测 import 的一致性要求转交 t2 §3.4 |
| R-21（不可合并重复必须列为明示例外并给理由） | §8.2 例外表 E-01…E-08 | **已列出 8 条例外**，含副本数、语义级理由与门禁归属（覆盖 R-21 点名的三类：vmdl patch、模块 workspace 清单、`wasm.d.ts`） |

### 9.2 对上游文档的更正与补充

| # | 对象 | 上游说法 | 实测更正 / 补充 | 证据 |
|---|---|---|---|---|
| 1 | [framework-audit.md](framework-audit.md) §4.2 | `Vec3` 在仓库有 **3 处**定义（含 `apps/debug/src/world/types.ts`） | 实为 **2 处**：`apps/debug/src/physics/math/vec3.ts:11`（vendored）与 `apps/game/src/world/types.ts:28,34`（`Vec3Like` + 别名）；debug 的 `world/types.ts` 不含 `Vec3` 字样 | `Select-String 'Vec3' apps/debug/src/world/types.ts` 零命中；该文件的 `Vec3` 来自 `../physics/math/vec3.js` |
| 2 | [framework-audit.md](framework-audit.md) §4.3 | 「完全同字节的被追踪重复」表列 2 对 | **补充**：第三对（三处）`apps/debug/web/textures.mtz`、`apps/game/web/textures.mtz`、`src/materials/textures.mtz`，各 5,942,995 B，SHA256 前 16 位 `A87F36F591CB…` 全等 | `Get-FileHash -Algorithm SHA256` 实测三份同值 |
| 3 | 本任务描述的问题 4 | 追问「`src/decoupled/` 与 `src/ts-shared/decoupled/` 是否构成命名混淆」 | **前提不成立**：`src/decoupled/` 不存在（`Test-Path src/decoupled` → `False`）；裁决改为「禁止未来在 `src/` 顶层新建同名目录」（§5.3） | `Test-Path src/decoupled` → `False`；`src/` 顶层实测 6 个子目录 |
| 4 | [framework-launch-structure.md](framework-launch-structure.md) §3.6/§10.1 第 13 条 | `install-wasm-bindgen.cmd` 就地补一层 `..` | 判**上提**（D-02 / §1.3 C-1），落点由本文件定稿 | 依赖方向 + R-19 |
| 5 | [documents/architecture.md](architecture.md) | 记为「TS 共享层 12 源文件五域，共 4171 行」 | 实测 **18 文件 / 6664 行**（t1 §5.2 亦为 18/6664）→ 该篇存在既有漂移 | `git ls-files src/ts-shared` 输出 18 行 |
| 6 | [framework-audit.md](framework-audit.md) §4.1 | 「`apps/viewer/tsconfig.json` 把 `../../src/ts-shared/**/*.ts` 纳入 `include`」，并据此判 R-09 / R-20 不成立 | **前提不成立**：实测 `apps/viewer/tsconfig.json:15` = `["src/**/*.ts","src/wasm.d.ts","test/**/*.ts"]`，**不含**共享层，与其零引用**自洽** → R-09 现状**合规**、R-20 **无标的**；viewer 专章据此写为「**正当隔离**（裁决 = 保留）」（§4.1、§4.4） | 实测 `apps/viewer/tsconfig.json:15` 全文；t2 §10.2 第 1 条记同一更正 |
| 7 | 本文件 D-09（原判） | base64 → `Uint8Array` 解码「6 处 / 3 工程」（**漏计共享层内 2 处**） | **更正为 8 处 / 4 处落点**：补 `src/ts-shared/auth/worker-dispatch.ts:164`、`src/ts-shared/phys/world-builder.ts:196`；判据同步改为全子树匹配（§7.7 批 1 验证行由 `-- apps/*/src` 改为 `-- apps src`，期望值由「0 处」改为「恰好 1 处 = `src/ts-shared/wasm/loader.ts`」） | 全树 `atob` 扫描实测 8 处（三工程 6 + 共享层 2） |
| 8 | 本文件 D-16（原判） | `EYE_STAND` 同值「6 处」（**漏计 2 处 TS 引用**） | **更正为 8 处计数 = 1 Rust 定义 + 7 TS 引用**：补 `src/ts-shared/auth/shared-state.protocol.test.ts:139`（精确断言 `dstF[8] === 64.09`）与 `apps/game/scripts/phys-smoke.mjs:122`（±0.5 容差断言 `Math.abs(eStand.eyeHeight - 64.09) > 0.5`）。**同口径漏项复核结论：无其他命中**——`64.09` 在 `apps/`+`src/`（排除 `node_modules`）全树扫描仅此 8 处；`:237,238,281,282,309` 的 `eyeHeight: 64` 属夹具占位值、viewer `fly.ts:176,195` 与 `pose.ts:34` 属符号级消费，均**不**计入同口径 | 字面量全树扫描；`apps/game/scripts/phys-smoke.mjs:118-123` 第 7 项断言 |
| 9 | [framework-audit.md](framework-audit.md) §6.1 的 I-21（game 的 dist 缺 `LICENSE.cs-movement`/`NOTICE.cs-movement`） | 记为「待修缺陷」（未给修复口径） | **本文件处置口径**：I-21 为**合规待修**（不得列为真实差异、不得豁免），修复 = ①许可源上提 `src/phys/{LICENSE,NOTICE}`（D-23，captain 裁定）；②`apps/game/scripts/build-dist.mjs` 补同款拷贝（single + multi）；③三工程 dist 一律从**唯一源**拷贝（产物级拷贝合法，禁止第二份**源副本**，判据见 §8.2 E-08）。`apps/viewer/` 不在其列（无 `websurf-phys`）。**补充发现**：将上提为 `src/phys/NOTICE` 的现 NOTICE 第 16-20 行的「Files added by WebSurf」清单**陈旧**——其中 `src/physics/runtime.ts`、`src/physics/physics/Collision/brush-grid.ts` 在仓库内不存在，且 4 条路径用的是相对 `apps/debug/` 的旧前缀；建议随搬迁核正为仓库根相对路径并删除不存在项 | `apps/game/crates/wasm/Cargo.toml:22` = `websurf-phys = { path = "../../../../src" }`；`apps/debug/scripts/build-dist.mjs:136-137`、`:191-192` 为现唯一拷贝方；`Test-Path` 两次 `False`，`Get-ChildItem -Recurse -File apps,src -Filter runtime.ts` 零命中 |

## 10. 验证方法

### 10.1 本文件自身的体检

- **行尾/编码**（纯 `fs`，任何沙箱可跑）：

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('documents/framework-decoupling.md','utf8');const bom=s.charCodeAt(0)===0xFEFF;const cr=/\r(?!\n)/.test(s);const tw=/\r?\n[ \t]+\r?\n/.test(s);console.log('BOM:',bom,'loneCR:',cr,'trailingWS:',tw);process.exit(bom||cr||tw?1:0)"
```

- 更严的行尾空白检查（覆盖「内容行末空格」，captain 版只覆盖空白行）：`/[ \t]+\r?\n/`。
- **锚点/行数声明**：`node src/scripts/check-doc-drift.mjs documents/framework-decoupling.md`。该脚本在 `src/scripts/check-doc-drift.mjs:31` 用 `execFileSync` 起 `git` 子进程，在禁止子进程 spawn 的环境会 `spawnSync git EPERM`（errno -4048）——属**环境限制**而非文档缺陷；此时改用同一套 A/B 正则的纯 `fs` 等价检查（把预生成的 `git ls-files --cached --others --exclude-standard` 列表喂给同一逻辑）。
- **相对链接**：本文件只链接真实存在的文件（[framework-audit.md](framework-audit.md)、[framework-launch-structure.md](framework-launch-structure.md)、[AGENTS.md](../AGENTS.md)、[architecture.md](architecture.md)）。

### 10.2 落地后的验收命令

```bash
# R-18：级别 A 候选应已消失
git ls-files -- 'apps/*/scripts/ensure-node-deps.cmd' 'apps/*/src/world/pvs-manager.ts'   # 期望空输出

# R-19：共享脚本单份 + 工程内无副本
git ls-files 'src/scripts/*.cmd'          # 期望含 cargo-env / ensure-node-deps / install-wasm-bindgen

# §5.4 规则 2：共享层不得 import apps/
git grep -nE "apps/|\\.\\./\\.\\./\\.\\." -- src

# §6.2 T-04 硬约束：内核不得 import esbuild
git grep -n "from 'esbuild'" -- src/scripts

# D-16 / R-21 门禁
node src/scripts/check-shared-sync.mjs

# D-11：三处纹理包一致性（T-05 亦覆盖）
node -e "const c=require('crypto'),f=require('fs');const h=p=>c.createHash('sha256').update(f.readFileSync(p)).digest('hex').slice(0,16);const a=['src/materials/textures.mtz','apps/debug/web/textures.mtz','apps/game/web/textures.mtz'].map(h);console.log(a,new Set(a).size===1?'SYNC':'DRIFT');process.exit(new Set(a).size===1?0:1)"
```
