/**
 * WebSurf — Worker 物理协调器（阶段 2 缩减版：权威帧计算器模式）
 *
 * 阶段 2 架构：权威世界与固定步长循环在 main.ts（game 模式自驱 dispatch），
 * 本类只保留物理控制面板职责：
 * - 物理参数/碰撞箱（PhysicsParams → Rust set_params/set_hull → 权威 phys）
 * - physics-snapshot 回传（面板渲染；主线程 renderPhysicsSnapshot 同步镜像到
 *   渲染物理 predPhys —— 双端同参）
 *
 * 已删除（阶段 1/2 主线程本地化）：handleLoadBsp（BSP 解析/GLB 导出移主线程）、
 * handleFrame/physicsLoop（frame 信号驱动删除，改 setTimeout 4ms 自驱）、
 * stats/game-stats/player-pos 回传（HUD/计时挑战/自定义传送点保存位置均主线程本地）。
 */

import { PhysicsParams } from '../physics/physics-params.js';
import type { PhysWorld } from '../../pkg/websurf_wasm.js';
import type { MainMessage, WorkerMessage } from './worker-types.js';

/**
 * Worker 物理面板协调器。
 */
export class PhysicsWorker {
  private readonly physicsParams = new PhysicsParams();
  private phys: PhysWorld | null = null;

  /** tickRate 变更 → 权威固定步长（main.ts 注入）。 */
  get params(): PhysicsParams {
    return this.physicsParams;
  }

  /**
   * 绑定权威 PhysWorld（main.ts world-json 构建后调用）：
   * 应用已存在的面板覆盖 + 回传一次快照（主线程镜像到渲染物理）。
   */
  attachWorld(phys: PhysWorld | null): void {
    this.phys = phys;
    this.physicsParams.attach(phys);
    this.emitPhysicsSnapshot();
  }

  /**
   * 重新应用面板覆盖（main.ts config 消息全量 set_params/set_hull 后调用，
   * 防全量参数覆盖掉面板手动值——"参数覆盖 > 配置默认"）。
   */
  reapplyParams(): void {
    this.physicsParams.attach(this.phys);
  }

  /** 物理面板消息入口（返回是否已处理）。 */
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
  // 内部
  // -------------------------------------------------------------------------

  /** 回传物理参数快照（面板渲染；参数/碰撞箱变更后调用）。 */
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

  /** 发送消息到主线程。 */
  private postMessage(msg: MainMessage): void {
    const pm = postMessage as (m: MainMessage) => void;
    pm(msg);
  }
}
