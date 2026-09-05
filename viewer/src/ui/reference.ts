/** 参考显示：地面网格与世界坐标轴开关（自量测页迁入地图页）。 */

import * as THREE from 'three';
import { checkField, noteLine, section } from '../core/dom.js';
import type { ViewerScene } from '../core/scene.js';
import type { WorldBox } from './mapinfo.js';

export class ReferenceGrid {
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private setNote: (text: string, kind?: 'info' | 'warn' | 'error') => void;

  constructor(root: HTMLElement, private readonly scene: ViewerScene) {
    const body = section(root, '参考显示');
    this.setNote = noteLine(body);
    checkField(
      body,
      '地面网格',
      false,
      (v) => this.setGrid(v),
      '按地图尺寸自适应，512 HU 一格',
    );
    checkField(body, '世界坐标轴', false, (v) => this.setAxes(v), 'X 红 / Y 绿 / Z 蓝');
  }

  /** 地图加载后调用：更新网格尺寸与位置。 */
  setWorld(box: WorldBox | null): void {
    this.disposeGrid();
    this.disposeAxes();
    if (!box) return;
    const size = Math.max(
      box.max[0] - box.min[0],
      box.max[2] - box.min[2],
      1024,
    );
    const span = Math.ceil(size / 512) * 512;
    const cx = (box.min[0] + box.max[0]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    const y = box.min[1];

    this.grid = new THREE.GridHelper(span, span / 512, 0x3a4250, 0x232a35);
    this.grid.position.set(cx, y, cz);
    this.grid.visible = false;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(Math.max(256, span / 8));
    this.axes.position.set(cx, y, cz);
    this.axes.visible = false;
    this.scene.add(this.axes);
  }

  private setGrid(v: boolean): void {
    if (this.grid) this.grid.visible = v;
    else if (v) this.setNote('还没有地图，网格需要先加载 BSP', 'warn');
  }

  private setAxes(v: boolean): void {
    if (this.axes) this.axes.visible = v;
    else if (v) this.setNote('还没有地图，坐标轴需要先加载 BSP', 'warn');
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = null;
  }

  private disposeAxes(): void {
    if (!this.axes) return;
    this.scene.remove(this.axes);
    this.axes.geometry.dispose();
    (this.axes.material as THREE.Material).dispose();
    this.axes = null;
  }
}
