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
import type { ShmState, MsgState, RenderSample } from '../../../../src/ts-shared/auth/shared-state.js';
import {
  createAuthLoop,
  type PhysWorldLike,
  type RenderTrajectorySource,
} from '../../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerDispatch } from '../../../../src/ts-shared/auth/worker-dispatch.js';
import { buildPhysicsParams } from '../../../../src/ts-shared/phys/params.js';
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

// ── 渲染轨迹采样源（渲染轨迹采样扩展）：把权威 tick 的发布位置投到渲染折线上 ──
//
// 主线程每 rAF 经共享槽尾槽（SAB：RT_SEQ seqlock / MsgState：input 消息）写一条
// 「渲染采样」；本 worker 读它，形成 tick 折线 = 渲染曲线内接 ~64 边形。
//
// 热路径约束（R1）：f64/Number 域运算，无 BigInt 装箱、无每唤醒分配；四唤醒中
// 三唤醒不 tick（4ms 轮询 vs ≥6.9ms tick 间隔），故**首个 tick 才惰性读一次**。

/** 采样龄上限（单位=worker 读取计数）：>2 渲染帧 ≈ 8 次 4ms 唤醒未更新即判陈旧。
 * 刻意用「读取计数」而非跨时钟比较——渲染时钟与 worker 时钟的偏移不可假设。 */
const RT_STALE_READS = 8;
/** 偏移估计滑动窗（≥64 观测；下界 = 到达延迟下界，即「渲染时刻相对 worker 的最前位」）。 */
const RT_OFFSET_WINDOW = 64;

/** 偏移估计滑窗（预分配：热路径零分配）。 */
const rtLagWindow = new Float64Array(RT_OFFSET_WINDOW);
let rtLagCount = 0;
let rtLagCursor = 0;
let rtOffset = 0; // min(lag)；正无穷哨兵 = 尚无观测

/** 唯一复用的读缓冲（readRenderSample 零分配契约）。 */
const rtOut: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
/** 缓存的有效配对（相邻两样本；seq<=0 = 缺参）。 */
const rtPrev: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
const rtCur: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
let rtCurSeq = 0;
let rtGapReads = 0;
let rtValid = false;
/**
 * 缓存配对（rtPrev→rtCur）所属的**失效世代**（缺陷修复 · epoch 竞态）。
 *
 * 与 `rtCur.epoch` 的区别：`rtCur.epoch` 是「读到这条样本时它自称的世代」，
 * 本值是「**服务样本那一刻**再确认过的世代」——主线程 `resetTo → bumpSampleEpoch`
 * 自增世代与 Worker 下一次读槽之间有一个窗口，窗口内 `rtCur` 仍可能是旧世界的
 * 点。服务前用 `readRenderEpoch()` 复检本值，不一致即判定缓存对作废
 * （见 `rtServeEpochOk`）。
 */
let rtPairEpoch = 0;
/**
 * 配对建立时的**到达延迟**（ms；渲染时刻 `t` − Worker 读到它的时刻）。
 *
 * 用途：把 `rtCur.t` 换算成「配对建立时的渲染时钟估计」= `rtCur.t + rtPairLagMs`，
 * 用于判断本次 τ 是否已经跑出缓存对太久（`RT_SERVE_STALE_MS`）——τ 远超过
 * `rtCur.t` 说明渲染已前进而 Worker 的配对没跟上（渲染采样停更/被节流），
 * 此时**宁可本 tick 不投影**（回退权威自身位置），也不能把一个陈旧的采样点
 * 当成"当前位置"发布出去。
 */
let rtPairLagMs = 0;
/** 惰性读守卫：true = 本次唤醒尚未读槽（rtTickGate 置位）。 */
let rtWakeUnread = true;
/** 上次唤醒边界探测的时刻（performance.now()；-1 = 尚未探测）。 */
let rtLastGateMs = -1;
/** 唤醒边界判据（ms）：与上次 getPhys 的间隔 ≥ 本值即视为新唤醒（≈一个固定步长）。 */
const RT_WAKE_GAP_MS = 1;

