# WebSurf 仓库第一轮模块审查报告（2026-09-06）

> 方法：六个评审单元各由独立子代理执行（src 共享层 / debug / game / viewer / test 两工程 / 根级横切），
> 每个评审员实跑所在模块的验证门并交叉核对跨模块契约。本文为汇总存档，供后续轮次跟踪闭环。
> 范围口径：P0=正确性/安全问题；P1=应修；P2=建议。本轮只审查不改码（评审中标注的行号以当日 HEAD 49049e7 为准）。
>
> ✅ **收尾验证（2026-09-06，独立收尾评审员）**：九条 P1 逐条重验零失实（行号 9/9 命中）、
> 六条 P2 抽查全命中、§一统计自洽（P1=9/P2=46）、门抽验（viewer typecheck/test:replay、
> 根 cargo metadata）通过。本报告据此微修 7 处计数/措辞后定稿，可作第二轮执行依据。
> 第二轮顺序确认维持 §六 1→6，补充：#1 须按 9 处实现清单批量修；#2/#3 一行级可合批先行；
> #5 现在上「同 BSP → 碰撞 JSON 一致」CI 门可立即变绿；#4 须明确 trace-verify.mjs 的处置（修或删）。

## 一、总览

| 评审单元 | 结论 | P0 | P1 | P2 | 实跑门 |
|---|---|---|---|---|---|
| src/ 共享层 | 有条件健康 | 0 | 1 | 9 | cargo test phys 4/4 ✅、vmdl test 3/3 ✅、wasm32 check ✅、debug/game build:ts ✅（wasm-core host test 因本机 dlltool 缺失未跑） |
| debug/ | 有条件健康 | 0 | 1 | 9 | typecheck/build:ts/build:dist single+multi/check-wasm-api 全 ✅ |
| game/ | 有条件健康 | 0 | 1 | 6 | typecheck/build:ts/build:dist single+multi/check-wasm-api + 10 个 phys-*.mjs 逐个实跑全 ✅（test:phys 即其中的 phys-smoke，10 断言） |
| viewer/ | 有条件健康 | 0 | 1 | 9 | typecheck/test:replay/build:ts/build:dist ✅、test:smoke ✅（[1b] 偶发竞态，见 V-P2-1） |
| test/ 两工程 | 有条件健康 | 0 | 3 | 5 | 两工程 tsc/build:ts/build:dist ✅；dual scripts 11 个中 4 个因 maps/ 迁移崩溃或假绿（见 T-P1-1） |
| 根级横切 | 有条件健康 | 0 | 2 | 8 | cargo metadata（根+三模块 target 指向）✅、YAML 解析 ✅、六 lock 三件套一致 ✅ |

**合计：P0 = 0；P1 = 9；P2 ≈ 46。** 全部模块「有条件健康」：无正确性级致命缺陷，共性问题集中在「协议/文档/验证资产随仓库演进未跟进」。

## 二、P1 清单（9 项，按跨模块影响排序）

### ★ 跨模块：朝向换算与自家定标结论矛盾（viewer P1-1，波及 src/ts-shared）
- viewer 的 `bspYawToCsYaw = (270 − yaw)`（viewer/src/core/pose.ts:12-14）与 2026-09-03 实测定标（`yaw+180`、pitch 取反，见 maps/surf_null_4.rule.json、replay-selftest [6]、replay-rule-ai.md §2）矛盾。评审员用真实录像 1199 帧做 facing-vs-motion 全量裁决：定标式 meanDot=0.995，现式 0.056（minDot −1.000 背向）——**spawn 公式错误、定标正确**。
- 影响面：viewer 换图初始视角/出生点跳转朝向（水平镜像 + pitch 反号）；**同式同病嫌疑在 `src/ts-shared/phys/world-builder.ts:92-94,231,238`（debug/game 的 spawn yawDeg）**。
- 修复方向：viewer applyInitialPose/mapinfo 改 `yaw+180` + `−pitch`；全仓审计 `bspYawToCsYaw` 的 **9 处实现**（收尾复核实测：viewer 1、debug 2、ts-shared 1、test/dual-mode-harness 验证脚本内 5——脚本内嵌同一错误公式属「验证资产带病」，须与运行时同批修，否则防回归断言本身就是错的）；补「出生点朝向 vs 录像首帧朝向」防回归断言（数据锚 = surf_null_4.rule.json + selftest [6]）；用 demo 深链做最终目检。

