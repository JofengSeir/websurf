/**
 * debug Worker 入口：把权威物理线接到「自驱循环 + 消息分发 + 渲染轨迹采样 + 健康守护」四条链上。
 *
 * 装配与职责（物理算法本身全在共享层，本文件只做接线）：
 * - `createAuthLoop`（`src/ts-shared/auth/auth-loop.ts`）：权威 `PhysWorld` 的唯一推进者。
 *   循环每 4ms 唤醒一次（`setTimeout`），按绝对欠账排空固定步长——单次唤醒最多 64 步、
 *   保留欠账上限 250ms；每个真实步长读一次输入、推进一次物理、发布一帧权威帧，并在着地
 *   上升沿或速度骤降时发出 `phys-event`。固定步长来自面板 `tickRate`（见
 *   `physicsWorker.params.onTickRateChange`），初值 1/64 秒。
 * - `createWorkerDispatch`（`src/ts-shared/auth/worker-dispatch.ts`）：`self.onmessage` 的
 *   全部消息处理；本文件只交出槽对象、配置读写与七个钩子。
 * - 渲染轨迹采样：主线程每渲染帧写一条采样（共享内存路径写渲染采样槽的 seqlock；回退路径
 *   随 `input` 消息携带），本文件读它并在渲染折线上取点，作为权威帧的**发布位置**，使权威
 *   位置与渲染位置落在同一条折线上。
 * - 权威健康守护：复用同一个 4ms 唤醒（经 `getPhys` 取值器），只读状态、只发 `health-log`
 *   告警，不碰权威实例、不碰渲染。
 *
 * 位置与角度的分工（双线耦合的不变量）：渲染位置/朝向在偏离阈值内不被权威改写，权威的
 * 发布位置改取渲染折线上的采样点；速度方向相反——权威是速度之源，主线程每渲染帧按权威
 * 速度校准渲染物理。
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

/** Worker 侧 config 副本：由分发层的 `config` 分支部分更新；
 *  `getConfigTickRate` 与 `syncParamsToWasm` 都读它。 */
const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽：`init` 消息写入（共享内存 → `ShmState`，否则 `MsgState`）；
 *  `authLoop`、渲染轨迹采样与健康守护共用它。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威实例槽：`world-json` 构建后写入；`syncParamsToWasm` 与健康守护读它。 */
const phys: { current: PhysWorldLike | null } = { current: null };

/** 物理面板协调器（参数/碰撞箱写权威实例 + `physics-snapshot` 回传）。 */
const physicsWorker = new PhysicsWorker();

/** 把 config 里的物理参数映射成 wasm `set_params` JSON，并写碰撞箱。
 *
 *  - `tickRate` 不在这里：它是 JS 驱动层的固定步长，走 `physicsWorker.params.onTickRateChange`；
 *  - 字段与主线程 `apps/debug/src/physics/prediction-params.ts` 的 `buildDebugPredictionParams`
 *    同构（同一份参数喂双端物理），映射本身收敛在 `src/ts-shared/phys/params.ts` 的
 *    `buildPhysicsParams`；
 *  - 面板没有独立的走路/蹲走配置项，这两个值写死为面板定义默认值 130 / 85，自动连跳与连跳
 *    限速同样写死为 true。
 */
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
      // 面板无独立走路/蹲走配置：写死为 PARAM_DEFS 的默认值 130 / 85
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

// ── 渲染轨迹采样源：把权威帧的发布位置投到渲染折线上 ──
//
// 主线程每渲染帧写一条采样（共享内存路径写渲染采样槽；回退路径随 `input` 消息携带）。
// 本 Worker 取相邻两条样本组成「配对」，把权威时钟瞬时值换算成渲染时钟 τ，再在配对区间内
// 线性插值出发布位置。
//
// 热路径约束：全部运算在 Number 域（不引入 BigInt 装箱）、读缓冲与滑窗都是模块级预分配
// （每次读不分配）；采样只在真正的 tick 上惰性读一次——4ms 唤醒与面板步长不同拍，多数唤醒
// 没有 tick。

/** 配对陈旧门限（单位 = 读槽次数）：同一个样本序号被连续读到超过本值即丢弃配对。
 *  判据刻意用读计数，不比较两侧时钟。 */
