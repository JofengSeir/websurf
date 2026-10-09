/**
 * 播放器：持有主时钟与一组轨道（TrackSet），只认 Clip，不关心 Clip 怎么来的。
 *
 * 主时钟统一驱动所有轨道，各轨道按自己的 Track.offset 换算成内部时间
 * （`apps/viewer/src/replay/tracks.ts` 的 localTime），因此起跑时刻不同的两次跑法能对齐比较。
 * 时间定位走采样模块：二分查找 + 线性插值（yaw/roll 取最短弧，pitch 直接插值）。
 * 支持倍速、A-B 区间、循环、逐帧。
 */

import { indexInClip } from './sampling.js';
import { TrackSet } from './tracks.js';
import type { Clip, Sample, Track, TrackSample } from './types.js';

/** 播放视角：first = 第一人称跟随，third = 第三人称自由观察。 */
export type PlayMode = 'first' | 'third';

export class ReplayPlayer {
  /** 轨道集：本类的增删方法改完都会走 notify；外部读写请成对地配合 onChange。 */
  readonly tracks = new TrackSet();

  /** 当前播放时间（秒，主时钟）。 */
  time = 0;
  /** 播放倍速：update 里主时钟按 dt × speed 推进（时间轴的倍速下拉直接写它）。 */
  speed = 1;
  /** 是否在推进主时钟（update 的入口条件之一）。 */
  playing = false;
  /** 主时钟到达区间末端后是否回绕到区间起点。 */
  loop = true;
  /** 播放视角：默认第一人称（看回放的标准视角），第三人称（自由观察）按需切换。 */
  mode: PlayMode = 'first';

  /** A-B 区间（秒，主时钟）。rangeEnd <= rangeStart 表示未设区间、按整段播放。 */
  rangeStart = 0;
  rangeEnd = 0;

  /** 状态变化回调：时间推进、播放态、区间、轨道增删都会触发。 */
  onChange: ((p: ReplayPlayer) => void) | null = null;

  /** 跟随轨道的 clip（TrackSet.follow 在 followId 失效时回退到第一条；无轨道为 null）。 */
  get clip(): Clip | null {
    return this.tracks.follow?.clip ?? null;
  }

  /**
   * **会话时长兜底**（秒）：会话已经有整段长度、但还没有任何轨道时用它撑起主时钟。
   *
   * 为什么需要：录像（`.dem`）载入后、用户还没点任何玩家时轨道是空的、`tracks.duration` 为 0，
   * 于是 `play()` 直接返回、滑杆也拖不动 —— 表现为"载入完不能播放/暂停"。录像会话在解析成功后
   * 把整段时长写进这里。
   *
   * **只作用于本会话**：记录（`.replay`）会话不写它（恒 0），故记录会话的总长完全由自己的轨道决定。
   * 早先这个字段叫 `span`，并且**被当成"这是录像会话"的会话类型标志**（`span > 0` 时总长与窗口
   * 都无视轨道）—— 那是两个 tab 共用一个播放器时的权宜之计：一旦播放器里残留了另一边的轨道，
   * 主时钟就会被它撑长/压短。两条链路拆成各自独立的会话之后，这个字段回归它的字面语义。
   *
   * **必须是访问器**：`applyFullRange()` 算窗口用的就是它，而窗口是在**加轨道那一刻**算出来并
   * 缓存的 —— 裸字段直接赋值不会让窗口重算，会出现「`duration` 已经是 3598，但 `rangeStop`
   * 还停在 100 秒」这种半截状态（`rangeStop` 才是滑杆真正映射到的终点）。
   */
  private sessionLengthValue = 0;

  get sessionLength(): number {
    return this.sessionLengthValue;
  }

  set sessionLength(v: number) {
    if (this.sessionLengthValue === v) return;
    this.sessionLengthValue = v;
    this.applyFullRange();
    this.notify();
  }

  /**
   * 主时钟总长（秒）= max(各轨道 `offset + clip.duration` 的最大值, `sessionLength`)。
   * 记录会话的 `sessionLength` 恒 0，故总长 = 轨道总长；录像会话有整段时长兜底，
   * 某条玩家轨迹只覆盖他自己在场的那一段，不会把整场长度压短。
   */
  get duration(): number {
    return Math.max(this.tracks.duration, this.sessionLength);
  }

