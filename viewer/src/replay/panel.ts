/**
 * 录像面板（右侧「录像」标签页）：导入 + 规则编辑器。
 *
 * 规则 = 一份声明式配置（表单）+ 由它生成的脚本（可手改）。
 * 表单改一次就重生成一次脚本；脚本被手改后表单不再覆盖（除非点「从表单重新生成」）。
 */

import {
  buttonRow,
  checkField,
  el,
  foldBox,
  noteLine,
  numField,
  section,
  selectField,
  textField,
} from '../core/dom.js';
import { PRESETS, applyPreset, generateScript } from './codegen.js';
import { CalibPanel } from './calibpanel.js';
import type { WorldRefs } from './calibpanel.js';
import { getPath, pickFrameArray } from './helpers.js';
import { computeOrientation, suggestYawFix } from './orientation.js';
import type { OrientFrame, OrientationReport } from './orientation.js';
import { TrackPanel } from './trackpanel.js';
import type { ReplayImporter } from './importer.js';
import type { ReplayPlayer } from './player.js';
import { buildSampleReplayText, SAMPLE_FILE_NAME } from './sample.js';
import { LARGE_CLIP_FRAMES } from './build.js';
import type {
  AngleUnit,
  AxisSrc,
  Clip,
  RuleConfig,
  Sign,
  TimeMode,
  TimeUnit,
} from './types.js';
import { defaultRule } from './types.js';
import type { ArrayCandidateInfo } from './protocol.js';
import type { Solution } from './calib.js';

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
  /** 世界侧参考点（标定面板用）：地图出生点 + 当前人物位置。 */
  getWorldRefs: () => WorldRefs;
  /** 起点对齐信息（无地图或无录像时返回 null）。 */
  getStartAid?: () => StartAid | null;
  onStatus: (text: string) => void;
}

const AXIS_OPTS = [
  { value: 'x', label: '输入 X' },
  { value: 'y', label: '输入 Y' },
  { value: 'z', label: '输入 Z' },
];

/** 取值路径类字段（都是 string）对应的 RuleConfig 键。 */
type StringRuleKey = 'posX' | 'posY' | 'posZ' | 'yawPath' | 'pitchPath' | 'rollPath' | 'velX' | 'velY' | 'velZ' | 'timePath' | 'framePath';
const SIGN_OPTS = [
  { value: '1', label: '＋' },
  { value: '-1', label: '－' },
];

export class ReplayPanel {
  private rule: RuleConfig = defaultRule();
  private file: File | null = null;
  /**
   * 上次导入承载结果的轨道 id。
   * 同一份文件改规则后的重新导入要**替换**那条轨道，否则每次改规则都会多出一条重复轨迹；
   * 换文件（loadFile）时清空，于是导入新文件＝追加一条轨道。
   */
  private lastTrackId: string | null = null;
  private candidates: ArrayCandidateInfo[] = [];
  private autoApply = true;
  private busy = false;
  private debounce = 0;

  private readonly scriptArea: HTMLTextAreaElement;
  private readonly customBadge: HTMLElement;
  private readonly pathSelect: HTMLSelectElement;
  private readonly pathInput: HTMLInputElement;
  private readonly sampleEl: HTMLElement;
  private readonly fileNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly scriptNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly locateNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly anchorNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly orientNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private readonly infoBody: HTMLElement;
  /** 组 2「对齐与校正」的折叠容器：有轨道后自动展开。 */
  private readonly g2Details: HTMLDetailsElement;
  /** 上一个已知轨道数（0 → >0 时才自动展开组 2，尊重手动折叠）。 */
  private trackPresence = 0;
  /** 坐标系预设下拉：组 1 快捷一份 + 组 3 原控件一份，同源双向同步。 */
  private presetQuickSel: HTMLSelectElement | null = null;
  private presetSel: HTMLSelectElement | null = null;
  /** 轴映射 / 符号 / 缩放 / 平移 的控件引用——标定求解后要把它们拉回同步。 */
  private readonly axisSelects: HTMLSelectElement[] = [];
  private readonly signSelects: HTMLSelectElement[] = [];
  private scaleInput: HTMLInputElement | null = null;
  private tickrateInput: HTMLInputElement | null = null;
  /** 字符串类（路径）输入控件的引用，见 pathField。 */
  private readonly pathInputs = new Map<StringRuleKey, HTMLInputElement>();
  private readonly offInputs: HTMLInputElement[] = [];
  private yawOffsetInput: HTMLInputElement | null = null;
  private orientDiagBtn: HTMLButtonElement | null = null;
  private orientFixBtn: HTMLButtonElement | null = null;
  private trackPanel: TrackPanel | null = null;
  private calibPanel: CalibPanel | null = null;

