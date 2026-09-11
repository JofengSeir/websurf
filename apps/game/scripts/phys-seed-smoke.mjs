/**
 * t3 种子面 v2 回归（node 级，禁浏览器）：set_state_ex / state_full_json / seed_from
 * + state_out 22 槽（B5 十字段 + eye_height + on_ground）。
 *
 * 验证链（对应 t1 事实表 plan/field-fidelity.md 的活性缺口）：
 *   A  全字段往返 + 位级种子等价（混合输入 40 tick，set_state_ex 与 seed_from 双通道）
 *   B  ground_normal 活性缺口闭环（45° 坡带速着地：v2 种子位级全等；9 参 set_state
 *      负对照必现 nopre 钳误触发发散——bench s3c 机制复刻）
 *   C  contact_ticks 活性缺口闭环（埋地 trigger B 路径：v2 同 tick 传送同 tick 事件；
 *      9 参负对照恰晚 1 tick——bench s4b 机制复刻）
 *   D  ducked/duck_frac 活性缺口闭环（半蹲态：v2 眼高即刻相等；9 参负对照眼高 Δ 大）
 *   E  old_jump 条件性活位（autobhop=false 持跳跨种子：v2 位级全等；9 参负对照重跳）
 *   F  state_out 22 槽逐槽语义（tick_into 追加写 + 种子面预填）
 *   G  set_state_ex 防御：坏 JSON / schema v 错 / triggers_inside 错长 → FAIL LOUD
 *
 * 用法：node scripts/phys-seed-smoke.mjs（需先 npm run build:wasm）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
const initOut = initSync({ module: wasmBytes });
const mem = initOut.memory;

const DT = 1 / 64;
let passCount = 0;

function ok(msg) {
  passCount += 1;
  console.log('OK ' + msg);
}

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

// 地板世界（与 phys-smoke 同构：地面 y=0 法线朝下 → 内部 y>=0）
const floorBrush = JSON.stringify([
  {
    planes: [
      { normal: [0, -1, 0], dist: 0 },
      { normal: [0, 1, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 1000 },
      { normal: [-1, 0, 0], dist: 1000 },
      { normal: [0, 0, 1], dist: 1000 },
      { normal: [0, 0, -1], dist: 1000 },
    ],
    min: [-1000, 0, -1000], max: [1000, 0.01, 1000],
    is_ladder: false, is_solid: true,
  },
]);

// 45° 坡世界：表面 y+z=0（solid 在下），带速着地复刻 bench s3c
const S = Math.SQRT1_2;
const rampBrush = JSON.stringify([
  {
    planes: [
      { normal: [0, S, S], dist: 0 },
      { normal: [0, -1, 0], dist: 20 },
      { normal: [1, 0, 0], dist: 500 },
      { normal: [-1, 0, 0], dist: 500 },
      { normal: [0, 0, 1], dist: 500 },
      { normal: [0, 0, -1], dist: 500 },
    ],
    min: [-500, -20, -500], max: [500, 500, 500],
    is_ladder: false, is_solid: true,
  },
]);

// 埋地 trigger 世界：trigger 体 y∈[-8,-0.5]（A 路径体段 [pos.y, pos.y+72] 不相交，
// 仅 B 路径脚底 8u 下探可触发）→ grounded 门即 contact_ticks 门（bench s4b 同构）
const buriedTele = JSON.stringify({
  teleports: [{ index: 0, targetname: 'tp_dest2', origin: [50, 0, 30], angles: [0, 90, 0] }],
  triggers: [{
    index: 0, classname: 'trigger_teleport', target: 'tp_dest2', origin: [0, 0, 0],
    model_mins: [-10, -8, -10], model_maxs: [10, -0.5, 10], spawnflags: 1,
  }],
});

const emptyTele = '{"teleports":[],"triggers":[]}';

function newWorld(brush, tele, sx, sy, sz, yaw) {
  const w = new PhysWorld();
  w.build_world(brush, '[]', tele, sx, sy, sz, yaw);
  return w;
}

/** 逐 tick 双跑比较：返回 {equal, firstDiffTick}。 */
function driveAndCompare(a, b, masks, label) {
  for (let i = 0; i < masks.length; i++) {
    a.tick(DT, masks[i], 0, 0);
    b.tick(DT, masks[i], 0, 0);
    const sa = a.state_full_json(false);
    const sb = b.state_full_json(false);
    if (sa !== sb) {
      // 找出首个分歧行（诊断）
      const pa = JSON.parse(sa);
      const pb = JSON.parse(sb);
      const diffKeys = Object.keys(pa).filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
      return { equal: false, firstDiffTick: i, diffKeys };
    }
  }
  return { equal: true, firstDiffTick: -1 };
}

