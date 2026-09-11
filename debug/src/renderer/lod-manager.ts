/**
 * WebSurf — 视距剔除（照搬 game 的语义）
 * - **唯一判据**：块中心到相机距离 > cullDistance → 隐藏；否则可见。
 * - **无 PVS、无 hysteresis、无 cluster**（2026-09-11 对齐 game：
 *   game/src/renderer/renderer-main.ts:746-763 就是这个单条距离判据，ENABLE_PVS=false）。
 *   原 PVS 判定实测在 surf_666 上可见集仅 153/8269 cluster、隐藏 1968/2221 块 → 面成片消失。
 * - update 每帧执行（updateCounter++ 无条件）确保 stats 正确
 * - 剔除滑块上限 = 场景对角线 ×4，默认值对齐 game 的 maxDim×0.5（不低于 12800）
 * 原 3 级 LOD 的中级（lightmap 降级 shader）已移除：cullDistance 恒小于 midDistance，
 * 物体在到达中级前已被视距剔除，该级永不生效。
 */

import * as THREE from 'three';
import type { RuntimeConfig } from '../config.js';
import type { PvsManager } from '../world/pvs-manager.js';

/** LOD 级别。 */
export const LOD_LEVEL = {
	NEAR: 0, // 完整渲染
	FAR: 2, // 隐藏（视距剔除）
	PVS_HIDDEN: -1, // PVS 剔除隐藏
} as const;

/** 单个 mesh 的 LOD 注册项。 */
interface LodItem {
	mesh: THREE.Mesh;
	/** 世界坐标中心。 */
	center: THREE.Vector3;
	/** 包围球半径。 */
	radius: number;
	/**
	 * mesh 覆盖的 cluster 集合（包围盒采样定位，去重）。
	 * 空数组 = 无 PVS 信息（采样全部落在固体/地图外），PVS 判定跳过。
	 */
	clusterIds: number[];
	/** 当前是否可见。 */
	isVisible: boolean;
	/** 当前 LOD 级别。 */
	lodLevel: number;
}

/** LOD 统计信息。 */
export interface LodStats {
	/** 可见 mesh 数。 */
	visible: number;
	/** 总 mesh 数。 */
	total: number;
	/** 近级数量。 */
	near: number;
	/** 远级（已剔除）数量。 */
	far: number;
	/** PVS 剔除数量。 */
	pvsHidden: number;
	/** 当前视距剔除距离。 */
	cullDistance: number;
	/** 场景对角线。 */
	diagonal: number;
	/** 视距剔除上限。 */
	maxCull: number;
}

/** 场景对角线信息（setupLod 输出，用于 UI 滑块设置）。 */
export interface SceneDiagonalInfo {
	/** mesh 数量。 */
	count: number;
	/** 场景对角线。 */
	diagonal: number;
	/** 默认视距剔除距离（对角线 * 0.5）。 */
	defaultCull: number;
	/** 视距剔除上限（对角线 * 2）。 */
	maxCull: number;
}

/**
 * LOD 管理器。
 *
 * 维护 mesh 的 LOD 注册项，每帧执行：
 * 1. updateCounter++ 无条件（确保 stats 正确）。
 * 2. 每 updateInterval 帧执行一次重的 PVS + 距离 LOD 判定。
 * 3. PVS 优先：cluster 不在可见集 → 隐藏(-1)。
 * 4. 距离 LOD（带 hysteresis）：
 *    - 当前可见：distSq > cullDistSq → 远(2)；else 近(0)
 *    - 当前不可见：distSq < cullHysteresisSq → 恢复近(0)；else 远(2)
 */
export class LodManager {
	/** LOD 注册项。 */
	private items: LodItem[] = [];
	/** 每帧计数器（无条件 ++）。 */
	private updateCounter = 0;
	/** 视距剔除距离（HU）。 */
	cullDistance = 12800;
	/** 场景对角线。 */
	private diagonal = 0;
	/** 视距剔除上限。 */
	private maxCull = 0;

