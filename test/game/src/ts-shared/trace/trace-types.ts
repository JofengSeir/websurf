/**
 * trace — 运动路径采集与显示（公共模块 v1）
 *
 * 由 /test 的 trace 功能提升而来（game/debug/test 共用）：记录物理运动的空间
 * 路径线（双线对照：无限制基准 vs tick 实际），在 3D 场景中以线条显示。
 *
 * 协议（worker ↔ main ↔ renderer 消息）：
 * - 采集侧（物理 Worker）发 trace-data：双实例位置采样点
 * - 主线程转发 trace-point 给渲染 Worker（或直接消费）
 * - 控制：trace（启停）/ trace-clear（清空）
 *
 * 文件分工：
 * - trace-types.ts：消息类型 + 状态机 + 数据结构（本文件）
 * - trace-recorder.ts：采集端状态机（WorkerA 侧：开关/节流/滚动窗口）
 * - trace-renderer.ts：显示端（three.js 路径线，渲染 Worker 可挂载）
 */

/** 双实例路径点（无限制基准 + tick 实际——world 坐标，Y-up）。 */
export interface TracePoint {
  base: Vec3Like;
  tick: Vec3Like;
}

/** 最小化 3D 坐标（与 Vec3 结构兼容）。 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 记录状态机：off（未记录）→ recording（记录中）→ saved（已保存保留显示）→ off。 */
export type TraceState = 'off' | 'recording' | 'saved';

/** 路径节点滚动窗口上限（防内存溢出；清除时清空）。 */
export const TRACE_MAX_POINTS = 2000;

// ── 消息协议（与两端消息命名空间兼容）───────────────────────────

/** 采集侧 → 主线程：单次采样点（双实例位置）。 */
export interface TraceDataMessage {
  type: 'trace-data';
  baseX: number;
  baseY: number;
  baseZ: number;
  tickX: number;
  tickY: number;
  tickZ: number;
}

/** 主线程 → 采集侧：启停记录。 */
export interface TraceControlMessage {
  type: 'trace';
  enabled: boolean;
}

/** 主线程 → 显示侧：清除路径线（节点清空 + 隐藏）。 */
export interface TraceClearMessage {
  type: 'trace-clear';
}

/** 主线程 → 显示侧：单点（转发 TraceDataMessage，world 坐标）。 */
export interface TracePointMessage {
  type: 'trace-point';
  baseX: number;
  baseY: number;
  baseZ: number;
  tickX: number;
  tickY: number;
  tickZ: number;
}

/** TraceDataMessage → TracePoint（测试/工具用）。 */
export function toTracePoint(msg: TraceDataMessage): TracePoint {
  return {
    base: { x: msg.baseX, y: msg.baseY, z: msg.baseZ },
    tick: { x: msg.tickX, y: msg.tickY, z: msg.tickZ },
  };
}

/** TracePoint → TracePointMessage（转发用）。 */
export function toTracePointMessage(pt: TracePoint): TracePointMessage {
  return {
    type: 'trace-point',
    baseX: pt.base.x,
    baseY: pt.base.y,
    baseZ: pt.base.z,
    tickX: pt.tick.x,
    tickY: pt.tick.y,
    tickZ: pt.tick.z,
  };
}
