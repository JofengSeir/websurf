/**
 * 轨迹列表面板（Q2）：一条轨迹一张两行轨道卡——配色、重命名、显隐、
 * 时间偏移、跟随目标、移除。批量操作只在有轨道时出现。
 *
 * 偏移用于对齐起跑时刻不同的两次跑法：offset 大的那条在主时钟上后起步。
 */

import { buttonRow, el, noteLine, section } from '../core/dom.js';
import type { ReplayPlayer } from './player.js';
import type { Track } from './types.js';

export interface TrackPanelOptions {
  /** 轨道属性变化（显隐 / 偏移 / 重命名 / 移除 / 跟随）→ app 重建可视化。 */
  onChange: () => void;
  /** 轨道数变化通知（0 ↔ n 切换时录像页组 2 折叠状态跟随）。 */
  onPresence?: (count: number) => void;
  /**
   * 清空/清到零回调：接回 app 的 onClearAll（清播放器、重建可视化与时间轴、
   * 复位「起点对齐」提示、清空 HUD 录像提醒行）。列表自身刷新仍由 TrackPanel
   * 完成；缺省时保留本地自清兜底，TrackPanel 独立可用。
   */
  onCleared?: () => void;
}

type Note = (text: string, kind?: 'info' | 'warn' | 'error') => void;

export class TrackPanel {
  private readonly listEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly batchRow: HTMLElement;
  private readonly note: Note;

  constructor(
    root: HTMLElement,
    private readonly player: ReplayPlayer,
    private readonly opts: TrackPanelOptions,
  ) {
    const body = section(root, '轨迹列表');

    this.summaryEl = el('div', 'note note-info');
    this.summaryEl.style.display = 'none';
    body.appendChild(this.summaryEl);

    this.listEl = el('div', 'track-list');
    body.appendChild(this.listEl);

    // 批量操作只属于「有轨道」的状态：空列表时不显示（见 refresh）
    this.batchRow = buttonRow(body, [
      {
        label: '全部显示',
        onClick: () => this.setAllVisible(true),
        title: '把所有轨迹重新显示出来',
      },
      { label: '全部隐藏', onClick: () => this.setAllVisible(false), title: '只留地图，隐藏所有轨迹' },
      {
        label: '偏移归零',
        onClick: () => {
          for (const t of this.player.tracks.tracks) t.offset = 0;
          this.refresh();
          this.opts.onChange();
        },
        title: '取消所有时间对齐偏移',
      },
      {
        label: '清空全部',
        onClick: () => {
          // 接回 app.onClearAll（清播放器/重建可视化/复位起点对齐与 HUD 提醒行）；
          // 无回调时保留本地自清兜底，保证独立可用。
          if (this.opts.onCleared) this.opts.onCleared();
          else {
            this.player.clearTracks();
            this.refresh();
            this.opts.onChange();
          }
          this.note('已清空全部轨迹', 'info');
        },
      },
    ]);
    this.batchRow.style.display = 'none';

    this.note = noteLine(body);
    this.refresh();
  }

  private setAllVisible(v: boolean): void {
    for (const t of this.player.tracks.tracks) t.visible = v;
    this.refresh();
    this.opts.onChange();
  }

  /** 轨道增删改后重绘列表。 */
  refresh(): void {
    const tracks = this.player.tracks.tracks;
    this.listEl.innerHTML = '';
    this.opts.onPresence?.(tracks.length);

    if (tracks.length === 0) {
      this.summaryEl.style.display = 'none';
      this.batchRow.style.display = 'none';
      this.listEl.appendChild(
        el('div', 'note note-info', '还没有轨迹——导入一份 JSON 录像，或点上面的「载入示例录像」'),
      );
      return;
    }

    const total = this.player.duration;
    this.summaryEl.style.display = '';
    this.summaryEl.textContent =
      `${tracks.length} 条轨迹，主时钟总长 ${total.toFixed(2)} s` +
      (tracks.length > 1 ? '（短的播完会停在终点）' : '');
    this.batchRow.style.display = '';

    for (const track of tracks) this.listEl.appendChild(this.buildRow(track));
  }

  private buildRow(track: Track): HTMLElement {
    const row = el('div', 'track-row');
    const tracks = this.player.tracks;

    // 行 1：色点 + 名称 + 帧数/时长（元信息）
    const line1 = el('div', 'track-line');
    const dot = el('span', 'track-dot');
    dot.style.background = '#' + track.color.toString(16).padStart(6, '0');
    dot.title = '轨迹配色';
    line1.appendChild(dot);

    const name = el('input', 'track-name');
    name.type = 'text';
    name.value = track.name;
    name.spellcheck = false;
    name.title = '轨迹名（回车生效）';
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (v) track.name = v;
      else name.value = track.name;
      this.opts.onChange();
    });
    line1.appendChild(name);

    line1.appendChild(
      el(
        'span',
        'track-meta',
        `${track.clip.count.toLocaleString('en-US')} 帧 / ${track.clip.duration.toFixed(2)} s`,
      ),
    );
    row.appendChild(line1);

    // 行 2：显隐 / 时间偏移 / 跟随 / 移除（控件顺序 = [显隐, 跟随, 移除]）
    const line2 = el('div', 'track-line track-line-ops');

    const visBtn = el('button', 'track-btn', track.visible ? '◉' : '◌', {
      type: 'button',
      title: track.visible ? '点击隐藏这条轨迹' : '点击显示这条轨迹',
    });
    if (!track.visible) visBtn.classList.add('off');
    visBtn.addEventListener('click', () => {
      track.visible = !track.visible;
      this.refresh();
      this.opts.onChange();
    });
    line2.appendChild(visBtn);

    line2.appendChild(el('span', 'track-off-label', '偏移'));
    const offInput = el('input', 'track-off');
    offInput.type = 'number';
    offInput.step = '0.1';
    offInput.value = String(track.offset);
    offInput.title = '时间偏移（秒）：本条的第 0 帧对应主时钟的这一刻，用来对齐起跑时刻不同的跑法';
    offInput.addEventListener('input', () => {
      const n = Number(offInput.value);
      const valid = Number.isFinite(n);
      offInput.classList.toggle('invalid', !valid);
      if (!valid) return;
      track.offset = Math.max(0, n);
      this.opts.onChange();
    });
    line2.appendChild(offInput);
    line2.appendChild(el('span', 'track-off-unit', 's'));

    // 跟随（第一人称相机 / 速度读数取哪条）
    const following = tracks.followId === track.id;
    const followBtn = el('button', 'track-btn', '◎', {
      type: 'button',
      title: following
        ? '当前跟随目标（第一人称与速度读数取自这条）'
        : '设为跟随目标：第一人称与速度读数取自这条',
    });
    if (following) followBtn.classList.add('active');
    followBtn.addEventListener('click', () => {
      this.player.followTrack(track.id);
      this.refresh();
      this.opts.onChange();
    });
    line2.appendChild(followBtn);

    const delBtn = el('button', 'track-btn danger', '×', {
      type: 'button',
      title: '移除这条轨迹',
    });
    delBtn.addEventListener('click', () => {
      this.player.removeTrack(track.id);
      this.refresh();
      this.opts.onChange();
      // 逐条移除到零也要复位「起点对齐」提示与 HUD 录像提醒行
      if (this.player.tracks.tracks.length === 0) this.opts.onCleared?.();
      this.note(`已移除「${track.name}」`, 'info');
    });
    line2.appendChild(delBtn);
    row.appendChild(line2);

    return row;
  }
}
