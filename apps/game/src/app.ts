/**
 * WebSurf-game — 主线程入口（`main` 装配全流程，文件末 `void main()` 触发）。
 *
 * 装配顺序：
 * 1. `#preview` 画布缺失即报错返回；否则判通道：`crossOriginIsolated` 且
 *    `SharedArrayBuffer` 可用 → 新建 `SharedArrayBuffer(SHARED_BUFFER_SIZE)`，
 *    否则该实参传 `null`，由 `createMainSharedState` 落到 postMessage 回退通道。
 * 2. 建权威 Worker：`__VBSP_WORKER_JS__` 存在则把内嵌代码做成 Blob URL 装载
 *    （module worker 在 `file://` 下被 CORS 拒绝），否则装载 `./worker.js`（module）。
 * 3. `RendererMain` = 主线程物理+渲染线；`InputBridge` = 面板参数与传送/重生的发送口；
 *    `PanelController` = ESC 面板，其构造回调直达 `RendererMain` 的对应 setter。
 * 4. `bindInput` 绑 DOM 事件，`startInputLoop` 起 rAF 输入循环。
 *
 * P2 Step2（共享 bootstrap）：通道判定/Worker 创建/wasm 注入/共享状态/桥接/渲染器+
 * 通用回调骨架/init·start/主线程 wasm 预热已下沉到 `src/ts-shared/app/app-runtime.ts`
 * 的 `createAppRuntime()`；本文件 `main()` 只保留端特有装配（面板/输入/HUD/载图）。
 *
 * 线程分工：Worker 独立跑固定步长权威模拟并回发权威帧与碰撞事件；主线程全速跑渲染物理。
 * 两者消费同一份输入——`RendererMain.tick` 每帧把 `feedInput` 暂存的鼠标增量与键位掩码
 * 写入共享输入槽，Worker 从该槽取。
 *
 * 主线程 → Worker：`init`、`wasm-init`、`world-json`、`set-spawn-points`、
 * `sync-render-state`，以及经 `InputBridge` 发出的 `config`、`respawn`、`teleport`、
 * `set-death-threshold`。
 * Worker → 主线程：`phys-frame`（权威帧）、`phys-event`（落地/撞墙修正）、`health-log`、
 * `error`、`world-build-ms`、`world-parse-ms`。
 */

import { createConfig, LOCKED_TICK_RATE, applyConfigPatch } from './config.js'; import { optDom } from './dom-optional.js';
import type { RuntimeConfig } from './config.js';
import { BspProcessor, decode_vtf_to_png, decompress_mtz } from '../pkg/websurf_wasm.js';
import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { ACTION_LABELS, codeLabel, loadKeymap, type BindableAction } from './input/keymap.js';
import type { KeyState } from './worker/worker-types.js';
import { shouldConfirmClose } from '../../../src/ts-shared/dom/close-guard.js';
import { ChatOverlay } from '../../../src/ts-shared/dom/chat-overlay.js';
import { MouseBuffer } from '../../../src/ts-shared/input/mouse-buffer.js';
import { PointerLockController } from '../../../src/ts-shared/input/pointer-lock.js';
import { keysToMask, KEY_MASK, type SharedState } from '../../../src/ts-shared/auth/shared-state.js';
import { layerMouseDelta, qeEquivalentDx } from '../../../src/ts-shared/input/input-layer.js';
import { buildWorldBundle } from '../../../src/ts-shared/phys/world-builder.js'; import { buildSkyboxCubeTexture, collectSkyboxFaces, type SkyboxProcessorLike } from '../../../src/renderer-shared/environment/skybox.js'; import { fogParamsFromEntities } from '../../../src/renderer-shared/environment/fog-controller.js'; import { skyCameraFromEntities, type SkyCameraParams } from '../../../src/renderer-shared/environment/miniature-sky.js';
import { RendererMain } from './renderer/renderer-main.js';
import { PanelController } from './panel/panel-controller.js';
import { SavePointStore, SAVEPOINT_MAX, type SavePoint } from './savepoint.js';
import { readRenderPrefs, writeRenderPrefs, applyRenderPrefs, defaultRenderPrefs, readPrefsPath, prefsPathPatch } from '../../../src/renderer-shared/config/render-prefs.js';
import { buildRenderPanel, type RenderPanelApi, type RenderPanelValue } from '../../../src/renderer-shared/config/render-panel-ui.js';
import { setOptimizeFlags } from '../../../src/renderer-shared/config/optimize-flags.js';
import type { RenderPanelItem } from '../../../src/renderer-shared/config/render-panel-spec.js';
import {
  createAppRuntime,
  type AppAuthorityMode,
  type AppHooks,
  type AppRuntime,
} from '../../../src/ts-shared/app/app-runtime.js';
import { createConfigSync, type ConfigSync } from '../../../src/ts-shared/app/config-sync.js';

const config: RuntimeConfig = createConfig();

const dom = {
  canvas: document.getElementById('preview') as HTMLCanvasElement | null,
  fileInput: optDom<HTMLInputElement>('bspFile'),
  statusEl: document.getElementById('status') as HTMLElement | null,
  statsEl: document.getElementById('stats') as HTMLElement | null,
  keys: document.getElementById('keys') as HTMLElement | null,
  spawnSelect: optDom<HTMLSelectElement>('spawnSelect'),
  respawnBtn: optDom<HTMLButtonElement>('respawnBtn'),
  fpsEl: document.getElementById('fps') as HTMLElement | null,
  // 近平面自适应控件：range 与 number 成对，bindNearParam 双向同步后交给渲染器
  nearProbeDistRange: document.getElementById('nearProbeDist') as HTMLInputElement | null,
  nearProbeDistNum: document.getElementById('nearProbeDistNum') as HTMLInputElement | null,
  nearRatioRange: document.getElementById('nearRatio') as HTMLInputElement | null,
  nearRatioNum: document.getElementById('nearRatioNum') as HTMLInputElement | null,
  // 地图加载进度覆盖层（showLoading / advanceLoading / finishLoading / failLoading 操作这些元素）
  loadingOverlay: document.getElementById('loadingOverlay') as HTMLElement | null,
  loadingSub: document.getElementById('loadingSub') as HTMLElement | null,
  loadingFill: document.getElementById('loadingFill') as HTMLElement | null,
  loadingStage: document.getElementById('loadingStage') as HTMLElement | null,
  loadingPct: document.getElementById('loadingPct') as HTMLElement | null,
} as const;

const keyboard = new KeyboardInput(loadKeymap());
// 面板改键入口：KeyboardInput 实例挂到 globalThis.__keyboardInput，面板提交键位时取它调 setKeymap
(globalThis as unknown as { __keyboardInput?: KeyboardInput }).__keyboardInput = keyboard;

// 键位表变更 → 立即刷新左下角按键簇标签；HUD 与面板读同一份 loadKeymap()
keyboard.onKeymapChange(() => syncKeyHudLabels());
export type { BindableAction };
const mouseBuffer = new MouseBuffer();
const pointerLock = new PointerLockController();

let fixWorker: Worker | null = null;
let bridge: InputBridge | null = null;
let renderer: RendererMain | null = null;
/** 地图聊天框：渲 `point_servercommand` / `point_clientcommand` 的 `say` 提示。 */
let chatOverlay: ChatOverlay | null = null;
/** 共享 bootstrap 实例（Step2）：死亡阈值等「端侧决定时机」的下发必须经它。 */
let appRuntime: AppRuntime<RuntimeConfig, RendererMain, InputBridge, Worker | null> | null = null;
let panel: PanelController | null = null;
let sharedState: SharedState | null = null;
let sceneReady = false;
/** 主线程 wasm 初始化 promise：handleLoadBsp 调 buildWorldBundle 前 await 它（decompress_mtz 依赖）。 */
let mainWasmReady: Promise<void> = Promise.resolve();

