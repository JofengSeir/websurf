/**
 * 可交互实体 UI：准星旁的 F/G 操作提示 + G 键关联浮层 + 完整信息抽屉（debug 端）。
 *
 * 交互约定（2026-11-24 owner 要求）：
 * - 准星瞄准一个可 `use` 的实体时，在准星下方显示「F 使用」与「G 关联」；
 * - F 只负责使用（连锁不再随 F 自动弹出）；
 * - G 打开右侧折叠浮层，列出该实体的关联信息（根实体 + 2 层 outputs 目标）；
 *   条目可点击删除，未删除就常驻；「查看全部信息」打开抽屉看完整字段与输出链。
 *
 * 本模块只操作 DOM，不读渲染/物理状态；数据由 `renderer-main` 从实体系统收集后传入，
 * 保证浮层内容与连锁连线严格同源（都来自 `entity-chain.ts`）。
 */
import type { Entity } from '../../../../src/ts-shared/entity/base-entity.js';
import { entityDisplayName } from './entity-chain.js';
import type { ChainEdgeInfo, ChainInfo } from './entity-chain.js';

/** 准星提示需要的瞄准信息（renderer-main 每帧按选靶结果更新）。 */
export interface InteractAim {
  entityIndex: number;
  /** 主标题：targetname 优先，退回 classname。 */
  title: string;
  /** 副标题：`classname #index`。 */
  subtitle: string;
  /** 该实体是否有输出链（没有就不显示 G 提示）。 */
  hasChain: boolean;
}

const CLS_HIDDEN = 'hidden';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把一条关联边描述成「来自 #x output → Input（延迟）」。 */
function describeEdge(edge: ChainEdgeInfo): string {
  const delay = edge.delay > 0 ? `延迟 ${edge.delay}s` : '即时';
  const param = edge.parameter ? `，参数 ${esc(edge.parameter)}` : '';
  return `来自 #${edge.from} <code>${esc(edge.output)}</code> → <code>${esc(edge.input)}</code>（${delay}${param}）`;
}

/** 单个实体的完整信息（属性表 + 输出链），抽屉与面板共用。 */
function renderEntityDetail(entity: Entity, heading: string, edge: ChainEdgeInfo | null): string {
  const props = entity.props
    .map((p) => `<tr><td>${esc(p.key)}</td><td>${esc(p.value)}</td></tr>`)
    .join('');
  const origin = entity.origin
    ? `(${entity.origin.map((v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)).join(', ')})`
    : '—';
  const outputs: string[] = [];
  for (const [name, output] of entity.outputs) {
    for (const action of output.getActionList()) {
      outputs.push(
        `<li><code>${esc(name)}</code> → <b>${esc(action.target ?? '')}</b> ` +
          `<code>${esc(action.targetInput ?? 'Use')}</code>` +
          (action.parameter ? ` 参数 <code>${esc(action.parameter)}</code>` : '') +
          ` · 延迟 ${action.delay}s · times=${action.timesToFire}</li>`,
      );
    }
  }
  return (
    `<section class="idr-sec">` +
    `<div class="idr-sec-head">${esc(heading)}<span class="idr-sub">${esc(entity.classname || '?')} #${entity.index}` +
    (entity.targetname ? ` · ${esc(entity.targetname)}` : '') +
    `</span></div>` +
    (edge ? `<div class="idr-edge">${describeEdge(edge)}</div>` : '') +
    `<div class="idr-grid">原点 ${esc(origin)} · 体积 ${entity.volumes.length} 块 · 属性 ${entity.props.length} 项</div>` +
    `<table class="idr-table">${props || '<tr><td colspan="2">（无）</td></tr>'}</table>` +
    `<div class="idr-out-title">输出（${outputs.length} 条连接）</div>` +
    (outputs.length > 0 ? `<ul class="idr-out">${outputs.join('')}</ul>` : '<div class="idr-empty">无输出连接</div>') +
    `</section>`
  );
}

export class InteractUi {
  private readonly hints: HTMLElement | null;
  private readonly hintName: HTMLElement | null;
  private readonly hintKeys: HTMLElement | null;
  private readonly panel: HTMLElement | null;
  private readonly panelTitle: HTMLElement | null;
  private readonly panelSub: HTMLElement | null;
  private readonly panelBody: HTMLElement | null;
  private readonly panelCollapse: HTMLButtonElement | null;
  private readonly panelClose: HTMLButtonElement | null;
  private readonly panelFull: HTMLButtonElement | null;
  private readonly drawer: HTMLElement | null;
  private readonly drawerTitle: HTMLElement | null;
  private readonly drawerBody: HTMLElement | null;
  private readonly drawerClose: HTMLButtonElement | null;

