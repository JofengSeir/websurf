# implementation/wasm：WASM 薄导出层

> 覆盖 `apps/viewer/crates/wasm/**`（crate `websurf-viewer-wasm`）与两份工程级 Cargo 配置：`apps/viewer/Cargo.toml`（workspace 与 patch）、`apps/viewer/crates/wasm/Cargo.toml`（依赖面与 wasm-pack 元数据）。

---

## 模块职责

`apps/viewer/crates/wasm/src/lib.rs` 是薄导出层：解析与合并全部落在共享解析层 `websurf-wasm-core`（`src/wasm-core/**`），本文件只做参数搬运与错误翻译（`apps/viewer/crates/wasm/src/lib.rs:31` 一次 `use` 覆盖 `bsp_to_gltf_core` / `model_integrator` / `pakfile_models` / `texture_utils` / `vbsp`）。

导出清单：

| 导出 | 形态 | 说明 | 锚点 |
|---|---|---|---|
| `BspProcessor` | `#[wasm_bindgen]` 结构体 | 持有 `Option<Arc<Bsp>>` 与构造期缓存的 pakfile 条目数 | `apps/viewer/crates/wasm/src/lib.rs:414`、`apps/viewer/crates/wasm/src/lib.rs:415` |
| `BspProcessor::new(data: &[u8])` | 构造器 | `vbsp::Bsp::read` + 缓存 zip 条目数 | `apps/viewer/crates/wasm/src/lib.rs:426` |
| `BspProcessor::metadata()` | 借用方法 | 元数据 JSON 字符串 | `apps/viewer/crates/wasm/src/lib.rs:438` |
| `BspProcessor::parse_spawn_points()` | 借用方法 | 出生点报告 JSON | `apps/viewer/crates/wasm/src/lib.rs:464` |
| `BspProcessor::export_glb_with_pakfile_models_with_defaults_and_lights(defaults_json)` | `&mut self` | **主导出入口**（2026-10-04 起与 game 同款）：PAKFILE 模型 + 缺失材质回退（`defaults_json`）+ `KHR_lights_punctual` 灯实体（渲染端 buildMapScene 摘除）；实现核失败时把 `Bsp` 放回实例（TS 侧回退裸导出） | `apps/viewer/crates/wasm/src/lib.rs:642` |
| `BspProcessor::export_glb_with_pakfile_models()` | `&mut self` | 裸导出（无回退表）：主导出失败时的 TS 侧回退路径 | `apps/viewer/crates/wasm/src/lib.rs:583` |
| `decompress_mtz(bytes)` | 模块级函数 | MTZ 容器（`MTZ6`/`MTZ5`）→ JSON 文本；TS 侧构建 defaults_json 用 | `apps/viewer/crates/wasm/src/lib.rs:717` |
| `BspMetadata` | 仅 `serde::Serialize`（**不**跨 wasm 边界） | 元数据的序列化载体 | `apps/viewer/crates/wasm/src/lib.rs:361`、`apps/viewer/crates/wasm/src/lib.rs:362` |

