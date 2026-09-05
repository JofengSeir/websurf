/**
 * 录像时间轴（底部条）：播放控制、进度、倍速、视角与显示开关。
 *
 * 布局（S5）：row1 = 主控制（播放/停止/逐帧、时间/帧号、进度条、倍速）；
 * row2 = 设置（视角、循环/轨迹线/幽灵、A-B 区间、速度读数）。
 */

import { el } from '../core/dom.js';
import type { Track } from './types.js';
import type { PlayMode, ReplayPlayer } from './player.js';
import type { ReplayVisuals } from './visuals.js';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly speedEl: HTMLElement;
  private readonly rangeEl: HTMLElement;
  /** 有没有轨迹（有才显示时间轴）。帧数等读数一律从播放器取，不缓存。 */
  private hasTracks = false;
  private dragging = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly player: ReplayPlayer,
    private readonly visuals: ReplayVisuals,
  ) {
    // ── 行 1：主控制 ──
    const row1 = el('div', 'tl-row');

    this.playBtn = el('button', 'btn', '播放', { type: 'button' });
    this.playBtn.addEventListener('click', () => this.player.toggle());
    row1.appendChild(this.playBtn);

    const stopBtn = el('button', 'btn', '停止', { type: 'button' });
    stopBtn.addEventListener('click', () => this.player.stop());
    row1.appendChild(stopBtn);

    const prevBtn = el('button', 'btn small', '◀ 帧', { type: 'button', title: '上一帧（,）' });
    prevBtn.addEventListener('click', () => this.player.stepFrames(-1));
    row1.appendChild(prevBtn);

    const nextBtn = el('button', 'btn small', '帧 ▶', { type: 'button', title: '下一帧（.）' });
    nextBtn.addEventListener('click', () => this.player.stepFrames(1));
    row1.appendChild(nextBtn);

    this.timeEl = el('span', 'tl-time', '0.00 / 0.00 s');
    row1.appendChild(this.timeEl);
    this.frameEl = el('span', 'tl-frame', '0 / 0');
    row1.appendChild(this.frameEl);

    this.slider = el('input', 'tl-slider');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '1000';
    this.slider.value = '0';
    this.slider.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
    this.slider.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    this.slider.addEventListener('input', () => {
      this.player.seekRatio(Number(this.slider.value) / 1000);
      this.refresh();
    });
    row1.appendChild(this.slider);

    // 倍速上提为主控制项（无文字 label，select 自身即说明）
    const speedSel = el('select', 'tl-select tl-speed-select', undefined, {
      title: '播放速度',
    });
    for (const s of SPEEDS) {
      speedSel.appendChild(el('option', undefined, `${s}×`, { value: String(s) }));
    }
    speedSel.value = '1';
    speedSel.addEventListener('change', () => {
      this.player.speed = Number(speedSel.value);
    });
    row1.appendChild(speedSel);

    root.appendChild(row1);

    // ── 行 2：设置与区间 ──
    const row2 = el('div', 'tl-row');

    const modeSel = el('select', 'tl-select');
    modeSel.appendChild(el('option', undefined, '第一人称（跟随）', { value: 'first' }));
    modeSel.appendChild(el('option', undefined, '第三人称（自由观察）', { value: 'third' }));
    modeSel.value = this.player.mode;
    modeSel.title = '回放视角';
    modeSel.addEventListener('change', () => {
      this.player.mode = modeSel.value as PlayMode;
    });
    row2.appendChild(modeSel);

    const loopLabel = el('label', 'tl-opt');
    const loopInput = el('input');
    loopInput.type = 'checkbox';
    loopInput.checked = true;
    loopInput.addEventListener('change', () => {
      this.player.loop = loopInput.checked;
    });
    loopLabel.append(loopInput, el('span', undefined, '循环'));
    row2.appendChild(loopLabel);

    const trailLabel = el('label', 'tl-opt');
    const trailInput = el('input');
    trailInput.type = 'checkbox';
    trailInput.checked = true;
    trailInput.addEventListener('change', () => this.visuals.setTrailVisible(trailInput.checked));
    trailLabel.append(trailInput, el('span', undefined, '轨迹线'));
    row2.appendChild(trailLabel);

    const ghostLabel = el('label', 'tl-opt');
    const ghostInput = el('input');
    ghostInput.type = 'checkbox';
    ghostInput.checked = true;
    ghostInput.addEventListener('change', () => this.visuals.setGhostVisible(ghostInput.checked));
    ghostLabel.append(ghostInput, el('span', undefined, '幽灵'));
    row2.appendChild(ghostLabel);

    // A-B 区间
    const aBtn = el('button', 'btn small', 'A 起点', {
      type: 'button',
      title: '以当前时间作为区间起点（快捷键 I）',
    });
    aBtn.addEventListener('click', () => this.setRangeStart());
    row2.appendChild(aBtn);

    const bBtn = el('button', 'btn small', 'B 终点', {
      type: 'button',
      title: '以当前时间作为区间终点（快捷键 O）',
    });
    bBtn.addEventListener('click', () => this.setRangeEnd());
    row2.appendChild(bBtn);

    const clearRangeBtn = el('button', 'btn small', '整段', {
      type: 'button',
      title: '清除区间，恢复整段播放',
    });
    clearRangeBtn.addEventListener('click', () => {
      this.player.rangeStart = 0;
      this.player.rangeEnd = 0;
      this.refresh();
    });
    row2.appendChild(clearRangeBtn);

    this.rangeEl = el('span', 'tl-range', '整段');
    row2.appendChild(this.rangeEl);

    this.speedEl = el('span', 'tl-speed', '速度 —');
    this.speedEl.title = '无速度数据：规则脚本未提供速度字段（写法见 docs/replay-rule-ai.md）';
    row2.appendChild(this.speedEl);

    root.appendChild(row2);

    window.addEventListener('keydown', (e) => {
      if (!this.hasTracks) return;
      // 别抢输入框的键——输入框里打 , . k i o 应该正常输入
      if (isTypingTarget(e.target)) return;
      if (e.code === 'KeyK') {
        e.preventDefault();
        this.player.toggle();
      } else if (e.code === 'Comma') {
        e.preventDefault();
        this.player.stepFrames(-1);
      } else if (e.code === 'Period') {
        e.preventDefault();
        this.player.stepFrames(1);
      } else if (e.code === 'KeyI') {
        e.preventDefault();
        this.setRangeStart();
      } else if (e.code === 'KeyO') {
        e.preventDefault();
        this.setRangeEnd();
      }
    });
  }

  /** 设 A 点：终点未定或已失效时顶到片尾，保证区间立刻可用。 */
  private setRangeStart(): void {
    const p = this.player;
    p.rangeStart = p.time;
    if (p.rangeEnd <= p.rangeStart) p.rangeEnd = p.duration;
    p.seek(p.time);
    this.refresh();
  }

  /** 设 B 点：终点早于起点时把起点退回片头。 */
  private setRangeEnd(): void {
    const p = this.player;
    p.rangeEnd = p.time;
    if (p.rangeEnd <= p.rangeStart) p.rangeStart = 0;
    p.seek(p.time);
    this.refresh();
  }

  /** 轨道增删后调用；传空数组即隐藏时间轴。 */
  setTracks(tracks: readonly Track[]): void {
    this.hasTracks = tracks.length > 0;
    this.root.classList.toggle('hidden', !this.hasTracks);
    this.refresh();
  }

  /** 每帧（或播放状态变化时）刷新读数。 */
  refresh(): void {
    if (!this.hasTracks) return;
    const p = this.player;
    this.playBtn.textContent = p.playing ? '暂停' : '播放';
    this.timeEl.textContent = `${fmtTime(p.time)} / ${fmtTime(p.duration)} s`;
    const total = p.clip?.count ?? 0;
    const idx = p.indexAt(p.time);
    this.frameEl.textContent = `${total > 0 ? idx + 1 : 0} / ${total}`;
    if (!this.dragging) {
      this.slider.value = String(Math.round(p.ratio * 1000));
    }

    const s = p.sample();
    if (s?.vel) {
      const horiz = Math.hypot(s.vel[0], s.vel[2]);
      const vert = s.vel[1];
      const total = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
      this.speedEl.textContent = `速度 ${total.toFixed(0)}（水平 ${horiz.toFixed(0)}，垂直 ${vert.toFixed(0)}）HU/s`;
    } else {
      this.speedEl.textContent = '速度 —';
    }

    const inRange = p.rangeEnd > p.rangeStart;
    this.rangeEl.textContent = inRange
      ? `${fmtTime(p.rangeStart)} → ${fmtTime(p.rangeStop)}（${fmtTime(p.rangeLength)} s）`
      : '整段';
    this.rangeEl.classList.toggle('active', inRange);
  }
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '0.00';
  return t.toFixed(2);
}

/** 焦点在可输入控件里时不该响应播放快捷键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}
