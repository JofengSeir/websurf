/** P2 坡顶幻影碰撞 —— 修复后 H×vz 矩阵回归（64Hz vs 144Hz 分叉 Δvel）。
 *  几何与 phys-rate-parity-v2.mjs 场景 B 一致：60° 坡（表面 y=-z·tan60°）+
 *  平顶台（z≤0），spawn (0,H,-30) 平飞 vz。判定：Δvel<10 收敛（phys-fix-directions.md P2）。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64, FINE = 1 / 144, X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
const TH = Math.PI / 3, COS = Math.cos(TH), SIN = Math.sin(TH);

function flatTop(topY, zEdge, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], zEdge), P([0, 0, -1], 4000)],
    [-X, -yBot, zEdge - 4000], [X, topY, zEdge],
  );
}
function rampDown(topY, zEnd, yBot) {
  return brush(
    [P([0, COS, SIN], topY * COS), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, -1], 0), P([0, 0, 1], zEnd)],
    [-X, topY - yBot, 0], [X, topY, zEnd],
  );
}

function run(geo, spawn, vel, dt, nSteps) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(geo), '[]', '{"teleports":[],"triggers":[]}', ...spawn, 0);
  w.set_velocity(...vel);
  let st = null, prev = null, firstHit = '';
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    if (prev && !firstHit) {
      const dv = Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ);
      if (Math.abs(dv - 800 * dt) > 3) {
        firstHit = `t=${(i * dt).toFixed(4)} |dv|=${dv.toFixed(1)} v=(${st.velX.toFixed(0)},${st.velY.toFixed(0)},${st.velZ.toFixed(0)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`;
      }
    }
  }
  return { st, firstHit };
}

console.log('===== P2 坡顶幻影：修复后 H×vz 矩阵（Δvel<10 通过）=====');
const geo = [flatTop(0, 0, 2000), rampDown(0, 1500, 3000)];
let fails = 0;
for (const H of [2.1, 2.5, 3, 4]) {
  for (const vz of [300, 500, 800]) {
    const a = run(geo, [0, H, -30], [0, 0, vz], TICK, 200);
    const b = run(geo, [0, H, -30], [0, 0, vz], FINE, 450);
    const dv = Math.hypot(a.st.velX - b.st.velX, a.st.velY - b.st.velY, a.st.velZ - b.st.velZ);
    const ok = dv < 10;
    if (!ok) fails++;
    console.log(`  H=${H} vz=${vz}: Δvel=${dv.toFixed(1)} ${ok ? 'CONVERGED' : '★ DIVERGED'}`);
    if (dv > 10) {
      if (a.firstHit) console.log(`    64Hz  ${a.firstHit}`);
      if (b.firstHit) console.log(`    144Hz ${b.firstHit}`);
    }
  }
}
console.log(`===== 判定: ${fails === 0 ? 'ALL PASS —— 盒-AABB 必要校验修复 P2' : `FAIL (${fails}/12 发散)`} =====`);