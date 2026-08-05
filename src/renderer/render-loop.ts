/**
 * WebSurf — 渲染循环
 *
 * 中央编排器：持有 WebGLRenderer / Scene / Camera 与各渲染子管理器，
 * 驱动 rAF 帧循环：鼠标输入(已在 setInput 中直接写入 yaw/pitch) → 物理 tick → LOD/PVS → 渲染。
 *
 * 关键约束：
 * - WebGLRenderer 用 `powerPreference: 'high-performance'` 优先独显
 * - 像素比限制 `Math.min(window.devicePixelRatio, 2)`
 * - needsRender 标志（空闲帧跳过渲染）
 * - 物理固定步长 128Hz（FIXED_DT = 1/128），最多 MAX_FIXED_STEPS=10 次/帧
 * - LOD update 逻辑必须每帧执行（updateCounter++ 无条件）
 * - 从 yaw/pitch 生成 quaternion 时必须使用 'YXZ' 顺序（由 CameraController 保证）
 *
 * 鼠标输入流：
 *   主线程 mousemove → MouseBuffer(discardNext + 绝对削平 CLAMP@1000) → input 消息
 *   → Worker setInput → applyMouseDelta 直接写入 player.yaw/pitch(度)
 *   → tick 中 player.tick() / noclipStep → 相机从 yaw/pitch 同步
 *   公式：yaw -= dx * (sensitivity * m_yaw)；pitch -= dy * (sensitivity * m_yaw)；clamp ±89°
 */

import * as THREE from 'three';
import type { RuntimeConfig } from '../config.js';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import type { PlayerController } from '../physics/player/PlayerController.js';
import type { PvsManager } from '../world/pvs-manager.js';
import type { TeleportManager, TeleportTrigger } from '../world/teleport-manager.js';
import type { KeyState, PlaneInfo } from '../worker/worker-types.js';
import { CameraController } from './camera-controller.js';
import { ColliderDebug } from './collider-debug.js';
import { FogManager } from './fog-manager.js';
import { LightManager } from './light-manager.js';
import { LodManager } from './lod-manager.js';
import { PlaneInspector } from './plane-inspector.js';

/** 度→弧度转换因子。 */
const DEG2RAD = Math.PI / 180;
/** cs-movement m_yaw（deg/count，匹配 Source m_yaw/m_pitch，MouseInput.config.ts）。 */
const M_YAW = 0.022;
/** pitch 限位（度，匹配 cs-movement PITCH_CLAMP）。 */
const PITCH_CLAMP_DEG = 89;

/** 默认物理固定步长（128Hz，匹配 cs-movement DEFAULT_TICK_RATE）。 */
const FIXED_DT = 1 / 128;
/** 每帧最多固定步数（低帧率保护）。 */
const MAX_FIXED_STEPS = 10;
/** 视场角（度）。 */
const FOV = 75;
/** 准星射线检测限流（每 N 帧一次）。 */
const PLANE_INSPECT_INTERVAL = 6;

/**
 * 渲染循环。
 *
 * 生命周期：
 * 1. `init(canvas, width, height, dpr, config)` — 创建 renderer/scene/camera/管理器
 * 2. `setScene(scene, diagonal)` — 注入已加载场景（来自 SceneBuilder）
 * 3. `start()` — 启动 rAF；`stop()` — 停止
 * 4. `setInput(keys, mouseDx, mouseDy)` — 每帧由 worker 层推送输入（鼠标增量直接写入视角）
 */
export class RenderLoop {
	private renderer: THREE.WebGLRenderer | null = null;
	private scene: THREE.Scene | null = null;
	private camera: THREE.PerspectiveCamera | null = null;

	private _cameraController: CameraController | null = null;
	readonly lightManager = new LightManager();
	readonly fogManager = new FogManager();
	readonly lodManager = new LodManager();
	readonly colliderDebug = new ColliderDebug();

