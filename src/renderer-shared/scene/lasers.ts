/**
 * Source `env_laser` 光束的 three.js 实现。
 *
 * 语义来源（`test/project/source-sdk-2013-master/src/`）：
 * - `game/server/EnvLaser.cpp`：`spawnflags & SF_BEAM_STARTON(0x1)` 才点亮；每帧用
 *   `UTIL_TraceLine(GetAbsOrigin(), target->origin, MASK_SOLID)` 把梁截到墙面；
 *   `Spawn()` 里 `SetEndWidth(GetWidth())`（两端等宽），`TextureScroll` 是贴图周期/秒。
 * - `game/client/view_beams.cpp`：`DrawBeam` 里 `rendermode = kRenderTransAdd`（加法），
 *   颜色 = `rendercolor/255 × renderamt/255`；`freq = curtime × speed`。
 * - `game/client/beamdraw.cpp`：`DrawSegs` 的 `m_flWidth = width*2`（视觉全宽 = 2×width HU），
 *   贴图每 100 HU 一个 V 周期（`length *= 0.01` → `vStep`），加宽方向 =
 *   `normalize(Cross(viewForward, beamDir))`（面向相机的窄带）。
 *
 * 本图 12 对 `env_laser` 里只有 12 个 `spawnflags 1` 的 start 可见：width 0.5（→1 HU）、
 * rendercolor "203 249 254"、renderamt 100；另 12 个 `spawnflags 0` 的 endpoint 锚点不画。
 * 贴图 `sprites/laserbeam.spr` 不在 pakfile 里，这里用程序化横条贴图重建「亮核 + 柔边」。
 */

import * as THREE from 'three';

import { parseEntityBlocks, parseVec3 } from './particles.js';

/**
 * 辉光外扩半宽（HU）。Source 用 HDR + bloom 把 1 HU 的细梁「晕」到几个像素宽；
 * 本工程的加色管线没有 bloom，只画 Core 会在远处淡到看不见。这里在 Core（忠实 2×width）
 * 外面再叠一圈低强度加法 quad 模拟辉光 —— 几何宽度仍按 SDK，只补视觉上的发光扩散。
 */
const LASER_GLOW_HU = 3;
/** 辉光强度（乘以 beam 颜色；加色混合下等价于 Alpha）。 */
const LASER_GLOW_INTENSITY = 0.22;

/** 一条可见 `env_laser`（两头坐标已换到 Y-up 世界坐标）。 */
export interface LaserBeam {
  /** start 实体 origin（世界坐标，HU）。 */
  readonly start: THREE.Vector3;
  /** `LaserTarget` 指向的 endpoint origin（世界坐标，HU）。 */
  readonly end: THREE.Vector3;
  /** 被墙面截断后的终点（`trace()` 更新）。 */
  readonly clippedEnd: THREE.Vector3;
  /** `width` key（HU）；视觉全宽 = 2×width（见文件头 DrawSegs）。 */
  readonly width: number;
  /** `TextureScroll`：贴图 V 周期/秒（本图可见的 12 条都是 0）。 */
  readonly scrollRate: number;
  /** 加法色：rendercolor/255 × renderamt/255。 */
  readonly color: THREE.Color;
}

