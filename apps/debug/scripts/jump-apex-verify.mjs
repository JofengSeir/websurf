#!/usr/bin/env node
/**
 * 跳跃离群值判定实验：确定性 node 镜像，无浏览器、无 Worker、无真共享内存。
 *
 * 目的：把「跳跃高度不一致 / 偶尔跳得特别高」变成可复现、可对照的数字。同一份源码在同一台
 * 机器上跑出多列结果，差别只来自本脚本自己的两个开关。
 *
 * 架构镜像 —— 本脚本**自己重写**了两条接线，并自造确定性时钟与虚拟权威帧队列：
 *   · render = 一个 `PhysWorld` 实例，代替渲染线的 `predPhys`，每个模拟帧按墙钟式 `dt` 推进一次；
 *     与 `apps/debug/src/renderer/renderer-main.ts` 每帧「先 `correctFromAuthority`、再
 *     `calibrateVelocity`、最后 `tick`」同序；
 *   · auth = 另一个 `PhysWorld` 实例，代替 Worker 侧权威实例；每个帧间隙按固定 1/64 秒补足
 *     整数个 tick（`workerStep`），并把 tick 后的状态封成一条权威帧放进邮箱；
 *   · cal = **真实** `AuthorityCalibrator`（`src/ts-shared/phys/authority-calibrator.ts`），
 *     用一个手写 `deps` 桩构造。
 * `performance.now()` 被替换成脚本内的确定性时钟对象（`clock.t`，初值 1000，按帧步长自增），
 * 因此本脚本的结果与真实墙钟无关。
 *
 * 两条被对照的接线（`MATRIX` 的列即它们的组合）：
 *   ① 重锚载荷 `authority` —— `onSyncRenderState` 里选择往权威写什么：
 *        `full`    把渲染的九项（位置 / 角度 / 速度 / `onGround`）整份灌进权威；
 *        `posonly` 位置取渲染、角度与速度与 `onGround` 取权威现读值
 *                  （对应 `src/ts-shared/auth/worker-dispatch.ts` 的 `sync-render-state` 在
 *                  `sm.teleport === false` 时的常规重锚支路）。
 *   ② land 处理 `land` —— 权威 `phys-event{land}` 落到渲染线时走哪条路
 *      （生产侧调用点是 `apps/debug/src/app.ts` 的 `phys-event` 分支）：
 *        `legacy` 走本脚本**自带的一份内联复刻**：读渲染当前状态后整份重写，并把
 *                 `onGround` 置真。该复刻是脚本资产、不是当前源码的镜像，源码里没有这段代码，
 *                 故它只作对照面，不作为本仓行为事实；
 *        `prod`   调**当前源码**的真实方法 `applyCollisionCorrection`（它有一条门：渲染
 *                 自身 `onGround` 为假时零写入，连速度也不写）。
 *   `accel` 是第三个开关：为假时把 `cal.computeAuthAccel` 覆写成恒返回零向量，用于隔离
 *   「加速度外推」这一项对顶高的贡献。
 *
 * 冲量判定（两线各判一次，阈值相同）：权威侧看 `before.onGround` 为真且 tick 后
 *   `velY > 250`；渲染侧看 `set_velocity` 之后、`tick` 之前的 `onGround` 为真且 tick 后
 *   `velY > 250`。`src/phys/player.rs` 的 `check_jump` 把竖直分速度**赋值**为
 *   `sqrt(2 × gravity × jump_height)`（不是叠加），默认 800 / 57 下 ≈ 302 HU/s，故该判据
 *   等价于「本 tick 发生了一次起跳」。冲量施加点高度 h = tick 前 `posY` − `GROUND_Y`：
 *   h 超过 `MID_AIR_HU` 记一次腾空起跳。飞行段 = 起跳到渲染线重新着地之间的所有帧，
 *   顶高取段内 `posY` 的最大值（`apexH` 即顶高减去地面高度）。
 *
 * 世界与参数：平地 brush 顶面在 `GROUND_Y`，出生 y 为 8；`set_hull` 三围 16 / 72 / 54；
 *   `set_params` 给出 gravity 800、accelerate 10、friction 4、stop_speed 100、
 *   jump_height 57、air_accelerate 150、run_speed 250、autobhop 与 bhop_speed_clamp 均为真；
 *   传送表为空。两线各自先空跑 64 个 tick 稳定落地。
 *
 * 前置：两个 wasm 产物与一个打包产物必须已在工作区，否则 `existsSync` 存在性检查落 SKIP 分支
 *   （打印 `[SKIP]` 并退出码 0）：
 *   · 权威物理从下面 `PHYS_PKG` / `PHYS_WASM` 两个常量指向的那对产物引入，即**本工程自己的
 *     `apps/debug/pkg/`**（由 `apps/debug` 的 `build:wasm` 产出，与本工程 `crates/wasm` 同源，
 *     `PhysWorld` 由共享层 `src/phys` 提供）；
 *   · `AuthorityCalibrator` 从 `apps/debug/.tmp/jump-apex/authority-calibrator.bundle.mjs`
 *     引入，该文件由 `esbuild` 打包产出（`apps/debug` 的 `test:jump-apex` 脚本第一段就是它）。
 *   因此**直接跑 node 本脚本无法工作**，须经 `npm run test:jump-apex`（它会先打包再调用）。
 *
 * 输出：5 个修复组合 × 5 个渲染帧率（60 / 144 / 144±25% 抖动 / 165 / 240 Hz）共 25 格，
 *   每格模拟 20 秒、按住跳键；逐格打印飞行段数、顶高中位/最小/最大、顶高列表、超 70 HU 与
 *   低于 20 HU 的段数、单段多次冲量段数、两侧腾空起跳次数、两侧冲量次数、land 事件数
 *   （含「渲染在空」的条数）与两线最大竖直速度。本脚本不写文件，也不做阈值断言。
 *
 * 退出码：仅未捕获异常会以 1 结束（`process.exit(0)` 那条 SKIP 分支除外）。
 *
 * 用法：npm run test:jump-apex（先 esbuild 打包 calibrator，再 node 本脚本）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = join(HERE, '..');
// 权威物理的两个 wasm 产物：本工程自己的 pkg（`build:wasm` 的产出，与 crates/wasm 同源）
const PHYS_PKG = join(DEBUG_DIR, 'pkg', 'websurf_wasm.js');
const PHYS_WASM = join(DEBUG_DIR, 'pkg', 'websurf_wasm_bg.wasm');
// calibrator 的 esbuild 产物（由 apps/debug 的 test:jump-apex 脚本生成）
const CAL_BUNDLE = join(DEBUG_DIR, '.tmp', 'jump-apex', 'authority-calibrator.bundle.mjs');

// ── 确定性时钟：calibrator 内部与主线程模拟都读 performance.now()，这里整体换成脚本时钟 ──
const clock = { t: 1000, now() { return this.t; } };
Object.defineProperty(globalThis, 'performance', {
  value: clock, configurable: true, writable: true,
});

if (!existsSync(PHYS_PKG) || !existsSync(PHYS_WASM)) {
  console.log(`[SKIP] 物理 wasm 缺失（${PHYS_PKG}）——先在 apps/debug 执行 npm run build:wasm 再运行本门`);
  process.exit(0);
}
const { PhysWorld, initSync } = await import(new URL(`file://${PHYS_PKG}`).href);
initSync({ module: readFileSync(PHYS_WASM) });
const { AuthorityCalibrator } = await import(new URL(`file://${CAL_BUNDLE}`).href);

// ── 世界：一块手工 brush 的平地。六个平面围出 [−2048, 2048] × [−64, 0] × [−2048, 2048]，
//    顶面在 y=0（即 GROUND_Y），is_solid 为真、is_ladder 为假。
const BRUSHES = [
  {
    planes: [
      { normal: [0, 0, -1], dist: 2048 },
      { normal: [0, 0, 1], dist: 2048 },
      { normal: [-1, 0, 0], dist: 2048 },
      { normal: [1, 0, 0], dist: 2048 },
      { normal: [0, -1, 0], dist: 64 },
      { normal: [0, 1, 0], dist: 0 },
    ],
    min: [-2048, -64, -2048], max: [2048, 0, 2048], is_ladder: false, is_solid: true,
  },
];
const TELEPORT_JSON = '{"teleports":[],"triggers":[]}'; // 空传送表：本实验不需要传送
const PARAMS = JSON.stringify({
  gravity: 800, accelerate: 10, friction: 4, stop_speed: 100,
  jump_height: 57, air_accelerate: 150, run_speed: 250,
  autobhop: true, bhop_speed_clamp: true,
});
const KEY_JUMP = 0x10; // 跳键位，与 src/ts-shared/auth/shared-state.ts 的 KEY_MASK.jump 同值
const GROUND_Y = 0; // 平地顶面高度（HU）
const MID_AIR_HU = 2; // 冲量施加点高于地面这么多（HU）即记为「腾空起跳」

/** 造一条物理线：同一份 brush/参数/出生点，只换实例。出生点 x=0、z=0、yaw=0。 */
function makeWorld(spawnY) {
  const p = new PhysWorld();
  p.set_hull(16, 72, 54);
  p.build_world(JSON.stringify(BRUSHES), '[]', TELEPORT_JSON, 0, spawnY, 0, 0);
  p.set_params(PARAMS);
  return p;
}

