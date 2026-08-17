/**
 * Pointer Lock 管理 — 请求锁定、检测状态、监听锁定变化/错误。
 *
 * 使用 { unadjustedMovement: true } 禁用 OS 级鼠标加速（Three.js r175 PR #30687，
 * Chromium bug 40662608）。高回报率鼠标在 OS 加速开启时会产生单次 movementX/Y
 * ≈ innerWidth/2.3 量级脉冲，被 push 到 input buffer 后造成视角瞬间跳变。
 * 提供 try-catch + Promise 降级方案兼容旧浏览器。
 */

type LockChangeCallback = (locked: boolean) => void;
type LockErrorCallback = () => void;

/**
 * requestPointerLock 的运行时签名：
 * - 现代 Chromium 114+ 接受 options 参数并返回 Promise<void>
 * - 旧浏览器不接受参数，返回 void
 * 两种返回值都需在运行时判断。
 */
type RequestPointerLockFn = (
  options?: { unadjustedMovement?: boolean },
) => Promise<void> | void;

export class PointerLockController {
  private locked = false;
  private currentTarget: HTMLElement | null = null;
  private lockChangeCallbacks = new Set<LockChangeCallback>();
  private lockErrorCallbacks = new Set<LockErrorCallback>();

  constructor() {
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('pointerlockerror', this.handleLockError);
  }

  /**
   * 请求 Pointer Lock。使用 { unadjustedMovement: true } 禁用 OS 鼠标加速；
   * 若浏览器不支持则降级为普通锁定。返回 Promise<boolean> 表示是否锁定成功。
   *
   * Promise 链使用 .then(success).catch(error) 顺序，确保只有锁定成功时
   * 才通知调用方启用鼠标输入。
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

      // 降级路径专用：判定本次请求是否成功锁定
      const onSettleChange = (): void => {
        done(document.pointerLockElement === target);
      };
      const onSettleError = (): void => {
        done(false);
      };

      document.addEventListener('pointerlockchange', onSettleChange);
      document.addEventListener('pointerlockerror', onSettleError);

      // 安全超时：避免 Promise 永久挂起
      const timeoutId = setTimeout(() => done(false), 3000);

      // 降级路径：旧浏览器 requestPointerLock() 返回 void，依赖事件判定结果
      const tryFallback = (): void => {
        const r = callRequestPointerLock(target);
        if (r) {
          r.then(() => done(true)).catch(() => done(false));
        }
        // 若返回 void，等待 onSettleChange / onSettleError 事件
      };

      // 标准 API（Chromium 114+）：接受 unadjustedMovement 选项
      const p = callRequestPointerLock(target, { unadjustedMovement: true });
      if (p) {
        p
          .then(() => {
            // unadjustedMovement 锁定成功
            done(true);
          })
          .catch(() => {
            // unadjustedMovement 不可用，降级为普通锁定
            console.warn(
              '[PointerLock] unadjustedMovement 不可用，降级为普通锁定',
            );
            tryFallback();
          });
      }
      // 若 p 为 undefined（旧浏览器不支持 options 参数）：
      // 等待 onSettleChange / onSettleError 事件
    });
  }

  isLocked(): boolean {
    return this.locked;
  }

  unlock(): void {
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }

  /** 注册 pointerlockchange 回调。锁定/解锁时均会触发。 */
  onLockChange(callback: LockChangeCallback): void {
    this.lockChangeCallbacks.add(callback);
  }

  /** 注册 pointerlockerror 回调。 */
  onLockError(callback: LockErrorCallback): void {
    this.lockErrorCallbacks.add(callback);
  }

  private handleLockChange = (): void => {
    this.locked =
      this.currentTarget !== null &&
      document.pointerLockElement === this.currentTarget;
    for (const cb of this.lockChangeCallbacks) {
      cb(this.locked);
    }
  };

  private handleLockError = (): void => {
    for (const cb of this.lockErrorCallbacks) {
      cb();
    }
  };
}

/**
 * 调用 element.requestPointerLock，统一处理返回类型。
 * 现代 Chromium 114+ 返回 Promise<void>；旧浏览器返回 void。
 * 通过 unknown 中转绕过不同 TS lib 版本的签名差异。
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
