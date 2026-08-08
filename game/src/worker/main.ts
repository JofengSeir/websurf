/**
 * Worker — 权威帧计算器（v7 定案）。
 *
 * 架构（用户核心思想）：
 * - **Worker 加载地图物理碰撞**（world-json 一次性构建 PhysWorld），
 *   独立模拟**权威物理线**（固定 64Hz tick，含碰撞/摩擦/重力），
 *   每 tick 输出**权威帧**（位置/朝向/速度/眼高/着地/时间戳）
 * - 主线程是渲染预测线（全速物理+渲染），每帧读权威帧，
 *   用权威速度（考虑中途地图碰撞后的正确速度）外推校准渲染物理
 * - 输入：主线程写 SAB 输入槽（keys/dx/dy），本 Worker takeInput 消费
 *   （权威帧模拟需要同输入）；不反写位置，不渲染
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import { createWorkerSharedState, type ShmState, type MsgState } from './shared-state.js';
import type { WorkerMessage } from './worker-types.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';

/** 权威固定步长（默认 64Hz；config.physics.tickRate 动态覆盖——面板改 tickRate 即时生效）。 */
let fixedDt = 1 / 64;
/** 防穿墙：单 tick 输入增量上限。 */
const MAX_INPUT_PER_STEP_BASE = 1200; // 每 1/64s 的 yaw 增量上限（度）

let shared: ShmState | MsgState | null = null;
let phys: PhysWorld | null = null;
let ready = false;
let loopStarted = false;
let config: RuntimeConfig = createConfig();
/** 累积器：真实墙钟 → 固定步长推进（不设上限，低帧率不丢物理时间）。 */
let acc = 0;
let lastWall = 0;

/** 主循环：墙钟驱动固定步长权威 tick。 */
function loop(): void {
  setTimeout(loop, 4); // 250Hz 轮询（> 最大 tick 率，满足固定步长累积）
  if (!shared || !phys) return;
  const now = performance.now();
  if (lastWall === 0) {
    lastWall = now;
    return;
  }
  acc += (now - lastWall) / 1000;
  lastWall = now;
  // 固定步长推进（不设上限：低帧率补足全部欠步）
  let guard = 0;
  while (acc >= fixedDt && guard < 64) {
    acc -= fixedDt;
    stepPhysics(fixedDt);
    guard++;
  }
}

/** 单个权威步长：消费输入 → 完整物理 tick（含碰撞）→ 写权威帧。 */
let prevOnGround = false;
let prevSpeed = 0;
let prevOrigin: [number, number, number] | null = null;
function stepPhysics(dt: number): void {
  if (!shared || !phys) return;
  const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
  const input = shared.takeInput(maxStep);
  // 碰撞事件检测基准（tick 前）
  const before = phys.state() as {
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean;
  };
  prevOnGround = before.onGround;
  prevSpeed = Math.hypot(before.velX, before.velY, before.velZ);
  prevOrigin = [before.posX, before.posY, before.posZ];

  phys.tick(dt, input.keysMask, input.dx, input.dy);
  const s = phys.state() as {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean; eyeHeight: number;
  };
  shared.writeAuthoritative(
    {
      pos: { x: s.posX, y: s.posY, z: s.posZ },
      yaw: s.yaw,
      pitch: s.pitch,
      vel: { x: s.velX, y: s.velY, z: s.velZ },
      eyeHeight: s.eyeHeight,
      timeMs: performance.now(),
    },
    s.onGround,
  );

  // 权威碰撞事件（低频，postMessage 回传主线程做位置微调 + 角度同步）：
  // - land：onGround 上升沿（权威真实落地点；渲染侧相位差可能差几 units）
  // - blocked：撞墙/被阻——速度骤降（>250 u/s）且实际位移远小于速度对应位移
  if (!prevOnGround && s.onGround) {
    postMessage({
      type: 'phys-event',
      kind: 'land',
      pos: [s.posX, s.posY, s.posZ],
      yawDeg: s.yaw,
      pitchDeg: s.pitch,
      timeMs: performance.now(),
    } satisfies import('./worker-types.js').MainMessage);
    return;
  }
  const curSpeed = Math.hypot(s.velX, s.velY, s.velZ);
  const moved = prevOrigin ? Math.hypot(s.posX - prevOrigin[0], s.posY - prevOrigin[1], s.posZ - prevOrigin[2]) : 0;
  const expectedMove = prevSpeed * dt;
  if (curSpeed > 80 && prevSpeed - curSpeed > 250 && moved < expectedMove * 0.3) {
    postMessage({
      type: 'phys-event',
      kind: 'blocked',
      pos: [s.posX, s.posY, s.posZ],
      yawDeg: s.yaw,
      pitchDeg: s.pitch,
      timeMs: performance.now(),
    } satisfies import('./worker-types.js').MainMessage);
  }
}

/** 面板参数 → wasm set_params（tickRate 由权威固定 64Hz 驱动）。 */
function syncParamsToWasm(): void {
  if (!phys) return;
  const p = config.physics;
  const params = {
    gravity: p.gravity,
    accelerate: p.accelerate,
    friction: p.friction,
    stop_speed: p.stopSpeed,
    jump_height: (p.jumpSpeed * p.jumpSpeed) / (2 * p.gravity),
    air_accelerate: p.airAccel,
    run_speed: p.maxSpeed,
    walk_speed: p.walkSpeed,
    crouch_speed: p.crouchSpeed,
    autobhop: p.autobhop,
    bhop_speed_clamp: p.bhopSpeedClamp,
    no_prestrafe: p.noPrestrafe,
    // 灵敏度固定 1：真实灵敏度由主线程输入层应用（mousemove 乘入角度增量），
    // 与主线程 buildPhysicsParams 一致——双端物理用同一份已缩放输入，角度永不分叉
    sensitivity: 1,
    yaw_bind_speed: config.input.yawBindSpeed,
    noclip_speed: config.input.noclipSpeed,
    teleport_gate_ticks: p.teleportGateTicks,
  };
  phys.set_params(JSON.stringify(params));
  const pl = config.player;
  phys.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
}

