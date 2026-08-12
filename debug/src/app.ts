/**
 * WebSurf — 主线程入口
 * 创建 Worker（权威帧计算器：WASM 物理世界 + 固定步长模拟）、绑定键盘/鼠标输入与
 * UI 控件、主线程解析 BSP 并驱动渲染物理（唯一物理渲染线），本地更新 HUD。
 */

import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { MouseBuffer } from './input/mouse-buffer.js';
import { PointerLockController } from './input/pointer-lock.js';
import { createConfig, applyConfigPatch } from './config.js';
import { loadDefaultTexturePack } from './default-pack.js';
import { ensureMainWasm, mainWasmUrl } from './main-wasm.js';
// 阶段 1：主线程解析/物理接管（与 Worker 同一 wasm 模块实例）
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
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask, KEY_MASK } from '../../src/ts-shared/auth/shared-state.js';
import type { SharedState } from '../../src/ts-shared/auth/shared-state.js';
import { layerMouseDelta, qeEquivalentDx } from '../../src/ts-shared/input/input-layer.js';
import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../src/ts-shared/phys/params.js';
import { buildWorldBundle } from '../../src/ts-shared/phys/world-builder.js';
import type { WorldMetadata } from '../../src/ts-shared/phys/world-builder.js';
import { RendererMain, type CullStatsLike, type RenderPhysEvent } from './renderer/renderer-main.js';
import { formatTime, GameState } from './game/game-state.js';
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
	// 缺失材质纹理确认弹窗
	missingTexturesModal: document.getElementById('missingTexturesModal') as HTMLElement | null,
	missingTexturesSummary: document.getElementById('missingTexturesSummary') as HTMLElement | null,
	missingTexturesList: document.getElementById('missingTexturesList') as HTMLElement | null,
	missingTexturesOk: document.getElementById('missingTexturesOk') as HTMLButtonElement | null,
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
	showPlaneInfoChk: document.getElementById('showPlaneInfo') as HTMLInputElement | null,
	planeInfoEl: document.getElementById('planeInfo') as HTMLElement | null,
	// 近平面贴墙自适应（实时生效）
	nearProbeDistRange: document.getElementById('nearProbeDist') as HTMLInputElement | null,
	nearProbeDistNum: document.getElementById('nearProbeDistNum') as HTMLInputElement | null,
	nearRatioRange: document.getElementById('nearRatio') as HTMLInputElement | null,
	nearRatioNum: document.getElementById('nearRatioNum') as HTMLInputElement | null,
	ambientIntensityRange: document.getElementById('ambientIntensity') as HTMLInputElement | null,
	ambientIntensityNum: document.getElementById('ambientIntensityNum') as HTMLInputElement | null,
	// 物理控制面板
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
	// 自定义传送点面板
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
/** 跨线程状态通道（SAB / MsgState 回退；phys-frame 缓存 + recvFrame）。 */
let sharedState: SharedState | null = null;
/** 最近一次出生点传送索引（去重；换地图时重置）。 */
let lastTeleportIdx = -1;
/** 主线程渲染器（唯一渲染入口）。 */
let rendererMain: RendererMain | null = null;
let sceneReady = false;

/** 计时挑战状态机（阶段 2 起主线程持有；权威 Worker 不再消费事件）。 */
const game = new GameState();

/** 场景死亡阈值 Y（onSceneLoaded 记录；world-json 后重发 Worker 防丢弃）。 */
let sceneDeathY: number | null = null;

// 自定义传送点：地图名（localStorage 分组）
let teleportMapName = '';
/** 输入循环状态 */
let wheelJumpPending = false;

// HUD 本地采样（阶段 2）：FPS 主线程 rAF 计数（每秒刷新）
let localFps = 0;
let fpsFrames = 0;
let fpsTime = 0;

/** 主线程 wasm 就绪（默认已 resolved；渲染器初始化处赋 ensureMainWasm promise）。
 * 地图加载前 await，保证后续阶段主线程 BspProcessor/PhysWorld 可用。 */
