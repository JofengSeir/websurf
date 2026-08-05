/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.


/**
 * CS2 式耐力池：跳跃/落地累加 `max` 的比例，随时间恢复；耐力较高时同时抑制
 * 最大地速与起跳速度。Valve 未公开其精确公式（sv_staminajumpcost /
 * sv_staminalandcost / sv_staminamax），故为可调近似而非经核实的游戏精确值。
 * 默认关闭——所有现有预设（含 perf 连跳模式）均在不启用状态下游玩，
 * 与把成本清零的服务器一致。
 */
export interface StaminaSettings {
  enabled: boolean;
  max: number;
  jumpCost: number; // 每次跳跃增加 max 的比例
  landCost: number; // 每次落地增加 max 的比例
  recoveryRate: number; // 每秒恢复 max 的比例
  maxPenalty: number; // 满池时速度/起跳速度的削减比例（0..1）
}
