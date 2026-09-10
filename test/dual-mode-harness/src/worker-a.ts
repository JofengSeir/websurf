/**
 * WorkerA — 三模式物理核心（coupled / decoupled / tick + 运行时热切）。
 *
 * 迁移背景（2026-09-10）：game 的三模式切换经真机手测判定失败，该工程已回退为
 * 原本的耦合单模（`game/` 与 c4824e9 逐字节一致）。三种模式的**物理计算本体**
 * 迁入本测试工程，实现在 src/ts-shared（auth-loop / decoupled-loop /
 * tick-authority / compute-mode / worker-dispatch）——本文件只做 harness 装配。
 *
 * 通道（双通道，职责分离）：
 * - **auth 通道**（`ShmState`，512B，共享协议）：输入消费 + 权威/解耦帧 + meta
 *   三元组（seg/tick/evt）。三模式物理的唯一读写面；`createWorkerDispatch`
 *   拥有其 'init'/'input'/'wasm-init'/'world-json' 生命周期。
 * - **渲染通道**（harness 既有 `TestShared`，192B）：`MirrorShmState` 在**每次
 *   发布时**把帧镜像进 TestShared 状态槽 → WorkerB 渲染路径**零改动**
 *   （TestShared 状态槽无 eyeHeight 字段，沿用既有固定站立眼高语义）。
 *
 * 三模式语义（唯一权威：src/ts-shared/auth/compute-mode.ts）：
 * - `coupled`：auth 线 64Hz 权威（面板 tickRate + 3 隐藏偏移）；默认模式。
 * - `decoupled`：1ms 无限制真理源 + 独立 64t tickPhys 速度校准 + 分叉锚定。
 * - `tick`：raw 64Hz 单实例权威 + F4-C scratch 乐观评估（排序门 + 内容封帽）。
 * 双线互斥 gate + `set-mode`/`mode-ack` 热切握手全部由共享层 dispatch 收口。
 *
 * 世界构建：主线程 BSP 解析后发 `world-json`（brushJson/triJson/teleportJson/
 * spawn{x,y,z,yawDeg}）；dispatch 建三实例同参（G3）并 setFixedDt；本文件补齐
 * harness 既有的死亡阈值（brushJson 最小 min[1] − 100）。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../pkg/websurf_test_wasm.js';
import { TestShared, type SharedInputMsg, type SharedTickRateMsg } from './shared-state.js';
import {
  ShmState,
  MsgState,
  AUTH_EVT,
  type AuthFrame,
  type AuthPublishMeta,
  type SharedState,
} from '../../../src/ts-shared/auth/shared-state.js';
import { createAuthLoop, type PhysWorldLike } from '../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerDispatch } from '../../../src/ts-shared/auth/worker-dispatch.js';
import {
  createTickAuthority,
  type TickF4Controller,
  type F4AuthorityWorld,
  type F4ScratchWorld,
} from '../../../src/ts-shared/auth/tick-authority.js';
import {
  createDecoupledLoop,
  type ComputeMode,
  type DecoupledPhysWorld,
  type HoldState,
  type SavePointLike,
  type SyncRenderStateLike,
} from '../../../src/ts-shared/decoupled/decoupled-loop.js';
import { resolveAuthTickRate } from '../../../src/ts-shared/auth/compute-mode.js';

/** 耦合权威线隐藏偏移（用户定调 2026-08-18）：实际步长 = 面板值 + 3。
 *  仅耦合线消费；tick 走 raw 直译、解耦 tickPhys 另读 raw（§3.4.D）。 */
const TICK_RATE_OFFSET = 3;

/** 默认 tickRate（harness 难度按钮默认 64；TestShared 未就绪时兜底）。 */
const DEFAULT_TICK_RATE = 64;

/** 碰撞箱（harness 既有值；与 game player 配置一致）。 */
const HULL_HALF_WIDTH = 16;
const HULL_STAND_HEIGHT = 72;
const HULL_DUCK_HEIGHT = 54;