/** config-sync（P5）：game 段清单（与旧 syncFullConfig 一致：4 段；副作用全在 bridge.sendConfig 内）。 */
const CONFIG_SYNC_SECTIONS: ReadonlyArray<keyof RuntimeConfig> = ['physics', 'input', 'player', 'hud'];
/** config 段同步实例（P5）：AppRuntime 就绪后构造。 */
let configSync: ConfigSync<RuntimeConfig> | null = null;
/** 速度面板刷新门控时刻（ms）：输入循环间隔 ≥125ms 才调 updateSpeedHud。 */
let speedUpdateAt = 0;
/** 滚轮跳待消费标志：wheel 事件置位，输入循环下一帧把它并入键位掩码后清零。 */
let wheelJumpPending = false;
/** 当前地图名（handleLoadBsp 去掉 .bsp 后缀写入；SavePointStore 以它为持久化键）。 */
let currentMapName = '';
/** 存点存储：X 存点、C 定身、面板列表三处共用；按地图持久化，容量 SAVEPOINT_MAX。 */
const savePointStore = new SavePointStore();
/** 按住 C 期间的冻结存点；非空即处于定身态，keyup 交给 endHoldPoint 释放。 */
let holdPoint: SavePoint | null = null;

/**
 * P2 Step2：game 薄入口——通道/Worker/wasm 注入/共享状态/桥接/渲染器+通用回调骨架/
 * init·start/主线程 wasm 预热全部走共享 createAppRuntime()（9 步固定序见 runtime 文件头）；
 * 本函数只保留端特有装配：共享内存判定与日志、面板、输入/HUD 与输入循环。
 */
async function main(): Promise<void> {
  if (!dom.canvas) {
    console.error('[app] canvas#preview 未找到');
    return;
  }

  // 0. 权威物理归属（T-D132）：默认单权威主线程；`?authority=worker` 回切旧双线做 A/B。
  //    归属由端入口显式解析并传入，runtime 只在缺省时按 legacy 'worker' 处理（apps/debug 不改）。
  const authorityMode = resolveAuthorityMode();
  console.info(
    authorityMode === 'main'
      ? '[authority] 单权威主线程模式：唯一 PhysWorld 在主线程（?authority=worker 可回切双线 A/B）'
      : '[authority] 双线模式（legacy）：Worker 权威 + 主线程预测',
  );

  // 0.1 共享内存通道判定（仅双线模式需要；单权威主线程没有跨线程通道，
  //     也不应弹「无 SharedArrayBuffer 兼容模式」降级提示）
  const sharedMemory = authorityMode === 'worker' ? resolveSharedMemory() : false;

  // 1-2. 通道骨架 + 主线程 wasm 预热 → 共享 bootstrap
  const runtime = createAppRuntime<RuntimeConfig, RendererMain, InputBridge, Worker | null>(
    {
      id: 'game',
      canvas: dom.canvas,
      config,
      sharedMemory,
      authorityMode,
      worker: { inlineJs: readEmbedded('__VBSP_WORKER_JS__'), url: './worker.js' },
      wasm: {
        inlineB64: readEmbedded('__VBSP_WASM_B64__'),
        url: './websurf_wasm_bg.wasm',
      },
    },
    createGameHooks(authorityMode),
  );
  appRuntime = runtime;

  // 3. 旧模块级引用直接指向 runtime 装配结果（面板/输入/载图与错误处理代码不改）
  fixWorker = runtime.worker;
  sharedState = runtime.shared;
  renderer = runtime.renderer;
  // 地图聊天框（`point_servercommand` / `point_clientcommand` 的 `say`）。
  chatOverlay = new ChatOverlay({ left: 12, bottom: 56 });
  if (renderer) renderer.onChatMessage = (text) => chatOverlay?.push(text);
  mainWasmReady = runtime.wasmReady;
  bridge = runtime.bridge;
  if (!bridge) {
    setError('InputBridge 装配未完成（bridgePhase=after-init 应在 init/start 后创建）');
    return;
  }

  // 实体副作用（共享宿主 EntityGameplay）→ 权威 Worker：渲染物理线已由宿主写，这里只做转发。
  // 注：这组转发在 P2 Step3 收口时随 legacy 块被误删（C1 行为回放回归发现），缺了会让
  // 加速板/跳高/限速/玩家名门控只在主线程生效，权威与主线程速度、传送门控分叉。
  renderer.onPlayerVelocity = (vel, mode) => {
    if (mode === 'set') bridge?.sendSetPushVelocity(vel);
    else bridge?.sendAddVelocity(vel);
  };
  renderer.onSpeedCapChange = (cap) => bridge?.sendSetSpeedCap(cap);
  renderer.onJumpHeightChange = (height) => bridge?.sendSetJumpHeight(height);
  renderer.onPlayerNameChange = (name) => bridge?.sendSetPlayerName(name);
  renderer.onMapPhysicsParam = (name, value) => bridge?.sendSetMapPhysicsParam(name, value);
  // brush 实心状态/位移必须同步权威 Worker：不同步时预测里门关了、权威里还开着，
  // 电梯/移动平台在权威侧不动，玩家会被权威帧拉回。
  renderer.onBrushSolidForAuthority = (entity, solid) => bridge?.sendBrushSolid(entity, solid);
  renderer.onBrushOffsetForAuthority = (entity, offset) => bridge?.sendBrushOffset(entity, offset);

  // 3.1 config 段同步实例（P5）：构造点=AppRuntime 就绪后；render 缺省（副作用全在 bridge.sendConfig 内）。
  //     applyPatch 用端 applyConfigPatch 保留旧守卫；send 直接走 bridge。
  configSync = createConfigSync<RuntimeConfig, RendererMain | null, InputBridge>({
    config,
    sections: CONFIG_SYNC_SECTIONS,
    applyPatch: (section, patch) => applyConfigPatch(config, section, patch),
    send: (section, patch) => bridge?.sendConfig(section, patch),
  });
  // 启动段：此时世界未建，Worker 会丢弃 config（既有行为，不在此修）
  syncFullConfig();

  // 4. 面板（参数变更实时同步主线程物理；构造与回调见 createPanel）
  panel = createPanel(bridge);

  // 5. 输入绑定（按键簇标签先就位，避免首帧显示 HTML 里的默认键名）
  initKeyHud();
  bindInput();
  startInputLoop();
}

/** 权威物理归属解析：`?authority=worker` → 旧双线；缺省/其他值 → 单权威主线程（T-D132）。 */
function resolveAuthorityMode(): AppAuthorityMode {
  const search = typeof location !== 'undefined' ? location.search : '';
  return new URLSearchParams(search).get('authority') === 'worker' ? 'worker' : 'main';
}

/** 共享内存可用性判定 + 端侧提示（回退语义/日志措辞由端保留，runtime 只接收结果）。
 *  仅双线模式调用；单权威主线程不判定也不提示（没有跨线程通道可用可降）。 */
function resolveSharedMemory(): boolean {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (isolated) {
    console.log('[game] crossOriginIsolated 已启用，使用共享内存输入/物理通道');
  } else {
    console.warn('[game] 未启用 crossOriginIsolated，回退 postMessage 输入通道（延迟较高）');
  }
  const canSab = isolated && typeof SharedArrayBuffer !== 'undefined';
  if (!canSab) {
    setStatus('兼容模式（无 SharedArrayBuffer）：功能可用，性能降级', '');
  }
  return canSab;
}

/** 读取构建注入的全局（内嵌 worker/wasm base64；dev 模式为 undefined）。 */
function readEmbedded(name: string): string | undefined {
  return (globalThis as unknown as Record<string, string | undefined>)[name];
}

