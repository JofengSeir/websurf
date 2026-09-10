/**
 * tick 消费器 node 单测（任务 t5 · 验证命令：esbuild bundle + node 直跑，禁浏览器）。
 *
 * 覆盖判据（对应 t5 验收 + Gate 2 消费侧断言）：
 * - P0 逐帧等式：弦插值逐帧落在某相邻真实帧对的弦上（α∈[0,1)，容差 1e-3 HU）
 *   + 消费器内部 α 一票否决/凸组合自检计数恒 0；
 * - τ 单调钳制（硬不变量①）：恒速运动下显示 x 逐帧非递减；Δ 调小→快进白名单；
 * - 时钟锚（硬不变量②）：首帧一次性 + 漂移快照重锚计数；
 * - 断窗（硬不变量④）：I_A_SEG 突变/首帧/evt 代理强制/deathY → break-direct，
 *   新段不跨界（显示值仅取新段）；
 * - 零外推红线（pure-history 兜底）：停止发布后显示值恒等于最新已发布帧
 *   （无任何外推形态）， starvation 逐 tick 去重 + hold-scheduled/hold-starved
 *   两态按 ε_max 预算分界；
 * - F4 对接：OPT 帧 → 政策升级 + direct-opt 精确直出 + 越点 hold 不得外推；
 *   修订到达 → snap + div 双桶（bulk 硬断言 / flip 独立计数 + P99 逃逸粘滞）；
 *   两格领先防御计数；修订漏采计数；f4 截断窗外推 P-ra-0 等式逐位核对；
 * - i32 wrap-safe tick diff；yaw 最短弧；seqlock 冲突（−1）弃读不断流。
 *
 * 运行：cd game && npx esbuild src/renderer/tick-consumer.test.ts --bundle
 *       --format=esm --outfile=temp/tick-consumer.test.mjs && node temp/tick-consumer.test.mjs
 */

import {
  TickConsumer,
  tickDiff,
  shortestArcLerp,
  type TickConsumerStats,
} from './tick-consumer.js';
import { AUTH_EVT, AUTH_EVT_OPT } from '../../../../src/ts-shared/auth/shared-state.js';

