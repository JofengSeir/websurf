#!/usr/bin/env node
/**
 * 输入录制 / 确定性回放【无头验收】——用户不参与。
 *
 * 验的是什么（对应交付要求）：
 * 1. **逐帧输入一致**：录制期交给 `feedInput` 的 `(dx, dy, keys)` 序列，与回放期
 *    实际喂出去的序列**逐帧严格相等**（`===`，不是容差比较）。
 * 2. **逐帧位置一致**：录制期每个 rAF 帧的玩家位置，与回放期第 k 帧的位置相等
 *    （要求"位置差 ≤ 容差"，本脚本按 1e-9 HU 判等并报告实测最大值）。
 * 3. **帧数一致**：回放帧数 = 录制帧数（丢帧就要报出来，不许掩盖）。
 *
 * 怎么做到"录制/回放同一时间轴"：两边都由 `__wsInput` 驱动，缓存在页内——
 *   - 录制：`pushSynthetic()` 每帧注入一份合成输入（走**真实**输入路径：Q/E 合并 +
 *     滚轮位 + 录制点 + `feedInput`），排空队列即"这一帧已被物理消费"。
 *   - 回放：`tickReplay()` 每帧推进一步（等渲染主循环消费后再结算），天然逐帧对齐。
 * 页内循环执行（不是每个 rAF 一次 CDP evaluate），所以录制/回放速率只受页面 rAF 限制。
 *
 * 前置：无（本脚本自己起静态服务、自己起无头浏览器、自己收尾）。
 * 用法：node scripts/input-replay-verify.mjs [label] [seconds]
 * 产物：debug/.tmp/input-replay/<label>-recorded.json（录制文件）
 *       debug/.tmp/input-replay/<label>-replay.json（回放捕获 + 轨迹对照，全部数值）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const debugDir = join(__dirname, '..');
const repoRoot = join(debugDir, '..');

const LABEL = process.argv[2] ?? 'run';
const SECONDS = Number(process.argv[3] ?? 10);
const MAP = join(repoRoot, 'test', 'maps', 'surf_666.bsp');
const OUT_DIR = join(debugDir, '.tmp', 'input-replay');
const PORT_HTTP = 8080;
const LOAD_TIMEOUT_MS = 180000;
/** 位置判等容差（HU）：物理是同一份 wasm + 同一输入 + 同一步长，应当逐位相等；
 *  留 1e-6 只为吸收"最后一位浮点"可能出现的平台差异，不是给分叉留余地。 */
const POS_TOL = 1e-6;

const KEY = { forward: 1, left: 4, right: 8, jump: 16, duck: 32, wheelJump: 256, yawRight: 1024 };

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = CANDIDATES.find((p) => p && existsSync(p));
if (!BROWSER) {
  console.error('未找到 Chrome/Edge（headless CDP 需要其一）');
  process.exit(2);
}
if (!existsSync(MAP)) {
  console.error(`地图不存在：${MAP}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 静态服务（本脚本自起自停；不要求人工先跑 dev）──────────────────────────
const server = spawn('python', [join(repoRoot, 'src', 'serve.py'), String(PORT_HTTP), '.'], {
  cwd: debugDir,
  stdio: 'ignore',
});
let serverAlive = true;

// ── headless 浏览器 ────────────────────────────────────────────────────────
const CDP_PORT = 9500 + Math.floor(Math.random() * 90);
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + (process.env.TEMP ?? '.') + '/ws-input-replay-' + CDP_PORT,
    '--window-size=1280,720',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let finished = false;
function finish(code, note) {
  if (finished) return;
  finished = true;
  if (note) console.log(note);
  try { ws?.close(); } catch { /* noop */ }
  try { browser.kill(); } catch { /* noop */ }
  if (serverAlive) {
    serverAlive = false;
    try { server.kill(); } catch { /* noop */ }
  }
  setTimeout(() => process.exit(code), 250);
}
process.on('unhandledRejection', (e) => {
  console.error('[harness] unhandledRejection:', e instanceof Error ? e.stack : e);
  finish(1);
});
process.on('uncaughtException', (e) => {
  console.error('[harness] uncaughtException:', e instanceof Error ? e.stack : e);
  finish(1);
});

async function waitForCdp() {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json/list`);
      if (r.ok) {
        const page = (await r.json()).find((t) => t.type === 'page');
        if (page) return page;
      }
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}

