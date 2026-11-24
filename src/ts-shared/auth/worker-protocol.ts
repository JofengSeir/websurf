/**
 * 主线程 ↔ 权威 Worker 的消息协议版本。
 *
 * 背景（2026-11-17 事故）：`apps/*` 的 `build:app` 只重建 `web/app.js`，
 * `set-player-name` 这类 worker 侧新消息在旧 `web/worker.js` 里不存在，
 * 浏览器就会「前端改了、权威行为没变」，且没有任何报错——排查了很久。
 *
 * 约定：
 * - 只要 `WorkerMessage` / `MainMessage` 的**语义**有增删改，就把版本号 +1；
 * - Worker 在 `ready` 消息里带上自己的版本；
 * - 主线程版本不一致时在状态栏显式报错，提示重建 worker，避免静默跑旧 bundle。
 */
export const WORKER_PROTOCOL = 3;
