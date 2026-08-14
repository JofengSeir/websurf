/**
 * HUD —— 渲染统计（FPS / 帧耗时 / draw calls / 三角形 / 实例数）。
 *
 * 每 500ms 采样一次 renderer.info（WebGL 计数器）→ 证明实例化+分块后
 * draw call 与三角形数量级（2.1 万实例仅 4 个方块 draw call）。
 */
import * as THREE from 'three';

export class Hud {
  private fpsEl = document.getElementById('hud-fps')!;
  private msEl = document.getElementById('hud-ms')!;
  private callsEl = document.getElementById('hud-calls')!;
  private trisEl = document.getElementById('hud-tris')!;
  private instancesEl = document.getElementById('hud-instances')!;
  private noteEl = document.getElementById('hud-note')!;

  private frames = 0;
  private lastSample = performance.now();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** 每帧调用（内部按 500ms 节流采样）。 */
  tick(): void {
    this.frames++;
    const now = performance.now();
    if (now - this.lastSample < 500) return;
    const dt = (now - this.lastSample) / 1000;
    const fps = this.frames / dt;
    this.frames = 0;
    this.lastSample = now;

    const info = this.renderer.info.render;
    this.fpsEl.textContent = fps.toFixed(0);
    this.msEl.textContent = (1000 / fps).toFixed(2) + ' ms';
    this.callsEl.textContent = String(info.calls);
    this.trisEl.textContent = info.triangles.toLocaleString();
  }

  /** 实例总数（模式相关：沙盘实例 / 地图实例化实例）。 */
  setInstances(n: number): void {
    this.instancesEl.textContent = n.toLocaleString();
  }

  /** 附加说明（模式/材质分布/灯光统计）。 */
  setNote(text: string): void {
    this.noteEl.textContent = text;
  }
}
