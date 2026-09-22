/**
 * 输入层：把设备像素增量与 Q/E 转向折算成物理层消费的等效鼠标增量。
 *
 * 上下游：各工程 `app.ts` 的输入段（`mousemove` 事件与逐帧 Q/E 检查）调用本模块，
 * 再把结果经 `feedInput` 交给物理线；权威 Worker 与主线程预测实例消费的是**同一份
 * 已缩放输入**（经 SAB 输入槽传递），因此两侧角度同源。
 *
 * 两条口径（不可混用）：
 * - 真实鼠标：原始像素增量**先乘 `sensitivity`**再钳制 → `layerMouseDelta`
 * - Q/E 转向：折算成等效像素增量，**不乘 `sensitivity`**（角速度是固定值）→ `qeEquivalentDx`
 *
 * 为什么灵敏度只在这一层乘：物理侧的 `sensitivity` 参数被
 * `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams` 固定写死为 `1`，真实灵敏度
 * 只在这里乘入一次。这样改灵敏度不会让权威端与预测端拿到不同的物理参数。
 * Rust 侧 `PhysWorld::step_core` 仍会乘 `params.sensitivity`，此时值为 1、等于不缩放。
 */

/** 增量钳制上限（像素）。先乘灵敏度再钳制，所以原始上限之外还需要这一层兜底。 */
export const INPUT_CLAMP = 1000;

/** cs-movement 的 m_yaw（度/像素）。与 Rust `player::M_YAW` 数值相同，两侧各自持有字面量。 */
export const M_YAW = 0.022;

/** 原始鼠标像素增量 → 乘 `sensitivity` → 逐轴钳到 ±`INPUT_CLAMP`。不做取整。 */
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
 * Q/E 转向 → 等效鼠标像素增量（单帧量，正 = 右转）：`yawBindSpeed / M_YAW × dtF`。
 *
 * 折算后与真实鼠标走同一通道，因此 Q/E 也不需要物理侧额外处理。同样钳到
 * ±`INPUT_CLAMP`；按 144Hz（`dtF ≈ 6.94ms`）与 `yawBindSpeed = 720` 估算单帧约 227px，
 * 正常配置下不会触顶。
 */
export function qeEquivalentDx(yawBindSpeed: number, dtF: number): number {
  return Math.max(
    -INPUT_CLAMP,
    Math.min(INPUT_CLAMP, (yawBindSpeed / M_YAW) * dtF),
  );
}
