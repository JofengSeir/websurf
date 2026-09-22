/**
 * 物理参数管理器：物理控制面板的数据源与执行层。
 *
 * 两条写入通路：
 * - 面板可调项经 `PARAM_TO_RUST` 映射成 snake_case 后写 `PhysWorld.set_params`；
 * - `tickRate` 不是 Rust 键（JS 驱动层的固定步长），`applyOverride` 对它改走
 *   `onTickRateChange` 回调。
 * 碰撞箱走 `PhysWorld.set_hull`。
 *
 * 装配点：`apps/debug/src/worker/physics-worker.ts` 持有唯一实例，在 `attachWorld` 与
 * `reapplyParams` 里调 `attach`。主线程经 `apps/debug/src/input/input-bridge.ts` 的
 * `sendSetPhysicsParam` / `sendResetPhysicsParam` / `sendSetHull` / `sendResetHull` /
 * `sendSetAutoRestoreHull` 操作；Worker 每条处理完回传一次 `physics-snapshot`。
 */

import { findParamDef, PARAM_DEFS, type ParamSource, type ParamState } from './param-defs.js';
import type { PhysWorld } from '../../pkg/websurf_wasm.js';

/** 默认碰撞箱体型（HU）：与 `src/phys/player.rs` 的 `DEFAULT_HULL_HALF_WIDTH` / `DEFAULT_HULL_STAND_HEIGHT` / `DEFAULT_HULL_DUCK_HEIGHT` 同值。 */
const DEFAULT_HULL = { halfWidth: 16, standHeight: 72, duckHeight: 54 };

/** 面板参数名 → Rust `set_params` 的 snake_case 键名（11 项）。
 *
 * 面板参数 `tickRate` 不在本表：它是 JS 驱动层的固定步长，不是 Rust 键。
 *
 * `src/phys/mod.rs` 的 `set_params` 共接受 15 个键；本表不含 `sensitivity`、
 * `yaw_bind_speed`、`noclip_speed`、`teleport_gate_ticks` 四项 —— 它们由
 * `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams` 一次性写全（调用点见
 * `apps/debug/src/worker/main.ts` 的 `syncParamsToWasm`，以及
 * `apps/debug/src/physics/prediction-params.ts` 的 `buildDebugPredictionParams`）。 */
export const PARAM_TO_RUST: Record<string, string> = {
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
};

/** 碰撞箱面板状态（`getHullState` 的返回结构）。 */
export interface HullState {
  hull: typeof DEFAULT_HULL;
  source: ParamSource;
  /** 当前三围是否与 `DEFAULT_HULL` 逐项相等。 */
  isDefault: boolean;
}

/** 面板参数与碰撞箱的唯一持有者（每实例一份覆盖表 + 一份箱体）。 */
export class PhysicsParams {
  /** 覆盖表：参数名 → {值, 来源}；表内没有的项按 `PARAM_DEFS` 的默认值与 `mode-default` 上报。 */
  private readonly overrides = new Map<string, { value: number | boolean; source: ParamSource }>();
  /** 当前箱体三围（`setHull` / `resetHull` 写入，`getHullState` 读）。 */
  private hull: typeof DEFAULT_HULL = { ...DEFAULT_HULL };
  /** 箱体来源（`setHull` 置 manual，`resetHull` 置 mode-default）。 */
  private hullSource: ParamSource = 'mode-default';
  /** 碰撞箱自动恢复开关（初值 true）。写路径是 `set-auto-restore-hull` 消息，读路径只进
   * `physics-snapshot`；`src/phys/` 内没有对应参数与读取点。 */
  autoRestoreHull = true;

  /** 绑定的权威 `PhysWorld`；未 `attach` 或显式传 null 时为 null。 */
  private phys: PhysWorld | null = null;

  /**
   * tickRate 变更回调（装配点 `apps/debug/src/worker/main.ts` 把它接到权威固定步长）。
   * 未装配时 `applyOverride` 与 `attach` 都不产生副作用。
   */
  onTickRateChange: ((rate: number) => void) | null = null;

  /** 绑定 PhysWorld 并重放覆盖：先按覆盖表组一次 `set_params` patch，再无条件 `set_hull`，最后补一次 tickRate 回调。 */
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
    // tickRate 不在 Rust 参数里：这里补一次回调，使面板在进图前调好的值
    // 覆盖 world-json 构建时按 config.physics.tickRate 设下的固定步长
    const tickRate = this.overrides.get('tickRate');
    if (tickRate) {
      this.onTickRateChange?.(tickRate.value as number);
    }
  }

  /** 手动设置参数（来源记 manual）：按 `ParamDef` 的 min/max 钳制后写覆盖表并立即下发；名字不在 `PARAM_DEFS` 里时直接返回。 */
  setParam(name: string, value: number | boolean): void {
    const def = findParamDef(name);
    if (!def) return;
    // 只钳制 number 型
    let v = value;
    if (def.kind === 'number' && typeof v === 'number') {
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
    }
    this.overrides.set(name, { value: v, source: 'manual' });
    this.applyOverride(name, v);
  }

  /** 以 map 来源写入覆盖（不钳制、不查 `PARAM_DEFS`）。本仓无调用点。 */
  setParamFromMap(name: string, value: number | boolean): void {
    this.overrides.set(name, { value, source: 'map' });
    this.applyOverride(name, value);
  }

  /** 恢复参数到 mode-default：给名字则删该条覆盖并回写定义默认值；不给名字则清空覆盖表并逐项回写默认值。 */
  resetParam(name?: string): void {
    if (name) {
      this.overrides.delete(name);
      this.applyOverride(name, findParamDef(name)?.default);
    } else {
      this.overrides.clear();
      for (const def of PARAM_DEFS) this.applyOverride(def.name, def.default);
    }
  }

  /** 设置碰撞箱三围（来源记 manual）并立即写 Rust。 */
  setHull(hull: typeof DEFAULT_HULL): void {
    this.hull = { ...hull };
    this.hullSource = 'manual';
    this.phys?.set_hull(hull.halfWidth, hull.standHeight, hull.duckHeight);
  }

  /** 恢复 `DEFAULT_HULL` 并写 Rust，来源回 mode-default。 */
  resetHull(): void {
    this.hull = { ...DEFAULT_HULL };
    this.hullSource = 'mode-default';
    this.phys?.set_hull(DEFAULT_HULL.halfWidth, DEFAULT_HULL.standHeight, DEFAULT_HULL.duckHeight);
  }

  /** 取碰撞箱状态（返回箱体副本，调用方改它不影响内部）。 */
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

  /** 按 `PARAM_DEFS` 顺序生成全量快照：有覆盖取覆盖值与来源，否则取定义默认值 + mode-default。 */
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
  // 内部实现
  // -------------------------------------------------------------------------

  /** 单点下发：tickRate 走回调；其余查 `PARAM_TO_RUST`，查不到则不下发。值为 undefined 时直接返回。 */
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
