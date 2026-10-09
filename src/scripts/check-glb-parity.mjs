/**
 * 三端 GLB 一致性门禁 —— `apps/debug` / `apps/game` / `apps/viewer` 的 wasm 导出面**必须**对同一张地图
 * 产出同一套语义：节点名、图元属性键、`extras.ambientCube` 有无、材质字段、贴图字节。
 *
 * ## 为什么需要它
 *
 * 三个工程的 GLB 都由各自 crate 的导出方法驱动（`src/ts-shared/phys/world-builder.ts` 的
 * `buildWorldBundle` 是唯一调用方），共享的只有 `src/wasm-core/` 的解析层；**回退链与编排的接线**
 * 在三个 crate 里各写一遍。接线漏一环不会报错——表现只是「同一张图、同一处，三端产物不一样」：
 * 实测过一次 debug 侧 `resolve_pakfile_materials` 少传默认纹理包，21 个模型材质退化成无贴图
 * （`metalgrate013a` 这类 `alphaMode = MASK` 的镂空贴图因基色 alpha 恒为 1 而整块变实心）；
 * viewer 侧则曾整段不导实体放置模型（`entities` 恒空 ⇒ `buk01.mdl` / `cow.mdl` 完全不出现）。
 *
 * ## 断言（撤掉任一侧的接线即 FAIL）
 *
 * 1. `materials` 数量与**顺序**一致，逐项比对 `name` / `alphaMode` / `alphaCutoff` /
 *    `doubleSided` / 是否绑定 `baseColorTexture` / `extras.vbsp_wireframe` / `extras.unlit`；
 * 2. `images` 的**名字集合与字节**一致（按名字取 sha256 比对）——只缺一张贴图也判失败；
 * 3. `nodes` 的名字集合一致（实体放置模型就靠它进入产物）；
 * 4. 图元属性键集合一致（`POSITION` / `NORMAL` / `TEXCOORD_0` / `_VBSP_VLIGHT` / `_VBSP_BLEND` …）；
 * 5. 带 `extras.ambientCube` 的节点集合一致（prop 逐叶环境立方体，T-433/D-016 口径）。
 *
 * 不比对 GLB 字节全等：三端 crate 名/生成器字符串不同，`serde_json` 浮点打印尾数也可能有极小差异
 * （历史记录：viewer 与 game 曾只差 472 字节的浮点打印）。字节长度与 sha256 只作参考信息打印。
 * 同一端重复导出是**确定性**的（`.tmp/unify/glb-hash-probe.mjs` 实测同端两次哈希一致），
 * 因此「搬动共享编排前后哈希不变」可用作重构的无行为变化证据（见 T-454 P5 进展记录）。
 *
 * ## 用法与跳过语义
 *
 *   node src/scripts/check-glb-parity.mjs [<map.bsp>]
 *
 * 缺任一工程的 `pkg/websurf*.js`、`web/textures.mtz` 或地图文件（`test/maps/` 在 `.gitignore` 内，
 * 干净检出与 CI 上不存在）时打印 `SKIP` 并 `exit 0` —— 与 `apps/viewer` 的 `test:sessions`
 * 在语料夹具缺失时自报 SKIP 同一口径。断言失败 `exit 1`，全部通过 `exit 0`。
 *
 * 实现约束：只 import `node:fs` / `node:path` / `node:crypto` / `node:url`，**不引**
 * `child_process`（三份 wasm 在同一个进程里顺序加载，前一份导出完即释放引用后再加载下一份）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 三端的 pkg 入口文件名不同（crate 名不同），导出方法名相同。 */
const APPS = [
  { app: 'debug', pkg: 'websurf_wasm.js' },
  { app: 'game', pkg: 'websurf_wasm.js' },
  { app: 'viewer', pkg: 'websurf_viewer_wasm.js' },
];
const DEFAULT_MAP = process.argv[2] ?? path.join(ROOT, 'test', 'maps', 'surf_666.bsp');

const failures = [];

/** 载入某个工程的 wasm pkg，导出地图 GLB，返回门禁要用的字段。 */
async function exportApp({ app, pkg }, mapBytes) {
  const pkgJs = path.join(ROOT, 'apps', app, 'pkg', pkg);
  const pkgWasm = pkgJs.replace(/\.js$/, '_bg.wasm');
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
    ...parsed,
  };
  // 释放引用：下一份 wasm 实例会另开一块线性内存，先让这份可被回收
  void proc;
  return out;
}

