/**
 * 本工程的向量与 PVS 类型出口，两类内容来源不同。
 *
 * - `WasmPvsNode` / `WasmPvsLeaf` / `WasmPvsData`：定义点唯一在 `src/ts-shared/world/types.ts`
 *   （`parse_pvs_data` 导出 JSON 的形状），此处仅以 `export type { … } from` 转出；
 * - `Vec3Like` 与别名 `Vec3`：在本文件内定义，结构为 `x` / `y` / `z` 三个 `number` 字段。
 *
 * 导入点：本工程 `apps/game/src` 下对 `./types.js` 的 `import` 为零；共享层
 * `src/ts-shared/world/pvs-manager.ts` 只在注释里按结构等价提到 `Vec3Like`，不导入本文件。
 */

export type { WasmPvsNode, WasmPvsLeaf, WasmPvsData } from '../../../../src/ts-shared/world/types.js';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type Vec3 = Vec3Like;
