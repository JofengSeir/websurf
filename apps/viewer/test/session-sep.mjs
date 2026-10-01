/**
 * 记录会话 / 录像会话**分离**的端到端回归（CDP + 自带静态服务器）。
 *
 * 目的：锁住一条不变量 —— **`apps/viewer` 的记录（`.replay`）与录像（`.dem`）两条链路在展示上
 * 互不影响**。结构上由 `apps/viewer/src/replay/session.ts` 的 `ReplaySession`（每边一份播放器 /
 * 3D 呈现 / 时间轴 DOM / 能力档）保证；`apps/viewer/test/smoke-cdp.mjs` 覆盖不到这一点 ——
 * 那个脚本只驱动记录页，且不带 `.dem` 夹具。
 *
 * 做三件事（断言集中在 `check(...)` 里）：
 *   1. 拖入一份合成 `.replay`（75 字节 V2，2 帧）→ 只落记录会话；
 *   2. fetch 真实的 `.dem` 夹具并拖入 → 只落录像会话，且记录会话的轨道数 / 时长 / 播放态不变；
 *   3. 来回切 tab → 两边的轨道、时间与显示开关各自保留，非活动的一侧**停表**。
 *
 * 用法：`npm run test:sessions`（= `node test/session-sep.mjs`）
 *   环境变量：EDGE_PATH / SMOKE_FILE_DEM / SESSIONS_HTTP_PORT / SESSIONS_CDP_PORT
 *   缺 Edge、缺 `.dem` 夹具或页面装配失败时**loud skip**（打印 SKIP、不计入 failures、退出码 0）。
 *
 * 与 `smoke-cdp.mjs` 的区别：本脚本**自带一个静态服务器**（服务仓库根，页面在
 * `/apps/viewer/web/index.html`）。原因：`.dem` 夹具在 `<仓库根>/test/replay/`，
 * 而 viewer 的 dev 服务器（根 = `apps/viewer`）取不到它；页面里的相对路径
 * `../../../test/replay/...` 正是靠这一点成立。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const VIEWER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(VIEWER_ROOT, '..', '..');

const EDGE =
  process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = Number(process.env.SESSIONS_CDP_PORT ?? 9444);
const HTTP_PORT = Number(process.env.SESSIONS_HTTP_PORT ?? 8123);

/** 缺省夹具：`<仓库根>/test/replay` 下的第一份 `.dem`（`SMOKE_FILE_DEM` 可覆盖）。 */
function findDemFixture() {
  if (process.env.SMOKE_FILE_DEM) return process.env.SMOKE_FILE_DEM;
  const dir = join(REPO_ROOT, 'test', 'replay');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.dem'));
  return hit ? join(dir, hit) : null;
}
const DEMO_PATH = findDemFixture();
/** 页面里的相对取法：从 `/apps/viewer/web/` 出发回到仓库根。 */
const DEMO_REL = DEMO_PATH ? relative(REPO_ROOT, DEMO_PATH).replace(/\\/g, '/') : null;

const URL_ = `http://127.0.0.1:${HTTP_PORT}/apps/viewer/web/index.html`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function skip(reason) {
  console.log(`[SKIP] ${reason}`);
  process.exit(0);
}

if (!existsSync(EDGE)) skip(`找不到 Edge（${EDGE}）—— 设 EDGE_PATH 指向浏览器可执行文件后重跑`);
if (!DEMO_PATH || !existsSync(DEMO_PATH)) {
  skip(`找不到 .dem 夹具（<仓库根>/test/replay/*.dem）—— 把夹具放到那里或用 SMOKE_FILE_DEM 指定`);
}
for (const rel of ['web/app.js', 'web/worker.js', 'web/index.html']) {
  if (!existsSync(join(VIEWER_ROOT, rel))) skip(`缺构建产物 apps/viewer/${rel} —— 先 npm run build:ts`);
}

let WebSocket;
try {
  WebSocket = (await import('ws')).default;
} catch {
  skip('缺 ws 包 —— 在 apps/viewer 里 npm i ws（或用 WS_PATH 指向已有安装）后重跑');
}

// ── 自带静态服务器（根 = 仓库根）──────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
    const abs = join(REPO_ROOT, p);
    if (!abs.replace(/\\/g, '/').startsWith(REPO_ROOT.replace(/\\/g, '/'))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const st = await stat(abs);
    if (st.isDirectory()) {
      res.writeHead(404).end('dir');
      return;
    }
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
console.log(`[http] ${URL_}`);
console.log(`[夹具] ${DEMO_PATH}`);

// ── Edge + CDP ──────────────────────────────────────────────────────
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${join(tmpdir(), 'websurf-session-sep')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let socket = null;
let seq = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  socket.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`));
    }, 180000);
  });
}

async function evaluate(expr, sessionId) {
  const res = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面异常：${d.exception?.description ?? d.text}`);
  }
  return res?.result?.value;
}

/** 面板/容器是否**真的画了出来**（祖先 `display:none` 时 `getComputedStyle` 仍会给出自身值）。 */
const PAINTED = (id) => `document.getElementById('${id}').getClientRects().length > 0`;

/** 合成 `.replay`：最小 V2（第 1 行 `<帧数>:{SHAVITREPLAYFORMAT}{V2}` + 2 帧 × 6 cell）。 */
const DROP_V2 = `(() => {
  const bytes = [];
  const line = '2:{SHAVITREPLAYFORMAT}{V2}\\n';
  for (let i = 0; i < line.length; i++) bytes.push(line.charCodeAt(i) & 0xff);
  const push = (x, signed) => {
    const dv = new DataView(new ArrayBuffer(4));
    if (signed) dv.setInt32(0, x, true); else dv.setFloat32(0, x, true);
    for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i));
  };
  for (const [x, y, z, pi, ya] of [[10, 20, 30, 0, 30], [20, 20, 30, 0, 30]]) {
    push(x, false); push(y, false); push(z, false); push(pi, false); push(ya, false); push(8, true);
  }
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(bytes)], 'session-sep.replay', { type: 'application/octet-stream' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  return bytes.length;
})()`;

