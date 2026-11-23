/**
 * `point_worldtext` 的 3D 文字（面向相机的 billboard）。
 *
 * 语义来源（`test/project/source-sdk-2013-master/src/game/server/PointWorldText.cpp`）：
 * - 实体键 `message`（文字内容）、`textsize`（世界单位字高）、`color`（"r g b"）、
 *   `angles`（本实现忽略：始终面向相机）；
 * - 文字是「世界里的面板」，无贴图资产：这里用 canvas `fillText` 画进一张图集，
 *   每个实体一个 quad，全部 quad 合进一个 batch = 1 次 draw。
 *
 * 图集打包：每条按 `textsize × 4` 的像素字高量宽（不小于 24 px、不大于 160 px，
 * 保证近看清晰、远看不过度占图集），白字 + 深色描边（描边保证在亮背景上可读），
 * 顶点色乘实体颜色；材质走普通半透明混合（文字颜色准确，且不进 bloom 光效层）。
 *
 * 注意：本图 11 条 `point_worldtext` 里有 1 条（`text_lvl03b`）**没有 `message` 键**
 * ——Source 里它同样不显示文字。`count` 统计采到的实体数（11），实际 quad 只有 10。
 */

import * as THREE from 'three';

import { parseVec3, type EntityBlockRecords } from '../particles.js';
import {
  BillboardQuadBatch,
  billboardBasisOf,
  type BillboardBasis,
  type BillboardUv,
} from './billboard-batch.js';
import { parseEntityColor } from './colors.js';

/** 画在其它半透明光效之前（文字不被光晕盖掉）。 */
const WORLDTEXT_RENDER_ORDER = 11;
const DEFAULT_TEXT_SIZE = 10;
/** 图集固定宽度（POT）：2048 足够本图最长一行（约 500 px @32 px 字高）。 */
const ATLAS_WIDTH = 2048;
/** 每个条目四周的透明留白（px）：避免 mipmap 采样跨条目渗色。 */
const ATLAS_PAD = 4;
/** 每条文字的最小/最大像素字高。 */
const MIN_PX_HEIGHT = 24;
const MAX_PX_HEIGHT = 160;

/** 一条 `point_worldtext`（已换算到 Y-up 世界坐标）。 */
export interface WorldTextEntity {
  /** 世界坐标（Y-up，HU）。 */
  origin: [number, number, number];
  /** `message` 键（可能为空：实体存在但没有文字）。 */
  message: string;
  /** 世界单位字高（HU）。 */
  textSize: number;
  /** 线性空间颜色。 */
  color: THREE.Color;
}

/** 汇编进图集的一条文字。 */
interface MeasuredText {
  entity: WorldTextEntity;
  font: string;
  /** 图集像素坐标/尺寸（含 padding）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 像素字高（= font px）。 */
  px: number;
}

/** 一个已定位的 billboard（世界尺寸 + UV）。 */
interface WorldTextQuad {
  x: number;
  y: number;
  z: number;
  halfWidth: number;
  halfHeight: number;
  color: THREE.Color;
  uv: BillboardUv;
}

/** 从实体键值块里收集 `point_worldtext`（含没有 `message` 的条目）。 */
export function collectWorldTextEntities(blocks: EntityBlockRecords): WorldTextEntity[] {
  const out: WorldTextEntity[] = [];
  for (const block of blocks) {
    if (block['classname'] !== 'point_worldtext') continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const textSizeRaw = Number.parseFloat(block['textsize'] ?? '');
    const textSize = Number.isFinite(textSizeRaw) && textSizeRaw > 0 ? textSizeRaw : DEFAULT_TEXT_SIZE;
    const color = new THREE.Color();
    // 本图用的是 `color` 键；`rendercolor` 作为兼容回退。
    parseEntityColor(block['color'] ?? block['rendercolor'], block['renderamt'], color);
    // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)。
    out.push({
      origin: [src[1], src[2], src[0]],
      message: (block['message'] ?? '').trim(),
      textSize,
      color,
    });
  }
  return out;
}

