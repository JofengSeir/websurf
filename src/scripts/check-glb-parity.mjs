/**
 * 三端 GLB 等价门禁（task-57 G5，patch 依据 .tmp/audit/CI_GLB_GATE.md）。
 *
 * 背景：`glb-parity` job 过去只跑 check-wasm-api（导出↔导入契约），从不比较 GLB；viewer 的独立
 * 导出管线（core/bsp.ts）与共享管线（ts-shared/phys/world-builder.ts）可能静默漂移。实测：同一
 * `.bsp` 的三端 GLB **裸 sha 永远不同**（JSON 浮点序列化差异 + BIN 对齐），但 BIN chunk 逐字节相同、
 * JSON 按 f32 归一化后相同。⇒ 判据必须是：
 *   ① BIN chunk sha 相同；② 非整数数值 Math.fround 后 canonical-JSON sha 相同；
 *   ③ nodes/meshes/primitives/triangles/materials/images 计数相同。裸 GLB sha 只打印 INFO。
 *
 * 缺失口径：`test/maps/*.bsp` 不存在 ⇒ SKIP exit 0（CI 无地图夹具）。地图存在但 pkg/贴图包缺少
 * ⇒ FAIL（存在而判据无法计算）。默认只跑最小的 N=2 张图（确定性：按字节数升序 + 文件名），
 * 可用 `--maps a.bsp,b.bsp` / `--max-maps N` / `--all` 覆盖。
 *
 * 用法：`node src/scripts/check-glb-parity.mjs [--root <dir>] [--maps ...] [--max-maps N]`
 */
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = arg('--root', process.cwd());
const MAX_MAPS = Number(arg('--max-maps', '2'));
const MAPS_ARG = arg('--maps', '');
const ALL = argv.includes('--all');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const violations = [];
const fail = (m) => violations.push(m);

// ── 1) 地图夹具 ─────────────────────────────────────────────────────────────
const mapsDir = join(ROOT, 'test', 'maps');
const allMaps = existsSync(mapsDir)
  ? readdirSync(mapsDir).filter((n) => n.endsWith('.bsp')).map((n) => ({ name: n, size: statSync(join(mapsDir, n)).size }))
      .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))
  : [];
if (allMaps.length === 0) {
  console.log('[glb-parity] SKIP：test/maps/*.bsp 不存在（CI 无地图夹具；判据需夹具才可计算）。');
  process.exit(0);
}
let maps;
if (MAPS_ARG) {
  const want = MAPS_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  maps = want.map((w) => {
    const hit = allMaps.find((m) => m.name === w || m.name === `${w}.bsp`);
    if (!hit) { fail(`--maps 指定的 ${w} 不存在于 test/maps/`); return null; }
    return hit;
  }).filter(Boolean);
} else {
  maps = ALL ? allMaps : allMaps.slice(0, MAX_MAPS);
}
if (maps.length === 0) {
  if (violations.length) { for (const v of violations) console.error('  - ' + v); process.exit(1); }
  console.log('[glb-parity] SKIP：没有可跑的地图。');
  process.exit(0);
}

