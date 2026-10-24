/**
 * 活态连拍（T-650 v3 U0）：同一页面会话连续截 N 帧渲染画面——观感材料专用。
 *
 * 铁律（docs/T-650-water-v3-task.md §0/§6）：观感材料禁止 pin/freeze；本脚本永不注入
 * 时间 pin。`--init` 只用于 R0 这类「改变渲染态」的开关（如 `__vbspWaterDudvOff=true`）。
 * Edge 由调用方以**硬件 GPU** 启动（不加 swiftshader 参数）。
 *
 * 用法（仓库根）：
 *   node src/scripts/capture-live.mjs --cdp http://127.0.0.1:9224 \
 *     --url "http://127.0.0.1:8123/apps/viewer/web/index.html?bsp=/test/maps/surf_boreas.bsp" \
 *     [--pose x,y,z,yaw,pitch] [--init "globalThis.__vbspWaterDudvOff=true"] \
 *     --frames 8 --interval 120 --out-prefix ".tmp/water-v3/rounds/round-base/p0"
 * 输出：<out-prefix>-f01.png … -fNN.png（同时打印逐帧时间戳，供核对实际间隔）。
 */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

function arg(name, fallback = null) {
	const i = process.argv.indexOf('--' + name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const outPrefix = arg('out-prefix');
const frames = Math.max(1, Number(arg('frames', '8')));
const interval = Math.max(30, Number(arg('interval', '120')));
const settle = Math.max(0, Number(arg('settle', '0')));
const poseArg = arg('pose');
const initScript = arg('init');
const cdp = arg('cdp', 'http://127.0.0.1:9222');
if (!url || !outPrefix) {
	console.error('缺少 --url 或 --out-prefix');
	process.exit(2);
}
mkdirSync(dirname(outPrefix), { recursive: true });

const targets = await (await fetch(cdp + '/json/list')).json();
let target = targets.find((t) => t.type === 'page');
if (!target) target = await (await fetch(cdp + '/json/new?about:blank', { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.addEventListener('open', resolve, { once: true });
	ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
	const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(JSON.stringify(msg.error)));
		else resolve(msg.result);
		return;
	}
	if (msg.method === 'Runtime.exceptionThrown') {
		console.log('[exception] ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? ''));
	}
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
	const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
	return r.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
if (initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
await send('Page.navigate', { url });

const started = Date.now();
let mounted = false;
while (Date.now() - started < 30000) {
	try { mounted = await evaluate('!!globalThis.__vbspRenderProbe'); } catch { /* 导航中 */ }
	if (mounted) break;
	await sleep(300);
}
if (!mounted) throw new Error('__vbspRenderProbe 未挂载：页面没起来？');

let state = null;
while (Date.now() - started < 300000) {
	try {
		state = await evaluate('(() => { const p = globalThis.__vbspRenderProbe; return p ? { merge: p.snapshot().merge } : null; })()');
		if (state?.merge) break;
	} catch { /* 解析/装配中 */ }
	await sleep(700);
}
if (!state?.merge) throw new Error('场景未完成合并（等待超时）');

// --settle：装配完成后先让页面**开着**放置指定毫秒再拍（滚动偏移随真实时间推进，
// 用于时相探针——T-650 v3 §1.2 的机制里，位移采样窗口的位置是时变的）。
if (settle > 0) {
	console.log('[live] settle ' + settle + 'ms（页面保持打开，时间自然推进）');
	await sleep(settle);
}

if (poseArg) {
	const pose = (() => {
		const [x, y, z, yawDeg, pitchDeg] = poseArg.split(',').map(Number);
		if ([x, y, z, yawDeg, pitchDeg].some((v) => !Number.isFinite(v))) throw new Error('--pose 需要 x,y,z,yaw,pitch');
		return { pos: [x, y, z], yawDeg, pitchDeg };
	})();
	const applied = await evaluate(`(async () => {
		const e = globalThis.__vbspPose;
		if (!e) return { ok: false, why: '__vbspPose 未挂载' };
		return { ok: true, pose: await e.setPose(${JSON.stringify(pose)}) };
	})()`);
	if (!applied?.ok) throw new Error('位姿未应用：' + JSON.stringify(applied));
	await sleep(2500);
}

// 只留 canvas（与 capture-render 同约定：观感材料不含 DOM HUD）。
await evaluate(`(() => {
	const s = document.createElement('style');
	s.textContent = 'body *{visibility:hidden!important} canvas{visibility:visible!important}';
	document.head.appendChild(s);
})()`);
await sleep(300);
const rect = await evaluate(`(() => {
	const c = document.querySelector('canvas');
	if (!c) return null;
	const r = c.getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
if (!rect) throw new Error('找不到 canvas');

// 确认没有 time pin/freeze（保真防线：活态材料里绝不允许出现钉死的时间）。
const frozenCheck = await evaluate(`(() => {
	const g = globalThis;
	const pin = g.__vbspWaterTimePin;
	const frozen = g.__vbspWaterTime;
	const dbg = g.__vbspWaterDebug ?? {};
	return { pin: pin === undefined ? null : pin, frozen: frozen === undefined ? null : frozen, time: dbg.time };
})()`);
if (frozenCheck.pin !== null || frozenCheck.frozen !== null) {
	throw new Error('活态保真违规：检测到 __vbspWaterTimePin/__vbspWaterTime = ' + JSON.stringify(frozenCheck));
}
console.log('[live] time=' + frozenCheck.time + '（未钉，随帧推进）');

const stamps = [];
for (let i = 1; i <= frames; i++) {
	const shot = await send('Page.captureScreenshot', {
		format: 'png',
		clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
	});
	const file = outPrefix + '-f' + String(i).padStart(2, '0') + '.png';
	writeFileSync(file, Buffer.from(shot.data, 'base64'));
	stamps.push(Date.now());
	console.log('[live] ' + file + ' (t+' + (stamps[stamps.length - 1] - stamps[0]) + 'ms)');
	if (i < frames) await sleep(interval);
}
const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
console.log('[live] 帧间隔实际值：' + gaps.join(',') + ' ms（目标 ' + interval + '）');
ws.close();
process.exit(0);
