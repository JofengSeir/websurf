/**
 * Rust 物理冒烟测试（node 环境直接跑 WASM，无需浏览器）。
 *
 * 验证：自由落体 → 落地 → 跳跃 → 回落 → predict 模式。
 * 用法：node scripts/phys-smoke.mjs（需先 npm run build:wasm）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

// 地板世界：地面在 y=0（法线朝下 → 内部 y>=0），玩家在其上方自由落体
// 注意：不要把玩家包进 brush 内部（会触发 check_stuck 卡死——真实地图 spawn 在 brush 外）
const brushJson = JSON.stringify([
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

const w = new PhysWorld();
w.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 100, 0, 0);

// 1. 自由落体直到落地（重力 800；落地时 origin.y ≈ 碰撞箱底 0 + 站高 72 内缩）
let s = w.tick(1 / 64, 0, 0, 0);
const expectV0 = -800 / 64; // air_move 半重力×2 = 全重力每 tick
if (Math.abs(s.velY - expectV0) > 1) {
  console.error('FAIL: 重力注入异常 velY=' + s.velY.toFixed(2) + ' 预期≈' + expectV0.toFixed(2));
  process.exit(1);
}
console.log('OK t0: velY=' + s.velY.toFixed(2) + '（重力 ' + expectV0.toFixed(2) + '/tick）');

let landTick = -1;
for (let i = 1; i < 200; i++) {
  s = w.tick(1 / 64, 0, 0, 0);
  if (s.onGround) {
    landTick = i;
    break;
  }
}
if (landTick < 0) {
  console.error('FAIL: 200 tick 内未落地');
  process.exit(1);
}
console.log('OK 落地 at tick' + landTick + ': y=' + s.posY.toFixed(2) + ' ground=' + s.onGround);

// 2. 落地后跳跃
s = w.tick(1 / 64, 0x10, 0, 0);
if (s.velY <= 0) {
  console.error('FAIL: 跳跃后 velY=' + s.velY.toFixed(2) + ' 应为正');
  process.exit(1);
}
console.log('OK 跳跃: velY=' + s.velY.toFixed(2) + '（预期 ≈' + Math.sqrt(2 * 800 * 57).toFixed(0) + '）');

// 3. 跳跃顶点后回落再落地
let landed2 = false;
for (let i = 0; i < 80; i++) {
  s = w.tick(1 / 64, 0, 0, 0);
  if (s.onGround) {
    landed2 = true;
    break;
  }
}
if (!landed2) {
  console.error('FAIL: 跳跃后未回落落地');
  process.exit(1);
}
console.log('OK 回落落地: y=' + s.posY.toFixed(2) + ' ground=' + s.onGround);

// 4. predict 模式（Worker-B 语义，无副作用）
const p = new PhysWorld();
p.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 100, 0, 0);
const ps = p.predict(1 / 64, 0, 0, 0);
if (ps.posY >= 100) {
  console.error('FAIL: predict 未推进');
  process.exit(1);
}
console.log('OK predict: y=' + ps.posY.toFixed(2) + ' velY=' + ps.velY.toFixed(2));

// 5. Worker-B 基线同步全流程（时序图 §3.4）：set_state 权威基线 → 2 子步预测
//    模拟：权威落地在 (0,72,0) velY=0 onGround=true → 预测 2 子步（跳跃位 0x10）
const b = new PhysWorld();
b.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 100, 0, 0);
b.set_state(0, 72, 0, 0, 0, 0, 0, 0, true); // 权威基线：站在地面
let b1 = b.predict(1 / 64, 0x10, 0, 0); // 子步 1：跳跃意图
let b2 = b.predict(1 / 64, 0x10, 0, 0); // 子步 2
if (b2.velY <= 0 || b2.posY <= 72) {
  console.error('FAIL: 基线预测未起跳 velY=' + b2.velY.toFixed(2) + ' y=' + b2.posY.toFixed(2));
  process.exit(1);
}
console.log('OK 基线预测: y=' + b2.posY.toFixed(2) + ' velY=' + b2.velY.toFixed(2) + '（2 子步起跳）');

// 6. 基线重置验证：set_state 强制回到地面 (0,72,0) 后，单子步 predict 应给出
//    从该位置起跳的**局部**位移（≈ 起跳初速×dt，约 4-5 HU），而非从漂移远处跳变。
//    证明预测锚定权威基线、不累积漂移。
b.set_state(0, 72, 0, 0, 0, 0, 0, 0, true);
const b3 = b.predict(1 / 64, 0x10, 0, 0); // 单子步
const expectStep = 302 / 64; // ≈ 4.72 HU
const dy = b3.posY - 72;
if (Math.abs(dy - expectStep) > 1.5) {
  console.error('FAIL: set_state 基线未锚定 dy=' + dy.toFixed(2) + ' 预期≈' + expectStep.toFixed(2));
  process.exit(1);
}
console.log('OK 基线锚定: 单子步位移 dy=' + dy.toFixed(2) + '（预期≈' + expectStep.toFixed(2) + '，无漂移）');

// 7. eyeHeight（P0）：站立时应 ≈64.09（EYE_STAND），蹲下后降低
const e = new PhysWorld();
e.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 72, 0, 0);
const eStand = e.tick(1 / 64, 0, 0, 0); // 站立
if (Math.abs(eStand.eyeHeight - 64.09) > 0.5) {
  console.error('FAIL: 站立 eyeHeight=' + eStand.eyeHeight.toFixed(2) + ' 预期≈64.09');
  process.exit(1);
}
const eDuck = e.tick(1 / 64, 0x20, 0, 0); // duck 位 0x20
if (eDuck.eyeHeight >= eStand.eyeHeight) {
  console.error('FAIL: 蹲下 eyeHeight 未降低=' + eDuck.eyeHeight.toFixed(2));
  process.exit(1);
}
console.log('OK eyeHeight: 站立=' + eStand.eyeHeight.toFixed(2) + ' → 蹲下=' + eDuck.eyeHeight.toFixed(2));

// 8. teleport_to_spawn（P1）：设置 2 个出生点，传送到索引 1
const t = new PhysWorld();
t.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 72, 0, 0);
t.set_spawn_points(JSON.stringify([[0, 72, 0, 0], [50, 200, 30, 90]]));
t.teleport_to_spawn(1);
const t1 = t.state();
if (Math.abs(t1.posX - 50) > 0.01 || Math.abs(t1.posY - 200) > 0.01 || Math.abs(t1.posZ - 30) > 0.01) {
  console.error('FAIL: teleport_to_spawn(1) 未生效 pos=(' + t1.posX + ',' + t1.posY + ',' + t1.posZ + ')');
  process.exit(1);
}
console.log('OK teleport_to_spawn(1): pos=(' + t1.posX.toFixed(0) + ',' + t1.posY.toFixed(0) + ',' + t1.posZ.toFixed(0) + ') yaw=' + t1.yaw.toFixed(0));

// 9. 触发传送（落地稳定 ≥3 帧后判定位于传送平面）：
//    spawn 高空 (0,60,0) → 下落 → 落地在 trigger 区域（x∈[-10,10], z∈[-10,10], y∈[0,4]）
//    → 站定 3 帧后应传送到 destination (50,0,30)
const tg = new PhysWorld();
tg.build_world(brushJson, '[]', JSON.stringify({
  teleports: [{ index: 0, targetname: 'tp_dest', origin: [50, 0, 30], angles: [0, 90, 0] }],
  triggers: [{
    index: 0, classname: 'trigger_teleport', target: 'tp_dest', origin: [0, 0, 0],
    model_mins: [-10, 0, -10], model_maxs: [10, 4, 10], spawnflags: 1,
  }],
}), 0, 60, 0, 0);
let tgPos = null;
let teleportedAt = -1;
for (let i = 0; i < 60; i++) {
  tgPos = tg.tick(1 / 64, 0, 0, 0);
  if (Math.abs(tgPos.posX - 50) < 1 && Math.abs(tgPos.posZ - 30) < 1) {
    teleportedAt = i;
    break;
  }
}
if (teleportedAt < 0) {
  console.error('FAIL: 触发传送未生效 pos=(' + tgPos.posX.toFixed(1) + ',' + tgPos.posY.toFixed(1) + ',' + tgPos.posZ.toFixed(1) + ')');
  process.exit(1);
}
// 落地约 tick 5-8（y=60 自由落体），传送应在落地后 >3 tick 触发（严格化门槛）
if (teleportedAt < 9) {
  console.error('FAIL: 传送触发过早 tick=' + teleportedAt + '（落地门槛未生效？）');
  process.exit(1);
}
console.log('OK 触发传送: tick' + teleportedAt + ' → (' + tgPos.posX.toFixed(0) + ',' + tgPos.posY.toFixed(0) + ',' + tgPos.posZ.toFixed(0) + ')（落地站定后触发）');

console.log('\n=== 物理冒烟测试全部通过 ===');
