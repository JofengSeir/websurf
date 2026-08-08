/**
 * 雾管理：基于场景半径与相机到场景中心的距离动态调整线性雾的 near/far。
 */

import * as THREE from 'three';

/** 默认雾颜色（与背景一致，由 LightManager 背景色覆盖）。 */
const DEFAULT_FOG_COLOR = 0x222222;

/**
 * 雾管理器（THREE.Fog 线性）。
 * near = max(0, camDist - sceneRadius × 0.5)，far = camDist + sceneRadius；
 * 相机远离场景时 near/far 同步外推，避免场景被完全雾化。
 */
export class FogManager {
	private scene: THREE.Scene | null = null;
	private fog: THREE.Fog | null = null;
	private sceneRadius = 0;
	private sceneCenter = new THREE.Vector3();
	private enabled = true;

	/**
	 * 初始化雾。
	 * @param scene Three.js 场景。
	 * @param sceneRadius 场景半径（包围球半径，HU）。
	 * @param sceneCenter 场景中心（可选，默认原点）。
	 * @param color 雾颜色（可选）。
	 */
	init(
		scene: THREE.Scene,
		sceneRadius: number,
		sceneCenter?: THREE.Vector3,
		color: number | string = DEFAULT_FOG_COLOR,
	): void {
		this.scene = scene;
		this.sceneRadius = sceneRadius > 0 ? sceneRadius : 1;
		if (sceneCenter) this.sceneCenter.copy(sceneCenter);

		const fogColor =
			typeof color === 'string' ? new THREE.Color(parseInt(color.slice(1), 16)) : new THREE.Color(color);
		this.fog = new THREE.Fog(fogColor, this.sceneRadius * 0.5, this.sceneRadius);
		scene.fog = this.enabled ? this.fog : null;
	}

	/**
	 * 基于相机位置动态调整 near/far。
	 * @param cameraPos 相机世界坐标。
	 * @param sceneRadius 当前场景半径（若变化则更新）。
	 */
	update(cameraPos: THREE.Vector3, sceneRadius?: number): void {
		if (!this.fog) return;
		if (sceneRadius !== undefined && sceneRadius > 0 && sceneRadius !== this.sceneRadius) {
			this.sceneRadius = sceneRadius;
		}

		const R = this.sceneRadius;
		const camDist = cameraPos.distanceTo(this.sceneCenter);

		// near：相机后方 0.5R 处起雾（近处清晰）；far：相机前方 R 处完全雾化
		const near = Math.max(0, camDist - R * 0.5);
		const far = camDist + R;

		// 防止 near >= far（极端情况）
		this.fog.near = near;
		this.fog.far = Math.max(far, near + 1);
	}

	/** 设置雾颜色。 */
	setColor(color: number | string): void {
		if (!this.fog) return;
		if (typeof color === 'string') {
			this.fog.color.set(parseInt(color.slice(1), 16));
		} else {
			this.fog.color.set(color);
		}
	}

	/** 启用/禁用雾。 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (this.scene) {
			this.scene.fog = enabled ? this.fog : null;
		}
	}

	/** 当前是否启用雾。 */
	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 当前场景半径。 */
	get currentSceneRadius(): number {
		return this.sceneRadius;
	}

	/** 释放资源。 */
	dispose(): void {
		if (this.scene) this.scene.fog = null;
		this.scene = null;
		this.fog = null;
	}
}