/**
 * game 端特有 hook：createAppRuntime() 只负责通用 9 步骨架，端差异全部在这里声明。
 * - deathThresholdPolicy='after-scene'：loadScene 回调时 predPhys 未建，setDeathY 会空跑；
 *   保留「buildPredictionWorld 之后经 bridge 发一次」的旧时序（见 handleLoadBsp）。
 * - bridgePhase='after-init'：game 的 InputBridge 构造参数含 renderer，旧序在 init/start 后才建。
 * - initWorker：game 无 InputBridge.sendInit，`{type:'init'}` 必须在 wasm-init 之前直接发。
 */
function createGameHooks(authorityMode: AppAuthorityMode): AppHooks<RuntimeConfig, RendererMain, InputBridge, Worker | null> {
  return {
    // 主线程 wasm 懒初始化（BspProcessor + PhysWorld 同模块；dist 内嵌 base64）
    ensureMainWasm: (ctx) =>
      ctx.renderer!.initPrediction('./websurf_wasm_bg.wasm', readEmbedded('__VBSP_WASM_B64__')),
    deathThresholdPolicy: 'after-scene',
    bridgePhase: 'after-init',
    // Step2 只迁装配骨架；BSP→SceneData 流程仍在 handleLoadBsp，Step3（scene-loader）再收。
    onSceneBundle: (_bundle, _message) => {},
    // 权威归属显式传给渲染器：main 模式跳过权威帧校准链（公共呈现序列不改）
    createRenderer: (shared) => new RendererMain(shared, authorityMode),
    createInputBridge: (ctx) => new InputBridge(ctx.worker, ctx.renderer!, ctx.config),
    initWorker: (ctx) => {
      // 权威 Worker 的共享通道初始化：必须先于 wasm-init（否则 authLoop 以 shared=null 起步）
      // 单权威主线程没有 Worker（ctx.worker=null）：本次装配不存在该通道。
      ctx.worker?.postMessage({ type: 'init', shared: ctx.sharedBuffer });
    },
    afterRendererStart: (ctx) => {
      // 出帧探针（自动化验证仪器；只往 globalThis 挂对象，不改变渲染/物理行为）
      ctx.renderer?.installFrameProbe();
    },
    status: (message, kind) => setStatus(message, kind ?? ''),
    error: (message) => setError(message),
    health: (message) => pushHealthLog(message),
    // game 独有的耗时诊断（旧 main 内联分支）；其余消息交 runtime 通用处理
    onWorkerMessage: (message) => {
      if (message.type === 'world-build-ms') {
        const src = message.source === 'bin' ? 'world-bin（WSBW 解码+build_world）' : 'world-json（解析+build_world）';
        console.info(`[authority] Worker 内 ${src} = ${String(message.ms)}ms`);
        return true;
      }
      if (message.type === 'world-parse-ms') {
        console.info(
          `[authority] JSON 解析（JS 代理）：brush=${String(message.brush)}ms tri=${String(message.tri)}ms`,
        );
        return true;
      }
      return false;
    },
    // T-731/F3：只记录；下发仍由 handleLoadBsp 在 buildPredictionWorld 之后经 bridge 发一次
    onSceneLoaded: (deathY) => {
      pendingDeathY = deathY;
    },
  };
}

/** 面板构造（回调与旧 main 完全一致；从薄入口抽出以保持 main() <50 行）。 */
function createPanel(bridgeImpl: InputBridge): PanelController {
  return new PanelController(
    config,
    bridgeImpl,
    () => pointerLock.isLocked(),
    (params) => renderer?.setPredictionParams(params),
    (hw, sh, dh) => renderer?.setPredictionHull(hw, sh, dh),
    (active) => renderer?.setPredictionNoclip(active),
    (quality) => void renderer?.applyTextureQuality(quality),
    (fov) => renderer?.setFov(fov),
    (dist) => renderer?.setRenderDistance(dist),
    (exposure) => renderer?.applyLighting({ exposure }),
    (gamma) => renderer?.applyLighting({ lightGamma: gamma }),
    (scale) => renderer?.applyLighting({ ambientScale: scale }),
    (mode) => renderer?.setLightingMode(mode),
    (i) => {
      const list = savePointStore.delete(i);
      panel?.renderSavePoints(list);
    },
    (i) => {
      const list = savePointStore.all();
      const sp = list[i];
      if (sp && renderer) {
        renderer.loadSavepoint(sp);
        setStatus(`已读点 #${i + 1} @ (${sp.x.toFixed(0)}, ${sp.y.toFixed(0)}, ${sp.z.toFixed(0)})`, 'success');
      }
    },
    // task-95：计算帧率上限（physics.computeRateCap，独立于物理步长 tickRate）→ 主线程模拟时钟；
    // HUD「计算 xxxHz / 呈现 xxxfps」读模拟时钟统计（未接线时传 null 即显示 —）。
    (hz) => renderer?.setComputeRateCap(hz),
    () => renderer?.simClockStats ?? null,
    // 优化处理（config.optimize 三开关，默认全关）：交给共享渲染层运行时开关
    // （src/renderer-shared/config/optimize-flags.ts 的 setOptimizeFlags）。
    // 启动时由 PanelController.sendAllPrefs 按 vbsp:panelPrefs 恢复一次，之后每次勾选再应用一次。
    (flags) => setOptimizeFlags(flags),
    // 横向限速（physics.maxHorizontalSpeed，0=关闭）→ 共享宿主 EntityGameplay.setUserSpeedCap
    // （生效值 = min(地图 sv_maxvelocity, 用户值)）。
    (cap) => renderer?.setHorizontalSpeedCap(cap),
  );
}

