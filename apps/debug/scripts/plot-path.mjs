#!/usr/bin/env node
/**
 * 路径数据绘图 / 折角分析（常驻工具）。
 *
 * 用途：把 debug 面板导出的 phys-path JSON 画成 PNG，并按「tick 节点尺度」放大，
 * 用于核对 64Hz tick 物理的折角与两线偏差——3D 视角下路径远、段被透视压缩，
 * 这里用 2D 正交投影 + 节点标记，节点结构不受相机影响。
 *
 * 输出（默认写到 <jsonDir>/plot-<时间戳>/）：
 *   overview.png      俯视 X-Z + 侧视 Z-Y（切断 >JUMP 的跳变，只画最长连续段）
 *   zoom-<n>.png      折角最密的若干 1 秒窗口（render 细青 / tick 粗琥珀 / tick 节点方点）
 * 同时打印：采样率、段长、夹角分布、折角密集窗口。
 *
 * 用法：node scripts/plot-path.mjs <phys-path.json> [--out <dir>] [--zooms 3] [--jump 60]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, basename } from 'node:path';

// ── 参数 ──
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法: node scripts/plot-path.mjs <phys-path.json> [--out <dir>] [--zooms 3] [--jump 60]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const JUMP = Number(opt('jump', 60));
const ZOOMS = Number(opt('zooms', 3));
const OUTDIR = opt('out', join(dirname(file), 'plot-' + basename(file).replace(/\.json$/, '')));

const j = JSON.parse(readFileSync(file, 'utf8'));
const R = j.render ?? [];
const T = j.tick ?? [];
if (!R.length || !T.length) {
  console.error('JSON 缺少 render/tick 数据');
  process.exit(2);
}

// ── 统计 ──
/** 按 >jump 的跳变切连续段（respawn/teleport 会制造上万 HU 的跳变）。 */
function segments(pts) {
  const out = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const a = pts[i - 1], b = pts[i];
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > JUMP) {
        if (cur.length >= 5) out.push(cur);
        cur = [];
      }
    }
    cur.push(pts[i]);
  }
  if (cur.length >= 5) out.push(cur);
  return out;
}
const longest = (s) => s.slice().sort((a, b) => b.length - a.length)[0] ?? [];
const LR = longest(segments(R));
const LT = longest(segments(T));
const dur = (a) => (a.length ? (a[a.length - 1].t - a[0].t) / 1000 : 0);
const gaps = (a) => { const o = []; for (let i = 1; i < a.length; i++) o.push(Math.hypot(a[i].x-a[i-1].x, a[i].y-a[i-1].y, a[i].z-a[i-1].z)); return o; };
const turns = (a) => {
  const o = [];
  for (let i = 2; i < a.length; i++) {
    const p = Math.atan2(a[i-1].y-a[i-2].y, a[i-1].x-a[i-2].x);
    const q = Math.atan2(a[i].y-a[i-1].y, a[i].x-a[i-1].x);
    let d = Math.abs(q - p); if (d > Math.PI) d = 2 * Math.PI - d;
    o.push(d * 180 / Math.PI);
  }
  return o;
};
const pct = (a, p) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

console.log('=== 采样 ===');
console.log(`  render ${R.length} 点 / ${dur(R).toFixed(2)}s = ${(R.length / dur(R)).toFixed(1)} Hz`);
console.log(`  tick   ${T.length} 点 / ${dur(T).toFixed(2)}s = ${(T.length / dur(T)).toFixed(1)} Hz`);
console.log(`  最长连续段: render ${LR.length} 点 / tick ${LT.length} 点`);
console.log('=== tick 节点结构（最长连续段）===');
const gT = gaps(LT), aT = turns(LT);
console.log(`  段长: p50=${pct(gT,0.5).toFixed(1)} p90=${pct(gT,0.9).toFixed(1)} max=${Math.max(...gT).toFixed(0)} HU`);
console.log(`  夹角: p50=${pct(aT,0.5).toFixed(2)}° p75=${pct(aT,0.75).toFixed(2)}° p90=${pct(aT,0.9).toFixed(2)}° p99=${pct(aT,0.99).toFixed(2)}° max=${Math.max(...aT).toFixed(1)}°`);
for (const th of [5, 10, 20, 45, 90]) {
  const n = aT.filter((v) => v > th).length;
  console.log(`  夹角 >${th}°: ${n} / ${aT.length} = ${(n / aT.length * 100).toFixed(1)}%`);
}

