/**
 * **文本消息的分类与过滤**（纯函数，无 DOM）+ 过关记录的跳转时刻换算。
 *
 * 为什么单独成模块：`.dem` 的文本消息全走 `svc_UserMessage` 的 **SayText2**（用户消息号 4），
 * 服务器播报、玩家聊天、进服/掉线公告、过关记录**混在同一个流里**（实测本仓夹具 40 条：
 * 34 条 SourceMod 播报、4 条过关记录、3 条连接/掉线、1 条玩家聊天）。看板要按类别过滤，
 * 过关记录还要能**点一下跳到那一跑**，两件事都得先有一个稳定的分类判据。
 *
 * 分类判据来自**真实语料**（`test/replay/auto-20261001-050330-surf_gigapede.dem` 的 40 条，
 * 逐条抄在 `apps/viewer/test/replay-selftest.ts` 的合成用例里）：
 *
 * - **进服 / 掉线**：SourceMod 用 `▲` / `▼` 起头，正文含 `has joined` / `connected from` /
 *   `disconnected`；中文服另见「已连接 / 已断开 / 加入服务器」等写法。
 * - **过关记录**：`… 在 Segmented模式 下以用时 18.714 完成了 [ 奖励关4 ]。 排名: 1/1`
 *   （另有 `(SR: +0.045 | PB: +0.045 )` 变体）—— 这一条既是要过滤的「过关记录」，
 *   也是要**跳转**的依据（`用时` 就是这一跑的时长）。
 * - **服务器公告**：SourceMod 播报的固定形状是「`[ 标签 ]` + ` - ` + 正文」，
 *   例如 `[ Timer ] - 地图剩余时间: 20 分钟。` —— **注意它有冒号，不能靠冒号判玩家聊天**。
 * - **玩家对话**：去掉前缀标签后是「说话人 + `:` + 正文」，例如 `[ H a r d c o r e ] LuoXuan: ( ͡° ͜ʖ ͡°)`
 *   （`*DEAD*` / `(CT)` / `(T)` 之类的队伍前缀也算说话人前缀）。
 *
 * 判定**有先后**（顺序即优先级，理由见上）：进服 → 过关 → 服务器公告 → 玩家对话 → 兜底算公告。
 * 兜底给「服务器公告」而不是「玩家对话」：说不出说话人的一律是服务端打印（`svc_Print` 等）。
 */

/** 消息类别。看板的过滤多选框与过关跳转都按它分流。 */
export type ChatKind = 'chat' | 'join' | 'announce' | 'record';

/** 固定顺序（UI 按这个顺序摆多选框，测试也按它断言）。 */
export const CHAT_KINDS: readonly ChatKind[] = ['chat', 'join', 'announce', 'record'];

/** 多选框上的短标签。 */
export const CHAT_KIND_LABEL: Record<ChatKind, string> = {
  chat: '玩家对话',
  join: '进服公告',
  announce: '服务器公告',
  record: '过关记录',
};

/** 悬停说明（写清判据，免得用户以为分类是随意的）。 */
export const CHAT_KIND_HINT: Record<ChatKind, string> = {
  chat: '玩家自己打的字：去掉前缀标签后是「说话人: 正文」',
  join: '连接 / 断开的播报：▲ 进服、▼ 掉线（含 connected from / has joined / 已断开 等写法）',
  announce: '服务器播报：「[ 标签 ] - 正文」形状，以及说不出说话人的服务端打印',
  record: '过关记录：「… 以用时 18.714 完成了 [ 奖励关4 ]。 排名: 1/1」—— 可点击跳到这一跑',
};

/** 一条过关记录解析出来的东西。 */
export interface ChatRecord {
  /** 过的人（`以用时` 前面那个词）。 */
  player: string;
  /** 关卡名（`[ … ]` 里的内容；取不到给空串）。 */
  level: string;
  /** 这一跑的用时（秒）。 */
  durationSec: number;
}

