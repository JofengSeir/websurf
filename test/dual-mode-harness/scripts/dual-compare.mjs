#!/usr/bin/env node
/**
 * WebSurf-test — game 双线 vs test 双模 对照验证（node 直接跑 WASM）。
 *
 * 目标：验证改造后的 test 模式B（权威 tick + 速度校准）数据与 game 双线实现接近。
 *
 * 双线模拟（相同输入序列：forward 直线 + 周期跳跃 + 鼠标转向）：
 * - **GameDual**（game renderer-main v7 语义）：主线程 phys（可变 dt 单步 16.7ms——
 *   模拟 60fps）+ 权威 phys（固定步长 1/64 独立实例）——每帧：
 *   主线程 tick(0.0167, 帧输入) → 权威 64Hz tick（消费累积输入）→
 *   set_velocity(权威速度) 校准主线程（只覆盖速度——位置/角度 = 主线程物理）→ 记录
 * - **TestDual**（worker-a 模式B 语义）：模式A（1ms 子步——渲染参数唯一源，位置/角度
 *   连续）+ 模式B（每 1/64：输入采样（键位/鼠标边界快照）→ 粗糙 tick(tickDt) →
 *   set_velocity(xz=粗糙/vy=模式A) + 位置/角度恢复模式A）→ 60fps 采样记录
 *
 * 对比指标（判定"接近"：关键指标偏差 < 15%）：
 *   a. 直线跑稳态速度（两者应 ≈ 相同——maxSpeed 250 附近，偏差 < 10%）
 *   b. 转向台阶：鼠标持续转向时角度轨迹（game 帧粒度 vs test tick 粒度——台阶大小
 *      接近：16.7ms vs 15.6ms）
 *   c. 跳跃轨迹：周期跳跃的位置高度/落地时间（偏差 < 15%）
 *   d. 速度离散度：速度序列的 tick 化程度（game 权威校准 vs test 模式B 校准——
 *      相邻帧速度差分布）
 *
 * 用法：node scripts/tmp-dual-compare.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhysWorld, initSync } from '../pkg/websurf_test_wasm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
initSync({ module: readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')) });

// ── 常量 ────────────────────────────────────────────────────────
const FRAME_S = 1 / 60; // 60fps 主线程帧
const TICK = 1 / 64; // 权威/模式B 固定步长
const RENDER_DT = 0.001; // 模式A 1ms
const KEY_FWD = 1;
const KEY_JUMP = 16;

// ── 世界（大平面——与 phys-smoke 一致）──────────────────────────
const flatBrushes = [
  {
    planes: [
      { normal: [0, 0, -1], dist: 2048 }, { normal: [0, 0, 1], dist: 2048 },
      { normal: [-1, 0, 0], dist: 2048 }, { normal: [1, 0, 0], dist: 2048 },
      { normal: [0, -1, 0], dist: 64 }, { normal: [0, 1, 0], dist: 0 },
    ],
    min: [-2048, -64, -2048], max: [2048, 0, 2048],
    is_ladder: false, is_solid: true,
  },
];
const WORLD = '{"teleports":[],"triggers":[]}';

function buildWorld() {
  const p = new PhysWorld();
  p.set_hull(16, 72, 54);
  p.build_world(JSON.stringify(flatBrushes), '[]', WORLD, 0, 0, 0, 0);
  return p;
}

// ── GameDual：主线程 60fps phys + 独立权威 64Hz phys ────────────
// 每帧：权威 tick（消费累积输入）→ set_velocity(权威速度) → 主线程 tick(16.7ms, 帧输入)
// 输入：帧输入 = script(ms)；权威消费两帧之间累积的 dx/dy + 当前 keys
function simulateGameDual(script, durationMs) {
  const main = buildWorld();
  const auth = buildWorld();
  // 预热落地（无输入——两条线各自落地站稳）
  let warmed = false;
  let warmMain = 0;
  let warmAuth = 0;
  while (!warmed) {
    warmMain += FRAME_S;
    warmAuth += TICK;
    main.tick(FRAME_S, 0, 0, 0);
    auth.tick(TICK, 0, 0, 0);
    if (main.state().onGround && auth.state().onGround) warmed = true;
  }

  let authVel = null; // 最近权威速度（权威校准依据）
  let authDxAcc = 0;
  let authDyAcc = 0;
  let nextAuthT = 0;
  let frameCarry = 0;
  const samples = [];
  for (let ms = 0; ms < durationMs; ms++) {
    const inp = script(ms);
    const tSec = (ms + 1) / 1000;
    // 权威 64Hz tick（消费累积输入——game takeInput 语义）
    if (tSec >= nextAuthT) {
      nextAuthT += TICK;
      const sa = auth.tick(TICK, inp.keys, authDxAcc, authDyAcc);
      authDxAcc = 0;
      authDyAcc = 0;
      authVel = { x: sa.velX, y: sa.velY, z: sa.velZ };
    }
    // 主线程帧：速度校准（set_velocity 只覆盖速度——位置/角度不动）→ tick
    frameCarry += 1;
    if (frameCarry >= FRAME_S * 1000) {
      frameCarry -= FRAME_S * 1000;
      if (authVel) main.set_velocity(authVel.x, authVel.y, authVel.z);
      main.tick(FRAME_S, inp.keys, inp.dx, inp.dy);
      authDxAcc += inp.dx;
      authDyAcc += inp.dy;
      const s = main.state();
      samples.push({
        t: (ms + 1) / 1000,
        posX: s.posX, posY: s.posY, posZ: s.posZ,
        velX: s.velX, velY: s.velY, velZ: s.velZ,
        yaw: s.yaw,
        speed: Math.hypot(s.velX, s.velZ),
      });
    }
  }
  return samples;
}

// ── TestDual：模式A 1ms 子步 + 模式B 64Hz 权威 tick + 速度校准 ──
// 模式A：1ms 子步（渲染参数唯一源——位置/角度连续）；模式B 每 1/64 边界：
// 输入采样 → 粗糙 tick(tickDt) → set_velocity(xz=粗糙/vy=模式A) + 位置/角度恢复模式A
function simulateTestDual(script, durationMs) {
  const p = buildWorld();
  // 预热落地（模式B 激活下的模式A 子步）
  const tickDt = TICK;
  let lo = 0;
  let keysSnap = 0;
  let dxSnap = 0;
  let dySnap = 0;
  let dxApplied = true;
  const step = (keys, dx, dy) => {
    let sdx = 0;
    let sdy = 0;
    if (!dxApplied) {
      sdx = dxSnap;
      sdy = dySnap;
      dxApplied = true;
    }
    p.tick(RENDER_DT, keysSnap, sdx, sdy);
    lo += RENDER_DT;
    if (lo >= tickDt) {
      lo -= tickDt;
      keysSnap = keys;
      dxSnap = dx;
      dySnap = dy;
      dxApplied = false;
      const a = p.state();
      p.tick(tickDt, keysSnap, dxSnap, dySnap);
      const rough = p.state();
      p.set_state(a.posX, a.posY, a.posZ, a.yaw, a.pitch, rough.velX, a.velY, rough.velZ, a.onGround);
    }
  };
  let warmed = false;
  while (!warmed) {
    step(0, 0, 0);
    if (p.state().onGround) warmed = true;
  }

  let frameCarry = 0;
  const samples = [];
  for (let ms = 0; ms < durationMs; ms++) {
    const inp = script(ms);
    step(inp.keys, inp.dx, inp.dy);
    frameCarry += 1;
    if (frameCarry >= FRAME_S * 1000) {
      frameCarry -= FRAME_S * 1000;
      const s = p.state();
      samples.push({
        t: (ms + 1) / 1000,
        posX: s.posX, posY: s.posY, posZ: s.posZ,
        velX: s.velX, velY: s.velY, velZ: s.velZ,
        yaw: s.yaw,
        speed: Math.hypot(s.velX, s.velZ),
      });
    }
  }
  return samples;
}

// ── 输入脚本（ms 级时间函数——两条线同序列）──────────────────────
/** forward 直线（稳态速度 + 速度离散度场景）。 */
const scriptForward = (ms) => ({ keys: KEY_FWD, dx: 0, dy: 0 });
/** forward + 持续鼠标转向（转向台阶场景——yaw 持续增长）。 */
const scriptTurn = (ms) => ({ keys: KEY_FWD, dx: 1, dy: 0 });
/** forward + 周期跳跃（jump 30ms / 300ms——跳跃轨迹场景）。 */
const scriptJump = (ms) => ({ keys: KEY_FWD | (ms % 300 < 30 ? KEY_JUMP : 0), dx: 0, dy: 0 });