/**
 * 单次实验。
 * @param opts.frameHz    渲染帧率（模拟的 rAF 频率）
 * @param opts.durationMs 模拟时长（ms）；帧数按 frameHz 折算后向下取整
 * @param opts.holdJump   为真则全程按住跳键位
 * @param opts.authority  'full' | 'posonly'  重锚载荷二选一（见文件头接线①）
 * @param opts.land       'legacy' | 'prod'   land 事件两支路二选一（见文件头接线②）
 * @param opts.accel      true|false          为假时覆盖 computeAuthAccel 为恒零
 * @param opts.jitter     帧长抖动比例（0 = 定长帧；每帧乘 1 + jitter×(2r−1)，r 为脚本内 LCG）
 * @returns flights：各飞行段（apex / apexH / impulses / maxImpulseH / startH）；
 *          stat：两线的冲量次数、腾空起跳次数、最大竖直速度与 land 事件计数。
 */
function run(opts) {
  const fixedDt = 1 / 64; // 权威固定步长（秒），对应 64Hz
  const LAT_MS = 2; // 权威帧的模拟发布延迟（ms）：tick 后要过这么久才「可被主线程读到」
  const render = makeWorld(8);
  const auth = makeWorld(8);

  // 预热：两线各自落地稳定
  for (let i = 0; i < 64; i++) render.tick(fixedDt, 0, 0, 0);
  for (let i = 0; i < 64; i++) auth.tick(fixedDt, 0, 0, 0);

  // ── 跨线程状态：键位槽、权威帧版本号、发布队列、事件队列 ──
  let sharedKeys = 0;
  let va = 0;
  let mailbox = [];
  let events = [];
  let prevAuthOnGround = auth.state().onGround;
  let workerSimMs = 0;

  // ── calibrator 装配：deps 是手写桩，接口见 src/ts-shared/phys/authority-calibrator.ts 的
  //    CalibratorDeps（readAuth / getPhys / clearPendingInput / onSyncRenderState）──
  let pendingDx = 0, pendingDy = 0, pendingKeys = 0;
  const deps = {
    readAuth() {
      let best = null;
      for (const m of mailbox) if (m.readableAt <= clock.t && (!best || m.va > best.va)) best = m;
      if (!best) return null;
      mailbox = mailbox.filter((m) => m.va >= best.va - 1);
      return { frame: best.frame, va: best.va };
    },
    getPhys() {
      return {
        state: () => render.state(),
        set_state: (...a) => render.set_state(...a),
        set_velocity: (...a) => render.set_velocity(...a),
      };
    },
    clearPendingInput() { pendingDx = 0; pendingDy = 0; },
    onSyncRenderState(s, teleport) {
      // 接线①：重锚载荷。'full' = 渲染九项整份灌进权威；'posonly' = 位置取渲染、
      // 角度/速度/onGround 取权威现读值（对照 src/ts-shared/auth/worker-dispatch.ts 的
      // sync-render-state 在 teleport 为 false 时的常规重锚支路）。teleport 入参本脚本不用。
      if (opts.authority === 'full') {
        auth.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
      } else {
        const cur = auth.state(); // 只播位置：其余字段保持权威自身值
        auth.set_state(s.posX, s.posY, s.posZ, cur.yaw, cur.pitch, cur.velX, cur.velY, cur.velZ, cur.onGround);
      }
      void teleport;
    },
  };
  const cal = new AuthorityCalibrator(deps);
  // 关加速度外推的档位：直接覆盖实例方法（JS 侧私有字段不构成访问屏障）。
  if (!opts.accel) cal.computeAuthAccel = () => ({ x: 0, y: 0, z: 0 });

  // ── 统计 ──
  const flights = [];
  let cur = null;
  const stat = {
    authImpulses: 0, authImpulsesMidAir: 0,
    renderImpulses: 0, renderImpulsesMidAir: 0,
    maxAuthVelY: -1e9, maxRenderSetVelY: -1e9, landWhileAirborne: 0, landEvents: 0,
  };

  const workerStep = (tickMs) => {
    const before = auth.state();
    auth.tick(fixedDt, sharedKeys, 0, 0);
    const after = auth.state();
    if (before.onGround && after.velY > 250) {
      stat.authImpulses++;
      if (before.posY - GROUND_Y > MID_AIR_HU) stat.authImpulsesMidAir++;
    }
    if (after.posY - GROUND_Y > 0 && after.velY > stat.maxAuthVelY) stat.maxAuthVelY = after.velY;
    // 发布权威帧：版本号自增；readableAt 之后主线程才读得到（见 LAT_MS）。
    va++;
    mailbox.push({
      readableAt: tickMs + LAT_MS, va,
      frame: {
        pos: { x: after.posX, y: after.posY, z: after.posZ },
        yaw: after.yaw, pitch: after.pitch,
        vel: { x: after.velX, y: after.velY, z: after.velZ },
        onGround: after.onGround, eyeHeight: after.eyeHeight, timeMs: tickMs,
      },
    });
    // 权威 land 边沿：判据是 onGround 的上升沿（与 src/ts-shared/auth/auth-loop.ts 的
    // stepPhysics 同口径），事件带 tick 后的位置、速度与角度。
    if (!prevAuthOnGround && after.onGround) {
      stat.landEvents++;
      events.push({
        at: tickMs + LAT_MS, kind: 'land',
        pos: [after.posX, after.posY, after.posZ],
        vel: [after.velX, after.velY, after.velZ],
        yawDeg: after.yaw, pitchDeg: after.pitch,
      });
    }
    prevAuthOnGround = after.onGround;
  };

  // ── 主循环：每帧先按 now 补足权威 tick，再处理到期事件，再按生产同序推进渲染线 ──
  const frameDt = 1 / opts.frameHz;
  const jitter = opts.jitter ?? 0;
  // 帧长抖动用的确定性 LCG（种子写死，故同一 opts 的结果可复现）
  let rndState = 12345;
  const rnd = () => { rndState = (rndState * 1103515245 + 12345) & 0x7fffffff; return rndState / 0x7fffffff; };
  let lastTickMs = 0;
  const totalFrames = Math.round((opts.durationMs / 1000) * opts.frameHz);

  for (let f = 0; f < totalFrames; f++) {
    const dtf = frameDt * (1 + jitter * (rnd() * 2 - 1));
    clock.t += dtf * 1000;
    const now = clock.t;
    const dt = lastTickMs === 0 ? frameDt : Math.min((now - lastTickMs) / 1000, 0.1);
    lastTickMs = now;

    // 权威循环推进（帧间所有 64Hz tick）
    while (workerSimMs + fixedDt * 1000 <= now + 1e-9) {
      workerSimMs += fixedDt * 1000;
      workerStep(workerSimMs);
    }

    // 主线程消息处理：把到期的 land 事件交给接线②（调用点见
    // apps/debug/src/app.ts 的 phys-event 分支）
    for (const ev of events) {
      if (ev.at > now) continue;
      if (ev.kind !== 'land') continue;
      const rNow = render.state();
      if (!rNow.onGround) stat.landWhileAirborne++;
      if (opts.land === 'legacy') {
        // 本脚本自带的内联复刻（脚本资产）：读渲染现状态后整份重写并把 onGround 置真。
        // 源码里没有这段代码，它只作对照面，不代表本仓任何现有行为。
        render.set_state(
          rNow.posX, rNow.posY, rNow.posZ, rNow.yaw, rNow.pitch,
          ev.vel[0], ev.vel[1], ev.vel[2], true,
        );
      } else {
        cal.applyCollisionCorrection(ev.kind, ev.pos, ev.yawDeg, ev.pitchDeg, ev.vel);
      }
    }
    events = events.filter((ev) => ev.at > now);

    // 输入：按住跳键时写跳键位，否则写 0；pendingKeys 即本帧要喂给渲染线的掩码
    sharedKeys = opts.holdJump ? KEY_JUMP : 0;
    pendingKeys = sharedKeys;

    // 生产同序：权威校准 → 速度外推 → 推进渲染物理（见
    // apps/debug/src/renderer/renderer-main.ts 的 tick 实现）
    cal.correctFromAuthority();
    cal.calibrateVelocity(now);
    const preSet = render.state(); // set_velocity 之后、tick 之前
    if (preSet.velY > stat.maxRenderSetVelY) stat.maxRenderSetVelY = preSet.velY;
    render.tick(dt, pendingKeys, pendingDx, pendingDy);
    const post = render.state();
    pendingDx = 0; pendingDy = 0;

    if (preSet.onGround && post.velY > 250) { // 本帧发生起跳
      const h = preSet.posY - GROUND_Y;
      stat.renderImpulses++;
      if (h > MID_AIR_HU) stat.renderImpulsesMidAir++;
      if (cur === null) cur = { apex: post.posY, impulses: 1, maxImpulseH: h, startH: h };
      else { cur.impulses++; cur.maxImpulseH = Math.max(cur.maxImpulseH, h); }
    }
    if (cur) cur.apex = Math.max(cur.apex, post.posY);
    if (post.onGround && cur) { cur.apexH = cur.apex - GROUND_Y; flights.push(cur); cur = null; }
  }

  return { flights, stat, frameHz: opts.frameHz };
}

