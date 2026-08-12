// wasm 端到端验证:加载 pkg/bsp_extract.js,测试 bsp_info + bsp_to_glb。
// 用法:node test-wasm.mjs <bsp路径>
import { readFile } from 'fs/promises';
import init, { bsp_info, bsp_to_glb } from './pkg/bsp_extract.js';

const path = process.argv[2] || 'D:/code/project/websurf/maps/ze_cursed_bear_tales_v1_2.bsp';

// web 目标胶水用 fetch 拉 wasm;Node 下改为直接编译字节传入
const wasmBytes = await readFile(new URL('./pkg/bsp_extract_bg.wasm', import.meta.url));
const wasmModule = await WebAssembly.compile(wasmBytes);
await init({ module_or_path: wasmModule });

// 1. bsp_info
const bytes = new Uint8Array(await readFile(path));
const info = JSON.parse(bsp_info(bytes));
console.log('bsp_info:', JSON.stringify(info, null, 2));

// 2. bsp_to_glb
const glb = bsp_to_glb(bytes);
console.log('bsp_to_glb: 返回字节数 =', glb.length);

// 3. 校验 GLB 头
const view = new DataView(glb.buffer);
const magic = String.fromCharCode(glb[0], glb[1], glb[2], glb[3]);
const version = view.getUint32(4, true);
const totalLen = view.getUint32(8, true);
console.log(`GLB 头: magic=${magic} version=${version} totalLen=${totalLen} (文件字节=${glb.length})`);
if (magic !== 'glTF' || version !== 2 || totalLen !== glb.length) {
  console.error('FAIL: GLB 头校验不通过');
  process.exit(1);
}
console.log('PASS: wasm 端到端导入→解析→导出 GLB 校验通过');
