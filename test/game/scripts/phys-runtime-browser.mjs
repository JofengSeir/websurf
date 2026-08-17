#!/usr/bin/env node
/**
 * test/game 真实浏览器运行时验证（Chrome headless + CDP）
 *
 * 与 phys-random-projectile.mjs（Node 模拟）不同，本脚本直接加载 test/game 的
 * 真实 web 页面（web/index.html + web/app.js + web/worker.js + WASM），通过文件选择
 * 载入真实 .bsp，然后经 __WEBSURF_DEBUG__ 钩子采样：
 *   - 渲染线实际状态（RendererMain.predPhys.state()）
 *   - 权威帧实际状态（sharedState.readAuthoritative()）
 *   - 校准器统计（反向同步次数 / 碰撞驳回次数）
 *
 * 用法：
 *   node scripts/phys-runtime-browser.mjs [map.bsp] [port] [cdpPort]
 * 默认 map: 仓库根 maps/surf_666.bsp
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = join(__dirname, '..');
const MAP = process.argv[2] ?? 'D:/code/project/websurf/maps/surf_666.bsp';
const PORT = Number(process.argv[3] || 8137);
const DEBUG_PORT = Number(process.argv[4] || 9333);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = `http://localhost:${PORT}/web/index.html`;
const SAMPLE_MS = 50;
const DURATION_MS = 5000;
const LOAD_TIMEOUT_MS = 180000;
const MAX_DIVERGENCE = 500;
const MAX_SAMPLE_JUMP_FACTOR = 2.0;

if (!existsSync(MAP)) {
  console.error(`地图不存在: ${MAP}`);
  process.exit(1);
}

const server = spawn('python', ['serve.py', String(PORT), '.'], { cwd: GAME_DIR, stdio: 'ignore' });
let chrome = null;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(URL, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.setTimeout(1500, () => req.destroy(new Error('timeout')));
      });
      return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('本地服务器启动超时');
}

async function waitForCdp() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson(`http://localhost:${DEBUG_PORT}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP 不可用');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleMsgs = [];
    this.exceptionMsgs = [];
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.consoleMsgs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.exceptionMsgs.push(m.params.exceptionDetails?.text ?? 'EXCEPTION');
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function setFileInput(cdp, filePath) {
  const doc = await cdp.send('DOM.getDocument', { depth: 1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#bspFile' });
  if (!q.nodeId) throw new Error('未找到 #bspFile');
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [filePath] });
  // 某些情况下 CDP 设置文件后不会自动触发 change，这里手动补发
  await cdp.evaluate(`(() => {
    const el = document.getElementById('bspFile');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  await waitForServer();
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + process.env.TEMP + '/websurf-runtime-verify',
    '--disable-gpu', '--window-size=1280,720', URL,
  ], { stdio: 'ignore' });

  const page = await waitForCdp();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');

  // 等待调试钩子出现
  const hookDeadline = Date.now() + 15000;
  while (Date.now() < hookDeadline) {
    const has = await cdp.evaluate(`typeof __WEBSURF_DEBUG__ !== 'undefined'`);
    if (has) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const hasHook = await cdp.evaluate(`typeof __WEBSURF_DEBUG__ !== 'undefined'`);
  if (!hasHook) throw new Error('页面未暴露 __WEBSURF_DEBUG__，请确认 web/app.js 已重新构建');

  // 载入真实地图
  console.log(`载入地图: ${MAP}`);
  await setFileInput(cdp, MAP);

  // 等待场景就绪
  const loadStart = Date.now();
  let ready = false;
  while (Date.now() - loadStart < LOAD_TIMEOUT_MS) {
    ready = await cdp.evaluate(`(() => { const s = __WEBSURF_DEBUG__.sample(); return !!(s.ready && s.render && s.auth); })()`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    const status = await cdp.evaluate(`document.getElementById('status')?.textContent ?? ''`);
    console.error(`场景未就绪，status=${status}`);
    console.error('控制台错误:', cdp.exceptionMsgs.join(' | ') || '(无)');
    throw new Error('场景加载超时');
  }
  console.log(`场景就绪，注入持续前进输入后开始采样 ${DURATION_MS / 1000}s（每 ${SAMPLE_MS}ms）...`);
  await cdp.evaluate(`__WEBSURF_DEBUG__.setInput(1)`); // KEY_MASK.forward
  await new Promise((r) => setTimeout(r, 500));

  // 采样
  const samples = [];
  const sampleCount = Math.floor(DURATION_MS / SAMPLE_MS);
  for (let i = 0; i < sampleCount; i++) {
    const s = await cdp.evaluate(`__WEBSURF_DEBUG__.sample()`);
    samples.push(s);
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }

  const statusText = await cdp.evaluate(`document.getElementById('status')?.textContent ?? ''`);
  const fpsText = await cdp.evaluate(`document.getElementById('fps')?.textContent ?? ''`);
  const isolated = await cdp.evaluate(`crossOriginIsolated`);

  console.log(`状态栏: ${statusText}`);
  console.log(`FPS: ${fpsText}`);
  console.log(`crossOriginIsolated: ${isolated}`);
  console.log(`采样数: ${samples.length}`);
  console.log(`控制台错误: ${cdp.exceptionMsgs.length ? cdp.exceptionMsgs.join(' | ') : '(无)'}`);
  const errMsgs = cdp.consoleMsgs.filter((m) => /error|exception|failed|warn/i.test(m));
  const errCounts = new Map();
  for (const m of errMsgs) errCounts.set(m, (errCounts.get(m) ?? 0) + 1);
  if (errCounts.size) {
    console.log(`console error/warn 种类: ${errCounts.size}，总条数: ${errMsgs.length}`);
    for (const [m, c] of [...errCounts.entries()].slice(0, 8)) console.log(`  x${c} ${m.slice(0, 160)}`);
  }

  // ── 分析 ──
  const valid = samples.filter((s) => s && s.render && s.auth);
  if (valid.length === 0) {
    console.error('没有有效采样（render/auth 为空）');
    throw new Error('无有效采样');
  }

  const divergences = [];
  const renderSpeeds = [];
  const authSpeeds = [];
  const renderJumps = [];
  let syncStart = valid[0].stats?.syncCount ?? 0;
  let collStart = valid[0].stats?.collisionRejectCount ?? 0;
  let syncDelta = 0;
  let collDelta = 0;
  let prevRender = null;
  let prevT = null;
  let maxRenderJump = 0;
  let maxDiv = 0;
  let maxDivSample = null;

  for (const s of valid) {
    const r = s.render;
    const a = s.auth.frame;
    const d = Math.hypot(r.posX - a.pos.x, r.posY - a.pos.y, r.posZ - a.pos.z);
    divergences.push(d);
    if (d > maxDiv) { maxDiv = d; maxDivSample = s; }
    renderSpeeds.push(Math.hypot(r.velX, r.velY, r.velZ));
    authSpeeds.push(Math.hypot(a.vel.x, a.vel.y, a.vel.z));
    if (prevRender && prevT !== null) {
      const jump = Math.hypot(r.posX - prevRender.posX, r.posY - prevRender.posY, r.posZ - prevRender.posZ);
      const dt = SAMPLE_MS / 1000;
      const expected = (renderSpeeds[renderSpeeds.length - 2] ?? 0) * dt;
      renderJumps.push({ jump, expected, ratio: expected > 0 ? jump / expected : 0 });
      if (jump > maxRenderJump) maxRenderJump = jump;
    }
    prevRender = r;
  }
  syncDelta = (valid[valid.length - 1].stats?.syncCount ?? 0) - syncStart;
  collDelta = (valid[valid.length - 1].stats?.collisionRejectCount ?? 0) - collStart;

  const meanDiv = divergences.reduce((s, v) => s + v, 0) / divergences.length;
  const sortedDiv = [...divergences].sort((a, b) => a - b);
  const p95Div = sortedDiv[Math.floor(sortedDiv.length * 0.95)] ?? 0;
  const meanRenderSpeed = renderSpeeds.reduce((s, v) => s + v, 0) / renderSpeeds.length;
  const meanAuthSpeed = authSpeeds.reduce((s, v) => s + v, 0) / authSpeeds.length;
  const abnormalJumps = renderJumps.filter((j) => j.ratio > MAX_SAMPLE_JUMP_FACTOR).length;

  // 更多维度：权威帧推进、着地一致性、数值健康度、速度比
  const vas = valid.map((s) => s.auth.va);
  const vaDistinct = new Set(vas).size;
  const vaMonotonic = vas.every((v, i) => i === 0 || v >= vas[i - 1]);
  const onGroundMismatch = valid.filter((s) => !!s.render.onGround !== !!s.auth.frame.onGround).length;
  const nanCount = valid.filter((s) =>
    [s.render.posX, s.render.posY, s.render.posZ, s.render.velX, s.render.velY, s.render.velZ,
      s.auth.frame.pos.x, s.auth.frame.pos.y, s.auth.frame.pos.z,
      s.auth.frame.vel.x, s.auth.frame.vel.y, s.auth.frame.vel.z].some((v) => !Number.isFinite(v)),
  ).length;
  const outOfBoundsCount = valid.filter((s) =>
    [s.render.posX, s.render.posY, s.render.posZ, s.auth.frame.pos.x, s.auth.frame.pos.y, s.auth.frame.pos.z]
      .some((v) => Math.abs(v) > 200000),
  ).length;
  const speedRatios = [];
  for (let i = 0; i < valid.length; i++) {
    if (renderSpeeds[i] > 1) speedRatios.push(authSpeeds[i] / renderSpeeds[i]);
  }
  const meanSpeedRatio = speedRatios.length ? speedRatios.reduce((s, v) => s + v, 0) / speedRatios.length : 0;

  console.log('\n=== 真实运行时统计 ===');
  console.log(`有效采样: ${valid.length}/${samples.length}`);
  console.log(`权威-渲染偏移: mean=${meanDiv.toFixed(2)}u  p95=${p95Div.toFixed(2)}u  max=${maxDiv.toFixed(2)}u`);
  console.log(`渲染平均速度: ${meanRenderSpeed.toFixed(1)}u/s  权威平均速度: ${meanAuthSpeed.toFixed(1)}u/s`);
  console.log(`采样间隔位移最大跳变: ${maxRenderJump.toFixed(1)}u（${SAMPLE_MS}ms 间隔；异常判定 > ${MAX_SAMPLE_JUMP_FACTOR}x 预期）`);
  console.log(`异常跳变采样点数: ${abnormalJumps}`);
  console.log(`反向同步增量: ${syncDelta}  碰撞驳回增量: ${collDelta}`);
  console.log(`权威帧推进: 不同 va=${vaDistinct}，单调=${vaMonotonic ? '是' : '否'}`);
  console.log(`着地状态不一致采样数: ${onGroundMismatch}`);
  console.log(`NaN/非有限值采样数: ${nanCount}  越界采样数: ${outOfBoundsCount}`);
  console.log(`权威/渲染速度比均值: ${meanSpeedRatio.toFixed(3)}`);
  if (maxDivSample) {
    console.log(`最大偏移时刻: render=(${maxDivSample.render.posX.toFixed(1)},${maxDivSample.render.posY.toFixed(1)},${maxDivSample.render.posZ.toFixed(1)}) auth=(${maxDivSample.auth.frame.pos.x.toFixed(1)},${maxDivSample.auth.frame.pos.y.toFixed(1)},${maxDivSample.auth.frame.pos.z.toFixed(1)})`);
  }

  // ── 挑剔的问题检查 ──
  console.log('\n=== 潜在问题检查 ===');
  const issues = [];
  if (cdp.exceptionMsgs.length > 0) issues.push(`页面异常: ${cdp.exceptionMsgs.join(' | ')}`);
  if (!isolated) issues.push('crossOriginIsolated=false：未启用 SAB，走 MsgState 回退');
  if (valid.length < samples.length * 0.8) issues.push(`有效采样比例过低 (${valid.length}/${samples.length})`);
  if (maxDiv > MAX_DIVERGENCE) issues.push(`权威-渲染最大偏移 ${maxDiv.toFixed(1)}u 超过阈值 ${MAX_DIVERGENCE}u`);
  if (abnormalJumps > 0) issues.push(`采样间隔位移跳变异常点数 ${abnormalJumps}`);
  if (syncDelta === 0 && maxDiv > 100) issues.push('偏移较大但反向同步次数为 0，可能同步未触发');
  if (meanAuthSpeed === 0 && meanRenderSpeed > 100) issues.push('权威平均速度为 0 而渲染有速度，权威可能未在正确模拟');
  if (vaDistinct < 2) issues.push('权威帧 va 没有推进，权威模拟可能未运行');
  if (!vaMonotonic) issues.push('权威帧 va 非单调递增，可能存在帧乱序/回退');
  if (onGroundMismatch > 0) issues.push(`渲染/权威着地状态不一致采样 ${onGroundMismatch} 个`);
  if (nanCount > 0) issues.push(`存在 NaN/非有限值采样 ${nanCount} 个`);
  if (outOfBoundsCount > 0) issues.push(`存在越界位置采样 ${outOfBoundsCount} 个`);
  if (speedRatios.length > 0 && (meanSpeedRatio < 0.5 || meanSpeedRatio > 2)) issues.push(`权威/渲染速度比均值异常: ${meanSpeedRatio.toFixed(3)}`);
  if (errMsgs.length > 0) {
    const first = [...errCounts.keys()][0] ?? '';
    issues.push(`console error/warn ${errMsgs.length} 条（${errCounts.size} 类），例如: ${first.slice(0, 120)}`);
  }
  const fpsNum = parseInt(fpsText, 10);
  if (!Number.isNaN(fpsNum) && fpsNum < 10) issues.push(`FPS 过低: ${fpsNum}`);

  if (issues.length === 0) {
    console.log('未发现明显问题 ✅');
  } else {
    for (const it of issues) console.log(`- ${it}`);
  }

  console.log('\nRESULT: ' + (issues.length === 0 ? 'PASS ✅' : 'ISSUES FOUND ❌'));
  cdp.close();
  chrome.kill();
  server.kill();
  process.exit(issues.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  process.exit(1);
});
