/**
 * 步长分区等价性（rate parity）实验 — 同一 wasm 物理在不同积分步长下的行为对比。
 *
 * 背景（均可回源码定位）：
 * - 渲染线（主线程预测）与权威线（Worker）共用同一份 `PhysWorld`；`src/phys/player.rs` 的
 *   `air_move` 是半重力中点法——`try_player_move` 前后各施加 `−0.5 × gravity × dt`，
 *   合计每 tick `−gravity × dt`。
 * - 由此纯弹道（无碰撞、无输入）下速度累加 `Σ g·dt` 与位置都与步长划分无关（中点法对线性
 *   速度精确）⇒ 两档步长跑到同一时刻，差异应当只在 f64 舍入量级。
 * - 实验：①自由落体 64 vs 144（同段另跑一条"混合分区"，其终态未参与比对，见该段注释）；
 *   ②60° 直坡滑行；③坡顶入坡（凸角，离角间隙扫描）；④坡底接缝（坡→平顶块，两段的 z 覆盖
 *   并不重合，见该段注释）；⑤V 形槽谷底横切。
 *
 * 用法：node scripts/phys-rate-parity.mjs（无参数）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
initSync({ module: readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm')) });

const TICK = 1 / 64; // 步长档 A：1/64 s
const FINE = 1 / 144; // 步长档 B：1/144 s（与档 A 之比 = 2.25）
const G = 800; // 与 src/phys/player.rs 的 `GRAVITY`（800.0）一致；用于"该步重力预期"判据
const X = 4000; // 世界盒远界面距离（±x 与 z 向平面的 dist）

const P = (n, d) => ({ normal: n, dist: d });
const brush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });

/** 下坡（向 +z 下降 θ）：表面 y = -z·tanθ，z∈[0,zEnd]，实体在表面下方。 */
function rampDown(theta, zEnd, yBottom) {
  const t = Math.tan(theta);
  return brush(
    [
      P([0, Math.cos(theta), Math.sin(theta)], 0),
      P([0, -1, 0], yBottom),
      P([1, 0, 0], X), P([-1, 0, 0], X),
      P([0, 0, -1], 0), P([0, 0, 1], zEnd),
    ],
    [-X, -yBottom, 0], [X, 0, zEnd],
  );
}

/** 平顶块：顶面 y=topY，z ≤ zEdge。
 *  宽相位 AABB 取 `z ∈ [zEdge − 4000, zEdge]`、`y ∈ [−yBot, topY]`（`src/phys/world.rs` 的
 *  候选筛选与空间网格都读它们），而平面本身允许 `z ≥ −4000` ⇒ `zEdge > 0` 时两者不一致：
 *  实验④传 `zEdge = zEnd + 5000`，AABB 于是从 `z = zEnd + 1000` 起，接缝处那段不在索引内。 */
function flatTop(topY, zEdge, yBot) {
  return brush(
    [
      P([0, 1, 0], topY), P([0, -1, 0], yBot),
      P([1, 0, 0], X), P([-1, 0, 0], X),
      P([0, 0, 1], zEdge), P([0, 0, -1], 4000),
    ],
    [-X, -yBot, zEdge - 4000], [X, topY, zEdge],
  );
}

/** V 形槽（谷底棱线沿 x 过原点，两壁 60°）：A 壁 z≥0 面 y=+z·tanθ，B 壁镜像。 */
function grooveWall(theta, sign) {
  // sign=+1: z≥0 壁（实体 y ≤ z·tanθ，法线 (0,cosθ,-sinθ)）；sign=-1 镜像
  const c = Math.cos(theta), s = Math.sin(theta);
  return brush(
    [
      P([0, c, -s * sign], 0),
      P([0, -1, 0], 4000),
      P([1, 0, 0], X), P([-1, 0, 0], X),
      P([0, 0, sign], 0),       // 内侧切（A: z≥0 / B: z≤0）
      P([0, 0, -sign], 3000),
    ],
    sign > 0 ? [-X, -4000, 0] : [-X, -4000, -3000],
    sign > 0 ? [X, 3000 * Math.tan(theta), 3000] : [X, 3000 * Math.tan(theta), 0],
  );
}

function makeWorld(brushes, spawn, vel) {
  const w = new PhysWorld();
  w.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}',
    spawn[0], spawn[1], spawn[2], 0);
  if (vel) w.set_velocity(vel[0], vel[1], vel[2]);
  return w;
}

