# 第二关口 grill · 材料骨架（captain 预置 · t7 数据落地后回填）

> 用途：矩阵数据落地后的用户 grill（三关口节奏的第 2 关）。**待回填项以 `⟨T7⟩` 标注。**
> 关口目标：用户确认「矩阵面是否足以支撑 Gate 2 通过」+ 四项裁定 + 是否进入 t8/t9。

## 1. 一页结论（待回填）

- 全矩阵规模：M-A 180 格 + M-B 144 格 + M-C 32 格 ≈ ⟨T7⟩ 格，执行 ⟨T7⟩ 分钟。
- Gate 2 阻断断言：⟨T7: 逐条 PASS/FAIL 表⟩。
- D10 六格：⟨T7: 复现格数/6 + 结构归因⟩。
- DIA D-scan：⟨T7: 三档 ε 曲线 + knee 判定⟩。
- 残余风险：⟨T7: RK 表⟩。

## 2. 需用户裁定（四项）

| # | 问题 | captain 倾向 | 依据 |
|---|---|---|---|
| Q1 | 「六格齐格」语义：**矩阵面完整+未复现格附结构归因**（`reproduced` 作事实字段） vs 字面 6/6 复现 | 前者 | 后者需改载体参数触及 nonGoals「不为通过验收放宽场景参数」；DECOUPLED×T3 因 tick 线**无 phys-event 通道**（`auth-loop.ts:238` return 在 emit 前）+ 本载体无假落地帧 ⇒ 结构不可达 |
| Q2 | S5 div 未解决量 5.0%（8 帧，6-tick 周期=接触采样相位） | 接受为已解释残差（t9 不记 findings） | 逐帧表：hard=4 帧全为 flip∧snap 帧、`hard−flip=0` ⇒ bulk 独立硬违例=0；flip 独立计数与用户「bulk≤2–3u 硬 / flip 独立」裁定同构 |
| Q3 | 真机 A/B 地图 | 主候选 `maps/surf_null.bsp`（30.4MB，仓库另有同图 replay）；用户日常图 `surf_pools` 需自备 | t8 底稿 §6.2 实测枚举；指引须写「A/B 两臂同图同起点」 |
| Q4 | 真机 A/B 臂范围 | **两臂**：A=coupled / B=tick（decoupled 单列注记区，r2 违例基线不入主判据） | plan-v2 U2；用户 r2 裁定「解耦=违例基线不修复不漂白」 |

## 3. 数据面（t7 回填）

### 3.1 D10 六格（两复刻线 × 三异常类）
⟨T7: 表格——每格 reproduced 事实值 + 判据形态（假落地/幻影阻挡）+ 结构归因⟩
- 已知（t7 前基线，20:29:10）：`reproducedCells=3/6`；COUPLED×T2✓ / DECOUPLED×T2✓ / DECOUPLED×T4✓；T3 双线 false（fakeLands 0）
- 已知（bench-2 探针）：**幻影阻挡形在权威/耦合线 4×4 稳定复现**（sweep fraction=1.000 @k=25, 2000u/s）
- t7 必办：台架接线（已落）+ 载体迁移（D10_PHANTOM：内角 90°/armLen 512/v0=2000/零输入）+ 判据双形；`d10.t7TODO` 按「完成态省略字段」消失（t9 硬前置）

