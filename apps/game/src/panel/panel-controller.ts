/**
 * ESC 控制面板控制器（`#panel`）：左栏 `.nav` 的 `data-mod` 切换右栏 `.mod-pane` 的
 * `data-pane`。分栏内容静态声明在 `apps/game/web/index.html`，依次为 general（通用）、
 * physics（物理）、hull（体型）、keys（按键）、look（操作）、display（显示）、
 * view（视角）、health（权威健康）；本类负责控件绑定、config 写回、偏好持久化与两端下发。
 *
 * 可见性：`updateVisibility` 取 `visible = !getLocked() || !sceneReady`——指针未锁定、
 * 或场景尚未就绪时显示面板。`apps/game/src/app.ts` 在 pointerlockchange 与 BSP 加载完成
 * 两处调用它；开始加载地图时调用 `hide`，把界面让给加载进度覆盖层。
 * `#panelClose` 只加 `hidden` 类，不请求 Pointer Lock（锁定由画布点击触发）；
 * M 键切换 `hidden` 类（不校验锁定状态）；ESC 在未锁定时移除 `hidden` 类。
 *
 * 按键模块：`renderKeyList` 渲染 `#keyList`，录制结果写入本类持有的 keymap，
 * 经 `apps/game/src/input/keymap.ts` 的 `saveKeymap` 落 localStorage，并经
 * `globalThis.__keyboardInput`（`apps/game/src/app.ts` 挂载的 KeyboardInput 实例）
 * 调 `setKeymap` 即时生效。
 *
 * 偏好持久化：localStorage 键 `vbsp:panelPrefs`（带 `PREFS_VERSION` 版本号）；
 * 参数下发走 `apps/game/src/input/input-bridge.ts` 的 `sendConfig`（主线程预测实例
 * + 权威 Worker 的 `config` 消息）。
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
  /** 正在录制的动作；`null` = 当前无录制（此时 `finishRecording` 直接返回，键位不变）。 */
  private recordingAction: BindableAction | null = null;
  /** 录制期间挂在 window 上的 keydown 监听器引用；`stopRecording` 用它配合 `{ capture: true }` 解绑。 */
  private recordingHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly bridge: InputBridge,
    private readonly getLocked: () => boolean,
    /** 全量物理参数 → 主线程预测实例：`apps/game/src/renderer/renderer-main.ts` 的 `setPredictionParams` 转 `PhysWorld.set_params`。 */
    private readonly onSyncPrediction?: (params: Record<string, unknown>) => void,
    /** 体型三尺寸 → 主线程预测实例：`apps/game/src/renderer/renderer-main.ts` 的 `setPredictionHull` 转 `PhysWorld.set_hull`。 */
    private readonly onSyncHull?: (halfWidth: number, standHeight: number, duckHeight: number) => void,
    /** noclip 开关 → 主线程预测实例：`apps/game/src/renderer/renderer-main.ts` 的 `setPredictionNoclip`（`PhysWorld.set_noclip` + 采样代数自增 + 清未消费输入）。 */
    private readonly onNoclipChange?: (active: boolean) => void,
    /** 纹理画质 → 主线程渲染器 `applyTextureQuality`：按 mosaic manifest 换低清贴图 / 还原缓存原图，无需重载地图。 */
    private readonly onTextureQualityChange?: (quality: 'original' | 'mini') => void,
    /** FOV（度）→ 主线程渲染器 `setFov`：写相机 `fov` 后重建透视矩阵。 */
    private readonly onSyncFov?: (fov: number) => void,
    /** 渲染距离（世界单位）→ 渲染器 `setRenderDistance`：大于 0 用显式距离，否则回落自动值（地图包围盒对角线的一半）。 */
    private readonly onSyncRenderDistance?: (dist: number) => void,
    /** 曝光（显示侧亮度倍率）→ 渲染器 `setExposure`：全场景共享 uniform，改值后下一次绘制生效。 */
    private readonly onSyncExposure?: (exposure: number) => void,
    /** 暗部提升 γ → 渲染器 `setLightGamma`（共享 uniform）；着色器侧只接受 `(0, 1]`，更大取值被忽略。 */
    private readonly onSyncLightGamma?: (gamma: number) => void,
    /** 模型（prop）烘焙光照亮度 → 渲染器 `setAmbientScale`（共享 uniform，只作用于 ambient cube 路径）。 */
    private readonly onSyncAmbientScale?: (scale: number) => void,
    /**
     * 光照模式（`baked` 预烘焙 / `texture` 纯纹理）→ 渲染器 `setLightingMode`：
     * `apps/game/src/renderer/lightmap-shader.ts` 用全场景共享的一个 uniform 承载该开关，
     * 改值即全场景生效（不重建场景、不重编译材质）；模式未变化时渲染器 `setLightingMode` 直接返回。
     */
    private readonly onSyncLightingMode?: (mode: 'baked' | 'texture') => void,
    /** 删除存点（索引，无确认）→ `apps/game/src/app.ts` 调 `SavePointStore.delete` 后把返回列表回刷给 `renderSavePoints`。 */
    private readonly onSavePointDelete?: (index: number) => void,
    /** 读取存点（索引）→ `apps/game/src/app.ts` 取 `SavePointStore.all()` 的第 i 项交渲染器 `loadSavepoint`（`set_state` + 权威同步）。 */
    private readonly onSavePointLoad?: (index: number) => void,
  ) {
    this.root = document.getElementById('panel') as HTMLElement;
    // 键位：与 app.ts 构造 KeyboardInput 时同源——都走 loadKeymap() 读 localStorage，缺省回默认表
    this.keymap = loadKeymap();
    // 偏好：先把 localStorage 存档合并进 config，构造末尾再回写控件并下发两端
    this.loadPanelPrefs();
    this.bindEvents();
    this.bindModuleNav();
    this.renderKeyList();
    // 顺序：loadPanelPrefs 改 config → syncControlsFromConfig 回写控件 → sendAllPrefs 下发两端
    // → applyCrosshair。回写放在 bindEvents 之后，控件显示的是加载后的 config 值。
    this.syncControlsFromConfig();
    this.sendAllPrefs();
    this.applyCrosshair();
  }

  /** 按指针锁定与场景就绪刷新可见性：`!getLocked() || !sceneReady` 时移除 `hidden` 类。 */
  updateVisibility(sceneReady: boolean): void {
    const visible = !this.getLocked() || !sceneReady;
    this.root.classList.toggle('hidden', !visible);
  }

  /** 加 `hidden` 类强制隐藏；`app.ts` 在开始加载地图时调用（界面交给加载进度覆盖层）。 */
  hide(): void {
    this.root.classList.add('hidden');
  }

  // ── 模块导航：在 `.nav` 上事件委托，按 `data-mod` 切 `.mod` 与 `.mod-pane` 的 active ──

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

  // ── 按键模块：渲染 #keyList、录制重绑、删除键位、恢复默认键位 ────────

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
              ${this.keymap[action].length === 0
                ? '<span class="kempty">（已禁用）</span>'
                : this.keymap[action]
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
    // 点键位 chip：进入录制；录制结果替换该动作的键位（append = false）
    list.querySelectorAll('.key-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = (chip as HTMLElement).dataset.action as BindableAction;
        this.startRecording(action);
      });
    });
    // 点 ✕：从该动作的键位数组里剔除该 code（允许删空——空数组即该动作无按键）
    list.querySelectorAll('.key-chip .x').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = (x as HTMLElement).closest('.key-chip') as HTMLElement;
        const action = chip.dataset.action as BindableAction;
        const code = (x as HTMLElement).dataset.del!;
        this.keymap[action] = this.keymap[action].filter((c) => c !== code);
        this.commitKeymap();
      });
    });
    // 点「+ 添加」：进入录制；录制结果追加到该动作（append = true，保留已有键位）
    list.querySelectorAll('.key-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action as BindableAction;
        this.startRecording(action, true);
      });
    });
  }

  /**
   * 进入录制：置 `recordingAction`、显示 `#keyRecHint`、给同类 chip 加 `recording` 类，
   * 并在 window 捕获阶段挂 keydown 监听——下一次按键即完成录制。
   *
   * 监听器注册时带了 `{ capture: true }`，`stopRecording` 必须用同一标志解绑：
   * 标志不匹配时 removeEventListener 不生效，监听器会留在捕获阶段，
   * 持续 preventDefault + stopPropagation 吞掉全部 keydown。
   *
   * @param action 目标动作
   * @param append true = 追加键位；false = 替换该动作的键位
   */
  private startRecording(action: BindableAction, append = false): void {
    // 先解掉尚未解绑的监听（正常路径下 stopRecording 已在完成时调用）
    this.stopRecording();
    this.recordingAction = action;
    const hint = document.getElementById('keyRecHint');
    if (hint) {
      hint.classList.add('show');
      hint.textContent = `录制「${ACTION_LABELS[action]}」：按下一个键…（Esc 取消）`;
    }
    // 高亮该动作的全部 chip（recording 类）
    document.querySelectorAll('.key-chip').forEach((c) => {
      if ((c as HTMLElement).dataset.action === action) c.classList.add('recording');
    });

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      this.stopRecording();
      this.finishRecording(e.code, action, append);
    };
    this.recordingHandler = onKey;
    window.addEventListener('keydown', onKey, { capture: true });
  }

  /** 解绑录制监听并把引用置空；capture 标志必须与 `startRecording` 注册时一致。 */
  private stopRecording(): void {
    if (this.recordingHandler) {
      window.removeEventListener('keydown', this.recordingHandler, { capture: true });
      this.recordingHandler = null;
    }
  }

  /** 取消录制（`#panelClose`、window blur 调用）：解绑监听 + 清 `recordingAction`、提示与高亮，不改写键位。 */
  private cancelRecording(): void {
    this.stopRecording();
    if (this.recordingAction === null) return;
    this.recordingAction = null;
    const hint = document.getElementById('keyRecHint');
    if (hint) hint.classList.remove('show');
    document.querySelectorAll('.key-chip').forEach((c) => c.classList.remove('recording'));
  }

  private finishRecording(code: string, action: BindableAction, append: boolean): void {
    // 无 recordingAction 时直接返回：不改写任何键位
    if (this.recordingAction === null) return;
    this.recordingAction = null;
    const hint = document.getElementById('keyRecHint');
    if (hint) hint.classList.remove('show');
    document.querySelectorAll('.key-chip').forEach((c) => c.classList.remove('recording'));
    if (code === 'Escape' || !isBindableCode(code)) return; // Esc = 取消；其余不可绑 code 忽略
    // 先从其余动作里剔除该 code（一个键只属一个动作），再按 append 写入目标动作
    for (const act of Object.keys(this.keymap) as BindableAction[]) {
      this.keymap[act] = this.keymap[act].filter((c) => c !== code);
    }
    if (!append) this.keymap[action] = [code];
    else if (!this.keymap[action].includes(code)) this.keymap[action].push(code);
    this.commitKeymap();
  }

  /** 提交键位：落 localStorage → 经 `globalThis.__keyboardInput` 调 `setKeymap` → 重渲染 `#keyList`。 */
  private commitKeymap(): void {
    saveKeymap(this.keymap);
    // 实例由 app.ts 挂在 globalThis.__keyboardInput；未挂载时为 undefined，跳过
    const kb = (globalThis as unknown as { __keyboardInput?: KeyboardInput }).__keyboardInput;
    kb?.setKeymap(this.keymap);
    this.renderKeyList();
  }

  // ── 通用控件绑定：滑块 + 数值框、复选框、select、按钮 ────────────

  private bindEvents(): void {
    // M 键：切换面板 `hidden` 类（不校验锁定状态）
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') {
        e.preventDefault();
        this.root.classList.toggle('hidden');
      }
    });

    // ESC：未锁定时移除 `hidden` 类；锁定态的退锁由浏览器 pointerlockchange 触发（见 app.ts）
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.getLocked()) {
        this.root.classList.remove('hidden');
      }
    });

    // 物理滑块/复选框 → config.physics 就地写回 → InputBridge.sendConfig('physics', …)：
    // 该桥把 buildPhysicsParams 的全量 snake_case 参数同时交给主线程预测实例与权威 Worker
    // （消息 type = 'config'，section = 'physics'），并额外带上 JS 驱动层的 tickRate。
    // lockTickRate 为 true 时 tickRate 不走滑块：写死 64、滑块与数值框都禁用，只下发一次 config。
    const tickRateEl = document.getElementById('tickRate') as HTMLInputElement | null;
    const tickRateNum = document.getElementById('tickRateNum') as HTMLInputElement | null;
    if (this.config.lockTickRate) {
      // 锁定：config 与两个控件都写 64 并禁用
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
    // 传送门槛（帧，1..20）：映射为 teleport_gate_ticks
    this.bindSlider('teleportGateTicks', 1, 20, 1, (v) => {
      this.config.physics.teleportGateTicks = v;
      this.bridge.sendConfig('physics', { teleportGateTicks: v });
      this.pushPhysicsParams();
    });

    // 体型：三个尺寸都经 sendHull() 下发（player 段 → set_hull 通道）
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
      // 滑块与右侧数值框一起写默认值（#hullReset 不走 bindSlider，两个控件都要手工同步）
      for (const [id, val] of [
        ['hullHalfWidth', 16],
        ['hullStandHeight', 72],
        ['hullDuckHeight', 54],
      ] as const) {
        const range = document.getElementById(id) as HTMLInputElement | null;
        if (range) range.value = String(val);
        const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
        if (num) num.value = String(val);
      }
      this.sendHull();
      this.savePanelPrefs();
    });

    // 操作：灵敏度（写 config.input.sensitivity；物理参数里的 sensitivity 恒为 1，
    // 真实灵敏度由输入层乘入角度增量）与 Q/E 旋转速度（映射为 yaw_bind_speed）
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

    // 准星可见性：写 config.hud.showCrosshair，并直接切 #crosshair 的 hidden 类
    this.bindCheckbox('showCrosshair', (v) => {
      this.config.hud.showCrosshair = v;
      const el = document.getElementById('crosshair');
      if (el) el.classList.toggle('hidden', !v);
    });

    // 准星样式：颜色走 input 事件，其余走 bindSlider / bindCheckbox；每次变更即 applyCrosshair + 落盘
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

    // 视野 FOV（度，60..110，步进 0.1）→ config.hud.fov + 渲染器 setFov
    this.bindSlider('fov', 60, 110, 0.1, (v) => {
      this.config.hud.fov = v;
      this.onSyncFov?.(v);
    });

    // 渲染距离（0..60000，步进 500）→ config.hud.renderDistance + 渲染器 setRenderDistance；
    // 0 = 自动（地图包围盒对角线的一半），正值按世界单位（≈1 英寸）把超距空间块置 visible=false
    this.bindSlider('renderDistance', 0, 60000, 500, (v) => {
      this.config.hud.renderDistance = v;
      this.onSyncRenderDistance?.(v);
    });

    // 曝光（0.1..8，步进 0.01）→ config.lighting.exposure + 渲染器 setExposure：
    // 显示侧亮度倍率，乘在光照项上，不改变烘焙数据；默认值见 apps/game/src/config.ts 的 DEFAULT_CONFIG。
    this.bindSlider('exposure', 0.1, 8, 0.01, (v) => {
      this.config.lighting.exposure = v;
      this.onSyncExposure?.(v);
    });

    // 暗部提升 γ（0.5..6，步进 0.01）→ config.lighting.lightGamma + 渲染器 setLightGamma：
    // 着色器对光照项做 pow(L, 1/γ)（γ>1 抬暗部、γ<1 压暗部）；
    // 渲染端的 setLightGamma 只接受 (0, 1]，滑块大于 1 的取值不会写进共享 uniform。
    this.bindSlider('lightGamma', 0.5, 6, 0.01, (v) => {
      this.config.lighting.lightGamma = v;
      this.onSyncLightGamma?.(v);
    });

    // 模型光照（0..3，步进 0.01）→ config.lighting.ambientScale + 渲染器 setAmbientScale：
    // 只作用于 prop 的 ambient cube 路径，不影响 world lightmap。
    this.bindSlider('ambientScale', 0, 3, 0.01, (v) => {
      this.config.lighting.ambientScale = v;
      this.onSyncAmbientScale?.(v);
    });

    // 速度面板模式（lateral / lateral-vertical / total）→ config.hud.speedMode
    // （app.ts 的 updateSpeedHud 按 125ms 门控读取）
    const speedMode = document.getElementById('speedMode') as HTMLSelectElement | null;
    speedMode?.addEventListener('change', () => {
      this.config.hud.speedMode = speedMode.value as 'lateral' | 'lateral-vertical' | 'total';
      this.savePanelPrefs();
    });

    // 光照模式（baked / texture）→ config.lighting.mode + 渲染器 setLightingMode：
    // 渲染端只改一个全场景共享的 uniform，立即生效，不重建场景、不重编译材质；
    // 模式初值由 RendererMain.init 按 config 设定，此处负责运行期切换与持久化。
    const lightingMode = document.getElementById('lightingMode') as HTMLSelectElement | null;
    lightingMode?.addEventListener('change', () => {
      this.config.lighting.mode = lightingMode.value === 'texture' ? 'texture' : 'baked';
      this.onSyncLightingMode?.(this.config.lighting.mode);
      this.savePanelPrefs();
    });

    // 纹理画质（original / mini）→ config.texture.quality + 渲染器 applyTextureQuality
    const textureQuality = document.getElementById('textureQuality') as HTMLSelectElement | null;
    textureQuality?.addEventListener('change', () => {
      this.config.texture.quality = textureQuality.value as 'original' | 'mini';
      this.onTextureQualityChange?.(this.config.texture.quality);
      this.savePanelPrefs();
    });

    // noclip 开关按钮：`active` 类即状态；切换后写 physics.mode、发全量物理参数、通知预测实例
    const noclipBtn = document.getElementById('noclipToggle') as HTMLButtonElement | null;
    noclipBtn?.addEventListener('click', () => {
      const active = noclipBtn.classList.toggle('active');
      // 两端通知：sendConfig('physics', { mode }) 让权威 Worker 单发一次 mode，
      // 随后的 pushPhysicsParams() 补全量参数，onNoclipChange 同步主线程预测实例
      this.bridge.sendConfig('physics', { mode: active ? 'noclip' : 'physics' });
      this.pushPhysicsParams();
      this.onNoclipChange?.(active);
    });

    // noclip 移动速度（HU/s，200..3000）→ config.input.noclipSpeed（映射为 noclip_speed）
    this.bindSlider('noclipSpeed', 200, 3000, 1, (v) => {
      this.config.input.noclipSpeed = v;
      this.bridge.sendConfig('input', { noclipSpeed: v });
      this.pushPhysicsParams();
    });

    // 恢复默认键位：resetKeymap 清 localStorage 并返回默认表，随即 commitKeymap 生效
    document.getElementById('keyReset')?.addEventListener('click', () => {
      this.keymap = resetKeymap();
      this.commitKeymap();
    });

    // 「关闭」按钮：只加 `hidden` 类，不请求 Pointer Lock（锁定由画布点击触发，见 app.ts）
    document.getElementById('panelClose')?.addEventListener('click', () => {
      this.cancelRecording(); // 关闭时若仍在录制必须先取消——否则捕获阶段监听会继续吞 keydown
      this.root.classList.add('hidden');
    });

    // 窗口失焦：录制监听等不到下一次按键，直接取消
    window.addEventListener('blur', () => this.cancelRecording());
  }

  private sendHull(): void {
    const p = this.config.player;
    this.bridge.sendConfig('player', {
      halfWidth: p.halfWidth,
      standHeight: p.standHeight,
      duckHeight: p.duckHeight,
    });
    // 同步主线程预测实例体型（setPredictionHull → set_hull）
    this.onSyncHull?.(p.halfWidth, p.standHeight, p.duckHeight);
  }

  /** 按当前 config 重建全量物理参数（buildPhysicsParams）并交给主线程预测实例。 */
  private pushPhysicsParams(): void {
    this.onSyncPrediction?.(buildPhysicsParams(this.config));
  }

  private bindSlider(id: string, min: number, max: number, step: number, onInput: (v: number) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
    // 步进以实参写回两个控件（滑块与数值框共用同一个 step）
    el.step = String(step);
    if (num) num.step = String(step);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (num && Number.isFinite(v)) num.value = String(v);
      onInput(v);
      this.savePanelPrefs(); // 落盘偏好
    });
    // 数值框输入：解析 → 钳到 [min, max] → 回写滑块与 config（数值框自身文本不改写）
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

  /** 复选框绑定：`change` 时把 `checked` 交给回调，并落盘偏好。 */
  private bindCheckbox(id: string, onChange: (v: boolean) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.addEventListener('change', () => {
      onChange(el.checked);
      this.savePanelPrefs();
    });
  }

  // ── 面板偏好持久化（localStorage 键 vbsp:panelPrefs；physics/player/input/hud/texture/lighting）──

  /** localStorage 存储键（`vbsp:panelPrefs`）。 */
  private static readonly PREFS_KEY = 'vbsp:panelPrefs';

  /**
   * 面板偏好结构版本，随偏好一起写入 `__version` 字段。
   * `loadPanelPrefs` 发现存档版本不等于该值时：不合并存档内容，
   * 并以当前 config（默认值）立即写回一个新版本档。
   */
  private static readonly PREFS_VERSION = 2;

  /** 收集待持久化的六段偏好（physics / player / input / hud / texture / lighting），并写入 `__version`。 */
  private collectPrefs(): Record<string, unknown> {
    const p = this.config;
    return {
      __version: PanelController.PREFS_VERSION,
      physics: { ...p.physics },
      player: { ...p.player },
      input: {
        sensitivity: p.input.sensitivity,
        yawBindSpeed: p.input.yawBindSpeed,
        noclipSpeed: p.input.noclipSpeed,
      },
      hud: {
        showCrosshair: p.hud.showCrosshair,
        speedMode: p.hud.speedMode,
        fov: p.hud.fov,
        renderDistance: p.hud.renderDistance,
        crosshair: { ...p.hud.crosshair },
      },
      texture: { ...p.texture },
      lighting: {
        exposure: p.lighting.exposure,
        lightGamma: p.lighting.lightGamma,
        ambientScale: p.lighting.ambientScale,
        // 光照模式也是持久化项：重开页面时由 loadPanelPrefs 合并回 config.lighting.mode
        mode: p.lighting.mode,
      },
    };
  }

  /** 落盘偏好（构造期与每次控件变更后调用）；localStorage 抛错时只告警。 */
  private savePanelPrefs(): void {
    try {
      localStorage.setItem(PanelController.PREFS_KEY, JSON.stringify(this.collectPrefs()));
    } catch (err) {
      console.warn('[panel] 面板偏好保存失败:', err);
    }
  }

  /** 读取 localStorage 存档并按段合并进 config（`Object.assign`：同名覆盖，存档里的新键一并写入）。
   * `__version` 不匹配时：不合并，直接把当前 config 默认值写回为新版本。 */
  private loadPanelPrefs(): void {
    try {
      const raw = localStorage.getItem(PanelController.PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw) as Record<string, unknown>;
      if (prefs.__version !== PanelController.PREFS_VERSION) {
        console.warn(
          `[panel] 面板偏好版本 ${String(prefs.__version)} → ${PanelController.PREFS_VERSION}，` +
            '丢弃旧设置，采用新默认值。',
        );
        // 不合并存档内容：以当前 config 写回新版本档
        this.savePanelPrefs();
        return;
      }
      const merge = <T>(section: T, patch: unknown): void => {
        if (!patch || typeof patch !== 'object') return;
        Object.assign(section as object, patch);
      };
      merge(this.config.physics, prefs.physics);
      merge(this.config.player, prefs.player);
      merge(this.config.input, prefs.input);
      merge(this.config.hud, prefs.hud);
      merge(this.config.texture, prefs.texture);
      merge(this.config.lighting, prefs.lighting);
    } catch (err) {
      console.warn('[panel] 面板偏好加载失败:', err);
    }
  }

  /** 把 config 当前值回写到全部控件（滑块、数值框、复选框、select）；构造函数在偏好加载之后调用。 */
  private syncControlsFromConfig(): void {
    const setVal = (id: string, val: string): void => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = val;
      // 同时写滑块与 `${id}Num` 数值框（持久化值与 HTML 默认值不一致时同样要覆盖）
      const num = document.getElementById(`${id}Num`) as HTMLInputElement | null;
      if (num) num.value = val;
    };
    const setChecked = (id: string, val: boolean): void => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.checked = val;
    };
    const p = this.config;
    // 物理（config.physics）
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
    setVal('teleportGateTicks', String(p.physics.teleportGateTicks));
    // 体型（config.player）
    setVal('hullHalfWidth', String(p.player.halfWidth));
    setVal('hullStandHeight', String(p.player.standHeight));
    setVal('hullDuckHeight', String(p.player.duckHeight));
    // 操作（config.input：灵敏度、Q/E 旋转速度）
    setVal('sensitivity', String(p.input.sensitivity));
    setVal('yawBindSpeed', String(p.input.yawBindSpeed));
    // 视角（config.input.noclipSpeed）
    setVal('noclipSpeed', String(p.input.noclipSpeed));
    // 显示（config.hud + texture.quality + lighting.mode）
    setChecked('showCrosshair', p.hud.showCrosshair);
    const speedMode = document.getElementById('speedMode') as HTMLSelectElement | null;
    if (speedMode) speedMode.value = p.hud.speedMode;
    const textureQuality = document.getElementById('textureQuality') as HTMLSelectElement | null;
    if (textureQuality) textureQuality.value = p.texture.quality;
    const lightingModeEl = document.getElementById('lightingMode') as HTMLSelectElement | null;
    if (lightingModeEl) lightingModeEl.value = p.lighting.mode;
    // 光照（config.lighting：曝光 / γ / 模型光照）
    setVal('exposure', String(p.lighting.exposure));
    setVal('lightGamma', String(p.lighting.lightGamma));
    setVal('ambientScale', String(p.lighting.ambientScale));
    // 准星（config.hud.crosshair）
    setVal('chColor', p.hud.crosshair.color);
    setVal('chSize', String(p.hud.crosshair.size));
    setVal('chThickness', String(p.hud.crosshair.thickness));
    setVal('chGap', String(p.hud.crosshair.gap));
    setChecked('chOutline', p.hud.crosshair.outline);
    setChecked('chDot', p.hud.crosshair.dot);
    // 视野（config.hud.fov / renderDistance）
    setVal('fov', String(p.hud.fov));
    setVal('renderDistance', String(p.hud.renderDistance));
  }

  /** 把加载后的偏好整体下发：3 条 sendConfig（physics / player / input）+ 预测参数与体型 + 渲染侧各 setter。 */
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
    // 渲染侧初值由 RendererMain.init 按 config 当时的值设定，而 init 早于本构造函数执行，
    // 故这里用 loadPanelPrefs 合并后的 config 覆盖一次 FOV / 渲染距离 / 曝光 / γ / 模型光照 / 光照模式。
    this.onSyncFov?.(p.hud.fov);
    this.onSyncRenderDistance?.(p.hud.renderDistance);
    this.onSyncExposure?.(p.lighting.exposure);
    this.onSyncLightGamma?.(p.lighting.lightGamma);
    this.onSyncAmbientScale?.(p.lighting.ambientScale);
    this.onSyncLightingMode?.(p.lighting.mode);
  }

  /** 把准星样式写进 `#crosshair` 的行内 CSS 变量（--ch-color / --ch-size / --ch-thickness / --ch-gap），并切 `hidden` / `outline` / `no-dot` 三个类。 */
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
    // 四条 .ch-line 按 outline 加类；中心点由 no-dot 类控制显隐
    el.querySelectorAll('.ch-line').forEach((line) => {
      line.classList.toggle('outline', c.outline);
    });
    const dot = el.querySelector('.ch-dot') as HTMLElement | null;
    el.classList.toggle('no-dot', !c.dot);
  }

  /** 渲染 `#savepointList`（「通用」分栏）：每行是序号 + 坐标 + 速率，附「读」与「×」两个按钮，
   * 分别回调 `onSavePointLoad` / `onSavePointDelete`；空列表显示一条提示。
   * 形参只取 x/y/z/yaw/vx/vy/vz——`yaw` 不参与本方法渲染。 */
  renderSavePoints(list: Array<{ x: number; y: number; z: number; yaw: number; vx: number; vy: number; vz: number }>): void {
    const box = document.getElementById('savepointList');
    if (!box) return;
    box.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '暂无存点（X 键存点 / C 键读最近）';
      box.appendChild(empty);
      return;
    }
    list.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'savepoint-row';
      const speed = Math.hypot(p.vx, p.vy, p.vz).toFixed(0);
      row.innerHTML =
        `<span class="sp-idx">${i + 1}</span>` +
        `<span class="sp-pos">(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) · ${speed}u/s</span>`;
      const loadBtn = document.createElement('button');
      loadBtn.className = 'small';
      loadBtn.textContent = '读';
      loadBtn.title = '恢复该存点';
      loadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSavePointLoad?.(i);
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'small danger';
      delBtn.textContent = '×';
      delBtn.title = '删除该存点（无确认）';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSavePointDelete?.(i);
      });
      row.appendChild(loadBtn);
      row.appendChild(delBtn);
      box.appendChild(row);
    });
  }
}
