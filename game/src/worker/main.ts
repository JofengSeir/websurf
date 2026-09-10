/**
 * Worker — 双模式物理计算器（phys-mode-port t10；v7 权威线 + 解耦线双线共存）。
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
 * 双模式扩展（phys-mode-port §3.2，t10）：
 * - **实例拓扑**：phys（v7 权威实例，两模式共享——耦合=权威线 / 解耦=1ms 无限制
 *   真理源）+ tickPhys（新增第二实例，world-json 同建同参 G3/P9——解耦=64t 速度
 *   校准线，对 phys 唯一影响 = set_velocity；分叉锚定 TICK_ANCHOR_DIST 拉回）
 * - **双调度线互斥 gate**：auth-loop（耦合线）+ decoupled-loop（解耦线）常驻自驱，
 *   各自 body 顶部 mode gate 早退；切换 = set-mode 翻转 worker 侧 computeMode
 *   （两 loop 下一轮自然互斥，无 start/stop 竞态）
 * - **热切握手**（§3.4.C）：set-mode{state} → applyModeSwitch（gate 翻转 + 状态
 *   注入 + tickPhys 对齐 + 采样器清零 + resetInput）→ mode-ack（dispatch 回执）
 * - **hold 冻结**（§3.4.A）：set-hold 注入，解耦循环逐轮强制 set_state（worker 侧执行）
 * - 默认耦合模式（computeMode='coupled'），v7 行为零回归
 *
 * 公共化（2026-08-09）：自驱循环/固定步长/碰撞事件（auth-loop）、消息分发
 * （worker-dispatch）、参数映射（params）全部收敛到 src/ts-shared/，本文件
 * 仅剩 wasm/Config 注入接线 + 双模式装配（t10）。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import type { ShmState, MsgState } from '../../../src/ts-shared/auth/shared-state.js';
import { createAuthLoop, type PhysWorldLike } from '../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerDispatch } from '../../../src/ts-shared/auth/worker-dispatch.js';
import {
  createDecoupledLoop,
  type ComputeMode,
  type DecoupledPhysWorld,
  type HoldState,
  type SavePointLike,
  type SyncRenderStateLike,
} from '../../../src/ts-shared/decoupled/decoupled-loop.js';
import { buildPhysicsParams } from '../../../src/ts-shared/phys/params.js';
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';

/**
 * tickRate 隐藏偏移（用户定调 2026-08-18）：面板显示/输入原值，实际权威步长 = 原值 + 3。
 * 不体现在面板/HUD（显示仍为原值），仅权威固定步长生效（fixedDt = 1/(tickRate+3)）。
 * 仅耦合线消费；解耦 tickPhys 走 raw 原值（§3.4.D）。
 */
export const TICK_RATE_OFFSET = 3;

const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽（init 消息注入；双 loop/同步共用）。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威 PhysWorld 槽（world-json 构建后注入；耦合=权威线 / 解耦=1ms 真理源）。 */
const phys: { current: DecoupledPhysWorld | null } = { current: null };
/** tickPhys 槽（第二实例；world-json 与 phys 同建同参 G3/P9；解耦=64t 校准线）。 */
const tickPhys: { current: PhysWorldLike | null } = { current: null };
/** wasm 线性内存（initSync 的 InitOutput.memory；state_out 零分配视图宿主）。 */
const wasmMemory: { current: WebAssembly.Memory | null } = { current: null };

/**
 * 计算模式（worker 侧真相源；仅 set-mode 翻转——§3.4.C 握手纪律。
 * config.physics.computeMode 字段是声明性元数据，不绕过握手切换）。
 * 默认耦合（§3.6）；v7 行为 = 本值恒 'coupled'。
 */
let computeMode: ComputeMode = 'coupled';

/** 解耦 hold 冻结态（set-hold 注入；null = 自由）。 */
let hold: HoldState | null = null;

/** 面板参数 → wasm set_params（tickRate 由权威固定步长驱动；两端 config 各自映射）。
 * 双实例同参（G3）：phys + tickPhys 逐实例同步（world-json 同建后参数变更只走这里）。 */
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
  const paramJson = JSON.stringify(params);
  const pl = config.player;
  // 双实例同参（tickPhys 空槽时自然跳过——debug/耦合单实例等价）
  const instances: (PhysWorldLike | null)[] = [phys.current, tickPhys.current];
  for (const inst of instances) {
    if (!inst) continue;
    inst.set_params(paramJson);
    inst.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
  }
}

/** 耦合权威自驱循环（setTimeout 4ms + 固定步长累积器 + 碰撞事件；ts-shared）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  post: (msg) => postMessage(msg),
  // 双线互斥门（§3.2）：解耦期间耦合权威线早退（写槽权移交解耦线；关断窗口
  // 墙钟冻结，复入不补跑解耦期间的时间）
  modeGate: () => computeMode === 'coupled',
});

/** 解耦自驱循环（WorkerA 编排移植：1ms 无限制真理源 + 64t tickPhys 速度校准 +
 * 分叉锚定 + 背压；ts-shared/decoupled）。 */
