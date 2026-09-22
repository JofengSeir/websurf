/**
 * WebSurf — 灯光管理器（debug 工程主线程）
 *
 * 持有一场景的全部灯光：
 * - 三盏基础灯 `THREE.AmbientLight` / `THREE.HemisphereLight` / `THREE.DirectionalLight`，
 *   方向灯按球坐标（方位角 + 仰角 + 固定距离）定位，`dir.target` 留在原点；
 * - 固定 8 槽的点光源池 `pointLights`（槽数由 `MAX_POINT_LIGHTS` 定），供 glTF
 *   `KHR_lights_punctual` 候选按距离取最近的若干槽启用。
 *
 * 上游（`apps/debug/src/renderer/renderer-main.ts` 的两处调用）：
 * - `applyLights`：初始化时把三盏灯与点光源池挂到新建的 `THREE.Scene`，并设置背景色；
 * - `syncFromConfig`：`applyConfigPatch('lighting', …)` 之后按 `config.lighting` 整体同步。
 *
 * 当前接线状况（实测调用点）：
 * - `extractPointLights` / `updatePointLights` / `activePointLightCount` / `dispose`
 *   在本仓 `src` 与 `apps` 内**零调用点**：点光源池被创建并挂进场景后始终保持
 *   `visible = false`、`intensity = 0`，`pointCandidates` 恒为空数组；
 * - `updateLighting` 只被本文件的 `syncFromConfig` 调用。
 *
 * 不变量与边界：
 * - 参数更新都先判 `scene` 与三盏基础灯是否就绪：`applyLights` 之前调
 *   `updateLighting`/`syncFromConfig` 一律静默返回（背景色也一样丢）；
 * - `applyLights` 每次调用都**新建**三盏灯并 `scene.add`，不摘除上一次的实例；
 * - 颜色经 `toColor` 归一：只认 `number` 与 `string`，其余输入（含 `null`）回落到 fallback，
 *   而 `bgColor` 传的 fallback 是 `null` ⇒ 落到白色。
 */

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RuntimeConfig } from '../config.js';

/** 颜色入参的两种形态：`number` 直接当十六进制色值，字符串按 `#rrggbb` 解析。 */
type ColorInput = number | string;

/** `updateLighting` 的入参：十个字段全可选，未出现的字段保持当前值不动。 */
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

/** 点光源池的槽数：构造函数按它预分配，`updatePointLights` 也按它写满整池。 */
const MAX_POINT_LIGHTS = 8;

/** 方向灯到原点的距离（HU）。只参与定位：方向灯本身无衰减，该值不改变照射方向。 */
const DIR_LIGHT_DISTANCE = 5000;

/**
 * 灯光管理器：三盏基础灯 + 固定 8 槽点光源池。
 *
 * 点光源池在构造时预分配（`decay = 2`、`intensity = 0`、`visible = false`），
 * 候选坐标由 `extractPointLights` 从 glTF 取出，`updatePointLights` 再按距参考点的
 * 远近决定每槽的启用与参数；两个方法当前都无调用点（见模块头）。
 */
export class LightManager {
	private scene: THREE.Scene | null = null;
	private ambient: THREE.AmbientLight | null = null;
	private hemi: THREE.HemisphereLight | null = null;
	private dir: THREE.DirectionalLight | null = null;

	/** 点光源池：构造时一次性填满 `MAX_POINT_LIGHTS` 个实例，之后只换参数不换对象。 */
	private readonly pointLights: THREE.PointLight[] = [];
	/** 最近一次 `updatePointLights` 启用的槽数；`disableAllPointLights` 会清零。 */
	private activePointCount = 0;

	/** 方向灯定位状态：方位角与仰角为度，距离恒为 `DIR_LIGHT_DISTANCE`（HU）。 */
	private dirAzimuth = 45;
	private dirElevation = 45;
	private dirDistance = DIR_LIGHT_DISTANCE;

	/** 已提取的点光源候选（世界坐标 + 颜色/强度/半径），每次 `extractPointLights` 整体替换。 */
	private pointCandidates: PointLightCandidate[] = [];

