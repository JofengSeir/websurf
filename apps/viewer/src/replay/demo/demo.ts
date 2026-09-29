/**
 * Source 引擎演示录像（`.dem`）的顶层解析：文件头 + 消息链 + 逐帧玩家轨迹。
 *
 * 消息链（全部小端）：
 *   文件头 1072 字节：`HL2DEMO\0`(8) + demoprotocol(i32=3) + networkprotocol(i32) +
 *     servername/clientname/mapname/gamedirectory(各 260 字节) + playback_time(f32) +
 *     playback_ticks(i32) + playback_frames(i32) + signonlength(i32)。
 *   其后逐条消息，每条以 `cmd u8 + tick i32` 开头：
 *     dem_signon(1) / dem_packet(2)：再跟 `democmdinfo` 76 字节（flags i32 + 6 个三轴 float）、
 *       `seqIn i32`、`seqOut i32`、`len i32`，随后 `len` 字节的**网络消息流**（见 demo/net.ts）。
 *     dem_synctick(3)：无载荷。
 *     dem_consolecmd(4)：NUL 结尾命令串。
 *     dem_usercmd(5)：`outgoingSequence i32 + len i32 + len 字节`。
 *     dem_datatables(6)：`len i32 + len 字节`（发送表 + 类别表，见 demo/tables.ts）。
 *     dem_stop(7)：无载荷。
 *     dem_stringtables(8)：`len i32 + len 字节`（本模块按长度整段跳过）。
 *   协议 24 的 `dem_signon` / `dem_packet` **没有**玩家槽字节——`cmd + tick` 之后直接是 `democmdinfo`。
 *
 * 玩家轨迹（`extractPlayerTracks`）：每处理完一条 `svc_PacketEntities` 消息，就把所有「玩家类」实体
 * 的当前位置与朝向记一个采样点。玩家类的判据是**类别名以 `Player` 结尾或名为 `CCSPlayer`**，
 * 字段判据是属性表里同时存在 `m_vecOrigin` 与 `m_angEyeAngles[0]`——后者正是 CS:S 发送表里
 * `DT_CSPlayer` 的两个 Float 属性（见 demo/tables.ts 的展平结果）。
 */

import { BitReader } from './bits.js';
import { currentTickRef, type EntityProps, NetContext, parsePacket, type DemoParseStats } from './net.js';
import { readDataTables, type DataTables } from './tables.js';

/** 文件头字段（`demoheader_t`）。 */
export interface DemoHeader {
  demoprotocol: number;
  networkprotocol: number;
  serverName: string;
  clientName: string;
  mapName: string;
  gameDirectory: string;
  playbackTime: number;
  playbackTicks: number;
  playbackFrames: number;
  signonLength: number;
}

/** 一个采样点（某一 tick 上某玩家的位姿）。 */
export interface PlayerSample {
  /** 录像 tick。 */
  tick: number;
  /** 位置（Source 坐标，HU）。 */
  pos: [number, number, number];
  /** 视向：yaw / pitch（度，Source 约定）。 */
  yaw: number;
  pitch: number;
  /** 生命值；本次未发送该属性时为 null（沿用旧值）。 */
  health: number | null;
  /** 队伍号；未发送时为 null。 */
  team: number | null;
  /** 生命状态（2 = 存活）；未发送时为 null。 */
  lifeState: number | null;
}

/** 一名玩家（一个实体号）的完整轨迹。 */
export interface PlayerTrack {
  entityIndex: number;
  classId: number;
  className: string;
  /** 表名（`DT_*`）。 */
  dtName: string;
  /** 按 tick 升序的采样点。 */
  samples: PlayerSample[];
}

/** 解析产物。 */
export interface DemoParseResult {
  header: DemoHeader;
  dataTables: DataTables;
  stats: DemoParseStats;
  players: PlayerTrack[];
  /** 录像内嵌字符串表（含 instancebaseline）。 */
  stringTables: DemoStringTable[];
  /**
   * 网络消息流里 `svc_CreateStringTable` 收到的字符串表（表名 → 条目）。
   * 其中 `instancebaseline` 是按类别的属性基线来源，与 `dem_stringtables` 的那份互补。
   */
  packetStringTables: { name: string; entries: Map<number, { key: string; value: Uint8Array | null }> }[];
  /** 玩家采样诊断（定位「为什么没有轨迹」用）。 */
  playerDiag: PlayerSampleDiag;
  /** 诊断直方图：「类别 id:扁平下标」→ 引擎实际下发次数。 */
  indexHistogram: Map<string, number>;
  /**
   * 玩家名：**实体号 → 名字**。来源是 `userinfo` 字符串表（条目键 = 玩家槽号，值 =
   * `player_info_s`，名字在偏移 0 处、NUL 结尾的 32 字节）。槽号与实体号的关系是
   * `实体号 = 槽号 + 1`（引擎把玩家槽 i 的实体放在 `i + 1`）。空槽 / 空名不进表。
   */
  playerNames: Map<number, string>;
  /**
   * 录像内出现过的**文本消息**（`svc_Print` / `svc_StringCmd` / `svc_Disconnect`），按出现顺序。
   * 这里面含服务器打印、聊天与「X connected / disconnected」公告 —— 是**不依赖实体流**的
   * 玩家名单来源（容量上限见 `demo/net.ts` 的 `CHAT_LINE_LIMIT`）。
   */
  chatLines: string[];
  /** 录像里的玩家信息（按已验证的 `player_info_s` 布局解码；见 `readPlayerInfos`）。 */
  playerInfos: DemoPlayerInfo[];
  /** 解析结束时每个玩家实体的属性快照（诊断用，仅取关注字段）。 */
  playerSnapshots: Record<number, Record<string, unknown>>;
  /** 选定的属性位图极性（见 demo/net.ts 的 `NetContext.legacyPropOrder`）。 */
  legacyPropOrder: boolean;
  /** 解析结束时仍在实体表里的实体数。 */
  entityCount: number;
  /** 解析结束时各服务器类别的实体数（类名 → 个数）。 */
  classCounts: Record<string, number>;
  /** 玩家类实体上实际解出的属性名（类名 → 属性名，诊断用）。 */
  playerPropNames: Record<string, string[]>;
}

