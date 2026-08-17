/**
 * 输入层（公共化 v1）— 灵敏度乘入 + Q/E 等效像素。
 *
 * 由 game/debug 两端 app.ts 输入段收敛而来：
 * - mousemove 原始像素增量 → 乘 sensitivity 后统一分发（物理两端 sensitivity
 *   固定 1，真实灵敏度只在此乘入 → 改灵敏度不产生双端参数差异 → 角度永不分叉）
 * - Q/E 转向 → 等效鼠标增量（按住时作用到鼠标的量上，但**独立增量**）：
 *   旋转速度恒 = yawBindSpeed（固定角速度，**不受灵敏度影响**——qeDx 不乘
 *   sensitivity，物理两端 sensitivity 固定 1）
 */

/** 增量钳制上限（与 MouseBuffer 一致的增量上限；乘灵敏度后可能超限，重新钳制）。 */
export const INPUT_CLAMP = 1000;

/** cs-movement m_yaw（deg/pixel，与 Rust player.rs M_YAW 一致）。 */
export const M_YAW = 0.022;

/** 原始鼠标像素增量 → 灵敏度缩放后钳制（mousemove 事件用）。 */
export function layerMouseDelta(
  rawDx: number,
  rawDy: number,
  sensitivity: number,
): { dx: number; dy: number } {
  return {
    dx: Math.max(-INPUT_CLAMP, Math.min(INPUT_CLAMP, rawDx * sensitivity)),
    dy: Math.max(-INPUT_CLAMP, Math.min(INPUT_CLAMP, rawDy * sensitivity)),
  };
}

/**
 * Q/E 转向 → 等效鼠标像素增量（单帧量，正 = 右转）。
 * 与真实鼠标同一输入通道（feedInput + SAB 累积，双端消费同源输入 →
 * 角度天然一致，无 Q/E 分叉）；上限防异常（yawBind 720 时单帧仅 ~227px，不触发）。
 */
export function qeEquivalentDx(yawBindSpeed: number, dtF: number): number {
  return Math.max(
    -INPUT_CLAMP,
    Math.min(INPUT_CLAMP, (yawBindSpeed / M_YAW) * dtF),
  );
}
