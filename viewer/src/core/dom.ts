/** 极小 DOM 工具（面板 UI 大量构建 DOM，避免重复样板）。 */

export function qs<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
  attrs?: Attrs,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return node;
}

/** 面板分区：标题 + 内容容器（内容可后续填充）。 */
export function section(parent: HTMLElement, title: string): HTMLElement {
  const box = el('div', 'sec');
  const head = el('div', 'sec-title', title);
  const body = el('div', 'sec-body');
  box.append(head, body);
  parent.appendChild(box);
  return body;
}

export interface FoldBoxOptions {
  open?: boolean;
  /** 标题右侧的浅色小字说明（如分区内容清单）。 */
  hint?: string;
}

/**
 * 可折叠分组容器（<details>/<summary>）：面板分段折叠用。
 * 构造时全量渲染、仅折叠；折叠头不拦截组内控件事件。
 */
export function foldBox(
  parent: HTMLElement,
  title: string,
  opts?: FoldBoxOptions,
): { details: HTMLDetailsElement; body: HTMLElement } {
  const details = el('details', 'fold');
  if (opts?.open) details.open = true;
  const head = el('summary', 'fold-title');
  head.appendChild(el('span', 'fold-name', title));
  if (opts?.hint) head.appendChild(el('span', 'fold-hint', opts.hint));
  details.appendChild(head);
  const body = el('div', 'fold-body');
  details.appendChild(body);
  parent.appendChild(details);
  return { details, body };
}

interface FieldOpts {
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  onInput?: (v: string) => void;
  onChange?: (v: string) => void;
}

/** 单行文本输入行（label + input + 可选说明）。返回 input 元素。 */
export function textField(parent: HTMLElement, opts: FieldOpts): HTMLInputElement {
  const row = el('label', 'field');
  row.appendChild(el('span', 'field-label', opts.label));
  const input = el('input', 'field-input');
  input.type = 'text';
  input.spellcheck = false;
  if (opts.value !== undefined) input.value = opts.value;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.hint) input.title = opts.hint;
  const onInput = opts.onInput;
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  const onChange = opts.onChange;
  if (onChange) input.addEventListener('change', () => onChange(input.value));
  row.appendChild(input);
  parent.appendChild(row);
  return input;
}

interface NumOpts {
  label: string;
  value: number;
  step?: number;
  hint?: string;
  onInput?: (v: number, valid: boolean) => void;
}

/** 数字输入行。非法输入不上抛（valid=false），保持上一次有效值。 */
export function numField(parent: HTMLElement, opts: NumOpts): HTMLInputElement {
  const row = el('label', 'field');
  row.appendChild(el('span', 'field-label', opts.label));
  const input = el('input', 'field-input field-num');
  input.type = 'number';
  if (opts.step !== undefined) input.step = String(opts.step);
  input.value = String(opts.value);
  if (opts.hint) input.title = opts.hint;
  input.addEventListener('input', () => {
    const n = Number(input.value);
    const valid = Number.isFinite(n);
    input.classList.toggle('invalid', !valid);
    if (valid) opts.onInput?.(n, true);
    else opts.onInput?.(Number.NaN, false);
  });
  row.appendChild(input);
  parent.appendChild(row);
  return input;
}

interface SelectOpts {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  hint?: string;
  onChange: (v: string) => void;
}

export function selectField(parent: HTMLElement, opts: SelectOpts): HTMLSelectElement {
  const row = el('label', 'field');
  row.appendChild(el('span', 'field-label', opts.label));
  const sel = el('select', 'field-input');
  for (const o of opts.options) {
    const opt = el('option', undefined, o.label, { value: o.value });
    sel.appendChild(opt);
  }
  sel.value = opts.value;
  if (opts.hint) sel.title = opts.hint;
  sel.addEventListener('change', () => opts.onChange(sel.value));
  row.appendChild(sel);
  parent.appendChild(row);
  return sel;
}

/** 勾选行。 */
export function checkField(
  parent: HTMLElement,
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
  hint?: string,
): HTMLInputElement {
  const row = el('label', 'field field-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  if (hint) row.title = hint;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(input, el('span', 'field-label', label));
  parent.appendChild(row);
  return input;
}

/** 一行按钮组。 */
export function buttonRow(
  parent: HTMLElement,
  buttons: Array<{ label: string; onClick: () => void; title?: string }>,
): HTMLElement {
  const row = el('div', 'btn-row');
  for (const b of buttons) {
    const btn = el('button', 'btn', b.label, { type: 'button' });
    if (b.title) btn.title = b.title;
    btn.addEventListener('click', b.onClick);
    row.appendChild(btn);
  }
  parent.appendChild(row);
  return row;
}

/** 状态/错误提示行（可反复设置文本，空文本自动隐藏）。 */
export function noteLine(parent: HTMLElement): (text: string, kind?: 'info' | 'warn' | 'error') => void {
  const node = el('div', 'note');
  node.style.display = 'none';
  parent.appendChild(node);
  return (text, kind = 'info') => {
    if (!text) {
      node.style.display = 'none';
      node.textContent = '';
      return;
    }
    node.style.display = '';
    node.textContent = text;
    node.className = 'note note-' + kind;
  };
}
