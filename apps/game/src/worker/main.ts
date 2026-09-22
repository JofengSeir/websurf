/**
 * 权威 Worker 入口：装配「权威物理线」，并把消息协议整体交给共享层分发器。
 *
 * ## 角色
 * 本 Worker 持有唯一权威 `PhysWorld`（`apps/game/pkg/websurf_wasm.js` 的导出），由
 * `src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop` 以固定步长独立推进，每个步长向跨线程
 * 状态通道写一帧权威帧。主线程另持自己的渲染物理实例
 * （`apps/game/src/renderer/renderer-main.ts` 的 `predPhys`），两侧只经通道交换输入与帧：
 * 本文件不渲染，也不反写主线程位置。
 *
 * ## 装配顺序（本文件自上而下）
 * 1. `config`：`createConfig()` 建本 Worker 自己的配置副本，面板下发经 `config` 消息部分更新；
 * 2. `shared` / `phys` 两个槽：`init` 消息写 `shared`（状态通道），`world-json` 写 `phys`（权威实例）；
 * 3. `renderTrajectorySource`：渲染轨迹采样源，作为 `createAuthLoop` 的 `renderTrajectory` 注入；
 * 4. 权威健康守护：越界与停滞探测，挂在注入 `createAuthLoop` 的 `getPhys` 上；
 * 5. `createAuthLoop`（`src/ts-shared/auth/auth-loop.ts`）；
 * 6. `createWorkerDispatch`（`src/ts-shared/auth/worker-dispatch.ts`）——消息分支的实现方；
 * 7. `self.onmessage`：先做本文件自己的 `world-json` 诊断计时，再整体转交 `dispatch`。
 *
 * ## 消息协议（方向 / `type` 字面量 / 载荷）
 * 主线程 → 本 Worker：
 * - `init`：`{ shared: SharedArrayBuffer | null }`。分发器据此调
 *   `createWorkerSharedState`（`src/ts-shared/auth/shared-state.ts`）建通道，主线程侧对称地调
 *   `createMainSharedState`；`shared` 为 `null` 时两侧同时落到 `MsgState` 的 `postMessage`
 *   回退通道。本工程发送方：`apps/game/src/app.ts`；
 * - `wasm-init`：`{ wasmB64?: string; wasmUrl?: string; mtzB64?: string }`。内嵌 base64 优先，
 *   其次按 URL 取字节，两者皆缺则整条消息被丢弃。发送方同 `init`；
 * - `input`：`{ dx: number; dy: number; keys: number; rt?: number; rx?: number; ry?: number;
 *   rz?: number; ri0?: number; repoch?: number }`。仅回退通道使用（SAB 模式走共享槽），由
 *   `MsgState.addInput` 发出；后六项是随消息搭车的渲染采样；
 * - `world-json`：`{ brushJson: string; triJson: string; teleportJson: string;
 *   spawn: { x: number; y: number; z: number; yawDeg: number } }`。据此建（或重建）全部已注入实例；
 *   发送方：`apps/game/src/app.ts` 的 BSP 装载段；
 * - `config`：`{ section: keyof RuntimeConfig; patch: Record<string, unknown> }`。`physics` /
 *   `input` 两段的 patch 先做 snake_case → camelCase 键名归一（含 `jump_height` 的值换算）再写
 *   配置副本，`player` 段改走 `set_hull`。发送方：`apps/game/src/input/input-bridge.ts`；
 * - `respawn`：无载荷；`teleport`：`{ target: number }`（出生点索引）。发送方同上；
 * - `sync-render-state`：`{ state: { posX: number; posY: number; posZ: number; yaw: number;
 *   pitch: number; velX: number; velY: number; velZ: number; onGround: boolean };
 *   teleport?: boolean }`。`teleport === false` 走常规重锚（速度与 `onGround` 取权威自身现读值），
 *   缺省或 `true` 走全态注入。发送方：`apps/game/src/app.ts`；
 * - `set-spawn-points`：`{ json: string }`（出生点列表 JSON，只影响 `teleport_to_spawn` 的目标集）；
 * - `set-death-threshold`：`{ value: number }`（掉落死亡线，写入全部已注入实例）。
 *
 * 本工程内无发送方、但分发器仍有对应分支的三条 `type`：`teleport-to-pos`
 * （`{ pos: [number, number, number]; yaw?: number }`）、`set-mode`
 * （`{ mode: 'coupled' | 'decoupled' | 'tick'; state?: SyncRenderStateLike }`）与 `set-hold`
 * （`{ hold?: HoldState | null; release?: SavePointLike }`）；未识别的 `type` 落到分发器的
 * `onExtraMessage` 扩展点，本文件未注入该钩子。
 *
 * 本 Worker → 主线程：
 * - `phys-frame`：`{ va: number; frame: AuthFrame }`。仅回退通道使用，由
 *   `MsgState.writeAuthoritative` 发出；SAB 模式下主线程直接读共享槽；
 * - `phys-event`：`{ kind: 'land' | 'blocked'; pos: number[]; yawDeg: number; pitchDeg: number;
 *   vel?: number[]; timeMs: number }`。由 `createAuthLoop` 的碰撞事件经 `post` 发出；
 * - `error`：`{ message: string }`；`mode-ack`：`{ mode: string; appliedAtMs: number }`
 *   （两条由分发器发出）；
 * - `health-log`：`{ message: string }`。本文件的健康告警，主线程交面板控制台消费；
 * - `world-build-ms`：`{ ms: number }`；`world-parse-ms`：`{ brush: number; tri: number }`。
 *   本文件的诊断计时，主线程只打 console。
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
import { createConfig, applyConfigPatch } from '../config.js';
import type { RuntimeConfig } from '../config.js';

const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽：`init` 消息注入 `createWorkerSharedState` 的结果，收到 `init` 之前为 null。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威 `PhysWorld` 槽：`world-json` 分支建实例后写入，实例方法全部经它调用。 */
const phys: { current: PhysWorldLike | null } = { current: null };

