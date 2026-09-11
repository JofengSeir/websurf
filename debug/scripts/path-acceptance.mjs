#!/usr/bin/env node
/**
 * tick→渲染折线 **垂距** 验收门 / 基线度量。
 *
 * 度量定义（用户口径）：每个 tick 点到**渲染折线**的最短距离。
 *   d(p) = min over **合格线段** i of segDist(p, R[i], R[i+1])
 *   segDist = 把 p 投影到线段并**钳位** s∈[0,1] 后的三维距离
 *   合格线段 = 两端距离 ≤ JUMP_BREAK(100 HU)（渲染器不在跳变处连线）
 * 该度量对采样相位不敏感 —— 与面板"偏差梳"（按时间对齐、含切向滞后、会被传送
 * 放大成数千 HU）是**不同量**，不可混用。
 *
 * 关键实现要点（经实测确认）：
 *  1. **不能用时间窗筛候选线段**：渲染路径会绕回，实测最近线段的时间可差 5.5 秒。
 *     改用**对线段 AABB 的 BVH**（中位数切分 / 叶 8 / 按 AABB 距离剪枝），与暴力法逐位一致。
 *  2. **必须按时间剔除传送邻近点**：每个跳变（>D，D=max(100, 2×p99 间距)）前后
 *     ±EXCL_HALF_MS 内的 tick 点单独统计，否则一次传送会把总体 p95 抬到几十 HU。
 *  3. **垂距有固有地板**：渲染折线本身是弦近似，实测 sagitta 最大 ≈6 HU，
 *     因此**不对原始总体设硬 max**，只对剔除传送后的稳态总体设阈。
 *
 * 用法：
 *   node scripts/path-acceptance.mjs <phys-path.json> [更多...] [选项]
 * 选项：
 *   --assert              按阈值判定并以非 0 退出（CI 门）
 *   --p95 2.0             稳态 p95 上限（HU）
 *   --max 10.0            稳态 max 上限（HU）
 *   --glitch-hu 30        "毛刺"阈值（HU）
 *   --glitch-share 0.01   稳态中 >glitch-hu 的占比上限
 *   --max-excluded 0.10   传送邻近点占比上限（防止用剔除"刷分"）
 *   --excl-half-ms 500    跳变前后剔除半窗（ms）
 *   --jump-hu 100         折线断点阈值（HU）
 *   --json / --quiet / --write-baseline <out.md>
 *
 * 退出码：0 = 全部通过；1 = 有门未过；2 = 用法/数据非法。
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ── 参数 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--') && /\.json$/i.test(a));
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);
if (!files.length) {
  console.error('用法: node scripts/path-acceptance.mjs <phys-path.json> [更多...] [--assert]');
  process.exit(2);
}
const LIM_P95 = Number(opt('p95', 2.0));
const LIM_MAX = Number(opt('max', 10.0));
const GLITCH_HU = Number(opt('glitch-hu', 30));
const LIM_GLITCH_SHARE = Number(opt('glitch-share', 0.01));
const LIM_EXCLUDED_SHARE = Number(opt('max-excluded', 0.1));
const EXCL_HALF_MS = Number(opt('excl-half-ms', 500));
const JUMP_HU = Number(opt('jump-hu', 100));
/**
 * 期望判定（仅 --assert 时生效）：
 *   pass（默认）= 门禁应通过；fail = 门禁应**失败**。
 * 用途：夹具是"某个构建下的录制"，它固化了那个构建的行为。改动前的录制即使代码修好
 * 也永远失败——因此用 `--expect fail` 把它当**度量判别力的自检**（证明该门能识破缺陷）；
 * 真正验收要用修好之后录制的夹具 + `--expect pass`。
 */
const EXPECT = opt('expect', 'pass');
const QUIET = has('quiet');

// ── 小工具 ────────────────────────────────────────────────────
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
const stats = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  return {
    n: s.length, mean: mean(arr), p50: pct(s, 0.5), p90: pct(s, 0.9), p95: pct(s, 0.95),
    p99: pct(s, 0.99), max: s.length ? s[s.length - 1] : NaN,
  };
};

// ── 线段准备（跳变处断开 = 不合格线段不参与）────────────────────
function buildSegments(R) {
  const segs = [];
  const jumps = []; // 渲染侧跳变时刻（ms）
  for (let i = 0; i + 1 < R.length; i++) {
    const a = R[i], b = R[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (len > JUMP_HU) { jumps.push(b.t); continue; }
    if (len < 1e-9) continue; // 零长段无意义
    segs.push({
      a, b, len,
      minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y), minz: Math.min(a.z, b.z),
      maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y), maxz: Math.max(a.z, b.z),
    });
  }
  return { segs, jumps };
}