function bindInput(): void {
  if (!dom.canvas) return;
  keyboard.bind(window);

  // +use：F 键（按住不重复触发）。与 WASD 同口径，只在 Pointer Lock 锁定时生效；
  // 选靶由渲染器按相机视线完成，按钮/门走地图既有实体 I/O（不再单独加掩码位）。
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyF' || event.repeat || !pointerLock.isLocked()) return;
    const target = event.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest('input, textarea, select')) return;
    renderer?.usePressed();
  });

  window.addEventListener('mousemove', (e) => {
    if (!pointerLock.isLocked()) return;
    const r = mouseBuffer.process(e.movementX, e.movementY);
    if (!r) return;
    const mask = keyboard.getMask();
    // 灵敏度输入层应用：物理两端 sensitivity 固定 1，这里乘入角度增量后统一分发
    // （改灵敏度只改这个系数，双端物理用同一份已缩放输入 → 角度永不因灵敏度分叉）
    const { dx, dy } = layerMouseDelta(r.dx, r.dy, config.input.sensitivity);
    renderer?.feedInput(dx, dy, mask); // 主线程渲染物理输入（RendererMain.tick 同写 SAB 权威端）
  });

  // 点击锁定视角（2026-09-21 修）：监听 **document**，不是 canvas。
  //
  // 旧实现绑在 `#preview` 上 ⇒ 面板/弹窗浮在画布之上时（面板是常驻覆盖层），点击落点其实是
  // 面板元素、事件不冒泡到 canvas ⇒ **永远拿不到 pointer lock**。用户症状就是"进图后转不动视角"
  // （尤其刚点过面板/刚热切换光照模式：视线在面板上，再点画面以为能转，其实什么都没发生）。
  //
  // 现在是「3D 区域点一下即锁定」：只要点击目标不在 UI 内（面板/按钮/弹窗），就请求锁定。
  const UI_HIT_SELECTOR =
    '#panel, #panelClose, .modal, .modal-box, .modal-backdrop, [data-ui-block-lock]';
  document.addEventListener('click', (e) => {
    if (!sceneReady || pointerLock.isLocked()) return;
    const target = e.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest(UI_HIT_SELECTOR)) return;
    // `requestLock` 恒返回 `Promise<boolean>`（`src/ts-shared/input/pointer-lock.ts:63`）：
    // 原先的 `instanceof Promise` 判门在当前签名下恒真、只是死分支，故直接走 promise（T-207）。
    const p = pointerLock.requestLock(dom.canvas!);
    p.then((ok) => {
      if (!ok) setStatus('锁定失败，请再次点击画布（确保焦点在页面内）', 'error');
    });
  });

  // 存点 / 读点快捷键（用户定调 2026-08-18）：X 存点；C 按住 = 定在存点（速度 0），
  // 松开 = 恢复存点速度。独立于 KeyState（不参与物理输入），仅锁定状态下响应。
  window.addEventListener('keydown', (e) => {
    if (!pointerLock.isLocked()) return;
    if (e.code === 'KeyX') {
      e.preventDefault();
      savePoint();
    } else if (e.code === 'KeyC' && !holdPoint) {
      e.preventDefault();
      startHoldPoint();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyC' && holdPoint) {
      e.preventDefault();
      endHoldPoint();
    }
  });

  pointerLock.onLockChange((locked) => {
    mouseBuffer.onLockChange(locked);
    // 按键捕获门控：仅锁定时接受按键；退锁（ESC 打开面板）后忽略面板内按键
    keyboard.setEnabled(locked);
    keyboard.reset();
    // 清预测实例残留输入（防 ESC 前最后输入/按住键残留）；权威键位由下一帧
    // 输入循环写 0 兜底（退锁后 mask 恒 0 → RendererMain.tick 统一写 SAB，
    // 一帧内自愈；bridge.addInput 为历史 no-op 占位，显式清权威键位见 blur 处理器）
    renderer?.clearPendingInput();
    bridge?.addInput(0, 0, 0);
    // 重锁时清滚轮跳 pending（面板期间滚动不产生跳跃）
    wheelJumpPending = false;
    // 面板状态机：锁定 → 隐藏；退锁（ESC）→ 弹出
    panel?.updateVisibility(sceneReady);
    if (locked) setStatus('已锁定。WASD 移动，鼠标视角，F 使用，ESC 打开面板。', '');
  });

  window.addEventListener('resize', () => {
    if (dom.canvas) renderer?.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
  });

  window.addEventListener('blur', () => {
    keyboard.reset();
    // 页面失焦：rAF 后台停摆会冻结 SAB 输入槽（I_KEYS 停在失焦前键位，Worker
    // 权威模拟按旧键位继续移动）——立即显式写 keysMask=0 清权威键位（SAB 路径
    // Atomics.store(I_KEYS,0)；MsgState 回退 post input{keys:0}，共享层 addInput
    // 双通道同接口）+ 清预测待喂输入。
    sharedState?.addInput(0, 0, 0);
    renderer?.clearPendingInput();
  });

  // 滚轮跳：wheel 事件置位，下一帧并入 jump（Rust apply_input 处理 0x100 位）。
  // 仅锁定时置位：面板打开时滚动面板不触发跳跃（否则改参数时角色乱跳）
  window.addEventListener('wheel', () => {
    if (pointerLock.isLocked()) wheelJumpPending = true;
  });

  // 加载地图按钮 → 触发隐藏 file input
  optDom<HTMLButtonElement>('loadMapBtn')?.addEventListener('click', () => {
    dom.fileInput?.click();
  });

  dom.fileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !renderer) return;
    input.value = '';
    // 记住 File 引用（不复制字节、不额外占内存）：面板「重载类」项改完要重建这张图
    lastMapFile = file;
    await handleLoadBsp(file.name, await file.arrayBuffer());
  });

  dom.respawnBtn?.addEventListener('click', () => bridge?.sendRespawn());

  // Spawn 选择（input + change 双监听：重选当前值/部分浏览器只触发 input 时
  // 也能响应；去重防重复传送——同步自主项目修复）
  // 注意：必须走 bridge.sendTeleport（主线程预测物理 + Worker 权威物理双端
  // 同步）——直接调 renderer.teleportToSpawn 只传主线程，权威帧 >200 兜底
  // 会把传送点拉回旧位置（"传送初始点出现问题"根因）
  let lastTeleportIdx = -1;
  const onSpawnPick = (idx: number): void => {
    if (idx === lastTeleportIdx || Number.isNaN(idx)) return;
    lastTeleportIdx = idx;
    bridge?.sendTeleport(idx);
  };
  dom.spawnSelect?.addEventListener('change', (e) => {
    onSpawnPick(parseInt((e.target as HTMLSelectElement).value, 10));
  });
  dom.spawnSelect?.addEventListener('input', (e) => {
    onSpawnPick(parseInt((e.target as HTMLSelectElement).value, 10));
  });

  // 近平面自适应参数（滑块 ↔ 输入框双向同步 + 渲染器实时生效）
  const bindNearParam = (
    range: HTMLInputElement | null,
    num: HTMLInputElement | null,
    apply: (v: number) => void,
    round: (v: number) => number,
  ): void => {
    if (!range && !num) return;
    const onRange = (): void => {
      if (!range) return;
      const val = round(parseFloat(range.value));
      if (num) num.value = String(val);
      apply(val);
    };
    const onNum = (): void => {
      if (!num) return;
      const raw = parseFloat(num.value);
      if (Number.isNaN(raw)) return;
      const val = round(raw);
      if (range) range.value = String(val);
      apply(val);
    };
    range?.addEventListener('input', onRange);
    num?.addEventListener('change', onNum);
  };
  bindNearParam(dom.nearProbeDistRange, dom.nearProbeDistNum, (v) => {
    renderer?.setNearParams(v, undefined);
  }, (v) => v);
  bindNearParam(dom.nearRatioRange, dom.nearRatioNum, (v) => {
    renderer?.setNearParams(undefined, v);
  }, (v) => Math.round(v * 100) / 100);
}

/** 低帧自检：把「为什么这台机器只有 N FPS」一次性打出来（GPU/焦点/视口），
 *  避免用户只能报「帧率不行」而无定位信息。仅在低帧时打印，正常机器零噪音。 */
