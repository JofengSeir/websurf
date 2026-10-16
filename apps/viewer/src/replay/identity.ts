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

/**
 * **用户手工指定的名字 → 账号**映射（localStorage，跨录像生效）。
 *
 * 为什么必须有这条出口：有些改名在档案里**没有任何字段能连起来** —— 实测 boreas dem 里
 * `[yuzusoft] GalgameEnjoyer1337` 只出现在聊天**发言行**（发言行不带 SteamID），而 userinfo 与
 * 连接行给的是改名后的「她不一样」。程序不能硬猜，只能让用户指认一次，之后按 guid 一直生效。
 */
const NAME_ALIAS_KEY = 'vbsp:demNameAliases';

/** 读落盘的名字别名表（guid → 名字数组）；读不到给空表。 */
export function readNameAliases(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(NAME_ALIAS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    }
    return out;
  } catch {
    return {};
  }
}

/** 把一个名字并入某个 guid（去重、trim、立即落盘），返回更新后的表。 */
export function addNameAlias(guid: string, name: string): Record<string, string[]> {
  const g = guid.trim();
  const nm = name.trim();
  const table = readNameAliases();
  if (!g || !nm) return table;
  const list = table[g] ?? [];
  if (!list.includes(nm)) list.push(nm);
  table[g] = list;
  try {
    localStorage.setItem(NAME_ALIAS_KEY, JSON.stringify(table));
  } catch (err) {
    console.warn('[dem-alias] 保存失败（本次仍生效）:', err);
  }
  return table;
}

/** 从某个 guid 上摘掉一个名字，返回更新后的表。 */
export function removeNameAlias(guid: string, name: string): Record<string, string[]> {
  const table = readNameAliases();
  const list = (table[guid] ?? []).filter((x) => x !== name);
  if (list.length > 0) table[guid] = list;
  else delete table[guid];
  try {
    localStorage.setItem(NAME_ALIAS_KEY, JSON.stringify(table));
  } catch (err) {
    console.warn('[dem-alias] 保存失败:', err);
  }
  return table;
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
  // **歧义名字不硬猜**（T-712 实测）：服务器会把**显示名**改来改去，同一个显示名可能被两个账号
  // 先后用过 —— boreas 里 `S-f4Ce` 既出现在 [U:1:1425188194] 的发言里，也出现在槽位 6
  // （账号 [U:1:162031570]、userinfo 名 GenShinEnjoyer8267）的发言里。这类名字连给谁都是猜，
  // 一律从表里摘掉、放进 unlinkedNames，交给用户用面板上的「名字并入选中的人」指认一次。
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

