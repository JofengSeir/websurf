/**
 * WebSurf — 碰撞体可视化
 * 1. 实体碰撞箱：玩家附近 512 HU 内 brush 真实凸包线框（从 planes 重建，非 AABB），
 *    三色分类（地面绿/斜坡黄/墙红）；身处 brush 内部时叠加半透明填充。
 * 2. 传送触发碰撞箱：全部 trigger 凸包/AABB 线框（青=已链接/紫=孤儿/灰=禁用/橙=非玩家）。
 * 凸包重建与 Rust compute_vertices 同算法（三平面求交 + 内侧验证）。
 */

import * as THREE from 'three';
import type { Brush, TriMesh } from '../physics/physics/Collision/Collision.types.js';
import type { RuntimeConfig } from '../config.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';

/** 玩家附近显示半径（HU）。 */
const DEBUG_RADIUS = 512;
/** Y 方向上下扩展（HU）。 */
const DEBUG_Y_EXTENT = 300;
/** 最多显示的碰撞体数量。 */
const MAX_DEBUG_COLLIDERS = 800;
/** 重建限流（每 N 帧）。 */
const REBUILD_INTERVAL = 6;
/** 模型三角形碰撞线框重建限流（每 N 帧；三角形量大，重建更慢）。 */
const TRI_REBUILD_INTERVAL = 30;
/** 碰撞体半透明填充不透明度（0-1）。仅相机进入 brush 内部时显示，且颜色淡。 */
const FILL_OPACITY = 0.09;

/** 颜色（RGB 0..1）。 */
interface RgbColor {
	r: number;
	g: number;
	b: number;
}

const COLOR_GROUND: RgbColor = { r: 0.1, g: 1.0, b: 0.1 };
const COLOR_SLOPE: RgbColor = { r: 1.0, g: 0.9, b: 0.1 };
const COLOR_WALL: RgbColor = { r: 1.0, g: 0.2, b: 0.1 };
/** 触发碰撞箱：已链接 + 启用 + 对玩家生效（青）。 */
const COLOR_TRIGGER_LINKED: RgbColor = { r: 0.2, g: 0.8, b: 0.9 };
/** 触发碰撞箱：孤儿触发器（紫）。 */
const COLOR_TRIGGER_ORPHAN: RgbColor = { r: 0.6, g: 0.2, b: 0.9 };
/** 触发碰撞箱：初始禁用 / StartDisabled=1（灰）。 */
const COLOR_TRIGGER_DISABLED: RgbColor = { r: 0.5, g: 0.5, b: 0.5 };
/** 触发碰撞箱：spawnflags 不含 Clients 且非 Everything（橙）。 */
const COLOR_TRIGGER_NON_PLAYER: RgbColor = { r: 1.0, g: 0.6, b: 0.2 };

/** spawnflags: bit 1 = Clients, bit 64 = Everything。 */
const SPAWNFLAG_CLIENTS = 0x01;
const SPAWNFLAG_EVERYTHING = 0x40;

// ---------------------------------------------------------------------------
// 真实碰撞几何：从 brush 平面列表重建凸包线框（与 Rust compute_vertices 同算法）
// ---------------------------------------------------------------------------

/** 平面交点的有效容差（HU）。 */
const HULL_EPS = 0.5;
/** 面内顶点判定容差（HU）。 */
const FACE_EPS = 0.5;
/** 顶点去重距离平方（HU²）。 */
const VERT_DUP_SQ = 0.01;

interface PlaneLike {
	normal: { x: number; y: number; z: number };
	dist: number;
}

/** 三平面求交点（克莱默法则），退化返回 null。 */
function planeIntersect(
	p1: PlaneLike,
	p2: PlaneLike,
	p3: PlaneLike,
): [number, number, number] | null {
	const n1 = p1.normal;
	const n2 = p2.normal;
	const n3 = p3.normal;
	const c23 = [
		n2.y * n3.z - n2.z * n3.y,
		n2.z * n3.x - n2.x * n3.z,
		n2.x * n3.y - n2.y * n3.x,
	];
	const det = n1.x * c23[0] + n1.y * c23[1] + n1.z * c23[2];
	if (Math.abs(det) < 1e-6) return null;
	const c31 = [
		n3.y * n1.z - n3.z * n1.y,
		n3.z * n1.x - n3.x * n1.z,
		n3.x * n1.y - n3.y * n1.x,
	];
	const c12 = [
		n1.y * n2.z - n1.z * n2.y,
		n1.z * n2.x - n1.x * n2.z,
		n1.x * n2.y - n1.y * n2.x,
	];
	const inv = 1 / det;
	return [
		(c23[0] * p1.dist + c31[0] * p2.dist + c12[0] * p3.dist) * inv,
		(c23[1] * p1.dist + c31[1] * p2.dist + c12[1] * p3.dist) * inv,
		(c23[2] * p1.dist + c31[2] * p2.dist + c12[2] * p3.dist) * inv,
	];
}

