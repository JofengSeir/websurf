/**
 * 地图信息面板 + 出生点导航（右侧「地图」标签页的内容，挂在 `#pane-map` 下）。
 *
 * 构造函数按序建出四块：
 * 1. 「更换地图」文件行（`filebtn map-reload`，`for="bspFile"`，点击转发 `#bspFile.click()`；
 *    未加载地图时不显示）；
 * 2. 光照模式分区（`select#lightingMode`，两档 baked / texture，初值 baked）；
 * 3. 「地图信息」分区：默认只列文件 / 出生点数 / 世界尺寸三行，统计明细收进折叠容器；
 * 4. 「出生点导航」分区：每个出生点一行（`spawn-item`，推荐项加 `primary` 类与 ★ 前缀），
 *    行内「跳转」按钮把该点的位置与角度交给构造时传入的 `onJump`。
 *
 * 数据来源：`apps/viewer/src/core/bsp.ts` 的 `BspLoadResult`（文件名、元数据、出生点、耗时）
 * 与 `ViewerScene.worldBox()` 的几何包围盒；角度换算复用
 * `apps/viewer/src/core/spawn.ts` 的 `spawnPointAng`，故面板显示的角度与初始视角同源。
 * 类名契约（`kv` / `k` / `v`、`spawn-list` / `spawn-item` / `primary` / `cls`、`note`、`field` 系列）
 * 在 `apps/viewer/web/styles.css`。
 */

