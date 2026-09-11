/**
 * 出生点解析与初始视角回退（P2-4）。
 *
 * wasm 的 primary 只在存在 info_player_start 时指向真实玩家出生点，否则回落
 * 「实体序第 0 个 spawn 类实体」。地图实体区里 info_teleport_destination 普遍
 * 排在 info_player_* 之前，因此 surf_null 这类无 info_player_start 的地图初始
 * 视角会命中传送目标——实测 surf_null primary=taiikii_bonus_dest
 * (11264,−9600,5792)，距主出生区 26,200 HU，落在远离主场景的空域（P2-4）。
 *
 * 本模块是消费端统一回退（app 初始视角与地图面板 ★ 推荐标记共用，单点实现）。
 * 优先级（P2-4，2026-09）：
 *   1. spawn 实体：info_player_start 优先，其次按实体序首个 info_player_*
 *   2. 传送目标：首个在地图几何 bbox 内的 info_teleport_destination
 *      （bbox = GLB 几何包围盒；域外实体点判为空域，弃用）
 *   3. 兜底：无任何可用出生点 → 地图 bbox 中心高位俯瞰
 *      （水平居中、取 bbox 顶面高度、pitch −60°）
 *
 * 角度换算单点（spawnPointAng，初始视角与面板跳转共用）：
 *   yaw = wrap(src + 180)（与 pose.ts bspYawToCsYaw / .replay 实测定标同口径）；
 *   pitch = −src（Source 正值=俯视，viewer 正值=仰视）；限幅由 fly.setPose 统一处理。
 */
import { bspYawToCsYaw } from './pose.js';
import type { SpawnPoint } from './bsp.js';

/** 结构化 bbox（与 ui/mapinfo 的 WorldBox 同形；core 不反向依赖 ui）。 */
export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export type SpawnSource = 'player-start' | 'player-spawn' | 'teleport-dest' | 'bbox-vantage';

export interface ResolvedSpawn {
  /** 命中的出生点下标；bbox 兜底视角为 −1（列表无对应项）。 */
  index: number;
  /** 脚底位置（世界坐标）。 */
  pos: [number, number, number];
  /** [yaw, pitch]（度，viewer 约定）。 */
  ang: [number, number];
  source: SpawnSource;
}

const isPlayerStart = (p: SpawnPoint): boolean => p.classname === 'info_player_start';
const isPlayerSpawn = (p: SpawnPoint): boolean => p.classname.startsWith('info_player_');
const isTeleportDest = (p: SpawnPoint): boolean => p.classname === 'info_teleport_destination';

/** 出生点实体 Source 角 → viewer 角（两条消费路径共用：初始视角 / 面板跳转）。 */
export function spawnPointAng(sp: SpawnPoint): [number, number] {
  return [bspYawToCsYaw(sp.angles?.[1] ?? 0), -(sp.angles?.[0] ?? 0)];
}

/** bbox 中心高位俯瞰锚点：水平居中 + bbox 顶面高度（相机眼高另加）。 */
export function bboxVantagePos(box: Box3Like): [number, number, number] {
  return [(box.min[0] + box.max[0]) / 2, box.max[1], (box.min[2] + box.max[2]) / 2];
}

function inBox(o: readonly number[], box: Box3Like): boolean {
  return (
    o.length >= 3 &&
    o[0] >= box.min[0] &&
    o[0] <= box.max[0] &&
    o[1] >= box.min[1] &&
    o[1] <= box.max[1] &&
    o[2] >= box.min[2] &&
    o[2] <= box.max[2]
  );
}

function fromPoint(points: readonly SpawnPoint[], index: number, source: SpawnSource): ResolvedSpawn {
  const sp = points[index];
  const o = sp.origin ?? [];
  return { index, pos: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0], ang: spawnPointAng(sp), source };
}

/**
 * 解析初始视角（优先级见模块头注）。
 * points 为空且无 bbox → null（调用方保持当前视角不动）。
 */
export function resolveInitialSpawn(
  points: readonly SpawnPoint[],
  primaryHint: number,
  box: Box3Like | null,
): ResolvedSpawn | null {
  // 1a. wasm primary 若已是 info_player_start，直接用
  const hint = points[primaryHint];
  if (hint && isPlayerStart(hint)) return fromPoint(points, primaryHint, 'player-start');
  // 1b. 首个 info_player_start（防御：wasm primary 规则本应覆盖到）
  const startIdx = points.findIndex(isPlayerStart);
  if (startIdx >= 0) return fromPoint(points, startIdx, 'player-start');
  // 1c. 按实体序首个 info_player_*（真实玩家出生点优先于传送目标）
  const playerIdx = points.findIndex(isPlayerSpawn);
  if (playerIdx >= 0) return fromPoint(points, playerIdx, 'player-spawn');
  if (box) {
    // 2. 首个在几何 bbox 内的传送目标（域外空域弃用）
    const destIdx = points.findIndex((p) => isTeleportDest(p) && inBox(p.origin ?? [], box));
    if (destIdx >= 0) return fromPoint(points, destIdx, 'teleport-dest');
    // 3. 兜底：bbox 中心高位俯瞰
    return { index: -1, pos: bboxVantagePos(box), ang: [0, -60], source: 'bbox-vantage' };
  }
  return null;
}
