/**
 * Source `momentary_rot_button`（可旋转按钮 / 符文环）的旋转动画。
 *
 * 为什么需要：boreas 的符文盘是 5 个 `momentary_rot_button` brush 实体（内盘 `*1`
 * `distance -3600`/`speed 15`，外环 `*3` 带 3 根辐条 `*2/*4/*5`，`distance 3600`/`speed 25`），
 * 地图的 `logic_auto` 在 `OnMapSpawn` 给它们发 `SetPosition 1` ⇒ 开图就按 `speed`
 * 转到 `distance`（3600° = 10 圈，约 4 分钟）。导出侧（`convert.rs` 的 `bsp_models`）
 * 把旋转参数写进 GLB 节点 extras `vbsp_rot_button`，这里把它变成 three 的 pivot Group。
 *
 * 两个必须做对的点：
 * 1. 旋转中心是**实体 origin**，不是模型包围盒中心；子实体（`parentname`）要绕父的
 *    pivot 公转（`*2/*4/*5` 因此才形成「三根辐条跟着外环转」）。
 * 2. 合并块（`scene-optimizer.ts`）会把顶点烘焙到世界空间、丢掉模型身份，所以这些
 *    mesh 必须在合并前打上 `userData.vbspRot`，合并时按 `MergeOptions.exclude` 留下、
 *    再由本模块重新挂到 pivot 上。
 */

import * as THREE from 'three';

/** GLB 节点 extras `vbsp_rot_button` 的形状（对应 Rust `RotButtonExport`）。 */
export interface RotButtonMeta {
  /** 同一实体的唯一 id（导出侧按旋钮实体递增）。 */
  id: number;
  /** 旋转中心（`map_coords` 之后的世界坐标，three 轴序）。 */
  origin: [number, number, number];
  /** 角速度（度/秒）。 */
  speed: number;
  /** 开到位需要转过的角度（度），符号表示方向。 */
  distance: number;
  /** Source `spawnflags` 原值（位 32 = Use 打开、位 1 = Not solid）。 */
  spawnflags: number;
  targetname?: string;
  parentname?: string;
}

/** 打在所有子 mesh 上的 `userData` 键；合并器按它排除。 */
export const ROT_BUTTON_MESH_KEY = 'vbspRot';

/** 一只旋钮：pivot（挂到场景根）与当前角度（弧度，绕世界 Y）。 */
export interface RotButtonPivot {
  meta: RotButtonMeta;
  pivot: THREE.Group;
  /** 累计角度（弧度）。 */
  angle: number;
}

/**
 * 把 `vbsp_rot_button` 元数据从节点贴到它下面所有 mesh 的 `userData.vbspRot`。
 *
 * 必须在合并（`mergeIntoNewRoot` / `optimizeScene`）**之前**调用：合并后模型身份就没了。
 *
 * @returns 打标的 mesh 数。
 */
export function markRotButtons(root: THREE.Object3D): number {
  let marked = 0;
  root.traverse((obj) => {
    const meta = (obj.userData as { vbsp_rot_button?: RotButtonMeta }).vbsp_rot_button;
    if (!meta || typeof meta.id !== 'number') return;
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh.userData as Record<string, unknown>)[ROT_BUTTON_MESH_KEY]) return;
      (mesh.userData as Record<string, unknown>)[ROT_BUTTON_MESH_KEY] = meta;
      marked++;
    });
  });
  return marked;
}

/**
 * 把打过标的 mesh 从合并块里摘出来，按实体分组挂到各自的 pivot 上。
 *
 * 前提：这些 mesh 的几何已经被烘焙到世界空间、自身变换是单位阵（合并器的保留口径）。
 * 给出 `parentname` 的实体挂到父 pivot 下，局部位置 = 自身 origin − 父 origin，
 * 这样父 pivot 转动时子实体绕父公转，与 Source 的 `SetParent` 一致。
 *
 * @returns pivot 列表；没有旋钮实体时返回空数组。
 */