  /** 有效播放区间末端：设了区间取 min(rangeEnd, duration)，未设取 duration。 */
  get rangeStop(): number {
    const d = this.duration;
    return this.rangeEnd > this.rangeStart ? Math.min(this.rangeEnd, d) : d;
  }

  /** 区间长度（秒），恒 ≥ 0。 */
  get rangeLength(): number {
    return Math.max(0, this.rangeStop - this.rangeStart);
  }

  /** 主时钟在区间内的进度；区间长度为 0 时返回 0。 */
  get ratio(): number {
    const len = this.rangeLength;
    return len > 0 ? (this.time - this.rangeStart) / len : 0;
  }

  // ── 轨道管理 ────────────────────────────────────────────────────

  /** 清空轨道后加载一条（null 即只清空）；随后区间复位为整段、时间回到起点、暂停。 */
  load(clip: Clip | null): void {
    this.tracks.clear();
    if (clip) this.tracks.add(clip);
    this.resetRange();
    this.notify();
  }

  /**
   * 追加一条轨道并返回它；当它是第一条时同样复位区间（走 `resetRange`）。
   *
   * **但不能因此把播放态改掉**：`resetRange()` 里带着「暂停」（区间复位语义），而**录像页自动跟随
   * 第一次切人**正是走「加第一条轨道」这条路 ⇒ 它会把正在播放的录像**停住**。owner 实测症状：
   * 「任由其加载后自动播放，replay 或 dem 都会莫名其妙自己暂停」（进度条应当一直动，
   * 只有用户主动暂停才停）。所以这里记下进入时的播放态并**原样恢复**；
   * 「什么时候开始播」由调用方决定（载入完 `play()` / 用户点人 `play()`），加轨道不改它。
   */
  addTrack(clip: Clip, name?: string): Track {
    const wasPlaying = this.playing;
    const first = this.tracks.isEmpty;
    const track = this.tracks.add(clip, name);
    if (first) {
      // 正在播放时**只把窗口拉成整段**：不动主时钟、不改播放态（见上面的说明）。
      if (wasPlaying) {
        this.applyFullRange();
        this.clampTime();
      } else {
        this.resetRange();
      }
    }
    this.notify();
    return track;
  }

  /** 移除轨道，并把主时钟夹回区间内。 */
  removeTrack(id: string): void {
    this.tracks.remove(id);
    this.clampTime();
    this.notify();
  }

  /** 清空全部轨道（等价于 load(null)）。 */
  clearTracks(): void {
    this.load(null);
  }

  /** 切换跟随轨道（第一人称相机与速度读数取它）；TrackSet.setFollow 只接受已存在的 id。 */
  followTrack(id: string): void {
    this.tracks.setFollow(id);
    this.notify();
  }

  /** 区间复位：窗口取整段、主时钟回到窗口起点、暂停。 */
  private resetRange(): void {
    this.applyFullRange();
    this.time = this.rangeStart;
    this.playing = false;
  }

  /**
   * 播放窗口复位为**整条 clip**（含 prerun 与 post）。
   * 主时钟 0 = 起跑帧的语义不变；首帧 t[0] 为负（prerun）时窗口起点即片头。
   */
  clearRange(): void {
    this.applyFullRange();
    this.time = Math.max(this.rangeStart, Math.min(this.rangeStop, this.time));
    this.notify();
  }

  /**
   * 整段窗口：起点 = `min(0, 首轨道首帧时间)`，终点 = 主时钟总长。
   *
   * 两条链路各自在一个独立会话里，共用同一个公式而不会互相干扰：
   * - 记录（`.replay`）的帧时间是**相对起跑帧**的（prerun 为负）⇒ 起点落在片头、终点 = 末帧；
   * - 录像（`.dem`）的帧时间是**录像内绝对时刻**（首帧 > 0）⇒ 起点 0、终点 = `sessionLength`（整场）。
   */
  private applyFullRange(): void {
    const first = this.tracks.tracks[0]?.clip;
    const t0 = first && first.count > 0 ? first.t[0] : 0;
    this.rangeStart = Math.min(0, t0);
    this.rangeEnd = Math.max(this.tracks.duration, this.sessionLength);
  }

