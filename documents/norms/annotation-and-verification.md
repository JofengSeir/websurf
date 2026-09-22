# 注释重编与复验规范

> 本篇属 P4「规范类篇」。它把本仓注释重编过程中的**操作规范与已验证的陷阱**固定下来，供后续任何人（含自动化执行者）照做。
> 事实来源约定见 `documents/plan/doc-rewrite-taskbook.md`；进度与待决项见根 `AGENTS.md`；历史过程记录见 `documents/plan/progress-log.md`。

---

## 1. 事实来源与三条禁令

| 编号 | 禁令 | 含义 |
|---|---|---|
| **B1** | 禁以旧注释为依据 | 不得摘抄、复述、沿用被重写的旧注释；语义只能从实现、调用点、测试、构建脚本取得 |
| **B2** | 禁以旧文档为依据 | 已删除的旧文档**不得读取、不得引用、不得当作回滚依据**；结论必须能在文档树为空时从源码重建 |
| **B3** | 禁推测 | 无法在代码中定位的结论不写；禁止「应该 / 可能 / 大概 / 似乎 / 推测 / 此前 / 据文档 / 据注释 / 原设计 / 历史上 / 待确认」等措辞 |

判定「无法定位」的例子：只存在于旧注释里的地图名、日期、百分比、毫秒实测值；指向仓库外工程的 `文件:行号`；已不存在的符号。这类内容一律删除或改写为**代码可核对的口径**（常量值、分支条件、调用点符号）。

> 上表与本节列出的禁用词是本规范的**引用对象**——它是全仓**唯一**允许出现这些字样的位置（因为要定义「什么算推测」）。其余任何新稿出现这些词即判不合格。

---

## 2. 注释书写规范

1. **代码零改动**：重编只允许增删注释。字符串字面量（含断言标签、日志文案、DOM 文案、报文 `type` 取值）与缩进都在「代码」范围内。
2. **注释内不写行号**：同文件引用用**符号名**；跨文件引用用「相对仓库根的路径 + 符号名」。原因：行号锚点在目标文件被重编后必然失效，而「行号仍在范围内但内容已变」的那类错误是**静默**的。
3. **块注释不得提前闭合**：注释续行内不得出现 `*/` 序列，也不得写含 `**/` 的 glob（改用「某个目录下的全部 `.ts`」这类表述）。
4. **模板字符串内容＝代码**：形如 `` `…${x}…` `` 的字符串内部（GLSL / HTML / 多行文案）不得改动，即使其中含以 `//` 开头的行。
5. **文件格式**：UTF-8 无 BOM、行尾 CRLF（本仓 `core.autocrlf = true`，入库内容恒为 LF）。
6. **空行与既有空白**：不得顺手清理原有的行尾空白或空白行——那属于格式改动；判据是「不高于 HEAD 基线」。

---

## 3. 复验：四道门

每件（或每批）交付前必须实跑，缺一不可：

| # | 门 | 命令 | 通过判据 |
|---|---|---|---|
| 1 | 代码同一性 + 来源审查 + 格式 | `& .tmp/tools/verify.ps1 -Files <文件...>` | `校验失败文件数: 0 / N`、exit 0；**主判据是 `stripTrail` 逐行 d0**；`strict` 报差异时须由脚本自动判定为「行尾注释改写」；**三项按「不高于 HEAD 基线」判**：禁用词、禁用路径、行尾空白 |
| 2 | 注释锚点 | `node .tmp/tools/anchor-scan.mjs <文件...>` | 违规 0；目标状态是**锚点 0 处**（注释内不写行号） |
| 3 | 模板字符串 | `node .tmp/tools/template-proof.mjs <文件...>` | `PROOF-OK`（与 `git show HEAD` 逐模板比对，CRLF 归一化） |
| 4 | 编译 / 类型 | Rust：`cargo check`；TS：`npm run typecheck` | exit 0 |

**关键纪律：不得只凭第 1 道门判定通过。** 已被实测证明「三套文本判据全部通过、但代码实际被改」的两种情形：

- 块注释提前闭合（其后注释被当作代码解析）——只有编译器/类型检查会暴露；
- 模板字符串内部被改（其内以 `//` 开头的行会被判据当作注释剥离）——只有第 3 道门会暴露。

