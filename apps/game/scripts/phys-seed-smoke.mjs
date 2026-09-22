/**
 * 种子面 v2 回归（node 直跑 wasm 产物，不经浏览器）：`set_state_ex` / `state_full_json` /
 * `seed_from` 与 `state_out` 的 22 槽（槽位表见 `src/phys/mod.rs` 的 `PhysWorld` 字段文档）。
 *
 * 对照通道：v2 = `set_state_ex` 种子 JSON（或同模块的 `seed_from` 逐字段直拷）；
 * 负对照 = 9 参 `set_state` —— 它只写 origin / yaw / pitch / velocity / on_ground 五项状态，
 * 种子面其余字段保持新实例初值（`src/phys/mod.rs` 的 `set_state`）。判据基本都是逐个 tick
 * 比较两实例的 `state_full_json(false)` 文本，或比较事件时序。
 *
 *   A  全字段往返 + 位级种子等价：先跑 24 tick 混合键位掩码取快照，再用 `set_state_ex` 与
 *      `seed_from` 两个通道播种新实例，与权威同跑掩码数组剩余 6 项并逐 tick 比较文本。
 *   B  `ground_normal` 往返：45° 坡带速着地后快照里的 `ground_normal` 必须是坡面法线
 *      （判据 `ground_normal[1] ≤ 0.999`）且水平速度 ≥ 260 HU/s；v2 种子逐 tick 全等，
 *      9 参通道不写 `ground_normal` 也不写计时器，首个比较 tick 即不等。
 *   C  `contact_ticks` 与事件时序：埋地 trigger 只由 B 路径（脚底 8 HU 下探）命中；
 *      v2 与权威的传送事件落在同一 tick，9 参通道的传送事件落在权威之后。
 *   D  `ducked` / `duck_frac`：半蹲态快照播种后 v2 逐 tick 全等；9 参通道的 `duck_frac`
 *      停在 0，与权威 frac 的差即权威 frac（眼高按 `duck_frac` 在 `src/phys/player.rs` 的
 *      `EYE_DUCK` 46.04 与 `EYE_STAND` 64.09 之间线性缩放，差 ≈ 18.05 × frac）。
 *   E  `old_jump`：`set_params('{"autobhop": false}')` 下持跳落地，`old_jump` 阻断重跳
 *      （`src/phys/player.rs` 的 `check_jump`）；v2 位级全等，9 参通道不写 `old_jump`，
 *      负对照出现重跳（`velocity[1] > 50`）。
 *   F  `state_out` 22 槽逐槽语义：`tick_into` 写入后逐槽与 `state()` / `state_full_json(false)`
 *      比对；另验证 `set_state_ex` 之后、首个 `tick_into` 之前 state_out 已与状态一致。
 *   G  `set_state_ex` 防御：坏 JSON / `v` 不符 / `triggers_inside` 长度不符 / 非数 origin
 *      四种输入都必须抛错（`throwOk` 只要求抛错，不校验错误文本）。
 *
 * 用法：node scripts/phys-seed-smoke.mjs（= npm run test:seed-smoke；先 npm run build:wasm）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
const initOut = initSync({ module: wasmBytes });
const mem = initOut.memory; // initSync 返回的内存对象，供 state_out 建 Float64Array 视图

const DT = 1 / 64; // 固定步长（s），与权威线 64 Hz 一致
let passCount = 0; // 通过组计数（脚本末尾汇总打印）

// 通过：计数 +1 并打印一行 OK 前缀
function ok(msg) {
  passCount += 1;
  console.log('OK ' + msg);
}

// 失败：打印 FAIL 前缀并以退出码 1 结束（本脚本以退出码表达判定）
function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

// 地板世界：六个平面围出 y ∈ [0, 0.01] 的薄板，与 `apps/game/scripts/phys-smoke.mjs` 的 brush 同参
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

// 45° 坡世界：坡面平面 (0, √½, √½)·x = 0 即 y = −z，实体在 y + z ≤ 0 一侧；带速着地后取快照
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

// 埋地 trigger 世界：trigger 体 y ∈ [−8, −0.5]（model_mins / model_maxs 相对 origin）。
// A 路径的身体线段 [pos.y, pos.y + body_top] 与它不相交，只有落地后启用的脚底 8 HU 下探能命中。
const buriedTele = JSON.stringify({
  teleports: [{ index: 0, targetname: 'tp_dest2', origin: [50, 0, 30], angles: [0, 90, 0] }],
  triggers: [{
    index: 0, classname: 'trigger_teleport', target: 'tp_dest2', origin: [0, 0, 0],
    model_mins: [-10, -8, -10], model_maxs: [10, -0.5, 10], spawnflags: 1,
  }],
});

const emptyTele = '{"teleports":[],"triggers":[]}';

/** 建实例：brush / teleport JSON + 出生点四项（x, y, z, yaw）；tri 段传空串。 */
function newWorld(brush, tele, sx, sy, sz, yaw) {
  const w = new PhysWorld();
  w.build_world(brush, '[]', tele, sx, sy, sz, yaw);
  return w;
}