  /** 当前窗口是否等于默认整段（时间轴据此显示「整段」而不是区间读数）。 */
  get isFullWindow(): boolean {
    const first = this.tracks.tracks[0]?.clip;
    const t0 = first && first.count > 0 ? first.t[0] : 0;
    return (
      this.rangeEnd > this.rangeStart &&
      this.rangeStart === Math.min(0, t0) &&
      Math.abs(this.rangeEnd - this.duration) < 1e-9
    );
  }

  // ── 播放控制 ────────────────────────────────────────────────────

  /** 开始播放：既无轨道又无会话时长时不动；主时钟已在区间末端（1e-6 容差内）时先退回区间起点。 */
  play(): void {
    if (this.tracks.isEmpty && this.sessionLength <= 0) return;
    if (this.time >= this.rangeStop - 1e-6) this.time = this.rangeStart;
    this.playing = true;
    this.notify();
  }

  /** 暂停（主时钟不动）。 */
  pause(): void {
    this.playing = false;
    this.notify();
  }

  /** 在播放与暂停之间切换。 */
  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 停止：暂停并把主时钟退回区间起点。 */
  stop(): void {
    this.playing = false;
    this.time = this.rangeStart;
    this.notify();
  }

  /** 绝对定位（主时钟秒），夹到 [rangeStart, rangeStop]。 */
  seek(t: number): void {
    const lo = this.rangeStart;
    const hi = this.rangeStop;
    this.time = Math.max(lo, Math.min(hi, t));
    this.notify();
  }

  /** 按区间比例定位：r 夹到 [0, 1] 后换算成主时钟时间再 seek。 */
  seekRatio(r: number): void {
    this.seek(this.rangeStart + this.rangeLength * Math.max(0, Math.min(1, r)));
  }

  /** 逐帧步进（n 可负），步长按**跟随轨道**的帧号。 */
  stepFrames(n: number): void {
    const track = this.tracks.follow;
    const c = track?.clip;
    if (!track || !c || c.count === 0) return;
    const idx = this.indexAt(this.time);
    const next = Math.max(0, Math.min(c.count - 1, idx + n));
    // c.t 是轨道内部时间，seek 用的是主时钟
    this.seek(c.t[next] + track.offset);
  }

  /** 按 dt 推进主时钟（dt × speed）：到区间末端时回绕或停在末端并暂停。 */
  update(dt: number): void {
    if (!this.playing || (this.tracks.isEmpty && this.sessionLength <= 0)) return;
    const len = this.rangeLength;
    if (len <= 0) return;
    this.time += dt * this.speed;
    if (this.time >= this.rangeStop) {
      if (this.loop) {
        const over = this.time - this.rangeStop;
        this.time = this.rangeStart + (len > 0 ? over % len : 0);
      } else {
        this.time = this.rangeStop;
        this.playing = false;
      }
    }
    this.notify();
  }

  // ── 采样 ────────────────────────────────────────────────────────

  /** 主时钟 t 对应的跟随轨道帧号（插值左端）；未到该轨道片头或无轨道时返回 0。 */
  indexAt(t: number): number {
    const track = this.tracks.follow;
    if (!track) return 0;
    const local = this.tracks.localTime(track, t);
    return local === null ? 0 : indexInClip(track.clip, local);
  }

  /** 当前主时钟下跟随轨道的插值位姿（第一人称相机取它）。 */
  sample(): Sample | null {
    return this.sampleAt(this.time);
  }

  /** 指定主时钟时刻下跟随轨道的插值位姿；未到片头或无轨道时返回 null。 */
  sampleAt(t: number): Sample | null {
    const track = this.tracks.follow;
    return track ? this.tracks.sample(track, t) : null;
  }

  /** 所有轨道在当前主时钟的采样（含不可见轨道，渲染层按 Track.visible 过滤）。 */
  sampleAll(): TrackSample[] {
    return this.tracks.sampleAll(this.time);
  }

  /** 把主时钟夹回当前区间。 */
  private clampTime(): void {
    this.time = Math.max(this.rangeStart, Math.min(this.rangeStop, this.time));
  }

  /** 触发 onChange（本类各状态变更方法的收尾）。 */
  private notify(): void {
    this.onChange?.(this);
  }
}
