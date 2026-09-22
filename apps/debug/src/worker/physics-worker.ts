/**
 * Worker 物理控制面板协调器（`PhysicsWorker`）。
 *
 * 本类只承担「物理控制面板」这一条链路；权威物理的推进与发布由
 * `src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop` 独立承担。三件事：
 * - 持有 `PhysicsParams`（面板数据源与执行层）：参数写权威 `PhysWorld.set_params`、
 *   碰撞箱写 `set_hull`；`tickRate` 属 JS 驱动层参数，`PhysicsParams.applyOverride`
 *   对它改走 `onTickRateChange` 回调而不写 Rust，由 `apps/debug/src/worker/main.ts`
 *   接到权威固定步长；
 * - 接收主线程的面板消息 `set-physics-param` / `reset-physics-param` / `set-hull` /
 *   `reset-hull` / `set-auto-restore-hull`，每条处理完立即回传一次 `physics-snapshot`；
 * - `physics-snapshot` 的消费方是 `apps/debug/src/app.ts` 的 `renderPhysicsSnapshot`：
 *   回填面板控件，并经同文件的 `mirrorSnapshotToPrediction` 把同一份参数镜像到主线程
 *   渲染物理（双端同参）。
 *
 * 装配点（全仓唯一实例）：`apps/debug/src/worker/main.ts` 的 `physicsWorker`。
 * `createWorkerDispatch` 的三个钩子分别调本类——`onWorldBuilt` → `attachWorld`、
 * `onConfigApplied` → `reapplyParams`、`onExtraMessage` → `handleMessage`。
 */

import { PhysicsParams } from '../physics/physics-params.js';
import type { PhysWorld } from '../../pkg/websurf_wasm.js';
import type { MainMessage, WorkerMessage } from './worker-types.js';

/**
 * Worker 侧物理面板协调器：参数/碰撞箱的变更写进权威实例，并把面板快照回传主线程。
 */
export class PhysicsWorker {
  private readonly physicsParams = new PhysicsParams();
  /** 权威实例槽；未收到 `world-json`（或已解绑）时为 `null`。 */
  private phys: PhysWorld | null = null;

  /** 面板参数管理器（`apps/debug/src/worker/main.ts` 经它挂 `onTickRateChange`）。 */
  get params(): PhysicsParams {
    return this.physicsParams;
  }

  /**
   * 绑定权威 `PhysWorld`（`onWorldBuilt` 钩子传入，可为 `null`）：
   * 写实例槽 → `PhysicsParams.attach` 重放已存在的面板覆盖（含 tickRate 回调）→
   * 回传一次快照。
   */
  attachWorld(phys: PhysWorld | null): void {
    this.phys = phys;
    this.physicsParams.attach(phys);
    this.emitPhysicsSnapshot();
  }

  /**
   * 重放面板覆盖（`onConfigApplied` 钩子调用）：`config` 消息已把全量配置参数写成权威
   * 参数，此处再写一遍面板手动值、碰撞箱与面板 tickRate，使面板值优先于配置默认值。
   */
  reapplyParams(): void {
    this.physicsParams.attach(this.phys);
  }

  /**
   * 面板消息入口：命中下面五个 `case` 之一则处理后返回 `true`；`msg` 非对象、或 `type`
   * 不在这五个之内（例如分发层没有分支、直接落到本入口的 `set-cull-distance`）返回
   * `false`。返回值在唯一调用点 `src/ts-shared/auth/worker-dispatch.ts` 的
   * `onExtraMessage` 处未被使用。
   */
  handleMessage(msg: WorkerMessage | { type?: string }): boolean {
    if (!msg || typeof msg !== 'object') return false;
    switch (msg.type) {
      case 'set-physics-param': {
        const m = msg as { name: string; value: number | boolean };
        this.physicsParams.setParam(m.name, m.value);
        this.emitPhysicsSnapshot();
        return true;
      }
      case 'reset-physics-param': {
        const m = msg as { name?: string };
        this.physicsParams.resetParam(m.name);
        this.emitPhysicsSnapshot();
        return true;
      }
      case 'set-hull': {
        const m = msg as { hull: { halfWidth: number; standHeight: number; duckHeight: number } };
        this.physicsParams.setHull(m.hull);
        this.emitPhysicsSnapshot();
        return true;
      }
      case 'reset-hull': {
        this.physicsParams.resetHull();
        this.emitPhysicsSnapshot();
        return true;
      }
      case 'set-auto-restore-hull': {
        const m = msg as { enabled: boolean };
        this.physicsParams.autoRestoreHull = m.enabled;
        this.emitPhysicsSnapshot();
        return true;
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * 回传 `physics-snapshot`：参数表逐项只留 name/value/source（label、单位与取值范围
   * 留在主线程 `apps/debug/src/physics/param-defs.ts` 的 `PARAM_DEFS`），另附碰撞箱
   * 三项 + 来源 + 是否默认，以及自动恢复开关。
   */
  private emitPhysicsSnapshot(): void {
    const snapshot = this.physicsParams.snapshot();
    const hullState = this.physicsParams.getHullState();
    this.postMessage({
      type: 'physics-snapshot',
      params: snapshot.map((p) => ({ name: p.name, value: p.value, source: p.source })),
      hull: {
        halfWidth: hullState.hull.halfWidth,
        standHeight: hullState.hull.standHeight,
        duckHeight: hullState.hull.duckHeight,
        source: hullState.source,
        isDefault: hullState.isDefault,
      },
      autoRestoreHull: this.physicsParams.autoRestoreHull,
    });
  }

  /** 发往主线程：把 worker 全局 `postMessage` 收窄成 `MainMessage` 的类型化包装。 */
  private postMessage(msg: MainMessage): void {
    const pm = postMessage as (m: MainMessage) => void;
    pm(msg);
  }
}
