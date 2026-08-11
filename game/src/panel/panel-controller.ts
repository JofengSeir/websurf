/**
 * ESC 弹出式控制面板 — 桌面两栏（左侧模块导航 + 右侧设置）。
 * 模块：物理 / 体型 / 按键 / 操作 / 显示 / 视角。
 *
 * 显示状态机：visible = !pointerLocked ∥ !sceneReady
 * - 初始化（未加载地图）→ 面板常驻（加载地图入口）
 * - 加载完成 → 隐藏，点击 canvas 锁定
 * - 锁定中按 ESC（浏览器原生退锁）→ pointerlockchange(locked=false) → 面板弹出
 * - 面板内「关闭并锁定」→ 请求 Pointer Lock → 隐藏
 * - M 键手动开关兜底
 *
 * 按键模块：可录制重绑（KeyboardInput.setKeymap）+ localStorage 持久化。
 */

import type { RuntimeConfig } from '../config.js';
import { buildPhysicsParams } from '../config.js';
import type { InputBridge } from '../input/input-bridge.js';
import type { KeyboardInput } from '../input/keyboard.js';
import {
  ACTION_LABELS,
  codeLabel,
  isBindableCode,
  loadKeymap,
  resetKeymap,
  saveKeymap,
  type BindableAction,
} from '../input/keymap.js';

