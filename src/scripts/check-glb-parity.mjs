/**
 * 材质口径一致性门禁 —— `apps/debug` 与 `apps/game` 的 wasm 导出面**必须**对同一张地图产出同一套材质。
 *
 * ## 为什么需要它
 *
 * 两个工程的 GLB 都由各自 crate 里的 `export_glb_with_pakfile_models_with_defaults_and_lights`
 * 驱动（`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 是唯一调用方），共享的只有
 * `src/wasm-core` 的解析层；**回退链的接线**在两侧 crate 里各写一遍。接线漏一环不会报错——
 * 表现只是「同一张图、同一处，debug 与 game 的材质不一样」（实测过一次：debug 侧
 * `resolve_pakfile_materials` 少传默认纹理包，21 个模型材质退化成无贴图，其中
 * `metalgrate013a` 这类 `alphaMode = MASK` 的镂空贴图因基色 alpha 恒为 1 而整块变实心）。
 *
 * ## 断言（撤掉任一侧的回退接线即 FAIL）
 *
 * 1. `materials` 数量与**顺序**一致，逐项比对 `name` / `alphaMode` / `alphaCutoff` /
 *    `doubleSided` / 是否绑定 `baseColorTexture` / `extras.vbsp_wireframe` / `extras.unlit`；
 * 2. `images` 的**名字集合与字节**一致（按名字取 sha256 比对）——只缺一张贴图也判失败。
 *
 * 不比对 GLB 字节全等：两侧 crate 的 `serde_json` 版本可以不同，浮点打印尾数会有极小差异
 * （见历史记录：viewer 与 game 的 GLB 只差 472 字节的浮点打印）。故字节长度与 sha256 只作
 * 参考信息打印，不进断言。
 *
 * ## 用法与跳过语义
 *
 *   node src/scripts/check-glb-parity.mjs [<map.bsp>]
 *
 * 缺任一工程的 `pkg/websurf_wasm.js`、`web/textures.mtz` 或地图文件（`test/maps/` 在
 * `.gitignore` 内，干净检出不存在）时打印 `SKIP` 并 `exit 0` —— 与 `apps/viewer` 的
 * `test:sessions` 在语料夹具缺失时自报 SKIP 同一口径。断言失败 `exit 1`，全部通过 `exit 0`。
 *
 * 实现约束：只 import `node:fs` / `node:path` / `node:crypto` / `node:url`，**不引**
 * `child_process`（两份 wasm 在同一个进程里顺序加载，前一份导出完即释放引用后再加载下一份）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = ['debug', 'game'];
const DEFAULT_MAP = process.argv[2] ?? path.join(ROOT, 'test', 'maps', 'surf_666.bsp');

const failures = [];

/** 载入某个工程的 wasm pkg，导出地图 GLB，返回 `{ glbLen, glbSha, materials, images }`。 */
async function exportApp(app, mapBytes) {
  const pkgJs = path.join(ROOT, 'apps', app, 'pkg', 'websurf_wasm.js');
  const pkgWasm = path.join(ROOT, 'apps', app, 'pkg', 'websurf_wasm_bg.wasm');
  const mtzPath = path.join(ROOT, 'apps', app, 'web', 'textures.mtz');
  const mod = await import(pathToFileURL(pkgJs).href);
  mod.initSync({ module: fs.readFileSync(pkgWasm) });

  const defaultsJson = mod.decompress_mtz(new Uint8Array(fs.readFileSync(mtzPath)));
  const proc = new mod.BspProcessor(new Uint8Array(mapBytes));
  const glb = proc.export_glb_with_pakfile_models_with_defaults_and_lights(defaultsJson);
  const parsed = parseGlb(glb);
  const out = {
    glbLen: glb.byteLength,
    glbSha: sha256(Buffer.from(glb)),
    materials: parsed.materials,
    images: parsed.images,
  };
  // 释放引用：下一份 wasm 实例会另开一块线性内存，先让这份可被回收
  void proc;
  return out;
}

