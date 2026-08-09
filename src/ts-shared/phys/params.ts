/**
 * 物理参数映射（公共化 v1）— config → Rust set_params snake_case 全量参数。
 *
 * 由 game/config.ts buildPhysicsParams 与 debug app.ts buildPredictionParams 收敛：
 * - 两端 config 字段名有差异（debug 用 gravity/jumpHeight/maxSpeed/...，
 *   game 同构），统一入参接口 PhysicsParamsLike + PhysicsInputLike，两端各自
 *   映射后调用（jumpSpeed → jump_height = jumpSpeed²/2g）
 * - sensitivity 固定 1：真实灵敏度由主线程输入层应用（mousemove 时乘入角度
 *   增量），双端物理（权威 Worker + 主线程渲染）用同一份已缩放输入 →
 *   改灵敏度不产生双端参数差异 → 角度永不分叉
 */

/** 物理参数统一入参（两端 config.physics 各自映射）。 */
export interface PhysicsParamsLike {
  gravity: number;
  accelerate: number;
  friction: number;
  stopSpeed: number;
  jumpSpeed: number;
  airAccel: number;
  maxSpeed: number;
  walkSpeed: number;
  crouchSpeed: number;
  autobhop: boolean;
  bhopSpeedClamp: boolean;
  noPrestrafe: boolean;
  /** 传送触发落地稳定门槛（帧；Rust teleport_gate_ticks）。 */
  teleportGateTicks: number;
}

/** 输入侧参数（两端 config.input 各自映射）。 */
export interface PhysicsInputLike {
  /** Q/E 键 yaw 旋转速度（度/秒，turn bind）。 */
  yawBindSpeed: number;
  /** noclip 自由视角移动速度（HU/s）。 */
  noclipSpeed: number;
}

/** 构造 Rust `set_params` 兼容的全量参数对象（权威 Worker 与主线程预测实例共用）。 */
export function buildPhysicsParams(
  p: PhysicsParamsLike,
  input: PhysicsInputLike,
): Record<string, unknown> {
  return {
    gravity: p.gravity,
    accelerate: p.accelerate,
    friction: p.friction,
    stop_speed: p.stopSpeed,
    jump_height: (p.jumpSpeed * p.jumpSpeed) / (2 * p.gravity),
    air_accelerate: p.airAccel,
    run_speed: p.maxSpeed,
    walk_speed: p.walkSpeed,
    crouch_speed: p.crouchSpeed,
    autobhop: p.autobhop,
    bhop_speed_clamp: p.bhopSpeedClamp,
    no_prestrafe: p.noPrestrafe,
    // 灵敏度固定 1：真实灵敏度由主线程输入层应用（mousemove 时乘入角度增量），
    // 双端物理（权威 Worker + 主线程渲染）用同一份已缩放输入 → 改灵敏度不产生双端分叉
    sensitivity: 1,
    yaw_bind_speed: input.yawBindSpeed,
    noclip_speed: input.noclipSpeed,
    teleport_gate_ticks: p.teleportGateTicks,
  };
}
