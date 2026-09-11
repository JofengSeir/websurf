#!/usr/bin/env node
/**
 * 跳跃顶高 A/B 实测服务（**不改仓库任何源文件**）。
 *
 * 背景：headless 无法拿 pointer lock，`app.ts` 的输入循环会把按键掩码强制置 0，
 * 因此必须注入一个「输入覆盖槽 + 只读探针」。但把 hook 插进仓库文件会与其它 agent
 * 的工作冲突，故这里**全部在内存里打补丁**：
 *   · 按请求实时 esbuild 打包 src/app.ts / src/worker/main.ts；
 *   · 打包前把源码拷进 OS 临时目录（仓库外），在**副本**上做字符串补丁；
 *   · HTTP 层补齐 COOP/COEP（SharedArrayBuffer 必需）+ 正确 MIME。
 *
 * 变体（`X-Variant` 或 `?variant=`，默认 fixed）：
 *   fixed   = 现状（worker-dispatch.ts 的「常规重锚=只播位置」分支）
 *   reverted= 把该分支临时改回修复前的**全态注入**（只这一处；authority-calibrator 的
 *             land 门保持仓库现状）
 *
 * 补丁标记会被写进产物（`JUMPPROBE_PATCH` / `JUMPREVERT_PATCH`），harness 可校验。
 *
 * 用法：node scripts/jump-apex-serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG = join(HERE, '..');
const REPO = join(DEBUG, '..');
const PORT = Number(process.argv[2] ?? 8080);

const SCRATCH = join(tmpdir(), 'websurf-jump-probe');
mkdirSync(SCRATCH, { recursive: true });

/** 递归镜像目录（只拷文件，保留相对结构）。 */
function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) mirror(a, b);
    else if (e.isFile()) copyFileSync(a, b);
  }
}

/** 镜像一张「仓库视图」：debug/ + src/ + pkg/，使相对 import 原样成立。 */
function makeMirror(name) {
  const root = join(SCRATCH, name);
  mkdirSync(root, { recursive: true });
  mirror(join(DEBUG, 'src'), join(root, 'debug', 'src'));
  mirror(join(DEBUG, 'pkg'), join(root, 'debug', 'pkg'));
  mirror(join(REPO, 'src'), join(root, 'src'));
  return root;
}

const APP_ROOT = makeMirror('app');
const WORKER_ROOT = makeMirror('worker');

const patchReport = {};

// ── app.ts 补丁 ────────────────────────────────────────────────────
{
  const p = join(APP_ROOT, 'debug', 'src', 'app.ts');
  let s = readFileSync(p, 'utf8');
  const anchor = 'const sharedStateInstance = createMainSharedState(sharedBuffer, worker);';
  if (!s.includes(anchor)) throw new Error('app.ts 锚点缺失');
  if (!s.includes('__jumpProbe')) {
    s = s.replace(
      anchor,
      `${anchor}
	// JUMPPROBE_PATCH: 只读探针（测量专用，仓库外的临时副本）
	(globalThis as { __jumpProbe?: unknown }).__jumpProbe = {
		__jumpProbePatch: true,
		state: () => rendererMain?.getCurrentState() ?? null,
		auth: () => {
			const a = sharedStateInstance.readAuthoritative();
			return a ? { va: a.va, frame: { posY: a.frame.pos.y, velY: a.frame.vel.y, onGround: a.frame.onGround, timeMs: a.frame.timeMs } } : null;
		},
	};`,
    );
  }
  const maskRe = /(\t*)(?:let|const) mask = pointerLock\.isLocked\(\) \? keysToMask\(keys\) : 0;/;
  if (!maskRe.test(s)) throw new Error('app.ts 掩码锚点缺失');
  if (!s.includes('__jumpMask')) {
    s = s.replace(
      maskRe,
      `$1let mask = pointerLock.isLocked() ? keysToMask(keys) : 0;
$1// JUMPPROBE_PATCH: 测量脚本注入的按键掩码（绕过 pointer lock）
$1{ const m = (globalThis as { __jumpMask?: number }).__jumpMask; if (typeof m === 'number') mask = m; }`,
    );
  }
  // Worker 变体透传：主页面 ?variant=reverted → 子 Worker 也加载回退版
  const workerRe = /worker = new Worker\('\.\/worker\.js', \{ type: 'module' \}\);/;
  if (!workerRe.test(s)) throw new Error('app.ts Worker 构造锚点缺失');
  if (!s.includes('__workerVariantPatch')) {
    s = s.replace(
      workerRe,
      `const __workerVariantPatch = new URLSearchParams(location.search).get('variant') ?? 'fixed';
		worker = new Worker('./worker.js?variant=' + __workerVariantPatch, { type: 'module' });
		console.log('[app] JUMPPROBE worker variant =', __workerVariantPatch);`,
    );
  }
  writeFileSync(p, s, 'utf8');
  patchReport.app = {
    file: p,
    probe: s.includes('__jumpProbePatch'),
    maskCode: s.includes('globalThis as { __jumpMask?: number }'),
    workerVariant: s.includes('__workerVariantPatch'),
  };
}

