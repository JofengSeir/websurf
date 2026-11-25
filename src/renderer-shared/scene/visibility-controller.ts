/**
 * 可见性控制器：把「哪些块要画」收敛到**单一判据**——距离档（PVS 关闭时才有）+ PVS 可见集。
 *
 * 设计约束（T-454 之后重写，替换 debug 端原有的 `LodManager`；game 端与 viewer 端共用同一份）：
 *
 *   - **PVS 档下不做任何运行期兜底**：没有近场豁免、没有「最近点/房间盒救援」、没有「无 cluster 就画」、
 *     没有「近处全被剔就整帧退回」。块画不画只由「它覆盖的 cluster 里有没有可见的」决定，
 *     距离/半径/包围盒一律不参与「该不该显示」的判断——否则就会出现「看得见的东西被距离吃掉」。
 *   - `cullDistance = 0`（默认）表示自动档：`RenderSession` 给 PVS 开时是 `Infinity`、PVS 关时是
 *     `maxDim × 0.25`。显式正值只在 PVS 关闭时生效（PVS 开时会被每帧压回 `Infinity`），
 *     按**块表面**判定（`dist > cullDistance + 半径`），大合并块不会被整块误杀。
 *   - 天空层（`SKY_LAYER`）的 mesh 不参与剔除：它们由独立的天空相机绘制，主相机永远不画。
 *   - 块的 cluster 归属在**装载期一次性算定**（`assignClusters`），运行期只读不写；
 *     `mesh.visible` 与 `mesh.userData.lodLevel` 一起更新，避免「可见但 LOD 显示不对」。
 */

import * as THREE from 'three';
import { SKY_LAYER } from '../environment/miniature-sky.js';

/** 块的 LOD 档位：写进 `mesh.userData.lodLevel` 供 HUD/诊断读取（不是渲染状态）。 */
export const LOD_NEAR = 0;
export const LOD_FAR = 2;
export const LOD_PVS_HIDDEN = -1;

/** 剔除距离下限（HU）：自动档再小也不会低于这个值，避免近处被「视距」整片吃掉。 */
export const CULL_DISTANCE_MIN = 1000;

/**
 * PVS 开时的自动距离场半径（HU）：以玩家为球心，球外的块直接不画、也不参与 PVS 判定；
 * 球内的块再由 PVS 的可见集决定。取 18000（source 引擎里常见的大图可视距离量级，
 * 覆盖 boreas 主要结构又能在 666 这类大图上省掉大半远景块）。
 */
export const CULL_DISTANCE_PVS_DEFAULT = 18000;

/**
 * 给「顶点全落在固体/虚空里」的块（窗玻璃、贴墙 model 面、地图外壳外的重复道具）找房间时，
 * 沿 6 个轴向试探的偏移量（HU）。窗玻璃通常嵌在 16~64 HU 厚的墙体里，所以需要 96/192 这一档
 * 才能探到房间；再远就不试了——那说明它确实不在任何房间里。
 */
const PROBE_OFFSETS: Array<[number, number, number]> = [
  [24, 0, 0], [-24, 0, 0], [0, 24, 0], [0, -24, 0], [0, 0, 24], [0, 0, -24],
  [96, 0, 0], [-96, 0, 0], [0, 96, 0], [0, -96, 0], [0, 0, 96], [0, 0, -96],
  [192, 0, 0], [-192, 0, 0], [0, 192, 0], [0, -192, 0], [0, 0, 192], [0, 0, -192],
];

/** 沿顶点法线的阶梯式外扩距离（HU）：±4 落在墙体内时，±64/±192 才进到房间里。 */
const NORMAL_LADDER = [4, 16, 32, 64, 96, 144, 192];

/**
 * PVS 查询面（`update` / `enabled` / `currentClusterId` / `isVisible` + 点定位 `getClusterAt`）。
 */
export interface PvsQuery extends PvsSampler {
  enabled: boolean;
  currentClusterId: number;
  update(camPos: THREE.Vector3): void;
  isVisible(clusterId: number): boolean;
  /**
   * cluster 的空间范围（`PvsManager` 侧用 leaf AABB 合成）。目前运行期已不再用它做剔除，
   * 保留给诊断/工具脚本读取。
   */
  clusterBounds?(cluster: number): { count: number; min: number[]; max: number[] } | null;
  /**
   * 找一个「靠近」某点的 cluster：先按点位定位，落进固体 leaf 时再按 24/72 HU 的 6 个方向找。
   * 只给**相机**用（一次调用），批量顶点采样仍走 `getClusterAt`。
   */
  getClusterNear?(p: { x: number; y: number; z: number }): number;
  /**
   * 把可见集直接切到指定 cluster（相机点落在固体 leaf 时的兜底）。
   * 返回 false 表示该行数据缺失/全零 ⇒ 调用方本帧不按 PVS 剔除。
   */
  updateToCluster?(clusterId: number): boolean;
}

