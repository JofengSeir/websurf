/**
 * 键盘输入映射 — 监听 keydown/keyup，维护 KeyState 状态。
 *
 * 键盘映射（cs-movement PlayerController.bindInput 契约）：
 *   KeyW / ArrowUp    → forward
 *   KeyS / ArrowDown  → backward
 *   KeyA / ArrowLeft  → left
 *   KeyD / ArrowRight → right
 *   Space             → jump
 *   ControlLeft/Right → duck
 *   ShiftLeft/Right   → sprint（noclip 冲刺 / physics 慢走）
 *   KeyR              → reset（重生，cs-movement input.reset）
 *
 * 运行在主线程。Pointer Lock 退出时调用方应调用 reset() 清空状态。
 */

import type { KeyState } from '../worker/worker-types.js';
import { keysToMask } from '../../../src/ts-shared/auth/shared-state.js';

/** KeyboardEvent.code → KeyState 字段映射。 */
const KEY_MAP: Record<string, keyof KeyState> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ControlLeft: 'duck',
  ControlRight: 'duck',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyR: 'reset',
  KeyQ: 'yawLeft',
  KeyE: 'yawRight',
};

function createEmptyKeyState(): KeyState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    duck: false,
    sprint: false,
    reset: false,
    wheelJump: false,
    yawLeft: false,
    yawRight: false,
  };
}

export class KeyboardInput {
  private state: KeyState = createEmptyKeyState();
  private target: EventTarget | null = null;

  private handleKeyDown = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (key) {
      this.state[key] = true;
      // 阻止 Space/方向键等默认行为（页面滚动）
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (key) {
      this.state[key] = false;
      e.preventDefault();
    }
  };

  /** 绑定 keydown/keyup 事件。重复调用会先解绑旧目标。 */
  bind(target: EventTarget): void {
    this.unbind();
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown as EventListener);
    target.addEventListener('keyup', this.handleKeyUp as EventListener);
  }

  /** 解绑事件。 */
  unbind(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.handleKeyDown as EventListener);
      this.target.removeEventListener('keyup', this.handleKeyUp as EventListener);
      this.target = null;
    }
  }

  /** 返回当前按键状态的浅拷贝。 */
  getState(): KeyState {
    return { ...this.state };
  }

  /** 返回当前按键位掩码（共享内存输入区写入用；实现收敛到 ts-shared keysToMask）。 */
  getMask(): number {
    return keysToMask(this.state);
  }

  /** 清空所有按键状态（Pointer Lock 退出时调用）。 */
  reset(): void {
    this.state = createEmptyKeyState();
  }
}
