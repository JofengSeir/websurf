/**
 * viewer 打包：把 `web/` 下的产物与源码切片装配进 `viewer/dist/`（本脚本唯一的输出目录）。
 *
 * 两种模式共用同一批公共产物，差别只在 app/worker/wasm 的形态：
 * - **single（默认）**：app 打成 IIFE，WASM(base64) 与录像解析 Worker 代码一并内嵌进 app.js，
 *   `index.html` 改写成 classic `<script>`（file:// 下 module script 会被浏览器拦），供本地双击；
 * - **multi（`--multi`）**：复制 `web/` 的 ESM 产物与外置 `websurf_viewer_wasm_bg.wasm`，另生成
 *   `wasm-embedded.js`（fetch 失败时的内嵌回退副本），并把预缓存清单注入
 *   `src/web/coi-serviceworker.js` 后写进 dist，供 Pages 部署。
 *
 * 公共产物（两种模式都写）：`.nojekyll`、`serve.py`（内联生成）、`play.cmd` / `play.sh`（内联生成：起静态服务 + 延时 1s 开浏览器），
 * 以及存在时的 `assets/maps/surf_null_4.replay` 示例录像。
 * single 侧额外：`index.html` / `app.js` / `styles.css`；
 * multi 侧额外：`index.html` / `app.js` / `worker.js` / `styles.css` /
 * `websurf_viewer_wasm_bg.wasm` / `wasm-embedded.js` / `coi-serviceworker.js`。
 *
 * 重建策略：先 `cleanDist` 清空 dist，写完再用 `cleanStale` 删掉不在保留清单里的残留，
 * 避免上一次另一种模式的产物留在目录里。打包内核（esbuild 注入、`__VBSP_*` 拼装、index 改写）
 * 在 `src/scripts/lib/dist-pack.mjs`。
 *
 * 用法（在 `apps/viewer/` 下）：
 *   node scripts/build-dist.mjs            # single → dist/
 *   node scripts/build-dist.mjs --multi    # multi → dist/
 */
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  bundleIife,
  writeEmbeddedPreamble,
  rewriteIndexToClassicScript,
  cleanDist,
  cleanStale,
  distLaunchers,
  printTree,
} from '../../../src/scripts/lib/dist-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(HERE, '..'); // apps/viewer
const repoRoot = join(viewerRoot, '..', '..'); // 仓库根
const dist = join(viewerRoot, 'dist');
const MTZ = join(repoRoot, 'src', 'materials', 'textures.mtz'); // 默认纹理包（仓库根共享资产）
const VMTS = join(repoRoot, 'src', 'materials', 'vmts-fallback.json'); // 回退 VMT 文本表（游戏本体自带材质）

const multi = process.argv.includes('--multi');

const APP_SRC = join(viewerRoot, 'src/app.ts');
const WORKER_SRC = join(viewerRoot, 'src/worker/main.ts');
const HEADER = '/* WebSurf-viewer single-file build — auto-generated, do not edit */\n';
const KEEP_SINGLE = [
  '.nojekyll',
  'serve.py',
  'play.cmd',
  'play.sh',
  'index.html',
  'app.js',
  'styles.css',
];
const KEEP_MULTI = [
  ...KEEP_SINGLE.filter((f) => f !== 'index.html' && f !== 'app.js'),
  'index.html',
  'app.js',
  'worker.js',
  'websurf_viewer_wasm_bg.wasm',
  'wasm-embedded.js',
  'textures.mtz',
  'vmts.json',
  'coi-serviceworker.js',
];

const { servePy: SERVE_PY, playCmd: PLAY_CMD, playSh: PLAY_SH } = distLaunchers({
  appName: 'WebSurf-viewer',
  port: 8101,
  // 只有 viewer 认 ?replay= 深链，故示例录像只在这里出现
  demoReplay: 'assets/maps/surf_null_4.replay',
});