const RT_STALE_READS = 8;
/** 到达延迟滑窗长度（观测条数）：窗口内取下界作为偏移估计。 */
const RT_OFFSET_WINDOW = 64;

/** 到达延迟滑窗（预分配；写满后按游标循环覆盖）。 */
const rtLagWindow = new Float64Array(RT_OFFSET_WINDOW);
let rtLagCount = 0;
let rtLagCursor = 0;
let rtOffset = 0; // 滑窗下界；仅在 rtLagCount > 0 时被读

/** 读缓冲（`readRenderSample` 的零分配契约：调用方预分配，函数把载荷写进来）。 */
const rtOut: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
/** 缓存配对：相邻两条采样；任一侧 `seq <= 0` 即表示该侧缺参、配对不可用。 */
const rtPrev: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
const rtCur: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
/** 采样读状态：`rtCurSeq` = 最近读到的样本序号，`rtGapReads` = 同一序号连续被读到的次数，
 *  `rtValid` = 缓存配对是否可用。 */
let rtCurSeq = 0;
let rtGapReads = 0;
let rtValid = false;
/**
 * 缓存配对（`rtPrev` → `rtCur`）建立时样本自称的世代。
 *
 * 与 `rtCur.epoch` 的区别：后者是「读到这条样本时它自称的世代」，本值是配对身份的标记，
 * 服务一条 τ 之前要再用 `readRenderEpoch()` 复检（见 `rtServeEpochOk`）。
 *
 * 需要复检的原因：主线程重置采样槽（`resetRenderSample`，经
 * `apps/debug/src/renderer/renderer-main.ts` 的 `bumpSampleEpoch`）会把世代 +1 并清零样本
 * 序号，而本 Worker 要到下一次读槽才知道；「读到新样本」与「用配对服务 τ」之间还隔着一次
 * tick，窗口内配对仍属旧世界。
 */
let rtPairEpoch = 0;
/**
 * 建立配对时的到达延迟（ms；= 样本自报渲染时刻 `t` − 本 Worker 读到它的时刻）。
 *
 * 用途：把 `rtCur.t` 换算成「配对建立时刻的渲染时钟估计」= `rtCur.t + rtPairLagMs`，供
 * `rtSampleAtTau` 判断 τ 是否已经跑出配对太久（`RT_SERVE_STALE_MS`）——τ 远超该估计值说明
 * 渲染已前进而配对没跟上（渲染采样停更或节流），此时本 tick 不投影、发布位置回退权威自身
 * 位置，而不是把陈旧采样点当成当前位置发布出去。
 *
 * 只在配对更新时刷新：若每次读都刷新，那些「读到的还是同一个旧样本」的读数会把陈旧配对的
 * 估计值抬到现在，陈旧判定不再成立。
 */
let rtPairLagMs = 0;
/** 惰性读守卫：true = 本次唤醒尚未读槽（由 `rtTickGate` 置位、`rtSample` 消费）。 */
let rtWakeUnread = true;
/** 上次唤醒边界探测的时刻（`performance.now()`；-1 = 尚未探测）。 */
let rtLastGateMs = -1;
/** 唤醒边界判据（ms）：与上次探测的间隔达到本值即视为新唤醒。 */
const RT_WAKE_GAP_MS = 1;

/** 同唤醒内多次 tick 的读取合并窗（ms）：与上次读槽间隔小于本值的后续 tick 复用刚读到的配对。 */
const RT_READ_MIN_GAP_MS = 2;

/** 上次读槽的时刻（`performance.now()`；-1 = 尚未读）。 */
let rtLastReadMs = -1;

/** 丢弃缓存配对（世代变化 / 配对陈旧 / 通道未开始）：清有效性、样本序号、世代与到达延迟。
 *  偏移估计保留——它描述两个时钟的相对位置，与某一对样本无关。 */
function rtInvalidate(): void {
  rtValid = false;
  rtCurSeq = 0;
  rtPairEpoch = 0;
  rtPairLagMs = 0;
  rtPrev.seq = 0;
  rtCur.seq = 0;
}

