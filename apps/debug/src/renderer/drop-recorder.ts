/**
 * 掉帧记录器（**只给 apps/debug**，不属于共享层）。
 *
 * 用户报「玩着玩着 HUD 掉到 280」，但干净回放/重载区实测只有 0.05–0.25% 的单槽滑移，
 * 现场条件（面板、线框、长时间游玩、输入）无法在脚本里完全复刻。这里做一件事：
 * 常驻轻量记录「单帧耗时超阈值」那一刻的现场，事后 `__vbspDropRec.dump()` 拿出来看。
 *
 * 用法（F12 控制台）：
 * - `__vbspDropRec.dump()`    → 打印并返回最近记录（最多 120 条）的 JSON 文本。
 * - `__vbspDropRec.stats()`   → 只给汇总（记录数、最大间隔、每秒丢帧分布）。
 * - `__vbspDropRec.clear()`   → 清空。
 * - `__vbspDropRec.stop()` / `.start()` → 暂停 / 恢复（默认常驻开启，开销只在超阈值时才写一条）。
 * - `__vbspDropRec.setThreshold(ms)` → 改阈值（默认 4.5ms；调小可在低负载机位自测）。
 *
 * 记录内容：墙钟/相对时间、本次 rAF 间隔、上一帧分段耗时（frame/vis/near/sort/water/sky，
 * 需要 `__vbspDrawDebug.on` 打开才有）、相机位姿、玩家脚底状态/速度、drawn 块数、
 * 计算帧率上限与实际 Hz、帧预算等级、GC/heap（`performance.memory`，Chromium 可用）、
 * 该间隔是否伴随 longtask（PerformanceObserver）、回放模式/单步闸门/窗口可见性。
 */

export interface DropRecorderContext {
  /** 相机位姿（度）；拿不到返回 null。 */
  getPose(): { pos: [number, number, number]; yawDeg: number; pitchDeg: number } | null;
  /** 玩家状态（脚底/速度/着地）；拿不到返回 null。 */
  getPlayerState():
    | { posX: number; posY: number; posZ: number; velX: number; velY: number; velZ: number; onGround: boolean }
    | null;
  /** 可见块数。 */
  getDrawn(): number;
  /** 计算帧率上限（Hz）。 */
  getComputeRateCap(): number;
  /** 模拟时钟实际 Hz；未运行返回 null。 */
  getSimClockHz(): number | null;
  /** 是否在回放模式。 */
  isReplay(): boolean;
  /** 实体运行期统计（可选，用于判断实体/粒子是否是现场因素）。 */
  getEntityStats?(): unknown;
}

export interface DropRecord {
  /** ISO 墙钟时间。 */
  at: string;
  /** 相对记录器启动的毫秒。 */
  tMs: number;
  /** 本次 rAF 间隔（ms）。 */
  dtMs: number;
  /** 上一帧分段耗时（`__vbspFrameLog` 最后一条；未开 drawDebug 时为 null）。 */
  segments: { frame?: number; vis?: number; near?: number; sort?: number; water?: number; sky?: number } | null;
  /** 该间隔内是否有 longtask（>50ms 主线程阻塞）。 */
  longTask: boolean;
  pose: DropRecorderContext['getPose'] extends () => infer R ? R : never;
  player: DropRecorderContext['getPlayerState'] extends () => infer R ? R : never;
  drawn: number;
  computeRateCap: number;
  simClockHz: number | null;
  budgetLevel: number;
  replay: boolean;
  hidden: boolean;
  /** 该间隔前后 8 帧的 rAF 间隔（看是单发尖峰还是连续滑移）。 */
  neighbors: number[];
  /** JS 堆（MB，Chromium 专有）。 */
  heapMb: number | null;
  entityStats?: unknown;
}

export interface DropRecorderApi {
  start(): void;
  stop(): void;
  clear(): void;
  setThreshold(ms: number): void;
  stats(): {
    enabled: boolean;
    thresholdMs: number;
    count: number;
    maxDtMs: number;
    longTasks: number;
    /** 按秒聚合：秒 → 丢的槽数（>1 个槽）。 */
    dropsPerSecond: Record<string, number>;
  };
  dump(): string;
  /** 触发一次浏览器下载（`vbsp-drops-<时间>.json`），省去从控制台复制长文本。 */
  download(): void;
  readonly records: DropRecord[];
}

const DEFAULT_THRESHOLD_MS = 4.5;
const MAX_RECORDS = 120;

/**
 * 安装记录器（幂等：重复调用返回同一个 API）。
 * 挂在 `globalThis.__vbspDropRec`，**只由 debug 端的 renderer 调用**。
 */