`.tmp/` 下的工具不入库，属过程产物；本仓另有 `src/scripts/check-doc-drift.mjs`（只校验 `documents/**` 的 md 锚点与路径）与 `src/scripts/check-shared-sync.mjs`（Rust 与 TS 两侧常量逐位比对）。

---

## 4. 内容审查（补上「文本判据」的盲区）

文本判据只能证明「代码没改、格式合规」，**不能证明注释里写的事实为真**。因此每批交付还要做两项机器可核验的内容审查：

| 手段 | 做法 | 判据 |
|---|---|---|
| **路径核验** | 抽取注释里所有看起来像仓内路径的引用（`apps/…`、`src/…`、`test/…` 加扩展名），逐个 `Test-Path` | 全部存在 |
| **符号核验** | 抽取「`` `路径` `` … `` `符号` ``」型跨文件断言，逐个在目标文件里 grep 该符号 | 全部命中 |

这两项替代了「人工抽三条看一眼」的旧做法；符号核验尤其重要，因为**符号名不存在会立刻暴露，而行号不会**。

**判读口径（交付面 vs 过程记录）**：这两项按「**当前事实断言**」判 `bad=0`。`documents/plan/progress-log.md` 是**过程记录**，其行内会出现三类**非当前断言**的路径文本，需逐条判读而不是直接判失败：① **已删文件的历史引用**（行文本自带「已删文档 / 已退役」限定，例：已退役 harness 目录 `test/dual-mode-harness/` 下的文件、`documents/<app>/implementation/<旧篇名>.md`、`apps/game/` 下被删的 favicon 图标）；② **引用的错误写法样本**（行文本本身就在讲「把 app 相对路径当仓内路径」这件事）；③ **工具名与相邻路径的误配**（`verify.ps1` / `stripTrail` 等判据名被当成符号）。除此之外的路径与符号断言，一律按交付面判 `bad=0`——本仓实测即据此修掉台账 13 处路径文本与 2 处不存在的符号名。**同口径**：台账的历史行还会**引用**禁用词（如转述旧稿措辞、记录某次裁决时用到「此前」「可能」），这些是过程记录里的引述，不按「新稿 0 命中」判；交付面文档与代码注释仍按 §1 的 0 命中判。

---

## 5. 已验证的陷阱清单

