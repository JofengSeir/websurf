/**
 * trace-renderer — 显示端（渲染引擎无关，依赖注入）
 *
 * 职责：在 3D 场景中渲染双线路径（绿=无限制基准 / 红=tick 实际）。
 * **不直接依赖 three**（ts-shared 公共目录无 node_modules，three 解析会失败）——
 * 线条的创建/更新/销毁由调用方注入 LineFactory（three 或其他引擎适配）。
 *
 * 用法（渲染 Worker 侧，如 test worker-b）：
 *   const traceRenderer = new TraceRenderer({
 *     baseColor: 0x4ade80, // 绿 = 无限制基准
 *     tickColor: 0xf87171, // 红 = tick 实际
 *     lineFactory: (color) => {
 *       // three 适配示例：
 *       const line = new THREE.Line(new THREE.BufferGeometry(),
 *         new THREE.LineBasicMaterial({ color }));
 *       scene.add(line);
 *       return {
 *         setPoints: (pts) => {
 *           line.geometry.dispose();
 *           line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
 *           line.visible = pts.length >= 2;
 *         },
 *         dispose: () => {
 *           scene.remove(line);
 *           line.geometry.dispose();
 *           (line.material as THREE.Material).dispose();
 *         },
 *       };
 *     },
 *   });
 *   // 'trace-point' 消息：traceRenderer.addPoint(pt)
 *   // 'trace-clear' 消息：traceRenderer.clear()
 */

import type { TracePoint, Vec3Like } from './trace-types.js';
import { TRACE_MAX_POINTS } from './trace-types.js';

/** 渲染引擎无关的路径线接口（调用方适配）。 */
export interface TraceLine {
  /** 更新几何点集（< 2 点应隐藏；即时生效）。 */
  setPoints(pts: Vec3Like[]): void;
  /** 释放资源（场景销毁时）。 */
  dispose(): void;
}

/** 线条工厂（调用方注入：创建一条指定颜色的路径线）。 */
export type TraceLineFactory = (color: number) => TraceLine;

/** TraceRenderer 配置。 */
export interface TraceRendererOptions {
  /** 滚动窗口上限（防内存溢出；与采集端一致）。 */
  maxPoints?: number;
  /** 无限制基准线颜色（默认绿）。 */
  baseColor?: number;
  /** tick 实际线颜色（默认红）。 */
  tickColor?: number;
  /** 线条工厂（必填；由调用方适配 three 等渲染引擎）。 */
  lineFactory: TraceLineFactory;
}

/**
 * 双线路径渲染器（渲染引擎无关）：
 * - addPoint(pt)：累积点 + 更新两线（懒创建，首次 addPoint 时建）
 * - clear()：清空点 + 隐藏线（按钮"删除"）
 * - 节点 < 2 自动隐藏（单点无法成线）
 */
export class TraceRenderer {
  private readonly maxPoints: number;
  private readonly baseColor: number;
  private readonly tickColor: number;
  private readonly lineFactory: TraceLineFactory;
  private basePts: Vec3Like[] = [];
  private tickPts: Vec3Like[] = [];
  private baseLine: TraceLine | null = null;
  private tickLine: TraceLine | null = null;

  constructor(opts: TraceRendererOptions) {
    this.maxPoints = opts.maxPoints ?? TRACE_MAX_POINTS;
    this.baseColor = opts.baseColor ?? 0x4ade80; // 绿 = 无限制基准
    this.tickColor = opts.tickColor ?? 0xf87171; // 红 = tick 实际
    this.lineFactory = opts.lineFactory;
  }

  /** 当前已采点数。 */
  get pointCount(): number {
    return this.basePts.length;
  }

  /** 累积一点（双实例位置）→ 更新两线。 */
  addPoint(pt: TracePoint): void {
    this.ensureLines();
    this.basePts.push({ x: pt.base.x, y: pt.base.y, z: pt.base.z });
    this.tickPts.push({ x: pt.tick.x, y: pt.tick.y, z: pt.tick.z });
    if (this.basePts.length > this.maxPoints) this.basePts.shift();
    if (this.tickPts.length > this.maxPoints) this.tickPts.shift();
    this.baseLine?.setPoints(this.basePts);
    this.tickLine?.setPoints(this.tickPts);
  }

  /** 清空点 + 隐藏线（按钮"删除"）。 */
  clear(): void {
    this.basePts = [];
    this.tickPts = [];
    // 清空后以空点集刷新线（setPoints 空集 → 隐藏）；未创建线则无操作
    this.baseLine?.setPoints([]);
    this.tickLine?.setPoints([]);
  }

  /** 释放资源（场景销毁时调用）。 */
  dispose(): void {
    this.baseLine?.dispose();
    this.tickLine?.dispose();
    this.baseLine = null;
    this.tickLine = null;
    this.basePts = [];
    this.tickPts = [];
  }

  /** 首次 addPoint 时创建两条线（工厂注入；初始隐藏——空点集）。 */
  private ensureLines(): void {
    if (this.baseLine) return;
    this.baseLine = this.lineFactory(this.baseColor);
    this.tickLine = this.lineFactory(this.tickColor);
    this.baseLine.setPoints([]);
    this.tickLine.setPoints([]);
  }
}