/** GLB → `{ materials, images }`（只取本门禁断言用到的字段）。 */
function parseGlb(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB magic 不匹配');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const body = new Uint8Array(glb.buffer, glb.byteOffset + off + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    if (type === 0x004e4942) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const materials = (json.materials ?? []).map((m) => ({
    name: m.name ?? '',
    alphaMode: m.alphaMode ?? 'OPAQUE',
    alphaCutoff: m.alphaCutoff ?? null,
    doubleSided: !!m.doubleSided,
    hasBaseColorTexture:
      !!(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture),
    wireframe: !!(m.extras && m.extras.vbsp_wireframe),
    unlit: !!(m.extras && m.extras.unlit),
  }));
  const images = (json.images ?? []).map((img) => {
    const view = json.bufferViews[img.bufferView];
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    return { name: img.name ?? '', sha: sha256(Buffer.from(bytes)), len: view.byteLength };
  });
  return { materials, images };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function compare(a, b) {
  const [appA, appB] = APPS;
  const A = a.materials;
  const B = b.materials;
  if (A.length !== B.length) {
    failures.push(`材质数不一致：${appA}=${A.length}，${appB}=${B.length}`);
  }
  const n = Math.min(A.length, B.length);
  let fieldDiffs = 0;
  for (let i = 0; i < n; i++) {
    for (const key of Object.keys(A[i])) {
      if (JSON.stringify(A[i][key]) !== JSON.stringify(B[i][key])) {
        fieldDiffs++;
        if (fieldDiffs <= 12) {
          failures.push(
            `material[${i}] ${A[i].name || '(无名)'} 的 ${key} 不一致：` +
              `${appA}=${JSON.stringify(A[i][key])} ${appB}=${JSON.stringify(B[i][key])}`,
          );
        }
      }
    }
  }
  if (fieldDiffs > 12) failures.push(`…另有 ${fieldDiffs - 12} 处材质字段差异未逐条打印`);

  // 贴图：名字集合 + 逐个字节
  const mapA = new Map(a.images.map((im) => [im.name, im]));
  const mapB = new Map(b.images.map((im) => [im.name, im]));
  const onlyA = [...mapA.keys()].filter((k) => !mapB.has(k));
  const onlyB = [...mapB.keys()].filter((k) => !mapA.has(k));
  if (onlyA.length) failures.push(`仅 ${appA} 有的贴图 ${onlyA.length} 张：${onlyA.slice(0, 10).join(', ')}`);
  if (onlyB.length) failures.push(`仅 ${appB} 有的贴图 ${onlyB.length} 张：${onlyB.slice(0, 10).join(', ')}`);
  let byteDiffs = 0;
  for (const [name, imA] of mapA) {
    const imB = mapB.get(name);
    if (imB && imA.sha !== imB.sha) {
      byteDiffs++;
      if (byteDiffs <= 8) failures.push(`贴图字节不一致：${name}（${appA}=${imA.len}B ${appB}=${imB.len}B）`);
    }
  }
  if (byteDiffs > 8) failures.push(`…另有 ${byteDiffs - 8} 张贴图字节不一致`);

  return { fieldDiffs, onlyA: onlyA.length, onlyB: onlyB.length, byteDiffs };
}

console.log('=== 材质口径一致性门禁（debug ↔ game）===');
console.log(`仓库根: ${ROOT}`);
console.log(`地图: ${DEFAULT_MAP}`);

const missing = [];
for (const app of APPS) {
  for (const rel of [['pkg', 'websurf_wasm.js'], ['pkg', 'websurf_wasm_bg.wasm'], ['web', 'textures.mtz']]) {
    const abs = path.join(ROOT, 'apps', app, ...rel);
    if (!fs.existsSync(abs)) missing.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
}
if (!fs.existsSync(DEFAULT_MAP)) missing.push(path.relative(ROOT, DEFAULT_MAP).split(path.sep).join('/'));
if (missing.length) {
  console.log(`SKIP 缺少输入（先各自 npm run build:wasm 并放入地图夹具）：${missing.join(', ')}`);
  process.exit(0);
}

const mapBytes = fs.readFileSync(DEFAULT_MAP);
const results = {};
for (const app of APPS) {
  const t0 = Date.now();
  results[app] = await exportApp(app, mapBytes);
  const r = results[app];
  console.log(
    `${app}: GLB ${r.glbLen} B（sha256 ${r.glbSha.slice(0, 16)}），材质 ${r.materials.length}，` +
      `贴图 ${r.images.length}，无基色贴图材质 ${r.materials.filter((m) => !m.hasBaseColorTexture).length}，` +
      `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

const stats = compare(results.debug, results.game);
if (failures.length > 0) {
  console.error('');
  console.error(`❌ 门禁失败：debug 与 game 的材质口径不一致（${failures.length} 条）`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('');
  console.error('提示：两侧 crate 的缺失纹理回退链（默认纹理包 / 基名 VMT 索引）必须逐项对齐。');
  process.exit(1);
}
console.log('');
console.log(
  `✅ 材质口径一致：${results.debug.materials.length} 个材质逐字段相同、` +
    `${results.debug.images.length} 张贴图逐字节相同（字段差异 ${stats.fieldDiffs}）`,
);
process.exit(0);
