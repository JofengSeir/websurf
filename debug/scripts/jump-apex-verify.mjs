#!/usr/bin/env node
/**
 * 跳跃顶高离群值判定实验（确定性 node，无浏览器/无 Worker）。
 *
 * 目的：把用户报告的「跳跃高度不一致 / 偶尔跳得特别高」变成可复现的数字。
 *
 * 架构镜像（与 debug 生产逐行同序，见 debug/src/renderer/renderer-main.ts:552-587）：
 *   render  = PhysWorld（wasm，renderer-main `predPhys`）—— 每"帧" tick
 *   auth    = PhysWorld（wasm，worker-dispatch `env.phys.current`）—— 固定 64Hz tick
 *   cal     = **真实** `AuthorityCalibrator`（src/ts-shared/phys/authority-calibrator.ts）
 *   每帧：addInput → correctFromAuthority() → calibrateVelocity(now) → predPhys.tick()
 *
 * 本脚本自己实现的两条**接线**（正是被怀疑的两条通道，A/B 开关即修复 A/B）：
 *   ① `onSyncRenderState` → worker-dispatch.ts 的 `phys.set_state(...)`（常规重锚）
 *        full    = 修复前：渲染整份状态（含 onGround / 速度）灌进权威
 *        posonly = 修复 A：只播位置，权威的 yaw/pitch/速度/onGround 保持自身值
 *   ② 权威 `phys-event{land}` → debug/src/app.ts:328 → `cal.applyCollisionCorrection`
 *        legacy  = 修复前行为（内联复刻 calibrator.ts 旧代码：无条件写 onGround=true）
 *        prod    = 调用**当前源码**的真实方法（修复 B 后 = 渲染腾空时不写）
 *      注意：`legacy` 是内联复刻的旧代码，与源码修订无关，故本脚本在同一份源码上
 *      即可跑出「修复前 / 修复后」两列，互相对照。
 *
 * 冲量判定：`check_jump` 把 v_y **赋值**为 √(2·800·57)=302（player.rs:560-561），
 * 故「pre-tick onGround=true ∧ post-tick v_y > 250」= 本 tick 发生了一次起跳。
 * 冲量施加点高度 h = pre-tick posY − groundY：h≈0 = 正常地面起跳，h>2 = 腾空起跳。
 *
 * 用法：node scripts/jump-apex-verify.mjs
 *       npm run test:jump-apex
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = join(HERE, '..');
const REPO = join(DEBUG_DIR, '..');
const HARNESS_PKG = join(REPO, 'test', 'dual-mode-harness', 'pkg', 'websurf_test_wasm.js');
const HARNESS_WASM = join(REPO, 'test', 'dual-mode-harness', 'pkg', 'websurf_test_wasm_bg.wasm');
const CAL_BUNDLE = join(DEBUG_DIR, '.tmp', 'jump-apex', 'authority-calibrator.bundle.mjs');

// ── 确定性时钟（calibrator 内部用 performance.now()）──────────────────
const clock = { t: 1000, now() { return this.t; } };
Object.defineProperty(globalThis, 'performance', {
  value: clock, configurable: true, writable: true,
});

const { PhysWorld, initSync } = await import(new URL(`file://${HARNESS_PKG}`).href);
initSync({ module: readFileSync(HARNESS_WASM) });
const { AuthorityCalibrator } = await import(new URL(`file://${CAL_BUNDLE}`).href);

// ── 世界：平地（顶面 y=0；与 phys-smoke.mjs:92-106 同一手工 brush）──────
const BRUSHES = [
  {
    planes: [
      { normal: [0, 0, -1], dist: 2048 },
      { normal: [0, 0, 1], dist: 2048 },
      { normal: [-1, 0, 0], dist: 2048 },
      { normal: [1, 0, 0], dist: 2048 },
      { normal: [0, -1, 0], dist: 64 },
      { normal: [0, 1, 0], dist: 0 },
    ],
    min: [-2048, -64, -2048], max: [2048, 0, 2048], is_ladder: false, is_solid: true,
  },
];
const TELEPORT_JSON = '{"teleports":[],"triggers":[]}';
const PARAMS = JSON.stringify({
  gravity: 800, accelerate: 10, friction: 4, stop_speed: 100,
  jump_height: 57, air_accelerate: 150, run_speed: 250,
  autobhop: true, bhop_speed_clamp: true, no_prestrafe: true,
});
const KEY_JUMP = 0x10; // shared-state.ts KEY_MASK.jump
const GROUND_Y = 0;
const MID_AIR_HU = 2;

function makeWorld(spawnY) {
  const p = new PhysWorld();
  p.set_hull(16, 72, 54);
  p.build_world(JSON.stringify(BRUSHES), '[]', TELEPORT_JSON, 0, spawnY, 0, 0);
  p.set_params(PARAMS);
  return p;
}

/**
 * 单次实验。
 * @param opts.frameHz    渲染帧率（rAF）
 * @param opts.authority  'full' | 'posonly'   修复 A：重锚载荷
 * @param opts.land       'legacy' | 'prod'  修复 B：land 事件是否写 onGround
 * @param opts.accel      true|false           诊断：calibrateVelocity 加速度外推
 */
