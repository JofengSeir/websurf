/**
 * 物理参数映射：把各工程的 config 结构映射成 Rust `set_params` 接受的 snake_case 参数对象。
 *
 * 上下游：两个工程的 Worker 直接调用本函数（`apps/game/src/worker/main.ts`、
 * `apps/debug/src/worker/main.ts`）；各自的 config 层再包一层适配
 * （`apps/game/src/config.ts`、`apps/debug/src/physics/prediction-params.ts`）。
 * 主线程预测实例与权威 Worker 共用同一份映射结果，避免两端参数分叉。
 *
 * 两处必须守住的映射口径：
 * - `jump_height` 不是透传：由 `jumpSpeed² / (2 × gravity)` 反算（config 给的是起跳速度）。
 * - `sensitivity` 恒为 `1`：真实灵敏度由输入层在乘角度增量时应用一次
 *   （`src/ts-shared/input/input-layer.ts`），物理侧再乘 1 等于不缩放——这样改灵敏度
 *   不会让权威端与预测端拿到不同的物理参数。
 *
 * 不在本函数内：三项碰撞箱尺寸走 `set_hull`，不是 `set_params` 的键。
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

/**
 * 构造 Rust `set_params` 兼容的参数对象：返回 **15 个键且恒为全量**（不是 patch），
 * 与 Rust 侧可接受的 15 个键一一对应。调用方按 JSON 序列化后传给 `set_params`
 * 或 `set_params` 对应通道。`jump_height` 在这里换算，`sensitivity` 在这里写死为 1
 * （原因见文件头）。
 */
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
    // 灵敏度恒为 1：真实灵敏度由输入层乘入角度增量（见 input-layer.ts），
    // 物理侧再乘 1 等于不缩放，故权威端与预测端不会因灵敏度不同而分叉
    sensitivity: 1,
    yaw_bind_speed: input.yawBindSpeed,
    noclip_speed: input.noclipSpeed,
    teleport_gate_ticks: p.teleportGateTicks,
  };
}
