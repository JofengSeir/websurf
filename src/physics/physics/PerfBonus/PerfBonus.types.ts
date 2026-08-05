/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
// Modified by WebSurf — see src/physics/NOTICE for modification details.


/**
 * 完美连跳速度继承：一次真实、技能时机的即时重跳（落地后下一 tick，仅手动输入）
 * 恢复落地时的精确水平速度，绕过 bhopSpeedClamp / 地面摩擦已削减的值。
 * 其它情况均不触发：
 *
 *  - `autobhop` 永不继承——按住跳的 autobhop 总是尽可能快地重发，与技能无关；
 *    若把它当"完美"处理，则每次连跳都恢复落地速度，bhopSpeedClamp 永远没机会
 *    真正压住速度。
 *  - 来自 surf 斜坡的落地（或离开斜坡后、下次真实落地前的飞行）也不触发——
 *    surf 速度不是能当完美连跳"兑现"的东西。
 *  - 晚于落地后下一 tick 的任何起跳不继承——近失不给部分折扣。
 *
 * 未命中时，起跳速度维持 `bhopSpeedClamp` 已算好的值。
 *
 * 单靠继承会在连跳链上无限叠加，不符合真实 chasemod 服务器的体感——玩家反馈
 * 空中速度从不超 `maxAirSpeed`（除非 surf，那是经斜坡几何的另一条物理路径）。
 * 因此 `enabled` 时，AirMove.ts 每空中 tick 将空中速度本身过一遍递减收益曲线
 * ——不只继承那一刻——逼近 `maxAirSpeed` 但永不达到。Surf（及离开斜坡后的
 * 飞行）完全豁免此压缩。
 */
export interface PerfSettings {
  enabled: boolean;
  maxAirSpeed: number; // 完美连跳空中速度逼近的渐近上限；nopre chasemod 服务器实测约 390
}
