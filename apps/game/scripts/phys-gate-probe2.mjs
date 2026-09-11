/** wasm 门校验行为探针：仅 ramp brush（无平台），64Hz 与 144Hz 双速率。
 *  若门生效：盒越过坡顶（不拦）；若门失效：z=-15.94 处被端盖清零。
 *  144Hz 线验证门在高步率同样生效（原 P2 基线 144Hz 亦被钉住/异常减速）。*/
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
const TH = Math.PI / 3, COS = Math.cos(TH), SIN = Math.sin(TH);

const ramp = brush(
  [P([0, COS, SIN], 0), P([0, -1, 0], 3000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, -1], 0), P([0, 0, 1], 1500)],
  [-X, -3000, 0], [X, 0, 1500],
);

for (const [label, dt, nSteps] of [['64Hz', 1 / 64, 64], ['144Hz', 1 / 144, 144]]) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify([ramp]), '[]', '{"teleports":[],"triggers":[]}', 0, 2.5, -30, 0);
  w.set_velocity(0, 0, 300);
  let st = null, prev = null;
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    if (i <= 3) {
      console.log(`${label} tick${i + 1}: v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`);
    }
  }
  console.log(`${label} final: v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`);
  console.log(`${label} gate_veto_count = ${w.gate_veto_count()}`);
  const tr = w.debug_trace(0, 2.109375, -20.625, 0, 1.62109375, -15.9375);
  console.log(`${label} raw trace(blocking tick): fraction=${tr[0].toFixed(6)} normal=(${tr[1].toFixed(3)},${tr[2].toFixed(3)},${tr[3].toFixed(3)})`);
  console.log(`${label} ${st.velZ < 1 ? 'STOPPED —— 门校验未生效' : 'PASS —— 门校验生效'}`);
}