/**
 * 贴地滑行段逐 tick 对照：把「盒在平顶台上落地后沿坡滑行」的全过程摊开，逐 tick 打印
 * `onGround`、速度、位置与 `|Δv| − gravity × dt`，用来把摩擦减速与碰撞剪裁分开。
 *
 * 几何与 `apps/game/scripts/phys-p2-trace.mjs` 同一套：平顶台（顶面 `y = 0`、`z <= 0`）
 * + 60° 坡（坡面外法线 `(0, cos60, sin60)`）；出生点 `(0, 2.1, -30)`、yaw 0、
 * `set_velocity(0, 0, 300)`。
 *
 * 两条步长线：64 Hz 跑 200 步、144 Hz 跑 450 步（同为 3.125 s）。`run` 内每步取
 * `g = 800 × dt` 作「纯重力每步速度增量」，`dv` 是与上一 tick 的三维速度差，`dv − g`
 * 即非重力来源的那部分变化量；`|dv − g| > 0.01` 的步记为碰撞候选（入行的字段是 `coll`）。
 *
 * 打印策略：前 12 步、所有候选步、`onGround` 翻转步、每 25 步与最后一步。
 *
 * 摩擦口径（`src/phys/player.rs` 的 `apply_friction`）：控制速度取
 * `max(当前速率, stop_speed)`（默认 `stop_speed = 100`），每步扣除
 * `控制速度 × friction × dt`；默认 `friction = 4` 时速率按 `1 − friction × dt` 衰减，
 * 即 64 Hz 每步 ×0.9375、144 Hz 每步 ×0.9722。地面步进不带竖直重力（`walk_move`），
 * 所以贴台段的速度变化只来自摩擦或碰撞剪裁。
 *
 * 「P2」指坡形 brush 幽灵面这一组排查：门校验本身的回归在 `src/phys/p2_gate_tests.rs`，
 * 门否决只跳过该平面的进入判定、不改速度（`src/phys/world.rs` 的 `clip_planes`）。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-p2-ground.mjs`。
 * 无产物落盘；退出码恒为 0，判据是 stdout。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
const TH = Math.PI / 3, COS = Math.cos(TH), SIN = Math.sin(TH);

// 平顶台：顶面 y = 0，台面覆盖 z <= 0
const flatTop = brush(
  [P([0, 1, 0], 0), P([0, -1, 0], 2000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, 1], 0), P([0, 0, -1], 4000)],
  [-X, -2000, -4000], [X, 0, 0],
);
// 60° 坡：坡面 y = -z·tan60°，实体在坡面下方，z ∈ [0, 1500]
const ramp = brush(
  [P([0, COS, SIN], 0), P([0, -1, 0], 3000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, -1], 0), P([0, 0, 1], 1500)],
  [-X, -3000, 0], [X, 0, 1500],
);
const geo = [flatTop, ramp];

function run(dt, nSteps) {
  const w = new PhysWorld();
  // 空 tri、空传送；出生点 (0, 2.1, -30)、yaw 0，随后给 vz = 300 HU/s；全程不按键
  w.build_world(JSON.stringify(geo), '[]', '{"teleports":[],"triggers":[]}', 0, 2.1, -30, 0);
  w.set_velocity(0, 0, 300);
  let st = null, prev = null;
  const rows = [];
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    const dv = prev ? Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ) : 0;
    const g = 800 * dt; // 纯重力每 tick 速度增量
    const coll = Math.abs(dv - g) > 0.01 && prev && Math.abs(dv - g) > 1e-6 && Math.abs(dv) > 0.01;
    const collide = prev ? Math.abs(dv - g) > 0.01 && Math.abs(dv) > 0.01 : false;
    // 行字段：dv 存的是 dv − g（非重力来源的变化量），coll 是该步是否为碰撞候选
    rows.push({ i: i + 1, t: (i + 1) * dt, onGround: st.onGround, v: [st.velX, st.velY, st.velZ], p: [st.posX, st.posY, st.posZ], dv: dv - g, coll: collide });
  }
  return { w, st, rows };
}

for (const [dt, nSteps, label] of [[1 / 64, 200, '64Hz'], [1 / 144, 450, '144Hz']]) {
  const { w, st, rows } = run(dt, nSteps);
  console.log(`\n===== ${label} (dt=${dt})  gate_veto_count=${w.gate_veto_count()}  最终 v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(1)},${st.posY.toFixed(1)},${st.posZ.toFixed(1)})`);
  console.log(`  tick   t       ground   velX velY   velZ    posX posY   posZ    |dv|-g`);
  let lastGround = null;
  // 只打有信息量的行：前 12 步、候选步、落地状态翻转、每 25 步与末步
  for (const r of rows) {
    const isTrans = r.onGround !== lastGround;
    const showAll = r.i <= 12 || r.coll || isTrans || r.i % 25 === 0 || r.i === rows.length;
    if (showAll || isTrans) {
      console.log(`  ${String(r.i).padStart(4)} ${r.t.toFixed(4)} ${r.onGround ? ' G' : ' A'}  ${r.v[0].toFixed(1).padStart(6)} ${r.v[1].toFixed(1).padStart(5)} ${r.v[2].toFixed(1).padStart(7)}  ${r.p[0].toFixed(0).padStart(5)} ${r.p[1].toFixed(3).padStart(7)} ${r.p[2].toFixed(2).padStart(8)}  ${r.dv.toFixed(3)}${r.coll ? '  <-- 非重力速度变化(碰撞?)' : ''}`);
    }
    lastGround = r.onGround;
  }
  // 候选步总数：贴台段的摩擦步也会落进来，需与摩擦公式对照后再判定
  const gravTicks = rows.filter(r => r.coll).length;
  console.log(`  非纯重力速度变化 tick 数（碰撞候选）: ${gravTicks}`);
}