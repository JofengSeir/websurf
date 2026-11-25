---
name: websurf-env-traps
description: WebSurf 仓库在 Windows 下作业的环境与流程陷阱：长输出静默截断、生成物不在 git 树上、PowerShell 5.1 无 && 与 UTF-8 BOM、Rust msvc/离线缓存、沙箱边界、并发提交。当在本仓跑命令取证据、判断某功能是否还在、或准备提交时使用。
user-invocable: false
---

本技能收集 WebSurf 仓库（Windows + PowerShell 5.1）反复撞过的墙：假绿、假「功能已删」、编码与行尾、输出截断、工具链陷阱与沙箱边界。目标：每堵墙只撞一次。

**边界**：本技能只讲「怎么干活不撞墙」，**不是事实来源**；事实回源码、构建脚本与命令输出。

## 1. Quick start（开工四条命令）

```powershell
git status --short -uall     # 看有没有别人的在途改动
npm run dev:check            # 查三端产物完整性、mtime 过期与端口占用
npm run verify:fast          # TS 三端 typecheck + test:ts + 源码/着色器/配置门禁
node --check <脚本>          # 改完 JS/MJS：先做语法检查
```

## 2. 五条最贵的坑

| # | 坑 | 后果 | 规避 |
|---|---|---|---|
| 1 | 长输出被**静默截断成「尾部」** | 直接解析 stdout 拿到残缺集合，结论全错 | 大输出先落盘（`.tmp/*.log`）再读；**先断言规模再判读内容** |
| 2 | 「不在 `git grep` 里」≠「已删除」 | `git grep` / `git ls-files` 只覆盖已跟踪文件 | 判存在性走**全工作区索引**（含未跟踪生成物，见 `REFERENCE.md` §2） |
| 3 | basename 存在性正则短后缀抢匹配 | `js` 先于 `json` 命中，把 `package.json` 切成 `package.js` | 正则**最长后缀优先**：`d\.ts|json|mts|mjs|cjs|ts|js|rs|md|cmd` |
| 4 | PowerShell 5.1 无 `&&` 且易写 BOM/GBK | 用 `;` 串联让红灯继续提交；`>` / `Set-Content` 写坏文件 | 多步校验统一跑 `npm run verify:fast|rust|ts|full`；改文件用编辑工具或 Node `utf8` |
| 5 | Windows 默认 `gnu` 缺 `dlltool.exe` + 离线 `wasm-pack` 断网 | 为跑 `wasm-core` 单测去魔改 `~/.cargo/registry` 搞坏环境 | `websurf-wasm-core` 切 `+stable-x86_64-pc-windows-msvc`；直接跑 `npm run verify:rust|full` 自动适配 |

## 3. 为什么是这些坑

共性：**失败时不立刻显式报错，而是给一个看似合理的假结果**——截断输出像完整输出、`git grep` 0 命中像已删除、跳过校验的 `;` 像全绿通过、旧 `app.js`/`worker.js` 像最新构建。因此本仓铁律是**先断言规模/版本，再判读内容；先跑统一验证器，再提交**。

## 4. 作业流程（按场景）

1. **跑命令取证据**：大输出落盘后用读文件工具查看（或 Node `execFileSync` 配大 `maxBuffer`），先核对总数再读细节；互不依赖的只读检查合并进一个临时 `.mjs` 脚本一次跑完。
2. **判「某物是否还在」**：用 `Select-String` 或全工作区索引（含未跟踪目录）；本机未装 `rg`，仓库内检索用 `git grep -n`。
3. **跑待办 / 验收判据**：先确认目标路径真实存在且测试有正反控，避免空文件/错目录导致的永久假结案。
4. **验证与提交**：
   - 运行对应档位：`npm run verify:fast` / `verify:rust` / `verify:ts` / `verify:full`（内置红灯即停）；
   - `git status --short -uall` → 只 `git add -- <自己改的文件>` → `git commit`（D-124 `pre-commit` 会机械拦截 `main` 提交、生成物、UTF-8 BOM、`.cmd/.bat/.ps1` 非 CRLF/非 ASCII）。
5. **改门禁 / 做注入验证**：先断言「确实改了字节」，再同时测**该拦的真拦住**与**该放行的真放行**。

## 5. 对错示例

| WRONG | RIGHT |
|---|---|
| `git grep "某函数"` 0 命中 ⇒ 结案已删 | 检查是否属生成物/本地物，用全工作区索引复核 |
| 在 PowerShell 5.1 用 `;` 拼检验和提交命令 | 跑 `npm run verify:ts` 或 `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` |
| 在 `~/.cargo/registry` 改 `windows-sys` 凑合过 `gnu` | 切 `+stable-x86_64-pc-windows-msvc` 或跑 `npm run verify:rust` |
| 用 `rg` 命令或复杂单行 `node -e "..."` | 仓内搜用 `git grep`；复杂 JS 先写 `.tmp/*.mjs` 再 `node` |
| `node_modules/.bin` 或手编 `app.js` 跳过 `worker.js` | 用 `npm run build:ts` / `build:app`；起服前看 `npm run dev:check` `STALE` 提醒 |

## 6. 收尾 checklist

- [ ] 大输出：先落盘并断言规模，再判读内容。
- [ ] 存在性判断：用全工作区索引，不靠 `git grep` 0 命中下结论。
- [ ] 提交前跑过 `git status --short -uall` 与 `npm run verify:*`，只暂存自己改动。
- [ ] 未使用 `git checkout -- <file>`、`--no-verify` 或 `PRECHECK_BYPASS=1` 绕过门禁。
- [ ] 源码/JSON 无 UTF-8 BOM；改过 `.cmd/.bat/.ps1` 保持 CRLF + 纯 ASCII 并实跑。
- [ ] 结论与修改均落到精确的 `文件:行号`，不编造未核实状态。

## 7. See also

- [AGENTS.md](../../AGENTS.md)：仓库地图、构建与一键验证入口、提交红线、`§8` 元规则。
- [websurf-handoff SKILL.md](../websurf-handoff/SKILL.md)：多卡委派 / 跨模型接力规范（日常单卡小修跳过）。
- [REFERENCE.md](./REFERENCE.md)：完整陷阱明细表（§1–§10）。
- 本地 `TODO.md` / `OWNER.md`（gitignore）：未结工作与待拍板决定（都不是门禁）。
