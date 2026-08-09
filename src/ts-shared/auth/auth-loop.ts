/**
 * 权威帧计算循环（公共化 v1）— setTimeout 4ms 自驱 + 固定步长累积器 + 碰撞事件。
 *
 * Worker = 权威帧计算器：持权威 PhysWorld（world-json 一次性构建），
 * 墙钟驱动固定步长（默认 64Hz；config.physics.tickRate 动态覆盖）独立模拟
 * 权威物理线（含碰撞/摩擦/重力），每 tick：
 * - takeInput 消费主线程写 SAB 输入槽（或 MsgState 回退缓冲）的鼠标/按键
 * - phys.tick 完整推进（含碰撞/传送/死亡）
 * - writeAuthoritative 写权威帧到 SAB 双缓冲（或 phys-frame 消息回退）
 * - 权威碰撞事件（land/blocked）postMessage 回传主线程做位置微调 + 角度同步
 *
 * 抽象：wasm 模块（PhysWorld）由调用方注入（结构性接口 PhysWorldLike），
 * 碰撞事件可经 onCollisionEvent 回调接管（默认 postMessage）。
 */

import type { ShmState, MsgState } from './shared-state.js';

/** 权威 PhysWorld 最小接口（两端 pkg/websurf_wasm.js 的 PhysWorld 结构性满足）。 */
export interface PhysWorldLike {
  state(): unknown;
  tick(dt: number, keysMask: number, dx: number, dy: number): unknown;
  build_world(
    brushJson: string,
    triJson: string,
    teleportJson: string,
    x: number,
    y: number,
    z: number,
    yawDeg: number,
  ): void;
  set_params(json: string): void;
  set_hull(halfWidth: number, standHeight: number, duckHeight: number): void;
  set_noclip(active: boolean): void;
  set_state(
    posX: number,
    posY: number,
    posZ: number,
    yaw: number,
    pitch: number,
    velX: number,
    velY: number,
    velZ: number,
    onGround: boolean,
  ): void;
  respawn(): void;
  teleport_to_spawn(idx: number): void;
  teleport_to(x: number, y: number, z: number, yaw: number): void;
  set_spawn_points(json: string): void;
  set_death_y(y: number): void;
}

/** 权威碰撞事件（低频，postMessage 回传主线程；两端 MainMessage 同构）。 */
export interface AuthCollisionEvent {
  type: 'phys-event';
  kind: 'land' | 'blocked';
  pos: number[];
  /** 权威碰撞瞬间朝向（度；权威仅在碰撞判断时可影响渲染角度）。 */
  yawDeg: number;
  pitchDeg: number;
  timeMs: number;
}

export interface AuthLoopEnv {
  /** 跨线程状态通道（SAB 或 MsgState 回退；动态读取——init 消息后注入）。 */
  shared: ShmState | MsgState | null;
  getPhys(): PhysWorldLike | null;
  /** 消息发送（缺省 self.postMessage；node 测试注入）。 */
  post?(msg: unknown): void;
  /** 碰撞事件回调（缺省 postMessage；可注入做断言/过滤）。 */
  onCollisionEvent?(ev: AuthCollisionEvent): void;
}

export interface AuthLoop {
  /** 固定步长（Hz；config.physics.tickRate 变更即时生效）。 */
  setFixedDt(rate: number): void;
  /** 清累积器/基准墙钟（world-json 重建后防新旧步长错配）。 */
  reset(): void;
  /** 启动自驱循环（幂等；wasm-init 就绪后调用一次）。 */
  start(): void;
}

/** 防穿墙：单 tick 输入增量上限（度）。 */
const MAX_INPUT_PER_STEP_BASE = 1200;

