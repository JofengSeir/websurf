/**
 * 录像导入入口：优先把解析交给 Worker（避免长时间占用主线程），Worker 不可用或启动失败时
 * 自动回退到主线程做同一套解析；两条路径都只接受 Shavit 原生 `.replay`。
 *
 * 数据流：`File` + `RuleConfig` → （Worker 或主线程）`parseShavitReplay` →
 * `clipFromShavitReplay` → `Clip`。Worker 消息与载荷类型见
 * `apps/viewer/src/replay/protocol.ts`，Worker 侧实现见 `apps/viewer/src/worker/main.ts`。
 *
 * 关键不变量：
 * - 「Worker 坏掉」是**单向**的：`ensureWorker` 一旦置 `workerBroken`（抛异常或被 `onerror` 捕获），
 *   后续每次都直接走主线程，不再重试起 Worker；
 * - 两条路径对调用方同形：都返回 `ImportResult`，并按同一个 `ProgressFn` 约定回调进度
 *   （Worker 侧发 `'parse'` 的 0/1 与 1/1 两条，主线程侧在同一位置回调同样的值）；
 * - 缓存的是**原始字节**而不是解析结果：Worker 侧按文件对象句柄复用（见
 *   `apps/viewer/src/worker/main.ts` 的 `cachedNativeFile`），主线程侧按 `mainNativeFile` 复用，
 *   两者都以「换成新文件就重新读字节」为界。
 *
 * 本仓调用关系：本文件唯一的外部消费者是 `apps/viewer/src/replay/panel.ts` 的
 * `ReplayPanel.runImport`（每条成员的调用点情况写在各成员自己的注释里）。
 */

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

/** 进度阶段取值：`'parse'` = 解析 `.replay`，`'map'` = 规则映射；当前只有 `'parse'` 会被发出。 */
export type ImportPhase = 'parse' | 'map';
/** 进度回调签名（阶段 + 已完成 + 总数）。 */
export type ProgressFn = (phase: ImportPhase, done: number, total: number) => void;

export interface ImportResult {
  clip: Clip;
  warnings: string[];
  /** 导入来源标识；当前 Shavit 路径恒为 `'.replay'`（取自 `Clip.resolvedPath`）。 */
  resolvedPath: string;
}

/** pending 表的一项：响应到达时结算的 resolver / rejecter，外加本次请求的进度回调。 */
interface Pending {
  resolve: (v: ParseResponse) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
}

export class ReplayImporter {
  /** 解析 Worker 实例；懒创建，`dispose` 后置回 null。 */
  private worker: Worker | null = null;
  /** Worker 不可用标记：一旦为 true，`ensureWorker` 直接返回 null（不重试）。 */
  private workerBroken = false;
  /** 请求序号：`import` 每次自增并写进 `ParseRequest.id`，Worker 回填同一个 id。 */
  private seq = 0;
  /** 未结算请求表：key = `ParseRequest.id`；进度响应用它找回回调，终结响应把它删掉。 */
  private readonly pending = new Map<number, Pending>();
  /** 主线程回退路径的字节缓存句柄（与 `mainNativeBytes` 配套）。 */
  private mainNativeFile: File | null = null;
  /** 主线程回退路径缓存的原始字节（Worker 路径不写它）。 */
  private mainNativeBytes: ArrayBuffer | null = null;

  /**
   * 取（或懒建）Worker：首次创建时优先用单文件构建内嵌的 Worker 源码起 Blob Worker，
   * 没有内嵌源码才按模块 Worker 加载 `apps/viewer/web/worker.js`。
   *
   * 副作用与边界：
   * - 挂 `onmessage`（按 `id` 配回 pending：`'progress'` 只转发回调不结算，其余终结请求）
   *   与 `onerror`（置 `workerBroken`、终止并丢弃 Worker、用同一个错误拒绝全部未结算请求）；
   * - 构造期抛异常同样置 `workerBroken` 并返回 null；
   * - `workerBroken` 已置位时不再尝试创建。
   */
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
        w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
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
        // Worker 起不来（缺少 worker.js 等）：后续全部走主线程
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

  /** 无 Worker 可用时用哨兵错误拒绝（`import` 据此转主线程）。 */
  private send(req: ParseRequest, onProgress?: ProgressFn): Promise<ParseResponse> {
    const w = this.ensureWorker();
    if (!w) return Promise.reject(new Error('__NO_WORKER__'));
    return new Promise<ParseResponse>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      w.postMessage(req);
    });
  }

  /**
   * 导入一份录像并生成 `Clip`：先试 Worker，`send` 抛哨兵错误或 `workerBroken` 已置位时
   * 改走 `importOnMain`（同源解析）；其余异常原样上抛。
   *
   * `file` 为 null 时交由解析侧复用自己缓存的上一份文件——本仓唯一调用点
   * （`apps/viewer/src/replay/panel.ts` 的 `ReplayPanel.runImport`）保证非空。
   * 边界：`postMessage` 成功但 Worker 始终不回消息时，本 Promise 不设超时、不会被结算。
   */
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

  /** 终止 Worker 并清空未结算请求表（不置 `workerBroken`，下次 `import` 会重新起 Worker）；本仓无调用点。 */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  // ── 主线程回退（与 Worker 同源：嗅探 → 字节缓存 → 原生解析 → Clip）──

  /**
   * 主线程回退路径：目标文件取 `file ?? mainNativeFile`，两者都为空则抛错。
   * 先按魔数嗅探（是二进制判定，不做文本解码），非 `.replay` 直接抛错；
   * 字节只在「命中同一文件句柄」时复用缓存，否则重新 `arrayBuffer()` 并覆盖缓存。
   *
   * `ProgressFn` 的数值口径与 Worker 侧一致（`'parse'` 的 0/1 与 1/1），
   * 故面板按阶段读进度时两条路径表现一致。
   */
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

/** 是否为「无 Worker」哨兵错误（`send` 在 `ensureWorker` 返回 null 时抛出的那一条）。 */
function isNoWorker(e: unknown): boolean {
  return e instanceof Error && e.message === '__NO_WORKER__';
}

/**
 * Worker 载荷 → `Clip`：载荷里没有 `id` 与 `rule`（见
 * `apps/viewer/src/replay/protocol.ts` 的 `ClipPayload`），故 `id` 用「当前时间戳的 36 进制」
 * 现场生成，`rule` 取本次导入请求的规则快照。
 */
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