/** 9 参 set_state 从种子 JSON 摘要播种（负对照通道）。 */
function seedNine(w, snapJson) {
  const s = JSON.parse(snapJson);
  w.set_state(s.origin[0], s.origin[1], s.origin[2], s.yaw, s.pitch,
    s.velocity[0], s.velocity[1], s.velocity[2], s.on_ground);
}

// ---------------------------------------------------------------------------
// A. 全字段往返 + 位级种子等价（混合输入）
// ---------------------------------------------------------------------------
{
  const masks = [
    0x01, 0x01, 0x01 | 0x20, 0x01 | 0x20, 0x01 | 0x20, 0x10, 0x10, 0, 0, 0,
    0x01, 0x01 | 0x200, 0x01 | 0x200, 0x01, 0x01 | 0x400, 0x10, 0x10, 0, 0,
    0x01 | 0x20, 0x01 | 0x20, 0x01, 0x01, 0x10, 0x10, 0, 0x01, 0x01, 0, 0,
  ];
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  for (let i = 0; i < 24; i++) a.tick(DT, masks[i], 0, 0);
  const snap = a.state_full_json(false);
  const s1 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  s1.set_state_ex(snap);
  const s2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  s2.seed_from(a);
  const r1 = driveAndCompare(a, s1, masks.slice(24), 'A/set_state_ex');
  const r2 = driveAndCompare(a, s2, [], 'A/seed_from(空窗)');
  // seed_from 后继续同窗口
  for (let i = 0; i < masks.slice(24).length; i++) s2.tick(DT, masks[i + 24], 0, 0);
  const r2b = a.state_full_json(false) === s2.state_full_json(false);
  if (!r1.equal) fail('A: set_state_ex 种子后分叉 tick' + r1.firstDiffTick + ' keys=' + r1.diffKeys);
  if (!r2b) fail('A: seed_from 种子后分叉');
  ok('A: 全字段往返位级全等（set_state_ex + seed_from 双通道，' + masks.length + ' tick 混合输入）');
}

// ---------------------------------------------------------------------------
// B. ground_normal 活性缺口（45° 坡带速着地；bench s3c 复刻）
// ---------------------------------------------------------------------------
{
  const a = newWorld(rampBrush, emptyTele, 0, 80, -40, 0);
  a.set_state(0, 80, -40, 0, 0, 0, -800, 500, false);
  let landed = false;
  for (let i = 0; i < 30; i++) {
    a.tick(DT, 0, 0, 0);
    const st = a.state();
    if (st.onGround) { landed = true; break; }
  }
  if (!landed) fail('B: 坡面未着陆');
  a.tick(DT, 0, 0, 0); // 带速滑行 1 tick（walk_move 消费 ground_normal）
  const snap = a.state_full_json(false);
  const sp = JSON.parse(snap);
  if (sp.ground_normal[1] > 0.999) fail('B: 权威 ground_normal 非坡面 gn=' + sp.ground_normal);
  const hSpeed = Math.hypot(sp.velocity[0], sp.velocity[2]);
  if (hSpeed < 260) fail('B: 带速不足 h=' + hSpeed.toFixed(0) + '（钳制不会咬合）');

  const v2 = newWorld(rampBrush, emptyTele, 0, 80, -40, 0);
  v2.set_state_ex(snap);
  const neg = newWorld(rampBrush, emptyTele, 0, 80, -40, 0);
  seedNine(neg, snap);
  const slide = [0, 0, 0, 0, 0, 0, 0, 0];
  const r = driveAndCompare(a, v2, slide, 'B/v2');
  if (!r.equal) fail('B: v2 种子坡面带速分叉 tick' + r.firstDiffTick + ' keys=' + r.diffKeys);
  let negDiverged = false;
  const an = [], nn = [];
  for (let i = 0; i < slide.length; i++) {
    a.tick(DT, 0, 0, 0);
    neg.tick(DT, 0, 0, 0);
    an.push(a.state_full_json(false));
    nn.push(neg.state_full_json(false));
    if (an[i] !== nn[i]) { negDiverged = true; break; }
  }
  if (!negDiverged) fail('B: 9 参负对照未发散（钳制未咬合？）');
  ok('B: ground_normal 活性缺口闭环——v2 位级全等（h=' + hSpeed.toFixed(0) + '），9 参负对照发散 ✓（bench s3c 复刻）');
}