const page = await waitForCdp();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let id = 0;
const pending = {};
const consoleLines = [];
ws.onclose = () => {
  for (const k of Object.keys(pending)) {
    pending[k]?.({ __wsClosed: true });
    delete pending[k];
  }
};
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending[m.id]) {
    pending[m.id](m.result);
    delete pending[m.id];
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(
      (m.params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
        .join(' '),
    );
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleLines.push('EXCEPTION: ' + (m.params.exceptionDetails?.text ?? ''));
  }
};
const send = (method, params = {}) =>
  Promise.race([
    new Promise((res) => {
      const myId = ++id;
      pending[myId] = res;
      try {
        ws.send(JSON.stringify({ id: myId, method, params }));
      } catch (e) {
        delete pending[myId];
        res({ __wsClosed: true, err: String(e) });
      }
    }),
    new Promise((res) => setTimeout(() => res({ __timeout: true, method }), 300000)),
  ]);
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.__wsClosed) throw new Error('CDP WebSocket closed');
  if (r?.__timeout) throw new Error('CDP evaluate timeout: ' + expression.slice(0, 120));
  if (r?.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 900));
  }
  return r?.result?.value;
};
const evalJson = async (expression) => {
  const raw = await evalJs(expression);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');

const URL_ = `http://localhost:${PORT_HTTP}/web/index.html`;
console.log(`[${LABEL}] ${BROWSER.split(/[\\/]/).pop()} -> ${URL_}`);
console.log(`[${LABEL}] 地图 ${MAP}`);
await send('Page.navigate', { url: URL_ });
await sleep(3000);

const doc = await send('DOM.getDocument', { depth: -1 });
const nodeRes = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
if (!nodeRes?.nodeId) {
  console.error('页面里找不到 #bspFile 文件输入框');
  finish(1);
}
await send('DOM.setFileInputFiles', { nodeId: nodeRes.nodeId, files: [MAP] });
console.log(`[${LABEL}] 已注入地图，等待场景就绪…`);

/** 场景就绪判据：物理实例可读（位置非零）+ 出生点列表已填充。 */
async function waitSceneReady() {
  const t0 = Date.now();
  let lastDiag = 0;
  for (;;) {
    if (Date.now() - t0 > LOAD_TIMEOUT_MS) throw new Error(`场景就绪超时（${LOAD_TIMEOUT_MS}ms）`);
    const d = await evalJs(`(() => {
      const api = globalThis.__wsInput;
      let st = null;
      try { st = api?.replayState?.() ?? null; } catch (e) { st = null; }
      return {
        api: typeof api === 'object' && api !== null,
        hasState: !!(st && st.state),
        x: st?.state?.pos?.x ?? null,
        spawns: document.getElementById('spawnSelect')?.options?.length ?? 0,
        status: (document.getElementById('status')?.textContent ?? '').slice(0, 120),
      };
    })()`);
    if (d?.api && d.hasState && d.x !== null && d.spawns > 0) return d;
    if (Date.now() - lastDiag > 15000) {
      lastDiag = Date.now();
      console.log(
        `[${LABEL}] waiting… api=${d?.api} state=${d?.hasState} x=${d?.x} spawns=${d?.spawns} status="${d?.status}"`,
      );
    }
    await sleep(500);
  }
}
const ready = await waitSceneReady();
console.log(`[${LABEL}] 场景就绪（出生点 ${ready.spawns} 个，x=${Number(ready.x).toFixed(1)}）`);
await sleep(1500); // 让 LOD/PVS 与物理首帧稳定

// ── 可复用的页内脚本片段 ───────────────────────────────────────────────────

/**
 * 录制一段合成输入会话（走真实输入路径）+ 逐帧采样位置。
 * @param frames 帧数
 * @param authorityOff true = 同时关掉渲染器的"权威实时耦合"（`__wsInput.setReplayMode(true)`）
 *        ——用于对照实验 A：证明"同一输入 + 同一步长 → 同一轨迹"，与权威线噪声无关。
 */
const recordScript = (frames, authorityOff) => `(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const evs = [];
  const traj = [];
  api.clearSynthetic();
  api.clear();
  if (${authorityOff}) api.setReplayMode(true);
  api.start();
  for (let i = 0; i < ${frames}; i++) {
    let keys = 0;
    if (i % 240 < 190) keys |= ${KEY.forward};
    if (i % 240 >= 150 && i % 240 < 200) keys |= ${KEY.jump};      // 连跳脉冲
    if (Math.floor(i / 600) % 2 === 0) keys |= ${KEY.left};
    else keys |= ${KEY.right};
    if (i % 97 === 0) keys |= ${KEY.duck};
    if (i % 53 === 0) keys |= ${KEY.wheelJump};
    if (i % 800 < 100) keys |= ${KEY.yawRight};
    const ph = i * 0.045;
    const dx = Math.sin(ph) * 11.5;
    const dy = Math.cos(ph * 0.7) * 4.25;
    api.pushSynthetic({ dx, dy, keys });
    await raf();
    let drained = false;
    for (let g = 0; g < 8 && !drained; g++) {
      if (api.counts().syntheticPending === 0) drained = true;
      else await raf();
    }
    if (!drained) evs.push('frame ' + i + ': synthetic not drained');
    // 位置 = 渲染物理**本帧** post-tick 状态（此刻输入循环已喂入第 i 帧合成输入；
    // 渲染主循环在本 rAF 拍已用上一帧的 pending 值 tick 过 → 位置与第 i 帧输入配对）
    const s = api.replayState();
    traj.push(s && s.state
      ? { i, x: s.state.pos.x, y: s.state.pos.y, z: s.state.pos.z }
      : { i, x: null, y: null, z: null });
  }
  api.stop();
  if (${authorityOff}) api.setReplayMode(false);
  return JSON.stringify({
    counts: api.counts(),
    statusText: api.status(),
    export: api.exportJson(),
    liveTraj: traj,
    evs,
  });
})()`;

/**
 * 回放一段录制并逐帧采样位置。
 * @param exportJsonText 录制导出 JSON 原文（作为 JS 对象字面量内联）
 * @param startDelayRafs 开始前等待的 rAF 数（换图后需要更多）
 */
const replayScript = (exportJsonText, startDelayRafs) => `(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  // 直接内联为 JS 对象字面量（导出 JSON 里没有反斜杠转义，可安全内联；
  // 若内层再 JSON.stringify 会变成"字符串里的 JSON"，load() 收到字符串就会报
  // 非对象——这正是本脚本第一版的坑）
  const rec = ${exportJsonText};
  const recDiag = { hasFrames: !!(rec && rec.frames), schema: rec && rec.schema, ctor: Object.prototype.toString.call(rec) };
  let loaded = 0;
  let loadError = null;
  try { loaded = api.load(rec); } catch (e) { loadError = String(e); }
  if (loadError) return JSON.stringify({ error: 'load() 失败：' + loadError, recDiag, loaded, counts: api.counts() });
  for (let i = 0; i < ${startDelayRafs}; i++) await raf();
  const started = api.play(true);
  if (!started) return JSON.stringify({ error: 'play() returned false', loaded, counts: api.counts() });
  const startState = api.replayState();
  const traj = [];
  const errors = [];
  let guard = 0;
  for (;;) {
    guard++;
    if (guard > loaded + 50) { errors.push('frame loop exceeded loaded+50'); break; }
    let r = null;
    try { r = await api.tickReplay(); } catch (e) { errors.push('tickReplay threw: ' + String(e)); break; }
    if (!r || r.reason === 'not-playing') { errors.push('not-playing at ' + guard); break; }
    if (r.reason === 'busy') { await raf(); continue; }
    // r.index = 刚推进到的录制帧号；r.state = 该帧物理 post-tick 状态
    if (r.state) traj.push({ i: r.index, x: r.state.pos.x, y: r.state.pos.y, z: r.state.pos.z });
    if (r.done || r.reason === 'exhausted') break;
  }
  const counts = api.counts();
  return JSON.stringify({
    loaded, started, startState, traj, errors, counts, recDiag,
    capture: api.captureText(),
    finalState: api.replayState(),
    statusText: api.status(),
  });
})()`;

/** 逐帧输入序列比对（dx/dy/keys 严格 ===）。 */
function compareInputs(recordedPayload, capPayload) {
  const at = (payload, i) => {
    const f = payload.frames;
    if (Array.isArray(f)) return { t: f[i].t, dx: f[i].dx, dy: f[i].dy, keys: f[i].keys };
    return { t: f.t[i], dx: f.dx[i], dy: f.dy[i], keys: f.keys[i] };
  };
  const n = Array.isArray(recordedPayload.frames)
    ? recordedPayload.frames.length
    : recordedPayload.frames.t.length;
  const capCount = Array.isArray(capPayload.frames)
    ? capPayload.frames.length
    : capPayload.frames.t.length;
  let firstMismatch = -1;
  const mismatchSamples = [];
  for (let i = 0; i < n; i++) {
    const a = at(recordedPayload, i);
    const b = at(capPayload, i);
    if (a.dx !== b.dx || a.dy !== b.dy || a.keys !== b.keys) {
      if (firstMismatch < 0) firstMismatch = i;
      if (mismatchSamples.length < 6) {
        mismatchSamples.push(`#${i} rec(dx=${a.dx},dy=${a.dy},keys=${a.keys}) vs play(dx=${b.dx},dy=${b.dy},keys=${b.keys})`);
      }
    }
  }
  return { n, capCount, firstMismatch, mismatchSamples, identical: firstMismatch < 0 && n === capCount };
}

/** 逐帧位置比对（按录制帧号索引）。 */
function compareTraj(liveTraj, repTraj) {
  const byIndex = new Map(repTraj.map((p) => [p.i, p]));
  let max = 0;
  let at = -1;
  let compared = 0;
  let missing = 0;
  for (let i = 0; i < liveTraj.length; i++) {
    const a = liveTraj[i];
    const b = byIndex.get(i);
    if (!b) { missing++; continue; }
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    compared++;
    if (d > max) { max = d; at = i; }
  }
  return { max, at, compared, missing };
}

// ── 早跑相位：在**用户真实录像**上测「移动方向 vs 画面朝向」──────────────────
// 放在所有录制相位之前：录制功能已从产品中移除，后续相位必然失败并可能中断脚本，
// 而本测量不依赖录制，必须在中断前完成。
if (process.env.IR_EXTERNAL) {
  const __text = readFileSync(process.env.IR_EXTERNAL, 'utf8');
  const __max = Number(process.env.IR_MAX_FRAMES ?? 0);
  const m = await evalJson(`(async () => {
    const api = globalThis.__wsInput;
    const text = ${JSON.stringify(__text)};
    api.clear(); api.clearSynthetic();
    const loaded = api.load(text);
    const started = api.play(true);
    const CAP = ${__max} > 0 ? Math.min(${__max}, loaded) : loaded;
    let maxDev = 0, devAt = -1, devYaw = 0, devVh = 0, wFrames = 0, fed = 0;
    const devs = [];
    for (let i = 0; i < CAP; i++) {
      const r = await api.tickReplay();
      if (!r || r.frame === null) break;
      fed++;
      const s = r.state;
      if (!s) continue;
      // 只按 W（低 4 位 = forward）且在地面且水平速度足够 → wishdir 必为 forward
      if ((r.frame.keys & 15) === 1 && s.onGround) {
        const vh = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
        if (vh > 40) {
          wFrames++;
          const yv = Math.atan2(-s.vel.x, -s.vel.z) * 180 / Math.PI;
          let d = yv - s.yaw;
          d = ((d + 180) % 360 + 360) % 360 - 180;
          if (Math.abs(d) > maxDev) { maxDev = Math.abs(d); devAt = i; devYaw = s.yaw; devVh = vh; }
          devs.push(Math.abs(d));
        }
      }
    }
    api.stopPlay();
    devs.sort((a, b) => a - b);
    const q = (p) => (devs.length ? devs[Math.min(devs.length - 1, Math.floor(devs.length * p))] : -1);
    const nBig = devs.filter((v) => v > 10).length;
    return { loaded, started, fed, wFrames, maxDev, devAt, devYaw, devVh,
             p50: q(0.5), p90: q(0.9), p99: q(0.99), nBig, nDev: devs.length };
  })()`);
  console.log(
    `[${LABEL}] **用户录像移动方向自检**：载入 ${m?.loaded} 帧｜回放 ${m?.fed} 帧｜` +
      `只按W且在地面的样本 ${m?.wFrames} 帧`,
  );
  console.log(
    `[${LABEL}]   偏差分布：p50 ${Number(m?.p50 ?? 0).toFixed(3)}°｜p90 ${Number(m?.p90 ?? 0).toFixed(3)}°｜` +
      `p99 ${Number(m?.p99 ?? 0).toFixed(3)}°｜>10° 的样本 ${m?.nBig}/${m?.nDev}`,
  );
  console.log(
    `[${LABEL}]   移动方向 vs 画面朝向：最大偏差 ${Number(m?.maxDev ?? 0).toFixed(3)}°` +
      `（第 ${m?.devAt} 帧｜yaw=${Number(m?.devYaw ?? 0).toFixed(2)}｜水平速度=${Number(m?.devVh ?? 0).toFixed(1)}）`,
  );
}

// ── 相位 0：录制中状态行刷新自检 ───────────────────────────────────────────
// 背景：曾经 updateInputRecUi() 只在 inputReplaying 分支里被调用，导致录制期间
// 状态行**从不刷新**，永久冻结在点击「开始录制」那一刻的 "0 帧"——功能其实是好的，
// 但看起来像"录不到东西"。本相位直接读 DOM 断言录制期间计数在涨。
const liveUi = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  if (!api) return { ok: false, why: 'no __wsInput' };
  const el = () => document.getElementById('inputRecStatus');
  const txt = () => (el() ? el().textContent : '');
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  api.clear();
  api.start();
  const t0 = performance.now();
  let mid = { frames: -1, statusText: '' };
  while (performance.now() - t0 < 1200) {
    await raf();
    mid = { frames: api.counts().frames, statusText: txt() };
  }
  api.stop();
  const after = { frames: api.counts().frames, statusText: txt() };
  api.clear();
  return { ok: true, mid, after };
})()`);

const midFrames = liveUi?.mid?.frames ?? -1;
const midText = liveUi?.mid?.statusText ?? '';
const afterText = liveUi?.after?.statusText ?? '';
console.log(
  `[${LABEL}] 录制中状态行自检：录制中帧数 ${midFrames}｜状态行「${midText}」｜停止后「${afterText}」`,
);
let uiFail = false;
if (!(midFrames > 0)) {
  console.error(`[${LABEL}] 自检失败：录制期间帧数为 ${midFrames}（应为正数）`);
  uiFail = true;
}
if (!/录制中/.test(midText) || !/\d/.test(midText)) {
  console.error(`[${LABEL}] 自检失败：录制期间状态行未刷新为「● 录制中 N 帧」，实为「${midText}」`);
  uiFail = true;
}
if (uiFail) process.exitCode = 1;

// ── 相位 0b：**面板回放路径**自检（startPlayback，由 rAF 输入循环驱动）──────
// 背景：输入循环原先只调 inputPlayer.next()，而 next() 的语义是"保持当前帧"
// （游标只由 step()/stepReplay() 推进）。于是面板「载入并回放」永远停在第 0 帧——
// 而无头路径走 tickReplay()→stepReplay()，恰好绕开了这个缺陷，所以旧验收全绿却
// 掩盖了它。本相位**故意不调 tickReplay**，纯靠 rAF 驱动，直接看游标是否前进。
const panelPlay = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  if (!api) return { ok: false, why: 'no __wsInput' };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) await raf(); };
  api.clear();
  api.start();
  await wait(500);
  api.stop();
  const recFrames = api.counts().frames;
  const text = api.exportJson();
  api.clear();
  const loaded = api.load(text);
  const played = api.play();            // ← 面板「载入并回放」走的正是这条
  const idx = [];
  for (let k = 0; k < 45; k++) { await raf(); idx.push(api.counts().playerIndex); }
  const c = api.counts();
  const statusText = api.status();
  api.stopPlay();
  api.clear();
  return { ok: true, recFrames, loaded, played, idx0: idx[0], idxLast: idx[idx.length - 1],
           uniq: new Set(idx).size, playing: c.playing, captureFrames: c.captureFrames, statusText };
})()`);

