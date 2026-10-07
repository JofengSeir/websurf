---
name: websurf-env-traps
description: "本仓（WebSurf，Windows + PowerShell 工作区）的环境与流程陷阱：跑命令取证据、沙箱边界、git 并发提交、以及「判断某功能是否已被删除」时的假阳性。要在本仓开工、跑命令、查证待办、或准备提交前读它——每条都是本仓实测撞过的墙，读一次省大量绕路 token。"
---

# WebSurf 环境与流程陷阱（Windows）

> **为什么有这篇**：本仓在 Windows + PowerShell 下作业，agent 反复撞同一批墙（假绿、假「功能已删」、编码/行尾、输出被截断、沙箱边界），每次都要花 token 重新发现一遍。
> **边界**：本篇讲「怎么干活不撞墙」，**不是事实来源**；待办与状态只在根 `TODO.md`。
> **历史工具链陷阱**（`verify.ps1` 时代共 16 条）已在 `documents/norms/annotation-and-verification.md:70` 的 §5 逐条留档，本篇**不复述**，只写今天仍会撞、且开工就该知道的。

## 0. 三条最贵的坑（只看这三条也值）

1. **长输出会被截断成「尾部」**：直接解析 stdout 会静默拿到**残缺集合**，据此下的结论全错。
   实例：解析 `git log` 只拿到 97/387 条提交，由此得出的「某改动不存在」结论是错的。
   做法：大输出**用 Node 写文件再读**（`execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64*1024*1024 })`），并**先断言规模**（`git rev-list --count HEAD`）再看内容。
2. **「文件不在树上」≠「功能已删除」**：`git grep` / `git ls-files` 只覆盖**已跟踪**文件；`dist/`、`pkg/`、`web/app.js`、`web/worker.js`、`**/web/*.wasm`、`test/maps/*`、`test/replay/*`、`.tmp/`、`.cargo-home/`、`.wasm-pack-cache/`、`apps/*/scripts/_*.mjs` 都是生成物或本地物。
   实例（差点误判）：`apps/viewer/dist/play.cmd` 不在树里，但它是 `apps/viewer/scripts/build-dist.mjs:233` 的**生成物** ⇒ 不能据此把 `T-135` 结案。
   做法：判「某物是否还在」走**全工作区文件索引**（含未跟踪），不要用 `git grep` 的 0 命中下结论。
3. **basename 存在性检查会批量假阴性**：正则分支里 `js` 会先于 `json` 命中（`package.json` 被切成 `package.js`），`d.ts` 也会被切碎。
   做法：正则分支**最长后缀优先**（`d\.ts|json|mts|mjs|cjs|ts|js|rs|md|cmd|…`），并用「全仓 basename → 路径表」判定，而不是把裸文件名丢给 `fs.existsSync`。

## 1. 命令与取证据（Windows / PowerShell）

| 坑 | 症状 | 做法 |
|---|---|---|
| pwsh 的 `>` 重定向写 **UTF-16** | read 工具报 binary file | 用 Node 的 `fs.writeFileSync` 落盘；或 `| Out-File -Encoding utf8` |
| 把 git 塞进 `cmd /c "… & echo"` | 静默 exit 1、文件没生成 | 用 Node `execFileSync("git", [args])`——**不经 shell**，无引号/转义地狱 |
| 层层反斜杠转义 | 引号/反斜杠层数算错 | 路径在 Node 用**正斜杠**；参数走数组，不拼命令字符串 |
| `node 脚本 \| Select-Object -First N` | 上游进程被提前终止，退出码成 −1 | 先重定向到文件再读（同 norms §5 第 7 条） |
| 脚本末尾 `exit` | 整个 pwsh 进程结束，**汇总行丢失** | 脚本里不要 `exit`；判读改为过滤日志（同 §5 第 15 条） |
| `Get-Content` 读中文 | 控制台按 GBK 解码 → 乱码 | 判读内容**一律用 read 工具**（同 §5 第 14 条） |
| PowerShell 正则里的 `\s` | 吃掉行尾 `\r` → 变 bare LF | 行尾用 `[ \t]*`（同 §5 第 4 条） |
| `git status --porcelain` 不加 `-uall` | 未跟踪**目录**塌缩成一行 | 当文件清单用会读目录（`EISDIR`）⇒ 加 `-uall`（同 §5 第 16 条） |
| `git show "HEAD:<路径>"` 用反斜杠 | 参照集为空 → **假通过** | 必须正斜杠（同 §5 第 1 条） |

## 2. 沙箱边界

- 受限模式跑在 **ConstrainedLanguage**：`[System.IO.*]::`、`[math]::`、`Add-Type`、COM、反射一律报 only core types ⇒ 改用 cmdlet 与核心类型（`[string]`/`[regex]`/`[datetime]`/`[guid]`）。
- 受限模式下**程序不能开命名管道**：Node `child_process` 用默认 `stdio:"pipe"` 抓别的程序输出会 `EPERM`。这是**设计边界**，不要换个写法重试——改 `stdio:"inherit"/"ignore"`，或用 PowerShell 自己的管道。
- 沙箱拒绝形如 `[sandbox: file access denied under <mode>]`：那是**策略拒绝**，不是路径写错 ⇒ 不要换路径重试。

