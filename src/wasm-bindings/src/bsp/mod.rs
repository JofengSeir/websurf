//! 三端共享 wasm-bindgen 导出层（P4）：BspProcessor 状态 + 按 feature 划分的导出面。
//!
//! task-73 slice2 生成；task-78（A2）把原 `glb.rs` / `glb_lite.rs` / `viewer_export.rs` 三份
//! GLB 绑定合并为单文件 `glb.rs`（同名不同实现按 feature 分块），此处只保留模块分派。
use wasm_bindgen::prelude::*;
use websurf_wasm_core::render_bundle::{PakfileModels, VhvLog};
use websurf_wasm_core::vbsp;

/// 统一错误包装：错误文本格式是 JS 侧区分失败阶段的唯一依据，逐字保留。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

// 结构体字段：debug/game 5 个 + viewer 的 cached_static_props（仅 viewer-export 编译时存在）。
// 必须在共享 crate 内定义并标 #[wasm_bindgen]：各 feature 模块的导出 impl 都作用在它上面。
#[wasm_bindgen]
pub struct BspProcessor {
    bsp: Option<std::sync::Arc<vbsp::Bsp>>,
    packed_files: usize,
    mosaic_cache: std::collections::HashMap<String, String>,
    pak_models: std::cell::RefCell<Option<(VhvLog, std::rc::Rc<PakfileModels>)>>,
    vmt_fallback: std::collections::HashMap<String, String>,
    #[cfg(feature = "viewer-export")]
    cached_static_props: usize,
}

#[cfg(feature = "core")]
mod common;
// glb / glb-lite / viewer-export 三份 GLB 绑定已合并为单文件 glb.rs（task-78 A2）；
// glb-lite 只是 game 子集标记并依赖 glb，故 glb-lite 组合也由 feature "glb" 命中。
#[cfg(any(feature = "glb", feature = "viewer-export"))]
mod glb;
#[cfg(feature = "debug-tools")]
mod debug_tools;
// 传送名门控解析：glb-lite（game/viewer）与 debug-tools（debug）两条 parse_teleports
// 路径共用同一份实现（此前两处各写一份，game 那份缺名门控 → 回卷不受 filter 约束）。
#[cfg(any(feature = "glb", feature = "debug-tools"))]
mod teleport_filters;

#[allow(unused_imports)]
#[cfg(feature = "core")]
pub use common::*;
#[allow(unused_imports)]
#[cfg(any(feature = "glb", feature = "viewer-export"))]
pub use glb::*;
#[allow(unused_imports)]
#[cfg(feature = "debug-tools")]
pub use debug_tools::*;
