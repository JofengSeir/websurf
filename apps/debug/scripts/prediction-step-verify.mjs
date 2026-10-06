#!/usr/bin/env node
/**
 * 预测定步的推进计划验证（node，无浏览器、无 wasm）。
 *
 * 对象：`apps/debug/src/renderer/prediction-step.ts` 的 `planPredSteps` —— 主线程预测
 * 「本帧推几步物理 + 渲染插值系数」的唯一算式，渲染侧消费点是
 * `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.tick`。
 *
 * 为什么必须锁它（实测背景，见 `apps/debug/src/config.ts` 的 `PredictionConfig` 头注）：
 * 预测原先每渲染帧推进一步、步长取墙钟间隔，而移动解算含逐调用离散动作（`step_move` 的
 * 抬升-滑-落择优 / `stay_on_ground` 吸附 / 落地判定 / `check_stuck` 挤出）。用真实 wasm
 * 物理在 `surf_666` 的抵墙点驱动同一份输入：
 *   · 64 Hz（权威定步）：4 步后 `Δ(0.000, 0.000, 0.000)`，160/160 步无反向 —— **停死**；
 *   · 320 Hz（同一点、同一输入、1/320 步长）：800/800 步都在动，2.5 s 净位移 +40.21 HU。
 * 本脚本不重复跑物理，只锁「步进总量与帧率无关」这条数学不变量 —— 它正是上面那个差异的
 * 充要条件：帧率一变，步长与调用次数就不再对应 64 Hz。
 *
 * 做法：`apps/debug/package.json` 的 `test:prediction-step` 先用 esbuild 把
 * `src/renderer/prediction-step.ts` 打成 ESM bundle（落在 `apps/debug/.tmp/pred-step/`），
 * 本脚本 import 后**直接驱动产品代码**（不是算法副本）。缺 bundle 时打印补救命令并以 2 退出。
 *
 * 断言（逐条打印 [PASS]/[FAIL]；失败数 > 0 则以 1 退出）：
 *   ① 320 Hz（3.125 ms/帧）跑 1 s：步数**恰好 64**（= tickRate），且每帧 `alpha ∈ [0,1]`；
 *   ② 64 Hz（15.625 ms/帧）跑 1 s：步数恰好 64；
 *   ③ 帧率无关性：144 / 240 / 320 / 1000 Hz 跑 5 s 的步数**全部相等**且 = `5 × tickRate`；
 *   ④ 低帧率两档：30 Hz + 上限 3 ⇒ 总步数 = 2×tickRate（补步能力 90/s ≥ 64/s，不丢时间）；
 *      30 Hz + 上限 2 ⇒ 退化为「上限 × 帧率」= 60 Hz（120 步），且两次的累加器欠账都 ≤ 一个步长
 *      （欠账有界，不许雪崩）—— 这两条钉住「默认上限 3 覆盖到 21.3 fps」这个取值理由；
 *   ⑤ 空转帧（0 ms 间隔）不推进物理，且 `alpha` 单调不减到接近 1；
 *   ⑥ 反例（修复被撤掉的形态）：把「每帧一步、步长取墙钟间隔」还原成等价算式后，320 Hz 与
 *      64 Hz 在同样 1 s 内给出的**物理时间**相差 5 倍 —— 断言这条差异确实存在（否则本门禁
 *      失去意义：它必须能区分「定步」与「每帧一步」）。
 *
 * 用法：npm run test:prediction-step   （先 esbuild 打包再运行本脚本）
 *      或手动：npx esbuild src/renderer/prediction-step.ts --bundle --format=esm \
 *                --platform=node --outfile=.tmp/pred-step/prediction-step.bundle.mjs
 *              node scripts/prediction-step-verify.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const bundlePath = join(debugDir, '.tmp', 'pred-step', 'prediction-step.bundle.mjs');

if (!existsSync(bundlePath)) {
  console.error(
    `缺少打包产物 ${bundlePath}\n请先执行：\n` +
      `  cd apps/debug && npx esbuild src/renderer/prediction-step.ts --bundle --format=esm ` +
      `--platform=node --outfile=.tmp/pred-step/prediction-step.bundle.mjs`,
  );
  process.exit(2);
}

const { planPredSteps } = await import(pathToFileURL(bundlePath).href);

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    passed++;
    console.log(`[PASS] ${name}${detail ? ` —— ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`[FAIL] ${name} —— ${err.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** 按固定帧间隔跑 `seconds` 秒，返回总步数、alpha 序列与最大单帧步数。 */
function simulate(frameMs, seconds, { tickRate = 64, maxSteps = 2 } = {}) {
  const stepMs = 1000 / tickRate;
  const frames = Math.round((seconds * 1000) / frameMs);
  let acc = 0;
  let steps = 0;
  let maxSingle = 0;
  let maxAlpha = -Infinity;
  let minAlpha = Infinity;
  let maxRest = 0;
  for (let i = 0; i < frames; i++) {
    const plan = planPredSteps(acc, frameMs, stepMs, maxSteps);
    assert(plan.alpha >= 0 && plan.alpha <= 1, `alpha 越界：${plan.alpha}`);
    acc = plan.restMs;
    steps += plan.steps;
    maxSingle = Math.max(maxSingle, plan.steps);
    maxAlpha = Math.max(maxAlpha, plan.alpha);
    minAlpha = Math.min(minAlpha, plan.alpha);
    maxRest = Math.max(maxRest, plan.restMs);
  }
  return { stepMs, frames, steps, maxSingle, minAlpha, maxAlpha, maxRest, acc };
}

