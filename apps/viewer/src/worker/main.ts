/**
 * 回放解析 Worker 源码（`apps/viewer/package.json` 的 `build:worker` 用 esbuild 打成
 * `web/worker.js`）。这是本工程的回放导入路径：进 `ParseRequest`、出 `ParseResponse`，
 * 协议与字段见 `apps/viewer/src/replay/protocol.ts`，主线程侧对手是
 * `apps/viewer/src/replay/importer.ts` 的 `ReplayImporter`。
 *
 * 关键不变量：
 * - **魔数嗅探先于任何文本解码**：记录文件是二进制，先按 `fileLooksLikeShavitReplay` /
 *   `fileLooksLikeGokzRec` 判定并分派格式（Shavit `.replay` 或 KSF `.rec`），都不命中直接回
 *   `type: 'error'`（文本解码会破坏字节）；
 * - 缓存的是**原始字节**（`cachedNativeBytes`）而不是解析结果：改映射/变换重导时重新解码，
 *   同时避免 buffer 被 transfer 出去后本地失效；
 * - 回传的定型数组 buffer 全部进 transfer 列表（`t`/`pos`/`ang` 必有，`vel`/`buttons` 存在
 *   才加）⇒ 零拷贝，但发送后这些 buffer 在 Worker 侧已不可再用；
 * - 进度只发 `'parse'` 阶段两条（0/1、1/1）；协议里不再声明第二个阶段（原 `'map'` 已按 T-167 删除）；
 * - 单条请求的异常在 `handle` 内收敛成 `type: 'error'` 响应，不会漏到 `onmessage`；
 * - 本文件不做 Worker 能力检测：环境里起不了 Worker 时，由主线程侧
 *   `apps/viewer/src/replay/importer.ts` 退回 `importOnMain` 做同源解析。
 */

import {
  clipFromShavitReplay,
  fileLooksLikeShavitReplay,
  parseShavitReplay,
} from '../replay/shavit-replay.js';
import { clipFromGokzRec, fileLooksLikeGokzRec, parseGokzRec } from '../replay/gokz-rec.js';
import type { ClipPayload, ParseRequest, ParseResponse } from '../replay/protocol.js';
import type { Clip } from '../replay/types.js';

// Worker 全局面不再手写类型：直接用 `lib` 里的 `WebWorker`（`apps/viewer/tsconfig.json` 的
// `lib` 已含它）——`self` 本身就是 `WorkerGlobalScope & typeof globalThis`，其 `onmessage` /
// `postMessage`（含 transfer 形参）都由 lib 提供，故此处不再需要 `interface WorkerCtx`。
// 保留下面这个 `ctx` 别名只为少改调用点：类型与 `self` 完全一致，无断言、无收窄。

const ctx = self;

/** Shavit .replay 缓存：`cachedNativeFile` 是上次取字节的文件句柄，`cachedNativeBytes` 是其原始
 *  字节；仅当本次请求的 `file` 与缓存句柄同一个对象时才复用字节，否则重新 `arrayBuffer()`。 */
let cachedNativeFile: File | null = null;
let cachedNativeBytes: ArrayBuffer | null = null;

/** 薄封装：给 `ctx.postMessage` 一个确定签名（`WebWorker` lib 的 transfer 形参不接受 `undefined`）。 */
function post(msg: ParseResponse, transfer?: Transferable[]): void {
  if (transfer) ctx.postMessage(msg, transfer); else ctx.postMessage(msg);
}

/** Worker 入口：只挂 `onmessage`，不 await `handle`——异常已在 `handle` 内转成 `'error'` 响应。 */
ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as ParseRequest;
  void handle(req);
};

/** 单条请求的全流程：取文件（`req.file` 或缓存）→ 魔数嗅探 → 取字节并缓存 → 原生解析 →
 *  生成 `Clip` → 带 transfer 列表回 `'done'`；任一步抛错都收敛为 `'error'` 响应。 */
