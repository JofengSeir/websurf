/** 主线程 ↔ 解析 Worker 的消息协议。 */

import type { RuleConfig } from './types.js';

export interface ArrayCandidateInfo {
  path: string;
  length: number;
  depth: number;
}

/** Clip 的可转移形态（定型数组，零拷贝回传）。 */
export interface ClipPayload {
  name: string;
  count: number;
  t: Float64Array;
  pos: Float32Array;
  ang: Float32Array;
  vel: Float32Array | null;
  duration: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  maxSpeed: number;
  resolvedPath: string;
}

export type ParseRequest =
  | { id: number; type: 'probe'; file: File }
  | { id: number; type: 'import'; file: File | null; rule: RuleConfig; name: string }
  /** 取某一帧的原始坐标（未经规则变换），供坐标系标定使用。 */
  | {
      id: number;
      type: 'rawpos';
      framePath: string;
      index: number;
      paths: [string, string, string];
    }
  | { id: number; type: 'reset' };

export type ParseResponse =
  | { id: number; type: 'progress'; phase: 'parse' | 'map'; done: number; total: number }
  | {
      id: number;
      type: 'probed';
      candidates: ArrayCandidateInfo[];
      resolvedPath: string | null;
      sample: string;
      /** 根对象的 `meta` 浅拷贝（若存在且是普通对象）——用于自动识别录像来源。 */
      meta?: Record<string, unknown>;
    }
  | { id: number; type: 'done'; payload: ClipPayload; warnings: string[]; resolvedPath: string }
  | {
      id: number;
      type: 'rawposed';
      /** 三个轴都取到有效数字才有值。 */
      value: [number, number, number] | null;
      /** 该帧原始对象摘要，取值失败时给用户看。 */
      preview: string;
      /** 帧数组总长度，供 UI 夹取帧号。 */
      count: number;
    }
  | { id: number; type: 'error'; message: string; raw?: string };
