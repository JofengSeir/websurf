/**
 * Worker-A（权威物理）入口 — 最小化版。
 *
 * 职责：
 * 1. wasm-init：加载 WASM（dist base64 / dev URL），实例化 BspProcessor + PhysWorld
 * 2. load-bsp：Worker 内解析 BSP → 导出 GLB/spawn/pvs 传主线程 + build_world 构建物理世界
 * 3. 60Hz 自驱物理循环：Atomics.wait(16ms 超时兜底) → CAS 消耗输入槽 → wasm tick → 写权威区 + V_A++
 * 4. config/respawn/teleport/set-death-threshold 消息处理
 */

/// <reference lib="webworker" />

import { PhysWorld, BspProcessor, default as wasmInit } from '../../pkg/websurf_wasm.js';
import { createWorkerSharedState, type ShmState } from './shared-state.js';
import type { WorkerMessage, MainMessage } from './worker-types.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';

/** 固定步长（默认 64Hz；config.tickRate 覆盖）。 */
let fixedDt = 1 / 64;
/** 每帧最多固定步数（低帧率保护）。 */
const MAX_FIXED_STEPS = 10;
/** 防穿墙：单 tick 输入增量上限（随步长缩放，tickRate 快则每步上限同比缩小）。 */
const MAX_INPUT_PER_STEP_BASE = 1200; // 每 1/64s 的 yaw 增量上限（度）

/** WASM 初始化参数（常规打包：wasmUrl 相对 worker.js）。 */
interface WasmInitPayload {
  type: 'wasm-init';
  wasmUrl?: string;
}

let phys: PhysWorld | null = null;
let shared: ShmState | null = null;
let config: RuntimeConfig = createConfig();
let sceneReady = false;
/** 权威版本号（本地递增用）。 */
let seqCounter = 0;
/** FPS 统计。 */
let fpsCount = 0;
let fpsWallStart = 0;
/** wasm 初始化状态（对齐主项目：wasm-init 前消息入队，就绪后按序重放）。 */
let wasmReady = false;
let initStarted = false;
const pending: MessageEvent[] = [];

/** WASM 初始化（消息驱动）：fetch wasmUrl（相对 worker.js）→ init。 */
async function startWasm(msg: WasmInitPayload): Promise<void> {
  // 常规打包：wasm 外置文件，worker 内 fetch 相对自身 URL 加载（dist/ 与 web/ 同构）
  if (!msg.wasmUrl) {
    throw new Error('wasm-init 消息缺少 wasmUrl');
  }
  const resp = await fetch(msg.wasmUrl);
  const buf = await resp.arrayBuffer();
  await wasmInit(buf);
  wasmReady = true;
  // 按序重放此前缓存的消息（含 init：创建 shared）
  for (const ev of pending) dispatch(ev);
  pending.length = 0;
  // 启动 60Hz 自驱物理循环
  runLoop();
}

/** 分发消息：首个 init 消息注入共享内存。 */
function dispatch(e: MessageEvent): void {
  const msg = e.data as { type?: string } | null;
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  if (type === 'init') {
    const init = msg as { shared: SharedArrayBuffer | null };
    if (init.shared) shared = createWorkerSharedState(init.shared);
    return;
  }
  if (type === 'load-bsp') {
    const lb = msg as { name: string; data: ArrayBuffer };
    void handleLoadBsp(lb.data, lb.name);
    return;
  }
  if (type === 'config') {
    const cm = msg as { section: keyof RuntimeConfig; patch: Record<string, unknown> };
    applyConfigPatch(config, cm.section, cm.patch);
    if (cm.section === 'physics') {
      syncParamsToWasm();
      // noclip 模式切换 → Rust set_noclip（noclip 下禁物理/传送）
      if (typeof cm.patch.mode === 'string' && phys) {
        phys.set_noclip(cm.patch.mode === 'noclip');
      }
    }
    return;
  }
  if (type === 'respawn') {
    phys?.respawn();
    return;
  }
  if (type === 'teleport') {
    // 传送到指定出生点索引（spawn 下拉）；Rust 侧按索引查表
    const tm = msg as { target?: number };
    if (typeof tm.target === 'number') {
      phys?.teleport_to_spawn(tm.target);
    }
    return;
  }
  if (type === 'set-death-threshold') {
    const dm = msg as { value: number };
    phys?.set_death_y(dm.value);
    return;
  }
}

