#!/usr/bin/env node
/**
 * 三端呈现档一致性门禁（T-460 WP2 / D1=A）——本地判据：「同一台机器三端能不能落到同一档」。
 *
 * ## 为什么需要它
 *
 * 呈现档存 `localStorage` 的 `vbsp:renderPrefs`，而 localStorage **按 origin 隔离**（debug 8080 /
 * game 8090 / viewer 8100 是三个 origin）⇒ 三端可以静默分叉：同一张图、同一视点，三端曝光/γ/
 * 画质档不同，跨端画面比对从一开始就没有基线（T-459）。`render-prefs.ts` 因此补了**深链覆盖**
 * `?prefs=default|<base64(JSON)>`（优先级最高、不落盘）与**档指纹**（`fp=`），本脚本是它的判据。
 *
 * ## 断言
 *
 *   A 三端都打出 `[render-prefs] 生效：…` 诊断行（缺行 = 该端根本没读共享档）；
 *   B 三行**逐字相同**（不一致时逐字段打印：字段 → 三端取值），且 `fp=` 档指纹一致；
 *   C 默认（深链）模式下三行都必须是 `source=deep-link`——证明覆盖真的生效，
 *     而不是「三端恰好的存档相同」。
 *
 * ## 用法与跳过语义
 *
 *   node src/scripts/check-prefs-parity.mjs                # 三端带 `?prefs=default` 比对（判据默认口径）
 *   node src/scripts/check-prefs-parity.mjs --raw           # 三端不带参数：查本机存档档是否已分叉（诊断用）
 *   node src/scripts/check-prefs-parity.mjs --prefs=<b64>   # 指定档（base64(JSON)，与深链同格式）
 *   node src/scripts/check-prefs-parity.mjs --selftest      # 负向自测：给一端塞非默认档 ⇒ 必须报红
 *   node src/scripts/check-prefs-parity.mjs --dump          # 附带打印三端全部控制台行
 *   node src/scripts/check-prefs-parity.mjs --headed        # 有头浏览器（肉眼复核）
 *
 * 缺依赖（三端 dev 服务没起 / 找不到 Edge/Chromium）时打印 `SKIP` 并 `exit 0`——与
 * `check-glb-parity.mjs` 的跳过口径一致；本脚本**不接 CI**（D4）。三行不一致 `exit 1`，一致 `exit 0`。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_PAGES,
  capturePage,
  connectCdp,
  keyValueMap,
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
const LINE_RE = /\[render-prefs\] 生效：/;
const skip = (why) => { console.log('SKIP 呈现档一致性门禁：' + why); process.exit(0); };

/** 负向自测用的非默认档：四个段都与默认档不同（曝光/γ/画质/剔除距离/PVS/FOV）。 */
const SEED_PREFS = JSON.stringify({
  version: 1,
  lighting: { exposure: 2.5, lightGamma: 2.2, ambientScale: 1, propVertexRelax: 1, propVertexFlatten: 0, mode: 'baked' },
  textureQuality: 'mini',
  culling: { distance: 3000, pvs: true },
  camera: { fov: 90 },
});
const SEED_EXPR =
  "localStorage.setItem('vbsp:renderPrefs', JSON.stringify(" + SEED_PREFS + ")); 'seeded'";
const CLEAR_EXPR = "localStorage.removeItem('vbsp:renderPrefs'); 'cleared'";

const rawMode = has('raw');
const prefsArg = rawMode ? '' : opt('prefs', 'default');
const settleMs = Number(opt('settle', '6000'));
const cdpPort = Number(opt('cdp-port', '9413'));

/** 逐端开页面收诊断行；返回结果表（不打印）。 */
async function collect(cdp, query) {
  const results = [];
  for (const p of APP_PAGES) {
    const url = p.url + query;
    const r = await capturePage(cdp, url, { match: LINE_RE, settleMs });
    results.push({ app: p.app, url, line: r.lines[0] ?? null, errors: r.errors, all: r.all });
  }
  return results;
}

