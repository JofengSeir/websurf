/**
 * Worker 运行时（**三端共用一份**）：权威物理线的装配、渲染轨迹采样源、健康守护、
 * 消息分发与 `self.onmessage` 挂载。
 *
 * 背景（2026-11-18 共用收敛 P1）：`apps/debug/src/worker/main.ts`（509 行）与
 * `apps/game/src/worker/main.ts`（526 行）此前各自复制了同一套 ~380 行逻辑
 * （渲染轨迹采样源 / 健康守护 / createAuthLoop / createWorkerDispatch 装配），只靠人肉同步。
 * 两份调用顺序逐字相同，任何改一边的修复都会在另一边漂移——审计已列为最大结构重复之一。
 *
 * 本模块把这段共有逻辑收成一个 `createWorkerRuntime()`；各 app 的 Worker 入口只剩：
 * 1. 建自己的 config 副本（`createConfig()`）；
 * 2. 提供一个 `syncParamsToWasm()`（config → wasm 参数映射，app 自己的 config 形状）；
 * 3. 按需注入扩展钩子（debug 的物理面板协调器 / game 的 world-json 诊断计时）；
 * 4. `self.onmessage = runtime.dispatch`（或先做 app 自己的诊断再转交）。
 *
 * 各 app 的差异一律走注入（不靠复制）：
 * - 参数映射：`syncParamsToWasm`（debug 面板无 walk/crouch/autobhop 配置项，game 有；
 *   两者的默认值差异在 app 的 config，不在本模块）；
 * - 面板协调器 / 诊断计时 / 内嵌纹理包留存：`hooks.*`；
 * - 面板 tickRate 变化后的 `setFixedDt + reset`：用返回的 `runtime.authLoop` 自行绑定。
 *
 * 渲染轨迹采样与健康守护的注释语义原样保留（见各自函数头），保证迁移零行为变化。
 */

/// <reference lib="webworker" />

import type { ShmState, MsgState, RenderSample } from '../auth/shared-state.js';
import {
  createAuthLoop,
  type AuthLoop,
  type PhysWorldLike,
  type RenderTrajectorySource,
} from '../auth/auth-loop.js';
import { createWorkerDispatch } from '../auth/worker-dispatch.js';
import { makeReadyMessage } from '../auth/worker-ready.js';

/** 跨线程状态通道槽（`init` 消息写入；`authLoop`、渲染轨迹采样与健康守护共用）。 */
export interface WorkerSharedSlot {
  current: ShmState | MsgState | null;
}

/** 权威实例槽（`world-json` 构建后写入；`syncParamsToWasm` 与健康守护读它）。 */
export interface WorkerPhysSlot {
  current: PhysWorldLike | null;
}

/** 扩展钩子：全部可选，缺省即无操作（game 只用其中一部分）。 */
export interface WorkerRuntimeHooks {
  /** `wasm-init` 的第一步（debug 用它留存内嵌纹理包 base64）。 */
  onWasmInit?: (msg: { wasmB64?: string; wasmUrl?: string; mtzB64?: string }) => void;
  /** 世界重建完成（主实例）：debug 把面板协调器绑到新实例；game 记录 build 耗时。 */
  onWorldBuilt?: (phys: PhysWorldLike) => void;
  /** 世界出生点信息（健康守护已记录；app 可再记一份）。 */
  onWorldSpawn?: (spawnY: number, deathY: number | null) => void;
  /** 死亡阈值收到（健康守护已记录；app 可再记一份）。 */
  onDeathThreshold?: (value: number) => void;
  /** `config` 应用完之后（debug 用它重放面板覆盖值）。 */
  onConfigApplied?: () => void;
  /** 未识别消息的扩展点（debug 的物理面板消息在这里交给协调器；返回 true = 已处理）。 */
  onExtraMessage?: (msg: unknown) => boolean | void;
  /** 地图 `servercommand` 映射出的物理参数（debug 把它写进面板覆盖表并回传快照；
   *  game 把它写进 config 副本后重新同步 wasm）。 */
  onMapPhysicsParam?: (name: string, value: number | boolean) => void;
  /** 收到每条消息之前（game 用它给 `world-json` 记诊断起点）。返回 false 可拦下该条消息。 */
  onBeforeMessage?: (msg: unknown) => boolean | void;
}

