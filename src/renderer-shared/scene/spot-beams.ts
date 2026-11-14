/**
 * `KHR_lights_punctual` 里 spot 光源的**可见光柱 + 灯头光晕**。
 *
 * 起源的 `point_spotlight` 在运行时画一束可见光柱：不是 3D 锥壳，而是一条**朝向相机的
 * ribbon 四边形**（`CBeam`），沿宽度方向软边、沿长度线性淡出、贴脸时淡出，加法混合。
 * 这里按同样的做法还原（见 `source-sdk-2013` 的 `point_spotlight.cpp` / `beam_shared.cpp`）：
 * - 几何只有 2 个三角形，顶点在灯位、末端在光柱命中点；
 * - 顶点着色器在视图空间把窄带朝相机展开（`cross(axis, toEye)`），永远不退化；
 * - 片元 `pow(1-|u|,1.6) * (1-v)` 双衰减，边缘与末端都收到 0，看不到多边形硬边；
 * - 加法混合、不写深度、受深度测试遮挡（打到墙就停在墙前）。
 *
 * 灯头光晕 sprite 只给 `point_spotlight`（起源里它才带 halo）。
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

/** 起源 `beam_shared.cpp` 的 `MAX_BEAM_WIDTH`。 */
const MAX_BEAM_WIDTH = 102.3;
/** `CBeam::SetBrightness(64)` → 64/255，再加一点让它在暗场里读得出来。 */
const BEAM_PEAK = 0.32;
/** 起源 `FBEAM_SHADEOUT` 的近似：贴脸 30 HU 内淡出。 */
const SHADEOUT_DISTANCE = 30;

/**
 * 从 GLB 的 `KHR_lights_punctual` 扩展里取出 spot 光源数据。
 *
 * glTF 的 spot 朝向由**节点旋转**决定，但本工程的导出把方向写进了光源自定义字段
 * `direction`（见 `model_integrator` 的 `parse_light_direction`），这里优先用它。
 * `direction` 已经按起源 `angles` 语义换算过，这里不再翻转。
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
		const direction: [number, number, number] =
			Array.isArray(dRaw) && dRaw.length === 3 ? [Number(dRaw[0]), Number(dRaw[1]), Number(dRaw[2])] : [0, -1, 0];
		const dLen = Math.hypot(direction[0], direction[1], direction[2]) || 1;
		const dir: [number, number, number] = [direction[0] / dLen, direction[1] / dLen, direction[2] / dLen];

		const colorRaw = (raw.color as number[] | undefined) ?? [1, 1, 1];
		const spot = (raw.spot as { innerConeAngle?: number; outerConeAngle?: number } | undefined) ?? {};
		out.push({
			position,
			direction: dir,
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
 * 光柱顶点：把一条「沿本地 +Y 的窄带」在视图空间里朝相机展开（经典的 beam billboard）。
 *
 * 不依赖 CPU 每帧改 quaternion（那样单帧截屏会晚一帧、朝向不对）；`position.x = ±0.5`
 * 只表示左右，真实半宽由 `aHalf` 给出。
 */
const BEAM_VERT = `
attribute float aHalf;
varying vec2 vBeamUv;
varying vec3 vBeamWorld;
void main() {
	vBeamUv = uv;
	vec4 world = modelMatrix * vec4(position, 1.0);
	vBeamWorld = world.xyz;
	vec4 mv = viewMatrix * world;
	vec3 axisView = normalize((viewMatrix * modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
	vec3 toEye = normalize(-mv.xyz);
	vec3 side = cross(axisView, toEye);
	float len = length(side);
	side = len > 1e-4 ? side / len : vec3(1.0, 0.0, 0.0);
	mv.xyz += side * (position.x * 2.0 * aHalf);
	gl_Position = projectionMatrix * mv;
}
`;

/**
 * 光柱片元：`across` 软边 + `v` 线性长度衰减 + 贴脸淡出。
 *
 * 起源里 `CBeam` 的亮度是 64/255≈0.25、沿长度线性淡到 0、`FBEAM_SHADEOUT` 近处淡出。
 */
const BEAM_FRAG = `
uniform vec3 uColor;
uniform float uPeak;
varying vec2 vBeamUv;
varying vec3 vBeamWorld;
void main() {
	float across = abs(vBeamUv.x * 2.0 - 1.0);
	float a = uPeak * pow(max(0.0, 1.0 - across), 1.6) * (1.0 - vBeamUv.y);
	a *= smoothstep(0.0, ${SHADEOUT_DISTANCE.toFixed(1)}, distance(cameraPosition, vBeamWorld));
	if (a <= 0.001) discard;
	gl_FragColor = vec4(uColor * a, a);
}
`;

let glowTexture: THREE.Texture | null = null;

/** 径向渐变贴图（白色→透明），只建一次；多盏灯共享。 */
function getGlowTexture(): THREE.Texture {
	if (glowTexture) return glowTexture;
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(255,255,255,1)');
		g.addColorStop(0.2, 'rgba(255,255,255,0.7)');
		g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
		g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	glowTexture = tex;
	return tex;
}

