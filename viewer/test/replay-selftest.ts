/**
 * 录像管线核心链路自检（Node，无 DOM）：
 * JSON → 帧数组定位 → 规则脚本编译 → 标准帧 → Clip → 播放器采样。
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
import { applyPreset, compileScript, generateScript, probeScript } from '../src/replay/codegen.js';
import { buildClip } from '../src/replay/build.js';
import { applyTransform, solveTransform } from '../src/replay/calib.js';
import type { Correspondence } from '../src/replay/calib.js';
import { computeOrientation, suggestYawFix } from '../src/replay/orientation.js';
import { ReplayPlayer } from '../src/replay/player.js';
import { defaultRule } from '../src/replay/types.js';
import type { AxisSrc, Sign } from '../src/replay/types.js';

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

function dist3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
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

console.log('\n[3] 默认规则（viewer 原生，tick 128）');
const rule = defaultRule();
rule.scriptSrc = generateScript(rule);
console.log('--- 生成脚本 ---\n' + rule.scriptSrc + '\n----------------');
const fn = compileScript(rule.scriptSrc);
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

console.log('\n[5] Z-up 预设（Source 世界坐标，与地图几何一致）');
// 输入：Source/Hammer Z-up，origin [x, y, z_up]，angles [pitch, yaw, roll]
// 映射：(x,y,z)→(y,z,x)（与 map_coords 一致），viewerYaw = yaw + 180，pitch 取反。
// 注：早期版本这里写的是跨模块常量 bspYawToCsYaw=(270−yaw)，实测表明在 (y,z,x) 下
//     正确变换是 yaw+180（见 [14] 与其注释里的定标依据）。
const zup = {
  frames: [
    { o: [100, 200, 300], a: [0, 0, 0] },
    { o: [110, 210, 310], a: [0, 90, 0] },
  ],
};
const r2 = defaultRule();
r2.framePath = 'frames';
r2.posX = 'o[0]';
r2.posY = 'o[1]';
r2.posZ = 'o[2]';
r2.yawPath = 'a[1]';
r2.pitchPath = 'a[0]';
applyPreset(r2, 'bsp-entity');
r2.scriptSrc = generateScript(r2);
console.log('--- Z-up 脚本 ---\n' + r2.scriptSrc + '\n-----------------');
const fn2 = compileScript(r2.scriptSrc);
const f0 = fn2(zup.frames[0], 0, H);
check(
  '轴映射 (x,y,z)→(y,z,x)',
  f0.pos[0] === 200 && f0.pos[1] === 300 && f0.pos[2] === 100,
  JSON.stringify(f0.pos),
);
check('yaw = (0 + 180)%360 = 180', near(f0.ang[0], 180), String(f0.ang[0]));
const f1 = fn2(zup.frames[1], 1, H);
check('yaw = (90 + 180)%360 = 270', near(f1.ang[0], 270), String(f1.ang[0]));
// 保角性：源空间「位移 vs 朝向」的夹角，映射后必须不变。
// 数据是对角移动 (10,10,10)，源 yaw=0 朝 +X，故两侧都应是 45°。
{
  const angBetween = (a: number[], b: number[]) => {
    const c = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
    return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  };
  // 源空间：水平面 (x,y)，yaw=0 → 前向 +X
  const srcMove = [110 - 100, 210 - 200];
  const thSrc = angBetween(srcMove, [1, 0]);
  // viewer 空间：水平面 (x,z)，前向 = (−sinθ, −cosθ)
  const th = (f0.ang[0] * Math.PI) / 180;
  const viewMove = [f1.pos[0] - f0.pos[0], f1.pos[2] - f0.pos[2]];
  const thView = angBetween(viewMove, [-Math.sin(th), -Math.cos(th)]);
  check('源空间夹角 = 45°（对角移动 vs 朝 +X）', near(thSrc, 45, 1e-6), thSrc.toFixed(3));
  check('viewer 空间夹角同为 45°（保角）', near(thView, 45, 1e-6), thView.toFixed(3));
}

console.log('\n[6] 眼位换算 + 单位缩放 + 弧度 + 时间字段');
const r3 = defaultRule();
r3.framePath = 'frames';
r3.posX = 'o[0]';
r3.posY = 'o[1]';
r3.posZ = 'o[2]';
r3.yawPath = 'yaw';
r3.pitchPath = 'pitch';
r3.posIsEye = true;
r3.posScale = 2;
r3.angleUnit = 'rad';
r3.timeMode = 'field';
r3.timePath = 'ms';
r3.timeUnit = 'ms';
r3.scriptSrc = generateScript(r3);
const f3 = compileScript(r3.scriptSrc)(
  { o: [10, 100, 20], yaw: Math.PI, pitch: Math.PI / 4, ms: 2500 },
  7,
  H,
);
check('缩放 ×2', f3.pos[0] === 20 && f3.pos[2] === 40, JSON.stringify(f3.pos));
check('眼位减 64.09', near(f3.pos[1], 200 - 64.09, 1e-6), String(f3.pos[1]));
check('弧度转度 yaw 180', near(f3.ang[0], 180), String(f3.ang[0]));
check('弧度转度 pitch 45', near(f3.ang[1], 45), String(f3.ang[1]));
check('毫秒时间戳 → 2.5s', near(f3.t, 2.5), String(f3.t));

console.log('\n[7] 速度走同一套轴映射');
const r4 = defaultRule();
r4.framePath = 'frames';
r4.velX = 'v[0]';
r4.velY = 'v[1]';
r4.velZ = 'v[2]';
r4.posX = 'p[0]';
r4.posY = 'p[1]';
r4.posZ = 'p[2]';
r4.yawPath = '';
r4.pitchPath = '';
r4.axisX = 'x';
r4.axisY = 'z';
r4.axisZ = 'y';
r4.signZ = -1;
r4.scriptSrc = generateScript(r4);
const f4 = compileScript(r4.scriptSrc)({ p: [1, 2, 3], v: [10, 20, 30] }, 0, H);
check(
  '位置 Z-up 映射',
  f4.pos[0] === 1 && f4.pos[1] === 3 && f4.pos[2] === -2,
  JSON.stringify(f4.pos),
);
check(
  '速度同映射',
  f4.vel !== null && f4.vel !== undefined && f4.vel[0] === 10 && f4.vel[1] === 30 && f4.vel[2] === -20,
  JSON.stringify(f4.vel),
);

console.log('\n[8] 错误处理');
const rBad = defaultRule();
rBad.framePath = 'frames';
rBad.posX = 'nope[9]';
rBad.posY = 'nope[9]';
rBad.posZ = 'nope[9]';
rBad.scriptSrc = generateScript(rBad);
const bad = probeScript(compileScript(rBad.scriptSrc), frames);
check('坏路径被 probe 抓到', !bad.ok, bad.error);
console.log('  错误信息：' + String(bad.error));

try {
  compileScript('(raw, i, H) => { syntax error here');
  check('语法错误会抛', false);
} catch {
  check('语法错误会抛', true);
}

console.log('\n[9] 容错：脏数据不炸（NaN / 时间回退）');
const dirty = [
  { pos: [0, 0, 0], ang: [0, 0], vel: [0, 0, 0] },
  { pos: [null, 1, 2], ang: [10, 0], vel: [1, 1, 1] },
  { pos: [3, 4, 5], ang: [20, 0], vel: [2, 2, 2] },
];
const rDirty = defaultRule();
rDirty.framePath = '';
rDirty.scriptSrc = generateScript(rDirty);
const fnDirty = compileScript(rDirty.scriptSrc);
const dirtyProbe = probeScript(fnDirty, dirty);
check('脏数据被 probe 抓到（第 1 帧）', !dirtyProbe.ok, String(dirtyProbe.error));
// 探针只抽前/中/末帧，绕过它直接 build 才能验证兜底逻辑
const { clip: dirtyClip, warnings: dirtyWarnings } = buildClip({
  name: 'dirty',
  frames: dirty,
  fn: fnDirty,
  rule: rDirty,
  resolvedPath: '',
});
check('兜底后帧数不丢', dirtyClip.count === 3, String(dirtyClip.count));
check('兜底后无 NaN', dirtyClip.pos.every((v) => Number.isFinite(v)));
check('给出了警告', dirtyWarnings.length > 0, dirtyWarnings.join(';'));

console.log('\n[10] 坐标系标定求解（Q4）');
// 真值变换：out = 2 · S·P · in + (10,20,30)，P=(y,z,x)，S=(1,1,1)（det=+1，非镜像）
const TRUTH = {
  axis: ['y', 'z', 'x'] as [AxisSrc, AxisSrc, AxisSrc],
  sign: [1, 1, 1] as [Sign, Sign, Sign],
  scale: 2,
  offset: [10, 20, 30] as [number, number, number],
  mirrored: false,
};
const rawPts: Array<[number, number, number]> = [
  [0, 0, 0],
  [100, 0, 0],
  [0, 250, 0],
  [30, 40, 55],
  [-70, 15, 200],
];
const pairs: Correspondence[] = rawPts.map((raw) => ({
  raw,
  world: applyTransform(TRUTH, raw),
}));

const solved = solveTransform(pairs);
check('求解成功', solved.ok, solved.ok ? '' : solved.error);
if (solved.ok) {
  const b = solved.best;
  check('轴映射复原', b.axis.join('') === 'yzx', b.axis.join(''));
  check('符号复原', b.sign.join(',') === '1,1,1', b.sign.join(','));
  check('缩放复原 2', near(b.scale, 2, 1e-9), String(b.scale));
  check('平移复原', near(b.offset[0], 10, 1e-6) && near(b.offset[1], 20, 1e-6) && near(b.offset[2], 30, 1e-6), JSON.stringify(b.offset));
  check('残差 ~0', b.maxResidual < 1e-6, String(b.maxResidual));
  check('非镜像', b.mirrored === false, String(b.mirrored));
  // 只有「缩放非 1」这一条合理提示（真值 scale 就是 2），不该有残差/次优/镜像类警戒
  check(
    '5 点无质量类警戒',
    solved.warnings.length === 1 && solved.warnings[0].includes('单位缩放'),
    solved.warnings.join('；'),
  );
  // 回代：拿求出的解变换一个没参与标定的点，必须落在真值变换的位置上
  const probe = [123, -45, 67];
  const got = applyTransform(b, probe);
  const want = applyTransform(TRUTH, probe);
  check('未参与标定的点也对齐', dist3(got, want) < 1e-6, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  // 解出的参数写回规则后，生成的脚本应当产出同一结果
  const rCal = defaultRule();
  rCal.posX = 'p[0]';
  rCal.posY = 'p[1]';
  rCal.posZ = 'p[2]';
  rCal.axisX = b.axis[0];
  rCal.axisY = b.axis[1];
  rCal.axisZ = b.axis[2];
  rCal.signX = b.sign[0];
  rCal.signY = b.sign[1];
  rCal.signZ = b.sign[2];
  rCal.posScale = b.scale;
  rCal.offX = b.offset[0];
  rCal.offY = b.offset[1];
  rCal.offZ = b.offset[2];
  rCal.scriptSrc = generateScript(rCal);
  const viaScript = compileScript(rCal.scriptSrc)({ p: probe }, 0, H);
  check('写回规则后脚本输出一致', dist3(viaScript.pos, want) < 1e-4, `${JSON.stringify(viaScript.pos)} vs ${JSON.stringify(want)}`);
  // 平移不得污染速度
  rCal.velX = 'v[0]';
  rCal.velY = 'v[1]';
  rCal.velZ = 'v[2]';
  rCal.scriptSrc = generateScript(rCal);
  const velFrame = compileScript(rCal.scriptSrc)({ p: probe, v: [1, 2, 3] }, 0, H);
  // 速度：与位置同一套轴映射与缩放，但不吃平移。v=[1,2,3] → [_vy,_vz,_vx]·2 = [4,6,2]
  check(
    '速度不受平移影响',
    velFrame.vel !== null && velFrame.vel[0] === 4 && velFrame.vel[1] === 6 && velFrame.vel[2] === 2,
    JSON.stringify(velFrame.vel),
  );
}

// 镜像真值：S=(1,1,-1) 使 det = −1，求解器应当照样精确复原并如实标记 mirrored
const MIRROR = {
  axis: ['y', 'z', 'x'] as [AxisSrc, AxisSrc, AxisSrc],
  sign: [1, 1, -1] as [Sign, Sign, Sign],
  scale: 2,
  offset: [10, 20, 30] as [number, number, number],
  mirrored: false,
};
const mirrorPairs: Correspondence[] = rawPts.map((raw) => ({
  raw,
  world: applyTransform(MIRROR, raw),
}));
const mirrorSolved = solveTransform(mirrorPairs);
check('镜像真值也能精确复原', mirrorSolved.ok && mirrorSolved.best.maxResidual < 1e-6, mirrorSolved.ok ? String(mirrorSolved.best.maxResidual) : mirrorSolved.error);
check('如实标记 mirrored', mirrorSolved.ok && mirrorSolved.best.mirrored === true);
check(
  '镜像解附警告',
  mirrorSolved.ok && mirrorSolved.warnings.some((w) => w.includes('镜像')),
  mirrorSolved.ok ? mirrorSolved.warnings.join('；') : '',
);

check('1 组对应点 → 报错', !solveTransform([pairs[0]]).ok);
check('2 组对应点 → 可解但提示无冗余', (() => {
  const r = solveTransform(pairs.slice(0, 2));
  return r.ok && r.warnings.some((w) => w.includes('没有冗余'));
})());
check('点重合 → 报错', !solveTransform([
  { raw: [1, 2, 3], world: [4, 5, 6] },
  { raw: [1, 2, 3], world: [7, 8, 9] },
]).ok);
check('3 点带噪声仍能给出可用解', (() => {
  const noisy = pairs.slice(0, 3).map((p, i) => ({
    raw: p.raw,
    world: [p.world[0] + (i - 1) * 0.4, p.world[1], p.world[2]] as [number, number, number],
  }));
  const r = solveTransform(noisy);
  return r.ok && r.best.maxResidual < 1 && near(r.best.scale, 2, 0.05);
})());

console.log('\n[11] 多轨迹对比（Q2）');
function makeClip(frames: number, name: string) {
  const json = JSON.parse(buildSampleReplayText(frames)) as unknown;
  const r = defaultRule();
  r.scriptSrc = generateScript(r);
  const fs = getPath(json, 'frames') as unknown[];
  return buildClip({ name, frames: fs, fn: compileScript(r.scriptSrc), rule: r, resolvedPath: 'frames' }).clip;
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

console.log('\n[12] 大文件进度节奏（Q5）');
// 29 万帧（67 tick/s × 12h 量级）：进度回调应约 50 次，而不是 2 次
const bigFrames = 289_440;
const seen: number[] = [];
const rBig = defaultRule();
rBig.scriptSrc = generateScript(rBig);
const bigClip = buildClip({
  name: 'big',
  frames: Array.from({ length: bigFrames }, (_, i) => ({
    pos: [i, i, i],
    ang: [0, 0],
    vel: [1, 1, 1],
  })),
  fn: compileScript(rBig.scriptSrc),
  rule: rBig,
  resolvedPath: '',
  onProgress: (done) => seen.push(done),
});
check('帧数正确', bigClip.clip.count === bigFrames, String(bigClip.clip.count));
check('进度回调次数 ≥ 40', seen.length >= 40, String(seen.length));
check('进度回调次数 ≤ 120（不刷屏）', seen.length <= 120, String(seen.length));
check('进度单调', seen.every((v, i) => i === 0 || v > seen[i - 1]));

console.log('\n[13] 朝向一致性算法（orientation.ts，notes/requirements.md §2.1/§2.3）');
// 合成 Source 系数据：沿 +X 匀速直线（yaw=0、pitch=0），shavit 预设 (x,y,z)→(y,z,x)、yaw+180
const srcStraight = Array.from({ length: 64 }, (_, i) => ({ pos: [i * 5, 0, 0], ang: [0, 0] }));
const rS = defaultRule();
rS.posX = 'pos[0]';
rS.posY = 'pos[1]';
rS.posZ = 'pos[2]';
rS.yawPath = 'ang[1]';
rS.pitchPath = 'ang[0]';
applyPreset(rS, 'shavit-replay');
rS.scriptSrc = generateScript(rS);
const oS = computeOrientation(srcStraight, rS);
check('Source +X 直线（shavit 预设）→ PASS 且 θ≈0', oS.verdict === 'pass' && oS.angleDeg < 1, `${oS.verdict} θ=${oS.angleDeg}`);

// 错误映射：默认 viewer 原生（yawOffset=0、轴映射恒等）套在 Source 数据上 → 需修正
const rBad2 = defaultRule();
rBad2.posX = 'pos[0]';
rBad2.posY = 'pos[1]';
rBad2.posZ = 'pos[2]';
rBad2.yawPath = 'ang[1]';
rBad2.pitchPath = 'ang[0]';
rBad2.scriptSrc = generateScript(rBad2);
const oBad = computeOrientation(srcStraight, rBad2);
check('错误映射 → fix（θ≈90°）', oBad.verdict === 'fix' && Math.abs(oBad.angleDeg - 90) < 1, `${oBad.verdict} θ=${oBad.angleDeg}`);
const fx = suggestYawFix(srcStraight, rBad2);
check(
  '一键修正 → yawOffset −90，夹角回 0',
  fx.applicable === true && Math.abs(fx.yawOffsetTo - -90) < 1 && fx.angleAfter < 1,
  `${fx.yawOffsetFrom}→${fx.yawOffsetTo}：${fx.angleBefore.toFixed(1)}°→${fx.angleAfter.toFixed(1)}°`,
);

// 原地站立（位移 < D_MIN）→ SKIP，不算 FAIL
const still = Array.from({ length: 64 }, (_, i) => ({ pos: [100, 0, 0], ang: [0, 0] }));
const oStill = computeOrientation(still, rS);
check('原地站立 → SKIP（位移不足）', oStill.verdict === 'skip' && /位移/.test(oStill.reason ?? ''), oStill.reason ?? '');

// 起跑即转向（前 15 帧原地转 0→75°，随后沿 60° 方向直线）→ 主窗口 SKIP；
// preFrames 起跑点后移动方向与朝向一致 → PASS
const turny = Array.from({ length: 120 }, (_, i) => {
  const t = Math.max(0, i - 15);
  return {
    pos: [t * 5 * Math.cos(Math.PI / 3), t * 5 * Math.sin(Math.PI / 3), 0],
    ang: [0, i < 15 ? i * 5 : 60],
  };
});
const oTurn = computeOrientation(turny, rS, 15);
check(
  '起跑转向 + preFrames → 整体 PASS（依据 preFrames 窗口）',
  oTurn.verdict === 'pass' && oTurn.preFramesUsed === true,
  `${oTurn.verdict} preFramesUsed=${oTurn.preFramesUsed}`,
);
const oTurnNoPre = computeOrientation(turny, rS);
check('无 preFrames 时起跑转向 → SKIP（数据不足，不算 FAIL）', oTurnNoPre.verdict === 'skip', oTurnNoPre.reason ?? '');

console.log('\n[14] Source → viewer 映射必须与地图几何一致（定标结论，勿改）');
// 依据：maps/surf_null.bsp 的出生点 + surf_null_4.replay 实测定标。
//   GLB 导出 map_coords / parse_spawn_points 的 rotate_yup 均为 [x,y,z]→[y,z,x]（无符号翻转）。
//   录像位置必须走同一变换，否则轨迹相对地图整体绕竖直轴旋转 90°。
//   实测：按 (y,z,x) 首帧到最近出生点 191 HU，(x,z,−y) 则是 5706 HU。
for (const id of ['source-world', 'shavit-replay', 'bsp-entity']) {
  const r = defaultRule();
  applyPreset(r, id);
  check(`${id}：轴映射 = (y,z,x)`, r.axisX === 'y' && r.axisY === 'z' && r.axisZ === 'x', `${r.axisX}${r.axisY}${r.axisZ}`);
  check(`${id}：无符号翻转`, r.signX === 1 && r.signY === 1 && r.signZ === 1);
  check(`${id}：yaw_out = yaw + 180`, r.yawScale === 1 && near(r.yawOffset, 180), `${r.yawScale}*yaw+${r.yawOffset}`);
  check(`${id}：pitch 取反（Source 正=俯视）`, r.pitchSign === -1);
  check(`${id}：缩放 1、平移 0`, near(r.posScale, 1) && near(r.offX, 0) && near(r.offY, 0) && near(r.offZ, 0));
}

// 端到端：Source 里朝 +X 走 10 HU，在 viewer 里必须朝 +Z，且视角也朝 +Z
{
  const r = defaultRule();
  applyPreset(r, 'shavit-replay');
  r.posX = 'pos[0]';
  r.posY = 'pos[1]';
  r.posZ = 'pos[2]';
  r.yawPath = 'ang[1]';
  r.pitchPath = 'ang[0]';
  r.scriptSrc = generateScript(r);
  const fn = compileScript(r.scriptSrc);
  // Source: 位于原点、yaw=0（面朝 +X）、pitch=0
  const a = fn({ pos: [0, 0, 0], ang: [0, 0] }, 0, H);
  const b = fn({ pos: [10, 0, 0], ang: [0, 0] }, 1, H);
  check('Source +X 位移 → viewer +Z', near(b.pos[0] - a.pos[0], 0) && near(b.pos[2] - a.pos[2], 10), JSON.stringify(b.pos));
  check('Source Z(竖直) → viewer Y', near(b.pos[1] - a.pos[1], 0));
  // viewer yaw：面朝 +Z 应为 180°（viewer forward = (−sinθ, 0, −cosθ)）
  check('yaw=0 → viewerYaw=180（面朝 +Z）', near(a.ang[0], 180), String(a.ang[0]));
  const fwd = [-Math.sin((a.ang[0] * Math.PI) / 180), -Math.cos((a.ang[0] * Math.PI) / 180)];
  const move = [b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]];
  const cos = (fwd[0] * move[0] + fwd[1] * move[1]) / (Math.hypot(...fwd) * Math.hypot(...move));
  check('视角方向与运动方向一致', cos > 0.999, `cos=${cos.toFixed(4)}`);
  // pitch：Source pitch 正 = 俯视 → viewer 应为负
  const lookDown = fn({ pos: [0, 0, 0], ang: [30, 0] }, 0, H);
  check('Source pitch +30（俯视）→ viewer −30', near(lookDown.ang[1], -30), String(lookDown.ang[1]));
}

// 反例：通用 glTF 约定与本项目几何差 90°，必须保持「不匹配」的明确标注
{
  const r = defaultRule();
  applyPreset(r, 'gltf-zup');
  check(
    'gltf-zup 仍为 (x,z,−y)+yaw−90（仅导出给别的 DCC 用）',
    r.axisX === 'x' && r.axisY === 'z' && r.axisZ === 'y' && r.signZ === -1 && near(r.yawOffset, -90),
  );
  const canon = defaultRule();
  applyPreset(canon, 'source-world');
  check(
    'gltf-zup 与 source-world 确实不同（相差绕竖直轴 90°）',
    !(r.axisX === canon.axisX && r.axisY === canon.axisY && r.axisZ === canon.axisZ && r.signZ === canon.signZ),
  );
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}\n`);
process.exit(failures === 0 ? 0 : 1);