export interface CreateWorkerRuntimeOptions {
  /** 状态通道槽（由 `init` 消息写入；本模块只读）。 */
  shared: WorkerSharedSlot;
  /** 权威实例槽（本模块负责写入；app 不直接写）。 */
  phys: WorkerPhysSlot;
  /** 面板 tickRate（用于 auth-loop 的固定步长折算）。 */
  getConfigTickRate: () => number;
  /** 分发器的 `config` 分支：把 patch 写进 app 的 config 副本。 */
  applyConfigPatch: (section: string, patch: Record<string, unknown>) => void;
  /** app 自己的 config → wasm `set_params` / `set_hull` 映射。 */
  syncParamsToWasm: () => void;
  /** 建一个本 app 的 wasm `PhysWorld`（debug/game 的 pkg 不同）。 */
  createPhysWorld: () => PhysWorldLike;
  /** app 的 wasm `initSync`（game 需要转 `{ module }` 包装形态，debug 直接传）。 */
  initSync: (buf: ArrayBuffer) => void;
  /** 回主线程的通道（缺省 `postMessage`）。 */
  post?: (msg: unknown) => void;
  /** 扩展钩子。 */
  hooks?: WorkerRuntimeHooks;
}

/** `createWorkerRuntime()` 的产物。 */
export interface WorkerRuntime {
  /** 权威自驱循环（app 可绑定 `setFixedDt` 等）。 */
  authLoop: AuthLoop;
  /** 消息分发器（`self.onmessage = runtime.dispatch`）。 */
  dispatch: (event: MessageEvent<unknown>) => void;
}

// ── 渲染轨迹采样源：把权威 tick 的发布位置投到渲染折线上 ─────────────────
//
// 主线程每渲染帧写一条采样（共享内存路径写渲染采样槽的 seqlock；回退路径随 `input`
// 消息携带），本 Worker 取相邻两条样本组成「配对」，把权威时钟瞬时值换算成渲染时钟 τ，
// 再在配对区间内线性插值出发布位置，使权威位置与渲染位置落在同一条折线上。
//
// 热路径约束：全部运算在 Number 域（不引入 BigInt 装箱）、读缓冲与滑窗都是闭包内预分配
// （每次读不分配）；采样只在真正的 tick 上惰性读一次——毫秒级唤醒与面板步长不同拍，多数
// 唤醒没有 tick。

/** 配对陈旧门限（单位 = 读槽次数）：同一个样本序号被连续读到超过本值即丢弃配对。
 *  判据刻意用读计数，不比较两侧时钟。 */
const RT_STALE_READS = 8;
/** 到达延迟滑窗长度（观测条数）：窗口内取下界作为偏移估计。 */
const RT_OFFSET_WINDOW = 64;
/** 唤醒边界判据（ms）：与上次探测的间隔达到本值即视为新唤醒。 */
const RT_WAKE_GAP_MS = 1;
/** 同唤醒内多次 tick 的读取合并窗（ms）：与上次读槽间隔小于本值的后续 tick 复用刚读到的配对。 */
const RT_READ_MIN_GAP_MS = 2;
/** 配对陈旧门限（ms）：τ 超过「配对时刻估计」这么多即判配对没跟上，放弃本 tick 投影。 */
const RT_SERVE_STALE_MS = 50;

/** 权威 y 下坠地板余量（HU）：地板 = 「死亡阈值 − 本值」或「出生点 Y − 本值」。 */
const AUTH_Y_FLOOR_MARGIN = 4096;
/** 既无死亡阈值也无出生点信息时的兜底地板（HU）。 */
const AUTH_Y_FLOOR_FALLBACK = -100_000;
/** 权威发布停滞阈值（ms）：超过它权威帧版本号仍不前进 = 权威线停更。 */
const AUTH_STALL_MS = 500;
/** 渲染采样通道停滞阈值（ms）：超过它样本序号仍不前进 = 主线程采样停更。 */
const RT_STALL_MS = 250;
/** 健康探测最小间隔（ms）：把挂在真实步长上的探测节流到 20Hz。 */
const HEALTH_PROBE_MIN_GAP_MS = 50;

/**
 * 建一个 Worker 运行时：装配权威物理线并把 `self.onmessage` 交给共享分发器。
 *
 * 调用方典型形态：
 * ```ts
 * const config = createConfig();
 * const runtime = createWorkerRuntime({
 *   shared, phys,
 *   getConfigTickRate: () => config.physics.tickRate,
 *   applyConfigPatch: (section, patch) => applyConfigPatch(config, section as keyof RuntimeConfig, patch),
 *   syncParamsToWasm,
 *   createPhysWorld: () => new PhysWorld(),
 *   initSync,
 *   hooks: { ... },
 * });
 * self.onmessage = runtime.dispatch;
 * ```
 */
