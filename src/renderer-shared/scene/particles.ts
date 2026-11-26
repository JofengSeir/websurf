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

import { parseEntityBlocks as parseEntityBlocksShared, type KeyValuePair } from '../../ts-shared/entity/map-data.js';
import { particleStartsActive } from './entity-extras/entity-state.js';

/** 一条 `info_particle_system` 实体（已换算到 Y-up 世界坐标）。 */
export interface ParticleEntity {
  effect: string;
  /** 实体块下标（= `vbsp_entity_index`，运行期 Start/Stop 按它寻址）；旧调用方缺省 -1。 */
  entityIndex?: number;
  /** `start_active`（`CParticleSystem::Activate`）：false ⇒ 载入后不发射，等 I/O `Start`。 */
  startActive?: boolean;
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

/** 一次解析后的实体键值块（每块「首键优先」的扁平 key/value 记录）。 */
export type EntityBlockRecords = Array<Record<string, string>>;

/**
 * 把 `KeyValuePair[][]`（`src/ts-shared/entity/map-data.ts` 的解析结果）合并成键值记录：
 * 块顺序不变、块内重复键只保留第一次出现的值（与旧版逐行解析器的「首键优先」等价）。
 */
function toEntityBlockRecords(blocks: readonly KeyValuePair[][]): EntityBlockRecords {
  const out: EntityBlockRecords = [];
  for (const pairs of blocks) {
    const rec: Record<string, string> = {};
    for (const { key, value } of pairs) {
      if (!(key in rec)) rec[key] = value;
    }
    out.push(rec);
  }
  return out;
}

/**
 * 解析 Source `.ent`/`entities_text` 的键值块（`{ "key" "value" ... }`），供粒子与激光共用。
 * 复用 `src/ts-shared/entity/map-data.ts` 的解析入口（与 Rust `Entities::iter()` 同序同数）。
 */
export function parseEntityBlocks(text: string): EntityBlockRecords {
  return toEntityBlockRecords(parseEntityBlocksShared(text));
}

/**
 * 解析 `entityIoJson`（`{ entities_text, volumes, ... }`）**一次**，得到全部实体键值记录。
 * 供 `collectLaserBeams()` / `collectParticleEntities()` 共享，避免两边各自 `JSON.parse` + 切块
 * （task-58：载图期同一份实体文本被解析两遍）。JSON 非法时返回空数组（与旧实现的静默回退一致）。
 */
export function parseEntityIoBlocks(entityIoJson?: string | null): EntityBlockRecords {
  if (!entityIoJson) return [];
  try {
    const payload = JSON.parse(entityIoJson) as { entities_text?: string };
    return parseEntityBlocks(payload.entities_text ?? '');
  } catch {
    return [];
  }
}

/** collector 兼容入口：既接受原始 `entityIoJson` 字符串，也接受已解析好的实体键值记录。 */
export function resolveEntityBlocks(
  source?: string | EntityBlockRecords | null,
): EntityBlockRecords {
  if (!source) return [];
  return typeof source === 'string' ? parseEntityIoBlocks(source) : source;
}

export function parseVec3(raw: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!raw) return fallback;
  const parts = raw.trim().split(/\s+/).map((v) => Number(v));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return fallback;
  return [parts[0], parts[1], parts[2]];
}

/** 从 `entityIoJson`（或已解析的实体块）里收集所有 `info_particle_system`。 */
export function collectParticleEntities(
  entityIoJsonOrBlocks?: string | EntityBlockRecords | null,
): ParticleEntity[] {
  const out: ParticleEntity[] = [];
  const blocks = resolveEntityBlocks(entityIoJsonOrBlocks);
  for (let entityIndex = 0; entityIndex < blocks.length; entityIndex++) {
    const block = blocks[entityIndex];
    if (block['classname'] !== 'info_particle_system') continue;
    const effect = block['effect_name'];
    if (!effect) continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const angles = parseVec3(block['angles'], [0, 0, 0]);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)
    out.push({
      effect,
      entityIndex,
      startActive: particleStartsActive(block),
      origin: [src[1], src[2], src[0]],
      angles,
    });
  }
  return out;
}

