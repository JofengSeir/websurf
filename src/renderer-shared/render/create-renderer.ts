/**
 * 三端唯一的渲染器构造点与预编译包装（T-454 P2；任务书 `.tmp/task-unify-render/TASK.md` §2/L6）。
 *
 * 为什么有这一层：`new THREE.WebGLRenderer` 与随后的输出链参数此前在三端各写一遍
 * （`apps/debug/src/renderer/renderer-main.ts`、`apps/game/src/renderer/renderer-main.ts`、
 * `apps/viewer/src/core/scene.ts`），任何一处漏改都静默变成「同图不同画质」；预编译着色器的
 * try/catch 与耗时日志也是三份同构副本。本模块把参数与日志口径定死在一处。
 *
 * 口径（三端逐项一致，改这里即改三端）：
 *   - WebGL 上下文：`antialias: true` + `powerPreference: 'high-performance'`（无 alpha、无 stencil 变更）；
 *   - `setPixelRatio(min(dpr, 2))`：高 DPI 下不再翻倍像素量；`setSize(w, h, false)` 不写画布样式；
 *   - `outputColorSpace = SRGBColorSpace`：输出端唯一一次 sRGB 编码（= 引擎 `MathLib_Init(gamma 2.2)` 的那次屏幕
 *     gamma 出口；光照项因此在共享着色器里保持线性，详见 `../shader/lightmap-shader.ts` 的输出编码说明）；
 *   - `toneMapping = NoToneMapping`：呈现档（曝光 / γ）由共享光照层负责，不走 tone mapping。
 */
import * as THREE from 'three';

export interface CreateRendererOptions {
  /** 画布（三端各自页面上那一个）。 */
  canvas: HTMLCanvasElement;
  /** 绘制缓冲尺寸（CSS 像素；调用方负责在窗口 resize 后重新 `setSize`）。 */
  width: number;
  height: number;
  /** 设备像素比；缺省取 `window.devicePixelRatio`（非有限值按 1 处理）。 */
  dpr?: number;
}

/** 三端唯一的 `WebGLRenderer` 构造点：上下文参数与输出链参数一起定死。 */
export function createRenderer(opts: CreateRendererOptions): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: opts.canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  const raw = opts.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  renderer.setPixelRatio(Math.min(Number.isFinite(raw) && raw > 0 ? raw : 1, 2));
  renderer.setSize(opts.width, opts.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  return renderer;
}

/**
 * 预编译着色器程序（三端唯一实现）：把「首次可见才编译」的卡顿挪到场景加载期。
 * 失败不致命（three 仍按需编译），故只告警；耗时日志的三端口径也在这里定死。
 */
export function precompileScene(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  try {
    const t0 = performance.now();
    renderer.compile(scene, camera);
    console.info(`[render] 着色器程序预编译耗时 ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (err) {
    console.warn('[render] 预编译着色器失败（不影响按需编译）:', err);
  }
}
