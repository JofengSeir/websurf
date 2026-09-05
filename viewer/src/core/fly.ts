/** 自由飞行相机：持有位姿状态、处理键鼠输入，并把状态写入 three 相机。 */

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
  /** 人物脚底位置（相机 = pos + EYE_STAND）。 */
  readonly pos = new THREE.Vector3(0, 0, 0);
  /** 弧度；0 = 面朝 -Z，正 = 逆时针（俯视）。 */
  yaw = 0;
  /** 弧度；正 = 仰视。 */
  pitch = 0;
  /** roll（弧度），仅回放第一人称使用，自由飞行恒为 0。 */
  roll = 0;

  /** 指针锁定状态（外部只读）。 */
  locked = false;
  /**
   * 是否把自身状态写入相机。回放第一人称时为 false（相机由播放器驱动），
   * 但飞行状态仍照常持有，退出回放即可原地接管。
   */
  drivesCamera = true;
  /**
   * 是否响应 WASD 位移。回放第一人称时为 false（相机由播放器驱动，
   * 否则按了键会在看不见的地方把飞行位置挪走）。
   */
  allowMove = true;
  /** 是否允许点击画布请求指针锁定（量测拾取时置 false，避免抢走点击）。 */
  allowPointerLock = true;

  private canvas: HTMLCanvasElement | null = null;
  private discardNextMouse = false;
  private mouseDx = 0;
  private mouseDy = 0;
  private readonly keys = new Set<string>();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();

  /** 指针锁定状态变化回调（HUD 提示用）。 */
  onLockChange: ((locked: boolean) => void) | null = null;
  /** 指针锁定失败回调。 */
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

  /** 鼠标增量绝对削平（防事件合并/驱动异常跳变）。 */
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

  /** 每帧推进：先消化鼠标增量，再做按键位移。 */
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

  /** 写入相机（drivesCamera 为 false 时跳过）。 */
  applyTo(camera: THREE.PerspectiveCamera): void {
    if (!this.drivesCamera) return;
    this.writeCamera(camera);
  }

  private writeCamera(camera: THREE.PerspectiveCamera): void {
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.position.set(this.pos.x, this.pos.y + EYE_STAND, this.pos.z);
  }

  /** 用外部位姿覆盖（立即生效）。 */
  setPose(pose: Pose): void {
    this.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.yaw = pose.ang[0] * DEG2RAD;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pose.ang[1] * DEG2RAD));
  }

  /** 直接写入世界位姿（脚底 + 弧度角），用于回放第一人称同步飞行状态。 */
  setWorld(pos: THREE.Vector3Like, yawRad: number, pitchRad: number, rollRad = 0): void {
    this.pos.set(pos.x, pos.y, pos.z);
    this.yaw = yawRad;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchRad));
    this.roll = rollRad;
  }

  /** 用飞行状态写相机，并叠加 roll（第一人称回放用）。eyeOffset 可覆盖眼高。 */
  applyToWithRoll(camera: THREE.PerspectiveCamera, eyeOffset = EYE_STAND): void {
    camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    camera.position.set(this.pos.x, this.pos.y + eyeOffset, this.pos.z);
  }

  /** 当前位姿（人物脚底 + 度）。 */
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
