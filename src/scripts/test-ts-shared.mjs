/**
 * ts-shared 核心模块的 Node 单测（T-P2-4）。
 *
 * 覆盖四个高频纯逻辑模块：
 * - src/ts-shared/app/sim-clock.ts     固定步长累加器（时基、钳制、频率、统计、回调）；
 * - src/ts-shared/auth/shared-state.ts  SAB 通道（键位掩码、输入累加/消费、权威帧双缓冲、seqlock 元数据）；
 * - src/ts-shared/app/config-sync.ts    全量同步与增量 patch 的纯边界；
 * - src/ts-shared/phys/world-builder.ts 碰撞数据 JSON/WSBW 编码降级（二进制块成对不变量）。
 *
 * 运行：node src/scripts/test-ts-shared.mjs（或根目录 npm run test:ts）。
 * 依赖：只用 Node 内置 node:test / node:assert/strict；TS 由各端已有的 esbuild 在内存中转译，
 *       不依赖 Node 22 的 --experimental-strip-types（CI 是 Node 22，见 ci-gates.yml）。
 * 约定：全部用假时钟 / 假调度器，不睡真实时间，整套 < 2s。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 三端各自装了 esbuild（根没有）：按 debug -> game -> viewer -> 根 依次解析。 */
function resolveEsbuild() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(root, 'apps', 'debug'),
    path.join(root, 'apps', 'game'),
    path.join(root, 'apps', 'viewer'),
    root,
  ];
  for (const dir of candidates) {
    try {
      return require.resolve('esbuild', { paths: [dir] });
    } catch {
      // 下一个候选
    }
  }
  throw new Error('找不到 esbuild：先在 apps/debug（或 game/viewer）执行 npm ci');
}

const esbuild = createRequire(import.meta.url)(resolveEsbuild());

const tmpDir = mkdtempSync(path.join(tmpdir(), 'websurf-ts-shared-'));
process.on('exit', () => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});

/**
 * 读 .ts 源码（含相对 import）-> esbuild 打包成单文件 ESM -> 写临时目录 -> 动态 import。
 *
 * 用于「纯函数长在实体类文件里」的模块（如 `classes/brush.ts`）：单文件转译会留下未解析的
 * `../start-solid.js` 等 import。打包只引入共享层纯 TS，不碰 three/wasm。
 */
async function loadTsBundle(relPath, name) {
  const built = await esbuild.build({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const outFile = path.join(tmpDir, name + '.mjs');
  writeFileSync(outFile, built.outputFiles[0].text, 'utf8');
  return import(pathToFileURL(outFile).href);
}

/** 读 .ts 源码 -> esbuild 转译成 ESM -> 写临时目录 -> 动态 import。 */
async function loadTs(relPath, name) {
  const source = readFileSync(path.join(root, relPath), 'utf8');
  const transformed = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
    sourcefile: relPath,
  });
  const outFile = path.join(tmpDir, name + '.mjs');
  writeFileSync(outFile, transformed.code, 'utf8');
  return import(pathToFileURL(outFile).href);
}

const { createSimClock } = await loadTs('src/ts-shared/app/sim-clock.ts', 'sim-clock');
const sharedState = await loadTs('src/ts-shared/auth/shared-state.ts', 'shared-state');
const { createConfigSync } = await loadTs('src/ts-shared/app/config-sync.ts', 'config-sync');
// 门平移换算是 `classes/brush.ts` 的一部分（独立成模块会让 debug 端的 `__esm` 包装差异
// 触发 shared-artifacts 的跨端文本分叉判定），因此打包该文件后 import。
const {
  doorMoveDirection,
  doorModelSize,
  doorMoveDistance,
  doorMoveSpeed,
  doorTravelSeconds,
  doorMoveOffset,
  funcRotatingAxis,
  rotatingSpeedLimit,
  rotatingDegreesToRadians,
  axisAngleEuler,
  rotDoorAxis,
  rotDoorSpeed,
  rotDoorAngleEuler,
} = await loadTsBundle('src/ts-shared/entity/classes/brush.ts', 'entity-brush');
// 碰撞数据编码降级：只打包共享层 TS（不碰 wasm），用桩 proc 驱动 buildWorldBundle。
const { buildWorldBundle } = await loadTsBundle('src/ts-shared/phys/world-builder.ts', 'phys-world-builder');
// 实体运行期宿主：验证 load() 保留出生期 func_door 镜像并在 update() 重放到 predPhys。
const { EntityGameplay } = await loadTsBundle('src/ts-shared/gameplay/entity-gameplay.ts', 'entity-gameplay');

// 旋转枢轴的「rest 零变化」不变量：组位置 = pivot、mesh 局部位置 = 原位置 - pivot 时，
// 世界坐标在旋转 0 的情况下逐分量不变（pivot 加回本身的抵消）。
const {
  dynamicEntityGroupPlacement,
  markDynamicEntities,
  collectDynamicEntityGroups,
  DYNAMIC_ENTITY_PIVOT_KEY,
} = await loadTsBundle('src/renderer-shared/scene/dynamic-entities.ts', 'dynamic-entities');
const THREE = await import('three');

const { ShmState, SHARED_BUFFER_SIZE, KEY_MASK, keysToMask, maskToKeys } = sharedState;

function near(actual, expected, relTol) {
  return Math.abs(actual - expected) <= Math.abs(expected) * relTol;
}

/** 固定步长时钟的假时钟推进：首次 pump 只建立时基，之后按 tickMs 手动推进。 */
function advance(clock, baseMs, durationMs, tickMs) {
  let steps = 0;
  for (let t = tickMs; t <= durationMs + 1e-9; t += tickMs) {
    steps += clock.pump(baseMs + t);
  }
  return steps;
}