export function createAuthLoop(env: AuthLoopEnv): AuthLoop {
  /** 权威固定步长（默认 64Hz；config.physics.tickRate 动态覆盖）。 */
  let fixedDt = 1 / 64;
  /** 累积器：真实墙钟 → 固定步长推进（不设上限，低帧率不丢物理时间）。 */
  let acc = 0;
  let lastWall = 0;
  let started = false;

  // 碰撞事件检测基准（tick 前快照）
  let prevOnGround = false;
  let prevSpeed = 0;
  let prevOrigin: [number, number, number] | null = null;

  const post: (msg: unknown) => void =
    env.post ??
    ((msg: unknown): void => {
      if (typeof self !== 'undefined') {
        (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
      }
    });

  const emitCollision = (ev: AuthCollisionEvent): void => {
    if (env.onCollisionEvent) env.onCollisionEvent(ev);
    else post(ev);
  };

  /** 单个权威步长：消费输入 → 完整物理 tick（含碰撞）→ 写权威帧。 */
  function stepPhysics(dt: number): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const maxStep = (MAX_INPUT_PER_STEP_BASE * dt) / (1 / 64);
    const input = shared.takeInput(maxStep);
    // 碰撞事件检测基准（tick 前）
    const before = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
    };
    prevOnGround = before.onGround;
    prevSpeed = Math.hypot(before.velX, before.velY, before.velZ);
    prevOrigin = [before.posX, before.posY, before.posZ];

    phys.tick(dt, input.keysMask, input.dx, input.dy);
    const s = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      yaw: number;
      pitch: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
      eyeHeight: number;
    };
    shared.writeAuthoritative(
      {
        pos: { x: s.posX, y: s.posY, z: s.posZ },
        yaw: s.yaw,
        pitch: s.pitch,
        vel: { x: s.velX, y: s.velY, z: s.velZ },
        eyeHeight: s.eyeHeight,
        timeMs: performance.now(),
      },
      s.onGround,
    );

    // 权威碰撞事件（低频，postMessage 回传主线程做位置微调 + 角度同步）：
    // - land：onGround 上升沿（权威真实落地点；渲染侧相位差可能差几 units）
    // - blocked：撞墙/被阻——速度骤降（>250 u/s）且实际位移远小于速度对应位移
    if (!prevOnGround && s.onGround) {
      emitCollision({
        type: 'phys-event',
        kind: 'land',
        pos: [s.posX, s.posY, s.posZ],
        yawDeg: s.yaw,
        pitchDeg: s.pitch,
        timeMs: performance.now(),
      });
      return;
    }
    const curSpeed = Math.hypot(s.velX, s.velY, s.velZ);
    const moved = prevOrigin
      ? Math.hypot(s.posX - prevOrigin[0], s.posY - prevOrigin[1], s.posZ - prevOrigin[2])
      : 0;
    const expectedMove = prevSpeed * dt;
    if (curSpeed > 80 && prevSpeed - curSpeed > 250 && moved < expectedMove * 0.3) {
      emitCollision({
        type: 'phys-event',
        kind: 'blocked',
        pos: [s.posX, s.posY, s.posZ],
        yawDeg: s.yaw,
        pitchDeg: s.pitch,
        timeMs: performance.now(),
      });
    }
  }

  /** 主循环：墙钟驱动固定步长权威 tick（250Hz 轮询 > 最大 tick 率）。 */
  function loop(): void {
    setTimeout(loop, 4);
    if (!env.shared || !env.getPhys()) return;
    const now = performance.now();
    if (lastWall === 0) {
      lastWall = now;
      return;
    }
    acc += (now - lastWall) / 1000;
    lastWall = now;
    // 固定步长推进（不设上限：低帧率补足全部欠步）
    let guard = 0;
    while (acc >= fixedDt && guard < 64) {
      acc -= fixedDt;
      stepPhysics(fixedDt);
      guard++;
    }
  }

  return {
    setFixedDt(rate: number): void {
      fixedDt = 1 / Math.max(rate, 1);
    },
    reset(): void {
      acc = 0;
      lastWall = 0;
    },
    start(): void {
      if (started) return;
      started = true;
      loop();
    },
  };
}
