/**
 * 录像面板（右侧「录像」标签页）：导入、坐标映射切换、轨迹列表、调整工具四段。
 *
 * 职责边界：本文件负责人机交互与规则持久化，不做解析（交给
 * `apps/viewer/src/replay/importer.ts` 的 `ReplayImporter`）、不改轨道结构
 * （进出的 clip 交给 `onClip`，由 `apps/viewer/src/app.ts` 决定追加还是替换轨道）。
 *
 * 关键不变量：
 * - 导入基准是**帧自身坐标**：轴序与朝向映射只随 `RuleConfig` 的 `axesMode` / `yawMode` 走，
 *   平移与旋转只来自 `RuleConfig.transform`，并只在用户显式写过输入后才非恒等；
 * - 「同一份文件改映射/变换」与「换文件」是两条分支：`lastTrackId` 非 null 时把 `onClip` 的
 *   返回值当作替换目标（替换那条轨道、保留它的配色/显隐/偏移/名字），`loadFile` 先把它清成
 *   null，于是换文件即追加新轨道；
 * - 任何一次导入都受 `busy` 保护：进行中再次触发的请求一律丢弃（不排队），只写提示。
 */

import { buttonRow, checkField, el, foldBox, noteLine, numField, section } from '../core/dom.js';
import { TrackPanel } from './trackpanel.js';
import type { ReplayImporter } from './importer.js';
import type { ReplayPlayer } from './player.js';
import { LARGE_CLIP_FRAMES } from './build.js';
import type { Clip, RuleConfig, YawMode, AxesMode } from './types.js';
import { defaultRule } from './types.js';

/** 规则持久化的 localStorage 键（带版本号；读取失败或版本不符即回落到内置默认规则）。 */
const STORAGE_KEY = 'websurf-viewer.replay-rule.v2';

export interface ReplayPanelOptions {
  /**
   * 导入成功（或重新导入成功）时回调，返回**实际承载这份 clip 的轨道 id**——
   * 本面板把它存进 `lastTrackId`，下次重新导入时原样带回来当替换目标。
   * `replaceId` 为 null 表示没有可替换的轨道（换文件 / 轨道已被移除）。
   */
  onClip: (clip: Clip, warnings: string[], replaceId: string | null) => string;
  /** 清空全部轨迹（面板的「清空全部」与「移除到零」都走它）。 */
  onClearAll: () => void;
  /** 轨道属性变化（显隐 / 偏移 / 重命名 / 移除 / 跟随）→ 重建可视化、时间轴与信息条。 */
  onTracksChanged: () => void;
  /** 状态行文本（解析进度、工具结果、错误）；空串表示清除。 */
  onStatus: (text: string) => void;
}

export class ReplayPanel {
  /** 当前规则（构造时从 localStorage 读，改动即写回）。 */
  private rule: RuleConfig = defaultRule();
  /** 当前导入目标文件；重新导入（改映射/变换）复用它，不要求用户再选一次。 */
  private file: File | null = null;
  /**
   * 上次导入承载结果的轨道 id，即下次重新导入的替换目标。
   * `loadFile`（换文件的所有入口）把它清空，于是下一次导入走追加分支。
   */
  private lastTrackId: string | null = null;
  /** 导入进行中标记；为真时新的导入请求被丢弃。 */
  private busy = false;

  /** 导入分区提示行（文件选择、解析进度、导入摘要与警告）。 */
  private readonly fileNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  /** 调整工具分区提示行（映射切换、变换更新、重置）。 */
  private readonly tfNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  /** 轨迹列表面板实例（构造时建好，`refreshTracks` 只转发给它）。 */
  private trackPanel: TrackPanel | null = null;

  /** 三个平移输入框（顺序 = X、Y、Z，id 依次为 `tf-offX` / `tf-offY` / `tf-offZ`）。 */
  private readonly tfOffInputs: HTMLInputElement[] = [];
  /** 旋转输入框（id `tf-yaw`），`bumpYaw` 与重置都要读它。 */
  private tfYawInput: HTMLInputElement | null = null;
  /** 变换重导的防抖定时器句柄（`window.setTimeout` 的返回值，0 表示当前没有待触发的定时器）。 */
  private tfDebounce = 0;

