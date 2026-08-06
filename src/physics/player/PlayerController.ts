/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 逐 tick 玩家模拟，遵循 Source 的 CGameMovement 管线：duck → ladder →
// CheckJumpButton → Friction/Accelerate（地面）或 AirAccelerate（空中/surf）→
// TryPlayerMove 两侧分半重力 → CategorizePosition。状态均为 Source 单位，Y-up。
//
// 本类即 MovementContext（见 MovementContext.ts）——字段按引用传给各抽取行为
// （Jump、WalkMove…），tick() 是无额外分配的薄调用序列。

import { type Vec3, clone, copy, length2D, set, vec3 } from '../math/vec3.js';
import { recoverStamina } from '../physics/Stamina/Stamina.js';
import type { LadderVolume } from '../physics/Collision/Collision.types.js';
import type { World } from '../physics/World/World.js';
import type { Settings } from '../settings/Settings.js';

import { type InputState, type MovementContext } from './MovementContext.js';
import { updateDuck } from './Duck/Duck.js';
import {
  DEFAULT_HULL,
  DUCK_LERP_TIME,
  eyeDuckFor,
  eyeStandFor,
  type HullConfig,
} from './Duck/Duck.config.js';
import { checkLadder, ladderMove } from './Ladder/Ladder.js';
import { checkJump } from './Jump/Jump.js';
import { walkMove } from './WalkMove/WalkMove.js';
import { airMove } from './AirMove/AirMove.js';
import { categorizePosition } from './CategorizePosition/CategorizePosition.js';
import { checkStuck } from './StuckCheck/StuckCheck.js';
import { detectBlockedMove } from './BlockedMove/BlockedMove.js';
import { createMouseInputHandlers } from './MouseInput/MouseInput.js';

/** 可选宿主钩子。移动逻辑自身不写日志、不触碰全局。 */
export interface PlayerOptions {
  /** 异常时调用（unstuck 弹出、速度清零）。默认空操作。 */
  log?: (msg: string) => void;
  /** 初始碰撞箱体型（默认 DEFAULT_HULL = CS:S 基准 32×32×72 / 蹲 54）。 */
  hull?: Partial<HullConfig>;
}

export class PlayerController implements MovementContext {
  readonly world: World;
  readonly settings: Settings;
  readonly log: (msg: string) => void;

  origin: Vec3;
  velocity = vec3();
  yaw = 0; // 度；0 时面向 -Z
  pitch = 0;

  onGround = false;
  groundNormal = vec3(0, 1, 0);
  ducked = false;
  duckFrac = 0; // 0 站立，1 蹲下（驱动视角插值）
  onLadder: LadderVolume | null = null;

  /** 站在 surf 陡坡上为 true（按空中规则，无摩擦）。 */
  surfing = false;
  /** 自 surf 开始至下一次真实落地期间为 true。 */
  surfedSinceGrounded = false;

  // 插值快照（每 tick 的位置 + 视角高度）。
  prevPos: Vec3;
  currPos: Vec3;
  prevEye = eyeStandFor(DEFAULT_HULL);
  currEye = eyeStandFor(DEFAULT_HULL);

  landPunch = 0; // 落地造成的向下视角偏移，逐 tick 衰减

  /** 0..settings.stamina.max；仅 settings.stamina.enabled 时有意义。 */
  stamina = 0;
  /** 最近一次起跳的质量；仅 settings.perf.enabled 时设置。 */
  lastHopQuality: 'perfect' | 'normal' | null = null;

