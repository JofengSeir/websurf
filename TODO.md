# TODO — 未结工作（可选清单）

> 2026-10-18 从旧 `progress/board.jsonl` 拆出。原看板、台账、claim、close-round 已删除；历史全文在 git 历史（该 tag 已于 2026-10-27 按 owner 要求删除，提交 `fec9810` 仍在 main 祖先链上）。
> 这里不是门禁：直接增删行，不需要同步到任何地方。旧 ID 只作历史标签保留。
> 已结条目压缩成文末一行索引；验收全文在 git 历史（本文件旧版本 / 对应 commit）。

## 等 owner 介入（2026-10-27 owner：这两件需要他，但现在不用管）

- **T-733 重开中，等 owner 给地点**：旧「surf_boreas 六面天空盒壳墙隐形墙」结论已被 owner 作废（「地图外景微缩模型与任务无关」，只作 trivia 归档，不得引用为任务结论）。仍有效：8 条确定性走行里 disp 与 .phy→brush+bevel 路径零顿挫（补面机制无罪半边成立），台架在 `.tmp/t733/*.mjs`。**需要 owner 一句话「从哪走到哪」**，拿到后在该处建度量 → collider-debug 线框 + `debug_tri_mesh_name` 归因，再按任务书 §5 修。
- **T-734 PVS 调研完成（零代码，等拍板）**：报告 `.dsh/plans/T-734-pvs-research-report.md`（264 行，R1-R6 全带数字）。要点：PVS on 剔块 87-97%、666/fornax 帧时间回 34-80fps，但**两处语义级错杀（fornax spawn \|S\|=1、相机出界保留旧集）暂不能默认开**；粒度不是瓶颈（不重组 chunk）；sedona 最重（GLB 315MB/内存 1.5GB）；连续换图 Edge WS 2.8→17.5GB 不回落（观察项）。分阶段决策请求见报告 R6；默认开 PVS 属语义改动（涉 D-123），需 owner 拍板。

## 已结索引

- **T-650 水面 / 透明材质（2026-10-27 结案）**：蓝板歼灭战 v4 owner 终审通过（`8361819` 折射/深度 RT 移出嵌套 + `3aac325` RT 清屏与 NoGeom 兜底 + `e17202a`）；岸边过渡定档——亮雾流 60 / 暗雾流 40 零回归；W-A 四档与 Lift 旋钮默认关。透明链：`vbsp_translucent`/`vbsp_alpha_test` 标记 + BLEND 不写深度（`12c70df`/`a69a333`/`93be146`），`ice01/ice03` 无 `$translucent` 属资产事实。owner 2026-10-27：「不用管，直接了结」。
- **T-731 出生点悬空 / 计时 / 死亡线（2026-10-27 结案）**：`6829f61` 出生点去嵌入 / `5635f77` lastTickMs 复位 / `5b66560` death_y 双端接通；物理回归 36→40 全绿，两图冷加载 6/6 过。owner 2026-10-27 表示不知情 → 按已交付结案，不再等实机终审。
- **Agent 约束 Tier 1（2026-10-27 收口）**：`0fc6ce9`（ts-typecheck / wasm-core-tests 两 job + debug/game 补 build:ts）、`6bdff72`（修两个先天坏测试）、`5e23e66`（度量脚本）。**D-124 已实现**：`.githooks/pre-commit` + `src/scripts/precheck-staged.mjs`（生成物路径 / `.cmd/.bat/.ps1` 的 CRLF+ASCII，正负控都验过；`PRECHECK_BYPASS=1` 逃生门），`npm run hooks:install` 启用。**D-125 已落地**：AMH 尾注升「文档级必须」。剩 owner 侧动作（push、分支保护登记）不占本清单。
- **[已结] T-732 异常暗面（2026-10-27）**：根因是第 1 级逐顶点光照的"几何重建"层——接缝焊接 + 空间鲁棒滤波 + 拉普拉斯 + 方差压缩；滤波按 2 环邻域中位数把差 >0.1 的顶点整条拉回，`s1_ramp1b` 每行只有 2~6 个顶点 ⇒ 相邻行互相拉平，在连续曲面上造出硬边人字带。**整层已删除**（`3b19f2d` + `0ada145`，422 行），第 1 级只剩 `屏 = 贴图 sRGB × vlight（v = 2×byte/255）`；配套旋钮/面板/prefs 字段/统计日志/停用的 `_vbsp_vcube` 一并清除。另 `4b9ef3d`：`.vhv` 只取 LOD0。验证：三端 typecheck + parity 绿，正面机位与独立最小实现一致。规则与最小复现见 Mnemon 文档《T-732 — prop 预烘焙光照规则与最小复现》。
- **T-730 — `collect_pakfile_models` 一次加载重跑 4 遍**：2026-10-18 完成（`9ac0cce`：三个 `BspProcessor` 加 `RefCell<Option<(VhvLog, Rc<PakfileModels>)>>` 缓存 + 共享层 `collect_pakfile_models_bundle`）。三端两图实测：4 导出合计耗时下降（concretejungle game 3081→2632 ms、surf_666 game 14750→12090 ms）；tri / phy / GLB sha 改前 = 改后；三端 typecheck + build:wasm 通过；内存峰值有记录（cj 306.4 MB、666 655.5 MB 量级）。
- **渲染归属收口（2026-10-23）**：共享 `src/renderer-shared/scene/render-session.ts`，三端薄壳化；静态门禁 `src/scripts/check-render-parity.mjs` + CI `render-parity` job；规则与同机位看图流程见 `docs/render-parity.md`。可见性默认全加载 = owner 决定 D-123。AMH `mem_mvkhr473_1b3a3431f24c`。
