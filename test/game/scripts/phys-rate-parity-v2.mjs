/**
 * 实验③ v2（坡顶入坡）+ 实验⑥（Q3 双管道"规律归零"复现）。
 *
 * v1 教训：spawn 距面 ≤2u 会被 categorize_position 的 GROUND_TRACE_DIST=2 下探一步
 * 吸附成地面状态（diag 实测 y→0.0313=DIST_EPSILON 贴面）。v2 全部场景 spawn 距面 >2u。
 *
 * 场景 A（干净入坡）：脚底 H∈{3,5,8} 平飞 500u/s 越过台缘，自然下落撞坡面。
 * 场景 B（贴缘低空，用户描述的嫌疑场景）：H∈{2.1,2.5,3,4} —— 台 brush 竖直侧面
 *   （z=0, y≤0）与坡面在角点 (0,0) 相接；步长大的采样线可能从台侧擦入被竖直面
 *   拦截/角点吸附，步长小的先越过缘顺坡下滑 → 两线分叉。
 * 实验⑥：完整双管道（权威 64Hz + 渲染 144Hz + calibrateVelocity + land 事件微调 +
 *   反向同步三条件 + 250ms 冷却 + 在途撤回），几何 = 60°坡 → 平地，
 *   观测渲染线速度是否"规律衰减/归零"（嫌疑 a 摩擦灌入 vs 嫌疑 b 清零+循环同步）。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64, FINE = 1 / 144, G = 800, X = 4000;
const P = (n, d) => ({ normal: n, dist: d });
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
const TH = Math.PI / 3, TAN = Math.tan(TH), COS = Math.cos(TH), SIN = Math.sin(TH);

/** 平顶台：顶面 y=topY，z ≤ zEdge，竖直侧面在 z=zEdge（y≤topY 有效）。 */
function flatTop(topY, zEdge, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], zEdge), P([0, 0, -1], 4000)],
    [-X, -yBot, zEdge - 4000], [X, topY, zEdge],
  );
}
/** 60° 下坡：表面 y = topY − z·tanθ（z∈[0,zEnd]），实体在面下。 */
function rampDown(topY, zEnd, yBot) {
  return brush(
    [P([0, COS, SIN], topY * COS), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, -1], 0), P([0, 0, 1], zEnd)],
    [-X, topY - yBot, 0], [X, topY, zEnd],
  );
}
/** 平地：顶面 y=topY，z ∈ [z0, z0+len]。 */
function flat(topY, z0, len, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], z0 + len), P([0, 0, -1], z0)],
    [-X, -yBot, z0], [X, topY, z0 + len],
  );
}

function makeWorld(brushes, spawn, vel) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', ...spawn, 0);
  if (vel) w.set_velocity(...vel);
  return w;
}

function runLabeled(label, brushes, spawn, vel, dt, nSteps) {
  const w = makeWorld(brushes, spawn, vel);
  let st = null, prev = null, firstHit = '';
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    if (prev && !firstHit) {
      const dv = Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ);
      if (Math.abs(dv - G * dt) > 3) {
        firstHit = `t=${(i * dt).toFixed(4)} 首碰 |Δv|=${dv.toFixed(1)} → v=(${st.velX.toFixed(0)},${st.velY.toFixed(0)},${st.velZ.toFixed(0)}) pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)})`;
      }
    }
  }
  const speed = Math.hypot(st.velX, st.velY, st.velZ);
  console.log(`  [${label}] 终态 pos=(${st.posX.toFixed(2)},${st.posY.toFixed(2)},${st.posZ.toFixed(2)}) v=(${st.velX.toFixed(1)},${st.velY.toFixed(1)},${st.velZ.toFixed(1)}) speed=${speed.toFixed(1)} ground=${st.onGround}`);
  if (firstHit) console.log(`    · ${firstHit}`);
  return st;
}

console.log('=== 场景 A：干净入坡（H 高空平飞，无侧面参与）===');
for (const H of [3, 5, 8]) {
  console.log(`  -- 脚底 H=${H}u，vz=500 --`);
  const geo = [flatTop(0, 0, 2000), rampDown(0, 1500, 3000)];
  runLabeled('64Hz ', geo, [0, H, -30], [0, 0, 500], TICK, 200);
  runLabeled('144Hz', geo, [0, H, -30], [0, 0, 500], FINE, 450);
}

console.log('\n=== 场景 B：贴缘低空（角点 (0,0) 附近通过，台竖直侧面 z=0,y≤0）===');
for (const H of [2.1, 2.5, 3, 4]) {
  for (const vz of [300, 500, 800]) {
    const geo = [flatTop(0, 0, 2000), rampDown(0, 1500, 3000)];
    const a = runLabeled(`64Hz H=${H} vz=${vz}`, geo, [0, H, -30], [0, 0, vz], TICK, 200);
    const b = runLabeled(`144Hz H=${H} vz=${vz}`, geo, [0, H, -30], [0, 0, vz], FINE, 450);
    const dv = Math.hypot(a.velX - b.velX, a.velY - b.velY, a.velZ - b.velZ);
    if (dv > 30) console.log(`    ★ 两线分叉：Δvel=${dv.toFixed(1)} u/s`);
  }
}

