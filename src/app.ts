/**
 * WebSurf — 主线程入口
 * 创建 Worker（WASM 解析 .bsp）、绑定键盘/鼠标输入与 UI 控件、
 * 接收 Worker 消息（stats/error/scene-ready 等）更新 UI。
 */

import type { WasmBspMetadata } from './world/types.js';
import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { MouseBuffer } from './input/mouse-buffer.js';
import { PointerLockController } from './input/pointer-lock.js';
import { createConfig, applyConfigPatch } from './config.js';
import type { RuntimeConfig } from './config.js';
import type {
	MainMessage,
	SceneDataMessage,
	StatsMessage,
	GameStatsMessage,
	PlayerPosMessage,
	PhysicsSnapshotMessage,
	PhysicsEventMessage,
	PlaneInfo,
} from './worker/worker-types.js';
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask } from './worker/shared-state.js';
import { RendererMain, type CullStatsLike } from './renderer/renderer-main.js';
import { formatTime } from './game/game-state.js';
// 物理控制面板：参数定义表（主线程渲染用，不含物理实现依赖）
import { PARAM_DEFS, type ParamSource } from './physics/param-defs.js';
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
	physicsModeSelect: document.getElementById('physicsMode') as HTMLSelectElement | null,
	colliderSourceSelect: document.getElementById('colliderSource') as HTMLSelectElement | null,
	mouseSensRange: document.getElementById('mouseSens') as HTMLInputElement | null,
	mouseSensNum: document.getElementById('mouseSensNum') as HTMLInputElement | null,
	yawBindSpeedRange: document.getElementById('yawBindSpeed') as HTMLInputElement | null,
	yawBindSpeedNum: document.getElementById('yawBindSpeedNum') as HTMLInputElement | null,
	cullDistRange: document.getElementById('cullDistance') as HTMLInputElement | null,
	cullDistNum: document.getElementById('cullDistanceNum') as HTMLInputElement | null,
	pvsEnabledChk: document.getElementById('pvsEnabled') as HTMLInputElement | null,
	respawnBtn: document.getElementById('respawnBtn') as HTMLButtonElement | null,
	spawnSelect: document.getElementById('spawnSelect') as HTMLSelectElement | null,
	// 传送触发模式（物理面板）
	triggerModeRadios: document.querySelectorAll('input[name="teleportTriggerMode"]') as NodeListOf<HTMLInputElement>,
	groundedFramesRow: document.getElementById('groundedFramesRow') as HTMLElement | null,
	groundedFramesRange: document.getElementById('groundedFramesRange') as HTMLInputElement | null,
	groundedFramesNum: document.getElementById('groundedFramesNum') as HTMLInputElement | null,
	// 显示设置（显示设置面板）
	showSolidsChk: document.getElementById('showSolids') as HTMLInputElement | null,
	showTriggersChk: document.getElementById('showTriggers') as HTMLInputElement | null,
	showPlaneInfoChk: document.getElementById('showPlaneInfo') as HTMLInputElement | null,
	planeInfoEl: document.getElementById('planeInfo') as HTMLElement | null,
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
/** 主线程渲染器（唯一渲染入口）。 */
let rendererMain: RendererMain | null = null;
let sceneReady = false;

/** 最近加载的 BSP 文件名（bsp-metadata 消息不含 name）。 */
let lastLoadedFileName = '';

// 自定义传送点：地图名（localStorage 分组）
let teleportMapName = '';
/** 保存当前位置后，是否已在等待 Worker 回传 player-pos。 */
let awaitingPlayerPos = false;

