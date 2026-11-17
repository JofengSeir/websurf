/**
 * 实体运行期 → 物理 / 权威 Worker 的副作用宿主（三端共享装配，2026-11-18）。
 *
 * 为什么有这一层：`attachEntitySystem` 只负责「跑 Source 实体 I/O 并 emit 事件」；事件落到
 * 物理线（`trigger_push` 推力、`AddOutput basevelocity`、`servercommand sv_maxvelocity`、
 * `autohop_zone` 跳跃增幅区、玩家名门控）与权威 Worker 的转发，过去只在 debug 的
 * `renderer-main.ts` 里手写了一份，game 端只把事件转发给一个从未赋值的 `onEntityEvent`
 * ——于是「debug 里加速板/跳高有效果，game 里没有」（三端不同步的直接原因）。
 *
 * 本模块把这段宿主适配收成一份：
 *   ① 装配并推进 `EntitySystem`（`attachEntitySystem` + 每帧 `frame(dt)`）；
 *   ② 把实体事件落到物理线（`getPhys()` 返回的 `PhysWorld` 子集）；
 *   ③ 通过回调把同一份副作用转发给权威 Worker（`onPlayerVelocity` / `onSpeedCapChange` /
 *      `onJumpHeightChange` / `onPlayerNameChange`）——渲染线与权威必须同参，否则位置分叉；
 *   ④ 维护「跳跃增幅区」（`autohop_zone` 体积 → 区内跳高 80 HU）与「玩家 targetname →
 *      传送 filter」的状态镜像，只在变化时下发。
 *
 * 约束：本文件不 import three / renderer-shared；只有实体层与物理接口。
 */
import { attachEntitySystem } from '../entity/attach.js';
import { DEFAULT_HULL_MAXS, DEFAULT_HULL_MINS, playerStateFromRaw, type RawPlayerState } from '../entity/host.js';
import type { EntitySystem, EntitySystemStats } from '../entity/entity-system.js';
import type { EntityEvent } from '../entity/types.js';

/**
 * 「跳跃增幅区」（surf_null 的 `autohop_zone`）内的起跳高度（HU）。
 *
 * 区内格栅坑底比水泥台低 64 HU，而默认跳高 57 HU（`gravity=800`、`jumpSpeed=302`）跳不上台；
 * 原服由服务器插件在区内抬高跳跃高度，地图本身只提供 `autohop_zone` 这个名字作为区域接口。
 * 本引擎没有插件层，由宿主按同一语义实现：进入体积 → 80 HU（64 + 16 余量），离开恢复默认。
 */
export const AUTOHOP_ZONE_JUMP_HEIGHT = 80;

/** 宿主需要的最小物理面（`PhysWorld` 的相关子集；各方法都可缺省，缺省即跳过该副作用）。 */
export interface GameplayPhysLike {
  add_velocity?(vx: number, vy: number, vz: number): void;
  set_push_velocity?(vx: number, vy: number, vz: number): void;
  set_max_horizontal_speed?(cap: number): void;
  set_jump_height?(height: number): void;
  set_teleport_player_name?(name: string): void;
  set_teleport_filter_enabled?(enabled: boolean): void;
}

