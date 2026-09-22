/**
 * 计时挑战状态机：idle → running → finished，另带死亡计数与检查点回退。
 *
 * 装配点（全仓唯一实例）：`apps/debug/src/app.ts` 的 `game`。
 * 输入侧由 `app.ts` 两处驱动：渲染循环在 `config.physics.mode === 'physics'` 且速度平方
 * 大于 1 时调 `onPlayerMove`；渲染物理事件回调在 `teleport` 时调 `onTeleport`、`death` 时
 * 调 `onDeath` 并按 `getRespawnPos` 回退。
 * 输出侧：`getSnapshot` 供 HUD 计时行（经 `formatTime` 格式化），`consumeJustDied` 供死亡
 * 提示。
 */

import type { Vec3 } from './physics/math/vec3.js';
import type { TeleportDestination } from './world/teleport-manager.js';

/** 状态机阶段。 */
export type GamePhase = 'idle' | 'running' | 'finished';

/** 检查点快照（`onTeleport` 在非终点触发时追加）。 */
export interface Checkpoint {
	/** 记录时刻的已跑时长（毫秒）；非 running 阶段触发时为 0。 */
	t: number;
	/** 检查点位置（复制自 `TeleportDestination.origin`）。 */
	pos: Vec3;
	/** 目标名称（`TeleportDestination.targetname`），同时是去重键。 */
	name: string;
	/** 重生朝向（弧度）；由 `TeleportDestination.yaw`（度）按 π/180 换算。 */
	yaw: number;
}

/** 状态机对外快照（`getSnapshot` 的返回结构）。 */
export interface GameSnapshot {
	/** 当前阶段。 */
	phase: GamePhase;
	/** 已跑时长（毫秒）：running 阶段为累计值加当前段，finished 阶段为完成时间。 */
	elapsedMs: number;
	/** 检查点条数（`checkpoints.length`）。 */
	checkpointCount: number;
	/** 最后一个检查点的名称；无检查点时空字符串。 */
	lastCheckpointName: string;
	/** 完成时间（毫秒）；未完成时为 0。 */
	finishTimeMs: number;
	/** 死亡次数累计。 */
	deaths: number;
	/** 是否处于刚死亡状态；由 `consumeJustDied` 取走并清零。 */
	justDied: boolean;
}

/**
 * 判定终点目标名：正则 `/(?:^|[^a-zA-Z])end$/i`。
 *
 * 命中条件 = 串以 `end`（不分大小写）结尾，且紧邻其前的位置是串首或一个非字母字符。
 * 故 `end`、`level_end`、`map_end` 命中；`endless` 不命中（不以 end 结尾），
 * `friend` 不命中（end 前是字母）。
 */
function isEndTarget(name: string): boolean {
	return /(?:^|[^a-zA-Z])end$/i.test(name);
}

/** 计时挑战状态机：字段全部私有，只经下列方法读写。 */
export class GameState {
	private phase: GamePhase = 'idle';
	private startTime = 0;
	private elapsedMs = 0;
	private finishTimeMs = 0;
	private deaths = 0;
	private justDied = false;

	/** 检查点列表（按触发顺序追加；同名只记第一条）。 */
	private checkpoints: Checkpoint[] = [];

	/** 初始出生点（检查点为空时的回退目标；yaw 为弧度）。 */
	private initialSpawn: { pos: Vec3; yaw: number } | null = null;

	/** 记录初始出生点（`app.ts` 在场景就绪时按 `bundle.spawn` 调用）。 */
	setInitialSpawn(pos: Vec3, yaw: number): void {
		this.initialSpawn = { pos, yaw };
	}

	/** 取快照：running 时把 `performance.now() - startTime` 加进 `elapsedMs`。 */
	getSnapshot(): GameSnapshot {
		let elapsed = this.elapsedMs;
		if (this.phase === 'running' && this.startTime > 0) {
			elapsed += performance.now() - this.startTime;
		}
		return {
			phase: this.phase,
			elapsedMs: elapsed,
			checkpointCount: this.checkpoints.length,
			lastCheckpointName: this.checkpoints.length > 0
				? this.checkpoints[this.checkpoints.length - 1].name
				: '',
			finishTimeMs: this.finishTimeMs,
			deaths: this.deaths,
			justDied: this.justDied,
		};
	}

