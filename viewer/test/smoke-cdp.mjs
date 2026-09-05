/**
 * 用 CDP 驱动本机 Edge（headless + SwiftShader WebGL）跑一遍 viewer 的录像链路。
 * 目的：抓运行时异常——typecheck 与 Node 自检都覆盖不到 UI 接线。
 *
 * 前置：
 *   1. 另开终端 `npm run dev`（默认 8080）
 *   2. 需要 `ws`（`npm i ws`，或用 WS_PATH 指向已有的安装）
 *   3. 需要 Edge/Chromium（用 EDGE_PATH 覆盖默认路径）
 *
 * 用法：npm run test:smoke
 *   环境变量：EDGE_PATH / WS_PATH / SMOKE_URL / SMOKE_PORT
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
const URL_ = process.env.SMOKE_URL ?? 'http://127.0.0.1:8080/index.html';

async function loadWs() {
  try {
    return (await import('ws')).default;
  } catch {
    /* 落到隔离工作区的那份 */
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
      /* 还没起来 */
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
  // send 已解出 msg.result，即 Runtime.evaluate 的 { result: {type, value}, exceptionDetails? }
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

// ── [0] 单一 dist 结构静态断言（§6.2.1/§6.2.5；dist 未构建时跳过，不误伤 dev-server 冒烟）──
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
  check('dist 根无 parse-worker.js / *.wasm', !existsSync(join(distRoot, 'parse-worker.js')) && !existsSync(join(distRoot, 'websurf_viewer_wasm_bg.wasm')));
  check('dist/play.cmd 存在', existsSync(join(distRoot, 'play.cmd')));
  check('dist-multi/ 不存在（单一 dist）', !existsSync(join(VIEWER_ROOT, 'dist-multi')));

  const playCmd = readFileSync(join(distRoot, 'play.cmd'), 'utf8');
  check('play.cmd 含 serve.py', playCmd.includes('serve.py'));
  check('play.cmd 含 http://localhost:', playCmd.includes('http://localhost:'));
  check('play.cmd 含 npx serve 备选', playCmd.includes('npx serve'));
  // play.cmd 已 ASCII 化（cmd.exe 对非 ASCII + LF 批处理存在解析失步风险，2026-09-05）
  check('play.cmd 含 python 缺失提示（ASCII）', playCmd.includes('python not found'));
  check('play.cmd 不含旧 start-local', !playCmd.includes('start-local'));
}

/** 等轨迹行渲染出来（headless 下 DOM 渲染偶发滞后，轮询而不是固定 sleep）。 */
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

