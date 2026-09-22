#!/usr/bin/env node
/**
 * 定位「超限跳」的**真正起始**：从给定时刻向前回溯，找最近一次「渲染 vy 由 <350 跃升到 ≥350」
 * 的帧，再打印该帧起的一段逐帧表（该帧标 `<<INJECT`）。
 *
 * 用法：`node scripts/jump-apex-trace.mjs <label> <tMs> [windowMs=60]`
 * - 数据源：`apps/debug/scripts/jump-apex-measure.mjs` 写出的
 *   `apps/debug/.tmp/jump-apex/<label>.json`；
 * - `<tMs>` 是**相对首帧**的毫秒（对比 `apps/debug/scripts/jump-apex-window.mjs` 收的是
 *   `performance.now()` 绝对毫秒）；
 * - 350 是「单跳到不了」的判据：单跳起跳速度 302.05（同族
 *   `apps/debug/scripts/jump-apex-report.mjs` 的理论顶高式），≥350 说明该帧有额外冲量注入；
 * - 找不到跃升帧时退回「target 之后的第一帧」；两个分支都失败时 `start` 仍是 -1，随后
 *   `S[start].t` 取到 `undefined` 会抛 TypeError（本脚本未处理该分支）；
 * - 打印区间是 `i ∈ [start - round(win/3), start + win*3)`；`base` 取全部 `y` 的 2% 分位数，
 *   `Δbase` 是相对它的高度；权威列 `ay`/`avg`/`avy` 取不到时为 `null`（显示 `—`）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'jump-apex');
const [label, tStr, winStr] = process.argv.slice(2);
const S = JSON.parse(readFileSync(join(DIR, `${label}.json`), 'utf8'));
const t0 = S[0].t;
const target = Number(tStr);
const win = Number(winStr ?? 60);

let start = -1;
for (let i = 1; i < S.length; i++) {
  const t = S[i].t - t0;
  if (t > target) break;
  if (S[i].vy >= 350 && S[i - 1].vy < 350) start = i;
}
if (start < 0) {
  console.log('未找到 ≥350 的跃升帧，改用最早帧附近');
  start = S.findIndex((s) => s.t - t0 >= target);
}
const ys = S.map((s) => s.y).sort((a, b) => a - b);
const base = ys[Math.floor(ys.length * 0.02)];
console.log(`${label}: 目标 t=+${target}ms → 注入帧 t=+${(S[start].t - t0).toFixed(1)}ms（i=${start}）  基线 y=${base.toFixed(2)}`);
console.log('    t(ms)        y     Δbase       vy   g |     authY authG     authVy |  dVy_r  dVy_a   vy_r    vy_a');
let prev = null;
for (let i = Math.max(0, start - Math.round(win / 3)); i < Math.min(S.length, start + win * 3); i++) {
  const s = S[i];
  const dyr = prev ? s.vy - prev.vy : 0;
  const dya = prev && prev.avy !== null && s.avy !== null ? s.avy - prev.avy : 0;
  const mark = i === start ? ' <<INJECT' : '';
  console.log(
    `${(s.t - t0).toFixed(1).padStart(10)} ${s.y.toFixed(2).padStart(9)} ${(s.y - base).toFixed(2).padStart(9)} ` +
    `${s.vy.toFixed(1).padStart(8)} ${String(s.g).padStart(2)} | ${s.ay === null ? '     —  ' : s.ay.toFixed(2).padStart(9)} ` +
    `${s.avg === null ? '—' : String(s.avg).padStart(4)} ${s.avy === null ? '     —  ' : s.avy.toFixed(1).padStart(9)} | ` +
    `${dyr.toFixed(0).padStart(6)} ${dya.toFixed(0).padStart(6)} ${s.vy.toFixed(0).padStart(6)} ${s.avy === null ? '     —' : s.avy.toFixed(0).padStart(6)}${mark}`,
  );
  prev = s;
}
