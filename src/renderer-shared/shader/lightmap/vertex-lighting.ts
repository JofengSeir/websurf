import * as THREE from 'three';
import { VERTEX_LIGHTING_ATTR } from './glsl-chunks.js';

/**
 * `_vbsp_vlight` 去接缝的**采样半径**（HU）。
 *
 * 2026-11-13 实测（s666 / `s1_ramp1_b`、`s1_window01_1`）：`baked` 光模式下曲面出现
 * 边界清晰的明暗条带；切 `texture` 模式、或把本属性整体替换为常量后条带完全消失
 * ⇒ 条带 100% 来自本属性（贴图/UV/几何/世界光贴图均已逐一排除）。
 * 数据侧同一位置不同法线的副本可差 2%，相邻条带可差 3 倍；Gouraud 把这些跳变画成硬边。
 *
 * ⚠️ 第一版按 24HU 的**格子取均值**，在 s3_ramp1b_2 等曲面上引入了「按格子分块」的新接缝
 * （每格一个常量 ⇒ 相邻格子之间硬跳变）。现在改成**距离加权的连续核**：权重 `1-d/R`
 * 在球面上连续衰减到 0，不存在格子边界；同一位置的副本会收敛到同一结果。
 */
const VLIGHT_SMOOTH_RADIUS = 16;

/** 连续核平滑的遍数：两遍足以把 3 倍跳变压到 <10%，再多次会明显改变整体明暗。 */
const VLIGHT_SMOOTH_PASSES = 2;

/**
 * 逐顶点预烘焙光照（`_VBSP_VLIGHT`）的**去分段接缝**：对每个顶点取 `R` 半径内顶点的
 * 距离加权平均（自身权重 1），跑 {@link VLIGHT_SMOOTH_PASSES} 遍。
 *
 * 为什么在渲染侧做：`.vhv` 是 VRAD 按 strip group 顶点烘焙的，同一位置的不同副本
 * （法线分裂）本来就可以有不同值；这里做**空间重采样**，把条带之间的 3 倍跳变压成
 * 平滑过渡，权重对称 ⇒ 整体亮度不变。
 * 返回值 = 变化超过 1/255 的顶点数（诊断用）。
 */
export function smoothVertexLighting(geom: THREE.BufferGeometry): number {
	// A/B 开关：默认走快速实现；设 `globalThis.__vbspVLightFast = false` 回退到旧实现（数值语义完全一致）。
	const g = globalThis as { __vbspVLightFast?: boolean };
	if (g.__vbspVLightFast === false) return smoothVertexLightingLegacy(geom);
	return smoothVertexLightingFast(geom);
}

