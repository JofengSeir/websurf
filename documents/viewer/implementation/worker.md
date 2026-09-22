# implementation/worker：录像解析 Worker

> 覆盖 `apps/viewer/src/worker/main.ts`。它被两条构建路径消费：`apps/viewer/package.json:12` 的 `build:worker` 打成 `apps/viewer/web/worker.js`（dev / multi 产物按 module worker 装载），`apps/viewer/scripts/build-dist.mjs:314` 用 IIFE 再打一份内嵌进 single 产物的 `app.js`（运行时由 `apps/viewer/src/replay/importer.ts:83` 读 `globalThis.__VBSP_WORKER_JS__` 起 Blob Worker）。

---

## 模块职责

模块没有 `export`：`self.onmessage` 是唯一入口（`apps/viewer/src/worker/main.ts:46`），入参是 `apps/viewer/src/replay/protocol.ts` 的 `ParseRequest`，出参是该文件的 `ParseResponse`。内部接口 `WorkerCtx` 是就地声明的 Worker 全局面（只用 `onmessage` 与 `postMessage` 两个成员，`apps/viewer/src/worker/main.ts:28` 到 `apps/viewer/src/worker/main.ts:31`）。

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 入口不 await | `onmessage` 只把请求交给 `handle`，异常在该函数内部收敛 | `apps/viewer/src/worker/main.ts:46` 到 `apps/viewer/src/worker/main.ts:49` |
| 单条请求全流程 | 取文件（`req.file ?? cachedNativeFile`）→ 魔数嗅探 → 取字节并缓存 → `parseShavitReplay` → `clipFromShavitReplay` → 带 transfer 回 `done` | `apps/viewer/src/worker/main.ts:56` 到 `apps/viewer/src/worker/main.ts:100` |
| 嗅探先于取字节的文本解码 | `.replay` 是二进制；嗅探只切片读前 64 字节，判负即回 `error` | `apps/viewer/src/worker/main.ts:60`、`apps/viewer/src/replay/shavit-replay.ts:105` |
| 缓存原始字节 | 仅当本次请求的 `file` 与缓存句柄是同一个对象时才复用 `cachedNativeBytes`，否则重新 `arrayBuffer()` 并覆盖缓存 | `apps/viewer/src/worker/main.ts:67` 到 `apps/viewer/src/worker/main.ts:76` |
| 读文件失败单独包装 | `arrayBuffer()` 抛错时转成带原因的 `error` 响应 | `apps/viewer/src/worker/main.ts:69` 到 `apps/viewer/src/worker/main.ts:73` |
| 时间戳兜底 | 传入 `File.lastModified / 1000`（ms → Unix 秒） | `apps/viewer/src/worker/main.ts:80` |
| 映射随请求下发 | `mapping` 取 `req.rule` 的两个模式字段 | `apps/viewer/src/worker/main.ts:82` |
| 进度两档 | `'parse'` 的 0/1 与 1/1 | `apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/worker/main.ts:84` |
| 零拷贝回传 | `t` / `pos` / `ang` 的 buffer 必进 transfer 列表，`vel` / `buttons` 存在才加；发送后这些 buffer 在 Worker 侧不可再用 | `apps/viewer/src/worker/main.ts:88` 到 `apps/viewer/src/worker/main.ts:90` |
| 载荷逐字段构造 | `clipToPayload` 显式列 12 个字段（不用展开），与 `ClipPayload` 同名同型 | `apps/viewer/src/worker/main.ts:113` 到 `apps/viewer/src/worker/main.ts:127`、`apps/viewer/src/replay/protocol.ts:12` |
| 异常一律转 `error` 响应 | 任一步抛错都收敛成 `{ id, type: 'error', message }`，不漏到 `onmessage` | `apps/viewer/src/worker/main.ts:101` 到 `apps/viewer/src/worker/main.ts:107` |

## 已知缺口

1. **两条进度只覆盖 `'parse'`**：本文件只有两处进度回包且 `phase` 都写死 `'parse'`（`apps/viewer/src/worker/main.ts:66`、`apps/viewer/src/worker/main.ts:84`），协议里声明的 `'map'` 阶段没有发送方（`apps/viewer/src/replay/protocol.ts:47`）⇒ 面板侧按阶段判分支的写法实际恒真（`apps/viewer/src/replay/panel.ts:299`）。
2. **没有心跳，请求侧无法区分「在解析」与「已失联」**：本文件对一条请求只回 `done` 或 `error` 两种包（`apps/viewer/src/worker/main.ts:91`、`apps/viewer/src/worker/main.ts:102`），解析期间不发任何中间信号；请求侧也没有超时（`apps/viewer/src/replay/importer.ts:135`），因此大文件解析与 Worker 静默失效在调用方看来同形。
3. **`WorkerCtx` 是手写的全局面**：本工程 `apps/viewer/tsconfig.json:6` 的 `lib` 只有 `ES2022` / `DOM` / `DOM.Iterable`，没有 `WebWorker`，故文件内用 `self as unknown as WorkerCtx` 断言拿到 `postMessage`（`apps/viewer/src/worker/main.ts:33`），`post` 只是给它一个确定签名的薄封装（`apps/viewer/src/worker/main.ts:41`）⇒ Worker 全局类型面不受编译器保护，成员写错只在运行期暴露。
4. **`clipToPayload` 没有显式返回类型**：函数体只返回对象字面量（`apps/viewer/src/worker/main.ts:113`），其形状靠调用点 `post` 的形参类型 `ParseResponse` 做结构化校验（`apps/viewer/src/worker/main.ts:41`）⇒ 字段名写错时的报错位置在调用点而非定义点。
5. **`req.rule` 缺少防御**：`handle` 直接读 `req.rule.axesMode` / `req.rule.yawMode`（`apps/viewer/src/worker/main.ts:82`），请求缺该字段时抛 TypeError 并被 catch 成 `'error'` 响应（`apps/viewer/src/worker/main.ts:101`）；错误文本是运行期的属性访问错误，与「文件损坏」类错误同形，面板无法据此判断是调用方漏传字段。
