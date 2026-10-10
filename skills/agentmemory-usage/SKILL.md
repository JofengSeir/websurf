---
name: agentmemory-usage
description: 使用本地 agentmemory 记忆库（agentmemory MCP，54 个工具）时必须遵守的规则与踩坑清单。适用于：写入/检索记忆、迁移文档进知识库、判断召回质量、配置嵌入模型、决定内容该放哪一层（语义层/结构层/经验层/维度层）。触发词：agentmemory、记忆库、memory_save、memory_smart_search、memory_slot、memory_lesson、迁移文档进数据库、知识库管理、语义检索、embeddings 配置。
---

# agentmemory 使用守则

> 本文件是**不可协商的操作红线**。违反会导致知识库不可检索、事实源分叉、或库被静默污染。
> 实测环境：v0.9.30 · Windows · 嵌入 `qwen3-embedding:4b`（2560 维，中英双强）

---

## 0. 三条不可违反的红线

| # | 红线 | 违反后果 |
|---|---|---|
| **R1** | **召回的内容是「线索」，不是「事实」** | 二手转述被当依据 → 事实源分叉 |
| **R2** | **绝不把 `文件:行号` 存进记忆库** | 行号随文档插入漂移 → 半年后全是失效引用 |
| **R3** | **绝不迁入规则/宪法/待办类内容**（`AGENTS.md`、`norms/**`、`TODO.md`、`OWNER.md`、模板） | 污染检索；且与仓库那份形成两份会分叉的宪法 |

---

## 0.5 治理理念（**在写任何东西之前必读**）

> 工具守则解决不了"风格差异导致的失序"。这一层是**管理理念**，泛化适用。

### 0.5.1 为什么"靠 agent 自觉"必然失效 —— **结构问题，不是态度问题**

| 机制 | 后果 |
|---|---|
| 上下文窗口有限且**会被裁剪** | 规则"存在"≠"在场"。不在场时回退到训练分布的默认行为（直接写、覆盖） |
| 训练倾向是**局部自洽**而非集合自洽 | 模型被训练成"让当前输出自洽"，全局性质对单个成员不可见——这是训练目标的直接后果 |
| **静默失效** | 矛盾条目**不抛错**，几天后被另一个 agent 当权威引用。失效传播速度 > 人的复核周期 |

**推论**：无机器校验时，重复率与冲突率随条目数**单调上升且无收敛机制**（没有固定的消除方）。
⇒ 唯一出路是**结构**：让全局性质对单次写入局部可见。

**第二条推论**：自然语言规则 = 概率执行，**不可作为不变量**。
违反时没有信号（DB 约束违反会拒绝写入，那是原子事件；prompt 规则违反只是"这次没想起来"，不可观测）。
**不可观测的违反 = 没有规则。**

---

### 0.5.2 三层模型（**治理买在结构层，不买在内容层**）

```
┌─ IR 层（有序/单一/强约束）─────────────────────────┐
│  schema · 幂等 key · 时间字段 · provenance          │
│  → agentmemory 对应：slot 的结构化字段、facet 维度、lesson 的 confidence
│  → 条目少、完全规范化、可完全校验                    │
├─ 表述层（多样/自由/零约束）────────────────────────┤
│  自然语言内容与组织方式                             │
│  → 对应：memory_save 的正文                         │
├─ 派生层（多样/可重建/延迟一致）────────────────────┤
│  索引 · 摘要 · embedding · 归并结果                 │
│  → 对应：BM25 索引 + 向量索引                       │
└──────────────────────────────────────────────────┘
```

**判据一句话**：
> **能从源头重算出来的是派生，不能重算的是真相。**
> 约束只加在真相层；派生层允许脏、允许延迟一致、允许整体重建。

**为什么需要中间层**：任意两个 agent 互读需要 O(N²) 个适配；经规范化层只需 O(N) 写适配器 + O(N) 读适配器。
更重要的是——它把语义分歧从"运行时才发现"降级为"**写入时一次性仲裁**"。

