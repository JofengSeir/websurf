/**
 * 输入 / 配置桥：把面板参数同时写给本端 config 副本与 Worker 权威端。
 *
 * 设计：
 * - 直接同步，无防抖 / 节流：每次调用立即 patch 本端副本并 `postMessage`；
 * - 灵敏度由主线程输入层应用（`apps/game/src/app.ts` 的 mousemove 处理里乘入角度增量），
 *   物理参数里的 `sensitivity` 恒为 1（`src/ts-shared/phys/params.ts` 的
 *   `buildPhysicsParams` 写死）⇒ 改灵敏度不会让两端物理参数分叉；
 * - `mode`（noclip）单发一条只含 `mode` 的 `physics` 段消息，不随全量参数下发，避免改任何
 *   参数时都把 `set_noclip(false)` 写下去；
 * - 除 `player` 段外，下发的 `patch` 都是 `buildPhysicsParams(this.config)` 的**全量物理参数**
 *   （`section` 名原样保留），调用方传入的 patch 只用于更新本端副本，其效果经该全量参数带出。
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

  /** 占位方法：三个实参全部丢弃，不写任何通道。同源输入由
   *  `apps/game/src/renderer/renderer-main.ts` 的 `RendererMain.tick` 统一写共享槽
   *  （`shared.addInput`）；本工程内唯一调用点是 `apps/game/src/app.ts` 在 Pointer Lock
   *  状态变化时发的 `bridge?.addInput(0, 0, 0)`（清键位另有 `sharedState.addInput`）。 */
  addInput(dx: number, dy: number, keysMask: number): void {
    void dx; void dy; void keysMask; // 输入由 RendererMain.tick 统一写 SAB
  }

  // ── 面板 → 双端物理（直接同步，双端同参）──────────────────

  /** 面板参数下发。顺序固定：① 写本端 config 副本；② `patch` 带 `mode` 时单发一条只含
   *  `mode` 的 `physics` 段消息；③ `player` 段改走 `set_hull`（渲染端 `setPredictionHull`
   *  + `config` 消息的 `player` 段）并返回；④ 其余段构造全量物理参数，写渲染端
   *  （`setPredictionParams`）后以 `config` 消息发出（`physics` 段额外附加 `tickRate`，
   *  它是 JS 驱动层参数、不进 Rust `set_params`）。 */
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

    // 非 player 段：统一构造全量物理参数（sensitivity 固定 1——真实灵敏度由主线程输入层应用）
    const params = buildPhysicsParams(this.config);
    // tickRate 是 JS 驱动层参数（不进 Rust set_params），必须显式带给 Worker——
    // 权威固定步长由它折算（auth-loop 的 setFixedDt：1 / max(tickRate, 1) 秒），不带则步长不变
    if (section === 'physics') {
      params.tickRate = this.config.physics.tickRate;
    }
    this.renderer.setPredictionParams(params);
    this.worker.postMessage({ type: 'config', section, patch: params });
  }

  /** 重生：渲染端与权威端都回出生点。 */
  sendRespawn(): void {
    this.renderer.respawn();
    this.worker.postMessage({ type: 'respawn' });
  }

  /** 传送到权威出生点列表的第 `target` 项（渲染端与权威端同一索引）。 */
  sendTeleport(target: number): void {
    this.renderer.teleportToSpawn(target);
    this.worker.postMessage({ type: 'teleport', target });
  }

  /** 设置死亡 Y 阈值：渲染端 `setDeathY` + 权威端 `set-death-threshold` 消息双端同值。
   *  缺这条消息时权威端的 `death_y` 保持 `src/phys/mod.rs` 里的初值（极低的默认深渊），
   *  与渲染端按场景包围盒设定的阈值不一致，两端死亡判定随之分叉。 */
  sendSetDeathThreshold(value: number): void {
    this.renderer.setDeathY(value);
    // 权威侧同值下发：共享 dispatch 的 set-death-threshold 分支 → Rust set_death_y
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
