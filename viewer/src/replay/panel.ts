/**
 * 录像面板（右侧「录像」标签页）：导入 + 坐标映射切换 + 轨迹列表 + 变换调整。
 *
 * t4 播放基准：导入即以 .replay 帧自身坐标播放（解码只做标准坐标映射，默认零变换）；
 * 「调整工具」的平移/旋转与「坐标映射」切换仅在用户显式设置时叠加。
 * 「换文件＝追加轨道；改映射/变换＝替换当前轨道」的语义不变。
 */

import { buttonRow, checkField, el, foldBox, noteLine, numField, section } from '../core/dom.js';
import { TrackPanel } from './trackpanel.js';
import type { ReplayImporter } from './importer.js';
import type { ReplayPlayer } from './player.js';
import { LARGE_CLIP_FRAMES } from './build.js';
import type { Clip, RuleConfig, YawMode, AxesMode } from './types.js';
import { defaultRule } from './types.js';

const STORAGE_KEY = 'websurf-viewer.replay-rule.v2';

export interface ReplayPanelOptions {
  /**
   * 导入成功。
   * `replaceId` 非 null 表示这是对同一份文件改映射/变换后的重新导入——替换那条轨道，别追加。
   * 返回实际承载这份 clip 的轨道 id，供下次重新导入复用。
   */
  onClip: (clip: Clip, warnings: string[], replaceId: string | null) => string;
  /** 清空全部轨迹。 */
  onClearAll: () => void;
  /** 轨道属性变化（显隐 / 偏移 / 重命名 / 移除 / 跟随）→ 重建可视化。 */
  onTracksChanged: () => void;
  onStatus: (text: string) => void;
}

export class ReplayPanel {
  private rule: RuleConfig = defaultRule();
  private file: File | null = null;
  /**
   * 上次导入承载结果的轨道 id。
   * 同一份文件改映射/变换后的重新导入要**替换**那条轨道，否则每次改动都会多出一条重复轨迹；
   * 换文件（loadFile）时清空，于是导入新文件＝追加一条轨道。
   */
  private lastTrackId: string | null = null;
  private busy = false;

  private readonly fileNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  /** 变换/映射状态 note（调整工具分区顶部，常显）。 */
  private readonly tfNote: (t: string, k?: 'info' | 'warn' | 'error') => void;
  private trackPanel: TrackPanel | null = null;

  /** 变换调整输入（offset X/Y/Z + yaw°），见构造器「调整工具」分区。 */
  private readonly tfOffInputs: HTMLInputElement[] = [];
  private tfYawInput: HTMLInputElement | null = null;
  private tfDebounce = 0;

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

    // ── 轨迹列表（Q2：多轨迹对比；清空全部也在这里）──
    this.trackPanel = new TrackPanel(root, this.player, {
      onChange: () => this.opts.onTracksChanged(),
      onCleared: () => this.opts.onClearAll(),
    });

    // ── 坐标映射（t4：两个切换按钮的 src 侧支撑；默认直读无变换）──
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

    // ── 调整工具（仅用户显式设置时叠加；默认折叠，不再自动展开）──
    const tfBody = section(root, '调整工具');
    this.tfNote = noteLine(tfBody);
    const tfFold = foldBox(tfBody, '平移 / 旋转');
    const tfTools = tfFold.body;
    const tf = this.rule.transform ?? { offset: [0, 0, 0] as [number, number, number], yawDeg: 0 };
    // 三个平移输入（X/Y/Z 各一个）；t5 修复：此前 '平移 X 平移 Y 平移 Z'.split(' ')
    // 生成 6 个输入（后 3 个 value=undefined、id 越界），偏移读数错位
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

  private loadRule(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // 旧版 v1 脚本规则已随 JSON 通道移除：清掉，避免误导
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

  // ── 坐标映射切换（t4 ②）────────────────────────────────────────────

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

  /** 载入一个录像文件（面板按钮 / 主窗口拖拽 / 深链共用）。换文件＝追加一条新轨道。 */
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

  /** 读取变换输入 → 写规则 → 防抖重导（复用已缓存文件，替换当前轨道）。 */
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

  private bumpYaw(delta: number): void {
    if (!this.tfYawInput) return;
    const cur = Number(this.tfYawInput.value) || 0;
    this.tfYawInput.value = String(cur + delta);
    this.applyTransformFromInputs();
  }

  private resetTransform(): void {
    for (const el of this.tfOffInputs) el.value = '0';
    if (this.tfYawInput) this.tfYawInput.value = '0';
    this.rule.transform = { offset: [0, 0, 0], yawDeg: 0 };
    this.saveRule();
    this.tfNote('变换已重置（回到帧自身坐标），重新导入中…', 'info');
    void this.runImport(true);
  }
}
