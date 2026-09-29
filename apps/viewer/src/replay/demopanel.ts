/**
 * Source 演示录像（`.dem`）专用面板。
 *
 * 与「录像」页（`.replay` / Shavit 计时赛）**分开**：`.dem` 能给出的东西与 `.replay` 不同 ——
 * 前者有地图名、时长、tick 率、字符串表、类别基线、玩家名单（`player_info_s`），但**玩家逐帧位姿
 * 只在少数帧可见**（坐标主要靠增量下发，且本工程实体流尚未逐位对齐）；后者是定长采样、位姿完整。
 * 因此本面板的看板不是「轨迹列表 + 播放控制」，而是**时间线 + 玩家标注**：把每位玩家在上场时间轴
 * 上占的区间画出来，点选某位玩家即展开其全部已知信息。
 *
 * 数据来源：`parseSourceDemo()` 的 `DemoParseResult`（`playerInfos` 为按 `player_info_s` 布局解出的
 * 玩家信息，`players` 为采到的玩家类轨迹）。信息不足时**如实留白并注明原因**，不做推测填充。
 */

import { isPlayerClass, parseSourceDemo, type DemoParseResult, type DemoPlayerInfo, type PlayerTrack } from './demo/demo.js';
import { userinfoTimeline } from './demo/net.js';
import { trackToClip } from './democlip.js';
import { TRACK_PALETTE } from './tracks.js';
import { setAltPriorityOrder } from './demo/tables.js';
import type { Clip, RuleConfig } from './types.js';

/** 一位玩家在面板上的完整呈现数据：身份信息 + 其轨迹统计 + 在时间轴上的区间。 */
interface DemoPlayerRow {
  info: DemoPlayerInfo;
  /** 该玩家的轨迹（可能没有 —— 实体流未对齐时采不到位姿）。 */
  track: PlayerTrack | null;
  /** 时间轴区间（秒），无轨迹时为 `null`。 */
  span: { from: number; to: number } | null;
  /** 轨迹统计：帧数 / 跨度（世界单位）/ yaw 跨幅（度）。 */
  stats: { frames: number; distance: number; yawRange: number } | null;
}

