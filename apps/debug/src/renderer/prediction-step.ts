/**
 * 预测定步的**纯**推进计划（① 的核心算式）：把「本帧墙钟间隔」换算成「该推进几个物理步 +
 * 渲染插值系数」。抽成本模块的唯一理由是它必须能被 node 直接验证 ——
 * `apps/debug/scripts/prediction-step-verify.mjs`（`npm run test:prediction-step`）用它锁定
 * 「步进次数只由时间与 tickRate 决定，与渲染帧率无关」这条不变量；渲染器侧的唯一消费点是
 * `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.tick`。
 *
 * 背景（为什么需要定步）：主线程预测原先每渲染帧推进一步、步长取墙钟间隔，而移动解算里含
 * **逐调用离散动作**（`step_move` 的抬升-滑-落择优、`stay_on_ground` 吸附、落地判定、
 * `check_stuck` 挤出）——「一次 tick」不是可分割的量。高刷屏（320 Hz 渲染 vs 64 Hz 权威）上
 * 实测为「权威已停死、预测仍以 16 HU/s 下滑」。定步把预测拉回与权威同频。
 */

/** 一帧的推进计划：步数 + 渲染插值系数 + 留给下一帧的累加器余量。 */
export interface PredStepPlan {
  /** 本帧应推进的物理步数（0 = 本帧不推进，只更新显示插值）。 */
  steps: number;
  /** 渲染插值系数 ∈ [0, 1]：0 = 刚完成一步，1 = 已到本步末（只在补步封顶、欠账被夹到整整
   *  一个步长时取到；显示端按 1 处理即"停在最新一步的位置"，下一步立刻到来）。 */
  alpha: number;
  /** 扣掉本帧步数后的累加器余量（毫秒），供下次调用继续累加。 */
  restMs: number;
}

/**
 * 定步推进计划（纯函数）。
 *
 * 算式：`acc = accMs + frameMs`，只要 `acc >= stepMs` 就消耗一步，最多消耗 `maxSteps` 步；
 * 达到上限仍有余额时把余量**夹到至多一个步长**（欠账封顶，避免低帧率下一帧内雪崩式补步）。
 *
 * @param accMs 上次调用留下的累加器余量（毫秒；`planPredSteps(...).restMs`）。
 * @param frameMs 本帧墙钟间隔（毫秒；负数按 0 处理）。
 * @param stepMs 一个物理步的毫秒数（`1000 / tickRate`；必须 > 0，调用方负责兜底）。
 * @param maxSteps 每帧最多推进的步数（调用方负责取整，本函数再夹到 ≥1）。
 * @returns 步数、插值系数与剩余累加器；不修改任何入参，无副作用。
 *
 * 不变量（由 `prediction-step-verify.mjs` 锁定）：
 * - 步进总量只由「累计时间 ÷ stepMs」决定：只要每帧间隔 ≥ stepMs 且未触发上限，任意帧率下
 *   同样长的时间推进同样多的步数；
 * - `alpha ∈ [0, 1]`（取到 1 仅发生在补步封顶、欠账被夹成一个整步长时），且同一帧内 `steps`
 *   越大 `alpha` 越小（余量被步数吃掉）；
 * - 触发上限时 `restMs <= stepMs`（欠账有界）。
 */
export function planPredSteps(
  accMs: number,
  frameMs: number,
  stepMs: number,
  maxSteps: number,
): PredStepPlan {
  const cap = Math.max(1, Math.floor(maxSteps));
  let acc = Math.max(0, accMs) + Math.max(0, frameMs);
  let steps = 0;
  while (acc >= stepMs && steps < cap) {
    acc -= stepMs;
    steps++;
  }
  // 上限用尽仍有余额 ⇒ 只保留至多一个步长的欠账（否则低帧率下每帧欠账累积成雪崩）
  if (steps >= cap) acc = Math.min(acc, stepMs);
  const alpha = Math.max(0, Math.min(1, acc / stepMs));
  return { steps, alpha, restMs: acc };
}
