/**
 * 极小 DOM 工具：面板 UI 大量构建 DOM，这里收敛样板。
 *
 * 导出与契约：
 * - `qs(id)`：`document.getElementById` + 类型断言；元素不存在时返回 null（调用方判空）。
 * - `el(tag, cls?, text?, attrs?)`：`document.createElement`，可选写 className 与 textContent，
 *   再把 `attrs` 逐项 `setAttribute`——值为 `undefined` / `false` 的键跳过，值为 `true` 的键
 *   写成空串，其余走 `String(v)`。**只设属性，不绑事件**。内部 `Attrs` 是它的入参类型
 *   （string | number | boolean | undefined）。
 * - 其余导出都是「建结构 + 立即挂到 parent」的构件，返回新建的容器或输入元素。
 *
 * 消费方：`apps/viewer/src/ui/` 与 `apps/viewer/src/replay/` 下的面板模块
 * （`hud.ts`、`mapinfo.ts`、`replaymeta.ts`、`telemetry.ts`、`replay/panel.ts`、
 * `replay/trackpanel.ts`、`replay/timeline.ts`）。类名契约落在
 * `apps/viewer/web/styles.css`：`sec` / `sec-title` / `sec-body`、`fold` / `fold-title` /
 * `fold-name` / `fold-body`、`field` / `field-label` / `field-input` / `field-num` /
 * `field-check`、`btn-row` / `btn`、`note` 与 `note-info` / `note-warn` / `note-error`，
 * 以及数字输入非法态的 `invalid`。
 *
 * 共同约定：不查询既有 DOM、不做清理、不绑全局事件；每个函数只负责建节点并返回。
 */

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

/** 面板分区：`sec` 容器内建 `sec-title` 标题与 `sec-body` 内容容器，返回后者供填充。 */
export function section(parent: HTMLElement, title: string): HTMLElement {
  const box = el('div', 'sec');
  const head = el('div', 'sec-title', title);
  const body = el('div', 'sec-body');
  box.append(head, body);
  parent.appendChild(box);
  return body;
}

/**
 * 可折叠分组（`<details>` / `<summary>`）：`fold` 容器 + `fold-title` 折叠头 +
 * `fold-body` 内容容器，返回 details 与 body 两个句柄。
 * `opts.open` 只在为真时置 `details.open`；折叠头里只放 `fold-name` 标题文本，
 * 组内控件一律挂在 body 下（与 summary 平级），不受折叠头点击影响。
 * 构造时全量渲染，折叠只改变可见性。
 */
export function foldBox(
  parent: HTMLElement,
  title: string,
  opts?: { open?: boolean },
): { details: HTMLDetailsElement; body: HTMLElement } {
  const details = el('details', 'fold');
  if (opts?.open) details.open = true;
  const head = el('summary', 'fold-title');
  head.appendChild(el('span', 'fold-name', title));
  details.appendChild(head);
  const body = el('div', 'fold-body');
  details.appendChild(body);
  parent.appendChild(details);
  return { details, body };
}

interface NumOpts {
  label: string;
  value: number;
  step?: number;
  hint?: string;
  onInput?: (v: number, valid: boolean) => void;
}

/**
 * 数字输入行（`field` + `field-label` + `field-input field-num`），返回输入元素。
 *
 * `opts.step` 与 `opts.hint` 分别写到 `input.step` 与 `input.title`；每次 `input` 事件里
 * `Number(input.value)` 为有限数才算有效，并同步 `invalid` 类，无效时回调
 * `onInput(NaN, false)`。
 * 边界：空串经 `Number('')` 得 0，落到有效分支。是否保留上一次有效值由调用方决定——
 * `apps/viewer/src/replay/panel.ts` 的 `applyTransformFromInputs` 在非有限值时直接返回。
 */
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

/** 勾选行（`field field-check`）：`input[type=checkbox]` + 标签文本，返回输入元素；`hint` 写到行元素的 title。 */
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

/** 一行按钮组（`btn-row`）：逐个建 `type=button` 的 `btn` 并绑 `click`，返回该行容器。 */
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

/**
 * 状态/错误提示行（`note`）：返回一个写文本的闭包。
 * 闭包第二参 `kind` 取 `'info' | 'warn' | 'error'`（默认 `info`），写成 `note note-<kind>`；
 * 传空文本时清空内容并隐藏该行（`display: none`）。行初始为隐藏态。
 */
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
