/**
 * 回放遥测 HUD（视口中心偏下）：横向 / 竖向速度双读数 + 按键可视化。
 *
 * 速度 = 相邻帧位置差分的世界速度（Clip.vel，HU/s，跟随轨道），与原时间轴读数同源；
 * 应用户要求自时间轴下行迁入 HUD 并拆分横向（XY 平面）/ 竖向（Z 轴）两种显示。
 * 按键 = 逐帧 IN_* 位掩码（Clip.buttons；bit 值锚点见 types.ts「逐帧按键位掩码」注释
 * 与 replay-selftest 的 IN_FORWARD(8) / IN_MOVELEFT(512) 断言）。
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

interface KeyDef {
  readonly mask: number;
  readonly label: string;
  readonly cls: string;
  readonly title: string;
}

/** 展示六键：W/A/S/D + 跳（空格）+ 蹲（Ctrl）。 */
const KEYS: readonly KeyDef[] = [
  { mask: IN_FORWARD, label: 'W', cls: 'tm-key-w', title: 'IN_FORWARD' },
  { mask: IN_MOVELEFT, label: 'A', cls: 'tm-key-a', title: 'IN_MOVELEFT' },
  { mask: IN_BACK, label: 'S', cls: 'tm-key-s', title: 'IN_BACK' },
  { mask: IN_MOVERIGHT, label: 'D', cls: 'tm-key-d', title: 'IN_MOVERIGHT' },
  { mask: IN_JUMP, label: '跳', cls: 'tm-key-jump', title: 'IN_JUMP（空格）' },
  { mask: IN_DUCK, label: '蹲', cls: 'tm-key-duck', title: 'IN_DUCK（Ctrl）' },
];

export class TelemetryHud {
  private readonly horizEl: HTMLElement;
  private readonly vertEl: HTMLElement;
  private readonly keyEls: ReadonlyMap<string, HTMLElement>;

  constructor(private readonly root: HTMLElement) {
    // ── 速度：横向（XY 平面，主读数）+ 竖向（Z 轴）──
    const speed = el('div', 'tm-speed');

    const hRow = el('div', 'tm-row');
    hRow.appendChild(el('span', 'tm-label', '横向'));
    this.horizEl = el('span', 'tm-value tm-horiz', '—');
    hRow.appendChild(this.horizEl);
    speed.appendChild(hRow);

    const vRow = el('div', 'tm-row');
    vRow.appendChild(el('span', 'tm-label', '竖向'));
    this.vertEl = el('span', 'tm-value tm-vert', '—');
    vRow.appendChild(this.vertEl);
    speed.appendChild(vRow);

    // ── 按键簇：3 列网格（W 上排居中，A/S/D 中排，跳/蹲 下排）──
    const keys = el('div', 'tm-keys');
    const map = new Map<string, HTMLElement>();
    for (const k of KEYS) {
      const keyEl = el('span', `tm-key ${k.cls}`, k.label, { title: k.title });
      map.set(k.cls, keyEl);
      keys.appendChild(keyEl);
    }
    this.keyEls = map;

    root.appendChild(speed);
    root.appendChild(keys);
  }

  /** 轨道增删后调用；无轨道时整块隐藏。 */
  setTracks(hasTracks: boolean): void {
    this.root.classList.toggle('hidden', !hasTracks);
  }

  /**
   * 每帧刷新：速度双读数 + 按键高亮。
   * @param s 跟随轨道的采样（vel = 世界速度 [x,y,z]；null = 无速度数据）
   * @param buttons 跟随轨道当前帧的 IN_* 位掩码（null = 无按键数据）
   */
  update(s: Sample | null, buttons: number | null): void {
    if (s?.vel) {
      this.horizEl.textContent = Math.hypot(s.vel[0], s.vel[2]).toFixed(0);
      this.vertEl.textContent = s.vel[1].toFixed(0);
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
