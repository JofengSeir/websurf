/**
 * 渲染面板的通用 DOM 构建器（T-686）：把 `render-panel-spec.ts` 的规格表渲染成
 * 「分组标题 + 行（标签、控件、数值输入、单项复位、小字说明）」，并在控件变动时回调调用方。
 *
 * 分工：本模块只**建 DOM 与回写显示**，不碰档位与着色器——把值落到哪（本端渲染档 / globalThis）、
 * 现场怎么施加，由各端传进来的 `RenderPanelApi` 决定（debug 全功能、viewer 画面项、game 精简都复用它）。
 *
 * 类名一律带 `rp-` 前缀，样式由各端在自己的样式表里给（三端配色本就不同，规格表不该管观感）。
 */
import { panelGroupsFor, panelItemsFor, type RenderPanelApp, type RenderPanelItem } from './render-panel-spec.js';

/** 单项当前值（slider/number = 数值；toggle = 布尔；select/text = 字符串）。 */
export type RenderPanelValue = number | boolean | string;

export interface RenderPanelApi {
  app: RenderPanelApp;
  /** 读当前值（未落档项从 globalThis / 运行时读取）。 */
  read(item: RenderPanelItem): RenderPanelValue;
  /** 写值：调用方负责落档或写 globalThis。 */
  write(item: RenderPanelItem, value: RenderPanelValue): void;
  /** 恢复该项默认值。 */
  reset(item: RenderPanelItem): void;
  /** 写完之后要不要提示「需重新加载地图 / 刷新页面」（由调用方按 apply 决定）。 */
  afterWrite?(item: RenderPanelItem): void;
}

/** 行内控件的 id（`rp-<item.id>`；number 输入是 `rp-<item.id>-num`）。 */
export const renderPanelControlId = (item: RenderPanelItem): string => 'rp-' + item.id;

function makeControl(item: RenderPanelItem, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const id = renderPanelControlId(item);
  if (item.kind === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.addEventListener('change', () => {
      api.write(item, input.checked);
      api.afterWrite?.(item);
      onChange();
    });
    return input;
  }
  if (item.kind === 'select') {
    const select = document.createElement('select');
    select.id = id;
    for (const o of item.options ?? []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      api.write(item, select.value);
      api.afterWrite?.(item);
      onChange();
    });
    return select;
  }
  if (item.kind === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.addEventListener('change', () => {
      api.write(item, input.value);
      api.afterWrite?.(item);
      onChange();
    });
    return input;
  }
  // slider + 数值输入双控（与 game 面板既有写法一致）
  const wrap = document.createElement('div');
  wrap.className = 'rp-slider';
  const range = document.createElement('input');
  range.type = 'range';
  range.id = id;
  range.min = String(item.min ?? 0);
  range.max = String(item.max ?? 1);
  range.step = String(item.step ?? 0.01);
  const num = document.createElement('input');
  num.type = 'number';
  num.id = id + '-num';
  num.min = range.min;
  num.max = range.max;
  num.step = range.step;
  const push = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    api.write(item, v);
    api.afterWrite?.(item);
    onChange();
  };
  range.addEventListener('input', () => push(range.value));
  num.addEventListener('change', () => push(num.value));
  wrap.append(range, num);
  return wrap;
}

function makeRow(item: RenderPanelItem, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rp-row';
  row.dataset.item = item.id;

  const head = document.createElement('div');
  head.className = 'rp-head';
  const label = document.createElement('label');
  label.htmlFor = renderPanelControlId(item);
  label.textContent = item.label;
  label.title = item.title;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'rp-reset';
  reset.textContent = '默认';
  reset.title = '恢复该项默认值';
  reset.addEventListener('click', () => {
    api.reset(item);
    api.afterWrite?.(item);
    onChange();
  });
  head.append(label, reset);

  const body = document.createElement('div');
  body.className = 'rp-body';
  body.append(makeControl(item, api, onChange));

  row.append(head, body);
  if (item.note || item.apply !== 'live') {
    const note = document.createElement('div');
    note.className = 'rp-note';
    note.textContent = item.note ?? (item.apply === 'reload' ? '需刷新页面生效' : '需重新加载地图生效');
    row.append(note);
  }
  return row;
}

/** 用当前值回写所有控件显示（构建后与外部改动后都可调）。 */
export function syncRenderPanel(host: HTMLElement, api: RenderPanelApi): void {
  for (const item of panelItemsFor(api.app)) {
    const v = api.read(item);
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement>('#' + CSS.escape(renderPanelControlId(item)));
    const num = host.querySelector<HTMLInputElement>('#' + CSS.escape(renderPanelControlId(item) + '-num'));
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === true;
    else if (el instanceof HTMLSelectElement) el.value = String(v);
    else if (el instanceof HTMLInputElement) el.value = String(v);
    if (num) num.value = String(v);
  }
}

/**
 * 构建面板：按 `panelGroupsFor(app)` 逐组建 DOM 挂到 `host` 下，返回 `sync` 用于回写显示。
 * 每次控件变动都会先写值、再回写显示（数值输入与滑块同步）。
 */
export function buildRenderPanel(host: HTMLElement, api: RenderPanelApi): { sync: () => void } {
  host.textContent = '';
  const sync = () => syncRenderPanel(host, api);
  for (const group of panelGroupsFor(api.app)) {
    const items = panelItemsFor(api.app).filter((i) => i.group === group);
    if (!items.length) continue;
    const section = document.createElement('div');
    section.className = 'rp-group';
    const title = document.createElement('div');
    title.className = 'rp-group-title';
    title.textContent = group;
    section.append(title);
    for (const item of items) section.append(makeRow(item, api, sync));
    host.append(section);
  }
  sync();
  return { sync };
}
