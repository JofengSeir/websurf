/**
 * 顶层运行期：把 SDK 的「地图加载 → Spawn → Activate → 服务器帧」串成一条链。
 *
 * 帧顺序对照 `game/server/gameinterface.cpp:1225-1259`（GameFrame）：
 * ```
 * CleanupDeleteList → GameStartFrame → Physics_RunThinkFunctions
 *   → ServiceEventQueue → CleanupDeleteList → ...
 * ```
 * 本层对应：cleanup → think → touch（物理帧）→ ServiceEvents → cleanup。
 * touch 放在 think 之后、ServiceEvents 之前，保证 StartTouch/Touch 里 fire 的输出
 * 能在**同一帧**被 ServiceEvents 消费（delay=0 的输出必须当帧生效）。
 *
 * 与 SDK 的全局量语义一致：`g_Runtime` 是模块级单例，同一时刻只应有一个活跃系统；
 * 每个公开入口都先 `bindGlobals()`，避免多实例互相踩。
 */
import { Entity, type EntityRuntime } from './base-entity.js';
import { EventQueue, DEFAULT_MAX_EVENTS_PER_SERVICE } from './event-queue.js';
import { EntityList } from './entity-list.js';
import { g_Runtime, resetRuntime } from './runtime.js';
import { firstProp, parseEntityBlocks } from './map-data.js';
import { Variant } from './variant.js';
import type {
  EntityBrushVolume,
  EntityEvent,
  EntityHost,
  EntityIoPayload,
  EntityVolume,
  PlayerState,
  Vec3,
} from './types.js';
import { installEntityClasses, invokeEndTouch, invokeStartTouch, invokeTouch, resolveClassChain } from './classes/index.js';
import { globalStates, mapLoad, type MapLoadType } from './classes/logic.js';

const TOUCH_EPS = 1e-4;

export interface EntitySystemOptions {
  host: EntityHost;
  /** 未建模实体的 `On*` 键是否动态注册输出（默认 true，宿主扩展）。 */
  allowDynamicOutputs?: boolean;
  /** 每次 ServiceEvents 的事件上限（默认 100000；0 = 不限）。 */
  maxEventsPerService?: number;
  /** `logic_auto` 的地图加载类型（默认 newgame + multiplayer）。 */
  loadType?: MapLoadType;
  multiplayer?: boolean;
  roundRestart?: boolean;
  onEvent?: (event: EntityEvent) => void;
  log?: (message: string) => void;
}

export interface EntitySystemStats {
  entityCount: number;
  classCounts: Record<string, number>;
  outputConnections: number;
  volumeEntities: number;
  pendingEvents: number;
  dynamicOutputs: number;
  time: number;
}

/** AABB 相交（带容差）。 */
function aabbOverlap(
  aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3,
): boolean {
  return (
    aMin[0] <= bMax[0] + TOUCH_EPS && aMax[0] >= bMin[0] - TOUCH_EPS &&
    aMin[1] <= bMax[1] + TOUCH_EPS && aMax[1] >= bMin[1] - TOUCH_EPS &&
    aMin[2] <= bMax[2] + TOUCH_EPS && aMax[2] >= bMin[2] - TOUCH_EPS
  );
}

/**
 * AABB 与 brush 凸包的分离轴测试（只测凸包各面法线这一组轴）。
 *
 * 凸包内部满足 `dot(n,p) - d <= 0`。对每个面取 AABB 在法线方向的**最小投影点**
 * （`n>=0` 取 mins，否则取 maxs）：若连最近点都有 `dot(n,p) - d > 0`，说明 AABB
 * 整体落在该面外侧 ⇒ 两者分离。反之只说明「可能相交」（角上会有保守的假阳性，
 * 对 trigger 来说宁可多触发一次也不能漏掉 StartTouch）。
 *
 * 注意不能用最大投影点：那判的是「AABB 被凸包完全包含」，玩家碰撞盒通常比
 * 触发器大，会永远判为不接触。`planes` 为空时退化为纯 AABB（Rust 的 model 回退）。
 */
