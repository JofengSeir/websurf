/**
 * 地图聊天框（Source `point_servercommand` / `point_clientcommand` 的 `say` 文本 HUD 出口）。
 *
 * 为什么需要：ze 类地图的倒计时 / 关卡提示 / "门 20 秒后开" 都是
 * `point_servercommand.Command "say ***...***"` 打出来的，实体层已经把它作为
 * `kind: 'servercommand'` 事件上报（见 `entity/attach.ts`），但三端都没有 UI 消费，
 * 玩家就完全看不到这些提示。本模块只负责「文本 → 左下角聊天行」，不做命令解析
 * （解析在 `gameplay/entity-gameplay.ts` 的 `parseSayCommand`，便于 Node 侧单测）。
 *
 * 为什么放 `ts-shared/dom`：三端共用同一份 DOM 实现；不 import three、不碰渲染，
 * 无 document 时退化为 no-op（Node / 无头装配路径可以无条件构造）。
 *
 * 行内样式而非新增 CSS 文件：三端 HTML 结构不同、静态资源同步只覆盖固定清单，内联样式
 * 保证「有 app.js 就有聊天框」，不会出现样式文件漏拷导致只显示裸文本。
 */
export interface ChatOverlayOptions {
  /** 目标文档；缺省 `globalThis.document`。显式传 null 可强制 no-op（单测/无 DOM）。 */
  document?: Document | null;
  /** 挂载父节点；缺省 `document.body`。 */
  parent?: HTMLElement | null;
  /** 最多保留行数（超出丢最早），默认 10。 */
  maxLines?: number;
  /** 单行存活时间 ms，默认 20000；<= 0 表示保留到被新行挤出。 */
  lifetimeMs?: number;
  /** 距视口左侧 px，默认 12（debug 可传 312 避开左侧面板）。 */
  left?: number;
  /** 距视口底部 px，默认 72（给底部状态栏留位）。 */
  bottom?: number;
}

/** 同一文本在该窗口内重复推送时折叠（地图倒计时同一句会反复 say）。 */
const REPEAT_WINDOW_MS = 2500;
/** 单条最大长度：防止畸形地图文本撑爆一行。 */
const MAX_TEXT_LENGTH = 180;

interface ChatLine {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 清洗聊天文本：去控制字符（Source 颜色码落在 0x00–0x1f）、折叠空白、限长。 */
export function cleanChatText(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

export class ChatOverlay {
  private readonly doc: Document | null;
  private readonly root: HTMLElement | null;
  private readonly maxLines: number;
  private readonly lifetimeMs: number;
  private readonly lines: ChatLine[] = [];
  private lastText = '';
  private lastAt = 0;

  constructor(options: ChatOverlayOptions = {}) {
    this.doc = options.document ?? (typeof document === 'undefined' ? null : document);
    this.maxLines = Math.max(1, Math.floor(options.maxLines ?? 10));
    this.lifetimeMs = options.lifetimeMs ?? 20000;
    if (!this.doc) {
      this.root = null;
      return;
    }
    const parent = options.parent ?? this.doc.body ?? null;
    if (!parent) {
      this.root = null;
      return;
    }
    const root = this.doc.createElement('div');
    root.className = 'wsr-chat';
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position:fixed',
      `left:${options.left ?? 12}px`,
      `bottom:${options.bottom ?? 72}px`,
      'display:flex',
      'flex-direction:column',
      'align-items:flex-start',
      'gap:4px',
      'max-width:46vw',
      'pointer-events:none',
      'z-index:30',
      'font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
      'color:#f4f4f4',
      'text-shadow:0 1px 2px rgba(0,0,0,.9)',
      'user-select:none',
    ].join(';');
    parent.appendChild(root);
    this.root = root;
  }

  /** 当前保留的行数（诊断/测试用）。 */
  get lineCount(): number {
    return this.lines.length;
  }

  /** 推入一行聊天文本。 */
  push(raw: string): void {
    const root = this.root;
    if (!root) return;
    const text = cleanChatText(raw);
    if (!text) return;
    const now = Date.now();
    if (text === this.lastText && now - this.lastAt < REPEAT_WINDOW_MS) return;
    this.lastText = text;
    this.lastAt = now;

    const doc = this.doc;
    if (!doc) return;
    const line = doc.createElement('div');
    line.className = 'wsr-chat-line';
    line.textContent = text;
    line.style.cssText = [
      'max-width:100%',
      'padding:3px 10px',
      'border-radius:4px',
      'background:rgba(0,0,0,.45)',
      'overflow-wrap:anywhere',
      'white-space:pre-wrap',
    ].join(';');
    root.appendChild(line);

    const entry: ChatLine = { el: line, timer: null };
    this.lines.push(entry);
    while (this.lines.length > this.maxLines) {
      const oldest = this.lines.shift();
      if (oldest) this.dropLine(oldest, false);
    }
    if (this.lifetimeMs > 0) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.dropLine(entry, true);
      }, this.lifetimeMs);
    }
  }

  /** 清空全部行（换图时调用，避免上一张图的提示留在屏上）。 */
  clear(): void {
    for (const line of this.lines) this.dropLine(line, false);
    this.lines.length = 0;
    this.lastText = '';
    this.lastAt = 0;
  }

  /** 卸载：清空并移除根节点。 */
  dispose(): void {
    this.clear();
    this.root?.remove();
  }

  /** 从列表移除一行；`fade` = 带 350ms 淡出再删节点。 */
  private dropLine(entry: ChatLine, fade: boolean): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const index = this.lines.indexOf(entry);
    if (index >= 0) this.lines.splice(index, 1);
    if (fade) {
      entry.el.style.transition = 'opacity .35s ease';
      entry.el.style.opacity = '0';
      setTimeout(() => entry.el.remove(), 350);
    } else {
      entry.el.remove();
    }
  }
}
