/**
 * Worker-B（预测）入口 — 与 predictor-worker.ts 同构。
 * 独立文件以便 esbuild 单独打包（build-dist.mjs 引用 predictor-main.ts）。
 */

/// <reference lib="webworker" />

export * from './predictor-worker.js';
