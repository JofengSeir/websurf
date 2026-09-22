# implementation：wasm-bindings

主题对应 `apps/debug/crates/wasm/**`：本工程自带的 WASM 绑定层（crate `websurf-wasm`，源码 `apps/debug/crates/wasm/src/lib.rs` 与清单 `apps/debug/crates/wasm/Cargo.toml`）。

## 模块职责

**crate 配置（`apps/debug/crates/wasm/Cargo.toml`）**

包名 `websurf-wasm`，`crate-type` 同时出 `cdylib` 与 `rlib`（`apps/debug/crates/wasm/Cargo.toml:17`）。两条 path 依赖把共享层拉进来：`websurf-phys` 指向仓库根 `src`（`apps/debug/crates/wasm/Cargo.toml:22`）、`websurf-wasm-core` 指向仓库根 `src/wasm-core`（`apps/debug/crates/wasm/Cargo.toml:24`）。

**导出面（`apps/debug/crates/wasm/src/lib.rs`）**

- 自由函数：`parse_bsp`（`apps/debug/crates/wasm/src/lib.rs:463`）、`export_visleaf_pvs`（`:3245`）、`decode_vtf_to_png`（`:3431`）、`mosaic_encode`（`:3452`）、`mosaic_decode`（`:3459`）、`decompress_mtz`（`:3467`），另有模块装载时自动调用的 `start`（`:3478`）。
- `BspProcessor` 类（`apps/debug/crates/wasm/src/lib.rs:478`，`impl` 从 `:487` 起），24 个 `#[wasm_bindgen]` 成员：构造（`:490`）、`metadata`（`:505`）、`export_glb`（`:522`）、`export_glb_with_models`（`:561`）、`export_glb_with_pakfile_models`（`:621`）、`export_glb_with_pakfile_models_with_defaults`（`:677`）、`export_glb_with_pakfile_models_with_defaults_and_atlas_limit`（`:692`）、`export_glb_with_pakfile_models_with_defaults_and_lights`（`:711`）、`export_glb_with_pakfile_models_with_lights`（`:722`）、`export_model_tri_colliders`（`:822`）、`export_model_phy_colliders`（`:964`）、`is_alive`（`:1101`）、`export_mosaic_manifest`（`:1113`）、`export_missing_textures`（`:1137`）、`parse_spawn_points`（`:1154`）、`parse_entities`（`:1270`）、`list_pakfile`（`:1333`）、`read_pakfile_file`（`:1368`）、`read_pakfile_scripts`（`:1386`）、`parse_teleports`（`:1460`）、`parse_pvs_data`（`:1913`）、`export_colliders`（`:2056`）、`export_colliders_with_filter`（`:2078`）、`export_brushes_planes`（`:2537`）。
- 共享物理原样再导出：`pub use websurf_phys::phys::PhysWorld`（`apps/debug/crates/wasm/src/lib.rs:55`）——JS 侧从 `apps/debug/pkg/websurf_wasm.js` 拿到的 `PhysWorld` 就是共享层那一个类型，本文件不加包装。
- 非导出辅助：`to_js_err`（`:65`，错误 → `JsValue` 的统一转换）、`init_panic_hook`（`:375`，无 `#[wasm_bindgen]`，只被 `start` 调用且仅 `wasm32` 编译），以及 `BspMetadata`（`:391`，`metadata()` 的序列化载体）。

**上下游**

- 上游：`websurf-wasm-core` 的 `vbsp`、`bsp_to_gltf_core`、`model_integrator`、`pakfile_models`、`texture_utils`（`apps/debug/crates/wasm/src/lib.rs:49`）。
- 下游：主线程 `apps/debug/src/main-wasm.ts`（`initSync` / `mosaic_decode` / `decompress_mtz`）、`apps/debug/src/app.ts`（`BspProcessor` / `decompress_mtz`）、`apps/debug/src/renderer/renderer-main.ts`（经 `main-wasm` 取 `mosaic_decode`），以及共享层 `src/ts-shared/phys/world-builder.ts` 按 `BspProcessorLike` 接口消费的那批方法（`apps/debug/crates/wasm/src/lib.rs:10` 起）。

## 关键流程与不变量

**两条 wasm 实例**：Worker 内 `initSync` 一份、主线程经 `apps/debug/src/main-wasm.ts` 再 `initSync` 一份，两者互不影响（`apps/debug/crates/wasm/src/lib.rs:11`）。

**错误口径统一**：所有导出错误经 `to_js_err` 转成 `JsValue` 字符串，形如 `<上下文>: <错误的 Debug 输出>`（`apps/debug/crates/wasm/src/lib.rs:36`）。

