/**
 * WebSurf — 准星射线检测器（hover 查看模型/实体平面/触发面信息）
 *
 * 从相机发射射线，返回最近命中信息：
 * 1. **GLB 模型几何**（mesh）：用 THREE.Raycaster 对 BSP 场景求交，
 *    返回 mesh.name（模型名，如 "crate"、"crate#1"）+ 材质/纹理名。
 * 2. **实体碰撞箱**（solid/ladder brush）：Ray-Convex-Polyhedron 精交，
 *    返回法线/距离/brush 索引/类型。
 * 3. **传送触发器**（trigger AABB）：Ray-AABB + 入口面法线推断，
 *    返回 classname/target/dest 等触发信息。
 *
 * 优先级：mesh 几何 > 碰撞体 > 触发器（场景几何最贴近玩家所见）。
 *
 * 算法：
 * - Ray-AABB broadphase（slab 法）快速剔除不相交的 brush
 * - Ray-Convex-Polyhedron 精交（对每个平面求 t，取 tEnter 最大者作为入口平面）
 *
 * 性能：限频调用（每 6 帧一次，由 render-loop 控制）；maxDistance 8192 HU。
 */

import * as THREE from 'three';
import type { Brush } from '../physics/physics/Collision/Collision.types.js';
import type { PlaneInfo } from '../worker/worker-types.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';

/** 默认射线最大距离（HU）。 */
const DEFAULT_MAX_DISTANCE = 8192;
/** 浮点容差（HU）。 */
const EPS = 0.01;

/**
 * 准星射线检测器。
 *
 * 用法：
 *   const result = inspector.cast(camPos, camDir, scene, solids, ladders, triggers);
 *   if (result) { /* 使用 result.type / result.meshName / result.brushIndex 等 *\/ }
 */
export class PlaneInspector {
	/** 复用向量，避免每帧分配。 */
	private readonly _hitPoint = new THREE.Vector3();
	/** Raycaster（mesh 求交）。 */
	private readonly _raycaster = new THREE.Raycaster();

