/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

/**
 * 单次 TryPlayerMove 内累积的接触平面上限。
 *
 * 默认 5 在密集接缝区（surf 坡 = TriMesh 三角网格，每三角形 5 平面，
 * 高速扫掠一 tick 触及 3-6 个三角形边/面平面）会过早触发"超限归零"。
 * 提升到 8 给折角/平均法线逻辑更多机会；8 以上基本表示真实围角死锁，
 * 仍由多平面归零兜底。
 */
export const MAX_CLIP_PLANES = 8;

/**
 * 撞击后沿法线推开的距离（单位）。
 *
 * surf 滑行时玩家 AABB 表面持续停留在距坡面 DIST_EPSILON(0.03125) 处，
 * 每 tick 重力注入垂直分量 → trace 在 fraction≈0 处撞击 → origin 不更新
 * （移动量 ≈0）→ BlockedMove 判定"冻结"归零（卡坡）。
 * 撞击后推开 PUSH_OUT 让玩家脱离贴面位置：下一 tick 有正常"进入距离"，
 * 切向滑行不再被 fraction≈0 微撞击吞掉（Source/Quake 的 hitpos 惯例）。
 */
export const PUSH_OUT = 0.1;
