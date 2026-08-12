/**
 * mini — WorkerA 物理循环（架构与 test/src/worker-a.ts 一致，物理用轻量运动学演示）
 *
 * 架构对齐点（mini 保留完整版核心结构）：
 * - 独立 Worker 线程：主线程仅输入转发/UI → 本线程是**物理真理源**（唯一状态槽写入者）
 * - 双模循环（阶段2）：**先 tick 计算**（模式B 独立步长，可选）→ **后无限制计算**
 *   （1ms 子步 + 实时输入）——位置/角度只由无限制模式推进
 * - 1ms 子步：每轮最多 maxStepsPerRound 步（防无限追赶）
 * - 背压：waitWakeup(WAKEUP 槽) 挂起（主线程 rAF 唤醒，可提前唤醒）
 * - 状态发布：writeStateRaw 写空闲槽 → V++（add）——WorkerB 只读
 *
 * **全部可调参数来自 init 消息携带的 config（src/config.js 单一来源）**——
 * 物理参数（速度/加速度/重力/灵敏度/子步长等）零硬编码，改参数不碰本文件。
 */

import { TestShared, KEY_MASK } from './shared-state.js';

let shared = null;
let P = null; // config.phys 参数集（init 后注入）

// 物理状态（本线程真理源）
let pos = { x: 0, y: 0, z: 0 };
let vel = { x: 0, y: 0, z: 0 };
let yaw = 0;
let pitch = 0;
let onGround = false;

// tick 独立实例（模式B：独立步长推进 + 速度校准——与完整版双实例语义一致）
let tickState = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  onGround: false,
};

let acc = 0;
let loAcc = 0;
let tickDxAcc = 0;
let tickDyAcc = 0;
let modeBWasActive = false;
let lastNow = performance.now();

function writeStateFromPhys() {
  shared.writeStateRaw(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, yaw, pitch);
}

function alignTickPhys() {
  tickState = {
    pos: { ...pos },
    vel: { ...vel },
    yaw,
    pitch,
    onGround,
  };
}

function tickDiverged() {
  const dx = pos.x - tickState.pos.x;
  const dy = pos.y - tickState.pos.y;
  const dz = pos.z - tickState.pos.z;
  return dx * dx + dy * dy + dz * dz > P.tickAnchorDist * P.tickAnchorDist;
}

/** 运动学一步（renderDt 子步；真实版为 wasm PhysWorld.tick）。 */
function stepPhysics(dt, keysMask, dx, dy) {
  // 视角转向（鼠标增量 → yaw/pitch；FPS 约定）
  yaw -= dx * P.sensitivity;
  pitch -= dy * P.sensitivity;
  const pc = P.pitchClamp;
  if (pitch > pc) pitch = pc;
  if (pitch < -pc) pitch = -pc;
  yaw = ((yaw % 360) + 360) % 360;

  // 平面移动（相对 yaw 方向：forward 朝向 -Z 旋转 yaw，与 FPS 相机一致）
  const yawRad = (yaw * Math.PI) / 180;
  const sinY = Math.sin(yawRad);
  const cosY = Math.cos(yawRad);
  let ax = 0;
  let az = 0;
  if (keysMask & KEY_MASK.forward) {
    ax -= sinY * P.accel;
    az -= cosY * P.accel;
  }
  if (keysMask & KEY_MASK.backward) {
    ax += sinY * P.accel;
    az += cosY * P.accel;
  }
  if (keysMask & KEY_MASK.left) {
    ax -= cosY * P.accel;
    az += sinY * P.accel;
  }
  if (keysMask & KEY_MASK.right) {
    ax += cosY * P.accel;
    az -= sinY * P.accel;
  }
  vel.x += ax * dt;
  vel.z += az * dt;

  // 平面速度钳制（moveSpeed 上限）
  const hSpeed = Math.hypot(vel.x, vel.z);
  if (hSpeed > P.moveSpeed) {
    vel.x = (vel.x / hSpeed) * P.moveSpeed;
    vel.z = (vel.z / hSpeed) * P.moveSpeed;
  }

  // 跳跃 + 重力
  if ((keysMask & KEY_MASK.jump) && onGround) {
    vel.y = P.jumpVel;
    onGround = false;
  }
  vel.y -= P.gravity * dt;

  // 积分
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;

  // 地板（y=0 平面）
  if (pos.y <= 0) {
    pos.y = 0;
    vel.y = 0;
    onGround = true;
  }
}