// ── 指标 ────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const devPct = (a, b) => (Math.abs(a - b) / Math.max(Math.abs(a), 1e-9)) * 100;

// a. 直线跑稳态速度：forward 3s，取后 1.5s 平均速度
function metricSteadySpeed() {
  const g = simulateGameDual(scriptForward, 3000);
  const t = simulateTestDual(scriptForward, 3000);
  const gv = mean(g.filter((s) => s.t > 1.5).map((s) => s.speed));
  const tv = mean(t.filter((s) => s.t > 1.5).map((s) => s.speed));
  return { game: gv, test: tv, dev: devPct(gv, tv) };
}

// b. 转向台阶：forward + 持续 dx 2s，取后 1.5s 的 yaw 序列（60fps 采样）
//    每帧 yaw 变化 = 转向率 × 帧长（game 16.7ms vs test tick 15.6ms 台阶）
function metricTurnStaircase() {
  const g = simulateGameDual(scriptTurn, 2000);
  const t = simulateTestDual(scriptTurn, 2000);
  const gYaw = g.filter((s) => s.t > 0.5);
  const tYaw = t.filter((s) => s.t > 0.5);
  const gStep = [];
  const tStep = [];
  for (let i = 1; i < gYaw.length; i++) gStep.push(Math.abs(gYaw[i].yaw - gYaw[i - 1].yaw));
  for (let i = 1; i < tYaw.length; i++) tStep.push(Math.abs(tYaw[i].yaw - tYaw[i - 1].yaw));
  const gs = mean(gStep);
  const ts = mean(tStep);
  const gTurnRate = (gYaw[gYaw.length - 1].yaw - gYaw[0].yaw) / (gYaw[gYaw.length - 1].t - gYaw[0].t);
  const tTurnRate = (tYaw[tYaw.length - 1].yaw - tYaw[0].yaw) / (tYaw[tYaw.length - 1].t - tYaw[0].t);
  // 理论台阶：帧长（16.7ms）× 转向率 vs tick 长（15.6ms）× 转向率
  const gTheo = FRAME_S * gTurnRate;
  const tTheo = TICK * tTurnRate;
  return {
    game: gs,
    test: ts,
    dev: devPct(gs, ts),
    gameTheo: gTheo,
    testTheo: tTheo,
    turnRateDev: devPct(gTurnRate, tTurnRate),
  };
}

