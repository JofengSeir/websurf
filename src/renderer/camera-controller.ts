/**
 * 相机角度同步器：将 yaw/pitch（弧度）同步到相机 quaternion。
 * 鼠标输入在主线程过滤后发给 Worker 写入 PlayerController，本类不做输入处理。
 * 约束：pitch clamp ±89°（防 gimbal lock）、yaw 归一化到 [-π, π]（防精度损失）、
 * 生成 quaternion 必须用 'YXZ' 顺序。
 */

import * as THREE from 'three';
import type { InputConfig } from '../config.js';

/**
 * 相机角度同步器。
 *
 * yaw=0 朝 -Z（Three.js 默认）；正 yaw 绕 Y 顺时针（鼠标右转）。
 * pitch=0 水平；正 pitch 仰视。
 */
export class CameraController {
	readonly camera: THREE.PerspectiveCamera;

	/** 当前 yaw（弧度，[-π, π]）。 */
	yaw = 0;
	/** 当前 pitch（弧度，[-pitchLimitRad, pitchLimitRad]）。 */
	pitch = 0;
	/** pitch 限位（弧度，默认 ±89°，cs-movement PITCH_CLAMP）。 */
	pitchLimitRad: number;

	/** 复用 Euler 对象（YXZ 顺序）。 */
	private readonly lookEuler: THREE.Euler;
	/** 上一帧的 yaw/pitch（用于检测是否旋转）。 */
	private prevYaw = 0;
	private prevPitch = 0;

	constructor(camera: THREE.PerspectiveCamera, inputCfg?: InputConfig) {
		this.camera = camera;
		this.lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
		this.pitchLimitRad = ((inputCfg?.pitchLimit ?? 89) * Math.PI) / 180;
	}

	/** 每帧更新：归一化 yaw、clamp pitch、同步 quaternion（YXZ）。@returns 是否发生旋转。 */
	update(): boolean {
		// yaw 归一化到 [-π, π]（atan2 方式，无边界 bug）
		this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));

		// pitch clamp
		const limit = this.pitchLimitRad;
		if (this.pitch > limit) this.pitch = limit;
		else if (this.pitch < -limit) this.pitch = -limit;

		// YXZ Euler → quaternion
		this.lookEuler.set(this.pitch, this.yaw, 0, 'YXZ');
		this.camera.quaternion.setFromEuler(this.lookEuler);

		const rotated = this.yaw !== this.prevYaw || this.pitch !== this.prevPitch;
		this.prevYaw = this.yaw;
		this.prevPitch = this.pitch;
		return rotated;
	}

	/**
	 * 直接设置 yaw/pitch（弧度）并同步 quaternion。
	 * @param sync 是否立即同步（默认 true，传送/出生时用）。
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

	/** 直接设置相机位置。 */
	setPosition(x: number, y: number, z: number): void {
		this.camera.position.set(x, y, z);
	}

	/** 从输入配置更新 pitch 限位。 */
	applyInputConfig(cfg: InputConfig): void {
		this.pitchLimitRad = (cfg.pitchLimit * Math.PI) / 180;
	}
}
