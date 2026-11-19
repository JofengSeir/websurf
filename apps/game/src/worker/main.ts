/**
 * game Worker 入口：装配权威物理线，并把消息协议整体交给共享层。
 *
 * 2026-11-18 起，**通用装配已下沉到共享层** `src/ts-shared/app/worker-runtime.ts`
 * （`createWorkerRuntime`）：权威自驱循环（`createAuthLoop`）、消息分发
 * （`createWorkerDispatch`）、渲染轨迹采样源与权威健康守护原先在 debug/game 两个 Worker 入口
 * 各自复制了一份，现在只有共享层一份。本文件只保留 game 特有的：
 * - config 副本与参数映射（`syncParamsToWasm`：全部物理参数（含 D3 新增的 pushOut 两项）
 *   从 `config.physics` 取）；
 * - `initSync` 的 `{ module }` 包装形态转换（`apps/game/pkg/websurf_wasm.d.ts` 的胶水签名）；
 * - `world-json` 的 Worker 内诊断计时（`world-build-ms` / `world-parse-ms`）。
 *
 * 角色不变：本 Worker 持有唯一权威 `PhysWorld`，由共享 `createAuthLoop` 以固定步长独立推进，
 * 每个步长向跨线程状态通道写一帧权威帧。主线程另持渲染物理实例（`predPhys`），两侧只经通道
 * 交换输入与帧：本文件不渲染，也不反写主线程位置。
 */

/// <reference lib="webworker" />

import { PhysWorld, initSync } from '../../pkg/websurf_wasm.js';
import type { ShmState, MsgState } from '../../../../src/ts-shared/auth/shared-state.js';
import type { PhysWorldLike } from '../../../../src/ts-shared/auth/auth-loop.js';
import { createWorkerRuntime } from '../../../../src/ts-shared/app/worker-runtime.js';
import { createConfig, applyConfigPatch, buildPhysicsParams } from '../config.js';
import type { RuntimeConfig } from '../config.js';

const config: RuntimeConfig = createConfig();

/** 跨线程状态通道槽：`init` 消息注入 `createWorkerSharedState` 的结果，收到 `init` 之前为 null。 */
const shared: { current: ShmState | MsgState | null } = { current: null };
/** 权威 `PhysWorld` 槽：`world-json` 分支建实例后写入，实例方法全部经它调用。 */
const phys: { current: PhysWorldLike | null } = { current: null };

/** 本 Worker 的面板参数 → wasm `set_params` / `set_hull`。映射式在 `apps/game/src/config.ts`
 * 的 `buildPhysicsParams`（共享 14 键 + `push_out` / `push_out_only_when_solid` 两项）；
 * 调用点是分发器的 `world-json` 尾部与除 `player` 外的 `config` 分支。主线程持另一份 config
 * 副本并各自映射，两端的 tickRate 同值下发。 */
function syncParamsToWasm(): void {
  if (!phys.current) return;
  const params = buildPhysicsParams(config);
  phys.current.set_params(JSON.stringify(params));
  const pl = config.player;
  phys.current.set_hull(pl.halfWidth, pl.standHeight, pl.duckHeight);
}

/**
 * 诊断用：本 Worker **收到** `world-json` 的时刻，`onWorldBuilt` 用它算出「解析 + build_world」
 * 的 Worker 内耗时。计时放在 Worker 内而不跨线程相减，是因为两端 `performance.now()` 基准不同、
 * 不可直接相减。
 */
let worldJsonRecvAt = 0;

/** 地图 `servercommand` 的物理参数名（面板名）→ game config 字段名。
 *
 * 只有 `airAccelerate` 与 config 不同名（config 沿用历史短名 `airAccel`），其余同形；
 * 认不出的参数名直接忽略（映射表未列出的 servercommand 参数不会写入 config）。
 */
const MAP_PARAM_TO_CONFIG: Record<string, keyof RuntimeConfig['physics']> = {
  maxSpeed: 'maxSpeed',
  accelerate: 'accelerate',
  airAccelerate: 'airAccel',
  friction: 'friction',
  stopSpeed: 'stopSpeed',
  gravity: 'gravity',
  bhopSpeedClamp: 'bhopSpeedClamp',
};

/** 共享 Worker 运行时：权威循环/分发/采样/健康守护都在共享层，这里只注入 game 的映射与诊断。 */
const runtime = createWorkerRuntime({
  shared,
  phys,
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
  hooks: {
    /** 收到 `world-json` 之前记诊断起点（大 JSON 的解析耗时由本函数自己测）。 */
    onBeforeMessage: (data) => {
      const d = data as { type?: string; brushJson?: string; triJson?: string } | null;
      if (d?.type !== 'world-json') return;
      worldJsonRecvAt = performance.now();
      // 诊断（默认关闭，T-220）：大 JSON 的解析耗时（`JSON.parse` 代理测量）与 `world-build-ms`
      // 相减即得 build_world 的净耗时；`build_world` 内部会再解析一遍，故只有置
      // `globalThis.__vbspWorldParseTiming` 为 true 时才测。
      const measureParse = (globalThis as { __vbspWorldParseTiming?: boolean }).__vbspWorldParseTiming === true;
      const t0 = performance.now();
      try { if (d.brushJson && measureParse) JSON.parse(d.brushJson); } catch { /* 诊断用，忽略 */ }
      const brushMs = performance.now() - t0;
      const t1 = performance.now();
      try { if (d.triJson && measureParse) JSON.parse(d.triJson); } catch { /* 诊断用，忽略 */ }
      const triMs = performance.now() - t1;
      if (measureParse) postMessage({ type: 'world-parse-ms', brush: +brushMs.toFixed(1), tri: +triMs.toFixed(1) });
    },
    /** 世界构建完成：回一条 Worker 内处理耗时，供主线程与 postMessage 耗时配对。 */
    onWorldBuilt: () => {
      if (worldJsonRecvAt > 0) {
        const ms = performance.now() - worldJsonRecvAt;
        worldJsonRecvAt = 0;
        postMessage({ type: 'world-build-ms', ms: +ms.toFixed(1) });
      }
    },
    /** 地图 convar（`sv_airaccelerate` / `sv_enablebunnyhopping` 等）落到 config 副本：
     * 之后任何一次 `syncParamsToWasm` / 换图重放都会带上地图值，不会被配置默认值冲掉。 */
    onMapPhysicsParam: (name, value) => {
      const field = MAP_PARAM_TO_CONFIG[name];
      if (!field) return;
      (config.physics as unknown as Record<string, unknown>)[field] = value;
      syncParamsToWasm();
    },
  },
});

self.onmessage = runtime.dispatch;
