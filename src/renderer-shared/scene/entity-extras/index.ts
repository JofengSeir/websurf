/**
 * 地图资产实体图元（`entity-extras`）：实体 lump 里有数据、但共享渲染层此前**没有消费者**
 * 的四类「有数据、零消费者」资产——
 *
 * | classname | 图元 | 实现 | draw |
 * |---|---|---|---|
 * | `env_sprite` / `env_sprite_clientside` | 加法 billboard 光晕 | `sprites.ts` | 1（全图合批） |
 * | `point_worldtext` | canvas 图集 + billboard 文字 | `worldtext.ts` | 1（图集 + 合批） |
 * | `move_rope` / `keyframe_rope` | `NextKey` 链 + `Slack` 下垂的线 | `ropes.ts` | 1（合批 LineSegments） |
 * | `env_beam` | 面向相机的加法光束带 | `beams.ts` | 1（合批 ribbon） |
 *
 * 取证背景见 `.tmp/enhance-plugin/gaps/vscript-assets-wall-report.md` §3-§5；全部数据来自
 * `entityIoJson`（无损 entity lump），不需要改 Rust/wasm，也不需要 PAK/mtz 资产
 * （贴图全程序化，见 `textures.ts`）。
 *
 * 接入约定（`render-session.ts` 的 `setupSceneExtras` / `disposeSceneExtras`）：
 * - 四类实体总数为 0 时 `fromBlocks()` 返回 `null`：不建 three 对象、不建贴图、零新增 draw；
 * - 每类装配独立 try/catch：一类失败只 warn，不影响其它类与主场景；
 * - `dispose()` 逐类释放 geometry/material/texture；
 * - A/B 逃生：`globalThis.__vbspEntityExtrasOff = true` 时由调用方跳过装配。
 */

import * as THREE from 'three';

import type { EntityBlockRecords } from '../particles.js';
import { Beams, collectBeamEntities } from './beams.js';
import { collectRopeChains, Ropes, type RopeCollectResult } from './ropes.js';
import { collectSpriteEntities, SpriteGlows } from './sprites.js';
import { collectWorldTextEntities, WorldTexts } from './worldtext.js';

/** 验收/面板用的装配统计（`globalThis.__vbspEntityExtrasStats`）。 */
export interface EntityExtrasStats {
  /** `env_sprite` + `env_sprite_clientside` 实体数。 */
  sprite: number;
  /** `point_worldtext` 实体数（含没有 `message` 的条目）。 */
  worldtext: number;
  /** 参与 `NextKey` 链的 `move_rope` + `keyframe_rope` 实体数。 */
  rope: number;
  /** `env_beam` 实体数。 */
  beam: number;
  /** 新增的 draw call 数（四类各最多 1，合计 0-4）。 */
  draws: number;
  /** 绳索链数。 */
  ropeChains: number;
  /** 实际画出的绳段数。 */
  ropeSegments: number;
}

/** 零统计（没有资产实体 / A/B 关闭时写入 `globalThis`）。每次返回新对象，避免被外部改写共享实例。 */
export function emptyEntityExtrasStats(): EntityExtrasStats {
  return { sprite: 0, worldtext: 0, rope: 0, beam: 0, draws: 0, ropeChains: 0, ropeSegments: 0 };
}

/** 四类子图元的装配产物（null = 该类没有实体或装配失败）。 */
interface EntityExtrasParts {
  sprites: SpriteGlows | null;
  worldTexts: WorldTexts | null;
  ropes: Ropes | null;
  beams: Beams | null;
}

/** 采集到的实体计数（构造 `EntityExtras` 前已经确定，用于统计口）。 */
interface EntityExtrasCounts {
  sprite: number;
  worldtext: number;
  rope: number;
  beam: number;
  ropeChains: number;
  ropeSegments: number;
}

/** 供场景扩展图元（sprite / beam）做 PVS 房间剔除的最小查询接口。 */
export interface EntityExtrasPvs {
  isVisible(clusterId: number): boolean;
  getClusterAt(pos: { x: number; y: number; z: number }): number;
}

export class EntityExtras {
  /** 挂到 `scene` 的根节点（三端共用；不挂 `this.root`，故不参与 chunk 剔除）。 */
  readonly root: THREE.Group;
  readonly stats: EntityExtrasStats;
  private readonly sprites: SpriteGlows | null;
  private readonly worldTexts: WorldTexts | null;
  private readonly ropes: Ropes | null;
  private readonly beams: Beams | null;

