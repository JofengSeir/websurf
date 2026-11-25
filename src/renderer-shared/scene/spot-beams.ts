/**
 * `KHR_lights_punctual` 里 spot 光源的**可见光柱 + 灯头光晕 + 运行期父级跟随**。
 *
 * 起源的 `point_spotlight` 在运行时画一束可见光柱：不是硬边 3D 锥壳，而是一条**朝向相机的
 * ribbon 四边形**（`CBeam`），带热灯丝核心与柔和体积光锥外晕、掠射消隐与距离淡出，加法混合。
 * 通用特性：
 * - 从 `KHR_lights_punctual` 读取真实 `rendercolor`、`vbspEntityIndex`、`vbspParentName`、`vbspSpawnFlags`；
 * - 从紧致底座 `halfStart` 随距离张开为广角柔边光锥 `halfEnd`，不再出现灯头大矩形块；
 * - 若带 `parentname`（例如挂在 `func_movelinear` / `func_rotating` / `func_door` 上的车载/机械射灯），
 *   通过 `SpotBeamRig` 实时跟随祖先实体的平移与旋转，同时驱动光束几何、`SpotLightSelector` 与 `dlight` 光斑。
 */
import * as THREE from 'three';
import type { EntityBlockRecords } from './particles.js';

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
	/** BSP 实体枚举下标；缺失时为 null。 */
	entityIndex: number | null;
	/** 父实体 targetname（如车载旋转/平移动台）；缺失时为 null。 */
	parentName: string | null;
	/** `point_spotlight` spawnflags（bit0=Start On, bit1=No Dynamic Light）；缺失时为 null。 */
	spawnFlags: number | null;
}

