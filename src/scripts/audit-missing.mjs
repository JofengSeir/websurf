#!/usr/bin/env node
/**
 * 缺失资源审计：解析一张 BSP，按**探针模式**跑一遍材质/贴图解析，输出缺失清单。
 *
 * 用法：
 *   node src/scripts/audit-missing.mjs <map.bsp> [--mode raw|vmt|both] [--json]
 *
 *   raw  = 不装任何回退（基线缺口）
 *   vmt  = 只装回退 VMT 文本表（src/materials/vmts-fallback.json）
 *   both = 回退 VMT 表 + 默认纹理包 textures.mtz（默认）
 *
 * 前置：npm run build:wasm（apps/viewer 的 pkg 必须存在）。
 * **一次只跑一张图**：大图会撑爆 wasm 实例，之后每张都假报失败；批量请在 shell 里循环、
 * 每张一个进程。
 *
 * 输出（--json 为单行 JSON）：缺失数、登记材质数、逐条 name/reason。
 */
import { readFileSync } from 'node:fs';
import { initSync, BspProcessor, decompress_mtz } from '../../apps/viewer/pkg/websurf_viewer_wasm.js';

const argv = process.argv.slice(2);
const map = argv.find((a) => !a.startsWith('--'));
const modeIndex = argv.indexOf('--mode');
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'both';
const asJson = argv.includes('--json');
if (!map || !['raw', 'vmt', 'both'].includes(mode)) {
  console.error('usage: node src/scripts/audit-missing.mjs <map.bsp> [--mode raw|vmt|both] [--json]');
  process.exit(2);
}

const ROOT = process.cwd();
initSync({ module: readFileSync(ROOT + '/apps/viewer/pkg/websurf_viewer_wasm_bg.wasm') });
const proc = new BspProcessor(new Uint8Array(readFileSync(map)));
if (mode === 'vmt' || mode === 'both') {
  proc.setVmtFallback(readFileSync(ROOT + '/src/materials/vmts-fallback.json', 'utf8'));
}
let defaults = '{}';
if (mode === 'both') {
  defaults = decompress_mtz(new Uint8Array(readFileSync(ROOT + '/src/materials/textures.mtz')));
}

const t0 = Date.now();
const out = JSON.parse(proc.probeMissingResources(defaults));
const result = { map, mode, ms: Date.now() - t0, count: out.missing.length, missing: out.missing };
if (asJson) {
  console.log(JSON.stringify(result));
} else {
  console.log(`${map} [${mode}] ${result.ms} ms  缺失 ${result.count} 条`);
  for (const m of result.missing) console.log('  - ' + m.name);
}