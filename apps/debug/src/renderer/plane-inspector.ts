/**
 * WebSurf — 准星射线检测器（debug 工程主线程）
 *
 * 职责：从相机位置沿给定方向发一条射线，在四类候选上求最近命中，组装成 `PlaneInfo`
 * 供 HUD 显示。本文件只做几何求交与字段填充：不读 DOM、不写物理世界状态。
 *
 * 四段候选（`cast` 按 mesh → solid → ladder → trigger 的顺序依次跑完）：
 * - `mesh`：`THREE.Raycaster.intersectObject` 取命中集第一项；
 * - `solid` / `ladder`：`Brush.planes` 的 ray-convex-polyhedron 精交，入口先做 ray-AABB 粗筛；
 * - `trigger`：`TeleportTrigger.mins`/`maxs` 的 ray-AABB（slab 法）+ 入口面法线推断。
 *
 * 类型之间没有固定优先级，唯一判据是距离：四段共用同一个 `bestDist`，每段命中都要
 * `distance < bestDist` 才替换 ⇒ 距离相等时**先跑的那段胜出**（严格小于才替换）。
 *
 * 上下游：
 * - 上游：`apps/debug/src/renderer/renderer-main.ts` 的 `inspectPlane`（受
 *   `PLANE_INSPECT_INTERVAL` 限频）传相机位置与相机前向 `(0,0,-1)` 调 `cast`；
 *   `solids`/`ladders` 来自 `apps/debug/src/world/collider-adapter.ts` 的 `adaptBrushes`，
 *   `triggers` 来自 `apps/debug/src/world/teleport-manager.ts` 的 `TeleportManager`。
 * - 下游：`apps/debug/src/renderer/renderer-main.ts` 的 `getPlaneInfo` 把结果交给
 *   `apps/debug/src/app.ts` 的 `formatPlaneInfo` 渲染成 HUD 文本。
 *
 * 不变量与边界：
 * - `dir` 必须是单位向量：四段都把射线参数 `t` 当距离用（HU）；本文件既不校验也不归一。
 * - mesh 段元数据取自 `mesh.userData.vbsp`（由 `apps/debug/src/renderer/renderer-main.ts`
 *   的 `collectMetadata` 写入）；该字段缺失时 `materialName`/`textureName` 退化为 `''`，
 *   `meshMeta` 退化为 `undefined`。
 * - 四段全部落空返回 `null`；`scene` 为 `null` 时跳过 mesh 段；`mins` 或 `maxs` 为 `null`
 *   的触发器跳过（`castTriggerAABB` 内以非空断言读这两个字段）。
 */

import * as THREE from 'three';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import type { PlaneInfo } from '../worker/worker-types.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';

/** `cast` 的 `maxDistance` 默认值（HU）。线上调用方不传该参数，故实际取此值。 */
const DEFAULT_MAX_DISTANCE = 8192;
/**
 * `castBrush` 的比较容差，两处量纲不同：
 * 判平面朝向时比 `dot(n, dir)`（无量纲），判「origin 在平面外侧」时比
 * `dot(n, origin) - plane.dist`（HU）。
 */
const EPS = 0.01;

/**
 * 准星射线检测器：无构造参数、无可调状态，命中结果按次返回。
 * 跨调用复用的只有两个临时对象（`_raycaster`、`_hitPoint`），故同一实例不可重入。
 */
export class PlaneInspector {
	/** 复用向量：承载 brush / trigger 两段的命中点，免去每次调用新建。 */
	private readonly _hitPoint = new THREE.Vector3();
	/** 复用 Raycaster：mesh 段每次重设 origin/dir/far，`near` 保持构造缺省。 */
	private readonly _raycaster = new THREE.Raycaster();

