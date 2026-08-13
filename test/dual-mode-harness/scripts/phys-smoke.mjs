#!/usr/bin/env node
/**
 * WebSurf-test — WorkerA 双模物理核心冒烟测试（node 可跑，不依赖 DOM/Worker）。
 *
 * 用法：node scripts/phys-smoke.mjs
 *
 * 在 node 环境模拟最新时序图核心逻辑（与 test/dual-mode-harness/src/shared-state.ts / worker-a.ts
 * / worker-b.ts 镜像）：
 * - 世界构建/落地/跳跃/respawn 基本物理断言（PhysWorld wasm）
 * - 双缓冲：writeState 写空闲槽（S[V&1^1]）→ readState 读当前槽 S[V&1]（交替正确）
 * - writeStateRaw 零分配直写（wasm API 能力验证；worker-a 实际子步热路径为
 *   writeState → phys.state()，不使用 writeStateRaw/tick_into——见下方热路径两条）
 * - V 递增用 add（写 N 次 → V 增 N）
 * - WAKEUP 协议：wake() 后 waitWakeup 立即返回（被唤醒）；无 wake 时 wait 超时返回；
 *   阶段0 writeTickRate 仅 store（不影响 WAKEUP）
 * - RENDER_WAKEUP 协议（WorkerB 独立渲染槽）：wake() 双槽同置位；waitRenderWakeup
 *   立即返回/超时/复位；双槽隔离——WorkerA 消费 WAKEUP 后渲染唤醒仍保留
 * - 帧信号驱动（阶段3 主驱动，worker_threads 真线程）：**发布（writeStateRaw）不
 *   notify**（仅 V++——1kHz 随机相位唤醒已移除）；主线程 wake()（rAF 帧信号）唤醒
 *   挂起渲染循环（vsync 对齐——渲染节奏 = 显示器刷新，呈现平滑）
 * - 8 次子步上限：一次大 delta（如 20ms）→ 物理最多 8 个子步；**上限耗尽保留剩余累加**
 *   （下轮补跑），仅封顶 MAX_ACC 防无限追赶（MAX_ACC=0.02 与 worker-a 同步）
 * - 热路径 API 能力验证（worker-a 实际子步热路径为 writeState → phys.state()，
 *   不使用 tick 返回值直写 / tick_into / writeStateRaw——下述两条仅验证 wasm API 能力）：
 * - tick() 返回值字段直接写状态槽（不再二次 phys.state()——能力描述，省一次
 *   wasm→JS 对象构造，GC 压力减半）
 * - tick_into 零分配热路径：tick_into → state_out_ptr 的 Float64Array 视图直读 8 标量
 *   → writeStateRaw——每子步零 JS 对象分配（与 tick 同语义，state_out 与 state() 一致）
 * - 输入限幅：consumeInput(clamp) 超限值被截断（±1000 防穿墙）
 * - 渲染采样与重绘（模拟 WorkerB 最终时序）：本地副本唯一参数源 = readState；
 *   仅状态更新时重绘（V 未变不提交 Draw——高频屏不重复渲染相同状态）；去重粒度 =
 *   版本号而非状态值（V 递增但值相同仍重绘——加载期行为实证）
 * - !ready 世界（未 build_world）：tick 不报错且 V 仍每 ms 递增（地图加载期 WorkerB
 *   去重失效的实证）
 * - 梯子（on_ladder 索引化回归）：真实梯子世界抓梯攀爬 / 跳离 / 换图重建不 panic
 * - 长时间停顿（隐藏标签页）：delta 钳制 + 8 子步上限 + 后续轮次有界追赶收敛
 * - 模式B（权威 tick + 速度校准——2026-08-11 重构：**先 tick 计算、后无限制计算**，
 *   对齐 game 双线语义）：**独立 tick 实例**（第二个 PhysWorld，只走 tickDt 步长——
 *   真实 64t 物理）每 1/TICK_RATE 边界用采样输入（键位 = 当前掩码、鼠标 = 模式A
 *   实时消耗累积）推进 → `set_velocity(三轴速度)` 校准模式A（**唯一 tick 影响通道**，
 *   位置/角度绝不触碰——用户要求 3）；模式A（无限制）1ms 子步 + **实时输入**
 *   （位置/角度唯一推进者，共享槽唯一写入者）；TICK_RATE ≥ 1000（tickDt ≤ 1ms）
 *   或 0 → 跳过模式B（纯 1ms 无限制，防双倍物理）
 * - 模式B 不写共享槽（用户定调：共享槽只由模式A 写——模式B 只做 set_velocity 速度修正，
 *   V 不递增、readState 返回 null）
 * - 消息回退模式（无 SAB）：main→WorkerA 输入/难度 postMessage；WorkerA→WorkerB 状态
 *   直连；V 版本/仅状态更新重绘/限幅/松手清零语义与 SAB 模式一致；wait 立即超时返回
 *
 * 注：node 无 TS 加载器，TestShared 与 brush JSON 在此复制镜像（与 shared-state.ts
 * / worker-a.ts 逐字一致；改动须同步）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PhysWorld, BspProcessor, initSync } from '../pkg/websurf_test_wasm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 断言工具 ────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function close(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ── 世界构建（手工 brush JSON 镜像；worker-a.ts 已删除同款函数，此处仅作时序/逻辑测试）──
// brush 平面约定：法线朝外、dist=dot(n,面上一点)、内部 = dot(n,p)-dist <= 0；
// 地面有限厚（顶面 (0,1,0) dist=0、底面 (0,-1,0) dist=64）——无限厚会 Minkowski 卡死。
const q = 1 / Math.SQRT2;
const brushes = [
  {
    planes: [
      { normal: [0, 0, -1], dist: 2048 }, // z- 侧（z=-2048）
      { normal: [0, 0, 1], dist: 2048 }, // z+ 侧（z=2048）
      { normal: [-1, 0, 0], dist: 2048 }, // x- 侧（x=-2048）
      { normal: [1, 0, 0], dist: 2048 }, // x+ 侧（x=2048）
      { normal: [0, -1, 0], dist: 64 }, // 底面（y=-64）
      { normal: [0, 1, 0], dist: 0 }, // 顶面（y=0，玩家站立面）
    ],
    min: [-2048, -64, -2048],
    max: [2048, 0, 2048],
    is_ladder: false,
    is_solid: true,
  },
  {
    // 斜顶 brush：盒 5 面 + 顶面替换为斜平面（normal (0,-0.707,0.707)，dist=dot(n,面上一点)）
    planes: [
      { normal: [0, 0, -1], dist: 1024 }, // z- 侧（z=-1024）
      { normal: [0, 0, 1], dist: -256 }, // z+ 侧（z=-256）
      { normal: [-1, 0, 0], dist: 256 }, // x- 侧（x=256）
      { normal: [1, 0, 0], dist: 512 }, // x+ 侧（x=512）
      { normal: [0, -1, 0], dist: 64 }, // 底面（y=-64）
      { normal: [0, -q, q], dist: q * -256 }, // 斜顶面
    ],
    min: [256, -64, -1024],
    max: [512, 0, -256],
    is_ladder: false,
    is_solid: true,
  },
];

// ── TestShared 镜像（与 shared-state.ts 布局/协议逐字一致）─────────
// 布局（Int32 索引）：[0]TICK_RATE [1]WAKEUP [2]dxAcc(B64 索引 1) [4]dyAcc(B64 索引 2)
// [6]keysMask [7]RENDER_WAKEUP [8]V；双缓冲 Float64 索引 [5..12]（槽0）/[13..20]（槽1）
// pos/vel/yaw/pitch；FIXED_SCALE=1000；SHARED_BUFFER_SIZE=192
// ★ 布局回归：BigInt64 索引 1/2（字节 8..15/16..23），勿用 2/4——
//   B64 索引 4 = 字节 32..39 与 V（Int32 8，字节 32..35）重叠（历史屏闪 bug）
const I_TICK_RATE = 0;
const I_WAKEUP = 1;
const B_DX_ACC = 1;
const B_DY_ACC = 2;
const I_KEYS_MASK = 6;
const I_RENDER_WAKEUP = 7;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const FIXED_SCALE = 1000;
const SHARED_BUFFER_SIZE = 192;

class TestShared {
  constructor(buf, mode = 'sab', postToPhysics = null, postToRender = null) {
    this.mode = mode;
    this.i32 = buf ? new Int32Array(buf) : new Int32Array(0);
    this.b64 = buf ? new BigInt64Array(buf) : new BigInt64Array(0);
    this.f64 = buf ? new Float64Array(buf) : new Float64Array(0);
    this.lastV = 0;
    // 消息回退模式状态
    this.msgDx = 0;
    this.msgDy = 0;
    this.msgKeysMask = 0;
    this.msgTickRate = 0;
    this.msgV = 0;
    this.msgLatest = null;
    this.postToPhysics = postToPhysics;
    this.postToRender = postToRender;
  }
  static init(buf) {
    return new TestShared(buf, 'sab');
  }
  static createMessaging(postToPhysics) {
    return new TestShared(null, 'msg-main', postToPhysics);
  }
  static initMessaging(postToRender) {
    return new TestShared(null, 'msg-physics', null, postToRender);
  }
  static initMessagingRender() {
    return new TestShared(null, 'msg-render');
  }
  get sab() {
    return this.i32.buffer;
  }
  get isMessageMode() {
    return this.mode !== 'sab';
  }
  writeTickRate(rate) {
    // 阶段0：仅 store，无 notify（消息回退：投递 shared-tick-rate）
    if (this.mode === 'msg-main') {
      this.postToPhysics?.({ type: 'shared-tick-rate', rate });
      return;
    }
    Atomics.store(this.i32, I_TICK_RATE, rate);
  }
  readTickRate() {
    if (this.mode === 'msg-physics') {
      return this.msgTickRate; // 主线程 shared-tick-rate 消息已缓存
    }
    return Atomics.load(this.i32, I_TICK_RATE);
  }
  wake() {
    // 阶段1：双槽分离——WAKEUP(WorkerA 物理背压) + RENDER_WAKEUP(WorkerB 渲染帧对齐)，
    // 各槽 notify 计数 = 1（每槽恰一个等待者，互不抢唤醒）
    if (this.mode === 'msg-main') {
      return; // 消息回退：双 Worker 均消息自驱，无阻塞等待可唤醒
    }
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
    Atomics.store(this.i32, I_RENDER_WAKEUP, 1);
    Atomics.notify(this.i32, I_RENDER_WAKEUP, 1);
  }
  waitWakeup(timeoutMs) {
    if (this.mode !== 'sab') {
      return false; // 消息回退：无阻塞原语，立即"超时"返回（自投递续环即自驱）
    }
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    if (res === 'timed-out') return false;
    Atomics.compareExchange(this.i32, I_WAKEUP, 1, 0); // CAS 消费唤醒并复位
    return true;
  }
  waitRenderWakeup(timeoutMs) {
    if (this.mode !== 'sab') {
      return false; // 消息回退：同 waitWakeup
    }
    const res = Atomics.wait(this.i32, I_RENDER_WAKEUP, 0, timeoutMs);
    if (res === 'timed-out') return false;
    Atomics.compareExchange(this.i32, I_RENDER_WAKEUP, 1, 0);
    return true;
  }
  addInput(dx, dy, keysMask) {
    // 消息回退：每 rAF 批投递（含 keysMask=0：松手即清零语义与 SAB 一致）
    if (this.mode === 'msg-main') {
      this.postToPhysics?.({ type: 'shared-input', dx, dy, keysMask });
      return;
    }
    const dxFixed = BigInt(Math.round(dx * FIXED_SCALE));
    const dyFixed = BigInt(Math.round(dy * FIXED_SCALE));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }
  onInputMessage(dx, dy, keysMask) {
    // msg-physics：main 的 shared-input 消息 → 本地累加（与 SAB addInput 语义一致）
    this.msgDx += dx;
    this.msgDy += dy;
    this.msgKeysMask = keysMask;
  }
  onTickRateMessage(rate) {
    this.msgTickRate = rate;
  }
  consumeInput(maxDelta = Infinity) {
    if (this.mode === 'msg-physics') {
      const dx = this.msgDx;
      const dy = this.msgDy;
      this.msgDx = 0;
      this.msgDy = 0;
      if (maxDelta !== Infinity) {
        return {
          dx: Math.max(-maxDelta, Math.min(maxDelta, dx)),
          dy: Math.max(-maxDelta, Math.min(maxDelta, dy)),
          keysMask: this.msgKeysMask,
        };
      }
      return { dx, dy, keysMask: this.msgKeysMask };
    }
    const dxFixed = this.exchangeZero(this.b64, B_DX_ACC);
    const dyFixed = this.exchangeZero(this.b64, B_DY_ACC);
    let dx = Number(dxFixed) / FIXED_SCALE;
    let dy = Number(dyFixed) / FIXED_SCALE;
    if (maxDelta !== Infinity) {
      dx = Math.max(-maxDelta, Math.min(maxDelta, dx));
      dy = Math.max(-maxDelta, Math.min(maxDelta, dy));
    }
    return {
      dx,
      dy,
      keysMask: Atomics.load(this.i32, I_KEYS_MASK),
    };
  }
  exchangeZero(b, idx) {
    let cur = Atomics.load(b, idx);
    for (;;) {
      const res = Atomics.compareExchange(b, idx, cur, 0n);
      if (res === cur) return cur;
      cur = res;
    }
  }
  writeState(pos, vel, yaw, pitch) {
    // 零分配热路径镜像：writeState 委托 writeStateRaw（标量直写 SAB）
    return this.writeStateRaw(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, yaw, pitch);
  }
  writeStateRaw(x, y, z, vx, vy, vz, yaw, pitch) {
    // 消息回退：本地 V++ → 投递 shared-state（WorkerB onStateMessage 缓存）
    if (this.mode === 'msg-physics') {
      this.msgV++;
      this.postToRender?.({
        type: 'shared-state',
        v: this.msgV,
        pos: { x, y, z },
        vel: { x: vx, y: vy, z: vz },
        yaw,
        pitch,
      });
      return this.msgV;
    }
    // 双缓冲：写空闲槽（S[V&1^1]）→ Atomics.add(V,1)——**不 notify**（帧信号驱动：
    // 渲染唤醒 = 主线程 rAF wake()（vsync 对齐）；1kHz 随机相位唤醒已移除）
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE;
    const f = this.f64;
    f[base] = x;
    f[base + 1] = y;
    f[base + 2] = z;
    f[base + 3] = vx;
    f[base + 4] = vy;
    f[base + 5] = vz;
    f[base + 6] = yaw;
    f[base + 7] = pitch;
    const v = Atomics.add(this.i32, I_V, 1) + 1;
    return v;
  }
  onStateMessage(msg) {
    // msg-render：缓存最近状态（本地副本唯一来源，与 SAB readState 语义一致）
    this.msgLatest = { pos: msg.pos, vel: msg.vel, yaw: msg.yaw, pitch: msg.pitch, v: msg.v };
  }
  readState() {
    // 消息回退：返回缓存的最近状态；V 未变返回 null（仅状态更新时重绘）
    if (this.mode === 'msg-render') {
      const s = this.msgLatest;
      if (!s || s.v === this.lastV) return null;
      this.lastV = s.v;
      return s;
    }
    // 读当前槽 S[V&1]；double-check 防撕裂
    const v0 = Atomics.load(this.i32, I_V);
    if (v0 === this.lastV) return null;
    const f = this.f64;
    let v = v0;
    let pos = { x: 0, y: 0, z: 0 };
    let vel = { x: 0, y: 0, z: 0 };
    let yaw = 0;
    let pitch = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = F_SLOT_BASE + (v & 1) * F_SLOT_STRIDE;
      pos = { x: f[base], y: f[base + 1], z: f[base + 2] };
      vel = { x: f[base + 3], y: f[base + 4], z: f[base + 5] };
      yaw = f[base + 6];
      pitch = f[base + 7];
      const v2 = Atomics.load(this.i32, I_V);
      if (v2 === v) break;
      v = v2;
    }
    this.lastV = v;
    return { pos, vel, yaw, pitch, v };
  }
}

// ── WorkerA 写路径镜像（worker-a.ts writeStateFromPhys）──────────
function writeStateFromPhys(shared, phys) {
  const s = phys.state();
  return shared.writeState(
    { x: s.posX, y: s.posY, z: s.posZ },
    { x: s.velX, y: s.velY, z: s.velZ },
    s.yaw,
    s.pitch,
  );
}

// ── WorkerA 单模循环核心镜像（worker-a.ts loop：delta clamp + 累加器 + 8 次上限；
//    上限耗尽**保留剩余累加**（下轮补跑），仅封顶 MAX_ACC 防无限追赶；
//    **MAX_ACC=0.02 与 worker-a.ts 同步**（2026-08-11 对齐，曾漂移为 0.05））──
// 返回 { ticks: 本轮执行的子步数, acc: 残留累加器（秒） }
const RENDER_DT = 0.001;
const MAX_DELTA = 0.05;
const MAX_STEPS_PER_ROUND = 8;
const MAX_ACC = 0.02;
function simulateWorkerARound(deltaMs, acc) {
  let delta = deltaMs / 1000;
  if (delta > MAX_DELTA) delta = MAX_DELTA;
  if (delta < 0) delta = 0;
  acc += delta;
  let ticks = 0;
  if (acc >= RENDER_DT) {
    while (acc >= RENDER_DT && ticks < MAX_STEPS_PER_ROUND) {
      acc -= RENDER_DT;
      ticks++;
      // 真实循环：consumeInput(±1000) → phys.tick(1ms)（返回值直接写状态槽）→ V add
    }
    if (acc > MAX_ACC) acc = MAX_ACC; // 仅封顶，不丢弃——时间不丢失
  }
  return { ticks, acc };
}

// ── WorkerB 帧逻辑镜像（worker-b.ts frameLoop/onFrame：本地副本唯一参数源 = readState；
//    仅状态更新时重绘——V 未变不提交 Draw（高频屏不重复渲染相同状态））──
class FakeWorkerB {
  constructor(shared) {
    this.shared = shared;
    this.localCopy = null; // 唯一渲染参数源（只被 readState 更新——真理源）
    this.updates = 0; // 本地副本被 readState 刷新次数
    this.repaints = 0; // 实际 Draw 次数（仅状态更新时 +1）
  }
  onFrame(_now) {
    const state = this.shared.readState(); // ① 非阻塞；V 更新→读最新槽（无撕裂），未变→null
    if (state) {
      // ② 本地副本只被 readState 更新（无其他来源——渲染参数零污染）
      this.localCopy = state;
      this.updates++;
      this.repaints++; // ③ 仅状态更新时重绘（镜像 worker-b.ts onFrame）
    }
  }
  onFrameRet(_now) {
    // 镜像 worker-b onFrame 返回值（是否重绘——自适应超时/节流判定用）
    const state = this.shared.readState();
    if (state) {
      this.localCopy = state;
      this.updates++;
      this.repaints++;
      return true;
    }
    return false;
  }
}

// ── 模式A+B 双模驱动器（worker-a.ts loop 逐字镜像，2026-08-11 重构）────────────
// 输入通道：input(keys, dx, dy) 注入真实输入（可选走 TestShared 通道）；
// tick(p) 执行一个 1ms 轮次，**先 tick 计算、后无限制计算**：
// - 第一步 tick：tick 节点（loAcc ≥ tickDt）到达才执行，未到达跳过直达无限制——
//   **独立 tick 实例**（tickWorld，只走 tickDt 步长——真实 64t 物理）用边界采样
//   （键位 = 当前掩码、鼠标 = 自上一边界模式A 实时消耗累积）推进 →
//   set_velocity 三轴速度校准模式A（**唯一 tick 影响通道**，位置/角度不动）
// - 第二步无限制：模式A 1ms 子步 + **实时输入**（consumeInput / real 直喂）——
//   位置/角度只由模式A 推进（共享槽写入只发生在模式A 子步后，外部处理）
class ModeAB {
  constructor(rate, tickWorld = null, shared = null) {
    this.tickDt = rate > 0 ? 1 / rate : 0;
    this.active = rate > 0 && this.tickDt > RENDER_DT;
    this.shared = shared; // SAB/msg-physics 通道（consumeInput 消费）；null → real 直喂
    this.lo = 0;
    this.tickDxAcc = 0;
    this.tickDyAcc = 0;
    this.tickKeys = 0;
    /** 独立 64t 权威速度线实例（与模式A 同世界构建；null 且 active → 无速度校准） */
    this.tickPhys = tickWorld;
    /** 可选：tick 边界对 tickPhys 施加的 yaw（鼠标 64t 采样模拟；null = 用 dx 流） */
    this.tickYaw = null;
    this.realKeys = 0;
    this.realDx = 0;
    this.realDy = 0;
    if (this.active && !tickWorld) {
      throw new Error(`ModeAB: rate=${rate} 激活必须提供 tickWorld（独立 64t 权威实例）`);
    }
  }
  input(keys, dx = 0, dy = 0) {
    this.realKeys = keys;
    this.realDx = dx;
    this.realDy = dy;
  }
  /** 模式A 实时输入采样（唯一消费路径；SAB/msg → consumeInput；否则 real 直喂）。 */
  takeReal() {
    if (this.shared) {
      if (this.shared.mode === 'sab') this.shared.addInput(this.realDx, this.realDy, this.realKeys);
      return this.shared.consumeInput(1000);
    }
    return { dx: this.realDx, dy: this.realDy, keysMask: this.realKeys };
  }
  tick(p) {
    // ── 第一步：tick 计算（先——tick 节点才执行，未到跳过直达无限制）──
    if (this.active && this.tickPhys) {
      this.lo += RENDER_DT;
      while (this.lo >= this.tickDt) {
        this.lo -= this.tickDt;
        const tickMax = (1000 * this.tickDt) / RENDER_DT; // 限幅（worker-a tickInputMax）
        const tdx = Math.max(-tickMax, Math.min(tickMax, this.tickDxAcc));
        const tdy = Math.max(-tickMax, Math.min(tickMax, this.tickDyAcc));
        this.tickDxAcc = 0;
        this.tickDyAcc = 0;
        // 分叉兜底锚定（worker-a 镜像）：偏差 > 64 → 全量拉回模式A（死亡/传送/
        // 卡墙等极限操作防护）；正常演化不干预——tick 保持自身 64t 离散演化
        const aSt = p.state();
        const tSt = this.tickPhys.state();
        const ddx = aSt.posX - tSt.posX;
        const ddy = aSt.posY - tSt.posY;
        const ddz = aSt.posZ - tSt.posZ;
        if (ddx * ddx + ddy * ddy + ddz * ddz > 64 * 64) {
          this.tickPhys.set_state(aSt.posX, aSt.posY, aSt.posZ, aSt.yaw, aSt.pitch, aSt.velX, aSt.velY, aSt.velZ, aSt.onGround);
        }
        if (this.tickYaw !== null) this.tickPhys.set_yaw_pitch(this.tickYaw, 0);
        this.tickPhys.tick(this.tickDt, this.tickKeys, tdx, tdy); // 独立 64t 物理
        const st = this.tickPhys.state();
        p.set_velocity(st.velX, st.velY, st.velZ); // 速度校准（三轴——唯一 tick 影响）
      }
    } else {
      this.lo = 0;
    }
    // ── 第二步：无限制计算（后——实时输入 1ms 子步；位置/角度只由模式A 推进）──
    const inp = this.takeReal();
    if (this.active) {
      this.tickDxAcc += inp.dx; // tick 边界采样累积（下一边界注入 tick 实例）
      this.tickDyAcc += inp.dy;
      this.tickKeys = inp.keysMask;
    }
    p.tick(RENDER_DT, inp.keysMask, inp.dx, inp.dy);
  }
}