/** 同唤醒内多 tick 的读取合并窗（ms；< 最快渲染帧间隔，避免漏掉真新样本）。 */
const RT_READ_MIN_GAP_MS = 2;

/** 上次采样读的时刻（performance.now()；用于同唤醒内的读取合并）。 */
let rtLastReadMs = -1;

/** 丢弃缓存配对（世代变化 / 陈旧 / reset）——保留 offset 估计（连续时钟，无需重学）。 */
function rtInvalidate(): void {
  rtValid = false;
  rtCurSeq = 0;
  rtPairEpoch = 0;
  rtPairLagMs = 0;
  rtPrev.seq = 0;
  rtCur.seq = 0;
}

/**
 * 唤醒边界检测 + 惰性读触发（挂在本 worker 的 `getPhys` 上：`stepPhysics` 每次
 * tick 都会调它一次，`loop()` 每唤醒至多调一次 `resolveAuthGateOpen` → 钩子缺省
 * 时 gate 恒开、不产生 getPhys 调用）。
 *
 * 判据（纯模块内墙钟，不依赖跨线程时钟同步）：`loop()` 先推进 `simMs` 再
 * `stepPhysics`，故每次 getPhys 都晚于其唤醒时刻；「与上次 getPhys 的间隔 < 一个
 * 固定步长」= 同一唤醒内的 tick 密集段 → 折叠成单次读，否则视为新唤醒 → 置位
 * 重读。无 tick 的唤醒（4ms 轮询 vs ≥6.9ms tick 间隔时约 3/4）其 getPhys 一次都
 * 不被调用，因而零读零成本；追赶爆发（一次唤醒多步）同样只读一次。
 */
function rtTickGate(): PhysWorldLike | null {
  const now = performance.now();
  if (rtLastGateMs < 0 || now - rtLastGateMs >= RT_WAKE_GAP_MS) rtWakeUnread = true;
  rtLastGateMs = now;
  return null; // null → 调用方 ?? 落到真 phys；本函数只做边界探测与惰性读标记
}

/** 记一次观测：滑动窗下界（最小到达延迟）。 */
function rtObserveLag(lag: number): void {
  if (rtLagCount < RT_OFFSET_WINDOW) {
    rtLagWindow[rtLagCount++] = lag;
  } else {
    rtLagWindow[rtLagCursor] = lag;
    rtLagCursor = (rtLagCursor + 1) % RT_OFFSET_WINDOW;
  }
  let m = rtLagWindow[0];
  for (let i = 1; i < rtLagCount; i++) if (rtLagWindow[i] < m) m = rtLagWindow[i];
  rtOffset = m;
}