// ---------------------------------------------------------------------------
// C. contact_ticks 活性缺口（埋地 trigger B 路径；bench s4b 复刻）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, buriedTele, 0, 120, 0, 0);
  let landed = false;
  for (let i = 0; i < 90; i++) {
    a.tick(DT, 0, 0, 0);
    if (a.state().onGround) { landed = true; break; }
  }
  if (!landed) fail('C: 未落地');
  const snap = a.state_full_json(false); // 落地 tick 末：contact_ticks≥1，check 尚未再跑
  const sp = JSON.parse(snap);
  if (sp.contact_ticks < 1) fail('C: 快照 contact_ticks<1');

  const v2 = newWorld(floorBrush, buriedTele, 0, 120, 0, 0);
  v2.set_state_ex(snap);
  const neg = newWorld(floorBrush, buriedTele, 0, 120, 0, 0);
  seedNine(neg, snap);
  const evA = [], evV = [], evN = [];
  let negFiredAt = -1;
  for (let i = 0; i < 6; i++) {
    a.tick(DT, 0, 0, 0);
    v2.tick(DT, 0, 0, 0);
    neg.tick(DT, 0, 0, 0);
    const ea = a.take_event(), ev = v2.take_event(), en = neg.take_event();
    evA.push(ea ? 'tp' : '-'); evV.push(ev ? 'tp' : '-'); evN.push(en ? 'tp' : '-');
    if (negFiredAt < 0 && en) negFiredAt = i;
  }
  const r = { equal: a.state_full_json(false) === v2.state_full_json(false) };
  const v2FiredAt = evV.indexOf('tp');
  const aFiredAt = evA.indexOf('tp');
  if (!r.equal) fail('C: v2 种子触发后状态分叉');
  if (aFiredAt < 0 || v2FiredAt !== aFiredAt) {
    fail('C: v2 事件时序错位 authority@' + aFiredAt + ' v2@' + v2FiredAt);
  }
  if (negFiredAt < 0 || negFiredAt <= aFiredAt) {
    fail('C: 9 参负对照未晚 1 tick（neg@' + negFiredAt + ' auth@' + aFiredAt + '）');
  }
  ok('C: contact_ticks 活性缺口闭环——v2 同 tick 传送+事件（@' + v2FiredAt + '），9 参负对照晚 1 tick（@' + negFiredAt + '）✓（bench s4b 复刻）');
}