async function rebuildDist() {
  // 全量重建：先清空 dist，产物只由本轮写入（不留上一次的残留）
  await cleanDist(dist);
  await mkdir(join(dist, 'assets', 'maps'), { recursive: true });

  // ── 两种模式共用的产物 ──────────────────────────────────────────────
  await writeFile(join(dist, '.nojekyll'), '');
  await writeFile(join(dist, 'serve.py'), SERVE_PY);
  // play.cmd **已经是 CRLF**（`distLaunchers` 里转好的）：cmd.exe 解析 LF-only 批处理会把行撕开执行，
  // 这一步不能漏、也不能在这里再转一次（会把 \r\n 变成 \r\r\n）
  await writeFile(join(dist, 'play.cmd'), PLAY_CMD);
  await writeFile(join(dist, 'play.sh'), PLAY_SH);

  // ── 示例录像（深链演示用；本地夹具缺失时告警并跳过）──────────────
  await mkdir(join(dist, 'assets', 'maps'), { recursive: true });
  for (const name of ['surf_null_4.replay']) {
    const srcReplay = join(repoRoot, 'test', 'replay', name);
    if (existsSync(srcReplay)) {
      await copyFile(srcReplay, join(dist, 'assets/maps', name));
    } else {
      console.warn(`[WARN] 示例资产缺失，跳过: test/replay/${name}（dist 示例深链将不可用）`);
    }
  }

  if (multi) {
    // ── multi：web/ 的 ESM 产物 + 外置 wasm + 内嵌回退副本 ────
    console.log('[multi] 复制 web/ 产物（app.js/worker.js/styles.css/index.html）…');
    await copyFile(join(viewerRoot, 'web/index.html'), join(dist, 'index.html'));
    await copyFile(join(viewerRoot, 'web/app.js'), join(dist, 'app.js'));
    await copyFile(join(viewerRoot, 'web/worker.js'), join(dist, 'worker.js'));
    await copyFile(join(viewerRoot, 'web/styles.css'), join(dist, 'styles.css'));
    console.log('[multi] 复制外置 WASM …');
    const wasmMulti = join(dist, 'websurf_viewer_wasm_bg.wasm');
    await copyFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'), wasmMulti);
    // 默认纹理包外置（缺失纹理回退的数据源，2026-10-04 起与 game 同款）
    await copyFile(MTZ, join(dist, 'textures.mtz'));
    console.log('[multi] 复制 textures.mtz（缺失纹理回退数据源）…');
    // 回退 VMT 文本表：缺 VMT 的游戏本体材质靠它拿真实参数（取不到只降级，不编造）
    await copyFile(VMTS, join(dist, 'vmts.json'));
    console.log('[multi] 生成 wasm-embedded.js（fetch 失败时的内嵌回退副本）…');
    const wasmBytes = await readFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'));
    await writeFile(
      join(dist, 'wasm-embedded.js'),
      `/* WebSurf-viewer WASM 内嵌回退副本（fetch 失败时由 bsp.ts 动态加载）—— auto-generated */\n` +
        `globalThis.__VBSP_WASM_B64__ = "${wasmBytes.toString('base64')}";\n`,
    );

    // 预缓存清单与「内容哈希派生的缓存名」一起注入 SW 模板（multi 专用）
    const precacheManifest = [
      './index.html',
      './app.js',
      './worker.js',
      './websurf_viewer_wasm_bg.wasm',
      './wasm-embedded.js',
      './textures.mtz',
      './vmts.json',
      './styles.css',
      './coi-serviceworker.js',
    ].filter((f) => existsSync(join(dist, f.slice(2)))); // 仅存在的文件（去掉 './' 前缀）

    const swTemplate = (await readFile(join(viewerRoot, '..', '..', 'src', 'web', 'coi-serviceworker.js'), 'utf8')).replace(/\r\n/g, '\n');
    // 缓存名由「清单 + 各文件内容」的 sha256 派生：内容变 → SW 字节变 → 浏览器触发 install → 缓存刷新；
    // 固定缓存名会让 SW 字节不变，部署后长期命中旧缓存。
    const cacheHash = createHash('sha256');
    cacheHash.update(JSON.stringify(precacheManifest));
    for (const entry of precacheManifest) {
      const abs = join(dist, entry.slice(2));
      if (existsSync(abs)) { cacheHash.update(entry); cacheHash.update(await readFile(abs)); }
    }
    const cacheName = 'websurf-coi-' + cacheHash.digest('hex').slice(0, 12);
    const swWithManifest = swTemplate
      .replace(
        'const PRECACHE_MANIFEST =\n  typeof __PRECACHE_MANIFEST__ === "object" && __PRECACHE_MANIFEST__ ? __PRECACHE_MANIFEST__ : [];',
        `const PRECACHE_MANIFEST = ${JSON.stringify(precacheManifest)};`
      )
      .replace(
        'const CACHE_NAME = typeof __CACHE_NAME__ === "string" ? __CACHE_NAME__ : "websurf-coi-dev";',
        `const CACHE_NAME = ${JSON.stringify(cacheName)};`
      );
    if (
      swWithManifest.includes('typeof __PRECACHE_MANIFEST__') ||
      swWithManifest.includes('typeof __CACHE_NAME__')
    ) {
      throw new Error(
        '[build-dist] SW 占位符未被替换：src/web/coi-serviceworker.js 的声明行与构建脚本不一致'
      );
    }
    await writeFile(join(dist, 'coi-serviceworker.js'), swWithManifest);
    console.log(`[multi] 注入 SW 预缓存清单: ${precacheManifest.length} 个资源`);

    await cleanStale(dist, KEEP_MULTI);
    return;
  }

  // ── single：app 打成 IIFE（WASM 与 Worker 内嵌），index.html 改写成 classic script ──
  console.log('[single] 编码 WASM → base64 …');
  const wasmBytes = await readFile(join(viewerRoot, 'web/websurf_viewer_wasm_bg.wasm'));
  const wasmB64 = wasmBytes.toString('base64');

  console.log('[single] 打包录像解析 Worker（IIFE，Blob URL 用）…');
  const workerCode = await bundleIife({
    build,
    entry: WORKER_SRC,
    options: { logLevel: 'warning' },
  });

  console.log('[single] 打包 app（IIFE + 内嵌）…');
  const appCode = await bundleIife({
    build,
    entry: APP_SRC,
    options: { logLevel: 'warning' },
  });

  console.log('[single] 写入 dist/（classic index.html + 内嵌 app.js + styles.css）…');
  await writeEmbeddedPreamble({
    distDir: dist,
    appCode,
    headerComment: HEADER,
    wasmB64,
    workerJs: workerCode,
    mtzB64: (await readFile(MTZ)).toString('base64'),
  });
  const rewritten = await rewriteIndexToClassicScript({
    webIndex: join(viewerRoot, 'web/index.html'),
    distIndex: join(dist, 'index.html'),
  });
  if (!rewritten) {
    console.warn('[WARN] web/index.html 未命中 module script 特征串，dist/index.html 可能仍是 module script。');
  }
  await copyFile(join(viewerRoot, 'web/styles.css'), join(dist, 'styles.css'));

  await cleanStale(dist, KEEP_SINGLE);
}

rebuildDist()
  .then(async () => {
    console.log(`[${multi ? 'multi（Pages 部署）' : 'single（file:// 双击）'}] 打包完成 → ${dist}`);
    console.log((await printTree(dist)).join('\n'));
  })
  .catch((err) => {
    console.error(`[ERROR] dist build failed: ${err?.message ?? err}`);
    console.error('[HINT] See the message above, fix the input or toolchain, then retry.');
    process.exit(1);
  });
