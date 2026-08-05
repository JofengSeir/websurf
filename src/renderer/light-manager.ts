/**
 * 灯光管理
 *
 * 管理三类灯光：
 * - 基础环境光：AmbientLight + HemisphereLight + DirectionalLight（球坐标定位）
 * - glTF KHR_lights_punctual 点光源：只保留最近 8 个（WebGL uniform 上限约束）
 *
 * 关键约束（project_memory）：
 * - ≤8 点光源（max_point_lights）
 * - DirectionalLight 位置由球坐标（azimuth/elevation/distance）→ 笛卡尔
 */

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RuntimeConfig } from '../config.js';

/** 颜色字段统一接受 number 或 `#rrggbb` 字符串。 */
type ColorInput = number | string;

/** 灯光更新参数：颜色字段放宽为 ColorInput，强度/角度字段保持 number，全部可选。 */
export interface LightingUpdateParams {
	ambientColor?: ColorInput;
	ambientIntensity?: number;
	hemiSkyColor?: ColorInput;
	hemiGroundColor?: ColorInput;
	hemiIntensity?: number;
	dirColor?: ColorInput;
	dirIntensity?: number;
	dirAzimuth?: number;
	dirElevation?: number;
	bgColor?: ColorInput;
}

/** WebGL uniform 上限：最多 8 个点光源。 */
const MAX_POINT_LIGHTS = 8;

/** DirectionalLight 距场景中心的距离（仅用于定位，方向光无衰减）。 */
const DIR_LIGHT_DISTANCE = 5000;

/**
 * 灯光管理器。
 *
 * 持有基础灯光（Ambient/Hemisphere/Directional）与最多 8 个 PointLight 池。
 * 点光源从 glTF KHR_lights_punctual 提取，按到参考点的距离排序后取最近 8 个。
 */
export class LightManager {
	private scene: THREE.Scene | null = null;
	private ambient: THREE.AmbientLight | null = null;
	private hemi: THREE.HemisphereLight | null = null;
	private dir: THREE.DirectionalLight | null = null;

	/** 点光源池（固定大小 MAX_POINT_LIGHTS，按需启用/禁用）。 */
	private readonly pointLights: THREE.PointLight[] = [];
	/** 当前启用的点光源数量。 */
	private activePointCount = 0;

	/** 方向光球坐标参数（度 / HU）。 */
	private dirAzimuth = 45;
	private dirElevation = 45;
	private dirDistance = DIR_LIGHT_DISTANCE;

	/** 已提取的全部点光源候选（来自 glTF），按需重排取最近 8 个。 */
	private pointCandidates: PointLightCandidate[] = [];

