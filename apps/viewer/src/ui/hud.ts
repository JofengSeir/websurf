/**
 * HUD、引导层、拖拽反馈、启动兜底卡、帮助浮层。
 *
 * 三条状态行的角色分工：
 * - `#pose`：只读位姿读数（`apps/viewer/src/app.ts` 的 `poseText` 格式化后写入）；
 * - `#bspStatus`：地图域（解析进度 / 成功摘要 / 失败提示）；
 * - `#replayStatus`：录像域（跨面提醒 + 录像临时消息）。
 * 两行临时消息走各自的 flash 语义：先写入临时文本，`ms` 毫秒后**只有该行仍是这条临时文本**
 * 时才回写持久文本（期间被新的持久文本或新的 flash 改写则旧定时器不再回写）；
 * 传空字符串则立即恢复持久文本。
 *
 * 元素句柄由构造函数用 `qs` 取一次（取不到即 null，各方法逐个判空，不抛错）。
 * id 全部来自 `apps/viewer/web/index.html` 提供：pose / bspStatus / replayStatus / guide /
 * guideError / dropzone / fatal / fatalDetail / help / helpBtn / helpClose。
 * 显隐一律靠类名，样式在 `apps/viewer/web/styles.css`（`hidden`、`show`、`active`、`raw`）。
 * 帮助浮层还挂了全局 `keydown`：任意 Escape 都会关闭它（不做其他按键处理）。
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
    // 帮助浮层：顶栏「?」打开（阻止冒泡）/ × 或 Esc 关闭；非模态，不拦其他点击
    this.helpBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHelp();
    });
    this.helpCloseEl?.addEventListener('click', () => this.closeHelp());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeHelp();
    });
  }

  // ── 位姿读数行（`#pose`）─────────────────────────────────────────
  setPose(text: string): void {
    if (this.poseEl) this.poseEl.textContent = text;
  }

  // ── 地图状态行（`#bspStatus`：持久文本 + 临时插队）───────────────
  setStatus(text: string): void {
    window.clearTimeout(this.statusTimer);
    this.statusTimer = 0;
    this.statusPersistent = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /** 地图行当前文本（`apps/viewer/src/app.ts` 的 `loadBsp` 用它保存换图前的摘要）。 */
  statusText(): string {
    return this.statusEl?.textContent ?? '';
  }

  /** 地图状态行临时闪现：写入 `text`，`ms`（默认 3000）后按 flash 语义恢复持久文本。 */
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

  // ── 录像提醒行（`#replayStatus`：跨面提醒 + 录像域临时消息）────────
  setReplayStatus(text: string): void {
    window.clearTimeout(this.replayTimer);
    this.replayTimer = 0;
    this.replayPersistent = text;
    if (this.replayEl) this.replayEl.textContent = text;
  }

  /** 录像行临时消息（导入进度 / 工具结果）：空文本立即恢复持久内容（默认 8000 ms 后回退）。 */
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

  // ── 帮助浮层（`#help`）──────────────────────────────────────────
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
