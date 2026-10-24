# websurf-env-traps 细则

`SKILL.md` 给三条最贵的坑与作业流程，本文件放**完整陷阱表**。本文件不作事实来源；事实回源码、构建脚本与命令输出。

> 2026-10-18：旧看板（`progress/board.jsonl`）、`docflow`、记忆库同步门禁与 agentmemory 栈已删除。下文只保留仍然会撞的环境坑。

## 目录

| § | 主题 | 什么时候查 |
|---|---|---|
| 1 | 命令与取证据 | 跑命令、读输出、写文件前 |
| 2 | 生成物与本地物 | 判断「某文件/功能是否还在」前 |
| 3 | 沙箱边界 | 命令被拒、提权、跨进程取输出时 |
| 4 | git 与提交 | 提交前 |
| 5 | 判断「已完成 / 前提是否还在」 | 跑待办判据、结案前 |
| 6 | 本机工具与资源边界 | 用浏览器/技能/目录约定时 |
| 7 | 省 token 的作业方式 | 任何时候 |
| 8 | 改门禁 / 做注入验证时 | 改门禁、注入探针、A/B 验证时 |
| 9 | 其它实测教训 | wasm 验证、批处理、Pages 部署异常时 |
| 10 | GitHub 网络 | push/fetch/clone 连不上时 |

## 1. 命令与取证据（Windows / PowerShell）

| 坑 | 症状 | 做法 |
|---|---|---|
| pwsh 的 `>` 重定向写 UTF-16 | read 工具报 binary file | 用 Node `fs.writeFileSync` 落盘，或 `\| Out-File -Encoding utf8` |
| 把 git 塞进 `cmd /c "… & echo"` | 静默 exit 1、文件没生成 | 用 Node `execFileSync("git", [args])`——不经 shell，无引号/转义地狱 |
| 层层反斜杠转义 | 引号层数算错 | 路径在 Node 用正斜杠；参数走数组，不拼命令字符串 |
| `node 脚本 \| Select-Object -First N` | 上游进程被提前终止，退出码成 −1 | 先重定向到文件再读 |
| 脚本末尾 `exit` | 整个 pwsh 进程结束，汇总行丢失 | 脚本里不要 `exit`；判读改为过滤日志 |
| `Get-Content` 读中文 | 控制台按 GBK 解码 → 乱码 | 判读内容一律用 read 工具 |
| PowerShell 正则里的 `\s` | 吃掉行尾 `\r` → 变 bare LF | 行尾用 `[ \t]*` |
| `git status --porcelain` 不加 `-uall` | 未跟踪**目录**塌缩成一行 | 当文件清单用会读目录（`EISDIR`）⇒ 加 `-uall` |
| `git show "HEAD:<路径>"` 用反斜杠 | 参照集为空 → 假通过 | 必须正斜杠 |
| PowerShell 里 `try{…}catch{}` 挤成一行 | `The Try statement is missing its Catch or Finally block` | 必须多行；PS 5.1 一行式直接语法错 |
| `web_fetch` 直连 `raw.githubusercontent.com` | 30 s 超时 | 走代理：`Invoke-WebRequest -UseBasicParsing -Proxy $env:HTTPS_PROXY -OutFile …`（代理地址走环境变量，不写死） |

## 2. 生成物与本地物（不在 git 树上，≠ 不存在）

`git grep` / `git ls-files` 只覆盖**已跟踪**文件。以下都是生成物或本地物：

~~~text
dist/  pkg/  web/app.js  web/worker.js  **/web/*.wasm
test/maps/*  test/replay/*  .tmp/  .cargo-home/  .wasm-pack-cache/
apps/*/scripts/_*.mjs  .amh/  .dsh/
~~~

实例：`apps/viewer/dist/play.cmd` 不在树里，但它是**生成物**（生成器 `src/scripts/lib/dist-pack.mjs` 的 `distLaunchers`，由各工程 `scripts/build-dist.mjs` 调用写盘），不能据此把相关待办结案。

**做法**：判「某物是否还在」走**全工作区文件索引**（含未跟踪），不要用 `git grep` 的 0 命中下结论。

## 3. 沙箱边界

