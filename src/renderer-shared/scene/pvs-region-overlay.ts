/**
 * PVS 区域着色（debug 专用诊断层）。
 *
 * 为什么按**面**着色而不是按块：起源的 PVS 单位是 **visleaf**（BSP 切出来的凸体），
 * 编译时 VVIS 把 leaf 归成 **cluster**，PVS 是「cluster → cluster」的位图；运行时只问
 * 「玩家所在 cluster 能看到哪些 cluster」。渲染块（`scene-optimizer` 的合并块）只是我们
 * 自己的合批单位，比 leaf 粗得多，按块着色会得到「合并网格」的轮廓而不是真实区域轮廓。
 *
 * 所以这里走几何里已有的 `_vbsp_face` 顶点属性：face → BSP face → `getFaceCluster(face)`
 * → cluster，逐顶点缓存 cluster，颜色按 cluster 逐顶点写 `color` 属性，材质换成
 * `MeshBasicMaterial({ vertexColors: true })`。切换 cluster 时才重算颜色。
 */
import * as THREE from 'three';
import type { PvsManager } from '../../ts-shared/world/pvs-manager.js';

/** 玩家所在 cluster 的颜色。 */
const CURRENT_COLOR = 0xff2d55;
/** 从当前 cluster 不可见的区域。 */
const HIDDEN_COLOR = 0x3a3a3a;
/** 可见的其它 cluster 的调色板（按 cluster id 取模）。 */
const PALETTE = [
  0x4a90d9, 0x50c878, 0xf5a623, 0x9b59b6, 0x1abc9c,
  0xe67e22, 0x8e44ad, 0x2ecc71, 0xd35400, 0x16a085,
  0xc0392b, 0x7f8c8d,
];
/** cluster 未知（-1 / 无 face 属性）的哨兵值。 */
const UNKNOWN = 0xffff;

interface Prepared {
  /** 每个顶点所属 cluster（UNKNOWN = 未知）。 */
  clusters: Uint16Array;
  /** 每个顶点的 RGB（归一化 Uint8）。 */
  colors: Uint8Array;
}

export class PvsRegionOverlay {
  private on = false;
  /** 逐顶点着色的共享材质（颜色来自几何的 `color` 属性）。 */
  private readonly vertexMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  /** 块 → 原材质（关闭时还原）。 */
  private readonly saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** 上一次着色用的 cluster（不变就不重算颜色）。 */
  private lastCluster = -2;
  /** 准备阶段的统计（顶点数 / 有 cluster 的顶点数）。 */
  private prepVerts = 0;
  private prepKnown = 0;
  /** 调色板预乘成线性 0..255（与 three 的颜色工作空间一致）。 */
  private readonly paletteBytes: [number, number, number][];
  private readonly currentBytes: [number, number, number];
  private readonly hiddenBytes: [number, number, number];

  constructor() {
    const toBytes = (hex: number): [number, number, number] => {
      const c = new THREE.Color(hex);
      return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
    };
    this.paletteBytes = PALETTE.map(toBytes);
    this.currentBytes = toBytes(CURRENT_COLOR);
    this.hiddenBytes = toBytes(HIDDEN_COLOR);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** 开关：开时准备逐顶点 cluster/color 并换材质；关时还原原材质。 */
  setEnabled(on: boolean, root: THREE.Object3D | null, pvs: PvsManager | null): void {
    if (this.on === on) return;
    this.on = on;
    if (!on) {
      this.restore();
      return;
    }
    if (!root) return;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (!this.saved.has(m)) this.saved.set(m, m.material as THREE.Material | THREE.Material[]);
      this.prepare(m, pvs);
      m.material = this.vertexMat;
    });
    this.lastCluster = -2;
  }

  /** 换图/销毁时清表。 */
  reset(): void {
    this.saved.clear();
    this.on = false;
    this.lastCluster = -2;
  }

  /** 每帧：cluster 变了才重算颜色。 */
  update(root: THREE.Object3D | null, pvs: PvsManager | null, camPos: THREE.Vector3): void {
    if (!this.on || !root || !pvs || !pvs.enabled) return;
    pvs.update(camPos);
    const cur = pvs.currentClusterId;
    if (cur !== this.lastCluster) {
      this.lastCluster = cur;
      this.recolor(root, pvs, cur);
    }
  }

  /** 逐顶点写颜色（O(顶点数)，只在 cluster 变化时跑）。 */
  private recolor(root: THREE.Object3D, pvs: PvsManager, cur: number): void {
    let colored = 0;
    let total = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      total++;
      const prep = m.geometry.userData.__pvsPrep as Prepared | undefined;
      if (!prep) return;
      const { clusters, colors } = prep;
      let has = false;
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        let r: number, g: number, b: number;
        if (c === UNKNOWN || cur < 0) {
          [r, g, b] = this.hiddenBytes;
        } else if (c === cur) {
          [r, g, b] = this.currentBytes;
          has = true;
        } else if (pvs.isVisible(c)) {
          [r, g, b] = this.paletteBytes[c % this.paletteBytes.length];
          has = true;
        } else {
          [r, g, b] = this.hiddenBytes;
        }
        const k = i * 3;
        colors[k] = r; colors[k + 1] = g; colors[k + 2] = b;
      }
      const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
      if (has) colored++;
    });
    const st = pvs.getStats();
    (globalThis as { __vbspPvsRegions?: unknown }).__vbspPvsRegions = {
      current: cur,
      visibleClusters: st.visibleCount,
      totalClusters: st.totalClusters,
      coloredChunks: colored,
      totalChunks: total,
      prepVerts: this.prepVerts,
      prepKnown: this.prepKnown,
    };
  }

  /** 为一块几何准备 cluster/color 属性（只做一次）。 */
  private prepare(mesh: THREE.Mesh, pvs: PvsManager | null): void {
    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!g || g.userData.__pvsPrep) return;
    const pos = g.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const n = pos.count;
    const clusters = new Uint16Array(n);
    if (pvs) {
      // 逐顶点定位所属 cluster（BSP leaf → cluster）。顶点沿法线外偏 4 HU，避免正好落在
      // 固体/开放的边界上被判进 solid（face→cluster 表对本图几乎全是 -1，不可用）。
      const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
      for (let i = 0; i < n; i++) {
        const nx = nrm ? nrm.getX(i) : 0;
        const ny = nrm ? nrm.getY(i) : 1;
        const nz = nrm ? nrm.getZ(i) : 0;
        const c = pvs.getClusterAt({
          x: pos.getX(i) + nx * 4,
          y: pos.getY(i) + ny * 4,
          z: pos.getZ(i) + nz * 4,
        });
        if (c >= 0) this.prepKnown++;
        clusters[i] = c >= 0 && c < UNKNOWN ? c : UNKNOWN;
      }
    } else {
      clusters.fill(UNKNOWN);
    }
    this.prepVerts += n;
    const colors = new Uint8Array(n * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    g.userData.__pvsPrep = { clusters, colors } as Prepared;
  }

  /** 还原原材质。 */
  private restore(): void {
    for (const [mesh, mat] of this.saved) mesh.material = mat;
    this.saved.clear();
    this.lastCluster = -2;
  }
}