/** 把一次 run 的结果压成一行一行的统计量；apex 列表保留一位小数，其余按需取位数。 */
function summarize(tag, r) {
  const apex = r.flights.map((f) => f.apexH).filter((v) => Number.isFinite(v));
  const sorted = [...apex].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const s = r.stat;
  return {
    tag, frameHz: r.frameHz, n: apex.length,
    median: med, min: sorted[0], max: sorted[sorted.length - 1],
    apex: sorted.map((v) => +v.toFixed(1)),
    multiImpulseFlights: r.flights.filter((f) => f.impulses > 1).length,
    midAirFlights: r.flights.filter((f) => f.maxImpulseH > MID_AIR_HU).length,
    apexOver70: r.flights.filter((f) => f.apexH > 70).length,
    deadFlights: r.flights.filter((f) => f.apexH < 20).length,
    authImpulses: s.authImpulses, authImpulsesMidAir: s.authImpulsesMidAir,
    renderImpulses: s.renderImpulses, renderImpulsesMidAir: s.renderImpulsesMidAir,
    landEvents: s.landEvents, landWhileAirborne: s.landWhileAirborne,
    maxAuthVelY: +s.maxAuthVelY.toFixed(1), maxRenderSetVelY: +s.maxRenderSetVelY.toFixed(1),
  };
}