const decoupledLoop = createDecoupledLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  getTickPhys: () => tickPhys.current as DecoupledPhysWorld | null,
  // tickPhys 步长源：raw 原值（无 +3 偏移——偏移仅耦合权威线语义，§3.4.D）
  getTickPhysRate: () => config.physics.tickRate,
  isDecoupled: () => computeMode === 'decoupled',
  getWasmMemory: () => wasmMemory.current,
  getHold: () => hold,
});
// 自驱待命：未就绪/门关轮次为 4ms 空转等待，就绪+解耦后自动接管（§3.2 双线常驻）
decoupledLoop.start();

/**
 * 热切执行（§3.4.C 步骤 a-f；dispatch set-mode 分支调用，mode-ack 由 dispatch 回）。
 * 耦合→解耦（主线程预测真理 → Worker 真理源）；解耦→耦合（反向，免带 state）。
 */
function applyModeSwitch(mode: ComputeMode, state?: SyncRenderStateLike): void {
  if (mode === computeMode) return; // 幂等守卫（dispatch 已做同 mode 幂等，双保险）
  computeMode = mode; // a. gate 翻转（两 loop 下一轮自然互斥）
  if (mode === 'decoupled') {
    // b. 状态注入（主线程预测全态 9 字段；eyeHeight→set_posture 姿态导出为
    // §3.9 明确不做项——Rust 零改动约束，蹲姿交接缺口 v1 接受）
    if (state && phys.current) {
      phys.current.set_state(
        state.posX, state.posY, state.posZ, state.yaw, state.pitch,
        state.velX, state.velY, state.velZ, state.onGround,
      );
    }
    // c+d. tickPhys 全量对齐（alignTickPhys 语义）+ 采样器全清
    //（acc/loAcc/tickDx/tickDy/modeBWasActive + 墙钟基准）
    decoupledLoop.resetSamplers(true);
    // e. 输入增量清零（键位保留）
    shared.current?.resetInput();
    // 交接即时帧：清掉上一段解耦会话的陈旧 S_D（V_D 带旧 timeMs——外推消费者
    // 会拿陈旧帧算 Δt），注入后立刻发布切换时刻全态（§3.4.C 步骤 b 的可见化）
    decoupledLoop.publishCurrentState();
    // f. modeGate 立即生效（耦合线下轮早退）；解耦线下轮接管（自驱已就位）
  } else {
    // 解耦→耦合：a. 已翻转（解耦线下轮早退，停写 S_D）
    // b. 清 worker 侧在途 hold（t12 修复：冻结不跨模式存活——残留 hold 会在
    //    再次进入解耦时复活死冻结；主线程 holdPoint 照常由 keyup 收尾）
    hold = null;
    // c. 权威步长恢复（面板 tickRate + 3）+ 清累积器/墙钟
    authLoop.setFixedDt(config.physics.tickRate + TICK_RATE_OFFSET);
    authLoop.reset();
    // d. 立即 writeAuthoritative 一帧——主线程 readAuthoritative 读到切换
    // 时刻态而非耦合期陈旧帧（复入首帧，§3.4.C-c）
    authLoop.publishCurrentState();
  }
}

/**
 * set-hold 执行（解耦模式 worker 侧 hold 冻结，§3.4.A）。
 * hold 注入：解耦循环逐轮强制 set_state(held, vel=0)；解除：null + release 存点
 * = 按 loadSavepoint 全量恢复（9 字段 set_state 双实例 + 采样器清零 + 输入清 +
 * 首帧发布，对齐 renderer-main.ts:609-618）。
 */
function applySetHold(next: HoldState | null, release?: SavePointLike): void {
  hold = next;
  if (next || !phys.current) return;
  if (release) {
    // 全量恢复存点（双实例 + 采样器 + 输入 + 首帧）
    phys.current.set_state(
      release.x, release.y, release.z, release.yaw, release.pitch,
      release.vx, release.vy, release.vz, release.onGround,
    );
    tickPhys.current?.set_state(
      release.x, release.y, release.z, release.yaw, release.pitch,
      release.vx, release.vy, release.vz, release.onGround,
    );
    decoupledLoop.resetSamplers(true);
    shared.current?.resetInput();
    decoupledLoop.publishCurrentState();
  } else {
    // plain 解除（无存点）：采样器清零从静止续跑（runHeldRound 已把 tickPhys
    // 冻结对齐到 held 态）
    decoupledLoop.resetSamplers(false);
  }
}

self.onmessage = createWorkerDispatch({
  shared,
  phys,
  authLoop,
  // ── 双模式装配（phys-mode-port §3.7 t10）─────────────────────
  tickPhys,
  decoupledLoop,
  getComputeMode: () => computeMode,
  onSetMode: applyModeSwitch,
  onSetHold: applySetHold,
  // tickRate 隐藏偏移（用户定调 2026-08-18）：面板显示/输入原值，实际权威步长 = 原值 + 3
  // （如面板 64 → 实际 67Hz；偏移不体现在面板/HUD，仅权威固定步长生效）
  getConfigTickRate: () => config.physics.tickRate + TICK_RATE_OFFSET,
  applyConfigPatch: (section, patch) =>
    applyConfigPatch(config, section as keyof RuntimeConfig, patch),
  syncParamsToWasm,
  createPhysWorld: () => new PhysWorld(),
  // initSync 包装：捕获 InitOutput.memory（state_out 零分配视图宿主，§3.2 A5）
  initSync: (module) => {
    wasmMemory.current = initSync(module).memory;
  },
  post: (msg) => postMessage(msg),
});