1. `git show "HEAD:<路径>"` 在 Windows 下**必须用正斜杠**，否则参照集为空，比对脚本会把它静默判成「无差异」而输出假通过。
2. 判定注释行必须用字面前缀判断（`//`、`/*`、`*`）；用通配符匹配会把两侧都清空成 0 行，从而再次假通过。
3. 比对代码要跑**两遍**：一遍按整行是否注释过滤，一遍先剥离行尾 `//` 之后的内容——只跑第一遍会把行尾注释当成代码改动。
4. PowerShell 正则里 `\s` **会吃掉行尾的 `\r`**：用 `(?m)^(\s*)…(\s*)$` 做替换且不回补第二个捕获组，会把该行变成 bare LF。行尾请用 `[ \t]*`。
5. 禁止用「哈希表 + 嵌套数组」存替换对：PowerShell 会摊平嵌套数组，取下标会退化成取字符串的第 N 个字符，导致「整串替换」静默变成「单字符替换」。批量替换一律用元组数组 + 具名变量，并在替换后断言「旧串计数为 0、新串计数符合预期」。
6. 子代理正在写文件时**不得**做代码同一性判定（中途态会被误判）；批量失败后要先做**静止期全量盘点**再逐件复验。
7. `cargo test` 经 PowerShell 管道会带出与结果无关的退出码，判据取命令自身的 `$LASTEXITCODE`。同理：`node <脚本> | Select-Object -First N` 会在取够 N 条后**提前终止上游进程**，`$LASTEXITCODE` 可能变成 `-1`——那是管道截断的产物、不是校验结论；要拿退出码就别截断输出（先重定向到文件再读）。
8. 用 `edit` 类工具修改**带 UTF-8 BOM 的 `.ps1`** 会**丢掉 BOM**：Windows PowerShell 5.1 随即按 ANSI 解码中文注释，抛出 `Array index expression is missing or not valid` / `Missing closing '}'` 一类**假语法错**（脚本根本没跑，而 `$LASTEXITCODE` 仍可能是 0 ⇒ 假绿）。改完这类脚本必须回读前 3 字节确认是 `EF BB BF`，并复跑一次。
9. 「禁用词」判据必须按 **HEAD 基线**判而不是「恒为 0」：面向用户的字符串字面量属**代码**，本来就可能含这些字样（例：`'可能原因：浏览器禁用了 WebGL…'`）。`verify.ps1` 输出形如 `禁用词=N/基线M`，判失败条件是 `N > M`。
10. 新建文件的行尾不可假定为 CRLF：写文件的工具产出 **LF**，而 `verify.ps1` 对代码文件会当场报 `bareLF>0`、对**文档却没有任何门会报**。实测本仓 6 篇新文档（`documents/{architecture,materials,norms,phys,ts-shared,wasm-core}/overview.md`）落盘时全是 LF，已统一归一为 CRLF（内容逐字未改；本仓索引恒存 LF，故入库内容本就一致）。**结论**：新建文档后要单独看一眼行尾。
11. 「禁用路径」与「禁用词」同口径（按 HEAD 基线判，失败条件是 `N > M`，输出形如 `禁用路径=N/基线M`）：被排除目录的名字会以**代码字面量**形式留在文件里（实例：`src/scripts/check-doc-drift.mjs` 里跳过快照目录的那条 `/archive\//` 正则，HEAD 基线即含它，该件实测 `禁用路径=1/基线5`）。这类字面量属**代码**：改注释既不能消除它、也不得为过门而改代码；若按「恒为 0」判，这类文件永远无法通过。**双向实测（方法留档）**：曾对某件做过 `3/基线3` → exit 0、临时追加一处退役路径 → `4/基线3` + exit 1、逐字节还原后 SHA256 与注入前一致的验证；那 3 处字面量已在本轮按 owner 裁决从代码中删除（见台账），方法本身仍是本判据的依据。
12. **被 `.gitignore` 忽略、不在 HEAD 的文件没有参照集**：`verify.ps1` 对它们必然报「`git show` 失败或参照集为空」并计入失败（实例：`apps/game/scripts/_dbg_keys.mjs`、`_dbg_floor.mjs` 被 `apps/game/.gitignore` 的 `scripts/_*.mjs` 规则忽略 ⇒ 11 件批的汇总恒为 `2 / 11`）。**处置**：① 这类文件**不要放进 `verify.ps1` 的 `-Files` 列表**（否则汇总永远不是 0）；② 改用**编辑前快照 + 同款两遍算法**作为替代判据——编辑前把原文件拷到 `.tmp/<批次>-baseline/`，改完跑 `node .tmp/tools/snapshot-diff.mjs <快照> <当前>`，要求 `strict` 与 `stripTrail` 双 `d0`；③ 该工具会剥离首行 BOM 并单独声明（BOM 属格式属性，`verify.ps1` 本就要求 `BOM=False`）；④ `template-proof.mjs` 对这类文件打印 `SKIP(no HEAD)`，不构成证明，不能据此判定通过。
13. **prose 资产与「注释语法不被 `verify.ps1` 识别」的资产，都不适用「代码同一性」判据**：前者的正文**就是**重写对象（实例：`apps/viewer/scripts/dist-README.md`，被 `build-dist.mjs` 消费），后者的注释（`.cmd` 的 `rem` / `REM` / `::`、`.html` 与 `.css` 的 `<!-- -->` / `/* */`）会被当成代码行（实例：`src/scripts/cargo-env.cmd` 改 18 行注释即报 `strict/stripTrail d18`；`apps/viewer/web/styles.css` 改 16 个注释块报 `d3`）——两者都会 `exit 1`，这是**判据不适用**而非返工信号。**判据集合改为**：① `verify.ps1` 的其余各项必须全过（行数/CRLF/`bareLF`/BOM/尾空白基线/空行尾空格基线/禁用词基线/禁用路径基线/块注释提前闭合）+ 末尾换行状态与 HEAD 一致；② `anchor-scan` 违规 0；③ `content-review.mjs` 的仓内路径与「路径+符号」全命中（注：该工具只抽取带 `apps|src|test` 前缀的路径，纯裸名路径需自己 grep 复核）；④ `markdown` 类：改动须是**整行文本替换**（改前逐条断言 `old` 命中次数恰为 1）；⑤ `.html` 跑 `.tmp/tools/html-struct-proof.mjs`（比对前自动剥掉 HTML 注释，要求 `<...>` 标签序列逐项相同）；⑥ `.css` 跑 `.tmp/tools/css-proof.mjs`（剥掉 `/* */` 后逐字符比对规则文本，要求 `CSS-CODE-IDENTICAL`）；⑦ `.cmd` 跑 `.tmp/tools/cmd-proof.mjs`（按 `rem`/`::` 过滤后比对**命令行**多重集，要求 `CMD-CODE-IDENTICAL`，并顺带打印 `nonASCII` 计数——该族文件实测 12 个全部为**纯 ASCII**，注释不得引入非 ASCII 字符）。**不得**因为「过不了代码同一性」就把这类文件还原为 HEAD——还原会把已删引用与事实错误一并带回。**⑧ `.py` 同族（本提示补齐）**：`verify.ps1` 只把 `//` 当注释，Python 的 `#` 与 `"""docstring"""` 会被计入「代码行」（实例：`src/serve.py` 报 `strict:52/60/d26`），**判据改为** `.tmp/tools/py-proof.py`——三重断言：`ast` 抹掉 docstring 后 `ast.dump` 相同、`tokenize` 的代码码流（剔 `COMMENT`/`NL`/`INDENT`/docstring `STRING`）相同、剥注释与 docstring 后的真实代码行逐行相同，要求 `PY-CODE-IDENTICAL`。**⑨ `.html` 的加强证明**：`html-struct-proof.mjs` 只比 `<...>` 记号，属性值里的**可见文本**（`title=` / `placeholder=` 等）不在判据内 ⇒ 再加一道 `.tmp/tools/html-markup-proof.mjs`：剥掉 HTML/CSS 注释后要求「标记 + 文本逐字符相同」＋「标签序列相同」＋「属性值多重集相同」，三项全过才是 `HTML-MARKUP-IDENTICAL`。**⑩ 该结构门的行尾陷阱（本轮实测修复）**：`git show` 产出 LF 而工作区是 CRLF，属性值里含 `>` 的标签会被 `/<[^>]*>/g` 切成**跨行记号**，同一标签随即因行尾的 `\r` 被判成不同（实例：`apps/debug/web/index.html` 曾误报 `HTML-STRUCT-DIFF 4`）⇒ 该工具已加入行尾归一，**任何新增的「HEAD vs 工作区」文本比对工具都必须先归一 `\r\n`**。相关实例与计数见 `documents/plan/progress-log.md` 的 WG4b / WG6b / WG12 各行与「范围覆盖盘点」行。 **⑪ 配置类资产（`.toml` / `.gitignore`，本轮补齐判据）**：它们同样没有「代码同一性」判据——`verify.ps1` 只把 `//` 当注释，`#` 注释与**忽略规则本身**都会被当成普通文本。**判据**：`.tmp/tools/config-proof.mjs`——先做行尾归一（`git show` 是 LF、工作区 CRLF），剥掉 `#` 注释与空行后把两侧**逐字符**比对，同时打印注释行数前后计数；要求 `CONFIG-CODE-IDENTICAL`。**注意**：`.gitignore` 的忽略**规则**是代码而非注释，规则一变就会如实报 `DIFF`（这正是想要的判据）；`#` 出现在 TOML 字符串里会被一并剥离，故该工具证明的是「剥注释后的配置文本相同」，不是 TOML 语义等价。**首轮实测（13 个配置文件）**：9 个 `Cargo.toml` + `apps/{debug,game,viewer}/.gitignore` 全部 `OK 配置文本逐字符相同`；**根 `.gitignore` 报 `DIFF`**——它在本轮被加过一条 `.ak/` 忽略规则（配置字符 610 → 615、注释行 31 → 33），是本仓库**唯一**被改动过的配置项。