/** 顶部标签（`[ Timer ]` / `<SM>` / `[ H a r d c o r e ]` 之类）——分类前先剥掉的一层壳。 */
const RE_LEAD_TAG = /^\s*[[<][^\]>]{1,32}[\]>]\s*/;

/** 进服 / 掉线的起头符号（SourceMod 的连接播报用这两个箭头）。 */
const RE_JOIN_ARROW = /^\s*[▲▼●○]/;

/** 进服 / 掉线的正文关键词（中英两套）。 */
const RE_JOIN_WORDS =
  /(has joined|connected from|disconnected|joined the game|left the game|已连接|已断开|加入了?游戏|加入服务器|离开服务器|进入服务器|退出服务器)/i;

/**
 * 过关记录：中英各一套「用时 + 完成」。
 *
 * **语料来源分两档**（写清楚，免得后人以为全是实测）：
 * - **实测档**：`以用时 18.714 完成了 [ 奖励关4 ]`（本仓夹具 4 条）—— 下面第一条 CN 规则；
 * - **泛化档**（**尚无真实语料核对**，只是同一族计时器插件的常见写法）：`用时 18.714 完成…`、
 *   `完成 [ 关卡 ] 用时 18.714`、英文的 `finished|completed|cleared … in|with a time of|time: 12.345`。
 *   它们都还要过 `RE_RECORD_*_DONE` 或 `RE_RECORD_EXTRA` 这两道闸（见 `parseChatRecord`），
 *   所以即便泛化档命中的是别的行，也只会落到「有完成字样 / 有排名读数」的那类播报上。
 *   等 owner 的更多 `.dem` 到位后，按真实写法收窄或补全。
 */
const RE_RECORD_CN = /(?:以)?用时\s*([0-9]+(?::[0-9]+)?(?:\.[0-9]+)?)/;
const RE_RECORD_CN2 = /([0-9]+(?::[0-9]+)?(?:\.[0-9]+)?)\s*(?:秒|s)\s*(?:内)?\s*(?:完成|通关)/;
const RE_RECORD_CN_DONE = /(完成了|完成|通关了|通关|过关了)/;
const RE_RECORD_EN =
  /(?:finished|completed|cleared|beat)\b.{0,32}?(?:in|with(?:\s+a)?\s+time\s+of|time\s*[:：]?)\s*([0-9]+(?::[0-9]+)?(?:\.[0-9]+)?)/i;
const RE_RECORD_EN_DONE = /(finished|completed|cleared|beat)/i;
/** `(SR: +0.045 | PB: +0.045 )` / `排名: 1/1` —— 过关记录特有的追加读数（兜底判据）。 */
const RE_RECORD_EXTRA = /(\(\s*SR\s*:|排名\s*:|P?B\s*:\s*[+-])/;

/** 广播形状：「[ 标签 ] - 正文」（标签后紧跟一个短横）。 */
const RE_ANNOUNCE_SHAPE = /^\s*[[<][^\]>]{1,32}[\]>]\s*[-–—]\s*/;

/**
 * 把「用时」写法化成秒：支持 `18.714`、`1:23.456`（分:秒.毫秒）、`83`。
 * 解析不出（负数 / 非数）返回 `null`。
 */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const parts = t.split(':');
  if (parts.length > 2) return null;
  let total = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0) return null;
    total = total * 60 + v;
  }
  return total;
}

/** 关卡名：取最后一个不像是「标签」的 `[ … ]`（`[ Timer ]` 那种纯字母标签跳过）。 */
function levelFrom(body: string): string {
  const groups = [...body.matchAll(/[[［]\s*([^\]］]{1,24}?)\s*[\]］]/g)].map((m) => m[1]);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.length === 0) continue;
    if (/^[\x20-\x7e]+$/.test(g)) continue; // `Timer` / `SM` / `SR: +0.0` 这类纯 ASCII 标签不是关卡名
    return g;
  }
  return '';
}

