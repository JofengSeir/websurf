#!/usr/bin/env node
/**
 * WebSurf-test — 性能基准（node 可跑，复用 pkg wasm；针对评审 A 节质疑的实测校验）。
 *
 * 用法：node scripts/perf-bench.mjs
 *
 * 基准 1（1ms 子步预算）：surf_666 真实世界 1ms 子步耗时（avg/p50/p95/max）——
 *   "WorkerA 能否稳定维持 1000Hz 发布率"（p95 < 1000µs 即可持续）
 * 基准 2（零分配主张差分）：同一世界下两条热路径——
 *   oldPath = tick()（wasm→JS 11 属性对象）+ writeState（Vec3 对象）
 *   newPath = tick_into()（wasm 固定缓冲）+ writeStateRaw（标量直写 SAB）
 *   小世界（物理 ~µs 级，对象构造占主导）与 surf_666（物理占主导）各测一次——
 *   回答"每子步零 JS 对象分配"到底省多少
 * 基准 3（对象构造开销模型）：11×Reflect.set vs 8×SAB Float64 写 vs 8×视图读——
 *   回答"直写 SAB 与 Reflect.set 是否一个量级"
 *
 * 注：与 phys-smoke.mjs 同为镜像风格（TestShared 布局/常量在此复制，改动须同步）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhysWorld, BspProcessor, initSync } from '../pkg/websurf_test_wasm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nowNs = () => process.hrtime.bigint();

// ── 断言/输出工具 ────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── TestShared 镜像（shared-state.ts 布局/协议；bench 仅需 consumeInput/writeState/writeStateRaw）──
const I_TICK_RATE = 0;
const I_WAKEUP = 1;
const B_DX_ACC = 1;
const B_DY_ACC = 2;
const I_KEYS_MASK = 6;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const FIXED_SCALE = 1000;
const SHARED_BUFFER_SIZE = 192;

class TestShared {
  constructor(buf) {
    this.i32 = new Int32Array(buf);
    this.b64 = new BigInt64Array(buf);
    this.f64 = new Float64Array(buf);
    this.lastV = 0;
  }
  consumeInput(maxDelta = Infinity) {
    const dxFixed = this.exchangeZero(this.b64, B_DX_ACC);
    const dyFixed = this.exchangeZero(this.b64, B_DY_ACC);
    let dx = Number(dxFixed) / FIXED_SCALE;
    let dy = Number(dyFixed) / FIXED_SCALE;
    if (maxDelta !== Infinity) {
      dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
      dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
    }
    return { dx, dy, keysMask: Atomics.load(this.i32, I_KEYS_MASK) };
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
    return this.writeStateRaw(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, yaw, pitch);
  }
  writeStateRaw(x, y, z, vx, vy, vz, yaw, pitch) {
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE;
    const f = this.f64;
    f[base] = x;
    f[base + 1] = y;
    f[base + 2] = z;
    f[base + 3] = vx;
    f[base + 4] = vy;
    f[base + 5] = vz;
    f[base + 6] = yaw;
    f[base + 7] = pitch;
    return Atomics.add(this.i32, I_V, 1) + 1;
  }
}

// ── 批量采样：跑 fn 的 batch 次，返回单次平均耗时（µs）────────────────
function benchBatch(fn, warmup, batches, batchSize) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let b = 0; b < batches; b++) {
    const t0 = nowNs();
    for (let i = 0; i < batchSize; i++) fn();
    const dtNs = nowNs() - t0;
    samples.push(Number(dtNs) / 1e3 / batchSize); // µs / 次
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    avg: sum / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    max: samples[samples.length - 1],
  };
}
const fmtUs = (s) => `${s.toFixed(2)}µs`;
const usToHz = (us) => Math.round(1e6 / us);

// ── 世界构建 ─────────────────────────────────────────────────────────
const BRUSH_FILTER_JSON = JSON.stringify({
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
});
const bspYawToCsYaw = (bspYaw) => ((270 - bspYaw) % 360 + 360) % 360;

/** 小世界（手工 brush 镜像，与 phys-smoke brushes 一致）：物理 ~µs 级，对象构造占主导。 */
const q = 1 / Math.SQRT2;
const tinyBrushes = [
  {
    planes: [
      { normal: [0, 0, -1], dist: 2048 },
      { normal: [0, 0, 1], dist: 2048 },
      { normal: [-1, 0, 0], dist: 2048 },
      { normal: [1, 0, 0], dist: 2048 },
      { normal: [0, -1, 0], dist: 64 },
      { normal: [0, 1, 0], dist: 0 },
    ],
    min: [-2048, -64, -2048],
    max: [2048, 0, 2048],
    is_ladder: false,
    is_solid: true,
  },
  {
    planes: [
      { normal: [0, 0, -1], dist: 1024 },
      { normal: [0, 0, 1], dist: -256 },
      { normal: [-1, 0, 0], dist: 256 },
      { normal: [1, 0, 0], dist: 512 },
      { normal: [0, -1, 0], dist: 64 },
      { normal: [0, -q, q], dist: q * -256 },
    ],
    min: [256, -64, -1024],
    max: [512, 0, -256],
    is_ladder: false,
    is_solid: true,
  },
];

