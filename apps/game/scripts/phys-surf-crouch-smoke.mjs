/**
 * surf 坡面蹲姿回归（node 级，跑真实 wasm 产物，不需要浏览器）。
 *
 * 三件断言，任一不成立即打印 FAIL 行并以退出码 1 结束；三件全过时末行是 `全部通过：3/3`。
 *   A 贴坡 surf：蹲下后松开蹲键 → 保持蹲姿
 *   B 落地后松开蹲键 → 起立（不是永久卡蹲）
 *   C 空中蹲姿的每 tick 动量增量与站姿一致（两者都按站姿参数算）
 *
 * 判据出自 `src/phys/player.rs`：
 * - `update_duck` 的起立分支：地面起立只要求原地站立箱空闲；空中（含贴坡）起立要把 origin
 *   下移「站立箱高 − 蹲箱高」（默认 18 HU）并放脚，判据是站立箱从当前 origin 扫掠到目标位置的
 *   `fraction == 1.0` 且非 `start_solid` / `all_solid`，不满足就保持蹲姿。
 * - `air_accelerate`：`addspeed` 一侧把 wishspeed 钳到 `AIR_SPEED_CAP`（30 HU/s），
 *   `accelspeed` 一侧用未钳制的 wishspeed 乘 `AIR_ACCELERATE`；`current_max_speed` 只在
 *   地面看 `ducked`，故蹲姿不降低空中上限 —— 这就是 C 两条线逐 tick 相同的依据。
 *
 * 为什么要跑产物而不是只跑 Rust 单测：物理在 wasm 里，`src/phys` 的 Rust 改动必须先经
 * `apps/game/package.json` 的 `build:wasm`（wasm-pack 输出到 `pkg/`，再把 wasm 复制进 `web/`）
 * 才会反映到 `pkg/websurf_wasm_bg.wasm`；`apps/game/start-dev.cmd` 则按共享脚本
 * `src/scripts/wasm-stale-check.mjs` 的 mtime 判定（产物不比 `src/` 与 `crates/` 下的
 * Rust 源新即跳过重建）决定是否重跑 `build:wasm`。本脚本直接加载 `pkg/` 下的产物。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-surf-crouch-smoke.mjs`
 * （`apps/game/package.json` 的 `test:surf-crouch` 即该命令）。
 * 无产物落盘。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

// 步长与三个键位掩码（位定义见 `src/phys/mod.rs` 的 `apply_input`）
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

// 三个小工具：建世界（空 tri、空传送）、读种子 JSON、按步长推进
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
  // 自由落到坡面首次接触（surfing 置位）——这是本场景的前置条件
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

  // 按住蹲键 20 tick：空中/贴坡蹲下由 update_duck 处理
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
  // 起立即判失败：贴坡时脚下放不下那 18 HU 的站立箱（update_duck 的空中起立分支）
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
  // 40 tick 按住蹲键：先落地、再进入蹲姿
  for (let i = 0; i < 40; i++) tick(w, K_DUCK);
  const g = st(w);
  if (!g.on_ground) fail('B: 前置——应已落地');
  if (!g.ducked) fail('B: 前置——应已蹲下');
  // 松开蹲键后地面起立只要求原地站立箱空闲，应在有限 tick 内站起
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
