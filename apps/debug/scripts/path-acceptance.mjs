#!/usr/bin/env node
/**
 * tick 点到渲染折线的垂距验收门与基线度量。
 *
 * 度量定义：每个 tick 点到**渲染折线**的最短距离。
 *   d(p) = 所有合格线段 i 上 segDist(p, R[i], R[i+1]) 的最小值；
 *   segDist = 把 p 投影到线段、把投影参数钳位到 [0, 1] 之后的三维距离；
 *   合格线段 = 两端距离不超过 `--jump-hu`（缺省 100 HU）的渲染相邻点对——渲染器在跳变处
 *   不连线，故这里也不让跳变段参与候选（零长段同样跳过）。
 * 该度量与「按同一时刻在渲染线上插值再比」的偏差梳是两件不同的事：垂距不含时间对齐误差，
 * 也不含切向滞后，因此不会被一次传送放大成数千 HU。面板上的 `perpStats` 虽然也叫垂距，
 * 但只扫 ±250ms 时间窗内的线段；本脚本扫全部合格线段。两者口径不同，不可互相引用数值。
 *
 * 关键实现要点：
 *  1. **不用时间窗筛候选线段**：渲染路径会绕回来，时间上相邻不等于空间上最近。
 *     这里给全部合格线段的 AABB 建 BVH（按最宽轴中位数切分、叶容量 8、按 AABB 距离剪枝），
 *     查询时取严格更小的距离。查询同时回传最近线段中点与本点的时间偏移 `dt`。
 *  2. **按时间剔除传送邻近点**：跳变阈值 D = max(`--jump-hu`, 2 × 渲染相邻间距的 p99)
 *     （由数据推出，避免手调）。渲染侧与 tick 侧所有超过 D 的跳变都取时间戳，各自开一个
 *     ±`--excl-half-ms` 的窗，重叠的窗合并成若干个区间；落在任一区间内的 tick 点进
 *     `excluded` 组，其余进 `steady` 组。门只看稳态组，但剔除占比本身也是一道门
 *     （防止用剔除"刷分"）。
 *  3. **只对稳态组设 max 门**：因为渲染折线本身是折线近似，垂距有固有地板。
 *
 * 判定（仅 `--assert` 时生效）：
 *   · 每个输入文件依次比对四项门：稳态 p95 ≤ `--p95`（缺省 2.0）、稳态 max ≤ `--max`
 *     （缺省 10.0）、稳态中垂距 > `--glitch-hu`（缺省 30）的占比 ≤ `--glitch-share`
 *     （缺省 0.01）、剔除点占比 ≤ `--max-excluded`（缺省 0.10）；解析失败也算一项未过。
 *   · 退出码由「门结果是否等于期望」决定，而不是由门本身是否通过决定：`--expect pass`
 *     （缺省）要求四项门全过，`--expect fail` 要求四项门**至少有一项不过**——后者用于
 *     验证这道门确实有判别力（拿一份已知有缺陷的录制喂进去，它必须报 FAIL）。
 *
 * CLI：位置参数里**凡以 `.json` 结尾**的都是输入文件（可给多个，至少一个）；
 *   `--assert` 开启判定；`--expect pass|fail` 设期望；`--quiet` 只打印判定段；
 *   `--json` 把逐文件的完整结果以 JSON 打印；`--write-baseline <路径>` 把汇总写成 Markdown
 *   基线表（本脚本不会自动写 `apps/debug/scripts/path-baseline.md`，该文件是手工维护的资产）。
 *
 * 输入格式：`apps/debug/src/renderer/renderer-main.ts` 的 `exportPathJson` 写出的 JSON；
 *   本脚本只读 `render` 与 `tick` 两个数组，且要求 render 至少 2 点、tick 至少 50 点、
 *   两者时间戳都非递减，否则该文件记为数据不足/非法。`sampling` 键只用来打「新构建」标记
 *   （见文件末尾附近的输出行）——该键在当前导出里是写死的说明性字符串，故标记恒为真。
 *
 * 用法：
 *   node scripts/path-acceptance.mjs <phys-path.json> [更多...] [选项]
 *
 * 退出码：0 = 与 `--expect` 一致；1 = 与 `--expect` 不符，或（无 `--assert` 时）
 *   数据不足/JSON 解析失败；2 = 用法非法（没给任何 .json 输入）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ── 参数：位置参数只认 .json 结尾者；选项取值不得以 `--` 开头（否则回落默认值）──
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
// 四道阈值 + 两个几何量，全部可由 CLI 覆盖；括号内为缺省值
const LIM_P95 = Number(opt('p95', 2.0));
const LIM_MAX = Number(opt('max', 10.0));
const GLITCH_HU = Number(opt('glitch-hu', 30));
const LIM_GLITCH_SHARE = Number(opt('glitch-share', 0.01));
const LIM_EXCLUDED_SHARE = Number(opt('max-excluded', 0.1));
const EXCL_HALF_MS = Number(opt('excl-half-ms', 500));
const JUMP_HU = Number(opt('jump-hu', 100));
/**
 * 期望判定（仅 `--assert` 时生效）：`pass` = 要求四项门全过，`fail` = 要求至少一项不过。
 * 用途：夹具是「某次运行录下来的数据」，它固化的是录制当时那条链路的行为；同一份夹具喂给
 * 改好之后的代码仍然会失败。因此可以用一份已知有缺陷的录制配 `--expect fail` 做**判别力
 * 自检**（该门必须报 FAIL 才算有意义），另用一份录制正常的夹具配 `--expect pass` 做验收。
 * `apps/debug` 的 `test:path-acceptance` 脚本用的是前者，只吃
 * `apps/debug/fixtures/path/tick-on-render-prefix.json` 这**一个**文件。
 */
