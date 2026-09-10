# tick 权威模式（第三计算模式）· 交接参考

> **状态**：实现与矩阵验证**已终态**；`delivery_check` **PASS**（file-exists / nonempty / UTF-8 / headless-smoke / 13 项证据）。
> **唯一未完成**：**真机手测**（用户侧；团队受「禁真实浏览器」约束不可代做）——指引见 `docs/phys-plan-discuss/t8-user-test-guide.md`。
> **本文件用途**：给后续 agent 的单一入口——契约锚点、复跑命令、残留清单、经验教训。
> 生成时点：2026-09-10（团队 `phys-tick-impl` 已删除；成员开销归零）。

---

## 0. 一句话

在 websurf（浏览器 surf 游戏）中新增**第三种物理计算模式 `tick`**：worker 内**单一 raw 64Hz 权威实例** + **F4-C scratch 乐观评估**（worker 内第二实例、权威实例零触碰零写入），主线程纯历史插值消费；**参数面板对 tick 档直接生效（无 +3 隐藏偏移）**，且渲染侧性能不受影响（per-substep 路径零新增分配、每步分配比既有权衡线**净减少**）。

## 1. 交付物（绝对路径）

### 代码
| 面 | 文件 | 说明 |
|---|---|---|
| 权威/乐观控制器 | `src/ts-shared/auth/tick-authority.ts` | `authorityTickInto`（P0 面唯一入口）/`publishMeta`/`onWake`/`refreshViews`/`makeGate`/`peekInput`/`floorSkips` |
| 协议槽与发布 | `src/ts-shared/auth/shared-state.ts` | `I_A_SEG=i32[5]`/`I_A_TICK=i32[6]`/`I_A_EVT=i32[7]`(+bit8 OPT)/`I_A_PSEQ=i32[8]` seqlock；**f′ 写序**（帧槽→PS 奇→三元组+ground→**VA release**→PS 偶）；读侧含 **VA 代际复检**；`peekInput`（scratch 投影非消耗读） |
| 三值模式与步长真源 | `src/ts-shared/auth/compute-mode.ts` | `ComputeMode` 三值、`MODE_HANDOVER_MATRIX`、**`resolveAuthTickRate(mode, tickRate, OFFSET)`**（tick=raw / coupled=+3 的唯一实现源） |
| 排序门 | `src/ts-shared/tick/ordering-gate.ts` | `createOrderingGate`（δ≤T−ε_max；cap=max(0,T−ε_max)；双档 setTimeout 7.625ms / Atomics 14.625ms）+ 发布门/lead-miss |
| worker 装配 | `game/src/worker/main.ts`、`game/src/worker/phys-instances.ts` | 三值门接线、tick 支路 raw 步长、G3 三实例参数扇出（纯函数） |
| 消费器 | `game/src/renderer/tick-consumer.ts`、`src/ts-shared/tick/tick-consumer.ts` | α 确定性网格弦插值、六显示态、**Δ 事件驱动控制器**、revision-snap + div 双桶 + P99 逃逸、断窗八类 |
| 面板/接线 | `game/src/panel/panel-controller.ts`、`game/src/panel/tick-telemetry-format.ts`(+`.test.ts` 37 断言)、`game/src/app.ts`、`game/src/renderer/renderer-main.ts`、`game/web/index.html` | 三值下拉、tick 遥测 7 行、四取证键（冻结/复制/异常打点/复制打点）、`{type:'tick-stats'}` handler |
| Rust 种子面 | `src/phys/seed.rs`(+340 行)、`src/phys/mod.rs`、`src/phys/teleport.rs`、`src/Cargo.toml` | `extract_seed`/`apply_seed`/`set_state_ex(json)`/`state_full_json()`；`state_out [f64;8]→[f64;22]`；serde_json `float_roundtrip` |
| wasm 产物 | `game/pkg/*`、`game/web/websurf_wasm_bg.wasm` | pin **sha256 `ee4c1ab3…4690`**（3710792B，双端一致；`game/temp/wasm-hash-pin.json`） |

### 文档
- `plan/gate2-report.md`（**主交付叙事**，496 行：阻断断言 B1-B7 13/13 + 数据面 + 判定口径 + 附 A 台架缺陷纠正 C1-C7）
- `plan/field-fidelity.md`（t1 事实表：22 样本、三活性缺口、10 项死位）
- `temp/phys-plan-discuss/t4-p0-boundary-and-r6-declaration.md`（**P0/R6 唯一磁盘验签面**：38 处编号表 + 出处三分 + 六类盲区 + 转换路径级披露 + R6 闭环）
- `plan-discuss/checkpoint2-grill-brief.md`（第二关口材料：D10/DIA/S5 双桶/空覆盖战绩/C5 三态/物证/五项待裁定）
- `plan-discuss/delivery-evidence-plan.md`（交付门取证清单与口径）
- `docs/phys-plan-discuss/t8-user-test-guide.md`（**用户手测指引**，14 节）
- 设计基线：`plan-discuss/plan-v2.md`、`plan-discuss/t6-render-ahead-stance.md`、`plan-discuss/t4-acceptance-memo.md`、`docs/phys-plan-discuss/t2-bench-brief.md`、`temp/phys-plan-discuss/t3-memo-mode-designer.md`

