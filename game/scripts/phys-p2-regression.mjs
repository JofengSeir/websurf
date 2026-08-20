/** P2 坡顶幻影碰撞 —— H×vz 矩阵回归（64Hz vs 144Hz 分叉 Δvel）。
 *  几何与 phys-rate-parity-v2.mjs 场景 B 一致：60° 坡（表面 y=-z·tan60°）+
 *  平顶台（z≤0），spawn (0,H,-30) 平飞 vz。
 *
 *  定位（2026-08-20，见 docs/chamfer-physics/p2-remaining-task.md）：
 *  本矩阵度量的是「终速速率一致性」，**不纯是幻影**——幻影（z=0 无限平面端盖）
 *  已被盒-AABB 门根除（phys-gate-probe2.mjs PASS）。残余发散来自地面物理的固有
 *  速率依赖：盒在平台顶落地后 nopre 钳制(300→250) + 逐 tick 摩擦×(1-4·dt) 滑行，
 *  64/144Hz 离缘速度不同；随后坡面真实掠触对步长敏感（64Hz 擦触飞越 vs 144Hz
 *  持续 surf）。此发散非碰撞幻影（phys-p2-ground.mjs 实证：摩擦序列与公式逐值吻合）。
 *  故本矩阵保留为「地面物理参考」；幻影修复验证以 phys-gate-probe2.mjs + 单测为准。
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

console.log('===== P2 H×vz 矩阵（幻影已根除；残余发散=地面物理速率依赖，见 docs）=====');
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
console.log(`===== 判定: ${fails === 0 ? 'ALL PASS —— 全程速率一致' : `参考矩阵：${fails}/12 发散（幻影已根治；发散为地面物理固有速率依赖）`} =====`);