export class PanelController {
  private readonly root: HTMLElement;
  private keymap: Record<BindableAction, string[]>;
  /** 当前录制中的动作（null = 无录制）。 */
  private recordingAction: BindableAction | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly bridge: InputBridge,
    private readonly getLocked: () => boolean,
    /** 面板参数变更 → 同步主线程预测实例（set_params；实时生效）。 */
    private readonly onSyncPrediction?: (params: Record<string, unknown>) => void,
    /** 面板体型变更 → 同步主线程预测实例（set_hull）。 */
    private readonly onSyncHull?: (halfWidth: number, standHeight: number, duckHeight: number) => void,
    /** noclip 切换 → 同步主线程预测实例（set_noclip + 渲染走权威直读）。 */
    private readonly onNoclipChange?: (active: boolean) => void,
    /** 纹理画质切换 → 主线程渲染（mosaic 贴图替换，即时生效）。 */
    private readonly onTextureQualityChange?: (quality: 'original' | 'mini') => void,
    /** FOV 变更 → 主线程渲染器 setFov（相机透视矩阵即时更新）。 */
    private readonly onSyncFov?: (fov: number) => void,
  ) {
    this.root = document.getElementById('panel') as HTMLElement;
    // 按键：读取持久化键位（与 app.ts 初始 KeyboardInput 一致）
    this.keymap = loadKeymap();
    // 面板偏好持久化：构造时加载（localStorage → config → 控件/双端生效）
    this.loadPanelPrefs();
    this.bindEvents();
    this.bindModuleNav();
    this.renderKeyList();
    // 持久化加载后：控件值回写 + 双端同步 + 准星应用（在 bindEvents 之后执行，
    // 避免控件初始化覆盖加载值）
    this.syncControlsFromConfig();
    this.sendAllPrefs();
    this.applyCrosshair();
  }

  /** 面板可见 = 未锁定 ∥ 场景未就绪。 */
  updateVisibility(sceneReady: boolean): void {
    const visible = !this.getLocked() || !sceneReady;
    this.root.style.display = visible ? 'flex' : 'none';
  }

  // ── 模块导航（左栏切换，事件委托防 DOM 替换失效）────────────

  private bindModuleNav(): void {
    this.root.querySelector('.nav')?.addEventListener('click', (e) => {
      const mod = (e.target as HTMLElement).closest('.mod');
      if (!mod) return;
      const name = (mod as HTMLElement).dataset.mod;
      if (!name) return;
      this.root.querySelectorAll('.nav .mod').forEach((m) => m.classList.remove('active'));
      mod.classList.add('active');
      this.root.querySelectorAll('.mod-pane').forEach((p) => {
        p.classList.toggle('active', (p as HTMLElement).dataset.pane === name);
      });
    });
  }

  // ── 按键模块（录制/删除/恢复/持久化）────────────────────────

  private renderKeyList(): void {
    const list = document.getElementById('keyList');
    if (!list) return;
    const actions = Object.keys(ACTION_LABELS) as BindableAction[];
    list.innerHTML = actions
      .map(
        (action) => `
          <div class="key-row" data-action="${action}">
            <span class="kname">${ACTION_LABELS[action]}</span>
            <div class="kkeys">
              ${this.keymap[action]
                .map(
                  (code) =>
                    `<span class="key-chip" data-action="${action}" data-code="${code}">
                       ${codeLabel(code)}<span class="x" data-del="${code}">✕</span>
                     </span>`,
                )
                .join('')}
              <button class="key-add" data-action="${action}">+ 添加</button>
            </div>
          </div>`,
      )
      .join('');
    this.bindKeyEvents();
  }

  private bindKeyEvents(): void {
    const list = document.getElementById('keyList');
    if (!list) return;
    // 点击键位 chip → 开始录制（重绑该动作）
    list.querySelectorAll('.key-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = (chip as HTMLElement).dataset.action as BindableAction;
        this.startRecording(action);
      });
    });
    // 点击 ✕ → 删除该键位（保留至少一个）
    list.querySelectorAll('.key-chip .x').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = (x as HTMLElement).closest('.key-chip') as HTMLElement;
        const action = chip.dataset.action as BindableAction;
        const code = (x as HTMLElement).dataset.del!;
        if (this.keymap[action].length <= 1) return; // 至少保留一个
        this.keymap[action] = this.keymap[action].filter((c) => c !== code);
        this.commitKeymap();
      });
    });
    // 点击 "+ 添加" → 追加键位（录制新键，不替换）
    list.querySelectorAll('.key-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action as BindableAction;
        this.startRecording(action, true);
      });
    });
  }

  /** 开始录制：监听下一次可绑定按键。 */
  private startRecording(action: BindableAction, append = false): void {
    if (this.recordingAction) return; // 已在录制
    this.recordingAction = action;
    const hint = document.getElementById('keyRecHint');
    if (hint) {
      hint.style.display = 'block';
      hint.textContent = `录制「${ACTION_LABELS[action]}」：按下一个键…（Esc 取消）`;
    }
    // 高亮当前动作的 chips
    document.querySelectorAll('.key-chip').forEach((c) => {
      if ((c as HTMLElement).dataset.action === action) c.classList.add('recording');
    });

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey);
      this.finishRecording(e.code, action, append);
    };
    window.addEventListener('keydown', onKey, { capture: true });
  }

  private finishRecording(code: string, action: BindableAction, append: boolean): void {
    this.recordingAction = null;
    const hint = document.getElementById('keyRecHint');
    if (hint) hint.style.display = 'none';
    document.querySelectorAll('.key-chip').forEach((c) => c.classList.remove('recording'));
    if (code === 'Escape' || !isBindableCode(code)) return; // 取消或修饰键
    // 从其他动作移除该键（避免冲突），再绑定
    for (const act of Object.keys(this.keymap) as BindableAction[]) {
      this.keymap[act] = this.keymap[act].filter((c) => c !== code);
    }
    if (!append) this.keymap[action] = [code];
    else if (!this.keymap[action].includes(code)) this.keymap[action].push(code);
    this.commitKeymap();
  }

  /** 提交键位：保存 + 生效（KeyboardInput.setKeymap）+ 重渲染。 */
  private commitKeymap(): void {
    saveKeymap(this.keymap);
    // 通过 app.ts 注入的 KeyboardInput 实例即时生效
    const kb = (globalThis as unknown as { __keyboardInput?: KeyboardInput }).__keyboardInput;
    kb?.setKeymap(this.keymap);
    this.renderKeyList();
  }

  // ── 通用控件绑定 ───────────────────────────────────────────

  private bindEvents(): void {
    // M 键手动开关（兜底，防 ESC 被拦截）
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') {
        e.preventDefault();
        this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none';
      }
    });

    // ESC：未锁定时展开面板（锁定态由浏览器退锁 pointerlockchange 触发显示）
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.getLocked()) {
        this.root.style.display = 'flex';
      }
    });

    // 物理参数滑块 → config → Worker-A（权威）→ 同步 Worker-B（预测）
    // V8/P2：lockTickRate=true 时 tick 频率锁定 64Hz 只读（计时玩法公平性）
    const tickRateEl = document.getElementById('tickRate') as HTMLInputElement | null;
    const tickRateNum = document.getElementById('tickRateNum') as HTMLInputElement | null;
    if (this.config.lockTickRate) {
      // 锁定：值固定 64，控件禁用
      this.config.physics.tickRate = 64;
      if (tickRateEl) {
        tickRateEl.value = '64';
        tickRateEl.disabled = true;
      }
      if (tickRateNum) {
        tickRateNum.value = '64';
        tickRateNum.disabled = true;
      }
      this.bridge.sendConfig('physics', { tickRate: 64 });
    } else {
      this.bindSlider('tickRate', 48, 128, 1, (v) => {
        this.config.physics.tickRate = v;
        this.bridge.sendConfig('physics', { tickRate: v });
        this.pushPhysicsParams();
      });
    }
    this.bindSlider('gravity', 200, 2000, 1, (v) => {
      this.config.physics.gravity = v;
      this.bridge.sendConfig('physics', { gravity: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('accelerate', 1, 30, 1, (v) => {
      this.config.physics.accelerate = v;
      this.bridge.sendConfig('physics', { accelerate: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('airAccel', 1, 200, 1, (v) => {
      this.config.physics.airAccel = v;
      this.bridge.sendConfig('physics', { airAccel: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('friction', 0, 10, 0.1, (v) => {
      this.config.physics.friction = v;
      this.bridge.sendConfig('physics', { friction: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('maxSpeed', 100, 1000, 1, (v) => {
      this.config.physics.maxSpeed = v;
      this.bridge.sendConfig('physics', { maxSpeed: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('walkSpeed', 50, 400, 1, (v) => {
      this.config.physics.walkSpeed = v;
      this.bridge.sendConfig('physics', { walkSpeed: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('crouchSpeed', 30, 300, 1, (v) => {
      this.config.physics.crouchSpeed = v;
      this.bridge.sendConfig('physics', { crouchSpeed: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('stopSpeed', 10, 400, 1, (v) => {
      this.config.physics.stopSpeed = v;
      this.bridge.sendConfig('physics', { stopSpeed: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('jumpSpeed', 100, 600, 1, (v) => {
      this.config.physics.jumpSpeed = v;
      this.bridge.sendConfig('physics', { jumpSpeed: v });
      this.pushPhysicsParams();
    });
    this.bindCheckbox('autobhop', (v) => {
      this.config.physics.autobhop = v;
      this.bridge.sendConfig('physics', { autobhop: v });
      this.pushPhysicsParams();
    });
    this.bindCheckbox('bhopSpeedClamp', (v) => {
      this.config.physics.bhopSpeedClamp = v;
      this.bridge.sendConfig('physics', { bhopSpeedClamp: v });
      this.pushPhysicsParams();
    });
    this.bindCheckbox('noPrestrafe', (v) => {
      this.config.physics.noPrestrafe = v;
      this.bridge.sendConfig('physics', { noPrestrafe: v });
      this.pushPhysicsParams();
    });
    // 传送落地触发门槛（帧）
    this.bindSlider('teleportGateTicks', 1, 20, 1, (v) => {
      this.config.physics.teleportGateTicks = v;
      this.bridge.sendConfig('physics', { teleportGateTicks: v });
      this.pushPhysicsParams();
    });

    // 体型
    this.bindSlider('hullHalfWidth', 4, 32, 1, (v) => {
      this.config.player.halfWidth = v;
      this.sendHull();
    });
    this.bindSlider('hullStandHeight', 36, 144, 1, (v) => {
      this.config.player.standHeight = v;
      this.sendHull();
    });
    this.bindSlider('hullDuckHeight', 24, 108, 1, (v) => {
      this.config.player.duckHeight = v;
      this.sendHull();
    });
    document.getElementById('hullReset')?.addEventListener('click', () => {
      this.config.player.halfWidth = 16;
      this.config.player.standHeight = 72;
      this.config.player.duckHeight = 54;
      (document.getElementById('hullHalfWidth') as HTMLInputElement).value = '16';
      (document.getElementById('hullStandHeight') as HTMLInputElement).value = '72';
      (document.getElementById('hullDuckHeight') as HTMLInputElement).value = '54';
      this.sendHull();
      this.savePanelPrefs();
    });

    // 操作：灵敏度 / Q-E 旋转速度
    this.bindSlider('sensitivity', 0.1, 5.0, 0.01, (v) => {
      this.config.input.sensitivity = v;
      this.bridge.sendConfig('input', { sensitivity: v });
      this.pushPhysicsParams();
    });
    this.bindSlider('yawBindSpeed', 0, 720, 1, (v) => {
      this.config.input.yawBindSpeed = v;
      this.bridge.sendConfig('input', { yawBindSpeed: v });
      this.pushPhysicsParams();
    });

    // 准星（主线程本地）
    this.bindCheckbox('showCrosshair', (v) => {
      this.config.hud.showCrosshair = v;
      const el = document.getElementById('crosshair');
      if (el) el.classList.toggle('hidden', !v);
    });

    // 准星风格化（主线程本地；变更即应用 + 持久化）
    const ch = (): void => {
      this.applyCrosshair();
      this.savePanelPrefs();
    };
    const chColor = document.getElementById('chColor') as HTMLInputElement | null;
    chColor?.addEventListener('input', () => {
      this.config.hud.crosshair.color = chColor.value;
      ch();
    });
    this.bindSlider('chSize', 1, 20, 1, (v) => {
      this.config.hud.crosshair.size = v;
      ch();
    });
    this.bindSlider('chThickness', 1, 8, 1, (v) => {
      this.config.hud.crosshair.thickness = v;
      ch();
    });
    this.bindSlider('chGap', 0, 16, 1, (v) => {
      this.config.hud.crosshair.gap = v;
      ch();
    });
    this.bindCheckbox('chOutline', (v) => {
      this.config.hud.crosshair.outline = v;
      ch();
    });
    this.bindCheckbox('chDot', (v) => {
      this.config.hud.crosshair.dot = v;
      ch();
    });

    // 视野 FOV（主线程渲染器；60-110，CS:S 标准 75）
    this.bindSlider('fov', 60, 110, 1, (v) => {
      this.config.hud.fov = v;
      this.onSyncFov?.(v);
    });

    // 速度面板模式（主线程本地 8Hz）
    const speedMode = document.getElementById('speedMode') as HTMLSelectElement | null;
    speedMode?.addEventListener('change', () => {
      this.config.hud.speedMode = speedMode.value as 'lateral' | 'lateral-vertical' | 'total';
      this.savePanelPrefs();
    });

    // 纹理画质（原始 / mosaic 压缩低清，主线程渲染即时切换）
    const textureQuality = document.getElementById('textureQuality') as HTMLSelectElement | null;
    textureQuality?.addEventListener('change', () => {
      this.config.texture.quality = textureQuality.value as 'original' | 'mini';
      this.onTextureQualityChange?.(this.config.texture.quality);
      this.savePanelPrefs();
    });

    // 自由视角切换（noclip）
    const noclipBtn = document.getElementById('noclipToggle') as HTMLButtonElement | null;
    noclipBtn?.addEventListener('click', () => {
      const active = noclipBtn.classList.toggle('active');
      // 通知 Worker-A（noclip 下禁用物理/传送）与预测实例（同步 noclip 状态，
      // 渲染切权威直读——否则权威在飞/预测实例掉落的双管道撕裂）
      this.bridge.sendConfig('physics', { mode: active ? 'noclip' : 'physics' });
      this.pushPhysicsParams();
      this.onNoclipChange?.(active);
    });

    // noclip 移动速度（HU/s，200-3000；sprint 再 ×4）
    this.bindSlider('noclipSpeed', 200, 3000, 1, (v) => {
      this.config.input.noclipSpeed = v;
      this.bridge.sendConfig('input', { noclipSpeed: v });
      this.pushPhysicsParams();
    });

    // 恢复默认键位
    document.getElementById('keyReset')?.addEventListener('click', () => {
      this.keymap = resetKeymap();
      this.commitKeymap();
    });

    // 关闭：直接隐藏面板（不请求指针锁定；锁定由点击画布触发）
    document.getElementById('panelClose')?.addEventListener('click', () => {
      this.root.style.display = 'none';
    });
  }

  private sendHull(): void {
    const p = this.config.player;
    this.bridge.sendConfig('player', {
      halfWidth: p.halfWidth,
      standHeight: p.standHeight,
      duckHeight: p.duckHeight,
    });
    // 同步主线程预测实例体型（实时生效）
    this.onSyncHull?.(p.halfWidth, p.standHeight, p.duckHeight);
  }

  /** 全量物理参数同步给主线程预测实例（实时生效）。 */
  private pushPhysicsParams(): void {
    this.onSyncPrediction?.(buildPhysicsParams(this.config));
  }

  private bindSlider(id: string, min: number, max: number, step: number, onInput: (v: number) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
    // 步进生效：slider 与数字输入框同步（灵敏度 0.01、数值类 1）
    el.step = String(step);
    if (num) num.step = String(step);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (num && Number.isFinite(v)) num.value = String(v);
      onInput(v);
      this.savePanelPrefs(); // 面板偏好持久化
    });
    if (num) {
      num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!Number.isFinite(v)) return;
        el.value = String(Math.min(max, Math.max(min, v)));
        onInput(Math.min(max, Math.max(min, v)));
        this.savePanelPrefs();
      });
    }
  }

  private bindCheckbox(id: string, onChange: (v: boolean) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener('change', () => {
      onChange(el.checked);
      this.savePanelPrefs();
    });
  }

  // ── 面板偏好持久化（localStorage；体型/物理/操作/显示/视角）─────────

  /** localStorage 存储键。 */
  private static readonly PREFS_KEY = 'vbsp:panelPrefs';

  /** 从 config 收集全部面板可调偏好。 */
  private collectPrefs(): Record<string, unknown> {
    const p = this.config;
    return {
      physics: { ...p.physics },
      player: { ...p.player },
      input: {
        sensitivity: p.input.sensitivity,
        yawBindSpeed: p.input.yawBindSpeed,
        noclipSpeed: p.input.noclipSpeed,
      },
      hud: { showCrosshair: p.hud.showCrosshair, speedMode: p.hud.speedMode, fov: p.hud.fov, crosshair: { ...p.hud.crosshair } },
      texture: { ...p.texture },
    };
  }

  /** 保存面板偏好（构造/变更时调用）。 */
  private savePanelPrefs(): void {
    try {
      localStorage.setItem(PanelController.PREFS_KEY, JSON.stringify(this.collectPrefs()));
    } catch (err) {
      console.warn('[panel] 面板偏好保存失败:', err);
    }
  }

  /** 加载面板偏好 → 合并到 config（仅覆盖已存在的字段）。 */
  private loadPanelPrefs(): void {
    try {
      const raw = localStorage.getItem(PanelController.PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw) as Record<string, unknown>;
      const merge = <T>(section: T, patch: unknown): void => {
        if (!patch || typeof patch !== 'object') return;
        Object.assign(section as object, patch);
      };
      merge(this.config.physics, prefs.physics);
      merge(this.config.player, prefs.player);
      merge(this.config.input, prefs.input);
      merge(this.config.hud, prefs.hud);
      merge(this.config.texture, prefs.texture);
    } catch (err) {
      console.warn('[panel] 面板偏好加载失败:', err);
    }
  }

  /** 按 config 当前值回写全部控件 UI（持久化加载后同步显示）。 */
  private syncControlsFromConfig(): void {
    const setVal = (id: string, val: string): void => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = val;
      // 同步滑块旁的数字输入框（否则数值框恒显示 HTML 默认值）
      const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
      if (num) num.value = val;
    };
    const setChecked = (id: string, val: boolean): void => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.checked = val;
    };
    const p = this.config;
    // 物理
    setVal('tickRate', String(p.physics.tickRate));
    setVal('gravity', String(p.physics.gravity));
    setVal('accelerate', String(p.physics.accelerate));
    setVal('airAccel', String(p.physics.airAccel));
    setVal('friction', String(p.physics.friction));
    setVal('maxSpeed', String(p.physics.maxSpeed));
    setVal('walkSpeed', String(p.physics.walkSpeed));
    setVal('crouchSpeed', String(p.physics.crouchSpeed));
    setVal('stopSpeed', String(p.physics.stopSpeed));
    setVal('jumpSpeed', String(p.physics.jumpSpeed));
    setChecked('autobhop', p.physics.autobhop);
    setChecked('bhopSpeedClamp', p.physics.bhopSpeedClamp);
    setChecked('noPrestrafe', p.physics.noPrestrafe);
    setVal('teleportGateTicks', String(p.physics.teleportGateTicks));
    // 体型
    setVal('hullHalfWidth', String(p.player.halfWidth));
    setVal('hullStandHeight', String(p.player.standHeight));
    setVal('hullDuckHeight', String(p.player.duckHeight));
    // 操作
    setVal('sensitivity', String(p.input.sensitivity));
    setVal('yawBindSpeed', String(p.input.yawBindSpeed));
    // 视角
    setVal('noclipSpeed', String(p.input.noclipSpeed));
    // 显示
    setChecked('showCrosshair', p.hud.showCrosshair);
    const speedMode = document.getElementById('speedMode') as HTMLSelectElement | null;
    if (speedMode) speedMode.value = p.hud.speedMode;
    const textureQuality = document.getElementById('textureQuality') as HTMLSelectElement | null;
    if (textureQuality) textureQuality.value = p.texture.quality;
    // 准星
    setVal('chColor', p.hud.crosshair.color);
    setVal('chSize', String(p.hud.crosshair.size));
    setVal('chThickness', String(p.hud.crosshair.thickness));
    setVal('chGap', String(p.hud.crosshair.gap));
    setChecked('chOutline', p.hud.crosshair.outline);
    setChecked('chDot', p.hud.crosshair.dot);
    // 视野
    setVal('fov', String(p.hud.fov));
  }

  /** 持久化加载后向双端（Worker 权威 + 主线程预测实例）推送全部偏好。 */
  private sendAllPrefs(): void {
    const p = this.config;
    this.bridge.sendConfig('physics', { ...p.physics });
    this.bridge.sendConfig('player', { ...p.player });
    this.bridge.sendConfig('input', {
      sensitivity: p.input.sensitivity,
      yawBindSpeed: p.input.yawBindSpeed,
      noclipSpeed: p.input.noclipSpeed,
    });
    this.pushPhysicsParams();
    this.sendHull();
    // 持久化加载后 FOV 应用（相机创建用 config.hud.fov，此处覆盖面板加载值）
    this.onSyncFov?.(p.hud.fov);
  }

  /** 应用准星风格到 DOM（CSS 变量 + 可见性）。 */
  private applyCrosshair(): void {
    const el = document.getElementById('crosshair');
    if (!el) return;
    const c = this.config.hud.crosshair;
    const s = (el as HTMLElement).style;
    s.setProperty('--ch-color', c.color);
    s.setProperty('--ch-size', `${c.size}px`);
    s.setProperty('--ch-thickness', `${c.thickness}px`);
    s.setProperty('--ch-gap', `${c.gap}px`);
    el.classList.toggle('hidden', !this.config.hud.showCrosshair);
    // 描边：四线加 outline class（中心点恒带描边）
    el.querySelectorAll('.ch-line').forEach((line) => {
      line.classList.toggle('outline', c.outline);
    });
    const dot = el.querySelector('.ch-dot') as HTMLElement | null;
    if (dot) dot.style.display = c.dot ? 'block' : 'none';
  }
}