// ── 槽（dispatch/loops 共享）─────────────────────────────────────
/** auth 通道槽（三模式物理唯一读写面；由 'auth-init' 注入）。 */
const shared: { current: SharedState | null } = { current: null };
/** 渲染通道槽（harness 既有 TestShared；由 'init-shared' 注入）。 */
const testShared: { current: TestShared | null } = { current: null };
/** 权威实例（耦合=权威线 / 解耦=1ms 真理源 / tick=raw 64Hz 唯一实例）。 */
const phys: { current: DecoupledPhysWorld | null } = { current: null };
/** 第二实例（解耦=64t 速度校准线；tick 模式闲置不驱动不 free）。 */
const tickPhys: { current: PhysWorldLike | null } = { current: null };
/** 第三实例（F4-C scratch 乐观评估执行体；仅 tick 模式驱动）。 */
const scratch: { current: PhysWorldLike | null } = { current: null };
/** wasm 线性内存（state_out 零分配视图宿主）。 */
const wasmMemory: { current: WebAssembly.Memory | null } = { current: null };

/** 计算模式（worker 侧真相源；仅 set-mode 翻转——§3.4.C 握手纪律）。 */
let computeMode: ComputeMode = 'coupled';
/** 解耦 hold 冻结态（set-hold 注入；null = 自由）。 */
let hold: HoldState | null = null;
/** 最近一次 world-json 的 brushJson（死亡阈值计算用；dispatch 不透传）。 */
let lastBrushJson: string | null = null;

/** harness 侧配置（无参数面板；仅 tickRate 参与权威步长解析）。 */
const config = {
  physics: { tickRate: DEFAULT_TICK_RATE },
};

/** 当前面板 tickRate（harness 难度按钮 → TestShared 槽；tickRate=0/≥1000 由
 *  harness 既有语义处理：0 = 关闭 tick 线）。 */
function panelTickRate(): number {
  const r = testShared.current?.readTickRate();
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : DEFAULT_TICK_RATE;
}

// ── 渲染通道镜像（发布即镜像，无轮询）────────────────────────────
/** 把 auth 帧写进 harness 既有 TestShared 状态槽（WorkerB 唯一渲染参数源）。
 *  TestShared 槽位为 pos×3/vel×3/yaw/pitch——eyeHeight 不在槽内（既有语义）。 */
function mirrorFrame(f: AuthFrame): void {
  const t = testShared.current;
  if (!t) return;
  t.writeState(
    { x: f.pos.x, y: f.pos.y, z: f.pos.z },
    { x: f.vel.x, y: f.vel.y, z: f.vel.z },
    f.yaw,
    f.pitch,
  );
}

/**
 * auth 通道的 ShmState 子类：每次权威/解耦发布后把帧镜像进渲染通道。
 * 用子类而非包装对象，是为了保持 `ShmState | MsgState` 的精确类型
 * （dispatch/loops 的 env 按该联合类型标注，结构性包装无法通过类型门）。
 */
class MirrorShmState extends ShmState {
  private readonly mirror: (f: AuthFrame) => void;

  constructor(buffer: SharedArrayBuffer, mirror: (f: AuthFrame) => void) {
    super(buffer);
    this.mirror = mirror;
  }

  override writeAuthoritative(
    a: Omit<AuthFrame, 'onGround'>,
    onGround: boolean,
    meta?: AuthPublishMeta,
  ): number {
    const v = super.writeAuthoritative(a, onGround, meta);
    this.mirror({ ...a, onGround });
    return v;
  }

  override writeDecoupled(frame: AuthFrame): void {
    super.writeDecoupled(frame);
    this.mirror(frame);
  }
}

/** worker 侧消息回退通道（无 SAB）：与 ShmState 分支同构地做发布镜像，
 *  使非 SAB 环境下 WorkerB（经 renderPort 直连）仍能收到帧。 */