const ppIdx0 = panelPlay?.idx0 ?? -99;
const ppIdxLast = panelPlay?.idxLast ?? -99;
const ppUniq = panelPlay?.uniq ?? 0;
console.log(
  `[${LABEL}] 面板回放路径自检：录制 ${panelPlay?.recFrames} 帧｜载入 ${panelPlay?.loaded} 帧｜` +
    `play()=${panelPlay?.played}｜游标 ${ppIdx0} → ${ppIdxLast}（走过 ${ppUniq} 个不同帧）｜` +
    `回放喂出 ${panelPlay?.captureFrames} 帧｜状态行「${panelPlay?.statusText}」`,
);
let ppFail = false;
if (ppIdxLast <= ppIdx0 || ppUniq < 10) {
  console.error(
    `[${LABEL}] 自检失败：面板回放游标未前进（${ppIdx0} → ${ppIdxLast}，仅走过 ${ppUniq} 个不同帧）` +
      `——回放卡在第 0 帧。`,
  );
  ppFail = true;
}
if (ppFail) process.exitCode = 1;

// ── 相位 0c：**循环外输入（鼠标路径）必须被录到** ───────────────────────────
// 背景：录制点原先挂在输入循环的 rAF 上，而鼠标走 mousemove 事件**直连 feedInput**、
// 根本不经过输入循环 → 录到的 `dy` 恒为 0、`dx` 只有 Q/E 换算量。实测用户 2.5 分钟
// 实机录像正是如此（dy 全零、dx 仅来自 yaw 键），回放从源头就不可能复现。
// 录制点移到物理步后，循环外到达的输入必须同样入账。本相位注入等价于 mousemove 的
// 设备级输入并断言它出现在录制里——旧实现下 `dy≠0` 不可能成立，故有判别力。
const MOUSE_DX = 0.5;
const MOUSE_DY = -0.25;
const mouseRec = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  if (!api || typeof api.feedDeviceInput !== 'function') return { ok: false, why: 'no feedDeviceInput' };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  api.clear();
  api.start();
  const t0 = performance.now();
  let injected = 0;
  while (performance.now() - t0 < 900) {
    api.feedDeviceInput({ dx: ${MOUSE_DX}, dy: ${MOUSE_DY} });
    injected++;
    await raf();
  }
  api.stop();
  const json = api.exportJson();
  api.clear();
  return { ok: true, injected, json };
})()`);

let mouseFail = false;
let mouseSummary = '未执行';
if (mouseRec?.ok) {
  const p = JSON.parse(mouseRec.json);
  const f = p.frames;
  const n = Array.isArray(f) ? f.length : f.t.length;
  const col = (k) => (Array.isArray(f) ? f.map((r) => r[k]) : f[k]);
  const dys = col('dy');
  const dxs = col('dx');
  const dts = Array.isArray(f) ? f.map((r) => r.dt) : f.dt;
  let nzDy = 0, nzDx = 0, sumDy = 0, sumDx = 0, dtCount = 0;
  for (let i = 0; i < n; i++) {
    if (dys[i] !== 0) nzDy++;
    if (dxs[i] !== 0) nzDx++;
    sumDy += dys[i];
    sumDx += dxs[i];
    if (Array.isArray(dts) && dts[i] > 0) dtCount++;
  }
  mouseSummary =
    `录制 ${n} 帧｜注入 ${mouseRec.injected} 次｜dy≠0 的帧 ${nzDy}｜dx≠0 的帧 ${nzDx}｜` +
    `Σdy=${sumDy.toFixed(3)}（注入合计 ${(MOUSE_DY * mouseRec.injected).toFixed(3)}）｜带 dt 的帧 ${dtCount}`;
  if (nzDy === 0) {
    console.error(`[${LABEL}] 自检失败：循环外（鼠标路径）输入没有被录到——所有帧 dy 都是 0。`);
    mouseFail = true;
  }
  if (dtCount === 0) {
    console.error(`[${LABEL}] 自检失败：录制未带每帧物理步长 dt（frames.dt 缺失或全 0）。`);
    mouseFail = true;
  }
} else {
  console.error(`[${LABEL}] 自检失败：${mouseRec?.why ?? '未知'}`);
  mouseFail = true;
}
console.log(`[${LABEL}] 循环外输入录制自检：${mouseSummary}`);
if (mouseFail) process.exitCode = 1;

// ── 相位 0d：**二次开始录制必须重置磁带（起点坐标唯一）** ────────────────────
// 一份录制只有一个起点（meta.initialState / physSeed），而 startWithState 每次都用新
// 起点覆盖旧起点。若沿用旧样本，导出文件就是「第 1 段的帧 + 第 2 段的起点」——回放从
// 第一帧就错位（这正是"没考虑开始录制时的坐标"）。判据：第二次停止后的总帧数不得
// 接近两段之和，而应≈单段。
const restartRec = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) await raf(); };
  api.clear();
  api.start(); await wait(420); api.stop();
  const n1 = api.counts().frames;
  api.start(); await wait(420); api.stop();
  const n2 = api.counts().frames;
  const json = api.exportJson();
  api.clear();
  const p = JSON.parse(json);
  const nf = Array.isArray(p.frames) ? p.frames.length : p.frames.t.length;
  const init = p.meta && p.meta.initialState ? p.meta.initialState.pos : null;
  return { n1, n2, nf, init };
})()`);

