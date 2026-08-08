/**
 * WebSurf — Worker 物理协调器（渲染已搬回主线程，物理已迁移到共享 Rust 物理）
 *
 * 1. 接收并分发主线程 `WorkerMessage`（`frame` 信号驱动物理循环）
 * 2. 持有 `PhysicsLoop`、`PhysWorld`（websurf-phys）、`PvsManager`、`GameState`
 * 3. BSP 解析（WASM）后，场景数据（GLB + 碰撞体/PVS/出生点/传送点 JSON）一次性
 *    transfer 给主线程——渲染由主线程 RendererMain 承担（GLTFLoader/LOD/PVS/准星）
 * 4. 物理结果写共享内存输出区（Atomics 锁 + seq），主线程安全检查 + LERP 后渲染
 *
 * 物理语义（Rust websurf-phys）：
 * - build_world(brushJson, triJson, teleportJson, spawn) 直接构建世界
 * - tick 内部完成移动/碰撞/传送检测/死亡重生；经 take_event 回传传送/死亡事件
 *   （计时挑战检查点/死亡统计消费）
 * - 传送触发 = Rust StartTouch 边沿 + 落地脚底 OR 语义（teleport_gate_ticks 参数）
 * - 灵敏度在 TS 输入层乘入（sensitivity 固定 1），Q/E 转等效像素并入鼠标通道
 */

import { PhysicsLoop } from './physics-loop.js';
import { loadSpawnPoints } from '../world/spawn-loader.js';
import { PvsManager } from '../world/pvs-manager.js';
import { GameState } from '../game/game-state.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { BspProcessor, PhysWorld, decompress_mtz } from '../../pkg/websurf_wasm.js';
import { DEFAULT_COLLIDER_FILTER } from '../world/types.js';
import type { WasmBspMetadata } from '../world/types.js';
// 物理控制面板：参数管理器（值 + 来源）
import { PhysicsParams } from '../physics/physics-params.js';
import {
  SharedState,
  keysToMask,
  type InputSample,
} from './shared-state.js';
import { getMtzB64 } from './mtz-data.js';
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
 * 用字符串拼接而非 parse/concat/stringify：brush 动辄几十 MB，多一轮解析/序列化在 Worker 里卡顿。
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
 * 2. `load-bsp` → Worker 内 WASM 解析 BSP → 场景数据 transfer 主线程 + Rust 物理世界构建
 * 3. `frame` → 物理循环（固定步长 + 写共享输出）
 * 4. `config` / `respawn` / `set-physics-mode` / `teleport` / 物理面板 → 运行时控制
 */
export class PhysicsWorker {
	private readonly physicsLoop: PhysicsLoop;
	private phys: PhysWorld | null = null;
	private pvs: PvsManager | null = null;
	private readonly game = new GameState();

	/** 运行时配置（Worker 持有，主线程通过 config 消息 patch）。 */
	private config: RuntimeConfig = createConfig();

	/** 跨线程状态通道（共享内存 / 回退）。 */
	private shared: SharedState;

	/** Stats 回传累加器（秒）。 */
	private statsAccumulator = 0;
	/** FPS 计数（帧数 + 墙钟窗口；物理 dt 含 Worker 延迟会虚低）。 */
	private fpsFrameCount = 0;
	private fpsWallStart = 0;
	/** 当前 FPS（frame 信号处理频率，0.5s 墙钟窗口）。 */
	private currentFps = 0;

	/** 是否已加载场景（防止 init 之前误处理 frame 信号）。 */
	private sceneReady = false;

	/** 物理控制面板：参数管理器（值 + 来源）。 */
	private readonly physicsParams = new PhysicsParams();

	constructor(shared: SharedState) {
		this.shared = shared;
		this.physicsLoop = new PhysicsLoop(this.config, shared);

		// tickRate 变更 → 物理循环步长（面板可调）
		this.physicsParams.onTickRateChange = (rate) => {
			this.physicsLoop.setTickRate(rate);
		};

		// 注册物理后回调（游戏状态 + 物理事件消费 + stats 回传）
		this.physicsLoop.onAfterPhysics = (dt, didPhysicsTick) => {
			if (this.sceneReady) {
				const inPhysics = this.config.physics.mode === 'physics';
				if (didPhysicsTick && inPhysics && this.phys) {
					// 1. 玩家移动 → 游戏计时开始
					const s = this.phys.state();
					const v = [s.velX, s.velY, s.velZ];
					if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 1) {
						this.game.onPlayerMove();
					}
					// 2. Rust 物理事件（传送/死亡）→ 计时挑战状态机
					this.consumePhysEvents();
				}
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
				this.handleSetDeathThreshold(msg.value);
				break;
			default:
				// 未知消息类型：忽略（向前兼容）
				break;
		}
	}

