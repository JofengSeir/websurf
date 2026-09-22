/**
 * WebSurf — 碰撞体可视化（debug 工程专用）。
 *
 * 由 `apps/debug/src/renderer/renderer-main.ts` 持有，把三路上游数据画成叠加线框：
 * - 实体碰撞体：`apps/debug/src/world/collider-adapter.ts` 的 `adaptBrushes` 输出（源自 WASM
 *   `apps/debug/crates/wasm/src/lib.rs` 的 `export_brushes_planes`；平面已转为 cs-movement 的
 *   "法线朝外"约定，内部满足 dot(n,p)-dist <= 0）；
 * - 传送触发器：`apps/debug/src/world/teleport-manager.ts` 的 `TeleportManager.getTriggers`；
 * - 模型三角形网格：`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 产出的 triJson，
 *   本模块按 `TriMesh.surfaceprop`（`apps/debug/src/physics/physics/Collision/Collision.types.ts`）
 *   是否存在拆成 .phy 与可视网格两条路径。
 *
 * 五个 Group 与五个开关彼此独立，各有自己的可视距离：
 * - `showSolids`  实体碰撞体凸包线框，逐面按法线着色（地面绿 / 斜坡黄 / 墙红）；
 * - `showTriggers` 触发器凸包或 AABB 线框（青=已链接 / 紫=孤儿 / 灰=初始禁用 / 橙=非玩家）；
 * - `showPhy` / `showVis` 模型三角形线框（橙 / 紫）；
 * - `showChamfers` brush 平面里"只过棱、不构成面"的 chamfer 切角平面（黄）。
 *
 * 不变量与边界：
 * - 只创建 `THREE.Group` 与线/面对象，不创建相机与灯光，不改动 scene 的其它成员；
 * - `init` 之前或 `dispose` 之后 `scene` 为 null，`update` 一律返回 false 且不做任何事；
 * - 对外方法不主动抛错，集合为空或缺字段时静默跳过，最多少画一些线框；
 * - 凸包重建 `computeBrushHull` 与 WASM 侧 `export_brushes_planes` 内嵌的 `compute_vertices`
 *   结构相同（三平面组合求交 + 全平面同侧校验 + 0.1 HU 去重），容差各自取常量；顶点数 < 4
 *   时本模块回退 AABB 线框，WASM 侧另有翻转法线重算的分支。
 */

import * as THREE from 'three';
import type { Brush, TriMesh } from '../physics/physics/Collision/Collision.types.js';
import type { RuntimeConfig } from '../config.js';
import type { TeleportTrigger } from '../world/teleport-manager.js';

/** Y 向视野窗口的上下扩展量（HU）：脚底以下与本人体高以上各留这么多。 */
const DEBUG_Y_EXTENT = 300;
/** 实体碰撞箱单帧最多装配的 brush 数（超出按收集顺序截断）。 */
const MAX_DEBUG_COLLIDERS = 800;
/** 实体碰撞箱与 chamfer 的重建限流周期（帧）：计数累加到该值才重建一次。 */
const REBUILD_INTERVAL = 6;
/** 模型三角形线框（.phy / 可视网格）共用的重建限流周期（帧），比 brush 更长。 */
const TRI_REBUILD_INTERVAL = 30;
/** 可视网格线框的线段数上限（每个三角形 3 条边，达到即停止收集）。 */
const MAX_TRI_LINES = 12_000;
/** 实体碰撞箱半透明填充的不透明度（0-1）。只在相机落入某个 brush 内部时生成。 */
const FILL_OPACITY = 0.09;

/** 顶点色（RGB，0..1），写入 Float32BufferAttribute 的 color 属性。 */
interface RgbColor {
	r: number;
	g: number;
	b: number;
}

