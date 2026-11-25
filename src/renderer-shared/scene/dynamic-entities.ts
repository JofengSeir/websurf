/**
 * 动态 brush 实体脱离静态合并（T-P1-5a 阶段 1）。
 *
 * 为什么需要：`func_door` / `func_movelinear` / `func_brush` 这类实体会在运行期显隐、
 * 平移或旋转，但旧管线把它们和世界几何一起烘焙进了静态 VBO 大块：
 * 1. 平移只能逐顶点改写合并缓冲并整块重传 GPU（`brush-entity-visibility.ts`）；
 * 2. 合并块从不更新 `boundingBox/boundingSphere`，实体移出原视锥就会凭空消失；
 * 3. 与 PVS 逐三角形索引重写互踩。
 *
 * 做法与 `momentary_rot_button`（`rot-buttons.ts`）同构：合并**之前**给实体下的 mesh
 * 打 `userData.vbspDynamicEntity = entityIndex`，`MergeOptions.exclude` 把它们留下
 * （几何烘焙到世界空间、局部变换清单位阵），合并**之后**按实体下标收进独立
 * `THREE.Group`。阶段 1 只搭骨架，默认关闭（`__vbspDynamicEntityGroups === true` 才启用）；
 * 阶段 2（T-P1-5b）再让 `BrushEntityVisibility` 消费这些组并切默认。
 *
 * 实体下标口径与导出侧一致：`bsp.entities.iter().enumerate()`（0 起、按 entities_text
 * 书写顺序），即 `parseEntityIoBlocks()` 的块序号，也是 GLB 节点 extras
 * `vbsp_entity_index` / 节点名 `brush_<idx>` 的同一个下标。
 */

import * as THREE from 'three';
import { resolveEntityBlocks, type EntityBlockRecords } from './particles.js';

/** mesh 上的标记：值 = 实体下标（与 `vbsp_entity_index` 同口径）。 */
export const DYNAMIC_ENTITY_MESH_KEY = 'vbspDynamicEntity';

/** 实体组上的标记：值 = 实体下标。静态矩阵冻结按它豁免整棵子树。 */
export const DYNAMIC_ENTITY_GROUP_KEY = 'vbspDynamicEntityGroup';

/** mesh 上的枢轴标记：值 = 实体 BSP origin 的世界坐标（Y-up，three 轴序）。 */
export const DYNAMIC_ENTITY_PIVOT_KEY = 'vbspDynamicEntityPivot';

/** 动态实体组的一次放置：组位置 = 枢轴，组内 mesh 局部偏移 = 原世界位置 − 枢轴。 */
export interface DynamicEntityGroupPlacement {
  /** 组 `position`（世界坐标 = 实体 origin，旋转围绕它进行）。 */
  readonly position: [number, number, number];
  /** 组内 mesh 的局部 `position`（未旋转时与组位置相加仍等于原来的世界坐标）。 */
  readonly meshOffset: [number, number, number];
}

function finiteComponent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 计算「组 = 枢轴、mesh = 原世界坐标 − 枢轴」的放置（纯函数，供单测锁住零变化不变量）。
 *
 * 入参必须是 **mesh 当时的世界坐标**，不是它的局部 `position`：合并路径里
 * `scene-optimizer` 的 exclude 分支已把顶点烘焙到世界空间、把 mesh 局部变换清零（世界坐标 = 0），
 * 而未合并路径（`render-session.ts` 的 `merge === false`）里子 mesh 的世界坐标 = 实体 origin。
 * 两种路径都用「世界坐标 − 枢轴」才能让 `组位置 + mesh 偏移 === 原世界坐标`，即
 * **rest 姿态世界坐标逐分量不变**（像素一致）；用局部位置会在多 primitive 的未合并场景上
 * 少算一次父链平移。
 */
export function dynamicEntityGroupPlacement(
  pivot?: readonly number[] | null,
  meshWorldPosition?: readonly number[] | null,
): DynamicEntityGroupPlacement {
  const px = finiteComponent(pivot?.[0]);
  const py = finiteComponent(pivot?.[1]);
  const pz = finiteComponent(pivot?.[2]);
  return {
    position: [px, py, pz],
    meshOffset: [
      finiteComponent(meshWorldPosition?.[0]) - px,
      finiteComponent(meshWorldPosition?.[1]) - py,
      finiteComponent(meshWorldPosition?.[2]) - pz,
    ],
  };
}