  /**
   * 建四段 UI 并读一次已保存的规则。构造期只建节点、不导入任何文件。
   * 「调整工具」的平移/旋转分组不给 `open`，故初始为折叠态。
   */
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
    fileInput.accept = '.replay';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (f) void this.loadFile(f);
    });
    fileBody.appendChild(fileInput);

    buttonRow(fileBody, [
      {
        label: '选择录像文件…',
        onClick: () => fileInput.click(),
        title: '.replay = Shavit 原生录像，零配置直入（帧自身坐标直接播放）',
      },
    ]);

    // ── 轨迹列表（多轨迹对比；清空全部也在这里）──
    this.trackPanel = new TrackPanel(root, this.player, {
      onChange: () => this.opts.onTracksChanged(),
      onCleared: () => this.opts.onClearAll(),
    });

    // ── 坐标映射（两个映射开关的界面侧；默认直读帧自身坐标、不叠加平移）──
    const mapBody = section(root, '坐标映射');
    noteLine(mapBody)(
      '默认直读 .replay 帧自身坐标（标准轴序 + 实测朝向映射）。轨迹与地图对不上时切换对照项，不用改任何平移。',
      'info',
    );
    checkField(
      mapBody,
      '坐标轴映射：标准（Source [x,y,z] → viewer [y,z,x]）',
      this.rule.axesMode === 'shavit',
      (v) => this.setAxesMode(v ? 'shavit' : 'raw'),
      '与地图 GLB 导出同一变换（rotate_yup）。轨迹整体轴错位/侧转 90° 时切换「直读 [x,y,z]」对照。',
    );
    checkField(
      mapBody,
      '朝向轴映射：实测定标（yaw+180、pitch 取反）',
      this.rule.yawMode === 'shavit',
      (v) => this.setYawMode(v ? 'shavit' : 'raw'),
      '真实 run 段「视角·运动方向」平均 cos=0.9992（+180 口径）。朝向反了/镜像时切换「角度直读」对照。',
    );

    // ── 调整工具（仅用户显式设置时叠加；初始折叠）──
    const tfBody = section(root, '调整工具');
    this.tfNote = noteLine(tfBody);
    const tfFold = foldBox(tfBody, '平移 / 旋转');
    const tfTools = tfFold.body;
    const tf = this.rule.transform ?? { offset: [0, 0, 0] as [number, number, number], yawDeg: 0 };
    // 三个平移输入（X/Y/Z 各一个），步长 10 HU，绑同一个重导回调
    const offLabels = ['平移 X', '平移 Y', '平移 Z'] as const;
    offLabels.forEach((label, i) => {
      const input = numField(tfTools, {
        label,
        value: tf.offset[i] ?? 0,
        step: 10,
        hint: 'HU；显式叠加在帧坐标上（默认 0 = 播放帧自身坐标）',
        onInput: () => this.applyTransformFromInputs(),
      });
      input.id = ['tf-offX', 'tf-offY', 'tf-offZ'][i];
      this.tfOffInputs.push(input);
    });
    const yawInput = numField(tfTools, {
      label: '旋转 yaw（度）',
      value: tf.yawDeg,
      step: 15,
      hint: '绕 Y 旋转：pos/vel 同步旋转、yaw 同步加该角（正 = 逆时针，对照 viewer 约定）',
      onInput: () => this.applyTransformFromInputs(),
    });
    yawInput.id = 'tf-yaw';
    this.tfYawInput = yawInput;
    buttonRow(tfTools, [
      {
        label: 'yaw +90°',
        onClick: () => this.bumpYaw(90),
        title: '整条轨迹绕竖直轴转 90°（轨迹相对地图侧转 90° 时的修正）',
      },
      {
        label: 'yaw −90°',
        onClick: () => this.bumpYaw(-90),
        title: '整条轨迹绕竖直轴转 −90°',
      },
      {
        label: '重置变换',
        onClick: () => this.resetTransform(),
        title: '清零平移与旋转（回到帧自身坐标）并重新导入当前轨道',
      },
    ]);
    this.tfNote('播放基准 = 帧自身坐标；下面都是可选项，不动就是原始轨迹。', 'info');
  }

  // ── 规则持久化 ────────────────────────────────────────────────────

  /**
   * 读持久化规则：没有存档时顺手清掉旧版键并保留内置默认规则；
   * 有存档时只在「`version === 2` 且两个映射字段都取合法字面量」时才采用，
   * 否则整个存档被忽略（`transform` 不做校验，按存档原样取）。
   * 读或解析抛异常时同样保留默认规则。
   */
  private loadRule(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // 旧版 v1 键已随 JSON 通道移除：清掉，避免误导
        localStorage.removeItem('websurf-viewer.replay-rule.v1');
        return;
      }
      const parsed = JSON.parse(raw) as Partial<RuleConfig>;
      if (
        parsed &&
        parsed.version === 2 &&
        (parsed.axesMode === 'shavit' || parsed.axesMode === 'raw') &&
        (parsed.yawMode === 'shavit' || parsed.yawMode === 'raw')
      ) {
        this.rule = {
          ...defaultRule(),
          axesMode: parsed.axesMode,
          yawMode: parsed.yawMode,
          transform: parsed.transform,
        };
      }
    } catch {
      /* 读取失败就用默认规则 */
    }
  }

  /** 写回持久化规则；写失败（如隐私模式）时静默忽略。 */
  private saveRule(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.rule));
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  /** 轨道增删后刷新轨迹列表（`apps/viewer/src/app.ts` 的 `onClip` / `onClearAll` / 跟随切换都调它）。 */
  refreshTracks(): void {
    this.trackPanel?.refresh();
  }

  // ── 坐标映射切换 ──────────────────────────────────────────────────

  /** 切轴序映射：与当前值相同则直接返回；否则写规则、落盘、提示，并触发一次重新导入。 */
  private setAxesMode(mode: AxesMode): void {
    if (this.rule.axesMode === mode) return;
    this.rule.axesMode = mode;
    this.saveRule();
    this.tfNote(
      `坐标轴映射 → ${mode === 'shavit' ? '标准 [y,z,x]' : '直读 [x,y,z]'}，重新导入中…`,
      'info',
    );
    void this.runImport(true);
  }

  /** 切朝向映射：与当前值相同则直接返回；否则写规则、落盘、提示，并触发一次重新导入。 */
  private setYawMode(mode: YawMode): void {
    if (this.rule.yawMode === mode) return;
    this.rule.yawMode = mode;
    this.saveRule();
    this.tfNote(
      `朝向轴映射 → ${mode === 'shavit' ? '实测定标（yaw+180、pitch 取反）' : '角度直读'}，重新导入中…`,
      'info',
    );
    void this.runImport(true);
  }

  // ── 导入 ──────────────────────────────────────────────────────────

  /**
   * 载入一份录像文件：进行中（`busy`）则只写提示并返回；否则记下文件、把 `lastTrackId`
   * 清空（于是本次导入追加新轨道），写两条「正在解析」提示后开始导入。
   * 面板按钮、主窗口拖拽（`apps/viewer/src/app.ts` 的 drop 处理）与 URL 深链共用本入口。
   */
  async loadFile(file: File): Promise<void> {
    if (this.busy) {
      this.fileNote('上一次导入还在进行，请稍候再试', 'warn');
      return;
    }
    this.file = file;
    this.lastTrackId = null;
    this.fileNote(`正在解析录像 ${file.name} …`);
    this.opts.onStatus(`正在解析录像 ${file.name} …`);
    await this.runImport(true);
  }

  /**
   * 走一次导入：没有目标文件时只有显式请求才提示；`busy` 期间的请求直接丢弃（不排队，
   * 显式请求会写「本次改动未生效」）；其余情况置 `busy`，调 `importer.import` 并把结果交给
   * `onClip`（返回值存回 `lastTrackId`），随后写摘要与警告、清状态行；异常写错误提示；
   * `finally` 复位 `busy`。
   *
   * 摘要里 `LARGE_CLIP_FRAMES` 的判定只影响文案与提示级别（帧数多时提示重导较慢）。
   */
  private async runImport(explicit: boolean): Promise<void> {
    if (!this.file) {
      if (explicit) this.fileNote('还没有选择录像文件', 'warn');
      return;
    }
    if (this.busy) {
      // 大文件导入期间到达的重导请求（防抖回调/映射切换）不排队，明确告知
      if (explicit) this.fileNote('上一次导入还在进行，本次改动未生效——请稍候重试', 'warn');
      return;
    }
    this.busy = true;
    try {
      const result = await this.importer.import(
        this.file,
        this.rule,
        this.file.name,
        (phase, done, total) => {
          const pct = total > 1 ? ` ${Math.round((done / total) * 100)}%` : '';
          if (phase === 'parse') this.opts.onStatus(`解析 .replay…${pct}`);
        },
      );
      this.lastTrackId = this.opts.onClip(result.clip, result.warnings, this.lastTrackId);
      const big = result.clip.count >= LARGE_CLIP_FRAMES;
      // warnings 与摘要合并为一条 note（warnings 若独占会被摘要立即覆盖）
      const summary =
        `${this.file.name}：${result.clip.count.toLocaleString('en-US')} 帧，` +
        `${result.clip.duration.toFixed(2)} s` +
        (result.clip.vel ? `，最大速度 ${result.clip.maxSpeed.toFixed(0)} u/s` : '') +
        (big ? ' —— 帧数较多，改映射/变换重新导入耗时较长' : '');
      this.fileNote(
        result.warnings.length > 0 ? result.warnings.join('；') + ' —— ' + summary : summary,
        result.warnings.length > 0 || big ? 'warn' : 'info',
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

  // ── 调整工具（仅显式叠加）──────────────────────────────────────────

  /**
   * 读四个输入框 → 写 `rule.transform` → 落盘 → 500 ms 防抖后重新导入。
   * 任一输入不是有限数时直接返回（不改规则、不重导）；空串经 `Number('')` 得 0 会落进有效分支，
   * 即把该分量写成 0。每次输入都会重置防抖定时器，故连续敲键只在停顿后触发一次重导。
   */
  private applyTransformFromInputs(): void {
    const off = this.tfOffInputs.map((el) => Number(el.value));
    const yaw = Number(this.tfYawInput?.value ?? 0);
    if (!off.every(Number.isFinite) || !Number.isFinite(yaw)) return;
    this.rule.transform = {
      offset: [off[0] ?? 0, off[1] ?? 0, off[2] ?? 0],
      yawDeg: yaw,
    };
    this.saveRule();
    window.clearTimeout(this.tfDebounce);
    this.tfDebounce = window.setTimeout(() => {
      this.tfNote('变换已更新，重新导入中…', 'info');
      void this.runImport(true);
    }, 500);
  }

  /** 在当前 yaw 上叠加 `delta` 度（`Number(...) || 0` 把非数值按 0 处理），再走一次输入回调。无 yaw 输入框时不做任何事。 */
  private bumpYaw(delta: number): void {
    if (!this.tfYawInput) return;
    const cur = Number(this.tfYawInput.value) || 0;
    this.tfYawInput.value = String(cur + delta);
    this.applyTransformFromInputs();
  }

  /** 重置变换：三个平移输入与 yaw 输入都写回 `'0'`，规则里的 `transform` 置恒等并落盘，随后立即（不经防抖）重新导入。 */
  private resetTransform(): void {
    for (const el of this.tfOffInputs) el.value = '0';
    if (this.tfYawInput) this.tfYawInput.value = '0';
    this.rule.transform = { offset: [0, 0, 0], yawDeg: 0 };
    this.saveRule();
    this.tfNote('变换已重置（回到帧自身坐标），重新导入中…', 'info');
    void this.runImport(true);
  }
}
