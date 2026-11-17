//! 三端共享 wasm-bindgen 导出层（P4）：BspProcessor 状态 + 按 feature 划分的导出面。
//!
//! 本文件 task-73 slice2 生成，请勿手改；改实现请改对应 feature 模块。
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
#[cfg(feature = "glb")]
mod glb;
#[cfg(feature = "glb-lite")]
mod glb_lite;
#[cfg(feature = "debug-tools")]
mod debug_tools;
#[cfg(feature = "viewer-export")]
mod viewer_export;

#[allow(unused_imports)]
#[cfg(feature = "core")]
pub use common::*;
#[allow(unused_imports)]
#[cfg(feature = "glb")]
pub use glb::*;
#[allow(unused_imports)]
#[cfg(feature = "glb-lite")]
pub use glb_lite::*;
#[allow(unused_imports)]
#[cfg(feature = "debug-tools")]
pub use debug_tools::*;
#[allow(unused_imports)]
#[cfg(feature = "viewer-export")]
pub use viewer_export::*;
