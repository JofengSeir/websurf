/**
 * PCF 粒子系统的 three.js 实现（最小子集）。
 *
 * 数据来源：`buildWorldBundle().entityIoJson` 里的 `entities_text`（Source 实体原文）。
 * 本轮只做 surf_boreas 的 `tendies_*` 家族：
 * - `tendies_endparticle01`：紫色光柱。PCF 里是「父层 sprite_trail + 子层 rope」，
 *   rope 的粒子按 emit_continuously(8/s) 发射、lifetime 3s、gravity +1000（沿粒子局部轴）。
 *   Position Within Box Random (0,0,-256)、Alpha Fade and Decay；这里按「粒子链 ribbon」实现：
 *   发射-重力-寿命模拟 + 面向相机的条带 + 每 64 HU 一个纹理平铺 + UV 沿长度滚动。
 * - `tendies_alch01*`：符文盘辉光（animated sprites），用 billboard 加法 sprite 近似。
 *
 * 坐标：实体 origin 是 Source 空间，`map_coords = [y, z, x]`（见
 * `src/wasm-core/model_integrator/mod.rs` 的 `map_coords`），故 world = (src.y, src.z, src.x)。
 * 实体 angles 的 pitch=-90 表示朝上：粒子链的「上」取世界 +Y（本轮地图里的效果都是竖直的）。
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

/** rope 类光柱的模拟/绘制参数（HU、秒）。 */
interface RopeProfile {
  /** 每秒发射的粒子数（PCF emission_rate）。 */
  rate: number;
  /** 粒子寿命（秒）。 */
  lifetime: number;
  /** 沿 +Y 的加速度（HU/s2；PCF gravity 1000）。 */
  gravity: number;
  /** 粒子相对实体原点的偏移（HU，Y-up）。 */
  spawnOffset: [number, number, number];
  /** 光柱宽度（HU）。 */
  width: number;
  /** 贴图沿长度每格长度（HU；PCF texel_size）。 */
  texelSize: number;
  /** UV 每秒滚动速度（PCF texture_scroll_rate）。 */
  scroll: number;
  /** 整体不透明度。 */
  opacity: number;
}

const ROPE_PROFILES: Record<string, RopeProfile> = {
// tendies_endparticle01 的 rope 子层（endparticle05）
  tendies_endparticle01: {
    rate: 8,
    lifetime: 3,
    gravity: 1000,
    spawnOffset: [0, -256, 0],
    width: 1500,
    texelSize: 4096,
    scroll: 0.25,
    opacity: 1,
  },
};

// ── 符文祭坛（alch）粒子层 ────────────────────────────────────────────────────
// 环的 brush 几何与旋转由 ALCH_SYMBOLS 实体（rot-buttons）负责，见 `.tmp/pcf/ALCH_PARAMS.md`；
// 这里只实现每站点叠加的两层 PCF 粒子：父层 render_animated_sprites 光点 + 子层 render_sprite_trail 拖尾。
// 数值全部来自 `.tmp/pcf/tendies-dump.json`（PCF 定义），不再使用猜测尺寸。

/** `render_animated_sprites` 父层：小光点（quad 半宽 = Radius Random，HU）。 */
interface AlchSpriteLayer {
  /** Radius Random min/max（HU）。 */
  radiusMin: number;
  radiusMax: number;
  /** Lifetime Random min/max（秒）。 */
  lifeMin: number;
  lifeMax: number;
  /** Alpha Random min/max（0..255，运行时 /255）。 */
  alphaMin: number;
  alphaMax: number;
  /** Position Within Sphere Random distance_min/max（HU，整球散布）。 */
  distanceMin: number;
  distanceMax: number;
  /** Movement Basic gravity（HU/s²，世界 +Y）。 */
  gravity: number;
  /** Movement Max Velocity（HU/s）。 */
  maxVelocity: number;
  /** emit_continuously rate（每秒）。 */
  rate: number;
  /** PCF max_particles。 */
  maxParticles: number;
  /** settings color（DPS color，rgb）。 */
  color: number;
}

/** `render_sprite_trail` 子层：水平盘上的一圈淡拖尾。 */
interface AlchTrailLayer {
  /** 拖尾宽度 = settings radius（HU）。 */
  width: number;
  lifeMin: number;
  lifeMax: number;
  alphaMin: number;
  alphaMax: number;
  /** Position Within Sphere Random distance_min/max（HU，bias [1,1,0] ⇒ 水平盘）。 */
  distanceMin: number;
  distanceMax: number;
  gravity: number;
  maxVelocity: number;
  rate: number;
  maxParticles: number;
  /** render_sprite_trail min/max length（HU）。 */
  trailMin: number;
  trailMax: number;
  color: number;
}