async function main() {
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) version = await r.json();
    } catch {
      /* 端口未就绪：继续轮询 */
    }
    if (!version) await sleep(500);
  }
  if (!version) skip('Edge 调试端口没起来（本机策略有时会禁止 headless 浏览器创建 IPC 通道）');

  socket = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => {
    socket.once('open', r);
    socket.once('error', j);
  });
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      consoleErrors.push(msg.params.entry.text ?? '');
    }
  });

  const { targetId } = await send('Target.createTarget', { url: URL_ });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await sleep(6000); // 应用装配（WebGL 上下文 + wasm 懒加载）

  console.log('\n[A] 初始：记录会话上场');
  const boot = await evaluate(
    `({
      hasViewer: !!window.viewer,
      session: window.viewer?.session,
      tlReplay: !!document.getElementById('timeline'),
      tlDemo: !!document.getElementById('timelineDemo'),
    })`,
    sessionId,
  );
  if (!boot.hasViewer) skip('window.viewer 未装配（WebGL/wasm 初始化失败）—— 见页面 #fatal');
  console.log('  ' + JSON.stringify(boot));
  check('两条会话时间轴容器都在（#timeline / #timelineDemo）', boot.tlReplay && boot.tlDemo);
  check('初始活动会话 = replay', boot.session?.active === 'replay', JSON.stringify(boot.session));

  console.log('\n[B] 拖入合成 .replay（75 字节 V2）→ 只落记录会话');
  const dropped = await evaluate(DROP_V2, sessionId);
  check('合成 V2 已投递（75 字节）', dropped === 75, String(dropped));
  await sleep(2500);

  const afterReplay = await evaluate(
    `(() => {
      const r = window.viewer.replay, d = window.viewer.demo;
      const pane = (id) => document.getElementById(id).classList.contains('active');
      const tlVisible = (id) => {
        const el = document.getElementById(id);
        if (el.classList.contains('hidden')) return false;
        return getComputedStyle(el).display !== 'none';
      };
      const buttons = (sel, re) =>
        Array.from(document.querySelectorAll(sel + ' button')).filter((b) => re.test(b.textContent)).length;
      return {
        session: window.viewer.session,
        replayTracks: r.trackCount, replayDuration: r.duration, replayPlaying: r.playing,
        demoTracks: d.trackCount, demoDuration: d.duration, demoReady: d.ready,
        tabReplay: document.querySelector('.tab[data-tab="replay"]').classList.contains('active'),
        tabDemo: document.querySelector('.tab[data-tab="demo"]').classList.contains('active'),
        paneReplay: pane('pane-replay'), paneDemo: pane('pane-demo'),
        tlReplayVisible: tlVisible('timeline'),
        tlDemoHidden: document.getElementById('timelineDemo').classList.contains('hidden'),
        replayKeys: document.querySelectorAll('#timeline .tm-key').length,
        demoKeys: document.querySelectorAll('#timelineDemo .tm-key').length,
        // 能力档：记录 = 跑段带 + A-B 带 + 帧步进 + A/B 按钮；录像 = 人物叠加带 ×2，且没有上面那些
        rRun: document.querySelectorAll('#timeline .tl-zone-run').length,
        rAb: document.querySelectorAll('#timeline .tl-zone-ab').length,
        rActive: document.querySelectorAll('#timeline .tl-zone-active').length,
        dRun: document.querySelectorAll('#timelineDemo .tl-zone-run').length,
        dAb: document.querySelectorAll('#timelineDemo .tl-zone-ab').length,
        dActive: document.querySelectorAll('#timelineDemo .tl-zone-active').length,
        dHl: document.querySelectorAll('#timelineDemo .tl-zone-hl').length,
        // 已撤的标记层：两边都不许再建（owner 裁：滑杆上不需要阵亡点）
        rMarks: document.querySelectorAll('#timeline .tl-marks, #timeline .tl-mark').length,
        dMarks: document.querySelectorAll('#timelineDemo .tl-marks, #timelineDemo .tl-mark').length,
        // 录像信息条此刻应为空（还没喂过 .dem）
        demoInfoPainted: document.getElementById('demoInfo').getClientRects().length > 0,
        demoInfoLabels: Array.from(document.querySelectorAll('#demoInfo .mk')).map((k) => k.textContent),
        rFrameBtns: buttons('#timeline', /帧/),
        dFrameBtns: buttons('#timelineDemo', /帧/),
        rAbBtns: buttons('#timeline', /A 起点|B 终点|整段/),
        dAbBtns: buttons('#timelineDemo', /A 起点|B 终点|整段/),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(afterReplay));
  check('.replay 落进记录会话（1 条轨道）', afterReplay.replayTracks === 1, String(afterReplay.replayTracks));
  check('录像会话没有拿到这条轨道', afterReplay.demoTracks === 0, String(afterReplay.demoTracks));
  check('切到记录 tab（不是录像 tab）', afterReplay.tabReplay === true && afterReplay.tabDemo === false);
  check('记录时间轴可见', afterReplay.tlReplayVisible === true);
  check('录像时间轴仍隐藏', afterReplay.tlDemoHidden === true);
  check('记录时间轴有按键簇（.tm-key × 8）', afterReplay.replayKeys === 8, String(afterReplay.replayKeys));
  check('录像时间轴没有按键簇（.dem 无按键真值）', afterReplay.demoKeys === 0, String(afterReplay.demoKeys));
  check(
    '记录档能力：跑段带 + A-B 带 + 帧步进 ×2 + A/B 按钮 ×3，无人物带',
    afterReplay.rRun === 1 && afterReplay.rAb === 1 && afterReplay.rActive === 0 &&
      afterReplay.rFrameBtns === 2 && afterReplay.rAbBtns === 3,
    JSON.stringify(afterReplay),
  );
  check(
    '录像档能力：人物带 ×2，无跑段/A-B/帧步进',
    afterReplay.dActive === 1 && afterReplay.dHl === 1 &&
      afterReplay.dRun === 0 && afterReplay.dAb === 0 && afterReplay.dFrameBtns === 0 && afterReplay.dAbBtns === 0,
    JSON.stringify(afterReplay),
  );
  check('阵亡标记层已撤（两条时间轴都不建）', afterReplay.rMarks === 0 && afterReplay.dMarks === 0, JSON.stringify(afterReplay));
  check(
    '只喂过 .replay 时，录像信息条为空且不占屏',
    afterReplay.demoInfoPainted === false && afterReplay.demoInfoLabels.length === 0,
    JSON.stringify({ painted: afterReplay.demoInfoPainted, labels: afterReplay.demoInfoLabels }),
  );
  const replayDuration = afterReplay.replayDuration;

  console.log('\n[C] 拖入真实 .dem → 只落录像会话');
  const t0 = Date.now();
  await evaluate(
    `(async () => {
      const resp = await fetch('../../../${DEMO_REL}');
      if (!resp.ok) throw new Error('HTTP ' + resp.status + '（${DEMO_REL}）');
      const buf = await resp.arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([buf], 'session-sep.dem', { type: 'application/octet-stream' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      return buf.byteLength;
    })()`,
    sessionId,
  );
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    await sleep(1000);
    ready = await evaluate('window.viewer.demo.ready === true', sessionId);
  }
  console.log(`  .dem 解析+就绪耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('录像会话就绪（sessionLength 撑起整场时长）', ready === true);
  await sleep(4000); // 让自动跟随建出第一条录像轨道

  const afterDemo = await evaluate(
    `(() => {
      const r = window.viewer.replay, d = window.viewer.demo;
      const pane = (id) => document.getElementById(id).classList.contains('active');
      const painted = (id) => document.getElementById(id).getClientRects().length > 0;
      return {
        session: window.viewer.session,
        replayTracks: r.trackCount, replayDuration: r.duration, replayTime: r.time, replayPlaying: r.playing,
        demoTracks: d.trackCount, demoDuration: d.duration, demoTime: d.time, demoPlaying: d.playing,
        demoSessionLength: d.sessionLength, demoFollow: d.followId, demoMetaIsNull: d.meta() === null,
        tabDemo: document.querySelector('.tab[data-tab="demo"]').classList.contains('active'),
        paneDemo: pane('pane-demo'), paneReplay: pane('pane-replay'),
        tlDemoPainted: painted('timelineDemo'), tlReplayPainted: painted('timeline'),
        replayMetaPainted: painted('replayMeta'),
        demoMarks: document.querySelectorAll('#timelineDemo .tl-marks, #timelineDemo .tl-mark').length,
        replayMarks: document.querySelectorAll('#timeline .tl-marks, #timeline .tl-mark').length,
        rosterRows: document.querySelectorAll('#demoRoster .dmp-who').length,
        rosterNames: Array.from(document.querySelectorAll('#demoRoster .dmp-whoname')).map((n) => n.textContent),
        // 注意：本表达式在模板字符串里，反斜杠转义会被吃掉 —— 一律用 [0-9] 这类无转义写法
        rosterMeta: document.querySelector('#demoMeta')?.textContent?.match(/玩家([0-9]+)/)?.[1] ?? '',
        // 本轮把看板压成「标题行摘要 + 在服 + 来源」（事实由录像信息条常驻）：摘要与悬停提示是这些值的**新家**
        metaSummary: document.querySelector('#demoMeta .dmp-sum') ? document.querySelector('#demoMeta .dmp-sum').textContent : '',
        metaTitleTip: document.querySelector('#demoMeta .dmp-title') ? document.querySelector('#demoMeta .dmp-title').getAttribute('title') : '',
        demoClock: document.querySelector('#timelineDemo .tl-time')?.textContent ?? '',
        replayClock: document.querySelector('#timeline .tl-time')?.textContent ?? '',
        serverRow: document.querySelector('#demoMeta')?.textContent?.includes('服务器') ?? false,
        // 录像信息条 #demoInfo：.dem 独有事实的展示位。记录条 #replayMeta 必须原样不受影响。
        demoInfoPainted: painted('demoInfo'),
        demoInfoLabels: Array.from(document.querySelectorAll('#demoInfo .mk')).map((k) => k.textContent),
        demoInfoText: document.querySelector('#demoInfo')?.textContent ?? '',
        demoInfoTitles: Array.from(document.querySelectorAll('#demoInfo .mi')).map((i) => i.getAttribute('title') ?? ''),
        replayMetaText: document.querySelector('#replayMeta')?.textContent ?? '',
        replayMetaPainted2: painted('replayMeta'),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(afterDemo));
  check('活动会话切到 demo', afterDemo.session?.active === 'demo', JSON.stringify(afterDemo.session));
  check('录像 tab 面板激活', afterDemo.paneDemo === true && afterDemo.tabDemo === true);
  check('记录会话的轨道数没被录像改动（仍 1 条）', afterDemo.replayTracks === 1, String(afterDemo.replayTracks));
  check('记录会话的时长没被录像撑长', afterDemo.replayDuration === replayDuration, `${afterDemo.replayDuration} vs ${replayDuration}`);
  check('记录会话已停表（playing=false）', afterDemo.replayPlaying === false);
  check('录像会话建出轨道（自动跟随）', afterDemo.demoTracks >= 1, String(afterDemo.demoTracks));
  check(
    '录像时长 = 整场（远大于记录片段）',
    afterDemo.demoDuration > 1000 && afterDemo.demoDuration === afterDemo.demoSessionLength,
    `${afterDemo.demoDuration} / sessionLength ${afterDemo.demoSessionLength}`,
  );
  check('录像会话的 Clip.meta 恒 null', afterDemo.demoMetaIsNull === true);
  // **「任由它自己播」不该被内部动作停住**（owner 实测：加载后自动播放，会莫名其妙自己暂停）。
  // 成因是自动跟随**第一次切人**走「加第一条轨道」那条路，而 `addTrack` 里的区间复位带着暂停语义
  // （`ReplayPlayer.resetRange()`）⇒ 自动跟随把人切过去的同时把录像停住了。
  // 这里不碰任何控件，只等它自己往前走：播放态必须还是「在播」、且播放头确实在前进。
  const autoPlayA = await evaluate(`({ t: window.viewer.demo.time, playing: window.viewer.demo.playing })`, sessionId);
  await sleep(5000);
  const autoPlayB = await evaluate(`({ t: window.viewer.demo.time, playing: window.viewer.demo.playing, entity: window.viewer.demo.followId })`, sessionId);
  console.log('  ' + JSON.stringify({ 前: autoPlayA, 后5秒: autoPlayB }));
  check('不受打扰地自己播 5 秒：仍在播放（内部换轨/换人不得暂停它）', autoPlayB.playing === true, JSON.stringify(autoPlayB));
  check('不受打扰地自己播 5 秒：播放头确实前进了 ≥ 3 秒', autoPlayB.t - autoPlayA.t >= 3, `${autoPlayA.t.toFixed(2)} → ${autoPlayB.t.toFixed(2)}`);
  check('录像时间轴可见', afterDemo.tlDemoPainted === true);
  check('记录时间轴随记录面板一起收起（不占屏）', afterDemo.tlReplayPainted === false);
  check('记录信息条随记录面板一起收起', afterDemo.replayMetaPainted === false);
  check('录像时间轴读 m:ss（绝对时刻）', /^\d+:\d\d \/ \d+:\d\d$/.test(afterDemo.demoClock), afterDemo.demoClock);
  check('记录时间轴读秒（两套口径互不串）', /s$/.test(afterDemo.replayClock), afterDemo.replayClock);
  check('阵亡标记层已撤（录像时间轴也不再建）', afterDemo.demoMarks === 0 && afterDemo.replayMarks === 0, JSON.stringify({ d: afterDemo.demoMarks, r: afterDemo.replayMarks }));
  // **花名册去重**（owner 实测：同一台机器人被复用做回放时反复重连，名单上摊成十几行）。
  // 本夹具的占用事件 11 条、真实身份只有 5 个：3 台回放机器人（各重连 3 次，guid 恒为 `BOT`、
  // 每槽名字不变）+ 真人 `LuoXuan`（guid 相同、先后占了槽 6 与槽 4）= 4 行，
  // 外加只在签名表里、从不更新 `userinfo` 的录制机器人（走「可用轨迹」分支）= 5 行。
  console.log('  ' + JSON.stringify({ rosterRows: afterDemo.rosterRows, rosterNames: afterDemo.rosterNames, meta: afterDemo.rosterMeta }));
  check('花名册已按身份去重（本夹具 5 行）', afterDemo.rosterRows === 5, String(afterDemo.rosterRows));
  check(
    '花名册没有重名（同一身份不再铺成多行）',
    new Set(afterDemo.rosterNames).size === afterDemo.rosterNames.length,
    JSON.stringify(afterDemo.rosterNames),
  );
  check(
    '真人只出现一行（跨槽位已合并）',
    afterDemo.rosterNames.filter((n) => /LuoXuan/.test(n ?? '')).length === 1,
    JSON.stringify(afterDemo.rosterNames),
  );
  // 看板已压缩：人数与服务器名不再各占一行（事实由录像信息条常驻），但**新家仍要能读到**。
  check(
    '看板标题摘要仍报人数（与花名册行数一致）',
    new RegExp(String(afterDemo.rosterRows) + ' 位').test(afterDemo.metaSummary ?? ''),
    `summary=${afterDemo.metaSummary} rows=${afterDemo.rosterRows}`,
  );
  check('看板已压缩但服务器名仍可在悬停提示里读到', /ERDY's Surf Server/.test(afterDemo.metaTitleTip ?? ''), JSON.stringify(afterDemo.metaTitleTip));

  console.log('\n[C-board] 看板（载入与看板）重新设计后的结构');
  const board = await evaluate(
    `(() => {
      const q = (s) => document.querySelector(s);
      const rows = Array.from(document.querySelectorAll('#demoMeta .dmp-facts > div')).map((d) => ({
        k: (d.querySelector('dt') || {}).textContent || '',
        v: (d.querySelector('dd') || {}).textContent || '',
      }));
      const names = (q('#demoMeta .dmp-live') || {}).textContent || '';
      return {
        rows,
        file: (q('#demoMeta .dmp-file') || {}).textContent || '',
        sum: (q('#demoMeta .dmp-sum') || {}).textContent || '',
        tag: (q('#demoMeta .dmp-live-tag') || {}).textContent || '',
        names,
        badge: (q('#demoMeta .dmp-live-n') || {}).textContent || '',
        drop: (q('#pane-demo .dmp-drop') || {}).textContent || '',
        altBox: !!q('#demoAltOrder'),
        altText: (q('#pane-demo') || { textContent: '' }).textContent.includes('运动优先'),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ rows: board.rows.map((r) => r.k + '=' + r.v.replace(/\s+/g, ' ')), badge: board.badge, names: board.names }));
  const keys = board.rows.map((r) => r.k);
  check('看板是一张规格表：六行事实齐全且顺序固定', JSON.stringify(keys) === JSON.stringify(['地图', '服务器', '天空', '时长', '人数', '解析']), JSON.stringify(keys));
  const val = (k) => (board.rows.find((r) => r.k === k) || {}).v || '';
  check('地图 / 天空取真值（svc_ServerInfo.skyName 只在 .dem 里有）', /surf_gigapede/.test(val('地图')) && /Clear_night_sky/.test(val('天空')), JSON.stringify({ map: val('地图'), sky: val('天空') }));
  check('时长行带单位与副读数（tick 数 + tick 率）', /[0-9]+:[0-9][0-9]/.test(val('时长')) && /119900 tick/.test(val('时长')) && /[0-9]+\.[0-9]\/s/.test(val('时长')), JSON.stringify(val('时长')));
  check('人数行 = 花名册行数，并带轨迹 / 对话副读数', new RegExp(String(afterDemo.rosterRows) + ' 位').test(val('人数')) && /轨迹 [0-9]+ 条/.test(val('人数')) && /对话 [0-9]+ 条/.test(val('人数')), JSON.stringify(val('人数')));
  check('解析行 = 包成功数 + 实体消息数与耗时', /59949\/59951/.test(val('解析')) && /实体 59948 条/.test(val('解析')) && /[0-9]+\.[0-9] s/.test(val('解析')), JSON.stringify(val('解析')));
  check('标题行 = 文件名 + 一句摘要（大小 / 时长 / 人数 / 服务器名）', /\.dem$/.test(board.file.trim()) && /[0-9.]+ MB/.test(board.sum) && / 位/.test(board.sum) && /ERDY's Surf Server/.test(board.sum), JSON.stringify({ file: board.file, sum: board.sum }));
  // 「在服」行三段：强调色标签 + 可换行名单 + 人数角标；角标必须与名单条数一致（不能各说各的）
  const nameCount = board.names.trim() === '—' ? 0 : board.names.split('·').length;
  check('「在服」行三段齐全，且角标人数与名单条数一致', board.tag === '在服' && new RegExp('^' + nameCount + ' 人$').test(board.badge.trim()), JSON.stringify({ tag: board.tag, badge: board.badge, nameCount }));
  check('载入区给出拖拽提示', /拖进窗口/.test(board.drop), JSON.stringify(board.drop));
  check('「运动优先（实验展平顺序）」开关与文案已撤除', board.altBox === false && board.altText === false, JSON.stringify({ box: board.altBox, text: board.altText }));
  const ruleInfo = await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#demoChat .dmp-chat-line'));
      const fb = document.querySelector('#demoChatFilter .dmp-cf-fb');
      return {
        rules: rows.map((r) => r.dataset.rule),
        titles: rows.slice(0, 3).map((r) => r.getAttribute('title') || ''),
        fbHidden: fb ? fb.hidden : null,
        fbText: fb ? fb.textContent : '',
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ 判据: ruleInfo.rules.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}), 兜底: ruleInfo.fbText, 隐藏: ruleInfo.fbHidden }));
  check('每一行都写出命中的判据（data-rule），且没命中具体规则的会显示出来', ruleInfo.rules.length === 40 && ruleInfo.rules.every((r) => typeof r === 'string' && r.length > 0), JSON.stringify(ruleInfo.rules.slice(0, 4)));
  check('悬停提示写明「类别：判据」（可核对分类依据）', ruleInfo.titles.length === 3 && ruleInfo.titles.every((t) => /：/.test(t)), JSON.stringify(ruleInfo.titles));
  check('本夹具 40 条全部命中具体判据 ⇒ 兜底读数不显示', ruleInfo.fbHidden === true && ruleInfo.fbText === '', JSON.stringify({ hidden: ruleInfo.fbHidden, text: ruleInfo.fbText }));

  console.log('\n[C-chat] 消息过滤（四类）+ 过关记录点击跳转');
  const chatBox = await evaluate(
    `(() => {
      const q = (s) => document.querySelector(s);
      const cats = Array.from(document.querySelectorAll('#demoChatFilter .dmp-cf')).map((l) => ({
        kind: l.dataset.kind,
        label: (l.querySelector('.dmp-cf-name') || {}).textContent || '',
        n: (l.querySelector('.dmp-cf-n') || {}).textContent || '',
        checked: !!(l.querySelector('input') || {}).checked,
      }));
      const rows = Array.from(document.querySelectorAll('#demoChat .dmp-chat-line'));
      const jumps = Array.from(document.querySelectorAll('#demoChat .dmp-chat-jump'));
      return {
        cats,
        lineCount: rows.length,
        kinds: rows.map((r) => r.dataset.kind),
        recRows: rows.filter((r) => r.classList.contains('dmp-chat-rec')).length,
        jumpCount: jumps.length,
        firstJump: jumps.length > 0 ? { to: Number(jumps[0].dataset.jump), label: jumps[0].textContent, player: jumps[0].dataset.player, level: jumps[0].dataset.level, dur: Number(jumps[0].dataset.dur), title: jumps[0].title } : null,
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ cats: chatBox.cats, kinds: chatBox.lineCount, rec: chatBox.recRows, jump: chatBox.firstJump }));
  check('过滤行 = 四个类别，顺序与标签固定', JSON.stringify(chatBox.cats.map((c) => c.kind)) === JSON.stringify(['chat', 'join', 'announce', 'record']) && chatBox.cats.map((c) => c.label).join('/') === '玩家对话/进服公告/服务器公告/过关记录', JSON.stringify(chatBox.cats.map((c) => c.label)));
  check('每类都带实时条数读数（本夹具 1 / 5 / 30 / 4）', chatBox.cats.map((c) => c.n).join(',') === '×1,×5,×30,×4', chatBox.cats.map((c) => c.n).join(','));
  check('缺省一个都不勾（不过滤）', chatBox.cats.every((c) => c.checked === false) && chatBox.lineCount === 40, JSON.stringify({ checked: chatBox.cats.map((c) => c.checked), lines: chatBox.lineCount }));
  check('每一行都带类别标记，且 40 行的类别分布与读数一致', chatBox.kinds.length === 40 && chatBox.kinds.filter((k) => k === 'announce').length === 30 && chatBox.kinds.filter((k) => k === 'record').length === 4, JSON.stringify(chatBox.kinds.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {})));
  check('过关记录行单独标了 dmp-chat-rec 并带跳转按钮', chatBox.recRows === 4 && chatBox.jumpCount === 4, JSON.stringify({ rec: chatBox.recRows, jump: chatBox.jumpCount }));
  check(
    '跳转目标是「播报 − 用时 − 5 秒」（首条实测 576.556s）',
    chatBox.firstJump !== null && Math.abs(chatBox.firstJump.to - 576.556) < 0.05 && chatBox.firstJump.player === 'LuoXuan' && /奖励关4/.test(chatBox.firstJump.level),
    JSON.stringify(chatBox.firstJump),
  );
  check('按钮与悬停都写明算式', chatBox.firstJump !== null && /9:37/.test(chatBox.firstJump.label) && /用时 18.714 秒 − 5 秒缓冲 = 9:37/.test(chatBox.firstJump.title), JSON.stringify(chatBox.firstJump));

  // 勾上「服务器公告」+「进服公告」：行数应只剩 过关记录 + 玩家对话，且标签加删除线
  await evaluate(
    `(() => {
      for (const k of ['announce', 'join']) {
        const box = document.querySelector('#demoChatFilter input[data-kind="' + k + '"]');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`,
    sessionId,
  );
  await sleep(300);
  const filtered = await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#demoChat .dmp-chat-line'));
      const off = Array.from(document.querySelectorAll('#demoChatFilter .dmp-cf.off')).map((l) => l.dataset.kind);
      return {
        lines: rows.length,
        kinds: rows.map((r) => r.dataset.kind),
        off,
        overlay: Array.from(document.querySelectorAll('#chatOverlay .co-line')).map((l) => l.textContent),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ 滤后行数: filtered.lines, 类别: filtered.kinds.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}), 删除线: filtered.off }));
  check('勾掉两类后只剩 5 行（1 对话 + 4 过关），且一条 announce / join 都不剩', filtered.lines === 5 && filtered.kinds.every((k) => k === 'chat' || k === 'record'), JSON.stringify(filtered.kinds));
  check('被勾掉的类别标签加删除线（.off）', filtered.off.join(',') === 'join,announce', JSON.stringify(filtered.off));

  // 点第一条过关记录的跳转按钮：播放头必须落到那个时刻（先切视角、最后 seek —— 顺序反了会被切视角的 seek 覆盖）
  await evaluate(
    `(() => { const d = window.viewer.demo; d.pause(); d.seek(560); return true; })()`,
    sessionId,
  );
  await sleep(400);
  const jumped = await evaluate(
    `(() => {
      const b = document.querySelector('#demoChat .dmp-chat-jump');
      const want = Number(b.dataset.jump);
      b.click();
      return { want };
    })()`,
    sessionId,
  );
  await sleep(600);
  const afterJump = await evaluate(
    `({ time: window.viewer.demo.time, playing: window.viewer.demo.playing, status: (document.getElementById('bspStatus') || {}).textContent || '' })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ 目标: Math.round(jumped.want * 100) / 100, 落点: Math.round(afterJump.time * 100) / 100, 状态: afterJump.status }));
  check(
    '点过关记录 ⇒ 播放头落到算好的时刻（±0.2s，不被切视角的 seek 覆盖）',
    Math.abs(afterJump.time - jumped.want) < 0.2,
    `${afterJump.time.toFixed(2)} vs ${jumped.want.toFixed(2)}`,
  );
  check('点跳转不改播放态（暂停着点完仍暂停）', afterJump.playing === false, String(afterJump.playing));
  check('状态行写明跳转与算式', /跳到 LuoXuan/.test(afterJump.status) && /5 秒缓冲/.test(afterJump.status), JSON.stringify(afterJump.status));

  // 复原：把两个勾去掉（后面的段落按「40 行都在」的前提复核对话节）
  await evaluate(
    `(() => {
      for (const k of ['announce', 'join']) {
        const box = document.querySelector('#demoChatFilter input[data-kind="' + k + '"]');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`,
    sessionId,
  );
  await sleep(200);

  console.log('\n[C1c] 录像信息条：`.dem` 独有事实，且不碰记录条');
  console.log('  ' + JSON.stringify({ labels: afterDemo.demoInfoLabels, text: afterDemo.demoInfoText }));
  check('录像信息条已放出（且已渲染字段）', afterDemo.demoInfoPainted === true && afterDemo.demoInfoLabels.length === 12, JSON.stringify(afterDemo.demoInfoLabels));
  check(
    '录像信息条含 .dem 独有字段（服务器 / 天空 / 协议 / 录制机位 / 事件 / 实体流 / 字符串表 / 包）',
    ['服务器', '地图', '天空', '协议', '时长', '录制机位', '实体流', '玩家', '事件', '聊天', '字符串表', '包'].every((k) =>
      afterDemo.demoInfoLabels.includes(k),
    ),
    JSON.stringify(afterDemo.demoInfoLabels),
  );
  // **数值级断言**：这几项是本夹具的实测真值（解析层直接产出，不是文案）
  check(
    '录像信息条的关键读数与本夹具一致（天空 / 事件 / 聊天 / 字符串表 / 实体流 / 录制机位）',
    /Clear_night_sky/.test(afterDemo.demoInfoText) &&
      /事件231 次/.test(afterDemo.demoInfoText) &&
      /聊天40 条/.test(afterDemo.demoInfoText) &&
      /字符串表19 张/.test(afterDemo.demoInfoText) &&
      /59948 条 \/ 514022 次/.test(afterDemo.demoInfoText) &&
      /录制机位未记录（59951 条全 0）/.test(afterDemo.demoInfoText),
    afterDemo.demoInfoText,
  );
  check(
    '录像信息条把「签名表条数」与「花名册人数」并列（两个口径不混）',
    /玩家5 位 \/ 签名表 5 条/.test(afterDemo.demoInfoText),
    afterDemo.demoInfoText,
  );
  check(
    '录像信息条的悬停提示带诊断面（用户消息直方图 / 字符串表清单 / 包失败分类）',
    afterDemo.demoInfoTitles.some((t) => /svc_UserMessage 直方图/.test(t)) &&
      afterDemo.demoInfoTitles.some((t) => /dem_stringtables 19 张/.test(t)) &&
      afterDemo.demoInfoTitles.some((t) => /成功解析 \/ 全部/.test(t)),
    JSON.stringify(afterDemo.demoInfoTitles.map((t) => t.slice(0, 40))),
  );
  check(
    '记录条没被录像会话写过（仍是那份 .replay 的元信息，且不含任何 .dem 事实）',
    /session-sep\.replay/.test(afterDemo.replayMetaText) &&
      !/Clear_night_sky|svc_|签名表/.test(afterDemo.replayMetaText) &&
      afterDemo.replayMetaPainted2 === false,
    JSON.stringify({ text: afterDemo.replayMetaText, painted: afterDemo.replayMetaPainted2 }),
  );

  console.log('\n[C1d] 「进过一次服、退出、又进来」的真人：区间分两段 + 自动跟随在他第二段切过去');
  // 本夹具的真人 `LuoXuan` 就是这种：`userinfo` 更新流里是**两段**占用（槽 6 早段、槽 4 后段），
  // 而按身份合并成一行后，若把它压成一段连贯区间，就再也看不出他退过服（owner 实测）。
  const seg = await evaluate(
    `(() => {
      const btn = Array.from(document.querySelectorAll('#demoRoster .dmp-who')).find((b) => /LuoXuan/.test(b.textContent || ''));
      if (!btn) return null;
      return {
        bars: btn.querySelectorAll('.dmp-whobar i').length,
        time: btn.querySelector('.dmp-whotime') ? btn.querySelector('.dmp-whotime').textContent : '',
        title: btn.getAttribute('title') || '',
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(seg));
  check('花名册把「退出又进来」画成两段（区间条两枚 + 读数标 2 段）', seg !== null && seg.bars === 2 && /2 段/.test(seg.time ?? ''), JSON.stringify(seg));
  check('悬停提示列出两段的时刻并说明中途退出过', /在场分 2 段/.test(seg?.title ?? '') && /中途退出过/.test(seg?.title ?? ''), JSON.stringify(seg?.title));
  // **自动跟随**：把播放头放到他**第二段**内（本夹具 #5 的窗口 ≈ 276–714 s），不点任何东西，
  // 视角应当自动切到第二段那个实体。修前它锁死在第一段的实体上，必须手动再点一次（owner 实测）。
  await evaluate(`(() => { const d = window.viewer.demo; d.play(); d.seek(600); return true; })()`, sessionId);
  await sleep(900);
  const auto2 = await evaluate(
    `({
      internals: document.querySelector('#demoDetail .dmp-grid') ? document.querySelector('#demoDetail .dmp-grid').getAttribute('title') : '',
      segs: document.querySelectorAll('#timelineDemo .tl-zone-active .tl-seg').length,
      // **段的实际像素宽度**：只数个数会漏掉「元素在、但容器 0 宽 ⇒ 整条带看不见」这类缺陷
      segWidths: Array.from(document.querySelectorAll('#timelineDemo .tl-zone-active .tl-seg')).map((s) => Math.round(s.getBoundingClientRect().width)),
      time: window.viewer.demo.time,
    })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ segs: auto2.segs, widths: auto2.segWidths, time: auto2.time, entity: (auto2.internals.match(/实体号 #[0-9]+/) ?? [''])[0] }));
  check('自动跟随在他第二段切到 #5（无需再点一次）', /实体号 #5/.test(auto2.internals ?? ''), JSON.stringify(auto2.internals.slice(0, 120)));
  check('人物叠加带按区间画成两段（中间留断口）', auto2.segs === 2, String(auto2.segs));
  check(
    '两段都真的画出来了（像素宽度 > 0，不是容器 0 宽导致整条带不可见）',
    auto2.segWidths.length === 2 && auto2.segWidths.every((w) => w > 5),
    JSON.stringify(auto2.segWidths),
  );
  // 回到他的**第一段**（本夹具 #7 的窗口 ≈ 5–74 s）⇒ 视角自动切回那一段的实体 #7。
  await evaluate(`(() => { const d = window.viewer.demo; d.play(); d.seek(30); return true; })()`, sessionId);
  await sleep(900);
  const auto1 = await evaluate(
    `({ internals: document.querySelector('#demoDetail .dmp-grid') ? document.querySelector('#demoDetail .dmp-grid').getAttribute('title') : '' })`,
    sessionId,
  );
  check('回到他第一段 ⇒ 自动切到 #7', /实体号 #7/.test(auto1.internals ?? ''), JSON.stringify(auto1.internals.slice(0, 120)));
  // **缺口期间**（本夹具两段之间 ≈ 74–276 s）：owner 定稿——**一直在看着的人退出后不切别人**，
  // 直接把播放头跳到他**重进那一刻**接着看（同一段只跳一次，免得手动拖回缺口又被弹走）。
  await evaluate(`(() => { const d = window.viewer.demo; d.play(); d.seek(150); return true; })()`, sessionId);
  await sleep(1200);
  const gap = await evaluate(
    `({
      internals: document.querySelector('#demoDetail .dmp-grid') ? document.querySelector('#demoDetail .dmp-grid').getAttribute('title') : '',
      time: window.viewer.demo.time,
      status: document.querySelector('#bspStatus') ? document.querySelector('#bspStatus').textContent : '',
    })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ entity: (gap.internals.match(/实体号 #[0-9]+/) ?? [''])[0], time: Math.round(gap.time), status: gap.status }));
  check(
    '他退出后不切别人，而是跳到他重进那一刻接着看（≈276 s / #5）',
    Math.abs(gap.time - 276) < 12 && /实体号 #5/.test(gap.internals ?? ''),
    JSON.stringify({ time: gap.time, entity: (gap.internals.match(/实体号 #[0-9]+/) ?? [''])[0] }),
  );
  check('跳转时给出状态提示（说明跳过了他不在场的一段）', /已跳过/.test(gap.status ?? '') && /重进/.test(gap.status ?? ''), JSON.stringify(gap.status));

  console.log('\n[C1e] 对话：面板只做明暗（不滚） + 画面左下角浮层（15 秒 / 最多 5 条 / 最底下最晚）');
  const chat0 = await evaluate(
    `(() => {
      const box = document.getElementById('demoChat');
      const lines = Array.from(box.querySelectorAll('.dmp-chat-line'));
      const cs = getComputedStyle(box);
      return {
        lines: lines.length,
        withAt: lines.filter((l) => l.dataset.at !== undefined).length,
        boxH: Math.round(box.getBoundingClientRect().height),
        scrollH: Math.round(box.scrollHeight),
        overflowY: cs.overflowY,
        scrollTop: Math.round(box.scrollTop),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(chat0));
  check('对话每条都带会话内时刻（绑定时间轴的依据）', chat0.lines > 0 && chat0.withAt === chat0.lines, JSON.stringify(chat0));
  check(
    '面板对话**不设自己的滚动条**（溢出可见 / 不滚动，留档由整列滚动看）',
    chat0.overflowY === 'visible' && chat0.scrollTop === 0,
    JSON.stringify({ overflowY: chat0.overflowY, scrollTop: chat0.scrollTop }),
  );
  // 回到 0 s（暂停，免得自动跟随把播放头挪走）：一条都还没发生 ⇒ 全暗
  await evaluate(`(() => { const d = window.viewer.demo; d.pause(); d.seek(0); return true; })()`, sessionId);
  await sleep(400);
  const chatZero = await evaluate(
    `({
      on: document.querySelectorAll('#demoChat .dmp-chat-on').length,
      total: document.querySelectorAll('#demoChat .dmp-chat-line').length,
      overlay: document.querySelectorAll('#chatOverlay .co-line').length,
    })`,
    sessionId,
  );
  check('播放头 0 s：面板已发生 0 条（全暗）、浮层也没到该显示的时刻', chatZero.on === 0 && chatZero.total > 0 && chatZero.overlay === 0, JSON.stringify(chatZero));
  // 走到 900 s：面板前若干条点亮、后面的仍暗
  await evaluate(`(() => { const d = window.viewer.demo; d.pause(); d.seek(900); return true; })()`, sessionId);
  await sleep(500);
  const chatMid = await evaluate(
    `(() => {
      const box = document.getElementById('demoChat');
      const lines = Array.from(box.querySelectorAll('.dmp-chat-line'));
      const on = lines.filter((l) => l.classList.contains('dmp-chat-on'));
      // 面板**自己**不滚：播放头走到 900 s 也不该有 scrollTop
      return { on: on.length, total: lines.length, scrollTop: Math.round(box.scrollTop) };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(chatMid));
  check('播放头 900 s：面板已发生的点亮、未发生的仍暗', chatMid.on > 0 && chatMid.on < chatMid.total, JSON.stringify(chatMid));
  check('面板不发亮的同时也不自己滚（scrollTop 仍为 0）', chatMid.scrollTop === 0, String(chatMid.scrollTop));
  // ── 画面左下角的浮层 ──
  // 走到本夹具 15 秒窗口内最多条数的那一段（29:44–29:59 共 4 条）看同屏与顺序
  await evaluate(`(() => { const d = window.viewer.demo; d.pause(); d.seek(1799); return true; })()`, sessionId);
  await sleep(600);
  const ov = await evaluate(
    `(() => {
      const box = document.getElementById('chatOverlay');
      const lines = Array.from(box.querySelectorAll('.co-line'));
      const rects = lines.map((l) => l.getBoundingClientRect());
      const host = box.getBoundingClientRect();
      const dock = document.getElementById('dock').getBoundingClientRect();
      return {
        n: lines.length,
        visible: lines.filter((l) => getComputedStyle(l).opacity !== '0').length,
        texts: lines.map((l) => (l.textContent || '').slice(0, 18)),
        left: Math.round(host.left),
        bottom: Math.round(host.bottom),
        dockTop: Math.round(dock.top),
        // **最底下是最晚的**：DOM 顺序自早到晚 ⇒ 每条的 top 应递增
        ascending: rects.every((r, i) => i === 0 || r.top > rects[i - 1].top - 0.5),
        onScreen: rects.every((r) => r.left >= 0 && r.bottom <= window.innerHeight + 1),
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(ov));
  check('浮层在左下角、且不被底部时间轴压住', ov.left < 120 && ov.bottom <= ov.dockTop + 2, JSON.stringify({ left: ov.left, bottom: ov.bottom, dockTop: ov.dockTop }));
  check('浮层同屏**最多 5 条**（本夹具实测该时刻 ' + ov.n + ' 条）', ov.n > 0 && ov.n <= 5, String(ov.n));
  check('浮层顺序自早到晚（最底下是最晚的那条）', ov.ascending === true && ov.n > 1, JSON.stringify(ov.texts));
  check('浮层那条在屏幕内（不是被挤到视口外）', ov.onScreen === true, JSON.stringify({ onScreen: ov.onScreen }));

  console.log('\n[C1f] 视角**按区间**绑定（换绑不跳转） + 用户拖进度条时自动跟随让开方向');
  // ① 暂停着从第一段直接拖到**第二段中间** ⇒ 视角必须自己换绑到 #5，且**播放头不许动**。
  await evaluate(`(() => { const d = window.viewer.demo; d.pause(); d.seek(30); return true; })()`, sessionId);
  await sleep(500);
  const seg1 = await evaluate(`({ time: Math.round(window.viewer.demo.time), who: ((document.querySelector('#demoDetail .dmp-grid') || {}).title || '').match(/实体号 #[0-9]+/) || [] })`, sessionId);
  await evaluate(`(() => { const d = window.viewer.demo; d.seek(500); return true; })()`, sessionId);
  await sleep(600);
  const seg2 = await evaluate(`({
    time: Math.round(window.viewer.demo.time * 100) / 100,
    playing: window.viewer.demo.playing,
    who: (((document.querySelector('#demoDetail .dmp-grid') || {}).title || '').match(/实体号 #[0-9]+/) || [])[0] || '',
  })`, sessionId);
  console.log('  ' + JSON.stringify({ seg1: seg1.who[0], seg1Time: seg1.time, seg2: seg2.who, seg2Time: seg2.time, playing: seg2.playing }));
  check('暂停着拖到第二段 ⇒ 视角换绑到那一段的实体（#5）', /#5/.test(seg2.who), JSON.stringify(seg2));
  check('换绑**不动播放头**（用户拖到 500 s 就停在 500 s，误差 < 0.2 s）', Math.abs(seg2.time - 500) < 0.2, String(seg2.time));
  check('换绑**不改播放态**（用户按下的暂停仍是暂停，不会自己跑起来）', seg2.playing === false, JSON.stringify({ playing: seg2.playing }));
  // ② 用户**亲手拖滑杆**到两段之间的缺口 ⇒ 不许被强制弹到第二段开头（owner 报的大问题）。
  await evaluate(
    `(() => {
      const sl = document.querySelector('#timelineDemo .tl-slider');
      if (!sl) return false;
      window.viewer.demo.play();
      sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      sl.value = String(Math.round((150 / window.viewer.demo.duration) * 1000));
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      sl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`,
    sessionId,
  );
  await sleep(1500);
  const dragged = await evaluate(`({ time: Math.round(window.viewer.demo.time * 10) / 10 })`, sessionId);
  console.log('  ' + JSON.stringify(dragged));
  check(
    '用户把滑杆拖进缺口 ⇒ 停在原地、不被弹到他重进的那一刻（150 s 附近）',
    dragged.time > 120 && dragged.time < 200,
    String(dragged.time),
  );
  // ③ 用户松手后继续播：缺口跳过权已作废，不会过一会儿又偷偷弹走。
  await sleep(1200);
  const later = await evaluate(`({ time: Math.round(window.viewer.demo.time * 10) / 10, playing: window.viewer.demo.playing })`, sessionId);
  console.log('  ' + JSON.stringify(later));
  check('松手后继续播也不补跳（时间只按播放前进，没有大跳）', later.time > 150 && later.time < 230, JSON.stringify(later));
  // **点他 = 从他最早那一段进去**（owner 实测：从 0 s 点他原先会直接跳到第二段的开头、越过第一段）。
  await evaluate(`(() => { const d = window.viewer.demo; d.pause(); d.seek(0); return true; })()`, sessionId);
  await sleep(300);
  const clickFirst = await evaluate(
    `(() => {
      const btn = Array.from(document.querySelectorAll('#demoRoster .dmp-who')).find((b) => /LuoXuan/.test(b.textContent || ''));
      if (!btn) return null;
      btn.click();
      return { time: window.viewer.demo.time, internals: document.querySelector('#demoDetail .dmp-grid') ? document.querySelector('#demoDetail .dmp-grid').getAttribute('title') : '' };
    })()`,
    sessionId,
  );
  await sleep(400);
  console.log('  ' + JSON.stringify({ time: Math.round(clickFirst?.time ?? -1), entity: ((clickFirst?.internals ?? '').match(/实体号 #[0-9]+/) ?? [''])[0] }));
  check(
    '播放头在 0 s 时点他 ⇒ 进他**第一段**（≈5 s / #7），不再被拽到第二段开头',
    clickFirst !== null && clickFirst.time < 60 && /实体号 #7/.test(clickFirst.internals ?? ''),
    JSON.stringify({ time: clickFirst?.time, entity: ((clickFirst?.internals ?? '').match(/实体号 #[0-9]+/) ?? [''])[0] }),
  );

  console.log('\n[C1a] 喂一份「像 .dem 但截断」的文件 → 解析失败即清空录像信息条（不留上一份的事实）');
  // 走**用户路径**：录像页文件框 `#demoFile` 的 change。文件头魔数 `HL2DEMO` 让它被识别为 `.dem`
  // 并交给 `parseSourceDemo`，随后因头部截断抛错 —— 这正是 `onParsed(null, ...)` 那条分支。
  await evaluate(
    `(() => {
      const bytes = new TextEncoder().encode('HL2DEMO' + '\\u0000'.repeat(8));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'broken.dem', { type: 'application/octet-stream' }));
      const inp = document.getElementById('demoFile');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    sessionId,
  );
  await sleep(800);
  const broken = await evaluate(
    `({
      meta: document.querySelector('#demoMeta')?.textContent ?? '',
      labels: Array.from(document.querySelectorAll('#demoInfo .mk')).length,
      painted: document.getElementById('demoInfo').getClientRects().length > 0,
    })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(broken));
  check('截断的 .dem 走到解析失败分支（看板给出失败文案）', /解析失败/.test(broken.meta), broken.meta.slice(0, 120));
  check(
    '解析失败后录像信息条被清空（不留上一份录像的服务器 / 事件数）',
    broken.labels === 0 && broken.painted === false,
    JSON.stringify(broken),
  );

  console.log('\n[C1b] 点开合并行 → 详情落到「当前播放头所在的那条轨迹」并列出同身份的另一个实体');
  // 先把播放头停到一个**确定落在主实体区间内**的时刻（本夹具 `LuoXuan` 的两条轨迹：`#7` 早段
  // tick 316 起、`#5` tick 18426 起 ≈ 276 s）。600 s ≈ tick 40000 ⇒ 只有 `#5` 覆盖 ⇒ 目标 = #5。
  await evaluate(
    `(() => { const d = window.viewer.demo; d.pause(); d.seek(600); return true; })()`,
    sessionId,
  );
  await sleep(300);
  const merged = await evaluate(
    `(() => {
      const btns = Array.from(document.querySelectorAll('#demoRoster .dmp-who'));
      const luo = btns.find((b) => /LuoXuan/.test(b.textContent || ''));
      if (!luo) return null;
      luo.click();
      const grid = document.querySelector('#demoDetail .dmp-grid');
      return {
        internals: grid ? grid.getAttribute('title') || '' : '',
        name: document.querySelector('#demoDetail .dmp-who-name')?.textContent || '',
      };
    })()`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(merged));
  check('真人行点得动且详情跟到这个人（名字与看板一致）', merged !== null && /LuoXuan/.test(merged.name ?? ''), JSON.stringify(merged));
  check(
    '详情落到覆盖播放头的那条轨迹（#5）并点名另一实体（#7）',
    /实体号 #5/.test(merged?.internals ?? '') && /同一身份另有实体 #7/.test(merged?.internals ?? ''),
    JSON.stringify(merged),
  );

  console.log('\n[C2] 录像上场时，播放快捷键不许打到记录会话上');
  // 两条时间轴各绑一份 window keydown：`K` 播放/暂停、`,` / `.` 逐帧、`I` / `O` 设 A-B 区间。
  // 没有「只让上场那条响应」的闸，在看录像时按这些键会把**记录会话**的播放态 / 时间 / 区间一起改掉。
  const beforeKeys = await evaluate(
    `({ time: window.viewer.replay.time, playing: window.viewer.replay.playing, rs: window.viewer.replay.rangeStart, re: window.viewer.replay.rangeEnd })`,
    sessionId,
  );
  await evaluate(
    `(() => {
      for (const code of ['Comma', 'Period', 'KeyI', 'KeyO', 'KeyK']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      }
      return true;
    })()`,
    sessionId,
  );
  await sleep(400);
  const afterKeys = await evaluate(
    `({ time: window.viewer.replay.time, playing: window.viewer.replay.playing, rs: window.viewer.replay.rangeStart, re: window.viewer.replay.rangeEnd })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify({ beforeKeys, afterKeys }));
  check('记录会话时间未被快捷键改动', afterKeys.time === beforeKeys.time, `${afterKeys.time} vs ${beforeKeys.time}`);
  check('记录会话播放态未被快捷键改动', afterKeys.playing === beforeKeys.playing);
  check(
    '记录会话 A-B 区间未被快捷键改动',
    afterKeys.rs === beforeKeys.rs && afterKeys.re === beforeKeys.re,
    `${afterKeys.rs}-${afterKeys.re} vs ${beforeKeys.rs}-${beforeKeys.re}`,
  );

  console.log('\n[D] 切回记录 tab：两边状态各自保留、都不被推进');
  await evaluate(`document.querySelector('.tab[data-tab="replay"]').click()`, sessionId);
  await sleep(1200);
  const st1 = await evaluate(
    `({
      active: window.viewer.session.active,
      replayTime: window.viewer.replay.time,
      demoTracks: window.viewer.demo.trackCount,
      replayTracks: window.viewer.replay.trackCount,
      demoPlaying: window.viewer.demo.playing,
      demoTime: window.viewer.demo.time,
      tlReplayPainted: ${PAINTED('timeline')},
      tlDemoPainted: ${PAINTED('timelineDemo')},
    })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(st1));
  check('活动会话切回 replay', st1.active === 'replay', String(st1.active));
  check('录像会话停表', st1.demoPlaying === false);
  check('两边轨道都还在（记录 1 / 录像 ≥1）', st1.replayTracks === 1 && st1.demoTracks >= 1, JSON.stringify(st1));
  check('记录时间轴回到可见', st1.tlReplayPainted === true);
  check('录像时间轴随录像面板收起', st1.tlDemoPainted === false);
  // **基准取「切走之后」的那一刻**：切换前取样会把「点击之前仍在播放的那几帧」算成漂移
  // （实测两次运行差 0～33 ms，属取样窗口而非产品行为）。
  const frozenAt = st1.demoTime;

  await sleep(2500);
  const st2 = await evaluate(
    `({
      demoTracks: window.viewer.demo.trackCount,
      replayTracks: window.viewer.replay.trackCount,
      demoTime: window.viewer.demo.time,
    })`,
    sessionId,
  );
  check('录像会话时间冻结（切走后不再推进）', Math.abs(st2.demoTime - frozenAt) < 1e-9, `${st2.demoTime} vs ${frozenAt}`);
  check('录像轨道没被记录侧清掉或改写', st2.demoTracks === st1.demoTracks, `${st2.demoTracks} vs ${st1.demoTracks}`);

  console.log('\n[E] 记录 tab 内播放不影响录像侧');
  await evaluate(`(() => { const r = window.viewer.replay; r.seek(0); r.play(); return true; })()`, sessionId);
  await sleep(1500);
  const st3 = await evaluate(
    `({
      replayTime: window.viewer.replay.time,
      replayPlaying: window.viewer.replay.playing,
      demoTime: window.viewer.demo.time,
      demoPlaying: window.viewer.demo.playing,
    })`,
    sessionId,
  );
  console.log('  ' + JSON.stringify(st3));
  check('记录会话在走', st3.replayPlaying === true && st3.replayTime > 0, JSON.stringify(st3));
  check('录像会话纹丝不动', st3.demoPlaying === false && Math.abs(st3.demoTime - frozenAt) < 1e-9, `${st3.demoTime} vs ${frozenAt}`);
  await evaluate('window.viewer.replay.pause()', sessionId);

  console.log('\n[F] 控制台');
  console.log(`  exceptions=${exceptions.length} consoleErrors=${consoleErrors.length}`);
  for (const e of exceptions.slice(0, 5)) console.log('   ! ' + e.split('\n')[0]);
  for (const e of consoleErrors.slice(0, 5)) console.log('   ! ' + e);
  check('无未捕获异常', exceptions.length === 0);
}

try {
  await main();
} catch (e) {
  failures++;
  console.log(`\n[FATAL] ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  try {
    socket?.close();
  } catch {
    /* 忽略 */
  }
  try {
    edge.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
  // Windows 上 kill 不保证杀净进程树：补一刀 taskkill /T（不带 /F 之外的可抛出路径）
  try {
    spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  server.close();
  await sleep(800);
  console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}
