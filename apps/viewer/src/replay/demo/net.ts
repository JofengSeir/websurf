/**
 * `.dem` 包内的网络消息解析与实体 delta 解码。
 *
 * 一个 `dem_signon` / `dem_packet` 消息的载荷就是一段**串接的网络消息流**：每条消息以 6 位类型号
 * 开头（`NETMSG_TYPE_BITS = 6`），其后各消息自有布局。本文件只实现到「能拿到玩家位置与朝向」为止：
 * 需要的消息精确解析，不需要的按各自长度跳过——跳过的长度同样必须精确，否则后续消息会错位。
 *
 * 实现的消息（类型号见 `NetMsgType`）：服务端信息、类别信息、字符串表建/改、包实体、
 * 游戏事件表/事件、用户消息、以及一批定长控制消息。任何未列出或解析失败的消息会让本次包解析
 * 中止（游标丢弃、保留上一帧实体状态），并把原因记入 `DemoParseStats.warnings`。
 *
 * 实体解码（`decodePacketEntities`）：
 * 1. 载荷位流按「属性位图」描述被改动的属性。位图读取器状态为「当前属性下标」：
 *      读 1 位 = 0 → 下标 +1；= 1 → 下标 = `uBitVar()` + 1（跳读）。
 * 2. 每条实体记录：
 *      索引增量：读 1 位 = 0 → 实体号 +1；= 1 → 实体号 = `uBitVar()`；
 *      更新类型：2 位（0 = 离开 PVS、1 = 进入 PVS、2 = 保留、3 = 增量更新）；
 *      进入 PVS 时再读类别号（`classIdBits` 位）与序号（10 位）；
 *      离开 PVS 无属性位图；
 *    增量/进入时按属性位图逐项读值。
 * 3. 读到的值写回该实体的属性表（进入 PVS 时以类别基线重建，增量时在旧值上覆盖）。
 *
 * 属性值解码规则（`decodeProp`，与 `test/project/source-sdk-2013-master` 的
 * `src/public/dt_send.cpp` 里 `SendPropFloat` / `SendPropInt` 的写入侧约定对应）：
 * - 整数：`SPROP_VARINT`（复用 `SPROP_NORMAL` 位）= `uBitVar()`；否则按 `SPROP_UNSIGNED`
 *   选读无符号/有符号定长位；
 * - 浮点：`SPROP_COORD*` 家族 → 定点坐标；`SPROP_NOSCALE` 或 `numBits` 为 0/32 → 原始 32 位；
 *   其余按 `low + raw / (iHigh / (high − low))` 反量化（`iHigh = 2^bits − 1`，倍数按 float32 计）；
 * - 向量：`SPROP_NORMAL` → 三轴法线；`SPROP_COORD` → 三轴存在位 + 各轴定点坐标；否则三轴按浮点规则；
 * - `VectorXY` 只发两轴；`String` 为 9 位长度 + 字节；`Array` 为 `numElements` 个元素值。
 */

import { BitReader } from './bits.js';
import {
  PropType,
  SPROP,
  flattenSendTable,
  type DataTables,
  type FlatProp,
  type SendProp,
} from './tables.js';

/**
 * 网络消息类型号（`net_*` 0..6，`svc_*` 自 7 起）。
 *
 * 与常见「CS:GO 编号表」的差异（本表按协议 24 取值）：
 * - 协议 24 **没有** `net_SplitScreenUser`，7 号就是 `svc_Print`；
 * - 16 号是 `svc_HLTV`、22 号是 `svc_TerrainMod`，两者本工程不解析（遇到即中止该包）；
 * - 32 号 `svc_CmdKeyValues` 只存在于后期引擎，协议 24 的 `SVC_LASTMSG` 为 31。
 */
export const enum NetMsgType {
  Nop = 0,
  Disconnect = 1,
  File = 2,
  Tick = 3,
  StringCmd = 4,
  SetConVar = 5,
  SignonState = 6,
  Print = 7,
  ServerInfo = 8,
  SendTable = 9,
  ClassInfo = 10,
  SetPause = 11,
  CreateStringTable = 12,
  UpdateStringTable = 13,
  VoiceInit = 14,
  VoiceData = 15,
  HLTV = 16,
  Sounds = 17,
  SetView = 18,
  FixAngle = 19,
  CrosshairAngle = 20,
  BSPDecal = 21,
  TerrainMod = 22,
  UserMessage = 23,
  EntityMessage = 24,
  GameEvent = 25,
  PacketEntities = 26,
  TempEntities = 27,
  Prefetch = 28,
  Menu = 29,
  GameEventList = 30,
  GetCvarValue = 31,
}

/** 位宽常量（`netcontants.h`）。 */
const MAX_EDICT_BITS = 11;
/** 实体号真上限（1 << MAX_EDICT_BITS）—— 越界判据用它，不用消息头里的 maxEntries。 */
const MAX_EDICT_COUNT = 1 << MAX_EDICT_BITS;
const MAX_SERVER_CLASS_BITS = 9;
const MAX_DECAL_INDEX_BITS = 9;
const MAX_EVENT_BITS = 9;
const EVENT_INDEX_BITS = 8;
const MAX_SOUND_INDEX_BITS = 14;
const MAX_SOUND_INDEX_BITS_OLD = 13;
const DELTASIZE_BITS = 20;
const SP_MODEL_INDEX_BITS = 11;
/** 字符串表数量上限对应的表号位宽：`log2(MAX_TABLES)` = 5。 */
const MAX_TABLES = 32;
/** 字符串表条目 userdata 的最大位宽（引擎 `MAX_USERDATA_BITS`）。 */
const MAX_USERDATA_BITS = 14;
/** 留档的文本消息条数上限（`NetContext.chatLines`）。 */
const CHAT_LINE_LIMIT = 4000;
/** 单条字符串表更新最多读取的条目数（数据段另有位长上限，这里只是防御性上限）。 */
const MAX_UPDATE_ENTRIES = 512;

/** 一条实体的属性快照（属性名 → 值）。 */
/** 实体号越界警告的逐条上限；超过只累加 `DemoParseStats.entityOverflow`（见越界分支注释）。 */
const OVERFLOW_WARN_LIMIT = 20;

export type EntityProps = Map<string, number | number[] | string>;
/** 一次 `.dem` 解析的统计与诊断。 */
export interface DemoParseStats {
  /** 解析成功的包数。 */
  packetsParsed: number;
  /** 解析中途失败（消息布局不符/越界）的包数。 */
  packetsFailed: number;
  /** 每个「导致整包放弃」的消息号出现次数（诊断用）。 */
  failureByType: Record<string, number>;
  /** 每个消息号被成功处理的次数（诊断用）。 */
  seenByType: Record<string, number>;
  /** 累计的 `svc_PacketEntities` 消息数。 */
  entityMessages: number;
  /** 累计的实体更新记录数。 */
  entityUpdates: number;
  /** 实体载荷位流恰好用尽声明位数的消息数（解码正确性的强判据）。 */
  entityPayloadExact: number;
  /** 实体载荷未能恰好用尽声明位数的消息数。 */
  entityPayloadMismatch: number;
  /** 类别未知（未见过 EnterPVS）而导致本消息剩余实体被跳过的次数。 */
  entityUnknownClass: number;
  /** 实体号越界次数（含被限量抑制的部分）。 */
  entityOverflow: number;
  /**
   * **多读**了声明位数的消息数（`实读 > 声明`）。这是当前的核心错误指标。
   *
   * 为什么不是「恰好用尽」：实测 24 条 64 位消息的载荷**尾部存在变长填充**（低位大量为 0、
   * 且尾部前 8 位呈现逐包 +1 的计数形态），因此「解完恰好用尽 `length`」**不是**正确解析的必要
   * 条件 —— 正确解析应表现为**残差 ≥ 0**（少读的是填充）。真该清零的是**负残差**（多读）。
   */
  entityOverread: number;
  /**
   * 实体循环的退出原因计数：`guard`（剩余位不足一条最小实体头）/ `overflowBreak`（实体号越界且开着中断）
   * / `readerOverflow`（`BitReader.overflowed` 被置位）/ `count`（读满配额或配额即 `numUpdated`）。
   * 用途：判断循环究竟被谁截断——`untilEnd` 与 `count` 给出几乎相同结果时，这是唯一的分辨手段。
   */
  loopExit: Map<string, number>;
  /** 残差直方图：`声明位数 − 实读位数` → 出现次数（诊断「固定尾巴」还是「逐实体漂移」）。 */
  entityResidual: Map<number, number>;
  /** 残差直方图（仅全量更新 `isDelta = false`）——用于判定漂移是否只发生在增量消息里。 */
  entityResidualFull: Map<number, number>;
  /** 恰好用尽的消息数（仅全量更新）。 */
  entityExactFull: number;
  /** 恰好用尽的消息数（仅增量更新）。 */
  entityExactDelta: number;
  /**
   * 残差直方图（仅 `updatedEntries === 1` 的消息）。用途：区分「每条消息固定漏一段」与
   * 「每条实体记录少读若干位」——前者在单实体消息上残差仍很大，后者会缩到很小的常数。
   */
  entityResidualUpd1: Map<number, number>;
  /** `dem_stringtables` 解析终点（位，相对该消息载荷起点）。 */
  stringTableEndBit: number;
  /** `dem_stringtables` 载荷字节数。 */
  stringTableBytes: number;
  /** 非致命问题文本（去重后建议只取前若干条展示）。 */
  warnings: string[];
}