/**
 * 剥掉「`[ 标签 ]`」与紧随的分隔短横 —— 公告与过关记录都带这层壳。
 *
 * 为什么必须先剥：`[ Timer ] - LuoXuan 在 Segmented模式 下以用时 18.714 …` 里，
 * 取名字时若把 `[ Timer ]` 留在句首，句首取词会取到 `[`（本轮实测踩过）。
 */
export function stripLeadTag(text: string): string {
  return text.replace(RE_LEAD_TAG, '').replace(/^\s*[-–—]\s*/, '');
}

/** 说话人：剥壳后取「`用时` 之前紧邻的那个人名」（中英两套句式共用）。 */
function playerFrom(body: string, durationText: string): string {
  const cn = body.match(/^\s*([^\s，,。]{1,32})\s+在\s/);
  if (cn) return cn[1];
  const en = body.match(/^\s*([^\s，,。]{1,32})\s+(?:finished|completed|cleared)/i);
  if (en) return en[1];
  // 兜底：`用时` 前面那一串里，从后往前找第一个不含「用时 / in / 下以」的词
  const at = body.indexOf(durationText);
  const head = (at > 0 ? body.slice(0, at) : body).trim();
  const toks = head.split(/\s+/).filter((t) => t.length > 0);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (/用时|^in$|^以$|^下$|^模式$/i.test(t)) continue;
    return t;
  }
  return '';
}

/**
 * 解析一条**过关记录**；不是过关记录返回 `null`。
 *
 * 判据（按顺序试）：中文「(以)用时 <秒>」→ 中文「<秒> 秒内完成」→ 英文
 * `finished|completed|cleared|beat … in|with a time of|time: <秒>`；
 * 另外还要求**有完成字样**或**过关记录特有的读数**（`排名:` / `(SR: … | PB: … )`）之一，
 * 这样「播报里恰好出现一个数字」不会被当成过关（见 `RE_RECORD_*_DONE` / `RE_RECORD_EXTRA`）。
 * 只要拿到时长就返回（`用时` 就是那一跑的时长，跳转要用它）。
 */
export function parseChatRecord(text: string): ChatRecord | null {
  let m = text.match(RE_RECORD_CN) ?? text.match(RE_RECORD_CN2);
  let done = RE_RECORD_CN_DONE.test(text);
  if (!m) {
    const en = text.match(RE_RECORD_EN);
    if (en) {
      m = en;
      done = true;
    }
  }
  if (!m) return null;
  const durationSec = parseDuration(m[1]);
  if (durationSec === null) return null;
  // 「用时 / 完成」字样本身已经足够（中文服的写法）；英文那支上面已置 done；除此之外还认追加读数
  if (!done && !RE_RECORD_EXTRA.test(text)) return null;
  const body = stripLeadTag(text);
  return { player: playerFrom(body, m[1]), level: levelFrom(body), durationSec };
}

/**
 * **判据名字**（哪一条规则命中的）。看板把每条消息 `data-rule` 与悬停提示写出来 ——
 * 这样「这条为什么算公告 / 为什么算过关」是可核对、可追责的，而不是黑箱；
 * 新录像里出现没见过的写法时，看板上的「兜底 N」读数会把它指出来（见 `countFallback`）。
 */
export type ChatRule =
  | 'join-arrow'
  | 'join-words'
  | 'record-cn'
  | 'record-en'
  | 'announce-shape'
  | 'chat-speaker'
  | 'fallback';

/** 判据的可读说明（悬停提示直接用）。 */
export const CHAT_RULE_HINT: Record<ChatRule, string> = {
  'join-arrow': '▲ / ▼ 起头的连接播报',
  'join-words': '正文含 has joined / connected from / disconnected / 已断开 等连接用语',
  'record-cn': '中文计时器：「以用时 <秒> 完成了 [ 关卡 ]」或 <秒> + 完成 的近似写法',
  'record-en': '英文计时器：finished / completed / cleared … in|with a time of <秒>',
  'announce-shape': '服务器播报形状：「[ 标签 ] - 正文」',
  'chat-speaker': '玩家对话：剥掉前缀标签后是「说话人: 正文」',
  fallback: '没命中任何具体规则 ⇒ 按服务端打印归到「服务器公告」（新录像里这类行值得补判据）',
};

