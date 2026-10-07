# implementation/worker：记录解析 Worker

> 覆盖 `apps/viewer/src/worker/main.ts`。它被两条构建路径消费：`apps/viewer/package.json:13` 的 `build:worker` 打成 `apps/viewer/web/worker.js`（dev / multi 产物按 module worker 装载），`apps/viewer/scripts/build-dist.mjs:320` 用 IIFE 再打一份内嵌进 single 产物的 `app.js`（运行时由 `apps/viewer/src/replay/importer.ts:100` 读 `globalThis.__VBSP_WORKER_JS__` 起 Blob Worker）。

---

## 模块职责

模块没有 `export`：`self.onmessage` 是唯一入口（`apps/viewer/src/worker/main.ts:48`），入参是 `apps/viewer/src/replay/protocol.ts` 的 `ParseRequest`，出参是该文件的 `ParseResponse`。内部接口 `WorkerCtx` 是就地声明的 Worker 全局面（只用 `onmessage` 与 `postMessage` 两个成员，`apps/viewer/src/worker/main.ts:30` 到 `apps/viewer/src/worker/main.ts:33`）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 入口不 await | `onmessage` 只把请求交给 `handle`，异常在该函数内部收敛 | `apps/viewer/src/worker/main.ts:48` 到 `apps/viewer/src/worker/main.ts:51` |
| 单条请求全流程 | 取文件（`req.file ?? cachedNativeFile`）→ 魔数嗅探并**分派格式**（Shavit `.replay` / KSF `.rec`）→ 取字节并缓存 → `parseShavitReplay` / `parseGokzRec` → `clipFromShavitReplay` / `clipFromGokzRec` → 带 transfer 回 `done` | `apps/viewer/src/worker/main.ts:58` 到 `apps/viewer/src/worker/main.ts:107` |
| 嗅探先于取字节的文本解码 | 记录文件是二进制；按各格式嗅探函数切片判别（Shavit 前 64 字节、`.rec` 前 24 字节），都不命中即回 `error` | `apps/viewer/src/worker/main.ts:62`、`apps/viewer/src/replay/shavit-replay.ts:105`、`apps/viewer/src/replay/gokz-rec.ts:80` |
| 缓存原始字节 | 仅当本次请求的 `file` 与缓存句柄是同一个对象时才复用 `cachedNativeBytes`，否则重新 `arrayBuffer()` 并覆盖缓存 | `apps/viewer/src/worker/main.ts:71` 到 `apps/viewer/src/worker/main.ts:80` |
| 读文件失败单独包装 | `arrayBuffer()` 抛错时转成带原因的 `error` 响应 | `apps/viewer/src/worker/main.ts:75` 到 `apps/viewer/src/worker/main.ts:78` |
| 时间戳兜底 | 传入 `File.lastModified / 1000`（ms → Unix 秒），两种格式同口径 | `apps/viewer/src/worker/main.ts:85`、`apps/viewer/src/worker/main.ts:91` |
| 映射随请求下发 | `mapping` 取 `req.rule` 的两个模式字段，两种格式同口径 | `apps/viewer/src/worker/main.ts:87`、`apps/viewer/src/worker/main.ts:93` |
| 进度两档 | `'parse'` 的 0/1 与 1/1 | `apps/viewer/src/worker/main.ts:70`、`apps/viewer/src/worker/main.ts:95` |
| 零拷贝回传 | `t` / `pos` / `ang` 的 buffer 必进 transfer 列表，`vel` / `buttons` 存在才加；发送后这些 buffer 在 Worker 侧不可再用 | `apps/viewer/src/worker/main.ts:97` 到 `apps/viewer/src/worker/main.ts:99` |
| 载荷逐字段构造 | `clipToPayload` 显式列 12 个字段（不用展开），与 `ClipPayload` 同名同型 | `apps/viewer/src/worker/main.ts:122` 到 `apps/viewer/src/worker/main.ts:136`、`apps/viewer/src/replay/protocol.ts:12` |
| 异常一律转 `error` 响应 | 任一步抛错都收敛成 `{ id, type: 'error', message }`，不漏到 `onmessage` | `apps/viewer/src/worker/main.ts:108` 到 `apps/viewer/src/worker/main.ts:114` |

## 已知缺口（状态见 TODO.md）

1. **两条进度只覆盖 `'parse'`**：本文件只有两处进度回包且 `phase` 都写死 `'parse'`（`apps/viewer/src/worker/main.ts:70`、`apps/viewer/src/worker/main.ts:95`），协议里声明的 `'map'` 阶段没有发送方（`apps/viewer/src/replay/protocol.ts:47`）⇒ 面板侧按阶段判分支的写法实际恒真（`apps/viewer/src/replay/panel.ts:327`）。
2. **没有心跳，请求侧无法区分「在解析」与「已失联」**：本文件对一条请求只回 `done` 或 `error` 两种包（`apps/viewer/src/worker/main.ts:98`、`apps/viewer/src/worker/main.ts:108`），解析期间不发任何中间信号；请求侧也没有超时（`apps/viewer/src/replay/importer.ts:154`），因此大文件解析与 Worker 静默失效在调用方看来同形。（见 TODO.md T-152）
3. **`WorkerCtx` 是手写的全局面**：本工程 `apps/viewer/tsconfig.json:6` 的 `lib` 只有 `ES2022` / `DOM` / `DOM.Iterable`，没有 `WebWorker`，故文件内用 `self as unknown as WorkerCtx` 断言拿到 `postMessage`（`apps/viewer/src/worker/main.ts:35`），`post` 只是给它一个确定签名的薄封装（`apps/viewer/src/worker/main.ts:43`）⇒ Worker 全局类型面不受编译器保护，成员写错只在运行期暴露。（见 TODO.md T-153）
4. **`clipToPayload` 没有显式返回类型**：函数体只返回对象字面量（`apps/viewer/src/worker/main.ts:122`），其形状靠调用点 `post` 的形参类型 `ParseResponse` 做结构化校验（`apps/viewer/src/worker/main.ts:43`）⇒ 字段名写错时的报错位置在调用点而非定义点。（见 TODO.md T-154）
5. **`req.rule` 缺少防御**：`handle` 直接读 `req.rule.axesMode` / `req.rule.yawMode`（`apps/viewer/src/worker/main.ts:87`、`apps/viewer/src/worker/main.ts:93`），请求缺该字段时抛 TypeError 并被 catch 成 `'error'` 响应（`apps/viewer/src/worker/main.ts:113`）；错误文本是运行期的属性访问错误，与「文件损坏」类错误同形，面板无法据此判断是调用方漏传字段。（见 TODO.md T-155）
