//! 传送名门控（`filter_activator_name`）静态解析：`glb` / `debug-tools` 两条导出路径共用。
//!
//! 背景（2026-11-19）：`parse_teleports` 曾在 `glb-lite`（game/viewer 路径）与 `debug-tools`
//! （debug 独有路径）里各有一份实现，名门控只加在 debug 那份上 → game 端的 teleport JSON
//! 缺 `filtername/filter_name/filter_negated`，运行时把 `*361` 这类 Negated 门控当「无门控」
//! 一律回卷（表现为「间隔性速度清零」）。本模块把门控解析收敛成唯一实现，两条路径都调它。
use std::collections::HashMap;

use websurf_wasm_core::vbsp;

/// `filter_activator_name.targetname` → (玩家名模式, 是否取反)。
///
/// Source 语义链：`trigger_teleport.filtername` → filter 实体的 `targetname`；
/// `filter_activator_name.filtername` 才是玩家名模式（`CFilterName`，末尾 `*` 通配、
/// 大小写不敏感 → 见 `src/phys/teleport.rs::name_matches`）；filter 实体的 `Negated`
/// 键 → `CBaseFilter::m_bNegated`，为 1 时**结果取反**。
///
/// 静态解析：不跟踪 `logic_*` 在运行时改 `filtername` / 禁用 filter 的情况；解析不到
/// 就按「无门控」处理（保守：不阻塞旧地图的无 filter 触发器）。
pub(crate) fn build_filter_names(bsp: &vbsp::Bsp) -> HashMap<String, (String, bool)> {
    bsp.entities
        .iter()
        .filter(|ent| {
            ent.prop("classname")
                .map(|c| c == "filter_activator_name")
                .unwrap_or(false)
        })
        .filter_map(|ent| {
            let targetname = ent.prop("targetname").ok()?;
            let filtername = ent.prop("filtername").ok()?;
            // 实体文本在读入时已整体转小写（`read_entities`），但历史实现两种键名都试，
            // 这里保持一致：`Negated` 取不到时再试 `negated`。
            let negated = ent
                .prop("Negated")
                .or_else(|_| ent.prop("negated"))
                .map(|v| v == "1")
                .unwrap_or(false);
            Some((targetname.to_string(), (filtername.to_string(), negated)))
        })
        .collect()
}

/// 解析单个触发器的门控：返回 `(filtername 原始值, filter_name 模式, filter_negated)`。
///
/// `filter_name = None` 表示无门控或解析不到；`filter_negated` 默认 false。
pub(crate) fn resolve_trigger_filter(
    filter_names: &HashMap<String, (String, bool)>,
    filtername: Option<String>,
) -> (Option<String>, Option<String>, bool) {
    let mapped = filtername
        .as_ref()
        .and_then(|f| filter_names.get(f.as_str()));
    let filter_name = mapped.map(|(pattern, _)| pattern.clone());
    let filter_negated = mapped.map(|(_, negated)| *negated).unwrap_or(false);
    (filtername, filter_name, filter_negated)
}
