/**
 * 录像信息条（底部 dock 上层的**录像会话专属**展示位）：`.dem` 里那些**只有 Source 录像才有**的
 * 事实——服务器身份 / 天空盒 / 协议号 / 事件与自定义消息 / 实体流规模 / 字符串表 / 包走读。
 *
 * 与记录信息条（`apps/viewer/src/ui/replaymeta.ts`）的关系：**同一个位置、同一套类名契约**
 * （`info-strip` / `mi` / `mk` / `mv` / `headline`，见 `apps/viewer/web/styles.css`），但数据源、
 * 字段集合、甚至「什么时候有值」都完全不同 —— 记录条读的是跟随轨道的 `Clip.meta`（Shavit 文件头），
 * 录像条读的是 `DemoParseResult`（`.dem` 解析产物）。两条各挂在自己会话的 dock 容器里
 * （`#replayMeta` / `#demoInfo`），互不写对方。
 *
 * **只渲染一次**：这些量在一份录像里是常量（解析完成即定），故在载入完成时整条重建、不进每帧刷新；
 * 唯一按播放头变的是「在服」那类信息，它归录像看板 `apps/viewer/src/replay/demopanel.ts` 管。
 *
 * 取值原则：**条面上只放「一眼有用」的**，长的、逐项的、诊断性的（字符串表清单、用户消息直方图、
 * 包失败分类、实体流残差、每位玩家的 guid/userID）全部进悬停 `title` —— 条面是影院门口的海报，
 * title 是放映间的技术单。
 */

import { el } from '../core/dom.js';
import type { DemoParseResult } from '../replay/demo/demo.js';
import { NetMsgType } from '../replay/demo/net.js';

/** 一条录像信息条的输入（由录像看板在解析完成后推入）。 */
export interface DemoMetaInfo {
  /** 文件名（条面用它的短名，完整名进 title）。 */
  fileName: string;
  /** 解析产物。 */
  result: DemoParseResult;
  /** 花名册人数（按身份去重后的行数）；看板还没算出来时传 0。 */
  rosterCount: number;
}

export class DemoMetaStrip {
  constructor(private readonly root: HTMLElement) {}

  /**
   * 载入完成后调用；传 `null`（或解析失败）时清空并加 `hidden` 类。
   * 无解析产物就没有任何可展示的 `.dem` 事实，此时**整条隐藏**，不摆一排空标签。
   */
  set(info: DemoMetaInfo | null): void {
    if (!info) {
      this.root.classList.add('hidden');
      this.root.replaceChildren();
      return;
    }
    this.root.classList.remove('hidden');
    this.root.replaceChildren(this.buildName(info.fileName), ...this.buildItems(info));
  }

  /** 名称位：与记录条同构（色点 + 名字），但录像会话只有一条轨道，故不画轨道色点。 */
  private buildName(fileName: string): HTMLElement {
    const wrap = el('span', 'meta-name');
    const name = el('span', undefined, fileName);
    name.title = '录像信息条展示这份 .dem 的解析事实（服务器 / 协议 / 事件 / 实体流 / 字符串表）';
    wrap.append(name);
    return wrap;
  }