  readonly input: InputState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    duck: false,
    walk: false,
    reset: false,
  };

  oldJump = false; // 上一 tick 是否按住 +jump（Source 的 pogo-stick 检查）
  // Space 是真实按住键——input.jump 应持续跟踪它。mwheelup/mwheeldown 没有
  // 自己的 keyup，按 Source 自身的命令帧批处理，每个 notch 应精确记为一个 tick
  // 的 "+jump" 而非定时按住——见 bindInput() 的 wheel 处理器与 tick() 对
  // wheelJumpQueued 的消费。
  private keyJumpHeld = false;
  private wheelJumpQueued = false;
  // bindInput() 挂接真实监听后才为 true——否则 tick() 不得自行改动 input.jump，
  // 因为本代码库的测试都直接驱动它（player.input.jump = true）而不经绑定。
  private inputBound = false;
  ladderCooldown = 0; // 跳离梯子后可重新抓住的秒数
  fallVelocity = 0;
  groundTicksSinceLanding = 0; // 落地以来经过的地面摩擦 tick 数
  // 出生后重力把你沉降到出生地面不算跳跃落地——只有 checkJump 真正发起跳跃
  // 才置 true，这样完美连跳继承绝不会在没有前一跳可衔接时触发（见 Jump.ts）。
  hasJumpedBefore = false;
  /** 最近一次落地瞬间的水平速度快照；见 PerfBonus。 */
  landingVelocity = vec3();
  stuckTicks = 0;
  blockedTicks = 0;
  contactsThisTick: string[] = [];
  /** 最近一次速度归零/异常减速的诊断原因（HUD 显示；由各归零路径设置）。 */
  zeroCause: string | null = null;
  /** 本 tick 开始时的速度（速度骤降诊断用）。 */
  prevSpeed = 0;

  // 临时向量——跨 tick 复用避免分配。
  readonly wishDir = vec3();
  readonly moveEnd = vec3();
  readonly tmpA = vec3();
  readonly tmpB = vec3();

  // 滚动逐 tick 历史（dumpMovementLog 用）。不属于 MovementContext——
  // 是 PlayerController 自己的诊断 API。
  private tickCount = 0;
  private readonly tickHistory: string[] = [];
  private readonly spawn: Vec3;

  // ── 碰撞箱体型（可运行时调整，面板/自动恢复使用）──
  private _hull: HullConfig = { ...DEFAULT_HULL };
  // 体型缓存（setHull 时重建；getter 零分配）
  private _standMins = vec3();
  private _standMaxs = vec3();
  private _duckMins = vec3();
  private _duckMaxs = vec3();

  constructor(world: World, settings: Settings, spawn: Vec3, opts: PlayerOptions = {}) {
    this.world = world;
    this.settings = settings;
    this.log = opts.log ?? (() => {});
    this.spawn = clone(spawn);
    this.origin = clone(spawn);
    this.prevPos = clone(spawn);
    this.currPos = clone(spawn);
    // 初始化体型缓存（默认 DEFAULT_HULL；opts.hull 覆盖）
    this.setHull(opts.hull ? { ...DEFAULT_HULL, ...opts.hull } : { ...DEFAULT_HULL });
  }

  /**
   * 每个模拟 tick 的滚动记录（位置、速度、输入、接触平面），旧在前。
   * 需要移动转储时取用——库本身不注册全局来推送。
   */
  tickHistoryText(): string {
    return this.tickHistory.join('\n');
  }

  get mins(): Vec3 {
    return this.ducked ? this._duckMins : this._standMins;
  }

  get maxs(): Vec3 {
    return this.ducked ? this._duckMaxs : this._standMaxs;
  }

  /** 当前碰撞箱体型（面板显示/自动恢复判定用）。 */
  get hull(): HullConfig {
    return this._hull;
  }

  /** 站立/蹲下体型（MovementContext 实现，Duck.ts 等行为读取）。 */
  get standMins(): Vec3 {
    return this._standMins;
  }
  get standMaxs(): Vec3 {
    return this._standMaxs;
  }
  get duckMins(): Vec3 {
    return this._duckMins;
  }
  get duckMaxs(): Vec3 {
    return this._duckMaxs;
  }

  /**
   * 运行时调整碰撞箱体型（立即生效，无需重建 PlayerController）。
   * 视角高度按体型比例联动（eye = 基准眼高 × 高度/默认高度）。
   */
  setHull(hull: HullConfig): void {
    this._hull = { ...hull };
    set(this._standMins, -hull.halfWidth, 0, -hull.halfWidth);
    set(this._standMaxs, hull.halfWidth, hull.standHeight, hull.halfWidth);
    set(this._duckMins, -hull.halfWidth, 0, -hull.halfWidth);
    set(this._duckMaxs, hull.halfWidth, hull.duckHeight, hull.halfWidth);
  }

  get eyeHeight(): number {
    return eyeStandFor(this._hull) + (eyeDuckFor(this._hull) - eyeStandFor(this._hull)) * this.duckFrac;
  }

  get horizontalSpeed(): number {
    return length2D(this.velocity);
  }

  // -- Input ----------------------------------------------------------------

  bindInput(target: HTMLElement): void {
    this.inputBound = true;
    const keyMap: Record<string, keyof InputState | undefined> = {
      KeyW: 'forward',
      KeyS: 'back',
      KeyA: 'left',
      KeyD: 'right',
      ShiftLeft: 'walk',
      ControlLeft: 'duck',
      KeyC: 'duck',
      KeyR: 'reset',
    };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.keyJumpHeld = true;
        e.preventDefault();
        return;
      }
      const action = keyMap[e.code];
      if (action) {
        this.input[action] = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.keyJumpHeld = false;
        return;
      }
      const action = keyMap[e.code];
      if (action) this.input[action] = false;
    });

    // 绑定滚轮 "+jump"（chasemod 标准绑定，与空格并列而非替代）。滚一轮物理滚动
    // 不会只触发一个 wheel 事件——它会连发十几个独立 +jump/-jump 对。这正是
    // chasemod 滚轮连跳的机制：反复 +jump 给多次独立机会，让某次按压恰好落在
    // 落地后的精确 tick 上、抓住完美重跳。
    //
    // 此前两度尝试的墙上时钟定时脉冲都不可行：脉冲过长，相邻 notch 会合并成
    // 持续"按住"态——就像按住空格过落地那样，在真实（而非仅本模拟）中失败
    // pogo-stick 重按检查；过短则脉冲可能在物理 tick 之间流逝，静默吞掉 notch。
    // 两种时长都不"正确"，因为毫秒是错误单位——真正相关的是 *tick*，因为
    // checkJump 只读它。因此：wheel 事件只排队请求；tick() 精确消费为一个 tick
    // 的 "+jump" 并立即清除，无论请求排了多久。两个 tick 之间到达的多个事件
    // （一帧内整个连发）合并进同一个 tick 的按压——这符合 Source 自身的命令帧
    // 批处理，而非 bug；而前一请求被消费后到达的新事件会重新武装一次全新按压，
    // 所以分散在多个 tick 的连发获得多次独立机会，永远不会被合并成一次长按。
    window.addEventListener(
      'wheel',
      (e) => {
        if (document.pointerLockElement !== target || e.deltaY === 0) return;
        e.preventDefault();
        this.wheelJumpQueued = true;
      },
      { passive: false },
    );

    const { onPointerLockChange, onMouseMove } = createMouseInputHandlers(this);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== target) return;
      onMouseMove(e.movementX, e.movementY);
    });
  }

  respawn(): void {
    copy(this.origin, this.spawn);
    set(this.velocity, 0, 0, 0);
    copy(this.prevPos, this.spawn);
    copy(this.currPos, this.spawn);
    this.onGround = false;
    this.onLadder = null;
    this.ducked = false;
    this.stamina = 0;
    this.groundTicksSinceLanding = 0;
    this.hasJumpedBefore = false;
    this.surfedSinceGrounded = false;
    set(this.landingVelocity, 0, 0, 0);
    this.lastHopQuality = null;
  }

  // -- Simulation -----------------------------------------------------------

  tick(dt: number): void {
    copy(this.prevPos, this.currPos);
    this.prevEye = this.currEye;
    // 记录本 tick 起始速度（速度骤降诊断用；detectBlockedMove 读取）
    this.prevSpeed = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);

    // Space 物理按住期间持续为真；排队的滚轮 notch 只在本 tick 消费一次随即清除，
    // 与 Space 是否同按无关——见 bindInput() 的 wheel 处理器。
    if (this.inputBound) {
      this.input.jump = this.keyJumpHeld || this.wheelJumpQueued;
      this.wheelJumpQueued = false;
    }

    if (this.input.reset) {
      this.input.reset = false;
      this.respawn();
    }

    if (this.ladderCooldown > 0) this.ladderCooldown -= dt;
    updateDuck(this);
    if (this.settings.stamina.enabled) {
      this.stamina = recoverStamina(this.stamina, this.settings.stamina.recoveryRate, this.settings.stamina.max, dt);
    }

    if (!checkStuck(this)) {
      const ladder = checkLadder(this);
      if (ladder) {
        ladderMove(this, dt, ladder);
      } else {
        this.onLadder = null;
        checkJump(this);
        if (this.onGround) {
          walkMove(this, dt);
          this.groundTicksSinceLanding++;
        } else {
          this.fallVelocity = -this.velocity.y;
          airMove(this, dt);
        }
        categorizePosition(this);
      }
    }

    detectBlockedMove(this);

    // 落地视角震动（仅渲染，可选）。
    this.landPunch *= Math.max(0, 1 - 10 * dt);
    this.oldJump = this.input.jump;
    this.recordTick();

    // 蹲下视角高度插值。
    const target = this.ducked ? 1 : 0;
    const rate = dt / DUCK_LERP_TIME;
    this.duckFrac += Math.sign(target - this.duckFrac) * Math.min(rate, Math.abs(target - this.duckFrac));

    copy(this.currPos, this.origin);
    this.currEye = this.eyeHeight;
  }

  private recordTick(): void {
    const o = this.origin;
    const v = this.velocity;
    const i = this.input;
    const keys =
      (i.forward ? 'W' : '') +
      (i.back ? 'S' : '') +
      (i.left ? 'A' : '') +
      (i.right ? 'D' : '') +
      (i.jump ? 'J' : '') +
      (i.duck ? 'C' : '') +
      (i.walk ? 'H' : '');
    const flags =
      (this.onGround ? 'G' : 'A') + (this.surfing ? 's' : '') + (this.onLadder ? 'L' : '') + (this.ducked ? 'd' : '');
    const contacts = this.contactsThisTick.length > 0 ? ` c[${this.contactsThisTick.join(' ')}]` : '';
    this.tickHistory.push(
      `${this.tickCount++} p ${o.x.toFixed(1)},${o.y.toFixed(1)},${o.z.toFixed(1)} ` +
        `v ${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)} ${flags} in:${keys || '-'}${contacts}`,
    );
    if (this.tickHistory.length > 384) this.tickHistory.shift();
    this.contactsThisTick = [];
  }
}