/** 带体积的 trigger（可视化 / 调试用）；与 debug `ColliderDebug` 的 `EntityTriggerBoxView` 同形。 */
export interface EntityTriggerVolumeView {
  classname: string;
  targetname: string;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface EntityGameplayOptions {
  /** 当前玩家物理状态（每帧读；实体 touch / 区域判定都用它）。 */
  getPlayerState: () => RawPlayerState;
  /** 当前物理线；物理未就绪时返回 null（此时只跑实体、不施加副作用）。 */
  getPhys: () => GameplayPhysLike | null;
  /** 起跳高度默认值（HU）；缺省 57（对应 gravity 800 / jumpSpeed 302）。 */
  defaultJumpHeight?: number;
  /** 实体事件的观测出口（debug 面板用；不赋值也无副作用）。 */
  onEntityEvent?: (event: EntityEvent) => void;
  /** 速度副作用；`add` = 一次性冲量，`set` = 覆盖（加速板非 ONCE 语义）。 */
  onPlayerVelocity?: (velocity: [number, number, number], mode: 'add' | 'set') => void;
  /** 地图 `sv_maxvelocity` 速度上限（HU/s，水平）。 */
  onSpeedCapChange?: (cap: number) => void;
  /** 跳跃增幅区内/外的起跳高度变化。 */
  onJumpHeightChange?: (height: number) => void;
  /** 玩家 targetname 变化（传送 filter 门控用；首次为空串也会回调一次）。 */
  onPlayerNameChange?: (name: string) => void;
}

/** 浮点比较阈值：跳高目标值只在跨过 1e-6 时下发。 */
const JUMP_HEIGHT_EPS = 1e-6;

/** 解析实体层 `entity:addVelocity` / `entity:baseVelocity` 的 JSON 载荷（`[x,y,z]`）。 */
function parseVelocityDetail(detail: string | undefined): [number, number, number] | null {
  if (!detail || detail === 'null') return null;
  try {
    const v = JSON.parse(detail) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return null;
    if (!v.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) return null;
    return [v[0], v[1], v[2]];
  } catch {
    return null;
  }
}

/**
 * 实体副作用宿主：`load()` 装配、`update(dt)` 每帧推进、`dispose()` 释放。
 *
 * 典型装配（debug / game 的 `loadScene` 里各一次）：
 * ```ts
 * this.gameplay = new EntityGameplay({
 *   getPlayerState: () => this.predPhys?.state() ?? { posX: 0, posY: 0, posZ: 0 },
 *   getPhys: () => this.predPhys,
 *   defaultJumpHeight: this.defaultJumpHeight,
 *   onPlayerVelocity: (v, m) => ...,
 *   onSpeedCapChange: (cap) => ...,
 *   onJumpHeightChange: (h) => ...,
 *   onPlayerNameChange: (name) => ...,
 * });
 * this.gameplay.load(data.entityIoJson);
 * ```
 */
export class EntityGameplay {
  private entitySystem: EntitySystem | null = null;
  private readonly options: EntityGameplayOptions;
  private readonly defaultJumpHeight: number;
  /** `autohop_zone` 体积（玩家碰撞箱与之求交决定跳高）。 */
  private autohopZones: { min: [number, number, number]; max: [number, number, number] }[] = [];
  /** 带体积的 trigger 列表（debug 碰撞可视化用；game 端可忽略）。 */
  private triggerBoxes: EntityTriggerVolumeView[] = [];
  /** 最近一次下发的水平速度上限 / 跳高（null = 还没下发过）。 */
  private speedCap: number | null = null;
  private jumpHeight: number | null = null;
  /** 已镜像给权威侧的玩家名与 filter 开关（`null` = 还没同步过）。 */
  private playerNamePushed: string | null = null;
  private teleportFilterPushed: boolean | null = null;

  constructor(options: EntityGameplayOptions) {
    this.options = options;
    this.defaultJumpHeight = options.defaultJumpHeight ?? 57;
  }

  /** 当前下发的水平速度上限（诊断/测试用）。 */
  get speedCapApplied(): number | null {
    return this.speedCap;
  }

  /** 当前下发的起跳高度（诊断/测试用）。 */
  get jumpHeightApplied(): number | null {
    return this.jumpHeight;
  }

  /** 实体系统本体（debug 面板/诊断需要；未装配为 null）。 */
  get system(): EntitySystem | null {
    return this.entitySystem;
  }

  /** 换图装载：装配实体系统、收集 trigger 体积与跳跃增幅区；换图时自动释放旧实例。 */
  load(entityIoJson?: string | null): void {
    this.entitySystem?.dispose();
    this.entitySystem = attachEntitySystem({
      entityIoJson: entityIoJson ?? undefined,
      getPlayerState: () => playerStateFromRaw(this.options.getPlayerState()),
      onEvent: (event) => this.onEntityEvent(event),
    });
    this.collectTriggerVolumes();
    // 换图/重装实体后由下一帧重新判定并补发跳高（世界重建会把 Rust 侧 jump_height 回默认）。
    this.jumpHeight = null;
  }

  /** 每帧推进：实体 I/O → 跳跃增幅区 → 玩家名门控。物理未就绪时只跑实体。 */
  update(dt: number): void {
    if (!this.entitySystem) return;
    this.entitySystem.frame(dt);
    const phys = this.options.getPhys();
    const st = this.options.getPlayerState();
    this.updateAutohopZoneJump(st, phys);
    this.syncPlayerName(phys);
  }

  /** 实体运行期统计（实体浏览器 / 诊断面板）。 */
  entityStats(): EntitySystemStats | null {
    return this.entitySystem?.stats() ?? null;
  }

  /** 玩家实体当前 targetname（坐标/名称镜像，仅供诊断）。 */
  playerName(): string {
    return this.entitySystem?.getPlayer()?.targetname ?? '';
  }

