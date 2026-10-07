/**
 * Source 录像（`.dem`）专用面板。
 *
 * 与「录像」页（`.replay` / Shavit 计时赛）**分开**：`.dem` 能给出的东西与 `.replay` 不同 ——
 * 前者有地图名、时长、tick 率、字符串表、类别基线、玩家名单（`player_info_s`），但**玩家逐帧位姿
 * 只在少数帧可见**（坐标主要靠增量下发，且本工程实体流尚未逐位对齐）；后者是定长采样、位姿完整。
 * 因此本面板的看板不是「轨迹列表 + 播放控制」，而是**时间线 + 玩家标注**：把每位玩家在上场时间轴
 * 上占的区间画出来，点选某位玩家即展开其全部已知信息。
 *
 * 数据来源：`parseSourceDemo()` 的 `DemoParseResult`（`playerInfos` 为按 `player_info_s` 布局解出的
 * 玩家信息，`players` 为采到的玩家类轨迹）。信息不足时**如实留白并注明原因**，不做猜测填充。
 *
 * 入口只收 Source `.dem`：`load` 先按内容复核（`apps/viewer/src/core/filekind.ts`），
 * 选到 `.replay` / `.bsp` 时经 `onForeignFile` 交回 `apps/viewer/src/app.ts` 的 `routeFile` 改送，
 * 本面板不解析任何非 `.dem` 文件。
 */

import { isPlayerClass, parseSourceDemo, type DemoParseResult, type DemoPlayerInfo, type PlayerTrack } from './demo/demo.js';
import {
  CHAT_KINDS,
  CHAT_KIND_HINT,
  CHAT_KIND_LABEL,
  CHAT_RULE_HINT,
  classifyChatDetailed,
  countByKind,
  countFallback,
  filterChat,
  parseChatRecord,
  recordJumpSeconds,
  type ChatKind,
} from './demo/chatkind.js';
import { userinfoTimeline } from './demo/net.js';
import { trackToClip } from './democlip.js';
import { TRACK_PALETTE } from './tracks.js';
import { FILE_KIND_LABEL, sniffFileKind } from '../core/filekind.js';
import type { Clip, RuleConfig } from './types.js';

/** 一位玩家在面板上的完整呈现数据：身份信息 + 其轨迹统计 + 在时间轴上的区间。 */
interface DemoPlayerRow {
  info: DemoPlayerInfo;
  /** 该玩家的轨迹（没有时为 null —— 实体流未对齐时采不到位姿）。 */
  track: PlayerTrack | null;
  /** 时间轴区间（秒），无轨迹时为 `null`。 */
  span: { from: number; to: number } | null;
  /** 轨迹汇总（帧数 / 跨度 / 队伍 / 生命 / 阵亡）；无轨迹时为 `null`。 */
  facts: TrackFacts | null;
}

/** 一个数值夹在区间内。 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把同一身份的多次在场并成**互不重叠的区间列表**（按起始升序）。
 *
 * 只并「相邻或重叠」的段：真断开的两段必须留着断口 —— 那正是「进过一次服、退出、又进来」在
 * 花名册与时间轴上唯一能被看见的形态（owner 实测 `LuoXuan` 就是这样）。合并时保留**先到的那段的
 * 实体号**（跳转要落到「此刻这一段」的那条轨迹上；同一段里实体号相同，取哪个都一样）。
 */
function mergeSpans(list: Array<{ from: number; to: number; entity: number }>): Array<{ from: number; to: number; entity: number }> {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number; entity: number }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // `>=` 而不是 `>`：相邻（上一段结束 = 下一段开始）也算连续，不画一条零宽断口
    if (last && s.from <= last.to) {
      last.to = Math.max(last.to, s.to);
      continue;
    }
    out.push({ from: s.from, to: s.to, entity: s.entity });
  }
  return out;
}

/** Source 队伍号 → 显示标签（CS:S：0 未分配、1 观察者、2 T、3 CT）。 */
function teamLabel(team: number | null | undefined): string {
  switch (team) {
    case 1:
      return '观察者';
    case 2:
      return 'T';
    case 3:
      return 'CT';
    case 0:
      return '未分配';
    default:
      return '—';
  }
}

/**
 * 一条轨迹的**运动 + 生命体征**汇总：全部取自采样里已有的字段，不做推算。
 *
 * - `distance` / `yawRange`：世界跨度与朝向跨幅（运动量，自动跟随挑人时也用它）；
 * - `teams`：录像里下发过的队伍号（`PlayerSample.team`，去重升序）——`.dem` 的
 *   `m_iTeamNum` 逐帧在发，但此前没有任何消费点；
 * - `hp`：生命值区间（`PlayerSample.health`）；
 * - `deaths`：**阵亡时刻**（秒，整场口径）。判据取两条的并集并去重：`lifeState` **进入**「已死(2)」
 *   （`0 = 存活 / 2 = 已死`；实测本仓夹具：#2/#3/#4/#7 全程 `200/0`，#5 在 tick 49132 落到 `2/2`、
 *   tick 50918 回到 `200/0` —— 方向写反就把复活记成阵亡），或 `health` 从 >0 落到 ≤0；
 *   两条不保证同一条下发，单独用都会漏（同一 tick 只记一次）。
 * - `deadFrames`：判为已死（`lifeState === 2` 或生命值 ≤0）的采样条数。
 */
interface TrackFacts {
  frames: number;
  distance: number;
  yawRange: number;
  teams: number[];
  hp: { min: number; max: number } | null;
  deaths: number[];
  deadFrames: number;
}

/**
 * @param tickInterval 秒/tick（= 头部 `playbackTime / playbackTicks`），用于把 tick 换算成秒。
 */
