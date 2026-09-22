#!/usr/bin/env node
/**
 * 打印某时刻附近 ±windowMs 的逐帧采样表，用于定位「翻倍跳」的起始帧。
 *
 * 用法：`node scripts/jump-apex-window.mjs <label> <tMs> [windowMs=300]`
 * - 数据源：`apps/debug/scripts/jump-apex-measure.mjs` 写出的
 *   `apps/debug/.tmp/jump-apex/<label>.json`（采样器逐 rAF 帧记录）；
 * - `<tMs>` 与样本的 `t` **同钟**（页面的 `performance.now()` 绝对毫秒）：脚本内部换算成
 *   相对首帧的 `base = tMs - S[0].t`，再按 `±win` 截窗口（对比
 *   `apps/debug/scripts/jump-apex-trace.mjs` 收的是**相对首帧**的毫秒）；
 * - 样本字段（生产者侧定义）：`t`、`y`/`vy` 为渲染物理线，`g` 为渲染 onGround，
 *   `ay`/`avg`/`avy` 为权威帧只读快照，权威取不到时为 `null`（表中显示 `—`）。
 *
 * 两列基线是**本脚本内写死的常量**，不是从采样算出来的：
 * - `Δy` 以 `15360.97` 为参照高度（同族 `apps/debug/scripts/jump-apex-report.mjs` 改用采样的
 *   2% 分位数当基线）；
 * - `vy_r-302` / `vy_a-302` 以 `302.05` 为单跳起跳速度基线（同族 `jump-apex-report.mjs` 的
 *   理论顶高式取 302.05，`apps/debug/scripts/jump-apex-verify.mjs` 取 302）。
 */
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
