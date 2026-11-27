/**
 * 静态页部署新鲜度自检（三端共用）。
 *
 * 背景：GitHub Pages 给 HTML / JS 的 Cache-Control 是 max-age=600，部署新版本后，
 * 已经打开的页面（尤其是正在玩的 game）可能继续用旧缓存，表现为「线上明明更新了，
 * 本页还是旧行为」。根入口 src/web/index.html 已有一段内联核对；三端 app 页原先没有。
 *
 * 机制：
 * 1. deploy-pages.yml 组装时把 __DEPLOY_ID__ 烙印进每个 app 的 index.html
 *    （meta[name=websurf-deploy-id]，content = r<run>-<sha7>），并在 app 目录下写
 *    同目录 version.json；
 * 2. 本模块启动时读 meta，向同目录 version.json 发一次 no-store 请求；
 * 3. 远端 id 与本页 id 不同 ⇒ 弹层，默认 10 秒倒计时后强制刷新；可点「稍后提醒」推迟 5 分钟；
 * 4. 用 URL 上的 _ws_refresh（以及 sessionStorage）做一次性守卫：刷新后仍是旧页时不再自动
 *    刷新，改为提示手动 Ctrl+F5，避免缓存页与刷新之间死循环。
 *
 * 本地直接打开模板 / npm run build:dist 产物时 meta 仍是占位符，本模块直接跳过；
 * 只有真正部署到 Pages 的页面才会请求 version.json。
 */

/** 部署 id 的 meta 名；deploy-pages.yml 会替换它的 content。 */
export const DEPLOY_META_NAME = 'websurf-deploy-id';
/** 与 index.html 同目录的版本文件；部署时由 workflow 写入。 */
export const VERSION_FILE = 'version.json';
/** 刷新 URL 上的一次性参数；用于识别「这次加载已经是自动刷新后的加载」。 */
export const REFRESH_QUERY = '_ws_refresh';
/** 弹层默认倒计时（毫秒）。 */
export const REFRESH_COUNTDOWN_MS = 10_000;
/** 「稍后提醒」推迟时长（毫秒）。 */
export const SNOOZE_MS = 5 * 60_000;
/** 页面可见时的低频轮询间隔（毫秒）。 */
const POLL_MS = 5 * 60_000;
/** version.json 请求超时（毫秒）；超时按「本次没查到」处理，不打扰页面。 */
const FETCH_TIMEOUT_MS = 8_000;
/** 自动刷新守卫的 sessionStorage 键。 */
const ATTEMPT_KEY = 'ws-deploy-refresh-attempt';
/** 拼多行 CSS 用；不用模板字符串，避免外层工具链转义问题。 */
const NL = String.fromCharCode(10);

interface DeployVersion {
  id?: unknown;
  time?: unknown;
}

interface ModalHandle {
  close: () => void;
}

let installed = false;
let checking = false;
let activeModal: ModalHandle | null = null;
let currentDeployId: string | null = null;
/** 本次页面加载的 URL 是否已经带过 _ws_refresh（即已经自动刷新过一次）。 */
let bootHadRefreshQuery = false;
let snoozeUntil = 0;
let snoozeTimer = 0;
/** 用户已经关掉的 fallback 提示对应的远端 id；同一 id 不再自动弹。 */
let dismissedRemoteId: string | null = null;

/**
 * 校验部署 id 形状。真实 id 由 r<run_number>-<sha7> 组成；占位符 / 本地构建返回 null。
 * 只接受这个形状，避免把任意 meta 内容当版本号，也避免把 __DEPLOY_ID__ 发到线上。
 */
export function normalizeDeployId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!/^r[0-9]+-[0-9a-f]{7,40}$/i.test(id)) return null;
  return id;
}

/** 远端 id 是否代表「比本页新的一次部署」；任一 id 非法都返回 false（自检静默跳过）。 */
export function isStaleDeploy(current: string | null, remote: unknown): boolean {
  const now = normalizeDeployId(current);
  const next = normalizeDeployId(remote);
  return !!now && !!next && now !== next;
}

/**
 * 计算同目录 version.json 的 URL。
 * - /websurf/game/ 或 /websurf/game/index.html → /websurf/game/version.json
 * - / 或 /index.html → /version.json
 * - 无扩展名的 /game 按目录处理 → /game/version.json
 */