// 输入循环状态
let wheelJumpPending = false;

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
	//（Blob Worker 读不到主线程 global）；dev 模式发 wasmUrl，由 worker fetch。
	const embeddedWasm = (globalThis as unknown as { __VBSP_WASM_B64__?: string }).__VBSP_WASM_B64__;
	if (embeddedWasm) {
		worker.postMessage({ type: 'wasm-init', wasmB64: embeddedWasm });
	} else {
		worker.postMessage({ type: 'wasm-init', wasmUrl: '../pkg/websurf_wasm_bg.wasm' });
	}

	const sharedState = createMainSharedState(worker, sharedBuffer);
	inputBridge = new InputBridge(worker, sharedState);
	inputBridge.sendInit(
		sharedBuffer,
		dom.canvas.clientWidth,
		dom.canvas.clientHeight,
		window.devicePixelRatio,
	);

	// 2. 主线程渲染器
	rendererMain = new RendererMain(sharedState);
	rendererMain.onCullStats = updateCullStatsUI;
	rendererMain.onSceneLoaded = (deathThresholdY) => {
		// 回传死亡阈值给 Worker（死亡判定依赖世界 Y 下限）
		inputBridge?.sendSetDeathThreshold(deathThresholdY);
	};
	rendererMain.init(
		dom.canvas,
		dom.canvas.clientWidth,
		dom.canvas.clientHeight,
		window.devicePixelRatio,
		config,
	);
	rendererMain.start();

	// 3. 绑定输入
	bindInput(dom.canvas);
	bindUI();

	// 3.5 初始化"进入地图前即可设置"的控件（物理模式/碰撞来源/PVS 等与地图加载无关）
	if (dom.colliderSourceSelect) dom.colliderSourceSelect.value = config.physics.colliderSource;
	if (dom.pvsEnabledChk) dom.pvsEnabledChk.checked = config.lod.pvsEnabled;
	if (dom.physicsModeSelect) dom.physicsModeSelect.value = config.physics.mode;

	// 4. 启动输入循环（帧信号 + 按键位掩码）
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
			setStatus('Worker 已就绪。请加载 .bsp 文件。', 'success');
			// 同步全量配置到 Worker
			syncFullConfig();
			break;
		case 'bsp-metadata':
			// 解析后回传元数据 → 渲染 UI（文件名取 lastLoadedFileName）
			renderMetadata(msg.metadata, lastLoadedFileName);
			break;
		case 'parse-progress':
			// 解析进度 → status 区实时展示
			setStatus(msg.stage, '');
			break;
		case 'spawn-options':
			// 出生点列表由 Worker 回传
			renderSpawnOptions(msg.spawnJson);
			break;
		case 'scene-data':
			void handleSceneData(msg);
			break;
		case 'phys-frame':
			// 回退模式（MsgState）：缓存 Worker 回传的物理帧
			inputBridge?.setCachedFrame(msg.frame);
			break;
		case 'stats':
			updateStatsUI(msg);
			break;
		case 'game-stats':
			updateGameStatsUI(msg);
			break;
		case 'physics-snapshot':
			renderPhysicsSnapshot(msg);
			break;
		case 'physics-event':
			onPhysicsEvent(msg);
			break;
		case 'player-pos':
			onPlayerPos(msg);
			break;
		case 'error':
			setError(msg.message);
			break;
		default:
			// 未知消息：忽略（向前兼容）
			break;
	}
}

/** 场景数据到达：主线程建场景（GLTFLoader + LOD/PVS）并启用控件。 */
async function handleSceneData(msg: SceneDataMessage): Promise<void> {
	if (!rendererMain) {
		setStatus('渲染器未就绪，无法加载场景。', 'error');
		return;
	}
	const diag = await rendererMain.loadScene(msg);
	sceneReady = true;
	setStatus(
		`场景已加载（GLB ${msg.glbSizeKb} KB，${msg.metadata.numBrushes} brushes，` +
			`${msg.numSpawnPoints} 出生点，PVS ${msg.hasPvs ? '启用' : '无'}，` +
			`对角线 ${(diag?.diagonal ?? 0).toFixed(0)} HU）`,
		'success',
	);
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
	// 传送触发模式：同步 radio 状态 + 落地帧数滑块可见性
	dom.triggerModeRadios.forEach((radio) => {
		radio.checked = radio.value === config.debug.teleportTriggerMode;
	});
	if (dom.groundedFramesRange) {
		dom.groundedFramesRange.value = String(config.debug.groundedFramesRequired);
	}
	if (dom.groundedFramesNum) {
		dom.groundedFramesNum.value = String(config.debug.groundedFramesRequired);
	}
	updateGroundedFramesVisibility();
	// 显示设置：同步碰撞箱显示开关 + 准星信息开关
	if (dom.showSolidsChk) dom.showSolidsChk.checked = config.debug.showSolids;
	if (dom.showTriggersChk) dom.showTriggersChk.checked = config.debug.showTriggers;
	if (dom.showPlaneInfoChk) dom.showPlaneInfoChk.checked = config.debug.showPlaneInfo;
}

