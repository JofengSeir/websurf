/**
 * 规则脚本编译器与试跑校验。
 *
 * 规则 = 一段「求值为 (raw, i, H) => Frame 的单表达式」脚本文本（scriptSrc）。
 * 脚本怎么来的不重要（内置默认 / .js 文件 / 深链），这里只负责编译与试跑。
 */

import { REPLAY_HELPERS } from './helpers.js';
import type { Frame, FrameMapper } from './types.js';

// ── 编译 / 校验 ─────────────────────────────────────────────────────

/** 把脚本源码编译成映射函数（同源执行，仅用于本地工具）。 */
export function compileScript(src: string): FrameMapper {
  // 容错：剥掉 AI 产码常见的尾分号（整个文件会被包进 return (…) 里）
  const body = src.trim().replace(/;+\s*$/, '');
  const factory = new Function(
    'H',
    '"use strict";\nreturn (' + body + ');',
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
