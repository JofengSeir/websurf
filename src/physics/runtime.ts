/**
 * 运行时物理参数（物理控制面板的力学参数覆盖层）。
 *
 * cs-movement 原生把这些力学参数定义为模块级常量（constants.ts /
 * Accelerate.config.ts / Friction.config.ts / Jump.config.ts）。本模块提供
 * 运行时覆盖：默认值 = 各原生常量（CS:S 基准），面板经 `setRuntimeParam` 写入，
 * 消费方经 `getRuntimePhysics()` 实时读取。
 *
 * 与 Settings（PlayerController.settings）的分工：Settings 是 cs-movement 已有
 * 可配项（airAccelerate/runSpeed/autobhop…）；runtime 是原本硬编码常量的力学
 * 参数（gravity/accelerate/friction/…）。两者统一由 PhysicsParams 管理器
 * （src/physics/physics-params.ts）暴露给面板。
 */

/** 可运行时覆盖的力学参数（默认 = CS:S/cs-movement 基准值）。 */
export interface RuntimePhysics {
  /** 重力加速度（sv_gravity，u/s²；CS:S 默认 800）。 */
  gravity: number;
  /** 地面加速（sv_accelerate；CS:S 默认 10）。 */
  accelerate: number;
  /** 摩擦系数（sv_friction；CS:S 默认 4）。 */
  friction: number;
  /** 停止速度（sv_stopspeed，低于此速度直接归零；CS:S 默认 100）。 */
  stopSpeed: number;
  /** 跳跃最高点高度（jump apex，u；CS:S 默认 57 → 起跳速度 ≈302 u/s）。 */
  jumpHeight: number;
}

/** 默认值（与 cs-movement 原生常量一致）。 */
export const DEFAULT_RUNTIME_PHYSICS: RuntimePhysics = {
  gravity: 800,
  accelerate: 10,
  friction: 4,
  stopSpeed: 100,
  jumpHeight: 57,
};

let current: RuntimePhysics = { ...DEFAULT_RUNTIME_PHYSICS };

/** 当前生效的力学参数（消费方每 tick 读取）。 */
export function getRuntimePhysics(): RuntimePhysics {
  return current;
}

/** 覆盖单个参数（面板 set-physics-param 消息入口）。 */
export function setRuntimeParam<K extends keyof RuntimePhysics>(
  name: K,
  value: number,
): void {
  current[name] = value;
}

/** 恢复单个参数到默认值。 */
export function resetRuntimeParam(name: keyof RuntimePhysics): void {
  current[name] = DEFAULT_RUNTIME_PHYSICS[name];
}

/** 恢复全部参数到默认值。 */
export function resetAllRuntimePhysics(): void {
  current = { ...DEFAULT_RUNTIME_PHYSICS };
}