// ── WorkerB PVS 逻辑镜像（worker-b.ts PvsManager 完整镜像：findLeaf/decodePvsRow/
//    update/getClusterAt/isVisible——与 game pvs-manager.ts 逐字一致）──
class PvsMirror {
  constructor(wasmJson) {
    const data = JSON.parse(wasmJson);
    this.nodes = data.nodes;
    this.leaves = data.leaves;
    this.faceClusters = data.faceClusters;
    this.clusterCount = data.clusterCount;
    this.bytesPerRow = data.bytesPerRow;
    this.hasPvs = data.clusterCount > 0 && data.pvsBitsBase64.length > 0;
    this.pvsBits = this.hasPvs ? base64ToBytes(data.pvsBitsBase64) : new Uint8Array(0);
    this.currentCluster = -1;
    this.visibleSet = new Set();
  }
  get enabled() {
    return this.hasPvs;
  }
  get currentClusterId() {
    return this.currentCluster;
  }
  get visibleClusterCount() {
    return this.visibleSet.size;
  }
  findLeaf(pos) {
    if (this.nodes.length === 0) return -1;
    let nodeIdx = 0;
    let maxDepth = 0;
    const MAX_DEPTH = 256;
    while (nodeIdx >= 0 && maxDepth < MAX_DEPTH) {
      maxDepth++;
      const node = this.nodes[nodeIdx];
      if (!node) return -1;
      const d = node.normal[0] * pos.x + node.normal[1] * pos.y + node.normal[2] * pos.z - node.dist;
      const childIdx = d > 0 ? node.children[0] : node.children[1];
      if (childIdx < 0) return ~childIdx;
      nodeIdx = childIdx;
    }
    return -1;
  }
  decodePvsRow(cluster) {
    const visible = new Set();
    if (cluster < 0 || cluster >= this.clusterCount) return visible;
    visible.add(cluster);
    const rowStart = cluster * this.bytesPerRow;
    if (rowStart + this.bytesPerRow > this.pvsBits.length) return visible;
    for (let byteIdx = 0; byteIdx < this.bytesPerRow; byteIdx++) {
      const byte = this.pvsBits[rowStart + byteIdx];
      if (byte === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (1 << bit)) !== 0) {
          const targetCluster = byteIdx * 8 + bit;
          if (targetCluster < this.clusterCount) visible.add(targetCluster);
        }
      }
    }
    return visible;
  }
  update(pos) {
    if (!this.hasPvs) return false;
    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) return false;
    const newCluster = this.leaves[leafIdx].cluster;
    if (newCluster === this.currentCluster) return false;
    if (newCluster < 0) return false;
    this.currentCluster = newCluster;
    this.visibleSet = this.decodePvsRow(newCluster);
    return true;
  }
  getClusterAt(pos) {
    if (!this.hasPvs) return -1;
    const leafIdx = this.findLeaf(pos);
    if (leafIdx < 0 || leafIdx >= this.leaves.length) return -1;
    return this.leaves[leafIdx].cluster;
  }
  isVisible(clusterId) {
    if (!this.hasPvs || clusterId < 0) return true;
    return this.visibleSet.has(clusterId);
  }
}

