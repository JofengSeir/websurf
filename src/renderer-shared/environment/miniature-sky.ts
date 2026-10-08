/**
 * 3D 天空盒（起源「微缩景观」）：地图自带的天空区图元 + 一台随玩家 1/scale 移动的**第二相机**。
 *
 * 起源的做法（`viewrender.cpp` 的 `CSkyboxView::DrawInternal`）：把天空相机放到
 * `sky_camera 原点 + 主相机位置 / scale`，用**未缩放**的地图几何画一遍天空区，之后清深度、
 * 主相机再画主世界。本模块给出这条链路的三个部件：
 * - `skyCameraFromEntities`：从实体 JSON 取 `sky_camera` 的 origin/scale；
 * - `extractSkyArea`：把天空区图元摘进「天空层」（主相机看不到，判据由调用方给）；
 * - `createSkyCamera` / `syncSkyCamera`：第二相机及其每帧位姿。
 *
 * 没有 `sky_camera`、或天空区不可分离时，调用方回退 `buildMiniatureSky` 的合成山脊。
 */
import * as THREE from 'three';

/** 构建参数。 */
export interface MiniatureSkyOptions {
	/** 环心（一般是场景包围盒中心）。 */
	center: THREE.Vector3;
	/** 场景半径（HU）：三层分别放在 1.35 / 1.7 / 2.1 倍处，故恒在可达范围之外。 */
	radius: number;
	/** 山脊基色（**深色剪影**；不要用雾色/天空色，否则与天空同色看不见）。 */
	color: number;
	/** 远景雾色（逐层向它混合出大气透视）；省略时用白色。 */
	haze?: number;
	/** 每张图的稳定随机种子（同一地图每次加载一致）。 */
	seed?: number;
}

/** 一层的配置：半径倍数 / 高度占半径比 / 向雾色的混合比 / 段数。 */
const LAYERS: ReadonlyArray<{ r: number; h: number; mix: number; seg: number }> = [
	{ r: 1.35, h: 0.38, mix: 0.28, seg: 96 },
	{ r: 1.7, h: 0.52, mix: 0.48, seg: 84 },
	{ r: 2.1, h: 0.66, mix: 0.68, seg: 72 },
];

