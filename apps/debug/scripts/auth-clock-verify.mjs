#!/usr/bin/env node
/**
 * 权威时钟验证（确定性 Node 测试，无需浏览器）。
 *
 * 被测事实（均可在源码逐条核对）：
 *   - `src/ts-shared/auth/auth-loop.ts` 的 `reset()` 把累积器余数 `acc`、唤醒基准
 *     `lastWall`、仿真时钟 `simMs` 一并清零；`setFixedDt(同速率)` 返回 `false`，
 *     且不触碰任何内部量。
 *   - `src/ts-shared/auth/worker-dispatch.ts` 的 config/physics 分支只在
 *     `setFixedDt(env.getConfigTickRate())` 返回 `true`（步长真变化）时才调 `reset()`。
 *   - 面板 `tickRate` 有两条入口：`apps/debug/src/app.ts` 的滑块回调单发
 *     `{ tickRate }`（经 `InputBridge.sendConfig`），以及录制回放路径发整段 `physics`
 *     配置（其中含 `tickRate`）。
 *
 * 本测试直接驱动真实 `createAuthLoop`，对比三种注入方式下的权威 tick 数：
 *   A 基线：不发配置消息；
 *   B 生产语义：每 4ms 发一次配置，步长未变时不 reset；
 *   C 对照组：每 4ms 发一次配置并**无条件** reset（脚本内构造，用于证明本测试确实
 *     能区分两种调用方式）。
 * 断言：B ≥ 0.9×A（不丢时间）；C < 0.75×A；B > 1.15×C。
 *
 * 用法：node scripts/auth-clock-verify.mjs
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const HERE = import.meta.dirname ?? resolve(process.cwd(), 'scripts');
const bundlePath = resolve(HERE, '..', '.tmp', 'auth-clock', 'auth-loop.bundle.mjs');
const { createAuthLoop } = await import(pathToFileURL(bundlePath).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`[PASS] ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
};

/** 造一个最小可用的 AuthLoopEnv；统计 stepPhysics 实际执行次数。 */
function makeEnv() {
  const counter = { ticks: 0, lastDt: 0 };
  const env = {
    shared: {
      takeInput: () => ({ keysMask: 0, dx: 0, dy: 0 }),
      writeAuthoritative: () => {},
    },
    getPhys: () => ({
      tick: (dt) => { counter.ticks++; counter.lastDt = dt; },
      state: () => ({
        posX: 0, posY: 0, posZ: 0, yaw: 0, pitch: 0,
        velX: 0, velY: 0, velZ: 0, onGround: true, eyeHeight: 64,
      }),
    }),
    post: () => {},
  };
  return { env, counter };
}

const RATE = 64;
const PHASE_MS = 2000;

/** 跑一个阶段：每 4ms 触发一次（可选的）配置消息注入。 */
async function phase(label, opts) {
  const { env, counter } = makeEnv();
  const loop = createAuthLoop(env);
  loop.start();
  await sleep(150);                     // 让 first-wake 基准建立
  const t0 = counter.ticks;
  const wall0 = performance.now();

  const spam = setInterval(() => {
    if (opts.newContract) {
      // 生产语义：setFixedDt 返回 true（步长真变化）时才 reset
      if (loop.setFixedDt(RATE)) loop.reset();
    } else if (opts.legacy) {
      // 对照组：无条件 reset（脚本内构造，非现存调用方的写法）
      loop.setFixedDt(RATE);
      loop.reset();
    }
  }, 4);

  await sleep(PHASE_MS);
  clearInterval(spam);
  const ticks = counter.ticks - t0;
  const wallS = (performance.now() - wall0) / 1000;
  const rate = ticks / wallS;
  console.log(`  阶段 ${label}: ${ticks} ticks / ${wallS.toFixed(2)}s = ${rate.toFixed(1)} tick/s`);
  return rate;
}

console.log('=== 权威时钟验证：配置消息不应丢仿真时间 ===\n');
const base = await phase('A 基线（无配置消息）', {});
const neo = await phase('B 新契约（配置消息，步长未变不 reset）', { newContract: true });
const old = await phase('C 旧行为（配置消息 + 无条件 reset）', { legacy: true });

console.log('');
check('B 与 A 的 tick 率一致（新契约不丢时间）', neo >= base * 0.9,
  `A=${base.toFixed(1)} B=${neo.toFixed(1)} 比值=${(neo / base).toFixed(3)}`);
check('C 显著低于 A（复现缺陷，证明本测试有效）', old < base * 0.75,
  `A=${base.toFixed(1)} C=${old.toFixed(1)} 比值=${(old / base).toFixed(3)}`);
check('B 明显优于 C（修复有效）', neo > old * 1.15,
  `B=${neo.toFixed(1)} C=${old.toFixed(1)} 提升=${(neo / Math.max(old, 1e-9)).toFixed(2)}×`);

// setFixedDt 契约：同速率返回 false、变速率返回 true
{
  const { env } = makeEnv();
  const loop = createAuthLoop(env);
  check('setFixedDt(同速率) 返回 false', loop.setFixedDt(RATE) === false);
  check('setFixedDt(新速率) 返回 true', loop.setFixedDt(RATE + 3) === true);
  check('再次 setFixedDt(同速率) 返回 false', loop.setFixedDt(RATE + 3) === false);
}

