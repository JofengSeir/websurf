/**
 * Worker 侧默认纹理包数据（single 打包模式下经 wasm-init 消息下发）。
 *
 * file:// 下 worker 无法 fetch textures.mtz——主线程把内嵌 base64
 * （globalThis.__VBSP_TEXTURES_MTZ_B64__，由 build-dist.mjs single 模式注入）
 * 经 wasm-init 消息传给 worker；此处存取，handleLoadBsp 消费。
 */

let embeddedMtzB64: string | undefined;

/** 设置内嵌默认纹理包 base64（wasm-init 消息）。 */
export function setMtzB64(b64: string | undefined): void {
	embeddedMtzB64 = b64;
}

/** 读取内嵌默认纹理包 base64（无 = 走 fetch 路径）。 */
export function getMtzB64(): string | undefined {
	return embeddedMtzB64;
}
