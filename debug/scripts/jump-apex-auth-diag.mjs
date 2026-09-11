#!/usr/bin/env node
/**
 * 权威侧 / 渲染侧「空中着地」诊断（读 jump-apex-measure 的原始采样）。
 *
 * 核心问题：修复前的写入通道是「常规重锚把渲染的 onGround 灌进权威」。本脚本量化：
 *   · 权威 onGround=true 的帧里，**权威自己的 y** 相对渲染地面基线高多少；
 *   · 渲染飞行段内，权威 onGround 为真的帧数（= check_jump 硬门在权威侧被打开的次数）；
 *   · 权威 vy 的分布 / 相对渲染 vy 的偏差（速度注入的可见后果）。
 *
 * 用法：node scripts/jump-apex-auth-diag.mjs <label> [<label2> ...]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.tmp', 'jump-apex');

// 可选：输出同时写 UTF-8 文件（避免 shell 重定向产生二进制）
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

  // 权威 onGround=true 的帧，按「权威 y 相对基线的高度」分桶
  const authG = S.filter((s) => s.avg === 1 && s.ay !== null);
  const buckets = {};
  for (const s of authG) {
    const h = Math.round(s.ay - baseline);
    buckets[h] = (buckets[h] ?? 0) + 1;
  }
  console.log(`权威 onGround=true 帧数 = ${authG.length}`);
  console.log(`  按「权威 y − 渲染基线」分桶(HU): ${JSON.stringify(Object.fromEntries(Object.entries(buckets).sort((a, b) => a[0] - b[0])))}`);

  // 关键：权威 onGround=true 且权威自己的 y 高于基线 ≥6 HU → check_jump 硬门在权威空中被打开
  for (const thr of [3, 6, 10, 20, 40]) {
    const n = authG.filter((s) => s.ay - baseline >= thr).length;
    console.log(`  权威 onGround=true 且 权威 y ≥ 基线+${thr}HU 的帧 = ${n}`);
  }
  // 权威 onGround=true 且权威 vy > +50（= 权威真的在上升，却报着地）
  const risingGrounded = authG.filter((s) => s.avy !== null && s.avy > 50);
  console.log(`  权威 onGround=true 且 权威 vy > +50（着地却在上升）的帧 = ${risingGrounded.length}`);
  for (const s of risingGrounded.slice(0, 8)) {
    console.log(`    t=+${s.t.toFixed(1)}ms  authY=${f(s.ay)} (h=${f(s.ay - baseline)})  authVy=${f(s.avy)}  渲染 y=${f(s.y)} 渲染 vy=${f(s.vy)} 渲染 onG=${s.g}`);
  }

  // 权威 vy 分布 vs 渲染 vy 分布
  const avy = S.filter((s) => s.avy !== null).map((s) => s.avy);
  const rvy = S.map((s) => s.vy);
  const sAvy = [...avy].sort((a, b) => a - b);
  const sRvy = [...rvy].sort((a, b) => a - b);
  console.log(`权威 vy: min ${f(sAvy[0], 1)} p50 ${f(q(sAvy, 0.5), 1)} p99 ${f(q(sAvy, 0.99), 1)} max ${f(sAvy[sAvy.length - 1], 1)}`);
  console.log(`渲染 vy: min ${f(sRvy[0], 1)} p50 ${f(q(sRvy, 0.5), 1)} p99 ${f(q(sRvy, 0.99), 1)} max ${f(sRvy[sRvy.length - 1], 1)}`);

  // 权威 vy 冲量（Δvy ≥ 150）及其相对渲染的高度位置
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

  // 渲染飞行段内的权威 onGround 帧（用渲染 vy 冲量切段）
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
