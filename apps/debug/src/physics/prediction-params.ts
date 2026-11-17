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
 * 2026-11-18 起走路/蹲走/自动连跳/连跳限速也来自 `config.physics`（默认值见
 * `src/ts-shared/phys/param-defaults.ts`），不再写死字面量：面板改了就会落到这里，
 * 主线程预测与权威 Worker 仍吃同一份参数。
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
      walkSpeed: p.walkSpeed,
      crouchSpeed: p.crouchSpeed,
      autobhop: p.autobhop,
      bhopSpeedClamp: p.bhopSpeedClamp,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
}