/** 本 Worker 的面板参数 → wasm `set_params` / `set_hull`。映射式在
 * `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams`（physics 段与 input 段两个入参）；
 * 调用点是分发器的 `world-json` 尾部与除 `player` 外的 `config` 分支。主线程持另一份 config
 * 副本并各自映射，两端的 tickRate 同值下发。 */
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

// ── 渲染轨迹采样源：把权威 tick 的发布位置投到渲染折线上 ─────────────────
//
// 主线程每 rAF 写一条「渲染采样」到通道尾槽（SAB：RT_SEQ seqlock；MsgState：随 `input`
// 消息搭车）；本 Worker 读它，把权威时刻投影到主线程那条「渲染曲线」的折线上。
//
// 热路径约束：全程 f64/Number 域运算，无 BigInt 装箱、无每唤醒分配；自驱循环按毫秒级
// 定时器唤醒，而固定步长由 tickRate 折算，故多数唤醒不 tick——采样只在**该唤醒的首个 tick**
// 惰性读一次。

/** 采样龄上限（单位 = 本 Worker 的读取次数）：连续这么多次读都没等到新样本即判配对陈旧。
 * 刻意用「读取计数」而非跨时钟比较——渲染时钟与本 Worker 时钟的偏移不作假设。 */
const RT_STALE_READS = 8;
/** 偏移估计滑动窗（观测数上限；下界 = 到达延迟下界，即「渲染时刻相对本 Worker 的最前位」）。 */
const RT_OFFSET_WINDOW = 64;

/** 偏移估计滑窗（预分配：热路径零分配）。 */
const rtLagWindow = new Float64Array(RT_OFFSET_WINDOW);
let rtLagCount = 0;
let rtLagCursor = 0;
let rtOffset = 0; // 偏移估计下界 = min(lag)；「尚无观测」由 rtLagCount === 0 判定，本值不参与该判定

/** 唯一复用的读缓冲（`readRenderSample` 只往它写，故读路径零分配）。 */
const rtOut: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
/** 缓存的有效配对（相邻两样本；`seq <= 0` = 缺参）。 */
const rtPrev: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
const rtCur: RenderSample = { t: 0, x: 0, y: 0, z: 0, i0: -1, epoch: 0, seq: 0 };
let rtCurSeq = 0;
let rtGapReads = 0;
let rtValid = false;
/**
 * 缓存配对（rtPrev→rtCur）所属的失效世代。
 * `rtCur.epoch` = 样本自称的世代；本值 = **服务该样本那一刻**复检过的世代
 * （主线程 `bumpSampleEpoch` 与 Worker 下一次读槽之间存在窗口，见 rtServeEpochOk）。
 */
