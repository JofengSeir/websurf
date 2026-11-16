/**
 * 水面 mesh 归并（task-28）。
 *
 * 为什么需要：`scene-optimizer.ts` 的分块合并按 `OPT_TRANS_CELL_DIV` 把半透明图元单独分块，
 * 结果是水面被切成 160 个「每块 2 个材质槽（`*_beneath` + 水面）」的小 chunk —— 位置连续、
 * 材质等价，却要 ~320 个 draw call。尾段主遍 ~半数是这些水面 draw（Lead 实测每一项 ≈5µs）。
 *
 * 做法：在 `mergeMain()` 之后、`applyWaterShaders()` 之前，把所有「每个材质槽都带
 * `userData.vbsp_water`」的 mesh 按 **世界高度层（8 HU 一档）× 材质签名** 分组，几何按
 * `matrixWorld` 烘到世界坐标后**按槽序号分别**归并，再按槽顺序写回 `geometry.groups`：
 * 每个（高度层 × 签名）只剩 1 个 mesh，材质沿用**共享实例**（不 clone，水面 shader / 镜面
 * 驱动注入因此不受影响）。
 *
 * 为什么必须先于 `applyWaterShaders()`：水面着色器是「遍历 mesh → 逐材质槽注入」的，
 * 归并后再注入才只做一次（镜面驱动也从 160 个 mesh 降到 1~2 个）。
 *
 * 为什么不能更早（在 `applyLightmap()` 之前）：水材质在 lightmap 阶段才被收敛成
 * `MeshBasicMaterial` 并写入灯图 UV（`uv1`），提前归并会丢属性。
 *
 * A/B 开关：`globalThis.__vbspWaterMergeOff === true` 直接返回 null（整步跳过，供同机位对照）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SKY_LAYER } from '../environment/miniature-sky.js';

/** 高度层厚度（世界单位）：水面全部落在同一个 8 HU 桶里时归并成 1 个 mesh。 */
const HEIGHT_BUCKET_HU = 8;

export interface WaterMergeStats {
  /** 尝试归并的组数（成员 ≥2 且全部成员通过预检）。 */
  groups: number;
  /** 实际新建的归并 mesh 数。 */
  mergedMeshes: number;
  /** 被移除（其几何已 dispose）的原 mesh 数。 */
  removedMeshes: number;
}

interface WaterMeshEntry {
  mesh: THREE.Mesh;
  materials: THREE.Material[];
  parent: THREE.Object3D;
  /** 世界高度层 */
  layer: number;
  /** 材质槽签名（含 `userData.vbsp_water` 的稳定序列化） */
  signature: string;
}

/** 不改变渲染语义的稳定序列化：对象按键名排序，数组按原顺序。 */
function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** 材质槽里会影响水面观感的全部字段 + `vbsp_water` 参数。 */
function materialSignature(material: THREE.Material): string {
  const m = material as THREE.MeshBasicMaterial;
  return [
    material.type,
    m.map?.uuid ?? '-',
    m.color?.getHexString() ?? '-',
    m.opacity,
    m.alphaTest,
    m.blending,
    m.side,
    m.depthWrite,
    m.depthTest,
    stableSerialize((material.userData as { vbsp_water?: unknown } | undefined)?.vbsp_water),
  ].join('|');
}

function isWaterMaterial(material: THREE.Material | null | undefined): boolean {
  return !!(material && (material.userData as { vbsp_water?: unknown } | undefined)?.vbsp_water != null);
}

/** 所有槽都是水才算水面 mesh（普通半透明/加色/天空不碰）。 */
function waterMaterialsOf(mesh: THREE.Mesh): THREE.Material[] | null {
  const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!arr.length) return null;
  if (!arr.every((m) => m && isWaterMaterial(m))) return null;
  if (mesh.layers.isEnabled(SKY_LAYER)) return null;
  return arr as THREE.Material[];
}

function worldHeightOf(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const center = (geometry.boundingSphere?.center ?? new THREE.Vector3()).clone().applyMatrix4(mesh.matrixWorld);
  return center.y;
}

/**
 * 从烘到世界坐标的几何里拆出「某个材质槽」的三角形：
 * - 有索引几何：把该槽全部 group 的索引按顺序拼成新的 Uint32 索引，属性表整体沿用
 *   （未被引用的顶点留在 attribute 里不参与 draw，`mergeGeometries` 会保留它们，顶点数多几百个可忽略）；
 * - **无索引几何**（水面 chunk 就是这种：`groups` 的 start/count 直接是顶点区间）：
 *   逐属性按顶点区间切出并重建为无索引几何。
 */
