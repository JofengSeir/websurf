/**
 * 坐标系标定面板（Q4）。
 *
 * 用法：给 N≥2 组「录像里某一帧的原始坐标 ↔ 地图上对应的世界坐标」，
 * 点「求解」搜出轴置换 / 符号 / 缩放 / 平移，点「应用」写回规则并重新导入。
 *
 * 世界侧坐标的两种来路：地图出生点下拉（最省事：录像第 0 帧通常就是出生点）、
 * 或把自由视角飞到某个特征位置后「用当前相机位置」。
 */

import { buttonRow, el, noteLine, numField, section, selectField } from '../core/dom.js';
import { solveTransform } from './calib.js';
import type { Correspondence, Solution } from './calib.js';
import type { ReplayImporter } from './importer.js';
import type { AxisSrc, RuleConfig, Sign } from './types.js';

/** 世界侧参考点来源。 */
export interface WorldRefs {
  /** 地图出生点（世界坐标，脚底）。 */
  spawns: Array<{ name: string; pos: [number, number, number] }>;
  /** 当前人物脚底位置（相机位 − 眼高）。 */
  current: [number, number, number];
}

export interface CalibPanelOptions {
  importer: ReplayImporter;
  getRule: () => RuleConfig;
  /** 把求出的解写进规则（由 ReplayPanel 负责落到表单并重导）。 */
  applySolution: (s: Solution) => void;
  getWorldRefs: () => WorldRefs;
  onStatus: (text: string) => void;
}

type Note = (text: string, kind?: 'info' | 'warn' | 'error') => void;

const AXIS_LABEL: Record<AxisSrc, string> = { x: 'X', y: 'Y', z: 'Z' };

export class CalibPanel {
  private readonly pairs: Correspondence[] = [];
  /** 已读到但还没加入列表的录像侧坐标。 */
  private pendingRaw: [number, number, number] | null = null;
  private readonly worldDraft: [number, number, number] = [0, 0, 0];
  private frameIndex = 0;
  private lastSolution: Solution | null = null;

  private readonly rawNote: Note;
  private readonly listEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private readonly solveNote: Note;
  private readonly spawnSelect: HTMLSelectElement;
  private readonly worldInputs: HTMLInputElement[] = [];
  private readonly solveBtn: HTMLButtonElement | null;

