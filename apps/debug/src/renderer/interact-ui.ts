/**
 * 可交互实体 UI：准星下方 F/G 提示 + 右侧 G 关联浮层 + 全部信息抽屉。
 *
 * 交互约定（与 renderer-main 的 G/F 接线配套）：
 * - 提示只读、不拦点击；随瞄准实时更新（同一实体换目标才重写 DOM，内容变化有淡入）。
 * - 指针锁定时提示与浮层可见，但鼠标不可用 —— 浮层底部显式提示「ESC 解锁后可操作」。
 * - 指针解锁后浮层保留，按钮才真正可点（`data-ui-block-lock` 防止点击穿透抢回锁定）。
 * - 浮层按「主触发边」组织成以根为顶的文件树（缩进 + 引导线 + 子树折叠），抽屉与复制文本同序；
 *   跨层/重复触发不另起分支，以 `+N 条触发` 标注，完整边在详情抽屉。
 * - 删除是**本地面板语义**：只影响浮层/抽屉列表，不改变实体，不删除地图数据；
 *   删除集按根实体持久（关闭重开仍在，换图/重载清空），可一键「恢复已删」。
 * - 面板打开期间每 {@link PANEL_REFRESH_MS} 用 renderer 提供的 provider 重新收集关联，
 *   实体被 Kill / 禁用 / 有限次数输出耗尽时会刷新；根实体消失则冻结为「已移除」空态。
 */

import type { Entity } from '../../../../src/ts-shared/entity/base-entity.js';
import type { EventAction } from '../../../../src/ts-shared/entity/entity-io.js';
import {
  entityDisplayName,
  entityLifeState,
  entityOutputLinkCount,
  entityOutputStats,
  type ChainEdgeInfo,
  type ChainInfo,
  type ChainNodeInfo,
  type EntityLifeState,
} from './entity-chain.js';

/** 准星提示数据（每帧由 renderer 传入）。 */
export interface InteractAim {
  entityIndex: number;
  /** 实体显示名（targetname 优先，否则 classname）。 */
  title: string;
  /** 次级信息：`classname #index`。 */
  subtitle: string;
  /** 是否有可控的关联输出（决定是否显示 G 提示）。 */
  hasChain: boolean;
}

/** 从 targetname 解析实体（抽屉里把输出目标显示成 `#index`，可注入 mock）。 */
export type EntityResolver = (name: string) => Entity[];

/** renderer 注入的关联收集器，保证与画面连线同源。 */
export type ChainProvider = (rootIndex: number) => ChainInfo | null;

type DrawerMode = { kind: 'chain' } | { kind: 'entity'; index: number };

/**
 * 关联树视图：每个节点挂在其主触发边（primary）的来源下，形成以根为顶的文件树。
 * 主触发边总是来自更浅一层（BFS 发现顺序），因此不会成环；来源缺失/被隐藏时挂回根。
 */
interface ChainTree {
  /** 父下标 → 子节点（保持 BFS 发现顺序）。 */
  children: Map<number, ChainNodeInfo[]>;
  /** 子下标 → 父下标（根不在表中）。 */
  parent: Map<number, number>;
}

/** 一个节点的入边摘要：主触发边 + 其余触发边数。 */
interface IncomingInfo {
  primary: ChainEdgeInfo | null;
  extra: number;
}

/** 树节点折叠态：叶子 / 展开 / 已折叠。 */
type FoldState = 'leaf' | 'open' | 'closed';

const HIDDEN = 'hidden';
/** 面板打开时重新收集关联的间隔（毫秒）；只在签名变化时重绘。 */
const PANEL_REFRESH_MS = 700;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 数字短格式：整数原样，小数最多两位且去尾零。 */
function num(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(2).replace(/\.?0+$/, '');
  return fixed === '' || fixed === '-' ? '0' : fixed;
}

function vec(vec: readonly number[]): string {
  return `(${vec.map((v) => num(v)).join(', ')})`;
}

/** 地图键值里的原始字符串可能含 Hammer 的 \x01 分隔符，转成可读的分隔符。 */
function propText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' · ')
    .replace(/(?: · )+/g, ' · ')
    .replace(/^ · | · $/g, '')
    .trim();
}

function delayText(delay: number): string {
  return delay > 0 ? `延迟 ${num(delay)}s` : '即时';
}

function timesText(times: number): string {
  return times >= 0 ? `剩余 ${times} 次` : '不限次数';
}

function lifeLabel(state: EntityLifeState): string {
  if (state === 'removed') return '已移除';
  if (state === 'disabled') return '已禁用';
  return '正常';
}

function lifeBadge(state: EntityLifeState): string {
  if (state === 'live') return '';
  return `<span class="ip-state ip-state-${state}" title="运行时状态：${lifeLabel(state)}">${lifeLabel(state)}</span>`;
}

/** 面板/抽屉共用的单条边描述：`[来源 ›] output → input · 延迟 · 参数`。 */
function edgeLink(edge: ChainEdgeInfo, fromName: string | null): string {
  const bits: string[] = [];
  if (fromName) {
    bits.push(`<span class="ip-from" title="来源实体">${esc(fromName)}</span><span class="ip-arrow">›</span>`);
  }
  bits.push(`<code class="ip-io">${esc(edge.output)}</code><span class="ip-arrow">→</span>`);
  bits.push(`<code class="ip-io ip-in">${esc(edge.input)}</code>`);
  bits.push(`<span class="ip-delay">${delayText(edge.delay)}</span>`);
  if (edge.parameter) bits.push(`<span class="ip-param" title="输入参数">参数 ${esc(edge.parameter)}</span>`);
  if (edge.timesToFire >= 0) bits.push(`<span class="ip-times" title="有限触发次数">×${edge.timesToFire}</span>`);
  return `<span class="ip-link">${bits.join('')}</span>`;
}

export class InteractUi {
  // ── 准星提示 ────────────────────────────────────────────────────────────
  private readonly hints: HTMLElement | null;
  private readonly hintName: HTMLElement | null;
  private readonly hintMeta: HTMLElement | null;
  private readonly hintKeys: HTMLElement | null;