export function deployVersionUrl(href: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  const path = url.pathname;
  if (path.endsWith('/')) {
    url.pathname = path + VERSION_FILE;
    return url.toString();
  }
  const slash = path.lastIndexOf('/');
  const base = path.slice(0, slash + 1);
  const last = path.slice(slash + 1);
  url.pathname = last.includes('.') ? base + VERSION_FILE : base + last + '/' + VERSION_FILE;
  return url.toString();
}

/** 读取本页被烙印的部署 id；没有 meta / 仍是占位符时返回 null。 */
function readCurrentDeployId(): string | null {
  const selector = 'meta[name="' + DEPLOY_META_NAME + '"]';
  const meta = document.querySelector<HTMLMetaElement>(selector);
  const fromMeta = meta?.getAttribute('content') ?? null;
  const fromGlobal = (globalThis as { __WEBSURF_DEPLOY_ID__?: unknown }).__WEBSURF_DEPLOY_ID__;
  // meta 是主路径；占位符/缺失时再看可选全局变量，避免部署脚本换成别的注入方式后失效。
  return normalizeDeployId(fromMeta) ?? normalizeDeployId(fromGlobal);
}

/** 读取 / 写入「已经自动刷新过」的守卫；隐私模式禁用 storage 时静默失败。 */
function readAttemptId(): string | null {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    return normalizeDeployId(raw);
  } catch {
    return null;
  }
}

function markAttempt(id: string): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, id);
  } catch {
    // storage 不可用：URL 上的 _ws_refresh 仍能兜底
  }
}

function clearAttempt(): void {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // 忽略
  }
}

/** 取走 URL 上的 _ws_refresh，返回本次加载是不是自动刷新后的加载。 */
function takeRefreshQuery(): boolean {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(REFRESH_QUERY)) return false;
    url.searchParams.delete(REFRESH_QUERY);
    window.history.replaceState(window.history.state, '', url.toString());
    return true;
  } catch {
    return false;
  }
}

