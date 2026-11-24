/**
 * `CEventAction` / `CBaseEntityOutput` / `COutput*` 家族的 1:1 复刻。
 *
 * 对照 Source SDK 2013：
 * - `game/server/entityoutput.h:20-199`（字段、模板、typedef）
 * - `game/server/cbase.cpp:117-191`（`CEventAction` 构造 / ESC 分隔解析）
 * - `game/server/cbase.cpp:306-431`（`FireOutput` / `COutputEvent::FireOutput`）
 * - `game/server/cbase.cpp:434-443`（`ParseEventAction` / `AddEventAction` 头插）
 * - `src/public/fgdlib/entitydefs.h:19`（`VMF_IOPARAM_STRING_DELIMITER = 0x1b`）
 *
 * 四个必须保留的引擎硬语义：
 * 1. 分隔符 **ESC(0x1b) 优先，否则逗号**；字段 `target,input,parameter,delay,times`。
 *    input 空 ⇒ `"Use"`；parameter 空 ⇒ NULL（不覆盖默认参数）；times=0 ⇒ EVENT_FIRE_ALWAYS(-1)。
 * 2. `AddEventAction` 是**头插**：同一输出名的多条连接，触发顺序与地图书写顺序相反。
 * 3. `FireOutput` **无条件入队**，delay=0 也走事件队列，从不同步调用 `AcceptInput`。
 * 4. 参数覆盖分支用全新 `FIELD_STRING` 覆盖值，且延迟只取 `ev.delay`（**不加 fDelay**）；
 *    无覆盖分支用传入 value 且取 `ev.delay + fDelay`。这个不对称是引擎既有行为。
 */
import { g_Runtime } from './runtime.js';
import type { EntityLike } from './types.js';
import {
  FIELD_BOOLEAN,
  FIELD_COLOR32,
  FIELD_EHANDLE,
  FIELD_FLOAT,
  FIELD_INPUT,
  FIELD_INTEGER,
  FIELD_STRING,
  FIELD_VECTOR,
  type FieldType,
  Variant,
  atof,
  atoi,
} from './variant.js';

/** `EVENT_FIRE_ALWAYS`（entityoutput.h:20）。 */
export const EVENT_FIRE_ALWAYS = -1;

/** ESC：Hammer 用它分隔 I/O 字段，让参数里可以带逗号（entitydefs.h:19）。 */
export const VMF_IOPARAM_STRING_DELIMITER = '\x1b';

/** 一条输出连接（`CEventAction`）。 */
export class EventAction {
  /** `m_iTarget`，null = NULL_STRING。 */
  target: string | null = null;
  /** `m_iTargetInput`，null = NULL_STRING（空构造时保持 null）。 */
  targetInput: string | null = null;
  /** `m_iParameter`，null = NULL_STRING ⇒ 不覆盖默认参数。 */
  parameter: string | null = null;
  /** `m_flDelay`。 */
  delay = 0;
  /** `m_nTimesToFire`，-1 = 无限。 */
  timesToFire: number = EVENT_FIRE_ALWAYS;
  /** `m_iIDStamp`：传给 `AcceptInput` 的 outputID。 */
  readonly idStamp: number;

  private static s_iNextIDStamp = 0;

  constructor(actionData?: string | null) {
    this.idStamp = ++EventAction.s_iNextIDStamp;
    if (actionData === null || actionData === undefined) return;

    // cbase.cpp:133-138：串里出现 ESC 就用 ESC，否则退化为逗号。
    const delim = actionData.includes(VMF_IOPARAM_STRING_DELIMITER)
      ? VMF_IOPARAM_STRING_DELIMITER
      : ',';
    const tok = actionData.split(delim);
    const at = (i: number): string => (i < tok.length ? tok[i] : '');

    // 1. target
    if (at(0) !== '') this.target = at(0);
    // 2. input（空 ⇒ "Use"，cbase.cpp:156-159）
    if (at(1) !== '') this.targetInput = at(1);
    else this.targetInput = 'Use';
    // 3. parameter（空 ⇒ NULL_STRING）
    if (at(2) !== '') this.parameter = at(2);
    // 4. delay（atof）
    if (at(3) !== '') this.delay = atof(at(3));
    // 5. times to fire（atoi；0 ⇒ EVENT_FIRE_ALWAYS）
    if (at(4) !== '') {
      const n = atoi(at(4));
      this.timesToFire = n === 0 ? EVENT_FIRE_ALWAYS : n;
    }
  }

  /** 测试用：复位静态 ID 计数器（SDK 的 s_iNextIDStamp 每个进程一份）。 */
  static resetIdStamp(): void {
    EventAction.s_iNextIDStamp = 0;
  }
}

/** `CBaseEntityOutput`。`m_ActionList` 用数组表示，头插即 `unshift`。 */
export class EntityOutput {
  /** `m_Value`：输出对象存的默认参数。 */
  protected value: Variant = new Variant();
  /** `m_ActionList`（单链表，头插）。 */
  protected actionList: EventAction[] = [];

  /** `ParseEventAction` → `AddEventAction(new CEventAction(...))`。 */
  parseEventAction(eventData: string): void {
    this.addEventAction(new EventAction(eventData));
  }

  /** `AddEventAction`：**头插**（cbase.cpp:439-443）。 */
  addEventAction(action: EventAction): void {
    this.actionList.unshift(action);
  }

  removeEventAction(action: EventAction): void {
    const i = this.actionList.indexOf(action);
    if (i >= 0) this.actionList.splice(i, 1);
  }

  deleteAllElements(): void {
    this.actionList.length = 0;
  }