async function handle(req: ParseRequest): Promise<void> {
  const { id } = req;
  try {
    const file = req.file ?? cachedNativeFile;
    if (!file) throw new Error('没有可解析的文件');

    // 魔数嗅探与格式分派必须在文本解码之前——记录文件是二进制，file.text() 会破坏它
    const isShavit = await fileLooksLikeShavitReplay(file);
    const isGokz = !isShavit && (await fileLooksLikeGokzRec(file));
    if (!isShavit && !isGokz) {
      throw new Error(
        `${req.name} 不是受支持的记录文件——viewer 只收 Shavit .replay 与 KSF .rec（JSON/规则脚本通道已移除）`,
      );
    }

    post({ id, type: 'progress', phase: 'parse', done: 0, total: 1 });
    let bytes = cachedNativeFile === file ? cachedNativeBytes : null;
    if (!bytes) {
      try {
        bytes = await file.arrayBuffer();
      } catch (e) {
        throw new Error(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
      }
      cachedNativeFile = file;
      cachedNativeBytes = bytes;
    }

    const { clip, warnings } = isGokz
      ? clipFromGokzRec(req.name, parseGokzRec(bytes, {
          // File.lastModified 是 ms；时间戳兜底取 Unix 秒（与 Shavit 路径同口径）
          timestampFallback: Math.floor(file.lastModified / 1000),
          // 坐标映射切换（默认 shavit 定标映射；仅用户显式切换时非默认）
          mapping: { axesMode: ruleOf(req).axesMode, yawMode: ruleOf(req).yawMode },
        }), ruleOf(req))
      : clipFromShavitReplay(req.name, parseShavitReplay(bytes, {
          // File.lastModified 是 ms；.replay 头部 iTimestamp 是 Unix 秒（mtime 兜底同单位）
          timestampFallback: Math.floor(file.lastModified / 1000),
          // 坐标映射切换（默认 shavit 定标映射；仅用户显式切换时非默认）
          mapping: { axesMode: ruleOf(req).axesMode, yawMode: ruleOf(req).yawMode },
        }), ruleOf(req));
    post({ id, type: 'progress', phase: 'parse', done: 1, total: 1 });

    const transfer: Transferable[] = [clip.t.buffer, clip.pos.buffer, clip.ang.buffer];
    if (clip.vel) transfer.push(clip.vel.buffer);
    if (clip.buttons) transfer.push(clip.buttons.buffer);
    post(
      {
        id,
        type: 'done',
        payloads: [clipToPayload(clip)],
        warnings,
        resolvedPath: clip.resolvedPath,
      },
      transfer,
    );
  } catch (err) {
    post({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 逐字段构造 `ClipPayload`（见 `apps/viewer/src/replay/protocol.ts`）：显式列字段而不用展开，
 *  返回对象与 `transfer` 里那些 buffer 同源；**返回类型显式写在签名上**，故字段写错时
 *  `npm run typecheck` 在**定义处**报错（而不是落到 `post` 的调用点）。 */
function clipToPayload(clip: Clip): ClipPayload {
  return {
    name: clip.name,
    count: clip.count,
    t: clip.t,
    pos: clip.pos,
    ang: clip.ang,
    vel: clip.vel,
    duration: clip.duration,
    bbox: clip.bbox,
    maxSpeed: clip.maxSpeed,
    resolvedPath: clip.resolvedPath,
    buttons: clip.buttons,
    meta: clip.meta,
  };
}

/** 取请求里的规则配置；缺字段时给出**明确错误**，而不是让 `req.rule.x` 抛 TypeError 被 catch 成笼统 error（T-155）。 */
function ruleOf(req: ParseRequest): ParseRequest['rule'] {
  if (!req.rule) throw new Error('导入请求缺少 rule 配置——面板应总是带上它，请刷新页面后重试');
  return req.rule;
}