  /** 带体积的 trigger 列表（含加速板/其它；不含传送，传送由各端自己的可视化绘制）。 */
  entityTriggerBoxes(): EntityTriggerVolumeView[] {
    return this.triggerBoxes;
  }

  /** 卸载：释放实体系统并清空缓存。 */
  dispose(): void {
    this.entitySystem?.dispose();
    this.entitySystem = null;
    this.autohopZones = [];
    this.triggerBoxes = [];
    this.jumpHeight = null;
    this.speedCap = null;
    this.playerNamePushed = null;
    this.teleportFilterPushed = null;
  }

  // ── 事件 → 物理/权威 ────────────────────────────────────────────

  private onEntityEvent(event: EntityEvent): void {
    // trigger_push 一类速度副作用：观测宿主只 emit，在这里落到物理线。
    // `entity:addVelocity` = SF_TRIG_PUSH_ONCE（一次性冲量，累加）；
    // `entity:baseVelocity` = 非 ONCE 弹力区——Source 语义是「围绕本帧位移叠加的基准速度」，
    // 而本引擎按用户要求实现为「玩家在区内时把速度设成 pushdir*speed」（覆盖，不累加）；
    // 早期按 add 处理时 320fps 下每帧 +3000，站上板子 1 秒就涨到 40 万 HU/s。
    if (event.kind === 'entity:addVelocity') {
      const v = parseVelocityDetail(event.detail);
      if (v) this.applyPlayerVelocity(v, 'add');
    } else if (event.kind === 'entity:baseVelocity') {
      const v = parseVelocityDetail(event.detail);
      if (v) this.applyPlayerVelocity(v, 'set');
    } else if (event.kind === 'servercommand') {
      // 地图脚本的 `servercommand`（logic_auto OnMapSpawn 等）：目前只认速度上限
      // `sv_maxvelocity`——surf 图靠它把满速抬到 3500/10000；没这条命令时 Rust 侧
      // 用默认 3500 兜底（见 `PhysWorld::max_horizontal_speed`）。
      this.applyServerCommand(event.detail ?? '');
    }
    this.options.onEntityEvent?.(event);
  }

  /**
   * 把实体层上报的速度副作用同时施加到物理线并转发给权威 Worker。
   *
   * @param mode 'add' = 叠加冲量（`SF_TRIG_PUSH_ONCE`）；'set' = 覆盖速度
   *   （`trigger_push` 非 ONCE 的加速板：区内每帧设成固定方向/大小，离开后保持）。
   */
  private applyPlayerVelocity(velocity: [number, number, number], mode: 'add' | 'set'): void {
    const phys = this.options.getPhys();
    if (mode === 'set') {
      phys?.set_push_velocity?.(velocity[0], velocity[1], velocity[2]);
    } else {
      phys?.add_velocity?.(velocity[0], velocity[1], velocity[2]);
    }
    this.options.onPlayerVelocity?.(velocity, mode);
  }

  /**
   * 处理地图脚本下发的 `servercommand`：目前只认 `sv_maxvelocity <n>`。
   *
   * Source 里它是「速度上限」，默认 3500，`CheckVelocity` 每步多次钳位；surf_666 的
   * `logic_auto OnMapSpawn` 会把本图改成 10000——按 Source 语义应以地图为准（用户若想
   * 强制 3500 需要显式覆盖地图 cvar）。
   */
  private applyServerCommand(command: string): void {
    const m = /^\s*sv_maxvelocity\s+(-?\d+(?:\.\d+)?)\s*$/i.exec(command);
    if (!m) return;
    const cap = Number(m[1]);
    if (!Number.isFinite(cap)) return;
    this.speedCap = cap;
    this.options.getPhys()?.set_max_horizontal_speed?.(cap);
    this.options.onSpeedCapChange?.(cap);
  }