function updateStatsUI(msg: StatsMessage): void {
	if (!dom.statsEl) return;
	const [px, py, pz] = msg.pos;
	let text =
		`FPS ${msg.fps}  位置 ${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}  ` +
		`速度 ${msg.speed.toFixed(0)}  ${msg.onGround ? '地面' : '空中'}  ` +
		`cluster ${msg.cluster >= 0 ? msg.cluster : '—'}`;
	// 速度归零诊断（卡坡时显示触发路径，如 cornered×3 / blocked×3 / stuck×N）
	if (msg.zeroCause) {
		text += `  卡因[${msg.zeroCause}]`;
	}
	dom.statsEl.textContent = text;
	// 准星射线检测信息（渲染器本地计算，随渲染循环刷新）
	if (dom.planeInfoEl) {
		dom.planeInfoEl.textContent = formatPlaneInfo(rendererMain?.getPlaneInfo() ?? null);
	}
}

/** 格式化准星射线检测信息（模型/实体平面/触发面）。 */
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
					].filter(Boolean).join(' ')
				: '';
			return (
				`准星 模型「${info.meshName ?? ''}」 ${dist}HU ` +
				`[${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}]` +
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
				`#${info.brushIndex} ${dist}HU 法线(${n}) ` +
				`[${px.toFixed(0)},${py.toFixed(0)},${pz.toFixed(0)}]`
			);
		}
		case 'trigger': {
			const t = info.triggerTarget ?? '—';
			const dest = info.triggerDestIdx ?? -1;
			return (
				`准星 触发面「${info.triggerClassname ?? 'trigger'}」→${t}` +
				`(dest#${dest}) ${dist}HU` +
				(info.triggerStartDisabled ? ' [禁用]' : '')
			);
		}
		default:
			return '准星 —';
	}
}

function updateCullStatsUI(msg: CullStatsLike): void {
	if (dom.cullStatsEl) {
		const p = msg.pvs;
		dom.cullStatsEl.textContent =
			`可见 ${msg.visible}/${msg.total} (cull=${msg.cullDist.toFixed(0)})  ` +
			`PVS: cluster=${p.cluster >= 0 ? p.cluster : '—'} ` +
			`${p.visibleClusters}/${p.totalClusters} 可见 隐藏${p.pvsHidden}  ` +
			`LOD 近${p.near}/远${p.far}`;
	}
}