function run(opts) {
  const fixedDt = 1 / 64;
  const LAT_MS = 2; // 权威发布 → 主线程可读（SAB/消息往返 ≈2ms）
  const render = makeWorld(8);
  const auth = makeWorld(8);

  // 预热：两线各自落地稳定
  for (let i = 0; i < 64; i++) render.tick(fixedDt, 0, 0, 0);
  for (let i = 0; i < 64; i++) auth.tick(fixedDt, 0, 0, 0);

  // ── 跨线程状态（键位槽 + 权威帧发布队列）──
  let sharedKeys = 0;
  let va = 0;
  let mailbox = [];
  let events = [];
  let prevAuthOnGround = auth.state().onGround;
  let workerSimMs = 0;

  // ── calibrator 装配（deps 与 renderer-main.ts:204-230 同构）──
  let pendingDx = 0, pendingDy = 0, pendingKeys = 0;
  const deps = {
    readAuth() {
      let best = null;
      for (const m of mailbox) if (m.readableAt <= clock.t && (!best || m.va > best.va)) best = m;
      if (!best) return null;
      mailbox = mailbox.filter((m) => m.va >= best.va - 1);
      return { frame: best.frame, va: best.va };
    },
    getPhys() {
      return {
        state: () => render.state(),
        set_state: (...a) => render.set_state(...a),
        set_velocity: (...a) => render.set_velocity(...a),
      };
    },
    clearPendingInput() { pendingDx = 0; pendingDy = 0; },
    onSyncRenderState(s, teleport) {
      // 接线①：镜像 worker-dispatch.ts:356-404 的 sync-render-state 处理
      if (opts.authority === 'full') {
        auth.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
      } else {
        const cur = auth.state(); // 只播位置：其余字段保持权威自身值
        auth.set_state(s.posX, s.posY, s.posZ, cur.yaw, cur.pitch, cur.velX, cur.velY, cur.velZ, cur.onGround);
      }
      void teleport;
    },
  };
  const cal = new AuthorityCalibrator(deps);
  if (!opts.accel) cal.computeAuthAccel = () => ({ x: 0, y: 0, z: 0 });

  // ── 统计 ──
  const flights = [];
  let cur = null;
  const stat = {
    authImpulses: 0, authImpulsesMidAir: 0,
    renderImpulses: 0, renderImpulsesMidAir: 0,
    maxAuthVelY: -1e9, maxRenderSetVelY: -1e9, landWhileAirborne: 0, landEvents: 0,
  };

  const workerStep = (tickMs) => {
    const before = auth.state();
    auth.tick(fixedDt, sharedKeys, 0, 0);
    const after = auth.state();
    if (before.onGround && after.velY > 250) {
      stat.authImpulses++;
      if (before.posY - GROUND_Y > MID_AIR_HU) stat.authImpulsesMidAir++;
    }
    if (after.posY - GROUND_Y > 0 && after.velY > stat.maxAuthVelY) stat.maxAuthVelY = after.velY;
    va++;
    mailbox.push({
      readableAt: tickMs + LAT_MS, va,
      frame: {
        pos: { x: after.posX, y: after.posY, z: after.posZ },
        yaw: after.yaw, pitch: after.pitch,
        vel: { x: after.velX, y: after.velY, z: after.velZ },
        onGround: after.onGround, eyeHeight: after.eyeHeight, timeMs: tickMs,
      },
    });
    // 权威 land 边沿（镜像 auth-loop.ts:352-362）
    if (!prevAuthOnGround && after.onGround) {
      stat.landEvents++;
      events.push({
        at: tickMs + LAT_MS, kind: 'land',
        pos: [after.posX, after.posY, after.posZ],
        vel: [after.velX, after.velY, after.velZ],
        yawDeg: after.yaw, pitchDeg: after.pitch,
      });
    }
    prevAuthOnGround = after.onGround;
  };

  const frameDt = 1 / opts.frameHz;
  const jitter = opts.jitter ?? 0;
  let rndState = 12345;
  const rnd = () => { rndState = (rndState * 1103515245 + 12345) & 0x7fffffff; return rndState / 0x7fffffff; };
  let lastTickMs = 0;
  const totalFrames = Math.round((opts.durationMs / 1000) * opts.frameHz);

  for (let f = 0; f < totalFrames; f++) {
    const dtf = frameDt * (1 + jitter * (rnd() * 2 - 1));
    clock.t += dtf * 1000;
    const now = clock.t;
    const dt = lastTickMs === 0 ? frameDt : Math.min((now - lastTickMs) / 1000, 0.1);
    lastTickMs = now;

    // 权威循环推进（帧间所有 64Hz tick）
    while (workerSimMs + fixedDt * 1000 <= now + 1e-9) {
      workerSimMs += fixedDt * 1000;
      workerStep(workerSimMs);
    }

    // 主线程消息处理（phys-event；镜像 debug/src/app.ts:325-330）
    for (const ev of events) {
      if (ev.at > now) continue;
      if (ev.kind !== 'land') continue;
      const rNow = render.state();
      if (!rNow.onGround) stat.landWhileAirborne++;
      if (opts.land === 'legacy') {
        // 修复前行为内联复刻（authority-calibrator.ts 旧代码：无条件 onGround=true）
        render.set_state(
          rNow.posX, rNow.posY, rNow.posZ, rNow.yaw, rNow.pitch,
          ev.vel[0], ev.vel[1], ev.vel[2], true,
        );
      } else {
        cal.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg, ev.vel);
      }
    }
    events = events.filter((ev) => ev.at > now);

    // 输入（镜像 app.ts startInputLoop → rendererMain.feedInput）
    sharedKeys = opts.holdJump ? KEY_JUMP : 0;
    pendingKeys = sharedKeys;

    // 生产同序（renderer-main.ts:556-587）
    cal.correctFromAuthority();
    cal.calibrateVelocity(now);
    const preSet = render.state(); // set_velocity 之后、tick 之前
    if (preSet.velY > stat.maxRenderSetVelY) stat.maxRenderSetVelY = preSet.velY;
    render.tick(dt, pendingKeys, pendingDx, pendingDy);
    const post = render.state();
    pendingDx = 0; pendingDy = 0;

    if (preSet.onGround && post.velY > 250) { // 本帧发生起跳
      const h = preSet.posY - GROUND_Y;
      stat.renderImpulses++;
      if (h > MID_AIR_HU) stat.renderImpulsesMidAir++;
      if (cur === null) cur = { apex: post.posY, impulses: 1, maxImpulseH: h, startH: h };
      else { cur.impulses++; cur.maxImpulseH = Math.max(cur.maxImpulseH, h); }
    }
    if (cur) cur.apex = Math.max(cur.apex, post.posY);
    if (post.onGround && cur) { cur.apexH = cur.apex - GROUND_Y; flights.push(cur); cur = null; }
  }

  return { flights, stat, frameHz: opts.frameHz };
}

