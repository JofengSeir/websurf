/**
 * 物理面板参数名 → wasm `set_params` 的 snake_case 键名（13 项）。
 *
 * 为什么在共享层：debug 物理面板、地图 servercommand 映射（`map-cvars.ts`）与
 * Worker 分发器（`worker-dispatch.ts`）都要把「面板参数名」翻成 Rust 键；三处各写一份
 * 就会出现名字漂移（历史事故：改名只改了其中一处，另一处静默丢参数）。
 *
 * 面板参数 `tickRate` 不在本表：它是 JS 驱动层的固定步长，不是 Rust 键。
 *
 * `src/phys/mod.rs` 的 `set_params` 共接受 16 个键；本表不含 `sensitivity`、
 * `yaw_bind_speed`、`noclip_speed` 三项 —— 它们由
 * `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams` 一次性写全。
 */
export const PANEL_TO_RUST: Record<string, string> = {
  maxSpeed: 'run_speed',
  walkSpeed: 'walk_speed',
  crouchSpeed: 'crouch_speed',
  airAccelerate: 'air_accelerate',
  gravity: 'gravity',
  accelerate: 'accelerate',
  friction: 'friction',
  stopSpeed: 'stop_speed',
  jumpHeight: 'jump_height',
  autobhop: 'autobhop',
  bhopSpeedClamp: 'bhop_speed_clamp',
  pushOut: 'push_out',
  pushOutOnlyWhenSolid: 'push_out_only_when_solid',
};
