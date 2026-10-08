/**
 * 时间轴（底部控制条）：进度条、播放控制、显示开关。
 *
 * **一个会话一条时间轴**：记录（`.replay`）与录像（`.dem`）各自持有一个实例、各自挂在
 * 自己的 dock 层里，各自读自己那条 `ReplayPlayer`。两条会话之间没有任何共享字段 ——
 * 见 `apps/viewer/src/replay/session.ts` 的 `ReplaySession`。
 *
 * 一条时间轴有哪些控件**在构造时由 `TimelineProfile` 定死**，没有运行期开关：
 * 记录档要帧步进 / A-B 区间 / 帧·run 读数（严格比较两条跑法用的精度），
 * 录像档要「人物活跃区间 + 悬停高亮」两条叠加带（长会话里看某个人在干什么）。
 * 早先这两套控件落在同一个实例上、靠 `setDemoMode(on)` 切一个类名收起/放出，
 * 两侧的读数与叠加带又共用同一份 `hasTracks / hasMarks` 状态，是「两条链路互相串位」的根源之一。
 *
 * 三行结构：上行 = 进度条（正式跑段高亮与 A-B 区间带都叠在滑杆上）；
 * 中行 = 主控制（播放 / 停止 / 逐帧 / 时间·帧读数 / 倍速下拉）；
 * 下行 = 视角切换、显示开关与 A-B 区间按钮。速度读数在遥测 HUD（`apps/viewer/src/ui/telemetry.ts`）。
 *
 * 主时钟的零点由**会话自己的帧时间**决定，不由本类决定：记录档是「0 = 起跑帧」
 * （`t(i) = (i − preFrames) / tickrate`，prerun 落负段），录像档是「0 = 录像开头」（绝对 tick 时刻）。
 * `profile.clock` 只决定**怎么显示**这个主时钟（秒计数 / `m:ss`）。
 */

import { el } from '../core/dom.js';
import type { PlayMode, ReplayPlayer } from './player.js';
import type { ReplayVisuals } from './visuals.js';

/** 倍速下拉的档位（0.1× – 16×，与 window.viewer.replay.setSpeed 的钳制范围一致，见 `apps/viewer/src/app.ts` 的 replay）。 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

/**
 * 一条时间轴的能力档：**构造时定死**，决定建哪些控件、读哪种时间码、画哪些叠加带。
 *
 * 判据是「这条链路的产物能不能支撑这件事」，不是「文件叫什么」：
 * - 帧步进与「帧 · run」读数要有**定长帧序列 + 头部的 prerun/run/post 段位**（只有 `.replay` 有）；
 * - 正式跑段高亮要读 `Clip.meta.frameCount`（`.dem` 恒 `meta === null`）；
 * - A-B 区间是「强制定义一段长度再比快慢」的行为，长会话录像里没有意义；
 * - 人物活跃区间与悬停高亮要的是**花名册里的 tick 区间**（只有 `.dem` 有）。
 */
export interface TimelineProfile {
  /** 时间码口径：`'run'` = 秒计数（主时钟 0 = 起跑帧）；`'wall'` = `m:ss`（主时钟 0 = 录像开头）。 */
  clock: 'run' | 'wall';
  /** 帧步进按钮与「帧」读数（`Clip.count` 是定长帧号时才有意义）。 */
  frameStep: boolean;
  /** A-B 播放区间：按钮、区间带、`I` / `O` 快捷键。 */
  abRange: boolean;
  /** 正式跑段高亮带（读跟随轨道 `Clip.meta`）。 */
  runZone: boolean;
  /** 人物叠加带：当前视角人物的活跃区间 + 悬停高亮（由会话调 `setActiveSpan` / `setHighlight` 驱动）。 */
  personZones: boolean;
}

