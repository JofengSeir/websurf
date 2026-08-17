/** 诊断：探测实验③台 brush 的实际碰撞面位置（单步 tick + 纯落体扫描）。 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
// 与 phys-rate-parity.mjs flatTop(0, 0, 2000) 完全一致
const brush = {
  planes: [
    P([0, 1, 0], 0), P([0, -1, 0], 2000),
    P([1, 0, 0], X), P([-1, 0, 0], X),
    P([0, 0, 1], 0), P([0, 0, -1], 4000),
  ],
  min: [-X, -2000, -4000], max: [X, 0, 0],
  is_ladder: false, is_solid: true,
};

for (const y of [0.005, 0.05, 0.3, 2, 20, 100]) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify([brush]), '[]', '{"teleports":[],"triggers":[]}', 0, y, -3, 0);
  let st = w.tick(1 / 64, 0, 0, 0);   // 单步：预期纯落体 Δy=-6.25*1/64*2? 半重力中点: 位移≈v中*dt
  const s2 = w.tick(1 / 64, 0, 0, 0);
  console.log(`spawn y=${y}: t1 pos=${st.posY.toFixed(4)} vel=${st.velY.toFixed(3)} ground=${st.onGround} | t2 pos=${s2.posY.toFixed(4)} vel=${s2.velY.toFixed(3)} ground=${s2.onGround}`);
}

// 纯落体参考（无任何 brush）：确认期望位移/速度
{
  const w = new PhysWorld();
  w.build_world('[]', '[]', '{"teleports":[],"triggers":[]}', 0, 100, -3, 0);
  const a = w.tick(1 / 64, 0, 0, 0);
  const b = w.tick(1 / 64, 0, 0, 0);
  console.log(`无brush y=100: t1 pos=${a.posY.toFixed(4)} vel=${a.velY.toFixed(3)} | t2 pos=${b.posY.toFixed(4)} vel=${b.velY.toFixed(3)}（期望 t1: y≈99.95 v=-6.25; t2: y≈99.76 v=-18.75）`);
}
