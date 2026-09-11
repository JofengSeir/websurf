/**
 * t13 字面量类扫描：量化 fast parser（OFF）与 float_roundtrip（ON）在**真实输入形态**下的分歧率。
 *
 * 输入形态建模（关键）：产品把 JS 数字喂给 Rust 的方式 = `JSON.stringify(x)`，产出 x 的
 * **最短往返表示**。故本扫描的字面量一律取 `String(x)`（= JSON.stringify 的数值形态），
 * 分三类：
 *   R  realistic  : 均匀随机 double，量级 1e-3..1e6（坐标/参数域）
 *   F  f32-derived: 随机 f32 → double → String（BSP 平面数据经 f32 中转的实际形态）
 *   I  integer    : 整数域（含 >2^53 的可疑值）
 *
 * 观测面：set_spawn_points 精确回显（teleport_to_spawn(0..N-1) → state().posY 逐位）。
 * 判据：posY 位型 == JS `Number(literal)` 位型（JS 解析 = IEEE 正确舍入）。
 *   mismatch ⇒ 该构建的 Rust 解析偏离正确舍入 1 ULP（可达行为分歧）。
 *
 * 用法：node scripts/t13-literal-sweep.mjs [--wasm-dir=<dir>] [--n=600]
 * 只读：只打印 JSON 摘要 + 前若干样例。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..'); // apps/game（脚本位于 scripts/，其上一级即工程根）
const argDir = process.argv.find((a) => a.startsWith('--wasm-dir='));
const argN = process.argv.find((a) => a.startsWith('--n='));
const N = argN ? Number(argN.slice(4)) : 600;
const WASM_DIR = argDir ? resolve(argDir.slice('--wasm-dir='.length)) : join(APP, 'pkg');

const mod = await import(pathToFileURL(join(WASM_DIR, 'websurf_wasm.js')).href);
const wasmBytes = readFileSync(join(WASM_DIR, 'websurf_wasm_bg.wasm'));
const initOut = mod.initSync({ module: wasmBytes });
const PhysWorld = mod.PhysWorld;

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const b = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };

/** mulberry32：确定性 PRNG（两构建同种子 → 同一字面量集合）。 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 有效数字位数（去掉符号/小数点/前导零后计数）。 */
function sigDigits(lit) {
  const s = lit.replace(/^[-+]/, '').split(/[eE]/)[0].replace('.', '').replace(/^0+/, '');
  return s.length === 0 ? 1 : s.length;
}

const rnd = mulberry32(20260910);
const cases = [];
for (let i = 0; i < N; i++) {
  const lit = String(Math.round((rnd() * 2 - 1) * 1e6 * rnd() * 1000) / 1000);
  if (Number.isFinite(Number(lit))) cases.push({ cls: 'R', lit });
}
for (let i = 0; i < N; i++) {
  f64[0] = 0;
  const r = rnd();
  // 随机 f32 位型（指数限制在 1e-3..1e6 量级）
  f64[0] = (r * 2 - 1) * Math.pow(2, Math.floor(rnd() * 20) - 10);
  const asF32 = new Float32Array(1);
  asF32[0] = f64[0];
  const lit = String(asF32[0]);
  if (Number.isFinite(Number(lit))) cases.push({ cls: 'F', lit });
}
for (let i = 0; i < Math.max(20, Math.floor(N / 10)); i++) {
  const k = Math.floor(rnd() * 1e6);
  cases.push({ cls: 'I', lit: String(k) });
}
// D：任意 f64（非 f32 中转）的最短往返表示 —— JSON.stringify 的最一般形态
for (let i = 0; i < N; i++) {
  const mant = 1 + rnd();
  const exp = Math.floor(rnd() * 13) - 6;              // 1e-6 .. 1e6
  const v = (rnd() < 0.5 ? -1 : 1) * mant * Math.pow(10, exp);
  const lit = String(v);
  if (Number.isFinite(Number(lit))) cases.push({ cls: 'D', lit });
}
cases.push({ cls: 'I', lit: '9007199254740993' }, { cls: 'I', lit: '1000000000000000128' });

const NO_TELE = JSON.stringify({ teleports: [], triggers: [] });
const floor = `[{"planes":[{"normal":[0,1,0],"dist":0},{"normal":[0,-1,0],"dist":0},{"normal":[1,0,0],"dist":1e6},{"normal":[-1,0,0],"dist":1e6},{"normal":[0,0,1],"dist":1e6},{"normal":[0,0,-1],"dist":1e6}],"min":[-1e6,0,-1e6],"max":[1e6,1e7,1e6],"is_ladder":false,"is_solid":true}]`;

// 每 200 个字面量复用同一实例（set_spawn_points 批量 → 逐索引 teleport 回显）
const BATCH = 200;
const mismatches = [];
const byCls = {};
let tested = 0;
let mismatchTotal = 0;
for (let off = 0; off < cases.length; off += BATCH) {
  const chunk = cases.slice(off, off + BATCH);
  const w = new PhysWorld();
  w.build_world(floor, '[]', NO_TELE, 0, 20, 0, 0);
  w.set_spawn_points(JSON.stringify(chunk.map((c) => [0, Number(c.lit), 0, 0])));
  for (let i = 0; i < chunk.length; i++) {
    w.teleport_to_spawn(i);
    const s = w.state();
    const got = b(s.posY);
    const want = b(Number(chunk[i].lit));
    tested++;
    byCls[chunk[i].cls] = byCls[chunk[i].cls] ?? { n: 0, mismatch: 0, maxDigits: 0, mismatchMaxDigits: 0, mismatchMinDigits: 99 };
    const st = byCls[chunk[i].cls];
    st.n++;
    const d = sigDigits(chunk[i].lit);
    st.maxDigits = Math.max(st.maxDigits, d);
    if (got !== want) {
      st.mismatch++;
      mismatchTotal++;
      st.mismatchMaxDigits = Math.max(st.mismatchMaxDigits, d);
      st.mismatchMinDigits = Math.min(st.mismatchMinDigits, d);
      if (mismatches.length < 12) mismatches.push({ cls: chunk[i].cls, lit: chunk[i].lit, digits: d, got, want });
    }
  }
  w.free();
}

console.log(JSON.stringify({
  probe: 't13-literal-sweep',
  wasmDir: relative(APP, WASM_DIR),
  tested,
  totalMismatch: mismatchTotal,
  mismatchByClass: byCls,
  samples: mismatches,
}, null, 1));
