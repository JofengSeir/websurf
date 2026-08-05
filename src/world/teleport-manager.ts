/**
 * 传送点管理器
 *
 * 将 WASM `parse_teleports` 输出的 JSON 转换为运行时传送点管理器。
 * 坐标已在 Rust 端旋转为 Y-up（`[x,y,z]→[y,z,x]`），TS 端不再二次重映射。
 *
 * **职责**：
 * - 解析 trigger_teleport 与 info_teleport_destination 的链接关系
 * - 在物理 tick 中检测玩家是否进入触发器区域
 * - 触发时将玩家传送到目标点
 *
 * **触发检测**：trigger_teleport 是 brush 实体，其几何范围由 `model *N`
 * 指向的 bsp.models[N] 的 AABB 定义。Rust 端已解析并输出 `model_mins`/
 * `model_maxs`（Y-up）。检测优先使用 AABB 包含测试；无 AABB 时回退到
 * `origin` 周围 `TRIGGER_RADIUS` 球形检测（兼容性兜底）。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import { type WasmTeleportReport } from './types.js';

// ---------------------------------------------------------------------------
// 触发器配置
// ---------------------------------------------------------------------------

/** 球形检测半径（HU，Source 单位）。仅在 trigger 无 model AABB 时用作回退。
 * trigger_teleport brush 通常远大于此值，因此 AABB 检测是主路径。 */
const TRIGGER_RADIUS = 64;

/** 触发冷却时间（秒），防止同一触发器在连续 tick 中反复触发。 */
const TRIGGER_COOLDOWN = 0.5;

/**
 * 传送触发模式（用于调试 CS:S 传送行为的差异）。
 *
 * - `every-frame`: 每帧 AABB 包含检测（旧行为，最敏感）。
 *   只要玩家中心在 trigger AABB 内就触发，可能在大区域 trigger 中误触发
 *   （如 idx=557 30288×16800×18366 HU 的越界传送区，玩家在空中也立即传送）。
 *
 * - `start-touch`: StartTouch 边沿触发（CS:S 引擎原生行为）。
 *   仅在玩家从 AABB 外跨入 AABB 内时触发一次传送。
 *   玩家已经在 AABB 内（出生点或被传送后）不会重复触发，必须先离开再进入。
 *   实现方式：维护每个 trigger 的 inside 状态，仅在 false→true 跳变时触发。
 *
 * - `start-touch-grounded`: StartTouch + 着地状态（surf 服务器常见插件行为）。
 *   在 start-touch 基础上增加约束：玩家必须在着地状态（onGround=true）才触发传送。
 *   "空中不传送，落到地面才传送" — 对应 surf map 中常见的"误入越界区不立即回弹，
 *   落地才回起点"行为。
 */
export type TeleportTriggerMode =
  | 'every-frame'
  | 'start-touch'
  | 'start-touch-grounded';

/**
 * 将 BSP yaw（方位角，顺时针）转换为 cs-movement yaw（逆时针）。
 *
 * 公式：`cs_yaw = (270 - BSP_yaw) % 360`
 * 推导见 spawn-loader.ts 文件头注释。
 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------
// 运行时类型
// ---------------------------------------------------------------------------

/** 已解析的传送目标点。 */
export interface TeleportDestination {
  /** 目标点索引（在 `WasmTeleportReport.teleports` 数组中的位置）。 */
  index: number;
  /** targetname（与 trigger.target 匹配）。 */
  targetname: string;
  /** 目标坐标（Y-up）。 */
  origin: Vec3;
  /** BSP 原始角度 `[pitch, yaw, roll]`。 */
  angles: [number, number, number];
  /** 转换后的 cs-movement yaw（度，逆时针，0=朝 -Z）。
   * 由 BSP yaw（顺时针方位角）经 `bspYawToCsYaw` 转换而来。 */
  yaw: number;
}