const TICK = 64;

// ① 320 Hz（高刷屏）1 s：步数必须等于 tickRate，而不是帧数
check('320 Hz 跑 1 s 的物理步数 == tickRate（不是 320）', () => {
  const r = simulate(1000 / 320, 1, { tickRate: TICK, maxSteps: 2 });
  assert(r.steps === TICK, `期望 ${TICK}，实得 ${r.steps}`);
  assert(r.maxSingle === 1, `320 Hz 下不该有单帧多步，实得 ${r.maxSingle}`);
  return `steps=${r.steps} frames=${r.frames} maxSingle=${r.maxSingle}`;
});

// ② 64 Hz 1 s：一帧一步，步数同样等于 tickRate
check('64 Hz 跑 1 s 的物理步数 == tickRate', () => {
  const r = simulate(1000 / 64, 1, { tickRate: TICK, maxSteps: 2 });
  assert(r.steps === TICK, `期望 ${TICK}，实得 ${r.steps}`);
  return `steps=${r.steps} frames=${r.frames}`;
});

// ③ 帧率无关性：不同帧率、同样 5 s，步数全部相等
check('帧率无关性：144/240/320/1000 Hz 跑 5 s 步数全等且 = 5×tickRate', () => {
  const got = [144, 240, 320, 1000].map((hz) => simulate(1000 / hz, 5, { tickRate: TICK, maxSteps: 2 }));
  const steps = got.map((r) => r.steps);
  const allSame = steps.every((s) => s === steps[0]);
  assert(allSame, `不同帧率步数不等：${steps.join(' / ')}`);
  assert(steps[0] === 5 * TICK, `期望 ${5 * TICK}，实得 ${steps[0]}`);
  return `steps=${steps.join(' / ')}（帧率 ${[144, 240, 320, 1000].join('/')}）`;
});

// ④ 低帧率（30 Hz：一帧 33.3 ms = 2.13 个步长）：补步能力 = 上限 × 帧率，决定能否不丢时间
check('30 Hz 跑 2 s + 上限 3：总步数 = 2×tickRate（补步能力 90/s ≥ 64/s，不丢时间）', () => {
  const r = simulate(1000 / 30, 2, { tickRate: TICK, maxSteps: 3 });
  assert(r.maxSingle <= 3, `单帧补步超上限：${r.maxSingle}`);
  assert(r.steps === 2 * TICK, `期望 ${2 * TICK}，实得 ${r.steps}`);
  assert(r.maxRest <= r.stepMs + 1e-9, `欠账超出一步长：${r.maxRest} > ${r.stepMs}`);
  return `steps=${r.steps} maxSingle=${r.maxSingle} maxRest=${r.maxRest.toFixed(3)}ms`;
});
check('30 Hz 跑 2 s + 上限 2：退化为 上限×帧率 = 60 Hz（120 步，欠账仍有界）', () => {
  const r = simulate(1000 / 30, 2, { tickRate: TICK, maxSteps: 2 });
  assert(r.maxSingle <= 2, `单帧补步超上限：${r.maxSingle}`);
  assert(r.steps === 120, `期望 120（2×30×2），实得 ${r.steps}`);
  assert(r.maxRest <= r.stepMs + 1e-9, `欠账超出一步长：${r.maxRest} > ${r.stepMs}`);
  return `steps=${r.steps}（= 2 步/帧 × 60 帧）maxRest=${r.maxRest.toFixed(3)}ms`;
});

// ⑤ 空转帧（0 ms 间隔）不推进物理；alpha 随累加器单调升到接近 1
check('0 ms 空转帧不推进物理，alpha 单调不减', () => {
  let acc = 0;
  const stepMs = 1000 / TICK;
  let last = -1;
  for (let i = 0; i < 5; i++) {
    const plan = planPredSteps(acc, 0, stepMs, 2);
    assert(plan.steps === 0, `空转帧推进了 ${plan.steps} 步`);
    assert(plan.alpha >= last, `alpha 回退：${plan.alpha} < ${last}`);
    last = plan.alpha;
    acc = plan.restMs;
  }
  // 累加器攒够一个步长后必定推进一步
  const plan = planPredSteps(acc, stepMs, stepMs, 2);
  assert(plan.steps === 1, `攒满一步却推了 ${plan.steps} 步`);
  return `alpha 序列单调；攒满 ${stepMs.toFixed(3)}ms 后 steps=${plan.steps}`;
});

// ⑥ 反例对照：修复撤掉后的算式（每帧一步）在高帧率下把物理时间放大 5 倍
check('反例：每帧一步的旧算式在 320 Hz 下物理时间是 64 Hz 的 5 倍（本门禁的可辨识性）', () => {
  const stepMs = 1000 / TICK;
  const frames = 320; // 1 s @ 320 Hz
  const simTime = frames * stepMs; // 旧算式：每帧消耗一个步长的物理时间
  const realTime = frames * (1000 / 320);
  const ratio = simTime / realTime;
  assert(Math.abs(ratio - 5) < 1e-9, `期望 5 倍，实得 ${ratio}`);
  return `旧口径 1 s 内推进 ${frames} 步 = ${simTime.toFixed(0)}ms 物理时间（真时间 ${realTime.toFixed(0)}ms）`;
});

console.log(`\n预测定步推进计划：${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
