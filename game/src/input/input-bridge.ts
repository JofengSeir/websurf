/**
 * 输入/配置桥（v7 恢复版）—— 面板参数双端同步：Worker（权威帧）+ 主线程（渲染物理）。
 *
 * 设计：
 * - **直接同步，无防抖/节流**：参数变更立即双端生效，不存在延迟窗口导致的双端参数分叉
 * - 灵敏度由**主线程输入层应用**（mousemove 时乘入角度增量，见 app.ts）；物理两端
 *   sensitivity 固定 1（buildPhysicsParams）→ 改灵敏度不产生双端参数差异 → 角度永不分叉
 * - mode（noclip）单独立即同步：不随 buildPhysicsParams 全量下发
 *   （否则每次改参数都会 set_noclip(false)，noclip 玩家被强退）
 */

import type { RuntimeConfig } from '../config.js';
import { applyConfigPatch, buildPhysicsParams } from '../config.js';
import type { RendererMain } from '../renderer/renderer-main.js';

export class InputBridge {
  constructor(
    private readonly worker: Worker,
    private readonly renderer: RendererMain,
    private readonly config: RuntimeConfig,
  ) {}

  /** 输入（SAB 输入槽：主线程渲染物理与 Worker 权威帧模拟同输入）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    void dx; void dy; void keysMask; // 输入由 RendererMain.tick 统一写 SAB
  }

  // ── 面板 → 双端物理（直接同步，双端同参）──────────────────

  sendConfig(section: keyof RuntimeConfig, patch: Record<string, unknown>): void {
    applyConfigPatch(this.config, section, patch);

    // mode（noclip 切换）：单独立即同步 Worker（低频操作）
    if (patch.mode !== undefined) {
      this.worker.postMessage({ type: 'config', section: 'physics', patch: { mode: patch.mode } });
    }

    if (section === 'player') {
      const p = this.config.player;
      const hull = { halfWidth: p.halfWidth, standHeight: p.standHeight, duckHeight: p.duckHeight };
      this.renderer.setPredictionHull(hull.halfWidth, hull.standHeight, hull.duckHeight);
      this.worker.postMessage({ type: 'config', section: 'player', patch: hull });
      return;
    }

    // physics/input：snake_case 全量（sensitivity 固定 1——真实灵敏度由主线程输入层应用）
    const params = buildPhysicsParams(this.config);
    // tickRate 是 JS 驱动层参数（不进 Rust set_params），必须显式带给 Worker——
    // Worker 用它驱动权威固定步长（fixedDt = 1/tickRate），否则改 64↔128 无效果
    if (section === 'physics') {
      params.tickRate = this.config.physics.tickRate;
    }
    this.renderer.setPredictionParams(params);
    this.worker.postMessage({ type: 'config', section, patch: params });
  }

  sendRespawn(): void {
    this.renderer.respawn();
    this.worker.postMessage({ type: 'respawn' });
  }

  sendTeleport(target: number): void {
    this.renderer.teleportToSpawn(target);
    this.worker.postMessage({ type: 'teleport', target });
  }

  /** 设置死亡 Y 阈值：本地预测物理 + Worker 权威物理双端同值（对齐 debug 桥模式）。 */
  sendSetDeathThreshold(value: number): void {
    this.renderer.setDeathY(value);
    // 权威侧同值下发：共享 dispatch（worker-dispatch.ts set-death-threshold）→
    // Rust set_death_y。缺此消息权威 death_y 恒为 Rust 默认 -100000，与主线程
    // 场景包围盒阈值不一致 → 双端死亡判定分叉。
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
