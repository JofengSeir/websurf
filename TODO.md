# TODO — 未结工作（可选清单）

> 2026-10-18 从旧 `progress/board.jsonl` 拆出。原看板、台账、claim、close-round 已删除；历史全文在 git tag `checkpoint/pre-amh-reset-20261018`。
> 这里不是门禁：直接增删行，不需要同步到任何地方。旧 ID 只作历史标签保留。

## T-730 — `collect_pakfile_models` 一次加载被重跑 4 遍（debug / game）

**状态**：满足（2026-10-18 三端 wasm 实测，验收数据见本节末）。
**现象**：`src/wasm-core/render_bundle.rs` 的 `collect_pakfile_models(bsp, vhv_log)` 在 debug / game 的一次加载里被 `export_model_tri_colliders` + `export_model_phy_colliders` + `export_mosaic_manifest` + `export_glb_with_pakfile_models*` 各调一次，合计 4 遍；viewer 只走 1 遍。
**实测**：同一进程按加载顺序调用 4 个导出（game wasm）—— `surf_concretejungle_fix`（17 MB）= 310 + 85 + 1440 + 1476 = **3311 ms**；`surf_kraken`（193 MB）= 7849 + 2392 + 22262 + 29339 = **61842 ms**。collect 单次成本近似：concretejungle 暖态 555 ms / 冷态 1376 ms；kraken 以最便宜的调用者暖态约 2.2 s 为上界。
**修法**：在 `BspProcessor` 里加一份收集结果缓存（`RefCell<Option<Rc<(...)>>>`，`Rc` 共享以免克隆三件套的大缓冲），把各处 `collect_pakfile_models(bsp, VhvLog::Always)` 换成 `self.collect_models()?`。注意 `VhvLog` 逐端不同（viewer `Never` / game `Always` / debug `IfAnyProp`）：缓存要按调用方口径决定首建那次打不打印，或把日志从缓存路径剥离。
**代价/风险**：① 缓存让模型三件套在整次加载期间常驻（kraken 632 个模型，量级待测）；② 要动 3 个 crate 的调用点（debug 7 / game 6 / viewer 3）；③ 这些导出会消费 BSP 数据，缓存只能前向复用，不能把「消费之后本该失败」的调用变成成功。
**判据**：① 至少两图（当前本地用 `surf_concretejungle_fix` + `surf_666`；`surf_kraken` 夹具不在本地）的 tri / phy / GLB sha256 与改前基线相同；mosaic manifest 因 `HashMap` 顺序不稳定，改比「解析 JSON、按键排序后的语义 sha」；② 同一加载顺序的 4 个导出合计耗时下降（记录改前/改后两个数）；③ 加载期间 wasm 线性内存峰值用 `WebAssembly.Memory.buffer.byteLength` 前后差记录数字；④ 三端 `typecheck` + `build:wasm` 通过；⑤ 三端 wasm 对同一图：game 与 debug 的 GLB 逐字节相同；viewer 与二者只在 `accessors[*].min/max` 浮点末位不同（基线即如此，不是缓存引入）；mosaic 三端语义 sha 相同。

**2026-10-18 验收（三端 wasm 实测）**：缓存实现见 commit `9ac0cce`（三个 `BspProcessor` 的 `RefCell<Option<(VhvLog, Rc<PakfileModels>)>>` + 共享层 `PakfileModels` / `collect_pakfile_models_bundle`；只读入口共享 `Rc`，消费 BSP 的 GLB 入口用 `take_models_for` 取走所有权）。基线取 `9ac0cce^`（`00aaa66`）独立 worktree 构建，同一 harness 各跑一遍（同进程 phy → tri → mosaic → glb；viewer 无 tri / phy 导出，按 mosaic → glb）。

| 图 / 端 | 合计 改前 → 改后 | tri | mosaic | glb |
|---|---|---|---|---|
| concretejungle game | 3081 → 2632 ms | 78 → 4 | 1285 → 1199 | 1430 → 1135 |
| concretejungle debug | 3301 → 2990 ms | 85 → 4 | 1342 → 1256 | 1572 → 1433 |
| concretejungle viewer | 3284 → 3050 ms | — | 1535 → 1538 | 1749 → 1512 |
| surf_666 game | 14750 → 12090 ms | 30 → 20 | 592 → 549 | 14094 → 11490 |
| surf_666 debug | 16271 → 16210 ms | 48 → 33 | 929 → 875 | 15255 → 15263 |
| surf_666 viewer | 15522 → 15261 ms | — | 826 → 807 | 14696 → 14454 |

