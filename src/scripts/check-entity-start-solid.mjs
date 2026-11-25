/**
 * 跨端契约校验：Rust `render_bundle::eval_entity_start_solid` ↔ TS `entityStartSolidRaw`。
 *   node src/scripts/check-entity-start-solid.mjs
 *
 * 两侧读同一份 `src/ts-shared/entity/start-solid-cases.json`（Rust 侧是
 * `#[cfg(test)] include_str!`），任一侧漂移都会在这里或 `cargo test -p websurf-wasm-core` 红。
 * 不依赖 wasm / three / DOM；用 apps/game 里的 esbuild 把 start-solid.ts 打成临时 ESM 执行。
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const modulePath = path.join(root, 'src', 'ts-shared', 'entity', 'start-solid.ts');
const casesPath = path.join(root, 'src', 'ts-shared', 'entity', 'start-solid-cases.json');
const outDir = path.join(root, '.tmp', 'check-entity-start-solid');
const outFile = path.join(outDir, 'start-solid.mjs');

const raw = JSON.parse(readFileSync(casesPath, 'utf8'));
if (!Array.isArray(raw) || raw.length < 16) {
  console.error(`FAIL 契约夹具 ${path.relative(root, casesPath)} 必须是数组且至少 16 条（实际 ${Array.isArray(raw) ? raw.length : '非数组'}）`);
  process.exit(1);
}

// esbuild 只装在 apps/* 下；从 apps/game 取，避免仓库根重复安装依赖。
const gameRequire = createRequire(path.join(root, 'apps', 'game', 'package.json'));
const esbuild = gameRequire('esbuild');
const built = await esbuild.build({
  entryPoints: [modulePath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
});
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, built.outputFiles[0].contents, 'utf8');

const { entityStartSolidRaw, entityStartsNonSolid } = await import(`${pathToFileURL(outFile).href}?${Date.now()}`);

const failures = [];
let checked = 0;
for (const entry of raw) {
  const name = typeof entry.name === 'string' ? entry.name : `#${checked}`;
  const classname = entry.classname;
  const asText = (key) => (entry[key] === null || entry[key] === undefined ? undefined : String(entry[key]));
  const kv = {
    spawnflags: asText('spawnflags'),
    startdisabled: asText('startdisabled'),
    spawnpos: asText('spawnpos'),
  };
  const expectedSolid = entry.startSolid;
  const expectedHidden = entry.startHidden;
  if (typeof classname !== 'string' || typeof expectedSolid !== 'boolean' || typeof expectedHidden !== 'boolean') {
    failures.push(`${name}: 夹具字段缺失/类型错误（classname/startSolid/startHidden）`);
    continue;
  }
  const solid = entityStartSolidRaw(classname, kv);
  const hidden = !solid;
  // 适配器同样过一遍：模拟 Entity 的 getRaw，验证键名与缺省口径与调用点一致。
  const entity = {
    classname,
    spawnflags: 0,
    getRaw(key) {
      const k = key.toLowerCase();
      return k === 'spawnflags' || k === 'startdisabled' || k === 'spawnpos' ? kv[k] : undefined;
    },
  };
  const adapterHidden = entityStartsNonSolid(entity);
  checked += 1;
  if (solid !== expectedSolid) {
    failures.push(`${name}: startSolid 期望 ${expectedSolid}，实际 ${solid}（classname=${classname} kv=${JSON.stringify(kv)}）`);
  }
  if (hidden !== expectedHidden) {
    failures.push(`${name}: startHidden 期望 ${expectedHidden}，实际 ${hidden}`);
  }
  if (adapterHidden !== expectedHidden) {
    failures.push(`${name}: entityStartsNonSolid 期望 ${expectedHidden}，实际 ${adapterHidden}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL 实体 start_solid 契约：${failures.length} 处不符（共 ${checked} 条）`);
  for (const line of failures) console.error('  - ' + line);
  process.exit(1);
}
console.log(`实体 start_solid 契约自测：${checked}/${checked} 通过（Rust 侧同一夹具见 cargo test -p websurf-wasm-core）`);
