/**
 * Shavit `.replay` 二进制原生解析。
 *
 * 本模块只认 Shavit 的 `.replay` 格式：判据是头行标签里的魔数字面量 `{SHAVITREPLAYFORMAT}` 及其
 * `{FINAL}` / `{V2}` 后缀。下面列出的段顺序、版本门槛、偏移与字节宽**全部取自本模块的读取代码**，
 * 不引仓库外实现、不引行号。
 *
 * 文件四段（全部小端、无压缩）：
 *   ① ASCII 头行 `"<数字>:<标签>\n"`：标签为 `{SHAVITREPLAYFORMAT}{FINAL}` 时数字 = 格式版本，
 *      为 `{SHAVITREPLAYFORMAT}{V2}` 时数字 = 帧数（V2 无版本概念）。头行只在文件前
 *      SHAVIT_SNIFF_BYTES 字节内查找；二进制段自换行符后一字节起。FINAL 版本必须落在
 *      [1, SHAVIT_MAX_VERSION]；标签内含魔数但既非 FINAL 也非 V2 时明确报错。
 *   ② FINAL 二进制头：字段按固定顺序读取，每个字段带版本门槛（门槛 = 该字段存在的起始版本，
 *      版本不足则该字段不占字节、取默认值）。读取顺序与门槛（括号内为门槛）：
 *        sMap          变长 NUL 结尾字符串（3）——逐字节 latin1 组装，扫描上限 NT_STRING_MAX
 *        style         u8（3）
 *        track         u8（3）
 *        preFrames     i32（3）
 *        frameCount    i32（无门槛）
 *        time          f32（无门槛）
 *        steamID       i32（4）
 *        postFrames    i32（5）
 *        tickrate      f32（5）
 *        zoneOffset[0] f32（8）
 *        zoneOffset[1] f32（8）
 *        stage         u8（10）
 *        timestamp     i32（12）
 *        offsetsLength u8（11）——读取顺序排在 timestamp 之后
 *   ③ fail-replay offsets 区：offsetsLength ≥ 2 时跳过 (offsetsLength − 1) × 12 B；否则不占字节。
 *   ④ 帧区：totalFrames 个定长帧，每帧 cells × 4 B，cells 随版本增长（见 cellsForVersion）。
 *      本模块读取的帧内字段（偏移相对帧首）：
 *        +0 / +4 / +8   pos.x / pos.y / pos.z  f32 ×3
 *        +12 / +16      pitch / yaw            f32 ×2
 *        +20            buttons                i32（按键位掩码）
 *        +24            flags                  u32（cells ≥ 8 才存在；按位型存入 Int32Array）
 *      cells ≥ 10 时帧内另有第 9、10 个 cell（各 4 B），cells ≥ 11 时另有第 11 个 cell：
 *      本模块不读取，也不产出对应输出。帧区之后多出的字节计入 warnings。
 *
 * 读侧兼容修正（在头部字段读完、帧区定位之前）：
 *   - preFrames < 0 归零；
 *   - 版本 < 7 时 frameCount 减去 preFrames，版本 ≥ 5 时再减去 postFrames（修正后 frameCount 只含
 *     正式跑帧，总帧数 = preFrames + frameCount + postFrames）；
 *   - 修正后 frameCount < 1 报错。
 *
 * tickrate：版本 < 5 头部没有该字段 → 取 FALLBACK_TICKRATE 并写入 warning；字段存在但非有限
 * 正数 → 报错。
 *
 * 坐标与时间映射（默认映射；ShavitParseOptions.mapping 可把轴序与朝向分别切成 raw 直读）：
 *   - pos：Source [x, y, z] → viewer [y, z, x]，与 `apps/viewer/crates/wasm/src/lib.rs` 的
 *     rotate_yup 同一变换（det = +1 的正交变换，BSP Z-up → Y-up）。
 *   - yaw：wrap(src + 180)，与 `src/ts-shared/phys/angles.ts` 的 bspYawToCsYaw 同一定标
 *     （`apps/viewer/src/core/pose.ts` 转发该实现）；pitch：−src，经 clampPitch 限幅；roll 恒 0。
 *   - t(i) = (i − preFrames) / tickrate（秒）：prerun 段为负，主时钟 0 = 起跑帧。
 *   - vel：相邻帧位置差分（中央差分 scale = tickrate / 2，两端点单侧差分 scale = tickrate），
 *     单位 HU/s；帧数 < 2 时为 null。
 *
 * 对接：解析只产出定型数组（parseShavitReplay）；UI 导入链路用 clipFromShavitReplay 转成 Clip，
 * 头部元信息落在 Clip.meta、逐帧按键落在 Clip.buttons。导入前先用 fileLooksLikeShavitReplay 嗅探
 * （读字节切片，不经文本解码），命中的文件才走本模块的解析。
 */