	/** 释放所有资源（Worker 关闭时调用）。 */
	dispose(): void {
		this.phys = null;
		this.pvs = null;
		this.physicsLoop.setPhysWorld(null);
		this.sceneReady = false;
	}

	// -------------------------------------------------------------------------
	// 消息处理器
	// -------------------------------------------------------------------------

	private handleInit(msg: InitMessage): void {
		try {
			// init 已通过构造器传入 shared；此处仅一致性校验并上报 ready。
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

	/** Worker 内解析 BSP（一次解析），导出场景数据传主线程 + 构建 Rust 物理世界。 */
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

			// 模型碰撞体：按「碰撞来源」选项选择 ——
			//   visual → 可视网格原样三角形（零转化，与显示逐位一致）
			//   auto / phy → 模型自带物理碰撞体(.phy 凸包，引擎实际碰撞)；auto 在
			//                无 .phy/空结果时回退可视网格
			// 任一路径失败回退旧薄壳 brush 方案。
			let brushJson = mapBrushJson;
			let triJsonRaw: string | undefined;
			const colliderSource = this.config.physics.colliderSource ?? 'auto';
			try {
				if (colliderSource === 'visual') {
					triJsonRaw = processor.export_model_tri_colliders();
				} else {
					triJsonRaw = processor.export_model_phy_colliders();
					if (
						colliderSource === 'auto' &&
						(!triJsonRaw ||
							(JSON.parse(triJsonRaw) as unknown[]).length === 0)
					) {
						triJsonRaw = processor.export_model_tri_colliders();
					}
				}
				console.log(
					`[load-bsp] 模型三角形碰撞网格(${colliderSource}): ${JSON.parse(triJsonRaw).length} 个实例`,
				);
			} catch (e) {
				console.warn('[load-bsp] 模型碰撞导出失败，回退薄壳 brush:', e);
				try {
					const modelBrushJson = processor.export_model_colliders();
					brushJson = mergeBrushJson(mapBrushJson, modelBrushJson);
				} catch (e2) {
					console.warn('[load-bsp] 模型碰撞体导出失败，仅使用地图 brush:', e2);
				}
			}

			stage('导出 GLB（含 PAKFILE 模型）');
			// 纹理画质 manifest + 缺失纹理必须在 export_glb*（消费 BSP）之前生成
			let mosaicManifest: string | undefined;
			let missingTextures: string[] | undefined;
			try {
				mosaicManifest = processor.export_mosaic_manifest();
				missingTextures = JSON.parse(processor.export_missing_textures()) as string[];
			} catch (e) {
				console.warn('[load-bsp] mosaic manifest 生成失败（画质切换不可用）:', e);
			}
			// 缺失纹理回退数据源：默认纹理包（与地图纹理处理同一时序节点加载；
			// GLB 导出时直接在 Rust 侧把缺失材质替换为低清纹理——渲染端零后期处理）
			let defaultsJson = '{}';
			try {
				const embeddedMtz = getMtzB64();
				if (embeddedMtz) {
					// single 打包（file://）：主线程经 wasm-init 下发的内嵌 base64
					const bin = atob(embeddedMtz);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					defaultsJson = decompress_mtz(bytes);
					console.log('[load-bsp] 默认纹理包已加载（内嵌，缺失纹理回退可用）');
				} else {
					const resp = await fetch('./textures.mtz');
					if (resp.ok) {
						const bytes = new Uint8Array(await resp.arrayBuffer());
						defaultsJson = decompress_mtz(bytes);
						console.log('[load-bsp] 默认纹理包已加载（缺失纹理回退可用）');
					}
				}
			} catch (e) {
				console.warn('[load-bsp] 默认纹理包加载失败（缺失纹理保持占位色）:', e);
			}
			let glbBytes: Uint8Array;
			try {
				glbBytes = processor.export_glb_with_pakfile_models_with_defaults(defaultsJson);
			} catch (e) {
				console.warn('[load-bsp] 带默认纹理回退的 GLB 导出失败，回退无回退导出:', e);
				glbBytes = processor.export_glb_with_pakfile_models();
			}

			const glbBuffer = glbBytes.buffer.slice(
				glbBytes.byteOffset,
				glbBytes.byteOffset + glbBytes.byteLength,
			);

			// 1. 构建 Rust 物理世界（websurf-phys）
			const spawnResult = loadSpawnPoints(spawnJson);

			const phys = new PhysWorld();
			phys.build_world(
				brushJson,
				triJsonRaw ?? '[]',
				teleportJson,
				spawnResult.spawn.x,
				spawnResult.spawn.y,
				spawnResult.spawn.z,
				spawnResult.yaw,
			);
			// 灵敏度在 TS 输入层乘入（physics-loop），Rust 端固定 1
			phys.set_params(JSON.stringify({ sensitivity: 1 }));
			// 全部出生点列表（spawn 下拉切换用）：[x,y,z,yaw]
			phys.set_spawn_points(
				JSON.stringify(
					spawnResult.allSpawnPoints.map((sp) => [
						sp.origin.x,
						sp.origin.y,
						sp.origin.z,
						sp.yaw,
					]),
				),
			);

			this.phys = phys;
			this.physicsLoop.setPhysWorld(phys);
			this.physicsParams.attach(phys);
			void this.emitPhysicsSnapshot();

			this.pvs = new PvsManager(pvsJson);

			// 游戏状态：初始 spawn（死亡阈值由主线程场景加载后回传）
			this.game.reset();
			this.game.setInitialSpawn(
				{ x: spawnResult.spawn.x, y: spawnResult.spawn.y, z: spawnResult.spawn.z },
				(spawnResult.yaw * Math.PI) / 180,
			);

			// 同步视角到出生点 + 写首帧共享输出（noclip 位置同步）
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
				triJson: triJsonRaw,
				mosaicManifest,
				missingTextures,
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

	/** frame 触发信号：驱动物理循环（dt 由 Worker 侧 performance.now() 计算）。 */
	private handleFrame(_msg: FrameSignalMessage): void {
		if (!this.sceneReady) return;
		this.physicsLoop.frame();
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
		if (!this.phys) return;
		// 游戏模式：回退到最后检查点（若存在）；否则 Rust 重生到初始出生点
		const cp = this.game.getRespawnPos();
		if (cp) {
			this.phys.teleport_to(cp.pos.x, cp.pos.y, cp.pos.z, (cp.yaw * 180) / Math.PI);
		} else {
			this.phys.respawn();
		}
		// 同步视角（Rust respawn 不重置 yaw/pitch，保持当前朝向）
		const s = this.phys.state();
		this.physicsLoop.setView(s.yaw, s.pitch);
		// noclip 模式：位置权威源同步到重生后的 player 位置
		if (this.config.physics.mode === 'noclip') {
			this.physicsLoop.setNoclipPos({ x: s.posX, y: s.posY, z: s.posZ });
		}
		this.physicsLoop.onTeleport();
	}

	private handleSetPhysicsMode(msg: SetPhysicsModeMessage): void {
		// 同步 config.physics.mode；setPhysicsMode 内完成 player ↔ noclipView
		// 双向位置/视角继承（noclip 移动后切回 physics 不丢位置，速度清零）。
		this.config.physics.mode = msg.mode;
		this.physicsLoop.setPhysicsMode(msg.mode);
	}

	// -------------------------------------------------------------------------
	// 物理控制面板
	// -------------------------------------------------------------------------

	/** 设置物理参数（面板 → 参数管理器 → Rust set_params 立即生效）。 */
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

	/** 碰撞箱自动恢复开关（Rust 物理已有 stuck 解卡；保留占位兼容）。 */
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

	private handleTeleport(msg: TeleportMessage): void {
		// target = spawn 索引（来自 UI 下拉选择），切换到该出生点。
		if (!this.phys) return;
		this.phys.teleport_to_spawn(msg.target);
		const s = this.phys.state();
		this.physicsLoop.setView(s.yaw, s.pitch);
		// noclip 模式：同步位置到 noclipView
		if (this.config.physics.mode === 'noclip') {
			this.physicsLoop.setNoclipPos({ x: s.posX, y: s.posY, z: s.posZ });
		}
		this.physicsLoop.onTeleport();
	}

	/**
	 * 传送到任意自定义坐标（自定义传送点面板）。
	 * yaw 缺省 = 保持当前朝向。
	 */
	private handleTeleportToPos(msg: TeleportToPosMessage): void {
		if (!this.phys) return;
		const cur = this.phys.state();
		const yaw = msg.yaw !== undefined ? msg.yaw : cur.yaw;
		this.phys.teleport_to(msg.pos[0], msg.pos[1], msg.pos[2], yaw);
		const s = this.phys.state();
		this.physicsLoop.setView(s.yaw, s.pitch);
		// noclip 模式：同步位置到 noclipView
		if (this.config.physics.mode === 'noclip') {
			this.physicsLoop.setNoclipPos({ x: s.posX, y: s.posY, z: s.posZ });
		}
		this.physicsLoop.onTeleport();
	}

	/** 回传玩家当前位置（自定义传送点「保存当前位置」用）。 */
	private handleGetPlayerPos(): void {
		// 位置权威源：physics 模式 = Rust player；noclip 模式 = noclipView.pos
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
		if (!this.phys) return;
		const s = this.phys.state();
		this.postMessage({
			type: 'player-pos',
			pos: [s.posX, s.posY, s.posZ],
			yaw: s.yaw,
			pitch: s.pitch,
		});
	}

	/** 设置掉落死亡阈值（主线程从场景包围盒算出的 Y 下限 → Rust 阈值 = minY - 1000）。 */
	private handleSetDeathThreshold(sceneMinY: number): void {
		this.game.setDeathThreshold(sceneMinY);
		this.phys?.set_death_y(sceneMinY - 1000);
	}

	// -------------------------------------------------------------------------
	// 物理事件消费（Rust tick 内部传送/死亡 → 计时挑战状态机）
	// -------------------------------------------------------------------------

	/** 消费 Rust 物理事件（每帧一次，didPhysicsTick 后调用）。 */
	private consumePhysEvents(): void {
		if (!this.phys) return;
		for (;;) {
			const ev = this.phys.take_event();
			if (!ev) break;
			if (ev.kind === 'teleport') {
				// 计时挑战：记录检查点 / 检测完成（dest 信息来自 Rust 事件）
				this.game.onTeleport({
					index: -1,
					targetname: String(ev.targetname ?? ''),
					origin: { x: ev.origin[0], y: ev.origin[1], z: ev.origin[2] },
					angles: [0, ev.yaw, 0],
					yaw: ev.yaw,
				});
			} else if (ev.kind === 'death') {
				// Rust 已重生到初始出生点；计时挑战需回退到最后检查点
				this.game.onDeath();
				const cp = this.game.getRespawnPos();
				if (cp && this.phys) {
					this.phys.teleport_to(cp.pos.x, cp.pos.y, cp.pos.z, (cp.yaw * 180) / Math.PI);
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// 周期性回调（由 PhysicsLoop.onAfterPhysics 调用）
	// -------------------------------------------------------------------------

	/** 周期性回传 stats 与 game-stats 到主线程（10Hz）。 */
	private emitStats(dt: number): void {
		// FPS 用墙钟窗口（0.5s）而非物理 dt 累加：dt 含消息延迟/GC/调度抖动，
		// 会把显示值压低；墙钟统计对抖动免疫。
		this.fpsFrameCount++;
		const wallNow = performance.now();
		if (this.fpsWallStart === 0) this.fpsWallStart = wallNow;
		if (wallNow - this.fpsWallStart >= 500) {
			this.currentFps = Math.round((this.fpsFrameCount * 1000) / (wallNow - this.fpsWallStart));
			this.fpsFrameCount = 0;
			this.fpsWallStart = wallNow;
		}

		// HUD 不可见时跳过 stats/game-stats 发送（省性能）
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

		// 位置权威源：physics = Rust player state；noclip = noclipView.pos
		const inNoclip = this.config.physics.mode === 'noclip';
		if (!inNoclip && this.phys) {
			const s = this.phys.state();
			this.postMessage({
				type: 'stats',
				fps: this.currentFps,
				pos: [s.posX, s.posY, s.posZ],
				vel: [s.velX, s.velY, s.velZ],
				onGround: s.onGround,
				cluster: this.pvs?.currentClusterId ?? -1,
				speed: Math.hypot(s.velX, s.velZ),
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

	/** 发送消息到主线程（可选 transfer list，ArrayBuffer 零拷贝）。 */
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

/** Error/unknown → 字符串（保留 stack 诊断用）。 */
function stringifyError(err: unknown): string {
	if (err instanceof Error) {
		return err.stack ?? `${err.name}: ${err.message}`;
	}
	return String(err);
}
