/**
 * 双管道垂直落体对比：node 直跑 wasm 产物，不经浏览器。
 *
 * 场景：同一份地板 brush 建两个 `src/phys/mod.rs` 的 `PhysWorld` 实例 ——
 * `auth` 按 TICK(1/64 s) 调 `tick`，`pred` 按 PRED(1/144 s) 调 `predict`；
 * 每个渲染帧开头先消费上一轮记录的权威快照，再按 `mode` 决定是否用它改写速度。
 *
 * 五档模式（`process.argv[2]` 未命中 a-e 时五档全跑）：
 *   a 基线：两实例各跑各的，不做任何反推；
 *   b 全量双向：`(预测 posY − 权威 pos) / dt` 经 ±CLAMP 钳制后同时写
 *     `auth.set_velocity` 与 `pred.set_velocity`；
 *   c 增量仅权威：位置偏差 `ex` 落在 [5, 200] 时只写权威速度 `a.velY + ex × CONV`；
 *     `|ex| > 200` 时改走 `pred.set_state` 把预测覆盖到权威位置；
 *   d 逐帧速度校准：权威侧只 `tick`（到达分支空转），预测每渲染帧先
 *     `set_velocity(最近权威 velY)` 再 `predict`；
 *   e 外推校准：权威侧同样只 `tick`，预测每帧写
 *     `velY + accelY × (当前时刻 − 权威帧时刻)`，`accelY` 的单位是 HU/s 每毫秒。
 *
 * 输出（无断言、无退出码判定）：`analyze` 打印 t ≥ 0.5 s 与 t ≥ 1.0 s 的预测位置/速度误差
 * （对照 `theoryY` / `theoryVy`）、预测竖直速度的逐帧跳变均值与最大值，以及两实例在
 * t ≥ 1.0 s 处的位置差。理论落地时刻 = √(2 × Y0 / G) ≈ 1.118 s，两个取样点都在落地前。
 *
 * 用法：node scripts/phys-dual-pipe.mjs [mode]
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

// 地板世界：六个平面围出 y ∈ [0, 0.01] 的薄板（与 `apps/game/scripts/phys-smoke.mjs`
// 的 brush 同参，只有出生高度不同）；出生点 (0, Y0, 0) 在上方自由落体。
const brushJson = JSON.stringify([
  {
    planes: [
      { normal: [0, -1, 0], dist: 0 },
      { normal: [0, 1, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 1000 },
      { normal: [-1, 0, 0], dist: 1000 },
      { normal: [0, 0, 1], dist: 1000 },
      { normal: [0, 0, -1], dist: 1000 },
    ],
    min: [-1000, 0, -1000], max: [1000, 0.01, 1000],
    is_ladder: false, is_solid: true,
  },
]);
const world = '{"teleports":[],"triggers":[]}';

const TICK = 1 / 64;      // 权威实例步长（s）
const PRED = 1 / 144;     // 预测实例步长（s，模拟一帧渲染）
const G = 800;            // 重力（HU/s²）：`src/phys/player.rs` 的 `GRAVITY`，theoryY/theoryVy 用它
const DURATION_S = 1.5;   // 模拟时长上限（s）；权威落地即 break
const Y0 = 500;           // 出生高度（HU）：自由落体起点

function makeWorld() {
  const w = new PhysWorld();
  w.build_world(brushJson, '[]', world, 0, Y0, 0, 0);
  return w;
}

/** 无碰撞理论值：y = Y0 − ½·G·t²，vy = −G·t。 */
const theoryY = (t) => Y0 - 0.5 * G * t * t;
const theoryVy = (t) => -G * t;

