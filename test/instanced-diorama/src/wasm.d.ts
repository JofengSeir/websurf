/**
 * wasm-bindgen 生成类型（pkg/websurf_wasm.d.ts），保证与 wasm 实现一致。
 * 本文件仅做类型 re-export，由 esbuild 实际引用 pkg/websurf_wasm.js。
 */
export * from '../pkg/websurf_wasm.js';
