# TODO — 未结工作（可选清单）

> 2026-10-18 从旧 `progress/board.jsonl` 拆出。原看板、台账、claim、close-round 已删除；历史全文在 git tag `checkpoint/pre-amh-reset-20261018`。
> 这里不是门禁：直接增删行，不需要同步到任何地方。旧 ID 只作历史标签保留。

## T-730 — `collect_pakfile_models` 一次加载被重跑 4 遍（debug / game）

**状态**：未满足（缓存已落地；game 两图通过，debug / viewer、基线 sha、内存峰值未做）。
**现象**：`src/wasm-core/render_bundle.rs` 的 `collect_pakfile_models(bsp, vhv_log)` 在 debug / game 的一次加载里被 `export_model_tri_colliders` + `export_model_phy_colliders` + `export_mosaic_manifest` + `export_glb_with_pakfile_models*` 各调一次，合计 4 遍；viewer 只走 1 遍。
**实测**：同一进程按加载顺序调用 4 个导出（game wasm）—— `surf_concretejungle_fix`（17 MB）= 310 + 85 + 1440 + 1476 = **3311 ms**；`surf_kraken`（193 MB）= 7849 + 2392 + 22262 + 29339 = **61842 ms**。collect 单次成本近似：concretejungle 暖态 555 ms / 冷态 1376 ms；kraken 以最便宜的调用者暖态约 2.2 s 为上界。
**修法**：在 `BspProcessor` 里加一份收集结果缓存（`RefCell<Option<Rc<(...)>>>`，`Rc` 共享以免克隆三件套的大缓冲），把各处 `collect_pakfile_models(bsp, VhvLog::Always)` 换成 `self.collect_models()?`。注意 `VhvLog` 逐端不同（viewer `Never` / game `Always` / debug `IfAnyProp`）：缓存要按调用方口径决定首建那次打不打印，或把日志从缓存路径剥离。
**代价/风险**：① 缓存让模型三件套在整次加载期间常驻（kraken 632 个模型，量级待测）；② 要动 3 个 crate 的调用点（debug 7 / game 6 / viewer 3）；③ 这些导出会消费 BSP 数据，缓存只能前向复用，不能把「消费之后本该失败」的调用变成成功。
**判据**：① 至少两图（当前本地用 `surf_concretejungle_fix` + `surf_666`；`surf_kraken` 夹具不在本地）的 tri / phy / GLB sha256 与改前基线相同；mosaic manifest 因 `HashMap` 顺序不稳定，改比「解析 JSON、按键排序后的语义 sha」；② 同一加载顺序的 4 个导出合计耗时下降（记录改前/改后两个数）；③ 加载期间 wasm 线性内存峰值用 `WebAssembly.Memory.buffer.byteLength` 前后差记录数字；④ 三端 `typecheck` + `build:wasm` 通过；⑤ 三端 wasm 对同一图给同一组 GLB sha（mosaic 另按语义 sha）。

**2026-10-18 进展（game 实测）**：三个 `BspProcessor` 加 `RefCell<Option<(VhvLog, Rc<PakfileModels>)>>` 缓存；共享层加 `PakfileModels` / `collect_pakfile_models_bundle`；只读入口（tri / phy / mosaic / missing-model-textures）共享 `Rc`，消费 BSP 的 GLB 入口用 `take_models_for` 取走所有权，避免复制模型字节。game wasm 实测（同一进程按 phy → tri → mosaic → glb 顺序）：
- `surf_concretejungle_fix`：phy 288→294 ms、tri 78→4 ms、mosaic 1285→1199 ms、glb 1430→1135 ms；tri / phy / GLB 的 sha256 与改前相同。
- `surf_666`：phy 34→31 ms、tri 30→20 ms、mosaic 592→549 ms、glb 14094→11490 ms；GLB sha256 与改前相同。
- **判据①对 mosaic 不成立（不是缓存缺陷）**：mosaic manifest 是 `HashMap` 序列化，同进程连续两次调用 sha 也不同（实测 `868e5a…` / `878a36…` / `5a522f…`，字节数都 85097）；应改成「解析 JSON、按键排序后的语义 sha」。
- 剩余：debug / viewer 的 wasm 实跑（本轮只做了 `cargo check`）、wasm 线性内存峰值、三端同图 GLB sha、mosaic 语义 sha。

## T-650 — 透明材质未做半透/分层渲染（待 owner 拍板 D-120）

**状态**：待裁决。
**现象**：`ice03` / `ice01` / `ice_transparent` 是 UnlitGeneric / `$translucent`，现按 owner 裁决吃光照，但没有半透明与分层渲染（owner 明确点过的缺口）。透明排序/混合未实现。
**判据**：三端同视点下 `ice_transparent` 呈半透明（可透过看到后方几何）且三端逐像素一致；`$translucent` 材质在 GLB 材质 extras 有可判定的透明标记；三端 `npm run typecheck` exit 0 + 渲染一致性检查 exit 0。

## T-651 — 洞顶冰锥 `.vhv` 全 0（待 owner 拍板 D-121）

**状态**：待裁决。
**现象**：`icicle_01~05` 的 `.vhv` 全 0 —— VRAD 判定顶点落在岩石内部（`vradstaticprops.cpp` 的 PositionInSolid）⇒ 明确留黑，数据层面无解，须换光源策略。
**判据**：owner 选定光源策略（例如给冰锥指定 lighting origin / 独立环境光）后，三端同视点冰锥有明暗且逐像素一致；未拍板前不改数据。
