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
 *
 * task-8：按 `.tmp/pcf/LOOK_FORENSICS.md` §2/§3 的建议取 2–4 HU 区间上沿 4 HU
 * （实机 17 px 的梁几乎全是 bloom；我们此前 3 HU 在 2000+ HU 处仍只剩 1–2 px）。
 */
const LASER_GLOW_HU = 4;
/** 辉光强度（乘以 beam 颜色；加色混合下等价于 Alpha）。取证建议 0.10–0.20，取 0.20 上沿。 */
const LASER_GLOW_INTENSITY = 0.20;
/**
 * Core 亮度补偿：PCF 颜色是 rendercolor×(renderamt/255)=0.392，几何宽度又只有 2×width=1 HU；
 * 没有 bloom 时细芯在近/中距离偏暗。这里只给 Core 顶点色乘 1.2（几何宽度不变），
 * 相当于补回一部分 bloom 的能量，见 LOOK_FORENSICS §3 的「实机 17 px 几乎全是 bloom」。
 */
const LASER_CORE_BOOST = 1.2;
/**
 * 远距可见性补偿（近似缺失的 HDR bloom）。Source 里 1 HU 细梁靠 HDR+bloom 在中远距离仍有
 * 2–4 px 的软晕；本工程没有 bloom，2200 HU 处 Core 只剩 ~0.3 px、4 HU Glow 只有 ~2.6 px，
 * 实测 L≈80 几乎不可见（见 `.tmp/look_after_auto42_far.png`）。这里做两件事，几何 Core 仍
 * 按 SDK 的 1 HU 不变：
 *  a) 屏幕空间最小 Glow 半宽：按相机 fov 与到梁中点的距离反算，保证 Glow 全宽 ≥ 4 px；
 *  b) 距离增益：500 HU 内增益 1（近景保持取证值），之后线性放大到最多 12 倍（≈2000 HU 以上），
 *     只在加色四边形的顶点色上乘，等效于把 bloom 扩散的能量手工补回来。
 */
const LASER_MIN_GLOW_PX = 4;
const LASER_FAR_GAIN_START_HU = 500;
const LASER_FAR_END_HU = 2000;
const LASER_FAR_GAIN_MAX = 12;
/** 最小屏幕宽反算出的 Glow 半宽上限，避免极远时 quad 宽到穿帮。 */
const LASER_GLOW_HU_MAX = 60;
/**
 * 中距亮度增益（task-14 / BRIGHTNESS_GAP §7 #9）：Auto42 实测 near/far 已对齐起源
 * （178.9/170.5 vs ref 174.4），只有 mid（≈600 HU）的 150.3 偏低 14%。这里只在中距
 * 窗口对 Core/Glow 顶点色乘 ×1.15（300–1500 HU，两端各留 150 HU 平滑过渡），
 * near(<300) 与 far(>1500) 的强度保持不变。
 */
const LASER_MID_GAIN = 1.15;
const LASER_MID_GAIN_RAMP_IN_HU = 300;
const LASER_MID_GAIN_FULL_HU = 450;
const LASER_MID_GAIN_FADE_START_HU = 1200;
const LASER_MID_GAIN_RAMP_OUT_HU = 1500;

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
  /** `trace()` 命中的材质名（诊断用；未命中为 undefined）。 */
  hitMaterial?: string;
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
 * 非实体表面：`env_laser` 的 trace 走 `MASK_SOLID`，水面、触发体、clip 刷、nodraw、天空盒
 * 都不参与命中；而 `Raycaster` 会命中它们的 mesh，导致梁被提前截断（用户报的「坡上该有的
 * 光线没画出来」多半就是这类误截）。BSP 里这些面都是具名材质，按材质名排除。
 */
