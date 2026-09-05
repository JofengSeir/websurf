/**
 * 录像管线核心链路自检（Node，无 DOM）：
 * JSON → 帧数组定位 → 规则脚本编译 → 标准帧 → Clip（含 transform 后处理）→ 播放器采样。
 *
 * 运行：npm run test:replay
 */

import { buildSampleReplayText } from '../src/replay/sample.js';
import {
  findArrayCandidates,
  getPath,
  pickFrameArray,
  REPLAY_HELPERS as H,
  wrapDeg,
} from '../src/replay/helpers.js';
import { compileScript, probeScript } from '../src/replay/codegen.js';
import { DEFAULT_RULE_SRC } from '../src/replay/default-rule.js';
import { buildClip } from '../src/replay/build.js';
import { ruleFromText } from '../src/replay/rule-file.js';
import { ReplayPlayer } from '../src/replay/player.js';
import { defaultRule } from '../src/replay/types.js';
import type { RuleConfig } from '../src/replay/types.js';

let failures = 0;

// 顶层 tsconfig 只带 DOM 类型（types: []），这里补一个最小 Node 声明，
// 免得为一个 process.exit 拖进整个 @types/node。
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

console.log('\n[1] 路径取值');
const obj = { a: { b: [{ c: 7 }] }, n: 5 };
check('a.b[0].c', getPath(obj, 'a.b[0].c') === 7);
check('n', getPath(obj, 'n') === 5);
check('缺失路径 → undefined', getPath(obj, 'a.x.y') === undefined);
check('wrapDeg(-90)=270', near(wrapDeg(-90), 270), String(wrapDeg(-90)));
check('wrapDeg(450)=90', near(wrapDeg(450), 90));
check('wrapDeg(360)=0', near(wrapDeg(360), 0), String(wrapDeg(360)));

console.log('\n[2] 帧数组自动探测');
const sample = JSON.parse(buildSampleReplayText(512)) as unknown;
check('探测到 frames', pickFrameArray(sample) === 'frames', String(pickFrameArray(sample)));
check('候选包含 frames', findArrayCandidates(sample).some((c) => c.path === 'frames'));
check('候选项数 = 512', findArrayCandidates(sample)[0].length === 512);

console.log('\n[3] 默认规则（DEFAULT_RULE_SRC，viewer 原生，tick 128）');
const rule = defaultRule();
const fn = compileScript(DEFAULT_RULE_SRC);
const frames = getPath(sample, 'frames') as unknown[];
const probe = probeScript(fn, frames);
check('probe 通过', probe.ok, probe.error);
const { clip, warnings } = buildClip({ name: 'sample', frames, fn, rule, resolvedPath: 'frames' });
check('帧数 512', clip.count === 512, String(clip.count));
check('时长 = 511/128', near(clip.duration, 511 / 128, 1e-6), String(clip.duration));
check('无警告', warnings.length === 0, warnings.join(';'));
check('有速度', clip.vel !== null);
check('最大速度 > 0', clip.maxSpeed > 0);
check(
  '位置与源一致',
  near(clip.pos[0], (frames[0] as { pos: number[] }).pos[0], 1e-2),
  `${clip.pos[0]} vs ${(frames[0] as { pos: number[] }).pos[0]}`,
);
check('bbox 有效', clip.bbox.min[0] < clip.bbox.max[0]);

console.log('\n[4] 播放器采样');
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

