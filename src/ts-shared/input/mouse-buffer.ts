/**
 * 鼠标输入缓冲：Pointer Lock 首事件丢弃 + 增量削平（CLAMP）。
 *
 * ## 两条互斥的使用路径
 * - **`process`（线上路径）**：每个 `mousemove` 事件调一次，过滤后立刻返回增量，**不累积**。
 *   调用点：`apps/debug/src/app.ts` 与 `apps/game/src/app.ts` 的 `mousemove` 监听器；
 *   两者都先判 `PointerLockController.isLocked()`，再把返回值交给
 *   `src/ts-shared/input/input-layer.ts` 的 `layerMouseDelta` 乘灵敏度。
 * - **`push` + `drain`（累积路径）**：`push` 累加多次增量，`drain` 一次取出并清零。
 *   **本仓 `src/**` 与 `apps/**` 内零调用点**；`clear` 只被 `onLockChange` 内部调用。
 *
 * ## 削平口径：CLAMP 而非 DISCARD
 * 单轴增量超出 ±`MAX_DELTA` 时截到边界值，保留符号（方向）与阈值内的量级，
 * 因此快速的合法甩动不会被整段丢弃。注意与 `src/ts-shared/input/input-layer.ts`
 * 的 `INPUT_CLAMP` 是**两段**钳制：本文件作用于原始设备增量，那一段作用于乘过灵敏度的结果；
 * 两个工程的 `config` 默认 `sensitivity = 1.5`，故 raw 增量超过约 667 px 的部分在第二段被截掉。
 *
 * ## 首事件丢弃
 * `onLockChange` 无条件置 `discardNext`，使锁定后的第一个事件被丢弃且不产生增量。
 * 解锁时置位的该标志不会被消费——未锁定时 `process` / `push` 在更早的分支就返回了。
 */

/** 过滤后的鼠标像素增量（不含灵敏度；符号即方向）。 */
export interface MouseDelta {
	dx: number;
	dy: number;
}

/**
 * 单轴削平阈值（像素）。`process` 与 `push` 都经 `clampDelta` 走这个上限。
 *
 * 与 `INPUT_CLAMP` 同值但阶段不同：这里是设备原始增量，那里是乘灵敏度之后的结果。
 */
const MAX_DELTA = 1000;

/** 鼠标增量缓冲；两条路径共用同一套门（未锁定 / `discardNext` / 削平）。 */
export class MouseBuffer {
	/** 累积路径的 X 累加器（只被 push / drain / clear 读写）。 */
	private bufferX = 0;
	/** 累积路径的 Y 累加器（只被 push / drain / clear 读写）。 */
	private bufferY = 0;
	/** 锁定状态；为 false 时 `process` 与 `push` 都不产生输出。 */
	private locked = false;
	/** 待丢弃的首事件标志：由 `onLockChange` 置位，被 `process` / `push` 消费一次。 */
	private discardNext = false;

	/**
	 * 处理单个 `mousemove` 增量并立即返回（不累积）。
	 *
	 * 判定顺序：未锁定 → `null`；`discardNext` 置位 → 消费该标志并返回 `null`；
	 * 否则逐轴 `clampDelta` 后返回。
	 *
	 * @param movementX 事件的 `movementX`（原始像素）。
	 * @param movementY 事件的 `movementY`（原始像素）。
	 * @returns 过滤后的增量；`null` 表示本事件被丢弃。
	 */
	process(movementX: number, movementY: number): MouseDelta | null {
		if (!this.locked) return null;

		// 首事件：消费 discardNext，本次不产生增量
		if (this.discardNext) {
			this.discardNext = false;
			return null;
		}

		// 逐轴削平后直出（保留方向，不丢弃事件）
		return {
			dx: clampDelta(movementX),
			dy: clampDelta(movementY),
		};
	}

	/**
	 * 累积路径：按同一套门过滤后把增量累加进内部 buffer。
	 *
	 * 未锁定时直接返回；`discardNext` 置位时消费标志并跳过本次累加。
	 *
	 * @param movementX 事件的 `movementX`（原始像素）。
	 * @param movementY 事件的 `movementY`（原始像素）。
	 */
	push(movementX: number, movementY: number): void {
		if (!this.locked) return;

		// 首事件：消费 discardNext，本次不累加
		if (this.discardNext) {
			this.discardNext = false;
			return;
		}

		// 削平后再累加：异常大的单次事件不会把总量一次顶穿
		this.bufferX += clampDelta(movementX);
		this.bufferY += clampDelta(movementY);
	}

	/**
	 * 取出累积量并把两个累加器清零（不做平滑、不求平均）。
	 *
	 * 返回值为原始像素增量，不含灵敏度。
	 *
	 * @returns 自上次 `drain`（或 `clear`）以来的累加增量；无累积时为 `{dx: 0, dy: 0}`。
	 */
	drain(): MouseDelta {
		const dx = this.bufferX;
		const dy = this.bufferY;
		this.bufferX = 0;
		this.bufferY = 0;
		return { dx, dy };
	}

	/** 清零两个累加器；不改动 `locked` 与 `discardNext`。 */
	clear(): void {
		this.bufferX = 0;
		this.bufferY = 0;
	}

	/**
	 * 锁定状态变化时调用（两个工程都接在 `PointerLockController.onLockChange` 上）。
	 *
	 * 无条件清空累加器并置 `discardNext`：锁定后首个事件的增量不反映锁定后的真实移动，
	 * 直接采纳会造成视角突跳。
	 *
	 * @param locked 新的锁定状态。
	 */
	onLockChange(locked: boolean): void {
		this.locked = locked;
		this.clear();
		this.discardNext = true;
	}
}

/** 单轴削平：超上限取上限、低下限取下限，范围内原样返回（保留符号）。 */
function clampDelta(v: number): number {
	if (v > MAX_DELTA) return MAX_DELTA;
	if (v < -MAX_DELTA) return -MAX_DELTA;
	return v;
}