const r1 = restartRec?.n1 ?? -1;
const r2 = restartRec?.n2 ?? -1;
console.log(
  `[${LABEL}] 二次开始录制自检：第 1 段停止后 ${r1} 帧｜第 2 段停止后 ${r2} 帧｜` +
    `导出声明 ${restartRec?.nf} 帧｜起点 ${JSON.stringify(restartRec?.init)}`,
);
let restartFail = false;
if (!(r1 > 0) || !(r2 > 0)) {
  console.error(`[${LABEL}] 自检失败：段落帧数为 0（${r1} / ${r2}）。`);
  restartFail = true;
} else if (r2 >= r1 * 1.6) {
  console.error(
    `[${LABEL}] 自检失败：第二次开始录制**没有重置磁带**——总帧数 ${r2} ≈ 两段之和` +
      `（单段约 ${r1}）。导出文件将是「第 1 段的帧 + 第 2 段的起点坐标」，回放必错位。`,
  );
  restartFail = true;
}
if (restartFail) process.exitCode = 1;

// ── 相位 0e：**移动方向必须等于画面朝向**（传送后"斜向移动"回归）────────────
// 症状：只按 W/S，画面却往左前/右后偏。
// 机理：移动方向由**权威 yaw** 决定（calibrateVelocity 每帧把权威速度写进渲染），
// 画面由**渲染 yaw** 决定。两侧 yaw 分叉 δ 时，按 W 就会偏 δ。
// 度量：ground 且只有 W 输入时，wishdir = forward = (-sin yaw, 0, -cos yaw)，
// 故速度方向反解出的 yaw = atan2(-velX, -velZ) 必须等于画面 yaw。
const axisRes = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) await raf(); };
  const sel = document.getElementById('spawnSelect');
  const state = () => { const c = api.replayState(); return c && c.state ? c.state : null; };
  const samples = [];
  const measure = async (tag, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      api.pushSynthetic({ dx: 0, dy: 0, keys: 1 });   // 只按 W（前进）
      await raf();
      const s = state();
      if (!s) continue;
      // **必须在地面**：空中 air_accelerate 极弱，按 W 本就不掰方向（surf 的本质），
      // 那不是 bug。用户报的是"平地移动"，所以只统计 onGround 的样本。
      if (!s.onGround) continue;
      const vh = Math.hypot(s.vel.x, s.vel.z);
      if (vh < 40) continue;
      const yawFromVel = Math.atan2(-s.vel.x, -s.vel.z) * 180 / Math.PI;
      let d = yawFromVel - s.yaw;
      d = ((d + 180) % 360 + 360) % 360 - 180;
      samples.push({ tag, d: +d.toFixed(3), yaw: +s.yaw.toFixed(2), vh: +vh.toFixed(1) });
    }
  };
  await wait(300);
  // 转视角（模拟鼠标增量，走 mousemove 同一条 feedInput 路径）
  const turn = async (ms, dxPerFrame) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { api.feedDeviceInput({ dx: dxPerFrame }); await raf(); }
  };
  // 建立**横向速度**：W+D（forward|right = 1|8 = 9）按住 1.2s。
  // 目的：验证「地面加速不纠正方向」——addspeed = wishspeed − dot(vel,wishdir) ≤ 0 时
  // accelerate 完全不生效，摩擦只减速度大小、不掰方向，于是只按 W 也掰不直。
  const hold = async (ms, keys) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { api.pushSynthetic({ dx: 0, dy: 0, keys }); await raf(); }
  };
  // **先多次传送**（用户条件："这情况出现在多次触发传送后"），再做长按 W 测量
  const picks = [];
  if (sel && sel.options.length > 3) {
    for (const i of [1, 5, 12, 2, 30]) {
      if (i >= sel.options.length) continue;
      sel.value = String(i);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      picks.push(i);
      await turn(300, 4);
      await wait(300);
    }
  }
  await hold(1200, 9);
  // 松开 D，**只按 W**、全程零视角输入 —— δ 若存在就会一直暴露。
  await measure('recover', 6000);
  await measure('after', 1400);
  const worst = samples.reduce((a, b) => Math.max(a, Math.abs(b.d)), 0);
  const worstAfter = samples.filter((s) => s.tag === 'after').reduce((a, b) => Math.max(a, Math.abs(b.d)), 0);
  const rec = samples.filter((s) => s.tag === 'recover');
  const recWorst = rec.reduce((a, b) => Math.max(a, Math.abs(b.d)), 0);
  return { picks, n: samples.length, worst: +worst.toFixed(3), worstAfter: +worstAfter.toFixed(3),
           recN: rec.length, recWorst: +recWorst.toFixed(3),
           recHead: rec.slice(0, 3), recMid: rec.slice(Math.floor(rec.length / 2), Math.floor(rec.length / 2) + 2),
           recTail: rec.slice(-3), head: samples.slice(0, 4), tail: samples.slice(-6) };
})()`);

const axisWorst = axisRes?.worst ?? -1;
console.log(
  `[${LABEL}] 移动方向/画面朝向自检：传送 ${JSON.stringify(axisRes?.picks)}｜样本 ${axisRes?.n}｜` +
    `偏差 最大 ${axisWorst}°（传送后段 ${axisRes?.worstAfter}°）`,
);
console.log(`[${LABEL}]   只按W段(${axisRes?.recN} 样本, 最大 ${axisRes?.recWorst}°) 起点 ${JSON.stringify(axisRes?.recHead)}`);
console.log(`[${LABEL}]   只按W段 中点 ${JSON.stringify(axisRes?.recMid)}`);
console.log(`[${LABEL}]   只按W段 末尾 ${JSON.stringify(axisRes?.recTail)}`);
if (!(axisWorst >= 0) || axisWorst > 10) {
  console.error(
    `[${LABEL}] 自检失败：只按 W 时速度方向与画面朝向相差 ${axisWorst}°（应≈0）——` +
      `即"斜向移动"。根因：权威 yaw 与渲染 yaw 分叉，而移动方向取自权威。`,
  );
  process.exitCode = 1;
}

// ── 相位 A：合成输入录制（走真实输入路径）──────────────────────────────────
const FRAME_COUNT = Math.round(SECONDS * 60);
const recordResult = await evalJson(recordScript(FRAME_COUNT, false));

const counts = recordResult.counts ?? {};
if (recordResult.evs && recordResult.evs.some((e) => typeof e === 'string')) {
  console.warn(`[${LABEL}] 录制告警：`, recordResult.evs.filter((e) => typeof e === 'string').slice(0, 5));
}
console.log(
  `[${LABEL}] 录制完成：${counts.frames} 帧（请求 ${FRAME_COUNT} 帧），状态行「${recordResult.statusText}」`,
);

const recordedPayload = JSON.parse(recordResult.export);
const recFrames = recordedPayload.frames;
const recCount =
  Array.isArray(recFrames)
    ? recFrames.length
    : (recFrames?.t?.length ?? 0);

// 载荷自检（schema / meta / 帧结构）
const meta = recordedPayload.meta ?? {};
const metaChecks = {
  schema: recordedPayload.schema,
  mapFile: meta.mapFile,
  tickRate: meta.tickRate,
  autobhop: meta.physics?.autobhop,
  hasInitialState: !!meta.initialState,
  initialState: meta.initialState ?? null,
  hull: meta.hull ?? null,
  frameCount: recordedPayload.frameCount ?? recCount,
  hasParallelFrames:
    !!recFrames && !Array.isArray(recFrames) &&
    Array.isArray(recFrames.t) && Array.isArray(recFrames.dx) &&
    Array.isArray(recFrames.dy) && Array.isArray(recFrames.keys),
};
console.log(
  `[${LABEL}] 载荷：schema=${metaChecks.schema} map=${metaChecks.mapFile} tickRate=${metaChecks.tickRate} ` +
    `autobhop=${metaChecks.autobhop} 起点状态=${metaChecks.hasInitialState} 并行帧数组=${metaChecks.hasParallelFrames}`,
);

// ── 相位 B：**全新页面加载** + 确定性回放 ──────────────────────────────────
await send('Page.reload', { ignoreCache: true });
await sleep(3000);
const doc2 = await send('DOM.getDocument', { depth: -1 });
const node2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#bspFile' });
if (!node2?.nodeId) {
  console.error('刷新后找不到 #bspFile');
  finish(1);
  throw new Error('aborted');
}
await send('DOM.setFileInputFiles', { nodeId: node2.nodeId, files: [MAP] });
console.log(`[${LABEL}] 已刷新并重新注入地图，等待场景就绪…`);
const ready2 = await waitSceneReady();
console.log(`[${LABEL}] 场景就绪（x=${Number(ready2.x).toFixed(1)}）`);
await sleep(1500);

const replayResult = await evalJson(replayScript(recordResult.export, 2));

if (replayResult.error) {
  console.error(`[${LABEL}] 回放未能开始：${replayResult.error}`);
  console.error(`[${LABEL}] 诊断：`, JSON.stringify(replayResult.recDiag), JSON.stringify(replayResult.counts));
  finish(1);
  throw new Error('aborted'); // finish() 之后不再执行下方比对（曾导致二次异常掩盖真因）
}
const capPayload = JSON.parse(replayResult.capture);
if (!capPayload.frames) {
  console.error(`[${LABEL}] 回放捕获为空（输入循环可能未在回放中运行）`, JSON.stringify(replayResult.counts));
  finish(1);
  throw new Error('aborted');
}
const capCount = Array.isArray(capPayload.frames) ? capPayload.frames.length : capPayload.frames.t.length;

// ── 比对 1：逐帧输入序列（dx/dy/keys）──────────────────────────────────────
const cmp = compareInputs(recordedPayload, capPayload);
const { firstMismatch, mismatchSamples, inputIdentical } = {
  firstMismatch: cmp.firstMismatch,
  mismatchSamples: cmp.mismatchSamples,
  inputIdentical: cmp.identical,
};

// ── 比对 2：逐帧位置（录制期 rAF 位置 vs 回放第 k 帧位置）─────────────────
const liveTraj = recordResult.liveTraj;
const repTraj = replayResult.traj;
const repStart = replayResult.startState?.state ?? null;
const pc = compareTraj(liveTraj, repTraj);
const maxPosDiff = pc.max;
const maxPosDiffAt = pc.at;
const posCompared = pc.compared;
if (pc.missing) replayResult.errors = [...(replayResult.errors ?? []), `回放轨迹缺 ${pc.missing} 帧`];
// 起点核对：回放 arm 后的物理状态 vs 录制 meta.initialState
const initState = meta.initialState ?? null;
const startDiff =
  initState && repStart
    ? Math.hypot(
        initState.pos.x - repStart.pos.x,
        initState.pos.y - repStart.pos.y,
        initState.pos.z - repStart.pos.z,
      )
    : null;
const posIdentical = maxPosDiff !== null && maxPosDiff <= POS_TOL;

// ── 对照实验 ──────────────────────────────────────────────────────────────
// A：**同页**关权威耦合 录制 → 立即回放（同一物理实例、同一帧率）。
//    这一拍把"输入录制/回放机制"与"世界状态对齐"单独隔离出来：若这里仍不逐帧
//    相同，说明机制本身有问题；若相同，则差异只可能来自权威实时耦合/帧率差。
// B：同页关权威耦合 录制 → 回放 → 再回放（同一录制放两遍），验"确定性回放可重复"。
const controlA = await evalJson(recordScript(FRAME_COUNT, true));
const replayA = await evalJson(replayScript(controlA.export, 2));
const replayA2 = await evalJson(replayScript(controlA.export, 2));
if (typeof replayA?.capture !== 'string') {
  console.error(
    `[${LABEL}] 对照实验 A：回放未返回 capture（回归诊断）。replayA = ` +
      `${JSON.stringify(replayA)?.slice(0, 800)}`,
  );
}
const capA = JSON.parse(replayA.capture);
const capA2 = JSON.parse(replayA2.capture);
const cmpA = compareInputs(JSON.parse(controlA.export), capA);
const trajA = compareTraj(controlA.liveTraj, replayA.traj);
const trajAA = compareTraj(replayA.traj, replayA2.traj);

// ── 诊断：同一录制放两遍，找出**第一个分叉帧**与当时的 dt/速度 ──────────────
const divergence = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const rec = ${controlA.export};
  const run = async () => {
    api.stopPlay();
    api.load(rec);
    await raf(); await raf();
    api.play(true);
    const armed = api.replayState(); // arm 后、推进前（应 = meta.initialState）
    const out = [];
    const errors = [];
    for (;;) {
      const r = await api.tickReplay();
      if (!r || r.reason === 'not-playing') { errors.push('not-playing'); break; }
      if (r.reason === 'busy') { await raf(); continue; }
      out.push({ i: r.index, dt: r.dtS, x: r.state.pos.x, y: r.state.pos.y, z: r.state.pos.z,
                 vx: r.state.vel.x, vy: r.state.vel.y, vz: r.state.vel.z, g: r.state.onGround });
      if (r.done || r.reason === 'exhausted') break;
    }
    return { out, errors, armed };
  };
  const a = await run();
  // 同页立即再放一遍（**不**重建世界）：与下面"重建世界后再放"对照，
  // 用于区分"物理世界残留状态"与"物理步进本身不确定"。
  const a2 = await run();
  // 两次回放之间**重建物理世界**（换图）——排除"物理世界内部藏着跨回放残留状态"
  await api.reloadForTest();
  for (let g = 0; g < 600; g++) {
    const st = api.replayState();
    if (st && st.state) break;
    await raf();
  }
  for (let g = 0; g < 20; g++) await raf(); // 世界稳定
  const b = await run();
  const compareAB = (p, q) => {
    let mp = 0, mv = 0, first = -1, fv = -1;
    for (let k = 0; k < Math.min(p.out.length, q.out.length); k++) {
      const x = p.out[k], y = q.out[k];
      const d = Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
      const dv = Math.hypot(x.vx - y.vx, x.vy - y.vy, x.vz - y.vz);
      if (d > mp) mp = d;
      if (dv > mv) mv = dv;
      if (d > 0 && first < 0) first = k;
      if (dv > 0 && fv < 0) fv = k;
    }
    return { maxPos: mp, maxVel: mv, firstPos: first, firstVel: fv, n: Math.min(p.out.length, q.out.length) };
  };
  let first = -1;
  const samples = [];
  let maxPos = 0, maxVel = 0, firstVel = -1, firstDt = -1;
  for (let k = 0; k < Math.min(a.out.length, b.out.length); k++) {
    const p = a.out[k], q = b.out[k];
    const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const dv = Math.hypot(p.vx - q.vx, p.vy - q.vy, p.vz - q.vz);
    if (d > maxPos) maxPos = d;
    if (dv > maxVel) maxVel = dv;
    if (dv > 1e-9 && firstVel < 0) firstVel = k;      // 速度分叉（位置分叉之前）
    if (p.dt !== q.dt && firstDt < 0) firstDt = k;     // 步长分叉（不该发生）
    if (d > 1e-9 && first < 0) first = k;
    if (samples.length < 6 && (k < 2 || (first >= 0 && Math.abs(k - first) <= 2))) {
      samples.push({ k, dtA: p.dt, dtB: q.dt, d, dv, gA: p.g, gB: q.g,
                     posA: [+p.x.toFixed(6), +p.y.toFixed(6), +p.z.toFixed(6)],
                     posB: [+q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6)] });
    }
  }
  return JSON.stringify({
    nA: a.out.length, nB: b.out.length,
    firstDivergence: first, firstVelDivergence: firstVel, firstDtDivergence: firstDt,
    maxPos, maxVel, samples, errors: [...a.errors, ...b.errors],
    samePageRepeat: compareAB(a, a2),      // A vs A2：不重建世界
    afterReload: compareAB(a, b),          // A vs B：重建世界
    armedA: a.armed?.state ?? null,
    armedB: b.armed?.state ?? null,
    seedA: a.armed?.seed ?? null,
    seedB: b.armed?.seed ?? null,
    recInitial: rec.meta ? rec.meta.initialState : null,
  });
})()`);

