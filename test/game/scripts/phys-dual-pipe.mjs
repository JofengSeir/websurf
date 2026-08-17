/**
 * 双管道垂直落体测试（node 直接跑 WASM）。
 *
 * 模拟：权威（64Hz tick）+ 预测（144Hz predict）+ 权威帧到达时的反推逻辑。
 * 对比三种模式，验证"反推速度喂权威、预测渲染不被影响"的垂直落体行为：
 *   mode=a 基线：双管道独立，无任何反推（理论参考）
 *   mode=b 全量双向：vel_derived = Δpos/Δt 写权威 + 同步 set_velocity 预测（v4.2，曾导致走不动）
 *   mode=c 增量仅权威：err 门控 + V_fix = V_A2 + err/Δt×k，预测纯净（v4.3）
 *   mode=d 速度校准（v4.5 定案）：权威保持纯净（只吃输入，绝不外部写速度）；
 *       预测每帧 set_velocity(最近权威速度) 后 predict —— 逐帧速度校准。
 *       权威速度 = 物理模拟的瞬时速度（非平均速度）→ 无衰减；A→B 单向无反馈 → 无振荡
 *
 * 判定：位置接近理论 y=500-0.5·800·t²；速度无衰减/爆炸；渲染（预测）速度平滑。
 * 用法：node scripts/phys-dual-pipe.mjs <mode>（默认跑全部四模式）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

// 地板世界（与 phys-smoke 相同；玩家从 y=500 自由落体）
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

const TICK = 1 / 64;      // 权威步长
const PRED = 1 / 144;     // 预测步长（渲染帧）
const G = 800;
const DURATION_S = 1.5;   // 模拟时长（落地前）
const Y0 = 500;

function makeWorld() {
  const w = new PhysWorld();
  w.build_world(brushJson, '[]', world, 0, Y0, 0, 0);
  return w;
}

/** 理论值 */
const theoryY = (t) => Y0 - 0.5 * G * t * t;
const theoryVy = (t) => -G * t;

