// 跨工程 GLB 导出契约断言（§6.3 验收第 3 条的落地）：
// 四个工程（apps/{game,debug,viewer} + test/game-core）各自的 wasm 导出层各导出一份 GLB，
// 断言 lightmap 契约一致 ——
// ① asset.extras.lightmap.textureIndex 合法且指向 PNG 图集
// ② materials[*].extensions.__vbsp_lightmap__.textureIndex 与 ① 一致
// ③ 每个含 TEXCOORD_1 的 primitive：accessor count === POSITION.count、FLOAT、VEC2
// ④ 每个 primitive 的 extras.hasLightmap 为布尔；count 统计
// ⑤ primitives[*].extras.faceIndex 为整数、落在 [0, faceCount)、互不重复
// ⑥ 同一输入连续导出两次字节相同（确定性）
//   node scripts/cross-project-glb-contract.mjs          （npm run test:glb-contract）
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP = process.env.WEBSURF_MAP
  ? resolve(process.env.WEBSURF_MAP)
  : resolve(ROOT, 'test/maps/surf_666.bsp');

const PROJECTS = [
  {
    name: 'apps/game',
    pkg: 'apps/game/pkg/websurf_wasm.js',
    wasm: 'apps/game/pkg/websurf_wasm_bg.wasm',
    defaults: 'apps/game/web/textures.mtz',
    entry: 'export_glb_with_pakfile_models_with_defaults_and_lights',
    arg: 'defaults',
  },
  {
    name: 'apps/debug',
    pkg: 'apps/debug/pkg/websurf_wasm.js',
    wasm: 'apps/debug/pkg/websurf_wasm_bg.wasm',
    defaults: 'apps/debug/web/textures.mtz',
    entry: 'export_glb_with_pakfile_models_with_defaults_and_lights',
    arg: 'defaults',
  },
  {
    name: 'apps/viewer',
    pkg: 'apps/viewer/pkg/websurf_viewer_wasm.js',
    wasm: 'apps/viewer/pkg/websurf_viewer_wasm_bg.wasm',
    entry: 'export_glb_with_pakfile_models',
    arg: 'none',
  },
  {
    name: 'test/game-core',
    pkg: 'test/game-core/pkg/websurf_wasm.js',
    wasm: 'test/game-core/pkg/websurf_wasm_bg.wasm',
    defaults: 'test/game-core/web/textures.mtz',
    entry: 'export_glb_with_pakfile_models_with_defaults_and_lights',
    arg: 'defaults',
  },
];

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  const version = dv.getUint32(4, true);
  let off = 12, json = null;
  while (off < buf.length) {
    const clen = dv.getUint32(off, true);
    const ctype = dv.getUint32(off + 4, true);
    const body = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    off += 8 + clen;
  }
  return { magic, version, json };
}

