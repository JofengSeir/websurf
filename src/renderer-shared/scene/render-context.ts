/**
 * 帧运行期上下文（T-P2-1）：把帧预算等级、上一帧帧时这些「每帧变、跨模块读」的值
 * 从 `globalThis.__vbsp*` 隐式总线收口成显式对象，由 `RenderSession` 持有并作为参数下传。
 *
 * ## 为什么
 *
 * 原先 `render-session.ts` 每帧往 `globalThis` 写 `__vbspBudgetLevel` / `__vbspLastFrameDtMs`，
 * `water.ts` 与 `post-fx.ts` 各自读——数据流不可追、读点分散，也没有类型约束（谁都能写任意值）。
 * 收口后：**生产读点只认参数**；`globalThis` 只在「没拿到上下文」时当逃生舱（CDP / 外部调试脚本），
 * 以及末梢的**只写**诊断镜像。
 *
 * ## 边界（本卡只收口 5 个键，其余 ~189 个 `__vbsp*` 不动）
 *
 * - `waterInject` 是**材质对象上的标志**（`water.ts` 写 `material.__vbspWaterInject`、
 *   `bumpmap.ts` 读），不是 globalThis 总线。字段留着只为让上下文完整描述一帧的水面输入，
 *   运行期不从它读值，末梢镜像也不带它。
 * - `outputGamma22` 是**载入前**逃生舱：`lightmap-shader.ts` 在 import 时就要决定往源码里
 *   塞哪段输出编码，那时还没有 RenderSession，所以只提供 `outputGamma22Enabled()` 给着色器
 *   模块调用，不走运行期传递。
 * - `waterForcePass` 是预热专用：运行期恒 undefined，预热帧临时置 'mirror'。
 *
 * `RenderSession` 末梢调 `mirrorFrameContext()` 把快照并进 `globalThis.__vbspDebug`，并继续写
 * 旧的三个全局键（`drop-recorder.ts` 与外部 CDP 脚本还在读），但生产逻辑不再读回。
 */

/** 帧预算最大等级（0=正常，1=降级，2=重载）。 */
export const MAX_BUDGET_LEVEL = 2;

/** 一帧的运行期上下文。字段由 `RenderSession.frame()` 每帧更新。 */
export interface RenderFrameContext {
  /** 当前帧预算等级，夹在 0..MAX_BUDGET_LEVEL（见 `clampBudgetLevel`）。 */
  budgetLevel: number;
  /** 上一帧的 dt（ms）；0 = 未知（预热后首帧 / 非法值）。 */
  lastFrameDtMs: number;
  /** 预热逃生舱：本帧只跑指定的一趟水面整场景 RT。运行期 undefined。 */
  waterForcePass?: 'refr' | 'mirror';
  /** 水面材质的注入标志（材质对象级，见文件头「边界」）。 */
  waterInject: boolean;
  /** 输出是否走 gamma 2.2 编码（载入前决定，见文件头「边界」）。 */
  outputGamma22: boolean;
}

/** 新上下文：预算 0、dt 未知、无强制 pass。 */
export function createRenderFrameContext(): RenderFrameContext {
  return { budgetLevel: 0, lastFrameDtMs: 0, waterInject: false, outputGamma22: true };
}

/** 预算等级归一化：非有限数 → 0；否则向下取整并夹 0..2（与原 `water.ts` 内联逻辑一致）。 */
export function clampBudgetLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_BUDGET_LEVEL, Math.floor(value)));
}

/** 上一帧 dt 归一化：非有限 / 非正 → 0（0 = 未知，预算判断按「没掉槽」处理）。 */
export function clampLastFrameDt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** 逃生舱：`__vbspBudgetLevel`——没有上下文时的回落入口。 */
export function readBudgetLevelEscapeHatch(): number {
  return clampBudgetLevel((globalThis as { __vbspBudgetLevel?: unknown }).__vbspBudgetLevel);
}

/** 逃生舱：`__vbspLastFrameDtMs`——没有上下文时的回落入口。 */
export function readLastFrameDtEscapeHatch(): number {
  return clampLastFrameDt((globalThis as { __vbspLastFrameDtMs?: unknown }).__vbspLastFrameDtMs);
}

/** 逃生舱：`__vbspWaterForcePass`（只认 'refr'/'mirror'，其余当 undefined）。 */
export function readWaterForcePassEscapeHatch(): 'refr' | 'mirror' | undefined {
  const v = (globalThis as { __vbspWaterForcePass?: unknown }).__vbspWaterForcePass;
  return v === 'refr' || v === 'mirror' ? v : undefined;
}

/**
 * 输出是否走 gamma 2.2 编码。**只在模块载入期读一次**（`lightmap-shader.ts` 拼源码时）；
 * `render-prefs.ts` 的 `applyRenderDebugSwitches` 必须在建材质之前写这个开关。
 */
export function outputGamma22Enabled(): boolean {
  return (globalThis as { __vbspOutputGamma22?: unknown }).__vbspOutputGamma22 !== false;
}

/**
 * 末梢镜像（**只写**）：把本帧的运行期字段并进 `globalThis.__vbspDebug`（Object.assign，
 * 不覆盖别人的字段），并继续写旧的 `__vbspBudgetLevel` / `__vbspLastFrameDtMs` /
 * `__vbspWaterForcePass`——`drop-recorder.ts` 与外部 CDP 脚本还在读，生产逻辑不再读回。
 *
 * 只镜像「每帧真的会变」的三项；`waterInject` / `outputGamma22` 不是运行期总线（见文件头）。
 */
export function mirrorFrameContext(ctx: RenderFrameContext): void {
  const g = globalThis as {
    __vbspBudgetLevel?: number;
    __vbspLastFrameDtMs?: number;
    __vbspWaterForcePass?: 'refr' | 'mirror';
    __vbspDebug?: Record<string, unknown>;
  };
  g.__vbspBudgetLevel = ctx.budgetLevel;
  g.__vbspLastFrameDtMs = ctx.lastFrameDtMs;
  if (ctx.waterForcePass) g.__vbspWaterForcePass = ctx.waterForcePass;
  else delete g.__vbspWaterForcePass;
  const snapshot: Record<string, unknown> = {
    budgetLevel: ctx.budgetLevel,
    lastFrameDtMs: ctx.lastFrameDtMs,
  };
  if (ctx.waterForcePass) snapshot.waterForcePass = ctx.waterForcePass;
  g.__vbspDebug = Object.assign(g.__vbspDebug ?? {}, snapshot);
}
