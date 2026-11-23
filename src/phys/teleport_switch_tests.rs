//! `TeleportManager` 运行期启用开关（`set_trigger_enabled` / `trigger_enabled`）的回归测试。
//!
//! 背景：地图 `trigger_teleport` 常带 `StartDisabled`（ze_cursed 的 tp_stage01/02 传送盒），
//! 靠实体 I/O `Enable` 在阶段推进后打开。此前 `from_json` 把 `start_disabled` 当永久禁用，
//! 运行期 `Enable` 只改实体层 `disabled`、碰不到 Rust 静态传送表 ⇒ 玩家永远传不过去。
//! 这里锁定「初始关 → 开关后能触发 → 再关掉不触发」这条语义。

use crate::phys::teleport::TeleportManager;

/// 一个 128×128×128 的 AABB 传送区，落点固定；`start_disabled` 由调用方决定。
fn manager_with_start_disabled(start_disabled: bool) -> TeleportManager {
    let json = format!(
        r#"{{
            "teleports": [{{ "index": 900, "targetname": "tp_dest", "origin": [4096.0, 512.0, 512.0], "angles": [0.0, 90.0, 0.0] }}],
            "triggers": [{{
                "index": 194,
                "classname": "trigger_teleport",
                "target": "tp_dest",
                "origin": [0.0, 0.0, 0.0],
                "model_mins": [-64.0, -64.0, -64.0],
                "model_maxs": [64.0, 64.0, 64.0],
                "spawnflags": 1,
                "start_disabled": {}
            }}]
        }}"#,
        start_disabled
    );
    TeleportManager::from_json(&json).expect("teleport json 应能解析")
}

/// 站在传送区中心的一步检测（模拟 `PhysWorld::step_core` 的调用口径）。
fn check_at_origin(m: &mut TeleportManager) -> bool {
    m.check(
        &[0.0, 0.0, 0.0],
        1,    // ground_ticks > 0（落地）
        0.016,
        false, // predict
        false, // surfing
        72.0,  // body_top
    )
    .is_some()
}

#[test]
fn start_disabled_trigger_does_not_fire_until_enabled() {
    let mut m = manager_with_start_disabled(true);
    // 初始关（StartDisabled）：区域在脚下也不触发。
    assert!(!check_at_origin(&mut m), "StartDisabled 的传送区不应触发");
    assert!(!m.trigger_enabled(194));

    // 实体层 Enable 推过来：打开后同一位置立即触发。
    assert_eq!(m.set_trigger_enabled(194, true), 1, "应切换 1 条 trigger");
    assert!(m.trigger_enabled(194));
    assert!(check_at_origin(&mut m), "Enable 后传送区应触发");
    // 命中后 check 已置 0.5s 冷却；清掉再看落点字段。
    m.reset_cooldown();
    let dest = m
        .check(&[0.0, 0.0, 0.0], 1, 0.016, false, false, 72.0)
        .expect("冷却清掉后应再次触发");
    assert_eq!(dest.index, 900);
    assert_eq!(dest.targetname, "tp_dest");

    // 再 Disable：关掉后不再触发。
    m.reset_cooldown();
    assert_eq!(m.set_trigger_enabled(194, false), 1);
    assert!(!m.trigger_enabled(194));
    assert!(!check_at_origin(&mut m), "Disable 后传送区不应触发");
}

#[test]
fn normal_trigger_starts_enabled() {
    let mut m = manager_with_start_disabled(false);
    assert!(m.trigger_enabled(194));
    assert!(check_at_origin(&mut m), "未标记 StartDisabled 的传送区初始应可用");
}

#[test]
fn set_trigger_enabled_is_idempotent_and_handles_unknown_entity() {
    let mut m = manager_with_start_disabled(true);
    // 未知实体 / 负数 / 重复设置同一状态都不算变化。
    assert_eq!(m.set_trigger_enabled(-1, true), 0);
    assert_eq!(m.set_trigger_enabled(999, true), 0);
    assert_eq!(m.set_trigger_enabled(194, false), 0, "初始就是关，重复关不应算变化");
    assert_eq!(m.set_trigger_enabled(194, true), 1);
    assert_eq!(m.set_trigger_enabled(194, true), 0, "重复开不应算变化");
}