	/** 回到 idle 并清空计时、完成时间、死亡计数与检查点；不动 `initialSpawn`。 */
	reset(): void {
		this.phase = 'idle';
		this.startTime = 0;
		this.elapsedMs = 0;
		this.finishTimeMs = 0;
		this.deaths = 0;
		this.justDied = false;
		this.checkpoints = [];
	}

	/**
	 * idle → running，并把 `startTime` 置为当前 `performance.now()`。
	 * 已处于 running 或 finished 时无副作用。
	 */
	onPlayerMove(): void {
		if (this.phase === 'idle') {
			this.phase = 'running';
			this.startTime = performance.now();
		}
	}

	/**
	 * 传送点触发时调用。
	 * - `phase === 'finished'` 直接返回 false；
	 * - 目标名命中 `isEndTarget`：结算 `finishTimeMs` 并置 finished，返回 true；
	 * - 其余：同名检查点已存在则跳过，否则追加一条，返回 false。
	 *
	 * 返回值在唯一调用点 `apps/debug/src/app.ts` 的 `onRenderPhysEvent` 未被使用。
	 */
	onTeleport(dest: TeleportDestination): boolean {
		if (this.phase === 'finished') return false;

		if (isEndTarget(dest.targetname)) {
			// 终点：结算 elapsedMs 并置 finished
			if (this.phase === 'running' && this.startTime > 0) {
				this.elapsedMs += performance.now() - this.startTime;
			}
			this.finishTimeMs = this.elapsedMs;
			this.phase = 'finished';
			return true;
		}

		// 检查点：同名只记第一条（位置 + 触发时刻）
		const exists = this.checkpoints.some(c => c.name === dest.targetname);
		if (!exists) {
			this.checkpoints.push({
				t: this.phase === 'running' && this.startTime > 0
					? this.elapsedMs + (performance.now() - this.startTime)
					: 0,
				pos: { x: dest.origin.x, y: dest.origin.y, z: dest.origin.z },
				name: dest.targetname,
				// yaw 存弧度：入参 `dest.yaw` 是 cs-movement 口径的度（0 = 朝 −Z，
				// 由 `apps/debug/src/world/teleport-manager.ts` 的 `bspYawToCsYaw` 换算），
				// 消费端 `apps/debug/src/app.ts` 的 `onRenderPhysEvent` 再乘 180/π 还原成度。
				yaw: (dest.yaw * Math.PI) / 180,
			});
		}
		return false;
	}

	/**
	 * 死亡事件消费：只在 running 时累加 `deaths` 并置 `justDied`。
	 * 位置回退由调用方负责（目标点取自 `getRespawnPos`）。
	 */
	onDeath(): void {
		if (this.phase !== 'running') return;
		this.deaths++;
		this.justDied = true;
	}

	/** 取走 `justDied` 并清零（UI 显示后调用）。 */
	consumeJustDied(): boolean {
		const v = this.justDied;
		this.justDied = false;
		return v;
	}

	/** 回退目标：有检查点取最后一个，否则取 `initialSpawn`；两者皆无时返回 null。 */
	getRespawnPos(): { pos: Vec3; yaw: number } | null {
		const cp = this.checkpoints.length > 0
			? this.checkpoints[this.checkpoints.length - 1]
			: null;
		if (cp) return { pos: cp.pos, yaw: cp.yaw };
		return this.initialSpawn;
	}
}

	/** 把毫秒格式化为 `MM:SS.mmm`（分钟不设上限，秒补两位、毫秒补三位）。 */
export function formatTime(ms: number): string {
	const totalSec = ms / 1000;
	const m = Math.floor(totalSec / 60);
	const s = Math.floor(totalSec % 60);
	const ms3 = Math.floor(ms % 1000);
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
}
