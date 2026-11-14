/**
 * PCF 粒子系统的最小 three.js 实现（task-2）。
 *
 * 数据来源：`buildWorldBundle().entityIoJson` 里的 `entities_text`（Source 实体原文）。
 * 本轮只做 surf_boreas 的 `tendies_*` 家族：
 * - `tendies_endparticle01`：紫色光柱本体（PCF 里是 render_rope + laser.vmt + 3s 寿命的下落粒子链，
 *   可视化为从发射点向上的一根滚动纹理光柱）；
 * - `tendies_alch01*`：符文盘的辉光（PCF 里是 render_animated_sprites + glow 材质）。
 *
 * 之所以先做“可视化”而不是完整 PCF 模拟：PCF 的 rope/trail 几何算法在本机没有权威实现可对照，
 * 这里按观感复刻（见 `.tmp/pcf/CONCLUSION.md` 的不确定项），后续有对照图再逐项校准。
 *
 * 坐标：实体 origin 是 Source 空间，`map_coords = [y, z, x]`（见
 * `src/wasm-core/model_integrator/mod.rs` 的 `map_coords`），故 world = (src.y, src.z, src.x)。
 */

import * as THREE from 'three';

/** 一条 `info_particle_system` 实体（已换算到 Y-up 世界坐标）。 */
export interface ParticleEntity {
  effect: string;
  /** 世界坐标（Y-up，HU）。 */
  origin: [number, number, number];
  /** Source angles（pitch yaw roll，度）。 */
  angles: [number, number, number];
}

/** 光柱参数（按效果名，单位 HU）。 */
interface BeamProfile {
  height: number;
  radiusBottom: number;
  radiusTop: number;
  /** 纹理沿长度每秒滚动多少「整张」。 */
  scroll: number;
  opacity: number;
}

const BEAM_PROFILES: Record<string, BeamProfile> = {
  // endparticle01 的 rope 子层：laser.vmt + 3s 寿命；按观感取「从盘口向上张开」的紫白光柱。
  tendies_endparticle01: { height: 2200, radiusBottom: 45, radiusTop: 110, scroll: 0.5, opacity: 0.16 },
};

/** 辉光类效果（animated sprites）：按半径给一个 billboard 大小。 */
const GLOW_PROFILES: Record<string, { size: number; color: number; count: number }> = {
  tendies_alch01: { size: 22, color: 0xb58cff, count: 8 },
  tendies_alch01_large: { size: 40, color: 0xb58cff, count: 10 },
  tendies_alch01_smol: { size: 14, color: 0xb58cff, count: 6 },
  tendies_snow01: { size: 14, color: 0xffffff, count: 12 },
};

interface GlowCluster {
  sprites: THREE.Sprite[];
  basePositions: THREE.Vector3[];
  phases: number[];
  drift: number[];
  elapsed: number;
}

function parseEntityBlocks(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line === '{') {
      cur = {};
      continue;
    }
    if (line === '}') {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (line.charCodeAt(0) !== 34 /* '"' */ || cur === null) continue;
    const firstEnd = line.indexOf('"', 1);
    if (firstEnd < 0) continue;
    const key = line.slice(1, firstEnd);
    let value = '';
    const rest = line.slice(firstEnd + 1).trim();
    if (rest.charCodeAt(0) === 34) {
      const secondEnd = rest.indexOf('"', 1);
      if (secondEnd > 0) value = rest.slice(1, secondEnd);
    }
    if (!(key in cur)) cur[key] = value;
  }
  return out;
}

function parseVec3(raw: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!raw) return fallback;
  const parts = raw.trim().split(/\s+/).map((v) => Number(v));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return fallback;
  return [parts[0], parts[1], parts[2]];
}

/** 从 `entityIoJson` 里挑出所有 `info_particle_system`（start_active=0 也保留，运行期可再判断）。 */
export function collectParticleEntities(entityIoJson?: string): ParticleEntity[] {
  if (!entityIoJson) return [];
  let text = '';
  try {
    const payload = JSON.parse(entityIoJson) as { entities_text?: string };
    text = payload.entities_text ?? '';
  } catch {
    return [];
  }
  const out: ParticleEntity[] = [];
  for (const block of parseEntityBlocks(text)) {
    if (block['classname'] !== 'info_particle_system') continue;
    const effect = block['effect_name'];
    if (!effect) continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const angles = parseVec3(block['angles'], [0, 0, 0]);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)
    out.push({ effect, origin: [src[1], src[2], src[0]], angles });
  }
  return out;
}

function makeBeamTexture(): THREE.Texture {
  const width = 64;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1); // 0 = 顶端，1 = 底端（贴图 offset 滚动方向沿长度）
    // 底端更亮、向顶端淡出；再叠两条细亮纹模拟 laser 贴图的竖向条纹
    const along = Math.max(0, 1 - v * 0.85);
    const stripe = 0.72 + 0.28 * Math.cos(v * Math.PI * 2 * 3.0);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const across = Math.pow(Math.cos((u - 0.5) * Math.PI), 1.4);
      const core = Math.pow(across, 3.2);
      const a = Math.max(0, Math.min(1, across * along * stripe * 0.8));
      const i = (y * width + x) * 4;
      // 紫白：外缘偏紫，中心近白；底端比顶端亮
      img.data[i] = Math.round(100 + 95 * core + 20 * v);
      img.data[i + 1] = Math.round(60 + 120 * core + 25 * v);
      img.data[i + 2] = Math.round(230 + 25 * core);
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 粒子系统集合：构造时按实体表建好静态光柱与辉光，`update` 只做纹理滚动与辉光呼吸。
 * 没有任何可渲染实体时 `root.children.length === 0`，调用方不要挂到场景（零开销）。
 */
