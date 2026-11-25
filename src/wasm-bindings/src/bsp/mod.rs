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

// 出生点 primary 选择：game / viewer / debug 三条 `parse_spawn_points` 路径共用。
// 旧逻辑只认 `info_player_start`，没有它时退化为列表第一个；而列表按实体出现顺序排列，
// 可能以 `info_teleport_destination` 开头（ze 地图），game 初始出生点就会落到传送目标上。
// primary 改为在**真实玩家出生点**里按优先级选；列表内容与顺序保持不变。

/// `info_player_*` 玩家出生点优先度：数值越小越优先（0 = `info_player_start`）。
/// 非玩家出生点（如 `info_teleport_destination`）返回 `None`，不参与 primary 竞争。
#[cfg(any(feature = "glb-lite", feature = "viewer-export", feature = "debug-tools"))]
pub(crate) fn spawn_priority(classname: &str) -> Option<u8> {
    Some(match classname {
        "info_player_start" => 0,
        "info_player_terrorist" => 1,
        "info_player_counterterrorist" => 2,
        "info_player_deathmatch" => 3,
        "info_player_teamspawn" => 4,
        "info_player_axis" => 5,
        "info_player_allied" => 6,
        "info_player_coop" => 7,
        // 其它 info_player_* 兜底，排在已知玩家出生点之后
        name if name.starts_with("info_player_") => 8,
        _ => return None,
    })
}

/// 扫描出生点时的 primary 候选更新：只有玩家出生点参与；优先级更高（数值更小）才替换，
/// 同一优先级保留先出现的。`index` 是候选在 `spawn_points` 列表中的下标。
#[cfg(any(feature = "glb-lite", feature = "viewer-export", feature = "debug-tools"))]
pub(crate) fn track_spawn_primary(
    current: Option<(u8, usize)>,
    index: usize,
    classname: &str,
) -> Option<(u8, usize)> {
    let Some(priority) = spawn_priority(classname) else {
        return current;
    };
    match current {
        Some((best, _)) if best <= priority => current,
        _ => Some((priority, index)),
    }
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
// 碰撞 / 传送 / PVS 导出五个函数体的共享实现（T-P1-1a）：glb.rs 与 debug_tools.rs
// 只保留 #[wasm_bindgen] 外壳与各自的错误文案 / 日志档位；viewer-export 也编 glb.rs，故一并纳入。
#[cfg(any(feature = "glb", feature = "debug-tools", feature = "viewer-export"))]
mod colliders_impl;
// GLB 导出管线的共享实现（T-P1-1c）：glb.rs（game / viewer）与 debug_tools.rs 的 export_glb*
// 变体只保留取用语义与参数映射，贴图/材质/mosaic 次序由这里的同一份实现决定。
#[cfg(any(feature = "glb-lite", feature = "debug-tools", feature = "viewer-export"))]
mod glb_impl;
// 元数据 / 实体 / 出生点 / pakfile / mosaic manifest 的共享实现（T-P1-1b）：glb.rs 的
// game / viewer 两份与 debug_tools.rs 一份此前逐字重复，现只保留各端薄外壳。
#[cfg(any(feature = "glb-lite", feature = "viewer-export", feature = "debug-tools"))]
mod meta_impl;

#[allow(unused_imports)]
#[cfg(feature = "core")]
pub use common::*;
#[allow(unused_imports)]
#[cfg(any(feature = "glb", feature = "viewer-export"))]
pub use glb::*;
#[allow(unused_imports)]
#[cfg(feature = "debug-tools")]
pub use debug_tools::*;
