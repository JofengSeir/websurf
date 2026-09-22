/**
 * 录像播放器：持有主时钟与一组轨道（TrackSet），只认 Clip，不关心 Clip 怎么来的。
 *
 * 主时钟统一驱动所有轨道，各轨道按自己的 Track.offset 换算成内部时间
 * （`apps/viewer/src/replay/tracks.ts` 的 localTime），因此起跑时刻不同的两次跑法能对齐比较。
 * 时间定位走采样模块：二分查找 + 线性插值（yaw/roll 取最短弧，pitch 直接插值）。
 * 支持倍速、A-B 区间、循环、逐帧。
 */

import { indexInClip, sampleClip, horizontalSpeed as horizSpeed } from './sampling.js';
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
  /** 播放视角：默认第一人称（看录像的标准视角），第三人称（自由观察）按需切换。 */
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

  /** 主时钟总长：各轨道 (offset + 自身时长) 的最大值。 */
  get duration(): number {
    return this.tracks.duration;
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

  /** 追加一条轨道并返回它；当它是第一条时同样复位区间（走 resetRange）。 */
  addTrack(clip: Clip, name?: string): Track {
    const first = this.tracks.isEmpty;
    const track = this.tracks.add(clip, name);
    if (first) this.resetRange();
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

  /** 整段窗口：起点 = min(0, 首轨道首帧时间)（容纳 prerun 负段），终点 = 主时钟总长。 */
  private applyFullRange(): void {
    const first = this.tracks.tracks[0]?.clip;
    const t0 = first && first.count > 0 ? first.t[0] : 0;
    this.rangeStart = Math.min(0, t0);
    this.rangeEnd = this.tracks.duration;
  }

  /** 当前窗口是否等于默认整段（时间轴据此显示「整段」而不是区间读数）。 */
  get isFullWindow(): boolean {
    const first = this.tracks.tracks[0]?.clip;
    const t0 = first && first.count > 0 ? first.t[0] : 0;
    return (
      this.rangeEnd > this.rangeStart &&
      this.rangeStart === Math.min(0, t0) &&
      Math.abs(this.rangeEnd - this.tracks.duration) < 1e-9
    );
  }

  // ── 播放控制 ────────────────────────────────────────────────────

  /** 开始播放：无轨道时不动；主时钟已在区间末端（1e-6 容差内）时先退回区间起点。 */
  play(): void {
    if (this.tracks.isEmpty) return;
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
    if (!this.playing || this.tracks.isEmpty) return;
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

  /** 水平速度（HU/s）：转发 `apps/viewer/src/replay/sampling.ts` 的 `horizontalSpeed`；无速度数据返回 null。
   *  本方法在本仓无调用点——遥测 HUD 自己算（`apps/viewer/src/ui/telemetry.ts` 的
   *  `Math.hypot(s.vel[0], s.vel[2])`）。 */
  horizontalSpeed(s: Sample | null): number | null {
    return horizSpeed(s);
  }

  /** 按 clip 内部时间采样（不经 `Track.offset`）；本仓无调用点——全仓仅此处定义，未接任何 UI 或测试。 */
  static sampleClipAt(clip: Clip, t: number): Sample | null {
    return sampleClip(clip, t);
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
