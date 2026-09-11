/**
 * WASM 类型入口 — 直接 re-export pkg 生成的真实类型（wasm-pack 产物）。
 * pkg/websurf_wasm.d.ts 由 wasm-bindgen 生成，保证与 wasm 实现一致。
 */

export * from '../pkg/websurf_wasm.js';