/** 不落地的调度器桩：避免单测启动真实 MessageChannel 泵。 */
const fakeScheduler = { post() {}, delay() {}, cancel() {}, dispose() {} };

// ── sim-clock：固定步长累加器 ───────────────────────────────────────────────────

test('sim-clock: 首次 pump 只建立时基，返回 0 步', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 60 });
  assert.equal(clock.pump(1000), 0);
  assert.equal(clock.stats.steps, 0);
});

test('sim-clock: 60Hz 下 1s 推进约 60 步，且每步 dt 恒为 1/60', () => {
  const dts = [];
  const clock = createSimClock({ step: (dt) => dts.push(dt), getTargetHz: () => 60 });
  clock.pump(0);
  const steps = advance(clock, 0, 1000, 10);
  assert.ok(near(steps, 60, 0.02), 'steps=' + steps);
  assert.ok(dts.length > 0 && dts.every((dt) => Math.abs(dt - 1 / 60) < 1e-12));
  assert.equal(clock.stats.steps, dts.length);
});

test('sim-clock: cap 生效（target 1000 + cap 120 -> 120Hz）', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 1000, getCapHz: () => 120 });
  clock.pump(0);
  const steps = advance(clock, 0, 1000, 10);
  assert.ok(near(steps, 120, 0.03), 'steps=' + steps);
  assert.equal(clock.stats.targetHz, 1000);
  assert.equal(clock.stats.capHz, 120);
});

test('sim-clock: 默认 maxCatchUpMs=50 丢弃卡顿欠账（5s 跳跃只补 50 步）', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 1000 });
  clock.pump(0);
  assert.equal(clock.pump(5000), 50);
  assert.equal(clock.stats.steps, 50);
  assert.equal(clock.stats.lastOwedMs, 5000);
});

test('sim-clock: 单拍补步硬上限 64（MAX_STEPS_PER_PUMP）', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 1000, maxCatchUpMs: 250 });
  clock.pump(0);
  assert.equal(clock.pump(5000), 64);
});

test('sim-clock: 期望频率夹到 [1, 2000]', () => {
  const high = createSimClock({ step: () => {}, getTargetHz: () => 5000 });
  high.pump(0);
  assert.equal(high.stats.targetHz, 2000);
  const low = createSimClock({ step: () => {}, getTargetHz: () => 0 });
  low.pump(0);
  assert.equal(low.stats.targetHz, 1);
});

test('sim-clock: 非法频率回退 / 沿用上一有效值', () => {
  let target = Number.NaN;
  const clock = createSimClock({ step: () => {}, getTargetHz: () => target });
  clock.pump(0);
  assert.equal(clock.stats.targetHz, 1);
  target = 480;
  clock.pump(4);
  assert.equal(clock.stats.targetHz, 480);
  target = Number.NaN;
  clock.pump(8);
  assert.equal(clock.stats.targetHz, 480);
});

test('sim-clock: 时间戳回拨按经过 0 处理（不产生负步数）', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 480 });
  clock.pump(1000);
  assert.equal(clock.pump(0), 0);
  const nanSteps = clock.pump(Number.NaN);
  assert.equal(typeof nanSteps, 'number');
  assert.ok(nanSteps >= 0);
});

test('sim-clock: setOnRate 只在有效频率变化时回调，null 取消订阅', () => {
  const rates = [];
  let target = 240;
  const clock = createSimClock({ step: () => {}, getTargetHz: () => target });
  clock.setOnRate((rate) => rates.push(rate));
  clock.pump(0);
  clock.pump(10);
  assert.deepEqual(rates, []);
  target = 480;
  clock.pump(20);
  assert.deepEqual(rates, [480]);
  clock.setOnRate(null);
  target = 240;
  clock.pump(30);
  assert.deepEqual(rates, [480]);
});

test('sim-clock: start/stop 幂等且只翻转 running（注入调度器桩，不跑真实泵）', () => {
  const clock = createSimClock({ step: () => {}, getTargetHz: () => 60, scheduler: fakeScheduler });
  assert.equal(clock.running, false);
  clock.start();
  assert.equal(clock.running, true);
  clock.start();
  clock.stop();
  assert.equal(clock.running, false);
  clock.stop();
});

test('sim-clock: step 抛错向 pump 调用方传播', () => {
  const clock = createSimClock({
    step: () => {
      throw new Error('boom');
    },
    getTargetHz: () => 1000,
  });
  clock.pump(0);
  assert.throws(() => clock.pump(10), /boom/);
});

// ── shared-state：SAB 通道 ─────────────────────────────────────────────────────

function makeState() {
  return new ShmState(new SharedArrayBuffer(SHARED_BUFFER_SIZE));
}

function makeFrame(overrides) {
  const frame = {
    pos: { x: 12.34, y: -5.67, z: 89.01 },
    yaw: 1.234,
    pitch: -0.567,
    vel: { x: 0.12, y: 0, z: -3.45 },
    eyeHeight: 64.5,
    timeMs: 1234567,
  };
  return Object.assign(frame, overrides || {});
}

test('shared-state: keysToMask / maskToKeys 位掩码往返', () => {
  const mask = KEY_MASK.forward | KEY_MASK.jump;
  const keys = maskToKeys(mask);
  assert.equal(keys.forward, true);
  assert.equal(keys.jump, true);
  assert.equal(keys.backward, false);
  assert.equal(keysToMask(keys), mask);
  assert.equal(keysToMask(maskToKeys(0)), 0);
});