// ---------------------------------------------------------------------------
// D. ducked/duck_frac 活性缺口（半蹲态；bench s5 复刻）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  let landed = false;
  for (let i = 0; i < 60; i++) { a.tick(DT, 0, 0, 0); if (a.state().onGround) { landed = true; break; } }
  if (!landed) fail('D: 未落地');
  a.tick(DT, 0x20, 0, 0);
  a.tick(DT, 0x20, 0, 0);
  a.tick(DT, 0x20, 0, 0); // 蹲伏中段（0 < duck_frac < 1）
  const snap = a.state_full_json(false);
  const sp = JSON.parse(snap);
  if (!sp.ducked || sp.duck_frac <= 0 || sp.duck_frac >= 1) {
    fail('D: 快照非半蹲态 ducked=' + sp.ducked + ' frac=' + sp.duck_frac);
  }
  const v2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  v2.set_state_ex(snap);
  const neg = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  seedNine(neg, snap);
  // 蹲满 → 松键回站（lerp 全程）
  const masks = [0x20, 0x20, 0x20, 0x20, 0, 0, 0, 0, 0, 0];
  const r = driveAndCompare(a, v2, masks, 'D/v2');
  if (!r.equal) fail('D: v2 种子蹲伏分叉 tick' + r.firstDiffTick + ' keys=' + r.diffKeys);
  // 负对照 t0 即量：9 参播种后 frac=0，与权威 frac 差 = frac_A（眼高差 ≈18×frac_A）
  const negFrac0 = JSON.parse(neg.state_full_json(false)).duck_frac;
  const eyeGap = sp.duck_frac - negFrac0;
  if (eyeGap < 0.05) fail('D: 9 参负对照眼高差不足 gap=' + eyeGap.toFixed(3));
  // 负对照行为级：同 mask 再 tick 1 步必分叉（frac 轨迹错位 → 眼高/hull 路径不同）
  a.tick(DT, 0x20, 0, 0);
  neg.tick(DT, 0x20, 0, 0);
  if (a.state_full_json(false) === neg.state_full_json(false)) {
    fail('D: 9 参负对照未分叉（半蹲可播种？与 bench s5 矛盾）');
  }
  ok('D: ducked/duck_frac 活性缺口闭环——v2 半蹲即刻位级全等（frac=' + sp.duck_frac.toFixed(3) + '），9 参负对照 t0 frac 差 ' + eyeGap.toFixed(3) + ' 且行为级分叉 ✓（bench s5 复刻）');
}

// ---------------------------------------------------------------------------
// E. old_jump 条件性活位（autobhop=false 持跳跨种子）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  a.set_params('{"autobhop": false}');
  let landed = false;
  for (let i = 0; i < 60; i++) { a.tick(DT, 0, 0, 0); if (a.state().onGround) { landed = true; break; } }
  if (!landed) fail('E: 未落地');
  a.tick(DT, 0x10, 0, 0); // 起跳
  let relanded = false;
  for (let i = 0; i < 120; i++) { a.tick(DT, 0x10, 0, 0); if (a.state().onGround) { relanded = true; break; } }
  if (!relanded) fail('E: 持跳未回落');
  const snap = a.state_full_json(false); // 落地+持跳：old_jump=true 阻断重跳
  const sp = JSON.parse(snap);
  if (!sp.old_jump || !sp.input.jump) fail('E: 快照非持跳落地态 old_jump=' + sp.old_jump);
  const v2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  v2.set_params('{"autobhop": false}');
  v2.set_state_ex(snap);
  const neg = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  neg.set_params('{"autobhop": false}');
  seedNine(neg, snap);
  const r = driveAndCompare(a, v2, [0x10, 0x10, 0x10, 0x10], 'E/v2');
  if (!r.equal) fail('E: v2 种子持跳落地分叉 tick' + r.firstDiffTick + ' keys=' + r.diffKeys);
  let negJumped = false;
  for (let i = 0; i < 4; i++) {
    a.tick(DT, 0x10, 0, 0);
    neg.tick(DT, 0x10, 0, 0);
    if (JSON.parse(neg.state_full_json(false)).velocity[1] > 50
      && JSON.parse(a.state_full_json(false)).velocity[1] <= 0.01) { negJumped = true; break; }
  }
  if (!negJumped) fail('E: 9 参负对照未出现重跳分歧');
  ok('E: old_jump 条件性活位闭环——v2（autobhop=false）持跳落地位级全等，9 参负对照重跳发散 ✓');
}

