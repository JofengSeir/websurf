/**
 * 世界类型（最小化版）— 仅保留主线程渲染需要的 PVS 类型。
 *
 * PVS 三类型的定义已上提共享层（D-10）：`src/ts-shared/world/types.ts`。
 * 此处保留 re-export，使本工程内既有 `from './types.js'` 调用方路径不变。
 * 结构等价的 `Vec3Like` / `Vec3` 仍留在本工程（D-07 判「保留」，不上提）。
 */

export type { WasmPvsNode, WasmPvsLeaf, WasmPvsData } from '../../../../src/ts-shared/world/types.js';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type Vec3 = Vec3Like;