## 3. git 与提交（本仓有并发 agent）

- **提交前必跑 `git status --short`**：同一工作区常有**另一个 agent 的在途改动**。只 `git add` 自己改的文件；`TODO.md` / `OWNER.md` 常被双方同时改，**对方新增的行要原样保留**，不要回退，也不要写进自己的改动说明。
- **绝不 `git checkout -- <文件>` 去「清干净」**：会直接抹掉未提交成果。
- 行尾：`core.autocrlf=true` ⇒ 索引是 **LF**、工作树是 **CRLF**，体检以**索引 blob** 为准。不要顺手统一行尾。
- **体检与提交串成一步、红灯即终止**（`&&` 式；`;` 式会让红灯也提交）。本仓已因此出过红灯提交。
- 提交信息写 `T-###`；纯格式/注释措辞类改动写「无待办影响」——CI 软提示正是查这两者之一。

## 4. 判断「已完成 / 前提是否还在」

- **跑判据，不要看代码猜**：`TODO.md` 总表「判据」列 = 可执行命令 + 期望输出，先跑它。
- **判据本身可能指错路径**：实测 `T-126` 的判据写 `apps/viewer/src/renderer/panel.ts`，而**该路径不存在** ⇒ 判据永远「满足」，会把条目**永久假结案**。跑之前先确认判据引用的路径存在。
- **判据的 `-- <路径>` 可能指错目录**：实测 `T-129` / `T-132` 的判据搜 `apps/viewer/scripts`，而文件在 `apps/viewer/test/` ⇒ 判据永远 0 命中、两条被**假结案**。结案前必须**用「证据」文件本身**再复核一次该模式是否仍命中（体检 `[M]` 现在硬查这条）。
- **关掉一条必须堵上文档缺口**：该条在 `documents/**` 若有「已知缺口」段落，同提交打 `~~原断言~~ **已消除（YYYY-MM-DD）**：原因`（体检 `[L]` 硬查；删掉整段也算合格）。
- 判据列里的反引号以 `@BT@` 占位：读 `TODO.md` 判据列时先把 `@BT@` 还原成反引号。
- 结论必须落到 `文件:行号`；落不到就标 `[待确认]` 并停下上报（§1 B3 禁推测）。

## 5. 本机工具/资源边界

- **没有 Chrome**：`archify` 的 browser-check 会 skipped。先 `$env:ARCHIFY_CHROME="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`（Edge 是 Chromium）。
- **DSH 不自动发现项目级 skill**：本机 skill 来源是 home 级约定（`~/.dsh/skills`、`~/.agents/skills`、`~/.<工具>/skills`）；仓库内 `skills/**` 需链接/复制进共享池后 `skill` 工具才解析得到——**本机已用 junction 链好**（`~/.agents/skills/websurf-env-traps` → 仓库，零复制），`skill` 可直接解析。⇒ 本仓规矩：**任何 agent 都必须读的东西，写进 `AGENTS.md` 指向的仓库文件**（不依赖某个工具的 skill 发现）。
- 过程产物进 `.tmp/`（已 gitignore）；`progress/` 是可见的过程记录（不作事实来源）；图表产物本仓放 `.archify/`（**已** 进 `.gitignore`，不再出现在 `git status`）。

## 6. 省 token 的作业方式（这条最省）

- **一段程序做多件独立事**：把互不依赖的检查写进同一段 Node 程序跑完再打印摘要，比「一条一回合」省一个数量级。
- **先机械判据筛，再人工判读**：grep / 存在性 / 计数先把候选集收窄，不要把上百条逐条进上下文。
- **每步留可复跑的命令**，结论写进 `TODO.md` 的证据列——下一个人不用重推。

## 7. 改门禁 / 做注入验证时（本轮三次踩坑换来的）

- **注入必须先断言「确实改了字节」**：探针的替换串没匹配上真行时，文件没变、门当然不响——你会把"空转"误读成"机制不工作"（我第一版强绑定测试就是这样）。写完探针先比较改前改后字符串，不等就抛错。
- **验证必须同时覆盖「该拦的」和「该放的」**：只测该拦的，会漏掉"权限/门禁过紧把正常工作锁死"这类错。实例：`docflow` 的 `sync` 给控制层文件也建了整篇钉，把字段级权限盖住 ⇒「只改状态列」也被拦；**是靠"验证该放行的那一项"才发现的**。
- **粗粒度的锁会静默盖掉细粒度权限**：同一文件既在只读集里、又有字段级/单元级规格时，整篇钉优先——装完新的细粒度规则，务必回头验一遍"原本自由的改动仍然自由"。
- **`.cmd` / `.bat` / `.ps1` 的每一行都要 CRLF**：用 Node 写文件会落 LF，`cmd.exe` 当场把命令行切错（报 `'RT' is not recognized`、中文标签被当命令跑）。仓库已加 `.gitattributes`（`text eol=crlf`）钉死检出形态；改完必须确认行尾，再用桩件实跑一次。
