/** P2 修复后 H=2.1/vz=300 逐 tick 探针：定位 y=0.03 停驻机制。 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64, X = 4000;
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

const w = new PhysWorld();
w.build_world(JSON.stringify([flatTop, ramp]), '[]', '{"teleports":[],"triggers":[]}', 0, 2.1, -30, 0);
w.set_velocity(0, 0, 300);
let st = null, prev = null;
for (let i = 0; i < 10; i++) {
  prev = st;
  st = w.tick(TICK, 0, 0, 0);
  const dv = prev ? Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ) : 0;
  console.log(`t${(i + 1).toString().padStart(2)} t=${((i + 1) * TICK).toFixed(4)} v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)}) |dv|=${dv.toFixed(1)}`);
}
console.log(`gate_veto_count = ${w.gate_veto_count()}`);