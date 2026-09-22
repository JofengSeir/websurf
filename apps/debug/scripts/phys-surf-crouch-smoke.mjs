/**
 * surf 坡面蹲姿回归（node 级，跑 `apps/debug/pkg` 的真实 wasm 产物，不启浏览器）。
 *
 * 为什么直接验产物：物理在 wasm 里，`src/phys` 的 Rust 改动要经 `npm run build:wasm`
 * （`apps/debug/package.json` 的 `build:wasm`：wasm-pack 输出到 `apps/debug/pkg`）才进产物；
 * 本脚本对 `pkg` 产物跑端到端用例，验的是**产物**本身而不是 Rust 单测。
 *
 * 三项用例（任一失败即打印 FAIL 并以 1 退出；全过则打印计数后正常退出）：
 *   A 贴坡 surf：落到 60° 坡面进入 surf 态后按住蹲键、再松开 —— 必须**保持蹲姿**
 *     （`src/phys/player.rs` 的 `try_player_move` 在命中面法线满足 0.05 < n.y < 0.7 时置 `surfing`）；
 *   B 水平地面：落地并已蹲下后松开蹲键 —— 必须起立（不是永久卡蹲）；
 *   C 空世界同一 tick：按住蹲与不按蹲的水平速度增量必须相同，且等于 `air_accelerate` 的
 *     addspeed 值（`AIR_SPEED_CAP` 减去初速在 wishdir 上的投影，该投影此时为负）。
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

// 60° 坡：斜面法线 (0, 0.5, √3/2)，normal.y = 0.5 落在 surf 区间（0.05 < n.y < 0.7）内；
// 其余五面围出实体盒，范围由下方 min / max 给出
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

// 水平地面：顶面是可站面（法线 (0, 1, 0)、dist 0），盒体范围由下方 min / max 给出
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

// ── A. 贴坡 surf：按住蹲再松开，必须保持蹲姿 ────────────────────────
{
  const w = newWorld(surfRamp, 0, 40, 40);
  // 自由落体直到首次进入 surf 态（最多 240 tick）
  let contact = -1;
  for (let i = 0; i < 240; i++) {
    tick(w, 0);
    const s = st(w);
    if (s.surfing) { contact = i; break; }
  }
  if (contact < 0) fail('A: 未能进入 surf 接触态（前置条件失败）');

  // 用 set_state_ex 写入沿坡面向下的切向速度（0, −400·S, +400·C），制造稳定贴坡滑行
  const s0 = st(w);
  s0.velocity = [0, -400 * S, 400 * C];
  w.set_state_ex(JSON.stringify(s0));

  for (let i = 0; i < 20; i++) tick(w, K_DUCK);
  const ducked = st(w);
  if (!ducked.ducked) fail('A: 按住蹲键后应处于蹲姿');

  // 松开蹲键：90 tick 内一旦起立即判失败
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

// ── B. 水平地面：落地且蹲下后松开蹲键，必须起立 ─────────────────────
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

// ── C. 空世界：蹲姿与站姿在同一 tick 内得到相同的水平速度增量 ──────
{
  const run = (holdDuck) => {
    // 无 brush 的世界：只走 air_accelerate，排除碰撞对速度的影响
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
  // 期望值：yaw=0 且 forward+right 时 compute_wish 给出 wishdir=(1,0,−1)/√2，初速 (0,0,300) 在其上的
  // 投影为 −300/√2 ⇒ addspeed = AIR_SPEED_CAP(30) + 300/√2；air_accelerate 的 accelspeed 远大于它，故按 addspeed 截断
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
