/**
 * 增强插件：运行时屏幕渐变（env_fade）。
 *
 * 补的是什么缺口（来自 2026-11-23 缺口分析）：ze_cursed 有 2 个 `env_fade`
 * （lvl3_fader 绿 30 240 35、lvl3_fade 黑），I/O 链能触发、`EnvFadeClass` 也会调用
 * `host.fadeScreen(...)`，但观测宿主把载荷压成 `duration/hold/flags`，颜色被丢，
 * 渲染/UI 层也没有消费者 ⇒ 过场黑屏/绿屏完全没有。
 *
 * 本插件消费 `env_fade` 事件，用一张全屏 DOM 覆盖层按 Source `UTIL_ScreenFade` 的
 * 时间轴近似呈现（FFADE_IN / FFADE_OUT / FFADE_MODULATE / FFADE_STAYOUT）：
 *   - FFADE_IN：从目标颜色淡入到透明（duration 内）；
 *   - 否则（OUT）：从透明淡到目标颜色（duration 内），保持 holdtime，再淡回透明
 *     （STAYOUT 时保持不淡出）。
 * 这是**近似**：Source 的 reversefadeduration 不在 keyvalue 里（与 duration 相同处理），
 * FFADE_MODULATE 用 CSS multiply 近似，不做引擎级屏幕空间调制。
 *
 * 默认关零成本：插件未启用时模块不会被 import，覆盖层不创建，也无 rAF 循环；
 * 只有收到第一条 env_fade 事件时才创建 DOM。插件不 import three / renderer-shared。
 */
import type { EnhancePlugin, EnhancePluginFactory } from '../../../../../src/ts-shared/enhance/plugin.js';
import type { EntityEvent } from '../../../../../src/ts-shared/entity/types.js';

/** `screenfade.h` 的 FFADE_* 位（与 `src/ts-shared/entity/classes/misc.ts` 一致）。 */
const FFADE_IN = 0x0001;
const FFADE_MODULATE = 0x0004;
const FFADE_STAYOUT = 0x0008;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FadePayload {
  color: Rgba;
  duration: number;
  hold: number;
  flags: number;
}

/** 覆盖层 z-index：盖住 canvas，但不拦截鼠标（pointer-events:none）。 */
const OVERLAY_Z_INDEX = '2147483000';

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析 `attach.ts` 上报的 env_fade 载荷。
 * 新格式：`{"color":{"r":..,"g":..,"b":..,"a":..},"duration":..,"hold":..,"flags":..}`；
 * 兼容旧格式（只有 `duration/hold/flags` 三个数字，颜色按黑色）：`"3/2/9"`。
 */
export function parseFadeDetail(detail: string | undefined): FadePayload | null {
  if (!detail) return null;
  const text = detail.trim();
  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      const colorRaw = (raw.color ?? {}) as Record<string, unknown>;
      const color: Rgba = {
        r: Math.round(numberOr(colorRaw.r, 0)),
        g: Math.round(numberOr(colorRaw.g, 0)),
        b: Math.round(numberOr(colorRaw.b, 0)),
        a: Math.round(numberOr(colorRaw.a, 255)),
      };
      return {
        color: {
          r: Math.min(255, Math.max(0, color.r)),
          g: Math.min(255, Math.max(0, color.g)),
          b: Math.min(255, Math.max(0, color.b)),
          a: Math.min(255, Math.max(0, color.a)),
        },
        duration: Math.max(0, numberOr(raw.duration, 0)),
        hold: Math.max(0, numberOr(raw.hold, 0)),
        flags: Math.round(numberOr(raw.flags, 0)),
      };
    } catch {
      return null;
    }
  }
  const parts = text.split('/').map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) return null;
  return {
    color: { r: 0, g: 0, b: 0, a: 255 },
    duration: Math.max(0, parts[0] ?? 0),
    hold: Math.max(0, parts[1] ?? 0),
    flags: Math.round(parts[2] ?? 0),
  };
}

interface FadeScreen {
  readonly element: HTMLDivElement;
  /** 当前时间轴；第二次 fade 会替换。 */
  timeline: FadeTimeline | null;
}

interface FadeTimeline {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly holdMs: number;
  readonly fromAlpha: number;
  readonly toAlpha: number;
  readonly stay: boolean;
  /** 到达 toAlpha 并保持 hold 后，是否再淡回 0。 */
  readonly fadeBack: boolean;
  readonly colorRgb: string;
}

/** 从「持续时间 + hold + flags」构造时间轴（空 duration 时立即到位）。 */
export function buildTimeline(payload: FadePayload, now: number): FadeTimeline {
  const target = clamp01(payload.color.a / 255);
  const fadeIn = (payload.flags & FFADE_IN) !== 0;
  const stay = (payload.flags & FFADE_STAYOUT) !== 0;
  const durationMs = Math.max(0, payload.duration) * 1000;
  const holdMs = Math.max(0, payload.hold) * 1000;
  return {
    startedAt: now,
    durationMs,
    holdMs,
    fromAlpha: fadeIn ? target : 0,
    toAlpha: fadeIn ? 0 : target,
    stay,
    // FADE_IN 本身是「从颜色淡回游戏」，没有二次淡出；FADE_OUT 在 hold 后淡回透明（除非 STAYOUT）。
    fadeBack: !fadeIn && !stay,
    colorRgb: `${payload.color.r}, ${payload.color.g}, ${payload.color.b}`,
  };
}