/** 分类结果 + 命中的判据（`classifyChat` 是它的薄封装）。 */
export function classifyChatDetailed(text: string): { kind: ChatKind; rule: ChatRule } {
  if (RE_JOIN_ARROW.test(text)) return { kind: 'join', rule: 'join-arrow' };
  if (RE_JOIN_WORDS.test(text)) return { kind: 'join', rule: 'join-words' };
  if (parseChatRecord(text)) return { kind: 'record', rule: RE_RECORD_CN.test(text) ? 'record-cn' : 'record-en' };
  if (RE_ANNOUNCE_SHAPE.test(text)) return { kind: 'announce', rule: 'announce-shape' };
  // 玩家对话：剥掉前缀标签后是「说话人: 正文」；说话人里允许 `*DEAD*` / `(CT)` / `<Owner>` 之类的装饰
  const body = stripLeadTag(text);
  if (/^\s*(?:\*?[A-Za-z ]{0,12}\*?\s*)?(?:\([^)]{1,8}\)\s*)?[^:：<>[\]]{1,32}\s*[:：]\s*\S/.test(body)) {
    return { kind: 'chat', rule: 'chat-speaker' };
  }
  return { kind: 'announce', rule: 'fallback' };
}

/**
 * 判一条消息属于哪一类（**顺序即优先级**，见文件头说明）。
 *
 * 顺序不能换：`[ Timer ] - 地图剩余时间: 20 分钟。` 有冒号、`… 完成了 [ 奖励关4 ]。 排名: 1/1`
 * 既有冒号又有方括号 —— 先把进服与过关捞出来，剩下的才轮到「带标签的广播」和「说话人: 正文」。
 */
export function classifyChat(text: string): ChatKind {
  return classifyChatDetailed(text).kind;
}

/**
 * **走了兜底判据的条数**（既不是进服 / 过关，也不是「[ 标签 ] - 正文」形状，又看不出说话人）。
 *
 * 看板把非零的它显示成一个小标记：新录像（尤其别的服 / 别的语言）里一出现没见过的写法，
 * 这里就会涨 —— 拿那些行去补判据，比事后翻几十条消息快得多。
 */
export function countFallback(lines: readonly { text: string }[]): number {
  let n = 0;
  for (const l of lines) if (classifyChatDetailed(l.text).rule === 'fallback') n++;
  return n;
}

/**
 * 过关记录的**跳转时刻**（会话内秒）。
 *
 * 服务器是**跑完才播报**的（`tick` 落在他完成那一刻之后），所以「播报时刻 − 这一跑的用时」
 * 才是这一跑的开始；再往前让 `bufferSec`（缺省 5 秒）给播报延迟与起始判定留余量
 * —— owner 明确要求这个富余。结果夹到 `[0, 播报时刻]`（不能为负、也不该跑到播报之后）。
 */
export function recordJumpSeconds(announceSec: number, durationSec: number, bufferSec = 5): number {
  if (!Number.isFinite(announceSec) || announceSec <= 0) return 0;
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const buf = Number.isFinite(bufferSec) && bufferSec > 0 ? bufferSec : 0;
  return Math.max(0, Math.min(announceSec, announceSec - dur - buf));
}

/** 过滤：把**选中要隐藏**的类别去掉（`hidden` 里为真的类别不返回）。 */
export function filterChat<T extends { text: string }>(
  lines: readonly T[],
  hidden: Readonly<Partial<Record<ChatKind, boolean>>>,
): T[] {
  return lines.filter((l) => !hidden[classifyChat(l.text)]);
}

/** 每条类别各有几条（看板的过滤行用它显示「3/40」这类实时读数）。 */
export function countByKind(lines: readonly { text: string }[]): Record<ChatKind, number> {
  const out: Record<ChatKind, number> = { chat: 0, join: 0, announce: 0, record: 0 };
  for (const l of lines) out[classifyChat(l.text)]++;
  return out;
}
