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
 *
 * 边界（D-129 已决 (c) 混合，2026-11-18）：速度类副作用（推力/基准速度/限速/跳高/玩家名门控）
 * 已收编到本宿主；**传送仍走旧 Rust 链**（`parse_teleports` → `build_world(teleportJson)`），
 * 本文件不接管 `entity:teleport`，避免两条链重复传送。若将来要全收编（D-129(b)），
 * 需先做「同图同回放」A/B 基线再切。
 */
import { attachEntitySystem } from '../entity/attach.js';
import { DEFAULT_HULL_MAXS, DEFAULT_HULL_MINS, playerStateFromRaw, type RawPlayerState } from '../entity/host.js';
import type { EntitySystem, EntitySystemStats } from '../entity/entity-system.js';
import type { EntityEvent } from '../entity/types.js';
import { mapCvarsToPhysicsParams } from '../phys/map-cvars.js';
import { PANEL_TO_RUST } from '../phys/param-names.js';

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
  /** 通用参数写入（地图 `servercommand` 映射出的 `sv_airaccelerate` 等；JSON 是
   * `set_params` 的 snake_case patch）。 */
  set_params?(json: string): void;
  /**
   * 运行期切换实体 brush 的碰撞（`func_wall_toggle` / `func_door` 的 Open/Close）。
   * `entity` 是实体枚举下标（与实体 I/O 事件下标同序，Rust 侧 `WasmBrush.entity`）。
   * 返回切换前的状态。物理实现缺失时静默跳过（game 端旧 wasm 兼容）。
   */
  set_brush_solid?(entity: number, solid: boolean): boolean;
  /** 查询实体 brush 当前是否实心（诊断/重放用；实现缺失时视为实心）。 */
  brush_solid?(entity: number): boolean;
  /**
   * 运行期开关某个实体的传送触发区域（`trigger_teleport` 的 `Enable`/`Disable`）。
   * `entity` 是 BSP 实体编号（Rust 侧 `TeleportTrigger.index`）。
   * 实现缺失时静默跳过（game 端旧 wasm 兼容）。
   */
  set_teleport_enabled?(entity: number, enabled: boolean): boolean;
  /** 查询实体传送区域当前是否启用（诊断/重放用；实现缺失时视为未知）。 */
  teleport_enabled?(entity: number): boolean;
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
  /**
   * 地图聊天文本（`point_servercommand` / `point_clientcommand` 的 `say ...`）。
   *
   * ze/surf 类地图用它在聊天框打倒计时、关卡与「门 20 秒后开」提示；实体层已把它
   * 作为 `servercommand` / `clientcommand` 事件上报，这里只解析文本并交给 HUD 出口。
   */
  onChatMessage?: (text: string) => void;
  /** 速度副作用；`add` = 一次性冲量，`set` = 覆盖（加速板非 ONCE 语义）。 */
  onPlayerVelocity?: (velocity: [number, number, number], mode: 'add' | 'set') => void;
  /** 地图 `sv_maxvelocity` 速度上限（HU/s，水平）。 */
  onSpeedCapChange?: (cap: number) => void;
  /** 用户横向限速（HU/s；`0`/缺省 = 关闭，只跟随地图 `sv_maxvelocity`）。
   *  初值由各端 config 的 `physics.maxHorizontalSpeed` 传入，在 {@link EntityGameplay.load}
   *  里按「地图值 ∩ 用户值」生效（换图物理线重建后自动重放），之后可用
   *  {@link EntityGameplay.setUserSpeedCap} 更新（面板改值）。 */
  initialUserSpeedCap?: number;
  /** 跳跃增幅区内/外的起跳高度变化。 */
  onJumpHeightChange?: (height: number) => void;
  /** 玩家 targetname 变化（传送 filter 门控用；首次为空串也会回调一次）。 */
  onPlayerNameChange?: (name: string) => void;
  /** 地图 `servercommand` 映射出的物理参数（`name` 是物理面板参数名）。 */
  onMapPhysicsParam?: (name: string, value: number | boolean) => void;
  /**
   * 实体 brush 碰撞状态变化（`func_wall_toggle` / `func_door` 开关）。
   * 调试端用它同步几何可见性；game 端可忽略（纯视觉）。
   */
  onBrushSolidChange?: (entity: number, solid: boolean) => void;
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