  // ── 关联浮层 ────────────────────────────────────────────────────────────
  private readonly panel: HTMLElement | null;
  private readonly panelTitle: HTMLElement | null;
  private readonly panelSub: HTMLElement | null;
  private readonly panelCount: HTMLElement | null;
  private readonly panelBody: HTMLElement | null;
  private readonly panelCollapse: HTMLButtonElement | null;
  private readonly panelClose: HTMLButtonElement | null;
  private readonly panelFull: HTMLButtonElement | null;
  private readonly panelUndo: HTMLButtonElement | null;
  private readonly panelTree: HTMLButtonElement | null;
  private readonly panelState: HTMLElement | null;

  // ── 全部信息抽屉 ────────────────────────────────────────────────────────
  private readonly drawer: HTMLElement | null;
  private readonly drawerTitle: HTMLElement | null;
  private readonly drawerSub: HTMLElement | null;
  private readonly drawerBody: HTMLElement | null;
  private readonly drawerCopy: HTMLButtonElement | null;
  private readonly drawerClose: HTMLButtonElement | null;

  // ── 状态 ────────────────────────────────────────────────────────────────
  private enabled = false;
  private locked = false;
  private aim: InteractAim | null = null;
  private aimKey = '';
  private aimEntityIndex = -1;
  private chain: ChainInfo | null = null;
  private rootGone = false;
  private deletedByRoot = new Map<number, Set<number>>();
  private deleted: Set<number> = new Set();
  /** 树节点折叠集（按根实体持久，与删除集同生命周期）。 */
  private treeCollapsedByRoot = new Map<number, Set<number>>();
  private treeCollapsed: Set<number> = new Set();
  private collapsed = false;
  private drawerMode: DrawerMode | null = null;
  private refreshHandle: ReturnType<typeof setInterval> | null = null;
  private lastSignature = '';
  private provider: ChainProvider | null = null;
  private resolver: EntityResolver | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private copyDefault = '复制';

  /** 关闭浮层（收起连线等由 renderer 处理）。 */
  onPanelClosed: (() => void) | null = null;
  /** 根实体在打开期间被移除：renderer 应收起画面连线，但保留冻结面板。 */
  onChainStale: (() => void) | null = null;

  constructor() {
    const $ = (id: string): HTMLElement | null => document.getElementById(id);
    this.hints = $('interactHints');
    this.hintName = $('interactHintName');
    this.hintMeta = $('interactHintMeta');
    this.hintKeys = $('interactHintKeys');

    this.panel = $('interactPanel');
    this.panelTitle = $('interactPanelTitle');
    this.panelSub = $('interactPanelSub');
    this.panelCount = $('interactPanelCount');
    this.panelBody = $('interactPanelBody');
    this.panelCollapse = $('interactPanelCollapse') as HTMLButtonElement | null;
    this.panelClose = $('interactPanelClose') as HTMLButtonElement | null;
    this.panelFull = $('interactPanelFull') as HTMLButtonElement | null;
    this.panelUndo = $('interactPanelUndo') as HTMLButtonElement | null;
    this.panelTree = $('interactPanelTree') as HTMLButtonElement | null;
    this.panelState = $('interactPanelState');

    this.drawer = $('interactDrawer');
    this.drawerTitle = $('interactDrawerTitle');
    this.drawerSub = $('interactDrawerSub');
    this.drawerBody = $('interactDrawerBody');
    this.drawerCopy = $('interactDrawerCopy') as HTMLButtonElement | null;
    this.drawerClose = $('interactDrawerClose') as HTMLButtonElement | null;

    this.bindEvents();
  }

  // ── 公开 API（renderer-main 调用） ──────────────────────────────────────

