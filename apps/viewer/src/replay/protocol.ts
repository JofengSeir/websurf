/** 主线程 ↔ 解析 Worker 的消息协议。 */

import type { ReplayHeaderMeta, RuleConfig } from './types.js';

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
  /** 逐帧按键位掩码；仅 .replay 原生路径填充，JSON 路径为 null。 */
  buttons: Int32Array | null;
  /** Shavit .replay 头部元信息；JSON 路径为 null（UI 元信息面板数据源）。 */
  meta: ReplayHeaderMeta | null;
}

export type ParseRequest = {
  id: number;
  type: 'import';
  /** null = 复用 Worker 里已解析的上一份文件（改规则不重解析）。 */
  file: File | null;
  rule: RuleConfig;
  name: string;
};

export type ParseResponse =
  | { id: number; type: 'progress'; phase: 'parse' | 'map'; done: number; total: number }
  | { id: number; type: 'done'; payload: ClipPayload; warnings: string[]; resolvedPath: string }
  | { id: number; type: 'error'; message: string };