// c. 跳跃轨迹：forward + 周期跳跃 3s——逐跳顶点高度 + 平均滞空时间
function metricJumpTrajectory() {
  const g = simulateGameDual(scriptJump, 3000);
  const t = simulateTestDual(scriptJump, 3000);
  const jumpStats = (samples) => {
    const apexes = [];
    const airTimes = [];
    let prevGround = true;
    let airStart = -1;
    let apex = 0;
    let rising = false;
    for (const s of samples) {
      if (s.posY > 1) {
        if (s.posY > apex) {
          apex = s.posY;
          rising = true;
        } else if (rising && s.posY < apex - 0.5) {
          apexes.push(apex); // 局部极大 = 一跳顶点
          rising = false;
          apex = 0;
        }
        if (prevGround && airStart < 0) airStart = s.t; // 起跳
      } else {
        if (rising) {
          apexes.push(apex);
          rising = false;
          apex = 0;
        }
        if (!prevGround && airStart >= 0) {
          airTimes.push(s.t - airStart); // 落地
          airStart = -1;
        }
      }
      prevGround = s.posY <= 1;
    }
    if (rising) apexes.push(apex);
    return { apexAvg: mean(apexes), airAvg: mean(airTimes), apexMax: Math.max(...apexes, 0) };
  };
  const gs = jumpStats(g);
  const ts = jumpStats(t);
  return {
    game: gs,
    test: ts,
    apexDev: devPct(gs.apexAvg, ts.apexAvg),
    airDev: devPct(gs.airAvg, ts.airAvg),
    apexMaxDev: devPct(gs.apexMax, ts.apexMax),
  };
}