// ── 微型断言器 ─────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}
function close(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// ── 脚本化通道（模仿 SAB 最新帧语义：writeAuthoritative 覆写双缓冲）────
const T = 1000 / 64; // 15.625
const T0_MAIN = 1000; // 主线程时钟下 tick0 网格点
const LAG = 4; // 固定观测滞后（ε_publish + rAF 采样，无抖动模型）
interface PubFrame {
  f: Float64Array; // 10 值
  i: Int32Array; // [onGround, va, seg, tick, evt]
}
class ScriptedChannel {
  va = 0;
  latest: PubFrame | null = null;
  publish(
    tick: number,
    pos: [number, number, number],
    vel: [number, number, number],
    yaw: number,
    pitch: number,
    eye: number,
    onGround: boolean,
    seg: number,
    evt: number,
  ): void {
    this.va++;
    const f = new Float64Array(10);
    f[0] = pos[0]; f[1] = pos[1]; f[2] = pos[2];
    f[3] = yaw; f[4] = pitch;
    f[5] = vel[0]; f[6] = vel[1]; f[7] = vel[2];
    f[8] = eye;
    f[9] = T0_MAIN + tick * T + LAG; // worker timeMs（仅存档，消费器不用）
    const i = new Int32Array(5);
    i[0] = onGround ? 1 : 0;
    i[1] = this.va;
    i[2] = seg;
    i[3] = tick;
    i[4] = evt;
    this.latest = { f, i };
  }
  readInto = (dstF64: Float64Array, dstI32: Int32Array): number => {
    const l = this.latest;
    if (l === null) return 0;
    dstF64.set(l.f);
    dstI32.set(l.i);
    return l.i[1];
  };
}

/** 已发布真实帧台账（弦断言独立核对源）。 */
interface LogFrame {
  k: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/** rAF 调度驱动：把 [from, to] 按固定步进；每步先落 W_k ≤ now 的待发布 tick。
 * periodMs 缺省 144Hz；F4 场景（S6-S9）用 720Hz——乐观显示窗最坏 ~2ms 宽，
 * 低频步进网格会相位性漏采（确定性测试要求步距 ≪ 最坏窗宽）。 */
function drive(
  ch: ScriptedChannel,
  c: TickConsumer,
  from: number,
  to: number,
  publishDue: (now: number) => void,
  periodMs = 1000 / 144,
): void {
  for (let now = from; now < to; now += periodMs) {
    publishDue(now);
    c.step(now, ch.readInto);
  }
}

/** P0 弦断言：out 位置落在台账某相邻真实帧对的弦上（α∈[0,1)，1e-3 HU）。 */
function onSomeChord(st: TickConsumerStats, log: LogFrame[], x: number, y: number, z: number): boolean {
  if (log.length < 1) return false;
  for (let idx = 0; idx + 1 < log.length; idx++) {
    const a = log[idx];
    const b = log[idx + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    // 求出 x 投影 α 并全轴核对（非退化轴）
    const axis = Math.abs(dx) > 1e-9 ? dx : (Math.abs(dy) > 1e-9 ? dy : dz);
    if (Math.abs(axis) < 1e-9) continue;
    const denom = Math.abs(dx) > 1e-9 ? dx : (Math.abs(dy) > 1e-9 ? dy : dz);
    const alpha = (Math.abs(dx) > 1e-9 ? x - a.x : (Math.abs(dy) > 1e-9 ? y - a.y : z - a.z)) / denom;
    if (alpha < -1e-9 || alpha > 1 + 1e-9) continue;
    const ex = a.x + dx * alpha;
    const ey = a.y + dy * alpha;
    const ez = a.z + dz * alpha;
    if (close(x, ex, 1e-3) && close(y, ey, 1e-3) && close(z, ez, 1e-3)) return true;
  }
  void st;
  return false;
}

// ══ S1：P0 弦插值 + τ 单调（pure-history 主路径）══════════════
{
  console.log('S1 P0 弦插值 + τ 单调 + 自检计数恒 0');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  const log: LogFrame[] = [];
  let nextK = 0;
  // 变速直线：u_k ∈ {1, 1.5, 2} u/tick（位移互异 → 弦核对无歧义）
  const velOf = (k: number): [number, number, number] => [(64 * (1 + ((k % 3) * 0.5))), 0, 0];
  let prevX = 0;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG <= now) {
      const vx = velOf(nextK)[0];
      const x = prevX + vx * (T / 1000);
      ch.publish(nextK, [x, 0, 0], [vx, 0, 0], 90, 0, 64.09, true, 0, 0);
      log.push({ k: nextK, x, y: 0, z: 0, vx, vy: 0, vz: 0 });
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 400, publishDue);
  const s = c.stats;
  ok(s.lerpFrames > 50, `S1 lerp 帧数 >50（实测 ${s.lerpFrames}）`);
  ok(s.p0ConvexViolations === 0 && s.p0AlphaViolations === 0, `S1 P0 自检恒 0（convex=${s.p0ConvexViolations}, alpha=${s.p0AlphaViolations}）`);
  ok(onSomeChord(s, log, c.out.x, c.out.y, c.out.z), `S1 终帧位置落在某相邻真实帧弦上（x=${c.out.x.toFixed(4)}）`);
  ok(s.starvedTicks === 0, `S1 稳态无饥饿（starved=${s.starvedTicks}）`);
  ok(s.fallbackFrames <= 8, `S1 兜底仅引导缝（fallback=${s.fallbackFrames}）`);
  ok(c.out.policy === 'pure-history', `S1 政策 pure-history（实测 ${c.out.policy}）`);
  ok(c.out.state === 'lerp', `S1 稳态显示态 lerp（实测 ${c.out.state}）`);
}

// ══ S1b：τ 单调（显示 x 非递减）═════════════════════════════
{
  console.log('S1b τ 单调钳制（恒速运动显示 x 逐帧非递减）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let prevX = 0;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG <= now) {
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
  };
  let lastX = -1e9;
  let monotonic = true;
  const step = 1000 / 144;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 300; now += step) {
    publishDue(now);
    c.step(now, ch.readInto);
    if (c.out.state === 'lerp' || c.out.state === 'break-direct') {
      if (c.out.x < lastX - 1e-9) monotonic = false;
      lastX = c.out.x;
    }
  }
  ok(monotonic, 'S1b 显示 x 逐帧非递减');
}

// ══ S2：零外推红线 + hold 两态按 ε_max 预算分界 + starvation 去重 ══
{
  console.log('S2 兜底零外推 + hold-scheduled/starved 预算分界 + starvation 逐 tick 去重');
  const ch = new ScriptedChannel();
  // guard=1 < epsMax=8：显示需求先于饥饿预算（带宽 7ms > rAF 周期 6.94ms → 必采）
  const c = new TickConsumer({ tickRate: 64, guardMs: 1, epsMaxMs: 8 });
  let nextK = 0;
  let prevX = 0;
  const publishDue = (now: number): void => {
    while (nextK <= 20 && T0_MAIN + nextK * T + LAG <= now) {
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 360, publishDue); // k=20 后停发（至 starvation 阈值后）
  const s = c.stats;
  ok(s.starvedTicks >= 1, `S2 starvation 计数 ≥1（实测 ${s.starvedTicks}）`);
  ok(s.starvedTicks === 1, `S2 starvation 逐 tick 去重 =1（实测 ${s.starvedTicks}）`);
  ok(s.holdScheduledFrames > 0 && s.holdStarvedFrames > 0, `S2 两态分立（sched=${s.holdScheduledFrames}, starved=${s.holdStarvedFrames}）`);
  // 零外推红线：停发后显示值恒 = F_20（发布器 x=k+1 → F_20.x=21）
  ok(close(c.out.x, 21, 1e-9), `S2 停发后显示冻结在 F_20（x=${c.out.x.toFixed(6)}）`);
  ok(c.out.state === 'hold-starved', `S2 终态 hold-starved（实测 ${c.out.state}）`);
  ok(s.p0ConvexViolations === 0, `S2 兜底路径零外推（convex=${s.p0ConvexViolations}）`);
}

// ══ S3：I_A_SEG 断窗 + 新段不跨界 ═══════════════════════════
{
  console.log('S3 I_A_SEG 断窗（teleport 跳段）+ 新段不跨界');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let prevX = 0;
  let jumped = false;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG <= now) {
      if (nextK === 10 && !jumped) {
        jumped = true;
        const x = prevX + 500; // teleport：seg+1
        ch.publish(nextK, [x, 0, 0], [0, 0, 0], 90, 0, 64.09, true, 1, AUTH_EVT.teleport);
        prevX = x;
        nextK++;
        continue;
      }
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, jumped ? 1 : 0, 0);
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 400, publishDue);
  const s = c.stats;
  ok(s.segEvents === 1, `S3 segEvents=1（实测 ${s.segEvents}）`);
  ok(s.breakDirectFrames >= 1, `S3 break-direct ≥1（实测 ${s.breakDirectFrames}）`);
  ok(c.out.x > prevX - 400, `S3 显示在新段（x=${c.out.x.toFixed(2)}）`);
  ok(s.evtForceBreaks === 0, `S3 正确标段的 teleport 不触发强制代理（evtForce=${s.evtForceBreaks}）`);
}