/** 已解析的传送触发器。 */
export interface TeleportTrigger {
  /** 触发器索引。 */
  index: number;
  /** classname（如 `trigger_teleport`）。 */
  classname: string;
  /** 目标 targetname（匹配 dest.targetname）。 */
  target: string;
  /** 触发器坐标（Y-up，用于球形回退检测）。 */
  origin: Vec3;
  /** model 字符串（如 `*5`，指向 bsp.models[5]）。 */
  model: string | null;
  /** model brush AABB min（Y-up）。null = 无 model，回退球形检测。 */
  mins: Vec3 | null;
  /** model brush AABB max（Y-up）。null = 无 model，回退球形检测。 */
  maxs: Vec3 | null;
  /**
   * 触发区域凸包平面（世界坐标 Y-up，法线朝外，内部 dot(n,p)-dist <= 0）。
   * 提供时用凸包精确判定（楔形/斜面触发区，如绑在 trigger 实体上的斜坡）；
   * 缺省（undefined/null）回退 AABB 判定。
   */
  planes?: { normal: Vec3; dist: number }[] | null;
  /** 关联的目标点索引（-1 = 孤儿触发器，无匹配目标）。 */
  destIndex: number;
  /**
   * spawnflags（bitfield）。bit 1=Clients, 2=NPCs, 8=PhysicsObjects,
   * 16=Only players, 64=Everything。用于检测是否对玩家启用。
   */
  spawnflags: number;
  /** StartDisabled（true=禁用，不会触发传送）。 */
  startDisabled: boolean;
}

// ---------------------------------------------------------------------------
// TeleportManager
// ---------------------------------------------------------------------------

/**
 * 传送点管理器。
 *
 * 在物理 tick 中调用 `checkTeleport(pos)` 检测玩家是否进入触发器区域。
 * 若触发，返回目标坐标，由调用方执行传送。
 */
export class TeleportManager {
  private readonly triggers: TeleportTrigger[] = [];
  private readonly destinations: TeleportDestination[] = [];
  private cooldown = 0;
  /**
   * 每个 trigger 的 inside 状态（用于 start-touch 边沿触发模式）。
   * 数组索引与 triggers 对齐。true = 玩家上一帧在此 trigger 内。
   * 初始全为 false，玩家首次进入时触发 StartTouch。
   * 在 every-frame 模式下不使用此数组。
   */
  private readonly insideStates: boolean[];
  /**
   * 当前触发模式（默认 StartTouch 边沿触发，CS:S 引擎原生行为）。
   * 由物理面板单选框切换；落地检测 = start-touch-grounded。
   */
  private triggerMode: TeleportTriggerMode = 'start-touch';
  /**
   * 玩家连续着地的帧数计数器（用于 start-touch-grounded 模式）。
   *
   * 每帧根据传入的 onGround 参数更新：
   * - onGround=true: 计数器递增（上限 required+1 避免溢出）
   * - onGround=false: 计数器归零
   *
   * 仅在 start-touch-grounded 模式下用作触发条件之一。
   * 切换模式或重置时不归零（保留玩家真实落地状态）。
   */
  private groundedFrames = 0;
  /**
   * 触发传送所需的连续着地帧数阈值（默认 1，单帧落地即触发；仅落地检测模式生效）。
   *
   * - 1: 单帧落地即触发（最敏感，原始行为）
   * - 3-5: 要求持续 50-83ms 落地（约 3-5 个 16.67ms tick），过滤瞬时触地
   * - 10: 严格模式，要求持续约 167ms 落地（接近 ckSurf 插件行为）
   *
   * 仅在 start-touch-grounded 模式下生效。
   */
  private groundedFramesRequired = 1;

  constructor(wasmJson: string) {
    const data: WasmTeleportReport = JSON.parse(wasmJson);

    // 解析目标点
    for (const d of data.teleports) {
      this.destinations.push({
        index: d.index,
        targetname: d.targetname,
        origin: { x: d.origin[0], y: d.origin[1], z: d.origin[2] },
        angles: d.angles,
        yaw: bspYawToCsYaw(d.angles[1]),
      });
    }

    // 解析触发器 + 建立 target → dest 映射
    const destByName = new Map<string, number>();
    this.destinations.forEach((d, i) => {
      destByName.set(d.targetname, i);
    });

    for (const t of data.triggers) {
      const destIdx = destByName.has(t.target) ? destByName.get(t.target)! : -1;
      this.triggers.push({
        index: t.index,
        classname: t.classname,
        target: t.target,
        origin: { x: t.origin[0], y: t.origin[1], z: t.origin[2] },
        model: t.model,
        mins: t.model_mins ? { x: t.model_mins[0], y: t.model_mins[1], z: t.model_mins[2] } : null,
        maxs: t.model_maxs ? { x: t.model_maxs[0], y: t.model_maxs[1], z: t.model_maxs[2] } : null,
        planes: t.model_planes
          ? t.model_planes.map((p) => ({
              normal: { x: p[0], y: p[1], z: p[2] },
              dist: p[3],
            }))
          : null,
        destIndex: destIdx,
        spawnflags: t.spawnflags ?? 1,
        startDisabled: t.start_disabled ?? false,
      });
    }

    // 初始化 inside 状态数组（与 triggers 对齐，全为 false）
    this.insideStates = new Array(this.triggers.length).fill(false);
  }