	constructor() {
		// 预分配点光源池
		for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
			const pl = new THREE.PointLight(0xffffff, 0, 0, 2);
			pl.visible = false;
			this.pointLights.push(pl);
		}
	}

	/**
	 * 初始化基础灯光并加入场景。
	 *
	 * @param scene Three.js 场景。
	 * @param config 运行时配置（读取 lighting 段）。
	 */
	applyLights(scene: THREE.Scene, config: RuntimeConfig): void {
		this.scene = scene;
		const lc = config.lighting;

		this.ambient = new THREE.AmbientLight(lc.ambientColor, lc.ambientIntensity);
		scene.add(this.ambient);

		this.hemi = new THREE.HemisphereLight(
			lc.hemiSkyColor,
			lc.hemiGroundColor,
			lc.hemiIntensity,
		);
		scene.add(this.hemi);

		this.dir = new THREE.DirectionalLight(lc.dirColor, lc.dirIntensity);
		scene.add(this.dir);
		scene.add(this.dir.target);

		this.dirAzimuth = lc.dirAzimuth;
		this.dirElevation = lc.dirElevation;
		this.updateDirPosition();

		// 点光源池加入场景（初始不可见）
		for (const pl of this.pointLights) {
			scene.add(pl);
		}

		// 应用背景色
		scene.background = new THREE.Color(lc.bgColor);
	}

	/**
	 * 从 glTF KHR_lights_punctual 提取点光源候选。
	 *
	 * 读取 `parser.json.extensions.KHR_lights_punctual.lights` 与节点引用，
	 * 计算每个点光源的世界坐标，存入候选列表。后续 `updatePointLights(refPos)`
	 * 按距离取最近 8 个启用。
	 *
	 * @param gltf GLTF 解析结果。
	 * @returns 提取的点光源候选数量。
	 */
	extractPointLights(gltf: GLTF): number {
		this.pointCandidates.length = 0;

		const json = (gltf.parser?.json ?? {}) as {
			extensions?: { KHR_lights_punctual?: { lights?: RawGltfLight[] } };
			nodes?: RawGltfNode[];
			scenes?: { nodes?: number[] }[];
		};

		const ext = json.extensions?.KHR_lights_punctual;
		if (!ext?.lights || !json.nodes) {
			return 0;
		}
		const lights = ext.lights;
		const nodes = json.nodes;

		// 构建节点 worldMatrix：glTF scene 根节点 → 递归累积 transform
		// 为避免重复遍历，先收集所有引用 point light 的节点索引
		const candidates: PointLightCandidate[] = [];
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const lightRef = node?.extensions?.KHR_lights_punctual?.light;
			if (lightRef === undefined || lightRef === null) continue;
			const lightDef = lights[lightRef];
			if (!lightDef || lightDef.type !== 'point') continue;

			const worldPos = computeNodeWorldPosition(json, i);
			if (!worldPos) continue;

			candidates.push({
				position: worldPos,
				color: lightDef.color ?? [1, 1, 1],
				intensity: lightDef.intensity ?? 1,
				range: lightDef.range ?? 0,
			});
		}

		this.pointCandidates = candidates;
		return candidates.length;
	}

	/**
	 * 根据参考位置更新点光源池：取最近 8 个候选启用，其余禁用。
	 *
	 * @param refPos 参考位置（通常是相机位置）。
	 */
	updatePointLights(refPos: THREE.Vector3): void {
		if (this.pointCandidates.length === 0) {
			this.disableAllPointLights();
			return;
		}

		// 按到 refPos 的距离平方排序
		const ranked = this.pointCandidates
			.map((c) => ({
				c,
				distSq:
					(c.position[0] - refPos.x) ** 2 +
					(c.position[1] - refPos.y) ** 2 +
					(c.position[2] - refPos.z) ** 2,
			}))
			.sort((a, b) => a.distSq - b.distSq);

		const count = Math.min(MAX_POINT_LIGHTS, ranked.length);
		for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
			const pl = this.pointLights[i];
			if (i < count) {
				const r = ranked[i].c;
				pl.color.setRGB(r.color[0], r.color[1], r.color[2]);
				pl.intensity = r.intensity;
				pl.distance = r.range > 0 ? r.range : 0;
				pl.position.set(r.position[0], r.position[1], r.position[2]);
				pl.visible = true;
			} else {
				pl.visible = false;
				pl.intensity = 0;
			}
		}
		this.activePointCount = count;
	}

	/** 禁用全部点光源。 */
	private disableAllPointLights(): void {
		for (const pl of this.pointLights) {
			pl.visible = false;
			pl.intensity = 0;
		}
		this.activePointCount = 0;
	}

	/**
	 * 更新灯光参数（对应 render-worker.js applyLighting）。
	 *
	 * 接受部分 lighting 字段（hex 颜色用 `#rrggbb` 字符串或 number），
	 * 未提供的字段保持不变。
	 */
	updateLighting(params: Partial<LightingUpdateParams>): void {
		if (!this.scene || !this.ambient || !this.hemi || !this.dir) return;

		if (params.ambientIntensity !== undefined) {
			this.ambient.intensity = params.ambientIntensity;
		}
		if (params.ambientColor !== undefined) {
			this.ambient.color = toColor(params.ambientColor, this.ambient.color);
		}
		if (params.hemiIntensity !== undefined) {
			this.hemi.intensity = params.hemiIntensity;
		}
		if (params.hemiSkyColor !== undefined) {
			this.hemi.color = toColor(params.hemiSkyColor, this.hemi.color);
		}
		if (params.hemiGroundColor !== undefined) {
			this.hemi.groundColor = toColor(params.hemiGroundColor, this.hemi.groundColor);
		}
		if (params.dirIntensity !== undefined) {
			this.dir.intensity = params.dirIntensity;
		}
		if (params.dirColor !== undefined) {
			this.dir.color = toColor(params.dirColor, this.dir.color);
		}
		if (params.dirAzimuth !== undefined) {
			this.dirAzimuth = params.dirAzimuth;
			this.updateDirPosition();
		}
		if (params.dirElevation !== undefined) {
			this.dirElevation = params.dirElevation;
			this.updateDirPosition();
		}
		if (params.bgColor !== undefined) {
			this.scene.background = toColor(params.bgColor, null);
		}
	}

	/** 从配置同步全部灯光参数（配置 patch 后批量应用）。 */
	syncFromConfig(config: RuntimeConfig): void {
		const lc = config.lighting;
		this.updateLighting({
			ambientColor: lc.ambientColor,
			ambientIntensity: lc.ambientIntensity,
			hemiSkyColor: lc.hemiSkyColor,
			hemiGroundColor: lc.hemiGroundColor,
			hemiIntensity: lc.hemiIntensity,
			dirColor: lc.dirColor,
			dirIntensity: lc.dirIntensity,
			dirAzimuth: lc.dirAzimuth,
			dirElevation: lc.dirElevation,
			bgColor: lc.bgColor,
		});
	}

	/**
	 * 方向光位置更新（球坐标 → 笛卡尔）。
	 *
	 * azimuth（方位角，度）+ elevation（仰角，度）+ distance → (x,y,z)。
	 * DirectionalLight 从 position 朝 target（原点）照射。
	 */
	updateDirPosition(): void {
		if (!this.dir) return;
		const azRad = (this.dirAzimuth * Math.PI) / 180;
		const elRad = (this.dirElevation * Math.PI) / 180;
		const r = this.dirDistance;
		const x = r * Math.cos(elRad) * Math.cos(azRad);
		const y = r * Math.sin(elRad);
		const z = r * Math.cos(elRad) * Math.sin(azRad);
		this.dir.position.set(x, y, z);
	}

	/** 当前启用的点光源数量。 */
	get activePointLightCount(): number {
		return this.activePointCount;
	}

	/** 释放资源（从场景移除灯光）。 */
	dispose(): void {
		if (!this.scene) return;
		if (this.ambient) this.scene.remove(this.ambient);
		if (this.hemi) this.scene.remove(this.hemi);
		if (this.dir) {
			this.scene.remove(this.dir);
			this.scene.remove(this.dir.target);
		}
		for (const pl of this.pointLights) this.scene.remove(pl);
		this.scene = null;
	}
}

