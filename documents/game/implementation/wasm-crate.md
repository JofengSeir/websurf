# implementation / wasm-crate（`apps/game/crates/wasm/**`）

## 模块职责

本工程唯一的 Rust crate（workspace 成员见 `apps/game/Cargo.toml:7`），把共享解析层与共享物理层暴露给 JavaScript。

`apps/game/crates/wasm/src/lib.rs` 的导出面分两块：

| 导出 | 说明 | 锚点 |
|---|---|---|
| `mosaic_encode` | PNG 字节 → `#mosaic v4` 字节码文本 | `apps/game/crates/wasm/src/lib.rs:242` |
| `mosaic_decode` | 字节码 → PNG 字节（带最近邻放大倍数） | `apps/game/crates/wasm/src/lib.rs:249` |
| `decompress_mtz` | MTZ 容器字节 → `键 → 字节码` 的 JSON 文本 | `apps/game/crates/wasm/src/lib.rs:258` |
| `BspProcessor` | 持有已解析 BSP，17 个 wasm 方法：构造器、元数据、GLB 五个导出入口、两个模型碰撞体导出、两个纹理清单导出、三个阶段解析、brush 凸包导出、存活查询 | `apps/game/crates/wasm/src/lib.rs:493`、`:503`、`:525`、`:539`、`:566`、`:579`、`:603`、`:683`、`:740`、`:801`、`:946`、`:1083`、`:1096`、`:1122`、`:1140`、`:1267`、`:1723`、`:1876` |

非导出的内部辅助：`to_js_err`（`:42`）、`PakMaterials`（`:53`）、`collect_pakfile_models`（`:66`）、`collect_light_entities`（`:186`）、`decode_vtf_to_png`（`:221`）、`load_vmdl`（`:264`）、`build_vmt_stem_index`（`:281`）、`resolve_pakfile_materials`（`:312`）、`BspMetadata` 与其 `impl`（`:421`、`:444`），以及文件末段的 brush 过滤辅助：`ColliderFilter`（`:2388`）、`entity_is_non_solid`（`:2425`）、`model_classnames`（`:2436`）、`brush_model_indices`（`:2464`）、`build_brush_model_origins`（`:2504`）、`aabb_volume`（`:2568`）。

Cargo 侧的三条关键声明：共享物理层 path 依赖（`apps/game/crates/wasm/Cargo.toml:22`）、共享解析层 path 依赖（`apps/game/crates/wasm/Cargo.toml:24`）、关闭 wasm-pack 的二次优化（`apps/game/crates/wasm/Cargo.toml:88`）。

## 关键流程与不变量

- **借用式导出**：`take_bsp` 只克隆 `Arc`，导出成功或失败都不消费实例（`apps/game/crates/wasm/src/lib.rs:517`、`:520`）；`is_alive` 在构造成功后恒为 `true`（`:1083`）。唯一的取走式建实例点是构造器（`:503`）。
- **PAKFILE 三件套门**：按大小写不敏感判 `.mdl`，再按精确名取 `.vvd` 与 `.dx90.vtx`，任一件缺失即跳过该模型（`apps/game/crates/wasm/src/lib.rs:114`、`:117`、`:118`、`:119`、`:123`、`:127`）。
- **`sp_*.vhv` 的 LDR/HDR 择一**：同一下标下 HDR 版覆盖先到者，LDR 版不覆盖已存入的 HDR 版（`apps/game/crates/wasm/src/lib.rs:99`、`:100`）。
- **元数据结构不标导出宏**：`BspMetadata` 含 `String` 字段，故只经 `serde_json` 序列化成文本返回（`apps/game/crates/wasm/src/lib.rs:418`、`:475`）；`schema_version` 固定 1（`:455`）。
- **导出选项由 `ConvertOptions` 承载**：缺失纹理回退表、基名 VMT 索引、缺失清单开关与图集面积上界四项（`apps/game/crates/wasm/src/lib.rs:627`）；`generate_missing_list` 为真时导出期同时收集缺失清单（`:630`）。
- **PHY 顶点要过两级变换**：先做 IVP → Source 坐标换算（`(x, z, -y)`，纯旋转、det 为 +1），再施加与显示端相同的根骨骼变换，最后按放置表搬进世界空间（`apps/game/crates/wasm/src/lib.rs:1023`、`:1025`、`:1047`）。
- **brush 导出的自证计数**：九个具名跳过分支之和等于 `skipped`，且 `exported + skipped == total` 时统计行末尾为 `ok`，否则为 `MISMATCH`（`apps/game/crates/wasm/src/lib.rs:2008`、`:2026`、`:2043`）。
- **默认纹理包的解压口在本工程由主线程使用**：`decompress_mtz` 经 `buildWorldBundle` 的 `decompressMtz` 注入（`apps/game/src/app.ts:516`、`src/ts-shared/phys/world-builder.ts:235`）。

## 已知缺口

- **`start_disabled` 恒为 false**：触发器的该字段按**大写**键取值（`apps/game/crates/wasm/src/lib.rs:1545`），而实体文本在读入时已整体转小写（`src/wasm-core/vbsp/reader.rs` 的 `read_entities`），且属性查询是逐字节比较，取值必然失败、被 `.unwrap_or(false)` 吞掉（`apps/game/crates/wasm/src/lib.rs:1547`）。
- **`BspProcessor` 上叠了两个 `#[wasm_bindgen]` 属性**：一处悬空在结构体之前的注释块上方（`apps/game/crates/wasm/src/lib.rs:480`），一处紧随结构体（`:492`）。本次实测 `cargo check --manifest-path apps/game/crates/wasm/Cargo.toml` 以退出码 0 结束、未报重复属性，故该形态不影响当前构建。
- **`export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点**：方法有完整实现（`apps/game/crates/wasm/src/lib.rs:579`），而 `apps/game` 的 `.ts` 与 `.mjs` 内零匹配（本次实测；`apps/debug` 侧有引用，见 `apps/debug/crates/wasm/src/lib.rs:692`）。
- **`map_name` 恒为空串**：元数据里的该字段在 Rust 侧写死 `String::new()`（`apps/game/crates/wasm/src/lib.rs:457`），消费端拿到的值恒为空；工程内展示地图名走的是文件名字符串（`apps/game/src/app.ts:501`）。
- **`packed_files` 与其它计数来源不同**：该字段在构造时算一次并缓存（`apps/game/crates/wasm/src/lib.rs:506`、`:496`），其余计数在每次 `metadata()` 时重新统计（`:448`、`:449`）。
- **`.mdl` 配对名用大小写敏感的 `replace`**：判据本身大小写不敏感（`apps/game/crates/wasm/src/lib.rs:114`），而配对名由 `replace(".mdl", …)` 生成（`:117`、`:118`）；zip 条目名不是全小写时两次 `pack.get` 会取回同一份 `.mdl` 字节填进 `.vvd` / `.dx90.vtx` 槽位，「三件齐」的判据在该情形下不再区分三件。
- **顶点法向翻转回退只覆盖 `verts_bsp < 4` 的情形**：导出 brush 时先按原平面算顶点，不足 4 个才把全部平面法线与 `dist` 取负重算一次（`apps/game/crates/wasm/src/lib.rs:2149`、`:2165`）；仍不足 4 个才落到 `skipped_verts_lt4` 分支（`:2169`）。
- **单页图集面积上界的默认值不在本 crate 内**：`lightmap_max_atlas_area` 传 0 时沿用共享层的政策上界（`apps/game/crates/wasm/src/lib.rs:575`），本 crate 只做「非有限值或 ≤ 0 一律按 0 处理」的入口校验（`:586`）。
