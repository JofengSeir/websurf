/**
 * 可配置键位映射（自定义按键）。
 *
 * 结构：action → code[]（每个动作可绑定多个 KeyboardEvent.code）。
 * 默认键位与 cs-movement 契约一致；localStorage 持久化，支持面板录制重绑。
 */

import type { KeyState } from '../worker/worker-types.js';

/** 可绑定的动作（KeyState 字段，wheelJump 除外——滚轮专用，不在此配置）。 */
export type BindableAction = Exclude<keyof KeyState, 'wheelJump'>;

/** 动作 → 可读名（面板显示）。 */
export const ACTION_LABELS: Record<BindableAction, string> = {
  forward: '前进',
  backward: '后退',
  left: '左移',
  right: '右移',
  jump: '跳跃',
  duck: '蹲下',
  sprint: '慢走/加速',
  reset: '重生',
  yawLeft: '左转视角',
  yawRight: '右转视角',
};

/** 默认键位（code[]）。 */
export const DEFAULT_KEYMAP: Record<BindableAction, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  duck: ['ControlLeft', 'ControlRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  reset: ['KeyR'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
};

/** localStorage 存储键。 */
const STORAGE_KEY = 'websurf-game.keymap.v1';

/** 读取持久化键位（缺省返回默认深拷贝）。 */
export function loadKeymap(): Record<BindableAction, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_KEYMAP);
    const parsed = JSON.parse(raw) as Partial<Record<BindableAction, string[]>>;
    const merged = structuredClone(DEFAULT_KEYMAP);
    for (const action of Object.keys(DEFAULT_KEYMAP) as BindableAction[]) {
      if (Array.isArray(parsed[action]) && parsed[action]!.length > 0) {
        merged[action] = parsed[action]!;
      }
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_KEYMAP);
  }
}

/** 保存键位到 localStorage。 */
export function saveKeymap(keymap: Record<BindableAction, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap));
  } catch {
    // 忽略（隐私模式等）
  }
}

/** 恢复默认键位并清除持久化。 */
export function resetKeymap(): Record<BindableAction, string[]> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  return structuredClone(DEFAULT_KEYMAP);
}

/** KeyboardEvent.code → 友好显示名（面板/录制用）。 */
export function codeLabel(code: string): string {
  const map: Record<string, string> = {
    Space: '空格',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ControlLeft: 'Ctrl',
    ControlRight: 'Ctrl',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    AltLeft: 'Alt',
    AltRight: 'Alt',
    Enter: 'Enter',
    Escape: 'Esc',
    Tab: 'Tab',
  };
  if (map[code]) return map[code];
  // KeyA → A、Digit1 → 1、F1 → F1
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return code;
}

/** 是否是可安全绑定的修饰键（阻止绑定，避免冲突）。 */
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** 判定 code 是否可绑定（排除修饰键与 Esc）。 */
export function isBindableCode(code: string): boolean {
  return !MODIFIER_CODES.has(code) && code !== 'Escape';
}