let wasmMem = null;
try {
  const out = initSync({ module: readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')) });
  wasmMem = out.memory;
} catch (e) {
  console.error(`[SKIP] wasm 初始化失败（${e}）——无法跑任何基准`);
  process.exit(1);
}

function makeWorld(brushJson) {
  const p = new PhysWorld();
  p.set_hull(16, 72, 54);
  p.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
  return p;
}
/** tick_into state_out 视图（phys-smoke 13.5b 同法；bench 无内存增长问题——build 后一次性建）。 */
function stateOutView(phys) {
  return new Float64Array(wasmMem.buffer, phys.state_out_ptr(), 8);
}

// ── 基准 1+2：小世界差分（对象构造占主导的场景）────────────────────
{
  const tiny = makeWorld(JSON.stringify(tinyBrushes));
  const sharedOld = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  const sharedNew = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  sharedOld.i32[I_KEYS_MASK] = 1;
  sharedNew.i32[I_KEYS_MASK] = 1;
  const viewNew = stateOutView(tiny);

  console.log('── 基准1a：小世界（手工 2 brush）热路径差分——对象构造占主导 ──');
  const oldPath = () => {
    const inp = sharedOld.consumeInput(1000);
    const s = tiny.tick(0.001, inp.keysMask, inp.dx, inp.dy); // wasm→JS 11 属性对象
    sharedOld.writeState({ x: s.posX, y: s.posY, z: s.posZ }, { x: s.velX, y: s.velY, z: s.velZ }, s.yaw, s.pitch);
  };
  const newPath = () => {
    const inp = sharedNew.consumeInput(1000);
    tiny.tick_into(0.001, inp.keysMask, inp.dx, inp.dy); // 零分配：wasm 固定缓冲
    const v = viewNew;
    sharedNew.writeStateRaw(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
  };
  const rOld = benchBatch(oldPath, 300, 200, 100);
  const rNew = benchBatch(newPath, 300, 200, 100);
  console.log(`  oldPath（tick+对象写）：${fmtUs(rOld.avg)}  p95 ${fmtUs(rOld.p95)}`);
  console.log(`  newPath（tick_into 零分配）：${fmtUs(rNew.avg)}  p95 ${fmtUs(rNew.p95)}`);
  const speedup = rOld.avg / rNew.avg;
  console.log(`  → 零分配热路径快 ${speedup.toFixed(2)}×（对象构造占比 = ${((1 - 1 / speedup) * 100).toFixed(0)}%）`);
  check('小世界：newPath 快于 oldPath ≥ 1.2×（零分配主张成立）', speedup >= 1.2, `speedup=${speedup.toFixed(2)}x`);
}

// ── 基准 1b：surf_666 真实世界（物理占主导）─────────────────────────
let big = null;
let bigErr = '';
try {
  const bspBytes = readFileSync(join(root, '../maps/surf_666.bsp'));
  const proc = new BspProcessor(bspBytes);
  const brushJson = proc.export_brushes_planes(BRUSH_FILTER_JSON);
  let triJson = proc.export_model_phy_colliders();
  if ((JSON.parse(triJson) || []).length === 0) triJson = proc.export_model_tri_colliders();
  const teleportReport = JSON.parse(proc.parse_teleports());
  const spawnReport = JSON.parse(proc.parse_spawn_points());
  const sp = spawnReport.spawn_points[spawnReport.primary ?? 0] ?? spawnReport.spawn_points[0];
  big = new PhysWorld();
  big.set_hull(16, 72, 54);
  big.build_world(
    brushJson,
    triJson,
    JSON.stringify(teleportReport),
    sp.origin[0],
    sp.origin[1],
    sp.origin[2],
    bspYawToCsYaw(sp.angles[1]),
  );
  let minY = Infinity;
  for (const b of JSON.parse(brushJson)) {
    if (b.min[1] < minY) minY = b.min[1];
  }
  if (Number.isFinite(minY)) big.set_death_y(minY - 100);
} catch (e) {
  bigErr = String(e);
}

if (big) {
  const sharedOld = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  const sharedNew = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  sharedOld.i32[I_KEYS_MASK] = 1;
  sharedNew.i32[I_KEYS_MASK] = 1;
  const viewNew = stateOutView(big);
  const s0 = big.state();

  console.log(`\n── 基准2：surf_666 真实世界（出生点 (${s0.posX.toFixed(1)},${s0.posY.toFixed(1)},${s0.posZ.toFixed(1)})，含输入/碰撞）──`);
  const oldPath = () => {
    const inp = sharedOld.consumeInput(1000);
    const s = big.tick(0.001, inp.keysMask, inp.dx, inp.dy);
    sharedOld.writeState({ x: s.posX, y: s.posY, z: s.posZ }, { x: s.velX, y: s.velY, z: s.velZ }, s.yaw, s.pitch);
  };
  const newPath = () => {
    const inp = sharedNew.consumeInput(1000);
    big.tick_into(0.001, inp.keysMask, inp.dx, inp.dy);
    const v = viewNew;
    sharedNew.writeStateRaw(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
  };
  const rOld = benchBatch(oldPath, 200, 100, 50);
  const rNew = benchBatch(newPath, 200, 100, 50);
  console.log(`  oldPath（tick+对象写）：avg ${fmtUs(rOld.avg)}  p95 ${fmtUs(rOld.p95)}  max ${fmtUs(rOld.max)}`);
  console.log(`  newPath（tick_into）：avg ${fmtUs(rNew.avg)}  p95 ${fmtUs(rNew.p95)}  max ${fmtUs(rNew.max)}`);
  console.log(`  → 可维持 V 发布率 ~${usToHz(rNew.avg)}Hz（p95 ${usToHz(rNew.p95)}Hz）`);
  check('1ms 子步预算：newPath p95 < 1000µs（1000Hz 可持续）', rNew.p95 < 1000, `p95=${rNew.p95.toFixed(1)}µs`);
  check('surf_666：newPath 不比 oldPath 慢（无回归）', rNew.avg <= rOld.avg * 1.05, `new=${rNew.avg.toFixed(2)}µs old=${rOld.avg.toFixed(2)}µs`);
}

// ── 基准 3：对象构造开销模型（200k 次/项）────────────────────────────
{
  console.log('\n── 基准3：状态对象构造开销模型（200k 次/项）──');
  const keys11 = ['posX', 'posY', 'posZ', 'yaw', 'pitch', 'velX', 'velY', 'velZ', 'onGround', 'contactTicks', 'eyeHeight'];
  const reflect11 = () => {
    const o = {};
    for (const k of keys11) Reflect.set(o, k, 1.5);
    return o;
  };
  const direct8 = () => {
    const o = { a: 0 };
    o.a = 1.5; o.b = 1.5; o.c = 1.5; o.d = 1.5;
    o.e = 1.5; o.f = 1.5; o.g = 1.5; o.h = 1.5;
    return o;
  };
  const sab8 = (() => {
    const f8 = new Float64Array(new SharedArrayBuffer(64));
    return () => {
      f8[0] = 1.5; f8[1] = 1.5; f8[2] = 1.5; f8[3] = 1.5;
      f8[4] = 1.5; f8[5] = 1.5; f8[6] = 1.5; f8[7] = 1.5;
    };
  })();
  const view8 = (() => {
    const src = new Float64Array(new SharedArrayBuffer(64));
    src.fill(1.5);
    let sink = 0;
    return () => {
      sink = src[0] + src[1] + src[2] + src[3] + src[4] + src[5] + src[6] + src[7]; // 视图读（tick_into 侧）
      return sink;
    };
  })();
  const rRef = benchBatch(reflect11, 2000, 200, 1000);
  const rDir = benchBatch(direct8, 2000, 200, 1000);
  const rSab = benchBatch(sab8, 2000, 200, 1000);
  const rView = benchBatch(view8, 2000, 200, 1000);
  console.log(`  state_js 11×Reflect.set（tick 对象路径）：${fmtUs(rRef.avg)}  p95 ${fmtUs(rRef.p95)}`);
  console.log(`  8×SAB Float64 写（writeStateRaw 路径）：${fmtUs(rSab.avg)}  p95 ${fmtUs(rSab.p95)}`);
  console.log(`  8×Float64Array 视图读（tick_into 读侧）：${fmtUs(rView.avg)}  p95 ${fmtUs(rView.p95)}`);
  console.log(`  8×直接属性写（对照）：${fmtUs(rDir.avg)}`);
  const ratio = rRef.avg / rSab.avg;
  console.log(`  → 对象构造 / SAB 直写 ≈ ${ratio.toFixed(1)}×；对象构造 / 视图读 ≈ ${(rRef.avg / rView.avg).toFixed(1)}×`);
  check('对象构造比 SAB 直写贵 ≥ 5×（直写方案的理论收益成立）', ratio >= 5, `ratio=${ratio.toFixed(1)}x`);
  check('视图读与 SAB 直写同量级（tick_into 读侧无额外开销）', Math.abs(Math.log10(rView.avg / rSab.avg)) < 1, `view=${rView.avg.toFixed(3)}µs sab=${rSab.avg.toFixed(3)}µs`);
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} PASS${fail > 0 ? ` — ${fail} FAIL` : ''}`);
if (fail > 0) process.exitCode = 1;
