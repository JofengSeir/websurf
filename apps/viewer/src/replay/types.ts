/**
 * 录像（replay）数据契约：解析产物（`Clip` / `ReplayHeaderMeta`）、导入规则（`RuleConfig`）、
 * 播放器采样（`Sample`）与多轨道（`Track` / `TrackSample`）。
 *
 * 管线：Shavit `.replay`（`apps/viewer/src/replay/shavit-replay.ts` 原生解析）→ `Clip`（定型数组）
 * → `apps/viewer/src/replay/player.ts` 播放。播放基准 = 帧自身坐标：解码时只做坐标映射，
 * 平移/旋转来自 `RuleConfig.transform`（仅用户显式设置时非恒等）。
 */

// ── 规则配置（坐标映射切换 + 人工变换微调）──────────────────────────

/** 人工变换微调：viewer 侧后处理（「调整工具」面板写入；仅用户显式设置时非恒等）。 */
export interface RuleTransform {
  /** 平移（HU），加到输出坐标上。 */
  offset: [number, number, number];
  /**
   * 绕 Y 旋转（度）：pos 与 vel 同步旋转，yaw 同步加该角。
   * 方向对照 viewer 约定（yaw 0 = 面朝 −Z，逆时针为正）：yawDeg=90 把
   * 面朝 −Z 的轨迹变为面朝 −X。
   */
  yawDeg: number;
}

/**
 * 坐标轴映射切换（解码层，非变换；录像与 viewer 坐标系不一致时的逃生口）。
 * - `shavit`（默认）：Source `[x,y,z]` → viewer `[y,z,x]`——与 `apps/viewer/crates/wasm/src/lib.rs`
 *   的 `rotate_yup`、地图 GLB 导出同一变换（坐标循环置换 ⇒ det=+1）。
 * - `raw`：`[x,y,z]` 直读（坐标序不合时的对照项）。
 * 对照用例见 `apps/viewer/test/replay-selftest.ts` 的「坐标映射切换」组。
 */
export type AxesMode = 'shavit' | 'raw';

/**
 * 朝向轴切换（解码层，非变换）。实现在 `apps/viewer/src/replay/shavit-replay.ts` 的 `decodeFrames`：
 * - `shavit`（默认）：`yaw = wrapDeg(srcYaw + 180)`（与 `src/ts-shared/phys/angles.ts` 的
 *   `bspYawToCsYaw` 同一定标）、`pitch = clampPitch(−srcPitch)`（Source 正值 = 俯视）、roll 恒 0。
 * - `raw`：`[yaw, pitch, 0]` 直读（角度约定本就一致的数据用）。
 */
export type YawMode = 'shavit' | 'raw';

export interface RuleConfig {
  /** 规则版本：字面量类型只接受 `2`（持久化兼容用）。 */
  version: 2;
  /** 规则名（持久化用）。 */
  name: string;
  /** 坐标轴映射切换（默认 shavit = 与地图 GLB 同构）。 */
  axesMode: AxesMode;
  /** 朝向轴切换（默认 shavit = 定标映射）。 */
  yawMode: YawMode;
  /** 人工微调变换（缺省 = 恒等；仅用户显式设置时叠加）。 */
  transform?: RuleTransform;
}

/** 内置默认规则：标准轴序 + 定标朝向映射，不含人工变换（`transform` 不设）。 */
export function defaultRule(): RuleConfig {
  return { version: 2, name: '内置默认', axesMode: 'shavit', yawMode: 'shavit' };
}

// ── Shavit .replay 头部元信息（原生解析路径的元数据契约）──────────────

/**
 * Shavit `.replay` 头部元信息。字段的读取顺序与逐字段版本门槛见
 * `apps/viewer/src/replay/shavit-replay.ts` 的 `parseShavitReplay`（门槛由各 `has(n)` 分支与
 * `cellsForVersion` 给出）；FINAL 有这些字段，V2 无对应字段 → 0 / null。
 */
