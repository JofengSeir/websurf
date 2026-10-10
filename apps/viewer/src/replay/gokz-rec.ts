/**
 * KSF/gokz `.rec` 二进制原生解析（ksf.surf 回放文件格式，与 Shavit `.replay` 完全不同）。
 *
 * 格式权威出处是 ksf.surf 前端 `/gokz/js/replayviewer.js` 的 `ReplayFile` 类；本模块按该定义
 * 读取，字节级布局与逐段说明见 agentmemory `websurf/documents/viewer/implementation/replay.md#chunk*` 的 gokz `.rec` 段。
 * 概要：i32 魔数（2 或 3）→ i32 保留 → i32 tick 数 → i32 bookmark 数 →（v3 独有：i32 帧宽
 * cell 数 + i32 扩展块 cell 数并跳过扩展块）→ bookmark 区（整段跳过，本模块不解码）→ 定长帧区。
 * 每帧前 10 个 cell 与 v2 相同：i32 buttons、f32 pos[3]、f32 angles(pitch,yaw)、i32 丢弃、
 * f32 vel[3]；v3 帧宽超出 10 的余量（含 flags）本模块一律不读。
 *
 * 文件**不含 tickrate**（ksf.surf 页面按数据库另传）：缺省按 `GOKZ_FALLBACK_TICKRATE`
 * 估算并写 warning（见 `OWNER.md` D-010）。
 *
 * 坐标与朝向映射和 Shavit 路径同一套：缺省 pos 取 `[y,z,x]`、vel 同序、yaw = wrap(src+180)、
 * pitch 取 −src 并限幅、roll 恒 0；`raw` 直读。选项与语义见 `apps/viewer/src/replay/types.ts`
 * 的 `AxesMode` / `YawMode`。
 *
 * 对接：解析产出 `GokzRecParseResult`（不带无消费点的字段——flags 等一律不出面）；
 * UI 导入链路用 `clipFromGokzRec` 转成 `Clip`（`resolvedPath` 固定 '.rec'）。两条导入路径
 * （Worker 与主线程回退）的嗅探分派见 `apps/viewer/src/worker/main.ts` 与
 * `apps/viewer/src/replay/importer.ts`。
 */

import { applyClipTransform } from './build.js';
import { clampPitch, wrapDeg } from './helpers.js';
import type { Clip, ReplayHeaderMeta, RuleConfig } from './types.js';

/** v2 魔数（i32）：帧固定 10 cell（40 B），无扩展块。 */
export const GOKZ_REC_MAGIC_V2 = 2;

/** v3 魔数（i32）：自描述帧宽 + 可跳过的扩展块。 */
export const GOKZ_REC_MAGIC_V3 = 3;

/** 嗅探窗口：头部判定最多用到第 6 个 i32（v3 的扩展块 cell 数，字节 20..24）。 */
export const GOKZ_REC_SNIFF_BYTES = 24;

/**
 * tickrate 兜底（tick/s）：文件不含该字段，KSF CSS 服为 66.67（= 200/3）。
 * csgo/cs2 的 `.rec` 不适用该值——见 `OWNER.md` D-010。
 */
export const GOKZ_FALLBACK_TICKRATE = 200 / 3;

/** bookmark 记录定长（字节）：3 个 i32 + 2 个 64-cell 打包字符串；本模块整段跳过。 */
const BOOKMARK_BYTES = 524;

/** bookmark 数量上限（嗅探与解析共用的合法性界）。 */
const BOOKMARK_MAX = 4096;

/** 单帧 cell 数上限（合法性界；已见值 = 18）。 */
const TICK_CELLS_MAX = 4096;

/** 从字节切片读小端 i32。 */
function i32At(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24));
}

/**
 * 嗅探：魔数为 2/3，且头部的 tick 数、bookmark 数（与 v3 的帧宽、扩展块 cell 数）落在合法界内。
 * 四种导入类型里只有本格式的头 4 字节能构成 2/3 的小端 i32（shavit 文本头是 ASCII，
 * BSP / `.dem` 有各自的 ASCII 魔数），再加界校验排除偶然命中。
 */
