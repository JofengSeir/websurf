/**
 * Worker-B（预测预计算）入口 — 最小化版。
 *
 * 职责（时序图第三阶段）：
 * 1. 接收主线程下发的 BSP 数据 + wasm 模块，实例化独立 PhysWorld（同一 wasm 模块第二实例）
 * 2. Atomics.wait 热待机（仅 Worker 可 wait）
 * 3. 被主线程 notify 唤醒（权威就绪 → 基线更新）后：读输入槽 → 2 子步轻量 predict → 写 S_pred + 代际复合 seq
 * 4. noclip 模式下禁用（主线程通知）
 */

/// <reference lib="webworker" />

import { PhysWorld, default as wasmInit } from '../../pkg/websurf_wasm.js';
import { createWorkerSharedState, type ShmState } from './shared-state.js';

/** 预测固定步长（跟随权威 tickRate；主线程经消息更新）。 */
let predDt = 1 / 64;
/** 每轮预测子步数（时序图：2 子步）。 */
const PREDICT_STEPS = 2;
/** 预测序列号循环计数（代际复合低 16 位）。 */
let counter = 0;
/** 上次预测/基线同步时戳（V5 动态步长计算）。 */
let lastStepTs = 0;

let phys: PhysWorld | null = null;
let shared: ShmState | null = null;
let worldReady = false;
let wasmReady = false;
let disabled = false; // noclip 模式禁用预测

/** WASM 初始化（与 Worker-A 相同模式：fetch wasmUrl → init）。 */
async function startWasm(msg: { wasmUrl?: string }): Promise<void> {
  // 常规打包：wasm 外置文件，fetch 相对自身 URL（dist/ 与 web/ 同构）
  if (!msg.wasmUrl) {
    throw new Error('wasm-init 消息缺少 wasmUrl');
  }
  const resp = await fetch(msg.wasmUrl);
  const buf = await resp.arrayBuffer();
  await wasmInit(buf);
  wasmReady = true;
}

/** 构建世界（主线程转发 BSP 解析后的各 JSON + spawn；需 wasm 已初始化）。 */
function buildWorld(
  brushJson: string,
  triJson: string,
  teleportJson: string,
  spawnX: number,
  spawnY: number,
  spawnZ: number,
  spawnYaw: number,
): void {
  if (!wasmReady) return; // wasm 未初始化，忽略（消息顺序异常）
  phys = new PhysWorld();
  phys.build_world(brushJson, triJson, teleportJson, spawnX, spawnY, spawnZ, spawnYaw);
  worldReady = true;
}

/** 物理状态（wasm state() 返回）。 */
interface WasmState {
  posX: number; posY: number; posZ: number;
  yaw: number; pitch: number;
  velX: number; velY: number; velZ: number;
  onGround: boolean; eyeHeight: number;
}

/**
 * 一轮预测（终版，对齐审查 V5/V3）：
 * 1. 基线 = acquire 读权威 S（双缓冲无撕裂）→ set_state 同步预测实例，重置步长起点
 * 2. 输入 = 读输入槽当前值（只读，不消耗）
 * 3. 动态预测步长（V5）：min(now - lastStepTs, 1/64)——覆盖自上次物理同步以来的真实进度
 * 4. 2 子步轻量 predict → 写 S_pred（双缓冲）+ gen_P 代际（V3）
 */
