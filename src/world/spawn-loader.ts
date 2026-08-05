/**
 * 出生点加载器
 *
 * 将 WASM `parse_spawn_points` 输出的 JSON 转换为 cs-movement 的 `Vec3` 出生坐标
 * 与初始 yaw 角度。坐标已在 Rust 端旋转为 Y-up（`[x,y,z]→[y,z,x]`），TS 端不再
 * 二次重映射。
 *
 * **yaw 转换（关键修复）**：
 * - BSP yaw 是方位角（compass bearing），顺时针增加（从 +Z 向下看）：
 *   yaw=0 → +Y（北），yaw=90 → +X（东），yaw=180 → -Y（南），yaw=270 → -X（西）
 * - 经 `[x,y,z]→[y,z,x]` 旋转后，BSP (X,Y,Z) → TS (Y,Z,X)，即：
 *   BSP +Y（北）→ TS +X，BSP +X（东）→ TS +Z，BSP -Y（南）→ TS -X，BSP -X（西）→ TS -Z
 * - 所以 BSP yaw 在 TS 中仍为顺时针（从 +Y 向下看 X-Z 平面）
 * - 但 cs-movement/Three.js 的 yaw 是逆时针（从 +Y 向下看）：
 *   yaw=0 → -Z，yaw=90 → -X，yaw=180 → +Z，yaw=270 → +X
 * - 转换公式：`cs_yaw = (270 - BSP_yaw) % 360`
 *   验证：BSP yaw=0（北/+X）→ cs yaw=270（+X）✓
 *         BSP yaw=90（东/+Z）→ cs yaw=180（+Z）✓
 *         BSP yaw=180（南/-X）→ cs yaw=90（-X）✓
 *         BSP yaw=270（西/-Z）→ cs yaw=0（-Z）✓
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
 * 将 BSP yaw（方位角，顺时针）转换为 cs-movement yaw（逆时针）。
 *
 * 公式：`cs_yaw = (270 - BSP_yaw) % 360`
 * 详见文件头注释的推导。
 */
function bspYawToCsYaw(bspYaw: number): number {
  return ((270 - bspYaw) % 360 + 360) % 360;
}

// ---------------------------------------------------------------------------
// 主加载函数
// ---------------------------------------------------------------------------

/**
 * 加载出生点数据。
 *
 * @param wasmJson `parse_spawn_points` 返回的 JSON 字符串。
 * @returns 出生点加载结果，包含推荐出生点 + 所有出生点列表。
 *
 * @example
 * ```typescript
 * const wasmJson = await processor.parse_spawn_points();
 * const { spawn, yaw } = loadSpawnPoints(wasmJson);
 * const player = new PlayerController(world, settings, spawn);
 * player.yaw = yaw;
 * ```
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
 *
 * @param wasmJson `parse_spawn_points` 返回的 JSON 字符串。
 * @param index 出生点索引。
 * @returns 出生坐标 + yaw，若索引无效则返回 null。
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
