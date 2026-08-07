/**
 * WebSurf-min — 主线程入口。
 *
 * 架构（2026-08-07 简化）：
 * - Worker-A（权威物理，固定步长不设上限）：src/worker/main.ts
 *   只同步角度/速度/眼高/着地（位置不同步）
 * - 主线程渲染循环内做位置预测（速度积分外推，渲染帧 > 物理帧填补空隙）
 * - ESC 弹出式面板（PanelController）+ 速度面板 8Hz
 */

import { createConfig } from './config.js';
import type { RuntimeConfig } from './config.js';
import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { loadKeymap, type BindableAction } from './input/keymap.js';
import { MouseBuffer } from './input/mouse-buffer.js';
import { PointerLockController } from './input/pointer-lock.js';
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask } from './worker/shared-state.js';
import type { MainMessage, SceneDataMessage } from './worker/worker-types.js';
import { RendererMain } from './renderer/renderer-main.js';
import { PanelController } from './panel/panel-controller.js';

const config: RuntimeConfig = createConfig();

const dom = {
  canvas: document.getElementById('preview') as HTMLCanvasElement | null,
  fileInput: document.getElementById('bspFile') as HTMLInputElement | null,
  statusEl: document.getElementById('status') as HTMLElement | null,
  statsEl: document.getElementById('stats') as HTMLElement | null,
  spawnSelect: document.getElementById('spawnSelect') as HTMLSelectElement | null,
  respawnBtn: document.getElementById('respawnBtn') as HTMLButtonElement | null,
} as const;

const keyboard = new KeyboardInput(loadKeymap());
// 面板改键入口：暴露 KeyboardInput 实例（setKeymap）
(globalThis as unknown as { __keyboardInput?: KeyboardInput }).__keyboardInput = keyboard;
export type { BindableAction };
const mouseBuffer = new MouseBuffer();
const pointerLock = new PointerLockController();

let workerA: Worker | null = null;
let bridge: InputBridge | null = null;
let renderer: RendererMain | null = null;
let panel: PanelController | null = null;
let sharedState: ReturnType<typeof createMainSharedState> | null = null;
let sceneReady = false;
/** 速度面板 8Hz 门控（0.125s）。 */
let speedUpdateAt = 0;