function trackFacts(track: PlayerTrack, tickInterval: number): TrackFacts | null {
  const s = track.samples;
  if (s.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let ylo = Infinity;
  let yhi = -Infinity;
  const teams = new Set<number>();
  let hpMin: number | null = null;
  let hpMax: number | null = null;
  let deadFrames = 0;
  const deaths: number[] = [];
  const deathTicks = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    for (let k = 0; k < 3; k++) {
      const v = p.pos[k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    if (p.yaw < ylo) ylo = p.yaw;
    if (p.yaw > yhi) yhi = p.yaw;
    if (p.team !== null) teams.add(p.team);
    if (p.health !== null) {
      hpMin = hpMin === null ? p.health : Math.min(hpMin, p.health);
      hpMax = hpMax === null ? p.health : Math.max(hpMax, p.health);
      if (p.health <= 0 || p.lifeState === 2) deadFrames++;
    }
    if (i > 0) {
      const prev = s[i - 1];
      const byLife = prev.lifeState !== 2 && p.lifeState !== null && p.lifeState === 2;
      const byHp = (prev.health === null || prev.health > 0) && p.health !== null && p.health <= 0;
      if ((byLife || byHp) && !deathTicks.has(p.tick)) {
        deathTicks.add(p.tick);
        deaths.push(p.tick * tickInterval);
      }
    }
  }
  let distance = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1].pos;
    const b = s[i].pos;
    distance += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return {
    frames: s.length,
    distance,
    yawRange: yhi - ylo,
    teams: [...teams].sort((a, b) => a - b),
    hp: hpMin === null || hpMax === null ? null : { min: hpMin, max: hpMax },
    deaths,
    deadFrames,
  };
}

/** 面板与 3D 场景的挂钩：选中一条有轨迹的对象时把它变成可播放的轨道并切到对应视角。 */
export interface DemoPanelOptions {
  /** 取当前规则（与「录像」页同一套，保证变换/配色一致）。 */
  rule?: () => RuleConfig;
  /** 收到轨道：外部负责 `addTrack` / 替换并切视角。返回是否成功。 */
  onClip?: (clip: Clip) => void;
  /**
   * 载入入口收到**不是 `.dem`** 的文件时把原文件转发出去（由 `apps/viewer/src/app.ts` 的
   * `routeFile` 按内容改送到对应页面）。未提供该回调时只在看板上写一条错误文案、不做解析。
   */
  onForeignFile?: (file: File) => void;
  /** 无法提供位姿时的提示出口。 */
  onNotice?: (text: string) => void;
  /**
   * 取当前播放位置的 **tick**（秒 × tick 率）。用于**名称轮换**：记录机器人共用同一人物、
   * 改名显示当前记录的关卡 ⇒ 名字是时变属性，必须按当前 tick 取，而不是取最后一张快照。
   */
  currentTick?: () => number;
  /** **.dem 载入成功**后调用：外部据此放出胶片进度条（不必等建出轨道）。 */
  onLoaded?: () => void;
  /**
   * **解析完成 / 清空**时把产物推给**录像信息条**（`apps/viewer/src/ui/demometa.ts` 的 `DemoMetaStrip`）。
   * 解析失败或换文件时传 `null`，条上不留上一份录像的旧事实。
   *
   * 为什么走回调而不是面板自己画：条子在**底部 dock**（会话容器的一层），面板的 DOM 在侧栏里；
   * 两者不同容器，由 `apps/viewer/src/app.ts` 接线 —— 与记录侧「`ReplayMetaPanel` 归会话、
   * 数据由 app 的 `sync` 推」是同一套分工。
   */
  onParsed?: (result: DemoParseResult | null, file: File, rosterCount: number) => void;
  /** **悬停花名册某一行**时回调该行的活跃区间（秒，**多段全给**）；移开传 null。时间轴据此在条上临时画区间。 */
  onHoverSpan?: (spans: Array<[number, number]> | null) => void;
  /**
   * **点了一个「过关记录」行** ⇒ 跳到那一跑（`toSec` = 会话内秒，已算好「播报时刻 − 用时 − 5 秒缓冲」）。
   *
   * `announceSec` 是这一行的会话内秒（= 播报时刻，区间带的右端）、`player` / `level` / `durationSec` 一并给出来，让 app 侧能顺手把视角切到过的那个人
   * （名字重复很少见，按名字认人足够；认不出来就只跳时间、不动视角）。
   */
  onRecordJump?: (toSec: number, announceSec: number, player: string, level: string, durationSec: number) => void;
  /**
   * **消息过滤（四个类别勾选框）变了** ⇒ 通知外部按新的可见集合重推一次消息。
   *
   * 浮层（`apps/viewer/src/ui/chatoverlay.ts`）吃的是同一份消息，过滤要一起生效：
   * 面板只负责算出「过滤后还剩哪些」并通报，谁消费谁自己取。
   */
  onChatFilter?: () => void;
  /**
   * **按人物切换 tick 点**（`entity` = 实体号，`on` = 是否显示）。
   *
   * tick 点原先是「录像」页与「录像」页**共用的一个全局开关**，在一边关掉另一边也跟着没，
   * 所以改为**每个人物一份设置**，入口放在本面板的详情里（owner 要求）。
   */
  onTickToggle?: (entity: number, on: boolean) => void;
  /**
   * **「与视角绑定的那个人」的显示名变了**时回调。`.dem` 的记录机器人会随关卡改名，而信息条
   * 显示的是跟随轨道的名字（建轨道那一刻定死）⇒ 外部据此改名并刷新信息条，否则名字会冻住。
   */
  onWhoName?: (entity: number, name: string) => void;
}

/** Source 把实体号 1..64 留给玩家槽位；更大的实体号是地图物件 / NPC，不是「人物视角」。 */
const MAX_PLAYER_ENTITY = 64;

/**
 * 花名册「算得上一条可用视角」的最小采样帧数。低于它的轨迹切过去看不出动作，不该当作可选视角。
 * 口径与 `presenceWindows` / `fastestAt` 一致（后者用 2，此处用 50）。
 */
const ROSTER_MIN_SAMPLES = 50;

/**
 * 文件大小的可读写法（看板右上角那一格）：小于 1 MB 用 KB，否则 MB（一位小数）。
 * 只服务于展示，不参与任何解析判断。
 */
function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 花名册行：一次在场（占用会话）或一条可用轨迹，二者合并后的呈现单位。 */export interface RosterRow {
  key: number;
  name: string;
  isBot: boolean;
  /**
   * 该行是不是**真账号**（依据：`userinfo` 更新流里出现过 **非空且不是 `BOT`** 的 guid）。
   *
   * 为什么不能拿 `!isBot` 当「真人」：录制机器人在观察者录像里**从不更新 `userinfo`**，它的行来自
   * 「可用轨迹」那一支、`isBot` 无从判定（实测取假），于是它会被自动跟随当成「第一位真人」并一路锁住 ——
   * 真人 `LuoXuan` 反而永远等不到视角（owner 实测「进度条滚到他第二次进来也没跟过去」的成因之一）。
   * 判据收窄成「见过真 guid」后：录制机器人不是真人，`LuoXuan` 是。
   */
  human: boolean;
  /**
   * 该行的**主实体号**：**点选跳转与轨迹配色**取它 —— 主实体 = 他**最早那一段**的实体，
   * 于是「点这个人」= 从头看他，不会被他采样最长的那一段拽到中途（owner 实测过那版的问题）。
   * 生命体征（`team` / `deaths`）另取**采样最长**的那段轨迹统计（数据更多，见 `roster`）。
   * 一行可对应多个实体（同一身份先后占过多个槽位，见 `entities` / `spans`）。
   */
  entity: number;
  /**
   * 该身份**占过的全部实体号**（升序，`entity` 必在其中）。
   *
   * 为什么会有多个：同一名真人可以先后占两个槽位（实测本仓夹具 `LuoXuan` 在槽 6 与槽 4 各出现一次），
   * 而花名册要回答的是「这段录像里有谁」——一个人一行。位姿是**按实体**存的，故跳转只能落到主实体，
   * 其余实体在详情里如实列出（`jumpTo` 只认实体号，不合并轨迹）。
   */
  entities: number[];
  /**
   * 该身份**逐次在场**的区间（tick，升序，相邻/重叠已并段）—— `entities` 是「占过哪些实体」，
   * 这里是「什么时候在、什么时候不在」。
   *
   * 为什么必须留着：身份合并（同一台机器人重连、同一名真人换槽）会把「中途退出又进来」抹成一段
   * 连贯在场 —— 于是花名册的区间条、时间轴上的人物叠加带都看不出那个缺口，自动跟随也会在
   * 他**第二段**进场时停在他的**第一段**实体上不动（owner 实测：要再点一次才切过去）。
   * 每段自带 `entity`：跳转要落到「此刻这一段」的那条轨迹上。
   */
  spans: Array<{ from: number; to: number; entity: number }>;
  from: number;
  to: number;
  moving: number;
  /**
   * 该行是否有可用位姿轨迹。
   *
   * 为什么必须区分：本工程实体流尚未逐位对齐，**多数玩家实体采不到位姿**（实测本仓夹具：整份
   * 录像只有 1 个实体出轨迹）。没有轨迹的人仍然要出现在花名册里 —— 花名册回答的是「这段录像里
   * 有谁」，而「能不能切过去看」是另一件事，由本字段如实分开标注。
   */
  hasTrack: boolean;
  /** 队伍标签（`PlayerSample.team` → `teamLabel`）；没轨迹 / 没下发过队伍时为 `'—'`。 */
  team: string;
  /** 该行区间内的阵亡次数（无轨迹时为 0）。 */
  deaths: number;
}

/**
 * 「在场窗口」：一条实体轨迹的 tick 覆盖范围 + 它的生命体征汇总（花名册的候选行）。
 * 由 `presenceWindows()` 计算并缓存在 `presenceCache` 里（载入后不变）。
 */
interface PresenceWindow {
  slot: number;
  name: string;
  isBot: boolean;
  from: number;
  to: number;
  moving: number;
  team: number | null;
  deaths: number;
}

/** 「占用会话」：一个槽位一次「进服 → 换人/退场」（由 `occupancySessions()` 计算并缓存）。 */
interface OccupancySession {
  slot: number;
  name: string;
  /** `player_info_s` 的 guid（`BOT` = 服务器机器人；解码失败为空串）。花名册按它判身份。 */
  guid: string;
  isBot: boolean;
  from: number;
  to: number;
}
export class DemoPanel {
  private readonly opts: DemoPanelOptions;
  /**
   * **当前录像轨道的真实配色**（由 `app.ts` 在建/换轨道后写入）。
   *
   * 为什么不能自己算：轨迹颜色是 `TrackList` 按**轨道下标**取模分配的，**与实体号无关** ——
   * 录像只占一条轨道，它的颜色是固定的；早先我按实体号另算一套色板，于是看板上的点
   * 与 3D 里那条轨迹**永远对不上**（owner 实测「还是乱的」）。这里改成**如实取那条轨道的色**。
   */
  private trackColor: number | null = null;
  /** 最近一次被"点选/跟随"的实体号（详情名牌与信息条都以它为准）。 */
  private lastPickedEntity: number | null = null;
  /** 最近一次向外部通报的名字（去重用）。 */
  private lastReportedName = '';

  /** 由 `app.ts` 在录像轨道建立/替换后调用，写入其真实配色并重渲染详情。 */
  setTrackColor(color: number): void {
    if (this.trackColor === color) return;
    this.trackColor = color;
    this.renderDetail();
  }

  /** **按人物**记住「tick 点已关闭」的实体号（默认全部显示 ⇒ 只记关闭的那些）。 */
  private readonly tickOff = new Set<number>();
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly meta: HTMLElement;
  private readonly track: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly note: HTMLElement;
  /** 对话区容器（录像内的文本消息）。 */
  private readonly chat: HTMLElement;
  /** 消息过滤的四个勾选框（`renderChat` 里顺带刷新每类的实时条数）。 */
  private readonly chatFilter: HTMLElement;
  /**
   * 四个类别里**被勾选要过滤掉**的那些（缺省全不勾 = 一条都不滤）。
   * 语义按 owner 的说法：「过滤掉…相关的」——**勾上 = 不显示这一类**。
   */
  private chatHidden: Record<ChatKind, boolean> = { chat: false, join: false, announce: false, record: false };
  private rows: DemoPlayerRow[] = [];
  private result: DemoParseResult | null = null;
  private duration = 0;
  /** 全程总 tick 数（进度条的刻度基准；currentTick 也按同一 tick 口径）。 */
  private totalTicks = 1;
  private selected = -1;
  /** 最近一次载入的文件：重复载入（例如换文件）时按它重来。 */
  private lastFile: File | null = null;
  /** 最近一次解析耗时（毫秒）—— 看板上如实报出来，用户据此判断这份录像「重不重」。 */
  private parseMs = 0;
  /**
   * 载入后**不变的**中间结果缓存（`load()` 起始处清空）。
   *
   * 为什么必须缓存：花名册由帧循环每帧经 `refreshRoster()` 重算，而 `presenceWindows()` 要为每个
   * 实体遍历其**全部采样**求包围盒（实测本仓夹具 373 条轨迹、最大的那条近 6 万采样）——
   * 不缓存就是每帧上千万次浮点运算，页面会肉眼可见地卡。
   */
  private presenceCache: PresenceWindow[] | null = null;
  /** 占用会话缓存（同上；`occupancySessions()` 的结果载入后不再变）。 */
  private sessionsCache: OccupancySession[] | null = null;
  /** 秒/tick（头部 `playbackTime / playbackTicks`）；`tickRate()` 是它的倒数。 */
  private tickInterval = 1 / 66;

  constructor(root: HTMLElement, opts: DemoPanelOptions = {}) {
    this.opts = opts;
    this.root = root;
    root.innerHTML = `
      <div class="sec sec-load">
        <div class="sec-title">载入与看板</div>
        <div class="sec-body">
          <div class="dmp-load">
            <label class="filebtn" for="demoFile">载入录像（.dem）</label>
            <input id="demoFile" type="file" accept=".dem" />
            <span class="dmp-drop">也可以直接把 .dem 拖进窗口</span>
          </div>
          <div class="dmp-meta" id="demoMeta"><div class="dmp-empty">尚未载入录像</div></div>
          <div class="dmp-note" id="demoNote"></div>
        </div>
      </div>
      <div class="sec sec-roster">
        <div class="sec-title">详情与花名册</div>
        <div class="sec-body">
          <div class="dmp-detail" id="demoDetail"></div>
          <!-- **花名册必须落在这个 sec 里**：它原先渲染进「载入与看板」的 dmp-timeline，
               于是本节标题写着"花名册"、内容却是空的（owner 实测）。 -->
          <div class="dmp-roster-list" id="demoRoster" hidden></div>
        </div>
      </div>
      <div class="sec sec-chat">
        <div class="sec-title">对话</div>
        <div class="sec-body">
          <!-- 消息过滤（owner 要求）：四个类别各一个复选框，**勾上 = 这一类过滤掉（不显示）**。
               类别判据在 apps/viewer/src/replay/demo/chatkind.ts（纯函数，按真实语料定的顺序：
               进服 → 过关 → 服务器公告 → 玩家对话 → 兜底算公告）。
               这一行同时是**实时读数**：每个框后面跟「已隐藏 / 共几条」。 -->
          <div class="dmp-chat-filter" id="demoChatFilter"></div>
          <!-- 录像内的文本消息（svc_Print / svc_StringCmd / svc_Disconnect，以及
               svc_UserMessage 的 SayText2——玩家聊天与 SourceMod 播报走它，
               由解析层按「控制字节边界 + UTF-8」解出可读文本）。
               **与时间轴绑定，但只做明暗**：已发生的行正常亮度、未发生的压暗（见 refreshChatState）；
               这一份是**完整留档**，不自动滚动、不设自己的滚动条 —— 「当前这一刻说了什么」贴在
               画面左下角的浮层上（ui/chatoverlay.ts，元素 #chatOverlay）。
               过关记录那几行会多一个「跳到这一跑」的按钮（见 renderChat）。
               本节类名 sec-chat 只作结构标记，布局不依赖它（面板仍是整列滚动）。
               注意：本段在模板字符串里，注释内一律不写反引号（否则会截断它）。 -->
          <div class="dmp-chat" id="demoChat"></div>
        </div>
      </div>`;
    this.input = root.querySelector<HTMLInputElement>('#demoFile')!;
    this.meta = root.querySelector<HTMLElement>('#demoMeta')!;
    this.track = root.querySelector<HTMLElement>('#demoRoster')!;
    this.detail = root.querySelector<HTMLElement>('#demoDetail')!;
    this.note = root.querySelector<HTMLElement>('#demoNote')!;
    this.chat = root.querySelector<HTMLElement>('#demoChat')!;
    this.chatFilter = root.querySelector<HTMLElement>('#demoChatFilter')!;
    this.buildChatFilter();
    // 注：**「运动优先（实验展平顺序）」开关已撤除**（owner：用不上了）。它当时只切换
    // `demo/tables.ts` 里的属性展平顺序实验分支（`SPROP_CHANGES_OFTEN` 排头还是排尾），
    // 默认路径本来就是「排头」，撤掉开关后该分支一并删除，属性展平只剩一条确定路径。
    // 参考解析器（tf2-demo-parser）输出 JSON：直接吃它的 `users` / `chat` —— 那是**已验证可用**的
    // Source 1 解码结果（我们的 .dem 实测出 12 个用户，含真人 `Mon3tr`）。本工程自己的解析尚未对齐，
    // 故先提供这条**能直接看到全部名单**的通道，同时保留 .dem 通道继续收敛。
    this.input.addEventListener('change', () => {
      const f = this.input.files?.[0];
      if (f) void this.load(f);
    });
  }

  /**
   * 载入并解析一份 `.dem`。
   *
   * **先按内容复核**（`sniffFileKind`，不看扩展名）：不是 `.dem` 就交给 `onForeignFile`
   * 转发（`.replay` 会被改送到记录页、`.bsp` 会被当地图加载），本面板不解析它；
   * 确认是 `.dem` 后才开始解析。解析失败时只显示错误文本，不清空既有内容以外的状态。
   */
  async load(file: File): Promise<void> {
    const kind = await sniffFileKind(file);
    if (kind !== 'demo') {
      if (this.opts.onForeignFile) {
        // 去向与文案都归 `routeFile`（本面板不替它决定是记录页还是地图）
        this.opts.onForeignFile(file);
        return;
      }
      this.meta.textContent =
        `${file.name} 不是 ${FILE_KIND_LABEL.demo}文件（识别为 ${FILE_KIND_LABEL[kind]}）——本页只收 .dem`;
      return;
    }
    this.lastFile = file;
    // 换文件即作废所有「载入后不变」的缓存（它们全是从上一份 `result` 里算出来的）
    this.presenceCache = null;
    this.sessionsCache = null;
    this.meta.textContent = `解析中…（${file.name}，${(file.size / 1048576).toFixed(1)} MB）`;
    this.detail.innerHTML = '';
    this.note.textContent = '';
    this.track.hidden = true;
    let result: DemoParseResult;
    const t0 = performance.now();
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // **口径 = `'playerPosed'`（玩家类 + 有世界坐标即可，朝向缺省记 0）**，不是 `'posed'`。
      // `'posed'` 会给**任何**有坐标的实体逐 tick 建采样 —— 一个 30 分钟的录像里那是 200 多条
      // 地图物件 / NPC 轨迹、上千万个采样点（实测 227 条 × 59,948 帧 ≈ 2 GB，浏览器 Worker 直接
      // 崩）。而本面板的消费面**只用玩家实体**（见 `presenceWindows` 的过滤：实体号 1..64 + 玩家类），
      // 那些轨迹建出来就被丢掉。取 `'playerPosed'` 后实体数降到个位数、内存回到几十 MB。
      // 不用 `'players'`：那一档要求每帧都有朝向，而 `m_angEyeAngles` 在真录像里极少下发（见
      // `samplePlayers` 的注释），会把整条玩家轨迹丢掉 —— `'playerPosed'` 正是 `importer.ts`
      // 在同样情形下的兜底档。
      result = parseSourceDemo(buf, { sampleMode: 'playerPosed' });
    } catch (e) {
      this.meta.textContent = `解析失败：${e instanceof Error ? e.message : String(e)}`;
      // 失败即清空信息条：留着上一份录像的服务器 / 事件数会被读成「这份文件就是这样」
      this.opts.onParsed?.(null, file, 0);
      return;
    }
    this.result = result;
    this.parseMs = performance.now() - t0;
    this.duration = Math.max(1e-3, result.header.playbackTime);
    this.totalTicks = Math.max(1, result.header.playbackTicks);
    // 秒/tick 由头部两个字段推出（头部不直接记 tick 率）；花名册与阵亡时刻都按它换算
    this.tickInterval = this.duration / this.totalTicks;
    this.buildRows();
    this.renderMeta(file);
    this.renderTimeline();
    this.renderDetail();
    this.renderChat();
    // **载入成功即通知外部**：底部那条胶片进度条要立刻放出来，而不是等用户点了某个玩家、
    // 建出第一条轨道之后才出现 —— 那时进度条才冒出来会显得"没加载成功"。
    // 同时把解析产物推给**录像信息条**（服务器 / 天空盒 / 协议 / 事件 / 实体流 / 字符串表）。
    this.opts.onParsed?.(result, file, this.roster(0).length);
    this.opts.onLoaded?.();
  }

  /** 把「玩家信息」与「玩家类轨迹」按实体号配成一行；轨迹缺失的行如实留空。 */
  /**
   * **按当前 tick 取该槽位的显示名**（名称轮换）。
   *
   * 记录机器人共用同一人物、把名字改成「当前记录的关卡 + 玩家名」⇒ 名字是**时变属性**；
   * 锚定用**槽位**（与真人还是脚本控制无关）。取「最后一个 `tick <= 当前 tick` 且含该槽位的快照」。
   */
  private nameAtSlot(slot: number, atTick?: number): string {
    const now = atTick ?? (this.opts.currentTick ? this.opts.currentTick() : Infinity);
    let best = '';
    for (const snap of userinfoTimeline) {
      if (snap.tick > now) break;
      for (const e of snap.entries) {
        if (e.idx !== slot) continue;
        let end = Math.min(32, e.value.length);
        for (let q = 0; q < end; q++) if (e.value[q] === 0) { end = q; break; }
        const nm = new TextDecoder('utf-8', { fatal: false }).decode(e.value.subarray(0, end));
        // **拒绝非法名**：录像末段有个别条目解码后是乱码（替换字符 / 控制字符）。取名的用途是显示，
        // 与其把乱码显示出来，不如**保留上一个合法名** —— 轮换的语义（"当前记录的是哪一关"）不受影响，
        // 因为乱码那条本身不携带可读信息。
        if (nm.length > 0 && !/[\uFFFD\u0000-\u001f]/.test(nm)) best = nm;
      }
    }
    return best;
  }

  /**
   * **按当前 tick 刷新「在服是谁」的抬头**（名称轮换，帧循环调用）。
   *
   * 记录机器人会沿用同一人物改名显示当前记录的关卡 ⇒ 名字是**时变属性**，必须按当前 tick 取。
   *
   * 进度条与人物区间**不在这里画**：它们统一打在底部时间轴的滑杆上（录像会话自己那条
   * `apps/viewer/src/replay/timeline.ts` 的 `Timeline`）。侧栏自画一条只会和时间轴打架，
   * 也正是「看板东西太多」的来源之一。
   */
  refreshNames(): void {
    // 「在服」行已挪进 demoMeta（owner：花名册不显示在线状态）⇒ 到 meta 里找它。
    // 看板那一行是「标签 + 名单 + 计数」三段（`dmp-live-tag` / `dmp-live` / `dmp-live-n`），
    // 名字列表会很长（本仓夹具最多 5 位、真服上更多）⇒ **名单允许换行**，
    // 计数单独一格，这样长名单不会把标签挤走、也不会把行高撑成一条歪的。
    const head = this.meta.querySelector<HTMLElement>('.dmp-live');
    const count = this.meta.querySelector<HTMLElement>('.dmp-live-n');
    if (!head || this.rows.length === 0) return;
    const now = this.opts.currentTick ? this.opts.currentTick() : 0;
    const live: string[] = [];
    for (const row of this.rows) {
      const nm = this.nameAtSlot(row.info.slot, now);
      if (nm.length > 0) live.push(nm);
    }
    const text = live.length > 0 ? live.join(' · ') : '—';
    if (head.textContent !== text) head.textContent = text;
    const badge = live.length > 0 ? `${live.length} 人` : '';
    if (count && count.textContent !== badge) count.textContent = badge;
  }

  private buildRows(): void {
    const r = this.result!;
    const byEntity = new Map<number, PlayerTrack>();
    for (const t of r.players) byEntity.set(t.entityIndex, t);
    this.rows = r.playerInfos.map((info) => {
      const track = byEntity.get(info.entityIndex) ?? null;
      const facts = track ? trackFacts(track, this.tickInterval) : null;
      let span: DemoPlayerRow['span'] = null;
      if (track && track.samples.length > 0) {
        span = {
          from: track.samples[0].tick * this.tickInterval,
          to: track.samples[track.samples.length - 1].tick * this.tickInterval,
        };
      }
      return { info, track, span, facts };
    });
    this.rows.sort((a, b) => a.info.slot - b.info.slot);
    this.selected = this.rows.length > 0 ? 0 : -1;
  }

  private renderMeta(file: File): void {
    const h = this.result!.header;
    const r = this.result!;
    const tickRate = h.playbackTicks > 0 ? h.playbackTicks / Math.max(1e-3, h.playbackTime) : 0;
    // **人数取花名册里的实体数**（不是签名表条目数）：签名表只给开局名单，中途加入的人
    // （实测真人 `LuoXuan` 就是中途加入）不在里面 ⇒ 用签名表会少报人头，与下面花名册对不上。
    const people = new Set(this.roster(0).map((r2) => r2.entity)).size;
    // **取舍（owner：把地方让给对话区）**：地图 / 服务器 / 时长 / 玩家数这些事实现在由
    // **底部那条录像信息条**（`apps/viewer/src/ui/demometa.ts` 写 `#demoInfo`）常驻展示，
    // 看板上再摆一遍就是重复占地方 ⇒ 压成**标题行里的一串摘要**（悬停仍是完整诊断），
    // 板上只留一行真正**逐帧在变**的「在服」+ 来源文件。
    // 协议号 / 字符串表 / 类别数 / 消息号计数等解析内部量一律只进悬停提示，需要排查时停一下鼠标。
    const summary =
      `${fmtSize(file.size)} · ${(h.playbackTime / 60).toFixed(1)} 分钟 · ${people} 位` +
      (h.serverName ? ` · ${h.serverName}` : '');
    const serverTip =
      `录像头 serverName${h.serverName ? ` = ${h.serverName}` : '（空）'}；客户端 ${h.clientName || '（空）'}；` +
      `游戏目录 ${h.gameDirectory || '（空）'}`;
    // 解析内部量：真录像的实体流对齐情况（`entityPayloadExact` / `entityUnknownClass` / `entityOverread`）
    // 与各类别实体数一并收进悬停提示 —— 这些字段此前只在自检脚本里被读过。
    const topClasses = Object.entries(r.classCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cls, n]) => `${cls}×${n}`)
      .join('、');
    const propSummary = Object.entries(r.playerPropNames)
      .map(([cls, names]) => `${cls}: ${names.length} 项`)
      .join('；');
    const internals =
      `解析内部量（排查用）：文件 ${file.name}；tick 率 ${tickRate.toFixed(1)}/s；` +
      `录像头 播放帧 ${h.playbackFrames} / signon ${h.signonLength} 字节；` +
      `录像协议 ${h.demoprotocol} ／ 网络协议 ${h.networkprotocol}；客户端 ${h.clientName || '（空）'}；` +
      `游戏目录 ${h.gameDirectory || '（空）'}；` +
      `字符串表 ${r.stringTables.length} 张（网络流 ${r.packetStringTables.length} 张）；` +
      `服务器类别 ${r.dataTables.classes.length} 个；解析结束仍在实体表 ${r.entityCount} 个` +
      (topClasses ? `（${topClasses}）` : '') +
      `；包 ${r.stats.packetsParsed}/${r.stats.packetsParsed + r.stats.packetsFailed} 解析成功；` +
      `实体消息 ${r.stats.entityMessages} 条 / 更新 ${r.stats.entityUpdates} 次；` +
      `载荷恰好用尽 ${r.stats.entityPayloadExact}、多读 ${r.stats.entityOverread}、类别未知 ${r.stats.entityUnknownClass}；` +
      `玩家类属性 ${propSummary || '（无）'}；属性位图极性 legacyPropOrder=${r.legacyPropOrder}`;
    this.meta.innerHTML = `
      <div class="dmp-board">
        <div class="dmp-title dmp-title-row" title="${this.esc(serverTip)}">
          <span class="dmp-file">${this.esc(file.name)}</span>
          <span class="dmp-sum">${this.esc(summary)}</span>
        </div>
        <dl class="dmp-facts">
          <div><dt>地图</dt><dd class="dmp-mono">${this.esc(h.mapName || '（缺）')}</dd></div>
          <div><dt>服务器</dt><dd title="${this.esc(h.serverName || '（录像头未记服务器名）')}">${this.esc(
            h.serverName || '（缺）',
          )}</dd></div>
          <div><dt>天空</dt><dd class="dmp-mono" title="svc_ServerInfo 的 skyName —— .dem 里只有这一处记录天空盒">${this.esc(
            this.result?.serverInfo?.skyName || '（未下发）',
          )}</dd></div>
          <div>
            <dt>时长</dt>
            <dd><span class="dmp-mono">${this.fmtClock(h.playbackTime)}</span><em class="dmp-sub2">${
              h.playbackTicks
            } tick · ${tickRate.toFixed(1)}/s</em></dd>
          </div>
          <div>
            <dt>人数</dt>
            <dd><span class="dmp-mono">${people} 位</span><em class="dmp-sub2">轨迹 ${r.players.length} 条 · 对话 ${
              r.chat.length
            } 条</em></dd>
          </div>
          <div>
            <dt>解析</dt>
            <dd>
              <span class="dmp-mono">包 ${r.stats.packetsParsed}/${r.stats.packetsParsed + r.stats.packetsFailed}</span>
              <em class="dmp-sub2" title="${this.esc(internals)}">实体 ${r.stats.entityMessages} 条 · ${(
                this.parseMs / 1000
              ).toFixed(1)} s</em>
            </dd>
          </div>
        </dl>
        <div class="dmp-live-row" title="当前 tick 在服务器上的人（名字随录像轮换，逐帧更新）">
          <span class="dmp-live-tag">在服</span>
          <span class="dmp-live">—</span>
          <span class="dmp-live-n"></span>
        </div>
      </div>`;
  }

  /**
   * **在场区间**：每条实体轨迹的 tick 覆盖范围 = 这个占用者「在场」的时间窗。
   *
   * 为什么不用 `userinfo` 表来判断在场：那张表是**累积**的，槽位一旦出现就不会消失，
   * 因此从它看不出「谁退服了」。轨迹是逐帧采样的，**采样停了就是人走了**——
   * 这是本仓库里唯一可测的在/离场依据。名字取窗口末端那一刻的名字（同一窗内改过名时以末端为准）。
   */
  private presenceWindows(): PresenceWindow[] {
    if (this.presenceCache) return this.presenceCache;
    const r = this.result;
    if (!r) return [];
    const out: PresenceWindow[] = [];
    for (const t of r.players) {
      // **只收录有有效视角的轨迹**：采样点太少的实体切过去也看不出动作，不该占一个圆。
      if (t.samples.length < 50) continue;
      // **只收录玩家实体**：`r.players` 里混着地图物件与 NPC（实测有 `CWorld #0`、`CBaseEntity #145`、
      // `CDynamicProp #148`、`CFuncRotating #149` 等），它们不是"人物视角"，列进花名册会让圆的数量
      // 与人对不上（owner 实测到的"数量对不上"）。判据：实体号 ≤ 64 —— Source 把 1..MAX_PLAYERS(64)
      // 留给玩家槽位。
      // **实体号 0 必须排除**：Source 的 0 号实体是 worldspawn（世界本身），
      // 旧判据只挡 `> 64`，于是 `CWorld #0` 混进了花名册（owner 实测）。
      // 另用 `isPlayerClass` 挡掉道具 / NPC（`CBaseEntity` / `CDynamicProp` / `CFuncRotating` …）——
      // 原注释里写了这条，但代码里并没有真的判类名。
      if (t.entityIndex < 1 || t.entityIndex > MAX_PLAYER_ENTITY) continue;
      if (!isPlayerClass(t.className)) continue;
      const slot = t.entityIndex - 1;
      // **不再要求该槽在 `userinfo` 里有名字**：原先这里有一条 `nameAtSlot(...) === '' ⇒ continue`，
      // 而实测这些录像的 `userinfo` **只有槽 0（录制机器人）**（见 `documents/viewer/implementation/dem.md`
      // 「已知缺口（状态见 TODO.md）」第 4 条）⇒ 真人全被滤掉、槽 0 那位又常无位姿轨迹 ⇒ **花名册整个为空** ⇒ 自动跟随选不出人
      // ⇒ 信息条与详情名牌永远停在第一个人身上（owner 报的「滚动名称被锁死」）。
      // 名字本来就不必是判据：下面一行就有兜底（`|| className #实体号`）。
      const from = t.samples[0].tick;
      const to = t.samples[t.samples.length - 1].tick;
      const name = this.nameFor(slot, t.entityIndex, to);
      const guidIsBot = r.playerInfos.find((p) => p.slot === slot)?.isBot ?? true;
      // **运动量**（世界包围盒对角线）：给自动跟随当判据用。
      //
      // 为什么需要它：录制机器人自己也是一个**合法占用者** —— 实测实体 #1 就是
      // `ERDY-SURF Recorder`，它有名字、有 `playerInfo`、有一条覆盖全场的轨道，
      // 但它**是观察者、全程挂机不动**。自动跟随若选中它，速度读数恒为 `0｜0`、
      // 电平表与按键永远不亮（owner 实测）。而"按进场时间"或"按有无名字"都分不开它
      // 与真人（真人 `Mon3tr` 26:05 才进场，之前那段只能从机器人里挑）。
      // 唯一分得开的是**它到底动没动**：静物的包围盒是 0，冲浪的人动辄几千单位。
      let dx = 0;
      let dy = 0;
      let dz = 0;
      {
        const p0 = t.samples[0].pos;
        let minX = p0[0], minY = p0[1], minZ = p0[2];
        let maxX = minX, maxY = minY, maxZ = minZ;
        for (let i = 1; i < t.samples.length; i++) {
          const p = t.samples[i].pos;
          if (p[0] < minX) minX = p[0]; else if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; else if (p[1] > maxY) maxY = p[1];
          if (p[2] < minZ) minZ = p[2]; else if (p[2] > maxZ) maxZ = p[2];
        }
        dx = maxX - minX; dy = maxY - minY; dz = maxZ - minZ;
      }
      const moving = Math.round(Math.hypot(dx, dy, dz));
      // **生命体征摘要**（队伍 / 阵亡）：`trackFacts` 是唯一一处读 `PlayerSample.team` 与
      // `PlayerSample.health` / `lifeState` 的地方，花名册与详情都从这里取，口径只有一份。
      const facts = trackFacts(t, this.tickInterval);
      out.push({
        slot,
        name,
        isBot: guidIsBot,
        from,
        to,
        moving,
        team: facts && facts.teams.length > 0 ? facts.teams[0] : null,
        deaths: facts ? facts.deaths.length : 0,
      });
    }
    this.presenceCache = out;
    return out;
  }

  /**
   * 时间线：横轴 = 录像时长；每位**在场过的人**一行。
   *
   * 行来源见 `roster()`（占用会话 ∪ 可用轨迹）。两种行的呈现差别只有一处、且**如实标注**：
   * 无位姿的行在时间读数后带「· 无位姿」，点它由 `jumpTo` 说明原因 —— 不隐藏、也不假装。
   */
  private renderTimeline(): void {
    // **花名册回到右侧看板**（owner 定稿）：条上只留「当前视角人物的活跃区间」与「悬停高亮」，
    // 这里把**所有活跃过的人**（占用事件粒度，含中途加入的记录机器人）列成纵向列表。
    // - 每行一根按整场时长换算的**活跃条**；
    // - **当前时刻还在线** ⇒ 高亮；**已离线 / 还没加入** ⇒ 半透明；
    // - **鼠标悬停某行** ⇒ 回调 `onHoverSpan`，由时间轴把该行区间画到进度条上；移开清除。
    const roster = this.roster(0);
    if (roster.length === 0) {
      this.track.innerHTML = '<div class="dmp-empty">这条录像里没有可解出的人物。</div>';
      this.track.hidden = false;
      return;
    }
    const total = Math.max(1, this.totalTicks);
    const rows = roster
      .map((p, i) => {
        const tip = p.hasTrack
          ? '点击切到他的视角'
          : '该玩家的位姿尚未被本工程实体流采到（该层未逐位对齐）——点它会说明原因，不会切视角';
        // 无位姿的行：区间条改**弱色**（内联，避免为这一个状态新增 CSS 规则）、时间读数后带「· 无位姿」。
        // 别用 `opacity` 内联压暗整行——`refreshRosterState` 每帧用它切换 `.off`（在线/离线），内联会盖掉它。
        const barFill = p.hasTrack ? '' : ';background:var(--muted)';
        // **区间条按 `spans` 逐段画**（此前一行只画一根条）：同一身份中途退出又进来时，断口在这里可见。
        const bars = p.spans
          .map((s) => {
            const left = clamp((s.from / total) * 100, 0, 100);
            const right = clamp((s.to / total) * 100, 0, 100);
            const w = Math.max(0.4, right - left);
            return '<i style="left:' + left.toFixed(3) + '%;width:' + w.toFixed(3) + '%' + barFill + '"></i>';
          })
          .join('');
        // 队伍与阵亡来自 `PlayerSample.team` / `health` / `lifeState`（`trackFacts` 汇总）：
        // 队伍做成一枚小标签贴在名字后，阵亡数接在时间读数后 —— 都不占新格子，长名仍然省略号收尾。
        const team = p.team !== '—' ? '<i class="dmp-who-team">' + this.esc(p.team) + '</i>' : '';
        const deaths = p.deaths > 0 ? ' · 阵亡 ' + p.deaths : '';
        // 时间读数：多段时先报段数（读数格窄，逐段列全会被省略号吃掉），逐段时刻进悬停提示。
        const seg = p.spans.length > 1 ? p.spans.length + ' 段 ' : '';
        const segDetail =
          p.spans.length > 1
            ? '；在场分 ' +
              p.spans.length +
              ' 段：' +
              p.spans.map((s) => this.fmtClock(this.secAt(s.from)) + '–' + this.fmtClock(this.secAt(s.to))).join('、') +
              '（中途退出过）'
            : '';
        return (
          '<button class="dmp-who' + (p.hasTrack ? '' : ' dmp-who-notrack') + '" type="button" data-who="' + i + '" title="' + this.esc(tip + segDetail) + '">' +
          '<span class="dmp-whoname">' + this.esc(p.name) + team + '</span>' +
          '<span class="dmp-whobar">' + bars + '</span>' +
          '<span class="dmp-whotime">' + seg + this.fmtClock(this.secAt(p.from)) + '–' + this.fmtClock(this.secAt(p.to)) + (p.hasTrack ? deaths : ' · 无位姿') + '</span>' +
          '</button>'
        );
      })
      .join('');
    // 抬头（`.dmp-live`）保留：`refreshNames()` 每帧往这里写在服名单 + 轮换后的名字。
    // **「在服」抬头已撤**（owner：不该显示在这里）——在线状态挪到 demoMeta 的 `#dmp-live` 显示。
    this.track.innerHTML = '<div class="dmp-roster">' + rows + '</div>';
    this.track.hidden = false;
    for (const btn of Array.from(this.track.querySelectorAll<HTMLButtonElement>('.dmp-who'))) {
      const p = roster[Number(btn.dataset.who)];
      if (!p) continue;
      // 悬停高亮**该行的全部区间**（多段时一次全亮，断口也能看见），不再只给一段。
      const spans: Array<[number, number]> = p.spans.map((s) => [this.secAt(s.from), this.secAt(s.to)] as [number, number]);
      btn.addEventListener('mouseenter', () => this.opts.onHoverSpan?.(spans));
      btn.addEventListener('mouseleave', () => this.opts.onHoverSpan?.(null));
      btn.addEventListener('click', () => this.jumpTo(p.entity));
    }
    this.refreshRosterState();
  }

  /**
   * 取某实体所属的**花名册行**（同一身份可占过多个实体，故 `entity` 与 `entities` 都要查）；没有则 `null`。
   *
   * 供 `apps/viewer/src/app.ts` 在「跟随某人」时取他的**全部在场区间**（画人物叠加带用）——
   * 一个人中途退出又进来时，条上必须是分开的几段。
   */
  rosterFor(entity: number): RosterRow | null {
    return this.roster(0).find((p) => p.entity === entity || p.entities.includes(entity)) ?? null;
  }

  /** tick → 秒（整场口径，与 `secAt` 同一换算）；供外部换算花名册区间。 */
  secondsAt(tick: number): number {
    return this.secAt(tick);
  }

  /**
   * **该身份此刻在不在场**，在场返回**此刻那一段**（含该段对应的实体号），不在场返回 `null`。
   *
   * 自动跟随的判据：只看「行的进场时刻」会在「中途退出又进来」的人身上失灵 —— 他的行从第一段
   * 就开始了，于是第二段进场时视角仍停在第一段那条轨迹上（owner 实测：要再点一次才切过去）。
   * 逐段判断才能在他**第二段**进场时自动切过去；缺口期间返回 null，由调用方退回「跟当前最快的那位」。
   */
  spanAt(entity: number, tick: number): { from: number; to: number; entity: number } | null {
    const row = this.rosterFor(entity);
    if (!row) return null;
    return row.spans.find((s) => tick >= s.from && tick <= s.to) ?? null;
  }

  /** tick → 秒（整场时间轴口径）。 */
  private secAt(tick: number): number {
    return (tick / Math.max(1, this.totalTicks)) * this.duration;
  }

  /** 秒 → `m:ss`。 */
  private fmtClock(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /** 供帧循环调用：刷新看板每行的在线/离线态。 */
  /**
   * **按「当前时刻谁真的在动」挑一个人**，给自动跟随用。返回实体号，无人可选时 null。
   *
   * 为什么不能用静态属性（实测教训，三条判据都试过）：
   *   · 「按进场时刻」—— 记录机器人的四个槽位区间完全相同（都是 0:03–59:57），分不开；
   *   · 「按有无名字」—— 只能排除槽 0（它没有 `userinfo` 名字、显示为类名兜底），剩四个仍分不开；
   *   · 「按峰值速度」—— 四条轨道峰值都在 3585~4991，同样分不开。
   * 唯一随时间变化、且真正有意义的是**此刻的运动状态**：同一个记录机器人轮流占用不同槽位，
   * 某一时刻只有其中一个在跑。跟错槽位就会出现「速度读数恒 0、电平表与按键永不亮」。
   *
   * @param tick 当前播放头对应的 tick
   * @param preferNamed 为真时优先在「有真名」的候选里挑（排除类名兜底串）
   */
  fastestAt(tick: number, preferNamed: boolean): number | null {
    const r = this.result;
    if (!r) return null;
    const tickRate = this.tickRate();
    let bestEntity: number | null = null;
    let bestSpeed = -1;
    let bestNamedEntity: number | null = null;
    let bestNamedSpeed = -1;
    for (const t of r.players) {
      if (t.samples.length < 2) continue;
      if (t.entityIndex < 1 || t.entityIndex > MAX_PLAYER_ENTITY) continue;
      if (!isPlayerClass(t.className)) continue;
      // 当前时刻所在采样（二分定位）
      let lo = 0;
      let hi = t.samples.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t.samples[mid].tick <= tick) lo = mid;
        else hi = mid - 1;
      }
      if (lo < 1) continue;
      // **速度要跨「上一次位置真正变化」的采样算，不能只看相邻一条。**
      // `sampleMode: 'posed'` 下每个实体逐 tick 都有采样，但姿态只在少数帧更新，
      // 其余是原样重复（`Δpos = 0`）。按相邻帧差分会让**所有实体**都算出 ≈0 的速度，
      // 于是这个判据完全失去区分力、等于随机挑一个 —— 这正是「按速度挑人」上一轮无效的原因。
      let j = lo - 1;
      while (
        j > 0 &&
        t.samples[j].pos[0] === t.samples[lo].pos[0] &&
        t.samples[j].pos[1] === t.samples[lo].pos[1] &&
        t.samples[j].pos[2] === t.samples[lo].pos[2]
      ) {
        j--;
      }
      const a = t.samples[j];
      const b = t.samples[lo];
      const dt = (b.tick - a.tick) / tickRate;
      if (!(dt > 1e-6)) continue;
      const speed = Math.hypot((b.pos[0] - a.pos[0]) / dt, (b.pos[1] - a.pos[1]) / dt);
      if (speed > 6000) continue; // 瞬移样本不算「在动」
      const nm = this.nameAtSlot(t.entityIndex - 1, tick) || t.className + ' #' + t.entityIndex;
      const named = !/^[A-Za-z_]+ #\d+$/.test(nm);
      if (speed > bestSpeed) {
        bestSpeed = speed;
        bestEntity = t.entityIndex;
      }
      if (named && speed > bestNamedSpeed) {
        bestNamedSpeed = speed;
        bestNamedEntity = t.entityIndex;
      }
    }
    if (preferNamed && bestNamedEntity !== null) return bestNamedEntity;
    return bestEntity;
  }

  /**
   * 建**消息过滤**那一行：四个类别各一个复选框（**勾上 = 这一类过滤掉**），后面跟该类共几条。
   *
   * 为什么把「几条」摆在框里：分类是有判据的（见 `apps/viewer/src/replay/demo/chatkind.ts`），
   * 摆出条数用户一眼就能核对自己想滤掉的是不是真的被认成了那一类；勾上后标签加删除线（`.off`）。
   * 末尾另有一个**兜底读数**（`.dmp-cf-fb`，只在非零时显示）：它是「没命中任何具体规则、
   * 按服务端打印归到公告」的条数 —— 新录像里出现没见过的写法时它会涨，拿那些行去补判据最快。
   */
  private buildChatFilter(): void {
    this.chatFilter.innerHTML =
      '<span class="dmp-cf-title" title="勾上 = 这一类不显示（四个类别都按 apps/viewer/src/replay/demo/chatkind.ts 的判据分类）">过滤</span>' +
      CHAT_KINDS.map(
        (k) =>
          '<label class="dmp-cf" data-kind="' +
          k +
          '" title="' +
          this.esc(CHAT_KIND_HINT[k]) +
          '"><input type="checkbox" data-kind="' +
          k +
          '" /><span class="dmp-cf-name">' +
          this.esc(CHAT_KIND_LABEL[k]) +
          '</span><span class="dmp-cf-n" data-n="' +
          k +
          '"></span></label>',
      ).join('') +
      '<span class="dmp-cf-fb" data-fb hidden></span>';
    for (const box of Array.from(this.chatFilter.querySelectorAll<HTMLInputElement>('input[data-kind]'))) {
      box.addEventListener('change', () => {
        const k = box.dataset.kind as ChatKind;
        this.chatHidden[k] = box.checked;
        this.renderChat(); // 重画列表时一并刷新每类条数与删除线
        this.opts.onChatFilter?.(); // 浮层吃同一份消息，过滤要一起生效
      });
    }
  }

  /**
   * 过滤后的消息（浮层与「当前这一刻说了什么」都用这一份）；`tick` 原样保留，口径不变。
   */
  filteredChat(): ReadonlyArray<{ tick: number; text: string }> {
    return filterChat(this.result?.chat ?? [], this.chatHidden);
  }

  /**
   * 渲染**对话区**：录像内的文本消息，来源两条——`svc_Print` / `svc_StringCmd` /
   * `svc_Disconnect`，以及 `svc_UserMessage` 的 **SayText2**（CS:S 用户消息号 4，玩家聊天与
   * SourceMod 的连接/掉线/计时播报走它）。两者都由 `apps/viewer/src/replay/demo/demo.ts`
   * 收进 `chat`（**每条带 tick**，上限 4000 条）。
   *
   * **与时间轴绑定，但只做明暗**（owner 复核后定稿）：每行带 `data-at`（会话内秒数）与时间前缀；
   * 帧循环按当前播放头给**已发生的行**加 `.dmp-chat-on`（正常亮度）、**未发生的行**压暗
   * （见 `refreshChatState`）。这一份是**完整留档**，**不自动滚动、不设自己的滚动条** ——
   * 「当前这一刻说了什么」由画面左下角的浮层负责（`apps/viewer/src/ui/chatoverlay.ts`）。
   *
   * **本轮新增两件事**：① 按 `chatkind.ts` 的分类过滤（勾上的类别不渲染）；
   * ② **过关记录那几行多一个「跳到这一跑」按钮** —— 服务器是跑完才播报的，所以目标时刻 =
   * 播报时刻 − 这一跑用时 − 5 秒缓冲（`recordJumpSeconds`），点击经 `onRecordJump` 交 app 去 seek。
   */
  private renderChat(): void {
    const r = this.result;
    const msgs = r?.chat ?? [];
    // 每类的条数（读数与删除线）：即使一条都没渲染也要刷新，否则过滤行会一直显示上一份录像的数
    const counts = countByKind(msgs);
    for (const k of CHAT_KINDS) {
      const n = this.chatFilter.querySelector<HTMLElement>('[data-n="' + k + '"]');
      if (n) n.textContent = counts[k] > 0 ? '×' + counts[k] : '';
      this.chatFilter
        .querySelector<HTMLElement>('label[data-kind="' + k + '"]')
        ?.classList.toggle('off', this.chatHidden[k]);
    }
    // 兜底读数：没命中任何具体规则、被归到「服务器公告」的条数（非零才显示）——
    // 新录像里出现没见过的写法时它会涨，悬停能读到「拿这些行去补判据」的提示。
    const fbEl = this.chatFilter.querySelector<HTMLElement>('[data-fb]');
    if (fbEl) {
      const fb = countFallback(msgs);
      fbEl.hidden = fb === 0;
      fbEl.textContent = fb > 0 ? `兜底 ${fb}` : '';
      fbEl.title =
        fb > 0
          ? `${fb} 条消息没命中任何具体判据（既不是进服/过关，也不是「[ 标签 ] - 正文」形状，又看不出说话人），` +
            '按服务端打印归到了「服务器公告」。换新录像后这个数变大就说明有没见过的写法 —— 把这些行发我即可补判据。'
          : '';
    }
    if (msgs.length === 0) {
      this.chat.innerHTML =
        '<div class="dmp-chat-empty">本录像没有文本消息' +
        '<span class="dmp-chat-hint">（服务端打印与玩家聊天都为空，才是真的没人说话）</span></div>';
      return;
    }
    // 与看板其余部分同一套语彙：等宽小字、行间发丝线、不铺色块。
    // `data-at` 是**会话内秒数**（与时间轴同一口径）；正文原样转义，不解析颜色码。
    const rows: string[] = [];
    let shown = 0;
    for (const m of msgs) {
      const det = classifyChatDetailed(m.text);
      const kind = det.kind;
      if (this.chatHidden[kind]) continue;
      shown++;
      const sec = this.secAt(m.tick);
      const rec = kind === 'record' ? parseChatRecord(m.text) : null;
      let jump = '';
      if (rec) {
        const to = recordJumpSeconds(sec, rec.durationSec);
        jump =
          '<button type="button" class="dmp-chat-jump" data-jump="' +
          to.toFixed(3) +
          // 播报时刻（这一行的会话内秒）也挂到按钮上：点它时要拿它当**区间带的右端**，
          // 而 data-at 只在**行**上、按钮读不到（本轮实测：读成 0 ⇒ 区间被判成空、画不出来）。
          '" data-at="' +
          sec.toFixed(3) +
          '" data-player="' +
          this.esc(rec.player) +
          '" data-level="' +
          this.esc(rec.level) +
          '" data-dur="' +
          rec.durationSec +
          '" title="跳到这一跑：播报 ' +
          this.fmtClock(sec) +
          ' − 用时 ' +
          rec.durationSec.toFixed(3) +
          ' 秒 − 5 秒缓冲 = ' +
          this.fmtClock(to) +
          (rec.level ? '（' + this.esc(rec.level) + '）' : '') +
          '">↦ ' +
          this.fmtClock(to) +
          '</button>';
      }
      rows.push(
        '<div class="dmp-chat-line' +
          (rec ? ' dmp-chat-rec' : '') +
          '" data-at="' +
          sec.toFixed(3) +
          '" data-kind="' +
          kind +
          '" data-rule="' +
          det.rule +
          '" title="' +
          this.esc(CHAT_KIND_LABEL[kind] + '：' + CHAT_RULE_HINT[det.rule]) +
          '">' +
          '<span class="dmp-chat-t">' +
          this.fmtClock(sec) +
          '</span>' +
          '<span class="dmp-chat-x">' +
          this.esc(m.text) +
          '</span>' +
          jump +
          '</div>',
      );
    }
    this.chat.innerHTML =
      shown > 0
        ? rows.join('')
        : '<div class="dmp-chat-empty">四个类别都被过滤掉了' +
          '<span class="dmp-chat-hint">（把上面的勾去掉就能看到）</span></div>';
    for (const b of Array.from(this.chat.querySelectorAll<HTMLButtonElement>('.dmp-chat-jump'))) {
      b.addEventListener('click', () => {
        this.opts.onRecordJump?.(
          Number(b.dataset.jump ?? '0'),
          Number(b.dataset.at ?? '0'), // 播报时刻 = 这一行的会话内秒（区间带的右端）
          b.dataset.player ?? '',
          b.dataset.level ?? '',
          Number(b.dataset.dur ?? '0'),
        );
      });
    }
  }

  /**
   * **按播放头刷新对话区**（帧循环每帧调用，与花名册的在线态同一处）：已发生的行正常亮度
   * （`.dmp-chat-on`）、未发生的压暗。
   *
   * **这里只做明暗**（owner 复核后定稿）：不自动滚动、不设独立滚动条 —— 「当前这一刻说了什么」
   * 由画面左下角的浮层负责（`apps/viewer/src/ui/chatoverlay.ts`），侧栏这一份是**完整留档**，
   * 玩家想看哪一段自己滚整列即可，程序不跟用户抢滚动位置。
   */
  private refreshChatState(): void {
    const now = this.secAt(this.opts.currentTick ? this.opts.currentTick() : 0);
    const box = this.chat;
    if (!box.firstElementChild) return;
    for (const el2 of Array.from(box.children) as HTMLElement[]) {
      el2.classList.toggle('dmp-chat-on', Number(el2.dataset.at ?? '0') <= now);
    }
  }

  /**
   * **该实体的轨迹配色**：与「录像」页的轨迹点同一种分配口径（按序号取模），
   * 这样看板上的色点与 3D 视口里那条轨迹颜色一致，不用读文字就能对上号。
   * 用实体号做稳定键 —— 同一实体每次进来颜色不变。
   */
  private colorOf(entity: number): number {
    // **复用「录像」页那张色板**（`TRACK_PALETTE`），并同样按下标取模 —— 两边同源同算法，
    // 于是看板上的色点与 3D 里的轨迹线是**同一个颜色值**，不是"看着差不多"。
    return TRACK_PALETTE[(entity - 1) % TRACK_PALETTE.length];
  }

  /** 某个人物应有的轨迹配色（`app.ts` 据此写入轨道，保证 3D 与看板一致）。 */
  colorFor(entity: number): number {
    return this.colorOf(entity);
  }

  /**
   * 某个人物的 tick 点是否显示（app 在切到该人物时据此落到轨道上）。
   *
   * 判据是「有没有被这个人**自己**关掉」—— 该开关原先在详情面板里（逐实体的 `.dmp-opts`），
   * 已按 owner 要求移除（与时间轴 `.tl-opts` 的同名开关重复且互相打架）⇒ 现在恒为真：
   * 逐人默认都显示 tick 点，**总开关**归时间轴那一处。保留这个入口是为了让 app 侧的
   * 「切人时把该轨道恢复成默认显隐」这条语义不丢。
   */
  tickVisibleFor(entity: number): boolean {
    return !this.tickOff.has(entity);
  }

  refreshRoster(): void {
    this.refreshRosterState();
  }

  /**
   * 逐帧更新每行：**在线态**（当前 tick 落在该行区间内 ⇒ 不透明，否则半透明）
   * 与**显示名**。
   *
   * 名字必须在这里刷新：记录机器人沿用同一个人物、把名字改成「当前记录的关卡 + 玩家名」，
   * 所以名字是**时变属性**。早先名字是在 `renderTimeline()` 建行时按窗口终点 `p.to` 烘焙死的，
   * 而 `refreshNames()` 又只更新 `.dmp-live` 抬头（那个元素在改成花名册后已不存在，
   * 函数直接 return）—— 两处叠加的结果就是**名字再也不切换**（owner 实测）。
   *
   * **对话区的点亮 / 滚动也在这一处**（同一份「当前 tick」、同一帧率，不另开计时器）。
   */
  private refreshRosterState(): void {
    const tick = this.opts.currentTick ? this.opts.currentTick() : 0;
    this.refreshChatState();
    const roster = this.roster(0);
    for (const btn of Array.from(this.track.querySelectorAll<HTMLButtonElement>('.dmp-who'))) {
      const p = roster[Number(btn.dataset.who)];
      if (!p) continue;
      // **在线 = 任意一段覆盖当前 tick**（此前用并集 `from..to`，会把「中途退出的缺口」也算成在线）。
      const on = p.spans.some((s) => tick >= s.from && tick <= s.to);
      btn.classList.toggle('on', on);
      btn.classList.toggle('off', !on);
      // **名字按当前 tick 取**（`roster()` 里给的是窗口末端那一刻的名字，只作初值）。
      const nameEl = btn.querySelector<HTMLElement>('.dmp-whoname');
      if (nameEl) {
        const nm = this.nameAtSlot(p.entity - 1, tick) || p.name;
        if (nameEl.textContent !== nm) nameEl.textContent = nm;
      }
    }
    // **详情里的「人物名牌」也要跟着 tick 走**：它此前取建行时烘焙的 `row.info.name`，
    // 于是花名册在换名、详情却停在上一个名字（owner 实测「滚动名称没起效、被锁死」）。
    if (this.selected >= 0 && this.selected < this.rows.length) {
      const row = this.rows[this.selected];
      const nm = this.nameAtSlot(row.info.slot, tick) || row.info.name;
      const shown = this.detail.querySelector<HTMLElement>('.dmp-who-name');
      if (shown && nm.length > 0 && shown.textContent !== nm) shown.textContent = nm;
      // **跟随中那个人改了名 ⇒ 通知外部**（信息条据此改跟随轨道名；去重，避免每帧刷新）
      if (
        this.lastPickedEntity !== null &&
        row.info.entityIndex === this.lastPickedEntity &&
        nm.length > 0 &&
        nm !== this.lastReportedName
      ) {
        this.lastReportedName = nm;
        this.opts.onWhoName?.(row.info.entityIndex, nm);
      }
    }
  }

  /**
   * **供底部时间轴使用的占用标记**：每个「进服 / 换人」点一条，带那一刻的在场名单。
   *
   * 位置按**整条录像**的 tick 归一（`ratio = tick / 总 tick`）—— 录像片段在时间轴上就是整段窗口，
   * 故该比例与滑杆的 `0..1` 位置一一对应。
   */
  /**
   * **此刻在场的人**（供滑杆上的圆簇按播放头查询）。
   *
   * `ratio` = 主时钟在整条录像里的比例；乘总 tick 得到当前 tick，再取覆盖该 tick 的轨迹区间。
   * 名字按当前 tick 从名称时间线取 —— 记录机器人会沿用同一人物改名，名字是时变属性。
   */
  /** 录像总时长（秒），供播放器在还没有轨道时也能播放/暂停。 */
  totalSeconds(): number {
    return this.duration;
  }

  /**
   * **录像的真实 tick 率**（总 tick / 总秒数）。
   *
   * 录像页把「当前时间」换算成 tick 时必须用它 —— 早先在 `app.ts` 里把 tick 率写死成 100，
   * 而这份录像实际是 66.67，于是「当前 tick」跑得比真实快 1.5 倍：播到后半段 `currentTick`
   * 早已超过 `totalTicks`，花名册里**所有在线的人都被判成离线**（owner 实测）。
   */
  tickRate(): number {
    return this.duration > 0 ? Math.max(1, this.totalTicks) / this.duration : 1;
  }

  /** 全程总 tick，供时间轴把花名册的 tick 区间换算成时间标注。 */
  totalTickCount(): number {
    return Math.max(1, this.totalTicks);
  }

  /**
   * **花名册 = 占用身份 ∪ 可用轨迹**（**一个人一行**，不是「一次占用一行」、也不是「实体轨迹表」）。
   *
   * 数据两条来源，各补对方的缺口：
   *
   * ① **占用身份**（`userinfo` 更新流 → `occupancyIdentities`）：这是「这段录像里有谁」的**唯一真相**
   *    —— 签名表只给开局名单，中途加入的人只有在更新流里才看得见（实测本仓夹具：真人 `LuoXuan`
   *    就是中途加入，只出现在更新流里）。**按身份合并**，因为同一台机器人被复用做回放时会反复
   *    重连（实测 3 台各重连 3 次 = 9 条占用事件），同一个真人也曾先后占两个槽位。
   * ② **可用轨迹**（`presenceWindows`：有采样、玩家类、1..64 号）：有轨迹的行把区间换成
   *    **采样首末帧**——这与 `jumpTo` 抛出的 `clip.t[0]` 同口径，看板与点击后起点才对得上。
   *
   * 为什么要并集（两边的缺口各自实测过）：
   * - 只用轨迹（旧实现）：本工程实体流尚未逐位对齐，**整份录像只有 1 个实体出轨迹** ⇒ 花名册
   *   只剩 1 行，真人、回放机器人全部不见（owner 实测）。
   * - 只用占用会话：录制机器人只在**签名表**里、从不更新 `userinfo`，且在观察者录像里它常是
   *   唯一有位姿的那位 ⇒ 只用会话会把它整条漏掉。
   *
   * 每行带 `hasTrack`：没有位姿的人照常列出（如实标注「无位姿」），点它由 `jumpTo` 如实报缺，
   * **不假装切过去了**。
   */
  roster(ratio: number): RosterRow[] {
    void ratio;
    if (!this.result) return [];
    const rows: RosterRow[] = [];
    const wins = new Map(this.presenceWindows().map((p) => [p.slot + 1, p]));
    const covered = new Set<number>();
    // ── ① 占用身份（已按身份合并）──
    for (const g of this.occupancyIdentities()) {
      for (const e of g.entities) covered.add(e);
      // **逐次在场的区间列表**（合并身份会抹掉「退出又进来」这件事）：每次占用一条，
      // 有位姿就用该实体的采样窗口（与点击跳转同口径），没有就用占用事件本身的 tick 区间；
      // 相邻/重叠的再并成一段，免得同一段被画成两条。
      const spans = mergeSpans(
        g.sessions.map((s) => {
          const w = wins.get(s.entity);
          return { from: w ? w.from : s.from, to: w ? w.to : s.to, entity: s.entity };
        }),
      );
      // **主实体 = 他最早那一段的实体**：点花名册就是「从头看他」，`jumpTo` 也以它为跳转基准
      // （早先取「采样最长的那段」，于是 0 s 点 `LuoXuan` 会越过第一段、直接跳到第二段开头 —— owner 实测）。
      const entity = spans.length > 0 ? spans[0].entity : g.entities[0];
      const slot = entity - 1;
      // 生命体征（队伍 / 阵亡 / 运动）取**采样跨度最长**的那条轨迹：数据最多，
      // 而「他最早那段」往往只有几十秒、统计不出什么。
      const withWin = g.entities
        .map((e) => ({ e, win: wins.get(e) }))
        .filter((x): x is { e: number; win: PresenceWindow } => !!x.win)
        .sort((a, b) => b.win.to - b.win.from - (a.win.to - a.win.from));
      const factsWin = withWin[0] ?? null;
      // 区间（并集，供排序与读数用）：有位姿取**组内全部实体的采样窗口并集**，
      // 没有任何位姿才退回占用事件的并集（那时只有更新流能作证）。
      const from = withWin.length > 0 ? Math.min(...withWin.map((x) => x.win.from)) : g.from;
      const to = withWin.length > 0 ? Math.max(...withWin.map((x) => x.win.to)) : g.to;
      rows.push({
        key: rows.length,
        name: this.nameFor(slot, entity, to),
        isBot: g.isBot,
        human: g.human,
        entity,
        entities: g.entities,
        spans,
        from,
        to,
        moving: factsWin ? factsWin.win.moving : 0,
        hasTrack: withWin.length > 0,
        team: factsWin ? teamLabel(factsWin.win.team) : '—',
        deaths: factsWin ? factsWin.win.deaths : 0,
      });
    }
    // ── ② 有轨迹但更新流里没有的实体（录制机器人：只在签名表里、从不更新 userinfo）──
    for (const p of this.presenceWindows()) {
      const entity = p.slot + 1;
      if (covered.has(entity)) continue;
      rows.push({
        key: rows.length,
        name: this.nameFor(p.slot, entity, p.to),
        isBot: p.isBot,
        // 这一支来自「可用轨迹」而没有 `userinfo` 会话 ⇒ 无 guid 可判，**不当作真账号**
        human: false,
        entity,
        entities: [entity],
        spans: [{ from: p.from, to: p.to, entity }],
        from: p.from,
        to: p.to,
        moving: p.moving,
        hasTrack: true,
        team: teamLabel(p.team),
        deaths: p.deaths,
      });
    }
    return rows.sort((a, b) => a.from - b.from);
  }

  /**
   * **占用身份表**：把「占用会话」按**身份**合并 —— 花名册要回答的是「这段录像里有谁」。
   *
   * 合并键（判据取自 `player_info_s` 的两个字段，实测本仓夹具可区分）：
   * - **guid 不是 `BOT`** ⇒ 键 = guid：同一名真人跨槽位算一人（实测 `LuoXuan` 在槽 6 与槽 4 各出现
   *   一次、`guid` 同为 `[U:1:196340649]`，逐条事件成行时名单上会出现两个同名的他）；
   * - **guid 是 `BOT`** ⇒ 键 = 槽位：`BOT` 是**所有**机器人共用的 guid，无法据此区分具体哪一台；
   *   同一槽位上的多次重连按「同一台被复用」处理 —— 正是 owner 指出的场景（实测 3 台回放机器人
   *   各重连 3 次：每台的 `userId` 每次都变、名字不变、guid 恒为 `BOT`，逐条事件成行时
   *   11 条事件会摊成 11 行，而真实身份只有 3 台 + 1 名真人）。
   *
   * 返回的 `entities` 是该身份占过的全部实体号（升序）；`from` / `to` 是**占用事件**的并集
   * —— 有位姿时由 `roster` 换成采样窗口的并集（占用会话的 `to` 会一路记到片尾）。
   *
   * `sessions` 是**逐次在场的原始记录**（每次占用一条，带它自己的实体号与 tick 区间）：
   * 身份合并会抹掉「同一个人中途退出又进来」这件事，而这件事必须能被看见 ——
   * `roster` 用它算出该行的**区间列表** `spans`（owner 实测：`LuoXuan` 进过一次服、退出、又进来，
   * 而合并后的行显示成一段连贯的在场）。
   */
  private occupancyIdentities(): Array<{
    entities: number[];
    isBot: boolean;
    /** 该身份是不是**真账号**（`userinfo` 里 guid 非空且不是 `BOT`）。见 `RosterRow.human`。 */
    human: boolean;
    from: number;
    to: number;
    sessions: Array<{ entity: number; from: number; to: number }>;
  }> {
    const groups = new Map<
      string,
      {
        entities: Set<number>;
        isBot: boolean;
        human: boolean;
        from: number;
        to: number;
        sessions: Array<{ entity: number; from: number; to: number }>;
      }
    >();
    for (const s of this.occupancySessions()) {
      const human = s.guid.length > 0 && s.guid !== 'BOT';
      const key = human ? `g:${s.guid}` : `s:${s.slot}`;
      const one = { entity: s.slot + 1, from: s.from, to: s.to };
      const cur = groups.get(key);
      if (!cur) {
        groups.set(key, {
          entities: new Set([s.slot + 1]),
          isBot: s.isBot,
          human,
          from: s.from,
          to: s.to,
          sessions: [one],
        });
        continue;
      }
      cur.entities.add(s.slot + 1);
      cur.isBot = cur.isBot && s.isBot;
      cur.human = cur.human || human;
      cur.from = Math.min(cur.from, s.from);
      cur.to = Math.max(cur.to, s.to);
      cur.sessions.push(one);
    }
    return [...groups.values()].map((g) => ({
      entities: [...g.entities].sort((a, b) => a - b),
      isBot: g.isBot,
      human: g.human,
      from: g.from,
      to: g.to,
      sessions: g.sessions.sort((a, b) => a.from - b.from),
    }));
  }

  /**
   * **占用会话表**：某槽位一次「进服 → 换人/退场」= 一条。
   *
   * `from` = 该次占用的进服 tick；`to` = **该槽位的下一次占用事件**的 tick（= 这次占用结束），
   * 没有下一次的记到片尾。粒度是「占用事件」而不是「实体」——**一个实体可以先后被多个人占用**
   * （记录机器人换 uid 重连、回放机器人轮流上任），实测本仓夹具的 4 个槽位共发生十余次换人。
   */
  private occupancySessions(): OccupancySession[] {
    if (this.sessionsCache) return this.sessionsCache;
    const total = Math.max(1, this.totalTicks);
    const bySlot = new Map<number, Array<{ tick: number; name: string; guid: string; isBot: boolean }>>();
    for (const e of this.buildEvents()) {
      const list = bySlot.get(e.slot) ?? [];
      list.push({ tick: e.tick, name: e.name, guid: e.guid, isBot: e.isBot });
      bySlot.set(e.slot, list);
    }
    const out: OccupancySession[] = [];
    for (const [slot, evs] of bySlot) {
      evs.sort((a, b) => a.tick - b.tick);
      for (let i = 0; i < evs.length; i++) {
        out.push({
          slot,
          name: evs[i].name,
          guid: evs[i].guid,
          isBot: evs[i].isBot,
          from: evs[i].tick,
          to: i + 1 < evs.length ? evs[i + 1].tick : total,
        });
      }
    }
    this.sessionsCache = out;
    return out;
  }

  /**
   * **名字三级兜底**（顺序固定，判据都是「拿得到才用」）：
   *
   * 1. `userinfo` **更新流**里该槽位在 `atTick` 时的名字（时变名：记录机器人沿用同一人物改名）；
   * 2. `playerInfos`（**签名表**快照）里该槽位的名字 —— 更新流里没有的槽位只能靠它
   *    （实测槽 0 = 录制机器人 `ERDY-SURF Recorder` 从不更新，删掉这一级它就无名可显示）；
   * 3. 实体流里的类名 + 实体号（`CCSPlayer #3`）。
   *
   * 缺了第 2 级就会出现「有名单但一个名字都不显示」：本仓夹具的**唯一**一条可用轨迹恰好是
   * 槽 0 的录制机器人，而它不在更新流里 ⇒ 整份花名册只剩类名兜底串。
   */
  private nameFor(slot: number, entity: number, atTick: number): string {
    const live = this.nameAtSlot(slot, atTick);
    if (live.length > 0) return live;
    const signed = this.result?.playerInfos.find((p) => p.slot === slot)?.name;
    if (signed !== undefined && signed.length > 0) return signed;
    const cls = this.result?.players.find((t) => t.entityIndex === entity)?.className;
    return cls ? `${cls} #${entity}` : `#${entity}`;
  }

  occupancyMarks(): Array<{ ratio: number; items: Array<{ name: string; isBot: boolean; entity: number }> }> {
    const total = Math.max(1, this.totalTicks);
    const presence = this.presenceWindows();
    return this.buildEvents().map((e) => ({
      ratio: clamp(e.tick / total, 0, 1),
      items: presence
        .filter((p) => e.tick >= p.from && e.tick <= p.to)
        .map((p) => ({ name: p.name, isBot: p.isBot, entity: p.slot + 1 })),
    }));
  }

  /**
   * **占用事件**：从 `userinfoTimeline` 里按「槽位的 `userId` 发生变化」抽出进服 / 换人点。
   *
   * `userinfo` 的条目值是 `player_info_s`：名字在偏移 0（32 字节，NUL 终止）、`userID` 在 32
   * （i32 小端）、`guid` 在 36（33 字节）。同一个槽位 `userId` 变了就说明**换了一个占用者**
   * （真人进出、或记录机器人重连），这正是「谁什么时候进服/退服」可测的定义。
   * 解码出替换字符（U+FFFD）的条目是录像里个别未解对的记录，**跳过而不展示乱码**。
   */
  private buildEvents(): Array<{ tick: number; slot: number; name: string; userId: number; guid: string; isBot: boolean }> {
    const dec = new TextDecoder('utf-8', { fatal: false });
    const cstr = (v: Uint8Array, at: number, n: number): string => {
      let end = Math.min(at + n, v.length);
      for (let q = at; q < end; q++) if (v[q] === 0) { end = q; break; }
      return dec.decode(v.subarray(at, end));
    };
    const i32 = (v: Uint8Array, at: number): number =>
      v.length < at + 4 ? 0 : (v[at] | (v[at + 1] << 8) | (v[at + 2] << 16) | (v[at + 3] << 24)) | 0;
    const out: Array<{ tick: number; slot: number; name: string; userId: number; guid: string; isBot: boolean }> = [];
    const lastUid = new Map<number, number>();
    for (const snap of userinfoTimeline) {
      for (const ent of snap.entries) {
        const name = cstr(ent.value, 0, 32);
        if (name.length === 0 || /\uFFFD/.test(name)) continue;
        const userId = i32(ent.value, 32);
        const guid = cstr(ent.value, 36, 33);
        if (/\uFFFD/.test(guid)) continue;
        if (lastUid.get(ent.idx) === userId) continue;
        lastUid.set(ent.idx, userId);
        out.push({ tick: snap.tick, slot: ent.idx, name, userId, guid, isBot: guid === 'BOT' });
      }
    }
    return out;
  }

  /** 选中玩家的详细信息；缺失项如实写「未采到」并给出原因，不留空也不编造。 */
  private renderDetail(): void {
    if (this.selected < 0 || this.selected >= this.rows.length) {
      this.detail.innerHTML = '<div class="dmp-empty">本录像的 `userinfo` 表里没有可解出的玩家条目。</div>';
      this.note.textContent =
        '说明：玩家名单来自 `userinfo` 字符串表（按 `player_info_s` 布局解码）。表里没有条目时本面板无内容可显示。';
      return;
    }
    const row = this.rows[this.selected];
    const i = row.info;
    const kind = i.isBot ? '服务器机器人' : i.guid ? '真人' : '真伪未知';
    // **取舍**：看板上只留「看录像时要判断的几件事」——**身份**（真人还是脚本）、**在场区间**、
    // **队伍 / 生命**、**位姿有没有采到**。槽号 / 实体号 / userID / guid / 采样帧数 / 世界跨度 /
    // yaw 跨幅 / 类别与属性表名 / 阵亡时刻都是解析内部量，堆在板上只会挤占视线；
    // 它们全部收进悬停提示（`title`），需要排查时停一下就能读到。
    const facts = row.facts;
    const spanText = row.span ? `${row.span.from.toFixed(1)} – ${row.span.to.toFixed(1)} s` : '—';
    const teamText = facts && facts.teams.length > 0 ? facts.teams.map((t) => teamLabel(t)).join(' / ') : '—';
    // 生命：区间 + 阵亡次数 + 阵亡时刻（后两项直接来自 `PlayerSample.health` / `lifeState`）
    const hpText = facts?.hp
      ? `${facts.hp.min}–${facts.hp.max}` + (facts.deaths.length > 0 ? `，阵亡 ${facts.deaths.length} 次` : '')
      : facts && facts.deaths.length > 0
        ? `阵亡 ${facts.deaths.length} 次（未下发血量）`
        : '—';
    const deathTimes =
      facts && facts.deaths.length > 0
        ? `；阵亡时刻 ${facts.deaths.map((s2) => this.fmtClock(s2)).join('、')}`
        : '';
    // **同一身份占过多个槽位时如实列出**（花名册按身份合并成一行，位姿却是按实体存的）：
    // 跳转只能落到主实体，其余实体在这里点名，避免读者以为「这个人只有这一条轨迹」。
    // 身份信息在 `RosterRow` 上（本类的 `rows` 是「按 userinfo 条目」的另一张表，不含该字段）。
    const identity = this.rosterFor(i.entityIndex);
    const others = (identity?.entities ?? []).filter((e) => e !== i.entityIndex);
    const alsoAt = others.length > 0 ? `；同一身份另有实体 ${others.map((e) => `#${e}`).join('、')}` : '';
    const internals = facts
      ? `槽号 ${i.slot}；实体号 #${i.entityIndex}；userID ${i.userId}；guid ${i.guid || '（空）'}；` +
        `类别 ${row.track?.className ?? '—'}（${row.track?.dtName ?? '—'}，classId ${row.track?.classId ?? '—'}）；` +
        `采样帧数 ${facts.frames}；世界跨度 ${facts.distance.toFixed(0)} u；yaw 跨幅 ${facts.yawRange.toFixed(1)}°；` +
        `已死采样 ${facts.deadFrames} 条${deathTimes}${alsoAt}`
      : `槽号 ${i.slot}；实体号 #${i.entityIndex}；userID ${i.userId}；guid ${i.guid || '（空）'}；未采到位姿${alsoAt}`;
    // **人物名牌**（与「录像」页同一套语彙）：轨迹色点 + 名字 + 角色标签。
    // 色点取该实体的**轨迹配色**（`rows` 里按序号分配，与录像页的 `.track-dot` 同源），
    // 这样「看板上这个人 / 3D 里那条轨迹」一眼能对上，不必读文字。
    const color = '#' + (this.trackColor ?? this.colorOf(i.entityIndex)).toString(16).padStart(6, '0');
    const tag = i.isBot ? '脚本' : i.guid ? '真人' : '未知';
    this.detail.innerHTML = `
      <div class="dmp-who-head">
        <span class="dmp-who-dot" style="background:${color}" title="轨迹配色（与录像页的轨迹点同源）"></span>
        <span class="dmp-who-name">${this.esc(this.nameAtSlot(i.slot) || i.name || `槽 ${i.slot}`)}</span>
        <span class="dmp-who-tag${i.isBot ? '' : ' human'}">${tag}</span>
      </div>
      <div class="dmp-grid" title="解析内部量（排查用）：${this.esc(internals)}">
        <span>在场</span><b>${spanText}</b>
        <span>队伍</span><b>${this.esc(teamText)}</b>
        <span>生命</span><b>${this.esc(hpText)}</b>
      </div>
      </div>`;
    // **这里原先还有一个「tick 采样点」复选框**（逐实体的 `.dmp-opts`）—— owner 实测：
    // 它与时间轴 `.tl-opts` 里的同名开关**功能重叠且互相打架**（两处写同一件事，
    // 面板那处点不动/状态对不上），已按 owner 要求**移除**；tick 点的显隐现在只有
    // 时间轴那一处开关，逐人默认显隐仍由 `tickVisibleFor()` 提供（见其注释）。
    // **这段说明不再常驻**（owner：把地方让给对话区）：它讲的是「采样从哪来、为什么会不全」，
    // 属于一次性阅读的背景，回答一次就够 ⇒ 只作为详情面板的悬停提示保留，正文不再占行。
    this.note.textContent = '';
    this.detail.title = row.facts
      ? '说明：位姿采样自实体增量流；本工程该层尚未逐位对齐，故区间未必完整。队伍与生命取自同一批采样里的 m_iTeamNum / m_iHealth / m_lifeState。'
      : '说明：本条录像未采到该玩家的位姿 —— `CCSPlayer` 没有类别基线，坐标只能靠增量下发，而该层尚未逐位对齐。';
  }

  /**
   * 把实体号对应的轨迹交给外部（`apps/viewer/src/app.ts` 的录像会话负责 `addTrack` +
   * 切第一人称视角 + 播放）。
   *
   * `.dem` 的位姿**只能从实体流里取**（玩家类没有类别基线），所以「跳到某玩家的视角」等价于
   * 「用该玩家的实体轨迹建一条轨道并跟随」。轨迹不存在时**如实报缺**，不假装跳过去了。
   * 花名册行的点击与（可选）外部脚本的内省都走这里。
   */
  pickEntity(entityIndex: number): void {
    this.jumpTo(entityIndex);
  }

  private jumpTo(entityIndex: number): void {
    const r = this.result;
    // **点一个人 = 从他「该看的那一段」进去**（一行会对应多段 / 多条实体轨迹）：
    // · 播放头**正落在**他某一段里 ⇒ 就那一段（不把播放头甩到他另一段的起点）；
    // · 否则 ⇒ 调用方给的那条（点花名册给的是**他最早那一段**的实体；时间轴自动跳过缺口时
    //   给的是**下一段**的实体 —— 两者都靠「不给覆盖项就原样用」这条统一处理）。
    const identity = this.rosterFor(entityIndex);
    let target = entityIndex;
    if (identity) {
      const nowTick = this.opts.currentTick ? this.opts.currentTick() : -1;
      const covering = identity.spans.find((s) => nowTick >= s.from && nowTick <= s.to) ?? null;
      if (covering) target = covering.entity;
    }
    const track = r?.players.find((t) => t.entityIndex === target);
    if (!r || !track || track.samples.length < 2) {
      (this.opts.onNotice ?? ((s: string) => { this.note.textContent = s; }))(
        `实体 #${entityIndex} 在本录像里没有可用位姿（该层解析尚未对齐），无法切到它的视角。`,
      );
      return;
    }
    // 从这里起的「这个人」一律指解析出来的目标实体（同一身份，或许落在另一个槽位）
    entityIndex = target;
    const rule = this.opts.rule?.();
    if (!rule) return;
    // **名字的级别顺序**（都取「拿得到才用」）：花名册那一行的名字 → `userinfo` 条目里的名字 →
    // 「#实体号 类别名」。花名册排第一是因为**它才是看板上正在显示的那个名字** ——
    // 走 `userinfo` 条目表（`buildRows` 按签名表建）时，中途加入的真人根本不在表里，
    // 于是看板行写着 `LuoXuan`、详情却退回 `#5 CCSPlayer`（两者当场互相打脸）。
    const rosterRow = this.rosterFor(entityIndex);
    const row = this.rows.find((x) => x.info.entityIndex === entityIndex);
    const rosterName = rosterRow?.name.trim() ?? '';
    const label =
      rosterName ||
      (row?.info.name && row.info.name.length > 0 ? row.info.name : `#${entityIndex} ${track.className}`);
    // **详情面板要跟着换人**：`selected` 是 `renderDetail()` 唯一的取值来源，而它此前只在
    // `buildRows()` 里被设成 0、之后再没人改过 —— 于是无论点谁，「身份」那一栏始终显示第 0 行的
    // （owner 实测到的「显示的身份不是当前看的视角」）。这里按实体号把它同步过去。
    // **记住"当前跟随的是谁"**：详情名牌与信息条都以它为准（见 `refreshRosterState`）。
    this.lastPickedEntity = entityIndex;
    this.lastReportedName = label;
    const idx = this.rows.findIndex((x) => x.info.entityIndex === entityIndex);
    if (idx >= 0) {
      this.selected = idx;
      this.renderDetail();
    } else {
      // **`userinfo` 条目表里没有这个人**（实测这些录像该表只覆盖部分槽位，中途加入的真人不在其中）⇒
      // 补一条兜底行并按实体号回推槽位：槽号取 `实体号 − 1` 而不是 -1，这样详情名牌能继续按 tick 轮换
      // （`refreshRosterState` → `nameAtSlot(槽号, tick)`）；`userId` / `guid` 如实留空。
      // 不补的话 `selected` 指不到他，详情名牌会停在上一个人身上，而视角已经切走了。
      const s = track.samples;
      this.rows.push({
        info: { slot: rosterRow ? entityIndex - 1 : -1, entityIndex, name: label, userId: 0, guid: '', isBot: false },
        track,
        span:
          s.length > 0
            ? { from: s[0].tick * this.tickInterval, to: s[s.length - 1].tick * this.tickInterval }
            : null,
        facts: trackFacts(track, this.tickInterval),
      });
      this.selected = this.rows.length - 1;
      this.renderDetail();
    }
    const clip = trackToClip(track, r, rule, () => label);
    this.opts.onClip?.(clip);
  }

  private esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }
}
