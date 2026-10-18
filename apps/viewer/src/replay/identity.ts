/**
 * dem 身份别名（T-701）：把「同一个人在这份录像里的多个名字 / 多个 guid 写法」连起来。
 *
 * 为什么要单独一个模块：这套换算（SteamID 形态、服务器特色前缀、发言人行解析）既要给花名册用，
 * 也要给「点过关记录跳转时按名字切视角」用；写在面板里就没法在 node 里对夹具复跑。
 *
 * **能力边界（实测，别当它万能）**：`.dem` 里能把名字连到账号的信息只有
 *   ① userinfo 记录自带的 `guid`
 *   ② 聊天里的连接行 `▲ 名字 < STEAM_0:1:123 > connected`（带 SteamID）
 * 聊天**发言**行（`[标签] 名字: 正文`）只有名字没有 SteamID ⇒ 若这个名字既不在 userinfo、
 * 也没在连接行出现，就**无法判定**它属于哪个账号（boreas dem 的 `[yuzusoft] GalgameEnjoyer1337`
 * 就是这种：它只在发言行里，而 userinfo/连接行给的名字是改名后的「她不一样」）。
 */

/** `STEAM_x:y:z` → `[U:1:2z+y]`（CS:S 的 guid 实测就是后者这种形态）；已是 `[U:…]` 原样返回；BOT 返回空。 */
export function steamIdToGuid(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^BOT$/i.test(s)) return 'BOT';
  const u = /^\[U:1:(\d+)\]$/.exec(s);
  if (u) return s;
  const m = /^STEAM_[0-9]:([0-9]):([0-9]+)$/i.exec(s);
  if (!m) return '';
  const y = Number(m[1]);
  const z = Number(m[2]);
  return Number.isFinite(y) && Number.isFinite(z) ? `[U:1:${2 * z + y}]` : '';
}

/** 服务器特色名字前缀：`[tag] 名字` / `[a|b] 名字`（可能叠多层）。 */
// 发言人 / 前缀归一都复用分类器那一处实现（T-712）：两边各写一套前缀规则必然各自漏形态
import { classifyChat, parseSpeaker, stripChatPrefixes } from './demo/chatkind.js';

const TAG_RE = /^(\s*\[[^\]]*\]\s*)+/;


/** 归一化名字：先剥服务器前缀（客户端号 / 状态 / 队伍 / 军衔），再剥特色标签并 trim。 */
export function normalizeName(s: string): string {
  return stripChatPrefixes(s).replace(TAG_RE, '').trim();
}

/** 从聊天行里能连出的别名。 */
export interface AliasRegistry {
  /** guid（`[U:1:…]` / `BOT`）→ 见到的所有名字（含带前缀的原样写法）。 */
  namesByGuid: Map<string, Set<string>>;
  /** 归一化名字 → guid（连接行建立的确定关系；发言行只登记候选，不建关系）。 */
  guidByName: Map<string, string>;
  /** 只在聊天里出现、未能连到任何账号的名字（发言行候选）。 */
  unlinkedNames: Set<string>;
}

/**
 * 扫聊天行建别名表。
 *
 * 连接行形态（实测）：`▲ 她不一样 < STEAM_0:1:571334856 , 117.144.103.56 > connected from China ( CN )`、
 * `▲ 她不一样 < Admin > has joined.`、`▼ 名字 < STEAM_0:1:… > disconnected. ( Client Disconnect )`。
 * 其中 `< Admin >` 那种没有 SteamID ⇒ 只能当候选名。
 */
