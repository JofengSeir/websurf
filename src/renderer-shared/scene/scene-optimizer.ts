/**
 * 空间分块合并（scene optimizer）：把 GLTFLoader 逐 primitive 生成的数万 Mesh 收敛成数百个
 * 空间块，降低每帧遍历与 draw call 数量。2026-10-02 自 apps/game/src/renderer/renderer-main.ts
 * 的同名私有方法原样抽出、现居渲染共享层（game 经 tsconfig include 收编；逻辑零改动；this.camera / config.hud.fov 两个诊断读数改为入参传入）。
 *
 * 2026-10-03 Phase 3c 拆成「共享核 + 调用方包装」：mergeIntoChunks 是不改根、不挂载、不打日志的
 * 纯收集合并核（game 与 viewer 共用同一份算法）；root 挂载方式与诊断日志留在各调用方——game 的
 * optimizeScene 包装与拆分前逐行等价（先收集合并，再挂回 bspRoot、移除 GLB 子树、垫包围球、打统计）。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// ── 空间分块合并参数（GLB 挂载后一次性执行；见 optimizeScene）──────────
// GLTFLoader 按 GLB 的 primitive 逐个建 THREE.Mesh，图元多的地图因此会产生数万个 Mesh 对象：
// 每帧都要遍历它们做剔除，可见的还要逐个 draw call。分块合并把这批 Mesh 收敛成数百个空间块
// （块内先按材质实例分组，再合并成「每块一个 Mesh + 一份材质数组」），几何与材质实例不变；
// 合并失败的分支逐块回退为保留独立几何。
/** cell 大小自适应的目标块数：初值 = 世界包围盒对角线 / cbrt(本值)，随后按非空 cell 数微调。 */
const OPT_TARGET_CELLS = 512;
/** 自适应接受的「非空 cell 数」区间；落进区间即停止调整（最多 6 轮）。 */
const OPT_MIN_CELLS = 300;
const OPT_MAX_CELLS = 800;
/** cell 边长钳制区间（世界单位）：初值与每轮微调都被夹在区间内。 */
const OPT_CELL_MIN = 128;
const OPT_CELL_MAX = 4096;
/**
 * 视锥外保留圈的半径膨胀系数（分块结束时乘到每块的包围球半径上）。
 * three 的视锥剔除按 geometry.boundingSphere 判定，膨胀后视锥外一圈的块仍参与渲染 ⇒
 * 快速转动时新进入视野的块上一帧已在画，边缘不闪空。只影响剔除判定，不改几何与材质。
 */
const FRUSTUM_PAD = 1.6;