### 3.2 DIA D-scan 三档 ε（jitter8 / stall20 / gctail）+ C5 标定闭合
**C5（ε_max 标定复核，protocol-engineer-2，已按「产品门口径」闭合）**：
- **模型轨 PASS**：A 档 jitter8 ε_sup=**7.9957 < 8**（余量 0.0043ms）；**B 档 atomic1 0.9995 < 1 ⇒ 由「纯声明」转 PASS**（lib 0.9918 / v3 0.9995 两面均生效）；对照组 none ≡ 0；压测档 gctail/stall20 ε_sup>8 **且** leadMiss≈4/188>0（ε 尾门真实触发）；J3c superseded ≡ 0
- 步骤2：A 档重推 cap=**7.6293** > 声明 δ ⇒ 声明域仍合法；步骤3：SG-C12 自洽 ⇒ 无需同步
- **真机轨 BLOCKED**：8ms/1ms 为**声明值非实测**（禁浏览器），唯一闭合路径=t8 用户手测（`--real` 已备）⇒ **Gate 2 禁止写「实测≤声明」全绿**
- 交叉校验：protocol-2 独立抽取恒等式 vs 台架 `gateLog[].epsMs` max|Δ| ≤ **4.98e-5ms**（一致）
- 口径纪律：**δ 7.6（lib 台侧复刻常量）/ 7.625（v3 产品 cap）不统一但须显式命名**；引用 lib 面 ε 的判据必须标注「复刻门口径」，禁与产品门口径混算；`leadMiss===0` 断言**移植到 v3 面会假红**（v3 实测=1，门文档语义「引导期无锚归 leadMiss」）⇒ v3 面用 `leadMiss ≤ 1`
⟨T7: D-scan 648 格 ε 输出（4 剖面 × {144,240}Hz × Δ∈[4,32]ms）+ knee 表 + `eps_sup/late_max` 每格追加 + B 档同分布⟩
**T7 已落地（M-E 段，`run-matrix.mjs` 内）**：648 格（Δ×刷新×剖面）+ **Δ×L 二维 972 格**（L∈{0,T/2,T}）；knee 判据 `Δ ≥ T + late_max − L`；数据入 `v3/dscan-t7.json` 与矩阵 JSON `mE` 段。
- **注入生效正向证据**：`positiveAll=true`、`monotone=true`，ε_sup 实测 **atomic1 0.9938 < jitter8 7.9502 < gctail 11.4946**（禁引修复前任何 ε 数字）。
- knee 首轮（L=0，@144/240Hz）：none 11.75/13.5、atomic1 11.75/13.25、jitter8 13.5/16.5、gctail N/A(1.47% 残留)/17.0 —— **均低于 `T+late_max` 保守界**（该式为充分条件，已入 caveats）。
- **knee 读法纪律（t9 采纳）**：实测 knee ≤ 理论保守界 ⇒ 判读为「**模型充分性成立且保守**」，**不得记为「模型失效/数据异常」**；gctail 大 Δ 残 1.5–2.2% hold = **尾尖 > 该档余量**的数据特征（非缺陷）。
- **ε 面外部佐证（两条独立管线一致，对交付有利）**：`v3 面 runRaPredict`（产品门，horizon 200）vs **t7 D-scan**（走**产品 `TickConsumer` 真模块**）：none 0/0 · **atomic1 0.9995 / 0.9938** · **jitter8 7.9957 / 7.9502** · **gctail 11.4946 / 11.4946（完全一致）** ⇒ **声明档在两条产品侧管线均未击穿**（差异仅源于抽样窗 128 vs 200 tick）⇒ ε 注入+判据在两个产品侧端到端成立。
- **⚠️ 负面结果（如实记录，需你知悉）**：**Δ×L 的 L 轴未见模型预期的 knee 左移**（实测 flat/略升）⇒ 记为「**模型未获实测支持**」。且 L 轴是**台架近似**（发布相位前移），**产品 F4-C 主消费器无 L 接口** ⇒ **不得据此宣称 L 收益**。含义：lede/L 类设计假设在当前台架下**无实测支撑**，若后续要主张需先给产品侧 L 接口 + 真机数据。
- 前置：J0 已修（字符串归一化 + `epsSequence` 单一定义 + smoke 空断言→可伪证断言 + 零点守卫 → **61/61**）；「产品门+ε 注入」同面已建（`v3/ra-chains.mjs` epsProfile+epsilonMaxMs，缺省逐位不变）

### 3.3 S5 div 双桶逐帧表
⟨T7/gatekeeper-f: bulk 独立 hard / flip 计数 / snap 逃逸数 三列⟩
- 已知（gatekeeper-f 探针）：divN=159、hard=4 帧（k=24/60/96/132，dp≡4.627435）全为 flip∧snap 帧、`hard−flip=0`、未解决 8 帧=5.0%（6-tick 周期）
- **报告纪律**：禁止以 `hard=4` 直报「bulk 违例 4 帧」
- **⚠️ flip 桶全量重算（consumer-engineer-2 一手，台侧 divBuckets 按 dp 分桶不分 flip 的口径修正）**：1431 样本 → **非 flip hard(>3u) = 0**；**flip 桶 22 例（on_ground 21 / event 2，率 1.54%），P99 = 4.63u**，全部 `captured=false`，集中在 **S5 bhop 落地相位**
- **⚠️ 需你裁定（第五问 Q5，源自你 r3.5-Q3′ 的逃逸条款）**：该数据显示 **flip P99 = 4.63u > 1–2u 阈值 ⇒ 「P99 div_flip>1–2u 即回开混合评审」的逃逸信号已亮**。两读法：**①按条款字面**在第二关口即回开混合方案复审（F4-R/F4-C 权衡重开）；**②按条款本意**（针对真机稳态遥测而非台架单场景 1.54% 相位样本）记为「台架观察 + t8 真机复核项」，t8 手测若复现再回开。captain 倾向 ②，但此为你的原始裁定条款，须你确认。

