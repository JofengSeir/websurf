/**
 * 主线程 WASM 懒初始化（mosaic 画质切换 / 默认纹理包解压用）。
 *
 * debug 的 wasm 解析在 Worker 内；主线程仅在需要 mosaic 能力时初始化
 * 同一 wasm 模块的独立实例（与 worker 实例互不影响）：
 * - dist 内嵌模式：globalThis.__VBSP_WASM_B64__（build-dist.mjs 注入）→ initSync
 * - dev 模式：fetch 相对 web/ 的 wasm（`./websurf_wasm_bg.wasm`，R-14/B4-8）→ initSync
 */

import { initSync, mosaic_decode, decompress_mtz } from '../pkg/websurf_wasm.js';
import { base64ToBytes, fetchWasmBytes, readEmbeddedWasmB64 } from '../../../src/ts-shared/wasm/loader.js';

let mainWasmInit: Promise<void> | null = null;

/** 主线程 WASM 加载路径：multi 打包注入 __VBSP_WASM_URL__（相对 dist/）；
 * 否则 dev 默认相对 web/ 的同目录 wasm（`npm run build:wasm` 负责拷贝到 web/）。 */
export function mainWasmUrl(): string {
	return (
		(globalThis as unknown as { __VBSP_WASM_URL__?: string }).__VBSP_WASM_URL__ ??
		'./websurf_wasm_bg.wasm'
	);
}

/** 确保主线程 wasm 已初始化（幂等；失败后允许重试）。 */
export async function ensureMainWasm(): Promise<void> {
	if (!mainWasmInit) {
		mainWasmInit = (async () => {
			const embedded = readEmbeddedWasmB64();
			if (embedded) {
				const bytes = base64ToBytes(embedded);
				initSync({ module: bytes.buffer as ArrayBuffer });
			} else {
				initSync({ module: (await fetchWasmBytes(mainWasmUrl())).buffer as ArrayBuffer });
			}
		})().catch((e) => {
			mainWasmInit = null;
			throw e;
		});
	}
	return mainWasmInit;
}

export { mosaic_decode, decompress_mtz };