import { el, foldBox, section } from '../core/dom.js';
import { spawnPointAng } from '../core/spawn.js';
import type { Pose } from '../core/pose.js';
import type { BspLoadResult } from '../core/bsp.js';
import type { LightingMode } from '../renderer/lightmap-shader.js';

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
  /** 面板当前展示的出生点快照（`name` 已含 ★ 与坐标，`pos` 为脚底世界坐标）。 */
  private spawns: Array<{ name: string; pos: [number, number, number] }> = [];

  constructor(
    root: HTMLElement,
    private readonly onJump: (pose: Pose) => void,
    private readonly onLightingMode: (mode: LightingMode) => void = () => {},
  ) {
    // 更换地图行：地图加载后才显示（首次加载由引导层按钮负责）
    this.reloadWrap = el('label', 'filebtn map-reload');
    this.reloadWrap.setAttribute('for', 'bspFile');
    this.reloadWrap.textContent = '更换地图…';
    this.reloadWrap.title = '选择新的 .bsp 地图文件（载入新地图会重建场景）';
    this.reloadWrap.style.display = 'none';
    // 与引导按钮同链路：显式转发到 #bspFile.click()（label 对隐藏 input 的默认激活不可靠）
    this.reloadWrap.addEventListener('click', (e) => {
      e.preventDefault();
      (document.getElementById('bspFile') as HTMLInputElement | null)?.click();
    });
    root.appendChild(this.reloadWrap);

    this.buildLightingSection(root);

    this.infoBody = section(root, '地图信息');
    this.emptyNote = el('div', 'note note-info', '尚未加载地图');
    this.infoBody.appendChild(this.emptyNote);

    this.spawnBody = section(root, '出生点导航');
  }

  /**
   * 光照模式分区（预烘焙 / 纯纹理）：与 apps/game、apps/debug 同名同语义的运行期旋钮，
   * 初值 baked。分区小字（代码字面量）说明两档在**移动时**的渲染代价，与进图速度无关。
   * 变更经构造时传入的 `onLightingMode` 冒泡到 `ViewerScene.setLightingMode`。
   */
  private buildLightingSection(root: HTMLElement): void {
    const body = section(root, '光照模式');
    const row = el('label', 'field');
    row.appendChild(el('span', 'field-label', '模式'));
    const select = el('select', 'field-input field-select', undefined, {
      id: 'lightingMode',
      title: '预烘焙 = 每像素采 lightmap atlas + 逐顶点/环境盒烘焙光照（每帧光照开销更大）；纯纹理 = 只上漫反射贴图（每帧光照开销最小）',
    });
    for (const [value, label] of [
      ['baked', '预烘焙'],
      ['texture', '纯纹理'],
    ] as const) {
      select.appendChild(el('option', undefined, label, { value }));
    }
    select.value = 'baked';
    select.addEventListener('change', () => this.onLightingMode(select.value as LightingMode));
    row.appendChild(select);
    body.appendChild(row);
    body.appendChild(
      el(
        'div',
        'note note-info',
        '预烘焙：每个像素都采光照图集并算逐顶点/环境盒烘焙光照，画面有明暗关系，代价是每帧光照开销更大。' +
          '纯纹理：只上漫反射贴图，不采光照图、不算烘焙项，每帧光照开销最小——这就是给「人物移动时渲染速度不要大幅跳变」用的旋钮' +
          '（实际幅度取决于 GPU / 分辨率 / 地图）。切换即时生效（不重建场景、不打断视角）。',
      ),
    );
  }

  /** 出生点快照的只读视图（本仓当前零外部调用点：跳转列表由 `renderSpawns` 直接建 DOM）。 */
  get spawnPoints(): ReadonlyArray<{ name: string; pos: [number, number, number] }> {
    return this.spawns;
  }

  /** 换图载入中：给「更换地图」入口加 `busy` 类（引导按钮的 busy 态由 app 管）。 */
  setLoadBusy(busy: boolean): void {
    this.reloadWrap.classList.toggle('busy', busy);
  }

  /**
   * 渲染入口：`result`（null = 清空面板）+ 几何包围盒 + 推荐出生点下标。
   * `primaryIndex` 缺省取 `result.primary`（wasm 口径），二者都缺时按 −1 处理（无 ★ 标记）；
   * `apps/viewer/src/app.ts` 传入 `resolveInitialSpawn` 的命中下标，使 ★ 与初始视角同源。
   * 本仓当前唯一调用点只传非 null 的 `result`。
   */
  setMap(result: BspLoadResult | null, box: WorldBox | null, primaryIndex?: number): void {
    this.reloadWrap.style.display = result ? '' : 'none';
    this.renderInfo(result, box);
    this.renderSpawns(result, primaryIndex ?? result?.primary ?? -1);
  }

  private renderInfo(result: BspLoadResult | null, box: WorldBox | null): void {
    const body = this.infoBody;
    body.innerHTML = '';
    if (!result) {
      body.appendChild(el('div', 'note note-info', '尚未加载地图'));
      return;
    }
    const m = result.meta;
    // 默认核心行：文件 / 出生点数 / 世界尺寸（更细的统计见下方折叠）
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

    // 统计明细（排障用）整段收进折叠容器
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

  private renderSpawns(result: BspLoadResult | null, primaryIndex: number): void {
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
        name: `${i === primaryIndex ? '★ ' : ''}#${i} ${sp.classname}（${n(pos[0])}, ${n(pos[1])}, ${n(pos[2])}）`,
        pos,
      });

      // 单行 pill：类名 + 跳转按钮；坐标与角度全量放 title（角度按 viewer 约定）
      const [vyaw, vpitch] = spawnPointAng(sp);
      const item = el('div', 'spawn-item' + (i === primaryIndex ? ' primary' : ''));
      const star = i === primaryIndex ? '★ ' : '';
      const cls = el('span', 'cls', `${star}#${i} ${sp.classname}`);
      cls.title =
        `${star}#${i} ${sp.classname}（${n(o[0])}, ${n(o[1])}, ${n(o[2])}）` +
        `　yaw ${n(vyaw)}° pitch ${n(vpitch)}°（viewer 约定）`;
      item.appendChild(cls);

      const btn = el('button', undefined, '跳转', { type: 'button' });
      btn.title = '把相机移到这个出生点并套用其视角';
      btn.addEventListener('click', () => {
        this.onJump({
          pos: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0],
          ang: [vyaw, vpitch],
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