/** 稳定哈希 → [0,1)；同一个 (i, seed) 永远同值。 */
function hash(i: number, seed: number): number {
	const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/** 单层锯齿幕帘：顶部起伏的闭合环带（底部压到地平以下，避免露出下缘）。 */
function buildRidge(opts: MiniatureSkyOptions, layer: (typeof LAYERS)[number]): THREE.Mesh {
	const seed = opts.seed ?? 1;
	const R = opts.radius * layer.r;
	const baseY = -opts.radius * 0.06;
	const positions: number[] = [];
	const indices: number[] = [];
	for (let i = 0; i <= layer.seg; i++) {
		const a = (i / layer.seg) * Math.PI * 2;
		const x = opts.center.x + Math.cos(a) * R;
		const z = opts.center.z + Math.sin(a) * R;
		// 三个八度：单点哈希（碎峰）+ 低频哈希（山块）+ 正弦（主脉），归一后取 0.35~1 的高度
		const n =
			0.5 * hash(i, seed) +
			0.3 * hash(Math.floor(i / 4), seed + 7) +
			0.2 * (0.5 + 0.5 * Math.sin(a * 3 + seed));
		const topY = baseY + opts.radius * layer.h * (0.35 + 0.65 * n);
		positions.push(x, baseY, z, x, topY, z);
	}
	for (let i = 0; i < layer.seg; i++) {
		const b = i * 2;
		indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	const base = new THREE.Color(opts.color);
	const haze = new THREE.Color(opts.haze ?? 0xffffff);
	const material = new THREE.MeshBasicMaterial({
		color: base.lerp(haze, layer.mix),
		side: THREE.DoubleSide,
		fog: false,
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = 'MiniatureSkyLayer';
	mesh.frustumCulled = false;
	return mesh;
}

/**
 * 构建微缩外景（三层山脊）。返回的组已定位在 `center`，可直接挂进场景；
 * 调用方负责随地图一起释放（挂到 BSP 根子树即可随 `disposeScene` 一起走）。
 */
export function buildMiniatureSky(opts: MiniatureSkyOptions): THREE.Group {
	const group = new THREE.Group();
	group.name = 'MiniatureSky';
	for (const layer of LAYERS) group.add(buildRidge(opts, layer));
	return group;
}


/** `sky_camera` 换算出的参数（origin 已按导出轴约定转成 Three 坐标）。 */
export interface SkyCameraParams {
	origin: [number, number, number];
	scale: number;
}

/** 从 `parse_entities()` 的 JSON 取 `sky_camera`；无该实体或 origin/scale 非法返回 null。 */
export function skyCameraFromEntities(entitiesJson: string): SkyCameraParams | null {
	try {
		const parsed: unknown = JSON.parse(entitiesJson);
		const list = (Array.isArray(parsed) ? parsed : ((parsed as { entities?: unknown[] }).entities ?? [])) as Array<{
			classname?: string;
			props?: Record<string, string>;
		}>;
		for (const e of list) {
			if (e?.classname !== 'sky_camera') continue;
			const o = (e.props?.origin ?? '').trim().split(/\s+/).map(Number);
			if (o.length < 3 || o.some((v) => !Number.isFinite(v))) continue;
			const s = Number.parseFloat(e.props?.scale ?? '16');
			return { origin: [o[1], o[2], o[0]], scale: Number.isFinite(s) && s > 0 ? s : 16 };
		}
	} catch {
		// 非法 JSON 只说明没有天空盒，不影响地图渲染
	}
	return null;
}
/** 天空层：3D 天空盒图元只挂这一层——主相机看不到它，天空相机只看它。 */
export const SKY_LAYER = 1;

/** 建天空相机：投影每帧由 `syncSkyCamera` 从主相机抄，这里只定层与名字。 */
export function createSkyCamera(): THREE.PerspectiveCamera {
	const cam = new THREE.PerspectiveCamera();
	cam.name = 'SkyCamera';
	cam.layers.set(SKY_LAYER);
	return cam;
}

/**
 * 每帧同步天空相机（起源 `CSkyboxView::DrawInternal` 的位姿算法）。
 *
 * 位置 = `sky_camera 原点 + 主相机位置 / scale`：对应 `viewrender.cpp` 里
 * `VectorScale(origin, 1/scale)` 后 `VectorAdd(origin, sky3dparams.origin)`，与
 * `env_headcrabcanister_shared.cpp` 的 `vecSkyboxOrigin + pos/scale` 同式；朝向与投影抄主相机。
 *
 * 实测（`.tmp/mapsurvey/skyfrontface.mjs`，surf_boreas 的 163 个出生点）：本式让
 * **359.8/361** 个天空图元的正面朝向相机；换成绕相机缩放的相对式 `CAM + (P-CAM)/scale`
 * 只剩 235.6/361，且 163/163 个出生点都是本式更优。
 */
export function syncSkyCamera(sky: THREE.PerspectiveCamera, main: THREE.PerspectiveCamera, params: SkyCameraParams): void {
	sky.fov = main.fov;
	sky.aspect = main.aspect;
	sky.near = main.near;
	sky.far = main.far;
	sky.zoom = main.zoom;
	sky.updateProjectionMatrix();
	const s = params.scale;
	sky.position.set(
		params.origin[0] + main.position.x / s,
		params.origin[1] + main.position.y / s,
		params.origin[2] + main.position.z / s,
	);
	sky.quaternion.copy(main.quaternion);
	sky.updateMatrixWorld(true);
}

/**
 * 把天空区图元摘进天空层（起源 3D 天空盒的几何侧）：起源的天空区图元**不参与主视图**，
 * 由天空相机单独渲染。
 *
 * 判据 `isSkyMesh` 由调用方给出（本模块不认识 BSP/PVS）；摘出的 mesh 用 `attach` 保持世界
 * 变换，只改 `layers`：主相机看不到（`main.layers.disable(SKY_LAYER)`）、天空相机只看它。
 * 一个都没命中时返回 null（调用方回退 `buildMiniatureSky`）。
 *
 * 调用方（`apps/debug` 的 `RendererMain.loadScene`）用的判据是「图元采样点落在 `sky_camera`
 * 所在 BSP cluster」——实测它与本模块上一版的「种子 + 包围盒簇扩张」选出**同一批** 361 个图元
 * （`.tmp/mapsurvey/skysel.mjs`：两条独立判据互证）。
 */
export function extractSkyArea(mapRoot: THREE.Object3D, isSkyMesh: (mesh: THREE.Mesh) => boolean): THREE.Group | null {
	mapRoot.updateMatrixWorld(true);
	const picked: THREE.Mesh[] = [];
	mapRoot.traverse((o) => {
		const m = o as THREE.Mesh;
		if (m.isMesh && m.geometry && isSkyMesh(m)) picked.push(m);
	});
	if (picked.length === 0) return null;
	const group = new THREE.Group();
	group.name = 'MiniatureSky';
	group.userData.isMiniatureSky = true;
	group.updateMatrixWorld(true);
	for (const mesh of picked) {
		group.attach(mesh);
		mesh.layers.set(SKY_LAYER);
	}
	return group;
}