/** 旧实现（保留作 A/B 基准）：每遍重新扫 27 个 cell、每遍重算 sqrt 权重。 */
function smoothVertexLightingLegacy(geom: THREE.BufferGeometry): number {
	const attr = geom.getAttribute(VERTEX_LIGHTING_ATTR) as THREE.BufferAttribute | undefined;
	const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
	if (!attr || !pos) return 0;
	const n = pos.count;
	if (n < 2) return 0;
	const r = VLIGHT_SMOOTH_RADIUS;
	const r2 = r * r;

	// 1) 位置焊接：法线分裂会让同一位置出现 2~4 份顶点，平滑只需按位置算一次，
	//    写完再投影回所有副本——大 prop 的顶点数能直接砍掉一多半。
	const weld = new Map<string, number>();
	const rep = new Int32Array(n);
	const ux: number[] = [];
	const uy: number[] = [];
	const uz: number[] = [];
	// 每个唯一位置的代表顶点：颜色要从它身上取，不能拿唯一位置下标当顶点下标用。
	const firstVertex: number[] = [];
	for (let i = 0; i < n; i++) {
		const x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const k = Math.round(x * 100) + ',' + Math.round(y * 100) + ',' + Math.round(z * 100);
		let u = weld.get(k);
		if (u === undefined) {
			u = ux.length;
			weld.set(k, u);
			ux.push(x);
			uy.push(y);
			uz.push(z);
			firstVertex.push(i);
		}
		rep[i] = u;
	}
	const m = ux.length;
	// 性能护栏：这只是渲染期的观感修补，单块超过 8 万个独立位置时跳过，
	// 免得把地图加载拖成几十秒（boreas 的个别大 prop 会命中）。
	if (m > 80000) return 0;

	// 2) 空间桶（数字键，避免每遍几十万次字符串拼接）
	const key = (gx: number, gy: number, gz: number): number =>
		(gx + 1024) * 4194304 + (gy + 1024) * 2048 + (gz + 1024);
	const cellOf = (v: number): number => Math.floor(v / r);
	const grid = new Map<number, number[]>();
	for (let u = 0; u < m; u++) {
		const k = key(cellOf(ux[u]), cellOf(uy[u]), cellOf(uz[u]));
		const list = grid.get(k);
		if (list) list.push(u);
		else grid.set(k, [u]);
	}

	// 3) 逐遍平滑：每顶点最多取 MAX_NEIGHBORS 个邻居（双缓冲 typed array）。
	//    邻居上限是硬要求——boreas 的密集岩石网格里，几万个唯一位置可能两两都落在半径内，
	//    不限量建邻接表会把主线程卡死（曾把载图跑成无限等待）。
	const MAX_NEIGHBORS = 128;
	let src = new Float32Array(m * 3);
	for (let u = 0; u < m; u++) {
		const i = firstVertex[u];
		src[u * 3] = attr.getX(i);
		src[u * 3 + 1] = attr.getY(i);
		src[u * 3 + 2] = attr.getZ(i);
	}
	let dst = new Float32Array(m * 3);
	const t0 = performance.now();
	for (let pass = 0; pass < VLIGHT_SMOOTH_PASSES; pass++) {
		for (let u = 0; u < m; u++) {
			let w = 1;
			let cr = src[u * 3];
			let cg = src[u * 3 + 1];
			let cb = src[u * 3 + 2];
			let taken = 0;
			const x = ux[u];
			const y = uy[u];
			const z = uz[u];
			const gx = cellOf(x);
			const gy = cellOf(y);
			const gz = cellOf(z);
			gather: for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (let dz = -1; dz <= 1; dz++) {
						const list = grid.get(key(gx + dx, gy + dy, gz + dz));
						if (!list) continue;
						for (let t = 0; t < list.length; t++) {
							const v = list[t];
							if (v === u) continue;
							const ddx = ux[v] - x;
							const ddy = uy[v] - y;
							const ddz = uz[v] - z;
							const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
							if (d2 >= r2) continue;
							const ww = 1 - Math.sqrt(d2) / r;
							w += ww;
							cr += ww * src[v * 3];
							cg += ww * src[v * 3 + 1];
							cb += ww * src[v * 3 + 2];
							if (++taken >= MAX_NEIGHBORS) break gather;
						}
					}
				}
			}
			dst[u * 3] = cr / w;
			dst[u * 3 + 1] = cg / w;
			dst[u * 3 + 2] = cb / w;
		}
		const t = src;
		src = dst;
		dst = t;
		// 观感修补不该把载图拖成几十秒：单块预算 80ms，超了就停在这一遍的结果上。
		if (performance.now() - t0 > 80) break;
	}
	let changed = 0;
	// 收口：把平滑后的唯一值写回属性
	for (let i = 0; i < n; i++) {
		const u = rep[i];
		if (
			Math.abs(src[u * 3] - attr.getX(i)) +
			Math.abs(src[u * 3 + 1] - attr.getY(i)) +
			Math.abs(src[u * 3 + 2] - attr.getZ(i)) > 0.004) {
			changed++;
		}
		attr.setXYZ(i, src[u * 3], src[u * 3 + 1], src[u * 3 + 2]);
	}
	if (changed > 0) attr.needsUpdate = true;
	return changed;
}