	/** 当前统计快照（供 getStats 读取，每 updateInterval 帧刷新）。 */
	private stats: LodStats = {
		visible: 0,
		total: 0,
		near: 0,
		far: 0,
		pvsHidden: 0,
		cullDistance: 0,
		diagonal: 0,
		maxCull: 0,
	};

	/**
	 * 遍历模型注册 LOD item。
	 *
	 * 计算每个 mesh 的世界中心 + 包围球半径。
	 * 设置默认视距剔除距离 = 场景对角线 * 0.5，上限 = 场景对角线 * 2。
	 *
	 * @param model 加载的 glTF 场景根节点。
	 * @param config 运行时配置（读取 lod.updateInterval）。
	 * @returns 场景对角线信息（用于 UI 滑块设置）。
	 */
	setup(model: THREE.Object3D, config: RuntimeConfig): SceneDiagonalInfo {
		this.items.length = 0;
		model.updateMatrixWorld(true);

		const _center = new THREE.Vector3();
		let count = 0;

		model.traverse((obj) => {
			if (!(obj as THREE.Mesh).isMesh) return;
			const mesh = obj as THREE.Mesh;
			const geom = mesh.geometry as THREE.BufferGeometry;
			if (!geom) return;
			if (!geom.boundingSphere) geom.computeBoundingSphere();
			const bs = geom.boundingSphere;
			if (!bs || !isFinite(bs.radius) || bs.radius <= 0) return;

			_center.copy(bs.center).applyMatrix4(mesh.matrixWorld);
			this.items.push({
				mesh,
				center: _center.clone(),
				radius: bs.radius,
				clusterIds: [],
				isVisible: true,
				lodLevel: LOD_LEVEL.NEAR,
			});
			count++;
		});

		// 场景对角线 → 视距上限（向上取整到 100 HU）
		// 默认视距：小地图全可见（diag*2）；大地图与 game 口径对齐。
		// 2026-09-11 修正：原为「大地图硬钳 12800」，但 game 用 maxDim×0.5——
		//   实测 surf_666 世界 32152×32592×32624（maxDim=32624、diag=56217）：
		//   game → 16312，debug 旧口径 → 12800（**近 21%**）。在 32k 宽的开放 surf 图上，
		//   这会让远处平台比 game 早 ~3500 单位消失，是「面莫名消失」的第二个来源
		//   （第一个是 PVS，已默认关闭，见 config.ts lod.pvsEnabled）。
		//   现口径：min(diag*2, max(12800, maxDim*0.5))——小地图仍全可见，
		//   大地图取 game 的 maxDim×0.5（且不低于 12800，不回退）。
		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const diag = size.length();
		const maxCull = Math.ceil((diag * 4) / 100) * 100;
		const gameAlignedCull = Math.max(12800, Math.ceil((Math.max(size.x, size.y, size.z) * 0.5) / 100) * 100);
		const defaultCull = Math.min(Math.ceil((diag * 2) / 100) * 100, gameAlignedCull);
		this.diagonal = diag;
		this.maxCull = maxCull;
		this.cullDistance = defaultCull;

		// 触发首帧立即执行 LOD 判定
		this.updateCounter = config.lod.updateInterval;
		this.stats.total = count;
		this.stats.diagonal = diag;
		this.stats.maxCull = maxCull;
		this.stats.cullDistance = defaultCull;

		return { count, diagonal: diag, defaultCull, maxCull };
	}

	/**
	 * 为已注册的 mesh 建立 cluster 集合。
	 *
	 * 按 mesh 包围盒（中心 ± 半径）采样 7 个点（中心 + 6 面中点），
	 * 逐点用 BSP 树定位 cluster 并去重。mesh 横跨多个 cluster 时全部收录，
	 * PVS 判定时"任一 cluster 可见即可见"（保守方向正确，不会误剔大 mesh）。
	 *
	 * @param pvsManager PVS 管理器。
	 * @returns 已映射 cluster 的 mesh 数量（clusterIds 非空）。
	 */
	assignClusterIds(pvsManager: PvsManager): number {
		let mapped = 0;
		const p = { x: 0, y: 0, z: 0 };
		for (const item of this.items) {
			if (item.clusterIds.length > 0) continue;
			const set = new Set<number>();
			const c = item.center;
			const r = Math.max(item.radius, 1);
			const samples: [number, number, number][] = [
				[c.x, c.y, c.z],
				[c.x + r, c.y, c.z],
				[c.x - r, c.y, c.z],
				[c.x, c.y + r, c.z],
				[c.x, c.y - r, c.z],
				[c.x, c.y, c.z + r],
				[c.x, c.y, c.z - r],
			];
			for (const [x, y, z] of samples) {
				p.x = x;
				p.y = y;
				p.z = z;
				const cl = pvsManager.getClusterAt(p);
				if (cl >= 0) set.add(cl);
			}
			item.clusterIds = [...set];
			if (item.clusterIds.length > 0) mapped++;
		}
		return mapped;
	}