### debug P1-1 / game 深挖（同题）：lib.rs 共享实现复制粘贴无同步守卫
- debug/game 两份 lib.rs 逐字共享约 2062 行（占 game 侧非空行 96%：export_brushes_planes / parse_teleports / parse_pvs_data / parse_spawn_points）。本轮实测 `export_brushes_planes` 已从「逐字一致」漂移为「语义等价但代码重排」——该函数直接决定碰撞体输出，下次漂移未必无害。
- 修复方向：四个共享导出函数下沉 `src/wasm-core`（两工程已同依赖，lib.rs 只留 wasm_bindgen 薄包装）；短期先加 CI 级「同 BSP → 碰撞 JSON 一致」断言。

### game P1-1：权威 Worker 死亡阈值缺口（已文档化未修）
- input-bridge.ts:68-74 的 `sendSetDeathThreshold` 无调用方（app.ts:129 只喂预测侧）——权威物理 death_y 恒 −100000，掉落永不死亡；叠加 respawn 不走 calibrator.resetTo/豁免窗口，死亡成为完全脱离校准体系的状态突变。
- 修复方向：一行接线 + 打通 Rust `take_event` → `calibrator.resetTo`（带豁免）；补死亡场景回归脚本。

### viewer P1-1 之外的 src P1-1：SAB 权威帧读侧缺版本复验
- ts-shared/auth/shared-state.ts:258-284 读侧 `Atomics.load` V 一次后非原子读 10 值不复验；写侧同样非原子——「无撕裂」承诺不成立（seqlock 缺复验）。低概率可自愈，修复一行（读后复验重试）。

### test P1-1：maps/ 迁移后验证资产腐烂
- dual 的 phys-smoke.mjs:3222 / surf-e2e-verify.mjs:56 / flicker-debug.mjs:109 三处旧路径 ENOENT 崩溃（约 38 项断言从未执行）；perf-bench.mjs:217 静默跳过真实地图基准（假绿）。评审员修复路径副本实测 surf-e2e 全 PASS、phys-smoke 190/191。
### test P1-2：phys-smoke「出坡校验#2」确定性 FAIL（与路径无关）——档间高度差 10.2 > 容差 8，需 triage 是 wasm 物理漂移还是容差过期。
### test P1-3：trace-verify.mjs 孤儿化（硬编码 Chrome 路径 + 期望已移除的 traceBtn）+ dual README 仍描述已删除的 src/ts-shared/trace/。

### 根级 P1-1：全模块 CI 从未远端实跑（本地 ahead 11，origin workflow 无新步骤）——push 后须盯首跑。
### 根级 P1-2：根 README/architecture 对 viewer 的描述停留在已删除的旧形态（位姿三通道/朝向诊断）。

## 三、跨模块共性主题

1. **朝向/角度换算的一致性治理**（viewer P1-1 + ts-shared 同式 + 4 处 bspYawToCsYaw 实现）：角度约定是高漂移敏感不变量，建议单点化 + 数据锚断言。
2. **Rust 导出层多副本漂移**（debug P1-1 + game 深挖 + test P2-3 instanced 近全量拷贝 game）：至少四处 lib.rs 副本，建议下沉共享 crate + diff 门。
3. **验证资产随演进腐烂**（test P1-1/1-3 + 根级 CI 未实跑）：脚本路径无单一事实来源、不进 CI 没人发现坏了；建议路径常量化 + 轻量脚本入 CI。
4. **脏数据容错静默降级**（viewer P2-2/2-3：ang/vel NaN→0 不告警；src P2-5 phyfile 环路/mtz count 无上界）：第三方/损坏输入的统一容错口径待拉齐，建议 fuzzing 一轮。
5. **文档漂移面广**（根级 P1-2/P2-5/7 + game P2-6 + dual trace 表述 + src phys 头注「12 个 API」实为 21）：集中在「头注/规模表/CI 段」三类。

