/**
 * 物理参数定义表：面板渲染与 Worker 参数管理共用同一份，本文件不 import 任何物理实现。
 *
 * 消费点两处：主线程 `apps/debug/src/app.ts` 的 `initPhysicsPanel` 读全部字段渲染控件
 * （`description` 落成参数行的 title 属性），Worker 侧 `apps/debug/src/physics/physics-params.ts`
 * 读 `default` 与 `min`/`max` 做回退与钳制。
 *
 * 16 项里 13 项经 `PARAM_TO_RUST` 映射成 `src/phys/mod.rs` 的 `set_params` 键；`tickRate` /
 * `computeRateCap` / `maxHorizontalSpeed` 是 JS 驱动层参数，不进 Rust（前者=权威物理步长/难度，
 * 中者=主线程计算频率上限，后者=横向速度上限、由共享 `EntityGameplay` 与地图值取小后下发）。
 * `PHYSICS_PARAM_DEFAULTS`（2026-11-18 起唯一来源，与 `config.ts` 的 `DEFAULT_CONFIG.physics`
 * 及 Worker / 主线程预测参数同源，避免「面板显示值」与「实际生效值」漂移）。
 */
import { PHYSICS_PARAM_DEFAULTS } from '../../../../src/ts-shared/phys/param-defaults.js';
import {
  COMPUTE_CAP_DEFAULT,
  COMPUTE_CAP_MAX,
  COMPUTE_CAP_MIN,
} from '../../../../src/ts-shared/app/compute-cap.js';

/** 参数来源：定义默认值 / 面板手动 / 地图设置（面板标签见 `apps/debug/src/app.ts` 的 `SOURCE_LABEL`）。 */
export type ParamSource = 'mode-default' | 'manual' | 'map';

/** 单个参数的定义（不含当前值）。 */
export interface ParamDef {
  /** 参数名：面板 `data-param` 键，同时是 `PhysicsParams.overrides` 的键。 */
  name: string;
  /** 面板显示名。 */
  label: string;
  /** 单位后缀；布尔项与无量纲项不填。 */
  unit?: string;
  /** 控件类型：boolean 渲染复选框，number 渲染 range 与 number 输入联动。 */
  kind: 'number' | 'boolean';
  /** 默认值；未被覆盖时由 `PhysicsParams.snapshot` 上报。 */
  default: number | boolean;
  /** 数值下限（number 型使用；同时写进 range 与 number 输入的 min 属性）。 */
  min?: number;
  /** 数值上限（同上，写 max 属性）。 */
  max?: number;
  /** range 控件的步长。 */
  step?: number;
  /** 作用说明：渲染成参数行的 title 属性（tooltip）。 */
  description: string;
}

/** 参数定义 + 当前值 + 来源（`physics-snapshot` 的回传项）。 */
export interface ParamState extends ParamDef {
  /** 当前值（覆盖值或定义默认值）。 */
  value: number | boolean;
  /** 当前来源。 */
  source: ParamSource;
}