const EXPECT = opt('expect', 'pass');
const QUIET = has('quiet');

// ── 小工具：定宽数字格式、均值、分位、分布统计 ──────────────────
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

// ── 线段准备：超过 JUMP_HU 的相邻点对只记跳变时刻、不进候选；零长段也跳过 ──
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

// ── BVH：对线段 AABB 建树。叶容量 8；内部节点按包围盒最宽轴、
//    以线段中点为键做中位数切分（切分只重排 idx 数组，segs 本身不动）──
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
    // 切分轴 = 包围盒跨度最大的那一轴；键 = 线段两端在该轴上的中点
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

/** 点到线段的三维距离：投影参数钳位到 [0, 1]；退化线段（长度平方 ≤ 1e-12）按端点算。 */
function segDist(p, s) {
  const abx = s.b.x - s.a.x, aby = s.b.y - s.a.y, abz = s.b.z - s.a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((p.x - s.a.x) * abx + (p.y - s.a.y) * aby + (p.z - s.a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (s.a.x + abx * t), p.y - (s.a.y + aby * t), p.z - (s.a.z + abz * t));
}

/** 查询 p 到最近线段的距离，并回传该线段中点与 p 的时间偏移 `dt`（ms，带符号）。 */

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

// ── 时间对齐偏差：对每个 tick 点，在渲染线上按时间二分定位并线性插值后求三维距离。
//    这是面板偏差梳的口径，本脚本只用它做对照，不参与任何门。render 少于 2 点时返回空数组。──
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

// ── 主分析：读文件 → 校验 → 建段与 BVH → 分组 → 出统计。返回对象里 error 非空即该文件不可用 ──
function analyze(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const R = j.render ?? [];
  const T = j.tick ?? [];
  if (R.length < 2 || T.length < 50) return { path, error: `数据不足（render=${R.length} tick=${T.length}）` };
  for (let i = 1; i < R.length; i++) if (R[i].t < R[i - 1].t) return { path, error: 'render 时间戳非单调' };
  for (let i = 1; i < T.length; i++) if (T[i].t < T[i - 1].t) return { path, error: 'tick 时间戳非单调' };

  const { segs, jumps } = buildSegments(R);
  if (!segs.length) return { path, error: '无合格线段' };

  // D 由数据推出：不小于 --jump-hu，且不小于渲染相邻间距 p99 的两倍
  const spac = [];
  for (let i = 1; i < R.length; i++) spac.push(Math.hypot(R[i].x - R[i - 1].x, R[i].y - R[i - 1].y, R[i].z - R[i - 1].z));
  spac.sort((a, b) => a - b);
  const p99spac = pct(spac, 0.99);
  const D = Math.max(JUMP_HU, 2 * p99spac);

  // 剔除窗：渲染侧与 tick 侧所有超过 D 的跳变各开 ±EXCL_HALF_MS 的窗，首尾相接或相交的合并
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
const results = files.map(analyze); // JSON 解析失败会在此抛出（进程以非 0 结束，无逐文件兜底）
/** 累计未过的门数（含解析失败文件的 1 项）；只用于展示。 */
let gateFail = 0;
/** 与 --expect 不符数（**决定退出码**）。 */
let mismatch = 0;

for (const r of results) {
  if (QUIET) continue;
  console.log(`\n=== ${r.path.split(/[\\/]/).pop()} ===`);
  if (r.error) { console.log(`  错误: ${r.error}`); continue; }
  // 「(旧构建)」标记的判据是导出 JSON 里有没有 sampling 键；该键在当前导出里恒存在（写死的说明字符串）
  console.log(`  render ${r.renderPts} 点 / tick ${r.tickPts} 点 / 合格线段 ${r.segs} / 跳变 ${r.jumpSegs} / 时长 ${f(r.spanS, 1)}s${r.newBuild ? '' : '  (旧构建)'}`);
  console.log(`  D=${f(r.D, 1)} HU（p99 间距 ${f(r.p99spac)}）  剔除窗 ${r.windows} 个  剔除点 ${r.excluded.n} (${f(r.excluded.share * 100, 1)}%)`);
  console.log(`  **稳态垂距**: n=${r.steady.n} mean=${f(r.steady.mean)} p50=${f(r.steady.p50)} p90=${f(r.steady.p90)} p95=${f(r.steady.p95)} p99=${f(r.steady.p99)} max=${f(r.steady.max)}`);
  console.log(`    >${r.glitch.hu} HU 毛刺: ${r.glitch.n} (${f(r.glitch.share * 100, 2)}%)`);
  console.log(`  剔除点垂距: mean=${f(r.excluded.mean)} max=${f(r.excluded.max)}`);
  console.log(`  最近线段时间偏移: p50=${f(r.argminAbsDt.p50, 1)}ms p90=${f(r.argminAbsDt.p90, 1)}ms max=${f(r.argminAbsDt.max, 0)}ms  >250ms 的 ${r.argminAbsDt.over250} 点`);
  console.log(`  对照·时间对齐(偏差梳口径): mean=${f(r.timeAligned.mean)} p95=${f(r.timeAligned.p95)} max=${f(r.timeAligned.max)}`);
  console.log(`  残差: ${r.residual ? `n=${r.residual.n} mean=${f(r.residual.mean)} p95=${f(r.residual.p95)} max=${f(r.residual.max)}` : '（无 residual 字段）'}`);
}

// ── 判定段：仅 --assert 时打印；退出码只看「门结果是否等于 --expect」，不看门本身通过与否 ──
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

// ── 基线表：仅显式给 --write-baseline <路径> 时才写；本脚本不会自动更新仓库里的基线文件 ──
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
