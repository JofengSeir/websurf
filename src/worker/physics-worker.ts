/**
 * WebSurf — Worker 物理与渲染协调器
 *
 * 职责：
 * 1. 接收主线程 `WorkerMessage` 并分发到对应处理器
 * 2. 持有 `RenderLoop`、`World`、`PlayerController`、`PvsManager`、`TeleportManager`
 * 3. 通过 `RenderLoop.onAfterPhysics` 钩子周期性：
 *    - 检测传送触发器（玩家进入 trigger_teleport 区域 → 传送）
 *    - 回传 `stats` / `cull-stats` 消息到主线程
 */

import { RenderLoop } from '../renderer/render-loop.js';
import { SceneBuilder } from '../renderer/scene-builder.js';
import { World } from '../physics/physics/World/World.js';
import { PlayerController } from '../physics/player/PlayerController.js';
import { DEFAULT_SETTINGS } from '../physics/settings/Settings.js';
import { adaptBrushes, formatAdaptStats } from '../world/collider-adapter.js';
import { loadSpawnPoints, type LoadedSpawnPoint } from '../world/spawn-loader.js';
import { PvsManager } from '../world/pvs-manager.js';
import { TeleportManager } from '../world/teleport-manager.js';
import { GameState } from '../game/game-state.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { BspProcessor } from '../../pkg/websurf_wasm.js';
import { DEFAULT_COLLIDER_FILTER } from '../world/types.js';
import type { WasmBspMetadata } from '../world/types.js';
// 物理控制面板：参数管理器（值 + 来源 + 自动恢复）
import { PhysicsParams } from '../physics/physics-params.js';
import type {
	WorkerMessage,
	MainMessage,
	InitMessage,
	LoadBspMessage,
	ConfigMessage,
	SetPhysicsModeMessage,
	SetPhysicsParamMessage,
	ResetPhysicsParamMessage,
	SetHullMessage,
	SetAutoRestoreHullMessage,
	SetCullDistanceMessage,
	TeleportMessage,
	TeleportToPosMessage,
} from './worker-types.js';

/** 周期性 stats 回传间隔（秒）。 */
const STATS_INTERVAL_SEC = 0.1; // 10 Hz

/**
 * 把两段 `WasmBrush[]` JSON 拼成单个数组。
 *
 * 走**字符串拼接**而不是 `JSON.parse` + `concat` + `stringify`：brush 数组动辄
 * 几十 MB，多一轮解析/序列化在 worker 里是实打实的卡顿。
 */
function mergeBrushJson(a: string, b: string): string {
	const left = a.trim();
	const right = b.trim();
	if (right === '' || right === '[]') return left;
	if (left === '' || left === '[]') return right;
	if (!left.endsWith(']') || !right.startsWith('[')) {
		return JSON.stringify([
			...(JSON.parse(left) as unknown[]),
			...(JSON.parse(right) as unknown[]),
		]);
	}
	return `${left.slice(0, -1)},${right.slice(1)}`;
}

/**
 * Worker 协调器。
 *
 * 生命周期：
 * 1. `init` → 创建 RenderLoop、初始化 WebGLRenderer（OffscreenCanvas）
 * 2. `load-bsp` → Worker 内 WASM 解析 BSP、导出五元组、构建 World/PlayerController/PVS/Teleport
 * 3. `input` / `config` / `resize` / `respawn` / `set-physics-mode` / `set-cull-distance` / `teleport` → 运行时控制
 */
export class PhysicsWorker {
	private readonly renderLoop = new RenderLoop();
	private readonly world = new World();
	private player: PlayerController | null = null;
	private pvs: PvsManager | null = null;
	private teleport: TeleportManager | null = null;
	private readonly game = new GameState();
	private sceneBuilder: SceneBuilder | null = null;
	/** 所有出生点（用于 spawn 索引切换）。 */
	private spawnPoints: LoadedSpawnPoint[] = [];

	/** 运行时配置（Worker 持有，主线程通过 config 消息 patch）。 */
	private config: RuntimeConfig = createConfig();

