/**
 * 默认配置纹理包（textures.mtz，MTZ 容器）的加载与解压。
 *
 * 消费点一处：`apps/debug/src/app.ts` 的 `showMissingTextures` —— 把 WASM 报出的缺失材质名与
 * 包内键比对，分成「可覆盖」与「缺失」两组展示。渲染侧的默认纹理回退不走本模块，那条路
 * 由 `src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 自己读内嵌的 mtz base64。
 *
 * 装载路径两条：内嵌 base64（全局键 `__VBSP_TEXTURES_MTZ_B64__`）或按 `DEFAULT_TEXTURE_PACK_URL`
 * fetch（dev 下由 `apps/debug/web/textures.mtz` 提供）。解压结果缓存进 `cachedPack`。
 */

import { ensureMainWasm, decompress_mtz } from './main-wasm.js';
import { base64ToBytes } from '../../../src/ts-shared/wasm/loader.js';

/** 非内嵌路径下的取包地址（相对页面）。 */
const DEFAULT_TEXTURE_PACK_URL = './textures.mtz';

/** 解压结果缓存：键为 `materials/<小写名>`，值为 mosaic 字节码；未加载或加载失败时为 null。 */
let cachedPack: Record<string, string> | null = null;

/** 加载并解压默认纹理包：已有缓存直接返回，任一步失败返回 null（失败不写缓存，下次调用会重试）。 */
export async function loadDefaultTexturePack(): Promise<Record<string, string> | null> {
	if (cachedPack) return cachedPack;
	try {
		await ensureMainWasm();
		const embedded = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string })
			.__VBSP_TEXTURES_MTZ_B64__;
		let json: string;
		if (embedded) {
			const bytes = base64ToBytes(embedded);
			json = decompress_mtz(bytes);
		} else {
			const resp = await fetch(DEFAULT_TEXTURE_PACK_URL);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const bytes = new Uint8Array(await resp.arrayBuffer());
			json = decompress_mtz(bytes);
		}
		cachedPack = JSON.parse(json) as Record<string, string>;
		console.log(`[default-pack] 默认纹理包已加载: ${Object.keys(cachedPack).length} 条`);
	} catch (e) {
		console.warn('[default-pack] 默认纹理包加载失败（缺失比对/回退降级）:', e);
		cachedPack = null;
	}
	return cachedPack;
}