import { applyClipTransform } from './build.js';
import { clampPitch, wrapDeg } from './helpers.js';
import type { Clip, ReplayHeaderMeta, RuleConfig } from './types.js';

/** 格式识别魔数：嗅探在窗口内逐字节查找该串，头行解析要求冒号后的标签含它。 */
export const SHAVIT_MAGIC = '{SHAVITREPLAYFORMAT}';

/** viewer 支持的最高 FINAL 格式版本（0x0C = 12）：版本高于该值直接报错。 */
export const SHAVIT_MAX_VERSION = 0x0c;

/** 嗅探与头行解析共用的字节窗口：两者都只看文件前 64 字节（头行必须落在窗口内）。 */
export const SHAVIT_SNIFF_BYTES = 64;

/**
 * 头部没有 tickrate 字段（V2 与 FINAL 版本 < 5）时的时间轴估算值：
 * 取 128 并写入一条 warning，不静默给出时间轴。
 */
const FALLBACK_TICKRATE = 128;

/** NUL 结尾字符串的扫描上限（字节）：达到该长度仍未遇到 NUL 即报错。 */
const NT_STRING_MAX = 256;

export type ShavitFormatKind = 'final' | 'v2';

/** 嗅探：魔数是否出现在前 SHAVIT_SNIFF_BYTES 字节内（逐字节比较，不做文本解码）。 */
export function looksLikeShavitReplay(head: Uint8Array): boolean {
  const n = Math.min(head.length, SHAVIT_SNIFF_BYTES);
  const m = SHAVIT_MAGIC;
  if (n < m.length) return false;
  for (let i = 0; i <= n - m.length; i++) {
    let ok = true;
    for (let j = 0; j < m.length; j++) {
      if (head[i + j] !== m.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** File 形态的嗅探（Worker 与主线程两条导入路径共用）：只切片读取前 SHAVIT_SNIFF_BYTES 字节；切片或读取抛错时按「不是 .replay」返回 false。 */
export async function fileLooksLikeShavitReplay(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, SHAVIT_SNIFF_BYTES).arrayBuffer());
    return looksLikeShavitReplay(head);
  } catch {
    return false;
  }
}

// ── 头部行解析 ──────────────────────────────────────────────────────

interface ShavitLine {
  kind: ShavitFormatKind;
  /** FINAL 段为格式版本；V2 段为帧数（V2 无版本概念）。 */
  number: number;
  /** 换行符所在字节下标：二进制段自 lineEnd + 1 起。 */
  lineEnd: number;
}

function parseHeaderLine(head: Uint8Array): ShavitLine {
  let lineEnd = -1;
  const lim = Math.min(head.length, SHAVIT_SNIFF_BYTES);
  for (let i = 0; i < lim; i++) {
    if (head[i] === 0x0a) {
      lineEnd = i;
      break;
    }
  }
  if (lineEnd < 0) {
    throw new Error('不是有效的 Shavit .replay：前 64 字节内没有换行符（第 1 行缺失）');
  }
  // 逐字节按 latin1 组装头行：魔数全是 ASCII，避免引入文本解码假设
  let line = '';
  for (let i = 0; i < lineEnd; i++) line += String.fromCharCode(head[i]);
  line = line.trim(); // 去首尾空白后按「<数字>:<标签>」切分

  const colon = line.indexOf(':');
  if (colon < 0) {
    throw new Error(
      `不是有效的 Shavit .replay：第 1 行缺少「<数字>:」前缀（读到「${line.slice(0, 40)}」）`,
    );
  }
  const left = line.slice(0, colon).trim();
  const tag = line.slice(colon + 1).trim();
  const num = Number(left);
  if (!Number.isInteger(num) || num < 0 || left === '') {
    throw new Error(`不是有效的 Shavit .replay：第 1 行版本/帧数前缀不是非负整数（读到「${left}」）`);
  }
  if (tag === '{SHAVITREPLAYFORMAT}{FINAL}') return { kind: 'final', number: num, lineEnd };
  if (tag === '{SHAVITREPLAYFORMAT}{V2}') return { kind: 'v2', number: num, lineEnd };
  if (tag.includes(SHAVIT_MAGIC)) {
    throw new Error(
      `不支持的 Shavit 回放格式「${tag}」——viewer 只支持 FINAL / V2（远古文本/备份格式不支持）`,
    );
  }
  throw new Error('不是有效的 Shavit .replay 文件');
}

// ── 游标式读取（小端；每步带边界检查）───────────────────────────────

class ByteReader {
  private p = 0;
  constructor(private readonly dv: DataView) {}

  get pos(): number {
    return this.p;
  }

  private need(bytes: number, what: string): void {
    if (this.p + bytes > this.dv.byteLength) {
      throw new Error(
        `文件被截断：${what}需要 ${bytes} 字节，只剩 ${this.dv.byteLength - this.p} 字节（文件共 ${this.dv.byteLength} B）`,
      );
    }
  }

  u8(what: string): number {
    this.need(1, what);
    return this.dv.getUint8(this.p++);
  }

  i32(what: string): number {
    this.need(4, what);
    const v = this.dv.getInt32(this.p, true);
    this.p += 4;
    return v;
  }

  f32(what: string): number {
    this.need(4, what);
    const v = this.dv.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }

  /** NUL 结尾字符串：读到 0 字节为止（不含该字节），游标停在 0 之后；扫描上限 NT_STRING_MAX，超限或文件结束仍未遇 0 即报错。 */
  ntString(what: string): string {
    const start = this.p;
    let end = -1;
    while (this.p < this.dv.byteLength && this.p - start < NT_STRING_MAX) {
      if (this.dv.getUint8(this.p) === 0) {
        end = this.p;
        break;
      }
      this.p++;
    }
    if (end < 0) {
      throw new Error(`文件被截断或损坏：${what}缺少 NUL 结束符（已扫 ${this.dv.byteLength - start} 字节）`);
    }
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(this.dv.getUint8(i));
    this.p = end + 1;
    return s;
  }

  skip(bytes: number, what: string): void {
    this.need(bytes, what);
    this.p += bytes;
  }
}

// ── 解析 ────────────────────────────────────────────────────────────

export interface ShavitParseOptions {
  /**
   * 时间戳兜底（Unix 秒）：FINAL 版本 < 12 与 V2 的头部没有 timestamp 字段时用它填充
   * header.timestamp。Worker 与主线程回退两条导入路径都传 File.lastModified / 1000。
   */
  timestampFallback?: number | null;
  /**
   * 坐标映射切换：录像与 viewer 坐标系不一致时的逃生口。
   * 缺省 = shavit 定标映射（pos 取 [y, z, x]、yaw = wrap(src + 180)、pitch 取反）；
   * `raw` = 帧内原始值直读。只影响解码输出，不影响头字段与时间轴。
   */
  mapping?: {
    axesMode?: 'shavit' | 'raw';
    yawMode?: 'shavit' | 'raw';
  };
}

export interface ShavitParseResult {
  header: ReplayHeaderMeta;
  /** preFrames + frameCount + postFrames（解析保证 ≥ 1）。 */
  count: number;
  /** t(i) = (i − preFrames) / tickrate（秒），长度 = count；prerun 段为负，主时钟 0 = 起跑帧。 */
  t: Float64Array;
  /** 位置，3 × count；轴序由 mapping.axesMode 决定（缺省 = [y, z, x]）。 */
  pos: Float32Array;
  /** 朝向，3 × count，每帧 [yaw, pitch, roll]；映射由 mapping.yawMode 决定（缺省 = wrap(yaw + 180)、−pitch、roll 0）。 */
  ang: Float32Array;
  /** 世界速度，3 × count，HU/s；由相邻帧位置差分算出，count < 2 时为 null。 */
  vel: Float32Array | null;
  /** 逐帧按键位掩码（帧内 +20 的 i32 原样存入）。 */
  buttons: Int32Array;
  /** 逐帧实体 flags（帧内 +24 的 u32；cells < 8 的版本恒 0）。存入 Int32Array 以保位型。 */
  flags: Int32Array;
  /** 非致命问题的文本：tickrate 估算、帧区之后多余的字节、数值非有限的帧计数。 */
  warnings: string[];
  /** 帧区起始字节偏移（诊断用：frameStart + count × cells × 4 与文件长度闭合）。 */
  frameStart: number;
}

/**
 * 版本 → 每帧 cell 数（每 cell 4 B）。V2 恒 6；FINAL 随版本递增（版本 1 为 6，≥ 2 为 8，
 * ≥ 6 为 10，≥ 10 为 11）。cells ≥ 8 时帧内 +24 处有 flags；多出的 cell 本模块不读取。
 */
function cellsForVersion(kind: ShavitFormatKind, version: number): number {
  if (kind === 'v2') return 6; // pos×3 + ang×2 + buttons
  if (version >= 10) return 11;
  if (version >= 6) return 10;
  if (version >= 2) return 8; // 起：帧内 +24 有 flags
  return 6; // 版本 1
}

/**
 * 解析 Shavit `.replay`：只做解码与坐标/时间映射，不构造 Clip
 * （UI 导入链路在 clipFromShavitReplay 里转会 Clip）。
 * 数据结构非法时抛错；非致命问题进返回值的 warnings。
 */
export function parseShavitReplay(
  data: ArrayBuffer | ArrayBufferView,
  opts: ShavitParseOptions = {},
): ShavitParseResult {
  const dv = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  const warnings: string[] = [];

  const head = new Uint8Array(dv.buffer, dv.byteOffset, Math.min(dv.byteLength, SHAVIT_SNIFF_BYTES));
  if (!looksLikeShavitReplay(head)) {
    throw new Error('不是有效的 Shavit .replay 文件（缺少 {SHAVITREPLAYFORMAT} 魔数）');
  }
  const line = parseHeaderLine(head);
  const r = new ByteReader(dv);
  r.skip(line.lineEnd + 1, '第 1 行');

  if (line.kind === 'v2') {
    return parseV2(dv, r.pos, line.number, opts, warnings);
  }

  const version = line.number;
  if (version > SHAVIT_MAX_VERSION) {
    throw new Error(
      `Shavit .replay 格式版本 ${version} 高于 viewer 支持的最高版本 ${SHAVIT_MAX_VERSION}（0x0C）——请更新 viewer`,
    );
  }
  if (version < 1) {
    throw new Error(`Shavit .replay 格式版本异常（${version}）——文件损坏`);
  }

  // ── 二进制头：字段按顺序读取，has(n) = 版本 ≥ n（顺序与门槛见文件头注释）──
  const has = (min: number): boolean => version >= min;
  const map = has(3) ? r.ntString('地图名') : '';
  const style = has(3) ? r.u8('style') : 0;
  const track = has(3) ? r.u8('track') : 0;
  let preFrames = has(3) ? r.i32('preFrames') : 0;
  let frameCount = r.i32('frameCount');
  const time = r.f32('time');
  const steamId = has(4) ? r.i32('steamID') : null;
  const postFrames = has(5) ? r.i32('postFrames') : 0;
  const tickrateRaw = has(5) ? r.f32('tickrate') : null;
  const zoneOffset: [number, number] = has(8)
    ? [r.f32('zoneOffset[0]'), r.f32('zoneOffset[1]')]
    : [0, 0];
  const stage = has(10) ? r.u8('stage') : 0;
  const timestampRaw = has(12) ? r.i32('timestamp') : null;
  const offsetsLength = has(11) ? r.u8('offsetsLength') : 0;

  // 读侧兼容修正：负 prerun 归零；版本 < 7 时 frameCount 已把 pre 计入（版本 ≥ 5 时连 post 一并计入），需减去
  if (preFrames < 0) preFrames = 0;
  if (version < 7) {
    frameCount -= preFrames;
    if (version >= 5) frameCount -= postFrames;
  }
  if (frameCount < 1) {
    throw new Error(
      `Shavit .replay 无有效 run 帧（pre ${preFrames} + run ${frameCount} + post ${postFrames}）——文件损坏或不是完整回放`,
    );
  }

  // ── tickrate：版本 < 5 头部无该字段 → 按 FALLBACK_TICKRATE 估算并写入警告；字段存在但非有限正数 → 报错 ──
  let tickrate: number;
  if (tickrateRaw == null) {
    tickrate = FALLBACK_TICKRATE;
    warnings.push(`格式版本 ${version} 头部没有 tickrate 字段，时间轴按 ${FALLBACK_TICKRATE} tick/s 估算`);
  } else if (!Number.isFinite(tickrateRaw) || tickrateRaw <= 0) {
    throw new Error(`Shavit .replay tickrate 无效（${tickrateRaw}）——文件损坏`);
  } else {
    tickrate = tickrateRaw;
  }

  const totalFrames = preFrames + frameCount + postFrames;
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1) {
    throw new Error(
      `Shavit .replay 帧数无效（pre ${preFrames} + run ${frameCount} + post ${postFrames}）——文件损坏`,
    );
  }

  // ── offsets 区：offsetsLength ≥ 2 时占 (offsetsLength − 1) × 12 B，整段跳过（本模块不解析其内容）──
  if (offsetsLength >= 2) {
    r.skip((offsetsLength - 1) * 12, 'fail-replay offsets 区');
  }

  // ── 帧区：起点取当前游标，长度按 totalFrames × cellBytes 校验（不足报错，多余只警告）──
  const cells = cellsForVersion('final', version);
  const cellBytes = cells * 4;
  const frameStart = r.pos;
  const expected = frameStart + totalFrames * cellBytes;
  if (dv.byteLength < expected) {
    throw new Error(
      `文件被截断：帧区需要 ${totalFrames} 帧 × ${cellBytes} B = ${totalFrames * cellBytes} 字节（从字节 ${frameStart} 起），文件只有 ${dv.byteLength} 字节`,
    );
  }
  if (dv.byteLength > expected) {
    warnings.push(`文件末尾多出 ${dv.byteLength - expected} 字节（已忽略）`);
  }

  const header: ReplayHeaderMeta = {
    version,
    format: 'final',
    map,
    style,
    track,
    preFrames,
    frameCount,
    postFrames,
    totalFrames,
    time: Number.isFinite(time) ? time : null,
    steamId,
    steamIdDisplay: steamId != null ? `[U:1:${steamId}]` : null,
    tickrate,
    zoneOffset,
    stage,
    timestamp: timestampRaw ?? opts.timestampFallback ?? null,
    offsetsLength,
  };

  const mapping = {
    axes: opts.mapping?.axesMode === 'raw' ? ('raw' as const) : ('shavit' as const),
    yaw: opts.mapping?.yawMode === 'raw' ? ('raw' as const) : ('shavit' as const),
  };
  const decoded = decodeFrames(dv, frameStart, totalFrames, cellBytes, cells, tickrate, warnings, mapping);
  const t = buildTimeArray(totalFrames, preFrames, tickrate);

  return { header, count: totalFrames, t, ...decoded, warnings, frameStart };
}

