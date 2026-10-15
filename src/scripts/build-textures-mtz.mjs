#!/usr/bin/env node
/**
 * 重建默认纹理包 `src/materials/textures.mtz`：把素材目录里的缺失材质**追加**进包。
 *
 * 为什么需要本脚本：容器的**写出方向**（`websurf_wasm_core::mosaic::mtz::compress_json`）原先
 * 只被 Rust 单测调用、wasm 无导出，因此「往默认纹理包里加材质」在本仓没有可复现的路径。
 * 本脚本走 `apps/debug` wasm 的三个既有导出把整条链路串起来：
 *   `decompress_mtz`（读旧包）→ `decode_vtf_to_png`（VTF→PNG）→ `mosaic_encode`（PNG→字节码）
 *   → `compress_mtz`（JSON→新包，本次新增导出）。
 *
 * 素材目录约定（`--src`，默认 `test/fallback-src`，该目录不入库）：
 *   RESOLVED.json          `{ "<材质名>": "<贴图名>" }`；键是要加进包的**材质名**（不带 `materials/` 前缀）
 *   materials/<贴图名>.vtf 对应的 VTF 文件
 * 包内键的写法：材质名一条（`materials/<材质名>`，覆盖「整条材质加载失败」分支），
 * 用到的贴图名再补一条（`materials/<贴图名>`，覆盖「VMT 在、$basetexture 的 VTF 不在」分支）。
 *
 * 为什么不做整体重排：`decompress_mtz` 的输出是可逐行解析的 JSON 文本，本脚本**只在其末尾追加新行**，
 * 原条目一个字节都不重写；写完立刻用 `decompress_mtz` 回读并断言「旧条目逐字节不变 + 新键都在」，
 * 任何不一致都以非 0 退出（默认写盘；`--dry-run` 只打印计划）。
 *
 * 用法：
 *   node src/scripts/build-textures-mtz.mjs [--src test/fallback-src] [--out src/materials/textures.mtz] [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);

const SRC = resolve(ROOT, arg('src', 'test/fallback-src'));
const OUT = resolve(ROOT, arg('out', 'src/materials/textures.mtz'));
const DRY = flag('dry-run');

const PKG_JS = join(ROOT, 'apps', 'debug', 'pkg', 'websurf_wasm.js');
const PKG_WASM = join(ROOT, 'apps', 'debug', 'pkg', 'websurf_wasm_bg.wasm');
for (const f of [PKG_JS, PKG_WASM, OUT, join(SRC, 'RESOLVED.json')]) {
  if (!existsSync(f)) throw new Error('缺少输入：' + f);
}

const wasm = await import('file://' + PKG_JS.replace(/\\/g, '/'));
wasm.initSync({ module: readFileSync(PKG_WASM) });
for (const fn of ['decompress_mtz', 'compress_mtz', 'decode_vtf_to_png', 'mosaic_encode']) {
  if (typeof wasm[fn] !== 'function') {
    throw new Error(`wasm 缺少导出 ${fn} ⇒ apps/debug 的 pkg 是旧的，先跑 npm run build:wasm（T-652 记录过"假刷新"事故）`);
  }
}

/** 与 `mosaic::mtz::escape_json` 同口径：`"` `\` 与四类控制字符转义，其余（含非 ASCII）原样。 */
function escapeJson(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0) < 0x20) out += '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

const read = (p) => new Uint8Array(readFileSync(p));

// ── 1. 读旧包 ───────────────────────────────────────────────────────────────
const oldMtz = read(OUT);
const oldJson = wasm.decompress_mtz(oldMtz);
const parseEntries = (text) => {
  const m = new Map();
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l === '{' || l === '}') continue;
    const s = l.endsWith(',') ? l.slice(0, -1) : l;
    const i = s.indexOf('": "');
    if (i < 0) continue;
    m.set(JSON.parse(s.slice(0, i + 1)), JSON.parse(s.slice(i + 3).replace(/,$/, '')));
  }
  return m;
};
const before = parseEntries(oldJson);
console.log(`旧包：${oldMtz.length} B / ${before.size} 条`);

