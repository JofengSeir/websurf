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
import { parseEntityIoBlocks } from './particles.js';

/** mesh 上的标记：值 = 实体下标（与 `vbsp_entity_index` 同口径）。 */
export const DYNAMIC_ENTITY_MESH_KEY = 'vbspDynamicEntity';

/** 实体组上的标记：值 = 实体下标。静态矩阵冻结按它豁免整棵子树。 */
export const DYNAMIC_ENTITY_GROUP_KEY = 'vbspDynamicEntityGroup';

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
export function parseDynamicEntityIndices(entityIoJson?: string | null): Set<number> {
  const indices = new Set<number>();
  const blocks = parseEntityIoBlocks(entityIoJson);
  for (let index = 0; index < blocks.length; index++) {
    const record = blocks[index];
    const classname = record.classname;
    if (typeof classname === 'string' && NEVER_DYNAMIC_CLASSNAMES.has(classname)) continue;
    const parentname = record.parentname;
    const hasParent = typeof parentname === 'string' && parentname.trim() !== '';
    if (hasParent || (typeof classname === 'string' && DYNAMIC_ENTITY_CLASSNAMES.has(classname))) {
      indices.add(index);
    }
  }
  return indices;
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
    userData[DYNAMIC_ENTITY_MESH_KEY] = entityIndex;
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
  for (const [entityIndex, meshes] of meshesByEntity) {
    const group = new THREE.Group();
    group.name = `vbsp_dyn_ent_${entityIndex}`;
    // 标记：静态矩阵冻结必须放过这棵子树，否则运行期改 group.position 不会生效。
    (group.userData as Record<string, unknown>)[DYNAMIC_ENTITY_GROUP_KEY] = entityIndex;
    for (const mesh of meshes) group.add(mesh);
    root.add(group);
    groups.set(entityIndex, group);
  }
  return groups;
}
