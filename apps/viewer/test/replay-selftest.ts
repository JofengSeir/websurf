/**
 * 录像管线核心链路自检（Node，无 DOM）：
 * Shavit `.replay` 二进制原生解析（真实 fixture + 坐标映射切换 + 播放基准）→
 * Clip → 播放器采样 / A-B 区间 / 多轨迹 → transform 后处理 → 异常输入。
 *
 * t4 起以 .replay 为唯一基准（JSON 规则脚本通道已移除）：
 * 播放基准 = 帧自身坐标（无强制起点锚定；平移/映射切换仅显式叠加）。
 *
 * 运行：npm run test:replay
 */

import { readFileSync } from 'node:fs';
import { clampPitch, wrapDeg } from '../src/replay/helpers.js';
import { applyClipTransform } from '../src/replay/build.js';
import { ReplayPlayer } from '../src/replay/player.js';
import {
  clipFromShavitReplay,
  looksLikeShavitReplay,
  parseShavitReplay,
  SHAVIT_MAX_VERSION,
} from '../src/replay/shavit-replay.js';
import { defaultRule } from '../src/replay/types.js';
import type { Clip, RuleConfig } from '../src/replay/types.js';

let failures = 0;

// 顶层 tsconfig 只带 DOM 类型（types: []）：process 用本地 declare，
// node:fs 的最小模块声明在 test/node-shims.d.ts。
declare const process: { exit(code: number): never };

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

console.log('\n[1] 角度工具');
check('wrapDeg(-90)=270', near(wrapDeg(-90), 270), String(wrapDeg(-90)));
check('wrapDeg(450)=90', near(wrapDeg(450), 90));
check('wrapDeg(360)=0', near(wrapDeg(360), 0), String(wrapDeg(360)));
check('wrapDeg(540)=180', near(wrapDeg(540), 180));
check('clampPitch(-120)=-89（限幅）', near(clampPitch(-120), -89), String(clampPitch(-120)));
check('clampPitch(30)=30', near(clampPitch(30), 30));
check('clampPitch(NaN)=0', near(clampPitch(Number.NaN), 0));

// ── Shavit .replay 原生解析 ─────────────────────────────────────────
// 期望值全部来自 t2 规格研究（documents/viewer/implementation/shavit-replay-format.md §6，
// 对真实文件逐字节验证）与 HEAD 中已验证的转换产物，非凭空设定。

/** 真实 fixture：test/maps/surf_null_4.replay（Shavit FINAL v12，53,365 B）。 */
const FIXTURE_URL = new URL('../../../test/maps/surf_null_4.replay', import.meta.url);

const asciiBytes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** 写一个 f32 小端字节序列。 */
function pushF32(bytes: number[], x: number): void {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x, true);
  for (let i = 0; i < 4; i++) bytes.push(dv.getUint8(i));
}

/** 写一个 i32 小端字节序列。 */
function pushI32(bytes: number[], x: number): void {
  bytes.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
}

interface FinalFixtureOpts {
  version: number;
  map?: string;
  style?: number;
  track?: number;
  /** preFrames 字段值（可传负数测读侧归零）。 */
  pre?: number;
  /** frameCount 字段原始值（v<7 时按读侧语义：旧写入 = 总帧数）。 */
  run?: number;
  post?: number;
  time?: number;
  /** null = 该版本没有 steamID 字段（按版本门槛跳过写入）。 */
  steamId?: number | null;
  tickrate?: number;
  zoneOffset?: [number, number] | null;
  stage?: number | null;
  timestamp?: number | null;
  /** offsetsLength 字段值；≥2 时写 (n−1) 条 12B 记录。 */
  offsetsLength?: number | null;
  /** 实际写入的帧数（默认 pre+run+post；v<7 语义下需显式给）。 */
  frames?: number;
  tickrateMissing?: boolean;
}