test('shared-state: addInput -> takeInput 定点往返，消费后清零但键位保留', () => {
  const state = makeState();
  state.addInput(12.5, -3.25, KEY_MASK.forward);
  const sample = state.takeInput(100);
  assert.equal(sample.dx, 12.5);
  assert.equal(sample.dy, -3.25);
  assert.equal(sample.keysMask, KEY_MASK.forward);
  const again = state.takeInput(100);
  assert.equal(again.dx, 0);
  assert.equal(again.dy, 0);
  assert.equal(again.keysMask, KEY_MASK.forward);
});

test('shared-state: takeInput 按 maxStep 饱和截断', () => {
  const state = makeState();
  state.addInput(50, -60, 0);
  const sample = state.takeInput(1);
  assert.equal(sample.dx, 1);
  assert.equal(sample.dy, -1);
});

test('shared-state: peekInput 不消费（乐观投影不抢真实 tick 的输入）', () => {
  const state = makeState();
  state.addInput(2, 3, KEY_MASK.duck);
  const peeked = state.peekInput(100);
  assert.equal(peeked.dx, 2);
  assert.equal(peeked.dy, 3);
  const taken = state.takeInput(100);
  assert.equal(taken.dx, 2);
  assert.equal(taken.dy, 3);
  assert.equal(taken.keysMask, KEY_MASK.duck);
});

test('shared-state: resetInput 丢弃鼠标增量但保留按住键位', () => {
  const state = makeState();
  state.addInput(7, -7, KEY_MASK.jump);
  state.resetInput();
  const sample = state.takeInput(100);
  assert.equal(sample.dx, 0);
  assert.equal(sample.dy, 0);
  assert.equal(state.peekKeys(), KEY_MASK.jump);
});

test('shared-state: consumeInput 不限幅（解耦线整帧消费）', () => {
  const state = makeState();
  state.addInput(5, -4, 0);
  const sample = state.consumeInput();
  assert.equal(sample.dx, 5);
  assert.equal(sample.dy, -4);
  const after = state.takeInput(100);
  assert.equal(after.dx, 0);
});

test('shared-state: 未发布时 readAuthoritative 返回 null', () => {
  const state = makeState();
  assert.equal(state.readAuthoritative(), null);
  assert.equal(state.readAuthoritativeInto(new Float64Array(10), new Int32Array(5)), 0);
});

test('shared-state: writeAuthoritative / readAuthoritative 双缓冲往返', () => {
  const state = makeState();
  const frame = makeFrame();
  assert.equal(state.writeAuthoritative(frame, true), 1);
  const read = state.readAuthoritative();
  assert.ok(read !== null);
  assert.equal(read.va, 1);
  assert.equal(read.frame.pos.x, frame.pos.x);
  assert.equal(read.frame.pos.z, frame.pos.z);
  assert.equal(read.frame.yaw, frame.yaw);
  assert.equal(read.frame.pitch, frame.pitch);
  assert.equal(read.frame.vel.z, frame.vel.z);
  assert.equal(read.frame.eyeHeight, frame.eyeHeight);
  assert.equal(read.frame.timeMs, frame.timeMs);
  assert.equal(read.frame.onGround, true);
});

test('shared-state: 连续发布版本号递增且读到最新帧', () => {
  const state = makeState();
  state.writeAuthoritative(makeFrame(), false);
  const second = makeFrame({ pos: { x: -1.5, y: 2.25, z: 3 } });
  assert.equal(state.writeAuthoritative(second, false), 2);
  const read = state.readAuthoritative();
  assert.equal(read.va, 2);
  assert.equal(read.frame.pos.x, -1.5);
  assert.equal(read.frame.pos.y, 2.25);
  assert.equal(read.frame.onGround, false);
});

test('shared-state: readAuthoritativeInto 填充 f64/i32 并带出 tick 三元组', () => {
  const state = makeState();
  state.writeAuthoritative(makeFrame(), false, { seg: 3, tick: 77, evt: 8 });
  const dstF64 = new Float64Array(10);
  const dstI32 = new Int32Array(5);
  assert.equal(state.readAuthoritativeInto(dstF64, dstI32), 1);
  assert.equal(dstF64[0], 12.34);
  assert.equal(dstF64[1], -5.67);
  assert.equal(dstF64[3], 1.234);
  assert.equal(dstF64[9], 1234567);
  assert.equal(dstI32[0], 0);
  assert.equal(dstI32[1], 1);
  assert.equal(dstI32[2], 3);
  assert.equal(dstI32[3], 77);
  assert.equal(dstI32[4], 8);
});

test('shared-state: writeDecoupled / readDecoupled 独立于权威线', () => {
  const state = makeState();
  const frame = makeFrame({ pos: { x: 1, y: 2, z: 3 } });
  state.writeDecoupled(frame);
  const read = state.readDecoupled();
  assert.ok(read !== null);
  assert.equal(read.vd, 1);
  assert.equal(read.frame.pos.x, 1);
  assert.equal(state.readAuthoritative(), null);
});

// ── config-sync：全量同步 / 增量 patch ─────────────────────────────────────────

function makeSync(hooks) {
  const calls = [];
  const config = { render: { fov: 90, vsync: true }, audio: { volume: 0.8 } };
  const sync = createConfigSync({
    config,
    sections: ['render', 'audio'],
    send: (section, patch) => calls.push(['send', section, patch]),
    render: {
      render: (patch) => calls.push(['render', 'render', patch]),
      audio: (patch) => calls.push(['render', 'audio', patch]),
    },
    afterSection: (section, patch) => calls.push(['after', section, patch]),
    ...(hooks || {}),
  });
  return { sync, config, calls };
}

test('config-sync: syncConfig 按 sections 顺序逐段全量下发', () => {
  const { sync, calls } = makeSync();
  sync.syncConfig();
  const sends = calls.filter((c) => c[0] === 'send');
  assert.deepEqual(sends.map((c) => c[1]), ['render', 'audio']);
  assert.deepEqual(sends[0][2], { fov: 90, vsync: true });
  assert.deepEqual(sends[1][2], { volume: 0.8 });
});

