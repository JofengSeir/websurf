/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

export const HULL_HALF_WIDTH = 16; // 32x32 footprint
export const HULL_STAND_HEIGHT = 72;
export const HULL_DUCK_HEIGHT = 54;
export const EYE_STAND = 64.09;
export const EYE_DUCK = 46.04;
export const DUCK_LERP_TIME = 0.2; // seconds, eye-height transition

/**
 * 玩家碰撞箱配置（物理控制面板的可调项，基准 = CS:S 默认体型）。
 *
 * 基准数据（Valve Developer Wiki — Dimensions (HL2 & CS:S)）：
 * - 站立碰撞箱：32×32×72 units（mins = ±16 footprint，高 72）
 * - 蹲下碰撞箱：32×32×36 units（cs-movement fork 采用 54，见下）
 * - 视角高度：站立 64、蹲下 ~46（cs-movement 采用 64.09 / 46.04 实测值）
 *
 * 说明：本项目为 cs-movement fork，蹲下高度 54（而非原版 36）是 fork 的既有
 * 行为选择（KZ/surf 社区常见），面板默认值与之一致，可调回 36 匹配原版 CS:S。
 */
export interface HullConfig {
  /** 碰撞箱半宽（footprint = halfWidth×2 见方；默认 16 → 32×32）。 */
  halfWidth: number;
  /** 站立碰撞箱高度（默认 72）。 */
  standHeight: number;
  /** 蹲下碰撞箱高度（默认 54，fork 行为；原版 CS:S 为 36）。 */
  duckHeight: number;
}

/** 默认碰撞箱（CS:S 基准 + cs-movement fork 蹲高）。 */
export const DEFAULT_HULL: HullConfig = {
  halfWidth: HULL_HALF_WIDTH,
  standHeight: HULL_STAND_HEIGHT,
  duckHeight: HULL_DUCK_HEIGHT,
};

/** 判断 hull 是否等于默认体型（自动恢复用）。 */
export function isDefaultHull(h: HullConfig): boolean {
  return (
    h.halfWidth === DEFAULT_HULL.halfWidth &&
    h.standHeight === DEFAULT_HULL.standHeight &&
    h.duckHeight === DEFAULT_HULL.duckHeight
  );
}

/** 按 hull 缩放后的站立视角高度（64.09 × standHeight/72）。 */
export function eyeStandFor(hull: HullConfig): number {
  return EYE_STAND * (hull.standHeight / DEFAULT_HULL.standHeight);
}

/** 按 hull 缩放后的蹲下视角高度（46.04 × duckHeight/54）。 */
export function eyeDuckFor(hull: HullConfig): number {
  return EYE_DUCK * (hull.duckHeight / DEFAULT_HULL.duckHeight);
}
