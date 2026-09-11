# tick→渲染折线 垂距基线（Step 0）

## ⚠️ CI 夹具与两个夹具的语义（2026-09-11）

CI 门 `npm run test:path-acceptance`（`.github/workflows/deploy-pages.yml` 内、
`debug/` 块、紧跟「权威时钟验证」之后）跑的是
`node scripts/path-acceptance.mjs fixtures/path/tick-on-render-prefix.json --assert --expect fail`。

### 夹具 1：`tick-on-render-prefix.json` —— **缺陷存在时**的录制（当前 CI 输入）

= 下表最后一行的 `phys-path-20260911-033319.json` 逐字副本（修复前**最差**的一次
真实录制；实测**稳态 p95 = 36.52 HU**、max = 116.92 HU、毛刺 12.82%，验收阈值为
稳态 p95 ≤ 2 HU / max ≤ 10 HU）。

它**固化了旧行为**：即使 worker 侧修好（发布位置 = 渲染轨迹上的一个采样点），拿它跑
门禁**仍然会失败**——所以它**不能**当"修好后的验收输入"。它的用途是**判别力自检**：
`--expect fail` 断言"这道门必须能识破缺陷"，实测 fail ⇒ 命中预期 ⇒ 退出 0。
换句话说：CI 绿的语义是「度量确实有判别力」，而不是「轨迹已经对齐」。

### 夹具 2：`tick-on-render.json` —— **修复后**的真实录制（待补，`--expect pass`）

顺序依赖：worker 侧「权威发布位置 = 渲染轨迹上的一个采样点」+ 主线程侧
`writeRenderSample`/τ 同源落地后，重新录一段真实轨迹导出为
`fixtures/path/tick-on-render.json`，再加一个 `--expect pass` 的 npm 脚本
（或把本脚本的 `--expect` 切到 `pass`）——**在那之前不要**把它写进 CI：
用 prefix 夹具配 `pass` 会真红，配 `fail` 才是当前语义。

夹具入库靠根 `.gitignore` 地图区块后的两条例外（`!debug/fixtures/path/`、
`!debug/fixtures/path/*.json`），`git check-ignore -v` 对夹具**不应报 ignored**
（当前输出命中的是 `!` 取反规则 = 未忽略；`git add --dry-run` 可入库为准）。

生成时间: 2026-09-10T19:59:18.905Z

阈值（稳态总体）: p95 ≤ 2 HU, max ≤ 10 HU, 毛刺(>30 HU) ≤ 1.0%, 剔除点 ≤ 10.0%

度量 = 每个 tick 点到渲染折线（合格线段，跳变>100HU 断开）的最短距离；
剔除 = 渲染侧与 tick 侧所有 >D 跳变前后 ±500ms（传送邻近，不计入）。

| 文件 | 构建 | tick 点 | 稳态 p50 | **稳态 p95** | 稳态 max | 毛刺占比 | 剔除占比 | 时间对齐 mean | 残差 p95 |
|---|---|---|---|---|---|---|---|---|---|
| phys-path-20260911-013253.json | 旧 | 1296 | 11.67 | **39.05** | 42.77 | 14.77% | 4.9% | 19.64 | — |
| phys-path-20260911-030601.json | 新 | 1647 | 9.02 | **29.08** | 30.06 | 0.06% | 4.2% | 22.53 | — |
| phys-path-20260911-031201.json | 新 | 1010 | 1.36 | **2.39** | 3.75 | 0.00% | 13.2% | 8.68 | — |
| phys-path-20260911-033319.json | 新 | 1692 | 4.72 | **36.52** | 116.92 | 12.82% | 4.1% | 21.54 | — |
