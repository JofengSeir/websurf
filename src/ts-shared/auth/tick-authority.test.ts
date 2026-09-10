/**
 * 单测：tick 模式 F4-C 控制器 + auth-loop additive 钩子（任务 t4）。
 *
 * 覆盖（captain t4 指令 + t6-render-ahead §8.1/§8.4/§8.5/§10.1/§11.2/§11.3）：
 * - §1 peekInput 非消耗读 + maxStep 饱和钳制（单源输入台账：真实 tick 全窗消费）；
 * - §2 引导期 bootstrap（lastAuthLabel null → 纯历史回落）；
 * - §3 OPT happy path：种子投影 → 排序门 → OPT 帧（f' meta 三元组 + OPT 位 +
 *   timeMs=投影 due）+ 门闭账恒等式（⑧）；
 * - §4 div bulk 桶（非翻转 tick：硬界内 / 超界告警 / 均值累计）；
 *   §5 div flip 桶（接触字段翻转独立计数）；
 * - §6/§7 内容封帽（事件/on_ground/blocked/ladder/ducked/surfing）→ 孤发不经门；
 * - §8 key-edge gating；§9 窗外/地板/追爆无尝试（ε 尾由开火地板吸收 → 门分账
 *   不动；地板损失走门上游 `floorSkips` 显式记账 = lead-miss 全口径补全）；
 * - §10 同标签重发守卫；§11 R 键边沿断点；§12 权威事件排空（teleport/death →
 *   段 +1 + 位编码，一次性消费）；
 * - §13 hold 冻结（noteHoldTick → 投影作废 + holdTicks）；§14 world 重建（标号
 *   归零 + 门重建 → bootstrap 回归）；§15 外部断点（respawn/teleport/load）；
 * - §16 非 tick 模式零回归（meta undefined / 全钩子 no-op）；§17 MsgState 回退
 *   （F4 禁用 → 纯历史）；§18 动态周期 → 门重建（δ cap 随 T 重钳）；
 * - §20 红线审计（验收 #2）：乐观径零驱动权威实例 + authority 调用面 = 只读
 *   四方法（无 set_* 写面，结构性审计）；
 * - §19 auth-loop additive 钩子集成（真 timer）：tick 模式零分配支路自动推进 +
 *   每 tick meta 三元组；hold 顶置（帧定格 + 标号推进）；耦合回归（无钩子 =
   * v7 行为：帧推进 + I_A_* 三槽零触碰）。
 *
 * 运行（node，禁浏览器）：
 *   cd game && npx esbuild ../src/ts-shared/auth/tick-authority.test.ts \
 *     --bundle --format=esm --platform=node --outfile=node_modules/.cache/t4-tests/tick-authority.test.mjs \
 *     && node node_modules/.cache/t4-tests/tick-authority.test.mjs
 */

import {
  ShmState,
  SHARED_BUFFER_SIZE,
  AUTH_EVT,
  AUTH_EVT_OPT,
  I_A_SEG,
  I_A_TICK,
  I_A_EVT,
  I_A_PSEQ,
} from './shared-state.js';
import { createWorkerSharedState } from './shared-state.js';
import { createTickAuthority, type TickAuthorityEnv } from './tick-authority.js';
import { createAuthLoop, type PhysWorldLike } from './auth-loop.js';

