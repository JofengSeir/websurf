#!/usr/bin/env node
/**
 * 跳跃顶高分布分析（读 `jump-apex-measure.mjs` 的原始采样 JSON）。
 *
 * 输入：debug/.tmp/jump-apex/<label>.json —— 每帧
 *   { t, dt, x,y,z, vy, g(渲染物理线 onGround), ay/avg/avy/ava(权威帧只读快照) }
 *
 * ⚠️ 为什么**不用 onGround 沿**切段：自动连跳（autobhop）下渲染线的着地窗口只有
 * 1–3 帧（318Hz 采样、0.75s 滞空），onGround 沿会把一次跳跃切成「0 高 + 真跳」两段。
 * 故改用**发射冲量**定锚：
 *   发射帧 L = 满足 `vy[L] − vy[L−1] ≥ 150`（check_jump 的赋值冲量 ≈ +302）的帧；
 *   顶点 = 从 L 起 y 单调上升到反转的那一帧；
 *   顶高 = y(apex) − y(发射帧)，上升时长 = t(apex) − t(发射帧)；
 *   峰值垂直速度 = 段内 max(vy)；段末 = y 回到 ≤ y(发射帧)+0.5 或再次冲量。
 * 另记：
 *   · 段内「渲染线 onGround=true 且 y 高于发射高度 ≥6 HU」帧（渲染侧 smoke gun）；
 *   · 权威侧「权威 onGround=true 且权威 y 高于自身地面基线 ≥6 HU」帧（权威侧 smoke gun，
 *     即 bug 的**直接机制**：权威在空中报着地 → check_jump 硬门被打开）。
 *
 * 用法：node scripts/jump-apex-report.mjs <label> [<label2> ...]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.tmp', 'jump-apex');
const LAUNCH_DVY = 150;     // 发射冲量阈值（正常起跳 ≈ +302；重力单帧最多 −13）
const GROUND_BIAS_HU = 6;   // 「明显离地」阈值
const APEX_MIN_HU = 3;      // 低于此高度视为噪音/落地抖动，不计入跳跃

const labels = process.argv.slice(2);
if (labels.length === 0) {
  console.error('用法: node scripts/jump-apex-report.mjs <label> [<label2> ...]');
  process.exit(2);
}

const q = (sorted, p) => {
  const a = sorted.filter(Number.isFinite);
  if (a.length === 0) return NaN;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'NaN');

function analyze(label) {
  const file = join(DIR, `${label}.json`);
  if (!existsSync(file)) throw new Error(`缺文件 ${file}`);
  const S = JSON.parse(readFileSync(file, 'utf8'));
  const n = S.length;
  if (n === 0) return { label, file, S, n: 0, jumps: [] };

  const dts = S.map((s) => s.dt).filter((d) => d > 0 && d < 200);
  const meanDt = mean(dts);

  // 地面基线：取 y 的低分位（平地站立时 y 基本恒定）
  const ys = S.map((s) => s.y).sort((a, b) => a - b);
  const groundY = q(ys, 0.02);

  const jumps = [];
  const impulses = [];
  for (let i = 1; i < n; i++) {
    const dvy = S[i].vy - S[i - 1].vy;
    if (dvy >= LAUNCH_DVY) impulses.push({ i, t: S[i].t, dvy, y: S[i].y, g: S[i].g, ay: S[i].ay, avg: S[i].avg });
  }

  // 一次跳跃 = 一个发射帧 + 其后到「回到发射 y」的整段
  let lastAnchor = -1;
  for (const imp of impulses) {
    const L = imp.i;
    const y0 = S[L].y;
    // 前视：找 y 的局部最大（apex）；允许 ±1 HU 抖动
    let iApex = L, vyPeak = S[L].vy, iEnd = L;
    let renderAirborneGroundFrames = 0, authAirborneGroundFrames = 0;
    const renderAnom = [], authAnom = [];
    for (let j = L + 1; j < n; j++) {
      const s = S[j];
      if (s.vy > vyPeak) vyPeak = s.vy;
      if (s.y > S[iApex].y) iApex = j;
      // 渲染侧：报着地却在发射高度之上
      if (s.g === 1 && s.y - y0 >= GROUND_BIAS_HU) {
        renderAirborneGroundFrames++;
        renderAnom.push({ t: +s.t.toFixed(1), y: +s.y.toFixed(2), hAbove: +(s.y - y0).toFixed(2), vy: +s.vy.toFixed(0), authG: s.avg });
      }
      // 权威侧：报着地却在**权威自己的**地面基线之上 ≥6 HU
      if (s.avg === 1 && s.ay !== null && s.ay - groundY >= GROUND_BIAS_HU) {
        authAirborneGroundFrames++;
        authAnom.push({ t: +s.t.toFixed(1), authY: +s.ay.toFixed(2), hAbove: +(s.ay - groundY).toFixed(2), authVy: s.avy === null ? null : +s.avy.toFixed(0) });
      }
      // 段末：回到发射高度以下（含容差）且已经过顶点
      if (j > iApex && s.y <= y0 + 0.5) { iEnd = j; break; }
      // 下一个发射帧也视为段末（防止重复计数）
      const nextImp = impulses.find((x) => x.i > L);
      if (nextImp && j >= nextImp.i) { iEnd = j; break; }
      iEnd = j;
    }
    if (L <= lastAnchor) continue; // 段重叠保护
    lastAnchor = iEnd;
    const apexH = S[iApex].y - y0;
    if (apexH < APEX_MIN_HU) continue;
    jumps.push({
      label, tTakeoffMs: S[L].t, iTakeoff: L, iApex, iEnd,
      yTakeoff: y0, yApex: S[iApex].y, apexH,
      riseMs: S[iApex].t - S[L].t, flightMs: S[iEnd].t - S[L].t,
      vyPeak, launchDvy: imp.dvy, gAtTakeoff: S[L].g, authGAtTakeoff: S[L].avg,
      renderAirborneGroundFrames, authAirborneGroundFrames,
      renderAnom, authAnom,
    });
  }

  // 全局帧级 smoke-gun 统计（不依赖分段）
  const renderGroundedFrames = S.filter((s) => s.g === 1).length;
  let renderGroundAboveBaseline = 0, authGroundAboveBaseline = 0;
  const renderGroundAboveSamples = [], authGroundAboveSamples = [];
  for (const s of S) {
    if (s.g === 1 && s.y - groundY >= GROUND_BIAS_HU) {
      renderGroundAboveBaseline++;
      if (renderGroundAboveSamples.length < 40) renderGroundAboveSamples.push({ t: +s.t.toFixed(1), y: +s.y.toFixed(2), h: +(s.y - groundY).toFixed(2), vy: +s.vy.toFixed(0), authG: s.avg });
    }
    if (s.avg === 1 && s.ay !== null && s.ay - groundY >= GROUND_BIAS_HU) {
      authGroundAboveBaseline++;
      if (authGroundAboveSamples.length < 40) authGroundAboveSamples.push({ t: +s.t.toFixed(1), authY: +s.ay.toFixed(2), h: +(s.ay - groundY).toFixed(2), authVy: s.avy === null ? null : +s.avy.toFixed(0), renderY: +s.y.toFixed(2), renderG: s.g });
    }
  }

  const heights = jumps.map((j) => j.apexH);
  const sorted = [...heights].sort((a, b) => a - b);
  const med = q(sorted, 0.5);
  const oversized = jumps.filter((j) => j.apexH > 1.5 * med);

  const authDts = [];
  for (let i = 1; i < n; i++) {
    if (S[i].ava !== null && S[i - 1].ava !== null && S[i].ava > S[i - 1].ava) authDts.push(S[i].t - S[i - 1].t);
  }
  let authGFlips = 0, authGTrue = 0;
  let prevAG = null;
  for (const s of S) {
    if (s.avg === null) continue;
    if (s.avg === 1) authGTrue++;
    if (prevAG !== null && prevAG !== s.avg) authGFlips++;
    prevAG = s.avg;
  }

  return {
    label, file, S, n, groundY,
    seconds: (meanDt * n) / 1000, renderHz: 1000 / meanDt,
    authPublish: authDts.length,
    renderGroundedFrames, authGTrue, authGFlips,
    renderGroundAboveBaseline, authGroundAboveBaseline,
    renderGroundAboveSamples, authGroundAboveSamples,
    impulses, jumps, heights, sorted, med, oversized,
    authAvailable: S.filter((s) => s.ava !== null).length,
    yMin: ys[0], yMax: ys[ys.length - 1],
  };
}

function printDetail(r, trace) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`── ${r.label} ──   (${r.file.split(/[\\/]/).pop()})`);
  if (r.n === 0) return console.log('空采样');
  console.log(`采样 ${r.n} 帧 / ${f(r.seconds, 1)}s | 渲染物理线 ${f(r.renderHz, 1)} Hz | 权威发布 ${r.authPublish} 帧 | 地面基线 y=${f(r.groundY)}`);
  console.log(`渲染线 onGround 帧 ${r.renderGroundedFrames} | 权威 onGround 帧 ${r.authGTrue}（翻转 ${r.authGFlips} 次）| 权威快照可用 ${r.authAvailable}`);
  console.log(`y 范围 ${f(r.yMin)} … ${f(r.yMax)} HU`);

  const h = r.sorted;
  console.log(`\n发射冲量（Δvy≥${LAUNCH_DVY}）次数 = ${r.impulses.length}`);
  console.log(`跳跃段数 n = ${r.jumps.length}（顶高 ≥ ${APEX_MIN_HU} HU）`);
  if (h.length === 0) return;
  console.log(`顶高(HU)  mean ${f(mean(r.heights))} | p50 ${f(q(h, 0.5))} | p90 ${f(q(h, 0.9))} | p99 ${f(q(h, 0.99))} | max ${f(h[h.length - 1])} | min ${f(h[0])}`);
  console.log(`理论单跳顶高 = v²/2g = 302.05²/1600 = ${f(302.05 ** 2 / 1600)} HU   |   中位 ×1.5 = ${f(1.5 * r.med)} HU`);
  console.log(`顶高列表: ${r.heights.map((v) => v.toFixed(1)).join(', ')}`);
  const over70 = r.heights.filter((v) => v > 70).length;
  const over80 = r.heights.filter((v) => v > 80).length;
  const over100 = r.heights.filter((v) => v > 100).length;
  console.log(`> 70HU: ${over70} | > 80HU: ${over80} | > 100HU（≈翻倍）: ${over100}`);

  console.log(`\n★ SMOKE GUN（帧级，全时段）`);
  console.log(`  渲染线：onGround=true 且 y ≥ 基线+${GROUND_BIAS_HU}HU 的帧 = ${r.renderGroundAboveBaseline}`);
  console.log(`  权威侧：权威 onGround=true 且 权威 y ≥ 基线+${GROUND_BIAS_HU}HU 的帧 = ${r.authGroundAboveBaseline}`);
  if (r.authGroundAboveSamples.length) {
    console.log(`  权威侧样本（前 ${Math.min(10, r.authGroundAboveSamples.length)} 条）：`);
    for (const s of r.authGroundAboveSamples.slice(0, 10)) console.log(`    t=+${s.t}ms  authY=${s.authY}  hAbove=${s.h}  authVy=${s.authVy}  渲染 y=${s.renderY} 渲染 onG=${s.renderG}`);
  }
  if (r.renderGroundAboveSamples.length) {
    console.log(`  渲染侧样本（前 10 条）：`);
    for (const s of r.renderGroundAboveSamples.slice(0, 10)) console.log(`    t=+${s.t}ms  y=${s.y}  hAbove=${s.h}  vy=${s.vy}  权威 onG=${s.authG}`);
  }

  console.log(`\n超 1.5× 中位的跳跃: ${r.oversized.length} 个`);
  for (const o of r.oversized) {
    console.log(`  · t=+${f(o.tTakeoffMs, 1)}ms  顶高 ${f(o.apexH)} HU  上升 ${f(o.riseMs, 1)}ms  飞行 ${f(o.flightMs, 1)}ms  峰值vy ${f(o.vyPeak, 1)}  起跳Δvy ${f(o.launchDvy, 0)}  g@起跳=${o.gAtTakeoff} authG@起跳=${o.authGAtTakeoff}`);
    console.log(`    起跳 y=${f(o.yTakeoff)} → 顶点 y=${f(o.yApex)}；段内 渲染空中着地帧 ${o.renderAirborneGroundFrames} / 权威空中着地帧 ${o.authAirborneGroundFrames}`);
  }

  if (!trace) return;
  for (const o of r.oversized.slice(0, 3)) {
    console.log(`\n  ── 超限跳跃 t=+${f(o.tTakeoffMs, 1)}ms 逐帧 y 轨迹（Δ=相对发射帧）──`);
    const s0 = Math.max(0, o.iTakeoff - 6), s1 = Math.min(r.n - 1, o.iApex + 12);
    for (let i = s0; i <= s1; i++) {
      const s = r.S[i];
      const mark = i === o.iTakeoff ? '<< LAUNCH' : i === o.iApex ? '<< APEX' : '';
      console.log(`    t=${(s.t - r.S[o.iTakeoff].t).toFixed(1).padStart(8)}ms  y=${s.y.toFixed(2).padStart(10)}  Δ=${(s.y - o.yTakeoff).toFixed(2).padStart(8)}  vy=${s.vy.toFixed(1).padStart(8)}  g=${s.g}  authY=${s.ay === null ? '     —  ' : s.ay.toFixed(2).padStart(10)}  authG=${s.avg === null ? '—' : s.avg}  authVy=${s.avy === null ? '    —  ' : s.avy.toFixed(1).padStart(8)}  ${mark}`);
    }
  }
  // 正常跳跃对照轨迹
  const normal = r.jumps.filter((j) => j.apexH <= 1.5 * r.med).sort((a, b) => a.apexH - b.apexH);
  const pick = normal[Math.floor(normal.length / 2)];
  if (pick) {
    console.log(`\n  ── 中位跳跃 t=+${f(pick.tTakeoffMs, 1)}ms（顶高 ${f(pick.apexH)}）逐帧对照 ──`);
    const s0 = Math.max(0, pick.iTakeoff - 6), s1 = Math.min(r.n - 1, pick.iApex + 12);
    for (let i = s0; i <= s1; i++) {
      const s = r.S[i];
      const mark = i === pick.iTakeoff ? '<< LAUNCH' : i === pick.iApex ? '<< APEX' : '';
      console.log(`    t=${(s.t - r.S[pick.iTakeoff].t).toFixed(1).padStart(8)}ms  y=${s.y.toFixed(2).padStart(10)}  Δ=${(s.y - pick.yTakeoff).toFixed(2).padStart(8)}  vy=${s.vy.toFixed(1).padStart(8)}  g=${s.g}  authY=${s.ay === null ? '     —  ' : s.ay.toFixed(2).padStart(10)}  authG=${s.avg === null ? '—' : s.avg}  ${mark}`);
    }
  }
}

const results = labels.map((l) => {
  try {
    return analyze(l);
  } catch (e) {
    console.error(`分析 ${l} 失败: ${e.message}`);
    return null;
  }
}).filter(Boolean);

// 可选：把输出同时写入 UTF-8 文件（避免 shell 重定向产生 UTF-16/二进制）
const OUT = process.env.JUMP_REPORT_OUT;
if (OUT) {
  const chunks = [];
  const orig = console.log;
  console.log = (...a) => { chunks.push(a.join(' ')); orig(...a); };
  for (const r of results) printDetail(r, true);
  if (results.length > 1) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('── 汇总对照（渲染物理线顶高，HU）──');
    console.log(
      'label'.padEnd(16) + 'jumps'.padStart(7) + 'mean'.padStart(9) + 'p50'.padStart(9) + 'p90'.padStart(9) +
      'p99'.padStart(9) + 'max'.padStart(9) + '>70'.padStart(6) + '>100'.padStart(6) + '超1.5×p50'.padStart(11) +
      '渲空着地'.padStart(10) + '权空着地'.padStart(10),
    );
    for (const r of results) {
      const h = r.sorted.filter(Number.isFinite);
      console.log(
        r.label.padEnd(16) + String(r.jumps.length).padStart(7) + f(mean(r.heights)).padStart(9) +
        f(q(h, 0.5)).padStart(9) + f(q(h, 0.9)).padStart(9) + f(q(h, 0.99)).padStart(9) +
        f(h[h.length - 1]).padStart(9) + String(r.heights.filter((v) => v > 70).length).padStart(6) +
        String(r.heights.filter((v) => v > 100).length).padStart(6) +
        String(r.oversized.length).padStart(11) + String(r.renderGroundAboveBaseline).padStart(10) +
        String(r.authGroundAboveBaseline).padStart(10),
      );
    }
  }
  writeFileSync(OUT, chunks.join('\n') + '\n', 'utf8');
  process.exit(0);
}

for (const r of results) printDetail(r, true);

if (results.length > 1) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('── 汇总对照（渲染物理线顶高，HU）──');
  console.log(
    'label'.padEnd(16) + 'jumps'.padStart(7) + 'mean'.padStart(9) + 'p50'.padStart(9) + 'p90'.padStart(9) +
    'p99'.padStart(9) + 'max'.padStart(9) + '>70'.padStart(6) + '>100'.padStart(6) + '超1.5×p50'.padStart(11) +
    '渲空着地'.padStart(10) + '权空着地'.padStart(10),
  );
  for (const r of results) {
    const h = r.sorted.filter(Number.isFinite);
    console.log(
      r.label.padEnd(16) + String(r.jumps.length).padStart(7) + f(mean(r.heights)).padStart(9) +
      f(q(h, 0.5)).padStart(9) + f(q(h, 0.9)).padStart(9) + f(q(h, 0.99)).padStart(9) +
      f(h[h.length - 1]).padStart(9) + String(r.heights.filter((v) => v > 70).length).padStart(6) +
      String(r.heights.filter((v) => v > 100).length).padStart(6) +
      String(r.oversized.length).padStart(11) + String(r.renderGroundAboveBaseline).padStart(10) +
      String(r.authGroundAboveBaseline).padStart(10),
    );
  }
}