TS 侧的消费面有三个名字（`BspProcessor` / `decompress_mtz` / `initSync`；2026-10-04 起缺失纹理回退链路加入 `decompress_mtz`），契约清单由 `apps/viewer/scripts/check-wasm-api.mjs:30` 与 `apps/viewer/scripts/check-wasm-api.mjs:38` 守着（`VIEWER_API` 两项 + `BspProcessor` 类反向覆盖）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 顺序契约 | 两个 `export_glb_*` 都把内部 `Bsp` `take()` 走，必须排在 `metadata` / `parse_spawn_points` 之后；取走后再调它们返回「BSP 未解析或已导出」错误。TS 主链路：先试主导出，失败回退裸导出（`apps/viewer/src/core/bsp.ts:131` 到 `apps/viewer/src/core/bsp.ts:141`） | `apps/viewer/crates/wasm/src/lib.rs:584`、`apps/viewer/crates/wasm/src/lib.rs:642` |
| 元数据来源 | `schema_version` 固定 1；`magic` 由 header 的 v/b/s/p 四字节拼成；四个 lump 计数直接取长度；`num_static_props` 现数一遍；`packed_files` 用构造期缓存 | `apps/viewer/crates/wasm/src/lib.rs:387` 到 `apps/viewer/crates/wasm/src/lib.rs:395` |
| 出生点收录判据 | `classname` 命中 `SPAWN_CLASSNAMES` 之一，或以 `info_player_` 开头；`origin` 解析不出三个分量则整条跳过 | `apps/viewer/crates/wasm/src/lib.rs:504` 到 `apps/viewer/crates/wasm/src/lib.rs:514`、`apps/viewer/crates/wasm/src/lib.rs:524`、`apps/viewer/crates/wasm/src/lib.rs:533` |
| 出生点坐标变换 | `origin` 走 `rotate_yup`（`[x,y,z] → [y,z,x]`，正交且 det = +1），与地图 GLB 同一变换 | `apps/viewer/crates/wasm/src/lib.rs:499`、`apps/viewer/crates/wasm/src/lib.rs:549` |
| 角度保持原序 | `angles` 原样输出 BSP 的 `[pitch, yaw, roll]`（度），换算留给消费端 | `apps/viewer/crates/wasm/src/lib.rs:550`、`apps/viewer/src/core/spawn.ts:58` |
| `primary` 规则 | 首个 `info_player_start` 的收录下标；没有则回落收录列表第 0 条；列表为空为 null | `apps/viewer/crates/wasm/src/lib.rs:543`、`apps/viewer/crates/wasm/src/lib.rs:557` |
| 实体文本已小写 | 输入来自共享层 `read_entities`（整段小写化），故本文件的 classname 字面量全用小写 | `apps/viewer/crates/wasm/src/lib.rs:520`、`src/wasm-core/vbsp/reader.rs:71` |
| 三件套收集 | 只收 `static_props` 引用的模型名在 zip 里命中的条目，缺任一件即跳过；同时顺手挑 `sp_<idx>.vhv` / `sp_hdr_<idx>.vhv`（同 idx 上 HDR 优先） | `apps/viewer/crates/wasm/src/lib.rs:79`、`apps/viewer/crates/wasm/src/lib.rs:96` 到 `apps/viewer/crates/wasm/src/lib.rs:110` |
| zip 锁只锁一次 | 整轮条目扫描期间持锁，扫描结束立刻释放 | `apps/viewer/crates/wasm/src/lib.rs:85`、`apps/viewer/crates/wasm/src/lib.rs:114` |
| 缺失纹理回退 | pakfile 内没有该 VTF 时按 `$basetexture` 路径与材质名依次查默认纹理包（`textures.mtz` 解压表，键 `materials/<小写路径>`），命中即把低清纹理嵌进 GLB；主导出才传回退表，裸导出传 `None`（2026-10-04 起，viewer 材质纯色的根因修复） | `apps/viewer/crates/wasm/src/lib.rs:266` 到 `apps/viewer/crates/wasm/src/lib.rs:277` |
| 材质解析四步 | `.mdl` 纹理名表 → 按搜索目录拼候选路径找 `.vmt` → 必要时跟一层 `patch` include 取母材质 `$basetexture` → 用 `$basetexture` 找 `.vtf` 并解码 PNG | `apps/viewer/crates/wasm/src/lib.rs:222` 到 `apps/viewer/crates/wasm/src/lib.rs:230`、`apps/viewer/crates/wasm/src/lib.rs:240` 到 `apps/viewer/crates/wasm/src/lib.rs:248`、`apps/viewer/crates/wasm/src/lib.rs:253` |
| 失败只跳过不报错 | `.mdl` 读不出、VMT 找不到、`$basetexture` 缺失、VTF 取不到或解码失败都只跳过对应项；VMT 缺失时该材质按 Opaque 记一笔 | `apps/viewer/crates/wasm/src/lib.rs:211`、`apps/viewer/crates/wasm/src/lib.rs:234`、`apps/viewer/crates/wasm/src/lib.rs:255` 到 `apps/viewer/crates/wasm/src/lib.rs:266` |
| 无模型时回退纯地图导出 | 一个被引用模型都没收集到时改用 `bsp_to_gltf_core::export_bsp`，不报错 | `apps/viewer/crates/wasm/src/lib.rs:593` 到 `apps/viewer/crates/wasm/src/lib.rs:603` |
| 错误翻译格式 | `to_js_err` 把任意 Debug 错误压成 `"{上下文}: {Debug}"` 字符串 | `apps/viewer/crates/wasm/src/lib.rs:42` 到 `apps/viewer/crates/wasm/src/lib.rs:44` |
| 依赖面最小 | crate 只依赖共享解析层与绑定/序列化/图像四类；不依赖 `websurf-phys`，不含 mosaic / 默认纹理包 | `apps/viewer/crates/wasm/Cargo.toml:18` 到 `apps/viewer/crates/wasm/Cargo.toml:33` |
| patch 指向 vendored vmdl | workspace 级 `[patch.crates-io]` 把 `vmdl` 指到 `src/vendor/vmdl` | `apps/viewer/Cargo.toml:12` 到 `apps/viewer/Cargo.toml:13` |
| release 配置 | `opt-level = 3` + `lto = true` + `codegen-units = 1`；wasm-pack 侧跳过二次 `wasm-opt` | `apps/viewer/Cargo.toml:18` 到 `apps/viewer/Cargo.toml:21`、`apps/viewer/crates/wasm/Cargo.toml:36` 到 `apps/viewer/crates/wasm/Cargo.toml:37` |

