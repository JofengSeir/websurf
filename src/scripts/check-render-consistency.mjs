#!/usr/bin/env node
/**
 * 三端渲染一致性门禁（T-460 WP7）——同一台机器、同一张图、**同一档、同一位姿**下，逐字段比对三端
 * `globalThis.__vbspRenderProbe.snapshot()`（共享只读探针，见 `src/renderer-shared/render/render-probe.ts`）。
 *
 * ## 为什么需要它
 *
 * 静态门禁（`check-render-parity.mjs`）只能守「写法同源」；运行期真分叉（反射源漏挂、剔除距离各写
 * 一套、合并归一只有一端注入、画质根不同……）它一律看不见（任务书 §2 V1/V2/V4/V5）。此前只能靠
 * 截图逐像素，既不可复现又把「画面达标」和「链路口径一致」混成一件事（R2 明确不作判据）。本脚本
 * 只读状态：不截图（`--shot` 才出图）、不写任何端的状态。
 *
 * ## 判据（字段级；`scope` 与视口尺寸/来源按 D3 不参与相等判定）
 *
 *   V1 `prefs.*`（含 `fingerprint`）逐字段相同；V2 `envmap.ready/applied/missing` 相同；
 *   V4 `cull.*` 相同，且档 `pvs=true` ⇒ 三端 `pvs.pvsHidden > 0`（档 false ⇒ 三端均为 0）；
 *   V5 `merge.*`（输入 mesh 数 / 块数 / draw call 估算）相同；`sky.*` 相同；
 *   `viewport.matches` 三端都必须为真（声明与实际一致，尺寸不比）。
 *
 * ## 用法与跳过语义
 *
 *   node src/scripts/check-render-consistency.mjs [map.bsp] [--prefs=default|<base64(JSON)>]
 *                                              [--selftest] [--shot] [--cdp-port=9415] [--keep]
 *
 * 缺依赖（三端 dev 服务未起 / 找不到浏览器 / 地图夹具不存在）⇒ 打印 `SKIP` 并 `exit 0`（D4：不接 CI）。
 * 任一字段不一致 ⇒ 打印差异表并 `exit 1`。`--selftest`：给 viewer 注入 `__vbspEnvMapReady=false`，
 * 要求本脚本**报红且指出该字段**（负向自测）；自测通过 ⇒ exit 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  APP_PAGES,
  connectCdp,
  launchBrowser,
  probeDevServers,
  resolveBrowser,
} from './lib/three-app-cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const opt = (k, d = '') => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const MAP = path.resolve(argv.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'test', 'maps', 'surf_boreas.bsp'));
const PREFS = opt('prefs', 'default');
const CDP_PORT = Number(opt('cdp-port', '9415'));
const LOAD_TIMEOUT_MS = Number(opt('load-timeout', '420000'));
const SETTLE_MS = Number(opt('settle', '12000'));
const skip = (why) => { console.log('SKIP 三端渲染一致性门禁：' + why); process.exit(0); };

/** 参与相等判定的字段路径（点号路径；数组元素按序号）。 */
const FIELDS = [
  'prefs.exposure', 'prefs.lightGamma', 'prefs.ambientScale', 'prefs.propVertexRelax', 'prefs.propVertexFlatten',
  'prefs.mode', 'prefs.quality', 'prefs.fov', 'prefs.cull', 'prefs.pvs', 'prefs.fingerprint', 'prefs.source',
  'envmap.ready', 'envmap.applied', 'envmap.missing',
  'cull.distance', 'cull.auto', 'cull.configured',
  'pvs.enabled', 'pvs.clusters',
  'merge.meshes', 'merge.chunks', 'merge.drawCallEst',
  'sky.hasGroup', 'sky.children',
];

const pick = (obj, pathStr) => pathStr.split('.').reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);

const servers = await probeDevServers();
const down = Object.entries(servers).filter(([, ok]) => !ok).map(([a]) => a);
if (down.length) skip('三端 dev 服务未就绪（' + down.join('、') + '）');
if (!resolveBrowser()) skip('未找到 Edge/Chromium（可用 EDGE_PATH 指定）');
if (!fs.existsSync(MAP)) skip('地图夹具不存在：' + MAP);

const browser = await launchBrowser({ root: ROOT, port: CDP_PORT });
const cdp = await connectCdp(CDP_PORT);