export function brushIntersectsAabb(brush: EntityBrushVolume, mins: Vec3, maxs: Vec3): boolean {
  if (!aabbOverlap(mins, maxs, brush.mins, brush.maxs)) return false;
  for (const plane of brush.planes) {
    const nx = plane[0], ny = plane[1], nz = plane[2], d = plane[3] ?? 0;
    const px = nx >= 0 ? mins[0] : maxs[0];
    const py = ny >= 0 ? mins[1] : maxs[1];
    const pz = nz >= 0 ? mins[2] : maxs[2];
    if (nx * px + ny * py + nz * pz - d > TOUCH_EPS) return false;
  }
  return true;
}

/** 实体是否声明了 touch 生命周期（决定它是否进入每帧几何扫描）。 */
function hasTouchBehaviour(entity: Entity): boolean {
  return entity.classChain.some((c) => !!(c.touch || c.startTouch || c.endTouch));
}

/**
 * 地图实体运行期。零 `three` / 零 DOM 依赖，可直接在 Node 里跑地图 I/O 夹具。
 */
/**
 * 诊断事件环形缓冲上限。
 * `emit()` 每个输入/副作用都会 push 一条，而 `events` 只在 `unload()` 清空；长会话下
 * 会无限增长（观测模式下这些事件大多被丢弃），造成堆占用与 GC 抖动。保留最近 1024 条
 * 足够做诊断，且不影响 `onEvent` 回调（回调每次仍会收到完整事件）。
 */
const MAX_DIAG_EVENTS = 1024;

export class EntitySystem implements EntityRuntime {
  readonly host: EntityHost;
  readonly allowDynamicOutputs: boolean;
  readonly eventQueue = new EventQueue();
  readonly entList = new EntityList();
  readonly events: EntityEvent[] = [];

  private readonly options: EntitySystemOptions;
  private readonly deletion = new Set<Entity>();
  private playerEntity: Entity;
  private touchCandidates: Entity[] = [];
  private touchStamp = 0;
  private dynamicOutputCount = 0;

  constructor(options: EntitySystemOptions) {
    installEntityClasses();
    this.options = options;
    this.host = options.host;
    this.allowDynamicOutputs = options.allowDynamicOutputs ?? true;
    this.bindGlobals();
    // SDK 里玩家是全局实体表的一员，但没有地图实体块；用 -1 作为伪序号。
    this.playerEntity = new Entity(-1, 'player', [], resolveClassChain('player'), this);
    this.entList.add(this.playerEntity);
    g_Runtime.player = this.playerEntity;
  }

  // ── EntityRuntime 实现 ──
  now(): number {
    return g_Runtime.time;
  }
  getPlayer(): Entity | null {
    return this.playerEntity;
  }
  removeEntity(entity: Entity): void {
    this.deletion.add(entity);
  }
  log(message: string): void {
    if (/^dynamic output /.test(message)) this.dynamicOutputCount++;
    this.options.log?.(message);
  }
  emit(event: {
    kind: string;
    detail?: string;
    activatorName?: string;
    entityIndex?: number;
    classname?: string;
    targetname?: string;
  }): void {
    const full: EntityEvent = {
      kind: event.kind,
      entityIndex: event.entityIndex ?? -1,
      classname: event.classname ?? '',
      targetname: event.targetname ?? '',
      activatorName: event.activatorName,
      detail: event.detail,
      time: g_Runtime.time,
    };
    this.events.push(full);
    if (this.events.length > MAX_DIAG_EVENTS) {
      this.events.splice(0, this.events.length - MAX_DIAG_EVENTS);
    }
    this.options.onEvent?.(full);
  }

