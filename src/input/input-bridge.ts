/**
 * 主线程 → Worker 消息桥接。
 *
 * 将输入状态、配置更新、窗口尺寸、重生/传送请求、加载场景等
 * 通过 postMessage 发送到 Worker。消息类型对应 worker-types.ts 的 WorkerMessage。
 *
 * ArrayBuffer 类字段通过 transfer list 零拷贝传递，调用后主线程引用将被 detach。
 */

import type { RuntimeConfig } from '../config.js';
import type { KeyState } from '../worker/worker-types.js';

export class InputBridge {
  constructor(private readonly worker: Worker) {}

  /** 发送 init 消息：传递 OffscreenCanvas 给 Worker。 */
  sendInit(
    canvas: OffscreenCanvas,
    width: number,
    height: number,
    dpr: number,
  ): void {
    this.worker.postMessage({ type: 'init', canvas, width, height, dpr }, [canvas]);
  }

  /** 发送 BSP 原始字节到 Worker（Worker 内解析；transfer 后主线程 data 被 detach）。 */
  sendLoadBsp(name: string, data: ArrayBuffer): void {
    this.worker.postMessage({ type: 'load-bsp', name, data }, [data]);
  }

  /** 发送输入状态（按键 + 鼠标增量）到 Worker，每帧调用。 */
  sendInput(keys: KeyState, mouseDx: number, mouseDy: number): void {
    this.worker.postMessage({ type: 'input', keys, mouseDx, mouseDy });
  }

  /** 发送配置部分更新。 */
  sendConfig(
    section: keyof RuntimeConfig,
    patch: Record<string, unknown>,
  ): void {
    this.worker.postMessage({ type: 'config', section, patch });
  }

  /** 发送窗口尺寸变化。 */
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
}
