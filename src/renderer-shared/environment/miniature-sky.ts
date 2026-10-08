/**
 * 微缩外景（Source「3D 天空盒 / 微缩景观」在本仓的替代实现）。
 *
 * 起源引擎的 3D 天空盒是**地图作者**在 `sky_camera` 附近按 `scale` 缩放的密封区域，
 * 引擎用一台「随玩家 1/scale 移动」的相机把它画在主视图之前，于是成为玩家到不了的外景。
 * 本仓实测（`.tmp/mapsurvey/mini-recon.mjs`）表明手上的夹具**没有**可分离的该区域：
 * `surf_boreas` 的 `sky_camera` 在世界包围盒外 1281 HU、3000 HU 内 0 网格；
 * `surf_concretejungle_fix` 的相机落在play区域里（2000 HU 内占 26%，分布平滑）。
 * 因此这里改为**合成**一圈低多边形山脊，放在可达范围之外，充当「地图到达不了的地方的外景」。
 *
 * 画法：每层是一条锯齿「幕帘」（顶部随机起伏、底部低于地平），三层由近及远、颜色逐层
 * 向雾色靠拢（大气透视），材质 `fog: false` 以免远处被地图雾整片吃掉——透视已烘进颜色。
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
/**
 * 用地图自带的微缩区构建外景（起源 3D 天空盒的静态等价实现）。
 *
 * 选取：以 `sky_camera` 为中心半径 `seedRadius`（= 场景半径 / scale）内的 mesh 为**种子**，再按
 * 包围盒间距 `<= gap` 向相邻 mesh 扩张 —— 微缩区是一整块自相连的几何，而它与地图本体之间隔着
 * 空腔。**不能只用半径**：`surf_boreas` 实测按半径只取到 102/361 个图元，前面/左边的山整块丢失。
 *
 * 变换：绕 `sky_camera` 缩放 `scale` 倍（锚点 = 相机本身，`position = CAM*(1-scale)`）——与起源把
 * 天空相机放到 `CAM + (player-CAM)/scale` 再渲染微缩几何等价（方向夹角实测 0.00°）。
 */
export function buildMiniatureOutside(
	mapRoot: THREE.Object3D,
	cam: SkyCameraParams,
	seedRadius: number,
	gap = 256,
): THREE.Group | null {
	const origin = new THREE.Vector3(cam.origin[0], cam.origin[1], cam.origin[2]);
	mapRoot.updateMatrixWorld(true);
	const meshes: THREE.Mesh[] = [];
	mapRoot.traverse((o) => {
		const m = o as THREE.Mesh;
		if (m.isMesh && m.geometry) meshes.push(m);
	});
	const boxes = meshes.map((m) => {
		if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
		const bb = (m.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(m.matrixWorld);
		return bb;
	});
	const picked = new Set<number>();
	for (let i = 0; i < meshes.length; i++) {
		if (boxes[i].getCenter(new THREE.Vector3()).distanceTo(origin) <= seedRadius) picked.add(i);
	}
	if (picked.size === 0) return null;
	// 扩张：包围盒间距 <= gap 视为同一块（种子已保证落在微缩区内）
	// 两个包围盒之间的最短距离（逐轴取正向间隔，再取欧氏范数）
	const boxGap = (a: THREE.Box3, b: THREE.Box3): number => {
		let sum = 0;
		for (const axis of ['x', 'y', 'z'] as const) {
			const d = Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
			sum += d * d;
		}
		return Math.sqrt(sum);
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (let i = 0; i < meshes.length; i++) {
			if (picked.has(i)) continue;
			for (const j of picked) {
				if (boxGap(boxes[i], boxes[j]) <= gap) {
					picked.add(i);
					changed = true;
					break;
				}
			}
		}
	}
	const group = new THREE.Group();
	group.name = 'MiniatureSky';
	group.userData.isMiniatureSky = true;
	for (const i of picked) {
		const src = meshes[i];
		// 复用源材质：材质上已挂着 lightmap / ambient cube 注入，克隆会丢注入。
		const mesh = new THREE.Mesh(src.geometry, src.material);
		mesh.userData = src.userData;
		mesh.renderOrder = -1;
		mesh.frustumCulled = false;
		group.add(mesh);
	}
	const s = cam.scale;
	group.scale.setScalar(s);
	group.position.set(origin.x * (1 - s), origin.y * (1 - s), origin.z * (1 - s));
	return group;
}