/** `.dem` 文件头固定长度（字节）。 */
export const DEMO_HEADER_BYTES = 1072;

/**
 * 玩家实体号的合法上限。Source 的玩家实体恒占 `1..maxplayers` 槽位（CS:S 上限 64），
 * 超出这个范围的实体即使类别名像玩家（`CCSPlayer` / `CBasePlayer`）也不是真人 —— 见 `samplePlayers`。
 */
export const MAX_PLAYER_SLOT = 64;
/** 是否把包内 `userinfo` 更新并回签入表（诊断开关，见 `parseSourceDemo` 的并入段注释）。 */
const MERGE_USERINFO_UPDATES = true;
/** `democmdinfo_t` 在协议 24 的线上长度：flags(i32) + 6 × 三轴 float。 */
const DEMO_CMDINFO_BYTES = 76;

/** 诊断：`dem_usercmd`（cmd 5）的载荷长度分布 —— 用来判断按键信息是否存在。 */
export const usercmdDiag = { count: 0, maxLen: 0, samples: [] as number[] };

/** 嗅探：文件头魔数是否为 `HL2DEMO`。 */
export function looksLikeSourceDemo(head: Uint8Array): boolean {
  const magic = 'HL2DEMO\0';
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (head[i] !== magic.charCodeAt(i)) return false;
  return true;
}

/** 文件形态嗅探（Worker 与主线程两条导入路径共用）。 */
export async function fileLooksLikeSourceDemo(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return looksLikeSourceDemo(head);
  } catch {
    return false;
  }
}

