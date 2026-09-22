/**
 * 轨迹列表面板：一条轨道一张卡（上行 = 配色点 / 名字 / 帧数与时长，下行 = 显隐 / 偏移 / 跟随 / 移除），
 * 外加一行批量操作（全部显示 / 全部隐藏 / 偏移归零 / 清空全部）。
 *
 * 职责边界：本文件只读写 `ReplayPlayer.tracks.tracks` 上的 `visible` / `offset` / `name` 三个字段
 * 并经 `ReplayPlayer` 的 `followTrack` / `removeTrack` / `clearTracks` 改结构；3D 与时间轴的重建
 * 由 `onChange` 回调交给 `apps/viewer/src/app.ts` 的 `syncTracks`。
 *
 * 关键不变量：
 * - 任何一次改动都是「先改数据、再 `refresh()` 重绘、再 `opts.onChange()`」，没有局部更新路径；
 * - `refresh` 在无轨道时隐藏备注行与批量行并显示引导文案；有轨道时按轨道数写总时长摘要；
 * - 批量行与备注行都挂在分区内容容器下、不随每次 `refresh` 重建，故只切 `style.display`。
 */

import { buttonRow, el, noteLine, section } from '../core/dom.js';
import type { ReplayPlayer } from './player.js';
import type { Track } from './types.js';

export interface TrackPanelOptions {
  /**
   * 轨道属性变化（显隐 / 偏移 / 重命名 / 跟随 / 移除 / 位置归零）后回调，
   * 供 `apps/viewer/src/app.ts` 重建 3D 可视化、时间轴与录像信息条；列表自身已由本类重绘。
   */
  onChange: () => void;
  /** 轨道数变化通知（每次 `refresh` 都按当前轨道数回调）。本仓无调用方传入。 */
  onPresence?: (count: number) => void;
  /**
   * 清空（含逐条移除到零）回调，接到 `apps/viewer/src/app.ts` 的 `onClearAll`
   * （清播放器、重建可视化、清 HUD 录像提醒行）。缺省时走本类的本地自清兜底。
   */
  onCleared?: () => void;
}

/** 状态提示行的写入函数签名（`apps/viewer/src/core/dom.ts` 的 `noteLine` 返回值的形状）。 */
type Note = (text: string, kind?: 'info' | 'warn' | 'error') => void;

export class TrackPanel {
  /** 卡片列表容器（每次 `refresh` 整表重建）。 */
  private readonly listEl: HTMLElement;
  /** 轨道数 / 总时长的摘要行（无轨道时隐藏）。 */
  private readonly summaryEl: HTMLElement;
  /** 批量操作按钮行（无轨道时隐藏）。 */
  private readonly batchRow: HTMLElement;
  /** 底部提示行的写入口。 */
  private readonly note: Note;

  /**
   * 构造即建好四个分区元素并 `refresh` 一次。
   * 批量按钮的 `onClick` 闭包引用 `this.note`，而 `this.note` 在本构造器后段才赋值；
   * 点击回调只在构造返回之后执行，届时该字段已就绪。
   */
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
          // 接回 app.onClearAll（清播放器/重建可视化/刷新时间轴、信息条与 HUD 提醒行）；
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

  /** 批量设置全部轨道的显隐（不改跟随目标）。 */
  private setAllVisible(v: boolean): void {
    for (const t of this.player.tracks.tracks) t.visible = v;
    this.refresh();
    this.opts.onChange();
  }

  /**
   * 按 `ReplayPlayer.tracks.tracks` 整表重绘：先清空列表容器，回调 `onPresence`；
   * 无轨道时隐藏摘要行与批量行并挂一条引导文案后返回；
   * 有轨道时先显示两行、写「N 条轨迹 + 主时钟总长」摘要（多条时追加一句说明），再逐条建卡。
   */
  refresh(): void {
    const tracks = this.player.tracks.tracks;
    this.listEl.innerHTML = '';
    this.opts.onPresence?.(tracks.length);

    if (tracks.length === 0) {
      this.summaryEl.style.display = 'none';
      this.batchRow.style.display = 'none';
      this.listEl.appendChild(
        el('div', 'note note-info', '还没有轨迹——录像页「选择录像文件…」或直接把 .replay 拖进窗口'),
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

  /** 建一张轨道卡：上行（色点 / 名字 / 帧数与时长）+ 下行（显隐 / 偏移 / 跟随 / 移除）。 */
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
      // 逐条移除到零也接回 app 的清空回调（清可视化并清空 HUD 录像提醒行）
      if (this.player.tracks.tracks.length === 0) this.opts.onCleared?.();
      this.note(`已移除「${track.name}」`, 'info');
    });
    line2.appendChild(delBtn);
    row.appendChild(line2);

    return row;
  }
}
