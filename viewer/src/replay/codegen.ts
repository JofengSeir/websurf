/**
 * 规则 → 脚本的编译器。
 *
 * 「UI 表单」与「脚本逃生舱」不是两套机制：表单只负责**生成**下面这段代码，
 * 用户改完代码就是权威来源（customized 标记后表单不再覆盖）。两者能力完全对等。
 */

import { REPLAY_HELPERS } from './helpers.js';
import type { AxisSrc, Frame, FrameMapper, RuleConfig, Sign } from './types.js';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toPrecision(10)));
}

function q(s: string): string {
  return JSON.stringify(s);
}

type AxisVars = Record<AxisSrc, string>;

/**
 * 轴映射表达式：取输入某轴 → 乘符号 → 乘缩放 → 加平移。
 * 系数为 1 / -1 时简化掉，保持脚本可读。
 *
 * `off` 只对位置有意义（把录像原点搬到地图原点）；速度是方向量，传 0。
 */
function axisExpr(src: AxisSrc, sign: Sign, scale: number, off: number, vars: AxisVars): string {
  const base = vars[src];
  if (base === '0') return off === 0 ? '0' : fmt(off);
  let expr: string;
  if (sign === 1 && scale === 1) expr = base;
  else if (sign === 1) expr = `${base} * ${fmt(scale)}`;
  else if (scale === 1) expr = `-${base}`;
  else expr = `${base} * ${fmt(-scale)}`;
  if (off === 0) return expr;
  return off > 0 ? `${expr} + ${fmt(off)}` : `${expr} - ${fmt(-off)}`;
}

/** 生成可读、可改的规则脚本。 */
export function generateScript(r: RuleConfig): string {
  const L: string[] = [
    '// 由「导入规则」表单生成 —— 可直接改写（改写后表单改动不会再覆盖本段代码）',
    '// raw  原始帧对象（帧数组里的一个元素）',
    '// i    帧序号（从 0 开始）',
    '// H    H.get(raw, "pos[0]") 取路径  H.num(v) 转数字  H.wrap(度) 归一[0,360)',
    '//      H.clampPitch(度) ±89 限幅  H.deg(弧度) 转度  H.EYE 站立眼高 64.09',
    '(raw, i, H) => {',
  ];

  const hasPos = Boolean(r.posX || r.posY || r.posZ);
  const hasVel = Boolean(r.velX || r.velY || r.velZ);

  if (r.posX) L.push(`  const _ix = H.num(H.get(raw, ${q(r.posX)}));`);
  if (r.posY) L.push(`  const _iy = H.num(H.get(raw, ${q(r.posY)}));`);
  if (r.posZ) L.push(`  const _iz = H.num(H.get(raw, ${q(r.posZ)}));`);
  if (r.yawPath) L.push(`  const _yaw = H.num(H.get(raw, ${q(r.yawPath)}));`);
  if (r.pitchPath) L.push(`  const _pitch = H.num(H.get(raw, ${q(r.pitchPath)}));`);
  if (r.rollPath) L.push(`  const _roll = H.num(H.get(raw, ${q(r.rollPath)}));`);
  if (r.velX) L.push(`  const _vx = H.num(H.get(raw, ${q(r.velX)}));`);
  if (r.velY) L.push(`  const _vy = H.num(H.get(raw, ${q(r.velY)}));`);
  if (r.velZ) L.push(`  const _vz = H.num(H.get(raw, ${q(r.velZ)}));`);
  if (hasPos || hasVel) L.push('');

  // ── 时间 ──
  let tExpr: string;
  if (r.timeMode === 'tick') {
    tExpr = `i / ${fmt(r.tickrate)}`;
  } else {
    const path = r.timePath || 't';
    const base = `H.num(H.get(raw, ${q(path)}))`;
    tExpr =
      r.timeUnit === 'ms'
        ? `${base} / 1000`
        : r.timeUnit === 'tick'
          ? `${base} / ${fmt(r.tickrate)}`
          : base;
  }

  // ── 位置（含平移；眼位换算在平移之后减 EYE）──
  const posVars: AxisVars = {
    x: r.posX ? '_ix' : '0',
    y: r.posY ? '_iy' : '0',
    z: r.posZ ? '_iz' : '0',
  };
  const px = axisExpr(r.axisX, r.signX, r.posScale, r.offX, posVars);
  let py = axisExpr(r.axisY, r.signY, r.posScale, r.offY, posVars);
  const pz = axisExpr(r.axisZ, r.signZ, r.posScale, r.offZ, posVars);
  if (r.posIsEye) py = `(${py} - H.EYE)`;

  // ── 朝向 ──
  const rad = r.angleUnit === 'rad';
  let yawExpr = '0';
  if (r.yawPath) {
    const base = rad ? 'H.deg(_yaw)' : '_yaw';
    yawExpr =
      r.yawScale === 1 && r.yawOffset === 0
        ? `H.wrap(${base})`
        : `H.wrap(${base} * ${fmt(r.yawScale)} + ${fmt(r.yawOffset)})`;
  }
  let pitchExpr = '0';
  if (r.pitchPath) {
    const base = rad ? 'H.deg(_pitch)' : '_pitch';
    pitchExpr = `H.clampPitch(${r.pitchSign === -1 ? '-' : ''}${base})`;
  }
  let rollExpr = '0';
  if (r.rollPath) {
    const base = rad ? 'H.deg(_roll)' : '_roll';
    rollExpr = `H.wrap(${r.rollSign === -1 ? '-' : ''}${base})`;
  }

  // ── 速度（与位置同一套轴映射与缩放，但**不加平移**：平移不改变方向量）──
  let velExpr = 'null';
  if (hasVel) {
    const velVars: AxisVars = {
      x: r.velX ? '_vx' : '0',
      y: r.velY ? '_vy' : '0',
      z: r.velZ ? '_vz' : '0',
    };
    const vx = axisExpr(r.axisX, r.signX, r.posScale, 0, velVars);
    const vy = axisExpr(r.axisY, r.signY, r.posScale, 0, velVars);
    const vz = axisExpr(r.axisZ, r.signZ, r.posScale, 0, velVars);
    velExpr = `[${vx}, ${vy}, ${vz}]`;
  }

  L.push('  return {');
  L.push(`    t: ${tExpr},`);
  L.push(`    pos: [${px}, ${py}, ${pz}],`);
  L.push(`    ang: [${yawExpr}, ${pitchExpr}, ${rollExpr}],`);
  L.push(`    vel: ${velExpr},`);
  L.push('  };');
  L.push('}');

  return L.join('\n');
}

