/**
 * trace-recorder — 采集端状态机（物理 Worker 侧）
 *
 * 职责：trace 启停开关 + 子步循环节流采样（双实例位置）+ 滚动窗口。
 * 与渲染/主线程解耦：recorder 只负责"采样并产出点"，发送由调用方
 * （postMessage / 直接消费）决定——公共 API 不绑定 Worker 环境。
 *
 * 用法（物理 Worker 侧）：
 *   const recorder = new TraceRecorder({ sampleEvery: 16, onPoint: (pt) => self.postMessage(...) });
 *   // 子步循环内：recorder.tick(basePos, tickPos) —— recording 态且到采样节拍时触发 onPoint
 *   // 消息处理：recorder.setEnabled(enabled)
 */

import type { TracePoint, TraceState, Vec3Like } from './trace-types.js';
import { TRACE_MAX_POINTS } from './trace-types.js';

/** TraceRecorder 配置。 */
export interface TraceRecorderOptions {
  /** 采样节流：每 N 次子步发一点（1ms 子步 × 16 ≈ 16ms/点 ≈ 62.5Hz）。 */
  sampleEvery?: number;
  /** 单点产出回调（采集侧发出点；返回 false 可中断——如非记录态）。 */
  onPoint?: (pt: TracePoint) => void;
  /** 滚动窗口上限（防内存溢出）。 */
  maxPoints?: number;
}

/**
 * 采集端状态机（纯逻辑，无环境依赖）：
 * - setEnabled(true)：进入 recording；setEnabled(false)：进入 saved（保留已采点）
 * - tick(base, tick)：子步循环内调用，节流采样；recording 态才产出点
 * - clear()：清空已采点（按钮"删除"）
 * - getState() / getPoints() / points 只读视图
 */
export class TraceRecorder {
  private enabled = false;
  private counter = 0;
  private readonly sampleEvery: number;
  private readonly onPoint?: (pt: TracePoint) => void;
  private readonly maxPoints: number;
  private readonly pts: TracePoint[] = [];

  constructor(opts: TraceRecorderOptions = {}) {
    this.sampleEvery = opts.sampleEvery ?? 16;
    this.onPoint = opts.onPoint;
    this.maxPoints = opts.maxPoints ?? TRACE_MAX_POINTS;
  }

  /** 启停（消息 'trace' 处理）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.counter = 0;
  }

  /** 是否记录中。 */
  get isRecording(): boolean {
    return this.enabled;
  }

  /** 当前状态（与 UI 状态机对齐）。 */
  get state(): TraceState {
    return this.enabled ? 'recording' : this.pts.length > 0 ? 'saved' : 'off';
  }

  /** 已采点（只读）。 */
  getPoints(): readonly TracePoint[] {
    return this.pts;
  }

  /**
   * 子步循环内调用：节流采样双实例位置。
   * @param base 无限制基准位置（world 坐标）
   * @param tick tick 实际位置（world 坐标；无 tick 实例时传 base 兜底）
   * @returns 是否产出点（recording 态且到采样节拍）
   */
  tick(base: Vec3Like, tick: Vec3Like): boolean {
    if (!this.enabled) return false;
    this.counter++;
    if (this.counter < this.sampleEvery) return false;
    this.counter = 0;
    const pt: TracePoint = {
      base: { x: base.x, y: base.y, z: base.z },
      tick: { x: tick.x, y: tick.y, z: tick.z },
    };
    this.pts.push(pt);
    if (this.pts.length > this.maxPoints) this.pts.shift();
    this.onPoint?.(pt);
    return true;
  }

  /** 清空已采点（按钮"删除"）。 */
  clear(): void {
    this.pts.length = 0;
    this.counter = 0;
  }
}
