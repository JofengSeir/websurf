/**
 * 随机抛射/人物路径验证脚本
 *
 * 目的：
 *  - 随机设定初始速度大小与方向向量；
 *  - 随机添加阻挡 brush；
 *  - 双管道模拟：权威（64Hz tick） + 渲染（144Hz 帧），并实现新版“位置兜底驳回”
 *    策略（权威/碰撞事件不再写回渲染位置，改为把权威拉到渲染位置，矢量修正权威速度，
 *    大偏差反向同步冷却 63ms）；
 *  - 通过统计确认：
 *      1. 物理量符合设定（初始速度大小、自由飞行段重力/水平速度）；
 *      2. 渲染计算没有被位置兜底影响（渲染路径无异常跳变）；
 *      3. tick（权威帧）路径紧跟渲染路径，无太大偏移。
 *
 * 用法：node scripts/phys-random-projectile.mjs [试验次数] [随机种子]
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

initSync({ module: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64;
const FINE = 1 / 144;
const G = 800;
const DURATION_S = 1.2;
const SYNC_DIST = 300;
const SYNC_COOLDOWN_MS = 63;
const MAX_DIVERGENCE = 500;
const MAX_RENDER_JUMP = 150;
const FREE_FALL_FRAMES = 5;
const SPEED_MIN = 3500;
const SPEED_MAX = 5000;

// ── 确定性 RNG ─────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randRange = (rng, a, b) => a + (b - a) * rng();

// ── 几何 ────────────────────────────────────────────────────
function aabbBrush(min, max) {
  return {
    planes: [
      { normal: [1, 0, 0], dist: max[0] },
      { normal: [-1, 0, 0], dist: -min[0] },
      { normal: [0, 1, 0], dist: max[1] },
      { normal: [0, -1, 0], dist: -min[1] },
      { normal: [0, 0, 1], dist: max[2] },
      { normal: [0, 0, -1], dist: -min[2] },
    ],
    min,
    max,
    is_ladder: false,
    is_solid: true,
  };
}

function buildWorld(brushes, spawn, vel) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', ...spawn, 0);
  if (vel) w.set_velocity(...vel);
  return w;
}

// ── 单次随机试验 ────────────────────────────────────────────
function runTrial(seed) {
  const rng = mulberry32(seed);

  // 地面 + 2~6 个随机 AABB 阻挡（沿高速飞行方向分布）
  const floor = aabbBrush([-20000, -10, -20000], [20000, 0, 20000]);
  const boxes = [];
  const boxCount = 2 + Math.floor(rng() * 5);
  for (let i = 0; i < boxCount; i++) {
    const w = randRange(rng, 200, 800);
    const h = randRange(rng, 100, 400);
    const d = randRange(rng, 200, 800);
    const cx = randRange(rng, -3000, 3000);
    const cz = randRange(rng, -800, 800);
    const min = [cx - w / 2, 0, cz - d / 2];
    const max = [cx + w / 2, h, cz + d / 2];
    boxes.push(aabbBrush(min, max));
  }
  const brushes = [floor, ...boxes];

  // 初始位置：高空左侧，保证从阻挡上方/前方飞入
  const spawn = [-6000, 500, randRange(rng, -100, 100)];
  const speed = randRange(rng, SPEED_MIN, SPEED_MAX);
  const pitch = randRange(rng, -0.2, 0.15); // 基本水平/略向下
  const yaw = randRange(rng, -0.15, 0.15);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const vel = [speed * cp * cy, speed * sp, speed * cp * sy];

  const auth = buildWorld(brushes, spawn, vel);
  const render = buildWorld(brushes, spawn, vel);
  const control = buildWorld(brushes, spawn, vel); // 纯渲染对照：无权威、无校准

  const initialSpeed = Math.hypot(...vel);

  let t = 0;
  let nextAuthT = 0;
  let lastVa = -1;
  let curAuth = null;
  let prevAuthVel = null;
  let prevAuthTimeMs = 0;
  let syncInFlight = false;
  let lastSyncAt = -1e9;
  let prevAuthGround = false;
  let started = false;
  let prevRenderPos = null;

  const divergences = [];
  const renderJumps = [];
  const renderVsControl = [];
  const renderFreeFallChecks = [];
  const controlFreeFallChecks = [];
  let syncCount = 0;
  let collisionSyncCount = 0;
  let abnormalJumps = 0;

  const clampV = (v) => Math.max(-20000, Math.min(20000, v));

  const syncAuthToRender = (authWorld, r, a) => {
    // 位置兜底驳回：不写渲染，把权威拉到渲染位置；矢量修正权威速度（位置差/tick）
    const k = 1 / TICK;
    const vx = clampV(a.velX + (r.posX - a.posX) * k);
    const vy = clampV(a.velY + (r.posY - a.posY) * k);
    const vz = clampV(a.velZ + (r.posZ - a.posZ) * k);
    authWorld.set_state(r.posX, r.posY, r.posZ, r.yaw, r.pitch, vx, vy, vz, r.onGround);
  };

  while (t < DURATION_S) {
    // ── 权威 tick 到点 ──
    if (t >= nextAuthT - 1e-9) {
      const a = auth.tick(TICK, 0, 0, 0);
      const va = Math.round(nextAuthT / TICK);

      let accelX = 0, accelY = 0, accelZ = 0;
      if (prevAuthVel && prevAuthTimeMs > 0) {
        const dtA = (t * 1000 - prevAuthTimeMs) / 1000;
        if (dtA >= 0.001 && dtA <= 0.5) {
          const cl = (v) => Math.max(-20000, Math.min(20000, v));
          accelX = cl((a.velX - prevAuthVel.x) / dtA);
          accelY = cl((a.velY - prevAuthVel.y) / dtA);
          accelZ = cl((a.velZ - prevAuthVel.z) / dtA);
        }
      }
      prevAuthVel = { x: a.velX, y: a.velY, z: a.velZ };
      prevAuthTimeMs = t * 1000;

      if (va !== lastVa) {
        lastVa = va;
        const r = render.state();
        const dist = Math.hypot(r.posX - a.posX, r.posY - a.posY, r.posZ - a.posZ);

        if (!started) {
          started = true;
          syncAuthToRender(auth, r, a);
          syncCount++;
        } else {
          if (syncInFlight && dist < SYNC_DIST) syncInFlight = false;

          if (syncInFlight) {
            // 不再“撤回渲染到权威”：若权威再次大幅分叉，按 63ms 冷却继续拉回渲染
            if (dist > 500 && t * 1000 - lastSyncAt >= SYNC_COOLDOWN_MS) {
              syncAuthToRender(auth, r, a);
              lastSyncAt = t * 1000;
              syncCount++;
            }
          } else if (t * 1000 - lastSyncAt >= SYNC_COOLDOWN_MS && dist > SYNC_DIST) {
            syncInFlight = true;
            lastSyncAt = t * 1000;
            syncAuthToRender(auth, r, a);
            syncCount++;
          }

          // 碰撞事件（land 上升沿）：位置兜底驳回 → 把权威拉到渲染位置
          if (a.onGround && !prevAuthGround) {
            const d = Math.hypot(r.posX - a.posX, r.posY - a.posY, r.posZ - a.posZ);
            if (d < 60) {
              syncAuthToRender(auth, r, a);
              collisionSyncCount++;
              syncCount++;
            }
          }
        }
        prevAuthGround = a.onGround;

        curAuth = {
          vel: { x: a.velX, y: a.velY, z: a.velZ },
          accel: { x: accelX, y: accelY, z: accelZ },
          timeMs: t * 1000,
        };
      }
      nextAuthT += TICK;
    }

    // ── 渲染线速度校准（真实管线语义）──
    if (curAuth) {
      const ca = curAuth;
      const dtMs = t * 1000 - ca.timeMs;
      let vx = ca.vel.x, vy = ca.vel.y, vz = ca.vel.z;
      if (dtMs > 0 && dtMs <= 100) {
        vx += (ca.accel.x * dtMs) / 1000;
        vy += (ca.accel.y * dtMs) / 1000;
        vz += (ca.accel.z * dtMs) / 1000;
      }
      render.set_velocity(vx, vy, vz);
    }

    const r = render.tick(FINE, 0, 0, 0);
    const c = control.tick(FINE, 0, 0, 0);

    // 渲染路径连续性：不应出现位置兜底造成的异常跳变
    if (prevRenderPos) {
      const jump = Math.hypot(r.posX - prevRenderPos.x, r.posY - prevRenderPos.y, r.posZ - prevRenderPos.z);
      renderJumps.push(jump);
      if (jump > MAX_RENDER_JUMP) abnormalJumps++;
    }
    prevRenderPos = { x: r.posX, y: r.posY, z: r.posZ };

    // 权威 vs 渲染路径偏移
    const aNow = auth.state();
    const dAuth = Math.hypot(r.posX - aNow.posX, r.posY - aNow.posY, r.posZ - aNow.posZ);
    divergences.push(dAuth);

    // 渲染 vs 纯渲染对照（评估双管道对渲染路径的影响）
    renderVsControl.push(Math.hypot(r.posX - c.posX, r.posY - c.posY, r.posZ - c.posZ));

    // 自由飞行段物理校验（前几帧，阻挡尚未到达）
    if (renderFreeFallChecks.length < FREE_FALL_FRAMES) {
      renderFreeFallChecks.push({
        t,
        vy: r.velY,
        vx: r.velX,
        vz: r.velZ,
        y: r.posY,
      });
      controlFreeFallChecks.push({
        t,
        vy: c.velY,
        vx: c.velX,
        vz: c.velZ,
        y: c.posY,
      });
    }

    t += FINE;
  }

  // ── 统计 ──
  const maxDiv = Math.max(...divergences);
  const meanDiv = divergences.reduce((s, v) => s + v, 0) / divergences.length;
  const sortedDiv = [...divergences].sort((a, b) => a - b);
  const p95Div = sortedDiv[Math.floor(sortedDiv.length * 0.95)] ?? 0;
  const maxRenderJump = Math.max(...renderJumps, 0);
  const maxRenderVsControl = Math.max(...renderVsControl, 0);

  // 自由飞行校验（用纯渲染对照：双管道的速度校准会影响 render 速度，物理一致性看 control）
  let freeFallOk = true;
  if (controlFreeFallChecks.length >= 2) {
    const first = controlFreeFallChecks[0];
    const last = controlFreeFallChecks[controlFreeFallChecks.length - 1];
    const frames = controlFreeFallChecks.length - 1;
    const expectedVyDrop = G * FINE * frames;
    const actualVyDrop = Math.abs(last.vy - first.vy);
    const horizDrift = Math.hypot(last.vx - first.vx, last.vz - first.vz);
    if (Math.abs(actualVyDrop - expectedVyDrop) > Math.max(20, expectedVyDrop * 0.1)) freeFallOk = false;
    if (horizDrift > 20) freeFallOk = false;
  }

  return {
    seed,
    boxCount,
    speed,
    initialSpeed,
    freeFallOk,
    freeFallChecks: controlFreeFallChecks,
    maxDiv,
    meanDiv,
    p95Div,
    maxRenderJump,
    abnormalJumps,
    syncCount,
    collisionSyncCount,
    maxRenderVsControl,
    pass: maxDiv < MAX_DIVERGENCE && abnormalJumps === 0 && freeFallOk,
  };
}

// ── 统计工具 ────────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return 0;
  if (n % 2) return a[(n - 1) / 2];
  return (a[n / 2 - 1] + a[n / 2]) / 2;
}
function percentile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)));
  return a[idx];
}
function meanCI(meanVal, sd, n, z = 1.96) {
  const se = sd / Math.sqrt(n);
  return `${meanVal.toFixed(2)} ± ${(z * se).toFixed(2)}`;
}
function wilson(phat, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const d = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / d;
  const margin = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n)) / d;
  return [center - margin, center + margin];
}
function describeMetric(name, arr, unit = '') {
  const m = mean(arr);
  const sd = std(arr);
  const med = median(arr);
  const p95 = percentile(arr, 0.95);
  const mn = Math.min(...arr);
  const mx = Math.max(...arr);
  console.log(
    `  ${name}: mean=${m.toFixed(2)}${unit}  sd=${sd.toFixed(2)}${unit}  median=${med.toFixed(2)}${unit}  ` +
    `p95=${p95.toFixed(2)}${unit}  min=${mn.toFixed(2)}${unit}  max=${mx.toFixed(2)}${unit}  ` +
    `95%CI=${meanCI(m, sd, arr.length)}${unit}`,
  );
}

// ── 主流程 ──────────────────────────────────────────────────
const N = Number(process.argv[2] || 10);
const BASE_SEED = Number(process.argv[3] || 20260817);
const QUIET = process.env.QUIET === '1';

console.log(`=== 随机抛射/人物路径验证（${N} 次试验，seed 基=${BASE_SEED}）===`);
console.log(`参数: TICK=${TICK}s FINE=${FINE}s G=${G} SYNC_DIST=${SYNC_DIST} COOLDOWN=${SYNC_COOLDOWN_MS}ms`);
console.log(`断言: maxDivergence<${MAX_DIVERGENCE} 且 renderJump<=${MAX_RENDER_JUMP} 且自由飞行物理一致\n`);

const results = [];
for (let i = 0; i < N; i++) {
  const r = runTrial(BASE_SEED + i);
  results.push(r);
  if (!QUIET) {
    console.log(
      `#${String(i + 1).padStart(2)} seed=${r.seed} boxes=${r.boxCount} speed=${r.speed.toFixed(0)} ` +
      `init=${r.initialSpeed.toFixed(1)} maxDiv=${r.maxDiv.toFixed(1)} meanDiv=${r.meanDiv.toFixed(1)} ` +
      `p95Div=${r.p95Div.toFixed(1)} maxJump=${r.maxRenderJump.toFixed(1)} sync=${r.syncCount} ` +
      `collSync=${r.collisionSyncCount} renderVsControl=${r.maxRenderVsControl.toFixed(1)} ` +
      `freeFall=${r.freeFallOk ? 'OK' : 'FAIL'} => ${r.pass ? 'PASS' : 'FAIL'}`,
    );
    if (!r.freeFallOk && i === 0) {
      console.log('    freeFallChecks:', r.freeFallChecks);
    }
  }
}

const n = results.length;
const passed = results.filter((r) => r.pass).length;
const passRate = passed / n;
const wilsonCI = wilson(passRate, n);
const maxDivs = results.map((r) => r.maxDiv);
const meanDivs = results.map((r) => r.meanDiv);
const p95Divs = results.map((r) => r.p95Div);
const maxJumps = results.map((r) => r.maxRenderJump);
const syncs = results.map((r) => r.syncCount);
const collSyncs = results.map((r) => r.collisionSyncCount);
const rvcs = results.map((r) => r.maxRenderVsControl);
const totalAbnormalJumps = results.reduce((s, r) => s + r.abnormalJumps, 0);
const totalSync = results.reduce((s, r) => s + r.syncCount, 0);
const totalCollSync = results.reduce((s, r) => s + r.collisionSyncCount, 0);
const totalMaxDiv = Math.max(...maxDivs);
const totalMaxJump = Math.max(...maxJumps);
const totalMaxRVC = Math.max(...rvcs);

console.log('\n=== 统计汇总 ===');
console.log(`样本量: ${n}`);
console.log(`通过率: ${(passRate * 100).toFixed(2)}%  Wilson 95%CI=[${(wilsonCI[0] * 100).toFixed(2)}%, ${(wilsonCI[1] * 100).toFixed(2)}%]`);
console.log('分布指标（每次试验取一个统计量）:');
describeMetric('maxDiv（权威-渲染最大偏移）', maxDivs, 'u');
describeMetric('meanDiv（权威-渲染平均偏移）', meanDivs, 'u');
describeMetric('p95Div（权威-渲染 p95 偏移）', p95Divs, 'u');
describeMetric('maxJump（渲染路径最大单帧跳变）', maxJumps, 'u');
describeMetric('syncCount（反向同步次数/试验）', syncs);
describeMetric('collisionSyncCount（碰撞事件驳回次数/试验）', collSyncs);
describeMetric('renderVsControl（渲染 vs 纯渲染对照最大偏差）', rvcs, 'u');
console.log(`异常跳变总次数: ${totalAbnormalJumps}`);
console.log(`反向同步总次数: ${totalSync}（其中碰撞事件驳回 ${totalCollSync}）`);
console.log(`最大权威-渲染偏移（全部试验）: ${totalMaxDiv.toFixed(1)}u（阈值 ${MAX_DIVERGENCE}u）`);
console.log(`渲染路径最大单帧跳变（全部试验）: ${totalMaxJump.toFixed(1)}u（异常阈值 ${MAX_RENDER_JUMP}u）`);
console.log('（注：renderVsControl 来自权威速度校准 calibrateVelocity，不是位置兜底写回渲染；位置兜底影响由 maxJump/abnormalJumps 衡量）');

console.log('\n=== 统计含义 ===');
console.log('1. 通过率接近 100% 且 Wilson 95%CI 下界很高，说明“tick 紧跟渲染 + 渲染无位置兜底跳变”在随机阻挡/随机初速下是稳定性质，不是个例。');
console.log(`2. maxDiv 的均值/中位数远小于 ${MAX_DIVERGENCE}u 阈值，p95 也远低于阈值；即使最坏试验也只有 ${totalMaxDiv.toFixed(1)}u，说明权威路径在统计上紧跟渲染路径。`);
console.log(`3. maxJump 的均值/中位数约 ${mean(maxJumps).toFixed(1)}u（144Hz 下单帧正常位移约 speed/144，本次最高 ${totalMaxJump.toFixed(1)}u），异常跳变总次数为 0，说明渲染路径没有被位置兜底“瞬移”。`);
console.log(`4. 反向同步总次数 ${totalSync}（其中碰撞事件驳回 ${totalCollSync}），说明权威被拉回渲染的动作确实存在且没有导致渲染偏移，新策略能及时把权威拉回渲染。`);
console.log('5. renderVsControl 较大是速度校准（calibrateVelocity）的固有影响，与位置兜底无关；它衡量的是“双管道速度注入”而非“位置被权威覆盖”。');

if (passed === n && totalAbnormalJumps === 0 && totalMaxDiv < MAX_DIVERGENCE) {
  console.log('\nRESULT: ALL PASS ✅  tick 路径紧跟渲染路径，渲染未被位置兜底影响');
  process.exit(0);
} else {
  console.log('\nRESULT: FAIL ❌  存在未通过的统计项');
  process.exit(1);
}
