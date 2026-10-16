/**
 * 渲染面板的通用 DOM 构建器（T-691 重写）：把 `render-panel-spec.ts` 的规格表渲染成**各端自己的面板结构**。
 *
 * 为什么要有 skin：三端的面板结构并不一样，同一套竖排堆叠塞进去必然走形。以下约定逐条读实现得到：
 *   · debug `apps/debug/web/index.html:134` 的 `.ctrl-grid`：`grid-template-columns: 110px 1fr 50px`，
 *     一行 = **栅格的直接子元素**（`label` / `input[type=range]` / `.val > input.param-num`），跨整行用
 *     `.ctrl-full`（`:157`）；复选框行是 `.ctrl-checkbox-row.ctrl-full`（input 在前、`<label for>` 在后，`:703`）。
 *   · game `apps/game/web/styles.css:415` 的 `#panel .row`：`168px 1fr 88px`，一行 = 一个 `.row` 容器，
 *     标注是 `.row > label`（`:421`）、读数是 `.val`（`:468`）里的 `<input>` + `.val .unit`（`:485`）、
 *     小节标题是 `h4`（`:400`）、checkbox 落到读数列（`:438`）。
 *   · viewer `apps/viewer/web/styles.css:249-313`：分区 `.sec` > `.sec-title` + `.sec-body`，
 *     行 `.field`（flex）> `.field-label`（`:278`）+ 控件 + `.field-input.field-num`（`:297`），
 *     复选框行 `.field.field-check`（`apps/viewer/src/core/dom.ts:125`，input 在前、`.field-label` 在后），
 *     提示 `.note.note-info`（`:313`）、按钮 `.btn.small`（`:311`）。
 *
 * 三端共用的两条纪律（owner 2026-10-16：标注一多就把行挤开是不行的）：
 *   ① 标注列**定宽**（debug 110px / game 168px / viewer 96px），长标注在列内换行，**绝不挤压控件列**；
 *   ② 复位按钮收在标注格里（grid 两端是窄的标注列；viewer 是 flex 行，按它自己的 `.btn.small` 停在行尾），
 *      **不额外加列**，免得和同一面板里原生行的控件列错位。
 *
 * 本模块只建 DOM 与回写显示：值落到哪、现场怎么施加，由各端传进来的 `RenderPanelApi` 决定。
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
  /**
   * 当前是否已载入地图（三端各自的「当前地图名非空」）。
   * 给了就在面板顶部渲染一行状态：没载图时明说「以下改动会在下次加载地图后生效」，
   * 而不是让用户改了没反应还以为坏了（owner 2026-10-16：面板通路要交代清楚）。
   */
  hasMap?(): boolean;
}

/** `grid` = 行元素直接挂进宿主栅格（debug）；`row` = 每行一个容器（game / viewer）。 */
interface RenderPanelSkin {
  variant: 'grid' | 'row';
  /** row 变体的行容器类名。 */
  rowClass: string;
  /** checkbox 行的类名（debug 的 `.ctrl-checkbox-row` / viewer 的 `.field.field-check`）。 */
  checkRowClass: string;
  /** checkbox 行用 `<label>` 还是 `<div>` 作容器（viewer 是 label，点哪都能勾）。 */
  checkRowTag: 'div' | 'label';
  /**
   * checkbox 行里控件是否在标注**之前**。
   * 逐端读实现得到：debug 的 `.ctrl-checkbox-row`（`apps/debug/web/index.html:703`）与
   * viewer 的 `.field.field-check`（`apps/viewer/src/core/dom.ts:125`）都是 input 在前；
   * 而 game 的 `#panel .row` 是「label 占第 1 列、checkbox 用 grid-column:3 落读数位」
   * （`apps/game/web/styles.css:417/438`）⇒ input 若排在前，grid 自动排布会把后面的标注挤到下一行
   * （owner 2026-10-16 报的「PVS 复选框与行错开」就是这个）。
   */
  checkInputFirst: boolean;
  /** 标注元素标签（viewer 用 `span.field-label`；debug/game 用裸 `<label>`）。 */
  labelTag: 'label' | 'span';
  labelClass: string;
  /** true = 生成 `.rp-label` 标注格（含复位按钮）；false = 裸标注，复位按钮挂行尾（viewer）。 */
  wrapLabel: boolean;
  resetClass: string;
  resetText: string;
  /** 读数单元：外层类名（debug/game 的 `.val`）与数字输入类名。 */
  valueCellClass: string;
  numberClass: string;
  rangeClass: string;
  selectClass: string;
  textClass: string;
  unitClass: string;
  /** grid 变体的「跨整行」类名。 */
  fullClass: string;
  groupTag: 'div' | 'h4';
  groupClass: string;
  /** row 变体给分组包一层（viewer 的 `.sec` > `.sec-body`）。 */
  groupWrapClass: string;
  groupBodyClass: string;
  noteClass: string;
  /** 提示条是否放在行容器内部（game 的 `.row` 是栅格，放行内跨整行才对齐；viewer 的 `.field` 是 flex，放外面）。 */
  noteInRow: boolean;
}

