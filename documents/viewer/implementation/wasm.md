# implementation/wasm：WASM 薄导出层

> 覆盖 `apps/viewer/crates/wasm/**`（crate `websurf-viewer-wasm`）与两份工程级 Cargo 配置：`apps/viewer/Cargo.toml`（workspace 与 patch）、`apps/viewer/crates/wasm/Cargo.toml`（依赖面与 wasm-pack 元数据）。

---

## 模块职责

`apps/viewer/crates/wasm/src/lib.rs` 是薄导出层：解析与合并全部落在共享解析层 `websurf-wasm-core`（`src/wasm-core/**`），本文件只做参数搬运与错误翻译（`apps/viewer/crates/wasm/src/lib.rs:30` 一次 `use` 覆盖 `bsp_to_gltf_core` / `model_integrator` / `pakfile_models` / `texture_utils` / `vbsp`）。

导出清单：

| 导出 | 形态 | 说明 | 锚点 |
|---|---|---|---|
| `BspProcessor` | `#[wasm_bindgen]` 结构体 | 持有 `Option<Arc<Bsp>>` 与构造期缓存的 pakfile 条目数 | `apps/viewer/crates/wasm/src/lib.rs:134` |
| `BspProcessor::new(data: &[u8])` | 构造器 | `vbsp::Bsp::read` + 缓存 zip 条目数 | `apps/viewer/crates/wasm/src/lib.rs:148` |
| `BspProcessor::metadata()` | 借用方法 | 元数据 JSON 字符串 | `apps/viewer/crates/wasm/src/lib.rs:162` |
| `BspProcessor::parse_spawn_points()` | 借用方法 | 出生点报告 JSON | `apps/viewer/crates/wasm/src/lib.rs:188` |
| `BspProcessor::export_glb_with_pakfile_models_with_defaults_and_lights(defaults_json)` | `&mut self` | **主导出入口**（2026-10-04 起与 game 同款）：PAKFILE 模型 + 缺失材质回退（`defaults_json`）+ `KHR_lights_punctual` 灯实体（渲染端 buildMapScene 摘除）；实现核失败时把 `Bsp` 放回实例（TS 侧回退裸导出） | `apps/viewer/crates/wasm/src/lib.rs:367` |
| `BspProcessor::export_glb_with_pakfile_models()` | `&mut self` | 裸导出（无回退表）：主导出失败时的 TS 侧回退路径 | `apps/viewer/crates/wasm/src/lib.rs:307` |
| `decompress_mtz(bytes)` | 模块级函数 | MTZ 容器（`MTZ6`/`MTZ5`）→ JSON 文本；TS 侧构建 defaults_json 用 | `apps/viewer/crates/wasm/src/lib.rs:443` |
| `BspMetadata` | 仅 `serde::Serialize`（**不**跨 wasm 边界） | 元数据的序列化载体 | `apps/viewer/crates/wasm/src/lib.rs:83` |

