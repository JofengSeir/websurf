/**
 * 物理参数管理器（物理控制面板的数据源与执行层）。
 *
 * 物理已迁移到共享 Rust 物理（websurf-phys，PhysWorld）：
 * - 参数经 `set_params` JSON patch 应用（snake_case 字段，见 src/phys/player.rs PhysParams）
 * - 碰撞箱经 `set_hull` 应用
 * - tickRate 是 JS 驱动层参数（固定步长），不进 Rust，经 onTickRateChange 回调
 *
 * 由 Worker（PhysicsWorker）持有；主线程经 set-physics-param / reset-physics-param
 * 消息操作，经 physics-snapshot 回传状态。
 */

import { findParamDef, PARAM_DEFS, type ParamSource, type ParamState } from './param-defs.js';
import type { PhysWorld } from '../../pkg/websurf_wasm.js';

/** 默认碰撞箱体型（cs-movement 基准，与共享 crate player.rs DEFAULT_HULL_* 一致）。 */
const DEFAULT_HULL = { halfWidth: 16, standHeight: 72, duckHeight: 54 };

/** 面板参数名 → Rust set_params snake_case 字段名。 */
const PARAM_TO_RUST: Record<string, string> = {
  maxSpeed: 'run_speed',
  walkSpeed: 'walk_speed',
  crouchSpeed: 'crouch_speed',
  airAccelerate: 'air_accelerate',
  gravity: 'gravity',
  accelerate: 'accelerate',
  friction: 'friction',
  stopSpeed: 'stop_speed',
  jumpHeight: 'jump_height',
  autobhop: 'autobhop',
  bhopSpeedClamp: 'bhop_speed_clamp',
  noPrestrafe: 'no_prestrafe',
};

/** 碰撞箱面板状态。 */
export interface HullState {
  hull: typeof DEFAULT_HULL;
  source: ParamSource;
  /** 当前是否等于默认体型。 */
  isDefault: boolean;
}

export class PhysicsParams {
  /** 覆盖表：name → {value, source}；未覆盖 = mode-default。 */
  private readonly overrides = new Map<string, { value: number | boolean; source: ParamSource }>();
  private hull: typeof DEFAULT_HULL = { ...DEFAULT_HULL };
  private hullSource: ParamSource = 'mode-default';
  /** 碰撞箱自动恢复开关（Rust 物理已有 stuck 解卡，本开关保留为兼容占位）。 */
  autoRestoreHull = true;

  private phys: PhysWorld | null = null;

  /**
   * tickRate 变更回调（由 Worker 注入 → physicsLoop.setTickRate）。
   */
  onTickRateChange: ((rate: number) => void) | null = null;

  /** 绑定 PhysWorld 实例（Worker 构建世界后调用）；应用已存在的覆盖。 */
  attach(phys: PhysWorld | null): void {
    this.phys = phys;
    if (!phys) return;
    const patch: Record<string, number | boolean> = {};
    for (const [name, o] of this.overrides) {
      const rustName = PARAM_TO_RUST[name];
      if (rustName) patch[rustName] = o.value;
    }
    if (Object.keys(patch).length > 0) {
      phys.set_params(JSON.stringify(patch));
    }
    phys.set_hull(this.hull.halfWidth, this.hull.standHeight, this.hull.duckHeight);
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
    }
  }

  /** 设置碰撞箱体型（来源 = manual）。 */
  setHull(hull: typeof DEFAULT_HULL): void {
    this.hull = { ...hull };
    this.hullSource = 'manual';
    this.phys?.set_hull(hull.halfWidth, hull.standHeight, hull.duckHeight);
  }

  /** 恢复默认碰撞箱。 */
  resetHull(): void {
    this.hull = { ...DEFAULT_HULL };
    this.hullSource = 'mode-default';
    this.phys?.set_hull(DEFAULT_HULL.halfWidth, DEFAULT_HULL.standHeight, DEFAULT_HULL.duckHeight);
  }

  /** 碰撞箱面板状态。 */
  getHullState(): HullState {
    return {
      hull: { ...this.hull },
      source: this.hullSource,
      isDefault:
        this.hull.halfWidth === DEFAULT_HULL.halfWidth &&
        this.hull.standHeight === DEFAULT_HULL.standHeight &&
        this.hull.duckHeight === DEFAULT_HULL.duckHeight,
    };
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
    if (value === undefined) return;
    if (name === 'tickRate') {
      this.onTickRateChange?.(value as number);
      return;
    }
    const rustName = PARAM_TO_RUST[name];
    if (!rustName) return;
    this.phys?.set_params(JSON.stringify({ [rustName]: value }));
  }
}