export function buildAliasRegistry(
  chat: ReadonlyArray<{ text: string; from?: number | null; tick?: number }>,
  /** 已知账号名字（guid → userinfo 里见到的名字）：把聊天候选名按**完全同名**连回账号。 */
  knownNames?: ReadonlyMap<string, ReadonlySet<string>>,
  /**
   * **发送者槽位 → guid** 的查询（T-712/T-712）：`SayText2` 的 `ent_idx` 是发言者的槽位，
   * 与 userinfo 同一坐标系 ⇒ 用它把「聊天里那个名字」直接连到账号，不必再靠用户手工指认。
   * 返回空串表示该时刻这个槽位没有已知账号。
   */
  guidAtSlot?: (slot: number, tick: number) => string,
): AliasRegistry {
  const namesByGuid = new Map<string, Set<string>>();
  const guidByName = new Map<string, string>();
  const unlinkedNames = new Set<string>();
  const addName = (guid: string, name: string): void => {
    if (!guid || !name) return;
    const set = namesByGuid.get(guid) ?? new Set<string>();
    set.add(name);
    namesByGuid.set(guid, set);
    for (const key of new Set([name, normalizeName(name)])) {
      if (!key) continue;
      guidByName.set(key, guid);
      // 这个候选已经被连上账号了 ⇒ 从「连不到」名单里摘掉（发言行可能先于连接行出现）
      unlinkedNames.delete(key);
    }
  };
  for (const line of chat) {
    const text = String(line.text ?? '');
    // 说明：`line.from`（发送者槽位）与 `line.tick` 由 `net.ts` 的 SayText2 解码提供
    // 连接/断开行：`▲ 名字 < 身份 >`（身份可能是 SteamID、Admin、IP+SteamID 组合）
    const conn = /^[▲▼]\s*(.+?)\s*<([^>]*)>/.exec(text);
    if (conn) {
      const name = conn[1].trim();
      const inner = conn[2];
      const steam = /(STEAM_[0-9]:[0-9]:[0-9]+)/.exec(inner);
      const guid = steam ? steamIdToGuid(steam[1]) : '';
      if (guid) addName(guid, name);
      else unlinkedNames.add(normalizeName(name));
      continue;
    }
    // 发言行：**只听分类器的判决**（`classifyChat === 'chat'`），说话人再从 parseSpeaker 取。
    // 为什么不能只看 parseSpeaker：服务器播报 `[ Timer ] - 地图剩余时间: 20 分钟。` 与过关记录
    // `X 在 Normal模式 下以用时 18.7 完成了 …` **都带冒号**，光看"有冒号"会把它们当发言人
    // （T-712 实测：`未连上` 里混进了「地图剩余时间」「X 在 Normal模式 下以用时 1」）。
    // 分类器里「公告形状 / 过关记录」优先级更高，正是为了挡这一类。
    if (classifyChat(text) !== 'chat') continue;
    const speaker = parseSpeaker(text);
    if (speaker.length > 0) {
      const base = normalizeName(speaker);
      if (!base) continue;
      // **优先用发送者槽位连账号**：连上了就把这个名字登记为该账号的别名（发言人自己写什么就是什么）
      const guid = typeof line.from === 'number' && typeof line.tick === 'number' && guidAtSlot
        ? guidAtSlot(line.from, line.tick)
        : '';
      if (guid) addName(guid, base);
      else if (!guidByName.has(base)) unlinkedNames.add(base);
      continue;
    }
  }
  // 收尾：聊天候选名与账号名完全相等 ⇒ 连回该账号（boreas2 的 KKKsc01 就是这种：没有连接行，
  // 但发言/播报行里的名字与 userinfo 名字一字不差）
  if (knownNames) {
    for (const [guid, names] of knownNames) for (const nm of names) addName(guid, nm);
    for (const cand of [...unlinkedNames]) {
      for (const [guid, names] of knownNames) if (names.has(cand)) { addName(guid, cand); break; }
    }
  }
  // **歧义名字不硬猜**（T-712）：服务器会把**显示名**改来改去，同一个显示名可能被两个账号
  // 先后用过。这类名字连给谁都是猜，一律从表里摘掉、放进 unlinkedNames，交给用户指认一次。
  //
  // 注意：曾经把 `S-f4Ce` 判成"两个账号都用过"其实是个坐标错误 —— CS:S 的 `SayText2.ent_idx`
  // 是**实体号（1-based）**，userinfo 槽位 = ent_idx - 1。按 ent_idx 直接当槽位查，S-f4Ce 的发言
  // 会落到下一位（GenShin 的账号）上，于是看起来像"一个名字被两个账号用过"。修正后
  // `S-f4Ce` 只属于 [U:1:1425188194]，`GalgameEnjoyer1337` 归到 [U:1:1142669713]（其 userinfo
  // 显示名是服务器给的「她不一样」）。
  const owners = new Map<string, Set<string>>();
  for (const [guid, names] of namesByGuid) {
    for (const nm of names) {
      const set = owners.get(nm) ?? new Set<string>();
      set.add(guid);
      owners.set(nm, set);
    }
  }
  for (const [nm, guids] of owners) {
    if (guids.size <= 1) continue;
    for (const guid of guids) {
      const names = namesByGuid.get(guid);
      names?.delete(nm);
      if (names && names.size === 0) namesByGuid.delete(guid);
    }
    guidByName.delete(nm);
    unlinkedNames.add(nm);
  }
  return { namesByGuid, guidByName, unlinkedNames };
}

/** 聊天里的「离开」公告（`▼ 名字 < STEAM_x:y:z > disconnected. ( 原因 )`）。 */
export interface DisconnectEvent {
  tick: number;
  name: string;
  guid: string;
  reason: string;
}

/**
 * 从聊天流里抽出**断开事件**，把「谁什么时候离开」变成可查的时间点。
 *
 * 为什么必须用它：会话结束原先只看「该槽位的下一次 userinfo」，而中途 00:55 进服、02:59 被踢的人
 * 下一条 userinfo 可能到 03:03 才来（或干脆没有）⇒ 会话被拖长、踢人也完全不可见。断开公告自带
 * tick 与原因（`被管理员踢出` / `Client Disconnect`），是唯一能精确切会话的证据。
 *
 * 只认带 SteamID 的公告：`< Admin >` 这类没有账号可对，保留原样（不猜）。
 */
export function parseDisconnectEvents(
  chat: ReadonlyArray<{ tick?: number; text: string }>,
): DisconnectEvent[] {
  const out: DisconnectEvent[] = [];
  const re = /^▼\s*(.+?)\s*<([^>]*)>\s*disconnected\.\s*(?:\((.*?)\))?\s*$/;
  for (const line of chat) {
    if (typeof line.tick !== 'number') continue;
    const m = re.exec(String(line.text ?? ''));
    if (!m) continue;
    const steam = /(STEAM_[0-9]:[0-9]:[0-9]+)/.exec(m[2]);
    const guid = steam ? steamIdToGuid(steam[1]) : m[2].trim().toUpperCase() === 'BOT' ? 'BOT' : '';
    if (!guid) continue;
    out.push({ tick: line.tick, name: m[1].trim(), guid, reason: (m[3] ?? '').trim() });
  }
  return out.sort((a, b) => a.tick - b.tick);
}
