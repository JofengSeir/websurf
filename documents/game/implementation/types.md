# implementation / types（`apps/game/src/world/types.ts` 与 `apps/game/src/wasm.d.ts`）

## 模块职责

本工程的两个类型出口文件，都不含运行时逻辑。

| 文件 | 导出 | 职责 | 锚点 |
|---|---|---|---|
| `apps/game/src/world/types.ts` | `WasmPvsNode`、`WasmPvsLeaf`、`WasmPvsData` | 从共享层转出 PVS 数据结构（`parse_pvs_data` 导出 JSON 的形状） | `apps/game/src/world/types.ts:12` |
| 同上 | `Vec3Like`、`Vec3` | 本文件内定义的三分量向量类型与别名 | `apps/game/src/world/types.ts:14`、`:20` |
| `apps/game/src/wasm.d.ts` | `export * from '../pkg/websurf_wasm.js'` | 把 wasm-pack 生成的实体声明整体转出，供类型检查兜底 | `apps/game/src/wasm.d.ts:16` |

## 关键流程与不变量

- **PVS 类型的定义点唯一**：三个 PVS 类型只在共享层定义（`src/ts-shared/world/types.ts`），本文件用 `export type { … } from` 转出（`apps/game/src/world/types.ts:12`），不重写成员。
- **`wasm.d.ts` 的生效方式靠 tsconfig 显式列出**：`apps/game/tsconfig.json:15` 的 `include` 把 `apps/game/src/wasm.d.ts` 与 `../../src/ts-shared/**/*.ts` 一起列入。
- **声明面与实现同源**：`apps/game/src/wasm.d.ts` 不手写成员，pkg 的 `websurf_wasm.d.ts` 由 wasm-pack 生成（`apps/game/package.json:8`），因此类型面随 Rust 导出面同步变化。
- **工程内三个 pkg 导入方都直接写路径**：`apps/game/src/app.ts:27`、`apps/game/src/worker/main.ts:65`、`apps/game/src/renderer/renderer-main.ts:37`；`wasm.d.ts` 只作类型兜底，不被 import。

## 已知缺口

- **`apps/game/src/world/types.ts` 在本工程零导入点**：`apps/game/src` 内没有对 `./types.js` 或其相对路径的 import（本次实测零匹配）；PVS 类型经 `PvsManager` 内部消费（`apps/game/src/renderer/renderer-main.ts:42`、`apps/game/src/renderer/renderer-main.ts:401`），不经过本文件。
- **`wasm.d.ts` 的转出与三个导入方之间没有强制关系**：三个导入方直接写 pkg 路径（`apps/game/src/app.ts:27`），`apps/game/src/wasm.d.ts:16` 的 `export *` 只保证这些路径可解析；删掉本文件后类型检查仍能从 `pkg` 目录取到声明，本文件的独立作用仅限「pkg 产物缺失时的兜底形态」。
- **与另两个工程的类型入口形态不同**：本工程的入口是一条 `export *`（`apps/game/src/wasm.d.ts:16`），`apps/debug` 侧则是逐成员手写的 `declare module` 形态（`apps/debug/src/wasm.d.ts`，其头部注释与成员表见该文件）；两者不是同一套写法，改 Rust 导出面时只有本工程侧会自动跟进。
