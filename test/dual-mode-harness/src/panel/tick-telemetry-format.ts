/**
 * tick 遥测格式化（t8）——**纯函数**，可 node 直测（禁浏览器约束下唯一的验证面）。
 *
 * 背景：worker 侧 `TickF4Stats`（`src/ts-shared/auth/tick-authority.ts` 的
 * `post({ type:'tick-stats', stats })`）此前**主线程无任何消费者**（全仓无 handler），
 * 故 worker 侧的 div 双桶 / 门闭账 / 地板跳过等账目在真机 A/B 面板上不可见。
 * 本模块只做「数据 → 文本」的纯转换，DOM 接线留在 panel-controller.ts。
 *
 * 消费侧红线（t8 契约）：本模块**只读遥测、不做任何推定**——缺字段/未收到消息时
 * 显式打印占位文本，不用 0 冒充缺失值；不参与 α/τ/Δ 计算。
 */

/** worker `{type:'tick-stats'}` 载荷（`TickF4Stats` 的消费侧镜像；字段可缺）。 */
export interface WorkerTickStats {
  optimisticPublished?: number;
  leadMiss?: number;
  blockedOrder?: number;
  bootstrapSkips?: number;
  orphanedCap?: number;
  keyEdgeSkips?: number;
  floorSkips?: number;
  revisions?: number;
  divBulk?: number;
  divFlip?: number;
  divBulkMaxU?: number;
  divFlipMaxU?: number;
  divBulkSumU?: number;
  divBulkOverCap?: number;
  holdTicks?: number;
  seg?: number;
  tickLabel?: number;
  f4Ready?: boolean;
  [k: string]: unknown;
}

/** 面板固定展示的关键字段（顺序即渲染顺序；缺失时显式打 `—`）。 */
export const TICK_STATS_KEY_FIELDS = [
  'floorSkips',
  'orphanedCap',
  'keyEdgeSkips',
  'bootstrapSkips',
] as const;

const num = (v: unknown, digits = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? (digits ? v.toFixed(digits) : String(v)) : '—';

/**
 * worker 账行（面板第 6 行）。
 * - 未收到消息（null/undefined）→ 显式占位，**不用 0 冒充**；
 * - `f4Ready` 三态：✓ / ✗ / —（未知）。
 */
export function formatWorkerStatsLine(s: WorkerTickStats | null | undefined): string {
  if (s == null) return 'worker 账: （未收到 tick-stats——非 tick 模式，或 worker 尚未发首帧）';
  const ready = s.f4Ready === true ? '✓' : s.f4Ready === false ? '✗' : '—';
  const gate = `门 发 ${num(s.optimisticPublished)}/miss ${num(s.leadMiss)}/blocked ${num(s.blockedOrder)}`;
  const div = `worker div: bulk ${num(s.divBulk)}(max ${num(s.divBulkMaxU, 2)}u) flip ${num(s.divFlip)}(max ${num(s.divFlipMaxU, 2)}u) 超帽 ${num(s.divBulkOverCap)}`;
  const skips = `跳过: 地板 ${num(s.floorSkips)}/孤儿封帽 ${num(s.orphanedCap)}/key 边沿 ${num(s.keyEdgeSkips)}/引导 ${num(s.bootstrapSkips)}`;
  const misc = `修订 ${num(s.revisions)} | hold ${num(s.holdTicks)} | 段 ${num(s.seg)}/标号 ${num(s.tickLabel)}`;
  return `worker 账: f4Ready ${ready} | ${gate} | ${div} | ${skips} | ${misc}`;
}

/** 复制载荷（会话标签先行，便于 A/B 两臂归档区分）。 */
export function buildTelemetryPayload(lines: readonly string[], session?: string | null): string {
  const body = lines.map((l) => String(l ?? '').replace(/\s+$/u, '')).join('\n');
  const head = session ? `[会话] ${String(session).trim()}` : '[会话] （未标记）';
  return `${head}\n${body}`;
}

/** 会话标签默认值：`<臂>|<模式> <YYYY-MM-DD HH:mm>`（臂由用户填 A/B，缺省 `-`）。 */
export function defaultSessionLabel(mode: string, at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `-|${mode || 'unknown'} ${stamp}`;
}

/** 异常打点条目（本地停留缓冲用；点按瞬间直读遥测，绕开 500ms 轮询冲窗）。 */
export interface TickMarker {
  atMs: number;
  session: string;
  state: string;
  policy: string;
  lines: readonly string[];
}

/** 追加打点（保持上限，FIFO 淘汰；不修改入参）。 */
export function pushMarker(buf: readonly TickMarker[], entry: TickMarker, cap = 20): TickMarker[] {
  const next = [...buf, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 打点导出文本（逐条时间戳 + 快照；供用户原样回报）。 */
export function formatMarkers(buf: readonly TickMarker[]): string {
  if (!buf.length) return '（无打点）';
  return buf
    .map((m, i) => `#${i + 1} @${new Date(m.atMs).toISOString()} [${m.session}] state=${m.state} policy=${m.policy}\n${m.lines.join('\n')}`)
    .join('\n---\n');
}