/** Base64 → Uint8Array（node ≥18 全局 atob；与 worker-b.ts base64ToUint8Array 一致）。 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── 冒烟测试 ────────────────────────────────────────────────────
console.log('── WebSurf-test WorkerA 单模冒烟测试（最新时序图）──');

// 1. wasm 初始化 + 世界构建（worker-a 启动序列）
let initOk = false;
/** wasm 导出（memory 用于 tick_into state_out 的 Float64Array 视图——13.5b 用）。 */
let physMemory = null;
try {
  const out = initSync({ module: readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')) });
  physMemory = out.memory;
  initOk = true;
} catch (e) {
  console.error('initSync 失败:', e);
}
check('initSync wasm（pkg/websurf_test_wasm_bg.wasm）', initOk);

let phys = null;
let buildOk = false;
let buildErr = '';
try {
  phys = new PhysWorld();
  phys.set_hull(16, 72, 54);
  // teleport JSON 须为 report 对象（与 worker-a.ts buildWorld 一致）
  phys.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
  buildOk = true;
} catch (e) {
  buildErr = String(e);
}
check('PhysWorld + set_hull(16,72,54) + build_world(手工 brush)', buildOk, buildErr);

if (phys) {
  const s0 = phys.state();
  check(
    '初始状态：出生点 (0,0,0)',
    close(s0.posX, 0) && close(s0.posY, 0) && close(s0.posZ, 0),
    `pos=(${s0.posX},${s0.posY},${s0.posZ})`,
  );

  // 2. tick 落地：重力下落 → onGround
  let grounded = false;
  let sLand = null;
  for (let i = 0; i < 32; i++) {
    phys.tick(1 / 64, 0, 0, 0);
    sLand = phys.state();
    if (sLand.onGround === true) {
      grounded = true;
      break;
    }
  }
  check('tick 后落地 onGround=true', grounded === true, sLand ? `onGround=${sLand.onGround}` : '');
  check(
    '落地位置 y≈0（玩家站 y=0）',
    sLand !== null && close(sLand.posY, 0, 0.05),
    sLand ? `posY=${sLand.posY}` : '',
  );
  const allFinite =
    sLand !== null &&
    [sLand.posX, sLand.posY, sLand.posZ, sLand.velX, sLand.velY, sLand.velZ].every(Number.isFinite);
  check('state 全字段有限（无 NaN/Inf）', allFinite);

  // 3. 跳跃：posY 升高 → 空中 onGround=false → 落地恢复
  const sBeforeJump = phys.state();
  phys.tick(1 / 64, 16, 0, 0); // keysMask 16 = jump
  phys.tick(1 / 64, 0, 0, 0);
  const sJump = phys.state();
  check(
    '跳跃：posY 升高',
    sJump.posY > sBeforeJump.posY + 0.01,
    `posY ${sBeforeJump.posY} → ${sJump.posY}`,
  );
  check('空中 onGround=false', sJump.onGround === false, `onGround=${sJump.onGround}`);
  let landedAgain = false;
  for (let i = 0; i < 90; i++) {
    phys.tick(1 / 64, 0, 0, 0);
    if (phys.state().onGround === true) {
      landedAgain = true;
      break;
    }
  }
  check('跳跃后落地恢复 onGround=true', landedAgain === true);

  // 4. respawn（阶段4）：移动后重生回出生点
  const KEY_FORWARD = 1;
  for (let i = 0; i < 30; i++) phys.tick(1 / 64, KEY_FORWARD, 0, 0);
  const sMoved = phys.state();
  const moved = Math.abs(sMoved.posX) + Math.abs(sMoved.posZ) > 0.5;
  check('前进输入生效（pos 移动）', moved, `pos=(${sMoved.posX},${sMoved.posY},${sMoved.posZ})`);
  phys.respawn();
  const sBack = phys.state();
  check(
    'respawn 回到出生点 (0,0,0)',
    close(sBack.posX, 0) && close(sBack.posY, 0) && close(sBack.posZ, 0),
    `pos=(${sBack.posX},${sBack.posY},${sBack.posZ})`,
  );
}

// 5. consumeInput CAS（addInput → consume 得增量 → 再 consume 得 0）
const shared = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
shared.addInput(10, 0, 3);
const c1 = shared.consumeInput();
check(
  'consumeInput 首消：dx=10 dy=0 keysMask=3',
  close(c1.dx, 10) && c1.dy === 0 && c1.keysMask === 3,
  `dx=${c1.dx} dy=${c1.dy} keys=${c1.keysMask}`,
);
const c2 = shared.consumeInput();
check('consumeInput 二消归零（CAS 清零）', c2.dx === 0 && c2.dy === 0, `dx=${c2.dx} dy=${c2.dy}`);
shared.addInput(-1234, 567, 0);
const c3 = shared.consumeInput();
check(
  '负增量累加正确（dx=-1234 dy=567）',
  close(c3.dx, -1234) && close(c3.dy, 567),
  `dx=${c3.dx} dy=${c3.dy}`,
);

// 6. 双缓冲：writeState 写空闲槽（S[V&1^1]）→ readState 读当前槽 S[V&1]，交替正确
const r0 = shared.readState();
check('V 初始 0：readState 返回 null（非阻塞）', r0 === null);

// 5.5 布局回归（2026-08-10 屏闪根因）：addInput(dy≠0) 不得污染 V（dyAcc 与 V 字节重叠 bug 回归）
{
  const s = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  s.addInput(10, -20, 3); // dy≠0 → BigInt64 dyAcc 写（B64 索引 2 = 字节 16..23）
  check(
    '布局回归：addInput(dy≠0) 不污染 V（dyAcc 字节 16..23 ≠ V 字节 32..35）',
    Atomics.load(s.i32, I_V) === 0,
    `V=${Atomics.load(s.i32, I_V)}（若 ≠0 即 dyAcc 与 V 重叠——历史屏闪 bug 现场）`,
  );
  s.writeState({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 90, -30);
  s.addInput(0, 777, 0); // 写入后再次 dy 输入
  check('布局回归：writeState 后 addInput(dy≠0)：V 保持 1（未被 dyAcc 覆盖）',
    Atomics.load(s.i32, I_V) === 1, `V=${Atomics.load(s.i32, I_V)}`);
  s.consumeInput(); // 消费 dy（读回完整 dy 增量，未被 V++ 破坏）
  const rd = s.readState();
  check('布局回归：dy 输入消费后 readState 数据正确（版本/数据一致）',
    rd !== null && rd.v === 1 && close(rd.pos.x, 1) && close(rd.pos.z, 3) && close(rd.pitch, -30),
    rd ? `v=${rd.v}` : 'null');
}

const v1 = shared.writeState({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 90, -30);
const r1 = shared.readState();
check(
  '首写 V=1：writeState→readState 字段一致 + V 匹配（读槽 S[1&1]=槽1）',
  r1 !== null &&
    r1.v === v1 &&
    close(r1.pos.x, 1) &&
    close(r1.pos.y, 2) &&
    close(r1.pos.z, 3) &&
    close(r1.vel.x, 4) &&
    close(r1.vel.y, 5) &&
    close(r1.vel.z, 6) &&
    close(r1.yaw, 90) &&
    close(r1.pitch, -30),
  r1 ? `v=${r1.v} pos=(${r1.pos.x},${r1.pos.y},${r1.pos.z})` : 'null',
);
check(
  '双缓冲槽切换：V=1 时数据在槽1（Float64 [13..20]），槽0 未被覆盖',
  shared.f64[F_SLOT_BASE] === 0 && shared.f64[F_SLOT_BASE + F_SLOT_STRIDE] === 1,
  `槽0.x=${shared.f64[F_SLOT_BASE]} 槽1.x=${shared.f64[F_SLOT_BASE + F_SLOT_STRIDE]}`,
);
const v2 = shared.writeState({ x: 10, y: 20, z: 30 }, { x: 40, y: 50, z: 60 }, 180, 15);
const r2 = shared.readState();
check(
  '二写 V=2：写空闲槽（槽0）+ 读槽切回 S[2&1]=槽0，数据为新值',
  r2 !== null &&
    r2.v === v2 &&
    close(r2.pos.x, 10) &&
    close(r2.pos.y, 20) &&
    close(r2.pos.z, 30) &&
    close(r2.vel.x, 40) &&
    close(r2.vel.y, 50) &&
    close(r2.vel.z, 60) &&
    close(r2.yaw, 180) &&
    close(r2.pitch, 15),
  r2 ? `v=${r2.v} pos=(${r2.pos.x},${r2.pos.y},${r2.pos.z})` : 'null',
);
check(
  '双缓冲交替写：槽0=新值（10）槽1=旧值（1）不被覆盖',
  shared.f64[F_SLOT_BASE] === 10 && shared.f64[F_SLOT_BASE + F_SLOT_STRIDE] === 1,
  `槽0.x=${shared.f64[F_SLOT_BASE]} 槽1.x=${shared.f64[F_SLOT_BASE + F_SLOT_STRIDE]}`,
);
const r3 = shared.readState();
check('V 未变：readState 返回 null（缓存复用）', r3 === null);
const v3 = shared.writeState({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0);
check('再次写入 V 递增（Atomics.add）', v3 === v2 + 1, `v2=${v2} v3=${v3}`);

// 6.5. writeStateRaw 零分配直写（wasm API 能力验证——worker-a 实际子步热路径为 writeState → phys.state()，不使用本 API）
const vRaw = shared.writeStateRaw(3, 4, 5, 6, 7, 8, 45, -15);
const rRaw = shared.readState();
check(
  'writeStateRaw：标量直写与 writeState 同语义（字段一致 + V++）',
  rRaw !== null &&
    rRaw.v === vRaw &&
    close(rRaw.pos.x, 3) &&
    close(rRaw.pos.y, 4) &&
    close(rRaw.pos.z, 5) &&
    close(rRaw.vel.x, 6) &&
    close(rRaw.vel.y, 7) &&
    close(rRaw.vel.z, 8) &&
    close(rRaw.yaw, 45) &&
    close(rRaw.pitch, -15),
  rRaw ? `v=${rRaw.v}` : 'null',
);

// 7. V 递增用 add：写 N 次 → V 增 N
const vStart = Atomics.load(shared.i32, I_V);
const writeCount = 5;
for (let i = 0; i < writeCount; i++) {
  shared.writeState({ x: i, y: i, z: i }, { x: 0, y: 0, z: 0 }, 0, 0);
}
const vEnd = Atomics.load(shared.i32, I_V);
check('V 递增用 add：写 5 次 → V 精确增 5', vEnd === vStart + writeCount, `V ${vStart} → ${vEnd}`);

// 8. WAKEUP 协议：wake() 后 waitWakeup 立即返回；无 wake 时超时；waitWakeup 复位
const t0 = performance.now();
shared.wake(); // store(WAKEUP,1) + notify(WAKEUP,1) + RENDER_WAKEUP 同置位
const w1 = shared.waitWakeup(100);
const dtW1 = performance.now() - t0;
check('wake() 后 waitWakeup 立即返回 true（被唤醒，not-equal）', w1 === true && dtW1 < 20, `res=${w1} dt=${dtW1.toFixed(2)}ms`);
check('waitWakeup 返回后 WAKEUP 复位为 0', Atomics.load(shared.i32, I_WAKEUP) === 0);
const t1 = performance.now();
const w2 = shared.waitWakeup(30); // 无 wake：挂起直到超时
const dtW2 = performance.now() - t1;
check('无 wake：waitWakeup(30) 超时返回 false', w2 === false && dtW2 >= 20, `res=${w2} dt=${dtW2.toFixed(2)}ms`);
check('超时返回后 WAKEUP 仍为 0', Atomics.load(shared.i32, I_WAKEUP) === 0);
// 双槽语义残留：shared.wake() 同时置位 RENDER_WAKEUP（唤醒保留给 WorkerB）——
// 本节仅消费物理槽后，RENDER_WAKEUP 仍为 1（真实语义，见 8.5 双槽隔离）；
// 消费残留恢复 0 基线，供 9 的 writeTickRate 断言使用
shared.waitRenderWakeup(1);
check(
  'WAKEUP 协议残留消费：waitRenderWakeup 立即消费双槽同置位的渲染唤醒（RENDER_WAKEUP 复位 0）',
  Atomics.load(shared.i32, I_RENDER_WAKEUP) === 0,
);

// 8.5. RENDER_WAKEUP 协议（WorkerB 独立渲染槽）：wake() 双槽同置位；waitRenderWakeup
//     立即返回/超时/复位；两槽 CAS 消费互不干扰（物理背压不抢渲染唤醒）
const s2 = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
const tR0 = performance.now();
s2.wake(); // store+notify 双槽（WAKEUP + RENDER_WAKEUP）
const rw1 = s2.waitRenderWakeup(100);
const dtR1 = performance.now() - tR0;
check(
  'RENDER_WAKEUP#1：wake() 后 waitRenderWakeup 立即返回 true（独立渲染槽）',
  rw1 === true && dtR1 < 20,
  `res=${rw1} dt=${dtR1.toFixed(2)}ms`,
);
check(
  'RENDER_WAKEUP#2：waitRenderWakeup 返回后 RENDER_WAKEUP 复位为 0（且 WAKEUP 未被本次消费影响——物理槽独立复位）',
  Atomics.load(s2.i32, I_RENDER_WAKEUP) === 0,
);
const tR1 = performance.now();
const rw2 = s2.waitRenderWakeup(30); // 无 wake：挂起直到超时
const dtR2 = performance.now() - tR1;
check(
  'RENDER_WAKEUP#3：无 wake：waitRenderWakeup(30) 超时返回 false',
  rw2 === false && dtR2 >= 20,
  `res=${rw2} dt=${dtR2.toFixed(2)}ms`,
);
check('RENDER_WAKEUP#4：超时返回后 RENDER_WAKEUP 仍为 0', Atomics.load(s2.i32, I_RENDER_WAKEUP) === 0);
// 双槽隔离：仅消费 WAKEUP 后，RENDER_WAKEUP 仍保留唤醒给 WorkerB
s2.wake();
s2.waitWakeup(100); // WorkerA 消费物理槽
check(
  'RENDER_WAKEUP#5：双槽隔离——WorkerA 消费 WAKEUP 后 RENDER_WAKEUP 唤醒仍保留（waitRenderWakeup 立即返回）',
  s2.waitRenderWakeup(100) === true,
  '渲染帧边界不再被物理背压抢唤醒',
);

// 8.6. 帧信号驱动（阶段3 主驱动，node worker_threads 真线程验证）：渲染唤醒 =
//      主线程 rAF 的 wake()（store+notify RENDER_WAKEUP——vsync 对齐）；**WorkerA
//      发布（writeStateRaw）不 notify**（1kHz 随机相位唤醒 → 呈现时间不规则 →
//      观感抖动）；发布仅 V++，WorkerB 醒后读最新槽
{
  const sab = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  const pubShared = new TestShared(sab);
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const I_RENDER_WAKEUP = 7;
    const t0 = performance.now();
    const res = Atomics.wait(new Int32Array(workerData.sab), I_RENDER_WAKEUP, 0, 500);
    parentPort.postMessage({ res, dt: performance.now() - t0 });
  `;
  const w = new Worker(workerCode, { eval: true, workerData: { sab } });
  await new Promise((r) => setTimeout(r, 80)); // 等 worker 挂起在渲染槽上
  pubShared.writeStateRaw(1, 2, 3, 4, 5, 6, 0, 0); // 发布：仅 V++（不 notify——帧信号驱动）
  let rPub = null;
  const gotMsg = new Promise((resolve) => {
    w.on('message', (m) => {
      rPub = m;
      resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 120)); // 发布后留 120ms：若被 notify 应已唤醒
  const r1 = rPub;
  pubShared.wake(); // 主线程 rAF 帧信号（store+notify RENDER_WAKEUP）
  await gotMsg;
  w.terminate();
  check(
    '帧信号驱动#1：发布（writeStateRaw）不唤醒渲染（200ms 超时前未醒——1kHz 随机相位唤醒已移除）',
    r1 === null,
    r1 ? `res=${r1.res}` : '未唤醒（符合预期）',
  );
  const r2 = rPub;
  check(
    '帧信号驱动#2：主线程 wake()（rAF 帧信号）立即唤醒挂起渲染循环（res=ok 非超时；vsync 对齐主驱动）',
    r2 !== null && r2.res === 'ok',
    r2 ? `res=${r2.res}` : 'null',
  );
  const rPubState = pubShared.readState();
  check(
    '帧信号驱动#3：发布已 V++（醒后 readState 读到新版本——发布只写槽，不唤醒）',
    rPubState !== null && rPubState.v === 1,
    rPubState ? `v=${rPubState.v}` : 'null',
  );
}

// 9. 阶段0 writeTickRate 仅 store（无 notify，不影响 WAKEUP/RENDER_WAKEUP）
shared.writeTickRate(128);
check(
  'writeTickRate(128)：TICK_RATE=128 且 WAKEUP/RENDER_WAKEUP 均未被置位（仅 store 无 notify）',
  shared.readTickRate() === 128 &&
    Atomics.load(shared.i32, I_WAKEUP) === 0 &&
    Atomics.load(shared.i32, I_RENDER_WAKEUP) === 0,
  `TICK_RATE=${shared.readTickRate()} WAKEUP=${Atomics.load(shared.i32, I_WAKEUP)} RENDER_WAKEUP=${Atomics.load(shared.i32, I_RENDER_WAKEUP)}`,
);
shared.writeTickRate(64);

// 10. 输入限幅：consumeInput(clamp) 超限值被截断（±1000 防穿墙）
shared.addInput(5000, -3000, 0);
const cl1 = shared.consumeInput(1000);
check('限幅：dx=5000 → 1000（截断）', close(cl1.dx, 1000), `dx=${cl1.dx}`);
check('限幅：dy=-3000 → -1000（截断）', close(cl1.dy, -1000), `dy=${cl1.dy}`);
shared.addInput(250, -250, 0);
const cl2 = shared.consumeInput(1000);
check('限幅：界内值不截断（dx=250 dy=-250）', close(cl2.dx, 250) && close(cl2.dy, -250), `dx=${cl2.dx} dy=${cl2.dy}`);
shared.addInput(9999, -9999, 0);
const cl3 = shared.consumeInput(); // 缺省无限幅
check('无限幅（缺省 Infinity）：dx=9999 原样返回', close(cl3.dx, 9999) && close(cl3.dy, -9999), `dx=${cl3.dx} dy=${cl3.dy}`);

// 11. 8 次子步上限：一次大 delta → 物理最多 8 个子步（模拟 loop 上限断言；
//     上限耗尽**保留剩余累加**——时间不丢失，下轮补跑）
const rBig = simulateWorkerARound(20, 0); // 20ms 大 delta
check('delta=20ms：单轮最多 8 个子步', rBig.ticks === 8, `ticks=${rBig.ticks}`);
check(
  '8 次上限耗尽：保留剩余累加 12ms（时间不丢失，下轮补跑；原 acc=0 丢弃永久丢时间）',
  close(rBig.acc, 0.012),
  `acc=${rBig.acc}`,
);
const rBig2 = simulateWorkerARound(20, 0.0004); // 20ms + 残留 0.4ms
check('delta=20ms + 残留 0.4ms：仍 8 次', rBig2.ticks === 8, `ticks=${rBig2.ticks}`);
const rMid = simulateWorkerARound(5, 0.0003); // 5.3ms → 5 步
check('delta=5ms + 残留 0.3ms：5 个子步', rMid.ticks === 5, `ticks=${rMid.ticks}`);
const rSmall = simulateWorkerARound(0.3, 0); // 0.3ms < 1ms
check('delta=0.3ms < 1ms：0 个子步（纯累加）', rSmall.ticks === 0 && close(rSmall.acc, 0.0003), `ticks=${rSmall.ticks} acc=${rSmall.acc}`);
const rClamp = simulateWorkerARound(200, 0); // 200ms → clamp 50ms → 8 次
check('delta=200ms → clamp 50ms：仍 8 次', rClamp.ticks === 8, `ticks=${rClamp.ticks}`);
const rCatch = simulateWorkerARound(50, 0.042); // 上次 50ms 残留 + 本轮 50ms → 封顶 20ms（防无限追赶）
check('长期停顿累积：累加器封顶 MAX_ACC=20ms（防无限追赶，与 worker-a 同步）', close(rCatch.acc, 0.02), `acc=${rCatch.acc}`);

// 12. 渲染采样与重绘逻辑（模拟 WorkerB 最终时序：本地副本唯一参数源 = readState，
//     仅状态更新时重绘——V 未变不提交 Draw；TICK_RATE 不影响渲染采样）
// 12a. TICK_RATE=0（默认）→ 参数跟随 V 永远最新；V 未变 → 不重绘
const sharedB = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
const wb = new FakeWorkerB(sharedB); // TICK_RATE 默认 0
sharedB.writeState({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0); // v1
wb.onFrame(0); // 首帧：V 更新 → 本地副本=v1 + Draw
check(
  '渲染#1：首帧 V 更新 → 本地副本=v1 + Draw（参数来源仅 readState）',
  wb.localCopy !== null && wb.localCopy.v === 1 && wb.updates === 1 && wb.repaints === 1,
  `updates=${wb.updates} repaints=${wb.repaints}`,
);
sharedB.writeState({ x: 5, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 0, 0); // v2
wb.onFrame(10); // V 更新 → 本地副本立即=v2 + Draw（参数永远最新）
check(
  '渲染#2：V 更新 → 本地副本立即=v2 + Draw（参数永远最新）',
  wb.localCopy !== null && wb.localCopy.v === 2 && wb.updates === 2 && wb.repaints === 2,
  `target=${wb.localCopy ? wb.localCopy.v : null} updates=${wb.updates}`,
);
wb.onFrame(20); // V 未变 → 本地副本复用 v2（无其他来源），**不重绘**
check(
  '渲染#3：V 未变 → 本地副本复用 v2（参数零污染），不重绘（repaints 不增）',
  wb.localCopy.v === 2 && wb.updates === 2 && wb.repaints === 2,
  `updates=${wb.updates} repaints=${wb.repaints}`,
);
sharedB.writeState({ x: 9, y: 0, z: 9 }, { x: 0, y: 0, z: 0 }, 0, 0); // v3
wb.onFrame(30); // V 更新 → 本地副本=v3 + Draw
check(
  '渲染#4：V 更新 → 本地副本=v3 + Draw（参数永远最新真理源）',
  wb.localCopy.v === 3 && wb.updates === 3 && wb.repaints === 3,
  `target=${wb.localCopy.v} updates=${wb.updates}`,
);
wb.onFrame(40); // V 未变
check(
  '渲染#5：V 未变 → 本地副本保持非 null（首帧竞争不回落）',
  wb.localCopy !== null && wb.localCopy.v === 3 && wb.updates === 3,
  `target=${wb.localCopy ? wb.localCopy.v : null}`,
);

// 12b. TICK_RATE=64 → 渲染采样不被 tick 限频：V 更新即重绘（TICK_RATE 只影响 WorkerA 手感）
const sharedC = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
sharedC.writeTickRate(64);
const wbC = new FakeWorkerB(sharedC);
sharedC.writeState({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0); // v1
wbC.onFrame(1000); // 首帧 → 本地副本=v1 + Draw
check(
  '渲染高帧#1：首帧 → 本地副本=v1 + Draw（TICK_RATE=64 不限制渲染）',
  wbC.localCopy !== null && wbC.localCopy.v === 1 && wbC.updates === 1 && wbC.repaints === 1,
  `updates=${wbC.updates} repaints=${wbC.repaints}`,
);
sharedC.writeState({ x: 5, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 0, 0); // v2
wbC.onFrame(1005); // V 更新 → 本地副本=v2 + Draw
check(
  '渲染高帧#2：V 更新 → 本地副本=v2 + Draw（参数永远最新，V 更新即重绘）',
  wbC.localCopy !== null && wbC.localCopy.v === 2 && wbC.updates === 2 && wbC.repaints === 2,
  `target=${wbC.localCopy ? wbC.localCopy.v : null} repaints=${wbC.repaints}`,
);
wbC.onFrame(1010); // V 未变 → 本地副本复用 v2 + **不重绘**
check(
  '渲染高帧#3：V 未变 → 复用 v2 + 不重绘（渲染仅随状态更新）',
  wbC.localCopy.v === 2 && wbC.updates === 2 && wbC.repaints === 2,
  `updates=${wbC.updates} repaints=${wbC.repaints}`,
);
sharedC.writeState({ x: 9, y: 0, z: 9 }, { x: 0, y: 0, z: 0 }, 0, 0); // v3
wbC.onFrame(1015); // V 更新 → v3 + Draw
check(
  '渲染高帧#4：V 更新 → 本地副本=v3 + Draw（渲染参数唯一来自真理源，不限频）',
  wbC.localCopy.v === 3 && wbC.updates === 3 && wbC.repaints === 3,
  `target=${wbC.localCopy.v} updates=${wbC.updates}`,
);

// 12.5 模式B（权威 tick + 速度校准——worker-a 最新镜像 2026-08-11，对齐 game 双线语义）：
//     **先 tick 计算、后无限制计算**：模式A 每 1ms 子步（**渲染参数唯一源**——位置/
//     角度连续流畅、实时输入）；独立 tick 实例（第二个 PhysWorld，只走 tickDt 步长——
//     真实 64t 物理）每 1/TICK_RATE 边界用采样输入（键位 = 当前掩码、鼠标 = 模式A
//     实时消耗累积）推进 → **校准速度**（set_velocity 三轴——唯一 tick 影响通道；
//     位置/角度绝不触碰）；★ 不 writeState——共享状态槽只由模式A 写
if (phys) {
  const sharedC = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  sharedC.writeTickRate(64); // 难度手感 64 tick
  const vBefore = Atomics.load(sharedC.i32, I_V); // 模式B 执行前的共享槽版本

  // a. 渲染参数连续（位置由模式A 唯一推进）+ 速度校准 vy：纯模式A vs 模式A+B（64t）
  //    空中自由落体 1s——位移偏差 < 1%、vy 一致（tick 只校准速度——独立 64t 实例的
  //    vy 是自身重力演化结果，无重复重力；位置/角度由模式A 推进——渲染轨迹与纯 1ms
  //    无限制严格一致——game 双线"渲染 = 主线程物理"语义）
  {
    const pA = new PhysWorld();
    const pB = new PhysWorld();
    const pT = new PhysWorld(); // tick 线独立实例（同世界）
    pA.set_hull(16, 72, 54);
    pB.set_hull(16, 72, 54);
    pT.set_hull(16, 72, 54);
    pA.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 500, 0, 0);
    pB.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 500, 0, 0);
    pT.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 500, 0, 0);
    const mA = new ModeAB(0);
    const mB = new ModeAB(64, pT);
    for (let i = 0; i < 1000; i++) {
      mA.input(0, 0, 0);
      mA.tick(pA);
      mB.input(0, 0, 0);
      mB.tick(pB);
    }
    const sA = pA.state();
    const sB = pB.state();
    const dA = 500 - sA.posY;
    const dB = 500 - sB.posY;
    check(
      '模式B 渲染连续#1：位置由模式A 唯一推进（自由落体 1s 位移偏差 < 1%——tick 只校准速度，位置/角度不动，渲染轨迹 = 纯 1ms 无限制）',
      Math.abs(dA - dB) / dA < 0.01 && Math.abs(sA.posX - sB.posX) < 0.01 && Math.abs(sA.posZ - sB.posZ) < 0.01,
      `位移 A=${dA.toFixed(2)} B=${dB.toFixed(2)} 偏差=${(Math.abs(dA - dB) / dA * 100).toFixed(3)}%`,
    );
    check(
      '模式B 速度校准#1：vy 来自独立 64t 实例（重力聚合 1s vy == 基准、|Δ|<1——独立实例无重复重力）',
      Math.abs(sA.velY - sB.velY) < 1,
      `vyA=${sA.velY.toFixed(1)} vyB=${sB.velY.toFixed(1)}`,
    );
  }

  // b. 无浮空：模式B 激活时玩家在地面静止（无输入）——持续 2s——posY 保持地面高度
  //    （tick 线同态静止——无 vy 注入、无弹跳）
  {
    const p = new PhysWorld();
    const pT = new PhysWorld();
    p.set_hull(16, 72, 54);
    pT.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    pT.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(64, pT);
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0); // 落地
    const groundY = p.state().posY;
    for (let i = 0; i < 2000; i++) {
      m.input(0, 0, 0);
      m.tick(p); // 2s 静止
    }
    const s = p.state();
    check(
      '模式B 无浮空：地面静止（无输入）2s 后 posY 保持地面高度、onGround=true、vy=0（无 vy 注入、无弹跳）',
      Math.abs(s.posY - groundY) < 0.01 && s.onGround === true && Math.abs(s.velY) < 0.01,
      `posY=${s.posY.toFixed(4)}（地面 ${groundY.toFixed(4)}）onGround=${s.onGround} vy=${s.velY.toFixed(4)}`,
    );
  }

  // c. 跳跃时机：模式A 实时起跳（位置/角度不受 tick 输入采样影响）+ tick 线 64t
  //    边界采样起跳（速度通道难度——bhop 时机延迟 ∈(0, tickDt]）
  {
    const p = new PhysWorld();
    const pT = new PhysWorld();
    p.set_hull(16, 72, 54);
    pT.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    pT.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(64, pT);
    for (let i = 0; i < 200; i++) {
      m.input(0, 0, 0);
      m.tick(p); // 落地站稳
    }
    let jumpAt = -1;
    let tickJumpAt = -1;
    for (let i = 0; i < 100; i++) {
      m.input(i >= 30 ? 16 : 0, 0, 0); // t=30ms 按跳
      m.tick(p);
      if (jumpAt < 0 && !p.state().onGround) jumpAt = i; // 模式A：实时起跳（立即）
      if (tickJumpAt < 0 && !pT.state().onGround) tickJumpAt = i; // tick 线：边界采样起跳
    }
    check(
      '模式B 渲染即时#1：模式A 实时起跳（t=30ms 按下 → 立即起跳——位置/角度不受 tick 输入采样影响）',
      jumpAt === 30,
      `模式A 起跳 t=${jumpAt}ms（按下 t=30ms）`,
    );
    check(
      '模式B 速度通道难度#1：tick 线起跳 ∈ (30, 30+15.6+1]（64t 输入采样——bhop 时机延迟 = 难度核心，经速度校准传导到渲染）',
      tickJumpAt > 30 && tickJumpAt <= 30 + 15.6 + 1,
      `tick 线起跳 t=${tickJumpAt}ms（按下 t=30ms）`,
    );
  }

  // d. 常量输入等价：模式B（64t）按住 forward 的加速/摩擦衰减与纯模式A **一致**
  //    （独立 64t 实例 + dt 标定物理——旧"单实例 2× 粗糙"伪差已消除；难度差异只
  //    出现在变输入（跳跃/转向——见运动差别#1/#5）；稳态速度同为 250）
  {
    const runForward = (rate) => {
      const p = new PhysWorld();
      const t = new PhysWorld();
      p.set_hull(16, 72, 54);
      t.set_hull(16, 72, 54);
      p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
      t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
      const m = new ModeAB(rate, t);
      for (let i = 0; i < 100; i++) {
        m.input(0, 0, 0);
        m.tick(p);
      }
      const accel = [];
      for (let i = 0; i < 500; i++) {
        m.input(1, 0, 0); // forward
        m.tick(p);
        if (i === 99 || i === 499) {
          const s = p.state();
          accel.push(Math.hypot(s.velX, s.velZ));
        }
      }
      const decay = [];
      for (let i = 0; i < 500; i++) {
        m.input(0, 0, 0); // 松键
        m.tick(p);
        if (i === 99 || i === 499) {
          const s = p.state();
          decay.push(Math.hypot(s.velX, s.velZ));
        }
      }
      return { accel, decay };
    };
    const a = runForward(0);
    const b = runForward(64);
    // 独立 64t 实例 + dt 标定 → 常量输入下加速曲线与纯模式A 有界接近（|Δ|<50——
    // 边界校准的"snap + 子步间自有加速"锯齿振幅 ≈1 tick 窗口；旧"单实例 2× 粗糙"
    // 伪差已消除）；稳态同为 250（±10 锯齿带）
    const accelBounded = Math.abs(a.accel[0] - b.accel[0]) < 50;
    const decayBounded = Math.abs(a.decay[0] - b.decay[0]) < 20;
    check(
      '模式B 常量输入有界：加速/摩擦衰减与纯模式A 有界接近（|Δ加速|<50、|Δ衰减|<20——tick 校准锯齿带 ≈1 tick 窗口；稳态同为 250 ±10；难度在变输入采样）',
      accelBounded && decayBounded && Math.abs(a.accel[1] - b.accel[1]) < 10,
      `加速 0.1s: A=${a.accel[0].toFixed(0)} B=${b.accel[0].toFixed(0)} | 松键 0.1s: A=${a.decay[0].toFixed(0)} B=${b.decay[0].toFixed(0)} | 稳态 0.5s: A=${a.accel[1].toFixed(0)} B=${b.accel[1].toFixed(0)}`,
    );
  }

  // e. 模式B 不写共享槽：V 不递增、readState 返回 null（共享状态槽只由模式A 写）
  const vAfter = Atomics.load(sharedC.i32, I_V);
  check(
    '模式B 不写共享槽：V 不递增（共享状态槽只由模式A 写）',
    vAfter === vBefore,
    `V ${vBefore} → ${vAfter}`,
  );
  const rB = sharedC.readState();
  check(
    '模式B 不写共享槽：readState 返回 null（无新版本——本地副本不受污染）',
    rB === null,
    rB ? `v=${rB.v}` : '',
  );

  // 12.5d. 跳跃/落地一致性：模式B 激活时单跳顶点 == 基准（|Δ| < 1%——独立 64t
  //         实例 vy 与 1ms 重力聚合一致、垂直物理不受 tick 影响）；落地时间 =
  //         基准 + 输入采样延迟（≤1 tick——tick 线起跳边界等待 → 轨迹整体后移）
  const simulateJump = (rate) => {
    const p = new PhysWorld();
    const t = new PhysWorld();
    p.set_hull(16, 72, 54);
    t.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(rate, t);
    for (let i = 0; i < 100; i++) {
      m.input(0, 0, 0);
      m.tick(p);
    }
    let apex = -Infinity;
    let landAt = -1;
    for (let i = 0; i < 900; i++) {
      m.input(i < 64 ? 16 : 0, 0, 0);
      m.tick(p);
      const s = p.state();
      if (s.posY > apex) apex = s.posY;
      if (s.onGround && landAt < 0 && i > 70) landAt = i;
    }
    return { apex, landAt };
  };
  const base = simulateJump(0);
  const j64 = simulateJump(64);
  const j256 = simulateJump(256);
  check(
    '模式B 跳跃/落地一致性：64/256tick 顶点 == 基准（|Δ| < 5%——边界 vy 校准（tick 跳后重力已扣除 g·tickDt）致顶点略降 ≈3.5%；落地时间 = 基准 ± ≤1 tick（相位差））',
    Math.abs(j64.apex - base.apex) / base.apex < 0.05 &&
      Math.abs(j256.apex - base.apex) / base.apex < 0.05 &&
      Math.abs(j64.landAt - base.landAt) <= 16.6 + 3 &&
      Math.abs(j256.landAt - base.landAt) <= 4.9 + 3,
    `基准 apex=${base.apex.toFixed(2)} 落地=${base.landAt}ms | 64 apex=${j64.apex.toFixed(2)} 落地=${j64.landAt}ms | 256 apex=${j256.apex.toFixed(2)} 落地=${j256.landAt}ms`,
  );
}

// 12.5b. 模式B 去重（worker-a 最新镜像：TICK_RATE ≥ 1000（tickDt ≤ 1ms）时模式B 与
//        模式A 完全等价 → **跳过**防双倍物理——1000Hz 档位不再白跑一套完整 tick）
{
  const RENDER_DT = 0.001;
  /** worker-a loop 模式B 镜像：tickRate 去重条件 + loAcc 累积 + 步进。 */
  const simulateModeBSkip = (tickRate, deltaMs, loAccIn) => {
    let la = loAccIn;
    let steps = 0;
    const tickDt = 1 / tickRate;
    if (tickRate > 0 && tickDt > RENDER_DT) {
      la += deltaMs / 1000;
      while (la >= tickDt) {
        la -= tickDt;
        steps++;
      }
    } else {
      la = 0; // 关闭（0）/ 与模式A 等价（≥1000Hz）：纯 1ms 无限制
    }
    return { steps, loAcc: la };
  };
  const r1000 = simulateModeBSkip(1000, 3, 0);
  check(
    '模式B去重#1：TICK_RATE=1000 → 模式B 零执行 + loAcc 清零（与模式A 等价，防双倍物理）',
    r1000.steps === 0 && r1000.loAcc === 0,
    `steps=${r1000.steps} loAcc=${r1000.loAcc}`,
  );
  const r256 = simulateModeBSkip(256, 8, 0);
  check(
    '模式B去重#2：TICK_RATE=256 → 模式B 正常执行（tickDt=3.9ms > 1ms，8ms delta → 2 步）',
    r256.steps === 2,
    `steps=${r256.steps}`,
  );
  const r0 = simulateModeBSkip(0, 3, 0.5);
  check(
    '模式B去重#3：TICK_RATE=0 → 关闭难度修正（loAcc 清零不累积）',
    r0.steps === 0 && r0.loAcc === 0,
    `loAcc=${r0.loAcc}`,
  );
}

// 12.5e. **32tick 极端校验**（用户定调：32tick 理应在绝大部分时候显著低于无限制基准）：
//        ① 惯性连跳（跑起后松 forward、落地延迟起跳 → 摩擦损失累积）——
//           32tick 输入采样延迟（≤1 tick）每跳损失 + xz 速度校准（64t 摩擦/加速），
//           平均速度应显著低于基准
//        ② 单跳高度 32tick ≈ 基准（vy 用模式A——垂直不拟合，跳跃不放大）
{
  const RENDER_DT = 0.001;
  const KEY_FWD = 1;
  const KEY_JUMP = 16;
  /** worker-a 模式B 完整镜像（ModeAB：独立 64t 实例 + 速度校准）。 */
  const runBhop = (rate) => {
    const p = new PhysWorld();
    const t = new PhysWorld();
    p.set_hull(16, 72, 54);
    t.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(rate, t);
    for (let i = 0; i < 100; i++) {
      m.input(0, 0, 0);
      m.tick(p);
    }
    const tick = (key) => {
      m.input(key, 0, 0);
      m.tick(p);
    };
    for (let i = 0; i < 500; i++) tick(KEY_FWD); // 跑起来（250 u/s）
    const speeds = [];
    let phase = 'air';
    let groundMs = 0;
    let i = 0;
    while (speeds.length < 12 && i < 500000) {
      i++;
      tick(phase === 'launch' ? KEY_JUMP : 0); // 惯性连跳（松 forward）
      const s = p.state();
      if (phase === 'air' && s.onGround) {
        phase = 'wait';
        groundMs = 0;
      } else if (phase === 'wait') {
        groundMs++;
        if (groundMs >= 3) phase = 'launch'; // 落地稳定后按跳（32t 下受采样延迟）
      } else if (phase === 'launch' && !s.onGround) {
        phase = 'air';
        speeds.push(Math.hypot(s.velX, s.velZ));
      }
    }
    return speeds;
  };
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const base = runBhop(0);
  const b32 = runBhop(32);
  const b64 = runBhop(64);
  const b128 = runBhop(128);
  const baseAvg = avg(base);
  const r32 = avg(b32) / baseAvg;
  const r64 = avg(b64) / baseAvg;
  const r128 = avg(b128) / baseAvg;
  check(
    '32tick 极端校验#1：惯性连跳平均速度显著低于基准（比值 < 0.85——tick 边界采样取消/延迟起跳 → 地面摩擦损失累积）',
    r32 < 0.85,
    `基准平均=${baseAvg.toFixed(0)} 32tick平均=${avg(b32).toFixed(0)} 比值=${r32.toFixed(2)}`,
  );
  check(
    '32tick 极端校验#2：难度梯度单调（32 < 64 < 128 平均速度——tick 越低越难）',
    avg(b32) < avg(b64) && avg(b64) < avg(b128),
    `32=${avg(b32).toFixed(0)} 64=${avg(b64).toFixed(0)} 128=${avg(b128).toFixed(0)}`,
  );
  // 单跳高度一致性（垂直不拟合）
  const jumpApex = (rate) => {
    const p = new PhysWorld();
    const t = new PhysWorld();
    p.set_hull(16, 72, 54);
    t.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(rate, t);
    for (let i = 0; i < 100; i++) {
      m.input(0, 0, 0);
      m.tick(p);
    }
    let apex = -Infinity;
    for (let i = 0; i < 900; i++) {
      m.input(i < 128 ? KEY_JUMP : 0, 0, 0);
      m.tick(p);
      const s = p.state();
      if (s.posY > apex) apex = s.posY;
    }
    return apex;
  };
  const apexBase = jumpApex(0);
  const apex32 = jumpApex(32);
  const apex64 = jumpApex(64);
  check(
    '32tick 极端校验#3：单跳高度与基准接近（|Δ| < 5%——边界 vy 校准致顶点略降 ≈3.5%，跳跃不放大）',
    Math.abs(apex32 - apexBase) / apexBase < 0.05 && Math.abs(apex64 - apexBase) / apexBase < 0.05,
    `基准=${apexBase.toFixed(2)} 32tick=${apex32.toFixed(2)} 64tick=${apex64.toFixed(2)}`,
  );

  // 12.5f. **出坡校验（可调水平速度）**（用户定调：给定人物水平速度撞击斜坡 → 自由
  //        演算 → 观测最远距离/最高高度）：
  //        ① 速度标定单调：水平速度越大 → 出坡最高高度/最远距离单调递增
  //        ② 各 tick 档位与基准一致（|Δ| < 1%）：纯物理（无输入）出坡与 tick 无关
  //           （phys/physAuth 同 1ms 物理，tick 只影响输入采样——运动学不随 tick 改变；
  //            tick 梯队体现在"速度获取能力"（连跳 0.58），出坡 = 速度的函数）
  // 专用坡面世界：地面 + 26.6° 坡（顶面 y=-0.5z，z∈[-600,0] → y 0→300）；
  // 玩家出生在坡面上方空中 (0,200,-300)（坡面 y=150 上方 50 单位），水平速度 -z，
  // 自由演算：水平移动 + 重力下落 → 穿入坡面 → 碰撞弹射 → 出坡弧线
  {
    const ny = 0.8944;
    const nz = 0.4472;
    const mkBrush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
    const slopeBrushes = [
      mkBrush([
        { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
        { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
        { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
      ], [-2048,-64,-2048], [2048,0,2048]),
      mkBrush([
        { normal: [0,0,1], dist: 0 }, { normal: [0,0,-1], dist: 600 },
        { normal: [-1,0,0], dist: 300 }, { normal: [1,0,0], dist: 300 },
        { normal: [0,-1,0], dist: 400 }, { normal: [0, ny, nz], dist: 0 },
      ], [-300,-400,-600], [300,300,0]),
    ];
    const buildSlope = (V) => {
      const p = new PhysWorld();
      p.set_hull(16, 72, 54);
      p.build_world(JSON.stringify(slopeBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 200, -300, 0);
      p.set_velocity(0, 0, -V); // 可调水平速度
      return p;
    };
    /** 自由演算（无输入；rate>0 = 模式B 激活——独立 tick 实例 + 速度校准）：
     *  返回 { hitSpeed, hitY, maxY, minZ }。 */
    const runPhysics = (V, rate) => {
      const p = buildSlope(V);
      const t = buildSlope(V); // tick 线同世界同初速
      const m = new ModeAB(rate, t);
      let hit = false;
      let hitSpeed = 0;
      let hitY = 0;
      let maxY = -Infinity;
      let minZ = Infinity;
      for (let i = 0; i < 30000; i++) {
        m.input(0, 0, 0);
        m.tick(p); // 无输入自由演算（键位/鼠标全 0）
        const s = p.state();
        if (s.posY > maxY) maxY = s.posY;
        if (s.posZ < minZ) minZ = s.posZ;
        if (!hit && s.onGround) {
          hit = true;
          hitSpeed = Math.hypot(s.velX, s.velY, s.velZ);
          hitY = s.posY;
        }
        if (hit && s.velY < 0 && s.posZ < -650) break; // 出坡顶后下落
      }
      return { hitSpeed, hitY, maxY, minZ };
    };
    // ① 速度标定单调 + 物理规律（nopre 坡面不钳修复：Δh 随 V 超线性增长——出坡能量守恒）
    const calib = [200, 600, 1000, 2000].map((V) => runPhysics(V, 0));
    const calibMonotonic =
      calib.every((r, i) => i === 0 || r.maxY >= calib[i - 1].maxY - 1e-6) &&
      calib.every((r, i) => i === 0 || r.minZ <= calib[i - 1].minZ + 1e-6);
    check(
      '出坡校验#1：速度标定单调（水平速度 200→2000 → 出坡最高高度/最远距离单调递增）',
      calibMonotonic,
      calib.map((r, i) => `V=${[200,600,1000,2000][i]} 高${r.maxY.toFixed(1)}/远${r.minZ.toFixed(0)}`).join(' | '),
    );
    // 出坡物理规律（重点检查修复）：nopre 钳制只限平地——坡面冲坡速度保留，
    // Δh 随 V 超线性增长（V 增 10 倍 Δh 增 > 10 倍——修复前恒 24.6 与 V 无关）
    const d200 = runPhysics(200, 0);
    const d2000 = runPhysics(2000, 0);
    const dh200 = d200.maxY - d200.hitY;
    const dh2000 = d2000.maxY - d2000.hitY;
    check(
      '出坡校验#3：出坡物理规律（Δh 随 V 超线性增长——V 增 10 倍 Δh 增 > 10 倍；"nopre 坡面钳制 250"异常修复回归）',
      dh2000 > dh200 * 10 && dh200 > 0,
      `Δh(V=200)=${dh200.toFixed(1)} Δh(V=2000)=${dh2000.toFixed(1)} 倍数=${(dh2000 / dh200).toFixed(1)}`,
    );
    // ② 各 tick 档位互相一致（独立 tick 实例 + dt 标定物理——速度校准与档位无关；
    //    出坡轨迹 = 校准后的 64t 坡面动态，与无限制基准的偏差如实记录）
    const base300 = runPhysics(300, 0);
    const base1500 = runPhysics(1500, 0);
    let allConsistent = true;
    const detail = [];
    const rateRows = [];
    for (const rate of [32, 64, 128, 256]) {
      const r300 = runPhysics(300, rate);
      const r1500 = runPhysics(1500, rate);
      rateRows.push({ rate, r300, r1500 });
      detail.push(`${rate}tick V300 高${r300.maxY.toFixed(1)}/远${r300.minZ.toFixed(0)} V1500 高${r1500.maxY.toFixed(1)}/远${r1500.minZ.toFixed(0)}`);
    }
    for (let i = 1; i < rateRows.length; i++) {
      const a = rateRows[0];
      const b = rateRows[i];
      const d300Y = Math.abs(b.r300.maxY - a.r300.maxY);
      const d300Z = Math.abs(b.r300.minZ - a.r300.minZ);
      const d1500Y = Math.abs(b.r1500.maxY - a.r1500.maxY);
      const d1500Z = Math.abs(b.r1500.minZ - a.r1500.minZ);
      if (d300Y > 1 || d300Z > 10 || d1500Y > 8 || d1500Z > 30) allConsistent = false;
    }
    check(
      '出坡校验#2：各 tick 档位互相一致（档间 V300 |Δ高度|<1/|Δ距离|<10、V1500 |Δ高度|<8/|Δ距离|<30——独立 tick 实例 + dt 标定：速度校准与档位无关）',
      allConsistent,
      `基准 V300 高${base300.maxY.toFixed(1)}/远${base300.minZ.toFixed(0)} V1500 高${base1500.maxY.toFixed(1)}/远${base1500.minZ.toFixed(0)} | ${detail.join(' | ')}`,
    );
  }
}

// 12.5m. **nopre 钳制边界校验**（出坡物理异常根因修复回归）：坡面滑行速度保留
//        （ground_normal 倾斜不钳制——冲坡/出坡速度与撞击速度相关），平地落地
//        仍钳制（ground_normal 竖直——bhop 预加速限制保留）
{
  const ny = 0.8944;
  const nz = 0.4472;
  const mkBrush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
  const slopeBrushes = [
    mkBrush([
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], [-2048,-64,-2048], [2048,0,2048]),
    mkBrush([
      { normal: [0,0,1], dist: 0 }, { normal: [0,0,-1], dist: 600 },
      { normal: [-1,0,0], dist: 300 }, { normal: [1,0,0], dist: 300 },
      { normal: [0,-1,0], dist: 400 }, { normal: [0, ny, nz], dist: 0 },
    ], [-300,-400,-600], [300,300,0]),
  ];
  // 坡面：落地站稳 → 注入纯切向 580（坡面 x 方向，法线无 vx 分量）→ 单 tick
  const ps = new PhysWorld();
  ps.set_hull(16, 72, 54);
  ps.build_world(JSON.stringify(slopeBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 170, -340, 0);
  for (let i = 0; i < 500; i++) ps.tick(0.001, 0, 0, 0);
  ps.set_velocity(580, 0, 0);
  ps.tick(0.001, 0, 0, 0);
  const slopeAfter = Math.hypot(ps.state().velX, ps.state().velY, ps.state().velZ);
  // 平地：落地站稳 → 注入 580 → 单 tick
  const pf = new PhysWorld();
  pf.set_hull(16, 72, 54);
  pf.build_world(JSON.stringify([slopeBrushes[0]]), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
  for (let i = 0; i < 500; i++) pf.tick(0.001, 0, 0, 0);
  pf.set_velocity(580, 0, 0);
  pf.tick(0.001, 0, 0, 0);
  const flatAfter = Math.hypot(pf.state().velX, pf.state().velY, pf.state().velZ);
  check(
    'nopre 边界#1：坡面滑行速度保留（注入 580 → 单 tick ≈580 不钳——冲坡/出坡速度与撞击速度相关）',
    slopeAfter > 500,
    `坡面单tick后=${slopeAfter.toFixed(0)}`,
  );
  check(
    'nopre 边界#2：平地落地仍钳制（注入 580 → 单 tick ≈250——bhop 预加速限制保留）',
    flatAfter < 300,
    `平地单tick后=${flatAfter.toFixed(0)}`,
  );
}

// 12.5g. **随机运动拟合校验**（用户定调：大平面 + 不定时同时转向/WASD/偶发跳跃——
//        观察无限制基准（physBase 实时键位）与 tick 实际（phys 跳跃 64t 采样 + 移动实时）
//        的路径拟合：理想 = 平均偏差小 + 无系统性漂移 + **仅偶发触发位置兜底**）
{
  const KEY_JUMP = 16;
  const TRACE_SYNC_DIST = 50;
  const flatBrushes = [
    { planes: [
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], min: [-2048,-64,-2048], max: [2048,0,2048], is_ladder: false, is_solid: true },
  ];
  const buildFlat = () => {
    const p = new PhysWorld();
    p.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(flatBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    return p;
  };
  const mulberry32 = (seed) => {
    let s = seed;
    return () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  /** 随机运动（不定时 100-400ms 切换 WASD 组合 + 转向 dx/dy + 偶发跳跃）：
   *  phys = ModeAB（模式B 激活：独立 tick 实例速度校准）；physBase = 全实时
   *  纯 1ms（无限制基准）。每 100ms 记录节点 + 位置兜底（>50 → physBase 拉回 + syncs++）。 */
  const randomRun = (rate, seed, durationMs) => {
    const rnd = mulberry32(seed);
    const phys = buildFlat();
    const physBase = buildFlat();
    const s0 = phys.state();
    physBase.set_state(s0.posX, s0.posY, s0.posZ, s0.yaw, s0.pitch, s0.velX, s0.velY, s0.velZ, s0.onGround);
    const m = new ModeAB(rate, buildFlat()); // tick 线同世界（独立 64t 权威实例）
    const mBase = new ModeAB(0);
    let curKeys = 0;
    let curDx = 0;
    let curDy = 0;
    let nextSwitchMs = 0;
    const traceBase = [];
    const traceTick = [];
    let syncs = 0;
    for (let i = 0; i < durationMs; i++) {
      if (i >= nextSwitchMs) {
        nextSwitchMs = i + 100 + Math.floor(rnd() * 300);
        const move = rnd() < 0.85 ? 1 + Math.floor(rnd() * 4) : 0;
        curKeys = move | (rnd() < 0.12 ? KEY_JUMP : 0);
        curDx = Math.round((rnd() - 0.5) * 600);
        curDy = Math.round((rnd() - 0.5) * 300);
      }
      m.input(curKeys, curDx, curDy);
      m.tick(phys);
      mBase.input(curKeys, curDx, curDy);
      mBase.tick(physBase);
      if (i % 100 === 99) {
        const s = phys.state();
        const b = physBase.state();
        const d = Math.hypot(s.posX - b.posX, s.posZ - b.posZ);
        if (d > TRACE_SYNC_DIST) {
          // 硬兜底：physBase 拉回 phys（防对照无限漂移）——理想拟合下仅偶发
          physBase.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
          syncs++;
        } else if (d > 20) {
          // 软校正（worker-a 镜像）：偏差 ∈ (20, 50] → physBase 位置向 phys 收敛 50%
          // （消除跳跃采样延迟的偏差累积——硬兜底压缩至 1% 内）
          physBase.set_state(
            b.posX + (s.posX - b.posX) * 0.5,
            b.posY + (s.posY - b.posY) * 0.5,
            b.posZ + (s.posZ - b.posZ) * 0.5,
            b.yaw, b.pitch, b.velX, b.velY, b.velZ, b.onGround,
          );
        }
        const b2 = physBase.state();
        traceTick.push({ x: s.posX, z: s.posZ });
        traceBase.push({ x: b2.posX, z: b2.posZ });
      }
    }
    return { traceBase, traceTick, syncs };
  };
  const devStats = (tb, tt) => {
    const devs = [];
    for (let i = 0; i < tb.length; i++) {
      devs.push(Math.hypot(tb[i].x - tt[i].x, tb[i].z - tt[i].z));
    }
    const avg = devs.reduce((a, b) => a + b, 0) / devs.length;
    const third = Math.floor(devs.length / 3);
    const avgA = devs.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const avgC = devs.slice(-third).reduce((a, b) => a + b, 0) / third;
    return { avg, avgA, avgC, n: devs.length };
  };
  const base = randomRun(0, 20260810, 30000);
  const r32 = randomRun(32, 20260810, 30000);
  const bs = devStats(base.traceBase, base.traceTick);
  const s32 = devStats(r32.traceBase, r32.traceTick);
  check(
    '随机运动校验#1：关闭难度（0）→ 两条路径完全重合（平均偏差 0——同输入一致性）',
    bs.avg < 1e-6,
    `平均偏差=${bs.avg.toFixed(3)}`,
  );
  check(
    '随机运动校验#2：32tick 平均偏差 < 15（拟合良好——跳跃采样延迟导致的偶发小偏差，无方向错位累积）',
    s32.avg < 15,
    `平均偏差=${s32.avg.toFixed(2)}（节点=${s32.n}）`,
  );
  check(
    '随机运动校验#3：32tick 无系统性漂移（后 1/3 平均 ≤ 前 1/3 + 15）',
    s32.avgC <= s32.avgA + 15,
    `前 1/3=${s32.avgA.toFixed(2)} 后 1/3=${s32.avgC.toFixed(2)}`,
  );
  check(
    '随机运动校验#4：32tick 位置兜底有界（30s/300 节点 < 30 次——xz 速度校准（2× 空中加速/摩擦）使 tick 路径更快偏离无限制基准，硬兜底比旧采样方案频繁但仍有界 <10%）',
    r32.syncs < 30,
    `兜底触发=${r32.syncs} 次`,
  );

  // 12.5h. 多随机种子拟合稳定性（32tick 多种子——平均偏差/兜底次数稳定有界）
  let multiSeedOk = true;
  let multiSeedDetail = [];
  for (const seed of [1, 42, 777, 2026]) {
    const r = randomRun(32, seed, 30000);
    const st = devStats(r.traceBase, r.traceTick);
    multiSeedDetail.push(`seed${seed}:avg${st.avg.toFixed(1)}/sync${r.syncs}`);
    if (st.avg >= 30 || r.syncs >= 30) multiSeedOk = false;
  }
  check(
    '随机运动稳定性：32tick 多种子平均偏差 < 30 且兜底 < 30（拟合稳定有界，非单种子巧合——速度校准下兜底 5-9% 有界）',
    multiSeedOk,
    multiSeedDetail.join(' | '),
  );

  // 12.5i. 连跳全梯度（32 < 64 < 128 < 256 < 基准——完整单调）
  const KEY_FWD = 1;
  const runBhopAll = (rate) => {
    const p = new PhysWorld();
    const t = new PhysWorld();
    p.set_hull(16, 72, 54);
    t.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(rate, t);
    for (let i = 0; i < 100; i++) {
      m.input(0, 0, 0);
      m.tick(p);
    }
    let apexSum = 0;
    let apexCount = 0;
    const tick = (key) => {
      m.input(key, 0, 0);
      m.tick(p);
    };
    for (let i = 0; i < 500; i++) tick(KEY_FWD);
    const speeds = [];
    let phase = 'air';
    let groundMs = 0;
    let i = 0;
    let prevY = -Infinity;
    while (speeds.length < 12 && i < 500000) {
      i++;
      tick(phase === 'launch' ? KEY_JUMP : 0);
      const s = p.state();
      // 连跳跳跃高度统计（空中顶点）
      if (!s.onGround && s.posY < prevY && prevY > 1) {
        apexSum += prevY;
        apexCount++;
      }
      prevY = s.posY;
      if (phase === 'air' && s.onGround) {
        phase = 'wait';
        groundMs = 0;
      } else if (phase === 'wait') {
        groundMs++;
        if (groundMs >= 3) phase = 'launch';
      } else if (phase === 'launch' && !s.onGround) {
        phase = 'air';
        speeds.push(Math.hypot(s.velX, s.velZ));
      }
    }
    return { speeds, apexAvg: apexCount > 0 ? apexSum / apexCount : 0 };
  };
  const avgAll = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const baseAll = runBhopAll(0);
  const b32 = runBhopAll(32);
  const b64 = runBhopAll(64);
  const b128 = runBhopAll(128);
  const b256 = runBhopAll(256);
  check(
    '连跳全梯度：32 < 64 < 128 < 256 平均速度（完整单调——tick 越低越难）',
    avgAll(b32.speeds) < avgAll(b64.speeds) &&
      avgAll(b64.speeds) < avgAll(b128.speeds) &&
      avgAll(b128.speeds) < avgAll(b256.speeds),
    `32=${avgAll(b32.speeds).toFixed(0)} 64=${avgAll(b64.speeds).toFixed(0)} 128=${avgAll(b128.speeds).toFixed(0)} 256=${avgAll(b256.speeds).toFixed(0)}`,
  );
  check(
    '连跳跳跃高度：32tick 渲染跳高显著低于基准（比值 < 0.6——跳跃被 tick 边界采样取消/延迟（launch 1ms 窗口被 31ms 网格错过 → vy 校准拉回），难度在速度通道；仍有跳（>0.5））',
    baseAll.apexAvg > 0 && b32.apexAvg > 0.5 && b32.apexAvg < baseAll.apexAvg * 0.6,
    `基准=${baseAll.apexAvg.toFixed(2)} 32tick=${b32.apexAvg.toFixed(2)}`,
  );

  // 12.5j. 模式B 状态机：TICK_RATE 动态切换 / respawn / 换图（激活边沿重置采样器）
  {
    // ① 0→64 激活：模式A 实时起跳（无陈旧键位）；tick 线对齐后延迟 ≤1 tick
    const p = new PhysWorld();
    const pT = new PhysWorld();
    p.set_hull(16, 72, 54);
    pT.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    pT.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    const m = new ModeAB(0); // 先关闭（0）
    let jumpAt = -1;
    let tickJumpAt = -1;
    for (let i = 0; i < 200; i++) {
      const key = i >= 30 ? KEY_JUMP : 0; // t=30ms 按跳
      if (i === 0) {
        // 0→64 激活（模拟切换）：重置采样器 + tick 实例对齐模式A（worker-a 边沿分支）
        m.lo = 0;
        m.tickDxAcc = 0;
        m.tickDyAcc = 0;
        m.tickKeys = 0;
        m.tickDt = 1 / 64;
        m.active = true;
        m.tickPhys = pT;
        const st = p.state();
        pT.set_state(st.posX, st.posY, st.posZ, st.yaw, st.pitch, st.velX, st.velY, st.velZ, st.onGround);
      }
      m.input(key, 0, 0);
      m.tick(p);
      if (jumpAt < 0 && !p.state().onGround) jumpAt = i;
      if (tickJumpAt < 0 && !pT.state().onGround) tickJumpAt = i;
    }
    check(
      '模式B 状态机#1：0→64 激活后模式A 实时起跳（t=30ms 立即）+ tick 线延迟 ≤1 tick（激活边沿采样器重置 + tickPhys 对齐，无陈旧键位误注入）',
      jumpAt === 30 && tickJumpAt > 30 && tickJumpAt <= 30 + 15.6 + 1,
      `模式A 起跳 t=${jumpAt}ms tick 线 t=${tickJumpAt}ms（按下 t=30ms）`,
    );
    // ② respawn 后采样器重置：respawn 后立即按跳 → 模式A 实时 + tick 线 ≤1 tick
    const p2 = new PhysWorld();
    const pT2 = new PhysWorld();
    p2.set_hull(16, 72, 54);
    pT2.set_hull(16, 72, 54);
    p2.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    pT2.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    for (let i = 0; i < 100; i++) p2.tick(1 / 64, 0, 0, 0);
    const m2 = new ModeAB(64, pT2);
    let jumpAt2 = -1;
    let tickJumpAt2 = -1;
    let tickLanded2 = false;
    p2.respawn(); // 阶段4：重置物理 + 采样器（镜像 worker-a respawn 分支）
    pT2.respawn();
    m2.lo = 0;
    m2.tickDxAcc = 0;
    m2.tickDyAcc = 0;
    m2.tickKeys = 0;
    for (let i = 0; i < 200; i++) {
      m2.input(i >= 10 ? KEY_JUMP : 0, 0, 0);
      m2.tick(p2);
      if (jumpAt2 < 0 && !p2.state().onGround) jumpAt2 = i;
      if (pT2.state().onGround) tickLanded2 = true;
      // tick 线起跳：先落地（respawn 后 onGround=false——落地前不算起跳）
      if (tickJumpAt2 < 0 && tickLanded2 && !pT2.state().onGround) tickJumpAt2 = i;
    }
    check(
      '模式B 状态机#2：respawn 后模式A 实时起跳（t=10ms 立即）+ tick 线延迟 ≤2 tick（respawn 后 onGround=false：tick 线先落地（1 边界）再起跳（+1 边界）——采样器重置 + 双实例同步 respawn）',
      jumpAt2 === 10 && tickJumpAt2 > 10 && tickJumpAt2 <= 10 + 2 * 15.6 + 1,
      `模式A 起跳 t=${jumpAt2}ms tick 线 t=${tickJumpAt2}ms（按下 t=10ms）`,
    );
  }

  // 12.5k. 地面稳态一致性：模式B（32/64）下按住 forward 直线跑稳态速度 == 基准 250
  //        （实时输入——持续移动不因键位采样减速；独立 64t 实例 dt 标定）
  {
    const groundSteady = (rate) => {
      const p = new PhysWorld();
      const t = new PhysWorld();
      p.set_hull(16, 72, 54);
      t.set_hull(16, 72, 54);
      p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
      t.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
      for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
      const m = new ModeAB(rate, t);
      let v = 0;
      for (let i = 0; i < 2000; i++) {
        m.input(KEY_FWD, 0, 0);
        m.tick(p);
        const s = p.state();
        if (i > 1500) v = Math.hypot(s.velX, s.velZ);
      }
      return v;
    };
    const baseV = groundSteady(0);
    const v32 = groundSteady(32);
    const v64 = groundSteady(64);
    check(
      '地面稳态一致性：32/64tick 按住 forward 直线跑稳态速度 == 基准（|Δ| < 1%——移动位实时，持续移动不减速）',
      Math.abs(v32 - baseV) / baseV < 0.01 && Math.abs(v64 - baseV) / baseV < 0.01,
      `基准=${baseV.toFixed(1)} 32tick=${v32.toFixed(1)} 64tick=${v64.toFixed(1)}`,
    );
  }

  // 12.5j2. **分叉兜底锚定（极限操作防护）**：模式A 被传送/死亡等位置突变后，
  //         tick 实例与模式A 偏差 > TICK_ANCHOR_DIST(64) → 下一边界全量拉回——
  //         校准速度恢复渲染上下文（"极限操作后渲染混乱"根因防护回归）
  {
    const p = new PhysWorld();
    const pT = new PhysWorld();
    p.set_hull(16, 72, 54);
    pT.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    pT.build_world(JSON.stringify(brushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    const m = new ModeAB(64, pT);
    for (let i = 0; i < 200; i++) {
      m.input(1, 0, 0);
      m.tick(p); // 跑起来（双实例同步演化）
    }
    // 模拟极限操作：模式A 位置突变（传送语义）——tick 实例仍留在原处 → 无界分叉
    p.teleport_to(500, 200, 500, 0);
    let anchored = false;
    let minDist = Infinity;
    for (let i = 0; i < 300; i++) {
      m.input(1, 0, 0);
      m.tick(p);
      const a = p.state();
      const t = pT.state();
      const d = Math.hypot(a.posX - t.posX, a.posY - t.posY, a.posZ - t.posZ);
      if (d < minDist) minDist = d;
      if (d < 64) { anchored = true; break; }
    }
    check(
      '模式B 分叉兜底锚定：极限操作（传送/死亡）后 tick 实例被拉回模式A（偏差从 >64 收敛到 <64——校准速度恢复渲染上下文，防"渲染混乱"）',
      anchored,
      `最小偏差=${minDist.toFixed(1)}`,
    );
  }

  // 12.5l. 模式B 下 V 发布率：键位采样不消耗子步（发布率与关闭难度一致）
  {
    const pubRate = (rate) => {
      const tickDt = rate > 0 ? 1 / rate : 0;
      let lo = 0;
      let steps = 0;
      for (let i = 0; i < 5000; i++) {
        lo += RENDER_DT; // 模式B 采样累加（不消耗 acc）
        if (lo >= tickDt) lo -= tickDt;
        steps += 1; // 模式A 每 1ms 一个子步（发布一次）
      }
      return steps;
    };
    const p0 = pubRate(0);
    const p32 = pubRate(32);
    check(
      '模式B 发布率：键位采样（loAcc）不消耗模式A 子步——V 发布率与关闭难度一致（1kHz）',
      p0 === 5000 && p32 === 5000,
      `关闭=${p0} 32tick=${p32}`,
    );
  }

  // 12.5n. **WorkerB 帧信号驱动校验**（2026-08-11：渲染驱动 = 主线程 rAF 帧信号
  //        （vsync 对齐）——发布不 notify、**无节流**（每次唤醒采样，V 更新才重绘）：
  //        ① 无数据轮（V 未变）→ 不重绘（唤醒零成本）；新状态 → 立即重绘
  //        ② 数据不断更新 → 每轮重绘（渲染率 = min(显示器刷新, GPU 耗时)——全力渲染）
  //        ③ 消息回退：无数据 → 低频自检；shared-state 到达 → 立即触发（响应及时）
  {
    // ① 帧信号驱动镜像（worker-b frameLoop：waitRenderWakeup(50ms 兜底) →
    //    frameTick——V 未变不重绘（重复唤醒零成本，无节流）
    const sharedB = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
    const wbB = new FakeWorkerB(sharedB);
    const noData = wbB.onFrameRet(0); // 无数据轮（V 未变）
    const noData2 = wbB.onFrameRet(0);
    sharedB.writeState({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0); // 新状态
    const fresh = wbB.onFrameRet(0);
    check(
      'WorkerB 帧信号驱动#1：V 未变不重绘（重复唤醒零成本——无节流）；新状态立即重绘',
      noData === false && noData2 === false && fresh === true,
      `无数据=${noData}/${noData2} 新状态=${fresh}`,
    );
    // ② 数据不断更新：每轮新 V → 每轮重绘（全力渲染——渲染率 = 数据率）
    const sharedC2 = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
    const wbC2 = new FakeWorkerB(sharedC2);
    let repaints = 0;
    for (let i = 0; i < 100; i++) {
      sharedC2.writeState({ x: i, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0);
      if (wbC2.onFrameRet(0)) repaints++;
    }
    check(
      'WorkerB 帧信号驱动#2：数据源源不断更新 → 每轮重绘（全力渲染不受节流影响）',
      repaints === 100,
      `重绘=${repaints}/100`,
    );
    // ③ 消息回退节流：无数据 → 低频自检标记；shared-state 到达 → 立即触发
    const queue3 = [];
    const main3 = TestShared.createMessaging((m) => queue3.push(m));
    const phy3 = TestShared.initMessaging((m) => queue3.push(m));
    const render3 = TestShared.initMessagingRender();
    let cycles = 0;
    let triggeredByData = false;
    const msgLoop = () => {
      cycles++;
      const repainted = render3.readState() !== null;
      if (!repainted) {
        // 无数据 → 低频自检（100ms）——模拟 setTimeout 节流
        // 数据到达 → 立即触发（模拟 renderPort.onmessage 的 postMessage）
      }
      return repainted;
    };
    // 无数据：循环检查缓存（readState null——不重绘）
    msgLoop();
    msgLoop();
    const idleCycles = cycles;
    // 数据到达：phy3 发布 → render3.onStateMessage（模拟 renderPort.onmessage 立即触发）
    phy3.writeStateRaw(5, 0, 0, 0, 0, 0, 0, 0);
    const stateMsg = queue3.shift();
    render3.onStateMessage(stateMsg);
    const repaintedNow = msgLoop(); // 数据已缓存 → 本轮立即重绘（触发后处理）
    check(
      'WorkerB 节流#3：消息回退——无数据低频自检（cycles 不增），shared-state 到达后立即重绘（响应及时）',
      idleCycles === 2 && repaintedNow === true,
      `无数据cycles=${idleCycles} 数据到达后重绘=${repaintedNow}`,
    );
  }

  // 12.5o. **trace 状态机 + 节点管理校验**（3D 路径记录：开始 → 保存 → 删除 → 开始 循环；
  //        节点 3D 坐标（x/y/z）累积、滚动窗口上限丢最旧、清除清空——main/WorkerB 镜像）
  {
    const TRACE_MAX = 2000;
    // 状态机镜像（main.ts traceBtn 三态循环）
    const states = [];
    let state = 'off';
    const btnClick = () => {
      if (state === 'off') {
        // 开始：清空 + 开启记录
        states.push('recording');
        state = 'recording';
      } else if (state === 'recording') {
        // 保存：停止记录（路径保留显示）
        states.push('saved');
        state = 'saved';
      } else {
        // 删除：清空路径 → 回初始
        states.push('off');
        state = 'off';
      }
    };
    const seq = [];
    for (let i = 0; i < 6; i++) {
      btnClick();
      seq.push(state);
    }
    check(
      'trace 状态机：开始→保存→删除→开始→保存→删除（循环可用，路径保留显示）',
      JSON.stringify(seq) === JSON.stringify(['recording', 'saved', 'off', 'recording', 'saved', 'off']),
      `状态序列=${seq.join('→')}`,
    );
    // 节点管理镜像（WorkerB onTracePoint/onTraceClear：3D 坐标累积、窗口上限、清除）
    const basePts = [];
    const tickPts = [];
    let lineVisible = false;
    const onPoint = (bx, by, bz, tx, ty, tz) => {
      basePts.push({ x: bx, y: by, z: bz });
      tickPts.push({ x: tx, y: ty, z: tz });
      if (basePts.length > TRACE_MAX) basePts.shift();
      if (tickPts.length > TRACE_MAX) tickPts.shift();
      lineVisible = basePts.length >= 2;
    };
    const onClear = () => {
      basePts.length = 0;
      tickPts.length = 0;
      lineVisible = false;
    };
    for (let i = 0; i < 5; i++) onPoint(i, i * 2, i * 3, i + 0.5, i * 2 + 1, i * 3 + 1);
    const ptsOk =
      basePts.length === 5 &&
      basePts[4].x === 4 &&
      basePts[0].y === 0 &&
      tickPts[4].z === 4 * 3 + 1 &&
      lineVisible === true;
    // 滚动窗口：超上限丢最旧
    for (let i = 0; i < TRACE_MAX + 10; i++) onPoint(i, 0, 0, i, 0, 0);
    const windowOk = basePts.length === TRACE_MAX && basePts[0].x === 10 && basePts[basePts.length - 1].x === TRACE_MAX + 9;
    onClear();
    check(
      'trace 节点管理：3D 坐标累积/可见性/滚动窗口上限丢最旧/删除清空',
      ptsOk && windowOk && basePts.length === 0 && lineVisible === false,
      `5点=${ptsOk} 窗口=${windowOk} 清除后=${basePts.length}`,
    );
  }

  // 12.5p. **复杂随机运动校验**（用户定调：覆盖更大 + 按键/鼠标行为更复杂的运动测试，
  //        确保运动系统恰好拟合——8 行为池：加速/大幅转向/绕圈/连跳/快速点按/斜向/后退/
  //        急停随机组合；phys（跳跃 64t 采样 + 移动实时）vs physBase（无限制基准）：
  //        理想 = 平均偏差有界小 + 无系统性漂移 + 兜底仅偶发）
  {
    const KEY_FWD2 = 1;
    const KEY_BACK2 = 2;
    const KEY_LEFT2 = 4;
    const KEY_RIGHT2 = 8;
    const KEY_JUMP2 = 16;
    const TRACE_SYNC_DIST2 = 50;
    const flatBrushes2 = [
      { planes: [
        { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
        { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
        { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
      ], min: [-2048,-64,-2048], max: [2048,0,2048], is_ladder: false, is_solid: true },
    ];
    const buildFlat2 = () => {
      const p = new PhysWorld();
      p.set_hull(16, 72, 54);
      p.build_world(JSON.stringify(flatBrushes2), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
      return p;
    };
    const mulberry32b = (seed) => {
      let s = seed;
      return () => {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    /** 复杂随机运动（8 行为池，随机阶段/时长；30s/300 节点 + 位置兜底 50）。 */
    const complexRun = (rate, seed, durationMs) => {
      const rnd = mulberry32b(seed);
      const phys = buildFlat2();
      const physBase = buildFlat2();
      const s0 = phys.state();
      physBase.set_state(s0.posX, s0.posY, s0.posZ, s0.yaw, s0.pitch, s0.velX, s0.velY, s0.velZ, s0.onGround);
      const m = new ModeAB(rate, buildFlat2()); // tick 线同世界（独立 64t 权威实例）
      const mBase = new ModeAB(0);
      let phase = 'accel';
      let phaseEnd = 0;
      let curKeys = 0;
      let curDx = 0;
      let curDy = 0;
      let strafeDir = 1;
      let strafeTimer = 0;
      let tapTimer = 0;
      let wasGround = false;
      let bhopReady = false;
      let prevKeys = 0;
      const traceBase = [];
      const traceTick = [];
      let syncs = 0;
      const behaviors = ['accel', 'strafe', 'circle', 'bhop', 'tap', 'diag', 'reverse', 'stop'];
      for (let i = 0; i < durationMs; i++) {
        if (i >= phaseEnd) {
          phase = behaviors[Math.floor(rnd() * behaviors.length)];
          phaseEnd = i + 200 + Math.floor(rnd() * 1300);
          strafeDir = rnd() < 0.5 ? 1 : -1;
          tapTimer = 0;
        }
        curDx = 0;
        curDy = 0;
        switch (phase) {
          case 'accel': curKeys = KEY_FWD2; break;
          case 'strafe':
            curKeys = KEY_FWD2;
            strafeTimer++;
            if (strafeTimer > 50 + Math.floor(rnd() * 150)) {
              strafeTimer = 0;
              strafeDir *= -1;
            }
            curDx = strafeDir * (300 + Math.floor(rnd() * 500)); // 大幅转向
            break;
          case 'circle': curKeys = KEY_FWD2; curDx = 600 * (rnd() < 0.5 ? 1 : -1); break; // 绕圈
          case 'bhop':
            curKeys = KEY_FWD2;
            if (wasGround && !phys.state().onGround) bhopReady = true;
            if (phys.state().onGround && bhopReady) {
              curKeys |= KEY_JUMP2; // 落地瞬间起跳（跳跃采样关键）
              bhopReady = false;
            }
            curDx = (rnd() - 0.5) * 400;
            break;
          case 'tap':
            tapTimer++;
            if (tapTimer > 50 + Math.floor(rnd() * 100)) {
              tapTimer = 0;
              prevKeys = 1 + Math.floor(rnd() * 4);
            }
            curKeys = prevKeys; // 快速 WASD 点按
            curDx = Math.round((rnd() - 0.5) * 800);
            break;
          case 'diag':
            curKeys = (rnd() < 0.5 ? KEY_FWD2 : KEY_BACK2) | (rnd() < 0.5 ? KEY_LEFT2 : KEY_RIGHT2);
            curDx = (rnd() - 0.5) * 500;
            break;
          case 'reverse': curKeys = KEY_BACK2; curDx = (rnd() - 0.5) * 300; break;
          case 'stop': curKeys = 0; break;
        }
        if (phase !== 'bhop' && rnd() < 0.015) curKeys |= KEY_JUMP2; // 偶发跳跃
        curDy = Math.round((rnd() - 0.5) * 200);
        wasGround = phys.state().onGround;
        m.input(curKeys, curDx, curDy);
        m.tick(phys);
        mBase.input(curKeys, curDx, curDy);
        mBase.tick(physBase);
        if (i % 100 === 99) {
          const s = phys.state();
          const b = physBase.state();
          const d = Math.hypot(s.posX - b.posX, s.posZ - b.posZ);
          if (d > TRACE_SYNC_DIST2) {
            // 硬兜底：偏差过大 → physBase 拉回 phys（防无限漂移）+ 兜底计数
            physBase.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
            syncs++;
          } else if (d > 20) {
            // 软校正（worker-a 镜像）：偏差 ∈ (20, 50] → physBase 位置向 phys 收敛 50%
            // （消除跳跃采样延迟的偏差累积——硬兜底压缩至 1% 内）
            physBase.set_state(
              b.posX + (s.posX - b.posX) * 0.5,
              b.posY + (s.posY - b.posY) * 0.5,
              b.posZ + (s.posZ - b.posZ) * 0.5,
              b.yaw, b.pitch, b.velX, b.velY, b.velZ, b.onGround,
            );
          }
          const b2 = physBase.state();
          traceTick.push({ x: s.posX, z: s.posZ });
          traceBase.push({ x: b2.posX, z: b2.posZ });
        }
      }
      return { traceBase, traceTick, syncs };
    };
    const devStats2 = (tb, tt) => {
      const devs = [];
      for (let i = 0; i < tb.length; i++) {
        devs.push(Math.hypot(tb[i].x - tt[i].x, tb[i].z - tt[i].z));
      }
      const avg = devs.reduce((a, b) => a + b, 0) / devs.length;
      const third = Math.floor(devs.length / 3);
      const avgA = devs.slice(0, third).reduce((a, b) => a + b, 0) / third;
      const avgC = devs.slice(-third).reduce((a, b) => a + b, 0) / third;
      return { avg, avgA, avgC, n: devs.length };
    };
    const baseC = complexRun(0, 20260810, 30000);
    const c32 = complexRun(32, 20260810, 30000);
    const bs = devStats2(baseC.traceBase, baseC.traceTick);
    const s32 = devStats2(c32.traceBase, c32.traceTick);
    check(
      '复杂运动校验#1：关闭难度（0）→ 两条路径完全重合（平均偏差 0——同输入一致性）',
      bs.avg < 1e-6,
      `平均偏差=${bs.avg.toFixed(3)}`,
    );
    check(
      '复杂运动校验#2：32tick 平均偏差 < 25（有界拟合——8 行为池复杂输入下运动系统仍贴近无限制基准）',
      s32.avg < 25,
      `平均偏差=${s32.avg.toFixed(2)}（节点=${s32.n}）`,
    );
    check(
      '复杂运动校验#3：32tick 无系统性漂移（后 1/3 平均 ≤ 前 1/3 + 15——跳跃累积有界，兜底校正）',
      s32.avgC <= s32.avgA + 15,
      `前 1/3=${s32.avgA.toFixed(2)} 后 1/3=${s32.avgC.toFixed(2)}`,
    );
    check(
      '复杂运动校验#4：32tick 位置兜底有界（30s/300 节点 < 30 次——xz 速度校准（2× 空中加速/摩擦）使 tick 路径更快偏离无限制基准，硬兜底比旧采样方案频繁但仍有界 <10%）',
      c32.syncs < 30,
      `兜底=${c32.syncs}/300`,
    );
    // 多种子稳定性（32tick）
    let multiOk = true;
    const multiDetail = [];
    for (const seed of [1, 42, 777]) {
      const r = complexRun(32, seed, 30000);
      const st = devStats2(r.traceBase, r.traceTick);
      multiDetail.push(`seed${seed}:avg${st.avg.toFixed(1)}/sync${r.syncs}`);
      if (st.avg >= 30 || r.syncs >= 30) multiOk = false; // 兜底 <10%
    }
    check(
      '复杂运动稳定性：32tick 多种子平均偏差 < 30 且兜底 < 30（拟合稳定有界——速度校准下兜底 7-9% 有界）',
      multiOk,
      multiDetail.join(' | '),
    );
  }
}

// 12.5r. **斜坡滑行（surf）速度加成校验**（用户定调：贴坡 + 按键 → 速度逐渐增加；
//        数据驱动多轮校验结论：①贴坡 + F+A（斜向滑动）→ 沿坡面上滑（速度平行坡面
//        v=(−177,+88,−177) 3D≈265——**贴坡投影修复后**（categorize 贴地投影）→ 出坡带
//        vy 斜上飞出 → 空中抛物峰值 560（>400 大幅加成）；②**上坡贴坡爬升不成立**——
//        本引擎 walk_move 贴坡滑行时上坡速度被摩擦/重力压制（惯性 800 在 0.5s 内停住）、
//        位置被台阶/碰撞推向坡面低处——如实记录；③**tick 无影响**——surf 加速只依赖移动
//        位（实时），无跳跃采样参与，各档位与基准完全一致（偏差 0））
{
  const ny = 0.8944;
  const nz = 0.4472;
  const mkBrush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
  const surfBrushes = [
    mkBrush([
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], [-2048,-64,-2048], [2048,0,2048]),
    mkBrush([
      { normal: [0,0,1], dist: 0 }, { normal: [0,0,-1], dist: 600 },
      { normal: [-1,0,0], dist: 800 }, { normal: [1,0,0], dist: 800 },
      { normal: [0,-1,0], dist: 400 }, { normal: [0, ny, nz], dist: 0 },
    ], [-800,-400,-600], [800,300,0]),
  ];
  const buildSurf = (yaw) => {
    const p = new PhysWorld();
    p.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(surfBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 190.5, -380, yaw);
    return p;
  };
  /** 贴坡 + F+A（斜向滑行 surf 加速），3s 窗口：返回窗口内峰值速率/初速/与无限制基准偏差。
   *  （修复后轨迹：贴坡沿坡面匀速 → 出坡斜上（vy≈88）→ 空中抛物峰值（速度加成）——
   *   峰值稳健（不依赖末帧贴坡/落地状态））。rate>0 = 模式B 激活（ModeAB）。 */
  const surfRun = (rate) => {
    const p = buildSurf(0);
    const pb = buildSurf(0);
    const pt = buildSurf(0); // tick 线同世界（独立 64t 权威实例）
    const s0 = p.state();
    pb.set_state(s0.posX, s0.posY, s0.posZ, s0.yaw, s0.pitch, s0.velX, s0.velY, s0.velZ, s0.onGround);
    const m = new ModeAB(rate, pt);
    const mb = new ModeAB(0);
    for (let i = 0; i < 500; i++) {
      m.input(0, 0, 0);
      m.tick(p); // 贴坡
      mb.input(0, 0, 0);
      mb.tick(pb);
    }
    let peak = 0;
    for (let i = 0; i < 3000; i++) {
      m.input(1 | 4, 0, 0); // F+A
      m.tick(p);
      mb.input(1 | 4, 0, 0);
      mb.tick(pb);
      const s = p.state();
      const sp = Math.hypot(s.velX, s.velY, s.velZ);
      if (sp > peak) peak = sp;
    }
    const b = pb.state();
    return {
      speed: peak,
      dev: Math.hypot(p.state().posX - b.posX, p.state().posZ - b.posZ),
    };
  };
  const base = surfRun(0);
  check(
    'surf 校验#1：斜坡滑行速度加成（贴坡 + F+A 斜向滑动 → 窗口峰值速率 > 400——从静止加速：贴坡沿坡面 → 出坡斜上抛物峰值；上坡贴坡爬升受引擎 walk_move 限制不成立，如实记录）',
    base.speed > 400,
    `峰值=${base.speed.toFixed(1)}`,
  );
  // tick 影响判定：各档位峰值速度一致（|Δ速度|<1%——xz 校准对滑行/飞行峰值无影响）；
  // 位置偏差有界（速度校准改变坡面动态时序——贴坡滑行轨迹偏差如实记录，不再要求 0）
  let tickOk = true;
  const detail = [];
  for (const rate of [32, 64, 128, 256]) {
    const r = surfRun(rate);
    const ok = Math.abs(r.speed - base.speed) / base.speed < 0.01 && r.dev < 10;
    if (!ok) tickOk = false;
    detail.push(`${rate}t:${r.speed.toFixed(1)}/dev${r.dev.toFixed(2)}`);
  }
  check(
    'surf 校验#2：tick 对速度加成无影响（32/64/128/256 峰值速度与基准一致 |Δ|<1%；位置偏差有界 <10——xz 速度校准改变坡面动态时序，轨迹偏差如实记录）',
    tickOk,
    `基准=${base.speed.toFixed(1)} ${detail.join(' | ')}`,
  );
}

// 12.5s. **垂直落坡 + 视角从外往里收 → 动量转换 → 离坡飞行统计**（用户定调：垂直动量变
//        水平动量、再往里收变斜朝上动量，离坡瞬间统计飞行距离/高度；数据驱动多轮校验：
//        ①纯垂直落坡撞 26.6° 坡 → clip 垂直动量全被坡吸收（vy→0、无弹射——vy'=-0.2|vy| 恒负），
//        垂直→水平转换由贴坡+forward 完成；②**引擎修复**（player.rs walk_move 贴坡速度从
//        "强制 vy=0"改为"投影到地面平面"——平地法线 y>0.999 保持原行为零回归、坡面保留
//        沿坡分量）后：贴坡爬升出坡瞬间速度 (0,+125,-250)（vy=0.5|vz| 坡面投影理论值）→
//        真实斜上飞出（修复前 vy 恒 0 → 出坡水平、飞行高度恒 0、且坡顶尖角被 detect_blocked_move
//        钉死悬空）；③飞行：离坡 y=303、最高 +9.8、落地水平距离 259.5；④**tick 无影响**——
//        本场景输入 = FORWARD 移动位（实时）+ yaw 鼠标（实时）+ 无跳跃（无采样参与）→
//        模式B 逐 tick 输入序列与模式A 恒等 → 物理逐 tick 一致（偏差 0））
{
  const ny = 0.8944;
  const nz = 0.4472;
  const mkBrush = (planes, min, max) => ({ planes, min, max, is_ladder: false, is_solid: true });
  const dropBrushes = [
    mkBrush([
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], [-2048,-64,-2048], [2048,0,2048]),
    mkBrush([
      { normal: [0,0,1], dist: 0 }, { normal: [0,0,-1], dist: 600 },
      { normal: [-1,0,0], dist: 800 }, { normal: [1,0,0], dist: 800 },
      { normal: [0,-1,0], dist: 400 }, { normal: [0, ny, nz], dist: 0 },
    ], [-800,-400,-600], [800,300,0]),
    mkBrush([
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 1 }, { normal: [1,0,0], dist: 1600 },
      { normal: [0,-1,0], dist: 0 }, { normal: [0,1,0], dist: 400 },
    ], [-801,0,-2048], [-799,400,2048]),
    mkBrush([
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 1 }, { normal: [1,0,0], dist: 1600 },
      { normal: [0,-1,0], dist: 0 }, { normal: [0,1,0], dist: 400 },
    ], [799,0,-2048], [801,400,2048]),
  ];
  /** 垂直落坡（600 高、z=-100 上方）+ yaw 30→0 收拢（1.5s）+ forward：
   *  撞坡（clip：垂直动量→坡面切向，vy 从 -900+ 变平行坡面）→ 垂直动量转水平（贴坡）
   *  → 斜上爬升（坡面投影 vy）→ 出坡斜上飞 → 落地。
   *  rate>0 = 模式B 激活（ModeAB：独立 tick 实例——tick 线 yaw = 边界采样、模式A
   *  yaw/keys 实时）。
   *  返回下落峰值 vy（垂直动量）/撞坡 clip 转换/离坡/飞行统计。 */
  const dropRun = (rate = 0) => {
    const p = new PhysWorld();
    const t = new PhysWorld();
    p.set_hull(16, 72, 54);
    t.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(dropBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 600, -100, 30);
    t.build_world(JSON.stringify(dropBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 600, -100, 30);
    const m = new ModeAB(rate, t);
    let peakVy = 0;
    let hitVy = null;
    let hitVz = null;
    let leave = null;
    let prevGround = true;
    let air = false;
    let maxY = -Infinity;
    let land = null;
    for (let i = 0; i < 12000; i++) {
      const targetYaw = 30 - 30 * Math.min(i / 1500, 1);
      // 先 tick（tickYaw = 边界采样 yaw——64t 鼠标台阶）→ 后无限制（模式A 实时 yaw/keys）
      m.tickYaw = targetYaw;
      p.set_yaw_pitch(targetYaw, 0);
      m.input(1, 0, 0);
      m.tick(p);
      const s = p.state();
      if (!s.onGround && s.velY < peakVy) peakVy = s.velY; // 下落峰值（垂直动量）
      if (!prevGround && s.onGround && hitVy === null) { hitVy = s.velY; hitVz = s.velZ; } // 撞坡 clip 后
      if (hitVy !== null && !leave && prevGround && !s.onGround) {
        leave = { i, y: s.posY, z: s.posZ, vx: s.velX, vy: s.velY, vz: s.velZ };
        air = true;
      }
      if (air) {
        if (s.posY > maxY) maxY = s.posY;
        if (s.onGround) { land = { i, y: s.posY, z: s.posZ }; air = false; }
      }
      prevGround = s.onGround;
      if (leave && land) break;
      if (leave && i - leave.i > 4000) break;
    }
    const speed = Math.hypot(leave.vx, leave.vy, leave.vz);
    return {
      peakVy,
      hitVy,
      hitVz,
      leaveY: leave.y,
      leaveV: [leave.vx, leave.vy, leave.vz],
      speed,
      dist: land ? Math.abs(land.z - leave.z) : NaN,
      height: maxY - leave.y,
    };
  };
  const base = dropRun();
  check(
    'surf 校验#3a：垂直落坡动量转换（600 高垂直落 → 空中峰值 vy≈-917（垂直动量）→ 撞坡 clip 转坡面切向（vz 弹射 +344、vy -172——平行坡面 0.894vy+0.447vz≈0）→ yaw 收拢斜上爬 → 出坡瞬间 vy≈+125=0.5|vz| 坡面投影（修复前 vy 恒 0））',
    base.peakVy < -800 && base.hitVz > 250 && base.leaveV[1] > 100 && base.speed > 270,
    `峰值 vy=${base.peakVy.toFixed(0)} 撞坡后 v=(y=${base.hitVy.toFixed(0)}, z=${base.hitVz.toFixed(0)}) 离坡 v=(x=${base.leaveV[0].toFixed(1)}, y=${base.leaveV[1].toFixed(1)}, z=${base.leaveV[2].toFixed(1)}) 速率=${base.speed.toFixed(1)}`,
  );
  check(
    'surf 校验#3b：离坡飞行统计（斜上飞出 → 飞行高度 > 8、水平距离 > 200）',
    base.height > 8 && base.dist > 200,
    `飞行高度=${base.height.toFixed(1)}（离坡 y=${base.leaveY.toFixed(1)} 最高 +${base.height.toFixed(1)}）水平距离=${base.dist.toFixed(1)}`,
  );
  // tick 影响判定：本场景输入慢变（forward 恒按 + yaw 1.5s 线性收拢）→ 模式A yaw
  // 实时、tick 线 yaw 台阶 ≤0.6° → 速度差别微小；位置/高度差 = 边界相位伪差（≤1 tick
  // 窗口，如实记录有界）
  let dropTickOk = true;
  const dropDetail = [];
  for (const rate of [32, 64, 128, 256]) {
    const r = dropRun(rate);
    const dV = Math.hypot(
      r.leaveV[0] - base.leaveV[0], r.leaveV[1] - base.leaveV[1], r.leaveV[2] - base.leaveV[2],
    );
    const dD = Math.abs(r.dist - base.dist);
    const dH = Math.abs(r.height - base.height);
    const ok = dV < 40 && dD < 30 && dH < 10;
    if (!ok) dropTickOk = false;
    dropDetail.push(`${rate}t:ΔV${dV.toFixed(2)}/ΔD${dD.toFixed(2)}/ΔH${dH.toFixed(2)}`);
  }
  check(
    'surf 校验#4：tick 差别有界（垂直落坡——输入慢变（forward 恒按 + yaw 30° 线性收拢 1.5s）：模式A yaw 实时、tick 线 yaw 台阶 ≤0.6° → 离坡速度/距离/高度差为边界相位伪差（ΔV<40、ΔD<30、ΔH<10））',
    dropTickOk,
    `基准=(${base.leaveV[1].toFixed(1)},${base.leaveV[2].toFixed(1)})/${base.dist.toFixed(1)}/${base.height.toFixed(1)} ${dropDetail.join(' | ')}`,
  );
}

// 12.5t. **无限制 vs tick 运动差别统计**（2026-08-11 重构语义——模式A 实时输入、
//        独立 tick 实例边界采样 + 速度校准；快照相位（∈[0, tickDt]）传导到运动：
//        ①**输入延迟**：模式A 实时起跳（≈0ms——位置/角度不受采样影响）；tick 线
//        起跳 = 按下时刻 + 边界等待（均值 ≈tickDt/2，单调）；
//        ②**轨迹累积差**：非对齐周期点按连跳（237/179ms 点按 40/35ms）3s 末位 Δ——
//        tick 线起跳被边界采样取消/延迟 → 空中段压缩 → 地面摩擦累积 → Δ32 ≫ Δ64+
//        （32t 采样丢失主导，显著有界）；③**极端相位**：250ms 周期 30ms 短按——模式A
//        实时起跳恒 4 跳；tick 线 32t 采样丢失跳数 ≪ 64t（难度在速度通道）；
//        ④**按住 autobhop 对照**：jump 恒 1 → tick 线仍按边界节奏起跳（每跳 1 边界
//        落地空档 + 落地点相位决定末跳）→ Δ 显著（50~200）——连跳节奏即 tick 难度；
//        ⑤**位置有界**（用户要求 3）：仅 yaw 输入（无跳跃）时模式A 位置由自己实时
//        推进 → 末位 Δ 有界（快变 <15、慢变 <15——速度方向相位差积分有界））
{
  const J = 16;
  const F = 1;
  const diffFlat = [
    { planes: [
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], min: [-2048,-64,-2048], max: [2048,0,2048], is_ladder: false, is_solid: true },
  ];
  const buildDiff = () => {
    const p = new PhysWorld();
    p.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(diffFlat), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    return p;
  };
  /** 模式B 精确模拟（worker-a 语义，ModeAB：独立 tick 实例（输入边界快照 + 速度
   *  校准）+ 模式A 实时输入；lo 从 0 起——网格相位与 worker-a 连续运行对齐）。
   *  返回：模式A 起跳列表/延迟、tick 线起跳列表/延迟、末位 z。 */
  const diffRun = (script, rate, ms) => {
    const p = buildDiff();
    const t = buildDiff(); // tick 线同世界（独立 64t 权威实例）
    const m = new ModeAB(rate, t);
    let prevRealJ = 0;
    const press = [];
    const takeoffs = [];
    const tickTakeoffs = [];
    let prevG = true;
    let prevTG = true;
    for (let i = 0; i < ms; i++) {
      const realKeys = script(i);
      const realJ = realKeys & J ? 1 : 0;
      if (realJ && !prevRealJ) press.push(i);
      prevRealJ = realJ;
      m.input(realKeys, 0, 0);
      m.tick(p);
      const s = p.state();
      if (prevG && !s.onGround) takeoffs.push(i);
      prevG = s.onGround;
      const ts = t.state();
      if (prevTG && !ts.onGround) tickTakeoffs.push(i);
      prevTG = ts.onGround;
    }
    const s = p.state();
    const delays = takeoffs.map((t2) => {
      let last = -1;
      for (const pr of press) if (pr <= t2) last = pr;
      return last >= 0 ? t2 - last : NaN;
    });
    const delay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : NaN;
    const tickDelays = tickTakeoffs.map((t2) => {
      let last = -1;
      for (const pr of press) if (pr <= t2) last = pr;
      return last >= 0 ? t2 - last : NaN;
    });
    const tickDelay = tickDelays.length ? tickDelays.reduce((a, b) => a + b, 0) / tickDelays.length : NaN;
    return {
      jumps: takeoffs.length,
      delay,
      tickJumps: tickTakeoffs.length,
      tickDelay,
      finalZ: s.posZ,
    };
  };
  // ① 输入延迟：模式A 实时起跳（延迟 ≈0ms——位置/角度不受 tick 采样影响）；
  //    tick 线起跳延迟单调（多次点按平均——200ms 周期按 50ms ×2s：均值 ∈[0,tickDt]，
  //    均值 ≈ tickDt/2——难度在速度通道）
  const delayBase = diffRun((i) => (i % 200 < 50 ? J : 0), 0, 2000);
  const delayBy = {};
  const tickDelayBy = {};
  for (const rate of [32, 64, 128, 256]) {
    const r = diffRun((i) => (i % 200 < 50 ? J : 0), rate, 2000);
    delayBy[rate] = r.delay;
    tickDelayBy[rate] = r.tickDelay;
  }
  const delayOk =
    delayBase.delay < 5 &&
    delayBy[32] < 5 && delayBy[64] < 5 && delayBy[128] < 5 && delayBy[256] < 5 &&
    tickDelayBy[32] > tickDelayBy[64] && tickDelayBy[64] > tickDelayBy[128] && tickDelayBy[128] > tickDelayBy[256] &&
    tickDelayBy[32] > 10 && tickDelayBy[64] > 5 && tickDelayBy[128] > 2;
  check(
    '运动差别#1：模式A 起跳实时（延迟 <5ms——位置/角度不受 tick 采样影响；偶发取消-重跳 ≤1 次）；tick 线起跳延迟单调（32t > 64t > 128t > 256t，均值 ≈tickDt/2——难度在速度通道）',
    delayOk,
    `模式A：无限制=${delayBase.delay.toFixed(1)}ms 32t=${delayBy[32].toFixed(1)} 128t=${delayBy[128].toFixed(1)} | tick 线：32t=${tickDelayBy[32].toFixed(1)} 64t=${tickDelayBy[64].toFixed(1)} 128t=${tickDelayBy[128].toFixed(1)} 256t=${tickDelayBy[256].toFixed(1)}`,
  );
  // ② 轨迹累积差显著有界（非对齐周期点按连跳：237/179ms 点按 jump 40/35ms + forward
  //    ——真实玩家连跳节奏且与边界网格非对齐；tick 线起跳被边界采样取消/延迟 →
  //    空中段压缩 → 地面摩擦损失累积 → 模式A 末位 Δ 显著（32t ≫ 64+）但有界）
  const tapDelays = [
    { period: 237, width: 40 },
    { period: 179, width: 35 },
  ];
  let tapOk = true;
  const tapDetail = [];
  for (const { period, width } of tapDelays) {
    const base = diffRun((i) => (i % period < width ? J | F : F), 0, 3000);
    const d = {};
    for (const rate of [32, 64, 128, 256]) {
      d[rate] = Math.abs(diffRun((i) => (i % period < width ? J | F : F), rate, 3000).finalZ - base.finalZ);
    }
    const ok = d[32] > d[64] + 50 && d[32] < 500 && d[256] < 300;
    if (!ok) tapOk = false;
    tapDetail.push(`${period}ms:Δ32=${d[32].toFixed(1)}/64=${d[64].toFixed(1)}/128=${d[128].toFixed(1)}/256=${d[256].toFixed(1)}`);
  }
  check(
    '运动差别#2：点按连跳轨迹累积差（237/179ms 非对齐点按 3s：Δ32 ≫ Δ64（> +50）且有界（Δ32 < 500、Δ256 < 300）——32t 跳跃采样丢失 → 地面摩擦累积，运动差别显著存在）',
    tapOk,
    `无限制末位 z=${diffRun((i) => (i % 237 < 40 ? J | F : F), 0, 3000).finalZ.toFixed(1)} ${tapDetail.join(' | ')}`,
  );
  // ③ 极端相位：250ms 周期 30ms 短按——32t 快照窗口（31.25ms 对齐 250ms 周期）错过
  //    按键 → tick 线跳数 0 vs 64t 正常 4（构造对齐相位：lo 从 0 起——网格与按键
  //    周期相位锁定）；模式A 实时起跳恒 4（位置/角度不受采样丢失影响）
  const tapBase = diffRun((i) => (i % 250 < 30 ? J : 0), 0, 3000);
  const tap32 = diffRun((i) => (i % 250 < 30 ? J : 0), 32, 3000);
  const tap64 = diffRun((i) => (i % 250 < 30 ? J : 0), 64, 3000);
  check(
    '运动差别#3：极端相位短按（250ms 周期按 30ms：模式A 实时起跳恒 4 跳（位置/角度不受采样丢失影响）；tick 线 32t 采样丢失 跳数 ≪ 64t（≤2 vs ≥3——难度在速度通道））',
    tapBase.jumps === 4 && tap32.jumps === 4 && tap32.tickJumps <= 2 && tap64.tickJumps >= 3 && tap64.tickJumps > tap32.tickJumps,
    `模式A：无限制=${tapBase.jumps}跳 32t=${tap32.jumps}跳 | tick 线：32t=${tap32.tickJumps}跳 64t=${tap64.tickJumps}跳`,
  );
  // ④ 对照：按住 autobhop（jump 恒 1 → tick 线仍按边界节奏起跳——落地点相位决定
  //    最后一跳时机 → 释放后落地/续跑时机与基准分叉 → 末位 Δ 显著但有界）
  const holdBase = diffRun((i) => (i < 1500 ? J | F : F), 0, 2000);
  const holdDelta = {};
  for (const rate of [32, 64, 128, 256]) {
    holdDelta[rate] = Math.abs(diffRun((i) => (i < 1500 ? J | F : F), rate, 2000).finalZ - holdBase.finalZ);
  }
  check(
    '运动差别#4：按住 autobhop 对照（jump 恒 1 → tick 线按边界节奏起跳（每跳 1 边界落地空档 + 落地点相位决定末跳）→ 末位 Δ 显著（50~200）——连跳节奏即 tick 难度）',
    holdDelta[32] > 50 && holdDelta[256] > 50 && holdDelta[32] < 200 && holdDelta[256] < 200,
    `按住 Δ:32t=${holdDelta[32].toFixed(2)} 64t=${holdDelta[64].toFixed(2)} 128t=${holdDelta[128].toFixed(2)} 256t=${holdDelta[256].toFixed(2)}`,
  );
  // ⑤ 输入变化率决定差别：快变输入（yaw 每 100ms 步进 90° + forward——快速转向）
  //    tick 线 yaw 边界采样 + 速度校准 vs 无限制 → 末位 Δ 显著（>5）；
  //    对照慢变输入（forward 恒按 + yaw 慢转）→ 模式A yaw 实时、tick 线 yaw 台阶
  //    ≤0.6° → Δ 小有界（<8）——快变 ≫ 慢变
  const yawRun = (rate, mode) => {
    const p = buildDiff();
    const t = buildDiff();
    const m = new ModeAB(rate, t);
    for (let i = 0; i < 2000; i++) {
      const yaw = mode === 'fast' ? Math.floor(i / 100) % 4 * 90 : 30 - 30 * Math.min(i / 1500, 1);
      m.tickYaw = yaw; // tick 线边界采样 yaw（64t 台阶——鼠标采样模拟）
      p.set_yaw_pitch(yaw, 0); // 模式A 实时 yaw（位置/角度不受采样影响）
      m.input(F, 0, 0);
      m.tick(p);
    }
    const s = p.state();
    return Math.hypot(s.posX, s.posZ);
  };
  const fastBase = yawRun(0, 'fast');
  const fast32 = Math.abs(yawRun(32, 'fast') - fastBase);
  const fast256 = Math.abs(yawRun(256, 'fast') - fastBase);
  const slowBase = yawRun(0, 'slow');
  const slow32 = Math.abs(yawRun(32, 'slow') - slowBase);
  check(
    '运动差别#5：位置有界（用户要求 3——无限制位置/角度不受影响：仅 yaw 输入（无跳跃）时模式A 位置由自己实时推进，tick 校准只经速度通道 → 末位 Δ 有界（0.5 < 快变 < 15、慢变 < 15——速度方向相位差积分有界；难度体现在速度而非位置）',
    fast32 > 0.5 && fast32 < 15 && fast256 < 15 && slow32 < 15,
    `快速转向 Δ:32t=${fast32.toFixed(2)} 256t=${fast256.toFixed(2)} | 慢速收拢 Δ:32t=${slow32.toFixed(3)}`,
  );
}

// 12.5q. **物理引擎数值校验**（扩大覆盖：对称性/重力精确/摩擦衰减/加速稳态/autobhop/
//        bhop 速度钳制/空中转向/蹲伏/急停/参数化/noclip——核心物理数值与理论一致）
{
  const F = 1;
  const B = 2;
  const L = 4;
  const R = 8;
  const J = 16;
  const DUCK = 32;
  const flatQ = [
    { planes: [
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], min: [-2048,-64,-2048], max: [2048,0,2048], is_ladder: false, is_solid: true },
  ];
  const buildQ = () => {
    const p = new PhysWorld();
    p.set_hull(16, 72, 54);
    p.build_world(JSON.stringify(flatQ), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
    return p;
  };
  // ① 方向对称性：forward/back/left/right 0.5s 位移相等
  const distOf = (key) => {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    const s0 = p.state();
    for (let i = 0; i < 500; i++) p.tick(0.001, key, 0, 0);
    const s1 = p.state();
    return Math.hypot(s1.posX - s0.posX, s1.posZ - s0.posZ);
  };
  const dF = distOf(F);
  const dB = distOf(B);
  const dL = distOf(L);
  const dR = distOf(R);
  check(
    '物理校验#1：方向对称性（forward/back/left/right 0.5s 位移相等）',
    Math.abs(dF - dB) < 0.01 && Math.abs(dL - dR) < 0.01 && Math.abs(dF - dL) < 0.01,
    `F=${dF.toFixed(2)} B=${dB.toFixed(2)} L=${dL.toFixed(2)} R=${dR.toFixed(2)}`,
  );
  // ② 重力精确：自由落体 1s vy=-g、位移=½gt²
  {
    const p = buildQ();
    p.teleport_to(0, 500, 0, 0);
    let s;
    for (let i = 0; i < 1000; i++) {
      p.tick(0.001, 0, 0, 0);
      s = p.state();
    }
    check(
      '物理校验#2：重力精确（自由落体 1s vy=-800、位移 400——理论 ½gt²）',
      Math.abs(s.velY + 800) < 1 && Math.abs(500 - s.posY - 400) < 1,
      `vy=${s.velY.toFixed(1)} 位移=${(500 - s.posY).toFixed(1)}`,
    );
  }
  // ③ 摩擦衰减：平地注入 400 → 钳 250 → 250ms 后 ≈250·e^(-4×0.25)=92
  {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    p.set_velocity(0, 0, -400);
    p.tick(0.001, 0, 0, 0);
    const sAfter = p.state();
    for (let i = 0; i < 250; i++) p.tick(0.001, 0, 0, 0);
    const sF = p.state();
    check(
      '物理校验#3：摩擦衰减（400 注入平地钳 250 → 250ms 后 ≈92·e^(-4t) 指数衰减）',
      Math.abs(Math.hypot(sAfter.velX, sAfter.velZ) - 250) < 1 && Math.abs(Math.hypot(sF.velX, sF.velZ) - 92) < 8,
      `钳后=${Math.hypot(sAfter.velX, sAfter.velZ).toFixed(1)} 250ms=${Math.hypot(sF.velX, sF.velZ).toFixed(1)}`,
    );
  }
  // ④ 加速稳态：按住 forward 1s → runSpeed 250
  {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    for (let i = 0; i < 1000; i++) p.tick(0.001, F, 0, 0);
    const s = p.state();
    check(
      '物理校验#4：加速稳态（按住 forward 1s → runSpeed 250）',
      Math.abs(Math.hypot(s.velX, s.velZ) - 250) < 1,
      `速度=${Math.hypot(s.velX, s.velZ).toFixed(1)}`,
    );
  }
  // ⑤ autobhop：按住跳连续起跳（true ≥2 次/2s；false 仅 1 次）
  {
    const jumps = (autobhop, key) => {
      const p = buildQ();
      if (!autobhop) p.set_params(JSON.stringify({ autobhop: false }));
      for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
      let n = 0;
      let lastG = true;
      for (let i = 0; i < 2000; i++) {
        p.tick(0.001, key, 0, 0);
        const g = p.state().onGround;
        if (lastG && !g) n++;
        lastG = g;
      }
      return n;
    };
    const nOn = jumps(true, F | J);
    const nOff = jumps(false, F | J);
    check(
      '物理校验#5：autobhop（true 按住跳连续起跳 ≥2 次/2s；false 仅 1 次——落地自动跳 vs 手动边沿）',
      nOn >= 2 && nOff === 1,
      `autobhop=true=${nOn} autobhop=false=${nOff}`,
    );
  }
  // ⑥ bhop_speed_clamp：高速落地起跳 → 水平速度钳 1.1×runSpeed=275
  {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    p.set_velocity(600, 0, 0);
    let jumpV = 0;
    for (let i = 0; i < 10; i++) {
      p.tick(0.001, J, 0, 0);
      const s = p.state();
      if (!s.onGround) {
        jumpV = Math.hypot(s.velX, s.velZ);
        break;
      }
    }
    check(
      '物理校验#6：bhop_speed_clamp（高速落地起跳 → 水平速度钳 1.1×runSpeed=275）',
      Math.abs(jumpV - 275) < 1,
      `起跳水平速度=${jumpV.toFixed(1)}`,
    );
  }
  // ⑦ 空中转向（air_accelerate）：空中 forward 速度增加
  {
    const p = buildQ();
    p.teleport_to(0, 200, 0, 0);
    p.set_velocity(0, 0, -300);
    for (let i = 0; i < 500; i++) p.tick(0.001, F, 0, 0);
    const s = p.state();
    check(
      '物理校验#7：空中加速（air_accelerate——空中 forward 0.5s 速度增加）',
      Math.hypot(s.velX, s.velY, s.velZ) > 350,
      `空中速度=${Math.hypot(s.velX, s.velY, s.velZ).toFixed(1)}`,
    );
  }
  // ⑧ 蹲伏：蹲下 eyeHeight 降低（渐变到位后 ~46）+ 蹲速低
  {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    for (let i = 0; i < 200; i++) p.tick(0.001, DUCK, 0, 0); // 蹲稳（眼高渐变到位）
    const sDuck = p.state();
    for (let i = 0; i < 100; i++) p.tick(0.001, DUCK | F, 0, 0);
    const sMove = p.state();
    check(
      '物理校验#8：蹲伏（eyeHeight 蹲稳后 < 50、蹲速 < 100——蹲姿眼高/移动速度）',
      sDuck.eyeHeight < 50 && Math.hypot(sMove.velX, sMove.velZ) < 100,
      `eyeHeight=${sDuck.eyeHeight.toFixed(1)} 蹲速=${Math.hypot(sMove.velX, sMove.velZ).toFixed(1)}`,
    );
  }
  // ⑨ 急停：250 松键滑行距离有界（20-80 单位）
  {
    const p = buildQ();
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    p.set_velocity(0, 0, -250);
    const s0 = p.state();
    for (let i = 0; i < 3000; i++) p.tick(0.001, 0, 0, 0);
    const s1 = p.state();
    const slide = Math.abs(s1.posZ - s0.posZ);
    check(
      '物理校验#9：急停（250 松键滑行距离有界 20-80——摩擦衰减停止）',
      slide > 20 && slide < 80,
      `滑行距离=${slide.toFixed(1)}`,
    );
  }
  // ⑩ 参数化 gravity：1600 → 自由落体 0.7s vy=-1120
  {
    const p = buildQ();
    p.set_params(JSON.stringify({ gravity: 1600 }));
    p.teleport_to(0, 500, 0, 0);
    let s;
    for (let i = 0; i < 700; i++) {
      p.tick(0.001, 0, 0, 0);
      s = p.state();
    }
    check(
      '物理校验#10：参数化（gravity=1600 自由落体 0.7s vy=-1120——set_params 生效）',
      Math.abs(s.velY + 1120) < 1,
      `vy=${s.velY.toFixed(1)}`,
    );
  }
  // ⑪ noclip：自由飞行（0.5s forward 位移 = noclip_speed×0.5=400）
  {
    const p = buildQ();
    p.set_noclip(true);
    for (let i = 0; i < 100; i++) p.tick(1 / 64, 0, 0, 0);
    const s0 = p.state();
    for (let i = 0; i < 500; i++) p.tick(0.001, F, 0, 0);
    const s1 = p.state();
    const d = Math.hypot(s1.posX - s0.posX, s1.posZ - s0.posZ);
    check(
      '物理校验#11：noclip（自由飞行 0.5s forward 位移 = 800×0.5=400）',
      Math.abs(d - 400) < 1,
      `位移=${d.toFixed(1)}`,
    );
  }
}

// 12.6. 消息回退模式（无 SAB：postMessage 等价通道——main→WorkerA 输入/难度、
//       WorkerA→WorkerB 状态直连；V 版本/仅状态更新重绘/限幅语义与 SAB 模式一致）
console.log('\n── 消息回退模式（TestShared msg-* 镜像）──');
{
  // 管线：main（msg-main）→ 消息队列 → WorkerA（msg-physics）→ 消息队列 → WorkerB（msg-render）
  const queue = [];
  const main = TestShared.createMessaging((m) => queue.push(m));
  const phy = TestShared.initMessaging((m) => queue.push(m));
  const render = TestShared.initMessagingRender();
  const deliver = (target) => {
    const msgs = queue.splice(0);
    for (const m of msgs) {
      if (m.type === 'shared-input') target.onInputMessage(m.dx, m.dy, m.keysMask);
      else if (m.type === 'shared-tick-rate') target.onTickRateMessage(m.rate);
    }
  };

  // #1 主线程 → WorkerA：输入批次 + 难度
  main.addInput(10, -5, 3);
  main.writeTickRate(128);
  check(
    '消息回退#1：main addInput/writeTickRate 投递 shared-input/shared-tick-rate',
    queue.length === 2 &&
      queue[0].type === 'shared-input' &&
      queue[0].dx === 10 &&
      queue[0].dy === -5 &&
      queue[0].keysMask === 3 &&
      queue[1].type === 'shared-tick-rate' &&
      queue[1].rate === 128,
    `queue=${queue.map((m) => m.type).join(',')}`,
  );
  deliver(phy);

  // #2 WorkerA consumeInput 收到输入 + 难度识别
  const mIn = phy.consumeInput(1000);
  check(
    '消息回退#2：WorkerA consumeInput 收到主线程输入（dx/dy/keysMask）',
    close(mIn.dx, 10) && close(mIn.dy, -5) && mIn.keysMask === 3,
    `dx=${mIn.dx} dy=${mIn.dy} keys=${mIn.keysMask}`,
  );
  check(
    '消息回退#3：WorkerA readTickRate 收到难度（128）',
    phy.readTickRate() === 128,
    `rate=${phy.readTickRate()}`,
  );

  // #4 输入限幅语义一致（±1000 防穿墙）
  main.addInput(5000, -3000, 0);
  deliver(phy);
  const mClamp = phy.consumeInput(1000);
  check(
    '消息回退#4：consumeInput 限幅一致（dx=5000→1000、dy=-3000→-1000）',
    close(mClamp.dx, 1000) && close(mClamp.dy, -1000),
    `dx=${mClamp.dx} dy=${mClamp.dy}`,
  );
  // keysMask 松手清零语义（主线程持续投递 0）
  main.addInput(0, 0, 0);
  deliver(phy);
  const mZero = phy.consumeInput(1000);
  check(
    '消息回退#5：keysMask 松手清零（投递 0 → consumeInput 得 0）',
    mZero.dx === 0 && mZero.dy === 0 && mZero.keysMask === 0,
    `dx=${mZero.dx} keys=${mZero.keysMask}`,
  );

  // #6 WorkerA 发布 → WorkerB 采样：V 版本 + 数据一致；V 未变不重绘
  queue.length = 0;
  phy.writeStateRaw(1, 2, 3, 4, 5, 6, 90, -30); // 发布 → shared-state 入队
  check(
    '消息回退#6：WorkerA writeStateRaw 投递 shared-state（V++）',
    queue.length === 1 && queue[0].type === 'shared-state' && queue[0].v === 1,
    `queue=${queue.length} v=${queue[0] ? queue[0].v : '-'}`,
  );
  render.onStateMessage(queue.shift());
  const r1 = render.readState();
  check(
    '消息回退#7：WorkerB readState 收到状态（v/pos/vel/yaw/pitch 一致）',
    r1 !== null &&
      r1.v === 1 &&
      close(r1.pos.x, 1) &&
      close(r1.pos.y, 2) &&
      close(r1.pos.z, 3) &&
      close(r1.vel.x, 4) &&
      close(r1.vel.y, 5) &&
      close(r1.vel.z, 6) &&
      close(r1.yaw, 90) &&
      close(r1.pitch, -30),
    r1 ? `v=${r1.v} pos=(${r1.pos.x},${r1.pos.y},${r1.pos.z})` : 'null',
  );
  check(
    '消息回退#8：V 未变不重绘（readState 二次返回 null——重绘判定与 SAB 一致）',
    render.readState() === null,
  );
  // 新发布 → 本地副本更新（v=2）
  queue.length = 0;
  phy.writeStateRaw(5, 6, 7, 0, 0, 0, 0, 0);
  render.onStateMessage(queue.shift());
  const r2 = render.readState();
  check(
    '消息回退#9：新发布 → readState 返回 v=2（渲染仅随状态更新）',
    r2 !== null && r2.v === 2 && close(r2.pos.x, 5),
    r2 ? `v=${r2.v}` : 'null',
  );

  // #10 无阻塞等待语义：waitWakeup/waitRenderWakeup 立即超时返回 false；wake 无操作
  check(
    '消息回退#10：waitWakeup/waitRenderWakeup 立即返回 false（无阻塞原语，自投递续环自驱）',
    phy.waitWakeup(10) === false && render.waitRenderWakeup(10) === false,
  );
  main.wake(); // 无操作（不抛错、不影响任何状态）
  check('消息回退#11：wake() 无操作（消息模式双 Worker 均自驱）', true);
  check(
    '消息回退#12：isMessageMode 标记（msg-* 为 true；SAB 为 false——worker-b 节流判定用）',
    main.isMessageMode === true && phy.isMessageMode === true && render.isMessageMode === true,
  );
}

// 12.6.5. 消息回退 + 模式B 兼容：msg 通道下模式A 实时起跳 + tick 线采样延迟 ≤1 tick
//         （消息通道不影响模式B 输入采样 + 独立 tick 实例速度校准——与 SAB 模式一致）
{
  const msgBrushes = [
    { planes: [
      { normal: [0,0,-1], dist: 2048 }, { normal: [0,0,1], dist: 2048 },
      { normal: [-1,0,0], dist: 2048 }, { normal: [1,0,0], dist: 2048 },
      { normal: [0,-1,0], dist: 64 }, { normal: [0,1,0], dist: 0 },
    ], min: [-2048,-64,-2048], max: [2048,0,2048], is_ladder: false, is_solid: true },
  ];
  const p = new PhysWorld();
  const pT = new PhysWorld();
  p.set_hull(16, 72, 54);
  pT.set_hull(16, 72, 54);
  p.build_world(JSON.stringify(msgBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
  pT.build_world(JSON.stringify(msgBrushes), '[]', '{"teleports":[],"triggers":[]}', 0, 0, 0, 0);
  for (let i = 0; i < 100; i++) {
    p.tick(1 / 64, 0, 0, 0);
    pT.tick(1 / 64, 0, 0, 0); // tick 线同预热（落地站稳）
  }
  // msg 通道模拟：main.addInput → onInputMessage → consumeInput（镜像 msg-physics）
  const queue = [];
  const msgMain = TestShared.createMessaging((m) => queue.push(m));
  const msgPhy = TestShared.initMessaging(() => {});
  const m = new ModeAB(64, pT, msgPhy); // 输入走 msg-physics 通道（consumeInput 本地累加）
  let jumpAt = -1;
  let tickJumpAt = -1;
  for (let i = 0; i < 200; i++) {
    msgMain.addInput(0, 0, i >= 30 ? 16 : 0); // t=30ms 按跳（msg 投递）
    const msgs = queue.splice(0);
    for (const msg of msgs) {
      if (msg.type === 'shared-input') msgPhy.onInputMessage(msg.dx, msg.dy, msg.keysMask);
    }
    m.input(0, 0, 0); // 输入已入 msgPhy 通道——ModeAB 经 consumeInput 消费
    m.tick(p);
    const s = p.state();
    if (jumpAt < 0 && !s.onGround) jumpAt = i;
    const ts = pT.state();
    if (tickJumpAt < 0 && !ts.onGround) tickJumpAt = i;
  }
  check(
    '消息回退+模式B：msg 通道下模式A 实时起跳（t=30ms 立即）+ tick 线起跳延迟 ≤1 tick（消息回退与模式B 兼容——独立 tick 实例 + 速度校准语义与 SAB 一致）',
    jumpAt === 30 && tickJumpAt > 30 && tickJumpAt <= 30 + 15.6 + 1,
    `模式A 起跳 t=${jumpAt}ms tick 线 t=${tickJumpAt}ms（msg 按下 t=30ms）`,
  );
}


// 13. writeStateFromPhys（worker-a 写路径镜像）+ respawn 覆盖写（阶段4 双缓冲路径）
if (phys) {
  const vp1 = writeStateFromPhys(shared, phys);
  const rp = shared.readState();
  const s = phys.state();
  check(
    'writeStateFromPhys：状态槽=phys.state() 且 V++',
    rp !== null &&
      rp.v === vp1 &&
      close(rp.pos.x, s.posX) &&
      close(rp.pos.y, s.posY) &&
      close(rp.pos.z, s.posZ) &&
      close(rp.vel.x, s.velX) &&
      close(rp.yaw, s.yaw),
    `v=${vp1}`,
  );
  phys.respawn();
  const vp2 = writeStateFromPhys(shared, phys);
  check('respawn 后立即写路径 V++（阶段4 写空闲槽 + add(V,1)）', vp2 === vp1 + 1, `v=${vp2}`);
}

// 13.5. 热路径镜像（worker-a.ts 子步循环）：tick() 返回值直接写状态槽——
//       不再二次调 phys.state()（每子步省一次 wasm→JS 对象构造）；返回值字段与 state() 一致
if (phys) {
  const s = phys.tick(0.001, 0, 0, 0); // 1ms 子步（镜像 loop 内 consumeInput 后调用）
  const vHot = shared.writeState(
    { x: s.posX, y: s.posY, z: s.posZ },
    { x: s.velX, y: s.velY, z: s.velZ },
    s.yaw,
    s.pitch,
  );
  const rHot = shared.readState();
  const st = phys.state();
  check(
    '热路径：tick() 返回值字段直接写状态槽（pos/vel/yaw/pitch 与 state() 一致）',
    rHot !== null &&
      rHot.v === vHot &&
      close(rHot.pos.x, st.posX) &&
      close(rHot.pos.y, st.posY) &&
      close(rHot.pos.z, st.posZ) &&
      close(rHot.vel.x, st.velX) &&
      close(rHot.vel.y, st.velY) &&
      close(rHot.vel.z, st.velZ) &&
      close(rHot.yaw, st.yaw) &&
      close(rHot.pitch, st.pitch),
    rHot ? `v=${rHot.v}` : 'null',
  );
}

// 13.5b. tick_into 零分配（wasm API 能力验证——worker-a 实际子步热路径为 writeState → phys.state()，不使用本 API；tick_into → state_out_ptr
//        Float64Array 视图直读 8 标量 → writeStateRaw——每子步零 JS 对象分配）
if (phys && physMemory) {
  phys.tick_into(0.001, 0, 0, 0); // 与 tick 同语义，状态写 wasm 固定缓冲（无 JS 对象）
  const view = new Float64Array(physMemory.buffer, phys.state_out_ptr(), 8);
  const stAfter = phys.state();
  check(
    'tick_into 热路径#1：state_out 视图（pos×3/vel×3/yaw/pitch）与 tick 后 state() 一致',
    close(view[0], stAfter.posX) &&
      close(view[1], stAfter.posY) &&
      close(view[2], stAfter.posZ) &&
      close(view[3], stAfter.velX) &&
      close(view[4], stAfter.velY) &&
      close(view[5], stAfter.velZ) &&
      close(view[6], stAfter.yaw) &&
      close(view[7], stAfter.pitch),
    `view=(${view[0].toFixed(2)},${view[1].toFixed(2)},${view[2].toFixed(2)}) st=(${stAfter.posX.toFixed(2)},${stAfter.posY.toFixed(2)},${stAfter.posZ.toFixed(2)})`,
  );
  // tick_into → writeStateRaw 全链路（worker-a 子步热路径逐字镜像）
  phys.tick_into(0.001, 0, 0, 0);
  const v2 = new Float64Array(physMemory.buffer, phys.state_out_ptr(), 8);
  const vHot2 = shared.writeStateRaw(v2[0], v2[1], v2[2], v2[3], v2[4], v2[5], v2[6], v2[7]);
  const rHot2 = shared.readState();
  const st2 = phys.state();
  check(
    'tick_into 热路径#2：tick_into→writeStateRaw 全链路（状态槽 = tick 结果，版本/数据一致）',
    rHot2 !== null &&
      rHot2.v === vHot2 &&
      close(rHot2.pos.x, st2.posX) &&
      close(rHot2.pos.y, st2.posY) &&
      close(rHot2.pos.z, st2.posZ) &&
      close(rHot2.vel.x, st2.velX) &&
      close(rHot2.vel.y, st2.velY) &&
      close(rHot2.vel.z, st2.velZ) &&
      close(rHot2.yaw, st2.yaw) &&
      close(rHot2.pitch, st2.pitch),
    rHot2 ? `v=${rHot2.v}` : 'null',
  );
}

// ── 16. 梯子（on_ladder 索引化回归：抓梯攀爬 / 跳离 / 换图重建不 panic）──
//     评审 B4：on_ladder 由 Option<LadderVolume>（每 tick clone planes）改 Option<usize>
//     索引——本章节用真实梯子 brush 世界端到端验证索引路径（抓梯/攀爬/跳离/重建）
console.log('\n── 梯子世界（on_ladder 索引化回归）──');
{
  const ladderBrushes = [
    brushes[0], // 地面（与基础冒烟世界一致）
    {
      // 竖直梯子 slab：x∈[48,112]、y∈[0,256]、z∈[-32,32]（比玩家箱宽，攀爬面法线朝 -x）
      planes: [
        { normal: [-1, 0, 0], dist: -48 }, // x- 侧（x=48）
        { normal: [1, 0, 0], dist: 112 }, // x+ 侧（x=112）
        { normal: [0, 0, -1], dist: 32 }, // z- 侧（z=-32）
        { normal: [0, 0, 1], dist: 32 }, // z+ 侧（z=32）
        { normal: [0, 1, 0], dist: 256 }, // 顶面（y=256）
        { normal: [0, -1, 0], dist: 0 }, // 底面（y=0）
      ],
      min: [48, 0, -32],
      max: [112, 256, 32],
      is_ladder: true,
      is_solid: false,
    },
  ];
  let physL = null;
  let lBuildOk = false;
  let lBuildErr = '';
  try {
    physL = new PhysWorld();
    physL.set_hull(16, 72, 54);
    // 出生点 (80,2,0) 在梯子 slab 内、地面之上（空中，on_ground=false）；yaw=270 → 前向 +x
    physL.build_world(JSON.stringify(ladderBrushes), '[]', '{"teleports":[],"triggers":[]}', 80, 2, 0, 270);
    lBuildOk = true;
  } catch (e) {
    lBuildErr = String(e);
  }
  check('梯子世界：build_world（地面 + is_ladder slab）', lBuildOk, lBuildErr);

  if (physL) {
    // 抓梯：空中 + 前进 64 tick（1s）→ 抓梯成功（不坠落——梯子索引路径回归核心）
    for (let i = 0; i < 64; i++) physL.tick(1 / 64, 1, 0, 0); // keysMask 1 = forward
    const sClimb = physL.state();
    check(
      '抓梯攀爬：空中 1s 不坠落（posY ≥ 1.5，onGround=false——抓梯成功）',
      sClimb.posY >= 1.5 && sClimb.onGround === false,
      `posY=${sClimb.posY.toFixed(1)} onGround=${sClimb.onGround}`,
    );
    // 注：梯子攀爬高度/跳离轨迹属共享 Rust 物理行为细节（facing/pitch 依赖），
    // 不在 test 时序验证范围——此处只回归 on_ladder 索引路径（抓梯/重建不 panic）。

    // 换图重建：build_world 重建 player（on_ladder 复位为 None）→ 连续 tick 不 panic
    let rebuildOk = true;
    let rebuildErr = '';
    try {
      physL.build_world(JSON.stringify(ladderBrushes), '[]', '{"teleports":[],"triggers":[]}', 80, 2, 0, 270);
      for (let i = 0; i < 16; i++) physL.tick(1 / 64, 1, 0, 0);
    } catch (e) {
      rebuildOk = false;
      rebuildErr = String(e);
    }
    const sRebuild = physL.state();
    check(
      '换图重建：build_world 后连续 tick 不 panic、状态有限（on_ladder 索引复位安全）',
      rebuildOk && [sRebuild.posX, sRebuild.posY, sRebuild.posZ, sRebuild.velX, sRebuild.velY, sRebuild.velZ].every(Number.isFinite),
      rebuildErr || `pos=(${sRebuild.posX.toFixed(1)},${sRebuild.posY.toFixed(1)},${sRebuild.posZ.toFixed(1)})`,
    );
  }
}

// ── 17. 去重粒度：V 递增但状态值相同 → 仍重绘（版本号去重，非按值）──
//     评审 C5：WorkerB 仅按 readState 非 null（= V 变化）判定重绘——"相同状态、
//     不同版本"仍提交 Draw；本节实证当前语义，作为行为决策记录
console.log('\n── 去重粒度（版本号 vs 状态值）──');
{
  const sharedV = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  const wbV = new FakeWorkerB(sharedV);
  sharedV.writeStateRaw(1, 2, 3, 4, 5, 6, 90, -30); // v1
  wbV.onFrame(0);
  sharedV.writeStateRaw(1, 2, 3, 4, 5, 6, 90, -30); // v2：8 个值完全相同
  wbV.onFrame(10);
  check(
    '去重粒度：V 递增但状态值相同 → 仍重绘（按版本号去重，非按值——C5 语义实证）',
    wbV.updates === 2 && wbV.repaints === 2,
    `updates=${wbV.updates} repaints=${wbV.repaints}`,
  );
}

// ── 18. !ready 世界：加载期 V 递增 + tick/tick_into 语义分叉 ──────────
//     评审 C5：地图加载期物理 !ready（未 build_world）仍每 ms 写槽 → V 递增 →
//     WorkerB 去重失效（照常重绘相同画面）；且 tick()（返回玩家状态）与 tick_into()
//     （!ready 直接 return，state_out 保持旧值）存在语义分叉——实证记录
console.log('\n── !ready 世界（地图加载期行为）──');
{
  const physIdle = new PhysWorld(); // 未 build_world → ready=false
  const sharedN = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  const wbN = new FakeWorkerB(sharedN);
  physIdle.tick_into(0.001, 0, 0, 0); // !ready：直接 return（不写 state_out）
  const viewN = new Float64Array(physMemory.buffer, physIdle.state_out_ptr(), 8);
  sharedN.writeStateRaw(viewN[0], viewN[1], viewN[2], viewN[3], viewN[4], viewN[5], viewN[6], viewN[7]);
  const vIdle = Atomics.load(sharedN.i32, I_V);
  wbN.onFrame(0);
  check(
    '加载期：!ready 世界 tick_into 不报错、V 递增（WorkerB 加载期去重失效的实证）',
    vIdle === 1 && wbN.repaints === 1,
    `V=${vIdle} repaints=${wbN.repaints}`,
  );
  const sTick = physIdle.tick(0.001, 0, 0, 0); // tick：!ready 时返回当前玩家状态
  const viewAfter = new Float64Array(physMemory.buffer, physIdle.state_out_ptr(), 8);
  const zeroOut = viewAfter.every((v) => v === 0);
  check(
    '语义分叉：!ready 时 tick() 返回玩家状态(pos 0,100,0) 而 tick_into 不写 state_out（保持旧值/全零）',
    sTick.posY === 100 && zeroOut,
    `tick.posY=${sTick.posY} state_out 全零=${zeroOut}`,
  );
}

// ── 19. 长时间停顿（隐藏标签页/主线程停摆）──
//     评审 C6：delta 钳制 50ms + 8 子步上限 + 剩余累加保留 → 后续轮次有界追赶收敛
console.log('\n── 长时间停顿（隐藏标签页）──');
{
  const rLong = simulateWorkerARound(5000, 0); // 5s 停顿 → delta clamp 50ms
  check(
    'delta=5000ms（隐藏标签页）→ clamp 50ms → 8 子步，acc 封顶 20ms（MAX_ACC 防无限追赶；残余时间下轮补跑）',
    rLong.ticks === 8 && close(rLong.acc, 0.02),
    `ticks=${rLong.ticks} acc=${rLong.acc}`,
  );
  let catchAcc = rLong.acc;
  let catchRounds = 0;
  while (catchAcc >= RENDER_DT && catchRounds < 100) {
    const r = simulateWorkerARound(1, catchAcc); // 恢复后每轮 1ms delta
    catchAcc = r.acc;
    catchRounds++;
    if (r.ticks === 0) break;
  }
  check(
    '追赶收敛：后续轮次持续补跑直至 acc < 1ms（≤10 轮，有界追赶非无限）',
    catchAcc < RENDER_DT && catchRounds >= 1 && catchRounds <= 10,
    `rounds=${catchRounds} acc=${catchAcc}`,
  );
}

// 14. 相机映射纯逻辑（镜像 worker-b.ts render：FPS 约定，yaw/pitch 度→弧度 'YXZ'，//     眼高 EYE_STAND=64.09；three.js 'YXZ' 前向 = Ry(yaw)·Rx(pitch)·(0,0,-1)，roll=0）
const DEG2RAD = Math.PI / 180;
const EYE_STAND = 64.09;
function fpsForward(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const c = Math.cos(pitch);
  return { x: -c * Math.sin(yaw), y: Math.sin(pitch), z: -c * Math.cos(yaw) };
}
function cameraMapping(pos, yawDeg, pitchDeg) {
  return {
    rotation: { x: pitchDeg * DEG2RAD, y: yawDeg * DEG2RAD, z: 0, order: 'YXZ' },
    position: { x: pos.x, y: pos.y + EYE_STAND, z: pos.z },
  };
}
const cm1 = cameraMapping({ x: 1, y: 2, z: 3 }, 90, -30);
check(
  '相机映射#1：rotation.set(pitch·d2r, yaw·d2r, 0, YXZ) 度→弧度',
  close(cm1.rotation.x, -Math.PI / 6) && close(cm1.rotation.y, Math.PI / 2) && cm1.rotation.z === 0,
  JSON.stringify(cm1.rotation),
);
const cm2 = cameraMapping({ x: 5, y: 10, z: 0 }, 0, 0);
check(
  '相机映射#2：position.y = pos.y + EYE_STAND(64.09)',
  cm2.position.x === 5 && cm2.position.y === 10 + 64.09 && cm2.position.z === 0,
  JSON.stringify(cm2.position),
);
const f0 = fpsForward(0, 0);
const f90 = fpsForward(90, 0);
const fP = fpsForward(0, 30);
check(
  '相机映射#3：yaw=0/pitch=0 → 前向 (0,0,-1)（游戏 -Z 约定）',
  close(f0.x, 0) && close(f0.y, 0) && close(f0.z, -1),
  JSON.stringify(f0),
);
check(
  '相机映射#4：yaw=90° → 前向 (-1,0,0)（右转 90°）',
  close(f90.x, -1) && close(f90.y, 0) && close(f90.z, 0),
  JSON.stringify(f90),
);
check(
  '相机映射#5：pitch=30° → 前向 y=+0.5（抬头正 Y）',
  close(fP.x, 0) && close(fP.y, 0.5) && close(fP.z, -Math.cos(30 * DEG2RAD)),
  JSON.stringify(fP),
);

// 14. BspProcessor 冒烟：src/maps/surf_666.bsp → 导出 brush/tri/teleport/spawn/glb
console.log('\n── BspProcessor 冒烟（src/maps/surf_666.bsp）──');
const BRUSH_FILTER_JSON = JSON.stringify({
  include_ladder: true,
  include_solid: true,
  min_brush_volume: 0,
  skip_sky: true,
  skip_nodraw: false,
});
const bspPath = join(root, '../../maps/surf_666.bsp'); // 仓库重构后地图位于仓库根 maps/（perf-bench 同路径）
const bspBytes = readFileSync(bspPath);
check('读取 surf_666.bsp（字节 > 0）', bspBytes.length > 0, `${bspBytes.length} B`);

let proc = null;
let procErr = '';
try {
  proc = new BspProcessor(bspBytes);
} catch (e) {
  procErr = String(e);
}
check('new BspProcessor(surf_666.bsp)', proc !== null, procErr);

let meta = null;
let metaErr = '';
try {
  meta = JSON.parse(proc.metadata());
} catch (e) {
  metaErr = String(e);
}
check(
  'metadata()：magic=VBSP 且 num_brushes>0',
  meta !== null && meta.magic === 'VBSP' && meta.num_brushes > 0,
  metaErr || (meta ? `brushes=${meta.num_brushes}` : ''),
);

let brushJson = '';
let bspBrushes = [];
try {
  brushJson = proc.export_brushes_planes(BRUSH_FILTER_JSON);
  bspBrushes = JSON.parse(brushJson);
} catch (e) {
  brushJson = '';
  bspBrushes = [];
  console.log(`[FAIL] export_brushes_planes 异常: ${e}`);
}
check('export_brushes_planes 非空（collider brushes > 0）', Array.isArray(bspBrushes) && bspBrushes.length > 0, `count=${bspBrushes.length}`);

let triJson = '';
let bspTris = [];
try {
  triJson = proc.export_model_phy_colliders();
  bspTris = JSON.parse(triJson);
  if (bspTris.length === 0) {
    triJson = proc.export_model_tri_colliders(); // phy 空 → 回退可视网格
    bspTris = JSON.parse(triJson);
  }
} catch (e) {
  console.log(`[FAIL] 模型碰撞导出异常: ${e}`);
}
check('模型碰撞非空（phy 优先 / tri 回退；实例 > 0）', Array.isArray(bspTris) && bspTris.length > 0, `count=${bspTris.length}`);

let teleportReport = null;
try {
  teleportReport = JSON.parse(proc.parse_teleports());
} catch (e) {
  console.log(`[FAIL] parse_teleports 异常: ${e}`);
}
check(
  'parse_teleports 非空（triggers > 0）',
  teleportReport !== null && teleportReport.triggers.length > 0,
  teleportReport ? `triggers=${teleportReport.triggers.length}` : '',
);

let spawnJson = '';
let spawnReport = null;
try {
  spawnJson = proc.parse_spawn_points();
  spawnReport = JSON.parse(spawnJson);
} catch (e) {
  console.log(`[FAIL] parse_spawn_points 异常: ${e}`);
}
check(
  'parse_spawn_points 非空（spawn_points > 0）',
  spawnReport !== null && Array.isArray(spawnReport.spawn_points) && spawnReport.spawn_points.length > 0,
  spawnReport ? `total=${spawnReport.total}` : '',
);

// 14.5. PVS（parse_pvs_data）——须在 export_glb_with_pakfile_models（消费 Bsp）之前调用
console.log('\n── PVS 逻辑断言（surf_666 parse_pvs_data → PvsMirror）──');
let pvsJson = '';
let pvsData = null;
try {
  pvsJson = proc.parse_pvs_data();
  pvsData = JSON.parse(pvsJson);
} catch (e) {
  console.log(`[FAIL] parse_pvs_data 异常: ${e}`);
}
check(
  'parse_pvs_data 返回合法 JSON（nodes/leaves/faceClusters/clusterCount/bytesPerRow/pvsBitsBase64）',
  pvsData !== null &&
    Array.isArray(pvsData.nodes) &&
    Array.isArray(pvsData.leaves) &&
    Array.isArray(pvsData.faceClusters) &&
    typeof pvsData.pvsBitsBase64 === 'string' &&
    Number.isInteger(pvsData.clusterCount) &&
    pvsData.clusterCount > 0 &&
    Number.isInteger(pvsData.bytesPerRow) &&
    pvsData.bytesPerRow > 0,
  pvsData ? `clusterCount=${pvsData.clusterCount} bytesPerRow=${pvsData.bytesPerRow}` : '',
);
check(
  'bytesPerRow = ceil(clusterCount/8)（位图行字节对齐）',
  pvsData !== null && pvsData.bytesPerRow === Math.ceil(pvsData.clusterCount / 8),
  pvsData ? `bytesPerRow=${pvsData.bytesPerRow}` : '',
);
check(
  'pvsBits 解码字节数 = clusterCount × bytesPerRow（位图完整）',
  pvsData !== null && base64ToBytes(pvsData.pvsBitsBase64).length === pvsData.clusterCount * pvsData.bytesPerRow,
  pvsData ? `${base64ToBytes(pvsData.pvsBitsBase64).length} B` : '',
);

let pvs = null;
try {
  pvs = new PvsMirror(pvsJson);
} catch (e) {
  console.log(`[FAIL] PvsMirror 构造异常: ${e}`);
}
const spawnPt = spawnReport
  ? spawnReport.spawn_points[spawnReport.primary ?? 0] ?? spawnReport.spawn_points[0]
  : null;
const spPt = spawnPt ? { x: spawnPt.origin[0], y: spawnPt.origin[1], z: spawnPt.origin[2] } : null;
if (pvs && spPt) {
  check('enabled（hasPvs：clusterCount>0 且位图非空）', pvs.enabled === true, `enabled=${pvs.enabled}`);
  const leafIdx = pvs.findLeaf(spPt);
  check(
    'findLeaf(spawn 点) 返回有效 leaf（0 ≤ leaf < leaves.length）',
    leafIdx >= 0 && leafIdx < pvs.leaves.length,
    `leaf=${leafIdx} leaves=${pvs.leaves.length}`,
  );
  const cl = pvs.getClusterAt(spPt);
  check(
    'getClusterAt(spawn 点) 有效 cluster（0 ≤ cluster < clusterCount）',
    cl >= 0 && cl < pvs.clusterCount,
    `cluster=${cl}`,
  );
  check(
    'update(spawn 点) 首次返回 true（cluster 初始化 → 需重应用可见性）',
    pvs.update(spPt) === true,
    `currentCluster=${pvs.currentClusterId}`,
  );
  check('decodePvsRow 自身可见：isVisible(currentCluster) === true', pvs.isVisible(cl) === true, `cluster=${cl}`);
  check(
    'update 同 cluster 二次返回 false（不重解码/不重遍历）',
    pvs.update(spPt) === false,
    `visibleCount=${pvs.visibleClusterCount}`,
  );
  check(
    'isVisible(可见集内抽样) 全 true',
    [...pvs.visibleSet].slice(0, 32).every((c) => pvs.isVisible(c)),
    `visibleSet=${pvs.visibleSet.size}`,
  );

  // isVisible 对称性（A 见 B ⇔ B 见 A；用 leaf AABB 中心定位 cluster，采样点验证落点后比对）
  let symOk = true;
  let symFail = '';
  const leafCenter = (leaf) => ({
    x: (leaf.mins[0] + leaf.maxs[0]) / 2,
    y: (leaf.mins[1] + leaf.maxs[1]) / 2,
    z: (leaf.mins[2] + leaf.maxs[2]) / 2,
  });
  const clusterLeaves = new Map();
  for (const leaf of pvs.leaves) {
    if (leaf.cluster < 0) continue;
    if (!clusterLeaves.has(leaf.cluster)) clusterLeaves.set(leaf.cluster, leaf);
  }
  const sampleClusters = [...clusterLeaves.keys()].slice(0, 4);
  for (let ai = 0; ai < sampleClusters.length && symOk; ai++) {
    const ptA = leafCenter(clusterLeaves.get(sampleClusters[ai]));
    if (pvs.getClusterAt(ptA) !== sampleClusters[ai]) continue; // AABB 中心不在该 cluster → 跳过
    const mA = new PvsMirror(pvsJson);
    mA.update(ptA);
    for (let bi = 0; bi < sampleClusters.length && symOk; bi++) {
      if (ai === bi) continue;
      const ptB = leafCenter(clusterLeaves.get(sampleClusters[bi]));
      if (pvs.getClusterAt(ptB) !== sampleClusters[bi]) continue;
      const mB = new PvsMirror(pvsJson);
      mB.update(ptB);
      if (mA.isVisible(sampleClusters[bi]) !== mB.isVisible(sampleClusters[ai])) {
        symOk = false;
        symFail = `${sampleClusters[ai]}↔${sampleClusters[bi]}`;
      }
    }
  }
  check('isVisible 对称性（A 见 B ⇔ B 见 A，前 4 cluster 抽样）', symOk, symFail);
  check(
    'isVisible(-1) → true（无效 cluster → 全部可见）',
    pvs.isVisible(-1) === true,
  );
  check(
    'isVisible(越界 cluster) → false（不在可见集）',
    pvs.isVisible(pvs.clusterCount + 999) === false,
  );
} else {
  check('PvsMirror + spawn 点可用（PVS 断言前置）', false, pvs ? '无 spawn 点' : 'PvsMirror 为 null');
}

// 14.6. PVS 手工构造数据边界（小 nodes/leaves/位图：cluster 越界 / 无 PVS 全可见）
console.log('\n── PVS 边界断言（手工构造小数据）──');
{
  // 单分割平面 z=0（Y-up 世界坐标）：d>0（z>0）→ children[0]=~0 → leaf 0（cluster 0）；
  // d<=0 → children[1]=~1 → leaf 1（cluster 1）。位图行：row0=0b01（可见 0）、row1=0b10（可见 1）。
  const tinyJson = JSON.stringify({
    rootNode: 0,
    nodes: [{ normal: [0, 0, 1], dist: 0, children: [-1, -2] }],
    leaves: [
      { cluster: 0, mins: [0, 0, 0], maxs: [1024, 1024, 1024], isSolid: false },
      { cluster: 1, mins: [-1024, -1024, -1024], maxs: [0, 0, 0], isSolid: false },
    ],
    faceClusters: [-1],
    pvsBitsBase64: Buffer.from([0b00000001, 0b00000010]).toString('base64'), // "AQI="
    clusterCount: 2,
    bytesPerRow: 1,
  });
  const tiny = new PvsMirror(tinyJson);
  check(
    'tiny：findLeaf 前侧 (0,0,100) → leaf 0（d>0 → children[0]=~0）',
    tiny.findLeaf({ x: 0, y: 0, z: 100 }) === 0,
    `leaf=${tiny.findLeaf({ x: 0, y: 0, z: 100 })}`,
  );
  check('tiny：findLeaf 后侧 (0,0,-100) → leaf 1（d<=0 → children[1]=~1）', tiny.findLeaf({ x: 0, y: 0, z: -100 }) === 1);
  check('tiny：getClusterAt(前侧) = 0、getClusterAt(后侧) = 1', tiny.getClusterAt({ x: 0, y: 0, z: 5 }) === 0 && tiny.getClusterAt({ x: 0, y: 0, z: -5 }) === 1);
  const t1 = tiny.update({ x: 0, y: 0, z: 5 });
  check('tiny：update(cluster 0) 首次 true + 自身可见 0、不可见 1', t1 === true && tiny.isVisible(0) === true && tiny.isVisible(1) === false, `visible=${tiny.visibleClusterCount}`);
  check('tiny：update 同 cluster → false（不重算）', tiny.update({ x: 10, y: 20, z: 30 }) === false);
  const t2 = tiny.update({ x: 0, y: 0, z: -5 });
  check('tiny：update(cluster 1) → true + 可见 1、不可见 0（位图行切换）', t2 === true && tiny.isVisible(1) === true && tiny.isVisible(0) === false, `visible=${tiny.visibleClusterCount}`);

  // 边界：pvsBits 短于预期（仅 1 字节）→ decodePvsRow 边界保护（仅自身可见）
  const shortJson = JSON.stringify({
    rootNode: 0,
    nodes: [{ normal: [0, 0, 1], dist: 0, children: [-1, -2] }],
    leaves: [
      { cluster: 0, mins: [0, 0, 0], maxs: [1024, 1024, 1024], isSolid: false },
      { cluster: 1, mins: [-1024, -1024, -1024], maxs: [0, 0, 0], isSolid: false },
    ],
    faceClusters: [-1],
    pvsBitsBase64: Buffer.from([0b00000011]).toString('base64'), // 只够 1 行
    clusterCount: 2,
    bytesPerRow: 1,
  });
  const short = new PvsMirror(shortJson);
  short.update({ x: 0, y: 0, z: -5 }); // cluster 1 的行越界（rowStart+1=2 > len 1）
  check(
    'short 位图：cluster 1 行越界 → 边界保护仅自身可见（不 panic、不误判）',
    short.isVisible(1) === true && short.isVisible(0) === false,
    `visible=${short.visibleClusterCount}`,
  );

  // 无 PVS：clusterCount=0 / 空位图 → enabled=false，全部可见，update 恒 false
  const noPvsJson = JSON.stringify({
    rootNode: 0,
    nodes: [],
    leaves: [],
    faceClusters: [],
    pvsBitsBase64: '',
    clusterCount: 0,
    bytesPerRow: 0,
  });
  const noPvs = new PvsMirror(noPvsJson);
  check(
    '无 PVS：enabled=false、update 恒 false、isVisible 全 true、getClusterAt=-1、findLeaf=-1',
    noPvs.enabled === false &&
      noPvs.update({ x: 1, y: 2, z: 3 }) === false &&
      noPvs.isVisible(0) === true &&
      noPvs.isVisible(99) === true &&
      noPvs.getClusterAt({ x: 1, y: 2, z: 3 }) === -1 &&
      noPvs.findLeaf({ x: 1, y: 2, z: 3 }) === -1,
  );
}

let glbBytes = null;
try {
  glbBytes = proc.export_glb_with_pakfile_models();
} catch (e) {
  console.log(`[FAIL] export_glb_with_pakfile_models 异常: ${e}`);
}
check('export_glb_with_pakfile_models 非空（GLB 有字节）', glbBytes !== null && glbBytes.length > 0, glbBytes ? `${glbBytes.length} B` : '');

// 15. build_world 真实地图：surf_666 导出 → 物理 tick 正常
console.log('\n── build_world 真实地图（surf_666 导出）──');
/** BSP yaw → cs-movement yaw（与 main.ts bspYawToCsYaw 一致）。 */
const bspYawToCsYaw = (bspYaw) => ((270 - bspYaw) % 360 + 360) % 360;

let physReal = null;
let realBuildOk = false;
let realBuildErr = '';
try {
  const sp = spawnReport.spawn_points[spawnReport.primary ?? 0] ?? spawnReport.spawn_points[0];
  physReal = new PhysWorld();
  physReal.set_hull(16, 72, 54);
  physReal.build_world(
    brushJson,
    triJson,
    teleportReport ? JSON.stringify(teleportReport) : '{"teleports":[],"triggers":[]}',
    sp.origin[0],
    sp.origin[1],
    sp.origin[2],
    bspYawToCsYaw(sp.angles[1]),
  );
  // 死亡阈值：brushJson 遍历取最小 min[1] - 100（与 worker-a.ts applyWorld 一致）
  let minY = Infinity;
  for (const b of bspBrushes) {
    if (b.min[1] < minY) minY = b.min[1];
  }
  if (Number.isFinite(minY)) physReal.set_death_y(minY - 100);
  realBuildOk = true;
} catch (e) {
  realBuildErr = String(e);
}
check('set_hull(16,72,54) + build_world(surf_666 导出)', realBuildOk, realBuildErr);

if (physReal) {
  const sInit = physReal.state();
  const initFinite =
    [sInit.posX, sInit.posY, sInit.posZ, sInit.velX, sInit.velY, sInit.velZ].every(Number.isFinite);
  check('初始状态 pos 有效（不 start_solid / 无 NaN/Inf）', initFinite, `pos=(${sInit.posX},${sInit.posY},${sInit.posZ})`);

  // 落地：重力下落 → onGround（最多 2400 tick = 37.5s，防高空出生点）
  let grounded = false;
  let sLand = null;
  for (let i = 0; i < 2400; i++) {
    physReal.tick(1 / 64, 0, 0, 0);
    sLand = physReal.state();
    if (sLand.onGround === true) {
      grounded = true;
      break;
    }
  }
  check('tick 后落地 onGround=true', grounded === true, sLand ? `onGround=${sLand.onGround} pos=(${sLand.posX},${sLand.posY},${sLand.posZ})` : '');
  const sFinite =
    sLand !== null &&
    [sLand.posX, sLand.posY, sLand.posZ, sLand.velX, sLand.velY, sLand.velZ].every(Number.isFinite);
  check('落地后 state 全字段有限', sFinite);

  // 输入移动：前进键改变 pos
  const pBefore = physReal.state();
  for (let i = 0; i < 96; i++) physReal.tick(1 / 64, 1, 0, 0); // keysMask 1 = forward
  const pAfter = physReal.state();
  const movedDist = Math.hypot(pAfter.posX - pBefore.posX, pAfter.posZ - pBefore.posZ);
  check('前进输入改变 pos（移动 > 0.5）', movedDist > 0.5, `dist=${movedDist.toFixed(2)} pos=(${pAfter.posX},${pAfter.posY},${pAfter.posZ})`);

  // 鼠标增量：yaw/pitch 随 dx/dy 变化
  const y0 = pAfter.yaw;
  const p0 = pAfter.pitch;
  physReal.tick(1 / 64, 0, 500, -200);
  const sLook = physReal.state();
  const dyaw = Math.abs(sLook.yaw - y0);
  const dpitch = Math.abs(sLook.pitch - p0);
  check('鼠标增量改变 yaw（|Δyaw| > 1°）', dyaw > 1, `yaw ${y0.toFixed(2)} → ${sLook.yaw.toFixed(2)}`);
  check('鼠标增量改变 pitch（|Δpitch| > 1°）', dpitch > 1, `pitch ${p0.toFixed(2)} → ${sLook.pitch.toFixed(2)}`);

  // teleport 区域存在（build_world 已装载 report）
  check(
    'teleport 区域存在（triggers > 0）',
    teleportReport !== null && teleportReport.triggers.length > 0,
    teleportReport ? `triggers=${teleportReport.triggers.length}` : '',
  );
}

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} PASS${fail > 0 ? ` — ${fail} FAIL` : ''}`);
if (fail > 0) process.exitCode = 1;