test('config-sync: render -> send -> afterSection 顺序稳定', () => {
  const { sync, calls } = makeSync();
  sync.syncConfig({ sections: ['render'] });
  assert.deepEqual(calls.map((c) => c[0]), ['render', 'send', 'after']);
});

test('config-sync: syncConfig({ render: false }) 跳过主线程副作用', () => {
  const { sync, calls } = makeSync();
  sync.syncConfig({ render: false });
  assert.equal(calls.some((c) => c[0] === 'render'), false);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 2);
});

test('config-sync: applyPatch 只下发真正变化的字段', () => {
  const { sync, config, calls } = makeSync();
  sync.syncConfig();
  calls.length = 0;
  sync.applyPatch('render', { fov: 100 });
  assert.equal(config.render.fov, 100);
  const sends = calls.filter((c) => c[0] === 'send');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0][2], { fov: 100 });
});

test('config-sync: applyPatch 无变化时不下发（含同值重复 patch）', () => {
  const { sync, calls } = makeSync();
  assert.deepEqual(calls, []);
  sync.applyPatch('render', { fov: 90 });
  assert.equal(calls.filter((c) => c[0] === 'send').length, 0);
});

test('config-sync: transform 返回 null 时该段完全丢弃（不 render / 不 send / 不记快照）', () => {
  const { sync, calls } = makeSync({ transform: (section) => (section === 'audio' ? null : undefined) });
  sync.syncConfig();
  const sends = calls.filter((c) => c[0] === 'send');
  assert.deepEqual(sends.map((c) => c[1]), ['render']);
  calls.length = 0;
  sync.applyPatch('audio', { volume: 0.1 });
  assert.equal(calls.length, 0);
});

test('config-sync: snapshot 返回 sections 的深拷贝', () => {
  const { sync, config } = makeSync();
  const snap = sync.snapshot();
  assert.deepEqual(snap, { render: { fov: 90, vsync: true }, audio: { volume: 0.8 } });
  snap.render.fov = 12;
  assert.equal(config.render.fov, 90);
});

// ── door-motion：func_door 平移换算（T-N4） ──────────────────────────────────────
// 口径对照 Source `CBaseDoor::Spawn`：方向由 `AngleVectors` 的 forward 转 Y-up，
// 行程 = |dir·OBB| - lip，speed 是 HU/s。真实样例来自
// test/maps/ze_cursed_bear_tales_v1_2.bsp（Y-up 尺寸 = BSP model AABB 的 [y,z,x]）。

function vecNear(actual, expected, tol = 1e-9) {
  assert.equal(actual.length, 3, '三维向量');
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tol, '[' + actual.join(',') + '] != [' + expected.join(',') + ']');
  }
}

test('door-motion: movedir 角度 → Y-up 单位向量（pitch/yaw，roll 不参与）', () => {
  vecNear(doorMoveDirection([-90, 0, 0]), [0, 1, 0]);
  vecNear(doorMoveDirection([90, 0, 0]), [0, -1, 0]);
  vecNear(doorMoveDirection([0, 0, 0]), [0, 0, 1]);
  vecNear(doorMoveDirection([0, 90, 0]), [1, 0, 0]);
  vecNear(doorMoveDirection([0, 180, 0]), [0, 0, -1]);
  vecNear(doorMoveDirection([0, 270, 0]), [-1, 0, 0]);
  vecNear(doorMoveDirection([0, 15, 0]), [Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]);
  vecNear(doorMoveDirection([0, 90, 45]), doorMoveDirection([0, 90, 0]));
});

test('door-motion: 缺键/非法 movedir 返回 null（调用方回退旧隐藏近似）', () => {
  assert.equal(doorMoveDirection(undefined), null);
  assert.equal(doorMoveDirection(null), null);
  assert.equal(doorMoveDirection([]), null);
  assert.equal(doorMoveDirection([0, 0]), null);
  assert.equal(doorMoveDirection([Number.NaN, 0, 0]), null);
});

test('door-motion: brush 体积并集尺寸（AABB 平移不变，等价 OBB 尺寸）', () => {
  assert.deepEqual(doorModelSize([{ mins: [0, 0, 0], maxs: [10, 20, 30] }]), [10, 20, 30]);
  assert.deepEqual(doorModelSize([
    { mins: [-5, 0, 0], maxs: [0, 4, 8] },
    { mins: [0, 10, -2], maxs: [6, 12, 8] },
  ]), [11, 12, 10]);
  assert.equal(doorModelSize([]), null);
  assert.equal(doorModelSize(undefined), null);
});

test('door-motion: 行程 = |dir·OBB| - lip，投影小于 lip 时钳 0', () => {
  const size = [320, 304, 36];
  assert.equal(doorMoveDistance(size, [0, 1, 0], 64), 240); // 实测 #200 lvl2_door
  assert.equal(doorMoveDistance([1, 656, 168], [0, 1, 0], 300), 356); // 实测 #589 lvl1_door_08
  assert.equal(doorMoveDistance(size, [0, 1, 0], 0), 304);
  assert.equal(doorMoveDistance(size, [0, 1, 0], 304), 0);
  assert.equal(doorMoveDistance(size, [0, 1, 0], 400), 0);
  assert.ok(near(doorMoveDistance([356, 16, 356], [Math.SQRT1_2, 0, Math.SQRT1_2], 0), 503.46, 1e-4)); // 实测 #1355 45° 门
  assert.equal(doorMoveDistance(size, undefined, 0), 0);
  assert.equal(doorMoveDistance(undefined, [0, 1, 0], 0), 0);
});