/** `sprites/laserbeam.spr` 缺失，程序化重建：横向亮核 + 柔边，纵向轻微亮带。 */
function makeLaserTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    // 贴图 V 方向一个周期内轻微明暗（laserbeam sprite 的脉冲观感，幅度压小以免出现横带）
    const band = 0.88 + 0.12 * (0.5 + 0.5 * Math.cos(v * Math.PI * 2));
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const d = u - 0.5;
      const core = Math.exp(-Math.pow(d / 0.10, 2));
      const halo = Math.exp(-Math.pow(d / 0.34, 2));
      const profile = Math.min(1, core * 1.15 + halo * 0.42) * band;
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, Math.round(profile * 255)));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 从 `entityIoJson` 的 `entities_text` 收集可见的 `env_laser`。 */
export function collectLaserBeams(entityIoJson?: string): LaserBeam[] {
  if (!entityIoJson) return [];
  let text = '';
  try {
    const payload = JSON.parse(entityIoJson) as { entities_text?: string };
    text = payload.entities_text ?? '';
  } catch {
    return [];
  }
  const blocks = parseEntityBlocks(text);
  // 先建 targetname → origin 索引，env_laser 的 LaserTarget 指向 endpoint 锚点的 targetname。
  const targets = new Map<string, THREE.Vector3>();
  for (const block of blocks) {
    const name = block['targetname'];
    if (!name) continue;
    const origin = block['origin'];
    if (!origin) continue;
    const src = parseVec3(origin, [0, 0, 0]);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)
    targets.set(name, new THREE.Vector3(src[1], src[2], src[0]));
  }
  const beams: LaserBeam[] = [];
  for (const block of blocks) {
    if (block['classname'] !== 'env_laser') continue;
    const spawnflags = Number.parseInt(block['spawnflags'] ?? '0', 10);
    // SF_BEAM_STARTON = 0x0001；否则 EnvLaser::Spawn 会 TurnOff（本图 12 个锚点就是这样关掉的）。
    if ((spawnflags & 0x0001) === 0) continue;
    const targetName = block['LaserTarget'];
    if (!targetName) continue;
    const end = targets.get(targetName);
    if (!end) continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const start = new THREE.Vector3(src[1], src[2], src[0]);
    const width = Math.max(0.001, Number.parseFloat(block['width'] ?? '1') || 1);
    const scrollRate = Number.parseFloat(block['TextureScroll'] ?? '0') || 0;
    const rgb = parseVec3(block['rendercolor'], [255, 255, 255]);
    const amount = Math.max(0, Math.min(255, Number.parseInt(block['renderamt'] ?? '255', 10) || 255));
    const k = amount / 255;
    const color = new THREE.Color().setRGB(
      (rgb[0] / 255) * k,
      (rgb[1] / 255) * k,
      (rgb[2] / 255) * k,
      THREE.SRGBColorSpace,
    );
    beams.push({
      start,
      end: end.clone(),
      clippedEnd: end.clone(),
      width,
      scrollRate,
      color,
    });
  }
  return beams;
}

