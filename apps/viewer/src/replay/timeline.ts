/**
 * 录像时间轴（底部控制条）：进度条、播放控制、显示开关。
 *
 * 三行结构：上行 = 进度条（正式跑段高亮与 A-B 区间带都叠在滑杆上）；
 * 中行 = 主控制（播放 / 停止 / 逐帧 / 时间·帧读数 / 倍速下拉）；
 * 下行 = 视角切换、显示开关与 A-B 区间按钮。速度读数在遥测 HUD（`apps/viewer/src/ui/telemetry.ts`）。
 *
 * 主时钟 0 = 起跑帧（t(i) = (i − preFrames) / tickrate）：默认窗口是整条 clip，首帧落在 prerun
 * 负段时窗口起点即片头（ReplayPlayer 的 applyFullRange）。正式跑段高亮与帧读数的 run 段标注取
 * 跟随轨道的头部元信息（Clip.meta 的 preFrames / frameCount）。
 */

import { el } from '../core/dom.js';
import type { Track } from './types.js';
import type { PlayMode, ReplayPlayer } from './player.js';
import type { ReplayVisuals } from './visuals.js';

/** 倍速下拉的档位（0.1× – 16×，与 window.viewer.replay.setSpeed 的钳制范围一致，见 `apps/viewer/src/app.ts` 的 replay）。 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly runZone: HTMLElement;
  private readonly abBand: HTMLElement;
  private readonly rangeEl: HTMLElement;
  /** 是否有轨道：false 时整条时间轴加 hidden 类，refresh 与快捷键直接返回；读数一律现取，不缓存。 */
  private hasTracks = false;
  /** 是否正在拖动滑杆：为 true 时 refresh 不回写滑杆值（避免与拖动抢夺）。 */
  private dragging = false;

  /** root = 承载三行控件的容器；player 提供主时钟与区间；visuals 提供轨迹线 / 幽灵 / tick 点显隐。 */
  constructor(
    private readonly root: HTMLElement,
    private readonly player: ReplayPlayer,
    private readonly visuals: ReplayVisuals,
  ) {
    // ── 上行：进度条（正式跑段高亮与 A-B 区间带都叠加在滑杆上）──
    const sliderRow = el('div', 'tl-slider-row');
    const wrap = el('div', 'tl-sliderwrap');

    this.runZone = el('div', 'tl-zone tl-zone-run');
    this.runZone.style.display = 'none';
    this.runZone.title = '正式跑段（头部 frameCount）；主时钟 0 = 起跑帧，prerun 不在播放区间';
    wrap.appendChild(this.runZone);

    this.abBand = el('div', 'tl-zone tl-zone-ab');
    this.abBand.style.display = 'none';
    this.abBand.title = 'A-B 播放区间（I / O 设置，整段按钮清除）';
    wrap.appendChild(this.abBand);

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
    wrap.appendChild(this.slider);
    sliderRow.appendChild(wrap);
    root.appendChild(sliderRow);

    // ── 中行：主控制 ──
    const controls = el('div', 'tl-controls');

    this.playBtn = el('button', 'btn playbtn', '播放', { type: 'button', title: '播放 / 暂停（K）' });
    this.playBtn.addEventListener('click', () => this.player.toggle());
    controls.appendChild(this.playBtn);

    const stopBtn = el('button', 'btn', '停止', {
      type: 'button',
      title: '回到区间起点并暂停',
    });
    stopBtn.addEventListener('click', () => this.player.stop());
    controls.appendChild(stopBtn);

    const prevBtn = el('button', 'btn small', '◀ 帧', { type: 'button', title: '上一帧（,）' });
    prevBtn.addEventListener('click', () => this.player.stepFrames(-1));
    controls.appendChild(prevBtn);

    const nextBtn = el('button', 'btn small', '帧 ▶', { type: 'button', title: '下一帧（.）' });
    nextBtn.addEventListener('click', () => this.player.stepFrames(1));
    controls.appendChild(nextBtn);

    this.timeEl = el('span', 'tl-time', '0.00 / 0.00 s');
    this.timeEl.title = '当前 / 总时长（秒，主时钟）；0 = 起跑帧，prerun 帧不在播放区间';
    controls.appendChild(this.timeEl);

    this.frameEl = el('span', 'tl-frame', '0/0 帧');
    this.frameEl.title = '帧序号（跟随轨道）；run = 正式跑段第 n 帧（头部 frameCount 为分母）';
    controls.appendChild(this.frameEl);

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
    controls.appendChild(speedSel);

    root.appendChild(controls);

    // ── 下行：视角切换 / 显示开关 / A-B 区间按钮与读数 ──
    const opts = el('div', 'tl-opts');

    const modeSel = el('select', 'tl-select');
    modeSel.appendChild(el('option', undefined, '第一人称（跟随）', { value: 'first' }));
    modeSel.appendChild(el('option', undefined, '第三人称（自由观察）', { value: 'third' }));
    modeSel.value = this.player.mode;
    modeSel.title = '回放视角';
    modeSel.addEventListener('change', () => {
      this.player.mode = modeSel.value as PlayMode;
    });
    opts.appendChild(modeSel);

    const loopLabel = el('label', 'tl-opt');
    const loopInput = el('input');
    loopInput.type = 'checkbox';
    loopInput.checked = true;
    loopInput.addEventListener('change', () => {
      this.player.loop = loopInput.checked;
    });
    loopLabel.append(loopInput, el('span', undefined, '循环'));
    opts.appendChild(loopLabel);

    const trailLabel = el('label', 'tl-opt');
    const trailInput = el('input');
    trailInput.type = 'checkbox';
    trailInput.checked = true;
    trailInput.addEventListener('change', () => this.visuals.setTrailVisible(trailInput.checked));
    trailLabel.append(trailInput, el('span', undefined, '轨迹线'));
    opts.appendChild(trailLabel);

    const ghostLabel = el('label', 'tl-opt');
    const ghostInput = el('input');
    ghostInput.type = 'checkbox';
    ghostInput.checked = true;
    ghostInput.addEventListener('change', () => this.visuals.setGhostVisible(ghostInput.checked));
    ghostLabel.append(ghostInput, el('span', undefined, '幽灵'));
    opts.appendChild(ghostLabel);

    const tickLabel = el('label', 'tl-opt');
    const tickInput = el('input');
    tickInput.type = 'checkbox';
    tickInput.checked = true;
    tickInput.title = '录像原始 tick 数据点（每 tick 帧一个方点，同 debug 权威帧节点）';
    tickInput.addEventListener('change', () => this.visuals.setTickNodesVisible(tickInput.checked));
    tickLabel.append(tickInput, el('span', undefined, 'tick 点'));
    opts.appendChild(tickLabel);

    // A-B 区间：设置按钮在本行，区间带画在上行滑杆上
    const aBtn = el('button', 'btn small', 'A 起点', {
      type: 'button',
      title: '以当前时间作为区间起点（快捷键 I）',
    });
    aBtn.addEventListener('click', () => this.setRangeStart());
    opts.appendChild(aBtn);

    const bBtn = el('button', 'btn small', 'B 终点', {
      type: 'button',
      title: '以当前时间作为区间终点（快捷键 O）',
    });
    bBtn.addEventListener('click', () => this.setRangeEnd());
    opts.appendChild(bBtn);

    const clearRangeBtn = el('button', 'btn small', '整段', {
      type: 'button',
      title: '清除区间，恢复整段播放',
    });
    clearRangeBtn.addEventListener('click', () => {
      this.player.clearRange();
      this.refresh();
    });
    opts.appendChild(clearRangeBtn);

    this.rangeEl = el('span', 'tl-range', '整段');
    opts.appendChild(this.rangeEl);

    root.appendChild(opts);

    window.addEventListener('keydown', (e) => {
      if (!this.hasTracks) return;
      // 输入控件持有焦点时不抢键：让 , . k i o 正常输入
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

  /** 设 A 点 = 当前主时钟时间：终点不晚于新起点（未设或已失效）时把终点顶到主时钟总长，保证区间立刻可用；随后 seek 到当前时间并刷新读数。 */
  private setRangeStart(): void {
    const p = this.player;
    p.rangeStart = p.time;
    if (p.rangeEnd <= p.rangeStart) p.rangeEnd = p.duration;
    p.seek(p.time);
    this.refresh();
  }

  /** 设 B 点 = 当前主时钟时间：终点不晚于起点时把起点退回 0；随后 seek 到当前时间并刷新读数。 */
  private setRangeEnd(): void {
    const p = this.player;
    p.rangeEnd = p.time;
    if (p.rangeEnd <= p.rangeStart) p.rangeStart = 0;
    p.seek(p.time);
    this.refresh();
  }

  /** 轨道增删后调用：非空即显示时间轴（去掉 hidden 类），传空数组即隐藏，随后刷新读数。 */
  setTracks(tracks: readonly Track[]): void {
    this.hasTracks = tracks.length > 0;
    this.root.classList.toggle('hidden', !this.hasTracks);
    this.refresh();
  }

  /** 刷新读数：播放按钮文案与 active 态、时间文本、帧文本、滑杆值（拖动中不回写）、区间读数，最后刷新两条叠加带。无轨道时直接返回。 */
  refresh(): void {
    if (!this.hasTracks) return;
    const p = this.player;
    this.playBtn.textContent = p.playing ? '暂停' : '播放';
    this.playBtn.classList.toggle('active', p.playing);
    this.timeEl.textContent = `${fmtTime(p.time)} / ${fmtTime(p.duration)} s`;
    this.frameEl.textContent = frameText(p);
    if (!this.dragging) {
      this.slider.value = String(Math.round(p.ratio * 1000));
    }
    this.refreshZones();

    const inRange = p.rangeEnd > p.rangeStart && !p.isFullWindow;
    this.rangeEl.textContent = inRange
      ? `${fmtTime(p.rangeStart)} → ${fmtTime(p.rangeStop)}（${fmtTime(p.rangeLength)} s）`
      : '整段';
    this.rangeEl.classList.toggle('active', inRange);
  }

  /**
   * 进度条叠加层：A-B 区间带 + 正式跑段高亮，位置一律按**当前播放窗口**换算成百分比
   * （rel(t) = (t − rangeStart) / (rangeStop − rangeStart) × 100）。
   *
   * 区间带的分支条件 = 显式设了区间（rangeEnd > rangeStart）且窗口不是整段；其宽度算的是
   * (min(rangeStop, duration) − rangeStart) / winLen，而窗口端点就是区间端点，故该值恒为 100，
   * 落不进「width > 0.05 且 width < 99.95」这一绘制条件，该带实际不会被显示。
   *
   * 跑段高亮：左端 rel(track.offset)，宽度 (min(runEndLocal, clip.duration) − max(track.offset, winStart)) / winLen
   * （被减数取的是轨道内部时间 `track.clip.t` 上的帧时间，减数里含全局 `track.offset` 且只出现一次；
   * `offset` 非 0 时两项因此不同基准）；
   * runEndLocal 取 meta.preFrames + meta.frameCount 处的帧时间，该下标越界时取 clip.duration。
   */
  private refreshZones(): void {
    const p = this.player;
    const dur = p.duration;
    const winStart = p.rangeStart;
    const winLen = p.rangeStop - p.rangeStart;
    if (!(dur > 0) || !(winLen > 0)) {
      this.runZone.style.display = 'none';
      this.abBand.style.display = 'none';
      return;
    }
    // 叠加带位置一律按当前播放窗口映射（默认窗口 = 整条 clip，含 prerun 负段）
    const rel = (t: number): number => ((t - winStart) / winLen) * 100;

    // A-B 区间带：只在用户显式设了区间且窗口不是整段时画（整段窗口下整条滑杆就是它）
    if (p.rangeEnd > p.rangeStart && !p.isFullWindow) {
      const left = Math.max(0, rel(p.rangeStart));
      const width = ((Math.min(p.rangeStop, dur) - p.rangeStart) / winLen) * 100;
      if (width > 0.05 && width < 99.95) {
        this.abBand.style.display = '';
        this.abBand.style.left = `${left}%`;
        this.abBand.style.width = `${width}%`;
      } else {
        this.abBand.style.display = 'none';
      }
    } else {
      this.abBand.style.display = 'none';
    }

    // 正式跑段高亮：左端 = rel(track.offset)；宽度 = (min(runEndLocal, clip.duration) − max(track.offset, winStart)) / winLen，
    // runEndLocal = idxEnd（= preFrames + frameCount）处的帧时间，idxEnd 越界时取 clip.duration。
    const track = p.tracks.follow;
    const meta = track?.clip.meta ?? null;
    if (track && meta && meta.frameCount > 0) {
      const idxEnd = meta.preFrames + meta.frameCount;
      const arr = track.clip.t;
      const runEndLocal = idxEnd < track.clip.count ? arr[idxEnd] : track.clip.duration;
      const left = rel(track.offset);
      const width = ((Math.min(runEndLocal, track.clip.duration) - Math.max(track.offset, winStart)) / winLen) * 100;
      // 跑段占满或缺失窗口时高亮无信息量，不画
      if (width > 0.05 && width < 99.95) {
        this.runZone.style.display = '';
        this.runZone.style.left = `${left}%`;
        this.runZone.style.width = `${width}%`;
      } else {
        this.runZone.style.display = 'none';
      }
    } else {
      this.runZone.style.display = 'none';
    }
  }
}

/** 秒 → 两位小数字符串；非有限值按 '0.00' 输出。 */
function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '0.00';
  return t.toFixed(2);
}

/**
 * 帧读数文本：`idx = indexAt(主时钟)`，显示的总序号是 `idx + 1 / clip.count`；有 `Clip.meta` 时再标
 * 段位——一律按 **idx** 比：`idx < preFrames` 标 pre，`[preFrames, preFrames + frameCount)` 标 run
 * `idx − preFrames + 1 / frameCount`，其余标 post。无轨道或 `clip.count = 0` 时返回 '0/0 帧'。
 */
function frameText(p: ReplayPlayer): string {
  const clip = p.clip;
  const total = clip?.count ?? 0;
  if (total <= 0) return '0/0 帧';
  const idx = p.indexAt(p.time);
  const meta = clip?.meta ?? null;
  if (!meta) return `${idx + 1}/${total} 帧`;
  if (idx < meta.preFrames) return `${idx + 1}/${total} 帧 · pre`;
  if (idx < meta.preFrames + meta.frameCount) {
    return `${idx + 1}/${total} 帧 · run ${idx - meta.preFrames + 1}/${meta.frameCount}`;
  }
  return `${idx + 1}/${total} 帧 · post`;
}

/** 事件目标是否是可输入控件（INPUT / TEXTAREA / SELECT / contentEditable）——是则不响应播放快捷键；tagName 非字符串（window、document 等）按 false 处理。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}