const MAX_BEAM_WIDTH = 102.3;
/** 柔和体积散射基准亮度：侧视可见度充足且无尖锐高亮芯。 */
const BEAM_PEAK = 0.46;
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
			entityIndex: typeof raw.vbspEntityIndex === 'number' ? raw.vbspEntityIndex : null,
			parentName: typeof raw.vbspParentName === 'string' && raw.vbspParentName !== '' ? raw.vbspParentName : null,
			spawnFlags: typeof raw.vbspSpawnFlags === 'number' ? raw.vbspSpawnFlags : null,
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
varying float vViewFade;
void main() {
	vBeamUv = uv;
	vec4 world = modelMatrix * vec4(position, 1.0);
	vBeamWorld = world.xyz;
	vec4 mv = viewMatrix * world;
	vec3 axisView = normalize((viewMatrix * modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
	vec3 toEye = normalize(-mv.xyz);
	vec3 side = cross(axisView, toEye);
	float len = length(side);
	vViewFade = smoothstep(0.04, 0.32, len);
	side = len > 1e-4 ? side / len : vec3(1.0, 0.0, 0.0);
	mv.xyz += side * (position.x * 2.0 * aHalf);
	gl_Position = projectionMatrix * mv;
}
`;

/**
 * 体积射灯光锥片元：柔和大气散射 + 仅在灯口极短距离保留微弱白芯 + 掠角/贴脸淡出。
 */
const BEAM_FRAG = `
uniform vec3 uColor;
uniform float uPeak;
varying vec2 vBeamUv;
varying vec3 vBeamWorld;
varying float vViewFade;
void main() {
	float across = abs(vBeamUv.x * 2.0 - 1.0);
	float edgeMask = max(0.0, 1.0 - across * across);
	float scatter = exp(-across * across * 2.4) * edgeMask * edgeMask;
	float mouthHot = exp(-vBeamUv.y * 10.0) * exp(-across * across * 5.0);
	float along = smoothstep(0.0, 0.008, vBeamUv.y) * pow(max(0.0, 1.0 - vBeamUv.y), 2.15);
	float camFade = smoothstep(0.0, ${SHADEOUT_DISTANCE.toFixed(1)}, distance(cameraPosition, vBeamWorld));
	float a = uPeak * (scatter * 0.85 + mouthHot * 0.35) * along * camFade * vViewFade;
	if (a <= 0.001) discard;
	vec3 tint = mix(uColor, vec3(1.0), mouthHot * 0.45);
	gl_FragColor = vec4(tint * a, a);
}
`;

/**
 * 屏幕空间光学镜头炫光：
 * - 结合光源朝向与准星夹角（aimFactor），仅在正对灯头且靠近屏幕中心时展开覆盖大半视口的柔和致盲泛光、
 *   大幅彩虹色散衍射弧、非均匀多谐波星芒与水平拉丝；
 * - 未正对时保持紧凑小光斑，极大节省像素填充开销；
 * - 遮挡检测走 Rust WASM 空间网格 physTrace（~0.005ms，无 JS 三角形遍历卡顿）。
 */
const GLARE_VERT = `
uniform vec3 uSpotDir;
uniform float uAspect;
varying vec2 vUv;
varying vec2 vNdc;
varying float vFacing;
varying float vBulb;
varying float vGlare;
varying float vCamFade;
void main() {
	vUv = uv;
	vec4 worldOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	vec3 toCam = cameraPosition - worldOrigin.xyz;
	float dist = max(1.0, length(toCam));
	vec3 viewDir = toCam / dist;
	vFacing = dot(normalize(uSpotDir), viewDir);
	vCamFade = smoothstep(0.0, ${SHADEOUT_DISTANCE.toFixed(1)}, dist);
	vec4 clip = projectionMatrix * viewMatrix * worldOrigin;
	if (clip.w <= 0.1) {
		vNdc = vec2(2.0);
		vBulb = 0.0;
		vGlare = 0.0;
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		return;
	}
	vec2 ndc = clip.xy / clip.w;
	vNdc = ndc;
	float aimFactor = exp(-dot(ndc, ndc) * 1.4);
	// 0° 起连续非线性爬升：灯头球亮度先温和亮起，光学星芒/彩虹炫光随后在更大倾角加速绽放。
	float fwd = max(0.0, vFacing);
	vBulb = pow(fwd, 1.8);
	vGlare = pow(fwd, 3.2) * (0.30 + 0.70 * aimFactor);
	float distScale = clamp(420.0 / (dist + 180.0), 0.45, 1.15);
	float scale = mix(0.22 * distScale, 1.15, vGlare);
	vec2 halfExt = vec2(scale / max(0.5, uAspect), scale);
	gl_Position = vec4(ndc + position.xy * 2.0 * halfExt, 0.0, 1.0);
}
`;

const GLARE_FRAG = `
uniform vec3 uColor;
uniform float uGain;
uniform float uVis;
uniform float uSeed;
varying vec2 vUv;
varying vec2 vNdc;
varying float vFacing;
varying float vBulb;
varying float vGlare;
varying float vCamFade;
void main() {
	if (uVis <= 0.002) discard;
	vec2 p = vUv * 2.0 - 1.0;
	float r2 = dot(p, p);
	if (r2 >= 1.0) discard;
	float r = sqrt(r2);
	float edge = 1.0 - r2;
	float edge2 = edge * edge;

	float pinpoint = exp(-r2 * 140.0);
	float innerHalo = exp(-r2 * 9.0) * 0.24 + exp(-r2 * 3.2) * edge2 * 0.14;
	float veiling = exp(-r2 * 1.35) * 0.22 * vGlare * edge;

	float ang = atan(p.y, p.x) + uSeed + vNdc.x * 0.45 - vNdc.y * 0.35;
	float h1 = pow(abs(cos(ang * 3.0 + 0.4)), 24.0);
	float h2 = pow(abs(cos(ang * 5.0 - 1.1)), 18.0) * 0.65;
	float h3 = pow(abs(cos(ang * 7.0 + 2.3)), 28.0) * 0.50;
	float h4 = pow(abs(cos(ang * 11.0 - 0.7)), 32.0) * 0.35;
	float rayMod = 0.65 + 0.35 * sin(ang * 3.0 + uSeed * 6.28);
	float rays = (h1 + h2 + h3 + h4) * rayMod * exp(-r * 2.8) * smoothstep(0.01, 0.06, r) * edge;

	float streak = exp(-p.y * p.y * 65.0) * exp(-p.x * p.x * 2.2) * edge;

	float sideMask = smoothstep(0.10, 0.65, abs(p.x)) * exp(-p.y * p.y * 2.1) * edge;
	vec3 arcPrimary = vec3(
		exp(-pow((r - 0.56) * 11.0, 2.0)),
		exp(-pow((r - 0.62) * 11.0, 2.0)),
		exp(-pow((r - 0.68) * 11.0, 2.0))
	);
	vec3 arcOuter = vec3(
		exp(-pow((r - 0.78) * 14.0, 2.0)),
		exp(-pow((r - 0.82) * 14.0, 2.0)),
		exp(-pow((r - 0.86) * 14.0, 2.0))
	) * 0.45;
	vec3 rainbow = (arcPrimary + arcOuter) * sideMask * 0.40 * vGlare;

	float sideBase = mix(0.14, 0.42, smoothstep(-0.25, 0.15, vFacing));
	float baseTerm = innerHalo * (sideBase + 0.30 * vBulb) + pinpoint * (0.28 + 0.32 * vBulb) + veiling;
	float opticalTerm = (rays * 0.46 + streak * 0.26) * vGlare;

	vec3 baseTint = mix(uColor, vec3(1.0), clamp(pinpoint * 0.90 + veiling * 0.45, 0.0, 1.0));
	vec3 rayTint = mix(uColor, vec3(0.90, 0.95, 1.0), 0.58);
	vec3 arcTint = mix(vec3(1.0), uColor, 0.28);
	vec3 col = baseTint * baseTerm + rayTint * opticalTerm + rainbow * arcTint;
	col *= uGain * vCamFade * uVis;
	col = col / (1.0 + col * 0.35);
	if (max(col.r, max(col.g, col.b)) <= 0.002) discard;
	gl_FragColor = vec4(col, 1.0);
}
`;

export interface SpotDLightEntry {
	position: [number, number, number];
	color: [number, number, number];
	range: number;
}

interface RigEntry {
	spot: PunctualSpot;
	dlight: SpotDLightEntry | null;
	beam: THREE.Mesh;
	glare: THREE.Mesh;
	baseOrigin: THREE.Vector3;
	baseDir: THREE.Vector3;
	length: number;
	ancestors: number[];
	baseVisible: boolean;
	cluster: number;
	visTarget: number;
	visCurrent: number;
	lastCheckAt: number;
}

interface AncestorMeta {
	pivot: THREE.Vector3;
}

const ZERO_VEC3: readonly [number, number, number] = [0, 0, 0];

function parseOriginTuple(raw: unknown): THREE.Vector3 {
	if (typeof raw !== 'string') return new THREE.Vector3();
	const p = raw.trim().split(/\s+/).map(Number);
	if (p.length < 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
		return new THREE.Vector3();
	}
	// Source [x, y, z] → 本仓 Y-up [y, z, x]
	return new THREE.Vector3(p[1], p[2], p[0]);
}

/**
 * 通用父级射灯刚体跟随控制器：把 `parentname` 绑定到实时移动/旋转的动态实体上，
 * 同步更新体积光锥（beam）、灯头光晕（sprite）、聚光直接光（spot）与地面光斑（dlight）。
 */
export class SpotBeamRig {
	private readonly entries: RigEntry[] = [];
	private readonly byAncestor = new Map<number, RigEntry[]>();
	private readonly ancestorMeta = new Map<number, AncestorMeta>();
	private readonly offsets = new Map<number, readonly [number, number, number]>();
	private readonly rotations = new Map<number, readonly [number, number, number]>();
	private readonly tmpPos = new THREE.Vector3();
	private readonly tmpDir = new THREE.Vector3();
	private readonly tmpPivot = new THREE.Vector3();
	private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'XYZ');
	private readonly tmpQuat = new THREE.Quaternion();
	private readonly upAxis = new THREE.Vector3(0, 1, 0);
	private readonly camForward = new THREE.Vector3();
	private readonly tmpTarget = new THREE.Vector3();
	private cursor = 0;
	private lastOcclAt = 0;

	/** @internal 装配期登记一条射灯实例。 */
	addEntry(entry: RigEntry): void {
		this.entries.push(entry);
	}

	/** 节流视线遮挡检测（走 Rust WASM 物理空间网格，每帧最多 1 次，冷却 ≥80ms）+ PVS 可见性剔除。 */
	updateOcclusion(
		camera: THREE.Camera,
		physTrace: ((start: THREE.Vector3, end: THREE.Vector3) => number) | null,
		nowMs: number,
		pvs: { isVisible(clusterId: number): boolean; getClusterAt(p: { x: number; y: number; z: number }): number } | null = null,
	): void {
		const dt = this.lastOcclAt > 0 ? Math.min(0.1, (nowMs - this.lastOcclAt) / 1000) : 1 / 60;
		this.lastOcclAt = nowMs;
		const len = this.entries.length;
		if (len === 0) return;

		const aspect = (camera as THREE.PerspectiveCamera).aspect || 16 / 9;
		camera.getWorldPosition(this.tmpPos);
		camera.getWorldDirection(this.camForward);
		let checked = false;
		for (let step = 0; step < len; step++) {
			const idx = (this.cursor + step) % len;
			const entry = this.entries[idx];
			if (!entry.baseVisible) {
				entry.beam.visible = false;
				entry.glare.visible = false;
				entry.visTarget = 0;
				continue;
			}
			const gp = entry.glare.position;
			if (pvs) {
				let cl = entry.cluster;
				if (entry.ancestors.length > 0) {
					cl = pvs.getClusterAt(gp);
				} else if (cl === -2) {
					cl = pvs.getClusterAt(gp);
					entry.cluster = cl;
				}
				if (cl >= 0 && !pvs.isVisible(cl)) {
					entry.beam.visible = false;
					entry.glare.visible = false;
					entry.visTarget = 0;
					continue;
				}
			}
			entry.beam.visible = true;
			entry.glare.visible = true;
			const dx = gp.x - this.tmpPos.x;
			const dy = gp.y - this.tmpPos.y;
			const dz = gp.z - this.tmpPos.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			const fwd = dx * this.camForward.x + dy * this.camForward.y + dz * this.camForward.z;
			if (distSq > 3000 * 3000 || fwd <= 0) {
				entry.visTarget = 0;
				continue;
			}
			if (!physTrace) {
				entry.visTarget = 1;
				continue;
			}
			if (!checked && nowMs - entry.lastCheckAt >= 80) {
				entry.lastCheckAt = nowMs;
				checked = true;
				this.cursor = (idx + 1) % len;
				const sd = entry.spot.direction;
				this.tmpTarget.set(gp.x + sd[0] * 4, gp.y + sd[1] * 4, gp.z + sd[2] * 4);
				const frac = physTrace(this.tmpPos, this.tmpTarget);
				entry.visTarget = frac < 0.96 ? 0 : 1;
			}
		}

		const alpha = 1 - Math.exp(-dt * 18.0);
		for (const entry of this.entries) {
			entry.visCurrent += (entry.visTarget - entry.visCurrent) * alpha;
			const glareMat = entry.glare.material as THREE.ShaderMaterial;
			if (glareMat.uniforms?.uVis) glareMat.uniforms.uVis.value = entry.visCurrent;
			if (glareMat.uniforms?.uAspect) glareMat.uniforms.uAspect.value = aspect;
		}
	}

	/** 载入实体清单后解析每盏射灯的父子层级（根祖先 → 直接父级）。 */
	attachEntityHierarchy(entityBlocks: EntityBlockRecords): void {
		this.byAncestor.clear();
		this.ancestorMeta.clear();
		const byTargetName = new Map<string, number>();
		for (let i = 0; i < entityBlocks.length; i++) {
			const tn = entityBlocks[i]?.targetname;
			if (typeof tn !== 'string') continue;
			const key = tn.trim().toLowerCase();
			if (key && !byTargetName.has(key)) byTargetName.set(key, i);
		}
		for (const entry of this.entries) {
			if (entry.spot.entityIndex !== null) {
				const rec = entityBlocks[entry.spot.entityIndex];
				if (rec) {
					const amtRaw = Number.parseFloat(rec['renderamt'] ?? '');
					const amt = Number.isFinite(amtRaw) ? Math.min(255, Math.max(0, amtRaw)) / 255 : 1;
					const hdrRaw = Number.parseFloat(rec['hdrcolorscale'] ?? rec['HDRColorScale'] ?? '');
					const hdrScale = Number.isFinite(hdrRaw) && hdrRaw > 0 ? Math.min(2.0, Math.max(0.25, hdrRaw)) : 1;
					const gain = amt * hdrScale;
					const beamMat = entry.beam.material as THREE.ShaderMaterial;
					if (beamMat.uniforms?.uPeak) beamMat.uniforms.uPeak.value = BEAM_PEAK * gain;
					const glareMat = entry.glare.material as THREE.ShaderMaterial;
					if (glareMat.uniforms?.uGain) glareMat.uniforms.uGain.value = gain;
				}
			}
			entry.ancestors.length = 0;
			let curParent = entry.spot.parentName?.trim().toLowerCase() ?? '';
			const visited = new Set<number>();
			const chain: number[] = [];
			for (let depth = 0; depth < 16 && curParent; depth++) {
				const idx = byTargetName.get(curParent);
				if (idx === undefined || visited.has(idx)) break;
				visited.add(idx);
				chain.push(idx);
				if (!this.ancestorMeta.has(idx)) {
					this.ancestorMeta.set(idx, { pivot: parseOriginTuple(entityBlocks[idx]?.origin) });
				}
				const next = entityBlocks[idx]?.parentname;
				curParent = typeof next === 'string' ? next.trim().toLowerCase() : '';
			}
			if (chain.length === 0) continue;
			chain.reverse(); // 根祖先在前，直接父级在后
			entry.ancestors.push(...chain);
			entry.beam.userData.vbspDynamicSpot = true;
			entry.glare.userData.vbspDynamicSpot = true;
			for (const ancIdx of chain) {
				let list = this.byAncestor.get(ancIdx);
				if (!list) {
					list = [];
					this.byAncestor.set(ancIdx, list);
				}
				list.push(entry);
			}
		}
	}

	setEntityOffset(entityIndex: number, offset: readonly [number, number, number]): void {
		const affected = this.byAncestor.get(entityIndex);
		if (!affected) return;
		this.offsets.set(entityIndex, [offset[0], offset[1], offset[2]]);
		for (const entry of affected) this.recompute(entry);
	}

	setEntityRotation(entityIndex: number, angles: readonly [number, number, number]): void {
		const affected = this.byAncestor.get(entityIndex);
		if (!affected) return;
		this.rotations.set(entityIndex, [angles[0], angles[1], angles[2]]);
		for (const entry of affected) this.recompute(entry);
	}

	private recompute(entry: RigEntry): void {
		const pos = this.tmpPos.copy(entry.baseOrigin);
		const dir = this.tmpDir.copy(entry.baseDir);
		let prevOx = 0;
		let prevOy = 0;
		let prevOz = 0;
		for (const ancIdx of entry.ancestors) {
			const off = this.offsets.get(ancIdx) ?? ZERO_VEC3;
			pos.x += off[0] - prevOx;
			pos.y += off[1] - prevOy;
			pos.z += off[2] - prevOz;
			prevOx = off[0];
			prevOy = off[1];
			prevOz = off[2];
			const rot = this.rotations.get(ancIdx);
			if (rot && (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0)) {
				const meta = this.ancestorMeta.get(ancIdx);
				const pivot = this.tmpPivot.copy(meta ? meta.pivot : ZERO_VEC3 as unknown as THREE.Vector3);
				if (meta) {
					this.tmpPivot.set(meta.pivot.x + off[0], meta.pivot.y + off[1], meta.pivot.z + off[2]);
				} else {
					this.tmpPivot.set(off[0], off[1], off[2]);
				}
				void pivot;
				this.tmpEuler.set(rot[0], rot[1], rot[2], 'XYZ');
				this.tmpQuat.setFromEuler(this.tmpEuler);
				pos.sub(this.tmpPivot).applyQuaternion(this.tmpQuat).add(this.tmpPivot);
				dir.applyQuaternion(this.tmpQuat).normalize();
			}
		}
		entry.beam.position.copy(pos);
		entry.beam.quaternion.setFromUnitVectors(this.upAxis, dir);
		entry.beam.updateMatrix();
		entry.beam.updateMatrixWorld(true);
		entry.glare.position.copy(pos);
		entry.glare.updateMatrix();
		entry.glare.updateMatrixWorld(true);
		const glareMat = entry.glare.material as THREE.ShaderMaterial;
		if (glareMat.uniforms?.uSpotDir) {
			(glareMat.uniforms.uSpotDir.value as THREE.Vector3).copy(dir);
		}
		entry.spot.position[0] = pos.x;
		entry.spot.position[1] = pos.y;
		entry.spot.position[2] = pos.z;
		entry.spot.direction[0] = dir.x;
		entry.spot.direction[1] = dir.y;
		entry.spot.direction[2] = dir.z;
		if (entry.dlight) {
			entry.dlight.position[0] = pos.x + dir.x * entry.length;
			entry.dlight.position[1] = pos.y + dir.y * entry.length + 5;
			entry.dlight.position[2] = pos.z + dir.z * entry.length;
		}
	}
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

	const up = new THREE.Vector3(0, 1, 0);
	const activeSpots: PunctualSpot[] = [];
	const dlights: SpotDLightEntry[] = [];
	const rig = new SpotBeamRig();

	for (const s of spots) {
		const isPointSpot = s.beamWidth !== null;
		// 静态烘焙 light_spot 只用于离线 lightmap，运行期不画体积光柱也不占 SpotLightSelector 槽位。
		if (!isPointSpot) continue;
		activeSpots.push(s);
		const startsOff = s.spawnFlags !== null && (s.spawnFlags & 1) === 0;
		const noDLight = s.spawnFlags !== null && (s.spawnFlags & 2) !== 0;
		if (startsOff) s.intensity = 0;
		const axis = new THREE.Vector3(s.direction[0], s.direction[1], s.direction[2]).normalize();
		const origin = new THREE.Vector3(s.position[0], s.position[1], s.position[2]);
		const maxLength = Math.max(48, s.beamLength ?? Math.min(s.range, 900));
		// 动态挂接射灯会随载体离开出生房间，不做出生位一次性射线永久截断，由场景深度自然遮挡墙体。
		const hit = s.parentName ? null : traceBeamHit(origin, axis, maxLength, root);
		const length = hit ? hit.length : maxLength;
		const hitPoint = hit ? hit.point : origin.clone().addScaledVector(axis, length);
		const width = Math.min(MAX_BEAM_WIDTH, s.beamWidth as number);
		// 灯头紧凑聚拢（halfStart 窄口）→ 随照射距离自然散开成体积光锥，消除旧版大矩形灯头。
		const halfStart = Math.max(2.2, Math.min(7.5, width * 0.12));
		const halfEnd = Math.max(halfStart + 4, (width * 0.5) * (0.28 + 0.72 * (length / maxLength)));
		const color = new THREE.Color(s.color[0], s.color[1], s.color[2]);
		let dlight: SpotDLightEntry | null = null;
		if (!noDLight && !startsOff) {
			const k = Math.min(1.5, Math.max(0.25, s.intensity / 1000));
			dlight = {
				position: [hitPoint.x, hitPoint.y + 5, hitPoint.z],
				color: [s.color[0] * k, s.color[1] * k, s.color[2] * k],
				range: Math.max(48, 5.4 * halfEnd),
			};
			dlights.push(dlight);
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
		beam.visible = !startsOff;
		group.add(beam);

		// 灯头光学炫光（depthTest=false + 节流 LOS uVis 遮挡 + vbspNoGlow 保留锐利星芒与色散月牙弧）。
		const glareGeo = new THREE.BufferGeometry();
		glareGeo.setAttribute(
			'position',
			new THREE.Float32BufferAttribute([
				-0.5, -0.5, 0,
				0.5, -0.5, 0,
				-0.5, 0.5, 0,
				0.5, 0.5, 0,
			], 3),
		);
		glareGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
		glareGeo.setIndex([0, 1, 2, 1, 3, 2]);
		const glareMat = new THREE.ShaderMaterial({
			uniforms: {
				uColor: { value: color },
				uSpotDir: { value: axis.clone() },
				uAspect: { value: 16 / 9 },
				uGain: { value: 1.0 },
				uVis: { value: 1.0 },
				uSeed: { value: ((s.entityIndex ?? activeSpots.length) * 1.6180339) % 1.0 },
			},
			vertexShader: GLARE_VERT,
			fragmentShader: GLARE_FRAG,
			transparent: true,
			depthWrite: false,
			depthTest: false,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			fog: false,
		});
		const glare = new THREE.Mesh(glareGeo, glareMat);
		glare.position.copy(origin);
		glare.frustumCulled = false;
		glare.renderOrder = 15;
		glare.userData.vbspNoGlow = true;
		glare.visible = !startsOff;
		group.add(glare);

		rig.addEntry({
			spot: s,
			dlight,
			beam,
			glare,
			baseOrigin: origin.clone(),
			baseDir: axis.clone(),
			length,
			ancestors: [],
			baseVisible: !startsOff,
			cluster: -2,
			visTarget: 1,
			visCurrent: 1,
			lastCheckAt: 0,
		});
	}

	if (activeSpots.length === 0) return null;
	group.userData.spots = activeSpots;
	group.userData.dlights = dlights;
	group.userData.rig = rig;
	return group;
}