/** 采样面（只依赖「点 → cluster」）：装载期归属判定与相机定位都走它。 */
export interface PvsSampler {
  getClusterAt(p: { x: number; y: number; z: number }): number;
  /**
   * 采样器是否**持有可用 PVS 数据**（`PvsManager.enabled`：`clusterCount > 0` 且位图非空）。
   *
   * `false` = 这张地图没编译 vvis（`visibility` lump 为空），`getClusterAt` 恒 -1。
   * 采样方据此在**采样之前**区分「地图本来就没有 PVS」（正常 ⇒ 静默退回距离档）与
   * 「有 visdata 但整图一块都定位不到」（真接线/数据故障 ⇒ 保留熔断告警）。
   * 省略该字段的采样器按「有数据」处理（旧调用方仍然成立）。
   */
  readonly enabled?: boolean;
}

export interface VisibilityItem {
  mesh: THREE.Mesh;
  /** 世界空间包围球心（收集时按 `matrixWorld` 烘焙）。 */
  center: THREE.Vector3;
  radius: number;
  /** 该块覆盖的 cluster（装载期一次性算定；空数组表示「整块落在固体/虚空里，不属于任何房间」）。 */
  clusterIds: number[];
  /** 归属判定时用的 geometry uuid（几何被换成最终合并块后要重算，见 `update`）。 */
  clusterGeom?: string;
  /** 空集合的重算次数（有上限，避免每帧重试）。 */
  clusterTries?: number;
  /** 世界空间 AABB（距离场判定用；按当前几何与 `matrixWorld` 每帧刷新，无分配）。 */
  box?: THREE.Box3;
}

export interface VisibilityUpdateResult {
  visible: number;
  culledByDistance: number;
  culledByPvs: number;
  cullDistance: number;
  pvsActive: boolean;
  /** 本帧是否有块的 `lodLevel` 发生变化（debug 的按需渲染据此决定是否重画）。 */
  changed: boolean;
  /**
   * 本帧每个可见块**凭什么被画**：`pvs` = PVS 判可见（PVS 档下唯一的正当理由）、
   * `distance` = 只有距离档在起作用（PVS 关）。
   */
  reasons: { pvs: number; distance: number };
  /**
   * 本帧**真正用于可见性判定**的相机 cluster（`getClusterNear` 解析出来的房间，不一定等于
   * `pvs.currentClusterId`）；-1 = 相机连邻近房间都定位不到（嵌在实体里/地图外）。
   *
   * 逐三角形过滤必须用这个值：`pvs.currentClusterId` 在相机落进固体 leaf 时会保留上一个房间，
   * 拿它裁三角形就会把眼前真实可见的面整片裁掉（穿透相机看到的「破洞」）。
   */
  clusterAtCamera: number;
  /** 相机 cluster 是否有效；false 时本帧不做块级 PVS 剔除，逐三角形 index 也不能按它裁。 */
  pvsClusterValid: boolean;
  /**
   * 相机点本身落在**固体 leaf** 里（穿墙 / 相机嵌进 brush）。这种情况下 `getClusterNear` 找到的是
   * 隔壁房间，按它的 PVS 行裁三角形会把「隔着墙看过去、真实可见」的面裁掉——穿透视角下的
   * 三角破洞就是这么来的。上层据此跳过逐三角形裁剪（宁可多画）。
   */
  cameraInSolid: boolean;
}

/**
 * 距离判定（全程唯一口径）：**块表面**到相机是否超过剔除距离。
 *
 * 必须把块的包围球半径算进去（`cullDistance + radius`）。按块中心判定时，合并块越大越容易误杀：
 * surf 图的块半径上万，中心在视距外而几何体贴在相机脸上。默认 `cullDistance = Infinity` 时本函数
 * 恒为 false（全加载）；只有 PVS 关闭且面板显式设了视距才真正剔除。
 */
export function isBeyondCullDistance(
  center: THREE.Vector3,
  cameraPos: THREE.Vector3,
  cullDistance: number,
  radius = 0,
): boolean {
  if (!Number.isFinite(cullDistance)) return false;
  const dx = cameraPos.x - center.x;
  const dy = cameraPos.y - center.y;
  const dz = cameraPos.z - center.z;
  const reach = cullDistance + Math.max(0, radius);
  return dx * dx + dy * dy + dz * dz > reach * reach;
}

/**
 * 距离场判定（精确版）：**块的轴对齐盒**到相机是否在球外。
 *
 * `isBeyondCullDistance` 用「中心 + 包围球半径」，对合并块是**上界**：一块半径 5000 的合并块，
 * 中心在 21000 处也会被算成「球内」（21000 − 5000 < 18000），结果把隔着大半个地图的另一片区域
 * 拖进画面（surf_666 窗外结构就是这么漏的）。盒判定按**离相机最近的那个面**算，球外即剔，
 * 与用户要的「球形距离场」语义一致。几何烘焙成世界坐标、mesh 矩阵恒等，盒可直接用几何 AABB。
 */
