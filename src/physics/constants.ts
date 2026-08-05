/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.

// 数值单位 = Source 引擎单位（1 unit = 1 inch），与 CS:GO 实际 cvars 一致。
// 本项目为 Three.js Y-up：Source 的垂直 `z` 轴在此映射为 `y`。
//
// 仅跨行为共享的常量放这里；其余移入各自功能目录的 .config.ts。

// -- Cvars --------------------------------------------------------------
export const GRAVITY = 800; // sv_gravity，u/s²
export const RUN_SPEED = 250; // 刀/空手速度，实际最大值
export const WALK_SPEED = 130; // +speed（Shift）——固定值，非百分比
export const CROUCH_SPEED = 85; // ≈ CROUCH_SPEED_FACTOR × 250

// -- Movement mechanics ---------------------------------------------------
// StepMove / StayOnGround / TryPlayerMove / CategorizePosition 共用。
export const STANDABLE_NORMAL = 0.7; // normal.y >= 0.7（约 45.57°）即地面；更陡 = surf

// -- Simulation -------------------------------------------------------------
export const DEFAULT_TICK_RATE = 64;
export const MAX_FRAME_TIME = 0.1; // 钳制 rAF 帧间隔，避免螺旋死循环