console.log('\n=== 实验⑥：Q3 双管道复现（60°坡 → 平地 y=-1000）===');
{
  const Z_END = 1000 / TAN; // 577.35，坡表面到 y=-1000
  const geo = [rampDown(0, Z_END, 3000), flat(-1000, Z_END, 5000, 4000)];
  const auth = makeWorld(geo, [0, 40, 20], null); // 坡上方落下贴坡起滑
  const pred = makeWorld(geo, [0, 40, 20], null);

  let lastVa = -1;
  let curAuthSnap = null, prevAuthVel = null, prevAuthTimeMs = 0;
  let syncInFlight = false, lastSyncAt = -1e9;
  let authWasGround = false, started = false;
  const COOLDOWN = 250;

  let t = 0, nextAuthT = 0;
  const log = [];
  const series = [];
  let syncCount = 0, rollbackCount = 0, landEvents = 0;

  while (t < 6.0) {
    // ── 权威 tick 到点先执行（渲染帧内"读权威→校准→tick"顺序）──
    if (t >= nextAuthT - 1e-9) {
      const before = auth.tick(TICK, 0, 0, 0);
      const va = Math.round(nextAuthT / TICK);
      let accelX = 0, accelY = 0, accelZ = 0;
      if (prevAuthVel && prevAuthTimeMs > 0) {
        const dtA = (t * 1000 - prevAuthTimeMs) / 1000;
        if (dtA >= 0.001 && dtA <= 0.5) {
          const cl = (v) => Math.max(-20000, Math.min(20000, v));
          accelX = cl((before.velX - prevAuthVel.x) / dtA);
          accelY = cl((before.velY - prevAuthVel.y) / dtA);
          accelZ = cl((before.velZ - prevAuthVel.z) / dtA);
        }
      }
      const newVel = { x: before.velX, y: before.velY, z: before.velZ };
      const isNew = va !== lastVa;
      if (isNew) {
        lastVa = va;
        const st = pred.state();
        const dist = Math.hypot(st.posX - before.posX, st.posY - before.posY, st.posZ - before.posZ);
        if (!started) {
          started = true;
          pred.set_state(before.posX, before.posY, before.posZ, 0, 0, before.velX, before.velY, before.velZ, before.onGround);
        } else {
          if (syncInFlight && dist < 300) syncInFlight = false;
          if (syncInFlight) {
            if (dist > 500) {
              pred.set_state(before.posX, before.posY, before.posZ, 0, 0, before.velX, before.velY, before.velZ, before.onGround);
              rollbackCount++;
              log.push(`t=${t.toFixed(3)} 撤回回滚 dist=${dist.toFixed(0)}`);
              syncInFlight = false; lastSyncAt = t * 1000;
            }
          } else if (t * 1000 - lastSyncAt >= COOLDOWN && dist > 500) {
            syncInFlight = true; lastSyncAt = t * 1000; syncCount++;
            log.push(`t=${t.toFixed(3)} 反向同步(渲染→权威) dist=${dist.toFixed(0)} 渲染v=(${st.velX.toFixed(0)},${st.velY.toFixed(0)},${st.velZ.toFixed(0)})`);
            auth.set_state(st.posX, st.posY, st.posZ, 0, 0, st.velX, st.velY, st.velZ, st.onGround);
          }
        }
        // land 事件（onGround 上升沿）→ dist<60 微调
        if (started && before.onGround && !authWasGround) {
          landEvents++;
          const stR = pred.state();
          const d = Math.hypot(stR.posX - before.posX, stR.posY - before.posY, stR.posZ - before.posZ);
          if (d < 60) {
            pred.set_state(before.posX, before.posY, before.posZ, 0, 0, before.velX, before.velY, before.velZ, true);
            log.push(`t=${t.toFixed(3)} land 微调（dist=${d.toFixed(1)}）`);
          } else {
            log.push(`t=${t.toFixed(3)} land 事件但 dist=${d.toFixed(1)}≥60 跳过`);
          }
        }
        authWasGround = before.onGround;
        curAuthSnap = { vel: newVel, accel: { x: accelX, y: accelY, z: accelZ }, timeMs: t * 1000, ground: before.onGround };
      }
      prevAuthVel = newVel;
      prevAuthTimeMs = t * 1000;
      nextAuthT += TICK;
    }

    // ── calibrateVelocity：每渲染帧覆盖渲染线速度 ──
    if (curAuthSnap) {
      const a = curAuthSnap;
      const dtMs = t * 1000 - a.timeMs;
      let vx = a.vel.x, vy = a.vel.y, vz = a.vel.z;
      if (dtMs > 0 && dtMs <= 100) {
        vx += (a.accel.x * dtMs) / 1000;
        vy += (a.accel.y * dtMs) / 1000;
        vz += (a.accel.z * dtMs) / 1000;
      }
      pred.set_velocity(vx, vy, vz);
    }

    const sp = pred.tick(FINE, 0, 0, 0);
    series.push({ t, speed: Math.hypot(sp.velX, sp.velY, sp.velZ), vy: sp.velY, y: sp.posY, z: sp.posZ, ground: sp.onGround });
    t += FINE;
  }

  console.log(`  同步=${syncCount} 撤回=${rollbackCount} land事件=${landEvents}`);
  for (const l of log.slice(0, 40)) console.log(`    · ${l}`);
  console.log('  渲染线时间序列（每 0.2s）:');
  const step = Math.round(0.2 / FINE);
  for (let i = 0; i < series.length; i += step) {
    const s = series[i];
    console.log(`    t=${s.t.toFixed(2)} speed=${s.speed.toFixed(1)} vy=${s.vy.toFixed(1)} pos=(${s.y.toFixed(1)},${s.z.toFixed(1)}) ground=${s.ground}`);
  }
  const authSt = auth.tick(TICK, 0, 0, 0);
  console.log(`  权威终态 pos=(${authSt.posY.toFixed(1)},${authSt.posZ.toFixed(1)}) v=(${authSt.velY.toFixed(1)},${authSt.velZ.toFixed(1)}) ground=${authSt.onGround}`);
}
