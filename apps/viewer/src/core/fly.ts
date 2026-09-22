/**
 * 自由飞行相机：持有位姿状态、处理键鼠输入，并把状态写入 three 相机。
 *
 * 状态字段：`pos`（脚底世界坐标）、`yaw` / `pitch` / `roll`（弧度）、`locked`（指针锁定），
 * 以及三个开关 `drivesCamera` / `allowMove` / `allowPointerLock`。
 * 相机 y = `pos.y + EYE_STAND`，朝向用 `camera.rotation.set(pitch, yaw, roll, 'YXZ')` 写入。
 *
 * 输入链路（全部在 `attach` 内注册一次，此后是全局监听）：
 * click →（`locked` 为假时）`requestLock`，先试
 * `requestPointerLock({unadjustedMovement:true})`，Promise 拒绝或同步抛出时回退无参调用；
 * `pointerlockerror` → `onLockError`。`mousemove` 只在锁定时累加增量并丢掉锁定后的第一个事件，
 * `keydown` / `keyup` 维护按键集合，`blur` 与解锁都会清空增量与按键集合。
 *
 * 每帧调用方 = `apps/viewer/src/app.ts` 的 `frame`：自由飞行时 `FlyCam.update(dt)` 后
 * `applyTo(camera)`；回放第一人称时把 `drivesCamera` / `allowMove` 置假，改用 `setWorld`
 * 与 `applyToWithRoll` 让录像驱动相机。
 *
 * 文件末尾的 `MOVE_KEYS` 是参与位移的键集合（W/A/S/D、C、Space、左右 Shift、左右 Ctrl）：
 * 只有集合内的键会被 `preventDefault` 并记入状态，左右 Shift 决定用 `FLY_SPEED` 还是
 * `FLY_SPEED_FAST`，Space 上升，C 与左右 Ctrl 下降。
 *
 * 未接线字段：`allowPointerLock` 全仓只有声明（无写入点、无读取点）；`onLockChange` 只有
 * 调用点（`attach` 内），没有任何赋值点。
 */

import * as THREE from 'three';
import {
  DEG2RAD,
  EYE_STAND,
  FLY_SPEED,
  FLY_SPEED_FAST,
  MOUSE_MAX_DELTA,
  MOUSE_SENS,
  PITCH_LIMIT,
} from './constants.js';
import type { Pose } from './pose.js';

