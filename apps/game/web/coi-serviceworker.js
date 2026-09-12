/* COI Serviceworker —— 静态托管（GitHub Pages 等）上注入跨源隔离响应头，
 * 使 SharedArrayBuffer / crossOriginIsolated 可用。精简自 gzuidhof/coi-serviceworker（MIT）。
 * 同一文件双重身份：页面上下文负责注册 + 激活后 reload；SW 上下文给响应加 COOP/COEP。
 * 注册失败 / 浏览器不支持时静默跳过——调用方已有 MsgState 降级通道兜底。 */
if (typeof window === "undefined") {
  // ── Service Worker 上下文 ──────────────────────────────────────────
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    event.respondWith(
      fetch(r)
        .then((response) => {
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch(() => fetch(r)),
    );
  });
} else {
  // ── 页面上下文 ─────────────────────────────────────────────────────
  if (!window.crossOriginIsolated && window.isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(window.location.pathname)
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        // SW 激活（带隔离头）后重载一次页面；sessionStorage 标记防重载循环
        if (!sessionStorage.getItem("wsf-coi-reloaded")) {
          sessionStorage.setItem("wsf-coi-reloaded", "1");
          window.location.reload();
        }
      })
      .catch(() => {
        /* 注册失败（如 file://）→ 静默，调用方走 MsgState 回退 */
      });
  }
}