// ── BVH（线段 AABB，中位数切分）────────────────────────────────
function buildBVH(segs) {
  const idx = segs.map((_, i) => i);
  const nodes = [];
  const LEAF = 8;
  const bboxOf = (i0, i1) => {
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let k = i0; k < i1; k++) {
      const s = segs[idx[k]];
      if (s.minx < minx) minx = s.minx; if (s.maxy > maxy) maxy = s.maxy;
      if (s.miny < miny) miny = s.miny; if (s.maxz > maxz) maxz = s.maxz;
      if (s.minz < minz) minz = s.minz; if (s.maxx > maxx) maxx = s.maxx;
    }
    return { minx, miny, minz, maxx, maxy, maxz };
  };
  const build = (i0, i1) => {
    const bbox = bboxOf(i0, i1);
    const node = { bbox, i0, i1, left: -1, right: -1 };
    const id = nodes.push(node) - 1;
    if (i1 - i0 <= LEAF) return id;
    // 以线段中点为切分依据，取最宽轴
    const ex = bbox.maxx - bbox.minx, ey = bbox.maxy - bbox.miny, ez = bbox.maxz - bbox.minz;
    const axis = ex >= ey && ex >= ez ? 'x' : ey >= ez ? 'y' : 'z';
    const key = (i) => {
      const s = segs[i];
      return (s.a[axis] + s.b[axis]) * 0.5;
    };
    const slice = idx.slice(i0, i1).sort((p, q) => key(p) - key(q));
    for (let k = 0; k < slice.length; k++) idx[i0 + k] = slice[k];
    const mid = (i0 + i1) >> 1;
    if (mid === i0 || mid === i1) return id;
    node.left = build(i0, mid);
    node.right = build(mid, i1);
    return id;
  };
  if (segs.length) build(0, segs.length);
  return { nodes, idx, root: segs.length ? 0 : -1 };
}

const distToAABB = (p, b) => {
  const dx = p.x < b.minx ? b.minx - p.x : p.x > b.maxx ? p.x - b.maxx : 0;
  const dy = p.y < b.miny ? b.miny - p.y : p.y > b.maxy ? p.y - b.maxy : 0;
  const dz = p.z < b.minz ? b.minz - p.z : p.z > b.maxz ? p.z - b.maxz : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

function segDist(p, s) {
  const abx = s.b.x - s.a.x, aby = s.b.y - s.a.y, abz = s.b.z - s.a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((p.x - s.a.x) * abx + (p.y - s.a.y) * aby + (p.z - s.a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (s.a.x + abx * t), p.y - (s.a.y + aby * t), p.z - (s.a.z + abz * t));
}

/** 查询 p 到最近线段的距离，并回传最近线段的序号与其时间偏移。 */
function query(bvh, segs, p) {
  let best = Infinity, bestI = -1;
  const stack = [bvh.root];
  while (stack.length) {
    const ni = stack.pop();
    if (ni < 0) continue;
    const node = bvh.nodes[ni];
    if (distToAABB(p, node.bbox) >= best) continue;
    if (node.left < 0) {
      for (let k = node.i0; k < node.i1; k++) {
        const si = bvh.idx[k];
        const d = segDist(p, segs[si]);
        if (d < best) { best = d; bestI = si; }
      }
    } else {
      stack.push(node.left, node.right);
    }
  }
  const s = bestI >= 0 ? segs[bestI] : null;
  const dt = s ? (p.t - (s.a.t + s.b.t) * 0.5) : NaN;
  return { d: best, dt };
}

// ── 时间对齐偏差（面板"偏差梳"口径，仅作对照）───────────────────
function timeAligned(T, R) {
  if (R.length < 2) return [];
  const samp = (t) => {
    if (t <= R[0].t) return R[0];
    const L = R[R.length - 1];
    if (t >= L.t) return L;
    let lo = 0, hi = R.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m].t <= t) lo = m; else hi = m; }
    const a = R[lo], b = R[hi];
    const fr = (t - a.t) / Math.max(b.t - a.t, 1e-6);
    return { x: a.x + (b.x - a.x) * fr, y: a.y + (b.y - a.y) * fr, z: a.z + (b.z - a.z) * fr };
  };
  return T.map((p) => { const q = samp(p.t); return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); });
}