	/**
	 * 从相机发射射线，返回最近命中信息。
	 *
	 * @param origin 射线起点（相机世界坐标）。
	 * @param dir 射线方向（已归一化）。
	 * @param scene BSP 场景（GLB 模型几何，mesh 求交）。
	 * @param solids solid 碰撞体列表（World.solids）。
	 * @param ladders ladder 碰撞体列表（World.ladders）。
	 * @param triggers 传送触发器列表（来自 TeleportManager）。
	 * @param maxDistance 射线最大距离（HU）。
	 * @returns 最近命中信息，或 null（未命中）。
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

		// 1. GLB 模型几何（mesh 优先，最贴近所见）
		if (scene) {
			const hit = this.castMesh(scene, origin, dir, maxDistance);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// 2. Raycast against solids（brushType='solid'）
		for (let i = 0; i < solids.length; i++) {
			const brush = solids[i];
			const hit = this.castBrush(brush, i, 'solid', origin, dir, bestDist);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// 3. Raycast against ladders（brushType='ladder'）
		for (let i = 0; i < ladders.length; i++) {
			const brush = ladders[i];
			const hit = this.castBrush(brush, i, 'ladder', origin, dir, bestDist);
			if (hit && hit.distance < bestDist) {
				best = hit;
				bestDist = hit.distance;
			}
		}

		// 4. Raycast against triggers（AABB only）
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
	 * THREE.Raycaster 对场景 mesh 求交，返回模型信息。
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
			meshName: mesh.name || '(unnamed mesh)',
			materialName: meta?.materialName ?? '',
			textureName: meta?.textureName ?? '',
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
	 * Ray-Convex-Polyhedron 求交。
	 *
	 * 算法（Source 引擎标准 ray-trace）：
	 * - 对每个平面求 t = (dist - dot(n, origin)) / dot(n, dir)
	 * - dot(n, dir) < 0：射线进入 brush（从外向内），tEnter = max(这些 t)
	 * - dot(n, dir) > 0：射线离开 brush（从内向外），tExit = min(这些 t)
	 * - dot(n, dir) = 0：平行，若 origin 在该平面外侧则无交
	 * - 命中条件：tEnter <= tExit 且 tExit > 0
	 * - 入口平面 = 取得 tEnter 的那个平面
	 */
	private castBrush(
		brush: Brush,
		brushIndex: number,
		brushType: 'solid' | 'ladder',
		origin: THREE.Vector3,
		dir: THREE.Vector3,
		maxDist: number,
	): PlaneInfo | null {
		// 1. Ray-AABB broadphase
		const aabbHit = rayAABB(origin, dir, brush.min, brush.max);
		if (!aabbHit || aabbHit.tmin > maxDist) return null;

		// 2. Ray-Convex-Polyhedron 精交
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
				// 射线进入 brush（从外向内）
				if (t > tEnter) {
					tEnter = t;
					enterNormalX = n.x;
					enterNormalY = n.y;
					enterNormalZ = n.z;
					enterDist = plane.dist;
				}
			} else if (denom > EPS) {
				// 射线离开 brush（从内向外）
				if (t < tExit) {
					tExit = t;
				}
			} else {
				// 平行：若 origin 在该平面外侧（外部），整个 brush 在射线侧外
				if (distToOrigin > plane.dist + EPS) {
					return null;
				}
			}
		}

		// 命中条件：tEnter <= tExit 且 tExit > 0
		if (tEnter > tExit || tExit < 0) return null;

		// t 取值：优先 tEnter（射线从外部进入），否则 tExit（相机在 brush 内）
		const t = tEnter > 0 ? tEnter : tExit;
		if (t > maxDist) return null;

		// 若 t === tExit（相机在 brush 内），入口平面法线方向需翻转（朝向相机）
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
	 * Ray-AABB 求交 + 入口面法线推断。
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

		// Ray-AABB（slab 法）+ 跟踪入口轴
		let tmin = -Infinity;
		let tmax = +Infinity;
		let enterAxis = -1; // 0=x, 1=y, 2=z
		let enterSign = 0; // +1 或 -1（面法线方向）

		const o = [origin.x, origin.y, origin.z];
		const d = [dir.x, dir.y, dir.z];
		const mn = [mins.x, mins.y, mins.z];
		const mx = [maxs.x, maxs.y, maxs.z];

		for (let i = 0; i < 3; i++) {
			const di = d[i];
			if (Math.abs(di) < 1e-8) {
				// 平行：origin 必须在 slab 内
				if (o[i] < mn[i] || o[i] > mx[i]) return null;
			} else {
				let t1 = (mn[i] - o[i]) / di;
				let t2 = (mx[i] - o[i]) / di;
				let sign1 = -1; // t1 对应 mins 面，法线朝 -轴
				let sign2 = +1; // t2 对应 maxs 面，法线朝 +轴
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
		// 若相机在 AABB 内（tmin < 0），使用 tmax 作为出口
		const t = tmin > 0 ? tmin : tmax;
		if (t < 0 || t > maxDist) return null;

		// 入口面法线
		const normal: [number, number, number] = [0, 0, 0];
		if (enterAxis >= 0) {
			normal[enterAxis] = enterSign * (tmin > 0 ? 1 : -1);
		}

		this._hitPoint.set(
			origin.x + dir.x * t,
			origin.y + dir.y * t,
			origin.z + dir.z * t,
		);

		// 平面 dist = dot(normal, pointOnPlane)
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
			triggerTarget: trigger.target,
			triggerDestIdx: trigger.destIndex,
			triggerClassname: trigger.classname,
			triggerSpawnflags: trigger.spawnflags,
			triggerStartDisabled: trigger.startDisabled,
		};
	}
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** Ray-AABB 求交结果。 */
interface AabbHit {
	/** 入口 t（射线参数）。 */
	tmin: number;
	/** 出口 t。 */
	tmax: number;
}

/**
 * Ray-AABB 求交（slab 法）。
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
			if (o[i] < mn[i] || o[i] > mx[i]) return null;
		} else {
			let t1 = (mn[i] - o[i]) / di;
			let t2 = (mx[i] - o[i]) / di;
			if (t1 > t2) {
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
