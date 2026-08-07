/**
 * 传送 gate 回归测试：斜面滑行（surfing）不算落地 → 滑行中不触发传送，
 * 只有真正落地（可站面 normal.y >= 0.7）后才检测传送。
 *
 * 背景 bug：contact_ticks 曾把斜面滑行也算"接触"→ 滑行中传送 gate 通过，
 * 坡底 trigger_teleport 被多点下探（0~48 units）命中 → 人还在坡上滑就被传送回家。
 * 修复：contact_ticks 仅真正落地累加（与 on_ground 同步），滑行中恒 0。
 *
 * 场景 1（surfing 语义）：玩家在 60° 坡面上方贴坡悬空、沿坡速度滑行，
 *   contactTicks 必须恒 0（旧代码会把 surfing 计入接触 → 1+），且不触发传送。
 * 场景 2（落地触发）：玩家在坡底 trigger 上方悬空下落 → 落地后 contactTicks
 *   累加 → gate 通过 → 探测命中坡底 trigger → 传送。
 *
 * 用法：node scripts/phys-teleport-gate.mjs（需先 npm run build:wasm）
 */
import { initSync, PhysWorld } from '../pkg/websurf_wasm.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, '..', 'pkg', 'websurf_wasm_bg.wasm'));
initSync({ module: wasmBytes });

const TICK = 1 / 64;

// ---- 世界：60° 斜坡 + 地面 ----
// 坡面（顶面）平面：0.866x + 0.5y = 86.6 → y = 173.2 - 1.732x（x=-100→y=346.4, x=100→y=0）
// 坡面法线 y=0.5 ∈ (0.05, 0.7) → 属 surf 范围（不可站，滑行置 surfing）
// 楔形斜面 brush（60°，x∈[-100,100]，坡面 y 从 346.4 降到 0）：
// 内部 = 坡面下方 且 y>=0 且 x∈[-100,100] 且 z∈[-100,100]
const ramp = {
  planes: [
    { normal: [0.866, 0.5, 0], dist: 86.6 }, // 坡面顶面（法线朝外朝上偏 x）
    { normal: [0, -1, 0], dist: 0 },          // 底面 y>=0（法线朝下）
    { normal: [-1, 0, 0], dist: 100 },        // 小端 x>=-100（法线朝 -x）
    { normal: [1, 0, 0], dist: 100 },         // 大端 x<=100（法线朝 +x）
    { normal: [0, 0, -1], dist: 100 },        // z>=-100
    { normal: [0, 0, 1], dist: 100 },         // z<=100
  ],
  min: [-100, 0, -100], max: [100, 346.4, 100],
  is_ladder: false, is_solid: true,
};
// 有限厚地面（y∈[-100,0]，法线朝外）：真实 BSP brush 是有限厚，Minkowski 膨胀
// 后玩家 origin 在地面上方为外部 → 正常落地碰撞。无限厚地面（planes 底面 dist 大）
// 会让膨胀 brush 覆盖玩家所有高度 → start_solid 卡死（测试构造错误）。
const ground = {
  planes: [
    { normal: [0, 1, 0], dist: 0 },     // 顶面 y<=0（内部在下方）
    { normal: [0, -1, 0], dist: 100 },  // 底面 y>=-100（内部在上方）
    { normal: [1, 0, 0], dist: 1000 },
    { normal: [-1, 0, 0], dist: 1000 },
    { normal: [0, 0, 1], dist: 1000 },
    { normal: [0, 0, -1], dist: 1000 },
  ],
  min: [-1000, -100, -1000], max: [1000, 0, 1000],
  is_ladder: false, is_solid: true,
};
const brushJson = JSON.stringify([ground, ramp]);