  /**
   * 设置传送触发模式（由调试面板单选框切换）。
   *
   * 切换模式时会重置所有 inside 状态为 false，避免遗留状态影响新模式的判定。
   * - `every-frame`: 每帧 AABB 包含检测（最敏感，可能误触发）
   * - `start-touch`: StartTouch 边沿触发（CS:S 原生行为）
   * - `start-touch-grounded`: StartTouch + 着地状态（surf 服务器行为）
   */
  setTriggerMode(mode: TeleportTriggerMode): void {
    if (this.triggerMode === mode) return;
    this.triggerMode = mode;
    // 重置 inside 状态，避免遗留状态
    for (let i = 0; i < this.insideStates.length; i++) {
      this.insideStates[i] = false;
    }
    // 重置冷却，允许新模式立即生效
    this.cooldown = 0;
  }

  /**
   * 设置触发传送所需的连续着地帧数阈值（仅 start-touch-grounded 模式生效）。
   *
   * 由调试面板滑块控制，用于验证不同严格度的「落地才传送」行为：
   * - 1: 单帧落地即触发（最敏感，原始行为）
   * - 3-5: 过滤 surf 坡道短暂触地（典型 ckSurf 行为近似）
   * - 10: 严格模式，要求持续约 167ms 落地
   *
   * @param frames 连续着地帧数阈值（1-30，超出范围会被夹紧）。
   */
  setGroundedFramesRequired(frames: number): void {
    const clamped = Math.max(1, Math.min(30, Math.floor(frames)));
    if (this.groundedFramesRequired === clamped) return;
    this.groundedFramesRequired = clamped;
    // 不重置 groundedFrames，保留玩家真实落地状态
  }

  /**
   * 传送后清理 inside 状态。
   *
   * 玩家被传送到目标点后，可能落入另一个 trigger 的 AABB 内。
   * 重置所有 inside 状态，确保 start-touch 模式下不会在传送后立即误触发
   * （CS:S 行为：传送后玩家必须先离开 trigger 再进入才触发）。
   */
  onTeleported(): void {
    for (let i = 0; i < this.insideStates.length; i++) {
      this.insideStates[i] = false;
    }
  }

  /**
   * 检测玩家是否进入传送触发器区域。
   *
   * 优先使用 trigger brush AABB 包含检测；无 AABB 时回退到 origin 球形检测。
   *
   * **触发模式**（由 `triggerMode` 控制，调试面板切换）：
   * - `every-frame`: 每帧 AABB 包含检测（旧行为，最敏感）
   * - `start-touch`: StartTouch 边沿触发（CS:S 原生行为）
   *   仅在玩家从 AABB 外跨入 AABB 内时触发一次传送。
   * - `start-touch-grounded`: StartTouch + 着地状态（surf 服务器行为）
   *   在 start-touch 基础上要求 onGround=true 才触发（空中不传送）。
   *
   * **跳过条件**（v33 修复误传送）：
   * - `startDisabled === true`：触发器初始禁用，不应触发传送
   * - spawnflags 不含 Clients bit（0x01）且不是 Everything（0x40）：
   *   触发器只对 NPC/物理对象生效，不对玩家生效
   * - `destIndex < 0`：孤儿触发器（无匹配目标）
   *
   * @param pos 玩家当前坐标（Y-up）。
   * @param dt 距离上次调用的时间（秒），用于冷却递减。
   * @param onGround 玩家是否着地（仅 start-touch-grounded 模式使用）。
   *   noclip 模式或调用方无法提供时传 false。
   * @returns 目标点（若触发），否则 null。
   */
  checkTeleport(pos: Vec3, dt: number, onGround: boolean = false): TeleportDestination | null {
    // 保存上一帧的落地满足状态（用于落地边沿检测，在更新 groundedFrames 之前读取）
    const wasGrounded = this.groundedFrames >= this.groundedFramesRequired;

    // 更新连续落地帧数计数器（无论是否在冷却期）
    // 上限设为 required+1，避免溢出同时保留「已满足阈值」的语义
    if (onGround) {
      this.groundedFrames = Math.min(this.groundedFrames + 1, this.groundedFramesRequired + 1);
    } else {
      this.groundedFrames = 0;
    }

    if (this.cooldown > 0) {
      this.cooldown -= dt;
      // 冷却期间仍需更新 inside 状态，否则冷却结束后会误触发 start-touch
      if (this.triggerMode !== 'every-frame') {
        this.updateInsideStates(pos);
      }
      return null;
    }

    // 跳过非玩家触发器常量
    const SPAWNFLAG_CLIENTS = 0x01;
    const SPAWNFLAG_EVERYTHING = 0x40;

    for (let i = 0; i < this.triggers.length; i++) {
      const trigger = this.triggers[i];
      // 跳过禁用触发器（StartDisabled=1）
      if (trigger.startDisabled) {
        continue;
      }
      // 跳过非玩家触发器（spawnflags 不含 Clients 且不是 Everything）
      const sf = trigger.spawnflags;
      if ((sf & SPAWNFLAG_CLIENTS) === 0 && (sf & SPAWNFLAG_EVERYTHING) === 0) {
        continue;
      }
      if (trigger.destIndex < 0) {
        continue; // 孤儿触发器
      }

      const nowInside = this.isPlayerInTrigger(pos, trigger);

      // 模式判定
      let shouldFire = false;
      if (this.triggerMode === 'every-frame') {
        // 旧行为：每帧包含检测
        shouldFire = nowInside;
      } else if (this.triggerMode === 'start-touch') {
        // StartTouch 边沿触发：仅 false→true 跳变时触发
        const wasInside = this.insideStates[i];
        shouldFire = nowInside && !wasInside;
      } else {
        // start-touch-grounded: 在 trigger 内 + 落地边沿 + 连续落地帧数
        // 不使用 StartTouch 边沿（!wasInside），而是用落地边沿（!wasGrounded）。
        // 这样玩家空中进入 trigger 后落地仍能触发（修复「落地未传送」bug）。
        // wasGrounded 在 checkTeleport 开头读取（更新 groundedFrames 之前的值）。
        const grounded = this.groundedFrames >= this.groundedFramesRequired;
        shouldFire = nowInside && !wasGrounded && grounded;
      }

      // 更新 inside 状态（无论是否触发）
      this.insideStates[i] = nowInside;

      if (shouldFire) {
        this.cooldown = TRIGGER_COOLDOWN;
        return this.destinations[trigger.destIndex] ?? null;
      }
    }
    return null;
  }

