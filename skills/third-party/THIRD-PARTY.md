# skills/third-party/ 下的第三方技能（vendored）

本目录（`skills/third-party/`）**只放上游技能**；本仓自建技能在上一层（`skills/websurf-workflow/`、`skills/websurf-env-traps/`、`skills/agentmemory-usage/`）。判据看是否在本文件的「官方技能清单」里：

| 类别 | 归属 | 可否改动 | 是否进记忆库 |
|---|---|---|---|
| **本项目技能**（上一层 `skills/`）`websurf-workflow`、`websurf-env-traps`、`agentmemory-usage` | 本仓自有 | 可改（`SKILL.md` 属只读类，走 `approve → 改 → sync`） | 进（台账有记录） |
| **官方技能** 下表 17 个 + `_shared/` | 上游 agentmemory | **原样复制**（唯一例外见「唯一的人工改动」） | 不进（见下） |

## 唯一的人工改动

上游示例里出现家目录绝对路径（`/Users/<user>/...` 这种字形），会触发本仓体检 `[P]`「本机路径」（公开仓库不得出现家目录名）。复制后把**用户名整段**换成占位符，其余路径保留：

```bash
# 只换用户名段；模式刻意写成 Users/<…> 的字形，避免本文件自身触发 [P]
git grep -l 'Users/' -- skills/third-party | xargs sed -i 's|Users/[A-Za-z0-9][A-Za-z0-9._-]*|Users/<user>|g'
```

实测改写 8 行 / 2 个文件（`handoff/EXAMPLES.md`、`recap/EXAMPLES.md`），其余 29 个文件与上游逐字节一致。**升包后必须重跑这一条**，否则 `check-doc-drift` 的 `[P]` 会红。

## 来源

- 上游：`rohitg00/agentmemory`（<https://github.com/rohitg00/agentmemory>）
- 包：`@agentmemory/agentmemory` **v0.9.30**
- 取件路径：`node_modules/@agentmemory/agentmemory/plugin/skills/`
- 许可证：**Apache-2.0**（上游仓库根 `LICENSE`；此处按 Apache-2.0 §4 保留来源与版本信息，未作任何修改）

## 官方技能清单（17）

| 技能 | 用途一句话 |
|---|---|
| `memory-discipline` | 会话循环：开工先召回、决策点即写、被纠正转 lesson |
| `remember` / `recall` / `forget` | 写入 / 检索 / 删除三个动作面 |
| `lesson` | 把纠正沉淀为带置信度的经验 |
| `recap` / `handoff` / `session-history` | 会话回顾、交接、时间线 |
| `commit-context` / `commit-history` | 提交与会话的互相追溯 |
| `agentmemory-config` | 配置、环境变量、端口、特性开关 |
| `agentmemory-mcp-tools` | MCP 工具索引与参数（含 `REFERENCE.md` 全表） |
| `agentmemory-rest-api` | HTTP 接口面（MCP 不可用时的兜底） |
| `agentmemory-architecture` | 存储模型、iii 引擎、viewer |
| `agentmemory-hooks` | 插件钩子与自动捕获 |
| `agentmemory-agents` | `connect` 适配器与宿主接线 |
| `write-agentmemory-skill` | 上游的技能撰写规范（house format，即本目录结构的依据） |

`_shared/TROUBLESHOOTING.md` 被多个官方技能的 `Troubleshooting` 节以 `../_shared/` 引用，**属同一整体，不可单独删**。

## 为什么原样复制、不进记忆库

- **不修改**：上游的事实表由生成器产出（`npm run skills:gen` / `skills:check`），手改会在下次复制时丢失，也失去与上游对比的能力。除上节那一条路径占位改写外，不做任何改动。
- **不进记忆库**：这是**工具自带文档**，不是本项目的工程知识。进库会与项目条目同池竞争召回，且它们随包更新，台账的 sha 会长期陈旧。

## 更新方法

升包后重放同一动作（官方技能文件不是只读类，无需审批）：

```bash
# 1) 升级 @agentmemory/agentmemory（见 AGENTS 附录 A 的 agentmemory 段）
# 2) 复刻：把 <pkg>/plugin/skills 逐文件复制到 skills/（保持 LF、不加 BOM、跳过 *.map）
# 3) 执行上节的 /Users/<user> 占位改写
# 4) 核对：逐字节比对 skills/<官方技能> 与 <pkg>/plugin/skills/<官方技能>，
#    差异应恰好等于第 3 步改写的行
# 5) 更新本文件的版本号，重跑四道门禁
```

项目技能的 `SKILL.md` 属只读类：改它们要先 `docflow.mjs approve --path skills/<名>/SKILL.md --by owner --reason ...`，改完再 `sync` 建立钉。
