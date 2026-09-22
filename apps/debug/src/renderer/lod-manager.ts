/**
 * WebSurf — 视距剔除（debug 侧实现）。
 *
 * 判据（`update`）：块中心到相机的距离平方 > `cullDistance` 的平方 ⇒ 隐藏，否则可见。
 * 只有这一条判据：`update` 不读 `clusterIds`、不读 `PvsManager`、无迟滞带。
 *
 * 帧节流：`update` 每次调用都 `updateCounter++`，但只有计数达到 `config.lod.updateInterval`
 * 时才做判定并刷新 `stats`（`apps/debug/src/config.ts` 的 `lod.updateInterval` 默认 1）。
 *
 * 剔除距离取值（`setup`）：上限 `maxCull` = 场景对角线 ×4 上取整到 100 HU；默认
 * `cullDistance` = min(对角线 ×2, max(12800, 最大边 ×0.5))，各项先上取整到 100 HU ⇒
 * 小地图取对角线两倍全覆盖，大地图取最大边一半且不低于 12800。
 *
 * `PvsManager` 只被 `assignClusterIds` 用来把采样点映射成 cluster 集合，该结果当前无消费方；
 * `LOD_LEVEL.PVS_HIDDEN` 与 `LodStats.pvsHidden` 不参与判定（`pvsHidden` 每次刷新写 0）。
 */

import * as THREE from 'three';
import type { RuntimeConfig } from '../config.js';
import type { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';

/** LOD 级别。 */
export const LOD_LEVEL = {
	NEAR: 0, // 可见（距离判据通过）
	FAR: 2, // 隐藏（距离超出 cullDistance）
	PVS_HIDDEN: -1, // 预留档位：本文件零引用，update 从不写入
} as const;

/** 单个 mesh 的 LOD 注册项。 */
interface LodItem {
	mesh: THREE.Mesh;
	/** 世界坐标中心。 */
	center: THREE.Vector3;
	/** 包围球半径。 */
	radius: number;
	/**
	 * mesh 覆盖的 cluster 集合（由 assignClusterIds 采样定位并去重）。
	 * 空数组 = 7 个采样点全部落在 solid/地图外（getClusterAt 返回负值）；本文件内无消费方。
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
	/** 远级（距离超出，已隐藏）数量。 */
	far: number;
	/** PVS 剔除数量：update 每次刷新恒写 0。 */
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
	/** 默认视距剔除距离：min(对角线×2, max(12800, 最大边×0.5))，先上取整到 100 HU。 */
	defaultCull: number;
	/** 视距剔除上限：场景对角线 ×4，上取整到 100 HU。 */
	maxCull: number;
}

/**
 * LOD 管理器。
 *
 * `setup` 收集全部有效 mesh（世界中心 + 包围球半径 + 场景对角线），`assignClusterIds`
 * 为其采样 cluster，`update` 按相机距离逐块写 `mesh.visible` 并刷新 `stats`。
 *
 * `update` 的返回值为「本轮是否有块的可见性发生变化」，调用方据此决定是否重绘。
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
	 * 遍历模型注册 LOD 项。
	 *
	 * 只收 `boundingSphere` 存在、半径有限且 > 0 的 mesh；中心由包围球中心乘 `matrixWorld` 得到。
	 * 注册后把 `updateCounter` 置为 `lod.updateInterval`，使下一次 `update` 立即做首帧判定。
	 *
	 * @param model 加载的 glTF 场景根节点。
	 * @param config 运行时配置（只读 `lod.updateInterval`）。
	 * @returns 场景对角线信息（`count` / `diagonal` / `defaultCull` / `maxCull`，供 UI 滑块使用）。
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

		// 场景对角线 → 剔除上限与默认值（均向上取整到 100 HU）
		// 默认值 = min(diag*2, max(12800, maxDim*0.5))：小地图取对角线两倍全覆盖，
		// 大地图取最大边一半，且不低于 12800。
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
	 * 按 mesh 包围盒采样 7 个点（中心 + 6 个面中点，半径取 `max(radius, 1)`），逐点调
	 * `PvsManager.getClusterAt`，把非负结果去重收进 `clusterIds`；已有非空 `clusterIds` 的项跳过。
	 *
	 * @param pvsManager PVS 管理器。
	 * @returns 采到至少一个 cluster 的 mesh 数量。
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
	 * 每帧调用；每 `config.lod.updateInterval` 次做一轮判定。
	 *
	 * 判定：块中心到 `cameraPos` 的距离平方 <= `cullDistance` 的平方 ⇒ 可见（`NEAR`），
	 * 否则隐藏（`FAR`）；仅当可见性翻转时写 `mesh.visible` / `lodLevel` 并把返回值置为 true。
	 * 每轮判定后用当前结果重写 `stats`（`pvsHidden` 恒为 0）。
	 *
	 * @param cameraPos 相机世界坐标。
	 * @param config 运行时配置（读 `lod.updateInterval`）。
	 * @returns 本次是否有块的可见性发生变化。
	 */
	update(cameraPos: THREE.Vector3, config: RuntimeConfig): boolean {
		if (this.items.length === 0) return false;

		this.updateCounter++;
		if (this.updateCounter < config.lod.updateInterval) return false;
		this.updateCounter = 0;

		let lodChanged = false;

		// 可见性判据只有「块中心距离 > cullDistance」这一条：不查 cluster、不带迟滞带。
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
		// 触发下一帧立即判定（置 999 ≥ updateInterval）
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