  /**
   * 「跳跃增幅区」判定：玩家碰撞箱是否与任一 `autohop_zone` 体积相交，按结果切换起跳高度。
   *
   * 只在目标值变化时下发（进入 = 80 HU、离开 = 默认值），避免每帧发消息；首次运行
   * 或换图后 `jumpHeight === null` 会补发一次默认值，保证权威侧与世界重建后的状态
   * 与渲染线一致（世界重建会把 Rust 侧 `jump_height` 重放回默认值）。
   */
  private updateAutohopZoneJump(st: RawPlayerState, phys: GameplayPhysLike | null): void {
    if (!phys) return;
    // 用玩家碰撞箱（与实体 touch 同一口径）与区域 AABB 求交，而不是只测脚底点：
    // 格栅坑的地板比区域底沿还低 32 HU，站坑底时脚底在区域外但身体在区内——
    // 实体层 `serviceTouch` 也是用 `state.origin + hullMins/Maxs` 建盒，口径必须一致。
    const px0 = st.posX + DEFAULT_HULL_MINS[0];
    const px1 = st.posX + DEFAULT_HULL_MAXS[0];
    const py0 = st.posY + DEFAULT_HULL_MINS[1];
    const py1 = st.posY + DEFAULT_HULL_MAXS[1];
    const pz0 = st.posZ + DEFAULT_HULL_MINS[2];
    const pz1 = st.posZ + DEFAULT_HULL_MAXS[2];
    let inside = false;
    for (const z of this.autohopZones) {
      if (
        px1 >= z.min[0] && px0 <= z.max[0] &&
        py1 >= z.min[1] && py0 <= z.max[1] &&
        pz1 >= z.min[2] && pz0 <= z.max[2]
      ) {
        inside = true;
        break;
      }
    }
    const target = inside ? Math.max(this.defaultJumpHeight, AUTOHOP_ZONE_JUMP_HEIGHT) : this.defaultJumpHeight;
    if (this.jumpHeight !== null && Math.abs(this.jumpHeight - target) < JUMP_HEIGHT_EPS) return;
    this.jumpHeight = target;
    phys.set_jump_height?.(target);
    this.options.onJumpHeightChange?.(target);
  }

  /**
   * 把玩家实体当前 targetname 同步给权威侧（变化才回调）。
   *
   * 来源是实体系统内部的玩家实体（`EntitySystem.getPlayer()`）——地图脚本用
   * `AddOutput targetname krazy1/2/3` 在触碰时改名，传送器按 filter 里的名字模式决定是否响应。
   * 名字不由物理状态携带（`PlayerState` 无 name 字段），故此路是唯一回传通道。
   */
  private syncPlayerName(phys: GameplayPhysLike | null): void {
    const name = this.entitySystem?.getPlayer()?.targetname ?? '';
    // 主线程物理与权威 Worker 必须同参：两侧各自跑 teleport.check，名门控分叉会让
    // 「权威回卷了、画面没回卷」或反之（渲染侧没有反向同步传送的通道）。
    const filterEnabled =
      (globalThis as unknown as { __vbspTeleportFilterOff?: boolean }).__vbspTeleportFilterOff !== true;
    if (name === this.playerNamePushed && filterEnabled === this.teleportFilterPushed) return;
    this.playerNamePushed = name;
    this.teleportFilterPushed = filterEnabled;
    phys?.set_teleport_player_name?.(name);
    phys?.set_teleport_filter_enabled?.(filterEnabled);
    this.options.onPlayerNameChange?.(name);
  }

  /**
   * 收集实体运行时里带体积的 `trigger_*`（排除 `trigger_teleport*`：传送触发器由各端自己的
   * 凸包可视化绘制），并把 `autohop_zone` 的体积收进跳跃增幅区表。
   */
  private collectTriggerVolumes(): void {
    const boxes: EntityTriggerVolumeView[] = [];
    const zones: { min: [number, number, number]; max: [number, number, number] }[] = [];
    const entities = this.entitySystem?.entList.entities ?? [];
    for (const entity of entities) {
      if (!entity.classname.startsWith('trigger')) continue;
      if (entity.classname.startsWith('trigger_teleport')) continue;
      for (const volume of entity.volumes) {
        boxes.push({
          classname: entity.classname,
          targetname: entity.targetname,
          min: { x: volume.mins[0], y: volume.mins[1], z: volume.mins[2] },
          max: { x: volume.maxs[0], y: volume.maxs[1], z: volume.maxs[2] },
        });
        // 「跳跃增幅区」：surf_null 用 `autohop_zone` 这套 targetname 给服务器插件做区域
        // 接口（地图本身没有输出/脚本）。原服插件在区内提高跳高，本引擎没有插件层，
        // 所以在这里把体积收下来，由 `updateAutohopZoneJump()` 按玩家位置切换跳高。
        if (entity.targetname === 'autohop_zone') {
          zones.push({
            min: [volume.mins[0], volume.mins[1], volume.mins[2]],
            max: [volume.maxs[0], volume.maxs[1], volume.maxs[2]],
          });
        }
      }
    }
    this.triggerBoxes = boxes;
    this.autohopZones = zones;
  }
}