TS 侧的消费面有三个名字（`BspProcessor` / `decompress_mtz` / `initSync`；2026-10-04 起缺失纹理回退链路加入 `decompress_mtz`），契约清单由 `apps/viewer/scripts/check-wasm-api.mjs:36` 与 `apps/viewer/scripts/check-wasm-api.mjs:62` 守着（`VIEWER_API` 两项 + `BspProcessor` 类反向覆盖）；另有第三层 `BspMetadata` ↔ `BspMeta` 键名对齐（`apps/viewer/scripts/check-wasm-api.mjs:39`）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 顺序契约 | 两个 `export_glb_*` 都把内部 `Bsp` `take()` 走，必须排在 `metadata` / `parse_spawn_points` 之后；取走后再调它们返回「BSP 未解析或已导出」错误。TS 主链路：先试主导出，失败回退裸导出（`apps/viewer/src/core/bsp.ts:137` 到 `apps/viewer/src/core/bsp.ts:147`） | `apps/viewer/crates/wasm/src/lib.rs:307`、`apps/viewer/crates/wasm/src/lib.rs:367` |
| 元数据来源 | `schema_version` 固定 1；`magic` 由 header 的 v/b/s/p 四字节拼成；四个 lump 计数直接取长度；`num_static_props` 现数一遍；`packed_files` 用构造期缓存 | `apps/viewer/crates/wasm/src/lib.rs:106` 到 `apps/viewer/crates/wasm/src/lib.rs:116` |
| 出生点收录判据 | `classname` 命中 `SPAWN_CLASSNAMES` 之一，或以 `info_player_` 开头；`origin` 解析不出三个分量则整条跳过 | `apps/viewer/crates/wasm/src/lib.rs:228` 到 `apps/viewer/crates/wasm/src/lib.rs:238`、`apps/viewer/crates/wasm/src/lib.rs:248` 到 `apps/viewer/crates/wasm/src/lib.rs:254` |
| 出生点坐标变换 | `origin` 走 `rotate_yup`（`[x,y,z] → [y,z,x]`，正交且 det = +1），与地图 GLB 同一变换 | `apps/viewer/crates/wasm/src/lib.rs:223`、`apps/viewer/crates/wasm/src/lib.rs:273` |
| 角度保持原序 | `angles` 原样输出 BSP 的 `[pitch, yaw, roll]`（度），换算留给消费端 | `apps/viewer/crates/wasm/src/lib.rs:274`、`apps/viewer/src/core/spawn.ts:58` |
| `primary` 规则 | 首个 `info_player_start` 的收录下标；没有则回落收录列表第 0 条；列表为空为 null | `apps/viewer/crates/wasm/src/lib.rs:267` 到 `apps/viewer/crates/wasm/src/lib.rs:269`、`apps/viewer/crates/wasm/src/lib.rs:281` 到 `apps/viewer/crates/wasm/src/lib.rs:283` |
| 实体文本已小写 | 输入来自共享层 `read_entities`（整段小写化），故本文件的 classname 字面量全用小写 | `apps/viewer/crates/wasm/src/lib.rs:228`、`src/wasm-core/vbsp/reader.rs:71` |
| 三件套收集 | 只收 `static_props` / 带模型实体引用的模型名在 zip 里命中的条目，缺任一件即跳过；同时顺手挑 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`（同 idx 上 HDR 优先）——P5-2 起实现在共享层 | `src/wasm-core/render_bundle.rs:94` 到 `src/wasm-core/render_bundle.rs:102`、`src/wasm-core/render_bundle.rs:114` 到 `src/wasm-core/render_bundle.rs:131`、`src/wasm-core/render_bundle.rs:140` 到 `src/wasm-core/render_bundle.rs:165` |
| zip 锁只锁一次 | 整轮条目扫描期间持锁，扫描结束立刻释放（共享层实现） | `src/wasm-core/render_bundle.rs:106` 到 `src/wasm-core/render_bundle.rs:135` |
| 缺失纹理回退 | pakfile 内没有该 VTF 时按 `$basetexture` 路径与材质名依次查默认纹理包（`textures.mtz` 解压表，键 `materials/<小写路径>`），命中即把低清纹理嵌进 GLB；主导出才传回退表，裸导出传 `None`（2026-10-04 起，viewer 材质纯色的根因修复）；解析体在共享层 | `src/wasm-core/render_bundle.rs:314` 起、`apps/viewer/crates/wasm/src/lib.rs:331`（传 `None`）、`apps/viewer/crates/wasm/src/lib.rs:416`（传回退表） |
| 材质解析四步 | `.mdl` 纹理名表 → 按搜索目录拼候选路径找 `.vmt` → 必要时跟一层 `patch` include 取母材质 `$basetexture` → 用 `$basetexture` 找 `.vtf` 并解码 PNG（P5-2 起在共享层） | `src/wasm-core/render_bundle.rs:314` 到 `src/wasm-core/render_bundle.rs:433` |
| 失败只跳过不报错 | `.mdl` 读不出、VMT 找不到、`$basetexture` 缺失、VTF 取不到或解码失败都只跳过对应项；VMT 缺失时该材质按 Opaque 记一笔（共享层实现） | `src/wasm-core/render_bundle.rs:314` 到 `src/wasm-core/render_bundle.rs:433` |
| 无模型时回退纯地图导出 | 一个被引用模型都没收集到时改用 `bsp_to_gltf_core::export_bsp`，不报错 | `apps/viewer/crates/wasm/src/lib.rs:317` 到 `apps/viewer/crates/wasm/src/lib.rs:327` |
| 错误翻译格式 | `to_js_err` 把任意 Debug 错误压成 `"{上下文}: {Debug}"` 字符串 | `apps/viewer/crates/wasm/src/lib.rs:45` 到 `apps/viewer/crates/wasm/src/lib.rs:47` |
| 依赖面最小 | crate 只依赖共享解析层与绑定/序列化/图像四类；不依赖 `websurf-phys`，不含 mosaic / 默认纹理包 | `apps/viewer/crates/wasm/Cargo.toml:18` 到 `apps/viewer/crates/wasm/Cargo.toml:36` |
| patch 指向 vendored vmdl | workspace 级 `[patch.crates-io]` 把 `vmdl` 指到 `src/vendor/vmdl` | `apps/viewer/Cargo.toml:12` 到 `apps/viewer/Cargo.toml:13` |
| release 配置 | `opt-level = 3` + `lto = true` + `codegen-units = 1`；wasm-pack 侧跳过二次 `wasm-opt` | `apps/viewer/Cargo.toml:18` 到 `apps/viewer/Cargo.toml:21`、`apps/viewer/crates/wasm/Cargo.toml:39` 到 `apps/viewer/crates/wasm/Cargo.toml:40` |

## 已知缺口（状态见 TODO.md）

1. ~~**`.MDL` 大小写会让「三件齐」检查失效**~~ **已消除（2026-10-09）**：两条判据都已按大小写无关处理——`.mdl` 判定走 `to_ascii_lowercase().ends_with(".mdl")`（`src/wasm-core/render_bundle.rs:142`），配对名改用**按长度切片**再拼后缀（不再用区分大小写的 `replace`，见 `src/wasm-core/render_bundle.rs:145` 到 `src/wasm-core/render_bundle.rs:146` 的注释「T-144 / T-218」）。
2. ~~**模型名匹配与材质查找口径不一致**~~ **已消除（2026-10-09）**：T-145 —— 两侧都改成大小写无关：模型名集合建时按 `case_insensitive_model_names` 折叠（viewer 传 `true` ⇒ `to_ascii_lowercase()`）（`src/wasm-core/render_bundle.rs:85` 到 `src/wasm-core/render_bundle.rs:102`），比对用 `referenced.contains(&fold(name))`（`src/wasm-core/render_bundle.rs:142`），与材质查找（`pakfile_models::PakIndex`）同口径。原断言：模型名用 `referenced.contains(name)` 精确比较，材质查找走 `PakIndex`（大小写不敏感）。
3. ~~**锁中毒会 panic**~~ **已消除（2026-10-09）**：T-146 —— `BspProcessor::new` 里那把锁的 `PoisonError` 经 `map_err` 转成 `JsValue`（`"pakfile 锁定失败: {e}"`）再由 `?` 返回，与同文件其它失败点形态一致（`apps/viewer/crates/wasm/src/lib.rs:151`），该路径**由构造保证不再 panic**。`wasm-pack build`（viewer）**exit 0**；宿主跑不了 `cargo test`（缺 `dlltool.exe`）。
4. **材质去重键是材质名**：`resolve_pakfile_materials` 用 `out.alpha_modes.contains_key(&tex.name)` 判「已解析过」（`src/wasm-core/render_bundle.rs:340`）⇒ 不同模型对同名材质给出不同 `search_paths` 时，首次命中的 VMT 会被后续模型复用。（见 TODO.md T-147）
5. ~~**同一份元数据两套待遇**~~ **已消除（2026-10-09）**：T-148 —— `num_static_props` 现在与 `packed_files` 一样**在构造期算一次**并存入 `BspProcessor::cached_static_props`，`BspMetadata::from_bsp` 只接收缓存值（`apps/viewer/crates/wasm/src/lib.rs:152`），不再每次 `metadata()` 线性扫 `static_props()`。判据实测：`git grep -n "static_props()" -- apps/viewer/crates/wasm/src/lib.rs` ⇒ 唯一调用点在构造期。
6. ~~**`map_name` 实际不可用**~~ **已消除（2026-10-09）**：T-149 结案为**不做**——Rust 端恒写空串（`apps/viewer/crates/wasm/src/lib.rs:109`），TS 侧该字段可选（`apps/viewer/src/core/bsp.ts:30`），两端都无来源、字段仅占位；删除属 `OWNER.md` D-103 禁区，故保留占位并结案。
7. ~~**`apps/viewer/Cargo.toml:11` 的说明把 `test` 列为同款 patch 持有方**~~ **已消除（2026-10-07）**：该行现已写「与 `apps/debug`、`apps/game` 同款 `[patch.crates-io]`」，不再提 `test`（`apps/viewer/Cargo.toml:11` 到 `apps/viewer/Cargo.toml:13`）；实测 `git grep -n "test" -- apps/viewer/Cargo.toml` = 0 命中。（见 TODO.md T-150）
8. **`BspMetadata` 的字段与 TS 契约靠约定对齐**：Rust 端用 `serde::Serialize` 的字段名（`apps/viewer/crates/wasm/src/lib.rs:82` 到 `apps/viewer/crates/wasm/src/lib.rs:95`）与 TS 侧 `BspMeta` 的可选字段（`apps/viewer/src/core/bsp.ts:27` 到 `apps/viewer/src/core/bsp.ts:37`）逐字段对应，但两侧都没有把对方纳入编译期校验：重命名字段时 TS 侧只会静默拿到 `undefined`（消费点 `apps/viewer/src/ui/mapinfo.ts:157` 起用 `?? Number.NaN` 兜底显示 `—`）。**已消除（2026-10-09）**：T-151 —— `apps/viewer/scripts/check-wasm-api.mjs` 加了第三层断言 `assertStructFieldsMatchInterface`（引擎在 `src/scripts/lib/wasm-api-contract.mjs`）：解析 Rust `BspMetadata` 的 serde 键名（含 `rename` / `rename_all`）与 TS `BspMeta` 的接口键名，任一方向缺键即非零退出。实测：现网 9 ↔ 9 通过；把 TS 侧 `num_static_props` 改名后 `npm run check:api` **exit 1** 并点名 `missingInTs: [num_static_props]` / `missingInRust: [numStaticProps]`。
