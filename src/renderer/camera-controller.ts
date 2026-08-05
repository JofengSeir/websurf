/**
 * 相机角度同步器
 *
 * 职责：仅将 yaw/pitch（弧度）同步到 Three.js PerspectiveCamera 的 quaternion。
 * 不处理鼠标输入——鼠标输入由主线程 MouseBuffer（突变检测 + discardNext）过滤后，
 * 通过 input 消息发送到 Worker，由 RenderLoop.applyMouseDelta 直接写入
 * PlayerController.yaw/pitch（度），再由本类同步到相机 quaternion。
 *
 * 关键约束（project_memory）：
 * - pitch clamp ±89°（cs-movement PITCH_CLAMP，防 gimbal lock）
 * - yaw 归一化到 [-π, π]（防 Float32 精度损失）
 * - 从 yaw/pitch 生成 quaternion 时必须使用 'YXZ' 顺序
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

	/**
	 * 每帧更新：归一化 yaw，clamp pitch，同步相机 quaternion（YXZ）。
	 *
	 * @returns 是否发生旋转（与上一帧 yaw/pitch 不同）。
	 */
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
	 * 直接设置 yaw/pitch（弧度）并立即同步 quaternion。
	 *
	 * @param yaw yaw（弧度）。
	 * @param pitch pitch（弧度）。
	 * @param sync 是否立即同步 quaternion（默认 true，传送/出生时用）。
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