function updateGameStatsUI(msg: GameStatsMessage): void {
	if (!dom.gameStatsEl) return;
	let phaseLabel: string;
	let timeLabel: string;
	switch (msg.phase) {
		case 'idle':
			phaseLabel = '待开始';
			timeLabel = formatTime(msg.elapsedMs);
			break;
		case 'running':
			phaseLabel = '挑战中';
			timeLabel = formatTime(msg.elapsedMs);
			break;
		case 'finished':
			phaseLabel = '已完成';
			timeLabel = formatTime(msg.finishTimeMs);
			break;
	}
	const cpLabel = msg.checkpointCount > 0
		? `${msg.checkpointCount}(${msg.lastCheckpointName})`
		: '0';
	const text =
		`阶段 ${phaseLabel}  计时 ${timeLabel}  ` +
		`检查点 ${cpLabel}  死亡 ${msg.deaths}`;
	dom.gameStatsEl.textContent = text;
	// 死亡闪烁：红色高亮 500ms
	if (msg.justDied) {
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

	// 鼠标移动：过滤后立即写入共享内存输入区，不再经 8ms 限流批量发送，输入→物理延迟≈0
	window.addEventListener('mousemove', (e) => {
		if (!pointerLock.isLocked()) return;
		const r = mouseBuffer.process(e.movementX, e.movementY);
		if (r && inputBridge) {
			inputBridge.setInput(r.dx, r.dy, keyboard.getMask());
		}
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
	});
}

// ---------------------------------------------------------------------------
// UI 控件绑定
// ---------------------------------------------------------------------------

function bindUI(): void {
	// 物理控制面板：参数行初始化（值由 physics-snapshot 回填）
	initPhysicsPanel();

	// 文件上传
	dom.fileInput?.addEventListener('change', async (e) => {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await handleBspFile(file);
		// 重置 input.value 允许重新选择同一文件
		input.value = '';
	});

	// 物理模式
	dom.physicsModeSelect?.addEventListener('change', (e) => {
		const mode = (e.target as HTMLSelectElement).value as 'noclip' | 'physics';
		inputBridge?.sendSetPhysicsMode(mode);
		applyConfigPatch(config, 'physics', { mode });
	});

	// 碰撞来源（模型碰撞网格：可视网格 vs 模型自带 .phy；重新加载地图后生效）
	dom.colliderSourceSelect?.addEventListener('change', (e) => {
		const v = (e.target as HTMLSelectElement).value as 'auto' | 'visual' | 'phy';
		applyConfigPatch(config, 'physics', { colliderSource: v });
		inputBridge?.sendConfig('physics', { colliderSource: v });
		setStatus('碰撞来源已切换，重新加载地图后生效。', '');
	});

	// 鼠标灵敏度（cs-movement 乘数：有效灵敏度 = sensitivity * m_yaw 0.022 deg/px）
	dom.mouseSensRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.mouseSensNum && Number.isFinite(val)) dom.mouseSensNum.value = String(val);
		config.input.sensitivity = val;
		// sensitivity 通过 config 同步到 Worker 端 player.settings.sensitivity
		inputBridge?.sendConfig('input', { sensitivity: val });
	});
	dom.mouseSensNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		if (dom.mouseSensRange) dom.mouseSensRange.value = String(Math.min(5, Math.max(0.1, val)));
		config.input.sensitivity = val;
		inputBridge?.sendConfig('input', { sensitivity: val });
	});

	// Q/E 键 yaw 旋转速度（turn bind，度/秒）
	dom.yawBindSpeedRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.yawBindSpeedNum && Number.isFinite(val)) dom.yawBindSpeedNum.value = String(val);
		applyConfigPatch(config, 'input', { yawBindSpeed: val });
		inputBridge?.sendConfig('input', { yawBindSpeed: val });
	});
	dom.yawBindSpeedNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		if (dom.yawBindSpeedRange) dom.yawBindSpeedRange.value = String(Math.min(720, Math.max(0, val)));
		applyConfigPatch(config, 'input', { yawBindSpeed: val });
		inputBridge?.sendConfig('input', { yawBindSpeed: val });
	});

	// 视距剔除（主线程渲染器 LOD 直接生效 + Worker 配置同步）
	dom.cullDistRange?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (dom.cullDistNum && Number.isFinite(val)) dom.cullDistNum.value = String(val);
		rendererMain?.setCullDistance(val);
		inputBridge?.sendSetCullDistance(val);
	});
	dom.cullDistNum?.addEventListener('input', (e) => {
		const val = parseFloat((e.target as HTMLInputElement).value);
		if (!Number.isFinite(val)) return;
		const max = parseFloat(dom.cullDistRange?.max ?? '100000');
		if (dom.cullDistRange) dom.cullDistRange.value = String(Math.min(max, Math.max(1000, val)));
		rendererMain?.setCullDistance(val);
		inputBridge?.sendSetCullDistance(val);
	});

	// PVS 开关
	dom.pvsEnabledChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		inputBridge?.sendConfig('lod', { pvsEnabled: enabled });
	});

	// 重生
	dom.respawnBtn?.addEventListener('click', () => {
		inputBridge?.sendRespawn();
	});

	// Spawn 选择
	dom.spawnSelect?.addEventListener('change', (e) => {
		const idx = parseInt((e.target as HTMLSelectElement).value, 10);
		if (!Number.isNaN(idx)) {
			inputBridge?.sendTeleport(idx);
		}
	});

	// 自定义传送点：保存当前位置
	dom.capturePosBtn?.addEventListener('click', () => {
		if (!sceneReady || !inputBridge) {
			setStatus('场景尚未就绪，请先加载地图。', 'error');
			return;
		}
		if (!teleportMapName) {
			setStatus('未识别当前地图名称，无法保存传送点。', 'error');
			return;
		}
		if (awaitingPlayerPos) {
			setStatus('正在获取玩家位置...', '');
			return;
		}
		awaitingPlayerPos = true;
		inputBridge.sendGetPlayerPos();
	});

	// 自定义传送点：手动添加（展开 X/Y/Z 输入框，避免单框自由文本误填）
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

	// 手动添加表单：提交（X/Y/Z 三个数字框分别校验）
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
		const list = addCustomTeleport(teleportMapName, {
			name,
			pos: [x, y, z],
			yaw,
		});
		renderCustomTeleports(list);
		// 重置并收起表单
		if (dom.tpX) dom.tpX.value = '';
		if (dom.tpY) dom.tpY.value = '';
		if (dom.tpZ) dom.tpZ.value = '';
		if (dom.tpName) dom.tpName.value = '';
		if (dom.tpYaw) dom.tpYaw.value = '';
		if (dom.addTeleportForm) dom.addTeleportForm.style.display = 'none';
		setStatus(`已添加传送点 (${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)})。`, 'success');
	});

	// 手动添加表单：取消
	dom.tpCancel?.addEventListener('click', () => {
		if (dom.tpX) dom.tpX.value = '';
		if (dom.tpY) dom.tpY.value = '';
		if (dom.tpZ) dom.tpZ.value = '';
		if (dom.tpName) dom.tpName.value = '';
		if (dom.tpYaw) dom.tpYaw.value = '';
		if (dom.addTeleportForm) dom.addTeleportForm.style.display = 'none';
	});

	// 自定义传送点：列表点击（传送 / 删除，事件委托）
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
				setStatus(`传送到「${tp.name}」(${fmtPos(tp.pos)})。`, 'success');
			}
		} else if (action === 'delete') {
			const list = removeCustomTeleport(teleportMapName, id);
			renderCustomTeleports(list);
		}
	});

	// HUD 开关（关闭时停止 stats 发送 + 平面检测，省性能）
	dom.hudVisibleChk?.addEventListener('change', (e) => {
		const visible = (e.target as HTMLInputElement).checked;
		if (dom.hudEl) dom.hudEl.style.display = visible ? '' : 'none';
		applyConfigPatch(config, 'hud', { visible });
		inputBridge?.sendConfig('hud', { visible });
	});

	// 准星开关
	dom.showCrosshairChk?.addEventListener('change', (e) => {
		const visible = (e.target as HTMLInputElement).checked;
		if (dom.crosshairEl) {
			dom.crosshairEl.classList.toggle('hidden', !visible);
		}
		applyConfigPatch(config, 'hud', { showCrosshair: visible });
		inputBridge?.sendConfig('hud', { showCrosshair: visible });
	});

	// 传送触发模式（物理面板）：StartTouch / 落地检测
	dom.triggerModeRadios.forEach((radio) => {
		radio.addEventListener('change', () => {
			if (!radio.checked) return;
			const mode = radio.value as 'start-touch' | 'start-touch-grounded';
			applyConfigPatch(config, 'debug', { teleportTriggerMode: mode });
			inputBridge?.sendConfig('debug', { teleportTriggerMode: mode });
			updateGroundedFramesVisibility();
		});
	});
	// 落地检测：连续落地帧数滑块 + 输入框
	dom.groundedFramesRange?.addEventListener('input', (e) => {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (dom.groundedFramesNum && Number.isFinite(val)) dom.groundedFramesNum.value = String(val);
		applyConfigPatch(config, 'debug', { groundedFramesRequired: val });
		inputBridge?.sendConfig('debug', { groundedFramesRequired: val });
	});
	dom.groundedFramesNum?.addEventListener('input', (e) => {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!Number.isFinite(val)) return;
		if (dom.groundedFramesRange) dom.groundedFramesRange.value = String(Math.min(30, Math.max(1, val)));
		applyConfigPatch(config, 'debug', { groundedFramesRequired: val });
		inputBridge?.sendConfig('debug', { groundedFramesRequired: val });
	});

	// 显示设置：实体/触发碰撞箱、准星射线检测（渲染器负责可视化，config 同步 Worker）
	dom.showSolidsChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showSolids: enabled });
		rendererMain?.applyConfigPatch('debug', { showSolids: enabled });
		inputBridge?.sendConfig('debug', { showSolids: enabled });
	});
	dom.showTriggersChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showTriggers: enabled });
		rendererMain?.applyConfigPatch('debug', { showTriggers: enabled });
		inputBridge?.sendConfig('debug', { showTriggers: enabled });
	});
	// 准星射线检测（hover 查看模型/实体平面/触发面信息）
	dom.showPlaneInfoChk?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		applyConfigPatch(config, 'debug', { showPlaneInfo: enabled });
		rendererMain?.applyConfigPatch('debug', { showPlaneInfo: enabled });
		inputBridge?.sendConfig('debug', { showPlaneInfo: enabled });
	});
}

