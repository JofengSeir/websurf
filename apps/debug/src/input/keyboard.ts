/**
 * 键盘输入映射：监听 keydown / keyup，维护一份 `KeyState`。
 *
 * 只认 `KeyboardEvent.code`，映射表见 `KEY_MAP`：W/A/S/D 与四个方向键分别归到 forward /
 * backward / left / right，Space → jump，左右 Ctrl → duck，左右 Shift → sprint，R → reset，
 * Q / E → yawLeft / yawRight。命中映射表的按键会 `preventDefault()`（拦掉页面滚动等默认行为）；
 * 未命中的按键不改状态、不拦默认行为。
 *
 * `KeyState.wheelJump` 不在映射表里：它由 `apps/debug/src/app.ts` 的滚轮监听器置位。
 *
 * 装配点：`apps/debug/src/app.ts` 的 `keyboard`。主线程每渲染帧取 `getMask()` 写共享内存输入槽；
 * `getState()` 供录制；Pointer Lock 进入 / 退出时调用方调 `reset()` 清态。
 */

import type { KeyState } from '../worker/worker-types.js';
import { keysToMask } from '../../../../src/ts-shared/auth/shared-state.js';

/** `KeyboardEvent.code` → `KeyState` 字段名（18 条）。 */
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

/** 全 false 的初始按键状态（`wheelJump` 一并列入，等待滚轮监听器置位）。 */
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

/** 键盘输入源：持有一份按键状态并管理事件绑定。 */
export class KeyboardInput {
  /** 当前按键状态（唯一真源；`getState` 返回它的浅拷贝）。 */
  private state: KeyState = createEmptyKeyState();
  /** 当前事件目标；未绑定时为 null。 */
  private target: EventTarget | null = null;

  /** keydown 处理器：命中映射表则置位并阻止默认行为。 */
  private handleKeyDown = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (key) {
      this.state[key] = true;
      // 命中映射表的按键一律阻止默认行为（Space 滚动页面、方向键滚动等）
      e.preventDefault();
    }
  };

  /** keyup 处理器：命中映射表则清零并阻止默认行为。 */
  private handleKeyUp = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (key) {
      this.state[key] = false;
      e.preventDefault();
    }
  };

  /** 绑定 keydown / keyup 到目标（重复调用先 `unbind` 旧目标）。 */
  bind(target: EventTarget): void {
    this.unbind();
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown as EventListener);
    target.addEventListener('keyup', this.handleKeyUp as EventListener);
  }

  /** 解绑并把目标置空；除 `bind` 内部调用外，本仓无其他调用点。 */
  unbind(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.handleKeyDown as EventListener);
      this.target.removeEventListener('keyup', this.handleKeyUp as EventListener);
      this.target = null;
    }
  }

  /** 取按键状态浅拷贝（消费点：`apps/debug/src/app.ts` 的输入录制路径）。 */
  getState(): KeyState {
    return { ...this.state };
  }

  /** 取键位掩码：实现收敛到 `src/ts-shared/auth/shared-state.ts` 的 `keysToMask`（每帧写共享内存输入槽用）。 */
  getMask(): number {
    return keysToMask(this.state);
  }

  /** 重置为全 false（Pointer Lock 退出与丢焦时调用）。 */
  reset(): void {
    this.state = createEmptyKeyState();
  }
}
