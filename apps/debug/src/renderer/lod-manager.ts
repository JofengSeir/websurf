/**
 * WebSurf — 视距剔除（debug 侧**统计与 UI 形状**；判定本体在共享层）。
 *
 * 2026-10-11（T-460 WP3）：判定与 PVS 口径全部移交 `src/renderer-shared/scene/visibility-controller.ts`
 * ——本文件不再持有自己的距离公式，也不再自己写 `mesh.visible`，只做三件事：
 *   ① `setup`：把块交给共享控制器收集（`collect`），并算场景对角线与滑块量程（UI 用）；
 *   ② `assignClusterIds`：把 PVS 载荷交给共享控制器补 cluster 集合（`assignClusters`，采样口径同一份）
 *      ——该方法的返回值（采到 cluster 的块数）由此成为**真消费方**：`update` 用它做 PVS 判定（T-319）；
 *   ③ `update`：按 `lod.updateInterval` 节流调共享控制器的 `update`，把返回值翻成 `LodStats`，
 *      并把 `changed` 回给调用方（debug 是按需渲染）。
 *
 * 取值口径统一到共享呈现档 `vbsp:renderPrefs`（三端同档）：
 *   - `culling.distance`（0 = 自动 `max(maxDim × 0.5, 1000)`）——面板滑块写档，不再走本文件私有公式；
 *   - `culling.pvs`——每轮判定前重新读档，档即开关（T-633）。
 */
import * as THREE from 'three';
import type { RuntimeConfig } from '../config.js';
import type { PvsManager } from '../../../../src/ts-shared/world/pvs-manager.js';
import { readRenderPrefs, writeRenderPrefs } from '../../../../src/renderer-shared/config/render-prefs.js';
import {
	LOD_FAR,
	LOD_NEAR,
	LOD_PVS_HIDDEN,
	VisibilityController,
} from '../../../../src/renderer-shared/scene/visibility-controller.js';

/** LOD 级别：取值与共享控制器写进 `mesh.userData.lodLevel` 的三个常量同源。 */
export const LOD_LEVEL = {
	NEAR: LOD_NEAR, // 可见（距离判据通过，且未被 PVS 剔除）
	FAR: LOD_FAR, // 隐藏（距离超出 cullDistance）
	PVS_HIDDEN: LOD_PVS_HIDDEN, // 隐藏（PVS 判定当前 cluster 不可见）
} as const;

/** LOD 统计信息（形状不变：debug 的 UI 与 worker 消息按字段名取用）。 */
export interface LodStats {
	/** 可见块数。 */
	visible: number;
	/** 总块数。 */
	total: number;
	/** 近级数量（= 可见块数）。 */
	near: number;
	/** 远级（距离超出，已隐藏）数量。 */
	far: number;
	/** PVS 剔除数量（`culling.pvs` 为真时由共享控制器写回）。 */
	pvsHidden: number;
	/** 当前生效的视距剔除距离。 */
	cullDistance: number;
	/** 场景对角线。 */
	diagonal: number;
	/** 视距剔除上限（滑块量程，纯 UI 量）。 */
	maxCull: number;
}

/** 场景对角线信息（setup 输出，用于 UI 滑块设置）。 */
export interface SceneDiagonalInfo {
	/** mesh 数量。 */
	count: number;
	/** 场景对角线。 */
	diagonal: number;
	/** 生效剔除距离（档值 0 时 = 自动值）。 */
	defaultCull: number;
	/** 视距剔除上限：场景对角线 ×4，上取整到 100 HU。 */
	maxCull: number;
}

/**
 * LOD 管理器（debug 侧）：收集 → 补 cluster → 每 `updateInterval` 帧口径统一地判一次。
 *
 * `update` 的返回值为「本轮是否有块的可见性发生变化」，调用方据此决定是否重绘。
 */
