/**
 * 主线程 → Worker-A 消息桥接（最小化版）。
 * 输入经 SAB 输入槽（Atomics.add 零拷贝）；低频控制经 postMessage。
 */

import type { RuntimeConfig } from '../config.js';
import type { ShmState } from '../worker/shared-state.js';

export class InputBridge {
  constructor(
    private readonly worker: Worker,
    private readonly shared: ShmState,
  ) {}

  sendInit(shared: SharedArrayBuffer, width: number, height: number, dpr: number): void {
    this.worker.postMessage({ type: 'init', shared, width, height, dpr });
  }

  sendLoadBsp(name: string, data: ArrayBuffer): void {
    this.worker.postMessage({ type: 'load-bsp', name, data }, [data]);
  }

  // ── 输入（SAB 输入槽）──────────────────────────────────────

  addInput(dx: number, dy: number, keysMask: number): void {
    this.shared.addInput(dx, dy, keysMask);
  }

  // ── 低频控制 ───────────────────────────────────────────────

  sendConfig(section: keyof RuntimeConfig, patch: Record<string, unknown>): void {
    this.worker.postMessage({ type: 'config', section, patch });
  }

  sendRespawn(): void {
    this.worker.postMessage({ type: 'respawn' });
  }

  sendTeleport(target: number): void {
    this.worker.postMessage({ type: 'teleport', target });
  }

  sendSetDeathThreshold(value: number): void {
    this.worker.postMessage({ type: 'set-death-threshold', value });
  }
}
