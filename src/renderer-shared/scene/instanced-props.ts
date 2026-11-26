/**
 * 静态道具（`prop_static`）二进制实例表展开器：`vbsp_instanced_props` → 空间分桶 `THREE.InstancedMesh`。
 *
 * Rust 侧把同一模型（无 VHV、非动态实体、实例数 >= 2）的变换矩阵与 18-float `ambientCube`
 * 打包进单个 GLB `bufferView`（步长 29 × f32 = 116 B）。浏览器端直接用零拷贝 `Float32Array` 视图
 * 构造按 2048 HU 空间单元分桶（且 3D 天空盒分离）的 `THREE.InstancedMesh`，既大幅削减
 * Draw Call 与加载期 JSON/Mesh 内存峰值，又保持 PVS 与距离场剔除粒度。
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const INST_PROP_STRIDE_FLOATS = 29;
const INST_DEFAULT_CELL_SIZE = 2048;
const INST_MAX_PER_BATCH = 4096;

const INST_PROBE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [24, 0, 0], [-24, 0, 0], [0, 24, 0], [0, -24, 0], [0, 0, 24], [0, 0, -24],
  [96, 0, 0], [-96, 0, 0], [0, 96, 0], [0, -96, 0], [0, 0, 96], [0, 0, -96],
];

export interface InstancedPropsClusterQuery {
  getClusterAt(p: { x: number; y: number; z: number }): number;
}

export interface InstancedPropsDescriptor {
  bufferView: number;
  count: number;
  strideFloats: number;
  hasAnyCube?: boolean;
}

export interface InstancedPropsStats {
  templates: number;
  totalInstances: number;
  instancedMeshes: number;
  singleMeshes: number;
  skyInstances: number;
  uninstancedTranslucent: number;
}

interface InstBucket {
  isSky: boolean;
  indices: number[];
}

function isTranslucentPropMaterial(mat: THREE.Material | undefined): boolean {
  if (!mat) return false;
  return Boolean(mat.transparent);
}

/** 采样单个实例的 world-space cluster（先原位，落进固体则用几何中心与 ±24/±96 HU 探针）。 */
function sampleInstanceCluster(
  pvs: InstancedPropsClusterQuery,
  tx: number,
  ty: number,
  tz: number,
  mat4: THREE.Matrix4,
  geomCenter: THREE.Vector3,
  tmpVec: THREE.Vector3,
): number {
  const c0 = pvs.getClusterAt({ x: tx, y: ty, z: tz });
  if (c0 >= 0) return c0;
  tmpVec.copy(geomCenter).applyMatrix4(mat4);
  for (const [ox, oy, oz] of INST_PROBE_OFFSETS) {
    const c = pvs.getClusterAt({ x: tmpVec.x + ox, y: tmpVec.y + oy, z: tmpVec.z + oz });
    if (c >= 0) return c;
  }
  return -1;
}

/**
 * 展开 `root` 下所有带 `userData.vbsp_instanced_props` 的模板节点为 `THREE.InstancedMesh`。
 */
