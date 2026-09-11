/**
 * 单测：t4 worker 装配链（dispatch 三分支 + 参数单写链 + G3 三实例同参 + P-tick-6）。
 *
 * 覆盖（captain t4 验收 #1/#4/#5 + t3-memo §4.5 不变式 + P-tick-5/6）：
 * - §P1 world-json 装配：G3 三实例（phys/tickPhys/scratch）同建同参 + 旧实例 free
 *   （P5 无泄漏）+ 首帧可见 + onWorldRebuilt（t4 钩子）；
 * - §P2 P-tick-6 周期解析：resolveAuthTickRate（**生产唯一实现源**，main.ts
 *   getConfigTickRate 的实体）tick = raw 直译（1/64 **精确**，防耦合 +3 渗入）、
 *   coupled = 面板 + 3；world-json/config 两处生效点同步断言；
 * - §P3 W-GAP-1 参数链：snake→camel 键名归一 + jump_height 值反演 √(2gh)
 *   （零改键同引用=零分配）+ dispatch 应用归一 patch + 模式感知步长；
 * - §P4 步长三模式分派：coupled/tick 走 setFixedDt+reset（tick 边界原子生效），
 *   decoupled 走 onTickRateChanged（auth 线早退，零 setFixedDt）；
 * - §P5 三实例 hull 扇出（player fast-path，radius→halfWidth 归一）；
 * - §P6 三实例状态扇出：respawn/teleport/teleport-to-pos/spawn-points/
 *   death-threshold/noclip/sync-render-state（tick 模式种子等价前提）；
 * - §P7 断点钩子：respawn/teleport/load → tickExternalBreak 位（非 tick no-op
 *   在 tick-authority.test.ts §16 已断言）；
 * - §P8 set-mode 三值分派 + 同 mode 幂等 + state 透传 + mode-ack；set-hold 透传；
 * - §P9 **review 不变式**（t3 §4.5 / plan-v2「tick 原子性」）：set-mode / set-hold /
 *   respawn / teleport / sync-render-state 路径零参数重应用（syncParamsToWasm
 *   调用数不变）——任何未来 PR 在这些路径新增 set_params 即违反；
 * - §P10 applyParamsToInstances（G3 扇出本体）：同 JSON 同 hull、空槽跳过、计数。
 *
 * 说明：game/src/worker/main.ts 在模块顶层注册 self.onmessage（无法在 node 直接
 * import），故本件以 dispatch 真实代码 + env 桩覆盖装配协议面；main.ts 与生产
 * 组装的同构关系：getConfigTickRate = resolveAuthTickRate(mode, panel, +3)
 * （§P2 断言的即该生产函数本体）。
 *
 * 运行（node，禁浏览器）：
 *   cd game && npx esbuild src/worker/t4-chain.test.ts --bundle --format=esm \
 *     --platform=node --outfile=node_modules/.cache/t4-tests/t4-chain.test.mjs \
 *     && node node_modules/.cache/t4-tests/t4-chain.test.mjs
 */

import {
  createWorkerDispatch,
  normalizeConfigPatchKeys,
  type WorkerDispatchEnv,
} from '../../../../src/ts-shared/auth/worker-dispatch.js';
import type { AuthLoop, PhysWorldLike } from '../../../../src/ts-shared/auth/auth-loop.js';
import type {
  DecoupledLoop,
  HoldState,
  SavePointLike,
  SyncRenderStateLike,
} from '../../../../src/ts-shared/decoupled/decoupled-loop.js';
import {
  AUTH_EVT,
  createWorkerSharedState,
  SHARED_BUFFER_SIZE,
  type MsgState,
  type ShmState,
} from '../../../../src/ts-shared/auth/shared-state.js';
import { resolveAuthTickRate, type ComputeMode } from '../../../../src/ts-shared/auth/compute-mode.js';
import { applyParamsToInstances } from './phys-instances.js';

/** main.ts:63 同值（耦合权威线隐藏偏移）。 */
const TICK_RATE_OFFSET = 3;
/** 面板默认 tickRate（game/src/config.ts:109）。 */
const PANEL_RATE = 64;

