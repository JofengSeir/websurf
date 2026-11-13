/**
 * `KHR_lights_punctual` 里 spot 光源的**可见光柱**（起源 `point_spotlight` / `light_spot` 的观感）。
 *
 * 背景：BSP 的 `point_spotlight` 在起源里由引擎运行时生成「可见光柱 + 动态光」，地图几何里
 * 并没有这两样东西。导出侧把它按 spot 写进 GLB（自定义字段 `vbspSpotlightWidth` /
 * `vbspSpotlightLength` 带上 `spotlightwidth` / `spotlightlength`），这里用加法混合的锥面把它
 * 画出来，避免「灯在数据里但画面里看不见」。
 *
 * 纯视觉：不参与光照计算，也不写深度（`depthWrite=false`），因此不会遮挡后面的几何。
 */
import * as THREE from 'three';

export interface PunctualSpot {
	position: [number, number, number];
	/** 单位向量，指向光线前进方向（glTF 坐标）。 */
	direction: [number, number, number];
	color: [number, number, number];
	intensity: number;
	range: number;
	innerConeAngle: number;
	outerConeAngle: number;
	/** 起源 `point_spotlight` 的 `spotlightwidth`（HU）；其余 spot 为 null。 */
	beamWidth: number | null;
	/** 起源 `point_spotlight` 的 `spotlightlength`（HU）；其余 spot 为 null。 */
	beamLength: number | null;
}

/**
 * 从 GLB 的 `KHR_lights_punctual` 扩展里取出 spot 光源数据。
 *
 * glTF 的 spot 朝向由**节点旋转**决定，但本工程的导出把方向写进了光源自定义字段
 * `direction`（见 `model_integrator::serialize_with_lights`），这里优先用它，缺省朝下。
 */
export function collectPunctualSpots(json: unknown): PunctualSpot[] {
	const root = json as {
		extensions?: { KHR_lights_punctual?: { lights?: unknown[] } };
		nodes?: { extensions?: { KHR_lights_punctual?: { light?: number } }; translation?: number[] }[];
	};
	const lights = root?.extensions?.KHR_lights_punctual?.lights;
	if (!Array.isArray(lights)) return [];

	const nodeByLight = new Map<number, { translation?: number[] }>();
	for (const node of root?.nodes ?? []) {
		const idx = node?.extensions?.KHR_lights_punctual?.light;
		if (typeof idx === 'number') nodeByLight.set(idx, node);
	}
	// 诊断：记录 GLB 里的光源总数/类型分布，便于在页面上核对导出是否生效。
	(globalThis as unknown as { __vbspGltfLightStats?: unknown }).__vbspGltfLightStats = {
		total: lights.length,
		types: lights.reduce<Record<string, number>>((acc, l) => {
			const t = String((l as { type?: string })?.type ?? '?');
			acc[t] = (acc[t] ?? 0) + 1;
			return acc;
		}, {}),
		fallsBack: lights.filter((l) => String((l as { type?: string })?.type) === 'spot').length,
		hasBeamFields: lights.filter((l) => typeof (l as { vbspSpotlightWidth?: unknown })?.vbspSpotlightWidth === 'number').length,
	};

	const out: PunctualSpot[] = [];
	for (let i = 0; i < lights.length; i++) {
		const raw = lights[i] as Record<string, unknown> | null;
		if (!raw || raw.type !== 'spot') continue;
		const node = nodeByLight.get(i);
		const t = node?.translation;
		const position: [number, number, number] =
			Array.isArray(t) && t.length === 3
				? [Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0]
				: [0, 0, 0];
		const dRaw = raw.direction as number[] | undefined;
		let direction: [number, number, number] =
			Array.isArray(dRaw) && dRaw.length === 3 ? [Number(dRaw[0]), Number(dRaw[1]), Number(dRaw[2])] : [0, -1, 0];
		// 起源 `point_spotlight` 的 `angles` 第二分量与 `light_spot` 的俯仰符号相反：
		// 地图里 `-51 270 90` 的灯座在地上、光柱朝上打到照片墙，而按 `light_spot` 解释会朝下
		// 钻进地板。这里只对带 `spotlightwidth` 的（point_spotlight）翻转竖直分量。
		const beamWidth = typeof raw.vbspSpotlightWidth === 'number' ? raw.vbspSpotlightWidth : null;
		if (beamWidth !== null) direction = [direction[0], -direction[1], direction[2]];
		const dLen = Math.hypot(direction[0], direction[1], direction[2]) || 1;
		direction = [direction[0] / dLen, direction[1] / dLen, direction[2] / dLen];

		const colorRaw = (raw.color as number[] | undefined) ?? [1, 1, 1];
		const spot = (raw.spot as { innerConeAngle?: number; outerConeAngle?: number } | undefined) ?? {};
		out.push({
			position,
			direction,
			color: [Number(colorRaw[0]) || 0, Number(colorRaw[1]) || 0, Number(colorRaw[2]) || 0],
			intensity: Number(raw.intensity) || 1,
			range: Number(raw.range) || 500,
			innerConeAngle: Number(spot.innerConeAngle) || 0,
			outerConeAngle: Number(spot.outerConeAngle) || Math.PI / 4,
			beamWidth: typeof raw.vbspSpotlightWidth === 'number' ? raw.vbspSpotlightWidth : null,
			beamLength: typeof raw.vbspSpotlightLength === 'number' ? raw.vbspSpotlightLength : null,
		});
	}
	return out;
}

/**
 * 为一组 spot 造可见光柱（Group），没有 spot 时返回 null。
 *
 * 长度取 `beamLength`（起源 `spotlightlength`）；没有该字段时用 `range * 0.6`，
 * 避免 2000+ 盏灯/长 range 场景里锥面糊满屏幕。底部半径按 `beamWidth/2` 缩放。
 */
export function buildSpotBeams(spots: PunctualSpot[]): THREE.Group | null {
	if (spots.length === 0) return null;
	const group = new THREE.Group();
	group.name = 'vbspSpotBeams';
	group.userData.isSpotBeams = true;
	// 供渲染端挑选「离相机最近的 8 盏」做直接光（见 lightmap-shader 的 setSpotLights）。
	group.userData.spots = spots;
	const up = new THREE.Vector3(0, 1, 0);

	for (const spot of spots) {
		const length = Math.max(32, spot.beamLength ?? spot.range * 0.6);
		const radius = Math.max(8, (spot.beamWidth ?? Math.tan(spot.outerConeAngle) * length * 2) / 2);
		const geo = new THREE.ConeGeometry(radius, length, 20, 1, true);
		const mat = new THREE.MeshBasicMaterial({
			color: new THREE.Color(spot.color[0], spot.color[1], spot.color[2]),
			transparent: true,
			// 光柱是「看得见的光」，太淡等于没有；太浓会糊住画面。0.14 在深色场景里可见，
			// 在亮墙前也不会盖掉贴图（加法混合，只提亮）。
			opacity: 0.14,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			side: THREE.DoubleSide,
			fog: false,
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.renderOrder = 10;
		const dir = new THREE.Vector3(spot.direction[0], spot.direction[1], spot.direction[2]);
		// ConeGeometry 的顶点在 +Y、底在 -Y：让 +Y 对准 -dir，顶点就落在灯位。
		mesh.quaternion.setFromUnitVectors(up, dir.clone().multiplyScalar(-1));
		const pos = new THREE.Vector3(spot.position[0], spot.position[1], spot.position[2]);
		mesh.position.copy(pos).addScaledVector(dir, length / 2);
		group.add(mesh);
	}
	return group;
}
