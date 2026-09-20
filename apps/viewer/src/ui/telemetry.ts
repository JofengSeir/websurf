/**
 * 回放遥测 HUD：速度（视口内，game 同款位置/样式）+ 按键簇（timeline 右侧）。
 *
 * 速度 = 单行裸数字「横向｜竖向」（无标签无单位，竖向取绝对值），位置横向居中、
 * 距底 24%——与 game/web/index.html 速度 HUD 同款（用户定调）。数据源 = 跟随轨道
 * Clip.vel 相邻帧差分（横向 = hypot(vel[0],vel[2])，竖向 = |vel[1]|）。
 * 按键 = 八键簇（Q/W/E/A/S/D/蹲/跳），挂 #timeline 右列（grid），按跟随轨道当前帧
 * Clip.buttons[index] 的 IN_* 位掩码高亮（bit 值锚点见 types.ts 注释与 replay-selftest
 * 的 IN_FORWARD(8) / IN_MOVELEFT(512) 断言；转向位 1<<25/1<<26 见下方常量）。
 */

import { el } from '../core/dom.js';
import type { Sample } from '../replay/types.js';

/** Source IN_* 按键位（与 types.ts 注释、replay-selftest 断言一致）。 */
const IN_JUMP = 1 << 1; // 2
const IN_DUCK = 1 << 2; // 4
const IN_FORWARD = 1 << 3; // 8
const IN_BACK = 1 << 4; // 16
const IN_MOVELEFT = 1 << 9; // 512
const IN_MOVERIGHT = 1 << 10; // 1024
/** 转向位取 CS:GO `in_buttons.h` 的 1<<25 / 1<<26（对应 +left/+right，即默认 Q/E）。
 *  回放里没有这两个位时对应键位保持暗态（显示但不亮），不影响其余键。 */
const IN_TURNLEFT = 1 << 25; // 33554432
const IN_TURNRIGHT = 1 << 26; // 67108864

interface KeyDef {
  readonly mask: number;
  readonly label: string;
  readonly cls: string;
  readonly title: string;
}

/** 展示八键：Q/E（转向，占上排左右空缺位）+ W/A/S/D + 蹲（1 格）/ 跳（2 格）。 */
const KEYS: readonly KeyDef[] = [
  { mask: IN_TURNLEFT, label: 'Q', cls: 'tm-key-q', title: 'IN_TURNLEFT（+left / Q）' },
  { mask: IN_FORWARD, label: 'W', cls: 'tm-key-w', title: 'IN_FORWARD' },
  { mask: IN_TURNRIGHT, label: 'E', cls: 'tm-key-e', title: 'IN_TURNRIGHT（+right / E）' },
  { mask: IN_MOVELEFT, label: 'A', cls: 'tm-key-a', title: 'IN_MOVELEFT' },
  { mask: IN_BACK, label: 'S', cls: 'tm-key-s', title: 'IN_BACK' },
  { mask: IN_MOVERIGHT, label: 'D', cls: 'tm-key-d', title: 'IN_MOVERIGHT' },
  { mask: IN_DUCK, label: '蹲', cls: 'tm-key-duck', title: 'IN_DUCK（Ctrl）' },
  { mask: IN_JUMP, label: '跳', cls: 'tm-key-jump', title: 'IN_JUMP（空格）' },
];

export class TelemetryHud {
  private readonly horizEl: HTMLElement;
  private readonly vertEl: HTMLElement;
  private readonly keyEls: ReadonlyMap<string, HTMLElement>;

  /**
   * @param speedRoot 速度 HUD 容器（#telemetry，game 同款定位由 CSS 决定）
   * @param keysRoot 按键簇容器（#timeline，右列；随时间轴显隐）
   */
  constructor(speedRoot: HTMLElement, keysRoot: HTMLElement) {
    // ── 速度：单行「横向｜竖向」裸数字（game 同款）──
    this.horizEl = el('span', 'tm-horiz', '—');
    const sep = el('span', 'vsep', '｜');
    this.vertEl = el('span', 'tm-vert', '—');
    speedRoot.appendChild(this.horizEl);
    speedRoot.appendChild(sep);
    speedRoot.appendChild(this.vertEl);

    // ── 按键簇：3 列网格（Q/W/E 上排，A/S/D 中排，蹲 1 格 + 跳 2 格 下排），timeline 右列 ──
    const keys = el('div', 'tm-keys');
    const map = new Map<string, HTMLElement>();
    for (const k of KEYS) {
      const keyEl = el('span', `tm-key ${k.cls}`, k.label, { title: k.title });
      map.set(k.cls, keyEl);
      keys.appendChild(keyEl);
    }
    this.keyEls = map;
    keysRoot.appendChild(keys);
  }

  /** 轨道增删后调用；无轨道时速度 HUD 隐藏（按键随 #timeline 自身显隐）。 */
  setTracks(hasTracks: boolean): void {
    (this.horizEl.parentElement as HTMLElement).classList.toggle('hidden', !hasTracks);
  }

  /**
   * 每帧刷新：速度双读数 + 按键高亮。
   * @param s 跟随轨道的采样（vel = 世界速度 [x,y,z]；null = 无速度数据）
   * @param buttons 跟随轨道当前帧的 IN_* 位掩码（null = 无按键数据）
   */
  update(s: Sample | null, buttons: number | null): void {
    if (s?.vel) {
      this.horizEl.textContent = Math.hypot(s.vel[0], s.vel[2]).toFixed(0);
      this.vertEl.textContent = Math.abs(s.vel[1]).toFixed(0);
    } else {
      this.horizEl.textContent = '—';
      this.vertEl.textContent = '—';
    }
    for (const [cls, keyEl] of this.keyEls) {
      const def = KEYS.find((k) => k.cls === cls);
      keyEl.classList.toggle('on', def != null && buttons != null && (buttons & def.mask) !== 0);
    }
  }
}