let lowFpsWarnedAt = 0;
let lowFpsStreak = 0;
let frameDeltas: number[] = [];
function reportLowFps(fps: number, now: number): void {
  if (!sceneReady) return; // 加载/合并期本来就会掉帧，不算问题
  lowFpsStreak++;
  if (lowFpsStreak < 3 || now - lowFpsWarnedAt < 8000) return;
  lowFpsWarnedAt = now;
  lowFpsStreak = 0;
  const sorted = frameDeltas.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  let gpu = '?';
  try {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = dbg ? String(gl!.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unmasked-unavailable';
  } catch {
    /* 取不到就不写 */
  }
  const canvas = document.querySelector('canvas');
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const info = {
    fps,
    frameMs: +median.toFixed(2),
    gpu,
    canvas: canvas ? `${canvas.width}x${canvas.height}` : 'none',
    cssSize: `${innerWidth}x${innerHeight}`,
    dpr: devicePixelRatio,
    visible: document.visibilityState,
    focused: document.hasFocus(),
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(0) : undefined,
  };
  console.warn('[perf] 低帧自检', info);
  if (dom.fpsEl) {
    const hint = /swiftshader|software|basic render/i.test(info.gpu)
      ? '软件渲染（浏览器没启用 GPU：设置 → 系统和性能 → 使用硬件加速 → 重启浏览器）'
      : /intel/i.test(info.gpu)
        ? '核显渲染'
        : info.visible !== 'visible'
          ? '页面在后台被限帧'
          : !info.focused
            ? '窗口未聚焦（浏览器可能限帧）'
            : `GPU: ${info.gpu}`;
    dom.fpsEl.title = `${JSON.stringify(info, null, 2)}\n${hint}`;
    dom.fpsEl.textContent = `${fps} FPS ⚠`;
  }
}

/** 主线程 rAF 循环：按键 → SAB 输入槽 + 预测实例；渲染已在 RendererMain。 */
function startInputLoop(): void {
  let fpsFrames = 0;
  let fpsTime = 0;
  let lastQeMs = 0;
  let lastFrameAt = 0;
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    // FPS 显示（左上角，每秒刷新；不依赖场景就绪）
    fpsFrames++;
    if (lastFrameAt !== 0) {
      frameDeltas.push(now - lastFrameAt);
      if (frameDeltas.length > 120) frameDeltas.shift();
    }
    lastFrameAt = now;
    if (now - fpsTime >= 1000) {
      if (dom.fpsEl) dom.fpsEl.textContent = fpsFrames < 50 ? `${fpsFrames} FPS ⚠` : `${fpsFrames} FPS`;
      if (fpsFrames < 50) reportLowFps(fpsFrames, now);
      else lowFpsStreak = 0;
      fpsFrames = 0;
      fpsTime = now;
    }
    if (!bridge || !sceneReady) return;
    // 未锁定（面板打开）时强制输入为 0：面板内按键不进入物理（keyboard 已禁用，
    // 这里双保险防 ESC 前后按键状态残留）
    const keyState = keyboard.getState();
    const mask = pointerLock.isLocked() ? keysToMask(keyState) : 0;
    updateKeyHud(keyState); // 左下角按键簇高亮（仅状态变化时写 DOM）
    // 滚轮跳：仅锁定时并入本帧输入（消费一次即清）
    const maskWithWheel = pointerLock.isLocked() && wheelJumpPending ? mask | KEY_MASK.wheelJump : mask;
    wheelJumpPending = false;
    // Q/E 转向 → 等效鼠标增量（用户定调：按住时作用到鼠标的量上，但**独立增量**）：
    // 与真实鼠标同一输入通道（feedInput + SAB 累积，双端消费同源输入 →
    // 角度天然一致，无 Q/E 分叉）；旋转速度恒 = yawBindSpeed（固定角速度，
    // **不受灵敏度影响**——qeDx 不乘 sensitivity，物理两端 sensitivity 固定 1）
    const dtF = lastQeMs === 0 ? 1 / 144 : Math.min((now - lastQeMs) / 1000, 0.1);
    lastQeMs = now;
    const qe = qeEquivalentDx(config.input.yawBindSpeed, dtF);
    const qeDx = (maskWithWheel & KEY_MASK.yawRight ? qe : 0) - (maskWithWheel & KEY_MASK.yawLeft ? qe : 0);
    renderer?.feedInput(qeDx, 0, maskWithWheel); // 主线程物理按键 + Q/E 等效鼠标量
    // 速度面板 8Hz（0.125s）
    if (now - speedUpdateAt >= 125) {
      speedUpdateAt = now;
      updateSpeedHud();
    }
  };
  requestAnimationFrame(tick);
}

/** 速度面板：从主线程唯一物理线采样，8Hz 低频。纯数字无文字。 */
function updateSpeedHud(): void {
  if (!renderer || !dom.statsEl) return;
  const v = renderer.getCurrentVel();
  const lateral = Math.hypot(v.x, v.z);
  const vertical = Math.abs(v.y);
  const total = Math.hypot(v.x, v.y, v.z);
  const mode = config.hud.speedMode;
  const text =
    mode === 'lateral'
      ? `${lateral.toFixed(0)}<span class="unit"> u/s</span>`
      : mode === 'lateral-vertical'
        ? `${lateral.toFixed(0)}<span class="vsep">｜</span>${vertical.toFixed(0)}<span class="unit"> u/s</span>`
        : `${total.toFixed(0)}<span class="unit"> u/s</span>`;
  dom.statsEl.innerHTML = text;
}

// ── 左下角按键簇（#keys）：标签取自当前键位、高亮取实时输入 ─────────────
/** 键簇覆盖的动作（与 index.html 的 data-action 一一对应）。 */
const KEY_HUD_ACTIONS: readonly BindableAction[] = [
  'yawLeft', 'forward', 'yawRight', 'left', 'backward', 'right', 'duck', 'jump',
];
const keyHudEls = new Map<BindableAction, HTMLElement>();

/** 初始化：按 data-action 收集 8 个键位元素并写入首版标签。 */
function initKeyHud(): void {
  if (!dom.keys) return;
  for (const el of Array.from(dom.keys.querySelectorAll<HTMLElement>('[data-action]'))) {
    const action = el.dataset.action as BindableAction | undefined;
    if (action && KEY_HUD_ACTIONS.includes(action)) keyHudEls.set(action, el);
  }
  syncKeyHudLabels();
}

/**
 * 写入标签：取该动作**第一个绑定键**的显示名（与面板「按键」模块同源：
 * `loadKeymap` + `codeLabel`）⇒ 面板里改成什么，HUD 就显示什么。
 * 键位被删光 = 该动作已禁用 ⇒ 显示 "—" 并加 `.off`（与面板同语义）。
 */
function syncKeyHudLabels(): void {
  if (keyHudEls.size === 0) return;
  const keymap = loadKeymap();
  for (const [action, el] of keyHudEls) {
    const codes = keymap[action] ?? [];
    if (codes.length === 0) {
      el.textContent = '—';
      el.classList.add('off');
      el.title = `${ACTION_LABELS[action]}：未绑定（已禁用）`;
    } else {
      el.textContent = codeLabel(codes[0]);
      el.classList.remove('off');
      el.title = `${ACTION_LABELS[action]}（${codes.map(codeLabel).join(' / ')}）`;
    }
  }
}

/** 高亮：逐帧调用，但**仅在状态变化时写 DOM**（静止时零开销）。 */
let keyHudMask = -1;
function updateKeyHud(state: KeyState): void {
  if (keyHudEls.size === 0 || !dom.keys) return;
  const mask = keysToMask(state);
  if (mask === keyHudMask) return;
  keyHudMask = mask;
  for (const [action, el] of keyHudEls) el.classList.toggle('on', state[action] === true);
}

/**
 * 主线程加载 BSP（唯一物理线：解析 + 渲染 + 构建物理世界全部在主线程）。
 * Worker 已不参与地图加载/解析。
 * 公共化：BspProcessor 导出管线收敛到 ts-shared buildWorldBundle（colliderSource
 * auto + 默认纹理包回退 + GLB 导出 + 出生点解析全部共享）。
 */
/** 最近一次载入的地图文件引用（面板重载类项改完要重建它；File 引用不占内存）。 */
let lastMapFile: File | null = null;
/** T-731/F3：loadScene 回调先记下场景包围盒最小 Y（death_y）；buildPredictionWorld 之后再写双端
 *  ——回调到达时 predPhys 还是 null，当场 setDeathY 是空跑。 */
let pendingDeathY: number | null = null;
/** 面板「重载类」项改完后的重建计时器（250 ms 内多次写入只重建一次）。 */
let mapReloadTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * **重载类面板项改完后自动重建地图**（owner 清单 P2-①）。
 *
 * 为什么要防抖：apply === 'rebuild' 的项有 7 个，而「全部恢复默认」会一次写很多项 ——
 * 不合并就会连着重建好几次世界（每次都要重新解析 BSP）。250 ms 足够并成一次。
 * 没载入过地图时**如实说明**（提示「载入后生效」），不假装重建过。
 */
