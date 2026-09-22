/**
 * 线性雾（`THREE.Fog`）的 near / far 计算：按场景半径与相机到场景中心的距离逐帧外推，
 * 使相机远离场景时近裁剪面同步后移，场景不被整片雾化。
 *
 * 本类在本仓无装配点：`apps/debug/src/renderer/renderer-main.ts` 的 `loadScene` 不创建
 * `scene.fog`，也没有其他文件 import 它。
 */

import * as THREE from 'three';

/** 默认雾色（与默认背景色同值；可用 `LightManager` 的背景色覆盖）。 */
const DEFAULT_FOG_COLOR = 0x222222;

/**
 * 雾管理器。`update` 的两个端点：near = max(0, camDist − R/2)，far = camDist + R（R = 场景半径，
 * camDist = 相机到场景中心的距离）；far 另按 `max(far, near + 1)` 兜底。
 */
export class FogManager {
	/** 当前场景；`dispose` 后为 null。 */
	private scene: THREE.Scene | null = null;
	/** 持有的雾对象；`init` 创建，`dispose` 后为 null。 */
	private fog: THREE.Fog | null = null;
	/** 场景半径（HU）；≤ 0 的入参在 `init` 里被抬成 1。 */
	private sceneRadius = 0;
	/** 场景中心（默认原点）。 */
	private sceneCenter = new THREE.Vector3();
	/** 启用标记；为 false 时把 `scene.fog` 置 null，但 `fog` 对象保留。 */
	private enabled = true;

	/**
	 * 建雾并挂到场景上。
	 * @param scene 目标场景。
	 * @param sceneRadius 场景半径（HU）。
	 * @param sceneCenter 场景中心；省略时沿用当前值（初值为原点）。
	 * @param color 雾色：数值按 0xRRGGBB 用，字符串按去掉首位 `#` 后当十六进制解析。
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
	 * 按相机位置重算 near / far 并写回雾对象；`init` 之前（`fog` 为 null）直接返回。
	 * @param cameraPos 相机世界坐标。
	 * @param sceneRadius 新的场景半径；省略、≤ 0 或与当前值相同时不改。
	 */
	update(cameraPos: THREE.Vector3, sceneRadius?: number): void {
		if (!this.fog) return;
		if (sceneRadius !== undefined && sceneRadius > 0 && sceneRadius !== this.sceneRadius) {
			this.sceneRadius = sceneRadius;
		}

		const R = this.sceneRadius;
		const camDist = cameraPos.distanceTo(this.sceneCenter);

		// near 起于相机后方 R/2 处，far 止于相机前方 R 处
		const near = Math.max(0, camDist - R * 0.5);
		const far = camDist + R;

		// far 保底比 near 大 1，避免两端点相等或倒置
		this.fog.near = near;
		this.fog.far = Math.max(far, near + 1);
	}

	/** 改雾色：字符串按去掉首位 `#` 后当十六进制解析，数值按 0xRRGGBB 用。`init` 之前直接返回。 */
	setColor(color: number | string): void {
		if (!this.fog) return;
		if (typeof color === 'string') {
			this.fog.color.set(parseInt(color.slice(1), 16));
		} else {
			this.fog.color.set(color);
		}
	}

	/** 开关雾：同时改 `scene.fog`（开 = 挂上自有实例，关 = 置 null）。 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (this.scene) {
			this.scene.fog = enabled ? this.fog : null;
		}
	}

	/** 当前启用标记。 */
	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 当前场景半径（HU）。 */
	get currentSceneRadius(): number {
		return this.sceneRadius;
	}

	/** 摘掉 `scene.fog` 并清空两个引用；雾对象本身不额外释放。 */
	dispose(): void {
		if (this.scene) this.scene.fog = null;
		this.scene = null;
		this.fog = null;
	}
}
