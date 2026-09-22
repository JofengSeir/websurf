/**
 * 步长分区等价性实验的续篇：坡顶入坡细扫 + 双管道复现（`apps/game/scripts/phys-rate-parity.mjs`
 * 同族，其输出段编号为实验①–⑤；本脚本不沿用该编号）。
 *
 * 场景 A（干净入坡）：脚底高出平顶台 H ∈ {3,5,8} HU，以 500 HU/s 沿 +z 平飞越过台缘
 *   （z = 0）后自然下落撞 60° 坡面；两档步长各跑 3.125 s（200 × 1/64 与 450 × 1/144），
 *   比较终态位置与速度。
 * 场景 B（贴缘低空）：H ∈ {2.1,2.5,3,4} × vz ∈ {300,500,800}，扫描平顶台竖直侧面
 *   （平面 z = 0，实体在 z ≤ 0 一侧）与坡面在角点 (y,z) = (0,0) 相接处的通过结果；
 *   两档终态速度差 > 30 HU/s 时打印「两线分叉」。
 * 双管道复现：在脚本内复刻渲染线 + 权威线的同步逻辑 —— 权威 64 Hz `tick`、渲染 144 Hz
 *   `tick`、每渲染帧用权威快照覆盖渲染线速度、`onGround` 上升沿对应的落地微调、
 *   反向同步三条件、250 ms 冷却、在途撤回；几何为 60° 坡（下探到 y = −1000）接平地，
 *   循环 6 s。每 0.2 s 打印一次渲染线速度与位置供人工判读，脚本不设断言也无退出码判定。
 *
 * 各场景出生点与所站面的距离都大于 `GROUND_TRACE_DIST`（场景 B 最小 2.1 HU），
 * 避免 `src/phys/player.rs` 的 `categorize_position` 在首个 tick 就把出生点吸附成着地。
 *
 * 用法：node scripts/phys-rate-parity-v2.mjs（无参数）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64, FINE = 1 / 144, G = 800, X = 4000; // 权威 / 渲染两档步长（s）| 重力（HU/s²，同 `src/phys/player.rs` 的 `GRAVITY`）| 世界盒远界面距离
const P = (n, d) => ({ normal: n, dist: d }); // 平面：法线 + 距离
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true }); // brush：平面组 + 宽相位 AABB + 实心标志
const TH = Math.PI / 3, TAN = Math.tan(TH), COS = Math.cos(TH), SIN = Math.sin(TH); // 60° 坡角及其三角函数（rampDown 用）

/** 平顶台：顶面 y = topY（z ≤ zEdge），竖直侧面在 z = zEdge，底面 y = −yBot。
 *  宽相位 AABB 取 z ∈ [zEdge − 4000, zEdge]、y ∈ [−yBot, topY]（`src/phys/world.rs`
 *  的候选筛选与空间网格都读它）；本脚本全部调用点传 zEdge = 0，故 AABB 与平面覆盖一致。 */
function flatTop(topY, zEdge, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], zEdge), P([0, 0, -1], 4000)],
    [-X, -yBot, zEdge - 4000], [X, topY, zEdge],
  );
}
/** 60° 下坡：表面 y = topY − z·tanθ（z ∈ [0, zEnd]），实体在面下（y ≤ 表面）。
 *  θ 取上面的 TH，平面常数项为 topY × COS。 */
function rampDown(topY, zEnd, yBot) {
  return brush(
    [P([0, COS, SIN], topY * COS), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, -1], 0), P([0, 0, 1], zEnd)],
    [-X, topY - yBot, 0], [X, topY, zEnd],
  );
}
/** 平地：顶面 y = topY，z ∈ [z0, z0 + len]（底面 y = −yBot，两侧面在 x = ±X）。 */
function flat(topY, z0, len, yBot) {
  return brush(
    [P([0, 1, 0], topY), P([0, -1, 0], yBot), P([1, 0, 0], X), P([-1, 0, 0], X),
     P([0, 0, 1], z0 + len), P([0, 0, -1], z0)],
    [-X, -yBot, z0], [X, topY, z0 + len],
  );
}