function isNonSolidSurface(object: THREE.Object3D): boolean {
  const mesh = object as THREE.Mesh;
  const material = mesh.material;
  if (!material) return false;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some(
    (m) => typeof m?.name === 'string' && /water|trigger|tools[\\/]|nodraw|clip|sky/i.test(m.name),
  );
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
  private readonly tmpMid = new THREE.Vector3();
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
        // Core：忠实颜色 ×1.2 亮度补偿（几何宽度仍是 2×width，见 LASER_CORE_BOOST）。
        this.colors.set([c.r * LASER_CORE_BOOST, c.g * LASER_CORE_BOOST, c.b * LASER_CORE_BOOST], (i * vertsPerBeam + k) * 3);
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
    // 细激光要「实」不要泛光：不参与 bloom 光效层，保持清晰的加法亮线。
    this.mesh.userData.vbspNoGlow = true;
    this.root.add(this.mesh);
  }

  /**
   * 对场景几何做一次 `UTIL_TraceLine` 等价截断（12 条梁，静态地图只需一次）。
   *
   * 两种口径：
   * - 传 `physTrace` 时用**物理世界**的线段扫掠（只认实体 brush，天然忽略触发体/nodraw/水面，
   *   与 `MASK_SOLID` 同口径）——这是首选，`apps/debug` 有 `PhysWorld.debug_trace`；
   * - 否则退回 `Raycaster` + 材质名过滤（`trace(worldRoot)`），用于没有物理线的端。
   */
  trace(
    worldRoot: THREE.Object3D | null,
    physTrace?: (start: THREE.Vector3, end: THREE.Vector3) => number,
  ): void {
    const dir = new THREE.Vector3();
    for (const beam of this.beams) {
      dir.subVectors(beam.end, beam.start);
      const length = dir.length();
      if (length < 0.1) {
        beam.clippedEnd.copy(beam.end);
        beam.hitMaterial = undefined;
        continue;
      }
      dir.multiplyScalar(1 / length);
      if (physTrace) {
        const frac = physTrace(beam.start, beam.end);
        if (frac >= 0 && frac < 1) {
          beam.clippedEnd.copy(beam.start).addScaledVector(dir, Math.max(0, length * frac - 0.5));
          beam.hitMaterial = '(phys)';
        } else {
          beam.clippedEnd.copy(beam.end);
          beam.hitMaterial = undefined;
        }
        continue;
      }
      if (!worldRoot) return;
      const ray = new THREE.Raycaster();
      ray.set(beam.start, dir);
      ray.near = 0.5;
      ray.far = Math.max(0.5, length - 0.5);
      const hits = ray.intersectObject(worldRoot, true);
      const hit = hits.find((h) => isVisibleInHierarchy(h.object) && !isNonSolidSurface(h.object));
      if (hit) {
        beam.clippedEnd.copy(beam.start).addScaledVector(dir, hit.distance);
        const mat = (hit.object as THREE.Mesh).material;
        const first = Array.isArray(mat) ? mat[0] : mat;
        beam.hitMaterial = typeof first?.name === 'string' ? first.name : '(anon)';
      } else {
        beam.clippedEnd.copy(beam.end);
        beam.hitMaterial = undefined;
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
    const mid = this.tmpMid;
    const pa = this.positions;
    // 屏幕空间补偿所需的像素焦距：focalPx = (视口高/2) / tan(fov/2)。
    // 取 window.innerHeight 作为画布 CSS 高度（debug 页面 canvas 铺满窗口、dpr=1，截图 1304×876 佐证）。
    const viewH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 900;
    const persp = camera as THREE.PerspectiveCamera;
    const fovRad = persp.isPerspectiveCamera ? (persp.fov * Math.PI) / 180 : Math.PI / 3;
    const focalPx = viewH / 2 / Math.tan(fovRad / 2);
    const camPos = camera.position;
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
      // DrawSegs: m_flWidth = width*2，CBeamSegDraw 偏移 ±m_flWidth*0.5 ⇒ 半宽 = width。
      mid.addVectors(beam.start, beam.clippedEnd).multiplyScalar(0.5);
      const midDist = Math.max(1, mid.distanceTo(camPos));
      const pxPerHU = focalPx / midDist;
      const minHalfHU = (LASER_MIN_GLOW_PX * 0.5) / Math.max(1e-4, pxPerHU);
      const halfCore = beam.width;
      // Glow = 忠实宽度 + 取证辉光；若远处仍不足 3 px 宽，则用屏幕空间下限反算的半宽兜底。
      const halfGlow = Math.min(LASER_GLOW_HU_MAX, Math.max(beam.width + LASER_GLOW_HU, minHalfHU));
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
      // 距离增益只乘在 Glow 顶点色上：500 HU 内 gain=1（取证强度 0.20 不变），到 2000 HU
      // 线性放大到 12×，把缺失的 HDR bloom 能量手工补回来（见文件头 LASER_FAR_GAIN_* 注释）。
      const farT = Math.min(1, Math.max(0, (midDist - LASER_FAR_GAIN_START_HU) / (LASER_FAR_END_HU - LASER_FAR_GAIN_START_HU)));
      const gain = 1 + farT * (LASER_FAR_GAIN_MAX - 1);
      // 中距增益：300→450 HU 平滑升到 1.15，1200→1500 HU 平滑回到 1（near/far 不变）。
      const midIn = Math.min(1, Math.max(0, (midDist - LASER_MID_GAIN_RAMP_IN_HU) / (LASER_MID_GAIN_FULL_HU - LASER_MID_GAIN_RAMP_IN_HU)));
      const midOut = Math.min(1, Math.max(0, (midDist - LASER_MID_GAIN_FADE_START_HU) / (LASER_MID_GAIN_RAMP_OUT_HU - LASER_MID_GAIN_FADE_START_HU)));
      const midGain = 1 + (LASER_MID_GAIN - 1) * (midIn * (1 - midOut));
      const c = beam.color;
      // Core 顶点色逐帧写（中距增益依赖相机距离）：忠实颜色 ×1.2 亮度补偿 × midGain。
      const cr = c.r * LASER_CORE_BOOST * midGain;
      const cg = c.g * LASER_CORE_BOOST * midGain;
      const cb = c.b * LASER_CORE_BOOST * midGain;
      for (let k = 0; k < 4; k++) {
        const off = (base + k) * 3;
        this.colors[off] = cr;
        this.colors[off + 1] = cg;
        this.colors[off + 2] = cb;
      }
      const gr = c.r * LASER_GLOW_INTENSITY * gain * midGain;
      const gg = c.g * LASER_GLOW_INTENSITY * gain * midGain;
      const gb = c.b * LASER_GLOW_INTENSITY * gain * midGain;
      for (let k = 0; k < 4; k++) {
        const off = (base + 4 + k) * 3;
        this.colors[off] = gr;
        this.colors[off + 1] = gg;
        this.colors[off + 2] = gb;
      }
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
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
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

  /** 逐条诊断：全长/实画长度/命中材质（排查「该有的梁缺失」用）。 */
  detail(): Array<{ full: number; drawn: number; hit: string | null }> {
    return this.beams.map((beam) => ({
      full: Math.round(beam.start.distanceTo(beam.end)),
      drawn: Math.round(beam.start.distanceTo(beam.clippedEnd)),
      hit: beam.hitMaterial ?? null,
    }));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.root.clear();
  }
}
