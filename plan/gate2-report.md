# Gate 2 报告（t7 · 第二关口数据产物）

> 生成：2026-09-10T13:02:15.794Z · 运行者 **bench-engineer-2（t7 attempt 2 · 最终态）** · 血统：consumer-engineer-2 的 t7 attempt 1 初版 B1-B7/DIA/TEL 面 + bench-engineer-2 的 D10 判定源替换（PHANTOM 载体 + 判据双形 + attribution）与台架修正 · wasm `ee4c1ab317a100b4…`（pin 源=D:\code\projects\websurf\game\temp\wasm-hash-pin.json）· 耗时 1113ms
> 复跑：`node temp/phys-bench/run-matrix.mjs` → `node temp/phys-bench/gate2.mjs`（双 exit 0 为放行前提）

## 0. 结论：**达标**

阻断断言 13/13 通过。

## 1. 阻断断言（B1-B7）

| id | 断言 | 结果 | 明细 |
|---|---|---|---|
| G2-B1.T1 | T1 记账恒等（air/friction 闭式） | ✅ PASS | air=479 friction=67 顶头归因=4 真违例=0 |
| G2-B1.T2 | T2 压边异常减速 = 0（RA 线） | ✅ PASS | soft=0 hard=0 白名单归因=34 |
| G2-B1.T3 | T3 幻影碰撞 = 0（几何复核） | ✅ PASS | fakeLands=0 phantomBlocks=0 |
| G2-B1.T4 | T4 意外运动 = 0（位移/方向/视角） | ✅ PASS | {"excess":0,"zeroInputRot":0,"yawViol":0,"anchorPull":0}；death tick 排除 1（S8 重生位移 643.84u，谓词未含 'death' 排除——见报告 §3 发现） |
| G2-B1.T5 | T5 校准写入审计：RA 线权威零写入 | ✅ PASS | 9/9 场景 wasmUntouched=true & 权威写入=0（scenario-init 另计） |
| G2-B1.T6 | T6 外推越界 = 0（≤1 帧硬界 / 250ms 界） | ✅ PASS | 帧=1800 τ≥T=0 τ>250ms=0 capApplied=433 maxτ=13.889ms |
| G2-B2.P0 | P0 逐帧等式：α∈[0,1) + 弦插值 1e-3 容差 | ✅ PASS | 帧=1800 α违例=0 弦违例=0 单调违例=0 maxErr=0.00e+0 |
| G2-B2.P0c | P0 消费器面：套件自检计数恒 0（114 断言） | ✅ PASS | exit=0 114 passed, 0 failed bundleFresh=true |
| G2-B3 | F8' Δ_k'≡0 活体不变量（每 tick 位级 + 事件流恒等） | ✅ PASS | 5/5 场景 Δ_k'≡0（位级 & 事件流）budget={"halfTick":7.8125,"epsilonMax":8,"compensation":0,"total":15.8125} |
| G2-B4 | div 双桶：bulk（非 flip）硬界 3.0u / flip 独立计数 + P99 逃逸 | ✅ PASS | n=1431 bulk(非flip)=1409 最大=0.610352u p99=0.610352u warn(2-3u)=0 hard(>3u)=0 | flip 桶=22(0.0154) {"on_ground":21,"event":2} flipP99=4.627435u 逃逸=true |
| G2-B5 | 封帽谓词扩展版：状态不连续（event/on_ground/duck）独立成账 | ✅ PASS | 样本=1431 flip 桶（独立账）=22 三类翻转={"on_ground":21,"event":2} 非flip 越硬界=0 |
| G2-B6 | 逐位重放 replay-self（双跑 0 容差） | ✅ PASS | 3/3 场景 160 tick 逐位相同（含事件序列） |
| G2-B7.A1 | A1 判读警告：T1 必须与摩擦域断言同时归零 | ✅ PASS | 摩擦域 tick=67 / air tick=479 / T1 fails=0——摩擦盲未闭合则本项直接失败（防「T1=0 但摩擦未被检验」） |
| G2-DATA.flipP99 | 数据面：flip 桶 P99 逃逸信号（回开混合评审条款） | ✅ PASS | flip 桶=22 例（率 0.0154）P99=4.627435u 最大=4.627435u 逃逸(>1.5u)=**亮起** — 数据面：不参与退出码；亮起即触发「回开混合评审」条款（P-ra-5 S3 分布） |

## 2. 数据面

