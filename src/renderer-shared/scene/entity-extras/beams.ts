/**
 * `env_beam` 的加法光束（面向相机的四边形带）。
 *
 * 语义来源（`test/project/source-sdk-2013-master/src/game/server/EnvBeam.cpp` +
 * `game/client/view_beams.cpp` / `beamdraw.cpp`）：
 * - `LightningStart` / `LightningEnd` 是两个**实体名**，取它们的 `origin` 作为两端；
 *   解析不到时退回自身 `origin` / `targetpoint` 坐标；
 * - `BoltWidth` 是宽度、`rendercolor`/`renderamt` 是颜色与亮度；
 * - 客户端 `DrawBeam` 走 `kRenderTransAdd`（加法），加宽方向 =
 *   `normalize(Cross(viewForward, beamDir))`（与 `lasers.ts` 同口径的面向相机窄带）。
 *
 * **近似**：`sprites/physbeam.vmt` 不在资产里，横截面用程序化半椭圆剖面
 * （`textures.ts` 的 `makeBeamTexture()`）；`NoiseAmplitude` 的闪电抖动、
 * `life`/`StrikeTime` 的触发时序都没实现（本图只有 1 条、验收只要求可见）。
 * 本图 `spawnflags=48` 未置 `SF_BEAM_STARTON(1)`，Source 里它要等触发器点亮；
 * 这里按「资产实体常显」处理（任务验收口径），报告里标 [待确认]。
 */

import * as THREE from 'three';

import { parseVec3, type EntityBlockRecords } from '../particles.js';
import { parseEntityColor } from './colors.js';
import { makeBeamTexture } from './textures.js';

/** `BoltWidth` 缺失时的宽度（HU，Source 默认 2）。 */
const DEFAULT_BOLT_WIDTH = 2;
/** 画在透明光效层最后（lasers 13 之后）。 */
const BEAM_RENDER_ORDER = 14;

/** 一条 `env_beam`（两端已换算到 Y-up 世界坐标）。 */
export interface BeamEntity {
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** 视觉全宽（HU）。 */
  width: number;
  /** 线性空间颜色（`rendercolor × renderamt/255`）。 */
  color: THREE.Color;
}

/** 从实体键值块里收集 `env_beam`。 */
export function collectBeamEntities(blocks: EntityBlockRecords): BeamEntity[] {
  /** `targetname` → 世界坐标（同名取第一个，与 lasers.ts 的 targetname 解析口径一致）。 */
  const origins = new Map<string, [number, number, number]>();
  for (const block of blocks) {
    const name = (block['targetname'] ?? '').trim();
    if (name.length === 0 || origins.has(name)) continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)。
    origins.set(name, [src[1], src[2], src[0]]);
  }
  const out: BeamEntity[] = [];
  for (const block of blocks) {
    if (block['classname'] !== 'env_beam') continue;
    const ownSrc = parseVec3(block['origin'], [0, 0, 0]);
    const own = new THREE.Vector3(ownSrc[1], ownSrc[2], ownSrc[0]);
    const startName = (block['LightningStart'] ?? '').trim();
    const endName = (block['LightningEnd'] ?? '').trim();
    const startOrigin = startName.length > 0 ? origins.get(startName) : undefined;
    const endOrigin = endName.length > 0 ? origins.get(endName) : undefined;
    const start = startOrigin
      ? new THREE.Vector3(startOrigin[0], startOrigin[1], startOrigin[2])
      : own.clone();
    let end: THREE.Vector3;
    if (endOrigin) {
      end = new THREE.Vector3(endOrigin[0], endOrigin[1], endOrigin[2]);
    } else {
      const targetSrc = parseVec3(block['targetpoint'], [Number.NaN, Number.NaN, Number.NaN]);
      end = Number.isFinite(targetSrc[0])
        ? new THREE.Vector3(targetSrc[1], targetSrc[2], targetSrc[0])
        : start.clone().add(new THREE.Vector3(0, 0, -64));
    }
    if (!(start.distanceTo(end) > 1e-3)) continue;
    const widthRaw = Number.parseFloat(block['BoltWidth'] ?? '');
    const width = Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : DEFAULT_BOLT_WIDTH;
    const color = new THREE.Color();
    parseEntityColor(block['rendercolor'], block['renderamt'], color);
    out.push({ start, end, width, color });
  }
  return out;
}

/** 一整类 `env_beam`：所有光束一个加法 ribbon mesh，1 次 draw；每帧按视线重写加宽方向。 */
export class Beams {
  readonly root = new THREE.Group();
  readonly count: number;
  private readonly beams: BeamEntity[];
  private readonly texture: THREE.Texture | null;
  private readonly geometry: THREE.BufferGeometry | null;
  private readonly material: THREE.MeshBasicMaterial | null;
  private readonly positions: Float32Array;
  private readonly viewDir = new THREE.Vector3();
  private readonly beamDir = new THREE.Vector3();
  private readonly perp = new THREE.Vector3();
  private startClusters: Int32Array | null = null;
  private endClusters: Int32Array | null = null;
  private mesh: THREE.Mesh | null = null;
  private readonly lastViewDir = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  private lastVisHash = -1;
  private lastVisibleCount = -1;

