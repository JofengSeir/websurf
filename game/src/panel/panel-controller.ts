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
  ) {
    this.root = document.getElementById('panel') as HTMLElement;
    // 按键：读取持久化键位（与 app.ts 初始 KeyboardInput 一致）
    this.keymap = loadKeymap();
    this.bindEvents();
    this.bindModuleNav();
    this.renderKeyList();
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

    // 物理参数滑块 → config → Worker-A
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
      this.postToPredictor({ type: 'set-pred-dt', dt: 1 / 64 });
    } else {
      this.bindSlider('tickRate', 48, 128, 1, (v) => {
        this.config.physics.tickRate = v;
        this.bridge.sendConfig('physics', { tickRate: v });
        // 文档 §2.4：Worker-B 预测子步 dt_pred = 1/tickRate 同步
        this.postToPredictor({ type: 'set-pred-dt', dt: 1 / v });
      });
    }
    this.bindSlider('gravity', 200, 2000, 10, (v) => {
      this.config.physics.gravity = v;
      this.bridge.sendConfig('physics', { gravity: v });
    });
    this.bindSlider('accelerate', 1, 30, 0.5, (v) => {
      this.config.physics.accelerate = v;
      this.bridge.sendConfig('physics', { accelerate: v });
    });
    this.bindSlider('airAccel', 1, 200, 1, (v) => {
      this.config.physics.airAccel = v;
      this.bridge.sendConfig('physics', { airAccel: v });
    });
    this.bindSlider('friction', 0, 10, 0.1, (v) => {
      this.config.physics.friction = v;
      this.bridge.sendConfig('physics', { friction: v });
    });
    this.bindSlider('maxSpeed', 100, 1000, 5, (v) => {
      this.config.physics.maxSpeed = v;
      this.bridge.sendConfig('physics', { maxSpeed: v });
    });
    this.bindSlider('walkSpeed', 50, 400, 5, (v) => {
      this.config.physics.walkSpeed = v;
      this.bridge.sendConfig('physics', { walkSpeed: v });
    });
    this.bindSlider('crouchSpeed', 30, 300, 5, (v) => {
      this.config.physics.crouchSpeed = v;
      this.bridge.sendConfig('physics', { crouchSpeed: v });
    });
    this.bindSlider('stopSpeed', 10, 400, 5, (v) => {
      this.config.physics.stopSpeed = v;
      this.bridge.sendConfig('physics', { stopSpeed: v });
    });
    this.bindSlider('jumpSpeed', 100, 600, 1, (v) => {
      this.config.physics.jumpSpeed = v;
      this.bridge.sendConfig('physics', { jumpSpeed: v });
    });
    this.bindCheckbox('autobhop', (v) => {
      this.config.physics.autobhop = v;
      this.bridge.sendConfig('physics', { autobhop: v });
    });
    this.bindCheckbox('bhopSpeedClamp', (v) => {
      this.config.physics.bhopSpeedClamp = v;
      this.bridge.sendConfig('physics', { bhopSpeedClamp: v });
    });
    this.bindCheckbox('noPrestrafe', (v) => {
      this.config.physics.noPrestrafe = v;
      this.bridge.sendConfig('physics', { noPrestrafe: v });
    });
    // 传送落地触发门槛（帧）
    this.bindSlider('teleportGateTicks', 1, 20, 1, (v) => {
      this.config.physics.teleportGateTicks = v;
      this.bridge.sendConfig('physics', { teleportGateTicks: v });
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
    });

    // 操作：灵敏度 / Q-E 旋转速度
    this.bindSlider('sensitivity', 0.1, 5.0, 0.01, (v) => {
      this.config.input.sensitivity = v;
      this.bridge.sendConfig('input', { sensitivity: v });
    });
    this.bindSlider('yawBindSpeed', 0, 720, 1, (v) => {
      this.config.input.yawBindSpeed = v;
      this.bridge.sendConfig('input', { yawBindSpeed: v });
    });

    // 准星（主线程本地）
    this.bindCheckbox('showCrosshair', (v) => {
      this.config.hud.showCrosshair = v;
      const el = document.getElementById('crosshair');
      if (el) el.classList.toggle('hidden', !v);
    });

    // 速度面板模式（主线程本地 8Hz）
    const speedMode = document.getElementById('speedMode') as HTMLSelectElement | null;
    speedMode?.addEventListener('change', () => {
      this.config.hud.speedMode = speedMode.value as 'lateral' | 'lateral-vertical' | 'total';
    });

    // 自由视角切换（noclip）
    const noclipBtn = document.getElementById('noclipToggle') as HTMLButtonElement | null;
    noclipBtn?.addEventListener('click', () => {
      const active = noclipBtn.classList.toggle('active');
      // 通知 Worker-A（noclip 下禁用物理/传送）与 Worker-B（禁用预测）
      this.bridge.sendConfig('physics', { mode: active ? 'noclip' : 'physics' });
      this.postToPredictor({ type: 'set-enabled', enabled: !active });
    });

    // noclip 移动速度（HU/s，200-3000；sprint 再 ×4）
    this.bindSlider('noclipSpeed', 200, 3000, 10, (v) => {
      this.config.input.noclipSpeed = v;
      this.bridge.sendConfig('input', { noclipSpeed: v });
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
  }

  private bindSlider(id: string, min: number, max: number, _step: number, onInput: (v: number) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (num && Number.isFinite(v)) num.value = String(v);
      onInput(v);
    });
    if (num) {
      num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!Number.isFinite(v)) return;
        el.value = String(Math.min(max, Math.max(min, v)));
        onInput(Math.min(max, Math.max(min, v)));
      });
    }
  }

  private bindCheckbox(id: string, onChange: (v: boolean) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener('change', () => onChange(el.checked));
  }

  private postToPredictor(msg: unknown): void {
    // 通过共享 Worker 引用（app.ts 注入）发送
    const w = (globalThis as unknown as { __predictorWorker?: Worker }).__predictorWorker;
    w?.postMessage(msg);
  }
}
