/**
 * 默认配置纹理包（textures.mtz）加载 — 共享给 app（缺失比对弹窗）与 renderer（构建期回退）。
 *
 * 幂等缓存；失败降级为 null（比对全部标"完全缺失"、回退不执行）。
 * 路径：dev = web/textures.mtz（serve root 下）；dist = 同目录 textures.mtz。
 */

import { ensureMainWasm, decompress_mtz } from './main-wasm.js';

const DEFAULT_TEXTURE_PACK_URL = './textures.mtz';

/** 默认纹理包解压结果缓存（{ 键: 字节码 }，键 = materials/xxx 小写）。 */
let cachedPack: Record<string, string> | null = null;

/** 加载默认纹理包（幂等；失败返回 null）。
 * single 打包（file://）：内嵌 base64（__VBSP_TEXTURES_MTZ_B64__，build-dist.mjs 注入）；
 * multi/dev（HTTP）：fetch './textures.mtz'。 */
export async function loadDefaultTexturePack(): Promise<Record<string, string> | null> {
	if (cachedPack) return cachedPack;
	try {
		await ensureMainWasm();
		const embedded = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string })
			.__VBSP_TEXTURES_MTZ_B64__;
		let json: string;
		if (embedded) {
			const bin = atob(embedded);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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