/** 求时间轴在 `elapsed` 毫秒时的透明度（0..1）。 */
export function sampleTimeline(timeline: FadeTimeline, elapsed: number): number {
  const { durationMs, holdMs, fromAlpha, toAlpha } = timeline;
  if (durationMs <= 0) {
    if (elapsed < holdMs) return toAlpha;
    return timeline.fadeBack ? 0 : toAlpha;
  }
  if (elapsed < durationMs) {
    const k = elapsed / durationMs;
    return fromAlpha + (toAlpha - fromAlpha) * k;
  }
  if (elapsed < durationMs + holdMs) return toAlpha;
  if (!timeline.fadeBack) return toAlpha;
  const tail = elapsed - durationMs - holdMs;
  if (tail < durationMs) return toAlpha * (1 - tail / durationMs);
  return 0;
}

/** 时间轴是否已彻底结束（可以从 DOM 移除）。 */
export function isTimelineFinished(timeline: FadeTimeline, elapsed: number): boolean {
  if (timeline.durationMs <= 0 && timeline.holdMs <= 0) return true;
  const endMs = timeline.durationMs + timeline.holdMs + (timeline.fadeBack ? timeline.durationMs : 0);
  return elapsed >= endMs;
}

export function createFadeScreenPlugin(_runtime: { log(message: string): void }): EnhancePlugin {
  let screen: FadeScreen | null = null;
  let rafId = 0;
  let fadeCount = 0;
  let lastSummary = '—';
  let lastPayload: FadePayload | null = null;

  const ensureScreen = (): FadeScreen | null => {
    if (typeof document === 'undefined' || !document.body) return null;
    if (screen) return screen;
    const element = document.createElement('div');
    element.id = 'enhance-fade-overlay';
    element.style.position = 'fixed';
    element.style.inset = '0';
    element.style.pointerEvents = 'none';
    element.style.zIndex = OVERLAY_Z_INDEX;
    element.style.opacity = '0';
    element.style.background = 'rgb(0, 0, 0)';
    element.style.transition = 'none';
    document.body.appendChild(element);
    screen = { element, timeline: null };
    return screen;
  };

  const removeScreen = (): void => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (!screen) return;
    screen.element.remove();
    screen = null;
  };

  const tick = (): void => {
    rafId = 0;
    if (!screen || !screen.timeline) return;
    const timeline = screen.timeline;
    const elapsed = performance.now() - timeline.startedAt;
    screen.element.style.background = `rgb(${timeline.colorRgb})`;
    screen.element.style.opacity = String(clamp01(sampleTimeline(timeline, elapsed)));
    if (isTimelineFinished(timeline, elapsed)) {
      screen.timeline = null;
      // STAYOUT 到达目标颜色后保持不透明；其余时间轴结束后应回到全透明。
      screen.element.style.opacity = String(clamp01(timeline.stay ? timeline.toAlpha : 0));
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  const applyFade = (payload: FadePayload): void => {
    const target = ensureScreen();
    if (!target) {
      _runtime.log('env_fade：当前环境没有 document，无法呈现覆盖层');
      return;
    }
    fadeCount += 1;
    lastPayload = payload;
    lastSummary = `rgba(${payload.color.r},${payload.color.g},${payload.color.b},${payload.color.a})` +
      ` ${payload.duration}s/hold ${payload.hold}s/flags ${payload.flags}`;
    const now = performance.now();
    const timeline = buildTimeline(payload, now);
    target.timeline = timeline;
    target.element.style.background = `rgb(${timeline.colorRgb})`;
    target.element.style.mixBlendMode = (payload.flags & FFADE_MODULATE) !== 0 ? 'multiply' : 'normal';
    target.element.style.opacity = String(clamp01(timeline.fromAlpha));
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  };

  return {
    id: 'fade-screen',
    onMapLoad(): void {
      removeScreen();
      fadeCount = 0;
      lastSummary = '—';
      lastPayload = null;
    },
    onEvent(event: EntityEvent): void {
      if (event.kind !== 'env_fade') return;
      const payload = parseFadeDetail(event.detail);
      if (!payload) {
        _runtime.log(`env_fade：无法解析载荷（${String(event.detail).slice(0, 80)}）`);
        return;
      }
      applyFade(payload);
    },
    statusText(): string {
      const screenState = screen?.timeline ? '覆盖层播放中' : screen ? '覆盖层就绪' : '无覆盖层';
      const color = lastPayload
        ? `rgba(${lastPayload.color.r},${lastPayload.color.g},${lastPayload.color.b},${lastPayload.color.a})`
        : '—';
      return `渐变 ${fadeCount} 次；最近 ${lastSummary}；${screenState}；最近颜色 ${color}`;
    },
    dispose(): void {
      removeScreen();
      lastPayload = null;
      lastSummary = '—';
    },
  };
}

export const createFadeScreenPluginFactory: EnhancePluginFactory = async (runtime) =>
  createFadeScreenPlugin(runtime);