export function looksLikeGokzRec(head: Uint8Array): boolean {
  if (head.length < GOKZ_REC_SNIFF_BYTES) return false;
  const magic = i32At(head, 0);
  if (magic !== GOKZ_REC_MAGIC_V2 && magic !== GOKZ_REC_MAGIC_V3) return false;
  const tickCount = i32At(head, 8);
  const bookMarkCount = i32At(head, 12);
  if (tickCount < 0 || tickCount > 0x40000000) return false;
  if (bookMarkCount < 0 || bookMarkCount > BOOKMARK_MAX) return false;
  if (magic === GOKZ_REC_MAGIC_V3) {
    const tickCells = i32At(head, 16);
    const extCells = i32At(head, 20);
    if (tickCells < 10 || tickCells > TICK_CELLS_MAX) return false;
    if (extCells < 0 || extCells > TICK_CELLS_MAX) return false;
  }
  return true;
}

/** File 形态的嗅探（Worker 与主线程两条导入路径共用）：只切片读前 `GOKZ_REC_SNIFF_BYTES` 字节；切片或读取抛错时按「不是 .rec」返回 false。 */
export async function fileLooksLikeGokzRec(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, GOKZ_REC_SNIFF_BYTES).arrayBuffer());
    return looksLikeGokzRec(head);
  } catch {
    return false;
  }
}

export interface GokzRecParseOptions {
  /**
   * 时间戳兜底（Unix 秒）：头部没有 timestamp 字段，导入路径传 `File.lastModified / 1000`。
   */
  timestampFallback?: number | null;
  /**
   * tick/s：文件不含 tickrate，必须由调用方给或落 `GOKZ_FALLBACK_TICKRATE`；
   * 非有限正数按兜底处理并写 warning。
   */
  tickrate?: number;
  /**
   * 坐标映射切换：语义与 Shavit 路径一致（缺省 = [y,z,x] + yaw+180 + −pitch；`raw` 直读）。
   */
  mapping?: {
    axesMode?: 'shavit' | 'raw';
    yawMode?: 'shavit' | 'raw';
  };
}

export interface GokzRecParseResult {
  meta: ReplayHeaderMeta;
  /** tick 数（= 头部声明与帧区实有二者取小后定稿，见 `parseGokzRec`）。 */
  count: number;
  /** t(i) = i / tickrate（秒）；首帧即起跑（bookmark StartTouch 在 tick 0）。 */
  t: Float64Array;
  /** 位置，3 × count；轴序由 `mapping.axesMode` 决定（缺省 = [y,z,x]）。 */
  pos: Float32Array;
  /** 朝向，3 × count，每帧 [yaw, pitch, roll]；映射缺省 = wrap(yaw+180)、−pitch、roll 0。 */
  ang: Float32Array;
  /** 帧内原生世界速度，3 × count，HU/s；轴序同 pos。 */
  vel: Float32Array;
  /** 逐帧按键位掩码（帧内 cell 0 的 i32 原样存入，Source IN_* 位）。 */
  buttons: Int32Array;
  /** 非致命问题的文本：tickrate 估算、帧区多出的字节、数值非有限的帧计数。 */
  warnings: string[];
}

/**
 * 解析 KSF/gokz `.rec`：只做解码与坐标/时间映射，不构造 Clip
 * （UI 导入链路在 `clipFromGokzRec` 里转会 Clip）。数据结构非法时抛错；非致命问题进 warnings。
 */
