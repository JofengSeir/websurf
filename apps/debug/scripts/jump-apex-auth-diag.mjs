#!/usr/bin/env node
/**
 * 权威侧 / 渲染侧「空中着地」诊断：读 `apps/debug/scripts/jump-apex-measure.mjs` 写出的原始采样做统计。
 *
 * 数据源：`apps/debug/scripts/jump-apex-measure.mjs` 落到 `apps/debug/.tmp/jump-apex/<label>.json`
 * 的逐帧样本数组（生产者每个 rAF 帧记一条）。样本字段（按生产者代码）：`t` 为页面
 * `performance.now()` 绝对毫秒；`y` / `vy` / `g` 为渲染物理线的位置、竖直速度、onGround(0|1)；
 * `ay` / `avy` / `avg` 为权威帧只读快照，权威读数取不到时为 `null`（`avg` 取值 0|1）。
 *
 * 量什么（每个 label 一段输出）：
 *   · 基线 = 渲染 y 的 2% 分位数；
 *   · 权威 onGround=true 的帧数与「权威 y − 基线」取整后的分桶直方图；
 *   · 该集合里权威 y 高出基线 {3, 6, 10, 20, 40} HU 的帧数 —— `src/phys/player.rs` 的
 *     `check_jump` 以 `if !p.on_ground { return; }` 开头，权威自报着地即这道前置门对权威不设防；
 *   · 权威 onGround=true 而权威 vy > +50 的帧（自报着地却仍在上升）及其头 8 帧明细；
 *   · 权威 vy 与渲染 vy 各自的 min / p50 / p99 / max；
 *   · 两条线的 vy 冲量（相邻帧 Δvy ≥ 150）计数，并各记「冲量发生时已离地 >2 HU」的计数
 *     （权威侧按权威 y、渲染侧按渲染 y 判离地，两者都以渲染基线为参照）；
 *   · 以渲染 vy 冲量为段首切出的「起跳段」数、段内出现过权威报着地的段数、段内权威着地帧合计。
 *
 * 入参：命令行给一个或多个 label；一个都不给则循环不执行（此时设了 `JUMP_DIAG_OUT` 也只会写出一个空行）。
 * 某个 label 的样本文件不存在时打印「缺文件 …」并跳到下一个，退出码仍为 0。
 * 环境变量 `JUMP_DIAG_OUT` 有值时，把原本只走 console.log 的文本另写一份 UTF-8 文件。
 *
 * 前置：先跑 `apps/debug/scripts/jump-apex-measure.mjs <label>` 产出样本 JSON。
 *
 * 用法：node scripts/jump-apex-auth-diag.mjs <label> [<label2> ...]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.tmp', 'jump-apex');

// 可选：`JUMP_DIAG_OUT` 有值时，把 console.log 的每行同时攒进内存，脚本末尾一次性写文件
const OUT = process.env.JUMP_DIAG_OUT;
const chunks = [];
if (OUT) {
  const orig = console.log;
  console.log = (...a) => { chunks.push(a.join(' ')); orig(...a); };
}

const q = (sorted, p) => {
  const a = sorted.filter(Number.isFinite);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : NaN;
};
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'NaN');

for (const label of process.argv.slice(2)) {
  const file = join(DIR, `${label}.json`);
  if (!existsSync(file)) {
    console.log(`缺文件 ${file}`);
    continue;
  }
  const S = JSON.parse(readFileSync(file, 'utf8'));
  const ys = S.map((s) => s.y).sort((a, b) => a - b);
  const baseline = q(ys, 0.02);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`── ${label} ──  基线 y=${f(baseline)}  帧数=${S.length}`);

  // 权威 onGround=true 的帧（要求权威 y 也已取到），按「权威 y − 基线」四舍五入到整数 HU 分桶
  const authG = S.filter((s) => s.avg === 1 && s.ay !== null);
  const buckets = {};
  for (const s of authG) {
    const h = Math.round(s.ay - baseline);
    buckets[h] = (buckets[h] ?? 0) + 1;
  }
  console.log(`权威 onGround=true 帧数 = ${authG.length}`);
  console.log(`  按「权威 y − 渲染基线」分桶(HU): ${JSON.stringify(Object.fromEntries(Object.entries(buckets).sort((a, b) => a[0] - b[0])))}`);

  // 权威 y 高出渲染基线各阈值以上的帧数：这些帧上 `check_jump` 的 on_ground 前置未被挡住
  for (const thr of [3, 6, 10, 20, 40]) {
    const n = authG.filter((s) => s.ay - baseline >= thr).length;
    console.log(`  权威 onGround=true 且 权威 y ≥ 基线+${thr}HU 的帧 = ${n}`);
  }
  // 权威 onGround=true 且权威 vy > +50：自报着地却仍在上升
  const risingGrounded = authG.filter((s) => s.avy !== null && s.avy > 50);
  console.log(`  权威 onGround=true 且 权威 vy > +50（着地却在上升）的帧 = ${risingGrounded.length}`);
  for (const s of risingGrounded.slice(0, 8)) {
    console.log(`    t=+${s.t.toFixed(1)}ms  authY=${f(s.ay)} (h=${f(s.ay - baseline)})  authVy=${f(s.avy)}  渲染 y=${f(s.y)} 渲染 vy=${f(s.vy)} 渲染 onG=${s.g}`);
  }

  // 权威 vy 分布（只取权威读数非 null 的帧）vs 渲染 vy 分布（全部帧）
  const avy = S.filter((s) => s.avy !== null).map((s) => s.avy);
  const rvy = S.map((s) => s.vy);
  const sAvy = [...avy].sort((a, b) => a - b);
  const sRvy = [...rvy].sort((a, b) => a - b);
  console.log(`权威 vy: min ${f(sAvy[0], 1)} p50 ${f(q(sAvy, 0.5), 1)} p99 ${f(q(sAvy, 0.99), 1)} max ${f(sAvy[sAvy.length - 1], 1)}`);
  console.log(`渲染 vy: min ${f(sRvy[0], 1)} p50 ${f(q(sRvy, 0.5), 1)} p99 ${f(q(sRvy, 0.99), 1)} max ${f(sRvy[sRvy.length - 1], 1)}`);

  // vy 冲量（相邻帧 Δ ≥ 150）：分别统计两条线，以及冲量当帧「已离地 >2 HU」的条数
  let authImpulses = 0, authImpulsesAirborne = 0, renderImpulses = 0, renderImpulsesAirborne = 0;
  for (let i = 1; i < S.length; i++) {
    const a0 = S[i - 1].avy, a1 = S[i].avy;
    if (a0 !== null && a1 !== null && a1 - a0 >= 150) {
      authImpulses++;
      const h = S[i].ay !== null ? S[i].ay - baseline : NaN;
      if (Number.isFinite(h) && h > 2) authImpulsesAirborne++;
    }
    const r1 = S[i].vy - S[i - 1].vy;
    if (r1 >= 150) {
      renderImpulses++;
      if (S[i].y - baseline > 2) renderImpulsesAirborne++;
    }
  }
  console.log(`权威 vy 冲量(Δ≥150) = ${authImpulses}（其中权威已离地>2HU: ${authImpulsesAirborne}）`);
  console.log(`渲染 vy 冲量(Δ≥150) = ${renderImpulses}（其中渲染已离地>2HU: ${renderImpulsesAirborne}）`);

  // 「起跳段」= 以一次渲染 vy 冲量开头、向后走到再次下落且 y 回落到段首附近的帧序列
  let flights = 0, flightsWithAuthGround = 0, totalAuthGroundInFlight = 0;
  for (let i = 1; i < S.length; i++) {
    if (S[i].vy - S[i - 1].vy < 150) continue;
    flights++;
    let cnt = 0;
    for (let j = i; j < S.length; j++) {
      if (S[j].avg === 1) cnt++;
      if (j > i + 4 && S[j].vy < 0 && S[j - 1].vy < 0 && S[j].y <= S[i].y + 1) break;
    }
    if (cnt > 0) flightsWithAuthGround++;
    totalAuthGroundInFlight += cnt;
  }
  console.log(`渲染起跳段 = ${flights}；其中「段内权威报着地」的段 = ${flightsWithAuthGround}；段内权威着地帧合计 = ${totalAuthGroundInFlight}`);
}

if (OUT) writeFileSync(OUT, chunks.join('\n') + '\n', 'utf8');