export class LodManager {
	/** 判定本体（共享层唯一实现）：收集、cluster 采样、距离 + PVS 判定都在它里面。 */
	private readonly visibility = new VisibilityController();
	/** PVS 查询器：`assignClusterIds` 存入，`update` 交给共享控制器。 */
	private pvs: PvsManager | null = null;
	/** 每帧计数器（无条件 ++）。 */
	private updateCounter = 0;
	/** 生效视距剔除距离（HU）；与共享控制器同值。 */
	cullDistance = 0;
	/** 自动剔除距离（`最大边 × 0.5`；下限由共享控制器的 `CULL_DISTANCE_MIN` 兜）。 */
	private autoCull = 0;
	/** 场景对角线。 */
	private diagonal = 0;
	/** 视距剔除上限（滑块量程）。 */
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
	 * 注册视距剔除：块收集交给共享控制器（天空层在收集阶段被跳过），剔除距离按**共享档**取值。
	 *
	 * 注册后把 `updateCounter` 置为 `lod.updateInterval`，使下一次 `update` 立即做首帧判定。
	 *
	 * @param model 加载的 glTF 场景根节点。
	 * @param config 运行时配置（只读 `lod.updateInterval`）。
	 * @param maxDim 整图最大边（`assembleScene` 的 `maxDim`）——自动剔除距离的**输入必须与另两端同源**：
	 *   用本端模型根现算的 bbox 会偏小（天空区已被 `extractSkyArea` 摘走），三端 `cullDistance` 因此不等
	 *   （T-460 WP7 运行期探针实测：debug 16146.83 vs game/viewer 16325.11）。
	 * @returns 场景对角线信息（`count` / `diagonal` / `defaultCull` / `maxCull`，供 UI 滑块使用）。
	 */
	setup(model: THREE.Object3D, config: RuntimeConfig, maxDim: number): SceneDiagonalInfo {
		const count = this.visibility.collect(model, null);

		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const diag = size.length();
		this.diagonal = diag;
		this.maxCull = Math.ceil((diag * 4) / 100) * 100;
		this.autoCull = Number.isFinite(maxDim) ? Math.max(maxDim * 0.5, 0) : 0;
		this.cullDistance = this.visibility.setCullDistance(this.autoCull, readRenderPrefs().culling.distance);

		this.updateCounter = config.lod.updateInterval;
		this.stats = {
			visible: count,
			total: count,
			near: count,
			far: 0,
			pvsHidden: 0,
			cullDistance: this.cullDistance,
			diagonal: diag,
			maxCull: this.maxCull,
		};

		return { count, diagonal: diag, defaultCull: this.cullDistance, maxCull: this.maxCull };
	}

	/**
	 * 为已注册的块建立 cluster 集合：转交共享控制器的 `assignClusters`（7 点采样口径全仓一份）。
	 *
	 * @param pvsManager PVS 管理器。
	 * @returns 采到至少一个 cluster 的 mesh 数量（`update` 的 PVS 阶段消费它）。
	 */
	assignClusterIds(pvsManager: PvsManager): number {
		this.pvs = pvsManager;
		return this.visibility.assignClusters(pvsManager);
	}

	/**
	 * 每帧调用；每 `config.lod.updateInterval` 次做一轮判定（判定本体在共享控制器）。
	 *
	 * 判定顺序（共享口径）：距离优先 → 距离内再看 PVS（档 `culling.pvs` 为真、相机 cluster 有效、
	 * 该块 cluster 全部不可见 ⇒ 隐藏）。天空层不参与。
	 *
	 * @param cameraPos 相机世界坐标。
	 * @param config 运行时配置（读 `lod.updateInterval`）。
	 * @returns 本次是否有块的可见性发生变化。
	 */
	update(cameraPos: THREE.Vector3, config: RuntimeConfig): boolean {
		if (this.visibility.items.length === 0) return false;

		this.updateCounter++;
		if (this.updateCounter < config.lod.updateInterval) return false;
		this.updateCounter = 0;

		// 档即开关（T-633）：每轮判定前重读，面板/深链改档后下一轮生效
		this.visibility.enablePvs = readRenderPrefs().culling.pvs;
		const r = this.visibility.update({ position: cameraPos }, this.pvs);
		this.cullDistance = r.cullDistance;
		this.stats = {
			visible: r.visible,
			total: this.visibility.items.length,
			near: r.visible,
			far: r.culledByDistance,
			pvsHidden: r.culledByPvs,
			cullDistance: r.cullDistance,
			diagonal: this.diagonal,
			maxCull: this.maxCull,
		};
		return r.changed;
	}

	/**
	 * 设置视距剔除距离（UI 滑块调用）。
	 *
	 * 夹到 `[0, maxCull]` 后**写共享呈现档**（`culling.distance`，0 = 自动）——三端由同一档生效，
	 * 面板不再持有私有距离。
	 *
	 * @param dist 剔除距离（HU），会被 clamp 到 [0, maxCull]。
	 */
	setCullDistance(dist: number): void {
		const clamped = Math.max(0, Math.min(dist, this.maxCull));
		this.cullDistance = this.visibility.setCullDistance(this.autoCull, clamped);
		this.stats.cullDistance = this.cullDistance;
		writeRenderPrefs({ culling: { distance: clamped } });
		// 触发下一帧立即判定（置 999 ≥ updateInterval）
		this.updateCounter = 999;
	}

	/** 获取当前 LOD 统计。 */
	getStats(): LodStats {
		return { ...this.stats };
	}

	/** 已注册 mesh 数量。 */
	get itemCount(): number {
		return this.visibility.items.length;
	}

	/** 场景对角线。 */
	get sceneDiagonal(): number {
		return this.diagonal;
	}

	/** 视距剔除上限。 */
	get maxCullDistance(): number {
		return this.maxCull;
	}

	/** 生效的 PVS 开关（共享控制器里的值；三端一致性探针读它）。 */
	get pvsEnabled(): boolean {
		return this.visibility.enablePvs;
	}

	/** 自动剔除距离（`最大边 × 0.5`，下限由共享控制器兜；探针读它）。 */
	get autoCullDistance(): number {
		return this.autoCull;
	}

	/** 释放资源（只清块表，不碰场景对象）。 */
	dispose(): void {
		this.visibility.clear();
		this.pvs = null;
	}
}
