/**
 * 默认纹理包装载：textures.mtz 字节 → defaults JSON 字符串（三应用共用的单一实现）。
 *
 * 2026-10-04 自 `src/ts-shared/phys/world-builder.ts` 的内联段抽出（viewer 的 GLB 导出改走
 * 缺失纹理回退时需要同一段两路取值逻辑）。两路取值（与 game/debug 行为逐句一致）：
 * 1. `globalThis.__VBSP_TEXTURES_MTZ_B64__` 命中 ⇒ single 打包（file://）内嵌的 base64；
 * 2. 否则 `fetch` 同目录 `./textures.mtz`（dev / multi 部署主路径）。
 *
 * 任一路失败都只 `console.warn` 并返回 `'{}'`（缺失材质保持占位色，不阻断地图加载）；
 * `decompressMtz` 由调用方注入（各应用自己的 `pkg/websurf_wasm*.js` 导出的 `decompress_mtz`）。
 */

import { base64ToBytes, fetchWasmBytes } from '../wasm/loader.js';

/** MTZ 解压函数签名（wasm 导出 `decompress_mtz`：字节 → JSON 文本）。 */
export type DecompressMtz = (bytes: Uint8Array) => string;

/**
 * 装载默认纹理包并解压成 defaults JSON（`{ "materials/<小写路径>": "#mosaic v4 字节码" }`）。
 * @returns 解压产物；装载失败或解压抛错时返回 `'{}'`（回退关闭）。
 */
export async function loadDefaultsJson(decompressMtz: DecompressMtz): Promise<string> {
  try {
    const embeddedMtz = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string })
      .__VBSP_TEXTURES_MTZ_B64__;
    if (embeddedMtz) {
      // single 打包（file://）：内嵌 base64
      const mtzBytes = base64ToBytes(embeddedMtz);
      const json = decompressMtz(mtzBytes);
      console.log('[load-bsp] 默认纹理包已加载（内嵌，缺失纹理回退可用）');
      return json;
    }
    const mtzBytes = await fetchWasmBytes('./textures.mtz');
    const json = decompressMtz(mtzBytes);
    console.log('[load-bsp] 默认纹理包已加载（缺失纹理回退可用）');
    return json;
  } catch (e) {
    console.warn('[load-bsp] 默认纹理包加载失败（缺失纹理保持占位色）:', e);
    return '{}';
  }
}