// ── 断言助手（与 tick-authority.test.ts 同风格）───────────────────────────
function expect(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[FAIL] ${label}`);
}
function def<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) throw new Error(`[FAIL] ${label}`);
  return v;
}
const assert = {
  ok(v: unknown, label: string): void {
    expect(v !== null && v !== undefined && v !== false, label);
  },
  equal(a: unknown, b: unknown, label = ''): void {
    if (a !== b) throw new Error(`[FAIL] ${label} (a=${String(a)}, b=${String(b)})`);
  },
  same(a: unknown, b: unknown, label = ''): void {
    if (a !== b) throw new Error(`[FAIL] 引用不等 ${label}`);
  },
  near(a: number, b: number, eps: number, label: string): void {
    if (!(Math.abs(a - b) <= eps)) throw new Error(`[FAIL] ${label} (a=${a}, b=${b})`);
  },
};

// ── 桩件 ─────────────────────────────────────────────────────────────────
/** 假 PhysWorld（记录全部调用；结构性满足 PhysWorldLike）。 */
class SpyWorld implements PhysWorldLike {
  readonly calls: string[] = [];
  freed = false;
  private readonly yaw: number;

  constructor(yaw = 0) {
    this.yaw = yaw;
  }

  build_world(b: string, t: string, tp: string, x: number, y: number, z: number, yaw: number): void {
    this.calls.push(`build:${b}|${t}|${tp}|${x},${y},${z},${yaw}`);
  }
  set_params(json: string): void {
    this.calls.push(`params:${json}`);
  }
  set_hull(hw: number, sh: number, dh: number): void {
    this.calls.push(`hull:${hw},${sh},${dh}`);
  }
  set_noclip(active: boolean): void {
    this.calls.push(`noclip:${active}`);
  }
  set_state(
    posX: number, posY: number, posZ: number, yaw: number, pitch: number,
    velX: number, velY: number, velZ: number, onGround: boolean,
  ): void {
    this.calls.push(`state:${posX},${posY},${posZ},${yaw},${pitch},${velX},${velY},${velZ},${onGround ? 1 : 0}`);
  }
  respawn(): void {
    this.calls.push('respawn');
  }
  teleport_to_spawn(idx: number): void {
    this.calls.push(`tspawn:${idx}`);
  }
  teleport_to(x: number, y: number, z: number, yawDeg: number): void {
    this.calls.push(`tto:${x},${y},${z},${yawDeg}`);
  }
  set_spawn_points(json: string): void {
    this.calls.push(`spawns:${json}`);
  }
  set_death_y(y: number): void {
    this.calls.push(`deathY:${y}`);
  }
  free(): void {
    this.freed = true;
    this.calls.push('free');
  }
  state(): unknown {
    return { yaw: this.yaw, posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, onGround: true, eyeHeight: 72 };
  }
  tick(): unknown {
    this.calls.push('tick');
    return null;
  }
  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

/** 桩 auth 线（捕获 setFixedDt/reset/publishCurrentState）。 */
class StubAuthLoop {
  readonly fixedDts: number[] = [];
  resets = 0;
  starts = 0;
  /** 最近一次 setFixedDt 的步长（首条无前置 → 视为 -1 恒不相等 → 首次必变更）。 */
  private lastRate = -1;
  readonly published: unknown[] = [];
  /** 返回契约对齐 auth-loop.ts：步长未变返回 false、变化返回 true（调用方据此
   * 决定是否 reset）。修复 2 配套：原 `: void` 签名吞掉返回值，无法覆盖
   * "步长不变跳过 reset" 的接线语义。 */
  setFixedDt(rate: number): boolean {
    this.fixedDts.push(rate);
    if (rate !== this.lastRate) {
      this.lastRate = rate;
      return true;
    }
    return false;
  }
  reset(): void {
    this.resets++;
  }
  start(): void {
    this.starts++;
  }
  publishCurrentState(meta?: unknown): void {
    this.published.push(meta);
  }
}

/** 桩解耦线（捕获 tickRate 边沿/采样器清零/首帧发布）。 */
class StubDecoupledLoop {
  publishes = 0;
  readonly samplerResets: (boolean | undefined)[] = [];
  tickRateChanges = 0;
  starts = 0;
  start(): void {
    this.starts++;
  }
  publishCurrentState(): void {
    this.publishes++;
  }
  resetSamplers(align?: boolean): void {
    this.samplerResets.push(align);
  }
  onTickRateChanged(): void {
    this.tickRateChanges++;
  }
}

interface Harness {
  send(msg: unknown): void;
  auth: StubAuthLoop;
  dec: StubDecoupledLoop;
  created: SpyWorld[];
  phys: () => SpyWorld;
  tickPhys: () => SpyWorld;
  scratch: () => SpyWorld;
  appliedConfig: { section: string; patch: Record<string, unknown> }[];
  posted: { type?: string; mode?: string }[];
  setModeCalls: { mode: ComputeMode; state?: SyncRenderStateLike }[];
  setHoldCalls: { hold: HoldState | null; release?: SavePointLike }[];
  breaks: number[];
  rebuilt: () => number;
  syncParams: () => number;
  mode: () => ComputeMode;

}

function makeHarness(): Harness {
  let mode: ComputeMode = 'coupled';
  let panelRate = PANEL_RATE;
  const posts: { type?: string; mode?: string }[] = [];
  const created: SpyWorld[] = [];
  const physSlot = { current: null as SpyWorld | null };
  const tickSlot = { current: null as SpyWorld | null };
  const scratchSlot = { current: null as SpyWorld | null };
  const auth = new StubAuthLoop();
  const dec = new StubDecoupledLoop();
  const shared: { current: ShmState | MsgState | null } = {
    current: createWorkerSharedState(new SharedArrayBuffer(SHARED_BUFFER_SIZE)),
  };
  const appliedConfig: { section: string; patch: Record<string, unknown> }[] = [];
  const setModeCalls: { mode: ComputeMode; state?: SyncRenderStateLike }[] = [];
  const setHoldCalls: { hold: HoldState | null; release?: SavePointLike }[] = [];
  const breaks: number[] = [];
  let syncParamsCount = 0;
  let rebuiltCount = 0;

  const env: WorkerDispatchEnv = {
    shared,
    phys: physSlot as unknown as { current: PhysWorldLike | null },
    authLoop: auth as unknown as AuthLoop,
    // 生产同构（main.ts getConfigTickRate 的实体 = resolveAuthTickRate）
    getConfigTickRate: () => resolveAuthTickRate(mode, panelRate, TICK_RATE_OFFSET),
    applyConfigPatch: (section, patch) => {
      appliedConfig.push({ section, patch });
      // config store 建模（生产：先落库，随后 getConfigTickRate 读新值）
      if (section === 'physics' && typeof patch.tickRate === 'number') panelRate = patch.tickRate;
    },
    syncParamsToWasm: () => {
      syncParamsCount++;
    },
    createPhysWorld: () => {
      const w = new SpyWorld();
      created.push(w);
      return w as unknown as PhysWorldLike;
    },
    initSync: () => {},
    post: (msg) => {
      posts.push(msg as { type?: string; mode?: string });
    },
    tickPhys: tickSlot as unknown as { current: PhysWorldLike | null },
    scratch: scratchSlot as unknown as { current: PhysWorldLike | null },
    decoupledLoop: dec as unknown as DecoupledLoop,
    getComputeMode: () => mode,
    onSetMode: (m, state) => {
      setModeCalls.push({ mode: m, state });
      mode = m;
    },
    onSetHold: (hold, release) => {
      setHoldCalls.push({ hold, release });
    },
    tickExternalBreak: (evtBit) => {
      breaks.push(evtBit);
    },
    onWorldRebuilt: () => {
      rebuiltCount++;
    },
  };

  const handle = createWorkerDispatch(env);
  return {
    send: (msg) => handle({ data: msg } as MessageEvent<unknown>),
    auth,
    dec,
    created,
    phys: () => def(physSlot.current, 'phys 已建'),
    tickPhys: () => def(tickSlot.current, 'tickPhys 已建'),
    scratch: () => def(scratchSlot.current, 'scratch 已建'),
    appliedConfig,
    posted: posts,
    setModeCalls,
    setHoldCalls,
    breaks,
    rebuilt: () => rebuiltCount,
    syncParams: () => syncParamsCount,
    mode: () => mode,
  };
}

const WASM_INIT = { type: 'wasm-init', wasmB64: 'AAAA' };
const WORLD = {
  type: 'world-json',
  brushJson: 'BRUSH',
  triJson: 'TRI',
  teleportJson: 'TELE',
  spawn: { x: 1, y: 2, z: 3, yawDeg: 90 },
};
const STATE: SyncRenderStateLike = {
  posX: 4, posY: 5, posZ: 6, yaw: 7, pitch: 8, velX: 9, velY: 10, velZ: 11,
  onGround: true, eyeHeight: 72,
};

let passed = 0;
const names: string[] = [];
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  names.push(name);
}

// ── §P1 world-json 装配：G3 三实例同建同参 + free + 钩子 ──────────────────
test('§P1 world-json：G3 三实例同建同参 + 旧实例 free + 首帧/重建钩子', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send({ type: 'set-mode', mode: 'tick' }); // tick 模式（P-tick-6 raw 断言前提）
  assert.equal(h.auth.starts, 1, 'wasm 就绪即启动 auth 线（幂等一次）');
  h.send(WORLD);
  assert.equal(h.created.length, 3, 'phys + tickPhys + scratch 三实例');
  const b0 = h.created[0].calls[0];
  assert.equal(h.created[0].calls[0], h.created[1].calls[0], 'phys/tickPhys 同建参');
  assert.equal(h.created[1].calls[0], h.created[2].calls[0], 'tickPhys/scratch 同建参（G3）');
  assert.equal(b0, 'build:BRUSH|TRI|TELE|1,2,3,90', '建图参数逐字同源');
  assert.equal(h.syncParams(), 1, '建图后同参扇出一次');
  assert.equal(h.auth.fixedDts.at(-1), 64, 'P-tick-6：tick 模式 setFixedDt(raw 面板值)');
  assert.equal(1 / (h.auth.fixedDts.at(-1) as number), 1 / 64, 'fixedDt === 1/64 精确');
  assert.equal(h.auth.resets, 1, '累积器清零');
  assert.equal(h.dec.publishes, 1, '首帧状态即刻可见');
  assert.equal(h.rebuilt(), 1, 'onWorldRebuilt（t4 钩子）');
  // 第二轮 world-json：旧三实例先 free（P5 无泄漏）
  h.send(WORLD);
  assert.equal(h.created.length, 6, '三实例重建');
  assert.ok(h.created.slice(0, 3).every((w) => w.freed), '旧三实例逐个 free');
  assert.ok(!h.created[5].freed, '新实例存活');
});

// ── §P2 P-tick-6：周期解析（生产唯一实现源）──────────────────────────────
test('§P2 P-tick-6：resolveAuthTickRate tick=raw 精确 / coupled=面板+3', () => {
  assert.equal(resolveAuthTickRate('tick', 64, TICK_RATE_OFFSET), 64, 'tick raw 直译');
  assert.equal(1 / resolveAuthTickRate('tick', 64, TICK_RATE_OFFSET), 1 / 64, '1/64 精确成立');
  assert.equal(resolveAuthTickRate('coupled', 64, TICK_RATE_OFFSET), 67, '耦合 = +3');
  assert.equal(1 / resolveAuthTickRate('coupled', 64, TICK_RATE_OFFSET), 1 / 67, '耦合步长');
  for (const r of [48, 64, 100, 128, 1750]) {
    assert.equal(resolveAuthTickRate('tick', r, TICK_RATE_OFFSET), r, `tick 恒 raw（面板 ${r}）`);
    assert.equal(resolveAuthTickRate('coupled', r, TICK_RATE_OFFSET), r + 3, `耦合恒 +3（面板 ${r}）`);
  }
  // 生效点同断言：world-json 在 tick/coupled 两模式下的步长
  const ht = makeHarness();
  ht.send(WASM_INIT);
  ht.send({ type: 'set-mode', mode: 'tick' });
  ht.send(WORLD);
  assert.equal(1 / (ht.auth.fixedDts.at(-1) as number), 1 / 64, 'tick 模式建图 → raw');
  const hc = makeHarness();
  hc.send(WASM_INIT);
  hc.send(WORLD);
  assert.equal(hc.auth.fixedDts.at(-1), 67, '耦合模式建图 → +3');
  // 面板滑动（tick 模式）
  const hs = makeHarness();
  hs.send(WASM_INIT);
  hs.send({ type: 'set-mode', mode: 'tick' });
  hs.send(WORLD);

  hs.send({ type: 'config', section: 'physics', patch: { tickRate: 100 } });
  assert.equal(hs.auth.fixedDts.at(-1), 100, 'tick 模式 tickRate 变更 → raw 新值（无 +3）');
  assert.equal(1 / (hs.auth.fixedDts.at(-1) as number), 1 / 100, '精确 1/100');
});

// ── §P3 W-GAP-1 参数链 ───────────────────────────────────────────────────
test('§P3 W-GAP-1：键名归一 + jump_height 值反演 + dispatch 应用 + 单写路径', () => {
  // 纯函数面
  const clean = { gravity: 800, accelerate: 10 };
  assert.same(normalizeConfigPatchKeys(clean), clean, '无归一 → 同引用（零分配）');
  const renamed = normalizeConfigPatchKeys({ stop_speed: 100, jump_height: 302, gravity: 800 });
  assert.equal(renamed.stopSpeed, 100, 'snake→camel');
  assert.equal('stop_speed' in renamed, false, '旧键不再保留');
  assert.near(renamed.jumpSpeed as number, Math.sqrt(2 * 800 * 302), 1e-9, 'W-GAP-1 值反演 √(2gh)');
  assert.equal('jump_height' in renamed, false, 'jump_height 不原样透传（否则二次换算）');
  assert.near(
    normalizeConfigPatchKeys({ jump_height: 302 }).jumpSpeed as number,
    Math.sqrt(2 * 800 * 302),
    1e-9,
    '缺 gravity 回退 800（createConfig 默认）',
  );
  // 非数值分支（实测行为记录）：不进反演分支 → 落键名归一（值原样搬运，不换算）。
  // ⚠️ 观察项：字符串 jump_height 会被改名成 jumpSpeed 而非拒绝——真实协议面
  // buildPhysicsParams 恒发数值，非数值仅可能来自手工消息；本件如实记录不改行为
  //（共享协议函数属 t2 评审基线，行为变更须走协议评审而非本任务静默修改）。
  assert.equal(
    (normalizeConfigPatchKeys({ jump_height: '302' }) as { jumpSpeed?: unknown }).jumpSpeed,
    '302',
    '非数值：仅键名归一，值原样搬运（不反演）',
  );
  // dispatch 应用面：归一后的 patch 落到 applyConfigPatch
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  const before = h.syncParams();
  h.send({ type: 'config', section: 'physics', patch: { gravity: 800, jump_height: 302, stop_speed: 100 } });
  const applied = def(h.appliedConfig.at(-1), 'patch 已应用');
  assert.equal(applied.section, 'physics');
  assert.near(applied.patch.jumpSpeed as number, Math.sqrt(2 * 800 * 302), 1e-9, 'dispatch 落库值=反演值');
  assert.equal(applied.patch.stopSpeed, 100, 'dispatch 落库键=camel');
  assert.equal(h.syncParams(), before + 1, '参数应用路径数 = 1（单写链）');
});

// ── §P4 步长三模式分派（tick 边界原子生效）──────────────────────────────
test('§P4 步长分派：coupled/tick = setFixedDt+reset；decoupled = onTickRateChanged', () => {
  // coupled：面板 100 → 103
  const hc = makeHarness();
  hc.send(WASM_INIT);
  hc.send(WORLD);
  const rc = hc.auth.resets;
  hc.send({ type: 'config', section: 'physics', patch: { tickRate: 100 } });
  assert.equal(hc.auth.fixedDts.at(-1), 103, '耦合 = 面板 + 3');
  assert.equal(hc.auth.resets, rc + 1, '清累积器（防新旧步长错配）');
  // tick：面板 100 → 100 raw
  const ht = makeHarness();
  ht.send(WASM_INIT);
  ht.send({ type: 'set-mode', mode: 'tick' });
  ht.send(WORLD);
  const rt = ht.auth.resets;
  const dt = ht.auth.fixedDts.length;
  ht.send({ type: 'config', section: 'physics', patch: { tickRate: 100 } });
  assert.equal(ht.auth.fixedDts.at(-1), 100, 'tick = raw（+3 不渗入）');
  assert.equal(ht.auth.fixedDts.length, dt + 1, '仅一次步长变更');
  assert.equal(ht.auth.resets, rt + 1, 'tick 边界原子生效（reset 后下一 tick 即新步长）');
  // decoupled：走解耦线边沿，auth 线零 setFixedDt
  const hd = makeHarness();
  hd.send(WASM_INIT);
  hd.send({ type: 'set-mode', mode: 'decoupled' });
  hd.send(WORLD);
  const dcount = hd.auth.fixedDts.length;
  hd.send({ type: 'config', section: 'physics', patch: { tickRate: 100 } });
  assert.equal(hd.dec.tickRateChanges, 1, '解耦线 onTickRateChanged');
  assert.equal(hd.auth.fixedDts.length, dcount, '解耦模式 auth 线零步长变更');
});

// ── §P5 三实例 hull 扇出（player fast-path）─────────────────────────────
test('§P5 config player：radius→halfWidth 归一 + 三实例 hull 同参', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  const before = h.syncParams();
  h.send({ type: 'config', section: 'player', patch: { radius: 16, standHeight: 72, duckHeight: 36 } });
  for (const [label, w] of [['phys', h.phys()], ['tickPhys', h.tickPhys()], ['scratch', h.scratch()]] as const) {
    assert.equal(w.count('hull:16,72,36'), 1, `${label} hull 同参`);
  }
  assert.equal(h.syncParams(), before, 'hull fast-path 不走参数重应用（单写路径）');
  // 三字段守卫：缺失任一 → 不扇出
  const h2 = makeHarness();
  h2.send(WASM_INIT);
  h2.send(WORLD);
  h2.send({ type: 'config', section: 'player', patch: { radius: 16, standHeight: 72 } });
  assert.equal(h2.phys().count('hull:'), 0, 'partial patch 守卫：零扇出');
});

// ── §P6 三实例状态扇出 ──────────────────────────────────────────────────
test('§P6 三实例状态扇出：respawn/teleport/spawns/deathY/noclip/sync', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  h.send({ type: 'respawn' });
  assert.equal(h.phys().count('respawn'), 1, 'phys respawn');
  assert.equal(h.scratch().count('respawn'), 1, 'scratch 同落出生点（tick 种子等价）');
  h.send({ type: 'teleport', target: 2 });
  for (const w of [h.phys(), h.tickPhys(), h.scratch()]) {
    assert.equal(w.count('tspawn:2'), 1, 'teleport_to_spawn 三实例同步');
  }
  h.send({ type: 'teleport-to-pos', pos: [1, 2, 3] });
  for (const w of [h.phys(), h.tickPhys(), h.scratch()]) {
    assert.equal(w.count('tto:1,2,3,0'), 1, 'teleport_to 三实例同步（yaw 沿用当前）');
  }
  h.send({ type: 'set-spawn-points', json: '[{"x":1}]' });
  for (const w of [h.phys(), h.tickPhys(), h.scratch()]) {
    assert.equal(w.count('spawns:'), 1, 'spawn points 三实例同步');
  }
  h.send({ type: 'set-death-threshold', value: -64 });
  for (const w of [h.phys(), h.tickPhys(), h.scratch()]) {
    assert.equal(w.count('deathY:-64'), 1, 'death_y 三实例同步');
  }
  h.send({ type: 'config', section: 'input', patch: { mode: 'noclip' } });
  assert.equal(h.phys().count('noclip:true'), 1, 'phys noclip');
  assert.equal(h.scratch().count('noclip:true'), 1, 'scratch 同步（G3 状态恒等）');
  assert.equal(h.tickPhys().count('noclip:'), 0, 'tickPhys 走 set_noclip 单独通道（既有语义不动）');
  h.send({ type: 'sync-render-state', state: STATE });
  assert.equal(h.phys().count('state:4,5,6,7,8,9,10,11,1'), 1, 'phys 全态注入');
  assert.equal(h.scratch().count('state:'), 0, 'tick/耦合：scratch 不随 sync 注入（种子面独占）');
});

// ── §P7 断点钩子 ────────────────────────────────────────────────────────
test('§P7 断点钩子：respawn/teleport/load 位（dispatch 面）', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  h.send({ type: 'respawn' });
  h.send({ type: 'teleport', target: 0 });
  h.send({ type: 'teleport-to-pos', pos: [0, 0, 0] });
  h.send({ type: 'sync-render-state', state: STATE });
  assert.equal(h.breaks.length, 4, '四次断点');
  assert.equal(h.breaks[0], AUTH_EVT.respawn, 'respawn 位');
  assert.equal(h.breaks[1], AUTH_EVT.teleport, 'teleport 位（索引）');
  assert.equal(h.breaks[2], AUTH_EVT.teleport, 'teleport 位（坐标）');
  assert.equal(h.breaks[3], AUTH_EVT.load, 'load 位（sync-render-state）');
});

// ── §P8 set-mode 三值分派 + 幂等 + ack ──────────────────────────────────
test('§P8 set-mode：三值分派 + 同 mode 幂等 + state 透传 + mode-ack', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  h.send({ type: 'set-mode', mode: 'tick', state: STATE });
  assert.equal(h.setModeCalls.length, 1, 'onSetMode 一次');
  assert.equal(h.setModeCalls[0].mode, 'tick', '三值分派（tick 不被丢弃）');
  assert.same(h.setModeCalls[0].state, STATE, 'state 透传（coupled→tick 行①）');
  assert.equal(h.mode(), 'tick');
  assert.equal(def(h.posted.at(-1), 'ack').type, 'mode-ack');
  assert.equal(h.posted.at(-1)?.mode, 'tick', 'ack 回执 mode');
  h.send({ type: 'set-mode', mode: 'tick' });
  assert.equal(h.setModeCalls.length, 1, '同 mode 幂等：不重复执行交接步骤');
  assert.equal(h.posted.at(-1)?.type, 'mode-ack', '幂等仍回执（500ms 重发兜底）');
  h.send({ type: 'set-mode', mode: 'bogus' });
  assert.equal(h.posted.at(-1)?.type, 'mode-ack', '非法 mode 直接 return（无新回执）');
  assert.equal(h.posted.filter((p) => p.type === 'mode-ack').length, 2, '非法 mode 零回执');
  h.send({ type: 'set-mode', mode: 'coupled' });
  assert.equal(h.setModeCalls.at(-1)?.mode, 'coupled', 'tick→coupled 回退');
});

// ── §P9 review 不变式：交接/hold/respawn 零参数重应用 ────────────────────
test('§P9 不变式：set-mode/set-hold/respawn/teleport/load 路径零参数重应用', () => {
  const h = makeHarness();
  h.send(WASM_INIT);
  h.send(WORLD);
  const base = h.syncParams();
  h.send({ type: 'set-mode', mode: 'tick', state: STATE });
  h.send({ type: 'set-hold', hold: { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, onGround: true } });
  h.send({ type: 'respawn' });
  h.send({ type: 'teleport', target: 1 });
  h.send({ type: 'teleport-to-pos', pos: [1, 1, 1] });
  h.send({ type: 'sync-render-state', state: STATE });
  h.send({ type: 'set-hold', hold: null, release: { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, vx: 0, vy: 0, vz: 0, onGround: true } });
  assert.equal(h.syncParams(), base, '上述路径零 set_params（t3 §4.5 / plan-v2 不变式）');
  assert.equal(h.setHoldCalls.length, 2, 'set-hold 透传');
  assert.equal(h.setHoldCalls[0].hold?.x, 1, 'hold 注入态');
  assert.equal(h.setHoldCalls[1].hold, null, 'hold 解除');
  assert.equal(h.setHoldCalls[1].release?.x, 1, 'release 存点透传');
});

// ── §P10 G3 参数扇出本体 ────────────────────────────────────────────────
test('§P10 applyParamsToInstances：同 JSON 同 hull + 空槽跳过 + 计数', () => {
  const a = new SpyWorld();
  const b = new SpyWorld();
  const c = new SpyWorld();
  const json = '{"gravity":800,"jumpSpeed":695.2}';
  const n = applyParamsToInstances([a, b, null, c], json, 16, 72, 36);
  assert.equal(n, 3, '空槽跳过，计数 = 3');
  for (const w of [a, b, c]) {
    assert.equal(w.calls[0], `params:${json}`, '同一 JSON 内容（零重编码：逐实例透传同一字符串）');
    assert.equal(w.count('params:'), 1, '每实例一次 set_params');
    assert.equal(w.count('hull:16,72,36'), 1, '每实例一次 set_hull');
  }
  assert.equal(applyParamsToInstances([null, null], json, 1, 2, 3), 0, '全空槽零应用');
  assert.equal(applyParamsToInstances([], json, 1, 2, 3), 0, '空列表零应用');
});

console.log(`\nt4-chain.test.ts: ${passed} 例全绿`);
console.log(names.map((n) => `  ✓ ${n}`).join('\n'));
(globalThis as unknown as { process?: { exit(c?: number): void } }).process?.exit(0);
