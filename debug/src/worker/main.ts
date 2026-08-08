/**
 * WebSurf — Worker 入口
 *
 * 初始化 WASM 模块，实例化 `PhysicsWorker`，绑定 `onmessage`。
 *
 * WASM 初始化（消息驱动）：
 * - dist 内嵌：主线程下发唯一一份 base64（`wasm-init`）→ atob → `initSync({module})`
 *   （避免 file:// 下 fetch 失败）。
 * - dev 模式：下发 `wasmUrl`，worker `fetch` 后 `init`。
 *
 * 时序：收到 `wasm-init` 才启动初始化；此前到达的消息入队缓存，就绪后按序重放。
 * `init` 消息携带共享内存（SharedArrayBuffer，可 null），到达时创建 PhysicsWorker。
 */

/// <reference lib="webworker" />

import { PhysicsWorker } from './physics-worker.js';
import { createWorkerSharedState } from './shared-state.js';
import { setMtzB64 } from './mtz-data.js';
import init, { initSync } from '../../pkg/websurf_wasm.js';
import type { WasmInitMessage, InitMessage } from './worker-types.js';

/** 已就绪标志：false 时消息入队。 */
let worker: PhysicsWorker | null = null;
let wasmReady = false;
let initStarted = false;
const pending: MessageEvent[] = [];

/** 根据主线程下发的 wasm-init 消息初始化 WASM。 */
async function startWasm(msg: WasmInitMessage): Promise<void> {
	// single 打包：默认纹理包 base64 内嵌下发（file:// 下 worker 无法 fetch）
	setMtzB64(msg.mtzB64);
	if (msg.wasmB64) {
		const bin = atob(msg.wasmB64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		// initSync 期望 {module: ArrayBuffer}（避免弃用警告）
		initSync({ module: bytes.buffer });
	} else if (msg.wasmUrl) {
		// 开发模式：fetch WASM 字节后手动 init
		const resp = await fetch(msg.wasmUrl);
		const buf = await resp.arrayBuffer();
		await init(buf);
	} else {
		throw new Error('wasm-init 消息缺少 wasmB64 / wasmUrl');
	}
	wasmReady = true;
	// 按序重放此前缓存的消息（含 init：创建 PhysicsWorker）
	for (const ev of pending) {
		dispatch(ev);
	}
	pending.length = 0;
}

/** 分发消息：首个 init 消息创建 PhysicsWorker（注入共享状态通道）。 */
function dispatch(e: MessageEvent): void {
	const msg = e.data as { type?: string } | null;
	if (!msg || typeof msg !== 'object') return;
	if (!worker) {
		const initMsg = msg as InitMessage;
		if (initMsg.type !== 'init') {
			// 理论首个必为 init；异常时降级为无共享内存
			worker = new PhysicsWorker(createWorkerSharedState(null));
		} else {
			worker = new PhysicsWorker(createWorkerSharedState(initMsg.shared));
		}
	}
	worker.handleMessage(e as MessageEvent<unknown> as MessageEvent);
}

self.onmessage = (e: MessageEvent) => {
	const msg = e.data as { type?: string } | null;
	// wasm-init：触发 WASM 初始化（仅首次）
	if (msg && msg.type === 'wasm-init') {
		if (!initStarted) {
			initStarted = true;
			void (async () => {
				try {
					await startWasm(msg as WasmInitMessage);
				} catch (err) {
					const text =
						err instanceof Error
							? (err.stack ?? `${err.name}: ${err.message}`)
							: String(err);
					console.error('[Worker] WASM init 失败:', text);
					(postMessage as (m: unknown) => void)({
						type: 'error',
						message: `[wasm-init] ${text}`,
					});
				}
			})();
		}
		return;
	}
	if (!wasmReady) {
		pending.push(e);
		return;
	}
	dispatch(e);
};
