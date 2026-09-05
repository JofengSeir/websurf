/**
 * 录像（replay）数据契约。
 *
 * 管线：任意 JSON → 规则层（RuleConfig → 脚本）→ 标准帧（Frame）→ Clip（定型数组）→ 播放器。
 * 播放器只认 Clip，规则怎么改都不影响播放层。
 */

// ── 规则配置（脚本文本 + 人工变换微调）────────────────────────────────

/** 人工变换微调：viewer 侧后处理，作用于脚本输出之后（「变换调整」面板写入）。 */
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

/** 输出某个轴取自输入的哪个轴。 */
export type AxisSrc = 'x' | 'y' | 'z';
export type Sign = 1 | -1;
export type AngleUnit = 'deg' | 'rad';
export type TimeMode = 'tick' | 'field';
export type TimeUnit = 's' | 'ms' | 'tick';

export interface RuleConfig {
  /** 版本，用于持久化兼容。 */
  version: 1;
  /** 规则名（持久化用）。 */
  name: string;

  /** 帧数组在 JSON 中的路径；空串 = 自动探测。 */
  framePath: string;

  // 位置
  posX: string;
  posY: string;
  posZ: string;
  /** 输出 X 取自输入哪个轴。 */
  axisX: AxisSrc;
  axisY: AxisSrc;
  axisZ: AxisSrc;
  signX: Sign;
  signY: Sign;
  signZ: Sign;
  /** 位置单位缩放（HU/米/英寸换算）。 */
  posScale: number;
  /**
   * 位置平移（HU），在「轴映射 + 符号 + 缩放」之后施加于**输出**坐标。
   * 历史字段：表单时代由「坐标系标定」求解得到；现行人工微调走 transform 字段。
   * 只对位置生效——速度是方向量，平移不影响它。
   */
  offX: number;
  offY: number;
  offZ: number;
  /** 输入 pos 是眼位而非脚底（是则输出时减 EYE_STAND）。 */
  posIsEye: boolean;

  // 朝向
  yawPath: string;
  pitchPath: string;
  rollPath: string;
  angleUnit: AngleUnit;
  /** yaw_out = wrap(yaw_in * yawScale + yawOffset)。 */
  yawScale: number;
  yawOffset: number;
  /** pitch 符号（Source 系正值为俯视，需翻转）。 */
  pitchSign: Sign;
  rollSign: Sign;

  // 速度（可选；全空则 vel = null）
  velX: string;
  velY: string;
  velZ: string;

  // 时间
  timeMode: TimeMode;
  /** tick 模式下的 tickrate（帧/秒）。 */
  tickrate: number;
  timePath: string;
  timeUnit: TimeUnit;

  /** 编译产物 / 手改后的脚本源码；空串 = 使用内置默认规则（DEFAULT_RULE_SRC）。 */
  scriptSrc: string;
  /** true = 已被手工改写（历史字段，保留以兼容旧持久化数据）。 */
  customized: boolean;
  /** 人工微调变换（缺省 = 恒等）。 */
  transform?: RuleTransform;
}

// ── 标准帧（规则层唯一产出）─────────────────────────────────────────

export interface Frame {
  /** 秒，单调递增。 */
  t: number;
  /** viewer 世界坐标 Y-up，人物脚底。 */
  pos: [number, number, number];
  /** [yaw, pitch, roll] 度；yaw 0 = 面朝 −Z，逆时针为正。 */
  ang: [number, number, number];
  /** 世界速度 [vx,vy,vz]，缺失为 null。 */
  vel: [number, number, number] | null;
}

/** 规则函数的形状：输入原始帧 + 序号 + 辅助函数，产出标准帧。 */
export type FrameMapper = (raw: unknown, index: number, H: unknown) => Frame;

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
  /** 总时长（秒）= 末帧 t。 */
  duration: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  maxSpeed: number;
  /** 导入时实际用到的帧数组路径（自动探测时会回填）。 */
  resolvedPath: string;
  /** 生成这份 clip 的规则快照（重放/导出时可读）。 */
  rule: RuleConfig;
}

/** 播放器采样结果。 */
export interface Sample {
  pos: [number, number, number];
  ang: [number, number, number];
  vel: [number, number, number] | null;
  /** 当前落在第几帧（插值左端）。 */
  index: number;
}

// ── 多轨迹（Q2：同时加载多条轨迹做对比）────────────────────────────

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

/** 某条轨道在主时钟 t 时刻的采样结果；轨道已播完或未开始为 null。 */
export interface TrackSample {
  track: Track;
  sample: Sample | null;
}

// ── 默认值 ──────────────────────────────────────────────────────────

export function defaultRule(): RuleConfig {
  return {
    version: 1,
    name: '默认规则',
    framePath: '',
    posX: 'pos[0]',
    posY: 'pos[1]',
    posZ: 'pos[2]',
    axisX: 'x',
    axisY: 'y',
    axisZ: 'z',
    signX: 1,
    signY: 1,
    signZ: 1,
    posScale: 1,
    offX: 0,
    offY: 0,
    offZ: 0,
    posIsEye: false,
    yawPath: 'ang[1]',
    pitchPath: 'ang[0]',
    rollPath: '',
    angleUnit: 'deg',
    yawScale: 1,
    yawOffset: 0,
    pitchSign: 1,
    rollSign: 1,
    velX: 'vel[0]',
    velY: 'vel[1]',
    velZ: 'vel[2]',
    timeMode: 'tick',
    tickrate: 128,
    timePath: '',
    timeUnit: 's',
    scriptSrc: '',
    customized: false,
  };
}
