/**
 * `env_sprite` / `env_sprite_clientside` 的加法 billboard 光晕。
 *
 * 语义来源（`test/project/source-sdk-2013-master/src/game/client/`）：
 * - `env_sprite` 的 `model` 指向 `sprites/*.spr|*.vmt`，`scale` 乘模型基准尺寸；
 * - `rendercolor`/`renderamt` 决定颜色与亮度；本图 151 条的 `rendermode` 只有 5 与 9
 *   （kRenderTransAdd 一系），统一按加法渲染。
 *
 * **近似**：PAK 里没有 `.spr`/`.vmt`/`.vtf`，模型基准尺寸（纹理边长，HU）与贴图形状
 * 都取近似（形状见 `textures.ts` 的径向光晕，尺寸见下表）。所以这里保证「位置、数量、
 * 颜色、大致大小」忠实，不保证逐像素还原——取证见
 * `.tmp/enhance-plugin/gaps/vscript-assets-wall-report.md` §3。
 *
 * 151 条全部写进一个 `BillboardQuadBatch`：整类实体 1 次 draw。
 */

import * as THREE from 'three';

import { parseVec3, type EntityBlockRecords } from '../particles.js';
import { BillboardQuadBatch, billboardBasisOf, type BillboardBasis } from './billboard-batch.js';
import { parseEntityColor } from './colors.js';
import { makeGlowTexture } from './textures.js';

/**
 * `sprites/*` 的世界基准尺寸（HU）：近似值，按模型家族常见纹理边长给出。
 * 找不到的模型退回 `DEFAULT_SPRITE_BASE_SIZE`。
 */
const MODEL_BASE_SIZE: Record<string, number> = {
  'sprites/glow01.spr': 64,
  'sprites/glow07.vmt': 128,
  'sprites/light_glow02.vmt': 64,
  'sprites/glow_test01b.vmt': 128,
  'sprites/glow.vmt': 64,
  'sprites/halo.vmt': 128,
};

const DEFAULT_SPRITE_BASE_SIZE = 64;
/** 画在透明光效层（lasers 13）之前；同层内加法与顺序无关。 */
const SPRITE_RENDER_ORDER = 12;

/** 一条 `env_sprite`（已换算到 Y-up 世界坐标）。 */
export interface SpriteEntity {
  /** 世界坐标（Y-up，HU）。 */
  origin: [number, number, number];
  /** 世界尺寸（HU，= 模型基准尺寸 × `scale`）。 */
  size: number;
  /** 线性空间颜色（`rendercolor × renderamt/255`）。 */
  color: THREE.Color;
  /** `model` 键原文（仅用于诊断/面板）。 */
  model: string;
}

/** 从实体键值块里收集 `env_sprite` / `env_sprite_clientside`。 */
export function collectSpriteEntities(blocks: EntityBlockRecords): SpriteEntity[] {
  const out: SpriteEntity[] = [];
  for (const block of blocks) {
    const cls = block['classname'];
    if (cls !== 'env_sprite' && cls !== 'env_sprite_clientside') continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const model = (block['model'] ?? '').trim();
    const base = MODEL_BASE_SIZE[model] ?? DEFAULT_SPRITE_BASE_SIZE;
    const scaleRaw = Number.parseFloat(block['scale'] ?? '');
    const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;
    const color = new THREE.Color();
    parseEntityColor(block['rendercolor'], block['renderamt'], color);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)。
    out.push({ origin: [src[1], src[2], src[0]], size: base * scale, color, model });
  }
  return out;
}

/** 一整类 `env_sprite`：一个加法 quad batch，1 次 draw；每帧按相机基向量重写四边形。 */
export class SpriteGlows {
  readonly root = new THREE.Group();
  /** 采到的实体数（含尺寸为 0 的，仍算「已覆盖」）。 */
  readonly count: number;
  private readonly entities: SpriteEntity[];
  private readonly texture: THREE.Texture;
  private readonly batch: BillboardQuadBatch;
  private readonly basis: BillboardBasis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };

  constructor(entities: SpriteEntity[]) {
    this.entities = entities;
    this.count = entities.length;
    this.root.name = 'entity-sprites';
    this.texture = makeGlowTexture();
    this.batch = new BillboardQuadBatch(
      this.texture,
      Math.max(1, entities.length),
      SPRITE_RENDER_ORDER,
      'additive',
    );
    this.root.add(this.batch.mesh);
  }

  get draws(): number {
    return this.batch.draws;
  }

  update(camera: THREE.Camera): void {
    billboardBasisOf(camera, this.basis);
    this.batch.begin();
    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i];
      const half = Math.max(0, entity.size) * 0.5;
      // alpha 恒 1：亮度已经乘进顶点色（renderamt/255）。
      this.batch.billboardAt(
        i,
        entity.origin[0],
        entity.origin[1],
        entity.origin[2],
        half,
        half,
        this.basis,
        entity.color.r,
        entity.color.g,
        entity.color.b,
        1,
      );
    }
    this.batch.end();
  }

  dispose(): void {
    this.batch.dispose();
    this.texture.dispose();
    this.root.clear();
  }
}