  /**
   * 更新所有 trigger 的 inside 状态（不触发传送）。
   *
   * 在冷却期间调用，确保冷却结束后 start-touch 模式的状态正确。
   * 否则玩家在冷却期间进入 trigger，冷却结束后会因 false→true 跳变误触发。
   */
  private updateInsideStates(pos: Vec3): void {
    for (let i = 0; i < this.triggers.length; i++) {
      this.insideStates[i] = this.isPlayerInTrigger(pos, this.triggers[i]);
    }
  }

  /**
   * 检测玩家是否在 trigger 区域内。
   * - 有凸包平面（planes）：逐平面 dot(n,p)-dist <= eps 判定（精确，支持楔形/斜面）
   * - 有 AABB（mins/maxs）：AABB 包含检测（玩家中心在 mins/maxs 范围内）
   * - 无 AABB：球形回退（距离 origin <= TRIGGER_RADIUS）
   */
  private isPlayerInTrigger(pos: Vec3, trigger: TeleportTrigger): boolean {
    // 凸包精确判定（法线朝外：内部 dot(n,p)-dist <= 0）
    if (trigger.planes && trigger.planes.length > 0) {
      for (const p of trigger.planes) {
        const d =
          p.normal.x * pos.x + p.normal.y * pos.y + p.normal.z * pos.z - p.dist;
        if (d > 0.001) return false;
      }
      return true;
    }
    if (trigger.mins && trigger.maxs) {
      // AABB 包含检测
      return (
        pos.x >= trigger.mins.x && pos.x <= trigger.maxs.x &&
        pos.y >= trigger.mins.y && pos.y <= trigger.maxs.y &&
        pos.z >= trigger.mins.z && pos.z <= trigger.maxs.z
      );
    }
    // 球形回退
    const dx = pos.x - trigger.origin.x;
    const dy = pos.y - trigger.origin.y;
    const dz = pos.z - trigger.origin.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq <= TRIGGER_RADIUS * TRIGGER_RADIUS;
  }

  /** 触发器数量。 */
  get triggerCount(): number {
    return this.triggers.length;
  }

  /**
   * 暴露触发器列表（只读）。
   *
   * 用于触发碰撞箱可视化（ColliderDebug）绘制 trigger AABB 线框。
   */
  getTriggers(): readonly TeleportTrigger[] {
    return this.triggers;
  }

  /** 目标点数量。 */
  get destCount(): number {
    return this.destinations.length;
  }

  /** 重置冷却（用于手动传送或 respawn）。 */
  resetCooldown(): void {
    this.cooldown = 0;
  }
}