### 数据与台架（`temp/phys-bench/`）
- `v3/bench-v3-matrix.json`（**rows 344 / errors 0**；ledger 六维 + `mE` 段）
- `v3/d10-t7.json`（D10 六格：cells 6 / **reproduced 4** + 两条 attribution）
- `v3/dscan-t7.json`（648 格 + Δ×L 972 + knees/xlKnees + 每格 `eps_sup`/`late_max`）
- `v3/gate2-results.json`（14/14、阻断 13/13、达标）
- `v3/ts-shared-bundle-provenance.json`（bundle sha/mtime + 生成命令 + 20 源 mtime）
- 台架脚本：`t7/{preflight,d10,dscan,carriers,eps-profiles,matrix}.mjs`、`run-matrix.mjs`、`run-bench.mjs`、`smoke.mjs`、`gate2.mjs`、`lib/*`、`v3/*`
- 独立验证留档：`temp/gatekeeper-f/`（G1–G19 清单、`gate2-rerun.sh` 一键复跑、7 份探针、逐条核验表与日志）

## 2. 复跑验证（精确命令 + 期望）

```bash
# ① 单测（当轮新鲜 bundle；注意 cd game 后源路径要 ../）
cd game && npx esbuild ../src/ts-shared/auth/tick-authority.test.ts --bundle --platform=node --format=esm --outfile=temp/x.mjs && node temp/x.mjs
#   期望：tick-authority 19 / t4-chain 10 / ordering-gate 46 / compute-mode 45 / shared-state.protocol 75 / tick-consumer 114 / tick-telemetry-format 37 全绿 exit 0
# ② 台架守门 → 冒烟 → 矩阵 → Gate 2
node temp/phys-bench/t7/preflight.mjs      # 期望 exit 0（wasm sha==pin / 历史规范件 sha / bundle 新鲜度）
node temp/phys-bench/smoke.mjs             # 期望 63/63 exit 0
node temp/phys-bench/run-matrix.mjs        # 期望 344 格 0 错误（+mE 648+972）
node temp/phys-bench/gate2.mjs             # 期望 14/14、阻断 13/13、结论=达标 exit 0
# ③ 构建与类型门（期望双 exit 0）
cd game && npx tsc --noEmit -p tsconfig.json && npm run build:ts
# ④ 一键复跑（六套件 + 三探针，期望 15/15）
bash temp/gatekeeper-f/gate2-rerun.sh
```

**纪律**：一切 bundle **当轮新建**并附生成命令+mtime；**禁止 `| tail` 吞退出码**（用 `cmd >log 2>&1; echo exit=$?`）。

## 3. 已验证 / 未验证

**已验证**：全矩阵 344 格零错误；Gate 2 阻断 13/13 达标；D10 4/6（含 T3 幻影阻挡翻绿）；D-scan 648+972；309+37 断言；P0-CRITICAL=0（per-substep 路径零新增，且**每步比 v7 净减少**：tick 3 vs v7 4）；两条独立管线（产品门 vs 产品消费器）ε 交叉一致；页面 headless smoke（DOM/console 干净）；delivery_check PASS。

**未验证（需真机手测）**：真机延迟/平滑主观与客观读数、面板外观确认、真机 ε（C5 真机轨 BLOCKED：8ms/1ms 至今是**声明值**）、**flip 桶 P99 逃逸条款的真机复核**。

## 4. 已知残留与未决（按优先级）

1. **flip 桶 P99 = 4.627u > 1.5u ⇒ 用户 r3.5-Q3′ 的「回开混合评审」信号已亮**（22 例/率 1.54%/集中 S5 bhop 落地相位）——当前按「台架观察 + 真机复核项」归档；**真机若复现则须回开 F4-R/F4-C 混合方案复审**。
2. **Δ×L 的 L 轴未见 knee 左移**（模型未获实测支持）；产品 F4-C 消费器**无 L 接口** ⇒ **不得宣称 L 收益**。重建：`temp/phys-bench/t7/dscan.mjs` + `v3/dscan-t7.json`。
3. **C5 真机轨 BLOCKED**；模型轨 PASS（v3 产品门口径 A 档 7.9957<8、B 档 atomic1 0.9995，`deriveLeadCapMs` 重推 7.6293 仍合法）。
4. **S5 未解决量 5.0%（8 帧）= 6-tick 接触采样相位**（已解释残差）；**DECOUPLED×T3 结构性不可达**（tick/解耦线无碰撞事件通道：`auth-loop` tick 支路 return 在 land/blocked emit 之前）。
5. **T4 谓词对 S8 死亡重生位移缺 `death` 排除**（文档化残差；gate2 入参侧已排除+记账，未做静默调参）。
6. **M-C 实执行 20 格**（非 32）：RA 链 ε/δ 常量为 T=15.625 基准档定义，非 64 档属 (T,ε) 同步缩放 data-only 面（已记 `constantBasisScaled`）。
7. **分配面披露已知边界**：转换路径级 `auth-loop.publishCurrentState`（4 对象/次）+ 探针盲区六类（含**名单制**：未列函数不命中）⇒ **探针 0 命中 ≠ 无分配**。
8. `float_roundtrip` 影响半径：**未闭合但已量化**（OFF 196/1862 偏 1 ULP vs ON 0/1862；v2 面 4/22 样本；OFF 下种子面不可用）⇒ **禁写「既有输入面零分歧」**。
9. 面板真机外观确认未勾（团队侧只做到 DOM 级核对）。