function predictRound(): void {
  if (!shared || !phys || !worldReady || disabled) return;
  // 1. 基线同步：权威就绪才预测
  const auth = shared.readAuthoritative();
  if (!auth) return;
  phys.set_state(
    auth.state.pos.x, auth.state.pos.y, auth.state.pos.z,
    auth.state.yaw, auth.state.pitch,
    auth.state.vel.x, auth.state.vel.y, auth.state.vel.z,
    auth.state.onGround,
  );
  // 2. 只读输入
  const input = shared.readInput();
  // 3. 动态步长（V5）：距离上次同步/预测的真实时间，钳制到一物理步
  const now = performance.now();
  const sinceLast = lastStepTs === 0 ? predDt : Math.min((now - lastStepTs) / 1000, predDt);
  lastStepTs = now;
  // 4. 2 子步预测（步长均分）
  const genA = auth.gen; // V3：预测携带权威代际
  let last: WasmState | null = null;
  for (let i = 0; i < PREDICT_STEPS; i++) {
    last = phys.predict(sinceLast / PREDICT_STEPS, input.keysMask, i === 0 ? input.dx : 0, i === 0 ? input.dy : 0) as unknown as WasmState;
  }
  if (!last) return;
  // 代际守卫（V3）：预测期间权威又更新 → 本轮基于旧代际，丢弃
  if (shared.getGen() !== genA) return;
  counter++;
  shared.writePredicted(
    {
      pos: { x: last.posX, y: last.posY, z: last.posZ },
      yaw: last.yaw,
      pitch: last.pitch,
      vel: { x: last.velX, y: last.velY, z: last.velZ },
      onGround: last.onGround,
      eyeHeight: last.eyeHeight,
      timeMs: now,
    },
    genA,
    counter,
  );
}

/**
 * 热待机循环（时序图：Worker-B 热待机，Atomics.wait 仅限 Worker 调用）。
 *
 * 唤醒协议：
 * - 主线程三源决策命中「权威就绪」时 Atomics.notify(I_V_A)（见 app.ts）→ Worker-B 被唤醒
 * - 唤醒后：V_A 已变化 → 读权威基线 + 只读输入 → 2 子步预测 → 写 S_pred
 * - 超时 16ms 兜底（防 notify 丢失；notify 时若无等待者，wait 随后因条件不满足立即返回）
 */
function runWaitLoop(): void {
  const i32 = new Int32Array(shared!.bufferOf());
  const waitTarget = 0; // V_A 槽（Int32 索引 0）
  let lastVa = Atomics.load(i32, waitTarget);
  const tick = (): void => {
    try {
      if (!shared || !worldReady) {
        setTimeout(tick, 16);
        return;
      }
      // 权威变化 → 预测（读基线 + 只读输入 + 2 子步）
      const va = Atomics.load(i32, waitTarget);
      if (va !== lastVa) {
        lastVa = va;
        predictRound();
      }
      // 热待机：阻塞等唤醒（主线程 notify）或 16ms 超时兜底
      Atomics.wait(i32, waitTarget, lastVa, 16);
      const va2 = Atomics.load(i32, waitTarget);
      if (va2 !== lastVa) {
        lastVa = va2;
        predictRound();
      }
      setTimeout(tick, 16);
    } catch (err) {
      // 定位用：预测循环异常上报
      postMessage({
        type: 'error',
        message: `[predictor] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      });
    }
  };
  setTimeout(tick, 16);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string } & Record<string, unknown>;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'wasm-init': {
      void (async () => {
        try {
          await startWasm(msg as unknown as { wasmUrl?: string });
          // wasm 就绪 + shared 就绪 → 启动热待机预测循环
          if (shared) runWaitLoop();
        } catch (err) {
          console.error('[predictor] wasm-init 失败:', err);
        }
      })();
      break;
    }
    case 'init': {
      const init = msg as unknown as { shared: SharedArrayBuffer | null; predDt?: number };
      if (init.shared) {
        shared = createWorkerSharedState(init.shared);
      }
      if (init.predDt) predDt = init.predDt;
      // wasm 已就绪则立即启动热待机（消息顺序：wasm-init 可能先于 init 到达）
      if (wasmReady) runWaitLoop();
      break;
    }
    case 'build-world': {
      const b = msg as unknown as {
        brushJson: string; triJson: string; teleportJson: string;
        spawnX: number; spawnY: number; spawnZ: number; spawnYaw: number;
      };
      buildWorld(b.brushJson, b.triJson, b.teleportJson, b.spawnX, b.spawnY, b.spawnZ, b.spawnYaw);
      break;
    }
    case 'set-pred-dt': {
      const d = msg as unknown as { dt: number };
      predDt = d.dt;
      break;
    }
    case 'set-enabled': {
      const d = msg as unknown as { enabled: boolean };
      disabled = !d.enabled;
      break;
    }
    default:
      break;
  }
};
