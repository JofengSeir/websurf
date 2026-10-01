/**
 * 回放会话：一次「导入 → 播放」的全部私有状态。
 *
 * **两条链路各持一个会话**，互相之间不共享任何可变状态：
 *
 * | | 记录会话（`.replay`） | 录像会话（`.dem`） |
 * |---|---|---|
 * | 主时钟 / 区间 / 轨道 / 跟随 / 视角 | 自己一份 `ReplayPlayer` | 自己一份 `ReplayPlayer` |
 * | 3D 轨迹 / tick 点 / 幽灵 | 自己一份 `ReplayVisuals` | 自己一份 `ReplayVisuals` |
 * | 底部时间轴（DOM + 控件 + 读数） | 自己一条 `Timeline` | 自己一条 `Timeline` |
 * | 信息条（dock 上层那条横带） | 有：`ReplayMetaPanel` 读 `Clip.meta` | 本会话不持有（`meta` 恒 `null`）：录像侧那条 `#demoInfo` 由 `apps/viewer/src/app.ts` 单独持有并喂 `DemoParseResult` |
 * | dock 里的容器 | `#session-replay` | `#session-demo` |
 *
 * 早先两边共用**同一个** `ReplayPlayer` / `ReplayVisuals` / `Timeline`，靠
 * `activeTab` + `demoTrackId` + `player.span`（"非零即录像会话"）+ `timeline.setDemoMode(on)`
 * 四处在运行期来回拨 —— 任何一处漏拨都会让两边串位（时长取并集、窗口互相覆盖、
 * 一边的轨道出现在另一边的时间轴上）。这里把「哪条链路有哪些东西」提升成**构造期的能力档**
 * （`SESSION_PROFILES`），运行期只做一件事：切换哪个会话上场。
 *
 * 全局唯一的共享面只剩三样，且都只是「读活动会话」而不持有会话状态：
 * `three` 场景 / 飞行相机 / dock 之外的 HUD 与遥测读数。
 */

import type { ViewerScene } from '../core/scene.js';
import type { ReplayHeaderMeta, Sample, Track } from './types.js';
import { ReplayPlayer } from './player.js';
import { ReplayVisuals } from './visuals.js';
import { Timeline } from './timeline.js';
import type { TimelineProfile } from './timeline.js';
import { ReplayMetaPanel } from '../ui/replaymeta.js';

/** 会话种类：记录（Shavit `.replay`）/ 录像（Source `.dem`）。 */
export type SessionKind = 'replay' | 'demo';

/**
 * 两条链路的能力档 —— **全仓唯一一处**声明「哪种会话有哪些控件 / 画哪些叠加带」。
 *
 * 判据是产物能力，不是文件类型：`.dem` 的 `Clip.meta` 恒 `null`（没有 prerun/run/post 段位与
 * 官方计时），`Clip.count` 是 tick 采样条数而不是定长帧号，`Clip.buttons` 恒 `null`
 * （Source 只把录制者本人的输入写进 `usercmd`）—— 所以帧步进、跑段高亮、A-B 区间与按键簇
 * 在录像档里**根本不建**，而不是建出来再藏起来。
 */
export const SESSION_PROFILES: Record<SessionKind, TimelineProfile> = {
  replay: {
    clock: 'run',
    frameStep: true,
    abRange: true,
    runZone: true,
    personZones: false,
  },
  demo: {
    clock: 'wall',
    frameStep: false,
    abRange: false,
    runZone: false,
    personZones: true,
  },
};

export class ReplaySession {
  /** 本会话的主时钟、区间、轨道集与视角模式。 */
  readonly player = new ReplayPlayer();
  /** 本会话的 3D 呈现（轨迹线 / tick 点 / 幽灵 / 起终点标记）。 */
  readonly visuals: ReplayVisuals;
  /** 本会话的底部时间轴（自己一份 DOM，挂在 `host` 里）。 */
  readonly timeline: Timeline;
  /** 时间轴容器元素（遥测的按键簇挂进记录会话这一个）。 */
  readonly timelineRoot: HTMLElement;
  /** 头部信息条；只有记录会话有（录像的元信息由录像页看板自己展示）。 */
  readonly meta: ReplayMetaPanel | null;

