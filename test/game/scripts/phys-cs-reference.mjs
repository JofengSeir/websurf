#!/usr/bin/env node
/**
 * CS:S 参考值对照验证（走路 / 跳跃 / 高空坠落）
 *
 * 使用 test/game 真实 WASM PhysWorld（与运行时同一 Rust 物理核心），在简单平坦场景
 * 中测量：
 *   - 走路：平地持续前进的稳态速度、加速时间、松键停止时间
 *   - 跳跃：起跳初速、跳跃高度、空中时间
 *   - 高空坠落：1s 自由落体的速度/位移
 *
 * CS:S 参考：
 *   gravity=800, maxSpeed=250, accelerate=10, friction=4, stopSpeed=100,
 *   jumpSpeed≈302, jumpHeight≈57, 滞空≈0.755s
 *
 * 用法：node scripts/phys-cs-reference.mjs
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64;
const G = 800;
const CS_MAX_SPEED = 250;
const CS_JUMP_SPEED = 302;
const CS_JUMP_HEIGHT = 57;
const CS_AIRTIME = 0.755;
const KEY_FORWARD = 1;
const KEY_JUMP = 16;

const brushJson = JSON.stringify([
  {
    planes: [
      { normal: [0, -1, 0], dist: 0 },
      { normal: [0, 1, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 1000 },
      { normal: [-1, 0, 0], dist: 1000 },
      { normal: [0, 0, 1], dist: 1000 },
      { normal: [0, 0, -1], dist: 1000 },
    ],
    min: [-1000, 0, -1000], max: [1000, 0.01, 1000],
    is_ladder: false, is_solid: true,
  },
]);

function makeWorld(y = 100) {
  const w = new PhysWorld();
  w.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, y, 0, 0);
  return w;
}

function speed(s) {
  return Math.hypot(s.velX, s.velY, s.velZ);
}

function landOnGround(w) {
  let s = null;
  for (let i = 0; i < 200; i++) {
    s = w.tick(TICK, 0, 0, 0);
    if (s.onGround) return s;
  }
  throw new Error('200 tick 内未落地');
}

let failed = false;
function check(name, actual, expected, tol, unit = '') {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: actual=${actual.toFixed(2)}${unit} expected≈${expected.toFixed(2)}${unit} tol=±${tol.toFixed(2)}${unit}`);
  return ok;
}

console.log('=== CS:S 参考值对照（test/game WASM PhysWorld）===');

// ── 1. 走路 ────────────────────────────────────────────────
console.log('\n[走路] 平地持续前进 + 松键停止');
{
  const w = makeWorld();
  landOnGround(w);

  // 持续前进 2s，取最后 0.5s 稳态速度
  let s = null;
  const steady = [];
  for (let i = 0; i < 128; i++) {
    s = w.tick(TICK, KEY_FORWARD, 0, 0);
    if (i >= 96) steady.push(speed(s));
  }
  const steadySpeed = steady.reduce((a, b) => a + b, 0) / steady.length;
  check('稳态前进速度', steadySpeed, CS_MAX_SPEED, 8, ' u/s');

  // 加速时间：从 0 到 90% maxSpeed
  const accelWorld = makeWorld();
  landOnGround(accelWorld);
  let accelTicks = 0;
  for (let i = 1; i <= 128; i++) {
    const st = accelWorld.tick(TICK, KEY_FORWARD, 0, 0);
    if (speed(st) >= CS_MAX_SPEED * 0.9) {
      accelTicks = i;
      break;
    }
  }
  console.log(`INFO 加速到 90% maxSpeed 用时: ${(accelTicks * TICK).toFixed(3)}s（${accelTicks} ticks）`);

  // 松键停止：从稳态到 speed < 1
  let stopTicks = 0;
  for (let i = 1; i <= 128; i++) {
    s = w.tick(TICK, 0, 0, 0);
    if (speed(s) < 1) {
      stopTicks = i;
      break;
    }
  }
  console.log(`INFO 松键停止用时: ${(stopTicks * TICK).toFixed(3)}s（${stopTicks} ticks）`);
}

// ── 2. 跳跃 ────────────────────────────────────────────────
console.log('\n[跳跃] 起跳初速 / 高度 / 空中时间');
{
  const w = makeWorld();
  landOnGround(w);

  // 跳跃 tick
  const jumpStart = w.tick(TICK, KEY_JUMP, 0, 0);
  const initialVy = Math.max(jumpStart.velY, 0);
  check('起跳首 tick velY', initialVy, CS_JUMP_SPEED, 25, ' u/s');

  // 继续无输入，记录最高点与落地
  let maxY = jumpStart.posY;
  let apexTick = 0;
  let landTick = -1;
  for (let i = 1; i <= 120; i++) {
    const st = w.tick(TICK, 0, 0, 0);
    if (st.posY > maxY) {
      maxY = st.posY;
      apexTick = i;
    }
    if (st.onGround && i > 1) {
      landTick = i;
      break;
    }
  }
  const jumpHeight = maxY - jumpStart.posY;
  const airTime = landTick > 0 ? landTick * TICK : NaN;
  check('跳跃高度', jumpHeight, CS_JUMP_HEIGHT, 6, ' u');
  check('空中时间', airTime, CS_AIRTIME, 0.06, ' s');
  console.log(`INFO apex tick=${apexTick} land tick=${landTick}`);
}

// ── 3. 高空坠落 ────────────────────────────────────────────
console.log('\n[高空坠落] 1s 自由落体');
{
  const w = makeWorld(1000);
  let s = null;
  for (let i = 0; i < 64; i++) {
    s = w.tick(TICK, 0, 0, 0);
  }
  // 自由落体 1s：Δy = 0.5*g*t^2 = 400，vy = -g*t = -800
  const expectedY = 1000 - 0.5 * G * 1 * 1;
  check('1s 后 posY', s.posY, expectedY, 5, ' u');
  check('1s 后 velY', s.velY, -G, 8, ' u/s');
  console.log(`INFO 实际 pos=(${s.posX.toFixed(1)},${s.posY.toFixed(1)},${s.posZ.toFixed(1)}) velY=${s.velY.toFixed(1)}`);
}

console.log('\n' + (failed ? 'RESULT: FAIL ❌ 存在与 CS:S 参考不一致的项' : 'RESULT: ALL PASS ✅ 走路/跳跃/高空坠落与 CS:S 参考一致或接近'));
process.exit(failed ? 1 : 0);
