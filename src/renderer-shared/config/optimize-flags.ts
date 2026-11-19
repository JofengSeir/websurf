/**
 * 「优化处理」运行时开关（owner 2026-11-19 要求：面板新增「优化处理」tab，默认全部关闭）。
 *
 * 这些开关都是**有画面代价**的性能兜底手段：默认关，只有用户主动勾选后才生效。
 * 每个开关对应一个可测量的兜底路径：
 *
 * - `waterRtReuse`：帧预算不足（或上一帧漏槽）时，本帧跳过水面折射/镜面的整场景 RT 渲染，
 *   复用上一帧 RT（倒影/折射滞后 1 帧）。实现：`src/renderer-shared/shader/water.ts`。
 * - `bloomDirect`：帧预算不足时跳过光晕层（bright/blur/overlay），直接出主画面。
 *   实现：`src/renderer-shared/environment/post-fx.ts`。
 * - `mirrorLowRes`：水面镜面 RT 用半分辨率（1024² → 512²）渲染后再拉伸采样。
 *   实现：`src/renderer-shared/shader/water.ts`。
 *
 * 数据来源：两端 config 的 `optimize` 段（debug `apps/debug/src/config.ts`、
 * game `apps/game/src/config.ts`），由 config-sync 下发到这里；面板勾选即改 config 再同步。
 * 该模块只保存运行时开关，不落盘（落盘由各端面板偏好负责）。
 */

export interface OptimizeFlags {
  /** 帧预算不足时跳过水面 RT 更新（复用上一帧），画面滞后换准时提交。 */
  waterRtReuse: boolean;
  /** 帧预算不足时跳过光晕层（直出）。 */
  bloomDirect: boolean;
  /** 水面镜面 RT 降为一半分辨率。 */
  mirrorLowRes: boolean;
}

/** 默认全关：这些都是有画面代价的兜底手段，必须由用户显式打开。 */
export const OPTIMIZE_DEFAULTS: Readonly<OptimizeFlags> = Object.freeze({
  waterRtReuse: false,
  bloomDirect: false,
  mirrorLowRes: false,
});

let current: OptimizeFlags = { ...OPTIMIZE_DEFAULTS };

/** 合并写入（面板/config 同步进来）。只接受布尔值，缺失字段保持原值。 */
export function setOptimizeFlags(patch: Partial<OptimizeFlags> | null | undefined): void {
  if (!patch) return;
  const next = { ...current };
  if (typeof patch.waterRtReuse === 'boolean') next.waterRtReuse = patch.waterRtReuse;
  if (typeof patch.bloomDirect === 'boolean') next.bloomDirect = patch.bloomDirect;
  if (typeof patch.mirrorLowRes === 'boolean') next.mirrorLowRes = patch.mirrorLowRes;
  current = next;
}

/** 当前生效的开关（共享层只读）。 */
export function optimizeFlags(): Readonly<OptimizeFlags> {
  return current;
}

/** 单个开关查询，供热路径用（避免每帧分配对象）。 */
export function optimizeFlag(name: keyof OptimizeFlags): boolean {
  return current[name];
}

/** 恢复默认（测试/换图用，面板不需要）。 */
export function resetOptimizeFlags(): void {
  current = { ...OPTIMIZE_DEFAULTS };
}

// 诊断/验收口（浏览器控制台）：`__vbspOptimize.get()` 读当前开关；
// `__vbspOptimize.set({ waterRtReuse: true })` 临时打开（不落盘，刷新即回默认）。
// 面板与 config-sync 走 setOptimizeFlags，这个口只给 A/B 与自动化验收用。
const diagHost = globalThis as {
  __vbspOptimize?: { get: () => OptimizeFlags; set: (patch: Partial<OptimizeFlags>) => OptimizeFlags };
};
diagHost.__vbspOptimize = {
  get: () => ({ ...current }),
  set: (patch: Partial<OptimizeFlags>) => {
    setOptimizeFlags(patch);
    return { ...current };
  },
};