  /** 上次「朝向诊断」的结果（window.viewer.replay.orientation 的只读内省来源）。 */
  orientationResult: OrientationReport | null = null;
  /** 诊断用解析缓存（同一 File 只解析一次）。 */
  private diagCache: { file: File; root: unknown } | null = null;

  constructor(
    root: HTMLElement,
    private readonly importer: ReplayImporter,
    private readonly player: ReplayPlayer,
    private readonly opts: ReplayPanelOptions,
  ) {
    this.loadRule();

    // ── 三段式分组（构造时全量渲染，只折叠不惰性）──────────────────
    // 组 1 导入与播放（默认展开）｜组 2 对齐与校正（默认展开——朝向诊断/
    // 坐标系标定是契约要求默认可见的分区，见需求 §5-B6）｜组 3 高级规则
    // （默认收起）。分区标题与控件文本一律不动。
    const g1 = foldBox(root, '导入与播放', { open: true });
    const g2 = foldBox(root, '对齐与校正', { open: true });
    this.g2Details = g2.details;
    const g3 = foldBox(root, '高级规则（规则与映射）', {
      hint: '预设 · 数据定位 · 映射表单 · 脚本',
    });

    // ── 组 1 · 录像文件 ──
    const fileBody = section(g1.body, '录像文件');
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
        onClick: () => this.loadSample(),
        title: '生成一段合成的螺旋下降轨迹，用来验证整条导入链路',
      },
    ]);

    // 快捷坐标系预设（与「高级规则」里的预设下拉同源双向同步）：
    // Source / Shavit 录像先选预设再导入的最短路径
    this.presetQuickSel = selectField(fileBody, {
      label: '预设（快捷）',
      value: 'viewer-native',
      hint: '预设只是起点——坐标系约定千奇百怪，导入后请对照地图目视确认',
      options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
      onChange: (v) => this.applyPreset(v),
    });

    this.infoBody = el('div');
    this.infoBody.style.marginTop = '6px';
    fileBody.appendChild(this.infoBody);

    // ── 组 1 · 轨迹列表（Q2：多轨迹对比；清空全部也在这里）──
    this.trackPanel = new TrackPanel(g1.body, this.player, {
      onChange: () => this.opts.onTracksChanged(),
      // 组 2 默认展开；若用户曾手动收起，导入出轨道时自动再打开（清空不自动收起）
      onPresence: (n) => {
        if (this.trackPresence === 0 && n > 0) this.g2Details.open = true;
        this.trackPresence = n;
      },
      // 清空/清到零 → app 的 onClearAll（复位起点对齐提示与 HUD 提醒行）
      onCleared: () => this.opts.onClearAll(),
    });

    // ── 组 1 · 起点对齐（录像首帧应贴近地图传送起点；差距大时可一键平移锚定）──
    const anchorBody = section(g1.body, '起点对齐');
    this.anchorNote = noteLine(anchorBody);
    buttonRow(anchorBody, [
      { label: '一键锚定到出生点', onClick: () => this.applyAnchor() },
    ]);
    this.refreshStartAnchor();

    // ── 组 2 · 朝向诊断（只用录像自身数据：首段移动方向 vs 首帧朝向夹角）──
    const orientBody = section(g2.body, '朝向诊断');
    const orientIntro = el(
      'div',
      'note note-info',
      '取前 30 帧校验「移动方向 vs 首帧朝向」在源 / viewer 双空间保角（|差| ≤ 1°）。' +
        '内部一致性检查：抓不到整体旋转——那种错误用「起点对齐 / 坐标系标定」对着出生点校。',
    );
    orientIntro.title =
      '取录像前 30 帧：分别在源空间与 viewer 空间算「移动方向 vs 首帧朝向」夹角，' +
      '两者相等（|差|≤1°）即判定映射链自洽（注意：surf 起跑常侧身，绝对夹角大小不算失败）。' +
      '⚠ 这是**内部**一致性检查——它对任何正交映射都成立，无法发现轨迹相对地图整体旋转（那种错误用「起点对齐/坐标系标定」对着出生点校）。';
    orientBody.appendChild(orientIntro);
    buttonRow(orientBody, [
      {
        label: '运行朝向诊断',
        onClick: () => void this.runOrientationDiag(),
        title: '计算首段轨迹移动方向与首帧朝向的夹角（θ_view），并校验源/viewer 双空间保角',
      },
      {
        label: '一键修正朝向',
        onClick: () => void this.fixOrientation(),
        title: '在 yaw 偏移 {现状, +90, −90, +180} 中取夹角最小者应用并重新导入（pitch 不参与自动修正）',
      },
    ]).querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      if (b.textContent === '运行朝向诊断') this.orientDiagBtn = b;
      else this.orientFixBtn = b;
    });
    this.orientNote = noteLine(orientBody);

    // ── 组 2 · 坐标系标定（Q4）──
    this.calibPanel = new CalibPanel(g2.body, {
      importer: this.importer,
      getRule: () => this.rule,
      applySolution: (s) => this.applyCalibSolution(s),
      getWorldRefs: () => this.opts.getWorldRefs(),
      onStatus: (text) => this.opts.onStatus(text),
    });

    // ── 组 3 · 坐标系预设 ──
    const presetBody = section(g3.body, '坐标系预设');
    this.presetSel = selectField(presetBody, {
      label: '预设',
      value: 'viewer-native',
      hint: '预设只是起点——坐标系约定千奇百怪，导入后请对照地图目视确认',
      options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
      onChange: (v) => this.applyPreset(v),
    });

    // ── 组 3 · 数据定位 ──
    const locBody = section(g3.body, '数据定位');
    this.pathInput = textField(locBody, {
      label: '帧数组路径',
      value: this.rule.framePath,
      placeholder: '留空 = 自动探测',
      hint: '如 frames、data.ticks、recording.frames[0].ticks',
      onInput: (v) => {
        this.rule.framePath = v.trim();
        this.touch();
      },
    });
    const candRow = el('div', 'field');
    candRow.appendChild(el('span', 'field-label', '探测结果'));
    this.pathSelect = el('select', 'field-input');
    this.pathSelect.appendChild(el('option', undefined, '（尚未探测）', { value: '' }));
    this.pathSelect.addEventListener('change', () => {
      const v = this.pathSelect.value;
      if (!v) return;
      this.rule.framePath = v;
      this.pathInput.value = v;
      this.touch();
    });
    candRow.appendChild(this.pathSelect);
    locBody.appendChild(candRow);
    buttonRow(locBody, [
      {
        label: '探测 / 重新探测',
        onClick: () => void this.probe(),
        title: '解析 JSON 并列出所有「元素为对象的数组」，挑一个当作帧序列',
      },
    ]);
    this.locateNote = noteLine(locBody);
    this.sampleEl = el('div', 'note note-info mono');
    this.sampleEl.style.display = 'none';
    locBody.appendChild(this.sampleEl);

    // ── 组 3 · 位置 ──
    const posBody = section(g3.body, '位置');
    this.pathField(posBody, 'posX', 'X 路径', 'pos[0]');
    this.pathField(posBody, 'posY', 'Y 路径', 'pos[1]');
    this.pathField(posBody, 'posZ', 'Z 路径', 'pos[2]');

    posBody.appendChild(el('div', 'note note-info', '轴映射：输出轴取输入的哪个轴（含符号）'));
    this.axisRow(posBody, '输出 X ←', 'axisX', 'signX');
    this.axisRow(posBody, '输出 Y ←', 'axisY', 'signY');
    this.axisRow(posBody, '输出 Z ←', 'axisZ', 'signZ');

    this.scaleInput = numField(posBody, {
      label: '单位缩放',
      value: this.rule.posScale,
      step: 0.01,
      hint: '位置与速度同乘（英寸→HU、米→HU 等）',
      onInput: (v) => {
        this.rule.posScale = v;
        this.touch();
      },
    });

    const offNote = el(
      'div',
      'note note-info',
      '原点平移（缩放后加到输出坐标，只影响位置）——通常由「坐标系标定」自动解出。',
    );
    offNote.title =
      '原点平移（缩放后加到输出坐标上；只影响位置，不影响速度）。' +
      '通常由「坐标系标定」自动解出，一般不需要手填。';
    posBody.appendChild(offNote);
    for (const [i, label] of ['平移 X', '平移 Y', '平移 Z'].entries()) {
      const input = numField(posBody, {
        label,
        value: [this.rule.offX, this.rule.offY, this.rule.offZ][i],
        step: 10,
        hint: '把录像原点搬到地图原点',
        onInput: (v) => {
          if (i === 0) this.rule.offX = v;
          else if (i === 1) this.rule.offY = v;
          else this.rule.offZ = v;
          this.touch();
        },
      });
      this.offInputs.push(input);
    }
    checkField(
      posBody,
      '输入坐标是眼位（非脚底）',
      this.rule.posIsEye,
      (v) => {
        this.rule.posIsEye = v;
        this.touch();
      },
      '勾上时输出 Y 会减去站立眼高 64.09，换算回脚底',
    );

    // ── 组 3 · 朝向 ──
    const angBody = section(g3.body, '朝向');
    this.pathField(angBody, 'yawPath', 'yaw 路径', 'ang[1]');
    this.pathField(angBody, 'pitchPath', 'pitch 路径', 'ang[0]');
    this.pathField(angBody, 'rollPath', 'roll 路径', '可留空');
    selectField(angBody, {
      label: '角度单位',
      value: this.rule.angleUnit,
      options: [
        { value: 'deg', label: '度' },
        { value: 'rad', label: '弧度' },
      ],
      onChange: (v) => {
        this.rule.angleUnit = v as AngleUnit;
        this.touch();
      },
    });
    numField(angBody, {
      label: 'yaw 系数',
      value: this.rule.yawScale,
      step: 0.5,
      hint: 'yaw_out = wrap(yaw_in × 系数 + 偏移)',
      onInput: (v) => {
        this.rule.yawScale = v;
        this.touch();
      },
    });
    this.yawOffsetInput = numField(angBody, {
      label: 'yaw 偏移',
      value: this.rule.yawOffset,
      step: 15,
      onInput: (v) => {
        this.rule.yawOffset = v;
        this.touch();
      },
    });
    selectField(angBody, {
      label: 'pitch 符号',
      value: String(this.rule.pitchSign),
      hint: 'Source 系 pitch 正值为俯视，需要取反',
      options: [
        { value: '1', label: '正 = 仰视' },
        { value: '-1', label: '正 = 俯视（取反）' },
      ],
      onChange: (v) => {
        this.rule.pitchSign = Number(v) as Sign;
        this.touch();
      },
    });

    // ── 组 3 · 速度 ──
    const velBody = section(g3.body, '速度（可选）');
    const velNote = el(
      'div',
      'note note-info',
      '留空则无速度读数；⚠ Shavit 录像的 vel 是按键命令打包，不是世界速度——不要填。',
    );
    velNote.title =
      '留空则无速度显示；速度沿用位置那套轴映射与缩放。' +
      '⚠ Shavit 录像帧里的 vel 字段是按键命令（forwardmove | sidemove<<16），不是世界速度——不要填。';
    velBody.appendChild(velNote);
    this.pathField(velBody, 'velX', 'VX 路径', 'vel[0]');
    this.pathField(velBody, 'velY', 'VY 路径', 'vel[1]');
    this.pathField(velBody, 'velZ', 'VZ 路径', 'vel[2]');

    // ── 组 3 · 时间 ──
    const timeBody = section(g3.body, '时间');
    selectField(timeBody, {
      label: '时间来源',
      value: this.rule.timeMode,
      options: [
        { value: 'tick', label: '等间隔 tick（帧里没时间字段）' },
        { value: 'field', label: '帧里带时间字段' },
      ],
      onChange: (v) => {
        this.rule.timeMode = v as TimeMode;
        this.touch();
      },
    });
    numField(timeBody, {
      label: 'tickrate',
      value: this.rule.tickrate,
      step: 1,
      hint: 'tick 模式：t = 帧序号 / tickrate；字段模式且单位为 tick 时也用它换算',
      onInput: (v) => {
        this.rule.tickrate = v;
        this.touch();
      },
    });
    textField(timeBody, {
      label: '时间字段路径',
      value: this.rule.timePath,
      placeholder: 't / time / tick',
      onInput: (v) => {
        this.rule.timePath = v.trim();
        this.touch();
      },
    });
    selectField(timeBody, {
      label: '时间字段单位',
      value: this.rule.timeUnit,
      options: [
        { value: 's', label: '秒' },
        { value: 'ms', label: '毫秒' },
        { value: 'tick', label: 'tick 数' },
      ],
      onChange: (v) => {
        this.rule.timeUnit = v as TimeUnit;
        this.touch();
      },
    });

    // ── 组 3 · 脚本 ──
    const scriptBody = section(g3.body, '规则脚本（逃生舱）');
    const badgeRow = el('div', 'field');
    this.customBadge = el('span', 'badge', '已手工改写');
    this.customBadge.style.display = 'none';
    badgeRow.appendChild(this.customBadge);
    scriptBody.appendChild(badgeRow);

    this.scriptArea = el('textarea', 'script-area');
    this.scriptArea.spellcheck = false;
    this.scriptArea.addEventListener('input', () => {
      this.rule.scriptSrc = this.scriptArea.value;
      this.markCustomized(true);
      this.saveRule();
      this.scheduleImport();
    });
    scriptBody.appendChild(this.scriptArea);

    buttonRow(scriptBody, [
      { label: '应用脚本', onClick: () => void this.runImport(true) },
      {
        label: '从表单重新生成',
        onClick: () => {
          this.markCustomized(false);
          this.regenerate();
          void this.runImport(true);
        },
        title: '丢弃手改，按当前表单重生成脚本',
      },
      { label: '导出规则', onClick: () => this.exportRule() },
      { label: '导入规则', onClick: () => this.importRule() },
    ]);
    checkField(
      scriptBody,
      '改完自动重新导入（0.5s 防抖）',
      true,
      (v) => {
        this.autoApply = v;
      },
      '大文件建议关掉，改完手动点「应用脚本」',
    );
    this.scriptNote = noteLine(scriptBody);

    this.regenerate();
  }

  // ── 规则持久化 ────────────────────────────────────────────────────

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

  private exportRule(): void {
    const blob = new Blob([JSON.stringify(this.rule, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `replay-rule-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private importRule(): void {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.text().then((text) => {
        try {
          const parsed = JSON.parse(text) as Partial<RuleConfig>;
          if (parsed?.version !== 1 || typeof parsed.scriptSrc !== 'string') {
            this.scriptNote('这不像是规则文件（缺 version 或 scriptSrc）', 'error');
            return;
          }
          this.rule = { ...defaultRule(), ...parsed } as RuleConfig;
          this.syncFormFromRule();
          this.markCustomized(Boolean(this.rule.customized));
          this.saveRule();
          this.scriptNote('规则已导入', 'info');
          void this.runImport(true);
        } catch (e) {
          this.scriptNote(`规则解析失败：${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      });
    });
    input.click();
  }

  /** 规则被外部替换后，把表单控件拉回同步（导入规则文件用）。 */
  private syncFormFromRule(): void {
    this.pathInput.value = this.rule.framePath;
    this.scriptArea.value = this.rule.scriptSrc;
    this.syncNumericFields();
    // 其余控件交给页面刷新/下次生成时对齐；脚本是权威来源，重生成会覆盖表单语义
    this.scriptNote('已导入规则；表单控件将在下次交互时同步', 'warn');
  }

  /** 把轴映射 / 符号 / 缩放 / 平移 控件按当前 rule 刷新（标定求解后调用）。 */
  private syncNumericFields(): void {
    const axes: Array<AxisSrc> = [this.rule.axisX, this.rule.axisY, this.rule.axisZ];
    const signs: Array<Sign> = [this.rule.signX, this.rule.signY, this.rule.signZ];
    this.axisSelects.forEach((sel, i) => {
      if (axes[i] !== undefined) sel.value = axes[i];
    });
    this.signSelects.forEach((sel, i) => {
      if (signs[i] !== undefined) sel.value = String(signs[i]);
    });
    if (this.scaleInput) this.scaleInput.value = String(this.rule.posScale);
    const offs = [this.rule.offX, this.rule.offY, this.rule.offZ];
    this.offInputs.forEach((input, i) => {
      if (offs[i] !== undefined) input.value = String(offs[i]);
    });
  }

  /** 标定求解结果落盘：写进规则 → 同步表单 → 重新生成脚本 → 重新导入。 */
  private applyCalibSolution(s: Solution): void {
    this.rule.axisX = s.axis[0];
    this.rule.axisY = s.axis[1];
    this.rule.axisZ = s.axis[2];
    this.rule.signX = s.sign[0];
    this.rule.signY = s.sign[1];
    this.rule.signZ = s.sign[2];
    this.rule.posScale = s.scale;
    this.rule.offX = s.offset[0];
    this.rule.offY = s.offset[1];
    this.rule.offZ = s.offset[2];
    this.syncNumericFields();
    this.saveRule();
    if (!this.rule.customized) this.regenerate();
    void this.runImport(true);
  }

  /** 坐标系预设：组 1 快捷与组 3 原控件共用（同源双向同步，只写一次规则）。 */
  private applyPreset(id: string): void {
    applyPreset(this.rule, id);
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) {
      const hint = preset.hint;
      if (this.presetQuickSel) {
        this.presetQuickSel.value = id;
        this.presetQuickSel.title = hint;
      }
      if (this.presetSel) {
        this.presetSel.value = id;
        this.presetSel.title = hint;
      }
      this.locateNote(`已应用预设「${preset.label}」——预设只是起点，导入后请对照地图目视确认`);
    }
    this.touch();
  }

  /** 地图换过之后刷新标定面板的出生点下拉。 */
  refreshSpawns(): void {
    this.calibPanel?.refreshSpawns();
  }

  /** 轨迹增删后刷新轨迹列表（app 加完轨道调用）。 */
  refreshTracks(): void {
    this.trackPanel?.refresh();
  }

  // ── 表单 → 脚本 ──────────────────────────────────────────────────

  /**
   * 字符串类字段（各种路径）。统一登记引用，这样程序改规则（导入规则文件、
   * 自动识别来源）后能把输入框一起拉回同步，不会表单与规则各说各话。
   */
  private pathField(
    parent: HTMLElement,
    key: StringRuleKey,
    label: string,
    placeholder: string,
    hint?: string,
  ): HTMLInputElement {
    const input = textField(parent, {
      label,
      value: this.rule[key],
      placeholder,
      hint,
      onInput: (v) => {
        this.rule[key] = v.trim();
        this.touch();
      },
    });
    this.pathInputs.set(key, input);
    return input;
  }

  private axisRow(
    parent: HTMLElement,
    label: string,
    axisKey: 'axisX' | 'axisY' | 'axisZ',
    signKey: 'signX' | 'signY' | 'signZ',
  ): void {
    const row = el('div', 'field');
    row.appendChild(el('span', 'field-label', label));
    const axisSel = el('select', 'field-input');
    for (const o of AXIS_OPTS) axisSel.appendChild(el('option', undefined, o.label, { value: o.value }));
    axisSel.value = this.rule[axisKey];
    axisSel.addEventListener('change', () => {
      this.rule[axisKey] = axisSel.value as AxisSrc;
      this.touch();
    });
    row.appendChild(axisSel);
    this.axisSelects.push(axisSel);

    const signSel = el('select', 'field-input');
    signSel.style.maxWidth = '62px';
    signSel.style.flex = '0 0 auto';
    for (const o of SIGN_OPTS) signSel.appendChild(el('option', undefined, o.label, { value: o.value }));
    signSel.value = String(this.rule[signKey]);
    signSel.addEventListener('change', () => {
      this.rule[signKey] = Number(signSel.value) as Sign;
      this.touch();
    });
    row.appendChild(signSel);
    this.signSelects.push(signSel);
    parent.appendChild(row);
  }

  /** 表单改动：未手改过就重生成脚本，然后按需自动重导。 */
  private touch(): void {
    this.saveRule();
    if (!this.rule.customized) this.regenerate();
    this.scheduleImport();
  }

  private regenerate(): void {
    this.rule.scriptSrc = generateScript(this.rule);
    this.scriptArea.value = this.rule.scriptSrc;
  }

  private markCustomized(v: boolean): void {
    this.rule.customized = v;
    this.customBadge.style.display = v ? '' : 'none';
  }

  private scheduleImport(): void {
    window.clearTimeout(this.debounce);
    if (!this.autoApply || !this.file) return;
    this.debounce = window.setTimeout(() => void this.runImport(false), 500);
  }

  // ── 导入 ──────────────────────────────────────────────────────────

  /** 载入一个录像文件（面板按钮 / 主窗口拖拽共用）。换文件＝追加一条新轨道。 */
  async loadFile(file: File): Promise<void> {
    this.file = file;
    this.lastTrackId = null;
    this.fileNote(`正在探测 ${file.name} …`);
    this.opts.onStatus(`正在解析录像 ${file.name} …`);
    await this.probe();
    await this.runImport(true);
  }

  /**
   * 外部 API（URL 深链 / 打包演示）：直接喂 JSON 文本 + 可选规则，免文件选择。
   * 规则给定时先套用（覆盖 localStorage 里的旧规则），再走 loadFile 的探测+导入。
   */
  async loadUrlContent(jsonText: string, name: string, rule?: RuleConfig | null): Promise<void> {
    if (rule) {
      this.rule = { ...defaultRule(), ...rule } as RuleConfig;
      this.syncFormFromRule();
      this.markCustomized(Boolean(this.rule.customized));
      this.saveRule();
      this.scriptNote(`已套用规则「${this.rule.name}」`, 'info');
    } else {
      this.saveRule();
    }
    const file = new File([jsonText], name, { type: 'application/json' });
    await this.loadFile(file);
  }

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
        (near ? ' —— 已贴合传送起点' : ' —— 与传送起点不符：可一键锚定，或检查坐标系映射') +
        `（Δ=${aid.delta.map((v) => v.toFixed(1)).join(', ')}）`,
      near ? 'info' : 'warn',
    );
  }

  /**
   * 一键锚定：把起点偏差作为平移写进规则（作用于输出坐标），
   * 重新生成脚本并重新导入（替换当前轨道，不追加）。
   */
  applyAnchor(): void {
    const aid = this.opts.getStartAid?.() ?? null;
    if (!aid) return;
    this.rule.offX += aid.delta[0];
    this.rule.offY += aid.delta[1];
    this.rule.offZ += aid.delta[2];
    this.syncNumericFields();
    this.markCustomized(false);
    this.regenerate();
    this.saveRule();
    this.scriptNote(
      `已按起点锚定平移 Δ=${aid.delta.map((v) => v.toFixed(1)).join(', ')}，重新导入中…`,
      'info',
    );
    void this.runImport(true);
  }

  // ── 朝向诊断（§3：只用录像自身数据，不依赖地图/出生点）───────────────

  /** 读当前录像文件：解析 JSON（带缓存）→ 按规则/自动探测定位帧数组 → 返回原始帧。 */
  private async rawFramesForDiagnosis(): Promise<{ frames: OrientFrame[]; preFrames: number }> {
    if (!this.file) throw new Error('先载入一个录像文件再诊断');
    if (!this.diagCache || this.diagCache.file !== this.file) {
      const text = await this.file.text();
      let root: unknown;
      try {
        root = JSON.parse(text);
      } catch (e) {
        throw new Error(`录像 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
      }
      this.diagCache = { file: this.file, root };
    }
    const root = this.diagCache.root;
    const path = this.rule.framePath || pickFrameArray(root) || '';
    const arr = path ? getPath(root, path) : root;
    if (!Array.isArray(arr) || arr.length < 2) {
      throw new Error(
        this.rule.framePath
          ? `路径 "${path}" 取到的不是帧数组（先确认「数据定位」）`
          : '没能在 JSON 里自动找到帧数组（先点「探测」确认帧数组路径）',
      );
    }
    const meta = (root as { meta?: { preFrames?: unknown } }).meta;
    const pf = meta?.preFrames;
    const preFrames = typeof pf === 'number' && Number.isFinite(pf) && pf > 0 ? Math.floor(pf) : 0;
    return { frames: arr as OrientFrame[], preFrames };
  }

  /** 有轨道（文件导入成功）后才允许诊断/修正。 */
  private refreshOrientButtons(): void {
    const on = Boolean(this.file && this.lastTrackId);
    if (this.orientDiagBtn) this.orientDiagBtn.disabled = !on;
    if (this.orientFixBtn) this.orientFixBtn.disabled = !on;
  }

  /** 把报告渲染到面板，并更新只读内省钩子 orientationResult。 */
  private renderOrientation(report: OrientationReport): void {
    this.orientationResult = report;
    if (report.applied) {
      this.orientNote(
        `✔ 已应用一键修正：yaw 偏移 ${report.applied.yawOffsetFrom}° → ${report.applied.yawOffsetTo}°，` +
          `夹角 ${report.applied.angleBefore.toFixed(1)}° → ${report.applied.angleAfter.toFixed(1)}°；` +
          (report.verdict === 'pass'
            ? '现判定一致 ✓'
            : `现判定 ${report.verdict}（θ_view=${report.angleDeg.toFixed(1)}°）`),
        'info',
      );
      return;
    }
    const conf = report.conformal
      ? ''
      : `；⚠ 源/viewer 保角差 ${Math.abs(report.srcAngleDeg - report.angleDeg).toFixed(1)}° > 1°（映射链疑似镜像/翻转）`;
    const base =
      report.verdict === 'skip'
        ? ''
        : `θ_view = ${report.angleDeg.toFixed(1)}°（源空间 ${report.srcAngleDeg.toFixed(1)}°，` +
          `位移 ${report.displacement.toFixed(1)} HU，Δyaw ${report.deltaYaw.toFixed(1)}°` +
          `${report.preFramesUsed ? '，preFrames 窗口' : ''}${conf}）`;
    if (report.verdict === 'pass') {
      this.orientNote(
        `✓ 朝向自洽：${base}\n` +
          '注意：这**只**说明「录像里的人朝着自己移动的方向」，是**内部**一致性。\n' +
          '它对任何正交映射都成立，因此**无法**发现「整条轨迹相对地图旋转了 90°」这类错误——\n' +
          '那种情况要看出轨迹是否贴着地图（穿墙/浮空），或用「坐标系标定」对着出生点校。',
        'info',
      );
    } else if (report.verdict === 'fix') {
      this.orientNote(
        `⚠ 映射链不自洽（θ_view 与 θ_src 差 ${Math.abs(report.angleDeg - report.srcAngleDeg).toFixed(1)}° > 1°）` +
          `——yaw 偏移或轴映射与规则不配套。${base} 可点「一键修正朝向」，或对照地图标定。`,
        'warn',
      );
    } else {
      this.orientNote(`⚠ 数据不足：${report.reason ?? '无有效窗口'}`, 'warn');
    }
  }

  /** 「运行朝向诊断」：计算 θ_view 并展示报告。 */
  async runOrientationDiag(): Promise<void> {
    try {
      const data = await this.rawFramesForDiagnosis();
      this.renderOrientation(computeOrientation(data.frames, this.rule, data.preFrames));
    } catch (e) {
      this.orientNote(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** 「一键修正朝向」：候选 yaw 偏移取与源空间自洽（|θ_view − θ_src| ≤ 1°）者应用并重新导入；pitch 不参与。 */
  async fixOrientation(): Promise<void> {
    let data: { frames: OrientFrame[]; preFrames: number };
    try {
      data = await this.rawFramesForDiagnosis();
    } catch (e) {
      this.orientNote(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    const suggestion = suggestYawFix(data.frames, this.rule, data.preFrames);
    if (suggestion.needHuman) {
      this.renderOrientation(computeOrientation(data.frames, this.rule, data.preFrames));
      this.orientNote(suggestion.reason ?? '需要目视确认：起跑转向起步或数据异常，未改动规则', 'warn');
      return;
    }
    const before = computeOrientation(data.frames, this.rule, data.preFrames);
    if (!suggestion.applicable) {
      this.renderOrientation(before);
      this.orientNote('当前映射已自洽（θ_view ≈ θ_src），无需修正', 'info');
      return;
    }
    const from = suggestion.yawOffsetFrom;
    const to = suggestion.yawOffsetTo;
    this.rule.yawOffset = to;
    if (this.yawOffsetInput) this.yawOffsetInput.value = String(to);
    this.markCustomized(false);
    this.regenerate();
    this.saveRule();
    this.scriptNote(
      `一键修正朝向：yaw 偏移 ${from}° → ${to}°（夹角 ${suggestion.angleBefore.toFixed(1)}° → ` +
        `${suggestion.angleAfter.toFixed(1)}°），重新导入中…`,
      'info',
    );
    try {
      await this.runImport(true);
    } catch {
      /* 规则问题会在 runImport 内提示；修正记录照常呈现 */
    }
    const after = computeOrientation(data.frames, this.rule, data.preFrames);
    after.applied = {
      yawOffsetFrom: from,
      yawOffsetTo: to,
      angleBefore: suggestion.angleBefore,
      angleAfter: suggestion.angleAfter,
    };
    this.renderOrientation(after);
  }

  private async loadSample(): Promise<void> {
    const text = buildSampleReplayText();
    const file = new File([text], SAMPLE_FILE_NAME, { type: 'application/json' });
    this.fileNote('已生成示例录像（螺旋下降，viewer 原生约定，默认规则可直接播）', 'info');
    await this.loadFile(file);
  }

  private async probe(): Promise<void> {
    if (!this.file) {
      this.locateNote('先选一个 JSON 文件', 'warn');
      return;
    }
    try {
      const res = await this.importer.probe(this.file);
      this.candidates = res.candidates;
      this.pathSelect.innerHTML = '';
      this.pathSelect.appendChild(el('option', undefined, '（自动：留空）', { value: '' }));
      for (const c of res.candidates) {
        const label = `${c.path === '' ? '（根数组）' : c.path} — ${c.length} 项`;
        this.pathSelect.appendChild(el('option', undefined, label, { value: c.path }));
      }
      if (res.resolvedPath !== null && !this.rule.framePath) {
        this.pathSelect.value = res.resolvedPath;
        this.locateNote(`已自动选中最长的候选：${res.resolvedPath || '（根数组）'}`);
      } else {
        this.locateNote('探测完成，请确认帧数组路径');
      }
      if (res.sample) {
        this.sampleEl.style.display = '';
        this.sampleEl.textContent = `首帧样例：${res.sample}`;
      }
    } catch (e) {
      this.locateNote(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private async runImport(explicit: boolean): Promise<void> {
    if (!this.file) {
      if (explicit) this.scriptNote('还没有选择录像文件', 'warn');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.scriptNote('正在应用规则…', 'info');
    try {
      const result = await this.importer.import(
        null,
        this.rule,
        this.file.name,
        (phase, done, total) => {
          const pct = total > 1 ? ` ${Math.round((done / total) * 100)}%` : '';
          this.opts.onStatus(
            phase === 'parse' ? `解析 JSON…${pct}` : `映射帧… ${done}/${total}${pct}`,
          );
        },
      );
      this.scriptNote(
        result.warnings.length > 0 ? result.warnings.join('；') : '',
        result.warnings.length > 0 ? 'warn' : 'info',
      );
      this.lastTrackId = this.opts.onClip(result.clip, result.warnings, this.lastTrackId);
      this.refreshOrientButtons();
      const big = result.clip.count >= LARGE_CLIP_FRAMES;
      this.fileNote(
        `${this.file.name}：${result.clip.count.toLocaleString('en-US')} 帧，` +
          `${result.clip.duration.toFixed(2)} s，路径 ${result.resolvedPath || '（根数组）'}` +
          (big ? ' —— 帧数较多，建议关掉下面的「改完自动重新导入」，改完手动点「应用脚本」' : ''),
        big ? 'warn' : 'info',
      );
      this.opts.onStatus('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.scriptNote(msg, 'error');
      this.opts.onStatus('录像导入失败（见右侧面板）');
    } finally {
      this.busy = false;
    }
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