let mainWasmReady: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!dom.canvas) {
		console.error('[app] canvas#preview 元素未找到');
		return;
	}

	// 0. 共享内存通道（SharedArrayBuffer 需 crossOriginIsolated，dev 已配 COOP/COEP）；
	//    否则自动回退 postMessage 数据通道（功能等价、延迟更高）。
	const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
	let sharedBuffer: SharedArrayBuffer | null = null;
	if (isolated && typeof SharedArrayBuffer !== 'undefined') {
		sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
		console.log('[app] crossOriginIsolated 已启用，使用共享内存输入/物理通道');
	} else {
		console.warn('[app] 未启用 crossOriginIsolated，回退 postMessage 输入通道（延迟较高）');
	}

	// 1. 创建 Worker + 共享状态
	// dist 内嵌模式：用构建注入的 __VBSP_WORKER_JS__ 建 Blob URL（避免 file:// 下 module worker 失败）；
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

	// WASM 注入：dist 模式把内嵌的 __VBSP_WASM_B64__ 通过 postMessage 发给 worker
	//（Blob Worker 读不到主线程 global）；dev/multi 模式发 wasmUrl，由 worker fetch。
	// single 打包：默认纹理包 base64 一并下发（file:// 下 worker 无法 fetch，缺失回退依赖它）。
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
		// 双端设置掉落死亡阈值（主线程渲染物理 + Worker 权威物理）。
		// 注意：loadScene 时机早于 world-json，Worker 侧 phys 未构建会丢弃该消息，
		// 需在 handleLoadBsp world-json 后重发（见 handleLoadBsp）。
		sceneDeathY = deathThresholdY;
		rendererMain?.setDeathY(deathThresholdY);
		inputBridge?.sendSetDeathThreshold(deathThresholdY);
	};
	// 权威兜底：渲染主线（144Hz 精度更高）→ 权威 Worker 反向校准；同步瞬间
	// 清双端未消费输入增量（Worker 侧由 sync-render-state 处理 resetInput）
	rendererMain.onSyncRenderState = (s) => {
		worker?.postMessage({ type: 'sync-render-state', state: s });
	};
	// 渲染物理事件（Rust take_event：teleport/death）→ 计时挑战状态机（主线程）
	rendererMain.onPhysEvent = onRenderPhysEvent;
	rendererMain.init(
		dom.canvas,
		dom.canvas.clientWidth,
		dom.canvas.clientHeight,
		window.devicePixelRatio,
		config,
	);
	rendererMain.start();
	// 主线程 wasm 懒初始化（mosaic / 地图加载前置依赖；与 worker 实例互不影响）。
	// 保存 promise：handleBspFile 开头 await 防地图加载时 wasm 未就绪（参照 game 模式）。
	mainWasmReady = ensureMainWasm().catch((err) => {
		setError(`主线程 WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
	});

	// 3. 绑定输入
	bindInput(dom.canvas);
	// 3.2 面板偏好持久化：加载（config 合并 + 控件同步 + 准星应用 + 双端发送）
	loadUiPrefs();
	syncPrefsControls();
	applyCrosshairStyle();
	sendPrefsToWorker();
	bindUI();
	// 3.3 初始控件状态（config 默认值 → 面板）
	if (dom.colliderSourceSelect) dom.colliderSourceSelect.value = config.physics.colliderSource;
	if (dom.pvsEnabledChk) dom.pvsEnabledChk.checked = config.lod.pvsEnabled;
	if (dom.physicsModeSelect) dom.physicsModeSelect.value = config.physics.mode;

	// 4. 输入循环（按键/滚轮/Q-E → 主线程渲染物理 + SAB 权威端）
	startInputLoop();
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
			`${msg.numSpawnPoints} 出生点，PVS ${msg.hasPvs ? '启用' : '无'}，` +
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
	// 自定义传送点：启用按钮 + 从 localStorage 刷新列表
	if (dom.capturePosBtn) dom.capturePosBtn.disabled = false;
	if (dom.addTeleportBtn) dom.addTeleportBtn.disabled = false;
	renderCustomTeleports();
	// 显示设置：同步碰撞箱显示开关 + 准星信息开关
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
	if (dom.showPlaneInfoChk) dom.showPlaneInfoChk.checked = config.debug.showPlaneInfo;
	// 纹理画质：同步 radio 状态
	dom.textureQualityRadios.forEach((radio) => {
		radio.checked = radio.value === config.texture.quality;
	});
}

// ---------------------------------------------------------------------------
// 缺失材质纹理：加载后与默认配置纹理包（textures.mtz）比对，列出并等待确认
// （回退已在 renderer 场景构建期自动应用，此处仅展示信息）
// ---------------------------------------------------------------------------

/** 确认弹窗：仅关闭（缺失纹理回退已在场景构建期完成）。 */
function handleMissingFallback(): void {
	dom.missingTexturesModal?.classList.add('hidden');
}

/**
 * 展示缺失材质纹理列表并等待用户确认（地图加载完成后调用）。
 * 比对：地图缺失纹理（VMT/VTF 缺失 → 占位色）vs 默认纹理包键集合。
 * - 默认包覆盖：`materials/<名>` 存在 → 绿色标注（已在构建期自动回退为低清纹理）
 * - 完全缺失：默认包也没有 → 红色标注（保持占位色）
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
	// 确认弹窗：确认后关闭（回退已应用）
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
// HUD（阶段 2：主线程本地采样，无 Worker 回传）
// ---------------------------------------------------------------------------

/** 主 HUD 统计（10Hz 本地采样：FPS 主线程 rAF 计数；pos/vel/cluster 本地物理）。 */
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

/** 准星信息格式化（mesh/solid/ladder/trigger 分类展示）。 */
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

/** 剔除统计（主线程回调；LOD/PVS 本地数据）。 */
function updateCullStatsUI(msg: CullStatsLike): void {
	if (dom.cullStatsEl) {
		const p = msg.pvs;
		dom.cullStatsEl.textContent =
			`可见 ${msg.visible}/${msg.total} (cull=${msg.cullDist.toFixed(0)})  ` +
			`PVS: cluster=${p.cluster >= 0 ? p.cluster : '—'} ` +
			`${p.visibleClusters}/${p.totalClusters} 可见 隐藏${p.pvsHidden}  LOD 近${p.near}/远${p.far}`;
	}
}

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
		const r = mouseBuffer.process(e.movementX, e.movementY);
		if (!r) return;
		const mask = keyboard.getMask();
		// 灵敏度输入层应用：物理两端 sensitivity 固定 1，这里乘入角度增量后统一分发
		// （改灵敏度只改这个系数，双端物理用同一份已缩放输入 → 角度永不因灵敏度分叉）
		const { dx, dy } = layerMouseDelta(r.dx, r.dy, config.input.sensitivity);
		rendererMain?.feedInput(dx, dy, mask);
	});

	// Pointer Lock：点击 canvas 时请求锁定
	canvas.addEventListener('click', () => {
		if (!sceneReady) return;
		if (!pointerLock.isLocked()) {
			void pointerLock.requestLock(canvas);
		}
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

	// 失焦时清空键盘状态
	window.addEventListener('blur', () => {
		keyboard.reset();
		rendererMain?.clearPendingInput();
	});
}

// ---------------------------------------------------------------------------
// UI 控件绑定
// ---------------------------------------------------------------------------

/** 面板偏好持久化键（input/hud/debug/lod/player 子集；物理参数由 Settings 另管）。 */
const UI_PREFS_KEY = 'vbsp:uiPrefs';

/** 收集面板可调偏好（config 子集，序列化用）。 */
function collectUiPrefs(): Record<string, unknown> {
	return {
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

/** 加载面板偏好 → 合并到 config + 控件同步 + 双端发送。 */
function loadUiPrefs(): void {
	try {
		const raw = localStorage.getItem(UI_PREFS_KEY);
		if (!raw) return;
		const prefs = JSON.parse(raw) as Record<string, unknown>;
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

	// 环境光强度（渲染即时生效；lighting 不随 UI 偏好持久化）
	bindSlider(dom.ambientIntensityRange, dom.ambientIntensityNum, (v) => {
		applyConfigPatch(config, 'lighting', { ambientIntensity: v });
		rendererMain?.applyConfigPatch('lighting', { ambientIntensity: v });
		inputBridge?.sendConfig('lighting', { ambientIntensity: v });
	}, (v) => Math.round(v * 20) / 20);

	// 缺失纹理确认弹窗关闭
	dom.missingTexturesOk?.addEventListener('click', () => {
		dom.missingTexturesModal?.classList.add('hidden');
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
 * 默认值对齐物理面板 PARAM_DEFS（与 Rust PhysParams::default 一致）；
 * 灵敏度固定 1（真实灵敏度由主线程输入层乘入，game 同法）。
 * 公共化：映射收敛到 ts-shared buildPhysicsParams，本处仅做 config 映射。
 */
function buildPredictionParams(config: RuntimeConfig): Record<string, unknown> {
	const p = config.physics;
	return sharedBuildPhysicsParams(
		{
			gravity: p.gravity,
			accelerate: p.accelerate,
			friction: p.friction,
			stopSpeed: p.stopSpeed,
			jumpSpeed: p.jumpSpeed,
			airAccel: p.airAccel,
			maxSpeed: p.maxSpeed,
			// debug 无独立走路/蹲走配置：取面板定义默认值（与 Worker PhysicsParams 默认一致）
			walkSpeed: 130,
			crouchSpeed: 85,
			autobhop: true,
			bhopSpeedClamp: true,
			noPrestrafe: true,
			teleportGateTicks: p.teleportGateTicks,
		},
		{
			yawBindSpeed: config.input.yawBindSpeed,
			noclipSpeed: config.input.noclipSpeed,
		},
	);
}

/** 文件入口：读字节 → 主线程解析（BspProcessor → 渲染 + 物理世界）。 */
async function handleBspFile(file: File): Promise<void> {
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
	// 让 UI 先更新（解析可能耗时）
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
		rendererMain.feedInput(qeDx, 0, maskWithWheel);

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
