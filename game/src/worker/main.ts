/**
 * Worker — 权威帧计算器（v7 定案，公共化版）。
 *
 * 架构（用户核心思想）：
 * - **Worker 加载地图物理碰撞**（world-json 一次性构建 PhysWorld），
 *   独立模拟**权威物理线**（固定 64Hz tick，含碰撞/摩擦/重力），
 *   每 tick 输出**权威帧**（位置/朝向/速度/眼高/着地/时间戳）
 * - 主线程是渲染预测线（全速物理+渲染），每帧读权威帧，
 *   用权威速度（考虑中途地图碰撞后的正确速度）外推校准渲染物理
 * - 输入：主线程写 SAB 输入槽（keys/dx/dy），本 Worker takeInput 消费
 *   （权威帧模拟需要同输入）；不反写位置，不渲染
 *
 * 公共化（2026-08-09）：自驱循环/固定步长/碰撞事件（auth-loop）、消息分发
 * （worker-dispatch）、参数映射（params）全部收敛到 src/ts-shared/，本文件
 * 仅剩 wasm/Config 注入接线（PhysWorld/initSync 导入 + config 映射）。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import type { ShmState, MsgState } from '../../../src/ts-shared/auth/shared-state.js';
import { createAuthLoop, type PhysWorldLike } from '../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerDispatch } from '../../../src/ts-shared/auth/worker-dispatch.js';
import { buildPhysicsParams } from '../../../src/ts-shared/phys/params.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';

const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽（init 消息注入；authLoop/同步共用）。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威 PhysWorld 槽（world-json 构建后注入）。 */
const phys: { current: PhysWorldLike | null } = { current: null };

/** 面板参数 → wasm set_params（tickRate 由权威固定步长驱动；两端 config 各自映射）。 */
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
      walkSpeed: p.walkSpeed,
      crouchSpeed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhopSpeedClamp: p.bhopSpeedClamp,
      noPrestrafe: p.noPrestrafe,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
  phys.current.set_params(JSON.stringify(params));
  const pl = config.player;
  phys.current.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
}

/** 权威自驱循环（setTimeout 4ms + 固定步长累积器 + 碰撞事件；ts-shared）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  post: (msg) => postMessage(msg),
});

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
});