function scheduleMapReload(): void {
  if (mapReloadTimer !== null) clearTimeout(mapReloadTimer);
  mapReloadTimer = setTimeout(() => {
    mapReloadTimer = null;
    const file = lastMapFile;
    if (!file) {
      setStatus('面板已改；当前未载入地图，载入后生效。', '');
      return;
    }
    void file.arrayBuffer().then((bytes) => handleLoadBsp(file.name, bytes));
  }, 250);
}

async function handleLoadBsp(fileName: string, bytes: ArrayBuffer): Promise<void> {
  if (!renderer) {
    setError('渲染器未就绪');
    return;
  }
  // 换图清空上一张图的聊天提示。
  chatOverlay?.clear();
  // 存点按地图持久化：记录地图名并加载该地图存点列表（换地图清空/载入）
  currentMapName = fileName.replace(/\.bsp$/i, '');
  renderPanelHandle?.sync(); // 顶部「未载入地图」状态行随之收起
  savePointStore.load(currentMapName);
  panel?.renderSavePoints(savePointStore.all());
  // 读取地图后退出面板，改用加载进度覆盖层
  panel?.hide();
  // 主线程 wasm 就绪（BspProcessor / decompress_mtz 都来自该模块；失败即无法解析，报错并中止）
  await mainWasmReady.catch((e) => { console.error('[app] 主线程 wasm 初始化失败，无法解析地图：', e); setStatus('主线程 wasm 初始化失败，无法加载地图（详见控制台）', 'error'); throw e; });
  renderer.disposeScene();
  sceneReady = false;
  setStatus(`正在加载 ${fileName}（主线程解析 BSP）...`, '');
  showLoading(fileName);
  await new Promise((r) => setTimeout(r, 0)); // 让 UI 先更新（解析耗时较长）
  try {
    const proc = new BspProcessor(new Uint8Array(bytes)) as BspProcessor & SkyboxProcessorLike; const skyboxFaces = collectSkyboxFaces(proc, (v) => decode_vtf_to_png(v)); const entitiesJson = proc.parse_entities(); const fogParams = fogParamsFromEntities(entitiesJson); const skyCamera: SkyCameraParams | null = skyCameraFromEntities(entitiesJson); const bundle = await buildWorldBundle(proc, {
      // T-D135：game 的物理与 Worker 只吃 WSBW 二进制，不再序列化两份大 JSON。
      colliderEncoding: 'bin',
      decompressMtz: decompress_mtz,
      onProgress: (stage) => advanceLoading(stage),
    });

    // 渲染场景（GLB + PVS + spawn）
    advanceLoading('构建渲染场景 (GLB)'); const skyboxTexture = await buildSkyboxCubeTexture(skyboxFaces);
    await renderer.loadScene({
      type: 'scene-data',
      glb: bundle.glbBytes,
      spawnJson: bundle.spawnJson,
      pvsJson: bundle.pvsJson,
      mosaicManifest: bundle.mosaicManifest,
      metadata: bundle.metadata,
      spawn: bundle.spawn,
      glbSizeKb: Math.round(bundle.glbBytes.byteLength / 1024),
      numSpawnPoints: bundle.spawnList.length,
      hasPvs: bundle.pvsJson.length > 2, skyboxTexture, fogParams, skyCamera,
      entityIoJson: bundle.entityIoJson,
    });

    // 主线程物理世界（渲染线）
    advanceLoading('构建物理世界');
    // 二进制块先给主线程建世界，之后才允许 transfer（顺序即所有权，见 worker-protocol-types）。
    renderer.buildPredictionWorld({
      brushBin: bundle.brushBin,
      triBin: bundle.triBin,
      brushJson: bundle.brushJson,
      triJson: bundle.triJson,
      teleportJson: bundle.teleportJson,
      spawn: bundle.spawn,
    });
    // T-731/F3：death_y 双端补设。loadScene 回调先到（此时 predPhys 还是 null，setDeathY
    // 空跑），权威端则从未有发送方——两端都保持 Rust 默认 -100_000，掉出地图永不死亡重生。
    // 现在渲染实例已就绪：经 runtime.sendDeathThreshold（deathThresholdPolicy='after-scene'
    // 的端侧调用点）= 渲染端 setDeathY + Worker `set-death-threshold`（分发器会写入全部权威
    // 实例并记忆，世界重建后 reapplyDeathY 重放）。
    if (pendingDeathY !== null) {
      appRuntime?.sendDeathThreshold(pendingDeathY);
      pendingDeathY = null;
    }
    // Worker 权威物理世界（地图碰撞；独立固定步长权威帧计算）。
    // 单权威主线程模式（authorityMode='main'）没有 Worker：整段不发，主线程 predPhys 即唯一世界
    // （因此也不做两个大 JSON 的结构化克隆与 `set-spawn-points` 的重复序列化）。
    //
    // ⚠️ **顺序仍为"主线程世界建完再发"**（2026-09-20 实测过提前发送，更差）：
    // 提前到 `buildPredictionWorld` 之前曾让 Worker 内构建 3147ms → 3454ms、首个权威帧
    // 22.19s → 22.57s（主线程与 Worker 抢 CPU/内存带宽）。T-D135 改发 WSBW 二进制
    // （world-bin）消掉的是"JSON 字符串化 + Worker 侧 JSON.parse"，发送顺序不动；
    // 而且 transfer 语义本身就要求主线程先用同一块 buffer 建完世界。
    if (fixWorker) {
      if (bundle.brushBin && bundle.triBin) {
        console.info(`[authority] world-bin 已发送 @${performance.now().toFixed(0)}ms`);
        // 诊断：载荷体积（与旧 JSON 路径同口径，便于 A/B）
        console.info(
          `[authority] world-bin 载荷：brush=${(bundle.brushBin.byteLength / 1048576).toFixed(2)}MB ` +
            `tri=${(bundle.triBin.byteLength / 1048576).toFixed(2)}MB ` +
            `teleport=${(bundle.teleportJson.length / 1024).toFixed(1)}KB（合计 ` +
            `${((bundle.brushBin.byteLength + bundle.triBin.byteLength + bundle.teleportJson.length) / 1048576).toFixed(2)}MB）`,
        );
        const postT0 = performance.now();
        // **所有权**：两个 buffer 已在上面的 buildPredictionWorld 里被主线程世界读过，此后不再使用；
        // transfer 后本线程侧 byteLength=0，绝不能在本条消息之后复用它们。
        fixWorker.postMessage(
          {
            type: 'world-bin',
            brushBuf: bundle.brushBin,
            triBuf: bundle.triBin,
            teleportJson: bundle.teleportJson,
            spawn: bundle.spawn,
          },
          [bundle.brushBin, bundle.triBin],
        );
        // 诊断：postMessage 只转移所有权（不做结构化克隆），耗时含在主线程阻塞里
        console.info(`[authority] postMessage(world-bin) 转移耗时 = ${(performance.now() - postT0).toFixed(1)}ms`);
      } else {
        // 老 wasm / 二进制导出失败：退回 JSON 世界消息（builder 已保证两个 JSON 字段完整）。
        console.info(`[authority] world-json 已发送 @${performance.now().toFixed(0)}ms`);
        // 诊断：载荷体积（决定 Worker 内耗时是"解析"还是"建结构"主导）
        console.info(
          `[authority] world-json 载荷：brush=${(bundle.brushJson.length / 1048576).toFixed(2)}MB ` +
            `tri=${(bundle.triJson.length / 1048576).toFixed(2)}MB ` +
            `teleport=${(bundle.teleportJson.length / 1024).toFixed(1)}KB（合计 ` +
            `${((bundle.brushJson.length + bundle.triJson.length + bundle.teleportJson.length) / 1048576).toFixed(2)}MB）`,
        );
        const postT0 = performance.now();
        fixWorker.postMessage({
          type: 'world-json',
          brushJson: bundle.brushJson,
          triJson: bundle.triJson,
          teleportJson: bundle.teleportJson,
          spawn: bundle.spawn,
        });
        // 诊断：postMessage 内联做结构化克隆（三个大 JSON 字符串），耗时含在主线程阻塞里
        console.info(`[authority] postMessage(world-json) 结构化克隆耗时 = ${(performance.now() - postT0).toFixed(1)}ms`);
      }
    } else {
      console.info('[authority] 单权威主线程：跳过世界数据克隆与下发（无 Worker 权威线）');
    }
    // 出生点列表（spawn 下拉切换用）：主线程渲染物理 + Worker 权威物理**双端**
    // 都要设置——否则权威侧 teleport_to_spawn 索引为空静默忽略，权威帧
    // >200 兜底会把传送点拉回（"一瞬间传送过去又被拉回"根因）。
    // 单权威主线程只需主线程一份；`JSON.stringify` 也只在真有 Worker 时做。
    renderer.setSpawnPoints(bundle.spawnList);
    if (fixWorker) fixWorker.postMessage({ type: 'set-spawn-points', json: JSON.stringify(bundle.spawnList) });
    // 双端参数同步（Worker 权威 + 主线程渲染物理；含灵敏度，防操作分叉）
    syncFullConfig();

    sceneReady = true;
    setStatus(
      `场景已加载（GLB ${Math.round(bundle.glbBytes.byteLength / 1024)} KB，${bundle.metadata.numBrushes} brushes，` +
        `${bundle.spawnList.length} 出生点）`,
      'success',
    );
    // 出生点下拉
    if (dom.spawnSelect) {
      const spawnPoints = (JSON.parse(bundle.spawnJson) as {
        spawn_points?: Array<{ classname: string; origin: number[] }>;
      }).spawn_points ?? [];
      dom.spawnSelect.innerHTML = spawnPoints
        .map(
          (sp, i) =>
            `<option value="${i}">${i}: ${sp.classname} (${sp.origin.map((n) => n.toFixed(0)).join(',')})</option>`,
        )
        .join('');
      dom.spawnSelect.disabled = false;
    }
    if (dom.respawnBtn) dom.respawnBtn.disabled = false;
    // 加载完成：进度冲到 100 后隐藏（面板状态机：场景就绪 → 面板隐藏，等待锁定）
    finishLoading();
    panel?.updateVisibility(true);
  } catch (err) {
    const msg = `BSP 解析失败: ${err instanceof Error ? err.message : String(err)}`;
    setError(msg);
    renderer.disposeScene(); panel?.updateVisibility(sceneReady); // 加载失败：面板状态机复位（否则 M/ESC 一直被屏蔽）
    failLoading(msg);
  }
}

