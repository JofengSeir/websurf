/**
 * Pointer Lock 管理：请求锁定、查询状态、派发锁定变化与错误。
 *
 * ## 定位与消费点
 * 构造点：`apps/debug/src/app.ts` 与 `apps/game/src/app.ts` 各一个实例。
 * 两个工程的 `mousemove` 监听器先用 `isLocked()` 判门，锁定状态变化经 `onLockChange`
 * 同时驱动 `MouseBuffer.onLockChange` 与键盘状态复位。
 * 两个工程对 `requestLock` 返回值的用法不同：game 取 `Promise<boolean>` 做失败提示，
 * debug 只看副作用（`void`）。`apps/viewer` 不用本类（其 `fly.ts` 自带锁定状态）。
 *
 * ## 请求协议（`requestLock`）
 * 已锁定时直接返回 `Promise.resolve(true)`，不发新请求。否则记下目标元素并注册一次性
 * 结果监听，按三条路径竞争，**先到者胜**（`settled` 标志保证 `done` 只生效一次）：
 * 1. 带 `{ unadjustedMovement: true }` 调用（现代实现返回 Promise）→ 成功即 `true`；
 * 2. 上一步被拒 → 打印告警并以**无选项**重调一次（旧实现路径）；
 * 3. 两条 Promise 路径都拿不到 Promise（旧式 `void` 返回）→ 等
 *    `pointerlockchange` / `pointerlockerror` 事件判定。
 * 另有 3000ms 兜底超时，到点按失败结束，避免 Promise 永久挂起。
 *
 * ## 状态判定
 * `locked` 不来自 `requestLock` 的返回值，而是 `handleLockChange` 每次按
 * `document.pointerLockElement === currentTarget` 重算，因此外部触发的解锁（如 ESC）
 * 也能被正确识别。
 */

type LockChangeCallback = (locked: boolean) => void;
type LockErrorCallback = () => void;

/**
 * `requestPointerLock` 的运行时签名：支持选项的实现返回 `Promise<void>`，
 * 旧实现忽略参数并返回 `void`。两者都要在运行时分辨，故统一按可选 Promise 处理。
 */
type RequestPointerLockFn = (
  options?: { unadjustedMovement?: boolean },
) => Promise<void> | void;

/** Pointer Lock 控制器；构造即开始监听 document 上的两个 pointerlock 事件。 */
export class PointerLockController {
  /** 最新锁定状态（由 `handleLockChange` 重算，不是请求成功的回声）。 */
  private locked = false;
  /** 当前请求锁定的元素；`handleLockChange` 用它比对 `document.pointerLockElement`。 */
  private currentTarget: HTMLElement | null = null;
  /** 锁定变化的回调集合（Set 语义：同一函数重复注册只保留一份）。 */
  private lockChangeCallbacks = new Set<LockChangeCallback>();
  /** 锁定失败的回调集合。 */
  private lockErrorCallbacks = new Set<LockErrorCallback>();

  /** 注册 document 级监听（`pointerlockchange` / `pointerlockerror`）。 */
  constructor() {
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('pointerlockerror', this.handleLockError);
  }

  /**
   * 请求把 Pointer Lock 锁到 `target`。
   *
   * 先尝试带 `{ unadjustedMovement: true }`（请求不做 OS 级指针加速的原始位移）；
   * 该类实现不可用时降级为无选项的普通锁定。三条竞争路径与 3000ms 超时的细节见文件头。
   *
   * @param target 要锁定的元素；同时被记为 `currentTarget`，供后续状态比对。
   * @returns 是否锁定成功；已处于锁定状态时立即解析为 `true`。
   */
  requestLock(target: HTMLElement): Promise<boolean> {
    if (this.locked) {
      return Promise.resolve(true);
    }
    this.currentTarget = target;

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        document.removeEventListener('pointerlockchange', onSettleChange);
        document.removeEventListener('pointerlockerror', onSettleError);
        resolve(ok);
      };

      // 事件判定专供降级路径：以「锁定的元素是否就是 target」定成败
      const onSettleChange = (): void => {
        done(document.pointerLockElement === target);
      };
      const onSettleError = (): void => {
        done(false);
      };

      document.addEventListener('pointerlockchange', onSettleChange);
      document.addEventListener('pointerlockerror', onSettleError);

      // 兜底超时：三条路径都没结果时按失败收尾，不留挂起的 Promise
      const timeoutId = setTimeout(() => done(false), 3000);

      // 无选项重调：适用于忽略参数、返回 void 的实现
      const tryFallback = (): void => {
        const r = callRequestPointerLock(target);
        if (r) {
          r.then(() => done(true)).catch(() => done(false));
        }
        // 返回 void 时不在这里判定，交给上面注册的两个事件监听
      };

      // 首选路径：带 unadjustedMovement 请求原始（不做 OS 级加速）位移
      const p = callRequestPointerLock(target, { unadjustedMovement: true });
      if (p) {
        p
          .then(() => {
            // 首选路径成功；不再比对 pointerLockElement
            done(true);
          })
          .catch(() => {
            // 该类实现不支持该选项，退到无选项重调
            console.warn(
              '[PointerLock] unadjustedMovement 不可用，降级为普通锁定',
            );
            tryFallback();
          });
      }
      // p 为 undefined 时不发起降级重调，直接等事件判定
    });
  }

  /** 当前是否已锁定（取最近一次 `handleLockChange` 的记录）。 */
  isLocked(): boolean {
    return this.locked;
  }

  /** 主动解锁；`document.pointerLockElement` 为空时不调用 `exitPointerLock`。 */
  unlock(): void {
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }

  /** 注册 `pointerlockchange` 回调。锁定与解锁都会触发，回调收到新状态。 */
  onLockChange(callback: LockChangeCallback): void {
    this.lockChangeCallbacks.add(callback);
  }

  /** 注册 `pointerlockerror` 回调（无参数）。 */
  onLockError(callback: LockErrorCallback): void {
    this.lockErrorCallbacks.add(callback);
  }

  /**
   * `pointerlockchange` 处理：按「锁定元素是否就是 `currentTarget`」重算 `locked`，
   * 再以新状态逐个通知回调。外部触发的解锁因此也能落进同一状态机。
   */
  private handleLockChange = (): void => {
    this.locked =
      this.currentTarget !== null &&
      document.pointerLockElement === this.currentTarget;
    for (const cb of this.lockChangeCallbacks) {
      cb(this.locked);
    }
  };

  /** `pointerlockerror` 处理：逐个通知错误回调（不改动 `locked`）。 */
  private handleLockError = (): void => {
    for (const cb of this.lockErrorCallbacks) {
      cb();
    }
  };
}

/**
 * 调用 `element.requestPointerLock` 并归一返回类型。
 *
 * 用 `unknown` 中转以绕过不同 TS lib 版本对该方法签名的差异：返回可 then 的对象时原样给出，
 * 否则（旧式 `void` 返回）返回 `undefined`，由调用方改走事件判定路径。
 *
 * @param target 目标元素。
 * @param options 透传的选项；为 `undefined` 时即以无参形式调用。
 * @returns Promise（可 then 时）或 `undefined`。
 */
function callRequestPointerLock(
  target: HTMLElement,
  options?: { unadjustedMovement?: boolean },
): Promise<void> | undefined {
  const fn = target.requestPointerLock as unknown as RequestPointerLockFn;
  const result: unknown = fn.call(target, options);
  if (result && typeof (result as Promise<void>).then === 'function') {
    return result as Promise<void>;
  }
  return undefined;
}
