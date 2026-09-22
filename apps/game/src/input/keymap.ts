/**
 * 可配置键位表：action → `KeyboardEvent.code[]`（每个动作可绑定多个 code）。
 *
 * - 可绑定动作由 `KeyState` 的字段决定（`BindableAction` = 除 `wheelJump` 外的全部字段；
 *   滚轮跳由滚轮事件直接产生，不参与键位配置）；
 * - 默认键位见 `DEFAULT_KEYMAP`，改键经面板录制后由 `saveKeymap` 落 localStorage；
 * - 持久化键是 `STORAGE_KEY`（`websurf-game.keymap.v1`）：读失败、字段不是数组、
 *   localStorage 不可用（隐私模式）时一律回落到默认表的深拷贝，不抛错；
 * - 允许某动作的键数组为空（= 禁用该动作）。
 *
 * 消费方：`apps/game/src/input/keyboard.ts` 的 `KeyboardInput`（构造与 `setKeymap`）、
 * `apps/game/src/app.ts`（`loadKeymap` / `ACTION_LABELS` / `codeLabel`，HUD 按键簇标签）、
 * `apps/game/src/panel/panel-controller.ts`（改键界面：`loadKeymap` / `saveKeymap` /
 * `resetKeymap` / `codeLabel` / `isBindableCode`）。
 */

import type { KeyState } from '../worker/worker-types.js';

/** 可绑定的动作（`KeyState` 的字段，wheelJump 除外——滚轮专用，不在此配置）。 */
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

/** 默认键位（动作 → code[]；每个动作都给了至少一个 code）。 */
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

/** 读取持久化键位：缺省或无有效字段时返回默认表的深拷贝。
 *  逐动作合并——存储里有数组的动作照用（**允许空数组**，即用户把该动作的键全删了 =
 *  禁用该动作），缺字段或字段不是数组的动作保留默认值。 */
export function loadKeymap(): Record<BindableAction, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_KEYMAP);
    const parsed = JSON.parse(raw) as Partial<Record<BindableAction, string[]>>;
    const merged = structuredClone(DEFAULT_KEYMAP);
    for (const action of Object.keys(DEFAULT_KEYMAP) as BindableAction[]) {
      // 允许空数组（用户把某个动作的键全删了 = 禁用该动作）。
      if (Array.isArray(parsed[action])) {
        merged[action] = parsed[action]!;
      }
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_KEYMAP);
  }
}

/** 整表写回 localStorage；写入抛异常（配额 / 隐私模式）时静默忽略。 */
export function saveKeymap(keymap: Record<BindableAction, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap));
  } catch {
    // 忽略（隐私模式等）
  }
}

/** 清除持久化并返回默认表的深拷贝（面板「恢复默认」用）。 */
export function resetKeymap(): Record<BindableAction, string[]> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  return structuredClone(DEFAULT_KEYMAP);
}

/** `KeyboardEvent.code` → 友好显示名（面板与录制提示用）。
 *  先查固定表；未命中时按前缀化简：`KeyX` → `X`、`DigitN` → `N`，其余原样返回。 */
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
  // KeyA → A、Digit1 → 1；其余 code 原样返回
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return code;
}

/**
 * 不可绑定的 code 集合。
 *
 * 只有两类被排除：`Escape`（录制界面的取消键）与 `MetaLeft` / `MetaRight`（Win / Super 键，
 * 系统层面会拦截，keydown 常常收不到或弹出系统菜单）。修饰键
 * （`ControlLeft` / `ControlRight` / `ShiftLeft` / `ShiftRight` / `AltLeft` / `AltRight`）
 * 都在可绑定范围内，故可以把蹲绑到 Shift 这类组合。
 */
const UNBINDABLE_CODES = new Set(['Escape', 'MetaLeft', 'MetaRight']);

/** 判定 code 是否可绑定（不在 `UNBINDABLE_CODES` 中即可）。 */
export function isBindableCode(code: string): boolean {
  return !UNBINDABLE_CODES.has(code);
}
