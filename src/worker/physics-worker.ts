/**
 * WebSurf — Worker 物理协调器（渲染已搬回主线程）
 *
 * 对应重构时序图阶段二（Worker 隔离区）：
 * 1. 接收主线程 `WorkerMessage` 并分发（`frame` 信号驱动物理循环）
 * 2. 持有 `PhysicsLoop`、`World`、`PlayerController`、`TeleportManager`、`GameState`
 * 3. BSP 解析（WASM）后把场景数据（GLB + 碰撞体/PVS/出生点/传送点 JSON）一次性
 *    transfer 给主线程——渲染由主线程 RendererMain 承担（GLTFLoader/LOD/PVS/准星）
 * 4. 物理结果写共享内存输出区（Atomics 锁 + seq），主线程安全检查 + LERP 后渲染
 */

import { PhysicsLoop } from './physics-loop.js';
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
import {
  SharedState,
  keysToMask,
  type InputSample,
} from './shared-state.js';
import type {
  WorkerMessage,
  MainMessage,
  InitMessage,
  LoadBspMessage,
  ConfigMessage,
  FrameSignalMessage,
  SetPhysicsModeMessage,
  SetPhysicsParamMessage,
  ResetPhysicsParamMessage,
  SetHullMessage,
  SetAutoRestoreHullMessage,
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
 * Worker 物理协调器。
 *
 * 生命周期：
 * 1. `init` → 创建共享状态通道（SharedArrayBuffer 或回退）+ PhysicsLoop
 * 2. `load-bsp` → Worker 内 WASM 解析 BSP → 场景数据 transfer 主线程 + 构建物理
 * 3. `frame` → 物理循环（固定步长 + 写共享输出）
 * 4. `config` / `respawn` / `set-physics-mode` / `teleport` / 物理面板 → 运行时控制
 */
export class PhysicsWorker {
	private readonly physicsLoop: PhysicsLoop;
	private readonly world = new World();
	private player: PlayerController | null = null;
	private pvs: PvsManager | null = null;
	private teleport: TeleportManager | null = null;
	private readonly game = new GameState();
	/** 所有出生点（用于 spawn 索引切换）。 */
	private spawnPoints: LoadedSpawnPoint[] = [];

	/** 运行时配置（Worker 持有，主线程通过 config 消息 patch）。 */
	private config: RuntimeConfig = createConfig();

	/** 跨线程状态通道（共享内存 / 回退）。 */
	private shared: SharedState;

	/** Stats 回传累加器（秒）。 */
	private statsAccumulator = 0;
	/** FPS 计数（帧数 + 时间累加）。 */
	private fpsFrameCount = 0;
	private fpsAccumulator = 0;
	/** 当前 FPS（平滑后）。 */
	private currentFps = 0;

	/** 是否已加载场景（防止 init 之前误处理 frame 信号）。 */
	private sceneReady = false;

	/** 物理控制面板：参数管理器（值 + 来源 + 碰撞箱自动恢复）。 */
	private readonly physicsParams = new PhysicsParams();

	constructor(shared: SharedState) {
		this.shared = shared;
		this.physicsLoop = new PhysicsLoop(this.config, shared);

		// tickRate 变更 → 物理循环步长（面板可调）
		this.physicsParams.onTickRateChange = (rate) => {
			this.physicsLoop.setTickRate(rate);
		};

		// 注册物理后回调（游戏状态 + 传送检测 + 死亡检测 + stats 回传）
		this.physicsLoop.onAfterPhysics = (dt, didPhysicsTick) => {
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
			case 'frame':
				this.handleFrame(msg);
				break;
			case 'input':
				// 仅回退模式（MsgStateWorker）：输入经消息注入
				this.handleInput(msg);
				break;
			case 'config':
				this.handleConfig(msg);
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
			case 'teleport':
				this.handleTeleport(msg);
				break;
			case 'teleport-to-pos':
				this.handleTeleportToPos(msg);
				break;
			case 'get-player-pos':
				this.handleGetPlayerPos();
				break;
			case 'set-death-threshold':
				this.game.setDeathThreshold(msg.value);
				break;
			default:
				// 未知消息类型：忽略（向前兼容）
				break;
		}
	}

	/** 释放所有资源（Worker 关闭时调用）。 */
	dispose(): void {
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
			// init 已在构造器传入 shared（main.ts 创建 PhysicsWorker 时注入）；
			// 此处仅做一致性校验并上报 ready。
			if (this.shared.isShared !== !!msg.shared) {
				console.warn(
					`[worker] shared 模式不一致（构造=${this.shared.isShared}, 消息=${!!msg.shared}），以构造为准`,
				);
			}
			this.postMessage({ type: 'ready' });
		} catch (err) {
			this.postMessage({
				type: 'error',
				message: `[init] ${stringifyError(err)}`,
			});
		}
	}

	/** Worker 内解析 BSP（一次解析），导出场景数据传主线程 + 构建物理。 */
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

			// 1. 构建物理（World/PlayerController/PVS/Teleport/GameState）
			const adaptResult = adaptBrushes(brushJson);
			this.world.solids = adaptResult.solids;
			this.world.ladders = adaptResult.ladders;
			console.log(formatAdaptStats(adaptResult.stats));

			const spawnResult = loadSpawnPoints(spawnJson);
			this.spawnPoints = spawnResult.allSpawnPoints;

			this.pvs = new PvsManager(pvsJson);
			this.teleport = new TeleportManager(teleportJson);

			const settings = structuredClone(DEFAULT_SETTINGS);
			this.player = new PlayerController(this.world, settings, spawnResult.spawn, {
				log: (m: string) => console.log(`[PlayerController] ${m}`),
			});
			this.physicsLoop.setPlayerController(this.player);
			this.physicsParams.attach(this.player, settings);
			void this.emitPhysicsSnapshot();

			// 游戏状态：初始 spawn（死亡阈值由主线程场景加载后回传）
			this.game.reset();
			this.game.setInitialSpawn(
				{ x: spawnResult.spawn.x, y: spawnResult.spawn.y, z: spawnResult.spawn.z },
				(spawnResult.yaw * Math.PI) / 180,
			);

			// 同步视角到出生点 + 写首帧共享输出（noclip 位置也初始化为出生点）
			this.physicsLoop.setNoclipPos({
				x: spawnResult.spawn.x,
				y: spawnResult.spawn.y,
				z: spawnResult.spawn.z,
			});
			this.physicsLoop.setView(spawnResult.yaw, 0);
			this.sceneReady = true;

			// 2. 场景数据一次性 transfer 主线程（渲染由主线程承担）
			const sceneData = {
				type: 'scene-data' as const,
				glb: glbBuffer,
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
				spawn: {
					x: spawnResult.spawn.x,
					y: spawnResult.spawn.y,
					z: spawnResult.spawn.z,
					yawDeg: spawnResult.yaw,
				},
				// 场景对角线/剔除范围由主线程 GLTFLoader 后计算并校准
				diagonal: 0,
				maxCull: 100000,
				defaultCull: this.config.lod.cullDistance,
				glbSizeKb: Math.round(glbBuffer.byteLength / 1024),
				numSpawnPoints: spawnResult.allSpawnPoints.length,
				hasPvs: this.pvs.enabled,
				deathThresholdY: 0,
			};
			this.postMessage(sceneData, [glbBuffer]);
		} catch (err) {
			this.postMessage({
				type: 'error',
				message: `[load-bsp] ${stringifyError(err)}`,
			});
		}
	}

	/** frame 信号：驱动物理循环（阶段二）。 */
	private handleFrame(msg: FrameSignalMessage): void {
		if (!this.sceneReady) return;
		this.physicsLoop.frame(msg.t);
	}

	/** input 消息（仅回退模式）：注入输入样本。 */
	private handleInput(msg: Extract<WorkerMessage, { type: 'input' }>): void {
		if (!this.sceneReady) return;
		const sample: InputSample = {
			dx: msg.mouseDx,
			dy: msg.mouseDy,
			keysMask: keysToMask(msg.keys),
		};
		if ('setPendingInput' in this.shared) {
			(this.shared as { setPendingInput(s: InputSample): void }).setPendingInput(sample);
		}
	}

	private handleConfig(msg: ConfigMessage): void {
		// patch 到本地 config 副本 + 转发到物理循环
		applyConfigPatch(this.config, msg.section, msg.patch);
		this.physicsLoop.applyConfigPatch(msg.section, msg.patch);
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
			this.physicsLoop.setView(this.player.yaw, this.player.pitch);
			// noclip 模式：位置权威源同步到重生后的 player.origin
			if (this.config.physics.mode === 'noclip') {
				this.physicsLoop.setNoclipPos({ ...this.player.origin });
			}
			this.teleport?.resetCooldown();
			this.physicsLoop.onTeleport();
		}
	}

	private handleSetPhysicsMode(msg: SetPhysicsModeMessage): void {
		// 同步 config.physics.mode；PhysicsLoop.setPhysicsMode 内完成
		// player ↔ noclipView 的双向位置/视角继承（noclip 移动后切回 physics 不丢位置）。
		this.config.physics.mode = msg.mode;
		this.physicsLoop.setPhysicsMode(msg.mode);
		if (msg.mode === 'physics' && this.player) {
			// 切回物理模式：清零速度/着地，从 noclip 位置重新开始
			this.player.velocity.x = 0;
			this.player.velocity.y = 0;
			this.player.velocity.z = 0;
			this.player.onGround = false;
			this.physicsLoop.writeFrame();
		}
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
		// 位置权威源：physics 模式 = player.origin；noclip 模式 = noclipView.pos
		if (this.config.physics.mode === 'noclip') {
			const np = this.physicsLoop.getNoclipState();
			this.postMessage({
				type: 'player-pos',
				pos: [np.pos.x, np.pos.y, np.pos.z],
				yaw: np.yaw,
				pitch: np.pitch,
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
		// noclip 模式：noclipView 才是位置权威源；同步之（渲染读取共享输出）
		if (this.config.physics.mode === 'noclip') {
			this.physicsLoop.setNoclipPos(origin);
		}
		// 保留当前 pitch，仅设置 yaw（传送改变朝向，不改变俯仰角）
		this.physicsLoop.setView(yawDeg, this.player.pitch);
		this.teleport?.resetCooldown();
		this.physicsLoop.onTeleport();
	}

	// -------------------------------------------------------------------------
	// 周期性回调（由 PhysicsLoop.onAfterPhysics 调用）
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

	/** 周期性回传 stats 与 game-stats 到主线程（10Hz）。 */
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

		// HUD 不可见时跳过全部 stats/game-stats 发送（减少性能浪费）
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
		// 位置权威源：physics = player.origin；noclip = noclipView.pos
		const inNoclip = this.config.physics.mode === 'noclip';
		if (player && !inNoclip) {
			this.postMessage({
				type: 'stats',
				fps: this.currentFps,
				pos: [player.origin.x, player.origin.y, player.origin.z],
				vel: [player.velocity.x, player.velocity.y, player.velocity.z],
				onGround: player.onGround,
				cluster: this.pvs?.currentClusterId ?? -1,
				speed: player.horizontalSpeed,
			});
		} else {
			const np = this.physicsLoop.getNoclipState();
			this.postMessage({
				type: 'stats',
				fps: this.currentFps,
				pos: [np.pos.x, np.pos.y, np.pos.z],
				vel: [0, 0, 0],
				onGround: false,
				cluster: this.pvs?.currentClusterId ?? -1,
				speed: 0,
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

	/** 发送消息到主线程。可选 transfer list（ArrayBuffer 零拷贝）。 */
	private postMessage(msg: MainMessage, transfer?: Transferable[]): void {
		// 在 Worker 上下文中，postMessage 是全局函数
		const pm = postMessage as (m: MainMessage, t?: Transferable[]) => void;
		if (transfer && transfer.length > 0) {
			pm(msg, transfer);
		} else {
			pm(msg);
		}
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
