/**
 * 鼠标输入缓冲 — 安全削平（CLAMP）策略。
 *
 * 职责：
 * 1. discardNext — Pointer Lock 变化后丢弃下一个 mousemove 事件
 *    （cs-movement discardNextMouse 语义），防止首帧大位移视角跳变
 *    （Pointer Lock 初始跳变通常 2000-5000+ px，由 discardNext 丢弃）。
 * 2. 绝对削平 — 单次 mousemove |dx|/|dy| > MAX_DELTA 时削平到 MAX_DELTA，
 *    作为驱动异常/浏览器事件合并的兜底。用 CLAMP 而非 DISCARD：
 *    保留移动方向和大部分量级，避免"快速转动时突然停住"。
 *
 * 为何不用 cs-movement 的 DISCARD 突变检测（350/8x/100/1200）：
 * - cs-movement 在事件回调中即时应用增量，单个 dx 是单次原始 DOM 事件
 *   （通常 1-50 px），dx=400 确是异常，丢弃只损失 ~1ms 用户无感知。
 * - 本项目在主线程 buffer 中累积事件、每 8ms drain 一次发往 Worker；
 *   mousemove 被节流到显示刷新率（60-144Hz），快速甩动时单事件可达
 *   200-600+ px（180° 甩动 5455px / 9 事件 ≈ 606px/事件）。DISCARD 会丢弃
 *   这些合法的快速移动事件，损失 60-100ms 旋转 → "突然停住一段时间"。
 *
 * 注意：drain() 返回的 dx/dy 为原始像素增量，不含 sensitivity。
 * 调用方负责将其累加到 yaw/pitch（公式：yaw -= dx * sens * m_yaw）。
 */

export interface MouseDelta {
	dx: number;
	dy: number;
}

/**
 * 单次 mousemove 事件的最大增量削平阈值（像素）。
 *
 * - 有效灵敏度 = sensitivity(1.5) * m_yaw(0.022) = 0.033 deg/px
 * - 1000 px 事件 = 33° 旋转（显著但不致晕）
 * - 2000 px 事件 = 66° 旋转（致晕，应削平）
 * - Pointer Lock 初始跳变 2000-5000+ px 由 discardNext 处理，此处为兜底
 *
 * 正常快速游玩（400-3200 DPI 鼠标 + 60-144Hz 节流）的单事件增量
 * 通常 < 600 px，不会触发此削平。
 */
const MAX_DELTA = 1000;

export class MouseBuffer {
	private bufferX = 0;
	private bufferY = 0;
	private locked = false;
	/** Pointer Lock 变化后丢弃下一个事件（cs-movement discardNextMouse）。 */
	private discardNext = false;

	/**
	 * 处理单个 mousemove 事件（共享内存极速输入链路）。
	 *
	 * 不累积：经 locked / discardNext / 绝对削平过滤后立即返回增量
	 * （null = 被丢弃/未锁定），调用方立刻写入共享内存输入区。
	 * 消除旧链路 8ms 限流 + 批量化对输入断续的放大 → 甩动即时连续。
	 */
	process(movementX: number, movementY: number): MouseDelta | null {
		if (!this.locked) return null;

		// discardNext：lock 变化后丢弃首个事件（Pointer Lock 初始跳变）
		if (this.discardNext) {
			this.discardNext = false;
			return null;
		}

		// 绝对削平：保留移动方向和大部分量级（CLAMP 而非 DISCARD）
		return {
			dx: clampDelta(movementX),
			dy: clampDelta(movementY),
		};
	}

	/**
	 * 累加鼠标移动到 buffer（应用 discardNext + 绝对削平）。
	 *
	 * - 非锁定状态下忽略（安全兜底）。
	 * - lock 变化后丢弃首个事件（discardNext）。
	 * - 其余事件削平到 ±MAX_DELTA 后累加（CLAMP，不丢弃）。
	 */
	push(movementX: number, movementY: number): void {
		if (!this.locked) return;

		// discardNext：lock 变化后丢弃首个事件（Pointer Lock 初始跳变）
		if (this.discardNext) {
			this.discardNext = false;
			return;
		}

		// 绝对削平：防驱动异常/浏览器事件合并致晕；CLAMP 保留方向与大部分量级
		this.bufferX += clampDelta(movementX);
		this.bufferY += clampDelta(movementY);
	}

	/**
	 * 取出整个 buffer（不做平滑），并将 buffer 清零。
	 *
	 * 主线程只做 discardNext + 削平过滤，原始 dx/dy 直传 Worker 写入 yaw/pitch。
	 */
	drain(): MouseDelta {
		const dx = this.bufferX;
		const dy = this.bufferY;
		this.bufferX = 0;
		this.bufferY = 0;
		return { dx, dy };
	}

	/** 清空 buffer。 */
	clear(): void {
		this.bufferX = 0;
		this.bufferY = 0;
	}

	/**
	 * 锁定状态变化时调用：清空 buffer、置 discardNext。
	 * 锁定时丢弃首个事件；解锁时清空残留输入。
	 */
	onLockChange(locked: boolean): void {
		this.locked = locked;
		this.clear();
		this.discardNext = true;
	}
}

/** 绝对削平：将增量限制在 ±MAX_DELTA，保留符号（方向），仅削减过大值。 */
function clampDelta(v: number): number {
	if (v > MAX_DELTA) return MAX_DELTA;
	if (v < -MAX_DELTA) return -MAX_DELTA;
	return v;
}