const SKINS: Record<RenderPanelApp, RenderPanelSkin> = {
  // debug：扁平栅格（宿主 div 自带 .ctrl-grid），标注格 + 复位按钮占第 1 列
  debug: {
    variant: 'grid',
    rowClass: '',
    checkRowClass: 'ctrl-checkbox-row ctrl-full',
    checkRowTag: 'div',
    checkInputFirst: true,
    labelTag: 'label',
    labelClass: '',
    wrapLabel: true,
    resetClass: 'rp-reset',
    resetText: '默认',
    valueCellClass: 'val',
    numberClass: 'param-num',
    rangeClass: '',
    selectClass: '',
    textClass: 'rp-text',
    unitClass: 'rp-unit',
    fullClass: 'ctrl-full',
    groupTag: 'div',
    groupClass: 'acc-section-title ctrl-full',
    groupWrapClass: '',
    groupBodyClass: '',
    noteClass: 'rp-note ctrl-full',
    noteInRow: false,
  },
  // game：每行一个 .row（168/1fr/88），标注格 + 复位按钮占第 1 列
  game: {
    variant: 'row',
    rowClass: 'row rp-row',
    checkRowClass: 'row rp-row',
    checkRowTag: 'div',
    checkInputFirst: false,
    labelTag: 'label',
    labelClass: '',
    wrapLabel: true,
    resetClass: 'rp-reset',
    resetText: '默认',
    valueCellClass: 'val',
    numberClass: '',
    rangeClass: '',
    selectClass: '',
    textClass: 'rp-text',
    unitClass: 'unit',
    fullClass: '',
    groupTag: 'h4',
    groupClass: '',
    groupWrapClass: '',
    groupBodyClass: '',
    noteClass: 'rp-note',
    noteInRow: true,
  },
  // viewer：.sec > .sec-title + .sec-body，行是 .field（flex），复位按钮用本页 .btn.small 停在行尾
  viewer: {
    variant: 'row',
    rowClass: 'field rp-field',
    checkRowClass: 'field field-check rp-field',
    checkRowTag: 'label',
    checkInputFirst: true,
    labelTag: 'span',
    labelClass: 'field-label',
    wrapLabel: false,
    resetClass: 'btn small rp-reset',
    resetText: '默认',
    valueCellClass: '',
    numberClass: 'field-input field-num',
    rangeClass: 'field-range',
    selectClass: 'field-select',
    textClass: 'field-input',
    unitClass: 'rp-unit',
    fullClass: '',
    groupTag: 'div',
    groupClass: 'sec-title',
    groupWrapClass: 'sec',
    groupBodyClass: 'sec-body',
    noteClass: 'note note-info',
    noteInRow: false,
  },
};

/** 行内控件的 id（`rp-<item.id>`；数字输入是 `rp-<item.id>-num`）。 */
export const renderPanelControlId = (item: RenderPanelItem): string => 'rp-' + item.id;

const noteTextOf = (item: RenderPanelItem): string =>
  item.note ?? (item.apply === 'reload' ? '需刷新页面生效' : '需重新加载地图生效');

const needsNote = (item: RenderPanelItem): boolean => Boolean(item.note) || item.apply !== 'live';

function makeNote(item: RenderPanelItem, skin: RenderPanelSkin): HTMLElement {
  const note = document.createElement('div');
  note.className = skin.noteClass;
  note.textContent = noteTextOf(item);
  return note;
}