/** V2：头行数字即帧数，二进制头整段缺席（version 记 0，其余头字段取 0/null）+ 定长 6-cell 帧数组。 */
function parseV2(
  dv: DataView,
  offset: number,
  frameCount: number,
  opts: ShavitParseOptions,
  warnings: string[],
): ShavitParseResult {
  if (frameCount < 1) {
    throw new Error(`Shavit V2 回放帧数无效（${frameCount}）——文件损坏`);
  }
  const tickrate = FALLBACK_TICKRATE;
  warnings.push(`V2 格式头部没有 tickrate，时间轴按 ${FALLBACK_TICKRATE} tick/s 估算`);

  const cellBytes = 6 * 4;
  const frameStart = offset;
  const expected = frameStart + frameCount * cellBytes;
  if (dv.byteLength < expected) {
    throw new Error(
      `文件被截断：帧区需要 ${frameCount} 帧 × ${cellBytes} B = ${frameCount * cellBytes} 字节（从字节 ${frameStart} 起），文件只有 ${dv.byteLength} 字节`,
    );
  }
  if (dv.byteLength > expected) {
    warnings.push(`文件末尾多出 ${dv.byteLength - expected} 字节（已忽略）`);
  }

  const header: ReplayHeaderMeta = {
    version: 0,
    format: 'v2',
    map: '',
    style: 0,
    track: 0,
    preFrames: 0,
    frameCount,
    postFrames: 0,
    totalFrames: frameCount,
    time: null,
    steamId: null,
    steamIdDisplay: null,
    tickrate,
    zoneOffset: [0, 0],
    stage: 0,
    timestamp: opts.timestampFallback ?? null,
    offsetsLength: 0,
  };

  const decoded = decodeFrames(dv, frameStart, frameCount, cellBytes, 6, tickrate, warnings, {
    axes: opts.mapping?.axesMode === 'raw' ? 'raw' : 'shavit',
    yaw: opts.mapping?.yawMode === 'raw' ? 'raw' : 'shavit',
  });
  const t = buildTimeArray(frameCount, 0, tickrate);

  return { header, count: frameCount, t, ...decoded, warnings, frameStart };
}