  /** 把模块级全局量重新指向本系统。 */
  bindGlobals(): void {
    g_Runtime.eventQueue = this.eventQueue;
    g_Runtime.entList = this.entList;
    g_Runtime.player = this.playerEntity ?? null;
    g_Runtime.resolveEntityByName = (name) => this.entList.findFirstByName(name);
  }

  // ── 地图加载 ──
  /**
   * 解析无损实体原文 + brush 体积，按 SDK 顺序 Spawn → Activate。
   * `volumes[].index` 与 `parseEntityBlocks()` 的块序号一一对应。
   */
  load(payload: EntityIoPayload | string): void {
    this.bindGlobals();
    const data: EntityIoPayload = typeof payload === 'string'
      ? JSON.parse(payload) as EntityIoPayload
      : payload;

    this.unload();
    globalStates.clear();
    mapLoad.type = this.options.loadType ?? 'newgame';
    mapLoad.multiplayer = this.options.multiplayer ?? true;
    mapLoad.roundRestart = this.options.roundRestart ?? false;

    const volumes = new Map<number, EntityVolume>();
    for (const v of data.volumes ?? []) volumes.set(v.index, v);

    const blocks = parseEntityBlocks(data.entities_text ?? '');
    for (let index = 0; index < blocks.length; index++) {
      const pairs = blocks[index];
      if (pairs.length === 0) continue;
      const classname = firstProp(pairs, 'classname') ?? '';
      const chain = resolveClassChain(classname, (m) => this.log(m));
      const entity = new Entity(index, classname, pairs, chain, this);
      const volume = volumes.get(index);
      if (volume) {
        entity.volumes = volume.brushes;
        // 没有 origin 键的 brush 实体用 Rust 算出的 model origin（已是 Y-up）。
        if (firstProp(pairs, 'origin') === undefined) entity.origin = [...volume.origin] as Vec3;
      }
      entity.parseMapData(pairs);
      this.entList.add(entity);
    }

    // SDK：全部实体 Spawn 完，再全部 Activate（filter_multi 要在 Activate 里找齐子 filter）。
    const all = [...this.entList.entities];
    for (const entity of all) entity.spawn();
    for (const entity of all) entity.activate();

    this.touchCandidates = all.filter((e) => e.volumes.length > 0 && hasTouchBehaviour(e));
    this.touchStamp = 0;
  }

  /** 卸载地图：保留玩家伪实体，其余状态全部复位。 */
  unload(): void {
    this.bindGlobals();
    for (const entity of this.entList.entities) entity.touchLinks.clear();
    this.entList.clear();
    this.entList.add(this.playerEntity);
    this.playerEntity.touchLinks.clear();
    this.deletion.clear();
    this.eventQueue.clear();
    this.touchCandidates = [];
    this.touchStamp = 0;
    this.events.length = 0;
    this.dynamicOutputCount = 0;
    globalStates.clear();
    g_Runtime.time = 0;
  }

  /** 释放全局量（测试 / 热重载）。 */
  dispose(): void {
    this.unload();
    resetRuntime();
  }

  // ── 服务器帧 ──
  /**
   * 推进一帧。`dt` 单位秒；所有延迟、think、timer 都以 `g_Runtime.time` 为基准。
   * 返回本帧 ServiceEvents 处理的事件数，便于宿主观测 I/O 活跃度。
   */
  frame(dt: number): number {
    this.bindGlobals();
    g_Runtime.time += Math.max(0, dt);
    const now = g_Runtime.time;

    this.cleanupDeleteList();
    // Physics_RunThinkFunctions：快照遍历，think 里可以安全地删自己 / 生成新实体输入。
    for (const entity of [...this.entList.entities]) entity.serviceThink(now);
    this.serviceTouch();
    const processed = this.eventQueue.serviceEvents(now, this.options.maxEventsPerService ?? DEFAULT_MAX_EVENTS_PER_SERVICE);
    this.cleanupDeleteList();
    return processed;
  }