/** CDP 设置本地文件到 `<input type=file>`（file:// 模式验证「双击打开 + 选择录像文件」用）。 */
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

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      logs.push(`${msg.params.type}: ${text}`);
      if (msg.params.type === 'error') errors.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logs.push(`log.${e.level}: ${e.text}`);
      if (e.level === 'error') errors.push(e.text);
    }
  });

  // 复用已有的 page target（新建 target 再 attach 时导航有时不生效）
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 page target');
  const { sessionId } = await send('Target.attachToTarget', {
    targetId: page.id,
    flatten: true,
  });

  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  // file:// 冒烟前置：把本地配套规则注入 localStorage（page 脚本运行前生效），
  // 顺带覆盖「localStorage 规则载入」路径（本地 replay.json 旁若带 rule.json）。
  const useDeepLink = /[?&](replay|bsp)=/.test(URL_);
  const localReplay = process.env.SMOKE_FILE_REPLAY;
  const seedRulePath =
    !useDeepLink && localReplay ? localReplay.replace(/\.replay\.json$/i, '.rule.json') : null;
  if (seedRulePath) {
    try {
      const ruleText = readFileSync(seedRulePath, 'utf8');
      const parsedRule = JSON.parse(ruleText);
      if (parsedRule.version === 1 && typeof parsedRule.scriptSrc === 'string') {
        await send(
          'Page.addScriptToEvaluateOnNewDocument',
          {
            source: `try { localStorage.setItem(${JSON.stringify('websurf-viewer.replay-rule.v1')}, ${JSON.stringify(ruleText)}); } catch (e) {}`,
          },
          sessionId,
        );
        console.log('  [file:// 前置] 已注入本地规则到 localStorage');
      }
    } catch (e) {
      console.log(`  [file:// 前置] 无配套规则可注入（${e.message}）——使用内置默认规则`);
    }
  }

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
  for (const need of ['导入', '轨迹列表', '变换调整']) {
    check(`存在「${need}」分区`, sections.includes(need));
  }

  const modeLabel = useDeepLink
    ? '深链示例（?replay=…&rule=… 自动导入并应用规则）'
    : localReplay
      ? `本地录像文件（file:// 面板选择：${localReplay}）`
      : '载入示例录像（走完整导入链路）';
  console.log(`\n[3] ${modeLabel}`);
  if (useDeepLink) {
    // URL 深链自动导入，无需操作
  } else if (localReplay) {
    // file:// 双击打开场景：CDP 直接把本地 JSON 塞进「选择 JSON 录像」的 input，
    // 走与真实用户点击选择完全相同的 change → loadFile 链路
    await setFileInput(sessionId, '#pane-replay input[type=file]', localReplay);
    await sleep(500);
  } else {
    const clicked = await evaluate(
      `(() => {
        const btns = Array.from(document.querySelectorAll('#pane-replay button'));
        const b = btns.find(x => x.textContent.trim() === '载入示例录像');
        if (!b) return false;
        b.click();
        return true;
      })()`,
      sessionId,
    );
    check('找到并点击了「载入示例录像」', clicked === true);
  }

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
  const modeNow = await evaluate(
    "window.viewer?.replay?.mode ?? null",
    sessionId,
  );
  check('载入录像后默认第一人称', modeNow === 'first', String(modeNow));

  // [3b] 朝向诊断钩子断言已随功能删除移除（core-simplify-plan P1/P2）

  console.log('\n[4] 播放控制');
  const dur = await evaluate(
    "document.querySelector('.tl-time')?.textContent ?? ''",
    sessionId,
  );
  console.log('  时间读数：' + dur);
  check('时长非零', !/0\.00 \/ 0\.00/.test(dur), dur);
  await evaluate(
    "Array.from(document.querySelectorAll('#timeline button')).find(b => b.textContent.trim() === '播放')?.click()",
    sessionId,
  );
  await sleep(1500);
  const dur2 = await evaluate("document.querySelector('.tl-time')?.textContent ?? ''", sessionId);
  check('播放后时间在推进', dur !== dur2, `${dur} → ${dur2}`);
  await evaluate(
    "Array.from(document.querySelectorAll('#timeline button')).find(b => b.textContent.trim() === '暂停')?.click()",
    sessionId,
  );

  console.log('\n[5] A-B 区间');
  await evaluate("document.querySelector('.tl-slider').value = 300; document.querySelector('.tl-slider').dispatchEvent(new Event('input'))", sessionId);
  await sleep(300);
  await evaluate(
    "Array.from(document.querySelectorAll('#timeline button')).find(b => b.textContent.trim() === 'A 起点')?.click()",
    sessionId,
  );
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

  console.log('\n[8] 多轨迹（Q2）：再载入一份 → 追加第二条');
  await evaluate(
    `(() => {
      const b = Array.from(document.querySelectorAll('#pane-replay button'))
        .find(x => x.textContent.trim() === '载入示例录像');
      b.click();
      return true;
    })()`,
    sessionId,
  );
  await sleep(4000);
  const rows2 = await waitRows(sessionId, 2);
  check('轨迹列表变成 2 行', rows2 === 2, `rows=${rows2}`);
  const colors = await evaluate(
    "Array.from(document.querySelectorAll('#pane-replay .track-dot')).map(e => e.style.background)",
    sessionId,
  );
  check('两条轨迹配色不同', colors.length === 2 && colors[0] !== colors[1], JSON.stringify(colors));
  // 给第二条加偏移，主时钟总长应当变长（基准取加偏移前的总长，规则/录像不同也成立）
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

  // [9] 坐标系标定断言已随功能删除移除（core-simplify-plan P2；替换语义由 Node 自检覆盖）

  console.log('\n[10] 跟随切换与移除');
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
  await evaluate(
    `(() => {
      const rows = Array.from(document.querySelectorAll('#pane-replay .track-row'));
      rows[1].querySelector('.track-btn.danger').click();  // × 移除
      return true;
    })()`,
    sessionId,
  );
  await sleep(500);
  const st5 = await evaluate('window.viewer.replay', sessionId);
  check('移除后回到 1 条', st5.trackCount === 1, JSON.stringify(st5));
  check('移除后跟随回到剩下的那条', st5.followId === 'track-1', String(st5.followId));

  console.log('\n[11] 控制台（累计）');
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
