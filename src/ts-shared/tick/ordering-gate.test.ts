/**
 * 单测：排序门 δ ≤ T − ε_max（任务 t2 验收 #3）。
 *
 * 覆盖（t6-render-ahead §8.1/§8.4）：
 * - 静态 cap 推导：setTimeout 档 7.625ms（§8.4 记 7.6）/ Atomics 档 14.625ms
 *   （记 14.6）；ε_max ≥ T 退化为 0；边界含等号（δ = cap 恰好满足 ≤）；
 * - 构造期钳制：δ=8 双量子（超 0.4ms）由排序门吸收到 cap（§8.4 严格值纪律）；
 * - 运行时发布门：排序违例 block-order（authoritative(k−1) 未发布/首 tick）、
 *   ε 尾 drop-late（now > due → lead-miss+1）、边界 now == due → publish；
 * - 实时语义演示：δ*+ε_max ≤ T 在 ε 抖动下的放行/丢弃分界。
 *
 * protocol-engineer 42 例套件对拍映射（原 temp/phys-plan-discuss/
 * t2-sortgate-testcases-protocol-engineer.md，2026-09 清理；ref 42/42 独立参考实现交叉验证）：
 * - SG-C1→§1（T 常量；μs 整数域在 ref 验证，本件以 15.625ms 等价承载）
 *   SG-C2/C3→§1/§3  SG-C4/C5/C6→§2  SG-C7→§7（判定面拒+运行时钳制两层）
 *   SG-C8/C10/C11→§1/§2/§3  SG-C12→§2  SG-C9→§1（ε≥T→cap 0 防御形态）
 * - SG-P1→§4②  SG-P2→§4①  SG-P3→§4②  SG-P4→§4③  SG-P5/P6→§4⑤（同因互斥）
 *   SG-P9→§4④  SG-P10→§4⑥
 *   SG-P7【分档裁定】断窗检出=worker 编排（t4 合同），检出后不发乐观帧不经门
 *   ——gate 保持纯排序面（§7 注记）；SG-P8【裁定修正】now==due→publish：
 *   lead-miss ≡ P(停顿>δ) 严格大于——停顿==δ 非 miss；且 δ+ε_max≤T 充分性
 *   要求 ε==ε_max（now==due）必过，取等丢弃将使定理降级为严格不等（§7 注记）
 * - SG-E1..E4【分档】内容封帽=eval 期编排（t4 合同），被帽 tick 不触门不进
 *   leadMiss——门级等价断言=§6 仿真闭账（attempts ≡ published+leadMiss+
 *   blockedOrder = 门被咨询数；被帽 tick 不入尝试流，计数天然隔离）
 * - SG-M1/M2/M3/M4→shared-state.protocol.test.ts §2/§3（OPT 单向性/配对键
 *   载体/seg 沿用/传输透明）  SG-M5→门纯函数零传输依赖 + protocol §3/§5 双路径同值
 * - SG-S1→§6（10k 双链仿真 5 不变量+非平凡探针）  SG-S2→§6（故障形态由
 *   仿真剖面真实触发+§5 显式 ε 尾 demo）  SG-S2b→§5  SG-S3a/b→§4⑦  SG-S4→§2
 *
 * 运行（node，禁浏览器）：
 *   cd game && npx esbuild ../src/ts-shared/tick/ordering-gate.test.ts \
 *     --bundle --format=esm --platform=node --outfile=node_modules/.cache/t2-tests/ordering-gate.test.mjs \
 *     && node node_modules/.cache/t2-tests/ordering-gate.test.mjs
 */

import {
  TICK_PERIOD_MS,
  EPSILON_MAX_SETTIMEOUT_MS,
  EPSILON_MAX_ATOMICS_MS,
  deriveLeadCapMs,
  isLeadWithinCap,
  createOrderingGate,
} from './ordering-gate.js';