/** tick 独立实例一步（模式B：64t 网格离散演化 + 速度校准——与完整版 tickPhys 一致）。 */
function stepTickPhys(dt, keysMask, dx, dy) {
  const s = tickState;
  s.yaw -= dx * P.sensitivity;
  s.pitch -= dy * P.sensitivity;
  const pc = P.pitchClamp;
  if (s.pitch > pc) s.pitch = pc;
  if (s.pitch < -pc) s.pitch = -pc;
  const yawRad = (s.yaw * Math.PI) / 180;
  const sinY = Math.sin(yawRad);
  const cosY = Math.cos(yawRad);
  let ax = 0;
  let az = 0;
  if (keysMask & KEY_MASK.forward) {
    ax -= sinY * P.accel;
    az -= cosY * P.accel;
  }
  if (keysMask & KEY_MASK.backward) {
    ax += sinY * P.accel;
    az += cosY * P.accel;
  }
  if (keysMask & KEY_MASK.left) {
    ax -= cosY * P.accel;
    az += sinY * P.accel;
  }
  if (keysMask & KEY_MASK.right) {
    ax += cosY * P.accel;
    az -= sinY * P.accel;
  }
  s.vel.x += ax * dt;
  s.vel.z += az * dt;
  const hSpeed = Math.hypot(s.vel.x, s.vel.z);
  if (hSpeed > P.moveSpeed) {
    s.vel.x = (s.vel.x / hSpeed) * P.moveSpeed;
    s.vel.z = (s.vel.z / hSpeed) * P.moveSpeed;
  }
  if ((keysMask & KEY_MASK.jump) && s.onGround) {
    s.vel.y = P.jumpVel;
    s.onGround = false;
  }
  s.vel.y -= P.gravity * dt;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
  if (s.pos.y <= 0) {
    s.pos.y = 0;
    s.vel.y = 0;
    s.onGround = true;
  }
}

// ── 双模自驱循环（与 worker-a.ts loop 结构一致）────────────────
function loop() {
  if (!shared || !P) return;
  const now = performance.now();
  let delta = (now - lastNow) / 1000;
  lastNow = now;
  if (delta > P.maxDelta) delta = P.maxDelta;
  if (delta < 0) delta = 0;

  const tickRate = shared.readTickRate();
  const modeBActive = tickRate > 0 && 1 / tickRate > P.renderDt;
  if (modeBActive && !modeBWasActive) {
    loAcc = 0;
    tickDxAcc = 0;
    tickDyAcc = 0;
    alignTickPhys();
  } else if (!modeBActive && modeBWasActive) {
    loAcc = 0;
    tickDxAcc = 0;
    tickDyAcc = 0;
  }
  modeBWasActive = modeBActive;

  // 第一步：tick 计算（先——模式B 独立实例 + 速度校准）
  if (modeBActive) {
    const tickDt = 1 / tickRate;
    loAcc += delta;
    while (loAcc >= tickDt) {
      loAcc -= tickDt;
      const tickKeys = shared.peekKeys();
      const tickMax = P.maxInputDelta * (tickDt / P.renderDt);
      const tickDx = Math.max(-tickMax, Math.min(tickMax, tickDxAcc));
      const tickDy = Math.max(-tickMax, Math.min(tickMax, tickDyAcc));
      tickDxAcc = 0;
      tickDyAcc = 0;
      if (tickDiverged()) alignTickPhys();
      stepTickPhys(tickDt, tickKeys, tickDx, tickDy);
      // 速度校准（唯一 tick 影响通道：三轴速度写回无限制模式）
      vel.x = tickState.vel.x;
      vel.y = tickState.vel.y;
      vel.z = tickState.vel.z;
    }
  } else {
    loAcc = 0;
  }

  // 第二步：无限制计算（后——renderDt 子步 + 实时输入；位置/角度唯一推进者）
  acc += delta;
  if (acc >= P.renderDt) {
    let steps = 0;
    while (acc >= P.renderDt && steps < P.maxStepsPerRound) {
      acc -= P.renderDt;
      steps++;
      const inp = shared.consumeInput(P.maxInputDelta);
      if (modeBActive) {
        tickDxAcc += inp.dx;
        tickDyAcc += inp.dy;
      }
      stepPhysics(P.renderDt, inp.keysMask, inp.dx, inp.dy);
      writeStateFromPhys();
    }
    if (acc > P.maxAcc) acc = P.maxAcc;
  }

  // 背压：距下次子步 ≥ 阈值 → 挂起 WAKEUP 槽（主线程 rAF 提前唤醒）
  const idleMs = (P.renderDt - acc) * 1000;
  if (idleMs >= (P.backpressureThresholdMs ?? 1)) {
    shared.waitWakeup(Math.min(idleMs, P.backpressureMaxMs ?? 4));
  }
  setTimeout(loop, 0);
}

// ── 消息处理（与 worker-a.ts 握手一致；config 随 init 注入）─────
self.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.init(msg.shared);
      P = msg.config?.phys ?? {}; // 框架参数注入（单一来源 src/config.js）
      alignTickPhys();
      writeStateFromPhys(); // 首帧状态即刻可见
      loop();
      break;
    case 'respawn':
      pos = { x: 0, y: 0, z: 0 };
      vel = { x: 0, y: 0, z: 0 };
      yaw = 0;
      pitch = 0;
      onGround = false;
      alignTickPhys();
      writeStateFromPhys();
      break;
  }
});
