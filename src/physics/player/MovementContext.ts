/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 所有抽取出的移动行为（Jump、WalkMove、TryPlayerMove…）操作的对象形状。
// PlayerController 直接实现它——实例字段即上下文字段，所以把 `this` 传给行为
// 函数零开销：无包装对象、无代理、无逐 tick 分配。临时向量（wishDir/moveEnd/
// tmpA/tmpB）跨 tick 复用，原因与原单体类复用的相同。

import type { Vec3 } from '../math/vec3.js';
import type { LadderVolume } from '../physics/Collision/Collision.types.js';
import type { World } from '../physics/World/World.js';
import type { Settings } from '../settings/Settings.js';

/** 各行为把 ctx.yaw/pitch（度）转为方向向量时共用。 */
export const DEG2RAD = Math.PI / 180;

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  duck: boolean;
  walk: boolean;
  reset: boolean;
}

export interface MovementContext {
  readonly world: World;
  readonly settings: Settings;
  /** 异常时调用（unstuck 弹出、速度清零）。 */
  readonly log: (msg: string) => void;

  origin: Vec3;
  velocity: Vec3;
  yaw: number; // 度；0 时面向 -Z
  pitch: number;

  onGround: boolean;
  groundNormal: Vec3;
  ducked: boolean;
  duckFrac: number; // 0 站立，1 蹲下（驱动视角插值）
  onLadder: LadderVolume | null;
  /** 站在 surf 陡坡上为 true（按空中规则，无摩擦）。 */
  surfing: boolean;
  /** 自 surf 开始至下一次真实落地期间为 true。 */
  surfedSinceGrounded: boolean;

  /** 本 tick 开始时的位置快照（用于 blocked-move 检测）。 */
  prevPos: Vec3;
  prevEye: number;
  currEye: number;
  landPunch: number; // 落地造成的向下视角偏移，逐 tick 衰减

  /** 0..settings.stamina.max；仅 settings.stamina.enabled 时有意义。 */
  stamina: number;
  /** 最近一次起跳的质量；仅 settings.perf.enabled 时设置。 */
  lastHopQuality: 'perfect' | 'normal' | null;

  readonly input: InputState;

  oldJump: boolean; // 上一 tick 是否按住 +jump（Source 的 pogo-stick 检查）
  ladderCooldown: number; // 跳离梯子后可重新抓住的秒数
  fallVelocity: number;
  groundTicksSinceLanding: number; // 落地以来经过的地面摩擦 tick 数
  /** 本局是否曾由 checkJump 发起过真实跳跃——决定完美连跳继承是否生效。 */
  hasJumpedBefore: boolean;
  /** 最近一次落地瞬间的水平速度快照；见 PerfBonus。 */
  landingVelocity: Vec3;
  stuckTicks: number;
  blockedTicks: number;
  contactsThisTick: string[];
  /** 本 tick 开始时的速度标量（速度骤降诊断用；由 PlayerController.tick 记录）。 */
  prevSpeed?: number;
  /**
   * 最近一次速度归零/异常减速的诊断原因（可选；HUD 显示用）。
   * 由 TryPlayerMove / BlockedMove / StuckCheck 设置，
   * 格式：`路径名 上下文`（如 `cornered×3 v(0,0,0)`、`slowdown-36% c[...]`）。
   */
  zeroCause?: string | null;

  // 临时向量——跨 tick 复用避免分配。
  readonly wishDir: Vec3;
  readonly moveEnd: Vec3;
  readonly tmpA: Vec3;
  readonly tmpB: Vec3;

  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly horizontalSpeed: number;

  // 站立/蹲下的静态碰撞箱体型（由 PlayerController.hull 派生，供 Duck.ts 等使用）
  // —— 与 mins/maxs（当前姿态）不同，这四者是两种姿态的体型。
  readonly standMins: Vec3;
  readonly standMaxs: Vec3;
  readonly duckMins: Vec3;
  readonly duckMaxs: Vec3;
}