/**
 * 从 brush 平面重建凸包顶点。
 * 约定：法线朝外（内部 dot(n,p)-dist <= 0，与 Rust compute_vertices 一致），
 * 三平面组合求交并验证在所有平面内侧；顶点数 < 4 视为退化（回退 AABB）。
 */
function computeBrushHull(brush: Brush): [number, number, number][] {
	const ps = brush.planes;
	if (ps.length < 4) return [];
	const verts: [number, number, number][] = [];
	for (let i = 0; i < ps.length; i++) {
		for (let j = i + 1; j < ps.length; j++) {
			for (let k = j + 1; k < ps.length; k++) {
				const v = planeIntersect(ps[i], ps[j], ps[k]);
				if (!v) continue;
				let ok = true;
				for (const p of ps) {
					if (p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist > HULL_EPS) {
						ok = false;
						break;
					}
				}
				if (!ok) continue;
				// 去重（顶点数少，O(m²) 足够）
				let dup = false;
				for (const ev of verts) {
					const dx = ev[0] - v[0];
					const dy = ev[1] - v[1];
					const dz = ev[2] - v[2];
					if (dx * dx + dy * dy + dz * dz < VERT_DUP_SQ) {
						dup = true;
						break;
					}
				}
				if (!dup) verts.push(v);
			}
		}
	}
	return verts;
}

/**
 * 对 brush 的每个平面，返回落在面上的顶点索引，按绕法线的极角排序为凸多边形。
 */
function orderedFaces(
	brush: Brush,
	verts: [number, number, number][],
): number[][] {
	const faces: number[][] = [];
	for (const p of brush.planes) {
		const n = p.normal;
		// 面上顶点
		const face: number[] = [];
		for (let vi = 0; vi < verts.length; vi++) {
			const v = verts[vi];
			const d = n.x * v[0] + n.y * v[1] + n.z * v[2] - p.dist;
			if (Math.abs(d) < FACE_EPS) face.push(vi);
		}
		if (face.length < 3) continue;
		// 质心
		let cx = 0, cy = 0, cz = 0;
		for (const vi of face) {
			cx += verts[vi][0];
			cy += verts[vi][1];
			cz += verts[vi][2];
		}
		const inv = 1 / face.length;
		cx *= inv;
		cy *= inv;
		cz *= inv;
		// 平面内正交基
		const refDir: [number, number, number] =
			Math.abs(n.x) < 0.9 ? [1, 0, 0] : [0, 1, 0];
		const dotRn = refDir[0] * n.x + refDir[1] * n.y + refDir[2] * n.z;
		let ux = refDir[0] - dotRn * n.x;
		let uy = refDir[1] - dotRn * n.y;
		let uz = refDir[2] - dotRn * n.z;
		const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
		if (ulen < 1e-6) continue;
		ux /= ulen;
		uy /= ulen;
		uz /= ulen;
		const vx = n.y * uz - n.z * uy;
		const vy = n.z * ux - n.x * uz;
		const vz = n.x * uy - n.y * ux;
		// 按极角排序
		const angled: { vi: number; ang: number }[] = face.map((vi) => {
			const va = verts[vi];
			const dx = va[0] - cx;
			const dy = va[1] - cy;
			const dz = va[2] - cz;
			return {
				vi,
				ang: Math.atan2(dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz),
			};
		});
		angled.sort((a, b) => a.ang - b.ang);
		faces.push(angled.map((a) => a.vi));
	}
	return faces;
}

/**
 * 把 brush 凸包画成线框：对每个面，闭合多边形连边（真实碰撞几何边）。
 */
function pushBrushWireframe(
	positions: number[],
	colors: number[],
	brush: Brush,
	verts: [number, number, number][],
	color: RgbColor,
): void {
	const faces = orderedFaces(brush, verts);
	for (const face of faces) {
		const len = face.length;
		for (let i = 0; i < len; i++) {
			const a = verts[face[i]];
			const b = verts[face[(i + 1) % len]];
			positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
			colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
		}
	}
}