  constructor(root: HTMLElement, private readonly opts: CalibPanelOptions) {
    const body = section(root, '坐标系标定');
    const intro = el(
      'div',
      'note note-info',
      '给 ≥2 组「录像帧 ↔ 地图位置」对应点（要分散、确实是同一处），自动解轴映射 / 符号 / 缩放 / 平移。',
    );
    intro.title =
      '给 2 组以上「录像帧 ↔ 地图位置」的对应点，自动解出轴映射、符号、单位缩放与原点平移。' +
      '点要挑得分散、且确实是同一处（推荐：出生点 + 路线中段几个特征位置）。';
    body.appendChild(intro);

    // ── 录像侧 ──
    body.appendChild(el('div', 'sec-sub', '录像侧'));
    numField(body, {
      label: '帧号',
      value: 0,
      step: 1,
      hint: '取这一帧的原始坐标（规则变换之前的值）',
      onInput: (v, valid) => {
        if (valid) this.frameIndex = Math.max(0, Math.floor(v));
      },
    });
    buttonRow(body, [
      {
        label: '取该帧原始坐标',
        onClick: () => void this.fetchRaw(),
        title: '按规则里填的 posX/posY/posZ 路径读出原始值',
      },
    ]);
    this.rawNote = noteLine(body);

    // ── 世界侧 ──
    body.appendChild(el('div', 'sec-sub', '世界侧（地图坐标）'));
    this.spawnSelect = selectField(body, {
      label: '出生点',
      value: '',
      hint: '选一个出生点，直接把它的世界坐标填到下面',
      options: [{ value: '', label: '（未选）' }],
      onChange: (v) => {
        if (!v) return;
        const refs = this.opts.getWorldRefs();
        const s = refs.spawns[Number(v)];
        if (s) this.setWorld(s.pos);
      },
    });
    buttonRow(body, [
      {
        label: '用当前相机位置',
        onClick: () => this.setWorld(this.opts.getWorldRefs().current),
        title: '把自由视角当前所在的脚底位置填到下面',
      },
      {
        label: '刷新出生点',
        onClick: () => this.refreshSpawns(),
        title: '地图刚加载完时用它重新拉取出生点列表',
      },
    ]);
    for (const [i, label] of ['世界 X', '世界 Y', '世界 Z'].entries()) {
      const input = numField(body, {
        label,
        value: 0,
        step: 1,
        hint: 'viewer 世界坐标（Y-up，脚底）',
        onInput: (v, valid) => {
          if (valid) this.worldDraft[i] = v;
        },
      });
      this.worldInputs.push(input);
    }

    buttonRow(body, [
      {
        label: '添加对应点',
        onClick: () => this.addPair(),
        title: '把上面两侧的数值结成一组对应点',
      },
    ]);

    // ── 对应点列表 ──
    body.appendChild(el('div', 'sec-sub', '对应点'));
    this.listEl = el('div', 'calib-list');
    body.appendChild(this.listEl);

    const actionRow = buttonRow(body, [
      {
        label: '求解',
        onClick: () => this.solve(),
        title: '搜索轴映射/符号/缩放/平移（至少 2 组对应点）',
      },
      {
        label: '应用结果',
        onClick: () => this.apply(),
        title: '把解出的参数写进规则并重新导入',
      },
      {
        label: '清空',
        onClick: () => {
          this.pairs.length = 0;
          this.pendingRaw = null;
          this.lastSolution = null;
          this.rawNote('');
          this.solveNote('');
          this.resultEl.style.display = 'none';
          this.renderList();
        },
      },
    ]);
    // 过程态：少于 2 组时「求解」不可点，避免空操作（攒够自动解锁）
    this.solveBtn =
      Array.from(actionRow.querySelectorAll('button')).find((b) => b.textContent === '求解') ??
      null;

    this.resultEl = el('div', 'calib-result mono');
    this.resultEl.style.display = 'none';
    body.appendChild(this.resultEl);
    this.solveNote = noteLine(body);

    this.refreshSpawns();
    this.renderList();
  }

  /** 地图换了以后要重新拉出生点。 */
  refreshSpawns(): void {
    const refs = this.opts.getWorldRefs();
    this.spawnSelect.innerHTML = '';
    this.spawnSelect.appendChild(el('option', undefined, '（未选）', { value: '' }));
    refs.spawns.forEach((s, i) => {
      this.spawnSelect.appendChild(el('option', undefined, s.name, { value: String(i) }));
    });
    this.spawnSelect.disabled = refs.spawns.length === 0;
  }

  private setWorld(pos: [number, number, number]): void {
    this.worldDraft[0] = pos[0];
    this.worldDraft[1] = pos[1];
    this.worldDraft[2] = pos[2];
    for (let i = 0; i < 3; i++) this.worldInputs[i].value = String(Math.round(pos[i] * 100) / 100);
  }