const COLOR_GROUND: RgbColor = { r: 0.1, g: 1.0, b: 0.1 };
const COLOR_SLOPE: RgbColor = { r: 1.0, g: 0.9, b: 0.1 };
const COLOR_WALL: RgbColor = { r: 1.0, g: 0.2, b: 0.1 };
/** 触发碰撞箱：未禁用 + 对玩家生效 + destIndex >= 0（青）。 */
const COLOR_TRIGGER_LINKED: RgbColor = { r: 0.2, g: 0.8, b: 0.9 };
/** 触发碰撞箱：未禁用 + 对玩家生效 + destIndex < 0（紫）。 */
const COLOR_TRIGGER_ORPHAN: RgbColor = { r: 0.6, g: 0.2, b: 0.9 };
/** 触发碰撞箱：startDisabled 为真（灰）；判在其余三色之前，优先级最高。 */
const COLOR_TRIGGER_DISABLED: RgbColor = { r: 0.5, g: 0.5, b: 0.5 };
/** 触发碰撞箱：未禁用但 spawnflags 既无 Clients 也无 Everything（橙）。 */
const COLOR_TRIGGER_NON_PLAYER: RgbColor = { r: 1.0, g: 0.6, b: 0.2 };

/** spawnflags 位：1 = Clients、64 = Everything（与 TeleportManager 的两条判据同值）。 */
const SPAWNFLAG_CLIENTS = 0x01;
const SPAWNFLAG_EVERYTHING = 0x40;

// ---------------------------------------------------------------------------
// 凸包重建：从 brush 平面列表还原真实碰撞几何（线框与填充共用）
// ---------------------------------------------------------------------------

/** 三平面交点"落在凸包内侧"的校验容差（HU；WASM 侧同判据取 1.0）。 */
const HULL_EPS = 0.5;
/** 顶点"落在某平面上"的判定容差（HU）：面内顶点收集与 chamfer 判定共用。 */
const FACE_EPS = 0.5;
/** 顶点去重阈值（HU²）：间距小于 0.1 HU 视为同一顶点。 */
const VERT_DUP_SQ = 0.01;

/** 凸包判定只用到法线与距离两个字段，故 `Brush.planes` 与 `TeleportTrigger.planes` 可以共用同一套算法。 */
interface PlaneLike {
	normal: { x: number; y: number; z: number };
	dist: number;
}

/** 三平面求交（克莱默法则）；行列式绝对值 < 1e-6（近共面或平行）时返回 null。 */
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
 * 从 brush 平面重建凸包顶点：枚举全部三平面组合求交，保留对所有平面都满足
 * dot(n,p)-dist <= `HULL_EPS` 的交点，再按 `VERT_DUP_SQ` 去重（线性扫描，未用空间哈希）。
 * `planes` 少于 4 个直接返回空数组；返回空数组或顶点数 < 4 表示退化，调用方据此回退 AABB。
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
				// 去重：与已收顶点逐个比距离（brush 顶点数少，O(m²) 足够）
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
 * 一个面的凸多边形：顶点下标序列 + 该面法线。法线原样复用 brush plane 的法线，不重新归一化
 * （朝向由上游 `export_brushes_planes` 保证朝外）。
 */
interface OrderedFace {
	/** 构成该面的顶点下标（按绕法线的极角升序）。 */
	face: number[];
	/** 该面的平面法线（朝外，直接取自 brush plane）。 */
	normal: { x: number; y: number; z: number };
}

/**
 * 对 brush 的每个平面，收集落在该平面上的顶点下标（|d| < `FACE_EPS`），按绕法线的极角排序成
 * 凸多边形，并带上该平面法线。落在平面上的顶点少于 3 个、或面内正交基退化（|u| < 1e-6）时
 * 跳过该平面。只看顶点数与极角，不判多边形面积，故共线的三点以上也会形成一个退化多边形。
 */