	/** Stats 回传累加器（秒）。 */
	private statsAccumulator = 0;
	/** FPS 计数（帧数 + 时间累加）。 */
	private fpsFrameCount = 0;
	private fpsAccumulator = 0;
	/** 当前 FPS（平滑后）。 */
	private currentFps = 0;

	/** 是否已加载场景（防止 init 之前误处理 input）。 */
	private sceneReady = false;

	/** 物理控制面板：参数管理器（值 + 来源 + 碰撞箱自动恢复）。 */
	private readonly physicsParams = new PhysicsParams();

	constructor() {
		// tickRate 变更 → 渲染循环物理步长（面板可调）
		this.physicsParams.onTickRateChange = (rate) => {
			this.renderLoop.setTickRate(rate);
		};

		// 注册物理后回调（游戏状态 + 传送检测 + 死亡检测 + stats 回传）
		this.renderLoop.onAfterPhysics = (dt, didPhysicsTick) => {
			if (this.sceneReady) {
				// 1. 玩家移动 → 游戏计时开始
				if (didPhysicsTick && this.player && this.config.physics.mode === 'physics') {
					const v = this.player.velocity;
					if (v.x * v.x + v.y * v.y + v.z * v.z > 1) {
						this.game.onPlayerMove();
					}
				}

				// 2. 死亡检测（Y < 阈值 → 回退到检查点）
				if (didPhysicsTick && this.player && this.config.physics.mode === 'physics') {
					const respawn = this.game.checkDeath(this.player.origin);
					if (respawn) {
						this.applyTeleport(respawn.pos, (respawn.yaw * 180) / Math.PI);
					}
				}

				// 3. 传送检测（触发时记录检查点 / 完成游戏）
				this.checkTeleport(dt);

				// 4. 碰撞箱自动恢复检测（hull 非默认 + 持续卡住 → 强制恢复）
				this.checkHullAutoRestore();
			}
			// stats + game-stats 在 emitStats 内统一限流回传
			this.emitStats(dt);
		};
	}

