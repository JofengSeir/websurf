/**
 * WASM / 纹理包「字节获取」共享单点。
 *
 * ## 定位
 * 三工程与共享层其余模块都从这里取「一段字节」。本文件是**全仓唯一的 base64 解码点**：
 * `src/**` 与 `apps/**` 的源码里，`atob` 只出现在下面的 `base64ToBytes` 内。当前调用点
 * 实测 **8 处 / 7 个文件**：
 * - 共享层 3：`src/ts-shared/auth/worker-dispatch.ts`、`src/ts-shared/phys/world-builder.ts`、
 *   `src/ts-shared/world/pvs-manager.ts`
 * - 三工程 4：`apps/debug/src/main-wasm.ts`、`apps/debug/src/default-pack.ts`、
 *   `apps/game/src/renderer/renderer-main.ts`、`apps/viewer/src/core/bsp.ts`（该文件内 2 处）
 *
 * ## 三个原语按「字节从哪来」分层
 * 三者都返回 `Uint8Array`，调用方一律取 `.buffer` 直接喂 `initSync`：
 * - `base64ToBytes(b64)` —— 纯解码，字节来自字符串
 * - `readEmbeddedWasmB64()` —— 读构建期内嵌的 wasm base64（`__VBSP_WASM_B64__`）
 * - `fetchWasmBytes(url)` —— HTTP 取字节（带 `resp.ok` 校验）
 *
 * 内嵌与 fetch 的**选择器留在各工程**（判定口径与回退语义属工程侧行为，工程分支不入共享层）。
 *
 * ## 不变量
 * 本文件 import 数 = **0**：不引任何工程的 `pkg/*`。三工程 pkg 名实测为 debug 与 game
 * **同名**（产物 `websurf_wasm.*`、包名 `websurf-wasm`），viewer 为 `websurf_viewer_wasm.*` /
 * `websurf-viewer-wasm`；因此 `initSync` / `init` 一律留在工程内，由各工程按自己的 pkg 名分支。
 *
 * ## 内嵌键的写入点
 * `globalThis.__VBSP_WASM_B64__` 由构建脚本注入，运行时不产生：
 * - `src/scripts/lib/dist-pack.mjs` 的 `writeEmbeddedPreamble`（三工程的 build-dist 都从该
 *   共享脚本导入此函数）
 * - `apps/viewer/scripts/build-dist.mjs` 另写 `dist/wasm-embedded.js`（multi 模式的 fetch 失败
 *   回退副本），由 `apps/viewer/src/core/bsp.ts` 动态加载
 */

/** 构建期内嵌 base64 的全局键名（`__VBSP_WASM_B64__`）；值由 build-dist 注入。 */
const EMBEDDED_WASM_B64_KEY = '__VBSP_WASM_B64__';

/**
 * base64 → `Uint8Array`。
 *
 * 实现：`atob` 出二进制字符串，长度取 `binary.length`，逐字符 `charCodeAt` 写入新建的
 * `Uint8Array`（不经过 `TextEncoder`，也不做 base64 合法性预校验——非法输入由 `atob` 抛错）。
 * 本原语同时服务 wasm 与默认纹理包（`textures.mtz`）两类内嵌字节。
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 读取 dist 内嵌的 wasm base64（`globalThis.__VBSP_WASM_B64__`）。
 *
 * 判定口径为「**非空字符串**」：注入值不是 `string` 或长度为 0 时一律算未内嵌。取严口径的
 * 目的是让空串 / 非字符串注入可诊断——若放行，调用方会静默退回 fetch 路径，而该路径在
 * `file://` 下必失败（错误点远离真实原因）。
 *
 * @returns 内嵌 base64；未注入或为空串时返回 `undefined`。
 */
export function readEmbeddedWasmB64(): string | undefined {
  const g = globalThis as unknown as { __VBSP_WASM_B64__?: unknown };
  const v = g[EMBEDDED_WASM_B64_KEY];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * HTTP 取 wasm 字节（`file://` 下不可用——调用方应优先走内嵌 base64 分支）。
 *
 * 校验 `resp.ok`：非 2xx 直接抛错，文案带状态码与 URL。缺此校验会把 404 的 HTML 错误页
 * 当字节喂给 `initSync`，最终得到与真实原因无关的 wasm 解析错误。
 */
export async function fetchWasmBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch wasm → ${resp.status}（${url}）`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
