/**
 * 多轨迹容器：同时持有多份 Clip 及其展示属性，并把主时钟映射到每条轨道自己的内部时间。
 *
 * 职责边界：本文件只做「容器 + 时间换算 + 采样转发」，不持有主时钟（主时钟在
 * `apps/viewer/src/replay/player.ts` 的 `ReplayPlayer`），也不碰 DOM 与 3D 对象。
 *
 * 关键不变量：
 * - 时间两套基准——方法形参 `t` 一律是**主时钟**秒；某条轨道的内部时间 = `t − Track.offset`，
 *   故 `Track.offset` 大的那条在同一主时钟下更晚起步；轨道内部时间再交给
 *   `apps/viewer/src/replay/sampling.ts` 的 `sampleClip` 采样。
 * - `Track.id` 取 `add` 的调用序号（与颜色无关），且 `seq` 只增不减；`Track.color` 取 `tracks`
 *   当前长度对 `TRACK_PALETTE` 取模，故移除一条后再 `add` 会重新拿到被移除那条的颜色。
 * - 采样结果与 `Track.visible` 无关：隐藏只影响渲染，不影响 `sample` / `sampleAll` 的返回。
 *
 * 交互方：`ReplayPlayer` 持有唯一实例并封装增删（`addTrack` / `removeTrack` / `clearTracks` /
 * `followTrack`）；`apps/viewer/src/replay/visuals.ts` 与 `apps/viewer/src/replay/trackpanel.ts`
 * 经 `ReplayPlayer.tracks` 直接读写轨道属性；导出 `TrackSet` 与 `TRACK_PALETTE` 在
 * `apps/viewer/src/replay/` 之外无使用者。
 */

import { sampleClip } from './sampling.js';
import type { Clip, Sample, Track, TrackSample } from './types.js';

/** 轨道配色表（八项）：`add` 取 `tracks.length % 长度`，即按当前轨道数循环取色。 */
export const TRACK_PALETTE: readonly number[] = [
  0x8ab4f8, // 蓝：viewer 主色
  0xf9a03f, // 橙
  0x4ade80, // 绿
  0xf87171, // 红
  0xc084fc, // 紫
  0x22d3ee, // 青
  0xfacc15, // 黄
  0xf472b6, // 粉
];

export class TrackSet {
  /** 轨道列表，添加顺序即面板与调色顺序。外部直接读写（`ReplayPlayer`、可视化、轨迹面板）。 */
  readonly tracks: Track[] = [];
  /** 跟随目标的 id：第一人称相机与速度读数取它。 null 表示未挑过目标，`follow` 回退到第一条。 */
  followId: string | null = null;

  /** id 序号：`add` 每次自增，生成 `track-<n>`。 */
  private seq = 0;

  /** 追加一条轨道：id 取自增序号，名字按「显式 name → clip.name → 轨迹 <序号>」回退，配色按下标取模。第一条轨道同时被设为跟随目标。 */
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
   * 用新 clip 换掉某条轨道的内容，**只**写 `clip` 一个字段——配色 / 显隐 / 偏移 / 名字全部按原样留下，
   * 也不新增轨道。返回是否命中：id 不存在时返回 false 且不做任何改动。
   */
  replaceClip(id: string, clip: Clip): boolean {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return false;
    track.clip = clip;
    return true;
  }

  /** 移除指定 id 的轨道（id 不存在时原样返回）。被移除的正是跟随目标时，`followId` 改指剩下的第一条；已无轨道则置 null。 */
  remove(id: string): void {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    if (this.followId === id) this.followId = this.tracks[0]?.id ?? null;
  }

  /** 清空轨道并复位跟随目标（`seq` 不复位，故清空后新增的 id 不会与旧轨道的重号）。 */
  clear(): void {
    this.tracks.length = 0;
    this.followId = null;
  }

  /** 是否一条轨道都没有（`ReplayPlayer.play` 用它挡掉空播放）。 */
  get isEmpty(): boolean {
    return this.tracks.length === 0;
  }

  /** 当前跟随的轨道：`followId` 命中即返回它，未命中回退第一条，无轨道返回 null。 */
  get follow(): Track | null {
    return this.tracks.find((t) => t.id === this.followId) ?? this.tracks[0] ?? null;
  }

  /** 设置跟随目标；传入的 id 不存在时保留原值（`ReplayPlayer.followTrack` 转发到这里）。 */
  setFollow(id: string): void {
    if (this.tracks.some((t) => t.id === id)) this.followId = id;
  }

  /**
   * 主时钟总长（秒）= 各轨道 `offset + clip.duration` 的最大值；无轨道为 0。
   * 短轨道在其末端之后不再增长总长。
   */
  get duration(): number {
    let d = 0;
    for (const t of this.tracks) d = Math.max(d, t.offset + t.clip.duration);
    return d;
  }

  /**
   * 主时钟 `t` → 该轨道的内部时间（秒）：`local = t − track.offset`，
   * 上界夹到 `clip.duration`（已播完的轨道停在末帧，用于对比谁先到终点）。
   * `local` 早于片头 `clip.t[0]` 时返回 null（该帧什么都不显示）；`count = 0` 时片头按 0 计。
   */
  localTime(track: Track, t: number): number | null {
    const local = t - track.offset;
    const head = track.clip.count > 0 ? track.clip.t[0] : 0;
    if (local < head) return null;
    return Math.min(local, track.clip.duration);
  }

  /** 在指定时刻采样某条轨道：未到片头返回 null，其余交给 `sampleClip` 插值。 */
  sample(track: Track, t: number): Sample | null {
    const local = this.localTime(track, t);
    return local === null ? null : sampleClip(track.clip, local);
  }

  /** 主时钟 t 时刻全部轨道的采样结果（含不可见轨道，渲染层自行按 `Track.visible` 过滤）。 */
  sampleAll(t: number): TrackSample[] {
    return this.tracks.map((track) => ({ track, sample: this.sample(track, t) }));
  }
}
