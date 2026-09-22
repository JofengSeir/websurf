/**
 * debug 侧 `RuntimeConfig` → Rust `set_params` 全量参数（snake_case，共 15 个键）。
 *
 * 映射实现是 `src/ts-shared/phys/params.ts` 的 `buildPhysicsParams`（恒返回全量键，
 * `jump_height` 由 `jumpSpeed` 反算，`sensitivity` 写死为 1）；本文件只把 debug 的 config
 * 字段摊成它的入参。
 *
 * 消费点两处，取的必须是同一份结果：
 * - `apps/debug/src/renderer/renderer-main.ts` 的 `captureReplayState` 把它随录制快照一起存；
 * - `apps/debug/src/app.ts` 的 `buildPredictionParams`（`buildPredictionWorld` 用同一份喂
 *   主线程渲染物理实例）。
 *
 * debug 没有独立的走路 / 蹲走配置项：`walkSpeed` / `crouchSpeed` 写死 130 / 85，
 * `autobhop` 与 `bhopSpeedClamp` 写死 true，与 `PARAM_DEFS` 的定义默认值一致。
 */
import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../../../src/ts-shared/phys/params.js';
import type { RuntimeConfig } from '../config.js';

/**
 * 构造全量参数对象（主线程渲染物理实例与权威 Worker 同参）。
 * `yawBindSpeed` / `noclipSpeed` 取自 `config.input`，其余取自 `config.physics`。
 */
export function buildDebugPredictionParams(config: RuntimeConfig): Record<string, unknown> {
  const p = config.physics;
  return sharedBuildPhysicsParams(
    {
      gravity: p.gravity,
      accelerate: p.accelerate,
      friction: p.friction,
      stopSpeed: p.stopSpeed,
      jumpSpeed: p.jumpSpeed,
      airAccel: p.airAccel,
      maxSpeed: p.maxSpeed,
      // debug 无独立走路/蹲走配置：取面板定义默认值（与 Worker PhysicsParams 默认一致）
      walkSpeed: 130,
      crouchSpeed: 85,
      autobhop: true,
      bhopSpeedClamp: true,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
}
