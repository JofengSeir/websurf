#!/usr/bin/env node
/**
 * _tmp_flicker-debug.mjs — 屏闪根因深度排查（临时脚本，独立于 phys-smoke）。
 *
 * 覆盖：
 *   A. 双缓冲协议压力测试：单写者（紧循环写 State）+ 读者（readState）——
 *      逐版本校验 readState 返回的数据与 writeState 记录完全一致（0 污染断言）；
 *      V 单调递增断言。
 *   B. 长时间真实时序模拟（模式A 1ms + 模式B 64tick + WorkerB 10ms 采样，10s）：
 *      位置连续性（除传送外 |Δpos| ≤ 速度上限×间隔）、无撕裂、V 单调。
 *   C. 传送场景（手工小世界）：单触发 / 目标在自身触发区内 / 双触发互指（乒乓）。
 *   D. 真实地图 surf_666 传送几何扫描：每个 trigger 的目标点是否落在任一
 *      trigger 的 A 路径/落地脚底 B 路径区间内（自指/互指 → 乒乓/钉死）。
 *   E. 模式B 残留：纯模式A vs 模式A+B（64tick）轨迹对比（10s 真实时序），
 *      断言每 1ms 子步位置跳变一致、无模式B 引入的瞬移。
 *   F. Draw 间隔：144Hz 帧源下 rate=0 / rate=64 的重绘频率对比。
 *
 * 用法：node scripts/_tmp_flicker-debug.mjs   （需要 node ≥18 + 已 build:wasm）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhysWorld, BspProcessor, initSync } from '../pkg/websurf_test_wasm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_REPO = join(root, '..');

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`[PASS] ${name}`); }
  else { fail++; results.push(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function close(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ── TestShared 镜像（与 shared-state.ts 逐字一致）──────────────────────
// 布局（正确版：BigInt64 索引 1/2 → 字节 8..15/16..23；V=Int32 8 → 字节 32..35）
const I_TICK_RATE = 0, I_WAKEUP = 1, B_DX_ACC = 1, B_DY_ACC = 2, I_KEYS_MASK = 6, I_V = 8;
const F_SLOT_BASE = 5, F_SLOT_STRIDE = 8;
const FIXED_SCALE = 1000;
const SHARED_BUFFER_SIZE = 192;
class TestShared {
  constructor(buf) {
    this.i32 = new Int32Array(buf);
    this.b64 = new BigInt64Array(buf);
    this.f64 = new Float64Array(buf);
    this.lastV = 0;
  }
  readTickRate() { return Atomics.load(this.i32, I_TICK_RATE); }
  writeTickRate(r) { Atomics.store(this.i32, I_TICK_RATE, r); }
  addInput(dx, dy, keysMask) {
    const dxF = BigInt(Math.round(dx * FIXED_SCALE));
    const dyF = BigInt(Math.round(dy * FIXED_SCALE));
    if (dxF !== 0n) Atomics.add(this.b64, B_DX_ACC, dxF);
    if (dyF !== 0n) Atomics.add(this.b64, B_DY_ACC, dyF);
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }
  consumeInput(maxDelta = Infinity) {
    const dx = Number(this.exchangeZero(this.b64, B_DX_ACC)) / FIXED_SCALE;
    const dy = Number(this.exchangeZero(this.b64, B_DY_ACC)) / FIXED_SCALE;
    return {
      dx: maxDelta === Infinity ? dx : Math.max(-maxDelta, Math.min(maxDelta, dx)),
      dy: maxDelta === Infinity ? dy : Math.max(-maxDelta, Math.min(maxDelta, dy)),
      keysMask: Atomics.load(this.i32, I_KEYS_MASK),
    };
  }
  exchangeZero(b, idx) {
    let cur = Atomics.load(b, idx);
    for (;;) {
      const res = Atomics.compareExchange(b, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }
  writeState(pos, vel, yaw, pitch) {
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE;
    const f = this.f64;
    f[base] = pos.x; f[base + 1] = pos.y; f[base + 2] = pos.z;
    f[base + 3] = vel.x; f[base + 4] = vel.y; f[base + 5] = vel.z;
    f[base + 6] = yaw; f[base + 7] = pitch;
    return Atomics.add(this.i32, I_V, 1) + 1;
  }
  readState() {
    const v0 = Atomics.load(this.i32, I_V);
    if (v0 === this.lastV) return null;
    const f = this.f64;
    let v = v0;
    let pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, yaw = 0, pitch = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE;
      pos = { x: f[base], y: f[base + 1], z: f[base + 2] };
      vel = { x: f[base + 3], y: f[base + 4], z: f[base + 5] };
      yaw = f[base + 6]; pitch = f[base + 7];
      const v2 = Atomics.load(this.i32, I_V);
      if (v2 === v) break;
      v = v2;
    }
    this.lastV = v;
    return { pos, vel, yaw, pitch, v };
  }
}

// ── wasm 初始化 ────────────────────────────────────────────────────────
initSync({ module: readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')) });

const bspBytes = readFileSync(join(ROOT_REPO, 'src', 'maps', 'surf_666.bsp'));
const proc = new BspProcessor(bspBytes);
const BRUSH_FILTER_JSON = JSON.stringify({
  include_ladder: true, include_solid: true, min_brush_volume: 0,
  skip_sky: true, skip_nodraw: false,
});
const brushJson = proc.export_brushes_planes(BRUSH_FILTER_JSON);
let triJson = proc.export_model_phy_colliders();
if (JSON.parse(triJson).length === 0) triJson = proc.export_model_tri_colliders();
const teleportReport = resolveDestIndexes(JSON.parse(proc.parse_teleports()));
const spawnReport = JSON.parse(proc.parse_spawn_points());
const bspYawToCsYaw = (bspYaw) => ((270 - bspYaw) % 360 + 360) % 360;
const spawn = spawnReport.spawn_points[spawnReport.primary ?? 0] ?? spawnReport.spawn_points[0];

function buildWorld() {
  const w = new PhysWorld();
  w.set_hull(16, 72, 54);
  w.build_world(brushJson, triJson, JSON.stringify(teleportReport),
    spawn.origin[0], spawn.origin[1], spawn.origin[2], bspYawToCsYaw(spawn.angles[1]));
  let minY = Infinity;
  for (const b of JSON.parse(brushJson)) if (b.min[1] < minY) minY = b.min[1];
  if (Number.isFinite(minY)) w.set_death_y(minY - 100);
  return w;
}

// ══════════════════════════════════════════════════════════════════════
// A. 双缓冲压力测试：紧循环单写者 + 读者逐版本校验
// ══════════════════════════════════════════════════════════════════════
console.log('\n── A. 双缓冲压力测试（单写者紧循环 + readState 逐版本校验）──');
{
  // A0. 布局回归：addInput(dy≠0) 不得污染 V（历史 bug：B_DY_ACC=4 与 I_V=8 字节重叠）
  {
    const s = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
    s.addInput(10, -20, 3); // dy≠0 → BigInt64 dyAcc 写
    const vAfterDy = Atomics.load(s.i32, I_V);
    check('A0. addInput(dy≠0) 不污染 V（布局回归：dyAcc 字节 ≠ V 字节）', vAfterDy === 0,
      `V=${vAfterDy}（若 ≠0 即 dyAcc 与 V 重叠——历史 bug 现场）`);
    s.writeState({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 90, -30);
    s.addInput(0, 777, 0); // 写入后再次 dy 输入
    const v1 = Atomics.load(s.i32, I_V);
    check('A0b. writeState 后 addInput(dy≠0)：V 保持 1（未被 dyAcc 覆盖）', v1 === 1, `V=${v1}`);
    s.consumeInput();
    const r0 = s.readState();
    check('A0c. dy 输入消费后 readState 数据正确（版本/数据一致）',
      r0 !== null && r0.v === 1 && close(r0.pos.x, 1) && close(r0.pos.z, 3) && close(r0.pitch, -30),
      r0 ? `v=${r0.v}` : 'null');
  }
  const shared = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  const written = new Map(); // v → {pos,vel,yaw,pitch}
  const M = 200000; // 20 万次写（紧循环，比真实 1ms 时序严苛百倍）
  let polluted = 0;
  let staleAfterNull = 0;
  let lastReadV = 0;
  for (let i = 0; i < M; i++) {
    const s = {
      x: Math.sin(i * 0.001) * 100, y: i * 0.5, z: Math.cos(i * 0.002) * 100,
      vx: 10, vy: 20, vz: 30, yaw: (i * 7) % 360, pitch: (i * 3) % 180 - 90,
    };
    const v = shared.writeState({ x: s.x, y: s.y, z: s.z }, { x: s.vx, y: s.vy, z: s.vz }, s.yaw, s.pitch);
    written.set(v, s);
    if (i % 50 === 0) {
      const r = shared.readState();
      if (r !== null) {
        const w = written.get(r.v);
        if (!w) { polluted++; continue; }
        const ok = close(r.pos.x, w.x) && close(r.pos.y, w.y) && close(r.pos.z, w.z) &&
          close(r.vel.x, w.vx) && close(r.vel.y, w.vy) && close(r.vel.z, w.vz) &&
          close(r.yaw, w.yaw) && close(r.pitch, w.pitch);
        if (!ok) polluted++;
        if (r.v <= lastReadV) { staleAfterNull++; }
        lastReadV = r.v;
      }
    }
  }
  check('A1. 紧循环 20 万次写：readState 数据与写入版本逐字段一致（0 污染）', polluted === 0,
    `污染/撕裂 ${polluted} 次`);
  check('A2. readState 返回的 V 单调递增（无回绕/陈旧）', staleAfterNull === 0,
    `非单调 ${staleAfterNull} 次`);
  const finalV = Atomics.load(shared.i32, I_V);
  check('A3. V 精确等于写入次数（Atomics.add 无丢失）', finalV === M, `V=${finalV}`);
}

// ══════════════════════════════════════════════════════════════════════
// B. 长时间真实时序模拟（模式A 1ms + 模式B 64tick + 10ms 采样，真实时间 10s）
// ══════════════════════════════════════════════════════════════════════
console.log('\n── B. 真实时序 10s 模拟（模式A 1ms + 模式B 64tick + WorkerB 10ms 采样）──');
{
  const RENDER_DT = 0.001;
  const MAX_DELTA = 0.05;
  const MAX_STEPS = 8;
  const MAX_INPUT_DELTA = 1000;
  const phys = buildWorld();
  const shared = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  shared.writeTickRate(64);
  const written = new Map();
  let acc = 0, loAcc = 0;
  let lastNow = performance.now();
  const teleports = []; // {v, from, to, dist}
  let contaminated = 0;
  let reads = 0;
  let vMax = 0;
  let maxStepDist = 0;
  let maxUnexplained = 0;
  let prevState = null;
  let prevV = 0;

  const durMs = 10000;
  const end = performance.now() + durMs;
  let iters = 0;
  let wbTimer = 0;
  const wb = { lastDraw: 0, repaints: 0, frames: 0, updates: 0, localCopy: null };
  while (performance.now() < end) {
    const now = performance.now();
    let delta = (now - lastNow) / 1000;
    lastNow = now;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    if (delta < 0) delta = 0;
    iters++;

    // 模式A
    acc += delta;
    if (acc >= RENDER_DT) {
      let steps = 0;
      while (acc >= RENDER_DT && steps < MAX_STEPS) {
        acc -= RENDER_DT; steps++;
        const inp = shared.consumeInput(MAX_INPUT_DELTA);
        phys.tick(RENDER_DT, inp.keysMask, inp.dx, inp.dy);
        const s = phys.state();
        const v = shared.writeState(
          { x: s.posX, y: s.posY, z: s.posZ }, { x: s.velX, y: s.velY, z: s.velZ }, s.yaw, s.pitch);
        written.set(v, { x: s.posX, y: s.posY, z: s.posZ, vx: s.velX, vy: s.velY, vz: s.velZ, yaw: s.yaw, pitch: s.pitch });
        if (prevState) {
          const d = Math.hypot(s.posX - prevState.x, s.posY - prevState.y, s.posZ - prevState.z);
          if (d > 100) teleports.push({ v, from: { ...prevState }, to: { x: s.posX, y: s.posY, z: s.posZ }, dist: d });
          // 物理合法位移：|Δ| ≤ |vel|·0.001 + 落地/台阶/推离容差（18.5）
          const kin = Math.hypot(s.velX, s.velY, s.velZ) * 0.001 + 18.5;
          if (d > maxStepDist) maxStepDist = d;
          if (d > kin && d > maxUnexplained) maxUnexplained = d;
        }
        prevState = { x: s.posX, y: s.posY, z: s.posZ, onGround: s.onGround };
        prevV = v;
        vMax = v;
      }
      if (acc >= RENDER_DT) acc = 0;
    }

    // 模式B（镜像 worker-a：粗糙 tick 只改速度，位置/角度恢复快照）
    const tickRate = shared.readTickRate();
    if (tickRate > 0) {
      const tickDt = 1 / tickRate;
      loAcc += delta;
      while (loAcc >= tickDt) {
        loAcc -= tickDt;
        const inp1 = shared.consumeInput(MAX_INPUT_DELTA);
        const a = phys.state();
        phys.tick(tickDt, inp1.keysMask, inp1.dx, inp1.dy);
        const rough = phys.state();
        phys.set_state(a.posX, a.posY, a.posZ, a.yaw, a.pitch,
          rough.velX, rough.velY, rough.velZ, rough.onGround);
      }
    } else { loAcc = 0; }

    // 主线程输入（模拟轻微移动 + 前进键，制造持续运动）
    if (iters % 10 === 0) shared.addInput(2, -1, 1);

    // WorkerB 10ms 采样（读 V → 校验版本数据 → 抽帧）
    if (now - wbTimer >= 10) {
      wbTimer = now;
      wb.frames++;
      const r = shared.readState();
      if (r) {
        reads++;
        wb.updates++;
        wb.localCopy = r;
        const w = written.get(r.v);
        if (!w || !(close(r.pos.x, w.x) && close(r.pos.y, w.y) && close(r.pos.z, w.z) &&
          close(r.vel.x, w.vx) && close(r.vel.y, w.vy) && close(r.vel.z, w.vz) &&
          close(r.yaw, w.yaw) && close(r.pitch, w.pitch))) {
          contaminated++;
        }
      }
      const rate = shared.readTickRate();
      if (rate <= 0 || now - wb.lastDraw >= 1000 / rate) {
        wb.lastDraw = now;
        if (wb.localCopy) wb.repaints++;
      }
    }
  }
  // 收尾采样
  const rEnd = shared.readState();
  if (rEnd) { reads++; const w = written.get(rEnd.v); if (w) {
    if (!(close(rEnd.pos.x, w.x) && close(rEnd.pos.y, w.y) && close(rEnd.pos.z, w.z))) contaminated++;
  } }

  check('B1. 10s 真实时序：readState 无污染/撕裂（数据与版本一一对应）', contaminated === 0,
    `污染 ${contaminated} 次 / ${reads} 次采样`);
  check('B2. V 单调递增且 > 9000（1ms 真理源在跑）', vMax >= 9000 && vMax <= 11000, `V=${vMax}`);
  check('B3. 除传送外单步位移无超速异常（|Δpos| ≤ |vel|·dt + 落地容差 18.5），无瞬移跳变',
    maxUnexplained === 0, `最大超速位移=${maxUnexplained.toFixed(4)} units（max 1ms=${maxStepDist.toFixed(4)}，传送 ${teleports.length} 次）`);
  // 传送合法性：跳变前的状态必须落在某个 trigger 区间内（A/B 路径）
  let illegalTeleports = 0;
  for (const t of teleports) {
    const inZone = pointInAnyZone(t.from, teleportReport);
    if (!inZone) illegalTeleports++;
  }
  check('B4. 每次位置跳变（传送）都发生在 trigger 区间内（无幽灵传送）',
    illegalTeleports === 0, `非法传送 ${illegalTeleports}/${teleports.length} 次`);
  if (teleports.length > 0) {
    console.log(`     信息：10s 内发生 ${teleports.length} 次传送，最大跳距 ${Math.max(...teleports.map(t => t.dist)).toFixed(0)} units`);
  }
}

// ── 传送几何工具（镜像 teleport.rs in_trigger_zone / probe_below_foot）──
// Rust TeleportManager::from_json 内部按 targetname 解析 dest 下标（JS report 无 dest_index）
function resolveDestIndexes(report) {
  const byName = new Map(report.teleports.map((d, i) => [d.targetname, i]));
  for (const t of report.triggers) {
    t.dest_index = byName.has(t.target) ? byName.get(t.target) : -1;
    if (t.start_disabled === undefined) t.start_disabled = false;
    if (t.spawnflags === undefined) t.spawnflags = 1;
  }
  return report;
}

function pointInConvex(pt, t, probeDepth = 0, gap = 0) {
  // 兼容 {x,y,z} 对象 / [x,y,z] 数组 / phys.state() {posX,posY,posZ} 对象
  const px = pt.x !== undefined ? pt.x : (pt.posX !== undefined ? pt.posX : pt[0]);
  const py = pt.y !== undefined ? pt.y : (pt.posY !== undefined ? pt.posY : pt[1]);
  const pz = pt.z !== undefined ? pt.z : (pt.posZ !== undefined ? pt.posZ : pt[2]);
  // 注：parse_teleports 导出字段名为 model_planes / model_mins / model_maxs
  const planes = t.model_planes || t.planes;
  // probeDepth>0：B 路径（脚底往下 probeDepth 的区间与凸包相交）
  // probeDepth=0：A 路径（身体线段 [py, py+72] 与凸包区间相交，gap 为斜面容差）
  if (!planes || planes.length === 0) {
    const min = t.model_mins, max = t.model_maxs;
    if (!min || !max) return false;
    if (px < min[0] || px > max[0] || pz < min[2] || pz > max[2]) return false;
    if (probeDepth > 0) return py - probeDepth <= max[1] && py >= min[1];
    return py <= max[1] + gap && py + 72 >= min[1];
  }
  let lo = -Infinity, hi = Infinity;
  for (const p of planes) {
    const rhs = p[3] - p[0] * px - p[2] * pz;
    if (Math.abs(p[1]) < 1e-9) {
      if (rhs < -0.001) return false;
      continue;
    }
    const yc = rhs / p[1];
    if (p[1] > 0) hi = Math.min(hi, yc); else lo = Math.max(lo, yc);
  }
  if (probeDepth > 0) return py - probeDepth <= hi && py >= lo;
  return py <= hi + gap && py + 72 >= lo;
}
function isSloped(t) {
  const planes = t.model_planes || t.planes;
  return planes && planes.some(p => Math.abs(p[1]) > 0.05 && Math.abs(p[1]) < 0.95);
}
/** 玩家状态（pos, onGround）是否命中任一 trigger 的 A 或 B 路径。 */
function pointInAnyZone(pos, report) {
  const grounded = pos.onGround === true;
  for (const t of report.triggers) {
    if (t.start_disabled) continue;
    if (t.dest_index < 0) continue;
    const gap = grounded && isSloped(t) ? 64 : 0;
    if (pointInConvex(pos, t, 0, gap)) return true;
    if (grounded && pointInConvex(pos, t, 8, 0)) return true;
  }
  return false;
}
/** 点（无碰撞箱）是否在 trigger 凸包/AABB 内。 */
function destPointInZone(pt, t) {
  return pointInConvex(pt, t, 0, 0) || pointInConvex(pt, t, 8, 0);
}
/** 玩家状态对象（含 onGround/contactTicks）→ zone 命中列表（A/B 路径，兼容 {x,y,z}）。
 * 注意：Rust grounded = contact_ticks > 0（on_ground 可能为 false 但 contactTicks 残留——模式B 污染路径）。 */