---

### 0.5.3 五条硬原则（少而硬，逐条可判定）

| # | 原则 | 可判定判据 | 执行时点 |
|---|---|---|---|
| **G1** | **单一写入通道 + fail-closed** | 不存在绕过校验器的写入路径；schema 字段缺一即**拒写** | 写入时 |
| **G2** | **写入粒度 = 治理粒度** | 一个 slot/key 里只放**一个可独立替换删除的完整断言**；能无损拆分的**违规** | 写入时 |
| **G3** | **结构化幂等键 + upsert** | `key = hash(canonical(subject)+predicate)`；同 key 存活条目**恒为 1** | 写入时 |
| **G4** | **只追加 + 冲突前置判定** | 同 key 不同 object 即**冲突，拒绝并返回双方**；任一时刻库为合法状态 | 写入时 |
| **G5** | **真相/派生分离 + 过期默认不可见** | 删掉派生层后能一条命令完全重建；默认检索结果中过期条目数**恒为 0** | 写入 + 周期 |

**优先级**：G1 > G2 > G4 > G3 > G5。**G1/G2 不可协商。**

---

### 0.5.4 G2 为什么最容易被忽略却最关键

> **一次写入覆盖了什么，就等于一次治理能移除什么。**

因为 slot 的读/写/覆盖/删除**唯一地址是 label**（无 entry 级寻址），所以：

- 一个 slot 里塞了多个断言 ⇒ 覆盖其中一个必须连带覆盖其余
- ⇒ **不可逆、无法分辨作者、无法事后审计**
- 被忽略时，团队会自然地"按内容组织"而非"按可独立治理单元组织"
- ⇒ 库在几个月内退化成**不可清理的堆积物**，并连带制造粒度漂移与"不敢删"的心理负担

**配套**：**无版本即无追责，无追责就必须单写者**——在只有操作级日志的条件下，
把写权限收敛到唯一 owner，是把不可追溯的破坏风险**前置到唯一可控的点**。

---

### 0.5.5 分层准入矩阵

| 内容类型 | 允许层 | 禁止 | 时效策略 |
|---|---|---|---|
| 跨 agent 共用的**确定事实/契约** | 结构层 slot | 语义层不得作唯一副本 | 替换前先存影子值 |
| 可迁移的**判断与做法** | 经验层 lesson | 不得复制进 slot 当规范 | 用进废退 + `minConfidence` |
| **一次性过程/草稿/假设** | 语义层（短期） | ❌ 禁止写入 slot / lesson / pinned | 不治理，靠"不升级"处理 |
| 分类与状态 | facet 维度值 | ❌ 禁止塞入正文 | 受控词表 |

---

### 0.5.6 冲突消解（**无版本机制下的唯一可行解**）

1. **不覆盖先删除**：任何 `slot_replace` 前，旧值先写入影子 slot `<label>__prev`，读侧默认忽略
2. **提案-合并**：非 owner 发现冲突用 `memory_signal_send` 发给 owner（附证据）。**假设永远不能自动升级为事实**
3. **不可判定的矛盾显式化**：两条都保留 + 各打 `status=disputed` facet，交审查者用 `memory_verify` 裁决
   ⚠️ **禁止"时间戳最新者胜"**——无版本机制下"最新"根本不可信
4. **经验层天然容忍重复**：同内容重复保存自动增信 ⇒ **允许两个 agent 各自学到的同一经验并存**，由 confidence 收敛
   —— **这是唯一可以"多写"的层**

---

### 0.5.7 单一写入者 vs 共享写入 → **事实层共享写入，裁决单写**

- **完全单写**不可实现：agent"写记忆"与"做任务"是同一进程同一时刻，无法分离；强制分离等于让所有 agent 向中心上报，中心本身成单点
- **完全共享** = 上面 0.5.1 的失效论证
- **现实解**：并发写允许，但"**谁覆盖谁**"由确定性规则裁决，不由任何 agent 自由裁量
- **这正是编译器的答案**：多个前端都能写，但都必须经同一个后端 emit
  ——**多样性留在"如何表达"，单一性强制在"如何落地"**