/** 解析实体层 `brush` 事件载荷 `<entityIndex>:<true|false>`（true = 实心）。 */
function parseBrushSolidDetail(detail: string | undefined): { entity: number; solid: boolean } | null {
  if (!detail) return null;
  const m = /^(-?\d+):(true|false)$/.exec(detail);
  if (!m) return null;
  const entity = Number.parseInt(m[1], 10);
  if (!Number.isInteger(entity) || entity < 0) return null;
  return { entity, solid: m[2] === 'true' };
}

/**
 * 出生即非实心的 brush 实体（与 Rust `render_bundle::entity_start_solid` 同一套规则）。
 *
 * 用处：载图时把「实体层判定为关」的 brush 几何也同步隐藏（Rust 侧已按同一规则把
 * `start_solid=false` 的 brush 排除出碰撞查询，但渲染层没有事件就不会藏几何）。
 *
 * - `func_door*`：`spawnpos != 0` 或 spawnflags bit9（512 = START_OPEN_OBSOLETE）⇒ 初始开着；
 * - `func_wall_toggle`：spawnflags bit0（1 = START_OFF）；
 * - `func_brush`：`StartDisabled != 0`。
 *
 * 注意 `spawnpos` 是这张 ze 图（BSP 里 46 扇门中 8 扇）带的地图键：带它的门只被 `Close`
 * 连接驱动（#568 counter OnHitMax → lvl1_door_03 Close），即设计上初始就是开着的；两侧
 * 规则必须一致，否则会出现「物理放行、渲染显示关着的门」或反过来。
 */
function entityStartsNonSolid(entity: {
  classname: string;
  spawnflags: number;
  getNumber(key: string, fallback: number): number;
  getRaw(key: string): string | undefined;
}): boolean {
  // `spawnpos` / `startdisabled` 是 raw 键（字符串值），`getNumber` 只认 number 字段；
  // 不按原文解析会把 `spawnpos=1` 的初始开门误判成 0（实测门「看着关着、能穿过去」）。
  const rawNumber = (key: string, fallback: number): number => {
    const raw = entity.getRaw(key);
    if (raw !== undefined) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return entity.getNumber(key, fallback);
  };
  const cls = entity.classname;
  if (cls.startsWith('func_door')) {
    return rawNumber('spawnpos', 0) !== 0 || (entity.spawnflags & 512) !== 0;
  }
  if (cls === 'func_wall_toggle') return (entity.spawnflags & 1) !== 0;
  if (cls === 'func_brush') return rawNumber('startdisabled', 0) !== 0;
  return false;
}

/**
 * 从实体层 `servercommand` / `clientcommand` 的 detail 里解析聊天文本。
 *
 * 地图写的是 `point_servercommand` 的输入 `Command "say ***TEXT***"`（或 `say_team`），
 * 实体层把它原样上报为 detail；聊天框只关心 `say` 这一种命令，其它命令（改 cvar、
 * `sc Command ...` 的物理参数等）继续走各自的处理链。
 *
 * 兼容可选引号包裹（`say "..."`）与 Source 颜色控制字符；返回 null 表示不是聊天命令。
 */