let passed = 0;
let failed = 0;
function expect(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

const T = TICK_PERIOD_MS;

// ── 1. 静态 cap 推导 ─────────────────────────────────────────
console.log('[1] deriveLeadCapMs (δ ≤ T − ε_max)');
expect(T === 15.625, 'SG-C1 TICK_PERIOD_MS = 15.625 (raw 64Hz; 1e6/64===15625μs 无浮点漂移)');
expect(EPSILON_MAX_SETTIMEOUT_MS === 8, '常量表 ε_max setTimeout 档 = 8ms（SG-C2 输入，§8.4 严格界 7625μs 来源）');
expect(EPSILON_MAX_ATOMICS_MS === 1, '常量表 ε_max Atomics 档 = 1ms (strict bound，SG-C3 输入)');
expect(deriveLeadCapMs(T, EPSILON_MAX_SETTIMEOUT_MS) === 7.625, 'SG-C2/C4 setTimeout cap = 7.625ms（§8.4 记 7.6；SG-S2b 余量 15600≤15625 的界）');
expect(deriveLeadCapMs(T, EPSILON_MAX_ATOMICS_MS) === 14.625, 'SG-C3/C6 Atomics cap = 14.625ms (§8.4 记 14.6)');
expect(deriveLeadCapMs(T, 16) === 0, 'SG-C9 ε_max ≥ T → cap 0 (eps-profile REJECT 的实现退化)');
expect(deriveLeadCapMs(T, -3) === 0, 'SG-C11 负 ε_max → cap 0 (eps-profile REJECT 防御)');

// ── 2. δ 合法性（边界含等号）─────────────────────────────────
console.log('[2] isLeadWithinCap (≤ boundary)');
expect(isLeadWithinCap(7.625, T, 8) === true, 'SG-C4 δ = cap 恰好满足（7625μs = 界，边界含等号）');
expect(isLeadWithinCap(7.626, T, 8) === false, 'SG-C5 δ 超界 1μs 即拒（7626 > 7625）');
expect(isLeadWithinCap(14.625, T, 1) === true, 'SG-C6 Atomics 档 δ = 14625μs = cap 满足');
expect(isLeadWithinCap(14.626, T, 1) === false, 'SG-C6 Atomics 档 14626 > cap 拒');
expect(isLeadWithinCap(0, T, 8) === true, 'SG-C10 δ = 0 合法（退化但合法：无领先无增益）');
expect(isLeadWithinCap(-0.1, T, 8) === false, 'SG-C10 δ < 0 非法（delta-range）');
// SG-C12 声明常量表自洽（防实现常量与文档漂移）：δ* 7.6 ≤ 7625 ∧ 14.6 ≤ 14625
expect(
  isLeadWithinCap(7.6, T, 8) && isLeadWithinCap(14.6, T, 1),
  'SG-C12 声明值自洽：7600≤7625 ∧ 14600≤14625',
);
// SG-C8 ε=0（理想发布器）：δ ≤ T 全合法，整 tick 领先（cap=T）合法
expect(deriveLeadCapMs(T, 0) === 15.625 && isLeadWithinCap(15.625, T, 0) === true, 'SG-C8 ε=0 → cap=T=15.625（整 tick 领先合法，δ=T PASS）');
// SG-S4 配置面单调性：ε_max 增大 → cap 单调不增（通过集只收缩不翻回）
expect(
  deriveLeadCapMs(T, 0) >= deriveLeadCapMs(T, 2) &&
    deriveLeadCapMs(T, 2) >= deriveLeadCapMs(T, 8) &&
    deriveLeadCapMs(T, 8) >= deriveLeadCapMs(T, 12) &&
    deriveLeadCapMs(T, 12) >= deriveLeadCapMs(T, 15.625),
  'SG-S4 ε_max 单调增 → cap 单调不增（合法域只收缩）',
);

// ── 3. 构造期钳制（排序门吸收越界 δ）────────────────────────
console.log('[3] createOrderingGate clamping');
const g1 = createOrderingGate(); // 缺省 setTimeout 档
expect(g1.capMs === 7.625, 'SG-C2 default profile cap = 7.625');
expect(g1.leadDeltaMs === 7.625, 'SG-C2/S2b default δ = cap（早窗最大化，余量语义）');
const g2 = createOrderingGate({ epsilonMaxMs: EPSILON_MAX_ATOMICS_MS });
expect(g2.capMs === 14.625 && g2.leadDeltaMs === 14.625, 'SG-C3 Atomics profile cap/δ = 14.625');
const g3 = createOrderingGate({ leadDeltaMs: 8 }); // §8.4 双量子 8（超 0.4ms）
expect(g3.leadDeltaMs === 7.625, 'SG-C7 δ=8 双量子由排序门钳到 cap 7.625（§8.4 勘误：配置校验拒+运行时吸收两层）');
const g4 = createOrderingGate({ leadDeltaMs: 5 });
expect(g4.leadDeltaMs === 5, 'SG-C2 显式界内 δ 原样保留（7600μs 声明值形态）');
const g5 = createOrderingGate({ leadDeltaMs: -2 });
expect(g5.leadDeltaMs === 0, 'SG-C10 负 δ 钳到 0');

// ── 4. 运行时发布门 ─────────────────────────────────────────
// 分账（§8.5 对齐 + 裁定文档修订）：leadMiss = unordered + late 合账
//（无锚引导期/停顿/自身 ε 尾）；blockedOrder = superseded 专账（真值抢先/
// 锚回跳，稳态 0）。动作面恒三值：block-order/drop-late/publish。
console.log('[4] authorizeOptimistic / noteAuthoritative (SG-P1..P6, P8..P10)');
const dueOf = (k: number, t0Ms: number): number => t0Ms + k * T;
const t0 = 1000;
const g = createOrderingGate();
// ① 首 tick 前乐观发布必拒（无 authoritative(-1) 锚 → 引导期 unordered）
expect(g.authorizeOptimistic(0, dueOf(0, t0) - 7, dueOf(0, t0)) === 'block-order', 'SG-P2 optimistic(0) before any authoritative → block-order（无确认基线；首个合法乐观 label=1）');
expect(g.stats.leadMiss === 1 && g.stats.blockedOrder === 0 && g.stats.optimisticPublished === 0, 'SG-P2 分账：引导期无锚 → leadMiss=1（unordered 主机制；blockedOrder 不动）');
// ② authoritative(0) 后 optimistic(1) 放行（now < due）——首个合法乐观帧
g.noteAuthoritative(0);
expect(g.authorizeOptimistic(1, dueOf(1, t0) - 5, dueOf(1, t0)) === 'publish', 'SG-P3 optimistic(1) after authoritative(0) → publish（首个合法）');
expect(g.stats.optimisticPublished === 1, 'SG-P3 optimisticPublished=1');
// ③ 排序不变量：authoritative(1) 未发布即试 optimistic(2) → 拒（停顿越 δ 主机制）
expect(g.authorizeOptimistic(2, dueOf(2, t0) - 7, dueOf(2, t0)) === 'block-order', 'SG-P4 optimistic(2) without authoritative(1) → block-order（ε 尾主机制：停顿杀死领先）');
expect(g.stats.leadMiss === 2 && g.stats.blockedOrder === 0, 'SG-P4 分账：unordered → leadMiss=2（§8.5 P(停顿>δ)）；blockedOrder 仍 0');
// ④ authoritative(1) 发布后 → 放行；ε 尾边界：now == due → publish；now > due → drop-late
g.noteAuthoritative(1);
expect(g.authorizeOptimistic(2, dueOf(2, t0), dueOf(2, t0)) === 'publish', 'SG-P8（修正后）now == due → publish（边界含等号；收回原「保守取等」——与 lead-miss=P(停顿>δ) 严格大于自洽）');
g.noteAuthoritative(2);
expect(g.authorizeOptimistic(3, dueOf(3, t0) + 0.01, dueOf(3, t0)) === 'drop-late', 'SG-P9 now > due → drop-late (ε 尾严格迟到，乐观径次要机制)');
expect(g.stats.leadMiss === 3, 'SG-E1/分账 leadMiss=3 累计（unordered×2 + late×1 合账）');
expect(g.stats.blockedOrder === 0, 'SG-P5/P6 分账 blockedOrder=0（至此无 superseded）');
// ⑤ superseded 专账：auth(3) 已发还试 optimistic(3) → block-order + blockedOrder
g.noteAuthoritative(3);
expect(g.authorizeOptimistic(3, dueOf(3, t0) - 5, dueOf(3, t0)) === 'block-order', 'SG-P5 真值抢先：auth(n) 已发 → block-order（superseded 专账；迟到乐观帧=纯浪费 §8.5）');
expect(g.stats.blockedOrder === 1, 'SG-P5/P6 分账 blockedOrder=1（superseded 与 unordered 不可同时真——同因互斥）');
// ⑥ 幂等：同候选重放同裁决（每候选恰一终态，drop 即弃无重试路径）
const gIdem = createOrderingGate();
gIdem.noteAuthoritative(5);
const r1 = gIdem.authorizeOptimistic(6, dueOf(6, t0) + 1, dueOf(6, t0));
const r2 = gIdem.authorizeOptimistic(6, dueOf(6, t0) + 1, dueOf(6, t0));
expect(r1 === 'drop-late' && r2 === 'drop-late' && gIdem.stats.leadMiss === 2, 'SG-P10 幂等：同候选重放同裁决、每调用恰一终态计数（drop 即弃）');
// ⑦ i32 wrap（SG-S3a/b）：标签算术 wrap-safe——prev(i32min)=i32max
const gWrap = createOrderingGate();
gWrap.noteAuthoritative(2147483647); // seen = i32max
const wrapLabel = -2147483648; // tag = i32min（回绕）
expect(gWrap.authorizeOptimistic(wrapLabel, dueOf(wrapLabel, t0) - 5, dueOf(wrapLabel, t0)) === 'publish', 'SG-S3a i32 wrap：tag=i32min、seen={i32max} → emit（prev(i32min)=i32max，wrap-safe）');
const gWrap2 = createOrderingGate();
gWrap2.noteAuthoritative(-2147483648); // 锚 = i32min
expect(gWrap2.authorizeOptimistic(-2147483648, 0, 0) === 'block-order' && gWrap2.stats.blockedOrder === 1, 'SG-S3b i32 wrap：seen 含 tag=i32min → superseded 专账（回绕下真值抢先语义不变）');

// ── 5. 实时语义演示（δ* + ε_max ≤ T 的放行/丢弃分界）────────
console.log('[5] realtime boundary demo (δ + ε vs T)');
// 场景：authoritative(k−1) 于 due_{k−1}+2ms 发布；乐观评估于 t_{k−1}+δ*；
// 发布延迟 ε 抖动。label 6：δ*=7.625、ε=8 → 发布时刻 = t_5+15.625 = due_6
// 恰好放行；label 7：ε=8.5 → t_6+16.125 = due_7+0.5 → drop-late
// （该 tick 回落 pure-history 一拍）。
const gr = createOrderingGate();
gr.noteAuthoritative(5);
const evalK6 = dueOf(5, t0) + 7.625; // t_5 + δ*
expect(gr.authorizeOptimistic(6, evalK6 + 8, dueOf(6, t0)) === 'publish', 'SG-S2b δ*+ε_max=15600≤15625 → 恰在界内必 emit（25μs 余量 = δ≤T−ε_max 可执行含义）');
gr.noteAuthoritative(6);
const evalK7 = dueOf(6, t0) + 7.625; // t_6 + δ*
expect(gr.authorizeOptimistic(7, evalK7 + 8.5, dueOf(7, t0)) === 'drop-late', 'SG-P9 δ*+ε=8.5 → 越 due 0.5ms（丢弃，lead-miss）');
expect(gr.stats.leadMiss === 1, 'SG-P9 分账 lead-miss 计数=1（与 starvation 分列，§8.5）');

// ── 6. 双链仿真不变量（t2 用例集 SG-S1 收编；Gate 2 对拍基线）──
console.log('[6] two-chain simulation invariants');
/**
 * 10k tick 仿真：auth 链/opt 链各自单调（顺序发射），跨链按墙钟时间归并——
 * 排序违例/ε 尾在仿真中必须全部被门拦截。late 剖面（示意，非标定——标定
 * 剖面由 bench D-scan 出具）：两段量化 + 1% GC 尾。消费者日志不变量
 * （SG-S1 五条：①opt(k) 后于 auth(k−1) ②opt(k) 先于 auth(k) ③auth 标签单调
 * ∧ drop 原因互斥（superseded/unordered 不可同真——auth 单调发布）④闭账
 * published+leadMiss+blockedOrder ≡ 尝试数（分账完备，无帧悬空））+
 * 非平凡探针（drop 机制全部真实触发，防恒 publish 假绿）。
 */
function simulateGate(ticks: number, seed: number): {
  ok: boolean;
  stats: { optimisticPublished: number; leadMiss: number; blockedOrder: number };
} {
  let s = seed | 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gate = createOrderingGate();
  const authEmit: { t: number; k: number }[] = [];
  const optTry: { t: number; k: number }[] = [];
  let aPrev = 0;
  let oPrev = 0;
  for (let k = 0; k < ticks; k++) {
    const tK = k * T;
    const gcTail = rand() < 0.01 ? rand() * 20 : 0;
    aPrev = Math.max(tK, aPrev) + rand() * 4 + rand() * 4 + gcTail; // 链内单调
    authEmit.push({ t: aPrev, k });
    const gcOpt = rand() < 0.01 ? rand() * 20 : 0;
    oPrev = Math.max(tK + gate.leadDeltaMs, oPrev) + 0.1 + rand() * 0.2 + gcOpt;
    optTry.push({ t: oPrev, k: k + 1 });
  }
  // 时间归并（两序列各自有序；tie 时 auth 先——稳定裁决）
  const ev = [
    ...authEmit.map((e) => ({ ...e, kind: 0 as const })),
    ...optTry.map((e) => ({ ...e, kind: 1 as const })),
  ].sort((x, y) => x.t - y.t || x.kind - y.kind);
  const log: { kind: 'auth' | 'opt'; k: number }[] = [];
  for (const e of ev) {
    if (e.kind === 0) {
      gate.noteAuthoritative(e.k);
      log.push({ kind: 'auth', k: e.k });
    } else if (gate.authorizeOptimistic(e.k, e.t, e.k * T) === 'publish') {
      log.push({ kind: 'opt', k: e.k });
    }
  }
  // ①②：opt(k) 必在 auth(k−1) 之后、auth(k) 之前（auth 标签唯一）
  let inv12 = true;
  const posOf = (kind: 'auth' | 'opt', k: number): number => {
    for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === kind && log[i].k === k) return i;
    return -1;
  };
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.kind !== 'opt') continue;
    const prev = posOf('auth', e.k - 1);
    if (prev === -1 || prev >= i) { inv12 = false; break; }
    const pa = posOf('auth', e.k);
    if (pa !== -1 && pa < i) { inv12 = false; break; }
  }
  // ③：auth 标签严格递增（跨链归并不破坏链内单调）
  let last = -Infinity;
  let inv3 = true;
  for (const e of log) if (e.kind === 'auth') { if (e.k <= last) { inv3 = false; break; } last = e.k; }
  // ④：计数闭账（published + leadMiss + blockedOrder === 总尝试数）
  const attempts = gate.stats.optimisticPublished + gate.stats.leadMiss + gate.stats.blockedOrder;
  const inv4 = attempts === ticks;
  // 非平凡探针：三类判定全部真实触发（GC 尾驱动 leadMiss；锚缺口驱动 blockOrder）
  const nontrivial =
    gate.stats.leadMiss > 0 && gate.stats.blockedOrder > 0 && gate.stats.optimisticPublished > 0;
  return { ok: inv12 && inv3 && inv4 && nontrivial, stats: { ...gate.stats } };
}
{
  const r = simulateGate(10000, 20260910);
  expect(r.ok, '仿真五不变量全过 + 非平凡探针（GC 尾真实触发 lead-miss/block-order）');
  expect(
    r.stats.optimisticPublished > 0 && r.stats.leadMiss > 0 && r.stats.blockedOrder > 0,
    `counts: pub=${r.stats.optimisticPublished} leadMiss=${r.stats.leadMiss} block=${r.stats.blockedOrder}`,
  );
}

