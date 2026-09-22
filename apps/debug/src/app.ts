/**
 * apps/debug 的主线程装配入口。
 * 依次完成：取得全部 DOM 句柄 → 建共享缓冲（SAB）→ 起物理 Worker → 装配渲染物理
 * （主线程自己在 WASM 里跑一份物理并驱动渲染）→ 绑定键盘/鼠标与参数面板 → 注册文件加载入口。
 * 与 Worker 的分工：Worker 只算权威帧并回传快照/事件，主线程负责渲染、面板、HUD 与输入采集。
 */

import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { MouseBuffer } from '../../../src/ts-shared/input/mouse-buffer.js';
import { PointerLockController } from '../../../src/ts-shared/input/pointer-lock.js';
import {
	InputPlayer,
	InputRecorder,
	INPUT_REPLAY_SCHEMA,
} from './input/input-recorder.js';
import type { InputReplayMeta } from './input/input-recorder.js';
import { createConfig, applyConfigPatch } from './config.js';
import { loadDefaultTexturePack } from './default-pack.js';
import { ensureMainWasm, mainWasmUrl } from './main-wasm.js';
// 主线程侧的 WASM 入口：BSP 解析与 MTZ 解压（与 Worker 各自的 wasm 模块实例）
import { BspProcessor, decompress_mtz } from '../pkg/websurf_wasm.js';
import type { RuntimeConfig } from './config.js';
import type {
	MainMessage,
	SceneDataMessage,
	PhysFrameMessage,
	PhysEventMessage,
	PhysicsSnapshotMessage,
	PhysicsEventMessage,
	PlaneInfo,
} from './worker/worker-types.js';
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask, KEY_MASK } from '../../../src/ts-shared/auth/shared-state.js';
import type { SharedState } from '../../../src/ts-shared/auth/shared-state.js';
import { layerMouseDelta, qeEquivalentDx } from '../../../src/ts-shared/input/input-layer.js';
import { buildWorldBundle } from '../../../src/ts-shared/phys/world-builder.js';
import type { WorldMetadata } from '../../../src/ts-shared/phys/world-builder.js';
import { RendererMain, type CullStatsLike, type RenderPhysEvent } from './renderer/renderer-main.js';
import { formatTime, GameState } from './game-state.js';
// 物理控制面板：参数定义表（主线程渲染用，不含物理实现依赖）
import { PARAM_DEFS, type ParamSource } from './physics/param-defs.js';
// 面板参数名 → Rust set_params snake_case（physics-params.ts 导出）
import { PARAM_TO_RUST } from './physics/physics-params.js';
// 自定义传送点：localStorage 数据层
import {
	loadCustomTeleports,
	addCustomTeleport,
	removeCustomTeleport,
	clearCustomTeleports,
} from './world/custom-teleports.js';
import type { CustomTeleport } from './world/custom-teleports.js';
// 物理参数映射（渲染物理 + 输入录制 meta 共用同一份实现）
import { buildDebugPredictionParams } from './physics/prediction-params.js';

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const config: RuntimeConfig = createConfig();

const dom = {
	canvas: document.getElementById('preview') as HTMLCanvasElement | null,
	fileInput: document.getElementById('bspFile') as HTMLInputElement | null,
	statusEl: document.getElementById('status') as HTMLElement | null,
	metadataEl: document.getElementById('metadata') as HTMLElement | null,
	statsEl: document.getElementById('stats') as HTMLElement | null,
	cullStatsEl: document.getElementById('cullStats') as HTMLElement | null,
	gameStatsEl: document.getElementById('gameStats') as HTMLElement | null,
	hudEl: document.getElementById('hud') as HTMLElement | null,
	crosshairEl: document.getElementById('crosshair') as HTMLElement | null,
	hudVisibleChk: document.getElementById('hudVisible') as HTMLInputElement | null,
	showCrosshairChk: document.getElementById('showCrosshair') as HTMLInputElement | null,
	// 准星风格化
	chColor: document.getElementById('chColor') as HTMLInputElement | null,
	chSizeRange: document.getElementById('chSize') as HTMLInputElement | null,
	chSizeNum: document.getElementById('chSizeNum') as HTMLInputElement | null,
	chThicknessRange: document.getElementById('chThickness') as HTMLInputElement | null,
	chThicknessNum: document.getElementById('chThicknessNum') as HTMLInputElement | null,
	chGapRange: document.getElementById('chGap') as HTMLInputElement | null,
	chGapNum: document.getElementById('chGapNum') as HTMLInputElement | null,
	chOutlineChk: document.getElementById('chOutline') as HTMLInputElement | null,
	chDotChk: document.getElementById('chDot') as HTMLInputElement | null,
	physicsModeSelect: document.getElementById('physicsMode') as HTMLSelectElement | null,
	colliderSourceSelect: document.getElementById('colliderSource') as HTMLSelectElement | null,
	tickRateRange: document.getElementById('tickRate') as HTMLInputElement | null,
	tickRateNum: document.getElementById('tickRateNum') as HTMLInputElement | null,
	mouseSensRange: document.getElementById('mouseSens') as HTMLInputElement | null,
	mouseSensNum: document.getElementById('mouseSensNum') as HTMLInputElement | null,
	yawBindSpeedRange: document.getElementById('yawBindSpeed') as HTMLInputElement | null,
	yawBindSpeedNum: document.getElementById('yawBindSpeedNum') as HTMLInputElement | null,
	pitchLimitRange: document.getElementById('pitchLimit') as HTMLInputElement | null,
	pitchLimitNum: document.getElementById('pitchLimitNum') as HTMLInputElement | null,
	cullDistRange: document.getElementById('cullDistance') as HTMLInputElement | null,
	cullDistNum: document.getElementById('cullDistanceNum') as HTMLInputElement | null,
	pvsEnabledChk: document.getElementById('pvsEnabled') as HTMLInputElement | null,
	respawnBtn: document.getElementById('respawnBtn') as HTMLButtonElement | null,
	spawnSelect: document.getElementById('spawnSelect') as HTMLSelectElement | null,
	// 纹理画质（显示设置面板）
	textureQualityRadios: document.querySelectorAll('input[name="textureQuality"]') as NodeListOf<HTMLInputElement>,
	// 光照模式（预烘焙 / 纯纹理：预烘焙纹理多、进图更卡；纯纹理最快但无明暗）
	lightingModeRadios: document.querySelectorAll('input[name="lightingMode"]') as NodeListOf<HTMLInputElement>,
	// 缺失材质纹理确认弹窗
	missingTexturesModal: document.getElementById('missingTexturesModal') as HTMLElement | null,
	missingTexturesSummary: document.getElementById('missingTexturesSummary') as HTMLElement | null,
	missingTexturesList: document.getElementById('missingTexturesList') as HTMLElement | null,
	missingTexturesOk: document.getElementById('missingTexturesOk') as HTMLButtonElement | null,
	// 物理路径记录（渲染物理线 + tick 物理线）
	pathToggleBtn: document.getElementById('pathToggleBtn') as HTMLButtonElement | null,
	pathClearBtn: document.getElementById('pathClearBtn') as HTMLButtonElement | null,
	pathExportJsonBtn: document.getElementById('pathExportJsonBtn') as HTMLButtonElement | null,
	pathExportCsvBtn: document.getElementById('pathExportCsvBtn') as HTMLButtonElement | null,
	pathVisibleChk: document.getElementById('pathVisibleChk') as HTMLInputElement | null,
	pathRenderVisibleChk: document.getElementById('pathRenderVisibleChk') as HTMLInputElement | null,
	pathTickVisibleChk: document.getElementById('pathTickVisibleChk') as HTMLInputElement | null,
	pathDeviVisibleChk: document.getElementById('pathDeviVisibleChk') as HTMLInputElement | null,
	pathDotsVisibleChk: document.getElementById('pathDotsVisibleChk') as HTMLInputElement | null,
	pathCountsEl: document.getElementById('pathCounts') as HTMLElement | null,
	// 输入录制 / 确定性回放（用户录一段，开发者无头复现）
	inputRecStatusEl: document.getElementById('inputRecStatus') as HTMLElement | null,
	inputRecToggleBtn: document.getElementById('inputRecToggleBtn') as HTMLButtonElement | null,
	inputRecClearBtn: document.getElementById('inputRecClearBtn') as HTMLButtonElement | null,
	inputRecExportBtn: document.getElementById('inputRecExportBtn') as HTMLButtonElement | null,
	inputRecLoadBtn: document.getElementById('inputRecLoadBtn') as HTMLButtonElement | null,
	inputRecStopPlayBtn: document.getElementById('inputRecStopPlayBtn') as HTMLButtonElement | null,
	inputRecFile: document.getElementById('inputRecFile') as HTMLInputElement | null,
	// 显示设置（显示设置面板）
	showSolidsChk: document.getElementById('showSolids') as HTMLInputElement | null,
	brushViewDistanceRange: document.getElementById('brushViewDistance') as HTMLInputElement | null,
	brushViewDistanceNum: document.getElementById('brushViewDistanceNum') as HTMLInputElement | null,
	showTriggersChk: document.getElementById('showTriggers') as HTMLInputElement | null,
	triggerViewDistanceRange: document.getElementById('triggerViewDistance') as HTMLInputElement | null,
	triggerViewDistanceNum: document.getElementById('triggerViewDistanceNum') as HTMLInputElement | null,
	showPhyChk: document.getElementById('showPhy') as HTMLInputElement | null,
	phyViewDistanceRange: document.getElementById('phyViewDistance') as HTMLInputElement | null,
	phyViewDistanceNum: document.getElementById('phyViewDistanceNum') as HTMLInputElement | null,
	showVisChk: document.getElementById('showVis') as HTMLInputElement | null,
	visViewDistanceRange: document.getElementById('visViewDistance') as HTMLInputElement | null,
	visViewDistanceNum: document.getElementById('visViewDistanceNum') as HTMLInputElement | null,
	showChamfersChk: document.getElementById('showChamfers') as HTMLInputElement | null,
	chamferViewDistanceRange: document.getElementById('chamferViewDistance') as HTMLInputElement | null,
	chamferViewDistanceNum: document.getElementById('chamferViewDistanceNum') as HTMLInputElement | null,
	showPlaneInfoChk: document.getElementById('showPlaneInfo') as HTMLInputElement | null,
	planeInfoEl: document.getElementById('planeInfo') as HTMLElement | null,
	// 贴墙近平面自适应：两张滑块分别写 rendererMain.setNearParams 的探测距离与收缩系数
	nearProbeDistRange: document.getElementById('nearProbeDist') as HTMLInputElement | null,
	nearProbeDistNum: document.getElementById('nearProbeDistNum') as HTMLInputElement | null,
	nearRatioRange: document.getElementById('nearRatio') as HTMLInputElement | null,
	nearRatioNum: document.getElementById('nearRatioNum') as HTMLInputElement | null,
	ambientIntensityRange: document.getElementById('ambientIntensity') as HTMLInputElement | null,
	ambientIntensityNum: document.getElementById('ambientIntensityNum') as HTMLInputElement | null,
	// 物理控制面板（碰撞箱体型控件 + 参数表容器 + 全部复位按钮）
	hullScale: document.getElementById('hullScale') as HTMLInputElement | null,
	hullScaleNum: document.getElementById('hullScaleNum') as HTMLInputElement | null,
	hullHalfWidth: document.getElementById('hullHalfWidth') as HTMLInputElement | null,
	hullHalfWidthNum: document.getElementById('hullHalfWidthNum') as HTMLInputElement | null,
	hullStandHeight: document.getElementById('hullStandHeight') as HTMLInputElement | null,
	hullStandHeightNum: document.getElementById('hullStandHeightNum') as HTMLInputElement | null,
	hullDuckHeight: document.getElementById('hullDuckHeight') as HTMLInputElement | null,
	hullDuckHeightNum: document.getElementById('hullDuckHeightNum') as HTMLInputElement | null,
	autoRestoreHullChk: document.getElementById('autoRestoreHull') as HTMLInputElement | null,
	resetHullBtn: document.getElementById('resetHullBtn') as HTMLButtonElement | null,
	hullSourceBadge: document.getElementById('hullSourceBadge') as HTMLElement | null,
	physicsParamList: document.getElementById('physicsParamList') as HTMLElement | null,
	resetAllPhysicsBtn: document.getElementById('resetAllPhysicsBtn') as HTMLButtonElement | null,
	// 自定义传送点面板（新增表单、列表、折叠区）
	capturePosBtn: document.getElementById('capturePosBtn') as HTMLButtonElement | null,
	addTeleportBtn: document.getElementById('addTeleportBtn') as HTMLButtonElement | null,
	customTeleportList: document.getElementById('customTeleportList') as HTMLElement | null,
	customTeleportDetails: document.getElementById('customTeleportDetails') as HTMLDetailsElement | null,
	addTeleportForm: document.getElementById('addTeleportForm') as HTMLFormElement | null,
	tpX: document.getElementById('tpX') as HTMLInputElement | null,
	tpY: document.getElementById('tpY') as HTMLInputElement | null,
	tpZ: document.getElementById('tpZ') as HTMLInputElement | null,
	tpName: document.getElementById('tpName') as HTMLInputElement | null,
	tpYaw: document.getElementById('tpYaw') as HTMLInputElement | null,
	tpCancel: document.getElementById('tpCancel') as HTMLButtonElement | null,
	errorEl: document.getElementById('error') as HTMLElement | null,
} as const;

const keyboard = new KeyboardInput();
const mouseBuffer = new MouseBuffer();
const pointerLock = new PointerLockController();

let worker: Worker | null = null;
let inputBridge: InputBridge | null = null;
/** 跨线程状态通道（src/ts-shared/auth/shared-state.ts 的 createMainSharedState）：有 SAB 时输入与权威帧走共享槽，无 SAB 时走 MsgState 的 postMessage 通道（phys-frame 由 recvFrame 收回）。 */
let sharedState: SharedState | null = null;
/**
 * 出生点传送去重游标：与上一次相同（或非数）的索引不再下发，
 * 换图时由 handleBspFile 置 -1 重新开放。
 */
let lastTeleportIdx = -1;
/** 主线程渲染器：持主线程 WASM 物理与 Three.js 场景，渲染、剔除与面板即时生效都经它。 */
let rendererMain: RendererMain | null = null;
let sceneReady = false;

/** 计时挑战状态机（主线程本地持有）：由渲染物理事件与输入循环驱动，权威 Worker 不参与。 */
const game = new GameState();

/** 场景死亡阈值 Y（rendererMain.onSceneLoaded 的回调入参）：写渲染物理与权威 Worker 双方；
 * handleLoadBsp 在 world-json 之后再发一次，使权威侧在本次世界重建后持有同一阈值。 */
let sceneDeathY: number | null = null;

// 自定义传送点的 localStorage 分组键（当前地图名）
let teleportMapName = '';
/** 最近一次加载的 BSP 文件（__wsInput.reloadForTest 重建世界用；诊断入口）。 */
let lastBspFile: File | null = null;
/** 最近一次加载的出生点列表 [x,y,z,yaw]：spawn 下拉切换与输入录制 meta 共用同一份。 */
let loadedSpawnList: Array<[number, number, number, number]> = [];
/** 滚轮连跳脉冲：滚轮事件置位，下一次输入循环并进按键掩码后清零。 */
let wheelJumpPending = false;

