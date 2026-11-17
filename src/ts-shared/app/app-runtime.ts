/**
 * 三端 app 入口的通用 bootstrap 装配（P2 Step1，2026-11-18）。
 *
 * 背景：debug/game 的 `main()` 前段（SAB 通道 → Worker 创建 → wasm 注入 → 共享状态 →
 * 渲染器/桥接创建 → 通用回调注册 → init/start → 主线程 wasm 预热）顺序与依赖是同一套，
 * 但逐行重合只有 ~19–23%（其余是端专用 DOM/面板/持久化）。Step1 只把这一段下沉为
 * `createAppRuntime()`；BSP→SceneData（scene-loader）与 UI/面板/输入循环仍留在各端 app.ts。
 *
 * 端特有语义不靠猜，全部做成必选 hook / 策略：
 * - `ensureMainWasm`：主线程 wasm 预热方式（debug=`ensureMainWasm()` 模块级；
 *   game=`renderer.initPrediction()` 依赖 renderer）。
 * - `bridgePhase`：InputBridge 相对 renderer.init 的装配阶段（debug 早于 renderer、
 *   game 晚于 init/start）——固定成任何一端都会伤另一端。
 * - `deathThresholdPolicy`：死亡阈值下发时机（debug 立即发 + world-json 后重发；
 *   game 等 buildPredictionWorld 后发）。
 * - `onSceneBundle`：端特有的 scene-bundle 后处理（Step2 由 scene-loader 调用）。
 *
 * 顺序固定（9 步）：①共享内存判定（端侧）→ ②Worker 创建 → ③消息路由 → ④wasm 注入 →
 * ⑤共享状态 → ⑥桥接（按 bridgePhase）→ ⑦渲染器 + 通用回调骨架 → ⑧init/start →
 * ⑨主线程 wasm 预热。app 只在 hook 里做端特有动作。
 */

import {
	createMainSharedState,
	SHARED_BUFFER_SIZE,
	type SharedState,
} from '../auth/shared-state.js';
import {
	handleWorkerReady,
	workerStaleMessage,
	type ReadyMessageLike,
} from '../auth/worker-ready.js';

/** Worker 创建参数：内嵌构建用 Blob URL（file:// 下 module worker 不可用），dev 用入口 URL。 */
export interface AppWorkerSpec {
	/** 构建注入的 worker 源码（如 `__VBSP_WORKER_JS__`）；有则优先 Blob URL。 */
	inlineJs?: string;
	/** dev/multi 模式 worker 入口 URL（ES module）。 */
	url: string;
}

/** 主线程 → Worker 的 `wasm-init` 载荷。 */
export interface AppWasmSpec {
	/** 内嵌构建注入的 wasm base64（`__VBSP_WASM_B64__`）；有则与 mtzB64 一起 postMessage。 */
	inlineB64?: string;
	/** 默认纹理包 base64（`__VBSP_TEXTURES_MTZ_B64__`，Worker 侧只暂存供 mosaic 解压）。 */
	mtzB64?: string;
	/** dev/multi 模式由 Worker 自行 fetch 的 wasm URL。 */
	url: string;
}

/**
 * 渲染器最小接口：bootstrap 只碰 init/start/setDeathY/applyCollisionCorrection。
 * 各端 `RendererMain` 结构兼容（具体事件/配置类型仍由端侧持有）。
 */
export interface AppRendererLike {
	init(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, config: unknown): void;
	start(): void;
	setDeathY(deathY: number): void;
	applyCollisionCorrection(
		kind: string,
		pos: readonly number[],
		yawDeg: number,
		pitchDeg: number,
		vel?: readonly number[],
	): void;
}

/** 渲染状态反向同步载荷（与两端 RendererMain 的 onSyncRenderState 同形）。 */
export interface SyncRenderStateLike {
	posX: number;
	posY: number;
	posZ: number;
	yaw: number;
	pitch: number;
	velX: number;
	velY: number;
	velZ: number;
	onGround: boolean;
	eyeHeight: number;
}

/** InputBridge 最小接口：bootstrap 只转发这些低频控制消息；缺省方法 = 该端没有该消息。 */
export interface AppBridgeLike {
	/** debug 在 bridgePhase='before-renderer' 时由 initBridge 调用；game 无此方法。 */
	sendInit?(shared: SharedArrayBuffer | null, width: number, height: number, dpr: number): void;
	sendSetDeathThreshold?(value: number): void;
	sendSetPlayerName?(name: string, filterEnabled?: boolean): void;
	sendAddVelocity?(vel: [number, number, number]): void;
	sendSetPushVelocity?(vel: [number, number, number]): void;
	sendSetSpeedCap?(cap: number): void;
	sendSetJumpHeight?(height: number): void;
	sendSetMapPhysicsParam?(name: string, value: number | boolean): void;
}