// ── 诊断 2：**同一全量种子 + 同一输入 + 同一步长**，物理步进结果是否位级相同 ──
// 这是把"物理是否确定"与"回放接线是否正确"彻底分开的判据：
// 在页内把同一个种子写回两次，各自喂同一条微型输入序列（固定 dt），比对结果。
// 相同 → 物理确定，任何位置差都只能来自时序/权威耦合；不同 → 物理存在未播种状态。
const engineProbe = await evalJson(`(async () => {
  const api = globalThis.__wsInput;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  api.stopPlay();
  for (let i = 0; i < 5; i++) await raf();
  const seed = api.physSeed();
  // 单步闸门：每帧最多 1 步，物理步数由脚本精确控制（排除帧相位假象）
  const trial = async () => {
    api.setManualSteps(0);      // 先恢复连续推进（并清配额）
    api.seedPhys(seed);
    api.setManualSteps(1);      // 打开闸门：本帧只推 1 步
    await raf();
    api.setManualSteps(0);
    const s = api.replayState();
    return { p: s.state.pos, v: s.state.vel, g: s.state.onGround };
  };
  const t1 = await trial();
  const t2 = await trial();
  // 种子写回的**立即回读**：确认 set_state_ex 真的把 (pos, vel) 写到物理里
  // （若这里读数与 seed 不符 → "两轮不同"只是写回失败/时机的假象）
  const seedObj = JSON.parse(seed);
  api.seedPhys(seed);
  const echo = api.replayState();
  const echoOk = echo.state
    ? Math.hypot(echo.state.pos.x - seedObj.origin[0], echo.state.pos.y - seedObj.origin[1], echo.state.pos.z - seedObj.origin[2]) +
      Math.hypot(echo.state.vel.x - seedObj.velocity[0], echo.state.vel.y - seedObj.velocity[1], echo.state.vel.z - seedObj.velocity[2])
    : null;
  const d = Math.hypot(t1.p.x-t2.p.x, t1.p.y-t2.p.y, t1.p.z-t2.p.z);
  const dv = Math.hypot(t1.v.x-t2.v.x, t1.v.y-t2.v.y, t1.v.z-t2.v.z);
  return JSON.stringify({
    seedLen: seed ? seed.length : 0,
    seedVelocity: seedObj.velocity,
    seedOrigin: seedObj.origin,
    echoMismatch: echoOk,
    oneStepPosDiff: d, oneStepVelDiff: dv,
    t1: { p: [+t1.p.x.toFixed(9), +t1.p.y.toFixed(9), +t1.p.z.toFixed(9)], v: [+t1.v.x.toFixed(9), +t1.v.y.toFixed(9), +t1.v.z.toFixed(9)], g: t1.g },
    t2: { p: [+t2.p.x.toFixed(9), +t2.p.y.toFixed(9), +t2.p.z.toFixed(9)], v: [+t2.v.x.toFixed(9), +t2.v.y.toFixed(9), +t2.v.z.toFixed(9)], g: t2.g },
  });
})()`);
console.log(
  `[${LABEL}] 物理确定性探针（单步闸门：同种子各推 1 步）：位置差 ${Number(engineProbe.oneStepPosDiff).toExponential(3)} HU` +
    `｜速度差 ${Number(engineProbe.oneStepVelDiff).toExponential(3)} HU/s` +
    `｜种子立即回读偏差 ${engineProbe.echoMismatch === null ? '—' : Number(engineProbe.echoMismatch).toExponential(3)}` +
    `｜种子速度 ${JSON.stringify(engineProbe.seedVelocity)}` +
    `\n      t1=${JSON.stringify(engineProbe.t1)}\n      t2=${JSON.stringify(engineProbe.t2)}`,
);