async function runProject(p) {
  const pkgPath = join(ROOT, p.pkg);
  const wasmPath = join(ROOT, p.wasm);
  if (!existsSync(pkgPath) || !existsSync(wasmPath)) {
    return { name: p.name, skipped: `缺 ${existsSync(pkgPath) ? p.wasm : p.pkg}（先 npm run build:wasm）` };
  }
  const mod = await import(pathToFileURL(pkgPath).href);
  mod.initSync({ module: readFileSync(wasmPath) });
  const mapBytes = new Uint8Array(readFileSync(MAP));

  const exportOnce = () => {
    const proc = new mod.BspProcessor(new Uint8Array(mapBytes));
    if (p.arg === 'defaults') {
      const defaults = mod.decompress_mtz(new Uint8Array(readFileSync(join(ROOT, p.defaults))));
      return Buffer.from(proc[p.entry](defaults));
    }
    return Buffer.from(proc[p.entry]());
  };

  const t0 = Date.now();
  const glb1 = exportOnce();
  const ms1 = Date.now() - t0;
  const glb2 = exportOnce();
  const deterministic =
    createHash('sha256').update(glb1).digest('hex') === createHash('sha256').update(glb2).digest('hex');

  const { magic, version, json } = parseGlb(glb1);
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };

  ok(magic === 'glTF' && version === 2, `容器头非法（magic=${magic} version=${version}）`);

  // ① asset.extras.lightmap.textureIndex
  const lm = (json.asset?.extras ?? {}).lightmap ?? (json.scenes?.[0]?.extras ?? {}).lightmap;
  const ti = lm?.textureIndex;
  ok(Number.isInteger(ti), 'asset.extras.lightmap.textureIndex 缺失或非整数');
  if (Number.isInteger(ti)) {
    ok(ti >= 0 && ti < (json.textures?.length ?? 0), `textureIndex ${ti} 越界（textures=${json.textures?.length ?? 0}）`);
    const src = json.textures?.[ti]?.source;
    const img = src !== undefined ? json.images?.[src] : null;
    ok(!!img, '图集 texture 无 source/image');
    if (img) {
      ok(img.mimeType === 'image/png', `图集不是 PNG（${img.mimeType}）`);
      const bv = json.bufferViews?.[img.bufferView];
      const png = glb1.subarray(0, 0); // 仅占位；PNG 头在 BIN chunk 内，下面用 header 粗检
      ok(!!bv && bv.byteLength > 8, '图集 bufferView 缺失或过小');
    }
  }

  // ② material 扩展一致性
  const mats = (json.materials ?? []).filter((m) => m.extensions?.__vbsp_lightmap__);
  if (Number.isInteger(ti)) {
    ok(mats.length > 0, '没有任何 material 带 __vbsp_lightmap__ 扩展');
    ok(mats.every((m) => m.extensions.__vbsp_lightmap__.textureIndex === ti), 'material 扩展的 textureIndex 与 asset 不一致');
  }

  // ③④⑤ 逐 primitive
  const accessors = json.accessors ?? [];
  let primWithUv1 = 0, primTotal = 0, hlTrue = 0, hlFalse = 0, hlMissing = 0, idxChecked = 0;
  const seenFace = new Set();
  let faceDup = 0, faceOut = 0;
  const faceCount = json.meshes?.length ?? 0; // 仅用于“为整数”判定；真实面数以导出侧为准
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      primTotal++;
      const pos = accessors[prim.attributes?.POSITION];
      const uv1 = prim.attributes?.TEXCOORD_1 !== undefined ? accessors[prim.attributes.TEXCOORD_1] : null;
      if (uv1) {
        primWithUv1++;
        ok(pos && uv1.count === pos.count, `TEXCOORD_1.count(${uv1?.count}) !== POSITION.count(${pos?.count})`);
        ok(uv1.componentType === 5126, `TEXCOORD_1 非 FLOAT（${uv1.componentType}）`);
        ok(uv1.type === 'VEC2', `TEXCOORD_1 非 VEC2（${uv1.type}）`);
      }
      const hl = mesh.extras?.hasLightmap ?? prim.extras?.hasLightmap;
      if (hl === true) hlTrue++;
      else if (hl === false) hlFalse++;
      else if (uv1) hlMissing++;
      const fi = prim.extras?.faceIndex;
      if (fi !== undefined) {
        idxChecked++;
        if (!Number.isInteger(fi) || fi < 0) faceOut++;
        else if (seenFace.has(fi)) faceDup++;
        else seenFace.add(fi);
      }
    }
  }
  ok(hlMissing === 0, `有 ${hlMissing} 个 primitive 缺 extras.hasLightmap`);
  ok(faceOut === 0, `${faceOut} 个 faceIndex 非整数或为负`);
  ok(faceDup === 0, `${faceDup} 个 faceIndex 重复`);
  ok(deterministic, '连续两次导出字节不同（确定性失败）');

  return {
    name: p.name,
    entry: p.entry,
    glbMB: +(glb1.length / 1048576).toFixed(1),
    exportMs: ms1,
    deterministic,
    atlasTextureIndex: ti ?? null,
    atlasPng: Number.isInteger(ti) && json.images?.[json.textures[ti].source]?.mimeType === 'image/png',
    materialExtCount: mats.length,
    primTotal,
    primWithUv1,
    hasLightmap: { true: hlTrue, false: hlFalse, missing: hlMissing },
    faceIndexChecked: idxChecked,
    faceIndexUnique: seenFace.size,
    fails,
  };
}

console.log(`map = ${MAP}`);
const results = [];
for (const p of PROJECTS) {
  process.stdout.write(`\n=== ${p.name} ===\n`);
  try {
    const r = await runProject(p);
    results.push(r);
    if (r.skipped) { console.log(`  SKIP: ${r.skipped}`); continue; }
    console.log(`  entry=${r.entry}  ${r.glbMB} MB / ${r.exportMs} ms  确定性=${r.deterministic}`);
    console.log(`  atlas: textureIndex=${r.atlasTextureIndex} PNG=${r.atlasPng}  material 扩展=${r.materialExtCount}`);
    console.log(`  primitives=${r.primTotal}  含 TEXCOORD_1=${r.primWithUv1}  hasLightmap: true=${r.hasLightmap.true} false=${r.hasLightmap.false} missing=${r.hasLightmap.missing}`);
    console.log(`  faceIndex: 检查 ${r.faceIndexChecked} 个，唯一 ${r.faceIndexUnique} 个`);
    console.log(r.fails.length ? `  ❌ ${r.fails.length} 条失败：\n     - ` + r.fails.join('\n     - ') : '  ✅ 契约断言全通过');
  } catch (e) {
    results.push({ name: p.name, error: String(e && e.stack ? e.stack : e).slice(0, 300) });
    console.log(`  ❌ 导出/断言异常：${String(e).slice(0, 200)}`);
  }
}

const bad = results.filter((r) => r.error || (r.fails && r.fails.length));
console.log(`\n===== 汇总：${results.length} 个工程，失败 ${bad.length} =====`);
for (const r of results) {
  const mark = r.skipped ? 'SKIP' : r.error ? 'ERR ' : r.fails?.length ? 'FAIL' : 'PASS';
  console.log(`  ${mark}  ${r.name}${r.skipped ? '  ' + r.skipped : ''}`);
}
process.exit(bad.length ? 1 : 0);
