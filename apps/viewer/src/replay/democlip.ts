/**
 * Source `.dem`（录像）→ viewer `Clip` 的桥接层。
 *
 * 上游是 `apps/viewer/src/replay/demo/demo.ts` 的 `parseSourceDemo`：它解出 `.dem` 的容器帧、
 * 发送表、类别表、字符串表与逐帧实体属性，并采出每条实体轨迹（`PlayerTrack`：tick + 世界坐标 +
 * 偏航/俯仰 + 生命值/队伍）。本模块把这些轨迹转成 viewer 既有的 `Clip` 契约，使 DEM 与 Shavit
 * `.replay` 走同一条渲染/时间轴/多轨道链路（`apps/viewer/src/replay/types.ts` 的 `Clip`）。
 *
 * 坐标与朝向口径与 Shavit 路径保持一致（`apps/viewer/src/replay/types.ts` 的 `AxesMode` /
 * `YawMode` 缺省档）：
 * - 坐标：Source `[x,y,z]` → viewer `[y,z,x]`（与地图 GLB 导出的 `rotate_yup` 同构）；
 * - 朝向：`yaw = wrapDeg(srcYaw + 180)`、`pitch = −srcPitch`（Source 俯仰正值为俯视）、roll 恒 0。
 *
 * 一条实体轨迹 → 一份 `Clip`；`meta` 复用 `ReplayHeaderMeta` 形状（地图/时长/tick 率等），
 * 使 `apps/viewer/src/ui/replaymeta.ts` 无需改动即可显示 DEM 的元信息。
 */

import type { Clip, ReplayHeaderMeta, RuleConfig } from './types.js';
import { defaultRule } from './types.js';
import type { DemoParseResult, PlayerTrack } from './demo/demo.js';

/**
 * 瞬移判据（单位/秒）：相邻两帧的速率超过它就不当作速度（重生 / 换图 / 观察者跳转）。
 * CS:S 正常冲刺量级 250~3000 u/s，实测这份录像的相邻位移离群点达 ≈92 万 u/s，两者之间留足余量。
 */
const TELEPORT_SPEED = 5000;

/** 桥接选项。 */
export interface DemoClipOptions {
  /** 只保留采样点不少于该值的轨迹（缺省 2：单点轨迹无法播放）。 */
  minSamples?: number;
  /** 轨迹名生成器（缺省用「类别名 #实体号」）。 */
  nameOf?: (track: PlayerTrack) => string;
  /** 规则快照写进 clip（缺省 `defaultRule()`）。 */
  rule?: RuleConfig;
}

/** 把 Demo 解析结果里的实体轨迹转成 `Clip` 列表。 */
export function demoTracksToClips(result: DemoParseResult, opts: DemoClipOptions = {}): Clip[] {
  const minSamples = opts.minSamples ?? 2;
  const rule = opts.rule ?? defaultRule();
  const clips: Clip[] = [];
  for (const track of result.players) {
    if (track.samples.length < minSamples) continue;
    const clip = trackToClip(track, result, rule, opts.nameOf ?? defaultNameOf(result));
    clips.push(clip);
  }
  return clips;
}

/**
 * 缺省命名：能查到玩家名（`userinfo` 的槽号 + 1 = 实体号）就用
 * `玩家名 · 类别名`，查不到退回 `类别名 #实体号`。这样多人录像的轨道列表能直接读出「谁是谁」。
 */
function defaultNameOf(result: DemoParseResult): (t: PlayerTrack) => string {
  return (t) => {
    const who = result.playerNames.get(t.entityIndex);
    return who ? `${who} · ${t.className}` : `${t.className} #${t.entityIndex}`;
  };
}

