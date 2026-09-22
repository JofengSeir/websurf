/**
 * 用 CDP 驱动本机 Edge（headless + SwiftShader WebGL）跑一遍 viewer 的录像链路。
 * 目的：抓运行时异常——typecheck 与 Node 自检都覆盖不到 UI 接线。
 *
 * 前置：
 *   1. 先起页面服务：`npm run dev`（viewer 的 dev 端口 8100，见 apps/viewer/package.json）；
 *      脚本内置缺省 SMOKE_URL 是 http://127.0.0.1:8080/web/index.html，端口不同须用 SMOKE_URL 覆盖；
 *      也可指向 dist 产物：SMOKE_URL=file:///…/dist/index.html
 *   2. 需要 ws 包（`npm i ws`，或用 WS_PATH 指向已有的安装）
 *   3. 需要 Edge/Chromium（用 EDGE_PATH 覆盖默认路径）
 *
 * 用法：npm run local:smoke
 *   环境变量：EDGE_PATH / WS_PATH / SMOKE_URL / SMOKE_PORT / SMOKE_FILE_REPLAY
 *   缺省用 CDP 把本地 test/maps/surf_null_4.replay 塞进「选择录像文件」input（与用户点选同链路）；
 *   SMOKE_URL 带 ?replay= / ?bsp= 时改走深链自动导入。
 *   夹具或地图缺失时 loud skip：打印 SKIP、不计入 failures。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';

const VIEWER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.SMOKE_PORT ?? 9333);
const URL_ = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080/web/index.html';
// 缺省夹具：<仓库根>/test/maps/surf_null_4.replay（SMOKE_FILE_REPLAY 可覆盖）；深链跑不需要文件选择
const LOCAL_REPLAY =
  process.env.SMOKE_FILE_REPLAY ?? join(VIEWER_ROOT, '..', '..', 'test', 'maps', 'surf_null_4.replay');

async function loadWs() {
  try {
    return (await import('ws')).default;
  } catch {
    /* 裸 ws 不可用：改用 WS_PATH 指向的副本 */
  }
  const p =
    process.env.WS_PATH ??
    'C:/Users/Jofen/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
  return (await import(`file:///${p}`)).default;
}

const WebSocket = await loadWs();

const logs = [];
const errors = [];

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpdir()}\\websurf-edge-cdp-smoke`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 端口未就绪：继续轮询 */
    }
    await sleep(500);
  }
  throw new Error('Edge 调试端口没起来');
}

let seq = 0;
const pending = new Map();
let socket = null;

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  socket.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`));
    }, 30000);
  });
}

async function evaluate(expr, sessionId) {
  // send 解出的是 msg.result：Runtime.evaluate 的 { result: { type, value }, exceptionDetails? }；
  // 出现 exceptionDetails 时由本函数抛错（页面内异常按失败处理），否则返回 result.value
  const res = await send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(
      `页面异常：${d.exception?.description ?? d.text}` +
        (d.stackTrace?.callFrames?.[0]
          ? ` @ ${d.stackTrace.callFrames[0].url}:${d.stackTrace.callFrames[0].lineNumber}`
          : ''),
    );
  }
  return res?.result?.value;
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// ── [0] dist 结构静态断言：按 single 模式（file:// 双击）产物写 —— classic ./app.js、根目录无 worker.js/*.wasm；
//     dist/index.html 缺失即整段跳过。--multi 产物不适用这几条（module script + 外置 wasm + 根目录 worker.js）──
console.log('\n[0] dist 结构 + play.cmd 静态断言');
const distRoot = join(VIEWER_ROOT, 'dist');
if (!existsSync(join(distRoot, 'index.html'))) {
  console.log('  skip  dist/ 未构建（先 npm run build:dist）；跳过静态断言');
} else {
  const distHtml = readFileSync(join(distRoot, 'index.html'), 'utf8');
  check('index.html 用 classic script ./app.js', distHtml.includes('<script src="./app.js">'), 'module 残留?');
  check('index.html 无 <script type="module"', !distHtml.includes('<script type="module"'));
  const appJs = readFileSync(join(distRoot, 'app.js'), 'utf8');
  check('app.js 内嵌 __VBSP_WASM_B64__', appJs.includes('__VBSP_WASM_B64__'));
  check('app.js 内嵌 __VBSP_WORKER_JS__', appJs.includes('__VBSP_WORKER_JS__'));
  check('dist 根无 worker.js / *.wasm', !existsSync(join(distRoot, 'worker.js')) && !existsSync(join(distRoot, 'websurf_viewer_wasm_bg.wasm')));
  check('dist/play.cmd 存在', existsSync(join(distRoot, 'play.cmd')));
  check('dist-multi/ 不存在（单一 dist）', !existsSync(join(VIEWER_ROOT, 'dist-multi')));
  // 示例录像 dist/assets/maps/surf_null_4.replay 由 build 从本地源 test/maps/surf_null_4.replay 复制；
  // 源不存在时 build 只告警并跳过，本断言随之跳过（不误判为失败）。
  if (existsSync(LOCAL_REPLAY)) {
    check(
      'dist/assets/maps/surf_null_4.replay 存在（原生示例，HTTP 深链可用）',
      existsSync(join(distRoot, 'assets', 'maps', 'surf_null_4.replay')),
    );
  } else {
    console.log('  skip  dist/assets/maps/surf_null_4.replay（本地源 test/maps/surf_null_4.replay 不存在，build 未打包该示例）');
  }

  const playCmd = readFileSync(join(distRoot, 'play.cmd'), 'utf8');
  check('play.cmd 含 serve.py', playCmd.includes('serve.py'));
  check('play.cmd 含 http://localhost:', playCmd.includes('http://localhost:'));
  check('play.cmd 含 npx serve 备选', playCmd.includes('npx serve'));
  // play.cmd 的 python 缺失提示是纯 ASCII 英文（断言取子串 python not found）
  check('play.cmd 含 python 缺失提示（ASCII）', playCmd.includes('python not found'));
  check('play.cmd 不含旧 start-local', !playCmd.includes('start-local'));
  // 启动脚本不得引用 .replay.json / .rule.json（两者在当前链路中不存在）
  check(
    'play.cmd 无 .replay.json/.rule.json 残留',
    !playCmd.includes('.replay.json') && !playCmd.includes('.rule.json'),
  );
  const playSh = readFileSync(join(distRoot, 'play.sh'), 'utf8');
  check(
    'play.sh 无 .replay.json/.rule.json 残留',
    !playSh.includes('.replay.json') && !playSh.includes('.rule.json'),
  );
}

