/**
 * 计算频率上限（compute cap，task-95）：主线程「固定步长模拟时钟」每秒最多补算的目标频率（Hz）。
 *
 * ## 语义（2026-11-19 起复用 tickRate 本体）
 * - 三端主线程各有一个与 rAF 解耦的固定步长模拟时钟（`src/ts-shared/app/sim-clock.ts`，
 *   task-94 产物）；它的目标频率**复用**各端既有的 `physics.tickRate` 参数本体——tickRate 已是
 *   权威 Worker 固定步长的唯一来源（`src/ts-shared/auth/auth-loop.ts` 的 `setFixedDt(tickRate)`），
 *   再开一个 `computeRateCap` 配置字段/消息链会变成两个互斥旋钮（Lead 决策，2026-11-19）。
 * - 本模块只负责三件事：默认值探测、量程常量、HUD 双指标文案；不持有任何状态。
 * - 范围 48..1000 Hz、步长 1（面板控件同此量程）：下限 48 保证低刷屏/后台也能跑住最小模拟
 *   频率；上限 1000 对应高刷屏（240–360Hz 的 ×1.5 探测值）避免把主线程算穿。兜底值 480。
 *
 * ## 默认值探测：为什么是「刷新率 × 1.5」
 * 固定步长模拟的感知收益来自「每个呈现帧至少有 1–2 个模拟步」——60Hz 屏 ×1.5≈90Hz 已有
 * 1.5 步/帧的余量；高刷屏按刷新率等比放大，避免出现「144Hz 屏上 64Hz 模拟」的降级。
 * 采样 ~40 帧（上限 800ms）取逐帧间隔的 25 分位（最快一档）估刷新率——启动期长帧不能拖低
 * 估计值（见 `detectDefaultComputeCapHz`）；探测值 clamp 进 48..1000。
 *
 * ## 持久化：不另设 localStorage key
 * 探测值只是「用户没手动改过 tickRate 时的默认值」，本身不落盘：
 * - debug 的手动值走 `vbsp:physicsParams:debug`（`src/ts-shared/phys/param-prefs.ts` 的 tickRate）；
 * - game 的手动值走 `vbsp:panelPrefs` 的 physics 段（`apps/game/src/panel/panel-controller.ts`）；
 * 检测值若也存一份，下次启动分不清「存档默认值」与「手动值」，且会与各端既有偏好两套存值互相
 * 覆盖（三端还可能同 origin 打包部署）。故每次启动重新探测（刷新率本来就可能变），手动值优先。
 *
 * ## 消费点
 * - `apps/debug/src/app.ts`：启动检测 → 面板「计算帧率上限」行默认值 + HUD 双指标；
 * - `apps/game/src/panel/panel-controller.ts`：启动检测 → physics 滑块 + HUD 双指标；
 * - `apps/viewer/src/app.ts`：viewer 无主线程模拟时钟，只在 HUD 显示呈现 fps；
 * - 施加口：`rendererMain.setComputeRateCap(hz)`（debug/game 的 renderer-main 已实现）。
 */

/** 计算频率上限下限（Hz）。 */
export const COMPUTE_CAP_MIN = 48;
/** 计算频率上限上限（Hz）。 */
export const COMPUTE_CAP_MAX = 1000;
/** 探测失败/不可测时的兜底计算频率上限（Hz）。 */
export const COMPUTE_CAP_FALLBACK = 480;

/** 把任意数值夹进 48..1000 并取整；非有限数返回兜底值。 */
export function clampComputeCapHz(value: number): number {
	if (!Number.isFinite(value)) return COMPUTE_CAP_FALLBACK;
	return Math.min(COMPUTE_CAP_MAX, Math.max(COMPUTE_CAP_MIN, Math.round(value)));
}

/**
 * `rendererMain.simClockStats` 的公共形状（`src/ts-shared/app/sim-clock.ts` 的 `SimClockStats`
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

/** `detectDefaultComputeCapHz` 的可注入参数（测试用；生产调用不传）。 */
export interface DetectComputeCapOptions {
	/** 采样帧数，默认 40。 */
	frames?: number;
	/** 采样时间上限（毫秒），默认 800。 */
	maxMs?: number;
	/** 注入 rAF（Node 自测用假时钟）；缺省用 `globalThis.requestAnimationFrame`。 */
	requestFrame?: (cb: (ts: number) => void) => void;
}