/** 按版本门槛构造最小 FINAL fixture（帧数据给确定值，便于断言）。 */
function buildFinalFixture(o: FinalFixtureOpts): Uint8Array {
  const v = o.version;
  const pre = o.pre ?? 0;
  const run = o.run ?? 1;
  const post = o.post ?? 0;
  const n = o.frames ?? pre + run + post;
  const cells = v >= 10 ? 11 : v >= 6 ? 10 : v >= 2 ? 8 : 6;
  const body: number[] = [];
  if (v >= 3) {
    for (const c of o.map ?? 'testmap') body.push(c.charCodeAt(0) & 0xff);
    body.push(0); // NUL
    body.push(o.style ?? 0);
    body.push(o.track ?? 0);
    pushI32(body, pre);
  }
  pushI32(body, run);
  pushF32(body, o.time ?? 1);
  if (v >= 4 && o.steamId !== null) pushI32(body, o.steamId ?? 7);
  if (v >= 5) pushI32(body, post);
  if (v >= 5 && !o.tickrateMissing) pushF32(body, o.tickrate ?? 64);
  if (v >= 8 && o.zoneOffset !== null) {
    pushF32(body, o.zoneOffset?.[0] ?? 0.25);
    pushF32(body, o.zoneOffset?.[1] ?? 0.5);
  }
  if (v >= 10 && o.stage !== null) body.push(o.stage ?? 0);
  if (v >= 12 && o.timestamp !== null) pushI32(body, o.timestamp ?? 1000);
  if (v >= 11 && o.offsetsLength !== null) body.push(o.offsetsLength ?? 0);
  const offsetsLength = o.offsetsLength ?? 0;
  for (let i = 0; i < Math.max(0, offsetsLength - 1); i++) {
    pushI32(body, i); // iFrameOffset
    pushI32(body, 0); // iFailureAttempts
    pushF32(body, 0); // fReachTime
  }
  for (let i = 0; i < n; i++) {
    pushF32(body, i * 10); // Source x
    pushF32(body, 100 + i); // Source y
    pushF32(body, -i * 5); // Source z
    pushF32(body, i * 0.1); // pitch
    pushF32(body, 30 + i); // yaw
    pushI32(body, 8); // buttons = IN_FORWARD
    if (cells >= 8) {
      pushI32(body, 0x10041); // flags（u32 位型，含高位 bit 0x10000）
      pushI32(body, 2); // mt = MOVETYPE_WALK
    }
    if (cells >= 10) {
      pushI32(body, 0); // mousexy
      pushI32(body, 0); // vel（packed wishmove，不参与解码输出）
    }
    if (cells >= 11) pushI32(body, 0); // stage
  }
  const line = `${v}:{SHAVITREPLAYFORMAT}{FINAL}\n`;
  return new Uint8Array([...asciiBytes(line), ...body]);
}

function buildV2Fixture(n: number): Uint8Array {
  const body: number[] = [];
  for (let i = 0; i < n; i++) {
    pushF32(body, i * 4);
    pushF32(body, 0);
    pushF32(body, -i * 4);
    pushF32(body, 0);
    pushF32(body, i * 90);
    pushI32(body, 0);
  }
  const line = `${n}:{SHAVITREPLAYFORMAT}{V2}\n`;
  return new Uint8Array([...asciiBytes(line), ...body]);
}

/** 非录像文本（JSON）：嗅探必须排除（t4 起 JSON 通道已移除，但不得被误判成 .replay）。 */
const JSON_TEXT = JSON.stringify({ map: 'testmap', frames: [{ pos: [1, 2, 3], ang: [0, 0] }] });