14. **不要用 PowerShell 的 `Get-Content` / `Set-Content` 读改 UTF-8 文件**（本轮实测两次踩坑）：① 本会话控制台把 UTF-8 中文按 GBK 解码，`Get-Content apps/debug/package.json` 显示为乱码——**判读中文内容一律用 read 工具**，不得依据 `Get-Content` 的输出判定文件内容；② `Set-Content -Encoding utf8` 会**加 BOM 并吃掉换行**（Windows PowerShell 5.1），本轮据此把 `.tmp/tools/html-struct-proof.mjs` 写成 `SyntaxError: Illegal return statement`（行粘连 + BOM）——**改文件只用 write/edit 工具或 node 脚本**，改完回读首字节确认无 `EF BB BF`。**同一族的第三个坑（本轮又踩一次）**：PowerShell 的**反引号是转义符**，把含反引号的补丁写成 `node -e "…"` 内联命令时，反引号包裹的路径/符号会被吃掉，替换**静默命中 0 次**；含反引号的替换一律写成 `.mjs` 补丁文件再执行，并断言「命中次数恰为 1」。

15. **脚本末尾的 `exit` 会终止整个 pwsh 进程**：`.tmp/tools/gate-all.ps1` 以 `exit 1` 收尾，用 `& script *> log` 重定向时**末行汇总会丢失**（进程在写盘前结束）⇒ 判读改为对日志过滤 `--- failing chunk` 与 `★代码部分不同`，不依赖汇总行。同族的**运行期陷阱**：无头脚本里形如 `finish(code)` 的收尾若把 `process.exit` 排进 `setTimeout`（实例：`apps/debug/scripts/input-replay-verify.mjs` 的 `finish`），调用后代码**仍会继续执行**，随后以 `TypeError` / `unhandledRejection` 路径收场——静态读码时要按「不立即退出」理解其控制流。

