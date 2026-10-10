#!/usr/bin/env node
/**
 * 把唯一的默认纹理包 [src/materials/textures.mtz] 同步到三端的 web/ 目录。
 *
 * 为什么需要：apps/<app>/web/textures.mtz 是本地开发副本（根 .gitignore 已忽略、不入库），
 * 而三端 scripts/build-dist.mjs 读的都是 src/materials/textures.mtz（构建产物 dist/ 自带该文件）。
 * 只有「直接以 app 目录起静态服务」的 dev 路径需要 web/ 下有实物，故在起服务前同步一次。
 *
 * 幂等：内容一致就跳过；缺源即抛错（不静默产出没有纹理的站点）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src', 'materials', 'textures.mtz');
const APPS = ['debug', 'game', 'viewer'];

if (!existsSync(SRC)) throw new Error('默认纹理包不存在：' + SRC);
const srcBuf = readFileSync(SRC);

let copied = 0;
let skipped = 0;
for (const app of APPS) {
  const dst = join(REPO, 'apps', app, 'web', 'textures.mtz');
  if (existsSync(dst) && statSync(dst).size === srcBuf.length && Buffer.compare(readFileSync(dst), srcBuf) === 0) { skipped++; continue; }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(SRC, dst);
  copied++;
}
console.log('[textures] ' + srcBuf.length + ' B => 同步 ' + copied + ' / 已一致跳过 ' + skipped);