export function parseGokzRec(
  data: ArrayBuffer | ArrayBufferView,
  opts: GokzRecParseOptions = {},
): GokzRecParseResult {
  const dv = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  const warnings: string[] = [];
  const head = new Uint8Array(dv.buffer, dv.byteOffset, Math.min(dv.byteLength, GOKZ_REC_SNIFF_BYTES));
  if (!looksLikeGokzRec(head)) {
    throw new Error('不是有效的 KSF .rec 文件（头部魔数不是 2/3 或头部字段越界）');
  }
  const magic = dv.getInt32(0, true);
  const tickCountHead = dv.getInt32(8, true);
  const bookMarkCount = dv.getInt32(12, true);
  const tickCells = magic === GOKZ_REC_MAGIC_V3 ? dv.getInt32(16, true) : 10;
  const extCells = magic === GOKZ_REC_MAGIC_V3 ? dv.getInt32(20, true) : 0;

  // 头部没有 tickrate 字段：调用方给的值不可用时按 KSF CSS 兜底并写 warning（D-010）
  const rateRaw = opts.tickrate;
  let tickrate: number;
  if (rateRaw != null && Number.isFinite(rateRaw) && rateRaw > 0) {
    tickrate = rateRaw;
  } else {
    tickrate = GOKZ_FALLBACK_TICKRATE;
    warnings.push(`.rec 头部没有 tickrate 字段，时间轴按 ${GOKZ_FALLBACK_TICKRATE.toFixed(2)} tick/s 估算（KSF CSS）`);
  }

  const firstTickOffset = 24 + extCells * 4 + bookMarkCount * BOOKMARK_BYTES;
  const tickBytes = tickCells * 4;
  // 官方 reader 的口径：帧区实有帧数与头部声明不一致时以实有为准（容忍 lead-in 帧）
  const framesOnDisk = Math.floor((dv.byteLength - firstTickOffset) / tickBytes);
  if (framesOnDisk < tickCountHead) {
    throw new Error(
      `文件被截断：帧区需要 ${tickCountHead} tick × ${tickBytes} B（从字节 ${firstTickOffset} 起），文件只装得下 ${Math.max(framesOnDisk, 0)} tick`,
    );
  }
  const count = framesOnDisk !== tickCountHead ? framesOnDisk : tickCountHead;
  if (framesOnDisk !== tickCountHead) {
    warnings.push(`头部声明 ${tickCountHead} tick、帧区实有 ${framesOnDisk} tick，按实有帧数解析`);
  }
  if (dv.byteLength > firstTickOffset + count * tickBytes) {
    warnings.push(`文件末尾多出 ${dv.byteLength - (firstTickOffset + count * tickBytes)} 字节（已忽略）`);
  }

  const meta: ReplayHeaderMeta = {
    version: magic,
    format: magic === GOKZ_REC_MAGIC_V3 ? 'gokz3' : 'gokz2',
    map: '',
    style: 0,
    track: 0,
    preFrames: 0,
    frameCount: count,
    postFrames: 0,
    totalFrames: count,
    time: null,
    steamId: null,
    steamIdDisplay: null,
    tickrate,
    zoneOffset: [0, 0],
    stage: 0,
    timestamp: opts.timestampFallback ?? null,
    offsetsLength: 0,
  };

  const mapping = {
    axes: opts.mapping?.axesMode === 'raw' ? ('raw' as const) : ('shavit' as const),
    yaw: opts.mapping?.yawMode === 'raw' ? ('raw' as const) : ('shavit' as const),
  };
  const decoded = decodeFrames(dv, firstTickOffset, count, tickBytes, mapping, warnings);

  const t = new Float64Array(count);
  for (let i = 0; i < count; i++) t[i] = i / tickrate;

  return { meta, count, t, ...decoded, warnings };
}

/**
 * 帧解码 + 坐标映射。帧内 pos / angles / vel 出现非有限值时沿用上一帧的值（首帧前值为 0）
 * 并计数，计数在返回前写入 warnings。只读前 10 cell（v3 的余量 cell 不读、不产出）。
 */