/** 时间轴数组：t(i) = (i − preFrames) / tickrate（秒）。V2 路径传 preFrames = 0。 */
function buildTimeArray(n: number, preFrames: number, tickrate: number): Float64Array {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = (i - preFrames) / tickrate;
  return t;
}

/**
 * 帧解码 + 坐标映射 + 世界速度差分。
 * 帧内 pos / pitch / yaw 出现非有限值（NaN、Inf）时沿用上一帧的值（首帧前值为 0）并计数，
 * 计数在返回前写入 warnings。每帧只读 +0…+24 的字段，其余 cell 不读（见文件头布局说明）。
 */
function decodeFrames(
  dv: DataView,
  frameStart: number,
  n: number,
  cellBytes: number,
  cells: number,
  tickrate: number,
  warnings: string[],
  mapping: { axes: 'shavit' | 'raw'; yaw: 'shavit' | 'raw' },
): { pos: Float32Array; ang: Float32Array; vel: Float32Array | null; buttons: Int32Array; flags: Int32Array } {
  const pos = new Float32Array(n * 3);
  const ang = new Float32Array(n * 3);
  const buttons = new Int32Array(n);
  const flags = new Int32Array(n);
  let badPos = 0;
  let badAng = 0;
  let prevPos: [number, number, number] = [0, 0, 0];
  let prevAng: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const base = frameStart + i * cellBytes;
    const sx = dv.getFloat32(base, true);
    const sy = dv.getFloat32(base + 4, true);
    const sz = dv.getFloat32(base + 8, true);
    const pitch = dv.getFloat32(base + 12, true);
    const yaw = dv.getFloat32(base + 16, true);
    buttons[i] = dv.getInt32(base + 20, true);
    // flags 按 u32 读（高位 bit 不丢），再按位型存进 Int32Array
    flags[i] = cells >= 8 ? dv.getUint32(base + 24, true) | 0 : 0;
    // cells ≥ 10 时帧内还有第 9、10 个 cell，cells ≥ 11 时还有第 11 个 cell：本模块不读取，
    // 也不产出对应输出（速度一律由 pos 差分算出）

    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
      // 轴序：缺省 shavit = Source [x, y, z] → viewer [y, z, x]（与 wasm rotate_yup 同一变换）；
      // raw = 帧内 [x, y, z] 直读
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
      // 朝向：缺省 = yaw 归一为 wrap(src + 180)、pitch 取 −src 并限幅（clampPitch）、roll 0；
      // raw = 帧内 yaw/pitch 直读，roll 仍为 0
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
  }

  if (badPos > 0) warnings.push(`${badPos} 帧位置数值无效（NaN/Inf），已沿用上一帧的值`);
  if (badAng > 0) warnings.push(`${badAng} 帧视角数值无效（NaN/Inf），已沿用上一帧的值`);

  // vel = 位置差分 × tickrate：首末帧用单侧差分（scale = tickrate），中间帧用中央差分（scale = tickrate / 2）
  let vel: Float32Array | null = null;
  if (n >= 2) {
    vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const i0 = i === 0 ? 0 : i - 1;
      const i1 = i === n - 1 ? n - 1 : i + 1;
      const scale = i0 === i1 ? 0 : i === 0 || i === n - 1 ? tickrate : tickrate / 2;
      for (let k = 0; k < 3; k++) {
        const d = pos[i1 * 3 + k] - pos[i0 * 3 + k];
        vel[i * 3 + k] = Number.isFinite(d) ? d * scale : 0;
      }
    }
  }
  return { pos, ang, vel, buttons, flags };
}

/**
 * 解析结果 → Clip：先拷贝 parsed 的定型数组（后续 applyClipTransform 就地改写，parsed 保持原样
 * 可复用），再按 pos 算 bbox、按 vel 算 maxSpeed、按末帧 t 算 duration。
 * rule.transform 经 applyClipTransform 生效（「调整工具」的平移/旋转对 .replay 轨道同样生效）；
 * resolvedPath 固定为 '.replay'，meta 取 parsed.header，warnings 原样透传。
 */
export function clipFromShavitReplay(
  name: string,
  parsed: ShavitParseResult,
  rule: RuleConfig,
): { clip: Clip; warnings: string[] } {
  const n = parsed.count;
  const t = parsed.t.slice();
  const pos = parsed.pos.slice();
  const ang = parsed.ang.slice();
  const vel = parsed.vel ? parsed.vel.slice() : null;
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
    if (vel) {
      const sp = Math.hypot(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
      if (sp > maxSpeed) maxSpeed = sp;
    }
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
    resolvedPath: '.replay',
    rule,
    buttons,
    meta: parsed.header,
  };
  applyClipTransform(clip, rule.transform);
  return { clip, warnings: parsed.warnings };
}