16. **`git status --porcelain` 会把「完全未跟踪的目录」塌缩成一行**（本轮实测的假绿源头）：不带 `-uall` 时，整目录未跟踪只输出 `?? documents/norms/` 这样一条**目录**路径。若直接把该输出当「文件清单」逐件判定：① 目录会被当文件读，`readFileSync` 抛 `EISDIR`，异常文本恰好被格式化进计数位，产出形如 `BAD documents/norms/ CRLF=node:fs:732 bareLF=return BOM=binding.read(fd,` 的**假失败行**；② 更危险的是**该目录内的真实文件从未被检查**——本轮实测 7 个目录（`documents/` 下的 `architecture` / `materials` / `norms` / `phys` / `plan` / `ts-shared` / `wasm-core`，含 WG8 共享层 5 篇与计划三篇）的全部 `.md` 因此整整漏扫一轮。**判据**：清单一律取 `git status --porcelain -uall`，并对每条路径加 `-PathType Leaf` 过滤；行尾/BOM 扫描改用 `.tmp/tools/eol-sweep.mjs`（内置 `-uall` 与目录递归，输出 `scanned=N problems=M`）。**同族口径**：该扫描的 `trailingWS` 与 `verify.ps1` 同口径，**按 HEAD 基线判**（实例：`src/wasm-core/bsp_to_gltf_core/convert.rs` 58 处、`src/wasm-core/texture_utils/vtf.rs` 1 处均为 HEAD 既有，**不得清除**）；而**本轮新写的文档**自身的行尾空白要清（本轮实测清除 `documents/phys/overview.md` 1 处）。

---

## 6. 记录约定

- **规范与当前状态**写在根 `AGENTS.md`：规范（§1–§6）、工作组状态（§7.2）、仍生效的规则与待裁决项（§7.3）。
- **历史进展**逐行追加到 `documents/plan/progress-log.md`；已结案条目移入该文件时**逐行原样**，不改一字。
- 台账里提到**仍在重编的文件**时不写行数——行数会随重编变化，写死必然漂移；确需写时用完整路径且只在文件冻结后写。
- 疑似代码缺陷**只记录不修**（静态读码所得须注明「未运行验证」），是否修改由仓库 owner 裁决。
