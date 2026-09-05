/**
 * 录像播放器：持有**主时钟**与一组轨道（TrackSet），只认 Clip（标准帧），不关心规则怎么来的。
 *
 * 单轨道时行为与以前完全一致；多轨道时主时钟统一驱动所有轨道，
 * 各轨道按自己的 offset 对齐——用来对比起跑时刻不同的两次跑法。
 * 时间定位：二分查找 + 线性插值（yaw/roll 走最短弧，pitch 直接插值）。
 * 支持倍速、A-B 区间、循环、逐帧。
 */

import { indexInClip, sampleClip, horizontalSpeed as horizSpeed } from './sampling.js';
import { TrackSet } from './tracks.js';
import type { Clip, Sample, Track, TrackSample } from './types.js';

export type PlayMode = 'first' | 'third';

export class ReplayPlayer {
  /** 轨道集；增删改后记得通知渲染层重建。 */
  readonly tracks = new TrackSet();

  /** 当前播放时间（秒，主时钟）。 */
  time = 0;
  speed = 1;
  playing = false;
  loop = true;
  /** 播放视角：默认第一人称——看录像的标准姿势；第三人称（自由观察）按需切换。 */
  mode: PlayMode = 'first';

  /** A-B 区间（秒）。end <= start 表示整段。 */
  rangeStart = 0;
  rangeEnd = 0;

  onChange: ((p: ReplayPlayer) => void) | null = null;

  /** 跟随轨道的 clip（单轨道场景等价于「当前录像」）。 */
  get clip(): Clip | null {
    return this.tracks.follow?.clip ?? null;
  }

  get duration(): number {
    return this.tracks.duration;
  }

  /** 有效播放区间末端。 */
  get rangeStop(): number {
    const d = this.duration;
    return this.rangeEnd > this.rangeStart ? Math.min(this.rangeEnd, d) : d;
  }

  get rangeLength(): number {
    return Math.max(0, this.rangeStop - this.rangeStart);
  }

  get ratio(): number {
    const len = this.rangeLength;
    return len > 0 ? (this.time - this.rangeStart) / len : 0;
  }

  // ── 轨道管理 ────────────────────────────────────────────────────

  /** 清空后加载一条（旧的单录像语义）。 */
  load(clip: Clip | null): void {
    this.tracks.clear();
    if (clip) this.tracks.add(clip);
    this.resetRange();
    this.notify();
  }

  /** 追加一条（多轨迹对比）。第一条加入时会复位时钟与区间。 */
  addTrack(clip: Clip, name?: string): Track {
    const first = this.tracks.isEmpty;
    const track = this.tracks.add(clip, name);
    if (first) this.resetRange();
    this.notify();
    return track;
  }

  removeTrack(id: string): void {
    this.tracks.remove(id);
    this.clampTime();
    this.notify();
  }

  clearTracks(): void {
    this.load(null);
  }

  /** 切换第一人称跟随 / 速度读数取自哪条轨道。 */
  followTrack(id: string): void {
    this.tracks.setFollow(id);
    this.notify();
  }

  private resetRange(): void {
    this.rangeStart = 0;
    this.rangeEnd = 0;
    this.time = 0;
    this.playing = false;
  }

  // ── 播放控制 ────────────────────────────────────────────────────

  play(): void {
    if (this.tracks.isEmpty) return;
    if (this.time >= this.rangeStop - 1e-6) this.time = this.rangeStart;
    this.playing = true;
    this.notify();
  }

  pause(): void {
    this.playing = false;
    this.notify();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  stop(): void {
    this.playing = false;
    this.time = this.rangeStart;
    this.notify();
  }

  seek(t: number): void {
    const lo = this.rangeStart;
    const hi = this.rangeStop;
    this.time = Math.max(lo, Math.min(hi, t));
    this.notify();
  }

  seekRatio(r: number): void {
    this.seek(this.rangeStart + this.rangeLength * Math.max(0, Math.min(1, r)));
  }

  /** 逐帧步进（n 可负），相对**跟随轨道**的帧号。 */
  stepFrames(n: number): void {
    const track = this.tracks.follow;
    const c = track?.clip;
    if (!track || !c || c.count === 0) return;
    const idx = this.indexAt(this.time);
    const next = Math.max(0, Math.min(c.count - 1, idx + n));
    // c.t 是轨道内部时间，seek 用的是主时钟
    this.seek(c.t[next] + track.offset);
  }

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

  /** 当前帧序号（跟随轨道，插值左端）。 */
  indexAt(t: number): number {
    const track = this.tracks.follow;
    if (!track) return 0;
    const local = this.tracks.localTime(track, t);
    return local === null ? 0 : indexInClip(track.clip, local);
  }

  /** 跟随轨道在主时钟 t 的插值位姿（第一人称相机取它）。 */
  sample(): Sample | null {
    return this.sampleAt(this.time);
  }

  sampleAt(t: number): Sample | null {
    const track = this.tracks.follow;
    return track ? this.tracks.sample(track, t) : null;
  }

  /** 所有轨道在当前主时钟的采样（渲染层按 visible 过滤）。 */
  sampleAll(): TrackSample[] {
    return this.tracks.sampleAll(this.time);
  }

  /** 水平速度（HU/s），无速度数据返回 null。 */
  horizontalSpeed(s: Sample | null): number | null {
    return horizSpeed(s);
  }

  /** 直接按 clip 内部时间采样（工具/调试用，不走 offset）。 */
  static sampleClipAt(clip: Clip, t: number): Sample | null {
    return sampleClip(clip, t);
  }

  private clampTime(): void {
    this.time = Math.max(this.rangeStart, Math.min(this.rangeStop, this.time));
  }

  private notify(): void {
    this.onChange?.(this);
  }
}
