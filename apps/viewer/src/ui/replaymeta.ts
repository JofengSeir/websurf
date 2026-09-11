/**
 * 录像信息条（底部 dock 上层）：.replay 头部元信息的常驻展示位。
 *
 * 数据源 = t3 暴露的 `Clip.meta`（ReplayHeaderMeta，replay-file.inc FINAL 头部字段）。
 * 字段是静态的——只在轨道增删 / 跟随切换时重渲染，不进每帧刷新。
 * 文件里只有 steamID 没有人名（t2 规格）：玩家位显示 `[U:1:<id>]` 并用 title 说明。
 */

import { el } from '../core/dom.js';
import type { ReplayHeaderMeta, Track } from '../replay/types.js';

export class ReplayMetaPanel {
  constructor(private readonly root: HTMLElement) {}

  /**
   * 轨道增删 / 跟随切换后调用（app.syncTracks）。
   * 展示跟随轨道（无跟随回退第一条）的头部元信息；没有带元信息的轨道时整条隐藏。
   */
  setTracks(tracks: readonly Track[], followId: string | null): void {
    const follow = tracks.find((t) => t.id === followId) ?? tracks[0] ?? null;
    const meta = follow?.clip.meta ?? null;
    if (!follow || !meta) {
      this.root.classList.add('hidden');
      this.root.replaceChildren();
      return;
    }
    this.root.classList.remove('hidden');
    this.root.replaceChildren(this.buildName(follow), ...this.buildItems(meta));
  }

  /** 色点 + 轨道名：标明这条信息是谁的（跟随轨道，与轨迹列表一致）。 */
  private buildName(track: Track): HTMLElement {
    const wrap = el('span', 'meta-name');
    const dot = el('span', 'meta-dot');
    dot.style.background = '#' + track.color.toString(16).padStart(6, '0');
    dot.title = '轨迹配色（与轨迹列表一致）';
    const name = el('span', undefined, track.name);
    name.title = '录像信息条展示跟随轨道的头部元信息（轨迹列表「◎」可切换）';
    wrap.append(dot, name);
    return wrap;
  }

  /** 头部字段 → 标签值对；文件里没有的字段（人名 / V2 无成绩）不硬造，直接不出该项。 */
  private buildItems(meta: ReplayHeaderMeta): HTMLElement[] {
    const items: HTMLElement[] = [];
    const add = (k: string, v: string, title?: string, headline = false): void => {
      const item = el('span', 'mi' + (headline ? ' headline' : ''));
      item.append(el('span', 'mk', k), el('span', 'mv', v));
      if (title) item.title = title;
      items.push(item);
    };

    if (meta.time !== null) {
      // zoneOffset（<v8 无 → [0,0]）是亚 tick 份额（非秒）：有值时并入 title，不上条面（视觉从简）
      const [zo0, zo1] = meta.zoneOffset;
      const zoneDetail =
        zo0 !== 0 || zo1 !== 0
          ? `；zone 亚 tick 份额：起 ${zo0.toFixed(3)} / 终 ${zo1.toFixed(3)}（fTime ≈ (frameCount + 起 − (1 − 终)) × 帧间隔）`
          : '';
      add('成绩', `${meta.time.toFixed(2)} s`, `头部 fTime：官方计时成绩（含 zone 口径）${zoneDetail}`, true);
    }
    if (meta.steamIdDisplay) {
      add('玩家', meta.steamIdDisplay, `文件只记录账号 ID（steamID3 = ${meta.steamId ?? '—'}），不含玩家名`);
    }
    if (meta.map) {
      const where = meta.track > 0 ? `${meta.map} · Bonus ${meta.track}` : meta.map;
      add(
        '地图',
        where,
        meta.track > 0
          ? '文件名 _N 后缀是 bonus 轨道号，不是地图名的一部分'
          : '头部地图名（基础名，不含 _N 后缀）',
      );
    }
    add('风格', String(meta.style), 'Shavit style id（0 = 默认风格）');
    add('tick', meta.tickrate.toFixed(2), 'tick/s——帧率基准，帧间隔 = 1/tick');
    add(
      '帧',
      `${meta.preFrames}+${meta.frameCount}+${meta.postFrames}`,
      // stage>0 属跑段细节：进悬停 title，不占条面（t11 拍板③「从简」）
      `起跑前 + 正式跑 + 结束后（帧数，合计 ${meta.totalFrames}）；主时钟 0 = 起跑帧，prerun 不在播放区间` +
        (meta.stage > 0 ? `；stage 跑段 ${meta.stage}` : ''),
    );
    if (meta.timestamp !== null) {
      add('日期', fmtDate(meta.timestamp), '创纪录时间（头部 Unix 时间戳；旧版本用文件时间兜底）');
    }
    add(
      '格式',
      `v${meta.version}`,
      // offsetsLength>0 属格式内部细节：进悬停 title，不占条面（t11 拍板③「从简」）
      (meta.format === 'v2'
        ? 'V2 旧格式（带 tickrate 估算，见导入警告）'
        : `Shavit FINAL 格式版本 0x${meta.version.toString(16).toUpperCase().padStart(2, '0')}`) +
        (meta.offsetsLength > 0
          ? `；fail-replay offsets 记录 ${meta.offsetsLength - 1} 条（解析时已跳过该区）`
          : ''),
    );
    return items;
  }
}

/** Unix 秒 → 本地 YYYY-MM-DD。 */
function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
