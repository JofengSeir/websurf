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
const TAG_RE = /^(\s*\[[^\]]*\]\s*)+/;

/** 归一化名字：剥掉服务器特色前缀并 trim。花名册与按名字找人都用这一套，避免两种写法算两个人。 */
export function normalizeName(s: string): string {
  return s.replace(TAG_RE, '').trim();
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
  chat: ReadonlyArray<{ text: string }>,
  /** 已知账号名字（guid → userinfo 里见到的名字）：把聊天候选名按**完全同名**连回账号。 */
  knownNames?: ReadonlyMap<string, ReadonlySet<string>>,
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
    // 发言行：`[标签] 名字: 正文`
    const say = /^(\[[^\]]*\]\s*)?([^:<]{1,32}?)\s*[:：]\s+\S/.exec(text);
    if (say && say[2]) {
      const name = say[2].trim();
      const base = normalizeName(name);
      if (base && !guidByName.has(base)) unlinkedNames.add(base);
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
  return { namesByGuid, guidByName, unlinkedNames };
}