/** 沿光线找光柱被什么挡住（墙），用来决定末端半宽、长度与 dlight 位置。 */
function traceBeamHit(
	origin: THREE.Vector3,
	dir: THREE.Vector3,
	length: number,
	root: THREE.Object3D | null,
): { length: number; point: THREE.Vector3 } {
	const end = origin.clone().addScaledVector(dir, length);
	if (!root) return { length, point: end };
	const ray = new THREE.Raycaster(origin.clone().addScaledVector(dir, 2), dir.clone(), 0, length + 2);
	const hits = ray.intersectObject(root, true);
	for (const h of hits) {
		if (h.distance > 2) {
			const d = Math.min(length, Math.max(24, h.distance));
			return { length: d, point: origin.clone().addScaledVector(dir, d) };
		}
	}
	return { length, point: end };
}

/**
 * 建「可见光柱 + 灯头光晕」。
 *
 * 光柱长度取 `spotlightlength`（普通 spot 用 `range` 截断），末端半宽按起源
 * `spotlightwidth` 与命中距离换算；没有 `spotlightwidth` 的 spot 用 `outerConeAngle` 推。
 */
export function buildSpotBeams(spots: PunctualSpot[], root: THREE.Object3D | null = null): THREE.Group | null {
	if (spots.length === 0) return null;
	const group = new THREE.Group();
	group.name = 'vbspSpotBeams';
	group.renderOrder = 10;

	const glow = getGlowTexture();
	const up = new THREE.Vector3(0, 1, 0);
	const dlights: { position: [number, number, number]; color: [number, number, number]; range: number }[] = [];

	for (const s of spots) {
		const isPointSpot = s.beamWidth !== null;
		const axis = new THREE.Vector3(s.direction[0], s.direction[1], s.direction[2]).normalize();
		const origin = new THREE.Vector3(s.position[0], s.position[1], s.position[2]);
		const maxLength = Math.max(48, s.beamLength ?? Math.min(s.range, 900));
		const hit = traceBeamHit(origin, axis, maxLength, root);
		const length = hit.length;
		const width = Math.min(MAX_BEAM_WIDTH, isPointSpot ? (s.beamWidth as number) : 2 * Math.tan(s.outerConeAngle) * length);
		// 起源：起点宽 = spotlightwidth，末端宽 = width × 命中距离 / spotlightlength。
		const halfStart = Math.max(2, width / 2);
		const halfEnd = Math.max(2, (width / 2) * (length / maxLength));
		const color = new THREE.Color(s.color[0], s.color[1], s.color[2]);
		// 起源 `CL_AllocDlight`：命中点往 +Z 抬 5 HU，半径 = 5.4 × 末端半宽。
		// 亮度归一化到「1 = 默认 200×5 的灯」，避免和 spot 的 intensity 量纲直接相乘爆掉。
		if (isPointSpot) {
			const k = Math.min(1.5, Math.max(0.2, s.intensity / 1000));
			dlights.push({
				position: [hit.point.x, hit.point.y + 5, hit.point.z],
				color: [s.color[0] * k, s.color[1] * k, s.color[2] * k],
				range: Math.max(48, 5.4 * halfEnd),
			});
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute(
			'position',
			new THREE.Float32BufferAttribute([
				-0.5, 0, 0,
				0.5, 0, 0,
				-0.5, length, 0,
				0.5, length, 0,
			], 3),
		);
		geometry.setAttribute('aHalf', new THREE.Float32BufferAttribute([halfStart, halfStart, halfEnd, halfEnd], 1));
		geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
		geometry.setIndex([0, 2, 1, 1, 2, 3]);

		const material = new THREE.ShaderMaterial({
			uniforms: {
				uColor: { value: color },
				uPeak: { value: BEAM_PEAK },
			},
			vertexShader: BEAM_VERT,
			fragmentShader: BEAM_FRAG,
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			fog: false,
		});

		const beam = new THREE.Mesh(geometry, material);
		beam.position.copy(origin);
		beam.quaternion.setFromUnitVectors(up, axis);
		beam.frustumCulled = false;
		beam.renderOrder = 10;
		group.add(beam);

		// 灯头辉光：起源里 `point_spotlight` 带 `light_glow03` halo。
		if (isPointSpot) {
			const spriteMat = new THREE.SpriteMaterial({
				map: glow,
				color,
				transparent: true,
				opacity: 0.25,
				depthWrite: false,
				depthTest: true,
				blending: THREE.AdditiveBlending,
				fog: false,
			});
			const sprite = new THREE.Sprite(spriteMat);
			sprite.position.copy(origin);
			sprite.scale.setScalar(Math.max(24, Math.min(MAX_BEAM_WIDTH, s.beamWidth ?? 96) * 0.5));
			sprite.renderOrder = 11;
			group.add(sprite);
		}
	}

	group.userData.spots = spots;
	group.userData.dlights = dlights;
	return group;
}