  private constructor(parts: EntityExtrasParts, counts: EntityExtrasCounts) {
    this.root = new THREE.Group();
    this.root.name = 'entity-extras';
    this.sprites = parts.sprites;
    this.worldTexts = parts.worldTexts;
    this.ropes = parts.ropes;
    this.beams = parts.beams;
    if (parts.sprites) this.root.add(parts.sprites.root);
    if (parts.worldTexts) this.root.add(parts.worldTexts.root);
    if (parts.ropes) this.root.add(parts.ropes.root);
    if (parts.beams) this.root.add(parts.beams.root);
    this.stats = {
      sprite: counts.sprite,
      worldtext: counts.worldtext,
      rope: counts.rope,
      beam: counts.beam,
      draws:
        (parts.sprites ? parts.sprites.draws : 0) +
        (parts.worldTexts ? parts.worldTexts.draws : 0) +
        (parts.ropes ? parts.ropes.draws : 0) +
        (parts.beams ? parts.beams.draws : 0),
      ropeChains: counts.ropeChains,
      ropeSegments: counts.ropeSegments,
    };
  }

  /**
   * 从实体键值块装配。四类实体都没有时返回 `null`（零新增对象/贴图）。
   * `onWarn(label, err)` 供调用方把「单类装配失败」打到自己的日志前缀下。
   */
  static fromBlocks(
    blocks: EntityBlockRecords,
    onWarn?: (label: string, err: unknown) => void,
  ): EntityExtras | null {
    if (blocks.length === 0) return null;
    const attempt = <T>(label: string, build: () => T): T | null => {
      try {
        return build();
      } catch (err) {
        onWarn?.(label, err);
        return null;
      }
    };

    const spriteEntities = attempt('env_sprite', () => collectSpriteEntities(blocks)) ?? [];
    const worldTextEntities = attempt('point_worldtext', () => collectWorldTextEntities(blocks)) ?? [];
    const ropeResult: RopeCollectResult =
      attempt('move_rope/keyframe_rope', () => collectRopeChains(blocks)) ?? {
        chains: [],
        entityCount: 0,
        segmentCount: 0,
      };
    const beamEntities = attempt('env_beam', () => collectBeamEntities(blocks)) ?? [];
    const total =
      spriteEntities.length +
      worldTextEntities.length +
      ropeResult.entityCount +
      beamEntities.length;
    // 零实体：不建任何 three 对象/贴图（无这些实体的旧地图零新增对象、零新增 draw）。
    if (total === 0) return null;

    const sprites =
      spriteEntities.length > 0
        ? attempt('env_sprite build', () => new SpriteGlows(spriteEntities))
        : null;
    const worldTexts =
      worldTextEntities.length > 0
        ? attempt('point_worldtext build', () => new WorldTexts(worldTextEntities))
        : null;
    const ropes =
      ropeResult.chains.length > 0
        ? attempt('move_rope build', () => new Ropes(ropeResult.chains))
        : null;
    const beams =
      beamEntities.length > 0 ? attempt('env_beam build', () => new Beams(beamEntities)) : null;

    return new EntityExtras(
      { sprites, worldTexts, ropes, beams },
      {
        sprite: spriteEntities.length,
        worldtext: worldTextEntities.length,
        rope: ropeResult.entityCount,
        beam: beamEntities.length,
        ropeChains: ropeResult.chains.length,
        ropeSegments: ropes ? ropes.segmentCount : ropeResult.segmentCount,
      },
    );
  }

  /**
   * 运行期 `ShowSprite` / `HideSprite` / `ToggleSprite`（`Sprite.cpp:77-79,590-602`）。
   * 只有 `env_sprite` 有显隐 I/O；`point_worldtext` 的 SDK datadesc 里没有
   * StartDisabled / Show / Hide，恒可见（见 `entity-state.ts` 的类注释），这里返回 false 表示未覆盖。
   */
  setSpriteVisible(entityIndex: number, visible: boolean): boolean {
    return this.sprites ? this.sprites.setEntityVisible(entityIndex, visible) : false;
  }

  /** 单个 sprite 的可见性；null = 该下标不是 env_sprite 图元。 */
  spriteVisible(entityIndex: number): boolean | null {
    return this.sprites ? this.sprites.isEntityVisible(entityIndex) : null;
  }

  /** 当前点亮的 sprite 数（初态按 `CSprite::Spawn`，之后随 I/O 变）。 */
  get spriteVisibleCount(): number {
    return this.sprites ? this.sprites.visibleCount : 0;
  }

  /** 每帧推进：sprite / 文字 / 光束都是屏幕朝向的，按相机矩阵重写四边形顶点，并按 PVS 隐藏不可见房间图元。 */
  update(camera: THREE.Camera, pvs: EntityExtrasPvs | null = null): void {
    this.sprites?.update(camera, pvs);
    this.worldTexts?.update(camera);
    this.beams?.update(camera, pvs);
  }

  /** 释放几何/材质/贴图；幂等。 */
  dispose(): void {
    this.sprites?.dispose();
    this.worldTexts?.dispose();
    this.ropes?.dispose();
    this.beams?.dispose();
    this.root.clear();
  }
}