## 已知缺口（状态见 TODO.md）

1. **`.MDL` 大小写会让「三件齐」检查失效**：判据用 `name.to_ascii_lowercase().ends_with(".mdl")`（大小写不敏感，`apps/viewer/crates/wasm/src/lib.rs:119`），而配对名用 `name.replace(".mdl", …)`（大小写敏感，`apps/viewer/crates/wasm/src/lib.rs:122` 到 `apps/viewer/crates/wasm/src/lib.rs:123`）⇒ zip 条目名是 `.MDL` 时两个配对名仍等于 `.mdl` 名，两次 `pack.get` 取回同一份 `.mdl` 字节分别填进 `vvd` / `vtx` 槽位（`apps/viewer/crates/wasm/src/lib.rs:128`、`apps/viewer/crates/wasm/src/lib.rs:132`）。静态读码结论，未跑 wasm。（见 TODO.md T-144）
2. **模型名匹配与材质查找口径不一致**：模型名用 `referenced.contains(name)` 精确比较（`apps/viewer/crates/wasm/src/lib.rs:119`），材质查找走 `pakfile_models::PakIndex`（大小写不敏感，`apps/viewer/crates/wasm/src/lib.rs:606`）⇒ 同一份 pakfile 里两处对大小写的容忍度不同。（见 TODO.md T-145）
3. **锁中毒会 panic**：`new` 里 `bsp.pack.clone().into_zip().lock().unwrap()`（`apps/viewer/crates/wasm/src/lib.rs:429`）在锁中毒时 panic，而本文件其它失败点都转成 `JsValue`（`apps/viewer/crates/wasm/src/lib.rs:87`、`apps/viewer/crates/wasm/src/lib.rs:427`）⇒ 这一处失败形态与全文件不一致。（见 TODO.md T-146）
4. **材质去重键是材质名**：`resolve_pakfile_materials` 用 `out.alpha_modes.contains_key(&tex.name)` 判「已解析过」（`apps/viewer/crates/wasm/src/lib.rs:216`）⇒ 不同模型对同名材质给出不同 `search_paths` 时，首次命中的 VMT 会被后续模型复用。（见 TODO.md T-147）
5. **同一份元数据两套待遇**：`packed_files` 在构造期缓存（`apps/viewer/crates/wasm/src/lib.rs:429`），而 `num_static_props` 每次 `metadata()` 重新线性扫描（`apps/viewer/crates/wasm/src/lib.rs:381`）⇒ 同一结构体里两个计数一个缓存一个现算。（见 TODO.md T-148）
6. **`map_name` 实际不可用**：Rust 端恒写空串（`apps/viewer/crates/wasm/src/lib.rs:389`），TS 侧该字段可选（`apps/viewer/src/core/bsp.ts:30`）⇒ 两端都拿不到值，字段保留但无内容。（见 TODO.md T-149）
7. **`apps/viewer/Cargo.toml:11` 的说明把 `test` 列为同款 patch 持有方**：而该 workspace 已不在工作区，本工程 workspace 的 `members` 只有 `crates/wasm`（`apps/viewer/Cargo.toml:7` 到 `apps/viewer/Cargo.toml:9`）。属配置面文字与工作区现状不一致（是否改写由 owner 裁决）。（见 TODO.md T-150）
8. **`BspMetadata` 的字段与 TS 契约靠约定对齐**：Rust 端用 `serde::Serialize` 的字段名（`apps/viewer/crates/wasm/src/lib.rs:362` 到 `apps/viewer/crates/wasm/src/lib.rs:374`）与 TS 侧 `BspMeta` 的可选字段（`apps/viewer/src/core/bsp.ts:27` 到 `apps/viewer/src/core/bsp.ts:37`）逐字段对应，但两侧都没有把对方纳入编译期校验：重命名字段时 TS 侧只会静默拿到 `undefined`（消费点 `apps/viewer/src/ui/mapinfo.ts:162` 起用 `?? Number.NaN` 兜底显示 `—`）。（见 TODO.md T-151）
