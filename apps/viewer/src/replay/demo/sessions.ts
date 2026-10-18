/**
 * 槽位会话状态机。
 *
 * 为什么要有这一层：花名册不该假设「槽位按固定顺序被占用」，也不该把「会话结束」绑在
 * 「下一条 userinfo」上 —— 真实服务器里几十号人进出、被踢、改名、重连、同一账号换槽位，
 * 顺序随时会乱。这里只做一件事：把 `userinfo` 的逐条记录与聊天里的断开公告合成一条
 * **按 tick 排序的事件流**，再用每个槽位一份的状态机推出会话区间。
 *
 * 状态机规则（与顺序无关，只看事件）：
 * - 同槽、同 `userId` 的 userinfo：只是**改名/换 guid**，不切会话；
 * - 同槽、不同 `userId`：正常换人 ⇒ 旧会话止于本 tick，新会话从本 tick 起；
 * - 断开公告（带 guid）：把该 guid **当前打开的会话**都止于公告 tick，并记原因（被踢 / 断线）；
 * - 片尾仍未关闭的会话：止于片尾，标 `end: 'eof'`。
 *
 * 槽位 → 实体号仍按引擎约定 `entity = slot + 1`（Source 把玩家槽 i 的实体放在 i+1），
 * 但这里**不据此推断顺序**：会话的起止完全由事件决定，实体号只作为位姿查询的键。
 */

import { decodePlayerInfoRecords, type DemoParseResult } from './demo.js';
import { userinfoTimeline } from './net.js';
import { parseDisconnectEvents, type DisconnectEvent } from '../identity.js';

/** 一条 `userinfo` 记录（同一槽位同 userId 的重复记录已由调用方折叠为改名事件）。 */
export interface UserInfoEvent {
  tick: number;
  slot: number;
  userId: number;
  guid: string;
  name: string;
  isBot: boolean;
}

export type SessionEnd = 'join' | 'disconnect' | 'eof';

export interface SlotSession {
  slot: number;
  /** 引擎约定：玩家槽 i 的实体号 = i + 1。 */
  entity: number;
  userId: number;
  guid: string;
  name: string;
  isBot: boolean;
  from: number;
  to: number;
  end: SessionEnd;
  /** `end === 'disconnect'` 时的原因原文（`被管理员踢出` / `Client Disconnect` …）。 */
  endReason?: string;
}

/** 引擎约定：玩家槽 i → 实体 i+1。集中一处，别在调用点各写一遍。 */
export function entityForSlot(slot: number): number {
  return slot + 1;
}

/**
 * 从 `userinfoTimeline` 抽出**去重后的**记录：同槽同 userId 只保留一条，名字取最后一次。
 *
 * 为什么先折叠：几十号人反复重连时同一 uid 会被反复写入，逐条都当"进服"会切出大量 0 长会话。
 */
export function collectUserInfoEvents(): UserInfoEvent[] {
  const byKey = new Map<string, UserInfoEvent>();
  for (const snap of userinfoTimeline) {
    for (const entry of snap.entries) {
      for (const rec of decodePlayerInfoRecords(entry.value, entry.idx)) {
        if (rec.slot < 0 || rec.slot > 63) continue;
        const key = rec.slot + '/' + rec.userId;
        const cur = byKey.get(key);
        if (cur) {
          if (rec.name) cur.name = rec.name;
          if (rec.guid) cur.guid = rec.guid;
          continue;
        }
        byKey.set(key, { tick: snap.tick, slot: rec.slot, userId: rec.userId, guid: rec.guid, name: rec.name, isBot: rec.isBot });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.tick - b.tick || a.slot - b.slot);
}

/**
 * 纯状态机：事件 + 断开公告 + 片尾 ⇒ 会话列表。不读全局、不依赖槽位顺序，便于用合成数据压测。
 */
export function sessionize(
  events: readonly UserInfoEvent[],
  disconnects: readonly DisconnectEvent[],
  totalTicks: number,
): SlotSession[] {
  const total = Math.max(1, Math.floor(totalTicks));
  const out: SlotSession[] = [];
  const open = new Map<number, SlotSession>();
  // 事件按 tick 合并；同一 tick 先处理断开、再处理 userinfo（踢出与重连撞在同一 tick 时不该并成一段）。
  type Item = { tick: number; kind: 0 | 1; ev?: UserInfoEvent; disc?: DisconnectEvent };
  const items: Item[] = [];
  for (const ev of events) if (ev.tick >= 0 && ev.tick <= total) items.push({ tick: ev.tick, kind: 1, ev });
  for (const d of disconnects) if (d.tick >= 0 && d.tick <= total) items.push({ tick: d.tick, kind: 0, disc: d });
  items.sort((a, b) => a.tick - b.tick || a.kind - b.kind);

  const close = (s: SlotSession, tick: number, end: SessionEnd, reason?: string): void => {
    s.to = Math.max(s.from, Math.min(tick, total));
    s.end = end;
    if (reason) s.endReason = reason;
    out.push(s);
    if (open.get(s.slot) === s) open.delete(s.slot);
  };

  for (const it of items) {
    if (it.kind === 0 && it.disc) {
      const d = it.disc;
      if (!d.guid || d.guid === 'BOT') continue;
      // 同一 guid 可能同时占多个槽位（异常但真实存在）⇒ 全部收口。
      for (const s of [...open.values()]) {
        if (s.guid !== d.guid) continue;
        close(s, d.tick, 'disconnect', d.reason || 'disconnected');
      }
      continue;
    }
    const ev = it.ev;
    if (!ev) continue;
    const cur = open.get(ev.slot);
    if (cur && cur.userId === ev.userId) {
      // 同一次占用里的改名 / guid 变化：不切会话。
      if (ev.name) cur.name = ev.name;
      if (ev.guid) cur.guid = ev.guid;
      cur.isBot = ev.isBot;
      continue;
    }
    if (cur) close(cur, ev.tick, 'join');
    const s: SlotSession = {
      slot: ev.slot,
      entity: entityForSlot(ev.slot),
      userId: ev.userId,
      guid: ev.guid,
      name: ev.name,
      isBot: ev.isBot,
      from: ev.tick,
      to: total,
      end: 'eof',
    };
    open.set(ev.slot, s);
  }
  for (const s of [...open.values()]) close(s, total, 'eof');
  return out.sort((a, b) => a.from - b.from || a.slot - b.slot);
}

/** 从解析结果构建全部会话（供面板与 node 侧回归脚本共用）。 */
export function buildSessions(result: DemoParseResult, totalTicks?: number): SlotSession[] {
  const total = totalTicks ?? result.header.playbackTicks;
  return sessionize(collectUserInfoEvents(), parseDisconnectEvents(result.chat), total);
}
