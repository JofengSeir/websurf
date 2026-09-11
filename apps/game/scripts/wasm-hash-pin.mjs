// t3 wasm 产物 hash pin（t6:146 确定性定理台侧落点：同 wasm hash pin → 双实例序列位级全等）。
// 用法：node scripts/wasm-hash-pin.mjs
// 产物：apps/game/temp/wasm-hash-pin.json（temp/ 已 gitignore，可随时重建）（pkg 产物 sha256 + 双端拷贝一致性校验）。
// t1 基线（重建前）：sha256 a60371ee7f80947a7e1a993e0047d6e991adb51f489ff575830e52ab9d1db6b9
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(gameRoot, 'pkg', 'websurf_wasm_bg.wasm');
const webPath = join(gameRoot, 'web', 'websurf_wasm_bg.wasm');
const pkg = readFileSync(pkgPath);
const web = readFileSync(webPath);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const pin = {
  file: 'apps/game/pkg/websurf_wasm_bg.wasm',
  sha256: sha(pkg),
  bytes: pkg.length,
  webCopy: {
    path: 'apps/game/web/websurf_wasm_bg.wasm',
    sha256: sha(web),
    matches: sha(pkg) === sha(web),
  },
  baselineBeforeT3: 'a60371ee7f80947a7e1a993e0047d6e991adb51f489ff575830e52ab9d1db6b9',
  changedFromBaseline: sha(pkg) !== 'a60371ee7f80947a7e1a993e0047d6e991adb51f489ff575830e52ab9d1db6b9',
  generatedBy: 'apps/game/scripts/wasm-hash-pin.mjs',
  schemaVersion: 1,
};
mkdirSync(join(gameRoot, 'temp'), { recursive: true });
writeFileSync(join(gameRoot, 'temp', 'wasm-hash-pin.json'), JSON.stringify(pin, null, 2) + '\n');
console.log('[wasm-hash-pin]', JSON.stringify(pin));
if (!pin.webCopy.matches) {
  console.error('FAIL: game/web 拷贝与 game/pkg 产物不一致');
  process.exit(1);
}
console.log('OK: pin 写回 apps/game/temp/wasm-hash-pin.json；双端拷贝一致');
