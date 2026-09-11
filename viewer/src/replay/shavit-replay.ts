/**
 * Shavit `.replay` 二进制原生解析（replay-file.inc 规格）。
 *
 * 规格依据：documents/viewer/implementation/shavit-replay-format.md（t2 研究，已对照
 * 仓库真实文件 test/maps/surf_null_4.replay 逐字节验证）。支持 FINAL（0x01…0x0C）与 V2；
 * 版本 > 0x0C、远古文本格式**明确报错**，不做静默错解。
 *
 * 与现有管线的对接：
 * - 解析产出 viewer 坐标系的定型数组，可独立驱动现有 Clip 结构（见 §坐标映射）；
 * - Worker/主线程导入前先用 looksLikeShavitReplay 嗅探（必须在 file.text() 之前——
 *   文本解码会破坏二进制），命中则走本模块；t4 起 JSON 规则脚本通道已移除，
 *   这是唯一的录像导入路径；
 * - 头部元信息放在 Clip.meta（UI 元信息面板数据源），逐帧按键放 Clip.buttons；
 * - ShavitParseOptions.mapping（t4）：坐标轴映射 / 朝向轴切换，默认即下方定标映射，
 *   仅影响解码输出。
 *
 * 坐标/时间映射（以仓库既有定标为准，test/replay-selftest.ts [6] + 真实文件实测）：
 * - pos：Source `[x,y,z]` → viewer `[y,z,x]`——与 wasm `rotate_yup`（GLB 导出、
 *   出生点）同一变换，det=+1，无符号翻转；帧坐标是脚底绝对世界坐标（posIsEye=false）。
 * - yaw：viewer = wrap(source + 180)。viewer forward = (−sin yaw, −cos yaw)，在该轴
 *   映射下 Source 前向 (cos yaw, sin yaw) → viewer (sin yaw, cos yaw)，两者恒等式即
 *   +180。真实回放 run 段 1078 个有效帧上「视角·运动方向」平均 cos = 0.9992（
 *   BSP 出生点路径的 bspYawToCsYaw 现已统一为同一定标 wrap(src+180)，见 core/pose.ts；
 *   旧式 270−yaw 属 det=−1 镜像、同帧实测 ≈0.05，已废弃）。
 * - pitch：viewer = −source（Source 正值=俯视，types.ts 同一口径），限幅 ±89°；roll=0。
 * - t(i) = (i − preFrames) / tickrate：prerun 为负、单调；主时钟 0 = 起跑帧（t2 §8.3
 *   方案 A）。头部 fTime 是官方计时（含 zone 口径），展示成绩用它，播放对轴用帧推算。
 * - vel：相邻帧位置差分（中央差分，端点单侧）。packed vel 字段是按键 wishmove
 *   （forwardmove | sidemove<<16），**不能**当世界速度，本模块不解码输出。
 *
 * 布局（小端，无压缩）：
 *   [0..)      ASCII 第 1 行：`"<版本>:{SHAVITREPLAYFORMAT}{FINAL}\n"`（V2 为 `"<帧数>:…{V2}"`）
 *   [行尾..)   二进制头（字段按版本门槛逐个出现，见 readFinalHeader）
 *   [..+k*12)  fail-replay offsets 区（iOffsetsLength ≥ 2 时，k = iOffsetsLength−1，跳过）
 *   [帧区..)   N × cells × 4B 定长帧：pos[3], ang[2](pitch,yaw), buttons, flags, mt,
 *              mousexy, vel(packed), stage——cell 数随版本增加
 */

import { applyClipTransform } from './build.js';
import { clampPitch, wrapDeg } from './helpers.js';
import type { Clip, ReplayHeaderMeta, RuleConfig } from './types.js';

/** 格式识别魔数（第 1 行内必含）。 */
export const SHAVIT_MAGIC = '{SHAVITREPLAYFORMAT}';

/** viewer 支持的最高 FINAL 格式版本（0x0C = 12；更高版本明确拒绝）。 */
export const SHAVIT_MAX_VERSION = 0x0c;

/** 嗅探/头部行解析只看文件前 64 字节（RFC 读侧 ReadLine(64) 同宽）。 */
export const SHAVIT_SNIFF_BYTES = 64;

/**
 * 头部没有 tickrate 字段（V2 / FINAL < 0x05）时的时间轴估算值。
 * 该字段旧格式不落盘、shavit 播放端按服务器实时 tickrate 取值，文件里无从得知——
 * 取 128（现代 bhop 服务器主流值）并产生明确 warning，不静默。
 */
const FALLBACK_TICKRATE = 128;

/** 地图名长度上限（防损坏文件在 NUL 扫描上失控）。 */
const NT_STRING_MAX = 256;

export type ShavitFormatKind = 'final' | 'v2';

/** 嗅探结果：`{SHAVITREPLAYFORMAT}` 是否出现在前 64 字节。 */
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