  /** 条面字段（标签 + 值）。标签沿用记录条的 `.mk` / `.mv` 语彙。 */
  private buildItems(info: DemoMetaInfo): HTMLElement[] {
    const { result, rosterCount } = info;
    const h = result.header;
    const st = result.stats;
    const items: HTMLElement[] = [];
    const add = (k: string, v: string, title?: string, headline = false): void => {
      const item = el('span', 'mi' + (headline ? ' headline' : ''));
      item.append(el('span', 'mk', k), el('span', 'mv', v));
      if (title) item.title = title;
      items.push(item);
    };
    const count = (type: NetMsgType): number => st.seenByType[String(type)] ?? 0;

    // ① 服务器身份：**两个来源并不相同**，条面用文件头那个（它是给人看的服务器名），
    //    内层 `svc_ServerInfo.hostName` 进 title —— 两者混为一谈会让读者以为是同一个字段。
    const si = result.serverInfo;
    add(
      '服务器',
      h.serverName || '（文件头无服务器名）',
      `文件头 serverName；录制客户端 ${h.clientName || '—'}；游戏目录 ${h.gameDirectory || si?.gameDir || '—'}` +
        (si ? `；svc_ServerInfo.hostName = ${si.hostName}` : '；本录像没有 svc_ServerInfo 消息'),
      true,
    );
    add(
      '地图',
      h.mapName || '—',
      si && si.mapName !== h.mapName ? `文件头地图名；svc_ServerInfo 自报 ${si.mapName}` : '文件头地图名',
    );
    // ② 天空盒：`.dem` 里**唯一**来源是 svc_ServerInfo，解析层早先把它连同整条消息一起丢掉了。
    if (si) add('天空', si.skyName || '—', 'svc_ServerInfo 的 skyName —— .dem 里只有这一处记录天空盒');
    const tickHz = h.playbackTime > 0 ? Math.max(1, h.playbackTicks) / h.playbackTime : 1;
    add(
      '协议',
      `演示 ${h.demoprotocol} / 网络 ${h.networkprotocol}`,
      (si ? `svc_ServerInfo 内层协议 ${si.protocol}；服务器类别数上限 ${si.maxClasses}` : '未收到 svc_ServerInfo') +
        `；tick 率 ${tickHz.toFixed(2)} /s（间隔 ${(1000 / tickHz).toFixed(1)} ms）`,
    );
    add('时长', fmtClock(h.playbackTime), `头部 playbackTime；共 ${h.playbackTicks} tick / ${h.playbackFrames} 帧`);
    // 录制者机位（`democmdinfo`）：**这是「有没有第一人称视角可用」的直接答案**。
    // 实测 SourceTV 观察者录像里每条都是 0 ⇒ 记录本身没记，而不是解析漏读（两者必须分清）。
    // 玩家视角与此无关，由实体流采出的轨迹给（看板点人 = 换看谁）。
    const cam = result.cameraSamples;
    add(
      '录制机位',
      cam.nonZero > 0 ? `已记录 ${cam.nonZero}/${cam.samples} 条` : `未记录（${cam.samples} 条全 0）`,
      '每条 dem_signon / dem_packet 头部的 democmdinfo（viewOrigin / viewAngles）；' +
        (cam.first
          ? `首条 origin [${cam.first.origin.map((v) => v.toFixed(1)).join(', ')}] angles [${cam.first.angles
              .map((v) => v.toFixed(1))
              .join(', ')}]；末条 origin [${cam.last?.origin.map((v) => v.toFixed(1)).join(', ')}]`
          : '本录像没有可读的 democmdinfo') +
        '。玩家视角是另一回事：由实体流采出的轨迹给（看板点人 = 换看谁）',
    );
    add(
      '实体流',
      `${st.entityMessages} 条 / ${st.entityUpdates} 次`,
      `svc_PacketEntities 消息数 / 声明实体更新数；类别 ${result.dataTables.classes.length} 个、` +
        `结束时在表实体 ${result.entityCount} 个、玩家类实体 ${result.players.length} 条` +
        `；载荷恰好用尽 ${st.entityPayloadExact} / 不齐 ${st.entityPayloadMismatch}；类别未知 ${st.entityUnknownClass}；` +
        `多为 ${st.entityOverread} / 越界 ${st.entityOverflow} / 删除条目 ${st.entityDeletes}`,
    );
    // ③ 玩家：**签名表条数**与**花名册人数**是两个口径（前者含同一台机器人的多次改名行），
    //    如实并列，避免「玩家 14 位」与看板上 5 行对不上时被当成 bug。
    add(
      '玩家',
      `${rosterCount} 位 / 签名表 ${result.playerInfos.length} 条`,
      '花名册按身份去重后的人数 / player_info_s 条目数（同一台机器人改名、真人跨槽位都会让后者更多）' +
        `；玩家类轨迹 ${result.players.length} 条`,
    );
    // ④ 事件与自定义消息：`.dem` 特有（记录格式里没有这两个概念）。
    const events = count(NetMsgType.GameEvent);
    add(
      '事件',
      events > 0 ? `${events} 次` : '无',
      `svc_GameEvent ${events} 次；svc_GameEventList ${count(NetMsgType.GameEventList)} 次` +
        (count(NetMsgType.GameEventList) === 0 ? '（事件表未随录像下发 ⇒ 事件名与字段无从还原）' : ''),
    );
    const um = Object.entries(st.userMessageById)
      .map(([id, n]) => [Number(id), n] as const)
      .sort((a, b) => b[1] - a[1]);
    const umText = um.length > 0 ? um.map(([id, n]) => `id${id}×${n}`).join('、') : '无';
    add(
      '聊天',
      `${result.chat.length} 条`,
      `svc_UserMessage 直方图：${umText}；其中 id4 = SayText2（已解码为可读文本并**逐条带 tick**，其余 id 的布局随 mod 而异，整段跳过）` +
        `；svc_Print / svc_StringCmd / svc_Disconnect 共 ${count(NetMsgType.Print) + count(NetMsgType.StringCmd)} 条`,
    );
    add(
      '字符串表',
      `${result.stringTables.length} 张`,
      `dem_stringtables ${result.stringTables.length} 张；网络流 svc_CreateStringTable ${result.packetStringTables.length} 张` +
        `；清单：${result.stringTables.map((t) => `${t.name}(${t.entries.size})`).join('、')}`,
    );
    add(
      '包',
      `${st.packetsParsed} / ${st.packetsParsed + st.packetsFailed}`,
      `成功解析 / 全部（${fmtPercent(st.packetsParsed, st.packetsFailed)}）；失败分类：${
        Object.entries(st.failureByType)
          .map(([k, v]) => `${k}×${v}`)
          .join('、') || '无'
      }；signon 数据 ${h.signonLength} 字节`,
    );
    return items;
  }
}

/** 秒 → `m:ss`（与时间轴的录像读数同口径，便于条面与滑杆对着读）。 */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `a / (a+b)` 的百分比（保留 1 位小数）；分母为 0 时写 `—`。 */
function fmtPercent(a: number, b: number): string {
  const total = a + b;
  return total > 0 ? `${((a / total) * 100).toFixed(1)}%` : '—';
}