async function main(): Promise<void> {
  if (!dom.canvas) {
    console.error('[app] canvas#preview 未找到');
    return;
  }

  // 0. SAB（crossOriginIsolated 强制：file:// 双击无法满足，需本地服务器）
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated || typeof SharedArrayBuffer === 'undefined') {
    // 无隔离环境：显示引导卡片（双击 dist 常见），不再静默退出
    const overlay = document.getElementById('fatalOverlay') as HTMLElement | null;
    if (overlay) overlay.classList.add('show');
    setStatus('需要 HTTP 服务器（file:// 无 SharedArrayBuffer）— 请双击 play.cmd', 'error');
    return;
  }
  const sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  sharedState = createMainSharedState(sharedBuffer);
  const shared = sharedState;

  // 1. Worker-A（权威）——常规文件 Worker（与 dev 同构；wasm 经相对 URL 加载）
  workerA = new Worker('./worker.js', { type: 'module' });
  workerA.onmessage = handleWorkerMessage;
  workerA.onerror = (e) => setError(`Worker error: ${e.message}`);
  // WASM 注入：相对 worker.js 的 URL（dist/ 与 web/ 均同目录放置 wasm）
  workerA.postMessage({ type: 'wasm-init', wasmUrl: './websurf_wasm_bg.wasm' });

  bridge = new InputBridge(workerA, shared);
  bridge.sendInit(sharedBuffer, dom.canvas.clientWidth, dom.canvas.clientHeight, window.devicePixelRatio);

  // 2. 渲染器（客户端预测：主线程持 wasm 预测实例，每帧物理模拟）
  renderer = new RendererMain(shared);
  renderer.onSceneLoaded = (deathY) => bridge?.sendSetDeathThreshold(deathY);
  renderer.init(dom.canvas!, dom.canvas.clientWidth, dom.canvas.clientHeight, window.devicePixelRatio, config);
  renderer.start();
  // 主线程 wasm 初始化（预测实例与 Worker-A 同模块、独立实例）
  renderer.initPrediction('./websurf_wasm_bg.wasm').catch((err) => {
    setError(`主线程 WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 3. 面板
  panel = new PanelController(
    config,
    bridge,
    () => pointerLock.isLocked(),
  );

  // 4. 输入绑定
  bindInput();
  startInputLoop();
}

function bindInput(): void {
  if (!dom.canvas) return;
  keyboard.bind(window);

  window.addEventListener('mousemove', (e) => {
    if (!pointerLock.isLocked()) return;
    const r = mouseBuffer.process(e.movementX, e.movementY);
    if (!r) return;
    const mask = keyboard.getMask();
    if (bridge) bridge.addInput(r.dx, r.dy, mask); // 权威通道（SAB）
    renderer?.feedInput(r.dx, r.dy, mask); // 预测实例通道（主线程物理模拟）
  });

  dom.canvas.addEventListener('click', () => {
    if (!sceneReady || pointerLock.isLocked()) return;
    void pointerLock.requestLock(dom.canvas!);
  });

  pointerLock.onLockChange((locked) => {
    mouseBuffer.onLockChange(locked);
    keyboard.reset();
    // 面板状态机：锁定 → 隐藏；退锁（ESC）→ 弹出
    panel?.updateVisibility(sceneReady);
    if (locked) setStatus('已锁定。WASD 移动，鼠标视角，ESC 打开面板。', '');
  });

  window.addEventListener('resize', () => {
    if (dom.canvas) renderer?.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
  });

  window.addEventListener('blur', () => keyboard.reset());

  // 加载地图按钮 → 触发隐藏 file input
  document.getElementById('loadMapBtn')?.addEventListener('click', () => {
    dom.fileInput?.click();
  });

  dom.fileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !bridge) return;
    renderer?.disposeScene();
    sceneReady = false;
    panel?.updateVisibility(false);
    setStatus(`正在加载 ${file.name}...`, '');
    bridge.sendLoadBsp(file.name, await file.arrayBuffer());
    input.value = '';
  });

  dom.respawnBtn?.addEventListener('click', () => bridge?.sendRespawn());
  dom.spawnSelect?.addEventListener('change', (e) => {
    const idx = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(idx)) bridge?.sendTeleport(idx);
  });
}

/** 主线程 rAF 循环：按键 → SAB 输入槽 + 预测实例；渲染已在 RendererMain。 */
function startInputLoop(): void {
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    if (!bridge || !sceneReady) return;
    const keys = keyboard.getState();
    const mask = keysToMask(keys);
    bridge.addInput(0, 0, mask);
    renderer?.feedInput(0, 0, mask); // 预测实例按键（鼠标增量已在 mousemove 喂入）
    // 速度面板 8Hz（0.125s）
    if (now - speedUpdateAt >= 125) {
      speedUpdateAt = now;
      updateSpeedHud();
    }
  };
  requestAnimationFrame(tick);
}

/** 速度面板：从三源决策结果（SAB 权威区）采样，8Hz 低频。纯数字无文字。 */
function updateSpeedHud(): void {
  if (!sharedState || !dom.statsEl) return;
  const auth = sharedState.readAuthoritative();
  if (!auth) return;
  const v = auth.state.vel;
  const lateral = Math.hypot(v.x, v.z);
  const vertical = Math.abs(v.y);
  const total = Math.hypot(v.x, v.y, v.z);
  const mode = config.hud.speedMode;
  const text =
    mode === 'lateral'
      ? `${lateral.toFixed(0)}`
      : mode === 'lateral-vertical'
        ? `${lateral.toFixed(0)}<span class="vsep">｜</span>${vertical.toFixed(0)}`
        : `${total.toFixed(0)}`;
  dom.statsEl.innerHTML = text;
}

function handleWorkerMessage(e: MessageEvent<MainMessage>): void {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ready':
      setStatus('Worker 就绪。请加载 .bsp 文件。', 'success');
      syncFullConfig();
      break;
    case 'bsp-metadata':
      break;
    case 'scene-data':
      void handleSceneData(msg);
      break;
    case 'world-json':
      // 主线程构建预测 PhysWorld（客户端预测物理模拟实例）
      renderer?.buildPredictionWorld({
        brushJson: msg.brushJson,
        triJson: msg.triJson,
        teleportJson: msg.teleportJson,
        spawn: msg.spawn,
      });
      break;
    case 'player-respawn': {
      // 位置突变事件（重生/传送/noclip 切换）：预测实例归零到权威新位置
      const r = msg as unknown as { pos: number[]; yawDeg: number };
      renderer?.resetTo(r.pos, r.yawDeg);
      break;
    }
    case 'stats':
      break; // HUD 精简：速度面板由主线程 8Hz 采样，不依赖 stats 消息
    case 'error':
      setError(msg.message);
      break;
    default:
      break;
  }
}

async function handleSceneData(msg: SceneDataMessage): Promise<void> {
  if (!renderer) {
    setError('渲染器未就绪');
    return;
  }
  await renderer.loadScene(msg);
  sceneReady = true;
  setStatus(
    `场景已加载（GLB ${msg.glbSizeKb} KB，${msg.metadata.numBrushes} brushes，` +
      `${msg.numSpawnPoints} 出生点）`,
    'success',
  );
  // 出生点下拉
  if (dom.spawnSelect) {
    try {
      const data = JSON.parse(msg.spawnJson) as {
        spawn_points: Array<{ classname: string; origin: number[] }>;
      };
      dom.spawnSelect.innerHTML = (data.spawn_points ?? [])
        .map(
          (sp, i) =>
            `<option value="${i}">${i}: ${sp.classname} (${sp.origin.map((n) => n.toFixed(0)).join(',')})</option>`,
        )
        .join('');
      dom.spawnSelect.disabled = false;
    } catch {
      // 忽略
    }
  }
  if (dom.respawnBtn) dom.respawnBtn.disabled = false;
  // 面板状态机：场景就绪 → 面板隐藏（等待锁定）
  panel?.updateVisibility(true);
}

function syncFullConfig(): void {
  if (!bridge) return;
  // V8/P2：锁定模式下强制 tickRate=64（防面板/外部消息绕过）
  if (config.lockTickRate) {
    config.physics.tickRate = 64;
  }
  const sections: Array<keyof RuntimeConfig> = ['physics', 'input', 'player', 'hud'];
  for (const section of sections) {
    bridge.sendConfig(section, config[section] as unknown as Record<string, unknown>);
  }
}

function setStatus(msg: string, cls: 'success' | 'error' | ''): void {
  if (dom.statusEl) {
    dom.statusEl.textContent = msg;
    dom.statusEl.className = cls ? `status ${cls}` : 'status';
  }
}

function setError(msg: string): void {
  const el = document.getElementById('error') as HTMLElement | null;
  if (el) {
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }
  console.error(`[app] ${msg}`);
}

void main();
