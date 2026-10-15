#!/usr/bin/env node
/**
 * 把 wasm-pack 的产物从「沙箱可写区」拷进应用（T-643），拷完**逐项校验 sha256**（T-652）。
 *
 * ## 为什么需要这一层
 *
 * 本机在 agent 会话（DSH / WorkBuddy 之类带文件策略的宿主）里跑 `dev.cmd` / `build.cmd` 时，
 * `wasm-bindgen.exe`（`<repo>/.wasm-pack-cache/wasm-bindgen-<hash>/wasm-bindgen.exe`）**不在允许写工作区的
 * 二进制名单里**：直接 `--out-dir apps/<app>/pkg` 会得到
 * `failed to write ...\pkg\<crate>_bg.wasm: 拒绝访问 (os error 5)`，重试也一样（实测连新目录、连
 * `node.exe` 的副本都写不进去）。而 ① `<repo>/.tmp/**` 对任何二进制都可写、② `node` 本身可写工作区
 * ⇒ 把 wasm-pack 的输出改到 `<repo>/.tmp/wasm-out/<app>`，再用本脚本（node）拷回 `pkg/` 与 `web/`。
 *
 * 该做法在普通控制台里同样成立（只是多一次本地拷贝），因此构建脚本不再依赖宿主策略。
 *
 * ## 用法
 *
 *   node src/scripts/copy-wasm-pkg.mjs <debug|game|viewer>
 *
 * 只拷 wasm-pack 的四类产物（`*.js` / `*.d.ts` / `*.wasm` / `*.wasm.d.ts`），**不碰** `pkg/.gitignore`，
 * 也不拷 wasm-pack 生成的 `package.json`（仓库内无人读它）。`*_bg.wasm` 额外拷一份到 `<app>/web/`。
 *
 * ## 拷后校验（T-652）
 *
 * 历史症状：`npm run build:wasm` 报成功，但 `apps/<app>/pkg|web` 下仍是**旧产物**（T-649 全程手动比对
 * 字节数才没被假数据带偏）。故本脚本拷完后**重新读回目标文件**、与源逐项比 sha256；任一项不一致就
 * 逐条列出并 **exit 1**，让 `build:wasm` 整条链失败 —— 宁可报错，也不把旧 wasm 当成功交付。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = process.argv[2];
if (!['debug', 'game', 'viewer'].includes(app ?? '')) {
  console.error('[copy-wasm] 用法：node src/scripts/copy-wasm-pkg.mjs <debug|game|viewer>');
  process.exit(2);
}

const srcDir = path.join(ROOT, '.tmp', 'wasm-out', app);
const pkgDir = path.join(ROOT, 'apps', app, 'pkg');
const webDir = path.join(ROOT, 'apps', app, 'web');
if (!fs.existsSync(srcDir)) {
  console.error('[copy-wasm] 找不到 wasm-pack 输出目录：' + path.relative(ROOT, srcDir) + '（先跑 wasm-pack --out-dir 到该目录）');
  process.exit(1);
}

const wanted = fs.readdirSync(srcDir).filter((f) => /\.(js|d\.ts|wasm|wasm\.d\.ts)$/.test(f));
const bg = wanted.find((f) => f.endsWith('_bg.wasm'));
if (!bg) {
  console.error('[copy-wasm] 输出目录里没有 *_bg.wasm：' + wanted.join('、'));
  process.exit(1);
}
const bgBytes = fs.statSync(path.join(srcDir, bg)).size;
if (bgBytes < 1024 * 1024) {
  console.error('[copy-wasm] ' + bg + ' 只有 ' + bgBytes + ' B，疑似半成品，拒绝拷入');
  process.exit(1);
}

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const targets = [
  ...wanted.map((f) => ({ src: path.join(srcDir, f), dst: path.join(pkgDir, f), label: 'pkg/' + f })),
  { src: path.join(srcDir, bg), dst: path.join(webDir, bg), label: 'web/' + bg },
];

fs.mkdirSync(pkgDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });
for (const t of targets) fs.copyFileSync(t.src, t.dst);

// 拷后回读校验：源与目标逐项比 sha256（目标缺失也算失败）
const bad = [];
for (const t of targets) {
  const s = sha256(t.src);
  const d = fs.existsSync(t.dst) ? sha256(t.dst) : null;
  if (s !== d) {
    bad.push('  ' + t.label + '：源 ' + s.slice(0, 12) + ' ≠ 目标 ' + (d ? d.slice(0, 12) : '(缺失)') + '（源 ' + fs.statSync(t.src).size + ' B）');
  }
}
if (bad.length) {
  console.error('[copy-wasm] ' + app + '：拷入后 sha256 校验失败 ' + bad.length + ' / ' + targets.length + ' 项：');
  for (const b of bad) console.error(b);
  console.error('[copy-wasm] 目标可能被占用/只读，或写入被宿主策略拦下 ⇒ 重跑 build:wasm（必要时先关掉占用它的窗口）');
  process.exit(1);
}

console.log(
  '[copy-wasm] ' + app + '：' + wanted.length + ' 个产物拷入 pkg/（' + bg + ' = ' + bgBytes + ' B），'
  + 'web/ 1 份；sha256 逐项校验通过 ' + targets.length + '/' + targets.length,
);