/** 跑一档模式，返回 { predSamples, authSamples, predVelJumps }。 */
function simulate(mode) {
  const auth = makeWorld();
  const pred = makeWorld();
  let authSnap = null; // 最近一次权威帧快照 { pos, velY, accelY, timeMs }
  let lastAuthVy = null; // 上一权威帧的 velY（算 accelY 用）
  let lastVa = -1;
  let va = 0;
  const authTimes = []; // 权威帧产生时刻（记录后当前无读取点）
  let t = 0;
  let nextAuthT = 0; // 下一个权威 tick 的时刻（s）
  let authTickCount = 0;
  const predSamples = [];
  const authSamples = [];
  const predVelJumps = []; // 预测竖直速度的逐帧差绝对值（锯齿度量）
  let lastPredVy = null;

  const K = 0.3; const CONV = 1 / 0.25; // K 当前无读取点；CONV = 4：把位置偏差按 0.25 s 收敛折算成速度修正
  const CLAMP = 4000; // 速度修正量的绝对值上限（HU/s），b / c 两档用

  while (t < DURATION_S) {
    // ── 渲染帧开头：消费上一轮记录的权威帧（计时序号 va 变化即视为有新帧）──
    if (authSnap && va !== lastVa) {
      lastVa = va;
      const a = authSnap;
      if (mode !== 'a') {
        const st = pred.state();                 // 当前预测状态（改写速度之前读出）
        const dt = (t * 1000 - a.timeMs) / 1000; // 权威帧时刻到现在的秒数
        if (dt >= 0.0005) { // 同一毫秒内的重复处理直接跳过
          if (mode === 'b') {
            // b：用 Δpos/Δt 当速度，钳制后同时写权威与预测
            const vd = (st.posY - a.pos) / dt;
            const vc = Math.max(-CLAMP, Math.min(CLAMP, vd));
            auth.set_velocity(0, vc, 0);
            pred.set_velocity(0, vc, 0);
          } else if (mode === 'c') {
            // c：位置偏差 ex 落在 [5, 200] 时只修权威速度（a.velY + ex × CONV）；
            // 修正量同样经 ±CLAMP 钳制，预测实例不动
            const ex = st.posY - (a.pos + a.velY * dt); // 位置偏差（HU）
            if (Math.abs(ex) >= 5 && Math.abs(ex) <= 200) {
              const vc = Math.max(-CLAMP, Math.min(CLAMP, a.velY + ex * CONV)); // 钳制后的权威速度
              auth.set_velocity(0, vc, 0);
            } else if (Math.abs(ex) > 200) {
              // 兜底：|ex| > 200 时把预测整帧覆盖到权威位置（pred.set_state）
              pred.set_state(0, a.pos, 0, 0, 0, 0, a.velY, 0, true);
            }
          } else if (mode === 'd') {
            // d：权威到达分支不写任何实例 —— 权威速度只由 tick 与输入决定；
            // 校准动作在下方预测管道逐帧做（用 pred.set_velocity 写最近权威速度）。
            // 本分支只留占位语句，不参与任何状态写入。
            void 0;
          } else if (mode === 'e') {
            // e：权威到达分支同样不写任何实例；accelY 已随 authSnap 记录，
            // 供下方预测管道逐帧外推使用（权威速度取物理模拟的瞬时速度）。
            // 外推式：vel_target = vel_A + a × (t_now − t_A)，
            // 其中 a = 相邻权威帧速度差 ÷ tick 的毫秒数（单位 HU/s 每毫秒），
            // 乘上式里的毫秒时差即得速度增量。
            void 0;
          }
        }
      }
    }

    // ── 权威实例（1/64 s）：推进一个 TICK 并记录快照（timeMs = tick 结束时刻）──
    if (t >= nextAuthT - 1e-9) {
      nextAuthT += TICK;
      authTickCount++;
      const sa = auth.tick(TICK, 0, 0, 0);
      // accelY = 相邻权威帧速度差 ÷ (TICK × 1000)：单位 HU/s 每毫秒；首帧无前值记 0
      const accelY = lastAuthVy === null ? 0 : (sa.velY - lastAuthVy) / (TICK * 1000); // 每毫秒的速度增量
      lastAuthVy = sa.velY;
      // timeMs 记 tick 结束时刻 t + TICK：tick(TICK) 返回的是推进 TICK 之后的状态；
      // 记开始时刻会让后面的外推多算一个 TICK 的滞后。
      authSnap = { pos: sa.posY, velY: sa.velY, accelY, timeMs: (t + TICK) * 1000 };
      va++;
      authTimes.push(t * 1000);
      if (sa.onGround) break; // 落地即结束模拟（此后不再采样）
      authSamples.push({ t, y: sa.posY, vy: sa.velY, ground: sa.onGround });
    }

    // ── 预测实例（1/144 s）：d / e 先按权威快照校准速度，再 predict 一步并采样 ──
    if (authSnap) {
      if (mode === 'd') {
        // d：逐帧用最近权威速度替换预测速度（位置不动）
        pred.set_velocity(0, authSnap.velY, 0);
      } else if (mode === 'e') {
        // e：外推校准 —— 预测速度 = 权威 velY + accelY × dtMs；
        // dtMs 是权威帧到当前的毫秒数，与 accelY 的单位相配。
        const dtMs = t * 1000 - authSnap.timeMs;
        pred.set_velocity(0, authSnap.velY + authSnap.accelY * dtMs, 0);
      }
    }
    const sp = pred.predict(PRED, 0, 0, 0); // 一次 predict = 一个子步（`src/phys/mod.rs` 的 `predict`）
    predSamples.push({ t, y: sp.posY, vy: sp.velY });
    if (lastPredVy !== null) {
      predVelJumps.push(Math.abs(sp.velY - lastPredVy));
    }
    lastPredVy = sp.velY;

    t += PRED;
  }
  return { predSamples, authSamples, predVelJumps };
}