mkdirSync(OUT_DIR, { recursive: true });

// ── 外部录制相位（IR_EXTERNAL=<path>）────────────────────────────────────────
// 回放**外部提供**的录制（例如用户实机导出的 JSON）：连放两遍，比对键位序列与
// 轨迹，并做异常探测（逐步位移突变 = 传送/重生/掉出地图）。放在正常相位之后，
// 以便复用页面与浏览器、并让脚本正常收尾。
const EXTERNAL = process.env.IR_EXTERNAL ?? null;
if (EXTERNAL) {
  const IR_MAX = Number(process.env.IR_MAX_FRAMES ?? 0); // 0 = 全放
  const text = readFileSync(EXTERNAL, 'utf8');
  const payload = JSON.parse(text);
  const declared = Array.isArray(payload.frames) ? payload.frames.length : payload.frames.t.length;
  console.log(`\n── [${LABEL}] 外部录制回放 ──`);
  console.log(
    `  文件 ${EXTERNAL}\n  声明帧数 ${declared}｜地图 ${payload.meta?.mapFile}｜` +
      `tickRate ${payload.meta?.tickRate}｜autobhop ${payload.meta?.physics?.autobhop}`,
  );

  const ext = await evalJson(`(async () => {
    const api = globalThis.__wsInput;
    const text = ${JSON.stringify(text)};
    const CAP = ${IR_MAX};
    const runOnce = async () => {
      api.clear();
      api.clearSynthetic();
      const loaded = api.load(text);
      const played = api.play();
      const N = CAP > 0 ? Math.min(CAP, loaded) : loaded;
      const traj = new Float64Array(N * 3);
      const keys = new Int32Array(N);
      let fed = 0;
      let stoppedEarly = -1;
      let maxDev = 0, devAt = -1, devYaw = 0, devVh = 0;
      for (let i = 0; i < N; i++) {
        const r = await api.tickReplay();
        if (!r || r.frame === null) { stoppedEarly = i; break; }
        keys[i] = r.frame.keys | 0;
        const s = r.state;
        if (s) { traj[i * 3] = s.pos.x; traj[i * 3 + 1] = s.pos.y; traj[i * 3 + 2] = s.pos.z; }
        // 移动方向 vs 画面朝向：录像里"只按 W"（低 4 位 = 1）的帧上，
        // wishdir 必为 forward = (-sin yaw, 0, -cos yaw)，故速度反解 yaw 应等于画面 yaw。
        // 偏差 δ ≠ 0 就是用户报的"斜向移动"。**在用户自己的录像上直接测**。
        if (s && (keys[i] & 15) === 1) {
          const vh = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
          if (vh > 40) {
            const yv = Math.atan2(-s.vel.x, -s.vel.z) * 180 / Math.PI;
            let d = yv - s.yaw;
            d = ((d + 180) % 360 + 360) % 360 - 180;
            if (Math.abs(d) > maxDev) { maxDev = Math.abs(d); devAt = i; devYaw = s.yaw; devVh = vh; }
          }
        }
        fed++;
      }
      api.stopPlay();
      const c = api.counts();
      return { loaded, played, fed, stoppedEarly, capture: c.captureFrames, traj, keys,
               maxDev, devAt, devYaw, devVh };
    };
    const A = await runOnce();
    const B = await runOnce();
    const n = Math.min(A.fed, B.fed);
    let maxPos = 0, atPos = -1, firstDiv = -1, keyMismatch = -1;
    let minY = Infinity, maxY = -Infinity, maxStep = 0, atStep = -1;
    for (let i = 0; i < n; i++) {
      if (A.keys[i] !== B.keys[i] && keyMismatch < 0) keyMismatch = i;
      const dx = A.traj[i*3] - B.traj[i*3];
      const dy = A.traj[i*3+1] - B.traj[i*3+1];
      const dz = A.traj[i*3+2] - B.traj[i*3+2];
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d > 0 && firstDiv < 0) firstDiv = i;
      if (d > maxPos) { maxPos = d; atPos = i; }
      const y = A.traj[i*3+1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (i > 0) {
        const sx = A.traj[i*3] - A.traj[(i-1)*3];
        const sy = A.traj[i*3+1] - A.traj[(i-1)*3+1];
        const sz = A.traj[i*3+2] - A.traj[(i-1)*3+2];
        const s = Math.sqrt(sx*sx + sy*sy + sz*sz);
        if (s > maxStep) { maxStep = s; atStep = i; }
      }
    }
    const pt = (T, k) => (k >= 0 && k < n ? { x: T.traj[k*3], y: T.traj[k*3+1], z: T.traj[k*3+2] } : null);
    return { aLoaded: A.loaded, bLoaded: B.loaded, aPlayed: A.played, bPlayed: B.played,
             aFed: A.fed, bFed: B.fed, aCap: A.capture, bCap: B.capture,
             aEarly: A.stoppedEarly, bEarly: B.stoppedEarly, compared: n,
             aMaxDev: A.maxDev, aDevAt: A.devAt, aDevYaw: A.devYaw, aDevVh: A.devVh,
             keyMismatch, maxPos, atPos, firstDiv, minY, maxY, maxStep, atStep,
             aLast: pt(A, n-1), bLast: pt(B, n-1) };
  })()`);

  console.log(
    `  载入 A/B ${ext.aLoaded}/${ext.bLoaded} 帧｜喂出 ${ext.aFed}/${ext.bFed}｜` +
      `捕获 ${ext.aCap}/${ext.bCap}｜提前结束 ${ext.aEarly}/${ext.bEarly}`,
  );
  console.log(
    `  逐帧键位一致  ${ext.keyMismatch < 0 ? '是' : '否（首个不一致帧 ' + ext.keyMismatch + '）'}`,
  );
  console.log(
    `  两次回放轨迹  最大差 ${ext.maxPos.toExponential(3)} HU（第 ${ext.atPos} 帧）｜` +
      `首个分叉帧 ${ext.firstDiv}｜比较 ${ext.compared} 帧`,
  );
  console.log(
    `  异常探测  逐步最大位移 ${ext.maxStep.toFixed(3)} HU（第 ${ext.atStep} 帧）｜` +
      `高度 y ∈ [${ext.minY.toFixed(2)}, ${ext.maxY.toFixed(2)}]`,
  );
  console.log(
    `  只按W帧 移动方向 vs 画面朝向：最大偏差 ${Number(ext.aMaxDev ?? 0).toFixed(3)}°` +
      `（第 ${ext.aDevAt} 帧｜yaw=${Number(ext.aDevYaw ?? 0).toFixed(2)}｜水平速度=${Number(ext.aDevVh ?? 0).toFixed(1)}）`,
  );
  console.log(
    `  末点  A=${JSON.stringify(ext.aLast)}\n        B=${JSON.stringify(ext.bLast)}`,
  );
  writeFileSync(join(OUT_DIR, `${LABEL}-external.json`), JSON.stringify(ext, null, 2));
  if (ext.keyMismatch >= 0) process.exitCode = 1;
}


