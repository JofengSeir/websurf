/**
 * 主线程 → Worker 消息桥接。
 *
 * 阶段 2（权威帧计算器模式）：
 * - 输入不再经本桥：鼠标/按键增量由 renderer tick 统一写 SAB 输入槽
 *   （shared.addInput；MsgState 回退自动转 postMessage input 消息）。
 * - 其余低频控制（config/teleport/物理面板等）保持 postMessage。
 */
import type { RuntimeConfig } from '../config.js';

export class InputBridge {
  constructor(private readonly worker: Worker) {}

  /** 发送 init：共享内存（可 null）+ 画布尺寸（渲染在主线程）。 */
  sendInit(shared: SharedArrayBuffer | null, width: number, height: number, dpr: number): void {
    this.worker.postMessage({ type: 'init', shared, width, height, dpr });
  }

  /** 世界数据（主线程解析 BSP 后下发；Worker 构建权威 PhysWorld）。 */
  sendWorldJson(world: {
    brushJson: string;
    triJson: string;
    teleportJson: string;
    spawn: { x: number; y: number; z: number; yawDeg: number };
  }): void {
    this.worker.postMessage({ type: 'world-json', ...world });
  }

  /** 设置出生点列表（[[x,y,z,yaw], ...]，spawn 下拉切换用）。 */
  sendSetSpawnPoints(list: Array<[number, number, number, number]>): void {
    this.worker.postMessage({ type: 'set-spawn-points', json: JSON.stringify(list) });
  }

  // ── 低频控制消息 ──────────────────────────────────────────

  /** 发送配置部分更新。 */
  sendConfig(
    section: keyof RuntimeConfig,
    patch: Record<string, unknown>,
  ): void {
    this.worker.postMessage({ type: 'config', section, patch });
  }

  /** 发送重生请求（纯 Rust 重生；检查点回退由主线程 teleport-to-pos 完成）。 */
  sendRespawn(): void {
    this.worker.postMessage({ type: 'respawn' });
  }

  /** 发送 spawn 索引切换请求。 */
  sendTeleport(target: number): void {
    this.worker.postMessage({ type: 'teleport', target });
  }

  /** 传送到任意自定义坐标（自定义传送点面板/检查点回退）。yaw 缺省 = 保持当前朝向。 */
  sendTeleportToPos(pos: [number, number, number], yaw?: number): void {
    this.worker.postMessage({ type: 'teleport-to-pos', pos, yaw });
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

  /** 设置视距剔除距离（Worker 无剔除职责，协议兼容保留）。 */
  sendSetCullDistance(value: number): void {
    this.worker.postMessage({ type: 'set-cull-distance', value });
  }

  /** 设置掉落死亡阈值（主线程场景加载后回传 Worker）。 */
  sendSetDeathThreshold(value: number): void {
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