// 断言助手（与 shared-state.protocol.test.ts 同风格——node 类型不可用，就地定义）
function expect(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[FAIL] ${label}`);
}
/** 非空收窄（null/undefined 即抛）。 */
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
};

const T = 15.625;

/** 确定性假物理实例（结构性满足 F4AuthorityWorld——state_out 即真实 wasm 语义：
 * 共享 ArrayBuffer 不同 byteOffset 的 Float64Array(22) 视图）。确定性规则：
 * pos.x += dx + dt·10；on_ground=keys&1；blocked_ticks+=keys&2?1:0；ducked=keys&8；
 * ladder=keys&16?5:−1；surfing=keys&32；teleport 事件=keys&4；death 事件=keys&64。
 * 写面仅有自身视图（F4AuthorityWorld 权限清单审计面同构）。 */
class FakeWorld {
  readonly view: Float64Array;
  private events: { kind: string }[] = [];
  stepCount = 0;

  constructor(wasmBuf: ArrayBuffer, byteOffset: number) {
    this.view = new Float64Array(wasmBuf, byteOffset, 22);
  }

  tick_into(dt: number, keys: number, dx: number, _dy: number): void {
    this.stepCount++;
    const o = this.view;
    o[0] += dx + dt * 10;
    o[21] = (keys & 1) !== 0 ? 1 : 0;
    o[13] += (keys & 2) !== 0 ? 1 : 0;
    o[8] = (keys & 8) !== 0 ? 1 : 0;
    o[14] = (keys & 16) !== 0 ? 5 : -1;
    o[12] = (keys & 32) !== 0 ? 1 : 0;
    if ((keys & 4) !== 0) this.events.push({ kind: 'teleport' });
    if ((keys & 64) !== 0) this.events.push({ kind: 'death' });
  }

  state_out_ptr(): number {
    return this.view.byteOffset;
  }

  take_event(): { kind: string } | null {
    return this.events.shift() ?? null;
  }

  seed_from(src: object): void {
    this.view.set((src as FakeWorld).view);
  }
}

interface Ctx {
  sab: SharedArrayBuffer;
  shm: ShmState;
  auth: FakeWorld;
  scratch: FakeWorld;
  wasmBuf: ArrayBuffer;
  env: TickAuthorityEnv;
  c: ReturnType<typeof createTickAuthority>;
  posts: { type: string }[];
  rawI32: Int32Array;
  dstF: Float64Array;
  dstI: Int32Array;
}

function makeCtx(): Ctx {
  const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const shm = new ShmState(sab);
  const wasmBuf = new ArrayBuffer(4096);
  const auth = new FakeWorld(wasmBuf, 0);
  const scratch = new FakeWorld(wasmBuf, 512);
  const posts: { type: string }[] = [];
  const env: TickAuthorityEnv = {
    getShared: () => shm,
    getAuthority: () => auth,
    getScratch: () => scratch,
    getWasmBuffer: () => wasmBuf,
    getTickPeriodMs: () => T,
    post: (m: unknown) => {
      posts.push(m as { type: string });
    },
  };
  const c = createTickAuthority(env);
  return { sab, shm, auth, scratch, wasmBuf, env, c, posts, rawI32: new Int32Array(sab), dstF: new Float64Array(12), dstI: new Int32Array(6) };
}

/** 标准生命周期：enterMode → 首帧 meta 排空 → bootstrap 真实 tick（label 0）。 */
function boot(ctx: Ctx): void {
  ctx.c.enterMode();
  const fm = def(ctx.c.firstFrameMeta(), 'firstFrameMeta 非空');
  assert.equal(fm.evt, AUTH_EVT.modeSwitch);
  assert.equal(fm.tick, 0);
  ctx.c.publishMeta(); // label 0 真实 tick（引导锚）
}

/** 闭账恒等式断言（⑧）：published + leadMiss + blockedOrder ≡ 门尝试数。 */
function assertClosureIdentity(ctx: Ctx, attempts: number, label: string): void {
  const g = ctx.c.gate.stats;
  assert.equal(g.optimisticPublished + g.leadMiss + g.blockedOrder, attempts, label);
}

let passed = 0;
const names: string[] = [];
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  names.push(name);
}

// ── §1 peekInput：非消耗读 + maxStep 饱和钳制 ─────────────────────────────
test('§1 peekInput 非消耗读 + maxStep 钳制', () => {
  const ctx = makeCtx();
  ctx.shm.addInput(30, -10, 7);
  const p = ctx.shm.peekInput(1200);
  assert.equal(p.dx, 30);
  assert.equal(p.dy, -10);
  assert.equal(p.keysMask, 7);
  // 非消耗：真实 tick takeInput 仍拿全窗
  const taken = ctx.shm.takeInput(1200);
  assert.equal(taken.dx, 30);
  assert.equal(taken.dy, -10);
  // 钳制：超出 maxStep 饱和（定点比较）
  ctx.shm.addInput(5000, -2, 0);
  const p2 = ctx.shm.peekInput(1200);
  assert.equal(p2.dx, 1200);
  assert.equal(p2.dy, -2);
  // 钳制后再 takeInput 同样截断（单源语义一致）
  assert.equal(ctx.shm.takeInput(1200).dx, 1200);
});

// ── §2 引导期 bootstrap ──────────────────────────────────────────────────
test('§2 引导期无锚 → 纯历史回落', () => {
  const ctx = makeCtx();
  ctx.c.enterMode();
  ctx.c.firstFrameMeta();
  // 尚无 meta'd 真实 tick → onWake 乐观窗命中也不尝试
  ctx.shm.addInput(10, 0, 1);
  ctx.c.onWake(1000, 1008);
  assert.equal(ctx.c.stats.bootstrapSkips, 1);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assertClosureIdentity(ctx, 0, 'bootstrap 无尝试');
  assert.equal(ctx.c.stats.f4Ready, true);
  assert.equal(ctx.c.isActive(), true);
});

// ── §3 OPT happy path ────────────────────────────────────────────────────
test('§3 OPT 发布：f′ meta 三元组 + OPT 位 + 投影 due + 闭账恒等', () => {
  const ctx = makeCtx();
  boot(ctx);
  // 基线：真实 tick 后权威 x=10（seed 规则 dt·10）
  ctx.auth.view[0] = 10;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1); // 键沿基线（真实 tick 输入消费后）
  ctx.c.onRealTick(1000, {
    x: ctx.auth.view[0], y: 0, z: 0, velX: 0, velY: 0, velZ: 0,
    yaw: 0, pitch: 0, eyeHeight: 72, onGround: true,
    ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  // OPT 窗：trunc 输入窗 30px（真实 tick 将全窗 50px）
  ctx.shm.addInput(30, 0, 1);
  const due = 1008; // remaining = 8 = T − δ_cap（窗沿含等号）
  ctx.c.onWake(1000, due);
  const g = ctx.c.gate.stats;
  assert.equal(g.optimisticPublished, 1, 'OPT 已发布');
  assertClosureIdentity(ctx, 1, 'published≡尝试');
  // OPT 帧内容：pos 来自 scratch 投影（seed x=10 + dx30 + dt·10 ≈ 40.15625）
  const f = def(ctx.shm.readAuthoritative(), '权威帧已发布');
  assert.equal(f.frame.timeMs, due, 'timeMs=投影网格 due');
  assert.ok(Math.abs(f.frame.pos.x - (10 + 30 + 0.15625)) < 0.02, 'seed+截断窗投影（×100 定点量化容差）');
  // f′ meta 三元组：seg 沿用 / tick=标签 L / evt=OPT 位
  ctx.shm.readAuthoritativeInto(ctx.dstF, ctx.dstI);
  assert.equal(ctx.dstI[2], 1, 'seg 沿用 1');
  assert.equal(ctx.dstI[3], 1, 'tick 标签 = lastAuth+1');
  assert.equal(ctx.dstI[4], AUTH_EVT_OPT, 'evt = OPT 位（事件位恒 0）');
  // 修订（真实 tick 全窗）：x = 10 + 50 + 0.15625；同 label → div ≈ 20u？不——
  // 真侧全窗 50 vs 乐观截断 30 → 差 20u：超 bulk 硬断言域。这正是「截断窗不缩放」
  // 的双桶意义所在：修订差由 div 遥测如实暴露（本例人为放大差值验证对账通路）。
  ctx.auth.tick_into(1 / 64, 1, 50, 0);
  ctx.c.publishMeta(); // label 1（真实 tick k=OPT 的 L）
  ctx.c.onRealTick(1016, {
    x: ctx.auth.view[0], y: 0, z: 0, velX: 0, velY: 0, velZ: 0,
    yaw: 0, pitch: 0, eyeHeight: 72, onGround: true,
    ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  assert.equal(ctx.c.stats.revisions, 1, '修订对账 1 次');
  assert.equal(ctx.c.stats.divBulk, 1, 'bulk 桶（无接触字段翻转）');
  assert.ok(Math.abs(ctx.c.stats.divBulkMaxU - 20) < 1e-6, 'div = 全窗−截断窗差');
  assert.equal(ctx.c.stats.divFlip, 0);
});

// ── §4 div bulk 桶（2u 硬界内 + 超界告警面）───────────────────────────────
test('§4 div bulk 桶：硬界内 + 超界告警 + 均值累计（非翻转 tick）', () => {
  /** 真侧姿态记录（x 取权威视图；接触字段恒基线 = 强制 bulk 分类）。 */
  const pose = (x: number) => ({
    x, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, eyeHeight: 72,
    onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 10;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1); // 键沿基线（后续轮次 keysMask 恒 1，无新键沿）
  ctx.c.onRealTick(1000, pose(10));
  // 轮 1：乐观截断窗 30px vs 真侧 32px ⇒ div = 2.0u（bulk 硬界 2.5 之内）
  ctx.shm.addInput(30, 0, 1);
  ctx.c.onWake(1000, 1008);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1, 'OPT 已发布');
  ctx.shm.takeInput(1200); // 真实 tick 全窗消费（peek 非消耗读；台账单源）
  ctx.auth.tick_into(1 / 64, 1, 32, 0);
  ctx.c.publishMeta();
  ctx.c.onRealTick(1016, pose(ctx.auth.view[0]));
  assert.equal(ctx.c.stats.revisions, 1, '修订对账');
  assert.equal(ctx.c.stats.divBulk, 1, 'bulk 桶（无接触字段翻转）');
  assert.equal(ctx.c.stats.divFlip, 0, 'flip 桶零污染');
  assert.ok(Math.abs(ctx.c.stats.divBulkMaxU - 2) < 1e-9, '最大位移差 = |Δdx| = 2u');
  assert.ok(Math.abs(ctx.c.stats.divBulkSumU - 2) < 1e-9, '均值分子累计');
  assert.equal(ctx.c.stats.divBulkOverCap, 0, '2u ≤ 2.5u 硬界（零告警）');
  // 轮 2：真侧多走 5u ⇒ div = 5.0u（超硬界 → 告警计数，max 更新）
  ctx.shm.addInput(30, 0, 1);
  ctx.c.onWake(2000, 2008);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 2, 'OPT 2 已发布');
  ctx.shm.takeInput(1200); // 轮 2 真实 tick 全窗消费（防跨轮输入残留）
  ctx.auth.tick_into(1 / 64, 1, 35, 0);
  ctx.c.publishMeta();
  ctx.c.onRealTick(2016, pose(ctx.auth.view[0]));
  assert.equal(ctx.c.stats.divBulk, 2, '轮 2 仍属 bulk（接触字段无翻转）');
  assert.ok(Math.abs(ctx.c.stats.divBulkMaxU - 5) < 1e-9, '最大位移差更新为 5u');
  assert.ok(Math.abs(ctx.c.stats.divBulkSumU - 7) < 1e-9, '均值分子累计 2+5');
  assert.equal(ctx.c.stats.divBulkOverCap, 1, '超 2.5u 硬界告警 +1（残余告警面）');
  assert.equal(ctx.c.stats.divFlip, 0, 'flip 桶仍零');
  assertClosureIdentity(ctx, 2, '两轮闭账恒等（published≡尝试）');
});

// ── §5 div flip 桶 ───────────────────────────────────────────────────────
test('§5 div flip 桶：on_ground 翻转 / blocked 增量 → flip 独立计数', () => {
  // 场景 a：真侧 on_ground 翻转（OPT 期与真期接触判定不同——T3 类）
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(2, 0, 1); // 乐观步 keys=1 → on_ground=1=基线 → 可发
  ctx.c.onWake(1000, 1008);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1);
  // 真侧：on_ground 翻转为 false → flip 桶
  ctx.auth.tick_into(1 / 64, 0, 2, 0);
  ctx.c.publishMeta();
  ctx.c.onRealTick(1016, {
    x: ctx.auth.view[0], y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: false, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  assert.equal(ctx.c.stats.divFlip, 1, 'flip 桶独立计数');
  assert.equal(ctx.c.stats.divBulk, 0);
  assert.equal(ctx.c.stats.revisions, 1);
  // 场景 b：真侧 blocked 增量（T2 类——接触字段翻转分类）
  const ctx2 = makeCtx();
  boot(ctx2);
  ctx2.auth.view[0] = 0;
  ctx2.auth.view[21] = 1;
  ctx2.c.onInput(1);
  ctx2.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx2.shm.addInput(2, 0, 1);
  ctx2.c.onWake(1000, 1008);
  assert.equal(ctx2.c.gate.stats.optimisticPublished, 1);
  ctx2.auth.tick_into(1 / 64, 1 | 2, 2, 0); // 真侧 blocked+1（同 on_ground）
  ctx2.c.publishMeta();
  ctx2.c.onRealTick(1016, {
    x: ctx2.auth.view[0], y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 1, ladder: -1,
  });
  assert.equal(ctx2.c.stats.divFlip, 1, 'blocked 增量 → flip');
  assert.equal(ctx2.c.stats.divBulk, 0);
});

// ── §6/§7 内容封帽 ───────────────────────────────────────────────────────
test('§6 内容封帽：scratch 事件 → 孤发不经门', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(4 | 1); // 键沿基线（真实 tick 已在按 4|1——本轮无新键沿）
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 4 | 1); // 乐观步触发 scratch teleport 事件（keys&4）
  ctx.c.onWake(1000, 1008);
  assert.equal(ctx.c.stats.orphanedCap, 1);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0, '封帽=检出即不发');
  assertClosureIdentity(ctx, 0, '封帽不经门（闭账仍恒等）');
  assert.equal(ctx.shm.readAuthoritative(), null, '无 OPT 帧发布');
  // scratch 事件被随意排空（§11.2）——不影响权威实例（真步重放同一事件）
  assert.equal(ctx.scratch.take_event(), null, 'scratch 事件已排空');
  assert.equal(ctx.auth.take_event(), null, '权威实例零触碰（事件槽未动）');
});

test('§7 内容封帽：blocked 增量 / ducked 翻转 / surfing 翻转 / ladder 翻转', () => {
  // 子用例：keys（封帽字段触发）→ 孤发；onInput 预设键沿基线（真实 tick 语义）
  const mk = (keys: number, base: { onGround: boolean; ducked: number; surfing: number; blockedTicks: number; ladder: number }) => {
    const ctx = makeCtx();
    boot(ctx);
    ctx.auth.view[0] = 0;
    ctx.c.onInput(keys);
    ctx.c.onRealTick(1000, {
      x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
      eyeHeight: 72, onGround: base.onGround, ducked: base.ducked,
      surfing: base.surfing, blockedTicks: base.blockedTicks, ladder: base.ladder,
    });
    ctx.shm.addInput(1, 0, keys);
    ctx.c.onWake(1000, 1008);
    return ctx;
  };
  // blocked 增量（keys&2）
  assert.equal(mk(2, { onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1 }).c.stats.orphanedCap, 1, 'blocked 增量');
  // ducked 翻转（keys&8）
  assert.equal(mk(1 | 8, { onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1 }).c.stats.orphanedCap, 1, 'ducked 翻转');
  // surfing 翻转（keys&32）
  assert.equal(mk(1 | 32, { onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1 }).c.stats.orphanedCap, 1, 'surfing 翻转');
  // ladder 翻转（keys&16）
  assert.equal(mk(1 | 16, { onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1 }).c.stats.orphanedCap, 1, 'ladder 翻转');
  // 无翻转 → 正常发布
  assert.equal(mk(1, { onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1 }).c.gate.stats.optimisticPublished, 1, '无封帽 → 发布');
});

// ── §8 key-edge gating ───────────────────────────────────────────────────
test('§8 key-edge gating：键沿变化 → 跳过该 tick 乐观发布', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1); // 基线键位 1（真实 tick 消费后）
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 1 | 2); // 窗内键沿（新按 2）
  ctx.c.onWake(1000, 1008);
  assert.equal(ctx.c.stats.keyEdgeSkips, 1);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assertClosureIdentity(ctx, 0, '键沿跳过不经门');
  // 同键位续发 → 恢复发布（基线随真实 tick 更新：blocked=1）
  ctx.c.onInput(1 | 2);
  ctx.c.onRealTick(1016, {
    x: 1, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 1, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 1 | 2);
  ctx.c.onWake(1016, 1024);
  assert.equal(ctx.c.stats.keyEdgeSkips, 1);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1, '键位稳定 → 恢复发布');
});

// ── §9 窗外/地板/追爆 ─────────────────────────────────────────────────────
test('§9 窗外（remaining > T−δ）/ 地板（remaining ≤ 1）/ 追爆（remaining ≤ 0）→ 无尝试', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 1);
  ctx.c.onWake(1000, 1024); // remaining=24 > 窗 8 → 窗未开（早醒，非损失不记账）
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assert.equal(ctx.c.stats.floorSkips, 0, '窗外早醒不记账（每 tick 多次的正常唤醒）');
  ctx.c.onWake(1000, 1000.5); // remaining=0.5 ≤ 地板 1 → 放弃
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assert.equal(ctx.c.stats.floorSkips, 1, '迟到地板计入 floorSkips（门上游，Q1 口径）');
  ctx.c.onWake(1000, 999); // 追爆 remaining<0（acc≥fixedDt 真步本唤醒触发）→ 回落纯历史
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assert.equal(ctx.c.stats.floorSkips, 2, '追爆同属地板分支');
  assert.equal(ctx.c.stats.bootstrapSkips, 0, '有锚：非引导跳过');
  assertClosureIdentity(ctx, 0, '窗外/地板/追爆均不触门');
  // 窗内正例：remaining ∈ (1, 8]
  ctx.c.onWake(1000, 1006);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1, 'remaining=6 ∈ 窗 → 发布');
  assert.equal(ctx.c.stats.floorSkips, 2, '发布命中不改地板账');
  assertClosureIdentity(ctx, 1, '闭账恒等');
});

// ── §10 同标签重发守卫 ────────────────────────────────────────────────────
test('§10 同标签重发守卫：窗内重复唤醒不重发', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 1);
  ctx.c.onWake(1000, 1006);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1);
  ctx.c.onWake(1002, 1006); // 同窗再唤醒（remaining 仍 ≤ 8）
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1, '不重发');
  assertClosureIdentity(ctx, 1, '闭账恒等');
});

// ── §11 R 键边沿断点 ──────────────────────────────────────────────────────
test('§11 R 键（位 128）边沿 → seg+1 + reset 位入下帧；按住不重触发', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.c.onInput(0);
  ctx.c.onInput(128); // 边沿 → seg 1→2 + reset 位
  ctx.c.onInput(128); // 按住期间重复 → 无新边沿
  const m = def(ctx.c.publishMeta(), 'meta 非空');
  assert.equal(m.seg, 2);
  assert.equal(m.evt, AUTH_EVT.reset);
  assert.equal(ctx.c.stats.seg, 2);
  const m2 = def(ctx.c.publishMeta(), 'meta2 非空');
  assert.equal(m2.evt, 0, '事件位逐帧排空');
  assert.equal(m2.seg, 2, '段不变');
});

// ── §12 权威事件排空 ──────────────────────────────────────────────────────
test('§12 权威 take_event（teleport/death）→ 段+1 + 位编码 + 一次性消费', () => {
  const ctx = makeCtx();
  boot(ctx);
  (ctx.auth as unknown as { events: { kind: string }[] }).events.push({ kind: 'teleport' });
  const m = def(ctx.c.publishMeta(), 'meta 非空');
  assert.equal(m.seg, 2, '段 +1');
  assert.equal(m.evt, AUTH_EVT.teleport);
  assert.equal(ctx.auth.take_event(), null, '事件槽已排空（一次性）');
  const m2 = def(ctx.c.publishMeta(), 'meta2 非空');
  assert.equal(m2.evt, 0);
  assert.equal(m2.seg, 2);
  // death 同式
  (ctx.auth as unknown as { events: { kind: string }[] }).events.push({ kind: 'death' });
  const m3 = def(ctx.c.publishMeta(), 'meta3 非空');
  assert.equal(m3.evt, AUTH_EVT.death);
  assert.equal(m3.seg, 3);
});

// ── §13 hold 冻结 ────────────────────────────────────────────────────────
test('§13 noteHoldTick：holdTicks + 投影作废（真实帧不对账）', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 0;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.shm.addInput(1, 0, 1);
  ctx.c.onWake(1000, 1006); // OPT 已发（label 1）
  ctx.c.noteHoldTick(); // hold 顶置吞掉 label 1 的真实帧（hold 支路 publishMeta）
  ctx.c.publishMeta(); // hold 帧 label 1（真实帧永远不来）
  ctx.c.onRealTick(1016, {
    x: 999, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  assert.equal(ctx.c.stats.revisions, 0, '冻结期投影作废——不 div');
  assert.equal(ctx.c.stats.holdTicks, 1);
});

// ── §14 world 重建 ───────────────────────────────────────────────────────
test('§14 externalWorldRebuild：标号归零 + 段+1 + worldRebuild 位 + 门重建', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.c.publishMeta();
  ctx.c.publishMeta();
  const segBefore = ctx.c.stats.seg;
  ctx.c.externalWorldRebuild();
  assert.equal(ctx.c.stats.tickLabel, 0, '标号归零');
  assert.equal(ctx.c.stats.seg, segBefore + 1);
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0, '门已重建（计数清零）');
  // 重建后引导期回归：onWake → bootstrapSkips
  const bs0 = ctx.c.stats.bootstrapSkips;
  ctx.shm.addInput(1, 0, 1);
  ctx.c.onWake(2000, 2008);
  assert.equal(ctx.c.stats.bootstrapSkips, bs0 + 1, '重建后重新 bootstrap');
  // 首个重建后真实帧携带 worldRebuild 位
  const m = def(ctx.c.publishMeta(), 'meta 非空');
  assert.equal(m.tick, 0);
  assert.equal(m.evt, AUTH_EVT.worldRebuild);
});

// ── §15 外部断点 ─────────────────────────────────────────────────────────
test('§15 externalBreak（respawn/teleport/load）→ 段+1 + 位编码', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.c.externalBreak(AUTH_EVT.respawn);
  const m = def(ctx.c.publishMeta(), 'meta 非空');
  assert.equal(m.seg, 2);
  assert.equal(m.evt, AUTH_EVT.respawn);
  ctx.c.externalBreak(AUTH_EVT.teleport);
  ctx.c.externalBreak(AUTH_EVT.load);
  const m2 = def(ctx.c.publishMeta(), 'meta2 非空');
  assert.equal(m2.seg, 4, '两次断点段 +2');
  assert.equal(m2.evt, AUTH_EVT.teleport | AUTH_EVT.load, '同帧多事件位并集');
});

// ── §16 非 tick 模式零回归 ────────────────────────────────────────────────
test('§16 非 tick 模式：meta undefined + 全钩子 no-op（耦合/解耦零触碰）', () => {
  const ctx = makeCtx();
  // 不 enterMode
  assert.equal(ctx.c.publishMeta(), undefined, 'publishMeta → undefined');
  assert.equal(ctx.c.firstFrameMeta(), undefined, 'firstFrameMeta → undefined');
  assert.equal(ctx.c.isActive(), false);
  ctx.c.onWake(1000, 1006);
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 0, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0,
    eyeHeight: 72, onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  ctx.c.externalBreak(AUTH_EVT.respawn); // no-op
  ctx.c.exitMode(); // 幂等 no-op
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assert.equal(ctx.c.stats.seg, 0, '段未动');
  assert.equal(ctx.shm.readAuthoritative(), null, '零发布');
  // enter→exit 后：pendingEvt 清空、发布零触碰
  ctx.c.enterMode();
  ctx.c.exitMode();
  assert.equal(ctx.c.firstFrameMeta(), undefined, 'exitMode 后 meta undefined');
});

// ── §17 MsgState 回退 ────────────────────────────────────────────────────
test('§17 MsgState（无 SAB/peekInput）→ F4 禁用纯历史', () => {
  const ctx = makeCtx();
  const msgShared = createWorkerSharedState(null);
  (ctx.env as { getShared(): unknown }).getShared = () => msgShared;
  ctx.c.enterMode();
  ctx.c.publishMeta();
  ctx.shm.addInput(1, 0, 1);
  ctx.c.onWake(1000, 1006);
  assert.equal(ctx.c.stats.f4Ready, false, '乐观径禁用');
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0);
  assertClosureIdentity(ctx, 0, '无尝试');
  // isActive 仍 true（真实步零分配支路仅依赖 authority+buffer）——MsgState 的
  // writeAuthoritative(meta) 存在，真实步正常出帧
  assert.equal(ctx.c.isActive(), true);
});

// ── §18 动态周期 → 门重建 ────────────────────────────────────────────────
test('§18 动态 tick 周期：T=10 → 门重建 δ cap=2', () => {
  const ctx = makeCtx();
  (ctx.env as { getTickPeriodMs(): number }).getTickPeriodMs = () => 10;
  ctx.c.enterMode();
  ctx.c.firstFrameMeta();
  ctx.c.publishMeta();
  ctx.c.onWake(1000, 1006); // 触发门重建（T 15.625→10；remaining=6 ∈ 新窗 (1,8]）
  assert.equal(ctx.c.gate.leadDeltaMs, 2, 'δ cap = T − ε_max = 2');
  // 门重建后锚 null（bootstrap 语义 §8.5）→ 本窗尝试=leadMiss（纯历史一拍）
  assert.equal(ctx.c.gate.stats.optimisticPublished, 0, '重建后无锚 → 不发');
  assert.equal(ctx.c.gate.stats.leadMiss, 1, 'leadMiss 计入（§8.5 停顿语义）');
  assertClosureIdentity(ctx, 1, '重建后闭账恒等');
});

// ── §20 红线审计（t4 验收 #2：权威实例零触碰零写入，代码可审计）────────────
test('§20 红线：乐观径零驱动权威 + authority 调用面 = 只读四方法', () => {
  const ctx = makeCtx();
  boot(ctx);
  ctx.auth.view[0] = 10;
  ctx.auth.view[21] = 1;
  ctx.c.onInput(1);
  ctx.c.onRealTick(1000, {
    x: 10, y: 0, z: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, eyeHeight: 72,
    onGround: true, ducked: 0, surfing: 0, blockedTicks: 0, ladder: -1,
  });
  const authSteps = ctx.auth.stepCount;
  const scratchSteps = ctx.scratch.stepCount;
  ctx.shm.addInput(30, 0, 1);
  ctx.c.onWake(1000, 1008); // 乐观开火（seed → scratch 单步 → 门 → 发 OPT 帧）
  assert.equal(ctx.c.gate.stats.optimisticPublished, 1, 'OPT 已发布');
  assert.equal(ctx.auth.stepCount, authSteps, '乐观径零驱动权威实例（红线：实例不动）');
  assert.equal(ctx.scratch.stepCount, scratchSteps + 1, '乐观评估只在 scratch 上单步');
  // 权限清单 = 结构性审计面：authority 可被调用的方法恰为只读四方法
  //（tick_into 只由 auth-loop 真实步驱动，非乐观径；无任何 set_* 写面）
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.auth) as object)
    .filter((n) => n !== 'constructor')
    .sort();
  assert.equal(surface.join(','), 'seed_from,state_out_ptr,take_event,tick_into', 'authority 面 = 只读四方法');
});

// ── §19 auth-loop additive 钩子集成（真 timer）────────────────────────────
async function integrationTests(): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // §19a tick 模式零分配支路：auth 线自动推进 + 每 tick meta 三元组
  {
    const ctx = makeCtx();
    const physStub = {
      ready: true,
      tick: () => {
        throw new Error('tick 模式不得走 v7 tick()（零分配支路未生效）');
      },
      tick_into: (dt: number, keys: number, dx: number, dy: number) =>
        ctx.auth.tick_into(dt, keys, dx, dy),
      state: () => {
        throw new Error('tick 模式不得走 state()（零分配视图未生效）');
      },
      state_out_ptr: () => ctx.auth.state_out_ptr(),
      take_event: () => ctx.auth.take_event(),
      seed_from: (src: object) => ctx.auth.seed_from(src),
    } as unknown as PhysWorldLike;
    const loop = createAuthLoop({
      get shared() {
        return ctx.shm;
      },
      getPhys: () => physStub,
      post: () => {},
      getComputeMode: () => 'tick',
      tickF4: ctx.c,
    });
    ctx.c.enterMode();
    ctx.c.firstFrameMeta();
    loop.start();
    ctx.shm.addInput(2, 0, 1);
    await wait(60); // ~3-4 tick @64Hz
    def(ctx.shm.readAuthoritative(), 'tick 模式 auth 线出帧');
    ctx.shm.readAuthoritativeInto(ctx.dstF, ctx.dstI);
    assert.equal(ctx.dstI[2], 1, 'seg 沿用');
    assert.ok(ctx.dstI[3] >= 1, 'tick 标号随真实 tick 递增');
    assert.ok(ctx.dstI[4] === 0 || ctx.dstI[4] === AUTH_EVT_OPT, 'evt ∈ {0, OPT}');
    assert.equal(ctx.dstI[0], 1, 'onGround（keys&1）');
    assert.ok(ctx.auth.stepCount >= 2, '零分配支路 tick_into 已驱动');
  }

  // §19b hold 顶置：帧定格 + 标号继续 + holdTicks 计数
  {
    const ctx = makeCtx();
    const physStub = {
      ready: true,
      tick: () => {
        throw new Error('hold 期不得 tick');
      },
      tick_into: (dt: number, keys: number, dx: number, dy: number) => ctx.auth.tick_into(dt, keys, dx, dy),
      state_out_ptr: () => ctx.auth.state_out_ptr(),
      take_event: () => null,
      seed_from: () => {},
      set_state: () => {},
      state: () => ({
        posX: ctx.auth.view[0], posY: ctx.auth.view[1], posZ: ctx.auth.view[2],
        yaw: ctx.auth.view[6], pitch: ctx.auth.view[7],
        velX: 0, velY: 0, velZ: 0, eyeHeight: 72, onGround: true,
      }),
    } as unknown as PhysWorldLike;
    let holding = true;
    const loop = createAuthLoop({
      get shared() {
        return ctx.shm;
      },
      getPhys: () => physStub,
      post: () => {},
      getComputeMode: () => 'tick',
      tickF4: ctx.c,
      holdState: () => (holding ? { x: 5, y: 6, z: 7, yaw: 8, pitch: 9, onGround: true } : null),
    });
    ctx.c.enterMode();
    ctx.c.firstFrameMeta();
    loop.start();
    ctx.shm.addInput(2, 0, 1);
    await wait(60);
    assert.ok(ctx.c.stats.holdTicks >= 2, 'hold 顶置计数');
    const f = def(ctx.shm.readAuthoritative(), 'hold 期帧已发布');
    assert.equal(f.frame.pos.x, 5, 'held 定格');
    assert.equal(f.frame.pos.y, 6);
    assert.equal(f.frame.pos.z, 7);
    assert.equal(f.frame.vel.x, 0, 'vel=0');
    assert.ok(ctx.c.stats.tickLabel >= 1, '冻结期标号继续');
  }

  // §19c 耦合回归：不注入钩子 = v7 行为（帧推进 + I_A_* 三槽零触碰）
  {
    const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
    const shm = new ShmState(sab);
    const rawI32 = new Int32Array(sab);
    const wasmBuf = new ArrayBuffer(4096);
    const world = new FakeWorld(wasmBuf, 0);
    const physStub = {
      ready: true,
      tick: (dt: number, keys: number, dx: number, dy: number) => world.tick_into(dt, keys, dx, dy),
      state: () => ({
        posX: world.view[0], posY: world.view[1], posZ: world.view[2],
        yaw: world.view[6], pitch: world.view[7],
        velX: world.view[3], velY: world.view[4], velZ: world.view[5],
        eyeHeight: 72, onGround: world.view[21] === 1,
      }),
    } as unknown as PhysWorldLike;
    const loop = createAuthLoop({
      get shared() {
        return shm;
      },
      getPhys: () => physStub,
      post: () => {},
      getComputeMode: () => 'coupled',
    });
    loop.start();
    shm.addInput(2, 0, 1);
    await wait(60);
    def(shm.readAuthoritative(), '耦合 v7 出帧');
    assert.ok(world.stepCount >= 2, 'v7 tick() 已驱动');
    assert.equal(rawI32[I_A_SEG], 0, '耦合：I_A_SEG 零触碰');
    assert.equal(rawI32[I_A_TICK], 0, '耦合：I_A_TICK 零触碰');
    assert.equal(rawI32[I_A_EVT], 0, '耦合：I_A_EVT 零触碰');
    assert.ok(rawI32[I_A_PSEQ] % 2 === 0, 'PSEQ 恒偶（seqlock 不变）');
  }

  // 集成完成（auth-loop timer 常驻——显式退出）
  console.log(`\ntick-authority.test.ts: ${passed} 例全绿`);
  console.log(names.map((n) => `  ✓ ${n}`).join('\n'));
  (globalThis as unknown as { process?: { exit(c?: number): void } }).process?.exit(0);
}

// 顺序执行单测，再进集成
integrationTests().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process?: { exit(c?: number): void } }).process?.exit(1);
});
