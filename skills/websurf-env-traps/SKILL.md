---
name: websurf-env-traps
description: "本仓（WebSurf，Windows + PowerShell 工作区）的环境与流程陷阱：跑命令取证据、沙箱边界、git 并发提交、以及「判断某功能是否已被删除」时的假阳性。要在本仓开工、跑命令、查证待办、或准备提交前读它——每条都是本仓实测撞过的墙，读一次省大量绕路 token。"
---

# WebSurf 环境与流程陷阱（Windows）

> **为什么有这篇**：本仓在 Windows + PowerShell 下作业，agent 反复撞同一批墙（假绿、假「功能已删」、编码/行尾、输出被截断、沙箱边界），每次都要花 token 重新发现一遍。
> **边界**：本篇讲「怎么干活不撞墙」，**不是事实来源**；待办与状态只在根 `TODO.md`。
> **历史工具链陷阱**（`verify.ps1` 时代共 16 条）已在 agentmemory 记忆库 websurf/documents/norms/annotation-and-verification.md:70 的 §5 逐条留档，本篇**不复述**，只写今天仍会撞、且开工就该知道的。

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
| PowerShell 里 `try{…}catch{}` 挤成一行 | 解析报 `The Try statement is missing its Catch or Finally block` | 必须多行（或保证 `try{}` 与 `catch{}` 各自成块）——一行式写法在 PS 5.1 直接语法错 |
| `web_fetch` 直连 `raw.githubusercontent.com` | 30 s 超时 | 走代理：`pwsh` + `Invoke-WebRequest -UseBasicParsing -Proxy http://127.0.0.1:7897 -OutFile …`（7890/7891 未开） |

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
- **CI 里「工作树 == HEAD」，比对工作树与 HEAD 的判据在 CI 恒不成立**：`docflow` 的强绑定/联动原本只比工作树与 HEAD ⇒ 本地拦得住、CI 上永远绿。做法：把变更基线显式化（`--base <rev>`，CI 下默认 `HEAD^`），别把「本地跑得过」当门禁有牙。
- **锚点指纹必须按 `目标文件:行号` 存**，不能按「第几个锚点」存：后者在文档里插入一行新锚点时，后面所有锚点错位——实测一次报 221 处假红，门禁随即不可信。
- **`sync` 不许无条件全量重钉**：不点名的全量 `sync` 会把真漂移一起洗掉，门禁退化成「红了就 sync」。现在的口径：只钉点名的篇，锚点**真有变化**时 `--reason` 必填，并留痕在 `docflow.json` 的 `rebaselines`。
- **「登记 / 覆盖率」类判据不能用 basename 匹配**：`build-dist.mjs` 这类同名脚本一天三份，裸文件名会被别处的同名文件顶包 ⇒ 必须按**仓库相对路径**匹配（同名时只凭裸名不算登记）。
- **只读 md 的改动是三步闭环**：`approve` → 改 → `sync`。只做前两步时「有未落实的审批」本身就是红灯；反过来 `sync` 也不能替代许可——对只读文件 `sync --path` 没有许可会被拒。
- **本机路径与用户名不许进仓库**：公开仓库里出现 Windows 用户目录、`/Users/<真名>`、`<盘符>:\code\...` 一律是缺陷（体检 `[P]` 硬查）；兜底路径用环境变量或相对仓库根，找不到就明确报错。已经进过历史的，只有「镜像备份 → `filter-branch` 索引过滤 → 校验 → 强推」能清掉，且**所有 SHA 都会变**（文档里的短 SHA 必须按位置映射重写）。规则与事故记录见 agentmemory 记忆库 websurf/documents/norms/local-path-hygiene.md。
- **`git commit --amend` 会让已写进文档的 SHA 失效**：实测 5 处文档引用了被 amend 淘汰、不在任何 ref 上的提交。写 SHA 前先确认它在 ref 上（`git merge-base --is-ancestor <sha> main`）。
- **`.cmd` / `.bat` / `.ps1` 的每一行都要 CRLF**：用 Node 写文件会落 LF，`cmd.exe` 当场把命令行切错（报 `'RT' is not recognized`、中文标签被当命令跑）。仓库已加 `.gitattributes`（`text eol=crlf`）钉死检出形态；改完必须确认行尾，再用桩件实跑一次。

