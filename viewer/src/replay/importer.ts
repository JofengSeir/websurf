/** 录像导入：优先走 Worker（不卡 UI + 复用已解析的 JSON），失败自动回退主线程。 */

import { compileScript, probeScript } from './codegen.js';
import { getPath, pickFrameArray } from './helpers.js';
import { buildClip, safePreview } from './build.js';
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
  /** 主线程回退路径用的解析缓存。 */
  private mainFile: File | null = null;
  private mainRoot: unknown = undefined;

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

  /** 应用规则并生成 Clip。file 为 null 时复用上次已解析的文件（调规则不用重解析）。 */
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

  // ── 主线程回退 ────────────────────────────────────────────────────

  private async mainRootOf(file: File | null, onProgress?: ProgressFn): Promise<unknown> {
    const target = file ?? this.mainFile;
    if (!target) throw new Error('没有可解析的文件');
    if (target === this.mainFile && this.mainRoot !== undefined) return this.mainRoot;
    onProgress?.('parse', 0, 1);
    const text = await target.text();
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch (e) {
      throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    this.mainFile = target;
    this.mainRoot = root;
    onProgress?.('parse', 1, 1);
    return root;
  }

  private async importOnMain(
    file: File | null,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    const root = await this.mainRootOf(file, onProgress);
    const resolvedPath = rule.framePath || pickFrameArray(root) || '';
    const frames = resolveFrames(root, resolvedPath);
    const fn = compileScript(rule.scriptSrc);
    const probe = probeScript(fn, frames);
    if (!probe.ok) {
      throw new Error(
        `${probe.error ?? '规则校验失败'}\n原始对象：${safePreview(frames[probe.frameIndex ?? 0])}`,
      );
    }
    onProgress?.('map', 0, frames.length);
    const { clip, warnings } = buildClip({
      name,
      frames,
      fn,
      rule,
      resolvedPath,
      onProgress: (done, total) => onProgress?.('map', done, total),
    });
    onProgress?.('map', frames.length, frames.length);
    return { clip, warnings, resolvedPath };
  }
}

function isNoWorker(e: unknown): boolean {
  return e instanceof Error && e.message === '__NO_WORKER__';
}

function resolveFrames(root: unknown, framePath: string): unknown[] {
  const path = framePath || pickFrameArray(root) || '__none__';
  const value = getPath(root, path);
  if (!Array.isArray(value)) {
    throw new Error(
      framePath
        ? `路径 "${framePath}" 取到的不是数组`
        : '没能在 JSON 里自动找到「元素为对象的数组」——第三方格式请用规则 JSON 的 framePath 指定路径',
    );
  }
  if (value.length === 0) throw new Error('帧数组为空');
  return value;
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
  };
}