export function isBeyondCullDistanceBox(
  box: THREE.Box3,
  cameraPos: THREE.Vector3,
  cullDistance: number,
): boolean {
  if (!Number.isFinite(cullDistance)) return false;
  const x = cameraPos.x < box.min.x ? box.min.x : cameraPos.x > box.max.x ? box.max.x : cameraPos.x;
  const y = cameraPos.y < box.min.y ? box.min.y : cameraPos.y > box.max.y ? box.max.y : cameraPos.y;
  const z = cameraPos.z < box.min.z ? box.min.z : cameraPos.z > box.max.z ? box.max.z : cameraPos.z;
  const dx = cameraPos.x - x;
  const dy = cameraPos.y - y;
  const dz = cameraPos.z - z;
  return dx * dx + dy * dy + dz * dz > cullDistance * cullDistance;
}

/** 可见性控制器：`clear()` 后重新 `collect()`，每帧调一次 `update()`。 */
export class VisibilityController {
  items: VisibilityItem[] = [];
  /** 当前生效的剔除距离（HU）。`Infinity` = 不做距离剔除。 */
  cullDistance = 0;
  /** 自动档距离：PVS 开为 `CULL_DISTANCE_PVS_DEFAULT`（18000），PVS 关为 `maxDim × 0.25`（下限 1000）。
   *  由调用方按地图设置。 */
  autoCullDistance = CULL_DISTANCE_MIN;
  /** 是否启用 PVS 剔除（三端默认参见 `RENDER_DEFAULT_PVS`）。 */
  enablePvs = false;
  /** 场景里是否已有「逐三角形 cluster 表」的块（cluster-filter.ts）；有则这些块不按块判可见性。 */
  chunkIndexActive = false;
  /**
   * 相机定位不到任何房间（在实体里/在地图外）时的告警去抖标记。
   * 这种帧**不做任何距离兜底**——PVS 档下剔除只由 PVS 说话，距离档一插手就会吃掉看得见的几何。
   */
  private pvsUnlocated = false;
  /** 每帧复用的块世界盒（避免 700 次分配）。 */
  private readonly chunkBox = new THREE.Box3();
  /** cluster 集合是否已按顶点采样算好（开启 PVS 后懒算一次）。 */
  private clustersReady = false;
  /** 采样用的临时点（避免每顶点分配）。 */
  private readonly tmpPoint = new THREE.Vector3();
  /** 这张地图没有 PVS 数据（未编译 vvis）：不再采样，静默走距离档（见 `assignClusters`）。 */
  private pvsDataMissing = false;
  /**
   * 数据级熔断闩锁：有 visdata 但整图 `mapped === 0`（见 `assignClusters` 末尾）。
   *
   * 必须自己记：`RenderSession.updateVisibility` 每帧会用渲染偏好重写 `enablePvs`，
   * 只置 `enablePvs = false` 下一帧就被覆盖 ⇒ 熔断形同虚设（整图块级 `clusterIds` 为空，
   * 继续按 PVS 判就整屏黑）。换图/重建（`collect`）时复位。
   */
  private pvsDataBroken = false;
  /** `[pvs] 无 visdata` 的 info 每张图只打一次。 */
  private pvsNoDataLogged = false;

  clear(): void {
    this.items.length = 0;
    this.clustersReady = false;
    this.pvsDataMissing = false;
    this.pvsDataBroken = false;
    this.pvsNoDataLogged = false;
  }

  /**
   * 设置生效剔除距离。
   *
   * `configValue = 0`（默认）= 用**自动档** `autoValue`（PVS 关时由调用方给 `maxDim × 0.25`）：
   * 远景本来就被距离雾吃掉，全量提交给 CPU 代价很高（surf_boreas 实测 2789 draw / 53fps）。
   * 显式正值覆盖自动档；两者都按**块表面**判定（见 `isBeyondCullDistance`），大合并块不会被整块误杀。
   */
  setCullDistance(autoValue: number, configValue = 0): number {
    this.autoCullDistance = Math.max(autoValue, CULL_DISTANCE_MIN);
    // 0（默认）= 自动值（调用方给 maxDim × 0.25，见 RenderSession）；显式正值才覆盖。
    this.cullDistance = configValue > 0 ? configValue : this.autoCullDistance;
    return this.cullDistance;
  }

