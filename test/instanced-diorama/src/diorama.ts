/**
 * 沙盘场景（Diorama）—— 实例化绘制核心测试。
 *
 * 结构：
 * - 中央"展品区"：4 行 × 5 列体素材质对比方块（金属/玻璃/木头/砖），
 *   方块间隙是 SSAO"夹角浓重阴影"的展示区域；
 * - 外围"散落区"：数千~数万随机小方块（0.4~1.4 单位），全部走 InstancedMesh；
 * - 每类材质 = 1 个 InstancedMesh = 1 个 draw call（2.1 万实例仅 4 个 draw call）。
 *
 * 性能要点：
 * - instanceMatrix / instanceColor 一次性写入（每实例 1 个 4×4 矩阵 + 颜色，无逐帧更新）；
 * - 台面为单 mesh；全场景阴影只由主平行光投射；
 * - 实例数量可在 2k~100k 区间实时重建，验证 GPU 实例化的吞吐上限。
 */
import * as THREE from 'three';
import { makePbrMaterials, mulberry32, type PbrMaterials } from './materials.js';
import { TABLE_HALF_X, TABLE_HALF_Z } from './studio-lights.js';

/** 实例分布统计（HUD 展示）。 */
export interface DioramaStats {
  total: number;
  metal: number;
  glass: number;
  wood: number;
  brick: number;
  drawCalls: number; // 方块实例化后的 draw call 数（= 材质种类数）
}

/** 展品区：4 材质行 × 5 列，方块 2.4 单位、间距 4.2。 */
const EXHIBIT_SIZE = 2.4;
const EXHIBIT_SPACING = 4.2;
const EXHIBIT_COLS = 5;
const EXHIBIT_ROW_Z = [-6.3, -2.1, 2.1, 6.3]; // metal / glass / wood / brick 行

/** 金属实例色（银/金/铜，替代纯色材质 → 体素材质区分）。 */
const METAL_COLORS = [0xc8ccd4, 0xd8a53c, 0xb87333];

export class Diorama {
  readonly group = new THREE.Group();
  private readonly mats: PbrMaterials;
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private instanced: THREE.InstancedMesh[] = [];
  private _stats: DioramaStats = { total: 0, metal: 0, glass: 0, wood: 0, brick: 0, drawCalls: 0 };

  constructor(private readonly scene: THREE.Scene) {
    this.mats = makePbrMaterials();
  }

  /** （重新）构建沙盘；`total` 为实例总数。 */
  build(total: number): DioramaStats {
    this.clear();
    const rng = mulberry32(42);

    // 台面（单 mesh，接收阴影；grout 缝给 SSAO 提供细节）
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_HALF_X * 2, 4, TABLE_HALF_Z * 2),
      this.mats.ground,
    );
    table.position.y = -2;
    table.receiveShadow = true;
    this.group.add(table);

    // 实例配额：金属 25% / 木头 35% / 砖 25% / 玻璃 15%
    const metal = Math.round(total * 0.25);
    const wood = Math.round(total * 0.35);
    const brick = Math.round(total * 0.25);
    const glass = Math.max(total - metal - wood - brick, 0);

    const addMesh = (
      material: THREE.Material,
      count: number,
      tint: ((im: THREE.InstancedMesh, idx: number, rng: () => number) => void) | null,
    ): void => {
      if (count <= 0) return;
      const im = new THREE.InstancedMesh(this.boxGeo, material, count);
      const mat = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      const euler = new THREE.Euler();
      let i = 0;

      // ① 展品区（每材质一行 5 块，固定槽位）
      for (let col = 0; col < EXHIBIT_COLS; col++) {
        const x = (col - (EXHIBIT_COLS - 1) / 2) * EXHIBIT_SPACING;
        mat.compose(
          pos.set(x, EXHIBIT_SIZE / 2, EXHIBIT_ROW_Z[this.exhibitRow(material)]),
          quat.identity(),
          scl.setScalar(EXHIBIT_SIZE),
        );
        im.setMatrixAt(i, mat);
        if (tint) tint(im, i, rng);
        i++;
      }

      // ② 散落区（表内随机、避开展品区）
      let guard = 0;
      while (i < count && guard++ < count * 100) {
        const x = (rng() * 2 - 1) * (TABLE_HALF_X - 8);
        const z = (rng() * 2 - 1) * (TABLE_HALF_Z - 8);
        if (x * x + z * z < 15 * 15) continue; // 避开中央展品区
        const s = 0.4 + rng() * 1.0;
        euler.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
        quat.setFromEuler(euler);
        mat.compose(
          pos.set(x, s / 2, z),
          quat,
          scl.set(s, s * (0.7 + rng() * 0.6), s),
        );
        im.setMatrixAt(i, mat);
        if (tint) tint(im, i, rng);
        i++;
      }

      im.count = i; // 实际写入数（拒绝采样可能少于配额）
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
      this.instanced.push(im);
    };

    addMesh(this.mats.metal, metal, (im, idx, rng) => {
      const c = new THREE.Color(METAL_COLORS[Math.floor(rng() * METAL_COLORS.length)]);
      im.setColorAt(idx, c);
    });
    addMesh(this.mats.glass, glass, null);
    addMesh(this.mats.wood, wood, (im, idx, rng) => {
      // 轻微木色明度变化（乘法 tint，不破坏木纹）
      const v = 0.85 + rng() * 0.3;
      im.setColorAt(idx, new THREE.Color(v, v * 0.92, v * 0.78));
    });
    addMesh(this.mats.brick, brick, null);

    // 材质种类数 = 实例化后的 draw call 数（未计台面/阴影 pass）
    this._stats = {
      total: this.instanced.reduce((n, im) => n + im.count, 0),
      metal,
      glass,
      wood,
      brick,
      drawCalls: this.instanced.length,
    };
    return this._stats;
  }

  /** 材质 → 展品行索引（与 EXHIBIT_ROW_Z 对应）。 */
  private exhibitRow(material: THREE.Material): number {
    if (material === this.mats.metal) return 0;
    if (material === this.mats.glass) return 1;
    if (material === this.mats.wood) return 2;
    return 3; // brick
  }

  get stats(): DioramaStats {
    return this._stats;
  }

  /** 释放全部实例化 mesh（材质/几何保留，供重建复用）。 */
  clear(): void {
    for (const im of this.instanced) {
      this.group.remove(im);
      im.dispose();
    }
    this.instanced = [];
    this.group.clear();
  }

  /** 完全释放（切模式时调用）。 */
  dispose(): void {
    this.clear();
    this.boxGeo.dispose();
    for (const m of Object.values(this.mats)) {
      m.map?.dispose();
      m.dispose();
    }
    this.scene.remove(this.group);
  }
}