---

### 0.5.8 粒度一致性该不该强制 → **不强制统一，但强制可判定**

若强制"一条 = 一个不可再分的原子命题"：
- agent 只有检索视图、没有全局视野，拆分质量无保证
- **没有任何校验器能判定一条自然语言断言是否原子** → 强制粒度 = 强制不可判定约束 = 退回靠自觉
- 二阶代价更致命：粒度强制诱发**拆分膨胀**（一条写成 5 条互相重复的半命题）
  ⇒ 条目数↑而信息量不↑ ⇒ 检索噪声↑ ⇒ 回到 0.5.1 —— **是个负反馈**

**替代**：强制声明 `type`（observation/decision/preference/procedure/fact）与 `scope`，
type 内粒度自由；**多样性放在派生层，不放真相层**。

> **一致性只施加在可判定维度（字段完整性、key 唯一性、时间有效性），
> 不施加在不可判定维度（命题原子性、表述风格）。**

---

### 0.5.9 过期如何被系统性发现（不靠"人记得清理"）

1. **时间是必填字段**，不是约定
2. **过期 = 默认检索视图不可见 + 显式标记**，而不是删除（同时解决"不能自动删"与"不能被读到"）
3. **写入时同一次调用内必须回答**"这条是否冲突、或使旧条目过期"
   ⇒ 把清理从"事后 N 次巡检"降到"**每次写入 O(1)**"
4. 降级优先于删除：`memory_governance_delete` **仅用于两类明确垃圾**——私货（中间推理入库）与违反 G2 的超原子 slot

---

### 0.5.10 反面清单（**过度治理的代价**）

| 不做 | 原因 |
|---|---|
| ❌ 全量版本历史 | 无 entry 级版本设施，维护成本 ≫ 收益；只保留影子 slot 这一个回滚点 |
| ❌ 追求 100% 去重 | 语义层近重复是**特性不是 bug**；强行去重会误杀有效变体。**只在 slot/lesson 层去重** |
| ❌ 把所有知识塞进 slot | slot 是强一致但高成本结构，只给"多方共用的确定事实"。否则 label 体系瞬间腐化 |
| ❌ 用相似度分数做存在性/删除判定 | 阈值随表述漂移，不可判定 |
| ❌ 自由扩展 facet 维度词表 | 值域开放会漂移；新增需显式登记，否则聚合查询失效 |
| ❌ 给过程性内容做生命周期治理 | 过程内容应该"**不进长期层**"，而不是"进去后再治理" |
| ❌ 引入外部 sidecar 存元数据 | 无 HTTP 接口，跨进程一致性不可验证；元数据必须落在同一套设施内 |
| ❌ 全局写锁串行化 | 吞吐与复杂度爆炸；用 owner 单写 + 治理期局部互斥 |

---

### 0.5.11 责任划分（**没有角色就会失序**）

| 角色 | 职责 | 不负责 |
|---|---|---|
| **写入者** | 自检类型与粒度；非 owner 只提案 | 直接改他人 slot |
| **owner**（写入者中的固定角色） | 裁决冲突、执行替换、承担事实正确性 | 忽略提案 |
| **审查者** | 配额、stale 巡检、disputed 裁决、垃圾清理 | 替他人写内容 |
| **消费者** | 只读 + 结构化反馈 | 直接落长期层 |

⚠️ **「责任真空」是最容易被忽略的失效源**：所有 agent 都只做**加法**，
没有任何角色负责**收敛** ⇒ 库单调膨胀，而 top-k 检索会让"最新、最多、最不精确"的条目天然占优。
**必须显式指定 owner，否则以上五条原则无人执行。**