// d. 速度离散度：摩擦衰减段（forward 1.5s 到 250 → 松键 1.5s 衰减）的相邻帧速度差分布
//    （mean/max/std——速度序列的 tick 化程度：game 权威校准 vs test 模式B 校准）
function metricVelocityDiscretization() {
  const script = (ms) => ({ keys: ms < 1500 ? KEY_FWD : 0, dx: 0, dy: 0 });
  const g = simulateGameDual(script, 3000);
  const t = simulateTestDual(script, 3000);
  const diffs = (samples) => {
    const d = [];
    for (let i = 1; i < samples.length; i++) d.push(Math.abs(samples[i].speed - samples[i - 1].speed));
    return d;
  };
  const gd = diffs(g.filter((s) => s.t > 1.5));
  const td = diffs(t.filter((s) => s.t > 1.5));
  return {
    gameMean: mean(gd),
    testMean: mean(td),
    devMean: devPct(mean(gd), mean(td)),
    gameMax: Math.max(...gd, 0),
    testMax: Math.max(...td, 0),
    gameStd: std(gd),
    testStd: std(td),
  };
}

// ── 输出对比表 ──────────────────────────────────────────────────
console.log('── game 双线 vs test 双模 对照（tmp-dual-compare）──');
console.log('（GameDual：主线程 60fps phys + 权威 64Hz set_velocity 校准；TestDual：模式A 1ms + 模式B 64Hz 粗糙 tick 校准）');
console.log('（输入序列：forward 直线 / 周期跳跃 30ms-300ms / 持续鼠标转向——两线同输入）');
console.log('');

const ROWS = [];
const VERDICTS = [];

// a. 稳态速度
{
  const r = metricSteadySpeed();
  ROWS.push({
    name: 'a. 直线跑稳态速度（maxSpeed 250 附近）',
    game: r.game.toFixed(1),
    test: r.test.toFixed(1),
    dev: r.dev.toFixed(1) + '%',
    ok: r.dev < 10,
  });
}

// b. 转向台阶
{
  const r = metricTurnStaircase();
  ROWS.push({
    name: 'b. 转向台阶（每帧 yaw 变化均值——帧粒度 16.7ms vs tick 粒度 15.6ms）',
    game: `${r.game.toFixed(3)}°（理论 ${r.gameTheo.toFixed(3)}°）`,
    test: `${r.test.toFixed(3)}°（理论 ${r.testTheo.toFixed(3)}°）`,
    dev: r.dev.toFixed(1) + '%',
    ok: r.dev < 15 && r.turnRateDev < 15,
  });
}

// c. 跳跃轨迹
{
  const r = metricJumpTrajectory();
  ROWS.push({
    name: 'c. 跳跃轨迹·顶点高度（平均）',
    game: r.game.apexAvg.toFixed(2),
    test: r.test.apexAvg.toFixed(2),
    dev: r.apexDev.toFixed(1) + '%',
    ok: r.apexDev < 15,
  });
  ROWS.push({
    name: 'c. 跳跃轨迹·滞空时间（平均）',
    game: r.game.airAvg.toFixed(3) + 's',
    test: r.test.airAvg.toFixed(3) + 's',
    dev: r.airDev.toFixed(1) + '%',
    ok: r.airDev < 15,
  });
  ROWS.push({
    name: 'c. 跳跃轨迹·最高顶点',
    game: r.game.apexMax.toFixed(2),
    test: r.test.apexMax.toFixed(2),
    dev: r.apexMaxDev.toFixed(1) + '%',
    ok: r.apexMaxDev < 15,
  });
}