## 四、模块速查（各单元 P1 一句话 + 代表性 P2）

- **src/**：P1 SAB 读侧复验。代表 P2：vbsp panic 路径（face.plane_num 未验证/num_edges<3）、phyfile 环路无防护、mtz count 无上界、stale src/Cargo.lock(0.2.127)〔已随构建拓扑收敛合入根 Cargo.lock 而消解〕、ts-shared 死导出 maskToKeys。
- **debug/**：P1 lib.rs 复制粘贴债。代表 P2：~720 行零消费导出（export_colliders 系/export_visleaf_pvs/export_glb_with_models）、bspYawToCsYaw 两份拷贝（spawn-loader.ts:61 / teleport-manager.ts:41）、check-wasm-api 只查符号级、mtz-data.ts 写后不读、verify:chamfer 断链、tsconfig 死 paths。
- **game/**：P1 死亡阈值缺口。代表 P2：worker-types.ts 协议整体落后、app.ts 头注 v5 旧架构、teleportGateTicks 面板参数 Rust 已失效、serve.py 陈旧 fork、wasm.d.ts 零导入。
- **viewer/**：P1 出生点朝向换算。代表 P2：smoke [1b] reload 竞态（CI 随机红）、ang/vel NaN 静默、Timeline 视角下拉失同步、第一人称期间鼠标增量累积、多轨迹锚定目标错位、selftest 一条恒真断言、pnpm-lock 双锁。
- **test/**：P1×3 见上。代表 P2：race-wakeup 计时断言机器敏感、instanced crates 头注过期、build:dist 无 typecheck 门、零散只写不读字段。
- **根级**：P1×2 见上。代表 P2：CI 手工 wasm-bindgen 安装步骤冗余（decoy 实验证明 wasm-pack 无视 PATH 自下载）、CONTRIBUTING 锁步指引字面执行报错、「五份 lock」计数过时（实为六份）、CHANGELOG 缺本轮条目、CI 无 Rust 缓存、verify:chamfer 死引用（与 debug P2-8 同一问题，第二轮合并处置）。

## 五、确认无恙的横切面（六评审交叉验证）

- **物理核心质量**：phys 0 unsafe、0 unwrap/panic，p2_gate 回归测试全过；KEY_MASK 位定义 TS/Rust 逐位一致；input-layer M_YAW 与 player.rs 一致。
- **vbsp 资源处理**：with_capacity 普遍钳制、Bsp::read 后 validate() 覆盖索引链、mtz 6 个 roundtrip 测试。
- **SAB/消息双模式**：viewer 之外，dual 的 TestShared 192B 布局逐字节核算全对、双模式语义等价、Atomics wait/notify 无死锁；game 的 512B 权威帧协议与 MsgState 回退逐语义等价。
- **dist 注入契约**：debug/game/viewer 三家 build-dist 的 `__VBSP_*__` 注入与消费端逐字对齐；Pages 相对路径假设自洽。
- **textures.mtz 三副本 SHA256 一致**；六份 lock 三件套+patch 一致（不含已单列为 src P2 的陈旧 src/Cargo.lock 0.2.127）；.gitignore 规则经 check-ignore 实测命中。
- **文档自曝文化良好**：各模块已知债基本都有就地标注（本轮发现的多数 P2 是「标注了但没修」）。

## 六、建议的第二轮优先级

1. 朝向换算全仓修复 + 数据锚断言（viewer P1-1 闭环 + ts-shared/debug/game 排查）。
2. game 死亡阈值一行接线 + take_event → calibrator 链路。
3. SAB 读侧复验（一行）。
4. dual scripts 路径修复 + phys-smoke 出坡校验 triage。
5. debug/game 碰撞导出一致性 CI 门（中期下沉 wasm-core）。
6. 根级文档批处理（viewer 形态、六 lock 计数、CHANGELOG 补条目）+ push 后盯首次全模块 CI。
