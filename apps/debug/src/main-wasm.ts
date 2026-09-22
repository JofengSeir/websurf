/**
 * 主线程侧的 WASM 懒初始化（只服务 mosaic 画质切换与默认纹理包解压）。
 *
 * debug 的 BSP 解析与物理都在 Worker 里跑，Worker 在自己的作用域内独立 `initSync`
 * （`apps/debug/src/worker/main.ts`），与本文件的实例互不影响。
 *
 * 两条装载路径：
 * - 构建产物内嵌 base64：经 `src/ts-shared/wasm/loader.ts` 的 `readEmbeddedWasmB64()` 读
 *   全局键 `__VBSP_WASM_B64__`（由 `src/scripts/lib/dist-pack.mjs` 注入）；
 * - dev 与 multi 打包：按 `mainWasmUrl()` 取到字节后 `initSync`。
 */

import { initSync, mosaic_decode, decompress_mtz } from '../pkg/websurf_wasm.js';
import { base64ToBytes, fetchWasmBytes, readEmbeddedWasmB64 } from '../../../src/ts-shared/wasm/loader.js';

/** 初始化 Promise 缓存（幂等用）；失败时被置回 null 以便重试。 */
let mainWasmInit: Promise<void> | null = null;

/** dev 与 multi 打包下的 wasm 地址：优先取构建注入的 `__VBSP_WASM_URL__`，否则用 web 目录同级的文件名。 */
export function mainWasmUrl(): string {
	return (
		(globalThis as unknown as { __VBSP_WASM_URL__?: string }).__VBSP_WASM_URL__ ??
		'./websurf_wasm_bg.wasm'
	);
}

/** 确保主线程 wasm 已初始化（幂等：并发调用共用同一个 Promise）；失败时清掉缓存的 Promise 以便重试。 */
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

/** 转出两个解码函数：`mosaic_decode` 供 `renderer-main` 的画质切换，`decompress_mtz` 供 `default-pack`。 */
export { mosaic_decode, decompress_mtz };