export function installDropRecorder(ctx: DropRecorderContext): DropRecorderApi {
  const existing = (globalThis as { __vbspDropRec?: DropRecorderApi }).__vbspDropRec;
  if (existing) return existing;

  const records: DropRecord[] = [];
  const recent: number[] = [];
  let enabled = true;
  let thresholdMs = DEFAULT_THRESHOLD_MS;
  let lastTickMs = 0;
  let t0 = 0;
  let longTaskSeq = 0;
  let longTaskLast = -1;

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 50) longTaskSeq++;
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    // 浏览器不支持 longtask 时静默降级（记录里 longTask 恒 false）
  }

  const frameLogSegments = (): DropRecord['segments'] => {
    const log = (globalThis as { __vbspFrameLog?: Array<Record<string, number>> }).__vbspFrameLog;
    const last = log && log.length ? log[log.length - 1] : null;
    if (!last) return null;
    return {
      frame: last.frame,
      vis: last.vis,
      near: last.near,
      sort: last.sort,
      water: last.water,
      sky: last.sky,
    };
  };

  const heapMb = (): number | null => {
    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? +(mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) : null;
  };

  const api: DropRecorderApi = {
    start() {
      enabled = true;
      lastTickMs = performance.now();
    },
    stop() {
      enabled = false;
    },
    clear() {
      records.length = 0;
      recent.length = 0;
    },
    setThreshold(ms: number) {
      if (Number.isFinite(ms) && ms > 0.5) thresholdMs = ms;
    },
    stats() {
      const dropsPerSecond: Record<string, number> = {};
      for (const r of records) {
        const sec = String(Math.floor(r.tMs / 1000));
        dropsPerSecond[sec] = (dropsPerSecond[sec] ?? 0) + 1;
      }
      return {
        enabled,
        thresholdMs,
        count: records.length,
        maxDtMs: records.reduce((m, r) => Math.max(m, r.dtMs), 0),
        longTasks: records.filter((r) => r.longTask).length,
        dropsPerSecond,
      };
    },
    dump() {
      const text = JSON.stringify({ stats: api.stats(), records }, null, 1);
      console.info('[drop-rec] ' + text);
      return text;
    },
    download() {
      try {
        const blob = new Blob([api.dump()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vbsp-drops-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) {
        console.warn('[drop-rec] download 失败，请改用 dump() 复制：' + String(e));
      }
    },
    get records() {
      return records;
    },
  };

  (globalThis as { __vbspDropRec?: DropRecorderApi }).__vbspDropRec = api;
  // 分段耗时（frame/vis/near/sort/water/sky）只在 `__vbspDrawDebug.on` 时由 render-session 写入
  // 环形日志；记录器要能给出「这次掉帧是不是水面 pass 那帧」，所以安装时顺手打开它。
  // 开销：每帧多几个 performance mark + 一条 ≤600 环记录（实测对帧间隔无可见影响）。
  const dbg = (globalThis as { __vbspDrawDebug?: { on?: boolean } }).__vbspDrawDebug;
  if (!dbg || dbg.on !== true) {
    (globalThis as { __vbspDrawDebug?: { on?: boolean } }).__vbspDrawDebug = { on: true };
  }
  t0 = performance.now();
  lastTickMs = t0;
  console.info(
    '[drop-rec] 已安装：单帧 >' + DEFAULT_THRESHOLD_MS + 'ms 自动记录，控制台用 __vbspDropRec.dump() 取数据；'
      + '__vbspDropRec.stats() 看汇总，__vbspDropRec.download() 直接存 JSON',
  );

  // rAF 钩子：由 debug renderer 的 `tick` 每帧调 `dropRecorderTick(now)`（见文件头用法），
  // 不在这里包 `requestAnimationFrame`——渲染循环本身已经每帧过一次，包一层反而会改变调用时序。
  (globalThis as { __vbspDropRecTick?: (now: number) => void }).__vbspDropRecTick = (now: number) => {
    const prev = lastTickMs;
    lastTickMs = now;
    if (!enabled || prev === 0) return;
    const dt = now - prev;
    recent.push(+dt.toFixed(2));
    if (recent.length > 16) recent.shift();
    if (dt < thresholdMs) return;
    const state = ctx.getPlayerState();
    records.push({
      at: new Date().toISOString(),
      tMs: +(now - t0).toFixed(1),
      dtMs: +dt.toFixed(2),
      segments: frameLogSegments(),
      longTask: longTaskSeq !== longTaskLast ? ((longTaskLast = longTaskSeq), true) : false,
      pose: ctx.getPose(),
      player: state,
      drawn: ctx.getDrawn(),
      computeRateCap: ctx.getComputeRateCap(),
      simClockHz: ctx.getSimClockHz(),
      budgetLevel:
        typeof (globalThis as { __vbspBudgetLevel?: number }).__vbspBudgetLevel === 'number'
          ? ((globalThis as { __vbspBudgetLevel?: number }).__vbspBudgetLevel as number)
          : 0,
      replay: ctx.isReplay(),
      hidden: typeof document !== 'undefined' ? document.hidden : false,
      neighbors: recent.slice(0, -1),
      heapMb: heapMb(),
      entityStats: ctx.getEntityStats?.(),
    });
    if (records.length > MAX_RECORDS) records.shift();
  };
  // 提供数值稳定的 read-only 钩子：renderer 每帧调 `dropRecorderTick(now)`。
  return api;
}

/** 每帧调用（debug renderer 的 `tick` 开头）；未安装时是空操作。 */
export function dropRecorderTick(now: number): void {
  (globalThis as { __vbspDropRecTick?: (n: number) => void }).__vbspDropRecTick?.(now);
}