  constructor(beams: BeamEntity[]) {
    this.beams = beams;
    this.count = beams.length;
    this.root.name = 'entity-beams';
    const quads = Math.max(1, beams.length);
    this.positions = new Float32Array(quads * 12);
    const colors = new Float32Array(quads * 16);
    const uvs = new Float32Array(quads * 8);
    const indices: number[] = [];
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const uvOffset = q * 8;
      // 顶点顺序 p0/p1/p2/p3 = 起点-半宽 / 起点+半宽 / 终点+半宽 / 终点-半宽。
      uvs[uvOffset] = 0;
      uvs[uvOffset + 1] = 0;
      uvs[uvOffset + 2] = 1;
      uvs[uvOffset + 3] = 0;
      uvs[uvOffset + 4] = 1;
      uvs[uvOffset + 5] = 1;
      uvs[uvOffset + 6] = 0;
      uvs[uvOffset + 7] = 1;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      if (q < beams.length) {
        const color = beams[q].color;
        const colorOffset = q * 16;
        for (let vert = 0; vert < 4; vert++) {
          const c = colorOffset + vert * 4;
          colors[c] = color.r;
          colors[c + 1] = color.g;
          colors[c + 2] = color.b;
          colors[c + 3] = 1;
        }
      }
    }
    this.texture = makeBeamTexture();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, quads * 6);
    this.geometry = geometry;
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    this.material = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = BEAM_RENDER_ORDER;
    mesh.userData.vbspNoCull = true;
    this.mesh = mesh;
    this.root.add(mesh);
  }

  get draws(): number {
    return this.beams.length > 0 ? 1 : 0;
  }

  /** 每帧按视线方向重写加宽方向（`Cross(viewForward, beamDir)`），与 `lasers.ts` 同口径，并按 PVS 剔除不可见房间光束。 */
  update(
    camera: THREE.Camera,
    pvs: { isVisible(clusterId: number): boolean; getClusterAt(pos: { x: number; y: number; z: number }): number } | null = null,
  ): void {
    if (this.beams.length === 0) return;
    if (pvs && !this.startClusters) {
      this.startClusters = new Int32Array(this.beams.length);
      this.endClusters = new Int32Array(this.beams.length);
      for (let i = 0; i < this.beams.length; i++) {
        this.startClusters[i] = pvs.getClusterAt(this.beams[i].start);
        this.endClusters[i] = pvs.getClusterAt(this.beams[i].end);
      }
    }
    let visHash = 0;
    let visibleCount = 0;
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i];
      const pvsCulled =
        pvs !== null
        && this.startClusters !== null
        && this.endClusters !== null
        && this.startClusters[i] >= 0
        && this.endClusters[i] >= 0
        && !pvs.isVisible(this.startClusters[i])
        && !pvs.isVisible(this.endClusters[i]);
      if (!pvsCulled && beam.start.distanceToSquared(beam.end) > 1e-6) {
        visibleCount++;
        visHash = (visHash * 31 + (i + 1)) | 0;
      }
    }
    if (visibleCount === 0) {
      if (this.mesh) this.mesh.visible = false;
      this.lastVisHash = visHash;
      this.lastVisibleCount = 0;
      return;
    }
    camera.getWorldDirection(this.viewDir);
    if (
      visHash === this.lastVisHash
      && visibleCount === this.lastVisibleCount
      && this.viewDir.dot(this.lastViewDir) > 0.999999
    ) {
      if (this.mesh) this.mesh.visible = true;
      return;
    }
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i];
      const pvsCulled =
        pvs !== null
        && this.startClusters !== null
        && this.endClusters !== null
        && this.startClusters[i] >= 0
        && this.endClusters[i] >= 0
        && !pvs.isVisible(this.startClusters[i])
        && !pvs.isVisible(this.endClusters[i]);
      this.beamDir.subVectors(beam.end, beam.start);
      const length = this.beamDir.length();
      const v = i * 4;
      if (pvsCulled || !(length > 1e-3)) {
        // 退化或 PVS 不可见光束：塌成零面积。
        for (let vert = 0; vert < 4; vert++) {
          const p = (v + vert) * 3;
          this.positions[p] = beam.start.x;
          this.positions[p + 1] = beam.start.y;
          this.positions[p + 2] = beam.start.z;
        }
        continue;
      }
      this.beamDir.multiplyScalar(1 / length);
      this.perp.crossVectors(this.viewDir, this.beamDir);
      if (this.perp.lengthSq() < 1e-8) {
        // 视线与梁几乎平行：退化成一个方向（保证有面积，不产生 NaN）。
        this.perp.set(1, 0, 0);
      }
      this.perp.normalize().multiplyScalar(beam.width * 0.5);
      const { x: px, y: py, z: pz } = this.perp;
      const s = beam.start;
      const e = beam.end;
      const write = (vert: number, x: number, y: number, z: number): void => {
        const offset = (v + vert) * 3;
        this.positions[offset] = x;
        this.positions[offset + 1] = y;
        this.positions[offset + 2] = z;
      };
      write(0, s.x - px, s.y - py, s.z - pz);
      write(1, s.x + px, s.y + py, s.z + pz);
      write(2, e.x + px, e.y + py, e.z + pz);
      write(3, e.x - px, e.y - py, e.z - pz);
    }
    if (this.geometry) {
      (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    if (this.mesh) this.mesh.visible = true;
    this.lastViewDir.copy(this.viewDir);
    this.lastVisHash = visHash;
    this.lastVisibleCount = visibleCount;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.texture?.dispose();
    this.root.clear();
  }
}
