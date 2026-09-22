/**
 * 键盘输入：监听 keydown / keyup，把 `KeyboardEvent.code` 映射成 `KeyState` 的布尔字段。
 *
 * 映射方向：
 * - 构造参数是 action → `code[]` 键位表（`apps/game/src/input/keymap.ts` 的
 *   `DEFAULT_KEYMAP` 与 `loadKeymap`）；`buildCodeMap` 把它反转成 `code` → action 的反查表，
 *   按键时一次查表即命中；
 * - 位掩码不在本文件换算：`getMask()` 转调 `src/ts-shared/auth/shared-state.ts` 的
 *   `keysToMask`，位常量 `KEY_MASK` 也定义在那里。
 *
 * 运行在主线程，调用方是 `apps/game/src/app.ts`：构造时传 `loadKeymap()`，`bind(window)` 挂事件，
 * Pointer Lock 状态变化时 `setEnabled(locked)` 并 `reset()`，窗口失焦时再 `reset()`；
 * 面板改键经 `globalThis.__keyboardInput` 调 `setKeymap`，并由 `onKeymapChange` 回调刷新 HUD 标签。
 */

import type { KeyState } from '../worker/worker-types.js';
import { keysToMask } from '../../../../src/ts-shared/auth/shared-state.js';
import type { BindableAction } from './keymap.js';

/** 由 action→code[] 键位表构建 code→action 反查表；同一 code 绑多个动作时后写者胜。 */
function buildCodeMap(keymap: Record<BindableAction, string[]>): Map<string, BindableAction> {
  const m = new Map<string, BindableAction>();
  for (const action of Object.keys(keymap) as BindableAction[]) {
    for (const code of keymap[action]) {
      m.set(code, action);
    }
  }
  return m;
}

/** 全 false 的初始键位状态（每个字段都必须显式列出）。 */
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

  /** 键位表在构造时定稿；后续变更走 `setKeymap`。 */
  constructor(keymap: Record<BindableAction, string[]>) {
    this.codeMap = buildCodeMap(keymap);
  }

  /** 键位变更订阅（面板改键后刷新使用方显示，如左下角按键簇标签；单订阅者足够）。 */
  private keymapListener: (() => void) | null = null;

  /** 注册键位变更回调（覆盖式；传 null 取消）。 */
  onKeymapChange(fn: (() => void) | null): void {
    this.keymapListener = fn;
  }

  /** 更新键位映射（面板录制后调用；立即重建反查表并通知订阅者）。 */
  setKeymap(keymap: Record<BindableAction, string[]>): void {
    this.codeMap = buildCodeMap(keymap);
    this.keymapListener?.();
  }

  /** 启用 / 禁用按键捕获；置为 false 时顺带清空键位状态。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const action = this.codeMap.get(e.code);
    if (action) {
      this.state[action] = true;
      // 命中的键阻止默认行为（Space / 方向键的页面滚动）
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

  /** 绑定 keydown / keyup 到指定目标；重复调用会先解绑旧目标，不会重复挂钩。 */
  bind(target: EventTarget): void {
    this.unbind();
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown as EventListener);
    target.addEventListener('keyup', this.handleKeyUp as EventListener);
  }

  /** 解绑两个监听并把目标置空（未绑定时为空操作）。 */
  unbind(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.handleKeyDown as EventListener);
      this.target.removeEventListener('keyup', this.handleKeyUp as EventListener);
      this.target = null;
    }
  }

  /** 返回当前按键状态的浅拷贝（调用方改动不会回写内部状态）。 */
  getState(): KeyState {
    return { ...this.state };
  }

  /** 返回当前按键位掩码（由共享层 `keysToMask` 从 `state` 换算）。 */
  getMask(): number {
    return keysToMask(this.state);
  }

  /** 清空全部按键状态（Pointer Lock 退出与窗口失焦时调用）。 */
  reset(): void {
    this.state = createEmptyKeyState();
  }
}