/** bootstrap 输入：端标识、画布、配置与通道/注入参数。 */
export interface AppRuntimeProfile<C> {
	/** 端标识：'debug' | 'game' | 'viewer'（日志/诊断用）。 */
	readonly id: string;
	readonly canvas: HTMLCanvasElement;
	readonly config: C;
	/** crossOriginIsolated 是否可用（由端侧判定，回退日志也留在端侧）。 */
	readonly sharedMemory: boolean;
	readonly worker: AppWorkerSpec;
	readonly wasm: AppWasmSpec;
}

/** 钩子/工厂拿到的装配上下文（renderer/bridge 在阶段推进中填充）。 */
export interface AppBootstrapContext<C, R extends AppRendererLike, B extends AppBridgeLike> {
	readonly profile: AppRuntimeProfile<C>;
	readonly worker: Worker;
	readonly canvas: HTMLCanvasElement;
	readonly config: C;
	readonly sharedBuffer: SharedArrayBuffer | null;
	readonly shared: SharedState;
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
	/** `createRenderer` 之后才可用；桥接创建阶段（before-renderer）为 null。 */
	renderer: R | null;
	/** 按 bridgePhase 创建后填充。 */
	bridge: B | null;
}

/** 端特有语义与回调：通用骨架由 runtime 装配，端只补差异。 */
export interface AppHooks<C, R extends AppRendererLike, B extends AppBridgeLike> {
	/** 必选：主线程 wasm 预热（debug=`ensureMainWasm()`；game=`renderer.initPrediction()`）。 */
	ensureMainWasm(ctx: AppBootstrapContext<C, R, B>): Promise<void>;
	/** 必选：死亡阈值下发时机（debug='immediate'；game='after-scene'）。 */
	readonly deathThresholdPolicy: 'immediate' | 'after-scene';
	/** 必选：InputBridge 相对 renderer.init 的装配阶段（debug 先建；game init/start 后建）。 */
	readonly bridgePhase: 'before-renderer' | 'after-init';
	/** 必选：端特有的 scene-bundle 后处理（Step2 由 scene-loader 调用；Step1 仅占位）。 */
	onSceneBundle(bundle: unknown, message: unknown): void;

	createRenderer(shared: SharedState): R;
	createInputBridge(ctx: AppBootstrapContext<C, R, B>): B;
	/** 桥接创建后立即初始化（debug=`sendInit(sharedBuffer,w,h,dpr)`；game 无）。 */
	initBridge?(bridge: B, ctx: AppBootstrapContext<C, R, B>): void;
	/** renderer.init 之前（debug=`applyRenderDebugSwitches(readRenderPrefs().debug)`）。 */
	beforeRendererInit?(ctx: AppBootstrapContext<C, R, B>): void;
	/** renderer.start() 之后（game 的 installFrameProbe 等可挂这里）。 */
	afterRendererStart?(ctx: AppBootstrapContext<C, R, B>): void;

	/** 状态栏 / 错误栏 / 权威健康日志 sink（对接各端现有函数）。 */
	status?(message: string, kind: 'success' | 'error' | ''): void;
	error?(message: string): void;
	health?(message: string): void;

	/** 端特有 Worker 消息：返回 true = 已消费，不再走通用分支。 */
	onWorkerMessage?(message: Record<string, unknown>, ctx: AppBootstrapContext<C, R, B>): boolean;

	/** 通用回调的端侧补充（记录/额外副作用）。 */
	onCullStats?(stats: unknown): void;
	onSceneLoaded?(deathY: number): void;
	onPlayerNameChange?(name: string, filterEnabled: boolean): void;
	onPhysEvent?(event: unknown): void;
}

/** createAppRuntime() 的返回：装配好的线程通道 + 通用回调骨架。 */
export interface AppRuntime<C, R extends AppRendererLike, B extends AppBridgeLike> {
	readonly profile: AppRuntimeProfile<C>;
	readonly worker: Worker;
	readonly canvas: HTMLCanvasElement;
	readonly config: C;
	readonly sharedBuffer: SharedArrayBuffer | null;
	readonly shared: SharedState;
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
	readonly renderer: R;
	/** bridgePhase='before-renderer' 时创建后即为非 null；'after-init' 在 init/start 后填充。 */
	bridge: B | null;
	/** 主线程 wasm 预热 promise（rejection 已转给 hooks.error，不会 unhandled）。 */
	readonly wasmReady: Promise<void>;
	/** 最近一次渲染器上报的死亡阈值 Y（0=未知）。 */
	readonly deathThresholdY: number;
	/** 立即下发死亡阈值（renderer.setDeathY + bridge.sendSetDeathThreshold，按端 policy 调用）。 */
	sendDeathThreshold(deathY: number): void;
	/** Step2 的 scene-bundle 后处理入口：转调端必选 hook（Step1 尚无调用点）。 */
	notifySceneBundle(bundle: unknown, message: unknown): void;
	dispose(): void;
}