| # | 事实 | 规则 |
|---|---|---|
| 1 | 受限模式跑在 **ConstrainedLanguage**：`[System.IO.*]::`、`[math]::`、`Add-Type`、COM、反射一律报 only core types | 改用 cmdlet 与核心类型（`[string]` / `[regex]` / `[datetime]` / `[guid]`） |
| 2 | 受限模式下**程序不能开命名管道**：Node `child_process` 默认 `stdio:"pipe"` 抓别的程序输出会 `EPERM` | 这是**设计边界**，不要换写法重试——改 `stdio:"inherit"/"ignore"`，或用 PowerShell 自己的管道 |
| 3 | 沙箱拒绝形如 `[sandbox: file access denied under <mode>]` | 那是**策略拒绝**，不是路径写错 ⇒ 不要换路径重试；删除 `.git`、工作区外文件通常需要一次性提权 |
| 4 | **工作区写入模式并不等于可以删任何文件**：实测删除已跟踪文件会被拒 | 批量删除/提交用一次 `danger-full-access`，并在命令里先打印目标清单再删 |

## 4. git 与提交（本仓有并发 agent）

1. **提交前必跑 `git status --short`**：同一工作区常有另一个 agent 的在途改动。只 `git add` 自己改的文件；`OWNER.md` / `TODO.md` 常被双方同时改，**对方新增的行要原样保留**，不要回退，也不要写进自己的改动说明。
2. **绝不 `git checkout -- <文件>` 去「清干净」**：会直接抹掉未提交成果。
3. 行尾：`core.autocrlf=true` ⇒ 索引是 LF、工作树是 CRLF。不要顺手统一行尾。
4. **验证与提交串成一步、红灯即终止**（`&&` 式；`;` 式会让红灯也提交）。本仓已因此出过红灯提交。
5. 提交信息说清「改了什么 / 为什么 / 怎么验证」；纯格式/注释类改动写「无行为变化」。

## 5. 判断「已完成 / 前提是否还在」

1. **跑判据，不要看代码猜**：判据 = 可执行命令 + 期望输出，先跑它。
2. **判据本身可能指错路径**：实测 `T-126` 的判据写 `apps/viewer/src/renderer/panel.ts`，而该路径不存在 ⇒ 判据永远「满足」，会把条目**永久假结案**。跑之前先确认判据引用的路径存在。
3. **判据的 `-- <路径>` 可能指错目录**：实测 `T-129` / `T-132` 的判据搜 `apps/viewer/scripts`，而文件在 `apps/viewer/test/` ⇒ 判据永远 0 命中、两条被**假结案**。结案前必须用「证据」文件本身再复核一次该模式是否仍命中。
4. 结论必须落到 `文件:行号`；落不到就标 `[待确认]` 并说明缺什么。

## 6. 本机工具与资源边界

1. **没有 Chrome**：`archify` 的 browser-check 会 skipped。先设 `ARCHIFY_CHROME` 指向 `msedge.exe`（Edge 是 Chromium）。
2. **host 不自动发现仓库内 `skills/**`**：DSH 只扫 `<仓库>/.agents/skills`、`<仓库>/.dsh/skills`、`~/.agents/skills`、`<dshHome>/skills`。本机 `skills/websurf-env-traps` 已 junction 进 `~/.agents/skills/`；新机器要补这一条。⇒ **任何 agent 都必须读的东西，写进 `AGENTS.md` 指向的仓库文件**（不依赖某个工具的 skill 发现）。
3. 过程产物进 `.tmp/`（已 gitignore）；图表产物放 `.archify/`（已 gitignore）；AMH 项目侧接入放 `.amh/` / `.dsh/`（已 gitignore）。

## 7. 省 token 的作业方式

1. **一段程序做多件独立事**：把互不依赖的检查写进同一段 Node 程序跑完再打印摘要，比「一条一回合」省一个数量级。
2. **先机械判据筛，再人工判读**：grep / 存在性 / 计数先把候选集收窄，不要把上百条逐条进上下文。
3. **每步留可复跑的命令**，结论写进提交信息或代码注释，下一个人不用重推。

## 8. 改门禁 / 做注入验证时

