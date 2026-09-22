/**
 * Rust 物理冒烟测试（node 环境直接跑 WASM，无需浏览器）。
 *
 * 九段检查，逐段打印 OK 或 FAIL：任一段 FAIL 即 `process.exit(1)`，全过时末行是
 * `=== 物理冒烟测试全部通过 ===`。
 *   1 自由落体首个 tick 的竖直速度增量
 *   2 200 tick 内落地
 *   3 跳跃（键位掩码 0x10）后竖直速度为正
 *   4 跳跃顶点后 80 tick 内回落落地
 *   5 `predict` 能推进状态
 *   6 权威基线 `set_state` 后接 2 个子步 `predict`，应起跳
 *   7 同一基线再重置一次，单子步位移应锚定在该基线附近
 *   8 `eyeHeight`：站立时取共享单点常量、蹲下后降低
 *   9 `teleport_to_spawn` 与 trigger 传送（落地后触发）
 *
 * 第 7、8 段的期望值都不是本文件里的独立口径：`EYE_STAND` 用正则从
 * `src/ts-shared/phys/constants.ts` 的导出行现读（该导出行写法是本脚本依赖的接口，
 * 同一常量另有 `src/scripts/check-shared-sync.mjs` 的 `eye-stand` 子检查在两侧比对）；
 * 起跳初速的期望值写成 `302 / 64`，其中 302 取自 `sqrt(2 × 800 × 57)`，
 * 即 `src/phys/player.rs` 的 `GRAVITY` 与 `JUMP_HEIGHT` 推出的初速。
 *
 * 前置：`apps/game/pkg/websurf_wasm_bg.wasm` 已由 `npm run build:wasm` 产出
 * （`apps/game/package.json` 的 `build:wasm`；同文件的 `test:phys` 即本命令）。
 * 用法：在 `apps/game` 下执行 `node scripts/phys-smoke.mjs`。
 * 无产物落盘。
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

// 地板世界：两个平面分别给 y >= 0（[0,-1,0] dist 0）与 y <= 0（[0,1,0] dist 0），
// 侧面把实体限制在 ±1000 内 —— 实体是 y = 0 处的一张零厚板，玩家在其上方自由落体。
// 注意：不要把玩家放进 brush 内部 —— player_tick 的 check_stuck 会先做挤出探测
// （10 个方向 × 6 档距离），候选点全被占时该 tick 跳过全部移动并清零速度。
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
// 空 tri、空传送；出生点 (0, 100, 0)、yaw 0
w.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 100, 0, 0);

// 1. 自由落体直到落地：首个 tick 的竖直速度增量应等于 gravity × dt
let s = w.tick(1 / 64, 0, 0, 0);
const expectV0 = -800 / 64; // air_move 半重力×2 = 全重力每 tick
if (Math.abs(s.velY - expectV0) > 1) {
  console.error('FAIL: 重力注入异常 velY=' + s.velY.toFixed(2) + ' 预期≈' + expectV0.toFixed(2));
  process.exit(1);
}
console.log('OK t0: velY=' + s.velY.toFixed(2) + '（重力 ' + expectV0.toFixed(2) + '/tick）');

// 1. 自由落体直到落地：首个 tick 的竖直速度增量应等于 gravity × dt；
//    落地时 origin 停在距地面 DIST_EPSILON 处（src/phys/world.rs 的 DIST_EPSILON）
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

// 2. 落地后跳跃（键位掩码 0x10）：初速由 jump_height 反推，竖直分量应为正
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

// 4. predict 模式：走一次 player_tick，不经 step_core —— 不检测传送、不判死亡、
//    不处理 reset 键，也不改动本实例之外的任何东西
const p = new PhysWorld();
p.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 100, 0, 0);
const ps = p.predict(1 / 64, 0, 0, 0);
if (ps.posY >= 100) {
  console.error('FAIL: predict 未推进');
  process.exit(1);
}
console.log('OK predict: y=' + ps.posY.toFixed(2) + ' velY=' + ps.velY.toFixed(2));

// 5. 权威基线 → 预测子步：set_state 把实例按 9 个标量拉回权威状态（含 prev_origin 同步），
//    随后每调一次 predict 就是一个子步。模拟权威落地在 (0,72,0)、velY=0、onGround=true，
//    再接 2 个子步（跳跃位 0x10）应起跳
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

// 6. 基线重置：再把实例拉回 (0,72,0)，单子步 predict 的位移应是从该基线起跳的**局部**位移
//    （≈ 起跳初速 × dt），而不是从别处跳变 —— 即预测锚定权威基线、不累积漂移
b.set_state(0, 72, 0, 0, 0, 0, 0, 0, true);
const b3 = b.predict(1 / 64, 0x10, 0, 0); // 单子步
const expectStep = 302 / 64; // 起跳初速 sqrt(2×800×57) ≈ 302 HU/s 乘以步长
const dy = b3.posY - 72;
if (Math.abs(dy - expectStep) > 1.5) {
  console.error('FAIL: set_state 基线未锚定 dy=' + dy.toFixed(2) + ' 预期≈' + expectStep.toFixed(2));
  process.exit(1);
}
console.log('OK 基线锚定: 单子步位移 dy=' + dy.toFixed(2) + '（预期≈' + expectStep.toFixed(2) + '，无漂移）');

// 7. eyeHeight：站立时应等于共享单点 EYE_STAND，蹲下后降低。
//    常量不写字面量：本脚本由 node 直接执行（未 bundle），无法 import .ts，故按正则解析
//    src/ts-shared/phys/constants.ts 的导出行；解析不到即判 FAIL，不退回旧值。
const EYE_STAND_SRC = join(__dirname, '..', '..', '..', 'src', 'ts-shared', 'phys', 'constants.ts');
const EYE_STAND = (() => {
  const m = /export const EYE_STAND = ([\d.]+);/.exec(readFileSync(EYE_STAND_SRC, 'utf8'));
  if (!m) {
    console.error(
      'FAIL: 无法从共享单点 src/ts-shared/phys/constants.ts 解析 EYE_STAND（D-16 单源假定被破坏）',
    );
    process.exit(1);
  }
  return Number(m[1]);
})();
const e = new PhysWorld();
e.build_world(brushJson, '[]', '{"teleports":[],"triggers":[]}', 0, 72, 0, 0);
const eStand = e.tick(1 / 64, 0, 0, 0); // 站立
if (Math.abs(eStand.eyeHeight - EYE_STAND) > 0.5) {
  console.error('FAIL: 站立 eyeHeight=' + eStand.eyeHeight.toFixed(2) + ' 预期≈' + EYE_STAND);
  process.exit(1);
}
const eDuck = e.tick(1 / 64, 0x20, 0, 0); // duck 位 0x20
if (eDuck.eyeHeight >= eStand.eyeHeight) {
  console.error('FAIL: 蹲下 eyeHeight 未降低=' + eDuck.eyeHeight.toFixed(2));
  process.exit(1);
}
console.log('OK eyeHeight: 站立=' + eStand.eyeHeight.toFixed(2) + ' → 蹲下=' + eDuck.eyeHeight.toFixed(2));

// 8. teleport_to_spawn：用 set_spawn_points 写 2 个出生点（[x,y,z,yaw]），传送到索引 1；
//    越界索引会被静默忽略，故这里用合法索引；本方法不改 spawn（respawn 仍回 build_world 的出生点）
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

// 9. 触发传送：spawn 高空 (0,60,0) → 下落 → 落在 trigger 区域
//    （x∈[-10,10], z∈[-10,10], y∈[0,4]）→ 站定后应传送到 destination (50,0,30)
//    启用条件只有接触计数（`contact_ticks > 0`）：A 路径的身体线段本来就够到 trigger，
//    而 B 路径与斜面 gap 需要该计数；`set_params` 的 `teleport_gate_ticks` 键当前不改变行为
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
// 门槛 9：拦住在接触计数出现之前就触发传送的情形
if (teleportedAt < 9) {
  console.error('FAIL: 传送触发过早 tick=' + teleportedAt + '（落地门槛未生效？）');
  process.exit(1);
}
console.log('OK 触发传送: tick' + teleportedAt + ' → (' + tgPos.posX.toFixed(0) + ',' + tgPos.posY.toFixed(0) + ',' + tgPos.posZ.toFixed(0) + ')（落地站定后触发）');

console.log('\n=== 物理冒烟测试全部通过 ===');
