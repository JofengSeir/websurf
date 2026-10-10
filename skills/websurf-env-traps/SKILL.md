---
name: websurf-env-traps
description: WebSurf 仓库在 Windows 下作业的环境与流程陷阱：长输出静默截断、生成物不在 git 树上、并发提交、判据假结案、沙箱边界、行尾与编码。当在本仓跑命令取证据、判断某功能是否已被删除、查证待办判据、或准备提交时使用。
user-invocable: false
---

本仓在 Windows + PowerShell 下作业，agent 反复撞同一批墙（假绿、假「功能已删」、编码与行尾、输出被截断、沙箱边界），每次都要花 token 重新发现一遍。本技能让这批墙只撞一次。

边界：本技能讲「怎么干活不撞墙」，**不是事实来源**；待办与状态只在根 `progress/board.jsonl`。

## Quick start

任何改动提交前：

```bash
node src/scripts/check-doc-drift.mjs          # A–P 全 0
node src/scripts/check-memory-sync.mjs        # stale/orphan/missing/leak 全 0
```

三条最贵的坑，只看这三条也值：

1. **长输出会被截断成「尾部」**，直接解析 stdout 会静默拿到残缺集合，据此下的结论全错。
2. **「文件不在树上」不等于「功能已删除」** —— `git grep` / `git ls-files` 只覆盖已跟踪文件。
3. **basename 存在性检查会批量假阴性** —— 正则分支里 `js` 会先于 `json` 命中，把 `package.json` 切成 `package.js`。

## Why

这十类坑的共性：**失败时不报错，只给出一个看起来合理的错答案**。截断的输出像完整输出，`git grep` 的 0 命中像「已删除」，`existsSync` 的 false 像「文件不存在」。所以本仓的规矩是**先断言规模、再判读内容**，而不是拿到结果就用。

## Workflow

1. **跑命令取证据**：大输出用 Node 写文件再读（`execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64*1024*1024 })`），并**先断言规模**（如 `git rev-list --count HEAD`）再看内容。同一段程序做多件互不依赖的事，比一条一回合省一个数量级。
2. **判断「某物是否还在」**：走**全工作区文件索引**（含未跟踪），不要用 `git grep` 的 0 命中下结论；已知的生成物与本地物清单见 REFERENCE §2。
3. **跑待办判据**：先确认判据引用的路径真的存在，再用「证据」文件本身复核该模式是否仍命中。判据本身可能指错路径或指错目录，会把条目**永久假结案**。
4. **准备提交**：`git status --short` 看有没有别人的在途改动，只 `git add` 自己的文件；体检与提交串成一步（`&&`），红灯即终止。
5. **改门禁或做注入验证时**：先断言「确实改了字节」，再断言该拦的拦住了、**该放行的仍放行**。

## Anti-patterns

WRONG：`git grep "某函数"` 返回 0 命中，就把待办结案说「功能已删除」。

RIGHT：先查该物是否属生成物或本地物，再用全工作区索引（含未跟踪）复核。

WRONG：`existsSync('package.json')` 为 false 就认为文件不存在。

RIGHT：用「全仓 basename → 路径表」判定，或让正则分支**最长后缀优先**（`d\.ts|json|mts|mjs|cjs|ts|js|rs|md|cmd`）。

WRONG：把体检和提交写成 `;` 连接，红灯照样提交。

RIGHT：写成 `&&`，红灯即终止。

WRONG：为了让体检变绿而对只读文件直接 `sync`。

RIGHT：只读 md 走 `approve → 改 → sync` 三步；锚点真有变化时 `--reason` 必填。

## Checklist

- 大输出先断言了规模，再判读内容。
- 判「存在性」用的是全工作区索引或 basename 表，不是 `git grep`。
- 提交前列过 `git status --short`，`progress/board.jsonl` / `OWNER.md` 里别人的行原样保留。
- 没有用 `git checkout -- <文件>` 清理工作区。
- 改了 `.cmd` / `.bat` / `.ps1` 时确认过行尾是 CRLF，并实跑过一次。
- 结论落到了 `文件:行号`；落不到就标 `[待确认]` 并停下上报。

## See also

- `websurf-workflow`：一轮工作流的循环骨架。
- `agentmemory-rest-api`：MCP 不可用时的 HTTP 读路径（官方技能）。

## Reference

命令与取证据、沙箱边界、git 与提交、判据复核、本机工具边界、省 token 作业方式、门禁与锚点、GitHub 网络：见 REFERENCE.md。