/** requestPointerLock 运行时签名（现代 Chromium 支持 options 并返回 Promise）。 */
type RequestPointerLockFn = (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;

export class FlyCam {
  /** 人物脚底位置（相机 y = pos.y + EYE_STAND）。 */
  readonly pos = new THREE.Vector3(0, 0, 0);
  /** 弧度；0 = 面朝 −Z，正 = 逆时针（俯视）。与 three 相机的 Y 轴旋转同向。 */
  yaw = 0;
  /** 弧度；正 = 仰视（与 three 相机的 X 轴旋转同号）。 */
  pitch = 0;
  /** roll（弧度，绕 Z）：只有回放第一人称经 `setWorld` / `applyToWithRoll` 使用；自由飞行恒为 0。 */
  roll = 0;

  /** 指针锁定状态（只由 `pointerlockchange` 处理更新；外部只读）。 */
  locked = false;
  /**
   * 是否把自身状态写入相机（`applyTo` 与 `writeCamera` 读它）。
   * `apps/viewer/src/app.ts` 的回放第一人称段把它置 false（相机改由 `applyToWithRoll` 写），
   * 退出回放时置回 true——飞行状态本身照常持有，可原地接管。
   */
  drivesCamera = true;
  /**
   * 是否响应位移键（`update` 读它）。
   * 回放第一人称时置 false：否则按键会在看不见的地方把飞行位置挪走。
   */
  allowMove = true;
  /**
   * 是否允许点击画布请求指针锁定。
   * 本仓当前未接线：`attach` 的 click 处理只判 `locked`，不读本字段；全仓也没有写入点。
   */
  allowPointerLock = true;

  private canvas: HTMLCanvasElement | null = null;
  private discardNextMouse = false;
  private mouseDx = 0;
  private mouseDy = 0;
  private readonly keys = new Set<string>();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();

  /** 指针锁定状态变化回调（`pointerlockchange` 处理里调用）。 */
  onLockChange: ((locked: boolean) => void) | null = null;
  /** 指针锁定失败回调（`pointerlockerror` 处理里调用）。 */
  onLockError: (() => void) | null = null;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;

    canvas.addEventListener('click', () => {
      if (!this.locked) this.requestLock();
    });

    document.addEventListener('pointerlockerror', () => {
      console.warn('[viewer] Pointer Lock 请求失败');
      this.onLockError?.();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.discardNextMouse = true;
      if (!this.locked) {
        this.mouseDx = 0;
        this.mouseDy = 0;
        this.keys.clear();
      }
      this.onLockChange?.(this.locked);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.discardNextMouse) {
        this.discardNextMouse = false;
        return;
      }
      this.mouseDx += this.delta(e.movementX);
      this.mouseDy += this.delta(e.movementY);
    });

    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (MOVE_KEYS.has(e.code)) {
        e.preventDefault();
        this.keys.add(e.code);
      }
    });

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDx = 0;
      this.mouseDy = 0;
    });
  }

  /** 单次鼠标增量的绝对值削平（上限 `MOUSE_MAX_DELTA`，防事件合并 / 驱动异常跳变）。 */
  private delta(v: number): number {
    return Math.max(-MOUSE_MAX_DELTA, Math.min(MOUSE_MAX_DELTA, v));
  }

  private requestLock(): void {
    const target = this.canvas;
    if (!target) return;
    const fn = target.requestPointerLock as unknown as RequestPointerLockFn;
    try {
      const result: unknown = fn.call(target, { unadjustedMovement: true });
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {
          console.warn('[viewer] unadjustedMovement 不可用，降级为普通锁定');
          try {
            fn.call(target);
          } catch {
            /* 忽略降级失败 */
          }
        });
      }
    } catch {
      try {
        fn.call(target);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 每帧推进：锁定时先消化鼠标增量（改 yaw / pitch），再做按键位移；未锁定则两段都跳过。 */
  update(dt: number): void {
    if (this.locked) {
      const dx = this.mouseDx;
      const dy = this.mouseDy;
      this.mouseDx = 0;
      this.mouseDy = 0;
      this.yaw -= dx * MOUSE_SENS;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * MOUSE_SENS));
    }

    if (this.locked && this.allowMove && this.keys.size > 0) {
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = fast ? FLY_SPEED_FAST : FLY_SPEED;
      this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.move.set(0, 0, 0);
      if (this.keys.has('KeyW')) this.move.add(this.fwd);
      if (this.keys.has('KeyS')) this.move.sub(this.fwd);
      if (this.keys.has('KeyD')) this.move.add(this.right);
      if (this.keys.has('KeyA')) this.move.sub(this.right);
      if (this.keys.has('Space')) this.move.y += 1;
      if (this.keys.has('KeyC') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
        this.move.y -= 1;
      }
      if (this.move.lengthSq() > 0) {
        this.pos.addScaledVector(this.move.normalize(), speed * dt);
      }
    }
  }

  /** 把位姿写入相机（`drivesCamera` 为 false 时整个跳过）。 */
  applyTo(camera: THREE.PerspectiveCamera): void {
    if (!this.drivesCamera) return;
    this.writeCamera(camera);
  }

  private writeCamera(camera: THREE.PerspectiveCamera): void {
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.position.set(this.pos.x, this.pos.y + EYE_STAND, this.pos.z);
  }

  /** 用外部位姿覆盖（立即生效）：`ang` 按度解释，pitch 夹到 `PITCH_LIMIT`；yaw 不做归一。 */
  setPose(pose: Pose): void {
    this.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.yaw = pose.ang[0] * DEG2RAD;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pose.ang[1] * DEG2RAD));
  }

  /** 直接写入世界位姿（脚底 + 弧度角）：回放第一人称用它把录像状态灌进飞行状态，pitch 同样夹到 `PITCH_LIMIT`。 */
  setWorld(pos: THREE.Vector3Like, yawRad: number, pitchRad: number, rollRad = 0): void {
    this.pos.set(pos.x, pos.y, pos.z);
    this.yaw = yawRad;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchRad));
    this.roll = rollRad;
  }

  /** 用飞行状态写相机并叠加 roll（第一人称回放用）；`eyeOffset` 覆盖眼高，且**不检查** `drivesCamera`。 */
  applyToWithRoll(camera: THREE.PerspectiveCamera, eyeOffset = EYE_STAND): void {
    camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    camera.position.set(this.pos.x, this.pos.y + eyeOffset, this.pos.z);
  }

  /** 当前位姿（脚底 + 度）：yaw 与 pitch 由弧度换算回度，不含 roll。 */
  getPose(): Pose {
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      ang: [this.yaw / DEG2RAD, this.pitch / DEG2RAD],
    };
  }
}

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyC',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
]);