	private pvsManager: PvsManager | null = null;
	private teleportManager: TeleportManager | null = null;
	private playerController: PlayerController | null = null;
	/** 实体碰撞体列表（用于碰撞箱可视化，solids + ladders 合并）。 */
	private colliders: Brush[] = [];
	/** BSP 模型场景组（用于准星射线检测 mesh）。 */
	private bspModelScene: THREE.Object3D | null = null;
	/** solids 列表（用于准星射线检测区分 brushType）。 */
	private solids: Brush[] = [];
	/** ladders 列表（用于准星射线检测区分 brushType）。 */
	private ladders: Brush[] = [];
	/** 传送触发器列表（用于准星射线检测 trigger）。 */
	private triggers: TeleportTrigger[] = [];

	/** 准星射线检测器。 */
	private readonly planeInspector = new PlaneInspector();
	/** 准星射线检测限流计数器。 */
	private planeInspectCounter = 0;
	/** 最近一次准星检测结果（限频刷新，供 getPlaneInfo 读取）。 */
	private lastPlaneInfo: PlaneInfo | null = null;
	/** HUD/准星信息是否启用（关闭时跳过射线检测以节省性能）。 */
	private planeInfoEnabled = false;

	private config: RuntimeConfig | null = null;
	private physicsMode: 'noclip' | 'physics' = 'noclip';

	/** 物理固定步长（秒，由 tickRate 派生）。 */
	private fixedDt = FIXED_DT;

	/**
	 * noclip 模式临时视角（度，player 未创建时使用）。
	 * player 创建后，player.yaw/pitch 是唯一权威源，noclipView 自动同步。
	 */
	private noclipView = {
		yaw: 0,
		pitch: 0,
	};

	/** 当前按键状态。 */
	private keys: KeyState = {
		forward: false,
		backward: false,
		left: false,
		right: false,
		jump: false,
		duck: false,
		sprint: false,
		reset: false,
		wheelJump: false,
		yawLeft: false,
		yawRight: false,
	};

	/** needsRender 标志（外部触发或 LOD 变化触发）。 */
	private needsRender = true;
	/** 物理固定步长累加器。 */
	private moveAccumulator = 0;
	/** 上一帧时间戳（performance.now）。 */
	private lastTime = 0;
	/** rAF 句柄。 */
	private rafId = 0;
	/** 是否运行中。 */
	private running = false;

	/**
	 * 每帧物理 tick 结束后的回调（rAF 内调用一次）。
	 *
	 * 由 Worker 层设置，用于：
	 * - 检测传送触发器（`TeleportManager.checkTeleport`）
	 * - 周期性回传 stats 到主线程
	 */
	onAfterPhysics: ((frameDt: number, didPhysicsTick: boolean) => void) | null = null;

	/** 复用向量（避免每帧分配）。 */
	private readonly _fwdDir = new THREE.Vector3();
	private readonly _rightDir = new THREE.Vector3();
	private readonly _camPos = new THREE.Vector3();

	// bind tick 保证 rAF 回调 this 指向
	private readonly boundTick = this.tick.bind(this);

	constructor() {
		// cameraController 在 init 中创建（需要 camera 实例）
	}

	/** 相机控制器（init 后可用）。 */
	get cameraController(): CameraController | null {
		return this._cameraController;
	}

	/** 设置物理模拟频率（tickRate 参数 → Worker 调用）。 */
	setTickRate(rate: number): void {
		if (rate >= 1) this.fixedDt = 1 / rate;
	}

	/**
	 * 初始化渲染器、场景、相机与各子管理器。
	 */
	init(
		canvas: HTMLCanvasElement | OffscreenCanvas,
		width: number,
		height: number,
		dpr: number,
		config: RuntimeConfig,
	): void {
		this.config = config;
		// 物理模拟频率（tickRate）
		if (config.physics.tickRate > 0) {
			this.fixedDt = 1 / config.physics.tickRate;
		}

		// WebGLRenderer：powerPreference 高性能
		this.renderer = new THREE.WebGLRenderer({
			canvas: canvas as HTMLCanvasElement,
			antialias: true,
			powerPreference: 'high-performance',
		});
		// 像素比限制 min(dpr, 2)
		this.renderer.setPixelRatio(Math.min(dpr, 2));
		this.renderer.setSize(width, height, false);
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.NoToneMapping;

		this.scene = new THREE.Scene();

		// PerspectiveCamera
		const aspect = width / Math.max(height, 1);
		this.camera = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 100000);
		this.camera.position.set(2000, 2000, 2000);