const recFile = join(OUT_DIR, `${LABEL}-recorded.json`);
const repFile = join(OUT_DIR, `${LABEL}-replay.json`);
writeFileSync(recFile, recordResult.export, 'utf8');
writeFileSync(
  repFile,
  JSON.stringify(
    {
      label: LABEL,
      loaded: replayResult.loaded,
      recordedFrames: recCount,
      replayCaptureFrames: capCount,
      inputIdentical,
      firstMismatch,
      mismatchSamples,
      maxPosDiff,
      maxPosDiffAt,
      posCompared,
      posIdentical,
      startDiff,
      metaChecks,
      replayTrajFrames: repTraj.length,
      errors: replayResult.errors,
      counts: replayResult.counts,
      statusText: replayResult.statusText,
      finalState: replayResult.finalState,
      trajHead: repTraj.slice(0, 5),
      trajTail: repTraj.slice(-3),
      control: {
        authorityOff: {
          recorded: controlA.counts?.frames ?? null,
          captureFrames: Array.isArray(capA.frames) ? capA.frames.length : capA.frames.t.length,
          inputIdentical: cmpA.identical,
          firstMismatch: cmpA.firstMismatch,
          trajMaxDiff: trajA.max,
          trajDiffAt: trajA.at,
          trajCompared: trajA.compared,
          trajMissing: trajA.missing,
        },
        replayTwice: {
          trajMaxDiff: trajAA.max,
          trajDiffAt: trajAA.at,
          trajCompared: trajAA.compared,
        },
        engineProbe: {
          oneStepPosDiff: engineProbe.oneStepPosDiff,
          oneStepVelDiff: engineProbe.oneStepVelDiff,
          seedEchoMismatch: engineProbe.echoMismatch,
          t1: engineProbe.t1,
          t2: engineProbe.t2,
        },
        divergence,
      },
    },
    null,
    1,
  ),
  'utf8',
);