// ── 2. 逐个素材编码 ─────────────────────────────────────────────────────────
const resolved = JSON.parse(readFileSync(join(SRC, 'RESOLVED.json'), 'utf8'));
const codes = new Map(); // 贴图名 → 字节码
const added = [];        // [键, 字节码, 说明]
const skipped = [];
const needCode = (tex) => {
  if (codes.has(tex)) return codes.get(tex);
  const f = join(SRC, 'materials', tex.toLowerCase() + '.vtf');
  if (!existsSync(f)) { skipped.push(`${tex}（VTF 不在素材目录）`); return null; }
  const png = wasm.decode_vtf_to_png(read(f));
  if (png.length < 8 || Buffer.from(png.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('VTF 未解出 PNG：' + tex);
  const code = wasm.mosaic_encode(png, tex);
  codes.set(tex, code);
  return code;
};

for (const [mat, tex] of Object.entries(resolved)) {
  const code = needCode(tex);
  if (code === null) continue;
  const key = 'materials/' + mat.toLowerCase();
  if (before.has(key)) { skipped.push(`${mat}（包内已有）`); continue; }
  added.push([key, code, `材质名 ← 贴图 ${tex}`]);
}
// 贴图名本身也补一条（覆盖「VMT 在、VTF 不在」分支）
for (const tex of codes.keys()) {
  const key = 'materials/' + tex.toLowerCase();
  if (before.has(key) || added.some(([k]) => k === key)) continue;
  added.push([key, codes.get(tex), `贴图名（$basetexture）`]);
}

// 可选：`--extra <json>` 直接喂**已编码**的条目 `{ "materials/<键>": "<#mosaic v4 字节码>" }`。
// 用途：批量铺 stock 贴图时，贴图来自本机游戏包、路径不该写进仓库脚本，故由外部工具编码后经此入口并入
// （编码仍是 `decode_vtf_to_png` + `mosaic_encode`，与素材目录那条路同一套 wasm 导出）。
const EXTRA = arg('extra', '');
if (EXTRA) {
  const extra = JSON.parse(readFileSync(resolve(ROOT, EXTRA), 'utf8'));
  let n = 0;
  for (const [key, code] of Object.entries(extra)) {
    if (before.has(key) || added.some(([k]) => k === key)) continue;
    if (typeof code !== 'string' || !code.startsWith('#mosaic')) throw new Error(`--extra 里 ${key} 的值不像字节码`);
    added.push([key, code, 'stock 铺料']);
    n++;
  }
  console.log(`--extra ${EXTRA}：并入 ${n} 条（已存在/重复的跳过）`);
}

console.log(`拟新增 ${added.length} 条；用到 ${codes.size} 张不同贴图；跳过 ${skipped.length} 条`);
if (skipped.length) console.log('  跳过明细：\n    ' + skipped.join('\n    '));
if (DRY) { console.log('--dry-run：不写盘。'); process.exit(0); }
if (!added.length) { console.log('没有要新增的条目，未改动文件。'); process.exit(0); }

// ── 3. 只在 JSON 末尾追加（不动原有条目）────────────────────────────────────
const tail = oldJson.lastIndexOf('\n}\n');
if (tail < 0) throw new Error('旧包 JSON 文本尾部形态不符（期望以 \\n}\\n 结尾）');
const appended = added.map(([k, v]) => ',\n  ' + escapeJson(k) + ': ' + escapeJson(v)).join('');
const newJson = oldJson.slice(0, tail) + appended + '\n}\n';

// ── 4. 压缩 + 往返断言 ──────────────────────────────────────────────────────
// 注意：容器读回时会经 `parse_json` → `render_bytecode` **规范化重排**每条字节码
// （字段顺序固定、按条件省略 T/G/A/R），所以不能拿"压缩前文本"与"解压后文本"比字符串相等。
// 真正要守住的不变量有两条：① 原有条目逐字节不变；② 反复压缩-解压收敛到同一个定点。
const newMtz = wasm.compress_mtz(newJson);
const pass1 = wasm.decompress_mtz(newMtz);
const after = parseEntries(pass1);
if (after.size !== before.size + added.length) throw new Error(`条目数不符：${before.size} + ${added.length} ≠ ${after.size}`);
for (const [k, v] of before) if (after.get(k) !== v) throw new Error('原有条目被改动：' + k);
for (const [k] of added) if (!after.has(k)) throw new Error('新条目缺失：' + k);
const again = wasm.decompress_mtz(wasm.compress_mtz(pass1));
if (again !== pass1) throw new Error('压缩-解压未收敛到定点（第二次往返仍变化）');
// 规范化确有发生时说清楚（不是错误，只是提示新增条目的字节码被重排过）
for (const [k, raw] of added) {
  if (after.get(k) !== raw) { console.log(`  [提示] 新条目 ${k} 的字节码被容器规范化重排（长度 ${raw.length} → ${after.get(k).length}）`); break; }
}

const oldSize = statSync(OUT).size;
writeFileSync(OUT, Buffer.from(newMtz));
console.log(`✅ 已写 ${OUT.replace(/\\/g, '/')}：${oldSize} B → ${newMtz.length} B（+${added.length} 条，共 ${after.size} 条）`);
console.log('   新增键：\n     ' + added.map(([k, , why]) => `${k}  (${why})`).join('\n     '));