### 3.3b M-C tickRate 轴边界（consumer-engineer-2 一手实测，须写入 t7 报告与关口叙事）
- `resolveAuthTickRate('tick', r, 3) === r` ✓（raw 无 +3）；`('coupled', r, 3) === r+3` ✓
- **排序门 cap = max(0, T − ε_max)** ⇒ 48Hz=12.833 / 64=7.625 / 100=2.000 / **128Hz=0.000ms**
- ⇒ **ε_max=8 不缩放时，≥125Hz 的乐观窗整体关闭（δ*=0）**；按 (T,ε) 同步缩放 `ε=min(8, T/2)` ⇒ 12.833/7.8125/5.000/3.9063ms。**非 64 档必须显式声明 ε 缩放口径**，否则会被误读为「门坏了」

### 3.3c 两处谓词缺口（consumer-2 归因，未擅改 t6 制品）
- `t4UnexpectedMotion` 未排 `death` ⇒ S8 k=137 死亡重生位移 643.84u 被误判 T4 excess（gate2 入参侧排除+记账）
- **T1 air 闭式需"顶头"归因**：S5 天花板 C=40（底面 y=112）每 36 tick 顶头（vy +176.99→−6.42、无事件、onGround 两端 false）；用框体顶面几何（朝下平面 ∈ [头顶−0.5u, 头顶+2u]，头顶=脚底+72）归因 4 例后 **T1 真违例 = 0**（air 453 / 摩擦 67 样本）

### 3.4 本轮拦下的两处「空覆盖」缺陷（质量战绩）
| 缺陷 | 性质 | 修复 |
|---|---|---|
| J0 ε 剖面零注入 | 三档**静默零注入** + smoke 三条空断言 ⇒ 57/57 假绿；D-scan 交付物实际缺位 | 字符串归一化 + `epsSequence` 单一定义 + 可伪证断言 + 零点守卫 + 「产品门+ε 注入」同面 |
| 速度轴空转 | v3 面忽略 `initialVel` ⇒ S1 v1500/v2500 位级相同、速度被钳 250 ⇒ **M-A 速度轴假覆盖** | v3 `initState/initialVel` 消费修复；t7 是速度轴**首次真实覆盖** |

### 3.5 台架自身缺陷纠正（t9 会逐条核）
- **yaw→forward 实测映射**：0→−z / 90→−x / 180→+z / 270(−90)→+x（t6 报告/README/`lib/scenarios.mjs:243` 的「yaw=−90→+z」错误；R-C 修好真实原因=+x 路径穿 x∈[−60,−40]）
- v3 S1 零初速标签失实（「空中入坡 @1500/2500」未生效）