function summarize(tag, r) {
  const apex = r.flights.map((f) => f.apexH).filter((v) => Number.isFinite(v));
  const sorted = [...apex].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const s = r.stat;
  return {
    tag, frameHz: r.frameHz, n: apex.length,
    median: med, min: sorted[0], max: sorted[sorted.length - 1],
    apex: sorted.map((v) => +v.toFixed(1)),
    multiImpulseFlights: r.flights.filter((f) => f.impulses > 1).length,
    midAirFlights: r.flights.filter((f) => f.maxImpulseH > MID_AIR_HU).length,
    apexOver70: r.flights.filter((f) => f.apexH > 70).length,
    deadFlights: r.flights.filter((f) => f.apexH < 20).length,
    authImpulses: s.authImpulses, authImpulsesMidAir: s.authImpulsesMidAir,
    renderImpulses: s.renderImpulses, renderImpulsesMidAir: s.renderImpulsesMidAir,
    landEvents: s.landEvents, landWhileAirborne: s.landWhileAirborne,
    maxAuthVelY: +s.maxAuthVelY.toFixed(1), maxRenderSetVelY: +s.maxRenderSetVelY.toFixed(1),
  };
}

// ── 矩阵：帧率 × 修复 A/B × 加速度外推 ────────────────────────────────
// ①/② 两列的语义见文件头：authority 'full' = 修复前重锚；'posonly' = 修复 A（已在源码）
// land 'legacy' = 修复前 land 写；'prod' = 当前源码真实方法（修复 B）
const MATRIX = [
  { name: '①修复前 + ②修复前（历史 baseline）', authority: 'full', land: 'legacy', accel: true },
  { name: '仅修复A（重锚只播位置）', authority: 'posonly', land: 'legacy', accel: true },
  { name: '仅修复B（land 腾空不写）', authority: 'full', land: 'prod', accel: true },
  { name: '修复A+B（= 当前生产接线）', authority: 'posonly', land: 'prod', accel: true },
  { name: '修复A+B + 关加速度外推（诊断）', authority: 'posonly', land: 'prod', accel: false },
];
const FRAME_RATES = [
  { hz: 60, jitter: 0, label: '60Hz' },
  { hz: 144, jitter: 0, label: '144Hz' },
  { hz: 144, jitter: 0.25, label: '144Hz 抖动±25%' },
  { hz: 165, jitter: 0, label: '165Hz' },
  { hz: 240, jitter: 0, label: '240Hz' },
];
const DURATION_MS = 20000;

