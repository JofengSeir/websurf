/**
 * 共享地图加载进度覆盖层控制器（三端共用动画与阶段映射，外观各自走 CSS）。
 *
 * 约定 DOM 钩子：
 * - `overlay`：加/去 `.show` 与 `.error`；
 * - `fill`：写入行内 CSS 变量 `--load-pct`（`0%..100%`）；
 * - `pct` / `stage` / `sub`：写入文本；
 * - `dismissBtn`（可选）：错误态关闭按钮，点击调用 `hide()`。
 */

export const DEFAULT_LOAD_STAGE_PCT: Readonly<Record<string, number>> = {
  正在加载地图: 0,
  'WASM 解析中': 8,
  '解析出生点/传送点/PVS': 22,
  导出碰撞体: 40,
  加载默认纹理包: 46,
  '导出 GLB（含 PAKFILE 模型）': 58,
  '构建渲染场景 (GLB)': 78,
  构建物理世界: 92,
  装配实体与视角: 92,
};

export interface LoadingOverlayElements {
  overlay: HTMLElement | null;
  sub: HTMLElement | null;
  fill: HTMLElement | null;
  stage: HTMLElement | null;
  pct: HTMLElement | null;
  dismissBtn?: HTMLElement | null;
}

export interface LoadingOverlayController {
  show(mapName: string): void;
  advance(stage: string): void;
  update(stage: string, pct: number): void;
  finish(): void;
  fail(message: string): void;
  hide(): void;
}

export function createLoadingOverlay(
  getEls: () => LoadingOverlayElements,
  stagePct: Readonly<Record<string, number>> = DEFAULT_LOAD_STAGE_PCT,
): LoadingOverlayController {
  let els: LoadingOverlayElements | null = null;
  let dismissBound = false;

  const anim = {
    current: 0,
    target: 0,
    drifting: false,
    raf: 0,
  };

  function ensureEls(): LoadingOverlayElements {
    if (!els) els = getEls();
    if (!dismissBound && els.dismissBtn) {
      dismissBound = true;
      els.dismissBtn.addEventListener('click', () => hide());
    }
    return els;
  }

  function stopAnim(): void {
    if (anim.raf) cancelAnimationFrame(anim.raf);
    anim.raf = 0;
    anim.drifting = false;
  }

  function tick(): void {
    anim.raf = 0;
    const { overlay, fill, pct } = ensureEls();
    let cur = anim.current;
    const target = anim.target;
    const diff = target - cur;
    if (Math.abs(diff) > 0.1) {
      cur += diff * (0.12 + 0.02 * Math.abs(diff));
      if (cur > 0.98 * target && cur < target) cur = target;
      anim.current = cur;
    } else if (anim.drifting) {
      cur = Math.min(cur + 0.15, Math.max(target, 0) + 2);
      anim.current = cur;
    }
    const shown = Math.max(0, Math.min(100, cur));
    if (fill) fill.style.setProperty('--load-pct', `${shown}%`);
    if (pct) pct.textContent = `${Math.round(shown)}%`;
    if (overlay?.classList.contains('show')) {
      anim.raf = requestAnimationFrame(tick);
    }
  }

  function show(mapName: string): void {
    const { overlay, fill, stage, pct, sub } = ensureEls();
    stopAnim();
    anim.current = 0;
    anim.target = 0;
    if (overlay) {
      overlay.classList.add('show');
      overlay.classList.remove('error');
    }
    if (fill) fill.style.removeProperty('--load-pct');
    if (stage) stage.textContent = '初始化';
    if (pct) pct.textContent = '0%';
    if (sub) sub.textContent = mapName ? `加载 ${mapName}…` : '加载地图…';
    anim.raf = requestAnimationFrame(tick);
  }

  function update(stageName: string, pctVal: number): void {
    const { stage } = ensureEls();
    anim.target = Math.max(0, Math.min(100, pctVal));
    anim.drifting = false;
    if (stage) stage.textContent = stageName;
  }

  function advance(stageName: string): void {
    const pctVal = stagePct[stageName];
    if (pctVal !== undefined) {
      update(stageName, pctVal);
      anim.drifting = pctVal < 92;
    } else {
      const { stage } = ensureEls();
      if (stage) stage.textContent = stageName;
    }
  }

  function finish(): void {
    const { stage } = ensureEls();
    anim.target = 100;
    anim.drifting = false;
    if (stage) stage.textContent = '完成';
    window.setTimeout(() => hide(), 260);
  }

  function fail(message: string): void {
    const { overlay, stage, sub, fill, pct } = ensureEls();
    stopAnim();
    if (overlay) overlay.classList.add('error');
    if (stage) stage.textContent = '加载失败';
    if (sub) sub.textContent = message;
    if (fill) fill.style.setProperty('--load-pct', '100%');
    if (pct) pct.textContent = '—';
  }

  function hide(): void {
    const { overlay } = ensureEls();
    stopAnim();
    if (overlay) {
      overlay.classList.remove('show');
      overlay.classList.remove('error');
    }
  }

  return { show, advance, update, finish, fail, hide };
}