console.log('\n[2] Shavit .replay 原生解析（真实文件 test/maps/surf_null_4.replay）');
let fixture: Uint8Array | null = null;
try {
  fixture = readFileSync(FIXTURE_URL);
} catch {
  fixture = null;
}
if (!fixture) {
  // 真实 fixture 缺失（test/maps/surf_null_4.replay 未提供）：loud skip，本段断言不计入 failures，
  // 不因缺夹具而 exit 1；合成 fixture 相关断言（[3] 起）照常跑。
  console.log(
    '\n[SKIP] 真实 fixture 缺失（test/maps/surf_null_4.replay）——跳过「真实文件逐字节」段（[2][8] 节），其余断言照常',
  );
} else {
  check('fixture 可读（test/maps/surf_null_4.replay）', fixture.length > 0);
  check('文件大小 53365 B', fixture.length === 53365, String(fixture.length));
  check('嗅探命中魔数', looksLikeShavitReplay(fixture));
  check('嗅探排除 JSON 文本', !looksLikeShavitReplay(new TextEncoder().encode(JSON_TEXT)));

  const parsed = parseShavitReplay(fixture);

  // ── 头部元信息（与 t2 §6 byte 级实测逐字段对齐）──
  const hd = parsed.header;
  check('version = 12', hd.version === 12, String(hd.version));
  check('format = final', hd.format === 'final');
  check('map = surf_null（基础名，不带 _4）', hd.map === 'surf_null', hd.map);
  check('style = 0', hd.style === 0, String(hd.style));
  check('track = 4（bonus，非地图名后缀）', hd.track === 4, String(hd.track));
  check('preFrames = 113', hd.preFrames === 113, String(hd.preFrames));
  check('frameCount = 1080', hd.frameCount === 1080, String(hd.frameCount));
  check('postFrames = 18', hd.postFrames === 18, String(hd.postFrames));
  check('totalFrames = 1211', hd.totalFrames === 1211, String(hd.totalFrames));
  check('fTime = 16.2074…', hd.time === 16.207439422607422, String(hd.time));
  check('steamId = 196340649', hd.steamId === 196340649, String(hd.steamId));
  check('steamIdDisplay = [U:1:…]', hd.steamIdDisplay === '[U:1:196340649]', String(hd.steamIdDisplay));
  check('tickrate = 66.66667…（f32→f64 精确）', hd.tickrate === 66.66667175292969, String(hd.tickrate));
  check(
    'zoneOffset = [0.7851, 0.7110]',
    hd.zoneOffset[0] === 0.7850947380065918 && hd.zoneOffset[1] === 0.710992693901062,
    `${hd.zoneOffset[0]}, ${hd.zoneOffset[1]}`,
  );
  // §2.1 完整性：zoneOffset 是亚 tick 份额（∈[0,1]，非秒），与 fTime 存在闭环公式
  // fTime ≈ (frameCount + zo0 − (1 − zo1)) × tickInterval；offset 越界时跳过该校验
  if (
    hd.zoneOffset[0] >= 0 && hd.zoneOffset[0] <= 1 &&
    hd.zoneOffset[1] >= 0 && hd.zoneOffset[1] <= 1 &&
    hd.time !== null
  ) {
    const tickInterval = 1 / hd.tickrate;
    const expectTime = (hd.frameCount + hd.zoneOffset[0] - (1 - hd.zoneOffset[1])) * tickInterval;
    check(
      'fTime 与 zoneOffset 亚 tick 份额公式闭环（§2.1，容差 1e-3 s）',
      Math.abs(hd.time - expectTime) < 1e-3,
      `expect=${expectTime.toFixed(6)} actual=${hd.time?.toFixed(6)}`,
    );
  }
  check('stage = 0', hd.stage === 0, String(hd.stage));
  check('timestamp = 1787992447', hd.timestamp === 1787992447, String(hd.timestamp));
  check('offsetsLength = 0', hd.offsetsLength === 0, String(hd.offsetsLength));
  check('解析无警告（v12 完整文件）', parsed.warnings.length === 0, parsed.warnings.join(';'));

  // ── 帧区布局闭合 ──
  check('帧数 1211', parsed.count === 1211, String(parsed.count));
  check('帧区起点 81 B', parsed.frameStart === 81, String(parsed.frameStart));
  check(
    '字节闭合：81 + 1211×44 = 文件大小',
    parsed.frameStart + parsed.count * 44 === fixture.length,
    `${parsed.frameStart + parsed.count * 44} vs ${fixture.length}`,
  );

  // ── 帧解码（f32 原样透传 + viewer 映射，均应精确相等）──
  check(
    'frame0 pos = [y,z,x] 轴置换',
    parsed.pos[0] === 12187.201171875 &&
      parsed.pos[1] === -1791.96875 &&
      parsed.pos[2] === 2375.0390625,
    `${parsed.pos[0]}, ${parsed.pos[1]}, ${parsed.pos[2]}`,
  );
  check(
    'frame0 ang = [wrap(yaw+180), −pitch, 0]',
    Math.abs(parsed.ang[0] - 255.33753204345703) < 1e-4 &&
      Math.abs(parsed.ang[1] + 20.627914428710938) < 1e-9 &&
      parsed.ang[2] === 0,
    `${parsed.ang[0]}, ${parsed.ang[1]}, ${parsed.ang[2]}`,
  );
  check('buttons[0] = IN_FORWARD(8)', parsed.buttons[0] === 8, String(parsed.buttons[0]));
  check(
    'buttons[113] = JUMP|DUCK|MOVELEFT(518)',
    parsed.buttons[113] === 518,
    String(parsed.buttons[113]),
  );
  check('buttons[1210] = IN_MOVELEFT(512)', parsed.buttons[1210] === 512, String(parsed.buttons[1210]));
  check('flags[0] = 0x00010041（u32 含高位）', parsed.flags[0] === 65665, String(parsed.flags[0]));
  check('flags[1210] = 0x00010080（离地）', parsed.flags[1210] === 65664, String(parsed.flags[1210]));

  // ── 时间轴：t(i)=(i−preFrames)/tickrate，prerun 为负、主时钟 0 = 起跑 ──
  const TR = 66.66667175292969;
  check('t[113] = 0（起跑帧）', parsed.t[113] === 0, String(parsed.t[113]));
  check('t[0] = −113/tickrate', Math.abs(parsed.t[0] - -113 / TR) < 1e-9, String(parsed.t[0]));
  check('t[1210] = 1097/tickrate', Math.abs(parsed.t[1210] - 1097 / TR) < 1e-9, String(parsed.t[1210]));
  check('t 严格单调递增', parsed.t.every((v, i) => i === 0 || v > parsed.t[i - 1]));

  // ── 世界速度 = 位置差分（packed vel 是按键 wishmove，绝不直读）──
  check('vel 非空', parsed.vel !== null);
  if (parsed.vel) {
    const i = 600;
    let velOk = true;
    for (let k = 0; k < 3; k++) {
      const expect = (parsed.pos[(i + 1) * 3 + k] - parsed.pos[(i - 1) * 3 + k]) * (TR / 2);
      if (Math.abs(parsed.vel[i * 3 + k] - expect) > 1e-3) velOk = false;
    }
    check('vel[600] = 中央差分×tickrate', velOk);
    let maxSpd = 0;
    for (let j = 0; j < parsed.count; j++) {
      maxSpd = Math.max(
        maxSpd,
        Math.hypot(parsed.vel[j * 3], parsed.vel[j * 3 + 1], parsed.vel[j * 3 + 2]),
      );
    }
    check('世界速度量级合理（<4000 HU/s）', maxSpd > 100 && maxSpd < 4000, maxSpd.toFixed(1));
  }

  // ── 朝向自洽（对真实 run 段：viewer forward 与水平运动方向平均 cos）──
  {
    let sum = 0;
    let cnt = 0;
    const pre = parsed.header.preFrames;
    for (let i = pre + 1; i < pre + parsed.header.frameCount - 1; i++) {
      const dx = parsed.pos[(i + 1) * 3] - parsed.pos[(i - 1) * 3];
      const dz = parsed.pos[(i + 1) * 3 + 2] - parsed.pos[(i - 1) * 3 + 2];
      if (Math.hypot(dx, dz) * TR < 50) continue;
      const yaw = parsed.ang[i * 3];
      const yawRad = (yaw * Math.PI) / 180;
      const fwd = [-Math.sin(yawRad), -Math.cos(yawRad)];
      const len = Math.hypot(fwd[0], fwd[1]) * Math.hypot(dx, dz);
      sum += (fwd[0] * dx + fwd[1] * dz) / len;
      cnt++;
    }
    check(
      '视角与运动方向一致（run 段平均 cos > 0.98）',
      cnt > 500 && sum / cnt > 0.98,
      `n=${cnt} avg=${(sum / (cnt || 1)).toFixed(4)}`,
    );
  }

  // ── Clip 适配 + 播放器 ──
  const sclip = clipFromShavitReplay('surf_null_4', parsed, defaultRule());
  check('clip.count', sclip.clip.count === 1211);
  check('clip.meta = 头部元信息', sclip.clip.meta === parsed.header);
  check('clip.buttons = 解析按键', sclip.clip.buttons !== null && sclip.clip.buttons[113] === 518);
  check('clip.duration = t[1210]', Math.abs(sclip.clip.duration - parsed.t[1210]) < 1e-9);
  check('clip.maxSpeed > 0', sclip.clip.maxSpeed > 0);
  check('clip.bbox 有效', sclip.clip.bbox.min[0] < sclip.clip.bbox.max[0]);
  check('clip.warnings 直通', sclip.warnings.length === 0);

  // ── 播放基准（t4 验收③）：帧 0 即录像真实位置；无起点锚定 ──
  check('默认规则零变换（transform 缺省 = 恒等）', defaultRule().transform === undefined);
  check(
    'clip.rule 记录导入规则（axes/yaw 默认直读口径）',
    sclip.clip.rule.axesMode === 'shavit' && sclip.clip.rule.yawMode === 'shavit',
  );
  {
    let same = true;
    for (let k = 0; k < 3; k++) if (sclip.clip.pos[k] !== parsed.pos[k]) same = false;
    check('clip 帧 0 = 解析帧 0（帧自身坐标直读，未平移）', same);
  }
  {
    // bbox 必须等于帧数据自身的包围盒——任何「起点对齐/锚定」注入的平移都会打破它
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < parsed.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = parsed.pos[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const bboxOk =
      sclip.clip.bbox.min.every((v, k) => v === min[k]) &&
      sclip.clip.bbox.max.every((v, k) => v === max[k]);
    check('bbox = 帧数据自身包围盒（无锚定偏移）', bboxOk, JSON.stringify(sclip.clip.bbox));
  }

  const sp = new ReplayPlayer();
  sp.load(sclip.clip);
  check('主时钟 0 = 起跑帧（index 113）', sp.indexAt(0) === 113, String(sp.indexAt(0)));
  const sAt0 = sp.sampleAt(0);
  check(
    't=0 位姿 = frame113',
    sAt0 !== null && Math.abs(sAt0.pos[0] - sclip.clip.pos[113 * 3]) < 1e-4,
  );
  const sAtEnd = sp.sampleAt(sclip.clip.duration);
  check('t=duration 命中末帧', sAtEnd !== null && sAtEnd.index === 1210, String(sAtEnd?.index));

  // ── 变换微调（rule.transform）对原生轨道同样生效（仅显式叠加）──
  {
    const ruleT = defaultRule();
    ruleT.transform = { offset: [10, 20, 30], yawDeg: 0 };
    const moved = clipFromShavitReplay('moved', parsed, ruleT).clip;
    check(
      'transform 平移生效',
      Math.abs(moved.pos[0] - (sclip.clip.pos[0] + 10)) < 1e-3 &&
        Math.abs(moved.pos[1] - (sclip.clip.pos[1] + 20)) < 1e-3,
    );
    check('transform 不改 buttons/meta', moved.buttons !== null && moved.buttons[113] === 518 && moved.meta === parsed.header);
  }
}

console.log('\n[3] 坐标映射切换（axesMode / yawMode，synthetic fixture）');
{
  const fx = buildFinalFixture({ version: 12, run: 3, timestamp: 0, tickrate: 64 });
  // fixture 帧：Source pos=(i*10, 100+i, −i*5)、pitch=i*0.1、yaw=30+i
  const std = parseShavitReplay(fx); // 默认 = shavit 定标映射
  check(
    '默认 pos = [y,z,x]',
    std.pos[0] === 100 && std.pos[1] === 0 && std.pos[2] === 0,
    `${std.pos[0]}, ${std.pos[1]}, ${std.pos[2]}`,
  );
  check(
    '默认 ang = [wrap(30+180), −0, 0]',
    std.ang[0] === 210 && std.ang[1] === 0 && std.ang[2] === 0,
    `${std.ang[0]}, ${std.ang[1]}, ${std.ang[2]}`,
  );

  const raw = parseShavitReplay(fx, { mapping: { axesMode: 'raw', yawMode: 'raw' } });
  check(
    'raw pos = [x,y,z] 直读',
    raw.pos[0] === 0 && raw.pos[1] === 100 && raw.pos[2] === 0,
    `${raw.pos[0]}, ${raw.pos[1]}, ${raw.pos[2]}`,
  );
  check(
    'raw ang = [30, 0, 0] 直读',
    raw.ang[0] === 30 && raw.ang[1] === 0 && raw.ang[2] === 0,
    `${raw.ang[0]}, ${raw.ang[1]}, ${raw.ang[2]}`,
  );
  check('映射只影响解码输出，不影响头部/时间轴', raw.header.version === 12 && raw.t[2] === 2 / 64);

  // 混合：轴序标准 + 朝向直读（两个开关相互独立）
  const mix = parseShavitReplay(fx, { mapping: { yawMode: 'raw' } });
  check('轴序仍走标准 [y,z,x]', mix.pos[0] === 100 && mix.pos[2] === 0);
  check('朝向走直读 yaw=30', mix.ang[0] === 30 && mix.ang[1] === 0);

  // 规则切换直通 clip（导入链路）：rule.axesMode/yawMode → 解析映射
  const ruleRaw = defaultRule();
  ruleRaw.axesMode = 'raw';
  ruleRaw.yawMode = 'raw';
  const clipRaw = clipFromShavitReplay('raw', raw, ruleRaw).clip;
  check(
    'clip（raw 规则）= raw 解析输出',
    clipRaw.pos.every((v, i) => v === raw.pos[i]) && clipRaw.ang.every((v, i) => v === raw.ang[i]),
  );

  // 显式 transform 叠加在映射之后（raw 轴序 + 平移）
  const ruleRawTf = defaultRule();
  ruleRawTf.axesMode = 'raw';
  ruleRawTf.yawMode = 'raw';
  ruleRawTf.transform = { offset: [1, 0, 0], yawDeg: 0 };
  const clipRawTf = clipFromShavitReplay('raw+tf', raw, ruleRawTf).clip;
  check('映射切换 + 显式平移叠加', Math.abs(clipRawTf.pos[0] - 1) < 1e-6 && clipRawTf.pos[1] === 100);
}

// ── 合成 Clip（无 JSON：直接构造定型数组；tick 128、沿 +X、面朝 +X/yaw=270）──
// 与真实管线一致：构造后应用 rule.transform（clipFromShavitReplay 同款后处理）
let syntheticSeq = 0;
function makeSyntheticClip(count: number, name: string, rule?: RuleConfig): Clip {
  const tickrate = 128;
  const t = new Float64Array(count);
  const pos = new Float32Array(count * 3);
  const ang = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    t[i] = i / tickrate;
    pos[i * 3] = i * 10;
    pos[i * 3 + 1] = 100;
    pos[i * 3 + 2] = 0;
    ang[i * 3] = 270;
    ang[i * 3 + 1] = 0;
    ang[i * 3 + 2] = 0;
    vel[i * 3] = 10 * tickrate;
    vel[i * 3 + 1] = 0;
    vel[i * 3 + 2] = 0;
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  syntheticSeq += 1;
  const out: Clip = {
    id: `syn-${syntheticSeq}`,
    name,
    count,
    t,
    pos,
    ang,
    vel,
    duration: count > 0 ? t[count - 1] : 0,
    bbox: { min, max },
    maxSpeed: 10 * tickrate,
    resolvedPath: '.replay',
    rule: rule ?? defaultRule(),
    buttons: null,
    meta: null,
  };
  applyClipTransform(out, out.rule.transform);
  return out;
}

console.log('\n[4] 播放器采样');
const clip = makeSyntheticClip(512, 'synthetic');
const p = new ReplayPlayer();
p.load(clip);
check('duration 同步', near(p.duration, clip.duration));
const s0 = p.sampleAt(0);
check('t=0 命中首帧', s0 !== null && near(s0.pos[0], clip.pos[0], 1e-2));
const sMid = p.sampleAt(clip.duration / 2);
check(
  '中点插值在两个采样点之间',
  sMid !== null && sMid.index > 0 && sMid.index < 511,
  String(sMid?.index),
);
const sEnd = p.sampleAt(clip.duration);
check('t=末帧命中最后一帧', sEnd !== null && sEnd.index === 511, String(sEnd?.index));
p.seek(1.0);
p.play();
p.update(0.5);
check('播放推进 0.5s', near(p.time, 1.5, 1e-9), String(p.time));
p.speed = 2;
p.update(0.5);
check('2 倍速推进 1.0s', near(p.time, 2.5, 1e-9), String(p.time));
p.time = clip.duration;
p.update(0.1);
check('循环回绕', p.time < 1, String(p.time));
p.pause();
p.stepFrames(1);
check('逐帧步进后 index 有效', p.indexAt(p.time) >= 0);

console.log('\n[4b] A-B 区间');
p.rangeStart = 1;
p.rangeEnd = 3;
check('rangeStop = 3', near(p.rangeStop, 3), String(p.rangeStop));
check('rangeLength = 2', near(p.rangeLength, 2), String(p.rangeLength));
p.seekRatio(0.5);
check('区间内 seek 到中点 = 2', near(p.time, 2), String(p.time));
p.seek(99);
check('seek 被区间上界夹住', near(p.time, 3), String(p.time));
p.seek(-5);
check('seek 被区间下界夹住', near(p.time, 1), String(p.time));
p.time = 2.95;
p.play();
p.update(0.2);
check('循环只在区间内回绕', p.time >= 1 && p.time < 3, String(p.time));
p.pause();
p.rangeStart = 0;
p.rangeEnd = 0;
check('清除区间后回到整段', near(p.rangeStop, clip.duration), String(p.rangeStop));

console.log('\n[5] 多轨迹对比（Q2）');
const clipA = makeSyntheticClip(256, 'A'); // 时长 255/128
const clipB = makeSyntheticClip(128, 'B'); // 时长 127/128
const mp = new ReplayPlayer();
mp.addTrack(clipA, 'A');
const trackB = mp.addTrack(clipB, 'B');
check('两条轨道', mp.tracks.tracks.length === 2);
check('配色不同', mp.tracks.tracks[0].color !== trackB.color);
check('默认跟随第一条', mp.tracks.followId === mp.tracks.tracks[0].id);
check('总长取较长的 A', near(mp.duration, clipA.duration, 1e-9), `${mp.duration} vs ${clipA.duration}`);

trackB.offset = 1.0;
check('偏移后总长 = offset + B 时长', near(mp.duration, 1 + clipB.duration, 1e-9), String(mp.duration));
check('t=0.5 时 B 还没开始 → null', mp.tracks.sample(trackB, 0.5) === null);
check(
  't=1.0 时 B 正好在第 0 帧',
  (() => {
    const s = mp.tracks.sample(trackB, 1.0);
    return s !== null && near(s.pos[0], clipB.pos[0], 1e-2);
  })(),
);
check(
  't 超过 B 末尾 → 夹到末帧（停在终点而不是消失）',
  (() => {
    const s = mp.tracks.sample(trackB, 99);
    const last = (clipB.count - 1) * 3;
    return s !== null && near(s.pos[0], clipB.pos[last], 1e-2);
  })(),
);

mp.seek(1.5);
const all = mp.sampleAll();
check('sampleAll 覆盖两条轨道', all.length === 2 && all[0].sample !== null && all[1].sample !== null);
trackB.visible = false;
check('隐藏不影响采样（只影响渲染）', mp.sampleAll()[1].sample !== null);
trackB.visible = true;

mp.followTrack(trackB.id);
check('跟随切到 B', mp.tracks.followId === trackB.id && mp.clip === clipB);
mp.seek(1 + clipB.duration / 2);
const idxB = mp.indexAt(mp.time);
check('跟随 B 后 indexAt 落在 B 中段', idxB > 0 && idxB < clipB.count - 1, String(idxB));

mp.seek(1.0);
mp.stepFrames(1);
check('逐帧步进把偏移算进去', near(mp.time, 1 + clipB.t[1], 1e-6), String(mp.time));

mp.removeTrack(trackB.id);
check('移除后只剩一条', mp.tracks.tracks.length === 1);
check('跟随回退到剩下那条', mp.tracks.followId === mp.tracks.tracks[0].id);
check('移除后总长回到 A', near(mp.duration, clipA.duration, 1e-9), String(mp.duration));
check('移除后主时钟被夹回有效区间', mp.time <= mp.rangeStop + 1e-9, String(mp.time));

// 改映射/变换后的重新导入必须**替换**那条轨道，而不是每次都追加一条
const before = mp.tracks.tracks.length;
const trackA = mp.addTrack(clipA, 'A2');
trackA.visible = false;
trackA.offset = 0.5;
const replaced = mp.tracks.replaceClip(trackA.id, clipB);
check('replaceClip 命中', replaced === true);
check('替换不新增轨道', mp.tracks.tracks.length === before + 1, String(mp.tracks.tracks.length));
check('替换后 clip 换成 B', mp.tracks.tracks.find((t) => t.id === trackA.id)?.clip === clipB);
check('替换保留显隐', trackA.visible === false);
check('替换保留偏移', near(trackA.offset, 0.5));
check('替换保留名字', trackA.name === 'A2');
check('replaceClip 对不存在的 id 返回 false', mp.tracks.replaceClip('nope', clipA) === false);

mp.clearTracks();
check('清空后无轨道', mp.tracks.isEmpty && mp.duration === 0);
check('清空后采样为 null', mp.sample() === null && mp.sampleAll().length === 0);

console.log('\n[6] transform 后处理（调整工具的后端）');
function makeSimpleClip(tf?: RuleConfig['transform']) {
  const r: RuleConfig = { ...defaultRule(), transform: tf };
  // 4 帧沿 +X 匀速、面朝 +X（yaw=-90 ≡ 270）的轨迹（帧自身坐标直读）
  return makeSyntheticClip(4, 'tf', r);
}

// 恒等：无 transform 与全零 transform 输出一致
{
  const base = makeSimpleClip();
  const identity = makeSimpleClip({ offset: [0, 0, 0], yawDeg: 0 });
  check('恒等 transform 不动坐标', base.pos.every((v, i) => v === identity.pos[i]));
  check('缺省 transform 字段向后兼容', base.pos[0] === 0 && base.pos[2] === 0);
}

// 纯平移：pos 平移、bbox 跟着移，vel/ang 不动
{
  const c = makeSimpleClip({ offset: [10, 20, 30], yawDeg: 0 });
  const base = makeSimpleClip();
  check('平移后 pos = 原值 + offset', c.pos.every((v, i) => near(v, base.pos[i] + [10, 20, 30][i % 3], 1e-4)));
  check('平移不改 ang', c.ang.every((v, i) => near(v, base.ang[i], 1e-6)));
  const baseVel = base.vel;
  check('平移不改 vel', c.vel !== null && baseVel !== null && c.vel.every((v, i) => near(v, baseVel[i], 1e-6)));
  check('bbox 随平移', near(c.bbox.min[0], 10) && near(c.bbox.max[0], 40), JSON.stringify(c.bbox));
}

// 纯旋转：+90° 把运动方向 +X 转到 −Z，yaw 同步 +90，vel 同步旋转，bbox 重算
{
  const c = makeSimpleClip({ offset: [0, 0, 0], yawDeg: 90 });
  const base = makeSimpleClip();
  check(
    '旋转后运动方向 +X → −Z',
    near(c.pos[11], -30, 1e-4) && near(c.pos[2], base.pos[2], 1e-4),
    JSON.stringify([c.pos[9], c.pos[10], c.pos[11]]),
  );
  check('旋转同步 yaw：270+90 → 0', near(c.ang[0], 0), String(c.ang[0]));
  check(
    '旋转同步 vel',
    c.vel !== null && near(c.vel[0], 0, 1e-3) && near(c.vel[2], -1280, 1e-3),
    JSON.stringify([c.vel?.[0], c.vel?.[2]]),
  );
  check('旋转后 bbox 重算', near(c.bbox.min[2], -30) && near(c.bbox.max[2], 0), JSON.stringify(c.bbox));
}

// 平移 + 旋转组合：先绕 Y 转再平移（与 applyClipTransform 的实现顺序一致）
{
  const c = makeSimpleClip({ offset: [10, 0, 0], yawDeg: 90 });
  check(
    '组合：旋转后平移',
    near(c.pos[9], 10, 1e-4) && near(c.pos[10], 100, 1e-4) && near(c.pos[11], -30, 1e-4),
    JSON.stringify([c.pos[9], c.pos[10], c.pos[11]]),
  );
  check('组合：yaw 环绕 270+90 → 0', near(c.ang[0], 0), String(c.ang[0]));
}

console.log('\n[7] 容错：脏数据不炸（NaN 帧兜底）');
{
  const fx = buildFinalFixture({ version: 12, run: 3, timestamp: 0, tickrate: 64 });
  // 把第 1 帧 Source x 写成 NaN（f32 0x7FFFFFFF）
  const lineLen = fx.indexOf(10) + 1; // 头行以 \n 结束
  const cells = 11;
  const frameStart = lineLen + (7 + 1) + 1 + 1 + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 1 + 4 + 1;
  const dv = new DataView(fx.buffer, fx.byteOffset, fx.byteLength);
  dv.setUint32(frameStart + 1 * cells * 4, 0x7fffffff, true);
  const dirty = parseShavitReplay(fx);
  check('脏帧不炸、帧数不丢', dirty.count === 3, String(dirty.count));
  check('给出警告', dirty.warnings.some((w: string) => w.includes('位置数值无效')), dirty.warnings.join(';'));
  check(
    '脏帧沿用上一帧的值',
    dirty.pos[3] === dirty.pos[0] && dirty.pos[4] === dirty.pos[1] && dirty.pos[5] === dirty.pos[2],
    `${dirty.pos[3]}, ${dirty.pos[4]}, ${dirty.pos[5]}`,
  );
}

console.log('\n[8] Shavit .replay 异常输入（明确报错 / 兼容路径）');
{
  // 截断：帧区缺 100 字节
  if (fixture) {
    let threw = '';
    try {
      parseShavitReplay(fixture.subarray(0, fixture.length - 100));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('帧区截断 → 明确报错', threw.includes('截断'), threw);
    threw = '';
    try {
      parseShavitReplay(fixture.subarray(0, 40));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('头部截断 → 明确报错', threw.includes('截断') || threw.includes('损坏'), threw);
  }

  // 错版本：v13（把真文件第 1 行的 12 改成 13，其余字节不动）
  if (fixture) {
    const bad13 = new Uint8Array(fixture);
    bad13[0] = 0x31; // '1'
    bad13[1] = 0x33; // '3'
    let threw = '';
    try {
      parseShavitReplay(bad13);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(
      '版本 13 > 支持上限 → 明确报错',
      threw.includes('13') && threw.includes(String(SHAVIT_MAX_VERSION)),
      threw,
    );
  }

  // 未知格式标签（远古文本/备份格式）
  {
    const bytes = new Uint8Array([
      ...asciiBytes('12:{SHAVITREPLAYFORMAT}{OLD}\n'),
      ...new Array(80).fill(0),
    ]);
    let threw = '';
    try {
      parseShavitReplay(bytes);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('未知格式标签 → 明确报错', threw.includes('不支持'), threw);
  }

  // 非 Shavit 数据
  {
    const json = new TextEncoder().encode(JSON_TEXT);
    check('JSON 文本不被嗅探命中', !looksLikeShavitReplay(json));
    let threw = '';
    try {
      parseShavitReplay(json);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('直接解析 JSON → 明确报错', threw.includes('不是'), threw);
  }

  // V2：6-cell 帧、无二进制头、tickrate 估算 + 警告
  {
    const v2 = buildV2Fixture(3);
    const p2 = parseShavitReplay(v2);
    check('V2 帧数', p2.count === 3, String(p2.count));
    check('V2 version=0 / format=v2', p2.header.version === 0 && p2.header.format === 'v2');
    check('V2 tickrate 估算 128', p2.header.tickrate === 128, String(p2.header.tickrate));
    check('V2 有 tickrate 警告', p2.warnings.some((w: string) => w.includes('128')), p2.warnings.join(';'));
    check('V2 t(i)=i/128', Math.abs(p2.t[2] - 2 / 128) < 1e-9, String(p2.t[2]));
    check(
      'V2 帧解码',
      p2.pos[2 * 3] === 0 && p2.pos[2 * 3 + 1] === -8 && p2.pos[2 * 3 + 2] === 8 &&
        Math.abs(p2.ang[3] - 270) < 1e-6,
      `${p2.pos[6]}, ${p2.pos[7]}, ${p2.pos[8]}, ${p2.ang[3]}`,
    );
    const threwV2 = (() => {
      try {
        parseShavitReplay(v2.subarray(0, v2.length - 10));
        return '';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    check('V2 截断 → 明确报错', threwV2.includes('截断'), threwV2);
  }

  // offsets 区跳过：v12 + offsetsLength=2（1 条 12B 记录），帧区整体后移 12B
  {
    const fx = buildFinalFixture({
      version: 12,
      run: 3,
      offsetsLength: 2,
      timestamp: 1234,
      tickrate: 64,
    });
    const px = parseShavitReplay(fx);
    // 行 31B + 头部 48B（map7+1+NUL…此处 'testmap' 7+1=8, style1, track1, pre4, run4, time4,
    // steam4, post4, tick4, zone8, stage1, ts4, offsetsLen1 = 48）
    check('offsets 区被跳过（帧区起点 91）', px.frameStart === 31 + 48 + 12, String(px.frameStart));
    check('offsetsLength = 2', px.header.offsetsLength === 2, String(px.header.offsetsLength));
    check(
      'offsets 后帧数据正确',
      px.count === 3 && px.pos[0] === 100 && px.pos[7] === -10 && px.pos[8] === 20,
      `${px.count}, ${px.pos[0]}, ${px.pos[7]}, ${px.pos[8]}`,
    );
  }

  // v<0x07 读侧兼容：frameCount −= pre（≥0x05 再 −= post）→ 旧文件 frameCount 存总帧数
  {
    const fx6 = buildFinalFixture({ version: 6, pre: 2, run: 6, post: 1, frames: 6, tickrate: 64 });
    const p6 = parseShavitReplay(fx6);
    check('v6 frameCount 修正 = 3', p6.header.frameCount === 3, String(p6.header.frameCount));
    check('v6 总帧数 = 6', p6.count === 6, String(p6.count));
    check('v6 无 zoneOffset 字段（<v8）', p6.header.zoneOffset[0] === 0 && p6.header.zoneOffset[1] === 0);
  }

  // 负 preFrames 归零（RFC:318-321）
  {
    const fx = buildFinalFixture({ version: 12, pre: -5, run: 3, frames: 3, timestamp: 0, tickrate: 64 });
    const px = parseShavitReplay(fx);
    check('负 preFrames 归零', px.header.preFrames === 0, String(px.header.preFrames));
    check('归零后 t[0] = 0', px.t[0] === 0, String(px.t[0]));
  }

  // tickrate 无效 → 报错（存在字段但 ≤ 0 = 损坏）
  {
    const fx = buildFinalFixture({ version: 12, run: 1, tickrate: 0, timestamp: 0 });
    let threw = '';
    try {
      parseShavitReplay(fx);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('tickrate ≤ 0 → 明确报错', threw.includes('tickrate'), threw);
  }

  // 无有效 run 帧 → 报错
  {
    const fx = buildFinalFixture({ version: 12, run: 0, timestamp: 0, tickrate: 64 });
    let threw = '';
    try {
      parseShavitReplay(fx);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('frameCount = 0 → 明确报错', threw.includes('run'), threw);
  }

  // v11（有 offsetsLength、无 timestamp）→ timestamp 用 mtime 兜底（Unix 秒）
  {
    const fx = buildFinalFixture({ version: 11, run: 2, tickrate: 64, offsetsLength: 0 });
    const px = parseShavitReplay(fx, { timestampFallback: 1727000000 });
    check('v11 无 timestamp 字段 → 用 fallback', px.header.timestamp === 1727000000, String(px.header.timestamp));
  }
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}\n`);
process.exit(failures === 0 ? 0 : 1);
