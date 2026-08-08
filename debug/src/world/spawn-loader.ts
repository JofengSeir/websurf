/**
 * 出生点加载器
 * 将 WASM parse_spawn_points 输出的 JSON 转换为 cs-movement 的 Vec3 出生坐标与初始 yaw。
 * 坐标已旋转为 Y-up（[x,y,z]→[y,z,x]），TS 端不再二次重映射。
 * yaw 转换（关键）：BSP yaw 为方位角（顺时针），cs-movement/Three.js yaw 为逆时针（从 +Y 向下看），
 * 旋转后 BSP +Y→TS +X、+X→+Z，故转换公式 cs_yaw = (270 - BSP_yaw) % 360。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import { type WasmSpawnReport, type WasmSpawnPoint } from './types.js';

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
// yaw 坐标系转换
// ---------------------------------------------------------------------------

/**
 * BSP yaw（方位角，顺时针）→ cs-movement yaw（逆时针）。
 * 公式：cs_yaw = (270 - BSP_yaw) % 360（推导见文件头）。
 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
}

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
      yaw: bspYawToCsYaw(sp.angles[1]), // BSP 顺时针 → cs-movement 逆时针
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