/**
 * 唤醒边界探测（挂在传给 `createAuthLoop` 的 `getPhys` 取值器上）。
 *
 * 取值器每次被读都会调用本函数：`loop` 在模式门之后的前置守卫里每唤醒读一次，`stepPhysics`
 * 与 `holdStep` 在每个真实步长顶置再各读一次。判据只用本 Worker 的墙钟——与上次调用间隔
 * 达到 `RT_WAKE_GAP_MS` 即视为新唤醒并置位 `rtWakeUnread`；同一唤醒内的后续调用沿用该标记，
 * 于是 `rtSample` 只在本次唤醒的第一次调用处真正读槽。没有 tick 的唤醒（4ms 轮询 vs 面板
 * 步长，多数唤醒如此）即便读了取值器也不会读槽；一次唤醒内的追赶爆发（多步）同样只读一次。
 */
function rtTickGate(): PhysWorldLike | null {
  const now = performance.now();
  if (rtLastGateMs < 0 || now - rtLastGateMs >= RT_WAKE_GAP_MS) rtWakeUnread = true;
  rtLastGateMs = now;
  return null; // null：调用方用 ?? 落到真实例；本函数只做边界探测与读标记
}

/** 记一条到达延迟观测：窗口未满则追加，已满则按游标覆盖，随后重算窗口下界。 */
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

/**
 * 读一次渲染采样并维护缓存配对（惰性：只有真正的 tick 会走到这里）。
 *
 * 按 `readRenderSample` 的返回值分支：
 * - 正数 = 样本序号：序号与上次相同只累计 `rtGapReads`（超过 `RT_STALE_READS` 判配对陈旧并
 *   丢弃）；序号前进则滚动配对、记下世代与到达延迟、并入一条偏移观测；
 * - 0 = 通道未开始（未写 / 已重置）：丢弃配对；
 * - -1 = 读写冲突：本次不更新，保留原配对（或本就缺参）。
 *
 * 读缓冲、配对缓冲与滑窗都是模块级对象/数组，本函数不分配。
 */
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
    if (seq === 0) rtInvalidate(); // 0 = 通道未开始（未写 / 已重置）
    return; // -1 = 读写冲突：本 tick 不更新，保留原配对
  }
  if (rtValid && rtOut.epoch !== rtCur.epoch) rtInvalidate(); // 世代变化 → 旧配对全部失效
  if (seq === rtCurSeq) {
    // 无新样本：读取计数老化（连续读到同一序号超过门限 → 配对陈旧）
    if (rtValid && ++rtGapReads > RT_STALE_READS) rtInvalidate();
    return;
  }
  rtCurSeq = seq;
  rtGapReads = 0;
  rtPairEpoch = rtOut.epoch; // 本配对自称的世代（服务前还会用 readRenderEpoch 复检）
  // 配对新鲜度基准：只在配对更新时刷新（理由见 rtPairLagMs 的注释）。
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
  // 偏移观测：渲染时刻 − 本 Worker 的到达时刻；下界即渲染时间轴相对本 Worker 的最前位置，
  // 叠加到达延迟即当前渲染时钟估计（见 rtInstantToTau）。
  rtObserveLag(rtOut.t - arrival);
}

/** 把权威时钟瞬时值换算到渲染时钟域（尚无观测时返回 -1）；内部先读采样，故读槽天然惰性。 */
function rtInstantToTau(workerInstMs: number): number {
  rtSample(); // 惰性：仅真正的 tick 会走到这里（rtSample 内做同唤醒合并）
  if (rtLagCount === 0) return -1; // 尚无观测（采样通道未开始）
  return workerInstMs + rtOffset;
}

/** 配对陈旧门限（ms）：τ 超过「配对时刻估计」这么多即判配对没跟上，放弃本 tick 投影。 */
const RT_SERVE_STALE_MS = 50;

/**
 * 服务前世代复检：缓存配对必须仍属当前世代。
 *
 * 复检失败的后果：丢弃配对并返回 false，`rtSampleAtTau` 随之返回 null，`auth-loop` 按契约
 * 回退到权威自身位置发布本帧，下一 tick 用新世代的样本重建配对后恢复投影。跨世代插值会把
 * 旧世界折线上的一个点当成当前位置发布出去，因此这里宁可本 tick 不投影。
 *
 * 为什么必须在服务时复检：世代自增发生在主线程，本 Worker 要等下一次读槽才知道它变了，而
 * 「读到新样本」与「服务 τ」之间还隔着一次 tick；本复检只读一次世代槽，把该窗口压到零。
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

/** 在渲染折线上按 τ 取点：先过世代复检与新鲜度两道门，再把 τ 钳制到配对端点后线性插值。
 *  不外推、不跨世代——任一条件不满足即返回 null。 */
