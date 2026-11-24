/**
 * 可交互机关（`+use`）高亮与「按钮 → 连锁实体」连线可视化（debug 端）。
 *
 * 为什么需要：
 * - 地图里能按的按钮/门在画面上跟普通 brush 长得一样，玩家不知道哪里能按（F 键选靶
 *   在实体层只按体积判命中，没有任何提示）；
 * - 实体 I/O 是一张图（按钮 OnPressed → math_counter Add → OnHitMax → 碎墙 Break + 门
 *   Close + maker ForceSpawn），只看代码/聊天很难回答「按下去会发生什么、哪些东西是关联的」。
 *
 * 本模块只读运行时数据（`Entity.classChain` / `Entity.volumes` / `Entity.outputs`），
 * 不改实体与物理状态；画的是 Three.js 线框与连线，挂在场景根上，随相机远近实时更新。
 *
 * 显示规则：
 * 1. 玩家 NEAR_RANGE 内、类链实现了 `use` 的实体 → 青色脉冲线框；
 * 2. 视线命中的那个（与 F 键同一选靶结果）→ 黄色线框；
 * 3. 按 F 后：从被按实体沿 outputs 展开 2 层目标 → 绿色线框 + 连线，保持 6.5 秒淡出。
 */
import * as THREE from 'three';
import type { Entity } from '../../../../src/ts-shared/entity/base-entity.js';
import type { EntitySystem } from '../../../../src/ts-shared/entity/entity-system.js';
import type { EntityBrushVolume } from '../../../../src/ts-shared/entity/types.js';

/** 附近可交互实体的显示半径（HU）。 */
const NEAR_RANGE = 900;
/** 最多同时画多少个附近实体（防止大图刷屏/掉帧）。 */
const MAX_NEAR = 48;
/** 连锁连线的保持时间（毫秒）。 */
const CHAIN_HOLD_MS = 6500;
/** 连锁展开深度（按钮 → counter → 碎墙/门 恰好 2 层）。 */
const CHAIN_DEPTH = 2;
/** 同时最多画多少条连线。 */
const MAX_CHAIN_LINES = 96;
/** 内部重算间隔（毫秒）：高亮不需要每帧重算，减少实体遍历与几何重建。 */
const UPDATE_INTERVAL_MS = 90;

const COLOR_NEAR: readonly [number, number, number] = [0.25, 0.85, 1.0];
const COLOR_LOOK: readonly [number, number, number] = [1.0, 0.82, 0.2];
const COLOR_CHAIN: readonly [number, number, number] = [0.35, 1.0, 0.45];
const COLOR_ROOT: readonly [number, number, number] = [1.0, 0.55, 0.95];

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
}

interface ChainEdge {
  from: number;
  to: number;
  depth: number;
}