- **sha**：三端 tri / phy / GLB 改前 = 改后；game 与 debug 的 GLB 逐字节相同（cj `58b53524…`、666 `5c1fcdae…`）。
- **viewer GLB 与二者不等**：差异只有 `accessors[*].min/max` 的浮点末位（cj 7 处，如 `482.75762939453125` vs `482.7576293945313`）；基线构建即如此 ⇒ 不是本次引入，端间 GLB 字节不能直接比。
- **mosaic**：原始字节 sha 每次不同（`HashMap` 序），语义 sha 三端一致（cj `eb7e9e4b…`、666 `62c71ef9…`），且改前 = 改后。
- **内存峰值**（`WebAssembly.Memory.buffer.byteLength`，含 BSP 装载）：cj 65.1 → 306.4 MB（debug / game）；viewer cj 249.5 → 306.4 MB（+56.9 MB：mosaic 阶段缓存的模型三件套在 GLB 阶段仍常驻）；666 306.4 → 655.5 MB（debug / game），viewer 655.0 MB 不变。
- 三端 `npm run typecheck` exit 0；三端 `build:wasm` 通过（产物 sha 由 `copy-wasm-pkg.mjs` 逐项校验）。

## T-650 — 透明材质未做半透/分层渲染（待 owner 拍板 D-120）

**状态**：实施中（D-120 选 (a) 做；2026-10-18 起）。
**现象**：`ice03` / `ice01` / `ice_transparent` 是 UnlitGeneric / `$translucent`，现按 owner 裁决吃光照，但没有半透明与分层渲染（owner 明确点过的缺口）。透明排序/混合未实现。
**本轮进度**：VMT 实测 —— `ice01/ice03` 是 UnlitGeneric 且**没有** `$translucent`；`ice_transparent` 是 LightmappedGeneric + `$translucent 1`（`ice02` 与 `models/ice_transparent` 是 VertexLitGeneric + `$translucent 1`）。GLB 侧 `ice_transparent` 已是 `BLEND`、`doubleSided`；本轮补：材质 extras 增加 `vbsp_translucent` / `vbsp_alpha_test`（世界面与模型两条路径），渲染端对 BLEND 材质强制 `depthWrite=false`。

**2026-10-18 验证（wasm 三端，`surf_boreas`）**：`ice_transparent` / `ice02` / `snowiceblend` 均为 `alphaMode=BLEND` 且 extras 带 `vbsp_translucent:true`；三端材质元数据逐项相同。GLB 字节数 game = debug = 123956464，viewer = 123956376（差 88 B，仍是已知的 `accessors.min/max` 浮点末位格式差异）。`ice01` / `ice03` 的 VMT 没有 `$translucent`（UnlitGeneric + `$surfaceprop ice`），保持 OPAQUE 是资产事实，不是漏做。**剩余**：浏览器三端同视点逐像素验收（本机无 headless 文件选择）。
**判据**：三端同视点下 `ice_transparent` 呈半透明（可透过看到后方几何）且三端逐像素一致；`$translucent` 材质在 GLB 材质 extras 有可判定的透明标记；三端 `npm run typecheck` exit 0 + 渲染一致性检查 exit 0。

## 渲染归属收口（2026-10-23）

**已完成**：新增 `src/renderer-shared/scene/render-session.ts`，把 GLB 之后的共享接线（装配/合并/环境/天空/相机/可见性/近平面/画质/探针/每帧天空+主世界）收成一份；viewer/game/debug 改为薄壳，删除 debug 的 `LodManager`。静态门禁 `src/scripts/check-render-parity.mjs` + CI `render-parity` job；文档 `docs/render-parity.md`；同机位截图工具 `src/scripts/capture-render.mjs`。AMH `mem_mvkhr473_1b3a3431f24c`。

**待 owner 定（剔除）**：当前可见性仍按**块中心**距离判定。main `79cff4b`（块表面距离）实测 666 有 44/108 个机位误杀、3 分钟后被 `588ebe2` 回退未写原因；rebuild `19b1d4a`（默认全加载 + 块表面 + 近裁面 10 射线，tag `safety-19b1d4a`）未采用。下一步候选：按**块 AABB 到相机**的距离判定，保留显式视距；恢复前用同机位三张图 + `__vbspPose` 做 A/B。