### 2.1 div 双桶（RA-PREDICT，9 场景）
```json
{
 "samples": 1431,
 "bulkSamples": 1409,
 "flipSamples": 22,
 "flipRate": 0.0154,
 "withinN": 1409,
 "warnN": 0,
 "hardN": 0,
 "bulkMax": 0.610352,
 "p50": 0,
 "p99": 0.610352,
 "flipP99": 4.627435,
 "flipMax": 4.627435,
 "p99Escape": true,
 "flipKinds": {
  "on_ground": 21,
  "event": 2
 },
 "flipCapturedSplit": {
  "captured": 2,
  "notCaptured": 20
 },
 "hardExamples": []
}
```
### 2.2 D10 定向复现（两复刻线 × 三类异常 + PHANTOM 载体 + RA 对照）
```json
{
 "cells": [
  {
   "cell": "COUPLED × T3幻影碰撞",
   "line": "COUPLED-REPLICA",
   "carrier": "D10_PHANTOM(α90/armLen512/v0=2000/零输入)",
   "judge": {
    "formA_fakeLand": 0,
    "formB_phantomBlocked": 1
   },
   "evidence": {
    "authEvents": {
     "land": 1,
     "blocked": 1,
     "fakeLands": [],
     "phantomBlocked": [
      {
       "k": 25,
       "fraction": 1,
       "speed": 2000,
       "pos": [
        81.24999999999999,
        0.03125,
        0
       ]
      }
     ]
    },
    "lineCollisionEvents": {
     "land": 1,
     "blocked": 1
    },
    "fakeLands": 0,
    "corrections": {
     "land": 1,
     "blocked": 1,
     "distSkipped": 0,
     "gateConsistent": true
    },
    "phantomBlockedDetail": [
     {
      "k": 25,
      "fraction": 1,
      "speed": 2000,
      "pos": [
       81.24999999999999,
       0.03125,
       0
      ]
     }
    ]
   },
   "reproduced": true,
   "attribution": null,
   "channelFact": "coupled 线接收权威 land/blocked（auth-loop 非 tick 支路 emit → app.ts:111 → calibrator）；tick/解耦线结构上无此通道（见 DECOUPLED×T3 归因）"
  },
  {
   "cell": "DECOUPLED × T3幻影碰撞",
   "line": "DECOUPLED-REPLICA",
   "carrier": "D10_PHANTOM(α90/armLen512/v0=2000/零输入)",
   "judge": {
    "formA_fakeLand": 0,
    "formB_phantomBlocked": null
   },
   "evidence": {
    "publishedFrames": 288,
    "fakeLands": 0,
    "anchorPulls": 0,
    "authEventsOnThisLine": "N/A（解耦模式 auth 线早退 ⇒ 无权威碰撞事件通道）"
   },
   "reproduced": false,
   "attribution": "DECOUPLED×T3 结构归因（更根本的层级）：**tick/解耦线在结构上就没有碰撞事件通道**——auth-loop 的 tick 支路在 publish 后 return（位于 land/blocked emit 块之前；文件内注释「碰撞事件停发（tick 模式：主线程零预测实例…；事件显示面改经 I_A_EVT 位 + 消费器路由）」；worker-engineer-2 只读核验、我第一方复核一致），叠加消费端 renderer 的 computeMode!==coupled gate = **双保险**；解耦模式 auth 线早退同理。⇒ T3/幻影碰撞在 tick/解耦线上**无可观测事件源**，其可观测面只在 coupled/authority 线；本载体上 S_D 发布帧亦无假落地，二者共同构成不可观测归因（**非接线问题、非参数问题**）"
  },
  {
   "cell": "COUPLED × T2减速",
   "scenario": "S3 压边",
   "line": "COUPLED-REPLICA",
   "evidence": {
    "calibWrites": 193,
    "maxVelDiff": 145.86654898122924,
    "predFinalSpeed": 250,
    "authFinalSpeed": 250
   },
   "reproduced": true,
   "note": "校准通道逐帧写速度（T5 审计）：渲染线速度与权威差 = 耦合线减速失真观测面",
   "carrier": "S3 压边",
   "judge": {
    "legacy": true
   },
   "attribution": null
  },
  {
   "cell": "COUPLED × T4意外运动",
   "scenario": "S4 撞墙",
   "line": "COUPLED-REPLICA",
   "evidence": {
    "excessFrames": 0,
    "maxDp": 0,
    "calibWrites": 193
   },
   "reproduced": false,
   "note": "校准灌入（逐帧 set_velocity）与 144Hz predict 叠加 → 位移超 |v|dt+18+1 的帧",
   "carrier": "S4 撞墙",
   "judge": {
    "legacy": true
   },
   "attribution": "t6 载体下未复现（见本档 T3 格的载体教训：先查可观测量是否存在）"
  },
  {
   "cell": "DECOUPLED × T2减速",
   "scenario": "S3 压边",
   "line": "DECOUPLED-REPLICA",
   "evidence": {
    "tickPhysWrites": 76,
    "maxWriteDv": 186.20000000000016,
    "anchorPulls": 0
   },
   "reproduced": true,
   "note": "64t 边界 set_velocity（速度校准唯一通道）：写幅度 = 减速失真量化；TICK_ANCHOR_DIST=64 拉回另计",
   "carrier": "S3 压边",
   "judge": {
    "legacy": true
   },
   "attribution": null
  },
  {
   "cell": "DECOUPLED × T4意外运动",
   "scenario": "S7 传送+锚定窗",
   "line": "DECOUPLED-REPLICA",
   "evidence": {
    "anchorPulls": 1,
    "sdJumps": 1,
    "maxJump": 1026.9082722302387,
    "tickPhysWrites": 102
   },
   "reproduced": true,
   "note": "锚定拉回（TICK_ANCHOR_DIST=64）单列——传送双线时序差 >32u 触发；T4 锚点项独立计数，不与位移越界混账（实测：S3 薄沿 0 次、S7 传送触发）",
   "carrier": "S7 传送+锚定窗",
   "judge": {
    "legacy": true
   },
   "attribution": null
  }
 ],
 "reproducedCells": 4,
 "complete": true,
 "protocol": "齐格 = 六格全部在最终码态执行并落证据；reproduced 为事实字段；未复现格必附 attribution（captain 采纳口径；字面 6/6 强制口径已否决）",
 "t3Note": "T3 双形：A 假落地（air→ground ∧ 2u 无可站立面）/ B 幻影阻挡（blocked ∧ sweep fraction≥1−1e−3）。PHANTOM 载体上 B 形在权威/耦合线稳定复现；A 形两线全 0；解耦线结构归因见 cell.attribution。",
 "legacy": {
  "cells": [
   {
    "cell": "COUPLED × T2减速",
    "scenario": "S3 压边",
    "line": "COUPLED-REPLICA",
    "evidence": {
     "calibWrites": 193,
     "maxVelDiff": 145.86654898122924,
     "predFinalSpeed": 250,
     "authFinalSpeed": 250
    },
    "reproduced": true,
    "note": "校准通道逐帧写速度（T5 审计）：渲染线速度与权威差 = 耦合线减速失真观测面"
   },
   {
    "cell": "COUPLED × T3幻影碰撞",
    "scenario": "S2 凸棱",
    "line": "COUPLED-REPLICA",
    "evidence": {
     "fakeLands": 0,
     "predGroundFrames": 184
    },
    "reproduced": false,
    "note": "pred 线假落地判定（解析几何复核：脚底 2u 内无可站立面）"
   },
   {
    "cell": "COUPLED × T4意外运动",
    "scenario": "S4 撞墙",
    "line": "COUPLED-REPLICA",
    "evidence": {
     "excessFrames": 0,
     "maxDp": 0,
     "calibWrites": 193
    },
    "reproduced": false,
    "note": "校准灌入（逐帧 set_velocity）与 144Hz predict 叠加 → 位移超 |v|dt+18+1 的帧"
   },
   {
    "cell": "DECOUPLED × T2减速",
    "scenario": "S3 压边",
    "line": "DECOUPLED-REPLICA",
    "evidence": {
     "tickPhysWrites": 76,
     "maxWriteDv": 186.20000000000016,
     "anchorPulls": 0
    },
    "reproduced": true,
    "note": "64t 边界 set_velocity（速度校准唯一通道）：写幅度 = 减速失真量化；TICK_ANCHOR_DIST=64 拉回另计"
   },
   {
    "cell": "DECOUPLED × T3幻影碰撞",
    "scenario": "S2 凸棱",
    "line": "DECOUPLED-REPLICA",
    "evidence": {
     "fakeLands": 0,
     "publishedFrames": 201,
     "anchorPulls": 0
    },
    "reproduced": false,
    "note": "S_D 发布帧（64t 校准线）假落地（解析复核）；锚定拉回窗与薄沿交互另见 S3 格"
   },
   {
    "cell": "DECOUPLED × T4意外运动",
    "scenario": "S7 传送+锚定窗",
    "line": "DECOUPLED-REPLICA",
    "evidence": {
     "anchorPulls": 1,
     "sdJumps": 1,
     "maxJump": 1026.9082722302387,
     "tickPhysWrites": 102
    },
    "reproduced": true,
    "note": "锚定拉回（TICK_ANCHOR_DIST=64）单列——传送双线时序差 >32u 触发；T4 锚点项独立计数，不与位移越界混账（实测：S3 薄沿 0 次、S7 传送触发）"
   }
  ],
  "reproducedCells": 3
 },
 "phantom": {
  "coupled": {
   "events": {
    "land": 1,
    "blocked": 1
   },
   "total": 2,
   "predFrames": 130,
   "fakeLands": 0,
   "phantomBlocks": 95
  },
  "raPredict": {
   "events": 0,
   "ticks": 60,
   "fakeLands": 0,
   "phantomBlocks": 0,
   "authorityWrites": 0
  }
 }
}
```
### 2.3 DIA D-scan（F4-C 早窗/全窗分布；ε 剖面五档 × 三场景）