// ── 接线层覆盖：真实 createWorkerDispatch 的 config/physics tickRate 分支 ──
// 直接驱动生产 dispatch 函数（`src/ts-shared/auth/worker-dispatch.ts`），验证
// 「步长未变 → 不 reset；步长变化 → 恰好 reset 1 次」的接线语义；上方 A/B/C 对照实验
// 只验 auth-loop 自身的契约，不覆盖 dispatch 调用方。createWorkerDispatch 的依赖可在
// Node 桩环境 bundle（shared-state 为纯值、无运行时顶层 import；self/performance 只在
// 方法体内出现）。
{
  console.log('\n=== 修复 2 接线层：dispatch config tickRate 分支 reset 门禁 ===\n');
  // 合成长度偏移：本脚本让 `getConfigTickRate()` 返回 `面板值 + 3`，用于防回归——
  // dispatch 不得假设 `getConfigTickRate() === 面板值`（实测两工程当前都注入
  // `() => config.physics.tickRate`，即该差为 0）。
  const TICK_RATE_OFFSET = 3;
  try {
    const wdBundlePath = resolve(HERE, '..', '.tmp', 'worker-dispatch', 'worker-dispatch.bundle.mjs');
    mkdirSync(resolve(HERE, '..', '.tmp', 'worker-dispatch'), { recursive: true });
    await build({
      entryPoints: [resolve(HERE, '..', '..', '..', 'src', 'ts-shared', 'auth', 'worker-dispatch.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      outfile: wdBundlePath,
    });
    const { createWorkerDispatch } = await import(pathToFileURL(wdBundlePath).href);

    // 桩 authLoop：记录 setFixedDt/reset，返回值契约对齐 auth-loop.ts（步长未变
    // 返回 false、变化返回 true）。lastRate 预置为初始耦合步长，使首批同速率 config
    // 不触发 reset（模拟已在世界构建后进入稳态）。
    const INITIAL_PANEL = RATE; // 64
    const authLoop = {
      lastRate: INITIAL_PANEL + TICK_RATE_OFFSET,
      resets: 0,
      fixedDts: [],
      setFixedDt(rate) {
        this.fixedDts.push(rate);
        if (rate !== this.lastRate) { this.lastRate = rate; return true; }
        return false;
      },
      reset() { this.resets++; },
      start() {},
    };
    // 最小 PhysWorldLike 桩（config 分支仅检查 phys.current 真值 + 调用 syncParamsToWasm）
    const physStub = {
      set_death_y() {}, set_hull() {}, set_noclip() {}, set_state() {},
      respawn() {}, teleport_to_spawn() {}, teleport_to() {}, set_spawn_points() {},
      tick() {}, state() { return { yaw: 0 }; }, free() {},
    };
    let panelRate = INITIAL_PANEL;
    const physSlot = { current: physStub };
    const env = {
      shared: { current: null },
      phys: physSlot,
      authLoop,
      getConfigTickRate: () => panelRate + TICK_RATE_OFFSET,
      applyConfigPatch: (_section, patch) => {
        if (_section === 'physics' && typeof patch.tickRate === 'number') panelRate = patch.tickRate;
      },
      syncParamsToWasm: () => {},
      createPhysWorld: () => physStub,
      initSync: () => {},
      post: () => {},
      // getComputeMode 省略 → 默认 'coupled' → 走 setFixedDt + 条件 reset 分支
    };
    const dispatch = createWorkerDispatch(env);
    const sendCfg = (tickRate) => dispatch({ data: { type: 'config', section: 'physics', patch: { tickRate } } });

    // 1) 连续 1000 条同 tickRate（=初始稳态）→ reset 必须 0 次
    const beforeBatch = authLoop.resets;
    for (let i = 0; i < 1000; i++) sendCfg(INITIAL_PANEL);
    const batchResets = authLoop.resets - beforeBatch;
    check('1000 条同 tickRate config → reset 调用 0 次', batchResets === 0,
      `batchResets=${batchResets}`);
    check('1000 条同 tickRate config → setFixedDt 全部同值（面板 64 + 合成偏移 3 = 67）',
      authLoop.fixedDts.slice(-1000).every((r) => r === INITIAL_PANEL + TICK_RATE_OFFSET),
      `fixedDts.length=${authLoop.fixedDts.length}`);

    // 2) 再发一条 tickRate 变值 → reset 恰好 1 次
    const beforeChange = authLoop.resets;
    sendCfg(INITIAL_PANEL + 36); // 面板 64 → 100（+ 合成偏移 3），步长 67 → 103，真变化
    const changeResets = authLoop.resets - beforeChange;
    check('变值 tickRate config → reset 恰好 1 次', changeResets === 1,
      `changeResets=${changeResets}`);
  } catch (err) {
    // 桩环境无法构造 createWorkerDispatch 依赖时的替代覆盖说明：本分支只如实登记
    // 「该覆盖项未执行」，不把失败改判为通过。`setFixedDt` 的返回值契约已由上方
    // 「同速率 false / 新速率 true」三条断言独立覆盖。
    check('dispatch 接线层覆盖（createWorkerDispatch 桩构造）', false,
      `无法构造依赖：${err?.stack ?? err}`);
    console.log('  替代覆盖：t4-chain.test.ts §P4 + worker-dispatch.ts L268-272 条件 reset');
  }
}

console.log(`\n权威时钟验证：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
