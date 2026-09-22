/**
 * Worker 侧内嵌默认纹理包 base64 的存取槽。
 *
 * 写入通路：`apps/debug/src/app.ts` 读取构建产物注入的 `globalThis.__VBSP_TEXTURES_MTZ_B64__`，
 * 作为 `wasm-init` 消息的 `mtzB64` 字段发给 Worker；`apps/debug/src/worker/main.ts` 把该
 * 字段接到 `createWorkerDispatch` 的 `onWasmInit` 钩子上，该钩子在
 * `src/ts-shared/auth/worker-dispatch.ts` 的 wasm 实例化流程里最先执行（早于 base64 解码与
 * `initSync`），转手调用本模块的 `setMtzB64`。
 *
 * 读取面：`getMtzB64` 在本仓库内没有调用点（Worker 侧不消费纹理包），本模块只保证该值被
 * 留存下来；未收到字段时留存值为 `undefined`。
 */

let embeddedMtzB64: string | undefined;

/** 写入内嵌默认纹理包 base64（入参为 `undefined` 即置空）。 */
export function setMtzB64(b64: string | undefined): void {
	embeddedMtzB64 = b64;
}

/** 读取最后写入的值；未写入过则为 `undefined`（由调用方处理该情形）。 */
export function getMtzB64(): string | undefined {
	return embeddedMtzB64;
}