	/**
	 * 主消息入口（由 main.ts 的 onmessage 调用）。
	 */
	handleMessage(e: MessageEvent<WorkerMessage>): void {
		const msg = e.data;
		if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
			return;
		}
		switch (msg.type) {
			case 'init':
				this.handleInit(msg);
				break;
			case 'load-bsp':
				void this.handleLoadBsp(msg);
				break;
			case 'input':
				this.handleInput(msg);
				break;
			case 'config':
				this.handleConfig(msg);
				break;
			case 'resize':
				this.handleResize(msg);
				break;
			case 'respawn':
				this.handleRespawn();
				break;
			case 'set-physics-mode':
				this.handleSetPhysicsMode(msg);
				break;
			case 'set-physics-param':
				this.handleSetPhysicsParam(msg);
				break;
			case 'reset-physics-param':
				this.handleResetPhysicsParam(msg);
				break;
			case 'set-hull':
				this.handleSetHull(msg);
				break;
			case 'reset-hull':
				this.handleResetHull();
				break;
			case 'set-auto-restore-hull':
				this.handleSetAutoRestoreHull(msg);
				break;
			case 'set-cull-distance':
				this.handleSetCullDistance(msg);
				break;
			case 'teleport':
				this.handleTeleport(msg);
				break;
			case 'teleport-to-pos':
				this.handleTeleportToPos(msg);
				break;
			case 'get-player-pos':
				this.handleGetPlayerPos();
				break;
			default:
				// 未知消息类型：忽略（向前兼容）
				break;
		}
	}

	/** 释放所有资源（Worker 关闭时调用）。 */
	dispose(): void {
		this.renderLoop.dispose();
		this.sceneBuilder?.dispose();
		this.sceneBuilder = null;
		this.player = null;
		this.pvs = null;
		this.teleport = null;
		this.sceneReady = false;
	}

	// -------------------------------------------------------------------------
	// 消息处理器
	// -------------------------------------------------------------------------

	private handleInit(msg: InitMessage): void {
		try {
			this.renderLoop.init(
				msg.canvas,
				msg.width,
				msg.height,
				msg.dpr,
				this.config,
			);
			this.renderLoop.start();
			this.postMessage({ type: 'ready' });
		} catch (err) {
			this.postMessage({
				type: 'error',
				message: `[init] ${stringifyError(err)}`,
			});
		}
	}

	/** Worker 内解析 BSP（一次解析），导出五元组并构建场景。 */
	private async handleLoadBsp(msg: LoadBspMessage): Promise<void> {
		try {
			const bytes = new Uint8Array(msg.data);
			const stage = (s: string): void => {
				this.postMessage({ type: 'parse-progress', stage: s });
			};

			stage('WASM 解析中');
			const processor = new BspProcessor(bytes);

			stage('读取元数据');
			const meta: WasmBspMetadata = JSON.parse(processor.metadata());
			this.postMessage({ type: 'bsp-metadata', metadata: meta });

			stage('解析出生点');
			const spawnJson = processor.parse_spawn_points();
			this.postMessage({ type: 'spawn-options', spawnJson });

			stage('解析传送点');
			const teleportJson = processor.parse_teleports();
			stage('解析 PVS');
			const pvsJson = processor.parse_pvs_data();
			stage('导出碰撞体');
			const mapBrushJson = processor.export_brushes_planes(
				JSON.stringify(DEFAULT_COLLIDER_FILTER),
			);

			// PAKFILE 内嵌模型（surf 图的 ramp 坡多为 prop_static）的碰撞体。
			// 必须在 export_glb_with_pakfile_models 之前调用 —— 后者会消费 BSP。
			let brushJson = mapBrushJson;
			try {
				const modelBrushJson = processor.export_model_colliders();
				brushJson = mergeBrushJson(mapBrushJson, modelBrushJson);
			} catch (e) {
				console.warn('[load-bsp] 模型碰撞体导出失败，仅使用地图 brush:', e);
			}

			stage('导出 GLB（含 PAKFILE 模型）');
			let glbBytes: Uint8Array;
			try {
				glbBytes = processor.export_glb_with_pakfile_models();
			} catch (e) {
				console.warn('[load-bsp] PAKFILE 模型合并失败，回退纯地图导出:', e);
				glbBytes = processor.export_glb();
			}

			const glbBuffer = glbBytes.buffer.slice(
				glbBytes.byteOffset,
				glbBytes.byteOffset + glbBytes.byteLength,
			);

			await this.handleLoadScene({
				glbBytes: glbBuffer,
				brushJson,
				spawnJson,
				pvsJson,
				teleportJson,
				metadata: {
					mapName: meta.map_name,
					numFaces: meta.num_faces,
					numVertices: meta.num_vertices,
					numBrushes: meta.num_brushes,
					numModels: meta.num_models,
				},
			});
		} catch (err) {
			this.postMessage({
				type: 'error',
				message: `[load-bsp] ${stringifyError(err)}`,
			});
		}
	}

	private async handleLoadScene(payload: {
		glbBytes: ArrayBuffer;
		brushJson: string;
		spawnJson: string;
		pvsJson: string;
		teleportJson: string;
		metadata: { mapName: string; numFaces: number; numVertices: number; numBrushes: number; numModels: number };
	}): Promise<void> {
		try {
			// 1. 解析 GLB → Three.js Scene
			this.sceneBuilder = new SceneBuilder();
			const buildResult = await this.sceneBuilder.build(
				new Uint8Array(payload.glbBytes),
				this.config,
			);

			// 2. 转换碰撞体（WASM JSON → cs-movement Brush[]）
			const adaptResult = adaptBrushes(payload.brushJson);
			this.world.solids = adaptResult.solids;
			this.world.ladders = adaptResult.ladders;
			// 实体碰撞箱可视化使用 solids + ladders 合并数组
			this.renderLoop.setColliders([
				...adaptResult.solids,
				...adaptResult.ladders,
			]);
			// 准星射线检测需要分开的 solids/ladders 引用（区分 brushType）
			this.renderLoop.setSolidsLadders(adaptResult.solids, adaptResult.ladders);
			console.log(formatAdaptStats(adaptResult.stats));

			// 3. 出生点
			const spawnResult = loadSpawnPoints(payload.spawnJson);
			this.spawnPoints = spawnResult.allSpawnPoints;

			// 4. PVS
			this.pvs = new PvsManager(payload.pvsJson);
			this.renderLoop.setPvsManager(this.pvs);

			// 5. 传送点
			this.teleport = new TeleportManager(payload.teleportJson);
			this.renderLoop.setTeleportManager(this.teleport);

			// 6. 玩家控制器（默认 settings：参考 cs-movement DEFAULT_SETTINGS）
			const settings = structuredClone(DEFAULT_SETTINGS);
			this.player = new PlayerController(this.world, settings, spawnResult.spawn, {
				log: (m: string) => console.log(`[PlayerController] ${m}`),
			});
			this.renderLoop.setPlayerController(this.player);
			// 物理控制面板：绑定参数管理器（应用既有覆盖 + 碰撞箱体型）
			this.physicsParams.attach(this.player, settings);
			void this.emitPhysicsSnapshot();

			// 7. 注入场景到渲染循环（会触发 LOD/Fog 初始化）
			this.renderLoop.setScene(
				buildResult.scene,
				buildResult.boundingBox,
				buildResult.diagonal,
			);

			// 同步 cullDistance 到配置（lod-manager.setup 已根据对角线计算默认值）
			this.config.lod.cullDistance = this.renderLoop.lodManager.cullDistance;

			// 初始化游戏状态：死亡阈值 + 初始 spawn
			this.game.reset();
			this.game.setDeathThreshold(buildResult.boundingBox.min.y);
			this.game.setInitialSpawn(
				{ x: spawnResult.spawn.x, y: spawnResult.spawn.y, z: spawnResult.spawn.z },
				(spawnResult.yaw * Math.PI) / 180,
			);

			// 同步视角到出生点
			this.renderLoop.setView(spawnResult.yaw, 0);
			const cc = this.renderLoop.cameraController;
			if (cc) {
				cc.setPosition(
					spawnResult.spawn.x,
					spawnResult.spawn.y + this.player.eyeHeight,
					spawnResult.spawn.z,
				);
			}

			this.sceneReady = true;
			this.renderLoop.requestRender();

			this.postMessage({
				type: 'scene-ready',
				glbSizeKb: Math.round(payload.glbBytes.byteLength / 1024),
				numBrushes: adaptResult.stats.solids + adaptResult.stats.ladders,
				numSpawnPoints: spawnResult.allSpawnPoints.length,
				hasPvs: this.pvs.enabled,
				diagonal: this.renderLoop.lodManager.sceneDiagonal,
				defaultCull: this.config.lod.cullDistance,
				maxCull: this.renderLoop.lodManager.maxCullDistance,
			});
		} catch (err) {
			this.postMessage({
				type: 'error',
				message: `[load-scene] ${stringifyError(err)}`,
			});
		}
	}

	private handleInput(msg: Extract<WorkerMessage, { type: 'input' }>): void {
		if (!this.sceneReady) return;
		this.renderLoop.setInput(msg.keys, msg.mouseDx, msg.mouseDy);
	}

	private handleConfig(msg: ConfigMessage): void {
		// patch 到本地 config 副本 + 转发到 renderLoop
		applyConfigPatch(this.config, msg.section, msg.patch);
		this.renderLoop.applyConfigPatch(msg.section, msg.patch);
	}

	private handleResize(msg: Extract<WorkerMessage, { type: 'resize' }>): void {
		this.renderLoop.resize(msg.width, msg.height);
	}

	private handleRespawn(): void {
		if (!this.player) return;
		// 游戏模式：回退到最后检查点（若存在）
		const cp = this.game.getRespawnPos();
		if (cp) {
			this.applyTeleport(cp.pos, (cp.yaw * 180) / Math.PI);
		} else {
			this.player.respawn();
			// 同步视角（player.respawn 不重置 yaw/pitch，保持当前朝向）
			this.renderLoop.setView(this.player.yaw, this.player.pitch);
			const cc = this.renderLoop.cameraController;
			if (cc) {
				cc.setPosition(
					this.player.origin.x,
					this.player.origin.y + this.player.eyeHeight,
					this.player.origin.z,
				);
			}
			this.teleport?.resetCooldown();
			this.renderLoop.onTeleport();
		}
	}

	private handleSetPhysicsMode(msg: SetPhysicsModeMessage): void {
		// 同步 config.physics.mode（handleConfig 不再处理 mode 切换）
		this.config.physics.mode = msg.mode;
		this.renderLoop.setPhysicsMode(msg.mode);
		if (msg.mode === 'physics' && this.player) {
			this.player.velocity.x = 0;
			this.player.velocity.y = 0;
			this.player.velocity.z = 0;
			this.player.onGround = false;
			// 从当前相机位置对齐玩家 origin
			const cc = this.renderLoop.cameraController;
			if (cc) {
				const p = cc.camera.position;
				this.player.origin.x = p.x;
				this.player.origin.y = p.y - this.player.eyeHeight;
				this.player.origin.z = p.z;
			}
		}
	}

	private handleSetCullDistance(msg: SetCullDistanceMessage): void {
		this.renderLoop.lodManager.setCullDistance(msg.value);
		this.config.lod.cullDistance = this.renderLoop.lodManager.cullDistance;
		this.renderLoop.requestRender();
	}

	// -------------------------------------------------------------------------
	// 物理控制面板
	// -------------------------------------------------------------------------

	/** 设置物理参数（面板 → 参数管理器 → settings/runtime 立即生效）。 */
	private handleSetPhysicsParam(msg: SetPhysicsParamMessage): void {
		this.physicsParams.setParam(msg.name, msg.value);
		this.emitPhysicsSnapshot();
	}

	/** 恢复物理参数（缺省 = 全部）。 */
	private handleResetPhysicsParam(msg: ResetPhysicsParamMessage): void {
		this.physicsParams.resetParam(msg.name);
		this.emitPhysicsSnapshot();
	}

	/** 设置碰撞箱体型（立即生效）。 */
	private handleSetHull(msg: SetHullMessage): void {
		this.physicsParams.setHull({
			halfWidth: msg.hull.halfWidth,
			standHeight: msg.hull.standHeight,
			duckHeight: msg.hull.duckHeight,
		});
		this.emitPhysicsSnapshot();
	}

	/** 恢复默认碰撞箱。 */
	private handleResetHull(): void {
		this.physicsParams.resetHull();
		this.emitPhysicsSnapshot();
	}

	/** 碰撞箱自动恢复开关。 */
	private handleSetAutoRestoreHull(msg: SetAutoRestoreHullMessage): void {
		this.physicsParams.autoRestoreHull = msg.enabled;
		this.emitPhysicsSnapshot();
	}

	/** 回传物理参数快照（面板渲染；参数/碰撞箱变更后调用）。 */
	private emitPhysicsSnapshot(): void {
		const snapshot = this.physicsParams.snapshot();
		const hullState = this.physicsParams.getHullState();
		this.postMessage({
			type: 'physics-snapshot',
			params: snapshot.map((p) => ({ name: p.name, value: p.value, source: p.source })),
			hull: {
				halfWidth: hullState.hull.halfWidth,
				standHeight: hullState.hull.standHeight,
				duckHeight: hullState.hull.duckHeight,
				source: hullState.source,
				isDefault: hullState.isDefault,
			},
			autoRestoreHull: this.physicsParams.autoRestoreHull,
		});
	}

	/**
	 * 碰撞箱自动恢复检测（每帧调用）：
	 * hull 非默认 + 持续卡住（stuckTicks ≥ 48）→ 强制恢复默认体型并通知主线程。
	 */
	private checkHullAutoRestore(): void {
		if (this.physicsParams.checkAutoRestore()) {
			this.postMessage({
				type: 'physics-event',
				event: 'hull-auto-restored',
				message:
					'检测到碰撞箱非默认且玩家持续卡住，已自动恢复默认体积（32×32×72/54）。',
			});
			this.emitPhysicsSnapshot();
		}
	}

	private handleTeleport(msg: TeleportMessage): void {
		// `target` 是 spawn 索引（来自 UI 下拉选择）。切换到该出生点。
		if (!this.player) return;
		const sp = this.spawnPoints[msg.target];
		if (!sp) return;
		this.applyTeleport(sp.origin, sp.yaw);
	}

	/**
	 * 传送到任意自定义坐标（自定义传送点面板）。
	 * yaw 缺省 = 保持当前朝向（仅传送位置，不改变视角方向）。
	 */
	private handleTeleportToPos(msg: TeleportToPosMessage): void {
		if (!this.player) return;
		const yaw = msg.yaw !== undefined ? msg.yaw : this.player.yaw;
		this.applyTeleport(
			{ x: msg.pos[0], y: msg.pos[1], z: msg.pos[2] },
			yaw,
		);
	}

	/** 回传玩家当前位置（自定义传送点「保存当前位置」用）。 */
	private handleGetPlayerPos(): void {
		const cc = this.renderLoop.cameraController;
		// noclip 模式下相机自由飞行，player.origin 不随移动更新；
		// 故以相机位置（减去眼睛高度）作为真实玩家位置，yaw/pitch 取当前视角。
		if (this.config.physics.mode === 'noclip') {
			if (!cc) return;
			const p = cc.camera.position;
			const eyeHeight = this.player?.eyeHeight ?? 0;
			this.postMessage({
				type: 'player-pos',
				pos: [p.x, p.y - eyeHeight, p.z],
				yaw: this.player?.yaw ?? 0,
				pitch: this.player?.pitch ?? 0,
			});
			return;
		}
		if (!this.player) return;
		this.postMessage({
			type: 'player-pos',
			pos: [
				this.player.origin.x,
				this.player.origin.y,
				this.player.origin.z,
			],
			yaw: this.player.yaw,
			pitch: this.player.pitch,
		});
	}

	/**
	 * 应用传送：设置玩家位置 + yaw + 清零速度。
	 * 保留当前 pitch（玩家的俯仰角不应因传送而重置）。
	 */
	private applyTeleport(
		origin: { x: number; y: number; z: number },
		yawDeg: number,
	): void {
		if (!this.player) return;
		this.player.origin.x = origin.x;
		this.player.origin.y = origin.y;
		this.player.origin.z = origin.z;
		this.player.velocity.x = 0;
		this.player.velocity.y = 0;
		this.player.velocity.z = 0;
		this.player.onGround = false;
		// noclip 模式：相机才是位置权威源；仅改 player.origin 而不同步相机会导致
		// 传送「只改朝向、位置不动」的假象，必须显式移动相机。
		if (this.config.physics.mode === 'noclip') {
			const cc = this.renderLoop.cameraController;
			if (cc) {
				cc.camera.position.set(
					origin.x,
					origin.y + this.player.eyeHeight,
					origin.z,
				);
			}
		}
		// 保留当前 pitch，仅设置 yaw（传送改变朝向，不改变俯仰角）
		this.renderLoop.setView(yawDeg, this.player.pitch);
		this.teleport?.resetCooldown();
		this.renderLoop.onTeleport();
	}

	// -------------------------------------------------------------------------
	// 周期性回调（由 RenderLoop.onAfterPhysics 调用）
	// -------------------------------------------------------------------------

	/** 检测传送触发器，触发时执行传送。 */
	private checkTeleport(dt: number): void {
		if (!this.teleport || !this.player) return;
		// 仅在 physics 模式下检测（noclip 模式不应触发传送）
		if (this.config.physics.mode !== 'physics') return;
		// 传递玩家着地状态，用于 start-touch-grounded 模式判定
		const dest = this.teleport.checkTeleport(this.player.origin, dt, this.player.onGround);
		if (dest) {
			// 游戏状态：记录检查点 / 检测完成
			this.game.onTeleport(dest);
			// 应用传送（传送到 dest 位置，使用转换后的 cs-movement yaw）
			this.applyTeleport(dest.origin, dest.yaw);
			// 传送后清理 inside 状态，避免 target trigger 内立即误触发
			this.teleport.onTeleported();
		}
	}

	/** 周期性回传 stats 与 cull-stats 到主线程（10Hz）。 */
	private emitStats(dt: number): void {
		// FPS 计算（指数平滑，始终运行以保证需要时立即可用）
		this.fpsFrameCount++;
		this.fpsAccumulator += dt;
		if (this.fpsAccumulator >= 0.5) {
			// 0.5 秒更新一次 FPS（避免抖动）
			this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumulator);
			this.fpsFrameCount = 0;
			this.fpsAccumulator = 0;
		}

		// HUD 不可见时跳过全部 stats/cull-stats/game-stats 发送（减少性能浪费）
		if (!this.config.hud.visible) {
			this.statsAccumulator = 0;
			return;
		}

		// 10Hz 回传 stats
		this.statsAccumulator += dt;
		if (this.statsAccumulator < STATS_INTERVAL_SEC) {
			return;
		}
		this.statsAccumulator = 0;

		const player = this.player;
		const pvs = this.pvs;
		const lod = this.renderLoop.lodManager;
		const cc = this.renderLoop.cameraController;
		// 准星射线检测结果（限频刷新，由 render-loop 维护）
		const planeInfo = this.renderLoop.getPlaneInfo();

		// noclip 模式下玩家通过相机自由飞行，player.origin 不随移动更新；
		// 故 noclip 直接回传相机位置（实时）。physics 模式回传 player.origin（每帧更新）。
		const inNoclip = this.config.physics.mode === 'noclip';
		if (player && !inNoclip) {
			// physics 模式：player.origin 每帧更新，坐标真实
			this.postMessage({
				type: 'stats',
				fps: this.currentFps,
				pos: [player.origin.x, player.origin.y, player.origin.z],
				vel: [player.velocity.x, player.velocity.y, player.velocity.z],
				onGround: player.onGround,
				cluster: pvs?.currentClusterId ?? -1,
				speed: player.horizontalSpeed,
				planeInfo,
			});
		} else if (cc) {
			// noclip 模式（player 仍存在但 origin 不更新）或 init 阶段无 player：回传相机位置
			const p = cc.camera.position;
			this.postMessage({
				type: 'stats',
				fps: this.currentFps,
				pos: [p.x, p.y, p.z],
				vel: [0, 0, 0],
				onGround: false,
				cluster: pvs?.currentClusterId ?? -1,
				speed: 0,
				planeInfo,
			});
		}

		// cull-stats（仅在 LOD 已注册时）
		if (lod.itemCount > 0) {
			const lodStats = lod.getStats();
			const pvsStats = pvs?.getStats();
			this.postMessage({
				type: 'cull-stats',
				visible: lodStats.visible,
				total: lodStats.total,
				cullDist: lodStats.cullDistance,
				pvs: {
					cluster: pvsStats?.currentCluster ?? -1,
					visibleClusters: pvsStats?.visibleCount ?? 0,
					totalClusters: pvsStats?.totalClusters ?? 0,
					pvsHidden: lodStats.pvsHidden,
					near: lodStats.near,
					far: lodStats.far,
				},
			});
		}

		// game-stats（与 stats 同频回传）
		this.emitGameStats();
	}

	/** 周期性回传游戏状态（与 stats 同频，10Hz）。 */
	private emitGameStats(): void {
		const snap = this.game.getSnapshot();
		this.postMessage({
			type: 'game-stats',
			phase: snap.phase,
			elapsedMs: snap.elapsedMs,
			checkpointCount: snap.checkpointCount,
			lastCheckpointName: snap.lastCheckpointName,
			finishTimeMs: snap.finishTimeMs,
			deaths: snap.deaths,
			justDied: this.game.consumeJustDied(),
		});
	}

	// -------------------------------------------------------------------------
	// 工具
	// -------------------------------------------------------------------------

	/** 发送消息到主线程。 */
	private postMessage(msg: MainMessage): void {
		// 在 Worker 上下文中，postMessage 是全局函数
		(postMessage as (msg: MainMessage) => void)(msg);
	}
}

// -------------------------------------------------------------------------
// 工具函数
// -------------------------------------------------------------------------

/** 将 Error/unknown 转换为字符串（保留 stack 用于诊断）。 */
function stringifyError(err: unknown): string {
	if (err instanceof Error) {
		return err.stack ?? `${err.name}: ${err.message}`;
	}
	return String(err);
}