/** 一整类 `point_worldtext`：一张图集 + 一个 billboard batch，1 次 draw。 */
export class WorldTexts {
  readonly root = new THREE.Group();
  /** 采到的实体数（含没有文字的条目）。 */
  readonly count: number;
  private readonly texture: THREE.Texture | null;
  private readonly batch: BillboardQuadBatch | null;
  private readonly quads: WorldTextQuad[];
  private readonly basis: BillboardBasis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };

  constructor(entities: WorldTextEntity[]) {
    this.count = entities.length;
    this.root.name = 'entity-worldtext';
    const drawable = entities.filter((entity) => entity.message.length > 0);
    if (drawable.length === 0) {
      this.texture = null;
      this.batch = null;
      this.quads = [];
      return;
    }
    const canvas = document.createElement('canvas');
    const measureCtx = canvas.getContext('2d');
    if (!measureCtx) {
      this.texture = null;
      this.batch = null;
      this.quads = [];
      return;
    }
    // 1) 量宽：像素字高由 textsize 决定（×4 提高采样密度）。
    const measured: MeasuredText[] = [];
    for (const entity of drawable) {
      const px = Math.min(
        MAX_PX_HEIGHT,
        Math.max(MIN_PX_HEIGHT, Math.round(entity.textSize * 4)),
      );
      const font = `600 ${px}px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
      measureCtx.font = font;
      const textWidth = Math.ceil(measureCtx.measureText(entity.message).width);
      measured.push({
        entity,
        font,
        x: 0,
        y: 0,
        w: textWidth + ATLAS_PAD * 2,
        h: px + ATLAS_PAD * 2,
        px,
      });
    }
    // 2) shelf 打包（逐行填，行高取该行最高条目）。
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    for (const item of measured) {
      if (cursorX > 0 && cursorX + item.w > ATLAS_WIDTH) {
        cursorX = 0;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      item.x = cursorX;
      item.y = cursorY;
      cursorX += item.w;
      rowHeight = Math.max(rowHeight, item.h);
    }
    const usedHeight = Math.max(64, cursorY + rowHeight);
    let atlasHeight = 64;
    while (atlasHeight < usedHeight && atlasHeight < 4096) atlasHeight *= 2;
    // 3) 画图集（白字 + 深色描边，顶点色负责最终颜色）。
    canvas.width = ATLAS_WIDTH;
    canvas.height = atlasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.texture = null;
      this.batch = null;
      this.quads = [];
      return;
    }
    ctx.clearRect(0, 0, ATLAS_WIDTH, atlasHeight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const item of measured) {
      ctx.font = item.font;
      const centerX = item.x + item.w / 2;
      const centerY = item.y + item.h / 2;
      ctx.lineWidth = Math.max(2, Math.round(item.px * 0.06));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.strokeText(item.entity.message, centerX, centerY);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(item.entity.message, centerX, centerY);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.texture = texture;
    this.batch = new BillboardQuadBatch(texture, measured.length, WORLDTEXT_RENDER_ORDER, 'normal');
    this.root.add(this.batch.mesh);
    // 4) 世界尺寸 + UV：字形世界高度 = textsize（cell 含留白，按比例折回世界尺寸）。
    //    CanvasTexture 默认 flipY=true：纹理 v=1 对应画布顶部，所以 v 轴要翻转。
    const invWidth = 1 / ATLAS_WIDTH;
    const invHeight = 1 / atlasHeight;
    this.quads = measured.map((item) => {
      const worldHeight = item.entity.textSize * (item.h / item.px);
      const worldWidth = worldHeight * (item.w / item.h);
      return {
        x: item.entity.origin[0],
        y: item.entity.origin[1],
        z: item.entity.origin[2],
        halfWidth: worldWidth * 0.5,
        halfHeight: worldHeight * 0.5,
        color: item.entity.color,
        uv: {
          u0: (item.x + 1) * invWidth,
          u1: (item.x + item.w - 1) * invWidth,
          v0: 1 - (item.y + item.h - 1) * invHeight,
          v1: 1 - (item.y + 1) * invHeight,
        },
      };
    });
  }

  get draws(): number {
    return this.batch ? 1 : 0;
  }

  update(camera: THREE.Camera): void {
    if (!this.batch) return;
    billboardBasisOf(camera, this.basis);
    this.batch.begin();
    for (let i = 0; i < this.quads.length; i++) {
      const quad = this.quads[i];
      this.batch.billboardAt(
        i,
        quad.x,
        quad.y,
        quad.z,
        quad.halfWidth,
        quad.halfHeight,
        this.basis,
        quad.color.r,
        quad.color.g,
        quad.color.b,
        1,
        quad.uv,
      );
    }
    this.batch.end();
  }

  dispose(): void {
    this.batch?.dispose();
    this.texture?.dispose();
    this.root.clear();
  }
}
