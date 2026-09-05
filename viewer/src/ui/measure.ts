/** 量测与参考工具：点击拾取世界坐标、两点测距、网格与坐标轴开关。 */

import * as THREE from 'three';
import { checkField, el, noteLine, section, buttonRow } from '../core/dom.js';
import type { ViewerScene } from '../core/scene.js';
import type { WorldBox } from './mapinfo.js';

const COLOR_A = 0x4ade80;
const COLOR_B = 0xf87171;

export class MeasureTool {
  private pickMode = false;
  private a: THREE.Vector3 | null = null;
  private b: THREE.Vector3 | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private markerA: THREE.Mesh;
  private markerB: THREE.Mesh;
  private link: THREE.Line;
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;

  private setNote: (text: string, kind?: 'info' | 'warn' | 'error') => void;
  private readonly aEl: HTMLElement;
  private readonly bEl: HTMLElement;
  private readonly dEl: HTMLElement;
  private readonly pickBtn: HTMLButtonElement;

  constructor(
    root: HTMLElement,
    private readonly scene: ViewerScene,
    private readonly canvas: HTMLCanvasElement,
    private readonly onPickModeChange: (v: boolean) => void,
  ) {
    // 单区「量测与参考」：拾取模式 + 读数 + 参考显示（S6，教学换算移入帮助浮层）
    const body = section(root, '量测与参考');

    this.pickBtn = el('button', 'btn', '开始拾取', { type: 'button' });
    this.pickBtn.title =
      '拾取模式：点击画布取点（此时不锁定鼠标）。第一次点记 A，第二次记 B，之后滚动更新。';
    this.pickBtn.addEventListener('click', () => this.setPickMode(!this.pickMode));
    body.appendChild(this.pickBtn);
    this.setNote = noteLine(body);
    this.aEl = readout(body, 'A 点', '—');
    this.bEl = readout(body, 'B 点', '—');
    this.dEl = readout(body, '距离', '—');
    buttonRow(body, [
      { label: '清空 A / B', onClick: () => this.clear() },
      { label: '交换 A / B', onClick: () => this.swap() },
    ]);

    body.appendChild(el('div', 'sec-sub', '参考显示'));
    checkField(
      body,
      '地面网格',
      false,
      (v) => this.setGrid(v),
      '按地图尺寸自适应，512 HU 一格',
    );
    checkField(body, '世界坐标轴', false, (v) => this.setAxes(v), 'X 红 / Y 绿 / Z 蓝');

    const geo = new THREE.SphereGeometry(10, 16, 12);
    this.markerA = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLOR_A }));
    this.markerB = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: COLOR_B }));
    this.markerA.visible = false;
    this.markerB.visible = false;
    this.scene.add(this.markerA);
    this.scene.add(this.markerB);

    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.link = new THREE.Line(
      linkGeo,
      new THREE.LineBasicMaterial({ color: 0xffd9a0 }),
    );
    this.link.frustumCulled = false;
    this.link.visible = false;
    this.scene.add(this.link);

    canvas.addEventListener('click', this.onCanvasClick);
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

  get isPicking(): boolean {
    return this.pickMode;
  }

  private setPickMode(v: boolean): void {
    this.pickMode = v;
    this.pickBtn.textContent = v ? '结束拾取' : '开始拾取';
    this.pickBtn.classList.toggle('active', v);
    this.pickBtn.setAttribute('aria-pressed', String(v));
    this.canvas.style.cursor = v ? 'crosshair' : '';
    this.setNote(v ? '拾取已开启：点击画布取点（第一次为 A，第二次为 B，之后交替）' : '');
    this.onPickModeChange(v);
  }

  private onCanvasClick = (e: MouseEvent): void => {
    if (!this.pickMode) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.scene.camera);
    const model = this.scene.model;
    const hits = model ? this.raycaster.intersectObject(model, true) : [];
    if (hits.length === 0 || !hits[0]) {
      this.setNote('没有击中地图表面——请把准星对准可见的几何体再点', 'warn');
      return;
    }
    const p = hits[0].point.clone();
    if (!this.a) {
      this.a = p;
      this.setNote('已记录 A 点，再点一次记录 B 点', 'info');
    } else if (!this.b) {
      this.b = p;
      this.setNote('已记录 B 点', 'info');
    } else {
      // 已有两点：滚动替换（A ← B，B ← 新点），连续量多段更顺手
      this.a = this.b;
      this.b = p;
      this.setNote('已滚动更新 A / B', 'info');
    }
    this.refresh();
  };

  clear(): void {
    this.a = null;
    this.b = null;
    this.refresh();
  }

  swap(): void {
    const t = this.a;
    this.a = this.b;
    this.b = t;
    this.refresh();
  }

  private refresh(): void {
    this.aEl.textContent = this.a ? vec(this.a) : '—';
    this.bEl.textContent = this.b ? vec(this.b) : '—';

    this.markerA.visible = this.a !== null;
    this.markerB.visible = this.b !== null;
    if (this.a) this.markerA.position.copy(this.a);
    if (this.b) this.markerB.position.copy(this.b);

    if (this.a && this.b) {
      const d = this.a.distanceTo(this.b);
      const horiz = Math.hypot(this.b.x - this.a.x, this.b.z - this.a.z);
      const dy = this.b.y - this.a.y;
      this.dEl.textContent = `${d.toFixed(1)} HU（水平 ${horiz.toFixed(1)}，高差 ${dy.toFixed(1)}）`;
      const arr = this.link.geometry.getAttribute('position') as THREE.BufferAttribute;
      arr.setXYZ(0, this.a.x, this.a.y, this.a.z);
      arr.setXYZ(1, this.b.x, this.b.y, this.b.z);
      arr.needsUpdate = true;
      this.link.geometry.computeBoundingSphere();
      this.link.visible = true;
    } else {
      this.dEl.textContent = '—';
      this.link.visible = false;
    }
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

  dispose(): void {
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.scene.remove(this.markerA);
    this.scene.remove(this.markerB);
    this.scene.remove(this.link);
    this.disposeGrid();
    this.disposeAxes();
  }
}

function readout(parent: HTMLElement, k: string, v: string): HTMLElement {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', k));
  const val = el('span', 'v mono', v);
  row.appendChild(val);
  parent.appendChild(row);
  return val;
}

function vec(v: THREE.Vector3): string {
  return `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
}