export async function expandInstancedProps(
  root: THREE.Object3D,
  gltf: GLTF,
  opts?: {
    pvs?: InstancedPropsClusterQuery | null;
    skyCluster?: number;
    cellSize?: number;
  },
): Promise<InstancedPropsStats> {
  const stats: InstancedPropsStats = {
    templates: 0,
    totalInstances: 0,
    instancedMeshes: 0,
    singleMeshes: 0,
    skyInstances: 0,
    uninstancedTranslucent: 0,
  };

  const templates: Array<{ node: THREE.Object3D; desc: InstancedPropsDescriptor }> = [];
  root.traverse((obj) => {
    const desc = (obj.userData as { vbsp_instanced_props?: InstancedPropsDescriptor }).vbsp_instanced_props;
    if (
      desc &&
      typeof desc.bufferView === 'number' &&
      typeof desc.count === 'number' &&
      desc.count > 0 &&
      typeof desc.strideFloats === 'number' &&
      desc.strideFloats >= INST_PROP_STRIDE_FLOATS
    ) {
      templates.push({ node: obj, desc });
    }
  });

  if (templates.length === 0) {
    (globalThis as { __vbspInstancedPropsStats?: InstancedPropsStats }).__vbspInstancedPropsStats = stats;
    return stats;
  }

  root.updateMatrixWorld(true);
  const cellSize = Math.max(128, opts?.cellSize ?? INST_DEFAULT_CELL_SIZE);
  const skyCluster = opts?.skyCluster ?? -1;
  const pvs = opts?.pvs ?? null;

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const localMat = new THREE.Matrix4();
  const parentWorldMat = new THREE.Matrix4();
  const instWorldMat = new THREE.Matrix4();
  const geomCenter = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();

  for (const { node, desc } of templates) {
    const ab = (await gltf.parser.getDependency('bufferView', desc.bufferView)) as ArrayBuffer;
    const stride = desc.strideFloats;
    const floatCount = desc.count * stride;
    if (ab.byteLength < floatCount * 4) continue;
    const table = new Float32Array(ab, 0, floatCount);

    const srcMeshes: THREE.Mesh[] = [];
    node.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.isMesh && m.geometry) srcMeshes.push(m);
    });
    if (srcMeshes.length === 0) continue;

    stats.templates++;
    stats.totalInstances += desc.count;

    const parent = node.parent ?? root;
    parentWorldMat.copy(parent.matrixWorld);

    // 按天空区 + 2048 HU 空间桶分组实例（先算好每实例世界变换方向）
    const bucketMap = new Map<string, InstBucket>();
    for (let i = 0; i < desc.count; i++) {
      const base = i * stride;
      pos.set(table[base], table[base + 1], table[base + 2]);
      tmpVec.copy(pos).applyMatrix4(parentWorldMat);
      let isSky = false;
      if (pvs && skyCluster >= 0) {
        if (pvs.getClusterAt({ x: tmpVec.x, y: tmpVec.y, z: tmpVec.z }) === skyCluster) {
          isSky = true;
          stats.skyInstances++;
        }
      }
      const key = isSky
        ? 'sky'
        : `${Math.floor(tmpVec.x / cellSize)}|${Math.floor(tmpVec.y / cellSize)}|${Math.floor(tmpVec.z / cellSize)}`;
      let bucket = bucketMap.get(key);
      if (!bucket) {
        bucket = { isSky, indices: [] };
        bucketMap.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    // 切分超过 INST_MAX_PER_BATCH 的大桶
    const batches: InstBucket[] = [];
    for (const bucket of bucketMap.values()) {
      for (let off = 0; off < bucket.indices.length; off += INST_MAX_PER_BATCH) {
        batches.push({
          isSky: bucket.isSky,
          indices: bucket.indices.slice(off, off + INST_MAX_PER_BATCH),
        });
      }
    }

    for (const srcMesh of srcMeshes) {
      const geom = srcMesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (geom.boundingBox) geom.boundingBox.getCenter(geomCenter);
      else geomCenter.set(0, 0, 0);

      const rawMat = srcMesh.material;
      const mat = Array.isArray(rawMat) ? rawMat[0] : rawMat;
      const isTrans = isTranslucentPropMaterial(mat);

      if (isTrans) {
        // 半透明材质需要逐面排序，不合进 InstancedMesh，退回轻量独立 Mesh
        for (let i = 0; i < desc.count; i++) {
          const base = i * stride;
          const m = new THREE.Mesh(geom, rawMat);
          m.name = srcMesh.name || `${node.name}#${i}`;
          m.position.set(table[base], table[base + 1], table[base + 2]);
          m.quaternion.set(table[base + 3], table[base + 4], table[base + 5], table[base + 6]);
          m.scale.set(table[base + 7], table[base + 8], table[base + 9]);
          if (table[base + 10] > 0.5) {
            m.userData.ambientCube = Array.from(table.subarray(base + 11, base + 29));
          }
          parent.add(m);
          stats.uninstancedTranslucent++;
        }
        continue;
      }

      for (const batch of batches) {
        if (batch.indices.length === 1) {
          const i = batch.indices[0];
          const base = i * stride;
          const m = new THREE.Mesh(geom, rawMat);
          m.name = srcMesh.name || `${node.name}#${i}`;
          m.position.set(table[base], table[base + 1], table[base + 2]);
          m.quaternion.set(table[base + 3], table[base + 4], table[base + 5], table[base + 6]);
          m.scale.set(table[base + 7], table[base + 8], table[base + 9]);
          if (table[base + 10] > 0.5) {
            m.userData.ambientCube = Array.from(table.subarray(base + 11, base + 29));
          }
          if (batch.isSky) m.userData.__vbspSkyInstanced = true;
          parent.add(m);
          stats.singleMeshes++;
          continue;
        }

        const count = batch.indices.length;
        const inst = new THREE.InstancedMesh(geom, rawMat, count);
        inst.name = srcMesh.name || node.name || 'instanced_prop';
        inst.userData.vbspInstancedProp = true;
        if (batch.isSky) {
          inst.userData.__vbspSkyInstanced = true;
          if (skyCluster >= 0) inst.userData.splitClusters = [skyCluster];
        }

        let bucketHasCube = false;
        const clusterSet = !batch.isSky && pvs ? new Set<number>() : null;

        for (let k = 0; k < count; k++) {
          const i = batch.indices[k];
          const base = i * stride;
          pos.set(table[base], table[base + 1], table[base + 2]);
          quat.set(table[base + 3], table[base + 4], table[base + 5], table[base + 6]);
          scl.set(table[base + 7], table[base + 8], table[base + 9]);
          localMat.compose(pos, quat, scl);
          inst.setMatrixAt(k, localMat);
          if (table[base + 10] > 0.5) bucketHasCube = true;

          if (clusterSet && pvs) {
            instWorldMat.multiplyMatrices(parentWorldMat, localMat);
            tmpVec.setFromMatrixPosition(instWorldMat);
            const cl = sampleInstanceCluster(
              pvs,
              tmpVec.x,
              tmpVec.y,
              tmpVec.z,
              instWorldMat,
              geomCenter,
              pos,
            );
            if (cl >= 0) clusterSet.add(cl);
          }
        }

        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingBox();
        inst.computeBoundingSphere();

        if (bucketHasCube) {
          const cubes = new Float32Array(count * 18);
          for (let k = 0; k < count; k++) {
            const base = batch.indices[k] * stride;
            if (table[base + 10] > 0.5) {
              cubes.set(table.subarray(base + 11, base + 29), k * 18);
            } else {
              cubes.fill(1.0, k * 18, (k + 1) * 18);
            }
          }
          inst.userData.__vbspInstancedAmbCubes = cubes;
        }

        if (clusterSet && clusterSet.size > 0) {
          inst.userData.splitClusters = Array.from(clusterSet);
        }

        parent.add(inst);
        stats.instancedMeshes++;
      }
    }

    node.removeFromParent();
  }

  (globalThis as { __vbspInstancedPropsStats?: InstancedPropsStats }).__vbspInstancedPropsStats = stats;
  if (stats.totalInstances > 0) {
    console.info(
      `[instanced-props] 模板=${stats.templates} 实例=${stats.totalInstances} → ` +
        `InstancedMesh=${stats.instancedMeshes} 单体=${stats.singleMeshes} ` +
        `天空=${stats.skyInstances} 透明回退=${stats.uninstancedTranslucent}`,
    );
  }
  return stats;
}