// ---- 坡底 trigger_teleport → 目的地 (50, 0, 30) ----
const teleportJson = JSON.stringify({
  teleports: [{ index: 0, targetname: 'tp_dest', origin: [50, 0, 30], angles: [0, 90, 0] }],
  triggers: [{
    index: 0, classname: 'trigger_teleport', target: 'tp_dest', origin: [100, 0, 0],
    model_mins: [95, 0, -10], model_maxs: [115, 4, 10], spawnflags: 1,
  }],
});

function isTeleported(s) {
  return Math.abs(s.posX - 50) < 1 && Math.abs(s.posZ - 30) < 1;
}

// ============================================================
// 场景 1：贴坡滑行（surfing）→ contactTicks 恒 0，不触发传送
// ============================================================
{
  const rampY = 173.2 - 1.732 * (-80); // 311.8（坡面中部 x=-80）
  const w = new PhysWorld();
  w.build_world(brushJson, '[]', teleportJson, -80, rampY + 36.5, 0, 0);
  // 贴坡悬空 0.5 units + 沿坡速度（方向 (0.866, -0.5) × 500）
  // vy 必须足够负（-1.732×vx）才不被 vx 甩离坡面：浅 vy 会悬空飞离 → 永不撞坡
  // → surfing 不置位 → 旧代码也无法累加（测试无效）。平行坡面速度会逐渐穿入
  // 坡面（碰撞信号 → surfing=true），此时新旧代码行为才分叉。
  w.set_state(-80, rampY + 36.5, 0, 0, 0, 433, -750, 0, false);
  let maxContact = 0;
  let teleported = false;
  for (let i = 0; i < 10; i++) {
    const s = w.tick(TICK, 0, 0, 0);
    maxContact = Math.max(maxContact, s.contactTicks);
    if (isTeleported(s)) teleported = true;
  }
  if (maxContact !== 0) {
    console.error(`FAIL[场景1] 贴坡滑行 contactTicks=${maxContact}（应为 0——surfing 不算落地）`);
    process.exit(1);
  }
  if (teleported) {
    console.error('FAIL[场景1] 贴坡滑行中触发了传送（gate 应不通过）');
    process.exit(1);
  }
  console.log(`OK 场景1: 贴坡滑行 contactTicks 恒 0，未传送（surfing 不算落地）`);
}

// ============================================================
// 场景 2：落地才触发传送（纯地面世界，无斜面干扰）
// ============================================================
{
  // 只含地面 + 坡底 trigger；玩家在 trigger 上方悬空下落
  const w = new PhysWorld();
  w.build_world(JSON.stringify([ground]), '[]', teleportJson, 110, 36.5, 0, 0);
  // 玩家 (x=110) 在 trigger AABB [95,115]×[0,4] 正上方悬空 36.5，静止下落；
  // 探测点 36 → y=0 ∈ trigger，但落地前 gate 不通过（contactTicks=0）
  w.set_state(110, 36.5, 0, 0, 0, 0, 0, 0, false);
  let teleportedAt = -1;
  let firstContactTick = -1;
  for (let i = 0; i < 120; i++) {
    const s = w.tick(TICK, 0, 0, 0);
    if (firstContactTick < 0 && s.contactTicks > 0) firstContactTick = i;
    if (teleportedAt < 0 && isTeleported(s)) teleportedAt = i;
  }
  if (teleportedAt < 0) {
    console.error('FAIL[场景2] 落地后未触发坡底传送（trigger 未生效？）');
    process.exit(1);
  }
  if (firstContactTick < 0) {
    console.error('FAIL[场景2] 始终未进入落地状态');
    process.exit(1);
  }
  if (teleportedAt < firstContactTick) {
    console.error(`FAIL[场景2] 落地前(tick${teleportedAt} < contact tick${firstContactTick})就传送`);
    process.exit(1);
  }
  console.log(`OK 场景2: 悬空不传送 → tick${firstContactTick} 落地(contactTicks>0) → tick${teleportedAt} 触发传送`);
}

console.log('\n=== 传送 gate 回归测试通过 ===');