export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly frameEl: HTMLElement | null;
  private readonly slider: HTMLInputElement;
  private readonly runZone: HTMLElement | null;
  private readonly abBand: HTMLElement | null;
  private readonly rangeEl: HTMLElement | null;
  /** 当前视角人物的活跃区间（秒，可多段）；null = 不画。 */
  private activeSpans: Array<[number, number]> | null = null;
  /** 悬停高亮区间（秒，可多段）；null = 不画。 */
  private hlSpans: Array<[number, number]> | null = null;
  private readonly activeZone: HTMLElement | null;
  private readonly hlZone: HTMLElement | null;
  /** 一次性「跳到这一跑」区间带（见 setJumpSpan）；无内容时 display:none。 */
  private readonly jumpZone: HTMLElement | null;
  private jumpSpan: { from: number; to: number; title?: string } | null = null;
  /**
   * 本会话是否已有可播放的内容（记录 = 有轨道；录像 = 已载入整段）。
   * 为假时整条时间轴加 `hidden` 类、`refresh` 与快捷键直接返回。
   */
  private ready = false;
  /**
   * 本会话是否**上场**。两条时间轴各绑一份 `window` 的 `keydown`，而下场的那条时间轴仍然是
   * `ready` 的（它的轨道、时长、区间都还在）—— 没有这道闸，按 `K` / `,` / `.` / `I` / `O`
   * 会**同时打到两条播放器**上：用户在看录像，记录会话却在后台被改播放态、被逐帧步进、
   * 被设 A-B 区间（正是 owner 不许的「功能串位」）。
   * 由 `apps/viewer/src/replay/session.ts` 的 `ReplaySession` 在上下场时置位。
   */
  private onStage = false;
  /** 是否正在拖动滑杆：为 true 时 refresh 不回写滑杆值（避免与拖动抢夺）。 */
  private dragging = false;
  /**
   * **用户自己动了进度条**时的通报钩子（拖动中的每一次 `input` 都调一次）。
   *
   * 为什么要有它：缺口里的「跳到他重进那一刻」与「跟当前最快的那位」都是**替用户做决定**，
   * 而他亲手拖到某个位置时这两件事都不该抢方向（owner 实测：把播放头拖到两段中间，
   * 会被强制弹到第二段开头）。`apps/viewer/src/app.ts` 据此让开方向。
   * 只由**滑杆**触发 —— 程序内部的 `seek`（深链、载入后回到 0、A-B 循环）不算用户操作。
   */
  onUserSeek?: () => void;

  /** root = 本会话自己的时间轴容器；player 提供主时钟与区间；visuals 提供轨迹线 / 幽灵 / tick 点显隐。 */
  constructor(
    private readonly root: HTMLElement,
    private readonly player: ReplayPlayer,
    private readonly visuals: ReplayVisuals,
    private readonly profile: TimelineProfile,
  ) {
    // ── 上行：进度条（正式跑段高亮与 A-B 区间带都叠加在滑杆上）──
    const sliderRow = el('div', 'tl-slider-row');
    const wrap = el('div', 'tl-sliderwrap');

    this.runZone = profile.runZone ? el('div', 'tl-zone tl-zone-run') : null;
    if (this.runZone) {
      this.runZone.style.display = 'none';
      this.runZone.title = '正式跑段（头部 frameCount）；主时钟 0 = 起跑帧，prerun 不在播放区间';
      wrap.appendChild(this.runZone);
    }

    this.abBand = profile.abRange ? el('div', 'tl-zone tl-zone-ab') : null;
    if (this.abBand) {
      this.abBand.style.display = 'none';
      this.abBand.title = 'A-B 播放区间（I / O 设置，整段按钮清除）';
      wrap.appendChild(this.abBand);
    }

    // 人物叠加带：当前视角人物的活跃区间 + 悬停高亮（都叠在滑杆上）
    this.activeZone = profile.personZones ? el('div', 'tl-zone tl-zone-active') : null;
    if (this.activeZone) {
      this.activeZone.style.display = 'none';
      this.activeZone.title = '当前视角人物在这段录像里的活跃区间（他中途退出又进来的话，这里是分开的几段）';
      wrap.appendChild(this.activeZone);
    }
    // 一次性「跳到这一跑」带：两条链路都建（记录会话用不到，但代价只是一个隐藏 div）
    this.jumpZone = el('div', 'tl-zone tl-zone-jump');
    this.jumpZone.style.display = 'none';
    wrap.appendChild(this.jumpZone);
    this.hlZone = profile.personZones ? el('div', 'tl-zone tl-zone-hl') : null;
    if (this.hlZone) {
      this.hlZone.style.display = 'none';
      wrap.appendChild(this.hlZone);
    }

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
      // **用户自己动了进度条**：先通报（`apps/viewer/src/app.ts` 据此在拖动期间让开方向 ——
      // 缺口里的「跳过」与「跟最快的那位」都不许抢用户拖到的位置），再执行 seek。
      this.onUserSeek?.();
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

    if (profile.frameStep) {
      const prevBtn = el('button', 'btn small', '◀ 帧', { type: 'button', title: '上一帧（,）' });
      prevBtn.addEventListener('click', () => this.player.stepFrames(-1));
      controls.appendChild(prevBtn);

      const nextBtn = el('button', 'btn small', '帧 ▶', { type: 'button', title: '下一帧（.）' });
      nextBtn.addEventListener('click', () => this.player.stepFrames(1));
      controls.appendChild(nextBtn);
    }

    this.timeEl = el('span', 'tl-time', '0.00 / 0.00 s');
    this.timeEl.title =
      profile.clock === 'run'
        ? '当前 / 总时长（秒，主时钟）；0 = 起跑帧，prerun 帧计入区间（读数可为负）'
        : '当前 / 总时长（m:ss，主时钟 0 = 录像开头）';
    controls.appendChild(this.timeEl);

    this.frameEl = profile.frameStep ? el('span', 'tl-frame', '0/0 帧') : null;
    if (this.frameEl) {
      this.frameEl.title = '帧序号（跟随轨道）；run = 正式跑段第 n 帧（头部 frameCount 为分母）';
      controls.appendChild(this.frameEl);
    }

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
    tickInput.title = '回放原始采样点（每帧一个方点，同 debug 权威帧节点）';
    tickInput.addEventListener('change', () => this.visuals.setTickNodesVisible(tickInput.checked));
    tickLabel.append(tickInput, el('span', undefined, 'tick 点'));
    opts.appendChild(tickLabel);

    // A-B 区间：设置按钮在本行，区间带画在上行滑杆上
    if (profile.abRange) {
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
    } else {
      this.rangeEl = null;
    }

    root.appendChild(opts);

    // 快捷键只在**本会话上场且已有内容**时生效，且只在**本档支持的键**上生效：
    // 两条链路各自绑一份，互不影响（记录档按 `,` 逐帧时，录像档的播放器完全不动）。
    window.addEventListener('keydown', (e) => {
      if (!this.ready || !this.onStage) return;
      // 输入控件持有焦点时不抢键：让 , . k i o 正常输入
      if (isTypingTarget(e.target)) return;
      if (e.code === 'KeyK') {
        e.preventDefault();
        this.player.toggle();
      } else if (e.code === 'Comma' && profile.frameStep) {
        e.preventDefault();
        this.player.stepFrames(-1);
      } else if (e.code === 'Period' && profile.frameStep) {
        e.preventDefault();
        this.player.stepFrames(1);
      } else if (e.code === 'KeyI' && profile.abRange) {
        e.preventDefault();
        this.setRangeStart();
      } else if (e.code === 'KeyO' && profile.abRange) {
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

  /**
   * 本会话是否已有可播放内容（记录 = 有轨道；录像 = `.dem` 已解析出整段时长）。
   *
   * 有内容时去掉 `hidden` 类并刷新读数：录像刚载入、用户还没点任何玩家时也要能拖滑杆、能播放
   * （那时一条轨道都还没有，内容来自 `ReplayPlayer.sessionLength`）。
   */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.root.classList.toggle('hidden', !ready);
    this.refresh();
  }

  /**
   * 本会话上场 / 下场（由 `apps/viewer/src/replay/session.ts` 的 `ReplaySession` 调用）。
   *
   * 只影响**快捷键是否生效**：读数的刷新由帧循环驱动（它只刷活动会话），DOM 的显隐由会话容器
   * 的 `.active` 决定。于是「下场的那条时间轴还在、但它不抢键、也不改自己播放器的状态」。
   */
  setOnStage(on: boolean): void {
    this.onStage = on;
  }

  /** 用户**正在**拖滑杆（`pointerdown` 到 `pointerup` 之间）；见 `onUserSeek` 的说明。 */
  get scrubbing(): boolean {
    return this.dragging;
  }

  /**
   * 设置**当前视角人物**的活跃区间（秒，整场时间轴口径，**可多段**）；传 `null` / 空数组表示不画。
   * 仅 `personZones` 档使用。
   *
   * 为什么是列表：同一个人会**中途退出又进来**（`userinfo` 更新流里是两段在场），
   * 压成一段连贯区间就把「他退过服」这件事抹掉了 —— 段与段之间必须留断口。
   */
  setActiveSpan(spans: Array<[number, number]> | null): void {
    this.activeSpans = spans && spans.length > 0 ? spans : null;
  }

  /** 设置**悬停高亮**区间（秒，可多段）；传 `null` 清除。由右侧看板的行悬停驱动。仅 `personZones` 档使用。 */
  setHighlight(spans: Array<[number, number]> | null): void {
    this.hlSpans = spans && spans.length > 0 ? spans : null;
  }

  /**
   * **一次性的「跳到这一跑」区间带**（owner 要求）：点过关记录的跳转按钮时，在滑杆上画出
   * 你即将看到的那一段 `[跳转落点, 播报时刻]`，**播放头走完这一段就自己消失**
   * （清除由 app 的帧循环负责调 `setJumpSpan(null)`）。
   *
   * 与「人物活跃区间」的区别（两者能叠在一起，但语义不同）：
   * 人物带说的是「这个人在整场里什么时候在场」（常驻，随视角人物变），
   * 这条说的是「我刚点了这一跑、接下来这几分钟是它」（**一次性**，过掉就没）。
   * `title` 带上关卡名与用时，鼠标停在带上就能读到「跳的是哪一跑」。
   */
  setJumpSpan(span: { from: number; to: number; title?: string } | null): void {
    this.jumpSpan = span && span.to > span.from ? span : null;
    this.refreshJumpZone();
  }

  /** 当前那一次性区间带（app 的帧循环据此判断「播放头是否已走过这一段」）。 */
  get jumpSpanRange(): { from: number; to: number } | null {
    return this.jumpSpan ? { from: this.jumpSpan.from, to: this.jumpSpan.to } : null;
  }

  /**
   * 把一次性区间带按**当前播放窗口**换算成滑杆上的百分比。
   *
   * 单独一条刷新路径（而不是塞进 `refreshPersonZones`）：`setJumpSpan` 之后窗口未必已经变，
   * 需要立刻画出来给用户反馈；而 `refresh()` 里每帧也会调它，窗口一变（拉 A-B / 换录像）就跟着走。
   */
  private refreshJumpZone(): void {
    const zone = this.jumpZone;
    if (!zone) return;
    const span = this.jumpSpan;
    const p = this.player;
    const win = p.rangeStop - p.rangeStart;
    if (!span || !(win > 0) || !(p.duration > 0)) {
      zone.style.display = 'none';
      return;
    }
    const left = clamp01((span.from - p.rangeStart) / win);
    const right = clamp01((span.to - p.rangeStart) / win);
    if (right - left <= 0.0005) {
      zone.style.display = 'none';
      return;
    }
    zone.style.display = '';
    zone.title = span.title ?? '刚跳过来的那一跑（播放头走过它就消失）';
    zone.style.left = (left * 100).toFixed(3) + '%';
    zone.style.width = ((right - left) * 100).toFixed(3) + '%';
  }

  /** 刷新读数：播放按钮文案与 active 态、时间文本、帧文本、滑杆值（拖动中不回写）、区间读数，最后刷新叠加带。无内容时直接返回。 */
  refresh(): void {
    if (!this.ready) return;
    const p = this.player;
    this.playBtn.textContent = p.playing ? '暂停' : '播放';
    this.playBtn.classList.toggle('active', p.playing);
    // 录像档按**录像内绝对时刻**（`26:05 / 59:58`）显示：长会话里 `0.00 / 3598.00 s` 这种
    // 秒计数读不出「第几分钟」。
    this.timeEl.textContent =
      this.profile.clock === 'wall'
        ? clock(p.time) + ' / ' + clock(p.duration)
        : `${fmtTime(p.time)} / ${fmtTime(p.duration)} s`;
    // 播放中时间码前缀亮 REC 红点（暂停/停止熄灭）——录制指示语彙
    this.timeEl.classList.toggle('rec', p.playing);
    if (this.frameEl) this.frameEl.textContent = frameText(p);
    if (!this.dragging) {
      this.slider.value = String(Math.round(p.ratio * 1000));
    }
    this.refreshZones();
    this.refreshPersonZones();
    this.refreshJumpZone();

    if (this.rangeEl) {
      const inRange = p.rangeEnd > p.rangeStart && !p.isFullWindow;
      this.rangeEl.textContent = inRange
        ? `${fmtTime(p.rangeStart)} → ${fmtTime(p.rangeStop)}（${fmtTime(p.rangeLength)} s）`
        : '整段';
      this.rangeEl.classList.toggle('active', inRange);
    }
  }

  /** 人物叠加带：把 `activeSpans` / `hlSpans` 按**当前播放窗口**换算成滑杆上的百分比（逐段一个 `.tl-seg`）。 */
  private refreshPersonZones(): void {
    if (!this.activeZone && !this.hlZone) return;
    const p = this.player;
    const win = p.rangeStop - p.rangeStart;
    const dur = p.duration;
    // 容器 + 按需增删的段元素：段数随会话给的区间列表变化（一个人会进进出出好几回）。
    const sync = (container: HTMLElement | null, spans: Array<[number, number]> | null): void => {
      if (!container) return;
      if (!spans || spans.length === 0 || !(win > 0) || !(dur > 0)) {
        container.style.display = 'none';
        return;
      }
      container.style.display = '';
      const segs = Array.from(container.children) as HTMLElement[];
      while (segs.length < spans.length) {
        const seg = el('i', 'tl-seg');
        container.appendChild(seg);
        segs.push(seg);
      }
      while (segs.length > spans.length) {
        const drop = segs.pop();
        drop?.remove();
      }
      for (let i = 0; i < spans.length; i++) {
        const seg = segs[i];
        const left = clamp01((spans[i][0] - p.rangeStart) / win);
        const right = clamp01((spans[i][1] - p.rangeStart) / win);
        if (right - left <= 0.0005) {
          seg.style.display = 'none';
          continue;
        }
        seg.style.display = '';
        seg.style.left = (left * 100).toFixed(3) + '%';
        seg.style.width = ((right - left) * 100).toFixed(3) + '%';
      }
    };
    sync(this.activeZone, this.activeSpans);
    sync(this.hlZone, this.hlSpans);
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
      if (this.runZone) this.runZone.style.display = 'none';
      if (this.abBand) this.abBand.style.display = 'none';
      return;
    }
    // 叠加带位置一律按当前播放窗口映射（默认窗口 = 整条 clip，含 prerun 负段）
    const rel = (t: number): number => ((t - winStart) / winLen) * 100;

    // A-B 区间带：只在用户显式设了区间且窗口不是整段时画（整段窗口下整条滑杆就是它）
    if (this.abBand) {
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
    }

    // 正式跑段高亮：左端 = rel(track.offset)；宽度 = (min(runEndLocal, clip.duration) − max(track.offset, winStart)) / winLen，
    // runEndLocal = idxEnd（= preFrames + frameCount）处的帧时间，idxEnd 越界时取 clip.duration。
    if (this.runZone) {
      const track = p.tracks.follow;
      const meta = track?.clip.meta ?? null;
      if (track && meta && meta.frameCount > 0) {
        const idxEnd = meta.preFrames + meta.frameCount;
        const arr = track.clip.t;
        const runEndLocal = idxEnd < track.clip.count ? arr[idxEnd] : track.clip.duration;
        // 左端钳 0：offset 在 prerun 段为负，rel 会给出负百分比把带子推出滑杆左缘；
        // 宽度公式的右端已用 max(offset, winStart) 钳过，两端口径在此对齐
        const left = Math.max(0, rel(track.offset));
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
}

/** 秒 -> m:ss（录像档的时间码：长会话读「第几分钟」比读秒直观）。 */
function clock(t: number): string {
  const s = Math.max(0, Math.round(t));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

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

/** 夹到 [0,1]。 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