/**
 * 判断点是否在 brush 凸包内部（cs-movement 法线朝外约定：内部 dot(n,p)-dist <= 0）。
 * 容差 1.0 HU 容忍浮点误差。
 */
function isPointInsideBrush(
	pos: { x: number; y: number; z: number },
	brush: Brush,
): boolean {
	for (const p of brush.planes) {
		const d = p.normal.x * pos.x + p.normal.y * pos.y + p.normal.z * pos.z - p.dist;
		if (d > 1.0) return false;
	}
	return true;
}

/**
 * 把 brush 凸包填充为半透明实心：对每个面（凸多边形）做扇形三角化。
 * 与线框共用 `orderedFaces`，填充严格贴合描边，一眼分辨内外。
 */
function pushBrushFill(
	positions: number[],
	colors: number[],
	brush: Brush,
	verts: [number, number, number][],
	color: RgbColor,
): void {
	const faces = orderedFaces(brush, verts);
	for (const face of faces) {
		if (face.length < 3) continue;
		const anchor = verts[face[0]];
		for (let i = 1; i < face.length - 1; i++) {
			const b = verts[face[i]];
			const c = verts[face[i + 1]];
			positions.push(
				anchor[0], anchor[1], anchor[2],
				b[0], b[1], b[2],
				c[0], c[1], c[2],
			);
			colors.push(
				color.r, color.g, color.b,
				color.r, color.g, color.b,
				color.r, color.g, color.b,
			);
		}
	}
}

/**
 * 将一个 AABB 的 12 条边推入 positions/colors 数组（凸包退化时回退）。
 */
function pushAabbEdges(
	positions: number[],
	colors: number[],
	min: { x: number; y: number; z: number },
	max: { x: number; y: number; z: number },
	color: RgbColor,
): void {
	const { r, g, b: blue } = color;
	const x0 = min.x;
	const y0 = min.y;
	const z0 = min.z;
	const x1 = max.x;
	const y1 = max.y;
	const z1 = max.z;

	const corners: [number, number, number][] = [
		[x0, y0, z0],
		[x1, y0, z0],
		[x1, y0, z1],
		[x0, y0, z1],
		[x0, y1, z0],
		[x1, y1, z0],
		[x1, y1, z1],
		[x0, y1, z1],
	];

	const edges: [number, number][] = [
		[0, 1], [1, 2], [2, 3], [3, 0],
		[4, 5], [5, 6], [6, 7], [7, 4],
		[0, 4], [1, 5], [2, 6], [3, 7],
	];

	for (const [a, b] of edges) {
		const pa = corners[a];
		const pb = corners[b];
		positions.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
		colors.push(r, g, blue, r, g, blue);
	}
}

/**
 * 按 brush 中最朝上的平面法线分类颜色。
 *
 * - max(n.y) > cos(groundAngle) → 地面（绿）
 * - max(n.y) > cos(slideAngle) → 斜坡（黄）
 * - else → 墙（红）
 */
function classifyBrush(
	brush: Brush,
	groundAngleCos: number,
	slideAngleCos: number,
): RgbColor {
	let maxNy = -2;
	for (const plane of brush.planes) {
		if (plane.normal.y > maxNy) maxNy = plane.normal.y;
	}

	if (maxNy > groundAngleCos) return COLOR_GROUND;
	if (maxNy > slideAngleCos) return COLOR_SLOPE;
	return COLOR_WALL;
}

// ---------------------------------------------------------------------------
// 碰撞体可视化管理器
// ---------------------------------------------------------------------------

/**
 * 每帧由 render-loop 调用 `update`，内部每 6 帧重建实体碰撞箱线框，
 * 触发碰撞箱数量少直接每帧重建。两个开关独立（showSolids / showTriggers）。
 */
export class ColliderDebug {
	private scene: THREE.Scene | null = null;
	/** 实体碰撞箱线框组（受 showSolids 控制）。 */
	private solidGroup: THREE.Group | null = null;
	/** 模型三角形碰撞网格线框组（受 showSolids 控制）。 */
	private triGroup: THREE.Group | null = null;
	/** 触发碰撞箱线框组（受 showTriggers 控制）。 */
	private triggerGroup: THREE.Group | null = null;
	private showSolids = false;
	private showTriggers = false;
	private frameCounter = 0;
	private triFrameCounter = 0;
	/** 传送触发器列表（由 PhysicsWorker 注入）。 */
	private triggers: readonly TeleportTrigger[] = [];
	/** 模型三角形碰撞网格（由渲染主线程注入）。 */
	private triMeshes: TriMesh[] = [];