/** 轮询等轨迹行数达到 want（headless 下 DOM 更新有滞后，不用固定 sleep）；超时返回最后一次计数。 */
async function waitRows(sessionId, want, timeoutMs = 20000) {
  const t0 = Date.now();
  let rows = 0;
  while (Date.now() - t0 < timeoutMs) {
    rows = await evaluate(
      "document.querySelectorAll('#pane-replay .track-row').length",
      sessionId,
    );
    if (rows >= want) return rows;
    await sleep(400);
  }
  return rows;
}

/** 用 CDP 把本地文件塞进 <input type=file>：change 由它触发，与用户点选同一链路（file:// 与 http 同）。 */
async function setFileInput(sessionId, selector, filePath) {
  const { root } = await send('DOM.getDocument', {}, sessionId);
  const { nodeId } = await send(
    'DOM.querySelector',
    { nodeId: root.nodeId, selector },
    sessionId,
  );
  if (!nodeId) throw new Error(`找不到文件输入框 ${selector}`);
  await send('DOM.setFileInputFiles', { nodeId, files: [filePath] }, sessionId);
}

try {
  const version = await waitForDevtools();
  socket = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    socket.once('open', res);
    socket.once('error', rej);
  });

  // 日志按 session 归桶：主 session 进 logs/errors（[13] 检查）；[12b] 的独立 BSP target 只把 error 收进 bspErrors
  let mainSessionId = null;
  let bspSessionId = null;
  const bspErrors = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const isMain = msg.sessionId === mainSessionId;
    const isBsp = msg.sessionId != null && msg.sessionId === bspSessionId;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      if (isMain) {
        logs.push(`${msg.params.type}: ${text}`);
        if (msg.params.type === 'error') errors.push(text);
      } else if (isBsp && msg.params.type === 'error') {
        bspErrors.push(text);
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      if (isMain) {
        const d = msg.params.exceptionDetails;
        errors.push(d.exception?.description ?? d.text);
      } else if (isBsp) {
        const d = msg.params.exceptionDetails;
        bspErrors.push(d.exception?.description ?? d.text);
      }
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (isMain) {
        logs.push(`log.${e.level}: ${e.text}`);
        if (e.level === 'error') errors.push(e.text);
      } else if (isBsp && e.level === 'error') {
        bspErrors.push(e.text);
      }
    }
  });

  // 复用启动参数里的 about:blank page target：后续导航与事件都挂在这个 session 上
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 page target');
  const { sessionId } = await send('Target.attachToTarget', {
    targetId: page.id,
    flatten: true,
  });
  mainSessionId = sessionId;

  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const useDeepLink = /[?&](replay|bsp)=/.test(URL_);

  console.log('\n[1] 打开页面');
  const nav = await send('Page.navigate', { url: URL_ }, sessionId);
  if (nav?.errorText) throw new Error(`导航失败：${nav.errorText}（dev server 起了吗？）`);
  await sleep(5000);
  const href = await evaluate('location.href', sessionId);
  check('已导航到 viewer', String(href).includes('index.html'), String(href));
  const fatalShown = await evaluate(
    "document.getElementById('fatal')?.classList.contains('show')",
    sessionId,
  );
  check('没有触发启动兜底卡（WebGL 正常）', fatalShown === false, `fatalShown=${fatalShown}`);
  const webgl = await evaluate(
    "(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()",
    sessionId,
  );
  check('WebGL 可用', webgl === true, String(webgl));

  console.log('\n[1b] localStorage 卫生（防跨运行污染顶替「坐标映射默认直读」）');
  await evaluate('(() => { localStorage.clear(); location.reload(); return true; })()', sessionId);
  await sleep(4000); // 重载 + 应用初始化
  const reloaded = await evaluate(
    "document.getElementById('game') !== null && document.getElementById('fatal')?.classList.contains('show') !== true",
    sessionId,
  );
  check('清空 localStorage 后页面重载正常', reloaded === true);

  console.log('\n[2] 切到「录像」标签页');
  await evaluate(
    "document.querySelector('.tab[data-tab=\"replay\"]').click()",
    sessionId,
  );
  await sleep(600);
  const paneActive = await evaluate(
    "document.getElementById('pane-replay').classList.contains('active')",
    sessionId,
  );
  check('录像面板已激活', paneActive === true);
  const sections = await evaluate(
    "Array.from(document.querySelectorAll('#pane-replay .sec-title')).map(e => e.textContent)",
    sessionId,
  );
  console.log('  面板分区：' + JSON.stringify(sections));
  for (const need of ['导入', '轨迹列表', '坐标映射', '调整工具']) {
    check(`存在「${need}」分区`, sections.includes(need));
  }

  const modeLabel = useDeepLink
    ? '深链自动导入（?replay= 原生 .replay）'
    : `本地真实 .replay（CDP 文件选择：${LOCAL_REPLAY}）`;
  console.log(`\n[3] ${modeLabel}`);
  const haveReplay = useDeepLink || existsSync(LOCAL_REPLAY);
  if (useDeepLink) {
    // 深链（?replay= / ?bsp=）由页面自身自动导入，本脚本不操作
  } else if (!haveReplay) {
    // 夹具缺失：只打印 SKIP，不抛错、不计入 failures（与 [12b] 的地图缺失处理一致）
    console.log(`[SKIP] 本地录像缺失（${LOCAL_REPLAY}）——跳过 [3] 真实录像导入及依赖它的 [3]-[11] 断言`);
  } else {
    // 把本地 .replay 塞进「选择录像文件」input：走与用户点选相同的
    // change → loadFile → 嗅探 → 解码链路
    await setFileInput(sessionId, '#pane-replay input[type=file]', LOCAL_REPLAY);
    await sleep(500);
  }

  if (haveReplay) {
  const rows = await waitRows(sessionId, 1);
  check('轨迹列表出现 1 行', rows === 1, `rows=${rows}`);
  const trackCount = await evaluate(
    "window.viewer?.replay?.trackCount ?? null",
    sessionId,
  );
  check('trackCount = 1', trackCount === 1, String(trackCount));
  const tlHidden = await evaluate(
    "document.getElementById('timeline').classList.contains('hidden')",
    sessionId,
  );
  check('时间轴已显示', tlHidden === false);
  const info = await evaluate(
    "document.querySelector('#pane-replay .track-meta')?.textContent ?? ''",
    sessionId,
  );
  console.log('  轨道信息：' + info);
  check('轨道信息含帧数', /\d[\d,]* 帧/.test(info), info);
  check('轨道帧数 = 1,211（真实文件）', info.includes('1,211 帧'), info);
  const modeNow = await evaluate(
    "window.viewer?.replay?.mode ?? null",
    sessionId,
  );
  check('载入录像后默认第一人称', modeNow === 'first', String(modeNow));

  console.log('\n[3b] 头部元信息展示（#replayMeta，数据源 = Clip.meta）');
  const metaText = await evaluate(
    "document.getElementById('replayMeta')?.textContent ?? ''",
    sessionId,
  );
  console.log('  信息条：' + metaText);
  // 以下数值取自 test/maps/surf_null_4.replay 头部，与 apps/viewer/test/replay-selftest.ts 的真实文件段同源
  check('信息条含成绩 16.21 s', metaText.includes('成绩') && metaText.includes('16.21 s'), metaText);
  check('信息条含玩家 [U:1:196340649]', metaText.includes('[U:1:196340649]'), metaText);
  check('信息条含地图 surf_null · Bonus 4', metaText.includes('surf_null') && metaText.includes('Bonus 4'), metaText);
  check('信息条含 tick 66.67', metaText.includes('66.67'), metaText);
  check('信息条含帧 113+1080+18', metaText.includes('113+1080+18'), metaText);
  check('信息条含格式 v12', metaText.includes('v12'), metaText);
  const metaApi = await evaluate('window.viewer.replay.meta()', sessionId);
  check(
    'meta() API 返回真实头部（time≈16.207 / tickrate≈66.67 / track=4 / steamId）',
    metaApi &&
      Math.abs(metaApi.time - 16.20744) < 0.001 &&
      Math.abs(metaApi.tickrate - 66.66667) < 0.01 &&
      metaApi.track === 4 &&
      metaApi.steamId === 196340649 &&
      metaApi.preFrames === 113 &&
      metaApi.frameCount === 1080,
    JSON.stringify(metaApi),
  );

  console.log('\n[3b2] 遥测 HUD（速度 = game 同款单行；按键 = #timeline 右列）');
  const tmState = await evaluate(
    `(() => {
      const t = document.getElementById('telemetry');
      const keys = [...document.querySelectorAll('#timeline .tm-key')].map((k) => ({
        label: k.textContent, on: k.classList.contains('on'),
      }));
      return {
        hidden: t ? t.classList.contains('hidden') : null,
        horiz: t?.querySelector('.tm-horiz')?.textContent ?? '',
        vert: t?.querySelector('.tm-vert')?.textContent ?? '',
        sep: !!t?.querySelector('.vsep'),
        keys,
      };
    })()`,
    sessionId,
  );
  check('速度 HUD 可见（有轨道即显示）', tmState && tmState.hidden === false, JSON.stringify(tmState));
  check(
    '横向速度读数非占位（vel 差分，textContent = 纯数字）',
    tmState && /^[0-9]+$/.test(tmState.horiz),
    String(tmState?.horiz),
  );
  check(
    '竖向速度读数存在（绝对值口径，与 game 同款）',
    tmState && /^[0-9]+$/.test(tmState.vert),
    String(tmState?.vert),
  );
  check('速度为单行「横向｜竖向」结构（vsep 分隔）', tmState && tmState.sep === true, String(tmState?.sep));
  check(
    '按键簇六键齐备且位于 #timeline（W/A/S/D/跳/蹲）',
    tmState && tmState.keys.length === 6 &&
      ['W', 'A', 'S', 'D', '跳', '蹲'].every((l) => tmState.keys.some((k) => k.label === l)),
    JSON.stringify(tmState?.keys),
  );

  console.log('\n[3c] 播放基准（帧自身坐标直读，无起点锚定）');
  const tracks0 = await evaluate('window.viewer.replay.tracks()', sessionId);
  // 帧 0 是 prerun 首帧：坐标按 viewer 轴序 [y,z,x] 直读；若叠加了起点锚定，这里会整体平移
  const base0 = tracks0[0]?.firstPos;
  check(
    'firstPos = 帧自身坐标（12187.20, -1791.97, 2375.04）',
    base0 &&
      Math.abs(base0[0] - 12187.2012) < 0.01 &&
      Math.abs(base0[1] + 1791.9688) < 0.01 &&
      Math.abs(base0[2] - 2375.0391) < 0.01,
    JSON.stringify(base0),
  );
  const stDur = await evaluate('window.viewer.replay', sessionId);
  check(
    '总时长 = (1211-113)/66.667 ≈ 16.455 s（主时钟 0 = 起跑帧）',
    Math.abs(stDur.duration - 16.455) < 0.05,
    String(stDur.duration),
  );

  console.log('\n[4] 播放控制');
  const dur = await evaluate(
    "document.querySelector('.tl-time')?.textContent ?? ''",
    sessionId,
  );
  console.log('  时间读数：' + dur);
  check('时长非零', !/0\.00 \/ 0\.00/.test(dur), dur);
  const playClicked = await evaluate(
    "(() => { const b = Array.from(document.querySelectorAll('#timeline button')).find(x => x.textContent.trim() === '播放'); if (!b) return false; b.click(); return true; })()",
    sessionId,
  );
  check('找到并点击「播放」', playClicked === true);
  await sleep(1500);
  const dur2 = await evaluate("document.querySelector('.tl-time')?.textContent ?? ''", sessionId);
  check('播放后时间在推进', dur !== dur2, `${dur} → ${dur2}`);
  const pauseClicked = await evaluate(
    "(() => { const b = Array.from(document.querySelectorAll('#timeline button')).find(x => x.textContent.trim() === '暂停'); if (!b) return false; b.click(); return true; })()",
    sessionId,
  );
  check('找到并点击「暂停」', pauseClicked === true);

  console.log('\n[5] A-B 区间');
  await evaluate("document.querySelector('.tl-slider').value = 300; document.querySelector('.tl-slider').dispatchEvent(new Event('input'))", sessionId);
  await sleep(300);
  const aClicked = await evaluate(
    "(() => { const b = Array.from(document.querySelectorAll('#timeline button')).find(x => x.textContent.trim() === 'A 起点'); if (!b) return false; b.click(); return true; })()",
    sessionId,
  );
  check('找到并点击「A 起点」', aClicked === true);
  await sleep(300);
  const rangeText = await evaluate("document.querySelector('.tl-range')?.textContent ?? ''", sessionId);
  console.log('  区间读数：' + rangeText);
  check('区间已生效（读数不再是「整段」）', rangeText !== '整段', rangeText);

  console.log('\n[6] 幽灵与轨迹线已进场景');
  const sceneInfo = await evaluate(
    "window.viewer?.replay ?? null",
    sessionId,
  );
  console.log('  场景统计：' + JSON.stringify(sceneInfo));

  console.log('\n[7] 调整工具（transform 后处理，替换而非追加）');
  const tracksBeforeTf = await evaluate('window.viewer.replay.tracks()', sessionId);
  const durBeforeTf = (await evaluate('window.viewer.replay', sessionId)).duration;
  await evaluate(
    `(() => {
      const x = document.getElementById('tf-offX');
      if (!x) return false;
      x.value = '500';
      x.dispatchEvent(new Event('input'));
      return true;
    })()`,
    sessionId,
  );
  await sleep(1800); // 0.5s 防抖 + 重新导入
  const stTf = await evaluate('window.viewer.replay', sessionId);
  const tracksAfterTf = await evaluate('window.viewer.replay.tracks()', sessionId);
  check('改变换后仍是 1 条（替换当前轨道）', stTf.trackCount === 1, JSON.stringify(stTf));
  check('变换只动坐标不改时长', Math.abs(stTf.duration - durBeforeTf) < 0.01, `${durBeforeTf} → ${stTf.duration}`);
  check(
    '平移 500 真实作用到坐标（firstPos.x + 500）',
    tracksAfterTf.length === 1 &&
      Math.abs(tracksAfterTf[0].firstPos[0] - (tracksBeforeTf[0].firstPos[0] + 500)) < 1,
    `${JSON.stringify(tracksBeforeTf[0]?.firstPos)} → ${JSON.stringify(tracksAfterTf[0]?.firstPos)}`,
  );
  const resetClicked = await evaluate(
    "(() => { const b = Array.from(document.querySelectorAll('#pane-replay button')).find(x => x.textContent.trim() === '重置变换'); if (!b) return false; b.click(); return true; })()",
    sessionId,
  );
  check('找到并点击「重置变换」', resetClicked === true);
  await sleep(1500);
  const stReset = await evaluate('window.viewer.replay', sessionId);
  const tracksReset = await evaluate('window.viewer.replay.tracks()', sessionId);
  check('重置变换后仍 1 条', stReset.trackCount === 1, JSON.stringify(stReset));
  check(
    '重置后坐标回到基线',
    tracksReset.length === 1 &&
      Math.abs(tracksReset[0].firstPos[0] - tracksBeforeTf[0].firstPos[0]) < 1,
    JSON.stringify(tracksReset[0]?.firstPos),
  );

  console.log('\n[7b] 多轨迹（Q2）：同一录像再选一次 → 追加第二条');
  if (useDeepLink) {
    // 深链跑虽已自动导入，文件选择链路依旧可用：这里再选一次同一份本地文件 → 追加第二条
  }
  await setFileInput(sessionId, '#pane-replay input[type=file]', LOCAL_REPLAY);
  await sleep(2500);
  const rows2 = await waitRows(sessionId, 2);
  check('轨迹列表变成 2 行', rows2 === 2, `rows=${rows2}`);
  const colors = await evaluate(
    "Array.from(document.querySelectorAll('#pane-replay .track-dot')).map(e => e.style.background)",
    sessionId,
  );
  check('两条轨迹配色不同', colors.length === 2 && colors[0] !== colors[1], JSON.stringify(colors));

  console.log('\n[8] 轨道时间偏移：第二条 +5s → 总长 +5s');
  const st2 = await evaluate('window.viewer.replay', sessionId);
  check('trackCount = 2', st2.trackCount === 2, JSON.stringify(st2));
  const beforeOffset = st2.duration;
  await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#pane-replay .track-row'));
      const input = rows[1].querySelector('.track-off');
      input.value = '5';
      input.dispatchEvent(new Event('input'));
      return true;
    })()`,
    sessionId,
  );
  await sleep(400);
  const st3 = await evaluate('window.viewer.replay', sessionId);
  check(
    '偏移 5s 后总长增加 5s',
    Math.abs(st3.duration - (beforeOffset + 5)) < 0.01,
    `${beforeOffset} → ${st3.duration}`,
  );

  console.log('\n[9] 拖入合成 V2 .replay（drop 链路 → 追加第三条）');
  // 最小 V2 文件：第 1 行 "<帧数>:{SHAVITREPLAYFORMAT}{V2}\n" + 2 帧 × 6 cell
  // （pos x/y/z、pitch、yaw 各 f32 + buttons i32）；帧 0 = Source (10,20,30)、yaw=30
  const dropped = await evaluate(
    `(() => {
      const bytes = [];
      const line = '2:{SHAVITREPLAYFORMAT}{V2}\\n';
      for (let i = 0; i < line.length; i++) bytes.push(line.charCodeAt(i) & 0xff);
      const push = (x, signed) => {
        const dv = new DataView(new ArrayBuffer(4));
        if (signed) dv.setInt32(0, x, true); else dv.setFloat32(0, x, true);
        for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i));
      };
      const frames = [[10, 20, 30, 0, 30], [20, 20, 30, 0, 30]];
      for (const [x, y, z, pi, ya] of frames) {
        push(x, false); push(y, false); push(z, false); push(pi, false); push(ya, false); push(8, true);
      }
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'smoke-v2.replay', { type: 'application/octet-stream' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      return bytes.length;
    })()`,
    sessionId,
  );
  check('合成 V2 已投递（75 字节）', dropped === 75, String(dropped));
  await sleep(2000);
  const rows3 = await waitRows(sessionId, 3);
  check('拖入后 3 行', rows3 === 3, `rows=${rows3}`);
  const stV2 = await evaluate('window.viewer.replay', sessionId);
  check('trackCount = 3', stV2.trackCount === 3, JSON.stringify(stV2));

  console.log('\n[9b] 坐标映射切换（当前文件 = 合成 V2 → 替换 track-3）');
  // 默认 shavit 轴序：Source[x,y,z] → viewer[y,z,x] ⇒ firstPos = [20,30,10]
  const fpBeforeToggle = (await evaluate('window.viewer.replay.tracks()', sessionId))[2]?.firstPos;
  check(
    '默认轴序（shavit）：firstPos = [20,30,10]',
    fpBeforeToggle &&
      Math.abs(fpBeforeToggle[0] - 20) < 0.01 &&
      Math.abs(fpBeforeToggle[1] - 30) < 0.01 &&
      Math.abs(fpBeforeToggle[2] - 10) < 0.01,
    JSON.stringify(fpBeforeToggle),
  );
  const toggleBox = (nth) =>
    `(() => {
      const sec = Array.from(document.querySelectorAll('#pane-replay .sec'))
        .find(s => s.querySelector('.sec-title')?.textContent === '坐标映射');
      if (!sec) return false;
      const box = sec.querySelectorAll('input[type=checkbox]')[${nth}];
      if (!box) return false;
      box.click();
      return true;
    })()`;
  await evaluate(toggleBox(0), sessionId); // 轴序 → 直读 [x,y,z]
  await sleep(1800);
  const fpRaw = (await evaluate('window.viewer.replay.tracks()', sessionId))[2]?.firstPos;
  check(
    '切换「直读 [x,y,z]」：firstPos = [10,20,30]',
    fpRaw &&
      Math.abs(fpRaw[0] - 10) < 0.01 &&
      Math.abs(fpRaw[1] - 20) < 0.01 &&
      Math.abs(fpRaw[2] - 30) < 0.01,
    JSON.stringify(fpRaw),
  );
  await evaluate(toggleBox(0), sessionId); // 切回默认
  await sleep(1800);
  const stAfterToggle = await evaluate('window.viewer.replay', sessionId);
  const fpBack = (await evaluate('window.viewer.replay.tracks()', sessionId))[2]?.firstPos;
  check('切回后仍 3 条（替换语义，不追加）', stAfterToggle.trackCount === 3, JSON.stringify(stAfterToggle));
  check('切回默认轴序：firstPos 回 [20,30,10]', fpBack && Math.abs(fpBack[0] - 20) < 0.01, JSON.stringify(fpBack));

  console.log('\n[10] 跟随切换与移除（含信息条跟随刷新）');
  await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#pane-replay .track-row'));
      rows[1].querySelectorAll('.track-btn')[1].click();  // ◎ 设为跟随
      return true;
    })()`,
    sessionId,
  );
  await sleep(300);
  const st4 = await evaluate('window.viewer.replay', sessionId);
  check('跟随切到第二条', st4.followId === 'track-2', String(st4.followId));
  const metaNameAt2 = await evaluate(
    "document.querySelector('#replayMeta .meta-name span:last-child')?.textContent ?? ''",
    sessionId,
  );
  check('信息条跟随显示第二条名', metaNameAt2 === 'surf_null_4.replay', metaNameAt2);
  // API 跟随切换后信息条必须重渲染：follow 路径同样会刷新元信息行。
  // window.viewer.replay 是快照 getter：变更后要重新取一次才能读到新值，同一次取值内读到的是旧值。
  await evaluate("window.viewer.replay.follow('track-3')", sessionId);
  await sleep(300);
  const followed3 = await evaluate('window.viewer.replay.followId', sessionId);
  const metaNameAt3 = await evaluate(
    "document.querySelector('#replayMeta .meta-name span:last-child')?.textContent ?? ''",
    sessionId,
  );
  check('API follow(track-3) 生效', followed3 === 'track-3', String(followed3));
  check(
    'API 跟随切换后信息条同步刷新（smoke-v2.replay）',
    metaNameAt3 === 'smoke-v2.replay',
    metaNameAt3,
  );
  await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#pane-replay .track-row'));
      rows[1].querySelector('.track-btn.danger').click();  // × 移除第二条
      return true;
    })()`,
    sessionId,
  );
  await sleep(500);
  const st5 = await evaluate('window.viewer.replay', sessionId);
  check('移除后回到 2 条', st5.trackCount === 2, JSON.stringify(st5));
  // 移除的是非跟随轨道（跟随目标在 track-3）⇒ followId 保持不变：
  // apps/viewer/src/replay/tracks.ts 的 remove 只在被移除 id 等于 followId 时回退到 tracks[0]?.id ?? null
  check('移除非跟随轨道后跟随保持 track-3', st5.followId === 'track-3', String(st5.followId));

  console.log('\n[11] 播放控制 API（window.viewer.replay）');
  // 先点「整段」清掉 [5] 设下的 A-B 区间：否则 seek 会被夹在区间内
  const rangeCleared = await evaluate(
    "(() => { const b = Array.from(document.querySelectorAll('#timeline button')).find(x => x.textContent.trim() === '整段'); if (!b) return false; b.click(); return true; })()",
    sessionId,
  );
  check('找到并点击「整段」清除区间', rangeCleared === true);
  await evaluate(
    `(() => {
      const r = window.viewer.replay;
      r.pause(); r.seek(5); r.setSpeed(2); r.setMode('third');
      return true;
    })()`,
    sessionId,
  );
  // window.viewer.replay 是快照 getter：变更后再取一次快照读值
  const api1 = await evaluate(
    "(() => { const r = window.viewer.replay; return { seeked: r.time, speed: r.speed, mode: r.mode }; })()",
    sessionId,
  );
  check('seek(5) 生效（秒，主时钟）', Math.abs(api1.seeked - 5) < 0.01, JSON.stringify(api1));
  check('setSpeed 生效', api1.speed === 2, JSON.stringify(api1));
  check('setMode 生效', api1.mode === 'third', JSON.stringify(api1));
  await evaluate("(() => { const r = window.viewer.replay; r.setMode('first'); r.play(); return true; })()", sessionId);
  await sleep(500);
  const playingNow = await evaluate('window.viewer.replay.playing', sessionId);
  check('play() 后在播', playingNow === true, String(playingNow));
  await evaluate('window.viewer.replay.pause()', sessionId);
  await evaluate('window.viewer.replay.setSpeed(1)', sessionId);
  const tracksInfo = await evaluate('window.viewer.replay.tracks()', sessionId);
  check(
    'tracks() 只读信息（真实 + 合成两条）',
    Array.isArray(tracksInfo) &&
      tracksInfo.length === 2 &&
      tracksInfo[0].id === 'track-1' &&
      tracksInfo[0].frames === 1211 &&
      tracksInfo[1].id === 'track-3',
    JSON.stringify(tracksInfo),
  );
  const followBack = await evaluate(
    "(() => { window.viewer.replay.follow(null); return window.viewer.replay.followId; })()",
    sessionId,
  );
  check('follow(null) 回第一条', followBack === 'track-1', String(followBack));
  } else {
    console.log('[SKIP] 无真实录像可导入：[3]-[11] 依赖「已加载录像」的断言全部跳过（[12] 地图页 / [12b] BSP / [13] 控制台照常）');
  }

  console.log('\n[12] 地图页（ReferenceGrid 已移除；出生点导航在位）');
  await evaluate("document.querySelector('.tab[data-tab=\"map\"]').click()", sessionId);
  await sleep(400);
  const mapActive = await evaluate(
    "document.getElementById('pane-map').classList.contains('active')",
    sessionId,
  );
  check('地图页已激活', mapActive === true);
  const mapSecs = await evaluate(
    "Array.from(document.querySelectorAll('#pane-map .sec-title')).map(e => e.textContent)",
    sessionId,
  );
  console.log('  地图页分区：' + JSON.stringify(mapSecs));
  check('「参考显示」（ReferenceGrid）已不存在', !mapSecs.includes('参考显示'), JSON.stringify(mapSecs));
  check('「出生点导航」分区在位', mapSecs.includes('出生点导航'), JSON.stringify(mapSecs));
  // surf_null 的首个 info_player_* 是 Source yaw=180：viewer 侧出生朝向走
  // apps/viewer/src/core/spawn.ts 的 spawnPointAng → bspYawToCsYaw（wrap(src+180)）⇒ 初始 yaw = 0°；
  // pitch 取 −src（Source 正 = 俯视），该出生点 src pitch = 0。
  // 出生点回退优先级见 apps/viewer/src/core/spawn.ts 的 resolveInitialSpawn。
  await evaluate("document.querySelector('.tab[data-tab=\"replay\"]').click()", sessionId);

  // [12b]：真实 .bsp 走 #bspFile 用户链路，断言初始相机落在地图几何 bbox 内、
  // spawnSource 命中玩家出生点、yaw/pitch 符合出生点定标。
  // 口径：yaw = wrap(src+180)、pitch = −src（Source 正=俯视）；回退链见 core/spawn.ts。
  // 独立 target（新页面）：与主页面的回放状态隔离——第一人称回放会逐帧覆盖 fly 相机，
  // 在主页面加载 .bsp 读不到初始位姿；该 target 的 console 噪声也不进 [13] 的主页面检查。
  console.log('\n[12b] BSP 加载：初始相机 bbox 相交断言（P2-4 回退 + t1 定标）');
  {
    const { targetId: bspTargetId } = await send('Target.createTarget', { url: URL_ });
    const { sessionId: bspSession } = await send('Target.attachToTarget', {
      targetId: bspTargetId,
      flatten: true,
    });
    bspSessionId = bspSession;
    try {
      await send('Runtime.enable', {}, bspSession);
      await send('Log.enable', {}, bspSession);
      await sleep(5000); // 应用初始化（wasm 懒加载 + 装配）
      const bspReady = await evaluate('!!window.viewer?.map', bspSession);
      check('[12b] BSP 页面装配完成（window.viewer.map）', bspReady === true, String(bspReady));

      const bspCases = [
        {
          file: 'surf_null.bsp',
          expectSource: 'player-spawn',
          expectYaw: 0, // 首个 info_player_* Source yaw=180 → wrap(180+180)=0
          expectPitch: 0, // Source pitch=0 → −0
          oldVoidPos: [11264, -9600, 5792], // 旧 wasm primary（taiikii_bonus_dest），距主出生区 26,200 HU
        },
        {
          file: 'surf_666.bsp',
          expectSource: 'player-spawn',
          expectYaw: 180, // 首个 info_player_* Source yaw=0 → wrap(0+180)=180
          expectPitch: 0,
        },
      ];
      for (const bspCase of bspCases) {
        const bspPath = join(VIEWER_ROOT, '..', '..', 'test', 'maps', bspCase.file);
        if (!existsSync(bspPath)) {
          console.log(`  skip  ${bspCase.file} 不存在（test/maps/），跳过本图断言`);
          continue;
        }
        await setFileInput(bspSession, '#bspFile', bspPath);
        // 等换图真正完成（HUD 状态行以本文件名开头）再断言，避免读到上一张图的位姿
        let loaded = false;
        for (let i = 0; i < 120 && !loaded; i++) {
          const st = await evaluate(
            "document.getElementById('bspStatus')?.textContent ?? ''",
            bspSession,
          );
          if (typeof st === 'string' && st.startsWith(`${bspCase.file}：`)) loaded = true;
          else await sleep(500);
        }
        check(`${bspCase.file} 加载完成（HUD 状态行确认）`, loaded);
        if (!loaded) continue;
        const pose = JSON.parse(await evaluate('JSON.stringify(window.viewer.map.pose())', bspSession));
        const mapBox = JSON.parse(await evaluate('JSON.stringify(window.viewer.map.mapBox())', bspSession));
        console.log(
          `  初始视角 source=${pose.spawnSource} pos=(${pose.pos.map((v) => v.toFixed(0)).join(', ')}) ` +
            `yaw=${pose.yawDeg.toFixed(1)}° pitch=${pose.pitchDeg.toFixed(1)}°`,
        );
        const insideBbox =
          Array.isArray(mapBox?.min) &&
          mapBox.min.every(Number.isFinite) &&
          pose.pos.every((v, k) => v >= mapBox.min[k] && v <= mapBox.max[k]);
        check(
          `${bspCase.file} 初始相机与地图 bbox 相交（P2-4 验收断言）`,
          insideBbox,
          JSON.stringify({ pos: pose.pos, box: mapBox }),
        );
        check(
          `${bspCase.file} 命中玩家出生点（source=${bspCase.expectSource}）`,
          pose.spawnSource === bspCase.expectSource,
          String(pose.spawnSource),
        );
        check(
          `${bspCase.file} 初始 yaw = ${bspCase.expectYaw}°（wrap(src+180)）`,
          Math.abs(pose.yawDeg - bspCase.expectYaw) < 1e-6,
          String(pose.yawDeg),
        );
        check(
          `${bspCase.file} 初始 pitch = ${bspCase.expectPitch}°（−src，Source 正=俯视）`,
          Math.abs(pose.pitchDeg - bspCase.expectPitch) < 1e-6,
          String(pose.pitchDeg),
        );
        if (bspCase.oldVoidPos) {
          const distOld = Math.hypot(...pose.pos.map((v, i) => v - bspCase.oldVoidPos[i]));
          check(
            `${bspCase.file} 初始相机不在旧空域传送点（dist > 10k HU）`,
            distOld > 10000,
            `dist=${distOld.toFixed(0)} HU`,
          );
        }
      }
      // 已知降级：surf 系 GLB 的静态 prop 几何混合 indexed/non-indexed，会让 three 的
      // mergeGeometries 打 console.error；这批网格跳过合并、其余网格照常渲染——过滤只针对
      // 这一族，未捕获异常与其它 error 仍判失败。
      const knownBspNoise = /^THREE\.BufferGeometryUtils: \.mergeGeometries\(\) failed/;
      const realBspErrors = bspErrors.filter((e) => !knownBspNoise.test(e));
      console.log(
        `  （已知降级过滤：mergeGeometries ×${bspErrors.length - realBspErrors.length}，` +
          `其余 error ×${realBspErrors.length}）`,
      );
      check(
        '[12b] BSP 页面无未捕获异常 / 非 mergeGeometries error',
        realBspErrors.length === 0,
        realBspErrors.join(' | '),
      );
    } finally {
      try {
        await send('Target.closeTarget', { targetId: bspTargetId });
      } catch {
        /* 已随 Edge 退出 */
      }
      bspSessionId = null;
    }
  }

  console.log('\n[13] 控制台（累计）');
  const realErrors = errors.filter(
    (e) => !/favicon|Failed to load resource.*favicon/i.test(e),
  );
  if (realErrors.length === 0) console.log('  无 error 级日志 / 未捕获异常');
  else realErrors.forEach((e) => console.log('  ERR ' + e));
  check('无运行时错误', realErrors.length === 0, realErrors.join(' | '));
} catch (e) {
  failures++;
  console.log('\n执行中断：' + (e instanceof Error ? e.message : String(e)));
} finally {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  edge.kill();
  console.log(`\n${failures === 0 ? '冒烟全部通过' : failures + ' 项失败'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