/** 落地检测模式时显示连续落地帧数滑块，StartTouch 时隐藏。 */
function updateGroundedFramesVisibility(): void {
	const mode = config.debug.teleportTriggerMode;
	const isGrounded = mode === 'start-touch-grounded';
	if (dom.groundedFramesRow) {
		dom.groundedFramesRow.style.display = isGrounded ? '' : 'none';
	}
}

// ---------------------------------------------------------------------------
// 文件处理（WASM 解析）
// ---------------------------------------------------------------------------

/** 文件入口：只读字节 → transfer 给 Worker 解析。主线程不解析 WASM，UI 零阻塞。 */
async function handleBspFile(file: File): Promise<void> {
	if (!inputBridge) {
		setError('Worker 未就绪');
		return;
	}
	// 内存重置：先卸载旧地图的全部渲染资源（GPU geometry/material/纹理 +
	// LOD/PVS/碰撞可视化/插值缓存），防止多次加载地图累积泄漏导致帧率下降
	rendererMain?.disposeScene();
	lastLoadedFileName = file.name;
	teleportMapName = file.name;
	awaitingPlayerPos = false;
	setStatus(`正在发送 ${file.name} 到 Worker 解析...`, '');
	if (dom.spawnSelect) dom.spawnSelect.innerHTML = '';
	// transfer 后主线程不再读取 bytes（已 detach）
	inputBridge.sendLoadBsp(file.name, await file.arrayBuffer());
}