// ── 主分析 ────────────────────────────────────────────────────
function analyze(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const R = j.render ?? [];
  const T = j.tick ?? [];
  if (R.length < 2 || T.length < 50) return { path, error: `数据不足（render=${R.length} tick=${T.length}）` };
  for (let i = 1; i < R.length; i++) if (R[i].t < R[i - 1].t) return { path, error: 'render 时间戳非单调' };
  for (let i = 1; i < T.length; i++) if (T[i].t < T[i - 1].t) return { path, error: 'tick 时间戳非单调' };

  const { segs, jumps } = buildSegments(R);
  if (!segs.length) return { path, error: '无合格线段' };

  // D = max(JUMP_HU, 2×p99 渲染节点间距)（由数据推导，避免手调）
  const spac = [];
  for (let i = 1; i < R.length; i++) spac.push(Math.hypot(R[i].x - R[i - 1].x, R[i].y - R[i - 1].y, R[i].z - R[i - 1].z));
  spac.sort((a, b) => a - b);
  const p99spac = pct(spac, 0.99);
  const D = Math.max(JUMP_HU, 2 * p99spac);

  // 剔除窗：渲染侧 + tick 侧所有 >D 的跳变，前后 ±EXCL_HALF_MS，重叠合并
  const evt = [];
  for (let i = 1; i < R.length; i++) {
    const d = Math.hypot(R[i].x - R[i - 1].x, R[i].y - R[i - 1].y, R[i].z - R[i - 1].z);
    if (d > D) evt.push(R[i].t);
  }
  for (let i = 1; i < T.length; i++) {
    const d = Math.hypot(T[i].x - T[i - 1].x, T[i].y - T[i - 1].y, T[i].z - T[i - 1].z);
    if (d > D) evt.push(T[i].t);
  }
  evt.sort((a, b) => a - b);
  const wins = [];
  for (const t of evt) {
    const a = t - EXCL_HALF_MS, b = t + EXCL_HALF_MS;
    if (wins.length && a <= wins[wins.length - 1][1]) wins[wins.length - 1][1] = Math.max(wins[wins.length - 1][1], b);
    else wins.push([a, b]);
  }
  const excluded = (t) => wins.some(([a, b]) => t >= a && t <= b);

  const bvh = buildBVH(segs);
  const steady = [], excl = [];
  const dtAll = [];
  for (const p of T) {
    const { d, dt } = query(bvh, segs, p);
    if (!Number.isFinite(d)) continue;
    dtAll.push(Math.abs(dt));
    if (excluded(p.t)) excl.push(d);
    else steady.push(d);
  }
  const st = stats(steady);
  const glitch = steady.filter((d) => d > GLITCH_HU).length;
  const total = steady.length + excl.length;
  const ta = timeAligned(T, R);

  return {
    path, newBuild: !!j.sampling, renderPts: R.length, tickPts: T.length,
    spanS: (Math.max(R[R.length - 1].t, T[T.length - 1].t) - Math.min(R[0].t, T[0].t)) / 1000,
    segs: segs.length, jumpSegs: jumps.length, D, p99spac,
    windows: wins.length,
    steady: st,
    excluded: { n: excl.length, share: total ? excl.length / total : 0, mean: mean(excl), max: excl.length ? Math.max(...excl) : NaN },
    glitch: { hu: GLITCH_HU, n: glitch, share: steady.length ? glitch / steady.length : 0 },
    argminAbsDt: { p50: pct(dtAll.slice().sort((a, b) => a - b), 0.5), p90: pct(dtAll.slice().sort((a, b) => a - b), 0.9), max: dtAll.length ? Math.max(...dtAll) : NaN, over250: dtAll.filter((v) => v > 250).length },
    timeAligned: stats(ta),
    residual: (() => {
      const r = T.map((p) => p.residual).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return r.length ? stats(r) : null;
    })(),
  };
}

// ── 输出 ──────────────────────────────────────────────────────
const results = files.map(analyze);
/** 个别门未过数（仅用于展示）。 */
let gateFail = 0;
/** 与 --expect 不符数（**决定退出码**）。 */
let mismatch = 0;

for (const r of results) {
  if (QUIET) continue;
  console.log(`\n=== ${r.path.split(/[\\/]/).pop()} ===`);
  if (r.error) { console.log(`  错误: ${r.error}`); continue; }
  console.log(`  render ${r.renderPts} 点 / tick ${r.tickPts} 点 / 合格线段 ${r.segs} / 跳变 ${r.jumpSegs} / 时长 ${f(r.spanS, 1)}s${r.newBuild ? '' : '  (旧构建)'}`);
  console.log(`  D=${f(r.D, 1)} HU（p99 间距 ${f(r.p99spac)}）  剔除窗 ${r.windows} 个  剔除点 ${r.excluded.n} (${f(r.excluded.share * 100, 1)}%)`);
  console.log(`  **稳态垂距**: n=${r.steady.n} mean=${f(r.steady.mean)} p50=${f(r.steady.p50)} p90=${f(r.steady.p90)} p95=${f(r.steady.p95)} p99=${f(r.steady.p99)} max=${f(r.steady.max)}`);
  console.log(`    >${r.glitch.hu} HU 毛刺: ${r.glitch.n} (${f(r.glitch.share * 100, 2)}%)`);
  console.log(`  剔除点垂距: mean=${f(r.excluded.mean)} max=${f(r.excluded.max)}`);
  console.log(`  最近线段时间偏移: p50=${f(r.argminAbsDt.p50, 1)}ms p90=${f(r.argminAbsDt.p90, 1)}ms max=${f(r.argminAbsDt.max, 0)}ms  >250ms 的 ${r.argminAbsDt.over250} 点`);
  console.log(`  对照·时间对齐(偏差梳口径): mean=${f(r.timeAligned.mean)} p95=${f(r.timeAligned.p95)} max=${f(r.timeAligned.max)}`);
  console.log(`  残差: ${r.residual ? `n=${r.residual.n} mean=${f(r.residual.mean)} p95=${f(r.residual.p95)} max=${f(r.residual.max)}` : '（无 residual 字段）'}`);
}