// ── 矩阵：帧率 × 重锚载荷 × land 支路 × 加速度外推 ─────────────────────
// 各列语义见文件头：authority 'full' / 'posonly' 是接线①的两支；
// land 'legacy'（脚本自带复刻）/ 'prod'（当前源码真实方法）是接线②的两支；
// accel 为假表示把 computeAuthAccel 覆盖成恒零。
const MATRIX = [
  { name: '①修复前 + ②修复前（历史 baseline）', authority: 'full', land: 'legacy', accel: true },
  { name: '仅修复A（重锚只播位置）', authority: 'posonly', land: 'legacy', accel: true },
  { name: '仅修复B（land 腾空不写）', authority: 'full', land: 'prod', accel: true },
  { name: '修复A+B（= 当前生产接线）', authority: 'posonly', land: 'prod', accel: true },
  { name: '修复A+B + 关加速度外推（诊断）', authority: 'posonly', land: 'prod', accel: false },
];
const FRAME_RATES = [
  { hz: 60, jitter: 0, label: '60Hz' },
  { hz: 144, jitter: 0, label: '144Hz' },
  { hz: 144, jitter: 0.25, label: '144Hz 抖动±25%' },
  { hz: 165, jitter: 0, label: '165Hz' },
  { hz: 240, jitter: 0, label: '240Hz' },
];
const DURATION_MS = 20000;