/** X 键存点：采样当前完整状态（位置/朝向/速度/着地）入列表并持久化。 */
function savePoint(): void {
  if (!sceneReady || !renderer) return;
  const s = renderer.getFullState();
  const point: SavePoint = { ...s, t: performance.now() };
  const list = savePointStore.add(point);
  panel?.renderSavePoints(list);
  setStatus(`已存点（${list.length}/${SAVEPOINT_MAX}） @ (${s.x.toFixed(0)}, ${s.y.toFixed(0)}, ${s.z.toFixed(0)})`, 'success');
}

/** C 键按住：定在最近存点（每帧冻结——位置/朝向=存点、速度=0；空中悬停/地面站定）。 */
function startHoldPoint(): void {
  if (!sceneReady || !renderer) return;
  const sp = savePointStore.latest();
  if (!sp) {
    setStatus('无存点（X 键可存点）', 'error');
    return;
  }
  holdPoint = sp;
  renderer.setHoldPoint(sp);
  setStatus('已定在存点（松开 C 恢复速度）', 'success');
}

/** C 键松开：解除冻结并恢复存点速度（主线程 + 权威同步）。 */
function endHoldPoint(): void {
  if (!holdPoint || !renderer) return;
  renderer.releaseHoldPoint(holdPoint);
  holdPoint = null;
  setStatus('已恢复存点速度', 'success');
}

function syncFullConfig(): void {
  if (!bridge || !configSync) return;
  // V8/P2：锁定模式下强制 tickRate=64（防面板/外部消息绕过）——保留在 sync 前（旧行为）
  if (config.lockTickRate) {
    config.physics.tickRate = LOCKED_TICK_RATE;
  }
  // 段顺序/下发由 createConfigSync 保证（P5）：4 段，bridge.sendConfig 内部展开全量参数并做预测镜像。
  configSync.syncConfig();
}

/** 权威健康消息缓冲（面板「权威健康」控制台；最新在顶，限 30 条）。 */
const healthLogLines: string[] = [];
function pushHealthLog(message: string): void {
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  healthLogLines.unshift(`[${now}] ${message}`);
  if (healthLogLines.length > 30) healthLogLines.length = 30;
  const el = document.getElementById('health-log');
  if (el) el.textContent = healthLogLines.join('\n');
  const cnt = document.getElementById('health-count');
  if (cnt) cnt.textContent = String(healthLogLines.length);
}
const healthClearBtn = document.getElementById('health-clear');
healthClearBtn?.addEventListener('click', () => {
  healthLogLines.length = 0;
  const el = document.getElementById('health-log');
  if (el) el.textContent = '（无消息）';
  const cnt = document.getElementById('health-count');
  if (cnt) cnt.textContent = '0';
});
function setStatus(msg: string, cls: 'success' | 'error' | ''): void {
  if (dom.statusEl) {
    dom.statusEl.textContent = msg;
    dom.statusEl.className = cls ? `status ${cls}` : 'status';
  }
}

// ---------------------------------------------------------------------------
// 地图加载进度覆盖层
// ---------------------------------------------------------------------------

/** 加载过程阶段 → 进度百分比（解析/导出占大头；GLB 加载与物理构建收尾）。 */
const LOAD_STAGE_PCT: Record<string, number> = {
  '正在加载地图': 0,
  'WASM 解析中': 8,
  '解析出生点/传送点/PVS': 22,
  '导出碰撞体': 40,
  '导出 GLB（含 PAKFILE 模型）': 58,
  '构建渲染场景 (GLB)': 78,
  '构建物理世界': 92,
};

let loadingFillEl: HTMLElement | null = null;
let loadingStageEl: HTMLElement | null = null;
let loadingPctEl: HTMLElement | null = null;
let loadingSubEl: HTMLElement | null = null;
let loadingOverlayEl: HTMLElement | null = null;

/** 平滑补间：目标值 + 动画状态。 */
const loadingAnim = {
  /** 当前展示值（0-100，驱动补间）。 */
  current: 0,
  /** 目标值（最新阶段百分比）。 */
  target: 0,
  /** 阶段进行中的轻微漂移（伪不确定进度，避免视觉卡死）。 */
  drifting: false,
  raf: 0,
};

/** 缓存加载覆盖层 DOM（首次调用时）。 */
function ensureLoadingEls(): void {
  if (loadingOverlayEl) return;
  loadingOverlayEl = dom.loadingOverlay;
  loadingSubEl = dom.loadingSub;
  loadingFillEl = dom.loadingFill;
  loadingStageEl = dom.loadingStage;
  loadingPctEl = dom.loadingPct;
}

/** 停止补间动画（隐藏覆盖层时调用，防泄漏）。 */
function stopLoadingAnim(): void {
  if (loadingAnim.raf) cancelAnimationFrame(loadingAnim.raf);
  loadingAnim.raf = 0;
  loadingAnim.drifting = false;
}

/**
 * 逐帧推进进度条：朝 target 平滑接近；阶段切换(target 前进)后若目标不变，
 * 在阶段区间内做轻微漂移，营造"仍在处理"的感觉（默认共 ~4ms 采样自然推进）。
 */