### 3.6 三模共存零回归物证
- 耦合校准链 **HEAD 基线零触碰**：`git diff --stat` 空 + 真实增删行计数 0 + 段级 md5 HEAD==工作区（`t9-evidence-coupled-calib-chain-head-baseline.md`，带回归哨兵属性）
- t4 语义评审：四轴全过、blocker 0、low 2（均文档面：O1 帧 timeMs 对称性注记 / C-1 peekInput 帧级分配「已评估不修」）
- K 值纪律工具化：`t4-tickauthority-probe.mjs --strict`（`P0-CRITICAL` 非空即 blocker）
- **R6 闭环证据（原 low「`resolveAuthTickRate` 无断言 ⇒ 静默 64→67 风险」）**：`game/src/worker/t4-chain.test.ts` §P2 分支级断言 `resolveAuthTickRate('tick',64,3)===64`(:335)、`1/x===1/64`(:336)、`('coupled',64,3)===67`(:337)、`1/x===1/67`(:338) + 面板 {48,64,100,128,1750} 逐值 tick=raw/coupled=+3(:339-341) + **应用级**断言（world-json tick 档→setFixedDt(64)/耦合档→67、config 变更 tick 档→raw 新值）；公式一改即红。**落盘时点 20:32:45（早于 finding 取样）**；t4 output 为终态不可追加，故记录于此。可选加固（t9 若要求）：变异测试级证明（临时改公式验证变红），需 t7 取样外的静默窗。
- **P0/R6 的唯一磁盘验签面（t14 交付，t9 必读）**：`temp/phys-plan-discuss/t4-p0-boundary-and-r6-declaration.md`（14292B/192 行）——§1 P0 界定（per-substep 三调用点零新增 + tick 3 处 vs v7 4 处分配对比）；§2 帧级披露（**含 callee 面 11 行**：`shared-state.ts:377` spread + `:637-646` `writeAuthoritative` 内 SAB 帧编码 bigint-boxing ×10，**v7 既有发布面非新增**；对称面 `writeDecoupled:554-562`；另 2 条探针盲区=`peekInput` 字面量、wasm→JS `take_event()` 事件对象）；§3 R6 闭环（断言原文+时点）；§4 六项清单+双归零+计数（299/309）；§5 FakeWorld 单槽化=前置条件（非 finding）。probe 四桶：`P0-CRITICAL 0 / P0-CONDITIONAL 2（allowlist 外 0）/ PER-STEP-AUX 18 / FRAME-LEVEL 18`；**tick 径 FRAME-LEVEL 实为 5**（非 7 亦非 6——tick 支路于 `auth-loop.ts:237` return ⇒ `:241`(state())/`:252`(array-literal)/`:255`(state())/`:271`(v7 帧字面量)**四处全不可达**；可达 = `tick-authority.ts:411`(meta)+`:465`(遥测 1/s)+`:543`(OPT 帧)+`auth-loop.ts:221`(tick 权威帧)+`:184`(hold 帧，仅 hold 期) = **7−2=5**）。**v7 对比不变：tick 每步 3 处 vs v7 每步 4 处**（v7 多出 `phys.state()`×2 经 Rust `state_js()` 构造 JS 对象 + `:252` 数组字面量）。详见 `t4-p0-boundary-and-r6-declaration.md` §2.2 注②。**数字口径**：38=四桶合计（0+2+18+18）；36=仅两主桶之和（AUX+FRAME）；16=盲区审计前旧数（已作废）。**tick 径口径（唯一，勿用单一"事件数"）**：**调用点站点 5 处**（`auth-loop.ts:221` + `:184`(仅 hold 期) + `tick-authority.ts:411/:465/:543`；= FRAME 7 − v7-only 不可达 2）；**各站点对象数不等**：`:221`=3（帧+`pos`+`vel`）/`:184`=3/`:411`=1/`:465`=2（`post` 信封 + `{...stats}`）/`:543`=4（帧+`pos`+`vel`+meta）⇒ **不宜用单一"事件数"**（先前流传的「6」只在把 `:465` 记 2、却把 `:221`/`:543` 各记 1 的不自洽口径下出现，已弃用）。每真 tick 对象合计 = 4（常态：权威帧 3 + meta 1）/ 8（含一次 OPT 开火 +4）/ 4（hold 期：hold 帧 3 + meta 1）+ 2 对象/秒（遥测）。
- **可达性（模式×通道二维，探针 v3 机器化）**：FRAME-LEVEL 18 处中**任一通道可达 16 = SAB 15 ∪ MsgState 5**（重叠计）、**永不触达 2**（`auth-loop.ts:252`/`:271`，位于 `:237` 裸 `return;` 之后）；**探针 v3 修订后四桶行数=48**（FRAME-LEVEL 18→**28**，新增 `writeDecoupled` ×10 对称面）⇒ **t4 披露口径 38 = 扫描 48 − 对称面 10**（对称面因 `writeDecoupled` 为**解耦专用发布函数**而单列，**非因不可达**；38 内含可达与不可达行——协议侧扫得含 ✗ 的行 23 行）。
- **探针版本戳**（引用计数必带）：sha[:16]=`8265dc518841b780`、21439B；**计数不作门禁**，门禁只取四项不变量（`P0-CRITICAL=0` ∧ `p0ConditionalUnlisted=0` ∧ `--strict` exit 0 ∧ `kValueBreach=false`）。
- **P0 面（唯一入口）**：`authorityTickInto`（`tick-authority.ts:367-373`）体内三调用点 = `tick_into` / `refreshViews()→state_out_ptr()` / `fillPoseFromView`（`:332-347`）；`mirrorGateStats` **不属 P0 面**（调用点 `:456`/`:464`/`:539` 均在 `onWake`、`:612` `externalWorldRebuild`）⇒ 归**帧级辅助面**。
- **已知披露边界（t9 不得记为漏项）**：①**转换路径级**：`auth-loop.publishCurrentState`（`:370-393`）单次 **4 对象**（`phys.state()` 胶水对象 + 帧外层 + `pos` + `vel`），调用点 `main.ts:237`（coupled→tick 交接）/`:252`（tick→coupled）/`:282`/`:289`（hold 释放）⇒ 转换级、非 per-substep、不进每 tick 计量；②**探针盲区两类**：跨 wasm 边界（`take_event()` 事件对象）与**同文件未列函数**（探针按函数名单扫描，`publishCurrentState` 即此类）⇒「**探针 0 命中 ≠ 无分配**」的两个实证例；③**L/V 两面命名**：`eps-profiles.mjs` 对 **L 面（lib ε 空间，δ=7.6）** 与 **V 面（v3 复刻面/产品排序门，δ=cap=7.625）** 分别取证——`atomic1 0.9918(L) / 0.9995(V)`、`jitter8 7.9348(L) / 7.9957(V)`、`gctail 17.8697(L) / 11.4946(V)`、`stall20 40(L) / 60(V)`；**t9 引用须标注面名，禁混引**；V 面 declared 档 `leadMiss=1` = 引导期无锚（`bootstrapSkips` 域，与档位无关、非缺陷）。
- **对交付有利的正面结论（P0 面净减少）**：**tick 模式每步 JS 可见分配 = 3**（`takeInput`(aux) + meta + 帧）**vs v7 = 4**（`phys.state()`×2 + `prevOrigin` + 帧）——差额来自 **F4-C 零分配面（`state_out_ptr` 视图读）替代了两次 wasm 边界对象构造** ⇒ **净减少**（强于「零新增」）。
- **第 5 类披露 + 探针盲区边界**：`src/phys/mod.rs::take_event()` 的 `Some(Teleport)` 臂 `js_sys::Object::new()` + 4× `Reflect::set` ⇒ 事件 tick 分配一个 4 属性 JS 对象（`None => JsValue::NULL` 不分配）；tick 模式**新增**每真实 tick 排空（v7 从不排空）⇒ 事件/帧级、低频、P0 之外。**局限**：TS 静态探针看不到跨 wasm 边界与被调模块内部（如 v7 段 `phys.state()` 胶水对象 ×2）⇒ **t9 不得据「探针 0 命中」推断该面无分配**。