| ε 剖面 | 场景 | 尝试 | 乐观发布 | 早窗占比 | leadMiss | 门闭账 | ε p50/p95/p99/max (ms) | ε>8 | div n | div p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| none | S1 | 160 | 159 | 0.9938 | 1 | ✓ | 0/0/0/0 | 0 | 159 | 0 |
| none | S3 | 160 | 159 | 0.9938 | 1 | ✓ | 0/0/0/0 | 0 | 159 | 0.610352 |
| none | S5 | 160 | 159 | 0.9938 | 1 | ✓ | 0/0/0/0 | 0 | 159 | 4.627435 |
| jitter8 | S1 | 160 | 159 | 0.9938 | 1 | ✓ | 4.1118/7.504/7.9438/7.9502 | 0 | 159 | 0 |
| jitter8 | S3 | 160 | 159 | 0.9938 | 1 | ✓ | 4.1118/7.504/7.9438/7.9502 | 0 | 159 | 0.610352 |
| jitter8 | S5 | 160 | 159 | 0.9938 | 1 | ✓ | 4.1118/7.504/7.9438/7.9502 | 0 | 159 | 4.627435 |
| atomic1 | S1 | 160 | 159 | 0.9938 | 1 | ✓ | 0.514/0.938/0.993/0.9938 | 0 | 159 | 0 |
| atomic1 | S3 | 160 | 159 | 0.9938 | 1 | ✓ | 0.514/0.938/0.993/0.9938 | 0 | 159 | 0.610352 |
| atomic1 | S5 | 160 | 159 | 0.9938 | 1 | ✓ | 0.514/0.938/0.993/0.9938 | 0 | 159 | 4.627435 |
| gctail | S1 | 160 | 156 | 0.975 | 4 | ✓ | 0/0/11.4677/11.4946 | 3 | 156 | 0 |
| gctail | S3 | 160 | 156 | 0.975 | 4 | ✓ | 0/0/11.4677/11.4946 | 3 | 156 | 0.610352 |
| gctail | S5 | 160 | 156 | 0.975 | 4 | ✓ | 0/0/11.4677/11.4946 | 3 | 156 | 4.627435 |
| stall20 | S1 | 160 | 12 | 0.075 | 148 | ✓ | 20/60/60/60 | 147 | 12 | 0 |
| stall20 | S3 | 160 | 12 | 0.075 | 148 | ✓ | 20/60/60/60 | 147 | 12 | 0 |
| stall20 | S5 | 160 | 12 | 0.075 | 148 | ✓ | 20/60/60/60 | 147 | 12 | 0 |