// ── 折角密集窗口 ──
const t0 = LT[0].t;
const windows = [];
for (let off = 0; off + 1000 <= LT[LT.length - 1].t - t0; off += 250) {
  const A = t0 + off, B = A + 1000;
  const seg = LT.filter((p) => p.t >= A && p.t <= B);
  if (seg.length < 10) continue;
  const as = turns(seg);
  if (!as.length) continue;
  windows.push({ off: off / 1000, seg, mean: mean(as), max: Math.max(...as), over10: as.filter((v) => v > 10).length });
}
windows.sort((a, b) => b.mean - a.mean);
console.log('=== 折角最密的 1 秒窗口 ===');
for (const w of windows.slice(0, 10)) {
  console.log(`  t=+${w.off.toFixed(2)}s  节点=${w.seg.length}  夹角均值=${w.mean.toFixed(2)}°  最大=${w.max.toFixed(1)}°  >10°=${w.over10}`);
}

// ── 画图（手写 PNG，无依赖）──
const W = 1400, H = 1000;
const CY = [70, 220, 245], AM = [255, 170, 20], DOT = [255, 235, 120], BG = [16, 16, 20];

function newCanvas() {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { buf[i*3]=BG[0]; buf[i*3+1]=BG[1]; buf[i*3+2]=BG[2]; }
  return buf;
}
function savePng(buf, out) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y*(W*3+1)] = 0; buf.copy(raw, y*(W*3+1)+1, y*W*3, (y+1)*W*3); }
  const tb = (() => { const t = new Int32Array(256); for (let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; t[n]=c; } return t; })();
  const crc32 = (b) => { let c=-1; for (const v of b) c = tb[(c^v)&0xff]^(c>>>8); return (c^-1)>>>0; };
  const chunk = (type, data) => { const l=Buffer.alloc(4); l.writeUInt32BE(data.length); const td=Buffer.concat([Buffer.from(type,'ascii'),data]); const cr=Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l,td,cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=2;
  writeFileSync(out, Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR',ihdr), chunk('IDAT', deflateSync(raw,{level:6})), chunk('IEND', Buffer.alloc(0))]));
}
function px(buf, x, y, c) { if (x<0||y<0||x>=W||y>=H) return; const o=(y*W+x)*3; buf[o]=c[0]; buf[o+1]=c[1]; buf[o+2]=c[2]; }
function bbox(pts) {
  let x0=1e18,x1=-1e18,y0=1e18,y1=-1e18,z0=1e18,z1=-1e18;
  for (const p of pts) { x0=Math.min(x0,p.x);x1=Math.max(x1,p.x);y0=Math.min(y0,p.y);y1=Math.max(y1,p.y);z0=Math.min(z0,p.z);z1=Math.max(z1,p.z); }
  return {x0,x1,y0,y1,z0,z1};
}
function mk(a0,a1,b0,b1,px0,py0,pw,ph) {
  const pad = 55;
  const s = Math.min((pw-2*pad)/Math.max(a1-a0,1e-6), (ph-2*pad)/Math.max(b1-b0,1e-6));
  return { s, ox: px0+pad+((pw-2*pad)-(a1-a0)*s)/2, oy: py0+pad+((ph-2*pad)-(b1-b0)*s)/2, a0, b0 };
}
function line(buf, m, pts, col, w, sa, sb) {
  let prev = null;
  for (const p of pts) {
    const x = Math.round(m.ox + (sa(p)-m.a0)*m.s), y = Math.round(m.oy + (m.b0-sb(p))*m.s);
    if (prev) {
      const n = Math.max(Math.abs(x-prev[0]), Math.abs(y-prev[1]), 1);
      for (let k = 0; k <= n; k++) {
        const xi = Math.round(prev[0]+(x-prev[0])*k/n), yi = Math.round(prev[1]+(y-prev[1])*k/n);
        for (let q = 0; q < w; q++) { px(buf, xi+q, yi, col); px(buf, xi, yi+q, col); }
      }
    }
    prev = [x, y];
  }
}
function dots(buf, m, pts, col, sa, sb, r) {
  for (const p of pts) {
    const x = Math.round(m.ox + (sa(p)-m.a0)*m.s), y = Math.round(m.oy + (m.b0-sb(p))*m.s);
    for (let dx=-r; dx<=r; dx++) for (let dy=-r; dy<=r; dy++) px(buf, x+dx, y+dy, col);
  }
}

mkdirSync(OUTDIR, { recursive: true });

// overview
{
  const bb = bbox([...LR, ...LT]);
  const buf = newCanvas();
  const mTop = mk(bb.x0, bb.x1, bb.z0, bb.z1, 0, 0, W, Math.floor(H*0.55));
  line(buf, mTop, LR, CY, 1, (p)=>p.x, (p)=>p.z);
  line(buf, mTop, LT, AM, 2, (p)=>p.x, (p)=>p.z);
  const mSide = mk(bb.z0, bb.z1, bb.y0, bb.y1, 0, Math.floor(H*0.55), W, Math.floor(H*0.45));
  line(buf, mSide, LR, CY, 1, (p)=>p.z, (p)=>p.y);
  line(buf, mSide, LT, AM, 2, (p)=>p.z, (p)=>p.y);
  savePng(buf, join(OUTDIR, 'overview.png'));
  console.log(`\noverview 跨度 X=${(bb.x1-bb.x0).toFixed(0)} Y=${(bb.y1-bb.y0).toFixed(0)} Z=${(bb.z1-bb.z0).toFixed(0)}`);
}

// zoom windows
for (let i = 0; i < Math.min(ZOOMS, windows.length); i++) {
  const w = windows[i];
  const seg = w.seg;
  const A = seg[0].t, B = seg[seg.length - 1].t;
  const wr = LR.filter((p) => p.t >= A && p.t <= B);
  const bb = bbox([...wr, ...seg]);
  const buf = newCanvas();
  const mTop = mk(bb.x0, bb.x1, bb.z0, bb.z1, 0, 0, W, Math.floor(H*0.55));
  line(buf, mTop, wr, CY, 1, (p)=>p.x, (p)=>p.z);
  line(buf, mTop, seg, AM, 2, (p)=>p.x, (p)=>p.z);
  dots(buf, mTop, seg, DOT, (p)=>p.x, (p)=>p.z, 4);
  const mSide = mk(bb.z0, bb.z1, bb.y0, bb.y1, 0, Math.floor(H*0.55), W, Math.floor(H*0.45));
  line(buf, mSide, wr, CY, 1, (p)=>p.z, (p)=>p.y);
  line(buf, mSide, seg, AM, 2, (p)=>p.z, (p)=>p.y);
  dots(buf, mSide, seg, DOT, (p)=>p.z, (p)=>p.y, 4);
  const f = join(OUTDIR, `zoom-${i + 1}-t${w.off.toFixed(2)}s.png`);
  savePng(buf, f);
  console.log(`zoom-${i + 1} t=+${w.off.toFixed(2)}s 节点=${seg.length} 夹角均值=${w.mean.toFixed(2)}° max=${w.max.toFixed(1)}° -> ${f}`);
}
// ── diagnostics.png：偏差-时间 与 折角-时间 ──
{
  // 在 render 线上按时间插值（用于逐 tick 偏差）
  const rp = LR.map((p) => [p.x, p.y, p.z, p.t]);
  function sampleAt(t) {
    if (t <= rp[0][3]) return rp[0];
    const last = rp[rp.length - 1];
    if (t >= last[3]) return last;
    let lo = 0, hi = rp.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rp[m][3] <= t) lo = m; else hi = m; }
    const f = (t - rp[lo][3]) / Math.max(rp[hi][3] - rp[lo][3], 1e-6);
    return [0, 1, 2].map((k) => rp[lo][k] + (rp[hi][k] - rp[lo][k]) * f);
  }
  const serie = [];   // { t, devi, turn }
  for (let i = 0; i < LT.length; i++) {
    const p = LT[i];
    const s = sampleAt(p.t);
    const devi = Math.hypot(p.x - s[0], p.y - s[1], p.z - s[2]);
    let turn = 0;
    if (i >= 2) {
      const a1 = Math.atan2(LT[i-1].y-LT[i-2].y, LT[i-1].x-LT[i-2].x);
      const a2 = Math.atan2(LT[i].y-LT[i-1].y, LT[i].x-LT[i-1].x);
      let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
      turn = d * 180 / Math.PI;
    }
    serie.push({ t: p.t - t0, devi, turn });
  }
  const maxDevi = Math.max(...serie.map((s) => s.devi), 1);
  const maxTurn = Math.max(...serie.map((s) => s.turn), 1);
  const T_MAX = serie[serie.length - 1].t;

  const buf = newCanvas();
  // 上：偏差-时间
  const H1 = Math.floor(H * 0.5);
  const X1 = (t) => Math.round(70 + (t / T_MAX) * (W - 130));
  const Y1 = (v) => Math.round(H1 - 40 - (v / maxDevi) * (H1 - 90));
  for (let x = 70; x < W - 60; x++) px(buf, x, H1 - 40, [60, 60, 70]);
  for (let x = 70; x < W - 60; x++) px(buf, x, Math.round(H1 - 40 - (H1 - 90) / 2), [40, 40, 48]);
  let prev = null;
  for (const s of serie) {
    const x = X1(s.t), y = Y1(s.devi);
    if (prev && Math.abs(y - prev[1]) < H1) { for (let k = 0; k <= Math.abs(x-prev[0]); k++) { const xi = Math.round(prev[0]+(x-prev[0])*k/Math.max(Math.abs(x-prev[0]),1)); const yi = Math.round(prev[1]+(y-prev[1])*k/Math.max(Math.abs(x-prev[0]),1)); px(buf, xi, yi, [255, 60, 210]); } }
    prev = [x, y];
  }
  // 下：折角-时间
  const H2 = H;
  const Y2 = (v) => Math.round(H2 - 40 - (v / maxTurn) * (H - H1 - 100));
  for (let x = 70; x < W - 60; x++) px(buf, x, H2 - 40, [60, 60, 70]);
  prev = null;
  for (const s of serie) {
    const x = X1(s.t), y = Y2(s.turn);
    if (prev && Math.abs(y - prev[1]) < H) { for (let k = 0; k <= Math.abs(x-prev[0]); k++) { const xi = Math.round(prev[0]+(x-prev[0])*k/Math.max(Math.abs(x-prev[0]),1)); const yi = Math.round(prev[1]+(y-prev[1])*k/Math.max(Math.abs(x-prev[0]),1)); px(buf, xi, yi, [255, 170, 20]); } }
    prev = [x, y];
  }
  savePng(buf, join(OUTDIR, 'diagnostics.png'));
  const top = serie.slice().sort((a, b) => b.devi - a.devi).slice(0, 8);
  console.log(`\n诊断图 -> ${join(OUTDIR, 'diagnostics.png')}`);
  console.log(`  偏差最大 8 个时刻: ${top.map((s) => `+${(s.t/1000).toFixed(2)}s:${s.devi.toFixed(0)}HU`).join('  ')}`);
  const topTurn = serie.slice().sort((a, b) => b.turn - a.turn).slice(0, 8);
  console.log(`  折角最大 8 个时刻: ${topTurn.map((s) => `+${(s.t/1000).toFixed(2)}s:${s.turn.toFixed(0)}°`).join('  ')}`);

  // ── 滞后扫描：偏差是「物理分歧」还是「权威帧龄/延迟」？ ──
  // 把 tick 节点与「渲染线在 t-Δ」比较，扫 Δ。若某个 Δ 让偏差大幅下降 → 是延迟；
  // 扫不动 → 是真实物理分歧。这一步能避免把时间错位误读成分歧。
  const meanDiv = (dtMs) => {
    let sum = 0, n = 0;
    for (const p of LT) {
      const s = sampleAt(p.t - dtMs);
      sum += Math.hypot(p.x - s[0], p.y - s[1], p.z - s[2]);
      n++;
    }
    return n ? sum / n : NaN;
  };
  const at0 = meanDiv(0);
  let bestD = 0, bestV = Infinity;
  for (let d = -20; d <= 40; d += 0.5) { const v = meanDiv(d); if (v < bestV) { bestV = v; bestD = d; } }
  console.log('  滞后扫描（Δ=0 即当前实现：同挂钟时刻对齐）:');
  for (const d of [-7.8, 0, 7.8, 15.6, 23.4]) {
    console.log(`    Δ=${d.toFixed(1).padStart(5)}ms  平均偏差 ${meanDiv(d).toFixed(2)} HU`);
  }
  console.log(`    最优 Δ=${bestD.toFixed(1)}ms → ${bestV.toFixed(2)} HU（较 Δ=0 下降 ${(100*(1-bestV/at0)).toFixed(1)}%）`);
  console.log(bestV < at0 * 0.5
    ? '    → 偏差主要是**权威帧龄（延迟）**，对齐后应基本重合'
    : '    → 扫滞后降不下去：这是**真实的物理分歧**（不是时间错位假象）');
}

console.log(`\n输出目录: ${OUTDIR}`);