function tickLoading(): void {
  loadingAnim.raf = 0;
  let cur = loadingAnim.current;
  const target = loadingAnim.target;
  // 朝目标平滑逼近（ease-out 手感；差距大时走得快）
  const diff = target - cur;
  if (Math.abs(diff) > 0.1) {
    cur += diff * (0.12 + 0.02 * Math.abs(diff));
    if (cur > 0.98 * target && cur < target) cur = target; // 收尾贴合，避免无限趋近
    loadingAnim.current = cur;
  } else if (loadingAnim.drifting) {
    // 阶段进行中的伪前进：在当前阶段区间内缓慢漂移（封顶到下一阶段前）
    cur = Math.min(cur + 0.15, Math.max(target, 0) + 2);
    loadingAnim.current = cur;
  }
  // 渲染
  const shown = Math.max(0, Math.min(100, cur));
  if (loadingFillEl) loadingFillEl.style.setProperty('--load-pct', `${shown}%`);
  if (loadingPctEl) loadingPctEl.textContent = `${Math.round(shown)}%`;
  // 只要还在展示且有动画需求就继续
  if (loadingOverlayEl?.classList.contains('show')) {
    loadingAnim.raf = requestAnimationFrame(tickLoading);
  }
}

/** 显示加载覆盖层（读取地图后退出面板，改为展示进度）。 */
function showLoading(mapName: string): void {
  ensureLoadingEls();
  stopLoadingAnim();
  loadingAnim.current = 0;
  loadingAnim.target = 0;
  if (loadingOverlayEl) {
    loadingOverlayEl.classList.add('show');
    // 清掉残留的错误态
    loadingOverlayEl.classList.remove('error');
  }
  // 进度条复位走 CSS 回落值（.load-fill width:var(--load-pct, 0%)）——清除自定义属性即回落 0%
  if (loadingFillEl) loadingFillEl.style.removeProperty('--load-pct');
  if (loadingStageEl) loadingStageEl.textContent = '初始化';
  if (loadingPctEl) loadingPctEl.textContent = '0%';
  if (loadingSubEl) loadingSubEl.textContent = mapName ? `加载 ${mapName}…` : '加载地图…';
  loadingAnim.raf = requestAnimationFrame(tickLoading);
}

/** 更新进度（阶段名 + 目标百分比；实际展示经补间平滑）。 */
function updateLoadingProgress(stage: string, pct: number): void {
  ensureLoadingEls();
  loadingAnim.target = Math.max(0, Math.min(100, pct));
  loadingAnim.drifting = false;
  if (loadingStageEl) loadingStageEl.textContent = stage;
}

/** 按阶段名推进进度（映射到全局百分比；阶段名不识别时仅更新文字）。 */
function advanceLoading(stage: string): void {
  const pct = LOAD_STAGE_PCT[stage];
  if (pct !== undefined) {
    updateLoadingProgress(stage, pct);
    // 在阶段内做伪确定漂移，直到下个阶段到来（覆盖层动画循环里消费）
    // 仅在非最后一个已知阶段后允许漂移，避免 92→100 前乱漂
    loadingAnim.drifting = pct < 92;
  } else if (loadingStageEl) {
    loadingStageEl.textContent = stage;
  }
}

/** 加载完成：进度冲到 100 后延迟隐藏（给玩家收尾缓冲）。 */
function finishLoading(): void {
  ensureLoadingEls();
  loadingAnim.target = 100;
  loadingAnim.drifting = false;
  if (loadingStageEl) loadingStageEl.textContent = '完成';
  // 等补间贴近 100 再隐藏（约 250ms）
  window.setTimeout(() => hideLoading(), 260);
}

/** 加载失败：覆盖层转错误态并显示原因（不直接消失）。 */
function failLoading(message: string): void {
  ensureLoadingEls();
  stopLoadingAnim();
  if (loadingOverlayEl) loadingOverlayEl.classList.add('error');
  if (loadingStageEl) loadingStageEl.textContent = '加载失败';
  if (loadingSubEl) loadingSubEl.textContent = message;
  if (loadingFillEl) loadingFillEl.style.setProperty('--load-pct', '100%');
  if (loadingPctEl) loadingPctEl.textContent = '—';
}

/** 隐藏加载覆盖层（加载完成或失败）。 */
function hideLoading(): void {
  ensureLoadingEls();
  stopLoadingAnim();
  if (loadingOverlayEl) {
    loadingOverlayEl.classList.remove('show');
    loadingOverlayEl.classList.remove('error');
  }
}

function setError(msg: string): void {
  const el = document.getElementById('error') as HTMLElement | null;
  if (el) {
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
  }
  console.error(`[app] ${msg}`);
}

// ── 更多画面项（T-688）────────────────────────────────────────────────
// 控件来自共享规格表；game 只显示本页还没有的项（规格表里 apps 含 game 的那些）。
/** 面板写档后同步回 config：本页原生控件保存时是拿 \`config.lighting\` 整体覆盖，不同步会被旧值顶掉。 */
function mirrorRenderPrefToConfig(item: RenderPanelItem, value: RenderPanelValue): void {
  if (!item.pref) return;
  if (item.pref.startsWith('lighting.')) {
    (config.lighting as unknown as Record<string, unknown>)[item.pref.slice('lighting.'.length)] = value;
  }
}

/** 共享面板句柄（载图后调 sync() 刷新顶部「未载图」状态行）。 */
let renderPanelHandle: { sync: () => void } | null = null;

function setupRenderPanel(): void {
  const host = document.getElementById('renderPanel');
  if (!host) return;
  const api: RenderPanelApi = {
    app: 'game',
    hasMap: () => currentMapName !== '',
    read(item) {
      return item.pref ? readPrefsPath(readRenderPrefs(), item.pref) : 0;
    },
    write(item, value) {
      if (!item.pref) return; // game 不显示排查开关
      writeRenderPrefs(prefsPathPatch(item.pref, value));
      mirrorRenderPrefToConfig(item, value);
      applyRenderPrefs(readRenderPrefs());
    },
    reset(item) {
      if (!item.pref) return;
      const def = readPrefsPath(defaultRenderPrefs(), item.pref);
      writeRenderPrefs(prefsPathPatch(item.pref, def));
      mirrorRenderPrefToConfig(item, def);
      applyRenderPrefs(readRenderPrefs());
    },
    afterWrite(item) {
      if (item.apply !== 'live') {
        console.info('[render-panel] ' + item.label + '：' + (item.apply === 'reload' ? '刷新页面后生效' : '重新加载地图后生效'));
      }
      // **重载类改完自动重建地图**（owner 清单 P2-①）。整页刷新那类（apply === 'reload'）不自动做。
      if (item.apply === 'rebuild') scheduleMapReload();
    },
  };
  renderPanelHandle = buildRenderPanel(host, api);
}

setupRenderPanel();

void main();

// ── 关闭确认兜底（Ctrl+W 防误关）─────────────────────────────────────
// 浏览器不允许页面用 keydown preventDefault 拦截 Ctrl+W 这类浏览器快捷键，
// 但 beforeunload 可以：标签页关闭 / 刷新 / 离开前弹**原生确认框**（「离开页面？」，
// 文案由浏览器定、无法自定义；页面需先有过交互才弹——无激活时浏览器直接放行防滥用）。
// 误按「蹲 + 前进」关掉的页面在这里多一道反悔的机会；但**只在装了地图时拦**（T-056）——
// 空态（什么都没加载）的刷新 / 关闭本来就不丢东西，无条件拦只是噪音。
window.addEventListener('beforeunload', (e) => {
  if (!shouldConfirmClose({ hasMap: currentMapName !== '' })) return;
  e.preventDefault();
  e.returnValue = ''; // 触发确认框所必需（Chrome/Edge 约定）
});
