/**
 * ts-shared 核心模块的 Node 单测（T-P2-4）。
 *
 * 覆盖三个高频纯逻辑模块：
 * - src/ts-shared/app/sim-clock.ts     固定步长累加器（时基、钳制、频率、统计、回调）；
 * - src/ts-shared/auth/shared-state.ts  SAB 通道（键位掩码、输入累加/消费、权威帧双缓冲、seqlock 元数据）；
 * - src/ts-shared/app/config-sync.ts    全量同步与增量 patch 的纯边界。
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
} = await loadTsBundle('src/ts-shared/entity/classes/brush.ts', 'entity-brush');

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