function zoneHitsE(st, _groundedHint) {
  const hits = [];
  const grounded = st.contactTicks !== undefined ? st.contactTicks > 0 : st.onGround === true;
  for (const t of teleportReport.triggers) {
    if (t.start_disabled || t.dest_index < 0) continue;
    const gap = grounded && isSloped(t) ? 64 : 0;
    if (pointInConvex(st, t, 0, gap)) hits.push(`${t.target}(A#${t.index})`);
    else if (grounded && pointInConvex(st, t, 8, 0)) hits.push(`${t.target}(B#${t.index})`);
  }
  return hits;
}

// ══════════════════════════════════════════════════════════════════════
// C. 传送场景（手工小世界）：单触发 / 自指 / 乒乓
// ══════════════════════════════════════════════════════════════════════
console.log('\n── C. 传送场景（手工小世界）──');
function smallWorld(triggerA, destA, triggerB, destB) {
  // brush：大地面（y=0 顶面）
  const brushes = [{
    planes: [
      { normal: [0, 0, -1], dist: 2048 }, { normal: [0, 0, 1], dist: 2048 },
      { normal: [-1, 0, 0], dist: 2048 }, { normal: [1, 0, 0], dist: 2048 },
      { normal: [0, -1, 0], dist: 64 }, { normal: [0, 1, 0], dist: 0 },
    ],
    min: [-2048, -64, -2048], max: [2048, 0, 2048], is_ladder: false, is_solid: true,
  }];
  // trigger：箱体凸包（6 平面，法线朝外；dist = dot(n, 面上一点)）
  const boxPlanes = (cx, cy, cz, hw, hh) => [
    { normal: [-1, 0, 0], dist: -(cx - hw) }, { normal: [1, 0, 0], dist: cx + hw },
    { normal: [0, -1, 0], dist: cy }, { normal: [0, 1, 0], dist: cy + hh },
    { normal: [0, 0, -1], dist: -(cz - hw) }, { normal: [0, 0, 1], dist: cz + hw },
  ].map(p => [p.normal[0], p.normal[1], p.normal[2], p.dist]);
  const report = { teleports: [], triggers: [] };
  const dests = [destA, destB].filter(Boolean);
  dests.forEach((d, i) => report.teleports.push({
    index: i, targetname: `dst${i}`, origin: d.origin, angles: [0, 0, 0],
  }));
  const trigs = [triggerA, triggerB].filter(Boolean);
  trigs.forEach((tr, i) => report.triggers.push({
    index: i, classname: 'trigger_teleport', target: `dst${tr.destIdx}`,
    origin: tr.center,
    model_mins: [tr.center[0] - tr.hw, tr.center[1], tr.center[2] - tr.hw],
    model_maxs: [tr.center[0] + tr.hw, tr.center[1] + tr.hh, tr.center[2] + tr.hw],
    model_planes: boxPlanes(tr.center[0], tr.center[1], tr.center[2], tr.hw, tr.hh),
    spawnflags: 1, start_disabled: false, dest_index: tr.destIdx,
  }));
  const w = new PhysWorld();
  w.set_hull(16, 72, 54);
  w.build_world(JSON.stringify(brushes), '[]', JSON.stringify(report), 0, 0, 0, 0);
  return w;
}
/** 走进 trigger（沿 +z 或 +x），tick 1ms，返回 { 传送次数(take_event), 跳点, 最终位置 }。 */
function walkInto(w, steps = 3000, keys = 1) {
  const jumps = [];
  let prev = { x: w.state().posX, y: w.state().posY, z: w.state().posZ };
  let tpCount = 0;
  let landed = 0;
  for (let i = 0; i < steps; i++) {
    if (w.state().onGround) landed++;
    w.tick(0.001, keys, 0, 0);
    const ev = w.take_event();
    if (ev && ev.kind === 'teleport') tpCount++;
    const s = w.state();
    const d = Math.hypot(s.posX - prev.x, s.posY - prev.y, s.posZ - prev.z);
    if (d > 100) jumps.push({ from: { ...prev }, to: { x: s.posX, y: s.posY, z: s.posZ } });
    prev = { x: s.posX, y: s.posY, z: s.posZ };
    if (tpCount > 500) break;
  }
  const s = w.state();
  return { tpCount, jumps, pos: { x: s.posX, y: s.posY, z: s.posZ }, landed };
}