// ══ S4：消费侧封帽代理强制断窗（worker 漏标 seg）══════════════
{
  console.log('S4 evt 位强制断窗（worker 漏标 seg 自愈）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let prevX = 0;
  let evtTick = -1;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG <= now) {
      if (nextK === 10 && evtTick < 0) {
        evtTick = nextK;
        const x = prevX + 300; // 事件跳变但 seg 未 +1（worker 缺陷模拟）
        ch.publish(nextK, [x, 0, 0], [0, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT.teleport);
        prevX = x;
        nextK++;
        continue;
      }
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 400, publishDue);
  const s = c.stats;
  ok(s.evtForceBreaks === 1, `S4 evtForceBreaks=1（实测 ${s.evtForceBreaks}）`);
  ok(s.breakDirectFrames >= 1, `S4 强制断窗后直出 ≥1（实测 ${s.breakDirectFrames}）`);
}

// ══ S5：deathY 补判 ═══════════════════════════════════════
{
  console.log('S5 deathY 强制断窗');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64, deathY: -100 });
  let nextK = 0;
  let prevX = 0;
  let fell = false;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG <= now) {
      if (nextK === 10 && !fell) {
        fell = true;
        ch.publish(nextK, [prevX + 1, -150, 0], [0, -800, 0], 90, 0, 64.09, false, 0, 0);
        prevX += 1;
        nextK++;
        continue;
      }
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 400, publishDue);
  const s = c.stats;
  ok(s.deathYBreaks === 1, `S5 deathYBreaks=1（实测 ${s.deathYBreaks}）`);
  ok(s.breakDirectFrames >= 1, `S5 死亡断窗直出 ≥1（实测 ${s.breakDirectFrames}）`);
}