	/** 初始化调试 Group。 */
	init(scene: THREE.Scene): void {
		this.scene = scene;
		this.solidGroup = new THREE.Group();
		this.solidGroup.name = '__vbsp_collider_debug__';
		this.solidGroup.visible = false;
		scene.add(this.solidGroup);

		this.triGroup = new THREE.Group();
		this.triGroup.name = '__model_tri_collider_debug__';
		this.triGroup.visible = false;
		scene.add(this.triGroup);

		this.triggerGroup = new THREE.Group();
		this.triggerGroup.name = '__vbsp_trigger_debug__';
		this.triggerGroup.visible = false;
		scene.add(this.triggerGroup);
	}

	/** 注入模型三角形碰撞网格（场景加载后调用）。 */
	setTriMeshes(meshes: TriMesh[]): void {
		this.triMeshes = meshes;
		this.triFrameCounter = TRI_REBUILD_INTERVAL;
	}

	/** 注入传送触发器列表（场景加载后调用）。 */
	setTriggers(triggers: readonly TeleportTrigger[]): void {
		this.triggers = triggers;
		// 触发下一帧立即重建
		this.frameCounter = REBUILD_INTERVAL;
	}

	/** 设置显示标志（showSolids / showTriggers）。 */
	setDebugFlags(showSolids: boolean, showTriggers: boolean): void {
		this.showSolids = showSolids;
		this.showTriggers = showTriggers;
		if (this.solidGroup) {
			this.solidGroup.visible = showSolids;
			if (!showSolids) this.clearGroup(this.solidGroup);
		}
		if (this.triGroup) {
			this.triGroup.visible = showSolids;
			if (!showSolids) this.clearGroup(this.triGroup);
		}
		if (this.triggerGroup) {
			this.triggerGroup.visible = showTriggers;
			if (!showTriggers) this.clearGroup(this.triggerGroup);
		}
		this.frameCounter = REBUILD_INTERVAL;
		this.triFrameCounter = TRI_REBUILD_INTERVAL;
	}

	/**
	 * 每帧更新。
	 * @param cameraPos 相机世界坐标（眼睛位置）。
	 * @param colliders 实体碰撞体（World.solids + ladders）。
	 * @param config 运行时配置。
	 * @returns 是否重建线框（据此触发渲染）。
	 */
	update(
		cameraPos: THREE.Vector3,
		colliders: Brush[],
		config: RuntimeConfig,
	): boolean {
		if (!this.scene) return false;
		let rebuilt = false;

		// 1. 实体碰撞箱（受 showSolids 控制，限流）
		if (this.showSolids && this.solidGroup) {
			this.frameCounter++;
			if (this.frameCounter >= REBUILD_INTERVAL) {
				this.frameCounter = 0;
				this.rebuildSolids(cameraPos, colliders, config);
				rebuilt = true;
			}
		}

		// 1.5 模型三角形碰撞网格（受 showSolids 控制，独立限流——重建成本高）
		if (this.showSolids && this.triGroup) {
			this.triFrameCounter++;
			if (this.triFrameCounter >= TRI_REBUILD_INTERVAL) {
				this.triFrameCounter = 0;
				this.rebuildTriangles(cameraPos);
				rebuilt = true;
			}
		}

		// 2. 触发碰撞箱（受 showTriggers 控制，数量少直接每帧重建）
		if (this.showTriggers && this.triggerGroup) {
			this.rebuildTriggers();
			rebuilt = true;
		}

		return rebuilt;
	}

	/** 当前是否有调试显示工作（render-loop 据此决定是否调用 update）。 */
	get hasDebugWork(): boolean {
		return this.showSolids || this.showTriggers;
	}