// ---------------------------------------------------------------------------
// F. state_out 22 槽逐槽语义（tick_into 追加 + 种子面预填）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  let landed = false;
  for (let i = 0; i < 60; i++) { a.tick(DT, 0, 0, 0); if (a.state().onGround) { landed = true; break; } }
  a.tick(DT, 0x01 | 0x20, 0, 0); // 前进+蹲：让 B5 各槽取非零/多样值
  a.tick_into(DT, 0x01 | 0x20, 0, 0);
  const o = new Float64Array(mem.buffer, a.state_out_ptr(), 22);
  const st = a.state(); // state_js（11 键）
  const full = JSON.parse(a.state_full_json(false));
  const near = (x, y, eps) => Math.abs(x - y) <= (eps || 1e-9);
  const b1 = (v) => (v ? 1 : 0);
  const checks = [
    ['o0 posX', near(o[0], st.posX)], ['o1 posY', near(o[1], st.posY)], ['o2 posZ', near(o[2], st.posZ)],
    ['o3 velX', near(o[3], st.velX)], ['o4 velY', near(o[4], st.velY)], ['o5 velZ', near(o[5], st.velZ)],
    ['o6 yaw', near(o[6], st.yaw)], ['o7 pitch', near(o[7], st.pitch)],
    ['o8 ducked', near(o[8], b1(full.ducked))],
    ['o9 duck_frac', near(o[9], full.duck_frac)],
    ['o10 ground_ticks', near(o[10], full.ground_ticks_since_landing)],
    ['o11 contact_ticks', near(o[11], full.contact_ticks)],
    ['o12 surfing', near(o[12], b1(full.surfing))],
    ['o13 blocked_ticks', near(o[13], full.blocked_ticks)],
    ['o14 on_ladder', near(o[14], full.on_ladder === null ? -1 : full.on_ladder)],
    ['o15 fall_velocity', near(o[15], full.fall_velocity)],
    ['o16-18 landing_velocity', near([o[16], o[17], o[18]], full.landing_velocity, 0)
      || (near(o[16], full.landing_velocity[0]) && near(o[17], full.landing_velocity[1]) && near(o[18], full.landing_velocity[2]))],
    ['o19 has_jumped_before', near(o[19], b1(full.has_jumped_before))],
    ['o20 eye_height', near(o[20], st.eyeHeight)],
    ['o21 on_ground', near(o[21], b1(st.onGround))],
  ];
  for (const [name, pass] of checks) {
    if (!pass) fail('F: state_out 槽校验失败 ' + name);
  }
  // 种子面预填一致性：set_state_ex 后 state_out 即刻与状态一致（首个 tick_into 前）
  const w2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  w2.set_state_ex(a.state_full_json(false));
  const o2 = new Float64Array(mem.buffer, w2.state_out_ptr(), 22);
  if (!near(o2[9], full.duck_frac) || !near(o2[21], b1(full.on_ground))) {
    fail('F: 种子面预填 state_out 与状态不一致');
  }
  ok('F: state_out 22 槽语义逐槽通过（tick_into 追加 + 种子面预填）');
}

// ---------------------------------------------------------------------------
// G. set_state_ex 防御（FAIL LOUD）
// ---------------------------------------------------------------------------
{
  const w = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  const throwOk = (fn, label) => {
    try { fn(); fail('G: ' + label + ' 未拒绝'); } catch { /* 预期抛错 */ }
  };
  throwOk(() => w.set_state_ex('{bad json'), '坏 JSON');
  throwOk(() => w.set_state_ex(JSON.stringify({ v: 1, origin: [0, 72, 0] })), 'schema v=1');
  throwOk(() => {
    const bad = JSON.parse(newWorld(floorBrush, emptyTele, 0, 72, 0, 0).state_full_json(false));
    bad.triggers_inside = [true, false]; // 世界无 trigger → 长度错
    w.set_state_ex(JSON.stringify(bad));
  }, 'triggers_inside 错长');
  throwOk(() => w.set_state_ex(JSON.stringify({ v: 2, origin: [0, 'NaN-not-number', 0] })), '非数 origin');
  ok('G: set_state_ex 防御 4/4 FAIL LOUD（坏 JSON / v 错 / 错长 / 非数）');
}

console.log('\n=== 种子面 v2 回归全部通过（' + passCount + ' 组） ===');
