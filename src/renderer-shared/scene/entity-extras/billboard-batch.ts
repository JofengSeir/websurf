/**
 * 面向相机的四边形合批（`entity-extras` 的共用底座）。
 *
 * 语义与 `particles.ts` 的 `AdditiveQuadBatch` 对齐（同一次 draw 画完一组贴图 quad）：
 * - 顶点色 RGBA（three 0.165 的 vertexAlphas 路径），逐 quad 控颜色/alpha；
 * - 加法混合：出射 = 贴图色(线性) × 顶点色(线性)，alpha = 贴图 a × 顶点 a；
 *   普通半透明用于文字（颜色准确、不进 bloom）；
 * - `depthWrite=false`、`depthTest=true`、`DoubleSide`；
 * - 槽位是绝对下标，调用方每帧按同一槽位重写四边形；drawRange 恒定。
 *
 * 与粒子 batch 的差别：每个 quad 支持独立 UV 子矩形（worldtext 图集）与独立宽高
 * （文字有长宽比，sprite 是正方形）。
 */

import * as THREE from 'three';

/** 相机朝向 billboard 的基向量（世界空间：相机矩阵的右/上轴列向量）。 */
export interface BillboardBasis {
  /** 右轴（世界空间单位向量）。 */
  rx: number;
  ry: number;
  rz: number;
  /** 上轴（世界空间单位向量）。 */
  ux: number;
  uy: number;
  uz: number;
}

/**
 * 取相机的右/上轴（世界空间）。沿这两个轴偏移顶点不改变顶点的视线方向投影深度，
 * 因此等价于 three `Sprite` 着色器里的「view 空间 XY 偏移」——透视投影下逐像素一致。
 */
export function billboardBasisOf(camera: THREE.Camera, out: BillboardBasis): BillboardBasis {
  const m = camera.matrixWorld.elements;
  out.rx = m[0];
  out.ry = m[1];
  out.rz = m[2];
  out.ux = m[4];
  out.uy = m[5];
  out.uz = m[6];
  return out;
}

/** 单个 quad 的 UV 子矩形（图集用；缺省整张 0..1）。 */
export interface BillboardUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** 混合方式：`additive` = 光效（可进 bloom），`normal` = 普通半透明（文字）。 */
export type BillboardBlend = 'additive' | 'normal';

export class BillboardQuadBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly uvs: Float32Array;
  private readonly capacity: number;
  private live = 0;
  /** 上一帧 end() 时上传过的 live 数量；color/uv 是常量，只在数量变化时重传。 */
  private lastEndLive = -1;

  constructor(texture: THREE.Texture, capacity: number, renderOrder: number, blend: BillboardBlend) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const quads = this.capacity;
    this.positions = new Float32Array(quads * 12);
    this.colors = new Float32Array(quads * 16);
    this.uvs = new Float32Array(quads * 8);
    const indices: number[] = [];
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const o = q * 8;
      // 顶点顺序 p0/p1/p2/p3 对应 UV (0,0)/(1,0)/(1,1)/(0,1)。
      this.uvs[o] = 0;
      this.uvs[o + 1] = 0;
      this.uvs[o + 2] = 1;
      this.uvs[o + 3] = 0;
      this.uvs[o + 4] = 1;
      this.uvs[o + 5] = 1;
      this.uvs[o + 6] = 0;
      this.uvs[o + 7] = 1;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, quads * 6);
    this.geometry = geometry;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      // 屏幕朝向 quad 的绕序在极端视角下可能翻面；两种混合方式下双面与单面等价。
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    // 全局合批网格不参与 tagCullBounds/cullByCamera 的整片剔除。
    this.mesh.userData.vbspNoCull = true;
    // 首帧 update 之前没有顶点，先不画（否则多一次空 draw）。
    this.mesh.visible = false;
  }

  /** 新增 draw 数（本 batch 恒为 1）。 */
  get draws(): number {
    return 1;
  }

  begin(): void {
    this.live = 0;
  }

  /**
   * 写一个屏幕朝向的 billboard：中心 (cx,cy,cz)，半宽/半高（HU），
   * p0/p1/p2/p3 依次对应 UV (0,0)/(1,0)/(1,1)/(0,1)。
   */
  billboardAt(
    slot: number,
    cx: number,
    cy: number,
    cz: number,
    halfWidth: number,
    halfHeight: number,
    basis: BillboardBasis,
    r: number,
    g: number,
    b: number,
    a: number,
    uv?: BillboardUv,
  ): void {
    if (slot < 0 || slot >= this.capacity) return;
    const rx = basis.rx * halfWidth;
    const ry = basis.ry * halfWidth;
    const rz = basis.rz * halfWidth;
    const ux = basis.ux * halfHeight;
    const uy = basis.uy * halfHeight;
    const uz = basis.uz * halfHeight;
    const v = slot * 4;
    this.writeVert(v, cx - rx - ux, cy - ry - uy, cz - rz - uz, r, g, b, a);
    this.writeVert(v + 1, cx + rx - ux, cy + ry - uy, cz + rz - uz, r, g, b, a);
    this.writeVert(v + 2, cx + rx + ux, cy + ry + uy, cz + rz + uz, r, g, b, a);
    this.writeVert(v + 3, cx - rx + ux, cy - ry + uy, cz - rz + uz, r, g, b, a);
    if (uv) {
      const o = slot * 8;
      this.uvs[o] = uv.u0;
      this.uvs[o + 1] = uv.v0;
      this.uvs[o + 2] = uv.u1;
      this.uvs[o + 3] = uv.v0;
      this.uvs[o + 4] = uv.u1;
      this.uvs[o + 5] = uv.v1;
      this.uvs[o + 6] = uv.u0;
      this.uvs[o + 7] = uv.v1;
    }
    this.live++;
  }

  /** 把槽位塌成零面积（不可见，不计入 live）。 */
  collapseAt(slot: number): void {
    if (slot < 0 || slot >= this.capacity) return;
    const v = slot * 4;
    this.writeVert(v, 0, 0, 0, 0, 0, 0, 0);
    this.writeVert(v + 1, 0, 0, 0, 0, 0, 0, 0);
    this.writeVert(v + 2, 0, 0, 0, 0, 0, 0, 0);
    this.writeVert(v + 3, 0, 0, 0, 0, 0, 0, 0);
  }

  end(forceColorUpload = false): void {
    if (this.live === 0) {
      this.mesh.visible = false;
      this.lastEndLive = 0;
      return;
    }
    // position 由相机基变换后重写，必须上传；color/uv 是静态量，
    // 只在首帧或本帧可见槽位变化时上传，静止/同可见集下零重传。
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (this.live !== this.lastEndLive || forceColorUpload) {
      (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
      this.lastEndLive = this.live;
    }
    this.mesh.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private writeVert(
    vi: number,
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const p = vi * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    const c = vi * 4;
    this.colors[c] = r;
    this.colors[c + 1] = g;
    this.colors[c + 2] = b;
    this.colors[c + 3] = a;
  }
}
