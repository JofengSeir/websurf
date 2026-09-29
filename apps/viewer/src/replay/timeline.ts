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

/** 事件标记并簇的阈值（占全程比例）：相距小于它的点合成一簇，避免重叠成一团看不清。 */
/** 花名册条目：一个圆的全部依据（rom/	o 是**全程 tick**，不是比例）。 */
export interface PresenceEntry {
  /** 花名册内的唯一键（同一实体可先后被多人占用，故不能用 entity 当键）。 */
  key: number;
  name: string;
  isBot: boolean;
  entity: number;
  /** 进入 / 退出的全程 tick；	o 为 Infinity 表示直到录像结束都在场。 */
  from: number;
  to: number;
}

/**
 * 花名册最多画几组标记。
 *
 * **不再是 5**：`5` 是当年「圆簇堆在播放头处」时的上限，语义是"同屏最多几个圆"。
 * 现在标记**钉在各自加入时刻**上（占用事件粒度，这份录像有 11 条），上限若还是 5，
 * 就会把**后半段加入的记录机器人整批裁掉** —— 正是「中途加进来几位但没显示加入位置」的成因。
 * 标记按位置分开，拥挤与否交给 CSS，不该由数量上限决定谁被丢掉。
 */
const MAX_PRESENCE = 64;