/** 首个 tick（或距上次读 > 合并窗）才读一次共享槽；f64/Number 域，零分配。 */
function rtSample(): void {
  const now = performance.now();
  if (rtWakeUnread) {
    rtWakeUnread = false;
  } else if (now - rtLastReadMs < RT_READ_MIN_GAP_MS) {
    return; // 同一唤醒内的后续 tick：复用刚读到的配对
  }
  rtLastReadMs = now;
  const sh = shared.current;
  if (!sh) return;
  const arrival = now;
  const seq = sh.readRenderSample(rtOut);
  if (seq <= 0) {
    if (seq === 0) rtInvalidate(); // 通道未开始（世界重建/reset）
    return; // -1 = 读写冲突：本 tick 不更新（缓存配对保持或本就缺参）
  }
  if (rtValid && rtOut.epoch !== rtCur.epoch) rtInvalidate(); // 世代变化 → 旧样本全失效
  if (seq === rtCurSeq) {
    // 无新样本：读取计数老化（>2 渲染帧未更新 → 配对陈旧）
    if (rtValid && ++rtGapReads > RT_STALE_READS) rtInvalidate();
    return;
  }
  rtCurSeq = seq;
  rtGapReads = 0;
  rtPairEpoch = rtOut.epoch; // 本配对自称的世代（服务前还会用 readRenderEpoch 复检）
  // 配对新鲜度基准：**只在配对更新时**刷新。若改成每次读都刷，陈旧配对的
  // 「配对时刻估计」会被后来那些"读到的还是同一个旧样本"的读数抬到现在，
  // 陈旧判定就永远不成立（见 rtPairLagMs 注释）。
  rtPairLagMs = rtOut.t - arrival;
  rtPrev.t = rtCur.t;
  rtPrev.x = rtCur.x;
  rtPrev.y = rtCur.y;
  rtPrev.z = rtCur.z;
  rtPrev.i0 = rtCur.i0;
  rtPrev.epoch = rtCur.epoch;
  rtPrev.seq = rtCur.seq;
  rtCur.t = rtOut.t;
  rtCur.x = rtOut.x;
  rtCur.y = rtOut.y;
  rtCur.z = rtOut.z;
  rtCur.i0 = rtOut.i0;
  rtCur.epoch = rtOut.epoch;
  rtCur.seq = seq;
  rtValid = true;
  // 偏移观测：渲染时刻 −（worker）到达时刻。下界即「渲染时间轴相对本 worker 的
  // 最前位置」——再叠加到达延迟即当前渲染时钟估计（见 tickInstantToTau）。
  rtObserveLag(rtOut.t - arrival);
}

/** 把权威时钟瞬时值换算到渲染时钟域（不可用 → -1）。 */
function rtInstantToTau(workerInstMs: number): number {
  rtSample(); // 惰性：仅真正的 tick 会走到这里（rtSample 内做同唤醒合并）
  if (rtLagCount === 0) return -1; // 尚无观测（样本通道未开始）
  return workerInstMs + rtOffset;
}

/** 配对陈旧门限（ms）：τ 超过「配对时刻估计」这么多即判定配对没跟上，放弃本 tick 投影。 */
const RT_SERVE_STALE_MS = 50;

/**
 * 服务前世代复检（缺陷修复 · epoch 竞态）：缓存对必须仍属当前失效世代。
 *
 * 背景（实测现象）：主线程 `resetTo/换图/noclip/respawn` → `bumpSampleEpoch()`
 * 把世代 +1，渲染物理随即出现在**新世界**；但 Worker 缓存里那一对样本仍属**旧
 * 世界**，而 `rtSampleAtTau` 会把 τ **钳制**到这对样本的 `[rtPrev.t, rtCur.t]`
 * ——于是一个"看起来合法"的钳制点被当成当前位置发布出去 = 权威发布了一个旧世界
 * 线上的位置（实测跨图跳变被 `path-acceptance.mjs` 记成 1500+ HU 的 tick 跳变，
 * 并让"最近线段时间偏移 max"恶化到 20565ms）。
 *
 * 为什么必须在**服务时**复检而不是只在读槽时：世代自增发生在主线程，Worker 要等
 * 下一次读槽才知道；而"读到新样本"与"服务 τ"之间还隔着一次 tick。本复检用
 * `readRenderEpoch()`（1 次原子读）把窗口压到零。
 *
 * 复检失败 → 丢弃配对（`rtInvalidate`）并在本 tick 返回 null（**绝不插值跨世代**）。
 * 按契约，调用方 `auth-loop` 会回退到权威自身物理位置发布本帧（`pub = null`），
 * 下一 tick 用新世代的样本重建配对后恢复正常投影。
 */
function rtServeEpochOk(): boolean {
  const sh = shared.current;
  if (!sh) return false;
  if (sh.readRenderEpoch() !== rtPairEpoch) {
    rtInvalidate();
    return false;
  }
  return true;
}

