#!/usr/bin/env node
/** 打印某个时刻附近（±windowMs）的逐帧原始采样，用于定位翻倍跳的起始。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'jump-apex');
const [label, tStr, winStr] = process.argv.slice(2);
const t0 = Number(tStr);
const win = Number(winStr ?? 300);
const S = JSON.parse(readFileSync(join(DIR, `${label}.json`), 'utf8'));
const base = t0 - S[0].t;
const sel = S.filter((s) => s.t - S[0].t >= base - win && s.t - S[0].t <= base + win);
console.log(`${label}: t0=+${base.toFixed(1)}ms 窗口 ±${win}ms  帧数=${sel.length}`);
console.log('   t(ms)      y      Δy     vy    g |  authY   authG   authVy  |  dVy_r  dVy_a  vy_r-302  vy_a-302');
let prev = null;
for (const s of sel) {
  const dyr = prev ? s.vy - prev.vy : 0;
  const dya = prev && prev.avy !== null && s.avy !== null ? s.avy - prev.avy : 0;
  console.log(
    `${(s.t - S[0].t).toFixed(1).padStart(9)} ${s.y.toFixed(2).padStart(9)} ${(s.y - 15360.97).toFixed(2).padStart(7)} ` +
    `${s.vy.toFixed(1).padStart(8)} ${s.g} | ${s.ay === null ? '   —  ' : s.ay.toFixed(2).padStart(8)} ` +
    `${s.avg === null ? '—' : String(s.avg).padStart(4)} ${s.avy === null ? '   —  ' : s.avy.toFixed(1).padStart(8)} | ` +
    `${dyr.toFixed(0).padStart(6)} ${dya.toFixed(0).padStart(6)} ${(s.vy - 302.05).toFixed(0).padStart(9)} ${s.avy === null ? '   —' : (s.avy - 302.05).toFixed(0).padStart(9)}`,
  );
  prev = s;
}
