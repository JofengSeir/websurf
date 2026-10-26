# TODO — 未结工作（可选清单）

> 2026-10-18 从旧 `progress/board.jsonl` 拆出。原看板、台账、claim、close-round 已删除；历史全文在 git tag `checkpoint/pre-amh-reset-20261018`。
> 这里不是门禁：直接增删行，不需要同步到任何地方。旧 ID 只作历史标签保留。
> 已结条目压缩成文末一行索引；验收全文在 git 历史（本文件旧版本 / 对应 commit）。

## T-650 — 透明材质半透/分层渲染（D-120 已决取 (a)）

**状态**：实施中（2026-10-18 起）。近期进展 P2.1–P2.3：`12c70df`（补迁 main 半透明分块）、`a69a333`（debug 面板 A/B 开关）、`93be146`（水材质缓存合一 + 模型通路补 `vbsp_water`）。
**现象**：`ice03` / `ice01` / `ice_transparent` 是 UnlitGeneric / `$translucent`，现按 owner 裁决吃光照，但没有半透明与分层渲染（owner 明确点过的缺口）。透明排序/混合未实现。
**本轮进度**：VMT 实测 —— `ice01/ice03` 是 UnlitGeneric 且**没有** `$translucent`；`ice_transparent` 是 LightmappedGeneric + `$translucent 1`（`ice02` 与 `models/ice_transparent` 是 VertexLitGeneric + `$translucent 1`）。GLB 侧 `ice_transparent` 已是 `BLEND`、`doubleSided`；本轮补：材质 extras 增加 `vbsp_translucent` / `vbsp_alpha_test`（世界面与模型两条路径），渲染端对 BLEND 材质强制 `depthWrite=false`。

**2026-10-18 验证（wasm 三端，`surf_boreas`）**：`ice_transparent` / `ice02` / `snowiceblend` 均为 `alphaMode=BLEND` 且 extras 带 `vbsp_translucent:true`；三端材质元数据逐项相同。GLB 字节数 game = debug = 123956464，viewer = 123956376（差 88 B，仍是已知的 `accessors.min/max` 浮点末位格式差异）。`ice01` / `ice03` 的 VMT 没有 `$translucent`（UnlitGeneric + `$surfaceprop ice`），保持 OPAQUE 是资产事实，不是漏做。**剩余**：浏览器三端同视点逐像素验收（本机无 headless 文件选择）。
**判据**：三端同视点下 `ice_transparent` 呈半透明（可透过看到后方几何）且三端逐像素一致；`$translucent` 材质在 GLB 材质 extras 有可判定的透明标记；三端 `npm run typecheck` exit 0 + 渲染一致性检查 exit 0。

**v2 执行状态（2026-10-24 深夜）**：五规则实现并固化（`ea571f3`），冻结帧机位全过、666 逐字节回归——但 **owner 二次实机打回：活态仍透蓝**。§12.5 定案：全部观感验收材料冻结在 `__vbspWaterTimePin=1`，恰好抽中清晰帧；活态同机位复现 = 80-85% 平坦蓝板，与 owner 实机一致。v2 **B1 fail 拒收**（两次仪器事故：陈旧构建、冻结帧，均由 owner 实机暴露）。

**当前主战线（2026-10-25，v4 收官）**：**蓝板歼灭战 owner 终审通过**（原话「没有了 相当完美的修复」，实飞复测 + flight 条带确认）。最终修复链：`8361819`（折射/深度 RT 移出 onBeforeRender 嵌套——总根源：嵌套渲染状态随视角排序污染）+ `3aac325`（折射 RT 无条件清透明黑 + 镜面 pass 去嵌套 + NoGeom alpha≤0.25 兜底约束）+ `e17202a`。诊断史（v1 前提错误挂停 → v2 冻结帧拒收 → v3 根因叙述三次被确定性测量推翻 → v4 逐像素归因+嵌套定案）与**四次仪器事故总账**见因果链 **§13**；新坑已入 skill REFERENCE §9（嵌套渲染炸弹 / RT 清屏语义 / 单会话飞行模拟 / 视觉转述出局 / 旧服务锁 dist）。**遗留小项**：666 目视门已过（owner 2026-10-24「666目视感觉还不错」）；岸边过渡已定档——亮雾流默认 60（owner 2026-10-25 从 w40/60/80 活态条带选 60），暗雾流保持 40 零回归（材质级 `fogPeak<0.3` 分流，非地图特调；钉帧验证 default≡override60 逐字节相同）；W-A 四档/Lift 旋钮默认关（观感稳定后可定档）；推送由 owner 发起。

## Agent 约束加强（Tier 1 已落地，2026-10-24）

**方案书**：`.dsh/plans/agent-constraints-plan.md`（**本地文件，不入库**；含任务卡、判据、风险/假阳性、回滚、CI 成本）。方向 owner 已认可：在 AMH 流程基座上加强，不推翻 2026-10-18 重置。

