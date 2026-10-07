# progress/ 导航（过程记录）

> **性质**：**过程记录，不作事实来源**（事实以当前代码为准，状态只在 `TODO.md`）。本页只回答「哪个文件管什么、什么时候去看它」。
> **体积纪律**：过程记录单文件 ≤ 48 KB，超限按时间/主题切卷，卷必须登记在本页（体检 `[I]` 硬查覆盖）。

| 文件 | 一句话 | 什么时候看 |
|---|---|---|
| `monthly/2026-09.md` | 2026-09 逐条进展原文（重编期与 UI 轮次） | 追某次改动当时怎么做的 |
| `monthly/2026-10-1.md` | 2026-10 进展第 1/4 卷（物理 bevel / chamfer 那批） | 同上，按时间顺序 |
| `monthly/2026-10-2.md` | 2026-10 进展第 2/4 卷（渲染层下沉 Phase 1–3d） | 同上 |
| `monthly/2026-10-3.md` | 2026-10 进展第 3/4 卷（viewer 影带/时间轴/主题那批） | 同上 |
| `monthly/2026-10-4.md` | 2026-10 进展第 4/4 卷（10-01 收尾 ～ 本轮文档整理） | **新一轮进展追加到本卷**（当月最后一卷） |
| `board/archive-2026-10.md` | 看板分卷：已记录 + 已结案（40 条） | 查某条历史项的 ID / 状态 |
| `decisions.md` | 待裁决分批清单（133 条按 5 组，带建议答法） | owner 要批量裁决时 |
| `pending-detail.md` | 原 AGENTS §7.3 台账逐条原文 | 看板某行的「详情」列指过来时 |
| `wg-status.md` | 工作组（WG1–WG12）状态与历史计划 | 追重编期分工 |
| `board-migration.md` | 看板来由：为什么建、基线、C1–C8、S1–S7 | 质疑看板设计是否合原意时 |
| `open-issues/01-chamfer-is-not-a-bevel.md` | 取证：chamfer 不是 bevel | 追该结论的依据 |
| `open-issues/02-chamfer-visualization-guesswork.md` | 取证：chamfer 可视化曾靠猜 | 同上 |
| `open-issues/03-renderer-merge-normal-attribute.md` | 取证：合批因 normal 不一致失败 | 同上 |
| `open-issues/04-wasm-untextured-surface-color.md` | 取证：无纹理面上色 | 同上 |
| `open-issues/05-wasmcore-bevel-doc-vs-code.md` | 取证：wasm-core bevel 文档 vs 代码 | 同上 |
| `open-issues/06-phy-hull-facet-jump.md` | 取证：.phy 凸包表达不了曲面坡 | 同上 |
| `open-issues/07-is-position-free-vs-trace.md` | 取证：is_position_free vs trace（卡死修法） | 同上 |

## 卷序（月度进展）

`2026-10` 按月切了 4 卷（每卷 ≤ 48 KB，按时间顺序）：`2026-10-1` → `2026-10-2` → `2026-10-3` → `2026-10-4`。每卷头部有「上一卷 / 下一卷」链接；右列「什么时候看」写着用途。新进展追加到**当月最后一卷**（本页右列会随之更新）。