/** 解析上下文：发送表、类别、字符串表、实体表都在这里累积。 */
export class NetContext {
  /** 每类别展平后的属性序列（按需缓存）。 */
  private readonly flatByClass = new Map<number, FlatProp[]>();
  /** 实体号 → 类别 id。 */
  readonly entityClass = new Map<number, number>();
  /** 实体号 → 属性快照。 */
  readonly entityProps = new Map<number, EntityProps>();
  /** 字符串表：表名 → 序号 → 值。 */
  readonly stringTables = new Map<string, Map<number, { key: string; value: Uint8Array | null }>>();
  /** 各字符串表的 `maxEntries`（`svc_CreateStringTable` 头部的 u16）——更新条目时用它定下标位宽。 */
  readonly stringTableMaxEntries = new Map<string, number>();
  /** 留档的文本消息（`svc_Print` / `svc_StringCmd` / `svc_Disconnect`），容量见 `CHAT_LINE_LIMIT`。 */
  readonly chatLines: string[] = [];
  /**
   * 字符串表**序号 → 表名**（按 `dem_stringtables` 的创建顺序）。
   *
   * 用途：`svc_UpdateStringTable` 只给**表号**，而 `dem_stringtables` 给的是**表名**。早先的实现直接用
   * `ctx.stringTables` 的键序当表名（那些键其实是 `svc_CreateStringTable` 写进去的数字串），于是更新
   * 全部落进了一张与 `dem_stringtables` **互不相干**的表里 —— 中途加入的玩家名字因此一条也读不到。
   */
  stringTableIdNames: string[] = [];
  /** 诊断直方图：「类别 id:扁平下标」→ 引擎实际下发次数。 */
  readonly indexHistogram = new Map<string, number>();
  /** 类别基线原始位流：类别 id → `instancebaseline` 的条目值（由演示解析层灌入）。 */
  readonly baselineBlobs = new Map<number, Uint8Array>();
  /** 已解码的类别基线（按类别缓存）。 */
  private readonly baselineCache = new Map<number, EntityProps>();
  /** 当前包号（诊断用）。 */
  packetIndex = 0;
  /**
   * 属性位图的极性（见 `readPropList`）：`false` = 协议 24 的方案（0 = 位图结束，1 = 下标推进
   * `1 + uBitVar`），`true` = 对照用的 CS:GO 风格极性。缺省取协议 24 方案。
   */
  legacyPropOrder = false;
  /**
   * 服务器类别号的位宽 = `Q_log2(maxClasses) + 1`，`maxClasses` 由 `svc_ServerInfo` 给出
   * （缺省退回类别表长度推算）。
   */
  classIdBits = 0;
  /**
   * `svc_CreateStringTable` 是否带 `m_bDataCompressed` 位（引擎读侧在演示协议 > 14 时读它，
   * 而经实测的 CS:S 解析器 demboyz 不读）。缺省关闭，诊断开关可打开对照。
   */
  readCompressedFlag = false;
  /** 诊断开关：实体号 = `基准 + entityIndexPlusOne?1:0 + uBitVar`。 */
  entityIndexPlusOne = true;
  /**
   * 进入 PVS 时类别号之后的序号位数。引擎读侧为
   * `ReadUBitLong(NUM_NETWORKED_EHANDLE_SERIAL_NUMBER_BITS)` = 10 位，写侧
   * `WriteUBitLong(serialNumber, 10)`。
   */
  enterSerialBits = 10;
  /** 诊断开关：覆盖类别号位宽（0 = 用 ServerInfo 推得的位宽）。 */
  classIdBitsOverride = 0;
  /** 诊断开关：实体号基准初值（引擎 `m_nHeaderBase`）。 */
  headerBaseInit = -1;
  /** 诊断开关：类别号之前的额外位数。 */
  preClassBits = 0;
  /** 诊断开关：类别号之后的额外位数。 */
  postClassBits = 0;
  /** 诊断开关：类别号与序号之间的额外位数。 */
  preSerialBits = 0;
  /** 诊断开关：`svc_PacketEntities` 头部里实体号字段的位宽（缺省 `MAX_EDICT_BITS`）。 */
  edictBits = MAX_EDICT_BITS;
  /** 诊断开关：`maxEntries` 字段位宽（0 = 用 `edictBits`）。 */
  maxEntriesBits = 0;
  /** 诊断开关：`updatedEntries` 字段位宽（0 = 用 `edictBits`）。 */
  updatedEntriesBits = 0;
  /**
   * 实体号越界时是否中断整段实体流。**缺省中断**：`maxEntries` 这个上限虽从未被独立事实校验，
   * 但实测关闭它会让实体流一路狂读、包解析率从 3435/3438 掉到 1377/3438（自检「DEM 包解析率」
   * 会红）——所以它当前是**保持包层可用**的必要守卫，不是正确性保障。等实体头构成定死后应重新评估。
   */
  breakOnEntityOverflow = true;
  /** 诊断用：非 null 时把每条消息的「类型 + 起止位」追加进来（生产路径不设）。 */
  trace: string[] | null = null;
  /** 诊断计数：已留痕的单实体增量消息数。 */
  traceSingleEnt = 0;
  /** 诊断标记：是否已留痕过「首次实体号越界」。 */
  overflowTraced = 0;
  /** 诊断计数：已留痕的记录越界次数（见 `[OVERRUN]`）。 */
  overrunTraced = 0;
  /** 诊断计数：已留痕的近失配消息数（见 `[NEAR]`）。 */
  nearMissTraced = 0;
  /** 诊断计数：已留痕的字符串表更新消息数（见 `[UPD]`）。 */
  updateTraced = 0;
  /** 诊断计数：已留痕的极小 PE 消息数（见 `[SMALLPE]`）。 */
  smallPeTraced = 0;
  /**
   * 诊断：每条实体记录的属性列表之后额外跳过的位数（可负）。缺省 0（生产路径）。
   * 用于一维搜索「第 1 条记录到底该占多少位」——实测第 1 条永远合法、第 2 条永远越界。
   */
  propListPadBits = 0;
  /**
   * 实体循环的终止口径：`'count'` = 读 `updatedEntries` 条（实现依据见 `readPacketEntities` 注释）；
   * `'untilEnd'` = 一直读到 `dataStart + length` 为止。
   *
   * 判据（单实体增量样本，64 位载荷）：按 `'count'` 读只走到第 37 位、余 27 位；按 `'untilEnd'` 读恰好
   * 落在第 64 位——载荷里实际是**四条实体头**（`DeltaEnt` / `DeltaEnt` / `LeavePVS+DELETE` / `LeavePVS`）
   * 加 1 位删除表结束位。故 `'untilEnd'` 与位流一致。
   */
  entityLoopMode: 'count' | 'untilEnd' = 'count';

  /** 诊断开关：展平选项（见 demo/tables.ts 的 FlattenOptions）。 */
  flattenOptions: { childFirst?: boolean; stablePriority?: boolean; includeInsideArray?: boolean; emitDataTableProps?: boolean } = {};

  constructor(readonly dataTables: DataTables) {}

  /** 取某类别展平后的属性序列（缓存）。类别不存在时返回空序列。 */
  flatFor(classId: number): FlatProp[] {
    let f = this.flatByClass.get(classId);
    if (f) return f;
    const cls = this.dataTables.classes.find((c) => c.id === classId);
    f = cls ? flattenSendTable(cls.dtName, this.dataTables.tables, this.flattenOptions) : [];
    this.flatByClass.set(classId, f);
    return f;
  }

  /**
   * 取某类别的**基线属性表**（`instancebaseline`）。引擎在实体进入 PVS 时是「先按该类基线整表
   * 赋值，再叠加本帧 delta」两段式，本方法提供前一段。首次调用解码并缓存（按类别，全录像共用）；
   * 返回的是缓存本身，调用方要改必须先复制（`decodePacketEntities` 即 `new Map(...)`）。
   */
  baselineProps(classId: number): EntityProps {
    const cached = this.baselineCache.get(classId);
    if (cached) return cached;
    const props: EntityProps = new Map();
    const blob = this.baselineBlobs.get(classId);
    const flat = blob ? this.flatFor(classId) : [];
    if (blob && flat.length > 0) {
      const r = new BitReader(blob, 0, blob.length * 8);
      readPropList(r, flat, props, false);
    }
    this.baselineCache.set(classId, props);
    return props;
  }
}

/** 解析一个包（`dem_signon` / `dem_packet` 的载荷）中的全部网络消息。 */
export function parsePacket(bytes: Uint8Array, ctx: NetContext, stats: DemoParseStats): void {
  const r = new BitReader(bytes);
  const limit = bytes.length * 8;
  let ok = true;
  while (r.pos < limit && !r.overflowed) {
    // 包尾按字节对齐会留下 0..7 位填充；剩余不足一条消息头或全为 0 即视为结束
    if (limit - r.pos < 6 || restIsZero(r, limit)) break;
    const before = r.pos;
    const type = r.u(6);
    try {
      ok = dispatch(type, r, ctx, stats);
    } catch (e) {
      stats.warnings.push(`包 ${ctx.packetIndex}：消息 ${type} 解析异常（${errText(e)}）`);
      ok = false;
    }
    if (ok) stats.seenByType[`${type}`] = (stats.seenByType[`${type}`] ?? 0) + 1;
    if (ctx.trace) ctx.trace.push(`type=${type} @${before}..${r.pos} ok=${ok}`);
    if (!ok) {
      const key = `${type}`;
      stats.failureByType[key] = (stats.failureByType[key] ?? 0) + 1;
      break;
    }
    if (r.pos === before) {
      stats.warnings.push(`包 ${ctx.packetIndex}：消息 ${type} 未消耗任何位，放弃该包`);
      ok = false;
      break;
    }
  }
  if (ok && !r.overflowed) stats.packetsParsed++;
  else {
    stats.packetsFailed++;
    if (r.overflowed) stats.warnings.push(`包 ${ctx.packetIndex}：位流越界`);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `SayText2` 载荷 → 可读文本（`dispatch` 的 UserMessage 分支用，CS:S 用户消息号 4）。
 *
 * 载荷内串按字节组织、但消息起点是任意位偏移，故首段解出的可能是残余位——好在那是
 * 少量控制/非打印字节，落在控制字节边界上被切掉；`\x07` 后固定 6 字节颜色码（丢弃），
 * 其余 <0x20 的控制字节替换为单个空格，正文按 UTF-8 解码（玩家名与聊天含多字节字符）。
 */
function decodeSayText2(bytes: Uint8Array): string {
  const dec = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let run: number[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      out += dec.decode(new Uint8Array(run));
      run = [];
    }
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20) {
      flush();
      if (b === 7) {
        i += 6; // `\x07` + 6 字节 RGB 颜色码，整段丢弃
      }
      out += ' ';
    } else {
      run.push(b);
    }
  }
  flush();
  return out.trim().replace(/ {2,}/g, ' ');
}

/** 判断 `[from, limit)` 区间是否全为 0 位（包尾填充）。 */
function restIsZero(r: BitReader, limit: number): boolean {
  for (let i = r.pos; i < limit; i++) if (r.bitAt(i) !== 0) return false;
  return true;
}