/**
 * 运行期可能显隐 / 平移 / 旋转的 brush 实体类。
 *
 * **不要**把 `func_detail` / `worldspawn` 放进来：它们是静态几何的主体，排除出合并
 * 会让 draw call 暴涨（每只 func_detail mesh 都变成独立 draw）。
 */
/** 静态主体：即使带 `parentname` 也绝不脱合并（`func_detail` 是几何大头，世界根更不用说）。 */
const NEVER_DYNAMIC_CLASSNAMES: ReadonlySet<string> = new Set(['func_detail', 'worldspawn']);

const DYNAMIC_ENTITY_CLASSNAMES: ReadonlySet<string> = new Set([
  'func_door',
  'func_door_rotating',
  'func_movelinear',
  'func_wall_toggle',
  'func_brush',
  'func_rotating',
  'func_tracktrain',
  'func_water_analog',
  'func_breakable',
]);

/**
 * 从实体 IO 原文筛出需要脱离静态合并的实体下标。
 *
 * 判据：classname 在白名单里，**或**带非空 `parentname`（`prop_dynamic` 这类挂父实体，
 * 父实体移动时必须跟着动）。无 `entityIoJson`（viewer 端）/ JSON 非法 / 空文本时返回
 * 空 Set —— 全部走静态合并，与旧行为一致，不报错。
 */
export function parseDynamicEntityIndices(
  entityIoJsonOrBlocks?: string | EntityBlockRecords | null,
): Set<number> {
  const indices = new Set<number>();
  const blocks = resolveEntityBlocks(entityIoJsonOrBlocks);
  for (let index = 0; index < blocks.length; index++) {
    const record = blocks[index];
    const classname = typeof record.classname === 'string' ? record.classname.trim().toLowerCase() : '';
    if (NEVER_DYNAMIC_CLASSNAMES.has(classname)) continue;
    const parentname = record.parentname;
    const hasParent = typeof parentname === 'string' && parentname.trim() !== '';
    if (hasParent || DYNAMIC_ENTITY_CLASSNAMES.has(classname)) {
      indices.add(index);
    }
  }
  return indices;
}

/** 读 mesh 上记录的枢轴（`markDynamicEntities()` 写入；没有则回落原点）。 */
function pivotOf(mesh: THREE.Mesh | undefined): [number, number, number] {
  const raw = mesh?.userData?.[DYNAMIC_ENTITY_PIVOT_KEY];
  if (!Array.isArray(raw) || raw.length < 3) return [0, 0, 0];
  return [finiteComponent(raw[0]), finiteComponent(raw[1]), finiteComponent(raw[2])];
}

/**
 * 沿父链找 mesh 所属的 brush 实体节点（`vbsp_model` 只在实体节点上，`tagBrushEntityOwners()`
 * 不会往下复制），并核对实体下标，避免多 primitive 时错拿到父实体的原点。
 */
function findBrushEntityNode(mesh: THREE.Object3D, entityIndex: number): THREE.Object3D | null {
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    const userData = node.userData as Record<string, unknown>;
    if (userData.vbsp_entity_index !== entityIndex) continue;
    if (typeof userData.vbsp_model === 'string' && userData.vbsp_model !== '') return node;
  }
  return null;
}

/**
 * 给动态实体下的 mesh 打标，必须在合并**之前**调用（合并后模型身份就没了）。
 *
 * 已经被 `rot-buttons.ts` 打上 `userData.vbspRot` 的 mesh 跳过：旋钮实体走自己的 pivot
 * 路径，两者不能同时接管同一只 mesh。重复调用幂等。
 *
 * @returns 本次新打标的 mesh 数。
 */
