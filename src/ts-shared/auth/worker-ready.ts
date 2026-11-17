/**
 * Worker 协议握手的**两端共用实现**（2026-11-18，三端共用收敛 P0）。
 *
 * 背景（2026-11-17 事故）：`build:app` 只重建 `web/app.js`、不重建 `web/worker.js`；
 * 主线程新增的 worker 侧消息（如 `set-player-name`）在旧 worker 里不存在，会被**静默丢弃**，
 * 表现为「前端改了、权威行为没变」，排查很久。
 *
 * 约定（与 `worker-protocol.ts` 配套）：
 * - 消息语义增删改 → `WORKER_PROTOCOL` +1；
 * - Worker 在 wasm 初始化完成后回一条 `ready{protocol}`；
 * - 主线程比对，不一致时用状态栏/控制台显式报错，提示重建 worker。
 *
 * 这里同时给 worker 侧 `makeReadyMessage()` 与主线程侧 `handleWorkerReady()`，
 * debug/game 两端都只调用本模块，不再各自写一份比对逻辑。
 */

import { WORKER_PROTOCOL } from './worker-protocol.js';

/** `ready` 消息的最小形状（worker 旧构建时可能没有 `protocol` 字段）。 */
export interface ReadyMessageLike {
  type?: string;
  protocol?: number;
}

/** Worker 侧：构造要回给主线程的 `ready` 消息（带上当前协议版本）。 */
export function makeReadyMessage(): { type: 'ready'; protocol: number } {
  return { type: 'ready', protocol: WORKER_PROTOCOL };
}

/** 主线程侧处理 `ready` 消息的结果，供调用方打日志/拼状态栏文案。 */
export interface WorkerReadyResult {
  /** 该消息是不是 `ready`（false = 调用方继续走自己的分支）。 */
  isReady: boolean;
  /** 协议是否一致（`isReady` 为 false 时恒为 true）。 */
  ok: boolean;
  /** worker 上报的版本：数字或「无（旧构建）」；一致时为 `WORKER_PROTOCOL`。 */
  got: string;
  /** 期望版本（= `WORKER_PROTOCOL`）。 */
  expected: number;
}

/**
 * 主线程侧统一比对：`ready` 消息 → 校验协议；其它消息 → 原样放过。
 *
 * 调用方只需要：
 * ```ts
 * const r = handleWorkerReady(msg);
 * if (r.isReady) {
 *   if (!r.ok) setStatus(`Worker 是旧构建（协议 ${r.got}，需要 ${r.expected}）：...`, 'error');
 *   else setStatus('Worker 已就绪。', 'success');
 *   return; // 或 break
 * }
 * // ...其它消息分支
 * ```
 */
export function handleWorkerReady(msg: ReadyMessageLike | null | undefined): WorkerReadyResult {
  if (!msg || msg.type !== 'ready') {
    return { isReady: false, ok: true, got: String(WORKER_PROTOCOL), expected: WORKER_PROTOCOL };
  }
  const raw = msg.protocol;
  const got = raw === undefined ? '无（旧构建）' : String(raw);
  const ok = raw === WORKER_PROTOCOL;
  return { isReady: true, ok, got, expected: WORKER_PROTOCOL };
}

/** 旧构建的提示文案（两端状态栏共用，避免措辞漂移）。 */
export function workerStaleMessage(result: WorkerReadyResult): string {
  return `Worker 是旧构建（协议 ${result.got}，需要 ${result.expected}）：请执行 npm run build:worker（或 build:ts）后硬刷新。`;
}