interface AlchProfile {
  sprite: AlchSpriteLayer;
  trail: AlchTrailLayer;
}

const ALCH_PROFILES: Record<string, AlchProfile> = {
  // 父层 max 16 / radius 2 / color [209,184,184] / rate 4；子层 max 6 / trail 512–1024。
  tendies_alch01: {
    sprite: {
      radiusMin: 3,
      radiusMax: 6,
      lifeMin: 2,
      lifeMax: 6,
      alphaMin: 55,
      alphaMax: 180,
      distanceMin: 32,
      distanceMax: 96,
      gravity: 999,
      maxVelocity: 64,
      rate: 4,
      maxParticles: 16,
      color: 0xd1b8b8,
    },
    trail: {
      width: 16,
      lifeMin: 1,
      lifeMax: 6,
      alphaMin: 24,
      alphaMax: 32,
      distanceMin: 16,
      distanceMax: 32,
      gravity: 99999,
      maxVelocity: 128,
      rate: 1,
      maxParticles: 6,
      trailMin: 512,
      trailMax: 1024,
      color: 0xffffff,
    },
  },
  // large：sprite lifetime 2–16 / radius 3–9 / sphere 32–64；trail min 777 max 1500。
  tendies_alch01_large: {
    sprite: {
      radiusMin: 3,
      radiusMax: 9,
      lifeMin: 2,
      lifeMax: 16,
      alphaMin: 55,
      alphaMax: 180,
      distanceMin: 32,
      distanceMax: 64,
      gravity: 999,
      maxVelocity: 64,
      rate: 4,
      maxParticles: 16,
      color: 0xd1b8b8,
    },
    trail: {
      width: 16,
      lifeMin: 2,
      lifeMax: 8,
      alphaMin: 24,
      alphaMax: 32,
      distanceMin: 16,
      distanceMax: 32,
      gravity: 99999,
      maxVelocity: 128,
      rate: 1,
      maxParticles: 6,
      trailMin: 777,
      trailMax: 1500,
      color: 0xffffff,
    },
  },
  // smol：sprite radius 0.25–1 / sphere 16–32 / MaxVel 4；trail width 4 / min 128 max 256。
  tendies_alch01_smol: {
    sprite: {
      radiusMin: 0.25,
      radiusMax: 1,
      lifeMin: 2,
      lifeMax: 6,
      alphaMin: 55,
      alphaMax: 180,
      distanceMin: 16,
      distanceMax: 32,
      gravity: 999,
      maxVelocity: 4,
      rate: 4,
      maxParticles: 16,
      color: 0xd1b8b8,
    },
    trail: {
      width: 4,
      lifeMin: 2,
      lifeMax: 8,
      alphaMin: 24,
      alphaMax: 32,
      distanceMin: 1,
      distanceMax: 4,
      gravity: 999,
      maxVelocity: 16,
      rate: 1,
      maxParticles: 6,
      trailMin: 128,
      trailMax: 256,
      color: 0xffffff,
    },
  },
};

/** 其余辉光效果（snow 仍是近似值，等参数表再替换）。 */
const GLOW_PROFILES: Record<string, { size: number; color: number; count: number }> = {
  tendies_snow01: { size: 14, color: 0xffffff, count: 12 },
};

/** 一个 rope 粒子（发射时刻、位置、速度）。 */
interface RopePoint {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
}

/** 解析 Source `.ent`/`entities_text` 的键值块（`{ "key" "value" ... }`），供粒子与激光共用。 */
export function parseEntityBlocks(text: string): Array<Record<string, string>> {
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

export function parseVec3(raw: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!raw) return fallback;
  const parts = raw.trim().split(/\s+/).map((v) => Number(v));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return fallback;
  return [parts[0], parts[1], parts[2]];
}

/** 从 `entityIoJson` 解析出所有 `info_particle_system`。 */
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

/**
 * `laser01.vtf` 的放射重建：横截面软边渐变（紫边 → 白核）。
 *
 * 说明：原贴图 32×64 带竖向亮线，但它来自 sprite 材质的像素级细节，平铺到几千 HU 长的
 * 光柱上会变成「虚线」。这里沿 V 方向保持恒定，只保留横截面的亮度分布，平铺后无缝。
 * 光柱是连续柔光；改用「沿长度的透明度衰减」表现远近亮度差。
 */