> 口径说明：DIA = 显示插值精度 ≈ ε（t6-stance §9）。ε_k 按**确定性抽取恒等式**复算
> `ε_k = T − δ* − (t_k − nowWake)`，`nowWake = t_{k−1} + δ* + delayMs_k + stall累积`（与 RA-PREDICT 内部同式，
> ε 剖面向量与 lib 面共用 `epsSequence` 单一定义）。**早窗占比 = 乐观发布/尝试数**（δ*≈7.625ms ⇒ 理论 ≈48.8%）。

### 2.4 遥测汇总
```json
{
 "matrix": {
  "path": "temp/phys-bench/v3/bench-v3-matrix.json",
  "generatedAt": "2026-09-10T12:59:18.613Z",
  "cells": 356,
  "executed": 356,
  "errors": 0,
  "hard": 32,
  "flip": 298,
  "snaps": 32,
  "gateClosureFailed": 0,
  "authorityWritesSeen": 0,
  "bySection": {
   "M-A": {
    "n": 180,
    "hard": 32,
    "flip": 202,
    "snap": 32
   },
   "M-B": {
    "n": 144,
    "hard": 0,
    "flip": 96,
    "snap": 0
   },
   "M-C": {
    "n": 32,
    "hard": 0,
    "flip": 0,
    "snap": 0
   }
  }
 },
 "consumer": {
  "exit": 0,
  "fresh": true,
  "summary": "114 passed, 0 failed"
 }
}
```

## 3. 判定口径与已知边界

- 阻断=exit 非零的唯一来源；数据面（D10/DIA/TEL）**不参与**退出码，异常计数原样入报告（数据≠判定）。
- D10 复现=**事实记录非认可**：复刻线（coupled/decoupled replica）=旧双实例基线账；RA 线（F4-C 单实例）=新面，T1-T6 必须为 0。
- 消费器面 P0 证据来自 `game/temp/f0-tick-consumer.test.mjs`（bundle 必须**新于**源文件，陈旧则本项直接判失败——防静默用旧 bundle）。
- 非 raw64 档（tickRate≠64）的 ε/δ 常量按 (T,ε) 同步缩放，矩阵面记 `constantBasisScaled`（见 `t7/matrix.mjs`）。

