/**
 * 贴地滑行段逐 tick 探针：把「盒落在平顶台上、贴着台面平飞」的减速度摊到每一步上看。
 *
 * 场景：`flatTop` 平顶台（顶面 `y = 0`、`z <= 0`）+ 60° 坡（坡面外法线 `(0, cos60, sin60)`），
 * 出生点 `(0, 2.1, -30)`、yaw 0，`set_velocity(0, 0, 300)` 沿 +z 平飞，连跑 10 个 1/64 步，
 * 全程不按键。
 *
 * 每行打印：步序、累计时间、速度三分量、位置三分量，以及与上一 tick 的三维速度差 `|dv|`。
 * 地面步进不带竖直重力（`src/phys/player.rs` 的 `walk_move`），所以 `|dv|` 只来自摩擦
 * （`apply_friction`）或碰撞剪裁；与 `apply_friction` 的每步扣除量对得上即说明是前者。
 *
 * 末行打印 `gate_veto_count()`：盒-AABB 门校验否决假进入平面的累计次数，
 * 计数器是 `src/phys/world.rs` 的 `GATE_VETO_COUNT`（同一 wasm 模块内所有实例共用一份，
 * 只增不减、无复位入口）。
 *
 * 「P2」指坡形 brush 幽灵面（无限平面造成的假进入）这一组排查，回归落在
 * `src/phys/p2_gate_tests.rs`。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-p2-trace.mjs`。
 * 无产物落盘；退出码恒为 0，判据是 stdout。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

// 几何基元：平面 = { normal, dist }，brush = { planes, min, max, is_ladder, is_solid }，
// 与 `src/phys/mod.rs` 的 `PhysBrush` / `PhysPlane` 字段一一对应（Y-up、法线朝外）
const TICK = 1 / 64, X = 4000;
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

const w = new PhysWorld();
// 空 tri、空传送；出生点 (0, 2.1, -30)、yaw 0，随后给 vz = 300 HU/s
w.build_world(JSON.stringify([flatTop, ramp]), '[]', '{"teleports":[],"triggers":[]}', 0, 2.1, -30, 0);
w.set_velocity(0, 0, 300);
let st = null, prev = null;
for (let i = 0; i < 10; i++) {
  prev = st;
  st = w.tick(TICK, 0, 0, 0);
  // |dv| = 与上一 tick 的三维速度差；首步没有前值，记 0
  const dv = prev ? Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ) : 0;
  console.log(`t${(i + 1).toString().padStart(2)} t=${((i + 1) * TICK).toFixed(4)} v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)}) |dv|=${dv.toFixed(1)}`);
}
// 门校验否决计数：同一 wasm 模块内所有实例共用一份
console.log(`gate_veto_count = ${w.gate_veto_count()}`);