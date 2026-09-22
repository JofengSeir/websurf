/**
 * 主线程 → Worker 的消息桥接：每个方法只做一次 `worker.postMessage`，一个方法对应一种 `type`。
 *
 * 逐帧输入不走本类：鼠标 / 按键增量由渲染帧写共享内存输入槽（`shared.addInput`），回退通道
 * 才由 `MsgState` 直接发 `input` 消息。本类只承载低频控制消息。
 *
 * 接收侧分两处：`init` / `world-json` / `config` / `respawn` / `set-spawn-points` / `teleport` /
 * `teleport-to-pos` / `set-death-threshold` 由 `src/ts-shared/auth/worker-dispatch.ts` 按 `type`
 * 分派；`set-physics-param` / `reset-physics-param` / `set-hull` / `reset-hull` /
 * `set-auto-restore-hull` 由 `apps/debug/src/worker/physics-worker.ts` 的 `handleMessage` 处理。
 * `sendSetCullDistance` 发的是 `set-cull-distance`，两处都没有分支，落到 `onExtraMessage` 后被丢弃。
 */
import type { RuntimeConfig } from '../config.js';

/** 消息桥：持一个 Worker 引用，不保存任何状态。 */
export class InputBridge {
  constructor(private readonly worker: Worker) {}

  /** 发 `init`：共享内存（可为 null，null 时 Worker 走消息回退通道）+ 画布尺寸与设备像素比。 */
  sendInit(shared: SharedArrayBuffer | null, width: number, height: number, dpr: number): void {
    this.worker.postMessage({ type: 'init', shared, width, height, dpr });
  }

  /** 发 `world-json`：主线程解析好的世界数据，Worker 据此构建权威 `PhysWorld`。 */
  sendWorldJson(world: {
    brushJson: string;
    triJson: string;
    teleportJson: string;
    spawn: { x: number; y: number; z: number; yawDeg: number };
  }): void {
    this.worker.postMessage({ type: 'world-json', ...world });
  }

  /** 发 `set-spawn-points`：出生点列表序列化成 JSON 字符串放进 `json` 字段。 */
  sendSetSpawnPoints(list: Array<[number, number, number, number]>): void {
    this.worker.postMessage({ type: 'set-spawn-points', json: JSON.stringify(list) });
  }

  // ── 低频控制消息 ──────────────────────────────────────────

  /** 发 `config`：配置部分更新。`section` 在接收侧按字符串比较，`patch` 为该段的浅合并对象。 */
  sendConfig(
    section: keyof RuntimeConfig,
    patch: Record<string, unknown>,
  ): void {
    this.worker.postMessage({ type: 'config', section, patch });
  }

  /** 发 `respawn`：Worker 侧重生到 `build_world` 给定的初始出生点。 */
  sendRespawn(): void {
    this.worker.postMessage({ type: 'respawn' });
  }

  /** 发 `teleport`：切到出生点列表的第 `target` 个。 */
  sendTeleport(target: number): void {
    this.worker.postMessage({ type: 'teleport', target });
  }

  /** 发 `teleport-to-pos`：传送到任意坐标（`pos` 为 Y-up 三元组，`yaw` 单位为度）。 */
  sendTeleportToPos(pos: [number, number, number], yaw?: number): void {
    this.worker.postMessage({ type: 'teleport-to-pos', pos, yaw });
  }

  /** 发 `set-physics-param`：单个物理面板参数的 `{name, value}`。 */
  sendSetPhysicsParam(name: string, value: number | boolean): void {
    this.worker.postMessage({ type: 'set-physics-param', name, value });
  }

  /** 发 `reset-physics-param`：`name` 省略时恢复全部参数。 */
  sendResetPhysicsParam(name?: string): void {
    this.worker.postMessage({ type: 'reset-physics-param', name });
  }

  /** 发 `set-hull`：碰撞箱三围（HU）整包下发。 */
  sendSetHull(hull: { halfWidth: number; standHeight: number; duckHeight: number }): void {
    this.worker.postMessage({ type: 'set-hull', hull });
  }

  /** 发 `reset-hull`：恢复默认碰撞箱。 */
  sendResetHull(): void {
    this.worker.postMessage({ type: 'reset-hull' });
  }

  /** 发 `set-auto-restore-hull`：碰撞箱自动恢复开关；Worker 只把它并入快照。 */
  sendSetAutoRestoreHull(enabled: boolean): void {
    this.worker.postMessage({ type: 'set-auto-restore-hull', enabled });
  }

  /** 发 `set-cull-distance`：本仓无接收分支（见文件头说明）。 */
  sendSetCullDistance(value: number): void {
    this.worker.postMessage({ type: 'set-cull-distance', value });
  }

  /** 发 `set-death-threshold`：掉落死亡阈值 Y，主线程在拿到场景信息后回传。 */
  sendSetDeathThreshold(value: number): void {
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
