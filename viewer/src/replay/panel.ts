/**
 * 录像面板（右侧「录像」标签页）：导入 + 轨迹列表 + 变换调整。
 *
 * 规则 = 一段映射脚本文本（scriptSrc：内置默认 / .js 文件 / 深链 / localStorage），
 * 外加 transform 人工微调（平移 + 绕 Y 旋转，viewer 侧后处理）。
 * 「换文件＝追加轨道；改规则＝替换当前轨道」的语义不变。
 */

import { buttonRow, el, noteLine, section } from '../core/dom.js';
import { DEFAULT_RULE_SRC } from './default-rule.js';
import { TrackPanel } from './trackpanel.js';
import type { ReplayImporter } from './importer.js';
import type { ReplayPlayer } from './player.js';
import { buildSampleReplayText, SAMPLE_FILE_NAME } from './sample.js';
import { LARGE_CLIP_FRAMES } from './build.js';
import type { Clip, RuleConfig } from './types.js';
import { defaultRule } from './types.js';

const STORAGE_KEY = 'websurf-viewer.replay-rule.v1';

/** 起点对齐信息：录像首帧（viewer 世界坐标）与最近出生点的距离和所需平移。 */
export interface StartAid {
  /** 与最近出生点的距离（HU）。 */
  dist: number;
  /** 输出坐标平移量：出生点 − 录像首帧。 */
  delta: [number, number, number];
  /** 最近出生点的显示名。 */
  spawnName: string;
}

export interface ReplayPanelOptions {
  /**
   * 导入成功。
   * `replaceId` 非 null 表示这是对同一份文件改规则后的重新导入——替换那条轨道，别追加。
   * 返回实际承载这份 clip 的轨道 id，供下次重新导入复用。
   */
  onClip: (clip: Clip, warnings: string[], replaceId: string | null) => string;
  /** 清空全部轨迹。 */
  onClearAll: () => void;
  /** 轨道属性变化（显隐 / 偏移 / 重命名 / 移除 / 跟随）→ 重建可视化。 */
  onTracksChanged: () => void;
  /** 起点对齐信息（无地图或无录像时返回 null）。 */
  getStartAid?: () => StartAid | null;
  onStatus: (text: string) => void;
}

export class ReplayPanel {
  private rule: RuleConfig = defaultRule();
  private file: File | null = null;
  /**
   * 上次导入承载结果的轨道 id。
   * 同一份文件改规则后的重新导入要**替换**那条轨道，否则每次改规则都会多出一条重复轨迹；
   * 换文件（loadFile）时清空，于是导入新文件＝追加一条轨道。
   */
  private lastTrackId: string | null = null;
  private busy = false;

  private readonly fileNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly anchorNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly infoBody: HTMLElement;
  private trackPanel: TrackPanel | null = null;

