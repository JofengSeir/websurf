/**
 * 出生点加载器（坐标 / yaw 转换的参考实现）。
 *
 * 输入是 WASM `parse_spawn_points` 输出的 JSON，输出为 cs-movement 口径的出生坐标与初始 yaw：
 * 坐标已按 [x,y,z] → [y,z,x] 旋转为 Y-up，TS 端不再二次重映射。
 *
 * yaw：直接调 `bspYawToCsYaw`（角度换算的 TS 侧唯一实现，见 `src/ts-shared/phys/angles.ts`）。
 * 该轴映射是 det = +1 的循环置换，Source 前向 (cos yaw, sin yaw) 置换后成为 (sin yaw, cos yaw)，
 * 而消费端 yaw = 0 对应的前向是 (−sin, −cos)，两者相差恰好 180°——故换算为加 180° 后归一到 [0, 360)。
 *
 * ⚠ 零调用点（预留参考实现）：全仓无模块 import 本文件；出生点加载的实际链路是共享层
 * `src/ts-shared/phys/world-builder.ts` 消费 `parse_spawn_points` 的 JSON。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import { type WasmSpawnReport, type WasmSpawnPoint } from './types.js';
import { bspYawToCsYaw } from '../../../../src/ts-shared/phys/angles.js';

// ---------------------------------------------------------------------------
// 加载结果
// ---------------------------------------------------------------------------

/** 出生点加载结果。 */
export interface SpawnLoadResult {
  /** 出生坐标（Y-up，Source 单位）。 */
  spawn: Vec3;
  /** 初始 yaw 角度（度，0 = 朝 -Z）。 */
  yaw: number;
  /** 推荐的出生点索引。 */
  primary: number;
  /** 所有出生点列表（供 UI 切换）。 */
  allSpawnPoints: LoadedSpawnPoint[];
}

/** 单个出生点（已转换）。 */
export interface LoadedSpawnPoint {
  /** classname（如 `info_player_start`）。 */
  classname: string;
  /** 出生坐标（Y-up）。 */
  origin: Vec3;
  /** yaw 角度（度）。 */
  yaw: number;
  /** 原始 angles（BSP `[pitch, yaw, roll]`）。 */
  angles: [number, number, number];
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/** 无出生点时的默认坐标（原点上方 100 HU）。 */
const DEFAULT_SPAWN: Vec3 = { x: 0, y: 100, z: 0 };
const DEFAULT_YAW = 0;

// ---------------------------------------------------------------------------
// 主加载函数
// ---------------------------------------------------------------------------

/**
 * 加载出生点数据。
 * @param wasmJson parse_spawn_points 返回的 JSON 字符串。
 * @returns 出生点加载结果，包含推荐出生点 + 所有出生点列表。
 */
export function loadSpawnPoints(wasmJson: string): SpawnLoadResult {
  const data: WasmSpawnReport = JSON.parse(wasmJson);

  // 无出生点：返回默认值
  if (!data.spawn_points || data.spawn_points.length === 0) {
    return {
      spawn: { ...DEFAULT_SPAWN },
      yaw: DEFAULT_YAW,
      primary: -1,
      allSpawnPoints: [],
    };
  }

  // 转换所有出生点
  const allSpawnPoints: LoadedSpawnPoint[] = data.spawn_points.map(
    (sp: WasmSpawnPoint) => ({
      classname: sp.classname,
      origin: { x: sp.origin[0], y: sp.origin[1], z: sp.origin[2] },
      yaw: bspYawToCsYaw(sp.angles[1]), // 角度换算唯一实现：src/ts-shared/phys/angles.ts
      angles: sp.angles,
    }),
  );

  // 选择推荐出生点
  const primaryIdx = data.primary ?? 0;
  const primary = allSpawnPoints[primaryIdx] ?? allSpawnPoints[0];

  return {
    spawn: { ...primary.origin },
    yaw: primary.yaw,
    primary: primaryIdx >= 0 ? primaryIdx : 0,
    allSpawnPoints,
  };
}

/**
 * 从指定出生点索引获取坐标。
 * @param wasmJson parse_spawn_points 返回的 JSON 字符串。
 * @param index 出生点索引。
 * @returns 出生坐标 + yaw，索引无效则返回 null。
 */
export function getSpawnPointByIndex(
  wasmJson: string,
  index: number,
): { spawn: Vec3; yaw: number } | null {
  const data: WasmSpawnReport = JSON.parse(wasmJson);
  const sp = data.spawn_points[index];
  if (!sp) {
    return null;
  }
  return {
    spawn: { x: sp.origin[0], y: sp.origin[1], z: sp.origin[2] },
    yaw: bspYawToCsYaw(sp.angles[1]),
  };
}
