/**
 * WASM 字节获取共享单点（D-09，级别 A）。
 *
 * 上提来源：base64 → `Uint8Array` 解码全仓 **8 处**（三工程 6 + 共享层 2）——
 * `apps/viewer/src/core/bsp.ts`、`apps/game/src/renderer/renderer-main.ts`、
 * `apps/game/src/world/pvs-manager.ts`、`apps/debug/src/main-wasm.ts`、
 * `apps/debug/src/default-pack.ts`、`apps/debug/src/world/pvs-manager.ts`、
 * `src/ts-shared/auth/worker-dispatch.ts`、`src/ts-shared/phys/world-builder.ts`。
 * 收敛后 `-- apps src` 口径下恰好只剩本文件 1 处（`base64ToBytes` 内）。
 *
 * **三个原语按「字节从哪来」分层**（全部返回 `Uint8Array`，零 `ArrayBuffer` 形态差异）：
 * - `base64ToBytes(b64)` —— 纯解码，**全仓唯一 `atob`**
 * - `readEmbeddedWasmB64()` —— 读构建期内嵌的 wasm base64（`__VBSP_WASM_B64__`）
 * - `fetchWasmBytes(url)` —— HTTP 取字节（带 `resp.ok` 校验）
 *
 * 内嵌与 fetch 的选择器留在各工程（它们的判定口径与回退语义是工程侧行为），
 * 本站只提供统一原语，避免把工程分支塞进共享层。
 *
 * **硬约束（framework-decoupling §5.4 规则 2 / D-09）**：本模块**不得** import 任何
 * 工程的 `pkg/*`（三工程 pkg 名互异：`websurf_wasm` / `websurf_viewer_wasm` /
 * `websurf_test_wasm`），只负责「取字节」；`initSync` / `init` 一律留在工程内，
 * 由各工程按自己的 pkg 名分支。
 */

/** 构建期内嵌 base64 的全局键名（`__VBSP_WASM_B64__`）；值由 build-dist 注入。 */
const EMBEDDED_WASM_B64_KEY = '__VBSP_WASM_B64__';

/**
 * base64 → `Uint8Array`（浏览器/Node 原生 `atob` + 手动字节拷贝，比 TextEncoder 快）。
 *
 * 本站是**全仓唯一**的 `atob` 调用点：改这里的容错/性能口径即改全部 8 个原调用方。
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
 * 判定口径**统一为**「非空字符串」：原 6 处工程的判定写法不一致
 * （`if (embedded)` / `typeof g.x === 'string' && g.x.length > 0`），
 * 会让空串/非字符串注入在某些工程静默退回 fetch 路径（`file://` 下该路径必失败）。
 * 本站取更严的一支（仅非空字符串算内嵌），使三工程行为一致且可诊断。
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
 * 校验 `resp.ok`（原 `worker-dispatch.ts` 的 fetch 分支缺此校验，
 * 404 时会拿 HTML 错误页喂给 `initSync` 得到难读的 wasm 解析错误）；失败文案带 URL。
 */
export async function fetchWasmBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch wasm → ${resp.status}（${url}）`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