// ── 7. 语义收敛注记（t2 用例集 → 实现资产的对齐记录）──────────
console.log('[7] semantics convergence notes (case-set → implementation)');
// SG-C7（δ=8 配置必须拒）：isLeadWithinCap(8,T,8)=false（判定面）+ 构造期钳制
//（运行时防御）——两者互补，钳制不掩盖非法性报告。
expect(isLeadWithinCap(8, T, 8) === false, 'SG-C7 判定面：δ=8 越界（isLeadWithinCap=false）');
expect(createOrderingGate({ leadDeltaMs: 8 }).leadDeltaMs === 7.625, 'SG-C7 运行时面：钳制吸收');
// SG-P8 收回修正：now == due → publish（边界含等号）。理由：lead-miss 指标定义
// = P(停顿 > δ) 严格大于——停顿 == δ 不算 miss；now==due 的 OPT 帧仍是真实
// tick 输出、修订即撤收敛、显示价值≈0 但不为负 → 放行更忠实于「迟到」语义
//（ε 尾丢弃 = 严格越 due）。原用例集「保守取等」与 lead-miss 定义自相矛盾。
expect(
  (() => {
    const g = createOrderingGate();
    g.noteAuthoritative(5);
    return g.authorizeOptimistic(6, dueOf(6, t0), dueOf(6, t0));
  })() === 'publish',
  'SG-P8（修正后）：now == due → publish（与 lead-miss=P(停顿>δ) 自洽）',
);
// superseded 并入 block-order：auth(k) 已发还试乐观(k)（lastAuthoritative ≥ k >
// k−1）→ block-order（编排缺陷报警面）。行为面一致（拒发）；分账合并，稳态 0。
expect(
  (() => {
    const g = createOrderingGate();
    g.noteAuthoritative(5);
    g.noteAuthoritative(6);
    return g.authorizeOptimistic(6, dueOf(6, t0) - 5, dueOf(6, t0));
  })() === 'block-order',
  'superseded 情形 → block-order（lastAuthoritative=6 ≠ 5；编排缺陷面）',
);
// SG-P7 orphan 分层：断窗检出（I_A_SEG 突变）在 worker 编排（t4 合同）——
// 检出后不发乐观帧，不经本门；ordering-gate 保持纯排序面（无 breakPending 判据）。
// SG-E/M 组分层：内容封帽 = t4 编排 eval 期；帧元数据 = writeAuthoritative meta
// 路径（shared-state.protocol.test.ts 覆盖）。

console.log(`ordering-gate.test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`ordering-gate.test FAILED (${failed})`);
}