/** 全部参数定义（16 项）；面板行与快照都按本数组顺序。 */
export const PARAM_DEFS: ParamDef[] = [
  {
    name: 'maxSpeed', label: '地速上限', unit: 'u/s',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.maxSpeed, min: 50, max: 1000, step: 1,
    description: '地面移动速度上限（sv_maxspeed，对应 run_speed）。超过后地面加速不再生效；hns 模式下"拉不动地速"即此值被压低的典型表现。',
  },
  {
    name: 'maxHorizontalSpeed', label: '横向限速', unit: 'u/s',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.maxHorizontalSpeed, min: 0, max: 20000, step: 50,
    description: '横向（水平）速度模长上限：板上/斜坡加速后按此值收口，竖直分量不受限（Source 的 sv_maxvelocity 语义）。与地图 sv_maxvelocity 取更小者生效；0 = 关闭，只跟随地图。它是用户设置项、与地图无关（owner 2026-11-20）。',
  },
  {
    name: 'walkSpeed', label: '走路速度', unit: 'u/s',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.walkSpeed, min: 50, max: 400, step: 1,
    description: '按住 Shift 的走路速度（+speed）。',
  },
  {
    name: 'crouchSpeed', label: '蹲走速度', unit: 'u/s',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.crouchSpeed, min: 40, max: 300, step: 1,
    description: '蹲下移动速度。',
  },
  {
    name: 'airAccelerate', label: '空气加速', unit: '',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.airAccelerate, min: 10, max: 400, step: 1,
    description: '空中转向加速度（sv_airaccelerate）。越高，空中转向/加速越快。',
  },
  {
    name: 'gravity', label: '重力', unit: 'u/s²',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.gravity, min: 100, max: 2000, step: 1,
    description: '重力加速度（sv_gravity）。影响下落速度与跳跃滞空时间。',
  },
  {
    name: 'accelerate', label: '地面加速', unit: '',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.accelerate, min: 1, max: 100, step: 1,
    description: '地面加速系数（sv_accelerate）。越高，起步/转向越快。',
  },
  {
    name: 'friction', label: '摩擦', unit: '',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.friction, min: 0, max: 20, step: 0.1,
    description: '地面摩擦系数（sv_friction）。越高，滑行衰减越快。',
  },
  {
    name: 'stopSpeed', label: '停止速度', unit: 'u/s',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.stopSpeed, min: 0, max: 400, step: 1,
    description: '停止速度（sv_stopspeed）：速度低于此值直接归零。',
  },
  {
    name: 'jumpHeight', label: '跳跃高度', unit: 'u',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.jumpHeight, min: 20, max: 120, step: 1,
    description: '跳跃最高点高度（jump apex，对应 Rust jump_height）。起跳速度 = √(2·重力·跳高)，随重力联动。',
  },
  {
    name: 'autobhop', label: '自动连跳', unit: undefined,
    kind: 'boolean', default: PHYSICS_PARAM_DEFAULTS.autobhop,
    description: '自动连跳（落地瞬间自动起跳，无需精确按键时机）。',
  },
  {
    name: 'bhopSpeedClamp', label: '连跳限速', unit: undefined,
    kind: 'boolean', default: PHYSICS_PARAM_DEFAULTS.bhopSpeedClamp,
    description: '起跳时水平速度钳制为 1.1×地速上限（sv_enablebunnyhopping 0 行为），防止连跳无限加速。',
  },
  {
    name: 'tickRate', label: '模拟频率', unit: 'Hz',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.tickRate, min: 48, max: 128, step: 1,
    description: '物理模拟频率（固定步长 = 1/tickRate 秒，JS 驱动层参数，不进 Rust）。64=默认；调高更平滑但更吃 CPU，调低跳帧感增强。它控制权威物理的步长与手感/难度，不是「计算帧率上限」（后者是 computeRateCap）。',
  },
  {
    name: 'computeRateCap', label: '计算帧率上限', unit: 'Hz',
    kind: 'number', default: COMPUTE_CAP_DEFAULT, min: COMPUTE_CAP_MIN, max: COMPUTE_CAP_MAX, step: 1,
    description: '主线程固定步长模拟时钟的目标频率（与 rAF 呈现解耦、独立于上面的物理模拟频率）：默认 1000Hz、最高 2000Hz（owner 2026-11-19 指定），只影响主线程每秒算多少步预测/呈现，不改权威物理步长与难度。',
  },
  {
    name: 'pushOut', label: '贴面推开量', unit: 'u',
    kind: 'number', default: PHYSICS_PARAM_DEFAULTS.pushOut, min: 0, max: 1, step: 0.01,
    description: '撞到面之后沿该面法线把玩家推出的距离（HU），用于从几何里脱身（贴面死锁）。0 = 不推。推得越大越容易脱离嵌入，但也越容易在贴墙时被推着走。',
  },
  {
    name: 'pushOutOnlyWhenSolid', label: '推开仅在嵌入时', unit: undefined,
    kind: 'boolean', default: PHYSICS_PARAM_DEFAULTS.pushOutOnlyWhenSolid,
    description: '只在"起点已经在实体里"（trace 一出发就 startsolid）时才推开。旧口径是每次撞面都推一个固定 0.1 HU——与步长无关，所以高刷屏下每帧都推一次（320 fps ⇒ 32 HU/s），抵墙时就是"往墙里挤一下又被弹回"。关掉本项即回到旧口径（对照用）。',
  },
];

/** 参数名白名单（持久化 `allowedNames` 用；顺序同 `PARAM_DEFS`，杜绝面板与存储两张表漂移）。 */
export const PARAM_NAMES: readonly string[] = PARAM_DEFS.map((def) => def.name);

/** 按 `name` 线性查找定义；未命中返回 undefined。 */
export function findParamDef(name: string): ParamDef | undefined {
  return PARAM_DEFS.find((p) => p.name === name);
}
