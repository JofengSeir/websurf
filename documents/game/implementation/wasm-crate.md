# implementation / wasm-crate（`apps/game/crates/wasm/**`）

## 模块职责

本工程唯一的 Rust crate（workspace 成员见 `apps/game/Cargo.toml:7`），把共享解析层与共享物理层暴露给 JavaScript。

`apps/game/crates/wasm/src/lib.rs` 的导出面分两块：

| 导出 | 说明 | 锚点 |
|---|---|---|
| `mosaic_encode` | PNG 字节 → `#mosaic v4` 字节码文本 | `apps/game/crates/wasm/src/lib.rs:71` |
| `mosaic_decode` | 字节码 → PNG 字节（带最近邻放大倍数） | `apps/game/crates/wasm/src/lib.rs:78` |
| `decompress_mtz` | MTZ 容器字节 → `键 → 字节码` 的 JSON 文本 | `apps/game/crates/wasm/src/lib.rs:87` |
| `BspProcessor` | 持有已解析 BSP，17 个 wasm 方法：构造器、元数据、GLB 六个导出入口、两个模型碰撞体导出、两个纹理清单导出、三个阶段解析、brush 凸包导出、存活查询 | `apps/game/crates/wasm/src/lib.rs:180`、`:190`、`:212`、`:226`、`:253`、`:266`、`:290`、`:371`、`:429`、`:492`、`:654`、`:804`、`:832`、`:850`、`:977`、`:1433`、`:1586`、`:791` |

非导出的内部辅助：`to_js_err`（`:46`）、`decode_vtf_to_png`（`:52`）、`BspMetadata` 与其 `impl`（`:110`、`:133`）。PAKFILE 三件套与材质 / 光源 / 碰撞体派生（`PakMaterials`、`VhvLog`、`collect_pakfile_models`、`collect_light_entities`、`load_vmdl`、`build_vmt_stem_index`、`resolve_pakfile_materials`、`ColliderFilter`、`entity_is_non_solid`、`model_classnames`、`brush_model_indices`、`build_brush_model_origins`、`aabb_volume`）已在 P5-2 收编进共享层 `src/wasm-core/render_bundle.rs`：`:43`、`:59`、`:79`、`:224`、`:258`、`:273`、`:313`、`:447`、`:484`、`:494`、`:519`、`:556`、`:620`。

Cargo 侧的三条关键声明：共享物理层 path 依赖（`apps/game/crates/wasm/Cargo.toml:22`）、共享解析层 path 依赖（`apps/game/crates/wasm/Cargo.toml:24`）、关闭 wasm-pack 的二次优化（`apps/game/crates/wasm/Cargo.toml:88`）。

## 关键流程与不变量

- **借用式导出**：`take_bsp` 只克隆 `Arc`，导出成功或失败都不消费实例（`apps/game/crates/wasm/src/lib.rs:204`）；`is_alive` 在构造成功后恒为 `true`（`:791`）。唯一的取走式建实例点是构造器（`:190`）。
- **PAKFILE 三件套门**：按大小写不敏感判 `.mdl`，再按精确名取 `.vvd` 与 `.dx90.vtx`，任一件缺失即跳过该模型（共享层 `src/wasm-core/render_bundle.rs:142` 到 `:157`）。
- **`sp_*.vhv` 的 LDR/HDR 择一**：同一下标下 HDR 版覆盖先到者，LDR 版不覆盖已存入的 HDR 版（`src/wasm-core/render_bundle.rs:126`）。
- **元数据结构不标导出宏**：`BspMetadata` 含 `String` 字段，故只经 `serde_json` 序列化成文本返回（`apps/game/crates/wasm/src/lib.rs:110`、`:164`）；`schema_version` 固定 1（`:144`）。
- **导出选项由 `ConvertOptions` 承载**：缺失纹理回退表、基名 VMT 索引、缺失清单开关与图集面积上界四项（`apps/game/crates/wasm/src/lib.rs:314`）；`generate_missing_list` 为真时导出期同时收集缺失清单（`:317`）。
- **PHY 顶点要过两级变换**：先做 IVP → Source 坐标换算（`(x, z, -y)`，纯旋转、det 为 +1），再施加与显示端相同的根骨骼变换，最后按放置表搬进世界空间（`apps/game/crates/wasm/src/lib.rs:731`、`:733`、`:474`）。
- **brush 导出的自证计数**：九个具名跳过分支之和等于 `skipped`，且 `exported + skipped == total` 时统计行末尾为 `ok`，否则为 `MISMATCH`（`apps/game/crates/wasm/src/lib.rs:1940` 到 `:1973`）。
- **默认纹理包的解压口在本工程由主线程使用**：`decompress_mtz` 经 `buildWorldBundle` 的 `decompressMtz` 注入（`apps/game/src/app.ts:516`、`src/ts-shared/phys/world-builder.ts:260`）。

## 已知缺口（状态见 TODO.md）

