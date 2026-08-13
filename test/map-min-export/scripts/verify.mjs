// map-min-export 输出验证脚本（纯 Node 内置模块，无依赖）。
//
// 用法:node scripts/verify.mjs [输出目录, 默认 out]
// 校验:
//   1. geometry.glb   — glTF magic / version / totalLen 一致 / 三角形数 > 0
//   2. collision.json — WasmBrush[]:每项 planes>=4、plane 结构、min<=max、is_ladder/is_solid 布尔
//   3. materials/     — manifest 每项:VMT 落盘或注明缺失;PNG 存在时校验魔数与 IHDR 宽高一致
//   4. 交叉校验       — manifest 统计与实际文件/数值一致
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] || 'out';
let fails = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    fails++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

console.log(`═══ verify: ${outDir} ═══`);

// ---- 0. 文件存在性 ----
for (const f of ['geometry.glb', 'collision.json', 'manifest.json']) {
  check(`存在 ${f}`, existsSync(join(outDir, f)));
}
check('存在 materials/ 目录', existsSync(join(outDir, 'materials')));

// ---- 1. geometry.glb ----
const glbPath = join(outDir, 'geometry.glb');
if (existsSync(glbPath)) {
  const glb = readFileSync(glbPath);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const magic = String.fromCharCode(...glb.subarray(0, 4));
  const version = dv.getUint32(4, true);
  const totalLen = dv.getUint32(8, true);
  check('GLB magic = glTF', magic === 'glTF', magic);
  check('GLB version = 2', version === 2, String(version));
  check('GLB totalLen = 文件大小', totalLen === glb.length, `${totalLen} = ${glb.length}`);
  // JSON chunk 中提取三角形数（scene 组 → primitive 的 accessor count）
  const jsonLen = dv.getUint32(12, true);
  const jsonStr = glb.subarray(20, 20 + jsonLen).toString('utf8');
  const json = JSON.parse(jsonStr.replace(/\0+$/, ''));
  const triCounts = (json.meshes || []).flatMap((m) => m.primitives || [])
    .map((p) => {
      const idx = json.accessors[p.indices];
      return idx ? idx.count / 3 : 0;
    });
  const tris = triCounts.reduce((a, b) => a + b, 0);
  check('GLB 三角形数 > 0', tris > 0, `${tris} tris / ${(json.meshes || []).length} meshes`);
  check('GLB 有材质分组', (json.materials || []).length > 0, `${(json.materials || []).length} materials`);
}

// ---- 2. collision.json ----
const collPath = join(outDir, 'collision.json');
if (existsSync(collPath)) {
  const coll = readJson(collPath);
  check('collision.json 是数组', Array.isArray(coll));
  check('碰撞 brush 数 > 0', Array.isArray(coll) && coll.length > 0, `${coll.length} brushes`);
  let badPlanes = 0;
  let badAabb = 0;
  for (const b of coll) {
    const planes = b?.planes;
    if (!Array.isArray(planes) || planes.length < 4) badPlanes++;
    for (const p of planes || []) {
      if (!Array.isArray(p?.normal) || p.normal.length !== 3 || typeof p?.dist !== 'number') badPlanes++;
    }
    const min = b?.min, max = b?.max;
    if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) badAabb++;
    else if (min.some((v, i) => v > max[i])) badAabb++;
    if (typeof b?.is_ladder !== 'boolean' || typeof b?.is_solid !== 'boolean') badPlanes++;
  }
  check('每项 planes>=4 且结构合法', badPlanes === 0, badPlanes ? `${badPlanes} 项异常` : '全部合法');
  check('每项 min<=max 合法', badAabb === 0, badAabb ? `${badAabb} 项异常` : '全部合法');
}

// ---- 3. materials / manifest ----
const manPath = join(outDir, 'manifest.json');
if (existsSync(manPath)) {
  const man = readJson(manPath);
  const mats = man.materials || [];
  check('manifest.materials 非空', mats.length > 0, `${mats.length} materials`);
  // 结构校验(替换旧恒真表达式;数值交叉校验见下方第 4 节)
  check('manifest.geometry.triangles 为合法数值',
    typeof man.geometry?.triangles === 'number' && man.geometry.triangles > 0,
    String(man.geometry?.triangles));
  check('manifest.collision.brushes 为合法数值',
    typeof man.collision?.brushes === 'number' && man.collision.brushes > 0,
    String(man.collision?.brushes));

  let pngOk = 0;
  let pngBad = 0;
  for (const m of mats) {
    const files = m.files || [];
    const hasVmt = files.some((f) => f.endsWith('.vmt'));
    const hasPng = files.some((f) => f.endsWith('.png'));
    const hasVtf = files.some((f) => f.endsWith('.vtf'));
    const missingNote = (m.note || '').includes('不在 PAKFILE');

    if (!hasVmt && !missingNote) {
      check(`[${m.rel}] VMT 落盘`, false, m.note || '无 VMT 且未注明缺失');
      continue;
    }
    if (hasPng) {
      const pngPath = join(outDir, 'materials', files.find((f) => f.endsWith('.png')));
      if (existsSync(pngPath)) {
        const png = readFileSync(pngPath);
        const sigOk = png.length > 24 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        const w = dv32(png, 16), h = dv32(png, 20);
        const dimOk = m.width === undefined || (w === m.width && h === m.height);
        if (sigOk && dimOk) pngOk++;
        else {
          pngBad++;
          check(`[${m.rel}] PNG 合法`, false, `sig=${sigOk} dim=${w}x${h} 期望=${m.width}x${m.height}`);
        }
      } else {
        pngBad++;
        check(`[${m.rel}] PNG 文件存在`, false);
      }
    } else if (!hasVtf && !missingNote && !m.note) {
      check(`[${m.rel}] 有产物文件`, false, '无 PNG/VTF 且无备注');
    }
  }
  check('PNG 解码全部合法', pngBad === 0, `${pngOk} 个 PNG 校验通过`);
}

// ---- 4. 交叉校验（GLB 三角形 vs manifest；collision.json 项数 vs manifest） ----
if (existsSync(glbPath) && existsSync(manPath)) {
  const glb = readFileSync(glbPath);
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8').replace(/\0+$/, ''));
  const tris = (json.meshes || []).flatMap((m) => m.primitives || [])
    .map((p) => json.accessors[p.indices].count / 3).reduce((a, b) => a + b, 0);
  const man = readJson(manPath);
  check('GLB 三角形 == manifest.geometry.triangles', tris === man.geometry?.triangles,
    `GLB ${tris} vs manifest ${man.geometry?.triangles}`);
}
if (existsSync(collPath) && existsSync(manPath)) {
  const coll = readJson(collPath);
  const man = readJson(manPath);
  check('collision.json 项数 == manifest.collision.brushes', Array.isArray(coll) && coll.length === man.collision?.brushes,
    `collision ${coll.length} vs manifest ${man.collision?.brushes}`);
}

console.log(`\n═══ 结果: ${checks - fails}/${checks} 通过 ═══`);
process.exit(fails === 0 ? 0 : 1);

function dv32(buf, off) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off, false);
}
