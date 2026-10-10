/**
 * 三端唯一的**可见性控制器**（T-454 P4；任务书 `.tmp/task-unify-render/TASK.md` §2/L5）。
 *
 * 为什么有这一层：可见性此前三种形态——debug 有自己的 `LodManager`、game 把同一段「按距离剔除 +
 * 可选 PVS」内联在 `tick` 里、viewer **完全不剔除**（全量绘制，见 TODO.md T-624）⇒ 同一张图三端
 * draw call 规模与可见块集合都不同，跨端像素比对时无法区分「渲染差异」与「剔除差异」。
 * 本模块把策略与实现收成一份，三端只提供「收集哪些根、剔除距离取哪档、PVS 是否启用」：
 *
 *   - 判定顺序固定：**距离优先**（`dist > cullDistance` ⇒ 远），距离内再看 PVS（启用且相机 cluster 有效
 *     且该块有 clusterId 且全部不可见 ⇒ 隐藏）；
 *   - `cullDistance = 0` 表示自动（`maxDim × 0.5`，下限 1000，§12.2），显式值直接覆盖；
 *   - **天空层永不剔除**：`SKY_LAYER` 上的 mesh 在收集阶段就跳过（它们由第二相机单独渲染）；
 *   - 相机不在任何 cluster（出生在固体里/地图外）时跳过 PVS，只按距离判定，避免「可见集为空 ⇒ 全剔」；
 *   - 结果写回 `mesh.visible` 与 `mesh.userData.lodLevel`（三端同字段，供调试面板/统计读）。
 */
import * as THREE from 'three';
import { SKY_LAYER } from '../environment/miniature-sky.js';

/** 水平常量（写进 `mesh.userData.lodLevel`，三端同值）。 */
export const LOD_NEAR = 0;
export const LOD_FAR = 2;
export const LOD_PVS_HIDDEN = -1;

/** 剔除距离的自动值下限（HU）。 */
export const CULL_DISTANCE_MIN = 1000;

/** PVS 查询面（只用到 `update` / `enabled` / `currentClusterId` / `isVisible`）。 */
export interface PvsQuery {
  enabled: boolean;
  currentClusterId: number;
  update(camPos: THREE.Vector3): void;
  isVisible(clusterId: number): boolean;
}

/** 只要「点 → cluster」这一件事的采样面（`PvsManager` 与它的结构等价替身都满足）。 */
export interface PvsSampler {
  getClusterAt(p: { x: number; y: number; z: number }): number;
}

export interface VisibilityItem {
  mesh: THREE.Mesh;
  /** 世界空间包围球心（收集时按 `matrixWorld` 烘焙）。 */
  center: THREE.Vector3;
  radius: number;
  /** 该块覆盖的 cluster（7 点采样；空数组表示未知，PVS 阶段跳过）。 */
  clusterIds: number[];
}

export interface VisibilityUpdateResult {
  visible: number;
  culledByDistance: number;
  culledByPvs: number;
  cullDistance: number;
  pvsActive: boolean;
  /** 本帧是否有块的 `lodLevel` 发生变化（debug 的按需渲染据此决定是否重画）。 */
  changed: boolean;
}

/** 距离判定（共享唯一口径）：块中心到相机是否超过剔除距离。本控制器与 debug 的 `LodManager` 都调它。 */
export function isBeyondCullDistance(center: THREE.Vector3, cameraPos: THREE.Vector3, cullDistance: number): boolean {
  const dx = cameraPos.x - center.x;
  const dy = cameraPos.y - center.y;
  const dz = cameraPos.z - center.z;
  return dx * dx + dy * dy + dz * dz > cullDistance * cullDistance;
}

/** 收集/剔除的唯一实现。一个端持一个实例即可（换图时 `clear()` 再 `collect()`）。 */
export class VisibilityController {
  items: VisibilityItem[] = [];
  /** 生效剔除距离（HU）；`0` 表示自动。 */
  cullDistance = 0;
  /** 自动值（`maxDim × 0.5`，下限 1000）；由调用方按地图尺寸设置。 */
  autoCullDistance = CULL_DISTANCE_MIN;
  /** 是否启用 PVS 剔除（三端默认关，§12.2）。 */
  enablePvs = false;