**GLB 导出入口的 take 语义**：GLB 导出入口用 `Option::take` 取走内部 `bsp`；取走后其余入口一律报「BSP 未解析或已导出」，要再导出须重新构造处理器（`apps/debug/crates/wasm/src/lib.rs:37`）。`is_alive`（`:1101`）就是这条状态的读数点。

**二进制一律复制返回**：二进制产物以 `Vec<u8>` 返回，由 wasm-bindgen 复制成 JS 侧 `Uint8Array`（`apps/debug/crates/wasm/src/lib.rs:39`）。

**本层不做格式解析**：本文件不做字节级格式解析、不做 GLB 装配、不做 VTF 解码，全部转交上游 crate（`apps/debug/crates/wasm/src/lib.rs:40`）。

**图集面积上界的唯一覆盖入口**：`export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 是公开导出里唯一能改写 `ConvertOptions.lightmap_max_atlas_area` 的入口；非有限值、0 或负数都归一成 0（即用共享层政策上界），其余行为与 `_with_defaults` 相同（`apps/debug/crates/wasm/src/lib.rs:684` 起）。

**不变量**：

- wasm 产物落到 `apps/debug/pkg/`，再由 `apps/debug/package.json:8` 复制成 `apps/debug/web/websurf_wasm_bg.wasm`。
- 参数键名与 TS 侧的契约由 `apps/debug/scripts/check-wasm-api.mjs` 在构建期校验（`apps/debug/package.json:16`）。
- `PhysWorld` 的 TS 类型声明由 `apps/debug/src/wasm.d.ts` 手写维护，不是 wasm-bindgen 产物（`apps/debug/crates/wasm/src/lib.rs:20`）。

## 已知缺口

1. **手写 `.d.ts` 落后于本文件的导出面（`PhysWorld` 侧）**：`apps/debug/src/wasm.d.ts` 的 `PhysWorld` 只有 17 个成员（`apps/debug/src/wasm.d.ts:80`），而 `src/phys/mod.rs` 的 `impl` 有 24 个 `pub fn`；缺 `tick_into`、`state_out_ptr`、`set_state_ex`、`state_full_json`、`seed_from`、`gate_veto_count`、`debug_trace`。调用后两者时只能用运行时收窄（`apps/debug/src/renderer/renderer-main.ts:1272`、`apps/debug/src/renderer/renderer-main.ts:1289`）。
2. **手写 `.d.ts` 落后于本文件的导出面（`BspProcessor` 侧）**：`.d.ts` 声明 13 个成员（`apps/debug/src/wasm.d.ts:34` 起），Rust 侧有 24 个，缺 `export_glb_with_models`、`export_glb_with_pakfile_models_with_defaults_and_atlas_limit`、`export_glb_with_pakfile_models_with_defaults_and_lights`、`export_glb_with_pakfile_models_with_lights`、`is_alive`、`parse_entities`、`list_pakfile`、`read_pakfile_file`、`read_pakfile_scripts`、`export_colliders`、`export_colliders_with_filter`（`apps/debug/crates/wasm/src/lib.rs:21` 起）。
3. **两个自由导出未进 `.d.ts`**：`export_visleaf_pvs`（`apps/debug/crates/wasm/src/lib.rs:3245`）与 `start`（`:3478`）都没有对应的类型声明；`start` 由 wasm-bindgen 在装载时自动调用，不需要 TS 侧声明，`export_visleaf_pvs` 则既无声明也无任何 TS 消费点。
4. **`export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 无 TS 调用点**：该变体只出现在 Rust 导出面与本文件的类型面之外（`apps/debug/crates/wasm/src/lib.rs:690`）。
5. **本工程实际消费的 GLB 入口只有两个**：`export_glb_with_pakfile_models` 与 `export_glb_with_pakfile_models_with_defaults_and_lights`（由共享层 `BspProcessorLike` 要求，`apps/debug/crates/wasm/src/lib.rs:17`）；`.d.ts` 里声明的 `export_glb` 与 `export_glb_with_pakfile_models_with_defaults` 在本工程无调用点（`apps/debug/src/wasm.d.ts:38`、`:42`）。
6. **默认导出与 `parse_bsp` 在本工程零调用点**：`apps/debug/src/wasm.d.ts:20` 的默认导出与 `apps/debug/src/wasm.d.ts:30` 的 `parse_bsp` 都注明本工程调用点为零；主线程走 `BspProcessor` + `metadata()`。
