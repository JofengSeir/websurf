/**
 * 相机角度同步器：把 yaw / pitch（弧度）写进相机四元数。
 *
 * 三条约束：每帧把 yaw 归一到 [−π, π]；pitch 钳到 ±`pitchLimitRad`（初值取自
 * `InputConfig.pitchLimit`，缺省 89°）；欧拉顺序固定 'YXZ'。
 * 本类不做输入处理——鼠标增量在主线程过滤后发给 Worker 写玩家朝向，回帧时再喂进来。
 *
 * 装配点：`apps/debug/src/renderer/renderer-main.ts`（构造一次，`update` / `setYawPitch` /
 * `setPosition` 在每帧同步与传送路径里被调用）。
 */

import * as THREE from 'three';
import type { InputConfig } from '../config.js';

/**
 * 相机角度同步器。
 *
 * yaw = 0 面向 −Z（Three.js 默认朝向）；yaw 增大绕 Y 轴顺时针（鼠标右移）。
 * pitch = 0 水平，pitch 为正表示仰视。
 */
export class CameraController {
	/** 被同步的相机（构造传入）。 */
	readonly camera: THREE.PerspectiveCamera;

	/** 当前 yaw（弧度）；`update` 会把它归一到 [−π, π]。 */
	yaw = 0;
	/** 当前 pitch（弧度）；`update` 会把它钳到 ±`pitchLimitRad`。 */
	pitch = 0;
	/** pitch 限位（弧度）：构造时由 `InputConfig.pitchLimit`（度）换算，`applyInputConfig` 可改写。 */
	pitchLimitRad: number;

	/** 复用的欧拉对象（顺序 'YXZ'），避免每帧新建。 */
	private readonly lookEuler: THREE.Euler;
	/** 上一帧同步后的 yaw / pitch，用于判定本帧是否发生旋转。 */
	private prevYaw = 0;
	private prevPitch = 0;

	/** 绑定相机并换算初始 pitch 限位；`inputCfg` 省略时限位取 89°。 */
	constructor(camera: THREE.PerspectiveCamera, inputCfg?: InputConfig) {
		this.camera = camera;
		this.lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
		this.pitchLimitRad = ((inputCfg?.pitchLimit ?? 89) * Math.PI) / 180;
	}

	/** 归一 yaw、钳 pitch、写相机四元数；返回本帧朝向是否与上一帧不同（返回值在本仓无消费点）。 */
	update(): boolean {
		// yaw 归一到 [−π, π]：用 atan2(sin, cos) 做，跨越 ±π 时结果连续
		this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));

		// pitch 钳位
		const limit = this.pitchLimitRad;
		if (this.pitch > limit) this.pitch = limit;
		else if (this.pitch < -limit) this.pitch = -limit;

		// 顺序 'YXZ' 的欧拉角 → 四元数
		this.lookEuler.set(this.pitch, this.yaw, 0, 'YXZ');
		this.camera.quaternion.setFromEuler(this.lookEuler);

		const rotated = this.yaw !== this.prevYaw || this.pitch !== this.prevPitch;
		this.prevYaw = this.yaw;
		this.prevPitch = this.pitch;
		return rotated;
	}

	/**
	 * 直接写入 yaw / pitch（弧度）。
	 * @param sync 为真时立即 `update` 同步四元数，并把上一帧记录刷成当前值（传送/出生用）。
	 */
	setYawPitch(yaw: number, pitch: number, sync = true): void {
		this.yaw = yaw;
		this.pitch = pitch;
		if (sync) {
			this.update();
			this.prevYaw = this.yaw;
			this.prevPitch = this.pitch;
		}
	}

	/** 直接写相机世界坐标。 */
	setPosition(x: number, y: number, z: number): void {
		this.camera.position.set(x, y, z);
	}

	/** 按输入配置换算 pitch 限位（度 → 弧度）。 */
	applyInputConfig(cfg: InputConfig): void {
		this.pitchLimitRad = (cfg.pitchLimit * Math.PI) / 180;
	}
}