export function createWorkerRuntime(options: CreateWorkerRuntimeOptions): WorkerRuntime {
  const { shared, phys } = options;
  const post = options.post ?? ((msg: unknown) => postMessage(msg));
  const hooks = options.hooks ?? {};

  // ── 渲染轨迹采样源状态 ──
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
   * 需要复检的原因：主线程重置采样槽（`resetRenderSample`）会把世代 +1 并清零样本序号，
   * 而本 Worker 要到下一次读槽才知道；「读到新样本」与「用配对服务 τ」之间还隔着一次
   * tick，窗口内配对仍属旧世界。
   */
  let rtPairEpoch = 0;
  /**
   * 建立配对时的到达延迟（ms；= 样本自报渲染时刻 `t` − 本 Worker 读到它的时刻）。
   *
   * 用途：把 `rtCur.t` 换算成「配对建立时刻的渲染时钟估计」= `rtCur.t + rtPairLagMs`，
   * 供 `rtSampleAtTau` 判断 τ 是否已经跑出配对太久（`RT_SERVE_STALE_MS`）——τ 远超该估计
   * 说明渲染已前进而配对没跟上（渲染采样停更或节流），此时本 tick 不投影、发布位置回退
   * 权威自身位置，而不是把陈旧采样点当成当前位置发布出去。
   *
   * 只在配对更新时刷新：若每次读都刷新，那些「读到的还是同一个旧样本」的读数会把陈旧配对
   * 的估计值抬到现在，陈旧判定不再成立。
   */
  let rtPairLagMs = 0;
  /** 惰性读守卫：true = 本次唤醒尚未读槽（由 `rtTickGate` 置位、`rtSample` 消费）。 */
  let rtWakeUnread = true;
  /** 上次唤醒边界探测的时刻（`performance.now()`；-1 = 尚未探测）。 */
  let rtLastGateMs = -1;
  /** 上次读槽的时刻（`performance.now()`；-1 = 尚未读）。 */
  let rtLastReadMs = -1;

  /** 丢弃缓存配对（世代变化 / 配对陈旧 / 通道未开始）。偏移估计保留——它描述两个时钟的
   *  相对位置，与某一对样本无关。 */
  function rtInvalidate(): void {
    rtValid = false;
    rtCurSeq = 0;
    rtPairEpoch = 0;
    rtPairLagMs = 0;
    rtPrev.seq = 0;
    rtCur.seq = 0;
  }

  /** 唤醒边界探测（挂在 `getPhys` 取值器上）：判据只用本 Worker 的墙钟——与上次调用间隔
   *  达到 `RT_WAKE_GAP_MS` 即视为新唤醒并置位 `rtWakeUnread`；同一唤醒内的后续调用沿用
   *  该标记，于是 `rtSample` 只在本次唤醒的第一次调用处真正读槽。 */
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

  /** 读一次渲染采样并维护缓存配对（惰性：只有真正的 tick 会走到这里）。按
   *  `readRenderSample` 的返回值分支：正数 = 样本序号；0 = 通道未开始；-1 = 读写冲突。 */
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
      if (rtValid && ++rtGapReads > RT_STALE_READS) rtInvalidate();
      return;
    }
    rtCurSeq = seq;
    rtGapReads = 0;
    rtPairEpoch = rtOut.epoch; // 本配对自称的世代（服务前还会用 readRenderEpoch 复检）
    rtPairLagMs = rtOut.t - arrival; // 配对新鲜度基准：只在配对更新时刷新
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
    rtObserveLag(rtOut.t - arrival);
  }

  /** 把权威时钟瞬时值换算到渲染时钟域（尚无观测时返回 -1）；内部先读采样，故读槽天然惰性。 */
  function rtInstantToTau(workerInstMs: number): number {
    rtSample(); // 惰性：仅真正的 tick 会走到这里（rtSample 内做同唤醒合并）
    if (rtLagCount === 0) return -1; // 尚无观测（采样通道未开始）
    return workerInstMs + rtOffset;
  }

  /** 服务前世代复检：缓存配对必须仍属当前世代。失败即丢弃配对并返回 false（本 tick 不投影，
   *  `auth-loop` 回退到权威自身位置发布本帧）。 */
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
    if (!rtServeEpochOk()) return null; // ① 世代复检：跨世代不插值
    const rtPairNow = rtCur.t + rtPairLagMs;
    if (tauMs - rtPairNow > RT_SERVE_STALE_MS) return null; // ② 新鲜度门：配对没跟上则不投影
    const tau = tauMs < rtPrev.t ? rtPrev.t : tauMs > rtCur.t ? rtCur.t : tauMs;
    const f = (tau - rtPrev.t) / (rtCur.t - rtPrev.t);
    return {
      x: rtPrev.x + (rtCur.x - rtPrev.x) * f,
      y: rtPrev.y + (rtCur.y - rtPrev.y) * f,
      z: rtPrev.z + (rtCur.z - rtPrev.z) * f,
    };
  }

  /** 注入 `createAuthLoop` 的渲染轨迹钩子对象（闭包常量，零分配）。 */
  const renderTrajectorySource: RenderTrajectorySource = {
    tickInstantToTau: rtInstantToTau,
    sampleAtTau: rtSampleAtTau,
  };

  // ── 权威健康守护（只读探测 + 告警，不写渲染）────────────────────────────
  //
  // 权威是速度之源：`calibrateVelocity` 每渲染帧把权威速度写进渲染物理，因此权威一旦跑飞
  // （出现非有限值 / 越过下界地板 / 发布停更），渲染会被逐帧拖向同一个坏速度。
  //
  // 本守护挂在**已有的**自驱唤醒上（取值器 `getPhys` → `rtTickGate`），不新增定时器；告警
  // 复用既有的 `health-log` 消息类型，不新增消息类型；触发动作只发消息——不写权威实例、不写
  // 渲染。

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

  /** 权威 y 下界：死亡阈值优先，其次出生点基准，最后兜底常数（纯本地状态，与通道无关）。 */
  function authYFloor(): number {
    // 死亡阈值是地图自带的死亡线，优先采用；没有它才退到出生点基准。
    if (authDeathY !== null) return authDeathY - AUTH_Y_FLOOR_MARGIN;
    if (authSpawnY !== null) return authSpawnY - AUTH_Y_FLOOR_MARGIN;
    return AUTH_Y_FLOOR_FALLBACK;
  }

  /** 发一条健康告警（`health-log` 消息；主线程写面板「权威健康」控制台）。 */
  function postHealth(msg: string): void {
    post({ type: 'health-log', message: `[authority-health] ${msg}` });
  }

  /** 权威健康探测（由 `getPhys` 取值器触发，按 `HEALTH_PROBE_MIN_GAP_MS` 节流）。
   *  三项检查：有限性/越界、权威发布停滞、渲染采样停滞；全部只发告警。 */
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
        // 只告警、不动权威实例：`respawn()` 会把权威速度归零，而 `calibrateVelocity` 每渲染帧
        // 把权威速度写进渲染物理，归零会连带把渲染速度拉平。
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

  /** 权威自驱循环（定时器唤醒 + 绝对欠账排空固定步长 + 碰撞事件；实现见
   *  `src/ts-shared/auth/auth-loop.ts`）。取值器顺带挂 `rtTickGate`（唤醒边界探测与惰性读
   *  标记）与 `healthProbe`（自带节流），两者都复用这一次取值调用，不新增定时器。 */
  const authLoop = createAuthLoop({
    get shared() {
      return shared.current;
    },
    // rtTickGate 做唤醒边界探测；healthProbe 复用同一次取值（自带 50ms 节流）
    getPhys: () => (rtTickGate(), healthProbe(), phys.current),
    post: (msg) => post(msg),
    renderTrajectory: renderTrajectorySource,
  });

  const dispatch = createWorkerDispatch({
    shared,
    phys,
    authLoop,
    getConfigTickRate: () => options.getConfigTickRate(),
    applyConfigPatch: (section, patch) =>
      options.applyConfigPatch(section as string, patch as Record<string, unknown>),
    syncParamsToWasm: () => options.syncParamsToWasm(),
    createPhysWorld: () => options.createPhysWorld(),
    initSync: (buf) => options.initSync(buf),
    post: (msg) => post(msg),
    // `init` 处理完之后回一条 `ready`（主线程据此更新状态栏 / 识别旧构建）。
    onInit: () => {
      post(makeReadyMessage());
    },
    onWasmInit: (m) => {
      hooks.onWasmInit?.(m);
    },
    onWorldBuilt: (p) => {
      hooks.onWorldBuilt?.(p);
    },
    onWorldSpawn: (spawnY, deathY) => {
      authSpawnY = Number.isFinite(spawnY) ? spawnY : null;
      authDeathY = deathY;
      hooks.onWorldSpawn?.(spawnY, deathY);
    },
    onDeathThreshold: (value) => {
      authDeathY = value;
      hooks.onDeathThreshold?.(value);
    },
    onConfigApplied: () => {
      hooks.onConfigApplied?.();
    },
    onExtraMessage: (msg) => hooks.onExtraMessage?.(msg) === true,
    onMapPhysicsParam: (name, value) => hooks.onMapPhysicsParam?.(name, value),
  });

  /** `self.onmessage`：先给 app 一条观察消息的机会（诊断计时等），再整体交给分发器。 */
  function handleMessage(event: MessageEvent<unknown>): void {
    if (hooks.onBeforeMessage && hooks.onBeforeMessage(event.data) === false) return;
    dispatch(event);
  }

  return { authLoop, dispatch: handleMessage };
}