	/**
	 * 重建实体碰撞箱线框（清旧 + 收集附近 brush + 凸包线框 + 内部半透明填充）。
	 */
	private rebuildSolids(
		cameraPos: THREE.Vector3,
		colliders: Brush[],
		config: RuntimeConfig,
	): void {
		this.clearGroup(this.solidGroup!);

		if (colliders.length === 0) return;

		const pos = cameraPos;
		const playerHeight = config.player.standHeight;
		const feetY = pos.y - playerHeight + config.player.eyeOffset;
		const minY = feetY - DEBUG_Y_EXTENT;
		const maxY = feetY + playerHeight + DEBUG_Y_EXTENT;
		const radiusSq = DEBUG_RADIUS * DEBUG_RADIUS;

		// 过滤附近 brush（XZ 距离 < radius，Y 在范围内）
		const nearby: { brush: Brush; distSq: number }[] = [];
		for (const brush of colliders) {
			const nx = Math.max(brush.min.x, Math.min(pos.x, brush.max.x));
			const nz = Math.max(brush.min.z, Math.min(pos.z, brush.max.z));
			const dx = pos.x - nx;
			const dz = pos.z - nz;
			const distSq = dx * dx + dz * dz;
			if (distSq > radiusSq) continue;
			if (brush.max.y < minY || brush.min.y > maxY) continue;
			nearby.push({ brush, distSq });
		}

		if (nearby.length === 0) return;

		if (nearby.length > MAX_DEBUG_COLLIDERS) {
			nearby.sort((a, b) => a.distSq - b.distSq);
			nearby.length = MAX_DEBUG_COLLIDERS;
		}

		const groundAngleCos = Math.cos(config.physics.groundAngle);
		const slideAngleCos = Math.cos(config.physics.slideAngle);

		const positions: number[] = [];
		const colors: number[] = [];
		const fillPositions: number[] = [];
		const fillColors: number[] = [];

		for (const { brush } of nearby) {
			const color = classifyBrush(brush, groundAngleCos, slideAngleCos);
			// planes → 凸包线框（斜坡/斜面显示真实形状）；退化（顶点 < 4）回退 AABB
			const hull = computeBrushHull(brush);
			if (hull.length >= 4) {
				pushBrushWireframe(positions, colors, brush, hull, color);
				// 仅相机进入 brush 内部时显示半透明填充（提示"身处固体内部"）
				if (isPointInsideBrush(pos, brush)) {
					pushBrushFill(fillPositions, fillColors, brush, hull, color);
				}
			} else {
				pushAabbEdges(positions, colors, brush.min, brush.max, color);
			}
		}

		// 半透明实心填充（先渲染，线框盖在上面；depthWrite=false 不遮挡描边）
		if (fillPositions.length > 0) {
			const fgeom = new THREE.BufferGeometry();
			fgeom.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));
			fgeom.setAttribute('color', new THREE.Float32BufferAttribute(fillColors, 3));
			const fmat = new THREE.MeshBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: FILL_OPACITY,
				side: THREE.DoubleSide, // 内部视角也能看到填充，便于分辨内外
				depthWrite: false,
			});
			this.solidGroup!.add(new THREE.Mesh(fgeom, fmat));
		}

		if (positions.length === 0) return;

		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
		const mat = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.6,
			depthTest: true,
		});
		this.solidGroup!.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 重建模型三角形碰撞网格线框（只显示玩家附近半径内的三角形）。
	 * 按来源分组着色：可视网格=青色 / 模型自带碰撞体(.phy)=黄色（surfaceprop 存在即 .phy 来源）。
	 */
	private rebuildTriangles(cameraPos: THREE.Vector3): void {
		this.clearGroup(this.triGroup!);
		if (this.triMeshes.length === 0) return;

		const pos = cameraPos;
		const radiusSq = DEBUG_RADIUS * DEBUG_RADIUS;
		/** 附近三角形上限（超限截断，避免拖垮每帧重建）。 */
		const MAX_TRI_LINES = 12_000;

		const visPos: number[] = []; // 可视网格（青）
		const phyPos: number[] = []; // 模型自带 .phy（黄）
		let triCount = 0;

		for (const mesh of this.triMeshes) {
			if (triCount * 3 >= MAX_TRI_LINES) break;
			// mesh AABB 距离粗筛（顶点/边界为紧凑数组 `[x,y,z]`；Y-up 水平面 = x/z）
			const nx = Math.max(mesh.min[0], Math.min(pos.x, mesh.max[0]));
			const nz = Math.max(mesh.min[2], Math.min(pos.z, mesh.max[2]));
			const dx = pos.x - nx;
			const dz = pos.z - nz;
			if (dx * dx + dz * dz > radiusSq) continue;
			const target = mesh.surfaceprop !== undefined ? phyPos : visPos;

			for (const [a, b, c] of mesh.indices) {
				if (triCount * 3 >= MAX_TRI_LINES) break;
				const va = mesh.vertices[a];
				const vb = mesh.vertices[b];
				const vc = mesh.vertices[c];
				// 三角形 AABB 距离粗筛
				const tMinX = Math.min(va[0], vb[0], vc[0]);
				const tMaxX = Math.max(va[0], vb[0], vc[0]);
				const tMinZ = Math.min(va[2], vb[2], vc[2]);
				const tMaxZ = Math.max(va[2], vb[2], vc[2]);
				const cxp = Math.max(tMinX, Math.min(pos.x, tMaxX));
				const czp = Math.max(tMinZ, Math.min(pos.z, tMaxZ));
				const dxp = pos.x - cxp;
				const dzp = pos.z - czp;
				if (dxp * dxp + dzp * dzp > radiusSq) continue;
				target.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
				target.push(vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
				target.push(vc[0], vc[1], vc[2], va[0], va[1], va[2]);
				triCount++;
			}
		}

		if (triCount === 0) return;
		this.addTriLines(visPos, 0x44c8ff); // 青色：可视网格
		this.addTriLines(phyPos, 0xffb347); // 黄色：模型自带 .phy 碰撞
	}

	/** 追加一组三角形线框（positions 为 3 顶点 × 3 条边 × 3 分量）。 */
	private addTriLines(positions: number[], color: number): void {
		if (positions.length === 0) return;
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		const mat = new THREE.LineBasicMaterial({
			color,
			transparent: true,
			opacity: 0.7,
			depthTest: true,
		});
		this.triGroup!.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 重建触发碰撞箱线框（显示全部 trigger，凸包线框或 AABB 回退，不限距离）。
	 */
	private rebuildTriggers(): void {
		this.clearGroup(this.triggerGroup!);
		if (this.triggers.length === 0) return;

		const positions: number[] = [];
		const colors: number[] = [];

		for (const trigger of this.triggers) {
			if (!trigger.mins || !trigger.maxs) continue;

			let color: RgbColor;
			if (trigger.startDisabled) {
				color = COLOR_TRIGGER_DISABLED;
			} else {
				const sf = trigger.spawnflags;
				if ((sf & SPAWNFLAG_CLIENTS) === 0 && (sf & SPAWNFLAG_EVERYTHING) === 0) {
					color = COLOR_TRIGGER_NON_PLAYER;
				} else if (trigger.destIndex < 0) {
					color = COLOR_TRIGGER_ORPHAN;
				} else {
					color = COLOR_TRIGGER_LINKED;
				}
			}
			// 有凸包平面：画真实几何线框（楔形/斜面 trigger 可见形状）；否则回退 AABB
			if (trigger.planes && trigger.planes.length >= 4) {
				const brushLike: Brush = {
					planes: trigger.planes as PlaneLike[],
					min: trigger.mins,
					max: trigger.maxs,
				};
				const hull = computeBrushHull(brushLike);
				if (hull.length >= 4) {
					pushBrushWireframe(positions, colors, brushLike, hull, color);
				} else {
					pushAabbEdges(positions, colors, trigger.mins, trigger.maxs, color);
				}
			} else {
				pushAabbEdges(positions, colors, trigger.mins, trigger.maxs, color);
			}
		}

		if (positions.length === 0) return;

		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
		const mat = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.8,
			depthTest: false, // 不被遮挡，始终可见
		});
		this.triggerGroup!.add(new THREE.LineSegments(geom, mat));
	}

	/** 清除指定 group 的所有子对象。 */
	private clearGroup(group: THREE.Group): void {
		for (let i = group.children.length - 1; i >= 0; i--) {
			const child = group.children[i];
			group.remove(child);
			const obj = child as THREE.Mesh | THREE.LineSegments;
			if (obj.geometry) obj.geometry.dispose();
			if (obj.material) {
				const mat = obj.material as THREE.Material | THREE.Material[];
				if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
				else mat.dispose();
			}
		}
	}

	/** 释放资源。 */
	dispose(): void {
		if (this.solidGroup) this.clearGroup(this.solidGroup);
		if (this.triggerGroup) this.clearGroup(this.triggerGroup);
		if (this.scene) {
			if (this.solidGroup) this.scene.remove(this.solidGroup);
			if (this.triggerGroup) this.scene.remove(this.triggerGroup);
		}
		this.scene = null;
		this.solidGroup = null;
		this.triggerGroup = null;
	}
}