test('door-motion: speed 0/非有限/负数回落到 Source 默认 100 HU/s', () => {
  assert.equal(doorMoveSpeed(0), 100);
  assert.equal(doorMoveSpeed(-3), 100);
  assert.equal(doorMoveSpeed(Number.NaN), 100);
  assert.equal(doorMoveSpeed(250), 250);
});

test('door-motion: 行程时长 = 距离 / speed，按剩余进度线性折算', () => {
  assert.equal(doorTravelSeconds(240, 100), 2.4);
  assert.equal(doorTravelSeconds(240, 0), 2.4); // speed 0 → 100
  assert.equal(doorTravelSeconds(240, 100, 0.25), 0.6);
  assert.equal(doorTravelSeconds(240, 100, -0.5), 1.2);
  assert.equal(doorTravelSeconds(0, 100), 0);
  assert.equal(doorTravelSeconds(156, 1), 156); // 实测 #1315 speed=1，忠实 Source 的慢速
});

test('door-motion: 位移 = 方向 * 行程 * progress，progress 钳 0..1', () => {
  vecNear(doorMoveOffset([0, 1, 0], 240, 0.5), [0, 120, 0]);
  vecNear(doorMoveOffset([0, 1, 0], 240, 2), [0, 240, 0]);
  vecNear(doorMoveOffset([0, 1, 0], 240, -1), [0, 0, 0]);
  vecNear(doorMoveOffset(undefined, 240, 1), [0, 0, 0]);
  vecNear(doorMoveOffset([1, 0, 0], 240, 0), [0, 0, 0]);
});

// ── rotation：func_rotating / func_door_rotating 的轴与角度换算（T-N5） ──────────
// 轴语义以 bmodels.cpp:673-684 的 QAngle + physics_main.cpp:794-797 的欧拉积分 +
// vector.h:2191-2196 的 QAngleToAngularImpulse 为准：flag4 绕 Source X、flag8 绕 Source Y、
// 默认绕 Source Z；换到 three 轴序（convert.rs 的 map_coords）即 [0,0,1] / [1,0,0] / [0,1,0]。

test('rotation: func_rotating 轴旗标 → three 轴（X/Y/Z + BACKWARDS）', () => {
  vecNear(funcRotatingAxis(0), [0, 1, 0]); // 默认 Y_AXIS 名 → 实际绕 Source Z（竖直）
  vecNear(funcRotatingAxis(4), [0, 0, 1]); // Z_AXIS 名 → 实际绕 Source X
  vecNear(funcRotatingAxis(8), [1, 0, 0]); // X_AXIS 名 → 实际绕 Source Y
  vecNear(funcRotatingAxis(2), [0, -1, 0]); // BACKWARDS 取负
  vecNear(funcRotatingAxis(6), [0, 0, -1]);
  vecNear(funcRotatingAxis(10), [-1, 0, 0]);
  // BSP 实证（ze_cursed，flags / 数量）：512×2、513×1、516×1、580×1、581×2、582×1、585×4；
  // 其中 512 是 SMALL/LARGE 半径位，不影响轴。
  vecNear(funcRotatingAxis(513), [0, 1, 0]); // 512+1 lvl2_rotate（START_ON + 默认轴）
  vecNear(funcRotatingAxis(516), [0, 0, 1]); // 512+4 piege01
  vecNear(funcRotatingAxis(581), [0, 0, 1]); // 512+64+4+1 lvl2_rotate5/6
  vecNear(funcRotatingAxis(585), [1, 0, 0]); // 512+64+8+1 lvl2_rotate01..4
  vecNear(funcRotatingAxis(Number.NaN), [0, 1, 0]);
});

test('rotation: maxspeed 0/非有限回落 100、负值取绝对值', () => {
  assert.equal(rotatingSpeedLimit(0), 100);
  assert.equal(rotatingSpeedLimit(Number.NaN), 100);
  assert.equal(rotatingSpeedLimit(Number.POSITIVE_INFINITY), 100);
  assert.equal(rotatingSpeedLimit(-80), 80);
  assert.equal(rotatingSpeedLimit(8), 8);
  assert.equal(rotatingSpeedLimit(100), 100);
});

test('rotation: 角度→弧度与单轴欧拉写回，rest（0°）严格恒等', () => {
  assert.equal(rotatingDegreesToRadians(180), Math.PI);
  assert.equal(rotatingDegreesToRadians(90), Math.PI / 2);
  assert.equal(rotatingDegreesToRadians(Number.NaN), 0);
  vecNear(axisAngleEuler([0, 1, 0], Math.PI / 2), [0, Math.PI / 2, 0]);
  vecNear(axisAngleEuler([1, 0, 0], Math.PI), [Math.PI, 0, 0]);
  vecNear(axisAngleEuler([0, 0, 1], -Math.PI / 4), [0, 0, -Math.PI / 4]);
  // rest 不变量：未旋转时三分量必须都是 0（否则枢轴组会带着初始旋转出生）。
  vecNear(axisAngleEuler([0, 1, 0], 0), [0, 0, 0]);
  vecNear(axisAngleEuler([0, 0, 1], rotatingDegreesToRadians(0)), [0, 0, 0]);
  vecNear(axisAngleEuler(null, 1.23), [0, 0, 0]);
  vecNear(axisAngleEuler([Number.NaN, 0, 0], 1), [0, 0, 0]);
});