---

## 附 A. 台架自身缺陷纠正与口径（人工审定面）

> 源：`temp/phys-bench/t7/t7-report-draft.md`（mtime=2026-09-10T12:53:14.549Z）——审定内容随本文件一并交付；自动数据面见 §1-§2。

# t7 报告草稿（bench-engineer-2 · t7 attempt 2）→ 合并目标 `plan/gate2-report.md`

> 本文件=**报告内容源**，写在 t7 自有命名空间（`temp/phys-bench/t7/`），待 `plan/gate2-report.md` 的单写归属确定后原样并入。
> 纪律：所有数字均为**本机第一方复跑**；凡引用他方数据均标注来源与复跑状态。

## 0. 结论摘要（第二关口 grill 数据）

- **Gate 2 阻断面**：见 §4（当前 M-C 与 D10 面已就位；gate2.mjs 归属待裁定后整合）。
- **D10 定向复现**：**T3「幻影阻挡」形在权威/耦合线稳定复现**（sweep fraction=1.000 @k=25, 2000u/s，4×4 格全稳定）；「假落地」形两复刻线全 0。
- **DECOUPLED×T3 结构归因（更根本层级，已写进数据集 `attribution`）**：**tick/解耦线在结构上就没有碰撞事件通道** —— `auth-loop.ts` 的 tick 支路在 publish 后 `return`，位置在 land/blocked emit 块**之前**（文件内注释「碰撞事件停发（tick 模式：主线程零预测实例，land/blocked 位置微调无消费者；事件显示面改经 I_A_EVT 位 + 消费器路由）」），叠加消费端 renderer 的 `computeMode !== 'coupled'` gate = **双保险**；解耦模式 auth 线早退同理。⇒ **T3/幻影碰撞可观测面只在 coupled/authority 线**。本载体 S_D 发布帧亦无假落地 —— 二者共同构成不可观测归因（**非接线问题、非参数问题**）。
  - 来源：worker-engineer-2 只读核验（`auth-loop.ts` tick 支路 + `renderer-main.ts` gate），我第一方复核一致（内容锚点定位，非行号）。
  - `reproduced=false` 为**事实字段**，不改写成复现。
- **齐格口径**（captain 点头）：齐格 = 六格全部在最终码态（t7 台架接线 + D10_PHANTOM 载体 + 双形判据）执行并落证据；未复现格附结构归因。**字面 6/6 强制口径已否决**（避免「为通过验收放宽场景参数」）。

## 1. 台架自身缺陷纠正（t9 会核此节）

| # | 缺陷 | 证据（第一方） | 处置 |
|---|---|---|---|
| C1 | **ε 剖面字符串入参未归一化 ⇒ 三档静默零注入** | `lib/chains.mjs:375` 读 `opts.epsProfile`、`:391` 读 `eps.kind` ⇒ 字符串形态 `epsDelay≡0`；实测 ε_sup：str=0.0000 / obj=7.9348(jitter8)。protocol-engineer-2 先报，我复现一致 | 已修（归一化）+ 剖面抽成跨面单一定义 `epsSequence`；新增 4 条可伪证断言（含零点守卫、随档单调） |
| C2 | **smoke 三条 ε 断言为空断言** | 名字回显恒真 / `\|\| published>0` 恒真 / `clockStalls.length>=0` 恒真（RA 链不注册 `clock.stalls`） | 已升级为可伪证断言；**断言数 57 → 61 → 62 → 63**（61=ε 四条；62=+耦合速率单一真源；63=+J0′ 双断言）。**t7 报告一律引 63/63**；t4 output 的 57/57 只可读作**非 ε 面的零回归证据** |
| C3 | **D-scan 交付物缺位 + 过度声明** | `dScan()` 零调用者、结果 JSON 无 dscan 段、无 knee；README:9 / 报告:9 却列「ε 剖面 D-scan」为已验证面 | 已实现 `t7/dscan.mjs`（产品 `TickConsumer` 真模块 × 648 格 + knee）→ `v3/dscan-t7.json`；两处声明文字已订正并写明补齐路径 |
| C4 | **内核 yaw→forward 误注** | t6 报告/README/`lib/scenarios.mjs:243` 写「yaw=−90 → forward=+z」；实测映射 = `0→−z / 90→−x / 180→+z / 270→+x`（等价式 `forward=(−sinθ,0,−cosθ)`） | 三处注释/文档均按实测改正；R-C「修好」的真实原因=新带 x∈[−60,−40] 落在 spawn x=−250 的 **+x** 路径上（非「沿 +z 行进轴」） |
| C5 | **v3 面 S1 速度变体退化（假覆盖）** | `sc.build(v)` 产出 `initialVel` 但 `makeWorld()` 未消费 ⇒ `s1-th60-v1500/v2500/th45` 三变体 final pos **位级相同**、速度被 maxSpeed 钳到 250 | 已修（`initState/initialVel` 消费，语义=scenario-init，与 lib `applyInitState` 同式）；修后 vz=1500/2500 分化。**t7 是 v3 面速度轴的首次真实覆盖**（t6 的 S1 速度标签未生效） |
| C6 | **pin 假告警** | `lib/core.mjs:25` 与 `smoke.mjs:36` 仍持 t1 旧 pin `a60371ee…`，而事实表/pin 文件已升 `ee4c1ab3…` ⇒ 每次跑吐「pin 不一致」告警 | 已改读单一真源 `game/temp/wasm-hash-pin.json`；告警分支改**真 FAIL**（含 FAIL 路径自测：bogus pin → 56/57 + exit 1） |

