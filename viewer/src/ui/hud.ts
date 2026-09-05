/**
 * HUD、引导层、拖拽反馈、启动兜底卡、帮助浮层。
 *
 * 状态行角色（S9）：`#pose` 只读位姿读数；`#bspStatus` 地图域（解析进度/成功摘要/失败）；
 * `#replayStatus` 录像域（跨面提醒 + 录像临时消息）。临时消息走各自行的
 * flash 语义：显示 ms 毫秒后恢复该行的持久文本（'' 立即恢复，不残留）。
 */

import { el, qs } from '../core/dom.js';

export class Hud {
  private readonly poseEl = qs('pose');
  private readonly statusEl = qs('bspStatus');
  private readonly replayEl = qs('replayStatus');
  private readonly guideEl = qs('guide');
  private readonly guideErrorEl = qs('guideError');
  private readonly dropzoneEl = qs('dropzone');
  private readonly fatalEl = qs('fatal');
  private readonly fatalDetailEl = qs('fatalDetail');
  private readonly helpEl = qs('help');
  private readonly helpBtn = qs<HTMLButtonElement>('helpBtn');
  private readonly helpCloseEl = qs('helpClose');
  private statusTimer = 0;
  private replayTimer = 0;
  private statusPersistent = '';
  private replayPersistent = '';

  constructor() {
    // 帮助浮层：顶栏「?」打开 / × 或 Esc 关闭（非模态，不拦其他点击）
    this.helpBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp();
    });
    this.helpCloseEl?.addEventListener('click', () => this.closeHelp());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeHelp();
    });
  }

  // ── 位姿读数行 ──────────────────────────────────────────────────
  setPose(text: string): void {
    if (this.poseEl) this.poseEl.textContent = text;
  }

  // ── 地图状态行（持久文本；flash 只是临时插队）────────────────────
  setStatus(text: string): void {
    window.clearTimeout(this.statusTimer);
    this.statusTimer = 0;
    this.statusPersistent = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /** 地图行当前文本（换图失败还原摘要用）。 */
  statusText(): string {
    return this.statusEl?.textContent ?? '';
  }

  /** 地图状态行临时闪现提示（约 ms 后恢复该行持久文本；空文本立即恢复）。 */
  flashStatus(text: string, ms = 3000): void {
    if (!this.statusEl) return;
    window.clearTimeout(this.statusTimer);
    const persistent = this.statusPersistent;
    if (!text) {
      this.statusEl.textContent = persistent;
      return;
    }
    this.statusEl.textContent = text;
    this.statusTimer = window.setTimeout(() => {
      if (this.statusEl && this.statusEl.textContent === text) {
        this.statusEl.textContent = persistent;
      }
    }, ms);
  }

  // ── 录像提醒行（跨面提醒 + 录像域临时消息）────────────────────────
  setReplayStatus(text: string): void {
    window.clearTimeout(this.replayTimer);
    this.replayTimer = 0;
    this.replayPersistent = text;
    if (this.replayEl) this.replayEl.textContent = text;
  }

  /** 录像行临时消息（导入进度 / 工具结果）：空文本立即恢复持久内容。 */
  flashReplayStatus(text: string, ms = 8000): void {
    if (!this.replayEl) return;
    window.clearTimeout(this.replayTimer);
    const persistent = this.replayPersistent;
    if (!text) {
      this.replayEl.textContent = persistent;
      return;
    }
    this.replayEl.textContent = text;
    this.replayTimer = window.setTimeout(() => {
      if (this.replayEl && this.replayEl.textContent === text) {
        this.replayEl.textContent = persistent;
      }
    }, ms);
  }

  // ── 帮助浮层 ────────────────────────────────────────────────────
  toggleHelp(): void {
    this.helpEl?.classList.toggle('hidden');
  }

  closeHelp(): void {
    this.helpEl?.classList.add('hidden');
  }

  // ── 启动兜底 / 引导层 / 拖拽 ──────────────────────────────────────
  showFatal(detail: string): void {
    if (!this.fatalEl || !this.fatalDetailEl) return;
    this.fatalDetailEl.textContent =
      detail +
      '\n\n建议：使用最新版 Chrome / Edge / Firefox（需 WebGL）；' +
      '若首次构建请先在 viewer/ 目录运行 npm install → npm run build:wasm → npm run build:ts。';
    this.fatalEl.classList.add('show');
  }

  showGuide(): void {
    this.guideEl?.classList.remove('hidden');
  }

  hideGuide(): void {
    this.guideEl?.classList.add('hidden');
    this.clearGuideError();
  }

  showGuideError(human: string, raw?: string): void {
    if (!this.guideErrorEl) return;
    this.guideErrorEl.innerHTML = '';
    this.guideErrorEl.appendChild(el('div', undefined, human));
    if (raw) this.guideErrorEl.appendChild(el('span', 'raw', raw));
    this.guideErrorEl.classList.add('show');
  }

  clearGuideError(): void {
    this.guideErrorEl?.classList.remove('show');
  }

  setDropActive(v: boolean): void {
    this.dropzoneEl?.classList.toggle('active', v);
  }
}