/** 判断对象及其祖先是否都可见（射线只应命中可见几何，见 `trace()` 注释）。 */
function isVisibleInHierarchy(object: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = object;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * 水面不是 `MASK_SOLID` 的一部分（源引擎的 `env_laser` trace 用 `MASK_SOLID`，
 * 能穿过水），而 `Raycaster` 会命中水面 mesh，导致梁被水下/水面几何提前截断。
 * BSP 水面是独立 mesh 且带具名材质（`water*`），按材质名排除即可。
 */
function isNonSolidSurface(object: THREE.Object3D): boolean {
  const mesh = object as THREE.Mesh;
  const material = mesh.material;
  if (!material) return false;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((m) => typeof m?.name === 'string' && /water/i.test(m.name));
}

/** 渲染层：一个 BatchMesh（每束 Core + Glow 共 8 顶点 4 三角），每帧按相机重建面向相机的窄带。 */
export class LaserBeams {
  readonly root = new THREE.Group();
  private readonly beams: LaserBeam[];
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly texture: THREE.Texture;
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpPerp = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private elapsed = 0;

  constructor(beams: LaserBeam[]) {
    this.root.name = 'env-lasers';
    this.beams = beams;
    this.texture = makeLaserTexture();
    const vertsPerBeam = 8; // 前 4 = Core，后 4 = Glow
    this.positions = new Float32Array(beams.length * vertsPerBeam * 3);
    this.colors = new Float32Array(beams.length * vertsPerBeam * 3);
    const uvs = new Float32Array(beams.length * vertsPerBeam * 2);
    const indices: number[] = [];
    for (let i = 0; i < beams.length; i++) {
      const v = i * vertsPerBeam;
      // 每个 quad 的四角顺序：start+perp, start-perp, end-perp, end+perp（U 横跨宽度，V 沿长度）
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * vertsPerBeam * 2);
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], (i * vertsPerBeam + 4) * 2);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      indices.push(v + 4, v + 5, v + 6, v + 4, v + 6, v + 7);
      const c = beams[i].color;
      for (let k = 0; k < 4; k++) {
        this.colors.set([c.r, c.g, c.b], (i * vertsPerBeam + k) * 3);
        this.colors.set(
          [c.r * LASER_GLOW_INTENSITY, c.g * LASER_GLOW_INTENSITY, c.b * LASER_GLOW_INTENSITY],
          (i * vertsPerBeam + 4 + k) * 3,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    this.geometry = geometry;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      vertexColors: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.root.add(this.mesh);
  }

  /**
   * 对场景几何做一次 `UTIL_TraceLine` 等价截断（12 条梁，静态地图只需一次）。
   * `worldRoot` 是 BSP 主 mesh 根；命中则把梁缩短到命中点，否则用目标的 origin。
   * 只认「可见」命中：场景里还有 241 个隐藏 brush mesh（旋转按钮的初始隐藏态、skybox 等），
   * three 的 Raycaster 不会跳过它们，必须手动过滤，否则梁会在起点附近 30 HU 处被截断。
   */
  trace(worldRoot: THREE.Object3D | null): void {
    if (!worldRoot) return;
    const ray = new THREE.Raycaster();
    const dir = new THREE.Vector3();
    for (const beam of this.beams) {
      dir.subVectors(beam.end, beam.start);
      const length = dir.length();
      if (length < 0.1) {
        beam.clippedEnd.copy(beam.end);
        continue;
      }
      dir.multiplyScalar(1 / length);
      ray.set(beam.start, dir);
      ray.near = 0.5;
      ray.far = Math.max(0.5, length - 0.5);
      const hits = ray.intersectObject(worldRoot, true);
      const hit = hits.find((h) => isVisibleInHierarchy(h.object) && !isNonSolidSurface(h.object));
      if (hit) {
        beam.clippedEnd.copy(beam.start).addScaledVector(dir, hit.distance);
      } else {
        beam.clippedEnd.copy(beam.end);
      }
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.elapsed += dt;
    camera.getWorldDirection(this.tmpForward);
    const forward = this.tmpForward;
    const dir = this.tmpDir;
    const perp = this.tmpPerp;
    const fallback = this.tmpUp;
    const pa = this.positions;
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i];
      const base = i * 8;
      dir.subVectors(beam.clippedEnd, beam.start);
      const length = dir.length();
      if (length < 0.1) {
        // 退化梁：八个顶点都收到起点，不可见
        for (let k = 0; k < 8; k++) {
          const off = (base + k) * 3;
          pa[off] = beam.start.x;
          pa[off + 1] = beam.start.y;
          pa[off + 2] = beam.start.z;
        }
        continue;
      }
      dir.multiplyScalar(1 / length);
      // ComputeBeamPerpendicular: perp = normalize(Cross(viewForward, beamDir))
      perp.crossVectors(forward, dir);
      if (perp.lengthSq() < 1e-6) perp.copy(fallback);
      else perp.normalize();
      // DrawSegs: m_flWidth = width*2，CBeamSegDraw 偏移 ±m_flWidth*0.5 ⇒ 半宽 = width
      const halfCore = beam.width;
      const halfGlow = beam.width + LASER_GLOW_HU;
      const writeQuad = (vertBase: number, half: number): void => {
        const b = vertBase * 3;
        // 0=start+perp, 1=start-perp, 2=end-perp, 3=end+perp
        pa[b] = beam.start.x + perp.x * half;
        pa[b + 1] = beam.start.y + perp.y * half;
        pa[b + 2] = beam.start.z + perp.z * half;
        pa[b + 3] = beam.start.x - perp.x * half;
        pa[b + 4] = beam.start.y - perp.y * half;
        pa[b + 5] = beam.start.z - perp.z * half;
        pa[b + 6] = beam.clippedEnd.x - perp.x * half;
        pa[b + 7] = beam.clippedEnd.y - perp.y * half;
        pa[b + 8] = beam.clippedEnd.z - perp.z * half;
        pa[b + 9] = beam.clippedEnd.x + perp.x * half;
        pa[b + 10] = beam.clippedEnd.y + perp.y * half;
        pa[b + 11] = beam.clippedEnd.z + perp.z * half;
      };
      writeQuad(base, halfCore);
      writeQuad(base + 4, halfGlow);
    }
    const uvAttr = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i];
      const length = beam.clippedEnd.distanceTo(beam.start);
      const v0 = beam.scrollRate * this.elapsed;
      const v1 = v0 + length / 100;
      const uvBase = i * 8;
      uvAttr.setXY(uvBase, 0, v0);
      uvAttr.setXY(uvBase + 1, 1, v0);
      uvAttr.setXY(uvBase + 2, 1, v1);
      uvAttr.setXY(uvBase + 3, 0, v1);
      uvAttr.setXY(uvBase + 4, 0, v0);
      uvAttr.setXY(uvBase + 5, 1, v0);
      uvAttr.setXY(uvBase + 6, 1, v1);
      uvAttr.setXY(uvBase + 7, 0, v1);
    }
    uvAttr.needsUpdate = true;
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = this.beams.length > 0;
  }

  /** 诊断：可见梁数量与截断后的总长度（HU）。 */
  stats(): { beams: number; clipped: number; length: number } {
    let clipped = 0;
    let length = 0;
    for (const beam of this.beams) {
      const full = beam.start.distanceTo(beam.end);
      const cut = beam.start.distanceTo(beam.clippedEnd);
      length += cut;
      if (cut < full - 0.5) clipped++;
    }
    return { beams: this.beams.length, clipped, length: Math.round(length) };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.root.clear();
  }
}
