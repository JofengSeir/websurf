/**
 * WebSurf — Worker 入口
 *
 * 在 Worker 上下文中初始化 WASM 模块，然后实例化 `PhysicsWorker`，绑定 `onmessage`。
 *
 * WASM 初始化（消息驱动）：
 * - dist 内嵌模式：主线程把唯一一份 base64 通过 `wasm-init` 消息下发 →
 *   atob → `initSync({module})`（避免 file:// 下 fetch 失败）。
 * - dev 模式：主线程下发 `wasm-init` 携带 `wasmUrl`，本 worker `fetch` 后 `init`。
 *
 * 时序：收到 `wasm-init` 后才启动 WASM 初始化；在此之前到达的任何消息（含 init）
 * 入队缓存，WASM 就绪后按序重放（保持 postMessage 顺序语义）。
 */

/// <reference lib="webworker" />

import { PhysicsWorker } from './physics-worker.js';
import init, { initSync } from '../../pkg/websurf_wasm.js';
import type { WasmInitMessage } from './worker-types.js';

/** 已就绪标志：false 时消息入队。 */
let worker: PhysicsWorker | null = null;
let ready = false;
let initStarted = false;
const pending: MessageEvent[] = [];

/** 根据主线程下发的 wasm-init 消息初始化 WASM。 */
async function startWasm(msg: WasmInitMessage): Promise<void> {
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
	worker = new PhysicsWorker();
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
					ready = true;
					const w = worker;
					// 顺序重放初始化前收到的消息（含 init，保持 postMessage 顺序）
					for (const ev of pending) {
						w!.handleMessage(ev as MessageEvent<unknown> as MessageEvent);
					}
					pending.length = 0;
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
	if (!ready) {
		pending.push(e);
		return;
	}
	worker!.handleMessage(e as MessageEvent<unknown> as MessageEvent);
};