console.log('\n[5] 自定义脚本（AI 产出 .js 的形态：缩放 / 眼位 / 弧度 / 毫秒 / 速度）');
// 这就是「裸 .js 规则」的契约验证：求值为 (raw, i, H) => Frame 的单表达式
const CUSTOM_SRC = `(raw, i, H) => {
  const o = H.get(raw, 'o');
  const yaw = H.deg(H.num(H.get(raw, 'yaw')));
  const pitch = H.deg(H.num(H.get(raw, 'pitch')));
  return {
    t: H.num(H.get(raw, 'ms')) / 1000,
    pos: [H.num(o[0]) * 2, H.num(o[1]) * 2 - H.EYE, H.num(o[2]) * 2],
    ang: [H.wrap(yaw), H.clampPitch(pitch), 0],
    vel: [H.num(H.get(raw, 'v[0]')), H.num(H.get(raw, 'v[1]')), H.num(H.get(raw, 'v[2]'))],
  };
}`;
const rCustom: RuleConfig = { ...defaultRule(), name: '自定义', scriptSrc: CUSTOM_SRC };
const f3 = compileScript(rCustom.scriptSrc)(
  { o: [10, 100, 20], yaw: Math.PI, pitch: Math.PI / 4, ms: 2500, v: [1, 2, 3] },
  7,
  H,
);
check('缩放 ×2', f3.pos[0] === 20 && f3.pos[2] === 40, JSON.stringify(f3.pos));
check('眼位减 64.09', near(f3.pos[1], 200 - 64.09, 1e-6), String(f3.pos[1]));
check('弧度转度 yaw 180', near(f3.ang[0], 180), String(f3.ang[0]));
check('弧度转度 pitch 45', near(f3.ang[1], 45), String(f3.ang[1]));
check('毫秒时间戳 → 2.5s', near(f3.t, 2.5), String(f3.t));
check('速度直通', f3.vel !== null && f3.vel[0] === 1 && f3.vel[2] === 3, JSON.stringify(f3.vel));

console.log('\n[6] Source → viewer 映射（定标结论，以手写脚本形态保持可验证）');
// 依据：maps/surf_null.bsp 出生点 + surf_null_4.replay 实测定标（2026-09-03）。
//   GLB 导出 map_coords / parse_spawn_points 的 rotate_yup 均为 [x,y,z]→[y,z,x]（无符号翻转）；
//   录像位置必须走同一变换，否则轨迹相对地图整体绕竖直轴旋转 90°。
//   （y,z,x) 下 viewerYaw = srcYaw + 180；Source pitch 正=俯视 → viewer 取反。
//   同一映射的完整 .js 范例见 docs/replay-rule-ai.md。
const SOURCE_WORLD_SRC = `(raw, i, H) => {
  const p = H.get(raw, 'pos');
  const yaw = H.num(H.get(raw, 'ang[1]'));
  const pitch = H.num(H.get(raw, 'ang[0]'));
  return {
    t: i / 128,
    pos: [H.num(p[1]), H.num(p[2]), H.num(p[0])],
    ang: [H.wrap(yaw + 180), H.clampPitch(-pitch), 0],
    vel: null,
  };
}`;
const fnSW = compileScript(SOURCE_WORLD_SRC);
{
  const a = fnSW({ pos: [0, 0, 0], ang: [0, 0] }, 0, H);
  const b = fnSW({ pos: [10, 0, 0], ang: [0, 0] }, 1, H);
  check('Source +X 位移 → viewer +Z', near(b.pos[0] - a.pos[0], 0) && near(b.pos[2] - a.pos[2], 10), JSON.stringify(b.pos));
  check('Source Z(竖直) → viewer Y', near(b.pos[1] - a.pos[1], 0));
  // viewer yaw：面朝 +Z 应为 180°（viewer forward = (−sinθ, 0, −cosθ)）
  check('yaw=0 → viewerYaw=180（面朝 +Z）', near(a.ang[0], 180), String(a.ang[0]));
  const fwd = [-Math.sin((a.ang[0] * Math.PI) / 180), -Math.cos((a.ang[0] * Math.PI) / 180)];
  const move = [b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]];
  const cos = (fwd[0] * move[0] + fwd[1] * move[1]) / (Math.hypot(...fwd) * Math.hypot(...move));
  check('视角方向与运动方向一致', cos > 0.999, `cos=${cos.toFixed(4)}`);
  // pitch：Source pitch 正 = 俯视 → viewer 应为负
  const lookDown = fnSW({ pos: [0, 0, 0], ang: [30, 0] }, 0, H);
  check('Source pitch +30（俯视）→ viewer −30', near(lookDown.ang[1], -30), String(lookDown.ang[1]));
}