| 层 | 工具 | 装什么 | 关键特性 |
|---|---|---|---|
| **语义线索层** | `memory_save` / `memory_recall` / `memory_smart_search` | 文档摘要索引 | 模糊召回（BM25+向量混合） |
| **结构层** | `memory_slot_*`（6 个） | **少量**结构化元数据 | 按 label **精确读取**；`pinned` 会每轮注入 |
| **经验层** | `memory_lesson_*`（3 个） | 带 `confidence` 的经验 | confidence **用进废退**；同内容重复保存自动增信 |
| **维度层** | `memory_facet_tag` / `memory_facet_query` | `维度:值` 标签 | 支持 **AND/OR** 查询 |

**另有**：`memory_graph_query` / `memory_relations`（知识图谱）、`memory_action_*`（任务编排）、
`memory_signal_send/read`（agent 间消息）、`memory_lease`（防抢占锁）、`memory_audit`、
`memory_verify`（溯源）、`memory_diagnose` / `memory_heal`、`memory_obsidian_export`。

---

## 2. 🚨 检索分数完全不可用于判定存在性

**实测（这是最容易踩的坑）**：

| 查询 | 命中数 | 分数 |
|---|---:|---|
| 无意义串 `zzzzqqqqxxxx` | **3（全返回）** | 1.000 / 0.984 / 0.968 |
| **不存在的 marker** `9999zzzz8888` | **3（全返回）** | **1.000/0.984/0.968 ← 与无意义串逐位相同** |
| 真实存在的 marker | 3 | **1.050** ← 正确条目升第一，其余 0.59 |

⇒ **分数和命中数都不能判定存在性。**

### ✅ 正确的幂等查重

```js
const marker = `${source}#${kind}${seq}@${sha12}`;   // 高熵唯一串
const res = await memory_smart_search({ query: marker });

// ✅ 必须遍历内容断言 marker 精确出现
const exists = res.results.some(r => String(r.content || '').includes(marker));

// ❌ 错：用分数判定
const exists = res.results[0]?.score > 0.9;
// ❌ 错：用命中数判定
const exists = res.results.length > 0;
```

**唯一权威是 append-only 台账**（`progress.jsonl`），`smart_search` 只作交叉验证。

---

## 3. marker 格式（幂等的核心）

```
<相对路径>#<kind前缀><序号>@<源文件 sha256 前12位>
```

**妙处**：源文件一变 ⇒ marker 变 ⇒ **自动判 stale，而不是误判重复**。

例：agentmemory 记忆库 websurf/<相对路径>#chunk0@<sha12>

---

## 4. 内容写法（红线 R1/R2 的落地）

### ✅ 正确：只写「主题 + 符号名 + 路径」

```
[线索] websurf/<相对路径>#chunk0@<sha12>
主题：viewer 工程渲染器实现。符号 Renderer / RenderPass / WebGPU 管线。
路径：<源相对路径>（第 1/3 段）
```

### ❌ 错误示例与原因

| 反例 | 为什么错 |
|---|---|
| `viewer 的 fog 参数必须与 game 端一致，否则偏色` | **是结论**，未核到代码 ⇒ 违反 B3 禁推测 |
| `见 renderer 第 120-145 行` | **行号会漂移** ⇒ 违反 R2 |
| `应该/可能/大概/历史上` | 推测措辞，必须拦截 |
| 任何以"规则是…"开头的内容 | 规则属指令不是知识 ⇒ 违反 R3 |

**写前必过校验器**：
```js
const FORBIDDEN = /应该|可能|大概是|历史上/;
if (FORBIDDEN.test(content)) throw new Error('推测措辞');
if (/:\d+[-–]\d+/.test(content))  throw new Error('不得存行号');
if (!content.includes(marker))   throw new Error('缺 marker');
```

---

## 5. 🚨 配置踩坑（三个都是实测踩过的）

### 5.1 `OPENAI_EMBEDDING_BASE_URL` **绝对不能带 `/v1`**

`buildEmbeddingUrl()` 会**无条件拼接 `/v1/embeddings`**。带了 `/v1` 就变成
`/v1/v1/embeddings` → **404 被静默吞掉**，表现为"搜索退化成关键词、毫无报错"。

```ini
# ✅ 对
OPENAI_EMBEDDING_BASE_URL=http://localhost:11434
# ❌ 错（会静默 404）
OPENAI_EMBEDDING_BASE_URL=http://localhost:11434/v1
```

### 5.2 必须同时设 `OPENAI_API_KEY`

`openai` 分支**硬编码读 `OPENAI_API_KEY`**，会绕过 `OPENAI_EMBEDDING_API_KEY`（issue #1119）。
用本地 Ollama 时它是占位值。

```ini
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=ollama
OPENAI_API_KEY_FOR_LLM=false
OPENAI_EMBEDDING_MODEL=qwen3-embedding:4b
OPENAI_EMBEDDING_DIMENSIONS=2560
```

### 5.3 slots 默认是**关**的

```ini
AGENTMEMORY_SLOTS=true    # 不设则所有 memory_slot_* 报 500
```

**标签命名规则**：`[a-z0-9_]` 且**以字母开头**，**连字符 `-` 不合法**。
（`websurf-norms` ❌ / `websurf_norms` ✅）

---

## 6. 🚨 `status` 显示 `bm25-only` 是已知 bug，不要相信

`agentmemory status` 会**永远**打印 `bm25-only`（issue #1488）——CLI 把服务端返回值
与字面量 `"embeddings"` 比较，而服务端从不返回该值。

### ✅ 权威判断方式

```bash
TOKEN=$(cat ~/.agentmemory/secret)
# 嵌入是否配置
curl -s -H "Authorization: Bearer $TOKEN" \
  localhost:3111/agentmemory/config/flags | head -c 80
