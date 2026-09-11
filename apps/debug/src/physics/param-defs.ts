/**
 * 物理参数定义表（面板渲染与 Worker 参数管理共用）。
 *
 * 物理已迁移到共享 Rust 物理（websurf-phys）：参数子集 = Rust `PhysParams`
 * 支持的可调项（src/phys/player.rs）。默认值 = cs-movement/CS:S 基准，与
 * 共享 crate `PhysParams::default()` 一致。
 *
 * 独立成文件：主线程 UI（app.ts）与 Worker（physics-params.ts）都需要它，
 * 但不能引入物理实现（避免主线程 bundle 膨胀）。
 */

/** 参数来源。 */
export type ParamSource = 'mode-default' | 'manual' | 'map';

/** 参数定义。 */
export interface ParamDef {
  name: string;
  label: string;
  unit?: string;
  kind: 'number' | 'boolean';
  /** 默认值（= cs-movement/CS:S 基准，与 Rust PhysParams::default 一致）。 */
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** 作用说明（面板 tooltip / 文档共用）。 */
  description: string;
}

/** 参数当前状态（snapshot 回传项）。 */
export interface ParamState extends ParamDef {
  value: number | boolean;
  source: ParamSource;
}

/** 全部可调参数定义（面板顺序 = 本数组顺序）。 */
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
    name: 'noPrestrafe', label: '落地限速', unit: undefined,
    kind: 'boolean', default: true,
    description: '落地后地面速度硬性钳制到地速上限（空中积累的速度不能转化为地面速度）。',
  },
  {
    name: 'tickRate', label: '模拟频率', unit: 'Hz',
    kind: 'number', default: 64, min: 48, max: 128, step: 1,
    description: '物理模拟频率（固定步长 = 1/tickRate 秒，JS 驱动层参数，不进 Rust）。64=默认；调高更平滑但更吃 CPU，调低跳帧感增强。',
  },
];

/** 根据参数名取定义。 */
export function findParamDef(name: string): ParamDef | undefined {
  return PARAM_DEFS.find((p) => p.name === name);
}