/** 在渲染折线上按 τ 线性插值取点（钳制到配对端点；绝不外推、绝不跨世代）。 */
function rtSampleAtTau(tauMs: number): { x: number; y: number; z: number } | null {
  if (!rtValid || rtPrev.seq <= 0 || rtCur.seq <= 0 || rtCur.t <= rtPrev.t) return null;
  // ① 世代复检（见 rtServeEpochOk）：跨世代不插值。
  if (!rtServeEpochOk()) return null;
  // ② 新鲜度检查：τ 超前「配对时刻估计」太多 = 配对没跟上（渲染采样停更/节流），
  //    本 tick 不投影（回退权威自身位置），绝不把陈旧采样点当当前位置发布。
  //    注意**不能**只看 τ > rtCur.t：τ 本来就常略微超前 rtCur.t（样本到达延迟），
  //    那部分由钳制正常吸收（< 一个渲染帧）。
  const rtPairNow = rtCur.t + rtPairLagMs;
  if (tauMs - rtPairNow > RT_SERVE_STALE_MS) return null;
  const tau = tauMs < rtPrev.t ? rtPrev.t : tauMs > rtCur.t ? rtCur.t : tauMs;
  const f = (tau - rtPrev.t) / (rtCur.t - rtPrev.t);
  return {
    x: rtPrev.x + (rtCur.x - rtPrev.x) * f,
    y: rtPrev.y + (rtCur.y - rtPrev.y) * f,
    z: rtPrev.z + (rtCur.z - rtPrev.z) * f,
  };
}

/** 注入 AuthLoop 的钩子对象（零分配：私有字段 + 模块级缓存）。 */
const renderTrajectorySource: RenderTrajectorySource = {
  tickInstantToTau: rtInstantToTau,
  sampleAtTau: rtSampleAtTau,
};

// ── 权威健康守护（worker 侧，零渲染影响）──────────────────────────────
//
// 为什么需要（用户定调）：权威是**速度之主**——`calibrateVelocity` 每渲染帧把
// 权威速度写进渲染物理。故权威一旦跑飞（NaN/越界 y/停更），渲染会被每帧拖向同一
// 个坏速度，**不可自愈**。两个已知缺陷：
// ① `src/phys/mod.rs` 默认 death_y = -100_000，而 `set-death-threshold` 在
//    `phys.current` 为 null 时被静默丢弃、且 world 重建后不重放（worker-dispatch）
//    → 权威以默认深渊为地板，v_y → −√(2·800·100000) ≈ −12600 u/s，渲染被拽入
//    永久死亡循环。已在 worker-dispatch 侧补「阈值记忆 + world-json 重建后重放」。
// ② 此前**没有任何**权威故障探测器。
//
// 本守护全部挂在**已有的** 4ms 自驱唤醒上（`getPhys` → `rtTickGate`），不新增
// 定时器、不新增消息类型（复用既有 `error` 消息路径），短路在渲染线程之外。
// 触发动作只碰**权威实例**：respawn + 清死亡阈值外推，绝不写渲染。

/** 权威 y 下坠地板余量（HU）：低于 `spawnY − 本值` 即判「跑飞」（远大于任何合法
 *  地图高度：world-json 出生点 ±4096 HU 之外已不可能是正常下落）。 */
const AUTH_Y_FLOOR_MARGIN = 4096;
/** 无出生点信息时的兜底地板（HU）——足够深，正常地图永不到达。 */
const AUTH_Y_FLOOR_FALLBACK = -100_000;
/** 权威发布停滞阈值（ms）：超过它没有新 V_A = 权威线停更。 */
const AUTH_STALL_MS = 500;
/** 渲染采样通道停滞阈值（ms）：超过它没有新样本 = 主线程采样停更。 */
const RT_STALL_MS = 250;
/** 健康探测最小间隔（ms）：把 4ms 唤醒上的探测节流到 ≈20Hz（护栏本身也要便宜）。 */
const HEALTH_PROBE_MIN_GAP_MS = 50;

