/**
 * 录像解析 Worker：Shavit `.replay` 原生解析，产出定型数组零拷贝回传。
 *
 * t4 起 JSON 解析通道已移除——这是唯一的录像导入路径：
 * 先按魔数嗅探（在 file.text() 之前——文本解码会破坏二进制），非 `.replay` 明确报错。
 * 缓存的只是原始字节，重导（改映射/变换）时重新解码，避免缓冲区被 transfer 后失效。
 * 没有 Worker 环境时，主线程 importer 会走同源回退路径。
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

/** Shavit .replay 缓存（字节级；重导时重新解码，避免缓冲区被 transfer 后失效）。 */
let cachedNativeFile: File | null = null;
let cachedNativeBytes: ArrayBuffer | null = null;

function post(msg: ParseResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as ParseRequest;
  void handle(req);
};

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
