/**
 * 多轨迹容器（Q2：同时加载多条轨迹做对比）。
 *
 * 主时钟由 ReplayPlayer 持有，各轨道按自己的 `offset` 映射到内部时间——
 * 这样起跑时刻不同的两次跑法可以对齐到同一条时间轴上比较。
 */

import { sampleClip } from './sampling.js';
import type { Clip, Sample, Track, TrackSample } from './types.js';

/** 轨道配色（按添加顺序取；超过就循环）。 */
export const TRACK_PALETTE: readonly number[] = [
  0x8ab4f8, // 蓝（与 viewer 主色一致，第一条沿用旧观感）
  0xf9a03f, // 橙
  0x4ade80, // 绿
  0xf87171, // 红
  0xc084fc, // 紫
  0x22d3ee, // 青
  0xfacc15, // 黄
  0xf472b6, // 粉
];

export class TrackSet {
  readonly tracks: Track[] = [];
  /** 被跟随的轨道（第一人称相机 / 速度读数取它）。 null 时回退到第一条。 */
  followId: string | null = null;

  private seq = 0;

  add(clip: Clip, name?: string): Track {
    const track: Track = {
      id: `track-${++this.seq}`,
      name: name?.trim() || clip.name || `轨迹 ${this.tracks.length + 1}`,
      clip,
      color: TRACK_PALETTE[this.tracks.length % TRACK_PALETTE.length],
      visible: true,
      offset: 0,
    };
    this.tracks.push(track);
    if (this.followId === null) this.followId = track.id;
    return track;
  }

  /**
   * 用新 clip 替换某条轨道的内容，**保留**配色 / 显隐 / 偏移 / 名字。
   * 改规则后重新导入走这条路径——否则每次改规则都会多出一条重复轨迹。
   * 轨道不存在返回 false（调用方改为追加）。
   */
  replaceClip(id: string, clip: Clip): boolean {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return false;
    track.clip = clip;
    return true;
  }

  remove(id: string): void {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    if (this.followId === id) this.followId = this.tracks[0]?.id ?? null;
  }

  clear(): void {
    this.tracks.length = 0;
    this.followId = null;
  }

  get isEmpty(): boolean {
    return this.tracks.length === 0;
  }

  /** 当前跟随的轨道（id 失效时回退到第一条）。 */
  get follow(): Track | null {
    return this.tracks.find((t) => t.id === this.followId) ?? this.tracks[0] ?? null;
  }

  setFollow(id: string): void {
    if (this.tracks.some((t) => t.id === id)) this.followId = id;
  }

  /**
   * 主时钟总长：各轨道 (offset + 自身时长) 的最大值。
   * 短的轨道播完就停在终点，不影响总长。
   */
  get duration(): number {
    let d = 0;
    for (const t of this.tracks) d = Math.max(d, t.offset + t.clip.duration);
    return d;
  }

  /**
   * 主时钟 t → 轨道内部时间。
   * 还没开始返回 null（幽灵不显示）；已播完夹到末帧（停在终点，便于看谁先到）。
   */
  localTime(track: Track, t: number): number | null {
    const local = t - track.offset;
    if (local < 0) return null;
    return Math.min(local, track.clip.duration);
  }

  sample(track: Track, t: number): Sample | null {
    const local = this.localTime(track, t);
    return local === null ? null : sampleClip(track.clip, local);
  }

  /** 主时钟 t 时刻所有轨道的采样（含不可见的，渲染层自行过滤）。 */
  sampleAll(t: number): TrackSample[] {
    return this.tracks.map((track) => ({ track, sample: this.sample(track, t) }));
  }
}