// ── 2) 输入（pkg / 贴图包）与判据是否可算 ──────────────────────────────────
function findOne(dir, re) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).find((n) => re.test(n)) ?? null;
}
const PKG = {};
for (const app of ['debug', 'game', 'viewer']) {
  const dir = join(ROOT, 'apps', app, 'pkg');
  const js = findOne(dir, /^websurf.*_wasm\.js$/);
  const wasm = findOne(dir, /_bg\.wasm$/);
  if (!js || !wasm) {
    const missing = [!js && 'JS', !wasm && 'wasm'].filter(Boolean).join('+');
    fail(`apps/${app}/pkg 缺少 ${missing} 文件（地图夹具存在 ⇒ 判据必须可算）`);
    continue;
  }
  PKG[app] = { dir, js: join(dir, js), wasm: join(dir, wasm) };
}
const mtzPath = ['apps/game/web/textures.mtz', 'src/materials/textures.mtz'].map((p) => join(ROOT, p)).find(existsSync);
const vmtsPath = ['apps/game/web/vmts.json', 'apps/debug/web/vmts.json'].map((p) => join(ROOT, p)).find(existsSync);
if (!mtzPath) fail('贴图包缺失：apps/game/web/textures.mtz 与 src/materials/textures.mtz 都不存在');
if (!vmtsPath) fail('VMT 回退表缺失：apps/*/web/vmts.json 不存在');
if (violations.length) {
  console.error(`[glb-parity] 违规 ${violations.length} 处（夹具存在但判据无法计算）：`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}

// ── 3) 加载三端 wasm pkg（browser-target ESM，先拷到临时目录再 import）──────
const tmp = mkdtempSync(join(tmpdir(), 'ws-glb-gate-'));
const MOD = {};
try {
  const mtz = new Uint8Array(readFileSync(mtzPath));
  const vmts = readFileSync(vmtsPath, 'utf8');
  for (const app of Object.keys(PKG)) {
    const copy = join(tmp, `pkg-${app}.mjs`);
    copyFileSync(PKG[app].js, copy);
    const mod = await import(pathToFileURL(copy).href);
    mod.initSync({ module: new Uint8Array(readFileSync(PKG[app].wasm)) });
    MOD[app] = { mod, defaults: mod.decompress_mtz(mtz) };
  }

  // ── 4) 生产管线（与 apps 真实入口一致）──────────────────────────────────
  const BRUSH = JSON.stringify({ include_ladder: true, include_solid: true, min_brush_volume: 0, skip_sky: false, skip_nodraw: false });

  function exportViewer(mod, defaults, mapBytes) {
    const proc = new mod.BspProcessor(new Uint8Array(mapBytes));
    JSON.parse(proc.metadata());
    proc.parse_spawn_points();
    proc.parse_entities();
    proc.parse_pvs_data();
    if (typeof proc.export_entity_io === 'function') proc.export_entity_io();
    if (typeof proc.export_mosaic_manifest === 'function') proc.export_mosaic_manifest();
    if (typeof proc.setVmtFallback === 'function') proc.setVmtFallback(vmts);
    try { return Buffer.from(proc.export_glb_with_pakfile_models_with_defaults_and_lights(defaults)); } finally { try { proc.free(); } catch { /* noop */ } }
  }
  function exportShared(mod, defaults, mapBytes) {
    const proc = new mod.BspProcessor(new Uint8Array(mapBytes));
    JSON.parse(proc.metadata());
    proc.parse_spawn_points();
    proc.parse_teleports();
    proc.parse_pvs_data();
    if (typeof proc.export_entity_io === 'function') proc.export_entity_io();
    proc.export_brushes_planes(BRUSH);
    proc.export_model_phy_colliders();
    proc.export_model_tri_colliders();
    if (typeof proc.export_model_phy_bevels === 'function') proc.export_model_phy_bevels();
    if (typeof proc.export_mosaic_manifest === 'function') proc.export_mosaic_manifest();
    if (typeof proc.setVmtFallback === 'function') proc.setVmtFallback(vmts);
    try { return Buffer.from(proc.export_glb_with_pakfile_models_with_defaults_and_lights(defaults)); } finally { try { proc.free(); } catch { /* noop */ } }
  }

  // ── 5) GLB 解析 + 判据 ────────────────────────────────────────────────────
  function splitGlb(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB（magic 不符）');
    const total = dv.getUint32(8, true);
    if (total !== buf.byteLength) throw new Error(`GLB 长度不符：header=${total} actual=${buf.byteLength}`);
    let off = 12, jsonRaw = null, bin = null;
    while (off + 8 <= total) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      const dataOff = off + 8;
      if (type === 0x4e4f534a) jsonRaw = Buffer.from(buf.buffer, buf.byteOffset + dataOff, len).toString('utf8');
      else if (type === 0x004e4942) bin = Buffer.from(buf.buffer, buf.byteOffset + dataOff, len);
      off = dataOff + len;
    }
    if (!jsonRaw) throw new Error('GLB 缺 JSON chunk');
    return { json: JSON.parse(jsonRaw), bin: bin ?? Buffer.alloc(0) };
  }
  const canonF32 = (v) => {
    if (Array.isArray(v)) return v.map(canonF32);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canonF32(v[k]);
      return o;
    }
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.fround(v);
    return v;
  };
  function analyze(glb) {
    const { json, bin } = splitGlb(glb);
    const accessors = json.accessors ?? [];
    let primitives = 0, triangles = 0;
    for (const m of json.meshes ?? []) {
      for (const p of m.primitives ?? []) {
        primitives++;
        const count = p.indices !== undefined ? accessors[p.indices]?.count ?? 0 : accessors[p.attributes?.POSITION]?.count ?? 0;
        triangles += Math.floor(count / 3);
      }
    }
    const f32Json = JSON.stringify(canonF32(json));
    return {
      bareSha: sha(glb),
      size: glb.byteLength,
      binSha: sha(bin),
      f32Sha: sha(Buffer.from(f32Json)),
      counts: {
        nodes: (json.nodes ?? []).length,
        meshes: (json.meshes ?? []).length,
        primitives,
        triangles,
        materials: (json.materials ?? []).length,
        images: (json.images ?? []).length,
      },
    };
  }
  function firstDiffF32(a, b) {
    const A = JSON.stringify(canonF32(a.json), null, 1).split('\n');
    const B = JSON.stringify(canonF32(b.json), null, 1).split('\n');
    for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `L${i + 1}: ${JSON.stringify(A[i])} != ${JSON.stringify(B[i])}`;
    return '(无行级差异)';
  }

  // ── 6) 逐图跑三端并判定 ──────────────────────────────────────────────────
  for (const m of maps) {
    const mapBytes = readFileSync(join(mapsDir, m.name));
    const results = {};
    for (const app of ['debug', 'game', 'viewer']) {
      const { mod, defaults } = MOD[app];
      let glb;
      try {
        glb = app === 'viewer' ? exportViewer(mod, defaults, mapBytes) : exportShared(mod, defaults, mapBytes);
      } catch (e) {
        fail(`${m.name} ${app}: 导出 GLB 失败（地图夹具存在 ⇒ 判据必须可算）：${e && e.message ? e.message : e}`);
        continue;
      }
      results[app] = analyze(glb);
      // 为差异定位临时保留一次解析结果（仅 viewer/debug 对；用完即弃）
      if (app === 'viewer' || app === 'debug') results[app]._json = splitGlb(glb).json;
    }
    if (!results.debug || !results.game || !results.viewer) continue; // 已记 fail，继续下一张图
    const pairs = [['debug', 'game'], ['debug', 'viewer'], ['game', 'viewer']];
    const info = pairs.map(([a, b]) => `${a}~${b} bare=${results[a].bareSha.slice(0, 8)}/${results[b].bareSha.slice(0, 8)} ${results[a].bareSha === results[b].bareSha ? 'same' : 'diff'}`).join('；');
    for (const [a, b] of pairs) {
      const A = results[a], B = results[b];
      if (A.binSha !== B.binSha) fail(`${m.name} ${a}~${b}: BIN chunk sha 不同（${A.binSha.slice(0, 12)} vs ${B.binSha.slice(0, 12)}）`);
      if (A.f32Sha !== B.f32Sha) {
        const d = a === 'debug' || a === 'game' ? firstDiffF32({ json: A._json }, { json: B._json }) : '(跳过定位)';
        fail(`${m.name} ${a}~${b}: f32 归一化 JSON sha 不同（首差 ${d}）`);
      }
      for (const k of Object.keys(A.counts)) {
        if (A.counts[k] !== B.counts[k]) fail(`${m.name} ${a}~${b}: ${k} 计数不同（${A.counts[k]} vs ${B.counts[k]}）`);
      }
    }
    console.log(`[glb-parity] ${m.name} (${(m.size / 1048576).toFixed(1)}MB bsp)：` +
      `BIN ${results.debug.binSha.slice(0, 8)} / f32JSON ${results.debug.f32Sha.slice(0, 8)} / ` +
      `nodes=${results.debug.counts.nodes} meshes=${results.debug.counts.meshes} prims=${results.debug.counts.primitives} ` +
      `tris=${results.debug.counts.triangles} mats=${results.debug.counts.materials} imgs=${results.debug.counts.images}；裸 sha INFO：${info}`);
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
}

if (violations.length) {
  console.error(`[glb-parity] 违规 ${violations.length} 处（判据：BIN sha + f32-JSON sha + 结构计数，三端两两相等）：`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log(`[glb-parity] OK：${maps.length} 张图 × 三端，BIN/f32JSON/结构计数两两等价（裸 sha 差异见 INFO）。`);