function extractSlotGeometry(baked: THREE.BufferGeometry, slot: number): THREE.BufferGeometry | null {
  const groups = baked.groups.filter((g) => g.materialIndex === slot);
  if (!groups.length) return null;
  const sub = new THREE.BufferGeometry();
  if (baked.index) {
    let total = 0;
    for (const g of groups) total += g.count;
    const indices = new Uint32Array(total);
    let at = 0;
    const src = baked.index.array;
    for (const g of groups) {
      for (let i = g.start; i < g.start + g.count; i++) indices[at++] = src[i];
    }
    for (const [name, attr] of Object.entries(baked.attributes)) sub.setAttribute(name, attr);
    sub.setIndex(new THREE.BufferAttribute(indices, 1));
    return sub;
  }
  // 无索引：每个 group 的 start/count 是顶点区间，按属性切片重建。
  let verts = 0;
  for (const g of groups) verts += g.count;
  for (const [name, attr] of Object.entries(baked.attributes)) {
    const itemSize = attr.itemSize;
    const Ctor = (attr.array as unknown as { constructor: new (n: number) => ArrayLike<number> }).constructor;
    const dst = new Ctor(verts * itemSize) as unknown as Float32Array;
    const src = attr.array as unknown as ArrayLike<number>;
    let off = 0;
    for (const g of groups) {
      const from = g.start * itemSize;
      const to = (g.start + g.count) * itemSize;
      for (let i = from; i < to; i++) dst[off++] = src[i];
    }
    sub.setAttribute(name, new THREE.BufferAttribute(dst, itemSize, attr.normalized));
  }
  return sub;
}

/** 父级世界矩阵的逆（chunk 几何已烘到世界坐标，新 mesh 需抵消父级变换）。 */
function parentInverse(parent: THREE.Object3D): THREE.Matrix4 | null {
  parent.updateWorldMatrix(true, false);
  const inv = parent.matrixWorld.clone().invert();
  return inv.equals(new THREE.Matrix4()) ? null : inv;
}

/** 合并一个槽的几何；索引状态不一致时把有索引的转成无索引再合并。 */
function mergeSlotGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const indexed = geoms.some((g) => !!g.index);
  const unindexed = geoms.some((g) => !g.index);
  if (indexed && unindexed) {
    const converted: THREE.BufferGeometry[] = [];
    const list = geoms.map((g) => {
      if (!g.index) return g;
      const conv = g.toNonIndexed();
      converted.push(conv);
      return conv;
    });
    const merged = mergeGeometries(list, false);
    for (const c of converted) c.dispose();
    return merged;
  }
  return mergeGeometries(geoms, false);
}

/**
 * 把 root 下的水面 mesh 归并成「每（世界高度层 × 材质签名）一个 mesh」。
 *
 * @returns 统计；没有可归并的组（或 A/B 开关关闭）时返回 null。
 */