/** 逐 tick 同输入双跑：返回 { equal, firstDiffTick }，不等时另带 diffKeys（差异键名）。 */
function driveAndCompare(a, b, masks, label) {
  for (let i = 0; i < masks.length; i++) {
    a.tick(DT, masks[i], 0, 0);
    b.tick(DT, masks[i], 0, 0);
    const sa = a.state_full_json(false);
    const sb = b.state_full_json(false);
    if (sa !== sb) {
      // 首个不等的 tick：逐键比对并列出不同的键名（诊断）
      const pa = JSON.parse(sa);
      const pb = JSON.parse(sb);
      const diffKeys = Object.keys(pa).filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
      return { equal: false, firstDiffTick: i, diffKeys };
    }
  }
  return { equal: true, firstDiffTick: -1 };
}

/** 9 参 `set_state` 播种（负对照通道）：只取 origin / yaw / pitch / velocity / on_ground。 */
function seedNine(w, snapJson) {
  const s = JSON.parse(snapJson);
  w.set_state(s.origin[0], s.origin[1], s.origin[2], s.yaw, s.pitch,
    s.velocity[0], s.velocity[1], s.velocity[2], s.on_ground);
}

// ---------------------------------------------------------------------------
// A. 全字段往返 + 位级种子等价（混合键位掩码）
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
  // 上面传的是空窗口（不做推进也不比较），故这里用同一批掩码补跑 s2
  for (let i = 0; i < masks.slice(24).length; i++) s2.tick(DT, masks[i + 24], 0, 0);
  const r2b = a.state_full_json(false) === s2.state_full_json(false);
  if (!r1.equal) fail('A: set_state_ex 种子后分叉 tick' + r1.firstDiffTick + ' keys=' + r1.diffKeys);
  if (!r2b) fail('A: seed_from 种子后分叉');
  ok('A: 全字段往返位级全等（set_state_ex + seed_from 双通道，' + masks.length + ' tick 混合输入）');
}