/** 强制刷新：给 URL 加一次性参数，绕开 Pages 对 HTML 的 max-age 缓存。 */
function reloadPage(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(REFRESH_QUERY, String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

function scheduleCheck(delayMs: number): void {
  if (snoozeTimer) window.clearTimeout(snoozeTimer);
  snoozeTimer = window.setTimeout(() => {
    snoozeTimer = 0;
    if (!activeModal) void checkForUpdate();
  }, delayMs);
}

/** 查询 version.json；失败、404、占位符都静默，不打扰正常游玩。 */
async function checkForUpdate(): Promise<void> {
  if (checking || activeModal || !currentDeployId) return;
  if (Date.now() < snoozeUntil) return;
  if (document.visibilityState === 'hidden') return;
  checking = true;
  let timeout = 0;
  try {
    const controller = new AbortController();
    timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const url = deployVersionUrl(window.location.href) + '?bust=' + Date.now();
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) return;
    const payload = (await response.json()) as DeployVersion;
    const remoteId = normalizeDeployId(payload.id);
    if (!remoteId) return;
    if (remoteId === currentDeployId) {
      // 本页已经是最新：清掉上一轮的刷新守卫，避免下次部署被误判成「刷新过」。
      clearAttempt();
      dismissedRemoteId = null;
      return;
    }
    if (dismissedRemoteId === remoteId) return;
    const alreadyTried = bootHadRefreshQuery || readAttemptId() === remoteId;
    showUpdateModal(remoteId, payload.time, alreadyTried);
  } catch (error) {
    // 网络失败 / 超时 / JSON 坏掉都不值得打扰用户；控制台留一条便于排查。
    console.debug('[deploy-freshness] 版本检查失败', error);
  } finally {
    if (timeout) window.clearTimeout(timeout);
    checking = false;
  }
}

const MODAL_CSS = [
  ':host { all: initial; color-scheme: dark; }',
  '* { box-sizing: border-box; }',
  '.ws-wrap {',
  '  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;',
  '  padding: 20px; background: rgba(4, 6, 10, 0.74);',
  '  font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;',
  '  -webkit-font-smoothing: antialiased;',
  '}',
  '.ws-card {',
  '  width: min(520px, 100%); padding: 22px 24px 20px;',
  '  color: #e8ebf2; background: #151821;',
  '  border: 1px solid #394154; border-radius: 12px;',
  '  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.58);',
  '}',
  '.ws-badge {',
  '  display: inline-block; margin-bottom: 12px; padding: 3px 8px;',
  '  color: #0d1420; background: #64b5ff; border-radius: 4px;',
  '  font-size: 11px; font-weight: 700; letter-spacing: 0.12em;',
  '}',
  '.ws-title { margin: 0 0 8px; font-size: 21px; line-height: 1.3; font-weight: 700; }',
  '.ws-desc { margin: 0; color: #b9c2d4; font-size: 14px; line-height: 1.65; }',
  '.ws-ids { display: grid; gap: 4px; margin: 16px 0 4px; color: #8e9ab0; font-size: 12px; }',
  '.ws-ids code {',
  '  padding: 1px 5px; color: #d8e6ff; background: #0f131c;',
  '  border: 1px solid #2c3445; border-radius: 4px; font-family: ui-monospace, Consolas, monospace;',
  '}',
  '.ws-time { margin-top: 2px; color: #77849b; font-size: 12px; }',
  '.ws-count {',
  '  margin: 18px 0 0; padding: 10px 12px;',
  '  color: #d8e6ff; background: #0f131c; border-left: 3px solid #64b5ff;',
  '  font-size: 13px; line-height: 1.5;',
  '}',
  '.ws-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 18px; }',
  '.ws-btn {',
  '  padding: 9px 15px; border-radius: 6px; border: 1px solid transparent;',
  '  font: inherit; font-size: 13px; line-height: 1.2; cursor: pointer;',
  '}',
  '.ws-btn:focus-visible { outline: 2px solid #9fd0ff; outline-offset: 2px; }',
  '.ws-later { color: #9aa6ba; background: transparent; border-color: #394154; }',
  '.ws-later:hover { color: #d8e6ff; border-color: #5a6a86; }',
  '.ws-refresh { color: #0b1220; background: #64b5ff; border-color: #64b5ff; font-weight: 700; }',
  '.ws-refresh:hover { background: #86c7ff; border-color: #86c7ff; }',
  '@media (max-width: 440px) {',
  '  .ws-card { padding: 18px; }',
  '  .ws-title { font-size: 19px; }',
  '  .ws-actions { align-items: stretch; flex-direction: column-reverse; }',
  '  .ws-btn { width: 100%; }',
  '}',
].join(NL);

function modalHtml(): string {
  return [
    '<style>',
    MODAL_CSS,
    '</style>',
    '<div class="ws-wrap" role="alertdialog" aria-modal="true" aria-labelledby="ws-deploy-title" aria-describedby="ws-deploy-desc">',
    '  <div class="ws-card">',
    '    <div class="ws-badge">UPDATE</div>',
    '    <h2 class="ws-title" id="ws-deploy-title" data-role="title">检测到新版本</h2>',
    '    <p class="ws-desc" id="ws-deploy-desc" data-role="desc">站点已部署新的构建。为避免旧页面继续使用缓存资源，页面将自动刷新。</p>',
    '    <div class="ws-ids">',
    '      <div>当前页面 <code data-role="current"></code></div>',
    '      <div>线上版本 <code data-role="remote"></code></div>',
    '      <div class="ws-time" data-role="time"></div>',
    '    </div>',
    '    <p class="ws-count" data-role="count"></p>',
    '    <div class="ws-actions">',
    '      <button type="button" class="ws-btn ws-later" data-role="later">稍后提醒</button>',
    '      <button type="button" class="ws-btn ws-refresh" data-role="refresh">立即刷新</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
}

function showUpdateModal(remoteId: string, remoteTime: unknown, alreadyTried: boolean): void {
  if (activeModal) return;
  if (!document.body) {
    window.addEventListener(
      'DOMContentLoaded',
      () => showUpdateModal(remoteId, remoteTime, alreadyTried),
      { once: true },
    );
    return;
  }

  // 页面可能正处于指针锁定 / 全屏；先退出来，否则用户看不到鼠标，也点不到按钮。
  try {
    if (document.pointerLockElement) document.exitPointerLock();
  } catch {
    // 忽略
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {
      // 全屏退出失败不影响蒙层显示
    });
  }

  const host = document.createElement('div');
  host.setAttribute('data-websurf-deploy-freshness', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = modalHtml();

  const query = <T extends Element>(selector: string): T => {
    const element = shadow.querySelector(selector);
    if (!element) throw new Error('deploy-freshness: 缺少元素 ' + selector);
    return element as T;
  };

  const title = query<HTMLElement>('[data-role="title"]');
  const desc = query<HTMLElement>('[data-role="desc"]');
  const count = query<HTMLElement>('[data-role="count"]');
  const time = query<HTMLElement>('[data-role="time"]');
  const laterButton = query<HTMLButtonElement>('[data-role="later"]');
  const refreshButton = query<HTMLButtonElement>('[data-role="refresh"]');
  query<HTMLElement>('[data-role="current"]').textContent = currentDeployId ?? '';
  query<HTMLElement>('[data-role="remote"]').textContent = remoteId;
  const remoteTimeText = typeof remoteTime === 'string' ? remoteTime.trim() : '';
  if (remoteTimeText) {
    time.textContent = '线上部署：' + remoteTimeText;
  } else {
    time.hidden = true;
  }

  const previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';

  let countdownTimer = 0;
  let closed = false;
  let handle: ModalHandle;

  const stop = (event: Event): void => {
    event.stopPropagation();
  };
  const blockedEvents = [
    'keydown',
    'keyup',
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'wheel',
    'touchstart',
    'touchmove',
    'contextmenu',
  ];
  for (const eventName of blockedEvents) window.addEventListener(eventName, stop, true);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (countdownTimer) window.clearInterval(countdownTimer);
    countdownTimer = 0;
    for (const eventName of blockedEvents) window.removeEventListener(eventName, stop, true);
    host.remove();
    document.documentElement.style.overflow = previousOverflow;
    if (activeModal === handle) activeModal = null;
  };

  handle = { close };
  activeModal = handle;

  const doReload = (): void => {
    markAttempt(remoteId);
    close();
    reloadPage();
  };

  if (alreadyTried) {
    title.textContent = '新版本已部署，但刷新后仍是旧页面';
    desc.textContent = '浏览器仍在用缓存的旧页面。请按 Ctrl+F5（macOS 为 Cmd+Shift+R）强制刷新，或关闭标签页重新打开。';
    count.textContent = '自动刷新已停止，避免反复刷新。';
    refreshButton.textContent = '重新加载';
    laterButton.textContent = '关闭';
    refreshButton.addEventListener('click', () => {
      close();
      reloadPage();
    });
    laterButton.addEventListener('click', () => {
      dismissedRemoteId = remoteId;
      close();
    });
  } else {
    const deadline = performance.now() + REFRESH_COUNTDOWN_MS;
    const tick = (): void => {
      const left = Math.max(0, deadline - performance.now());
      if (left <= 0) {
        if (countdownTimer) window.clearInterval(countdownTimer);
        countdownTimer = 0;
        doReload();
        return;
      }
      count.textContent = Math.ceil(left / 1000) + ' 秒后自动刷新';
    };
    countdownTimer = window.setInterval(tick, 200);
    tick();
    refreshButton.addEventListener('click', doReload);
    laterButton.addEventListener('click', () => {
      close();
      snoozeUntil = Date.now() + SNOOZE_MS;
      scheduleCheck(SNOOZE_MS + 100);
    });
  }

  document.body.appendChild(host);
  window.setTimeout(() => {
    try {
      refreshButton.focus({ preventScroll: true });
    } catch {
      refreshButton.focus();
    }
  }, 0);
}

/**
 * 安装自检。三端 app 入口各调用一次；本地构建（meta 仍是占位符）自动 no-op。
 * 设计为不抛错：自检失败绝不能影响页面启动。
 */
export function installDeployFreshness(): void {
  if (installed) return;
  installed = true;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    currentDeployId = readCurrentDeployId();
    if (!currentDeployId) return;
    bootHadRefreshQuery = takeRefreshQuery();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !activeModal) void checkForUpdate();
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && !activeModal) void checkForUpdate();
    });
    window.setInterval(() => {
      if (document.visibilityState === 'visible' && !activeModal) void checkForUpdate();
    }, POLL_MS);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void checkForUpdate(), { once: true });
    } else {
      void checkForUpdate();
    }
  } catch (error) {
    console.debug('[deploy-freshness] 初始化失败', error);
  }
}
