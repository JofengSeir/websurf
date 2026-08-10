#!/usr/bin/env node
/**
 * WebSurf-test — WorkerA 单模物理核心冒烟测试（node 可跑，不依赖 DOM/Worker）。
 *
 * 用法：node scripts/phys-smoke.mjs
 *
 * 在 node 环境模拟最新时序图核心逻辑（与 test/src/shared-state.ts / worker-a.ts
 * / worker-b.ts 镜像）：
 * - 世界构建/落地/跳跃/respawn 基本物理断言（PhysWorld wasm）
 * - 双缓冲：writeState 写空闲槽（S[V&1^1]）→ readState 读当前槽 S[V&1]（交替正确）
 * - V 递增用 add（写 N 次 → V 增 N）
 * - WAKEUP 协议：wake() 后 waitWakeup 立即返回（被唤醒）；无 wake 时 wait 超时返回；
 *   阶段0 writeTickRate 仅 store（不影响 WAKEUP）
 * - 8 次子步上限：一次大 delta（如 20ms）→ 物理最多 8 个子步（模拟 loop 上限断言）
 * - 输入限幅：consumeInput(clamp) 超限值被截断（±1000 防穿墙）
 * - 抽帧逻辑（模拟 WorkerB 最终时序）：本地副本唯一参数源 = readState（参数永远最新）；
 *   Draw 间隔 = 1/TICK_RATE（rate>0 限频；rate=0 每 frame 都 Draw）
 * - 模式B 不写共享槽（用户定调：共享槽只由模式A 写——模式B 只做 phys 内部速度修正，
 *   V 不递增、readState 返回 null）
 *
 * 注：node 无 TS 加载器，TestShared 与 brush JSON 在此复制镜像（与 shared-state.ts
 * / worker-a.ts 逐字一致；改动须同步）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// [6]keysMask [8]V；双缓冲 Float64 索引 [5..12]（槽0）/[13..20]（槽1）pos/vel/yaw/pitch；
// FIXED_SCALE=1000；SHARED_BUFFER_SIZE=192
// ★ 布局回归：BigInt64 索引 1/2（字节 8..15/16..23），勿用 2/4——
//   B64 索引 4 = 字节 32..39 与 V（Int32 8，字节 32..35）重叠（历史屏闪 bug）
const I_TICK_RATE = 0;
const I_WAKEUP = 1;
const B_DX_ACC = 1;
const B_DY_ACC = 2;
const I_KEYS_MASK = 6;
const I_V = 8;
const F_SLOT_BASE = 5;
const F_SLOT_STRIDE = 8;
const FIXED_SCALE = 1000;
const SHARED_BUFFER_SIZE = 192;

class TestShared {
  constructor(buf) {
    this.i32 = new Int32Array(buf);
    this.b64 = new BigInt64Array(buf);
    this.f64 = new Float64Array(buf);
    this.lastV = 0;
  }
  get sab() {
    return this.i32.buffer;
  }
  writeTickRate(rate) {
    // 阶段0：仅 store，无 notify
    Atomics.store(this.i32, I_TICK_RATE, rate);
  }
  readTickRate() {
    return Atomics.load(this.i32, I_TICK_RATE);
  }
  wake() {
    // 阶段1：store(WAKEUP,1) + notify(WAKEUP,1)
    Atomics.store(this.i32, I_WAKEUP, 1);
    Atomics.notify(this.i32, I_WAKEUP, 1);
  }
  waitWakeup(timeoutMs) {
    const res = Atomics.wait(this.i32, I_WAKEUP, 0, timeoutMs);
    Atomics.store(this.i32, I_WAKEUP, 0);
    return res === 'ok' || res === 'not-equal';
  }
  addInput(dx, dy, keysMask) {
    const dxFixed = BigInt(Math.round(dx * FIXED_SCALE));
    const dyFixed = BigInt(Math.round(dy * FIXED_SCALE));
    if (dxFixed !== 0n) Atomics.add(this.b64, B_DX_ACC, dxFixed);
    if (dyFixed !== 0n) Atomics.add(this.b64, B_DY_ACC, dyFixed);
    Atomics.store(this.i32, I_KEYS_MASK, keysMask);
  }
  consumeInput(maxDelta = Infinity) {
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
    // 双缓冲：写空闲槽（S[V&1^1]）→ Atomics.add(V,1)
    const v0 = Atomics.load(this.i32, I_V);
    const base = F_SLOT_BASE + ((v0 & 1) ^ 1) * F_SLOT_STRIDE;
    const f = this.f64;
    f[base] = pos.x;
    f[base + 1] = pos.y;
    f[base + 2] = pos.z;
    f[base + 3] = vel.x;
    f[base + 4] = vel.y;
    f[base + 5] = vel.z;
    f[base + 6] = yaw;
    f[base + 7] = pitch;
    return Atomics.add(this.i32, I_V, 1) + 1;
  }
  readState() {
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

// ── WorkerA 单模循环核心镜像（worker-a.ts loop：delta clamp + 累加器 + 8 次上限）──
// 返回 { ticks: 本轮执行的子步数, acc: 残留累加器（秒） }
const RENDER_DT = 0.001;
const MAX_DELTA = 0.05;
const MAX_STEPS_PER_ROUND = 8;
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
      // 真实循环：consumeInput(±1000) → phys.tick(1ms) → writeState（写空闲槽 + V add）
    }
    if (acc >= RENDER_DT) acc = 0; // 8 次上限耗尽：丢弃剩余（防死亡螺旋）
  }
  return { ticks, acc };
}

// ── WorkerB 帧逻辑镜像（worker-b.ts onFrame 最终时序：本地副本唯一参数源 = readState，
//    每帧消息都绘制——渲染帧率不被 TICK_RATE 限制，与 game 一致）──
class FakeWorkerB {
  constructor(shared) {
    this.shared = shared;
    this.localCopy = null; // 唯一渲染参数源（只被 readState 更新——真理源）
    this.updates = 0; // 本地副本被 readState 刷新次数
    this.repaints = 0; // 实际 Draw 次数
  }
  onFrame(_now) {
    const state = this.shared.readState(); // ① 非阻塞；V 更新→读最新槽（无撕裂），未变→null
    if (state) {
      this.localCopy = state; // ② 本地副本只被 readState 更新（无其他来源——渲染参数零污染）
      this.updates++;
    }
    // ③ 每帧消息都绘制（无 Draw 间隔——TICK_RATE 只影响 WorkerA 手感，不限制渲染帧率）
    if (this.localCopy) this.repaints++;
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
try {
  initSync({ module: readFileSync(join(root, 'pkg', 'websurf_test_wasm_bg.wasm')) });
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
shared.wake(); // store(WAKEUP,1) + notify(WAKEUP,1)
const w1 = shared.waitWakeup(100);
const dtW1 = performance.now() - t0;
check('wake() 后 waitWakeup 立即返回 true（被唤醒，not-equal）', w1 === true && dtW1 < 20, `res=${w1} dt=${dtW1.toFixed(2)}ms`);
check('waitWakeup 返回后 WAKEUP 复位为 0', Atomics.load(shared.i32, I_WAKEUP) === 0);
const t1 = performance.now();
const w2 = shared.waitWakeup(30); // 无 wake：挂起直到超时
const dtW2 = performance.now() - t1;
check('无 wake：waitWakeup(30) 超时返回 false', w2 === false && dtW2 >= 20, `res=${w2} dt=${dtW2.toFixed(2)}ms`);
check('超时返回后 WAKEUP 仍为 0', Atomics.load(shared.i32, I_WAKEUP) === 0);

// 9. 阶段0 writeTickRate 仅 store（无 notify，不影响 WAKEUP）
shared.writeTickRate(128);
check(
  'writeTickRate(128)：TICK_RATE=128 且 WAKEUP 未被置位（仅 store 无 notify）',
  shared.readTickRate() === 128 && Atomics.load(shared.i32, I_WAKEUP) === 0,
  `TICK_RATE=${shared.readTickRate()} WAKEUP=${Atomics.load(shared.i32, I_WAKEUP)}`,
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

// 11. 8 次子步上限：一次大 delta → 物理最多 8 个子步（模拟 loop 上限断言）
const rBig = simulateWorkerARound(20, 0); // 20ms 大 delta
check('delta=20ms：单轮最多 8 个子步', rBig.ticks === 8, `ticks=${rBig.ticks}`);
check('8 次上限耗尽：丢弃剩余累加（防死亡螺旋）', rBig.acc < RENDER_DT, `acc=${rBig.acc}`);
const rBig2 = simulateWorkerARound(20, 0.0004); // 20ms + 残留 0.4ms
check('delta=20ms + 残留 0.4ms：仍 8 次', rBig2.ticks === 8, `ticks=${rBig2.ticks}`);
const rMid = simulateWorkerARound(5, 0.0003); // 5.3ms → 5 步
check('delta=5ms + 残留 0.3ms：5 个子步', rMid.ticks === 5, `ticks=${rMid.ticks}`);
const rSmall = simulateWorkerARound(0.3, 0); // 0.3ms < 1ms
check('delta=0.3ms < 1ms：0 个子步（纯累加）', rSmall.ticks === 0 && close(rSmall.acc, 0.0003), `ticks=${rSmall.ticks} acc=${rSmall.acc}`);
const rClamp = simulateWorkerARound(200, 0); // 200ms → clamp 50ms → 8 次
check('delta=200ms → clamp 50ms：仍 8 次', rClamp.ticks === 8, `ticks=${rClamp.ticks}`);

// 12. 渲染采样与抽帧逻辑（模拟 WorkerB 最终时序：本地副本唯一参数源 = readState，
//     Draw 间隔 = 1/TICK_RATE——rate>0 限频抽帧、rate=0 每 frame 都 Draw）
// 12a. TICK_RATE=0（默认）→ 每 frame 都 Draw（无抽帧），参数跟随 V 永远最新
const sharedB = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
const wb = new FakeWorkerB(sharedB); // TICK_RATE 默认 0 → 每 frame 都 Draw
sharedB.writeState({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0); // v1
wb.onFrame(0); // 首帧：V 更新 → 本地副本=v1 + Draw
check(
  '渲染#1：首帧 V 更新 → 本地副本=v1 + Draw（参数来源仅 readState）',
  wb.localCopy !== null && wb.localCopy.v === 1 && wb.updates === 1 && wb.repaints === 1,
  `updates=${wb.updates} repaints=${wb.repaints}`,
);
sharedB.writeState({ x: 5, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 0, 0); // v2
wb.onFrame(10); // V 更新 → 本地副本立即=v2 + Draw（rate=0 无抽帧——参数永远最新）
check(
  '渲染#2：V 更新 → 本地副本立即=v2 + Draw（rate=0 每 frame 都 Draw）',
  wb.localCopy !== null && wb.localCopy.v === 2 && wb.updates === 2 && wb.repaints === 2,
  `target=${wb.localCopy ? wb.localCopy.v : null} updates=${wb.updates}`,
);
wb.onFrame(20); // V 未变 → 本地副本复用 v2（无其他来源），rate=0 仍每 frame Draw
check(
  '渲染#3：V 未变 → 本地副本复用 v2（参数零污染），rate=0 仍每 frame Draw',
  wb.localCopy.v === 2 && wb.updates === 2 && wb.repaints === 3,
  `updates=${wb.updates} repaints=${wb.repaints}`,
);
sharedB.writeState({ x: 9, y: 0, z: 9 }, { x: 0, y: 0, z: 0 }, 0, 0); // v3
wb.onFrame(30); // V 更新 → 本地副本=v3 + Draw
check(
  '渲染#4：V 更新 → 本地副本=v3 + Draw（参数永远最新真理源）',
  wb.localCopy.v === 3 && wb.updates === 3 && wb.repaints === 4,
  `target=${wb.localCopy.v} updates=${wb.updates}`,
);
wb.onFrame(40); // V 未变
check(
  '渲染#5：V 未变 → 本地副本保持非 null（首帧竞争不回落）',
  wb.localCopy !== null && wb.localCopy.v === 3 && wb.updates === 3,
  `target=${wb.localCopy ? wb.localCopy.v : null}`,
);

// 12b. TICK_RATE=64 → 渲染帧率不被限制：每 frame 消息都 Draw（TICK_RATE 只影响 WorkerA 手感）
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
wbC.onFrame(1005); // V 更新 → 本地副本=v2 + Draw（每 frame——与 game 每 rAF 渲染一致）
check(
  '渲染高帧#2：V 更新 → 本地副本=v2 + Draw（参数永远最新，每 frame 都绘制）',
  wbC.localCopy !== null && wbC.localCopy.v === 2 && wbC.updates === 2 && wbC.repaints === 2,
  `target=${wbC.localCopy ? wbC.localCopy.v : null} repaints=${wbC.repaints}`,
);
wbC.onFrame(1010); // V 未变 → 本地副本复用 v2 + 仍每 frame Draw（渲染不因 tick 限频）
check(
  '渲染高帧#3：V 未变 → 复用 v2 + 每 frame Draw（渲染帧率 = frame 消息频率）',
  wbC.localCopy.v === 2 && wbC.updates === 2 && wbC.repaints === 3,
  `updates=${wbC.updates} repaints=${wbC.repaints}`,
);
sharedC.writeState({ x: 9, y: 0, z: 9 }, { x: 0, y: 0, z: 0 }, 0, 0); // v3
wbC.onFrame(1015); // V 更新 → v3 + Draw
check(
  '渲染高帧#4：V 更新 → 本地副本=v3 + Draw（渲染参数唯一来自真理源，永不限频）',
  wbC.localCopy.v === 3 && wbC.updates === 3 && wbC.repaints === 4,
  `target=${wbC.localCopy.v} updates=${wbC.updates}`,
);

// 12.5 模式B 只做速度修正（worker-a 镜像：TICK_RATE 只影响手感——粗糙步长覆盖 phys 内部
//      速度向量、位置/角度恢复模式A 真理源快照；★ 不 writeState——共享状态槽只由模式A 写，
//      渲染参数零污染）
if (phys) {
  const sharedC = new TestShared(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
  sharedC.writeTickRate(64); // 难度手感 64 tick
  // 先模式A 推进若干 1ms 子步，记快照
  for (let i = 0; i < 5; i++) phys.tick(0.001, 0, 0, 0);
  const before = phys.state();
  const posBefore = { x: before.posX, y: before.posY, z: before.posZ };
  const vBefore = Atomics.load(sharedC.i32, I_V); // 模式B 执行前的共享槽版本
  // 模式B（worker-a 镜像）：tickRate>0 → loAcc 累积 → 粗糙 tick → 只覆盖 phys 内部速度
  const tickDt = 1 / 64;
  const inpB = sharedC.consumeInput(1000); // 模式B 同样 CAS 消费输入（限幅 ±1000）
  const a = phys.state(); // 快照真理源当前状态
  phys.tick(tickDt, inpB.keysMask, inpB.dx, inpB.dy); // 粗糙 tick（步长 = 1/TICK_RATE）
  const rough = phys.state(); // 粗糙结果（粗糙速度）
  // 只做速度修正：恢复位置/角度为真理源（a），保留粗糙速度（手感 = 难度）
  phys.set_state(a.posX, a.posY, a.posZ, a.yaw, a.pitch, rough.velX, rough.velY, rough.velZ, rough.onGround);
  const after = phys.state();
  check(
    '模式B 速度修正：位置/角度恢复为真理源快照（未双重推进）',
    close(after.posX, posBefore.x) &&
      close(after.posY, posBefore.y) &&
      close(after.posZ, posBefore.z) &&
      close(after.yaw, before.yaw) &&
      close(after.pitch, before.pitch),
    `pos=(${after.posX.toFixed(2)},${after.posY.toFixed(2)},${after.posZ.toFixed(2)}) yaw=${after.yaw.toFixed(2)}`,
  );
  check(
    '模式B 速度修正：速度被粗糙步长覆盖（手感 = 难度）',
    close(after.velX, rough.velX) && close(after.velY, rough.velY) && close(after.velZ, rough.velZ),
    `vel=(${after.velX.toFixed(2)},${after.velY.toFixed(2)},${after.velZ.toFixed(2)})`,
  );
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

// 14. 相机映射纯逻辑（镜像 worker-b.ts render：FPS 约定，yaw/pitch 度→弧度 'YXZ'，
//     眼高 EYE_STAND=64.09；three.js 'YXZ' 前向 = Ry(yaw)·Rx(pitch)·(0,0,-1)，roll=0）
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
const bspPath = join(root, '../src/maps/surf_666.bsp');
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
