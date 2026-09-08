/**
 * 最小 Node 类型面（tsconfig types: []，不装 @types/node）。
 * 只声明自检（test/replay-selftest.ts）实际用到的 API。
 */

declare module 'node:fs' {
  /** 读文件为字节（Buffer 是 Uint8Array 子类，运行时返回 Buffer）。 */
  export function readFileSync(path: URL | string): Uint8Array;
}