export function parseSayCommand(detail: string | undefined): string | null {
  if (!detail) return null;
  const m = /^say(?:_team)?\s+(.+)$/i.exec(detail.trim());
  if (!m) return null;
  let text = m[1].trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  text = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
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
  /** 起跳高度默认值（HU）；面板 `jumpSpeed` 应用时由 {@link setDefaultJumpHeight} 更新。 */
  private defaultJumpHeight: number;
  /** 上次看到的物理实例；换图后主线程会建全新 `PhysWorld`，按实例镜像的状态需要重放。 */
  private physRef: GameplayPhysLike | null = null;
  /** `autohop_zone` 体积（玩家碰撞箱与之求交决定跳高）。 */
  private autohopZones: { min: [number, number, number]; max: [number, number, number] }[] = [];
  /** 带体积的 trigger 列表（debug 碰撞可视化用；game 端可忽略）。 */
  private triggerBoxes: EntityTriggerVolumeView[] = [];
  /** 最近一次下发的水平速度上限 / 跳高（null = 还没下发过）。 */
  private speedCap: number | null = null;
  /** 地图 `sv_maxvelocity` 给的上限（null = 地图没设过）。 */
  private mapSpeedCap: number | null = null;
  /** 用户设置项 `physics.maxHorizontalSpeed`（null = 关闭，只跟随地图）。 */
  private userSpeedCap: number | null = null;
  private jumpHeight: number | null = null;
  /** 已镜像给权威侧的玩家名与 filter 开关（`null` = 还没同步过）。 */
  private playerNamePushed: string | null = null;
  private teleportFilterPushed: boolean | null = null;
  /**
   * 实体 brush 的实心状态镜像（`entity → solid`）：只记录**运行期变化过**的实体。
   * 出生态由 Rust 侧 `start_solid` 决定（实体层 spawn 时 `applyHost=false` 不发事件），
   * 这里只负责「物理实例晚于事件建立」时把已发生的开关重放上去。
   */
  private brushSolid = new Map<number, boolean>();
  /**
   * 传送触发器的启用状态镜像（`entity → enabled`）：地图 `trigger_teleport` 的
   * `StartDisabled` 在 Rust 建表时只决定**初值**，运行期 `Enable`/`Disable` 需要本层
   * 同步到 `TeleportManager`（否则实体层开了、物理静态表仍是关的，玩家永远传不过去）。
   * 首次 `update()` 会把所有传送实体的当前状态推一遍（保证实体初态与物理表对齐）。
   */
  private teleportEnabled = new Map<number, boolean>();

  constructor(options: EntityGameplayOptions) {
    this.options = options;
    this.defaultJumpHeight = options.defaultJumpHeight ?? 57;
    const initialCap = options.initialUserSpeedCap;
    if (initialCap != null && Number.isFinite(initialCap) && initialCap > 0) {
      this.userSpeedCap = initialCap;
    }
  }

  /** 当前下发的水平速度上限（诊断/测试用）。 */
  get speedCapApplied(): number | null {
    return this.speedCap;
  }

  /**
   * 设置用户横向限速（`0`/负数/`null` = 关闭，此时只跟随地图 `sv_maxvelocity`）。
   *
   * Source 的 `sv_maxvelocity` 只钳水平模长（竖直不受限），我们沿用同一口径：
   * 生效值取「地图值」与「用户值」的较小者——用户设置只能收紧、不能把地图限制放宽。
   * 面板「横向限速」项与各端 config 的 `physics.maxHorizontalSpeed` 同参。
   */
  setUserSpeedCap(cap: number | null): void {
    this.userSpeedCap = cap != null && Number.isFinite(cap) && cap > 0 ? cap : null;
    this.applyEffectiveSpeedCap();
  }

  /** 按「地图值 ∩ 用户值」重算生效上限并下发渲染物理线 + 权威侧。 */
  private applyEffectiveSpeedCap(): void {
    const mapCap = this.mapSpeedCap;
    const userCap = this.userSpeedCap;
    let effective: number | null = null;
    if (mapCap != null && userCap != null) effective = Math.min(mapCap, userCap);
    else if (mapCap != null) effective = mapCap;
    else if (userCap != null) effective = userCap;
    if (effective == null || !Number.isFinite(effective) || effective <= 0) return;
    this.speedCap = effective;
    this.options.getPhys()?.set_max_horizontal_speed?.(effective);
    this.options.onSpeedCapChange?.(effective);
  }

  /** 把已生效的上限重放到当前物理实例（宿主/物理实例重建用；不重复通知权威侧）。 */
  private pushSpeedCapToPhys(): void {
    if (this.speedCap == null) return;
    this.options.getPhys()?.set_max_horizontal_speed?.(this.speedCap);
  }

  /**
   * 更新起跳高度默认值（HU）：面板 `jumpSpeed` 应用时由宿主端按 `jumpSpeed²/(2·gravity)`
   * 重算后调用。
   *
   * 为什么不能只留构造参数：`load()` 与「离开跳跃增幅区」都用默认值把跳高压回去。
   * 若默认值停留在 renderer.init 时的旧 config（panel 偏好晚于 init 合并），换图/离区
   * 会把面板设定值覆盖回 57。下一帧 `updateAutohopZoneJump()` 会按新基线重算并在变化时下发。
   */
  setDefaultJumpHeight(height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    this.defaultJumpHeight = height;
  }

  /** 当前下发的起跳高度（诊断/测试用）。 */
  get jumpHeightApplied(): number | null {
    return this.jumpHeight;
  }

  /** 实体系统本体（debug 面板/诊断需要；未装配为 null）。 */
  get system(): EntitySystem | null {
    return this.entitySystem;
  }

  /**
   * 玩家 `+use`：从视线选最近的可交互实体并触发（`func_button` / `func_door` 等）。
   *
   * `eye` 是眼睛位置、`dir` 是客户端相机前向（无需归一化），`reach` 是作用距离（HU）。
   * 返回触发的实体数；实体系统未装配时返回 0。按钮压制 / 门的开合都走实体层既有
   * `Use` 实现，副作用（碰撞、输出）与地图 I/O 一致。
   */
  useFromView(eye: [number, number, number], dir: [number, number, number], reach = 80): number {
    const picked = this.entitySystem?.pickUseFromView(eye, dir, reach) ?? null;
    if (!picked) return 0;
    this.entitySystem?.useEntity(picked);
    return 1;
  }

  /**
   * 只选靶不触发（调试可视化用）：返回视线内最近可交互实体的 BSP 下标，-1 = 没有。
   *
   * 与 `useFromView` 同一选靶规则；`useEntity()` 负责实际触发。
   */
  pickUseFromView(eye: [number, number, number], dir: [number, number, number], reach = 80): number {
    const picked = this.entitySystem?.pickUseFromView(eye, dir, reach) ?? null;
    return picked ? picked.index : -1;
  }

  /** 按 BSP 下标触发实体 `Use`（F 键选靶后调用）；实体不存在返回 false。 */
  useEntity(index: number): boolean {
    const entity = this.entitySystem?.getEntity(index);
    if (!entity) return false;
    this.entitySystem?.useEntity(entity);
    return true;
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
    // 换图后地图 `sv_maxvelocity` 会重新下发；这里只清地图值，用户设置项（userSpeedCap）保留。
    this.mapSpeedCap = null;
    // 换图后实体下标空间与 Rust brush 初态都是新的：清掉上一张图的运行期开关镜像。
    this.brushSolid.clear();
    this.teleportEnabled.clear();
    // 出生即「关」的 brush（初始开着的门 / START_OFF 墙 / StartDisabled 的 func_brush）：
    // Rust 侧建物理世界时已按 `start_solid=false` 排除碰撞，但渲染层没有事件就不会藏几何，
    // 于是会出现「能穿过去但看着是关着的门/墙」。这里把初态同步成渲染可见性镜像：
    // 记进 `brushSolid`（物理实例晚于本调用建立时由 `update()` 重放，属于安全冗余），
    // 并通过 `onBrushSolidChange` 通知宿主隐藏几何。
    const attached = this.entitySystem;
    if (attached) {
      for (const entity of attached.entList.entities) {
        if (!entityStartsNonSolid(entity)) continue;
        this.brushSolid.set(entity.index, false);
        this.options.onBrushSolidChange?.(entity.index, false);
      }
    }
    // 立即按「地图值 ∩ 用户值」重放一次生效限速（地图值若在实体装配期已由
    // `servercommand sv_maxvelocity` 写入，则这里直接取两者较小者）。不能只存不发：
    // 面板默认用户限速（5000）若不下发，Rust 侧会退回自己的兜底默认，面板值与权威实际
    // 生效值分叉。物理线若晚于本调用建立，由 `update()` 的实例变更分支再重放。
    this.applyEffectiveSpeedCap();
  }

  /** 每帧推进：实体 I/O → 跳跃增幅区 → 玩家名门控。物理未就绪时只跑实体。 */
  update(dt: number): void {
    if (!this.entitySystem) return;
    this.entitySystem.frame(dt);
    const phys = this.options.getPhys();
    if (phys !== this.physRef) {
      this.physRef = phys;
      if (phys) {
        // 换图后主线程是全新 `PhysWorld` 实例（`load()` 时它还不存在，见 loadScene →
        // buildPredictionWorld 的顺序）：按实例镜像的状态整体重放一次。跳高置 null 让
        // `updateAutohopZoneJump()` 用当前基线重发；玩家名/filter 也要重新推。
        this.jumpHeight = null;
        this.pushSpeedCapToPhys();
        this.playerNamePushed = null;
        this.teleportFilterPushed = null;
        // brush 开关镜像重放：`load()` 时物理实例还不存在（见 loadScene →
        // buildPredictionWorld 顺序），期间发生的 `func_wall_toggle` / 门事件要补到新世界。
        for (const [entity, solid] of this.brushSolid) {
          phys.set_brush_solid?.(entity, solid);
        }
        // 传送区开关镜像重放：同上，`load()` 之后、物理实例建立之前发生的阶段推进
        // （`tp_stage01/02` 的 Enable）要补到新世界。
        for (const [entity, enabled] of this.teleportEnabled) {
          phys.set_teleport_enabled?.(entity, enabled);
        }
      }
    }
    // 实体层 `trigger_teleport` 的 Enable/Disable → Rust 静态传送表（每帧只在状态变化时下发）。
    this.syncTeleportTriggers(phys);
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

  /** 实体 brush 当前实心状态（运行期改过的才有记录；出生态由 Rust 决定）。 */
  brushSolidOf(entity: number): boolean | undefined {
    return this.brushSolid.get(entity);
  }

  /**
   * 遍历运行期改过实心状态的实体 brush（entity → 当前是否实心）。
   * 渲染侧在「可见性管理权交接」时用它重放几何隐藏/恢复，避免与插件实例状态错位。
   */
  forEachBrushSolid(callback: (entity: number, solid: boolean) => void): void {
    for (const [entity, solid] of this.brushSolid) callback(entity, solid);
  }

  /** 实体传送区当前启用状态（运行期同步过的才有记录；初态由 Rust `start_disabled` 决定）。 */
  teleportEnabledOf(entity: number): boolean | undefined {
    return this.teleportEnabled.get(entity);
  }

  /**
   * 把实体层 `trigger_teleport` 的启用状态同步到 Rust 静态传送表。
   *
   * 每帧只遍历 classname 以 `trigger_teleport` 开头的实体（一张图几十个），
   * 状态变化才调用物理（wasm 边界不白跑）。物理实例未就绪时只记镜像，建立后由
   * `update()` 的实例变更分支整体重放。
   */
  private syncTeleportTriggers(phys: GameplayPhysLike | null): void {
    const system = this.entitySystem;
    if (!system) return;
    for (const entity of system.entList.entities) {
      if (!entity.classname.startsWith('trigger_teleport')) continue;
      const enabled = !entity.disabled;
      if (this.teleportEnabled.get(entity.index) === enabled) continue;
      this.teleportEnabled.set(entity.index, enabled);
      phys?.set_teleport_enabled?.(entity.index, enabled);
    }
  }

  /** 卸载：释放实体系统并清空缓存。 */
  dispose(): void {
    this.entitySystem?.dispose();
    this.entitySystem = null;
    this.autohopZones = [];
    this.triggerBoxes = [];
    this.jumpHeight = null;
    this.speedCap = null;
    this.mapSpeedCap = null;
    this.physRef = null;
    this.playerNamePushed = null;
    this.teleportFilterPushed = null;
    this.brushSolid.clear();
    this.teleportEnabled.clear();
  }

  // ── 事件 → 物理/权威 ────────────────────────────────────────────

  private onEntityEvent(event: EntityEvent): void {
    // trigger_push 一类速度副作用：观测宿主只 emit，在这里落到物理线。
    // `entity:addVelocity` = `ApplyAbsVelocityImpulse`（纯叠加）——ONCE 板与非 ONCE 板
    //   共用：非 ONCE 板在**接触触发区的当下**立刻叠加一次 `pushdir*speed`（owner 2026-11-20 口径，
    //   见 `classes/triggers.ts`），同一次接触不重复，离开后再接触会再给一次。
    // `entity:baseVelocity` = 旧版 `SetBaseVelocity` 通道；trigger_push 已不再使用它
    //   （历史实现是「区内每帧覆盖速度为 pushdir*speed」，与 Source 的 base-velocity 语义不符），
    //   保留处理只为兼容 `trigger_gravity` 的 `setPlayerBaseVelocity(null)` 清理；
    //   `set` 分支不再被常规实体路径触发。
    if (event.kind === 'entity:addVelocity') {
      const v = parseVelocityDetail(event.detail);
      if (v) this.applyPlayerVelocity(v, 'add');
    } else if (event.kind === 'entity:baseVelocity') {
      const v = parseVelocityDetail(event.detail);
      if (v) this.applyPlayerVelocity(v, 'set');
    } else if (event.kind === 'servercommand') {
      // 地图脚本的 `servercommand`（logic_auto OnMapSpawn 等）：目前只认速度上限
      // `sv_maxvelocity`——surf 图靠它把满速抬到 3500/10000；没这条命令时由用户限速 /
      // 两端单源默认值兜底（见 `PhysWorld::max_horizontal_speed` 与
      // `PHYSICS_PARAM_DEFAULTS.maxHorizontalSpeed`）。
      this.applyServerCommand(event.detail ?? '');
      // 同一通道还会携带 `say ***...***`（倒计时 / 关卡提示）：chat 与物理参数互斥，
      // 解析不出聊天文本就当作普通 servercommand 已处理完。
      const chat = parseSayCommand(event.detail);
      if (chat) this.options.onChatMessage?.(chat);
    } else if (event.kind === 'clientcommand') {
      // `point_clientcommand` 的 `say`（少数地图用客户端命令打聊天）。
      const chat = parseSayCommand(event.detail);
      if (chat) this.options.onChatMessage?.(chat);
    } else if (event.kind === 'brush') {
      // 实体层 brush 开关（`func_wall_toggle` Toggle、`func_door` 开门/关门）：
      // 落到物理线对应实体 brush 的碰撞开关；物理实例未就绪时先记镜像，建立后重放。
      // 渲染几何不在这一步处理（可见性/动画由宿主另接，见 `onBrushSolidChange`）。
      const brush = parseBrushSolidDetail(event.detail);
      if (brush) {
        this.brushSolid.set(brush.entity, brush.solid);
        this.options.getPhys()?.set_brush_solid?.(brush.entity, brush.solid);
        this.options.onBrushSolidChange?.(brush.entity, brush.solid);
      }
    }
    this.options.onEntityEvent?.(event);
  }

  /**
   * 把实体层上报的速度副作用同时施加到物理线并转发给权威 Worker。
   *
   * @param mode 'add' = 叠加冲量（ONCE 板 + 非 ONCE 板接触瞬间那一次）；'set' = 覆盖速度
   *   （仅保留给旧通道 `entity:baseVelocity`，常规实体路径不再使用）。
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
   * 处理地图脚本下发的 `servercommand`（`logic_auto OnMapSpawn → point_servercommand`）。
   *
   * 一条命令里可能有多条 cvar（`;` 或换行分隔）。分两类：
   * - `sv_maxvelocity <n>`：速度上限，走 `set_max_horizontal_speed`（只钳水平模长；
   *   Source 默认 3500，surf_666 的 logic_auto 会改成 10000 —— 以地图为准）；
   * - 其余在 `map-cvars.ts` 表里的（`sv_airaccelerate` / `sv_enablebunnyhopping` 等）：
   *   翻成物理面板参数名，先写渲染物理线，再经 `onMapPhysicsParam` 转发给权威 Worker
   *   （两侧必须同参，否则权威与渲染手感分叉）。
   */
  private applyServerCommand(command: string): void {
    for (const line of command.split(/[;\n]/)) {
      const m = /^\s*sv_maxvelocity\s+(-?\d+(?:\.\d+)?)\s*$/i.exec(line);
      if (m) {
        const cap = Number(m[1]);
        if (!Number.isFinite(cap)) continue;
        // 地图值先记下，再与用户设置项取小（见 `setUserSpeedCap`）——用户只能收紧。
        this.mapSpeedCap = cap;
        this.applyEffectiveSpeedCap();
        continue;
      }
      for (const { name, value } of mapCvarsToPhysicsParams(line)) {
        const rustName = PANEL_TO_RUST[name];
        if (rustName) {
          this.options.getPhys()?.set_params?.(JSON.stringify({ [rustName]: value }));
        }
        this.options.onMapPhysicsParam?.(name, value);
      }
    }
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