console.log('=== 跳跃顶高判定实验（平地按住空格连跳；autobhop=true）===');
console.log(`理论顶高 = v²/2g = 302²/1600 = ${(302 * 302 / 1600).toFixed(1)} HU（groundY=0）`);
console.log(`参数：时长 ${DURATION_MS / 1000}s/格，权威 64Hz，发布延迟 2ms\n`);

for (const rate of FRAME_RATES) {
  console.log(`################ 渲染 ${rate.label} ################`);
  for (const variant of MATRIX) {
    const r = run({ frameHz: rate.hz, jitter: rate.jitter, durationMs: DURATION_MS, holdJump: true, ...variant });
    const s = summarize(`${rate.label} ${variant.name}`, r);
    console.log(`── ${s.tag}`);
    console.log(`   飞行段 ${s.n} | 顶高 中位 ${s.median?.toFixed(1)} 最小 ${s.min?.toFixed(1)} 最大 ${s.max?.toFixed(1)}`);
    console.log(`   顶高列表 ${JSON.stringify(s.apex)}`);
    console.log(`   顶高>70HU ${s.apexOver70} | 死跳(<20HU) ${s.deadFlights} | 单段多次冲量 ${s.multiImpulseFlights} | 腾空起跳 渲染 ${s.renderImpulsesMidAir} 权威 ${s.authImpulsesMidAir}`);
    console.log(`   冲量 渲染 ${s.renderImpulses} 权威 ${s.authImpulses} | land 事件 ${s.landEvents}（其中渲染在空 ${s.landWhileAirborne}）| 权威 maxV_y ${s.maxAuthVelY} 渲染 set_velocity maxV_y ${s.maxRenderSetVelY}\n`);
  }
}