	/**
	 * 跑完四段候选取最近命中；四段全落空返回 `null`。
	 *
	 * 段间靠 `bestDist` 传递上界：mesh 段收 `maxDistance`，后三段收当前 `bestDist`，
	 * 于是后跑的类型一旦不近于已有命中，就在各段入口被剪掉。
	 *
	 * @param origin 射线起点（世界坐标，调用方传相机位置）。
	 * @param dir 射线方向，单位向量。
	 * @param scene 装载 BSP 模型几何的根对象；`null` 表示本次不做 mesh 求交。
	 * @param solids `Brush` 列表，命中记为 `type='solid'`，`brushIndex` 取该列表内下标。
	 * @param ladders `Brush` 列表，命中记为 `type='ladder'`，`brushIndex` 取该列表内下标。
	 * @param triggers `TeleportTrigger` 列表；`mins`/`maxs` 缺一的项跳过。
	 * @param maxDistance 射线最大距离（HU），同时是 `bestDist` 的初值。
	 * @returns 最近命中信息；无命中为 `null`。
	 */
	cast(
		origin: THREE.Vector3,
		dir: THREE.Vector3,
		scene: THREE.Object3D | null,
		solids: Brush[],
		ladders: Brush[],
		triggers: TeleportTrigger[],
		maxDistance: number = DEFAULT_MAX_DISTANCE,
	): PlaneInfo | null {
		let best: PlaneInfo | null = null;
		let bestDist = maxDistance;

		// ① mesh 段：先跑，故距离相等时由它占住 bestDist
		if (scene) {
			const hit = this.castMesh(scene, origin, dir, maxDistance);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// ② solid 碰撞体：以当前 bestDist 为上界逐个精交
		for (let i = 0; i < solids.length; i++) {
			const brush = solids[i];
			const hit = this.castBrush(brush, i, 'solid', origin, dir, bestDist);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// ③ ladder 碰撞体：同上，命中类型区分成 'ladder'
		for (let i = 0; i < ladders.length; i++) {
			const brush = ladders[i];
			const hit = this.castBrush(brush, i, 'ladder', origin, dir, bestDist);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// ④ 传送触发器：只做 AABB 求交；无包围盒的触发器由上面的 continue 拦下
		for (let i = 0; i < triggers.length; i++) {
			const trigger = triggers[i];
			if (!trigger.mins || !trigger.maxs) continue;
			const hit = this.castTriggerAABB(trigger, i, origin, dir, bestDist);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		return best;
	}

	/**
	 * mesh 段：设 `far = maxDist` 后对整个子树求交，取命中集第一项组装 `PlaneInfo`。
	 *
	 * 命中集按距离升序，故 `hits[0]` 即本段最近命中；`hit.object` 按 `THREE.Mesh` 断言后
	 * 直接用（场景里的非 Mesh 对象也参与求交，落在同一断言下）。
	 * 返回值中 `normal` 取面法线（`hit.face` 为 `null` 时写 `null`），
	 * `planeDist` 恒为 `null`、`brushIndex` 恒为 `-1`——这两个字段只由碰撞体/触发器分支填。
	 */
	private castMesh(
		scene: THREE.Object3D,
		origin: THREE.Vector3,
		dir: THREE.Vector3,
		maxDist: number,
	): PlaneInfo | null {
		this._raycaster.set(origin, dir);
		this._raycaster.far = maxDist;
		const hits = this._raycaster.intersectObject(scene, true);
		if (hits.length === 0) return null;

		const hit = hits[0];
		// 元数据在装载期由 renderer-main 的 collectMetadata 写到 userData.vbsp 上
		const mesh = hit.object as THREE.Mesh;
		const meta = mesh.userData?.vbsp as
			| {
					isTools?: boolean;
					isNodraw?: boolean;
					hasTexture?: boolean;
					isWater?: boolean;
					isTrans?: boolean;
					isLightEmissive?: boolean;
					textureName?: string;
					materialName?: string;
			  }
			| undefined;

		return {
			type: 'mesh',
			distance: hit.distance,
			point: [hit.point.x, hit.point.y, hit.point.z],
			normal: hit.face
				? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z]
				: null,
			planeDist: null,
			brushIndex: -1,
			// 块 mesh 由 renderer-main 的 optimizeScene 新建且不带 name/userData，
			// 故两个兜底分支在线上可达
			meshName: mesh.name || '(unnamed mesh)',
			materialName: meta?.materialName ?? '',
			textureName: meta?.textureName ?? '',
			// 六项分类标记缺一即按 false 填；meta 整体缺失时 meshMeta 写 undefined
			meshMeta: meta
				? {
						isTools: meta.isTools ?? false,
						isNodraw: meta.isNodraw ?? false,
						hasTexture: meta.hasTexture ?? false,
						isWater: meta.isWater ?? false,
						isTrans: meta.isTrans ?? false,
						isLightEmissive: meta.isLightEmissive ?? false,
					}
				: undefined,
		};
	}

	/**
	 * brush 段：ray-AABB 粗筛 + ray-convex-polyhedron 精交。
	 *
	 * 逐平面算 `t = (plane.dist - dot(n, origin)) / dot(n, dir)`，按 `dot(n, dir)` 分三路：
	 * - `< -EPS`（射线朝该平面内侧走）：取最大 `t` 作 `tEnter`，同时记下该平面法线与
	 *   `plane.dist`——返回值里的 `normal`/`planeDist` 都出自这里；
	 * - `> EPS`（朝外侧走）：取最小 `t` 作 `tExit`；
	 * - 落在 `[-EPS, EPS]`（与该平面平行）：`origin` 位于平面外侧时整条射线都在 brush 外，
	 *   立即返回 `null`（不是跳过该平面）。
	 *
	 * 拒绝条件：`tEnter > tExit`（未穿过），或 `tExit < 0`（brush 在相机背后）。
	 * 距离取 `tEnter > 0 ? tEnter : tExit`；后者对应相机已在 brush 内，给出出口。
	 * 相机在 brush 内时返回值里的法线是**进入面法线取反**（`normalSign = -1`）。
	 */
	private castBrush(
		brush: Brush,
		brushIndex: number,
		brushType: 'solid' | 'ladder',
		origin: THREE.Vector3,
		dir: THREE.Vector3,
		maxDist: number,
	): PlaneInfo | null {
		// 粗筛：AABB 未命中，或入口参数已越过当前距离上界
		const aabbHit = rayAABB(origin, dir, brush.min, brush.max);
		if (!aabbHit || aabbHit.tmin > maxDist) return null;

		// 精交：两个参数 + 进入面信息各自跟踪（法线/距离留给返回的 PlaneInfo）
		let tEnter = -Infinity;
		let tExit = +Infinity;
		let enterNormalX = 0;
		let enterNormalY = 0;
		let enterNormalZ = 0;
		let enterDist = 0;

		for (const plane of brush.planes) {
			const n = plane.normal;
			const denom = n.x * dir.x + n.y * dir.y + n.z * dir.z;
			const distToOrigin =
				n.x * origin.x + n.y * origin.y + n.z * origin.z;
			const t = (plane.dist - distToOrigin) / denom;

			if (denom < -EPS) {
				// 朝平面内侧：候选进入面（取最大 t）
				if (t > tEnter) {
					tEnter = t;
					enterNormalX = n.x;
					enterNormalY = n.y;
					enterNormalZ = n.z;
					enterDist = plane.dist;
				}
			} else if (denom > EPS) {
				// 朝平面外侧：候选离开面（取最小 t）
				if (t < tExit) {
					tExit = t;
				}
			} else {
				// 与该平面平行：origin 在外侧 ⇒ 整条射线都在 brush 外
				if (distToOrigin > plane.dist + EPS) {
					return null;
				}
			}
		}

		// 拒绝：进入晚于离开（未穿过），或出口在相机背后（tExit 为负）
		if (tEnter > tExit || tExit < 0) return null;

		// 取进入 t；tEnter 非正说明起点已在 brush 内，此时取出口 t
		const t = tEnter > 0 ? tEnter : tExit;
		if (t > maxDist) return null;

		// 取到出口 t 时把进入面法线取反，使其朝向射线来向
		const isEntry = t === tEnter;
		const normalSign = isEntry ? 1 : -1;

		this._hitPoint.set(
			origin.x + dir.x * t,
			origin.y + dir.y * t,
			origin.z + dir.z * t,
		);

		return {
			type: brushType,
			normal: [
				enterNormalX * normalSign,
				enterNormalY * normalSign,
				enterNormalZ * normalSign,
			],
			planeDist: enterDist,
			distance: t,
			point: [this._hitPoint.x, this._hitPoint.y, this._hitPoint.z],
			brushIndex,
		};
	}

	/**
	 * trigger 段：ray-AABB（slab 法）求入口/出口参数，并记下取得 `tmin` 的轴与方向符号，
	 * 用来拼出入口面法线。
	 *
	 * 与 `castBrush` 的差别：这里只处理轴向 AABB，判据逐轴即时比较（`tmin > tmax` 即退出），
	 * 距离取 `tmin > 0 ? tmin : tmax`（起点在盒内时给出出口）。
	 * 法线只有一个分量非零：`normal[enterAxis] = ±1`；三轴全平行（方向向量为零向量）时
	 * `enterAxis` 保持 `-1`，法线为 `[0,0,0]`，`planeDist` 随之恒为 `0`。
	 */
	private castTriggerAABB(
		trigger: TeleportTrigger,
		triggerIndex: number,
		origin: THREE.Vector3,
		dir: THREE.Vector3,
		maxDist: number,
	): PlaneInfo | null {
		const mins = trigger.mins!;
		const maxs = trigger.maxs!;

		// slab 法求交，同时记录取到 tmin 的轴与符号（拼入口面法线用）
		let tmin = -Infinity;
		let tmax = +Infinity;
		let enterAxis = -1; // 0=x, 1=y, 2=z；三轴全平行时保持 -1
		let enterSign = 0; // 与 enterAxis 配套：+1 朝 +轴，-1 朝 -轴

		const o = [origin.x, origin.y, origin.z];
		const d = [dir.x, dir.y, dir.z];
		const mn = [mins.x, mins.y, mins.z];
		const mx = [maxs.x, maxs.y, maxs.z];

		for (let i = 0; i < 3; i++) {
			const di = d[i];
			if (Math.abs(di) < 1e-8) {
				// 该轴平行：origin 必须落在这一对 slab 之间
				if (o[i] < mn[i] || o[i] > mx[i]) return null;
			} else {
				let t1 = (mn[i] - o[i]) / di;
				let t2 = (mx[i] - o[i]) / di;
				let sign1 = -1; // 与 t1（mins 面）配套：法线朝 -轴
				let sign2 = +1; // 与 t2（maxs 面）配套：法线朝 +轴
				if (t1 > t2) {
					const tmp = t1;
					t1 = t2;
					t2 = tmp;
					const ts = sign1;
					sign1 = sign2;
					sign2 = ts;
				}
				if (t1 > tmin) {
					tmin = t1;
					enterAxis = i;
					enterSign = sign1;
				}
				if (t2 < tmax) {
					tmax = t2;
				}
				if (tmin > tmax) return null;
			}
		}

		if (tmin > maxDist) return null;
		// tmin 非正表示起点在盒内：改用 tmax（出口）作命中距离
		const t = tmin > 0 ? tmin : tmax;
		if (t < 0 || t > maxDist) return null;

		// 入口面法线：只有 enterAxis 一个分量非零
		const normal: [number, number, number] = [0, 0, 0];
		if (enterAxis >= 0) {
			normal[enterAxis] = enterSign * (tmin > 0 ? 1 : -1);
		}

		this._hitPoint.set(
			origin.x + dir.x * t,
			origin.y + dir.y * t,
			origin.z + dir.z * t,
		);

		// planeDist 按定义取 dot(normal, 命中点)；法线为零向量时结果为 0
		const planeDist =
			normal[0] * this._hitPoint.x +
			normal[1] * this._hitPoint.y +
			normal[2] * this._hitPoint.z;

		return {
			type: 'trigger',
			normal,
			planeDist,
			distance: t,
			point: [this._hitPoint.x, this._hitPoint.y, this._hitPoint.z],
			brushIndex: triggerIndex,
			// 五项触发器信息原样透传（缺省由 worker-types 的 PlaneInfo 标注）
			triggerTarget: trigger.target,
			triggerDestIdx: trigger.destIndex,
			triggerClassname: trigger.classname,
			triggerSpawnflags: trigger.spawnflags,
			triggerStartDisabled: trigger.startDisabled,
		};
	}
}

// ---------------------------------------------------------------------------
// 射线求交辅助（与类实例无关的纯函数与类型）
// ---------------------------------------------------------------------------

/** `rayAABB` 的返回：两个射线参数。 */
interface AabbHit {
	/** 进入盒子的参数（三轴进入参数取最大）。 */
	tmin: number;
	/** 离开盒子的参数（三轴离开参数取最小）。 */
	tmax: number;
}

/**
 * ray-AABB 求交（slab 法），只算参数、不做可见性判定。
 *
 * 某轴方向分量为 0（`|d| < 1e-8`）时要求 `origin` 落在该轴区间内，否则返回 `null`；
 * 任一轴算完若 `tmin > tmax` 立即返回 `null`（盒子被射线错过）。
 * 两个参数初值为 `-Infinity` / `+Infinity`：三个轴全部平行时原样返回这一对值，
 * 由调用方（`castBrush` 的 `tmin > maxDist`、`castTriggerAABB` 的 `t` 判断）自行收敛。
 */
function rayAABB(
	origin: THREE.Vector3,
	dir: THREE.Vector3,
	min: { x: number; y: number; z: number },
	max: { x: number; y: number; z: number },
): AabbHit | null {
	let tmin = -Infinity;
	let tmax = +Infinity;

	const o = [origin.x, origin.y, origin.z];
	const d = [dir.x, dir.y, dir.z];
	const mn = [min.x, min.y, min.z];
	const mx = [max.x, max.y, max.z];

	for (let i = 0; i < 3; i++) {
		const di = d[i];
		if (Math.abs(di) < 1e-8) {
			// 该轴平行：origin 越界即判无交
			if (o[i] < mn[i] || o[i] > mx[i]) return null;
		} else {
			let t1 = (mn[i] - o[i]) / di;
			let t2 = (mx[i] - o[i]) / di;
			if (t1 > t2) {
				// 统一成 t1 = 进入、t2 = 离开，便于与累计区间求交
				const tmp = t1;
				t1 = t2;
				t2 = tmp;
			}
			if (t1 > tmin) tmin = t1;
			if (t2 < tmax) tmax = t2;
			if (tmin > tmax) return null;
		}
	}

	return { tmin, tmax };
}