function makeReset(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = skin.resetClass;
  btn.textContent = skin.resetText;
  btn.title = '恢复该项默认值';
  btn.addEventListener('click', (ev) => {
    // 标注格里的按钮可能落在 <label> 的点击范围内（viewer 的 checkbox 行就是 label 容器），别把点击顺带给控件
    ev.preventDefault();
    ev.stopPropagation();
    api.reset(item);
    api.afterWrite?.(item);
    onChange();
  });
  return btn;
}

/** 输入过程中只判合法（不改值、不夹取、不回写文本）——owner 2026-10-16：输入 "6" 想打 64 时不许当场被夹成下限。 */
function markValidity(num: HTMLInputElement, item: RenderPanelItem): void {
  const raw = num.value.trim();
  const v = Number(raw);
  const bad = raw === '' || !Number.isFinite(v) || (item.min !== undefined && v < item.min) || (item.max !== undefined && v > item.max);
  num.classList.toggle('rp-invalid', bad);
}

/**
 * 按 `step` 对齐：步进 1 的项提交 66.7 必须落到 67（否则滑块与数字框会不一致）。
 * 小数位取 step 的位数，避免 0.1 步进出现 66.70000000000001。
 */
export function snapToStep(v: number, step: number | undefined, min: number | undefined): number {
  if (!Number.isFinite(step) || (step ?? 0) <= 0) return v;
  const base = min ?? 0;
  const snapped = Math.round((v - base) / (step as number)) * (step as number) + base;
  const decimals = Math.min(6, (String(step).split('.')[1] ?? '').length);
  return Number(snapped.toFixed(decimals));
}

/**
 * 提交（失焦 / 回车）：夹到 [min,max] → 按 step 对齐 → 回写控件 → 应用。
 * **回写只在本框没有焦点时做**（否则会把用户的光标顶回开头，表现为「打了个 . 就变成 |66」）。
 */
function commitNumber(num: HTMLInputElement, item: RenderPanelItem, api: RenderPanelApi, onChange: () => void): void {
  const v = Number(num.value);
  if (!Number.isFinite(v)) { onChange(); return; }
  const min = item.min ?? v;
  const max = item.max ?? v;
  const clamped = snapToStep(Math.min(max, Math.max(min, v)), item.step, min);
  if (document.activeElement !== num) num.value = String(clamped);
  num.classList.remove('rp-invalid');
  api.write(item, clamped);
  api.afterWrite?.(item);
  onChange();
}

function makeNumber(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const num = document.createElement('input');
  num.type = 'number';
  num.id = renderPanelControlId(item) + '-num';
  num.className = skin.numberClass;
  num.min = String(item.min ?? 0);
  num.max = String(item.max ?? 1);
  num.step = String(item.step ?? 0.01);
  num.addEventListener('input', () => markValidity(num, item));
  const unit = item.unit;
  if (!skin.valueCellClass && unit) {
    // viewer 没有 .val 包裹层：数字输入直接是 flex 子项，单位跟在它后面
    num.addEventListener('change', () => commitNumber(num, item, api, onChange));
    const wrap = document.createElement('span');
    wrap.className = 'rp-value';
    wrap.append(num);
    const u = document.createElement('span');
    u.className = skin.unitClass;
    u.textContent = unit;
    wrap.append(u);
    return wrap;
  }
  num.addEventListener('change', () => {
    const v = Number(num.value);
    if (!Number.isFinite(v)) return;
    api.write(item, v);
    api.afterWrite?.(item);
    onChange();
  });
  return num;
}

/** 读数单元：debug/game 是 `.val > input`（+ 单位），viewer 是裸的 `.field-input.field-num`（+ 单位）。 */
function makeValueCell(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const num = makeNumber(item, skin, api, onChange);
  if (num.classList.contains('rp-value')) return num;
  const cell = document.createElement('div');
  cell.className = skin.valueCellClass;
  cell.append(num);
  if (item.unit) {
    const u = document.createElement('span');
    u.className = skin.unitClass;
    u.textContent = item.unit;
    cell.append(u);
  }
  return cell;
}

