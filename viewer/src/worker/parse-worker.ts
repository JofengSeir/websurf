/**
 * 录像解析 Worker：JSON.parse + 帧数组定位 + 应用规则脚本，产出定型数组零拷贝回传。
 *
 * 会缓存已解析的 JSON 根节点——调规则时不必重复解析几十 MB 的文件。
 * 没有 Worker 环境时，主线程 importer 会走同源回退路径。
 */

import { compileScript, probeScript } from '../replay/codegen.js';
import { findArrayCandidates, getPath, num, pickFrameArray, readMeta } from '../replay/helpers.js';
import { buildClip, safePreview } from '../replay/build.js';
import type { ParseRequest, ParseResponse } from '../replay/protocol.js';
import type { Clip } from '../replay/types.js';

interface WorkerCtx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: ParseResponse, transfer?: Transferable[]) => void;
}

const ctx = self as unknown as WorkerCtx;

let cachedFile: File | null = null;
let cachedRoot: unknown = undefined;

function post(msg: ParseResponse, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
}

async function ensureRoot(file: File, id: number): Promise<unknown> {
  if (cachedFile === file && cachedRoot !== undefined) return cachedRoot;
  post({ id, type: 'progress', phase: 'parse', done: 0, total: 1 });
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    throw new Error(`读取文件失败：${e instanceof Error ? e.message : String(e)}`);
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  cachedFile = file;
  cachedRoot = root;
  post({ id, type: 'progress', phase: 'parse', done: 1, total: 1 });
  return root;
}

function locateFrames(root: unknown, framePath: string): unknown[] {
  const value = framePath ? getPath(root, framePath) : getPath(root, pickFrameArray(root) ?? '__none__');
  if (!Array.isArray(value)) {
    throw new Error(
      framePath
        ? `路径 "${framePath}" 取到的不是数组`
        : '没能在 JSON 里自动找到「元素为对象的数组」，请在「数据定位」里手动填路径',
    );
  }
  if (value.length === 0) throw new Error('帧数组为空');
  return value;
}

ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as ParseRequest;
  void handle(req);
};

async function handle(req: ParseRequest): Promise<void> {
  const { id } = req;
  try {
    if (req.type === 'reset') {
      cachedFile = null;
      cachedRoot = undefined;
      return;
    }

    if (req.type === 'probe') {
      const root = await ensureRoot(req.file, id);
      const candidates = findArrayCandidates(root).map((c) => ({
        path: c.path,
        length: c.length,
        depth: c.depth,
      }));
      const auto = pickFrameArray(root);
      let sample = '';
      if (auto !== null) {
        const arr = getPath(root, auto) as unknown[];
        if (Array.isArray(arr) && arr.length > 0) sample = safePreview(arr[0]);
      }
      post({
        id,
        type: 'probed',
        candidates,
        resolvedPath: auto,
        sample,
        meta: readMeta(root),
      });
      return;
    }

    // rawpos：取某帧的原始坐标（未经规则变换），供坐标系标定使用
    if (req.type === 'rawpos') {
      if (cachedRoot === undefined) {
        throw new Error('还没有解析过录像文件——先导入一次再做标定');
      }
      const resolvedPath = req.framePath || pickFrameArray(cachedRoot) || '';
      const frames = locateFrames(cachedRoot, resolvedPath);
      const idx = Math.max(0, Math.min(frames.length - 1, Math.floor(req.index)));
      const raw = frames[idx];
      const v = req.paths.map((p) => num(getPath(raw, p)));
      const ok = v.every((x) => Number.isFinite(x));
      post({
        id,
        type: 'rawposed',
        value: ok ? [v[0], v[1], v[2]] : null,
        preview: safePreview(raw),
        count: frames.length,
      });
      return;
    }

    // import
    const file = req.file ?? cachedFile;
    if (!file) throw new Error('没有可解析的文件');
    const root = await ensureRoot(file, id);

    const resolvedPath = req.rule.framePath || pickFrameArray(root) || '';
    const frames = locateFrames(root, resolvedPath);

    const fn = compileScript(req.rule.scriptSrc);
    const probe = probeScript(fn, frames);
    if (!probe.ok) {
      throw new Error(
        `${probe.error ?? '规则校验失败'}\n原始对象：${safePreview(frames[probe.frameIndex ?? 0])}`,
      );
    }

    post({ id, type: 'progress', phase: 'map', done: 0, total: frames.length });
    const { clip, warnings } = buildClip({
      name: req.name,
      frames,
      fn,
      rule: req.rule,
      resolvedPath,
      onProgress: (done, total) => post({ id, type: 'progress', phase: 'map', done, total }),
    });
    post({ id, type: 'progress', phase: 'map', done: frames.length, total: frames.length });

    const transfer: Transferable[] = [clip.t.buffer, clip.pos.buffer, clip.ang.buffer];
    if (clip.vel) transfer.push(clip.vel.buffer);
    post(
      {
        id,
        type: 'done',
        payload: clipToPayload(clip),
        warnings,
        resolvedPath,
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
  };
}