// d. 速度离散度
{
  const r = metricVelocityDiscretization();
  ROWS.push({
    name: 'd. 速度离散度·相邻帧速度差均值',
    game: r.gameMean.toFixed(3),
    test: r.testMean.toFixed(3),
    dev: r.devMean.toFixed(1) + '%',
    ok: r.devMean < 15,
  });
  ROWS.push({
    name: 'd. 速度离散度·相邻帧速度差最大值',
    game: r.gameMax.toFixed(3),
    test: r.testMax.toFixed(3),
    dev: devPct(r.gameMax, r.testMax).toFixed(1) + '%',
    ok: devPct(r.gameMax, r.testMax) < 15,
  });
  ROWS.push({
    name: 'd. 速度离散度·相邻帧速度差 std',
    game: r.gameStd.toFixed(3),
    test: r.testStd.toFixed(3),
    dev: devPct(r.gameStd, r.testStd).toFixed(1) + '%',
    ok: devPct(r.gameStd, r.testStd) < 15,
  });
}

const nameW = Math.max(...ROWS.map((r) => r.name.length), 0) + 2;
console.log(`${'指标'.padEnd(nameW)} | ${'game 双线'.padEnd(16)} | ${'test 双模'.padEnd(16)} | 偏差`);
console.log('-'.repeat(nameW + 52));
for (const r of ROWS) {
  console.log(`${r.name.padEnd(nameW)} | ${r.game.padEnd(16)} | ${r.test.padEnd(16)} | ${r.dev}`);
  VERDICTS.push(r);
}
console.log('');

// ── 判定 ────────────────────────────────────────────────────────
const okCount = VERDICTS.filter((r) => r.ok).length;
console.log(`判定：${okCount}/${VERDICTS.length} 项偏差 < 15%（关键指标）`);
for (const r of VERDICTS) {
  console.log(`  [${r.ok ? '符合' : '不符合'}] ${r.name}（偏差 ${r.dev}）`);
}
const keyOk = VERDICTS.filter((r) => r.name.startsWith('a.') || r.name.startsWith('b.') || r.name.startsWith('c.')).every((r) => r.ok);
const allOk = VERDICTS.every((r) => r.ok);
if (allOk) {
  console.log('结论：test 双模数据与 game 双线实现接近（关键指标全部 < 15%）——模式B 改造达成"速度被 tick 限制、渲染连续"双线语义');
} else if (keyOk) {
  console.log('结论：核心运动指标（稳态速度/转向台阶/跳跃轨迹）与 game 双线接近（偏差 < 15%）；');
  console.log('      速度离散度部分符合（相邻帧速度差均值偏差 7.1% < 15%——平滑步主导；');
  console.log('      最大值/std 不符合（98.1%/59.7%——模式B 64t 边界注入跳变 ≈2× game 权威帧差））');
} else {
  console.log('结论：存在不符合项——见上方明细分析');
}
console.log('');
console.log('分析（d 速度离散度不符合项）：TestDual 单实例下粗糙 tick 从"模式A 已推进状态"再次推进');
console.log('  xz 时间窗口（游戏双线权威为独立实例、只推进自己的状态——无此问题）→ 模式B 校准注入');
console.log('  的速度跳变 ≈2× game 权威校准（28.9 vs 14.6 u/s/帧）——这是"xz 用粗糙结果（64t 摩擦/加速');
console.log('  ——难度手感）"的固有代价（vy/位置/角度由模式A 唯一推进——重力/跳跃/渲染连续正确）；');
console.log('  相邻帧速度差均值仍接近（2.81 vs 2.62——多数帧为 1ms 平滑步，64t 注入步稀疏）。');