		// cameraController（构造时为 null，此处用真实 camera 创建）
		this._cameraController = new CameraController(this.camera, config.input);

		// 初始化子管理器
		this.lightManager.applyLights(this.scene, config);
		this.colliderDebug.init(this.scene);
		// 应用当前显示标志（showSolids/showTriggers）
		this.colliderDebug.setDebugFlags(
			config.debug.showSolids,
			config.debug.showTriggers,
		);

		this.physicsMode = config.physics.mode;
		this.lastTime = performance.now();
		this.needsRender = true;
	}

	/**
	 * 注入已加载的场景（来自 SceneBuilder）并初始化 LOD/Fog。
	 */
	setScene(
		scene: THREE.Scene,
		boundingBox: THREE.Box3,
		diagonal: number,
	): void {
		if (!this.scene) return;
		// 移除旧模型（保留灯光）
		for (let i = this.scene.children.length - 1; i >= 0; i--) {
			const child = this.scene.children[i];
			if (child.userData?.isBspModel) {
				this.scene.remove(child);
			}
		}
		// 标记 BSP 模型场景（旧模型移除依据 + 准星射线检测用）
		scene.userData.isBspModel = true;
		this.bspModelScene = scene;
		this.scene.add(scene);

		// 调整相机 near/far
		if (this.camera) {
			const size = boundingBox.getSize(new THREE.Vector3());
			const maxDim = Math.max(size.x, size.y, size.z);
			this.camera.near = Math.max(maxDim / 1000, 0.1);
			this.camera.far = maxDim * 100;
			this.camera.updateProjectionMatrix();
		}

		// LOD 注册
		if (this.config) {
			this.lodManager.setup(scene, this.config);
			if (this.pvsManager) {
				this.lodManager.assignClusterIds(this.pvsManager);
			}
		}

		// Fog 初始化（基于场景半径）
		const center = boundingBox.getCenter(new THREE.Vector3());
		const radius = diagonal / 2;
		this.fogManager.init(this.scene, radius, center);
		this.fogManager.setColor(this.config?.lighting.bgColor ?? 0x222222);

		this.needsRender = true;
	}

	/**
	 * 设置输入（由 worker 层每帧推送）。
	 *
	 * 鼠标增量直接写入 player.yaw/pitch（cs-movement 公式）：
	 *   yaw -= dx * (sensitivity * m_yaw)
	 *   pitch -= dy * (sensitivity * m_yaw)
	 *   pitch clamp ±89°
	 */
	setInput(keys: KeyState, mouseDx: number, mouseDy: number): void {
		this.keys = keys;
		if (mouseDx === 0 && mouseDy === 0) return;
		this.applyMouseDelta(mouseDx, mouseDy);
	}

	/**
	 * 应用鼠标增量到当前视角（cs-movement MouseInput.ts 公式忠实复刻）。
	 */
	private applyMouseDelta(dx: number, dy: number): void {
		const sens = this.effectiveSensitivity();
		if (this.playerController) {
			this.playerController.yaw -= dx * sens;
			this.playerController.pitch -= dy * sens;
			this.playerController.pitch = Math.max(
				-PITCH_CLAMP_DEG,
				Math.min(PITCH_CLAMP_DEG, this.playerController.pitch),
			);
		} else {
			this.noclipView.yaw -= dx * sens;
			this.noclipView.pitch -= dy * sens;
			this.noclipView.pitch = Math.max(
				-PITCH_CLAMP_DEG,
				Math.min(PITCH_CLAMP_DEG, this.noclipView.pitch),
			);
		}
	}

	/**
	 * 有效灵敏度 = sensitivity * m_yaw（cs-movement MouseInput.ts 公式）。
	 */
	private effectiveSensitivity(): number {
		if (this.playerController) {
			return (
				this.playerController.settings.sensitivity *
				this.playerController.settings.mYaw
			);
		}
		return (this.config?.input.sensitivity ?? 1.5) * M_YAW;
	}

	/** 设置 PVS 管理器。 */
	setPvsManager(pvs: PvsManager | null): void {
		this.pvsManager = pvs;
		// 幂等兜底：无论 setup/setPvsManager 先后，cluster 集合都确保赋值
		if (pvs) {
			this.lodManager.assignClusterIds(pvs);
		}
	}

	/** 设置传送点管理器（用于传送检测 + 触发碰撞箱可视化 + 准星检测）。 */
	setTeleportManager(teleport: TeleportManager | null): void {
		this.teleportManager = teleport;
		// 注入触发器列表到碰撞箱可视化 + 准星检测
		this.triggers = teleport ? [...teleport.getTriggers()] : [];
		this.colliderDebug.setTriggers(this.triggers);
		// 应用传送触发模式配置
		if (teleport && this.config) {
			teleport.setTriggerMode(this.config.debug.teleportTriggerMode);
			teleport.setGroundedFramesRequired(this.config.debug.groundedFramesRequired);
		}
	}

	/** 设置实体碰撞体列表（用于碰撞箱可视化，solids + ladders 合并数组）。 */
	setColliders(colliders: Brush[]): void {
		this.colliders = colliders;
	}

	/** 设置 solids/ladders 分开引用（用于准星射线检测区分类型）。 */
	setSolidsLadders(solids: Brush[], ladders: Brush[]): void {
		this.solids = solids;
		this.ladders = ladders;
	}

	/** 最近一次准星射线检测结果（限频刷新，可能为 null）。 */
	getPlaneInfo(): PlaneInfo | null {
		return this.lastPlaneInfo;
	}

	/**
	 * 执行一次准星射线检测（从相机正前方发射射线，与 mesh/碰撞体/触发器求交）。
	 */
	private inspectPlane(): PlaneInfo | null {
		if (!this.camera || !this.bspModelScene) return null;
		this.camera.getWorldDirection(this._fwdDir);
		return this.planeInspector.cast(
			this._camPos,
			this._fwdDir,
			this.bspModelScene,
			this.solids,
			this.ladders,
			this.triggers,
		);
	}

	/** 设置玩家控制器（physics 模式必需）。 */
	setPlayerController(player: PlayerController | null): void {
		this.playerController = player;
	}

	/**
	 * 设置物理模式。
	 */
	setPhysicsMode(mode: 'noclip' | 'physics'): void {
		if (this.physicsMode === mode) {
			this.needsRender = true;
			return;
		}
		// player 存在时同步 noclipView（保持一致，用于 player 被销毁时的回退）
		if (this.playerController) {
			this.noclipView.yaw = this.playerController.yaw;
			this.noclipView.pitch = this.playerController.pitch;
		}
		this.physicsMode = mode;
		this.needsRender = true;
	}

	/** 强制下一帧渲染（外部场景变化时调用）。 */
	requestRender(): void {
		this.needsRender = true;
	}

	/**
	 * Pointer Lock 状态变化通知。
	 * 仅重置时间戳防止大 dt；鼠标增量由主线程 MouseBuffer 的 lock-grace 过滤。
	 */
	onPointerLockChange(_locked: boolean): void {
		this.lastTime = performance.now();
	}

	/**
	 * 传送/出生后同步相机（避免跳变）。
	 */
	onTeleport(): void {
		this.moveAccumulator = 0;
		this.needsRender = true;
	}

	/**
	 * 统一设置视角（度）：同时更新 noclipView 和 player（若存在），并立即同步相机。
	 */
	setView(yawDeg: number, pitchDeg: number): void {
		this.noclipView.yaw = yawDeg;
		this.noclipView.pitch = pitchDeg;
		if (this.playerController) {
			this.playerController.yaw = yawDeg;
			this.playerController.pitch = pitchDeg;
		}
		this._cameraController?.setYawPitch(
			yawDeg * DEG2RAD,
			pitchDeg * DEG2RAD,
			true,
		);
	}

	/**
	 * 同步玩家位置到相机（physics 模式下每帧调用）。
	 */
	private syncCameraFromPlayer(): void {
		if (!this.playerController || !this.camera) return;
		const p = this.playerController;
		this.camera.position.set(
			p.origin.x,
			p.origin.y + p.eyeHeight,
			p.origin.z,
		);
	}

	/** 启动 rAF 帧循环。 */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.lastTime = performance.now();
		this.rafId = requestAnimationFrame(this.boundTick);
	}

	/** 停止 rAF 帧循环。 */
	stop(): void {
		this.running = false;
		if (this.rafId !== 0) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
	}

	/**
	 * 帧循环主体。
	 */
	private tick(now: number): void {
		if (!this.running) return;
		this.rafId = requestAnimationFrame(this.boundTick);

		if (!this.renderer || !this.scene || !this.camera || !this.config) return;
		const config = this.config;

		const dt = Math.min((now - this.lastTime) / 1000, 0.1);
		this.lastTime = now;

		let moved = false;
		let rotated = false;

		// 0. 应用 Q/E 键 yaw 旋转（turn bind）
		const yawDir = (this.keys.yawRight ? 1 : 0) - (this.keys.yawLeft ? 1 : 0);
		if (yawDir !== 0) {
			const yawDelta = yawDir * this.config.input.yawBindSpeed * dt;
			if (this.playerController) {
				this.playerController.yaw -= yawDelta;
			} else if (this.noclipView) {
				this.noclipView.yaw -= yawDelta;
			}
			rotated = true;
		}

		// 1. 同步相机旋转（从 player.yaw/pitch 或 noclipView.yaw/pitch）
		if (this.syncCameraRotation()) rotated = true;

		// 2. 物理 tick（固定步长 = 1/tickRate，最多 MAX_FIXED_STEPS 次/帧）
		this.moveAccumulator += dt;
		this.moveAccumulator = Math.min(
			this.moveAccumulator,
			this.fixedDt * MAX_FIXED_STEPS,
		);
		let didPhysicsTick = false;
		while (this.moveAccumulator >= this.fixedDt) {
			this.moveAccumulator -= this.fixedDt;
			if (this.physicsMode === 'physics' && this.playerController) {
				this.syncPlayerInput();
				this.playerController.tick(this.fixedDt);
				moved = true;
				didPhysicsTick = true;
			} else {
				// noclip 模式：自由飞行
				if (this.noclipStep(this.fixedDt)) {
					moved = true;
					didPhysicsTick = true;
				}
			}
		}
		// physics 模式：同步相机位置到玩家眼睛
		if (this.physicsMode === 'physics' && this.playerController) {
			this.syncCameraFromPlayer();
		}

		// 物理后回调：传送检测 + 周期 stats 回传（由 Worker 设置）
		if (this.onAfterPhysics) {
			this.onAfterPhysics(dt, didPhysicsTick);
		}

		// 3. LOD/PVS 更新（每帧 updateCounter++，每 updateInterval 帧判定）
		this._camPos.copy(this.camera.position);
		if (this.lodManager.itemCount > 0) {
			if (this.lodManager.update(this._camPos, config, this.pvsManager)) {
				this.needsRender = true;
			}
		}

		// 4. 雾动态调整
		this.fogManager.update(this._camPos, this.fogManager.currentSceneRadius);

		// 4.1 碰撞箱可视化更新（实体限流重建；触发每帧重建）
		if (this.colliderDebug.hasDebugWork) {
			if (this.colliderDebug.update(this._camPos, this.colliders, config)) {
				moved = true; // 强制渲染
			}
		}

		// 4.2 准星射线检测（每 PLANE_INSPECT_INTERVAL 帧一次，限流）
		//     仅 showPlaneInfo 开启时执行（Raycaster 对全部 mesh 求交有开销）
		if (this.planeInfoEnabled) {
			this.planeInspectCounter++;
			if (this.planeInspectCounter >= PLANE_INSPECT_INTERVAL) {
				this.planeInspectCounter = 0;
				this.lastPlaneInfo = this.inspectPlane();
			}
		} else if (this.lastPlaneInfo !== null) {
			this.lastPlaneInfo = null;
		}

		// 5. 渲染（needsRender 标志：空闲帧跳过）
		const shouldRender = moved || rotated || this.needsRender;
		if (shouldRender) {
			this.renderer.render(this.scene, this.camera);
			this.needsRender = false;
		}
	}

	/**
	 * 同步相机旋转从当前视角。
	 *
	 * @returns 是否发生旋转（与上一帧不同）。
	 */
	private syncCameraRotation(): boolean {
		const cc = this._cameraController;
		if (!cc) return false;
		if (this.playerController) {
			cc.setYawPitch(
				this.playerController.yaw * DEG2RAD,
				this.playerController.pitch * DEG2RAD,
				false,
			);
		} else {
			cc.setYawPitch(
				this.noclipView.yaw * DEG2RAD,
				this.noclipView.pitch * DEG2RAD,
				false,
			);
		}
		return cc.update();
	}

	/**
	 * noclip 模式单步移动（自由飞行，无碰撞）。
	 */
	private noclipStep(dt: number): boolean {
		if (!this.camera || !this.config) return false;
		const k = this.keys;
		const forward = (k.forward ? 1 : 0) - (k.backward ? 1 : 0);
		const strafe = (k.right ? 1 : 0) - (k.left ? 1 : 0);
		if (forward === 0 && strafe === 0) return false;

		this.camera.getWorldDirection(this._fwdDir);
		this._rightDir.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
		const speed =
			this.config.movement.speed *
			(k.sprint ? this.config.movement.sprintMultiplier : 1) *
			dt;
		this.camera.position.addScaledVector(this._fwdDir, forward * speed);
		this.camera.position.addScaledVector(this._rightDir, strafe * speed);
		return true;
	}

	/**
	 * 将 KeyState 映射到 PlayerController.input（cs-movement 契约）。
	 */
	private syncPlayerInput(): void {
		if (!this.playerController) return;
		const inp = this.playerController.input;
		inp.forward = this.keys.forward;
		inp.back = this.keys.backward;
		inp.left = this.keys.left;
		inp.right = this.keys.right;
		inp.jump = this.keys.jump;
		inp.duck = this.keys.duck;
		inp.walk = this.keys.sprint;
		inp.reset = this.keys.reset;
		// 滚轮连跳：wheelJump 为 true 时强制 input.jump = true（chasemod 风格）
		if (this.keys.wheelJump) {
			inp.jump = true;
		}
	}

	/**
	 * 调整渲染器和相机尺寸。
	 */
	resize(width: number, height: number): void {
		if (!this.renderer || !this.camera) return;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / Math.max(height, 1);
		this.camera.updateProjectionMatrix();
		this.needsRender = true;
	}

	/**
	 * 应用配置 patch（由 worker 层转发 config 消息）。
	 */
	applyConfigPatch(
		section: keyof RuntimeConfig,
		patch: Record<string, unknown>,
	): void {
		if (!this.config) return;
		const target = this.config[section];
		if (!target || typeof target !== 'object') return;
		Object.assign(target, patch);

		// 响应各段变化
		if (section === 'lighting') {
			this.lightManager.syncFromConfig(this.config);
			this.fogManager.setColor(this.config.lighting.bgColor);
			this.needsRender = true;
		} else if (section === 'input' && this._cameraController) {
			this._cameraController.applyInputConfig(this.config.input);
			// 同步 sensitivity 到 player.settings（cs-movement 模型）
			if (this.playerController) {
				this.playerController.settings.sensitivity =
					this.config.input.sensitivity;
			}
		} else if (section === 'physics') {
			this.setPhysicsMode(this.config.physics.mode);
		} else if (section === 'lod') {
			this.needsRender = true;
		} else if (section === 'debug') {
			// 碰撞箱可视化：实体/触发显示开关
			this.colliderDebug.setDebugFlags(
				this.config.debug.showSolids,
				this.config.debug.showTriggers,
			);
			// 准星射线检测开关
			this.planeInfoEnabled = this.config.debug.showPlaneInfo;
			if (!this.planeInfoEnabled) {
				this.lastPlaneInfo = null;
			}
			// 传送触发模式：切换 TeleportManager 的判定逻辑
			if (this.teleportManager) {
				this.teleportManager.setTriggerMode(
					this.config.debug.teleportTriggerMode,
				);
				this.teleportManager.setGroundedFramesRequired(
					this.config.debug.groundedFramesRequired,
				);
			}
			this.needsRender = true;
		}
	}

	/** 当前运行时配置（只读引用）。 */
	get currentConfig(): RuntimeConfig | null {
		return this.config;
	}

	/** 释放资源。 */
	dispose(): void {
		this.stop();
		this.lodManager.dispose();
		this.colliderDebug.dispose();
		this.lightManager.dispose();
		this.fogManager.dispose();
		if (this.renderer) {
			this.renderer.dispose();
			this.renderer = null;
		}
		this.scene = null;
		this.camera = null;
	}
}
