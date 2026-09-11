/**
 * t13 灵敏度阳性对照：证明三条输入面在 **1 ULP 解析差异**下确实会产生位级可观测输出。
 *
 * 做法：对同一物理场景分别喂「相差 1 ULP 的两个相邻字面量」（第二个 = 第一个的下一个
 * double 的十进制展开），比较输出位型。若位型不同 → 该面灵敏度 = 1 ULP（可作为
 * ON/OFF 比对的阳性对照）；若位型相同 → 该面对 1 ULP 不敏感，须在结论中显式降权。
 *
 * 用法：node scripts/t13-ulp-sensitivity-control.mjs [--wasm-dir=<dir>]
 * 只读：只打印 JSON。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..'); // apps/game（脚本位于 scripts/，其上一级即工程根）
const argDir = process.argv.find((a) => a.startsWith('--wasm-dir='));
const WASM_DIR = argDir ? resolve(argDir.slice('--wasm-dir='.length)) : join(APP, 'pkg');

const mod = await import(pathToFileURL(join(WASM_DIR, 'websurf_wasm.js')).href);
const wasmBytes = readFileSync(join(WASM_DIR, 'websurf_wasm_bg.wasm'));
const initOut = mod.initSync({ module: wasmBytes });
const PhysWorld = mod.PhysWorld;
const DT = 1 / 64;

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const b = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };
/** 相邻下一个 double（+1 ULP）的精确十进制表示。 */
function nextUpDecimal(x) {
  f64[0] = x;
  u64[0] += 1n;
  const y = f64[0];
  return { y, lit: y.toPrecision(25) };
}

const NO_TELE = JSON.stringify({ teleports: [], triggers: [] });
const floorBrush = (topDist) =>
  `[{"planes":[{"normal":[0,1,0],"dist":${topDist}},{"normal":[0,-1,0],"dist":0},{"normal":[1,0,0],"dist":1e6},{"normal":[-1,0,0],"dist":1e6},{"normal":[0,0,1],"dist":1e6},{"normal":[0,0,-1],"dist":1e6}],"min":[-1e6,0,-1e6],"max":[1e6,1e7,1e6],"is_ladder":false,"is_solid":true}]`;

const out = { probe: 't13-ulp-sensitivity', wasmDir: relative(APP, WASM_DIR), controls: {} };

// ── A：平面 dist 相差 1 ULP → 静止 posY 是否不同 ────────────────────────
{
  const base = 10.478655362066775;
  const { y: up, lit } = nextUpDecimal(base);
  const run = (litStr) => {
    const w = new PhysWorld();
    w.build_world(floorBrush(litStr), '[]', NO_TELE, 0, 20.478655362066775, 0, 0);
    for (let i = 0; i < 90; i++) w.tick(DT, 0, 0, 0);
    const s = w.state();
    const r = { posY: b(s.posY), velY: b(s.velY), onGround: s.onGround, posX: b(s.posX) };
    w.free();
    return r;
  };
  const lo = run(String(base));
  const hi = run(lit);
  out.controls.build_world_plane = { loLiteral: String(base), hiLiteral: lit, lo, hi, sensitive: JSON.stringify(lo) !== JSON.stringify(hi), deltaDouble: up - base };
}

// ── B：run_speed 相差 1 ULP → velX 是否不同 ─────────────────────────────
{
  const base = 250;
  const { lit } = nextUpDecimal(base);
  const run = (litStr) => {
    const w = new PhysWorld();
    w.build_world(floorBrush('0'), '[]', NO_TELE, 0, 20, 0, 0);
    for (let i = 0; i < 10; i++) w.tick(DT, 0, 0, 0);
    w.set_params(`{"run_speed":${litStr}}`);
    for (let i = 0; i < 60; i++) w.tick(DT, 1, 0, 0);
    const s = w.state();
    const r = { velX: b(s.velX), velZ: b(s.velZ), posX: b(s.posX) };
    w.free();
    return r;
  };
  const lo = run('250');
  const hi = run(lit);
  out.controls.set_params_run_speed = { loLiteral: '250', hiLiteral: lit, lo, hi, sensitive: JSON.stringify(lo) !== JSON.stringify(hi) };
}

// ── C：spawn y 相差 1 ULP → origin.y 是否不同 ───────────────────────────
{
  const base = 100.00000000000001;
  const { lit } = nextUpDecimal(base);
  const run = (litStr) => {
    const w = new PhysWorld();
    w.build_world(floorBrush('0'), '[]', NO_TELE, 0, 20, 0, 0);
    w.set_spawn_points(`[[0,${litStr},0,0]]`);
    w.teleport_to_spawn(0);
    const s = w.state();
    const r = { posY: b(s.posY) };
    w.free();
    return r;
  };
  const lo = run(String(base));
  const hi = run(lit);
  out.controls.set_spawn_points = { loLiteral: String(base), hiLiteral: lit, lo, hi, sensitive: JSON.stringify(lo) !== JSON.stringify(hi) };
}

// ── A-threshold：brush 平面 dist 的**行为分辨率**扫描 ────────────────────
// A 面对 1 ULP 不敏感（碰撞解算量化）。本扫描给出「多大的 dist 差才会改变输出位型」，
// 从而把「A 面不敏感」量化成行为分辨率（相对量级），而非笼统「测不出」。
{
  const base = 10.478655362066775;
  const run = (litStr) => {
    const w = new PhysWorld();
    w.build_world(floorBrush(litStr), '[]', NO_TELE, 0, 20.478655362066775, 0, 0);
    for (let i = 0; i < 90; i++) w.tick(DT, 0, 0, 0);
    const s = w.state();
    const r = { posY: b(s.posY) };
    w.free();
    return r;
  };
  const baseline = run(String(base));
  const rows = [];
  for (const rel of ['1e-16', '1e-15', '1e-14', '1e-12', '1e-10', '1e-8', '1e-6']) {
    const cand = base * (1 + Number(rel));
    const lit = cand.toPrecision(25);
    const got = run(lit);
    rows.push({ relDelta: rel, literal: lit, posY: got.posY, changed: got.posY !== baseline.posY });
  }
  out.controls.build_world_plane_threshold = { base: String(base), baselinePosY: baseline.posY, rows, firstChangedRel: (rows.find((r) => r.changed) || {}).relDelta ?? '>1e-6' };
}

console.log(JSON.stringify(out, null, 1));