export function setupRotButtons(root: THREE.Object3D): RotButtonPivot[] {
  const byId = new Map<number, { meta: RotButtonMeta; meshes: THREE.Mesh[] }>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const meta = (mesh.userData as Record<string, unknown>)[ROT_BUTTON_MESH_KEY] as RotButtonMeta | undefined;
    if (!meta) return;
    let group = byId.get(meta.id);
    if (!group) {
      group = { meta, meshes: [] };
      byId.set(meta.id, group);
    }
    group.meshes.push(mesh);
  });
  if (byId.size === 0) return [];

  const pivots = new Map<number, THREE.Group>();
  for (const [id, group] of byId) {
    const pivot = new THREE.Group();
    pivot.name = `rot-button:${id}`;
    // 标记：载图后的「静态矩阵冻结」要放过这些 pivot（它们每帧改 rotation）。
    pivot.userData.vbspRotPivot = true;
    // 世界坐标 pivot：mesh 几何已在世界空间，把 mesh 反向平移，视觉位置不动。
    const [x, y, z] = group.meta.origin;
    pivot.position.set(x, y, z);
    pivots.set(id, pivot);
  }

  const result: RotButtonPivot[] = [];
  for (const [id, group] of byId) {
    const pivot = pivots.get(id);
    if (!pivot) continue;
    const parentMeta = group.meta.parentname
      ? [...byId.values()].find((candidate) => candidate.meta.targetname === group.meta.parentname)?.meta
      : undefined;
    if (parentMeta) {
      const parentPivot = pivots.get(parentMeta.id);
      if (parentPivot) {
        // 子实体绕父 pivot 公转：局部位置 = 自身世界 origin − 父世界 origin。
        pivot.position.set(
          group.meta.origin[0] - parentMeta.origin[0],
          group.meta.origin[1] - parentMeta.origin[1],
          group.meta.origin[2] - parentMeta.origin[2],
        );
        parentPivot.add(pivot);
      }
    }
    // mesh 已经烘焙到世界空间：抵消 pivot 的平移，使 pivot 旋转时 mesh 绕 pivot 转。
    for (const mesh of group.meshes) {
      mesh.position.set(-group.meta.origin[0], -group.meta.origin[1], -group.meta.origin[2]);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.updateMatrix();
      pivot.add(mesh);
    }
    result.push({
      meta: group.meta,
      pivot,
      // 从 0 开始：Source `SetPosition 1` 的动作就是把 0 → distance 转一遍。
      angle: 0,
    });
  }

  // 只把「没有父 pivot」的根挂进场景（子 pivot 已经在父下面）。
  for (const entry of result) {
    if (entry.pivot.parent) continue;
    root.add(entry.pivot);
  }

  return result;
}

/**
 * 每帧推进旋钮角度。
 *
 * 口径（pcf-scout 取证 `.tmp/pcf/ROT_LASER_SEMANTICS.md`）：`distance` 是**度**、`speed` 是度/秒，
 * `SetPosition 1` 让旋钮从 0 走到 `distance`；本图 `distance` 恒为 ±3600°（整 10 圈），到点后
 * `OnFullyClosed` 立刻 `SetPositionImmediately 0` + `SetPosition 1` ⇒ **无缝无限循环**。
 * 落到渲染上就是匀速自转（speed 15 ⇒ 24s/圈，25 ⇒ 14.4s/圈，负 distance 反向），
 * 所以这里直接按角速度累加并对 2π 取模，不做「到点停住」。
 */
export function updateRotButtons(buttons: readonly RotButtonPivot[], dt: number): void {
  if (!(dt > 0)) return;
  for (const entry of buttons) {
    const { speed, distance } = entry.meta;
    if (!speed || !distance) continue;
    const step = speed * (Math.PI / 180) * dt * (distance < 0 ? -1 : 1);
    const next = (entry.angle + step) % (Math.PI * 2);
    entry.angle = next;
    entry.pivot.rotation.y = next;
  }
}