test('rotation: func_door_rotating 轴（YAW/ROLL/PITCH + BACKWARDS）', () => {
  vecNear(rotDoorAxis(0), [0, 1, 0]); // 默认 YAW → 竖直
  vecNear(rotDoorAxis(2), [0, -1, 0]);
  vecNear(rotDoorAxis(64), [0, 0, 1]); // ROTATE_ROLL → 绕 Source X
  vecNear(rotDoorAxis(128), [1, 0, 0]); // ROTATE_PITCH → 绕 Source Y
  vecNear(rotDoorAxis(66), [0, 0, -1]);
  vecNear(rotDoorAxis(130), [-1, 0, 0]);
  vecNear(rotDoorAxis(12), [0, 1, 0]); // ze_cursed flags=12（NONSOLID_TO_PLAYER|PASSABLE）非轴
  vecNear(rotDoorAxis(Number.NaN), [0, 1, 0]);
});

test('rotation: 旋转门速度 0/非有限/负数回落 100 度/秒', () => {
  assert.equal(rotDoorSpeed(0), 100);
  assert.equal(rotDoorSpeed(-30), 100);
  assert.equal(rotDoorSpeed(Number.NaN), 100);
  assert.equal(rotDoorSpeed(30), 30);
  assert.equal(rotDoorSpeed(300), 300);
});

test('rotation: 旋转门角度按 progress 线性插值并钳 0..1', () => {
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, 0), [0, 0, 0]);
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, 0.5), [0, Math.PI / 2, 0]);
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, 1), [0, Math.PI, 0]);
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, 2), [0, Math.PI, 0]);
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, -1), [0, 0, 0]);
  vecNear(rotDoorAngleEuler([0, 0, 1], 90, 1), [0, 0, Math.PI / 2]);
  vecNear(rotDoorAngleEuler([0, 1, 0], 180, Number.NaN), [0, 0, 0]);
});

test('rotation: 枢轴组放置的 rest 零变化不变量（world = pivot + worldPos - pivot）', () => {
  const pivot = [12556, 12896, -140]; // 实测 #116 lvl2_rotate 的 BSP origin
  const meshWorld = [12556, 12896, -140]; // 合并后 mesh 已清零局部变换，世界坐标 = 0；这里取与 pivot 重合的最简分支
  const placed = dynamicEntityGroupPlacement(pivot, meshWorld);
  vecNear(placed.position, pivot);
  vecNear(placed.meshOffset, [0, 0, 0]);
  const world = [placed.position[0] + placed.meshOffset[0], placed.position[1] + placed.meshOffset[1], placed.position[2] + placed.meshOffset[2]];
  vecNear(world, meshWorld);
  // 带内部偏移的 mesh（多 primitive / 非零局部变换）：世界坐标同样逐分量不变。
  const offsetWorld = [12600, 12896, -100];
  const placed2 = dynamicEntityGroupPlacement(pivot, offsetWorld);
  vecNear(placed2.position, pivot);
  vecNear(placed2.meshOffset, [44, 0, 40]);
  vecNear([
    placed2.position[0] + placed2.meshOffset[0],
    placed2.position[1] + placed2.meshOffset[1],
    placed2.position[2] + placed2.meshOffset[2],
  ], offsetWorld);
  // 未合并路径：子 mesh 世界坐标 = 实体 origin（父链平移仍在），偏移应为 0 而不是 -pivot。
  vecNear(dynamicEntityGroupPlacement(pivot, pivot).meshOffset, [0, 0, 0]);
  // 缺 pivot（旧 GLB / 无 origin 实体）→ 组在原点，行为与改造前一致。
  vecNear(dynamicEntityGroupPlacement(null, [4, 5, 6]).position, [0, 0, 0]);
  vecNear(dynamicEntityGroupPlacement(null, [4, 5, 6]).meshOffset, [4, 5, 6]);
  vecNear(dynamicEntityGroupPlacement([1, Number.NaN, 3], [1, 2, 3]).position, [1, 0, 3]);
});

test('rotation: 动态实体组绕自身 BSP origin 旋转（rest 世界坐标零变化）', () => {
  // 造一个「合并前」的场景：实体节点 translation = BSP origin（GLB 导出即如此），
  // mesh 几何已世界烘焙、局部变换单位阵（scene-optimizer 的 exclude 分支结果）。
  const root = new THREE.Scene();
  const entityNode = new THREE.Group();
  entityNode.name = 'brush_5';
  entityNode.userData.vbsp_entity_index = 5;
  entityNode.userData.vbsp_model = '*1';
  entityNode.position.set(10, 20, 30);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.userData.vbsp_entity_index = 5;
  entityNode.add(mesh);
  root.add(entityNode);

  assert.equal(markDynamicEntities(root, new Set([5])), 1);
  assert.deepEqual(mesh.userData[DYNAMIC_ENTITY_PIVOT_KEY], [10, 20, 30]);
  // 合并路径：exclude 分支把顶点烘焙到世界空间、局部变换清零，mesh 成为新 root 的直接子节点。
  root.add(mesh);
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  const groups = collectDynamicEntityGroups(root);
  const group = groups.get(5);
  assert.ok(group, '组已建立');
  assert.deepEqual([group.position.x, group.position.y, group.position.z], [10, 20, 30]);
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [-10, -20, -30]);

  root.updateMatrixWorld(true);
  const pivotPoint = new THREE.Vector3(10, 20, 30); // 恰在枢轴上的顶点
  const offPoint = new THREE.Vector3(11, 20, 30); // 枢轴 +1 HU
  const worldOf = (v) => v.clone().applyMatrix4(mesh.matrixWorld);
  vecNear(worldOf(pivotPoint).toArray(), [10, 20, 30], 1e-6); // rest：零变化
  vecNear(worldOf(offPoint).toArray(), [11, 20, 30], 1e-6);

  group.rotation.y = Math.PI / 2; // func_rotating 默认轴（three Y = 竖直）
  root.updateMatrixWorld(true);
  vecNear(worldOf(pivotPoint).toArray(), [10, 20, 30], 1e-6); // 枢轴点严格不动（不绕世界原点公转）
  // three Y 轴 +90°：相对偏移 (1,0,0) → (0,0,-1)。
  vecNear(worldOf(offPoint).toArray(), [10, 20, 29], 1e-6);
});

