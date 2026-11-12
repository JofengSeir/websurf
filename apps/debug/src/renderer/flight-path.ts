/**
 * 飞行轨迹录制 / 复播（debug 面板「飞行轨迹」）。
 *
 * 和 `path-recorder.ts` 的分工：那个记的是**物理节点**（脚底中心，用来对比两条物理线是否一致）；
 * 这个记的是**相机本体**（世界位置 + yaw/pitch，度），用途是「先飞一遍 → 导出 JSON → 之后原样
 * 复播并截图」。有些场景（越界区域、模型背后、贴图拼接处）用坐标描述很麻烦，录一条轨迹给
 * 自动化脚本按时间 seek 即可复现，且不依赖物理：复播直接把相机摆到样本位姿（走 `poseHold`，
 * 与 `globalThis.__vbspPose.setPose()` 同一条路），所以 noclip 穿过几何也能重放。
 *
 * 采样口径：
 * - 采样点就是**相机位姿**（不是脚底），复播时原样写回，不需要再补 eyeHeight；
 * - 每 `intervalMs`（默认 10ms ≈ 100Hz）最多落一点，两点之间的帧只把最后一点原位更新
 *   （保证轨迹末端不滞后、文件又不会按 320Hz 膨胀）；
 * - 文件里 `samples` 用紧凑数组 `[t, x, y, z, yaw, pitch]`：t 为相对起点的毫秒，角度为度。
 */

export const FLIGHT_PATH_FORMAT = 'websurf-flight-path';
export const FLIGHT_PATH_VERSION = 1;
/** 默认采样间隔（毫秒）：100Hz 足够复播，320Hz 全记会让 1 分钟轨迹涨到 2MB 级。 */
export const FLIGHT_SAMPLE_INTERVAL_MS = 10;

/** 一个采样点：`t` = 相对录制起点的毫秒；`yaw` / `pitch` 为度（与 HUD / 导出文件同口径）。 */
export interface FlightSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 导出时写进文件的会话信息（回放端不依赖它，只用于人读与排错）。 */
export interface FlightFileMeta {
  /** 地图文件名（如 `surf_boreas.bsp`）：换图后复播没有意义，靠它认领轨迹。 */
  map?: string;
  /** 录制端标识（固定 `debug`）。 */
  app?: string;
  /** 自由备注（面板/脚本传入）。 */
  note?: string;
  [key: string]: unknown;
}

/** 面板/脚本读的状态快照。 */
export interface FlightPathStatus {
  recording: boolean;
  count: number;
  durationMs: number;
  hasPath: boolean;
}