export interface ReplayHeaderMeta {
  /** FINAL 格式版本（1..0x0C）；V2 无版本概念 → 0。 */
  version: number;
  /** 格式变体。 */
  format: 'final' | 'v2';
  /** 地图基础名（头部 sMap，不带 `_N`/`_sN` 后缀；V2 无 → ''）。 */
  map: string;
  /** 样式（V2 / <v3 无 → 0）。 */
  style: number;
  /** 轨道：0 = 主图，>0 = bonus N。 */
  track: number;
  /** 起跑前帧数（prerun）。 */
  preFrames: number;
  /** 正式跑帧数。 */
  frameCount: number;
  /** 结束后帧数（<v5 无 → 0）。 */
  postFrames: number;
  /** 总帧数 = preFrames + frameCount + postFrames。 */
  totalFrames: number;
  /** 官方成绩（秒，头部 fTime，含 zone 口径）；无官方计时（V2）→ null。 */
  time: number | null;
  /** steamID3；文件没记（<v4 / V2）→ null。 */
  steamId: number | null;
  /** 显示名 `[U:1:<id>]`——文件里没有玩家名，只有账号 ID。 */
  steamIdDisplay: string | null;
  /** tick/s；V2 / <v5 头部没有该字段 → 估算值（见解析 warnings）。 */
  tickrate: number;
  /**
   * 起点区 / 终点区的**亚 tick 份额**（非秒）：头部两个 f32，`<v8` 无该字段 → `[0, 0]`。
   * 与头部 fTime 的关系 `fTime ≈ (frameCount + zo0 − (1 − zo1)) × tickInterval` 由
   * `apps/viewer/test/replay-selftest.ts` 闭环校验；本仓唯一消费者是
   * `apps/viewer/src/ui/replaymeta.ts`（值非零时并入 title，不上条面）。
   */
  zoneOffset: [number, number];
  /** stage（0 = 非 stage；<v10 无 → 0）。 */
  stage: number;
  /** 创纪录 Unix 秒（≥v12 有；更早 / V2 用文件 mtime 兜底，无则 null）。 */
  timestamp: number | null;
  /** fail-replay offsets 记录数+1（解析时跳过该区；<v11 无 → 0）。 */
  offsetsLength: number;
}

// ── Clip（导入产物，定型数组存帧以便 Worker 零拷贝回传）────────────────

export interface Clip {
  id: string;
  name: string;
  count: number;
  /** 时间（秒），Float64 保精度。 */
  t: Float64Array;
  /** 位置，3n。 */
  pos: Float32Array;
  /** 朝向，3n。 */
  ang: Float32Array;
  /** 速度，3n；无速度数据为 null。 */
  vel: Float32Array | null;
  /** 总时长（秒）= 末帧 t；`count = 0` 时为 0。 */
  duration: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  maxSpeed: number;
  /** 导入来源标识：'.replay'（原生 Shavit）。 */
  resolvedPath: string;
  /** 生成这份 clip 的规则快照（重放时可读）。 */
  rule: RuleConfig;
  /**
   * 逐帧按键位掩码（IN_*：IN_JUMP=2、IN_DUCK=4、IN_FORWARD=8…）。
   * 仅 Shavit .replay 原生路径填充。
   */
  buttons: Int32Array | null;
  /** Shavit .replay 头部元信息（地图/track/成绩/玩家/tick…）。 */
  meta: ReplayHeaderMeta | null;
}

/** 播放器采样结果。 */
export interface Sample {
  pos: [number, number, number];
  ang: [number, number, number];
  vel: [number, number, number] | null;
  /** 当前落在第几帧（插值左端）。 */
  index: number;
}

// ── 多轨迹：同时加载多条做对比 ───────────────────────────────────────

/** 一条轨道 = 一份 clip + 展示属性 + 时间对齐偏移。 */
export interface Track {
  id: string;
  name: string;
  clip: Clip;
  /** 轨迹线与幽灵的配色。 */
  color: number;
  visible: boolean;
  /**
   * 时间偏移（秒）：本 clip 的第 0 帧对应主时钟的 offset 秒。
   * 用来对齐起跑时刻不同的两次跑法（offset 大的后起步）。
   */
  offset: number;
}

/** 某条轨道在主时钟 t 时刻的采样结果；未到该轨道片头时为 null，已播完则夹到末帧（停在终点）。 */
export interface TrackSample {
  track: Track;
  sample: Sample | null;
}