let rtPairEpoch = 0;
/** 配对建立时的到达延迟（ms）：把 rtCur.t 换算成「配对时刻的渲染时钟估计」。 */
let rtPairLagMs = 0;
/** 惰性读守卫：true = 本次唤醒尚未读槽（rtTickGate 置位）。 */
let rtWakeUnread = true;
/** 上次唤醒边界探测的时刻（performance.now()；-1 = 尚未探测）。 */
let rtLastGateMs = -1;
/** 唤醒边界判据（ms）：与上次 `getPhys` 的间隔 ≥ 本值即视为「新唤醒」——同一次唤醒内连续
 *  补步的相邻 `getPhys` 间隔远小于它。 */
const RT_WAKE_GAP_MS = 1;

/** 同唤醒内多 tick 的读取合并窗（ms；短于最快渲染帧间隔，避免漏掉真新样本）。 */
const RT_READ_MIN_GAP_MS = 2;

/** 上次采样读的时刻（performance.now()；用于同唤醒内的读取合并）。 */
let rtLastReadMs = -1;

/** 丢弃缓存配对（世代变化 / 陈旧 / reset）——保留 offset 估计（渲染时钟连续，无需重学）。 */
function rtInvalidate(): void {
  rtValid = false;
  rtCurSeq = 0;
  rtPairEpoch = 0;
  rtPairLagMs = 0;
  rtPrev.seq = 0;
  rtCur.seq = 0;
}

/**
 * 唤醒边界检测 + 惰性读标记，挂在本 Worker 的 `getPhys` 上：`auth-loop` 的每个真实步长都会
 * 取一次 `getPhys`，而本函数自身不返回实例。
 *
 * 判据只用本 Worker 的墙钟：相邻两次 `getPhys` 的间隔达到 RT_WAKE_GAP_MS 即认为进入了新的
 * 一次唤醒（置位 rtWakeUnread，让下一次真实 tick 重读），间隔更小则视为同一次唤醒内的连续
 * 补步。不 tick 的唤醒根本不调 `getPhys`，因而零读零成本。
 */
function rtTickGate(): PhysWorldLike | null {
  const now = performance.now();
  if (rtLastGateMs < 0 || now - rtLastGateMs >= RT_WAKE_GAP_MS) rtWakeUnread = true;
  rtLastGateMs = now;
  return null; // null → 调用方的 ?? 落到真 phys；本函数只做边界探测与惰性读标记
}

/** 记一次观测并重算滑动窗下界（最小到达延迟）写入 rtOffset。 */
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

/** 该唤醒的首个 tick（或距上次读超过 RT_READ_MIN_GAP_MS）才读一次共享槽；全程 f64/Number
 * 域、零分配。同一唤醒内的后续 tick 复用已读到的配对。 */
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
    // 无新样本：读取计数老化（连续超过 RT_STALE_READS 次读都没有新样本 → 配对陈旧）
    if (rtValid && ++rtGapReads > RT_STALE_READS) rtInvalidate();
    return;
  }
  rtCurSeq = seq;
  rtGapReads = 0;
  rtPairEpoch = rtOut.epoch; // 本配对自称的世代（服务前还会用 readRenderEpoch 复检）
  // 配对新鲜度基准：**只在配对更新时**刷新（见 rtPairLagMs 注释）
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
  // 偏移观测：渲染时刻 − 本 Worker 的到达时刻。下界即「渲染时间轴相对本 Worker 的
  // 最前位置」——再叠加到达延迟即当前渲染时钟估计（见 rtInstantToTau）。
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
 * 服务前世代复检：缓存配对必须仍属当前失效世代。
 *
 * 主线程 `apps/game/src/renderer/renderer-main.ts` 的 `bumpSampleEpoch` 在 resetTo / 换图 /
 * noclip / respawn 时把世代 +1 并清样本槽，渲染物理随即出现在新世界；而 Worker 缓存的
 * 那对样本仍属旧世界，`rtSampleAtTau` 又会把 τ 钳制到这对样本的 `[rtPrev.t, rtCur.t]`，
 * 于是一个看似合法的钳制点会被当成当前位置发布（旧世界线上的位置）。复检失败即丢弃配对并
 * 让本 tick 返回 null（不跨世代插值），调用方 `auth-loop` 回退到权威自身位置发布本帧。
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