export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly timeEl: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly runZone: HTMLElement;
  private readonly abBand: HTMLElement;
  private readonly rangeEl: HTMLElement;
  /** 滑杆上的事件标记层（贴滑杆顶端的一排小圆点）。 */
  private readonly marksLayer: HTMLElement;
  /** 播放头处的人物圆簇容器（跟着主时钟走）。 */
  private presence!: HTMLElement;
  /** 由演示页提供的「此刻在场的人」查询；未设置则圆簇不出现。 */
  private presenceOf: ((ratio: number) => ReadonlyArray<PresenceEntry>) | null = null;
  private onPickEntity: ((entity: number) => void) | null = null;
  /** 上一次圆簇的「位置 + 成员」签名：没变就不写 DOM，避免每帧重建打断悬停。 */
  private presenceSig = '';
  /** 当前视角人物的活跃区间（秒）；
ull = 不画。 */
  private activeSpan: [number, number] | null = null;
  /** 悬停高亮区间（秒）；
ull = 不画。 */
  private hlSpan: [number, number] | null = null;
  private activeZone!: HTMLElement;
  private hlZone!: HTMLElement;
  /** 全程总 tick：把花名册的 tick 区间换算成时间标注用（由演示页在 setPresence 时给出）。 */
  private totalTicks = 1;
  /** 是否有轨道：false 时整条时间轴加 hidden 类，refresh 与快捷键直接返回；读数一律现取，不缓存。 */
  private hasTracks = false;
  /** 是否演示（长会话）模式：为真时时间码按「录像内绝对时刻」显示，并收起 replay 专用控件。 */
  private demoMode = false;
  /** 是否已打过事件标记：演示录像载入后即成立（此时还没有轨道），时间轴也该保持可见、滑杆可拖。 */
  private hasMarks = false;
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

    // 事件标记层：紧贴滑杆顶端，压在滑杆之下（滑杆 z-index 2），不吃指针事件（点由 .tl-mark 自己接）
    // 两条区间带：当前视角人物的活跃区间 + 悬停高亮（都叠在滑杆上，与 replay 的跑段高亮同族）
    this.activeZone = el('div', 'tl-zone tl-zone-active');
    this.activeZone.style.display = 'none';
    this.activeZone.title = '当前视角人物在这段录像里的活跃区间';
    wrap.appendChild(this.activeZone);
    this.hlZone = el('div', 'tl-zone tl-zone-hl');
    this.hlZone.style.display = 'none';
    wrap.appendChild(this.hlZone);

    this.marksLayer = el('div', 'tl-marks hidden');
    wrap.appendChild(this.marksLayer);

    // 播放头处的人物圆簇：默认隐藏，演示页调 setPresence 后才出现
    this.presence = el('div', 'tl-presence');
    this.presence.hidden = true;
    wrap.appendChild(this.presence);

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

    const prevBtn = el('button', 'btn small tl-only-replay', '◀ 帧', { type: 'button', title: '上一帧（,）' });
    prevBtn.addEventListener('click', () => this.player.stepFrames(-1));
    controls.appendChild(prevBtn);

    const nextBtn = el('button', 'btn small tl-only-replay', '帧 ▶', { type: 'button', title: '下一帧（.）' });
    nextBtn.addEventListener('click', () => this.player.stepFrames(1));
    controls.appendChild(nextBtn);

    this.timeEl = el('span', 'tl-time', '0.00 / 0.00 s');
    this.timeEl.title = '当前 / 总时长（秒，主时钟）；0 = 起跑帧，prerun 帧不在播放区间';
    controls.appendChild(this.timeEl);

    this.frameEl = el('span', 'tl-frame tl-only-replay', '0/0 帧');
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
    const aBtn = el('button', 'btn small tl-only-replay', 'A 起点', {
      type: 'button',
      title: '以当前时间作为区间起点（快捷键 I）',
    });
    aBtn.addEventListener('click', () => this.setRangeStart());
    opts.appendChild(aBtn);

    const bBtn = el('button', 'btn small tl-only-replay', 'B 终点', {
      type: 'button',
      title: '以当前时间作为区间终点（快捷键 O）',
    });
    bBtn.addEventListener('click', () => this.setRangeEnd());
    opts.appendChild(bBtn);

    const clearRangeBtn = el('button', 'btn small tl-only-replay', '整段', {
      type: 'button',
      title: '清除区间，恢复整段播放',
    });
    clearRangeBtn.addEventListener('click', () => {
      this.player.clearRange();
      this.refresh();
    });
    opts.appendChild(clearRangeBtn);

    this.rangeEl = el('span', 'tl-range tl-only-replay', '整段');
    opts.appendChild(this.rangeEl);

    root.appendChild(opts);

    window.addEventListener('keydown', (e) => {
      if (!this.hasTracks && !this.hasMarks) return;
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
    // **有标记就不隐藏**：演示录像载入后没有轨道但有标记，此时必须留着胶片条与滑杆
    // （否则 onLoaded 刚放出来，紧接着的 syncTracks 又把它藏回去）。
    this.root.classList.toggle('hidden', !this.hasTracks && !this.hasMarks);
    this.refresh();
  }

  /**
   * **播放头处的人物圆簇 + 悬停上弹的视角选择块**（owner 定稿形态）。
   *
   * 滑杆当前位置上立一簇**较大的圆**，一个圆 = 一个此刻在场的人物；**最多 `MAX_PRESENCE` 个**，
   * 超出时**先保真人**（脚本先被挤出），真人再溢出才用 `…` 收尾。
   * **鼠标悬停到簇上**向上弹出选择块，块内逐行列出此刻在场的人；**点一行即切到那个人的视角**。
   *
   * 由 `refresh()` 每帧重画：簇要**跟着播放头走**，位置与内容都随主时钟变；
   * 位置与成员都没变时零写入，避免每帧重建把悬停打断。
   */
  setPresence(
    provider: (ratio: number) => ReadonlyArray<PresenceEntry>,
    onPick?: (entity: number) => void,
    totalTicks = 1,
  ): void {
    this.presenceOf = provider;
    this.onPickEntity = onPick ?? null;
    this.totalTicks = totalTicks;
    // **条上不再画人物标记**（owner 定稿：太复杂）。花名册与在线态移到右侧看板，
    // 条上只保留「当前视角人物的活跃区间」与「悬停某人时高亮他的区间」两条带。
    this.presence.hidden = true;
    this.presence.innerHTML = '';
    this.hasMarks = true;
    this.presence.hidden = false;
    this.root.classList.remove('hidden');
  }

  /**
   * **重画播放头处的花名册圆簇**。
   *
   * owner 定稿的语义（与"只显示此刻在场的人"不同）：
   * - 圆簇是**一份稳定的花名册** —— 整条录像里出现过的每个人都占一个圆，**不随播放头增减**，
   *   这样才看得出"谁什么时候进、谁什么时候退"；早先按"此刻在场"过滤，人一进出圆就跳变，数量对不上。
   * - 每人三种状态：**未加入**（播放头还没到他的进入时刻）画成**虚像**（空心）；
   *   **在场**画成实心；**已退出**画成**暗色 + 一道斜杠**，表示"这人已经走了"。
   * - **只收录有有效视角的人**：`presenceWindows` 已按"有采样轨迹"过滤，故圆 = 一个可切过去的视角。
   * - 超过上限时**先保真人**（脚本先被挤出），真人再溢出才用 `…` 收尾。
   *
   * 位置与成员都没变时零写入，避免每帧重建把悬停打断。
   */
  /**
   * **在滑杆上按「真实进入时刻」摆人物标记**（owner 定稿的视觉形态）。
   *
   * 形态：`—|当前位置—— ①实像 ——|进入后上移—— ①虚像 ——|到这里后实像消失——`
   * - 每个标记**钉在该人真实的进入时刻**上（不是跟着播放头跑）——这样才能一眼看出"谁在哪一刻进"；
   * - **播放头还没到他的进入时刻** ⇒ **虚像**（空心虚线环，落在滑杆中线上）；
   * - **播放头进入他的在场区间** ⇒ **实像**，并**抬到滑杆上方**（上移 = "这个人现在在场"）；
   * - **播放头越过他的退出时刻** ⇒ 实像消失，只留一枚**暗色残影**（看得出他曾在这个位置进场过）。
   *
   * **为什么不整段重建 DOM**：早先每帧按「位置 + 成员」重写 `innerHTML`，播放时签名每帧都变 ⇒
   * 鼠标刚移到弹出框上，节点就被换掉、hover 丢失，**根本点不到**（owner 实测）。现在拆成两件事：
   * **成员变了才重建**；**状态变了只切 class**；悬停期间连位置都不动。
   */
  /**
   * **条上只画两条区间带**（owner 定稿，取代此前那套人物标记）：
   *
   * 1. **当前视角人物的活跃区间**（`.tl-zone-active`）—— 就像 replay 的跑段高亮：你选了谁，
   *    条上就标出「这个人在整场里的哪一段有数据」。时长按**整段录像**换算，不随选中而改变条长。
   * 2. **悬停高亮**（`.tl-zone-hl`）—— 鼠标停在右侧看板某一行上时，把**那一行对应的区间**
   *    画到条上；移开即清除。这样「进服顺序 / 谁什么时候在线」放在看板里看，
   *    条上只在需要时临时显示某一个人的区间，不再堆二十几枚标记。
   */
  private refreshPresence(): void {
    const p = this.player;
    const win = p.rangeStop - p.rangeStart;
    const dur = p.duration;
    const put = (el2: HTMLElement, from: number, to: number): void => {
      if (!(win > 0) || !(dur > 0)) {
        el2.style.display = 'none';
        return;
      }
      const left = clamp01((from - p.rangeStart) / win);
      const right = clamp01((to - p.rangeStart) / win);
      if (right - left <= 0.0005) {
        el2.style.display = 'none';
        return;
      }
      el2.style.display = '';
      el2.style.left = (left * 100).toFixed(3) + '%';
      el2.style.width = ((right - left) * 100).toFixed(3) + '%';
    };
    if (this.activeSpan) put(this.activeZone, this.activeSpan[0], this.activeSpan[1]);
    else this.activeZone.style.display = 'none';
    if (this.hlSpan) put(this.hlZone, this.hlSpan[0], this.hlSpan[1]);
    else this.hlZone.style.display = 'none';
  }

  /** 设置**当前视角人物**的活跃区间（秒，整场时间轴口径）；传 `null` 表示不画。 */
  setActiveSpan(span: [number, number] | null): void {
    this.activeSpan = span;
  }

  /** 设置**悬停高亮**区间（秒）；传 `null` 清除。由右侧看板的行悬停驱动。 */
  setHighlight(span: [number, number] | null): void {
    this.hlSpan = span;
  }
  private fmtSpan(from: number, to: number): string {
    const t = this.totalTicks;
    const f = (x: number): string => {
      const s = t > 0 ? (x / t) * this.player.duration : 0;
      const m = Math.floor(s / 60);
      return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    };
    return f(from) + ' – ' + f(to);
  }
  /** 文本转义（圆簇与选择块里要写玩家名，名字来自录像、不可信）。 */
  private esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  }

  /**
   * **演示（长会话）模式**：把只服务于 replay「严格比较记录」的控件收起来。
   *
   * owner 的判据：一段近一小时的录像要看的是「某个人这段时间在干什么」，而不是「两条记录谁快」——
   * 所以 **A/B 区间与「整段」**（这三个都是**强制定义长度**的行为）、**帧步进与 `帧 · run` 读数**
   * （比较用的精度）在这个 tab 里没有意义，直接不显示。
   * 保留：播放 / 暂停 / 停止 / 拖拽当前位置 / 倍速 / 视角与显示开关。
   */
  setDemoMode(on: boolean): void {
    this.root.classList.toggle('tl-demo', on);
    this.demoMode = on;
    // **进演示模式就把胶片放出来**：`.dem` 一解析完就该看见这条进度条，
    // 而不是等播放头走到第一个人进场、`pickEntity` 建出轨道之后才出现
    // （owner 实测到的「加载完成后没从 0s 播放、像先藏起来等机器人进来」）。
    // 演示录像的时长由 `player.span` 兜底，此刻没有任何轨道也能显示与拖动。
    if (on) {
      this.hasMarks = true;
      this.root.classList.remove('hidden');
      this.refresh();
    }
  }

  /** 刷新读数：播放按钮文案与 active 态、时间文本、帧文本、滑杆值（拖动中不回写）、区间读数，最后刷新两条叠加带。无轨道时直接返回。 */
  refresh(): void {
    if (!this.hasTracks && !this.hasMarks) return;
    const p = this.player;
    this.playBtn.textContent = p.playing ? '暂停' : '播放';
    this.playBtn.classList.toggle('active', p.playing);
    // 演示模式按**录像内绝对时刻**（`26:05 / 59:58`）显示：长会话里 `0.00 / 3598.00 s` 这种
    // 秒计数读不出「第几分钟」，正是「只适合严格比较记录」的读法。
    this.timeEl.textContent = this.demoMode
      ? clock(p.time) + ' / ' + clock(p.duration)
      : `${fmtTime(p.time)} / ${fmtTime(p.duration)} s`;
    // 播放中时间码前缀亮 REC 红点（暂停/停止熄灭）——录制指示语彙
    this.timeEl.classList.toggle('rec', p.playing);
    this.frameEl.textContent = frameText(p);
    if (!this.dragging) {
      this.slider.value = String(Math.round(p.ratio * 1000));
    }
    this.refreshZones();
    this.refreshPresence();

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

/** 秒 → 两位小数字符串；非有限值按 '0.00' 输出。 */
/** 秒 -> m:ss（演示模式的时间码：长会话读「第几分钟」比读秒直观）。 */
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