  /** 不推进时间，只把当前到期事件跑完（加载后立刻冲一次 logic_auto 之外的链）。 */
  serviceEventsNow(): number {
    this.bindGlobals();
    return this.eventQueue.serviceEvents(g_Runtime.time, this.options.maxEventsPerService ?? DEFAULT_MAX_EVENTS_PER_SERVICE);
  }

  private cleanupDeleteList(): void {
    if (this.deletion.size === 0) return;
    for (const entity of this.deletion) {
      // 删除前补发 EndTouch（SDK 在 UTIL_Remove 的 touchlink 清理里做）。
      for (const other of [...entity.touchLinks.keys()]) {
        invokeEndTouch(entity, other);
        entity.touchLinks.delete(other);
      }
      for (const alive of this.entList.entities) alive.touchLinks.delete(entity);
      this.entList.remove(entity);
      this.touchCandidates = this.touchCandidates.filter((e) => e !== entity);
    }
    this.deletion.clear();
  }

  /**
   * `PhysicsTouchTriggers` 的宿主等价物：用 touchStamp 帧心跳维护 touchlink。
   * 新接触 ⇒ StartTouch + Touch；持续接触 ⇒ Touch；失去接触 ⇒ EndTouch。
   */
  private serviceTouch(): void {
    const state = this.host.getPlayerState();
    this.playerEntity.origin = [...state.origin] as Vec3;
    const mins: Vec3 = [
      state.origin[0] + state.hullMins[0],
      state.origin[1] + state.hullMins[1],
      state.origin[2] + state.hullMins[2],
    ];
    const maxs: Vec3 = [
      state.origin[0] + state.hullMaxs[0],
      state.origin[1] + state.hullMaxs[1],
      state.origin[2] + state.hullMaxs[2],
    ];
    this.touchStamp++;

    for (const entity of this.touchCandidates) {
      if (entity.markedForDeletion) continue;
      const link = entity.touchLinks.get(this.playerEntity);
      // FSOLID_TRIGGER 被摘掉（StartDisabled / Toggle / Impact 关闭）⇒ 不参与几何扫描，
      // 但已建立的 link 必须补 EndTouch，与 SDK 的 PhysicsTouchTriggers 一致。
      const solid = entity.triggerSolidFlag && !entity.disabled;
      let touching = false;
      if (solid && state.alive) {
        for (const brush of entity.volumes) {
          if (brushIntersectsAabb(brush, mins, maxs)) { touching = true; break; }
        }
      }

      if (touching) {
        if (!link) {
          entity.touchLinks.set(this.playerEntity, { stamp: this.touchStamp, startTouch: true });
          invokeStartTouch(entity, this.playerEntity);
        } else {
          link.stamp = this.touchStamp;
          link.startTouch = false;
        }
        invokeTouch(entity, this.playerEntity);
      } else if (link) {
        entity.touchLinks.delete(this.playerEntity);
        invokeEndTouch(entity, this.playerEntity);
      }
    }
  }

  // ── 宿主注入入口 ──
  /** 按名字把一个输入投递到事件队列（与地图输出走同一条 ServiceEvents 路径）。 */
  queueInput(
    targetName: string,
    inputName: string,
    value: Variant = Variant.void(),
    activator: Entity | null = null,
    caller: Entity | null = null,
    delay = 0,
  ): void {
    this.bindGlobals();
    this.eventQueue.addEventByName(targetName, inputName, value, delay, activator, caller);
  }

  /** 立即对全部同名匹配派发输入（跳过事件队列，供宿主 UI / 调试注入）。 */
  acceptInputOn(
    targetName: string,
    inputName: string,
    value: Variant = Variant.void(),
    activator: Entity | null = null,
    caller: Entity | null = null,
  ): number {
    this.bindGlobals();
    let count = 0;
    let cur: Entity | null = null;
    for (;;) {
      cur = this.entList.findEntityByName(cur, targetName, null, activator, caller);
      if (!cur) break;
      cur.acceptInput(inputName, activator, caller, value.clone(), 0);
      count++;
    }
    return count;
  }

