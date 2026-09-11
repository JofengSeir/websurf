/** P2 第二层机制实证：H=2.1/vz=300 全程（200 tick）逐 tick 打 onGround/vel/pos。
 *  目的：证明滑行段减速 = nopre 地面速度钳制(300→250) + apply_friction(×0.9375@64Hz / ×0.9722@144Hz)，
 *  而非碰撞 clip（无 fraction<1 的真实命中；门否决端盖进入但不动速度）。
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

const flatTop = brush(
  [P([0, 1, 0], 0), P([0, -1, 0], 2000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, 1], 0), P([0, 0, -1], 4000)],
  [-X, -2000, -4000], [X, 0, 0],
);
const ramp = brush(
  [P([0, COS, SIN], 0), P([0, -1, 0], 3000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, -1], 0), P([0, 0, 1], 1500)],
  [-X, -3000, 0], [X, 0, 1500],
);
const geo = [flatTop, ramp];

function run(dt, nSteps) {
  const w = new PhysWorld();
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
    rows.push({ i: i + 1, t: (i + 1) * dt, onGround: st.onGround, v: [st.velX, st.velY, st.velZ], p: [st.posX, st.posY, st.posZ], dv: dv - g, coll: collide });
  }
  return { w, st, rows };
}

for (const [dt, nSteps, label] of [[1 / 64, 200, '64Hz'], [1 / 144, 450, '144Hz']]) {
  const { w, st, rows } = run(dt, nSteps);
  console.log(`\n===== ${label} (dt=${dt})  gate_veto_count=${w.gate_veto_count()}  最终 v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(1)},${st.posY.toFixed(1)},${st.posZ.toFixed(1)})`);
  console.log(`  tick   t       ground   velX velY   velZ    posX posY   posZ    |dv|-g`);
  let lastGround = null;
  for (const r of rows) {
    const isTrans = r.onGround !== lastGround;
    const showAll = r.i <= 12 || r.coll || isTrans || r.i % 25 === 0 || r.i === rows.length;
    if (showAll || isTrans) {
      console.log(`  ${String(r.i).padStart(4)} ${r.t.toFixed(4)} ${r.onGround ? ' G' : ' A'}  ${r.v[0].toFixed(1).padStart(6)} ${r.v[1].toFixed(1).padStart(5)} ${r.v[2].toFixed(1).padStart(7)}  ${r.p[0].toFixed(0).padStart(5)} ${r.p[1].toFixed(3).padStart(7)} ${r.p[2].toFixed(2).padStart(8)}  ${r.dv.toFixed(3)}${r.coll ? '  <-- 非重力速度变化(碰撞?)' : ''}`);
    }
    lastGround = r.onGround;
  }
  const gravTicks = rows.filter(r => r.coll).length;
  console.log(`  非纯重力速度变化 tick 数（碰撞候选）: ${gravTicks}`);
}