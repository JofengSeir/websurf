/**
 * `move_rope` / `keyframe_rope` 的绳索（`NextKey` 链 + `Slack` 下垂）。
 *
 * 语义来源（`test/project/source-sdk-2013-master/src/game/server/`）：
 * - `move_rope`（`CRopeKeyframe::MoveRope`）与 `keyframe_rope` 是同一套绳索的两种端点角色：
 *   链由 `NextKey` 指向下一个 `targetname`，绳段在两端之间按 `Slack` 下垂；
 * - `RopeMaterial` 决定绳段外观（本图 `cable/cable` / `cable/rope2` 两族，取近似颜色）；
 * - `Width` / `Subdiv` 是半径/细分参数，本实现忽略（见下）。
 *
 * **实现近似**：
 * - 下垂量取标准悬链线近似 `sag = sqrt(3/8 × slack × span)`，形状用二次抛物线
 *   `4·sag·t·(1-t)` 沿世界 -Y 下移；
 * - 全部绳段合进**一个** `LineSegments`（1 次 draw）。WebGL 的线宽恒为 1 px，`Width=2`
 *   无法表达成 2 HU 粗的实体——这是本实现的已知观感差距（报告里注明）；
 * - 链在 `NextKey` 缺失/悬空（本图 `lvl1_rope3 → "keyframe"`）/自指时截止，不造环。
 */

import * as THREE from 'three';

import { parseVec3, type EntityBlockRecords } from '../particles.js';

/** 一条 1 HU 宽（WebGL 线宽）绳段。 */
export interface RopeSegment {
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** `Slack` 键（Source 单位）；缺失/非法按 0。 */
  slack: number;
  /** `RopeMaterial` 原文。 */
  material: string;
}

/** 一条 `NextKey` 链（相邻点之间各一段）。 */
export interface RopeChain {
  segments: RopeSegment[];
}

export interface RopeCollectResult {
  chains: RopeChain[];
  /** 参与链的 `move_rope`/`keyframe_rope` 实体数（= 验收口径的 rope 计数）。 */
  entityCount: number;
  /** 绳段数（链内相邻点对数）。 */
  segmentCount: number;
}

/** 防病态数据：链最多走这么多跳。 */
const MAX_CHAIN_HOPS = 64;
/** 每段采样点数 = clamp(span / 48, 8, 64)。 */
const SAMPLE_STEP_HU = 48;
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 64;

interface RopeEntity {
  /** 在实体块数组里的下标。 */
  index: number;
  block: Record<string, string>;
  origin: THREE.Vector3;
}

function parseSlack(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 收集 `NextKey` 链；悬空/自指/超跳数都就地截断。 */
export function collectRopeChains(blocks: EntityBlockRecords): RopeCollectResult {
  const entities: RopeEntity[] = [];
  /** `targetname` → `entities` 下标（同名取第一个）。 */
  const byTarget = new Map<string, number>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const cls = block['classname'];
    if (cls !== 'move_rope' && cls !== 'keyframe_rope') continue;
    const src = parseVec3(block['origin'], [0, 0, 0]);
    const localIndex = entities.length;
    entities.push({
      index,
      block,
      // Source Z-up → 引擎 Y-up：world = (src.y, src.z, src.x)。
      origin: new THREE.Vector3(src[1], src[2], src[0]),
    });
    const name = (block['targetname'] ?? '').trim();
    if (name.length > 0 && !byTarget.has(name)) byTarget.set(name, localIndex);
  }

  const chains: RopeChain[] = [];
  const used = new Set<number>();
  let segmentCount = 0;
  for (let start = 0; start < entities.length; start++) {
    if (entities[start].block['classname'] !== 'move_rope') continue;
    const chain: RopeChain = { segments: [] };
    const visited = new Set<number>([start]);
    used.add(start);
    let current = entities[start];
    for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
      const nextName = (current.block['NextKey'] ?? '').trim();
      if (nextName.length === 0) break;
      const nextIndex = byTarget.get(nextName);
      // 悬空 target（本图 "keyframe"）/自指/环：就地截止，不造伪绳段。
      if (nextIndex === undefined || visited.has(nextIndex)) break;
      visited.add(nextIndex);
      used.add(nextIndex);
      const next = entities[nextIndex];
      chain.segments.push({
        start: current.origin.clone(),
        end: next.origin.clone(),
        slack: parseSlack(current.block['Slack']),
        material: (current.block['RopeMaterial'] ?? '').trim(),
      });
      current = next;
    }
    if (chain.segments.length > 0) {
      chains.push(chain);
      segmentCount += chain.segments.length;
    }
  }
  return { chains, entityCount: used.size, segmentCount };
}

/** 绳段颜色（线性空间）：`cable/cable` 深棕、`cable/rope2` 浅棕。 */
function ropeColor(material: string): THREE.Color {
  const key = material.toLowerCase().replace(/\.vmt$/, '');
  if (key.includes('rope2')) return new THREE.Color(0xa8834f);
  if (key.includes('cable')) return new THREE.Color(0x7a5a3c);
  return new THREE.Color(0x8a7a64);
}

/** 一整类绳索：所有链/段合成一个 `LineSegments`，1 次 draw（静态，无需每帧更新）。 */
export class Ropes {
  readonly root = new THREE.Group();
  readonly chains: number;
  /** 实际画出的绳段数（退化段被跳过）。 */
  readonly segmentCount: number;
  private readonly geometry: THREE.BufferGeometry | null;
  private readonly material: THREE.LineBasicMaterial | null;

  constructor(chains: RopeChain[]) {
    this.chains = chains.length;
    this.root.name = 'entity-ropes';
    const positions: number[] = [];
    const colors: number[] = [];
    let segmentCount = 0;
    for (const chain of chains) {
      for (const segment of chain.segments) {
        const span = segment.start.distanceTo(segment.end);
        if (!(span > 1e-3)) continue;
        const samples = Math.min(
          MAX_SAMPLES,
          Math.max(MIN_SAMPLES, Math.round(span / SAMPLE_STEP_HU)),
        );
        // 悬链线近似的下垂量（二次抛物线中点下垂量 = sag）。
        const sag = Math.sqrt(Math.max(0, segment.slack) * span * 0.375);
        const color = ropeColor(segment.material);
        let prevX = 0;
        let prevY = 0;
        let prevZ = 0;
        for (let sample = 0; sample <= samples; sample++) {
          const t = sample / samples;
          const x = segment.start.x + (segment.end.x - segment.start.x) * t;
          const y =
            segment.start.y +
            (segment.end.y - segment.start.y) * t -
            4 * sag * t * (1 - t);
          const z = segment.start.z + (segment.end.z - segment.start.z) * t;
          if (sample > 0) {
            positions.push(prevX, prevY, prevZ, x, y, z);
            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
          }
          prevX = x;
          prevY = y;
          prevZ = z;
        }
        segmentCount++;
      }
    }
    this.segmentCount = segmentCount;
    if (positions.length === 0) {
      this.geometry = null;
      this.material = null;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: false,
      depthWrite: true,
      fog: false,
      toneMapped: false,
    });
    this.geometry = geometry;
    this.material = material;
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.userData.vbspNoCull = true;
    this.root.add(lines);
  }

  get draws(): number {
    return this.geometry ? 1 : 0;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.root.clear();
  }
}