class MirrorMsgState extends MsgState {
  private readonly mirror: (f: AuthFrame) => void;

  constructor(mirror: (f: AuthFrame) => void) {
    super(null);
    this.mirror = mirror;
  }

  override writeAuthoritative(
    a: Omit<AuthFrame, 'onGround'>,
    onGround: boolean,
    meta?: AuthPublishMeta,
  ): number {
    const v = super.writeAuthoritative(a, onGround, meta);
    this.mirror({ ...a, onGround });
    return v;
  }

  override writeDecoupled(frame: AuthFrame): void {
    super.writeDecoupled(frame);
    this.mirror(frame);
  }
}

function createAuthShared(buffer: SharedArrayBuffer | null): SharedState {
  return buffer ? new MirrorShmState(buffer, mirrorFrame) : new MirrorMsgState(mirrorFrame);
}

// ── 三模式引擎装配（全部来自 src/ts-shared）──────────────────────
/** F4-C 控制器（tick 模式 scratch 乐观评估 + 排序门 + 内容封帽）。 */
const tickF4: TickF4Controller = createTickAuthority({
  getShared: () => shared.current,
  getAuthority: () => phys.current as F4AuthorityWorld | null,
  getScratch: () => scratch.current as F4ScratchWorld | null,
  getWasmBuffer: () => wasmMemory.current?.buffer ?? null,
  getTickPeriodMs: () => 1000 / Math.max(panelTickRate(), 1),
});

/** 耦合权威自驱循环（auth 线：coupled + tick 推进；decoupled 早退）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  post: (msg) => postMessage(msg),
  getComputeMode: () => computeMode,
  holdState: () => (computeMode === 'tick' ? hold : null),
  tickF4,
});

/** 解耦自驱循环（1ms 真理源 + 64t tickPhys 速度校准 + 分叉锚定）。 */
const decoupledLoop = createDecoupledLoop({
  get shared() {
    return shared.current;
  },
  getPhys: () => phys.current,
  getTickPhys: () => tickPhys.current as DecoupledPhysWorld | null,
  getTickPhysRate: () => panelTickRate(),
  isDecoupled: () => computeMode === 'decoupled',
  getWasmMemory: () => wasmMemory.current,
  getHold: () => hold,
});
// 自驱待命：未就绪/门关轮次空转等待，就绪 + 解耦后自动接管
decoupledLoop.start();

// ── 世界构建辅助 ────────────────────────────────────────────────
/** 三实例同参（G3）：本 harness 无参数面板，仅同步碰撞箱（保持既有 wasm
 *  默认参数语义不变——harness 此前从不调用 set_params）。 */
function syncParamsToWasm(): void {
  const instances: (PhysWorldLike | null)[] = [phys.current, tickPhys.current, scratch.current];
  for (const w of instances) {
    if (!w) continue;
    w.set_hull(HULL_HALF_WIDTH, HULL_STAND_HEIGHT, HULL_DUCK_HEIGHT);
  }
}

/** 死亡阈值：brushJson 最小 min[1] − 100（harness 既有语义，默认 −100000 兜底）。 */
function applyDeathThreshold(): void {
  if (!lastBrushJson) return;
  let minY = Infinity;
  try {
    const brushes = JSON.parse(lastBrushJson) as Array<{ min: number[] }>;
    for (const b of brushes) {
      if (b.min[1] < minY) minY = b.min[1];
    }
  } catch (e) {
    console.error('[worker-a] brushJson 解析失败（死亡阈值保持默认）:', e);
    return;
  }
  if (!Number.isFinite(minY)) return;
  phys.current?.set_death_y(minY - 100);
  tickPhys.current?.set_death_y(minY - 100);
  scratch.current?.set_death_y(minY - 100);
}

