/**
 * WebSurf-min — 主线程入口。
 *
 * 架构（2026-08-07 v5 定案）：
 * - **唯一物理渲染主线 = 主线程**：主线程解析 BSP、构建 PhysWorld（世界+碰撞+输入）、
 *   每帧 tick 推进并渲染，全速无限制
 * - Worker = 纯速度修正器：无 WASM/无地图/无按键/无碰撞，只读主线程状态槽，
 *   位置差分算"实际移动速度"写回修正槽；主线程仅在卡墙/异常时校准
 * - ESC 弹出式面板（PanelController）+ 速度面板 8Hz
 */

import { createConfig, buildPhysicsParams } from './config.js';
import type { RuntimeConfig } from './config.js';
import { BspProcessor } from '../pkg/websurf_wasm.js';
import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { loadKeymap, type BindableAction } from './input/keymap.js';
import { MouseBuffer } from './input/mouse-buffer.js';
import { PointerLockController } from './input/pointer-lock.js';
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask, KEY_MASK } from './worker/shared-state.js';
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
  fpsEl: document.getElementById('fps') as HTMLElement | null,
  // 近平面贴墙自适应（实时生效）
  nearProbeDistRange: document.getElementById('nearProbeDist') as HTMLInputElement | null,
  nearProbeDistNum: document.getElementById('nearProbeDistNum') as HTMLInputElement | null,
  nearRatioRange: document.getElementById('nearRatio') as HTMLInputElement | null,
  nearRatioNum: document.getElementById('nearRatioNum') as HTMLInputElement | null,
} as const;

const keyboard = new KeyboardInput(loadKeymap());
// 面板改键入口：暴露 KeyboardInput 实例（setKeymap）
(globalThis as unknown as { __keyboardInput?: KeyboardInput }).__keyboardInput = keyboard;
export type { BindableAction };
const mouseBuffer = new MouseBuffer();
const pointerLock = new PointerLockController();

let fixWorker: Worker | null = null;
let bridge: InputBridge | null = null;
let renderer: RendererMain | null = null;
let panel: PanelController | null = null;
let sharedState: ReturnType<typeof createMainSharedState> | null = null;
let sceneReady = false;
/** 速度面板 8Hz 门控（0.125s）。 */
let speedUpdateAt = 0;
/** 滚轮跳 pending（wheel 事件置位，下一帧消费并清除；与根工程语义一致）。 */
let wheelJumpPending = false;