## 8. 文档 / 看板 / 锚点（2026-10 这几轮新增）

- **悬空待办号是硬门**：任何**制品**里出现的具体待办号（progress 条目、文档正文、`docflow sync --reason` 的说明）都必须能在 `TODO.md` 找到，否则体检 `[G]` 待办同源失败——**包括用来举例的号**。实测两次：在 progress 里引用了一个已被分卷移走的旧批次号、以及在 `sync --reason` 里先写新号后建行，都被拦。要引用历史批次就写文字描述，别写号。
- **加行 = 锚点行号变旧**：`docflow sync` 只按给定行号**重钉内容**，不会告诉你行号错了（体检只说「行内容已变」）⇒ 优先把改动压成 **1:1 行替换**（新增字段与相邻字段同行、加 `#[wasm_bindgen]` 导出用文件末尾独立 impl 块）；确实必须加行时，先按 `git diff -U0` 的 hunk 表把文档里的行号整体平移，再 `sync`。
- **只读 md 会被「锚点平移」顺带改到**：一次批量平移把根 `README.md`（只读）改进了「需审批」状态 ⇒ 平移脚本要**跳过只读集**；非改不可时改成「不改行数」的写法（只读三步闭环见 §7）。
- **认领的时序**：`claim` 之后必须真的改过 `must` 文件，`verify` 才通过；「先改后认领」同样过不了。做法：备份 `must` 文件 → 还原成 `HEAD` 版 → `release` + `claim` → 还原备份 → `verify`。
- **看板体量**：硬上限 96 KB（提前分卷线 80 KB）。超线时**逐行精简**（长判据/长证据转 `见详情`）可以自决；把「已记录 + 已结案」**迁入 agentmemory** 并把 ID 登记进 `progress/control-ids.json`，**必须先取 owner 许可**
- **记忆库文档没有「列全了没有」的门禁**：整理时自己跑一遍「原文归档树 ↔ 台账 marker」对照，并核对 `progress/memory-index.jsonl` 与 `progress/control-ids.json` 是否一致（体检 `check-memory-sync` 只查 sha 与缺口，不查覆盖）。
- **验 wasm-core 只能靠「重建 wasm + 探针」**：宿主 `cargo test/check -p websurf-wasm-core` 会因缺 `dlltool.exe` 失败；TS 探针用 `npx esbuild x.ts --bundle --format=esm --platform=node --outfile=x.mjs` 打包后再 `node` 跑（探针放 `.tmp/`，只打印不落盘也行）。
- **判据要落到「拓扑 / 语义」，不要只看位置**：实测一个网格的顶点位置全对、三角形却连错顶点（顶点数组展平顺序被转置）——用**浮点四舍五入的位置键**比对会产生大量假差异（f32 vs f64），要用**整数拓扑键**（如网格三元组）或与 SDK 规则逐项对齐。这类错肉眼只表现为「位置不对」，极易误判成别的问题。
- **Pages 站点会被「从分支构建」静默顶掉**：站点源一旦是「Deploy from a branch」，GitHub 内部 `pages-build-deployment` 会在**每次推送**（含纯文档推送）把仓库根按 Jekyll 发布 ⇒ 站点根被 README 渲染页顶掉（出现 `Jekyll v3.10.0` + `style.css?v=<sha>` 即中招），Actions 产物的 `/debug/`、`/game/`、`/viewer/`、`/version.json` 全 404。查源：`GET /repos/{owner}/{repo}/pages` 的 `build_type`（须为 `workflow`）；修：`PUT` 同路径 `{"build_type":"workflow"}`，再 `POST .../actions/workflows/<id>/dispatches` 重跑部署。**取证别只看仓库**——设置改动不在 git 里，要查浏览器历史与各 agent 日志（`~/.dsh/sessions/**` 是 zstd 压缩，先解压再搜）；取 token 用 `git credential fill`（PowerShell 管道，bash 下会挂）。