	constructor() {
		// 预分配整池：初始 intensity 0、distance 0、decay 2、visible false
		for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
			const pl = new THREE.PointLight(0xffffff, 0, 0, 2);
			pl.visible = false;
			this.pointLights.push(pl);
		}
	}

	/**
	 * 建三盏基础灯并挂到传入场景，同时登记场景引用与背景色。
	 *
	 * 方向灯的方位角/仰角取自配置（球坐标定位见 `updateDirPosition`），其 `target` 也加入
	 * 场景以保持缺省原点；点光源池整池入场景，但保持构造时的不可见状态。
	 *
	 * 重复调用会往场景里叠加新灯：本方法不摘除上一次的实例，也不判空。
	 *
	 * @param scene 目标场景，登记为 `this.scene`（后续参数更新都要求它非空）。
	 * @param config 运行时配置，只读 `lighting` 段。
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

		// 点光源池整池入场景：只改挂载关系，可见性仍是构造时的 false
		for (const pl of this.pointLights) {
			scene.add(pl);
		}

		// 背景色不走 toColor：config 的该字段类型为 number
		scene.background = new THREE.Color(lc.bgColor);
	}

	/**
	 * 读 `gltf.parser.json` 里的 `extensions.KHR_lights_punctual.lights`，为每个引用
	 * **point** 类型灯的节点算一份世界坐标，整表替换 `pointCandidates`。
	 *
	 * 生效前提：扩展段与 `lights` 数组都在、且 `json.nodes` 存在；缺一即清空候选后返回 0。
	 * 逐个节点的跳过条件：`extensions.KHR_lights_punctual.light` 为 `undefined`/`null`；
	 * `lights[lightRef]` 取不到；该灯 `type !== 'point'`（spot / directional 一律不收）；
	 * `computeNodeWorldPosition` 返回 `null`。
	 * 灯自身的缺省：`color` → `[1, 1, 1]`，`intensity` → `1`，`range` → `0`。
	 *
	 * @param gltf GLTFLoader 的解析结果（只读 `parser.json`）。
	 * @returns 本次入表的候选数量（旧候选已被清空）。
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

		// 逐个节点取灯定义与节点世界坐标，两者齐备才成为候选
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
	 * 按参考点重排点光源池：候选按到参考点的距离平方升序，前 `min(MAX_POINT_LIGHTS, 候选数)`
	 * 槽写入候选的颜色/强度/半径/位置并置为可见，其余槽置 `visible = false`、`intensity = 0`。
	 *
	 * 候选为空时委托 `disableAllPointLights`（本方法不做别的判定）。
	 * 「关闭」的槽只改可见性与强度：颜色、位置、`distance` 保留上一次写入的值。
	 * `range <= 0` 时把 `distance` 写成 0（该字段由 three.js 的 `PointLight.distance` 承载）。
	 * 池中实例的 `decay` 自构造起不再改写。
	 *
	 * 本方法不检查场景与挂载状态：在 `applyLights` 之前调用只改对象字段，画面无变化。
	 *
	 * @param refPos 参考点世界坐标（调用方传相机位置）。
	 */
	updatePointLights(refPos: THREE.Vector3): void {
		if (this.pointCandidates.length === 0) {
			this.disableAllPointLights();
			return;
		}

		// 距离平方排序：省去开方，且比较结果与距离一致
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

	/** 整池关闭并把启用计数清零（候选为空时的分支）。 */
	private disableAllPointLights(): void {
		for (const pl of this.pointLights) {
			pl.visible = false;
			pl.intensity = 0;
		}
		this.activePointCount = 0;
	}

	/**
	 * 按字段增量更新三盏基础灯与背景色；字段缺省即不动那一项。
	 *
	 * 前置条件：`scene` 与三盏基础灯都已就绪（由 `applyLights` 建立），任一为空则整次调用
	 * 直接返回——包括已传入的其他字段。颜色统一过 `toColor`，fallback 取该灯当前颜色，
	 * 只有 `bgColor` 传 `null` 作 fallback。
	 * 方位角/仰角改动会顺带重算方向灯位置；强度、颜色、背景色不触发重算。
	 *
	 * @param params 部分字段覆盖；本方法不校验取值范围。
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

	/**
	 * 把 `config.lighting` 的十个字段一次性喂给 `updateLighting`。
	 *
	 * 只读配置不改写配置；`lighting.mode`（预烘焙/纯纹理）不属本方法范围，
	 * 它由 `apps/debug/src/renderer/renderer-main.ts` 的 `setLightingMode` 走 uniform 切换。
	 */
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
	 * 由方位角/仰角/距离算方向灯位置（球坐标 → 笛卡尔，Y 轴为仰角轴）。
	 *
	 * 只写 `dir.position`，不改 `dir.target`——target 在 `applyLights` 入场景后保持缺省原点，
	 * 于是照射方向恒为「位置 → 原点」。`dirDistance` 除字段初始化外无写入点，
	 * 距离恒为 `DIR_LIGHT_DISTANCE`。`dir` 为空时直接返回。
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

	/** 当前启用的点光源槽数（`activePointCount` 的只读出口，仓内零调用点）。 */
	get activePointLightCount(): number {
		return this.activePointCount;
	}

	/**
	 * 从场景摘除三盏基础灯、方向灯 target 与整池点光源，并把 `scene` 置空。
	 *
	 * 只解除挂载：三盏灯与 `pointLights` 的实例引用、方位角/仰角、`activePointCount`
	 * 均保持原值；置空 `scene` 后所有参数更新入口继续静默返回。
	 * 仓内零调用点。
	 */
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
// 辅助类型与函数（与类实例无关）
// ---------------------------------------------------------------------------

/** `extractPointLights` 的中间产物，供池槽按距离排序后取用。 */
interface PointLightCandidate {
	/** 节点世界坐标（Y-up）。 */
	position: [number, number, number];
	/** 线性的 RGB 三分量，取自灯定义的 `color`。 */
	color: [number, number, number];
	/** 取自灯定义的 `intensity`。 */
	intensity: number;
	/** 取自灯定义的 `range`；0 表示未给。 */
	range: number;
}

/** glTF `KHR_lights_punctual.lights[]` 里本文件关心的字段。 */
interface RawGltfLight {
	/** 灯类型；只有 `'point'` 会被 `extractPointLights` 收下。 */
	type?: string;
	color?: [number, number, number];
	intensity?: number;
	range?: number;
}

/** glTF 节点的本文件子集：只用到变换、子节点与灯引用。 */
interface RawGltfNode {
	translation?: [number, number, number];
	/** 只有未给 `matrix` 时才会被读；本文件不参与位置累计。 */
	rotation?: [number, number, number, number];
	/** 同上：只在无 `matrix` 的分支里被跳过。 */
	scale?: [number, number, number];
	/** 列主序 4×4；给了它就整段走矩阵变换。 */
	matrix?: number[];
	children?: number[];
	/** 挂在节点上的灯索引（指向 `lights[]`）。 */
	extensions?: { KHR_lights_punctual?: { light?: number } };
}

/**
 * 颜色归一。
 *
 * - `number`：直接作色值构造；
 * - `string`：丢掉首字符后按十六进制解析（约定带 `#` 前缀），不做格式校验；
 * - 其他类型（运行期从配置消息进来的 `null` 等）：返回 `fallback`，`fallback` 为 `null`
 *   时返回白色。
 *
 * @param input 面板/配置消息给的颜色值。
 * @param fallback 非 `number`/`string` 时的回落颜色；`null` 表示回落白色。
 */
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
 * 求 glTF 节点在场景里的世界坐标，只累加**平移类**变换。
 *
 * 三步：① 以 `json.scenes[0].nodes` 为起点沿 `children` 走一遍（显式栈 + `visited` 去重，
 * 取值用 `pop()` 即后进先出序）建立「子 → 父」映射；② 从目标节点沿映射回溯到根，得到
 * 自根到该节点的路径（`guard` 集合兜住自环）；③ 自根向叶逐级把变换作用到位置向量上。
 *
 * 每一级的处理分两种：给了 `matrix` 的节点整段走 `Vector3.applyMatrix4`（该矩阵里的旋转、
 * 缩放与透视行都会作用到位置上）；没给 `matrix` 的节点只累加 `translation`，其 `rotation`
 * 与 `scale` 不参与位置累计。
 *
 * 只遍历 `scenes[0]`：不在该场景图内的节点拿不到父映射，回溯路径只剩它自己，
 * 返回的就是它自身的局部平移。
 *
 * @param json glTF 的 `parser.json`，只读 `nodes` 与 `scenes`。
 * @param nodeIdx 目标节点下标。
 * @returns `[x, y, z]`；`nodes` 缺失或下标越界时为 `null`。
 */
function computeNodeWorldPosition(
	json: { nodes?: RawGltfNode[]; scenes?: { nodes?: number[] }[] },
	nodeIdx: number,
): [number, number, number] | null {
	const nodes = json.nodes;
	if (!nodes || nodeIdx < 0 || nodeIdx >= nodes.length) return null;

	// 建父子映射：显式栈 + visited 去重，故每个节点最多入栈一次
	const parentMap = new Map<number, number>();
	const visited = new Set<number>();
	const stack: number[] = [];

	// 从 scene[0] 的根开始下行；pop() 取的是栈顶，故实际是深度优先
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

	// 回溯到根：guard 防自环，path 按「叶 → 根」顺序累积
	const path: number[] = [];
	let cur: number | undefined = nodeIdx;
	const guard = new Set<number>();
	while (cur !== undefined && !guard.has(cur)) {
		guard.add(cur);
		path.push(cur);
		cur = parentMap.get(cur);
	}

	// 自根向叶累加（path 反过来遍历）；取不到节点的层级直接跳过
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
			// 无 matrix 的节点只累加平移：rotation / scale 不参与位置累计
		}
	}

	return [pos.x, pos.y, pos.z];
}