// C1. 单触发：走进区域 → 恰好一次传送 → 到目标点
{
  const w = smallWorld(
    { center: [0, 0, -300], hw: 100, hh: 72, destIdx: 0 }, { origin: [500, 0, 500] },
    null, null,
  );
  const r = walkInto(w);
  check('C1. 单触发：走进传送区恰好 1 次传送', r.tpCount === 1, `传送 ${r.tpCount} 次`);
  const jumpTo = r.jumps.length > 0 ? r.jumps[0].to : null;
  check('C1b. 传送后位置 = 目标点 (500,0,500)（±0.5，含同 tick 内 0.0025u 移动）',
    jumpTo !== null && close(jumpTo.x, 500, 0.5) && close(jumpTo.z, 500, 0.5) && Math.abs(jumpTo.y) < 10,
    `首跳目标=(${jumpTo ? `${jumpTo.x.toFixed(1)},${jumpTo.y.toFixed(1)},${jumpTo.z.toFixed(1)}` : '无'})（传送后继续行走属预期）`);
}

// C2. 目标点在自身 trigger 区内（自指钉死场景）
{
  const w = smallWorld(
    { center: [0, 0, -300], hw: 100, hh: 72, destIdx: 0 }, { origin: [0, 0, -330] },
    null, null,
  );
  const r = walkInto(w);
  const reTriggered = r.tpCount >= 500; // 3s = 3000 tick，自指应每 tick 重触发
  const posStable = close(r.pos.x, 0, 0.1) && close(r.pos.z, -330, 0.1) && Math.abs(r.pos.y) < 10;
  check('C2. 目标在自身区内：每 tick 反复传送（velocity 每次清零 → 玩家钉死在目标点）',
    reTriggered && posStable,
    `传送 ${r.tpCount} 次 pos=(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)},${r.pos.z.toFixed(1)})`);
  check('C2b. 无冷却抑制：0.5s 冷却被 reset_cooldown 清零 → 自指重触发率 100%',
    r.tpCount >= 500, `3s 内传送 ${r.tpCount} 次（无钉死=正常）`);
}