  /** 面板关闭时通知宿主（收起连锁连线）。 */
  onPanelClosed: (() => void) | null = null;

  private chain: ChainInfo | null = null;
  private readonly deleted = new Set<number>();
  private collapsed = false;
  private aimKey = '';
  private enabled = false;

  constructor() {
    this.hints = document.getElementById('interactHints');
    this.hintName = document.getElementById('interactHintName');
    this.hintKeys = document.getElementById('interactHintKeys');
    this.panel = document.getElementById('interactPanel');
    this.panelTitle = document.getElementById('interactPanelTitle');
    this.panelSub = document.getElementById('interactPanelSub');
    this.panelBody = document.getElementById('interactPanelBody');
    this.panelCollapse = document.getElementById('interactPanelCollapse') as HTMLButtonElement | null;
    this.panelClose = document.getElementById('interactPanelClose') as HTMLButtonElement | null;
    this.panelFull = document.getElementById('interactPanelFull') as HTMLButtonElement | null;
    this.drawer = document.getElementById('interactDrawer');
    this.drawerTitle = document.getElementById('interactDrawerTitle');
    this.drawerBody = document.getElementById('interactDrawerBody');
    this.drawerClose = document.getElementById('interactDrawerClose') as HTMLButtonElement | null;

    this.panelCollapse?.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.panelClose?.addEventListener('click', () => this.closePanel());
    this.panelFull?.addEventListener('click', () => this.openChainDrawer());
    this.drawerClose?.addEventListener('click', () => this.hideDrawer());
    // 标题栏整行可点折叠（按钮区域除外，避免点关闭/折叠时重复触发）。
    document.getElementById('interactPanelHead')?.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('button')) return;
      this.setCollapsed(!this.collapsed);
    });
    this.panelBody?.addEventListener('click', (event) => this.onPanelBodyClick(event));
  }

  /** 指针锁定状态：未锁定时不显示准星提示（F/G 在未锁定状态下也不会触发）。 */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.setAim(null);
  }

  /** 每帧更新瞄准提示；相同目标只写一次 DOM。 */
  setAim(aim: InteractAim | null): void {
    if (!this.hints || !this.hintName || !this.hintKeys) return;
    if (!this.enabled || !aim) {
      if (this.aimKey !== '') {
        this.aimKey = '';
        this.hints.classList.add(CLS_HIDDEN);
      }
      return;
    }
    const key = `${aim.entityIndex}|${aim.title}|${aim.hasChain ? 1 : 0}`;
    if (key === this.aimKey) return;
    this.aimKey = key;
    this.hintName.textContent = aim.title;
    const keys: string[] = ['<kbd>F</kbd> 使用'];
    if (aim.hasChain) keys.push('<kbd>G</kbd> 关联');
    this.hintKeys.innerHTML = keys.join('<span class="ih-sep">·</span>');
    this.hints.classList.remove(CLS_HIDDEN);
  }

  /** G 键：打开/替换关联浮层（面板常驻，直到关闭或删光）。 */
  openPanel(chain: ChainInfo): void {
    if (!this.panel) return;
    this.chain = chain;
    this.deleted.clear();
    this.setCollapsed(false);
    this.renderPanel();
    this.panel.classList.remove(CLS_HIDDEN);
  }

  closePanel(): void {
    if (!this.panel) return;
    const wasOpen = !this.panel.classList.contains(CLS_HIDDEN);
    this.panel.classList.add(CLS_HIDDEN);
    this.hideDrawer();
    this.chain = null;
    this.deleted.clear();
    if (wasOpen) this.onPanelClosed?.();
  }

  /** 当前浮层是否正为这个实体打开（G 再次按下时据此切换关闭）。 */
  isOpenFor(entityIndex: number): boolean {
    return !!this.panel && !this.panel.classList.contains(CLS_HIDDEN) && this.chain?.root.index === entityIndex;
  }

  /** 关闭浮层与抽屉、清掉提示（换图/换场景时调用）。 */
  reset(): void {
    this.closePanel();
    this.setAim(null);
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel?.classList.toggle('collapsed', collapsed);
    if (this.panelCollapse) this.panelCollapse.textContent = collapsed ? '▸' : '▾';
  }

  private renderPanel(): void {
    const chain = this.chain;
    if (!chain || !this.panelTitle || !this.panelSub || !this.panelBody) return;
    const root = chain.root;
    this.panelTitle.textContent = `${entityDisplayName(root)}`;
    const maxDepth = chain.nodes.reduce((max, n) => Math.max(max, n.depth), 0);
    this.panelSub.textContent =
      `#${root.index} · ${root.classname || '?'} · ${chain.nodes.length} 个关联` +
      (maxDepth > 0 ? `（${maxDepth} 层）` : '') +
      (chain.truncated ? ' · 已截断' : '');

    const parts: string[] = [];
    // 根实体常驻第一行（不可删除）：这是「当前瞄准的连锁按钮」本身。
    const rootLinkCount = Array.from(root.outputs.values()).reduce((n, o) => n + o.getActionList().length, 0);
    parts.push(
      `<div class="ip-row ip-root">` +
        `<span class="ip-depth">根</span>` +
        `<span class="ip-main"><span class="ip-name">${esc(root.classname || '?')} <em>#${root.index}</em></span>` +
        `<span class="ip-tag">${esc(entityDisplayName(root))}</span>` +
        `<span class="ip-link">${rootLinkCount} 条输出连接</span></span>` +
        `<span class="ip-acts"><button class="ip-btn" data-act="detail" data-idx="${root.index}">详情</button></span>` +
        `</div>`,
    );

    const live = chain.nodes.filter((n) => !this.deleted.has(n.entity.index));
    live.sort((a, b) => a.depth - b.depth || a.entity.index - b.entity.index);
    for (const node of live) {
      const entity = node.entity;
      const edge = chain.edges.find((e) => e.to === entity.index) ?? null;
      parts.push(
        `<div class="ip-row" data-idx="${entity.index}">` +
          `<span class="ip-depth">L${node.depth}</span>` +
          `<span class="ip-main"><span class="ip-name">${esc(entity.classname || '?')} <em>#${entity.index}</em></span>` +
          `<span class="ip-tag">${esc(entityDisplayName(entity))}</span>` +
          (edge ? `<span class="ip-link">${describeEdge(edge)}</span>` : '') +
          `</span>` +
          `<span class="ip-acts">` +
          `<button class="ip-btn" data-act="detail" data-idx="${entity.index}">详情</button>` +
          `<button class="ip-btn ip-del" data-act="del" data-idx="${entity.index}" title="从浮层删除该条">删除</button>` +
          `</span>` +
          `</div>`,
      );
    }
    if (live.length === 0) {
      parts.push('<div class="ip-empty">关联条目已全部删除</div>');
    }
    this.panelBody.innerHTML = parts.join('');
  }

  private onPanelBodyClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-act]') as HTMLElement | null;
    if (!button) return;
    const entityIndex = Number(button.dataset.idx);
    if (!Number.isFinite(entityIndex)) return;
    if (button.dataset.act === 'del') {
      this.deleted.add(entityIndex);
      const chain = this.chain;
      if (chain && chain.nodes.every((n) => this.deleted.has(n.entity.index))) {
        this.closePanel();
      } else {
        this.renderPanel();
      }
      return;
    }
    if (button.dataset.act === 'detail') this.openEntityDrawer(entityIndex);
  }

  private openEntityDrawer(entityIndex: number): void {
    const chain = this.chain;
    if (!chain) return;
    const entity = entityIndex === chain.root.index ? chain.root : chain.nodes.find((n) => n.entity.index === entityIndex)?.entity;
    if (!entity) return;
    const edge = entityIndex === chain.root.index ? null : (chain.edges.find((e) => e.to === entityIndex) ?? null);
    this.showDrawer('实体详情', renderEntityDetail(entity, `#${entity.index} ${entity.classname || ''}`, edge));
  }

  private openChainDrawer(): void {
    const chain = this.chain;
    if (!chain) return;
    const sections: string[] = [renderEntityDetail(chain.root, '根实体', null)];
    const live = chain.nodes.filter((n) => !this.deleted.has(n.entity.index));
    for (const node of live) {
      const edge = chain.edges.find((e) => e.to === node.entity.index) ?? null;
      sections.push(renderEntityDetail(node.entity, `L${node.depth} 关联`, edge));
    }
    sections.push(
      `<section class="idr-sec"><div class="idr-sec-head">输出链<b>${chain.edges.length}</b> 条</div>` +
        (chain.edges.length > 0
          ? `<ul class="idr-out">${chain.edges
              .map((e) => `<li>#${e.from} ${esc(e.output)} → #${e.to} ${esc(e.input)}（延迟 ${e.delay}s${e.parameter ? `，参数 ${esc(e.parameter)}` : ''}）</li>`)
              .join('')}</ul>`
          : '<div class="idr-empty">无</div>') +
        `</section>`,
    );
    this.showDrawer('全部关联信息', sections.join(''));
  }

  private showDrawer(title: string, html: string): void {
    if (!this.drawer || !this.drawerTitle || !this.drawerBody) return;
    this.drawerTitle.textContent = title;
    this.drawerBody.innerHTML = html;
    this.drawer.classList.remove(CLS_HIDDEN);
  }

  private hideDrawer(): void {
    this.drawer?.classList.add(CLS_HIDDEN);
  }
}