/** 按类型号分派；返回 false 表示该包无法继续解析。 */
function dispatch(type: number, r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  switch (type) {
    case NetMsgType.Nop:
      return true;
    case NetMsgType.Tick:
      // 协议 24：tick i32 + 主机帧时 u16 + 主机帧时标准差 u16（各为 100000×秒 的定点）
      r.u(32);
      r.u(16);
      r.u(16);
      return true;
    case NetMsgType.SetConVar: {
      const n = r.u(8);
      for (let i = 0; i < n; i++) {
        r.str();
        r.str();
      }
      return true;
    }
    case NetMsgType.SignonState:
      r.u(8);
      r.u(32);
      return true;
    case NetMsgType.StringCmd:
    case NetMsgType.Print:
    case NetMsgType.Disconnect: {
      // 文本消息：内含服务器打印/聊天/连接公告（「X connected」之类），是**不依赖实体流**的
      // 玩家名单来源，故留档供上层取用（限量，避免长录像把内存吃光）。
      const text = r.str();
      if (ctx.chatLines.length < CHAT_LINE_LIMIT) ctx.chatLines.push(text);
      return !r.overflowed;
    }
    case NetMsgType.ServerInfo:
      return readServerInfo(r, ctx, stats);
    case NetMsgType.SendTable: {
      // 协议 24：1 位 needsDecoder + 16 位长度（位）+ 该长度的发送表位流
      r.bit();
      r.skip(r.u(16));
      return !r.overflowed;
    }
    case NetMsgType.ClassInfo:
      return readClassInfo(r, ctx, stats);
    case NetMsgType.SetPause:
      r.bit();
      return true;
    case NetMsgType.CreateStringTable:
      return readCreateStringTable(r, ctx, stats);
    case NetMsgType.UpdateStringTable:
      return readUpdateStringTable(r, ctx, stats);
    case NetMsgType.VoiceInit:
      r.str();
      r.u(8);
      return true;
    case NetMsgType.VoiceData: {
      r.u(8); // 发送者槽位
      r.u(8); // 邻近度
      const bits = r.u(16);
      r.skip(bits);
      return !r.overflowed;
    }
    case NetMsgType.Sounds: {
      // 可靠音效固定 1 条、长度 8 位；不可靠音效带条数（8 位）与长度（16 位）
      if (r.bit() === 1) {
        r.skip(r.u(8));
      } else {
        r.u(8);
        r.skip(r.u(16));
      }
      return !r.overflowed;
    }
    case NetMsgType.SetView:
      r.u(MAX_EDICT_BITS);
      return true;
    case NetMsgType.FixAngle:
      r.bit();
      r.u(16);
      r.u(16);
      r.u(16);
      return true;
    case NetMsgType.CrosshairAngle:
      r.u(16);
      r.u(16);
      return true;
    case NetMsgType.BSPDecal: {
      r.vec3Coord();
      r.u(MAX_DECAL_INDEX_BITS);
      if (r.bit() === 1) {
        r.u(MAX_EDICT_BITS);
        r.u(SP_MODEL_INDEX_BITS);
      }
      r.bit(); // lowPriority
      return !r.overflowed;
    }
    case NetMsgType.UserMessage: {
      const umId = r.u(8); // 消息类型
      const umBits = r.u(11);
      // **`SayText2`（CS:S 用户消息号 4）解码进 `chatLines`**：玩家聊天与 SourceMod 的
      // 连接/掉线/计时播报都走它。实测（`test/replay/auto-20261001-050330-surf_gigapede.dem`）：
      // 全录像 `svc_Print` / `svc_StringCmd` 为 0 条，而 id=4 出现 40 条，内容为带颜色码的聊天
      // 文本。载荷是**位流**：内部按字节组织（客户端号 + 布尔 + 串），`\x07` 后跟 6 字节颜色码，
      // 其余 <0x20 的控制字节（`\x01` 等）作分隔——按「控制字节边界切 UTF-8 段」解码即可得到
      // 可读文本（颜色码丢弃）。其它 id 的布局随 mod 而异，维持整段跳过。
      if (umId === 4) {
        const pos0 = r.pos;
        const wasOvf = r.overflowed;
        const bytes = r.readBytes(Math.min(Math.ceil(umBits / 8), 512));
        r.overflowed = wasOvf; // 载荷截断只影响本条文本，不能拖垮整包
        const text = decodeSayText2(bytes);
        if (text.length > 0 && ctx.chatLines.length < CHAT_LINE_LIMIT) ctx.chatLines.push(text);
        r.seek(pos0 + umBits);
        return !r.overflowed;
      }
      r.skip(umBits);
      return !r.overflowed;
    }
    case NetMsgType.EntityMessage: {
      r.u(MAX_EDICT_BITS);
      r.u(MAX_SERVER_CLASS_BITS);
      r.skip(r.u(11));
      return !r.overflowed;
    }
    case NetMsgType.GameEvent: {
      r.skip(r.u(11));
      return !r.overflowed;
    }
    case NetMsgType.PacketEntities:
      return readPacketEntities(r, ctx, stats);
    case NetMsgType.TempEntities: {
      r.u(EVENT_INDEX_BITS);
      const bits = r.varInt32(); // 协议 24 (> 23) 用变长整数
      r.skip(bits);
      return !r.overflowed;
    }
    case NetMsgType.Prefetch:
      r.u(MAX_SOUND_INDEX_BITS); // 协议 24 (> 22) 用 14 位
      return true;
    case NetMsgType.Menu:
      r.u(16);
      r.skip(r.u(32));
      return !r.overflowed;
    case NetMsgType.GameEventList: {
      const count = r.u(MAX_EVENT_BITS);
      r.u(20);
      for (let i = 0; i < count; i++) {
        r.u(MAX_EVENT_BITS);
        r.str();
        for (let guard = 0; guard < 64; guard++) {
          const t = r.u(3);
          if (t === 0) break;
          r.str();
        }
      }
      return !r.overflowed;
    }
    case NetMsgType.GetCvarValue:
      r.u(32);
      r.str();
      return !r.overflowed;
    case NetMsgType.File:
      r.u(32);
      r.str();
      r.u(8);
      return !r.overflowed;
    case NetMsgType.HLTV:
    case NetMsgType.TerrainMod:
      stats.warnings.push(`包 ${ctx.packetIndex}：消息类型 ${type}（HLTV/TerrainMod）本工程未实现`);
      return false;
    default:
      stats.warnings.push(`包 ${ctx.packetIndex}：未知消息类型 ${type}`);
      return false;
  }
}

/**
 * `svc_ServerInfo`：布局取自 demboyz 的 `svc_serverinfo.cpp`（协议 24 落在 `protocol > 17` 分支，
 * 即 16 字节保留区而非 mapCRC）。字段顺序与位宽：
 * `protocol u16、serverCount u32、isHLTV 1、isDedicated 1、clientCRC u32、maxClasses u16、
 *  reserved 16 字节、playerSlot u8、maxClients u8、tickInterval f32、os u8、
 *  gameDir 串、mapName 串、skyName 串、hostName 串、unk2 1 位`。
 */
function readServerInfo(r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  const protocol = r.u(16);
  r.u(32);
  r.bit();
  r.bit();
  r.u(32);
  const maxClasses = r.u(16);
  classBitsDiag.maxClasses = maxClasses;
  ctx.classIdBits = qLog2Plus1(maxClasses);
  if (protocol <= 17) r.u(32);
  else r.skip(16 * 8);
  r.u(8);
  r.u(8);
  r.f32();
  r.u(8);
  const gameDir = r.str();
  const mapName = r.str();
  r.str();
  const hostName = r.str();
  r.bit();
  stats.warnings.push(`#serverinfo protocol=${protocol} game=${gameDir} map=${mapName} host=${hostName}`);
  return !r.overflowed;
}

/**
 * 位宽：`Q_log2(n) + 1`（引擎 `Q_log2` = floor(log2(n))）。
 * 用于 `svc_ClassInfo` 的类别号、`svc_CreateStringTable` 的条目数、以及字符串表条目的下标。
 * 注意**不是** `ceil(log2(n))`——`n = 95` 时本式为 7，取上整只有 6。
 */
function qLog2Plus1(n: number): number {
  if (n <= 1) return 1;
  return Math.floor(Math.log2(n)) + 1;
}

/** `Q_log2(n)`：字符串表条目下标的位宽（不加 1）。 */
function qLog2(n: number): number {
  return n <= 1 ? 0 : Math.floor(Math.log2(n));
}

/** `svc_ClassInfo`：`numServerClasses u16、createOnClient 1 位；为假时逐项
 *  `classId u(Q_log2(n)+1)、className 串、dataTableName 串`。本工程已从 dem_datatables 拿到类别表，
 *  此处只按长度跳过。 */
function readClassInfo(r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  const n = r.u(16);
  classBitsDiag.n = n;
  try { classBitsDiag.classes = ctx.dataTables.classes.length; } catch { classBitsDiag.classes = -2; }
  classBitsDiag.bits = ctx.classIdBits;
  // **类别号位宽以「服务器类别数」为准**（权威：`log_base2(state.server_classes.len()) + 1`）。
  // 此前取的是 `svc_ServerInfo` 的 `max_classes`，实测推得 14 位，而真实类别数 197 ⇒ 应为 8 位；
  // 多读 6 位会让每条 `Enter` 之后的位流整体前移（实测：类别号读出 8475、类别未知 229,613 次）。
  if (n > 0) ctx.classIdBits = qLog2Plus1(n);
  const createOnClient = r.bit();
  if (!createOnClient) {
    const bits = qLog2Plus1(n);
    for (let i = 0; i < n; i++) {
      r.u(bits);
      r.str();
      r.str();
    }
  }
  void ctx;
  void stats;
  return !r.overflowed;
}

/** `svc_CreateStringTable`：`表名串、（首字节为 ':' 时先吃掉该字节）、maxEntries u16、
 *  numEntries u(Q_log2(maxEntries)+1)、dataLengthInBits（协议 > 23 用变长整数）、
 *  isUserDataFixedSize 1 位（为真再读 12 位与 4 位）、dataCompressed 1 位、data`。 */
function readCreateStringTable(r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  if (r.u(8) !== 0x3a) r.skip(-8); // 非 ':' 前缀则退回首字节
  const name = r.str();
  const maxEntries = r.u(16);
  const numEntries = r.u(qLog2Plus1(maxEntries));
  const dataBits = r.varInt32();
  const fixed = r.bit() === 1;
  let userDataSizeBits = 0;
  if (fixed) {
    // 两个字段都读：12 位的 `size`（字节数）只作留档，真正决定 userdata 位宽的是 4 位的 `bits`
    // —— 权威 `read_table_entry` 读的就是它（`stream.read_bits(size.bits)`，再由
    // `ExtraData::new` 取 `byte_len = bits / 8`）。**不要用 12 位那个去乘 8**：那是偏离基准的改法。
    const fixedBytes = r.u(12);
    userDataSizeBits = r.u(4);
    void fixedBytes;
  }
  const compressed = ctx.readCompressedFlag ? r.bit() === 1 : false;
  const table = ctx.stringTables.get(name) ?? new Map<number, { key: string; value: Uint8Array | null }>();
  ctx.stringTables.set(name, table);
  ctx.stringTableMaxEntries.set(name, maxEntries);
  if (ctx.trace) {
    ctx.trace.push(`  [ST] ${name} max=${maxEntries} n=${numEntries} bits=${dataBits} fixed=${fixed} compressed=${compressed}`);
  }
  if (compressed) {
    // 压缩载荷本工程不支持：按声明长度整段跳过，表内容留空
    stats.warnings.push(`包 ${ctx.packetIndex}：字符串表 ${name} 采用压缩载荷，未解压`);
    r.skip(dataBits);
    return !r.overflowed;
  }
  const dataStart = r.pos;
  readStringTableEntries(r, dataBits, numEntries, table, maxEntries, fixed, userDataSizeBits, 0, 14);
  r.seek(dataStart + dataBits);
  return !r.overflowed;
}

/** `svc_UpdateStringTable`：`tableId u(Q_log2(32)=5)、变动条数位（0 表示 1 条；1 时再读 u16）、
 *  dataLengthInBits u20、data`。 */
