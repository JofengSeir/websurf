#!/usr/bin/env node
/**
 * 把 `dev/water_dudv.vtf`（起源水面的 DU/DV 扭曲图）解出的 PNG **内嵌**成 TS 常量。
 *
 * 为什么要内嵌而不是放 `web/`：三端 + dist 的 `--single/--multi` 资产清单各不相同，多一个
 * 外置文件就要同时改 `sync-web-assets.mjs`、三份 `build-dist.mjs` 与单文件模式的注入清单；
 * 这张图只有 20 KB（base64 约 28 KB），内嵌后所有形态都能拿到，也不会出现"少拷一个文件 ⇒
 * 画面静默回退到程序化波纹"。
 *
 * 用法（先解 VTF，再生成；解码器已入库 `src/scripts/vtf-to-png.py`）：
 *   python src/scripts/vtf-to-png.py test/fallback-src/materials/dev/water_dudv.vtf 256 .tmp/water_dudv.png
 *   node   src/scripts/gen-water-dudv.mjs .tmp/water_dudv.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = process.argv[2];
if (!src) throw new Error('用法: node src/scripts/gen-water-dudv.mjs <water_dudv.png>');
const png = readFileSync(resolve(src));
const b64 = png.toString('base64');
const out = join(REPO, 'src', 'renderer-shared', 'shader', 'water-dudv-data.ts');
const ts = `/**
 * **自动生成，不要手改**：起源水面的 DU/DV 扭曲图（\`dev/water_dudv\`）的 256² mip0。
 *
 * 来源：\`test/fallback-src/materials/dev/water_dudv.vtf\`（VTF 7.1，256×256，格式 **UV88**
 * —— R=du、G=dv，29 帧动画，本文件取 frame 0 / mip 0）。这张图既不在 BSP pakfile 里、也没进
 * \`textures.mtz\`，但它是**地图水材质真正引用的那张**（\`$bumpmap dev/water_dudv\`，
 * \`surf_boreas\` 的 \`project_tendies/water01.vmt\` 与 \`surf_666\` 的 depth patch 都指向它）。
 *
 * 重新生成：
 *   python src/scripts/vtf-to-png.py test/fallback-src/materials/dev/water_dudv.vtf 256 .tmp/water_dudv.png
 *   node   src/scripts/gen-water-dudv.mjs .tmp/water_dudv.png
 */
export const WATER_DUDV_PNG_BASE64 =
  '${b64}';

/** 内嵌 PNG 的字节数（生成时写入，便于验收脚本核对资产真的换了）。 */
export const WATER_DUDV_PNG_BYTES = ${png.length};
`;
writeFileSync(out, ts);
console.log(`[gen-water-dudv] ${png.length} B → ${out}（base64 ${b64.length} 字符）`);