export class ParticleSystems {
  readonly root = new THREE.Group();
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly glowTexture: THREE.Texture;
  private readonly beams: THREE.Mesh[] = [];
  private readonly glowClusters: GlowCluster[] = [];
  private elapsed = 0;

  constructor(entities: ParticleEntity[]) {
    this.root.name = 'particle-systems';
    this.beamMaterial = new THREE.MeshBasicMaterial({
      map: makeBeamTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: false,
      toneMapped: false,
      opacity: 1,
    });
    this.glowTexture = makeGlowTexture();

    for (const entity of entities) {
      const beam = BEAM_PROFILES[entity.effect];
      if (beam) {
        this.beams.push(this.buildBeam(entity, beam));
        continue;
      }
      const glow = GLOW_PROFILES[entity.effect];
      if (glow) this.glowClusters.push(this.buildGlow(entity, glow));
    }
  }

  private buildBeam(entity: ParticleEntity, profile: BeamProfile): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(profile.radiusTop, profile.radiusBottom, profile.height, 24, 1, true);
    const mesh = new THREE.Mesh(geometry, this.beamMaterial.clone());
    mesh.position.set(entity.origin[0], entity.origin[1] + profile.height / 2, entity.origin[2]);
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.opacity = profile.opacity;
    material.map = this.beamMaterial.map?.clone() ?? null;
    if (material.map) {
      material.map.wrapS = THREE.RepeatWrapping;
      material.map.wrapT = THREE.RepeatWrapping;
      material.map.needsUpdate = true;
    }
    this.root.add(mesh);
    return mesh;
  }

  private buildGlow(entity: ParticleEntity, glow: { size: number; color: number; count: number }): GlowCluster {
    const sprites: THREE.Sprite[] = [];
    const basePositions: THREE.Vector3[] = [];
    const phases: number[] = [];
    const drift: number[] = [];
    for (let i = 0; i < glow.count; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: glow.color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        opacity: 0.32,
      });
      const sprite = new THREE.Sprite(material);
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * glow.size * 0.8,
        Math.random() * glow.size * 1.4,
        (Math.random() - 0.5) * glow.size * 0.8,
      );
      const base = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]).add(offset);
      sprite.position.copy(base);
      sprite.scale.setScalar(glow.size * (0.5 + Math.random() * 0.7));
      sprite.renderOrder = 11;
      sprites.push(sprite);
      basePositions.push(base);
      phases.push(Math.random() * Math.PI * 2);
      drift.push(8 + Math.random() * 18);
      this.root.add(sprite);
    }
    return { sprites, basePositions, phases, drift, elapsed: Math.random() * 4 };
  }

  /** 每帧推进：纹理滚动 + 辉光呼吸/上浮。`dt` 单位秒。 */
  update(dt: number): void {
    this.elapsed += dt;
    const beamMap = this.beamMaterial.map;
    if (beamMap) beamMap.offset.y = (beamMap.offset.y - dt * 0.55) % 1;
    for (const mesh of this.beams) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      const map = material.map;
      if (map) map.offset.y = (map.offset.y - dt * 0.55) % 1;
    }
    for (const cluster of this.glowClusters) {
      cluster.elapsed += dt;
      for (let i = 0; i < cluster.sprites.length; i++) {
        const t = cluster.elapsed * 0.5 + cluster.phases[i];
        const sprite = cluster.sprites[i];
        const material = sprite.material as THREE.SpriteMaterial;
        material.opacity = 0.14 + 0.18 * (0.5 + 0.5 * Math.sin(t));
        const base = cluster.basePositions[i];
        sprite.position.set(
          base.x + Math.sin(t * 0.7) * 4,
          base.y + ((cluster.elapsed * cluster.drift[i]) % 24),
          base.z + Math.cos(t * 0.9) * 4,
        );
      }
    }
  }

  dispose(): void {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material;
      if (Array.isArray(material)) {
        for (const m of material) m.dispose();
      } else if (material) {
        material.dispose();
      }
    });
    this.root.clear();
    this.beamMaterial.map?.dispose();
    this.beamMaterial.dispose();
    this.glowTexture.dispose();
    this.beams.length = 0;
    this.glowClusters.length = 0;
  }

  /** 诊断：当前挂了多少光柱 / 辉光簇（面板或 CDP 用）。 */
  stats(): { beams: number; glowClusters: number; sprites: number } {
    return {
      beams: this.beams.length,
      glowClusters: this.glowClusters.length,
      sprites: this.glowClusters.reduce((sum, c) => sum + c.sprites.length, 0),
    };
  }
}