  numberOfElements(): number {
    return this.actionList.length;
  }

  getMaxDelay(): number {
    let max = 0;
    for (const a of this.actionList) if (a.delay > max) max = a.delay;
    return max;
  }

  getFirstAction(): EventAction | null {
    return this.actionList[0] ?? null;
  }

  /**
   * 只读快照（调试/可视化用）：取当前链表全部连接。
   *
   * 同一 output 可能有多条连接（如 ze_cursed 的按钮 OnPressed 同时挂「播音效、加计数器、
   * Kill 自己」），`getFirstAction()` 只给第一条，无法还原完整连锁，因此单独开这个只读接口；
   * 调用方不得修改返回数组（内部仍有 `removeEventAction` 等受控增删）。
   */
  getActionList(): readonly EventAction[] {
    return this.actionList;
  }

  /** 当前默认参数（调试 / 测试用）。 */
  currentValue(): Variant {
    return this.value.clone();
  }

  /**
   * `CBaseEntityOutput::FireOutput`（cbase.cpp:306-418）。
   * 遍历时按 `m_nTimesToFire` 递减，归零即**当场从链表删除**（没有 mark-for-delete）。
   */
  fireOutput(
    value: Variant,
    activator: EntityLike | null,
    caller: EntityLike | null,
    fDelay = 0,
  ): void {
    let i = 0;
    while (i < this.actionList.length) {
      const ev = this.actionList[i];
      const q = g_Runtime.eventQueue;
      const target = ev.target ?? '';
      const input = ev.targetInput ?? '';

      if (ev.parameter === null) {
        // 无参数覆盖：用传入 value，delay = action.delay + fDelay
        q?.addEventByName(target, input, value.clone(), ev.delay + fDelay, activator, caller, ev.idStamp);
      } else {
        // 参数覆盖：新 FIELD_STRING，完全丢弃 value；delay **不加 fDelay**
        const override = Variant.fromString(ev.parameter);
        q?.addEventByName(target, input, override, ev.delay, activator, caller, ev.idStamp);
      }

      let remove = false;
      if (ev.timesToFire !== EVENT_FIRE_ALWAYS) {
        ev.timesToFire--;
        if (ev.timesToFire === 0) remove = true;
      }
      if (remove) this.actionList.splice(i, 1);
      else i++;
    }
  }
}

/** `COutputEvent`：`FireOutput` 传 FIELD_VOID，不读 `m_Value`（cbase.cpp:426-431）。 */
export class OutputEvent extends EntityOutput {
  fire(activator: EntityLike | null, caller: EntityLike | null, fDelay = 0): void {
    this.fireOutput(Variant.void(), activator, caller, fDelay);
  }
}

/**
 * `CEntityOutputTemplate<Type, fieldType>`：`Init` 只写值，`Set` 写值并 fire。
 * 子类决定默认参数的类型。
 */
export class OutputTyped extends EntityOutput {
  constructor(private readonly outType: FieldType) {
    super();
  }

  init(value: unknown): void {
    this.value = new Variant().setFromField(this.outType, value);
  }

  set(value: unknown, activator: EntityLike | null, caller: EntityLike | null): void {
    this.value = new Variant().setFromField(this.outType, value);
    this.fireOutput(this.value.clone(), activator, caller);
  }

  get(): unknown {
    switch (this.outType) {
      case FIELD_FLOAT:
        return this.value.float();
      case FIELD_INTEGER:
        return this.value.int();
      case FIELD_STRING:
        return this.value.string();
      case FIELD_BOOLEAN:
        return this.value.bool();
      case FIELD_VECTOR:
        return this.value.vector3D();
      case FIELD_COLOR32:
        return this.value.color32();
      case FIELD_EHANDLE:
        return this.value.entity();
      default:
        return this.value.clone();
    }
  }
}

/** `COutputFloat` / `COutputInt` / ... 的工厂，与 SDK typedef 一一对应。 */
export function makeOutput(kind: OutputKind): EntityOutput {
  switch (kind) {
    case 'event':
      return new OutputEvent();
    case 'float':
      return new OutputTyped(FIELD_FLOAT);
    case 'int':
      return new OutputTyped(FIELD_INTEGER);
    case 'string':
      return new OutputTyped(FIELD_STRING);
    case 'vector':
      return new OutputTyped(FIELD_VECTOR);
    case 'color32':
      return new OutputTyped(FIELD_COLOR32);
    case 'ehandle':
      return new OutputTyped(FIELD_EHANDLE);
    case 'variant':
      // COutputVariant = CEntityOutputTemplate<variant_t, FIELD_INPUT>。
      // SDK 的 variant_t::Set 没有 FIELD_INPUT 分支 ⇒ 落 default ⇒ FIELD_VOID（见 variant.ts 注释）。
      return new OutputTyped(FIELD_INPUT);
    default:
      return new OutputEvent();
  }
}

export type OutputKind =
  | 'event'
  | 'float'
  | 'int'
  | 'string'
  | 'vector'
  | 'color32'
  | 'ehandle'
  | 'variant';

/** 便于类实现里 fire 带参数的输出（`OutputTyped.set` 的类型安全包装）。 */
export function fireTyped(
  output: EntityOutput,
  value: unknown,
  activator: EntityLike | null,
  caller: EntityLike | null,
): void {
  if (output instanceof OutputTyped) output.set(value, activator, caller);
  else if (output instanceof OutputEvent) output.fire(activator, caller);
  else output.fireOutput(Variant.fromString(String(value ?? '')), activator, caller);
}
