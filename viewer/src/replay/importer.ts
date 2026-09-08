/** 录像导入：优先走 Worker（不卡 UI），失败自动回退主线程；只支持 Shavit 原生 .replay。 */

import {
  clipFromShavitReplay,
  fileLooksLikeShavitReplay,
  parseShavitReplay,
} from './shavit-replay.js';
import type {
  ClipPayload,
  ParseRequest,
  ParseResponse,
} from './protocol.js';
import type { Clip, RuleConfig } from './types.js';

export type ImportPhase = 'parse' | 'map';
export type ProgressFn = (phase: ImportPhase, done: number, total: number) => void;

export interface ImportResult {
  clip: Clip;
  warnings: string[];
  resolvedPath: string;
}

interface Pending {
  resolve: (v: ParseResponse) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
}

export class ReplayImporter {
  private worker: Worker | null = null;
  private workerBroken = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Shavit .replay 的主线程回退缓存（字节级，重导时重新解码）。 */
  private mainNativeFile: File | null = null;
  private mainNativeBytes: ArrayBuffer | null = null;

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      // 单文件（file:// 双击）构建：Worker 代码内嵌在 globalThis.__VBSP_WORKER_JS__，
      // 用 Blob URL 起 Worker（file:// 下 new URL(..., import.meta.url) 的 module worker 会被拦）
      const g = globalThis as { __VBSP_WORKER_JS__?: unknown };
      let w: Worker;
      if (typeof g.__VBSP_WORKER_JS__ === 'string' && g.__VBSP_WORKER_JS__.length > 0) {
        const blob = new Blob([g.__VBSP_WORKER_JS__], { type: 'text/javascript' });
        w = new Worker(URL.createObjectURL(blob));
      } else {
        w = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
      }
      w.onmessage = (e: MessageEvent) => {
        const msg = e.data as ParseResponse;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'progress') {
          p.onProgress?.(msg.phase, msg.done, msg.total);
          return;
        }
        this.pending.delete(msg.id);
        p.resolve(msg);
      };
      w.onerror = (e) => {
        // Worker 起不来（缺少 parse-worker.js 等）：后续全部走主线程
        this.workerBroken = true;
        this.worker?.terminate();
        this.worker = null;
        const err = new Error(`解析 Worker 启动失败（${e.message || '未知原因'}），已改用主线程解析`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      this.worker = w;
      return w;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private send(req: ParseRequest, onProgress?: ProgressFn): Promise<ParseResponse> {
    const w = this.ensureWorker();
    if (!w) return Promise.reject(new Error('__NO_WORKER__'));
    return new Promise<ParseResponse>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      w.postMessage(req);
    });
  }

  /** 应用规则（映射切换 + 变换微调）并生成 Clip。file 为 null 时复用上次缓存的文件。 */
  async import(
    file: File | null,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    try {
      const res = await this.send({ id: ++this.seq, type: 'import', file, rule, name }, onProgress);
      if (res.type === 'error') throw new Error(res.message);
      if (res.type !== 'done') throw new Error('导入返回了意外的响应类型');
      return {
        clip: payloadToClip(res.payload, rule),
        warnings: res.warnings,
        resolvedPath: res.resolvedPath,
      };
    } catch (e) {
      if (isNoWorker(e) || this.workerBroken) return this.importOnMain(file, rule, name, onProgress);
      throw e;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  // ── 主线程回退（与 Worker 同源：嗅探 → 字节缓存 → 原生解析 → Clip）──

  private async importOnMain(
    file: File | null,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    const target = file ?? this.mainNativeFile;
    if (!target) throw new Error('没有可解析的文件');

    // 魔数嗅探必须在 text() 之前——Shavit .replay 是二进制，文本解码会破坏它
    if (!(await fileLooksLikeShavitReplay(target))) {
      throw new Error(
        `${name} 不是 Shavit .replay 录像文件——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）`,
      );
    }

    onProgress?.('parse', 0, 1);
    let bytes = this.mainNativeFile === target ? this.mainNativeBytes : null;
    if (!bytes) {
      bytes = await target.arrayBuffer();
      this.mainNativeFile = target;
      this.mainNativeBytes = bytes;
    }
    const parsed = parseShavitReplay(bytes, {
      // File.lastModified 是 ms；.replay 头部 iTimestamp 是 Unix 秒（mtime 兜底同单位）
      timestampFallback: Math.floor(target.lastModified / 1000),
      // 坐标映射切换（默认 shavit 定标映射；仅用户显式切换时非默认）
      mapping: { axesMode: rule.axesMode, yawMode: rule.yawMode },
    });
    onProgress?.('parse', 1, 1);
    const { clip, warnings } = clipFromShavitReplay(name, parsed, rule);
    return { clip, warnings, resolvedPath: clip.resolvedPath };
  }
}

function isNoWorker(e: unknown): boolean {
  return e instanceof Error && e.message === '__NO_WORKER__';
}

function payloadToClip(p: ClipPayload, rule: RuleConfig): Clip {
  return {
    id: `clip-${Date.now().toString(36)}`,
    name: p.name,
    count: p.count,
    t: p.t,
    pos: p.pos,
    ang: p.ang,
    vel: p.vel,
    duration: p.duration,
    bbox: p.bbox,
    maxSpeed: p.maxSpeed,
    resolvedPath: p.resolvedPath,
    rule,
    buttons: p.buttons,
    meta: p.meta,
  };
}
