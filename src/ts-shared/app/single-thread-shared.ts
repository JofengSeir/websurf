/**
 * 单权威主线程（`authorityMode: 'main'`）的惰性共享通道占位（T-D132）。
 *
 * 背景：game 端默认把唯一 `PhysWorld` 放在主线程，不再创建权威 Worker，也就没有跨线程
 * 输入/帧通道。但 `RendererMain` 与共享 `player-presentation` 的签名仍要求一个
 * `SharedState`（`src/ts-shared/auth/shared-state.ts` 的 `ShmState | MsgState`）：
 * 渲染端只读 `readAuthoritative()`（校准器）并向它 `addInput` / `writeRenderSample` /
 * `resetRenderSample`。主线程模式下这些动作没有第二个消费者：
 * - `readAuthoritative()` 恒 `null` → 校准器无帧可校（`beforeTick` 在该模式也已跳过）；
 * - 写输入/渲染采样落到本对象，**不**发消息、**不**分配 SharedArrayBuffer。
 *
 * 该对象只用于「无跨线程通道」的模式，不是 `MsgState` 的替代品（它不发送任何消息）。
 * `src/ts-shared/auth/**` 不改动（D-131 领地），故此处以结构化断言交给 `SharedState`。
 */
import type { SharedState } from '../auth/shared-state.js';

/**
 * 无通道占位：方法全部惰性，只保证渲染端既有调用点（`addInput` / `writeRenderSample` /
 * `resetRenderSample` / `readAuthoritative`）在单线程模式下仍是合法调用。
 */
class SingleThreadSharedState {
	/** 旧通道判定位（Worker 侧只读它区分 SAB/MsgState）；单线程模式没有通道，恒 `false`。 */
	readonly isShared = false;

	/** 输入增量丢弃：主线程模式没有 Worker 消费，输入由 `RendererMain.tick` 直接喂 `predPhys`。 */
	addInput(_dx: number, _dy: number, _keysMask: number): void {
		// 无消费者：不写通道、不发消息
	}

	/** 渲染采样丢弃：采样槽只用于 Worker 侧的读侧轨迹，单线程模式无读者。 */
	writeRenderSample(_tMs: number, _x: number, _y: number, _z: number, _i0: number): void {
		// 无读者：不写通道、不发消息
	}

	/** 采样世代复位为空操作（没有槽位可失效）。 */
	resetRenderSample(): void {
		// 无槽位：空操作
	}

	/** 恒 `null`：单线程模式不存在权威帧（校准器据此无帧可校）。 */
	readAuthoritative(): null {
		return null;
	}
}

/** 建一个无通道的 `SharedState` 占位（仅 `authorityMode: 'main'` 使用）。 */
export function createSingleThreadSharedState(): SharedState {
	return new SingleThreadSharedState() as unknown as SharedState;
}