export function mergeWaterSurfaces(root: THREE.Object3D): WaterMergeStats | null {
  const g = globalThis as { __vbspWaterMergeOff?: unknown };
  if (g.__vbspWaterMergeOff === true) {
    console.info('[app][water-merge] 跳过（__vbspWaterMergeOff=true）');
    return null;
  }

  const entries: WaterMeshEntry[] = [];
  let totalMeshes = 0;
  let skySkipped = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    totalMeshes++;
    const materials = waterMaterialsOf(mesh);
    if (!materials) return;
    if (mesh.layers.isEnabled(SKY_LAYER)) {
      skySkipped++;
      return;
    }
    mesh.updateWorldMatrix(true, false);
    entries.push({
      mesh,
      materials,
      parent: mesh.parent ?? root,
      layer: Math.round(worldHeightOf(mesh) / HEIGHT_BUCKET_HU),
      signature: materials.map(materialSignature).join('||'),
    });
  });
  const diag = { totalMeshes, waterEntries: entries.length, skySkipped, merged: 0, groups: 0 };
  (globalThis as { __vbspWaterMergeDiag?: typeof diag }).__vbspWaterMergeDiag = diag;
  if (!entries.length) {
    console.info(`[app][water-merge] 无候选（root mesh ${totalMeshes}，水面 ${entries.length}，天空层跳过 ${skySkipped}）`);
    return null;
  }

  // 组键 = 高度层 + 材质槽签名 + 父节点（同一父节点的世界变换相同才可直接换 mesh）。
  const buckets = new Map<string, WaterMeshEntry[]>();
  for (const entry of entries) {
    const key = `${entry.layer}|${entry.signature}|${entry.parent.uuid}`;
    const list = buckets.get(key);
    if (list) list.push(entry);
    else buckets.set(key, [entry]);
  }

  let groups = 0;
  let mergedMeshes = 0;
  let removedMeshes = 0;
  let failedGroups = 0;

  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    groups++;
    const first = members[0];
    const parent = first.parent;
    const slotCount = first.materials.length;
    const parentInv = parentInverse(parent);

    // ① 烘到世界坐标：每个成员的几何都 clone 一份世界坐标副本。
    const baked: THREE.BufferGeometry[] = [];
    for (const member of members) {
      const copy = member.mesh.geometry.clone();
      copy.applyMatrix4(member.mesh.matrixWorld);
      baked.push(copy);
    }

    try {
      // ② 按槽序号分别归并（useGroups=false：每个槽内部是单材质几何）。
      const perSlot: THREE.BufferGeometry[] = [];
      let abandoned = false;
      let abandonReason = '';
      for (let slot = 0; slot < slotCount; slot++) {
        const slotGeoms: THREE.BufferGeometry[] = [];
        for (const b of baked) {
          const sub = extractSlotGeometry(b, slot);
          if (!sub) {
            abandoned = true;
            abandonReason = `槽 ${slot} 拆不出子几何`;
            break;
          }
          slotGeoms.push(sub);
        }
        if (abandoned) break;
        const merged = mergeSlotGeometries(slotGeoms);
        for (const sub of slotGeoms) sub.dispose();
        if (!merged) {
          abandoned = true;
          abandonReason = `槽 ${slot} mergeGeometries 返回 null（属性不一致）`;
          break;
        }
        perSlot.push(merged);
      }

      // ③ 槽几何按槽顺序合成一个带 groups 的几何：`useGroups=true` 会按输入顺序写 materialIndex。
      let mergedGeometry: THREE.BufferGeometry | null = null;
      if (!abandoned && perSlot.length) {
        if (perSlot.length === 1) {
          mergedGeometry = perSlot[0];
        } else {
          mergedGeometry = mergeGeometries(perSlot, true);
          // 合并结果已复制数据，输入几何全部释放（失败时也不留悬挂缓冲）。
          for (const geo of perSlot) geo.dispose();
        }
      } else {
        for (const geo of perSlot) geo.dispose();
      }

      if (!mergedGeometry) {
        failedGroups++;
        console.warn(
          `[app][water-merge] 组放弃（${abandonReason || '原因未知'}，保留原样）：${members.length} 个 mesh，` +
            `签名 ${first.signature.slice(0, 96)}…`,
        );
        continue;
      }
      mergedGeometry.computeBoundingSphere();
      mergedGeometry.computeBoundingBox();

      // ④ 共享材质实例（不 clone）：水面 shader / 镜面驱动随后只注入这一次。
      const mergedMesh = new THREE.Mesh(mergedGeometry, first.materials as THREE.Material | THREE.Material[]);
      mergedMesh.name = first.mesh.name || 'water-merged';
      mergedMesh.renderOrder = first.mesh.renderOrder;
      mergedMesh.layers.mask = first.mesh.layers.mask;
      mergedMesh.userData = {
        ...first.mesh.userData,
        vbspWaterMerged: { members: members.length, slots: slotCount, layer: first.layer },
      };
      // 几何已在世界坐标：新 mesh 的局部变换 = 父级世界矩阵的逆（父级为单位阵时即单位阵）。
      mergedMesh.matrixAutoUpdate = false;
      mergedMesh.matrix.copy(parentInv ?? new THREE.Matrix4());
      mergedMesh.matrixWorldNeedsUpdate = true;
      parent.add(mergedMesh);

      // ⑤ 移除原 mesh（只 dispose 几何；材质是共享/放弃的实例，不在这里动）。
      for (const member of members) {
        member.mesh.removeFromParent();
        member.mesh.geometry.dispose();
        removedMeshes++;
      }
      mergedMeshes++;
      console.info(
        `[app][water-merge] 归并 1 组：${members.length} 个 mesh → 1 个（高度层 ${first.layer}，槽 ${slotCount}，` +
          `材质 ${first.materials.map((m) => m.name || '(unnamed)').join(' + ')}）`,
      );
    } finally {
      for (const b of baked) b.dispose();
    }
  }

  if (mergedMeshes === 0) {
    console.info('[app][water-merge] 无可归并水面组');
    return null;
  }
  if (failedGroups > 0) {
    console.warn(`[app][water-merge] ${failedGroups} 组因属性/槽不一致放弃（已保留原样）`);
  }
  diag.merged = mergedMeshes;
  diag.groups = groups;
  console.info(
    `[app][water-merge] 组 ${groups} / 归并 ${mergedMeshes} 个 mesh / 删除 ${removedMeshes} 个（失败组 ${failedGroups}）`,
  );
  return { groups, mergedMeshes, removedMeshes };
}