// ---------------------------------------------------------------------------
// 辅助类型与函数
// ---------------------------------------------------------------------------

interface PointLightCandidate {
	position: [number, number, number];
	color: [number, number, number];
	intensity: number;
	range: number;
}

interface RawGltfLight {
	type?: string;
	color?: [number, number, number];
	intensity?: number;
	range?: number;
}

interface RawGltfNode {
	translation?: [number, number, number];
	rotation?: [number, number, number, number];
	scale?: [number, number, number];
	matrix?: number[];
	children?: number[];
	extensions?: { KHR_lights_punctual?: { light?: number } };
}

/** 将 ColorInput（number | `#rrggbb`）转为 THREE.Color。 */
function toColor(input: ColorInput, fallback: THREE.Color | null): THREE.Color {
	if (typeof input === 'number') {
		return new THREE.Color(input);
	}
	if (typeof input === 'string') {
		return new THREE.Color(parseInt(input.slice(1), 16));
	}
	return fallback ?? new THREE.Color(0xffffff);
}

/**
 * 计算 glTF 节点的世界坐标（递归累积 translation/rotation/scale/matrix）。
 *
 * 简化处理：仅累积 translation 与 matrix（点光源节点通常无旋转/缩放，
 * 且我们只需要位置）。若节点有 matrix，直接用 matrix 的平移分量。
 */
function computeNodeWorldPosition(
	json: { nodes?: RawGltfNode[]; scenes?: { nodes?: number[] }[] },
	nodeIdx: number,
): [number, number, number] | null {
	const nodes = json.nodes;
	if (!nodes || nodeIdx < 0 || nodeIdx >= nodes.length) return null;

	// 收集从根到该节点的路径
	const parentMap = new Map<number, number>();
	const visited = new Set<number>();
	const stack: number[] = [];

	// BFS 从 scene roots 建立父节点映射
	const roots = json.scenes?.[0]?.nodes ?? [];
	for (const r of roots) stack.push(r);
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (visited.has(cur)) continue;
		visited.add(cur);
		const node = nodes[cur];
		if (node?.children) {
			for (const c of node.children) {
				if (!visited.has(c)) {
					parentMap.set(c, cur);
					stack.push(c);
				}
			}
		}
	}

	// 从目标节点回溯到根，收集路径
	const path: number[] = [];
	let cur: number | undefined = nodeIdx;
	const guard = new Set<number>();
	while (cur !== undefined && !guard.has(cur)) {
		guard.add(cur);
		path.push(cur);
		cur = parentMap.get(cur);
	}

	// 累积平移
	const pos = new THREE.Vector3();
	const tmpMat = new THREE.Matrix4();
	for (let i = path.length - 1; i >= 0; i--) {
		const node = nodes[path[i]];
		if (!node) continue;
		if (node.matrix) {
			tmpMat.fromArray(node.matrix);
			pos.applyMatrix4(tmpMat);
		} else {
			if (node.translation) {
				pos.x += node.translation[0];
				pos.y += node.translation[1];
				pos.z += node.translation[2];
			}
			// 点光源节点通常无旋转/缩放影响位置；若需要可扩展
		}
	}

	return [pos.x, pos.y, pos.z];
}
