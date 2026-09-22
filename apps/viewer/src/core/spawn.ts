/**
 * 出生点解析与初始视角回退（viewer 消费端的单点实现）。
 *
 * 输入与来源：
 * - `points` / `primaryHint` 来自 `apps/viewer/src/core/bsp.ts` 的 `BspLoadResult`：
 *   `spawnPoints` 是 wasm `parse_spawn_points` 的 JSON 产物，只含 `info_player_*` 与
 *   `info_teleport_destination` 两类实体；`primaryHint` 由 `apps/viewer/crates/wasm/src/lib.rs` 的 `parse_spawn_points` 给出（有 `info_player_start` 时是它的下标，否则回落 0）；
 * - `box` 来自 `ViewerScene.worldBox()`（GLB 几何包围盒），由 `apps/viewer/src/app.ts` 的
 *   `loadBsp` 转成 `Box3Like` 传入。
 *
 * 优先级（自上而下，命中即返回）：
 * 1. `info_player_start`：先看 primary 下标指向的实体，否则扫实体序里第一个；
 * 2. 实体序里第一个 `info_player_*`（`source` = `player-spawn`）；
 * 3. 几何 bbox 内的第一个 `info_teleport_destination`（`source` = `teleport-dest`）；
 * 4. 兜底为 bbox 中心高位俯瞰（`source` = `bbox-vantage`，`index` 置 −1：出生点列表里
 *    没有对应条目）。
 * `box` 为 null 时第 3、4 步都不执行，直接返回 null，调用方保持当前视角不动。
 *
 * 两处消费共用本模块，避免初始视角与面板 ★ 标记各判一次：
 * - `apps/viewer/src/app.ts` 的 `applyInitialPose`（本次地图的初始视角）；
 * - `apps/viewer/src/ui/mapinfo.ts` 的 `renderSpawns`（★ 推荐标记与「跳转」按钮）。
 *
 * 角度换算单点是 `spawnPointAng`：yaw = `bspYawToCsYaw`（wrap(src + 180)）、
 * pitch = −src（wasm 的 `angles` 保持 BSP 原始 [pitch, yaw, roll] 次序）。
 * 限幅不在这里做——`FlyCam.setPose` 会把 pitch 夹到 `PITCH_LIMIT`。
 */
import { bspYawToCsYaw } from './pose.js';
import type { SpawnPoint } from './bsp.js';

/** 结构化 bbox（与 `apps/viewer/src/ui/mapinfo.ts` 的 `WorldBox` 同形；core 不反向依赖 ui）。 */
export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export type SpawnSource = 'player-start' | 'player-spawn' | 'teleport-dest' | 'bbox-vantage';

export interface ResolvedSpawn {
  /** 命中的出生点下标；bbox 兜底视角为 −1（出生点列表里没有对应条目）。 */
  index: number;
  /** 脚底位置（世界坐标，HU）。 */
  pos: [number, number, number];
  /** [yaw, pitch]（度，viewer 约定：yaw 0 = 面朝 −Z，pitch 正 = 仰视）。 */
  ang: [number, number];
  source: SpawnSource;
}

const isPlayerStart = (p: SpawnPoint): boolean => p.classname === 'info_player_start';
const isPlayerSpawn = (p: SpawnPoint): boolean => p.classname.startsWith('info_player_');
const isTeleportDest = (p: SpawnPoint): boolean => p.classname === 'info_teleport_destination';

/**
 * 出生点实体角度 → viewer 角度（初始视角与面板跳转共用）。
 * `sp.angles` 是 wasm 原样输出的 BSP `[pitch, yaw, roll]`：缺值时按 0 处理，
 * roll 不参与（viewer 的位姿角只有 yaw 与 pitch）。
 */
export function spawnPointAng(sp: SpawnPoint): [number, number] {
  return [bspYawToCsYaw(sp.angles?.[1] ?? 0), -(sp.angles?.[0] ?? 0)];
}

/**
 * bbox 中心高位俯瞰锚点：水平取中心（x、z），高度取 bbox 顶面（max.y）。
 * 返回的是**脚底**坐标——相机 y 由 `FlyCam.writeCamera` 再加 `EYE_STAND`。
 */
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
 * 解析初始视角，优先级见模块头注。
 *
 * 边界：`points` 为空且 `box` 为 null 时返回 null（调用方保持当前视角不动）；
 * `primaryHint` 越界或指向非 `info_player_start` 实体时，回落到实体序扫描。
 * 内部辅助：`inBox` 逐分量做闭区间包含判定（`origin` 不足 3 个分量即判 false）；
 * `fromPoint` 把第 index 个实体转成 `ResolvedSpawn`，缺失的坐标分量按 0 补。
 * 无副作用：不写 `points`，不碰相机与 DOM。
 */
export function resolveInitialSpawn(
  points: readonly SpawnPoint[],
  primaryHint: number,
  box: Box3Like | null,
): ResolvedSpawn | null {
  // 1a. primary 下标指向的实体本身就是 info_player_start → 直接采用
  const hint = points[primaryHint];
  if (hint && isPlayerStart(hint)) return fromPoint(points, primaryHint, 'player-start');
  // 1b. 否则扫实体序里第一个 info_player_start
  const startIdx = points.findIndex(isPlayerStart);
  if (startIdx >= 0) return fromPoint(points, startIdx, 'player-start');
  // 1c. 再退一步：实体序里第一个 info_player_*（玩家出生点优先于传送目标）
  const playerIdx = points.findIndex(isPlayerSpawn);
  if (playerIdx >= 0) return fromPoint(points, playerIdx, 'player-spawn');
  if (box) {
  // 2. 几何 bbox 内的第一个 info_teleport_destination（bbox 外的点判为空域、不用）
    const destIdx = points.findIndex((p) => isTeleportDest(p) && inBox(p.origin ?? [], box));
    if (destIdx >= 0) return fromPoint(points, destIdx, 'teleport-dest');
  // 3. 兜底：bbox 中心高位俯瞰
    return { index: -1, pos: bboxVantagePos(box), ang: [0, -60], source: 'bbox-vantage' };
  }
  return null;
}
