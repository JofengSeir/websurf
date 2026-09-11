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

/** Y 方向上下扩展（HU）。 */
const DEBUG_Y_EXTENT = 300;
/** 最多显示的碰撞体数量。 */
const MAX_DEBUG_COLLIDERS = 800;
/** 重建限流（每 N 帧）。 */
const REBUILD_INTERVAL = 6;
/** 可视网格三角形线框重建限流（每 N 帧；三角形量大，重建更慢）。 */
const TRI_REBUILD_INTERVAL = 30;
/** 可视网格（紫色）附近三角形上限（超限截断，避免拖垮每帧重建）。 */
const MAX_TRI_LINES = 12_000;
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
 * 同时返回每面的单位法线（背面/侧面/斜面分类用），使绘制可按面独立着色。
 */
interface OrderedFace {
	/** 构成该凸多边形面的顶点索引（按绕法线极角排序）。 */
	face: number[];
	/** 该面的单位法线（复用 brush plane 法线，朝外）。 */
	normal: { x: number; y: number; z: number };
}

function orderedFaces(
	brush: Brush,
	verts: [number, number, number][],
): OrderedFace[] {
	const faces: OrderedFace[] = [];
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
		faces.push({ face: angled.map((a) => a.vi), normal: { x: n.x, y: n.y, z: n.z } });
	}
	return faces;
}

/**
 * 按单面法线分类颜色（Y-up）：
 *
 * - n.y > cos(groundAngle) → 近乎水平朝上 → 地面（绿）
 * - n.y > cos(slideAngle)  → 斜面/缓坡 → 斜坡（黄）
 * - else                   → 垂直墙 / 朝下底面 / 陡面 → 墙（红）
 *
 * 注意：这里 **只** 看该面自身法线，与 `classifyBrush` 的"整 brush 最大法线 y"
 * 不同——`classifyBrush` 会让"含水平面的斜面 brush"被误判成地面（绿），
 * 使所有 bevel（斜面）都看不见黄色。逐面分类后，斜面面单独显示为黄色。
 */
function classifyNormal(
	normal: { x: number; y: number; z: number },
	groundAngleCos: number,
	slideAngleCos: number,
): RgbColor {
	const ny = normal.y;
	if (ny > groundAngleCos) return COLOR_GROUND;
	if (ny > slideAngleCos) return COLOR_SLOPE;
	return COLOR_WALL;
}

// ---------------------------------------------------------------------------
// chamfer（切角）平面可视化（黄色）
// ---------------------------------------------------------------------------
// 远端在 WASM 导出层（debug/crates/wasm/src/lib.rs 的 AddEdgeBevels 简化版）为每个
// brush 的凸棱运行时生成一张"外切角"平面（n = normalize(n_i + n_j)，凸包外侧校验），
// 已合并进 brush.planes 一并输出：既进物理碰撞，也进 debug 线框。本模块把这类
// "只过棱、不构成面"的平面单独标黄，供排查坡顶/尖角幻影碰撞。
// 分类判据：平面上落在凸包上的顶点 <3 或全部共线（= 只含一条棱，不是真实面）
// → 该平面即 chamfer；与 orderedFaces 的 `face.length < 3` 跳过逻辑同源。
// 绘制：平铺在平面内、沿"平面内 ⊥ 棱 ∧ 背离 brush 质心"方向外推 CHAMFER_QUAD_LEN，
// —— 角平分线 chamfer 呈现为贴坡倒角、水平过棱呈现为贴面帽盖，而非竖起的挡墙。
// 黄色且 depthTest:false 恒可见（chamfer 常嵌在几何内/背面）。

/** chamfer 切角平面线段（棱两端点 + 朝外法线）。 */
interface ChamferStrip {
	a: [number, number, number];
	b: [number, number, number];
	n: [number, number, number];
}

/** chamfer 四边形沿平面内方向外推长度（HU，≈ hull 半宽，示意扩张尺度）。 */
const CHAMFER_QUAD_LEN = 16;
/** 共线判定容差（HU；顶点到棱线的垂直距离小于此值视为共线 → 该平面是 chamfer）。 */
const CHAMFER_COLLINEAR_EPS = 0.5;