function getRequestAnimationFrame(): ((cb: (ts: number) => void) => void) | null {
	const raf = (globalThis as { requestAnimationFrame?: (cb: (ts: number) => void) => number }).requestAnimationFrame;
	if (typeof raf !== 'function') return null;
	return (cb) => {
		raf.call(globalThis, cb);
	};
}

/**
 * 用 rAF 采样约 40 帧（≤800ms）估显示器刷新率，返回 clamp(刷新率 × 1.5, 48, 1000)。
 *
 * 估法取**逐帧间隔的 25 分位**（最快的一档），不取平均值：探测紧跟在页面初始化之后，
 * 载图/着色器编译会在窗口里插入 20–80ms 长帧，平均会把 320Hz 屏估成 ~160Hz（实测默认值
 * 一度是 246Hz）；刷新率是「最快且持续」的节拍，25 分位对少量长帧鲁棒。
 *
 * - 无 rAF（Node / 测试环境）→ 立即返回兜底值 480；超时/采样不足同样返回 480。
 * - 页面隐藏时 rAF 被节流，采样会偏慢，但只在启动时跑一次；调用方应把手动值放在探测值之前
 *   （debug/game 均只在「用户没手动改过」时才把探测值当默认值下发）。
 * - 永不 reject：调用方无需 try/catch。
 */
export function detectDefaultComputeCapHz(options: DetectComputeCapOptions = {}): Promise<number> {
	const requestFrame = options.requestFrame ?? getRequestAnimationFrame();
	if (!requestFrame) return Promise.resolve(COMPUTE_CAP_FALLBACK);
	const frames = Math.max(2, Math.floor(options.frames ?? 40));
	const maxMs = Math.max(16, Math.floor(options.maxMs ?? 800));
	return new Promise<number>((resolve) => {
		let firstTs = -1;
		let prevTs = -1;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		/** 逐帧间隔（ms）；启动期载图卡顿会产生远大于刷新间隔的帧，不能直接取平均。 */
		const gaps: number[] = [];
		/**
		 * 估刷新率：取间隔的 **25 分位**（最快的一档）而不是平均值。
		 *
		 * 启动探测紧跟在页面初始化之后，载图/编译会在采样窗口里插入若干 20–80ms 的长帧；
		 * 取平均会把 320Hz 屏估成 ~160Hz（实测 246Hz 默认值就是这么来的），而显示刷新率
		 * 是「最快且持续」的节拍——25 分位对少量长帧鲁棒，又不至于像「取最小间隔」那样
		 * 被时间戳抖动抬高。采样不足 4 帧时退回平均值。
		 */
		const estimate = (): number => {
			const usable = gaps.filter((g) => Number.isFinite(g) && g > 0);
			if (usable.length < 1) return COMPUTE_CAP_FALLBACK;
			let intervalMs: number;
			if (usable.length >= 4) {
				const sorted = usable.slice().sort((a, b) => a - b);
				intervalMs = sorted[Math.floor((sorted.length - 1) * 0.25)];
			} else {
				intervalMs = usable.reduce((a, b) => a + b, 0) / usable.length;
			}
			if (!(intervalMs > 0)) return COMPUTE_CAP_FALLBACK;
			return (1000 / intervalMs) * 1.5;
		};
		const finish = (hz: number): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolve(clampComputeCapHz(hz));
		};
		timer = setTimeout(() => finish(estimate()), maxMs + 50);
		const step = (ts: number): void => {
			if (settled) return;
			if (firstTs < 0) {
				firstTs = ts;
			} else if (prevTs >= 0) {
				gaps.push(ts - prevTs);
			}
			prevTs = ts;
			if (gaps.length >= frames - 2) {
				finish(estimate());
				return;
			}
			requestFrame(step);
		};
		requestFrame(step);
	});
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
