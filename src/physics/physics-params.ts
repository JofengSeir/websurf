/**
 * 物理参数管理器（物理控制面板的数据源与执行层）。
 *
 * 职责：
 * 1. 维护 14 项物理参数的「当前生效值 + 来源」：
 *    - 来源 `mode-default`：cs-movement 基准默认（CS:S 值）
 *    - 来源 `manual`：面板手动修改
 *    - 来源 `map`：预留（未来地图 worldspawn 键值，如 sv_gravity）
 * 2. 参数分两类落点：
 *    - Settings 类（PlayerController.settings）：airAccelerate / runSpeed / autobhop 等
 *    - Runtime 类（src/physics/runtime.ts）：gravity / accelerate / friction / stopSpeed / jumpHeight
 * 3. 碰撞箱体型（hull）管理：setHull / resetHull / 自动恢复检测。
 *
 * 该管理器由 Worker（PhysicsWorker）持有；主线程通过
 * set-physics-param / reset-physics-param 消息操作，经 physics-snapshot 回传状态。
 */

import { type Settings } from './settings/Settings.js';
import {
  DEFAULT_HULL,
  isDefaultHull,
  type HullConfig,
} from './player/Duck/Duck.config.js';
import type { PlayerController } from './player/PlayerController.js';
import { findParamDef, PARAM_DEFS, type ParamSource, type ParamState } from './param-defs.js';
import { DEFAULT_RUNTIME_PHYSICS, resetAllRuntimePhysics, setRuntimeParam } from './runtime.js';

/** 碰撞箱面板状态。 */
export interface HullState {
  hull: HullConfig;
  source: ParamSource;
  /** 当前是否等于默认体型。 */
  isDefault: boolean;
}

/** 卡住自动恢复的触发阈值（tick 数，128Hz 下 48 tick ≈ 0.375s）。 */
const AUTO_RESTORE_STUCK_TICKS = 48;

export class PhysicsParams {
  /** 覆盖表：name → {value, source}；未覆盖 = mode-default。 */
  private readonly overrides = new Map<string, { value: number | boolean; source: ParamSource }>();
  private hull: HullConfig = { ...DEFAULT_HULL };
  private hullSource: ParamSource = 'mode-default';
  /** 碰撞箱自动恢复开关（hull 非默认 + 持续卡住 → 强制恢复默认）。 */
  autoRestoreHull = true;

  private player: PlayerController | null = null;
  private settings: Settings | null = null;

  /**
   * tickRate 变更回调（由 Worker 注入 → renderLoop.setTickRate）。
   * tickRate 同时写入 settings.tickRate（cs-movement advisory 字段），
   * 实际步长由渲染循环消费。
   */
  onTickRateChange: ((rate: number) => void) | null = null;

  /** 绑定 PlayerController 与 Settings（Worker 创建 player 后调用）。 */
  attach(player: PlayerController, settings: Settings): void {
    this.player = player;
    this.settings = settings;
    // 应用已存在的覆盖（含 hull）
    for (const [name, o] of this.overrides) {
      this.applyOverride(name, o.value);
    }
    player.setHull(this.hull);
  }

  /** 手动设置参数（来源 = manual）。 */
  setParam(name: string, value: number | boolean): void {
    const def = findParamDef(name);
    if (!def) return;
    // 数值钳制到定义范围
    let v = value;
    if (def.kind === 'number' && typeof v === 'number') {
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
    }
    this.overrides.set(name, { value: v, source: 'manual' });
    this.applyOverride(name, v);
  }

  /** 地图来源（预留：未来 worldspawn 键值 → source=map）。 */
  setParamFromMap(name: string, value: number | boolean): void {
    this.overrides.set(name, { value, source: 'map' });
    this.applyOverride(name, value);
  }

  /** 恢复单个参数（缺省 = 全部）到 mode-default。 */
  resetParam(name?: string): void {
    if (name) {
      this.overrides.delete(name);
      this.applyOverride(name, findParamDef(name)?.default);
    } else {
      this.overrides.clear();
      for (const def of PARAM_DEFS) this.applyOverride(def.name, def.default);
      this.resetAllRuntimeAndSettings();
    }
  }

  /** 设置碰撞箱体型（来源 = manual）。 */
  setHull(hull: HullConfig): void {
    this.hull = { ...hull };
    this.hullSource = 'manual';
    this.player?.setHull(this.hull);
  }

  /** 恢复默认碰撞箱。 */
  resetHull(): void {
    this.hull = { ...DEFAULT_HULL };
    this.hullSource = 'mode-default';
    this.player?.setHull(this.hull);
  }

  /** 碰撞箱面板状态。 */
  getHullState(): HullState {
    return {
      hull: this.player ? this.player.hull : this.hull,
      source: this.hullSource,
      isDefault: isDefaultHull(this.hull),
    };
  }

  /**
   * 自动恢复检测（每帧由 Worker 调用）：
   * 当 autoRestoreHull 开启、hull 非默认、且玩家持续卡住（stuckTicks 超阈值）时，
   * 强制恢复默认碰撞箱并返回 true（调用方回传通知）。
   */
  checkAutoRestore(): boolean {
    const p = this.player;
    if (!p) return false;
    if (!this.autoRestoreHull) return false;
    if (isDefaultHull(p.hull)) return false;
    if (p.stuckTicks < AUTO_RESTORE_STUCK_TICKS) return false;
    this.resetHull();
    this.hullSource = 'mode-default';
    p.stuckTicks = 0;
    return true;
  }

  /** 全量快照（面板渲染用）。 */
  snapshot(): ParamState[] {
    return PARAM_DEFS.map((def) => {
      const o = this.overrides.get(def.name);
      return {
        ...def,
        value: o ? o.value : def.default,
        source: o ? o.source : 'mode-default',
      };
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private applyOverride(name: string, value: number | boolean | undefined): void {
    if (!this.settings || value === undefined) return;
    switch (name) {
      case 'maxSpeed': this.settings.runSpeed = value as number; break;
      case 'walkSpeed': this.settings.walkSpeed = value as number; break;
      case 'crouchSpeed': this.settings.crouchSpeed = value as number; break;
      case 'airAccelerate': this.settings.airAccelerate = value as number; break;
      case 'autobhop': this.settings.autobhop = value as boolean; break;
      case 'bhopSpeedClamp': this.settings.bhopSpeedClamp = value as boolean; break;
      case 'noPrestrafe': this.settings.noPrestrafe = value as boolean; break;
      case 'perfEnabled': this.settings.perf.enabled = value as boolean; break;
      case 'maxAirSpeed': this.settings.perf.maxAirSpeed = value as number; break;
      case 'tickRate':
        this.settings.tickRate = value as number;
        this.onTickRateChange?.(value as number);
        break;
      case 'gravity': setRuntimeParam('gravity', value as number); break;
      case 'accelerate': setRuntimeParam('accelerate', value as number); break;
      case 'friction': setRuntimeParam('friction', value as number); break;
      case 'stopSpeed': setRuntimeParam('stopSpeed', value as number); break;
      case 'jumpHeight': setRuntimeParam('jumpHeight', value as number); break;
      default: break;
    }
  }

  private resetAllRuntimeAndSettings(): void {
    resetAllRuntimePhysics();
  }
}

/** 便捷函数：当前 runtime 值（供状态展示）。 */
export function runtimeDefaults(): typeof DEFAULT_RUNTIME_PHYSICS {
  return DEFAULT_RUNTIME_PHYSICS;
}
