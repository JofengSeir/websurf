/**
 * trace-renderer — 显示端（three.js 路径线）
 *
 * 职责：在 3D 场景中渲染双线路径（绿=无限制基准 / 红=tick 实际）。
 * 由渲染 Worker（如 test worker-b）挂载：注入 scene + 接收点/清除消息。
 *
 * 用法（渲染 Worker 侧）：
 *   const traceRenderer = new TraceRenderer(scene, { maxPoints: 2000 });
 *   // 'trace-point' 消息：traceRenderer.addPoint(pt)
 *   // 'trace-clear' 消息：traceRenderer.clear()
 *   // 渲染循环无需额外调用（路径线几何即时更新；可见性自动管理）
 */

import * as THREE from 'three';
import type { TracePoint } from './trace-types.js';
import { TRACE_MAX_POINTS } from './trace-types.js';

/** TraceRenderer 配置。 */
export interface TraceRendererOptions {
  /** 滚动窗口上限（防内存溢出；与采集端一致）。 */
  maxPoints?: number;
  /** 无限制基准线颜色（默认绿）。 */
  baseColor?: number;
  /** tick 实际线颜色（默认红）。 */
  tickColor?: number;
}

/**
 * 双线路径渲染器（纯显示，无环境依赖）：
 * - addPoint(pt)：累积点 + 重建两线几何（懒创建线，首次挂 scene）
 * - clear()：清空点 + 隐藏线（按钮"删除"）
 * - 节点 < 2 自动隐藏（单点无法成线）
 */
export class TraceRenderer {
  private readonly scene: THREE.Scene;
  private readonly maxPoints: number;
  private readonly baseColor: number;
  private readonly tickColor: number;
  private basePts: THREE.Vector3[] = [];
  private tickPts: THREE.Vector3[] = [];
  private baseLine: THREE.Line | null = null;
  private tickLine: THREE.Line | null = null;

  constructor(scene: THREE.Scene, opts: TraceRendererOptions = {}) {
    this.scene = scene;
    this.maxPoints = opts.maxPoints ?? TRACE_MAX_POINTS;
    this.baseColor = opts.baseColor ?? 0x4ade80; // 绿 = 无限制基准
    this.tickColor = opts.tickColor ?? 0xf87171; // 红 = tick 实际
  }

  /** 当前已采点数。 */
  get pointCount(): number {
    return this.basePts.length;
  }

  /** 累积一点（双实例位置）→ 更新两线。 */
  addPoint(pt: TracePoint): void {
    this.ensureLines();
    this.basePts.push(new THREE.Vector3(pt.base.x, pt.base.y, pt.base.z));
    this.tickPts.push(new THREE.Vector3(pt.tick.x, pt.tick.y, pt.tick.z));
    if (this.basePts.length > this.maxPoints) this.basePts.shift();
    if (this.tickPts.length > this.maxPoints) this.tickPts.shift();
    this.updateLine(this.baseLine, this.basePts);
    this.updateLine(this.tickLine, this.tickPts);
  }

  /** 清空点 + 隐藏线（按钮"删除"）。 */
  clear(): void {
    this.basePts = [];
    this.tickPts = [];
    if (this.baseLine) this.baseLine.visible = false;
    if (this.tickLine) this.tickLine.visible = false;
  }

  /** 释放几何资源（场景销毁时调用）。 */
  dispose(): void {
    this.clear();
    if (this.baseLine) {
      this.scene.remove(this.baseLine);
      this.baseLine.geometry.dispose();
      (this.baseLine.material as THREE.Material).dispose();
      this.baseLine = null;
    }
    if (this.tickLine) {
      this.scene.remove(this.tickLine);
      this.tickLine.geometry.dispose();
      (this.tickLine.material as THREE.Material).dispose();
      this.tickLine = null;
    }
  }

  /** 首次 addPoint 时创建两条线（挂 scene；初始隐藏）。 */
  private ensureLines(): void {
    if (this.baseLine || !this.scene) return;
    this.baseLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: this.baseColor }),
    );
    this.tickLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: this.tickColor }),
    );
    this.baseLine.visible = false;
    this.tickLine.visible = false;
    this.scene.add(this.baseLine, this.tickLine);
  }

  /** 更新线几何（节点 < 2 隐藏；每次重建 BufferGeometry）。 */
  private updateLine(line: THREE.Line | null, pts: THREE.Vector3[]): void {
    if (!line) return;
    if (pts.length < 2) {
      line.visible = false;
      return;
    }
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    line.visible = true;
  }
}