/** 60Hz 自驱循环：Atomics.wait 16ms 超时兜底（notify 仅加速），无需主线程 frame 信号。 */
function runLoop(): void {
  let lastT = performance.now();
  // 固定时间步累积器（防高刷丢时间：dt<fixedDt 时残留累加，物理时间守恒）
  let acc = 0;
  const loop = (): void => {
    try {
      if (!shared || !sceneReady) {
        setTimeout(loop, 16);
        return;
      }
      // 热待机：等待 notify 或 16ms 超时（自驱节奏）
      const now = performance.now();
      const dt = Math.min((now - lastT) / 1000, 0.1);
      lastT = now;

      // 固定步长推进：累积器模式（144Hz 下 dt≈7ms < fixedDt，累积到整步再推进）
      acc += dt;
      let steps = 0;
      while (acc >= fixedDt && steps < MAX_FIXED_STEPS) {
        acc -= fixedDt;
        stepPhysics(fixedDt);
        steps++;
      }
      // 每帧都写权威快照（steps=0 时物理未推进，也写基准帧供渲染插值）
      writeFrame(now);
      setTimeout(loop, 16);
    } catch (err) {
      // Worker 循环异常上报（避免静默死亡，便于浏览器控制台排查）
      postMessage({
        type: 'error',
        message: `[runLoop] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      } satisfies MainMessage);
    }
  };
  setTimeout(loop, 16);
}

/** 单个固定步长物理。 */
function stepPhysics(dt: number): void {
  if (!shared || !phys) return;
  // CAS 安全消耗输入（maxStep 防穿墙，随步长缩放）
  const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
  const input = shared.takeInput(maxStep);
  const keys = input.keysMask;
  const dx = input.dx;
  const dy = input.dy;
  phys.tick(dt, keys, dx, dy);
}

/** 写权威状态到 SAB + 递增 V_A。 */
function writeFrame(timeMs: number): void {
  if (!shared || !phys) return;
  const s = phys.state() as {
    posX: number; posY: number; posZ: number;
    yaw: number; pitch: number;
    velX: number; velY: number; velZ: number;
    onGround: boolean; eyeHeight: number;
  };
  seqCounter++;
  const va = shared.writeAuthoritative(
    {
      pos: { x: s.posX, y: s.posY, z: s.posZ },
      yaw: s.yaw,
      pitch: s.pitch,
      vel: { x: s.velX, y: s.velY, z: s.velZ },
      onGround: s.onGround,
      eyeHeight: s.eyeHeight,
      timeMs,
    },
    s.eyeHeight,
    s.onGround,
  );
  void va;
  // FPS 统计（0.5s 墙钟窗口）
  fpsCount++;
  if (fpsWallStart === 0) fpsWallStart = performance.now();
  if (performance.now() - fpsWallStart >= 500) {
    const fps = Math.round((fpsCount * 1000) / (performance.now() - fpsWallStart));
    fpsCount = 0;
    fpsWallStart = performance.now();
    if (phys) {
      const st = phys.state() as {
        posX: number; posY: number; posZ: number;
        velX: number; velY: number; velZ: number;
        onGround: boolean;
      };
      const speed = Math.hypot(st.velX, st.velZ);
      postMessage({
        type: 'stats',
        fps,
        speed,
        speedY: Math.abs(st.velY),
        speedTotal: Math.hypot(st.velX, st.velY, st.velZ),
        onGround: st.onGround,
      } satisfies MainMessage);
    }
  }
}

/** load-bsp：解析 + 导出 + 构建物理世界 + scene-data 传主线程。 */
async function handleLoadBsp(data: ArrayBuffer, _name: string): Promise<void> {
  try {
    postMessage({ type: 'parse-progress', stage: 'WASM 解析中' } as never);
    const bytes = new Uint8Array(data);
    const processor = new BspProcessor(bytes);

    const meta = JSON.parse(processor.metadata()) as {
      map_name: string; num_faces: number; num_vertices: number;
      num_brushes: number; num_models: number;
    };
    postMessage({
      type: 'bsp-metadata',
      metadata: {
        map_name: meta.map_name,
        num_faces: meta.num_faces,
        num_vertices: meta.num_vertices,
        num_brushes: meta.num_brushes,
        num_models: meta.num_models,
      },
    } satisfies MainMessage);

    // 导出顺序：借用方法（brush/tri/spawn/teleport/pvs）先于消费 BSP 的 export_glb
    postMessage({ type: 'parse-progress', stage: '导出碰撞体' } as never);
    const brushJson = processor.export_brushes_planes(
      JSON.stringify({
        include_ladder: true,
        include_solid: true,
        min_brush_volume: 0,
        skip_sky: true,
        skip_nodraw: false,
      }),
    );
    let triJson: string | undefined;
    try {
      triJson = processor.export_model_phy_colliders();
      if (!triJson || (JSON.parse(triJson) as unknown[]).length === 0) {
        triJson = processor.export_model_tri_colliders();
      }
    } catch {
      try {
        triJson = processor.export_model_tri_colliders();
      } catch {
        triJson = '[]';
      }
    }

    const spawnJson = processor.parse_spawn_points();
    const teleportJson = processor.parse_teleports();
    postMessage({ type: 'parse-progress', stage: '导出 PVS' } as never);
    const pvsJson = processor.parse_pvs_data();

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
    postMessage({ type: 'parse-progress', stage: '导出 GLB' } as never);
    let glbBytes: Uint8Array;
    try {
      glbBytes = processor.export_glb_with_pakfile_models();
    } catch {
      glbBytes = processor.export_glb();
    }
    const glbBuffer = glbBytes.buffer.slice(
      glbBytes.byteOffset,
      glbBytes.byteOffset + glbBytes.byteLength,
    );

    // 构建物理世界（brush/tri/teleport/spawn）
    phys = new PhysWorld();
    phys.build_world(
      brushJson,
      triJson ?? '[]',
      teleportJson,
      spawn.x,
      spawn.y,
      spawn.z,
      spawn.yawDeg,
    );
    // 出生点列表（spawn 下拉切换用）：[[x,y,z,yaw], ...]
    phys.set_spawn_points(
      JSON.stringify(
        spawnPoints.map((sp) => [sp.origin[0], sp.origin[1], sp.origin[2], bspYawToCsYaw(sp.angles[1])]),
      ),
    );
    // 同步面板参数
    syncParamsToWasm();

    // scene-data 一次 transfer（GLB + spawn/pvs 小 JSON，无 brush/tri/teleport 大 JSON）
    const sceneData = {
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
      hasPvs: true,
    };
    postMessage(sceneData, [glbBuffer] as never);

    // 世界 JSON 转发（Worker-B 构建预测世界；加载时一次，非 64Hz 热路径）
    postMessage({
      type: 'world-json',
      brushJson,
      triJson: triJson ?? '[]',
      teleportJson,
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z, yawDeg: spawn.yawDeg },
    } satisfies MainMessage);

    sceneReady = true;
    postMessage({ type: 'parse-progress', stage: '物理世界就绪' } as never);
  } catch (err) {
    postMessage({
      type: 'error',
      message: `[load-bsp] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    } satisfies MainMessage);
  }
}

/** 面板参数 → wasm set_params（tickRate 单独处理驱动步长）。 */
function syncParamsToWasm(): void {
  if (!phys) return;
  const p = config.physics;
  phys.set_params(
    JSON.stringify({
      gravity: p.gravity,
      accelerate: p.accelerate,
      friction: p.friction,
      stop_speed: p.stopSpeed,
      jump_height: p.jumpSpeed * p.jumpSpeed / (2 * p.gravity),
      air_accelerate: p.airAccel,
      run_speed: p.maxSpeed,
      walk_speed: p.walkSpeed,
      crouch_speed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhop_speed_clamp: p.bhopSpeedClamp,
      no_prestrafe: p.noPrestrafe,
      sensitivity: config.input.sensitivity,
      yaw_bind_speed: config.input.yawBindSpeed,
      noclip_speed: config.input.noclipSpeed,
      teleport_gate_ticks: p.teleportGateTicks,
    }),
  );
  const pl = config.player;
  phys.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
  fixedDt = 1 / Math.max(p.tickRate, 1);
}

self.onmessage = (e: MessageEvent<WorkerMessage | { type: string }>) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  const type = (msg as { type: string }).type;
  // wasm-init：触发 WASM 初始化（仅首次；就绪后重放队列并启动物理循环）
  if (type === 'wasm-init') {
    if (initStarted) return;
    initStarted = true;
    void (async () => {
      try {
        await startWasm(msg as unknown as WasmInitPayload);
        postMessage({ type: 'ready' } satisfies MainMessage);
      } catch (err) {
        postMessage({
          type: 'error',
          message: `[wasm-init] ${err instanceof Error ? err.stack : String(err)}`,
        } satisfies MainMessage);
      }
    })();
    return;
  }
  // wasm 未就绪：消息入队（含 init），就绪后按序重放
  if (!wasmReady) {
    pending.push(e);
    return;
  }
  dispatch(e);
};