// ── 编译 / 校验 ─────────────────────────────────────────────────────

/** 把脚本源码编译成映射函数（同源执行，仅用于本地工具）。 */
export function compileScript(src: string): FrameMapper {
  const factory = new Function(
    'H',
    '"use strict";\nreturn (' + src + ');',
  ) as (H: unknown) => FrameMapper;
  return factory(REPLAY_HELPERS);
}

export interface ProbeResult {
  ok: boolean;
  /** 人类可读错误（含帧号与原始对象摘要）。 */
  error?: string;
  frameIndex?: number;
  sample?: Frame;
}

const NUM3 = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

/** 拿前几帧试跑脚本，抓语法/取值/NaN 问题。 */
export function probeScript(fn: FrameMapper, frames: unknown[]): ProbeResult {
  const probes = [0, Math.floor(frames.length / 2), frames.length - 1].filter(
    (i, idx, arr) => i >= 0 && i < frames.length && arr.indexOf(i) === idx,
  );
  let first: Frame | null = null;
  for (const i of probes) {
    let out: Frame;
    try {
      out = fn(frames[i], i, REPLAY_HELPERS);
    } catch (e) {
      return { ok: false, frameIndex: i, error: `第 ${i} 帧执行出错：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!out || typeof out !== 'object') {
      return { ok: false, frameIndex: i, error: `第 ${i} 帧未返回对象` };
    }
    if (!Number.isFinite(out.t)) {
      return { ok: false, frameIndex: i, error: `第 ${i} 帧的 t 不是有效数字（${String(out.t)}）——检查时间配置` };
    }
    if (!NUM3(out.pos) || out.pos.some((n) => !Number.isFinite(n))) {
      return {
        ok: false,
        frameIndex: i,
        error: `第 ${i} 帧的位置不是三个有效数字（${JSON.stringify(out.pos)}）——检查位置字段路径与轴映射`,
      };
    }
    if (!NUM3(out.ang) || out.ang.some((n) => !Number.isFinite(n))) {
      return {
        ok: false,
        frameIndex: i,
        error: `第 ${i} 帧的朝向不是三个有效数字（${JSON.stringify(out.ang)}）——检查朝向字段路径`,
      };
    }
    if (out.vel !== null && out.vel !== undefined && !NUM3(out.vel)) {
      return { ok: false, frameIndex: i, error: `第 ${i} 帧的速度必须是三个数字或 null` };
    }
    if (first === null) first = out;
  }
  return { ok: true, sample: first ?? undefined };
}

// ── 坐标系预设 ──────────────────────────────────────────────────────

export interface Preset {
  id: string;
  label: string;
  hint: string;
  apply: (r: RuleConfig) => void;
}

/**
 * Source 世界坐标 → viewer 的**唯一正确**映射（本项目几何约定）。
 *
 * 依据（2026-09-03 用 maps/surf_null.bsp + surf_null_4.replay 实测定标）：
 * - 位置：GLB 导出 `bsp_to_gltf_core::map_coords` 与 `parse_spawn_points` 的
 *   `rotate_yup` 都是 `[x,y,z] → [y,z,x]`，**无符号翻转**。录像位置必须走同一个变换，
 *   否则轨迹相对地图会整体绕竖直轴旋转 90°（表现为「侧向播放 / 穿墙」）。
 *   实测：按此映射，录像首帧到最近出生点 191 HU；按 (x,z,−y) 则是 5706 HU。
 * - yaw：在 (y,z,x) 下 `viewerYaw = srcYaw + 180`。实测该值下「视角方向与运动方向」的
 *   夹角与源空间自洽值逐个相等（59.5°/18.4°/9.7°），其余候选（0/±90/270）全是 ~90°。
 * - pitch：Source pitch 正 = 俯视（SDK `AngleVectors`：`forward.z = −sin(pitch)`），
 *   viewer pitch 正 = 仰视，故取反。
 *
 * ⚠ 与跨模块常量 `bspYawToCsYaw = (270−yaw)%360` 存在冲突：该常量斜率为 −1，
 *   本映射解出的斜率为 +1 且偏移 +180。两者不等价（仅 yaw=45° 时巧合相等）。
 *   录像侧以实测为准；实体朝向是否要同步修正见 README「已知冲突」一节。
 */
function applySourceWorld(r: RuleConfig): void {
  r.axisX = 'y';
  r.axisY = 'z';
  r.axisZ = 'x';
  r.signX = 1;
  r.signY = 1;
  r.signZ = 1;
  r.posScale = 1;
  // 平移依赖所选的轴映射，换预设必须一并清零
  r.offX = 0;
  r.offY = 0;
  r.offZ = 0;
  r.angleUnit = 'deg';
  r.yawScale = 1;
  r.yawOffset = 180;
  r.pitchSign = -1;
  r.rollSign = 1;
}

/**
 * 预设只是「起点」。坐标系约定千奇百怪，导入后请对照地图目视确认，
 * 不对就改下面的轴映射 / yaw 变换，或在脚本里直接处理。
 */
export const PRESETS: Preset[] = [
  {
    id: 'source-world',
    label: 'Source 世界坐标（推荐，与地图一致）',
    hint: '与本项目 GLB 几何 / 出生点同一约定：(x,y,z)→(y,z,x)，viewerYaw = yaw + 180，pitch 取反。BSP 实体、Shavit 录像、Source demo 都用它。',
    apply: applySourceWorld,
  },
  {
    id: 'shavit-replay',
    label: 'Shavit 录像（.replay）',
    hint: 'Shavit/SurfTimer 录像：Source Z-up，ang[0]=pitch、ang[1]=yaw（无 roll）。帧里的 vel 字段是按键命令（forwardmove/sidemove 打包），不是世界速度——不要映射到速度。',
    apply: applySourceWorld,
  },
  {
    id: 'bsp-entity',
    label: 'BSP / Hammer 实体（Z-up）',
    hint: '与 WASM parse_spawn_points 的 rotate_yup 一致。实体 angles 与运行时 view angles 同为 Source QAngle 约定，故与 Source 世界坐标预设同参数。',
    apply: applySourceWorld,
  },
  {
    id: 'viewer-native',
    label: 'viewer 原生（Y-up）',
    hint: '与 window.viewer.setPose 同一约定：Y-up、yaw 0 面朝 −Z 逆时针为正、pitch 正为仰视、度。',
    apply: (r) => {
      r.axisX = 'x';
      r.axisY = 'y';
      r.axisZ = 'z';
      r.signX = 1;
      r.signY = 1;
      r.signZ = 1;
      r.posScale = 1;
      // 平移依赖所选的轴映射，换预设必须一并清零
      r.offX = 0;
      r.offY = 0;
      r.offZ = 0;
      r.angleUnit = 'deg';
      r.yawScale = 1;
      r.yawOffset = 0;
      r.pitchSign = 1;
      r.rollSign = 1;
    },
  },
  {
    id: 'gltf-zup',
    label: '通用 glTF 风格 Z-up（不匹配本项目地图）',
    hint: '⚠ 取 (x,z,−y)、viewerYaw = yaw − 90。这是 Blender/glTF 常见约定，但与本项目 GLB 几何用的 (y,z,x) 相差绕竖直轴 90°——用它导入录像会看到轨迹整体侧转、穿墙。只在你要把录像导去别的 DCC 工具时才选。',
    apply: (r) => {
      r.axisX = 'x';
      r.axisY = 'z';
      r.axisZ = 'y';
      r.signX = 1;
      r.signY = 1;
      r.signZ = -1;
      r.posScale = 1;
      // 平移依赖所选的轴映射，换预设必须一并清零
      r.offX = 0;
      r.offY = 0;
      r.offZ = 0;
      r.angleUnit = 'deg';
      r.yawScale = 1;
      r.yawOffset = -90;
      r.pitchSign = -1;
      r.rollSign = 1;
    },
  },
];

export function applyPreset(r: RuleConfig, id: string): void {
  PRESETS.find((p) => p.id === id)?.apply(r);
}