/** 两点向量差。 */
function chVecSub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** 两点距离。 */
function chVecDist(a: [number, number, number], b: [number, number, number]): number {
	const d = chVecSub(a, b);
	return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
}

/**
 * 提取 brush 的全部 chamfer（切角）平面线段。
 * 判据：平面上落在凸包上的顶点 <3 或全部共线 → 只过棱、不构成面 → chamfer。
 */
function computeChamferStrips(brush: Brush): ChamferStrip[] {
	const verts = computeBrushHull(brush);
	if (verts.length < 4) return [];
	const strips: ChamferStrip[] = [];
	for (const p of brush.planes) {
		// 落在平面上的顶点
		const on: number[] = [];
		for (let vi = 0; vi < verts.length; vi++) {
			const v = verts[vi];
			const d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
			if (Math.abs(d) < FACE_EPS) on.push(vi);
		}
		if (on.length < 2) continue;
		// 取相距最远的两点作棱线段
		let ai = on[0], bi = on[1], best = -1;
		for (let x = 0; x < on.length; x++) {
			for (let y = x + 1; y < on.length; y++) {
				const d = chVecDist(verts[on[x]], verts[on[y]]);
				if (d > best) { best = d; ai = on[x]; bi = on[y]; }
			}
		}
		const a = verts[ai], b = verts[bi];
		if (chVecDist(a, b) < 0.01) continue;
		// 共线判定：其余面上顶点到棱线的垂直距离
		let collinear = true;
		const ab = chVecSub(b, a);
		const abLen = Math.sqrt(ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
		for (const vi of on) {
			if (vi === ai || vi === bi) continue;
			const ap = chVecSub(verts[vi], a);
			const cp = [
				ab[1] * ap[2] - ab[2] * ap[1],
				ab[2] * ap[0] - ab[0] * ap[2],
				ab[0] * ap[1] - ab[1] * ap[0],
			];
			if (Math.sqrt(cp[0] * cp[0] + cp[1] * cp[1] + cp[2] * cp[2]) / abLen > CHAMFER_COLLINEAR_EPS) {
				collinear = false;
				break;
			}
		}
		if (!collinear) continue; // 真实面（≥3 非共线顶点）
		strips.push({
			a: [a[0], a[1], a[2]],
			b: [b[0], b[1], b[2]],
			n: [p.normal.x, p.normal.y, p.normal.z],
		});
	}
	return strips;
}

/**
 * 把 brush 凸包画成线框：对每个面，闭合多边形连边（真实碰撞几何边）。
 * 每面按其法线调用 `classify` 独立着色（支持 bevel 斜面显示为斜坡色）。
 */
function pushBrushWireframe(
	positions: number[],
	colors: number[],
	brush: Brush,
	verts: [number, number, number][],
	classify: (normal: { x: number; y: number; z: number }) => RgbColor,
): void {
	const faces = orderedFaces(brush, verts);
	for (const { face, normal } of faces) {
		const color = classify(normal);
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
 * 每面按其法线调用 `classify` 独立着色（与描边颜色逐面一致）。
 */
function pushBrushFill(
	positions: number[],
	colors: number[],
	brush: Brush,
	verts: [number, number, number][],
	classify: (normal: { x: number; y: number; z: number }) => RgbColor,
): void {
	const faces = orderedFaces(brush, verts);
	for (const { face, normal } of faces) {
		if (face.length < 3) continue;
		const color = classify(normal);
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
	/** 模型 .phy 碰撞网格线框组（橙色，受 showPhy 控制）。 */
	private phyGroup: THREE.Group | null = null;
	/** 模型可视网格线框组（紫色，受 showVis 控制）。 */
	private visGroup: THREE.Group | null = null;
	/** chamfer 切角平面线框组（黄色，受 showChamfers 控制）。 */
	private chamferGroup: THREE.Group | null = null;
	/** 触发碰撞箱线框组（受 showTriggers 控制）。 */
	private triggerGroup: THREE.Group | null = null;
	private showSolids = false;
	/** brush 线框显示可视距离（HU；0 = 全量）。 */
	private brushViewDistance = 512;
	private showTriggers = false;
	/** 触发区域线框显示可视距离（HU；0 = 全量）。 */
	private triggerViewDistance = 0;
	/** .phy 碰撞网格独立开关（橙色）。 */
	private showPhy = false;
	/** 可视网格独立开关（紫色）。 */
	private showVis = false;
	/** chamfer 切角平面独立开关（黄色）。 */
	private showChamfers = false;
	/** .phy 碰撞网格显示可视距离（HU；0 = 全量）。 */
	private phyViewDistance = 2048;
	/** 可视网格显示可视距离（HU）。 */
	private visViewDistance = 512;
	/** chamfer 切角平面显示可视距离（HU；0 = 全量）。 */
	private chamferViewDistance = 512;
	/** .phy 距离/开关变更待重建标记（立即生效不等限流）。 */
	private phyDirty = false;
	private frameCounter = 0;
	/** chamfer 切角平面线框重建限流计数（与 solid 同周期）。 */
	private chamferFrameCounter = 0;
	/** chamfer 线段缓存（凸包重建昂贵，仅首次计算；brush 引用稳定，地图重载清空）。 */
	private chamferCache = new WeakMap<Brush, ChamferStrip[]>();
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

		this.phyGroup = new THREE.Group();
		this.phyGroup.name = '__model_phy_collider_debug__';
		this.phyGroup.visible = false;
		scene.add(this.phyGroup);

		this.visGroup = new THREE.Group();
		this.visGroup.name = '__model_vis_collider_debug__';
		this.visGroup.visible = false;
		scene.add(this.visGroup);

		this.chamferGroup = new THREE.Group();
		this.chamferGroup.name = '__vbsp_chamfer_debug__';
		this.chamferGroup.visible = false;
		scene.add(this.chamferGroup);

		this.triggerGroup = new THREE.Group();
		this.triggerGroup.name = '__vbsp_trigger_debug__';
		this.triggerGroup.visible = false;
		scene.add(this.triggerGroup);
	}

	/** 注入模型三角形碰撞网格（场景加载后调用）；标记 phyDirty 等下次 update 重建。 */
	setTriMeshes(meshes: TriMesh[]): void {
		this.triMeshes = meshes;
		this.phyDirty = true;
		this.triFrameCounter = TRI_REBUILD_INTERVAL;
	}

	/** 注入传送触发器列表（场景加载后调用）。 */
	setTriggers(triggers: readonly TeleportTrigger[]): void {
		this.triggers = triggers;
		// 触发下一帧立即重建
		this.frameCounter = REBUILD_INTERVAL;
	}

	/** 设置显示标志（showSolids / showTriggers / 各自可视距离；triGroup 由 setTriDebugFlags 独立管理）。 */
	setDebugFlags(
		showSolids: boolean,
		showTriggers: boolean,
		triggerViewDistance?: number,
		brushViewDistance?: number,
	): void {
		this.showSolids = showSolids;
		this.showTriggers = showTriggers;
		if (triggerViewDistance !== undefined) {
			this.triggerViewDistance = triggerViewDistance;
		}
		if (brushViewDistance !== undefined) {
			this.brushViewDistance = brushViewDistance;
		}
		if (this.solidGroup) {
			this.solidGroup.visible = showSolids;
			if (!showSolids) this.clearGroup(this.solidGroup);
		}
		if (this.triggerGroup) {
			this.triggerGroup.visible = showTriggers;
			if (!showTriggers) this.clearGroup(this.triggerGroup);
		}
		this.frameCounter = REBUILD_INTERVAL;
	}

	/**
	 * 设置模型三角形线框独立开关与可视距离（.phy 橙 / 可视网格紫）。
	 * 距离或开关变更立即重建（phyDirty），不等限流。
	 */
	setTriDebugFlags(
		showPhy: boolean,
		showVis: boolean,
		phyViewDistance: number,
		visViewDistance: number,
	): void {
		if (
			this.showPhy !== showPhy ||
			this.showVis !== showVis ||
			this.phyViewDistance !== phyViewDistance ||
			this.visViewDistance !== visViewDistance
		) {
			this.phyDirty = true;
		}
		this.showPhy = showPhy;
		this.showVis = showVis;
		this.phyViewDistance = phyViewDistance;
		this.visViewDistance = visViewDistance;
		if (this.phyGroup) {
			this.phyGroup.visible = showPhy;
			if (!showPhy) this.clearGroup(this.phyGroup);
		}
		if (this.visGroup) {
			this.visGroup.visible = showVis;
			if (!showVis) this.clearGroup(this.visGroup);
		}
		this.triFrameCounter = TRI_REBUILD_INTERVAL;
	}

	/**
	 * 设置 chamfer 切角平面线框独立开关与可视距离（黄色；导出层运行时生成并已并入
	 * brush 平面，此处仅分类显示）。开关/距离变更立即生效（限流周期内照常重建）。
	 */
	setChamferDebugFlags(showChamfers: boolean, chamferViewDistance: number): void {
		this.showChamfers = showChamfers;
		this.chamferViewDistance = chamferViewDistance;
		if (this.chamferGroup) {
			this.chamferGroup.visible = showChamfers;
			if (!showChamfers) this.clearGroup(this.chamferGroup);
		}
		this.chamferFrameCounter = REBUILD_INTERVAL;
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

		// 1.5 模型三角形线框（.phy 橙 / 可视网格紫，独立开关 + 各自可视距离；
		//     共用限流——重建成本高；距离/开关变更时 phyDirty 立即重建）
		if ((this.showPhy || this.showVis) && (this.phyGroup || this.visGroup)) {
			this.triFrameCounter++;
			if (this.phyDirty || this.triFrameCounter >= TRI_REBUILD_INTERVAL) {
				this.triFrameCounter = 0;
				this.phyDirty = false;
				if (this.showPhy && this.phyGroup) this.rebuildPhyTriangles(cameraPos);
				if (this.showVis && this.visGroup) this.rebuildVisTriangles(cameraPos);
				rebuilt = true;
			}
		}

		// 1.6 chamfer 切角平面线框（黄色；独立开关 + 可视距离，与 solid 同限流周期；
		//     线段已缓存，重建只做距离筛选，成本低）
		if (this.showChamfers && this.chamferGroup) {
			this.chamferFrameCounter++;
			if (this.chamferFrameCounter >= REBUILD_INTERVAL) {
				this.chamferFrameCounter = 0;
				this.rebuildChamfers(cameraPos, colliders, config);
				rebuilt = true;
			}
		}

		// 2. 触发碰撞箱（受 showTriggers 控制，数量少直接每帧重建）
		if (this.showTriggers && this.triggerGroup) {
			this.rebuildTriggers(cameraPos);
			rebuilt = true;
		}

		return rebuilt;
	}

	/** 当前是否有调试显示工作（render-loop 据此决定是否调用 update）。 */
	get hasDebugWork(): boolean {
		return this.showSolids || this.showTriggers || this.showPhy || this.showVis || this.showChamfers;
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
		const full = this.brushViewDistance <= 0;
		const radiusSq = this.brushViewDistance * this.brushViewDistance;

		// 过滤附近 brush（XZ 距离 < radius，Y 在范围内；0 = 全量）
		const nearby: { brush: Brush; distSq: number }[] = [];
		for (const brush of colliders) {
			if (!full) {
				const nx = Math.max(brush.min.x, Math.min(pos.x, brush.max.x));
				const nz = Math.max(brush.min.z, Math.min(pos.z, brush.max.z));
				const dx = pos.x - nx;
				const dz = pos.z - nz;
				const distSq = dx * dx + dz * dz;
				if (distSq > radiusSq) continue;
			}
			if (brush.max.y < minY || brush.min.y > maxY) continue;
			nearby.push({ brush, distSq: 0 });
		}

		if (nearby.length === 0) return;

		if (nearby.length > MAX_DEBUG_COLLIDERS) {
			nearby.sort((a, b) => a.distSq - b.distSq);
			nearby.length = MAX_DEBUG_COLLIDERS;
		}

		const groundAngleCos = Math.cos(config.physics.groundAngle);
		const slideAngleCos = Math.cos(config.physics.slideAngle);
		// 逐面分类：每个面按其自身法线着色（斜面 bevel 显示为黄色斜坡，
		// 而非被同 brush 的水平面拖成全绿——修复原 classifyBrush 的 maxNy 误判）
		const classify = (normal: { x: number; y: number; z: number }) =>
			classifyNormal(normal, groundAngleCos, slideAngleCos);

		const positions: number[] = [];
		const colors: number[] = [];
		const fillPositions: number[] = [];
		const fillColors: number[] = [];

		for (const { brush } of nearby) {
			// 退化（顶点 < 4）回退 AABB：用整 brush 主朝向（最朝上法线）定单色
			// planes → 凸包线框（斜坡/斜面显示真实形状）；退化（顶点 < 4）回退 AABB
			const hull = computeBrushHull(brush);
			if (hull.length >= 4) {
				pushBrushWireframe(positions, colors, brush, hull, classify);
				// 仅相机进入 brush 内部时显示半透明填充（提示"身处固体内部"）
				if (isPointInsideBrush(pos, brush)) {
					pushBrushFill(fillPositions, fillColors, brush, hull, classify);
				}
			} else {
				const dominant = { x: 0, y: -2, z: 0 };
				for (const plane of brush.planes) {
					if (plane.normal.y > dominant.y) dominant.y = plane.normal.y;
				}
				const color = classify(dominant);
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
	 * 重建 **.phy** 碰撞网格线框（橙色，全部 .phy 三角形，无上限截断）。
	 * 按 phyViewDistance 距离筛选（0 = 全量）；受 tri 共用限流，距离/开关变更
	 * 由 phyDirty 立即触发。
	 */
	private rebuildPhyTriangles(cameraPos: THREE.Vector3): void {
		const group = this.phyGroup!;
		this.clearGroup(group);
		if (this.triMeshes.length === 0) return;

		const pos = cameraPos;
		const full = this.phyViewDistance <= 0;
		const radiusSq = this.phyViewDistance * this.phyViewDistance;

		const phyPos: number[] = [];
		for (const mesh of this.triMeshes) {
			if (mesh.surfaceprop === undefined) continue; // 仅 .phy 来源
			if (!full) {
				// mesh AABB 距离粗筛（Y-up 水平面 = x/z）
				const nx = Math.max(mesh.min[0], Math.min(pos.x, mesh.max[0]));
				const nz = Math.max(mesh.min[2], Math.min(pos.z, mesh.max[2]));
				const dx = pos.x - nx;
				const dz = pos.z - nz;
				if (dx * dx + dz * dz > radiusSq) continue;
			}
			for (const [a, b, c] of mesh.indices) {
				const va = mesh.vertices[a];
				const vb = mesh.vertices[b];
				const vc = mesh.vertices[c];
				phyPos.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
				phyPos.push(vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
				phyPos.push(vc[0], vc[1], vc[2], va[0], va[1], va[2]);
			}
		}
		console.log(
			`[collider-debug] phy 重建: 距离=${this.phyViewDistance} 三角形=${phyPos.length / 18}`,
		);

		this.addTriLines(phyPos, 0xff8c00, group); // 橙色：模型自带 .phy 碰撞
	}

	/**
	 * 重建**可视网格**三角形线框（紫色，按 visViewDistance 距离筛选 + 数量上限）。
	 * 独立 Group，不影响 .phy 线框。
	 */
	private rebuildVisTriangles(cameraPos: THREE.Vector3): void {
		const group = this.visGroup!;
		this.clearGroup(group);
		if (this.triMeshes.length === 0) return;

		const pos = cameraPos;
		const radiusSq = this.visViewDistance * this.visViewDistance;

		const visPos: number[] = []; // 可视网格（紫）
		let triCount = 0;

		for (const mesh of this.triMeshes) {
			if (mesh.surfaceprop !== undefined) continue; // 跳过 .phy（phy Group 已画）
			if (triCount * 3 >= MAX_TRI_LINES) break;
			// mesh AABB 距离粗筛（顶点/边界为紧凑数组 `[x,y,z]`；Y-up 水平面 = x/z）
			const nx = Math.max(mesh.min[0], Math.min(pos.x, mesh.max[0]));
			const nz = Math.max(mesh.min[2], Math.min(pos.z, mesh.max[2]));
			const dx = pos.x - nx;
			const dz = pos.z - nz;
			if (dx * dx + dz * dz > radiusSq) continue;

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
				visPos.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
				visPos.push(vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
				visPos.push(vc[0], vc[1], vc[2], va[0], va[1], va[2]);
				triCount++;
			}
		}

		if (visPos.length === 0) return;
		console.log(
			`[collider-debug] vis 重建: 距离=${this.visViewDistance} 三角形=${visPos.length / 18}`,
		);
		this.addTriLines(visPos, 0xaa66ff, group); // 紫色：可视模型网格
	}

	/**
	 * 重建 chamfer 切角平面线框（黄色）。距离筛选同实体碰撞箱（XZ 半径 + Y 窗口）；
	 * 线段缓存在 WeakMap，凸包分类仅首次执行，重建只做筛选与装配。
	 * 四边形平铺在平面内、沿"平面内 ⊥ 棱 ∧ 背离 brush 质心"外推：角平分线 chamfer
	 * 呈现为贴坡倒角、水平过棱呈现为贴面帽盖（坡面切线感），而非竖起的挡墙。
	 * depthTest:false —— 贴在几何内/后被遮挡也能看到（排查需要）。
	 */
	private rebuildChamfers(
		cameraPos: THREE.Vector3,
		colliders: Brush[],
		config: RuntimeConfig,
	): void {
		const group = this.chamferGroup!;
		this.clearGroup(group);
		if (colliders.length === 0) return;

		const pos = cameraPos;
		const playerHeight = config.player.standHeight;
		const feetY = pos.y - playerHeight + config.player.eyeOffset;
		const minY = feetY - DEBUG_Y_EXTENT;
		const maxY = feetY + playerHeight + DEBUG_Y_EXTENT;
		const full = this.chamferViewDistance <= 0;
		const radiusSq = this.chamferViewDistance * this.chamferViewDistance;

		const positions: number[] = [];
		let drawn = 0;
		for (const brush of colliders) {
			if (brush.max.y < minY || brush.min.y > maxY) continue;
			if (!full) {
				const nx = Math.max(brush.min.x, Math.min(pos.x, brush.max.x));
				const nz = Math.max(brush.min.z, Math.min(pos.z, brush.max.z));
				const dx = pos.x - nx;
				const dz = pos.z - nz;
				if (dx * dx + dz * dz > radiusSq) continue;
			}
			let strips = this.chamferCache.get(brush);
			if (!strips) {
				strips = computeChamferStrips(brush);
				this.chamferCache.set(brush, strips);
			}
			for (const s of strips) {
				// 四边形：平铺在 chamfer 平面内，沿"平面内 ⊥ 棱 ∧ 背离 brush 质心"外推
				const ex = s.b[0] - s.a[0];
				const ey = s.b[1] - s.a[1];
				const ez = s.b[2] - s.a[2];
				// 法线 ⊥ 棱 → cross(n, e) 落在平面内且 ⊥ 棱
				let dx = s.n[1] * ez - s.n[2] * ey;
				let dy = s.n[2] * ex - s.n[0] * ez;
				let dz = s.n[0] * ey - s.n[1] * ex;
				const dLen = Math.hypot(dx, dy, dz);
				if (dLen < 1e-6) continue;
				dx /= dLen; dy /= dLen; dz /= dLen;
				// 符号：指向"背离 brush 质心"的一侧（幻影区 / 坡面切线方向）
				const mdx = (s.a[0] + s.b[0]) / 2 - (brush.min.x + brush.max.x) / 2;
				const mdy = (s.a[1] + s.b[1]) / 2 - (brush.min.y + brush.max.y) / 2;
				const mdz = (s.a[2] + s.b[2]) / 2 - (brush.min.z + brush.max.z) / 2;
				if (dx * mdx + dy * mdy + dz * mdz < 0) {
					dx = -dx; dy = -dy; dz = -dz;
				}
				const a2: [number, number, number] = [
					s.a[0] + dx * CHAMFER_QUAD_LEN,
					s.a[1] + dy * CHAMFER_QUAD_LEN,
					s.a[2] + dz * CHAMFER_QUAD_LEN,
				];
				const b2: [number, number, number] = [
					s.b[0] + dx * CHAMFER_QUAD_LEN,
					s.b[1] + dy * CHAMFER_QUAD_LEN,
					s.b[2] + dz * CHAMFER_QUAD_LEN,
				];
				positions.push(
					s.a[0], s.a[1], s.a[2], s.b[0], s.b[1], s.b[2],
					s.a[0], s.a[1], s.a[2], a2[0], a2[1], a2[2],
					s.b[0], s.b[1], s.b[2], b2[0], b2[1], b2[2],
					a2[0], a2[1], a2[2], b2[0], b2[1], b2[2],
				);
				drawn++;
			}
		}
		console.log(`[collider-debug] chamfer 重建: 距离=${this.chamferViewDistance} 平面=${drawn}`);

		if (positions.length === 0) return;
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		const mat = new THREE.LineBasicMaterial({
			color: 0xfffb14,
			depthTest: false, // 不被遮挡，始终可见（chamfer 常在几何内/背面）
		});
		group.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 追加一组三角形线框（positions 为 3 顶点 × 3 条边 × 3 分量）。
	 * 不透明材质：opaque 阶段恒在透明 brush 线框之后渲染，橙色不被混合染色。
	 */
	private addTriLines(positions: number[], color: number, group: THREE.Group): void {
		if (positions.length === 0) return;
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		const mat = new THREE.LineBasicMaterial({
			color,
			depthTest: false, // 不被 brush 线框/几何遮挡，始终可见
		});
		group.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 重建触发碰撞箱线框（凸包线框或 AABB 回退；按 triggerViewDistance 距离筛选，0 = 全量）。
	 */
	private rebuildTriggers(cameraPos: THREE.Vector3): void {
		this.clearGroup(this.triggerGroup!);
		if (this.triggers.length === 0) return;

		const pos = cameraPos;
		const full = this.triggerViewDistance <= 0;
		const radiusSq = this.triggerViewDistance * this.triggerViewDistance;

		const positions: number[] = [];
		const colors: number[] = [];

		for (const trigger of this.triggers) {
			if (!trigger.mins || !trigger.maxs) continue;
			if (!full) {
				// AABB 距离粗筛（Y-up 水平面 = x/z）
				const nx = Math.max(trigger.mins.x, Math.min(pos.x, trigger.maxs.x));
				const nz = Math.max(trigger.mins.z, Math.min(pos.z, trigger.maxs.z));
				const dx = pos.x - nx;
				const dz = pos.z - nz;
				if (dx * dx + dz * dz > radiusSq) continue;
			}

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
					// trigger 用触发类型定单色，不按面分类
					pushBrushWireframe(positions, colors, brushLike, hull, () => color);
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

	/**
	 * 清空全部调试组内容（加载新地图时调用；保留 group 与 scene 引用，
	 * 不清内部状态，避免破坏后续 rebuild）。
	 */
	clearAll(): void {
		if (this.solidGroup) this.clearGroup(this.solidGroup);
		if (this.phyGroup) this.clearGroup(this.phyGroup);
		if (this.visGroup) this.clearGroup(this.visGroup);
		if (this.chamferGroup) this.clearGroup(this.chamferGroup);
		if (this.triggerGroup) this.clearGroup(this.triggerGroup);
		// brush 引用已随地图刷新 → chamfer 缓存随之失效（WeakMap 自动回收）
		this.chamferCache = new WeakMap();
	}

	/** 释放资源。 */
	dispose(): void {
		this.clearAll();
		if (this.scene) {
			if (this.solidGroup) this.scene.remove(this.solidGroup);
			if (this.phyGroup) this.scene.remove(this.phyGroup);
			if (this.visGroup) this.scene.remove(this.visGroup);
			if (this.chamferGroup) this.scene.remove(this.chamferGroup);
			if (this.triggerGroup) this.scene.remove(this.triggerGroup);
		}
		this.scene = null;
		this.solidGroup = null;
		this.phyGroup = null;
		this.visGroup = null;
		this.chamferGroup = null;
		this.triggerGroup = null;
	}
}
