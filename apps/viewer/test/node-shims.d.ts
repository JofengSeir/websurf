/**
 * 最小 Node 类型面：`apps/viewer/tsconfig.json` 的 `types` 为空（不装 `@types/node`），
 * 而自检 `apps/viewer/test/replay-selftest.ts` 要在 Node 下跑，故只补它用到的那一个 API。
 * 覆盖范围仅 `node:fs`；`process` 由自检文件内部就地 `declare`，不在这里声明。
 */

declare module 'node:fs' {
  /** 读文件为字节；运行时返回 `Buffer`（`Uint8Array` 的子类），故这里直接按 `Uint8Array` 声明。 */
  export function readFileSync(path: URL | string): Uint8Array;
}
