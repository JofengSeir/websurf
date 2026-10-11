#!/usr/bin/env node
/**
 * 把共享 web 资产同步到三端的 web/ 目录（单一来源 → 三端本地副本）。
 *
 * 同步两项：
 *   1. [src/materials/textures.mtz] → apps/<app>/web/textures.mtz（默认纹理包）
 *   2. [src/web/coi-serviceworker.js] → apps/<app>/web/coi-serviceworker.js（COOP/COEP 补头 SW）
 *
 * 为什么需要：这两个文件在 apps/<app>/web/ 下都是**本地开发副本**（根 .gitignore 已忽略、不入库）。
 * 构建产物 dist/ 不走本脚本——三端 scripts/build-dist.mjs 直接读共享源（src/materials、src/web）。
 * 只有「直接以 app 目录起静态服务」的 dev 路径需要 web/ 下有实物，故在起服务前同步一次。
 *
 * 幂等：内容一致就跳过；缺源即抛错（不静默产出没有纹理 / 没有隔离头的站点）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = ['debug', 'game', 'viewer'];
const ASSETS = [
  { name: 'textures.mtz', src: join(REPO, 'src', 'materials', 'textures.mtz') },
  { name: 'coi-serviceworker.js', src: join(REPO, 'src', 'web', 'coi-serviceworker.js') },
];

for (const a of ASSETS) if (!existsSync(a.src)) throw new Error('共享资产不存在：' + a.src);

for (const a of ASSETS) {
  const srcBuf = readFileSync(a.src);
  let copied = 0;
  let skipped = 0;
  for (const app of APPS) {
    const dst = join(REPO, 'apps', app, 'web', a.name);
    if (existsSync(dst) && statSync(dst).size === srcBuf.length && Buffer.compare(readFileSync(dst), srcBuf) === 0) { skipped++; continue; }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(a.src, dst);
    copied++;
  }
  console.log('[web-assets] ' + a.name + ' ' + srcBuf.length + ' B => 同步 ' + copied + ' / 已一致跳过 ' + skipped);
}
