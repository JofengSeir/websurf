/**
 * Worker — 权威帧计算器（阶段 2 game 同构，公共化版）。
 *
 * 架构：
 * - **Worker 持权威 PhysWorld**（world-json 一次性构建），setTimeout 4ms 自驱
 *   固定步长累积器（不设上限，guard<64）独立模拟权威物理线（含碰撞/摩擦/重力），
 *   每 tick 输出**权威帧**（位置/朝向/速度/眼高/着地/时间戳）到 SAB 双缓冲
 *   （或 MsgState phys-frame 消息回退），另回传碰撞事件（land/blocked）
 * - 主线程是渲染预测线（全速物理+渲染），每帧读权威帧做速度外推校准与异常兜底
 * - 输入：主线程写 SAB 输入槽（keys/dx/dy），本 Worker takeInput 消费
 * - 物理控制面板（PhysicsWorker）：set-physics-param/set-hull 等 → 权威 set_params
 *
 * 公共化（2026-08-09）：自驱循环/固定步长/碰撞事件（auth-loop）、消息分发
 * （worker-dispatch）、参数映射（params）全部收敛到 src/ts-shared/，本文件
 * 保留 debug 特有接线：
 * - mtzB64 内嵌（wasm-init 钩子：协议兼容保留，Worker 不再解析 BSP）
 * - `ready` 回执（init 钩子）
 * - 物理面板（onWorldBuilt attachWorld / onConfigApplied 参数覆盖重应用 /
 *   onExtraMessage 面板消息 / onTickRateChange 面板 tickRate）
 *
 * wasm-init：dist 内嵌 base64（initSync）/ dev 模式 wasmUrl fetch。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import type { ShmState, MsgState } from '../../../src/ts-shared/auth/shared-state.js';
import { createAuthLoop, type PhysWorldLike } from '../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerDispatch } from '../../../src/ts-shared/auth/worker-dispatch.js';
import { buildPhysicsParams } from '../../../src/ts-shared/phys/params.js';
import type { MainMessage, WorkerMessage } from './worker-types.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';
import { setMtzB64 } from './mtz-data.js';
import { PhysicsWorker } from './physics-worker.js';

const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽（init 消息注入；authLoop/同步共用）。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威 PhysWorld 槽（world-json 构建后注入）。 */
const phys: { current: PhysWorldLike | null } = { current: null };

/** 物理控制面板协调器（PhysicsParams → 权威 set_params/set_hull + snapshot 回传）。 */
const physicsWorker = new PhysicsWorker();

/** 面板参数 → wasm set_params（tickRate 由 JS 驱动层控制，不进 Rust）。
 * 字段与主线程 buildPredictionParams 同构（双端物理同一份参数；
 * 映射收敛到 ts-shared buildPhysicsParams）。 */
function syncParamsToWasm(): void {
  if (!phys.current) return;
  const p = config.physics;
  const params = buildPhysicsParams(
    {
      gravity: p.gravity,
      accelerate: p.accelerate,
      friction: p.friction,
      stopSpeed: p.stopSpeed,
      jumpSpeed: p.jumpSpeed,
      airAccel: p.airAccel,
      maxSpeed: p.maxSpeed,
      // debug 无独立走路/蹲走配置：取面板定义默认值（与主线程 buildPredictionParams 一致）
      walkSpeed: 130,
      crouchSpeed: 85,
      autobhop: true,
      bhopSpeedClamp: true,
      noPrestrafe: true,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
  phys.current.set_params(JSON.stringify(params));
  const pl = config.player;
  phys.current.set_hull(pl.radius, pl.standHeight, pl.duckHeight);
}

/** 权威自驱循环（setTimeout 4ms + 固定步长累积器 + 碰撞事件；ts-shared）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  post: (msg) => postMessage(msg),
});
/** tickRate 变更（面板）→ 权威固定步长即时生效。 */
physicsWorker.params.onTickRateChange = (rate) => {
  authLoop.setFixedDt(rate);
  authLoop.reset(); // 清累积器，防新旧步长错配
};

self.onmessage = createWorkerDispatch({
  shared,
  phys,
  authLoop,
  getConfigTickRate: () => config.physics.tickRate,
  applyConfigPatch: (section, patch) =>
    applyConfigPatch(config, section as keyof RuntimeConfig, patch),
  syncParamsToWasm,
  createPhysWorld: () => new PhysWorld(),
  initSync,
  post: (msg) => postMessage(msg),
  // ── debug 特有钩子 ─────────────────────────────────────────
  onInit: () => {
    postMessage({ type: 'ready' } satisfies MainMessage);
  },
  onWasmInit: (m) => {
    setMtzB64(m.mtzB64); // 协议兼容保留（Worker 不再解析 BSP，纹理包不再使用）
  },
  onWorldBuilt: (p) => {
    physicsWorker.attachWorld(p as PhysWorld);
  },
  onConfigApplied: () => {
    // 面板手动参数覆盖（全量默认参数可能盖掉面板值——覆盖优先）
    physicsWorker.reapplyParams();
  },
  onExtraMessage: (msg) => physicsWorker.handleMessage(msg as WorkerMessage | { type?: string }),
});