  /** 玩家 `+use`：直接调 `CBaseEntity::Use`，不经 AcceptInput。 */
  useByName(name: string): number {
    this.bindGlobals();
    let count = 0;
    let cur: Entity | null = null;
    for (;;) {
      cur = this.entList.findEntityByName(cur, name, null, null, null);
      if (!cur) break;
      cur.use(this.playerEntity, this.playerEntity, 0);
      count++;
    }
    return count;
  }

  getEntity(index: number): Entity | undefined {
    return this.entList.entities.find((e) => e.index === index);
  }
  get player(): Entity {
    return this.playerEntity;
  }
  get time(): number {
    return g_Runtime.time;
  }

  stats(): EntitySystemStats {
    const classCounts: Record<string, number> = {};
    let outputConnections = 0;
    let volumeEntities = 0;
    for (const entity of this.entList.entities) {
      classCounts[entity.classname] = (classCounts[entity.classname] ?? 0) + 1;
      for (const out of entity.outputs.values()) outputConnections += out.numberOfElements();
      if (entity.volumes.length > 0) volumeEntities++;
    }
    return {
      entityCount: this.entList.count,
      classCounts,
      outputConnections,
      volumeEntities,
      pendingEvents: this.eventQueue.pendingCount,
      dynamicOutputs: this.dynamicOutputCount,
      time: g_Runtime.time,
    };
  }
}

/** 无副作用宿主，供 viewer / 单元测试使用；`player` 可直接改坐标后再 `frame()`。 */
export function createRecordingHost(initial?: Partial<PlayerState>): {
  host: EntityHost;
  player: PlayerState;
  calls: {
    teleports: Array<{ origin: Vec3; angles: Vec3 | null; velocity: Vec3 | null }>;
    commands: string[];
    clientCommands: string[];
    texts: Array<{ message: string; params: Record<string, string | number> }>;
    damage: Array<{ amount: number; damageType: number }>;
    brushEnabled: Array<[number, boolean]>;
    scripts: string[];
  };
} {
  const player: PlayerState = {
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    angles: [0, 0, 0],
    hullMins: [-16, -36, -16],
    hullMaxs: [16, 36, 16],
    onGround: true,
    alive: true,
    ...initial,
  };
  const calls = {
    teleports: [] as Array<{ origin: Vec3; angles: Vec3 | null; velocity: Vec3 | null }>,
    commands: [] as string[],
    clientCommands: [] as string[],
    texts: [] as Array<{ message: string; params: Record<string, string | number> }>,
    damage: [] as Array<{ amount: number; damageType: number }>,
    brushEnabled: [] as Array<[number, boolean]>,
    scripts: [] as string[],
  };
  const host: EntityHost = {
    getPlayerState: () => player,
    teleportPlayer: (origin, angles, velocity) => {
      calls.teleports.push({ origin: [...origin] as Vec3, angles, velocity });
      player.origin = [...origin] as Vec3;
      if (angles) player.angles = [...angles] as Vec3;
      if (velocity) player.velocity = [...velocity] as Vec3;
    },
    addPlayerVelocity: (delta) => {
      player.velocity = [
        player.velocity[0] + delta[0],
        player.velocity[1] + delta[1],
        player.velocity[2] + delta[2],
      ];
    },
    setPlayerBaseVelocity: (value) => {
      if (value) player.velocity = [...value] as Vec3;
    },
    damagePlayer: (amount, damageType) => calls.damage.push({ amount, damageType }),
    showGameText: (message, params) => calls.texts.push({ message, params }),
    runServerCommand: (command) => calls.commands.push(command),
    runClientCommand: (command) => calls.clientCommands.push(command),
    setBrushEnabled: (index, enabled) => calls.brushEnabled.push([index, enabled]),
    evalScript: (code) => calls.scripts.push(code),
  };
  return { host, player, calls };
}