  private async fetchRaw(): Promise<void> {
    const rule = this.opts.getRule();
    if (!rule.posX || !rule.posY || !rule.posZ) {
      this.rawNote('规则里的位置路径（posX/posY/posZ）还没填满，先填好再来', 'error');
      return;
    }
    try {
      const res = await this.opts.importer.readRawPos(
        rule.framePath,
        this.frameIndex,
        [rule.posX, rule.posY, rule.posZ],
      );
      if (!res.value) {
        this.rawNote(`第 ${this.frameIndex} 帧取不到三个有效数字：${res.preview}`, 'error');
        return;
      }
      this.pendingRaw = res.value;
      this.rawNote(
        `第 ${this.frameIndex} 帧原始坐标 (${fmt3(res.value)})（共 ${res.count.toLocaleString('en-US')} 帧）`,
        'info',
      );
    } catch (e) {
      this.rawNote(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private addPair(): void {
    if (!this.pendingRaw) {
      this.rawNote('先点「取该帧原始坐标」把录像侧的值读出来', 'warn');
      return;
    }
    this.pairs.push({
      raw: [...this.pendingRaw],
      world: [this.worldDraft[0], this.worldDraft[1], this.worldDraft[2]],
    });
    this.pendingRaw = null;
    this.rawNote('');
    this.renderList();
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    if (this.pairs.length === 0) {
      this.listEl.appendChild(
        el(
          'div',
          'note note-info',
          '还没有对应点：先在上方取录像帧原始坐标、填世界坐标，再「添加对应点」（至少 2 组）',
        ),
      );
    } else {
      this.pairs.forEach((p, i) => {
        const row = el('div', 'calib-row');
        row.appendChild(el('span', 'calib-idx', String(i + 1)));
        row.appendChild(el('span', 'calib-pair mono', `${fmt3(p.raw)} → ${fmt3(p.world)}`));
        const del = el('button', 'track-btn danger', '×', { type: 'button', title: '删除这组' });
        del.addEventListener('click', () => {
          this.pairs.splice(i, 1);
          this.renderList();
        });
        row.appendChild(del);
        this.listEl.appendChild(row);
      });
    }
    // 过程态：N / ≥2 组才允许求解
    if (this.solveBtn) {
      this.solveBtn.disabled = this.pairs.length < 2;
      this.solveBtn.title =
        this.pairs.length < 2
          ? `已记录 ${this.pairs.length} 组，至少需要 2 组才能求解`
          : '搜索轴映射/符号/缩放/平移（至少 2 组对应点）';
    }
  }

  private solve(): void {
    const res = solveTransform(this.pairs);
    if (!res.ok) {
      this.lastSolution = null;
      this.resultEl.style.display = 'none';
      this.solveNote(res.error, 'error');
      return;
    }
    const b = res.best;
    this.lastSolution = b;
    const rows: Array<[string, string]> = [
      ['轴映射', `X←${AXIS_LABEL[b.axis[0]]}  Y←${AXIS_LABEL[b.axis[1]]}  Z←${AXIS_LABEL[b.axis[2]]}`],
      ['符号', `${signStr(b.sign)}`],
      ['单位缩放', b.scale.toFixed(6)],
      ['原点平移', `${fmt3(b.offset.map((v) => Math.round(v * 100) / 100) as [number, number, number])}`],
      ['最大残差', `${b.maxResidual.toFixed(3)} HU`],
      ['点位跨度', `${res.worldSpread.toFixed(0)} HU`],
      ['手性', b.mirrored ? '镜像（det −1）' : '正常（det +1）'],
    ];
    this.resultEl.innerHTML = '';
    for (const [k, v] of rows) {
      const row = el('div', 'kv');
      row.appendChild(el('span', 'k', k));
      row.appendChild(el('span', 'v', v));
      this.resultEl.appendChild(row);
    }
    this.resultEl.style.display = '';

    if (res.warnings.length > 0) this.solveNote(res.warnings.join('；'), 'warn');
    else this.solveNote('解已求出，点「应用结果」写入规则', 'info');
  }

  private apply(): void {
    if (!this.lastSolution) {
      this.solveNote('先点「求解」', 'warn');
      return;
    }
    this.opts.applySolution(this.lastSolution);
    this.opts.onStatus('已把标定结果写入规则并重新导入');
  }
}

function fmt3(a: readonly number[]): string {
  return `${round1(a[0])}, ${round1(a[1])}, ${round1(a[2])}`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function signStr(s: [Sign, Sign, Sign]): string {
  return s.map((v) => (v === 1 ? '＋' : '－')).join(' ');
}