  /**
   * 收集可剔除块：遍历 `root` 下所有 mesh，写入包围球与 `userData.lodLevel = LOD_NEAR`，
   * 返回块数。天空层（`SKY_LAYER`）跳过。
   */
  collect(root: THREE.Object3D, pvs: PvsSampler | null): number {
    this.items.length = 0;
    // 换图/重建：上一张图的数据级判定（无 visdata / 熔断）不继承。
    this.pvsDataMissing = false;
    this.pvsDataBroken = false;
    this.pvsNoDataLogged = false;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.layers.isEnabled(SKY_LAYER)) return; // 天空层由天空相机画，主相机不参与剔除
      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const bs = geom.boundingSphere;
      if (!bs) return;
      mesh.userData.lodLevel = LOD_NEAR;
      const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
      this.items.push({ mesh, center, radius: bs.radius, clusterIds: [] });
    });
    if (pvs && this.enablePvs) {
      this.assignClusters(pvs);
      this.clustersReady = true;
    }
    return this.items.length;
  }

  /**
   * 确保 cluster 归属已经算过（幂等）。
   *
   * 为什么需要：PVS 可以在**装载之后**才被打开（面板勾选 / 存档里上次是关的）。那条路径上
   * `collect()` 当时没采样，块的 `clusterIds` 是空的——直接开 PVS 会把「没有任何 cluster」
   * 当成「哪儿都看不见」而把全场景剔空（实测 drawn 0）。
   */
  ensureClusters(pvs: PvsSampler): void {
    if (this.clustersReady) return;
    // 无 visdata 或已熔断：采样没有意义（每次重试都是整图白扫），保持「没有归属」。
    if (this.pvsDataMissing || this.pvsDataBroken) return;
    this.assignClusters(pvs);
    this.clustersReady = true;
  }

  /**
   * 装载期给每个块算出它覆盖的 cluster 集合。
   *
   * **优先逐顶点定位**（顶点沿法线外偏 4 HU 后查 BSP leaf → cluster，去重成集合）：合并块的
   * 包围球半径可达数千 HU，7 点采样会落到块外的其它区域，既不准确也容易误剔/漏剔。
   * 顶点采样在 1.5M 顶点量级约 170ms，只在 PVS 剔除真正开启时做一次。
   * 没有 position 属性的块、以及顶点全落进固体的块走 AABB 多点探测（见下）。
   *
   * @returns 采到至少一个 cluster 的块数。
   */
  assignClusters(pvs: PvsSampler, only?: VisibilityItem, quiet = false): number {
    // 地图**没有 visdata**（没跑 vvis / `visibility` lump 为空）：`getClusterAt` 恒 -1。
    // 逐顶点采样只会白扫一遍全图（1.5M 顶点量级 ≈ 170ms），最后必然命中下面那条数据级
    // 熔断并打出「数据/接线问题」告警——把一张正常地图误报成故障（surf_voyager 就是这样）。
    // 这里在采样前就把两种情况分开：无数据 ⇒ 不采样、不置熔断，只记一次 info，由上层
    // 按 `pvs.enabled === false` 退回距离档（与用户手动关 PVS 走同一条路径）。
    if (pvs.enabled === false) {
      this.pvsDataMissing = true;
      if (!quiet && typeof console !== 'undefined' && !this.pvsNoDataLogged) {
        this.pvsNoDataLogged = true;
        console.info('[pvs] 本地图未编译 PVS（visdata 为空，clusterCount = 0）⇒ 不做 PVS 剔除，按距离档渲染（正常，不是接线故障）');
      }
      return 0;
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    let mapped = 0;
    for (const item of this.items) {
      if (only && item !== only) continue;
      // 按 cluster 拆出来的子块：**不要重新采样**。它们的几何与源块共享同一批顶点属性
      // （`position` 里是整个源块的顶点），再按顶点采样会把别的房间的 cluster 又收回来，
      // 拆分就白做了。这类块的归属在拆分时已按三角形定好，直接采用。
      const splitClusters = item.mesh.userData?.splitClusters;
      if (Array.isArray(splitClusters) && splitClusters.length > 0) {
        item.clusterIds = splitClusters.slice();
        item.clusterGeom = (item.mesh.geometry as THREE.BufferGeometry | undefined)?.uuid ?? '';
        mapped++;
        continue;
      }
      const splitCluster = item.mesh.userData?.splitCluster;
      if (typeof splitCluster === 'number') {
        item.clusterIds = [splitCluster];
        item.clusterGeom = (item.mesh.geometry as THREE.BufferGeometry | undefined)?.uuid ?? '';
        mapped++;
        continue;
      }
      const set = new Set<number>();
      const geom = (item.mesh.geometry as THREE.BufferGeometry | undefined);
      const pos = geom?.attributes.position as THREE.BufferAttribute | undefined;
      const nrm = geom?.attributes.normal as THREE.BufferAttribute | undefined;
      if (pos && pos.count > 0) {
        for (let i = 0; i < pos.count; i++) {
          const nx = nrm ? nrm.getX(i) : 0;
          const ny = nrm ? nrm.getY(i) : 1;
          const nz = nrm ? nrm.getZ(i) : 0;
          const vx = pos.getX(i);
          const vy = pos.getY(i);
          const vz = pos.getZ(i);
          // 顶点沿法线外偏 4 HU 后查 leaf。**只看外侧不够**：贴墙看背面（BSP 面多为双面材质）
          // 或法线朝固体时，外偏一律落进固体 leaf（-1），该块就只剩「远处那部分」的 cluster，
          // 房间里的墙被误剔（surf_666 室内缺墙就是这么来的）。所以外侧落进固体时依次再试内侧、
          // 顶点本身，取第一个非固体 leaf——多算几个 cluster 只会更保守（多画），不会误剔。
          let cl = -1;
          for (let k = 0; k < 3; k++) {
            const off = k === 0 ? 4 : k === 1 ? -4 : 0;
            this.tmpPoint.set(vx + nx * off, vy + ny * off, vz + nz * off);
            const w = this.tmpPoint.applyMatrix4(item.mesh.matrixWorld);
            cl = pvs.getClusterAt({ x: w.x, y: w.y, z: w.z });
            if (cl >= 0) break;
          }
          if (cl >= 0) set.add(cl);
        }
      }
      if (set.size === 0) {
        // 顶点快速通道（±4 HU）一个 cluster 都没采到：这块的顶点全埋在固体或虚空里
        // （窗玻璃、贴墙 model 面、地图外壳外的重复道具）。改用**阶梯式外扩**再采一次：
        // 沿法线 ±16/32/64/96/144/192 HU 各试一遍——窗玻璃嵌在墙里时 +4 还在墙内，+64 才进房间。
        //
        // 这一步是**装载期的一次性归属判定**（把「这块属于哪个房间」算出来），不是运行期兜底：
        // 算出来的 cluster 之后完全由 PVS 决定画不画。之前这里用「继承 1024 HU 内最近块的 cluster
        // 集合」——那等于把隔壁房间的可见性借给它，窗外/别的关卡区域就是这么漏出来的；
        // 而「判定不出来就按距离画」同样会让地图外壳外的道具永远可见。
        if (pos && pos.count > 0) {
          const step = Math.max(1, Math.floor(pos.count / 32));
          for (let i = 0; i < pos.count; i += step) {
            const nx = nrm ? nrm.getX(i) : 0;
            const ny = nrm ? nrm.getY(i) : 1;
            const nz = nrm ? nrm.getZ(i) : 0;
            const vx = pos.getX(i);
            const vy = pos.getY(i);
            const vz = pos.getZ(i);
            let cl = -1;
            for (const off of NORMAL_LADDER) {
              for (const s of [off, -off]) {
                this.tmpPoint.set(vx + nx * s, vy + ny * s, vz + nz * s);
                const w = this.tmpPoint.applyMatrix4(item.mesh.matrixWorld);
                cl = pvs.getClusterAt({ x: w.x, y: w.y, z: w.z });
                if (cl >= 0) break;
              }
              if (cl >= 0) break;
            }
            if (cl >= 0) set.add(cl);
          }
        }
      }
      if (set.size === 0) {
        // 顶点在 brush 角上：窗玻璃、门板这类薄片的顶点恰好是几个固体的交角，
        // ±4 和 ±192 的阶梯都探不出房间（顶点在几何边界上，任何方向都可能还是固体）。
        // 改用**三角形重心 + 面法线**采样：重心在面内部，沿外法线 ±2 HU 就落在可见侧空气里。
        // 这与相机位置无关，仍然只是「这块属于哪个房间」的一次性归属判定。
        const index = geom?.index ?? null;
        const triCount = index ? Math.floor(index.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
        if (pos && triCount > 0) {
          const stepT = Math.max(1, Math.floor(triCount / 64));
          for (let t = 0; t < triCount; t += stepT) {
            const i0 = index ? index.getX(t * 3) : t * 3;
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
            const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
            const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
            const cx2 = pos.getX(i2), cy2 = pos.getY(i2), cz2 = pos.getZ(i2);
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            const gx = (ax + bx + cx2) / 3;
            const gy = (ay + by + cy2) / 3;
            const gz = (az + bz + cz2) / 3;
            let cl = -1;
            for (const off of [2, 8, 24, 64, 192]) {
              for (const s of [off, -off]) {
                this.tmpPoint.set(gx + nx * s, gy + ny * s, gz + nz * s);
                const w = this.tmpPoint.applyMatrix4(item.mesh.matrixWorld);
                cl = pvs.getClusterAt({ x: w.x, y: w.y, z: w.z });
                if (cl >= 0) break;
              }
              if (cl >= 0) break;
            }
            if (cl >= 0) set.add(cl);
          }
        }
      }
      if (set.size === 0) {
        // 仍为空：在块的世界 AABB 上取中心 + 8 个角 + 6 个面心，沿 ±24/±96/±192 HU 的 6 个轴向
        // 各探一次（与相机的 `getClusterNear` 同一套思路，只是半径更大——道具通常比玩家小得多）。
        const gb = geom ? (geom.boundingBox ?? (geom.computeBoundingBox(), geom.boundingBox)) : null;
        if (gb) {
          this.chunkBox.copy(gb).applyMatrix4(item.mesh.matrixWorld);
          const b = this.chunkBox;
          const cx = (b.min.x + b.max.x) * 0.5;
          const cy = (b.min.y + b.max.y) * 0.5;
          const cz = (b.min.z + b.max.z) * 0.5;
          const pts: Array<[number, number, number]> = [
            [cx, cy, cz],
            [b.min.x, b.min.y, b.min.z], [b.min.x, b.min.y, b.max.z],
            [b.min.x, b.max.y, b.min.z], [b.min.x, b.max.y, b.max.z],
            [b.max.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.max.z],
            [b.max.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.max.z],
            [cx, b.min.y, cz], [cx, b.max.y, cz],
            [b.min.x, cy, cz], [b.max.x, cy, cz],
            [cx, cy, b.min.z], [cx, cy, b.max.z],
          ];
          for (const [px, py, pz] of pts) {
            let cl = pvs.getClusterAt({ x: px, y: py, z: pz });
            if (cl < 0) {
              for (const [ax, ay, az] of PROBE_OFFSETS) {
                cl = pvs.getClusterAt({ x: px + ax, y: py + ay, z: pz + az });
                if (cl >= 0) break;
              }
            }
            if (cl >= 0) set.add(cl);
          }
        }
      }
      item.clusterIds = [...set];
      item.clusterGeom = (item.mesh.geometry as THREE.BufferGeometry | undefined)?.uuid ?? '';
      if (item.clusterIds.length > 0) mapped++;
    }
    if (!quiet && typeof console !== 'undefined') {
      const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      console.info(
        `[pvs] 采样 ${mapped}/${this.items.length} 块有 cluster（不属于任何房间 ${this.items.length - mapped}），用时 ${ms.toFixed(0)}ms`,
      );
    }
    // 数据级保险（不是运行期兜底）：整张图一块 cluster 都采不到 ⇒ PVS 数据/接线不可用，
    // 此时若继续按「不在房间里 ⇒ 不画」执行会整屏黑。这种情况直接关掉 PVS 剔除并告警，
    // 由用户/日志发现数据问题；不会退回任何按距离的可见性判断。
    // 只在**整图**这一趟（不带 `only` 的单块补采样）判：单块重试采不到不代表整图数据坏了。
    if (mapped === 0 && this.items.length > 0 && this.enablePvs && !only) {
      this.enablePvs = false;
      this.pvsDataBroken = true;
      console.warn('[pvs] 整张图没有任何块能定位到 cluster ⇒ 关闭 PVS 剔除（数据/接线问题，需修数据）');
    }
    return mapped;
  }

  /** 每帧剔除：距离档（PVS 关时才有）与 PVS 可见集；`camera` 只用到 `position`（debug 侧只持有相机位置）。 */
  update(camera: { position: THREE.Vector3 }, pvs: PvsQuery | null): VisibilityUpdateResult {
    const camPos = camera.position;
    let visible = 0;
    let culledByDistance = 0;
    let culledByPvs = 0;
    let changed = false;
    // `pvsActive` 还要求「数据没被判坏」：熔断闩锁置位后本帧起彻底不碰 PVS（见 `pvsDataBroken`）。
    const pvsActive = this.enablePvs && pvs !== null && pvs.enabled && !this.pvsDataBroken;
    if (pvsActive && pvs) {
      // 首次开启才做顶点采样（1.5M 顶点 ≈170ms），之后只有 cluster 变化才有意义；
      // `pvs.update` 内部自己判「cluster 没变就不重解位图」。
      if (!this.clustersReady) {
        this.assignClusters(pvs);
        this.clustersReady = true;
      }
      pvs.update(camPos);
      // 装载期归属判定可能比最终几何更早（有的块先在占位几何/空 buffer 上采样，合并完成后再换
      // geometry）——这样的块会一直 `clusterIds = []` 被判成「不属于任何房间」而不画
      // （surf_666 的 `s1_window1` 玻璃窗就是这样被剔掉的）。这里做**有限次**补算：
      // 每帧最多 8 块、每块最多 4 次，几何换了（uuid 变）就重算；仍为空说明它确实不在房间里。
      let retried = 0;
      for (const item of this.items) {
        if (retried >= 8) break;
        if (item.clusterIds.length > 0) continue;
        if (item.clusterGeom === undefined) {
          // 首次进 update 时补齐 uuid（assignClusters 已写过的不受影响）
          item.clusterGeom = (item.mesh.geometry as THREE.BufferGeometry | undefined)?.uuid ?? '';
          continue;
        }
        const tries = item.clusterTries ?? 0;
        // 不比较 uuid：几何可能是同一个 buffer 被原地重写（合并/透明面重排都会改写顶点），
        // 也有的块在 group 变换稳定前就被采样。用「次数上限」兜底即可。
        if (tries >= 4) continue;
        item.clusterTries = tries + 1;
        retried++;
        this.assignClusters(pvs, item, true);
      }
    }
    // 相机**当前所在 leaf** 的 cluster。贴墙、站在栏杆/斜坡里、出生点嵌在地板里时相机点会落进
    // 固体 leaf 得到 -1：先用 `getClusterNear` 在 24/72 HU 的 6 个方向上找最近的房间（玩家半宽量级）；
    // 仍找不到才沿用上一次有效 cluster。**不能**整帧关掉 PVS——那样一贴墙就把 1000+ 块全画出来
    // （surf_666 实测 44 → 1076 块 / 320 → 151fps）；也不能直接拿上一个房间的 PVS 行剔块，
    // 那个房间可能在地图另一端（实测 P1 机位 current=8069、真所在 6918 ⇒ 一次丢了 4 个块、画面露天空）。
    const camDirectCluster = pvsActive && pvs ? pvs.getClusterAt(camPos) : -1;
    const camLeafCluster =
      camDirectCluster >= 0 ? camDirectCluster : pvsActive && pvs && pvs.getClusterNear ? pvs.getClusterNear(camPos) : camDirectCluster;
    // 只用**真正定位到的房间**。不要退回 `pvs.currentClusterId`：`update(pos)` 在相机点落进
    // 固体 leaf 时会保留上一个房间的可见集（穿墙瞬移不闪变），那个房间可能在地图另一端——
    // 按它的 PVS 行剔块，就会把眼前真实可见的块整片剔掉（2026-11-13 冰坡消失现场：
    // clusterAtCamera = -1、current = 旧房间，可见集只有 6 个 cluster ⇒ 画面几乎全空）。
    // 定位到了但 `update(pos)` 走的是固体分支时，把可见集**切到**这个邻近房间再判。
    // 判定门槛用**直接**定位结果：`camDirectCluster < 0` 表示相机点本身在固体 leaf 里（穿墙）。
    // Source 的对应行为是「leaf 0 没有 PVS，引擎整帧不做可见性剔除」；这里照此处理——若改用
    // `getClusterNear` 找到的隔壁房间来剔，隔墙看过去真实可见的面会被整片/按三角形剔掉
    // （用户报的「穿透状态下几何缺失」）。`camLeafCluster` 保留给日志与诊断。
    const cullAll = (globalThis as { __vbspPvsCullAll?: boolean }).__vbspPvsCullAll === true;
    let pvsClusterValid = camDirectCluster >= 0;
    if (pvsClusterValid && pvs && pvs.updateToCluster) {
      if (!pvs.updateToCluster(camLeafCluster)) {
        // 该行数据缺失/全零（部分第三方编译器留空）：本帧 PVS 无从判定，退回不剔。
        pvsClusterValid = false;
      }
    }
    if (pvsActive && cullAll) {
      pvsClusterValid = true;
    }
    if (pvsActive && !pvsClusterValid && !this.pvsUnlocated) {
      // 相机点在实体里（穿墙）或在图外：这一帧 PVS 无从判定。
      // **这里不补任何距离剔除**——距离档一旦插手剔除，就必然出现「看得见却被距离吃掉」；
      // 宁可这一帧按「全画」慢下来（surf_666 1126 块 ≈ 151fps），等相机回到空间里立刻恢复。
      this.pvsUnlocated = true;
      console.warn('[pvs] 相机定位不到任何房间，本帧不做剔除（由 PVS 恢复后自动解除）');
    } else if (pvsClusterValid && this.pvsUnlocated) {
      this.pvsUnlocated = false;
    }
    // 两层同时生效，**距离场先判**：球外的块直接不画、也不再查 PVS（省掉这部分的 `isVisible`）；
    // 球内的块交给 PVS 的可见集决定。除此之外刻意**没有任何运行期兜底**——没有近场豁免、
    // 没有最近点/房间盒救援、没有「无 cluster 就画」、没有「近处全被剔就整帧退回」。
    // 块的 cluster 归属在装载期一次性算定（见 `assignClusters`），这样「看得见才画」才是可验证的单一语义。
    let nearTotal = 0;
    let nearVisible = 0;
    const reasons = { pvs: 0, distance: 0 };
    for (const item of this.items) {
      // 用**当前**几何的包围球刷新中心/半径：块在收集之后仍可能被替换几何（合并、光照注入、
      // 切贴图档都会换 geometry），旧包围球会把眼前的块判到很远。只做一次球心变换，无分配。
      const g = item.mesh.geometry as THREE.BufferGeometry | undefined;
      if (g) {
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = g.boundingSphere;
        if (bs) {
          item.center.copy(bs.center).applyMatrix4(item.mesh.matrixWorld);
          item.radius = bs.radius;
        }
        if (!g.boundingBox) g.computeBoundingBox();
        if (g.boundingBox) {
          if (!item.box) item.box = new THREE.Box3();
          item.box.copy(g.boundingBox).applyMatrix4(item.mesh.matrixWorld);
        }
      }
      const near = item.center.distanceToSquared(camPos) < 2000 * 2000;
      if (near) nearTotal++;
      const beyond = item.box
        ? isBeyondCullDistanceBox(item.box, camPos, this.cullDistance)
        : isBeyondCullDistance(item.center, camPos, this.cullDistance, item.radius);
      // 严格 PVS：块的 cluster 集合为空 ⇒ 它不在任何房间里（装到地图外壳外的重复道具、
      // 悬空装饰），没有任何 PVS 行会把它判为可见 ⇒ 不画。**不按距离兜底**，否则又回到
      // 「距离参与可见性」。距离场外的块连这次查询都不做。
      // 有逐三角形 cluster 表的块不按块判：它的 index 已按可见集裁好（见 cluster-filter.ts），
      // 块级再判一次会把「部分可见」的块整块剔掉 = 开洞。
      const triFiltered = this.chunkIndexActive && !!item.mesh.userData.clusterIndex;
      const parent = item.mesh.parent;
      const isDynamicMoved =
        parent !== null
        && typeof (parent.userData as { vbspDynamicEntityGroup?: unknown }).vbspDynamicEntityGroup === 'number'
        && (parent.position.x !== 0 || parent.position.y !== 0 || parent.position.z !== 0);
      let willCull = false;
      if (!beyond && pvsActive && cullAll) {
        willCull = true;
      } else if (!beyond && pvsActive && pvsClusterValid) {
        if (triFiltered) {
          const triClusters = (item.mesh.userData.clusterIndex as { clusters?: Uint16Array } | undefined)?.clusters;
          let anyVisible = item.clusterIds.some((c) => pvs!.isVisible(c));
          if (!anyVisible && triClusters) {
            for (let i = 0; i < triClusters.length; i++) {
              if (pvs!.isVisible(triClusters[i])) {
                anyVisible = true;
                break;
              }
            }
          }
          willCull = !anyVisible;
        } else if (isDynamicMoved) {
          // 动态实体离开出生位置后，装载期烘焙的 clusterIds 属于旧房间；改查当前世界中心
          // 所在 cluster，中心落进固体（-1）时放行，避免移动平台/门跨 PVS 门户消失。
          const liveCluster = pvs!.getClusterAt(item.center);
          willCull =
            liveCluster >= 0
            && !pvs!.isVisible(liveCluster)
            && !item.clusterIds.some((c) => pvs!.isVisible(c));
        } else {
          willCull = !item.clusterIds.some((c) => pvs!.isVisible(c));
        }
      }
      let level = LOD_NEAR;
      if (beyond) {
        level = LOD_FAR;
        culledByDistance++;
        reasons.distance++;
      } else if (willCull) {
        level = LOD_PVS_HIDDEN;
        culledByPvs++;
      } else {
        visible++;
        if (near) nearVisible++;
        reasons.pvs++;
      }
      // 逐三角形过滤的块还要看「有没有可见三角形」：`cluster-filter.ts` 只裁 PVS 不可见的面，
      // 距离场外的块仍必须整块不画（visible 只在 lodLevel===LOD_NEAR 时才可能为 true）。
      const triState = triFiltered
        ? ((item.mesh.userData as { clusterIndex?: { visTris: number } }).clusterIndex?.visTris ?? -1)
        : -1;
      if (item.mesh.userData.lodLevel !== level) {
        item.mesh.userData.lodLevel = level;
        item.mesh.visible = level === LOD_NEAR && (triState !== 0);
        changed = true;
      } else if (triFiltered) {
        // lodLevel 没变但可见三角形变了（相机换房间才发生，由 applyClusterIndex 写回）。
        item.mesh.visible = level === LOD_NEAR && triState !== 0;
      }
    }
    return {
      visible,
      culledByDistance,
      culledByPvs,
      cullDistance: this.cullDistance,
      pvsActive,
      changed,
      reasons,
      clusterAtCamera: pvsActive ? camLeafCluster : -1,
      pvsClusterValid: pvsActive && pvsClusterValid,
      cameraInSolid: pvsActive && camDirectCluster < 0,
    };
  }
}