| C7 | **v3 预测世界带传送结构（保真偏差）** | 产品耦合线**预测实例禁用传送**（`mod.rs:275-295`、`teleport.rs:182-184`；lib 复刻线同款 `lib/chains.mjs:121` `noTeleport:true`），而 v3 `runCoupledReplica` 的 pred 世界此前带 teleport 结构 ⇒ S7 类载体上 pred 会自行传送，与产品语义不符 | 已修（pred 世界 teleports 置空，镜像产品语义）；回归 smoke 61/61、run-bench 八段不变 |

## 2. D10 六格：T3 载体迁移 + 双形判据（实测）

**载体迁移**（captain 采纳的步骤②）：D10_PHANTOM = `corner(α=90, armLen=512, h=256, cx=300)` + spawn `[-700,60,0]` + yaw −90 + `initState{vel:[2000,0,0], onGround:false}` + 零输入（逐字取自 `lib/scenarios.mjs:276-284`），跨面单一定义于 `t7/carriers.mjs`。

**判据双形**（步骤③）：
- **T3-A 假落地**：air→ground 上升沿 ∧ 脚底 2u 内无可站立面（`standableBelow`，STANDABLE_NORMAL ny≥0.7）
- **T3-B 幻影阻挡**：`blocked` 事件 ∧ 内核 `debug_trace` 重放 `prev → prev+v·dt` 扫掠 **fraction ≥ 1−1e−3**（路径无阻挡）

| 载体 / 输入组合 | 权威线 | COUPLED 复刻线 | DECOUPLED 复刻线 |
|---|---|---|---|
| PHANTOM v0=2000 零输入（canonical） | land=1, blocked=1, **幻影阻挡=1**（fraction=1.000 @k=25）, 假落地=0 | 事件 land=1/blocked=1；校正 land=1/blocked=1 已施加（`gateConsistent=true`）；假落地=0 | 假落地=0, anchorPulls=0 |
| ×{零输入,前进键}×{v0=2000,3500}（4 格） | 4/4 同上 | 4/4 同上 | 4/4 假落地=0 |
| 旧载体 S2/S4/S7（对照） | 各仅 **land=1, blocked=0** | 假落地=0 | 假落地=0 |

**接线（步骤①）实测结论**：台架接线（`v3/replicas.mjs` 帧首消费 → `calibrator.applyCollisionCorrection`，镜像产品 `app.ts:111 → renderer-main.ts:909-911`）已生效且**审计不变量成立**（`gateConsistent = (状态改动)===(dist<60)`；S1/S2/S4/S7 均 true），但**单独接线不翻转 T3**（3/6 不变）——三载体上权威碰撞事件总量=1 land/0 blocked，该通道「无物可作用」。**主杠杆=载体，第二杠杆=判据双形**（t7 实测）。

**六格复现事实**（`t7/d10.mjs` 最终码态复跑 → `v3/d10-t7.json`）：**4/6** —
COUPLED×T2 ✓ / **COUPLED×T3 ✓（幻影阻挡形，formB=1）** / COUPLED×T4 ✗ / DECOUPLED×T2 ✓ / DECOUPLED×T3 ✗（结构归因见 §0） / DECOUPLED×T4 ✓。
两处未复现格的 `attribution` 已逐格落盘：
- **DECOUPLED×T3**：该线无权威碰撞事件通道 + 本载体 S_D 帧无假落地（=captain 采纳措辞）。
- **COUPLED×T4**：legacy 载体 S4 撞墙上无 ≥1u 量级校正事件 ⇒ T4 通道不可观测；**载体迁移未完成**（候选 S7 传送载体的首次尝试在 90 tick 内未触发传送，判据未命中，属未决残余项，**未做任何静默调参**）。这与 T3 的教训同类：先确认可观测量存在，再判复现。