/** 以固定步长跑 n 步；记录碰撞样事件（|Δv| 超出该步重力预期 +3）与 onGround 翻转。 */
function run(label, brushes, spawn, vel, dt, nSteps) {
  const w = makeWorld(brushes, spawn, vel);
  let st = null, prev = null, prevGround = null;
  const events = [];
  for (let i = 0; i < nSteps; i++) {
    prev = st;
    st = w.tick(dt, 0, 0, 0);
    if (prev) {
      const dv = Math.hypot(st.velX - prev.velX, st.velY - prev.velY, st.velZ - prev.velZ);
      if (Math.abs(dv - G * dt) > 3) {
        events.push(`t=${(i * dt).toFixed(3)} |Δv|=${dv.toFixed(1)} v=(${st.velX.toFixed(0)},${st.velY.toFixed(0)},${st.velZ.toFixed(0)}) pos=(${st.posX.toFixed(1)},${st.posY.toFixed(1)},${st.posZ.toFixed(1)}) ground=${st.onGround}`);
      }
      if (prevGround !== null && st.onGround !== prevGround) {
        events.push(`t=${(i * dt).toFixed(3)} onGround→${st.onGround}`);
      }
    }
    prevGround = st.onGround;
  }
  const speed = Math.hypot(st.velX, st.velY, st.velZ);
  console.log(`  [${label}] t=${(nSteps * dt).toFixed(3)} pos=(${st.posX.toFixed(3)},${st.posY.toFixed(3)},${st.posZ.toFixed(3)}) vel=(${st.velX.toFixed(3)},${st.velY.toFixed(3)},${st.velZ.toFixed(3)}) speed=${speed.toFixed(2)} ground=${st.onGround}`);
  for (const e of events.slice(0, 12)) console.log(`    · ${e}`);
  if (events.length > 12) console.log(`    · …共 ${events.length} 条`);
  return st;
}

console.log('=== 实验①：自由落体步长分区等价性（1.0s，落地前）===');
{
  const floor = brush(
    [P([0, 1, 0], 0), P([0, -1, 0], 1), P([1, 0, 0], X), P([-1, 0, 0], X), P([0, 0, 1], X), P([0, 0, -1], X)],
    [-X, -1, -X], [X, 0.01, X],
  );
  const a = run('64Hz ', [floor], [0, 500, 0], null, TICK, 64);
  const b = run('144Hz', [floor], [0, 500, 0], null, FINE, 144);
  // 混合分区：交替 1/64 与 1/144×2，42 轮后再补一个 1/144（总时长 ≈ 1.2465 s，与其他两档
  // 不同长）；终态 `c` 未参与下面的差值输出——本段只演示"另一条划分"。
  const w = makeWorld([floor], [0, 500, 0], null);
  for (let i = 0; i < 42; i++) { w.tick(TICK, 0, 0, 0); w.tick(FINE, 0, 0, 0); w.tick(FINE, 0, 0, 0); }
  const c = w.tick(FINE, 0, 0, 0);
  const dy = Math.abs(a.posY - b.posY), dvy = Math.abs(a.velY - b.velY);
  console.log(`  → 64 vs 144：Δy=${dy.toExponential(2)}  Δvy=${dvy.toExponential(2)}（理论 y=100, vy=-800）`);
}

console.log('\n=== 实验②：60° 直坡滑行（surf，3s）分区等价性 ===');
{
  const th = Math.PI / 3; // 60°，normal.y=0.5 < 0.7 → 真 surf
  const brushes = [rampDown(th, 1000, 2500)];
  const surf = (z) => -z * Math.tan(th);
  const spawn = [0, surf(400) + 300, 400];
  const a = run('64Hz ', brushes, spawn, null, TICK, 192);
  const b = run('144Hz', brushes, spawn, null, FINE, 432);
  const dd = Math.hypot(a.posX - b.posX, a.posY - b.posY, a.posZ - b.posZ);
  const dv = Math.hypot(a.velX - b.velX, a.velY - b.velY, a.velZ - b.velZ);
  console.log(`  → 终态差：Δpos=${dd.toFixed(4)}u  Δvel=${dv.toFixed(4)}u/s`);
}

console.log('\n=== 实验③：坡顶入坡（凸角）— 平顶台 + 60° 下坡，500u/s 平飞，离角间隙扫描 ===');
{
  const th = Math.PI / 3;
  const brushes = [flatTop(0, 0, 2000), rampDown(th, 1200, 3000)];
  for (const h of [0.005, 0.01, 0.02, 0.05, 0.1, 0.3]) {
    console.log(`  -- 起跳脚底高于台面 ${h}u --`);
    run('64Hz ', brushes, [0, h, -3], [0, 0, 500], TICK, 128);
    run('144Hz', brushes, [0, h, -3], [0, 0, 500], FINE, 288);
  }
}

console.log('\n=== 实验④：坡底接缝（凹角）— 60° 坡滑入平地（4s）===');
{
  const th = Math.PI / 3;
  const zEnd = 1000 / Math.tan(th); // 坡面降到 y = −1000 处的 z 坐标
  // 见 `flatTop` 的注释：它的 AABB 从 `zEdge − 4000` 起，本次传 `zEdge = zEnd + 5000`
  // ⇒ 平顶块只被索引到 `z ≥ zEnd + 1000`，接缝之后那 1000 u 内该块不进候选。
  const brushes = [rampDown(th, zEnd, 2500), flatTop(-1000, zEnd + 5000, 3500)];
  const surf = (z) => -z * Math.tan(th);
  const spawn = [0, surf(300) + 300, 300];
  run('64Hz ', brushes, spawn, null, TICK, 256);
  run('144Hz', brushes, spawn, null, FINE, 576);
}

console.log('\n=== 实验⑤：V 形槽谷底横切（两壁 60°，沿壁下滑线直冲谷底棱，3s）===');
{
  const th = Math.PI / 3;
  const brushes = [grooveWall(th, 1), grooveWall(th, -1)];
  const wallY = (z) => z * Math.tan(th); // A 壁（z≥0）表面
  const spawn = [0, wallY(600) + 300, 600];
  run('64Hz ', brushes, spawn, null, TICK, 192);
  run('144Hz', brushes, spawn, null, FINE, 432);
}