/** 打印与判定；返回 `{ equal, missing }`。 */
function report(results, label) {
  const missing = results.filter((r) => !r.line);
  console.log('呈现档一致性门禁（' + label + '）');
  for (const r of results) {
    console.log('  ' + r.app.padEnd(7) + (r.line ?? '(无 `[render-prefs] 生效：` 行)'));
    if (!r.line && r.errors.length) console.log('         页面异常: ' + String(r.errors[0]).slice(0, 160));
  }
  if (missing.length) {
    console.log('  ⇒ 失败：有端未读共享呈现档（缺诊断行）');
    return { equal: false, missing };
  }
  const maps = results.map((r) => ({ app: r.app, kv: keyValueMap(r.line) }));
  console.log('  指纹 ' + [...new Set(maps.map((m) => m.kv.get('fp')))].join(' / ') +
    '；来源 ' + [...new Set(maps.map((m) => m.kv.get('source')))].join(' / '));
  const equal = new Set(results.map((r) => r.line)).size === 1;
  if (!equal) {
    console.log('  ⇒ 失败：三端生效行不一致（逐字段差异）');
    const keys = new Set(maps.flatMap((m) => [...m.kv.keys()]));
    for (const k of keys) {
      const vals = maps.map((m) => m.kv.get(k));
      if (new Set(vals).size > 1) console.log('    ' + k + '：' + maps.map((m, i) => m.app + '=' + vals[i]).join('  '));
    }
  }
  return { equal, missing };
}

// ── 依赖：三端 dev 服务 + 浏览器 ───────────────────────────────────────────
const servers = await probeDevServers();
const down = Object.entries(servers).filter(([, ok]) => !ok).map(([app]) => app);
if (down.length) skip('三端 dev 服务未就绪（' + down.join('、') + '）⇒ 先在各自目录 npm run dev');
if (!resolveBrowser()) skip('未找到 Edge/Chromium（可用环境变量 EDGE_PATH 指定可执行文件）');

const browser = await launchBrowser({ root: ROOT, port: cdpPort, headless: !has('headed') });
if (!browser) skip('浏览器启动失败');

let code = 0;
try {
  const cdp = await connectCdp(cdpPort);
  if (has('selftest')) {
    // 负向自测：先给 game 那个 origin 塞一份非默认档，再按「不带参数」的口径比对 ⇒ 必须报红。
    await capturePage(cdp, APP_PAGES[1].url, { evaluate: SEED_EXPR, settleMs: 2500 });
    const seeded = await collect(cdp, '');
    const r = report(seeded, '负向自测：game 档已改成非默认，三端不带参数');
    await capturePage(cdp, APP_PAGES[1].url, { evaluate: CLEAR_EXPR, settleMs: 1500 });
    if (r.equal) {
      console.log('\n自测失败：game 的档与非默认档不同，门禁却没报红（判据失效）');
      code = 1;
    } else {
      console.log('\n自测通过：门禁报红并打印了三行（负向用例成立）');
    }
    cdp.close();
  } else {
    const query = prefsArg ? '?prefs=' + encodeURIComponent(prefsArg) : '';
    const results = await collect(cdp, query);
    if (has('dump')) {
      for (const r of results) {
        console.log('── ' + r.app + ' 控制台（' + r.all.length + ' 行）');
        for (const l of r.all) console.log('   ' + l.slice(0, 200));
      }
      console.log('');
    }
    const r = report(results, rawMode ? '不带参数 --raw：查本机存档档' : '深链覆盖 ?prefs=' + prefsArg);
    const sources = results.map((x) => (x.line ? keyValueMap(x.line).get('source') : null));
    if (!r.equal) code = 1;
    else if (!rawMode && sources.some((s) => s !== 'deep-link')) {
      console.log('  ⇒ 失败：深链覆盖未生效（有端 source≠deep-link）⇒ 该端没走 `?prefs=` 分支');
      code = 1;
    } else {
      console.log('  ⇒ 通过（exit 0）');
    }
    cdp.close();
  }
} finally {
  browser.close();
}
process.exit(code);