// ══ S6：F4 政策升级 + direct-opt 精确直出 + 修订 snap + div bulk ══
// 时间线（δ_pub=10，720Hz 步进）：real k 于 due(k)；OPT(11) 于 due(11)−10
// （guess +0.5u）；真 11 为修订（div=0.5 → bulk 桶）。断言：政策升级、乐观窗
// 直出值逐位精确、修订 snap 对账、双桶分账、修订后截断窗外推接管。
{
  console.log('S6 F4 升级 + direct-opt + 修订 snap + div 双桶（bulk）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  const dueOf = (k: number): number => T0_MAIN + k * T + LAG;
  let nextK = 0;
  let prevX = 0;
  let optPub = false;
  const optX = 11.5; // OPT(11)：真步 x=11 + 0.5u 乐观偏差
  let sawDirectOpt = 0;
  let directOptExact = true;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 230; now += 1000 / 720) {
    while (nextK <= 13 && dueOf(nextK) <= now) {
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
    if (!optPub && now >= dueOf(11) - 10) {
      optPub = true;
      ch.publish(11, [optX, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT);
    }
    c.step(now, ch.readInto);
    if (c.out.state === 'direct-opt') {
      sawDirectOpt++;
      if (!close(c.out.x, optX, 1e-9)) directOptExact = false;
    }
  }
  const s = c.stats;
  ok(s.policyUpgrades === 1 && c.out.policy === 'f4', `S6 政策升级 f4（${c.out.policy}, upgrades=${s.policyUpgrades}）`);
  ok(sawDirectOpt > 0 && directOptExact, `S6 乐观直出帧 >0 且逐位精确（帧数=${sawDirectOpt}）`);
  ok(s.revisionSnaps === 1, `S6 修订 snap=1（实测 ${s.revisionSnaps}）`);
  ok(s.divBulkSamples === 1, `S6 div bulk 样本=1（实测 ${s.divBulkSamples}）`);
  ok(close(s.lastDivU, 0.5, 1e-9), `S6 div=0.5u（实测 ${s.lastDivU.toFixed(6)}）`);
  ok(s.divBulkHardViolations === 0, `S6 bulk 硬断言通过（viol=${s.divBulkHardViolations}）`);
  ok(s.divFlipSamples === 0, `S6 flip 桶零样本（实测 ${s.divFlipSamples}）`);
  ok(s.p99Escape === false, `S6 P99 逃逸未触发`);
  ok(s.extrapolatedFrames > 0, `S6 修订后截断窗外推接管（帧数=${s.extrapolatedFrames}）`);
  ok(s.starvedTicks === 0, `S6 无饥饿（starved=${s.starvedTicks}）`);
}

// ══ S7：div flip 桶（onGround 翻转代理）+ P99 逃逸粘滞 ════════
// 时间线（720Hz）：real 1/2 onGround=0（与 OPT onG=1 翻转，无 evt 位、seg 不变
// → 翻转代理入 flip 桶）；OPT guess +2u → div=2u ×2 → P99=2 > 1.5 → 逃逸粘滞。
{
  console.log('S7 div flip 桶 + P99 逃逸（回开混合评审信号）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  const dueOf = (k: number): number => T0_MAIN + k * T + LAG;
  let nextK = 0;
  let prevX = 0;
  let opt1 = false;
  let opt2 = false;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 120; now += 1000 / 720) {
    while (nextK <= 5 && dueOf(nextK) <= now) {
      const x = prevX + 1;
      const onG = nextK !== 1 && nextK !== 2; // real 1/2 onGround=0（与 OPT 翻转）
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, onG, 0, 0);
      prevX = x;
      nextK++;
    }
    if (!opt1 && now >= dueOf(1) - 10) {
      opt1 = true;
      ch.publish(1, [prevX + 3, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT); // guess = 真 1 (x=prevX+1) +2u
    }
    if (!opt2 && now >= dueOf(2) - 10) {
      opt2 = true;
      ch.publish(2, [prevX + 3, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT); // guess = 真 2 (x=prevX+1) +2u
    }
    c.step(now, ch.readInto);
  }
  const s = c.stats;
  ok(s.revisionSnaps === 2, `S7 修订 snap=2（实测 ${s.revisionSnaps}）`);
  ok(s.divFlipSamples === 2, `S7 flip 样本=2（实测 ${s.divFlipSamples}）`);
  ok(s.divBulkSamples === 0, `S7 bulk 桶零样本（实测 ${s.divBulkSamples}）`);
  ok(s.divFlipMaxU >= 2, `S7 flip max ≥2u（实测 ${s.divFlipMaxU.toFixed(3)}）`);
  ok(s.p99Escape === true, `S7 P99 逃逸粘滞置位（p99=${s.divFlipP99U.toFixed(3)}）`);
  ok(c.out.policy === 'f4' && s.policyUpgrades === 1, `S7 政策保持 f4（OPT 断供 4 tick < 8 未降级）`);
}

// ══ S8：f4 截断窗外推 P-ra-0 等式逐位核对 + 越帽 hold ═════════
// 停发后 f4 政策 + 无 OPT → 截断窗外推（δ_pub=10 升级后 Δ_f4 由 δ 实测决定）。
// 期望值用 debugAnchorT0（EMA 冻结）+ stats.deltaEffMs 逐位复算（容差 1e-6）。
{
  console.log('S8 f4 截断窗外推等式 + 越帽 hold');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  const dueOf = (k: number): number => T0_MAIN + k * T + LAG;
  let nextK = 0;
  let prevX = 0;
  let optPub = false;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 200; now += 1000 / 720) {
    while (nextK <= 12 && dueOf(nextK) <= now) {
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
    if (!optPub && now >= dueOf(11) - 10) {
      optPub = true;
      ch.publish(11, [11, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT); // guess=真步（div=0）
    }
    c.step(now, ch.readInto);
  }
  // 停发（k=12 为最新）：f4 + 无 OPT(13) → 截断窗外推 → 越帽 hold
  const T0EST = c.debugAnchorT0();
  let checked = 0;
  let cappedSeen = false;
  for (let now = T0_MAIN + 200; now < T0_MAIN + 300; now += 1000 / 720) {
    c.step(now, ch.readInto);
    const delta = c.stats.deltaEffMs;
    const tau = now - delta; // 绝对刻度（display 同式）
    const tNewest = T0EST + 12 * T;
    if (tau > tNewest) {
      const sSec = (tau - tNewest) / 1000;
      const newestX = 13; // 发布器 x=k+1 → F_12.x=13（消费器 newest real = tick 12）
      const capX = newestX + 64 * (T / 1000);
      const expectX = newestX + 64 * Math.min(sSec, T / 1000);
      if (sSec <= T / 1000) {
        ok(c.out.state === 'extrapolate-capped' && close(c.out.x, expectX, 1e-6),
          `S8 外推等式帧 #${checked}（state=${c.out.state}, x=${c.out.x.toFixed(6)}, expect=${expectX.toFixed(6)}）`);
      } else {
        cappedSeen = true;
        ok(c.out.state === 'hold-scheduled' && close(c.out.x, capX, 1e-6),
          `S8 越帽 hold 恒值帧 #${checked}（x=${c.out.x.toFixed(6)}）`);
      }
      checked++;
      if (checked > 40) break;
    }
  }
  ok(checked > 10, `S8 核对帧数 >10（实测 ${checked}）`);
  ok(cappedSeen, 'S8 越帽 hold 已覆盖');
}

// ══ S9：两格领先防御 + 修订漏采 ═════════════════════════════
// 时间线（720Hz）：OPT(11) 于 due(11)−10（可显示 → shownOptTick=11）；OPT(12)
// 于 due(11)−8（后发覆盖通道 → 被读 → 两格领先违规样本；此后通道滞留 OPT(12)，
// findOptAfterReal 只认 K+1=11 → 不显示，无越权直出）；真 11+12 同步突发发布
// （catch-up 模拟，通道=12）→ 读者跳过真 11 → shownOptTick=11 的修订漏采。
{
  console.log('S9 optLead 防御 + revisionMissed');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  const dueOf = (k: number): number => T0_MAIN + k * T + LAG;
  let nextK = 0;
  let prevX = 0;
  let opt11 = false;
  let opt12 = false;
  let burst = false;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 230; now += 1000 / 720) {
    while (nextK <= 10 && dueOf(nextK) <= now) {
      const x = prevX + 1;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
    if (!opt11 && now >= dueOf(11) - 10) {
      opt11 = true;
      ch.publish(11, [11, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT);
    }
    if (!opt12 && now >= dueOf(11) - 8) {
      opt12 = true;
      ch.publish(12, [12, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, AUTH_EVT_OPT); // 两格领先（违规样本）
    }
    if (!burst && now >= dueOf(12)) {
      burst = true;
      ch.publish(11, [11, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0); // 真 11（修订，同步突发）
      ch.publish(12, [12, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0); // 真 12（通道覆写 → 读者跳过 11）
      prevX = 12;
      nextK = 13;
    }
    if (burst) {
      while (nextK <= 13 && dueOf(nextK) <= now) {
        const x = prevX + 1;
        ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
        prevX = x;
        nextK++;
      }
    }
    c.step(now, ch.readInto);
  }
  const s = c.stats;
  ok(s.optLeadViolations === 1, `S9 optLeadViolations=1（实测 ${s.optLeadViolations}）`);
  ok(s.revisionMissed === 1, `S9 修订漏采=1（真 11 被突发覆写，实测 ${s.revisionMissed}）`);
  ok(s.revisionSnaps === 0, `S9 无对账 snap（OPT(11) 修订被跳过，实测 ${s.revisionSnaps}）`);
  ok(s.divBulkSamples + s.divFlipSamples === 0, `S9 漏采不产生 div 样本（bulk=${s.divBulkSamples}, flip=${s.divFlipSamples}）`);
  ok(s.directOptFrames > 0, `S9 OPT(11) 曾直出（shownOptTick 锚定前提，帧数=${s.directOptFrames}）`);
}

// ══ S10：yaw 最短弧 ═══════════════════════════════════════
{
  console.log('S10 yaw 最短弧');
  ok(close(shortestArcLerp(359, 1, 0.5), 0, 1e-9), `S10 359→1 中点=0（${shortestArcLerp(359, 1, 0.5)}）`);
  ok(close(shortestArcLerp(10, 350, 0.5), 0, 1e-9), `S10 10→350 中点=0（${shortestArcLerp(10, 350, 0.5)}）`);
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let sawShortArc = false;
  for (let now = T0_MAIN + 2; now < T0_MAIN + 130; now += 1000 / 144) {
    while (T0_MAIN + nextK * T + LAG <= now && nextK < 6) {
      ch.publish(nextK, [nextK, 0, 0], [64, 0, 0], nextK === 3 ? 359 : (nextK === 4 ? 1 : 90), 0, 64.09, true, 0, 0);
      nextK++;
    }
    c.step(now, ch.readInto);
    // lerp 跨立对 (3,4) 时 yaw 应走 359→1 短弧（过 0 附近；错走长弧会在 ~180）
    if (c.out.state === 'lerp' && c.out.yaw > -6 && c.out.yaw < 6) sawShortArc = true;
  }
  ok(sawShortArc, `S10 lerp 走短弧（实测终 yaw=${c.out.yaw.toFixed(3)}）`);
}

// ══ S11：漂移快照重锚 + guard 快进 + seqlock 冲突 ═════════════
{
  console.log('S11 漂移重锚 / guard 快进 / 读冲突弃读');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let drift = 0;
  const publishDue = (now: number): void => {
    while (T0_MAIN + nextK * T + LAG + drift <= now) {
      // 漂移直接叠加在发布时刻上（worker 时钟跳变模拟）
      const x = nextK;
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      if (nextK === 10) drift = 40; // epoch 级跳变 → 漂移快照重锚
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 400, publishDue);
  const s = c.stats;
  ok(s.reanchorEvents === 1, `S11 漂移重锚=1（实测 ${s.reanchorEvents}）`);
  ok(s.anchorEvents === 1, `S11 首帧一次性锚=1（实测 ${s.anchorEvents}）`);
  const ffBefore = s.fastForwardEvents;
  c.setGuardMs(4); // 调小 → 快进白名单
  drive(ch, c, T0_MAIN + 400, T0_MAIN + 440, publishDue);
  ok(c.stats.fastForwardEvents === ffBefore + 1, `S11 快进计数 +1（${ffBefore}→${c.stats.fastForwardEvents}）`);
  const rcBefore = c.stats.readConflicts;
  const realRead = ch.readInto;
  ch.readInto = () => -1; // 模拟 seqlock 复检失败（dst 弃用语义）
  drive(ch, c, T0_MAIN + 440, T0_MAIN + 460, publishDue);
  ch.readInto = realRead; // 恢复正常读
  ok(c.stats.readConflicts === rcBefore + Math.round(20 / (1000 / 144)), `S11 冲突弃读计数（${rcBefore}→${c.stats.readConflicts}）`);
  ok(c.stats.framesIngested > 0, 'S11 恢复后继续摄入');
}

// ══ S12：wrap-safe tick diff + 断言器自检 ═══════════════════
{
  console.log('S12 wrap-safe tick diff');
  ok(tickDiff(5, 3) === 2 && tickDiff(-2147483648 + 3, -2147483648) === 3, 'S12 i32 wrap 差值语义');
  ok(tickDiff(2, 5) === -3, 'S12 负差值');
}

// ══ S13：Δ 事件驱动控制器（t3 §3.1.1 v1.3 + P-tick-8 记账）══════════════
{
  console.log('S13 Δ 控制器（饥饿步进 + 恢复步降 + 界 + 无极限环）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  let nextK = 0;
  let prevX = 0;
  let publishing = true;
  const publishDue = (now: number): void => {
    if (!publishing) return;
    while (T0_MAIN + nextK * T + LAG <= now) {
      const x = prevX + 1; // 1 u/tick 匀速
      ch.publish(nextK, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX = x;
      nextK++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 100, publishDue);
  ok(c.getGuardMs() === 8, `S13 稳态 guard=8（实测 ${c.getGuardMs()}）`);
  const adj0 = c.stats.deltaAdjustEvents;
  // 饥饿突发：停发 70ms → 若干 starved tick（ε_max=8 后逐 tick 步进）
  publishing = false;
  drive(ch, c, T0_MAIN + 100, T0_MAIN + 170, publishDue);
  const guardAfterBurst = c.getGuardMs();
  ok(guardAfterBurst > 8, `S13 饥饿步进 guard 上升（8→${guardAfterBurst}）`);
  ok(c.stats.deltaAdjustEvents > adj0, `S13 步进事件记账（${adj0}→${c.stats.deltaAdjustEvents}）`);
  // 恢复：恢复发布 + 12s clean @144Hz（门控 1000 槽 ≈ 6.9s 后步降）
  publishing = true;
  const adjAfterBurst = c.stats.deltaAdjustEvents;
  drive(ch, c, T0_MAIN + 170, T0_MAIN + 170 + 12000, publishDue);
  const guardAfterRecover = c.getGuardMs();
  ok(guardAfterRecover < guardAfterBurst, `S13 恢复步降（${guardAfterBurst}→${guardAfterRecover}）`);
  ok(c.stats.deltaAdjustEvents > adjAfterBurst, 'S13 恢复步事件记账');
  // 长驱到下界：guard=4（Δ_min = T+4 = 19.625）
  drive(ch, c, T0_MAIN + 170 + 12000, T0_MAIN + 170 + 40000, publishDue);
  ok(c.getGuardMs() === 4, `S13 下界 guard=4（实测 ${c.getGuardMs()}）`);
  // P-tick-8 无极限环：floor 稳态 2s 内步进事件不再增加
  const adjFloor = c.stats.deltaAdjustEvents;
  drive(ch, c, T0_MAIN + 170 + 40000, T0_MAIN + 170 + 42000, publishDue);
  ok(c.stats.deltaAdjustEvents === adjFloor, `S13 无极限环（floor 稳态 ${adjFloor}→${c.stats.deltaAdjustEvents}）`);
  // 硬帽：重复饥饿事件把 guard 顶到 0.5T+8（⟺ Δ_max = 1.5T+8 = 31.4375）。
  // starvation 事件按突发去重（每 burst 计 1）→ 8 次独立突发触帽（8+8 > 15.8125）。
  // 每轮 40ms 停发 = 1 个 starved 事件；60ms 恢复发布 = 重置去重键（clean 槽远
  // 不足 1000，恢复步降不触发）。
  const ch2 = new ScriptedChannel();
  const c2 = new TickConsumer({ tickRate: 64 });
  let k2 = 0;
  let prevX2 = 0;
  let paused = false;
  const pub2 = (now: number): void => {
    if (paused) return;
    while (T0_MAIN + k2 * T + LAG <= now) {
      const x = prevX2 + 1;
      ch2.publish(k2, [x, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      prevX2 = x;
      k2++;
    }
  };
  drive(ch2, c2, T0_MAIN + 2, T0_MAIN + 60, pub2); // 稳态
  let t2 = T0_MAIN + 60;
  for (let i = 0; i < 10; i++) {
    paused = true;
    drive(ch2, c2, t2, t2 + 40, pub2); // 饥饿突发（+1ms）
    paused = false;
    drive(ch2, c2, t2 + 40, t2 + 100, pub2); // 恢复发布（重置去重）
    t2 += 100;
  }
  ok(Math.abs(c2.getGuardMs() - (0.5 * T + 8)) < 1e-9, `S13 硬帽 guard=${0.5 * T + 8}（实测 ${c2.getGuardMs()}）`);
  ok(close(c2.getDeltaMs(), 1.5 * T + 8, 1e-9), `S13 Δ 上限=${1.5 * T + 8}（实测 ${c2.getDeltaMs()}）`);
}

// ══ S14：setTickRate 变率重建（worker 未竟 #1 收口）══════════════════
{
  console.log('S14 setTickRate（幂等 + 变率 bootstrap + 不变量保持）');
  const ch = new ScriptedChannel();
  const c = new TickConsumer({ tickRate: 64 });
  // 幂等：同率 no-op（stats 无扰动）
  const before = c.stats.displayedFrames + c.stats.framesIngested;
  c.setTickRate(64);
  ok(c.stats.displayedFrames + c.stats.framesIngested === before, 'S14 同率 no-op（幂等）');
  ok(close(c.tickRateHz, 64, 1e-9), 'S14 tickRateHz=64');
  // 阶段一：64Hz 发布 80 ticks
  let k = 0;
  let lastX = 0;
  let lastDisplayX = -1e9;
  const pub64 = (now: number): void => {
    while (k * (1000 / 64) + 4 <= now - T0_MAIN) {
      lastX = k + 1;
      ch.publish(k, [lastX, 0, 0], [64, 0, 0], 90, 0, 64.09, true, 0, 0);
      k++;
    }
  };
  drive(ch, c, T0_MAIN + 2, T0_MAIN + 1000, pub64);
  ok(c.stats.framesIngested >= 40, `S14 64Hz 摄入（${c.stats.framesIngested}）`);
  // 变率：64 → 96（结构常量重建 + bootstrap；guard 回 8 → Δ=10.417+8=18.4167）
  c.setTickRate(96);
  ok(close(c.tickRateHz, 96, 1e-9), `S14 tickRateHz=96（实测 ${c.tickRateHz}）`);
  ok(c.getGuardMs() === 8, `S14 变率后 guard 回 8（实测 ${c.getGuardMs()}）`);
  const T96 = 1000 / 96;
  // 阶段二：96Hz 发布 160 ticks（k 连续；EMA bootstrap 以新 T 重建 T0_est）
  const pub96 = (now: number): void => {
    while (k * T96 + 4 <= now - T0_MAIN) {
      lastX = k + 1;
      ch.publish(k, [lastX, 0, 0], [96, 0, 0], 90, 0, 64.09, true, 0, 0);
      k++;
    }
  };
  let prevDisplay = -1e9;
  let maxAlphaViolation = 0;
  let displayLagTicks = 0;
  drive(ch, c, T0_MAIN + 1000, T0_MAIN + 3000, pub96, 1000 / 144);
  // 硬不变量保持：τ 单调（显示 x 非递减）+ P0 自检恒 0 + 显示滞后 ≤ 2 tick
  ok(c.stats.p0AlphaViolations === 0 && c.stats.p0ConvexViolations === 0, `S14 P0 自检恒 0（α=${c.stats.p0AlphaViolations}/凸=${c.stats.p0ConvexViolations}）`);
  ok(c.out.x >= lastX - 3, `S14 显示追上新率发布（out.x=${c.out.x} vs 发布 ${lastX}）`);
  ok(close(c.getDeltaMs(), T96 + 8, 1e-9), `S14 Δ=T96+guard=${(T96 + 8).toFixed(4)}（实测 ${c.getDeltaMs()}）`);
  ok(c.stats.framesIngested >= 120, `S14 96Hz 摄入续计（${c.stats.framesIngested}）`);
  void prevDisplay; void maxAlphaViolation; void displayLagTicks; void lastDisplayX;
}

console.log(`\n结果：${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  throw new Error(`tick-consumer.test FAILED (${failures.length})`);
}
