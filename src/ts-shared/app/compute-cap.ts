/**
 * 计算频率上限（compute cap，task-95）：主线程「固定步长模拟时钟」每秒最多补算的目标频率（Hz）。
 *
 * ## 语义（2026-11-19 定稿）
 * - 三端主线程各有一个与 rAF 解耦的固定步长模拟时钟（`src/ts-shared/app/sim-clock.ts`，
 *   task-94 产物）；它只负责「每秒算多少步主线程预测/呈现」，**不改权威物理步长**——
 *   权威 Worker 的固定步长仍由 `physics.tickRate`（48..128，难度/手感旋钮）决定。
 * - 本模块只负责三件事：量程常量、默认值、HUD 双指标文案；不持有任何状态。
 * - 范围 48..2000 Hz、步长 1：下限 48 保证低刷屏/后台也能跑住最小模拟频率；
 *   上限 2000 对应高刷屏与「多步/帧」余量；默认 1000 Hz（owner 2026-11-19 指定）。
 *
 * ## 默认值：固定 1000Hz，不做 rAF 探测
 * 早期实现用「rAF 频率 × 1.5」探测默认值（兜底 480），但探测受载图长帧影响、且 owner 已明确
 * 「默认 1000Hz、最高 2000Hz」。现在默认值就是常量 `COMPUTE_CAP_DEFAULT`；用户手动改动走各端
 * 既有偏好存储（debug `vbsp:physicsPrefs:debug`、game `vbsp:panelPrefs`），默认值本身不落盘。
 *
 * ## 消费点
 * - `apps/debug/src/app.ts`：面板「计算帧率上限」行默认值 + HUD 双指标；
 * - `apps/game/src/panel/panel-controller.ts`：physics 滑块 + HUD 双指标；
 * - `apps/viewer/src/app.ts`：viewer 无主线程模拟时钟，只在 HUD 显示呈现 fps；
 * - 施加口：`rendererMain.setComputeRateCap(hz)`（debug/game 的 renderer-main 已实现）。
 */

/** 计算频率上限下限（Hz）。 */
export const COMPUTE_CAP_MIN = 48;
/** 计算频率上限上限（Hz）。 */
export const COMPUTE_CAP_MAX = 2000;
/** 默认计算频率上限（Hz，owner 2026-11-19：默认 1000、最高 2000）。 */
export const COMPUTE_CAP_DEFAULT = 1000;

/** 把任意数值夹进 48..2000 并取整；非有限数返回默认值。 */
export function clampComputeCapHz(value: number): number {
	if (!Number.isFinite(value)) return COMPUTE_CAP_DEFAULT;
	return Math.min(COMPUTE_CAP_MAX, Math.max(COMPUTE_CAP_MIN, Math.round(value)));
}

/**
 * `rendererMain.simClockStats` 的公共形状（与 `src/ts-shared/app/sim-clock.ts` 的 `SimClockStats`
 * 结构兼容）。三端 HUD 只读：`计算` 取 `actualHz`（滚动窗口实测频率），空值显示 `—`。
 */
export interface SimClockStatsLike {
	/** 目标频率（面板上限与目标步频的较小者）。 */
	targetHz: number;
	/** 当前生效的计算频率上限（可选）。 */
	capHz?: number;
	/** 滚动窗口的实测频率。 */
	actualHz: number;
	/** 累计补算步数。 */
	steps: number;
	/** 上次 pump 的欠账毫秒数（可选，调试用）。 */
	lastOwedMs?: number;
}

/**
 * HUD 双指标文案：`计算 xxxHz / 呈现 xxxfps`。
 * `stats` 缺失（renderer 未就绪/回放/单步闸门）时计算侧显示 `—`。
 */
export function formatComputeHudText(stats: SimClockStatsLike | null, fps: number): string {
	const compute = stats && Number.isFinite(stats.actualHz) ? `${Math.round(stats.actualHz)}Hz` : '—';
	const present = Number.isFinite(fps) && fps > 0 ? `${Math.round(fps)}fps` : '--fps';
	return `计算 ${compute} / 呈现 ${present}`;
}