## 4. t9 硬前置（放行前须全清）
1. t7 完成 ∧ 六格齐格（按 Q1 裁定语义）∧ `d10.t7TODO` 字段消失
2. `build:ts` + `tsc` 双 exit 0；六套断言计数重钉（309+ 现行）
3. `run-bench` exit 0（否则 ra/d10/la 数字视为陈旧值）
4. wasm pin `ee4c1ab3…` 取数前后各校一次（t13 期间曾重建，当前恒等）
5. 第二关口 grill 完成（本文件四项裁定落定）+ captain 显式放行

## 5. 关口后路径
t8（真机 A/B 包，consumer-2）→ t9（独立终审，gatekeeper-f）→ t10（文档同步）→ delivery_check（captain）。

**t10 已登记文档项（低危，逐条）**：
1. `ordering-gate.ts:121` 注释「分账完备（闭账 = published+leadMiss+blockedOrder ≡ 尝试数）」→ 补「（**门内**；门上游损失见 tick-authority `floorSkips`）」，防「完备」被误读为「遥测全口径完备」（`floorSkips` 为门上游计数、**不并入闭账**，逐行核证：`tick-authority.ts:103-112` 注释 + 测试 `:152-155` 三项式 + 行为覆盖 `:430-442` 四例）。
2. O1：OPT 帧 `timeMs`（投影网格）vs 权威帧 `performance.now()`（墙钟）不对称 → 注记「tick 模式结构性不可达」（`tick-consumer.ts` 读取数=0；全仓 `frame.timeMs` 读取者仅 `renderer-main.ts:1093`(S_D 解耦通道) 与耦合 calibrator，均在 tick 模式不可达）。
3. t13 `float_roundtrip` 影响半径 → 按「未闭合但已量化」表述，**禁写「既有输入面零分歧」**（分歧仅限需 16–17 位有效数字的最短往返字面量：OFF 196/1862 vs ON 0/1862；影响集中精确回显面+参数面 1 ULP；brush 几何面被碰撞量化吸收；**OFF 下种子面不可用**）。
4. C-1：`peekInput` per-call 字面量+BigInt 装箱 → 「已评估/不修」（帧级 ≤1/tick，P0 之外；t2 已评审 API，零收益改动只增回归面）。
5. R6 台侧派生项：`v3/replicas.mjs:45` `tickRate=67` 裸默认 + `lib/chains.mjs:22/108/138` 硬编码 `1/67` → 已裁「从 `game/src/config.ts:109`(64)+`TICK_RATE_OFFSET` 派生」（finding=low，不阻断 G13）。
6. FakeWorld `take_event` FIFO vs 真 Rust 单槽（`mod.rs:79/:511`）→ 保真度注记（方向保守=多报孤儿、当前不可达）；**立为后续「同 tick 双事件」用例的前置条件**（非 finding）。
