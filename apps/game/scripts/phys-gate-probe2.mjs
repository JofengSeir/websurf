/**
 * 坡形 brush 幽灵面探针：只放 60° 坡（无平顶台），让盒从 `z = -30` 以 `vz = 300` 平飞，
 * 在 64 Hz 与 144 Hz 两条步长线上各跑 1 秒，看盒是被坡在 `z = 0` 的端盖平面拦停、还是越过去。
 *
 * 场景要点：
 * - 坡 brush 的六面见下方 `ramp`：坡面外法线 `(0, cos60, sin60)`、底 `y >= -3000`、两侧 x 墙、
 *   `z = 0` 端盖（法线 `[0, 0, -1]`、`dist = 0`）与 `z = 1500` 闭合面；实体在坡面下方。
 * - 出生点 `(0, 2.5, -30)`、yaw 0、速度 `(0, 0, 300)`；盒半宽 16 HU、站立箱高 72 HU
 *   （`src/phys/player.rs` 的 `apply_hull` 写 `stand_mins` / `stand_maxs`），故盒前沿贴到端盖
 *   平面时 `origin.z` 在 `-15.94` 附近 —— 该处并没有实体面，端盖只是无限平面求交的产物。
 * - 「门」指 `src/phys/world.rs` 的 `clip_planes` 里的必要校验：在真实接触分数处，若盒 AABB
 *   与该实体 AABB 三轴分离，就只跳过该平面的进入判定（逐平面否决，不做整实体否决），并自增
 *   `world::GATE_VETO_COUNT`。AABB 分离的两凸形必不相交，故该判据可用来剔除假进入。
 *
 * 两条线各自打印：前 4 个 tick 与终态的速度/位置、`gate_veto_count()`、`debug_trace` 的
 * `fraction` 与法线，最后按终速给出 `PASS` / `STOPPED` 一行。`debug_trace` 的线段
 * `(0, 2.109375, -20.625) → (0, 1.62109375, -15.9375)` 就是 64 Hz 线第三个 tick 的位移，
 * 与 `src/phys/p2_gate_tests.rs` 的 `p2_endcap_phantom_vetoed` 用同一组参数；扫掠盒取玩家
 * 当前碰撞箱，本脚本全程不按 duck 位，即站立箱。
 *
 * `gate_veto_count()` 读的是 `world::GATE_VETO_COUNT`：原子计数、只增不减、无复位入口，
 * 同一 wasm 模块内所有实例共用一份，故第二条步长线打印的是累计值。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-gate-probe2.mjs`。
 * 无产物落盘；退出码恒为 0，判据是 stdout 的 `PASS` / `STOPPED` 行。
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

// 60° 坡：坡面 y = -z·tan60°，z ∈ [0, 1500]；z = 0 的面即被求交当成"实体面"的端盖
const ramp = brush(
  [P([0, COS, SIN], 0), P([0, -1, 0], 3000), P([1, 0, 0], X), P([-1, 0, 0], X),
   P([0, 0, -1], 0), P([0, 0, 1], 1500)],
  [-X, -3000, 0], [X, 0, 1500],
);

// 两条步长线：64 Hz 跑 64 步、144 Hz 跑 144 步，各 1 秒
for (const [label, dt, nSteps] of [['64Hz', 1 / 64, 64], ['144Hz', 1 / 144, 144]]) {
  const w = new PhysWorld();
  // 空 tri、空传送；出生点 (0, 2.5, -30)、yaw 0，随后给 vz = 300 HU/s
  w.build_world(JSON.stringify([ramp]), '[]', '{"teleports":[],"triggers":[]}', 0, 2.5, -30, 0);
  w.set_velocity(0, 0, 300);
  let st = null, prev = null;
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    // 只打前 4 步：端盖平面恰在这几步内被求交到
    if (i <= 3) {
      console.log(`${label} tick${i + 1}: v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`);
    }
  }
  console.log(`${label} final: v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`);
  console.log(`${label} gate_veto_count = ${w.gate_veto_count()}`);
  // 对当事线段直接做一次扫掠：不推进物理、不改状态；未命中时法线回填 (0,0,0)
  const tr = w.debug_trace(0, 2.109375, -20.625, 0, 1.62109375, -15.9375);
  console.log(`${label} raw trace(blocking tick): fraction=${tr[0].toFixed(6)} normal=(${tr[1].toFixed(3)},${tr[2].toFixed(3)},${tr[3].toFixed(3)})`);
  // 判据：门生效时盒越过端盖继续飞（vz 保持 300），被拦停则 vz 归零
  console.log(`${label} ${st.velZ < 1 ? 'STOPPED —— 门校验未生效' : 'PASS —— 门校验生效'}`);
}