/** runtime 通过这层结构访问 renderer 的通用回调属性（具体类型由端侧 RendererMain 持有）。 */
interface RendererCallbackSink {
	onCullStats?: ((stats: unknown) => void) | null;
	onSceneLoaded?: ((deathY: number) => void) | null;
	onPlayerNameChange?: ((name: string) => void) | null;
	onPlayerVelocity?: ((vel: [number, number, number], mode: 'add' | 'set') => void) | null;
	onSpeedCapChange?: ((cap: number) => void) | null;
	onJumpHeightChange?: ((height: number) => void) | null;
	onMapPhysicsParam?: ((name: string, value: number | boolean) => void) | null;
	onSyncRenderState?: ((state: SyncRenderStateLike, teleport: boolean) => void) | null;
	onPhysEvent?: ((event: unknown) => void) | null;
}

/**
 * 创建三端共用的 app bootstrap：外部只给 profile + hooks，runtime 按固定 9 步装配，
 * 端特有行为全部落在 hooks（见文件头）。
 */
export function createAppRuntime<C, R extends AppRendererLike, B extends AppBridgeLike>(
	profile: AppRuntimeProfile<C>,
	hooks: AppHooks<C, R, B>,
): AppRuntime<C, R, B> {
	const { canvas, config } = profile;
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	const dpr = globalThis.devicePixelRatio || 1;

	// ①（端侧已判定 sharedMemory；此处只建缓冲）
	const sharedBuffer = profile.sharedMemory ? new SharedArrayBuffer(SHARED_BUFFER_SIZE) : null;

	// ② Worker 创建
	let worker: Worker;
	if (profile.worker.inlineJs) {
		const blob = new Blob([profile.worker.inlineJs], { type: 'text/javascript' });
		worker = new Worker(URL.createObjectURL(blob));
	} else {
		worker = new Worker(profile.worker.url, { type: 'module' });
	}

	// ⑤ 共享状态先建（消息路由与回调都要用）
	const shared = createMainSharedState(sharedBuffer, worker);

	let deathThresholdY = 0;
	const ctx: AppBootstrapContext<C, R, B> = {
		profile,
		worker,
		canvas,
		config,
		sharedBuffer,
		shared,
		width,
		height,
		dpr,
		renderer: null,
		bridge: null,
	};

	const sendDeathThreshold = (deathY: number): void => {
		deathThresholdY = deathY;
		ctx.renderer?.setDeathY(deathY);
		ctx.bridge?.sendSetDeathThreshold?.(deathY);
	};
	const notifySceneBundle = (bundle: unknown, message: unknown): void => {
		hooks.onSceneBundle(bundle, message);
	};

	// ③ 消息路由（尽早挂上，避免 wasm 初始化早回的 ready 丢失）
	worker.onmessage = (e: MessageEvent<unknown>): void => {
		const message = e.data as Record<string, unknown> | null;
		if (!message || typeof message !== 'object') return;
		if (hooks.onWorkerMessage?.(message, ctx)) return;
		switch (String(message.type ?? '')) {
			case 'ready': {
				const ready = handleWorkerReady(message as ReadyMessageLike);
				if (ready.ok) {
					hooks.status?.('Worker 已就绪。请加载 .bsp 文件。', 'success');
				} else {
					console.error(`[worker] 协议版本不一致：worker=${ready.got} app=${ready.expected}`);
					hooks.status?.(workerStaleMessage(ready), 'error');
				}
				break;
			}
			case 'phys-frame': {
				// 回退模式（MsgState）：缓存 Worker 权威帧（readAuthoritative 读取）
				const frame = message as unknown as { frame: unknown; va: number };
				(shared as unknown as { recvFrame?: (frame: unknown, va: number) => void })
					.recvFrame?.(frame.frame, frame.va);
				break;
			}
			case 'phys-event': {
				// 权威碰撞事件：位置微调 + 角度同步（权威仅碰撞时可影响渲染）
				const ev = message as unknown as {
					kind: string;
					pos: readonly number[];
					yawDeg: number;
					pitchDeg: number;
					vel?: readonly number[];
				};
				ctx.renderer?.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg, ev.vel);
				break;
			}
			case 'health-log':
				hooks.health?.(String(message.message ?? ''));
				break;
			case 'error':
				hooks.error?.(String(message.message ?? ''));
				break;
			default:
				// 未知消息：忽略（向前兼容）
				break;
		}
	};
	worker.onerror = (e: ErrorEvent): void => {
		hooks.error?.(`Worker error: ${e.message} (${e.filename}:${e.lineno})`);
	};

	// ④ wasm 注入：内嵌构建走 postMessage（Blob Worker 读不到主线程 global）；
	// dev/multi 发 wasmUrl 由 worker 自行 fetch；mtzB64 两模式都带。
	if (profile.wasm.inlineB64) {
		worker.postMessage({ type: 'wasm-init', wasmB64: profile.wasm.inlineB64, mtzB64: profile.wasm.mtzB64 });
	} else {
		worker.postMessage({ type: 'wasm-init', wasmUrl: profile.wasm.url, mtzB64: profile.wasm.mtzB64 });
	}

	// ⑥ 桥接（按 bridgePhase：debug 在 renderer 之前；game 在 init/start 之后）
	const createBridge = (): void => {
		const bridge = hooks.createInputBridge(ctx);
		ctx.bridge = bridge;
		hooks.initBridge?.(bridge, ctx);
	};
	if (hooks.bridgePhase === 'before-renderer') createBridge();

	// ⑦ 渲染器 + 通用回调骨架
	const renderer = hooks.createRenderer(shared);
	ctx.renderer = renderer;
	const sink = renderer as unknown as RendererCallbackSink;
	sink.onCullStats = hooks.onCullStats ? (stats): void => hooks.onCullStats?.(stats) : null;
	sink.onSceneLoaded = (deathY: number): void => {
		// 记录与发送拆开：policy='immediate' 立即下发（debug 旧行为），否则等端侧显式调用
		// runtime.sendDeathThreshold()（game 在 buildPredictionWorld 之后）。
		hooks.onSceneLoaded?.(deathY);
		if (hooks.deathThresholdPolicy === 'immediate') sendDeathThreshold(deathY);
	};
	sink.onPlayerNameChange = (name: string): void => {
		const filterOff =
			(globalThis as unknown as { __vbspTeleportFilterOff?: boolean }).__vbspTeleportFilterOff === true;
		ctx.bridge?.sendSetPlayerName?.(name, !filterOff);
		hooks.onPlayerNameChange?.(name, !filterOff);
	};
	sink.onPlayerVelocity = (vel, mode): void => {
		if (mode === 'set') ctx.bridge?.sendSetPushVelocity?.(vel);
		else ctx.bridge?.sendAddVelocity?.(vel);
	};
	sink.onSpeedCapChange = (cap: number): void => {
		ctx.bridge?.sendSetSpeedCap?.(cap);
	};
	sink.onJumpHeightChange = (height: number): void => {
		ctx.bridge?.sendSetJumpHeight?.(height);
	};
	sink.onMapPhysicsParam = (name: string, value: number | boolean): void => {
		ctx.bridge?.sendSetMapPhysicsParam?.(name, value);
	};
	sink.onSyncRenderState = (state, teleport): void => {
		worker.postMessage({ type: 'sync-render-state', state, teleport });
	};
	sink.onPhysEvent = (event: unknown): void => {
		hooks.onPhysEvent?.(event);
	};

	// ⑧ 固定序：beforeRendererInit → init → start →（after-init 桥接）→ afterRendererStart
	hooks.beforeRendererInit?.(ctx);
	renderer.init(canvas, width, height, dpr, config);
	renderer.start();
	if (hooks.bridgePhase === 'after-init') createBridge();
	hooks.afterRendererStart?.(ctx);

	// ⑨ 主线程 wasm 预热：catch 掉 rejection（失败转状态栏，不制造 unhandled rejection）
	const wasmReady = hooks.ensureMainWasm(ctx).catch((err: unknown): void => {
		hooks.error?.(`主线程 WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
	});

	return {
		profile,
		worker,
		canvas,
		config,
		sharedBuffer,
		shared,
		width,
		height,
		dpr,
		get renderer(): R {
			return renderer;
		},
		get bridge(): B | null {
			return ctx.bridge;
		},
		wasmReady,
		get deathThresholdY(): number {
			return deathThresholdY;
		},
		sendDeathThreshold,
		notifySceneBundle,
		dispose(): void {
			worker.onmessage = null;
			worker.onerror = null;
			worker.terminate();
		},
	};
}