function rtSampleAtTau(tauMs: number): { x: number; y: number; z: number } | null {
  if (!rtValid || rtPrev.seq <= 0 || rtCur.seq <= 0 || rtCur.t <= rtPrev.t) return null;
  // ① 世代复检（见 rtServeEpochOk）：跨世代不插值。
  if (!rtServeEpochOk()) return null;
  // ② 新鲜度门：τ 超前「配对时刻估计」太多 = 配对没跟上（渲染采样停更或节流），本 tick 不投影。
  //    不能只看 τ > rtCur.t：τ 本就有样本到达延迟带来的小幅超前，那部分由下面的钳制吸收。
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

/** 注入 `createAuthLoop` 的渲染轨迹钩子对象（模块级常量，零分配）。 */
const renderTrajectorySource: RenderTrajectorySource = {
  tickInstantToTau: rtInstantToTau,
  sampleAtTau: rtSampleAtTau,
};

// ── 权威健康守护（只读探测 + 告警，不写渲染）────────────────────────────
//
// 权威是速度之源：`src/ts-shared/phys/authority-calibrator.ts` 的 `calibrateVelocity` 每
// 渲染帧把权威速度写进渲染物理，因此权威一旦跑飞（出现非有限值 / 越过下界地板 / 发布停更），
// 渲染会被逐帧拖向同一个坏速度。
//
// 本守护挂在**已有的** 4ms 自驱唤醒上（取值器 `getPhys` → `rtTickGate`），不新增定时器；告警
// 复用既有的 `health-log` 消息类型，不新增消息类型；触发动作只发消息——不写权威实例、不写渲染。

/** 权威 y 下坠地板余量（HU）：地板 = 「死亡阈值 − 本值」或「出生点 Y − 本值」。 */
const AUTH_Y_FLOOR_MARGIN = 4096;
/** 既无死亡阈值也无出生点信息时的兜底地板（HU）。 */
const AUTH_Y_FLOOR_FALLBACK = -100_000;
/** 权威发布停滞阈值（ms）：超过它权威帧版本号仍不前进 = 权威线停更。 */
const AUTH_STALL_MS = 500;
/** 渲染采样通道停滞阈值（ms）：超过它样本序号仍不前进 = 主线程采样停更。 */
const RT_STALL_MS = 250;
/** 健康探测最小间隔（ms）：把挂在 4ms 唤醒上的探测节流到 20Hz。 */
const HEALTH_PROBE_MIN_GAP_MS = 50;

/** 健康探测状态（模块级标量，零分配）：上次探测时刻；上次见到的权威帧版本号与「版本号最后
 *  变化的时刻」；上次见到的采样序号与「序号最后变化的时刻」；两个停滞告警的已发标记；越界
 *  告警已发条数（上限见 `healthProbe`）。 */
let healthLastProbeMs = -1;
let healthLastAuthVa = -1;
let healthAuthVersionAtMs = -1;
let healthRtSeqAtMs = -1;
let healthLastRtSeq = -1;
let healthAuthStallLogged = false;
let healthRtStallLogged = false;
let healthGuardLogCount = 0;
/** 本图出生点 Y（`world-json` 记录；非有限值记为 null）。 */
let authSpawnY: number | null = null;
/** 最近一次收到的死亡阈值（`set-death-threshold` 记录）。 */
let authDeathY: number | null = null;

/** 记录本图出生点 Y 与已记忆的死亡阈值（`onWorldSpawn` 钩子调用）。 */
function noteWorldSpawn(spawnY: number, deathY: number | null): void {
  authSpawnY = Number.isFinite(spawnY) ? spawnY : null;
  authDeathY = deathY;
}

/** 权威 y 下界：死亡阈值优先，其次出生点基准，最后兜底常数（纯本地状态，与通道无关）。 */
function authYFloor(): number {
  // 死亡阈值是地图自带的死亡线，优先采用；没有它才退到出生点基准。
  if (authDeathY !== null) return authDeathY - AUTH_Y_FLOOR_MARGIN;
  if (authSpawnY !== null) return authSpawnY - AUTH_Y_FLOOR_MARGIN;
  return AUTH_Y_FLOOR_FALLBACK;
}

/** 发一条健康告警（`health-log` 消息；主线程写面板「权威健康」控制台）。 */
function postHealth(msg: string): void {
  // health-log：面板内「权威健康」控制台消费，不写 console。
  postMessage({ type: 'health-log', message: `[authority-health] ${msg}` } satisfies MainMessage);
}

/**
 * 权威健康探测（由 `getPhys` 取值器触发，按 `HEALTH_PROBE_MIN_GAP_MS` 节流）。
 *
 * 三项检查：
 * 1. 有限性 / 越界：`phys.state()` 的六个分量出现非有限值，或 y 低于 `authYFloor()`；
 * 2. 权威发布停滞：`readAuthoritative()` 的版本号超过 `AUTH_STALL_MS` 不前进；
 * 3. 渲染采样停滞：`rtCurSeq` 超过 `RT_STALL_MS` 不前进。
 *
 * 三项都只发告警：越界一项的告警条数上限为 8；两项停滞各在每轮停滞里只发一条（版本号 /
 * 序号一旦前进即重置该标记）。
 *
 * 覆盖边界：探测挂在权威自驱循环的取值器上，自驱循环自身停摆时探测也随之停摆，那种故障只能
 * 由主线程侧的帧流观测。
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
      // 只告警、不动权威实例：`respawn()` 会把权威速度归零（`src/phys/player.rs` 的
      // `Player::respawn` 写 `velocity = [0, 0, 0]`），而 `calibrateVelocity` 每渲染帧把权威
      // 速度写进渲染物理，归零会连带把渲染速度拉平；同时权威被瞬移回出生点，与渲染当前位置
      // 分离，其后的碰撞事件都落在错误位置。
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

  // ② 权威发布停滞（版本号取自跨线程共享槽的读接口）
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

  // ③ 渲染采样通道停滞（`rtCurSeq` 由 rtSample 在真实 tick 内刷新）
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

/** 权威自驱循环（4ms 唤醒 + 绝对欠账排空固定步长 + 碰撞事件；实现见
 *  `src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop`）。
 *  取值器顺带挂两个钩子：`rtTickGate`（唤醒边界探测与惰性读标记）与 `healthProbe`
 *  （自带节流）——两者都复用这一次取值调用，不新增定时器。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  // rtTickGate 做唤醒边界探测；healthProbe 复用同一次取值（自带 50ms 节流）
  getPhys: () => (rtTickGate(), healthProbe(), phys.current),
  post: (msg) => postMessage(msg),
  renderTrajectory: renderTrajectorySource,
});
/** 面板 tickRate 变更 → 权威固定步长。`setFixedDt` 返回 false 表示步长未变，此时不得
 *  `reset()`：`config` 消息每条都带 tickRate，清累积器会丢掉当前欠账与本次唤醒区间。 */
physicsWorker.params.onTickRateChange = (rate) => {
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
  // ── 本工程注入的钩子 ─────────────────────────────────────────
  /** `init` 处理完之后回一条 `ready`（主线程据此更新状态栏）。 */
  onInit: () => {
    postMessage({ type: 'ready' } satisfies MainMessage);
  },
  /** `wasm-init` 的第一步：取走内嵌纹理包 base64（本工程只留存，不消费）。 */
  onWasmInit: (m) => {
    setMtzB64(m.mtzB64); // 留存内嵌纹理包 base64（Worker 侧无读取点）
  },
  /** 世界重建完成（主实例）：把面板协调器绑到新实例并回传一次快照。 */
  onWorldBuilt: (p) => {
    physicsWorker.attachWorld(p as PhysWorld);
  },
  /** 健康守护：记录本图出生点 Y（越界地板基准）+ 分发层已记忆的死亡阈值。 */
  onWorldSpawn: (spawnY, deathY) => {
    noteWorldSpawn(spawnY, deathY);
  },
  /** 健康守护：死亡阈值收到即记（无出生点信息时当地板基准）。 */
  onDeathThreshold: (value) => {
    authDeathY = value;
  },
  /** `config` 应用完之后重放面板覆盖（面板手动值优先于配置默认值）。 */
  onConfigApplied: () => {
    physicsWorker.reapplyParams();
  },
  /** 未识别消息的扩展点：物理面板消息在这里交给协调器。 */
  onExtraMessage: (msg) => physicsWorker.handleMessage(msg as WorkerMessage | { type?: string }),
});
