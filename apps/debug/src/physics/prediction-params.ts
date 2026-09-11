/**
 * debug `RuntimeConfig` → Rust `set_params` 全量参数（snake_case）。
 *
 * 抽出原因：输入录制需要把「录制那一刻的物理参数」写进 meta，回放时再原样写回；
 * 而参数来源就是这里（`debug/src/app.ts` 的 `buildPredictionParams` 与
 * `debug/src/worker/main.ts` 的 `buildPhysicsParams` 调用点共用同一份映射）。
 * 放在单独模块里，渲染器（`renderer-main.ts`）也能取到同一份，不必反向 import
 * `app.ts`（那会形成 app → renderer → app 的循环依赖）。
 *
 * 映射实现仍在 `src/ts-shared/phys/params.ts`（公共化 v1）：本文件只做
 * 「debug config 字段 → PhysicsParamsLike」的适配，字段来源见各处注释。
 */
import { buildPhysicsParams as sharedBuildPhysicsParams } from '../../../../src/ts-shared/phys/params.js';
import type { RuntimeConfig } from '../config.js';

/**
 * 构造主线程渲染物理实例/权威 Worker 用的全量参数对象。
 * 默认值对齐物理面板 PARAM_DEFS（与 Rust PhysParams::default 一致）；
 * 灵敏度固定 1（真实灵敏度由主线程输入层乘入，game 同法）。
 *
 * debug 没有独立的走路/蹲走配置项 → 取面板定义默认值（130/85，与 Worker
 * `PhysicsParams` 默认一致）。
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
      noPrestrafe: true,
      teleportGateTicks: p.teleportGateTicks,
    },
    {
      yawBindSpeed: config.input.yawBindSpeed,
      noclipSpeed: config.input.noclipSpeed,
    },
  );
}