if (has('assert')) {
  console.log('\n=== 判定 ===');
  for (const r of results) {
    if (r.error) { console.log(`  [FAIL] ${r.path.split(/[\\/]/).pop()}: ${r.error}`); gateFail++; continue; }
    const name = r.path.split(/[\\/]/).pop();
    const checks = [
      [`稳态垂距 p95 ≤ ${LIM_P95} HU`, r.steady.p95, LIM_P95],
      [`稳态垂距 max ≤ ${LIM_MAX} HU`, r.steady.max, LIM_MAX],
      [`毛刺占比 ≤ ${f(LIM_GLITCH_SHARE * 100, 1)}%`, r.glitch.share, LIM_GLITCH_SHARE],
      [`剔除点占比 ≤ ${f(LIM_EXCLUDED_SHARE * 100, 1)}%`, r.excluded.share, LIM_EXCLUDED_SHARE],
    ];
    for (const [label, val, lim] of checks) {
      const ok = val <= lim;
      if (!ok) gateFail++;
      const show = label.includes('%') ? `${f(val * 100, 2)}%` : f(val);
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${label} — 实测 ${show}`);
    }
  }
  const gateOk = gateFail === 0;
  const want = EXPECT === 'pass';
  const expectOk = gateOk === want;
  if (!expectOk) mismatch++;
  console.log(
    `\n门禁结果: ${gateOk ? 'PASS' : `FAIL（${gateFail} 项）`}　期望: ${EXPECT.toUpperCase()}　→ ${expectOk ? '与期望一致' : '**与期望不符**'}`,
  );
  if (!expectOk && gateOk) {
    console.log('  提示：门禁意外通过。若这是"改动前"夹具，说明该门失去了判别力（缺陷未被识破）。');
  } else if (!expectOk && !gateOk) {
    console.log('  提示：门禁意外失败。若这是"修好后"的夹具，说明投影/采样链路未生效。');
  }
}

if (has('write-baseline')) {
  const out = opt('write-baseline');
  const L = [
    '# tick→渲染折线 垂距基线（Step 0）', '',
    `生成时间: ${new Date().toISOString()}`, '',
    `阈值（稳态总体）: p95 ≤ ${LIM_P95} HU, max ≤ ${LIM_MAX} HU, 毛刺(>${GLITCH_HU} HU) ≤ ${f(LIM_GLITCH_SHARE * 100, 1)}%, 剔除点 ≤ ${f(LIM_EXCLUDED_SHARE * 100, 1)}%`, '',
    '度量 = 每个 tick 点到渲染折线（合格线段，跳变>100HU 断开）的最短距离；',
    '剔除 = 渲染侧与 tick 侧所有 >D 跳变前后 ±500ms（传送邻近，不计入）。', '',
    '| 文件 | 构建 | tick 点 | 稳态 p50 | **稳态 p95** | 稳态 max | 毛刺占比 | 剔除占比 | 时间对齐 mean | 残差 p95 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const n = r.path.split(/[\\/]/).pop();
    if (r.error) { L.push(`| ${n} | — | — | ${r.error} | | | | | | |`); continue; }
    L.push(`| ${n} | ${r.newBuild ? '新' : '旧'} | ${r.tickPts} | ${f(r.steady.p50)} | **${f(r.steady.p95)}** | ${f(r.steady.max)} | ${f(r.glitch.share * 100, 2)}% | ${f(r.excluded.share * 100, 1)}% | ${f(r.timeAligned.mean)} | ${r.residual ? f(r.residual.p95) : '—'} |`);
  }
  writeFileSync(out, L.join('\n') + '\n');
  console.log(`\n基线已写入 ${out}`);
}

if (has('json')) console.log('\n' + JSON.stringify(results, null, 2));
// 退出码只看"与 --expect 是否一致"：`--expect fail` 下门禁**按预期失败**应 exit 0
// （它是度量判别力的自检）；`--expect pass`（默认）下门禁必须通过才 exit 0。
process.exit(mismatch ? 1 : 0);