function readUpdateStringTable(r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  updateStringTableCount++;
  const updateStart = r.pos;
  // `SVC_UpdateStringTable_t::WriteToBuffer`：表号位宽 = `Q_log2(MAX_STRING_TABLES) + 1`（MAX=32 ⇒ 6 位），
  // 随后是 16 位「本次变更的条目数」，再往后是**没有长度前缀的位流**：每条目形如
  // `[条目下标 (Q_log2(条目上限)+1 位)][字符串][1 位 userdata 标志][有则 u16 字节数 + 原始字节]`
  //（`CNetworkStringTable::WriteUpdate`）。旧实现把表号读成 5 位、又凭空多读了一个 20 位长度字段，
  // 因此表名几乎全部落空、中途加入的玩家名字一条也拿不到。
  // 权威 Source 1 头（`tf2-demo-parser` 的 `src/demo/message/stringtable.rs`
  // `UpdateStringTableMessage::parse`）：
  //   `table_id : 5 位` ／ `changed : 1 位标志，为真再读 16 位，否则 = 1` ／ `length : 20 位`（**位长**）
  // 本工程早先读成「6 位表号 + 16 位长度」，三处全错：表号多 1 位、漏掉 changed 标志、长度少 4 位。
  // 实测吻合：按 5 位读表号仍得 7（= userinfo）；按新法读 changed = 1（一条条目）、length = 1081 位
  // ≈ 135 字节 —— 正好是一个 `player_info_s` 的量级（旧读法把 1081 当成"条目数"，才会一路解错）。
  const tableId = r.u(5);
  const changed = r.bit() === 1 ? r.u(16) : 1;
  const dataBits = r.u(20);
  // 表号 → 表名：优先用 `dem_stringtables` 的表名序列（权威创建顺序），其次退回 `ctx.stringTables`
  // 里已有的键。解析出的更新写入**同一张命名表**，这样 `readPlayerNames` 才能看到中途加入的玩家。
  const name = ctx.stringTableIdNames[tableId] ?? [...ctx.stringTables.keys()][tableId];
  if (!name) {
    stats.warnings.push(`包 ${ctx.packetIndex}：更新了未知字符串表 ${tableId}`);
    return !r.overflowed;
  }
  let table = ctx.stringTables.get(name);
  if (!table) {
    table = new Map<number, { key: string; value: Uint8Array | null }>();
    ctx.stringTables.set(name, table);
  }
  const dataStart = r.pos;
  // **必须夹住**：该字段偶尔会读出离谱值（实测 14656、16480 位，远超包长）。若照它 seek，游标会
  // 直接跳出包外，把该包之后的所有消息一起毁掉 —— 实测后果是玩家类轨迹整批消失、导入退回
  // `posed` 口径（301 条服务器实体）。故上界取「包内剩余位数」，宁可少读也不越界。
  const dataEnd = Math.min(dataStart + dataBits, r.pos + r.remaining);
  // `stringTableMaxEntries` 只由 `svc_CreateStringTable` 填；签入段建的表（含 `userinfo`）不走该消息
  // ⇒ 这里走兜底。**下标位宽已按外部基准逐个试过，三种取值都不成立**：
  //   兜底 32（entryBits=5，现状）⇒ 条目 userdata 长度 1056、内容无 `BOT`
  //   兜底 64（=6）              ⇒ 长度 7528、起点比现状**前移 13 字节**，仍无 `BOT`
  //   兜底 21（=4，权威实测 `userinfo` 的 `max_entries` 就是 21）⇒ 长度 10256，仍无 `BOT`
  // ⇒ 病灶不在下标位宽，而在**条目起点更早处**；改回原兜底以免留下无依据的改动。
  // **该表是否由签入段（dem_stringtables）建**：这类表在更新条目里多 5 位（见 readStringTableEntries）。
  // 判据用「ctx.stringTableMaxEntries 里有没有它」—— 那张映射只由 svc_CreateStringTable 填。
  const signonBuilt = !ctx.stringTableMaxEntries.has(name);
  const maxEntries = ctx.stringTableMaxEntries.get(name) ?? (signonBuilt ? 21 : MAX_TABLES);
  // 诊断：把「本条更新解出的表号与 changed」直接打出来，供与手工位解算对照（钉死位索引）。
  if (ctx.trace && updateStringTableCount <= 8) {
    ctx.trace.push(`  [UPDH] 包 ${ctx.packetIndex} tableId=${tableId} changed=${changed} dataBits=${dataBits} 起点=${updateStart}`);
  }
  if (ctx.trace && ctx.updateTraced < 6) {
    ctx.updateTraced++;
    const raw = (r as unknown as { bytes: Uint8Array }).bytes;
    const from = Math.max(0, updateStart - 16);
    let s = '';
    for (let i = from; i < updateStart + 96; i++) s += String((raw[i >> 3] >> (i & 7)) & 1);
    ctx.trace.push(
      `  [UPD] 包 ${ctx.packetIndex} 表 ${tableId}(${name}) dataBits=${dataBits} max=${maxEntries} 起始位=${updateStart}\n` +
        `        原始位（${from} 起，表号在偏移 ${updateStart - from}）：${s}`,
    );
  }
  // 更新条目**只带数据、不带键**：`userinfo` 这类表的键在签入时已建好，之后每次变动的只是
  // `player_info_s` 数据本身。若沿用创建期的「条目流」编码（里面含字符串与前缀压缩）就会把位数
  // 读飞——实测解出的键是随机字节、userdata 长度离谱到 10398 字节（真值约 100 字节）。
  // 形式：`1 位下标是否连续`（1 → 上一条 +1）/ `u(entryBits) 下标`，随后 `1 位有无值`，
  //       有值时 `u14 字节数` + 该字节数（`MAX_USERDATA_BITS = 14`，与创建期一致）。
  // 注：权威实现（`demoinfocs-golang` v3 `processStringTable`）在条目流最前面读 **1 位且要求为 0**，
  // 且其 `handleUpdateStringTable` **复用同一个解码器**。但**本工程实测跳过这 1 位后槽 1 反而解不出**
  //（`plausibleName` 闸门拒收，玩家名从 2 个降到 1 个），故**不跳**。差异说明这段位流与 CS:GO 的
  // protobuf `string_data` 布局并不一致，仍需按 Source 1 的实际形态继续核对。
  const entryBits = qLog2(maxEntries);
  let last = -1;
  // 诊断：在数据段内扫「位偏移 0..64」，找第一个能解出**可打印 32 字节名**的偏移。
  // 判据不含臆测：`player_info_s` 的 `name[32]` 在偏移 0，必须是可打印 ASCII 且以 NUL 结尾。
  if (ctx.trace && name === 'userinfo' && ctx.updateTraced < 8) {
    ctx.updateTraced++;
    const raw = (r as unknown as { bytes: Uint8Array }).bytes;
    const hits: string[] = [];
    for (let off = 0; off <= 64; off++) {
      let s = '';
      for (let k = 0; k < 32; k++) {
        const bit = dataStart + off + k * 8;
        let byte = 0;
        for (let b = 0; b < 8; b++) byte += ((raw[(bit + b) >> 3] >> ((bit + b) & 7)) & 1) << b;
        if (byte === 0) break;
        s += String.fromCharCode(byte);
      }
      if (s.length >= 3 && /^[\x20-\x7e]+$/.test(s)) hits.push(`${off}:"${s}"`);
    }
    ctx.trace.push(`  [UI] 包 ${ctx.packetIndex} dataBits=${dataBits} 可打印名命中偏移：${hits.join(' ') || '（无）'}`);
  }
  // **只对 `userinfo` 做条目解码**（键已建、更新只发数据 —— 该形态已实测确认）。其它表的更新形式
  // 本工程尚未定死，若一并按此读会把位流读飞、连带把实体流传坏（实测后果：玩家类轨迹整批消失、
  // 导入退回 `posed` 口径）。故其它表**只按（夹住后的）长度跳过**，不解析内容。
  if (updateEntryShift !== 0) r.skip(updateEntryShift);
  if (decodeUpdateEntries) {
    // **改用与创建期完全相同的条目解码器** —— 权威 Source 1 实现就是这么做的
    // （`parse_string_table_update` 与建表共用 `read_table_entry`），条目数取头部读到的 `changed`。
    // 注：**不要给读取器加"限界到载荷"** —— 实测那样做之后条目一条都解不出来（`userinfo` 的更新映射
    // 变空、`playerInfos` 仍为 1），故"u14 长度读越出本消息"这条假设**已被实测否掉**，维持不限界。
    readStringTableEntries(r, dataBits, changed, table, maxEntries, false, 0, signonBuilt ? 4 : 0, 14);
  }
  if (r.pos < dataEnd) r.seek(dataEnd);
  // **名称时间线**：每次 userinfo 更新后快照一次（tick + 条目值），供面板按时间轮换显示。
  if (name === 'userinfo' && userinfoTimeline.length < 4000) {
    const snap: Array<{ idx: number; value: Uint8Array }> = [];
    for (const [k, v] of table) if (v.value && v.value.length > 0) snap.push({ idx: k, value: v.value });
    userinfoTimeline.push({ tick: currentTickRef.tick, entries: snap });
  }
  return !r.overflowed;
}

/**
 * 字符串表**条目流**（引擎 `CNetworkStringTable::WriteUpdate` 的等价读取）：
 *   1 位「下标是否连续」：1 → 下标 = 上一条 + 1；0 → 下标 = `u(Q_log2(maxEntries))`；
 *   1 位「是否新建条目」：为真时再 1 位「有无历史前缀」——
 *     有：`u5 前缀起点` + `u5 前缀长度` + 串（拼在前缀之后）；无：直接读串；
 *   1 位「有无值」：有值时定长表读 `userDataSizeBits` 位，非定长表读 `u14 字节数` + 该字节数。
 *   `MAX_USERDATA_BITS = 14`（引擎 `networkstringtableitem.h`）；值长度为 **14 位**而非 17 位。
 */