// ── 输入录制 / 确定性回放（用户录一段，开发者无头复现）─────────────────────
// 录制/回放器实现见 apps/debug/src/input/input-recorder.ts；面板见 web/index.html 的「输入录制」区。
// 常态（既不录制也不回放）下输入直接来自设备：鼠标由 mousemove 直连 rendererMain.feedInput，按键由输入循环合成。
/** 用户录制器（面板按钮与 __wsInput 驱动；仅在录制状态落样本）。 */
const inputRecorder = new InputRecorder();
/** 回放期「实际喂出去的帧」捕获器（与用户录制器互不干扰；确定性自检用）。 */
const replayCapture = new InputRecorder();
replayCapture.setAlwaysOn(true); // 常开落样本，不受录制状态门控
/** 回放器（载入 JSON 后由输入循环或 __wsInput.tickReplay 驱动）。 */
const inputPlayer = new InputPlayer();
/** 回放中：输入改由回放样本决定，设备键鼠与合成队列不参与本帧。 */
let inputReplaying = false;
/** 回放捕获闸门：只在回放期把喂出去的值写进 replayCapture。 */
let replayCaptureArmed = false;
/** 回放期走过回放分支的帧数（__wsInput.counts() 报出，用于确认覆盖真的发生）。 */
let replayLoopFrames = 0;
/**
 * 上一次真正喂出去的回放样本下标（初值 -2 = 尚未喂过）。
 *
 * 输入循环每帧跑一次，而 __wsInput.tickReplay 要走两拍 rAF 才结算，同一个样本会被看到两次；
 * rendererMain.feedInput 的 dx/dy 是累加语义，重复喂会给该帧双倍位移，回放捕获也会变成
 * 一帧两条。故同一游标只喂一次（input-recorder.ts 的 next() 保持当前帧、不推游标）。
 */
let lastFedReplayIndex = -2;
/** 回放元数据（载入 JSON 时保存、可被 __wsInput.setPlaybackMeta 覆盖；armReplay 依它还原起点并核对地图名）。 */
let playbackMeta: Partial<InputReplayMeta> = {};
/** 录制/回放状态行的刷新节流：距上次重绘满 100ms 才更新一次。 */
let lastRecUiAt = 0;
/**
 * 确定性回放的等待计数（__wsInput.tickReplay → replayAdvanceAndWait）。
 * 0 = 可推进；1 = 已推进一帧、等输入循环消费后自减回 0；推进中再调返回 busy。
 */
let replayTickWait = 0;
/**
 * 回放游标推进权归属：`false` = 输入循环自己推进（面板路径，由 rAF 驱动）；
 * `true` = 由 __wsInput.tickReplay → replayAdvanceAndWait 推进（无头协议）。
 *
 * 推进权只有一份：拿到权的一侧调 inputPlayer.stepReplay，另一侧只消费当前游标。
 */
let externalReplayClock = false;
/**
 * 合成输入队列（**只由 __wsInput.pushSynthetic 填充**，用户操作不写入）。
 *
 * 用途：让无头验证的合成输入与真实设备输入走同一条输入路径（同一处 Q/E 合并、同一录制点），
 * 「录制 → 回放」比对才处于同一口径。
 */
const syntheticQueue: Array<{ dx: number; dy: number; keys: number }> = [];
/** 出队一帧合成输入；null = 本帧没有合成输入（改用设备输入）。 */
function takeSynthetic(): { dx: number; dy: number; keys: number } | null {
	return syntheticQueue.length > 0 ? syntheticQueue.shift() ?? null : null;
}

// HUD 本地采样：FPS 由主线程 rAF 计数，累计满 1 秒刷新一次 localFps
let localFps = 0;
let fpsFrames = 0;
let fpsTime = 0;

/** 主线程 wasm 就绪 promise（默认已 resolved；渲染器初始化处改赋 ensureMainWasm 的结果）。
 * handleBspFile 在解析前 await 它，保证 BspProcessor / decompress_mtz 可用。 */
let mainWasmReady: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!dom.canvas) {
		console.error('[app] canvas#preview 元素未找到');
		return;
	}

	// 0. 共享内存通道（SharedArrayBuffer 需 crossOriginIsolated；dev 已配 COOP/COEP）。
	//    条件不满足则退回 postMessage 数据通道（功能等价、延迟更高）。
	const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
	let sharedBuffer: SharedArrayBuffer | null = null;
	if (isolated && typeof SharedArrayBuffer !== 'undefined') {
		sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
		console.log('[app] crossOriginIsolated 已启用，使用共享内存输入/物理通道');
	} else {
		console.warn('[app] 未启用 crossOriginIsolated，回退 postMessage 输入通道（延迟较高）');
	}

	// 1. 创建 Worker + 共享状态
	// 内嵌构建：用构建注入的 __VBSP_WORKER_JS__ 建 Blob URL（file:// 下 module worker 不可用）；
	// dev 模式：从 ./worker.js 加载 ES module worker。
	const embeddedWorker = (globalThis as unknown as { __VBSP_WORKER_JS__?: string }).__VBSP_WORKER_JS__;
	if (embeddedWorker) {
		const blob = new Blob([embeddedWorker], { type: 'text/javascript' });
		worker = new Worker(URL.createObjectURL(blob));
	} else {
		worker = new Worker('./worker.js', { type: 'module' });
	}
	worker.onmessage = handleWorkerMessage;
	worker.onerror = (e) => {
		setError(`Worker error: ${e.message} (${e.filename}:${e.lineno})`);
	};

	// WASM 注入：内嵌模式把 __VBSP_WASM_B64__ 经 postMessage 交给 worker
	//（Blob Worker 读不到主线程 global）；dev/multi 模式发 wasmUrl，由 worker 自行 fetch。
	// 默认纹理包 base64 一并下发，Worker 侧只暂存（apps/debug/src/worker/main.ts 的 setMtzB64）。
	const embeddedWasm = (globalThis as unknown as { __VBSP_WASM_B64__?: string }).__VBSP_WASM_B64__;
	const embeddedMtz = (globalThis as unknown as { __VBSP_TEXTURES_MTZ_B64__?: string }).__VBSP_TEXTURES_MTZ_B64__;
	if (embeddedWasm) {
		worker.postMessage({ type: 'wasm-init', wasmB64: embeddedWasm, mtzB64: embeddedMtz });
	} else {
		worker.postMessage({
			type: 'wasm-init',
			wasmUrl: mainWasmUrl(),
			mtzB64: embeddedMtz,
		});
	}

	const sharedStateInstance = createMainSharedState(sharedBuffer, worker);
	sharedState = sharedStateInstance;
	inputBridge = new InputBridge(worker);
	inputBridge.sendInit(
		sharedBuffer,
		dom.canvas.clientWidth,
		dom.canvas.clientHeight,
		window.devicePixelRatio,
	);

	// 2. 主线程渲染器
	rendererMain = new RendererMain(sharedStateInstance);
	rendererMain.onCullStats = updateCullStatsUI;
	rendererMain.onSceneLoaded = (deathThresholdY) => {
		// 双端设置掉落死亡阈值（主线程渲染物理 + 权威 Worker）。
		// onSceneLoaded 早于 world-json 触发，故 handleLoadBsp 在 world-json 之后再发一次。
		sceneDeathY = deathThresholdY;
		rendererMain?.setDeathY(deathThresholdY);
		inputBridge?.sendSetDeathThreshold(deathThresholdY);
	};
	// 渲染主线 → 权威反向同步：teleport=true（真位置突变）由权威侧清未消费输入增量；
	// teleport=false 走常规重锚，只注入状态、保留输入增量——清输入会造成可见的瞄准顿挫。
	rendererMain.onSyncRenderState = (s, teleport) => {
		worker?.postMessage({ type: 'sync-render-state', state: s, teleport });
	};
	// 主线程渲染物理事件（Rust take_event 产出：teleport / death）→ 计时挑战状态机
	rendererMain.onPhysEvent = onRenderPhysEvent;
	rendererMain.init(
		dom.canvas,
		dom.canvas.clientWidth,
		dom.canvas.clientHeight,
		window.devicePixelRatio,
		config,
	);
	rendererMain.start();
	// 主线程 wasm 懒初始化（mosaic 解压与地图加载依赖它；与 worker 的 wasm 实例互不影响）。
	// 保存 promise：handleBspFile 开头 await，避免解析时 wasm 尚未就绪。
	mainWasmReady = ensureMainWasm().catch((err) => {
		setError(`主线程 WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
	});

	// 3. 绑定输入
	bindInput(dom.canvas);
	// 3.2 面板偏好持久化：读取 → 合并 config → 同步控件 → 应用准星 → 下发双端
	loadUiPrefs();
	syncPrefsControls();
	applyCrosshairStyle();
	sendPrefsToWorker();
	bindUI();
	// 3.3 初始控件状态（config 默认值 → 面板）
	if (dom.colliderSourceSelect) dom.colliderSourceSelect.value = config.physics.colliderSource;
	if (dom.pvsEnabledChk) dom.pvsEnabledChk.checked = config.lod.pvsEnabled;
	if (dom.physicsModeSelect) dom.physicsModeSelect.value = config.physics.mode;

	// 4. 输入循环（设备 / 回放 / 合成三条路径 → 主线程渲染物理 + SAB 权威端）
	startInputLoop();
	// 4.1 输入录制面板初始状态
	updateInputRecUi();
}

// ---------------------------------------------------------------------------
// Worker 消息处理
// ---------------------------------------------------------------------------

function handleWorkerMessage(e: MessageEvent<MainMessage>): void {
	const msg = e.data;
	if (!msg || typeof msg !== 'object') return;
	switch (msg.type) {
		case 'ready':
			// 阶段 2：Worker 不再需要同步配置（world-json 后由 handleLoadBsp 发送）
			setStatus('Worker 已就绪。请加载 .bsp 文件。', 'success');
			break;
		case 'phys-frame': {
			// 回退模式（MsgState）：缓存 Worker 权威帧（readAuthoritative 读取）
			const f = msg as unknown as PhysFrameMessage;
			(sharedState as { recvFrame?: (frame: PhysFrameMessage['frame'], va: number) => void })?.recvFrame?.(f.frame, f.va);
			break;
		}
		case 'phys-event': {
			// 权威碰撞事件（落地/撞墙）：位置微调 + 角度同步（权威仅碰撞时可影响渲染）
			const ev = msg as unknown as PhysEventMessage;
			rendererMain?.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg, ev.vel);
			break;
		}
		case 'physics-snapshot':
			renderPhysicsSnapshot(msg);
			break;
		case 'physics-event':
			onPhysicsEvent(msg);
			break;
		case 'health-log':
			pushHealthLog(msg.message);
			break;
		case 'error':
			setError(msg.message);
			break;
		default:
			// 未知消息：忽略（向前兼容）
			break;
	}
}

/**
 * 场景就绪（主线程解析完成）：启用控件 + 同步面板状态 + 缺失纹理弹窗。
 * 原 handleSceneData 的 UI 部分（渲染已由主线程 loadScene 本地完成）。
 */
async function onSceneReadyUi(
	diag: { diagonal: number; defaultCull: number; maxCull: number } | null,
	msg: SceneDataMessage,
): Promise<void> {
	setStatus(
		`场景已加载（GLB ${msg.glbSizeKb} KB，${msg.metadata.numBrushes} brushes，` +
			`${msg.numSpawnPoints} 出生点，PVS 已停用（照搬 game），` +
			`对角线 ${(diag?.diagonal ?? 0).toFixed(0)} HU）`,
		'success',
	);
	// 缺失材质纹理：与默认纹理包比对后列出，等待用户确认
	void showMissingTextures(msg.missingTextures);
	// 动态设置视距剔除滑块范围（真实值由主线程 LOD 计算；控件本身进入地图前已可用）
	if (dom.cullDistRange && diag) {
		dom.cullDistRange.min = '1000';
		dom.cullDistRange.max = String(Math.ceil(diag.maxCull));
		dom.cullDistRange.value = String(diag.defaultCull);
	}
	if (dom.cullDistNum && diag) {
		dom.cullDistNum.max = String(Math.ceil(diag.maxCull));
		dom.cullDistNum.value = String(diag.defaultCull);
	}
	// 启用控件（进入地图前即可设置的：物理模式/碰撞来源/PVS/视距已在 HTML 初始可用）
	if (dom.respawnBtn) dom.respawnBtn.disabled = false;
	if (dom.spawnSelect) dom.spawnSelect.disabled = false;
	// PVS 剔除：复选框同步 config.lod.pvsEnabled
	if (dom.pvsEnabledChk) {
		dom.pvsEnabledChk.checked = config.lod.pvsEnabled;
	}
	// 自定义传送点：启用两个按钮并从 localStorage 刷新列表
	if (dom.capturePosBtn) dom.capturePosBtn.disabled = false;
	if (dom.addTeleportBtn) dom.addTeleportBtn.disabled = false;
	renderCustomTeleports();
	// 显示设置：把 config.debug 的显示开关与视距回填到控件
	if (dom.showSolidsChk) dom.showSolidsChk.checked = config.debug.showSolids;
	if (dom.brushViewDistanceRange) dom.brushViewDistanceRange.value = String(config.debug.brushViewDistance);
	if (dom.brushViewDistanceNum) dom.brushViewDistanceNum.value = String(config.debug.brushViewDistance);
	if (dom.showTriggersChk) dom.showTriggersChk.checked = config.debug.showTriggers;
	if (dom.triggerViewDistanceRange) dom.triggerViewDistanceRange.value = String(config.debug.triggerViewDistance);
	if (dom.triggerViewDistanceNum) dom.triggerViewDistanceNum.value = String(config.debug.triggerViewDistance);
	if (dom.showPhyChk) dom.showPhyChk.checked = config.debug.showPhy;
	if (dom.phyViewDistanceRange) dom.phyViewDistanceRange.value = String(config.debug.phyViewDistance);
	if (dom.phyViewDistanceNum) dom.phyViewDistanceNum.value = String(config.debug.phyViewDistance);
	if (dom.showVisChk) dom.showVisChk.checked = config.debug.showVis;
	if (dom.visViewDistanceRange) dom.visViewDistanceRange.value = String(config.debug.visViewDistance);
	if (dom.visViewDistanceNum) dom.visViewDistanceNum.value = String(config.debug.visViewDistance);
	if (dom.showChamfersChk) dom.showChamfersChk.checked = config.debug.showChamfers;
	if (dom.chamferViewDistanceRange) dom.chamferViewDistanceRange.value = String(config.debug.chamferViewDistance);
	if (dom.chamferViewDistanceNum) dom.chamferViewDistanceNum.value = String(config.debug.chamferViewDistance);
	if (dom.showPlaneInfoChk) dom.showPlaneInfoChk.checked = config.debug.showPlaneInfo;
	// 纹理画质：按 config.texture.quality 勾选对应 radio
	dom.textureQualityRadios.forEach((radio) => {
		radio.checked = radio.value === config.texture.quality;
	});
	// 光照模式：按 config.lighting.mode（缺省 baked）勾选 radio；渲染器 init 时已按 config 设好模块级开关
	dom.lightingModeRadios.forEach((radio) => {
		radio.checked = radio.value === (config.lighting.mode ?? 'baked');
	});
}

// ---------------------------------------------------------------------------
// 缺失材质纹理：与默认纹理包（textures.mtz）的键集合比对后列成清单，等用户点确认
//（本段只做展示与统计，不在这里改场景材质）
// ---------------------------------------------------------------------------

/** 确认按钮：只隐藏弹窗（本模块不执行纹理回退）。 */
function handleMissingFallback(): void {
	dom.missingTexturesModal?.classList.add('hidden');
}

/**
 * 展示缺失材质纹理清单（场景就绪后由 onSceneReadyUi 调用；无缺失立即返回）。
 *
 * 逐项与默认纹理包比对：`materials/<小写名>` 命中归入「可覆盖」，未命中归入「缺失」；
 * 两组都只写进弹窗 DOM，不改变场景材质。
 */
async function showMissingTextures(missing: string[] | undefined): Promise<void> {
	if (!missing || missing.length === 0) return;
	const pack = await loadDefaultTexturePack();
	const covered: string[] = [];
	const orphan: string[] = [];
	for (const name of missing) {
		const key = `materials/${name}`.toLowerCase();
		if (pack && key in pack) {
			covered.push(name);
		} else {
			orphan.push(name);
		}
	}
	// 先移除旧监听再挂新监听：弹窗重复展示时不叠加处理器
	dom.missingTexturesOk?.removeEventListener('click', handleMissingFallback);
	dom.missingTexturesOk?.addEventListener('click', handleMissingFallback);
	const listEl = dom.missingTexturesList;
	const summaryEl = dom.missingTexturesSummary;
	const modal = dom.missingTexturesModal;
	if (!listEl || !summaryEl || !modal) return;

	summaryEl.innerHTML =
		`本图有 <b>${missing.length}</b> 个材质纹理缺失（BSP 内找不到 VMT/VTF）：` +
		`<br/>默认纹理包已自动回退 <b class="mt-ok-num">${covered.length}</b> 个（低清纹理），` +
		`完全缺失 <b class="mt-bad-num">${orphan.length}</b> 个（保持占位色）。`;
	listEl.innerHTML = '';
	const rows: HTMLElement[] = [];
	for (const name of covered) {
		const row = document.createElement('div');
		row.className = 'mt-row';
		row.innerHTML = `<span class="mt-covered">✓ 可覆盖</span> ${escapeHtml(name)}`;
		rows.push(row);
	}
	for (const name of orphan) {
		const row = document.createElement('div');
		row.className = 'mt-row';
		row.innerHTML = `<span class="mt-orphan">✗ 缺失</span> ${escapeHtml(name)}`;
		rows.push(row);
	}
	listEl.append(...rows);
	modal.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// HUD（主线程本地采样，无 Worker 回传）
// ---------------------------------------------------------------------------

/** 主 HUD 统计行：位置/速度/onGround/PVS cluster 取自主线程渲染物理，FPS 取 localFps。 */
function updateStatsUI(): void {
	if (!dom.statsEl) return;
	const st = rendererMain?.getCurrentState();
	if (!st) return;
	const cluster = rendererMain?.getPvsCluster() ?? -1;
	const lateral = Math.hypot(st.vel.x, st.vel.z);
	const text =
		`FPS ${localFps}  位置 ${st.pos.x.toFixed(0)},${st.pos.y.toFixed(0)},${st.pos.z.toFixed(0)}  ` +
		`速度 ${lateral.toFixed(0)}  ${st.onGround ? '地面' : '空中'}  cluster ${cluster >= 0 ? cluster : '—'}`;
	dom.statsEl.textContent = text;
	if (dom.planeInfoEl) {
		dom.planeInfoEl.textContent = formatPlaneInfo(rendererMain?.getPlaneInfo() ?? null);
	}
}

/** 准星信息格式化（按 PlaneInfo.type 分 mesh / solid / ladder / trigger 四支）。 */
function formatPlaneInfo(info: PlaneInfo | null): string {
	if (!info) return '准星 —';
	const [px, py, pz] = info.point;
	const dist = info.distance.toFixed(0);
	switch (info.type) {
		case 'mesh': {
			const m = info.meshMeta;
			const flags = m
				? [
						m.isTools ? '工具' : null,
						m.isNodraw ? 'nodraw' : null,
						m.isWater ? '水面' : null,
						m.isTrans ? '半透明' : null,
						m.isLightEmissive ? '发光' : null,
					]
						.filter(Boolean)
						.join(' ')
				: '';
			return (
				`准星 模型「${info.meshName ?? ''}」 ${dist}HU [${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}]` +
				(info.materialName ? ` 材质:${info.materialName}` : '') +
				(info.textureName ? ` 纹理:${info.textureName}` : '') +
				(flags ? ` (${flags})` : '')
			);
		}
		case 'solid':
		case 'ladder': {
			const n = info.normal ? info.normal.map((v) => v.toFixed(2)).join(',') : '—';
			return (
				`准星 ${info.type === 'solid' ? '实体面' : '梯子面'}` +
				`#${info.brushIndex} ${dist}HU 法线(${n}) [${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}]`
			);
		}
		case 'trigger': {
			const t = info.triggerTarget ?? '—';
			const dest = info.triggerDestIdx ?? -1;
			return (
				`准星 触发面「${info.triggerClassname ?? 'trigger'}」→${t}(dest#${dest}) ${dist}HU` +
				(info.triggerStartDisabled ? ' [禁用]' : '')
			);
		}
		default:
			return '准星 —';
	}
}

