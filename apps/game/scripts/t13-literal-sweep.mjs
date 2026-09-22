/**
 * 字面量类扫描（脚本名 `t13-literal-sweep`）：量化某个 wasm 构建解析 JS 数值字面量时
 * 是否偏离 IEEE 正确舍入。
 *
 * 输入形态建模：产品把 JS 数字交给 wasm 的方式是 `JSON.stringify(x)`——调用点如
 * `apps/game/src/renderer/renderer-main.ts` 的 `set_spawn_points` / `set_params`、
 * `apps/game/src/worker/main.ts` 的 `set_params`——产出 x 的**最短往返表示**。故本扫描的
 * 字面量一律取 `String(x)`，分四类：
 *   R  realistic  ：坐标/参数域量级的随机 double（`Math.round(±1e6 · r · 1000) / 1000`，3 位小数）
 *   F  f32-derived：随机 double 乘 `2^(−10 .. 9)` 后落到 f32、再取 `String`
 *                   （BSP 平面数据经 f32 中转的实际形态）
 *   I  integer    ：`0 .. 999999`，外加两个 > 2^53 的字面量（`9007199254740993`、
 *                   `1000000000000000128`）
 *   D  double     ：任意 f64 的最短往返表示（`mant ∈ [1, 2)`、指数 `1e-6 .. 1e6`）
 *
 * 观测面：`set_spawn_points` 精确回显——把字面量放进出生点的 y，逐索引 `teleport_to_spawn(i)`
 * 后读 `state().posY`，与 JS `Number(literal)` 的位型逐位比对（JS 解析 = IEEE 正确舍入）。
 *   mismatch ⇒ 该构建的 Rust 解析与正确舍入不一致（可达行为分歧；偏差幅度本脚本不度量）。
 * 这三个方法由 `src/phys/mod.rs` 的 `#[wasm_bindgen] impl PhysWorld` 导出。
 *
 * 跨构建对比：`--wasm-dir` 缺省指向 `apps/game/pkg`，把另一构建的产物目录传进来即可对比两条
 * 解析路径。可定位的 feature 事实：`src/Cargo.toml` 给 `serde_json` 开了 `float_roundtrip`，
 * 而 `src/wasm-core/Cargo.toml` 与三工程（`apps/debug`、`apps/game`、`apps/viewer`）各自的
 * `crates/wasm/Cargo.toml` 都取默认 features（同一构建图内 feature 统一，故该图是否含
 * `websurf-phys` 决定 ON/OFF）。
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

/** mulberry32：确定性 PRNG。种子固定（见下方 `mulberry32(20260910)`），故两次运行、不同构建
 *  取到的字面量集合相同。 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 有效数字位数：去掉符号与指数部分，再去掉小数点与前导零后计数。 */
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
  // F 类：随机 double 乘 2^(−10..9) 后落到 f32（f32 中转形态，量级 9.8e-4 .. 512）
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
// D 类：任意 f64（不经 f32 中转）的最短往返表示 —— `JSON.stringify` 的最一般形态
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