/** File 形态的嗅探（导入入口用；读取失败按「不是 .replay」处理，走既有 JSON 路径报错）。 */
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
  /** FINAL = 格式版本；V2 = 帧数（V2 无版本概念）。 */
  number: number;
  /** 换行符所在字节下标（二进制头从 lineEnd+1 开始）。 */
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
  // 逐字节按 latin1 取字符：魔数是 ASCII，避免任何文本解码假设
  let line = '';
  for (let i = 0; i < lineEnd; i++) line += String.fromCharCode(head[i]);
  line = line.trim(); // RFC 读侧 TrimString 同语义

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

  /** NUL 结尾字符串（sMap 写侧 = 字符串 + '\0'）。 */
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
   * 时间戳兜底（Unix 秒）：版本 < 0x0C / V2 头部没有 iTimestamp 字段，
   * shavit 读侧用文件 mtime——浏览器/Node 侧传 File.lastModified / stat.mtime。
   */
  timestampFallback?: number | null;
  /**
   * 坐标映射切换（t4：录像与 viewer 坐标系不一致时的逃生口）。
   * 默认 shavit/shavit = 实测定标映射（pos [y,z,x]、yaw=wrap(src+180)、pitch 取反）；
   * `raw` = Source 值直读。仅影响解码输出，不影响头部/时间轴。
   */
  mapping?: {
    axesMode?: 'shavit' | 'raw';
    yawMode?: 'shavit' | 'raw';
  };
}

export interface ShavitParseResult {
  header: ReplayHeaderMeta;
  /** preFrames + frameCount + postFrames。 */
  count: number;
  /** t(i) = (i − preFrames) / tickrate，秒；主时钟 0 = 起跑帧。 */
  t: Float64Array;
  /** viewer 世界坐标（mapping.axesMode 决定轴序，默认 shavit = [y,z,x]），3n。 */
  pos: Float32Array;
  /** [yaw, pitch, roll]，viewer 约定（mapping.yawMode 决定映射，默认实测定标），3n。 */
  ang: Float32Array;
  /** 世界速度（相邻帧位置差分，HU/s），3n；单帧文件为 null。 */
  vel: Float32Array | null;
  /** 逐帧按键位掩码（IN_*）。 */
  buttons: Int32Array;
  /** 逐帧实体 flags（按 u32 读，CS2 有高位 bit；Int32Array 保位型）。 */
  flags: Int32Array;
  /** 解析警告（非致命：估算值 / 尾部多余字节 / 脏帧兜底）。 */
  warnings: string[];
  /** 帧区起始字节偏移（诊断：frameStart + count×cells×4 应与文件大小闭合）。 */
  frameStart: number;
}

/** 版本 → 每帧 cell 数（×4B）。 */
function cellsForVersion(kind: ShavitFormatKind, version: number): number {
  if (kind === 'v2') return 6; // pos3 + ang2 + buttons
  if (version >= 10) return 11; // + stage
  if (version >= 6) return 10; // + mousexy, vel（播放不用）
  if (version >= 2) return 8; // + flags, mt
  return 6; // 0x01
}

/**
 * 解析 Shavit `.replay`。只做解码与坐标/时间映射，不构造 Clip
 * （UI 导入链路用 clipFromShavitReplay）。
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

  // ── 二进制头（字段顺序与版本门槛逐条对齐 replay-file.inc 读侧）──
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

  // 读侧兼容修正（RFC:318-353）：负 prerun 归零；<0x07 的 frameCount 需减 pre（≥0x05 再减 post）
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

  // ── tickrate：缺失（<v5）按 FALLBACK 估算并警告；存在但无效则报错 ──
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

  // ── offsets 区（iOffsetsLength ≥ 2 时存在 (n−1) 条 12B 记录；viewer 跳过）──
  if (offsetsLength >= 2) {
    r.skip((offsetsLength - 1) * 12, 'fail-replay offsets 区');
  }

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

/** V2：`"<帧数>:{SHAVITREPLAYFORMAT}{V2}"` + 定长 6-cell 帧数组，无二进制头（RFC:383-386）。 */
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

function buildTimeArray(n: number, preFrames: number, tickrate: number): Float64Array {
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = (i - preFrames) / tickrate;
  return t;
}

/** 帧解码 + 坐标映射 + 世界速度差分。脏数值沿用历史导入管线的兜底语义并计数。 */
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
    // flags 按 u32 读（CS2 有高位 bit，如 0x80010002）；Int32Array 保位型
    flags[i] = cells >= 8 ? dv.getUint32(base + 24, true) | 0 : 0;
    // cells ≥ 10 还有 mousexy/vel(packed)、≥ 11 还有 stage——t3 不输出（packed vel 是
    // 按键 wishmove 不是世界速度；UI 取舍见 shavit-replay-format.md §9）

    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
      // shavit（默认）：Source [x,y,z] → viewer [y,z,x]（与 wasm rotate_yup 同一变换）；
      // raw：[x,y,z] 直读（坐标序不合时的对照项）
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
      // shavit（默认，实测定标）：yaw = wrap(src+180)（run 段 view·motion cos=0.9992）、
      // pitch = −src（Source 正值=俯视）；raw：角度直读
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

  // 世界速度 = 位置差分 × tickrate（中央差分，端点单侧差分）
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
 * 解析结果 → 现有 Clip 结构（含 rule.transform 后处理（applyClipTransform）：
 * 「调整工具」的平移/旋转对 .replay 原生轨道同样生效）。
 *
 * 接管的是 parsed 数组的**拷贝**（transform 原地后处理，parsed 结果保持原样可复用）。
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