// ── 权威健康守护（只告警，不写渲染）──────────────────────────────────
//
// 为什么需要：权威是「速度之主」——`calibrateVelocity`
// （`src/ts-shared/phys/authority-calibrator.ts`，本工程经
// `apps/game/src/renderer/renderer-main.ts` 的 `RendererMain.calibrateVelocity` 调用）每个渲染
// 帧把权威速度写进渲染物理，故权威一旦跑飞（非有限值 / y 越界 / 发布停更），渲染会被逐帧拖
// 向同一个坏速度而无法自愈。本守护在权威侧探测这几类异常，只上报：不改权威状态、不 respawn、
// 不碰渲染。
//
// 挂载点：复用权威自驱循环已有的唤醒（与 `rtTickGate` 同一次 `getPhys` 调用），不新增定时器。
// 告警经 `health-log` 消息回主线程，由主线程交面板控制台消费。

/** 权威 y 下坠地板余量（HU）：地板取「死亡阈值 − 本值」，无阈值时取「出生点 − 本值」。 */
const AUTH_Y_FLOOR_MARGIN = 4096;
/** 既无死亡阈值也无出生点信息时的兜底地板（HU）：足够深，正常地图的合法下落不会触及。 */
const AUTH_Y_FLOOR_FALLBACK = -100_000;
/** 权威发布停滞阈值（ms）：超过它没有新 V_A = 权威线停更。 */
const AUTH_STALL_MS = 500;
/** 渲染采样通道停滞阈值（ms）：超过它没有新样本 = 主线程采样停更。 */
const RT_STALL_MS = 250;
/** 健康探测最小间隔（ms）：把自驱唤醒上的探测节流到约 20Hz（护栏自身也要便宜）。 */
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
/** 出生点 Y（`world-json` 处理器记录；null = 未知 → 地板改用死亡阈值或兜底常数）。 */
let authSpawnY: number | null = null;
/** 最近收到的死亡阈值（`set-death-threshold` 记录；`world-json` 重建实例后重放用）。 */
let authDeathY: number | null = null;

/** 记录本图出生点 Y 与已记忆的死亡阈值（由分发器的 `world-json` 处理器经 `onWorldSpawn`
 * 调用；出生点非有限值时按未知处理）。 */
function noteWorldSpawn(spawnY: number, deathY: number | null): void {
  authSpawnY = Number.isFinite(spawnY) ? spawnY : null;
  authDeathY = deathY;
}

/** 权威 y 下坠地板：死亡阈值优先 → 出生点 → 兜底常数。只读本 Worker 的模块级状态，
 *  与通道实现（SAB / 消息回退）无关。 */
function authYFloor(): number {
  // death_y（地图声明的死亡线）优先：surf 的合法滑落落差可以超过「出生点 − 余量」，
  // 用出生点作基准会把正常滑行判成跑飞。
  if (authDeathY !== null) return authDeathY - AUTH_Y_FLOOR_MARGIN;
  if (authSpawnY !== null) return authSpawnY - AUTH_Y_FLOOR_MARGIN;
  return AUTH_Y_FLOOR_FALLBACK;
}

/** 上报一条健康告警：发 `health-log` 消息，主线程 `apps/game/src/app.ts` 的 `health-log`
 *  分支调 `pushHealthLog` 交给面板控制台（本路径不打 console）。 */
function postHealth(msg: string): void {
postMessage({ type: 'health-log', message: `[authority-health] ${msg}` });
}

/**
 * 权威健康探测（挂在 `getPhys` 上，随权威真实步长调用；按 HEALTH_PROBE_MIN_GAP_MS 节流）。
 *
 * 三项检查，**全部只上报、不动任何状态**：
 * 1. 有限性 / 越界：`phys.state()` 的位置或速度出现非有限值，或 `posY` 低于 authYFloor()
 *    → 发一条 `health-log`（累计条数上限 healthGuardLogCount）；
 * 2. 发布停滞：超过 AUTH_STALL_MS 没有新的 V_A（`readAuthoritative` 的版本号不变）；
 * 3. 采样停滞：超过 RT_STALL_MS 渲染采样通道没有新样本（rtCurSeq 不前进）。
 * 2 / 3 各自只告警一次，直到版本号或序号重新前进才复位。
 *
 * 覆盖边界：本探测挂在权威自驱循环上——若自驱循环本身停摆，探测也随之停摆；那种故障由
 * 主线程侧的帧流可观测，不在本护栏职责内。
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
      // 只告警、不 respawn：`respawn()` 会把权威速度归零（`src/phys/mod.rs` 的
      // `respawn` 写 `velocity = [0,0,0]`），而 `calibrateVelocity` 每个渲染帧把权威速度
      // 写进渲染物理 → 归零后渲染速度被拽到 0；同时 respawn 把权威瞬移回出生点，与渲染
      // 当前位置分离（渲染侧无对应复位），其后的碰撞事件都产生在错误位置。
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

/** 权威自驱循环：定时器唤醒 + 固定步长累积器 + 碰撞事件，实现全在
 *  `src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop`（此处只注入环境）。 */