function renderMetadata(meta: WasmBspMetadata, filename: string): void {
	if (!dom.metadataEl) return;
	const rows: [string, string | number][] = [
		['文件名', filename],
		['魔术字', meta.magic],
		['模型数', meta.num_models],
		['面数', meta.num_faces],
		['顶点数', meta.num_vertices],
		['Brush 数', meta.num_brushes],
		['Leaf 数', meta.num_leaves],
		['Node 数', meta.num_nodes],
		['实体数', meta.num_entities],
		['静态道具数', meta.num_static_props],
		['Pakfile 文件数', meta.packed_files],
	];
	dom.metadataEl.innerHTML = rows
		.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
		.join('');
}

function renderSpawnOptions(spawnJson: string): void {
	if (!dom.spawnSelect) return;
	try {
		const data = JSON.parse(spawnJson) as { spawn_points: Array<{ classname: string; origin: number[]; angles: number[] }> };
		const opts = data.spawn_points.map((sp, i) => {
			const label = `${i}: ${sp.classname} (${sp.origin.map(n => n.toFixed(0)).join(',')})`;
			return `<option value="${i}">${label}</option>`;
		});
		dom.spawnSelect.innerHTML = opts.join('');
	} catch (err) {
		console.warn('[app] spawn 解析失败', err);
	}
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

/** 处理 player-pos 回传：保存当前位置为自定义传送点。 */
function onPlayerPos(msg: PlayerPosMessage): void {
	if (!awaitingPlayerPos) return;
	awaitingPlayerPos = false;
	if (!teleportMapName) return;
	const [x, y, z] = msg.pos;
	const list = addCustomTeleport(teleportMapName, {
		name: `位置 ${msg.pos.map((n) => n.toFixed(0)).join(',')}`,
		pos: [x, y, z],
		yaw: msg.yaw,
	});
	renderCustomTeleports(list);
	setStatus(
		`已保存当前位置 (${msg.pos.map((n) => n.toFixed(0)).join(',')}) 为传送点。`,
		'success',
	);
}

// ---------------------------------------------------------------------------
// 物理控制面板
// ---------------------------------------------------------------------------

/** 参数来源徽标样式（snapshot 回传 source → 展示）。 */
const SOURCE_LABEL: Record<ParamSource, { text: string; color: string }> = {
	'mode-default': { text: '默认', color: '#4a4' },
	manual: { text: '手动', color: '#4a90e2' },
	map: { text: '地图设置', color: '#c9a84a' },
};

/** 面板渲染防回环标志（snapshot 回写控件时抑制 input 事件）。 */
let panelSuppress = false;

/** 初始化物理参数行（静态定义渲染一次，值由 physics-snapshot 更新）。 */
function initPhysicsPanel(): void {
	if (!dom.physicsParamList) return;
	dom.physicsParamList.innerHTML = PARAM_DEFS.map((def) => {
		const unit = def.unit ? ` <span style="color:#6a6f8a; font-size:10px;">${def.unit}</span>` : '';
		if (def.kind === 'boolean') {
			return (
				`<div class="ctrl-checkbox-row ctrl-full" data-param-row="${def.name}">` +
				`<input type="checkbox" data-param="${def.name}" ${def.default ? 'checked' : ''} />` +
				`<label data-param-label="${def.name}" title="${def.description}" style="cursor:pointer;">${def.label}</label>` +
				`<span data-param-src="${def.name}" style="font-size:10px;"></span>` +
				`</div>`
			);
		}
		// 数值参数：滑块 + 数字输入框（允许范围内任意输入，双向同步）
		return (
			`<label data-param-label="${def.name}" title="${def.description}">${def.label}</label>` +
			`<input type="range" data-param="${def.name}" min="${def.min ?? 0}" max="${def.max ?? 100}" step="${def.step ?? 1}" />` +
			`<div class="val"><input type="number" data-param-input="${def.name}" class="param-num" ` +
			`min="${def.min ?? 0}" max="${def.max ?? 100}" step="any" value="${def.default}" />${unit}` +
			`<span data-param-src="${def.name}" style="font-size:10px; margin-left:2px;"></span></div>`
		);
	}).join('');

	// 参数行事件（range/number/checkbox → Worker，滑块与输入框双向同步）
	dom.physicsParamList.addEventListener('input', (e) => {
		if (panelSuppress) return;
		const el = e.target as HTMLInputElement;
		const name = el.dataset.param ?? el.dataset.paramInput;
		if (!name) return;
		const value = el.type === 'checkbox' ? el.checked : Number(el.value);
		// 同步兄弟控件（range ↔ number）
		if (el.dataset.param && el.type === 'range') {
			const numEl = document.querySelector(`[data-param-input="${name}"]`) as HTMLInputElement | null;
			if (numEl) numEl.value = String(value);
		} else if (el.dataset.paramInput) {
			const rangeEl = document.querySelector(`[data-param="${name}"]`) as HTMLInputElement | null;
			if (rangeEl && Number.isFinite(value)) rangeEl.value = String(value);
		}
		if (Number.isFinite(value)) inputBridge?.sendSetPhysicsParam(name, value);
	});
	// 碰撞箱控件（滑块 ↔ 输入框双向同步）
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

/** 从三个数值控件（滑块/输入框）发送 set-hull（同时把倍率滑块标为自定义）。 */
function sendHullFromInputs(): void {
	if (panelSuppress) return;
	inputBridge?.sendSetHull({
		halfWidth: Number(dom.hullHalfWidth?.value ?? 16),
		standHeight: Number(dom.hullStandHeight?.value ?? 72),
		duckHeight: Number(dom.hullDuckHeight?.value ?? 54),
	});
	if (dom.hullScaleNum) dom.hullScaleNum.value = '1';
}

/** 渲染物理参数快照（Worker → 主线程；参数值/来源/碰撞箱状态）。 */
function renderPhysicsSnapshot(msg: PhysicsSnapshotMessage): void {
	panelSuppress = true;
	try {
		// 1. 参数行：值（输入框/滑块）+ 来源 badge
		for (const p of msg.params) {
			const label = SOURCE_LABEL[p.source as ParamSource] ?? SOURCE_LABEL['mode-default'];
			const numEl = document.querySelector(`[data-param-input="${p.name}"]`) as HTMLInputElement | null;
			const srcEl = document.querySelector(`[data-param-src="${p.name}"]`);
			const inputEl = document.querySelector(`[data-param="${p.name}"]`) as HTMLInputElement | null;
			if (numEl) numEl.value = String(p.value);
			if (srcEl) {
				srcEl.textContent = label.text;
				(srcEl as HTMLElement).style.color = label.color;
			}
			if (inputEl) {
				if (inputEl.type === 'checkbox') inputEl.checked = Boolean(p.value);
				else inputEl.value = String(p.value);
			}
		}
		// 2. 碰撞箱：三值同步 + 倍率（与默认×k 一致则显示 k，否则"自定义"）
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
		// 3. 自动恢复开关 + 来源 badge
		if (dom.autoRestoreHullChk) dom.autoRestoreHullChk.checked = msg.autoRestoreHull;
		if (dom.hullSourceBadge) {
			const label = SOURCE_LABEL[source as ParamSource] ?? SOURCE_LABEL['mode-default'];
			dom.hullSourceBadge.textContent = `来源：${label.text}`;
			dom.hullSourceBadge.style.color = label.color;
		}
	} finally {
		panelSuppress = false;
	}
}

/** 物理事件通知（碰撞箱自动恢复等）。 */
function onPhysicsEvent(msg: PhysicsEventMessage): void {
	if (msg.event === 'hull-auto-restored') {
		setStatus(msg.message, 'success');
	}
}

// ---------------------------------------------------------------------------
// 输入循环（主线程 rAF，每帧推送按键状态 + frame 触发信号到 Worker）
// ---------------------------------------------------------------------------

function startInputLoop(): void {
	const tick = (): void => {
		requestAnimationFrame(tick);
		if (!inputBridge || !sceneReady) return;

		// 按键位掩码（含滚轮连跳脉冲，置位后清零）；环形缓冲下每帧推送，保证按住键不动鼠标时
		// Worker 仍能刷新按键状态
		const keys = keyboard.getState();
		keys.wheelJump = wheelJumpPending;
		wheelJumpPending = false;
		const mask = keysToMask(keys);
		inputBridge.setKeys(mask);

		// frame 触发信号（无负载，物理 dt 由 Worker 自算）；M2 Worker 自驱落地后移除
		inputBridge.sendFrame();
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