/** 分块收集项：mesh + 它的世界包围盒中心（分桶键用）。 */
interface OptMeshInfo {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

/** cell 键：世界坐标三分量各除以 cellSize 后向下取整，拼成字符串（一次性分桶）。 */
function optCellKey(x: number, y: number, z: number, cellSize: number): string {
  return Math.floor(x / cellSize) + '|' + Math.floor(y / cellSize) + '|' + Math.floor(z / cellSize);
}

/** 统计给定 cellSize 下的非空 cell 数（cell 大小自适应循环用）。 */
function optCountCells(infos: OptMeshInfo[], cellSize: number): number {
  const keys = new Set<string>();
  for (const it of infos) keys.add(optCellKey(it.cx, it.cy, it.cz, cellSize));
  return keys.size;
}

/** mergeIntoChunks 的产物：chunks / keptMeshes 由调用方自行挂载，统计字段供诊断日志用。 */
export interface MergeResult {
  infos: OptMeshInfo[];
  keptMeshes: THREE.Mesh[];
  chunks: THREE.Mesh[];
  cellSize: number;
  cellsCount: number;
  chunkCount: number;
  vertsTotal: number;
  drawCallEst: number;
}

/**
 * 收集与合并核：traverse `collectRoot` 收集单材质 Mesh → cell 边长自适应 → 分桶 → 逐 cell 合并。
 * 不改根、不挂载、不打日志（root 处理与诊断是调用方的事）；infos 为空时 chunks/keptMeshes
 * 的收集（多材质烘焙）已经完成，调用方按各自语义处理空集路径。
 */
export function mergeIntoChunks(collectRoot: THREE.Object3D): MergeResult {
  // ① 收集：先刷新 matrixWorld 作为世界变换基准。多材质 mesh（GLB primitive 恒单材质，此处是
  //    防御路径）烘焙到世界空间后保留；无材质 mesh 原样跳过。两者都不参与分块
  collectRoot.updateMatrixWorld(true);
  const infos: OptMeshInfo[] = [];
  const keptMeshes: THREE.Mesh[] = [];
  const worldBox = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  collectRoot.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.geometry || !m.geometry.attributes.position) return;
    if (Array.isArray(m.material) || !m.material) {
      // 多材质：烘焙到世界空间后整体保留（不参与分块合并）
      if (Array.isArray(m.material)) {
        const baked = m.geometry.clone();
        baked.applyMatrix4(m.matrixWorld);
        m.geometry.dispose();
        m.geometry = baked;
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        m.updateMatrix();
        keptMeshes.push(m);
      }
      return;
    }
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
    worldBox.union(box);
    box.getCenter(center);
    infos.push({ mesh: m, cx: center.x, cy: center.y, cz: center.z });
  });
  if (infos.length === 0) {
    return { infos, keptMeshes, chunks: [], cellSize: 0, cellsCount: 0, chunkCount: 0, vertsTotal: 0, drawCallEst: 0 };
  }

  // ①b 合并失败不丢几何：`mergeGeometries` 在属性集不一致时返回 null，而本函数每一处失败分支
  //     都回退成「保留各自独立几何」，不存在"合并失败就丢弃"的路径。

  // ② cell 边长自适应：初值取世界包围盒对角线 / cbrt(目标块数)，随后按非空 cell 数缩放（收敛到
  //    OPT_MIN_CELLS..OPT_MAX_CELLS）
  const diag = Math.max(worldBox.getSize(new THREE.Vector3()).length(), 1);
  let cellSize = Math.min(Math.max(diag / Math.cbrt(OPT_TARGET_CELLS), OPT_CELL_MIN), OPT_CELL_MAX);
  for (let i = 0; i < 6; i++) {
    const n = optCountCells(infos, cellSize);
    if (n >= OPT_MIN_CELLS && n <= OPT_MAX_CELLS) break;
    const scale = Math.min(Math.max(Math.cbrt(n / OPT_TARGET_CELLS), 0.55), 1.8);
    cellSize = Math.min(Math.max(cellSize * scale, OPT_CELL_MIN), OPT_CELL_MAX);
  }

  // ③ 分桶：按每个 mesh 的世界包围盒中心归 cell（横跨多 cell 的归中心所在 cell）
  const cells = new Map<string, OptMeshInfo[]>();
  for (const it of infos) {
    const key = optCellKey(it.cx, it.cy, it.cz, cellSize);
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(it);
  }

  // ④ 合并：单 mesh 的 cell 保留原 mesh（几何烘焙到世界空间、变换清零）；多 mesh 的 cell
  //    先按材质实例分组子合并，再 mergeGeometries(useGroups = true) 合成一个 Mesh + 材质数组
  //    （groups 与材质数组下标一一对应）
  const chunks: THREE.Mesh[] = [];
  let chunkCount = 0;
  let drawCallEst = 0;
  let vertsTotal = 0;
  for (const arr of cells.values()) {
    if (arr.length === 1) {
      const m = arr[0].mesh;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      m.geometry.dispose();
      m.geometry = baked;
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.updateMatrix();
      chunks.push(m);
      chunkCount++;
      drawCallEst++;
      vertsTotal += baked.attributes.position.count;
      continue;
    }

    // 多 mesh cell：按材质实例分组，组内合并成一个几何（每组对应一个材质槽）
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const it of arr) {
      const m = it.mesh;
      const mat = m.material as THREE.Material;
      const baked = m.geometry.clone();
      baked.applyMatrix4(m.matrixWorld);
      let list = byMat.get(mat);
      if (!list) {
        list = [];
        byMat.set(mat, list);
      }
      list.push(baked);
    }
    const mergedGeoms: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    for (const [mat, geoms] of byMat) {
      let merged: THREE.BufferGeometry[];
      if (geoms.length === 1) {
        merged = geoms;
      } else {
        const mg = mergeGeometries(geoms, false);
        if (mg) {
          for (const g of geoms) g.dispose();
          merged = [mg];
        } else {
          merged = geoms; // 属性不一致（防御分支）：保留各自独立几何
        }
      }
      for (const g of merged) {
        mergedGeoms.push(g);
        mats.push(mat);
      }
    }
    if (mergedGeoms.length === 0) {
      for (const it of arr) it.mesh.geometry.dispose();
      continue;
    }
    let chunk: THREE.Mesh;
    if (mergedGeoms.length === 1) {
      chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
      drawCallEst++;
    } else {
      const final = mergeGeometries(mergedGeoms, true);
      if (final) {
        for (const g of mergedGeoms) if (g !== final) g.dispose();
        chunk = new THREE.Mesh(final, mats);
        drawCallEst += final.groups.length;
      } else {
        // 最终合并失败（极端防御）：每个材质单独一块
        chunk = new THREE.Mesh(mergedGeoms[0], mats[0]);
        for (let i = 1; i < mergedGeoms.length; i++) {
          chunks.push(new THREE.Mesh(mergedGeoms[i], mats[i]));
          chunkCount++;
          drawCallEst++;
        }
      }
    }
    for (const it of arr) it.mesh.geometry.dispose();
    chunkCount++;
    for (const g of mergedGeoms) vertsTotal += g.attributes.position.count;
    chunks.push(chunk);
  }

  return { infos, keptMeshes, chunks, cellSize, cellsCount: cells.size, chunkCount, vertsTotal, drawCallEst };
}