/** 单条轨迹 → 单份 `Clip`。 */
export function trackToClip(
  track: PlayerTrack,
  result: DemoParseResult,
  rule: RuleConfig,
  nameOf?: (t: PlayerTrack) => string,
): Clip {
  const samples = [...track.samples].sort((a, b) => a.tick - b.tick);
  const n = samples.length;
  // tick 间隔由文件头的「播放时长 / 总 tick 数」推出（头部不直接记 tick 率）
  const tickInterval =
    result.header.playbackTicks > 0 ? result.header.playbackTime / result.header.playbackTicks : 1 / 66;
  const t0 = samples[0].tick;

  const t = new Float64Array(n);
  const pos = new Float32Array(n * 3);
  const ang = new Float32Array(n * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    // **绝对时间轴**：帧时间 = 该帧在**整段录像**里的时刻，而不是「相对本实体首个采样」。
    // 录像是一段长会话（这份近一小时），玩家在中途才进服；若用相对时间，选中他之后
    // 进度条会被压成他那一段（owner 实测到的「点了人物整个进度条都变了」），也就看不出
    // 「他在整场里的哪个位置」。绝对时间 + 轨道偏移恒 0 ⇒ 进度条始终是整场，
    // 人物只在他在场的那一段里有数据。
    t[i] = s.tick * tickInterval;
    // Source [x,y,z] → viewer [y,z,x]
    const vx = s.pos[1];
    const vy = s.pos[2];
    const vz = s.pos[0];
    pos[i * 3] = vx;
    pos[i * 3 + 1] = vy;
    pos[i * 3 + 2] = vz;
    if (vx < min[0]) min[0] = vx;
    if (vy < min[1]) min[1] = vy;
    if (vz < min[2]) min[2] = vz;
    if (vx > max[0]) max[0] = vx;
    if (vy > max[1]) max[1] = vy;
    if (vz > max[2]) max[2] = vz;
    ang[i * 3] = wrapDeg(s.yaw + 180);
    ang[i * 3 + 1] = clampPitch(-s.pitch);
    ang[i * 3 + 2] = 0;
  }

  const meta: ReplayHeaderMeta = {
    version: 0,
    format: 'final',
    map: result.header.mapName,
    style: 0,
    track: 0,
    preFrames: 0,
    frameCount: n,
    postFrames: 0,
    totalFrames: n,
    time: t[n - 1],
    steamId: null,
    steamIdDisplay: null,
    tickrate: tickInterval > 0 ? 1 / tickInterval : 0,
    zoneOffset: [0, 0],
    stage: 0,
    timestamp: null,
    offsetsLength: 0,
  };

  // **速度由位置差分补出**：`.dem` 的实体流只给位姿，没有速度字段，而下游有三处依赖它——
  // 遥测的速度读数与电平表（`apps/viewer/src/ui/telemetry.ts` 的 `update` 以 `s?.vel` 为门）、
  // 以及按键反推（`apps/viewer/src/replay/keyguess.ts`）。
  //
  // **差分必须跨"上一次位置真正变化"的采样，不能只看相邻一条。**
  // 实测（`sampleMode: 'posed'`）：每个实体逐 tick 都记一条采样，但姿态只在**约 1.2%** 的帧
  // 真正更新，其余帧是**原样重复**（`Δpos = 0`）。若按相邻帧差分，98.8% 的帧会得到 0 速度
  // —— 表现就是「速度读数恒为 0｜0、电平表与按键永不亮」（owner 实测，也是这一摊问题的总根源）。
  // 口径：位置没变 ⇒ 沿用上一帧的速度（保持"此刻仍在以该速度运动"的语义）；
  // 位置变了 ⇒ 用「上次变化点到本次」的时间跨度求平均速度。
  const vel = new Float32Array(n * 3);
  let maxSpeed = 0;
  let anchor = 0; // 上一次位置真正变化的下标
  for (let i = 1; i < n; i++) {
    const same =
      pos[i * 3] === pos[(i - 1) * 3] &&
      pos[i * 3 + 1] === pos[(i - 1) * 3 + 1] &&
      pos[i * 3 + 2] === pos[(i - 1) * 3 + 2];
    if (same) {
      // 重复帧：继承上一帧的速度
      vel[i * 3] = vel[(i - 1) * 3];
      vel[i * 3 + 1] = vel[(i - 1) * 3 + 1];
      vel[i * 3 + 2] = vel[(i - 1) * 3 + 2];
      continue;
    }
    const dt = t[i] - t[anchor];
    if (!(dt > 1e-6)) {
      anchor = i;
      continue;
    }
    const vx = (pos[i * 3] - pos[anchor * 3]) / dt;
    const vy = (pos[i * 3 + 1] - pos[anchor * 3 + 1]) / dt;
    const vz = (pos[i * 3 + 2] - pos[anchor * 3 + 2]) / dt;
    anchor = i;
    // **传送过滤**：实测相邻位移中位数 60 单位，而重生/换图/观察者跳转会到 27,580
    // （≈92 万 u/s）。超阈值按"没有速度"处理（写 0），免得一个瞬移把电平表打到满格。
    if (
      Math.abs(vx) > TELEPORT_SPEED ||
      Math.abs(vy) > TELEPORT_SPEED ||
      Math.abs(vz) > TELEPORT_SPEED
    ) {
      continue;
    }
    vel[i * 3] = vx;
    vel[i * 3 + 1] = vy;
    vel[i * 3 + 2] = vz;
    const h = Math.hypot(vx, vy);
    if (h > maxSpeed) maxSpeed = h;
  }
  // 首帧没有前一帧可差，沿用第二帧的值（否则起点那一帧显示 0 速度，看着像"站着不动"）。
  if (n > 1) {
    vel[0] = vel[3];
    vel[1] = vel[4];
    vel[2] = vel[5];
  }

  return {
    id: `dem:${result.header.mapName}:${track.entityIndex}`,
    name: nameOf ? nameOf(track) : `${track.className} #${track.entityIndex}`,
    count: n,
    t,
    pos,
    ang,
    vel,
    duration: t[n - 1],
    bbox: { min, max },
    maxSpeed,
    resolvedPath: `${result.header.mapName}.dem`,
    rule,
    buttons: null,
    meta,
  };
}

/** 角度归一化到 `[0, 360)`。 */
function wrapDeg(a: number): number {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

/** 俯仰夹到 `[-89, 89]`。 */
function clampPitch(p: number): number {
  return p < -89 ? -89 : p > 89 ? 89 : p;
}