**已落地**：Tier 1 三卡（`0fc6ce9` ts-typecheck / wasm-core-tests 两 job + debug/game-gates 补 build:ts；`6bdff72` C2 前置盘点修两个先天坏测试）；§6.4 度量脚本（`5e23e66`）；§6.1 worktree 约定与 §6.3 元规则（随 6c53ae0 后一笔文档提交）。

**待 owner 四件**：① `git push origin main` 看新 job 首跑——wasm-core-tests 预期 32 过 + 1 跳 + 1 忽略，结果回填方案书 §4 卡 C2；② 分支保护登记 `three-end TS typecheck`、`wasm-core unit tests (host)`；③ 拍板 D-124 / D-125（OWNER.md 待决表）；④ lightmap 测试语义：现钉「最小可用页」实际行为，若要「钉死 2048²」属生产语义改动，需另行立项。

## 下一批任务（2026-10-25 立项并当日执行完毕；任务书本地下发）

执行方式：executor=GLM-5.3-Flash（workflow 钉模型），主会话逐任务独立复核证据后放行下一个；任务书与证据在 `.dsh/plans/`、`.tmp/`（本地不入库）。

- **T-731 修复完成**（`6829f61` 出生点去嵌入 / `5635f77` lastTickMs 复位 / `5b66560` death_y 双端接通）：进图悬空=出生盒嵌入→check_stuck 整帧跳过；物理回归 36→40 项全绿，两图冷加载 6/6 过。待 owner：①终审 ②确认报障时面板「体型」是否非默认（executor 15 次默认体型不复现，机制靠非默认体型复现）③胖体型无解时是否启 auto_restore_hull ④传送目的地是否也接去嵌入。
- **T-732 异常暗面：根因=默认的逐顶点"重建"伪造色带（`e0ebfbf`）；另修 .vhv 多 LOD（`4b9ef3d`）**（2026-10-27）：用同一份字节按引擎口径（屏=贴图 sRGB×vlight）重画是平滑的；带子由默认 `reconstructVertexLighting` 的空间鲁棒滤波造出——把与 2 环邻域中位数差 >0.1 的顶点整条拉回中位数，而 `s1_ramp1b` 每行仅 2~6 个顶点，相邻行互相拉平 ⇒ 硬边人字带。修法：`propVertexRelax` 1→0（默认直接用烘焙值，面板仍可开）；顺带 `parse_vhv` 只收 LOD0 块（boreas 82% 的 sp 文件带 LOD>0 块，原来会把整块 vlight 丢掉/错位）。验证：666 正面机位 relax=1 有带、relax=0 平滑；三端 typecheck + parity 绿。证据 `.tmp/t732b/`（app-default/app-raw/final-headon/minmodel0）。未推送。
- **T-733 归因结案（零代码）**：顿挫=surf_boreas 六面天空盒壳墙被地形画穿的**隐形墙**（18093 穿面采样点；r3a/r1 原始 tick 已复核），补面机制无罪；`skip_sky:false` 为既有决定。待 owner：A 改图（需 .bsp 源）或 B 接受现状（外坡不作走行区）。
- **T-734 调研完成（零代码）**：报告 `.dsh/plans/T-734-pvs-research-report.md`（264 行，R1-R6 全带数字）。要点：PVS on 剔块 87-97%、666/fornax 帧时间回 34-80fps，但**两处语义级错杀（fornax spawn \|S\|=1、相机出界保留旧集）暂不能默认开**；粒度不是瓶颈（不重组 chunk）；sedona 最重（GLB 315MB/内存 1.5GB）；连续换图 Edge WS 2.8→17.5GB 不回落（观察项）。分阶段决策请求见报告 R6。待 owner：默认开 PVS 档位语义（涉 D-123）与实施优先级。

## 已结索引

- **T-730 — `collect_pakfile_models` 一次加载重跑 4 遍**：2026-10-18 完成（commit `9ac0cce`：三个 `BspProcessor` 加 `RefCell<Option<(VhvLog, Rc<PakfileModels>)>>` 缓存 + 共享层 `collect_pakfile_models_bundle`）。三端两图实测：4 导出合计耗时下降（如 concretejungle game 3081→2632 ms、surf_666 game 14750→12090 ms）；tri / phy / GLB sha 改前 = 改后，game 与 debug GLB 逐字节相同；mosaic 语义 sha 三端一致；三端 typecheck + build:wasm 通过；内存峰值有记录（cj 306.4 MB、666 655.5 MB 量级）。
- **渲染归属收口（2026-10-23）**：共享 `src/renderer-shared/scene/render-session.ts`，三端薄壳化；静态门禁 `src/scripts/check-render-parity.mjs` + CI `render-parity` job；规则与同机位看图流程见 `docs/render-parity.md`。可见性默认全加载 = owner 决定 D-123。AMH `mem_mvkhr473_1b3a3431f24c`。