/** 模拟一次模式；返回 { predSamples, authSamples, predVelJumps } */
function simulate(mode) {
  const auth = makeWorld();
  const pred = makeWorld();
  let authSnap = null; // 最近权威帧 {pos, vel, accel, timeMs}
  let lastAuthVy = null; // 上一权威速度（算加速度）
  let lastVa = -1;
  let va = 0;
  const authTimes = []; // 权威帧产生时刻
  let t = 0;
  let nextAuthT = 0; // 下一个权威 tick 时刻
  let authTickCount = 0;
  const predSamples = [];
  const authSamples = [];
  const predVelJumps = []; // 预测速度突变（渲染管道受污染的度量）
  let lastPredVy = null;

  const K = 0.3; const CONV = 1 / 0.25; // v4.4：位置偏差比例纠正（0.25s 收敛）
  const CLAMP = 4000;

  while (t < DURATION_S) {
    // ── 主线程：处理"上轮产生的"权威帧（A2 到达，延迟 1 个预测帧 ≈ 真实轮询延迟）──
    if (authSnap && va !== lastVa) {
      lastVa = va;
      const a = authSnap;
      if (mode !== 'a') {
        const st = pred.state();
        const dt = (t * 1000 - a.timeMs) / 1000;
        if (dt >= 0.0005) {
          if (mode === 'b') {
            // v4.2 全量双向：vel_derived = Δpos/Δt 写权威 + 同步预测
            const vd = (st.posY - a.pos) / dt;
            const vc = Math.max(-CLAMP, Math.min(CLAMP, vd));
            auth.set_velocity(0, vc, 0);
            pred.set_velocity(0, vc, 0);
          } else if (mode === 'c') {
            // v4.4 增量仅权威：err 门控（5 units）+ 位置偏差比例纠正
            // V_fix = V_A2 + ex×CONV（CONV=1/收敛时间，不除以 dt 防放大振荡）；预测纯净
            const ex = st.posY - (a.pos + a.velY * dt);
            if (Math.abs(ex) >= 5 && Math.abs(ex) <= 200) {
              const vc = Math.max(-CLAMP, Math.min(CLAMP, a.velY + ex * CONV));
              auth.set_velocity(0, vc, 0);
            } else if (Math.abs(ex) > 200) {
              // 异常兜底：预测覆盖
              pred.set_state(0, a.pos, 0, 0, 0, 0, a.velY, 0, true);
            }
          } else if (mode === 'd') {
            // v4.5 速度校准：权威到达时【只记录速度】——权威纯净，
            // 不写任何外部值（权威帧不能收到除了鼠标事件以外的影响）。
            // 校准动作在预测管道逐帧执行（见下方 set_velocity）。
            void 0;
          } else if (mode === 'e') {
            // v4.6 滞后速度外推校准（反馈过程）：权威到达时【只记录速度+权威加速度】。
            // 权威算出的"Bn 应有的速度"到达时 Bn 已渲染 → 在 Bn+1..Bn+3 渲染前，
            // 从 Bn 实际速度按物理逻辑（权威最近加速度 a）外推到当前帧再替换：
            //   vel_target = vel_A + a × (t_now − t_A)
            // 垂直落体：a = −g（两帧速度差/tick）→ 外推恰好消除滞后偏差。
            void 0;
          }
        }
      }
    }

    // ── 权威管道（64Hz）：tick + 写帧（带 timeMs = tick 时刻 + 加速度）──
    if (t >= nextAuthT - 1e-9) {
      nextAuthT += TICK;
      authTickCount++;
      const sa = auth.tick(TICK, 0, 0, 0);
      // 权威加速度（两帧速度差 / tick，u/s²；首帧为 0）
      const accelY = lastAuthVy === null ? 0 : (sa.velY - lastAuthVy) / (TICK * 1000);
      lastAuthVy = sa.velY;
      // timeMs 必须记 tick【结束】时刻（t+TICK）——tick(TICK) 输出的是
      // "从 t 推进 TICK 后"的状态；记开始时刻会让外推多算一个 TICK 的滞后
      authSnap = { pos: sa.posY, velY: sa.velY, accelY, timeMs: (t + TICK) * 1000 };
      va++;
      authTimes.push(t * 1000);
      if (sa.onGround) break; // 落地结束
      authSamples.push({ t, y: sa.posY, vy: sa.velY, ground: sa.onGround });
    }

    // ── 预测管道（144Hz）：速度校准（d 直接替换 / e 外推校准）→ predict + 采样 ──
    if (authSnap) {
      if (mode === 'd') {
        // v4.5 逐帧速度校准：以最近权威速度替换预测速度（物理瞬时速度，非平均速度）。
        pred.set_velocity(0, authSnap.velY, 0);
      } else if (mode === 'e') {
        // v4.6 外推校准：vel_target = vel_A + a×(t_now − t_A)。
        // a = 权威最近加速度；两次权威帧之间 (t_now−t_A) 递增 → 逐帧外推反馈。
        const dtMs = t * 1000 - authSnap.timeMs;
        pred.set_velocity(0, authSnap.velY + authSnap.accelY * dtMs, 0);
      }
    }
    const sp = pred.predict(PRED, 0, 0, 0);
    predSamples.push({ t, y: sp.posY, vy: sp.velY });
    if (lastPredVy !== null) {
      predVelJumps.push(Math.abs(sp.velY - lastPredVy));
    }
    lastPredVy = sp.velY;

    t += PRED;
  }
  return { predSamples, authSamples, predVelJumps };
}

/** 分析：位置/速度误差 + 预测速度平滑度 */
function analyze(name, { predSamples, authSamples, predVelJumps }) {
  // 取 0.5s 与 1.0s 时刻的预测帧（避开落地）
  const at = (tt) => predSamples.find((s) => s.t >= tt) || predSamples[predSamples.length - 1];
  const p05 = at(0.5), p10 = at(1.0);
  const yErr05 = p05.y - theoryY(0.5);
  const yErr10 = p10.y - theoryY(1.0);
  // 预测速度相对理论偏差（渲染管道）
  const vyErr05 = p05.vy - theoryVy(0.5);
  const vyErr10 = p10.vy - theoryVy(1.0);
  // 预测速度逐帧跳变（锯齿度）：取第 20 帧后的均值与最大
  const jumps = predVelJumps.slice(20);
  const avgJump = jumps.reduce((s, v) => s + v, 0) / (jumps.length || 1);
  const maxJump = Math.max(...jumps, 0);
  // 权威 vs 预测 位置差（管道一致性）
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

const mode = process.argv[2];
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