/** 消息分发。 */
function dispatch(e: MessageEvent<WorkerMessage | { type: string }>): void {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  if (type === 'init') {
    const init = msg as { shared?: SharedArrayBuffer | null };
    // shared 为 null（线上静态无 COOP/COEP）→ MsgState 消息回退通道
    shared = createWorkerSharedState(init.shared ?? null);
    return;
  }
  if (type === 'input') {
    // MsgState 回退：主线程每帧消息输入（SAB 模式无此消息）
    const d = msg as { dx?: number; dy?: number; keys?: number };
    if (shared && !shared.isShared) {
      shared.recvInput(d.dx ?? 0, d.dy ?? 0, d.keys ?? 0);
    }
    return;
  }
  if (type === 'wasm-init') {
    const m = msg as { wasmB64?: string; wasmUrl?: string };
    const initWasm = async (): Promise<void> => {
      // 注意：必须用 initSync({module})——async init() 解构的是 {module_or_path}，
      // 传 {module} 会解构出 undefined → 走 new URL(import.meta.url) 路径，
      // dist 下 import.meta.url 被 define 为 about:blank → "Failed to construct 'URL'"。
      if (m.wasmB64) {
        // dist 内嵌模式（file:// 双击）：base64 → initSync
        const bin = atob(m.wasmB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        initSync({ module: bytes.buffer as ArrayBuffer });
      } else if (m.wasmUrl) {
        const resp = await fetch(m.wasmUrl);
        const buf = await resp.arrayBuffer();
        initSync({ module: buf });
      } else {
        return;
      }
      ready = true;
      if (!loopStarted) {
        loopStarted = true;
        loop();
      }
    };
    initWasm().catch((err) => postMessage({ type: 'error', message: `Worker wasm 加载失败: ${err}` }));
    return;
  }
  if (type === 'world-json') {
    const w = msg as unknown as {
      brushJson: string;
      triJson: string;
      teleportJson: string;
      spawn: { x: number; y: number; z: number; yawDeg: number };
    };
    if (!ready) return; // wasm 未就绪则忽略（主线程 init 顺序保证 wasm 先行）
    const p = new PhysWorld();
    p.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
    phys = p;
    syncParamsToWasm();
    fixedDt = 1 / config.physics.tickRate; // 面板 tickRate 生效
    acc = 0;
    lastWall = 0;
    return;
  }
  if (type === 'config') {
    const c = msg as { section: keyof RuntimeConfig; patch: Record<string, unknown> };
    if (!phys) return;
    // 更新自身 config（v7 隐藏 bug 修复：之前从不应用 patch，权威一直用默认参数，
    // 面板改任何参数（含灵敏度）双端都分叉）
    applyConfigPatch(config, c.section, c.patch);
    // tickRate → 权威固定步长即时生效（面板 64↔128 切换真正改变物理采样率）
    if (c.section === 'physics' && typeof c.patch.tickRate === 'number') {
      fixedDt = 1 / config.physics.tickRate;
      acc = 0; // 清累积器，防新旧步长错配
    }
    if (c.section === 'player') {
      const pl = c.patch as { halfWidth?: number; standHeight?: number; duckHeight?: number };
      if (pl.halfWidth !== undefined && pl.standHeight !== undefined && pl.duckHeight !== undefined) {
        phys.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
      }
    } else {
      syncParamsToWasm();
    }
    // noclip 模式：与主线程渲染物理同步
    if (typeof (c.patch as { mode?: string }).mode === 'string') {
      phys.set_noclip((c.patch as { mode: string }).mode === 'noclip');
    }
    return;
  }
  if (type === 'respawn') {
    phys?.respawn();
    return;
  }
  if (type === 'sync-render-state') {
    // 渲染主线 → 权威同步（用户定调：渲染 144Hz 预测物理精度更高，大偏差时
    // 以渲染主线为准反向校准权威）。同步瞬间清空权威侧未消费输入增量，
    // 防止同步前的旧鼠标/按键残留注入新状态（键位保留——按住状态是实时的）。
    const sm = msg as {
      state?: {
        posX: number; posY: number; posZ: number;
        yaw: number; pitch: number;
        velX: number; velY: number; velZ: number;
        onGround: boolean;
      };
    };
    if (!phys || !sm.state) return;
    const s = sm.state;
    phys.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
    shared?.resetInput();
    return;
  }
  if (type === 'set-spawn-points') {
    // 权威物理出生点列表（spawn 下拉切换用；world-json 只设了初始 spawn，
    // 缺此列表时 teleport_to_spawn 索引为空 → 静默忽略 → 传送被权威帧拉回）
    const sm = msg as { json?: string };
    if (typeof sm.json === 'string' && phys) {
      phys.set_spawn_points(sm.json);
    }
    return;
  }
  if (type === 'teleport') {
    const tm = msg as { target?: number };
    if (typeof tm.target === 'number') {
      phys?.teleport_to_spawn(tm.target);
    }
    return;
  }
}

self.onmessage = dispatch;