/** 立即发布一帧（respawn/world-json 后首帧可见；镜像随之更新）。 */
function publishNow(): void {
  if (computeMode === 'decoupled') decoupledLoop.publishCurrentState();
  else authLoop.publishCurrentState(tickF4.firstFrameMeta());
}

// ── 热切执行（§3.4.C 步骤 a-f；dispatch set-mode 分支调用）────────
function applyModeSwitch(mode: ComputeMode, state?: SyncRenderStateLike): void {
  if (mode === computeMode) return; // 幂等守卫（dispatch 已做同 mode 幂等，双保险）
  computeMode = mode; // a. gate 翻转（两 loop 下一轮自然互斥）

  if (mode === 'decoupled') {
    // 0. F4 状态清理（离开 tick 模式；非 tick 来向幂等 no-op）
    tickF4.exitMode();
    // b. 状态注入（主线程预测全态 9 字段；eyeHeight→set_posture 为明确不做项）
    if (state && phys.current) {
      phys.current.set_state(
        state.posX, state.posY, state.posZ, state.yaw, state.pitch,
        state.velX, state.velY, state.velZ, state.onGround,
      );
    }
    // c+d. tickPhys 全量对齐 + 采样器全清（acc/loAcc/tickDx/tickDy/modeBWasActive）
    decoupledLoop.resetSamplers(true);
    // e. 输入增量清零（键位保留）
    shared.current?.resetInput();
    // 交接即时帧（清掉上一段会话的陈旧 S_D）
    decoupledLoop.publishCurrentState();
  } else if (mode === 'tick') {
    // ── tick 支路（四向交接矩阵行①②）──
    // a.0 F4 进入（段 +1 + modeSwitch 位）
    tickF4.enterMode();
    // b. 状态注入：仅耦合→tick（行① stateInject=true）；解耦→tick 零注入
    if (state && phys.current) {
      phys.current.set_state(
        state.posX, state.posY, state.posZ, state.yaw, state.pitch,
        state.velX, state.velY, state.velZ, state.onGround,
      );
    }
    // c. 清在途 hold（冻结不跨模式存活）
    hold = null;
    // d. 输入增量清零（键位保留）
    shared.current?.resetInput();
    // e. raw 步长 + 清累积器/墙钟（不动物理状态）
    authLoop.setFixedDt(resolveAuthTickRate('tick', panelTickRate(), TICK_RATE_OFFSET));
    authLoop.reset();
    // f. 交接首帧（meta 携带 seg+1 + modeSwitch 位）
    authLoop.publishCurrentState(tickF4.firstFrameMeta());
  } else {
    // 解耦/tick → 耦合
    hold = null;
    tickF4.exitMode();
    authLoop.setFixedDt(resolveAuthTickRate('coupled', panelTickRate(), TICK_RATE_OFFSET));
    authLoop.reset();
    authLoop.publishCurrentState(tickF4.firstFrameMeta());
  }
}

/** set-hold 执行（解耦模式 worker 侧 hold 冻结；§3.4.A）。 */
function applySetHold(next: HoldState | null, release?: SavePointLike): void {
  hold = next;
  if (next || !phys.current) return;
  if (release) {
    phys.current.set_state(
      release.x, release.y, release.z, release.yaw, release.pitch,
      release.vx, release.vy, release.vz, release.onGround,
    );
    tickPhys.current?.set_state(
      release.x, release.y, release.z, release.yaw, release.pitch,
      release.vx, release.vy, release.vz, release.onGround,
    );
    tickF4.externalBreak(AUTH_EVT.holdRelease);
    decoupledLoop.resetSamplers(true);
    shared.current?.resetInput();
    decoupledLoop.publishCurrentState();
    authLoop.publishCurrentState(tickF4.firstFrameMeta());
  } else {
    decoupledLoop.resetSamplers(false);
    tickF4.externalBreak(AUTH_EVT.holdRelease);
    authLoop.publishCurrentState(tickF4.firstFrameMeta());
  }
}

