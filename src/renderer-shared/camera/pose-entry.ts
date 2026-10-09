/**
 * 三端共享的**位姿入口**（T-454 P3/L7；同时收编 T-443）。
 *
 * 为什么有这一层：三端各自有一套「把相机钉到某个位姿」的私有机制——game 用生产路径的
 * `setHoldPoint`（按住 C 读点）加 `__vbspFrameProbe`，viewer 用 `FlyCam.setPose`，debug 只能在物理
 * 每帧写回相机之后**没有**冻结入口 ⇒ 同图同视点的三端比对无法做，跨端像素判据也就永远跑不起来。
 * 本模块把「位姿」定义成**相机位姿**（世界坐标 HU + 度），并提供：
 *   - 唯一读数实现 `cameraPoseOf()`（三端数字格式一致，角度四位小数）；
 *   - 唯一位姿换算 `feetFromCameraPose()`（相机 → 脚底：`y − EYE_STAND`，各端物理/飞行器都吃脚底）；
 *   - 唯一挂载点 `installPoseEntry()`（挂 `globalThis.__vbspPose`，供自动化脚本与三端比对使用）。
 *
 * 各端只需要提供一个宿主（`PoseHost`）：把它自己「怎么钉住位姿」的机制接上（game 走 `setHoldPoint`、
 * viewer 走 `FlyCam.setPose`、debug 走它的每帧相机写回覆盖）。**位姿语义与读数格式不允许各端自定义**。
 */
import type * as THREE from 'three';
import { EYE_STAND } from '../../ts-shared/phys/constants.js';

export { EYE_STAND };

/** 角度换算：各端内部一律弧度，本模块对外一律度。 */
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** pitch 硬限幅（度）：与三端视角输入的限位取同一值（`InputConfig.pitchLimit` 缺省 89°）。 */
export const POSE_PITCH_LIMIT_DEG = 89;

/** 三端可读的位姿标识。 */
export type PoseScope = 'debug' | 'game' | 'viewer';

/**
 * 位姿（**相机位姿**）：`pos` = 相机世界位置（HU），`yawDeg` / `pitchDeg` 为度。
 * 脚底位姿由 `feetFromCameraPose()` 换算，各端物理/飞行器只吃脚底。
 */
export interface PoseSpec {
  pos: [number, number, number];
  yawDeg: number;
  pitchDeg: number;
}

/** 位姿读数：位姿 + 该端相机的投影参数（三端同格式，便于逐字对比）。 */
export interface PoseReadout extends PoseSpec {
  fov: number;
  near: number;
  far: number;
}

/** 各端提供的位姿宿主：怎么钉、怎么读、怎么解除由各端实现，语义由本模块固定。 */
export interface PoseHost {
  /** 把相机钉到该位姿（异步可实现：等物理/场景就绪）。 */
  applyPose(spec: PoseSpec): void | Promise<void>;
  /** 当前相机读数；不可用时返回 null。 */
  readPose(): PoseReadout | null;
  /** 解除冻结（各端自行决定恢复到什么状态）。 */
  releasePose(): void;
}

/** 挂在 `globalThis` 上的入口（自动化脚本与三端比对的唯一入口）。 */
export interface PoseEntry {
  readonly scope: PoseScope;
  readonly ready: boolean;
  setPose(spec: PoseSpec): Promise<PoseReadout | null>;
  cameraPose(): PoseReadout | null;
  release(): void;
}

/** 位姿 → 弧度对（需要弧度的端用这一处换算，避免各端自己乘常数）。 */
export function yawPitchRadOf(spec: PoseSpec): [number, number] {
  return [spec.yawDeg * DEG2RAD, spec.pitchDeg * DEG2RAD];
}

/** 相机读数（三端唯一实现）：位置原值 + 角度四位小数 + fov/near/far。 */
export function cameraPoseOf(camera: THREE.PerspectiveCamera | null | undefined): PoseReadout | null {
  if (!camera) return null;
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    yawDeg: +((camera.rotation.y * RAD2DEG)).toFixed(4),
    pitchDeg: +((camera.rotation.x * RAD2DEG)).toFixed(4),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };
}

/** 相机位姿 → 脚底位姿（各端物理/飞行器吃脚底；`EYE_STAND` 来自共享物理常量）。 */
export function feetFromCameraPose(spec: PoseSpec, eyeStand: number = EYE_STAND): [number, number, number] {
  return [spec.pos[0], spec.pos[1] - eyeStand, spec.pos[2]];
}

/** 位姿归一：非有限值拒绝、pitch 钳到 ±`POSE_PITCH_LIMIT_DEG`（三端同一口径）。 */
export function normalizePoseSpec(spec: PoseSpec): PoseSpec {
  const bad = spec.pos.some((v) => !Number.isFinite(v)) || !Number.isFinite(spec.yawDeg) || !Number.isFinite(spec.pitchDeg);
  if (bad) throw new Error('[pose-entry] 位姿含非有限值: ' + JSON.stringify(spec));
  const pitch = Math.max(-POSE_PITCH_LIMIT_DEG, Math.min(POSE_PITCH_LIMIT_DEG, spec.pitchDeg));
  let yaw = spec.yawDeg % 360;
  if (yaw > 180) yaw -= 360;
  if (yaw <= -180) yaw += 360;
  return { pos: [spec.pos[0], spec.pos[1], spec.pos[2]], yawDeg: yaw, pitchDeg: pitch };
}

/** 位姿读数 → 单行描述（三端同格式；比对脚本直接比这一行）。 */
export function describePose(p: PoseReadout | null): string {
  if (!p) return '[pose-entry] 位姿：不可用';
  return (
    '[pose-entry] 位姿：pos=(' +
    p.pos[0] +
    ', ' +
    p.pos[1] +
    ', ' +
    p.pos[2] +
    ') yaw=' +
    p.yawDeg +
    ' pitch=' +
    p.pitchDeg +
    ' fov=' +
    p.fov +
    ' near=' +
    p.near +
    ' far=' +
    p.far
  );
}

/**
 * 挂载位姿入口：把宿主接到 `globalThis.__vbspPose`。
 * 生产路径零影响——不调用 `setPose` 就不改变任何状态。
 */
export function installPoseEntry(host: PoseHost, scope: PoseScope): PoseEntry {
  const entry: PoseEntry = {
    scope,
    get ready(): boolean {
      return host.readPose() !== null;
    },
    async setPose(spec: PoseSpec): Promise<PoseReadout | null> {
      const norm = normalizePoseSpec(spec);
      await host.applyPose(norm);
      return host.readPose();
    },
    cameraPose(): PoseReadout | null {
      return host.readPose();
    },
    release(): void {
      host.releasePose();
    },
  };
  (globalThis as unknown as { __vbspPose?: PoseEntry }).__vbspPose = entry;
  console.info('[pose-entry] 已挂载：scope=' + scope + ' 入口=globalThis.__vbspPose');
  return entry;
}