/** 健康探测状态（模块级，零分配）。 */
let healthLastProbeMs = -1;
let healthLastAuthVa = -1;
let healthAuthVersionAtMs = -1;
let healthRtSeqAtMs = -1;
/** 上次探测见到的渲染采样序号（stall 判据 ③）。 */
let healthLastRtSeq = -1;
let healthAuthStallLogged = false;
let healthRtStallLogged = false;
let healthGuardLogCount = 0;
/** 出生点 Y（world-json 记录；null = 未知 → 用死亡阈值/兜底常数当地板）。 */
let authSpawnY: number | null = null;
/** 最近收到的死亡阈值（set-death-threshold 记录；world 重建后重放用）。 */
let authDeathY: number | null = null;

/** 记录 world-json 出生点 + 重放死亡阈值（由 dispatch 的 world-json 处理器调用）。 */
function noteWorldSpawn(spawnY: number, deathY: number | null): void {
  authSpawnY = Number.isFinite(spawnY) ? spawnY : null;
  authDeathY = deathY;
}

/** 权威 y 下坠地板：出生点优先 → 死亡阈值 → 兜底常数（channel 无关，纯本地状态）。 */
function authYFloor(): number {
  if (authSpawnY !== null) return authSpawnY - AUTH_Y_FLOOR_MARGIN;
  if (authDeathY !== null) return authDeathY - AUTH_Y_FLOOR_MARGIN;
  return AUTH_Y_FLOOR_FALLBACK;
}

/** 上报一条健康告警（复用既有 `error` 消息路径；主线程已有 console 消费）。 */
function postHealth(msg: string): void {
  postMessage({ type: 'error', message: `[authority-health] ${msg}` } satisfies MainMessage);
}

/**
 * 权威健康探测（每次 `getPhys` = 每个真实 tick 调用一次；节流到 ≈20Hz）。
 *
 * 三项检查：
 * 1. **有限性/越界**：`phys.state()` 出现非有限值，或 y < authYFloor() → 权威跑飞，
 *    直接 `respawn()` 拉回出生点（权威侧自愈；渲染侧不受任何影响，下一 tick 起
 *    权威速度恢复正常，calibrateVelocity 自然跟上）。
 * 2. **发布停滞**：> AUTH_STALL_MS 没有新的 V_A（`readAuthoritative` 版本号不变）。
 * 3. **采样停滞**：> RT_STALL_MS 渲染采样通道没有新样本（`rtCurSeq` 不前进）。
 *    2/3 只告警（不猜原因、不动状态），复用既有 `error` 消息 → 主线程 console。
 *
 * 注意覆盖边界：本探测挂在权威自驱循环上——若**自驱循环本身**死亡（进程级），
 * 探测也随之停摆；那种故障由主线程 HUD/帧流可观测，不在本护栏职责内。
 */