async function main(): Promise<void> {
  if (!dom.canvas) {
    console.error('[app] canvas#preview 未找到');
    return;
  }

  // 0. 通道选择：crossOriginIsolated（本地 serve.py COOP/COEP）→ SAB 高性能；
  //    否则（线上静态部署无 COOP/COEP）→ MsgState postMessage 回退（功能等价可玩）
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const canSab = isolated && typeof SharedArrayBuffer !== 'undefined';
  if (!canSab) {
    setStatus('兼容模式（无 SharedArrayBuffer）：功能可用，性能降级', '');
  }
  const sharedBuffer = canSab ? new SharedArrayBuffer(SHARED_BUFFER_SIZE) : null;

  // 1. 权威帧 Worker（加载地图碰撞、独立固定步长权威模拟，输出权威帧供渲染校准）
  fixWorker = new Worker('./worker.js', { type: 'module' });
  fixWorker.onerror = (e) => setError(`Worker error: ${e.message}`);
  fixWorker.onmessage = (e: MessageEvent<{ type?: string }>) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'error') {
      setError((msg as { message?: string }).message ?? 'Worker 错误');
    } else if (msg.type === 'phys-event') {
      // 权威碰撞事件（落地/撞墙）：位置微调 + 角度同步（权威仅碰撞时可影响渲染）
      const ev = msg as { kind: 'land' | 'blocked'; pos: number[]; yawDeg: number; pitchDeg: number };
      renderer?.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg);
    } else if (msg.type === 'phys-frame') {
      // MsgState 回退：Worker 权威帧消息 → 缓存（readAuthoritative 读取）
      const f = msg as { va: number; frame: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; vel: { x: number; y: number; z: number }; onGround: boolean; eyeHeight: number; timeMs: number } };
      (sharedState as { recvFrame?: (frame: unknown, va: number) => void })?.recvFrame?.(f.frame, f.va);
    }
  };
  fixWorker.postMessage({ type: 'init', shared: sharedBuffer });
  fixWorker.postMessage({ type: 'wasm-init', wasmUrl: './websurf_wasm_bg.wasm' });

  // 通道创建（SAB / MsgState 同接口）
  sharedState = createMainSharedState(sharedBuffer, fixWorker);
  const shared = sharedState;

  // 2. 渲染器 = 主线程唯一物理线（BSP 解析/物理/渲染全在主线程）
  renderer = new RendererMain(shared);
  renderer.onSceneLoaded = (deathY) => renderer?.setDeathY(deathY);
  // 兜底同步：渲染主线（144Hz 精度更高）→ 权威 Worker 反向校准；同步瞬间
  // 清双端未消费输入增量（Worker 侧由 sync-render-state 处理 resetInput）
  renderer.onSyncRenderState = (s) => {
    fixWorker?.postMessage({ type: 'sync-render-state', state: s });
  };
  renderer.init(dom.canvas!, dom.canvas.clientWidth, dom.canvas.clientHeight, window.devicePixelRatio, config);
  renderer.start();
  // 主线程 wasm 初始化（BspProcessor + PhysWorld 同模块）
  renderer.initPrediction('./websurf_wasm_bg.wasm').catch((err) => {
    setError(`主线程 WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 3. 桥（面板 → 双端物理：Worker 权威帧 + 主线程渲染物理，参数同参）
  bridge = new InputBridge(fixWorker, renderer, config);
  syncFullConfig();

  // 4. 面板（参数变更实时同步主线程物理）
  panel = new PanelController(
    config,
    bridge,
    () => pointerLock.isLocked(),
    (params) => renderer?.setPredictionParams(params),
    (hw, sh, dh) => renderer?.setPredictionHull(hw, sh, dh),
    (active) => renderer?.setPredictionNoclip(active),
  );

  // 5. 输入绑定
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
    // 灵敏度输入层应用：物理两端 sensitivity 固定 1，这里乘入角度增量后统一分发
    // （改灵敏度只改这个系数，双端物理用同一份已缩放输入 → 角度永不因灵敏度分叉）
    const sens = config.input.sensitivity;
    const CLAMP = 1000; // 与 MouseBuffer 一致的增量上限（乘灵敏度后可能超限，重新钳制）
    const dx = Math.max(-CLAMP, Math.min(CLAMP, r.dx * sens));
    const dy = Math.max(-CLAMP, Math.min(CLAMP, r.dy * sens));
    renderer?.feedInput(dx, dy, mask); // 主线程渲染物理输入（RendererMain.tick 同写 SAB 权威端）
  });

  dom.canvas.addEventListener('click', () => {
    if (!sceneReady || pointerLock.isLocked()) return;
    const p = pointerLock.requestLock(dom.canvas!);
    if (p instanceof Promise) {
      p.then((ok) => {
        if (!ok) setStatus('锁定失败，请再次点击画布（确保焦点在页面内）', 'error');
      });
    }
  });

  pointerLock.onLockChange((locked) => {
    mouseBuffer.onLockChange(locked);
    // 按键捕获门控：仅锁定时接受按键；退锁（ESC 打开面板）后忽略面板内按键
    keyboard.setEnabled(locked);
    keyboard.reset();
    // 清预测实例残留输入 + 权威 keysMask 归零（防 ESC 前最后输入/按住键残留）
    renderer?.clearPendingInput();
    bridge?.addInput(0, 0, 0);
    // 重锁时清滚轮跳 pending（面板期间滚动不产生跳跃）
    wheelJumpPending = false;
    // 面板状态机：锁定 → 隐藏；退锁（ESC）→ 弹出
    panel?.updateVisibility(sceneReady);
    if (locked) setStatus('已锁定。WASD 移动，鼠标视角，ESC 打开面板。', '');
  });

  window.addEventListener('resize', () => {
    if (dom.canvas) renderer?.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
  });

  window.addEventListener('blur', () => {
    keyboard.reset();
    // 页面失焦：立即清权威 keysMask + 预测输入（rAF 可能暂停，防 Worker 继续移动）
    bridge?.addInput(0, 0, 0);
    renderer?.clearPendingInput();
  });

  // 滚轮跳：wheel 事件置位，下一帧并入 jump（Rust apply_input 处理 0x100 位）。
  // 仅锁定时置位：面板打开时滚动面板不触发跳跃（否则改参数时角色乱跳）
  window.addEventListener('wheel', () => {
    if (pointerLock.isLocked()) wheelJumpPending = true;
  });

  // 加载地图按钮 → 触发隐藏 file input
  document.getElementById('loadMapBtn')?.addEventListener('click', () => {
    dom.fileInput?.click();
  });

  dom.fileInput?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !renderer) return;
    input.value = '';
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

/** 主线程 rAF 循环：按键 → SAB 输入槽 + 预测实例；渲染已在 RendererMain。 */
function startInputLoop(): void {
  let fpsFrames = 0;
  let fpsTime = 0;
  let lastQeMs = 0;
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    // FPS 显示（左上角，每秒刷新；不依赖场景就绪）
    fpsFrames++;
    if (now - fpsTime >= 1000) {
      if (dom.fpsEl) dom.fpsEl.textContent = `${fpsFrames} FPS`;
      fpsFrames = 0;
      fpsTime = now;
    }
    if (!bridge || !sceneReady) return;
    // 未锁定（面板打开）时强制输入为 0：面板内按键不进入物理（keyboard 已禁用，
    // 这里双保险防 ESC 前后按键状态残留）
    const mask = pointerLock.isLocked() ? keysToMask(keyboard.getState()) : 0;
    // 滚轮跳：仅锁定时并入本帧输入（消费一次即清）
    const maskWithWheel = pointerLock.isLocked() && wheelJumpPending ? mask | KEY_MASK.wheelJump : mask;
    wheelJumpPending = false;
    // Q/E 转向 → 等效鼠标增量（用户定调：按住时作用到鼠标的量上，但**独立增量**）：
    // 与真实鼠标同一输入通道（feedInput + SAB 累积，双端消费同源输入 →
    // 角度天然一致，无 Q/E 分叉）；旋转速度恒 = yawBindSpeed（固定角速度，
    // **不受灵敏度影响**——qeDx 不乘 sensitivity，物理两端 sensitivity 固定 1）
    const M_YAW = 0.022; // 与 Rust player.rs M_YAW 一致（度/像素）
    const dtF = lastQeMs === 0 ? 1 / 144 : Math.min((now - lastQeMs) / 1000, 0.1);
    lastQeMs = now;
    let qeDx = 0;
    if (maskWithWheel & KEY_MASK.yawLeft) qeDx -= (config.input.yawBindSpeed / M_YAW) * dtF;
    if (maskWithWheel & KEY_MASK.yawRight) qeDx += (config.input.yawBindSpeed / M_YAW) * dtF;
    if (qeDx !== 0) {
      qeDx = Math.max(-1000, Math.min(1000, qeDx)); // 上限防异常（yawBind 720 时单帧仅 ~227px，不触发）
    }
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
      ? `${lateral.toFixed(0)}`
      : mode === 'lateral-vertical'
        ? `${lateral.toFixed(0)}<span class="vsep">｜</span>${vertical.toFixed(0)}`
        : `${total.toFixed(0)}`;
  dom.statsEl.innerHTML = text;
}

/**
 * 主线程加载 BSP（唯一物理线：解析 + 渲染 + 构建物理世界全部在主线程）。
 * Worker 已不参与地图加载/解析。
 */
async function handleLoadBsp(fileName: string, bytes: ArrayBuffer): Promise<void> {
  if (!renderer) {
    setError('渲染器未就绪');
    return;
  }
  renderer.disposeScene();
  sceneReady = false;
  panel?.updateVisibility(false);
  setStatus(`正在加载 ${fileName}（主线程解析 BSP）...`, '');
  await new Promise((r) => setTimeout(r, 0)); // 让 UI 先更新（解析可能耗时）
  try {
    const proc = new BspProcessor(new Uint8Array(bytes));
    const meta = JSON.parse(proc.metadata()) as {
      map_name: string; num_faces: number; num_vertices: number;
      num_brushes: number; num_models: number;
    };

    // 导出顺序：借用方法（brush/tri/spawn/teleport/pvs）先于消费 BSP 的 export_glb
    const brushJson = proc.export_brushes_planes(
      JSON.stringify({
        include_ladder: true,
        include_solid: true,
        min_brush_volume: 0,
        skip_sky: true,
        skip_nodraw: false,
      }),
    );
    let triJson: string;
    try {
      triJson = proc.export_model_phy_colliders();
      if ((JSON.parse(triJson) as unknown[]).length === 0) {
        triJson = proc.export_model_tri_colliders();
      }
    } catch {
      try {
        triJson = proc.export_model_tri_colliders();
      } catch {
        triJson = '[]';
      }
    }
    const spawnJson = proc.parse_spawn_points();
    const teleportJson = proc.parse_teleports();
    const pvsJson = proc.parse_pvs_data();

    // spawn 解析（primary 出生点 + 全部列表）
    const spawnData = JSON.parse(spawnJson) as {
      spawn_points: Array<{ classname: string; origin: number[]; angles: number[] }>;
      primary?: number;
    };
    const spawnPoints = spawnData.spawn_points ?? [];
    const primaryIdx = (spawnData.primary ?? 0) >= 0 ? (spawnData.primary ?? 0) : 0;
    const primary = spawnPoints[primaryIdx] ?? spawnPoints[0];
    const bspYawToCsYaw = (yaw: number): number => ((270 - yaw) % 360 + 360) % 360;
    const spawn = primary
      ? {
          x: primary.origin[0], y: primary.origin[1], z: primary.origin[2],
          yawDeg: bspYawToCsYaw(primary.angles[1]),
        }
      : { x: 0, y: 100, z: 0, yawDeg: 0 };

    // GLB（消费 BSP，最后调用）
    let glbBytes: Uint8Array;
    try {
      glbBytes = proc.export_glb_with_pakfile_models();
    } catch {
      glbBytes = proc.export_glb();
    }
    const glbBuffer = glbBytes.buffer.slice(
      glbBytes.byteOffset,
      glbBytes.byteOffset + glbBytes.byteLength,
    );

    // 渲染场景（GLB + PVS + spawn）
    await renderer.loadScene({
      type: 'scene-data',
      glb: glbBuffer,
      spawnJson,
      pvsJson,
      metadata: {
        mapName: meta.map_name,
        numFaces: meta.num_faces,
        numVertices: meta.num_vertices,
        numBrushes: meta.num_brushes,
        numModels: meta.num_models,
      },
      spawn,
      glbSizeKb: Math.round(glbBuffer.byteLength / 1024),
      numSpawnPoints: spawnPoints.length,
      hasPvs: pvsJson.length > 2,
    });

    // 主线程物理世界（渲染线）
    renderer.buildPredictionWorld({
      brushJson,
      triJson: triJson ?? '[]',
      teleportJson,
      spawn,
    });
    // Worker 权威物理世界（地图碰撞；独立 64Hz 权威帧计算）
    fixWorker?.postMessage({
      type: 'world-json',
      brushJson,
      triJson: triJson ?? '[]',
      teleportJson,
      spawn,
    });
    // 出生点列表（spawn 下拉切换用）：主线程渲染物理 + Worker 权威物理**双端**
    // 都要设置——否则权威侧 teleport_to_spawn 索引为空静默忽略，权威帧
    // >200 兜底会把传送点拉回（"一瞬间传送过去又被拉回"根因）
    const spawnList: Array<[number, number, number, number]> = spawnPoints.map((sp) => [
      sp.origin[0], sp.origin[1], sp.origin[2], bspYawToCsYaw(sp.angles[1]),
    ]);
    renderer.setSpawnPoints(spawnList);
    fixWorker?.postMessage({ type: 'set-spawn-points', json: JSON.stringify(spawnList) });
    // 双端参数同步（Worker 权威 + 主线程渲染物理；含灵敏度，防操作分叉）
    syncFullConfig();

    sceneReady = true;
    setStatus(
      `场景已加载（GLB ${Math.round(glbBuffer.byteLength / 1024)} KB，${meta.num_brushes} brushes，` +
        `${spawnPoints.length} 出生点）`,
      'success',
    );
    // 出生点下拉
    if (dom.spawnSelect) {
      dom.spawnSelect.innerHTML = spawnPoints
        .map(
          (sp, i) =>
            `<option value="${i}">${i}: ${sp.classname} (${sp.origin.map((n) => n.toFixed(0)).join(',')})</option>`,
        )
        .join('');
      dom.spawnSelect.disabled = false;
    }
    if (dom.respawnBtn) dom.respawnBtn.disabled = false;
    // 面板状态机：场景就绪 → 面板隐藏（等待锁定）
    panel?.updateVisibility(true);
  } catch (err) {
    setError(`BSP 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    renderer.disposeScene();
  }
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