/** 读取 `.dem` 文件头。 */
export function readDemoHeader(bytes: Uint8Array): DemoHeader {
  if (!looksLikeSourceDemo(bytes)) throw new Error('不是有效的 Source 演示录像（缺少 HL2DEMO 魔数）');
  if (bytes.length < DEMO_HEADER_BYTES) throw new Error('Source 演示录像文件被截断：文件头不足 1072 字节');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cstr = (from: number): string => {
    let s = '';
    for (let i = from; i < from + 260 && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  return {
    demoprotocol: dv.getInt32(8, true),
    networkprotocol: dv.getInt32(12, true),
    serverName: cstr(16),
    clientName: cstr(276),
    mapName: cstr(536),
    gameDirectory: cstr(796),
    playbackTime: dv.getFloat32(1056, true),
    playbackTicks: dv.getInt32(1060, true),
    playbackFrames: dv.getInt32(1064, true),
    signonLength: dv.getInt32(1068, true),
  };
}

/**
 * 解析整份 `.dem`。
 *
 * `bitOrderOverride` 用于把属性位图极性钉死（诊断用）；缺省时按第一条 `svc_PacketEntities`
 * 的「实体载荷是否恰好用尽声明位数」自动择优。
 */
/** 解析选项（诊断与实测开关；生产路径不传，走缺省）。 */
export interface DemoParseOptions {
  /** 属性位图极性覆盖（见 `NetContext.legacyPropOrder`）。 */
  legacyPropOrder?: boolean;
  /** 非 null 时收集逐消息轨迹（诊断用）。 */
  trace?: string[];
  /** 实体号是否带 `+1`（见 `NetContext.entityIndexPlusOne`）。 */
  entityIndexPlusOne?: boolean;
  /** 进入 PVS 时的序号位数（见 `NetContext.enterSerialBits`）。 */
  enterSerialBits?: number;
  /** 位姿采样口径：`'players'`（缺省）只采玩家类，`'posed'` 采任何同时有坐标与朝向的实体。 */
  sampleMode?: 'players' | 'playerPosed' | 'posed';
  /** 类别号位宽覆盖（见 `NetContext.classIdBitsOverride`）。 */
  classIdBitsOverride?: number;
  /** 实体号基准初值（见 `NetContext.headerBaseInit`）。 */
  headerBaseInit?: number;
  /** 类别号前的额外位数（见 `NetContext.preClassBits`）。 */
  preClassBits?: number;
  /** 类别号后的额外位数（见 `NetContext.postClassBits`）。 */
  postClassBits?: number;
  /** 展平选项（见 `NetContext.flattenOptions`）。 */
  flattenOptions?: { childFirst?: boolean; stablePriority?: boolean; includeInsideArray?: boolean; emitDataTableProps?: boolean };
  /** 诊断：每条实体记录属性列表后额外跳过的位数（见 `NetContext.propListPadBits`）。 */
  propListPadBits?: number;
  /** 实体号越界时是否中断整段实体流（见 `NetContext.breakOnEntityOverflow`；缺省中断）。 */
  breakOnEntityOverflow?: boolean;
  /** 实体循环终止口径（见 `NetContext.entityLoopMode`）：'count'（缺省）读 updatedEntries 条，'untilEnd' 读到声明长度。 */
  entityLoopMode?: 'count' | 'untilEnd';
  /** svc_PacketEntities 实体号位宽（见 NetContext.edictBits）。 */
  edictBits?: number;
  /** maxEntries 位宽（见 `NetContext.maxEntriesBits`）。 */
  maxEntriesBits?: number;
  /** updatedEntries 位宽（见 `NetContext.updatedEntriesBits`）。 */
  updatedEntriesBits?: number;
}

export function parseSourceDemo(bytes: Uint8Array, opts: DemoParseOptions = {}): DemoParseResult {
  const header = readDemoHeader(bytes);
  if (header.demoprotocol !== 3) {
    throw new Error(`不支持的演示协议版本 ${header.demoprotocol}（本工程只实现 3）`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stats: DemoParseStats = {
    packetsParsed: 0,
    packetsFailed: 0,
    failureByType: {},
    seenByType: {},
    entityMessages: 0,
    entityUpdates: 0,
    entityPayloadExact: 0,
    entityPayloadMismatch: 0,
    entityUnknownClass: 0,
    entityOverread: 0,
    entityOverflow: 0,
    loopExit: new Map(),
    entityResidual: new Map(),
    entityResidualFull: new Map(),
    entityExactFull: 0,
    entityExactDelta: 0,
    entityResidualUpd1: new Map(),
    stringTableEndBit: 0,
    stringTableBytes: 0,
    warnings: [],
  };

  const messages = scanMessages(bytes, dv, stats);
  const dtMsg = messages.find((m) => m.cmd === 6);
  if (!dtMsg) throw new Error('演示录像缺少 dem_datatables 消息（无法取得发送表）');
  const dataTables = readDataTables(
    new BitReader(bytes, dtMsg.payloadBit, dtMsg.payloadBit + dtMsg.payloadBits),
  );
  const ctx = new NetContext(dataTables);
  if (opts.legacyPropOrder !== undefined) ctx.legacyPropOrder = opts.legacyPropOrder;
  if (opts.entityIndexPlusOne !== undefined) ctx.entityIndexPlusOne = opts.entityIndexPlusOne;
  if (opts.enterSerialBits !== undefined) ctx.enterSerialBits = opts.enterSerialBits;
  if (opts.classIdBitsOverride !== undefined) ctx.classIdBitsOverride = opts.classIdBitsOverride;
  if (opts.headerBaseInit !== undefined) ctx.headerBaseInit = opts.headerBaseInit;
  if (opts.preClassBits !== undefined) ctx.preClassBits = opts.preClassBits;
  if (opts.postClassBits !== undefined) ctx.postClassBits = opts.postClassBits;
  if (opts.flattenOptions) ctx.flattenOptions = opts.flattenOptions;
  if (opts.edictBits !== undefined) ctx.edictBits = opts.edictBits;
  if (opts.breakOnEntityOverflow !== undefined) ctx.breakOnEntityOverflow = opts.breakOnEntityOverflow;
  if (opts.propListPadBits !== undefined) ctx.propListPadBits = opts.propListPadBits;
  if (opts.entityLoopMode !== undefined) ctx.entityLoopMode = opts.entityLoopMode;
  if (opts.maxEntriesBits !== undefined) ctx.maxEntriesBits = opts.maxEntriesBits;
  if (opts.updatedEntriesBits !== undefined) ctx.updatedEntriesBits = opts.updatedEntriesBits;

  // dem_stringtables：类别基线的来源，同时是「发送表展平 + 属性位图」的逐类判据
  const stMsg = messages.find((m) => m.cmd === 8);
  let stringTables: DemoStringTable[] = [];
  if (stMsg) {
    const from = stMsg.payloadBit / 8;
    const res = readDemoStringTables(bytes, from, from + stMsg.payloadBytes);
    stringTables = res.tables;
    stats.stringTableEndBit = res.endBit - from * 8;
    stats.stringTableBytes = stMsg.payloadBytes;
    if (res.overflowed) stats.warnings.push('dem_stringtables 解析越界');
  }
  ctx.stringTableIdNames = stringTables.map((t) => t.name);
  const chatLines = ctx.chatLines;
  // 类别基线灌进解析上下文：实体进入 PVS 时要「先套基线再叠 delta」
  for (const t of stringTables) {
    if (t.name !== 'instancebaseline') continue;
    for (const [, e] of t.entries) {
      if (!e.value) continue;
      const id = Number(e.key);
      if (Number.isFinite(id)) ctx.baselineBlobs.set(id, e.value);
    }
  }
  if (opts.trace) ctx.trace = opts.trace;

  const players: PlayerTrack[] = [];
  const playerDiag = newPlayerSampleDiag();
  for (const m of messages) {
    if (m.cmd !== 1 && m.cmd !== 2) continue;
    ctx.packetIndex++;
    const head = m.payloadBit / 8;
    const len = m.payloadBytes;
    if (len <= 0 || head + len > bytes.length) {
      stats.warnings.push(`消息 @${m.offset}：包长 ${len} 非法`);
      continue;
    }
    currentTickRef.tick = m.tick;
    parsePacket(bytes.subarray(head, head + len), ctx, stats);
    // 每包解析完后立即采样：属性表里已有本 tick 的玩家位姿
    samplePlayers(ctx, dataTables, m.tick, players, playerDiag, opts.sampleMode ?? 'players');
  }

  // 包内 `svc_UpdateStringTable` 的表号→表名路由已修正（见 `NetContext.stringTableIdNames`），
  // 但**更新消息内部的条目位布局仍未解对**：并入后名字会变成乱码字节，并覆盖掉签入时那条好数据
  // （实测自检「userinfo 解出玩家名」从 1 变 0）。故此处暂不并入，等条目布局定死后再打开。
  // 诊断出口：`ctx.stringTables` 里已能看到落在 `userinfo` 上的更新条目数（21 → 27）。
  // 包内 `svc_UpdateStringTable` 会把**中途加入**的玩家写进 `userinfo`，更新落在 `ctx.stringTables`，
  // 需并回 `dem_stringtables` 那份表再取名单。但更新条目流尚未完全对齐，**并入前必须校验**：
  // 只接受「userdata 首段是可打印文本」的条目（`player_info_s` 的名字就在首段），否则乱码条目会
  // 覆盖掉签入时那条好数据（实测自检「userinfo 解出玩家名」会从 1 变 0）。校验即 `plausibleName`。
  for (const t of stringTables) {
    if (!MERGE_USERINFO_UPDATES) break;
    // **只并 `userinfo`**：其它表（尤其 `instancebaseline`）的更新形式尚未定死，用解错的值覆盖签入
    // 期那份会毁掉类别基线 —— 实测后果是玩家类实体的世界坐标整批消失、导入退回 `posed` 口径
    //（301 条服务器实体、看不到玩家）。这个限制是实测得出的，不是保守起见。
    if (t.name !== 'userinfo') continue;
    const upd = ctx.stringTables.get(t.name);
    if (!upd || upd.size === 0) continue;
    for (const [k, v] of upd) {
      if (!v.value || v.value.length === 0) continue;
      // **允许多记录块**：实测更新条目的 userdata 是 1056 字节 = 8 x 132（每条一个 player_info_s）。
      // 早先只按「整段像不像一个名字」放行，1056 字节的块一律被拒 -> 中途加入的玩家全部丢失。
      const isMultiRecord = v.value.length > 132 && v.value.length % 132 === 0;
      const name = isMultiRecord ? 'multi' : plausibleName(v.value);
      // 诊断：把更新条目的原始 userdata 前 48 字节打出来。`player_info_s` 的名字在偏移 0、`userID`
      // 在偏移 32、`guid` 在偏移 36 —— 只要在偏移 36 处看到 `BOT`（0x42 0x4f 0x54）就说明对位。
      if (playerDiag.userinfoUpdateHex.length < 12) {
        const hex = [...v.value.subarray(0, 48)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        playerDiag.userinfoUpdateHex.push(
          `idx=${k} key=${JSON.stringify(v.key)} len=${v.value.length} name=${JSON.stringify(name)} head=${hex}`,
        );
      }
      // 诊断：按 `player_info_s`（132 字节）逐条切分该 blob，`name`@0 / `userID`@32 / `guid`@36。
      // 若逐条能读出可读名字与 `BOT`，说明线上真实形态就是「一次下发 N 条玩家记录」。
      if (v.value.length >= 132 && playerDiag.userinfoUpdateHex.length < 24) {
        const val = v.value;
        const dec = new TextDecoder('utf-8', { fatal: false });
        const cstr = (from: number, max: number): string => {
          const end = Math.min(from + max, val.length);
          let e2 = end;
          for (let q = from; q < end; q++) if (val[q] === 0) { e2 = q; break; }
          return dec.decode(val.subarray(from, e2));
        };
        const recs: string[] = [];
        for (let off = 0; off + 132 <= val.length && recs.length < 8; off += 132) {
          recs.push(`[${off}] name=${JSON.stringify(cstr(off, 32))} uid=${val[off + 32]} guid=${JSON.stringify(cstr(off + 36, 33))}`);
        }
        playerDiag.userinfoUpdateHex.push(`分条(${val.length}B)：` + recs.join(' ｜ '));
      }
      // **槽号取「条目下标」**：更新条目只带 userdata、不带文本键（键沿用表里已有的），故 `v.key` 为空。
      // 注：必须与 `net.ts` 的「签入段表多 5 位」修正**成对**才成立 —— 单改这里会把错位的垃圾数据并进表。
      if (name === null) continue;
      const slotKey = /^\d{1,3}$/.test(v.key) ? v.key : String(k);
      t.entries.set(k, { key: slotKey, value: v.value });
    }
  }
  playerDiag.updateMap = [...ctx.stringTables.entries()].map(([k, v]) => k + '=' + v.size);
  playerDiag.idNames = ctx.stringTableIdNames.slice();
  const playerInfos = readPlayerInfos(stringTables);
  const playerNames = readPlayerNames(stringTables);
  // **诊断：`CCSPlayerResource` 实体上到底有没有名字/队伍**。
  // 动机：这份录像的 `userinfo` 只有槽 0 有值（记录机器人），4 个真实玩家因此没有名字；
  // 权威实现的名字来自 `CCSPlayerResource` 的 `m_szPlayerName` 数组。先确认那些属性是否还在手里，
  // 再决定要不要把它接成名字来源。
  for (const [entIdx, clsId] of ctx.entityClass) {
    const cls = ctx.dataTables.classes.find((c) => c.id === clsId);
    if (!cls || !/PlayerResource/i.test(cls.name)) continue;
    const props = ctx.entityProps.get(entIdx);
    if (!props) continue;
    const keys = [...props.keys()];
    // 键名多为纯数字（`001`/`002`…）⇒ 该类的扁平表里名字是空的；这里把**值**也带出来，
    // 看 48 项里有没有字符串（玩家名就在 `m_szPlayerName` 数组里）。
    const fl = ctx.flatFor(clsId);
    const withVals = keys.slice(0, 60).map((k) => {
      const idx = Number(k.split('#')[1]);
      const fe = fl[idx] as { ownerTable?: string; prop?: { name?: string } } | undefined;
      return `${fe?.ownerTable ?? '?'}/${fe?.prop?.name ?? k}=${JSON.stringify(props.get(k)).slice(0, 36)}`;
    });
    playerDiag.playerResource.set(entIdx, [`总属性数=${props.size}`, ...withVals]);
  }

  const WATCH = [
    'm_iHealth',
    'm_iTeamNum',
    'm_lifeState',
    'm_vecOrigin',
    'm_vecViewOffset[2]',
    'm_angEyeAngles[0]',
    'm_angEyeAngles[1]',
    'm_flSimulationTime',
    'm_iPlayerState',
  ];
  const playerSnapshots: Record<number, Record<string, unknown>> = {};
  for (const [entityIndex, classId] of ctx.entityClass) {
    const cls = dataTables.classes.find((c) => c.id === classId);
    if (!cls || !isPlayerClass(cls.name)) continue;
    const props = ctx.entityProps.get(entityIndex);
    if (!props) continue;
    const snap: Record<string, unknown> = {};
    for (const k of WATCH) if (props.has(k)) snap[k] = props.get(k);
    snap['_propCount'] = props.size;
    playerSnapshots[entityIndex] = snap;
  }

  const classCounts: Record<string, number> = {};  const playerPropNames: Record<string, string[]> = {};
  for (const [, classId] of ctx.entityClass) {
    const cls = dataTables.classes.find((c) => c.id === classId);
    const cn = cls?.name ?? `#${classId}`;
    classCounts[cn] = (classCounts[cn] ?? 0) + 1;
    if (cls && isPlayerClass(cls.name) && !playerPropNames[cn]) {
      const props = ctx.entityProps.get([...ctx.entityClass.entries()].find(([, v]) => v === classId)![0]);
      playerPropNames[cn] = props ? [...props.keys()] : [];
    }
  }

  return {
    header,
    chatLines,
    playerInfos,
    dataTables,
    stats,
    players,
    stringTables,
    packetStringTables: [...ctx.stringTables.entries()].map(([name, entries]) => ({ name, entries })),
    playerDiag,
    indexHistogram: ctx.indexHistogram,
    playerNames,
    playerSnapshots,
    legacyPropOrder: ctx.legacyPropOrder,
    entityCount: ctx.entityClass.size,
    classCounts,
    playerPropNames,
  };
}

/**
 * `dem_stringtables` 载荷（**不是**网络消息流，是引擎 `WriteStringTables` 的直接位流）：
 *   `[u8 numTables]`，随后每张表：
 *     `[字符串 表名][u16 条目数]`，随后每条目：
 *       `[字符串 键][1 位 有无值]`，有值时 `[u16 字节数][该字节数的原始位]`
 *     条目之后：`[1 位 有无客户端侧条目]`，有则再读一组同构条目。
 *
 * 这份表里有 `instancebaseline`（键 = 类别序号的十进制串，值 = 该类别的属性基线位流），
 * 是本工程校验「发送表展平 + 属性位图」是否正确的**逐类判据**：基线位流的字节数是已知的，
 * 解码它必须恰好用尽这些位。
 */
export function readDemoStringTables(
  bytes: Uint8Array,
  startByte: number,
  endByte: number,
): { tables: DemoStringTable[]; endBit: number; overflowed: boolean } {
  const r = new BitReader(bytes, startByte * 8, endByte * 8);
  const numTables = r.u(8);
  const tables: DemoStringTable[] = [];
  const readEntries = (count: number, into: Map<number, { key: string; value: Uint8Array | null }>): void => {
    for (let i = 0; i < count && !r.overflowed; i++) {
      const key = r.str();
      let value: Uint8Array | null = null;
      if (r.bit() === 1) {
        const size = r.u(16);
        value = r.readBytes(size);
      }
      into.set(i, { key, value });
    }
  };
  for (let t = 0; t < numTables && !r.overflowed; t++) {
    const name = r.str();
    const count = r.u(16);
    const entries = new Map<number, { key: string; value: Uint8Array | null }>();
    readEntries(count, entries);
    if (r.bit() === 1) readEntries(r.u(16), entries);
    tables.push({ name, entries });
  }
  return { tables, endBit: r.pos, overflowed: r.overflowed };
}

/**
 * 从 `userinfo` 字符串表读玩家名，返回**实体号 → 名字**。
 *
 * `userinfo` 的条目键是玩家槽号的十进制串（`"0"`…`"20"`），值是该槽的 `player_info_s`：名字在
 * 偏移 0 处、以 NUL 结尾（最长 32 字节）。引擎把槽 i 的玩家实体放在实体号 `i + 1`，故此处做
 * `+1` 映射，供轨迹命名用。没有 `userinfo` 表或条目无值时返回空表。
 */
/**
 * 从 `player_info_s` 原始字节里取「像玩家名」的首段：最长 32 字节、遇 NUL 截断、且**全部是可打印
 * ASCII 或合法 UTF-8** 才算数（引擎只允许名字含可见字符）。用于在并入字符串表更新前做校验 ——
 * 更新条目流未完全对齐时解出的乱码会被这一步挡住，不会污染已经正确的数据。
 */
function plausibleName(value: Uint8Array): string | null {
  let end = Math.min(32, value.length);
  for (let k = 0; k < end; k++) {
    if (value[k] === 0) {
      end = k;
      break;
    }
  }
  if (end === 0) return null;
  const name = new TextDecoder('utf-8', { fatal: false }).decode(value.subarray(0, end)).trim();
  if (name.length === 0) return null;
  // 可打印性：不允许控制字符（换行/制表等都不该出现在名字里）
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  // 至少含一个字母或数字（纯符号/纯空白不算名字）
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(name)) return null;
  return name;
}

/**
 * 一个玩家的完整信息（按 `player_info_s` 布局解码，布局已用实测逐字段验证）。
 *
 * 验证依据（夹具 `t66-auto-20260902-1519-surf_pools.dem` 槽 0，值长 132 字节）：
 * `name` 落在偏移 0、`userID` 落在偏移 32、`guid` 落在偏移 36 且值为 `BOT` —— 三者与
 * `player_info_s` 的声明偏移逐一吻合，故按同一布局取字段。
 */
export interface DemoPlayerInfo {
  /** 槽号（`userinfo` 的条目键）。 */
  slot: number;
  /** 玩家实体号 = 槽号 + 1（引擎把玩家槽 i 的实体放在 i + 1）。 */
  entityIndex: number;
  /** `name[32]`，偏移 0，NUL 截断。 */
  name: string;
  /** `userID`，偏移 32。 */
  userId: number;
  /** `guid[33]`，偏移 36：机器人是 `BOT`，真人是 `STEAM_x:y:z`。 */
  guid: string;
  /** `guid === 'BOT'`（或 `fakeplayer` 位置位）即为服务器机器人。 */
  isBot: boolean;
}

/**
 * 解出录像里**每个有值的 `userinfo` 条目**的完整玩家信息（见 `DemoPlayerInfo` 的字段偏移依据）。
 * 与 `readPlayerNames` 的区别：后者只取名字并做过滤，本函数把 `userID` / `guid` / 是否机器人
 * 一并取出来，供面板展示「录像里到底有哪些玩家、是不是真人」。
 */
export function readPlayerInfos(tables: DemoStringTable[]): DemoPlayerInfo[] {
  const ui = tables.find((t) => t.name === 'userinfo');
  if (!ui) return [];
  const out: DemoPlayerInfo[] = [];
  const dec = new TextDecoder('utf-8', { fatal: false });
  for (const [i, e] of ui.entries) {
    const v0 = e.value;
    if (!v0 || v0.length < 40) continue;
    const slot = Number.isFinite(Number(e.key)) ? Number(e.key) : i;
    // **一个条目里可能塞着多条 `player_info_s`**：实测 `userinfo` 更新条目的 userdata 是
    // **1056 字节 = 8 × 132**（132 正是逐字段验证过的单条记录长度）。早先整段当成**一条**读，
    // 于是只能读出第一条、且字段错位 —— 这就是"名字只有 1～2 个"的直接原因。
    // 这里按 132 字节切分，逐条解；不足 132 的按单条处理（签入期槽 0 就是恰好 132）。
    const chunks: Array<{ off: number; len: number }> = [];
    if (v0.length > RECORD_BYTES && v0.length % RECORD_BYTES === 0) {
      for (let off = 0; off < v0.length; off += RECORD_BYTES) chunks.push({ off, len: RECORD_BYTES });
    } else {
      chunks.push({ off: 0, len: v0.length });
    }
    for (let ci = 0; ci < chunks.length; ci++) {
      const { off } = chunks[ci];
      const v = v0.subarray(off, off + chunks[ci].len);
      const cstr = (from: number, max: number): string => {
        let end = Math.min(from + max, v.length);
        for (let k = from; k < end; k++) {
          if (v[k] === 0) {
            end = k;
            break;
          }
        }
        return dec.decode(v.subarray(from, end)).trim();
      };
      const guid = cstr(36, 32);
      const name = cstr(0, 32);
      if (name.length === 0) continue;
      // 可打印性：名字里不该有控制字符（切分错的块会被这一步挡住）
      let printable = true;
      for (let k = 0; k < name.length; k++) {
        const c = name.charCodeAt(k);
        if (c < 0x20 || c === 0x7f) {
          printable = false;
          break;
        }
      }
      if (!printable) continue;
      const slotNo = slot + ci;
      out.push({
        slot: slotNo,
        entityIndex: slotNo + 1,
        name,
        userId: (v[32] | (v[33] << 8) | (v[34] << 16) | (v[35] << 24)) >>> 0,
        guid,
        isBot: guid.toUpperCase() === 'BOT' || v[100] === 1,
      });
    }
  }
  return out;
}

/** 单条 `player_info_s` 的字节数（`name[32] + userID + steamID[32] + extra + friendsID + friendsName[32]
 *  + 三个 1 字节标志 + customFile[4] + filesDownloaded + moreExtra`）—— 与签入期槽 0 实测的 132 一致。 */
const RECORD_BYTES = 132;


/**
 * 从 `player_info_s` 的 `name[32]` 里取出**干净的名字**。
 *
 * 为什么需要清洗：本工程解出的 `userinfo` 条目里，部分条目（如槽 1）的 userdata **整体错位若干
 * 字节**，`name` 字段前会混入非打印字节（实测形如 `"\uFFFD\uFFFD励关4 21.849 | LuoXuan"`）。
 * 直接展示会把乱码一起显示出来。做法是**取最长的可打印 ASCII/UTF-8 连续段**；若首段不可打印而
 * 第 9 字节起（`offsetAlt`）才是名字（错位 8 字节时的偏移），则回退用后者。
 *
 * 注意：这是**展示层清洗**，不改变「条目本身错位」这个事实 —— 该事实已在面板脚注里如实写明。
 */
function cleanPlayerName(raw: string, offsetAlt: string): string {
  const pick = (s: string): string => {
    let best = '';
    let cur = '';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      const printable = c >= 0x20 && c !== 0x7f;
      if (printable) {
        cur += ch;
        if (cur.length > best.length) best = cur;
      } else {
        cur = '';
      }
    }
    return best.trim();
  };
  const a = pick(raw);
  const b = pick(offsetAlt);
  // 取更长的那个可打印段；并列时用原偏移（不做无谓改动）
  return b.length > a.length ? b : a;
}



export function readPlayerNames(tables: DemoStringTable[]): Map<number, string> {
  // 复用 readPlayerInfos（同一份数据、同一套 132 字节切分规则），避免两处逻辑漂移。
  const out = new Map<number, string>();
  for (const p of readPlayerInfos(tables)) {
    if (p.name.length > 0) out.set(p.entityIndex, p.name);
  }
  return out;
}

/** 一张演示录像内嵌字符串表。 */
export interface DemoStringTable {  name: string;
  /** 条目序号 → 键与值（值多为类别的属性基线位流）。 */
  entries: Map<number, { key: string; value: Uint8Array | null }>;
}

/** 消息链上的一条记录。 */
interface DemoMessage {
  cmd: number;
  tick: number;
  /** 消息在字节流中的起始偏移。 */
  offset: number;
  /** 载荷起始位（相对整份文件）。 */
  payloadBit: number;
  /** 载荷位数（仅 datatables / stringtables / packet 类有效）。 */
  payloadBits: number;
  /** 载荷字节数（`dem_signon` / `dem_packet` 的包长字段）。 */
  payloadBytes: number;
}

/** 按 cmd 走一遍消息链，返回全部记录（不解析载荷内容，只按长度跳过）。 */
function scanMessages(bytes: Uint8Array, dv: DataView, stats: DemoParseStats): DemoMessage[] {
  const out: DemoMessage[] = [];
  let p = DEMO_HEADER_BYTES;
  const readCString = (from: number): number => {
    let i = from;
    while (i < bytes.length && bytes[i] !== 0) i++;
    return i + 1;
  };
  while (p + 5 <= bytes.length) {
    const offset = p;
    const cmd = bytes[p++];
    const tick = dv.getInt32(p, true);
    p += 4;
    if (cmd < 1 || cmd > 8) {
      stats.warnings.push(`消息链 @${offset}：未知命令 ${cmd}，停止扫描`);
      break;
    }
    let payloadBit = p * 8;
    let payloadBits = 0;
    let payloadBytes = 0;
    if (cmd === 1 || cmd === 2) {
      // 文件被截断（或长度字段损坏）时不能越界读：截断处按「到此为止」处理并记一条 warning，
      // 而不是抛 RangeError —— 调用方拿到的是可用的部分结果 + 明确说明。
      if (p + DEMO_CMDINFO_BYTES + 12 > bytes.length) {
        stats.warnings.push(`消息链 @${offset}：文件在 cmd=${cmd} 的消息头处截断，停止扫描`);
        break;
      }
      p += DEMO_CMDINFO_BYTES + 8; // democmdinfo + seqIn/seqOut
      const len = dv.getInt32(p, true);
      p += 4;
      const end = p + len;
      if (len < 0 || end > bytes.length) {
        stats.warnings.push(
          `消息链 @${offset}：载荷长度 ${len} 超出文件剩余 ${bytes.length - p} 字节（文件被截断），停止扫描`,
        );
        break;
      }
      payloadBit = p * 8;
      payloadBits = len * 8;
      payloadBytes = len;
      if (len < 0 || p + len > bytes.length) {
        stats.warnings.push(`消息链 @${offset}：包长 ${len} 越界，停止扫描`);
        break;
      }
      p += len;
    } else if (cmd === 6 || cmd === 8) {
      const len = dv.getInt32(p, true);
      p += 4;
      payloadBit = p * 8;
      payloadBits = len * 8;
      payloadBytes = len;
      if (len < 0 || p + len > bytes.length) {
        stats.warnings.push(`消息链 @${offset}：${cmd === 6 ? 'datatables' : 'stringtables'} 长度 ${len} 越界，停止扫描`);
        break;
      }
      p += len;
    } else if (cmd === 4) {
      p = readCString(p);
    } else if (cmd === 5) {
      p += 4;
      const len = dv.getInt32(p, true);
      p += 4;
      // 诊断：dem_usercmd 的载荷长度 —— 它就是 usercmd（含 `buttons` 按键位）。
      usercmdDiag.count++;
      if (len > usercmdDiag.maxLen) usercmdDiag.maxLen = len;
      if (usercmdDiag.samples.length < 12) usercmdDiag.samples.push(len);
      p += Math.max(0, len);
    }
    out.push({ cmd, tick, offset, payloadBit, payloadBits, payloadBytes });
    if (cmd === 7) break; // dem_stop
  }
  return out;
}

/** 玩家类判据：类别名以 `Player` 结尾或等于 `CCSPlayer`。 */
export function isPlayerClass(className: string): boolean {
  return /Player$/.test(className) || className === 'CCSPlayer';
}

/** 在每个 `svc_PacketEntities` 之后把当前玩家位姿记入轨迹表（按需创建轨迹）。 */
/** 玩家采样诊断计数（定位「为什么没有轨迹」用）。 */
export interface PlayerSampleDiag {
  /** 诊断：字符串表**更新映射**的键与条目数（`svc_UpdateStringTable` 的落点）。 */
  updateMap: string[];
  /** 诊断：`userinfo` 更新条目的原始 userdata 前 48 字节（十六进制）。 */
  userinfoUpdateHex: string[];
  /** 诊断：`表号 → 表名` 的映射序列。 */
  idNames: string[];
  /** 见过的玩家实体号。 */
  playerEntities: Set<number>;
  /** 各属性名被采样到的 tick 次数。 */
  propTicks: Map<string, number>;
  /** `m_vecOrigin` 是三元数组的次数。 */
  originOk: number;
  /** `m_angEyeAngles[0]` 是数值的次数。 */
  /** 诊断：`CCSPlayerResource` 实体号 → 与名字/队伍相关的属性键。 */
  playerResource: Map<number, string[]>;
  /** 诊断：字符串表更新映射的键与条目数。 */
  stringTableSizes: string[];
  yawOk: number;
  /** `m_angEyeAngles[1]` 是数值的次数。 */
  pitchOk: number;
  /** 每个属性名最后一次解出的值（诊断用）。 */
  lastValue: Map<string, unknown>;
}

/** 玩家采样诊断计数（定位「为什么没有轨迹」用）。 */
export function newPlayerSampleDiag(): PlayerSampleDiag {
  return {
    playerEntities: new Set(),
    propTicks: new Map(),
    originOk: 0,
    yawOk: 0,
    pitchOk: 0,
    playerResource: new Map(),
    updateMap: [],
    userinfoUpdateHex: [],
    idNames: [],
    stringTableSizes: [],
    lastValue: new Map(),
  };
}

/**
 * 取该实体的世界坐标。玩家类有**两份** `m_vecOrigin`：`DT_CSLocalPlayerExclusive` 的那份只发给
 * 该玩家自己（`SPROP_NOSCALE`，原始 32 位浮点），`DT_CSNonLocalPlayerExclusive` 的那份发给其他所有
 * 观察者（`SPROP_COORD`，定点坐标）。录像由 SourceTV 录制，应当取后者，故优先挑带 `SPROP_COORD` 的项。
 */
/**
 * 取实体的有效属性值：先看本帧 delta 写过的项，没有再退回该类基线（引擎的「基线整表 + 本帧
 * delta」两段式——基线不整表复制进每个实体，只在取值时兜底，见 `decodePacketEntities` 注释）。
 */
function effectiveProp(ctx: NetContext, classId: number, props: EntityProps, key: string): unknown {
  return props.has(key) ? props.get(key) : ctx.baselineProps(classId).get(key);
}

function pickOrigin(props: EntityProps, ctx: NetContext, classId: number): unknown {
  const flat = ctx.flatFor(classId);
  // `m_vecOrigin` 在三张表里各有一份：`DT_CSPlayer`（基础定义）、`DT_CSLocalPlayerExclusive`（**本机
  // 玩家**自己的坐标）、`DT_CSNonLocalPlayerExclusive`（**其他玩家**的坐标）。引擎按客户端**只发其中
  // 一份**。本工程处理的是 **SourceTV 录像，视角不属于任何玩家，因此所有玩家都是"非本机"** ——
  // 引擎下发的就是 `DT_CSNonLocalPlayerExclusive` 那一份。参考实现同样是对两张表各查一次
  //（`tf2-demo-parser` 的 `gamestateanalyser.rs`：`DT_TFLocalPlayerExclusive` / `DT_TFNonLocalPlayerExclusive`）。
  // 早先只按 `SPROP_COORD` 过滤、**不看所属表**，可能挑中 Local 那份 —— 位置就此读错（实测玩家槽位
  // 实体的包围盒退化成轴对齐直线、三个实体完全相同）。
  const rank = (owner: string): number =>
    /NonLocalPlayerExclusive/i.test(owner) ? 0 : /LocalPlayerExclusive/i.test(owner) ? 1 : 2;
  const cands = flat
    .filter((f) => f.prop.name === 'm_vecOrigin')
    .sort((a, b) => rank(a.ownerTable) - rank(b.ownerTable));
  if (isWorldVec(effectiveProp(ctx, classId, props, 'm_vecOrigin'))) {
    for (const f of cands) {
      const v = effectiveProp(ctx, classId, props, `m_vecOrigin#${f.index}`);
      if (isWorldVec(v)) return v;
    }
  }
  const fallback = effectiveProp(ctx, classId, props, 'm_vecOrigin');
  return isWorldVec(fallback) ? fallback : undefined;
}

/**
 * 世界坐标合理性判定：Source 的世界坐标被 `MIN_COORD_INTEGER..MAX_COORD_INTEGER`（±16384）限定，
 * 故三元数组且各分量有限、绝对值不超过 32768 才算有效。用途是把「某个下标被解错一次」产生的
 * 天文数字挡在轨迹之外——实体属性表是跨 tick 累积的，一次坏值会永久污染该实体的坐标。
 */
function isWorldVec(v: unknown): v is [number, number, number] {
  if (!Array.isArray(v) || v.length < 3) return false;
  for (let i = 0; i < 3; i++) {
    const x = v[i];
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 32768) return false;
  }
  return true;
}

/**
 * 位姿采样：把当前 tick 的实体位姿追加到轨迹上。
 *
 * `mode` 取 `'players'` 时只采玩家类；取 `'posed'` 时采任何「同时有世界坐标与朝向」的实体
 * （朝向优先取 `m_angEyeAngles`，退回 `m_angRotation`），用于在没有玩家运动的录像里验证
 * 坐标/朝向通路，也用于给道具/机关建轨迹。
 */
export function samplePlayers(
  ctx: NetContext,
  dt: DataTables,
  tick: number,
  tracks: PlayerTrack[],
  diag?: PlayerSampleDiag,
  mode: 'players' | 'playerPosed' | 'posed' = 'players',
): void {
  for (const [entityIndex, classId] of ctx.entityClass) {
    const cls = dt.classes.find((c) => c.id === classId);
    if (!cls) continue;
    if (mode !== 'posed' && !isPlayerClass(cls.name)) continue;
    // 玩家槽位过滤：Source 的玩家实体号恒落在 `1..MAX_PLAYERS`（按服务器最大人数，取 64 为上限）。
    // 实测真录像里 `CCSPlayer` / `CBasePlayer` 会出现在 #78、#120、#147、#196、#225 这类远超槽位的
    // 实体号上——那些不可能是玩家（玩家必然占 1..N 的槽位），是「实体号 → 类别」误判的产物。
    // 不过滤的话，viewer 里会列出「一堆站着不动的玩家」，把真正的玩家淹没掉。
    if (mode !== 'posed' && (entityIndex < 1 || entityIndex > MAX_PLAYER_SLOT)) continue;
    const props = ctx.entityProps.get(entityIndex);
    if (!props) continue;
    if (diag) {
      diag.playerEntities.add(entityIndex);
      for (const [k, v] of props) {
        diag.propTicks.set(k, (diag.propTicks.get(k) ?? 0) + 1);
        diag.lastValue.set(k, v);
      }
    }
    const origin = pickOrigin(props, ctx, classId);
    // 视角：`m_angEyeAngles` 是「向量元素组」合并后的一项（元素 0 = 俯仰，元素 1 = 偏航）；
    // 若展平未合并则退回 `m_angEyeAngles[0]` / `[1]` 两个独立属性名；再退回 `m_angRotation`。
    const eye = effectiveProp(ctx, classId, props, 'm_angEyeAngles');
    const rot = effectiveProp(ctx, classId, props, 'm_angRotation');
    const yaw = Array.isArray(eye)
      ? eye[1]
      : typeof effectiveProp(ctx, classId, props, 'm_angEyeAngles[1]') === 'number'
        ? effectiveProp(ctx, classId, props, 'm_angEyeAngles[1]')
        : Array.isArray(rot)
          ? rot[1]
          : undefined;
    const pitch = Array.isArray(eye)
      ? eye[0]
      : typeof effectiveProp(ctx, classId, props, 'm_angEyeAngles[0]') === 'number'
        ? effectiveProp(ctx, classId, props, 'm_angEyeAngles[0]')
        : Array.isArray(rot)
          ? rot[0]
          : undefined;
    if (diag) {
      if (Array.isArray(origin)) diag.originOk++;
      if (typeof yaw === 'number') diag.yawOk++;
      if (typeof pitch === 'number') diag.pitchOk++;
    }
    if (!Array.isArray(origin) || origin.length < 3) continue;
    // 朝向要求按口径区分：
    // - `players`    必须有朝向（目标里「拿到不同人的移动朝向」要的就是它，缺朝向不算数）；
    // - `playerPosed` 只要**玩家类** + 有坐标即可，朝向缺失记 0 —— 实测真录像里玩家类实体常常只下发
    //   `m_vecOrigin` 而 `m_angEyeAngles` 极少下发（空服录像 0 次、真录像直方图里也仅个位数），
    //   若坚持要朝向，玩家轨迹会**整条消失**、只剩各种服务器实体；该口径保证至少能看到真人走位；
    // - `posed`      任何有坐标的实体（含非玩家），朝向缺失记 0。
    const hasAng = typeof yaw === 'number' && typeof pitch === 'number';
    if (!hasAng && mode === 'players') continue;
    // 角度归一化到 (-180, 180]：线上角度按 0..360 编码，负角会以 ~350/~360 出现。
    // 不归一化时播放会在 10° 与 360° 之间插值、扫过 90°（表现为「垂直朝下看」）——
    // 实测 #3 有 23415 帧落在 |pitch| > 88，其中绝大多数来自这种绕回而非真实俯角。
    const norm = (a: number): number => {
      const m = a % 360;
      return m > 180 ? m - 360 : m <= -180 ? m + 360 : m;
    };
    const yawV = hasAng ? norm(yaw as number) : 0;
    const pitchV = hasAng ? norm(pitch as number) : 0;
    let track = tracks.find((t) => t.entityIndex === entityIndex);
    if (!track) {
      track = { entityIndex, classId, className: cls.name, dtName: cls.dtName, samples: [] };
      tracks.push(track);
    }
    const num = (k: string): number | null => {
      const v = props.get(k);
      return typeof v === 'number' ? v : null;
    };
    track.samples.push({
      tick,
      pos: [origin[0], origin[1], origin[2]],
      yaw: yawV,
      pitch: pitchV,
      health: num('m_iHealth'),
      team: num('m_iTeamNum'),
      lifeState: num('m_lifeState'),
    });
  }
}