**六格齐格口径**：六格全部在最终码态执行并落证据 + 未复现格附结构归因 ⇒ 满足 captain 采纳的齐格定义（`reproduced` 为事实字段，字面 6/6 强制口径已否决）。

## 3. M-C：tickRate raw64 语义（契约硬项）

- **产品门精确档**（`createOrderingGate` 真模块，逐档断言）：`cap(T, ε=8ms) = T − 8`、`cap(T, ε=1ms) = T − 1`、`δ* = cap`，其中 `T = 1000/rate` **精确**（rate∈{48,64,100,128}）。
- **worker 级 raw 语义**（t4 真模块测试，t7 新建 bundle 跑）：`t7/t4-chain.test.bundle.mjs` **10/10 全绿 exit 0**，含 **§P2「resolveAuthTickRate tick=raw 精确 / coupled=面板+3」**、§P4「步长分派：coupled/tick = setFixedDt+reset；decoupled = onTickRateChanged」⇒ 契约「`fixedDt === 1/rate` 精确成立、+3 不渗入」的直接证据。
- **+3 非渗入守卫**：断言 `1000/(rate+3) ≠ 1000/rate` 且 cap 随之不同（泄漏可检测）。
- **三模门**：`isAuthLineMode(tick)=true / coupled=true / decoupled=false`。

## 3½. R6 配套：耦合速率单一真源（口径一行）

台侧此前的 `67`/`1/67` 为**裸字面量**（`v3/replicas.mjs` 默认参数、`lib/chains.mjs:22/138/139`）——与 `config` 默认（64 + `TICK_RATE_OFFSET` 3）**恰好一致但无共享真源**，config 一改台侧即静默停留在 67（假对照）。
处置：新增 `lib/product-constants.mjs`，从**产品源码**派生 `COUPLED_TICK_RATE = config.DEFAULT_CONFIG.physics.tickRate + worker.TICK_RATE_OFFSET`（解析失败即回退并在 `source.fallback` 标注，禁止静默回退），并带文件 mtime 溯源；`lib/chains.mjs` 的 `DT67_MS` 与 `auth.tick(1/…, …)`、`v3/replicas.mjs` 的默认 `tickRate` 全部改吃派生值。
交叉校验（产品**代码**侧，非台侧重推）：`resolveAuthTickRate('coupled', 64, 3) = 67`、`('tick', 64, 3) = 64`（raw 直译，M-C 附证）。smoke 新增断言 → **62/62 全绿**（含「非 fallback + 派生式成立 + 产品 resolver 一致」三合一）。

## 3⅕. δ 口径（captain 裁定①：双面都报，不回改 lib）

- **权威取证面 = v3 面**：产品排序门 + 产品 δ（`δ = cap = T − ε_max = 7.625ms`）+ ε 注入 ⇒ ε 尾/lead-miss 判据一律以 v3 面为准（`t7/eps-profiles.mjs` 的 v3 行、`epsSequence` 注入、门闭账）。
- **lib 面 δ=7.6ms** 为台侧复刻常量，保留作基线与回归对照（**不回改**，避免 t6 基线漂移）。
- 两面 0.025ms 口径差 = 生产 δ 取门缺省 cap（7.625）而台侧复刻取 7.6；报告引用两侧数字时**同时标注该差**，不得混用。

## 3½. DIA 延迟面「双读」（防口径混淆）

t7 同时交付两个**不同口径**的 DIA 数据面，报告引用时必须写明口径：
1. **产品消费器面**（`t7/dscan.mjs` → `v3/dscan-t7.json`；**已接入 `run-matrix.mjs` M-E 段**，随全量矩阵一并产出）：以产品 `TickConsumer` 真模块为取证对象，扫 Δ∈[4,32]ms × 刷新{144,240}Hz × ε 剖面{none,atomic1,jitter8,gctail} = 648 格，另**Δ×L 二维成本视图** 972 格（L∈{0,T/2,T}）。输出 hold 占比 / starvation / 直出阶梯 / 生效 Δ / **knee**（`Δ ≥ T + late_max − L`，L=0 档）。这是 DIA 的**主口径**。
2. **ε 空间门面**（gate2 §2.3，15 格）：ε 剖面 × 场景 × 乐观发布/尝试（早窗占比）——度量**门的乐观窗命中率**，非显示龄；不参与退出码。

**注入生效正向证据（M-E 打印，禁引修复前任何 ε 数字）**：`positiveAll=true`、`monotone=true`，ε_sup 实测 `atomic1 0.9938 < jitter8 7.9502 < gctail 11.4946`。
**knee 首轮实测**（L=0）：none 11.75/13.5、atomic1 11.75/13.25、jitter8 13.5/16.5、gctail N/A(1.47% 残留)/17.0（@144/240Hz）——均**低于** `T+late_max` 保守界（该式为充分条件，见 dscan meta caveats）。
**Δ×L 数据发现（必须如实记）**：L∈{0,T/2,T} 上 knee **未见模型预期的左移**（模型 `T+late_max−L` 单调下降，实测 flat/略升）⇒ 记述为「模型未获实测支持」；且 L 轴为**台架近似**（发布相位前移），产品 F4-C 主案消费器**无 L 接口**（L 属 D 家族备选），**不得**据此宣称 L 收益。