console.log('\n[7] 错误处理');
const rBad: RuleConfig = {
  ...defaultRule(),
  scriptSrc: `(raw, i, H) => ({ t: i / 128, pos: [H.num(H.get(raw, 'nope[9]')), 0, 0], ang: [0, 0, 0], vel: null })`,
};
const bad = probeScript(compileScript(rBad.scriptSrc), frames);
check('坏路径被 probe 抓到', !bad.ok, bad.error);
console.log('  错误信息：' + String(bad.error));

try {
  compileScript('(raw, i, H) => { syntax error here');
  check('语法错误会抛', false);
} catch {
  check('语法错误会抛', true);
}

console.log('\n[7b] 规则文件解析（.js / 规则 JSON 双形态，ruleFromText）');
const jsRule = ruleFromText(CUSTOM_SRC, 'custom.js');
check(
  '裸 .js → script 规则（scriptSrc 原样）',
  jsRule?.kind === 'script' && jsRule.rule.scriptSrc === CUSTOM_SRC,
);
check('裸 .js 规则名取文件名', jsRule?.rule.name === 'custom.js');
const jsonRule = ruleFromText(
  JSON.stringify({
    version: 1,
    name: 'R',
    scriptSrc: CUSTOM_SRC,
    transform: { offset: [1, 2, 3], yawDeg: 90 },
  }),
  'r.json',
);
check('规则 JSON → json 规则（scriptSrc 原样）', jsonRule?.kind === 'json' && jsonRule.rule.scriptSrc === CUSTOM_SRC);
check('transform 字段原样保留', jsonRule?.rule.transform?.yawDeg === 90 && jsonRule.rule.transform?.offset[2] === 3);
check('坏 JSON（{ 开头解析失败）→ null', ruleFromText('{oops', 'x') === null);
check('非规则 JSON（缺 version/scriptSrc）→ null', ruleFromText(JSON.stringify({ foo: 1 }), 'x') === null);
const compiledFromJs = compileScript(jsRule!.rule.scriptSrc);
check('.js 规则可编译并产出合法帧', compiledFromJs({ o: [1, 100, 2], yaw: 0, pitch: 0, ms: 0, v: [0, 0, 0] }, 0, H).pos[0] === 2);

console.log('\n[8] 容错：脏数据不炸（NaN / 时间回退）');
const dirty = [
  { pos: [0, 0, 0], ang: [0, 0], vel: [0, 0, 0] },
  { pos: [null, 1, 2], ang: [10, 0], vel: [1, 1, 1] },
  { pos: [3, 4, 5], ang: [20, 0], vel: [2, 2, 2] },
];
const fnDirty = compileScript(DEFAULT_RULE_SRC);
const dirtyProbe = probeScript(fnDirty, dirty);
check('脏数据被 probe 抓到（第 1 帧）', !dirtyProbe.ok, String(dirtyProbe.error));
// 探针只抽前/中/末帧，绕过它直接 build 才能验证兜底逻辑
const { clip: dirtyClip, warnings: dirtyWarnings } = buildClip({
  name: 'dirty',
  frames: dirty,
  fn: fnDirty,
  rule: defaultRule(),
  resolvedPath: '',
});
check('兜底后帧数不丢', dirtyClip.count === 3, String(dirtyClip.count));
check('兜底后无 NaN', dirtyClip.pos.every((v) => Number.isFinite(v)));
check('给出了警告', dirtyWarnings.length > 0, dirtyWarnings.join(';'));

console.log('\n[9] transform 后处理（变换调整的后端）');
function makeSimpleClip(tf?: RuleConfig['transform']) {
  const r: RuleConfig = { ...defaultRule(), scriptSrc: DEFAULT_RULE_SRC, transform: tf };
  // 默认脚本约定：raw.ang = [pitch, yaw]。这里造一条沿 +X 匀速、面朝 +X（yaw=-90）的轨迹
  return buildClip({
    name: 'tf',
    frames: Array.from({ length: 4 }, (_, i) => ({
      pos: [i * 10, 100, 0],
      ang: [0, -90],
      vel: [1, 0, 0],
    })),
    fn: compileScript(DEFAULT_RULE_SRC),
    rule: r,
    resolvedPath: '',
  }).clip;
}

