/**
 * 主线程 ↔ 解析 Worker 的消息协议：请求由 ReplayImporter 发出，响应由 Worker 回填同一 id。
 * 两侧共用本文件的类型：Worker 侧实现见 `apps/viewer/src/worker/main.ts`，主线程侧见
 * `apps/viewer/src/replay/importer.ts` 的 ReplayImporter。
 */

import type { ReplayHeaderMeta, RuleConfig } from './types.js';

/** Clip 的可转移形态，供 postMessage 传输（定型数组的 buffer 另走 transfer 列表，零拷贝）：
 *  与 `apps/viewer/src/replay/types.ts` 的 `Clip` 重合的 12 个字段同名同型；`Clip.id` 与 `Clip.rule`
 *  不在载荷里，由主线程 `payloadToClip` 本地补。 */
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
  /** 逐帧按键位掩码；Worker 侧由 Clip.buttons 透传（声明允许 null）。 */
  buttons: Int32Array | null;
  /** Shavit .replay 头部元信息；Worker 侧由 Clip.meta 透传（声明允许 null）。 */
  meta: ReplayHeaderMeta | null;
}

export type ParseRequest = {
  /** 请求序号：ReplayImporter 用它把响应配回 pending 表，Worker 原样回填。 */
  id: number;
  type: 'import';
  /** null = 复用 Worker 缓存的上一份文件（Worker 侧取 `req.file ?? cachedNativeFile`）。本类形参允许
   *  null 并原样转发；当前唯一调用点 `apps/viewer/src/replay/panel.ts` 的 `runImport` 已保证非空。 */
  file: File | null;
  /** 规则快照（映射模式 + 变换），随请求送到 Worker。 */
  rule: RuleConfig;
  /** 展示名；Worker 用它作为 clip 名（`clipFromShavitReplay` 的第一个实参）。 */
  name: string;
};

/**
 * Worker → 主线程的三种响应：progress（阶段进度，phase 取值域 'parse' | 'map'，Worker 当前只发
 * 'parse'）、done（payload + warnings + resolvedPath）、error（message 为错误文本）。
 */
export type ParseResponse =
  | { id: number; type: 'progress'; phase: 'parse' | 'map'; done: number; total: number }
  | { id: number; type: 'done'; payload: ClipPayload; warnings: string[]; resolvedPath: string }
  | { id: number; type: 'error'; message: string };
