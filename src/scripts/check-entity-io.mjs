/**
 * Source 实体 I/O 自测 runner（可在仓库任意 cwd 下运行）：
 *   node src/scripts/check-entity-io.mjs
 *
 * 用 apps/game 里的 esbuild 把 `test/entity-io/selftest.ts` 打成单文件 ESM，
 * 注入「读 BSP entities lump」的 Node 能力后执行。不依赖 wasm、不依赖 three、不依赖 DOM。
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const selftest = path.join(root, 'test', 'entity-io', 'selftest.ts');
const outFile = path.join(root, '.tmp', 'entity-io-selftest.mjs');

// esbuild 只装在 apps/game 下；从那里取，避免在仓库根重复安装依赖。
const gameRequire = createRequire(path.join(root, 'apps', 'game', 'package.json'));
const esbuild = gameRequire('esbuild');

const built = await esbuild.build({
  entryPoints: [selftest],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
});
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, built.outputFiles[0].contents, 'utf8');

/** 直接读 VBSP header 的 lump 0（entities），保持与 `Entities::raw()` 同样的无损字节。 */
function readEntitiesLump(file) {
  const buf = readFileSync(file);
  const ident = buf.readInt32LE(0);
  if (ident !== 0x50534256) throw new Error(`不是 VBSP: ${file} (ident=0x${ident.toString(16)})`);
  const offs = buf.readInt32LE(8);
  const len = buf.readInt32LE(12);
  if (offs <= 0 || len <= 0 || offs + len > buf.length) throw new Error(`lump 0 越界: ${file}`);
  return buf.subarray(offs, offs + len).toString('latin1').replace(/\0+$/, '');
}

const mapDir = path.join(root, 'test', 'maps');
const mapNames = [
  'surf_666.bsp', 'surf_fornax.bsp', 'ze_cursed_bear_tales_v1_2.bsp',
].filter((name) => existsSync(path.join(mapDir, name)));

globalThis.__websurfReadEntities = readEntitiesLump;
globalThis.__websurfMapDir = mapDir;
globalThis.__websurfPathJoin = (a, b) => path.join(a, b);
// 地图夹具本地自备、不入库；新克隆里为空，B/C 组由 selftest 判 SKIP 而不是 FAIL。
globalThis.__websurfMapNames = mapNames;

// 可选 C 组：用**已重建的 game wasm 产物**跑真实 `export_entity_io()`，
// 验证「改了 Rust 之后产物真的被用」，而不只是源码里多了个方法。
if (mapNames.length === 0) {
  console.log('  SKIP  C wasm 产物探针：test/maps 下无地图夹具（本地自备）');
} else {
  try {
    const gluePath = path.join(root, 'apps', 'game', 'pkg', 'websurf_wasm.js');
    const wasmPath = path.join(root, 'apps', 'game', 'pkg', 'websurf_wasm_bg.wasm');
    const glue = await import(pathToFileURL(gluePath).href);
    glue.initSync({ module: readFileSync(wasmPath) });
    globalThis.__websurfEntityIoFromBsp = (file) => {
      const proc = new glue.BspProcessor(new Uint8Array(readFileSync(file)));
      return proc.export_entity_io();
    };
  } catch (e) {
    console.log(`  SKIP  C wasm 产物探针（未重建或加载失败）：${e instanceof Error ? e.message : String(e)}`);
  }
}

process.exitCode = 0;
try {
  await import(pathToFileURL(outFile).href);
} catch (e) {
  console.error('实体 I/O 自测执行失败：', e);
  process.exitCode = 1;
}