  constructor(
    root: HTMLElement,
    private readonly importer: ReplayImporter,
    private readonly player: ReplayPlayer,
    private readonly opts: ReplayPanelOptions,
  ) {
    this.loadRule();

    // ── 导入 ──
    const fileBody = section(root, '导入');
    this.fileNote = noteLine(fileBody);
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (f) void this.loadFile(f);
    });
    fileBody.appendChild(fileInput);

    buttonRow(fileBody, [
      { label: '选择 JSON 录像…', onClick: () => fileInput.click() },
      {
        label: '载入示例录像',
        onClick: () => void this.loadSample(),
        title: '生成一段合成的螺旋下降轨迹，用来验证整条导入链路',
      },
    ]);

    this.infoBody = el('div');
    this.infoBody.style.marginTop = '6px';
    fileBody.appendChild(this.infoBody);

    // ── 轨迹列表（Q2：多轨迹对比；清空全部也在这里）──
    this.trackPanel = new TrackPanel(root, this.player, {
      onChange: () => this.opts.onTracksChanged(),
      // 清空/清到零 → app 的 onClearAll（复位起点对齐提示与 HUD 提醒行）
      onCleared: () => this.opts.onClearAll(),
    });

    // ── 变换调整（录像↔地图对齐的人工微调；P3 加平移/yaw 输入与重置）──
    const tfBody = section(root, '变换调整');
    this.anchorNote = noteLine(tfBody);
    buttonRow(tfBody, [
      {
        label: '一键锚定到出生点',
        onClick: () => this.applyAnchor(),
        title: '把「录像首帧 → 最近出生点」的偏差作为平移叠加进变换，并重新导入当前轨道',
      },
    ]);
    this.refreshStartAnchor();
  }

  // ── 规则 ──────────────────────────────────────────────────────────

  /** scriptSrc 为空时使用内置默认规则（自家标准格式）。 */
  private effectiveRule(): RuleConfig {
    return this.rule.scriptSrc ? this.rule : { ...this.rule, scriptSrc: DEFAULT_RULE_SRC };
  }

  private loadRule(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<RuleConfig>;
      if (parsed && parsed.version === 1 && typeof parsed.scriptSrc === 'string') {
        this.rule = { ...defaultRule(), ...parsed } as RuleConfig;
      }
    } catch {
      /* 读取失败就用默认规则 */
    }
  }

  private saveRule(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.rule));
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  /** 轨迹增删后刷新轨迹列表（app 加完轨道调用）。 */
  refreshTracks(): void {
    this.trackPanel?.refresh();
  }

  // ── 导入 ──────────────────────────────────────────────────────────

  /** 载入一个录像文件（面板按钮 / 主窗口拖拽共用）。换文件＝追加一条新轨道。 */
  async loadFile(file: File): Promise<void> {
    this.file = file;
    this.lastTrackId = null;
    this.fileNote(`正在解析录像 ${file.name} …`);
    this.opts.onStatus(`正在解析录像 ${file.name} …`);
    // freshFile=true：把文件交给 importer/Worker（解析并缓存）；之后的重导复用缓存
    await this.runImport(true, true);
  }

  /**
   * 外部 API（URL 深链 / 打包演示）：直接喂 JSON 文本 + 可选规则，免文件选择。
   * 规则给定时先套用（覆盖 localStorage 里的旧规则），再走导入。
   */
  async loadUrlContent(jsonText: string, name: string, rule?: RuleConfig | null): Promise<void> {
    if (rule) {
      this.rule = { ...defaultRule(), ...rule } as RuleConfig;
      this.saveRule();
      this.fileNote(`已套用规则「${this.rule.name}」`, 'info');
    } else {
      this.saveRule();
    }
    const file = new File([jsonText], name, { type: 'application/json' });
    await this.loadFile(file);
  }

  private async loadSample(): Promise<void> {
    const text = buildSampleReplayText();
    const file = new File([text], SAMPLE_FILE_NAME, { type: 'application/json' });
    this.fileNote('已生成示例录像（螺旋下降，viewer 原生约定，默认规则可直接播）', 'info');
    await this.loadFile(file);
  }

  private async runImport(explicit: boolean, freshFile = false): Promise<void> {
    if (!this.file) {
      if (explicit) this.fileNote('还没有选择录像文件', 'warn');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.importer.import(
        freshFile ? this.file : null,
        this.effectiveRule(),
        this.file.name,
        (phase, done, total) => {
          const pct = total > 1 ? ` ${Math.round((done / total) * 100)}%` : '';
          this.opts.onStatus(
            phase === 'parse' ? `解析 JSON…${pct}` : `映射帧… ${done}/${total}${pct}`,
          );
        },
      );
      this.fileNote(
        result.warnings.length > 0 ? result.warnings.join('；') : '',
        result.warnings.length > 0 ? 'warn' : 'info',
      );
      this.lastTrackId = this.opts.onClip(result.clip, result.warnings, this.lastTrackId);
      const big = result.clip.count >= LARGE_CLIP_FRAMES;
      this.fileNote(
        `${this.file.name}：${result.clip.count.toLocaleString('en-US')} 帧，` +
          `${result.clip.duration.toFixed(2)} s，路径 ${result.resolvedPath || '（根数组）'}` +
          (big ? ' —— 帧数较多，改规则重新导入耗时较长' : ''),
        big ? 'warn' : 'info',
      );
      this.opts.onStatus('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.fileNote(msg, 'error');
      this.opts.onStatus('录像导入失败（见右侧面板）');
    } finally {
      this.busy = false;
    }
  }

  // ── 变换调整 ──────────────────────────────────────────────────────

  /**
   * 起点对齐提示：录像首帧（viewer 世界坐标）距离最近出生点多远。
   * 由 app 在导入 / 换图后调用。
   */
  refreshStartAnchor(): void {
    const aid = this.opts.getStartAid?.() ?? null;
    if (!aid) {
      this.anchorNote('载入录像并加载地图后，这里会检查录像起点是否贴近传送起点', 'info');
      return;
    }
    const near = aid.dist <= 128;
    this.anchorNote(
      `录像起点距最近出生点「${aid.spawnName}」${aid.dist.toFixed(0)} HU` +
        (near ? ' —— 已贴合传送起点' : ' —— 与传送起点不符：可一键锚定') +
        `（Δ=${aid.delta.map((v) => v.toFixed(1)).join(', ')}）`,
      near ? 'info' : 'warn',
    );
  }

  /**
   * 一键锚定：把起点偏差**叠加**进 rule.transform.offset（viewer 侧后处理），
   * 重新导入（替换当前轨道，不追加）。
   */
  applyAnchor(): void {
    const aid = this.opts.getStartAid?.() ?? null;
    if (!aid) return;
    const tf = this.rule.transform ?? { offset: [0, 0, 0] as [number, number, number], yawDeg: 0 };
    this.rule.transform = {
      offset: [
        tf.offset[0] + aid.delta[0],
        tf.offset[1] + aid.delta[1],
        tf.offset[2] + aid.delta[2],
      ],
      yawDeg: tf.yawDeg,
    };
    this.saveRule();
    this.anchorNote(
      `已按起点锚定平移 Δ=${aid.delta.map((v) => v.toFixed(1)).join(', ')}，重新导入中…`,
      'info',
    );
    void this.runImport(true);
  }

  /** 由 app 调用：展示当前 clip 的统计信息。 */
  showClipInfo(clip: Clip | null): void {
    this.infoBody.innerHTML = '';
    if (!clip) return;
    const rows: Array<[string, string]> = [
      ['帧数', clip.count.toLocaleString('en-US')],
      ['时长', `${clip.duration.toFixed(3)} s`],
      ['帧率', clip.duration > 0 ? `${(clip.count / clip.duration).toFixed(1)} 帧/秒` : '—'],
      ['最大速度', clip.vel ? `${clip.maxSpeed.toFixed(0)} HU/s` : '—'],
      ['解析路径', clip.resolvedPath || '（根数组）'],
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'kv');
      row.appendChild(el('span', 'k', k));
      row.appendChild(el('span', 'v mono', v));
      this.infoBody.appendChild(row);
    }
  }
}