两者不可互相替代；报告正文引用「DIA」时默认指口径 1。

## 3¾. J0′ 反假绿：B 档 atomic1 的真实注入（强制项⑤）

**陷阱同型于 J0**：「仅接受剖面名」会让 `ε_sup=0` 满足「<1」而假绿。故落地形态=**真实注入 + 双断言见证**：

| 面 | ε_sup | leadMiss | 双断言 | 备注 |
|---|---|---|---|---|
| lib（`runRAPREDICT`，台架 δ=7.6） | **0.9918** | **0** | ✓ `ε_sup>0 ∧ leadMiss===0` | 另核**字符串/对象两形态同值**（J0 回归守卫） |
| v3（`runRaPredict`，**产品门** δ=cap=7.625） | **0.9995** | 1 | ✓ `ε_sup>0 ∧ leadMiss≤1` | +1 为**引导期无锚**结构性允许——由 `none` 剖面亦为 1 佐证（与 ε 无关，非豁免借口） |

全档家族判据（`t7/eps-profiles.mjs`，exit 0）：control `none=0`；declared `atomic1<1`、`jitter8≤8`（尾不触发）；over `gctail/stall20`（ε 尾真实触发）。
smoke 新增该专项断言 → **63/63 全绿**（t7 报告统一引此新数，不引 t4 期的 57/57）。protocol-engineer-2 复核器（独立实现，家族表驱动）现报「模型轨 PASS」，与本档逐档一致。

## 3⅙. 边界：种子面对解析器 feature 敏感（rig 必须 pin）

rust-engineer-2（t13，float_roundtrip ON/OFF 双构建差分）实测：关闭该 feature 的构建上，**v2 种子面（`set_state_ex`/`state_full_json` 全字段）22 样本中 4 例分歧**（#4/#14/#15/#16），而 v1 面一致；`game/temp/phys-seed-smoke.mjs` 在该构建上 exit 1（首败 B 组）⇒ 该 feature 是**种子面位级契约的承重件**。
t7 处置：一切数值绑定**当前 pin `ee4c1ab3…`**（各数据集 meta 均记 `wasmSha256`，且取数前后各校一次 pin；t13 期间 wasm 于 20:36:17 重建后实测仍=pin、双端恒等）。OFF 构建数据不参与 t7 判据，仅作边界记录（其产物在 `game/temp/phys-t13/off-field-fidelity-results-{v1,v2}.json`，属 rust-engineer-2 域）。
另：我方 `field-fidelity-results*.json` 曾被 t13 批跑意外覆盖，已由 rust-engineer-2 逐字节恢复，我按 sha256 复核一致：canonical/`-v1` = `c82b8641ae85d009…`（31912B，`cmp` IDENTICAL）、`-v2` = `042abe071619b4e8…`（38391B）。
**取数前守门（t7 新增）**：`node temp/phys-bench/t7/preflight.mjs` —— 三项核验（wasm vs pin 真源 / 上述 t1 历史规范件 sha 登记值 / v3 bundle 新鲜度），**exit 0 才允许取证**；实测 5/5 ✓（wasm `ee4c1ab3…` = pin、v1/v2 登记值一致、bundle 12:52:15Z ≥ 源最新 12:34:53Z）。
**判读规则（写入报告）**：RA-PREDICT 主链用 **v2 全字段种子档**时，**当前 ON 构建（pin `ee4c1ab3…`）是唯一正确档**；若出现 t13 所述 4 个样本（#4/#14/#15/#16）相关的分叉，**先核 wasm pin，不得直接判种子面缺陷**。

## 4. 待办（本文件随进度更新）

1. D10 六格**最终码态**全重跑（PHANTOM 载体 + 双形）→ 回填 §2 表 + 消除 `d10.t7TODO`（t9 硬前置）。
2. M-C 32 格参数化 dt 扫描并入矩阵数据集（`--only=mC`）。
3. `gate2.mjs` 归属裁定 → 整合/重写（B1-B7 + 数据面 D10/DIA/TEL）→ 本文件内容并入 `plan/gate2-report.md`。
4. DIA D-scan 的 knee 表与 caveats（单 seed 采样误差 / 实测 knee 低于 `T+late_max` 保守界 / gctail 尾档残留非单调）进报告正文。

—— bench-engineer-2（t7 attempt 2 · in_progress）
