/**
 * 键盘输入映射 — 监听 keydown/keyup，维护 KeyState 状态。
 *
 * 键位可配置：由 keymap.ts 提供 action → code[] 映射（默认 = cs-movement 契约，
 * 面板可录制重绑 + localStorage 持久化）。
 *
 * 运行在主线程。Pointer Lock 退出时调用方应调用 reset() 清空状态。
 */

import type { KeyState } from '../worker/worker-types.js';
import { keysToMask } from '../../../src/ts-shared/auth/shared-state.js';
import type { BindableAction } from './keymap.js';

/** 从 action→code[] 键位表构建 code→action 反查表。 */
function buildCodeMap(keymap: Record<BindableAction, string[]>): Map<string, BindableAction> {
  const m = new Map<string, BindableAction>();
  for (const action of Object.keys(keymap) as BindableAction[]) {
    for (const code of keymap[action]) {
      m.set(code, action);
    }
  }
  return m;
}

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
  private codeMap: Map<string, BindableAction> = new Map();
  /** 是否接受按键事件（仅 Pointer Lock 锁定时 true；面板打开时忽略，防污染 WASD）。 */
  private enabled = false;

  constructor(keymap: Record<BindableAction, string[]>) {
    this.codeMap = buildCodeMap(keymap);
  }

  /** 更新键位映射（面板录制后调用；立即生效）。 */
  setKeymap(keymap: Record<BindableAction, string[]>): void {
    this.codeMap = buildCodeMap(keymap);
  }

  /** 启用/禁用按键捕获（锁定启用；ESC 退锁/面板打开禁用）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const action = this.codeMap.get(e.code);
    if (action) {
      this.state[action] = true;
      // 阻止 Space/方向键等默认行为（页面滚动）
      e.preventDefault();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const action = this.codeMap.get(e.code);
    if (action) {
      this.state[action] = false;
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