/** 剔除统计行（rendererMain.onCullStats 回调；可见数、PVS cluster、LOD 远近由渲染器本地给出）。 */
function updateCullStatsUI(msg: CullStatsLike): void {
	if (dom.cullStatsEl) {
		const p = msg.pvs;
		dom.cullStatsEl.textContent =
			`可见 ${msg.visible}/${msg.total} (cull=${msg.cullDist.toFixed(0)})  ` +
			`PVS: cluster=${p.cluster >= 0 ? p.cluster : '—'} ` +
			`${p.visibleClusters}/${p.totalClusters} 可见 隐藏${p.pvsHidden}  LOD 近${p.near}/远${p.far}`;
	}
	updatePathCountsUI(); // 顺带刷新路径记录点数（~10Hz，够用）
}

// ---------------------------------------------------------------------------
// 物理路径记录（面板接线）
// 两条线共用一个 PathRecorder：渲染线 = 主线程渲染物理每个物理步一个节点，
// tick 线 = 权威帧节点。节点取脚底中心（PhysWorld origin 的 x/y/z），按计算节点采样而非定时轮询。
// ---------------------------------------------------------------------------

/** 刷新记录状态、点数、垂距/偏差梳与折线自检（面板与导出按钮都调它）。 */
function updatePathCountsUI(): void {
	if (!dom.pathCountsEl || !rendererMain) return;
	const c = rendererMain.getPathCounts();
	const rec = rendererMain.isPathRecording() ? '● 记录中' : '未开始';
	const d = rendererMain.getPathDeviStats();
	// ── 两个度量分开显示、分开标注（口径不同）──────────────────────────
	// 垂距 perp = tick 点到渲染折线的最短距离（不敏感于采样相位）；
	// 偏差梳 = tick 点与渲染线同一时刻位置的差（时间对齐，含切向滞后）。
	const perp = d.perp.n
		? `　<b>垂距</b> p50 ${d.perp.p50.toFixed(1)} / <b>p95 ${d.perp.p95.toFixed(1)}</b> / max ${d.perp.max.toFixed(1)} HU` +
			`（n=${d.perp.n}；HUD 近似 ±250ms 窗，**验收以 CI 脚本为准**）`
		: '';
	const devi = d.n
		? `　<b>偏差梳</b>（时间对齐）均值 ${d.mean.toFixed(1)} / 最大 ${d.max.toFixed(1)} HU` +
			`（<span style="color:#26d966">≤10:${d.green}</span> <span style="color:#ffd926">≤30:${d.yellow}</span> <span style="color:#ff2626">&gt;30:${d.red}</span>）`
		: '';
	const resid = d.residual.n ? `　残差 p95 ${d.residual.p95.toFixed(2)} HU` : '';
	// 折线形状自检：长度比 = 绘制长度 / 节点直线长度；直连为 1.000，ratio > 1.15 即标红
	const sh = rendererMain.getPathShapeStats();
	let shape = '';
	if (sh.total > 0) {
		const ratio = sh.lenRatio;
		const bad = ratio > 1.15;
		shape =
			`<br />折线自检：段 ${sh.total}　长度比 ${ratio.toFixed(3)}（直连=1.000）` +
			`　轴对齐 ${((100 * sh.axis) / sh.total).toFixed(0)}%　折角&gt;45° ${((100 * sh.hard45) / sh.total).toFixed(0)}%` +
			(bad
				? ` <span style="color:#ff2626">← 长度比 >1.15：折线被展开成阶梯（异常）</span>`
				: ` <span style="color:#26d966">← 节点直连（正常）</span>`);
	}
	dom.pathCountsEl.innerHTML =
		`${rec} · 渲染 ${c.render} 点 / tick ${c.tick} 点${perp}${devi}${resid}${shape}`;
}