/** 载图 + 钉位姿 + 读探针快照；返回 `{ app, pose, snapshot, errors }`。 */
async function loadApp(app, pose) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const logs = [];
  const errors = [];
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => (a?.value !== undefined ? String(a.value) : '')).join(' ');
      logs.push(text);
      if (msg.params.type === 'error') errors.push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? '(页面异常)');
    }
  });
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(app.app + ' 求值异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };
  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('DOM.enable', {}, sessionId);
    const url = app.url + '?prefs=' + encodeURIComponent(PREFS);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(2500);
    const { root } = await cdp.send('DOM.getDocument', {}, sessionId);
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#bspFile' }, sessionId);
    if (!q.nodeId) throw new Error(app.app + ': 找不到 #bspFile（本页不是开发页？）');
    await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [MAP] }, sessionId);
    const t0 = Date.now();
    while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
      if (logs.some((l) => l.includes('[lightmap] 光照模式'))) break;
      await sleep(1000);
    }
    await sleep(SETTLE_MS);

    let appliedPose = null;
    if (pose) {
      appliedPose = await evaluate(
        `globalThis.__vbspPose ? globalThis.__vbspPose.setPose(${JSON.stringify(pose)}).then((p) => JSON.stringify(p)) : 'null'`,
      );
      await sleep(4000);
    }
    // 负向自测：地图载入**之后**（此时 `setReflectionEnvMap` 已把 ready 置真）再注入故障，
    // 让探针读到 viewer 的反射源缺失状态——门禁必须据此报红并指出 `envmap.ready`。
    if (has('selftest') && app.app === 'viewer') {
      await evaluate("globalThis.__vbspEnvMapReady = false; 'injected'");
      console.log('   自测：已给 viewer 注入 __vbspEnvMapReady=false');
    }
    const snapshot = JSON.parse(await evaluate('JSON.stringify(globalThis.__vbspRenderProbe.snapshot())'));
    const ownPose = await evaluate('JSON.stringify(globalThis.__vbspPose?.cameraPose?.() ?? null)');
    if (has('shot')) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const out = path.join(ROOT, '.tmp', 'render-consistency-' + app.app + '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('  已出图（--shot）：' + path.relative(ROOT, out));
    }
    return { app: app.app, pose: JSON.parse(ownPose), appliedPose, snapshot, errors };
  } finally {
    off();
    if (!has('keep')) { try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 已关 */ } }
  }
}

const results = [];
try {
  // 第一遍：debug 载图后用它自己的初始位姿当三端共用位姿（位姿入口三端同源）
  console.log('── 载 debug（基准位姿）…');
  const first = await loadApp(APP_PAGES[0], null);
  const basePose = first.pose ? { pos: first.pose.pos, yawDeg: first.pose.yawDeg, pitchDeg: first.pose.pitchDeg } : null;
  results.push(first);
  console.log('   基准位姿：' + JSON.stringify(basePose));
  for (const app of APP_PAGES.slice(1)) {
    console.log('── 载 ' + app.app + '（套用基准位姿）…');
    results.push(await loadApp(app, basePose));
  }
} finally {
  cdp.close();
  browser.close();
}

// ── 判定 ───────────────────────────────────────────────────────────────────
console.log('\n地图：' + path.basename(MAP) + '；档：?prefs=' + PREFS + '\n');
for (const r of results) {
  console.log('── ' + r.app + '  ' + r.snapshot.prefs.fingerprint + '/' + r.snapshot.prefs.source + '  viewport=' + r.snapshot.viewport.w + 'x' + r.snapshot.viewport.h + '(' + r.snapshot.viewport.source + ',matches=' + r.snapshot.viewport.matches + ')');
  console.log('   envmap=' + JSON.stringify(r.snapshot.envmap) + ' cull=' + JSON.stringify(r.snapshot.cull));
  console.log('   pvs=' + JSON.stringify(r.snapshot.pvs) + ' merge=' + JSON.stringify(r.snapshot.merge) + ' sky=' + JSON.stringify(r.snapshot.sky));
  if (r.errors.length) console.log('   页面异常：' + String(r.errors[0]).slice(0, 200));
}

const bad = [];
for (const f of FIELDS) {
  const vals = results.map((r) => pick(r.snapshot, f));
  if (new Set(vals.map((v) => JSON.stringify(v))).size > 1) bad.push('  ' + f + '：' + results.map((r, i) => r.app + '=' + JSON.stringify(vals[i])).join('  '));
}
// pvsHidden：档开 ⇒ 三端都 > 0；档关 ⇒ 三端都 == 0（不比具体数值，帧序不同会差 1）
const pvsOn = pick(results[0].snapshot, 'prefs.pvs') === true;
const hidden = results.map((r) => pick(r.snapshot, 'pvs.pvsHidden'));
if (pvsOn ? !hidden.every((h) => typeof h === 'number' && h > 0) : !hidden.every((h) => h === 0)) {
  bad.push('  pvs.pvsHidden（档 pvs=' + pvsOn + '）：' + results.map((r, i) => r.app + '=' + hidden[i]).join('  '));
}
for (const r of results) {
  if (r.snapshot.viewport.matches !== true) bad.push('  viewport.matches：' + r.app + '=false（视口声明与实际不一致）');
}

if (bad.length) {
  console.log('\n三端渲染一致性门禁：失败 ' + bad.length + ' 条\n' + bad.join('\n'));
  if (has('selftest')) {
    const hit = bad.some((b) => b.includes('envmap.ready'));
    console.log(hit ? '\n自测通过：注入 viewer 的 envmap.ready=false 后门禁报红并指出该字段' : '\n自测失败：门禁没指出 envmap.ready');
    process.exit(hit ? 0 : 1);
  }
  process.exit(1);
}
if (has('selftest')) {
  console.log('\n自测失败：注入 viewer 的 envmap.ready=false 后门禁仍判通过 ⇒ 判据失效');
  process.exit(1);
}
console.log('\n三端渲染一致性门禁：通过（exit 0）');
process.exit(0);
