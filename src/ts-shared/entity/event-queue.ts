/**
 * `CEventQueue` 的 1:1 复刻。
 *
 * 对照 Source SDK 2013：
 * - `game/server/eventqueue.h:19-79`（`EventQueuePrioritizedEvent_t` / `CEventQueue`）
 * - `game/server/cbase.cpp:895-1086`（`AddEvent` 四个重载、`ServiceEvents`）
 * - `game/server/gameinterface.cpp:1251-1259`（每服务器帧一次，位于 think 之后）
 *
 * 三个必须保留的引擎硬语义：
 * 1. `m_flFireTime = curtime + fireDelay`；按 fireTime 升序插入，**严格 `>` 才 break**
 *    ⇒ 同一时刻的事件按入队顺序 FIFO（稳定）。
 * 2. `ServiceEvents` 的目标解析顺序：按名字**遍历全部同名匹配** → 直接指针目标 →
 *    （都没找到时）按 classname **遍历全部匹配** → 全失败只记诊断，不抛错。
 * 3. 每处理完一个事件就**重扫链头**（cbase.cpp:1083-1084）⇒ 同 tick 内由输入处理
 *    函数新产生、`delay=0` 的事件会在**同一次 ServiceEvents 调用**里执行。
 *    副作用：0 延迟自环输出会死循环，这里保留该行为并加一个可配置的防爆上限。
 */
import { g_Runtime } from './runtime.js';
import type { EntityLike } from './types.js';
import { Variant } from './variant.js';

export interface QueuedEvent {
  fireTime: number;
  /** `m_iTarget`；null 表示 `m_pEntTarget` 指针目标。 */
  targetName: string | null;
  targetInput: string;
  activator: EntityLike | null;
  caller: EntityLike | null;
  outputID: number;
  /** `m_pEntTarget`：直接指向目标实体，覆盖名字查找。 */
  entTarget: EntityLike | null;
  value: Variant;
}

/** 0 延迟自环的保险丝；引擎没有它，仅用于宿主不被恶意/损坏地图挂死。设为 0 关闭。 */
export const DEFAULT_MAX_EVENTS_PER_SERVICE = 100_000;

export class EventQueue {
  private events: QueuedEvent[] = [];

  get pendingCount(): number {
    return this.events.length;
  }

  /** 只读快照（调试面板 / 测试）。 */
  snapshot(): readonly QueuedEvent[] {
    return this.events;
  }

  /** 名字重载：`FireOutput` 专用（cbase.cpp:895-913）。 */
  addEventByName(
    target: string,
    input: string,
    value: Variant,
    fireDelay: number,
    activator: EntityLike | null,
    caller: EntityLike | null,
    outputID = 0,
  ): void {
    this.insert({
      fireTime: g_Runtime.time + fireDelay,
      targetName: target,
      targetInput: input,
      activator,
      caller,
      outputID,
      entTarget: null,
      value: value.clone(),
    });
  }

  /** 指针重载（cbase.cpp:918-936）：relay 的 EnableRefire、branch 的通知等走这条。 */
  addEventForEntity(
    target: EntityLike,
    input: string,
    value: Variant,
    fireDelay: number,
    activator: EntityLike | null,
    caller: EntityLike | null,
    outputID = 0,
  ): void {
    this.insert({
      fireTime: g_Runtime.time + fireDelay,
      targetName: null,
      targetInput: input,
      activator,
      caller,
      outputID,
      entTarget: target,
      value: value.clone(),
    });
  }

  /** 无参数指针重载（cbase.cpp:938-943）：构造 FIELD_VOID 后转发。 */
  addEventForEntityVoid(
    target: EntityLike,
    input: string,
    fireDelay: number,
    activator: EntityLike | null,
    caller: EntityLike | null,
    outputID = 0,
  ): void {
    this.addEventForEntity(target, input, Variant.void(), fireDelay, activator, caller, outputID);
  }

  /** 私有排序插入：`>` 才 break ⇒ 同 fireTime 的事件插到已有同刻之后（FIFO）。 */
  private insert(ev: QueuedEvent): void {
    let i = 0;
    while (i < this.events.length && this.events[i].fireTime <= ev.fireTime) i++;
    this.events.splice(i, 0, ev);
  }

  /**
   * `ServiceEvents`：处理所有 `fireTime <= now` 的事件。
   * 每次循环都从链头重新找（ thereby 同 tick 新事件本 tick 执行）。
   */
  serviceEvents(now: number = g_Runtime.time, maxEvents = DEFAULT_MAX_EVENTS_PER_SERVICE): number {
    let processed = 0;
    while (true) {
      let idx = -1;
      for (let i = 0; i < this.events.length; i++) {
        if (this.events[i].fireTime <= now) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      if (maxEvents > 0 && processed >= maxEvents) {
        // 保险丝：丢弃剩余到期事件，避免 0 延迟自环把宿主挂死。
        this.events.length = 0;
        break;
      }
      const [pe] = this.events.splice(idx, 1);
      processed++;
      this.dispatch(pe);
    }
    return processed;
  }

  private dispatch(pe: QueuedEvent): void {
    const list = g_Runtime.entList;
    let targetFound = false;

    if (pe.targetName !== null && list) {
      // "In the context the event, the searching entity is also the caller"（cbase.cpp:1010-1011）
      const searching = pe.caller;
      let target: EntityLike | null = null;
      for (;;) {
        target = list.findEntityByName(target, pe.targetName, searching, pe.activator, pe.caller);
        if (!target) break;
        target.acceptInput(pe.targetInput, pe.activator, pe.caller, pe.value.clone(), pe.outputID);
        targetFound = true;
      }
    }

    if (pe.entTarget !== null) {
      pe.entTarget.acceptInput(pe.targetInput, pe.activator, pe.caller, pe.value.clone(), pe.outputID);
      targetFound = true;
    }

    if (!targetFound && pe.targetName !== null && list) {
      let target: EntityLike | null = null;
      for (;;) {
        target = list.findEntityByClassname(target, pe.targetName);
        if (!target) break;
        target.acceptInput(pe.targetInput, pe.activator, pe.caller, pe.value.clone(), pe.outputID);
      }
    }
  }

  /** `CancelEvents(pCaller)`：取消由该实体发出的全部待处理事件（logic_relay 用）。 */
  cancelEvents(caller: EntityLike | null): void {
    this.events = this.events.filter((e) => e.caller !== caller);
  }

  cancelEventOn(target: EntityLike, inputName: string): void {
    const key = inputName.toLowerCase();
    this.events = this.events.filter(
      (e) => !(e.entTarget === target && e.targetInput.toLowerCase() === key),
    );
  }

  hasEventPending(target: EntityLike, inputName: string): boolean {
    const key = inputName.toLowerCase();
    return this.events.some(
      (e) => e.entTarget === target && e.targetInput.toLowerCase() === key,
    );
  }

  clear(): void {
    this.events.length = 0;
  }
}
