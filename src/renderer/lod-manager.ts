/**
 * WebSurf — 2 级 LOD（近/远）+ 视距剔除 + PVS + hysteresis
 *
 * 关键约束：
 * - 2 级 LOD：近(0)完整渲染，远(2)隐藏（视距剔除），PVS 剔除(-1)直接隐藏
 * - PVS 剔除基于相机所在 cluster 的可见 cluster 集合，仅跨 cluster 边界时重算
 * - LOD update 逻辑必须每帧执行（updateCounter++ 无条件）确保 stats 显示正确
 * - 视距剔除滑块上限应为场景对角线的2倍，默认值为场景对角线的0.5倍
 *
 * 注：原 3 级 LOD 的中级（无 lightmap 降级 shader）已移除——cullDistance 恒远小于
 * midDistance（默认下限 20000 HU），物体在到达中级距离前已被视距剔除，该级永远不生效。
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

/** hysteresis 因子（恢复阈值 = cullDist * 0.85）。 */
const CULL_HYSTERESIS = 0.85;

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
		// 默认视距：小地图全可见（diag*2），大地图默认钳制到 12800
		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const diag = size.length();
		const maxCull = Math.ceil((diag * 4) / 100) * 100;
		const defaultCull = Math.min(Math.ceil((diag * 2) / 100) * 100, 12800);
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
	update(
		cameraPos: THREE.Vector3,
		config: RuntimeConfig,
		pvsManager: PvsManager | null,
	): boolean {
		if (this.items.length === 0) return false;

		this.updateCounter++;
		if (this.updateCounter < config.lod.updateInterval) return false;
		this.updateCounter = 0;

		let lodChanged = false;

		// 更新 PVS（仅跨 cluster 边界时重算，由 PvsManager 内部保证）
		if (pvsManager && config.lod.pvsEnabled) {
			pvsManager.update({
				x: cameraPos.x,
				y: cameraPos.y,
				z: cameraPos.z,
			});
		}

		const cullDistSq = this.cullDistance * this.cullDistance;
		const cullHysteresisSq = cullDistSq * CULL_HYSTERESIS * CULL_HYSTERESIS;
		const pvsActive = pvsManager !== null && pvsManager.enabled && config.lod.pvsEnabled;
		// PVS 安全保护：当 currentCluster < 0（从未有过有效 cluster，如出生即
		// 在固体/地图外）时，visibleSet 为空，所有有 cluster 的 mesh 会被错误剔除。
		// 此时跳过 PVS 判定，全部按距离 LOD 处理。
		const pvsClusterValid = pvsManager !== null && pvsManager.currentClusterId >= 0;

		let nearCount = 0;
		let farCount = 0;
		let pvsHiddenCount = 0;

		for (let i = 0, n = this.items.length; i < n; i++) {
			const item = this.items[i];

			const dx = cameraPos.x - item.center.x;
			const dy = cameraPos.y - item.center.y;
			const dz = cameraPos.z - item.center.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			// 1. PVS 判定：mesh 覆盖的 cluster 集合中任意一个可见 → 可见；
			// 全部不可见 → 隐藏。集合为空（采样全落固体/地图外）→ 跳过。
			if (
				pvsActive &&
				pvsClusterValid &&
				item.clusterIds.length > 0 &&
				!item.clusterIds.some((c) => pvsManager!.isVisible(c))
			) {
				if (item.lodLevel !== LOD_LEVEL.PVS_HIDDEN) {
					item.mesh.visible = false;
					item.lodLevel = LOD_LEVEL.PVS_HIDDEN;
					item.isVisible = false;
					lodChanged = true;
				}
				pvsHiddenCount++;
				continue;
			}

			// 2. 距离 LOD 判定（2 级：近 0 / 远 2）
			let newLevel: number;
			if (item.isVisible) {
				// 当前可见：仅超过 cullDistance 才剔除
				newLevel = distSq > cullDistSq ? LOD_LEVEL.FAR : LOD_LEVEL.NEAR;
			} else {
				// 当前不可见：需低于 hysteresis 阈值才恢复
				newLevel = distSq < cullHysteresisSq ? LOD_LEVEL.NEAR : LOD_LEVEL.FAR;
			}

			// 应用 LOD 变更
			if (newLevel !== item.lodLevel) {
				item.lodLevel = newLevel;
				if (newLevel === LOD_LEVEL.FAR) {
					item.mesh.visible = false;
					item.isVisible = false;
				} else {
					item.mesh.visible = true;
					item.isVisible = true;
				}
				lodChanged = true;
			}

			// 统计
			if (newLevel === LOD_LEVEL.NEAR) nearCount++;
			else farCount++;
		}

		// 刷新统计快照
		this.stats.visible = nearCount;
		this.stats.total = this.items.length;
		this.stats.near = nearCount;
		this.stats.far = farCount;
		this.stats.pvsHidden = pvsHiddenCount;
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

	/**
	 * 获取当前 LOD 统计。
	 */
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