function readStringTableEntries(
  r: BitReader,
  dataBits: number,
  numEntries: number,
  table: Map<number, { key: string; value: Uint8Array | null }>,
  maxEntries: number,
  userDataFixed: boolean,
  userDataSizeBits: number,
  /** **签入段建的表**在更新条目里于「有无文本」与「有无值」之间多 5 位（实测：userinfo 的条目起点
   * bit0=连续标志、bit1..4=下标、bit5=有无文本、**bit6..10 多出 5 位**、bit11=有无值、bit12..25 = u14 = 132
   * 正好等于 player_info_s 大小）。downloadables 走 svc_CreateStringTable、无这 5 位（那里精确闭合），故只对签入段表补。 */
  extraBeforeValue: number,
  /** **长度字段位宽**。签入段建的表实测为 **10 位**（downloadables 等走 svc_CreateStringTable 的表为 14）。
   * 依据：条目步长实测 **1073 位** = 1056(132B) + 1+4(下标) + 1(有无文本) + 1(有无值) + **10**。 */
  lenBits: number,
): void {
  const entryBits = qLog2(maxEntries);
  // **前缀历史是「本次调用内已解出的条目」，不是表里已有的条目** —— 依据权威
  // `read_string_table_update` / `TableEntries`：`TableEntries::new()` 每次都建**空** history，
  // 只有 `push`（本次解出的条目）才会往里加，`read_table_entry` 的 `get_history` 也只查它。
  // 早先的实现拿表里已有条目当历史，并附了一条"权威传的就是表自身的 entries"的注释 —— 那条注释
  // 与权威代码不符（已核对 `TableEntries::new` 与 `push`），故按权威改成**每次调用从空开始**。
  const history: string[] = [];
  // **逐位扫描**（穷举，不猜语义）：`userinfo` 那条 1081 位载荷恰好 ≈ 1 条 `player_info_s`（132 字节），
  // 但按现有布局「有无值」标志总读到 0 ⇒ 少读 1056 位。这里对条目起点后的 0..8 位逐个假设
  // 「该位就是有无值标志」，从其后读 `u14 长度` + 字节，**判据是偏移 36 处出现 `BOT`**
  // （`player_info_s` 的 `guid`，0x42 0x4F 0x54）—— 这是不需要任何真值就能判对错的硬信号。
  if ((dataBits === 1081 || dataBits === 3227) && entryStepTrace.length < 250) {
    const save = r.pos;
    // 原始比特：条目起点后 24 位（直接看清「下标 / 文本段 / 有无值」各占哪几位；实测「有无值」
    // 在 +11 位处三项判据同时成立 ⇒ 现有布局在它之前少了 5 位）。
    const rawBytes = (r as unknown as { bytes: Uint8Array }).bytes;
    let bitsStr = '';
    for (let q = 0; q < 24; q++) bitsStr += String((rawBytes[(save + q) >> 3] >> ((save + q) & 7)) & 1);
    entryStepTrace.push(`[原始] 起点=${save} 后 24 位=${bitsStr}`);
    if (dataBits === 3227) {
      // **搜 `BOT`（0x42 0x4F 0x54）的位位置**：每条 player_info_s 的 guid 都在偏移 36，
      // 三条命中点之差就是真实条目步长 —— 不依赖任何布局假设。
      const botAt: number[] = [];
      for (let q = save; q + 24 < save + dataBits; q++) {
        let a = 0, b2 = 0, c = 0;
        for (let k = 0; k < 8; k++) {
          a |= ((rawBytes[(q + k) >> 3] >> ((q + k) & 7)) & 1) << k;
          b2 |= ((rawBytes[(q + 8 + k) >> 3] >> ((q + 8 + k) & 7)) & 1) << k;
          c |= ((rawBytes[(q + 16 + k) >> 3] >> ((q + 16 + k) & 7)) & 1) << k;
        }
        if (a === 0x42 && b2 === 0x4f && c === 0x54) botAt.push(q);
      }
      entryStepTrace.push(`[BOT位] 载荷起点=${save} 命中 ${botAt.length} 处：${botAt.slice(0, 6).join(' ')}`);
      // 三条条目的起点 = BOT位 − 313（guid 偏移 36 字节 = 288 位，加上头部 25 位）
      for (let k2 = 0; k2 < botAt.length && k2 < 3; k2++) {
        const st = botAt[k2] - 313;
        let h = '';
        for (let q = 0; q < 25; q++) h += String((rawBytes[(st + q) >> 3] >> ((st + q) & 7)) & 1);
        entryStepTrace.push(`[头部] 第${k2 + 1}条@${st} 25位=${h}`);
      }
      if (botAt.length >= 2) {
        const ds: number[] = [];
        for (let i = 1; i < botAt.length; i++) ds.push(botAt[i] - botAt[i - 1]);
        entryStepTrace.push(`[BOT位] 相邻差：${ds.slice(0, 6).join(' ')}`);
      }
      const dump = (at: number): string => {
        let s2 = '';
        for (let q = 0; q < 32; q++) s2 += String((rawBytes[(at + q) >> 3] >> ((at + q) & 7)) & 1);
        return s2;
      };
      entryStepTrace.push(`[并排] 第1条@${save}: ${dump(save)}`);
      entryStepTrace.push(`[并排] 第2条@${save + 1073}: ${dump(save + 1073)}`);
      entryStepTrace.push(`[并排] 差@${save + 1073 - 8}: ${dump(save + 1073 - 8)}`);
    }
    // **硬切**：按实测步长 1073 位连续切段，逐段看前 48 字节（判定第 3 段是否仍是 player_info_s）。
    if (dataBits === 3227) {
      // **搜 `BOT`（0x42 0x4F 0x54）的位位置**：每条 player_info_s 的 guid 都在偏移 36，
      // 三条命中点之差就是真实条目步长 —— 不依赖任何布局假设。
      const botAt: number[] = [];
      for (let q = save; q + 24 < save + dataBits; q++) {
        let a = 0, b2 = 0, c = 0;
        for (let k = 0; k < 8; k++) {
          a |= ((rawBytes[(q + k) >> 3] >> ((q + k) & 7)) & 1) << k;
          b2 |= ((rawBytes[(q + 8 + k) >> 3] >> ((q + 8 + k) & 7)) & 1) << k;
          c |= ((rawBytes[(q + 16 + k) >> 3] >> ((q + 16 + k) & 7)) & 1) << k;
        }
        if (a === 0x42 && b2 === 0x4f && c === 0x54) botAt.push(q);
      }
      entryStepTrace.push(`[BOT位] 载荷起点=${save} 命中 ${botAt.length} 处：${botAt.slice(0, 6).join(' ')}`);
      // 三条条目的起点 = BOT位 − 313（guid 偏移 36 字节 = 288 位，加上头部 25 位）
      for (let k2 = 0; k2 < botAt.length && k2 < 3; k2++) {
        const st = botAt[k2] - 313;
        let h = '';
        for (let q = 0; q < 25; q++) h += String((rawBytes[(st + q) >> 3] >> ((st + q) & 7)) & 1);
        entryStepTrace.push(`[头部] 第${k2 + 1}条@${st} 25位=${h}`);
      }
      if (botAt.length >= 2) {
        const ds: number[] = [];
        for (let i = 1; i < botAt.length; i++) ds.push(botAt[i] - botAt[i - 1]);
        entryStepTrace.push(`[BOT位] 相邻差：${ds.slice(0, 6).join(' ')}`);
      }
      for (let seg = 0; seg < 3; seg++) {
        const at = save + 11 + seg * 1073;
        let hex = '';
        for (let q = 0; q < 48; q++) hex += (rawBytes[(at + q) >> 3] >> ((at + q) & 7) & 1 ? '' : '');
        void hex;
        const b: number[] = [];
        for (let q = 0; q < 48; q++) {
          let v = 0;
          for (let k = 0; k < 8; k++) v |= ((rawBytes[(at + q * 8 + k) >> 3] >> ((at + q * 8 + k) & 7)) & 1) << k;
          b.push(v);
        }
        const s = b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
        const asc = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(b)).replace(/[^\x20-\x7e]/g, '.');
        entryStepTrace.push(`[硬切] 段${seg} 起点=${at} 首48B=${s} | ASCII=${asc}`);
      }
    }
    for (let off = 0; off <= 1400; off++) {
      r.seek(save + off);
      const len = r.u(14);
      if (len < 40 || len > 2048) continue;
      const bytes = r.readBytes(len);
      const g = bytes.subarray(36, 39);
      const bot = g[0] === 0x42 && g[1] === 0x4f && g[2] === 0x54;
      const nm = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 16)).replace(/\0.*$/, '');
      const guidStr = new TextDecoder('utf-8', { fatal: false }).decode(g);
      const ascii = /^[\x20-\x7e]{2,}/.test(guidStr);
      if (len >= 100 && len <= 200 && ascii) entryStepTrace.push(`[命中] off=${off} len=${len} 名=${JSON.stringify(nm)} guid=${JSON.stringify(guidStr.slice(0, 14))}`);
    }
    r.seek(save);
    r.overflowed = false; // 诊断不得影响解析状态：扫描期间的长读会置位 overflowed，进而让条目循环整段跳过
  }
  let lastEntry = -1;
  for (let i = 0; i < numEntries && !r.overflowed; i++) {
    // 诊断：逐步记录本条条目在流里的位置，供与载荷总长做**闭合校验**（各步消耗之和应约等于
    // 载荷位数）—— 这比猜字段语义更能定位是哪一步读飞。
    const pEntry = r.pos;
    const index = r.bit() === 1 ? lastEntry + 1 : entryBits > 0 ? r.u(entryBits) : 0;
    lastEntry = index;
    const pIndex = r.pos;
    let key = '';
    let reuse = -1;
    if (r.bit() === 1) {
      if (r.bit() === 1) {
        const best = r.u(5);
        const sub = r.u(5);
        reuse = best;
        const base = best < history.length ? history[best].slice(0, sub) : '';
        key = base + r.str();
      } else {
        key = r.str();
      }
      history.push(key);
      if (history.length > 32) history.shift();
    }
    const pText = r.pos;
    if (extraBeforeValue > 0) r.u(extraBeforeValue);
    let value: Uint8Array | null = null;
    let len = -1;
    if (r.bit() === 1) {
      if (userDataFixed) {
        value = r.readBytes(Math.ceil(userDataSizeBits / 8));
      } else {
        len = r.u(lenBits);
        value = r.readBytes(len);
      }
    }
    if (dataBits === 3227 || dataBits === 1081) {
      entryStepTrace.push(
        `i=${i} entryBits=${entryBits} 起始=${pEntry} 下标=${index}(+${pIndex - pEntry}) ` +
          `文本=${JSON.stringify(key).slice(0, 20)}(+${pText - pIndex},reuse=${reuse}) ` +
          `u14长度=${len} 值后=${r.pos}(共${r.pos - pEntry}) 载荷=${dataBits}`,
      );
    }
    const prev = table.get(index);
    table.set(index, {
      key: key || prev?.key || '',
      value: value ?? prev?.value ?? null,
    });
  }
}

/** `svc_PacketEntities` 消息头 + 实体载荷。 */
function readPacketEntities(r: BitReader, ctx: NetContext, stats: DemoParseStats): boolean {
  const maxEntries = r.u(ctx.maxEntriesBits || ctx.edictBits);
  const isDelta = r.bit() === 1;
  const deltaFrom = isDelta ? r.u(32) : -1;
  const baselineIndex = r.u(1);
  void baselineIndex;
  const numUpdated = r.u(ctx.updatedEntriesBits || ctx.edictBits);
  const dataBits = r.u(DELTASIZE_BITS);
  const updateBaseline = r.bit() === 1;
  void updateBaseline;
  void deltaFrom;
  const dataStart = r.pos;
  stats.entityMessages++;
  if (ctx.trace && stats.entityMessages <= 12) {
    ctx.trace.push(
      `  [PE] max=${maxEntries} isDelta=${isDelta} updated=${numUpdated} bits=${dataBits} 窗口=[${dataStart}..${dataStart + dataBits}] 读取器上限=${r.limit} updateBaseline=${updateBaseline}`,
    );
    const raw = (r as unknown as { bytes: Uint8Array }).bytes;
    const bitsFrom = (from: number, n: number): string => {
      let s = '';
      for (let i = 0; i < n; i++) s += String((raw[(from + i) >> 3] >> ((from + i) & 7)) & 1);
      return s;
    };
    ctx.trace.push(`  [PE] 头部位 ${dataStart - 80}..${dataStart}: ${bitsFrom(Math.max(0, dataStart - 80), Math.min(80, dataStart))}`);
    ctx.trace.push(`  [PE] 载荷前 160 位: ${bitsFrom(dataStart, 160)}`);
  }
  if (ctx.trace && dataBits <= 200 && ctx.smallPeTraced < 24) {
    // 极小 PE 消息留痕：载荷只有几十位、实体 1~2 条，组合空间极小，适合用「实体号严格递增 +
    // 解完恰好落在载荷终点」穷举头部构成（第 21 轮用同样方法一次命中 64 位样本）。
    ctx.smallPeTraced++;
    const raw = (r as unknown as { bytes: Uint8Array }).bytes;
    let s = '';
    for (let i = dataStart; i < dataStart + dataBits; i++) s += String((raw[i >> 3] >> (i & 7)) & 1);
    ctx.trace.push(
      `  [SMALLPE] 包 ${ctx.packetIndex} dataBits=${dataBits} 头部读出 numUpdated=${numUpdated} 位流= ${s}`,
    );
  }
  if (ctx.trace && numUpdated === 1 && isDelta && ctx.traceSingleEnt < 2) {    ctx.traceSingleEnt++;
    const raw = (r as unknown as { bytes: Uint8Array }).bytes;
    let all = '';
    for (let i = 0; i < dataBits; i++) all += String((raw[(dataStart + i) >> 3] >> ((dataStart + i) & 7)) & 1);
    ctx.trace.push(`  [PE1] 单实体增量消息：dataStart=${dataStart} dataBits=${dataBits} 全部位= ${all}`);
  }
  decodePacketEntities(r, dataStart, dataBits, numUpdated, maxEntries, ctx, stats, isDelta);
  return !r.overflowed;
}