## 5. 经验与纪律（本次实际踩过的坑）

**A. 工具/流程面**
1. **任务完成校验器的 glob bug**：完成态校验器对 `inScope` 做**精确字符串匹配**（`**` **无 globstar 语义**）⇒ 任何 glob 项永不命中。**提交约定**：`changedPaths` 只填**字面量精确路径**或**空集**（实测两者均可过），**全量文件清单写进任务 output 文本**。
2. **运行中团队无 inScope 修订通道**：`edit_plan` 仅作用于 staged 计划且 schema 无 inScope；运行中团队要改契约只能**开新任务续写同一文件**。
3. **verify 命令串必须逐字匹配**（不得加注释后缀），否则完成提交被拒。
4. **模型切换**（本会话实际发生）：成员 provider 额度耗尽后，`edit_plan` 对运行中团队无效，只能**移除+重加**（成员名会被保留 ⇒ 需 `-2` 后缀），并以一份**交接简报**为上下文 bootstrap。

**B. 质量反模式（「空覆盖/假绿」三例，全部在交付前被抓出）**
1. **ε 剖面静默零注入 + 三条空断言**（字符串形态未归一化；smoke 仍 57/57 全绿）⇒ 制度化 **G19 通用式**：每个声明档/矩阵轴必须有**正向生效证据**；**零值为 0 时须区分「inert 缺陷」与「受控零点/设计不变量」**，判据必须配**反向对照用例**（否则判据本身不成立）。
2. **速度轴空转**（v3 忽略 `initialVel` ⇒ 变体位级相同、速度被钳 250 ⇒ 矩阵一轴假覆盖）。
3. **`async` 未 `await`** 致证据对象被 spread 成空对象（M-C 证据全丢但 `errors:0`）。
> 另有：「同文件未列函数」盲区（探针**名单制**）与跨 wasm 边界盲区 ⇒ **探针计数是观测值、不是门禁**；门禁只取不变量（`P0-CRITICAL=0` ∧ 未列示=0 ∧ `--strict` exit 0 ∧ K 值未命中），且计数**必须带探针版本戳（sha+字节数）**。
> **金丝雀必须被证明会响**（第一版金丝雀样本无判别力 ⇒ 篡改后仍通过，属安慰剂）。

**C. 协作纪律**
1. **单写者**：`temp/phys-bench/**` 等交付面同时只有一个写者；跨域写入会造成同秒双写与覆盖风险（本会话发生过 8 起自动调度跨域误派，均被成员拒认领或 captain 改派纠正）。
2. **不基于过期快照行动**：一律先查板面；**数字以磁盘件为准，消息数字不作引用源**；行号会漂移 ⇒ **内容锚点定位**。
3. **公开对账**：同一事实出现两个数字时，先核**口径名**（站点 vs 对象数 vs 事件数；L 面 vs V 面；0-based vs 1-based 样本序号）。
4. **最强验证形态**：reviewer **不跑被审者的脚本**，而是**用另一语言重写复算**（本会话 gatekeeper-f 用 Python 独立复算 t13 的 4/22 分歧）+ 独立复跑 + 逐条内容锚核。
5. **captain 接管提交**：当成员陷入消息队列延迟/循环时，captain 第一方复跑后直接提交（本会话 t1/t2/t7 均如此），比无限等待更省。

## 6. 后续 agent 建议的下一步（按性价比）

1. **做真机手测**（唯一缺口）：按 `t8-user-test-guide.md` Step0-5 走 A/B 两臂，重点看 **Q5 的 flip P99 逃逸**是否在真机复现。
2. 若真机复现 flip 分歧 ⇒ **回开混合方案（F4-R）复审**，以真机遥测为准。
3. 若要让「L 轴」主张成立 ⇒ 需先**给产品消费器加 L 接口**并重跑 D-scan（当前台架 L 轴是近似，且未见 knee 左移）。
4. 补充未覆盖面：`T4` 谓词的 `death` 排除；M-C 若需 32 格可展开（信息量低）；`tick-stats` 面板列已接（如需更多 worker 侧计数可扩）。
5. 交付前务必要跑：`temp/phys-bench/t7/preflight.mjs`（防过期 bundle/产物漂移）+ `gate2.mjs`（阻断门）。
