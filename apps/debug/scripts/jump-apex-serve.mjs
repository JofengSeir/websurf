#!/usr/bin/env node
/**
 * 跳跃顶高 A/B 实测用的本地服务（**不改仓库任何源文件**）。
 *
 * 为什么在临时目录里打补丁：headless 拿不到 pointer lock，`apps/debug/src/app.ts` 的输入循环
 * 会把按键掩码置 0，而测量需要「只读探针 + 输入覆盖槽」；直接把 hook 写进仓库文件会与其它工作
 * 冲突，因此补丁只落在 OS 临时目录的副本上。
 *
 * 镜像：`makeMirror` 把 `apps/debug/src`、`apps/debug/pkg` 与仓库根 `src` 递归拷进
 * `<tmpdir>/websurf-jump-probe/<app|worker>/`，并保持相对层级，使副本里的相对 import 原样成立；
 * 两份镜像分别供主线程入口（app.ts）与 Worker 入口（worker/main.ts）使用。
 *
 * 补丁一（改的是镜像里的 `apps/debug/src/app.ts` 副本；注入内容带标记 JUMPPROBE_PATCH）：
 *   · 在 `createMainSharedState(...)` 之后挂 `globalThis.__jumpProbe`：`state()` 转发
 *     `rendererMain?.getCurrentState()`，`auth()` 给出共享通道里权威帧的只读快照；
 *   · 把按键掩码那一行改成「`globalThis.__jumpMask` 是数字就覆盖」；
 *   · 把 `new Worker('./worker.js', …)` 改成带 `?variant=` 的 URL，使主页面的查询串透传给子 Worker。
 *   三个锚点（`createMainSharedState` 的调用行、掩码行、Worker 构造行）任一未命中即抛错，不产出半成品。
 *
 * 补丁二（对象是仓库根 `src/ts-shared/auth/worker-dispatch.ts`；生成的替换块带标记 JUMPREVERT_PATCH）：
 *   按**源码文本切片**生成回退版 —— 取最后一个 `if (sm.teleport === false) {` 到其后的
 *   `if ((env.getComputeMode` 之间的整段，替换为「该分支同样做全量 set_state（位置/角度/速度/onGround）」
 *   的块，并写到与原件同目录的 `worker-dispatch.reverted.ts`（同目录是为了它的相对 import 仍可解析）；
 *   两个切片锚点任一缺失即抛错。esbuild 侧由 `redirectPlugin` 把 `worker-dispatch(.js|.ts)` 的导入
 *   重定向到选定的那一份。
 *
 * 变体选择：只认查询串 `?variant=`，取值 `reverted` 或 `AoffB` 时用回退版，其余取值（含缺省）
 * 一律用仓库现状那份。主线程 app.js 的产物与变体无关（变体只影响 Worker 的依赖），
 * 两份产物仍按 `kind:variant` 分开缓存。
 *
 * 路由与响应头：`/web/app.js`、`/web/worker.js` 返回 esbuild 的内存产物（分别附 `X-Probe`/`X-Mask`
 * 与 `X-Revert`，供测量脚本核对补丁是否真的生效）；其余路径按 `apps/debug` 下的真实文件返回
 * （越界 403、不存在 404、异常 500）；所有响应都带 COOP `same-origin` + COEP `require-corp` +
 * CORP `cross-origin` + `Cache-Control: no-store`。启动时先预热 app/fixed、worker/fixed、
 * worker/reverted 三份产物，并把补丁报告打到 stdout。
 *
 * 用法：node scripts/jump-apex-serve.mjs [port]      （默认端口 8080）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG = join(HERE, '..');
const REPO = join(DEBUG, '..', '..');
const PORT = Number(process.argv[2] ?? 8080);

const SCRATCH = join(tmpdir(), 'websurf-jump-probe');
mkdirSync(SCRATCH, { recursive: true });

/** 递归把目录里的文件拷到目标（保留相对结构；既非目录又非普通文件的项跳过）。 */
function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) mirror(a, b);
    else if (e.isFile()) copyFileSync(a, b);
  }
}

/** 造一张「仓库视图」镜像：debug/src + debug/pkg + 仓库根 src，使相对 import 原样成立。 */
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

// ── 镜像里的 app.ts：探针 + 掩码覆盖 + Worker 变体透传 ─────────────
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
  // Worker 变体透传：主页面查询串里的 variant 透传给子 Worker 的 URL
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

// ── worker-dispatch.ts：按源码文本切片生成回退版 ──────────────────
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
// 回退版必须与原文件同目录：worker-dispatch.ts 还有 ./shared-state.js 这类同目录 import
const WD_SCRATCH_REVERTED = join(WORKER_ROOT, 'src', 'ts-shared', 'auth', 'worker-dispatch.reverted.ts');
writeFileSync(WD_SCRATCH_REVERTED, WD_REVERTED, 'utf8');
patchReport.workerDispatch = {
  fixedLen: WD_FIXED.length,
  revertedLen: WD_REVERTED.length,
  revertedHasMarker: WD_REVERTED.includes('__jumpRevertPatch'),
};

/** esbuild 插件：把 worker-dispatch 的导入重定向到选定的那份副本。 */
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
  // 临时目录在仓库外：手动把裸导入（three 等）指回 apps/debug/node_modules
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
    // variant：fixed 用仓库现状的 worker-dispatch；reverted 用切片生成的回退版；
    //          AfixedBon / AoffB 是与二者同义的别名，便于报告里对照
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
  // 只把明确的回退取值映射到回退产物；其余取值与缺省一律走仓库现状
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

// 预热三份产物：让首个请求不再现打包，避免测量端超时
await bundle('app', 'fixed');
await bundle('worker', 'fixed');
await bundle('worker', 'reverted');
console.log('[serve] patch report', JSON.stringify(patchReport, null, 2));
server.listen(PORT, () => console.log(`[serve] http://localhost:${PORT}/web/index.html  (COOP/COEP, variant=fixed|reverted)`));
