/**
 * 三联活态对比页（T-650 v3 U0）：默认 | 本轮 | 参考图 的翻页播放对比。
 *
 * 用法：
 *   node src/scripts/capture-strip.mjs \
 *     --default ../../round-base --round ../../rounds/R0 \
 *     --ref ../../ref/target-refined.png \
 *     --positions p0,p1,p2,p4 --out ../../rounds/R0/strip.html
 * 路径相对 --out 所在目录写进 HTML（file:// 直接打开）。列一/列二为 120ms 轮换的活态
 * 序列（同一播放头全局同步，可暂停），列三为静态参考图。owner 打开一个文件看全部。
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve, join, dirname, basename } from 'node:path';

function arg(name, fallback = null) {
	const i = process.argv.indexOf('--' + name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const defaultDir = arg('default');
const roundDir = arg('round');
const ref = arg('ref');
const out = arg('out');
const positions = (arg('positions', 'p0,p1,p2,p4') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!defaultDir || !roundDir || !ref || !out) {
	console.error('缺少 --default/--round/--ref/--out');
	process.exit(2);
}

/** 目录里按文件名排序的 png 序列（f01…fNN 命名天然有序）。 */
function framesOf(dir, pos) {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith(pos + '-') && f.endsWith('.png'))
			.sort()
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

const rows = [];
for (const pos of positions) {
	const a = framesOf(resolve(dirname(out), defaultDir), pos);
	const b = framesOf(resolve(dirname(out), roundDir), pos);
	rows.push({ pos, a, b });
}
const maxFrames = Math.max(1, ...rows.flatMap((r) => [r.a.length, r.b.length]));

const esc = (p) => p.split('\\').join('/');
const html = `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>T-650 v3 活态三联对比</title>
<style>
 body{font-family:system-ui,sans-serif;background:#14181d;color:#d8dee6;margin:16px}
 h1{font-size:18px} .row{margin:18px 0}
 .head{font-weight:600;margin-bottom:6px}
 .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
 .cell{border:1px solid #2c3540;border-radius:6px;padding:6px}
 .tag{font-size:12px;opacity:.75;margin-bottom:4px}
 img{width:100%;display:block;border-radius:4px}
 .bar{position:sticky;top:0;background:#14181d;padding:8px 0;border-bottom:1px solid #2c3540;margin-bottom:8px}
 button{font-size:14px;padding:4px 14px}
 .missing{color:#e6b455}
</style>
<div class="bar">
 <button id="toggle">暂停</button>
 <span id="frameNo" style="margin-left:12px">frame 1/${maxFrames}</span>
 <span style="margin-left:12px;opacity:.7">三列：默认（HEAD 活态）｜本轮（变量）｜owner 参考图。120ms/帧，两列活态同步播放。</span>
</div>
${rows.map((r) => {
	if (!r.a.length && !r.b.length) return `<div class="row"><div class="head">${r.pos}: <span class="missing">两列都缺帧</span></div></div>`;
	const cell = (tag, frames, missing) => frames.length
		? `<div class="cell"><div class="tag">${tag}</div>${frames.map((f, i) => `<img data-seq="${tag}-${r.pos}" src="${esc(relative(dirname(resolve(out)), f))}" style="display:${i === 0 ? 'block' : 'none'}">`).join('')}</div>`
		: `<div class="cell"><div class="tag">${tag}</div><div class="missing">${missing}</div></div>`;
	return `<div class="row"><div class="head">${r.pos}（默认 ${r.a.length} 帧｜本轮 ${r.b.length} 帧）</div>
<div class="cols">
${cell('默认', r.a, '默认序列缺帧')}
${cell('本轮', r.b, '本轮序列缺帧')}
<div class="cell"><div class="tag">参考图（owner 提供）</div><img src="${esc(relative(dirname(resolve(out)), resolve(dirname(out), ref)))}"></div>
</div></div>`;
}).join('\n')}
<script>
 const perSeq = {};
 document.querySelectorAll('img[data-seq]').forEach((img) => {
	const k = img.dataset.seq;
	(perSeq[k] ??= []).push(img);
 });
 const keys = Object.keys(perSeq);
 let idx = 0, playing = true;
 const frameNo = document.getElementById('frameNo');
 function show(n) {
	idx = n % ${maxFrames};
	for (const k of keys) {
		const imgs = perSeq[k];
		imgs.forEach((im, i) => { im.style.display = i === (idx % imgs.length) ? 'block' : 'none'; });
	}
	frameNo.textContent = 'frame ' + (idx + 1) + '/${maxFrames}';
 }
 setInterval(() => { if (playing) show(idx + 1); }, 120);
 document.getElementById('toggle').onclick = (e) => {
	playing = !playing;
	e.target.textContent = playing ? '暂停' : '播放';
 };
 show(0);
</script>
`;
writeFileSync(out, html);
console.log('[strip] ' + out + '（positions: ' + positions.join(',') + '，frames/列上限 ' + maxFrames + '）');
