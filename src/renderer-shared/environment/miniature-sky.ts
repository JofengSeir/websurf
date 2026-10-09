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
 * 没有 `sky_camera`、或天空区不可分离时，调用方**不加天空层**。（早期实现会合成一条三层山脊兜底；2026-10-09 作为遗留假景删除，见 TODO.md T-616。）
 */
import * as THREE from 'three';

/**
 * `sky_camera` 自己的天空盒雾（引擎 `CSkyboxView::Enable3dSkyboxFog` 的取值来源）。
 * `enable` 为假时引擎在天空遍直接 `FogMode(NONE)` —— 天空区**一点雾都不吃**。
 */
export interface SkyFogParams {
	enable: boolean;
	color: number;
	start: number;
	end: number;
}

/** `sky_camera` 换算出的参数（origin 已按导出轴约定转成 Three 坐标）。 */
export interface SkyCameraParams {
	origin: [number, number, number];
	scale: number;
	/** 天空盒雾；缺键或 `fogenable` 为假时天空遍不吃雾。 */
	fog?: SkyFogParams | null;
}

/** 从 `sky_camera` 键值取天空盒雾；`fogenable` 缺省即未启用（与引擎的 bool 键值缺省一致）。 */
function skyFogFromProps(props: Record<string, string> | undefined): SkyFogParams | null {
	if (!props) return null;
	const rgb = (props.fogcolor ?? '').trim().split(/\s+/).map(Number);
	const color =
		rgb.length >= 3 && rgb.every((v) => Number.isFinite(v))
			? ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff)
			: 0xffffff;
	const start = Number.parseFloat(props.fogstart ?? '0');
	const end = Number.parseFloat(props.fogend ?? '0');
	return {
		enable: /^1$/.test((props.fogenable ?? '').trim()),
		color,
		start: Number.isFinite(start) ? start : 0,
		end: Number.isFinite(end) ? end : 0,
	};
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
			return {
				origin: [o[1], o[2], o[0]],
				scale: Number.isFinite(s) && s > 0 ? s : 16,
				fog: skyFogFromProps(e.props),
			};
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
 * 一个都没命中时返回 null（调用方据此判定无 3D 天空盒）。
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
