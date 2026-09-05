/**
 * 地图信息面板 + 出生点导航（右侧「地图」标签页）。
 *
 * 布局（S7）：顶部「更换地图」文件行；地图信息默认只显核心行，
 * 统计明细收进折叠；出生点条目为单行 pill（坐标全量在 title）。
 */

import { el, foldBox, section } from '../core/dom.js';
import { bspYawToCsYaw } from '../core/pose.js';
import type { Pose } from '../core/pose.js';
import type { BspLoadResult } from '../core/bsp.js';

export interface WorldBox {
  min: [number, number, number];
  max: [number, number, number];
}

function kv(parent: HTMLElement, k: string, v: string, title?: string): HTMLElement {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', k));
  const val = el('span', 'v', v);
  if (title) val.title = title;
  row.appendChild(val);
  parent.appendChild(row);
  return row;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

export class MapPanel {
  private readonly infoBody: HTMLElement;
  private readonly spawnBody: HTMLElement;
  private readonly reloadWrap: HTMLElement;
  private readonly emptyNote: HTMLElement;
  /** 出生点快照（世界坐标，脚底），供录像坐标系标定选参考点。 */
  private spawns: Array<{ name: string; pos: [number, number, number] }> = [];

  constructor(
    root: HTMLElement,
    private readonly onJump: (pose: Pose) => void,
  ) {
    // 更换地图：已加载地图后显示的换图入口（引导层按钮管首次加载）
    this.reloadWrap = el('label', 'filebtn map-reload');
    this.reloadWrap.setAttribute('for', 'bspFile');
    this.reloadWrap.textContent = '更换地图…';
    this.reloadWrap.title = '选择新的 .bsp 地图文件（载入新地图会重建场景）';
    this.reloadWrap.style.display = 'none';
    // 与引导按钮同一链路：#bspFile.click()（label 默认激活在部分浏览器对隐藏 input 不可靠）
    this.reloadWrap.addEventListener('click', (e) => {
      e.preventDefault();
      (document.getElementById('bspFile') as HTMLInputElement | null)?.click();
    });
    root.appendChild(this.reloadWrap);

    this.infoBody = section(root, '地图信息');
    this.emptyNote = el('div', 'note note-info', '尚未加载地图');
    this.infoBody.appendChild(this.emptyNote);

    this.spawnBody = section(root, '出生点导航');
  }

  /** 出生点快照（录像标定的世界侧参考点来源）。 */
  get spawnPoints(): ReadonlyArray<{ name: string; pos: [number, number, number] }> {
    return this.spawns;
  }

  /** 换图载入中：禁用「更换地图」入口（引导按钮的 busy 由 app 管）。 */
  setLoadBusy(busy: boolean): void {
    this.reloadWrap.classList.toggle('busy', busy);
  }

  setMap(result: BspLoadResult | null, box: WorldBox | null): void {
    this.reloadWrap.style.display = result ? '' : 'none';
    this.renderInfo(result, box);
    this.renderSpawns(result);
  }

  private renderInfo(result: BspLoadResult | null, box: WorldBox | null): void {
    const body = this.infoBody;
    body.innerHTML = '';
    if (!result) {
      body.appendChild(el('div', 'note note-info', '尚未加载地图'));
      return;
    }
    const m = result.meta;
    // 默认核心行：文件 / 出生点数 / 世界尺寸
    kv(body, '文件', result.fileName, result.fileName);
    kv(body, '出生点数', fmt(result.spawnPoints.length));
    if (box) {
      const size = [
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2],
      ];
      kv(
        body,
        '世界尺寸',
        `${size[0].toFixed(0)} × ${size[1].toFixed(0)} × ${size[2].toFixed(0)}`,
        'X × Y(高) × Z，单位 HU',
      );
    }

    // 统计明细（开发/排障用）收进折叠
    const stats = foldBox(body, '统计明细');
    if (m.magic !== undefined) kv(stats.body, 'magic', m.magic ?? '—');
    kv(stats.body, 'brushes', fmt(m.num_brushes ?? Number.NaN));
    kv(stats.body, 'faces', fmt(m.num_faces ?? Number.NaN));
    kv(stats.body, 'models', fmt(m.num_models ?? Number.NaN));
    kv(stats.body, 'vertices', fmt(m.num_vertices ?? Number.NaN));
    kv(stats.body, 'static props', fmt(m.num_static_props ?? Number.NaN));
    kv(stats.body, 'PAKFILE 文件', fmt(m.packed_files ?? Number.NaN));
    kv(stats.body, '解析耗时', `${result.elapsedMs.toFixed(0)} ms`);
    if (box) {
      kv(stats.body, '包围盒 min', `${box.min[0].toFixed(0)}, ${box.min[1].toFixed(0)}, ${box.min[2].toFixed(0)}`);
      kv(stats.body, '包围盒 max', `${box.max[0].toFixed(0)}, ${box.max[1].toFixed(0)}, ${box.max[2].toFixed(0)}`);
    }
  }

  private renderSpawns(result: BspLoadResult | null): void {
    const body = this.spawnBody;
    body.innerHTML = '';
    this.spawns = [];
    if (!result || result.spawnPoints.length === 0) {
      body.appendChild(el('div', 'note note-info', result ? '这张地图没有出生点' : '尚未加载地图'));
      return;
    }

    const list = el('div', 'spawn-list');
    result.spawnPoints.forEach((sp, i) => {
      const o = sp.origin ?? [];
      const pos: [number, number, number] = [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0];
      this.spawns.push({
        name: `${i === result.primary ? '★ ' : ''}#${i} ${sp.classname}（${n(pos[0])}, ${n(pos[1])}, ${n(pos[2])}）`,
        pos,
      });

      // 单行 pill：名 + 跳转；坐标/yaw 全量进 title
      const item = el('div', 'spawn-item' + (i === result.primary ? ' primary' : ''));
      const star = i === result.primary ? '★ ' : '';
      const cls = el('span', 'cls', `${star}#${i} ${sp.classname}`);
      cls.title =
        `${star}#${i} ${sp.classname}（${n(o[0])}, ${n(o[1])}, ${n(o[2])}）` +
        `　yaw ${n(bspYawToCsYaw(sp.angles?.[1] ?? 0))}°（viewer 约定）`;
      item.appendChild(cls);

      const btn = el('button', undefined, '跳转', { type: 'button' });
      btn.title = '把相机移到这个出生点并套用其视角';
      btn.addEventListener('click', () => {
        this.onJump({
          pos: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0],
          ang: [bspYawToCsYaw(sp.angles?.[1] ?? 0), sp.angles?.[0] ?? 0],
        });
      });
      item.appendChild(btn);
      list.appendChild(item);
    });
    body.appendChild(list);
  }
}

function n(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}
