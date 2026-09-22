/**
 * 传送检测门槛回归（node 级，跑真实 wasm 产物）：两个场景各断言一组行为，任一断言不成立即
 * 打印 FAIL 行并以退出码 1 结束。
 *
 * 判定口径（`src/phys/teleport.rs` 的 `TeleportManager::check`）：
 * - 三道早退，顺序固定：`predict` 为真、冷却 `cooldown > 0`、`surfing` 为真 → 直接不检测。
 *   `surfing` 由 `src/phys/player.rs` 的 `try_player_move` 在命中面法线
 *   `0.05 < normal.y < 0.7` 时置位，故贴坡滑行期间传送整体不生效。
 * - `grounded` 取调用方传入的 `Player::contact_ticks > 0`：该计数只统计可站面
 *   （`normal.y >= STANDABLE_NORMAL`，0.7）接触，唯一重算点是
 *   `src/phys/player.rs` 的 `categorize_position`。它不是早退，只作后两条判定路径的启用条件。
 * - A 路径 `in_trigger_zone`：整条身体线段（origin 到 origin + `body_top`）与 trigger 凸包
 *   相交，落地与否只影响斜面 trigger 的 64 HU 贴面容差；B 路径 `probe_below_foot`：
 *   脚底往下 8 HU 的区间与 trigger 相交，要求 `grounded`。
 *
 * 场景 1（surfing 语义）：60° 坡 + 有限厚地面，玩家贴坡悬空、速度沿坡最陡下降方向；
 *   断言 10 个 tick 内 `contactTicks` 恒 0，且从未出现目的地坐标。
 * 场景 2（落地先后）：只放地面 + 坡底 trigger，玩家在 trigger 上方悬空下落；断言最终触发
 *   传送、接触计数出现过，且传送不早于首次接触。
 *
 * 用法：在 `apps/game` 下执行 `node scripts/phys-teleport-gate.mjs`（需先 `npm run build:wasm`，
 * 见 `apps/game/package.json`）。
 * 退出码：0 = 两个场景全部通过；1 = 任一断言失败。
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
// 坡面：0.866x + 0.5y <= 86.6，即表面 y = 173.2 - 1.732x（x = -100 处 y = 346.4，x = 100 处 y = 0）
// 面法线 (0.866, 0.5, 0) 的 y 分量是 0.5，落在 surf 区间 0.05 < normal.y < 0.7 内
// 楔形 brush：内部 = 坡面下方 且 y >= 0 且 x ∈ [-100, 100] 且 z ∈ [-100, 100]
const ramp = {
  planes: [
    { normal: [0.866, 0.5, 0], dist: 86.6 }, // 坡面：0.866x + 0.5y <= 86.6
    { normal: [0, -1, 0], dist: 0 },          // 底面：y >= 0
    { normal: [-1, 0, 0], dist: 100 },        // 小端：x >= -100
    { normal: [1, 0, 0], dist: 100 },         // 大端：x <= 100
    { normal: [0, 0, -1], dist: 100 },        // z >= -100
    { normal: [0, 0, 1], dist: 100 },         // z <= 100
  ],
  min: [-100, 0, -100], max: [100, 346.4, 100],
  is_ladder: false, is_solid: true,
};
// 有限厚地面：顶面 y <= 0、底面 y >= -100（厚 100 HU）。
// 玩家 origin 即脚底（`src/phys/player.rs` 的 `apply_hull` 把 `stand_mins[1]` 置 0），
// 箱体在 origin 上方 72 HU，故 origin 在地面之上时箱体与实体不相交 —— 这是落地碰撞的前提。
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
// trigger 只给 model_mins / model_maxs（无凸包平面），触发区按 AABB 回退判定
const teleportJson = JSON.stringify({
  teleports: [{ index: 0, targetname: 'tp_dest', origin: [50, 0, 30], angles: [0, 90, 0] }],
  triggers: [{
    index: 0, classname: 'trigger_teleport', target: 'tp_dest', origin: [100, 0, 0],
    model_mins: [95, 0, -10], model_maxs: [115, 4, 10], spawnflags: 1,
  }],
});

// 目的地 (50, 0, 30)：两轴各容差 1 HU 即认定已传送
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
  // 贴坡悬空：origin 距坡面的垂直距离是 36.5 × 0.5 = 18.25 HU（坡面法线 y 分量为 0.5，
  // 而 origin 即脚底）。速度取沿坡最陡下降方向 (433, -750, 0)：坡面 y = 173.2 - 1.732x 的
  // 下降方向 (1, -1.732) 归一化后是 (0.5, -0.866)，故 vy = -1.732 × vx 才贴着坡面走。
  // 浅 vy 会被 vx 甩离坡面而永不接触，surfing 不置位，本场景就测不到「滑行中不触发传送」。
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
  // 玩家 (x=110) 在 trigger AABB [95,115]×[0,4] 正上方悬空 36.5，静止下落：
  // A 路径要身体线段够到 y <= 4，B 路径要 grounded，两条在落地前都不成立
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