- ~~**`start_disabled` 恒为 false**~~ **已消除（2026-10-09）**：T-015 —— 绑定层原来按**大写**键 `.prop("StartDisabled")` 取值，而实体文本读入时已整体小写、`RawEntity::prop` 又是逐字节比较 ⇒ 必然取不到并被 `.unwrap_or(false)` 吞掉。现改为小写键 `.prop("startdisabled")`（`apps/game/crates/wasm/src/lib.rs:1255`、`apps/debug/crates/wasm/src/lib.rs:1475`，两处均 1:1）。**取证**：`test/maps/surf_fornax.bsp` 的实体文本里有且只有 1 处 `StartDisabled 1`，修复后 `parse_teleports()` 的 `triggers` 里恰有 **1** 条 `start_disabled=true`（`nebula2_startroom_dest`）；`surf_666` 的 420 处 `StartDisabled` 全为 `0` ⇒ 0 条禁用（与文本一致）。
3. ~~**`BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方）**~~ **已消除（2026-10-09）**：T-217 —— 悬空那个（原 `apps/game/crates/wasm/src/lib.rs:164`）连同其后的空行一起删除（净 −2 行），现在与 viewer 同形：属性各归其项（结构体一处、`impl` 一处，`apps/game/crates/wasm/src/lib.rs:179` 与 `:186`）。因该文件有 32 处文档锚点，先按 `git diff -U0` 建映射把 `:480` 之后的 **29 处重编号**再 `sync`。**验证**：`cd apps/game && npm run build:wasm` ⇒ exit 0。**附带的同族修复**：同一文件 `new` 里的 `lock().unwrap()`（原 `:504`）也改成 `map_err(...)?`——与 viewer 的 T-146 同一处缺陷。
- **`export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点**：方法有完整实现（`apps/game/crates/wasm/src/lib.rs:266`），而 `apps/game` 的 `.ts` 与 `.mjs` 内零匹配（本次实测；`apps/debug` 侧有实现，见 `apps/debug/crates/wasm/src/lib.rs:404`）。 （见 TODO.md T-236）
- ~~**`map_name` 恒为空串**~~ **已消除（2026-10-09）**：T-237 —— **遗弃（与已结案的 T-149 同一条）**：该字段是两端都无来源的**占位**（Rust 端恒写空串、TS 侧字段可选），删除属 `OWNER.md` D-103 禁区，故保留占位、不再单列一行。
- **`packed_files` 与其它计数来源不同**：该字段在构造时算一次并缓存（`apps/game/crates/wasm/src/lib.rs:193`、`:196`），其余计数在每次 `metadata()` 时经 `BspMetadata::from_bsp` 重新统计（`:137`、`:138`，调用点 `:217`）。
- **`.mdl` 配对名用大小写敏感的 `replace`**：判据本身大小写不敏感（`src/wasm-core/render_bundle.rs:142`），而配对名由 `replace(".mdl", …)` 生成（`:144`、`:145`）；zip 条目名不是全小写时两次 `pack.get` 会取回同一份 `.mdl` 字节填进 `.vvd` / `.dx90.vtx` 槽位，「三件齐」的判据在该情形下不再区分三件。 **已消除（2026-10-09）**：配对名改为「**去掉尾部 4 字节**（`.mdl`，任意大小写）再拼后缀」——`format!("{}.vvd", &name[..name.len() - 4])`（`:144`）与 `format!("{}.dx90.vtx", …)`（`:145`）。**同源代码当时另有两份**（game / debug / viewer 各一份副本；P5-2 已把三份收编为共享单实现 `src/wasm-core/render_bundle.rs:140` 到 `:164`），一并在同一提交修掉，三文件均 1:1。**回归实测**（重建 debug wasm 后）：`surf_fornax` / `surf_null` / `surf_666` 的 `export_glb_with_pakfile_models()` 输出与修复前**逐字节一致**（86191792 / 91835004 / 75732972，sha256 相同）⇒ 正常路径行为不变。**注**：该缺陷在本地 8 个地图上**不可复现**——550 个模型条目全部小写（探针实测「大小写异常 0」），故属**潜在**缺陷（地图打包工具写出大写条目时才触发），修复由代码路径保证。
- **顶点法向翻转回退只覆盖 `verts_bsp < 4` 的情形**：导出 brush 时先按原平面算顶点，不足 4 个才把全部平面法线与 `dist` 取负重算一次（`apps/game/crates/wasm/src/lib.rs:1852` 到 `:1867`）；仍不足 4 个才落到 `skipped_verts_lt4` 分支（`:1872` 到 `:1874`）。
- **单页图集面积上界的默认值不在本 crate 内**：`lightmap_max_atlas_area` 传 0 时沿用共享层的政策上界（`apps/game/crates/wasm/src/lib.rs:257`），本 crate 只做「非有限值或 ≤ 0 一律按 0 处理」的入口校验（`:273` 到 `:277`）。
