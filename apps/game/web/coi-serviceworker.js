/* COI Serviceworker —— 静态托管（GitHub Pages 等）上注入跨源隔离响应头，
 * 使 SharedArrayBuffer / crossOriginIsolated 可用。精简自 gzuidhof/coi-serviceworker（MIT）。
 * 同一文件双重身份：页面上下文负责注册 + 激活后 reload；SW 上下文给响应加 COOP/COEP。
 * 注册失败 / 浏览器不支持时静默跳过——调用方已有 MsgState 降级通道兜底。
 * 预缓存清单与缓存名由构建时注入（__PRECACHE_MANIFEST__ / __CACHE_NAME__），multi 模式部署生效。
 * 未注入时（dev 直读 web/）两者都走 typeof 安全回退，不会抛 ReferenceError。 */
const PRECACHE_MANIFEST =
  typeof __PRECACHE_MANIFEST__ === "object" && __PRECACHE_MANIFEST__ ? __PRECACHE_MANIFEST__ : [];
const CACHE_NAME = typeof __CACHE_NAME__ === "string" ? __CACHE_NAME__ : "websurf-coi-dev";

if (typeof window === "undefined") {
  // ── Service Worker 上下文 ──────────────────────────────────────────
  // cache.addAll 在 install 期的 fetch 不经过本 SW 的 fetch handler，
  // 因此缓存里的响应不带 COOP/COEP；命中缓存时必须重新套一层隔离头，
  // 否则文档不会被判定为 crossOriginIsolated。
  const withCOI = (response) => {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  self.addEventListener("install", (event) => {
    if (PRECACHE_MANIFEST && PRECACHE_MANIFEST.length > 0) {
      event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_MANIFEST)).catch(() => {})
      );
    }
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) =>
    event.waitUntil(
      (async () => {
        // 缓存名随预缓存内容变化，旧版本缓存在此清除
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
        await self.clients.claim();
      })()
    )
  );
  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    if (r.method !== 'GET') return;
    event.respondWith(
      caches.match(r).then((cached) => {
        if (cached) return withCOI(cached);
        return fetch(r).then(withCOI).catch(() => fetch(r));
      })
    );
  });
} else {
  // ── 页面上下文 ─────────────────────────────────────────────────────
  if (!window.crossOriginIsolated && window.isSecureContext && "serviceWorker" in navigator) {
    // 已重载过但仍无 crossOriginIsolated → 直接走降级，避免无限循环
    if (sessionStorage.getItem("wsf-coi-reloaded")) {
      console.warn('[COI] 已重载但 crossOriginIsolated 仍不可用，走 MsgState 降级');
    } else {
      navigator.serviceWorker
        .register('./coi-serviceworker.js')
        .then((reg) => {
          // 等待 SW 真正控制当前页面（controllerchange），而非仅 ready（仅激活）
          return new Promise((resolve) => {
            if (navigator.serviceWorker.controller) {
              // 已有控制器，可能是更新场景，直接 resolve
              resolve(reg);
            } else {
              // 首次加载：等待 controllerchange
              navigator.serviceWorker.addEventListener('controllerchange', () => resolve(reg), { once: true });
            }
          });
        })
        .then(() => {
          // 给浏览器一点时间应用 COOP/COEP 头（某些浏览器需要额外一个微任务轮次）
          setTimeout(() => {
            sessionStorage.setItem("wsf-coi-reloaded", "1");
            window.location.reload();
          }, 0);
        })
        .catch(() => {
          /* 注册失败（如 file://）→ 静默，调用方走 MsgState 回退 */
        });
    }
  }
}