/** 建实例：brush / teleport JSON + 出生点三项 + 固定 yaw = 0；传入 vel 时再 set_velocity。 */
function makeWorld(brushes, spawn, vel) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', ...spawn, 0);
  if (vel) w.set_velocity(...vel);
  return w;
}

/** 跑 nSteps 个 dt 步并打印终态，返回终态供两档比较；首个 |Δv| 偏离 G·dt 超过 3 的
 *  tick 记为「首碰」（自由落体每 tick 的速度增量恰为 G·dt）。 */
function runLabeled(label, brushes, spawn, vel, dt, nSteps) {
  const w = makeWorld(brushes, spawn, vel);
  let st = null, prev = null, firstHit = '';
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    // 首个 |Δv| 偏离 G·dt 超过 3 的 tick 记为首碰（碰面后速度改向即触发）
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
  const Z_END = 1000 / TAN; // 坡面下探到 y = −1000 所需的 z（= 1000 / tan60° ≈ 577.35）
  const geo = [rampDown(0, Z_END, 3000), flat(-1000, Z_END, 5000, 4000)];
  const auth = makeWorld(geo, [0, 40, 20], null); // 出生点在坡面上方（z = 20 处坡面 y ≈ −34.64），落下后贴坡起滑
  const pred = makeWorld(geo, [0, 40, 20], null);

  let lastVa = -1; // 上一次权威 tick 序号
  let curAuthSnap = null, prevAuthVel = null, prevAuthTimeMs = 0; // 当前权威快照 / 上一权威速度 / 上一权威时刻（ms）
  let syncInFlight = false, lastSyncAt = -1e9; // 反向同步在途标志 + 上次发起时刻（ms，初值取极小）
  let authWasGround = false, started = false; // 权威着地上沿检测 + 渲染线首次播种标志
  const COOLDOWN = 250; // 两次反向同步之间的最小间隔（ms）

  let t = 0, nextAuthT = 0; // 渲染线时间（s）与下一个权威 tick 时刻（s）
  const log = [];    // 同步 / 撤回 / 落地微调的文字记录
  const series = []; // 渲染线逐帧样本 { t, speed, vy, y, z, ground }
  let syncCount = 0, rollbackCount = 0, landEvents = 0; // 三类事件计数

  while (t < 6.0) {
    // ── 权威 tick 先于本帧渲染：tick 一步、按上一权威帧估加速度，再按需播种/同步/微调 ──
    if (t >= nextAuthT - 1e-9) {
      const before = auth.tick(TICK, 0, 0, 0);
      const va = Math.round(nextAuthT / TICK); // 权威 tick 序号
      let accelX = 0, accelY = 0, accelZ = 0;
      // 加速度按相邻权威帧的 Δv / Δt 估计：dtA ∈ [0.001, 0.5] s 才计算
      if (prevAuthVel && prevAuthTimeMs > 0) {
        const dtA = (t * 1000 - prevAuthTimeMs) / 1000;
        if (dtA >= 0.001 && dtA <= 0.5) {
          const cl = (v) => Math.max(-20000, Math.min(20000, v)); // 单轴钳制 ±20000
          accelX = cl((before.velX - prevAuthVel.x) / dtA);
          accelY = cl((before.velY - prevAuthVel.y) / dtA);
          accelZ = cl((before.velZ - prevAuthVel.z) / dtA);
        }
      }
      const newVel = { x: before.velX, y: before.velY, z: before.velZ };
      const isNew = va !== lastVa; // TICK = 1/64 是二进制精确值，序号逐 tick +1，本判据恒成立
      if (isNew) {
        lastVa = va;
        const st = pred.state();
        const dist = Math.hypot(st.posX - before.posX, st.posY - before.posY, st.posZ - before.posZ);
        // 首个权威帧：把渲染线整体播种到权威状态（位置 / 速度 / 着地）
        if (!started) {
          started = true;
          pred.set_state(before.posX, before.posY, before.posZ, 0, 0, before.velX, before.velY, before.velZ, before.onGround);
        } else {
          if (syncInFlight && dist < 300) syncInFlight = false; // 偏差已收敛到 300 以内 → 撤销在途标志
          if (syncInFlight) {
            // 在途且偏差 > 500 → 撤回：渲染线直接回滚到权威状态
            if (dist > 500) {
              pred.set_state(before.posX, before.posY, before.posZ, 0, 0, before.velX, before.velY, before.velZ, before.onGround);
              rollbackCount++;
              log.push(`t=${t.toFixed(3)} 撤回回滚 dist=${dist.toFixed(0)}`);
              syncInFlight = false; lastSyncAt = t * 1000;
            }
          // 非在途：距上次同步 ≥ COOLDOWN 且偏差 > 500 → 反向同步（渲染线状态写回权威）
          } else if (t * 1000 - lastSyncAt >= COOLDOWN && dist > 500) {
            syncInFlight = true; lastSyncAt = t * 1000; syncCount++;
            log.push(`t=${t.toFixed(3)} 反向同步(渲染→权威) dist=${dist.toFixed(0)} 渲染v=(${st.velX.toFixed(0)},${st.velY.toFixed(0)},${st.velZ.toFixed(0)})`);
            auth.set_state(st.posX, st.posY, st.posZ, 0, 0, st.velX, st.velY, st.velZ, st.onGround);
          }
        }
        // 落地事件（权威 onGround 由 false 变 true）：偏差 < 60 时把渲染线贴到权威状态
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

    // ── calibrateVelocity：每渲染帧用权威快照覆盖渲染线速度（位置不动）──
    if (curAuthSnap) {
      const a = curAuthSnap;
      const dtMs = t * 1000 - a.timeMs;
      let vx = a.vel.x, vy = a.vel.y, vz = a.vel.z;
      if (dtMs > 0 && dtMs <= 100) { // 只外推权威帧后 100 ms 内，超出则原样用快照速度
        vx += (a.accel.x * dtMs) / 1000;
        vy += (a.accel.y * dtMs) / 1000;
        vz += (a.accel.z * dtMs) / 1000;
      }
      pred.set_velocity(vx, vy, vz); // set_velocity 只写速度，不动位置与着地
    }

    const sp = pred.tick(FINE, 0, 0, 0); // 渲染线走 tick（不是 predict）
    series.push({ t, speed: Math.hypot(sp.velX, sp.velY, sp.velZ), vy: sp.velY, y: sp.posY, z: sp.posZ, ground: sp.onGround });
    t += FINE;
  }

  console.log(`  同步=${syncCount} 撤回=${rollbackCount} land事件=${landEvents}`);
  for (const l of log.slice(0, 40)) console.log(`    · ${l}`);
  console.log('  渲染线时间序列（每 0.2s）:');
  const step = Math.round(0.2 / FINE); // 抽稀步长 = 29 个渲染步（≈ 0.2014 s）
  for (let i = 0; i < series.length; i += step) {
    const s = series[i];
    console.log(`    t=${s.t.toFixed(2)} speed=${s.speed.toFixed(1)} vy=${s.vy.toFixed(1)} pos=(${s.y.toFixed(1)},${s.z.toFixed(1)}) ground=${s.ground}`);
  }
  const authSt = auth.tick(TICK, 0, 0, 0); // 收尾：权威再 tick 一步后打印终态
  console.log(`  权威终态 pos=(${authSt.posY.toFixed(1)},${authSt.posZ.toFixed(1)}) v=(${authSt.velY.toFixed(1)},${authSt.velZ.toFixed(1)}) ground=${authSt.onGround}`);
}
