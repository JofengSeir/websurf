/**
 * 物理参数定义表（面板渲染与 Worker 参数管理共用）。
 *
 * 独立文件的原因：主线程 UI（app.ts）与 Worker（physics-params.ts）都需要这份
 * 定义，但它不能引入 PlayerController 等物理实现（避免主线程 bundle 膨胀）。
 *
 * 默认值 = cs-movement/CS:S 基准，见 PHYSICS-CONTROL.md。
 */

import { DEFAULT_SETTINGS } from './settings/Settings.js';
import { DEFAULT_RUNTIME_PHYSICS } from './runtime.js';

/** 参数来源。 */
export type ParamSource = 'mode-default' | 'manual' | 'map';

/** 参数定义。 */
export interface ParamDef {
  name: string;
  label: string;
  unit?: string;
  kind: 'number' | 'boolean';
  /** 默认值（= cs-movement/CS:S 基准）。 */
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
    kind: 'number', default: DEFAULT_SETTINGS.runSpeed, min: 50, max: 1000, step: 5,
    description: '地面移动速度上限（sv_maxspeed，对应 runSpeed）。超过后地面加速不再生效；hns 模式下"拉不动地速"即此值被压低的典型表现。',
  },
  {
    name: 'walkSpeed', label: '走路速度', unit: 'u/s',
    kind: 'number', default: DEFAULT_SETTINGS.walkSpeed, min: 50, max: 400, step: 5,
    description: '按住 Shift 的走路速度（+speed）。',
  },
  {
    name: 'crouchSpeed', label: '蹲走速度', unit: 'u/s',
    kind: 'number', default: DEFAULT_SETTINGS.crouchSpeed, min: 40, max: 300, step: 5,
    description: '蹲下移动速度。',
  },
  {
    name: 'airAccelerate', label: '空气加速', unit: '',
    kind: 'number', default: DEFAULT_SETTINGS.airAccelerate, min: 10, max: 400, step: 5,
    description: '空中转向加速度（sv_airaccelerate）。越高，空中转向/加速越快。',
  },
  {
    name: 'gravity', label: '重力', unit: 'u/s²',
    kind: 'number', default: DEFAULT_RUNTIME_PHYSICS.gravity, min: 100, max: 2000, step: 10,
    description: '重力加速度（sv_gravity）。影响下落速度与跳跃滞空时间。',
  },
  {
    name: 'accelerate', label: '地面加速', unit: '',
    kind: 'number', default: DEFAULT_RUNTIME_PHYSICS.accelerate, min: 1, max: 100, step: 1,
    description: '地面加速系数（sv_accelerate）。越高，起步/转向越快。',
  },
  {
    name: 'friction', label: '摩擦', unit: '',
    kind: 'number', default: DEFAULT_RUNTIME_PHYSICS.friction, min: 0, max: 20, step: 0.1,
    description: '地面摩擦系数（sv_friction）。越高，滑行衰减越快。',
  },
  {
    name: 'stopSpeed', label: '停止速度', unit: 'u/s',
    kind: 'number', default: DEFAULT_RUNTIME_PHYSICS.stopSpeed, min: 0, max: 400, step: 5,
    description: '停止速度（sv_stopspeed）：速度低于此值直接归零。',
  },
  {
    name: 'jumpHeight', label: '跳跃高度', unit: 'u',
    kind: 'number', default: DEFAULT_RUNTIME_PHYSICS.jumpHeight, min: 20, max: 120, step: 1,
    description: '跳跃最高点高度（jump apex）。起跳速度 = √(2·重力·跳高)，随重力联动。',
  },
  {
    name: 'autobhop', label: '自动连跳', unit: undefined,
    kind: 'boolean', default: DEFAULT_SETTINGS.autobhop,
    description: '自动连跳（落地瞬间自动起跳，无需精确按键时机）。',
  },
  {
    name: 'bhopSpeedClamp', label: '连跳限速', unit: undefined,
    kind: 'boolean', default: DEFAULT_SETTINGS.bhopSpeedClamp,
    description: '起跳时水平速度钳制为 1.1×地速上限（sv_enablebunnyhopping 0 行为），防止连跳无限加速。',
  },
  {
    name: 'noPrestrafe', label: '落地限速', unit: undefined,
    kind: 'boolean', default: DEFAULT_SETTINGS.noPrestrafe,
    description: '落地后地面速度硬性钳制到地速上限（空中积累的速度不能转化为地面速度）。',
  },
  {
    name: 'perfEnabled', label: '空中限速模式', unit: undefined,
    kind: 'boolean', default: DEFAULT_SETTINGS.perf.enabled,
    description: '完美连跳辅助（perf）：开启后空中速度受 maxAirSpeed 限制，且完美起跳可继承落地速度。',
  },
  {
    name: 'maxAirSpeed', label: '空中限速值', unit: 'u/s',
    kind: 'number', default: DEFAULT_SETTINGS.perf.maxAirSpeed, min: 200, max: 800, step: 5,
    description: '空中速度上限（perf 模式开启后生效，sv_maxairspeed 风格）。',
  },
  {
    name: 'tickRate', label: '模拟频率', unit: 'Hz',
    kind: 'number', default: DEFAULT_SETTINGS.tickRate, min: 48, max: 128, step: 1,
    description: '物理模拟频率（固定步长 = 1/tickRate 秒）。64=默认；调高更平滑但更吃 CPU，调低跳帧感增强。',
  },
];

/** 根据参数名取定义。 */
export function findParamDef(name: string): ParamDef | undefined {
  return PARAM_DEFS.find((p) => p.name === name);
}
