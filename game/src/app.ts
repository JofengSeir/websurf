/**
 * WebSurf-game — 主线程入口。
 *
 * 架构（2026-08-07 v5 定案）：
 * - **唯一物理渲染主线 = 主线程**：主线程解析 BSP、构建 PhysWorld（世界+碰撞+输入）、
 *   每帧 tick 推进并渲染，全速无限制
 * - Worker = 纯速度修正器：无 WASM/无地图/无按键/无碰撞，只读主线程状态槽，
 *   位置差分算"实际移动速度"写回修正槽；主线程仅在卡墙/异常时校准
 * - ESC 弹出式面板（PanelController）+ 速度面板 8Hz
 */

import { createConfig } from './config.js';
import type { RuntimeConfig } from './config.js';
import { BspProcessor, decompress_mtz } from '../pkg/websurf_wasm.js';
import { InputBridge } from './input/input-bridge.js';
import { KeyboardInput } from './input/keyboard.js';
import { loadKeymap, type BindableAction } from './input/keymap.js';
import { MouseBuffer } from './input/mouse-buffer.js';
import { PointerLockController } from './input/pointer-lock.js';
import { createMainSharedState, SHARED_BUFFER_SIZE, keysToMask, KEY_MASK } from '../../src/ts-shared/auth/shared-state.js';
import { layerMouseDelta, qeEquivalentDx } from '../../src/ts-shared/input/input-layer.js';
import { buildWorldBundle } from '../../src/ts-shared/phys/world-builder.js';
import { RendererMain } from './renderer/renderer-main.js';
import { PanelController } from './panel/panel-controller.js';
import { SavePointStore, SAVEPOINT_MAX, type SavePoint } from './savepoint.js';

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
  // 地图加载进度覆盖层
  loadingOverlay: document.getElementById('loadingOverlay') as HTMLElement | null,
  loadingSub: document.getElementById('loadingSub') as HTMLElement | null,
  loadingFill: document.getElementById('loadingFill') as HTMLElement | null,
  loadingStage: document.getElementById('loadingStage') as HTMLElement | null,
  loadingPct: document.getElementById('loadingPct') as HTMLElement | null,
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
/** 主线程 wasm 初始化 promise（handleLoadBsp 的 decompress_mtz 依赖就绪）。 */
let mainWasmReady: Promise<void> = Promise.resolve();
/** 速度面板 8Hz 门控（0.125s）。 */
let speedUpdateAt = 0;
/** 滚轮跳 pending（wheel 事件置位，下一帧消费并清除；与根工程语义一致）。 */
let wheelJumpPending = false;
/** 当前地图名（去掉 .bsp 后缀；存点按地图持久化）。 */
let currentMapName = '';
/** 存点存储（X 存点 / C 读点 / 面板列表；按地图持久化，上限 50）。 */
const savePointStore = new SavePointStore();
/** 按住 C 冻结中的存点（非空 = 冻结中，keyup 时恢复速度）。 */
let holdPoint: SavePoint | null = null;

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
  //    dist 内嵌模式（file:// 双击）：worker 代码内嵌 → Blob URL（module worker 在
  //    file:// 下被 CORS 拦截）；dev 模式用 module worker（./worker.js）
  const embeddedWorkerJs = (globalThis as { __VBSP_WORKER_JS__?: string }).__VBSP_WORKER_JS__;
  fixWorker = embeddedWorkerJs
    ? new Worker(URL.createObjectURL(new Blob([embeddedWorkerJs], { type: 'text/javascript' })))
    : new Worker('./worker.js', { type: 'module' });
  fixWorker.onerror = (e) => setError(`Worker error: ${e.message}`);
  fixWorker.onmessage = (e: MessageEvent<{ type?: string }>) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'error') {
      setError((msg as { message?: string }).message ?? 'Worker 错误');
    } else if (msg.type === 'phys-event') {
      // 权威碰撞事件（落地/撞墙）：位置微调 + 角度同步（权威仅碰撞时可影响渲染）
      const ev = msg as { kind: 'land' | 'blocked'; pos: number[]; yawDeg: number; pitchDeg: number; vel?: number[] };
      renderer?.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg, ev.vel);
    } else if (msg.type === 'phys-frame') {
      // MsgState 回退：Worker 权威帧消息 → 缓存（readAuthoritative 读取）
      const f = msg as { va: number; frame: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; vel: { x: number; y: number; z: number }; onGround: boolean; eyeHeight: number; timeMs: number } };
      (sharedState as { recvFrame?: (frame: unknown, va: number) => void })?.recvFrame?.(f.frame, f.va);
    }
  };
  fixWorker.postMessage({ type: 'init', shared: sharedBuffer });
  // wasm-init：dist 内嵌 base64 → initSync（file:// 无法 fetch）；dev → fetch URL
  const embeddedWasm = (globalThis as { __VBSP_WASM_B64__?: string }).__VBSP_WASM_B64__;
  if (embeddedWasm) {
    fixWorker.postMessage({ type: 'wasm-init', wasmB64: embeddedWasm });
  } else {
    fixWorker.postMessage({ type: 'wasm-init', wasmUrl: './websurf_wasm_bg.wasm' });
  }

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
  // 主线程 wasm 初始化（BspProcessor + PhysWorld 同模块；dist 内嵌 base64）。
  // 保存 promise：handleLoadBsp 的 decompress_mtz 依赖 wasm 就绪（await 防竞态）。
  mainWasmReady = renderer.initPrediction('./websurf_wasm_bg.wasm', embeddedWasm).catch((err) => {
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
    (quality) => void renderer?.applyTextureQuality(quality),
    (fov) => renderer?.setFov(fov),
    // 存点列表：删除（无确认）→ 存储更新 + 回刷列表
    (i) => {
      const list = savePointStore.delete(i);
      panel?.renderSavePoints(list);
    },
    // 存点列表：读取任意存点 → 恢复（主线程 + 权威同步）
    (i) => {
      const list = savePointStore.all();
      const sp = list[i];
      if (sp && renderer) {
        renderer.loadSavepoint(sp);
        setStatus(`已读点 #${i + 1} @ (${sp.x.toFixed(0)}, ${sp.y.toFixed(0)}, ${sp.z.toFixed(0)})`, 'success');
      }
    },
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
    const { dx, dy } = layerMouseDelta(r.dx, r.dy, config.input.sensitivity);
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
      ? `${lateral.toFixed(0)}`
      : mode === 'lateral-vertical'
        ? `${lateral.toFixed(0)}<span class="vsep">｜</span>${vertical.toFixed(0)}`
        : `${total.toFixed(0)}`;
  dom.statsEl.innerHTML = text;
}

/**
 * 主线程加载 BSP（唯一物理线：解析 + 渲染 + 构建物理世界全部在主线程）。
 * Worker 已不参与地图加载/解析。
 * 公共化：BspProcessor 导出管线收敛到 ts-shared buildWorldBundle（colliderSource
 * auto + 默认纹理包回退 + GLB 导出 + 出生点解析全部共享）。
 */
async function handleLoadBsp(fileName: string, bytes: ArrayBuffer): Promise<void> {
  if (!renderer) {
    setError('渲染器未就绪');
    return;
  }
  // 存点按地图持久化：记录地图名并加载该地图存点列表（换地图清空/载入）
  currentMapName = fileName.replace(/\.bsp$/i, '');
  savePointStore.load(currentMapName);
  panel?.renderSavePoints(savePointStore.all());
  // 读取地图后退出面板，改用加载进度覆盖层
  panel?.hide();
  // 主线程 wasm 就绪（decompress_mtz 依赖；失败则继续，回退降级为占位色）
  await mainWasmReady.catch(() => undefined);
  renderer.disposeScene();
  sceneReady = false;
  setStatus(`正在加载 ${fileName}（主线程解析 BSP）...`, '');
  showLoading(fileName);
  await new Promise((r) => setTimeout(r, 0)); // 让 UI 先更新（解析可能耗时）
  try {
    const bundle = await buildWorldBundle(new BspProcessor(new Uint8Array(bytes)), {
      decompressMtz: decompress_mtz,
      onProgress: (stage) => advanceLoading(stage),
    });

    // 渲染场景（GLB + PVS + spawn）
    advanceLoading('构建渲染场景 (GLB)');
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
      hasPvs: bundle.pvsJson.length > 2,
    });

    // 主线程物理世界（渲染线）
    advanceLoading('构建物理世界');
    renderer.buildPredictionWorld({
      brushJson: bundle.brushJson,
      triJson: bundle.triJson,
      teleportJson: bundle.teleportJson,
      spawn: bundle.spawn,
    });
    // Worker 权威物理世界（地图碰撞；独立固定步长权威帧计算）
    fixWorker?.postMessage({
      type: 'world-json',
      brushJson: bundle.brushJson,
      triJson: bundle.triJson,
      teleportJson: bundle.teleportJson,
      spawn: bundle.spawn,
    });
    // 出生点列表（spawn 下拉切换用）：主线程渲染物理 + Worker 权威物理**双端**
    // 都要设置——否则权威侧 teleport_to_spawn 索引为空静默忽略，权威帧
    // >200 兜底会把传送点拉回（"一瞬间传送过去又被拉回"根因）
    renderer.setSpawnPoints(bundle.spawnList);
    fixWorker?.postMessage({ type: 'set-spawn-points', json: JSON.stringify(bundle.spawnList) });
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
    renderer.disposeScene();
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

function syncFullConfig(): void {  if (!bridge) return;
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
  if (loadingFillEl) loadingFillEl.style.width = `${shown}%`;
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
    // 清掉可能的错误态
    loadingOverlayEl.classList.remove('error');
  }
  if (loadingFillEl) loadingFillEl.style.width = '0%';
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
  if (loadingFillEl) loadingFillEl.style.width = '100%';
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
    el.style.display = msg ? 'block' : 'none';
  }
  console.error(`[app] ${msg}`);
}

void main();