/** 打印 t ≥ 0.5 s / 1.0 s 的误差、逐帧跳变统计与两实例位置差，并返回四项读数。 */
function analyze(name, { predSamples, authSamples, predVelJumps }) {
  // 取样点：t ≥ 0.5 s 与 t ≥ 1.0 s 的首个预测样本（落地约 1.118 s，两者都在落地前）
  const at = (tt) => predSamples.find((s) => s.t >= tt) || predSamples[predSamples.length - 1]; // 无命中则取末样本
  const p05 = at(0.5), p10 = at(1.0);
  const yErr05 = p05.y - theoryY(0.5);
  const yErr10 = p10.y - theoryY(1.0);
  // 预测竖直速度相对 theoryVy 的偏差
  const vyErr05 = p05.vy - theoryVy(0.5);
  const vyErr10 = p10.vy - theoryVy(1.0);
  // 逐帧跳变统计取第 20 个样本之后（跳过起步段）
  const jumps = predVelJumps.slice(20);
  const avgJump = jumps.reduce((s, v) => s + v, 0) / (jumps.length || 1);
  const maxJump = Math.max(...jumps, 0);
  // t ≥ 1.0 s 处权威与预测的位置差（两管道一致性）
  const authAt = (tt) => (authSamples.find((s) => s.t >= tt) || authSamples[authSamples.length - 1]);
  const a10 = authAt(1.0);
  const pipeDiff = Math.abs(a10.y - p10.y);

  console.log(`[${name}]`);
  console.log(`  预测 y@0.5s=${p05.y.toFixed(2)} 误差=${yErr05.toFixed(2)}  | y@1.0s=${p10.y.toFixed(2)} 误差=${yErr10.toFixed(2)}`);
  console.log(`  预测 vy@0.5s=${p05.vy.toFixed(2)} 误差=${vyErr05.toFixed(2)} | vy@1.0s=${p10.vy.toFixed(2)} 误差=${vyErr10.toFixed(2)}`);
  console.log(`  预测速度锯齿: 均值=${avgJump.toFixed(3)}/帧 最大=${maxJump.toFixed(3)}/帧 (理论 ~${(G * PRED).toFixed(3)}/帧)`);
  console.log(`  权威-预测位置差@1.0s=${pipeDiff.toFixed(2)}`);
  return { yErr10, vyErr10, avgJump, pipeDiff };
}

const mode = process.argv[2]; // 未命中 a-e（含缺省）时五档全跑
if (mode && ['a', 'b', 'c', 'd', 'e'].includes(mode)) {
  const r = simulate(mode);
  analyze(`mode=${mode}`, r);
} else {
  for (const m of ['a', 'b', 'c', 'd', 'e']) {
    const r = simulate(m);
    analyze(`mode=${m}`, r);
    console.log('');
  }
}
