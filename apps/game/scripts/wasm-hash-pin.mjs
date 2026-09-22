/**
 * wasm 产物指纹落盘：对 `apps/game/pkg/websurf_wasm_bg.wasm` 与
 * `apps/game/web/websurf_wasm_bg.wasm` 各算一份 sha256，写进 apps/game/temp/wasm-hash-pin.json，
 * 并校验两份拷贝是否逐字节一致。
 *
 * 两份文件的角色：`pkg/` 是 wasm-pack 的输出目录，`web/` 那份由
 * `apps/game/package.json` 的 `build:wasm` 在 `wasm-pack build` 之后 `copyFileSync` 复制过去，
 * 浏览器侧实际加载的是 `web/` 那份。
 *
 * 落盘 JSON 的字段：`file` / `sha256` / `bytes` / `webCopy{path,sha256,matches}` /
 * `baselineBeforeT3` / `changedFromBaseline` / `generatedBy` / `schemaVersion`。
 * `changedFromBaseline` 只做一件事：把本次 `pkg` 的 sha256 与同一对象里写死的
 * `baselineBeforeT3` 字面量比较（两者都在本文件内，不读外部文件）。
 *
 * 前置：`apps/game/pkg` 由 `npm run build:wasm` 产出、`apps/game/web` 的那份由同一脚本复制；
 * `temp/` 目录由本脚本 `mkdirSync` 自建，且被 `.gitignore` 忽略，产物可随时重建。
 *
 * 用法：在 `apps/game` 下执行 `node scripts/wasm-hash-pin.mjs`。
 * 退出码：0 = 两份拷贝 sha256 相同；1 = 不同（stdout 已先打印 pin 内容，stderr 打 FAIL 行）。
 */
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
// pin 对象的字段即落盘内容；webCopy.matches 是唯一的判据来源
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