/** 以隐藏 anchor + Blob URL 触发浏览器下载。 */
function downloadText(filename: string, text: string, mime: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: mime }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.style.display = 'none';
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名时间戳：YYYYMMDD-HHMMSS。 */
function pathStamp(): string {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

dom.pathToggleBtn?.addEventListener('click', () => {
	if (!rendererMain) return;
	if (rendererMain.isPathRecording()) {
		rendererMain.stopPathRecording();
		if (dom.pathToggleBtn) dom.pathToggleBtn.textContent = '开始记录';
	} else {
		rendererMain.startPathRecording();
		if (dom.pathToggleBtn) dom.pathToggleBtn.textContent = '停止记录';
	}
	updatePathCountsUI();
});

dom.pathClearBtn?.addEventListener('click', () => {
	rendererMain?.clearPath();
	updatePathCountsUI();
});

dom.pathVisibleChk?.addEventListener('change', () => {
	rendererMain?.setPathVisible(dom.pathVisibleChk?.checked ?? true);
});

dom.pathRenderVisibleChk?.addEventListener('change', () => {
	rendererMain?.setPathRenderVisible(dom.pathRenderVisibleChk?.checked ?? true);
});

dom.pathTickVisibleChk?.addEventListener('change', () => {
	rendererMain?.setPathTickVisible(dom.pathTickVisibleChk?.checked ?? true);
});

dom.pathDeviVisibleChk?.addEventListener('change', () => {
	rendererMain?.setPathDeviVisible(dom.pathDeviVisibleChk?.checked ?? false);
});

dom.pathDotsVisibleChk?.addEventListener('change', () => {
	rendererMain?.setPathDotsVisible(dom.pathDotsVisibleChk?.checked ?? true);
});

// ---------------------------------------------------------------------------
// 输入录制 / 确定性回放（面板 + 永久调试 API）
//
// 用法：用户录一段键鼠输入并导出 JSON，开发者在无头浏览器里逐帧回放同一段输入复现问题。
// 回放优先：回放期输入循环用回放样本覆盖设备输入，mousemove 处理器也直接返回。
// 落样本：本文件里 InputRecorder.record 的调用点只有回放分支的 replayCapture；
// 用户录制器 inputRecorder 在 apps/debug/src 内没有 record 调用点（导出即空载荷）。
// ---------------------------------------------------------------------------

/** 刷新状态行与按钮文案（录制/回放启停时立即调；进行中由输入循环按 100ms 节流调）。 */
function updateInputRecUi(): void {
	const c = inputRecorder.counts();
	const p = inputPlayer.state();
	let text: string;
	if (inputReplaying) {
		const played = Math.max(0, p.index + 1);
		text =
			`<span style="color:#ffd926">● 回放中</span> ${played}/${p.total} 帧` +
			(p.skipped > 0 ? `　<span style="color:#ff9f26">丢帧 ${p.skipped}</span>` : '') +
			`　起点 ${inputPlayer.isSampleClock() ? '确定性逐帧' : '实时墙钟'}`;
	} else if (inputRecorder.isRecording()) {
		const secs = c.frames > 1 ? ((c.t1 - c.t0) / 1000).toFixed(1) : '0.0';
		text = `<span style="color:#ff4444">● 录制中</span> ${c.frames} 帧（${secs}s）`;
	} else if (c.frames > 0) {
		const secs = c.frames > 1 ? ((c.t1 - c.t0) / 1000).toFixed(1) : '0.0';
		text = `已停止 · ${c.frames} 帧（${secs}s）待导出`;
	} else {
		text = '未开始';
	}
	if (dom.inputRecStatusEl) dom.inputRecStatusEl.innerHTML = text;
	if (dom.inputRecToggleBtn) {
		dom.inputRecToggleBtn.textContent = inputRecorder.isRecording() ? '停止录制' : '开始录制';
	}
	if (dom.inputRecStopPlayBtn) dom.inputRecStopPlayBtn.disabled = !inputReplaying;
}

/** 录制导出的 meta：地图名、出生点、起点状态、物理参数与碰撞箱、灵敏度等复现前提。 */
function buildReplayMeta(extra?: Partial<InputReplayMeta>): Partial<InputReplayMeta> {
	const cap = rendererMain?.captureReplayState() ?? null;
	const st = cap?.state ?? null;
	const spawnIdx = dom.spawnSelect ? Number(dom.spawnSelect.value) : -1;
	// 世界出生点（与 spawnIndex 对应；索引越界或列表未加载则为 null）。它不是录制起点——
	// 录制起点记在 initialState.pos。
	const sp = spawnIdx >= 0 ? loadedSpawnList[spawnIdx] : undefined;
	return {
		mapFile: teleportMapName,
		spawnIndex: Number.isFinite(spawnIdx) ? spawnIdx : -1,
		spawnPos: sp ? { x: sp[0], y: sp[1], z: sp[2] } : null,
		tickRate: config.physics.tickRate,
		physics: cap?.physics ?? {},
		hull: cap?.hull ?? null,
		initialState: st,
		physSeed: cap?.seed ?? null,
		spawnList: loadedSpawnList,
		sensitivity: config.input.sensitivity,
		devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
		startedAt: new Date().toISOString(),
		href: location.href,
		...extra,
	};
}

/** 开始录制（以当前状态作回放起点快照；正在回放则先收尾）。 */
function startRecording(): void {
	if (inputReplaying) endPlayback();
	inputRecorder.startWithState(buildReplayMeta());
	updateInputRecUi();
}

/** 停止录制（已录样本保留）。 */
function stopRecording(): void {
	inputRecorder.stop();
	updateInputRecUi();
}

/** 合成输入入队（见 syntheticQueue 说明）。 */
function enqueueSynthetic(dx: number, dy: number, keys: number): void {
	syntheticQueue.push({ dx, dy, keys });
}

/**
 * 对齐回放起点：把 meta 里的物理参数、碰撞箱与起点状态写回渲染物理（参数另经 inputBridge 下发 Worker）。
 *
 * 缺 initialState 时返回 false，调用方据此拒绝回放。
 */
function armReplay(meta: Partial<InputReplayMeta>): boolean {
	if (!rendererMain) return false;
	const init = meta.initialState;
	if (!init) return false;
	// 1) 物理参数 + 碰撞箱：渲染物理走 setter，Worker 走 inputBridge 消息
	if (meta.physics && Object.keys(meta.physics).length > 0) {
		rendererMain.setPredictionParams(meta.physics);
		inputBridge?.sendConfig('physics', meta.physics);
	}
	if (meta.hull) {
		rendererMain.setPredictionHull(meta.hull.halfWidth, meta.hull.standHeight, meta.hull.duckHeight);
		inputBridge?.sendSetHull(meta.hull);
	}
	// 2) 起点状态：优先用全量种子（apps/debug/src/renderer/renderer-main.ts 的 captureFullPhysState /
	//    restoreFullPhysState，位级一致）；无种子时退化为 9 参部分对齐（initialState）
	rendererMain.resetTo([init.pos.x, init.pos.y, init.pos.z], init.yaw, init.pitch);
	const seedRestored = typeof meta.physSeed === 'string' && meta.physSeed.length > 0
		? rendererMain.restoreFullPhysState(meta.physSeed)
		: false;
	if (!seedRestored) {
		rendererMain.setPredictionState(
			init.pos.x, init.pos.y, init.pos.z,
			init.yaw, init.pitch,
			init.vel.x, init.vel.y, init.vel.z,
			init.onGround,
		);
	}
	// 相机与渲染状态立即跟上，避免首帧位置读数带上残留
	rendererMain.syncCameraToCurrentState();
	lastSeedRestored = seedRestored;
	// 3) 回放模式：物理 dt 改用录制步长并关闭权威实时耦合（apps/debug/src/renderer/renderer-main.ts 的 setReplayMode）
	rendererMain.setReplayMode(true);
	rendererMain.clearPendingInput();
	return true;
}

/**
 * 上一次 armReplay 是否用全量种子写回起点（false = 退化为 9 参部分对齐，起点状态不保证一致）。
 * 仅诊断用，由 __wsInput.counts() 报出。
 */
let lastSeedRestored = false;

/** 结束回放：交还设备输入并退出回放模式（可重复调用）。 */
function endPlayback(): void {
	inputReplaying = false;
	replayCaptureArmed = false;
	inputPlayer.stop();
	rendererMain?.setReplayMode(false);
	rendererMain?.clearPendingInput();
	updateInputRecUi();
}

/**
 * 开始回放（面板「载入并回放」与 __wsInput.play 都走这里）。
 *
 * deterministic = true（默认）= 逐帧回放：帧号与录制帧号一一对应，推进一拍用两拍 rAF 结算；
 * false = 按墙钟实时回放（帧率不足会丢样本，丢帧数由 inputPlayer.counts().skipped 报出）。
 *
 * @returns 是否真的开始（未载入数据或缺 initialState 时为 false）
 */
function startPlayback(deterministic = true): boolean {
	if (!inputPlayer.counts().total) return false;
	if (inputReplaying) endPlayback();
	const init = playbackMeta.initialState;
	if (!init) {
		console.warn('[input-recorder] 该录制缺少 meta.initialState（起点状态）→ 无法对齐起点，拒绝回放。');
		updateInputRecUi();
		return false;
	}
	// 地图名不符只告警不阻断：换图后仍可回放，结果由调用方自行判断
	if (playbackMeta.mapFile && teleportMapName && playbackMeta.mapFile !== teleportMapName) {
		console.warn(
			`[input-recorder] 录制地图 ${playbackMeta.mapFile} ≠ 当前地图 ${teleportMapName}——回放结果不可信。`,
		);
	}
	// 回放期不请求 Pointer Lock：键鼠输入已被回放覆盖，锁定反而会被鼠标拖动窗口
	if (pointerLock.isLocked()) document.exitPointerLock();
	keyboard.reset();
	if (!armReplay(playbackMeta)) return false;
	if (deterministic) inputPlayer.playDeterministic();
	else inputPlayer.playRealtime();
	// 面板/API 发起的回放：推进权归输入循环；改用 __wsInput.tickReplay 时，
	// replayAdvanceAndWait 会把该标志置回 true 收回推进权。
	externalReplayClock = false;
	inputReplaying = true;
	replayCaptureArmed = true;
	replayCapture.clear();
	replayTickWait = 0;
	lastFedReplayIndex = -2;
	updateInputRecUi();
	return true;
}

/** 面板「开始录制 / 停止录制」按钮。 */
dom.inputRecToggleBtn?.addEventListener('click', () => {
	if (inputRecorder.isRecording()) stopRecording();
	else startRecording();
});

/** 面板「清空」按钮。 */
dom.inputRecClearBtn?.addEventListener('click', () => {
	inputRecorder.clear();
	updateInputRecUi();
});

/** 面板「导出 JSON」按钮（与路径记录导出共用 downloadText）。 */
dom.inputRecExportBtn?.addEventListener('click', () => {
	downloadText(
		`input-replay-${pathStamp()}.json`,
		inputRecorder.toJson({ stoppedAt: new Date().toISOString() }),
		'application/json',
	);
});

/** 面板「载入并回放」按钮：先打开文件选择框。 */
dom.inputRecLoadBtn?.addEventListener('click', () => {
	dom.inputRecFile?.click();
});

dom.inputRecFile?.addEventListener('change', async () => {
	const file = dom.inputRecFile?.files?.[0];
	if (!file) return;
	try {
		const text = await file.text();
		loadPlaybackFromJson(text, { mapFile: file.name.replace(/\.json$/i, '') });
		if (!startPlayback(true)) setStatus('输入回放：载入成功但无法开始（缺起点状态？）', 'error');
		else setStatus(`输入回放：已载入 ${file.name}，开始逐帧回放。`, 'success');
	} catch (err) {
		setError(`输入回放载入失败: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		// 复位 file input，便于重复选择同一个文件
		if (dom.inputRecFile) dom.inputRecFile.value = '';
	}
});

/** 面板「停止回放」按钮。 */
dom.inputRecStopPlayBtn?.addEventListener('click', () => {
	endPlayback();
});

/**
 * 载入录制 JSON 到回放器（不自动开始；开始时机由面板或 __wsInput.play 决定）。
 * @param override 覆盖 meta 字段（面板传文件名，无头可传 mapFile 校正）
 * @returns 载入后的总帧数
 */
function loadPlaybackFromJson(text: string, override?: Partial<InputReplayMeta>): number {
	// 接受 JSON 文本（__wsInput.load 的契约）或已解析对象；其余非对象输入一律拒绝。
	const parsed = (typeof text === 'string' ? JSON.parse(text) : text) as {
		meta?: Partial<InputReplayMeta>;
		schema?: unknown;
	} | null;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是合法 JSON 对象');
	if (parsed.schema !== INPUT_REPLAY_SCHEMA) {
		throw new Error(`schema 不符：期望 ${INPUT_REPLAY_SCHEMA}，实际 ${String(parsed.schema)}`);
	}
	inputPlayer.load(parsed);
	playbackMeta = { ...(parsed.meta ?? {}), ...(override ?? {}) };
	updateInputRecUi();
	return inputPlayer.counts().total;
}

// ---------------------------------------------------------------------------
// 永久调试 API：globalThis.__wsInput
//
// **这是产品功能，不是临时插桩**（用户明确要求：不要求用户做测试，开发者自己在
// 无头浏览器里复现）——确定性复现所需的全部动作（录制/导出/载入/逐帧回放/取状态）
// 都必须能被 CDP 脚本无点击驱动，故该 API 永久保留在本应用（仅 debug 应用注册；
// game 应用不注册）。
//
// 契约（签名固定，改动须同步 debug/scripts/input-replay-verify.mjs 与面板 title）：
//   start(): void                       开始录制（锚定当前状态为回放起点）
//   stop(): void                        停止录制
//   clear(): void                       清空已录帧
//   isRecording(): boolean
//   isPlaying(): boolean
//   exportJson(): string                录制载荷 JSON 文本（面板「导出 JSON」同源）
//   load(text, meta?): number           载入录制 JSON → 返回帧数（>0 成功）
//   play(deterministic?): boolean       开始回放（默认逐帧确定性）
//   stopPlay(): void
//   tickReplay(): Promise<…>            **确定性推进一帧**（等渲染主循环消费后再结算）
//   counts(): {…}                       录制/回放/捕获计数（含丢帧数）
//   captureText(): string               回放期**实际喂出去**的帧（自检用）
//   setPlaybackMeta(patch): void        覆盖回放 meta（无头跳过地图名核对等）
//   pushSynthetic({dx,dy,keys}): void   注入合成输入（走真实输入路径；无头录制用）
//   clearSynthetic(): number
//   status(): string                    状态行文本
// ---------------------------------------------------------------------------

/**
 * 逐帧确定性回放：推进一帧 → 等渲染主循环**消费完**该帧再结算。
 *
 * 为什么要"等两拍 rAF"：渲染主循环（RendererMain.tick）与输入循环（本文件
 * startInputLoop）注册顺序固定为「渲染先、输入后」。本函数在输入循环之外调用，
 * 于是：拍 N 推进样本 → 拍 N+1 渲染 tick 用 `replayDtS` 推物理、输入循环喂入该样本
 * → 拍 N+2 结算时 `getCurrentState()` 已是 post-tick 状态。
 *
 * 返回 `{ frame, dtS, index, total, done, state }`；`reason` 出现在异常路径
 * （`not-playing` / `busy`（上一帧还没消费完）/ `exhausted`）。
 */
function replayAdvanceAndWait(): Promise<Record<string, unknown>> {
	externalReplayClock = true; // 无头协议接管推进权（输入循环不再自行 step）
	if (!inputReplaying) return Promise.resolve({ frame: null, done: true, reason: 'not-playing' });
	if (replayTickWait > 0) return Promise.resolve({ frame: null, done: false, reason: 'busy' });
	const r = inputPlayer.stepReplay(1 / 64);
	if (!r.frame) return Promise.resolve({ frame: null, done: true, reason: 'exhausted' });
	// **必须**把录制步长交给渲染主循环：不设的话物理回落到墙钟 dt，两条独立回放
	// 因此分叉（实测首个分叉帧 67、最大差 3968 HU）。
	if (rendererMain) rendererMain.replayDtS = r.dtS;
	const frame = { t: r.frame.t, dx: r.frame.dx, dy: r.frame.dy, keys: r.frame.keys };
	replayTickWait = 1;
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const st = rendererMain?.getCurrentState() ?? null;
				resolve({
					frame,
					dtS: r.dtS,
					index: r.index,
					total: r.total,
					done: r.done,
					state: st
						? { pos: st.pos, yaw: st.yaw, pitch: st.pitch, vel: st.vel, onGround: st.onGround }
						: null,
				});
			});
		});
	});
}

(globalThis as unknown as { __wsInput?: Record<string, unknown> }).__wsInput = {
	/** 开始录制并锚定当前状态为回放起点。 */
	start: (): void => startRecording(),
	/** 停止录制（样本保留）。 */
	stop: (): void => stopRecording(),
	/** 清空已录帧。 */
	clear: (): void => {
		inputRecorder.clear();
		updateInputRecUi();
	},
	isRecording: (): boolean => inputRecorder.isRecording(),
	isPlaying: (): boolean => inputReplaying,
	/** 录制载荷 JSON（未录到帧时也返回合法空载荷，脚本可据 frames 判定）。 */
	exportJson: (): string => inputRecorder.toJson({ stoppedAt: new Date().toISOString() }),
	/** 载入录制 JSON（字符串）→ 返回帧数。 */
	load: (text: string, meta?: Partial<InputReplayMeta>): number => loadPlaybackFromJson(text, meta),
	/** 开始回放；deterministic=false 走墙钟实时（默认逐帧确定性）。 */
	play: (deterministic = true): boolean => startPlayback(deterministic),
	/** 停止回放。 */
	stopPlay: (): void => endPlayback(),
	/** 确定性推进一帧（无头验证用；见 replayAdvanceAndWait）。 */
	tickReplay: replayAdvanceAndWait,
	counts: (): Record<string, unknown> => ({
		recording: inputRecorder.isRecording(),
		frames: inputRecorder.counts().frames,
		playing: inputReplaying,
		playerIndex: inputPlayer.state().index,
		playerTotal: inputPlayer.state().total,
		skipped: inputPlayer.state().skipped,
		captureFrames: replayCapture.counts().frames,
		replayLoopFrames,
		seedRestored: lastSeedRestored,
		replayMode: rendererMain?.isReplayMode() ?? false,
		syntheticPending: syntheticQueue.length,
	}),
	/** 回放期实际喂出的帧（逐帧自检口径；空 = 尚未回放过）。 */
	captureText: (): string => replayCapture.toJson({ capturedAt: new Date().toISOString() }),
	/** 覆盖回放 meta（无头补 mapFile / 跳过地图名核对用）。 */
	setPlaybackMeta: (patch: Partial<InputReplayMeta>): void => {
		playbackMeta = { ...playbackMeta, ...patch };
	},
	/** 注入一帧合成输入（走真实输入路径：Q/E 合并 + 录制点）。 */
	pushSynthetic: (v: { dx?: number; dy?: number; keys?: number }): void =>
		enqueueSynthetic(v.dx ?? 0, v.dy ?? 0, v.keys ?? 0),
	/**
	 * 注入一次**设备级**输入——等价于一次 `mousemove` 事件：**直连 `feedInput`，
	 * 不经过输入循环**（无头驱动鼠标路径用）。
	 *
	 * 存在意义：录制点已从输入循环移到物理步（见 `rendererMain.onPhysicsStep`），
	 * 本 API 正是用来证明"循环外到达的输入也会被录进去"——旧实现里这条路径的
	 * `dy` 永远录不到（恒为 0）。
	 */
	feedDeviceInput: (v: { dx?: number; dy?: number; keys?: number }): void => {
		rendererMain?.feedInput(v.dx ?? 0, v.dy ?? 0, v.keys ?? 0);
	},
	/** 清空未消费的合成输入 → 返回清掉的条数。 */
	clearSynthetic: (): number => {
		const n = syntheticQueue.length;
		syntheticQueue.length = 0;
		return n;
	},
	/** 状态行文本（与面板同一口径）。 */
	status: (): string => dom.inputRecStatusEl?.textContent ?? '',
	/** 录制起点快照（诊断：确认 meta 会记下什么）。 */
	replayState: (): unknown => rendererMain?.captureReplayState() ?? null,
	/** 渲染物理当前全量种子 JSON（诊断：直接搬运/播种用的位级状态）。 */
	physSeed: (): string | null => rendererMain?.captureFullPhysState() ?? null,
	/** 用全量种子 JSON 写回渲染物理（诊断/确定性验证用；返回是否成功）。 */
	seedPhys: (json: string): boolean => rendererMain?.restoreFullPhysState(json) ?? false,
	/**
	 * 单步闸门（诊断/确定性验证用）：n>0 → 渲染主循环最多再推进 n 个物理步；
	 * n=0 → 恢复逐帧连续推进。见 renderer-main.setManualSteps。
	 */
	setManualSteps: (n: number): void => rendererMain?.setManualSteps(n),
	/**
	 * 直接开关渲染器的"回放模式"（关权威实时耦合 + dt 覆盖；见 renderer-main）。
	 * 只给无头验证的对照实验用（模块内部由 play()/stopPlay() 自动管理）：
	 * 对照 A = 录制时也关掉权威耦合 → 轨迹应当逐位复现；
	 * 对照 B（默认，用户真实情形）= 录制时权威耦合是开的 → 轨迹带权威线抖动。
	 */
	setReplayMode: (on: boolean): void => rendererMain?.setReplayMode(on),
	/**
	 * 重建物理世界（重新解析并加载已缓存的 BSP）——**只给无头验证的干净复位用**。
	 * 用途：排除"物理世界内部残留状态"对两次回放的影响（诊断非确定性用）。
	 */
	reloadForTest: (): Promise<unknown> => {
		const file = lastBspFile;
		if (!file) return Promise.resolve({ ok: false, reason: 'no-bsp-loaded' });
		return handleBspFile(file).then(() => ({ ok: true }));
	},
};

dom.pathExportJsonBtn?.addEventListener('click', () => {
	if (!rendererMain) return;
	const meta = { source: 'websurf-debug', href: location.href, recordedAt: new Date().toISOString() };
	downloadText(`phys-path-${pathStamp()}.json`, rendererMain.exportPathJson(meta), 'application/json');
});

dom.pathExportCsvBtn?.addEventListener('click', () => {
	if (!rendererMain) return;
	downloadText(`phys-path-${pathStamp()}.csv`, rendererMain.exportPathCsv(), 'text/csv');
});


/** 计时挑战 HUD（主线程本地快照 + justDied 闪烁）。 */
function updateGameStatsUI(): void {
	if (!dom.gameStatsEl) return;
	const snap = game.getSnapshot();
	let phaseLabel: string;
	let timeLabel: string;
	switch (snap.phase) {
		case 'idle':
			phaseLabel = '待开始';
			timeLabel = formatTime(snap.elapsedMs);
			break;
		case 'running':
			phaseLabel = '挑战中';
			timeLabel = formatTime(snap.elapsedMs);
			break;
		case 'finished':
			phaseLabel = '已完成';
			timeLabel = formatTime(snap.finishTimeMs);
			break;
	}
	const cpLabel = snap.checkpointCount > 0
		? `${snap.checkpointCount}(${snap.lastCheckpointName})`
		: '0';
	const text =
		`阶段 ${phaseLabel}  计时 ${timeLabel}  检查点 ${cpLabel}  死亡 ${snap.deaths}`;
	dom.gameStatsEl.textContent = text;
	// justDied 闪烁提示（500ms 后恢复）
	if (game.consumeJustDied()) {
		dom.gameStatsEl.style.color = '#f44';
		dom.gameStatsEl.style.fontWeight = 'bold';
		window.setTimeout(() => {
			if (dom.gameStatsEl) {
				dom.gameStatsEl.style.color = '';
				dom.gameStatsEl.style.fontWeight = '';
			}
		}, 500);
	}
}

// ---------------------------------------------------------------------------
// 输入绑定
// ---------------------------------------------------------------------------

function bindInput(canvas: HTMLCanvasElement): void {
	// 键盘绑定 window（canvas 无 tabindex 无法获焦，绑定 canvas 则 keydown/keyup 永不触发）
	keyboard.bind(window);

	// 鼠标移动：主线程渲染物理输入（灵敏度在此乘入；渲染 tick 同写 SAB 权威端）
	window.addEventListener('mousemove', (e) => {
		if (!pointerLock.isLocked()) return;
		// 回放中：设备输入被回放流覆盖——不喂鼠标，避免实时甩动污染复现
		if (inputReplaying) return;
		const r = mouseBuffer.process(e.movementX, e.movementY);
		if (!r) return;
		const mask = keyboard.getMask();
		// 灵敏度输入层应用：物理两端 sensitivity 固定 1，这里乘入角度增量后统一分发
		// （改灵敏度只改这个系数，双端物理用同一份已缩放输入 → 角度永不因灵敏度分叉）
		const { dx, dy } = layerMouseDelta(r.dx, r.dy, config.input.sensitivity);
		rendererMain?.feedInput(dx, dy, mask);
	});

	// Pointer Lock：点击 3D 区域请求锁定（**监听 document**，不是 canvas）。
	//
	// 2026-09-21 修：旧实现绑在 canvas 上 ⇒ 只要有浮层（缺失纹理弹窗、面板）盖住落点，点击事件就不冒泡到
	// canvas ⇒ **永远拿不到 pointer lock**，用户症状就是"debug 进去后转不动视角"（弹窗盖满画布时尤其明显）。
	// 现在只要点击目标不在 UI 内（面板 / 弹窗 / 按钮）就请求锁定；UI 内点击不抢锁定。
	const UI_HIT_SELECTOR =
		'#panel, #panelClose, .mt-modal, .mt-modal-box, .mt-actions, .mt-ok, button, select, input, label, [data-ui-block-lock]';
	document.addEventListener('click', (e) => {
		if (!sceneReady || pointerLock.isLocked()) return;
		const target = e.target as Element | null;
		if (target && typeof target.closest === 'function' && target.closest(UI_HIT_SELECTOR)) return;
		void pointerLock.requestLock(canvas);
	});

	// Pointer Lock 状态变化
	pointerLock.onLockChange((locked) => {
		mouseBuffer.onLockChange(locked);
		keyboard.reset();
		wheelJumpPending = false;
		// 清主线程渲染物理残留输入（防 ESC 前最后输入/按住键残留）
		rendererMain?.clearPendingInput();
		if (locked) {
			setStatus('Pointer Lock 已锁定。WASD 移动，鼠标视角，ESC 退出。', '');
		} else {
			setStatus('Pointer Lock 已解锁。点击画布重新锁定。', '');
		}
	});

	// 滚轮连跳（chasemod 风格 bhop）：Pointer Lock 锁定时滚轮触发 +jump 脉冲
	window.addEventListener('wheel', () => {
		if (!pointerLock.isLocked()) return;
		wheelJumpPending = true;
	}, { passive: true });

	// 窗口尺寸变化 → 主线程渲染器 resize
	window.addEventListener('resize', () => {
		rendererMain?.resize(canvas.clientWidth, canvas.clientHeight);
	});

	// 失焦：rAF 后台停摆会冻结 SAB 输入槽（I_KEYS 停在失焦前键位，Worker 权威
	// 模拟按旧键位继续移动）——立即显式写 keysMask=0 清权威键位（SAB 路径
	// Atomics.store(I_KEYS,0)；MsgState 回退 post input{keys:0}，共享层 addInput
	// 双通道同接口，与 game blur 修复同款）。退锁路径由下一帧输入循环写 0 兜底，
	// 此处针对的是后台标签页 rAF 暂停场景。
	window.addEventListener('blur', () => {
		keyboard.reset();
		sharedState?.addInput(0, 0, 0);
		rendererMain?.clearPendingInput();
	});
}

// ---------------------------------------------------------------------------
// UI 控件绑定
// ---------------------------------------------------------------------------

/** 面板偏好持久化键（input/hud/debug/lod/player 子集；物理参数由 Settings 另管）。 */
const UI_PREFS_KEY = 'vbsp:uiPrefs';

/**
 * UI 偏好结构版本：默认值变更时递增，加载时旧版本 ≠ 当前 → 丢弃旧持久化
 * （新默认覆盖旧设置），避免旧配置长期残留。
 */
const UI_PREFS_VERSION = 2;

/** 收集面板可调偏好（config 子集，序列化用）。 */
function collectUiPrefs(): Record<string, unknown> {
	return {
		__version: UI_PREFS_VERSION,
		input: { ...config.input },
		hud: { ...config.hud, crosshair: { ...config.hud.crosshair } },
		debug: { ...config.debug },
		lod: { ...config.lod },
		player: { ...config.player },
		texture: { ...config.texture },
	};
}

/** 保存面板偏好到 localStorage。 */
function saveUiPrefs(): void {
	try {
		localStorage.setItem(UI_PREFS_KEY, JSON.stringify(collectUiPrefs()));
	} catch (err) {
		console.warn('[app] UI 偏好保存失败:', err);
	}
}

/** 加载面板偏好 → 合并到 config + 控件同步 + 双端发送。
 * 版本不匹配时：丢弃旧持久化（新默认值生效）并立即以新默认写回。 */
function loadUiPrefs(): void {
	try {
		const raw = localStorage.getItem(UI_PREFS_KEY);
		if (!raw) return;
		const prefs = JSON.parse(raw) as Record<string, unknown>;
		if (prefs.__version !== UI_PREFS_VERSION) {
			console.warn(
				`[app] UI 偏好版本 ${String(prefs.__version)} → ${UI_PREFS_VERSION}，` +
					'丢弃旧设置，采用新默认值。',
			);
			saveUiPrefs();
			return;
		}
		const merge = (section: keyof RuntimeConfig, patch: unknown): void => {
			if (!patch || typeof patch !== 'object') return;
			applyConfigPatch(config, section, patch as Record<string, unknown>);
		};
		merge('input', prefs.input);
		merge('hud', prefs.hud);
		merge('debug', prefs.debug);
		merge('lod', prefs.lod);
		merge('player', prefs.player);
		merge('texture', prefs.texture);
	} catch (err) {
		console.warn('[app] UI 偏好加载失败:', err);
	}
}

/** 应用准星风格到 DOM（CSS 变量 + 可见性 + 描边/中心点）。 */
function applyCrosshairStyle(): void {
	const el = dom.crosshairEl;
	if (!el) return;
	const c = config.hud.crosshair;
	const s = el.style;
	s.setProperty('--ch-color', c.color);
	s.setProperty('--ch-size', `${c.size}px`);
	s.setProperty('--ch-thickness', `${c.thickness}px`);
	s.setProperty('--ch-gap', `${c.gap}px`);
	el.classList.toggle('hidden', !config.hud.showCrosshair);
	el.querySelectorAll('.ch-line').forEach((line) => {
		line.classList.toggle('outline', c.outline);
	});
	const dot = el.querySelector('.ch-dot') as HTMLElement | null;
	if (dot) dot.style.display = c.dot ? 'block' : 'none';
}

/** 同步面板控件值（config → 控件；启动/偏好加载后调用）。 */
function syncPrefsControls(): void {
	const setNum = (id: string, val: number): void => {
		const el = document.getElementById(id) as HTMLInputElement | null;
		if (el) el.value = String(val);
	};
	const setChk = (id: string, val: boolean): void => {
		const el = document.getElementById(id) as HTMLInputElement | null;
		if (el) el.checked = val;
	};
	setNum('mouseSens', config.input.sensitivity);
	setNum('yawBindSpeed', config.input.yawBindSpeed);
	setNum('pitchLimit', config.input.pitchLimit);
	setNum('tickRate', config.physics.tickRate);
	setNum('ambientIntensity', config.lighting.ambientIntensity);
	setNum('cullDistance', config.lod.cullDistance);
	setChk('pvsEnabled', config.lod.pvsEnabled);
	setChk('showSolids', config.debug.showSolids);
	setChk('showTriggers', config.debug.showTriggers);
	setChk('showChamfers', config.debug.showChamfers);
	setChk('showPlaneInfo', config.debug.showPlaneInfo);
	if (dom.hudVisibleChk) dom.hudVisibleChk.checked = config.hud.visible;
	if (dom.showCrosshairChk) dom.showCrosshairChk.checked = config.hud.showCrosshair;
	if (dom.chColor) dom.chColor.value = config.hud.crosshair.color;
	setNum('chSize', config.hud.crosshair.size);
	setNum('chThickness', config.hud.crosshair.thickness);
	setNum('chGap', config.hud.crosshair.gap);
	if (dom.chOutlineChk) dom.chOutlineChk.checked = config.hud.crosshair.outline;
	if (dom.chDotChk) dom.chDotChk.checked = config.hud.crosshair.dot;
	if (dom.hudEl) dom.hudEl.style.display = config.hud.visible ? '' : 'none';
}

/** 面板偏好 → Worker（启动时一次全量下发）。 */
function sendPrefsToWorker(): void {
	if (!inputBridge) return;
	inputBridge.sendConfig('input', { ...config.input });
	inputBridge.sendConfig('hud', { ...config.hud });
	inputBridge.sendConfig('debug', { ...config.debug });
	inputBridge.sendConfig('lod', { ...config.lod });
	inputBridge.sendConfig('player', { ...config.player });
}

/** 全部 UI 控件绑定（文件选择/面板/传送点/准星/显示设置）。 */
function bindUI(): void {
	initPhysicsPanel();
	dom.fileInput?.addEventListener('change', async (e) => {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await handleBspFile(file);
		input.value = '';
	});

	// 物理模式：physics/noclip（立即生效双端）
	dom.physicsModeSelect?.addEventListener('change', (e) => {
		const mode = (e.target as HTMLSelectElement).value as 'noclip' | 'physics';
		applyConfigPatch(config, 'physics', { mode });
		inputBridge?.sendConfig('physics', { mode });
		rendererMain?.setPredictionNoclip(mode === 'noclip');
	});

	// 碰撞来源（加载地图时生效；切换后需重新加载）
	dom.colliderSourceSelect?.addEventListener('change', (e) => {
		const v = (e.target as HTMLSelectElement).value as 'auto' | 'visual' | 'phy';
		applyConfigPatch(config, 'physics', { colliderSource: v });
		inputBridge?.sendConfig('physics', { colliderSource: v });
		setStatus('碰撞来源已切换，重新加载地图后生效。', '');
	});

	// 物理 tick 率（权威固定步长，即时生效；不随 UI 偏好持久化）
	bindSlider(dom.tickRateRange, dom.tickRateNum, (v) => {
		applyConfigPatch(config, 'physics', { tickRate: v });
		inputBridge?.sendConfig('physics', { tickRate: v });
	}, (v) => v);

	// 鼠标灵敏度（cs-movement 乘数：有效灵敏度 = sensitivity * m_yaw 0.022 deg/px）
	dom.mouseSensRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.mouseSensNum && Number.isFinite(val)) dom.mouseSensNum.value = String(val);
		config.input.sensitivity = val;
		inputBridge?.sendConfig('input', { sensitivity: val });
		saveUiPrefs();
	});
	dom.mouseSensNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		if (dom.mouseSensRange) dom.mouseSensRange.value = String(Math.min(5, Math.max(0.1, val)));
		config.input.sensitivity = val;
		inputBridge?.sendConfig('input', { sensitivity: val });
		saveUiPrefs();
	});

	// Q/E 键 yaw 旋转速度（度/秒）
	dom.yawBindSpeedRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.yawBindSpeedNum && Number.isFinite(val)) dom.yawBindSpeedNum.value = String(val);
		applyConfigPatch(config, 'input', { yawBindSpeed: val });
		inputBridge?.sendConfig('input', { yawBindSpeed: val });
		saveUiPrefs();
	});
	dom.yawBindSpeedNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		if (dom.yawBindSpeedRange) dom.yawBindSpeedRange.value = String(Math.min(720, Math.max(0, val)));
		applyConfigPatch(config, 'input', { yawBindSpeed: val });
		inputBridge?.sendConfig('input', { yawBindSpeed: val });
		saveUiPrefs();
	});

	// 俯仰角限制（相机 pitch clamp，度；渲染端即时生效 + Worker 协议同步）
	bindSlider(dom.pitchLimitRange, dom.pitchLimitNum, (v) => {
		applyConfigPatch(config, 'input', { pitchLimit: v });
		rendererMain?.applyConfigPatch('input', { pitchLimit: v });
		inputBridge?.sendConfig('input', { pitchLimit: v });
		saveUiPrefs();
	}, (v) => v);

	// 视距剔除距离（渲染器实时生效 + Worker 协议兼容保留）
	dom.cullDistRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.cullDistNum && Number.isFinite(val)) dom.cullDistNum.value = String(val);
		applyConfigPatch(config, 'lod', { cullDistance: val });
		rendererMain?.setCullDistance(val);
		inputBridge?.sendSetCullDistance(val);
		saveUiPrefs();
	});
	dom.cullDistNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		const max = parseFloat(dom.cullDistRange?.max ?? '100000');
		if (dom.cullDistRange) dom.cullDistRange.value = String(Math.min(max, Math.max(1000, val)));
		applyConfigPatch(config, 'lod', { cullDistance: val });
		rendererMain?.setCullDistance(val);
		inputBridge?.sendSetCullDistance(val);
		saveUiPrefs();
	});

	// PVS 剔除开关
	dom.pvsEnabledChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'lod', { pvsEnabled: enabled });
		inputBridge?.sendConfig('lod', { pvsEnabled: enabled });
		saveUiPrefs();
	});

	// 重生：检查点回退优先（无检查点 = 纯 Rust 重生到初始出生点）
	dom.respawnBtn?.addEventListener('click', () => {
		const cp = game.getRespawnPos();
		if (cp) {
			const pos: [number, number, number] = [cp.pos.x, cp.pos.y, cp.pos.z];
			const yawDeg = (cp.yaw * 180) / Math.PI;
			rendererMain?.teleportToPos(pos, yawDeg);
			inputBridge?.sendTeleportToPos(pos, yawDeg);
			rendererMain?.resetTo(pos, yawDeg);
			setStatus('已退回到最后检查点。', 'success');
			return;
		}
		rendererMain?.respawn();
		inputBridge?.sendRespawn();
		// 纯 Rust 重生后双端归零（防权威帧把重生位置拉回）
		const st = rendererMain?.getCurrentState();
		if (st) rendererMain?.resetTo([st.pos.x, st.pos.y, st.pos.z], st.yaw, st.pitch);
	});

	// Spawn 选择（input + change 双监听：重选当前值/部分浏览器只触发 input 时
	// 也能响应；去重防重复传送——同步自主项目修复）。
	// 注意：必须双端同步（主线程预测物理 + Worker 权威物理）+ resetTo——
	// 只传主线程时权威帧 >200 兜底会把传送点拉回（"传送初始点出现问题"根因）。
	const onSpawnPick = (idx: number): void => {
		if (idx === lastTeleportIdx || Number.isNaN(idx)) return;
		lastTeleportIdx = idx;
		inputBridge?.sendTeleport(idx);
		rendererMain?.teleportToSpawn(idx);
		const st = rendererMain?.getCurrentState();
		if (st) rendererMain?.resetTo([st.pos.x, st.pos.y, st.pos.z], st.yaw, st.pitch);
	};
	dom.spawnSelect?.addEventListener('change', (e) => {
		onSpawnPick(parseInt((e.target as HTMLSelectElement).value, 10));
	});
	dom.spawnSelect?.addEventListener('input', (e) => {
		onSpawnPick(parseInt((e.target as HTMLSelectElement).value, 10));
	});

	// 捕获当前位置为自定义传送点（主线程本地 state()）
	dom.capturePosBtn?.addEventListener('click', () => {
		if (!sceneReady) {
			setStatus('场景尚未就绪，请先加载地图。', 'error');
			return;
		}
		if (!teleportMapName) {
			setStatus('未识别当前地图名称，无法保存传送点。', 'error');
			return;
		}
		const st = rendererMain?.getCurrentState();
		if (!st) {
			setStatus('物理未就绪，无法获取位置。', 'error');
			return;
		}
		const list = addCustomTeleport(teleportMapName, {
			name: `位置 ${st.pos.x.toFixed(0)},${st.pos.y.toFixed(0)},${st.pos.z.toFixed(0)}`,
			pos: [st.pos.x, st.pos.y, st.pos.z],
			yaw: st.yaw,
		});
		renderCustomTeleports(list);
		setStatus(
			`已保存当前位置 (${st.pos.x.toFixed(0)},${st.pos.y.toFixed(0)},${st.pos.z.toFixed(0)}) 为传送点。`,
			'success',
		);
	});

	// 手动添加传送点表单
	dom.addTeleportBtn?.addEventListener('click', () => {
		if (!sceneReady || !inputBridge) {
			setStatus('场景尚未就绪，请先加载地图。', 'error');
			return;
		}
		if (!teleportMapName) {
			setStatus('未识别当前地图名称，无法添加传送点。', 'error');
			return;
		}
		const form = dom.addTeleportForm;
		if (!form) return;
		const showing = form.style.display !== 'none';
		form.style.display = showing ? 'none' : 'flex';
		if (!showing) dom.tpX?.focus();
	});
	dom.addTeleportForm?.addEventListener('submit', (e) => {
		e.preventDefault();
		if (!teleportMapName) return;
		if (!sceneReady) {
			setStatus('场景尚未就绪，请先加载地图。', 'error');
			return;
		}
		const x = dom.tpX ? Number(dom.tpX.value) : NaN;
		const y = dom.tpY ? Number(dom.tpY.value) : NaN;
		const z = dom.tpZ ? Number(dom.tpZ.value) : NaN;
		if (![x, y, z].every((n) => Number.isFinite(n))) {
			setStatus('X / Y / Z 三个框都必须填有效数字。', 'error');
			return;
		}
		const rawYaw = dom.tpYaw?.value?.trim() ?? '';
		let yaw: number | null = null;
		if (rawYaw !== '') {
			const yv = Number(rawYaw);
			if (!Number.isFinite(yv)) {
				setStatus('yaw 必须是数字。', 'error');
				return;
			}
			yaw = ((yv % 360) + 360) % 360;
		}
		const name = (dom.tpName?.value ?? '').trim() || fmtPos([x, y, z]);
		const list = addCustomTeleport(teleportMapName, { name, pos: [x, y, z], yaw });
		renderCustomTeleports(list);
		if (dom.tpX) dom.tpX.value = '';
		if (dom.tpY) dom.tpY.value = '';
		if (dom.tpZ) dom.tpZ.value = '';
		if (dom.tpName) dom.tpName.value = '';
		if (dom.tpYaw) dom.tpYaw.value = '';
		if (dom.addTeleportForm) dom.addTeleportForm.style.display = 'none';
		setStatus(`已添加传送点 (${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)})。`, 'success');
	});
	dom.tpCancel?.addEventListener('click', () => {
		if (dom.tpX) dom.tpX.value = '';
		if (dom.tpY) dom.tpY.value = '';
		if (dom.tpZ) dom.tpZ.value = '';
		if (dom.tpName) dom.tpName.value = '';
		if (dom.tpYaw) dom.tpYaw.value = '';
		if (dom.addTeleportForm) dom.addTeleportForm.style.display = 'none';
	});

	// 自定义传送点列表操作（go = 双端传送 + resetTo；delete = 移除）
	dom.customTeleportList?.addEventListener('click', (e) => {
		const target = (e.target as HTMLElement).closest('button');
		if (!target) return;
		const id = target.dataset.tpId;
		if (!id || !teleportMapName) return;
		const action = target.dataset.action;
		if (action === 'go') {
			const list = loadCustomTeleports(teleportMapName);
			const tp = list.find((t) => t.id === id);
			if (tp) {
				inputBridge?.sendTeleportToPos(tp.pos, tp.yaw ?? undefined);
				rendererMain?.teleportToPos(tp.pos, tp.yaw ?? undefined);
				const st = rendererMain?.getCurrentState();
				if (st) rendererMain?.resetTo([st.pos.x, st.pos.y, st.pos.z], st.yaw, st.pitch);
				setStatus(`传送到「${tp.name}」(${fmtPos(tp.pos)})。`, 'success');
			}
		} else if (action === 'delete') {
			const list = removeCustomTeleport(teleportMapName, id);
			renderCustomTeleports(list);
		}
	});

	// HUD 可见性
	dom.hudVisibleChk?.addEventListener('change', (e) => {
		const visible = (e.target as HTMLInputElement).checked;
		if (dom.hudEl) dom.hudEl.style.display = visible ? '' : 'none';
		applyConfigPatch(config, 'hud', { visible });
		inputBridge?.sendConfig('hud', { visible });
		saveUiPrefs();
	});

	// 准星可见性
	dom.showCrosshairChk?.addEventListener('change', (e) => {
		const visible = (e.target as HTMLInputElement).checked;
		if (dom.crosshairEl) {
			dom.crosshairEl.classList.toggle('hidden', !visible);
		}
		applyConfigPatch(config, 'hud', { showCrosshair: visible });
		inputBridge?.sendConfig('hud', { showCrosshair: visible });
		saveUiPrefs();
	});

	// 准星风格化（颜色/尺寸/粗细/间隙/描边/中心点）
	const bindCh = (
		range: HTMLInputElement | null,
		num: HTMLInputElement | null,
		apply: (v: number) => void,
	): void => {
		const onRange = (): void => {
			if (!range) return;
			const v = parseFloat(range.value);
			if (num) num.value = String(v);
			apply(v);
		};
		const onNum = (): void => {
			if (!num) return;
			const v = parseFloat(num.value);
			if (Number.isNaN(v)) return;
			if (range) range.value = String(v);
			apply(v);
		};
		range?.addEventListener('input', onRange);
		num?.addEventListener('change', onNum);
	};
	const applyCh = (): void => {
		applyCrosshairStyle();
		saveUiPrefs();
	};
	dom.chColor?.addEventListener('input', () => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, color: dom.chColor!.value } });
		applyCh();
	});
	bindCh(dom.chSizeRange, dom.chSizeNum, (v) => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, size: v } });
		applyCh();
	});
	bindCh(dom.chThicknessRange, dom.chThicknessNum, (v) => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, thickness: v } });
		applyCh();
	});
	bindCh(dom.chGapRange, dom.chGapNum, (v) => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, gap: v } });
		applyCh();
	});
	dom.chOutlineChk?.addEventListener('change', (e) => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, outline: (e.target as HTMLInputElement).checked } });
		applyCh();
	});
	dom.chDotChk?.addEventListener('change', (e) => {
		applyConfigPatch(config, 'hud', { crosshair: { ...config.hud.crosshair, dot: (e.target as HTMLInputElement).checked } });
		applyCh();
	});

	// 纹理画质（mosaic 切换：渲染器实时替换贴图）
	dom.textureQualityRadios.forEach((radio) => {
		radio.addEventListener('change', () => {
			if (!radio.checked) return;
			const quality = radio.value as 'original' | 'mini';
			applyConfigPatch(config, 'texture', { quality });
			rendererMain?.applyConfigPatch('texture', { quality });
			saveUiPrefs();
		});
	});

	// 光照模式（预烘焙 / 纯纹理）：**运行期 uniform 切换**，立即生效、不重建场景、不打断视角与操作。
	// 语义是"移动时的渲染速度"旋钮（见面板小字），不是进图速度开关。
	dom.lightingModeRadios.forEach((radio) => {
		radio.addEventListener('change', () => {
			if (!radio.checked) return;
			const mode = radio.value as 'baked' | 'texture';
			applyConfigPatch(config, 'lighting', { mode });
			rendererMain?.setLightingMode(mode);
			saveUiPrefs();
		});
	});

	// 环境光强度（渲染即时生效；lighting 不随 UI 偏好持久化）
	bindSlider(dom.ambientIntensityRange, dom.ambientIntensityNum, (v) => {
		applyConfigPatch(config, 'lighting', { ambientIntensity: v });
		rendererMain?.applyConfigPatch('lighting', { ambientIntensity: v });
		inputBridge?.sendConfig('lighting', { ambientIntensity: v });
	}, (v) => Math.round(v * 20) / 20);

	// 缺失纹理确认弹窗关闭（两个入口：确认按钮 / 点击背板）。
	//
	// 2026-09-21 修：弹窗是**全屏浮层**（`position: fixed; inset: 0`）⇒ 盖住整个画布，
	// 只有点「知道了，继续」才能回到 3D 视图；用户不知道这一层时症状就是"进 debug 后转不动视角"。
	// 现在点弹窗外的任何位置也关闭（点背板 = 取消），且背板点击不触发锁定（见上面的 UI 命中表），
	// 关掉后再点画面即可锁定。
	dom.missingTexturesOk?.addEventListener('click', () => {
		dom.missingTexturesModal?.classList.add('hidden');
	});
	dom.missingTexturesModal?.addEventListener('click', (e) => {
		if (e.target === dom.missingTexturesModal) dom.missingTexturesModal?.classList.add('hidden');
	});

	// 显示设置：碰撞箱/传送触发器/准星信息
	dom.showSolidsChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showSolids: enabled });
		rendererMain?.applyConfigPatch('debug', { showSolids: enabled });
		inputBridge?.sendConfig('debug', { showSolids: enabled });
		saveUiPrefs();
	});
	bindSlider(dom.brushViewDistanceRange, dom.brushViewDistanceNum, (v) => {
		applyConfigPatch(config, 'debug', { brushViewDistance: v });
		rendererMain?.applyConfigPatch('debug', { brushViewDistance: v });
		inputBridge?.sendConfig('debug', { brushViewDistance: v });
		saveUiPrefs();
	}, (v) => Math.round(v / 64) * 64);
	dom.showTriggersChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showTriggers: enabled });
		rendererMain?.applyConfigPatch('debug', { showTriggers: enabled });
		inputBridge?.sendConfig('debug', { showTriggers: enabled });
		saveUiPrefs();
	});
	bindSlider(dom.triggerViewDistanceRange, dom.triggerViewDistanceNum, (v) => {
		applyConfigPatch(config, 'debug', { triggerViewDistance: v });
		rendererMain?.applyConfigPatch('debug', { triggerViewDistance: v });
		inputBridge?.sendConfig('debug', { triggerViewDistance: v });
		saveUiPrefs();
	}, (v) => Math.round(v / 64) * 64);
	dom.showPlaneInfoChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showPlaneInfo: enabled });
		rendererMain?.applyConfigPatch('debug', { showPlaneInfo: enabled });
		inputBridge?.sendConfig('debug', { showPlaneInfo: enabled });
		saveUiPrefs();
	});

	// 显示设置：模型三角形线框（.phy 橙 / 可视网格紫）独立开关 + 可视距离滑块
	const applyTriDebug = (patch: Record<string, unknown>): void => {
		applyConfigPatch(config, 'debug', patch);
		rendererMain?.applyConfigPatch('debug', patch);
		inputBridge?.sendConfig('debug', patch);
		saveUiPrefs();
	};
	dom.showPhyChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyTriDebug({ showPhy: enabled });
	});
	dom.showVisChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyTriDebug({ showVis: enabled });
	});
	bindSlider(dom.phyViewDistanceRange, dom.phyViewDistanceNum, (v) => {
		applyTriDebug({ phyViewDistance: v });
	}, (v) => Math.round(v / 64) * 64);
	bindSlider(dom.visViewDistanceRange, dom.visViewDistanceNum, (v) => {
		applyTriDebug({ visViewDistance: v });
	}, (v) => Math.round(v / 64) * 64);

	// 显示设置：chamfer 切角平面线框（黄色）独立开关 + 可视距离滑块
	const applyChamferDebug = (patch: Record<string, unknown>): void => {
		applyConfigPatch(config, 'debug', patch);
		rendererMain?.applyConfigPatch('debug', patch);
		inputBridge?.sendConfig('debug', patch);
		saveUiPrefs();
	};
	dom.showChamfersChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyChamferDebug({ showChamfers: enabled });
	});
	bindSlider(dom.chamferViewDistanceRange, dom.chamferViewDistanceNum, (v) => {
		applyChamferDebug({ chamferViewDistance: v });
	}, (v) => Math.round(v / 64) * 64);

	// 近平面自适应参数（滑块 ↔ 输入框双向同步 + 渲染器实时生效）
	bindNearParamControls();
}

/**
 * 滑块 ↔ 数字输入框双向同步绑定（round 统一取整；apply 实时回调）。
 */
function bindSlider(
	range: HTMLInputElement | null,
	num: HTMLInputElement | null,
	apply: (v: number) => void,
	round: (v: number) => number,
): void {
	if (!range && !num) return;
	const onRange = (): void => {
		if (!range) return;
		const val = round(parseFloat(range.value));
		if (num) num.value = String(val);
		apply(val);
	};
	const onNum = (): void => {
		if (!num) return;
		const raw = parseFloat(num.value);
		if (Number.isNaN(raw)) return;
		const val = round(raw);
		if (range) range.value = String(val);
		apply(val);
	};
	range?.addEventListener('input', onRange);
	num?.addEventListener('change', onNum);
}

/** 近平面探测距离/收缩系数控件绑定。 */
function bindNearParamControls(): void {
	bindSlider(dom.nearProbeDistRange, dom.nearProbeDistNum, (v) => {
		rendererMain?.setNearParams(v, undefined);
	}, (v) => v);
	bindSlider(dom.nearRatioRange, dom.nearRatioNum, (v) => {
		rendererMain?.setNearParams(undefined, v);
	}, (v) => Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------------
// 文件处理（阶段 1：主线程解析 BSP + 构建物理 + 渲染，Worker 过渡保留并行物理）
// ---------------------------------------------------------------------------

/**
 * 构造 Rust `set_params` 兼容的全量参数对象（主线程渲染物理实例）。
 *
 * 实现（config → PhysicsParamsLike → snake_case）已抽到
 * `debug/src/physics/prediction-params.ts`：输入回放的起点快照
 * （`RendererMain.captureReplayState`）要用**同一份**实现取参数，否则「录制时记的
 * 参数」与「实际喂给物理的参数」不同源，回放会在起点分叉。
 */
function buildPredictionParams(config: RuntimeConfig): Record<string, unknown> {
	return buildDebugPredictionParams(config);
}

/** 文件入口：读字节 → 主线程解析（BspProcessor → 渲染 + 物理世界）。 */
async function handleBspFile(file: File): Promise<void> {
	lastBspFile = file; // 供 __wsInput.reloadForTest 重建世界（诊断用）
	// 主线程 wasm 就绪（BspProcessor/decompress_mtz 依赖；失败则继续由下方 try 报错）
	await mainWasmReady.catch(() => undefined);
	if (!inputBridge) {
		setError('Worker 未就绪');
		return;
	}
	// 内存重置：先卸载旧地图的全部渲染资源（GPU geometry/material/纹理 +
	// LOD/PVS/碰撞可视化 + 主线程物理实例），防止多次加载地图累积泄漏
	rendererMain?.disposeScene();
	sceneReady = false;
	teleportMapName = file.name;
	// 换地图重置出生点传送去重（新地图选相同索引也应生效）
	lastTeleportIdx = -1;
	if (dom.spawnSelect) dom.spawnSelect.innerHTML = '';
	setStatus(`正在加载 ${file.name}（主线程解析 BSP）...`, '');
	// 让 UI 先更新（解析耗时较长）
	await new Promise((r) => setTimeout(r, 0));
	try {
		await handleLoadBsp(file.name, await file.arrayBuffer());
	} catch (err) {
		setError(`BSP 解析失败: ${err instanceof Error ? err.message : String(err)}`);
		rendererMain?.disposeScene();
	}
}

/**
 * 主线程解析 BSP（参照 game handleLoadBsp 顺序）：
 * BspProcessor → metadata → 借用导出（brush/tri/spawn/teleport/pvs）→ mosaicManifest
 * → 默认纹理包（内嵌 base64 / fetch textures.mtz）→ export_glb* → 渲染场景 →
 * buildPredictionWorld → Worker 过渡（同一字节仍发 Worker 并行物理，渲染不用其输出）。
 * 公共化：导出管线收敛到 ts-shared buildWorldBundle（colliderSource 三档 +
 * 缺失纹理 + 阶段进度回调全部共享）。
 */
async function handleLoadBsp(fileName: string, bytes: ArrayBuffer): Promise<void> {
	if (!rendererMain || !inputBridge) return;
	const bundle = await buildWorldBundle(new BspProcessor(new Uint8Array(bytes)), {
		colliderSource: config.physics.colliderSource ?? 'auto',
		collectMissingTextures: true,
		decompressMtz: decompress_mtz,
		onProgress: (s) => setStatus(s, ''),
	});
	renderMetadata(bundle.metadata, fileName);

	const sceneData: SceneDataMessage = {
		type: 'scene-data',
		glb: bundle.glbBytes,
		brushJson: bundle.brushJson,
		triJson: bundle.triJson,
		mosaicManifest: bundle.mosaicManifest,
		missingTextures: bundle.missingTextures,
		spawnJson: bundle.spawnJson,
		pvsJson: bundle.pvsJson,
		teleportJson: bundle.teleportJson,
		metadata: {
			mapName: bundle.metadata.mapName,
			numFaces: bundle.metadata.numFaces,
			numVertices: bundle.metadata.numVertices,
			numBrushes: bundle.metadata.numBrushes,
			numModels: bundle.metadata.numModels,
		},
		spawn: bundle.spawn,
		// 场景对角线/剔除范围由主线程 GLTFLoader 后计算并校准
		diagonal: 0,
		maxCull: 100000,
		defaultCull: config.lod.cullDistance,
		glbSizeKb: Math.round(bundle.glbBytes.byteLength / 1024),
		numSpawnPoints: bundle.spawnList.length,
		hasPvs: bundle.pvsJson.length > 2,
		deathThresholdY: 0,
	};

	// 渲染场景（GLB + PVS + spawn；主线程直读本地数据，不再经 Worker scene-data）
	const diag = (await rendererMain.loadScene(sceneData)) ?? null;
	// 主线程物理世界（唯一物理渲染线）
	rendererMain.buildPredictionWorld({
		brushJson: bundle.brushJson,
		triJson: bundle.triJson,
		teleportJson: bundle.teleportJson,
		spawn: bundle.spawn,
	});
	// 出生点列表（spawn 下拉切换用）：主线程渲染物理 + Worker 权威物理**双端**
	// 都要设置——否则权威侧 teleport_to_spawn 索引为空静默忽略，权威帧
	// 兜底会把传送点拉回（"一瞬间传送过去又被拉回"根因）
	const spawnList = bundle.spawnList;
	rendererMain.setSpawnPoints(spawnList);
	loadedSpawnList = spawnList; // 输入录制 meta（回放端可还原出生点列表）
	// 初始物理参数/体型/模式同步主线程实例（面板参数经 physics-snapshot 镜像双端）
	rendererMain.setPredictionParams(buildPredictionParams(config));
	rendererMain.setPredictionHull(
		config.player.radius,
		config.player.standHeight,
		config.player.duckHeight,
	);
	rendererMain.setPredictionNoclip(config.physics.mode === 'noclip');

	// 权威 Worker：world-json 构建权威 PhysWorld（阶段 2：不再发 load-bsp，
	// Worker 不解析 BSP）→ 出生点列表 → 双端参数 config
	inputBridge.sendWorldJson({
		brushJson: bundle.brushJson,
		triJson: bundle.triJson,
		teleportJson: bundle.teleportJson,
		spawn: bundle.spawn,
	});
	inputBridge.sendSetSpawnPoints(spawnList);
	syncFullConfig();
	// 死亡阈值重发：loadScene 时的消息早于 world-json 被 Worker 丢弃
	if (sceneDeathY !== null) {
		inputBridge.sendSetDeathThreshold(sceneDeathY);
	}

	// 计时挑战状态机重置（初始出生点；死亡阈值由 onSceneLoaded 双端设置）
	game.reset();
	game.setInitialSpawn(
		{ x: bundle.spawn.x, y: bundle.spawn.y, z: bundle.spawn.z },
		(bundle.spawn.yawDeg * Math.PI) / 180,
	);

	sceneReady = true;
	// 出生点下拉（与 Worker spawn-options 幂等）
	if (dom.spawnSelect) {
		const spawnPoints = (JSON.parse(bundle.spawnJson) as { spawn_points?: Array<{ classname: string; origin: number[] }> })
			.spawn_points ?? [];
		dom.spawnSelect.innerHTML = spawnPoints
			.map(
				(sp, i) =>
					`<option value="${i}">${i}: ${sp.classname} (${sp.origin[0].toFixed(0)},` +
					`${sp.origin[1].toFixed(0)},${sp.origin[2].toFixed(0)})</option>`,
			)
			.join('');
	}
	// UI 激活（控件/面板同步/缺失纹理弹窗）
	await onSceneReadyUi(diag, sceneData);
}

/** 场景元数据面板（文件名 + 统计行；公共化：数据来自 ts-shared WorldMetadata）。 */
function renderMetadata(meta: WorldMetadata, filename: string): void {
	if (!dom.metadataEl) return;
	const rows: [string, string | number][] = [
		['文件名', filename],
		['魔术字', meta.magic ?? ''],
		['模型数', meta.numModels],
		['面数', meta.numFaces],
		['顶点数', meta.numVertices],
		['Brush 数', meta.numBrushes],
		['Leaf 数', meta.numLeaves ?? 0],
		['Node 数', meta.numNodes ?? 0],
		['实体数', meta.numEntities ?? 0],
		['静态道具数', meta.numStaticProps ?? 0],
		['Pakfile 文件数', meta.packedFiles ?? 0],
	];
	dom.metadataEl.innerHTML = rows
		.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
		.join('');
}

// ---------------------------------------------------------------------------
// 自定义传送点面板
// ---------------------------------------------------------------------------

/** 格式化坐标（HU，取整）。 */
function fmtPos(pos: readonly number[]): string {
	return pos.map((n) => n.toFixed(0)).join(', ');
}

/** 渲染自定义传送点列表（缺省从 localStorage 读取当前地图）。 */
function renderCustomTeleports(list?: CustomTeleport[]): void {
	if (!dom.customTeleportList) return;
	const items = list ?? (teleportMapName ? loadCustomTeleports(teleportMapName) : []);
	if (items.length === 0) {
		dom.customTeleportList.innerHTML =
			'尚未添加传送点。保存当前位置或手动输入坐标，一键传送。';
		return;
	}
	dom.customTeleportList.innerHTML =
		`<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">` +
		`<span style="color:#9098b5; font-size:10px;">${items.length} 个传送点</span>` +
		`<button id="clearTeleportsBtn" style="padding:1px 6px; font-size:10px;">清空全部</button>` +
		`</div>` +
		items
			.map(
				(tp) =>
					`<div style="display:flex; align-items:center; gap:4px; padding:3px 0; border-bottom:1px solid #2a2a2a;">` +
					`<button data-tp-id="${tp.id}" data-action="go" title="传送到 ${fmtPos(tp.pos)}" ` +
					`style="padding:1px 6px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:150px;">` +
					`▶ ${escapeHtml(tp.name)}</button>` +
					`<span style="color:#6a6f8a; font-size:10px; white-space:nowrap;">${fmtPos(tp.pos)}</span>` +
					`<button data-tp-id="${tp.id}" data-action="delete" title="删除此传送点" ` +
					`style="padding:1px 6px; font-size:11px; margin-left:auto;">✕</button>` +
					`</div>`,
			)
			.join('');
	// 清空全部
	document.getElementById('clearTeleportsBtn')?.addEventListener('click', () => {
		if (!teleportMapName) return;
		if (!confirm('清空当前地图的全部自定义传送点？')) return;
		clearCustomTeleports(teleportMapName);
		renderCustomTeleports([]);
	});
}

/** 简单 HTML 转义（传送点名称来自用户输入）。 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// 渲染物理事件（Rust take_event → 计时挑战状态机；主线程消费，权威侧不消费）
// ---------------------------------------------------------------------------

/** teleport → 检查点记录 / 终点完成；death → 死亡统计 + 检查点回退。 */
function onRenderPhysEvent(ev: RenderPhysEvent): void {
	if (ev.kind === 'teleport') {
		const yaw = ev.yaw ?? 0;
		game.onTeleport({
			index: -1,
			targetname: String(ev.targetname ?? ''),
			origin: { x: ev.origin?.[0] ?? 0, y: ev.origin?.[1] ?? 0, z: ev.origin?.[2] ?? 0 },
			angles: [0, yaw, 0],
			yaw,
		});
	} else if (ev.kind === 'death') {
		game.onDeath();
		// 死亡回退到最后检查点（双端 teleport-to-pos + resetTo 防权威帧拉回）
		const cp = game.getRespawnPos();
		if (cp && rendererMain) {
			const pos: [number, number, number] = [cp.pos.x, cp.pos.y, cp.pos.z];
			const yawDeg = (cp.yaw * 180) / Math.PI;
			rendererMain.teleportToPos(pos, yawDeg);
			inputBridge?.sendTeleportToPos(pos, yawDeg);
			rendererMain.resetTo(pos, yawDeg);
		}
	}
}

// ---------------------------------------------------------------------------
// 物理控制面板（阶段 4：参数迁主线程，snapshot 镜像双端）
// ---------------------------------------------------------------------------

/** 参数来源标签（默认/手动/地图设置）。 */
const SOURCE_LABEL: Record<ParamSource, { text: string; color: string }> = {
	'mode-default': { text: '默认', color: '#4a4' },
	manual: { text: '手动', color: '#4a90e2' },
	map: { text: '地图设置', color: '#c9a84a' },
};

/** 面板渲染抑制（snapshot 回填时防触发 input 事件回发 Worker，防循环）。 */
let panelSuppress = false;

/** 物理参数行初始化（静态定义渲染一次，值由 physics-snapshot 更新）。 */
function initPhysicsPanel(): void {
	if (!dom.physicsParamList) return;
	dom.physicsParamList.innerHTML = PARAM_DEFS.map((def) => {
		const unit = def.unit ? ` <span style="color:#6a6f8a; font-size:10px;">${def.unit}</span>` : '';
		if (def.kind === 'boolean') {
			return (
				`<div class="ctrl-checkbox-row ctrl-full" data-param-row="${def.name}">` +
				`<input type="checkbox" data-param="${def.name}" ${def.default ? 'checked' : ''} />` +
				`<label data-param-label="${def.name}" title="${def.description}" style="cursor:pointer;">${def.label}</label>` +
				`<span data-param-src="${def.name}" style="font-size:10px;"></span></div>`
			);
		}
		return (
			`<label data-param-label="${def.name}" title="${def.description}">${def.label}</label>` +
			`<input type="range" data-param="${def.name}" min="${def.min ?? 0}" max="${def.max ?? 100}" step="${def.step ?? 1}" />` +
			`<div class="val"><input type="number" data-param-input="${def.name}" class="param-num" ` +
			`min="${def.min ?? 0}" max="${def.max ?? 100}" step="any" value="${def.default}" />${unit}` +
			`<span data-param-src="${def.name}" style="font-size:10px; margin-left:2px;"></span></div>`
		);
	}).join('');

	dom.physicsParamList.addEventListener('input', (e) => {
		if (panelSuppress) return;
		const el = e.target as HTMLInputElement;
		const name = el.dataset.param ?? el.dataset.paramInput;
		if (!name) return;
		const value = el.type === 'checkbox' ? el.checked : Number(el.value);
		// 联动（range ↔ number）
		if (el.dataset.param && el.type === 'range') {
			const numEl = document.querySelector(`[data-param-input="${name}"]`) as HTMLInputElement | null;
			if (numEl) numEl.value = String(value);
		} else if (el.dataset.paramInput) {
			const rangeEl = document.querySelector(`[data-param="${name}"]`) as HTMLInputElement | null;
			if (rangeEl && Number.isFinite(value)) rangeEl.value = String(value);
		}
		// 发 Worker（权威 set_params；快照回传后镜像主线程实例）
		if (Number.isFinite(value)) inputBridge?.sendSetPhysicsParam(name, value);
	});

	// 碰撞箱体型（缩放/逐项）
	const syncHullNum = (): void => {
		if (dom.hullHalfWidthNum) dom.hullHalfWidthNum.value = dom.hullHalfWidth?.value ?? '16';
		if (dom.hullStandHeightNum) dom.hullStandHeightNum.value = dom.hullStandHeight?.value ?? '72';
		if (dom.hullDuckHeightNum) dom.hullDuckHeightNum.value = dom.hullDuckHeight?.value ?? '54';
	};
	dom.hullScale?.addEventListener('input', () => {
		if (panelSuppress) return;
		const s = Number(dom.hullScale!.value);
		if (dom.hullScaleNum && Number.isFinite(s)) dom.hullScaleNum.value = String(Math.round(s * 100) / 100);
		inputBridge?.sendSetHull({
			halfWidth: Math.round(16 * s),
			standHeight: Math.round(72 * s),
			duckHeight: Math.round(54 * s),
		});
	});
	dom.hullScaleNum?.addEventListener('input', () => {
		if (panelSuppress) return;
		const s = Number(dom.hullScaleNum!.value);
		if (!Number.isFinite(s)) return;
		if (dom.hullScale) dom.hullScale.value = String(Math.min(2, Math.max(0.5, s)));
		inputBridge?.sendSetHull({
			halfWidth: Math.round(16 * s),
			standHeight: Math.round(72 * s),
			duckHeight: Math.round(54 * s),
		});
	});
	dom.hullHalfWidth?.addEventListener('input', () => {
		syncHullNum();
		sendHullFromInputs();
	});
	dom.hullStandHeight?.addEventListener('input', () => {
		syncHullNum();
		sendHullFromInputs();
	});
	dom.hullDuckHeight?.addEventListener('input', () => {
		syncHullNum();
		sendHullFromInputs();
	});
	dom.hullHalfWidthNum?.addEventListener('input', () => {
		if (panelSuppress) return;
		const v = Number(dom.hullHalfWidthNum!.value);
		if (Number.isFinite(v) && dom.hullHalfWidth) dom.hullHalfWidth.value = String(v);
		sendHullFromInputs();
	});
	dom.hullStandHeightNum?.addEventListener('input', () => {
		if (panelSuppress) return;
		const v = Number(dom.hullStandHeightNum!.value);
		if (Number.isFinite(v) && dom.hullStandHeight) dom.hullStandHeight.value = String(v);
		sendHullFromInputs();
	});
	dom.hullDuckHeightNum?.addEventListener('input', () => {
		if (panelSuppress) return;
		const v = Number(dom.hullDuckHeightNum!.value);
		if (Number.isFinite(v) && dom.hullDuckHeight) dom.hullDuckHeight.value = String(v);
		sendHullFromInputs();
	});
	dom.resetHullBtn?.addEventListener('click', () => inputBridge?.sendResetHull());
	dom.autoRestoreHullChk?.addEventListener('change', () => {
		inputBridge?.sendSetAutoRestoreHull(dom.autoRestoreHullChk?.checked ?? true);
	});
	dom.resetAllPhysicsBtn?.addEventListener('click', () => {
		if (confirm('恢复全部物理参数与碰撞箱到默认值？')) {
			inputBridge?.sendResetPhysicsParam();
			inputBridge?.sendResetHull();
		}
	});
}

/** 从碰撞箱输入框发送 set-hull（面板手动调整）。 */
function sendHullFromInputs(): void {
	if (panelSuppress) return;
	inputBridge?.sendSetHull({
		halfWidth: Number(dom.hullHalfWidth?.value ?? 16),
		standHeight: Number(dom.hullStandHeight?.value ?? 72),
		duckHeight: Number(dom.hullDuckHeight?.value ?? 54),
	});
	if (dom.hullScaleNum) dom.hullScaleNum.value = '1';
}

/** 物理参数快照回填面板（Worker physics-snapshot 消息）。 */
function renderPhysicsSnapshot(msg: PhysicsSnapshotMessage): void {
	panelSuppress = true;
	try {
		for (const p of msg.params) {
			const label = SOURCE_LABEL[p.source as ParamSource] ?? SOURCE_LABEL['mode-default'];
			const numEl = document.querySelector(`[data-param-input="${p.name}"]`) as HTMLInputElement | null;
			const srcEl = document.querySelector(`[data-param-src="${p.name}"]`) as HTMLElement | null;
			const inputEl = document.querySelector(`[data-param="${p.name}"]`) as HTMLInputElement | null;
			if (numEl) numEl.value = String(p.value);
			if (srcEl) {
				srcEl.textContent = label.text;
				srcEl.style.color = label.color;
			}
			if (inputEl) {
				if (inputEl.type === 'checkbox') inputEl.checked = Boolean(p.value);
				else inputEl.value = String(p.value);
			}
		}
		// 碰撞箱回填（含比例缩放联动）
		const { halfWidth, standHeight, duckHeight, source, isDefault } = msg.hull;
		if (dom.hullHalfWidth) dom.hullHalfWidth.value = String(halfWidth);
		if (dom.hullHalfWidthNum) dom.hullHalfWidthNum.value = String(halfWidth);
		if (dom.hullStandHeight) dom.hullStandHeight.value = String(standHeight);
		if (dom.hullStandHeightNum) dom.hullStandHeightNum.value = String(standHeight);
		if (dom.hullDuckHeight) dom.hullDuckHeight.value = String(duckHeight);
		if (dom.hullDuckHeightNum) dom.hullDuckHeightNum.value = String(duckHeight);
		if (dom.hullScale && dom.hullScaleNum) {
			const k = standHeight / 72;
			const uniform = Math.abs(halfWidth / 16 - k) < 0.02 && Math.abs(duckHeight / 54 - k) < 0.02;
			if (uniform && !isDefault) {
				dom.hullScale.value = String(Math.round(k * 20) / 20);
				dom.hullScaleNum.value = String(Math.round(k * 100) / 100);
			} else if (isDefault) {
				dom.hullScale.value = '1';
				dom.hullScaleNum.value = '1';
			} else {
				dom.hullScale.value = '1';
				dom.hullScaleNum.value = '1';
			}
		}
		if (dom.autoRestoreHullChk) dom.autoRestoreHullChk.checked = msg.autoRestoreHull;
		if (dom.hullSourceBadge) {
			const label = SOURCE_LABEL[source as ParamSource] ?? SOURCE_LABEL['mode-default'];
			dom.hullSourceBadge.textContent = `来源：${label.text}`;
			dom.hullSourceBadge.style.color = label.color;
		}
		// 面板参数 → 主线程渲染物理实例镜像（双端同参）
		mirrorSnapshotToPrediction(msg);
	} finally {
		panelSuppress = false;
	}
}

/** 物理面板快照 → 主线程渲染物理实例（PARAM_TO_RUST snake_case 映射）。 */
function mirrorSnapshotToPrediction(msg: PhysicsSnapshotMessage): void {
	if (!rendererMain) return;
	const params: Record<string, number | boolean> = {};
	for (const p of msg.params) {
		const rustName = PARAM_TO_RUST[p.name as keyof typeof PARAM_TO_RUST];
		if (rustName) params[rustName] = p.value;
	}
	if (Object.keys(params).length > 0) {
		rendererMain.setPredictionParams(params);
	}
	const { halfWidth, standHeight, duckHeight } = msg.hull;
	rendererMain.setPredictionHull(halfWidth, standHeight, duckHeight);
}

/** 物理事件通知（自动恢复等）。 */
function onPhysicsEvent(msg: PhysicsEventMessage): void {
	if (msg.event === 'hull-auto-restored') {
		setStatus(msg.message, 'success');
	}
}

// ---------------------------------------------------------------------------
// 输入循环（主线程 rAF：每帧推送按键到 Worker + 喂主线程渲染物理按键/Q-E 等效像素）
// ---------------------------------------------------------------------------

/** 主线程 rAF 循环：按键 → 渲染物理（同写 SAB 权威端）+ HUD 本地采样（阶段 2）。 */
function startInputLoop(): void {
	let lastQeMs = 0;
	// HUD 本地采样：FPS 主线程 rAF 计数；stats/game-stats 10Hz
	let lastStatsAt = 0;
	let lastGameStatsAt = 0;
	const tick = (now: number): void => {
		requestAnimationFrame(tick);
		// FPS 计数（每秒一次刷新 localFps，供 HUD 显示）
		fpsFrames++;
		if (now - fpsTime >= 1000) {
			localFps = fpsFrames;
			fpsFrames = 0;
			fpsTime = now;
		}
		if (!inputBridge || !rendererMain || !sceneReady) return;

		// ── 本帧最终输入（唯一权威来源；三条路径互斥）────────────────────────
		// ① 回放中：**覆盖**设备输入（replay wins——绝不同时应用实时键位/鼠标）。
		//    时间戳取"下一个待消费样本 − ε"（确定性回放要求时间即录制时间；
		//    物理 dt 另由 frameDt() 覆盖到渲染主循环，见 renderer-main.replayDtS）。
		// ② 合成输入（__wsInput.pushSynthetic，无头驱动用）：与真实路径同构。
		// ③ 实时：按键位掩码 + 滚轮跳 + Q/E 等效鼠标量（与改动前逐字节一致）。
		let finalDx: number;
		let finalDy: number;
		let finalKeys: number;
		/** 本帧是否真的要把输入交给 feedInput（回放期同一帧只喂一次，见 lastFedReplayIndex）。 */
		let feed = true;
		if (inputReplaying) {
			// **游标由回放自己推进**：确定性（样本时钟）模式下每帧恰推进一步。
			// 这里原先只调 next()，而 next() 的语义是"保持当前帧"（游标只由 step()/
			// stepReplay() 推进）——于是面板回放**永远停在第 0 帧**，只有走
			// __wsInput.tickReplay()（内部 stepReplay）的无头路径才会前进。
			// 握手：仅当上一帧的录制 dt 已被渲染主循环消费（replayDtS 归 null）才推进
			// 下一帧 →"回放帧 ↔ 物理步"严格 1:1。不握手就会丢帧（本帧输入被下一帧
			// 覆盖，dx/dy 是累加语义）或重复喂。
			const canAdvance = !rendererMain || rendererMain.replayDtS === null;
			const stepped =
				inputPlayer.isSampleClock() && !externalReplayClock && canAdvance
					? inputPlayer.stepReplay(1 / 64)
					: null;
			const f = stepped ? stepped.frame : inputPlayer.next(inputPlayer.sampleNow());
			if (f) {
				finalDx = f.dx;
				finalDy = f.dy;
				finalKeys = f.keys;
				rendererMain.replayDtS = stepped ? stepped.dtS : inputPlayer.frameDt(1 / 64);
			} else {
				// 尚未到首帧时间：本帧零输入（保持 pendingKeys 原值不动会沿用设备残留）
				finalDx = 0;
				finalDy = 0;
				finalKeys = 0;
			}
			const idx = inputPlayer.state().index;
			if (idx === lastFedReplayIndex) {
				// 同一回放样本的第二个 rAF 窗口：不重复喂（dx/dy 是累加语义）
				feed = false;
			} else if (replayCaptureArmed) {
				// 回放捕获：每个样本**只记一条**（与录制逐帧一一对应，才能逐帧比对）
				replayCapture.record(now, finalDx, finalDy, finalKeys);
				replayLoopFrames++;
			}
			if (idx !== lastFedReplayIndex) lastFedReplayIndex = idx;
			// 确定性回放：渲染主循环已消费上一拍推进的那一帧 → 等待计数递减
			if (replayTickWait > 0) replayTickWait--;
		} else {
			const syn = takeSynthetic();
			if (syn) {
				// 合成鼠标量也要吃 Q/E 合并（与真实路径同一处代码），按键位直接给
				const qe = qeEquivalentDx(config.input.yawBindSpeed, 1 / 64);
				const qeDx = (syn.keys & KEY_MASK.yawRight ? qe : 0) - (syn.keys & KEY_MASK.yawLeft ? qe : 0);
				finalDx = syn.dx + qeDx;
				finalDy = syn.dy;
				finalKeys = syn.keys;
			} else {
				// 按键位掩码；每帧喂渲染物理（渲染 tick 同写 SAB 权威输入槽 → Worker
				// 权威帧模拟同输入，双端角度不分叉）。未锁定（面板打开）时强制 0：
				// 双保险防 ESC 前后按键状态残留（与 game startInputLoop 同法）
				const keys = keyboard.getState();
				const mask = pointerLock.isLocked() ? keysToMask(keys) : 0;
				// 滚轮跳：仅锁定时并入本帧输入（消费一次即清）
				const maskWithWheel = pointerLock.isLocked() && wheelJumpPending ? mask | KEY_MASK.wheelJump : mask;
				wheelJumpPending = false;

				// Q/E 键 → 等效鼠标像素（与 game 输入层同法：yaw_bind_speed/M_YAW × dt，
				// 独立增量不受灵敏度影响；实现收敛到 ts-shared qeEquivalentDx），并入本帧输入
				const dtF = lastQeMs === 0 ? 1 / 144 : Math.min((now - lastQeMs) / 1000, 0.1);
				lastQeMs = now;
				const qe = qeEquivalentDx(config.input.yawBindSpeed, dtF);
				const qeDx = (maskWithWheel & KEY_MASK.yawRight ? qe : 0) - (maskWithWheel & KEY_MASK.yawLeft ? qe : 0);
				finalDx = qeDx;
				finalDy = 0;
				finalKeys = maskWithWheel;
			}
			// 录制点已移到**物理步**（rendererMain.onPhysicsStep）：挂在本循环会漏掉
			// 鼠标（鼠标走 mousemove 直连 feedInput，不经过本循环）。
		}
		// feedInput：回放期同一回放样本只喂一次（见 lastFedReplayIndex）
		if (feed) rendererMain.feedInput(finalDx, finalDy, finalKeys);

		// 回放跑完：自动收尾（把输入交还键盘鼠标，避免"卡在最后一帧"）
		if (inputReplaying && inputPlayer.isExhausted()) endPlayback();
		// 状态行刷新：回放中与**录制中**都要刷（录制期原本从不刷新 → 帧数冻结在
		// 点击「开始录制」那一刻的 0，看起来像"录不到东西"，实际样本一直在累积）。
		else if ((inputReplaying || inputRecorder.isRecording()) && now - lastRecUiAt >= 100) {
			lastRecUiAt = now;
			updateInputRecUi();
		}

		// 计时挑战：玩家移动（physics 模式）→ idle → running
		if (config.physics.mode === 'physics') {
			const v = rendererMain.getCurrentVel();
			if (v.x * v.x + v.y * v.y + v.z * v.z > 1) {
				game.onPlayerMove();
			}
		}

		// HUD 本地采样（10Hz）：stats（FPS/pos/vel/cluster）+ game-stats
		if (now - lastStatsAt >= 100) {
			lastStatsAt = now;
			updateStatsUI();
		}
		if (now - lastGameStatsAt >= 100) {
			lastGameStatsAt = now;
			updateGameStatsUI();
		}
	};
	requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// 配置同步
// ---------------------------------------------------------------------------

function syncFullConfig(): void {
	if (!inputBridge) return;
	// 发送所有段到 Worker（让它有完整 config 副本）
	const sections: Array<keyof RuntimeConfig> = [
		'physics',
		'player',
		'movement',
		'smoothing',
		'teleport',
		'lod',
		'lighting',
		'input',
		'hud',
		'debug',
	];
	for (const section of sections) {
		const patch = config[section] as unknown as Record<string, unknown>;
		inputBridge.sendConfig(section, patch);
		// 渲染相关段（lighting/debug/input/lod）同步到主线程渲染器
		rendererMain?.applyConfigPatch(section, patch);
	}
}

// ---------------------------------------------------------------------------
// UI 辅助
// ---------------------------------------------------------------------------

/** 权威健康消息缓冲（面板「权威健康」控制台；最新在顶，限 30 条）。 */
const healthLogLines: string[] = [];
function pushHealthLog(message: string): void {
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  healthLogLines.unshift(`[${now}] ${message}`);
  if (healthLogLines.length > 30) healthLogLines.length = 30;
  const el = document.getElementById('health-log');
  if (el) el.textContent = healthLogLines.join('\n');
  const cnt = document.getElementById('health-count');
  if (cnt) cnt.textContent = String(healthLogLines.length);
}
const healthClearBtn = document.getElementById('health-clear');
healthClearBtn?.addEventListener('click', () => {
  healthLogLines.length = 0;
  const el = document.getElementById('health-log');
  if (el) el.textContent = '（无消息）';
  const cnt = document.getElementById('health-count');
  if (cnt) cnt.textContent = '0';
});
function setStatus(msg: string, cls: 'success' | 'error' | ''): void {
	if (dom.statusEl) {
		dom.statusEl.textContent = msg;
		dom.statusEl.className = cls ? `status ${cls}` : 'status';
	}
}

function setError(msg: string): void {
	if (dom.errorEl) {
		dom.errorEl.textContent = msg;
		dom.errorEl.style.display = msg ? 'block' : 'none';
	}
	console.error(`[app] ${msg}`);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

void main();