/**
 * 光柱横截面贴图：按 `laser01.vtf` 的 RGB 阶梯剖面重建（不是高斯软边）。
 *
 * 依据 task-7 取证 `.tmp/pcf/LOOK_FORENSICS.md` §0/§5：
 * - `laser01.vtf` alpha 全 255，`laser.vmt` 是 Sprite + `$spriterendermode 5`（加法、关深度写）
 *   ⇒ 加法下形状完全由 RGB 决定，黑色像素等于不可见；
 * - RGB 实测是「多条阶梯亮带 + 纯黑带」，不是高斯：U0-1≈(115,89,123)、U3-4≈(239,239,247) 亮核、
 *   U18-21 纯黑、U22-31 由黑渐亮到 (58,45,66)（U 是 32 像素归一化横截面坐标）；
 * - 沿 V 分三段亮带位置不同：V<0.125 亮带在 U≈0.23、0.125≤V<0.375 在 U≈0.36、V≥0.375 在 U≈0.11
 *   ⇒ 光柱沿长度呈「多缕交错」，而不是均匀光柱。
 * 贴图 U 横跨光柱宽度、V 沿长度每 4096 HU 重复一次（texel_size=64 × mappingHeight=64），
 * 所以 wrapT 必须是 RepeatWrapping（旧实现 V 恒定 + ClampToEdge 只适合高斯剖面）。
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
  // V≥0.375 的基础阶梯剖面（U 升序，RGB 来自 laser01 实测；线性插值，黑带保留）。
  const base: Array<[number, number, number, number]> = [
    [0.0, 115, 89, 123],
    [0.045, 115, 89, 123],
    [0.065, 156, 139, 164],
    [0.095, 239, 239, 247],
    [0.135, 239, 239, 247],
    [0.165, 156, 139, 164],
    [0.20, 115, 89, 123],
    [0.26, 35, 27, 38],
    [0.39, 12, 9, 12],
    [0.50, 0, 0, 0],
    [0.68, 0, 0, 0],
    [0.71, 5, 5, 5],
    [0.84, 16, 12, 16],
    [1.0, 58, 45, 66],
  ];
  const ladder = (u: number): [number, number, number] => {
    if (u <= base[0][0]) return [base[0][1], base[0][2], base[0][3]];
    for (let i = 1; i < base.length; i++) {
      const [u1, r1, g1, b1] = base[i];
      const [u0, r0, g0, b0] = base[i - 1];
      if (u <= u1) {
        const t = (u - u0) / Math.max(1e-6, u1 - u0);
        return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
      }
    }
    const last = base[base.length - 1];
    return [last[1], last[2], last[3]];
  };
  // 亮带（阶梯带）：平台 + 线性边缘（近似 bloom 后的平顶亮核，而不是三角尖峰——
  // 三角剖面在 90% 阈值处只剩亮带宽度的 20%，涨 w90 太慢、还会顺带撑宽 60/40% 肩部）。
  const band = (u: number, center: number, half: number): number => {
    const d = Math.abs(u - center);
    const edge = half * 0.4;
    if (d <= half - edge) return 1;
    if (d >= half) return 0;
    return (half - d) / edge;
  };
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    // laser01 的三条 V 带（原图亮带位置约 U=0.23 / 0.36 / 0.11）。round-2（task-10）把三条带的
    // U 位置统一到 U=0.355：三条带各自错位会让各层亮核在横截面上叠加成 ±400 HU 的宽肩
    // （实测 w60/w40 265/485 HU 偏宽），统一后亮核叠在同一处、V 向仍保留三段颜色变化。
    const c = v < 0.125 ? { u: 0.355, rgb: [206, 182, 214] } : v < 0.375 ? { u: 0.355, rgb: [247, 235, 255] } : { u: 0.355, rgb: [239, 239, 247] };
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const [br, bg2, bb] = ladder(u);
      // 亮带半宽：laser01 原图亮带只有 1–2 px（平铺到 1500 HU 宽的光柱上会细成发丝）；
      // 实机里 bloom 会把多条细亮带晕开，这里把亮带加宽到「肉眼可见的阶梯」宽度。
      // round-2（task-10）：0.06/0.07 → 0.16/0.20（配合平台剖面），把亮核 w90 抬到实机 41–61 HU；
      // 仍保留 U≈0.39–0.68 的纯黑带，避免整根柱面被填成实心。
      const t = band(u, c.u, 0.14);
      const i = (y * width + x) * 4;
      img.data[i] = Math.round(Math.max(br, c.rgb[0] * t));
      img.data[i + 1] = Math.round(Math.max(bg2, c.rgb[1] * t));
      img.data[i + 2] = Math.round(Math.max(bb, c.rgb[2] * t));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
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
 *
 * task-8：指数 2.2 → 1.3（依据 `.tmp/pcf/LOOK_FORENSICS.md` §5）：实机光柱中段光晕
 * w60/w40 比我们宽（实机 w60=121 HU、w40=237 HU；我们 w60=87、w40=100），
 * 把指数调低让 halo 肩部更宽、更接近实机的柔和外扩。
 *
 * task-11 round-3：幂律 `(1-f)^1.3` 的 w90:w60:w40 比例恒在 1:4.2:6.6 左右，而实机是
 * 1:2.37:4.63（w90 51.2 / w60 121.3 / w40 237.2 HU）——纯幂律/单高斯无法在保持亮核的
 * 同时收窄翼展。改为「平顶 + 陡肩 + 短尾」三段（f = |2u-1|，半宽按各层 widthScale 定）：
 *   f ≤ 0.08         → 1.0            （亮核平顶；halo 半宽 0.6×750 时约 36 HU 半宽）
 *   0.08 < f ≤ 0.26  → 线性 1.0→0.40   （陡肩，w60/w40 主要由它和 halo 宽度控制）
 *   0.26 < f ≤ 0.40  → 线性 0.40→0    （短尾，wEff 靠它控住）
 * 同一张软边贴图给两条 ribbon 用：宽 halo（翼展）+ 窄 plateau（亮核），把 w90 与翼展解耦
 * （lead 建议：核心平台独立一条窄 ribbon 撑住，宽度 0.10–0.14 量级、软边贴图）。
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
      const f = Math.abs(u * 2 - 1);
      let a: number;
      if (f <= 0.08) a = 1;
      else if (f <= 0.26) a = 1 - ((f - 0.08) / 0.18) * 0.60;
      else if (f <= 0.40) a = 0.40 * (1 - (f - 0.26) / 0.14);
      else a = 0;
      const i = (y * width + x) * 4;
      img.data[i] = 210;
      img.data[i + 1] = 204;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
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
 * baseGlow、motes、flare 与 alch 粒子使用；参考 `particle_glow_03/04` 的观感：亮核 + 快速衰减的柔边。
 *
 * task-8：贴图边缘始终归零（alpha=0），但把 0.25 处的 0.55 改为 0.18 处的 0.62、
 * 0.6 处的 0.12 改为 0.42 处的 0.30，并新增 0.72 处的 0.08——肩部更宽、核心更软，
 * 避免小尺寸 sprite 放大后出现「硬边圆片」（stock particle_glow_* 材质不在 pakfile，
 * 无法直接对照，此处按 Source additive sprite 的软光斑观感近似，见 LOOK_FORENSICS §4）。
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
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.62)');
  gradient.addColorStop(0.42, 'rgba(255,255,255,0.30)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 柱底「白热光球」的 sprite 贴图。
 *
 * 来源（pcf-scout task-15 / `BASE_BALL.md`）：实机那颗球是 `tendies_endparticle04`
 * ——`render_animated_sprites` + `particle_glow_11`，24–32 个 1600 HU 的加法光斑叠在同一处，
 * 于是中心直接饱和成纯白：白核直径实测 531±30 HU、过曝像素占球 bbox 61–64%、粉紫晕到 ~400 HU。
 * stock `particle_glow_11` 的 VTF 不在 pakfile，这里按「硬核 + 陡肩 + 长尾」近似：
 * 半径 34% 以内 alpha 全 1（对应 1600×0.34≈540 HU 白核），之后快速衰减，尾部留到边缘。
 */
function makeBallTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.34, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,244,252,0.55)');
  gradient.addColorStop(0.72, 'rgba(240,220,255,0.18)');
  gradient.addColorStop(1.0, 'rgba(220,200,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 相机朝向 billboard 的基向量（世界空间：相机矩阵的右/上轴列向量）。 */
interface BillboardBasis {
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
}

/**
 * 取相机的右/上轴（世界空间）。沿这两个轴偏移顶点不改变顶点的视线方向投影深度，
 * 因此等价于 three `Sprite` 着色器里的「view 空间 XY 偏移」——透视投影下逐像素一致。
 */
function billboardBasisOf(camera: THREE.Camera, out: BillboardBasis): BillboardBasis {
  const m = camera.matrixWorld.elements;
  out.rx = m[0];
  out.ry = m[1];
  out.rz = m[2];
  out.ux = m[4];
  out.uy = m[5];
  out.uz = m[6];
  return out;
}

/**
 * 加法光效合批容器（task-32）：把大量「贴图 × 顶点色 × alpha」的四边形写进一张动态
 * BufferGeometry，一次 draw 画完。语义与原来的 `THREE.Sprite`／单 quad 光效 mesh 对齐：
 *   - additive 混合：出射 = 贴图色(线性) × 顶点色(线性)，alpha = 贴图 a × 顶点 a × material.opacity；
 *   - depthWrite=false、depthTest=true；加法混合与绘制顺序无关，所以任意合批都不改变观感；
 *   - 顶点色是 RGBA（three 0.165 的 vertexAlphas 路径），逐 quad 控颜色/alpha。
 *
 * 槽位是绝对下标：调用方持有自己的 slot，可任意顺序写入（begin/end 只负责可见性与上传标记）。
 * 每帧所有槽位要么写入真实四边形、要么 `collapseAt` 成零面积——drawRange 恒定，也不会读到
 * 上一帧的旧顶点。
 */
class AdditiveQuadBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly capacity: number;
  private live = 0;

  constructor(texture: THREE.Texture, capacity: number, renderOrder: number, noGlow: boolean) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const quads = this.capacity;
    this.positions = new Float32Array(quads * 12);
    this.colors = new Float32Array(quads * 16);
    const uvs = new Float32Array(quads * 8);
    const indices: number[] = [];
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      uvs[q * 8] = 0;
      uvs[q * 8 + 1] = 0;
      uvs[q * 8 + 2] = 1;
      uvs[q * 8 + 3] = 0;
      uvs[q * 8 + 4] = 1;
      uvs[q * 8 + 5] = 1;
      uvs[q * 8 + 6] = 0;
      uvs[q * 8 + 7] = 1;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, quads * 6);
    this.geometry = geometry;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // 屏幕朝向 quad 的绕序在极端视角下可能翻面；加法混合下双面与单面等价，
      // 用 DoubleSide 省掉绕序校验（原 Sprite 走的是自己的着色器，不存在这个问题）。
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    // 全局合批网格不参与 tagCullBounds/cullByCamera 的整片剔除（见 tagCullBounds）。
    this.mesh.userData.vbspNoCull = true;
    // 首帧 update 之前没有顶点，先不画（否则多一次空 draw）。
    this.mesh.visible = false;
    // 原来是 Sprite 的光效不进 bloom 光效层（markGlowMeshes 只认 Mesh）；合批成 Mesh 后
    // 必须显式标记 vbspNoGlow，否则会额外多出一份泛光。
    if (noGlow) this.mesh.userData.vbspNoGlow = true;
  }

  begin(): void {
    this.live = 0;
  }

  /** 写一个世界空间的四边形：p0/p1/p2/p3 依次对应 UV (0,0)/(1,0)/(1,1)/(0,1)。 */
  orientedQuadAt(
    slot: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    x3: number,
    y3: number,
    z3: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (slot < 0 || slot >= this.capacity) return;
    const v = slot * 4;
    this.writeVert(v, x0, y0, z0, r, g, b, a);
    this.writeVert(v + 1, x1, y1, z1, r, g, b, a);
    this.writeVert(v + 2, x2, y2, z2, r, g, b, a);
    this.writeVert(v + 3, x3, y3, z3, r, g, b, a);
    this.live++;
  }

  /** 写一个屏幕朝向的 billboard：中心 (cx,cy,cz)、世界尺寸 size（HU）。 */
  billboardAt(
    slot: number,
    cx: number,
    cy: number,
    cz: number,
    size: number,
    basis: BillboardBasis,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (slot < 0 || slot >= this.capacity) return;
    const h = size * 0.5;
    const rx = basis.rx * h;
    const ry = basis.ry * h;
    const rz = basis.rz * h;
    const ux = basis.ux * h;
    const uy = basis.uy * h;
    const uz = basis.uz * h;
    const v = slot * 4;
    this.writeVert(v, cx - rx - ux, cy - ry - uy, cz - rz - uz, r, g, b, a);
    this.writeVert(v + 1, cx + rx - ux, cy + ry - uy, cz + rz - uz, r, g, b, a);
    this.writeVert(v + 2, cx + rx + ux, cy + ry + uy, cz + rz + uz, r, g, b, a);
    this.writeVert(v + 3, cx - rx + ux, cy - ry + uy, cz - rz + uz, r, g, b, a);
    this.live++;
  }

  /** 把槽位塌成零面积（不可见），用于「这个槽位本帧没有粒子」。 */
  collapseAt(slot: number, x = 0, y = 0, z = 0): void {
    if (slot < 0 || slot >= this.capacity) return;
    const v = slot * 4;
    this.writeVert(v, x, y, z, 0, 0, 0, 0);
    this.writeVert(v + 1, x, y, z, 0, 0, 0, 0);
    this.writeVert(v + 2, x, y, z, 0, 0, 0, 0);
    this.writeVert(v + 3, x, y, z, 0, 0, 0, 0);
  }

  end(): void {
    if (this.live === 0) {
      this.mesh.visible = false;
      return;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = true;
  }

  private writeVert(vi: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number): void {
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

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/**
 * rope 光柱的一层：贴图只有两种，各层只是「宽度系数 + 不透明度系数」不同。
 * （task-11 round-3 的分层依据见 `ParticleSystems` 构造处注释，AB 结论不变。）
 */
interface RopeLayerSpec {
  /** 用哪张贴图：laser01 阶梯纹理 / softBar 软边纹理。 */
  texture: 'beam' | 'softBar';
  /** 相对 `RopeProfile.opacity` 的不透明度系数（原 material.opacity 的乘子）。 */
  opacity: number;
  /** 相对 `profile.width / 2` 的宽度系数（原 widthScale）。 */
  widthScale: number;
}

/** 4 层叠加顺序与 task-11 round-3 一致：core / halo / plateau / inner。 */
const ROPE_LAYERS: RopeLayerSpec[] = [
  { texture: 'beam', opacity: 0.1, widthScale: 0.3 },
  { texture: 'softBar', opacity: 0.35, widthScale: 0.7 },
  { texture: 'softBar', opacity: 0.46, widthScale: 0.44 },
  { texture: 'beam', opacity: 0.1, widthScale: 0.1 },
];

/** 同一贴图下的若干层共用一套动态顶点缓冲（层从底部预热点开始逐层排布）。 */
interface RopeLayerGroup {
  layers: RopeLayerSpec[];
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  geometry: THREE.BufferGeometry;
  /** 每个层面片对应的 index 数量（顶点位置/uv/color 每条目 2 个顶点）。 */
  indexCount: number;
}

/**
 * 粒子链 ribbon：模拟 PCF rope 的发射/重力/寿命，每帧重建面向相机的条带；
 * 颜色 = 顶点点色 × 生命周期 alpha（fade in 0.25s / fade out 到 1s，最后边缘到 0）。
 *
 * task-32 合批：一条 rope 的 4 层原来各建 1 个 Mesh（4 draw），现在按贴图分成 2 组，
 * 每组内 2 层共用一个 geometry + 材质（2 draw）。层的宽度/抖动/alpha 逐顶点各自计算，
 * 每帧动画语义不变（模拟只有一份：4 层参数完全相同，原本就是 4 份等价模拟）。
 */
class RopeRibbon {
  /** 实体块下标（运行期 Start/Stop 门控）。 */
  readonly entityIndex: number;
  /** 按贴图分组后的网格（beam 层组 / softBar 层组），每组 1 个 draw。 */
  readonly meshes: THREE.Mesh[] = [];
  private readonly groups: RopeLayerGroup[] = [];
  private readonly profile: RopeProfile;
  private readonly origin: THREE.Vector3;
  private readonly points: RopePoint[] = [];
  private readonly spawnAccum: { value: number };
  private readonly maxPoints: number;
  private readonly scrollOffset = { value: 0 };

  constructor(entity: ParticleEntity, profile: RopeProfile, textures: { beam: THREE.Texture; softBar: THREE.Texture }) {
    this.entityIndex = entity.entityIndex ?? -1;
    this.profile = profile;
    this.origin = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]);
    this.maxPoints = Math.ceil(profile.rate * profile.lifetime) + 2;
    this.spawnAccum = { value: 0 };

    const byTexture: Record<'beam' | 'softBar', RopeLayerSpec[]> = { beam: [], softBar: [] };
    for (const layer of ROPE_LAYERS) byTexture[layer.texture].push(layer);
    for (const name of ['beam', 'softBar'] as const) {
      const layers = byTexture[name];
      if (layers.length === 0) continue;
      const verts = this.maxPoints * 2 * layers.length;
      const positions = new Float32Array(verts * 3);
      const uvs = new Float32Array(verts * 2);
      const colors = new Float32Array(verts * 4);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      const index: number[] = [];
      for (let l = 0; l < layers.length; l++) {
        const base = l * this.maxPoints * 2;
        for (let i = 0; i < this.maxPoints - 1; i++) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      geometry.setIndex(index);
      const indexCount = index.length;
      geometry.setDrawRange(0, indexCount);
      // 层的不透明度烘进顶点 alpha（步 3 的 color.a），材质保持 opacity=1：
      // additive 的贡献 = 贴图 × 顶点色 × 顶点 alpha × material.opacity，与原实现等价。
      const material = new THREE.MeshBasicMaterial({
        map: textures[name],
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      this.groups.push({ layers, positions, uvs, colors, geometry, indexCount });
      this.meshes.push(mesh);
    }

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
      // 顶点全部清到原点（零面积），避免残留上一帧的旧几何。
      for (const group of this.groups) {
        group.positions.fill(0);
        group.colors.fill(0);
        (group.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        (group.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      }
      for (const mesh of this.meshes) mesh.visible = false;
      return;
    }
    for (const mesh of this.meshes) mesh.visible = true;
    const cameraPos = camera.position;
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    let dist = 0;

    // 点列只算一份；层与层的差别只有 halfW（宽度系数）、wob 幅度与顶点 alpha。
    // 末尾空槽（i >= n）填成最后一个点 ⇒ 三角形零面积，drawRange 恒定。
    for (let i = 0; i < this.maxPoints; i++) {
      const hasPoint = i < n;
      const p = this.points[Math.min(i, n - 1)];
      if (hasPoint) {
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
      }
      const alpha = hasPoint ? this.alphaOf(p.age) : 0;
      // 锥形：越靠上（越老）越宽，形成「喇叭口」的体积感
      const frac = i / Math.max(1, n - 1);
      // 源贴图：顶端（V=0）碎裂且更宽、底部连续亮刃更窄 => 上宽下窄（喇叭口）。
      // round-3（task-11）：底部翼展 2.40→1.70，配合 halo 宽度控制 wEff（收窄光晕翼展）。
      const widen = 0.34 + 1.70 * Math.pow(frac, 2.6);
      const tint = frac;
      for (const group of this.groups) {
        for (let li = 0; li < group.layers.length; li++) {
          const layer = group.layers[li];
          const halfW = (this.profile.width / 2) * layer.widthScale;
          const wob =
            (Math.sin(p.age * 1.1 + i * 0.55) * 0.07 + Math.sin(p.age * 0.4 + i * 0.19) * 0.05) *
            halfW *
            (1 - frac);
          const base = (li * this.maxPoints + i) * 2;
          for (let side = 0; side < 2; side++) {
            const vi = (base + side) * 3;
            const sign = side === 0 ? -1 : 1;
            // 原实现先 perp *= halfW 再乘 widen；这里 perp 保持单位向量，等价写成
            // perp * sign * widen * halfW（逐层 halfW 不同）。
            const half = widen * halfW;
            group.positions[vi] = p.pos.x + wob + perp.x * sign * half;
            group.positions[vi + 1] = p.pos.y + perp.y * sign * half;
            group.positions[vi + 2] = p.pos.z + wob * 0.6 + perp.z * sign * half;
            const ui = (base + side) * 2;
            group.uvs[ui] = side;
            group.uvs[ui + 1] = dist / this.profile.texelSize - this.scrollOffset.value;
            const ci = (base + side) * 4;
            group.colors[ci] = 1 - 0.2 * tint;
            group.colors[ci + 1] = 1 - 0.3 * tint;
            group.colors[ci + 2] = 1;
            // 层不透明度乘以原 material.opacity（profile.opacity × layer.opacity），
            // 与其他因子相乘后仍是 min(1, ...) 之外的同一个 additive 贡献。
            group.colors[ci + 3] = Math.min(1, alpha * (0.52 + 0.30 * frac)) * this.profile.opacity * layer.opacity;
          }
        }
      }
    }
    this.scrollOffset.value += dt * this.profile.scroll;
    for (const group of this.groups) {
      (group.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (group.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
      (group.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    for (const group of this.groups) group.geometry.dispose();
    for (const mesh of this.meshes) (mesh.material as THREE.Material).dispose();
    this.meshes.length = 0;
    this.groups.length = 0;
  }
}

/**
 * 光柱内上升的细碎星点（PCF 里 `render_animated_sprites` 子层的观感近似）：
 * 一批小的加法点精灵，沿光柱高度缓慢上升、随机横向漂移、按高度渐隐。
 */
class BeamMotes {
  /** 实体块下标（运行期 Start/Stop 门控）。 */
  readonly entityIndex: number;
  readonly points: THREE.Points;
  private readonly baseY: Float32Array;
  private readonly phase: Float32Array;
  private readonly radius: Float32Array;
  private readonly speeds: Float32Array;
  private readonly height: number;
  private readonly count: number;
  private readonly positions: Float32Array;
  private elapsed = 0;

  constructor(origin: THREE.Vector3, beamWidth: number, height: number, count: number, texture: THREE.Texture, color: number, entityIndex: number) {
    this.entityIndex = entityIndex;
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
      size: Math.max(4, beamWidth * 0.03),
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.42,
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

/**
 * 静态光球/光斑/辉光簇的描述（task-32）：原来是独立的 `THREE.Sprite`（每个 1 draw），
 * 现在只记参数，`ParticleSystems.update` 每帧按当前相机基向量写进共享的 `AdditiveQuadBatch`。
 * `r/g/b` 是线性工作空间的颜色（与原来 SpriteMaterial.color 的取值一致）。
 */
interface StaticBillboard {
  x: number;
  y: number;
  z: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface GlowCluster {
  /** 拥有该光团的实体下标（运行期 Start/Stop 门控）。 */
  ownerIndex: number;
  basePositions: THREE.Vector3[];
  phases: number[];
  drift: number[];
  sizeScales: number[];
  color: THREE.Color;
  slots: number[];
  count: number;
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
  /** 站点中心（世界空间）；父层光点与子层拖尾都从这里散布。 */
  readonly origin: THREE.Vector3;
  /** 实体块下标（运行期 Start/Stop 门控）。 */
  readonly entityIndex: number;
  /** 剔除用粗包围球半径：粒子会向上飘，要把「散布距离 + 上飘位移」都包住。 */
  readonly cullRadius: number;
  /** 父层光点占用的槽位数（诊断 stats 用）。 */
  readonly spriteCount: number;
  private readonly profile: AlchProfile;
  private readonly spriteBatch: AdditiveQuadBatch;
  private readonly spriteSlot: number;
  private readonly trailBatch: AdditiveQuadBatch;
  private readonly trailSlot: number;
  private readonly spriteColor: THREE.Color;
  private readonly trailTint: THREE.Color;
  private readonly spriteParticles: AlchSpriteParticle[] = [];
  private readonly trailParticles: AlchTrailParticle[] = [];
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpDelta = new THREE.Vector3();
  private readonly tmpTangent = new THREE.Vector3();
  private readonly tmpTail = new THREE.Vector3();
  private spriteAccum = 0;
  private trailAccum = 0;

  constructor(
    entity: ParticleEntity,
    profile: AlchProfile,
    spriteBatch: AdditiveQuadBatch,
    spriteSlot: number,
    trailBatch: AdditiveQuadBatch,
    trailSlot: number,
  ) {
    this.origin = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]);
    this.entityIndex = entity.entityIndex ?? -1;
    this.profile = profile;
    this.spriteCount = profile.sprite.maxParticles;
    this.spriteBatch = spriteBatch;
    this.spriteSlot = spriteSlot;
    this.trailBatch = trailBatch;
    this.trailSlot = trailSlot;
    this.spriteColor = new THREE.Color(profile.sprite.color);
    this.trailTint = new THREE.Color(profile.trail.color);
    this.cullRadius =
      Math.max(profile.sprite.distanceMax, profile.trail.distanceMax) +
      profile.sprite.maxVelocity * profile.sprite.lifeMax +
      profile.trail.maxVelocity * profile.trail.lifeMax;
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

  update(dt: number, camera: THREE.Camera, basis: BillboardBasis): void {
    this.step(dt);
    const spriteLayer = this.profile.sprite;
    const trailLayer = this.profile.trail;
    // 距离粗剔除：原来按 group 包围球做，合批后没有独立顶层对象可挂 visible，改在这里整体塌掉。
    const far = camera.position.distanceTo(this.origin) - this.cullRadius > PARTICLE_CULL_DISTANCE;
    if (far) {
      for (let i = 0; i < spriteLayer.maxParticles; i++) this.spriteBatch.collapseAt(this.spriteSlot + i);
      for (let i = 0; i < trailLayer.maxParticles; i++) this.trailBatch.collapseAt(this.trailSlot + i);
      return;
    }
    for (let i = 0; i < spriteLayer.maxParticles; i++) {
      const slot = this.spriteSlot + i;
      const particle = this.spriteParticles[i];
      if (!particle) {
        this.spriteBatch.collapseAt(slot);
        continue;
      }
      const t = particle.age / particle.life;
      // 有效 alpha = initialAlpha × Fade In Random(前 50%) × Fade and Decay(后 50% 到 0)。
      const fadeIn = t < 0.5 ? spline01(t / 0.5) : 1;
      const fadeOut = t <= 0.5 ? 1 : 1 - spline01((t - 0.5) / 0.5);
      const alpha = particle.alpha0 * fadeIn * fadeOut;
      if (alpha <= 0.002) {
        this.spriteBatch.collapseAt(slot);
        continue;
      }
      this.spriteBatch.billboardAt(
        slot,
        particle.pos.x,
        particle.pos.y,
        particle.pos.z,
        particle.radius * 2,
        basis,
        this.spriteColor.r,
        this.spriteColor.g,
        this.spriteColor.b,
        alpha,
      );
    }
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
      // 0: head+tan, 1: head-tan, 2: tail-tan, 3: tail+tan（与 CollectSpriteTrail 的 quad 顺序一致）
      this.trailBatch.orientedQuadAt(
        this.trailSlot + active,
        head.x + tan.x,
        head.y + tan.y,
        head.z + tan.z,
        head.x - tan.x,
        head.y - tan.y,
        head.z - tan.z,
        tail.x - tan.x,
        tail.y - tan.y,
        tail.z - tan.z,
        tail.x + tan.x,
        tail.y + tan.y,
        tail.z + tan.z,
        this.trailTint.r,
        this.trailTint.g,
        this.trailTint.b,
        alpha,
      );
      active++;
    }
    for (let i = active; i < trailLayer.maxParticles; i++) this.trailBatch.collapseAt(this.trailSlot + i);
  }

  /** 运行期 Stop / 初态 `start_active=0`：两层槽位全塌；模拟状态保留，`Start` 后接着跑。 */
  collapse(): void {
    for (let i = 0; i < this.profile.sprite.maxParticles; i++) {
      this.spriteBatch.collapseAt(this.spriteSlot + i);
    }
    for (let i = 0; i < this.profile.trail.maxParticles; i++) {
      this.trailBatch.collapseAt(this.trailSlot + i);
    }
  }

  dispose(): void {
    this.spriteParticles.length = 0;
    this.trailParticles.length = 0;
  }
}

/**
 * 粒子系统集合：运行时按实体创建光柱/辉光，`update(dt, camera)` 推进模拟与 billboard。
 */
/** 光效对象的距离剔除上限（HU）。取地图剔除档的上限量级：更远时块本身已被剔除，光效没有意义。 */
const PARTICLE_CULL_DISTANCE = 18000;

/** 求顶层对象的包围球（局部坐标 == root 坐标，root 恒为单位变换）。sprite 用位置+缩放近似。 */
function cullBoundOf(obj: THREE.Object3D): { center: THREE.Vector3; radius: number } | null {
  const center = new THREE.Vector3();
  let radius = 0;
  let any = false;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  obj.traverse((node) => {
    const sprite = node as THREE.Sprite;
    if (sprite.isSprite) {
      const s = sprite.scale;
      const r = Math.max(Math.abs(s.x), Math.abs(s.y), 1) * 0.75;
      const p = new THREE.Vector3().setFromMatrixPosition(sprite.matrixWorld);
      box.expandByPoint(p.clone().addScalar(-r));
      box.expandByPoint(p.clone().addScalar(r));
      any = true;
      return;
    }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geom = (node as THREE.Mesh).geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    // 顶点每帧都在动（rope 尾迹/飘移粒子），旧包围盒不可复用，重算。
    if (!pos || pos.count === 0) return;
    geom.computeBoundingBox();
    if (!geom.boundingBox) return;
    tmp.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
    box.union(tmp);
    any = true;
  });
  if (!any || box.isEmpty()) return null;
  box.getBoundingSphere(new THREE.Sphere(center, 0));
  radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  // 动态部分（粒子飘移/缩放脉动）留 15% 余量
  return { center, radius: radius * 1.15 + 8 };
}

export class ParticleSystems {
  readonly root = new THREE.Group();
  private readonly beamTexture: THREE.Texture;
  private readonly glowTexture: THREE.Texture;
  private readonly ballTexture: THREE.Texture;
  private readonly softBarTexture: THREE.Texture;
  private readonly ropes: RopeRibbon[] = [];
  private readonly glowClusters: GlowCluster[] = [];
  private readonly hazes: THREE.Mesh[] = [];
  private readonly hazeTexture: THREE.Texture;
  /** 包围球是否已经算过（首帧模拟跑完才算，见 update）。 */
  private cullTagged = false;
  /** 包围球刷新计数：rope/尾迹顶点每帧在动，隔帧刷新避免用旧包围球误剔。 */
  private cullTagFrame = 0;
  private readonly motes: BeamMotes[] = [];
  /** 符文祭坛（alch）的两层 PCF 粒子（环几何由 brush 实体负责，不在这里）。 */
  private readonly alchFields: AlchParticleField[] = [];
  /**
   * 被 I/O `Stop`（或初态 `start_active=0`）关掉的 `info_particle_system` 实体：
   * 不推进模拟、槽位全塌、顶层对象强制不可见；`Start` 从集合里移除即可恢复（模拟状态未销毁）。
   */
  private readonly suppressed = new Set<number>();
  /** rope 底部光球/底光斑的静态参数（合批后每帧按相机基向量摆 quad）。 */
  private readonly ropeBillboards: {
    ribbon: RopeRibbon;
    entityIndex: number;
    balls: StaticBillboard[];
    flares: StaticBillboard[];
    ballSlot: number;
    flareSlot: number;
  }[] = [];
  /** 合批容器：底部光球 / 光斑+辉光簇+alch 光点 / alch 拖尾，各 1 个 draw。 */
  private readonly ballBatch: AdditiveQuadBatch;
  private readonly spriteBatch: AdditiveQuadBatch;
  private readonly trailBatch: AdditiveQuadBatch;
  private elapsed = 0;
  private readonly basis: BillboardBasis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };
  private readonly _cullProj = new THREE.Matrix4();
  private readonly _cullFrustum = new THREE.Frustum();
  private readonly _cullSphere = new THREE.Sphere();
  private readonly _cullCam = new THREE.Vector3();

  constructor(entities: ParticleEntity[]) {
    this.root.name = 'particle-systems';
    this.beamTexture = makeBeamTexture();
    this.glowTexture = makeGlowTexture();
    this.ballTexture = makeBallTexture();
    this.softBarTexture = makeSoftBarTexture();
    this.hazeTexture = makeHazeTexture();

    // 合批容量在建对象前一次算好：每条 rope = 24 底部光球 + 28 底光斑；每个辉光簇 = glow.count；
    // 每个 alch 站点 = maxParticles 个父层光点 + maxParticles 个拖尾 quad。
    const BALL_SPRITES = 24;
    const FLARE_SPRITES = 28;
    let ropeCount = 0;
    let glowSpriteCount = 0;
    let alchCount = 0;
    for (const entity of entities) {
      if (ROPE_PROFILES[entity.effect]) {
        ropeCount += 1;
        continue;
      }
      const glowProfile = GLOW_PROFILES[entity.effect];
      if (glowProfile) {
        glowSpriteCount += glowProfile.count;
        continue;
      }
      if (ALCH_PROFILES[entity.effect]) alchCount += 1;
    }
    const alchProfiles = Object.values(ALCH_PROFILES);
    const alchSpriteMax = alchProfiles.reduce((max, p) => Math.max(max, p.sprite.maxParticles), 0);
    const alchTrailMax = alchProfiles.reduce((max, p) => Math.max(max, p.trail.maxParticles), 0);
    // renderOrder 与原 Sprite 一致：底部光球 12、底光斑/辉光簇/alch 光点 11、alch 拖尾 10。
    // 前两个批的来源是 Sprite（过去不进 bloom 光效层）⇒ vbspNoGlow；拖尾来源是 Mesh（会进）⇒ 保留。
    this.ballBatch = new AdditiveQuadBatch(this.ballTexture, ropeCount * BALL_SPRITES, 12, true);
    this.spriteBatch = new AdditiveQuadBatch(
      this.glowTexture,
      ropeCount * FLARE_SPRITES + glowSpriteCount + alchCount * alchSpriteMax,
      11,
      true,
    );
    this.trailBatch = new AdditiveQuadBatch(this.glowTexture, alchCount * alchTrailMax, 10, false);
    // 合批网格是「全局一张」：不参与光效的距离/视锥剔除，细粒度可见性由各站点在 update 里
    // 把槽位塌成零面积（等价于原来逐个 Sprite/Group 改 visible）。
    this.root.add(this.ballBatch.mesh, this.spriteBatch.mesh, this.trailBatch.mesh);

    let ballSlot = 0;
    let spriteSlot = 0;
    let trailSlot = 0;

    for (const entity of entities) {
      const entityIndex = entity.entityIndex ?? -1;
      const startActive = entity.startActive !== false;
      const rope = ROPE_PROFILES[entity.effect];
      if (rope) {
        // 四层叠加（task-11 round-3：把「亮核宽度 w90」与「光晕翼展 w60/w40」解耦）：
        //   core    = laser01 阶梯贴图，窄亮刃（左偏 U≈0.113 的激光刃，非对称细节）
        //   halo    = softBar 宽翼展（控制 w60/w40；宽度 0.48→0.60、opacity 0.52→0.35）
        //   plateau = softBar 窄亮核（w90 由它撑住；宽度 0.29、opacity 0.40）
        //   inner   = laser01 阶梯窄刃（补黑带细节）
        // 依据 `.tmp/pcf/LOOK_FORENSICS.md` §5：实机 w90=51 / w60=121 / w40=237 / wEff=236 HU，
        // 峰值中位 194 且无 L≥250。round-2 交付时 w90 已对齐，但 w60/w40 偏宽近 2 倍 ⇒ 本层拆分。
        // task-14（BRIGHTNESS_GAP §7 增益表）：峰值/宽度已对齐，缺口是「整体强度」——
        // ROI meanL 83.9 vs ref 89.4、rowFrac250 0.037 vs 0.090、ROOT meanL 196 vs 252。
        // 故只加 opacity（不加宽，保住 w90≤65 / w60≥137.6 / w40≥206.5）；halo 宽度 0.60→0.70
        // 是表中唯一加宽项，用于补 w60 缺口（178.9 vs ref 215.6）。
        // task-32 合批：4 层按贴图并成 2 个 Mesh（beam 组 = core+inner / softBar 组 = halo+plateau），
        // 模拟只跑一份（4 层参数本来完全一致）；宽度/不透明度仍按 ROPE_LAYERS 逐层生效。
        const ribbon = new RopeRibbon(entity, rope, { beam: this.beamTexture, softBar: this.softBarTexture });
        this.ropes.push(ribbon);
        if (!startActive) this.suppressed.add(entityIndex);
        this.root.add(...ribbon.meshes);
        // 柱底「白热光球」= `tendies_endparticle04`（pcf-scout task-15 实测）：
        // render_animated_sprites + particle_glow_11，radius 800（半宽 ⇒ 单 sprite 1600 HU），
        // 64 发/s、寿命 0.25–0.5s、max 32，位置 Box z −400..−512 ⇒ 24–32 个 1600 HU 加法光斑
        // 叠在同一点，中心直接饱和。实机白核直径 531±30 HU、过曝占 bbox 61–64%、粉紫晕到 ~400 HU。
        // 这里用 24 个 sprite（scale 1500–1700、per-sprite opacity 0.085 ⇒ 中心 24×0.085≈2.0 叠加）
        // 收拢在 ±70 HU 内，得到硬白核 + 外圈紫晕；不再用「单张大光晕」近似。
        // 球心在符文盘平面**之下**（用户 m14239 对照实机指出：大部分球体低于符文高度）。
        // pcf-scout task-16 复核（`.tmp/pcf/ball-geometry.json`）：
        //   04 的 `Position Within Box Random` 是 local space 偏移 min (0,0,−400) / max (0,0,−512)，
        //   mean −456 ⇒ 球心 world y = 725.312 − 456 = 269.3，位于内盘顶面 756.59 之下 487 HU；
        //   盘面到世界地面（−469）之间**没有实体面**，球就悬在坑洞里。
        const ballColor = new THREE.Color(0xffeef6);
        const ballCenterY = entity.origin[1] - 456;
        // 白核对齐实机 531 HU：单 sprite 1600 HU × 34% = 544 HU，靠「近同心 + 少量散布」保持核心不被撑大。
        const balls: StaticBillboard[] = [];
        for (let i = 0; i < BALL_SPRITES; i += 1) {
          const angle = i * 2.399963; // 黄金角散布，避免规则条纹
          const spread = i < 8 ? 0 : 8 + (i % 5) * 8;
          balls.push({
            x: entity.origin[0] + Math.cos(angle) * spread,
            y: ballCenterY + 8 + (i % 5) * 10,
            z: entity.origin[2] + Math.sin(angle) * spread,
            size: 1500 + (i % 5) * 30,
            r: ballColor.r,
            g: ballColor.g,
            b: ballColor.b,
            a: 0.085,
          });
        }
        const motes = new BeamMotes(
          new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]),
          rope.width,
          4200,
          42,
          this.glowTexture,
          0xd8ccff,
          entityIndex,
        );
        this.root.add(motes.points);
        this.motes.push(motes);
        // 柱底大光斑（源 render_animated_sprites 04：radius 800 => 1600x1600 的 32 个大光斑堆在底部）
        // round-3（task-11）：32 个加法 sprite 在中心叠加会抬高 wEff/造成底部行饱和；28 个、opacity
        // 0.010→0.007（约 -30%），峰值缺口由 plateau 层补，不偏离 PCF 语义（这层本就是近似）。
        const flareWarm = new THREE.Color(0xf4f6ff);
        const flareCool = new THREE.Color(0xd9deff);
        const flares: StaticBillboard[] = [];
        for (let i = 0; i < FLARE_SPRITES; i++) {
          const color = i % 3 === 0 ? flareWarm : flareCool;
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.random() * 260;
          flares.push({
            x: entity.origin[0] + Math.cos(ang) * rad,
            y: ballCenterY + (Math.random() - 0.5) * 260,
            z: entity.origin[2] + Math.sin(ang) * rad,
            size: 700 + Math.random() * 900,
            r: color.r,
            g: color.g,
            b: color.b,
            a: 0.009,
          });
        }
        this.ropeBillboards.push({ ribbon, entityIndex, balls, flares, ballSlot, flareSlot: spriteSlot });
        ballSlot += BALL_SPRITES;
        spriteSlot += FLARE_SPRITES;
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
            // round-3（task-11）：满高度雾面是「梁外背景中位 L」偏高的主因（0.11→0.035，
            // 实测背景 300–600HU medL 78→66.6、600–1200HU 59→51.6，目标 55–70）。
            opacity: 0.022,
          }),
        );
        haze.position.set(entity.origin[0], entity.origin[1] + 2000, entity.origin[2]);
        haze.renderOrder = 9;
        // 门控按实体下标找对象（haze 与 rope/motes 是同一实体的三层）。
        haze.userData.vbspParticleEntity = entityIndex;
        this.root.add(haze);
        this.hazes.push(haze);
        continue;
      }
      const glow = GLOW_PROFILES[entity.effect];
      if (glow) {
        this.glowClusters.push(this.buildGlow(entity, glow, spriteSlot));
        if (!startActive) this.suppressed.add(entityIndex);
        spriteSlot += glow.count;
        continue;
      }
      const alch = ALCH_PROFILES[entity.effect];
      if (alch) {
        // task-32：父层光点 / 子层拖尾都写进共享批（不再各自建 Sprite / Mesh）。
        const field = new AlchParticleField(entity, alch, this.spriteBatch, spriteSlot, this.trailBatch, trailSlot);
        this.alchFields.push(field);
        if (!startActive) this.suppressed.add(entityIndex);
        spriteSlot += alch.sprite.maxParticles;
        trailSlot += alch.trail.maxParticles;
      }
    }
    // 所有光效对象都是「实体挂件」，不进合并块 ⇒ 块级 PVS/距离剔除管不到它们，
    // 由 `update()` 里按视锥 + 距离做粗剔除。包围球必须等第一帧模拟跑完再算：
    // 构造时 rope/尾迹的顶点缓冲还是空的，算出来的包围球贴在原点，会把整片光效误剔除。
  }

  /**
   * 运行期 I/O `Start` / `Stop`（`particle_system.cpp:117-118`）：只改门控集合，不销毁模拟状态。
   * 返回 false 表示该实体没有可门控的粒子对象（effect 未命中本实现的 profile）。
   */
  setEntityActive(entityIndex: number, active: boolean): boolean {
    const owned =
      this.ropes.some((r) => r.entityIndex === entityIndex) ||
      this.glowClusters.some((c) => c.ownerIndex === entityIndex) ||
      this.alchFields.some((f) => f.entityIndex === entityIndex);
    if (!owned) return false;
    if (active) this.suppressed.delete(entityIndex);
    else this.suppressed.add(entityIndex);
    return true;
  }

  /** 该实体当前的粒子门控状态（诊断用；没有对象时返回 null）。 */
  isEntityActive(entityIndex: number): boolean | null {
    let owned = false;
    for (const r of this.ropes) if (r.entityIndex === entityIndex) owned = true;
    for (const c of this.glowClusters) if (c.ownerIndex === entityIndex) owned = true;
    for (const f of this.alchFields) if (f.entityIndex === entityIndex) owned = true;
    return owned ? !this.suppressed.has(entityIndex) : null;
  }

  /**
   * 辉光簇（`tendies_snow01` 类）改成描述符：每帧按相机基向量写进共享的 sprite 批
   * （原来每个光点一个 `THREE.Sprite` = 1 draw）。随机数调用顺序与原实现一致。
   */
  private buildGlow(entity: ParticleEntity, glow: { size: number; color: number; count: number }, firstSlot: number): GlowCluster {
    const basePositions: THREE.Vector3[] = [];
    const phases: number[] = [];
    const drift: number[] = [];
    const sizeScales: number[] = [];
    const slots: number[] = [];
    for (let i = 0; i < glow.count; i++) {
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * glow.size * 0.8,
        Math.random() * glow.size * 1.4,
        (Math.random() - 0.5) * glow.size * 0.8,
      );
      const base = new THREE.Vector3(entity.origin[0], entity.origin[1], entity.origin[2]).add(offset);
      basePositions.push(base);
      sizeScales.push(glow.size * (0.5 + Math.random() * 0.7));
      slots.push(firstSlot + i);
      phases.push(Math.random() * Math.PI * 2);
      drift.push(8 + Math.random() * 18);
    }
    return {
      ownerIndex: entity.entityIndex ?? -1,
      basePositions,
      phases,
      drift,
      sizeScales,
      // SpriteMaterial.color 会按 SRGB→线性转换；THREE.Color 构造同源，逐像素等价。
      color: new THREE.Color(glow.color),
      slots,
      count: glow.count,
      elapsed: Math.random() * 4,
    };
  }

  /** 每帧推进：`dt` 秒；`camera` 用于 billboard 与朝向。 */
  update(dt: number, camera: THREE.Camera): void {
    this.elapsed += dt;
    for (const rope of this.ropes) {
      if (this.suppressed.has(rope.entityIndex)) continue;
      rope.update(dt, camera);
    }
    for (const motes of this.motes) {
      if (this.suppressed.has(motes.entityIndex)) continue;
      motes.update(dt);
    }
    for (const haze of this.hazes) {
      if (this.suppressed.has(haze.userData.vbspParticleEntity as number)) continue;
      haze.quaternion.copy(camera.quaternion);
      haze.rotateY(Math.PI);
    }
    // 包围球：首帧模拟跑完再算（构造时 rope/尾迹顶点缓冲还是空的，算出来会贴在原点；
    // 那样整片光效都会被判到视锥外而消失）；之后每 30 帧刷新一次，rope 顶点一直在动。
    this.cullTagFrame++;
    if (!this.cullTagged || this.cullTagFrame % 30 === 0) {
      this.tagCullBounds();
      this.cullTagged = true;
    }
    this.cullByCamera(camera);
    // 门控必须压在剔除之后：剔除会按包围球把 rope/haze/motes 重新置 visible。
    this.applyEntityGate();

    // task-32：光效四边形全部写进三张共享批。drawRange 恒定，所以每帧每个槽位要么写
    // 真实四边形、要么塌成零面积（否则会残留上一帧的顶点）。
    billboardBasisOf(camera, this.basis);
    this.ballBatch.begin();
    this.spriteBatch.begin();
    this.trailBatch.begin();
    // rope 底部光球/底光斑：同一条 rope 的两层光柱共用一片区域，任一层可见就画。
    for (const rig of this.ropeBillboards) {
      const visible = rig.ribbon.meshes.some((mesh) => mesh.visible);
      for (let i = 0; i < rig.balls.length; i++) {
        const b = rig.balls[i];
        if (visible) {
          this.ballBatch.billboardAt(rig.ballSlot + i, b.x, b.y, b.z, b.size, this.basis, b.r, b.g, b.b, b.a);
        } else {
          this.ballBatch.collapseAt(rig.ballSlot + i);
        }
      }
      for (let i = 0; i < rig.flares.length; i++) {
        const f = rig.flares[i];
        if (visible) {
          this.spriteBatch.billboardAt(rig.flareSlot + i, f.x, f.y, f.z, f.size, this.basis, f.r, f.g, f.b, f.a);
        } else {
          this.spriteBatch.collapseAt(rig.flareSlot + i);
        }
      }
    }
    // 辉光簇：呼吸 alpha + 上飘漂移（公式与原 Sprite 版逐项一致）；远处按距离整簇塌掉，
    // 等价于原来每个 Sprite 各自的包围球距离剔除。
    const maxDist = PARTICLE_CULL_DISTANCE;
    for (const cluster of this.glowClusters) {
      if (this.suppressed.has(cluster.ownerIndex)) {
        for (let i = 0; i < cluster.count; i++) this.spriteBatch.collapseAt(cluster.slots[i]);
        continue;
      }
      cluster.elapsed += dt;
      for (let i = 0; i < cluster.count; i++) {
        const base = cluster.basePositions[i];
        const dx = base.x - camera.position.x;
        const dy = base.y - camera.position.y;
        const dz = base.z - camera.position.z;
        // 原剔除判据是「中心距 − 包围球半径 > maxDist」，这里同样留出 sprite 半径。
        const reach = maxDist + cluster.sizeScales[i];
        if (dx * dx + dy * dy + dz * dz > reach * reach) {
          this.spriteBatch.collapseAt(cluster.slots[i]);
          continue;
        }
        const t = cluster.elapsed * 0.5 + cluster.phases[i];
        this.spriteBatch.billboardAt(
          cluster.slots[i],
          base.x + Math.sin(t * 0.7) * 4,
          base.y + ((cluster.elapsed * cluster.drift[i]) % 24),
          base.z + Math.cos(t * 0.9) * 4,
          cluster.sizeScales[i],
          this.basis,
          cluster.color.r,
          cluster.color.g,
          cluster.color.b,
          0.14 + 0.18 * (0.5 + 0.5 * Math.sin(t)),
        );
      }
    }
    // alch 站点自己处理父层/子层槽位（内含弹道模拟与距离粗剔除）。
    for (const field of this.alchFields) {
      if (this.suppressed.has(field.entityIndex)) field.collapse();
      else field.update(dt, camera, this.basis);
    }
    this.ballBatch.end();
    this.spriteBatch.end();
    this.trailBatch.end();
  }

  /** 初态 `start_active=0` / 运行期 `Stop` 的实体：顶层对象强制不可见（槽位在写批时塌掉）。 */
  private applyEntityGate(): void {
    if (this.suppressed.size === 0) return;
    for (const rope of this.ropes) {
      if (!this.suppressed.has(rope.entityIndex)) continue;
      for (const mesh of rope.meshes) mesh.visible = false;
    }
    for (const motes of this.motes) {
      if (this.suppressed.has(motes.entityIndex)) motes.points.visible = false;
    }
    for (const haze of this.hazes) {
      if (this.suppressed.has(haze.userData.vbspParticleEntity as number)) haze.visible = false;
    }
  }

  /**
   * 光效不参与块级 PVS/距离剔除（它们挂在实体上、不在合并块里），旧实现是「永远画」：
   * 远处/身后的大面积加法面片照样提交、照样过一遍混合与泛光，末尾水区这类视野里会明显掉帧。
   * 这里按「每个顶层对象构造时算好的包围球」做视锥 + 距离粗剔除（半径已带余量，只在这种
   * 粗粒度上剔除，不会出现面片突然被切掉的观感）。距离上限取地图剔除档的上限量级。
   */
  private cullByCamera(camera: THREE.Camera): void {
    const dbg = globalThis as { __vbspParticleCullOff?: boolean };
    if (dbg.__vbspParticleCullOff) {
      // 诊断口：关掉剔除，用来 A/B 判断「光效是不是被剔掉了」。
      for (const child of this.root.children) child.visible = true;
      return;
    }
    const proj = this._cullProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._cullFrustum.setFromProjectionMatrix(proj);
    const camPos = this._cullCam.setFromMatrixPosition(camera.matrixWorld);
    const maxDist = PARTICLE_CULL_DISTANCE;
    for (const child of this.root.children) {
      const bound = child.userData.cullBound as { center: THREE.Vector3; radius: number } | undefined;
      if (!bound) continue;
      if (camPos.distanceTo(bound.center) - bound.radius > maxDist) {
        child.visible = false;
        continue;
      }
      this._cullSphere.center.copy(bound.center);
      this._cullSphere.radius = bound.radius;
      child.visible = this._cullFrustum.intersectsSphere(this._cullSphere);
    }
  }

  /** 构造完成后给每个顶层对象记一份包围球（只算一次；动态部分留了余量）。 */
  private tagCullBounds(): void {
    for (const child of this.root.children) {
      // 合批网格是全局一张（细粒度可见性由槽位塌陷负责），不要给它算包围球，
      // 否则整张批会被一个错的包围球整片剔掉。
      if (child.userData.vbspNoCull) continue;
      const bound = cullBoundOf(child);
      if (bound) child.userData.cullBound = bound;
    }
  }

  dispose(): void {
    for (const rope of this.ropes) rope.dispose();
    this.ropes.length = 0;
    for (const field of this.alchFields) field.dispose();
    this.alchFields.length = 0;
    this.ballBatch.dispose();
    this.spriteBatch.dispose();
    this.trailBatch.dispose();
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
    this.ballTexture.dispose();
    this.softBarTexture.dispose();
    this.hazeTexture.dispose();
    for (const motes of this.motes) motes.dispose();
    this.motes.length = 0;
    this.glowClusters.length = 0;
    this.ropeBillboards.length = 0;
  }

  /** 诊断：当前挂了多少光柱 / 辉光 / 祭坛粒子（面板或 CDP 用）。 */
  stats(): { ropes: number; glowClusters: number; sprites: number; points: number; alchFields: number } {
    return {
      ropes: this.ropes.length,
      glowClusters: this.glowClusters.length,
      // 合批后「sprites」= 写进 sprite 批的光点总数（光斑 + 辉光簇 + alch 父层），
      // 不再等于 draw 数（全部合并成 1 draw）。
      sprites:
        this.ropeBillboards.reduce((sum, rig) => sum + rig.balls.length + rig.flares.length, 0) +
        this.glowClusters.reduce((sum, c) => sum + c.count, 0) +
        this.alchFields.reduce((sum, f) => sum + f.spriteCount, 0),
      points: this.motes.reduce((sum, m) => sum + (m.points.geometry.getAttribute('position') as THREE.BufferAttribute).count, 0),
      alchFields: this.alchFields.length,
    };
  }
}