1. **`applied=true` ≠ GLSL 编译通过**：注入探针只校验**字符串替换成功**。`vec3(1 / g)` 这种 int/float 混算会让 GLSL 编译失败、整块 prop 不渲染，而探针仍报「生效 387 / 失败 0」⇒ 判据必须落在**画面/像素统计**上（2026-10-11 T-649 实测，曾据此误报「已修复」）。
2. **改了 wasm 必须验证产物真的被用**：`copy-wasm-pkg.mjs` 曾多次没真正拷贝 ⇒ 连续几轮在旧 wasm 上测量。做法：比对 `.tmp/wasm-out/<app>` 与 `apps/*/pkg`、`apps/*/web` 的字节数/哈希，再跑探针。
3. **先量化再改，一次只动一个变量**：光照/渲染改动先做 baseline A/B（`git stash` → 基线 wasm → 同机位截图 → 逐像素差），再改一处、只看这一个变量（本仓出过「先改数据后看画面、方向错三轮」）。
4. **不要用 `node -e` 做多行源码替换**：`indexOf` 返回 -1 时 `slice(0,-1)` 会把文件拼成两份（实测把 `model_integrator/mod.rs` 拼到 2854 行、丢了 `map_coords` 等）。改 Rust/TS 一律用**可校验的编辑工具**（按行定位，改后跑 `node --check` / `cargo check`）。
5. **注入必须先断言「确实改了字节」**：探针的替换串没匹配上真行时，文件没变、门当然不响——会把「空转」误读成「机制不工作」。写完探针先比较改前改后字符串，不等就抛错。
6. **验证必须同时覆盖「该拦的」和「该放的」**：只测该拦的，会漏掉「权限/门禁过紧把正常工作锁死」这类错。

## 9. 其它实测教训

- **验 wasm-core 只能靠「重建 wasm + 探针」**：宿主 `cargo test/check -p websurf-wasm-core` 会因缺 `dlltool.exe` 失败；TS 探针用 `npx esbuild x.ts --bundle --format=esm --platform=node --outfile=x.mjs` 打包后再 `node` 跑（探针放 `.tmp/`）。
- **判据要落到「拓扑 / 语义」，不要只看位置**：实测一个网格的顶点位置全对、三角形却连错顶点（顶点数组展平顺序被转置）——用浮点四舍五入的位置键比对会产生大量假差异（f32 vs f64），要用**整数拓扑键**或与 SDK 规则逐项对齐。
- **Pages 站点会被「从分支构建」静默顶掉**：站点源一旦是「Deploy from a branch」，GitHub 内部的 `pages-build-deployment` 会在**每次推送**（含纯文档推送）把仓库根按 Jekyll 发布 ⇒ 站点根被 README 渲染页顶掉（出现 `Jekyll v3.10.0` + `style.css?v=<sha>` 即中招），Actions 产物的 `/debug/`、`/game/`、`/viewer/`、`/version.json` 全 404。查源：`GET /repos/{owner}/{repo}/pages` 的 `build_type`（须为 `workflow`）；修：`PUT` 同路径 `{"build_type":"workflow"}`，再 `POST .../actions/workflows/<id>/dispatches` 重跑部署。取证别只看仓库——设置改动不在 git 里，要查浏览器历史与各 agent 日志；取 token 用 `git credential fill`（PowerShell 管道，bash 下会挂）。
- **`.cmd` / `.bat` / `.ps1` 的每一行都要 CRLF**：用 Node 写文件会落 LF，`cmd.exe` 当场把命令行切错（报 `'RT' is not recognized`、中文标签被当命令跑）。仓库已加 `.gitattributes`（`text eol=crlf`）钉死检出形态；改完必须确认行尾，再用桩件实跑一次。
- **`chcp 65001` 的批处理保持纯 ASCII**：cmd 按块读取批处理并在 65001 代码页下做字节→UTF-16 转换，块内含多字节字符时下一块偏移记账错位，会把边界后的行**从中间当命令执行**（2026-10-24 实测：`apps/*/build.cmd` 中文横幅行横跨 512 字节块边界，下一行 `echo -^> TS ...` 被从 `-^>` 处当命令跑，报 `'->' is not recognized`；用文件前 695 字节重放逐行复现）。REM 注释行不豁免。修复 = 9 个脚本中文行改英文（commit `e646768`）；不要靠调行长避开边界。

## 10. GitHub 网络

直连不稳 → 先挂本机代理。`git push/fetch/clone` 报 `Connection was reset` / `Failed to connect to github.com:443` 时，不要以为没网——本机通常走 Clash，加代理即通；代理地址从 `HTTPS_PROXY` 环境变量取，不写进仓库：

~~~powershell
git -c http.proxy=$env:HTTPS_PROXY -c https.proxy=$env:HTTPS_PROXY push origin main
~~~

没有这个环境变量时，先按本机代理软件的实际地址设置 `HTTPS_PROXY` / `HTTP_PROXY`。实测：直连连续失败 7 次，挂代理第 1 次成功。
