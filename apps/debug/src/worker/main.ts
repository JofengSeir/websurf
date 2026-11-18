/**
 * debug Worker 入口：装配权威物理线（自驱循环 + 消息分发 + 渲染轨迹采样 + 健康守护）。
 *
 * 2026-11-18 起，**通用装配已下沉到共享层** `src/ts-shared/app/worker-runtime.ts`
 * （`createWorkerRuntime`）：debug 与 game 的 Worker 入口曾经各自复制 ~380 行完全相同的
 * 渲染轨迹采样源、健康守护与 dispatch 装配，只靠人肉同步。本文件现在只保留 debug 独有的部分：
 * - config 副本与参数映射（`syncParamsToWasm`：全部物理参数从 `config.physics` 取，
 *   默认值统一声明在 `src/ts-shared/phys/param-defaults.ts`）；
 * - 物理面板协调器 `PhysicsWorker`（参数/碰撞箱写权威实例 + `physics-snapshot` 回传）；
 * - 内嵌纹理包留存（`setMtzB64`）；
 * - 面板 tickRate 变化 → 权威固定步长（`authLoop.setFixedDt` + `reset`）。
 *
 * 位置与角度的分工（双线耦合的不变量）：渲染位置/朝向在偏离阈值内不被权威改写，权威的
 * 发布位置改取渲染折线上的采样点；速度方向相反——权威是速度之源，主线程每渲染帧按权威
 * 速度校准渲染物理。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import type { ShmState, MsgState } from '../../../../src/ts-shared/auth/shared-state.js';
import type { PhysWorldLike } from '../../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerRuntime } from '../../../../src/ts-shared/app/worker-runtime.js';
import { buildPhysicsParams } from '../../../../src/ts-shared/phys/params.js';
import type { WorkerMessage } from './worker-types.js';
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
 *  - 走路/蹲走/自动连跳/连跳限速同样来自 `config.physics`（默认值由
 *    `src/ts-shared/phys/param-defaults.ts` 统一声明）。2026-11-18 前这里写死 130/85/true/true，
 *    与面板默认值各存一份、改一侧就会分叉；用户要求「面板上有的都必须可调，写死的都是错的」。
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
      walkSpeed: p.walkSpeed,
      crouchSpeed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhopSpeedClamp: p.bhopSpeedClamp,
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

/** 共享 Worker 运行时：权威自驱循环、消息分发、渲染轨迹采样与健康守护都在共享层，
 *  这里只注入 debug 自己的 config 映射与面板扩展点。 */
const runtime = createWorkerRuntime({
  shared,
  phys,
  getConfigTickRate: () => config.physics.tickRate,
  applyConfigPatch: (section, patch) =>
    applyConfigPatch(config, section as keyof RuntimeConfig, patch),
  syncParamsToWasm,
  createPhysWorld: () => new PhysWorld(),
  initSync,
  hooks: {
    /** `wasm-init` 的第一步：取走内嵌纹理包 base64（本工程只留存，不消费）。 */
    onWasmInit: (m) => {
      setMtzB64(m.mtzB64); // 留存内嵌纹理包 base64（Worker 侧无读取点）
    },
    /** 世界重建完成（主实例）：把面板协调器绑到新实例并回传一次快照。 */
    onWorldBuilt: (p) => {
      physicsWorker.attachWorld(p as PhysWorld);
    },
    /** `config` 应用完之后重放面板覆盖（面板手动值优先于配置默认值）。 */
    onConfigApplied: () => {
      physicsWorker.reapplyParams();
    },
    /** 未识别消息的扩展点：物理面板消息在这里交给协调器。 */
    onExtraMessage: (msg) => physicsWorker.handleMessage(msg as WorkerMessage | { type?: string }),
    /** 地图 `servercommand` 映射出的物理参数：以「地图」来源进面板覆盖表并回传快照。 */
    onMapPhysicsParam: (name, value) => {
      physicsWorker.applyMapParam(name, value);
    },
  },
});

/** 面板 tickRate 变更 → 权威固定步长。`setFixedDt` 返回 false 表示步长未变，此时不得
 *  `reset()`：`config` 消息每条都带 tickRate，清累积器会丢掉当前欠账与本次唤醒区间。 */
physicsWorker.params.onTickRateChange = (rate) => {
  if (runtime.authLoop.setFixedDt(rate)) runtime.authLoop.reset();
};

self.onmessage = runtime.dispatch;