  /** 指针锁定状态变化；锁定时面板可见但不能点，需要明确文案告知用户。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.aimKey = '';
    this.renderHints();
  }

  /** 指针锁定状态（与 setEnabled 互补：提示/浮层可见性 vs 鼠标可操作性）。 */
  setPointerLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.panel?.classList.toggle('is-locked', locked);
    this.renderPanelState();
  }

  /** 每帧瞄准结果；内部按内容去重，只有变化才动 DOM。 */
  setAim(aim: InteractAim | null): void {
    this.aim = aim;
    if (!this.enabled || !aim) {
      this.aimKey = '';
      this.renderHints();
      return;
    }
    const open = this.isOpenFor(aim.entityIndex);
    const key = `${aim.entityIndex}|${aim.title}|${aim.subtitle}|${aim.hasChain ? 1 : 0}|${open ? 1 : 0}`;
    if (key === this.aimKey) return;
    this.aimKey = key;
    this.renderHints();
  }

  /** 注入关联收集器（与 renderer 的画面连线同源）。 */
  setChainProvider(provider: ChainProvider | null): void {
    this.provider = provider;
    if (this.hasPanelOpen() && !this.refreshHandle) this.startRefresh();
  }

  /** 注入 targetname 解析器（抽屉把输出目标显示成实体下标）。 */
  setEntityResolver(resolver: EntityResolver | null): void {
    this.resolver = resolver;
  }

  /** 打开/切换根实体的关联浮层（同一根重开保留已删条目）。 */
  openPanel(chain: ChainInfo): void {
    if (!this.panel) return;
    this.stopRefresh();
    this.chain = chain;
    this.rootGone = false;
    this.setCollapsed(false);
    let deleted = this.deletedByRoot.get(chain.root.index);
    if (!deleted) {
      deleted = new Set();
      this.deletedByRoot.set(chain.root.index, deleted);
    }
    this.deleted = deleted;
    let folded = this.treeCollapsedByRoot.get(chain.root.index);
    if (!folded) {
      folded = new Set();
      this.treeCollapsedByRoot.set(chain.root.index, folded);
    }
    this.treeCollapsed = folded;
    this.lastSignature = this.chainSignature(chain);
    this.panel.classList.remove(HIDDEN);
    this.panel.setAttribute('aria-hidden', 'false');
    this.renderPanel();
    this.renderHints();
    this.startRefresh();
  }

  /** 关闭浮层与抽屉（已删条目保留，供同根重开恢复）。 */
  closePanel(): void {
    const wasOpen = this.hasPanelOpen();
    this.stopRefresh();
    this.hideDrawer();
    this.chain = null;
    this.rootGone = false;
    this.deleted = new Set();
    this.treeCollapsed = new Set();
    this.panel?.classList.add(HIDDEN);
    this.panel?.setAttribute('aria-hidden', 'true');
    this.aimKey = '';
    this.aimEntityIndex = -1;
    this.renderHints();
    if (wasOpen) this.onPanelClosed?.();
  }

  /** 换图/重载：清空全部状态（保留 DOM 元素，构造只发生一次）。 */
  reset(): void {
    this.stopRefresh();
    this.hideDrawer();
    this.chain = null;
    this.rootGone = false;
    this.deletedByRoot.clear();
    this.deleted = new Set();
    this.treeCollapsedByRoot.clear();
    this.treeCollapsed = new Set();
    this.aim = null;
    this.aimKey = '';
    this.aimEntityIndex = -1;
    this.lastSignature = '';
    this.panel?.classList.add(HIDDEN);
    this.hints?.classList.add(HIDDEN);
  }

  /** 当前是否正为某实体显示关联浮层。 */
  isOpenFor(entityIndex: number): boolean {
    return this.hasPanelOpen() && !!this.chain && this.chain.root.index === entityIndex;
  }

  /** 浮层是否打开（根被移除后仍算打开，便于 G 收起）。 */
  hasPanelOpen(): boolean {
    return !!this.panel && !this.panel.classList.contains(HIDDEN);
  }

  /** 指针解锁时按 ESC：先关抽屉，再关浮层；都关着返回 false 交回给锁定逻辑。 */
  dismissTop(): boolean {
    if (this.drawerMode) {
      this.hideDrawer();
      return true;
    }
    if (this.hasPanelOpen()) {
      this.closePanel();
      return true;
    }
    return false;
  }

  // ── 事件接线 ────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.panel?.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target?.closest('button')) return;
      // 只有点击头部空白才折叠，避免误折叠
      if (!target?.closest('.ip-head')) return;
      this.setCollapsed(!this.collapsed);
    });
    // 浮层内所有带 data-act 的按钮（详情/删除）统一在 tbody 上代理
    const body = this.panelBody;
    body?.addEventListener('click', (event) => {
      const btn = (event.target as Element | null)?.closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset.act ?? '';
      const index = Number(btn.dataset.idx ?? '-1');
      if (action === 'del' && index >= 0) this.deleteEntry(index);
      else if (action === 'detail' && index >= 0) this.openEntityDrawer(index);
      else if (action === 'toggle' && index >= 0) this.toggleNode(index);
    });
    this.panelCollapse?.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.panelTree?.addEventListener('click', () => this.toggleAllTree());
    this.panelClose?.addEventListener('click', () => this.closePanel());
    this.panelFull?.addEventListener('click', () => this.openChainDrawer());
    this.panelUndo?.addEventListener('click', () => this.restoreDeleted());
    this.drawerClose?.addEventListener('click', () => this.hideDrawer());
    this.drawerCopy?.addEventListener('click', () => void this.copyDrawerText());
  }

  // ── 准星提示 ────────────────────────────────────────────────────────────

  private renderHints(): void {
    const hints = this.hints;
    if (!hints) return;
    if (!this.enabled || !this.aim) {
      hints.classList.add(HIDDEN);
      hints.setAttribute('aria-hidden', 'true');
      this.aimEntityIndex = -1;
      return;
    }
    const aim = this.aim;
    if (this.hintName) this.hintName.textContent = aim.title;
    if (this.hintMeta) this.hintMeta.textContent = aim.subtitle;
    if (this.hintKeys) {
      const open = this.isOpenFor(aim.entityIndex);
      const keys = ['<span class="ih-key"><kbd>F</kbd><span>使用</span></span>'];
      if (aim.hasChain) {
        keys.push(`<span class="ih-key"><kbd>G</kbd><span>${open ? '收起关联' : '关联信息'}</span></span>`);
      }
      this.hintKeys.innerHTML = keys.join('<span class="ih-sep">·</span>');
    }
    // 换目标时轻微闪入，同一目标的实时刷新不打断
    if (aim.entityIndex !== this.aimEntityIndex) {
      this.aimEntityIndex = aim.entityIndex;
      hints.classList.remove('is-live');
      void hints.offsetWidth;
      hints.classList.add('is-live');
    }
    hints.classList.remove(HIDDEN);
    hints.setAttribute('aria-hidden', 'false');
  }

  // ── 浮层渲染 ────────────────────────────────────────────────────────────

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel?.classList.toggle('collapsed', collapsed);
    if (this.panelCollapse) {
      this.panelCollapse.textContent = collapsed ? '▸' : '▾';
      this.panelCollapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.panelCollapse.title = collapsed ? '展开关联列表' : '折叠关联列表';
    }
  }

  /** 删除集合 + 其下游（BFS 子代）都视为隐藏，避免留下悬空行。 */
  private hiddenIndices(chain: ChainInfo): Set<number> {
    const hidden = new Set<number>(this.deleted);
    const children = new Map<number, number[]>();
    for (const edge of chain.edges) {
      const list = children.get(edge.from);
      if (list) list.push(edge.to);
      else children.set(edge.from, [edge.to]);
    }
    const stack = [...this.deleted];
    while (stack.length > 0) {
      const current = stack.pop() as number;
      for (const child of children.get(current) ?? []) {
        if (hidden.has(child)) continue;
        hidden.add(child);
        stack.push(child);
      }
    }
    hidden.delete(chain.root.index);
    return hidden;
  }

  private entityByIndex(chain: ChainInfo, index: number): Entity | null {
    if (chain.root.index === index) return chain.root;
    for (const node of chain.nodes) if (node.entity.index === index) return node.entity;
    return null;
  }

  private renderPanel(): void {
    const chain = this.chain;
    const panel = this.panel;
    if (!chain || !panel) return;
    const root = chain.root;
    const stats = entityOutputStats(root);
    if (this.panelTitle) this.panelTitle.textContent = entityDisplayName(root);
    if (this.panelSub) {
      this.panelSub.textContent =
        `#${root.index} · ${root.classname || '?'} · ${stats.events} 组输出 / ${stats.links} 条连接` +
        (chain.truncated ? ' · 已截断' : '');
    }
    const hidden = this.hiddenIndices(chain);
    const visible = chain.nodes.filter((node) => !hidden.has(node.entity.index)).length;
    if (this.panelCount) {
      if (this.rootGone) this.panelCount.textContent = '已移除';
      else if (this.deleted.size > 0) this.panelCount.textContent = `${visible}/${chain.nodes.length} 关联`;
      else this.panelCount.textContent = `${chain.nodes.length} 关联`;
    }
    const tree = this.buildTree(chain, hidden);
    if (this.panelBody) this.panelBody.innerHTML = this.renderPanelBody(chain, hidden, tree);
    if (this.panelFull) this.panelFull.disabled = this.rootGone;
    this.updateUndo();
    this.updateTreeButton(chain, tree);
    this.renderPanelState();
  }

  private renderPanelBody(chain: ChainInfo, hidden: Set<number>, tree: ChainTree): string {
    const parts: string[] = [this.renderRootRow(chain)];
    if (this.rootGone) {
      parts.push(
        `<div class="ip-empty ip-frozen"><div class="ip-empty-title">根实体已被移除</div>` +
          `<div class="ip-empty-sub">关联链已冻结；关闭浮层后收起画面连线。地图重载后恢复。</div></div>`,
      );
      return parts.join('');
    }
    if (chain.nodes.length === 0) {
      parts.push(this.emptyChainHtml(chain));
      return parts.join('');
    }
    const visibleNodes = chain.nodes.filter((node) => !hidden.has(node.entity.index));
    if (visibleNodes.length === 0) {
      parts.push(
        `<div class="ip-empty"><div class="ip-empty-title">关联条目已全部删除</div>` +
          `<div class="ip-empty-sub">点击底部「恢复已删 (${this.deleted.size})」可恢复；未删除的条目会常驻到换图或重载。</div></div>`,
      );
      return parts.join('');
    }

    parts.push(
      `<ul class="ip-tree ip-tree-top" role="tree" aria-label="关联树">` +
        this.renderTreeLevel(chain, tree, chain.root.index) +
        `</ul>`,
    );

    if (chain.truncated) parts.push('<div class="ip-note">输出过多，部分关联已截断（连线/列表均受影响）</div>');
    const notes = this.skippedNotes(chain);
    if (notes.length > 0) parts.push(`<div class="ip-note">${notes.join(' · ')}</div>`);
    return parts.join('');
  }

  private renderRootRow(chain: ChainInfo): string {
    const root = chain.root;
    const state: EntityLifeState = this.rootGone ? 'removed' : entityLifeState(root);
    const stats = entityOutputStats(root);
    const l1 = chain.nodes.filter((node) => node.depth === 1).length;
    const l2 = chain.nodes.filter((node) => node.depth === 2).length;
    const name = root.targetname ? `<span class="ip-name">${esc(root.targetname)}</span>` : '';
    const detailDisabled = this.rootGone ? ' disabled' : '';
    const levels =
      `<span class="ip-lvl ip-lvl-1" title="直接关联（根的输出目标）">L1 ${l1}</span>` +
      (l2 > 0 ? `<span class="ip-lvl ip-lvl-2" title="二级关联（L1 的输出目标）">L2 ${l2}</span>` : '');
    return (
      `<div class="ip-row ip-root" data-idx="${root.index}">` +
      `<span class="ip-tog ip-tog-root" aria-hidden="true" title="根实体">◆</span>` +
      `<span class="ip-main">` +
      `<span class="ip-line"><span class="ip-class">${esc(root.classname || '?')}</span>` +
      `<span class="ip-idx">#${root.index}</span>${name}${lifeBadge(state)}</span>` +
      `<span class="ip-meta">${stats.links} 条输出连接${levels}</span>` +
      `</span>` +
      `<span class="ip-acts">` +
      `<button type="button" class="ip-btn" data-act="detail" data-idx="${root.index}"${detailDisabled} ` +
      `title="在抽屉查看根实体完整信息">详情</button>` +
      `</span></div>`
    );
  }

  /** 递归渲染某父节点下的一层子节点（`<li>` 列表；展开的子树嵌套 `<ul>`）。 */
  private renderTreeLevel(chain: ChainInfo, tree: ChainTree, parentIndex: number): string {
    const kids = tree.children.get(parentIndex) ?? [];
    return kids
      .map((node) => {
        const index = node.entity.index;
        const hasKids = (tree.children.get(index)?.length ?? 0) > 0;
        const fold: FoldState = !hasKids ? 'leaf' : this.treeCollapsed.has(index) ? 'closed' : 'open';
        const row = this.renderNodeRow(chain, node, parentIndex, fold, hasKids ? this.descendantCount(tree, index) : 0);
        const nested =
          fold === 'open'
            ? `<ul class="ip-tree" role="group">${this.renderTreeLevel(chain, tree, index)}</ul>`
            : '';
        const expanded = hasKids ? ` aria-expanded="${fold === 'open' ? 'true' : 'false'}"` : '';
        return (
          `<li class="ip-tnode" role="treeitem" aria-level="${node.depth + 1}"${expanded} data-depth="${node.depth}">` +
          `${row}${nested}</li>`
        );
      })
      .join('');
  }

  private renderNodeRow(
    chain: ChainInfo,
    node: ChainNodeInfo,
    parentIndex: number,
    fold: FoldState,
    descendants: number,
  ): string {
    const entity = node.entity;
    const state = entityLifeState(entity);
    const { primary, extra } = this.incomingOf(chain, entity.index);
    const fromEntity = primary ? this.entityByIndex(chain, primary.from) : null;
    const fromName = fromEntity
      ? entityDisplayName(fromEntity)
      : primary
        ? `#${primary.from}`
        : '';
    // 树位置已经表达了来源；只有主触发来源与挂载父节点不一致（回退挂到根）时才显式写出来源。
    const detail = primary
      ? edgeLink(primary, primary.from !== parentIndex ? fromName : null)
      : '<span class="ip-link ip-warn">触发路径未解析</span>';
    const name = entity.targetname ? `<span class="ip-name">${esc(entity.targetname)}</span>` : '';
    let toggle: string;
    if (fold === 'leaf') {
      toggle = '<span class="ip-tog ip-tog-leaf" aria-hidden="true"></span>';
    } else {
      const open = fold === 'open';
      const label = `${open ? '折叠' : '展开'}子项（${descendants}）`;
      toggle =
        `<button type="button" class="ip-tog" data-act="toggle" data-idx="${entity.index}" ` +
        `title="${label}" aria-label="${label}">${open ? '▾' : '▸'}</button>`;
    }
    const folded =
      fold === 'closed' ? `<span class="ip-kids" title="子树已折叠">${descendants} 个子项</span>` : '';
    return (
      `<div class="ip-row ip-chain" data-idx="${entity.index}" data-depth="${node.depth}">` +
      toggle +
      `<span class="ip-main">` +
      `<span class="ip-line"><span class="ip-lvl ip-lvl-${node.depth}" title="距根 ${node.depth} 层">L${node.depth}</span>` +
      `<span class="ip-class">${esc(entity.classname || '?')}</span>` +
      `<span class="ip-idx">#${entity.index}</span>${name}${lifeBadge(state)}${folded}</span>` +
      `${detail}` +
      (extra > 0
        ? `<span class="ip-more" title="该实体还有 ${extra} 条其他触发连接，可在「详情」抽屉查看">+${extra} 条触发</span>`
        : '') +
      `</span>` +
      `<span class="ip-acts">` +
      `<button type="button" class="ip-btn" data-act="detail" data-idx="${entity.index}" title="在抽屉查看完整信息">详情</button>` +
      `<button type="button" class="ip-btn ip-del" data-act="del" data-idx="${entity.index}" title="仅从本列表隐藏（含其子树，可恢复），不改变实体">删除</button>` +
      `</span></div>`
    );
  }

  // ── 关联树 ──────────────────────────────────────────────────────────────

  /** 某节点的入边：主触发边优先，否则取第一条；extra 为其余条数。 */
  private incomingOf(chain: ChainInfo, index: number): IncomingInfo {
    const own = chain.edges.filter((edge) => edge.to === index);
    const primary = own.find((edge) => edge.primary) ?? own[0] ?? null;
    return { primary, extra: Math.max(0, own.length - (primary ? 1 : 0)) };
  }

  /** 按主触发边把可见节点组织成以根为顶的树（见 {@link ChainTree}）。 */
  private buildTree(chain: ChainInfo, hidden: Set<number>): ChainTree {
    const rootIndex = chain.root.index;
    const depthOf = new Map<number, number>([[rootIndex, 0]]);
    for (const node of chain.nodes) depthOf.set(node.entity.index, node.depth);
    const children = new Map<number, ChainNodeInfo[]>();
    const parent = new Map<number, number>();
    for (const node of chain.nodes) {
      const index = node.entity.index;
      if (hidden.has(index)) continue;
      const { primary } = this.incomingOf(chain, index);
      let parentIndex = rootIndex;
      if (primary) {
        const parentDepth = depthOf.get(primary.from);
        // 只接受更浅一层的来源，杜绝成环；来源被隐藏时回退挂到根。
        if (parentDepth !== undefined && parentDepth < node.depth && !hidden.has(primary.from)) {
          parentIndex = primary.from;
        }
      }
      parent.set(index, parentIndex);
      const list = children.get(parentIndex);
      if (list) list.push(node);
      else children.set(parentIndex, [node]);
    }
    return { children, parent };
  }

  private descendantCount(tree: ChainTree, index: number): number {
    let count = 0;
    const stack = [...(tree.children.get(index) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as ChainNodeInfo;
      count++;
      for (const child of tree.children.get(node.entity.index) ?? []) stack.push(child);
    }
    return count;
  }

  /** 先序遍历（抽屉/复制按树序输出，与浮层一致）。 */
  private treeOrder(tree: ChainTree, rootIndex: number): ChainNodeInfo[] {
    const out: ChainNodeInfo[] = [];
    const walk = (index: number): void => {
      for (const node of tree.children.get(index) ?? []) {
        out.push(node);
        walk(node.entity.index);
      }
    };
    walk(rootIndex);
    return out;
  }

  /** 从根到该节点的显示名路径（含两端）。 */
  private treePath(chain: ChainInfo, tree: ChainTree, index: number): string[] {
    const names: string[] = [];
    let current: number | undefined = index;
    for (let guard = 0; current !== undefined && guard < 16; guard++) {
      const entity = this.entityByIndex(chain, current);
      names.push(entity ? entityDisplayName(entity) : `#${current}`);
      if (current === chain.root.index) break;
      current = tree.parent.get(current) ?? chain.root.index;
    }
    return names.reverse();
  }

  /** 可折叠的父节点（根除外）。 */
  private treeParents(chain: ChainInfo, tree: ChainTree): number[] {
    return [...tree.children.keys()].filter((index) => index !== chain.root.index);
  }

  private toggleNode(index: number): void {
    if (!this.chain) return;
    if (this.treeCollapsed.has(index)) this.treeCollapsed.delete(index);
    else this.treeCollapsed.add(index);
    this.renderPanel();
  }

  private toggleAllTree(): void {
    const chain = this.chain;
    if (!chain) return;
    const parents = this.treeParents(chain, this.buildTree(chain, this.hiddenIndices(chain)));
    if (parents.some((index) => this.treeCollapsed.has(index))) {
      for (const index of parents) this.treeCollapsed.delete(index);
    } else {
      for (const index of parents) this.treeCollapsed.add(index);
    }
    this.renderPanel();
  }

  private updateTreeButton(chain: ChainInfo, tree: ChainTree): void {
    const button = this.panelTree;
    if (!button) return;
    const parents = this.treeParents(chain, tree);
    const anyFolded = parents.some((index) => this.treeCollapsed.has(index));
    button.classList.toggle(HIDDEN, parents.length === 0 || this.rootGone);
    button.textContent = anyFolded ? '全部展开' : '全部折叠';
    button.title = anyFolded ? '展开所有子树' : '折叠所有子树，只看直接关联';
  }

  private emptyChainHtml(chain: ChainInfo): string {
    const hasLinks = entityOutputLinkCount(chain.root) > 0;
    const title = hasLinks ? '没有可显示的关联实体' : '该实体没有输出连接';
    const sub = hasLinks
      ? '它的输出只指向特殊目标、自身或无法解析的目标名。'
      : '它不是连锁触发源；按 F 仍然可以直接使用它。';
    const notes = this.skippedNotes(chain);
    return (
      `<div class="ip-empty"><div class="ip-empty-title">${title}</div>` +
      `<div class="ip-empty-sub">${sub}</div>` +
      (notes.length > 0 ? `<div class="ip-empty-note">${notes.join(' · ')}</div>` : '') +
      `</div>`
    );
  }

  /** 被忽略输出的解释文案（空链/截断时显示，避免用户以为是 bug）。 */
  private skippedNotes(chain: ChainInfo): string[] {
    const notes: string[] = [];
    if (chain.skippedSpecial > 0) notes.push(`${chain.skippedSpecial} 条输出指向 <code>!activator</code> 等特殊目标`);
    if (chain.skippedSelf > 0) notes.push(`${chain.skippedSelf} 条输出指向自身，已忽略`);
    if (chain.skippedUnresolved > 0) notes.push(`${chain.skippedUnresolved} 条输出的目标名未解析`);
    return notes;
  }

  private renderPanelState(): void {
    const state = this.panelState;
    if (!state) return;
    if (this.rootGone) {
      state.innerHTML = '根实体已被移除，关联冻结 · <kbd>G</kbd> 收起浮层';
    } else if (this.locked) {
      state.innerHTML = '<kbd>G</kbd> 收起 · <kbd>ESC</kbd> 解锁鼠标后可操作列表';
    } else {
      state.innerHTML = '已解锁 · 可点击详情/删除；点击画面回到第一人称';
    }
    state.classList.toggle('is-unlocked', !this.locked && !this.rootGone);
  }

  private updateUndo(): void {
    const button = this.panelUndo;
    if (!button) return;
    const count = this.deleted.size;
    button.classList.toggle(HIDDEN, count === 0 || this.rootGone);
    button.textContent = `恢复已删 (${count})`;
  }

  private deleteEntry(index: number): void {
    if (!this.chain || this.deleted.has(index)) return;
    if (index === this.chain.root.index) return;
    this.deleted.add(index);
    this.afterMutation();
  }

  private restoreDeleted(): void {
    if (this.deleted.size === 0) return;
    this.deleted.clear();
    this.afterMutation();
  }

  /** 删除/恢复后统一刷新：面板必重绘；链式抽屉重绘；被删实体的详情抽屉关闭。 */
  private afterMutation(): void {
    if (!this.chain) return;
    const hidden = this.hiddenIndices(this.chain);
    if (this.drawerMode?.kind === 'entity' && hidden.has(this.drawerMode.index)) {
      this.hideDrawer();
    }
    this.renderPanel();
    if (this.drawerMode?.kind === 'chain') this.renderDrawer();
    if (this.aim) this.renderHints();
  }

  // ── 实时刷新（浮层打开期间） ────────────────────────────────────────────

  private startRefresh(): void {
    this.stopRefresh();
    const rootIndex = this.chain?.root.index;
    if (rootIndex === undefined || !this.provider) return;
    this.refreshHandle = setInterval(() => this.refreshFromProvider(rootIndex), PANEL_REFRESH_MS);
  }

  private stopRefresh(): void {
    if (this.refreshHandle !== null) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  private refreshFromProvider(rootIndex: number): void {
    if (!this.chain || this.chain.root.index !== rootIndex || this.rootGone) return;
    const next = this.provider ? this.provider(rootIndex) : null;
    if (!next) {
      this.markRootGone();
      return;
    }
    const signature = this.chainSignature(next);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.chain = next;
    this.renderPanel();
    if (this.drawerMode?.kind === 'chain') this.renderDrawer();
    if (this.aim) this.renderHints();
  }

  private markRootGone(): void {
    if (this.rootGone) return;
    this.rootGone = true;
    this.stopRefresh();
    this.onChainStale?.();
    this.renderPanel();
    if (this.drawerMode?.kind === 'chain') this.renderDrawer();
  }

  /** 刷新签名：节点/层级/状态/输出数 + 边集合 + 截断/跳过计数。 */
  private chainSignature(chain: ChainInfo): string {
    const parts: string[] = [
      `${chain.root.index}:${entityLifeState(chain.root)}:${entityOutputLinkCount(chain.root)}`,
      `${chain.truncated ? 1 : 0}:${chain.skippedSpecial}:${chain.skippedSelf}:${chain.skippedUnresolved}`,
    ];
    for (const node of chain.nodes) {
      parts.push(`n${node.entity.index}.${node.depth}.${entityLifeState(node.entity)}.${entityOutputLinkCount(node.entity)}`);
    }
    for (const edge of chain.edges) {
      parts.push(`e${edge.key}.${edge.primary ? 1 : 0}.${edge.timesToFire}`);
    }
    return parts.join(';');
  }

  // ── 抽屉 ────────────────────────────────────────────────────────────────

  private openEntityDrawer(index: number): void {
    const chain = this.chain;
    if (!chain) return;
    if (!this.entityByIndex(chain, index)) return;
    this.drawerMode = { kind: 'entity', index };
    this.renderDrawer();
    this.showDrawer();
  }

  private openChainDrawer(): void {
    if (!this.chain) return;
    this.drawerMode = { kind: 'chain' };
    this.renderDrawer();
    this.showDrawer();
  }

  private showDrawer(): void {
    if (!this.drawer) return;
    this.drawer.classList.remove(HIDDEN);
    this.drawer.setAttribute('aria-hidden', 'false');
  }

  private hideDrawer(): void {
    this.drawerMode = null;
    if (!this.drawer) return;
    this.drawer.classList.add(HIDDEN);
    this.drawer.setAttribute('aria-hidden', 'true');
  }

  private renderDrawer(): void {
    const chain = this.chain;
    const body = this.drawerBody;
    const mode = this.drawerMode;
    if (!chain || !body || !mode) return;

    if (mode.kind === 'chain') {
      const hidden = this.hiddenIndices(chain);
      const visible = chain.nodes.filter((node) => !hidden.has(node.entity.index));
      if (this.drawerTitle) this.drawerTitle.textContent = '全部关联信息';
      if (this.drawerSub) {
        this.drawerSub.textContent =
          `${entityDisplayName(chain.root)} · ${visible.length}/${chain.nodes.length} 个关联实体` +
          ` · ${chain.edges.length} 条关联`;
      }
      const parts: string[] = [this.renderEntitySection(chain, chain.root, '根', null, 0)];
      const tree = this.buildTree(chain, hidden);
      const order = this.treeOrder(tree, chain.root.index);
      if (order.length > 0) {
        parts.push(
          `<div class="idr-sec-title idr-tree-title">关联树 · 按触发路径` +
            `<span class="idr-count">${order.length}</span></div>`,
        );
      }
      for (const node of order) {
        const { primary, extra } = this.incomingOf(chain, node.entity.index);
        parts.push(
          this.renderEntitySection(chain, node.entity, `L${node.depth}`, primary, extra, {
            level: node.depth,
            path: this.treePath(chain, tree, node.entity.index),
          }),
        );
      }
      const notes: string[] = [];
      if (this.deleted.size > 0) notes.push(`${this.deleted.size} 个条目已在浮层中删除（可恢复）`);
      if (chain.truncated) notes.push('关联链因数量上限被截断');
      notes.push(...this.skippedNotes(chain));
      if (notes.length > 0) parts.push(`<div class="idr-note">${notes.join(' · ')}</div>`);
      body.innerHTML = parts.join('');
      return;
    }

    const entity = this.entityByIndex(chain, mode.index);
    if (!entity) {
      if (this.drawerTitle) this.drawerTitle.textContent = '实体详情';
      if (this.drawerSub) this.drawerSub.textContent = '';
      body.innerHTML = '<div class="idr-empty">该实体已不在关联链中（可能已被移除）。</div>';
      return;
    }
    if (this.drawerTitle) this.drawerTitle.textContent = entityDisplayName(entity);
    if (this.drawerSub) this.drawerSub.textContent = `${entity.classname || '?'} #${entity.index}`;
    const { primary, extra } = this.incomingOf(chain, entity.index);
    const isRoot = entity.index === chain.root.index;
    const tree = isRoot ? null : this.buildTree(chain, this.hiddenIndices(chain));
    body.innerHTML = this.renderEntitySection(
      chain,
      entity,
      '详情',
      primary,
      extra,
      tree ? { level: 0, path: this.treePath(chain, tree, entity.index) } : undefined,
    );
  }

  /** 抽屉里的单个实体段：头部 + 树路径 + 触发来源 + 键值 + 输出按事件分组。 */
  private renderEntitySection(
    chain: ChainInfo,
    entity: Entity,
    tag: string,
    incoming: ChainEdgeInfo | null,
    extraIncoming: number,
    tree?: { level: number; path: string[] },
  ): string {
    const state = entityLifeState(entity);
    const stats = entityOutputStats(entity);
    const reserved = new Set(['classname', 'targetname', 'origin', 'angles', 'model', 'spawnflags', 'hammerid']);
    // 输出定义在「输出连接」分组里已经结构化展示，键值表里不再重复一串 \x01 拼接的原始串。
    const outputNames = new Set(Array.from(entity.outputs.keys(), (name) => name.toLowerCase()));
    const otherProps = entity.props.filter((pair) => {
      const key = pair.key.toLowerCase();
      return !reserved.has(key) && !outputNames.has(key);
    });

    const rows: Array<{ key: string; value: string; html?: boolean }> = [
      { key: 'classname', value: entity.classname || '—' },
    ];
    if (entity.targetname) rows.push({ key: 'targetname', value: entity.targetname });
    if (entity.hammerid) rows.push({ key: 'hammerid', value: entity.hammerid });
    if (entity.model) rows.push({ key: 'model', value: entity.model });
    rows.push({ key: 'origin', value: vec(entity.origin) });
    if (entity.angles.some((value) => value !== 0)) rows.push({ key: 'angles', value: vec(entity.angles) });
    if (entity.spawnflags !== 0) {
      rows.push({ key: 'spawnflags', value: `${entity.spawnflags} (0x${entity.spawnflags.toString(16)})` });
    }
    rows.push({ key: '输出', value: `${stats.events} 组 / ${stats.links} 条连接` });
    if (entity.volumes.length > 0) rows.push({ key: '体积', value: `${entity.volumes.length} 个 brush` });

    const grid = rows
      .map(
        (row) =>
          `<div class="idr-kv"><dt>${esc(row.key)}</dt><dd>${row.html ? row.value : esc(row.value)}</dd></div>`,
      )
      .join('');

    const propsTable =
      otherProps.length > 0
        ? `<table class="idr-table"><tbody>${otherProps
            .map((pair) => {
            const value = propText(pair.value);
            const title = value.length > 48 ? ` title="${esc(pair.value)}"` : '';
            return `<tr><td>${esc(pair.key)}</td><td${title}>${esc(value)}</td></tr>`;
          })
            .join('')}</tbody></table>`
        : '<div class="idr-sub">无其他地图键值</div>';

    const outputGroups: string[] = [];
    let eventCount = 0;
    for (const [outputName, output] of entity.outputs) {
      const actions = output.getActionList();
      if (actions.length === 0) continue;
      eventCount++;
      outputGroups.push(
        `<div class="idr-out-title"><code>${esc(outputName)}</code>` +
          `<span class="idr-out-count">${actions.length} 条</span></div>`,
      );
      outputGroups.push(
        `<ul class="idr-out-list">${actions.map((action) => this.renderActionLine(action)).join('')}</ul>`,
      );
    }
    const outputsHtml = eventCount > 0 ? outputGroups.join('') : '<div class="idr-sub">该实体没有输出连接。</div>';

    const incomingHtml =
      incoming && incoming.from !== entity.index
        ? `<div class="idr-incoming"><span class="idr-k">触发来源</span>${this.edgeDescribeHtml(chain, incoming)}` +
          (extraIncoming > 0 ? `<span class="idr-more">另有 ${extraIncoming} 条触发</span>` : '') +
          `</div>`
        : '';

    const pathHtml =
      tree && tree.path.length > 1
        ? `<div class="idr-path" title="关联树路径（根 → 本实体）"><span class="idr-k">路径</span>` +
          tree.path
            .map((name, i) =>
              i === tree.path.length - 1
                ? `<span class="idr-path-self">${esc(name)}</span>`
                : `<span class="idr-path-item">${esc(name)}</span>`,
            )
            .join('<span class="idr-path-sep">›</span>') +
          `</div>`
        : '';
    const level = tree?.level ?? 0;
    const secAttrs =
      level > 0 ? ` class="idr-sec idr-sec-child idr-lvl-${level}" style="--lvl:${level}"` : ' class="idr-sec"';

    return (
      `<section${secAttrs}>` +
      `<div class="idr-sec-head"><span class="idr-badge${level > 0 ? ` idr-badge-l${level}` : ''}">${esc(tag)}</span>` +
      `<span class="idr-name">${esc(entityDisplayName(entity))}</span>` +
      `<span class="idr-class">${esc(entity.classname || '?')}</span>` +
      `<span class="idr-idx">#${entity.index}</span>${lifeBadge(state)}</div>` +
      pathHtml +
      incomingHtml +
      `<dl class="idr-grid">${grid}</dl>` +
      `<div class="idr-sec-title">地图键值</div>${propsTable}` +
      `<div class="idr-sec-title">输出连接</div>${outputsHtml}` +
      `</section>`
    );
  }

  private renderActionLine(action: EventAction): string {
    const target = action.target ?? '';
    let targetHtml: string;
    if (!target) {
      targetHtml = '<span class="idr-warn">空目标</span>';
    } else if (target.startsWith('!')) {
      targetHtml = `<span class="idr-special">${esc(target)}</span>`;
    } else {
      const resolved = this.resolver ? this.resolver(target) : [];
      if (resolved.length === 0) {
        targetHtml = `<span class="idr-target">${esc(target)}</span> <span class="idr-warn">未解析</span>`;
      } else {
        targetHtml =
          `<span class="idr-target">${esc(target)}</span> ` +
          `<span class="idr-idx">${resolved.map((item) => `#${item.index}`).join(', ')}</span>`;
      }
    }
    const meta: string[] = [delayText(action.delay)];
    if (action.timesToFire >= 0) meta.push(timesText(action.timesToFire));
    if (action.parameter) meta.push(`参数 ${action.parameter}`);
    return (
      `<li><span class="idr-arrow">→</span>${targetHtml}` +
      ` <code class="idr-input">${esc(action.targetInput ?? 'Use')}</code>` +
      ` <span class="idr-meta">${meta.map((item) => esc(item)).join(' · ')}</span></li>`
    );
  }

  private edgeDescribeHtml(chain: ChainInfo, edge: ChainEdgeInfo): string {
    const from = this.entityByIndex(chain, edge.from);
    const fromName = from ? entityDisplayName(from) : `#${edge.from}`;
    return edgeLink(edge, fromName);
  }

  // ── 复制 / 纯文本 ───────────────────────────────────────────────────────

  private copyDrawerText(): void {
    const text = this.buildPlainText();
    if (!text) return;
    const done = (ok: boolean): void => this.flashCopy(ok ? '已复制' : '复制失败');
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => done(true),
          () => done(this.fallbackCopy(text)),
        );
        return;
      }
    } catch {
      // 走 fallback
    }
    done(this.fallbackCopy(text));
  }

  private fallbackCopy(text: string): boolean {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      area.style.top = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  private flashCopy(text: string): void {
    const button = this.drawerCopy;
    if (!button) return;
    if (this.copyTimer === null) this.copyDefault = button.textContent ?? '复制';
    button.textContent = text;
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyTimer = null;
      if (this.drawerCopy) this.drawerCopy.textContent = this.copyDefault;
    }, 1500);
  }

  private buildPlainText(): string {
    const chain = this.chain;
    const mode = this.drawerMode;
    if (!chain || !mode) return '';
    const lines: string[] = [];
    const pushEntity = (entity: Entity, tag: string, incoming: ChainEdgeInfo | null, indent = ''): void => {
      const start = lines.length;
      const state = entityLifeState(entity);
      lines.push(`[${tag}] ${entityDisplayName(entity)} (${entity.classname || '?'} #${entity.index}) 状态=${lifeLabel(state)}`);
      if (entity.targetname) lines.push(`  targetname: ${entity.targetname}`);
      if (entity.hammerid) lines.push(`  hammerid: ${entity.hammerid}`);
      lines.push(`  origin: ${vec(entity.origin)}`);
      if (entity.model) lines.push(`  model: ${entity.model}`);
      if (incoming) lines.push(`  触发: ${this.edgePlain(chain, incoming)}`);
      const stats = entityOutputStats(entity);
      lines.push(`  输出: ${stats.events} 组输出 / ${stats.links} 条连接`);
      for (const [outputName, output] of entity.outputs) {
        for (const action of output.getActionList()) {
          const meta: string[] = [`input=${action.targetInput ?? 'Use'}`];
          if (action.parameter) meta.push(`param=${action.parameter}`);
          if (action.delay > 0) meta.push(`delay=${num(action.delay)}s`);
          if (action.timesToFire >= 0) meta.push(`times=${action.timesToFire}`);
          lines.push(`    ${outputName} -> ${action.target ?? '(空)'} (${meta.join(', ')})`);
        }
      }
      if (indent) for (let i = start; i < lines.length; i++) lines[i] = indent + lines[i];
      lines.push('');
    };

    if (mode.kind === 'chain') {
      lines.push(
        `# ${entityDisplayName(chain.root)} 关联链 · ${chain.nodes.length} 个实体 / ${chain.edges.length} 条关联` +
          (chain.truncated ? '（已截断）' : ''),
      );
      lines.push('');
      pushEntity(chain.root, '根', null);
      // 与浮层/抽屉同一棵树：先序遍历，按层级缩进（已在浮层删除的条目不导出）。
      const tree = this.buildTree(chain, this.hiddenIndices(chain));
      for (const node of this.treeOrder(tree, chain.root.index)) {
        const { primary } = this.incomingOf(chain, node.entity.index);
        pushEntity(node.entity, `L${node.depth}`, primary, '    '.repeat(node.depth));
      }
    } else {
      const entity = this.entityByIndex(chain, mode.index);
      if (!entity) return '';
      lines.push(`# 实体详情：${entityDisplayName(entity)}`);
      lines.push('');
      pushEntity(entity, '详情', this.incomingOf(chain, entity.index).primary);
    }
    return lines.join('\n').trim();
  }

  private edgePlain(chain: ChainInfo, edge: ChainEdgeInfo): string {
    const from = this.entityByIndex(chain, edge.from);
    const fromName = from ? entityDisplayName(from) : `#${edge.from}`;
    const extra: string[] = [delayText(edge.delay)];
    if (edge.parameter) extra.push(`参数 ${edge.parameter}`);
    if (edge.timesToFire >= 0) extra.push(timesText(edge.timesToFire));
    return `${fromName} 的 ${edge.output} → ${edge.input}（${extra.join('，')}）`;
  }
}
