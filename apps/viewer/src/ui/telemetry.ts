/**
 * 回放遥测 HUD：速度读数（`#telemetry`）+ 按键簇（`#timeline` 右列）。
 *
 * 速度：单行两个裸数字「横向｜竖向」（无标签、无单位，竖向取绝对值），横向 = hypot(vel[0],
 * vel[2])、竖向 = |vel[1]|，都取到 0 位小数；无速度数据时两格都写 `—`。
 * 数据源是 `apps/viewer/src/replay/player.ts` 的 `ReplayPlayer.sample` 给出的 `Sample.vel`，
 * 也就是跟随轨道 `Clip.vel` 的逐帧线性插值；而 `Clip.vel` 由
 * `apps/viewer/src/replay/shavit-replay.ts` 的 `decodeFrames` 按位置差分生成（中间帧中央差分、
 * 两端单侧差分，缩放量含 tickrate）。
 * 定位与配色由 CSS 决定（`apps/viewer/web/styles.css` 的 `.telemetry`：距底 24%、水平锚在扣除
 * 侧栏宽度后的可视区域中心；侧栏收起时 `apps/viewer/src/app.ts` 另加 `full` 类回到全屏居中）。
 * 距底 24% 与 game 的速度 HUD 同值（`apps/game/web/styles.css` 的 `#hud`），分隔符沿用同一个
 * `vsep` 类；两侧的元素与结构不同——game 是 `#hud > #stats` 单个数字，本工程是 `#telemetry`
 * 内的两个数字。
 *
 * 按键：八键簇（Q / W / E 上排，A / S / D 中排，蹲 1 格 + 跳 2 格下排），挂在 `#timeline` 的网格
 * 右列，随时间轴一起显隐。高亮判据是 `Clip.buttons[index]` 的 IN_* 位掩码与各键 `mask` 相与非 0，
 * 掩码值见下方常量（与 `apps/viewer/src/replay/types.ts` 的 `Clip.buttons` 注释、
 * `apps/viewer/test/replay-selftest.ts` 里 IN_FORWARD 记 8、IN_MOVELEFT 记 512 两条断言同源）。
 *
 * 刷新时机：`apps/viewer/src/app.ts` 帧循环里每约 80 ms 一次，传入跟随轨道采样与当前帧掩码；
 * 无轨道时由 `setTracks(false)` 隐藏速度行。
 */

import { el } from '../core/dom.js';
import type { Sample } from '../replay/types.js';

/** Source IN_* 按键位（`KEYS` 逐项消费；按位口径与 `Clip.buttons` 一致，值写在行尾）。 */
const IN_JUMP = 1 << 1; // 2
const IN_DUCK = 1 << 2; // 4
const IN_FORWARD = 1 << 3; // 8
const IN_BACK = 1 << 4; // 16
const IN_MOVELEFT = 1 << 9; // 512
const IN_MOVERIGHT = 1 << 10; // 1024
/**
 * 转向位 1<<25 / 1<<26（对应 +left / +right，界面上就是 Q / E 两键）。
 * 回放里不带这两位时，这两个键位保持暗态（仍然显示），不影响其余键的高亮。
 */
const IN_TURNLEFT = 1 << 25; // 33554432
const IN_TURNRIGHT = 1 << 26; // 67108864

interface KeyDef {
  readonly mask: number;
  readonly label: string;
  readonly cls: string;
  readonly title: string;
}

/** 展示八键：Q / E 转向（占上排左右位）+ W / A / S / D + 蹲（1 格）+ 跳（跨 2 格）。 */
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
   * @param speedRoot 速度读数容器（`apps/viewer/src/app.ts` 传 `#telemetry`；定位由 CSS 决定）
   * @param keysRoot 按键簇容器（传 `#timeline`；按键块挂它的网格右列，随时间轴一起显隐）
   */
  constructor(speedRoot: HTMLElement, keysRoot: HTMLElement) {
    // ── 速度：单行两个裸数字，中间夹一个全角竖线分隔符 ──
    this.horizEl = el('span', 'tm-horiz', '—');
    const sep = el('span', 'vsep', '｜');
    this.vertEl = el('span', 'tm-vert', '—');
    speedRoot.appendChild(this.horizEl);
    speedRoot.appendChild(sep);
    speedRoot.appendChild(this.vertEl);

    // ── 按键簇：3 列网格（Q/W/E 上排、A/S/D 中排、蹲 1 格 + 跳 2 格下排），挂 timeline 右列 ──
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

  /** 轨道增删后调用（`apps/viewer/src/app.ts` 的 `syncTracks`）：无轨道时给速度行加 `hidden` 类（按键随 `#timeline` 自身显隐）。 */
  setTracks(hasTracks: boolean): void {
    (this.horizEl.parentElement as HTMLElement).classList.toggle('hidden', !hasTracks);
  }

  /**
   * 每帧刷新：速度双读数 + 按键高亮。
   * `s` 为 null 或 `s.vel` 为 null 时两格写 `—`；`buttons` 为 null 时全部键位熄灭。
   * 高亮只切 `on` 类，不改文本与结构。
   * @param s 跟随轨道的采样（`vel` = 世界速度 [x,y,z]；null = 无速度数据）
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
