/**
 * 主线程 → Worker 消息桥接。
 *
 * 输入通道重构（共享内存架构）：
 * - 共享内存模式：鼠标增量/按键写入 SharedState（SharedArrayBuffer + Atomics），
 *   每帧仅发轻量 `frame` 信号（携带主线程时间戳）。
 * - 回退模式：SharedState 内部走 postMessage（MsgStateMain）。
 * 其余低频控制（config/resize/teleport/物理面板等）保持 postMessage。
 */

import type { RuntimeConfig } from '../config.js';
import type { FrameSnapshot } from '../worker/worker-types.js';
import type { SharedState } from '../worker/shared-state.js';

export class InputBridge {
  constructor(
    private readonly worker: Worker,
    private readonly shared: SharedState,
  ) {}

  /** 发送 init 消息：共享内存（可 null）+ 画布尺寸（渲染在主线程）。 */
  sendInit(shared: SharedArrayBuffer | null, width: number, height: number, dpr: number): void {
    this.worker.postMessage({ type: 'init', shared, width, height, dpr });
  }

  /** 发送 BSP 原始字节到 Worker（Worker 内解析；transfer 后主线程 data 被 detach）。 */
  sendLoadBsp(name: string, data: ArrayBuffer): void {
    this.worker.postMessage({ type: 'load-bsp', name, data }, [data]);
  }

  // ── 输入通道（共享内存 / 回退）────────────────────────────

  /** 写入鼠标增量 + 按键位掩码（阶段一：极速输入，主线程专属）。 */
  setInput(dx: number, dy: number, keysMask: number): void {
    this.shared.setInput(dx, dy, keysMask);
  }

  /** 仅更新按键位掩码。 */
  setKeys(keysMask: number): void {
    this.shared.setKeys(keysMask);
  }

  /** 每帧发送 frame 触发信号（无数据负载；物理 dt 由 Worker 侧 performance.now() 计算）。 */
  sendFrame(): void {
    this.worker.postMessage({ type: 'frame' });
  }

  /** 安全读取物理快照（阶段三：安全检查 + LERP 插值）。 */
  readFrame(): FrameSnapshot | null {
    return this.shared.readFrame();
  }

  /** 回退模式：缓存 Worker 回传的物理帧。 */
  setCachedFrame(frame: FrameSnapshot): void {
    if ('setCachedFrame' in this.shared) {
      (this.shared as { setCachedFrame(f: FrameSnapshot): void }).setCachedFrame(frame);
    }
  }

  // ── 低频控制消息 ──────────────────────────────────────────

  /** 发送配置部分更新。 */
  sendConfig(
    section: keyof RuntimeConfig,
    patch: Record<string, unknown>,
  ): void {
    this.worker.postMessage({ type: 'config', section, patch });
  }

  /** 发送窗口尺寸变化（Worker 物理无需尺寸，保留协议兼容）。 */
  sendResize(width: number, height: number): void {
    this.worker.postMessage({ type: 'resize', width, height });
  }

  /** 发送重生请求。 */
  sendRespawn(): void {
    this.worker.postMessage({ type: 'respawn' });
  }

  /** 发送 spawn 索引切换请求。 */
  sendTeleport(target: number): void {
    this.worker.postMessage({ type: 'teleport', target });
  }

  /** 传送到任意自定义坐标（自定义传送点面板）。yaw 缺省 = 保持当前朝向。 */
  sendTeleportToPos(pos: [number, number, number], yaw?: number): void {
    this.worker.postMessage({ type: 'teleport-to-pos', pos, yaw });
  }

  /** 请求玩家当前位置（Worker 回传 player-pos 消息）。 */
  sendGetPlayerPos(): void {
    this.worker.postMessage({ type: 'get-player-pos' });
  }

  /** 设置物理模式。 */
  sendSetPhysicsMode(mode: 'noclip' | 'physics'): void {
    this.worker.postMessage({ type: 'set-physics-mode', mode });
  }

  /** 设置物理参数（物理控制面板）。 */
  sendSetPhysicsParam(name: string, value: number | boolean): void {
    this.worker.postMessage({ type: 'set-physics-param', name, value });
  }

  /** 恢复物理参数到 mode-default（缺省 = 全部）。 */
  sendResetPhysicsParam(name?: string): void {
    this.worker.postMessage({ type: 'reset-physics-param', name });
  }

  /** 设置碰撞箱体型（立即生效）。 */
  sendSetHull(hull: { halfWidth: number; standHeight: number; duckHeight: number }): void {
    this.worker.postMessage({ type: 'set-hull', hull });
  }

  /** 恢复默认碰撞箱。 */
  sendResetHull(): void {
    this.worker.postMessage({ type: 'reset-hull' });
  }

  /** 碰撞箱自动恢复开关。 */
  sendSetAutoRestoreHull(enabled: boolean): void {
    this.worker.postMessage({ type: 'set-auto-restore-hull', enabled });
  }

  /** 设置视距剔除距离。 */
  sendSetCullDistance(value: number): void {
    this.worker.postMessage({ type: 'set-cull-distance', value });
  }

  /** 设置掉落死亡阈值（主线程场景加载后回传 Worker）。 */
  sendSetDeathThreshold(value: number): void {
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