// ── dispatch（共享层：init / wasm-init / world-json / config / respawn /
//    set-mode / set-hold / spawns 等）────────────────────────────
const dispatch = createWorkerDispatch({
  shared,
  phys,
  authLoop,
  tickPhys,
  scratch,
  decoupledLoop,
  getComputeMode: () => computeMode,
  onSetMode: applyModeSwitch,
  onSetHold: applySetHold,
  tickExternalBreak: (evtBit) => tickF4.externalBreak(evtBit),
  onWorldRebuilt: () => tickF4.externalWorldRebuild(),
  getConfigTickRate: () =>
    resolveAuthTickRate(computeMode, panelTickRate(), TICK_RATE_OFFSET),
  applyConfigPatch: (section, patch) => {
    if (section === 'physics' && typeof patch.tickRate === 'number') {
      config.physics.tickRate = patch.tickRate;
    }
  },
  syncParamsToWasm,
  createPhysWorld: () => new PhysWorld() as unknown as PhysWorldLike,
  // initSync 包装：捕获 InitOutput.memory（state_out 零分配视图宿主，§3.2 A5）
  initSync: (module) => {
    wasmMemory.current = initSync({ module }).memory;
  },
  post: (msg) => postMessage(msg),
  // 世界构建完成：三实例死亡阈值（dispatch 不透传 brushJson，用拦截记录）
  onWorldBuilt: () => {
    applyDeathThreshold();
    publishNow();
  },
});

// ── 消息入口：harness 私有消息自行处理，其余全部交给 dispatch ────
interface AuthInitMessage {
  type: 'auth-init';
  shared: SharedArrayBuffer | null;
}
type HarnessMessage =
  | AuthInitMessage
  | { type: 'init-shared'; shared: SharedArrayBuffer }
  | { type: 'init-msg'; renderPort: MessagePort }
  | SharedInputMsg
  | SharedTickRateMsg
  | { type: 'world-json'; brushJson: string; triJson: string; teleportJson: string; spawn: { x: number; y: number; z: number; yawDeg: number } };

self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HarnessMessage;

  switch (msg.type) {
    // harness 渲染通道（TestShared，192B）——WorkerB 参数源
    case 'init-shared':
      testShared.current = TestShared.init((msg as { shared: SharedArrayBuffer }).shared);
      return;
    // auth 通道（ShmState，512B）——三模式物理读写面（镜像到 TestShared）
    case 'auth-init':
      shared.current = createAuthShared((msg as AuthInitMessage).shared);
      return;
    // 消息回退模式：状态发布直连 WorkerB 端口（无 SAB 时的渲染通道）
    case 'init-msg': {
      const port = (msg as unknown as { renderPort: MessagePort }).renderPort;
      testShared.current = TestShared.initMessaging((m: unknown) => port.postMessage(m));
      return;
    }
    // 消息回退模式：主线程每 rAF 投递的输入批次（等价 SAB addInput）
    case 'shared-input': {
      const m = msg as SharedInputMsg;
      testShared.current?.onInputMessage(m.dx, m.dy, m.keysMask);
      return;
    }
    // 消息回退模式：难度调节（等价 SAB writeTickRate）
    case 'shared-tick-rate':
      testShared.current?.onTickRateMessage((msg as SharedTickRateMsg).rate);
      return;
    // world-json：记录 brushJson（死亡阈值）后交 dispatch 建世界
    case 'world-json':
      lastBrushJson = (msg as { brushJson: string }).brushJson;
      break;
    default:
      break;
  }

  dispatch(e);
});

// ── 入口 ────────────────────────────────────────────────────────
export function startWorkerA(): void {
  // 消息监听已在模块顶层注册；authLoop 在 wasm-init 就绪后由 dispatch 启动，
  // decoupledLoop 已在模块层 start() 自驱待命。
}

startWorkerA();