# → {"embeddingProvider":"openai (2560 dims)",...}   ← 这样才算真的开了

# 向量是否入库
curl -s -H "Authorization: Bearer $TOKEN" \
  localhost:3111/agentmemory/status
# → "vectorDocuments": N, "pendingVectorBackfill": 0   ← N>0 且 backfill=0 才算真入库
```

---

## 7. 🚨 记忆库没有 pin / 版本机制

实测：`entryVersion` / `memoryVersion` / `revision` / `pinnedAt` **全部 0 次出现**。
`memory_audit` 只有**操作级日志**（operation / targetIds / before-after / timestamp），
`memory_export` 有 `exportedAt` 但**无逐条版本**。

⇒ **唯一可行的"钉"手段**：
1. 条目里存**内容 sha12**（不存行号）
2. 仓库侧存 manifest（**入库**，不要放 `.tmp/`）
3. 外部脚本比对 sha ⇒ 变了即 `stale`

⚠️ **别造第三套哈希**：raw 字节哈希 ≠ LF 归一哈希。
如果仓库已有 pin 机制（如 `docflow.json` 的 `pins` 用 LF 归一），**复用它**。

---

## 8. 🚨 没有 HTTP 入口，只能用 MCP 工具

实测 25+ 路径全 404（`/mcp`、`/api/memory/*`、`/rest/*`、`/openapi.json`…），
`config/iii-http.yaml` 只有 host/port/cors，**无路由表**。

⇒ **所有验收判据必须写成 MCP `memory_*` 工具调用，不能写 curl**。
（curl 仅用于读 `/agentmemory/config/flags` 和 `/agentmemory/status` 这两个裸 REST 端点）

---

## 9. 检索质量的已知缺陷：跨工程同名

同名文件在不同子树下会互相串台。实测同名族
`input.md` / `renderer.md` / `ui.md` / `wasm*.md` rank-1 命中仅 **13/20**。

⇒ **必须先声明作用域再检索**，并校验结果 `source` 前缀：
```js
const res = await memory_smart_search({ query: `${工程名} ${query}` });
const ok = res.results.filter(r => r.content.includes(`/${工程名}/`));
```

---

## 10. 默认关闭的功能（别以为坏了）

| 环境变量 | 默认 | 开启后 |
|---|---|---|
| `AGENTMEMORY_SLOTS` | 关 | `memory_slot_*` 可用 |
| `AGENTMEMORY_REFLECT` | 关 | `memory_reflect`（**依赖 SLOTS**） |
| `AGENTMEMORY_AUTO_COMPRESS` | 关 | LLM 压缩（需 LLM key） |
| `GRAPH_EXTRACTION_ENABLED` | 关 | 知识图谱抽取（需 LLM key） |
| `CONSOLIDATION_ENABLED` | 关 | 四层固化（需 LLM key） |
| `AGENTMEMORY_INJECT_CONTEXT` | 关 | 会话内上下文注入 |
| `AGENTMEMORY_TOOLS` | `all`(54) | `core` = 只暴露 8 个 |

**没有 LLM key 时是 zero-LLM 模式**：压缩/摘要/consolidation/reflection 全部不可用，
但嵌入检索是活的。

---

## 11. 绝对不要用

| 工具 | 为什么 |
|---|---|
| **`memory_compress_file`** | ⚠️ **会写回原文件**。若目标仓库有只读钉（docflow/pin），误用一次就写坏锚点 |
| `memory_governance_delete` | 批量删记忆库内容前必须先确认备份 |

若必须读盘，`AGENTMEMORY_IMPORT_ROOT` **只给到确需的叶子目录**，
**绝不要给仓库根**（否则等于绕过"规则类不迁"的策略）。

---

## 12. 操作检查清单

### 写入前
- [ ] 内容只含「主题 + 符号名 + 路径」，无结论、无行号
- [ ] 无「应该/可能/大概/历史上」
- [ ] 带 `[线索]` 前缀
- [ ] 带唯一 marker `<路径>#<序号>@<sha12>`
- [ ] 已查台账确认不是重复（或确认是真 stale 需重迁）

### 写入后
- [ ] `progress.jsonl` 已 append（append-only，不覆盖）
- [ ] `vectorDocuments` 计数已增加
- [ ] `pendingVectorBackfill == 0`

### 定期体检
- [ ] 台账里全部 marker 的 sha12 与磁盘文件比对 ⇒ `stale=0`
- [ ] 台账有、磁盘无 ⇒ `orphan`（须已备份并登记）
- [ ] 磁盘在库 md、台账无 ⇒ `missing`（漏迁）
- [ ] 检索质量回归（同名族 rank-1 达标）

---

## 14. ⚠️ 项目隔离：**单实例共享库，没有自动隔离**

多 agent / 多项目共用同一个 agentmemory 实例时，**实测隔离能力不足**：

| 工具 | 有 `project` 参数？ |
|---|---|
| `memory_save` / `memory_lesson_save` / `memory_lesson_recall` / `memory_profile` / `memory_timeline` | ✅ 能打标 / 过滤 |
| **`memory_smart_search`** | ❌ **没有** |
| **`memory_recall`** | ❌ **没有** |
| **`memory_slot_get`** | ❌ **只有 `label`，无 scope 过滤** |
| **`memory_facet_query`** | ❌ **只有 dimension 匹配，无 project 维度** |

⇒ **写入能打 project 标，但语义检索与 slot 读取都无法按项目过滤。**
多项目共用时会**跨项目召回**。四道手动隔离闸（**第一个项目迁入时就要建**）：

| # | 闸 | 做法 |
|---|---|---|
| **I1** | marker 带项目前缀 | `<project>/<相对路径>#<序号>@<sha12>` |
| **I2** | 每条强制打 project 维度 | `memory_facet_tag(dimension="project", value="<slug>", targetId=<marker>, targetType="memory")` |
| **I3** | slot label 带项目前缀 | ✅ 用 `websurf_norms` 而非 `norms`；**绝不用 `persona`/`guidance` 这类通用名做项目专属 slot** |
| **I4** | 检索词强制带项目名 | 查 A 项目就用 `A <query>`，并**校验结果的 `source` 前缀** |

**体检必须含**：`cross_project_leak = 0`（检索结果里 source 不属当前项目的条数）

---

## 15. 启动与生命周期

```bash
# 完整启动（dsh + 记忆栈）
用桌面 dsh-web.cmd（自动拉起 Ollama + agentmemory）

# 仅记忆栈
Desktop\dsh-memory.cmd        # Ollama + agentmemory，不起 dsh

# 停止
node node_modules/@agentmemory/agentmemory/dist/cli.mjs stop   # 在 agentmemory 目录
```

- 配置在 `~/.agentmemory/.env`（245 行，改完**必须重启**才生效）
- 数据默认在 `~/.agentmemory/data`，可用 `--data-dir` 或 `AGENTMEMORY_DATA_DIR` 改
- **归零** = 停服务 → 挪走 `data/` → 建空目录 → 重启（配置在 `.env` 里，不会丢）
- 重启后 API 有**短暂未就绪期**（端口已监听但 `/agentmemory/config/flags` 仍 404），**轮询到 200 才算可用**

---

## 16. 🚨 判定「某条是否在库里」的唯一可靠办法（实测，v0.9.30）

> 这一节是本仓 2026-10-10 连着三轮误判换来的：**三个看似合理的判据全会骗人**，
> 用它们判定会得出「写入被静默丢弃 20–40%」这种**完全错误的结论**（实测反证：97 条并发写入 0 丢失）。

| 判据 | 为什么不能用来判存在性 |
|---|---|
| `/agentmemory/status` 的 `breakdown.memories` / `memoriesIndexed` / `vectorDocuments` | **会卡死**（实测数个字段长期不变，重启也不动），与实际内容无关 |
| `memory_export` | 它是**审计重放**，**不是活性库**（实测返回 133 条时活性库是 53 条，反之亦然） |
| `memory_smart_search` 的命中（分数 / 命中数 / obsId 成员判定） | §2 已写明分数与命中数不能判存在性。**即使查询串是高熵唯一串也不行**：正文或 `小节` token 多时，唯一串会被排序稀释出 top-k |

### 权威列表接口（§8 的旧版本漏记了这个）

```bash
TOKEN=$(cat ~/.agentmemory/secret)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3113/memories?limit=1000"
# → { limit, memories: [ { id, content, title, project, files, concepts, createdAt, ... } ], nextCursor, offset, total }
```

**注意端口是 Viewer 的 `3113`，不是 `3111`**（3111 只有 `config/flags` 与 `status` 两个裸端点，无记忆路由）。

### 正确配方

```
1) 写入（可并发；写入本身可靠——实测 97 条并发写入 0 丢失）
2) GET :3113/memories?limit=1000 取全量
3) 按 marker 比对「库内集合」与「台账集合」⇒ 补写 / 补记 / 去重
4) 不变式：每个 marker 在库内恰好一条，且其 id 与台账一致
```

> 推论：**「删除」也要用真 id**。台账里的 id 若来自 `memory_export`（审计重放），对它调
> `memory_governance_delete` 可能无效，从而留下删不掉的孤儿并占住同一个首行——这正是本仓踩过的坑。

## 工具不可用时（兜底）

MCP `memory_*` 没注册时**不要停**，先跑 `node src/scripts/kb-fallback.mjs probe`（本仓自带）：

- **读**：`GET http://127.0.0.1:3113/memories?limit=1000` —— 判存在性比检索可靠（检索只暴露 `title`）。
- **写**：写不进就 `node src/scripts/kb-fallback.mjs queue --marker <marker> --note <文本>` 落 `progress/pending-kb.jsonl`；
  恢复后 `plan` 打印可直接调用的 `memory_save` 参数 → 逐条写回 → 补 `progress/memory-index.jsonl` 台账 → `done --marker <marker>` 删除。
- **纯仓库兜底**：规则从 `skills/**` + 门禁脚本重建（`check-doc-drift.mjs` 的 A–P 即文档规则、`docflow.json` 即只读/认领规则）；控制层照常。
- **服务没起**：跑 `start-agentmemory.cmd`（probe 会打印实际路径）。
