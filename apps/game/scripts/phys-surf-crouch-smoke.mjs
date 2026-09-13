/**
 * surf 坡面蹲姿回归（node 级，跑真实 wasm 产物，禁浏览器）。
 *
 * 背景：物理跑在 wasm 里，`src/phys` 的 Rust 改动必须 `npm run build:wasm` 才生效；
 * 各工程的 start-dev.cmd 存在「wasm 已存在就跳过构建」的分支，容易出现
 * "改了源码但行为没变"。本脚本直接对 pkg 产物做端到端验证，
 * 避免只验 Rust 单测而漏掉产物陈旧。
 *
 * 验证：
 *   A 贴坡 surf：蹲下后松开蹲键 → **保持蹲姿**（对齐 Source CanUnduck 失败）
 *   B 落地后松开蹲键 → 起立（不是永久卡蹲）
 *   C 空中蹲姿的动量与站姿一致（站姿参数；addspeed 钳制下两者逐 tick 相同）
 *
 * 用法：node scripts/phys-surf-crouch-smoke.mjs（需先 npm run build:wasm）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

const DT = 1 / 64;
const K_FORWARD = 0x01;
const K_RIGHT = 0x08;
const K_DUCK = 0x20;

let passed = 0;
const ok = (m) => { passed += 1; console.log('OK   ' + m); };
const fail = (m) => { console.error('FAIL ' + m); process.exit(1); };

// 60° surf 坡：法线 (0, 0.5, 0.866)，normal.y = 0.5 ∈ surf 区间 (0.05, 0.7)
const S = Math.sqrt(3) / 2; // 0.8660254
const C = 0.5;
const surfRamp = JSON.stringify([
  {
    planes: [
      { normal: [0, C, S], dist: 0 },
      { normal: [0, -1, 0], dist: 4000 },
      { normal: [1, 0, 0], dist: 2000 },
      { normal: [-1, 0, 0], dist: 2000 },
      { normal: [0, 0, -1], dist: 0 },
      { normal: [0, 0, 1], dist: 4000 },
    ],
    min: [-2000, -4000, 0], max: [2000, 0, 4000],
    is_ladder: false, is_solid: true,
  },
]);

// 水平地面（顶面 y = 0）
const floor = JSON.stringify([
  {
    planes: [
      { normal: [0, 1, 0], dist: 0 },
      { normal: [0, -1, 0], dist: 2000 },
      { normal: [1, 0, 0], dist: 2000 },
      { normal: [-1, 0, 0], dist: 2000 },
      { normal: [0, 0, 1], dist: 2000 },
      { normal: [0, 0, -1], dist: 2000 },
    ],
    min: [-2000, -2000, -2000], max: [2000, 0, 2000],
    is_ladder: false, is_solid: true,
  },
]);

const emptyTele = '{"teleports":[],"triggers":[]}';
const newWorld = (brush, sx, sy, sz) => {
  const w = new PhysWorld();
  w.build_world(brush, '[]', emptyTele, sx, sy, sz, 0);
  return w;
};
const st = (w) => JSON.parse(w.state_full_json(false));
const tick = (w, keys) => w.tick(DT, keys, 0, 0);

// ── A. 贴坡 surf：蹲下松开 → 保持蹲姿 ────────────────────────────────
{
  const w = newWorld(surfRamp, 0, 40, 40);
  // 自由落到坡面首次接触
  let contact = -1;
  for (let i = 0; i < 240; i++) {
    tick(w, 0);
    const s = st(w);
    if (s.surfing) { contact = i; break; }
  }
  if (contact < 0) fail('A: 未能进入 surf 接触态（前置条件失败）');

  // 给沿坡切向速度（0, -0.866, 0.5）× 400，复刻稳定贴坡滑行
  const s0 = st(w);
  s0.velocity = [0, -400 * S, 400 * C];
  w.set_state_ex(JSON.stringify(s0));

  for (let i = 0; i < 20; i++) tick(w, K_DUCK);
  const ducked = st(w);
  if (!ducked.ducked) fail('A: 按住蹲键后应处于蹲姿');

  // 松开蹲键，继续滑行
  let stoodAt = -1;
  for (let i = 0; i < 90; i++) {
    tick(w, 0);
    if (!st(w).ducked) { stoodAt = i; break; }
  }
  const end = st(w);
  if (stoodAt >= 0) {
    fail(
      `A: 贴坡 surf 松开蹲键后不应起立（第 ${stoodAt} tick 站起；` +
      `onGround=${end.on_ground} surfing=${end.surfing} y=${end.origin[1].toFixed(2)}）`
    );
  }
  ok(`A: 贴坡 surf 松开蹲键保持蹲姿 ✓（90 tick 未起立，surfing=${end.surfing}）`);
}

// ── B. 落地后松开蹲键 → 起立 ─────────────────────────────────────────
{
  const w = newWorld(floor, 0, 1, 0);
  for (let i = 0; i < 40; i++) tick(w, K_DUCK);
  const g = st(w);
  if (!g.on_ground) fail('B: 前置——应已落地');
  if (!g.ducked) fail('B: 前置——应已蹲下');
  let stood = false;
  for (let i = 0; i < 20; i++) {
    tick(w, 0);
    if (!st(w).ducked) { stood = true; break; }
  }
  if (!stood) fail('B: 落地后松开蹲键应起立（不应永久卡蹲）');
  ok('B: 落地后松开蹲键起立 ✓');
}

// ── C. 空中蹲姿动量 == 站姿动量（站姿参数） ──────────────────────────
{
  const run = (holdDuck) => {
    // 空世界（无 brush）→ 纯 air_accelerate，去掉碰撞差异
    const w = new PhysWorld();
    w.build_world('[]', '[]', emptyTele, 0, 1000, 0, 0);
    const s = st(w);
    s.velocity = [0, 0, 300];
    w.set_state_ex(JSON.stringify(s));
    const before = st(w).velocity;
    tick(w, K_FORWARD | K_RIGHT | (holdDuck ? K_DUCK : 0));
    const after = st(w).velocity;
    return Math.hypot(after[0] - before[0], after[2] - before[2]);
  };
  const dvDuck = run(true);
  const dvStand = run(false);
  // 理论：wishdir=(1,0,-1)/√2；addspeed = 30 + 300/√2 ≈ 242.1320
  const addspeed = 30 + 300 / Math.SQRT2;
  if (Math.abs(dvDuck - dvStand) > 1e-6) {
    fail(`C: 空中蹲姿动量应等于站姿；蹲=${dvDuck.toFixed(6)} 站=${dvStand.toFixed(6)}`);
  }
  if (Math.abs(dvDuck - addspeed) > 1e-3) {
    fail(`C: 空中加速度应由 addspeed 钳住；期望≈${addspeed.toFixed(6)}，实测 ${dvDuck.toFixed(6)}`);
  }
  ok(`C: 空中蹲姿动量 == 站姿 ✓（${dvDuck.toFixed(4)} = addspeed ${addspeed.toFixed(4)}）`);
}

console.log(`\n全部通过：${passed}/3`);