function makeBeamTexture(): THREE.Texture {
  const width = 64;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    // 参考图里光柱是连续柔和的，纵向只做很轻的噪声（避免出现横向亮带）。
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      // 横截面：中心近白亮核 + 两侧渐弱的紫晕。
      const dc = (u - 0.5) / 0.055;
      const core = Math.exp(-dc * dc);
      const dh = (u - 0.5) / 0.018;
      const hot = Math.exp(-dh * dh);
      const dw = (u - 0.5) / 0.62;
      const wing = 1.05 * Math.exp(-dw * dw);
      const edge = Math.min(1, Math.min(u, 1 - u) / 0.10);
      const grain = 1 + 0.05 * Math.sin((u * 3.0 + v * 11.0) * Math.PI * 2);
      let lum = Math.min(1, hot * 1.25 + core * 0.80 + wing * 0.85) * Math.pow(edge, 0.55) * grain;
      lum = Math.min(1, lum);
      const i = (y * width + x) * 4;
      img.data[i] = Math.round((208 + 47 * core) * lum);
      img.data[i + 1] = Math.round((204 + 51 * core) * lum);
      img.data[i + 2] = Math.round((224 + 31 * core) * lum);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 柱体外围的体积雾贴图：横向
 * 中间亮、两侧平滑归零，纵向上下淡出，用作加法公告板。
 */
function makeHazeTexture(): THREE.Texture {
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const vFade = Math.pow(v, 0.7);
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1;
      const uFade = Math.exp(-Math.pow(u / 0.42, 2));
      const a = Math.min(1, uFade * vFade);
      const i = (y * w + x) * 4;
      img.data[i] = 235;
      img.data[i + 1] = 225;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * rope halo 层贴图：横向软边亮条（U 方向渐变、V 方向恒定）。
 * 平铺到 ribbon 上作为宽度方向的柔光轮廓，V 恒定可避免 halo 层出现横向纹理接缝。
 */
function makeSoftBarTexture(): THREE.Texture {
  const width = 64;
  const height = 8;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const img = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const across = Math.abs(u * 2 - 1);
      const a = Math.pow(Math.max(0, 1 - across), 2.2);
      const i = (y * width + x) * 4;
      img.data[i] = 210;
      img.data[i + 1] = 204;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 辉光 sprite 贴图：白色径向渐变（中心 1 → 边缘 0），供 `render_animated_sprites` 类光点、
 * baseGlow、motes、flare 使用；参考 `particle_glow_03/04` 的观感：亮核 + 快速衰减的柔边。
 */
function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 粒子链 ribbon：模拟 PCF rope 的发射/重力/寿命，每帧重建面向相机的条带；
 * 颜色 = 顶点点色 × 生命周期 alpha（fade in 0.25s / fade out 到 1s，最后边缘到 0）。
 */
class RopeRibbon {
  readonly mesh: THREE.Mesh;
  private readonly profile: RopeProfile;
  private readonly origin: THREE.Vector3;
  private readonly points: RopePoint[] = [];
  private readonly spawnAccum: { value: number };
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly maxPoints: number;
  private readonly scrollOffset = { value: 0 };
  private readonly widthScale: number;

  constructor(
    entity: ParticleEntity,
    profile: RopeProfile,
    texture: THREE.Texture,
    opacityScale = 1,
    widthScale = 1,
  ) {
    this.profile = profile;
    this.widthScale = widthScale;
    this.origin = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]);
    this.maxPoints = Math.ceil(profile.rate * profile.lifetime) + 2;
    this.positions = new Float32Array(this.maxPoints * 2 * 3);
    this.uvs = new Float32Array(this.maxPoints * 2 * 2);
    this.colors = new Float32Array(this.maxPoints * 2 * 4);
    this.spawnAccum = { value: 0 };

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    const index: number[] = [];
    for (let i = 0; i < this.maxPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    this.geometry = geometry;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      opacity: profile.opacity * opacityScale,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;

    // 预热：先跑满一个寿命周期，避免第一帧只有几个点
    const steps = Math.ceil(profile.lifetime * 60);
    for (let i = 0; i < steps; i++) this.step(1 / 60);
  }

  private spawn(): void {
    const [ox, oy, oz] = this.profile.spawnOffset;
    this.points.push({
      pos: new THREE.Vector3(this.origin.x + ox, this.origin.y + oy, this.origin.z + oz),
      vel: new THREE.Vector3(0, 0, 0),
      age: 0,
    });
  }

  private step(dt: number): void {
    const { rate, lifetime, gravity } = this.profile;
    this.spawnAccum.value += dt * rate;
    while (this.spawnAccum.value >= 1) {
      this.spawnAccum.value -= 1;
      this.spawn();
    }
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      p.age += dt;
      if (p.age >= lifetime) {
        this.points.splice(i, 1);
        continue;
      }
      p.vel.y += gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
    }
  }

  /** 生命周期 alpha：前 0.25s fade in、后 1.2s fade out（PCF Alpha Fade and Decay）。 */
  private alphaOf(age: number): number {
    const life = this.profile.lifetime;
    const fadeIn = 0.06;
    const fadeOutStart = life * 0.42;
    const fadeOutEnd = life;
    let a = 1;
    if (age < fadeIn) a = age / fadeIn;
    if (age > fadeOutStart) a = Math.max(0, 1 - (age - fadeOutStart) / (fadeOutEnd - fadeOutStart));
    return a;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.step(dt);
    const n = this.points.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const cameraPos = camera.position;
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    let dist = 0;
    const halfW = (this.profile.width / 2) * this.widthScale;

    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      if (i > 0) dist += p.pos.distanceTo(this.points[i - 1].pos);
      // 端点处的切线用相邻点差分
      if (i < n - 1) dir.subVectors(this.points[i + 1].pos, p.pos);
      else dir.subVectors(p.pos, this.points[i - 1].pos);
      if (dir.lengthSq() < 1e-6) dir.copy(up);
      dir.normalize();
      toCam.subVectors(cameraPos, p.pos);
      perp.crossVectors(dir, toCam);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      else perp.normalize();
      perp.multiplyScalar(halfW);

      const alpha = this.alphaOf(p.age);
      // 锥形：越靠上（越老）越宽，形成「喇叭口」的体积感
      const frac = i / Math.max(1, n - 1);
      // 源贴图：顶端（V=0）碎裂且更宽、底部连续亮刃更窄 => 上宽下窄。
      const widen = 0.34 + 2.40 * Math.pow(frac, 2.6);
      const tint = frac;
      const wob = (Math.sin(p.age * 1.1 + i * 0.55) * 0.07 + Math.sin(p.age * 0.4 + i * 0.19) * 0.05) * halfW * (1 - frac);
      for (let side = 0; side < 2; side++) {
        const vi = (i * 2 + side) * 3;
        const sign = side === 0 ? -1 : 1;
        this.positions[vi] = p.pos.x + wob + perp.x * sign * widen;
        this.positions[vi + 1] = p.pos.y + perp.y * sign * widen;
        this.positions[vi + 2] = p.pos.z + wob * 0.6 + perp.z * sign * widen;
        const ui = (i * 2 + side) * 2;
        this.uvs[ui] = side;
        this.uvs[ui + 1] = dist / this.profile.texelSize - this.scrollOffset.value;
        const ci = (i * 2 + side) * 4;
        this.colors[ci] = 1 - 0.2 * tint;
        this.colors[ci + 1] = 1 - 0.3 * tint;
        this.colors[ci + 2] = 1;
        this.colors[ci + 3] = Math.min(1, alpha * (0.52 + 0.30 * frac));
      }
    }
    this.scrollOffset.value += dt * this.profile.scroll;
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/**
 * 光柱内上升的细碎星点（PCF 里 `render_animated_sprites` 子层的观感近似）：
 * 一批小的加法点精灵，沿光柱高度缓慢上升、随机横向漂移、按高度渐隐。
 */
class BeamMotes {
  readonly points: THREE.Points;
  private readonly baseY: Float32Array;
  private readonly phase: Float32Array;
  private readonly radius: Float32Array;
  private readonly speeds: Float32Array;
  private readonly height: number;
  private readonly count: number;
  private readonly positions: Float32Array;
  private elapsed = 0;

  constructor(origin: THREE.Vector3, beamWidth: number, height: number, count: number, texture: THREE.Texture, color: number) {
    this.count = count;
    this.height = height;
    this.baseY = new Float32Array(count);
    this.phase = new Float32Array(count);
    this.radius = new Float32Array(count);
    this.speeds = new Float32Array(count);
    this.positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.baseY[i] = Math.random() * height;
      this.phase[i] = Math.random() * Math.PI * 2;
      this.radius[i] = beamWidth * (0.1 + Math.random() * 0.42);
      this.speeds[i] = 0.15 + Math.random() * 0.4;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const material = new THREE.PointsMaterial({
      map: texture,
      color,
      size: Math.max(6, beamWidth * 0.05),
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.55,
      fog: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.position.copy(origin);
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (let i = 0; i < this.count; i++) {
      const y = (this.baseY[i] + this.elapsed * this.speeds[i] * 90) % this.height;
      const a = this.phase[i] + this.elapsed * 0.4 + i;
      const i3 = i * 3;
      this.positions[i3] = Math.cos(a) * this.radius[i];
      this.positions[i3 + 1] = y;
      this.positions[i3 + 2] = Math.sin(a) * this.radius[i];
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

interface GlowCluster {
  sprites: THREE.Sprite[];
  basePositions: THREE.Vector3[];
  phases: number[];
  drift: number[];
  elapsed: number;
}

/** 引擎 `SimpleSpline`（3t²-2t³）；输入先 clamp 到 [0,1]。 */
function spline01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/**
 * 在单位球内均匀取点并写回方向（引擎 `RandomVectorInUnitSphere` 的体积均匀），
 * 返回该点长度——PCF `Position Within Sphere Random` 用它做 `Lerp(flLength, min, max)`。
 * `horizontal=true` 对应 bias [1,1,0]：只保留水平分量（Source XY 平面，three 的 XZ 平面）。
 */
function sampleUnitBall(out: THREE.Vector3, horizontal: boolean): number {
  if (horizontal) {
    const a = Math.random() * Math.PI * 2;
    out.set(Math.cos(a), 0, Math.sin(a));
  } else {
    const z = Math.random() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const a = Math.random() * Math.PI * 2;
    out.set(r * Math.cos(a), z, r * Math.sin(a));
  }
  return Math.cbrt(Math.random());
}

/** 父层 `render_animated_sprites` 的一个光点。 */
interface AlchSpriteParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  /** quad 半宽（HU）。 */
  radius: number;
  /** Alpha Random（0..1）。 */
  alpha0: number;
}

/** 子层 `render_sprite_trail` 的一个拖尾粒子。 */
interface AlchTrailParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  alpha0: number;
}

/**
 * 一个 alch 站点的两层 PCF 粒子：
 * - 父层：`render_animated_sprites` 小光点（球内散布、重力上飘、Alpha Fade and Decay + Fade In 包络）；
 * - 子层：`render_sprite_trail` 拖尾（水平盘散布、快速上飘、长度 clamp 到 PCF min length）。
 * 环的 brush 几何与旋转由 ALCH_SYMBOLS 实体负责，这里不再重复造环。
 */
class AlchParticleField {
  readonly group = new THREE.Group();
  private readonly origin: THREE.Vector3;
  private readonly profile: AlchProfile;
  private readonly spritePool: THREE.Sprite[] = [];
  private readonly spriteParticles: AlchSpriteParticle[] = [];
  private readonly trailParticles: AlchTrailParticle[] = [];
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailMaterial: THREE.MeshBasicMaterial;
  private readonly trailMesh: THREE.Mesh;
  private readonly trailTint: THREE.Color;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpDelta = new THREE.Vector3();
  private readonly tmpTangent = new THREE.Vector3();
  private readonly tmpTail = new THREE.Vector3();
  private spriteAccum = 0;
  private trailAccum = 0;

  constructor(entity: ParticleEntity, profile: AlchProfile, glowTexture: THREE.Texture) {
    this.origin = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]);
    this.profile = profile;
    this.group.name = `alch-particles:${entity.effect}`;
    this.trailTint = new THREE.Color(profile.trail.color);
    // 父层：每个光点独立 sprite 材质，才能逐粒子控制 opacity。
    const spriteColor = new THREE.Color(profile.sprite.color);
    for (let i = 0; i < profile.sprite.maxParticles; i++) {
      const material = new THREE.SpriteMaterial({
        map: glowTexture,
        color: spriteColor,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 11;
      this.group.add(sprite);
      this.spritePool.push(sprite);
    }
    // 子层：拖尾 quad 批（每粒子 4 顶点 2 三角），宽度方向 U=0/1、长度方向 V=0/1。
    const maxTrail = profile.trail.maxParticles;
    this.trailPositions = new Float32Array(maxTrail * 4 * 3);
    this.trailColors = new Float32Array(maxTrail * 4 * 4);
    const uvs = new Float32Array(maxTrail * 4 * 2);
    const indices: number[] = [];
    for (let i = 0; i < maxTrail; i++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const v = i * 4;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 4));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    this.trailGeometry = geometry;
    this.trailMaterial = new THREE.MeshBasicMaterial({
      map: glowTexture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    this.trailMesh = new THREE.Mesh(geometry, this.trailMaterial);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = 10;
    this.group.add(this.trailMesh);
    // 预热一个最大寿命周期，避免首次进入场景时只有零星粒子。
    const warm = Math.max(profile.sprite.lifeMax, profile.trail.lifeMax);
    for (let i = 0; i < Math.ceil(warm * 60); i++) this.step(1 / 60);
  }

  private spawnSprite(): void {
    const layer = this.profile.sprite;
    const flLength = sampleUnitBall(this.tmpDir, false);
    const distance = layer.distanceMin + (layer.distanceMax - layer.distanceMin) * flLength;
    this.spriteParticles.push({
      pos: this.origin.clone().addScaledVector(this.tmpDir, distance),
      vel: new THREE.Vector3(),
      age: 0,
      life: layer.lifeMin + Math.random() * (layer.lifeMax - layer.lifeMin),
      radius: layer.radiusMin + Math.random() * (layer.radiusMax - layer.radiusMin),
      alpha0: (layer.alphaMin + Math.random() * (layer.alphaMax - layer.alphaMin)) / 255,
    });
  }

  private spawnTrail(): void {
    const layer = this.profile.trail;
    // bias [1,1,0]：randpos.z 置零后归一化 ⇒ 水平盘上的随机方向。
    const flLength = sampleUnitBall(this.tmpDir, true);
    const distance = layer.distanceMin + (layer.distanceMax - layer.distanceMin) * flLength;
    this.trailParticles.push({
      pos: this.origin.clone().addScaledVector(this.tmpDir, distance),
      vel: new THREE.Vector3(),
      age: 0,
      life: layer.lifeMin + Math.random() * (layer.lifeMax - layer.lifeMin),
      alpha0: (layer.alphaMin + Math.random() * (layer.alphaMax - layer.alphaMin)) / 255,
    });
  }

  private step(dt: number): void {
    const sprite = this.profile.sprite;
    this.spriteAccum += dt * sprite.rate;
    while (this.spriteAccum >= 1) {
      this.spriteAccum -= 1;
      if (this.spriteParticles.length < sprite.maxParticles) this.spawnSprite();
    }
    for (let i = this.spriteParticles.length - 1; i >= 0; i--) {
      const p = this.spriteParticles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.spriteParticles.splice(i, 1);
        continue;
      }
      p.vel.y += sprite.gravity * dt;
      const speed = p.vel.length();
      if (speed > sprite.maxVelocity) p.vel.multiplyScalar(sprite.maxVelocity / speed);
      p.pos.addScaledVector(p.vel, dt);
    }
    const trail = this.profile.trail;
    this.trailAccum += dt * trail.rate;
    while (this.trailAccum >= 1) {
      this.trailAccum -= 1;
      if (this.trailParticles.length < trail.maxParticles) this.spawnTrail();
    }
    for (let i = this.trailParticles.length - 1; i >= 0; i--) {
      const p = this.trailParticles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.trailParticles.splice(i, 1);
        continue;
      }
      p.vel.y += trail.gravity * dt;
      const speed = p.vel.length();
      if (speed > trail.maxVelocity) p.vel.multiplyScalar(trail.maxVelocity / speed);
      p.pos.addScaledVector(p.vel, dt);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.step(dt);
    const spriteLayer = this.profile.sprite;
    for (let i = 0; i < this.spritePool.length; i++) {
      const sprite = this.spritePool[i];
      const particle = this.spriteParticles[i];
      if (!particle) {
        sprite.visible = false;
        continue;
      }
      const t = particle.age / particle.life;
      // 有效 alpha = initialAlpha × Fade In Random(前 50%) × Fade and Decay(后 50% 到 0)。
      const fadeIn = t < 0.5 ? spline01(t / 0.5) : 1;
      const fadeOut = t <= 0.5 ? 1 : 1 - spline01((t - 0.5) / 0.5);
      const alpha = particle.alpha0 * fadeIn * fadeOut;
      const material = sprite.material as THREE.SpriteMaterial;
      material.opacity = alpha;
      sprite.visible = alpha > 0.002;
      sprite.position.copy(particle.pos);
      sprite.scale.setScalar(particle.radius * 2);
    }
    void spriteLayer;
    const trailLayer = this.profile.trail;
    let active = 0;
    for (const particle of this.trailParticles) {
      const speed = particle.vel.length();
      if (speed < 1e-3 || active >= trailLayer.maxParticles) continue;
      // 引擎 RenderSpriteTrail：长度 = clamp(速度 × TRAIL_LENGTH(0.1), minLength, maxLength)。
      const length = Math.max(trailLayer.trailMin, Math.min(trailLayer.trailMax, speed * 0.1));
      this.tmpDir.copy(particle.vel).multiplyScalar(1 / speed);
      this.tmpTail.copy(particle.pos).addScaledVector(this.tmpDir, -length);
      // tangent = normalize(Cross(head - cameraPos, delta))；宽度 = settings radius。
      this.tmpDelta.subVectors(this.tmpTail, particle.pos);
      this.tmpTangent.subVectors(particle.pos, camera.position).cross(this.tmpDelta);
      if (this.tmpTangent.lengthSq() < 1e-8) this.tmpTangent.set(1, 0, 0);
      else this.tmpTangent.normalize();
      this.tmpTangent.multiplyScalar(trailLayer.width * 0.5);
      const t = particle.age / particle.life;
      // Fade and Decay：fade in 0..0.1（start_alpha 1 ⇒ 不变），fade out 0.9..1。
      const alpha = particle.alpha0 * (t > 0.9 ? 1 - spline01((t - 0.9) / 0.1) : 1);
      const head = particle.pos;
      const tail = this.tmpTail;
      const tan = this.tmpTangent;
      const p3 = active * 12;
      // 0: head+tan, 1: head-tan, 2: tail-tan, 3: tail+tan
      this.trailPositions[p3] = head.x + tan.x;
      this.trailPositions[p3 + 1] = head.y + tan.y;
      this.trailPositions[p3 + 2] = head.z + tan.z;
      this.trailPositions[p3 + 3] = head.x - tan.x;
      this.trailPositions[p3 + 4] = head.y - tan.y;
      this.trailPositions[p3 + 5] = head.z - tan.z;
      this.trailPositions[p3 + 6] = tail.x - tan.x;
      this.trailPositions[p3 + 7] = tail.y - tan.y;
      this.trailPositions[p3 + 8] = tail.z - tan.z;
      this.trailPositions[p3 + 9] = tail.x + tan.x;
      this.trailPositions[p3 + 10] = tail.y + tan.y;
      this.trailPositions[p3 + 11] = tail.z + tan.z;
      const c4 = active * 16;
      const r = this.trailTint.r;
      const g = this.trailTint.g;
      const b = this.trailTint.b;
      for (let v = 0; v < 4; v++) {
        this.trailColors[c4 + v * 4] = r;
        this.trailColors[c4 + v * 4 + 1] = g;
        this.trailColors[c4 + v * 4 + 2] = b;
        this.trailColors[c4 + v * 4 + 3] = alpha;
      }
      active++;
    }
    this.trailGeometry.setDrawRange(0, active * 6);
    this.trailMesh.visible = active > 0;
    (this.trailGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    for (const sprite of this.spritePool) (sprite.material as THREE.Material).dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.group.clear();
  }
}

/**
 * 粒子系统集合：运行时按实体创建光柱/辉光，`update(dt, camera)` 推进模拟与 billboard。
 */
export class ParticleSystems {
  readonly root = new THREE.Group();
  private readonly beamTexture: THREE.Texture;
  private readonly glowTexture: THREE.Texture;
  private readonly softBarTexture: THREE.Texture;
  private readonly ropes: RopeRibbon[] = [];
  private readonly glowClusters: GlowCluster[] = [];
  private readonly baseGlows: THREE.Sprite[] = [];
  private readonly flares: THREE.Group[] = [];
  private readonly hazes: THREE.Mesh[] = [];
  private readonly hazeTexture: THREE.Texture;
  private readonly motes: BeamMotes[] = [];
  /** 符文祭坛（alch）的两层 PCF 粒子（环几何由 brush 实体负责，不在这里）。 */
  private readonly alchFields: AlchParticleField[] = [];
  private elapsed = 0;

  constructor(entities: ParticleEntity[]) {
    this.root.name = 'particle-systems';
    this.beamTexture = makeBeamTexture();
    this.glowTexture = makeGlowTexture();
    this.softBarTexture = makeSoftBarTexture();
    this.hazeTexture = makeHazeTexture();

    for (const entity of entities) {
      const rope = ROPE_PROFILES[entity.effect];
      if (rope) {
        // 两层：亮核（laser 贴图）+ 外围柔光（glow 贴图，更宽更淡），叠加成体积光观感。
        const core = new RopeRibbon(entity, rope, this.beamTexture, 0.16, 1.0);
        const halo = new RopeRibbon(entity, rope, this.softBarTexture, 0.34, 1.6);
        // 第三层：极窄的激光核心（laser 贴图、0.13 宽度），让柱心有一条更亮的连续亮刃。
        const inner = new RopeRibbon(entity, rope, this.beamTexture, 0.40, 0.13);
        this.ropes.push(core, halo, inner);
        this.root.add(core.mesh, halo.mesh, inner.mesh);
        // 光柱底部的亮核
        const baseGlow = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: 0xe8ecff,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
            opacity: 0.10,
          }),
        );
        baseGlow.position.set(entity.origin[0], entity.origin[1] + 90, entity.origin[2]);
        baseGlow.scale.setScalar(360);
        baseGlow.renderOrder = 12;
        this.root.add(baseGlow);
        this.baseGlows.push(baseGlow);
        const motes = new BeamMotes(new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]), rope.width, 4200, 42, this.glowTexture, 0xd8ccff);
        this.root.add(motes.points);
        this.motes.push(motes);
        // 柱底大光斑（源 render_animated_sprites 04：radius 800 => 1600x1600 的 32 个大光斑堆在底部）
        const flare = new THREE.Group();
        for (let i = 0; i < 32; i++) {
          const mat = new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: i % 3 === 0 ? 0xf4f6ff : 0xd9deff,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
            opacity: 0.010,
          });
          const sp = new THREE.Sprite(mat);
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.random() * 260;
          sp.position.set(
            entity.origin[0] + Math.cos(ang) * rad,
            entity.origin[1] - 200 + Math.random() * 260,
            entity.origin[2] + Math.sin(ang) * rad,
          );
          const sc = 700 + Math.random() * 900;
          sp.scale.set(sc, sc, 1);
          sp.renderOrder = 11;
          flare.add(sp);
        }
        this.root.add(flare);
        this.flares.push(flare);
        // 柱体外围的大范围淡紫体积雾（源里来自 6 条 sprite_trail 白雾 + 04 大光斑的叠加包围感）
        const haze = new THREE.Mesh(
          new THREE.PlaneGeometry(rope.width * 3.6, 4400),
          new THREE.MeshBasicMaterial({
            map: this.hazeTexture,
            color: 0xccd6ff,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false,
            toneMapped: false,
            opacity: 0.11,
          }),
        );
        haze.position.set(entity.origin[0], entity.origin[1] + 2000, entity.origin[2]);
        haze.renderOrder = 9;
        this.root.add(haze);
        this.hazes.push(haze);
        continue;
      }
      const glow = GLOW_PROFILES[entity.effect];
      if (glow) {
        this.glowClusters.push(this.buildGlow(entity, glow));
        continue;
      }
      const alch = ALCH_PROFILES[entity.effect];
      if (alch) {
        const field = new AlchParticleField(entity, alch, this.glowTexture);
        this.alchFields.push(field);
        this.root.add(field.group);
      }
    }
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

  /** 每帧推进：`dt` 秒；`camera` 用于 rope 的 billboard 与朝向。 */
  update(dt: number, camera: THREE.Camera): void {
    this.elapsed += dt;
    for (const rope of this.ropes) rope.update(dt, camera);
    for (const motes of this.motes) motes.update(dt);
    for (const field of this.alchFields) field.update(dt, camera);
    for (const haze of this.hazes) {
      haze.quaternion.copy(camera.quaternion);
      haze.rotateY(Math.PI);
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
    for (const rope of this.ropes) rope.dispose();
    this.ropes.length = 0;
    for (const field of this.alchFields) field.dispose();
    this.alchFields.length = 0;
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const m of material) m.dispose();
      } else if (material) {
        material.dispose();
      }
    });
    this.root.clear();
    this.beamTexture.dispose();
    this.glowTexture.dispose();
    for (const motes of this.motes) motes.dispose();
    for (const flare of this.flares) {
      for (const child of flare.children) {
        const sprite = child as THREE.Sprite;
        sprite.material.dispose();
      }
    }
    this.motes.length = 0;
    this.glowClusters.length = 0;
  }

  /** 诊断：当前挂了多少光柱 / 辉光 / 祭坛粒子（面板或 CDP 用）。 */
  stats(): { ropes: number; glowClusters: number; sprites: number; points: number; alchFields: number } {
    return {
      ropes: this.ropes.length,
      glowClusters: this.glowClusters.length,
      sprites: this.glowClusters.reduce((sum, c) => sum + c.sprites.length, 0),
      points: this.motes.reduce((sum, m) => sum + (m.points.geometry.getAttribute('position') as THREE.BufferAttribute).count, 0),
      alchFields: this.alchFields.length,
    };
  }
}