  clear(): void {
    this.items.length = 0;
  }

  /** 按 map 尺寸设置自动剔除距离，并按配置值决定生效值（`configValue > 0` 覆盖自动值）。 */
  setCullDistance(autoValue: number, configValue = 0): number {
    this.autoCullDistance = Math.max(autoValue, CULL_DISTANCE_MIN);
    this.cullDistance = configValue > 0 ? configValue : this.autoCullDistance;
    return this.cullDistance;
  }

  /**
   * 收集可剔除块：遍历 `root` 下所有 mesh，按世界包围球中心与 6 个 ±r 轴上点查 cluster，
   * 写入 `userData.lodLevel = LOD_NEAR` 并返回块数。天空层（`SKY_LAYER`）跳过。
   */
  collect(root: THREE.Object3D, pvs: PvsSampler | null): number {
    this.items.length = 0;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.layers.isEnabled(SKY_LAYER)) return; // 天空层由第二相机渲染，不参与主相机剔除
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const bs = geom.boundingSphere;
      if (!bs) return;
      mesh.userData.lodLevel = LOD_NEAR;
      const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      this.items.push({ mesh, center, radius: bs.radius, clusterIds: [] });
    });
    if (pvs) this.assignClusters(pvs);
    return this.items.length;
  }

  /**
   * 为已收集的块补 cluster 集合：包围球中心 + 6 个 ±r 轴上点共 7 点采样，非负结果去重。
   *
   * 与 `collect(root, pvs)` 分开是因为 PVS 载荷可能晚于块收集就绪（debug 侧是 `setup` 之后才
   * `assignClusterIds`）；两处共用本方法 ⇒ 采样口径全仓只有一份。
   *
   * @returns 采到至少一个 cluster 的块数。
   */
  assignClusters(pvs: PvsSampler): number {
    let mapped = 0;
    for (const item of this.items) {
      const set = new Set<number>();
      const c = item.center;
      const r = Math.max(item.radius, 1);
      const samples: Array<[number, number, number]> = [
        [c.x, c.y, c.z],
        [c.x + r, c.y, c.z],
        [c.x - r, c.y, c.z],
        [c.x, c.y + r, c.z],
        [c.x, c.y - r, c.z],
        [c.x, c.y, c.z + r],
        [c.x, c.y, c.z - r],
      ];
      for (const [x, y, z] of samples) {
        const cl = pvs.getClusterAt({ x, y, z });
        if (cl >= 0) set.add(cl);
      }
      item.clusterIds = [...set];
      if (item.clusterIds.length > 0) mapped++;
    }
    return mapped;
  }

  /** 每帧剔除：距离优先、距离内再看 PVS；返回本帧统计。`camera` 只用到 `position`（debug 侧只持有相机位置）。 */
  update(camera: { position: THREE.Vector3 }, pvs: PvsQuery | null): VisibilityUpdateResult {
    const camPos = camera.position;
    let visible = 0;
    let culledByDistance = 0;
    let culledByPvs = 0;
    let changed = false;
    const pvsActive = this.enablePvs && pvs !== null && pvs.enabled;
    const pvsClusterValid = pvs !== null && pvs.currentClusterId >= 0;
    if (this.enablePvs && pvs) pvs.update(camPos);
    for (const item of this.items) {
      const beyond = isBeyondCullDistance(item.center, camPos, this.cullDistance);
      let level = LOD_NEAR;
      if (beyond) {
        level = LOD_FAR;
        culledByDistance++;
      } else if (
        pvsActive &&
        pvsClusterValid &&
        item.clusterIds.length > 0 &&
        !item.clusterIds.some((c) => pvs!.isVisible(c))
      ) {
        level = LOD_PVS_HIDDEN;
        culledByPvs++;
      } else {
        visible++;
      }
      if (item.mesh.userData.lodLevel !== level) {
        item.mesh.userData.lodLevel = level;
        item.mesh.visible = level === LOD_NEAR;
        changed = true;
      }
    }
    return { visible, culledByDistance, culledByPvs, cullDistance: this.cullDistance, pvsActive, changed };
  }
}