/** 行内主控件（滑块 / 下拉 / 文本框；数值框由 makeValueCell 单独出）。 */
function makeControl(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const id = renderPanelControlId(item);
  if (item.kind === 'select') {
    const select = document.createElement('select');
    select.id = id;
    select.className = skin.selectClass;
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
  if (item.kind === 'tags') {
    // **标签式输入**（owner 2026-10-16）：**存储口径不变**（仍是逗号分隔字符串，面板 prefs 与
    // 实现读的都是它），只是界面从「一个纯文本框」换成「胶囊 + 输入框」—— 回车或逗号成一枚，
    // 点胶囊上的 × 删一枚。多名字时不必在一行里数逗号。
    const wrap = document.createElement('div');
    wrap.className = 'rp-tags';
    const input = document.createElement('input');
    input.type = 'text';
    // **id 必须留在 input 上**：`syncRenderPanel` 是按 id 找控件回写值的（见该函数）
    input.id = id;
    input.className = skin.textClass;
    input.title = '回车或逗号分隔；点标签上的 × 移除';
    const names = (): string[] => input.value.split(',').map((s) => s.trim()).filter(Boolean);
    const paint = (): void => {
      for (const chip of [...wrap.querySelectorAll('.rp-tag')]) chip.remove();
      for (const nm of names()) {
        const chip = document.createElement('span');
        chip.className = 'rp-tag';
        chip.textContent = nm;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'rp-tag-x';
        x.textContent = '×';
        x.title = '移除 ' + nm;
        x.addEventListener('click', () => {
          input.value = names().filter((other) => other !== nm).join(',');
          commit();
        });
        chip.append(x);
        wrap.append(chip);
      }
      wrap.append(input);
    };
    const commit = (): void => {
      const uniq = [...new Set(names())];
      const joined = uniq.join(',');
      if (joined !== input.value) input.value = joined;
      api.write(item, joined);
      api.afterWrite?.(item);
      paint();
      onChange();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        commit();
      }
    });
    // 同步循环回写 input.value 之后要重画胶囊（「全部恢复默认」/ 外部写入都跟上）
    (input as HTMLInputElement & { __rpTags?: () => void }).__rpTags = paint;
    paint();
    return wrap;
  }
  if (item.kind === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = skin.textClass;
    input.addEventListener('change', () => {
      api.write(item, input.value);
      api.afterWrite?.(item);
      onChange();
    });
    return input;
  }
  const range = document.createElement('input');
  range.type = 'range';
  range.id = id;
  range.className = skin.rangeClass;
  range.min = String(item.min ?? 0);
  range.max = String(item.max ?? 1);
  range.step = String(item.step ?? 0.01);
  range.addEventListener('input', () => {
    const v = Number(range.value);
    if (!Number.isFinite(v)) return;
    api.write(item, v);
    api.afterWrite?.(item);
    onChange();
  });
  return range;
}

/** 标注格：debug/game 是 `.rp-label`（标注 + 复位按钮同格），viewer 是裸 `span.field-label`（复位挂行尾）。 */
function makeLabel(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const id = renderPanelControlId(item);
  const label = document.createElement(skin.labelTag === 'span' ? 'span' : 'label');
  if (skin.labelClass) label.className = skin.labelClass;
  if (label instanceof HTMLLabelElement) label.htmlFor = id;
  label.textContent = item.label;
  label.title = item.title;
  if (!skin.wrapLabel) return label;
  const cell = document.createElement('div');
  cell.className = 'rp-label';
  cell.append(label, makeReset(item, skin, api, onChange));
  return cell;
}

