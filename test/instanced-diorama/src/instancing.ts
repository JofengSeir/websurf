/**
 * 渲染端实例化 + 静态几何合并 —— 对导出的 GLB 应用实例化绘制。
 *
 * wasm 导出的 GLB 结构天然是「一个 mesh + 多个节点引用」（几何只写一次），
 * 但 three.js GLTFLoader 会把每个节点/primitive 加载为独立 THREE.Mesh（共享 geometry 对象）。
 * 本模块做两件事：
 *
 * 1. [`instanciateSharedMeshes`]：同一 geometry+material 的节点 → 空间 cell 分组
 *    → InstancedMesh（实例化绘制；cell 切分保住视锥剔除粒度）；
 * 2. [`mergeWorldGeometry`]：剩余的唯一世界几何（数万 primitive mesh）→ 按材质 +
 *    空间 cell 合并为静态块（draw call 从万级降到百级）。
 *
 * 返回统计供 HUD 展示（实例化前后 mesh 数 / 实例组数 / 实例总数 / 合并块数）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface InstancingStats {
  beforeMeshes: number;
  afterMeshes: number;
  groups: number; // InstancedMesh 组数
  instances: number; // 实例总数
  cells: number; // 实例化空间 cell 数
  chunks: number; // 世界几何合并块数
}

export function instanciateSharedMeshes(gltf: GLTF, cellSize = 2048): InstancingStats {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // 1. 收集普通 Mesh（跳过已有 InstancedMesh；多材质 mesh 不实例化）
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) meshes.push(m);
  });
  const beforeMeshes = meshes.length;

  // 2. 按 (geometry, material) 分组
  const byGeom = new Map<THREE.BufferGeometry, Map<THREE.Material, THREE.Mesh[]>>();
  for (const m of meshes) {
    if (Array.isArray(m.material) || !m.material || !m.geometry) continue;
    let byMat = byGeom.get(m.geometry);
    if (!byMat) {
      byMat = new Map();
      byGeom.set(m.geometry, byMat);
    }
    let arr = byMat.get(m.material);
    if (!arr) {
      arr = [];
      byMat.set(m.material, arr);
    }
    arr.push(m);
  }

  const replacements: Array<{ original: THREE.Mesh; instanced: THREE.InstancedMesh | null }> = [];
  const stats: InstancingStats = {
    beforeMeshes,
    afterMeshes: 0,
    groups: 0,
    instances: 0,
    cells: 0,
    chunks: 0,
  };

  for (const [, byMat] of byGeom) {
    for (const [material, arr] of byMat) {
      if (arr.length < 2) {
        // 单实例：原样保留
        for (const m of arr) replacements.push({ original: m, instanced: null });
        continue;
      }

      // 3. 空间 cell 切分（实例中心 = geometry 包围球中心经 matrixWorld 变换）
      const geo = arr[0].geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const bs = geo.boundingSphere!;
      const cells = new Map<string, THREE.Mesh[]>();
      const c = new THREE.Vector3();
      for (const m of arr) {
        c.copy(bs.center).applyMatrix4(m.matrixWorld);
        const key = `${Math.floor(c.x / cellSize)}|${Math.floor(c.y / cellSize)}|${Math.floor(c.z / cellSize)}`;
        let list = cells.get(key);
        if (!list) {
          list = [];
          cells.set(key, list);
        }
        list.push(m);
      }

      // 4. 每 cell 一个 InstancedMesh（共享同一 geometry）
      for (const cellArr of cells.values()) {
        const im = new THREE.InstancedMesh(geo, material, cellArr.length);
        cellArr.forEach((m, i) => im.setMatrixAt(i, m.matrixWorld));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true;
        im.receiveShadow = true;
        for (const m of cellArr) replacements.push({ original: m, instanced: im });
        stats.groups++;
        stats.instances += cellArr.length;
      }
      stats.cells += cells.size;
    }
  }

  // 5. 替换：移除原节点，实例化 mesh 挂到 GLB 根（保持世界矩阵语义）。
  //    注意不 dispose 原 geometry——InstancedMesh 仍共享该对象，dispose 会释放其 GPU 缓冲
  const holders = new Map<THREE.Mesh, THREE.InstancedMesh[]>();
  for (const r of replacements) {
    if (!r.instanced) continue;
    let list = holders.get(r.original);
    if (!list) {
      list = [];
      holders.set(r.original, list);
    }
    list.push(r.instanced);
  }
  for (const [original, list] of holders) {
    for (const im of list) root.add(im);
    original.removeFromParent();
  }

  // 6. 世界几何合并（唯一几何 → 按材质 + 空间 cell 合并为静态块）
  stats.chunks = mergeWorldGeometry(root, 4096);

  // 7. 统计：替换/合并后剩余 mesh 数
  let after = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) after++;
  });
  stats.afterMeshes = after;
  return stats;
}

/**
 * 静态世界几何合并：GLTFLoader 按 primitive 生成数万独立 Mesh（ze 图实证 18734 个），
 * 逐对象 draw call 会拖垮渲染。按 (材质, 空间 cell) 分组 → 顶点烘焙世界空间 →
 * `mergeGeometries` 合并为静态块（块数 = 非空 cell × 材质数，万级 → 百级）。
 *
 * 在实例化**之后**调用（共享 mesh 的 prop 已转 InstancedMesh，不会混入合并池）。
 * 返回合并后的块数。
 */
export function mergeWorldGeometry(root: THREE.Object3D, cellSize = 4096): number {
  // 1. 收集剩余普通 Mesh（跳过 InstancedMesh 与多材质 mesh）
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) meshes.push(m);
  });
  if (meshes.length < 2) return 0;

  // 2. 按 (material, cell) 分桶：cell = 几何包围盒中心的世界坐标
  const buckets = new Map<THREE.Material, Map<string, THREE.Mesh[]>>();
  const bsCenter = new THREE.Vector3();
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? null : m.material;
    if (!mat || !m.geometry) continue;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    bsCenter.copy(m.geometry.boundingSphere!.center).applyMatrix4(m.matrixWorld);
    const key = `${Math.floor(bsCenter.x / cellSize)}|${Math.floor(bsCenter.y / cellSize)}|${Math.floor(bsCenter.z / cellSize)}`;
    let byCell = buckets.get(mat);
    if (!byCell) {
      byCell = new Map();
      buckets.set(mat, byCell);
    }
    let arr = byCell.get(key);
    if (!arr) {
      arr = [];
      byCell.set(key, arr);
    }
    arr.push(m);
  }

  // 3. 每桶：克隆几何 → 烘焙世界变换 → 合并（useGroups=false：同材质无需 group）
  let chunks = 0;
  for (const [, byCell] of buckets) {
    for (const arr of byCell.values()) {
      if (arr.length === 1) continue; // 单 mesh 桶：保留原样（避免无谓克隆）
      const baked: THREE.BufferGeometry[] = [];
      for (const m of arr) {
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        baked.push(g);
      }
      const merged = mergeGeometries(baked, false);
      for (const g of baked) g.dispose();
      if (!merged) continue; // 属性不一致（防御）：保留原 mesh
      const chunk = new THREE.Mesh(merged, arr[0].material as THREE.Material);
      chunk.castShadow = true;
      chunk.receiveShadow = true;
      root.add(chunk);
      for (const m of arr) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      chunks++;
    }
  }
  return chunks;
}
