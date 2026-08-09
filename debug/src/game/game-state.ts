/**
 * 游戏化状态机（计时挑战模式）
 *
 * 状态机：
 *   idle ──首次移动──> running ──触发 end──> finished
 *    ↑                    │
 *    │                    ↓
 *    └── 死亡/重生 <── 死亡检测
 *
 * 检查点：玩家触发的每个 teleport 记录为检查点（位置 + 时间）。
 * 死亡：玩家 Y < deathYThreshold → 回到最后检查点。
 * 完成：触发 targetname 含 "end" 的传送点 → 停止计时。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import type { TeleportDestination } from '../world/teleport-manager.js';

/** 游戏状态。 */
export type GamePhase = 'idle' | 'running' | 'finished';

/** 检查点快照。 */
export interface Checkpoint {
	/** 触发时间戳（毫秒，performance.now 基准）。 */
	t: number;
	/** 检查点位置（传送 dest origin）。 */
	pos: Vec3;
	/** 目标名称（用于显示）。 */
	name: string;
	/** yaw（用于重生朝向）。 */
	yaw: number;
}

/** 游戏状态快照（发送到主线程显示）。 */
export interface GameSnapshot {
	phase: GamePhase;
	/** 当前计时（毫秒，phase=running 时持续递增）。 */
	elapsedMs: number;
	/** 检查点数量。 */
	checkpointCount: number;
	/** 最后检查点名称（无则空字符串）。 */
	lastCheckpointName: string;
	/** 完成时间（毫秒，phase=finished 时有效）。 */
	finishTimeMs: number;
	/** 死亡次数。 */
	deaths: number;
	/** 是否死亡回退（用于 UI 闪烁提示）。 */
	justDied: boolean;
}

/**
 * 判定是否为终点目标。
 *
 * 匹配规则：targetname 以 "end" 结尾，且 "end" 前面是字符串开始或非字母字符
 * （如下划线、空格）。覆盖 BSP 常见命名：`end`、`level_end`、`map_end`、`zone_end`；
 * 不匹配 `endless`（非 end 结尾）、`friend`（end 前是字母）。
 */
function isEndTarget(name: string): boolean {
	return /(?:^|[^a-zA-Z])end$/i.test(name);
}

/** 游戏状态机。 */
export class GameState {
	private phase: GamePhase = 'idle';
	private startTime = 0;
	private elapsedMs = 0;
	private finishTimeMs = 0;
	private deaths = 0;
	private justDied = false;

	/** 检查点列表（teleport 事件消费记录）。 */
	private checkpoints: Checkpoint[] = [];

	/** 初始 spawn（用于无检查点时回退）。 */
	private initialSpawn: { pos: Vec3; yaw: number } | null = null;

	/** 设置初始 spawn（无检查点时回退）。 */
	setInitialSpawn(pos: Vec3, yaw: number): void {
		this.initialSpawn = { pos, yaw };
	}

	/** 获取当前状态快照。 */
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

	/** 重置到 idle 状态（新场景加载时）。 */
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
	 * 玩家移动时调用：从 idle → running（首次移动开始计时）。
	 * 仅在 physics 模式下触发。
	 */
	onPlayerMove(): void {
		if (this.phase === 'idle') {
			this.phase = 'running';
			this.startTime = performance.now();
		}
	}

	/**
	 * 传送点触发时调用。
	 * - 非 end：记录检查点
	 * - end：进入 finished 状态，记录完成时间
	 *
	 * @returns 若为终点触发返回 true，否则 false。
	 */
	onTeleport(dest: TeleportDestination): boolean {
		if (this.phase === 'finished') return false;

		if (isEndTarget(dest.targetname)) {
			// 完成
			if (this.phase === 'running' && this.startTime > 0) {
				this.elapsedMs += performance.now() - this.startTime;
			}
			this.finishTimeMs = this.elapsedMs;
			this.phase = 'finished';
			return true;
		}

		// 检查点：记录位置 + 时间（避免重复记录同名检查点）
		const exists = this.checkpoints.some(c => c.name === dest.targetname);
		if (!exists) {
			this.checkpoints.push({
				t: this.phase === 'running' && this.startTime > 0
					? this.elapsedMs + (performance.now() - this.startTime)
					: 0,
				pos: { x: dest.origin.x, y: dest.origin.y, z: dest.origin.z },
				name: dest.targetname,
				yaw: (dest.angles[1] * Math.PI) / 180,
			});
		}
		return false;
	}

	/**
	 * Rust 物理死亡事件消费（位置由 Rust 侧重生，本方法仅统计）。
	 * 调用方需另行按 getRespawnPos() 覆盖到检查点位置。
	 */
	onDeath(): void {
		if (this.phase !== 'running') return;
		this.deaths++;
		this.justDied = true;
	}

	/** 消费"justDied"标志（UI 显示后清除）。 */
	consumeJustDied(): boolean {
		const v = this.justDied;
		this.justDied = false;
		return v;
	}

	/** 获取回退位置（手动 respawn 时使用最后检查点）。 */
	getRespawnPos(): { pos: Vec3; yaw: number } | null {
		const cp = this.checkpoints.length > 0
			? this.checkpoints[this.checkpoints.length - 1]
			: null;
		if (cp) return { pos: cp.pos, yaw: cp.yaw };
		return this.initialSpawn;
	}
}

/** 格式化毫秒为 MM:SS.mmm 字符串。 */
export function formatTime(ms: number): string {
	const totalSec = ms / 1000;
	const m = Math.floor(totalSec / 60);
	const s = Math.floor(totalSec % 60);
	const ms3 = Math.floor(ms % 1000);
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
}
