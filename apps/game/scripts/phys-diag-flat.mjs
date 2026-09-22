/**
 * 台面吸附扫描：六档出生高度各建一个世界，跑 2 个 1/64 步，看首个 tick 是否已被判到地面。
 *
 * 目的：把「出生高度」与「`categorize_position` 的下探吸附」分开 ——
 * 台 brush 的顶面在 `y = 0`，玩家 origin 即脚底（`src/phys/player.rs` 的 `apply_hull` 把
 * `stand_mins[1]` 置 0），落地判定从 origin 向下扫 `GROUND_TRACE_DIST`（2.0 HU）：出生高度落在
 * 这个距离内的一档，首个 tick 就被吸附到距顶面 `DIST_EPSILON`（`src/phys/world.rs`）处并置
 * `onGround`；更高的档位走 `air_move`，每 tick 竖直速度增量为 `gravity × dt`
 * （`air_move` 在位移前后各施一半重力）。
 *
 * 末段另建一个空世界（无 brush、`build_world('[]', ...)`）做同高度的纯落体参照：两次 tick 的
 * `posY` 与 `velY` 与上面 y=100 那一档应当一致。
 *
 * 台 brush 的六个平面与 AABB 与 `apps/game/scripts/phys-rate-parity.mjs` 的
 * `flatTop(0, 0, 2000)` 逐字段相同。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-diag-flat.mjs`。
 * 无产物落盘；退出码恒为 0，判据是 stdout。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
// 平顶台：顶面 y = 0、z <= 0；与 phys-rate-parity.mjs 的 flatTop(0, 0, 2000) 同参数
const brush = {
  planes: [
    P([0, 1, 0], 0), P([0, -1, 0], 2000),
    P([1, 0, 0], X), P([-1, 0, 0], X),
    P([0, 0, 1], 0), P([0, 0, -1], 4000),
  ],
  min: [-X, -2000, -4000], max: [X, 0, 0],
  is_ladder: false, is_solid: true,
};

// 六档出生高度：每档两步，只打印 posY / velY / onGround
for (const y of [0.005, 0.05, 0.3, 2, 20, 100]) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify([brush]), '[]', '{"teleports":[],"triggers":[]}', 0, y, -3, 0);
  let st = w.tick(1 / 64, 0, 0, 0);   // 首步：位移用半重力后的速度（gravity·dt/2）× dt，步末再补另一半重力
  const s2 = w.tick(1 / 64, 0, 0, 0);
  console.log(`spawn y=${y}: t1 pos=${st.posY.toFixed(4)} vel=${st.velY.toFixed(3)} ground=${st.onGround} | t2 pos=${s2.posY.toFixed(4)} vel=${s2.velY.toFixed(3)} ground=${s2.onGround}`);
}

// 纯落体参照（无任何 brush）：同一出生高度的两 tick 读数，与上面 y=100 档对照
{
  const w = new PhysWorld();
  w.build_world('[]', '[]', '{"teleports":[],"triggers":[]}', 0, 100, -3, 0);
  const a = w.tick(1 / 64, 0, 0, 0);
  const b = w.tick(1 / 64, 0, 0, 0);
  console.log(`无brush y=100: t1 pos=${a.posY.toFixed(4)} vel=${a.velY.toFixed(3)} | t2 pos=${b.posY.toFixed(4)} vel=${b.velY.toFixed(3)}（期望 t1: y≈99.95 v=-6.25; t2: y≈99.76 v=-18.75）`);
}
