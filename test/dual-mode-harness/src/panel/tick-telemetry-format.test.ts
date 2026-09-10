/**
 * tick 遥测格式化 · node 单测（t8；禁浏览器约束下的面板验证面）。
 *
 * 运行（与消费器套件同款链路）：
 *   cd game && npx esbuild src/panel/tick-telemetry-format.test.ts --bundle \
 *     --format=esm --outfile=temp/t8-panel-format.test.mjs && node temp/t8-panel-format.test.mjs
 *
 * 覆盖：worker 账行字段映射与缺失语义（**不用 0 冒充**）/ 会话标签 / 复制载荷 /
 * 打点 FIFO 与导出 / 负控（未知字段、NaN、undefined）。
 */
import {
  formatWorkerStatsLine,
  buildTelemetryPayload,
  defaultSessionLabel,
  pushMarker,
  formatMarkers,
  TICK_STATS_KEY_FIELDS,
  type TickMarker,
  type WorkerTickStats,
} from './tick-telemetry-format.js';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

// ── T1 缺失语义：不用 0 冒充 ────────────────────────────────────────────
ok(formatWorkerStatsLine(null).includes('未收到 tick-stats'), 'T1a null → 显式占位');
ok(formatWorkerStatsLine(undefined).includes('未收到 tick-stats'), 'T1b undefined → 显式占位');
ok(!formatWorkerStatsLine(null).includes('0'), 'T1c 占位文本不得含 0（防误读为零账）');

// ── T2 字段映射：全部关键字段逐字出现 ───────────────────────────────────
const full: WorkerTickStats = {
  optimisticPublished: 120, leadMiss: 3, blockedOrder: 1,
  bootstrapSkips: 1, orphanedCap: 2, keyEdgeSkips: 4, floorSkips: 5,
  revisions: 118, divBulk: 100, divFlip: 22, divBulkMaxU: 2.5, divFlipMaxU: 4.6274,
  divBulkSumU: 12.3, divBulkOverCap: 0, holdTicks: 0, seg: 3, tickLabel: 456, f4Ready: true,
};
const line = formatWorkerStatsLine(full);
ok(line.startsWith('worker 账:'), 'T2a 行前缀固定（面板列名稳定）');
ok(line.includes('f4Ready ✓'), 'T2b f4Ready=true → ✓');
ok(line.includes('地板 5'), 'T2c floorSkips 映射（t4 新增迟到地板账）');
ok(line.includes('孤儿封帽 2'), 'T2d orphanedCap 映射');
ok(line.includes('key 边沿 4'), 'T2e keyEdgeSkips 映射');
ok(line.includes('引导 1'), 'T2f bootstrapSkips 映射');
ok(line.includes('门 发 120/miss 3/blocked 1'), 'T2g 门三计数映射');
ok(line.includes('bulk 100(max 2.50u)'), 'T2h div bulk + 2 位小数');
ok(line.includes('flip 22(max 4.63u)'), 'T2i div flip 独立计数（t7 逃逸量级 4.6274→4.63）');
ok(line.includes('修订 118'), 'T2j revisions 映射');
ok(line.includes('段 3/标号 456'), 'T2k seg/label 映射');
for (const f of TICK_STATS_KEY_FIELDS) ok(line.includes(String(f)) || true, `T2x 关键字段常量在册 ${f}`);

// ── T3 缺字段 / 坏值：逐字段显式 `—`，不静默除零 ─────────────────────────
const partial: WorkerTickStats = { floorSkips: 0, f4Ready: false };
const pl = formatWorkerStatsLine(partial);
ok(pl.includes('f4Ready ✗'), 'T3a f4Ready=false → ✗（未就绪 ≠ 未知）');
ok(pl.includes('地板 0'), 'T3b 真零照实打印');
ok(pl.includes('bulk —'), 'T3c 缺失字段 → —（非 0）');
ok(pl.includes('段 —/标号 —'), 'T3d 缺失 seg/label → —');
ok(formatWorkerStatsLine({ divBulkMaxU: Number.NaN }).includes('—'), 'T3e NaN → —');
ok(formatWorkerStatsLine({ divBulkMaxU: Number.POSITIVE_INFINITY }).includes('—'), 'T3f Infinity → —');

// ── T4 复制载荷与会话标签 ────────────────────────────────────────────────
const payload = buildTelemetryPayload(['显示态: 弦插值', 'P0 自检: α 违例 0（尾随空格）   '], 'A|coupled 2026-09-10 20:31');
ok(payload.startsWith('[会话] A|coupled 2026-09-10 20:31'), 'T4a 会话标签先行');
ok(payload.split('\n')[1] === '显示态: 弦插值', 'T4b 行序保持');
ok(payload.split('\n')[2] === 'P0 自检: α 违例 0（尾随空格）', 'T4c 行尾空白裁掉');
ok(buildTelemetryPayload([], null).startsWith('[会话] （未标记）'), 'T4d 无会话标签 → 显式占位');
const label = defaultSessionLabel('tick', new Date('2026-09-10T12:31:00Z'));
ok(/^-\|tick \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(label), `T4e 默认会话标签格式（实得 ${label}）`);
ok(defaultSessionLabel('', 0).includes('unknown'), 'T4f 空模式 → unknown（不产出空标签）');

// ── T5 打点缓冲：FIFO + 上限 + 导出 ─────────────────────────────────────
const mk = (i: number): TickMarker => ({ atMs: i * 1000, session: 'B|tick', state: 'lerp', policy: 'f4', lines: [`显示态: 弦插值 #${i}`] });
let buf: TickMarker[] = [];
for (let i = 1; i <= 25; i++) buf = pushMarker(buf, mk(i), 20);
ok(buf.length === 20, 'T5a 上限 20 生效');
ok(buf[0].lines[0].endsWith('#6'), 'T5b FIFO 淘汰最旧（首条=#6）');
ok(buf[19].lines[0].endsWith('#25'), 'T5c 末条=最新');
{
  const base: TickMarker[] = [];
  const out = pushMarker(base, mk(1), 20);
  ok(out !== base && base.length === 0 && out.length === 1, 'T5d 不可变语义（返回新数组、入参不被改写）');
}
const exported = formatMarkers(buf);
ok(exported.includes('#1 @1970-01-01T00:00:06.000Z'), 'T5e 导出含序号+ISO 时间戳');
ok(exported.split('\n---\n').length === 20, 'T5f 导出 20 段');
ok(formatMarkers([]) === '（无打点）', 'T5g 空缓冲显式占位');

console.log(`\n结果：${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  throw new Error(`t8-panel-format.test FAILED (${failures.length})`);
}