function orderedFaces(
	brush: Brush,
	verts: [number, number, number][],
): OrderedFace[] {
	const faces: OrderedFace[] = [];
	for (const p of brush.planes) {
		const n = p.normal;
		// 收集落在该平面上的顶点（含共线点）
		const face: number[] = [];
		for (let vi = 0; vi < verts.length; vi++) {
			const v = verts[vi];
			const d = n.x * v[0] + n.y * v[1] + n.z * v[2] - p.dist;
			if (Math.abs(d) < FACE_EPS) face.push(vi);
		}
		if (face.length < 3) continue;
		// 顶点算术平均，作为极角排序的原点
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
		// 面内正交基 (u, v)：取与法线夹角较大的坐标轴做 Gram-Schmidt 得 u，再令 v = n × u
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
		// 按 atan2(u 分量, v 分量) 升序排成凸多边形
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
 * 按单条面法线取色（Y-up，法线朝外）：
 *
 * - n.y > groundAngleCos（倾角小于 groundAngle）→ 近乎水平朝上 → 地面（绿）
 * - n.y > slideAngleCos（倾角小于 slideAngle）  → 缓于 slide 的坡面 → 斜坡（黄）
 * - 其余（垂直墙、朝下面、更陡的坡）→ 墙（红）
 *
 * 只看传入的这一条法线，因此同一 brush 的各面可以各得其色（水平面与斜面不会互相拖色）。
 * 整 brush 单一颜色只出现在凸包退化的 AABB 回退路径。
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
// chamfer 平面由 WASM 导出层为每条真实凸棱生成：`apps/debug/crates/wasm/src/lib.rs` 的
// `export_brushes_planes` 取两相邻面法线的归一化均值作平面法线、按"凸包外侧"校验方向，
// 再把它们与真实面一起并入同一个 planes 数组输出 —— 既进物理碰撞，也进本模块的线框显示。
// 本模块把这类平面单独标黄：它只经过一条棱，落在其上的凸包顶点可少至 2 个或全部共线，
// 因而不构成真实面。注意判据不完全重合：`computeChamferStrips` 允许 ≥ 2 个顶点加共线校验，
// 而 `orderedFaces` 只按"顶点数 ≥ 3"筛选，故共线三点以上的 chamfer 平面也会进入线框
// （退化成沿棱的线段）。
// 绘制：以棱为一条边，沿"平面内 ⊥ 棱 ∧ 背离 brush AABB 中心"方向外推 `CHAMFER_QUAD_LEN`，
// 角平分线 chamfer 呈现为贴坡倒角、水平过棱的 chamfer 呈现为贴面帽盖。
// 黄色线段用 depthTest:false 绘制，嵌在几何内部或被遮挡时同样可见。

/** chamfer 线段：平面上相距最远的两个凸包顶点（a、b）与该平面的法线 n。 */
interface ChamferStrip {
	a: [number, number, number];
	b: [number, number, number];
	n: [number, number, number];
}

/** 四边形沿平面内外推的长度（HU）：只影响可视化尺寸，不参与任何判定。 */
const CHAMFER_QUAD_LEN = 16;
/** 共线判定容差（HU）：面上顶点到棱线的垂直距离大于此值即判为真实面。 */
const CHAMFER_COLLINEAR_EPS = 0.5;

/** 三维向量差（返回新数组）。 */
function chVecSub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** 三维两点距离。 */
function chVecDist(a: [number, number, number], b: [number, number, number]): number {
	const d = chVecSub(a, b);
	return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
}

/**
 * 提取 brush 的全部 chamfer 平面线段。逐平面判定：面上顶点少于 2 个 → 跳过；取其中相距最远
 * 的两点作棱，棱长 < 0.01 HU → 跳过；其余面上顶点到棱线的垂直距离（|ap × ab| / |ab|）全部
 * 不超过 `CHAMFER_COLLINEAR_EPS` → 只过棱、不构成面 → 收作 chamfer。
 * 凸包顶点少于 4 个（退化）时整体返回空数组。
 */
function computeChamferStrips(brush: Brush): ChamferStrip[] {
	const verts = computeBrushHull(brush);
	if (verts.length < 4) return [];
	const strips: ChamferStrip[] = [];
	for (const p of brush.planes) {
		// 收集落在该平面上的凸包顶点
		const on: number[] = [];
		for (let vi = 0; vi < verts.length; vi++) {
			const v = verts[vi];
			const d = p.normal.x * v[0] + p.normal.y * v[1] + p.normal.z * v[2] - p.dist;
			if (Math.abs(d) < FACE_EPS) on.push(vi);
		}
		if (on.length < 2) continue;
		// 双重循环取相距最远的一对，作为棱的两端
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
		if (!collinear) continue; // 有顶点偏离棱线 ⇒ 是真实面，不是 chamfer
		strips.push({
			a: [a[0], a[1], a[2]],
			b: [b[0], b[1], b[2]],
			n: [p.normal.x, p.normal.y, p.normal.z],
		});
	}
	return strips;
}

/**
 * 把凸包按面画成线框：每个面沿其有序顶点闭合连边（相邻顶点两两成段，末点连回首点）。
 * 每条线段按该面法线调用 `classify` 单独取色，故同一 brush 的不同面可以是不同颜色；
 * 位置与颜色都按"两个端点"写入（顶点色渲染要求逐顶点显式给出）。
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
 * 判断点是否在 brush 内部：对全部平面满足 dot(n,p)-dist <= 1.0 才算内部。
 * 1.0 HU 的容差吸收凸包重建与相机位置的浮点误差，即略微外凸的点仍算内部。
 * `planes` 为空时恒返回 true；唯一调用点在凸包顶点数 >= 4 之后。
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
 * 把凸包填充成实心三角形：每个面以首顶点为扇心做扇形三角化，与线框共用 `orderedFaces`，
 * 故填充边界与描边逐面重合，便于分辨内外。
 * 颜色同样按面法线经 `classify` 取，与描边逐面一致。
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

/** 把 AABB 的 12 条棱推入 positions/colors（单色；凸包退化或触发器无平面时用它回退）。 */
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
 * 碰撞体可视化：五个 Group 与五个开关，由 `renderer-main` 的每帧循环驱动。
 * `update` 内部按各自的限流计数重建：实体碰撞箱与 chamfer 每 `REBUILD_INTERVAL` 帧、模型三角形
 * 每 `TRI_REBUILD_INTERVAL` 帧（开关或距离变更时 `phyDirty` 立即触发）、触发器每帧重建。
 * `update` 的返回值表示本帧是否装配过对象，调用方据此置 `needsRender`。
 */
export class ColliderDebug {
	/** 由 `init` 注入的场景引用；`dispose` 置回 null，是 `update` 是否工作的总开关。 */
	private scene: THREE.Scene | null = null;
	/** 实体碰撞箱：凸包线框 + 相机在内部时的半透明填充（受 showSolids 控制）。 */
	private solidGroup: THREE.Group | null = null;
	/** .phy 三角形线框（橙，受 showPhy 控制）。 */
	private phyGroup: THREE.Group | null = null;
	/** 可视网格三角形线框（紫，受 showVis 控制）。 */
	private visGroup: THREE.Group | null = null;
	/** chamfer 切角平面线框（黄，受 showChamfers 控制）。 */
	private chamferGroup: THREE.Group | null = null;
	/** 触发器线框（按触发类型着色，受 showTriggers 控制）。 */
	private triggerGroup: THREE.Group | null = null;
	/** 实体碰撞箱开关。 */
	private showSolids = false;
	/** 实体碰撞箱可视距离（HU，XZ 平面内点到 brush AABB 的距离；<= 0 = 全量）。 */
	private brushViewDistance = 512;
	/** 触发器开关。 */
	private showTriggers = false;
	/** 触发器可视距离（HU；<= 0 = 全量）。 */
	private triggerViewDistance = 0;
	/** .phy 三角形开关（橙色线框）。 */
	private showPhy = false;
	/** 可视网格三角形开关（紫色线框）。 */
	private showVis = false;
	/** chamfer 平面开关（黄色线框）。 */
	private showChamfers = false;
	/** .phy 可视距离（HU；<= 0 = 全量）。初始化后由 config.debug.phyViewDistance 覆盖。 */
	private phyViewDistance = 2048;
	/** 可视网格可视距离（HU）。本路径没有"全量"分支：取 0 时仅相机落在 mesh AABB 内才通过粗筛。 */
	private visViewDistance = 512;
	/** chamfer 可视距离（HU；<= 0 = 全量）。 */
	private chamferViewDistance = 512;
	/** 模型三角形需立即重建标记：`setTriDebugFlags` 检测到开关或距离变化时置位。 */
	private phyDirty = false;
	/** 实体碰撞箱重建限流计数（只在开关打开时累加）。 */
	private frameCounter = 0;
	/** chamfer 重建限流计数（与实体碰撞箱同周期）。 */
	private chamferFrameCounter = 0;
	/** chamfer 线段缓存（按 Brush 引用缓存，凸包分类只算一次）；`clearAll` 换图时整体重置。 */
	private chamferCache = new WeakMap<Brush, ChamferStrip[]>();
	/** 模型三角形重建限流计数（.phy 与可视网格共用）。 */
	private triFrameCounter = 0;
	/** 触发器列表（`renderer-main` 由 `TeleportManager.getTriggers` 注入，非 Worker 来源）。 */
	private triggers: readonly TeleportTrigger[] = [];
	/** 模型三角形网格（`renderer-main` 用 `buildWorldBundle` 的 triJson 注入）。 */
	private triMeshes: TriMesh[] = [];

	/** 建 5 个 Group（visible 全为 false）并挂到 scene；不清旧 Group，重复调用会再挂一组。 */
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

	/** 注入模型三角形网格，并置 `phyDirty`、把限流计数推到上限，使下次 `update` 立即重建。 */
	setTriMeshes(meshes: TriMesh[]): void {
		this.triMeshes = meshes;
		this.phyDirty = true;
		this.triFrameCounter = TRI_REBUILD_INTERVAL;
	}

	/** 注入触发器列表；同时把实体碰撞箱的限流计数推到上限（触发器本身每帧重建，无需提示）。 */
	setTriggers(triggers: readonly TeleportTrigger[]): void {
		this.triggers = triggers;
		// 把限流计数推到上限：下一次 update 立即重建实体碰撞箱
		this.frameCounter = REBUILD_INTERVAL;
	}

	/** 设置实体碰撞箱/触发器开关与各自可视距离（distance 传 undefined 表示保持原值）；关闭时清空对应 Group。 */
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
	 * 设置两条模型三角形线框（.phy 橙 / 可视网格紫）的开关与可视距离。
	 * 四项中任一项变化即置 `phyDirty`；无论是否变化都把限流计数推到上限，故本次调用后
	 * 下一次 `update` 必定重建一次（不受 `TRI_REBUILD_INTERVAL` 限制）。关闭的路径清空对应 Group。
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
	 * 设置 chamfer 线框的开关与可视距离。关闭时清空 Group；并把限流计数推到上限，
	 * 使下一次 `update` 立即重建一次。
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
	 * 每帧入口：按五个开关分别重建四类内容，顺序为实体碰撞箱 → 模型三角形 → chamfer → 触发器。
	 * @param cameraPos 相机世界坐标，用作距离筛选中心与"相机是否在 brush 内部"的判据。
	 * @param colliders 实体碰撞体（`renderer-main` 传 solids 与 ladders 的合并数组）。
	 * @param config 运行时配置（取玩家体高/眼偏移与地面、斜坡两个角度阈值）。
	 * @returns 本帧是否装配过对象。`init` 之前或 `dispose` 之后 scene 为 null，直接返回 false；
	 *          触发器只要开关打开就无条件返回 true（与是否真的收集到线段无关）。
	 */
	update(
		cameraPos: THREE.Vector3,
		colliders: Brush[],
		config: RuntimeConfig,
	): boolean {
		if (!this.scene) return false;
		let rebuilt = false;

		// 1. 实体碰撞箱：开关打开才累加计数，达到 REBUILD_INTERVAL 才真正重建
		if (this.showSolids && this.solidGroup) {
			this.frameCounter++;
			if (this.frameCounter >= REBUILD_INTERVAL) {
				this.frameCounter = 0;
				this.rebuildSolids(cameraPos, colliders, config);
				rebuilt = true;
			}
		}

		// 1.5 模型三角形线框：.phy 与可视网格共用限流计数与 phyDirty，
		//     两条路径各自再检查自己的开关与 Group
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

		// 1.6 chamfer 线框：与实体碰撞箱同限流周期；线段有缓存，重建只做筛选与装配
		if (this.showChamfers && this.chamferGroup) {
			this.chamferFrameCounter++;
			if (this.chamferFrameCounter >= REBUILD_INTERVAL) {
				this.chamferFrameCounter = 0;
				this.rebuildChamfers(cameraPos, colliders, config);
				rebuilt = true;
			}
		}

		// 2. 触发碰撞箱：开关打开即每帧重建（数量少，不限流）
		if (this.showTriggers && this.triggerGroup) {
			this.rebuildTriggers(cameraPos);
			rebuilt = true;
		}

		return rebuilt;
	}

	/** 五个开关中任一为真即返回 true；`renderer-main` 据此决定本帧是否调用 `update`。 */
	get hasDebugWork(): boolean {
		return this.showSolids || this.showTriggers || this.showPhy || this.showVis || this.showChamfers;
	}

	/**
	 * 重建实体碰撞箱：清空 Group → 筛出附近的 brush → 逐个重建凸包线框；相机落在某个 brush
	 * 内部时再为该 brush 追加一层半透明填充面（填充面先加入 Group，线框后加入）。
	 * 早退：`colliders` 为空、筛选后为空、或最终没有可画线段时返回。
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

		// 距离筛选：XZ 取点到 brush AABB 的最近点算距离，Y 取 [minY, maxY] 窗口；全量模式跳过 XZ 判据
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

		// 超出上限时按 distSq 排序再截断；但收集时 distSq 一律写入 0、比较键恒等，
		// 故排序不产生距离序，截断保留的是 colliders 中靠前的 MAX_DEBUG_COLLIDERS 个
		if (nearby.length > MAX_DEBUG_COLLIDERS) {
			nearby.sort((a, b) => a.distSq - b.distSq);
			nearby.length = MAX_DEBUG_COLLIDERS;
		}

		const groundAngleCos = Math.cos(config.physics.groundAngle);
		const slideAngleCos = Math.cos(config.physics.slideAngle);
		// 逐面分类：每个面按自身法线取色，同一 brush 的不同面可各得其色
		// （整 brush 单一颜色只出现在下面的 AABB 回退路径）
		const classify = (normal: { x: number; y: number; z: number }) =>
			classifyNormal(normal, groundAngleCos, slideAngleCos);

		const positions: number[] = [];
		const colors: number[] = [];
		const fillPositions: number[] = [];
		const fillColors: number[] = [];

		for (const { brush } of nearby) {
			// 凸包顶点 >= 4 → 逐面线框（真实碰撞几何边）；顶点 < 4 → 回退 AABB 棱（单色）
			// AABB 回退色取全部平面法线 y 的最大值送入同一个 classify（无平面时留哨兵 -2，落墙色）
			const hull = computeBrushHull(brush);
			if (hull.length >= 4) {
				pushBrushWireframe(positions, colors, brush, hull, classify);
				// 仅相机在该 brush 内部（容差 1.0 HU）时才生成填充，提示"身处固体内部"
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

		// 填充面先加入 Group、线框后加入；depthWrite=false 且双面，不遮挡描边、内部视角也可见
		if (fillPositions.length > 0) {
			const fgeom = new THREE.BufferGeometry();
			fgeom.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));
			fgeom.setAttribute('color', new THREE.Float32BufferAttribute(fillColors, 3));
			const fmat = new THREE.MeshBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: FILL_OPACITY,
				side: THREE.DoubleSide, // 双面：相机在凸包内部时填充仍可见
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
	 * 重建 .phy 三角形线框（橙色，每三角形 3 条边，不做数量上限）。
	 * 只取 `TriMesh.surfaceprop` 存在的网格（WASM `export_model_phy_colliders` 的输出）；
	 * 按 `phyViewDistance` 做 mesh AABB 的 XZ 粗筛（<= 0 = 全量），不做 Y 向筛选。
	 * 无论是否收集到线段都会打印一条 console.log。
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
			if (mesh.surfaceprop === undefined) continue; // 仅 .phy 来源（可视网格的 TriMesh 没有 surfaceprop 字段）
			if (!full) {
				// mesh AABB 的 XZ 粗筛（Y-up 下水平面即 x/z 两轴）
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

		this.addTriLines(phyPos, 0xff8c00, group); // 橙色：模型自带 .phy 碰撞网格
	}

	/**
	 * 重建可视网格三角形线框（紫色，独立 Group，不影响 .phy 线框）。
	 * 只取没有 `surfaceprop` 的网格；先按 mesh AABB 的 XZ 距离粗筛，再按三角形自身的 XZ 包围盒
	 * 逐个粗筛；累计线段数（三角形数 × 3）达到 `MAX_TRI_LINES` 即停止收集（外层 break 退出 mesh
	 * 循环，内层 break 退出三角形循环）。距离筛选没有"全量"分支：`visViewDistance` 取 0 时
	 * `radiusSq` 为 0，只有相机落在 mesh AABB 的 XZ 投影内才通过粗筛。
	 * 没有可画线段时直接返回，连 console.log 都不打印。
	 */
	private rebuildVisTriangles(cameraPos: THREE.Vector3): void {
		const group = this.visGroup!;
		this.clearGroup(group);
		if (this.triMeshes.length === 0) return;

		const pos = cameraPos;
		const radiusSq = this.visViewDistance * this.visViewDistance;

		const visPos: number[] = []; // 可视网格顶点流（紫色）
		let triCount = 0;

		for (const mesh of this.triMeshes) {
			if (mesh.surfaceprop !== undefined) continue; // 跳过 .phy 网格（已由 rebuildPhyTriangles 画过）
			if (triCount * 3 >= MAX_TRI_LINES) break;
			// mesh AABB 的 XZ 粗筛（vertices/min/max 均为紧凑数组 [x,y,z]）
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
				// 三角形自身的 XZ 包围盒粗筛（比 mesh 级更紧）
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
	 * 重建 chamfer 线框（黄色）。距离筛选与实体碰撞箱同口径（先 Y 窗口、后 XZ 半径；<= 0 = 全量），
	 * 但不受 `MAX_DEBUG_COLLIDERS` 限制。
	 * chamfer 线段按 Brush 引用缓存在 `chamferCache` 里，`computeChamferStrips` 每个 brush 只跑一次，
	 * 后续重建只做筛选与装配；`clearAll` 时缓存整体重置。
	 * 四边形以棱为一条边，沿"平面内 ⊥ 棱 ∧ 背离 brush AABB 中心"方向外推，用 depthTest:false
	 * 绘制，故贴在几何内或背面的 chamfer 同样可见。
	 * 无论是否收集到线段都会打印一条 console.log。
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
				// 四边形：以棱为一条边，在 chamfer 平面内朝背离 brush 中心的一侧外推
				const ex = s.b[0] - s.a[0];
				const ey = s.b[1] - s.a[1];
				const ez = s.b[2] - s.a[2];
				// 平面内且 ⊥ 棱的方向 = n × e（n 为平面法线，e 为棱向量）
				let dx = s.n[1] * ez - s.n[2] * ey;
				let dy = s.n[2] * ex - s.n[0] * ez;
				let dz = s.n[0] * ey - s.n[1] * ex;
				const dLen = Math.hypot(dx, dy, dz);
				if (dLen < 1e-6) continue;
				dx /= dLen; dy /= dLen; dz /= dLen;
				// 定号：该方向若指向 brush 的 AABB 中心一侧则整体取反，保证朝外
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
			depthTest: false, // 不参与深度测试：嵌在几何内或被遮挡时也可见
		});
		group.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 往指定 Group 追加一组三角形线框。positions 的排布是"每三角形 3 条边 × 每条边 2 个端点 ×
	 * 每端点 3 个分量"，即每个三角形 18 个 float；空数组直接返回，不产生对象。
	 * 材质单色、不透明（transparent 未置位），并关闭深度测试使其始终可见。
	 */
	private addTriLines(positions: number[], color: number, group: THREE.Group): void {
		if (positions.length === 0) return;
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
		const mat = new THREE.LineBasicMaterial({
			color,
			depthTest: false, // 不参与深度测试：不被 brush 线框或几何遮挡
		});
		group.add(new THREE.LineSegments(geom, mat));
	}

	/**
	 * 重建触发器线框：清空 Group → 按 `triggerViewDistance` 做 AABB 的 XZ 粗筛（<= 0 = 全量）
	 * → 按触发类型定色 → 有 >= 4 个凸包平面且能解出 >= 4 个顶点时画凸包线框，否则画 AABB 棱。
	 * `mins` 或 `maxs` 为 null 的触发器整条跳过。
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
				// 触发器 AABB 的 XZ 粗筛（无 mins/maxs 的触发器已在上方跳过）
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
			// 有 >= 4 个凸包平面即按平面重建凸包（楔形/斜面触发器显示真实形状），解不出顶点再回退 AABB
			if (trigger.planes && trigger.planes.length >= 4) {
				const brushLike: Brush = {
					planes: trigger.planes as PlaneLike[],
					min: trigger.mins,
					max: trigger.maxs,
				};
				const hull = computeBrushHull(brushLike);
				if (hull.length >= 4) {
					// 触发器整只一个颜色：classify 恒返回上面选定的触发类型色
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
			depthTest: false, // 不参与深度测试：不被遮挡
		});
		this.triggerGroup!.add(new THREE.LineSegments(geom, mat));
	}

	/** 逐个摘除 Group 的子对象并 dispose 其 geometry 与 material（材质数组逐项）；不改 Group 的 visible。 */
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
	 * 清空全部 5 个 Group 的内容，并把 `chamferCache` 换成新的空 WeakMap（换图后 brush 引用整体更新，
	 * 旧缓存随之失效）。保留 Group 本身与 scene 引用，也不改五个开关字段。
	 */
	clearAll(): void {
		if (this.solidGroup) this.clearGroup(this.solidGroup);
		if (this.phyGroup) this.clearGroup(this.phyGroup);
		if (this.visGroup) this.clearGroup(this.visGroup);
		if (this.chamferGroup) this.clearGroup(this.chamferGroup);
		if (this.triggerGroup) this.clearGroup(this.triggerGroup);
		// brush 对象随地图刷新整体更换，旧条目不再被引用
		this.chamferCache = new WeakMap();
	}

	/** 清空 5 个 Group、从 scene 摘除并置空全部引用（含 scene）。之后 `update` 因 scene 为 null 恒返回 false；五个开关字段保持不变，`hasDebugWork` 仍可为 true。 */
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
