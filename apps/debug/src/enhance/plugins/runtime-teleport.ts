/**
 * 增强插件 v1：运行时传送。
 *
 * 补的是什么缺口（来自 2026-11-22 BSP 审计）：地图里有 57 个 `trigger_teleport`，其中 29 个
 * `StartDisabled=1`、全部有运行期 `Enable` 来源；但 Rust 物理链在 `src/phys/teleport.rs`
 * 里对 `start_disabled` 的传送体**永久跳过**（加载期 `continue`），运行期也没有回写通道，
 * 于是「脚本把传送门打开了」在游戏里没有反应。TS 实体层本来就在跑 Source I/O，
 * `trigger_teleport` 的 touch 已经算好落点/朝向并调用 `host.teleportPlayer(...)`，
 * 只是观测宿主的输出被丢弃（见 `src/ts-shared/entity/attach.ts`）。
 *
 * 为什么不会和 Rust 静态链重复传送：
 *   - Rust 链只处理「加载时未 StartDisabled」的传送体；本插件消费的是同一套实体事件的
 *     **另一批**（被 Enable 的）——两者在源集合上互补；
 *   - 仍在同一帧内做一次去重保护：若事件发生前玩家已经落在目标点附近，说明该次传送
 *     已被别的链施加过，直接跳过；同一目标点在 250ms 内只施加一次（防重叠触发体连发）。
 *
 * 语义依据：`CTriggerTeleport::Touch`（SDK triggers.cpp:2388-2452）。角度已由实体层
 * 用 `bspYawToCsYaw` 换算成项目 yaw 度（见 `classes/triggers.ts::teleportTouch`）。
 */
import type { EnhancePlugin, EnhanceRuntime } from '../../../../../src/ts-shared/enhance/plugin.js';
import type { EntityEvent } from '../../../../../src/ts-shared/entity/types.js';

/** 「玩家已经在该落点附近」判定半径（HU）：说明另一条链已经传过，避免重复施加。 */
const ALREADY_APPLIED_RADIUS_HU = 48;
/** 同一落点的去重窗口（ms）：防同一个触发体在连续帧里重复上报。 */
const DEDUPE_WINDOW_MS = 250;
/** 去重时认为「同一落点」的半径（HU）。 */
const DEDUPE_RADIUS_HU = 8;
/** 前 N 次成功传送打日志（之后只计数，避免刷屏）。 */
const LOG_LIMIT = 20;

interface TeleportPayload {
  origin?: unknown;
  angles?: unknown;
  velocity?: unknown;
}

/** 解析 `[x,y,z]`；非有限数字返回 null。 */
function parseVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return [out[0], out[1], out[2]];
}

/**
 * 解析 `entity:teleport` 事件载荷。
 *
 * 兼容两种格式：
 *   - 新格式（本插件配套）：`{"origin":[x,y,z],"angles":[pitch,yaw,roll]|null,"velocity":null}`；
 *   - 旧格式：裸 `[x,y,z]`（attach.ts 早期只上报 origin，滚动升级时旧构建仍可读）。
 */
function parseTeleportDetail(detail: string): { pos: [number, number, number]; yawDeg?: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
  const legacy = parseVec3(raw);
  if (legacy) return { pos: legacy };
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as TeleportPayload;
  const pos = parseVec3(payload.origin);
  if (!pos) return null;
  const angles = payload.angles;
  if (Array.isArray(angles) && angles.length >= 2) {
    const yaw = angles[1];
    if (typeof yaw === 'number' && Number.isFinite(yaw)) return { pos, yawDeg: yaw };
  }
  return { pos };
}

/** 距离（HU）。 */
function distance(a: readonly number[], b: readonly number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dy, dz);
}

export function createRuntimeTeleportPlugin(runtime: EnhanceRuntime): EnhancePlugin {
  let applied = 0;
  let skippedRust = 0;
  let skippedDup = 0;
  let lastDest: [number, number, number] | null = null;
  let lastAt = -Infinity;

  const reset = (): void => {
    applied = 0;
    skippedRust = 0;
    skippedDup = 0;
    lastDest = null;
    lastAt = -Infinity;
  };

  return {
    id: 'runtime-teleport',

    onMapLoad(): void {
      reset();
    },

    onEvent(event: EntityEvent): void {
      if (event.kind !== 'entity:teleport' || !event.detail) return;
      const payload = parseTeleportDetail(event.detail);
      if (!payload) return;
      const { pos, yawDeg } = payload;

      // 去重 1：玩家已经落在目标点附近 ⇒ 这次传送已由另一条链（Rust 静态链 /
      // 同帧重叠触发体）施加过，不重复。
      const state = runtime.getPlayerState();
      if (state && distance([state.posX, state.posY, state.posZ], pos) <= ALREADY_APPLIED_RADIUS_HU) {
        skippedRust += 1;
        return;
      }

      // 去重 2：同一落点在短窗口内只施加一次（重叠传送体/连续帧 touch）。
      const now = Date.now();
      if (lastDest && now - lastAt <= DEDUPE_WINDOW_MS && distance(lastDest, pos) <= DEDUPE_RADIUS_HU) {
        skippedDup += 1;
        return;
      }

      lastDest = pos;
      lastAt = now;
      runtime.teleport(pos, yawDeg);
      applied += 1;
      if (applied <= LOG_LIMIT) {
        const coords = pos.map((n) => Math.round(n)).join(', ');
        const yawText = yawDeg === undefined ? '' : `，yaw=${yawDeg.toFixed(1)}°`;
        runtime.log(`运行时传送 → [${coords}]${yawText}`);
      }
    },

    statusText(): string {
      return `已施加 ${applied} 次，跳过 ${skippedRust}（另一链已处理），去重 ${skippedDup}`;
    },

    dispose(): void {
      reset();
    },
  };
}