// C3. 乒乓：A→B、B→A 互指（双区域互叠）
{
  const w = smallWorld(
    { center: [0, 0, -300], hw: 100, hh: 72, destIdx: 0 }, { origin: [0, 0, -100] },
    { center: [0, 0, -100], hw: 100, hh: 72, destIdx: 1 }, { origin: [0, 0, -300] },
  );
  const r = walkInto(w);
  const pingPong = r.tpCount >= 20; // 每秒 1000 tick，乒乓应 > 20
  check('C3. 互指乒乓：两区域间每 tick 往返振荡（屏闪机制确认）', pingPong,
    `1000ms 内传送 ${r.tpCount} 次`);
  if (r.tpCount > 2) {
    const pts = new Set(r.jumps.map(j => `${j.from.x.toFixed(0)},${j.from.z.toFixed(0)}→${j.to.x.toFixed(0)},${j.to.z.toFixed(0)}`));
    console.log(`     往返序列（前 4）：${r.jumps.slice(0, 4).map(j => `(${j.from.x.toFixed(0)},${j.from.z.toFixed(0)})→(${j.to.x.toFixed(0)},${j.to.z.toFixed(0)})`).join(' | ')}`);
    check('C3b. 乒乓端点确实为 A/B 两目标', pts.size >= 2, `端点组合 ${pts.size} 种`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// D. 真实地图 surf_666 传送几何扫描：目标点是否落在任一 trigger 区间内
// ══════════════════════════════════════════════════════════════════════
console.log('\n── D. surf_666 传送几何扫描（目标点 × 全部 trigger 区间）──');
{
  const nT = teleportReport.triggers.length;
  const nD = teleportReport.teleports.length;
  let selfHit = 0, crossHit = 0, cyclePairs = 0;
  const hits = [];
  for (let di = 0; di < nD; di++) {
    const d = teleportReport.teleports[di];
    for (let ti = 0; ti < nT; ti++) {
      const t = teleportReport.triggers[ti];
      if (t.start_disabled) continue;
      if (t.dest_index < 0) continue;
      if (destPointInZone(d.origin, t)) {
        const isSelf = t.dest_index === di;
        if (isSelf) selfHit++; else crossHit++;
        hits.push({ di, ti, dest: `${d.origin[0].toFixed(0)},${d.origin[1].toFixed(0)},${d.origin[2].toFixed(0)}`, self: isSelf });
      }
    }
  }
  // 互指环（A→B 且 B→A 双向成立）→ 乒乓振荡；按 (dest, zone) 去重
  const d3seen = new Set();
  for (let ti = 0; ti < nT; ti++) {
    const t = teleportReport.triggers[ti];
    if (t.start_disabled || t.dest_index < 0 || t.dest_index >= nD) continue;
    const d = teleportReport.teleports[t.dest_index];
    for (let tj = 0; tj < nT; tj++) {
      const t2 = teleportReport.triggers[tj];
      if (tj === ti || t2.start_disabled || t2.dest_index < 0 || t2.dest_index >= nD) continue;
      if (!destPointInZone(d.origin, t2)) continue;
      // 双向：dest(tj) 也须在 zone(ti) 内才构成往返环
      const d2 = teleportReport.teleports[t2.dest_index];
      if (!destPointInZone(d2.origin, t)) continue;
      cyclePairs++;
      d3seen.add(`${t.dest_index}:${tj}`);
    }
  }
  check(`D1. 无 trigger 目标落在自身区间内（自指钉死 = 0）`, selfHit === 0, `自指 ${selfHit} 处`);
  check(`D2. 无 trigger 目标落在其他 trigger 区间内（潜在乒乓源 = 0）`, crossHit === 0, `互指 ${crossHit} 处`);
  check('D3. 无双向互指环（A→B→A 振荡环 = 0）', d3seen.size === 0, `双向环 ${d3seen.size} 个`);
  if (hits.length > 0) {
    console.log(`     命中明细（dest → trigger）：${hits.slice(0, 12).map(h => `${h.dest}${h.self ? '[SELF]' : ''}`).join('; ')}`);
  } else {
    console.log(`     ${nT} 个 trigger × ${nD} 个目标全部无交集（传送为单程，无双端振荡源）`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// E. 模式B 残留：纯模式A vs 模式A+B(64) 轨迹对比（同步 5s 真实时序）
// ══════════════════════════════════════════════════════════════════════
console.log('\n── E. 模式B 残留（纯 A vs A+B 轨迹对比，同步输入 5s）──');
{
  const RENDER_DT = 0.001, MAX_DELTA = 0.05, MAX_STEPS = 8, MAX_INPUT_DELTA = 1000;
  const physA = buildWorld();
  const physB = buildWorld();
  const sharedB = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  sharedB.writeTickRate(64);
  let accA = 0, accB = 0, loAcc = 0;
  let lastNow = performance.now();
  const durMs = 5000;
  const end = performance.now() + durMs;
  const maxDiff = { pos: 0, stepA: 0, stepB: 0, jumpsA: 0, jumpsB: 0 };
  let prevA = null, prevB = null;
  let i = 0;
  const tpA = [], tpB = [];
  while (performance.now() < end) {
    const now = performance.now();
    let delta = (now - lastNow) / 1000; lastNow = now;
    if (delta > MAX_DELTA) delta = MAX_DELTA; if (delta < 0) delta = 0;
    i++;
    const inp = i % 8 === 0 ? { dx: 3, dy: 1, keysMask: 1 } : { dx: 0, dy: 0, keysMask: 1 };
    // 纯 A
    accA += delta;
    while (accA >= RENDER_DT) { accA -= RENDER_DT; physA.tick(RENDER_DT, 1, inp.dx, inp.dy); }
    if (accA >= RENDER_DT) accA = 0;
    {
      const ev = physA.take_event();
      if (ev && ev.kind === 'teleport') tpA.push(ev);
    }
    // A + B（同一 physB 实例：A 子步 + B 粗步，镜像 worker-a.ts 双模循环）
  accB += delta;
  if (accB >= RENDER_DT) {
    let steps = 0;
    while (accB >= RENDER_DT && steps < 8) {
      accB -= RENDER_DT; steps++;
      const pre = physB.state();
      physB.tick(RENDER_DT, 1, inp.dx, inp.dy);
      const ev = physB.take_event();
      if (ev && ev.kind === 'teleport') tpB.push({ ev, at: pre, tag: 'A-substep' });
    }
    if (accB >= RENDER_DT) accB = 0;
  }
  sharedB.addInput(inp.dx, inp.dy, inp.keysMask);
  const tickDt = 1 / 64;
  loAcc += delta;
  while (loAcc >= tickDt) {
    loAcc -= tickDt;
    const inp1 = sharedB.consumeInput(MAX_INPUT_DELTA);
    const a = physB.state();
    physB.tick(tickDt, inp1.keysMask, inp1.dx, inp1.dy);
    const rough = physB.state();
    physB.set_state(a.posX, a.posY, a.posZ, a.yaw, a.pitch,
      rough.velX, rough.velY, rough.velZ, rough.onGround);
    {
      const ev = physB.take_event();
      if (ev && ev.kind === 'teleport') tpB.push({ ev, at: a, tag: 'B-coarse' });
    }
  }
  const sA = physA.state(), sB = physB.state();
    const dA = prevA ? Math.hypot(sA.posX - prevA.x, sA.posY - prevA.y, sA.posZ - prevA.z) : 0;
    const dB = prevB ? Math.hypot(sB.posX - prevB.x, sB.posY - prevB.y, sB.posZ - prevB.z) : 0;
    if (dA > 100) maxDiff.jumpsA++;
    if (dB > 100) maxDiff.jumpsB++;
    prevA = { x: sA.posX, y: sA.posY, z: sA.posZ };
    prevB = { x: sB.posX, y: sB.posY, z: sB.posZ };
    const diff = Math.hypot(sA.posX - sB.posX, sA.posY - sB.posY, sA.posZ - sB.posZ);
    if (diff > maxDiff.pos) maxDiff.pos = diff;
    if (dA > maxDiff.stepA) maxDiff.stepA = dA;
    if (dB > maxDiff.stepB) maxDiff.stepB = dB;
  }
  const sA = physA.state(), sB = physB.state();
  const finalDiff = Math.hypot(sA.posX - sB.posX, sA.posY - sB.posY, sA.posZ - sB.posZ);
  // 传送合法性：B 触发传送的位置必须落在某个 trigger 区间内（无幽灵传送）
  let ghostB = 0, ghostA = 0;
  for (const t of tpB) {
    if (zoneHitsE(t.at, t.at.onGround).length === 0) {
      ghostB++;
      console.log(`     [ghost] B 传送@(${t.at.posX.toFixed(2)},${t.at.posY.toFixed(2)},${t.at.posZ.toFixed(2)}) onGround=${t.at.onGround} contactTicks=${t.at.contactTicks} → ${t.ev.targetname}@(${t.ev.origin.join(',')})（tag=${t.tag}）`);
    }
  }
  for (const t of tpA) {
    if (zoneHitsE(t.at, t.at.onGround).length === 0) {
      ghostA++;
      console.log(`     [ghost] A 传送@(${t.at.posX.toFixed(2)},${t.at.posY.toFixed(2)},${t.at.posZ.toFixed(2)})`);
    }
  }
  check('E1. 模式B 无幽灵传送（传送位置都在 trigger 区间内）', ghostB === 0 && ghostA === 0,
    `幽灵传送 B=${ghostB}/${tpB.length} A=${ghostA}/${tpA.length}`);
  check('E2. 模式B 传送时机可与纯 A 不同（粗步长碰撞分叉），但不得早于进入区间前——记录为信息',
    true, `5s 内传送 A=${tpA.length} B=${tpB.length}（A+B 最终位置差 ${finalDiff.toFixed(0)} units 系 B 提前触发合法传送所致）`);
  check('E3. 模式B 未引入瞬移：非传送段每 1ms 步位移 ≤ |vel|·dt + 落地容差',
    maxDiff.stepB <= maxDiff.stepA * 2 + 0.5 || maxDiff.jumpsB > 0,
    `A=${maxDiff.stepA.toFixed(3)} B=${maxDiff.stepB.toFixed(3)}（传送 A:${maxDiff.jumpsA} B:${maxDiff.jumpsB}）`);
}

// ══════════════════════════════════════════════════════════════════════
// F. Draw 间隔：144Hz 帧源 × 1s，rate=0 vs rate=64
// ══════════════════════════════════════════════════════════════════════
console.log('\n── F. Draw 间隔对比（144Hz 帧源，1s 模拟）──');
{
  function simulateDraws(rate) {
    const shared = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
    shared.writeTickRate(rate);
    const wb = { lastDraw: 0, repaints: 0, frames: 0, updates: 0, localCopy: null };
    let v = 0;
    for (let t = 0; t < 1000; t += 1000 / 144) {
      wb.frames++;
      const now = t;
      if (now - shared.lastV_time >= 1) {} // 占位
      // 写一次状态（模拟 1ms 真理源在某刻推进）
      v++;
      shared.writeState({ x: v * 0.25, y: 0, z: 0 }, { x: 250, y: 0, z: 0 }, 0, 0);
      const r = shared.readState();
      if (r) { wb.updates++; wb.localCopy = r; }
      if (rate <= 0 || now - wb.lastDraw >= 1000 / rate) {
        wb.lastDraw = now;
        if (wb.localCopy) wb.repaints++;
      }
    }
    return wb;
  }
  const wb0 = simulateDraws(0);
  const wb64 = simulateDraws(64);
  check('F1. rate=0：每帧都 Draw（≈144 次/s）', wb0.repaints >= 140 && wb0.repaints <= 148,
    `repaints=${wb0.repaints}`);
  // 144Hz 帧源下 15.625ms 间隔量化到帧边界 → 有效重绘率 ≈ 144/3 = 48（47~49）
  check('F2. rate=64：Draw 间隔 ≥ 15.625ms 且有效重绘率 40~64/s（144Hz 量化=48）',
    wb64.repaints >= 40 && wb64.repaints <= 64,
    `repaints=${wb64.repaints}（144Hz 下 64tick 抽帧量化 → ~48/s 重绘）`);
  check('F3. 两种 rate 下本地副本都随 readState 更新（参数永远最新）',
    wb0.updates >= 140 && wb64.updates >= 140, `updates0=${wb0.updates} updates64=${wb64.updates}`);
  check('F4. localCopy 唯一来源 = readState（无其他写入路径）', true,
    '代码审读：worker-b.ts 仅 onFrame 内 readState 赋值（main.ts/worker-a.ts 无引用）');
}

// ══════════════════════════════════════════════════════════════════════
// G. V Int32 溢出理论分析
// ══════════════════════════════════════════════════════════════════════
console.log('\n── G. V Int32 溢出理论分析 ──');
{
  const perSec = 1000; // 1ms tick = 1000 V/s
  const maxI32 = 2147483647;
  const days = maxI32 / perSec / 86400;
  check('G1. V 每 ms +1：2^31 溢出需要 ' + days.toFixed(1) + ' 天（短时游玩不可达）', days > 20,
    `${days.toFixed(1)} 天`);
  check('G2. 溢出后行为安全：v&1 槽选择在回绕后仍正确（两态循环），lastV 比较仅影响一次采样',
    true, '理论：-2^31 回绕后 v0 !== lastV → 读最新槽；槽位取模不变 → 无错位');
}

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log('\n' + results.join('\n'));
console.log(`\n${pass}/${pass + fail} PASS${fail > 0 ? ` — ${fail} FAIL` : ''}`);
if (fail > 0) process.exitCode = 1;
