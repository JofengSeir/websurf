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
import type { SavePoint } from '../savepoint.js';
import type { SetHoldMessage, SetModeMessage } from '../worker/worker-types.js';

/** 解耦模式 hold 冻结载荷（renderer.setHoldPoint 同形；C 键按住）。 */
type HoldPose = { x: number; y: number; z: number; yaw: number; pitch: number; onGround: boolean };

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
    // 解耦模式：预测实例停 tick，跳过本地 respawn（worker 双实例重置为真理源，
    // §3.4.E；耦合维持 v7——主线程预测 respawn + worker 同步）
    if (this.config.physics.computeMode === 'coupled') this.renderer.respawn();
    this.worker.postMessage({ type: 'respawn' });
  }

  sendTeleport(target: number): void {
    // 同 sendRespawn：解耦跳过本地预测传送（worker 权威传送 → 解耦帧拉主线程）
    if (this.config.physics.computeMode === 'coupled') this.renderer.teleportToSpawn(target);
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

  // ── 双模式热切（phys-mode-port §3.4.C 主线程发起侧）────────────

  /** 计算模式热切（面板 → 这里 → worker）：
   * ① config.physics.computeMode 落字段（声明性元数据，§3.4.D——面板持久化
   *    与采样读法的门；不绕过握手切换）；
   * ② coupled→decoupled：快照 predPhys 全态（SyncRenderState）随消息（§3.4.A
   *    必带；无预测实例——解耦自启动——则省略 state，worker 用自己初始态）+
   *    暂停预测线（门控 T2-T6 + 清待喂输入）；
   * ③ decoupled→coupled：仅发消息；ack 后 renderer.handleModeAck 恢复预测线。
   * 500ms 超时重发一次 / 再超时回滚：renderer 内部（onSetModeResend/onModeSwitchFailed）。 */
  sendSetMode(mode: 'coupled' | 'decoupled'): void {
    // t12 F2 在途守卫（captain 裁决「必须补」）：pending ack 期间禁止二次发送——
    // 与 500ms 超时重发协同（重发走 resendSetMode 不经此口）；面板控件在途禁用
    // 为第一道防线，此为程序化路径兜底。启动自启动窗口 pendingMode=null 放行 ✓
    if (this.renderer.hasPendingModeSwitch()) return;
    applyConfigPatch(this.config, 'physics', { computeMode: mode });
    const msg: SetModeMessage = { type: 'set-mode', mode };
    if (mode === 'decoupled') {
      const state = this.renderer.buildHandoverState();
      this.renderer.enterDecoupledSwitch();
      if (state) msg.state = state;
    } else {
      this.renderer.enterCoupledSwitch();
    }
    this.worker.postMessage(msg);
  }

  /** 热切超时重发（renderer.onSetModeResend 转发；仅重发消息，不重复门控）。 */
  resendSetMode(mode: 'coupled' | 'decoupled'): void {
    const msg: SetModeMessage = { type: 'set-mode', mode };
    if (mode === 'decoupled') {
      const state = this.renderer.buildHandoverState();
      if (state) msg.state = state;
    }
    this.worker.postMessage(msg);
  }

  /** 解耦模式 C 键 hold：worker 侧执行（§3.4.A set-hold）。
   * hold 非空 = 注入冻结（位置/朝向=存点、速度 0，同 renderer.setHoldPoint 语义）；
   * release 非空 = 解除冻结并全量恢复存点（同 renderer.releaseHoldPoint →
   * loadSavepoint 语义：9 字段 set_state + 采样器/增量对齐，t10 侧）。 */
  sendSetHold(hold: HoldPose | null, release?: SavePoint): void {
    const msg: SetHoldMessage = { type: 'set-hold', hold, ...(release ? { release } : {}) };
    this.worker.postMessage(msg);
  }
}