const authLoop = createAuthLoop({
  get shared() {
    return shared.current;
  },
  // 本取值器在每个真实步长被调用一次：rtTickGate 做唤醒边界探测与惰性采样读标记，
  // healthProbe 复用同一次调用（自带节流）；返回值即被推进的权威实例。
  getPhys: () => (rtTickGate(), healthProbe(), phys.current),
  post: (msg) => postMessage(msg),
  renderTrajectory: renderTrajectorySource,
});

const dispatch = createWorkerDispatch({
  shared,
  phys,
  authLoop,
  // 面板 tickRate 直取（不做偏移）：`auth-loop` 的 setFixedDt 以它折算固定步长
  // （fixedDt = 1 / max(tickRate, 1) 秒），故面板显示值、下发值与权威步长三者同值。
  getConfigTickRate: () => config.physics.tickRate,
  applyConfigPatch: (section, patch) =>
    applyConfigPatch(config, section as keyof RuntimeConfig, patch),
  syncParamsToWasm,
  createPhysWorld: () => new PhysWorld(),
  // 胶水的 `initSync` 接受 `{ module }` 包装形态（`apps/game/pkg/websurf_wasm.d.ts`），而分发器
  // 以裸 `ArrayBuffer` 调用本注入（`WorkerDispatchEnv.initSync` 的共享层签名）；此处转一次
  // 形态。因注入点形参类型仍是 `ArrayBuffer`，按接口做一次双重断言。
  initSync: ((module: ArrayBuffer) =>
    initSync({ module } as unknown as ArrayBuffer)) as (module: ArrayBuffer) => void,
  post: (msg) => postMessage(msg),
  // 诊断：`world-json` 的 Worker 内处理耗时（从收到该消息到世界构建完成即本回调）。与主线程侧
  // 的 postMessage 耗时配对，可把「权威迟迟不活」拆成「结构化克隆传输」与「Worker 内 JSON
  // 解析 + build_world」两段。
  onWorldBuilt: () => {
    if (worldJsonRecvAt > 0) {
      const ms = performance.now() - worldJsonRecvAt;
      worldJsonRecvAt = 0;
      postMessage({ type: 'world-build-ms', ms: +ms.toFixed(1) });
    }
  },
  // 健康护栏：记录本图出生点 Y（越界地板基准）与已记忆的死亡阈值
  onWorldSpawn: (spawnY, deathY) => {
    noteWorldSpawn(spawnY, deathY);
  },
  // 健康护栏：死亡阈值收到即记（分发器在写实例之前调用本钩子）
  onDeathThreshold: (value) => {
    authDeathY = value;
  },
});

/**
 * 诊断用：本 Worker **收到** `world-json` 的时刻，`onWorldBuilt` 用它算出「解析 + build_world」
 * 的 Worker 内耗时。计时放在 Worker 内而不跨线程相减，是因为两端 `performance.now()` 基准不同、
 * 不可直接相减。
 */
let worldJsonRecvAt = 0;

self.onmessage = (e: MessageEvent<unknown>): void => {
  const d = e.data as { type?: string; brushJson?: string; triJson?: string } | null;
  if (d?.type === 'world-json') {
    worldJsonRecvAt = performance.now();
    // 诊断：两个大 JSON 的**解析**耗时（JS 侧 `JSON.parse` 作代理测量）。与 `world-build-ms`
    // （解析 + build_world）相减即得 build_world（含建索引）的净耗时。
    const t0 = performance.now();
    try { if (d.brushJson) JSON.parse(d.brushJson); } catch { /* 诊断用，忽略 */ }
    const brushMs = performance.now() - t0;
    const t1 = performance.now();
    try { if (d.triJson) JSON.parse(d.triJson); } catch { /* 诊断用，忽略 */ }
    const triMs = performance.now() - t1;
    postMessage({ type: 'world-parse-ms', brush: +brushMs.toFixed(1), tri: +triMs.toFixed(1) });
  }
  dispatch(e);
};