function buildToggleRow(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement {
  const id = renderPanelControlId(item);
  const row = document.createElement(skin.checkRowTag);
  row.className = skin.checkRowClass;
  row.title = item.title;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = id;
  box.addEventListener('change', () => {
    api.write(item, box.checked);
    api.afterWrite?.(item);
    onChange();
  });
  // 两端既有复选框行都是 input 在前：debug `.ctrl-checkbox-row`（html:703）、viewer `.field.field-check`（dom.ts:125）
  const label = document.createElement(skin.labelTag === 'span' ? 'span' : 'label');
  if (skin.labelClass) label.className = skin.labelClass;
  if (label instanceof HTMLLabelElement) label.htmlFor = id;
  label.textContent = item.label;
  // 顺序按各端原生行来（game 必须「标注在前」：它的 checkbox 被钉在第 3 列，input 在前会把标注挤到下一行）
  if (skin.checkInputFirst) row.append(box, label);
  else row.append(label, box);
  // 每个可改项都要有独立复位（owner 2026-10-16：默认按钮设置不全）
  if (skin.wrapLabel) {
    const cell = document.createElement('span');
    cell.className = 'rp-toggle-reset';
    cell.append(makeReset(item, skin, api, onChange));
    row.append(cell);
  } else {
    row.append(makeReset(item, skin, api, onChange));
  }
  return row;
}

function buildItem(item: RenderPanelItem, skin: RenderPanelSkin, api: RenderPanelApi, onChange: () => void): HTMLElement[] {
  if (item.kind === 'toggle') return [buildToggleRow(item, skin, api, onChange)];

  const control = makeControl(item, skin, api, onChange);
  const hasValue = item.kind === 'slider';
  if (skin.variant === 'grid') {
    // debug：label 格 / 控件 / 读数 都是宿主 .ctrl-grid 的直接子元素（与既有行完全同构）
    const out = [makeLabel(item, skin, api, onChange), control];
    if (hasValue) out.push(makeValueCell(item, skin, api, onChange));
    if (needsNote(item)) out.push(makeNote(item, skin));
    return out;
  }
  const row = document.createElement('div');
  row.className = skin.rowClass;
  row.append(makeLabel(item, skin, api, onChange), control);
  if (hasValue) row.append(makeValueCell(item, skin, api, onChange));
  if (!skin.wrapLabel) row.append(makeReset(item, skin, api, onChange));
  if (needsNote(item) && skin.noteInRow) row.append(makeNote(item, skin));
  return skin.noteInRow ? [row] : [row, makeNote(item, skin)];
}

/** 用当前值回写所有控件显示（构建后与外部改动后都可调）。 */
export function syncRenderPanel(host: HTMLElement, api: RenderPanelApi): void {
  for (const item of panelItemsFor(api.app)) {
    const v = api.read(item);
    const id = CSS.escape(renderPanelControlId(item));
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement>('#' + id);
    const num = host.querySelector<HTMLInputElement>('#' + CSS.escape(renderPanelControlId(item) + '-num'));
    // 正在输入的控件不回写：任何同步都不许动用户的光标（owner 2026-10-16：输入小数时光标被顶回开头）
    const focused = document.activeElement;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === true;
    else if (el instanceof HTMLSelectElement) { if (el !== focused) el.value = String(v); }
    else if (el instanceof HTMLInputElement) {
      if (el !== focused) el.value = String(v);
      // tags 控件的胶囊跟着重画：否则「全部恢复默认」之后旧胶囊还挂着
      (el as HTMLInputElement & { __rpTags?: () => void }).__rpTags?.();
    }
    if (num && num !== focused) num.value = String(v);
  }
}

/**
 * 构建面板：按 `panelGroupsFor(app)` 逐组、按该端 skin 的结构生成 DOM 挂到 `host` 下。
 * 每次控件变动都会先写值、再回写显示（数值输入与滑块同步）。
 */
export function buildRenderPanel(host: HTMLElement, api: RenderPanelApi): { sync: () => void } {
  host.textContent = '';
  const skin = SKINS[api.app];
  // 顶部状态行（只有调用方给了 hasMap 才渲染；载图后由调用方再调 sync() 刷新）
  const state = api.hasMap ? document.createElement('div') : null;
  if (state) {
    state.className = 'rp-mapstate';
    host.append(state);
  }
  const sync = () => {
    syncRenderPanel(host, api);
    if (state) state.textContent = api.hasMap?.() ? '' : '当前未载入地图 —— 以下改动会在下次加载地图后生效';
  };
  for (const group of panelGroupsFor(api.app)) {
    const items = panelItemsFor(api.app).filter((i) => i.group === group);
    if (!items.length) continue;
    const title = document.createElement(skin.groupTag);
    if (skin.groupClass) title.className = skin.groupClass;
    title.textContent = group;
    let body: HTMLElement = host;
    if (skin.groupWrapClass) {
      const sec = document.createElement('div');
      sec.className = skin.groupWrapClass;
      body = document.createElement('div');
      body.className = skin.groupBodyClass;
      sec.append(title, body);
      host.append(sec);
    } else {
      host.append(title);
    }
    for (const item of items) body.append(...buildItem(item, skin, api, sync));
  }
  // 面板级复位：本面板所有项一次性回到默认（owner 2026-10-16：tab 内也要有一个全局重置）
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'rp-reset-all';
  all.textContent = '全部恢复默认';
  all.title = '把本面板所有项恢复为默认值';
  all.addEventListener('click', () => {
    for (const item of panelItemsFor(api.app)) api.reset(item);
    sync();
  });
  host.append(all);
  sync();
  return { sync };
}