  /** 本会话当前是否上场（决定 3D 对象显隐与是否推进主时钟）。 */
  private active = false;

  constructor(
    readonly kind: SessionKind,
    scene: ViewerScene,
    /** dock 里本会话的容器（带 `.session-pane`，切换时切 `.active`）。 */
    private readonly host: HTMLElement,
    timelineRoot: HTMLElement,
    metaRoot: HTMLElement | null,
  ) {
    this.timelineRoot = timelineRoot;
    this.visuals = new ReplayVisuals(scene);
    this.timeline = new Timeline(timelineRoot, this.player, this.visuals, SESSION_PROFILES[kind]);
    this.meta = kind === 'replay' && metaRoot ? new ReplayMetaPanel(metaRoot) : null;
    this.visuals.setActive(false);
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * 本会话是否已有可播放的内容：记录 = 至少一条轨道；录像 = 已解析出整段时长（`sessionLength`）
   * 或已有轨道。为真时时间轴可见、可拖、可播放 —— 录像「载入完但还没点任何人」也在其中。
   */
  get ready(): boolean {
    return this.kind === 'demo'
      ? this.player.sessionLength > 0 || !this.player.tracks.isEmpty
      : !this.player.tracks.isEmpty;
  }

  /** 本会话的上场标记（`host.classList` 上的 `.active`，样式在 `apps/viewer/web/styles.css`）。 */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.host.classList.add('active');
    this.timeline.setReady(this.ready);
    // 上场才响应快捷键：两条时间轴各绑一份 window keydown，下场的那条必须闭嘴（见 Timeline.setOnStage）
    this.timeline.setOnStage(true);
    this.visuals.setActive(true, this.player.sampleAll(), this.player.mode, this.player.tracks.followId);
  }

  /**
   * 下场：**只停表，不销毁任何东西**。
   *
   * 主时钟暂停、3D 对象熄灭、快捷键失效，轨道 / 时间 / 区间 / 显示开关全部原样留着 ——
   * 切回来即刻续看。（早先切 tab 要 `teardownDemo()` 删掉录像轨道、清 `span`、
   * 切 `setDemoMode(false)`，那是因为两边共用同一套状态；现在各归各的，没有东西需要"拆"。）
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.host.classList.remove('active');
    this.timeline.setOnStage(false);
    this.player.pause();
    this.visuals.setActive(false);
  }

  /** 轨道增删 / 跟随切换 / 会话长度变化后同步：3D、时间轴可见性与读数、信息条。 */
  sync(): void {
    const tracks = this.player.tracks.tracks;
    this.visuals.setTracks(tracks);
    if (this.active) {
      this.visuals.setActive(true, this.player.sampleAll(), this.player.mode, this.player.tracks.followId);
    }
    this.timeline.setReady(this.ready);
    this.meta?.setTracks(tracks, this.player.tracks.followId);
  }

  /** 本会话的全部轨道（只读视图，供外部内省）。 */
  get tracks(): readonly Track[] {
    return this.player.tracks.tracks;
  }

  /** 跟随轨道的 `.replay` 头部元信息；录像会话恒 `null`。 */
  metaOfFollow(): ReplayHeaderMeta | null {
    return this.player.tracks.follow?.clip.meta ?? null;
  }

  /** 帧循环：推进主时钟并刷新本会话的 3D 呈现。**只有活动会话会被调用**。 */
  tick(dt: number): void {
    this.player.update(dt);
    this.visuals.update(this.player.sampleAll(), this.player.mode, this.player.tracks.followId);
  }

  /** 第一人称相机要跟随的采样；不在第一人称 / 没有轨道 / 不在场时返回 `null`（相机交回自由飞行）。 */
  cameraSample(): Sample | null {
    if (!this.active) return null;
    if (this.player.mode !== 'first' || !this.player.clip) return null;
    return this.player.sample();
  }
}