// ── worker 依赖（worker-dispatch.ts）补丁 ──────────────────────────
const WD = join(REPO, 'src', 'ts-shared', 'auth', 'worker-dispatch.ts');
const WD_FIXED = readFileSync(WD, 'utf8');
const startTok = 'if (sm.teleport === false) {';
const tailTok = '      if ((env.getComputeMode';
const i0 = WD_FIXED.lastIndexOf(startTok);
const i1 = WD_FIXED.indexOf(tailTok, i0);
if (i0 < 0 || i1 < 0) throw new Error('worker-dispatch.ts 修复分支锚点缺失');
const REVERTED_BLOCK = `if (sm.teleport === false) {
        // JUMPREVERT_PATCH: 修复前行为——全态注入（含渲染的 onGround / 速度）
        const __jumpRevertPatch = true;
        void __jumpRevertPatch;
        env.phys.current.set_state(
          s.posX, s.posY, s.posZ, s.yaw, s.pitch,
          s.velX, s.velY, s.velZ, s.onGround,
        );
        return;
      }
      env.phys.current.set_state(
        s.posX, s.posY, s.posZ, s.yaw, s.pitch,
        s.velX, s.velY, s.velZ, s.onGround,
      );
`;
const WD_REVERTED = WD_FIXED.slice(0, i0) + REVERTED_BLOCK + WD_FIXED.slice(i1);

const WD_SCRATCH_FIXED = join(WORKER_ROOT, 'src', 'ts-shared', 'auth', 'worker-dispatch.ts');
// 回退版**必须落在同一目录**（worker-dispatch.ts 自己还有 `./shared-state.js` 等同目录 import）
const WD_SCRATCH_REVERTED = join(WORKER_ROOT, 'src', 'ts-shared', 'auth', 'worker-dispatch.reverted.ts');
writeFileSync(WD_SCRATCH_REVERTED, WD_REVERTED, 'utf8');
patchReport.workerDispatch = {
  fixedLen: WD_FIXED.length,
  revertedLen: WD_REVERTED.length,
  revertedHasMarker: WD_REVERTED.includes('__jumpRevertPatch'),
};

/** 把 worker-dispatch 依赖重定向到补丁副本的 esbuild 插件。 */
function redirectPlugin(scratchWd) {
  return {
    name: 'redirect-worker-dispatch',
    setup(build) {
      build.onResolve({ filter: /worker-dispatch(\.js|\.ts)?$/ }, (args) => {
        if (args.path.startsWith('.') || args.path.includes('ts-shared')) {
          return { path: scratchWd };
        }
        return null;
      });
    },
  };
}

const COMMON = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'silent',
  // 临时目录在仓库外 → 手动指回仓库的 node_modules（three 等）
  nodePaths: [join(DEBUG, 'node_modules')],
};

const cache = new Map();
async function bundle(kind, variant) {
  const key = `${kind}:${variant}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  if (kind === 'app') {
    result = await esbuild.build({
      ...COMMON,
      entryPoints: [join(APP_ROOT, 'debug', 'src', 'app.ts')],
      write: false,
    });
  } else {
    // variant: fixed = 仓库现状（修复 A+B）；reverted = A 回退（B 保留）；
    //          AfixedBon / AoffB = 同义别名，便于报告里对照
    const useReverted = variant === 'reverted' || variant === 'AoffB';
    const wd = useReverted ? WD_SCRATCH_REVERTED : WD_SCRATCH_FIXED;
    result = await esbuild.build({
      ...COMMON,
      entryPoints: [join(WORKER_ROOT, 'debug', 'src', 'worker', 'main.ts')],
      plugins: [redirectPlugin(wd)],
      write: false,
    });
  }
  const code = result.outputFiles[0].text;
  const info = {
    code,
    hasProbe: code.includes('__jumpProbePatch'),
    hasMask: code.includes('globalThis.__jumpMask'),
    hasRevert: code.includes('__jumpRevertPatch'),
  };
  cache.set(key, info);
  return info;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.mtz': 'application/octet-stream',
  '.bsp': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawVariant = url.searchParams.get('variant') ?? 'fixed';
  // 只有明确的「回退 A」变体才走回退产物；其余（含 AfixedBon/未知值）= 仓库现状
  const variant = rawVariant === 'reverted' || rawVariant === 'AoffB' ? 'reverted' : 'fixed';
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
  try {
    if (url.pathname === '/web/app.js') {
      const b = await bundle('app', variant);
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.js'], 'X-Probe': String(b.hasProbe), 'X-Mask': String(b.hasMask) });
      res.end(b.code);
      console.log(`[serve] app.js variant=${variant} probe=${b.hasProbe} mask=${b.hasMask}`);
      return;
    }
    if (url.pathname === '/web/worker.js') {
      const b = await bundle('worker', variant);
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.js'], 'X-Revert': String(b.hasRevert) });
      res.end(b.code);
      console.log(`[serve] worker.js variant=${variant} revertMarker=${b.hasRevert} len=${b.code.length}`);
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = join(DEBUG, rel);
    if (!file.startsWith(DEBUG + sep) && file !== DEBUG) {
      res.writeHead(403, headers);
      res.end('forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, headers);
      res.end('not found: ' + url.pathname);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (e) {
    console.error('[serve] error:', e);
    res.writeHead(500, headers);
    res.end('error: ' + (e instanceof Error ? e.message : String(e)));
  }
});

// 预热两种变体（保证首个请求不超时）
await bundle('app', 'fixed');
await bundle('worker', 'fixed');
await bundle('worker', 'reverted');
console.log('[serve] patch report', JSON.stringify(patchReport, null, 2));
server.listen(PORT, () => console.log(`[serve] http://localhost:${PORT}/web/index.html  (COOP/COEP, variant=fixed|reverted)`));
