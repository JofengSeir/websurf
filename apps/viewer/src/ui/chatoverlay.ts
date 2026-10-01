/**
 * **画面左下角的对话浮层**：把「此刻正在发生的对话」贴到视口上（owner 定稿）。
 *
 * 与侧栏「对话」区分工：侧栏那份是**完整留档**（按播放头只做明暗，不滚动、不追当前），
 * 这一份只服务「看录像的当下」——只显示**当前时间点附近**的几条，说完就淡出。
 *
 * 规则（owner 原话）：每条**出现 15 秒后渐渐消失**；**同屏最多 5 条**；短时间内超过 5 条时
 * **最早出现的那条被快速丢出去**；**顺序自早到晚、最底下是最晚的**，新的一条从底部顶上来
 * （容器贴着左下角、按底边定位 ⇒ 内容自然向上长）。
 *
 * 「该显示哪几条」是**纯函数** `visibleChat`（见下），好让 Node 侧的 `test:replay` 用
 * 合成数据把「15 秒」「最多 5 条」「丢最早的」这三条规则钉住 —— 真实夹具 15 秒窗口内最多 4 条，
 * 光靠它测不出「>5 条」那条分支。
 */

import { el } from '../core/dom.js';

/** 浮层里的一条对话：`t` = **会话内秒**（与时间轴同一口径），`text` = 已解码文本。 */
export interface ChatLine {
  t: number;
  text: string;
}

/** 每条在浮层上停留的秒数（owner 定：15 秒后渐渐消失）。 */
export const CHAT_LIFE_SEC = 15;
/** 同屏最多几条（超出丢最早的那条）。 */
export const CHAT_MAX_LINES = 5;
/** 淡出时长（毫秒）：正常过期；`CHAT_EVICT_MS` 是被挤掉时用的更快时长。 */
const CHAT_FADE_MS = 420;
const CHAT_EVICT_MS = 140;

/**
 * **此刻该显示哪些对话**（纯函数，可单测）：
 * 取 `t <= now`（已发生）且 `now - t <= CHAT_LIFE_SEC`（还没到 15 秒）的条目，
 * 再取**最后 `CHAT_MAX_LINES` 条**（超出 ⇒ 最早的被丢），返回按时间升序 ——
 * 渲染时最早的在最上、最晚的在最下。
 */
export function visibleChat(lines: readonly ChatLine[], now: number): ChatLine[] {
  const alive = lines.filter((l) => l.t <= now && now - l.t <= CHAT_LIFE_SEC);
  return alive.slice(Math.max(0, alive.length - CHAT_MAX_LINES));
}

export class ChatOverlay {
  /** 已渲染的条目（按时间升序，与 DOM 子元素一一对应）。 */
  private lines: ChatLine[] = [];
  /** 当前时间（秒）；由帧循环推进。 */
  private now = 0;
  /** 上一次测到的 dock 高度（用来把浮层抬到 dock 之上；只在变化时写样式）。 */
  private dockH = -1;

  constructor(
    private readonly root: HTMLElement,
    /** dock 元素（底部那条时间轴）；浮层要踩着它的高度往上让位。 */
    private readonly dock: HTMLElement | null,
  ) {}

  /**
   * 换一份录像（或清空）。**传入的秒数必须是会话内秒**（调用方负责 tick → 秒）。
   * `null` / 空数组 = 本会话没有对话 ⇒ 清空浮层。
   */
  set(lines: readonly ChatLine[] | null): void {
    this.lines = lines ? [...lines].sort((a, b) => a.t - b.t) : [];
    this.root.replaceChildren();
    this.now = 0;
  }

  /**
   * 显示 / 隐藏。**记录（`.replay`）会话上场时隐藏**（它没有对话数据），
   * 数据留着 ⇒ 切回录像页立刻恢复（不必重新解析）。
   */
  setShown(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  /**
   * 按当前播放头刷新（帧循环每帧调用）。只在**该显示的那几条变了**的时候动 DOM：
   * 新增的追加到末尾（底部）、过期的加淡出类后移除、被挤掉的用更快的淡出。
   */
  update(now: number): void {
    this.now = now;
    // 浮层踩着 dock 高度：dock 高度随会话内容变（信息条 / 按键簇），变了才写样式
    if (this.dock) {
      const h = Math.round(this.dock.getBoundingClientRect().height);
      if (h !== this.dockH) {
        this.dockH = h;
        this.root.style.bottom = h + 24 + 'px';
      }
    }
    const want = visibleChat(this.lines, now);
    const wantKeys = want.map(keyOf);
    const haveKeys = (Array.from(this.root.children) as HTMLElement[]).map((c) => c.dataset.k ?? '');
    if (wantKeys.join('\u0000') === haveKeys.join('\u0000')) return;
    // 被挤掉 / 过期的：加淡出类后移除（被挤掉的用更快的一档）
    const wantSet = new Set(wantKeys);
    for (const child of Array.from(this.root.children) as HTMLElement[]) {
      const k = child.dataset.k ?? '';
      if (wantSet.has(k)) continue;
      const evicted = !this.lines.some((l) => keyOf(l) === k && l.t <= now && now - l.t <= CHAT_LIFE_SEC);
      child.style.transitionDuration = (evicted ? CHAT_EVICT_MS : CHAT_FADE_MS) + 'ms';
      child.classList.remove('co-on');
      window.setTimeout(() => child.remove(), evicted ? CHAT_EVICT_MS : CHAT_FADE_MS);
    }
    // 新增的：按时间顺序插到位（正常情况就是追加到末尾 —— 底部）
    const present = new Set((Array.from(this.root.children) as HTMLElement[]).map((c) => c.dataset.k ?? ''));
    for (const line of want) {
      const k = keyOf(line);
      if (present.has(k)) continue;
      const node = el('div', 'co-line', line.text);
      node.dataset.k = k;
      node.title = line.text;
      this.root.appendChild(node);
      // 下一帧再加 `co-on`，让 opacity 真的产生过渡（同帧添加不会触发 transition）
      window.requestAnimationFrame(() => node.classList.add('co-on'));
    }
  }
}

/** 浮层条目的稳定键：时刻 + 文本（同一秒会有多条，故不能只用时刻）。 */
function keyOf(l: ChatLine): string {
  return `${l.t.toFixed(3)}|${l.text}`;
}