test('rotation: 未合并路径（多 primitive 子 mesh）rest 世界坐标不变', () => {
  // merge === false 时不跑合并器：几何仍是模型局部坐标，mesh 保持挂在实体节点下，
  // 世界坐标 = 实体 origin + 局部偏移。偏移必须按世界坐标算，否则会少加一次 origin。
  const root = new THREE.Scene();
  const entityNode = new THREE.Group();
  entityNode.name = 'brush_7';
  entityNode.userData.vbsp_entity_index = 7;
  entityNode.userData.vbsp_model = '*2';
  entityNode.position.set(100, -50, 4);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.userData.vbsp_entity_index = 7;
  entityNode.add(mesh);
  root.add(entityNode);

  markDynamicEntities(root, new Set([7]));
  const groups = collectDynamicEntityGroups(root);
  const group = groups.get(7);
  assert.ok(group, '组已建立');
  assert.deepEqual([group.position.x, group.position.y, group.position.z], [100, -50, 4]);
  assert.deepEqual([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, 0]);

  root.updateMatrixWorld(true);
  const localPoint = new THREE.Vector3(1, 0, 0); // 模型局部顶点
  vecNear(localPoint.clone().applyMatrix4(mesh.matrixWorld).toArray(), [101, -50, 4], 1e-6);
  group.rotation.y = Math.PI / 2;
  root.updateMatrixWorld(true);
  vecNear(localPoint.clone().applyMatrix4(mesh.matrixWorld).toArray(), [100, -50, 3], 1e-6);
});
// ── world-builder：碰撞数据编码降级 ────────────────────────────────────────────

const WORLD_BRUSH_JSON = JSON.stringify([
  { planes: [{ normal: [0, 0, 1], dist: 0 }], min: [0, 0, 0], max: [1, 1, 1], is_ladder: false, is_solid: true, entity: -1, start_solid: true },
]);
const WORLD_TRI_JSON = JSON.stringify([
  { name: 'stub', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [[0, 1, 2]], min: [0, 0, 0], max: [1, 1, 0] },
]);

/** 最小 BspProcessor 桩：只覆盖 buildWorldBundle 会调用的导出。 */
function worldBuilderProc(overrides = {}) {
  return {
    metadata: () => JSON.stringify({ map_name: 'stub', num_faces: 1, num_vertices: 3, num_brushes: 1, num_models: 0 }),
    parse_spawn_points: () => JSON.stringify({ spawn_points: [{ classname: 'info_player_start', origin: [0, 100, 0], angles: [0, 0, 0] }], primary: 0 }),
    parse_teleports: () => '{"teleports":[]}',
    parse_pvs_data: () => '{}',
    export_brushes_planes: () => WORLD_BRUSH_JSON,
    export_brushes_planes_bin: () => new Uint8Array([1, 2, 3, 4]),
    export_model_phy_colliders: () => WORLD_TRI_JSON,
    export_model_tri_colliders: () => WORLD_TRI_JSON,
    export_model_colliders_bin: () => new Uint8Array([5, 6, 7, 8]),
    export_glb_with_pakfile_models_with_defaults_and_lights: () => new Uint8Array([9, 9, 9]),
    export_glb_with_pakfile_models: () => new Uint8Array([9, 9, 9]),
    take_mosaic_manifest: () => '{}',
    ...overrides,
  };
}

/** 跑一次 buildWorldBundle；测试期替换 fetch，避免 installVmtFallback 打真实请求。 */
async function buildWith(overrides, encoding) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    return await buildWorldBundle(worldBuilderProc(overrides), { colliderEncoding: encoding });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('world-builder: 两块二进制成功时只出二进制，JSON 保持占位', async () => {
  const bundle = await buildWith({}, 'bin');
  assert.ok(bundle.brushBin && bundle.triBin, '两块二进制都应存在');
  assert.equal(bundle.brushJson, '[]');
  assert.equal(bundle.triJson, '[]');
});

test('world-builder: 任一二进制块失败 -> 整对作废并强制 JSON 两件套', async () => {
  const cases = [
    { export_model_colliders_bin: () => { throw new Error('tri boom'); } },
    { export_brushes_planes_bin: () => { throw new Error('brush boom'); } },
  ];
  for (const overrides of cases) {
    const bundle = await buildWith(overrides, 'bin');
    assert.equal(bundle.brushBin, undefined, '不得留下半套 brush 二进制');
    assert.equal(bundle.triBin, undefined, '不得留下半套 tri 二进制');
    assert.notEqual(bundle.brushJson, '[]', 'brushJson 必须由 JSON 出口补齐');
    assert.notEqual(bundle.triJson, '[]', 'triJson 必须由 JSON 出口补齐');
  }
});

test('world-builder: both 档同时保留二进制与两份 JSON', async () => {
  const bundle = await buildWith({}, 'both');
  assert.ok(bundle.brushBin && bundle.triBin);
  assert.notEqual(bundle.brushJson, '[]');
  assert.notEqual(bundle.triJson, '[]');
});

const { PvsManager } = await loadTsBundle('src/ts-shared/world/pvs-manager.ts', 'pvs-manager');

