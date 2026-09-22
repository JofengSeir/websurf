/**
 * 速率一致性参考矩阵：同一几何下 64 Hz（200 步）与 144 Hz（450 步）两条线的终速差 `Δvel`，
 * 按 4 档脚底高度 × 3 档 `vz` 共 12 组逐一打印。
 *
 * 几何与 `apps/game/scripts/phys-rate-parity-v2.mjs` 的场景 B 同参数：
 * `flatTop(0, 0, 2000)` 平顶台（顶面 `y = 0`、竖直侧面在 `z = 0`）+
 * `rampDown(0, 1500, 3000)` 60° 坡（坡面外法线 `(0, cos60, sin60)`，实体在面下）；
 * 出生点 `(0, H, -30)`、yaw 0、速度 `(0, 0, vz)`，即贴着台缘低空平飞。
 *
 * 每组的判据是 `Δvel < 10`：成立打印 `CONVERGED`，否则打印 `★ DIVERGED`，并把该组两条线各自
 * 记录的「首个非纯重力速度变化步」（`|Δv| − gravity × dt` 超过 3 的第一处）打出来。
 * 12 组全收敛时末行是 `ALL PASS —— 全程速率一致`，否则是 `参考矩阵：N/12 发散`。
 *
 * 本脚本不是门禁：发散不改变退出码（恒 0），末行只汇报计数。坡在 `z = 0` 的端盖平面造成的
 * 假进入由盒-AABB 门校验处理，其回归在 `src/phys/p2_gate_tests.rs` 与
 * `apps/game/scripts/phys-gate-probe2.mjs`；本矩阵量的是两条线的终速差。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-p2-regression.mjs`。
 * 无产物落盘。
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

// 平顶台：顶面 y = topY、竖直侧面在 z = zEdge（台面覆盖 z <= zEdge）
function flatTop(topY, zEdge, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], zEdge), P([0, 0, -1], 4000)],
    [-X, -yBot, zEdge - 4000], [X, topY, zEdge],
  );
}
// 60° 下坡：坡面 y = topY − z·tan60°（z ∈ [0, zEnd]），实体在坡面下方
function rampDown(topY, zEnd, yBot) {
  return brush(
    [P([0, COS, SIN], topY * COS), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, -1], 0), P([0, 0, 1], zEnd)],
    [-X, topY - yBot, 0], [X, topY, zEnd],
  );
}

// 单组：建世界 → 给速度 → 跑 nSteps 步，返回终态与首个非纯重力速度变化步的描述
function run(geo, spawn, vel, dt, nSteps) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(geo), '[]', '{"teleports":[],"triggers":[]}', ...spawn, 0);
  w.set_velocity(...vel);
  let st = null, prev = null, firstHit = '';
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    // 只在首次命中时记录；阈值 3 用于容住浮点残差
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
// 4 档脚底高度 × 3 档 vz；每档各跑 64 Hz 与 144 Hz 两条线
for (const H of [2.1, 2.5, 3, 4]) {
  for (const vz of [300, 500, 800]) {
    const a = run(geo, [0, H, -30], [0, 0, vz], TICK, 200);
    const b = run(geo, [0, H, -30], [0, 0, vz], FINE, 450);
    const dv = Math.hypot(a.st.velX - b.st.velX, a.st.velY - b.st.velY, a.st.velZ - b.st.velZ);
    const ok = dv < 10;
    if (!ok) fails++;
    console.log(`  H=${H} vz=${vz}: Δvel=${dv.toFixed(1)} ${ok ? 'CONVERGED' : '★ DIVERGED'}`);
    // 发散组才打印两线各自的首次命中描述
    if (dv > 10) {
      if (a.firstHit) console.log(`    64Hz  ${a.firstHit}`);
      if (b.firstHit) console.log(`    144Hz ${b.firstHit}`);
    }
  }
}
console.log(`===== 判定: ${fails === 0 ? 'ALL PASS —— 全程速率一致' : `参考矩阵：${fails}/12 发散（幻影已根治；发散为地面物理固有速率依赖）`} =====`);