export function markDynamicEntities(
  root: THREE.Object3D,
  dynamicEntityIndices: ReadonlySet<number>,
): number {
  if (dynamicEntityIndices.size === 0) return 0;
  let marked = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const userData = mesh.userData as Record<string, unknown>;
    if (userData.vbspRot) return;
    const entityIndex = userData.vbsp_entity_index;
    if (typeof entityIndex !== 'number' || !dynamicEntityIndices.has(entityIndex)) return;
    if (typeof userData[DYNAMIC_ENTITY_MESH_KEY] === 'number') return;
    // 枢轴 = 实体节点（GLB 里 `brush_<下标>`，其 translation 就是 BSP origin）的世界坐标。
    // 必须在合并前记录：合并会把顶点烘焙到世界空间并清掉节点变换（见 scene-optimizer 的
    // exclude 分支），之后再也拿不回 origin。找不到实体节点（无 vbsp_model 的 props 等）
    // 时回落 (0,0,0)，与旧行为一致。
    const entityNode = findBrushEntityNode(mesh, entityIndex);
    const pivot = entityNode ? entityNode.getWorldPosition(new THREE.Vector3()) : null;
    userData[DYNAMIC_ENTITY_MESH_KEY] = entityIndex;
    userData[DYNAMIC_ENTITY_PIVOT_KEY] = pivot ? [pivot.x, pivot.y, pivot.z] : [0, 0, 0];
    marked++;
  });
  return marked;
}

/** 该节点是否被 `markDynamicEntities()` 标成动态实体 mesh（供 `MergeOptions.exclude` 用）。 */
export function isDynamicEntityNode(obj: THREE.Object3D): boolean {
  return typeof (obj.userData as Record<string, unknown>)[DYNAMIC_ENTITY_MESH_KEY] === 'number';
}

/**
 * 把打过标的 mesh 按实体下标收进独立 `THREE.Group`，返回「实体下标 → 组」。
 *
 * 前提：这些 mesh 已被合并器保留（几何烘焙到世界空间、局部变换单位阵 —— 见
 * `MergeOptions.exclude`）。因此组挂在父节点原点即可：`group.position.set(dx, dy, dz)`
 * 就是相对烘焙基准的平移，不需要逐顶点重写。组挂到传入的 root 下，原网格从旧父节点
 * 摘除；没有可标记 mesh 时返回空 Map。
 */
export function collectDynamicEntityGroups(root: THREE.Object3D): Map<number, THREE.Group> {
  const meshesByEntity = new Map<number, THREE.Mesh[]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const entityIndex = (mesh.userData as Record<string, unknown>)[DYNAMIC_ENTITY_MESH_KEY];
    if (typeof entityIndex !== 'number') return;
    const list = meshesByEntity.get(entityIndex);
    if (list) list.push(mesh);
    else meshesByEntity.set(entityIndex, [mesh]);
  });

  const groups = new Map<number, THREE.Group>();
  // 世界坐标要现取：合并路径下 mesh 已被清成单位变换，未合并路径下还要算上父链平移。
  root.updateMatrixWorld(true);
  const world = new THREE.Vector3();
  for (const [entityIndex, meshes] of meshesByEntity) {
    const group = new THREE.Group();
    group.name = `vbsp_dyn_ent_${entityIndex}`;
    // 标记：静态矩阵冻结必须放过这棵子树，否则运行期改 group.position / rotation 不会生效。
    (group.userData as Record<string, unknown>)[DYNAMIC_ENTITY_GROUP_KEY] = entityIndex;
    const pivot = pivotOf(meshes[0]);
    const placement = dynamicEntityGroupPlacement(pivot);
    group.position.set(placement.position[0], placement.position[1], placement.position[2]);
    for (const mesh of meshes) {
      // 世界坐标必须在 reparent 前取（挂进组之后父链就变了）。合并路径下它是 0（顶点已世界
      // 烘焙），未合并路径下它是实体 origin + 局部偏移 —— 两种情况都由「世界坐标 − 枢轴」覆盖。
      mesh.getWorldPosition(world);
      const offset = dynamicEntityGroupPlacement(pivot, [world.x, world.y, world.z]).meshOffset;
      mesh.position.set(offset[0], offset[1], offset[2]);
      group.add(mesh);
    }
    root.add(group);
    groups.set(entityIndex, group);
  }
  return groups;
}