// 恒等：无 transform 与全零 transform 输出一致
{
  const base = makeSimpleClip();
  const identity = makeSimpleClip({ offset: [0, 0, 0], yawDeg: 0 });
  check('恒等 transform 不动坐标', base.pos.every((v, i) => v === identity.pos[i]));
  check('缺省 transform 字段向后兼容', base.pos[0] === 0 && base.pos[2] === 0);
  check('脚本层 yaw=-90 → wrap 270', near(identity.ang[0], 270), String(identity.ang[0]));
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
  // 数据沿 +X 匀速（pos.x = i*10），yaw=270（即 −90，面朝 +X）。旋转 +90 后：
  //   位移方向 −Z（pos.z 递减）、vel → (0,0,−1)、yaw → 0（面朝 −Z，与运动一致）
  check('旋转后 pos 沿 −Z 递减', near(c.pos[2], 0) && near(c.pos[2 + 6], -20), JSON.stringify([c.pos[2], c.pos[8]]));
  check('旋转后 vel → (0,0,−1)', c.vel !== null && near(c.vel[0], 0, 1e-6) && near(c.vel[2], -1, 1e-6), JSON.stringify(c.vel ? [c.vel[0], c.vel[2]] : []));
  check('旋转后 yaw = 0（与运动方向自洽）', near(c.ang[0], 0) || near(c.ang[0], 360), String(c.ang[0]));
  check('旋转重算 bbox', near(c.bbox.min[2], -30) && near(c.bbox.max[2], 0), JSON.stringify(c.bbox));
}

// 组合：先旋转后平移（offset 在旋转之后的坐标系里施加）
{
  const c = makeSimpleClip({ offset: [100, 0, 0], yawDeg: 90 });
  // 旋转后 x∈[0,0]、z∈[−30,0]；再平移 x+100
  check('组合变换 pos.x = 100', near(c.pos[0], 100), String(c.pos[0]));
  check('组合变换 bbox.x = [100,100]', near(c.bbox.min[0], 100) && near(c.bbox.max[0], 100));
}

// transform 不污染速度模长（刚体变换）
{
  const c = makeSimpleClip({ offset: [5, 7, 9], yawDeg: 37 });
  check('旋转平移不改速度模长', c.vel !== null && near(Math.hypot(c.vel[0], c.vel[1], c.vel[2]), 1, 1e-6));
}

console.log('\n[10] 多轨迹对比（Q2）');
function makeClip(frames: number, name: string) {
  const json = JSON.parse(buildSampleReplayText(frames)) as unknown;
  const fs = getPath(json, 'frames') as unknown[];
  return buildClip({ name, frames: fs, fn: compileScript(DEFAULT_RULE_SRC), rule: defaultRule(), resolvedPath: 'frames' }).clip;
}

const clipA = makeClip(256, 'A'); // 时长 255/128
const clipB = makeClip(128, 'B'); // 时长 127/128
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

// 改规则后的重新导入必须**替换**那条轨道，而不是每次都追加一条
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

console.log('\n[11] 大文件进度节奏（Q5）');
// 29 万帧（67 tick/s × 12h 量级）：进度回调应约 50 次，而不是 2 次
const bigFrames = 289_440;
const seen: number[] = [];
const bigClip = buildClip({
  name: 'big',
  frames: Array.from({ length: bigFrames }, (_, i) => ({
    pos: [i, i, i],
    ang: [0, 0],
    vel: [1, 1, 1],
  })),
  fn: compileScript(DEFAULT_RULE_SRC),
  rule: defaultRule(),
  resolvedPath: '',
  onProgress: (done) => seen.push(done),
});
check('帧数正确', bigClip.clip.count === bigFrames, String(bigClip.clip.count));
check('进度回调次数 ≥ 40', seen.length >= 40, String(seen.length));
check('进度回调次数 ≤ 120（不刷屏）', seen.length <= 120, String(seen.length));
check('进度单调', seen.every((v, i) => i === 0 || v > seen[i - 1]));

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}\n`);
process.exit(failures === 0 ? 0 : 1);
