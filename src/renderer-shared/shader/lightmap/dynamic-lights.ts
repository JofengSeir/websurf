import * as THREE from 'three';

// spot 光源（起源 `point_spotlight` / `light_spot`）的有界直接光
// ---------------------------------------------------------------------------
//
// 烘焙 lightmap 只含**静态灯**的贡献；`point_spotlight` 由引擎运行时生成，烘焙里没有。
// 这里按「最多 8 盏、按相机距离挑最近的」把它加成直接光：锥内 + 距离衰减 + 朗伯项。
//
// 法线取片元导数叉积（世界材质是 MeshBasicMaterial，几何上没有 normal 属性，合并块也没有），
// 用 `abs(dot)` 双面接受——墙面/薄板不会因为朝向判反而丢掉光。
const SPOT_MAX = 8;
/** 起源 `point_spotlight` 命中点会额外分配一盏 dlight（宽而软的光斑），最多同时 2 盏。 */
const DLIGHT_MAX = 2;

const spotUniforms = {
	vbspSpotCount: { value: 0 },
	vbspSpotPos: { value: Array.from({ length: SPOT_MAX }, () => new THREE.Vector3()) },
	vbspSpotDir: { value: Array.from({ length: SPOT_MAX }, () => new THREE.Vector3(0, -1, 0)) },
	vbspSpotColor: { value: Array.from({ length: SPOT_MAX }, () => new THREE.Color(0, 0, 0)) },
	vbspSpotRange: { value: new Float32Array(SPOT_MAX) },
	vbspSpotCosOuter: { value: new Float32Array(SPOT_MAX) },
	vbspSpotCosInner: { value: new Float32Array(SPOT_MAX) },
	vbspSpotScale: { value: 0.0010 },
	vbspDLightCount: { value: 0 },
	vbspDLightPos: { value: Array.from({ length: DLIGHT_MAX }, () => new THREE.Vector3()) },
	vbspDLightColor: { value: Array.from({ length: DLIGHT_MAX }, () => new THREE.Color(0, 0, 0)) },
	vbspDLightRange: { value: new Float32Array(DLIGHT_MAX) },
	// dlight 强度倍率。起源的 dlight 在 HDR + tonemap 之后只是一层淡光；我们直接把加色
	// 叠在烘焙结果上。0.35→0.18 的 A/B（`cand_c` 机位，`.tmp/look_base_dlight.png` vs
	// `.tmp/look_dlight018.png`）只改变 1.1% 像素，集中在光柱根部亮斑 —— 根部明显更接近
	// 实机参考的柔和感，其余地面来自烘焙 lightmap、不受影响，故取 0.18。
	vbspDLightScale: { value: 0.18 },
};

/**
 * 诊断用：直接改 spot 直接光的全局强度（0 = 关闭）。
 * 供页面里做「开灯 / 关灯」的 A/B 截图，不参与正式逻辑。
 */
export function setSpotScale(v: number): void {
	spotUniforms.vbspSpotScale.value = v;
}
if (typeof window !== 'undefined') {
	(window as unknown as { __vbspSetSpotScale?: (v: number) => void }).__vbspSetSpotScale = setSpotScale;
}

/** 供渲染端每帧/每次可见性更新时调用：填入离相机最近的 spot。 */
export interface SpotLightInput {
	position: [number, number, number];
	direction: [number, number, number];
	color: [number, number, number];
	intensity: number;
	range: number;
	cosOuter: number;
	cosInner: number;
}

export function setSpotLights(list: SpotLightInput[]): void {
	const n = Math.min(SPOT_MAX, list.length);
	for (let i = 0; i < n; i++) {
		const s = list[i];
		spotUniforms.vbspSpotPos.value[i].set(s.position[0], s.position[1], s.position[2]);
		spotUniforms.vbspSpotDir.value[i].set(s.direction[0], s.direction[1], s.direction[2]);
		// 颜色 × 亮度：导出侧 intensity = brightness × 5（来源 `_light` 第 4 个数）。
		spotUniforms.vbspSpotColor.value[i].setRGB(
			s.color[0] * s.intensity,
			s.color[1] * s.intensity,
			s.color[2] * s.intensity,
		);
		spotUniforms.vbspSpotRange.value[i] = s.range;
		spotUniforms.vbspSpotCosOuter.value[i] = s.cosOuter;
		spotUniforms.vbspSpotCosInner.value[i] = s.cosInner;
	}
	spotUniforms.vbspSpotCount.value = n;
}

/** 供渲染端：填入 `point_spotlight` 命中点的 dlight（宽而软的光斑）。 */
export interface DLightInput {
	position: [number, number, number];
	color: [number, number, number];
	range: number;
}

export function setDLights(list: DLightInput[]): void {
	const n = Math.min(DLIGHT_MAX, list.length);
	for (let i = 0; i < n; i++) {
		const d = list[i];
		spotUniforms.vbspDLightPos.value[i].set(d.position[0], d.position[1], d.position[2]);
		spotUniforms.vbspDLightColor.value[i].setRGB(d.color[0], d.color[1], d.color[2]);
		spotUniforms.vbspDLightRange.value[i] = d.range;
	}
	spotUniforms.vbspDLightCount.value = n;
}
export {
  SPOT_MAX, DLIGHT_MAX, spotUniforms,
}
