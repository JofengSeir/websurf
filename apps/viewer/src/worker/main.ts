/**
 * 录像解析 Worker 源码（`apps/viewer/package.json` 的 `build:worker` 用 esbuild 打成
 * `web/worker.js`）。这是本工程的录像导入路径：进 `ParseRequest`、出 `ParseResponse`，
 * 协议与字段见 `apps/viewer/src/replay/protocol.ts`，主线程侧对手是
 * `apps/viewer/src/replay/importer.ts` 的 `ReplayImporter`。
 *
 * 关键不变量：
 * - **魔数嗅探先于任何文本解码**：`.replay` 是二进制，先按 `fileLooksLikeShavitReplay` 判定，
 *   非 `.replay` 直接回 `type: 'error'`（文本解码会破坏字节）；
 * - 缓存的是**原始字节**（`cachedNativeBytes`）而不是解析结果：改映射/变换重导时重新解码，
 *   同时避免 buffer 被 transfer 出去后本地失效；
 * - 回传的定型数组 buffer 全部进 transfer 列表（`t`/`pos`/`ang` 必有，`vel`/`buttons` 存在
 *   才加）⇒ 零拷贝，但发送后这些 buffer 在 Worker 侧已不可再用；
 * - 进度只发 `'parse'` 阶段两条（0/1、1/1）；`ParseResponse` 声明的 `'map'` 阶段本文件不发；
 * - 单条请求的异常在 `handle` 内收敛成 `type: 'error'` 响应，不会漏到 `onmessage`；
 * - 本文件不做 Worker 能力检测：环境里起不了 Worker 时，由主线程侧
 *   `apps/viewer/src/replay/importer.ts` 退回 `importOnMain` 做同源解析。
 */

import {
  clipFromShavitReplay,
  fileLooksLikeShavitReplay,
  parseShavitReplay,
} from '../replay/shavit-replay.js';
import type { ParseRequest, ParseResponse } from '../replay/protocol.js';
import type { Clip } from '../replay/types.js';

interface WorkerCtx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: ParseResponse, transfer?: Transferable[]) => void;
}

const ctx = self as unknown as WorkerCtx;

/** Shavit .replay 缓存：`cachedNativeFile` 是上次取字节的文件句柄，`cachedNativeBytes` 是其原始
 *  字节；仅当本次请求的 `file` 与缓存句柄同一个对象时才复用字节，否则重新 `arrayBuffer()`。 */
let cachedNativeFile: File | null = null;
let cachedNativeBytes: ArrayBuffer | null = null;

/** 薄封装：给 `ctx.postMessage` 一个确定签名（Worker 全局的 `postMessage` 无返回值的类型缺口）。 */
function post(msg: ParseResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
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

    // 魔数嗅探必须在文本解码之前——Shavit .replay 是二进制，file.text() 会破坏它
    if (!(await fileLooksLikeShavitReplay(file))) {
      throw new Error(
        `${req.name} 不是 Shavit .replay 录像文件——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）`,
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

    const parsed = parseShavitReplay(bytes, {
      // File.lastModified 是 ms；.replay 头部 iTimestamp 是 Unix 秒（mtime 兜底同单位）
      timestampFallback: Math.floor(file.lastModified / 1000),
      // 坐标映射切换（默认 shavit 定标映射；仅用户显式切换时非默认）
      mapping: { axesMode: req.rule.axesMode, yawMode: req.rule.yawMode },
    });
    post({ id, type: 'progress', phase: 'parse', done: 1, total: 1 });

    const { clip, warnings } = clipFromShavitReplay(req.name, parsed, req.rule);

    const transfer: Transferable[] = [clip.t.buffer, clip.pos.buffer, clip.ang.buffer];
    if (clip.vel) transfer.push(clip.vel.buffer);
    if (clip.buttons) transfer.push(clip.buttons.buffer);
    post(
      {
        id,
        type: 'done',
        payload: clipToPayload(clip),
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
 *  返回对象与 `transfer` 里那些 buffer 同源；本函数无显式返回类型，形状由 `post` 处的
 *  `ParseResponse` 逐字段校验。 */
function clipToPayload(clip: Clip) {
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