/**
 * 快速实现：数值语义与 legacy **逐位一致**（同一焊接量化、同一邻居遍历顺序与 MAX_NEIGHBORS 上限、
 * 同一权重公式 `1 - sqrt(d2)/r`、同一两遍双缓冲与除法），只做了三件事：
 *  1) 焊接键从字符串 `"rx,ry,rz"` 换成数字哈希桶 + 精确三元组比较（省掉每顶点字符串拼接）；
 *  2) 邻居表（v 下标 + 权重）只构建一次、两遍复用（legacy 是每遍重扫 27 cell、重算 sqrt）；
 *  3) 邻居表用 growable typed array，避免大量 number[] 装箱。
 * 仍保留 legacy 的「单块 80ms 预算」语义（超预算就停在这一遍的结果上）。
 */
function smoothVertexLightingFast(geom: THREE.BufferGeometry): number {
	const attr = geom.getAttribute(VERTEX_LIGHTING_ATTR) as THREE.BufferAttribute | undefined;
	const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
	if (!attr || !pos) return 0;
	const n = pos.count;
	if (n < 2) return 0;
	const r = VLIGHT_SMOOTH_RADIUS;
	const r2 = r * r;
	// 临时分项计时（A 的收益归因用；`__vbspVLightPerf` 可读累计值）
	const gp = globalThis as {
		__vbspVLightPerf?: {
			chunks: number; weld: number; grid: number; nbr: number; pass: number; write: number;
			mSum: number; eSum: number; nSum: number;
		};
	};
	const perf = (gp.__vbspVLightPerf ??= { chunks: 0, weld: 0, grid: 0, nbr: 0, pass: 0, write: 0, mSum: 0, eSum: 0, nSum: 0 });
	const tA = performance.now();

	// 1) 位置焊接（量化与 legacy 相同）
	const rep = new Int32Array(n);
	const ux: number[] = [];
	const uy: number[] = [];
	const uz: number[] = [];
	const qx: number[] = [];
	const qy: number[] = [];
	const qz: number[] = [];
	const firstVertex: number[] = [];
	const weld = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const ex = Math.round(x * 100);
		const ey = Math.round(y * 100);
		const ez = Math.round(z * 100);
		const h = (Math.imul(ex, 0x9e3779b1) ^ Math.imul(ey, 0x85ebca77) ^ Math.imul(ez, 0xc2b2ae3d)) >>> 0;
		let bucket = weld.get(h);
		let u = -1;
		if (bucket !== undefined) {
			for (let t = 0; t < bucket.length; t++) {
				const c = bucket[t];
				if (qx[c] === ex && qy[c] === ey && qz[c] === ez) {
					u = c;
					break;
				}
			}
		} else {
			bucket = [];
			weld.set(h, bucket);
		}
		if (u < 0) {
			u = ux.length;
			bucket.push(u);
			ux.push(x);
			uy.push(y);
			uz.push(z);
			qx.push(ex);
			qy.push(ey);
			qz.push(ez);
			firstVertex.push(i);
		}
		rep[i] = u;
	}
	const m = ux.length;
	if (m > 80000) return 0;

	const tB = performance.now();
	perf.weld += tB - tA;

	// 2) 空间桶（与 legacy 同键）
	const key = (gx: number, gy: number, gz: number): number =>
		(gx + 1024) * 4194304 + (gy + 1024) * 2048 + (gz + 1024);
	const cellOf = (v: number): number => Math.floor(v / r);
	const grid = new Map<number, number[]>();
	for (let u = 0; u < m; u++) {
		const k = key(cellOf(ux[u]), cellOf(uy[u]), cellOf(uz[u]));
		const list = grid.get(k);
		if (list) list.push(u);
		else grid.set(k, [u]);
	}

	const tC = performance.now();
	perf.grid += tC - tB;

	// 3) 邻居表（顺序/权重/上限与 legacy 的 gather 完全一致）
	const MAX_NEIGHBORS = 128;
	const nbrStart = new Int32Array(m + 1);
	let nbrCap = Math.max(1024, m * 4);
	let nbrCount = 0;
	let nbrV = new Int32Array(nbrCap);
	let nbrW = new Float64Array(nbrCap);
	const growNeighbors = (need: number): void => {
		if (need <= nbrCap) return;
		let cap = nbrCap;
		while (cap < need) cap *= 2;
		const nv = new Int32Array(cap);
		nv.set(nbrV.subarray(0, nbrCount));
		const nw = new Float64Array(cap);
		nw.set(nbrW.subarray(0, nbrCount));
		nbrV = nv;
		nbrW = nw;
		nbrCap = cap;
	};
	for (let u = 0; u < m; u++) {
		nbrStart[u] = nbrCount;
		const x = ux[u];
		const y = uy[u];
		const z = uz[u];
		const gx = cellOf(x);
		const gy = cellOf(y);
		const gz = cellOf(z);
		let taken = 0;
		gather: for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					const list = grid.get(key(gx + dx, gy + dy, gz + dz));
					if (!list) continue;
					for (let t = 0; t < list.length; t++) {
						const v = list[t];
						if (v === u) continue;
						const ddx = ux[v] - x;
						const ddy = uy[v] - y;
						const ddz = uz[v] - z;
						const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
						if (d2 >= r2) continue;
						const ww = 1 - Math.sqrt(d2) / r;
						growNeighbors(nbrCount + 1);
						nbrV[nbrCount] = v;
						nbrW[nbrCount] = ww;
						nbrCount++;
						if (++taken >= MAX_NEIGHBORS) break gather;
					}
				}
			}
		}
	}
	nbrStart[m] = nbrCount;
	const tD = performance.now();
	perf.nbr += tD - tC;

	// 4) 两遍平滑（双缓冲、算术顺序与 legacy 相同）
	let src = new Float32Array(m * 3);
	for (let u = 0; u < m; u++) {
		const i = firstVertex[u];
		src[u * 3] = attr.getX(i);
		src[u * 3 + 1] = attr.getY(i);
		src[u * 3 + 2] = attr.getZ(i);
	}
	let dst = new Float32Array(m * 3);
	const t0 = performance.now();
	for (let pass = 0; pass < VLIGHT_SMOOTH_PASSES; pass++) {
		for (let u = 0; u < m; u++) {
			let w = 1;
			let cr = src[u * 3];
			let cg = src[u * 3 + 1];
			let cb = src[u * 3 + 2];
			const s = nbrStart[u];
			const e = nbrStart[u + 1];
			for (let k = s; k < e; k++) {
				const ww = nbrW[k];
				const v = nbrV[k];
				w += ww;
				cr += ww * src[v * 3];
				cg += ww * src[v * 3 + 1];
				cb += ww * src[v * 3 + 2];
			}
			dst[u * 3] = cr / w;
			dst[u * 3 + 1] = cg / w;
			dst[u * 3 + 2] = cb / w;
		}
		const t = src;
		src = dst;
		dst = t;
		if (performance.now() - t0 > 80) break;
	}

	const tE = performance.now();
	perf.pass += tE - tD;

	// 5) 写回 + changed 统计（与 legacy 相同判定）
	let changed = 0;
	for (let i = 0; i < n; i++) {
		const u = rep[i];
		if (
			Math.abs(src[u * 3] - attr.getX(i)) +
			Math.abs(src[u * 3 + 1] - attr.getY(i)) +
			Math.abs(src[u * 3 + 2] - attr.getZ(i)) > 0.004) {
			changed++;
		}
		attr.setXYZ(i, src[u * 3], src[u * 3 + 1], src[u * 3 + 2]);
	}
	if (changed > 0) attr.needsUpdate = true;
	const tF = performance.now();
	perf.write += tF - tE;
	perf.chunks++;
	perf.mSum += m;
	perf.eSum += nbrCount;
	perf.nSum += n;
	if (perf.chunks % 100 === 0) console.info('[vlight-perf] ' + JSON.stringify(perf));
	return changed;
}