function decodeFrames(
  dv: DataView,
  firstTickOffset: number,
  n: number,
  tickBytes: number,
  mapping: { axes: 'shavit' | 'raw'; yaw: 'shavit' | 'raw' },
  warnings: string[],
): { pos: Float32Array; ang: Float32Array; vel: Float32Array; buttons: Int32Array } {
  const pos = new Float32Array(n * 3);
  const ang = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const buttons = new Int32Array(n);
  let badPos = 0;
  let badAng = 0;
  let badVel = 0;
  let prevPos: [number, number, number] = [0, 0, 0];
  let prevAng: [number, number, number] = [0, 0, 0];
  let prevVel: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const base = firstTickOffset + i * tickBytes;
    buttons[i] = dv.getInt32(base, true);
    const sx = dv.getFloat32(base + 4, true);
    const sy = dv.getFloat32(base + 8, true);
    const sz = dv.getFloat32(base + 12, true);
    const pitch = dv.getFloat32(base + 16, true);
    const yaw = dv.getFloat32(base + 20, true);
    const vx = dv.getFloat32(base + 28, true);
    const vy = dv.getFloat32(base + 32, true);
    const vz = dv.getFloat32(base + 36, true);

    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
      const p: [number, number, number] = mapping.axes === 'raw' ? [sx, sy, sz] : [sy, sz, sx];
      pos[i * 3] = p[0];
      pos[i * 3 + 1] = p[1];
      pos[i * 3 + 2] = p[2];
      prevPos = p;
    } else {
      badPos++;
      pos[i * 3] = prevPos[0];
      pos[i * 3 + 1] = prevPos[1];
      pos[i * 3 + 2] = prevPos[2];
    }

    if (Number.isFinite(pitch) && Number.isFinite(yaw)) {
      const a: [number, number, number] =
        mapping.yaw === 'raw' ? [yaw, pitch, 0] : [wrapDeg(yaw + 180), clampPitch(-pitch), 0];
      ang[i * 3] = a[0];
      ang[i * 3 + 1] = a[1];
      ang[i * 3 + 2] = a[2];
      prevAng = a;
    } else {
      badAng++;
      ang[i * 3] = prevAng[0];
      ang[i * 3 + 1] = prevAng[1];
      ang[i * 3 + 2] = prevAng[2];
    }

    if (Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz)) {
      const v: [number, number, number] = mapping.axes === 'raw' ? [vx, vy, vz] : [vy, vz, vx];
      vel[i * 3] = v[0];
      vel[i * 3 + 1] = v[1];
      vel[i * 3 + 2] = v[2];
      prevVel = v;
    } else {
      badVel++;
      vel[i * 3] = prevVel[0];
      vel[i * 3 + 1] = prevVel[1];
      vel[i * 3 + 2] = prevVel[2];
    }
  }

  if (badPos > 0) warnings.push(`${badPos} 帧位置数值无效（NaN/Inf），已沿用上一帧的值`);
  if (badAng > 0) warnings.push(`${badAng} 帧视角数值无效（NaN/Inf），已沿用上一帧的值`);
  if (badVel > 0) warnings.push(`${badVel} 帧速度数值无效（NaN/Inf），已沿用上一帧的值`);
  return { pos, ang, vel, buttons };
}

/**
 * 解析结果 → `Clip`：拷贝定型数组（后续 `applyClipTransform` 就地改写，parsed 保持原样可复用），
 * 按 pos 算 bbox、按帧内原生 vel 算 maxSpeed、按末帧 t 算 duration；`resolvedPath` 固定 '.rec'，
 * `rule.transform` 经 `applyClipTransform` 生效（与 Shavit 轨道同一套「调整工具」）。
 */
export function clipFromGokzRec(
  name: string,
  parsed: GokzRecParseResult,
  rule: RuleConfig,
): { clip: Clip; warnings: string[] } {
  const n = parsed.count;
  const t = parsed.t.slice();
  const pos = parsed.pos.slice();
  const ang = parsed.ang.slice();
  const vel = parsed.vel.slice();
  const buttons = parsed.buttons.slice();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let maxSpeed = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    const sp = Math.hypot(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
    if (sp > maxSpeed) maxSpeed = sp;
  }
  if (n === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const clip: Clip = {
    id: `clip-${Date.now().toString(36)}`,
    name,
    count: n,
    t,
    pos,
    ang,
    vel,
    duration: n > 0 ? t[n - 1] : 0,
    bbox: { min, max },
    maxSpeed,
    resolvedPath: '.rec',
    rule,
    buttons,
    meta: parsed.meta,
  };
  applyClipTransform(clip, rule.transform);
  return { clip, warnings: parsed.warnings };
}