/** 载入结果：轨迹点数、时长与文件里带的 meta（`null` 表示没写）。 */
export interface FlightLoadResult {
  count: number;
  durationMs: number;
  meta: FlightFileMeta | null;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** 角度差归一到 (-180, 180]：yaw 会绕圈，插值必须走最短弧。 */
function wrapDeg(delta: number): number {
  let d = delta % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 轨迹文件的结构（`loadJson` 校验后会转成 `FlightSample[]`）。 */
interface FlightFileShape {
  format?: unknown;
  version?: unknown;
  meta?: unknown;
  samples?: unknown;
}

/**
 * 记录器 + 播放时钟的样本源。
 *
 * 录制：`start(now)` → 每帧 `add(now, ...)` → `stop()`；
 * 复播：`sampleAt(tMs)` 按时间线性插值（位置直线、角度最短弧），播放的时钟由调用方持有
 * （`renderer-main.ts` 用 rAF 的 `now` 推），这样 pause / seek / 变速都不用改本类。
 */
export class FlightPathRecorder {
  private samples: FlightSample[] = [];
  private recording = false;
  /** 录制起点（墙钟毫秒）：所有样本的 `t` 都是相对它的偏移。 */
  private startedAtMs = 0;
  /** 采样间隔（毫秒）。 */
  private readonly intervalMs: number;
  /** 本次录制已落的最后一点（间隔内的帧就地更新它，避免末端滞后）。 */
  private last: FlightSample | null = null;

  constructor(intervalMs: number = FLIGHT_SAMPLE_INTERVAL_MS) {
    this.intervalMs = Math.max(1, intervalMs);
  }

  /** 是否正在录制。 */
  get isRecording(): boolean {
    return this.recording;
  }

  /** 已落点数。 */
  get count(): number {
    return this.samples.length;
  }

  /** 轨迹总时长（毫秒）：最后一点相对起点的偏移。 */
  get durationMs(): number {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].t : 0;
  }

  /** 开始录制：清空旧轨迹并从 `nowMs` 重新计时。 */
  start(nowMs: number): void {
    this.samples = [];
    this.last = null;
    this.startedAtMs = nowMs;
    this.recording = true;
  }

  /** 停止录制：已落的点保留（导出/复播仍可用）。 */
  stop(): void {
    this.recording = false;
  }

  /** 清空轨迹（不改变录制状态）。 */
  clear(): void {
    this.samples = [];
    this.last = null;
    this.startedAtMs = 0;
  }

  /**
   * 落一个相机位姿（每帧调用；未录制时是空操作）。
   *
   * 同一 `intervalMs` 窗口内只保留一点；窗口内后续帧就地覆盖这一点的数值，因此轨迹末端
   * 与当前相机一致，而点数仍按 100Hz 增长。
   */
  add(nowMs: number, x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void {
    if (!this.recording) return;
    if (!Number.isFinite(x + y + z + yawDeg + pitchDeg)) return;
    // 第一点作为时间原点：`start()` 拿的是 `performance.now()`，而 tick 传进来的是 rAF 时间戳，
    // 两者在本页可能有几百毫秒到几秒的错位（页面被节流/相机被 hold 时尤其明显）。不归一的话
    // 轨迹开头会带一段「谁也不是」的空档，`sampleAt` 会被夹在第一点上。
    if (this.samples.length === 0) this.startedAtMs = nowMs;
    const t = Math.max(0, nowMs - this.startedAtMs);
    const last = this.last;
    if (last && t - last.t < this.intervalMs) {
      last.x = x;
      last.y = y;
      last.z = z;
      last.yaw = yawDeg;
      last.pitch = pitchDeg;
      return;
    }
    const sample: FlightSample = { t, x, y, z, yaw: yawDeg, pitch: pitchDeg };
    this.samples.push(sample);
    this.last = sample;
  }

  /** 状态快照（面板与 `__vbspFlight.status()` 共用）。 */
  status(): FlightPathStatus {
    return { recording: this.recording, count: this.samples.length, durationMs: this.durationMs, hasPath: this.samples.length > 0 };
  }

  /** 导出 JSON：紧凑数组 + meta；`meta.map` 由调用方从当前地图名填。 */
  toJson(meta: FlightFileMeta = {}): string {
    const doc = {
      format: FLIGHT_PATH_FORMAT,
      version: FLIGHT_PATH_VERSION,
      createdAt: new Date().toISOString(),
      intervalMs: this.intervalMs,
      count: this.samples.length,
      durationMs: round2(this.durationMs),
      meta: { app: 'debug', ...meta },
      samples: this.samples.map((s) => [round2(s.t), round2(s.x), round2(s.y), round2(s.z), round2(s.yaw), round2(s.pitch)]),
    };
    return JSON.stringify(doc);
  }

  /**
   * 载入轨迹 JSON（替换当前轨迹，且**不**开始录制）。
   *
   * 接受本模块导出的格式，也接受 `{ samples: [{t,x,y,z,yaw,pitch}, ...] }` 这种可读写法；
   * 格式不认识时抛错（面板会把错误显示在状态行，脚本会 reject）。
   */
  loadJson(text: string): FlightLoadResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('轨迹 JSON 解析失败：' + (err instanceof Error ? err.message : String(err)));
    }
    const doc = (parsed ?? {}) as FlightFileShape;
    if (typeof doc.format === 'string' && doc.format !== FLIGHT_PATH_FORMAT) {
      throw new Error(`轨迹格式不认识：format=${doc.format}（期望 ${FLIGHT_PATH_FORMAT}）`);
    }
    if (doc.version !== undefined && doc.version !== FLIGHT_PATH_VERSION) {
      throw new Error(`轨迹版本不支持：version=${String(doc.version)}（期望 ${FLIGHT_PATH_VERSION}）`);
    }
    const raw = doc.samples;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('轨迹里没有 samples');
    const samples: FlightSample[] = [];
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i] as unknown;
      const sample = parseSample(row, i);
      if (sample) samples.push(sample);
    }
    if (samples.length === 0) throw new Error('轨迹 samples 没有一条合法记录（需要 6 个数值）');
    samples.sort((a, b) => a.t - b.t);
    this.samples = samples;
    this.last = samples[samples.length - 1];
    return {
      count: samples.length,
      durationMs: this.durationMs,
      meta: doc.meta && typeof doc.meta === 'object' ? (doc.meta as FlightFileMeta) : null,
    };
  }

  /**
   * 按时间取插值位姿：`tMs` 夹到 `[0, durationMs]`；空轨迹返回 null。
   *
   * 位置线性插值；yaw 走最短弧（跨 ±180 不会绕一圈），pitch 线性。
   */
  sampleAt(tMs: number): FlightSample | null {
    const n = this.samples.length;
    if (n === 0) return null;
    if (n === 1) return { ...this.samples[0] };
    const first = this.samples[0];
    const lastSample = this.samples[n - 1];
    if (tMs <= first.t) return { ...first };
    if (tMs >= lastSample.t) return { ...lastSample };
    // 二分：找最后一个 t <= tMs 的样本
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].t <= tMs) lo = mid;
      else hi = mid;
    }
    const a = this.samples[lo];
    const b = this.samples[hi];
    const span = b.t - a.t;
    if (span <= 0) return { ...a };
    const k = (tMs - a.t) / span;
    return {
      t: tMs,
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      z: a.z + (b.z - a.z) * k,
      yaw: round3(a.yaw + wrapDeg(b.yaw - a.yaw) * k),
      pitch: round3(a.pitch + (b.pitch - a.pitch) * k),
    };
  }
}

/** 单条样本归一：数组 `[t,x,y,z,yaw,pitch]` 或对象 `{t,x,y,z,yaw,pitch}`；非法返回 null。 */
function parseSample(row: unknown, index: number): FlightSample | null {
  const pick = (values: number[]): FlightSample | null => {
    if (values.length < 6 || values.some((v) => !Number.isFinite(v))) return null;
    const [t, x, y, z, yaw, pitch] = values;
    return { t, x, y, z, yaw, pitch };
  };
  if (Array.isArray(row)) return pick(row.map((v) => Number(v)));
  if (row && typeof row === 'object') {
    const o = row as Record<string, unknown>;
    const values = [o.t, o.x, o.y, o.z, o.yaw, o.pitch].map((v) => Number(v));
    const sample = pick(values);
    if (!sample) return null;
    return { ...sample, t: Math.max(0, sample.t || index) };
  }
  return null;
}