test('pvs-manager: hasLeafAmbient 与 getAmbientCubeAt 正确解码正负指数与实心 leaf', () => {
  const makeLeafAmbientEntry = (valid, faces) => {
    const buf = new Uint8Array(25);
    buf[0] = valid ? 1 : 0;
    for (let f = 0; f < 6; f++) {
      const [r, g, b, exp] = faces[f] ?? [0, 0, 0, 0];
      const off = 1 + f * 4;
      buf[off] = r & 0xff;
      buf[off + 1] = g & 0xff;
      buf[off + 2] = b & 0xff;
      buf[off + 3] = exp & 0xff;
    }
    return buf;
  };

  const leaf0 = makeLeafAmbientEntry(true, [
    [255, 128, 0, 0],    // +X: exp=0 -> [255, 128, 0]
    [255, 0, 0, 2],      // -X: exp=+2 -> [1020, 0, 0]
    [0, 255, 0, -2],     // +Y: exp=-2 -> [0, 63.75, 0]
    [0, 0, 255, -1],     // -Y: exp=-1 -> [0, 0, 127.5]
    [128, 128, 128, 1],  // +Z: exp=+1 -> [256, 256, 256]
    [64, 64, 64, 0],     // -Z
  ]);
  const leaf1 = makeLeafAmbientEntry(false, []);
  const packed = new Uint8Array(50);
  packed.set(leaf0, 0);
  packed.set(leaf1, 25);
  const leafAmbientB64 = Buffer.from(packed).toString('base64');

  const basePvs = {
    rootNode: 0,
    nodes: [{ normal: [0, 1, 0], dist: 0, children: [-1, -2] }],
    leaves: [
      { cluster: 0, mins: [-100, 0, -100], maxs: [100, 100, 100], isSolid: false },
      { cluster: -1, mins: [-100, -100, -100], maxs: [100, 0, 100], isSolid: true },
    ],
    faceClusters: [],
    pvsBitsBase64: '',
    clusterCount: 1,
    bytesPerRow: 1,
  };

  const withoutAmb = new PvsManager(JSON.stringify(basePvs));
  assert.equal(withoutAmb.hasLeafAmbient(), false);
  const cubeOut = new Float32Array(18);
  assert.equal(withoutAmb.getAmbientCubeAt({ x: 0, y: 10, z: 0 }, cubeOut), false);

  const withAmb = new PvsManager(JSON.stringify({ ...basePvs, leafAmbientB64 }));
  assert.equal(withAmb.hasLeafAmbient(), true);
  assert.equal(withAmb.getAmbientCubeAt({ x: 0, y: 10, z: 0 }, cubeOut), true);
  assert.ok(Math.abs(cubeOut[0] - 255) < 1e-4);
  assert.ok(Math.abs(cubeOut[1] - 128) < 1e-4);
  assert.equal(cubeOut[2], 0);
  assert.ok(Math.abs(cubeOut[3] - 1020) < 1e-4); // 正指数 2^2
  assert.ok(Math.abs(cubeOut[7] - 63.75) < 1e-4); // 负指数 2^-2
  assert.ok(Math.abs(cubeOut[11] - 127.5) < 1e-4); // 负指数 2^-1
  assert.equal(withAmb.getAmbientCubeAt({ x: 0, y: -10, z: 0 }, cubeOut), false, '实心 leaf / valid=0 应返回 false');
});

test('EntityGameplay.load preserves spawn-time func_door brushSolid/brushOffset and replays them to predPhys', () => {
  const entitiesText = [
    '{\n"classname" "worldspawn"\n}',
    '{\n"classname" "func_door"\n"targetname" "lvl1_door_08"\n"model" "*1"\n"spawnpos" "1"\n"movedir" "-90 0 0"\n"lip" "300"\n"speed" "100"\n}',
  ].join('\n');
  const entityIoJson = JSON.stringify({
    entities_text: entitiesText,
    volumes: [
      {
        index: 1,
        model: '*1',
        origin: [10974.5, 1208, -2912],
        brushes: [
          {
            mins: [10974, 880, -2932],
            maxs: [10975, 1536, -2892],
            planes: [],
          },
        ],
      },
    ],
  });

  let physRef = null;
  const gp = new EntityGameplay({
    getPlayerState: () => ({ posX: 0, posY: 0, posZ: 0 }),
    getPhys: () => physRef,
  });

  gp.load(entityIoJson);
  assert.equal(gp.brushSolidOf(1), true, 'spawnpos=1 的 func_door 出生即应保留 solid=true 镜像');
  const offAfterLoad = gp.brushOffsetOf(1);
  assert.ok(offAfterLoad, 'spawnpos=1 的 func_door 出生即应保留 brushOffset 镜像');
  assert.ok(Math.abs(offAfterLoad[0]) < 1e-6);
  assert.ok(Math.abs(offAfterLoad[1] - 356) < 1e-6, `预期 y 偏移 356，实际 ${offAfterLoad[1]}`);
  assert.ok(Math.abs(offAfterLoad[2]) < 1e-6);

  const solidCalls = [];
  const offsetCalls = [];
  physRef = {
    set_brush_solid(entity, solid) {
      solidCalls.push([entity, solid]);
      return true;
    },
    set_brush_offset(entity, x, y, z) {
      offsetCalls.push([entity, x, y, z]);
      return 1;
    },
  };

  gp.update(0.01);
  assert.deepEqual(solidCalls, [[1, true]], 'predPhys 建立后首次 update() 必须重放 set_brush_solid(1, true)');
  assert.equal(offsetCalls.length, 1, 'predPhys 建立后首次 update() 必须重放 set_brush_offset');
  assert.equal(offsetCalls[0][0], 1);
  assert.ok(Math.abs(offsetCalls[0][1]) < 1e-6);
  assert.ok(Math.abs(offsetCalls[0][2] - 356) < 1e-6);
  assert.ok(Math.abs(offsetCalls[0][3]) < 1e-6);
});