/** GLB → 门禁断言用的字段（材质 / 贴图 / 节点名 / 属性键 / ambientCube 节点）。 */
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
  const nodes = (json.nodes ?? []).map((n, i) => n.name ?? `#${i}`);
  const attrKeys = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const key of Object.keys(prim.attributes ?? {})) attrKeys.add(key);
    }
  }
  const ambientCubeNodes = (json.nodes ?? [])
    .map((n, i) => [n.name ?? `#${i}`, n.extras?.ambientCube])
    .filter(([, cube]) => cube !== undefined)
    .map(([name]) => name)
    .sort();
  return {
    materials,
    images,
    nodeNames: nodes.sort(),
    attrKeys: [...attrKeys].sort(),
    ambientCubeNodes,
  };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 集合型字段：三端必须完全一致（顺序无关）。 */
function compareSets(label, values) {
  const [first, ...rest] = values;
  const base = new Set(first);
  let bad = false;
  for (let i = 1; i < values.length; i++) {
    const cur = new Set(values[i]);
    const only = [...cur].filter((x) => !base.has(x));
    const missing = [...base].filter((x) => !cur.has(x));
    if (!only.length && !missing.length) continue;
    bad = true;
    failures.push(
      `${label} 不一致：${APPS[0].app} 有 ${first.length} 项，${APPS[i].app} 有 ${values[i].length} 项` +
        `（仅 ${APPS[i].app} 有 ${JSON.stringify(only.slice(0, 8))}${only.length > 8 ? ` …+${only.length - 8}` : ''}；` +
        `缺 ${JSON.stringify(missing.slice(0, 8))}${missing.length > 8 ? ` …+${missing.length - 8}` : ''}）`,
    );
  }
  return !bad;
}

/** 材质：数量 + 顺序 + 逐字段；贴图：名字集合 + 逐张字节。逐对比较（三端两两）。 */
function comparePair(a, b) {
  const appA = a.app;
  const appB = b.app;
  const A = a.materials;
  const B = b.materials;
  if (A.length !== B.length) failures.push(`材质数不一致：${appA}=${A.length}，${appB}=${B.length}`);
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
  if (fieldDiffs > 12) failures.push(`…另有 ${fieldDiffs - 12} 处材质字段差异未逐条打印（${appA} ↔ ${appB}）`);

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
  if (byteDiffs > 8) failures.push(`…另有 ${byteDiffs - 8} 张贴图字节不一致（${appA} ↔ ${appB}）`);
  return { fieldDiffs, byteDiffs };
}

console.log('=== 三端 GLB 一致性门禁（debug / game / viewer）===');
console.log(`仓库根: ${ROOT}`);
console.log(`地图: ${DEFAULT_MAP}`);

const missing = [];
for (const { app, pkg } of APPS) {
  for (const rel of [['pkg', pkg], ['pkg', pkg.replace(/\.js$/, '_bg.wasm')], ['web', 'textures.mtz']]) {
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
const results = [];
for (const end of APPS) {
  const t0 = Date.now();
  const r = { app: end.app, ...(await exportApp(end, mapBytes)) };
  results.push(r);
  console.log(
    `${end.app}: GLB ${r.glbLen} B（sha256 ${r.glbSha.slice(0, 16)}），材质 ${r.materials.length}，` +
      `贴图 ${r.images.length}，节点 ${r.nodeNames.length}，属性键 ${r.attrKeys.length}，` +
      `ambientCube 节点 ${r.ambientCubeNodes.length}，无基色贴图材质 ${r.materials.filter((m) => !m.hasBaseColorTexture).length}，` +
      `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

let fieldDiffsTotal = 0;
for (let i = 0; i < results.length; i++) {
  for (let j = i + 1; j < results.length; j++) {
    fieldDiffsTotal += comparePair(results[i], results[j]).fieldDiffs;
  }
}
compareSets('节点名集合', results.map((r) => r.nodeNames));
compareSets('图元属性键集合', results.map((r) => r.attrKeys));
compareSets('ambientCube 节点集合', results.map((r) => r.ambientCubeNodes));

if (failures.length > 0) {
  console.error('');
  console.error(`❌ 门禁失败：三端 GLB 语义不一致（${failures.length} 条）`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('');
  console.error('提示：三侧 crate 的缺失纹理回退链（默认纹理包 / 基名 VMT 索引）与导出编排必须逐项对齐；');
  console.error('      P5 起编排已收进 `src/wasm-core/render_bundle.rs`，若这里报差异说明某端仍在走自己的老路径。');
  process.exit(1);
}
console.log('');
console.log(
  `✅ 三端语义一致：${results[0].materials.length} 个材质逐字段相同、${results[0].images.length} 张贴图逐字节相同、` +
    `${results[0].nodeNames.length} 个节点名与 ${results[0].attrKeys.length} 个属性键集合相同、` +
    `${results[0].ambientCubeNodes.length} 个 ambientCube 节点相同（字段差异 ${fieldDiffsTotal}）`,
);
process.exit(0);