/** 实体更新标志（`FHDR_*`）。 */
const FHDR_LEAVEPVS = 1;
const FHDR_DELETE = 2;
const FHDR_ENTERPVS = 4;

/** 实体载荷解码（算法见文件头注释）。 */
function decodePacketEntities(
  r: BitReader,
  dataStart: number,
  dataBits: number,
  numUpdated: number,
  maxEntries: number,
  ctx: NetContext,
  stats: DemoParseStats,
  isDelta: boolean,
): void {
  const end = dataStart + dataBits;
  r.seek(dataStart);
  // 实体号以上一条为基准递推：新号 = 基准 + 1 + 变长增量（引擎 CL_ParseDeltaHeader）
  let headerBase = ctx.headerBaseInit;
  let traceEnts = 0;
  let decoded = 0;
  // 诊断：记录本消息内每条实体记录的「位区间 + 实体号」，供首次越界时留痕（见下）
  const recs: string[] = [];
  // `'count'` 读 `updatedEntries` 条；`'untilEnd'` 读到声明长度为止（见 `entityLoopMode`）
  const maxIter = ctx.entityLoopMode === 'untilEnd' ? 1 << 16 : numUpdated;
  // 退出原因（三条 break 出口 + reader 溢出 + 读满配额），循环后统一计数
  let exitReason = 'count';
  for (let i = 0; i < maxIter && !r.overflowed; i++) {
    // 读到声明长度为止时，剩余位数不足以再容纳一条最小实体头（`uBitVar` 6 位 + 2 位标志 = 8 位）
    // 就停——否则会从删除表结束位与包尾对齐位里"读"出phantom实体，实测会多读 1..7 位。
    if (ctx.entityLoopMode === 'untilEnd' && end - r.pos < entityStopThreshold) {
      exitReason = 'guard';
      break;
    }
    decoded++;
    const headStart = r.pos;
    const entityIndex = headerBase + (ctx.entityIndexPlusOne ? 1 : 0) + r.uBitVar();
    headerBase = entityIndex;
    if (
      (entityIndex >= maxEntries || entityIndex < 0) &&
      ctx.trace &&
      ctx.overflowTraced < 8
    ) {
      // 只留痕**第一次**越界：本条消息此前每条记录的位区间与实体号，用于定位退化的起点
      ctx.overflowTraced++;
      ctx.trace.push(
        `  [OVF] 首次越界：包 ${ctx.packetIndex} 消息第 ${decoded} 条，实体号 ${entityIndex}（上限 ${maxEntries}）\n` +
          `        前面各级记录：${recs.join(' ')}`,
      );
    }
    // **越界判据用实体号真上限（MAX_EDICT_BITS ⇒ 2048），而不是头里的 maxEntries**
    // （本录像读到 333）。二者不是同一个量：后者是「本消息最多涉及多少条」，全量更新本就会覆盖到
    // 接近上限的索引。用工后者当判据，会让循环在**合法索引**上 overflowBreak 提前中断 —— 实测每条
    // 消息只读到 3~43 条（声明 20~126 条），绝大部分载荷从未被消费。
    if (entityIndex >= MAX_EDICT_COUNT || entityIndex < 0) {
      // 实体号越界：只记录，不中断——中断会让整段实体流错位（早期实现即因此少读实体）。
      // 警告**必须限量**：真录像上关闭中断时越界可达 90 万次，逐条 push 字符串既吃掉内存也把
      // 解析拖慢两个数量级（实测 4 MB 从 0.3 s 涨到 75 s），而前若干条已足够定位。
      stats.entityOverflow++;
      if (stats.entityOverflow <= OVERFLOW_WARN_LIMIT) {
        stats.warnings.push(`包 ${ctx.packetIndex}：实体号 ${entityIndex} 越界（上限 ${maxEntries}）`);
      } else if (stats.entityOverflow === OVERFLOW_WARN_LIMIT + 1) {
        stats.warnings.push('（实体号越界警告过多，后续同类警告不再逐条记录，只累加计数）');
      }
      if (ctx.breakOnEntityOverflow) {
        exitReason = 'overflowBreak';
        break;
      }
    }
    let flags = 0;
    if (r.bit() === 0) {
      if (r.bit() !== 0) flags |= FHDR_ENTERPVS;
    } else {
      flags |= FHDR_LEAVEPVS;
      if (r.bit() !== 0) flags |= FHDR_DELETE;
    }
    stats.entityUpdates++;
    if (ctx.trace && entityIndex === 27) {
      // 保留**最后 12 条**（而非前 N 条）：首次越界往往发生在消息中后段，留头会把关键记录截掉
      recs.push(
        `[${headStart}..${r.pos}]idx=${entityIndex}${flags & FHDR_ENTERPVS ? 'E' : flags & FHDR_LEAVEPVS ? (flags & FHDR_DELETE ? 'L+D' : 'L') : 'D'}`,
      );
      if (recs.length > 60) recs.shift();
    }
    if ((flags & FHDR_LEAVEPVS) !== 0) {
      leaveBranchCount++;
      if ((flags & FHDR_DELETE) !== 0) deleteBranchCount++;
      if (ctx.trace && leaveBranchCount <= 12) {
        ctx.trace.push(`      [LEAVE] 包${ctx.packetIndex} 第${decoded} 条 #${entityIndex} 头部起=${headStart} 末=${r.pos}`);
      }
      // 离开 PVS：本 tick 不再发送该实体，本地快照丢弃
      ctx.entityClass.delete(entityIndex);
      ctx.entityProps.delete(entityIndex);
      continue;
    }
    let classId = ctx.entityClass.get(entityIndex) ?? -1;
    const isEnter = (flags & FHDR_ENTERPVS) !== 0;
    if (isEnter) {
      if (ctx.preClassBits > 0) r.u(ctx.preClassBits);
      // **优先用已解析类别表的位宽**（log_base2(类别数)+1，实测 197 ⇒ 8 位）：`svc_ServerInfo` 的
      // `max_classes` 实测为 8194（⇒14 位，与引擎实际使用的位宽不符），而 `svc_ClassInfo` / 发送表
      // 要晚于首批实体消息才到 ⇒ 早期消息必须直接以类别表为准，否则每条 `Enter` 多读 6 位。
      const effBits = ctx.classIdBitsOverride
        || (ctx.dataTables.classIdBits > 0 ? ctx.dataTables.classIdBits : ctx.classIdBits)
        || MAX_SERVER_CLASS_BITS;
      classId = r.u(effBits);
      if (ctx.postClassBits > 0) r.u(ctx.postClassBits);
      if (ctx.enterSerialBits > 0) {
        if (ctx.preSerialBits > 0) r.u(ctx.preSerialBits);
        r.u(ctx.enterSerialBits);
      }
      ctx.entityClass.set(entityIndex, classId);
      // 实体属性表**只存本帧 delta 写过的项**；取值时再用该类基线兜底（见 `demo.ts` 的
      // `effectiveProp`）。早先这里直接 `new Map(baseline)` 整表复制，对 `CCSPlayerResource`
      // 这类上千属性的类别每条实体都要复制一次，实测把解析耗时放大了两个数量级。
      ctx.entityProps.set(entityIndex, new Map());
    }
    if (classId < 0) {
      // 类别未知 ⇒ 无从知道该实体属性的位宽，属性列表读不了。这里**保留 `continue`**（跳过本记录、
      // 继续读下一条）：实测改为「停在本消息末尾」会让残差从 ±3 位恶化到最小 31 位（|残差|≤8 的
      // 消息由 62 条降为 0 条），说明多数情况下下一条记录仍能读出合理实体号 —— 早先「它就是错位
      // 来源」的判断只对上一条样本，整体不成立，故不改。仅累加计数供诊断。
      stats.entityUnknownClass++;
      if (unknownClassTrace.length < 10) {
        unknownClassTrace.push(`包${ctx.packetIndex} 第${decoded} 条 #${entityIndex} 起=${headStart} flags=${flags}`);
      }
      continue;
    }
    let props = ctx.entityProps.get(entityIndex);
    if (!props) {
      props = new Map();
      ctx.entityProps.set(entityIndex, props);
    }
    const flat = ctx.flatFor(classId);
    if (flat.length === 0) {
      if (emptyFlatTrace.length < 10) {
        emptyFlatTrace.push(`包${ctx.packetIndex} 第${decoded} 条 #${entityIndex} 起=${headStart} 末=${r.pos} class=${classId}`);
      }
      continue;
    }
    if (ctx.trace || ctx.indexHistogram.size >= 0) {
      const seen: number[] = [];
      const snapBefore = ctx.trace ? new Map(props) : null;
      const before = r.pos;
      // 越界首现前后的实体号区间留逐项轨迹（定位「哪个属性的宽度解错」）
      const steps = ctx.trace && entityIndex === 27 ? [] : undefined;
      if (ctx.trace && entityIndex === 27) {
        ctx.trace.push(`      [START] 包${ctx.packetIndex} #${entityIndex} $ {isEnter ? 'enter' : 'preserve'} class=${classId} 起始位=${r.pos}`);
      }
      readPropList(r, flat, props, ctx.legacyPropOrder, seen, steps);
      if (ctx.trace && entityIndex === 27) {
        ctx.trace.push(`      [END] 包${ctx.packetIndex} #${entityIndex} 结束位=${r.pos} 越界=${r.overflowed ? 1 : 0} 下标=[${seen.join(',')}]`);
      }
      if (ctx.trace && r.pos > end && ctx.overrunTraced < 10) {
        ctx.overrunTraced++;
        ctx.trace.push(
          `  [OVERRUN] 包 ${ctx.packetIndex} 实体 ${entityIndex}(class=${classId}) 越界 ${r.pos - end} 位 ` +
            `头起=${headStart} 下标=[${seen.join(',')}]`,
        );
      }
      // 诊断：在每条实体记录的属性列表之后额外跳 N 位（可负）。用途——实测「第 1 条记录永远合法、
      // 第 2 条永远越界」，说明第 1 条稳定地少读/多读了一段固定长度的位；这里用一维搜索找那个 N。
      if (ctx.propListPadBits !== 0) r.skip(ctx.propListPadBits);
      if (steps) ctx.trace!.push(`      [ITEMS] 包${ctx.packetIndex} #${entityIndex} ${steps.join(' ')}`);
      // 追踪两类：前 40 条解码；以及任何带「世界坐标 / 视向」下标的解码（真录像里玩家才有）
      const wantDetail =
        ctx.trace !== null &&
        (traceEnts < 40 || seen.some((v) => v === 13 || v === 14 || v === 15 || v === 16));
      if (wantDetail) {
        traceEnts++;
        const cls = ctx.dataTables.classes.find((c) => c.id === classId);
        const changed: string[] = [];
        for (const [k, v] of props) {
          if (snapBefore?.get(k) !== v) changed.push(`${k}=${JSON.stringify(v)}`);
        }
        ctx.trace!.push(
          `    [ENT] 包${ctx.packetIndex} #${entityIndex} ${isEnter ? 'enter' : 'delta'} class=${classId}(${cls?.name ?? '?'}) ` +
            `flat=${flat.length} 起=${before} 消耗=${r.pos - before}位 下标=[${seen.join(',')}] ` +
            `本帧变更=${changed.slice(0, 8).join(' ')}`,
        );
      }
      for (const s of seen) {
        const key = `${classId}:${s}`;
        ctx.indexHistogram.set(key, (ctx.indexHistogram.get(key) ?? 0) + 1);
      }
      continue;
    }
  }
  // **不读「显式删除表」，也不读终止位。** 这块位流的历史裁决经过三轮：
  //   ① 凭空多读一张「`1` + 11 位实体号、遇 `0` 结束」的表（错）；② 按 tf2-demo-parser 的
  //   `PacketEntitiesMessage::parse` 恢复同一张表（对本协议同样是错的）；③ 现状：**不读**。
  // 实证（2026-10-01，`test/replay/auto-20261001-050330-surf_gigapede.dem`，CS:S networkprotocol=24，
  // 工具 `test/replay/dem-probe.html`）：`svc_PacketEntities` 的实体载荷**恰好结束在头部声明的
  // `dataBits` 上**，其后是字节对齐填充（0..7 位）或紧接下一条消息——把「终止位/删除表」读掉会
  // 净消费 1+ 位，使同包后续消息全部错位：59,951 包实测，读表 = 24,378 包中止，不读 = 2 包。
  // 实体删除由记录内的 `FHDR_DELETE` / LeavePVS 标志表达，删除不在包尾另表。
  if (r.overflowed) exitReason = 'readerOverflow';
  if (ctx.trace && stats.entityMessages <= 8) {
    // 判据用：**声明条数 vs 实读条数**、载荷终点与残差、循环出口原因。
    // 若 `声明` 远小于载荷实际能装的记录数，说明 `updatedEntries` 的位置仍不对；
    // 若 `残差` 长期是几百位而非一个小填充值，说明记录边界整体偏移。
    ctx.trace.push(
      `  [PEEND] 包 ${ctx.packetIndex} 声明=${numUpdated} 实读=${decoded} end=${end} 末位=${r.pos} 残差=${end - r.pos} 出口=${exitReason}`,
    );
  }
  stats.loopExit.set(exitReason, (stats.loopExit.get(exitReason) ?? 0) + 1);
  if (r.pos !== end && !r.overflowed) {
    stats.entityPayloadMismatch++;
    const res = end - r.pos;
    if (res < 0) stats.entityOverread++;
    // 残差极小（|res| ≤ 6 位）的消息留痕：这类消息的每条记录至多差 1～2 位，是定位
    // 「字段边界差 1 位」的最小样本 —— 逐条位区间摊开后可直接对账。
    if (ctx.trace && Math.abs(res) <= 6 && ctx.nearMissTraced < 10) {
      ctx.nearMissTraced++;
      ctx.trace.push(
        `  [NEAR] 包 ${ctx.packetIndex} dataBits=${dataBits} 残差=${res} 实读 ${decoded} 条 记录=${recs.join(' ')}`,
      );
    }
    stats.entityResidual.set(res, (stats.entityResidual.get(res) ?? 0) + 1);
    if (!isDelta) stats.entityResidualFull.set(res, (stats.entityResidualFull.get(res) ?? 0) + 1);
    if (numUpdated === 1) stats.entityResidualUpd1.set(res, (stats.entityResidualUpd1.get(res) ?? 0) + 1);
    if (stats.entityMessages <= 4) {
      stats.warnings.push(
        `包 ${ctx.packetIndex}：实体载荷 ${dataStart}..${r.pos}（读 ${r.pos - dataStart} 位），声明 ${dataBits} 位，` +
          `不符 ${r.pos - end}，实体 ${numUpdated} 条（实读 ${decoded}），越界=${r.overflowed}`,
      );
    }
    r.seek(end);
  } else if (!r.overflowed) {
    stats.entityPayloadExact++;
    if (isDelta) stats.entityExactDelta++;
    else stats.entityExactFull++;
  }
}

