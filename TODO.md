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

**当前主战线（2026-10-24 深夜，v3 定稿）**：**精致水体——DU/DV 位移链定向修复**。根因已由隔离实验锁定（活态透蓝唯一制造者 = DU/DV 失真链：固定噪声场被 `$scroll×t` 滚动平移 → 折射采样漂移 → 时域抹平；冻结 t=1 恰好滚动未起步 = v2 假过的完整解释；涟漪着色/距离蓝均已排除）。**v3 任务书（定稿）**：`docs/T-650-water-v3-task.md`——定向序列 **R0**（E1 全关活态送 owner 定「精致底座」，无代码改动）→ **C1** 位移屏幕幅度钳制 → **C2** DUDV 平滑 → **C3** 滚动倍率 → **C4** 合成波场（兜底）。验收架构：owner 终审制（活态材料三联对比、裁决原话落 AMH）、冻结帧只算 666 回归哈希、全入口覆盖。C1–C3 连续 3 轮无「过」即停回设计层。

## Agent 约束加强（Tier 1 已落地，2026-10-24）

**方案书**：`.dsh/plans/agent-constraints-plan.md`（**本地文件，不入库**；含任务卡、判据、风险/假阳性、回滚、CI 成本）。方向 owner 已认可：在 AMH 流程基座上加强，不推翻 2026-10-18 重置。

**已落地**：Tier 1 三卡（`0fc6ce9` ts-typecheck / wasm-core-tests 两 job + debug/game-gates 补 build:ts；`6bdff72` C2 前置盘点修两个先天坏测试）；§6.4 度量脚本（`5e23e66`）；§6.1 worktree 约定与 §6.3 元规则（随 6c53ae0 后一笔文档提交）。

**待 owner 四件**：① `git push origin main` 看新 job 首跑——wasm-core-tests 预期 32 过 + 1 跳 + 1 忽略，结果回填方案书 §4 卡 C2；② 分支保护登记 `three-end TS typecheck`、`wasm-core unit tests (host)`；③ 拍板 D-124 / D-125（OWNER.md 待决表）；④ lightmap 测试语义：现钉「最小可用页」实际行为，若要「钉死 2048²」属生产语义改动，需另行立项。

## 已结索引

- **T-730 — `collect_pakfile_models` 一次加载重跑 4 遍**：2026-10-18 完成（commit `9ac0cce`：三个 `BspProcessor` 加 `RefCell<Option<(VhvLog, Rc<PakfileModels>)>>` 缓存 + 共享层 `collect_pakfile_models_bundle`）。三端两图实测：4 导出合计耗时下降（如 concretejungle game 3081→2632 ms、surf_666 game 14750→12090 ms）；tri / phy / GLB sha 改前 = 改后，game 与 debug GLB 逐字节相同；mosaic 语义 sha 三端一致；三端 typecheck + build:wasm 通过；内存峰值有记录（cj 306.4 MB、666 655.5 MB 量级）。
- **渲染归属收口（2026-10-23）**：共享 `src/renderer-shared/scene/render-session.ts`，三端薄壳化；静态门禁 `src/scripts/check-render-parity.mjs` + CI `render-parity` job；规则与同机位看图流程见 `docs/render-parity.md`。可见性默认全加载 = owner 决定 D-123。AMH `mem_mvkhr473_1b3a3431f24c`。