/**
 * 视锥外保留一圈：给 root 下每个 mesh 的包围球半径乘 FRUSTUM_PAD。必须无条件重算包围球（不能只判
 * null）：烘焙路径是 geometry.clone() + applyMatrix4(matrixWorld)，克隆会带上 GLB 局部空间的旧球
 * （非 null，不重算就会被当成有效值）⇒ 剔除按错误位置判定、眼前的块被误剔。顶点已烘焙到世界
 * 空间，重算才是对的。只影响剔除判定，不改几何与包围盒。game 与 viewer 共用。
 */
export function padBoundingSpheres(root: THREE.Object3D): void {
  for (const child of root.children) {
    const g = (child as THREE.Mesh).geometry;
    if (!g) continue;
    g.computeBoundingSphere();
    (g.boundingSphere as THREE.Sphere).radius *= FRUSTUM_PAD;
  }
}

// ── game 包装：签名与行为与抽取前逐行一致（loadScene 里挂载完 GLB 后执行一次）─────────────
// 目的：把 GLTFLoader 逐 primitive 生成的数万个 Mesh 收敛成数百个空间块，降低每帧遍历与 draw call
// 数量。载体是 BSP 场景根（`userData.isBspModel` 保持不变）：块 mesh 直接挂到它下面，原 GLB 子树移除。
// 流程：
// ① 收集与合并（mergeIntoChunks：收集单材质 Mesh、多材质烘焙保留、cell 自适应、逐 cell 合并）；
// ② 替换场景内容，并给每块重算包围球后乘 FRUSTUM_PAD；
// ③ 打印统计与「前向视锥可见块」估算（用入参 camera 与 fovDeg 粗估，仅诊断）。
export function optimizeScene(
  bspRoot: THREE.Scene,
  gltfScene: THREE.Object3D,
  camera: THREE.PerspectiveCamera | null,
  fovDeg: number,
): void {
  const r = mergeIntoChunks(bspRoot);
  if (r.infos.length === 0) return;

  // 替换：块 mesh 与保留 mesh 直接挂到 BSP 根（`add` 会自动让它们脱离原父节点），随后移除原
  // GLB 子树（旧几何已在上面逐个 dispose）。`bspRoot.userData.isBspModel` 保持不变——
  // disposeScene 与近平面自适应都依赖它
  const totalMeshes = r.infos.length;
  for (const m of r.chunks) bspRoot.add(m);
  for (const m of r.keptMeshes) bspRoot.add(m);
  bspRoot.remove(gltfScene);
  padBoundingSpheres(bspRoot);

  // 统计 + 前向视锥可见块估算（块中心与相机方向的点积粗估，FOV 取入参 fovDeg）
  const chunkBox = new THREE.Box3();
  const chunkCenter = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  let visibleEst = -1;
  if (camera) {
    camera.updateMatrixWorld(true);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const cosHalfFov = Math.cos((fovDeg / 2) * (Math.PI / 180));
    visibleEst = 0;
    for (const child of bspRoot.children) {
      const mesh = child as THREE.Mesh;
      chunkBox.setFromObject(mesh);
      if (chunkBox.isEmpty()) continue;
      chunkBox.getCenter(chunkCenter);
      toCam.subVectors(chunkCenter, camera.position);
      const dist = toCam.length();
      if (dist < camera.far && toCam.dot(camDir) / dist > cosHalfFov) visibleEst++;
    }
  }
  console.log(
    `[optimizeScene] 分块合并: ${totalMeshes} mesh → ${r.chunkCount} 块` +
      `（cellSize=${r.cellSize.toFixed(1)}、非空 cell=${r.cellsCount}）| ` +
      `平均顶点/块 ${(r.vertsTotal / Math.max(r.chunkCount, 1)).toFixed(0)}（总顶点 ${r.vertsTotal}）| ` +
      `draw call 估算 ${r.drawCallEst} | ` +
      `前向视锥可见块估算 ${visibleEst >= 0 ? `${visibleEst}/${r.chunkCount}` : 'N/A（camera 未就绪）'}`,
  );
}
