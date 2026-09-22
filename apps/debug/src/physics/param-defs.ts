/**
 * 物理参数定义表：面板渲染与 Worker 参数管理共用同一份，本文件不 import 任何物理实现。
 *
 * 消费点两处：主线程 `apps/debug/src/app.ts` 的 `initPhysicsPanel` 读全部字段渲染控件
 * （`description` 落成参数行的 title 属性），Worker 侧 `apps/debug/src/physics/physics-params.ts`
 * 读 `default` 与 `min`/`max` 做回退与钳制。
 *
 * 12 项里 11 项经 `PARAM_TO_RUST` 映射成 `src/phys/mod.rs` 的 `set_params` 键；`tickRate` 是
 * JS 驱动层参数，不进 Rust。默认值与 `src/phys/player.rs` 的 `PhysParams::default` 逐项同值
 * （`jumpHeight` 对应常量 `JUMP_HEIGHT`）。
 */

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

/** 全部参数定义（12 项）；面板行与快照都按本数组顺序。 */
export const PARAM_DEFS: ParamDef[] = [
  {
    name: 'maxSpeed', label: '地速上限', unit: 'u/s',
    kind: 'number', default: 250, min: 50, max: 1000, step: 1,
    description: '地面移动速度上限（sv_maxspeed，对应 run_speed）。超过后地面加速不再生效；hns 模式下"拉不动地速"即此值被压低的典型表现。',
  },
  {
    name: 'walkSpeed', label: '走路速度', unit: 'u/s',
    kind: 'number', default: 130, min: 50, max: 400, step: 1,
    description: '按住 Shift 的走路速度（+speed）。',
  },
  {
    name: 'crouchSpeed', label: '蹲走速度', unit: 'u/s',
    kind: 'number', default: 85, min: 40, max: 300, step: 1,
    description: '蹲下移动速度。',
  },
  {
    name: 'airAccelerate', label: '空气加速', unit: '',
    kind: 'number', default: 150, min: 10, max: 400, step: 1,
    description: '空中转向加速度（sv_airaccelerate）。越高，空中转向/加速越快。',
  },
  {
    name: 'gravity', label: '重力', unit: 'u/s²',
    kind: 'number', default: 800, min: 100, max: 2000, step: 1,
    description: '重力加速度（sv_gravity）。影响下落速度与跳跃滞空时间。',
  },
  {
    name: 'accelerate', label: '地面加速', unit: '',
    kind: 'number', default: 10, min: 1, max: 100, step: 1,
    description: '地面加速系数（sv_accelerate）。越高，起步/转向越快。',
  },
  {
    name: 'friction', label: '摩擦', unit: '',
    kind: 'number', default: 4, min: 0, max: 20, step: 0.1,
    description: '地面摩擦系数（sv_friction）。越高，滑行衰减越快。',
  },
  {
    name: 'stopSpeed', label: '停止速度', unit: 'u/s',
    kind: 'number', default: 100, min: 0, max: 400, step: 1,
    description: '停止速度（sv_stopspeed）：速度低于此值直接归零。',
  },
  {
    name: 'jumpHeight', label: '跳跃高度', unit: 'u',
    kind: 'number', default: 57, min: 20, max: 120, step: 1,
    description: '跳跃最高点高度（jump apex，对应 Rust jump_height）。起跳速度 = √(2·重力·跳高)，随重力联动。',
  },
  {
    name: 'autobhop', label: '自动连跳', unit: undefined,
    kind: 'boolean', default: true,
    description: '自动连跳（落地瞬间自动起跳，无需精确按键时机）。',
  },
  {
    name: 'bhopSpeedClamp', label: '连跳限速', unit: undefined,
    kind: 'boolean', default: true,
    description: '起跳时水平速度钳制为 1.1×地速上限（sv_enablebunnyhopping 0 行为），防止连跳无限加速。',
  },
  {
    name: 'tickRate', label: '模拟频率', unit: 'Hz',
    kind: 'number', default: 64, min: 48, max: 128, step: 1,
    description: '物理模拟频率（固定步长 = 1/tickRate 秒，JS 驱动层参数，不进 Rust）。64=默认；调高更平滑但更吃 CPU，调低跳帧感增强。',
  },
];

/** 按 `name` 线性查找定义；未命中返回 undefined。 */
export function findParamDef(name: string): ParamDef | undefined {
  return PARAM_DEFS.find((p) => p.name === name);
}