function entityBounds(entity: Entity): Bounds | null {
  const volumes = entity.volumes as EntityBrushVolume[];
  if (volumes.length === 0) {
    // 无 brush 体积的实体（math_counter / prop_dynamic / env_entity_maker 等）也要能画框、
    // 画连线端点：用 origin 给一个小方块（16HU 半边长），说明「这里有实体」。
    const origin = entity.origin;
    if (!origin) return null;
    const min: [number, number, number] = [origin[0] - 16, origin[1] - 16, origin[2] - 16];
    const max: [number, number, number] = [origin[0] + 16, origin[1] + 16, origin[2] + 16];
    return { min, max, center: [origin[0], origin[1], origin[2]] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of volumes) {
    for (let i = 0; i < 3; i++) {
      if (v.mins[i] < min[i]) min[i] = v.mins[i];
      if (v.maxs[i] > max[i]) max[i] = v.maxs[i];
    }
  }
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/** 12 条棱（24 个顶点）追加进 positions/colors。 */
function pushBox(
  positions: number[],
  colors: number[],
  bounds: Bounds,
  color: readonly [number, number, number],
): void {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const c = [color[0], color[1], color[2]];
  const corners: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [a, b] of edges) {
    positions.push(...corners[a], ...corners[b]);
    colors.push(...c, ...c);
  }
}

function isUseEntity(entity: Entity): boolean {
  return entity.classChain.some((cls) => typeof cls.use === 'function');
}

export class InteractVisualizer {
  private root: THREE.Group | null = null;
  private boxLines: THREE.LineSegments | null = null;
  private chainLines: THREE.LineSegments | null = null;
  private chainRootIndex: number | null = null;
  private chainEdges: ChainEdge[] = [];
  private chainUntil = 0;
  private lastUpdate = 0;
  private active = false;

  /** 挂到场景根（`renderer-main.loadScene` 时调用；同一实例换图前先 `dispose()`）。 */
  attach(sceneRoot: THREE.Object3D): void {
    this.dispose();
    const group = new THREE.Group();
    group.name = 'vbsp-interact-visualizer';
    group.renderOrder = 10;
    const boxGeom = new THREE.BufferGeometry();
    boxGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    boxGeom.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    this.boxLines = new THREE.LineSegments(
      boxGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    this.boxLines.frustumCulled = false;
    this.boxLines.renderOrder = 10;
    const chainGeom = new THREE.BufferGeometry();
    chainGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    chainGeom.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    this.chainLines = new THREE.LineSegments(
      chainGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    );
    this.chainLines.frustumCulled = false;
    this.chainLines.renderOrder = 11;
    group.add(this.boxLines);
    group.add(this.chainLines);
    sceneRoot.add(group);
    this.root = group;
    this.lastUpdate = 0;
    this.active = false;
  }

  dispose(): void {
    if (this.boxLines) {
      this.boxLines.geometry.dispose();
      (this.boxLines.material as THREE.Material).dispose();
      this.boxLines = null;
    }
    if (this.chainLines) {
      this.chainLines.geometry.dispose();
      (this.chainLines.material as THREE.Material).dispose();
      this.chainLines = null;
    }
    if (this.root) {
      this.root.parent?.remove(this.root);
      this.root = null;
    }
    this.chainRootIndex = null;
    this.chainEdges = [];
    this.chainUntil = 0;
    this.active = false;
  }

  /** 按 F 触发后调用：记录被按实体并展开 outputs 连锁（2 层）。 */
  showChain(entityIndex: number, system: EntitySystem | null): void {
    if (!system || entityIndex < 0) return;
    const rootEntity = system.getEntity(entityIndex);
    if (!rootEntity) return;
    this.chainRootIndex = entityIndex;
    this.chainEdges = this.collectChainEdges(rootEntity, system);
    this.chainUntil = performance.now() + CHAIN_HOLD_MS;
  }

  /** 连锁展开：按 targetname 解析 outputs 目标（与实体 I/O 同一份 EntityList 解析规则）。 */
  private collectChainEdges(rootEntity: Entity, system: EntitySystem): ChainEdge[] {
    const edges: ChainEdge[] = [];
    const seen = new Set<number>([rootEntity.index]);
    let frontier: Entity[] = [rootEntity];
    for (let depth = 1; depth <= CHAIN_DEPTH && frontier.length > 0; depth++) {
      const next: Entity[] = [];
      for (const source of frontier) {
        for (const output of source.outputs.values()) {
          for (const action of output.getActionList()) {
            const targetName = action.target;
            if (!targetName || targetName.startsWith('!')) continue;
            const matches = this.resolveTargets(system, targetName);
            for (const target of matches) {
              if (target.index === source.index || seen.has(target.index)) continue;
              seen.add(target.index);
              next.push(target);
              edges.push({ from: source.index, to: target.index, depth });
              if (edges.length >= MAX_CHAIN_LINES) return edges;
            }
          }
        }
      }
      frontier = next;
    }
    return edges;
  }

  private resolveTargets(system: EntitySystem, name: string): Entity[] {
    const out: Entity[] = [];
    let cur: Entity | null = null;
    for (let guard = 0; guard < 64; guard++) {
      const found = system.entList.findEntityByName(cur, name, null, null, null);
      if (!found) break;
      // 不按 volumes 过滤：按钮的目标大多是 math_counter / prop_dynamic / env_entity_maker
      // 这类没有 brush 体积的实体，过滤掉会让连线永远为空（实测按钮有 4 条 OnPressed 连接、
      // 但 chainEdges 为 0）。
      out.push(found);
      cur = found;
    }
    return out;
  }

  /**
   * 每个渲染帧（内部限流到 ~90ms 一次）刷新线框与连线。
   *
   * @param pickIndex `EntityGameplay.pickUseFromView` 的视线选靶结果（-1 = 没指到），
   *                  与 F 键同一规则，保证「看到黄色 = 按 F 会触发它」。
   * @returns 是否仍有可视化内容在显示（宿主据此按需渲染）。
   */
  update(camera: THREE.PerspectiveCamera, system: EntitySystem | null, pickIndex: number, now: number): boolean {
    if (!this.root || !this.boxLines || !this.chainLines) return false;
    if (!system) {
      this.setGeometry(this.boxLines, [], []);
      this.setGeometry(this.chainLines, [], []);
      this.active = false;
      return false;
    }
    const chainActive = this.chainUntil > now && this.chainRootIndex !== null;
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return this.active || chainActive;
    this.lastUpdate = now;
    if (!chainActive) {
      this.chainRootIndex = null;
      this.chainEdges = [];
    }

    const camPos = camera.position;
    const near: Array<{ entity: Entity; bounds: Bounds; distance: number }> = [];
    const chainTargets = new Set<number>();
    const byIndex = new Map<number, Entity>();
    for (const entity of system.entList.entities) {
      if (entity.disabled || !isUseEntity(entity)) continue;
      byIndex.set(entity.index, entity);
      const bounds = entityBounds(entity);
      if (!bounds) continue;
      const dx = bounds.center[0] - camPos.x;
      const dy = bounds.center[1] - camPos.y;
      const dz = bounds.center[2] - camPos.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance - 64 <= NEAR_RANGE) near.push({ entity, bounds, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    if (near.length > MAX_NEAR) near.length = MAX_NEAR;

    // 连锁目标可能需要画框，但不在附近列表里 → 单独收集。
    for (const edge of this.chainEdges) chainTargets.add(edge.to);

    const boxPos: number[] = [];
    const boxColors: number[] = [];
    for (let i = 0; i < near.length; i++) {
      const { entity, bounds } = near[i];
      const color =
        entity.index === pickIndex ? COLOR_LOOK
        : chainTargets.has(entity.index) ? COLOR_CHAIN
        : entity.index === this.chainRootIndex ? COLOR_ROOT
        : COLOR_NEAR;
      pushBox(boxPos, boxColors, bounds, color);
    }
    // 连锁目标若是「非 use 实体」（counter/maker/门），near 列表里没有 → 补画绿框。
    for (const targetIndex of chainTargets) {
      if (near.some((n) => n.entity.index === targetIndex)) continue;
      const target = byIndex.get(targetIndex) ?? system.getEntity(targetIndex);
      if (!target) continue;
      const bounds = entityBounds(target);
      if (bounds) pushBox(boxPos, boxColors, bounds, COLOR_CHAIN);
    }
    this.setGeometry(this.boxLines, boxPos, boxColors);

    const linePos: number[] = [];
    const lineColors: number[] = [];
    if (chainActive) {
      const boundsByIndex = new Map<number, Bounds | null>();
      const boundsOf = (index: number): Bounds | null => {
        if (!boundsByIndex.has(index)) {
          const target = system.getEntity(index);
          boundsByIndex.set(index, target ? entityBounds(target) : null);
        }
        return boundsByIndex.get(index) ?? null;
      };
      for (const edge of this.chainEdges) {
        const from = boundsOf(edge.from);
        const to = boundsOf(edge.to);
        if (!from || !to) continue;
        linePos.push(...from.center, ...to.center);
        const color = edge.depth === 1 ? COLOR_LOOK : COLOR_CHAIN;
        lineColors.push(...color, ...color);
      }
    }
    this.setGeometry(this.chainLines, linePos, lineColors);

    this.active = boxPos.length > 0 || linePos.length > 0;
    this.root.visible = this.active;
    return this.active;
  }

  private setGeometry(lines: THREE.LineSegments, positions: number[], colors: number[]): void {
    const geom = lines.geometry;
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.computeBoundingSphere();
  }
}