/**
 * 按属性位图读取一条实体的属性值（协议 24 的 `CDeltaBitsReader` 等价实现）。
 *
 * 协议 24 的方案很直白：**逐属性**读 1 位——`0` 表示属性位图到此结束，`1` 表示「这个属性被发送了」，
 * 随后读一个变长整数 `diff − 1`，属性下标推进 `1 + (diff − 1)`。没有 CS:GO 的 3 位索引增量方案，
 * 也没有固定位宽的下标字段。
 */
/**
 * 诊断：展平序列的**序号偏移**。缺省 0（生产路径）。
 * 用途——实测玩家类扁平下标 5（`m_vecViewOffset[2]`）被下发 1066 次，而 13/14（`m_vecOrigin`）
 * 只出现 1～2 次；移动中的玩家必须持续下发坐标，故怀疑「引擎下标 ↔ 本工程展平下标」整体差 d 格。
 * 置为非 0 时，属性查表改用 `flat[下标 + d]`（名字与位宽一起变，正是要验证的）。
 */
export let flatIndexShift = 0;

/** 诊断：`svc_UpdateStringTable` 消息数与并入的条目数。 */
export let updateStringTableCount = 0;

/** 诊断：字符串表条目逐步位置（闭合校验用）。 */
export const entryStepTrace: string[] = [];
export let updateStringTableEntries = 0;
export const updateStringTableNames = new Map<string, number>();

/** 诊断：类别号位宽的三个候选来源实测值。 */
export const classBitsDiag = { maxClasses: -1, n: -1, classes: -1, bits: -1 };

/** **名称时间线**：记录机器人会**共用同一人物、改名显示当前关卡** ⇒ 名字是时变属性，
 * 必须按 (tick, 槽位) 记录成历史，面板按当前 tick 取用，而不是只留一张快照。 */
export const userinfoTimeline: Array<{ tick: number; entries: Array<{ idx: number; value: Uint8Array }> }> = [];

/** 当前消息的 tick（由 parseSourceDemo 的消息循环写入）。 */
export const currentTickRef = { tick: 0 };

/** 诊断：属性下标越界（`readPropList` 静默返回）的次数与首现位置。 */
export let propIdxOverflowCount = 0;

/** 诊断：「类别未知」首批现场。 */
export const unknownClassTrace: string[] = [];

/** 诊断：该类别扁平表为空而跳过（同样**不消费属性位**）的首批现场。 */
export const emptyFlatTrace: string[] = [];

/** 诊断：属性下标越界的首批现场。 */
export const propIdxOverflowTrace: string[] = [];

/** 诊断：`Leave` 分支命中次数（该分支会**删除实体登记**）。 */
export let leaveBranchCount = 0;

/** 诊断：`Delete` 标志命中次数。 */
export let deleteBranchCount = 0;

/**
 * 诊断钩子：`decodeProp` 的 Vector 分支每次落地时回调（属性名、分支名、消耗位数）。
 *
 * 动机：`m_vecOrigin`（Vector / `0x404` / `numBits=96`）在隔离单元测试里**正确消耗 96 位**，
 * 但在实体记录里实测**只消耗 17 位** —— 五条外围解释已逐一排除，只剩「运行时实际走了哪一支」
 * 未验证。此前一直是从标志位**推理**分支，此钩子让运行时**自报**。缺省 `null`，不影响生产路径。
 */
export let onVectorBranch: ((name: string, branch: string, bits: number, ovf: boolean) => void) | null = null;

/** 设置该诊断钩子。 */
export function setOnVectorBranch(fn: typeof onVectorBranch): void {
  onVectorBranch = fn;
}

/** 诊断：`m_nTickBase` 的读取位宽（0 = 用发送表声明值）。 */
export let tickBaseBits = 0;

/** 设置该诊断开关。 */
export function setTickBaseBits(v: number): void {
  tickBaseBits = v;
}

/** 诊断：NOSCALE 向量是否改按定点坐标读（见 `decodeProp` 的 Vector 分支）。 */
export let vectorNoScaleAsCoord = false;

/** 设置该诊断开关。 */
export function setVectorNoScaleAsCoord(v: boolean): void {
  vectorNoScaleAsCoord = v;
}

/**
 * `untilEnd` 口径下的循环停止阈值（剩余位数小于它就停）。缺省 8（= 一条最小实体头的位数）。
 * 诊断开关：实测多读恒为 7 位、且与类别/属性无关，而 7 与「阈值 8」只差 1，故扫描该阈值。
 */
export let entityStopThreshold = 8;

/** 设置循环停止阈值（见 `entityStopThreshold`）。 */
export function setEntityStopThreshold(v: number): void {
  entityStopThreshold = v;
}

/**
 * 是否解码 `svc_UpdateStringTable` 的 `userinfo` 条目（缺省 true）。
 *
 * 诊断开关：用于二分定位「玩家类轨迹消失」的来源 —— 关掉后只按（夹住的）长度跳过数据段。
 */
export let decodeUpdateEntries = true;

/** 设置是否解码更新条目（见 `decodeUpdateEntries`）。 */
export function setDecodeUpdateEntries(v: boolean): void {
  decodeUpdateEntries = v;
}

/**
 * 诊断：字符串表**更新**条目流的起始偏移（位，可负）。缺省 0。
 *
 * 背景：`svc_UpdateStringTable` 的消息类型（13）与表号（7 = `userinfo`）已用原始位流逐位证实，
 * 表号之后那 16 位（实测恒为 1081）判定为**数据段位长**，但条目流起点仍未定死 —— 实测按当前起点
 * 一条更新条目都解不出可读名字。此开关用于对该起点做有界扫描，判据是「`userinfo` 里出现可打印
 * 玩家名」。扫描是安全的：并入前有 `plausibleName` 闸门，解错不会污染已有数据。
 */
export let updateEntryShift = 0;

/** 设置更新条目流起始偏移（见 `updateEntryShift`）。 */
export function setUpdateEntryShift(v: number): void {
  updateEntryShift = v;
}

/** 设置展平序号偏移（见 `flatIndexShift`）；返回旧值。 */
export function setFlatIndexShift(v: number): number {
  const old = flatIndexShift;
  flatIndexShift = v;
  return old;
}