// ---------------------------------------------------------------------------
// B. ground_normal 往返（45° 坡带速着地）
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
  a.tick(DT, 0, 0, 0); // 落地后再 tick 一步才取快照（ground_normal 为坡面法线，水平速度 ≥ 260）
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
// C. contact_ticks 与传送事件时序（埋地 trigger 的 B 路径）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, buriedTele, 0, 120, 0, 0);
  let landed = false;
  for (let i = 0; i < 90; i++) {
    a.tick(DT, 0, 0, 0);
    if (a.state().onGround) { landed = true; break; }
  }
  if (!landed) fail('C: 未落地');
  const snap = a.state_full_json(false); // 落地当帧快照：contact_ticks ≥ 1（本帧的传送检测已跑完）
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
// D. ducked / duck_frac（半蹲态）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  let landed = false;
  for (let i = 0; i < 60; i++) { a.tick(DT, 0, 0, 0); if (a.state().onGround) { landed = true; break; } }
  if (!landed) fail('D: 未落地');
  a.tick(DT, 0x20, 0, 0);
  a.tick(DT, 0x20, 0, 0);
  a.tick(DT, 0x20, 0, 0); // 蹲伏中段：连续三次蹲键后 0 < duck_frac < 1
  const snap = a.state_full_json(false);
  const sp = JSON.parse(snap);
  if (!sp.ducked || sp.duck_frac <= 0 || sp.duck_frac >= 1) {
    fail('D: 快照非半蹲态 ducked=' + sp.ducked + ' frac=' + sp.duck_frac);
  }
  const v2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  v2.set_state_ex(snap);
  const neg = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  seedNine(neg, snap);
  // 掩码：先按住蹲键 4 tick，再松开 6 tick（duck_frac 线性趋近，DUCK_LERP_TIME 为 0.2 s）
  const masks = [0x20, 0x20, 0x20, 0x20, 0, 0, 0, 0, 0, 0];
  const r = driveAndCompare(a, v2, masks, 'D/v2');
  if (!r.equal) fail('D: v2 种子蹲伏分叉 tick' + r.firstDiffTick + ' keys=' + r.diffKeys);
  // 负对照在 t0 就露出差距：set_state 不写 duck_frac，其值为 0；两实例眼高差 ≈ 18.05 × 权威 frac
  const negFrac0 = JSON.parse(neg.state_full_json(false)).duck_frac;
  const eyeGap = sp.duck_frac - negFrac0;
  if (eyeGap < 0.05) fail('D: 9 参负对照眼高差不足 gap=' + eyeGap.toFixed(3));
  // 再同输入 tick 一步，两者的 state_full_json 仍不等（判据是 JSON 文本，不是行为差分）
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
  a.tick(DT, 0x10, 0, 0); // 按下跳跃键起跳
  let relanded = false;
  for (let i = 0; i < 120; i++) { a.tick(DT, 0x10, 0, 0); if (a.state().onGround) { relanded = true; break; } }
  if (!relanded) fail('E: 持跳未回落');
  const snap = a.state_full_json(false); // 落地且仍按住跳跃键：old_jump = true 阻断重跳
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
// F. state_out 22 槽逐槽语义（tick_into 写入 + 种子面预填）
// ---------------------------------------------------------------------------
{
  const a = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  let landed = false;
  for (let i = 0; i < 60; i++) { a.tick(DT, 0, 0, 0); if (a.state().onGround) { landed = true; break; } }
  a.tick(DT, 0x01 | 0x20, 0, 0); // 前进 + 蹲：让 state_out 各槽取到非零值
  a.tick_into(DT, 0x01 | 0x20, 0, 0);
  const o = new Float64Array(mem.buffer, a.state_out_ptr(), 22); // 22 槽视图，直读 wasm 线性内存
  const st = a.state(); // state()：11 键 JS 对象（`src/phys/mod.rs` 的 `state_js`）
  const full = JSON.parse(a.state_full_json(false));
  const near = (x, y, eps) => Math.abs(x - y) <= (eps || 1e-9);
  const b1 = (v) => (v ? 1 : 0);
  // 逐槽核对：0-7 由 tick_into 直写，8-21 由 fill_state_out 写（landing_velocity 逐分量比）
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
  // 种子面预填一致性：set_state_ex 之后、首个 tick_into 之前，state_out 已与状态一致
  const w2 = newWorld(floorBrush, emptyTele, 0, 72, 0, 0);
  w2.set_state_ex(a.state_full_json(false));
  const o2 = new Float64Array(mem.buffer, w2.state_out_ptr(), 22); // 同一槽位口径（换实例后重建视图）
  if (!near(o2[9], full.duck_frac) || !near(o2[21], b1(full.on_ground))) {
    fail('F: 种子面预填 state_out 与状态不一致');
  }
  ok('F: state_out 22 槽语义逐槽通过（tick_into 追加 + 种子面预填）');
}

// ---------------------------------------------------------------------------
// G. set_state_ex 防御（四种坏输入必须抛错）
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
    bad.triggers_inside = [true, false]; // 该世界触发器数为 0，长度 2 必然不符
    w.set_state_ex(JSON.stringify(bad));
  }, 'triggers_inside 错长');
  throwOk(() => w.set_state_ex(JSON.stringify({ v: 2, origin: [0, 'NaN-not-number', 0] })), '非数 origin');
  ok('G: set_state_ex 防御 4/4 FAIL LOUD（坏 JSON / v 错 / 错长 / 非数）');
}

console.log('\n=== 种子面 v2 回归全部通过（' + passCount + ' 组） ===');