console.log('=== 跳跃顶高判定实验（平地按住空格连跳；autobhop=true）===');
console.log(`理论顶高 = v²/2g = 302²/1600 = ${(302 * 302 / 1600).toFixed(1)} HU（groundY=0）`);
console.log(`参数：时长 ${DURATION_MS / 1000}s/格，权威 64Hz，发布延迟 2ms\n`);

for (const rate of FRAME_RATES) {
  console.log(`################ 渲染 ${rate.label} ################`);
  for (const variant of MATRIX) {
    const r = run({ frameHz: rate.hz, jitter: rate.jitter, durationMs: DURATION_MS, holdJump: true, ...variant });
    const s = summarize(`${rate.label} ${variant.name}`, r);
    console.log(`── ${s.tag}`);
    console.log(`   飞行段 ${s.n} | 顶高 中位 ${s.median?.toFixed(1)} 最小 ${s.min?.toFixed(1)} 最大 ${s.max?.toFixed(1)}`);
    console.log(`   顶高列表 ${JSON.stringify(s.apex)}`);
    console.log(`   顶高>70HU ${s.apexOver70} | 死跳(<20HU) ${s.deadFlights} | 单段多次冲量 ${s.multiImpulseFlights} | 腾空起跳 渲染 ${s.renderImpulsesMidAir} 权威 ${s.authImpulsesMidAir}`);
    console.log(`   冲量 渲染 ${s.renderImpulses} 权威 ${s.authImpulses} | land 事件 ${s.landEvents}（其中渲染在空 ${s.landWhileAirborne}）| 权威 maxV_y ${s.maxAuthVelY} 渲染 set_velocity maxV_y ${s.maxRenderSetVelY}\n`);
  }
}