function healthProbe(): void {
  const now = performance.now();
  if (healthLastProbeMs >= 0 && now - healthLastProbeMs < HEALTH_PROBE_MIN_GAP_MS) return;
  healthLastProbeMs = now;
  const sh = shared.current;

  // ① 权威状态有限性 / 越界地板
  const cur = phys.current;
  if (cur) {
    const s = cur.state() as {
      posX: number;
      posY: number;
      posZ: number;
      velX: number;
      velY: number;
      velZ: number;
    };
    const floor = authYFloor();
    const finite =
      Number.isFinite(s.posX) && Number.isFinite(s.posY) && Number.isFinite(s.posZ) &&
      Number.isFinite(s.velX) && Number.isFinite(s.velY) && Number.isFinite(s.velZ);
    if (!finite || s.posY < floor) {
      // ⚠️ **只告警，绝不 respawn**（回归修复）：本护栏的注释宣称「绝不写渲染」，
      // 但 `respawn()` 会把权威速度**归零**（`player.rs:212` `velocity = [0,0,0]`），
      // 而 `calibrateVelocity` 每渲染帧把权威速度写进渲染物理 → 归零后渲染速度
      // 被硬拽到 0（1–2 帧的「操作不跟手/乱」）。同时 respawn 把权威瞬移回出生点，
      // 与渲染当前位置永久分离（渲染侧无对应复位），碰撞事件随后全在错误位置产生。
      // 真实缺陷（death_y 静默丢失导致权威无尽下坠）已由 worker-dispatch 的
      // `lastDeathY` 记忆 + world 重建后重放修复，本护栏不再是必要自愈手段。
      if (healthGuardLogCount < 8) {
        healthGuardLogCount++;
        postHealth(
          `权威状态异常（finite=${finite} y=${s.posY.toFixed(1)} floor=${floor.toFixed(1)}）` +
            `→ 仅告警（不 respawn：respawn 会经速度之主通道把渲染速度归零）`,
        );
      }
    }
  }

  if (!sh) return;

  // ② 权威发布停滞（V_A 是跨线程共享槽，读它不依赖任何本地猜测）
  const auth = sh.readAuthoritative();
  if (auth) {
    if (auth.va !== healthLastAuthVa) {
      healthLastAuthVa = auth.va;
      healthAuthVersionAtMs = now;
      healthAuthStallLogged = false;
    } else if (
      healthAuthVersionAtMs >= 0 &&
      now - healthAuthVersionAtMs > AUTH_STALL_MS &&
      !healthAuthStallLogged
    ) {
      healthAuthStallLogged = true;
      postHealth(`权威帧停滞 >${AUTH_STALL_MS}ms（V_A=${auth.va} 未前进）`);
    }
  }

  // ③ 渲染采样通道停滞（rtCurSeq 由 rtSample() 在真实 tick 内刷新）
  if (healthRtSeqAtMs < 0) {
    healthRtSeqAtMs = now;
  } else if (rtCurSeq !== healthLastRtSeq) {
    healthLastRtSeq = rtCurSeq;
    healthRtSeqAtMs = now;
    healthRtStallLogged = false;
  } else if (now - healthRtSeqAtMs > RT_STALL_MS && !healthRtStallLogged) {
    healthRtStallLogged = true;
    postHealth(`渲染采样通道停滞 >${RT_STALL_MS}ms（seq=${rtCurSeq} 未前进）`);
  }
}

/** 权威自驱循环（setTimeout 4ms + 固定步长累积器 + 碰撞事件；ts-shared）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  // rtTickGate = 唤醒边界探测 + 惰性采样读标记（本函数每次真实 tick 被调一次）；
  // healthProbe 复用同一次调用（自带 50ms 节流）——不新增定时器、不新增消息。
  getPhys: () => (rtTickGate(), healthProbe(), phys.current),
  post: (msg) => postMessage(msg),
  renderTrajectory: renderTrajectorySource,
});
/** tickRate 变更（面板）→ 权威固定步长即时生效。 */
physicsWorker.params.onTickRateChange = (rate) => {
  // D8 同款修复：步长未变（面板每帧/每条配置消息都会带 tickRate）时不得 reset()，
  // 否则累积器余数 + 一次唤醒区间被永久删除 = 权威时钟只跑墙钟的 ≈31%（「tick 计算滑落」）。
  if (authLoop.setFixedDt(rate)) authLoop.reset();
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
  // 健康护栏：本图出生点 Y（越界地板基准）+ 已记忆的死亡阈值
  onWorldSpawn: (spawnY, deathY) => {
    noteWorldSpawn(spawnY, deathY);
  },
  // 健康护栏：死亡阈值收到即记（无出生点信息时当地板用）
  onDeathThreshold: (value) => {
    authDeathY = value;
  },
  onConfigApplied: () => {
    // 面板手动参数覆盖（全量默认参数可能盖掉面板值——覆盖优先）
    physicsWorker.reapplyParams();
  },
  onExtraMessage: (msg) => physicsWorker.handleMessage(msg as WorkerMessage | { type?: string }),
});