/** 把一个数值夹在区间内。 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 从轨迹里算出「帧数 / 世界跨度 / yaw 跨幅」；无采样时返回 `null`。 */
function trackStats(track: PlayerTrack): DemoPlayerRow['stats'] {
  const s = track.samples;
  if (s.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let ylo = Infinity;
  let yhi = -Infinity;
  for (const p of s) {
    for (let k = 0; k < 3; k++) {
      const v = p.pos[k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    if (p.yaw < ylo) ylo = p.yaw;
    if (p.yaw > yhi) yhi = p.yaw;
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
  };
}

/** 面板与 3D 场景的挂钩：选中一条有轨迹的对象时把它变成可播放的轨道并切到对应视角。 */
export interface DemoPanelOptions {
  /** 取当前规则（与「录像」页同一套，保证变换/配色一致）。 */
  rule?: () => RuleConfig;
  /** 收到轨道：外部负责 `addTrack` / 替换并切视角。返回是否成功。 */
  onClip?: (clip: Clip) => void;
  /** 无法提供位姿时的提示出口。 */
  onNotice?: (text: string) => void;
  /**
   * 取当前播放位置的 **tick**（秒 × tick 率）。用于**名称轮换**：记录机器人共用同一人物、
   * 改名显示当前记录的关卡 ⇒ 名字是时变属性，必须按当前 tick 取，而不是取最后一张快照。
   */
  currentTick?: () => number;
  /** **.dem 载入成功**后调用：外部据此放出胶片进度条并在滑杆上打事件标记（不必等建出轨道）。 */
  onLoaded?: () => void;
  /** **悬停花名册某一行**时回调该行的活跃区间（秒）；移开传 null。时间轴据此在条上临时画区间。 */
  onHoverSpan?: (span: [number, number] | null) => void;
  /**
   * **按人物切换 tick 点**（`entity` = 实体号，`on` = 是否显示）。
   *
   * tick 点原先是「录像」页与「演示」页**共用的一个全局开关**，在一边关掉另一边也跟着没，
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
export class DemoPanel {
  private readonly opts: DemoPanelOptions;
  /**
   * **当前演示轨道的真实配色**（由 `app.ts` 在建/换轨道后写入）。
   *
   * 为什么不能自己算：轨迹颜色是 `TrackList` 按**轨道下标**取模分配的，**与实体号无关** ——
   * 演示只占一条轨道，它的颜色是固定的；早先我按实体号另算一套色板，于是看板上的点
   * 与 3D 里那条轨迹**永远对不上**（owner 实测「还是乱的」）。这里改成**如实取那条轨道的色**。
   */
  private trackColor: number | null = null;
  /** 最近一次被"点选/跟随"的实体号（详情名牌与信息条都以它为准）。 */
  private lastPickedEntity: number | null = null;
  /** 最近一次向外部通报的名字（去重用）。 */
  private lastReportedName = '';

  /** 由 `app.ts` 在演示轨道建立/替换后调用，写入其真实配色并重渲染详情。 */
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
  private rows: DemoPlayerRow[] = [];
  private result: DemoParseResult | null = null;
  private duration = 0;
  /** 全程总 tick 数（进度条的刻度基准；currentTick 也按同一 tick 口径）。 */
  private totalTicks = 1;
  private selected = -1;
  /** 最近一次载入的文件：切换展平顺序后要重新解析。 */
  private lastFile: File | null = null;

  constructor(root: HTMLElement, opts: DemoPanelOptions = {}) {
    this.opts = opts;
    this.root = root;
    root.innerHTML = `
      <div class="dmp-load">
        <label class="filebtn" for="demoFile">载入演示录像（.dem）</label>
        <input id="demoFile" type="file" accept=".dem" />
        <label class="dmp-alt"><input id="demoAltOrder" type="checkbox" /> 运动优先（实验展平顺序）</label>
      </div>
      <div class="dmp-meta" id="demoMeta">尚未载入</div>
      <div class="dmp-timeline" id="demoTimeline" hidden></div>
      <div class="dmp-detail" id="demoDetail"></div>
      <div class="dmp-note" id="demoNote"></div>`;
    this.input = root.querySelector<HTMLInputElement>('#demoFile')!;
    this.meta = root.querySelector<HTMLElement>('#demoMeta')!;
    this.track = root.querySelector<HTMLElement>('#demoTimeline')!;
    this.detail = root.querySelector<HTMLElement>('#demoDetail')!;
    this.note = root.querySelector<HTMLElement>('#demoNote')!;
    const alt = root.querySelector<HTMLInputElement>('#demoAltOrder');
    alt?.addEventListener('change', () => {
      setAltPriorityOrder(alt.checked);
      if (this.lastFile) void this.load(this.lastFile);
    });
    // 参考解析器（tf2-demo-parser）输出 JSON：直接吃它的 `users` / `chat` —— 那是**已验证可用**的
    // Source 1 解码结果（我们的 .dem 实测出 12 个用户，含真人 `Mon3tr`）。本工程自己的解析尚未对齐，
    // 故先提供这条**能直接看到全部名单**的通道，同时保留 .dem 通道继续收敛。
    this.input.addEventListener('change', () => {
      const f = this.input.files?.[0];
      if (f) void this.load(f);
    });
  }

  /** 载入并解析一份 `.dem`；解析失败时只显示错误文本，不清空既有内容以外的状态。 */
  async load(file: File): Promise<void> {
    this.lastFile = file;
    this.meta.textContent = `解析中…（${file.name}，${(file.size / 1048576).toFixed(1)} MB）`;
    this.detail.innerHTML = '';
    this.note.textContent = '';
    this.track.hidden = true;
    let result: DemoParseResult;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      result = parseSourceDemo(buf, { sampleMode: 'posed' });
    } catch (e) {
      this.meta.textContent = `解析失败：${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    this.result = result;
    this.duration = Math.max(1e-3, result.header.playbackTime);
    this.totalTicks = Math.max(1, result.header.playbackTicks);
    this.buildRows();
    this.renderMeta(file);
    this.renderTimeline();
    this.renderDetail();
    // **载入成功即通知外部**：底部那条胶片进度条要立刻放出来（并在滑杆上打好事件标记），
    // 而不是等用户点了某个玩家、建出第一条轨道之后才出现 —— 那时进度条才冒出来会显得"没加载成功"。
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
   * 进度条与事件标记**不在这里画**：它们统一打在底部时间轴的滑杆上
   * （`apps/viewer/src/replay/timeline.ts` 的 `setMarks`）。侧栏自画一条只会和时间轴打架，
   * 也正是「看板东西太多」的来源之一。
   */
  refreshNames(): void {
    // 「在服」行已挪进 demoMeta（owner：花名册不显示在线状态）⇒ 到 meta 里找它
    const head = this.meta.querySelector<HTMLElement>('.dmp-live');
    if (!head || this.rows.length === 0) return;
    const now = this.opts.currentTick ? this.opts.currentTick() : 0;
    const live: string[] = [];
    for (const row of this.rows) {
      const nm = this.nameAtSlot(row.info.slot, now);
      if (nm.length > 0) live.push(nm);
    }
    const text = live.length > 0 ? `在服 ${live.length}：${live.join(' · ')}` : '';
    if (head.textContent !== text) head.textContent = text;
  }

  private buildRows(): void {
    const r = this.result!;
    const byEntity = new Map<number, PlayerTrack>();
    for (const t of r.players) byEntity.set(t.entityIndex, t);
    this.rows = r.playerInfos.map((info) => {
      const track = byEntity.get(info.entityIndex) ?? null;
      const stats = track ? trackStats(track) : null;
      let span: DemoPlayerRow['span'] = null;
      if (track && track.samples.length > 0) {
        const tickRate = r.header.playbackTicks > 0 ? r.header.playbackTime / r.header.playbackTicks : 0;
        span = { from: track.samples[0].tick * tickRate, to: track.samples[track.samples.length - 1].tick * tickRate };
      }
      return { info, track, span, stats };
    });
    this.rows.sort((a, b) => a.info.slot - b.info.slot);
    this.selected = this.rows.length > 0 ? 0 : -1;
  }

  private renderMeta(file: File): void {
    const h = this.result!.header;
    const tickRate = h.playbackTicks > 0 ? h.playbackTicks / Math.max(1e-3, h.playbackTime) : 0;
    // **取舍**：看板上只留「看录像时真正要看的三项」——地图、时长、玩家数。
    // 协议号 / 字符串表张数 / 服务器类别数是**解析内部量**，看录像用不到，堆在板上只会挤占视线；
    // 它们收进悬停提示，需要排查时鼠标停一下即可读到，信息不丢。
    this.meta.innerHTML = `
      <div class="dmp-title">${h.mapName || '(地图名缺失)'}</div>
      <div class="dmp-grid">
        <span>时长</span><b>${(h.playbackTime / 60).toFixed(1)} 分钟</b>
        <span>玩家</span><b>${this.rows.length} 位</b>
        <span>在服</span><b class="dmp-live" title="当前 tick 在服务器上的人（名字随录像轮换）">—</b>
      </div>
      <div class="dmp-grid dmp-internals" title="解析内部量（排查用）：文件 ${file.name}；tick 率 ${tickRate.toFixed(1)}/s；演示协议 ${h.demoprotocol} ／ 网络协议 ${h.networkprotocol}；字符串表 ${this.result!.stringTables.length} 张；服务器类别 ${this.result!.dataTables.classes.length} 个">
        <span>来源</span><b>${file.name}</b>
      </div>`;
  }

  /**
   * **在场区间**：每条实体轨迹的 tick 覆盖范围 = 这个占用者「在场」的时间窗。
   *
   * 为什么不用 `userinfo` 表来判断在场：那张表是**累积**的，槽位一旦出现就不会消失，
   * 因此从它看不出「谁退服了」。轨迹是逐帧采样的，**采样停了就是人走了**——
   * 这是本仓库里唯一可测的在/离场依据。名字取窗口末端那一刻的名字（同一窗内可能改过名）。
   */
  private presenceWindows(): Array<{ slot: number; name: string; isBot: boolean; from: number; to: number }> {
    const r = this.result;
    if (!r) return [];
    const out: Array<{ slot: number; name: string; isBot: boolean; from: number; to: number }> = [];
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
      // §已知缺口 4）⇒ 真人全被滤掉、槽 0 那位又常无位姿轨迹 ⇒ **花名册整个为空** ⇒ 自动跟随选不出人
      // ⇒ 信息条与详情名牌永远停在第一个人身上（owner 报的「滚动名称被锁死」）。
      // 名字本来就不必是判据：下面一行就有兜底（`|| className #实体号`）。
      const from = t.samples[0].tick;
      const to = t.samples[t.samples.length - 1].tick;
      const name = this.nameAtSlot(slot, to) || t.className + ' #' + t.entityIndex;
      const guidIsBot = r.playerInfos.find((p) => p.slot === slot)?.isBot ?? true;
      out.push({ slot, name, isBot: guidIsBot, from, to });
    }
    return out;
  }

  /** 时间线：横轴 = 录像时长；每位玩家一行，有轨迹则画区间条，无轨迹则画一个「未采到位姿」的标记。 */
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
        const left = clamp((p.from / total) * 100, 0, 100);
        const right = clamp((p.to / total) * 100, 0, 100);
        const w = Math.max(0.4, right - left);
        return (
          '<button class="dmp-who" type="button" data-who="' + i + '">' +
          '<span class="dmp-whoname">' + this.esc(p.name) + '</span>' +
          '<span class="dmp-whobar"><i style="left:' + left.toFixed(3) + '%;width:' + w.toFixed(3) + '%"></i></span>' +
          '<span class="dmp-whotime">' + this.fmtClock(this.secAt(p.from)) + '–' + this.fmtClock(this.secAt(p.to)) + '</span>' +
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
      const span: [number, number] = [this.secAt(p.from), this.secAt(p.to)];
      btn.addEventListener('mouseenter', () => this.opts.onHoverSpan?.(span));
      btn.addEventListener('mouseleave', () => this.opts.onHoverSpan?.(null));
      btn.addEventListener('click', () => this.jumpTo(p.entity));
    }
    this.refreshRosterState();
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

  /** 某个人物的 tick 点是否显示（app 在切到该人物时据此落到轨道上）。 */
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
   */
  private refreshRosterState(): void {
    const tick = this.opts.currentTick ? this.opts.currentTick() : 0;
    const roster = this.roster(0);
    for (const btn of Array.from(this.track.querySelectorAll<HTMLButtonElement>('.dmp-who'))) {
      const p = roster[Number(btn.dataset.who)];
      if (!p) continue;
      const on = tick >= p.from && tick <= p.to;
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
   * 位置按**整条录像**的 tick 归一（`ratio = tick / 总 tick`）—— 演示片段在时间轴上就是整段窗口，
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
   * 演示页把「当前时间」换算成 tick 时必须用它 —— 早先在 pp.ts 里把 tick 率写死成 100，
   * 而这份录像实际是 66.67，于是「当前 tick」跑得比真实快 1.5 倍：播到后半段 currentTick`r
   * 早已超过 	otalTicks，花名册里**所有在线的人都被判成离线**（owner 实测）。
   */
  tickRate(): number {
    return this.duration > 0 ? Math.max(1, this.totalTicks) / this.duration : 1;
  }

  /** 全程总 tick，供时间轴把花名册的 tick 区间换算成时间标注。 */
  totalTickCount(): number {
    return Math.max(1, this.totalTicks);
  }

  /**
   * **花名册 = 占用事件表**（每次「进服 / 换人」是一条），不是「实体轨迹表」。
   *
   * owner 实测到的错：录像里到中途会**加进来其他几位记录机器人**，但条上没有任何加入标记。
   * 根因是我从 `r.players`（**实体轨迹**）建花名册 —— 这份录像只有 **4 条**玩家实体轨迹，
   * 而 `userinfo` 里有 **11 次**占用事件（记录机器人换 uid 重连、新机器人加入）。
   * **一个实体可以先后被多个人占用**，所以「一个人一次在场」才是花名册的正确粒度。
   *
   * - `from` = 该次占用事件的 tick（**加入位置** ⇒ 条上画得出）；
   * - `to` = **该槽位的下一次占用事件的 tick**（= 这次占用结束 ⇒ 退场位置也画得出）；
   *   没有下一次的（他一直在场到录像结束）记到片尾。
   * - **只保留有有效视角的**：该槽位对应的实体必须有一条可用轨迹，否则切过去看不到东西。
   */
  roster(ratio: number): Array<{ key: number; name: string; isBot: boolean; entity: number; from: number; to: number }> {
    void ratio;
    // **区间取「实际活跃窗口」= 该实体轨迹的首末采样帧，而不是 `userinfo` 的进服事件。**
    //
    // 这是 owner 实测到的"看板与点击后起点对不上、错得离谱"的根因：一个人可以**进服后一直挂机**
    // （挂到观察者上不动），此时 `userinfo` 里早早就有他的进服事件，但**位置数据要到很久之后才开始有**。
    // 实测 `#5`：进服事件 3:59，而首个采样帧是 **26:05** —— 差 22 分钟。
    // 点他时 `player.seek(clip.t[0])` 用的是**采样**口径 ⇒ 看板必须同口径才不会对不上。
    //
    // 名字仍取该窗口末端那一刻的名字（记录机器人会沿用同一人物改名）。
    return this.presenceWindows()
      .map((p, i) => ({
        key: i,
        name: this.nameAtSlot(p.slot, p.to) || p.name,
        isBot: p.isBot,
        entity: p.slot + 1,
        from: p.from,
        to: p.to,
      }))
      .sort((a, b) => a.from - b.from);
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
    // **取舍**：看板上只留「看录像时要判断的三件事」——**身份**（真人还是脚本）、**在场区间**、
    // **位姿有没有采到**。槽号 / 实体号 / userID / guid / 采样帧数 / 世界跨度 / yaw 跨幅都是
    // 解析内部量，堆在板上只会挤占视线；它们全部收进悬停提示（`title`），需要排查时停一下就能读到。
    const spanText = row.span ? `${row.span.from.toFixed(1)} – ${row.span.to.toFixed(1)} s` : '—';
    const internals = row.stats
      ? `槽号 ${i.slot}；实体号 #${i.entityIndex}；userID ${i.userId}；guid ${i.guid || '（空）'}；采样帧数 ${row.stats.frames}；世界跨度 ${row.stats.distance.toFixed(0)} u；yaw 跨幅 ${row.stats.yawRange.toFixed(1)}°`
      : `槽号 ${i.slot}；实体号 #${i.entityIndex}；userID ${i.userId}；guid ${i.guid || '（空）'}；未采到位姿`;
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
      </div>
      <div class="dmp-opts">
        <label class="dmp-opt" title="只影响这一个实体：tick 点是录像的原始帧采样点，关掉可让画面更干净">
          <input type="checkbox" data-tick="${i.entityIndex}"${this.tickOff.has(i.entityIndex) ? '' : ' checked'} />
          <span>tick 采样点</span>
        </label>
      </div>`;
    // tick 点开关：改的是**这一个实体**的设置（`onTickToggle` 由 app 落到该轨道的显隐上）。
    const tickBox = this.detail.querySelector<HTMLInputElement>('input[data-tick]');
    tickBox?.addEventListener('change', () => {
      const on = tickBox.checked;
      if (on) this.tickOff.delete(i.entityIndex);
      else this.tickOff.add(i.entityIndex);
      this.opts.onTickToggle?.(i.entityIndex, on);
    });
    this.note.textContent = row.stats
      ? '说明：位姿采样自实体增量流；本工程该层尚未逐位对齐，故区间可能不完整。'
      : '说明：本条录像未采到该玩家的位姿 —— `CCSPlayer` 没有类别基线，坐标只能靠增量下发，而该层尚未逐位对齐。';
  }

  /**
   * 把实体号对应的轨迹交给外部（`app.ts` 负责 `addTrack` + 切第一人称视角）。
   *
   * `.dem` 的位姿**只能从实体流里取**（玩家类没有类别基线），所以「跳到某玩家的视角」等价于
   * 「用该玩家的实体轨迹建一条轨道并跟随」。轨迹不存在时**如实报缺**，不假装跳过去了。
   * 底部时间轴滑杆上的事件标记点击即走这里。
   */
  /**
   * 把实体号对应的轨迹交给外部（`app.ts` 负责 `addTrack` + 切第一人称视角）。
   *
   * `.dem` 的位姿**只能从实体流里取**（玩家类没有类别基线），所以「跳到某玩家的视角」等价于
   * 「用该玩家的实体轨迹建一条轨道并跟随」。轨迹不存在时**如实报缺**，不假装跳过去了。
   */
  /** 公开的选人入口：底部时间轴的事件标记点击时调用（内部走既有的 jumpTo）。 */
  pickEntity(entityIndex: number): void {
    this.jumpTo(entityIndex);
  }

  private jumpTo(entityIndex: number): void {
    const r = this.result;
    const track = r?.players.find((t) => t.entityIndex === entityIndex);
    if (!r || !track || track.samples.length < 2) {
      (this.opts.onNotice ?? ((s: string) => { this.note.textContent = s; }))(
        `实体 #${entityIndex} 在本录像里没有可用位姿（该层解析尚未对齐），无法切到它的视角。`,
      );
      return;
    }
    const rule = this.opts.rule?.();
    if (!rule) return;
    // **名字不能只指望 `userinfo`**：实测这份录像的 `userinfo` 只有槽 0 有值（记录机器人），
    // 于是 4 个真实玩家全部拿不到名字、列表里只剩实体号。这里给出**一定有值**的标签：
    // 有 `userinfo` 名字就用名字，否则退回「#实体号 类别名」——类别名来自实体流，必然可得。
    const row = this.rows.find((x) => x.info.entityIndex === entityIndex);
    const label = row?.info.name && row.info.name.length > 0 ? row.info.name : `#${entityIndex} ${track.className}`;
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
      // **userinfo 里没有这个人**（实测这些录像的 `userinfo` 只有槽 0 = 录制机器人）⇒
      // 补一条兜底行：名字退回「#实体号 类别名」，其余项如实留空（槽号 -1 = 非 userinfo 来源）。
      // 不补的话 `selected` 指不到他，详情名牌会停在上一个人身上，而视角已经切走了。
      const h = this.result!.header;
      const tickRate = h.playbackTicks > 0 ? h.playbackTime / h.playbackTicks : 0;
      const s = track.samples;
      this.rows.push({
        info: { slot: -1, entityIndex, name: label, userId: 0, guid: '', isBot: false },
        track,
        span:
          s.length > 0
            ? { from: s[0].tick * tickRate, to: s[s.length - 1].tick * tickRate }
            : null,
        stats: trackStats(track),
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