export function readPropList(
  r: BitReader,
  flat: FlatProp[],
  out: EntityProps,
  legacyOrder: boolean,
  seen?: number[],
  steps?: string[],
): void {
  let index = -1;
  for (let guard = 0; guard < 1 << 17; guard++) {
    if (!legacyOrder) {
      // 协议 24：0 = 位图结束；1 = 下标推进 1 + uBitVar
      if (r.bit() === 0) return;
      index += 1 + r.uBitVar();
      if (seen) seen.push(index);
      if (index >= flat.length) {
        propIdxOverflowCount++;
        if (propIdxOverflowTrace.length < 10) {
          propIdxOverflowTrace.push(`下标=${index} 表长=${flat.length} 位=${r.pos}`);
        }
        return;
      }
    } else {
      // 对照用（CS:GO 风格的极性），仅诊断开关会走到
      if (r.bit() === 0) index++;
      else index = r.uBitVar() + 1;
      if (index < 0 || index >= flat.length) return;
    }
    if (r.overflowed) return;
    // 诊断序号偏移（缺省 0）：改查表下标 = 同时改属性名与位宽，用于验证「引擎下标与本工程差 d 格」
    if (flatIndexShift !== 0) {
      index += flatIndexShift;
      if (index < 0 || index >= flat.length) return;
    }
    const itemStart = r.pos;
    const value = decodeProp(flat[index].prop, r, flat[index].elementProp, flat[index].vectorElems);
    if (steps) {
      const pd = flat[index].prop;
      // 同时打出**定义本身**（类型 / 标志 / 位宽）与本次 `flat` 的长度：用来判定「同一下标在不同帧
      // 是否拿到了不同定义」—— 实测 `m_vecOrigin` 的值位宽在帧间出现 17 位与 96 位两种，而静态表项
      // 本不该变，故必须把定义一并留痕。
      steps.push(
        `${index}:${pd.name}(t=${pd.type},f=0x${pd.flags.toString(16)},n=${pd.numBits ?? '-'},len=${flat.length})[${itemStart}..${r.pos}]=${JSON.stringify(value).slice(0, 24)}`,
      );
    }
    out.set(flat[index].prop.name, value);
    // 同名属性可能有多份（如 localdata / nonlocaldata 各有一个 `m_vecOrigin`）：按「名#扁平下标」
    // 再存一份，调用方据此取到确定的那一份。
    out.set(`${flat[index].prop.name}#${index}`, value);
  }
}

/** 属性值解码；返回数值 / 向量 / 字符串。 */
export function decodeProp(
  p: SendProp,
  r: BitReader,
  element?: SendProp,
  vectorElems?: SendProp[],
): number | number[] | string {
  // 向量元素组：先读 n 位「元素是否发送」位图，再按序读被发送元素的值
  if (vectorElems && vectorElems.length > 0) {
    const present: boolean[] = [];
    for (let i = 0; i < vectorElems.length; i++) present.push(r.bit() !== 0);
    const out: number[] = new Array(vectorElems.length).fill(0);
    for (let i = 0; i < vectorElems.length; i++) {
      if (!present[i]) continue;
      const v = decodeProp(vectorElems[i], r);
      out[i] = typeof v === 'number' ? v : 0;
    }
    return out;
  }
  switch (p.type) {
    case PropType.Int:
      // **诊断**：`m_nTickBase` 的读取位宽（`tickBaseBits` 为 0 时用发送表声明值）。
      // 动机：实测它每帧都下发、值也正确（78/80/82…，高位全 0），但**紧随其后的属性下标会冒出
      // 1053 这种 ≥ 扁平表长度（634）的垃圾值** —— 「值对而流崩」正是「多读了若干位、但那些位恰为 0」
      // 的典型形态。此分支用于扫描位宽，判定它是否为主因。
      if (tickBaseBits > 0 && p.name === 'm_nTickBase') return r.s(tickBaseBits);
      // `SPROP_VARINT` 复用 `SPROP_NORMAL` 位：值为变长整数
      if ((p.flags & SPROP.NORMAL) !== 0) return decodeVarInt(p, r);
      return (p.flags & SPROP.UNSIGNED) !== 0
        ? r.u(p.numBits || 32)
        : r.s(p.numBits || 32);
    case PropType.Float:
      return decodeFloat(p, r);
    case PropType.Vector: {
      // 诊断钩子：让运行时**自报**走了哪一支、消耗多少位（此前一直是按标志位推理，见 `onVectorBranch`）。
      const vbStart = r.pos;
      const vb = (branch: string, v: string | number | number[]): string | number | number[] => {
        if (onVectorBranch) onVectorBranch(p.name, branch, r.pos - vbStart, r.overflowed);
        return v;
      };
      if ((p.flags & SPROP.NORMAL) !== 0) return vb('NORMAL', r.vec3Normal());
      // `SPROP_COORD` 的向量是**逐轴**定点坐标（三轴各一次 ReadBitCoord），
      // 不是 `WriteBitVec3Coord` 的「三轴存在位 + 各轴坐标」形式——用 7 条类别基线实测判定。
      if ((p.flags & SPROP.COORD) !== 0) return vb('COORD', [r.coord(), r.coord(), r.coord()]);
      // **多人坐标变体（玩家 `m_vecOrigin` 走的就是这几支）**：`SPROP_COORD_MP` / `_LOWPRECISION` /
      // `_INTEGRAL`（`dt_common.h` 的 `1<<13` / `1<<14` / `1<<15`）。整型变体**没有小数位**。
      // 早先这里只认 `SPROP_COORD`，玩家坐标因此落到下面的 `decodeFloat` 分支 —— 实测解出
      // `9.19e-41`、`-2.23e-18`、`1.76e11` 这类非规格化/巨大值（位数读飞），位置自然是噪声。
      if ((p.flags & SPROP.COORD_MP_INTEGRAL) !== 0) {
        return vb('MP_INTEGRAL', [r.coordMp(true, false), r.coordMp(true, false), r.coordMp(true, false)]);
      }
      if ((p.flags & SPROP.COORD_MP_LOWPRECISION) !== 0) {
        return vb('MP_LOW', [r.coordMp(false, true), r.coordMp(false, true), r.coordMp(false, true)]);
      }
      if ((p.flags & SPROP.COORD_MP) !== 0) {
        return vb('MP', [r.coordMp(false, false), r.coordMp(false, false), r.coordMp(false, false)]);
      }
      // **向量的位宽是「三轴合计」**（权威实现把向量记成 `32*3`，其 `Display` 再 `/3` 显示）。
      // 故逐轴解码时必须除以 3 —— 早先直接拿 `p.numBits`（96）当**单轴**位宽用，每轴读 96 位，
      // 位流立刻读飞：实测 `m_vecOrigin` 解出 `9.19e-41` / `-2.23e-18` / `1.76e11` 这类值。
      // **权威语义：向量的解析定义就是一个 `FloatDefinition`，逐轴套用** —— 即 `numBits` 是
      // **每轴**的位宽，不是三轴合计（参考实现的 `SendPropParseDefinition::Vector` 里装的正是
      // `FloatDefinition`）。故这里不做均分、也不做总量校正，把原定义直接交给逐轴解码：
      // NOSCALE 向量（`numBits` 记作 `32*3` 只是展示约定）在 `decodeFloat` 里因 `bits >= 32`
      // 走 32 位浮点 ✓；量化向量（如 `m_angRotation` 的 `numBits=13`）则**每轴各读 13 位**。
      const axis: SendProp = p;
      // **诊断开关**：NOSCALE 向量改按定点（`coord()`）读，用来判定线上到底是哪一种编码。
      // 判据：若改后属性下标列表不再冒出 ≥ 扁平表长度的垃圾值（实测出现 1053，而表长 634），
      // 说明定点才是对的；反之维持定长 32 位浮点。
      if (vectorNoScaleAsCoord) return vb('COORD_FORCED', [r.coord(), r.coord(), r.coord()]);
      const vOut = vb('SCALED', [decodeFloat(axis, r), decodeFloat(axis, r), decodeFloat(axis, r)]);
      return vOut;
    }
    case PropType.VectorXY:
      return [decodeFloat(p, r), decodeFloat(p, r)];
    case PropType.String: {
      const n = r.u(9);
      // **必须按 UTF-8 解码**：早先逐字节 `String.fromCharCode(r.u(8))` 等于按 Latin-1 解释，
      // 多字节字符全成乱码 —— 实测 `m_szClan` 里应有的 `主关卡 48.505 | tl` 解出 `48ï¼ - N`
      // 这种形态（`ï¼` 正是 `％`(U+FF05 = EF BC 85) 被当 Latin-1 的结果），玩家名因此不可读。
      const raw = new Uint8Array(n);
      for (let i = 0; i < n; i++) raw[i] = r.u(8);
      return new TextDecoder('utf-8', { fatal: false }).decode(raw);
    }
    case PropType.Array: {
      // 先读本帧实际元素个数（`Q_log2(numElements)+1` 位），再逐元素按模板解码
      const cap = p.numElements ?? 0;
      const n = r.u(qLog2Plus1(cap));
      const out: number[] = [];
      if (!element) return out; // 缺元素模板时只消费长度字段，避免自递归
      for (let i = 0; i < n; i++) {
        const v = decodeProp(element, r, undefined);
        out.push(typeof v === 'number' ? v : 0);
      }
      return out;
    }
    default:
      return 0;
  }
}

/**
 * `SPROP_VARINT` 的读法。取 `'leb128'`——逐字节 7 位小端变长整数（引擎的 `ReadVarInt32` /
 * `WriteVarInt32`）。判据：7 条类别基线全部逐位吻合，且 `m_iHealth` 解出 100 量级的合理生命值；
 * 换成 `ReadUBitVar()`（2 位编码 + 4/8/12/32 位值）则基线只剩 6/7 且生命值变成 20 亿量级的乱码。
 */
export let varIntMode: 'ubitvar' | 'leb128' = 'leb128';

/** 设置 `SPROP_VARINT` 读法。 */
export function setVarIntMode(m: 'ubitvar' | 'leb128'): void {
  varIntMode = m;
}

/** `SPROP_VARINT` 整数解码。 */
function decodeVarInt(p: SendProp, r: BitReader): number {
  if (varIntMode === 'leb128') {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = r.u(8);
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return (p.flags & SPROP.UNSIGNED) !== 0 ? v >>> 0 : v | 0;
  }
  return r.uBitVar();
}

/** 浮点属性解码（规则见文件头注释）。 */
function decodeFloat(p: SendProp, r: BitReader): number {  const f = p.flags;
  if ((f & SPROP.COORD) !== 0) return r.coord();
  if ((f & SPROP.COORD_MP_INTEGRAL) !== 0) return r.coordMp(true, false);
  if ((f & SPROP.COORD_MP_LOWPRECISION) !== 0) return r.coordMp(false, true);
  if ((f & SPROP.COORD_MP) !== 0) return r.coordMp(false, false);
  if ((f & SPROP.NOSCALE) !== 0) return r.f32();
  // 权威 `FloatDefinition::new` 的第 6 支：`SPROP_NORMAL`（0x20，即 `SPROP_VARINT`）在浮点上
  // 表示**变长浮点**。Int 侧早已按此分流，Float 侧此前缺这一支。**本录像实测：全类别中
  // 「Float 且带 0x20」为 0 个**，故它不是本录像错位的原因，但补上以免在别的录像上静默读错。
  if ((f & SPROP.NORMAL) !== 0) return decodeVarInt(p, r);
  const bits = p.numBits ?? 0;
  // `numBits <= 0`（发送表里写作 -1）或 >= 32 都表示「不量化，直接 32 位浮点」
  if (bits <= 0 || bits >= 32) return r.f32();
  const iHigh = Math.pow(2, bits) - 1;
  const range = (p.highValue ?? 0) - (p.lowValue ?? 0);
  if (range === 0) return p.lowValue ?? 0;
  const mul = Math.fround(Math.fround(iHigh) / Math.fround(range));
  const raw = r.u(bits);
  return Math.fround(p.lowValue ?? 0) + Math.fround(raw / mul);
}