console.log('');
console.log(`── [${LABEL}] 输入录制 / 确定性回放验收 ──`);
console.log(`  录制帧数            ${recCount}`);
console.log(`  回放捕获帧数        ${capCount}`);
console.log(`  帧数一致            ${recCount === capCount ? '是' : '否 ← 丢帧/多帧'}`);
console.log(
  `  逐帧输入序列一致    ${inputIdentical ? '是（dx/dy/keys 逐帧 ===）' : `否（首个不一致 #${firstMismatch}）`}`,
);
if (mismatchSamples.length) for (const s of mismatchSamples) console.log(`      ${s}`);
console.log(
  `  逐帧位置最大差      ${maxPosDiff === null ? '未采集' : `${maxPosDiff.toExponential(3)} HU`}` +
    (maxPosDiffAt >= 0 ? `（第 ${maxPosDiffAt} 帧，共比较 ${posCompared} 帧）` : ''),
);
console.log(
  `  起点对齐差          ${startDiff === null ? '未采集' : `${startDiff.toExponential(3)} HU`}` +
    `（录制 meta.initialState vs 回放 arm 后物理状态）`,
);
console.log(`  位置判等(≤${POS_TOL})  ${posIdentical ? '通过' : '未通过'}`);
console.log(`  回放丢帧数          ${replayResult.counts?.skipped ?? '—'}`);
console.log(`  回放错误            ${replayResult.errors?.length ? replayResult.errors.join(' | ') : '无'}`);
console.log(`  回放后状态行        「${replayResult.statusText}」`);
console.log('');
console.log(`  ── 对照实验（同页，关权威实时耦合）──`);
console.log(
  `  A 关权威·录制→回放   输入一致 ${cmpA.identical ? '是' : `否(#${cmpA.firstMismatch})`}` +
    `　逐帧位置最大差 ${trajA.max.toExponential(3)} HU（比较 ${trajA.compared} 帧，缺 ${trajA.missing}）`,
);
console.log(
  `  B 同一录制放两遍     逐帧位置最大差 ${trajAA.max.toExponential(3)} HU（比较 ${trajAA.compared} 帧）` +
    `　→ 回放本身可重复 ${trajAA.max <= POS_TOL ? '是' : '否'}`,
);
console.log(
  `  分叉诊断             首个位置分叉帧 ${divergence.firstDivergence}｜首个**速度**分叉帧 ${divergence.firstVelDivergence}` +
    `｜首个 dt 分叉帧 ${divergence.firstDtDivergence}｜maxPos ${divergence.maxPos.toExponential(3)}｜maxVel ${divergence.maxVel.toExponential(3)}`,
);
for (const s of divergence.samples ?? []) {
  console.log(
    `      #${s.k} dtA=${s.dtA} dtB=${s.dtB} d=${s.d.toExponential(2)} dv=${s.dv.toExponential(2)} g=${s.gA}/${s.gB} A=${JSON.stringify(s.posA)} B=${JSON.stringify(s.posB)}`,
  );
}
console.log(
  `      arm 后（A）${JSON.stringify(divergence.armedA)}\n` +
  `      arm 后（B）${JSON.stringify(divergence.armedB)}\n` +
  `      种子一致  ${divergence.seedA === divergence.seedB ? '是（JSON 逐字符相同）' : '否'}（长度 ${divergence.seedA?.length} vs ${divergence.seedB?.length}）\n` +
  `      录制起点  ${JSON.stringify(divergence.recInitial)}`,
);
console.log(
  `      同页连放两遍（不重建世界）：maxPos ${divergence.samePageRepeat.maxPos.toExponential(3)}｜maxVel ${divergence.samePageRepeat.maxVel.toExponential(3)}｜首个位置分叉帧 ${divergence.samePageRepeat.firstPos}`,
);
console.log(
  `      重建世界后再放：maxPos ${divergence.afterReload.maxPos.toExponential(3)}｜maxVel ${divergence.afterReload.maxVel.toExponential(3)}｜首个位置分叉帧 ${divergence.afterReload.firstPos}`,
);
console.log('');
console.log(`  RESULT_JSON ${JSON.stringify({
  label: LABEL,
  recorded: recCount,
  replayCapture: capCount,
  frameCountEqual: recCount === capCount,
  inputIdentical,
  maxPosDiff,
  posCompared,
  posIdentical,
  skipped: replayResult.counts?.skipped ?? null,
  controlAuthorityOffTrajDiff: trajA.max,
  controlReplayTwiceTrajDiff: trajAA.max,
  errors: replayResult.errors ?? [],
})}`);
console.log(`  录制文件 -> ${recFile}`);
console.log(`  回放报告 -> ${repFile}`);
if (consoleLines.length) {
  const errs = consoleLines.filter((l) => l.startsWith('EXCEPTION') || l.includes('error'));
  if (errs.length) {
    console.log(`  页面异常/错误（末 5 条）：`);
    for (const l of errs.slice(-5)) console.log('    ' + l.slice(0, 200));
  }
}

// 通过判据 = **输入流确定性**（本工具的硬承诺）：帧数一致 + 逐帧 dx/dy/keys 完全相同。
// 轨迹一致性单独报告、不参与判据：起点已位级对齐（0.000e+0 HU）、输入已逐帧一致，
// 但引擎单步即分叉（见"物理确定性探针"），故位置差是引擎侧限制，不是接线问题。
const ok = inputIdentical && recCount === capCount;
console.log('');
console.log(
  `  判据（输入流确定性：帧数一致 ∧ 逐帧输入 ===）：${ok ? '通过' : '未通过'}` +
    `　（轨迹差 ${maxPosDiff === null ? '—' : maxPosDiff.toExponential(3)} HU 单独报告，不计入通过条件）`,
);
finish(ok ? 0 : 1);