	/**
	 * 每帧更新：PVS 判定 + 距离 LOD（带 hysteresis）。
	 *
	 * - updateCounter++ 无条件（确保 stats 显示正确）。
	 * - 每 updateInterval 帧执行一次重的判定（默认 4 帧）。
	 * - 返回 true 表示 LOD 发生变化（需要重新渲染）。
	 *
	 * @param cameraPos 相机世界坐标。
	 * @param config 运行时配置。
	 * @param pvsManager PVS 管理器（null 表示无 PVS）。
	 * @returns 是否发生 LOD 变化。
	 */
	update(cameraPos: THREE.Vector3, config: RuntimeConfig): boolean {
		if (this.items.length === 0) return false;

		this.updateCounter++;
		if (this.updateCounter < config.lod.updateInterval) return false;
		this.updateCounter = 0;

		let lodChanged = false;

		// 2026-09-11 照搬 game 的剔除实现（game/src/renderer/renderer-main.ts:746-763）：
		// **只按「块中心距离 > cullDistance」判可见性**——无 PVS、无迟滞、无 cluster。
		// 原实现的两处额外机制已移除：
		//   · PVS 判定（实测 surf_666 可见集仅 153/8269 cluster，隐藏 1968/2221 块 → 面成片消失）；
		//   · 迟滞带（0.85×cull）——game 没有，去掉以保持两边完全同语义。
		const cullDistSq = this.cullDistance * this.cullDistance;

		let nearCount = 0;
		let farCount = 0;

		for (let i = 0, n = this.items.length; i < n; i++) {
			const item = this.items[i];

			const dx = cameraPos.x - item.center.x;
			const dy = cameraPos.y - item.center.y;
			const dz = cameraPos.z - item.center.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			const visible = distSq <= cullDistSq;
			if (item.isVisible !== visible) {
				item.mesh.visible = visible;
				item.isVisible = visible;
				item.lodLevel = visible ? LOD_LEVEL.NEAR : LOD_LEVEL.FAR;
				lodChanged = true;
			}

			if (visible) nearCount++;
			else farCount++;
		}

		// 刷新统计快照
		this.stats.visible = nearCount;
		this.stats.total = this.items.length;
		this.stats.near = nearCount;
		this.stats.far = farCount;
		this.stats.pvsHidden = 0;
		this.stats.cullDistance = this.cullDistance;
		this.stats.diagonal = this.diagonal;
		this.stats.maxCull = this.maxCull;

		return lodChanged;
	}

	/**
	 * 设置视距剔除距离（UI 滑块调用）。
	 *
	 * @param dist 剔除距离（HU），会被 clamp 到 [0, maxCull]。
	 */
	setCullDistance(dist: number): void {
		this.cullDistance = Math.max(0, Math.min(dist, this.maxCull));
		this.stats.cullDistance = this.cullDistance;
		// 触发下一帧立即重算
		this.updateCounter = 999;
	}

	/** 获取当前 LOD 统计。 */
	getStats(): LodStats {
		return { ...this.stats };
	}

	/** 已注册 mesh 数量。 */
	get itemCount(): number {
		return this.items.length;
	}

	/** 场景对角线。 */
	get sceneDiagonal(): number {
		return this.diagonal;
	}

	/** 视距剔除上限。 */
	get maxCullDistance(): number {
		return this.maxCull;
	}

	/** 释放资源。 */
	dispose(): void {
		this.items.length = 0;
	}
}
