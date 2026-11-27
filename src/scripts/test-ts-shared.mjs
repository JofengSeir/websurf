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
const threeUrl = pathToFileURL(path.join(root, 'node_modules', 'three', 'build', 'three.module.js')).href;
const externalThreePlugin = {
  name: 'external-three',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: threeUrl, external: true }));
    build.onResolve({ filter: /^three\/examples\/jsm\// }, (args) => ({
      path: pathToFileURL(path.join(root, 'node_modules', args.path)).href,
      external: true,
    }));
  },
};

async function loadTsBundle(relPath, name) {
  const built = await esbuild.build({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    plugins: [externalThreePlugin],
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
const { EntitySystem, createRecordingHost } = await loadTsBundle('src/ts-shared/entity/entity-system.ts', 'entity-system');
// 权威校准器：验证跳离梯子后 270 HU/s 推离速度不被滞后权威帧覆盖。
const { AuthorityCalibrator } = await loadTsBundle('src/ts-shared/phys/authority-calibrator.ts', 'authority-calibrator');
// 近平面控制器：验证纯转视角不触发球距离重扫、ratio=0 命中短路。
const { NearPlaneController } = await loadTsBundle('src/renderer-shared/camera/near-plane.ts', 'near-plane');
// P0/P1 优化回归：BloomPostFx 复用帧跳过模糊 + VisibilityController 静态包围缓存 + 水面斜裁剪 + 透明排序。
const { BloomPostFx } = await loadTsBundle('src/renderer-shared/environment/post-fx.ts', 'post-fx');
const { VisibilityController } = await loadTsBundle('src/renderer-shared/scene/visibility-controller.ts', 'visibility-controller');
const { applyObliqueWaterClip } = await loadTsBundle('src/renderer-shared/shader/water/planar-reflect.ts', 'planar-reflect');
const { TransparentSorter } = await loadTsBundle('src/renderer-shared/scene/transparent-sorter.ts', 'transparent-sorter');
const { mergeIntoChunks } = await loadTsBundle('src/renderer-shared/scene/scene-optimizer.ts', 'scene-optimizer');
const { mergeWaterSurfaces } = await loadTsBundle('src/renderer-shared/scene/water-merge.ts', 'water-merge');
const { SpriteGlows } = await loadTsBundle('src/renderer-shared/scene/entity-extras/sprites.ts', 'entity-sprites');
const { Beams } = await loadTsBundle('src/renderer-shared/scene/entity-extras/beams.ts', 'entity-beams');
const { prepareClusterIndex, applyClusterIndex } = await loadTsBundle('src/renderer-shared/scene/cluster-filter.ts', 'cluster-filter');
const { PlaneInspector } = await loadTsBundle('apps/debug/src/renderer/plane-inspector.ts', 'plane-inspector');
const { applyWaterShaders, renderWaterFramePasses, resetWaterShaders } = await loadTsBundle('src/renderer-shared/shader/water.ts', 'water');
const {
  parseVdxtBuffer,
  createDxtTexture,
  decodeDxtMip0ToRgba,
  VDXT_HEADER_BYTES,
} = await loadTsBundle('src/renderer-shared/scene/dxt-texture.ts', 'dxt-texture');
const { applyTextureQuality } = await loadTsBundle('src/renderer-shared/scene/texture-quality.ts', 'texture-quality');
const { expandInstancedProps, INST_PROP_STRIDE_FLOATS } = await loadTsBundle('src/renderer-shared/scene/instanced-props.ts', 'instanced-props');
const { disposeObject } = await loadTsBundle('src/renderer-shared/scene/dispose.ts', 'dispose');

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

test('AuthorityCalibrator preserves ladder jump-off 270 HU/s velocity and syncs detach to authority', () => {
  const setVelCalls = [];
  const syncCalls = [];
  let st = {
    posX: 10956, posY: 960, posZ: -2912,
    yaw: -90, pitch: 0,
    velX: 0, velY: 200, velZ: 0,
    onGround: false, onLadder: true, eyeHeight: 64.09,
  };
  let auth = {
    va: 1,
    frame: {
      pos: { x: 10956, y: 960, z: -2912 },
      yaw: -90, pitch: 0,
      vel: { x: 0, y: 0, z: 0 },
      eyeHeight: 64.09, onGround: false, timeMs: 100,
    },
  };
  const cal = new AuthorityCalibrator({
    getPhys: () => ({
      state: () => st,
      set_state: () => {},
      set_velocity: (vx, vy, vz) => setVelCalls.push([vx, vy, vz]),
    }),
    readAuth: () => auth,
    clearPendingInput: () => {},
    onSyncRenderState: (s, teleport) => syncCalls.push({ s, teleport }),
  });

  // 首帧确立起点与 curAuth
  cal.correctFromAuthority();
  // 在梯上：wasOnLadder 置真，不覆盖速度
  cal.calibrateVelocity(1000);
  assert.equal(setVelCalls.length, 0);

  // 跳离梯子：onLadder 变 false，predPhys 拿到 [-270, 0, 0]
  st = { ...st, onLadder: false, velX: -270, velY: 0, velZ: 0 };
  cal.calibrateVelocity(1001);
  assert.equal(setVelCalls.length, 0, '脱离梯子当帧不能被滞后权威帧 vel=[0,0,0] 覆盖');
  assert.equal(syncCalls.length, 1, '脱离梯子当帧应立即向权威反向同步 270 HU/s 速度');
  assert.equal(syncCalls[0].teleport, true);
  assert.equal(syncCalls[0].s.velX, -270);

  // 豁免窗口内（< 120ms）仍不覆盖速度
  cal.calibrateVelocity(1050);
  assert.equal(setVelCalls.length, 0, '豁免窗口内不能被权威帧速度覆盖');

  // 豁免窗口结束后恢复正常耦合
  cal.calibrateVelocity(1130);
  assert.equal(setVelCalls.length, 1, '豁免窗口结束后应恢复速度耦合');
});

test('simClock.pendingMs 与 64tick 固定步长插值在 144Hz/320Hz 下无重复帧与锯齿回跳', () => {
  for (const [label, frameMs] of [['144Hz', 1000 / 144], ['320Hz', 1000 / 320]]) {
    const physHz = 64;
    const physStepSec = 1 / physHz;
    const speed = 250; // HU/s
    let physAcc = 0;
    let physX = 0;
    let prevX = 0;
    let curX = 0;

    const clock = createSimClock({
      getTargetHz: () => 1000,
      getCapHz: () => 1000,
      step: (dt) => {
        physAcc += dt;
        while (physAcc + 1e-9 >= physStepSec) {
          prevX = curX;
          physX += speed * physStepSec;
          curX = physX;
          physAcc -= physStepSec;
        }
      },
    });

    clock.pump(0); // 建立时基
    // 模拟真实浏览器：单调时间下 4ms 粗唤醒不均 + 每次 rAF 渲染前补 pump(now)
    let tCursor = 0;
    const deltas = [];
    let lastCamX = 0;
    for (let f = 1; f <= 120; f++) {
      const now = f * frameMs;
      // 模拟在本次 rAF 之前最多有一次 4ms 定时器先醒
      if (now - tCursor >= 4) {
        tCursor += 4;
        clock.pump(tCursor);
      }
      tCursor = now;
      // 渲染前补 pump 到当前 rAF 时刻（修复后的 RendererMain.tick 行为）
      clock.pump(now);
      assert.ok(clock.pendingMs >= 0 && clock.pendingMs < 1.0 + 1e-9, `${label} pendingMs 越界: ${clock.pendingMs}`);
      const alpha = Math.max(0, Math.min(1, (physAcc + clock.pendingMs / 1000) / physStepSec));
      const camX = prevX + (curX - prevX) * alpha;
      deltas.push(camX - lastCamX);
      lastCamX = camX;
    }

    // 跳过第 1 个 64Hz 物理步建立前后双快照之前的启动帧，后续每一帧位移必须严格相等且无零帧/回跳
    const startIdx = Math.ceil((2 * 1000 / physHz) / frameMs) + 1;
    const expected = speed * (frameMs / 1000);
    for (let i = startIdx; i < deltas.length; i++) {
      assert.ok(
        Math.abs(deltas[i] - expected) < 1e-6,
        `${label} frame ${i} 位移抖动: got=${deltas[i].toFixed(6)}, expected=${expected.toFixed(6)}`,
      );
    }
  }
});

test('NearPlaneController 视锥安全收缩、防 Z-Fighting、动态位移与旋转格网均成立', () => {
  const THREE = createRequire(import.meta.url)('three');
  const ctrl = new NearPlaneController();

  // 1. 大图默认 near 封顶 8 HU（不再取到 32.72 造成跳帧穿墙）
  const surf666Default = NearPlaneController.defaultNearForScene(32720);
  assert.equal(surf666Default, 8, `surf_666 默认 near 应封顶 8，实际 ${surf666Default}`);
  ctrl.setDefaultNear(surf666Default);

  const root = new THREE.Group();
  root.userData.isBspModel = true;
  const scene = new THREE.Scene();
  scene.add(root);

  // 100x100x100 墙体：中心在 z=-114，正面在 z=-64（模拟脚下 64 HU 地面）
  const wallGeom = new THREE.BoxGeometry(100, 100, 100);
  const mesh = new THREE.Mesh(wallGeom, new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0, -114);
  mesh.updateMatrixWorld(true);
  root.add(mesh);

  const cam = new THREE.PerspectiveCamera(75, 16 / 9, surf666Default, 3272000);
  const k75 = Math.sqrt(1 + Math.tan((75 * Math.PI) / 360) ** 2 * (1 + (16 / 9) ** 2));

  // 2. 站在地面 64 HU 上且 ratio=0：near 保持 8 HU（不降到 0.05，彻底消除远距 Z-Fighting）
  ctrl.update(cam, scene, 0, 0, 0, { roots: [root] });
  assert.ok(Math.abs(cam.near - 8) < 1e-6, `64 HU 地面不应把 near 压低，实际 ${cam.near}`);
  assert.ok(cam.near * k75 < 64, '四角点距离必须小于 64 HU');

  // 3. 贴墙 16 HU（正前方墙面 z=-16，FOV=90° 16:9）：near 必须自动缩到 < 16 / k
  mesh.position.set(0, 0, -66);
  mesh.updateMatrixWorld(true);
  cam.fov = 90;
  cam.updateProjectionMatrix();
  const k90 = Math.sqrt(1 + Math.tan((90 * Math.PI) / 360) ** 2 * (1 + (16 / 9) ** 2));
  ctrl.update(cam, scene, 0, 0, 0, { roots: [root] });
  assert.ok(cam.near * k90 < 16, `16 HU 贴墙四角点必须 < 16：near=${cam.near}, k=${k90}`);
  assert.ok(cam.near > 5 && cam.near < 7, `16 HU 贴墙 near 应在 (5, 7) 高精度区间，实际 ${cam.near}`);

  // 4. 贴顶/极近 8 HU（FOV=110° 16:9）：FOV 变大也必须打破滞回并继续收缩
  mesh.position.set(0, 0, -58);
  mesh.updateMatrixWorld(true);
  cam.fov = 110;
  cam.updateProjectionMatrix();
  const k110 = Math.sqrt(1 + Math.tan((110 * Math.PI) / 360) ** 2 * (1 + (16 / 9) ** 2));
  ctrl.update(cam, scene, 0, 0, 0, { roots: [root] });
  assert.ok(cam.near * k110 < 8, `8 HU 贴顶 110° FOV 四角点必须 < 8：near=${cam.near}, k=${k110}`);

  // 5. 纯旋转 90°（位置/FOV 不变）：复用滞回缓存，不触发重扫
  const nearBeforeRot = cam.near;
  mesh.position.set(0, 0, -5000);
  mesh.updateMatrixWorld(true);
  cam.rotation.y = Math.PI / 2;
  cam.updateMatrixWorld(true);
  ctrl.update(cam, scene, 0, 0, 0, { roots: [root] });
  assert.ok(Math.abs(cam.near - nearBeforeRot) < 1e-6, '纯旋转不应重扫近平面，应复用滞回结果');

  // 6. 移开后恢复 defaultNear=8
  ctrl.update(cam, scene, 5, 0, 0, { roots: [root] });
  assert.ok(Math.abs(cam.near - 8) < 1e-6, `移开后应恢复 defaultNear=8，实际 ${cam.near}`);

  // 7. 动态门/移动实体靠近（不换 geometry.uuid）+ invalidateCache()：__nearBox 必须跟随刷新
  mesh.position.set(5, 0, -64); // 距 (5, 0, 0) 正面 14 HU
  mesh.updateMatrixWorld(true);
  ctrl.invalidateCache();
  ctrl.update(cam, scene, 5, 0, 0, { roots: [root] });
  assert.ok(cam.near * k110 < 14, `动态实体移动后应刷新 AABB 并收缩 near：实际 ${cam.near}`);

  // 8. 旋转 45° 的实体斜墙：必须仍走精确球距离路径（不退回六向射线漏 45° 墙）
  mesh.rotation.y = Math.PI / 4;
  mesh.position.set(5, 0, -82); // 旋转后最近顶点/面约 82 - 50*sqrt(2) ≈ 11.29 HU
  mesh.updateMatrixWorld(true);
  ctrl.invalidateCache();
  ctrl.update(cam, scene, 5, 0, 0, { roots: [root] });
  assert.ok(cam.near * k110 < 12, `旋转 45° 斜墙应精确探测并收缩 near：实际 ${cam.near}`);
  assert.equal(globalThis.__vbspNearStats?.tris > 0, true, '旋转 mesh 应走精确三角形距离而非射线回退');

  // 9. 隐藏父组（parent.visible = false）：应跳过整棵子树，不误缩 near
  const dynGroup = new THREE.Group();
  dynGroup.visible = false;
  root.remove(mesh);
  dynGroup.add(mesh);
  root.add(dynGroup);
  ctrl.invalidateCache();
  ctrl.update(cam, scene, 5, 0, 0, { roots: [root] });
  assert.ok(Math.abs(cam.near - 8) < 1e-6, `隐藏父组不应参与探测，应恢复 8，实际 ${cam.near}`);
});

test('BloomPostFx 复用帧跳过 6 趟冗余模糊，无可见光效时零开销全跳过', () => {
  const renderCalls = [];
  let drawW = 800;
  let drawH = 600;
  const mockRenderer = {
    capabilities: { isWebGL2: true },
    autoClear: true,
    getDrawingBufferSize(target) {
      return target.set(drawW, drawH);
    },
    setRenderTarget() {},
    clear() {},
    render(scene) {
      renderCalls.push(scene);
    },
  };
  const fx = new BloomPostFx(mockRenderer);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(75, 4 / 3, 1, 1000);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);

  const glowMesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }),
  );
  glowMesh.position.set(0, 0, -20);
  glowMesh.updateMatrixWorld(true);
  scene.add(glowMesh);

  globalThis.__vbspBloomBlurStats = undefined;

  // 0. 无光效 / 隐藏 / 视锥外：renderGlow 与 overlay 均 0 次 render
  fx.ensureSize();
  renderCalls.length = 0;
  fx.renderGlow(scene, cam, []);
  fx.overlay();
  assert.equal(renderCalls.length, 0, `空光效列表应 0 次 render，实际 ${renderCalls.length}`);

  glowMesh.visible = false;
  fx.renderGlow(scene, cam, [glowMesh]);
  fx.overlay();
  assert.equal(renderCalls.length, 0, '隐藏光效不应触发 render');

  glowMesh.visible = true;
  glowMesh.position.set(0, 0, 500); // 相机背后，视锥外
  glowMesh.updateMatrixWorld(true);
  fx.renderGlow(scene, cam, [glowMesh]);
  fx.overlay();
  assert.equal(renderCalls.length, 0, '视锥外光效不应触发 render');
  assert.equal(globalThis.__vbspBloomBlurStats?.emptySkips, 3);

  // 回到视野内：第 1 帧立即重画 glowTarget（2 趟）+ overlay 完整 7 趟
  glowMesh.position.set(0, 0, -20);
  glowMesh.updateMatrixWorld(true);
  fx.ensureSize();
  renderCalls.length = 0;
  fx.renderGlow(scene, cam, [glowMesh]);
  const glowCalls1 = renderCalls.length;
  renderCalls.length = 0;
  fx.overlay();
  const overlayCalls1 = renderCalls.length;
  assert.equal(glowCalls1, 2, `第 1 帧 renderGlow 应有 2 趟（深度+光效），实际 ${glowCalls1}`);
  assert.equal(overlayCalls1, 7, `第 1 帧 overlay 应运行完整 7 趟，实际 ${overlayCalls1}`);

  // 第 2 帧：glowTick=1 被隔帧跳过（0 趟），overlay 只跑 1 趟最终叠加（省掉 6 趟模糊）
  fx.ensureSize();
  renderCalls.length = 0;
  fx.renderGlow(scene, cam, [glowMesh]);
  const glowCalls2 = renderCalls.length;
  renderCalls.length = 0;
  fx.overlay();
  const overlayCalls2 = renderCalls.length;
  assert.equal(glowCalls2, 0, `第 2 帧 renderGlow 应被隔帧跳过，实际 ${glowCalls2}`);
  assert.equal(overlayCalls2, 1, `第 2 帧 overlay 应只跑 1 趟最终叠加，实际 ${overlayCalls2}`);
  assert.equal(globalThis.__vbspBloomBlurStats?.blurRuns, 1);
  assert.equal(globalThis.__vbspBloomBlurStats?.overlayRuns, 2);

  // 分辨率变化：ensureSize 重置 glowTick 且置 blurDirty=true，下一帧完整重画并模糊
  drawW = 1280;
  drawH = 720;
  fx.ensureSize();
  renderCalls.length = 0;
  fx.renderGlow(scene, cam, [glowMesh]);
  fx.overlay();
  assert.equal(renderCalls.length, 9, `改尺寸后应完整重画并模糊（2+7=9 趟），实际 ${renderCalls.length}`);
  fx.dispose();
});

test('VisibilityController 静态块缓存世界包围盒且动态位移后立即刷新', () => {
  const vis = new VisibilityController();
  const geom = new THREE.BoxGeometry(10, 10, 10);
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
  mesh.position.set(100, 0, 0);
  mesh.updateMatrixWorld(true);
  const root = new THREE.Group();
  root.add(mesh);
  vis.collect(root);
  vis.setCullDistance(500, 0);

  const cam = { position: new THREE.Vector3(0, 0, 0) };
  vis.update(cam, null);
  assert.equal(vis.items[0].center.x, 100);
  assert.equal(vis.items[0].box.min.x, 95);

  // 静态块第 2 帧：matrixWorld 未变，走缓存分支；把 center 临时改成哨兵值验证不会重复乘法覆盖
  vis.items[0].center.x = 12345;
  vis.update(cam, null);
  assert.equal(vis.items[0].center.x, 12345, '静态块 matrixWorld 未变时应命中世界包围缓存');

  // 动态块移动后：matrixWorld 变化，必须立即失效缓存并刷新 center/box
  mesh.position.set(250, 0, 0);
  mesh.updateMatrixWorld(true);
  vis.update(cam, null);
  assert.equal(vis.items[0].center.x, 250, '动态块位移后必须刷新 center');
  assert.equal(vis.items[0].box.min.x, 245, '动态块位移后必须刷新 box');
});

test('applyObliqueWaterClip 将镜像近平面精确对齐水面，剔除水下几何', () => {
  const vcam = new THREE.PerspectiveCamera(75, 16 / 9, 1, 5000);
  vcam.position.set(0, -20, 0);
  vcam.lookAt(0, 0, -50);
  vcam.updateMatrixWorld(true);
  vcam.updateProjectionMatrix();

  const ok = applyObliqueWaterClip(vcam, 0, 20, 0);
  assert.equal(ok, true, '水面上方镜像相机应成功应用斜裁剪');

  // 水面上的点 (0, 0, -50) 应落在近平面 z_ndc ≈ -1.0；水下 (-5) 应 < -1.0 被裁剪；水上 (+20) 应在 (-1, 1) 内保留
  const projZ = (p) => p.clone().applyMatrix4(vcam.matrixWorldInverse).applyMatrix4(vcam.projectionMatrix).z;
  const zOnPlane = projZ(new THREE.Vector3(0, 0, -50));
  const zUnderwater = projZ(new THREE.Vector3(0, -5, -50));
  const zAboveWater = projZ(new THREE.Vector3(0, 20, -50));
  assert.ok(Math.abs(zOnPlane - (-1)) < 1e-4, `水面上的点应位于近平面 z=-1，实际 ${zOnPlane}`);
  assert.ok(zUnderwater < -1, `水下点应被近平面裁剪 (z<-1)，实际 ${zUnderwater}`);
  assert.ok(zAboveWater > -1 && zAboveWater < 1, `水上点应保留在视锥内，实际 ${zAboveWater}`);

  // 相机几乎贴着水面时安全退回 false
  const vcamNear = new THREE.PerspectiveCamera(75, 16 / 9, 1, 5000);
  vcamNear.position.set(0, -0.1, 0);
  vcamNear.lookAt(0, 0, -50);
  vcamNear.updateMatrixWorld(true);
  assert.equal(applyObliqueWaterClip(vcamNear, 0, 0.1, 0.25), false);
});

test('TransparentSorter 共面跳过排序且非共面走局部空间扁平重心排序', () => {
  const sorter = new TransparentSorter();

  // 1. 共面水平透明面（y=0 两三角）：相机移动不触发归并排序或 index 重传
  const flatGeom = new THREE.BufferGeometry();
  flatGeom.setAttribute('position', new THREE.Float32BufferAttribute([
    -10, 0, -10,  10, 0, -10,  10, 0, 10,
    -10, 0, -10,  10, 0, 10,  -10, 0, 10,
  ], 3));
  flatGeom.setIndex([0, 1, 2, 3, 4, 5]);
  const flatMesh = new THREE.Mesh(flatGeom, new THREE.MeshBasicMaterial({ transparent: true }));
  flatMesh.updateMatrixWorld(true);

  // 2. 非共面 3D 透明体：两块重叠玻璃板在 z=0 与 z=-20
  const glassGeom = new THREE.BufferGeometry();
  glassGeom.setAttribute('position', new THREE.Float32BufferAttribute([
    -5, -5, 0,   5, -5, 0,   0, 5, 0,
    -5, -5, -20, 5, -5, -20, 0, 5, -20,
  ], 3));
  glassGeom.setIndex([0, 1, 2, 3, 4, 5]);
  const glassMesh = new THREE.Mesh(glassGeom, new THREE.MeshBasicMaterial({ transparent: true }));
  glassMesh.updateMatrixWorld(true);

  const root = new THREE.Group();
  root.add(flatMesh, glassMesh);
  sorter.collect(root);

  const cam = new THREE.PerspectiveCamera(75, 1, 1, 1000);
  cam.position.set(0, 5, 50);
  sorter.update(cam, null, -1);
  const flatVer0 = flatGeom.index.version;
  // 从 +z 看：远端 z=-20（顶点 3,4,5）必须先画，近端 z=0（0,1,2）后画
  assert.deepEqual(Array.from(glassGeom.index.array), [3, 4, 5, 0, 1, 2]);

  // 相机移到 -z（-50）：共面块 index.version 不变（零排序/零上传），玻璃块反转为 [0,1,2, 3,4,5]
  cam.position.set(0, 5, -50);
  sorter.update(cam, null, -1);
  assert.equal(flatGeom.index.version, flatVer0, '共面透明块移动相机不应重传 index');
  assert.deepEqual(Array.from(glassGeom.index.array), [0, 1, 2, 3, 4, 5]);
});

test('SpriteGlows 与 Beams 静止视角零重传且全隐时置 visible=false', () => {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 64,
        height: 64,
        getContext() {
          return {
            fillStyle: '',
            createRadialGradient() {
              return { addColorStop() {} };
            },
            createImageData(w, h) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData() {},
            fillRect() {},
          };
        },
      };
    },
  };
  try {
    const cam = new THREE.PerspectiveCamera(75, 1, 1, 1000);
    cam.position.set(0, 0, 50);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);

    const sprites = new SpriteGlows([{
      entityIndex: 1,
      startVisible: true,
      origin: [0, 0, 0],
      size: 16,
      color: new THREE.Color(1, 1, 1),
      model: 'sprites/glow01.vmt',
    }]);
    const spriteMesh = sprites.root.children[0];
    const spritePosAttr = spriteMesh.geometry.getAttribute('position');

    sprites.update(cam, null);
    assert.equal(spriteMesh.visible, true);
    const sv1 = spritePosAttr.version;

    // 相机纯平移不旋转：基向量不变，零顶点重写/零 GPU 上传
    cam.position.set(10, 5, 50);
    cam.updateMatrixWorld(true);
    sprites.update(cam, null);
    assert.equal(spritePosAttr.version, sv1, 'SpriteGlows 基向量未变时不应重传顶点');

    // 相机旋转：基向量变化，更新顶点
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    sprites.update(cam, null);
    assert.ok(spritePosAttr.version > sv1, 'SpriteGlows 旋转后应更新顶点');

    // 全部隐藏后：mesh.visible=false 且后续帧零上传
    sprites.setEntityVisible(1, false);
    sprites.update(cam, null);
    assert.equal(spriteMesh.visible, false, '全隐后 SpriteGlows mesh 应置 visible=false');
    const svHidden = spritePosAttr.version;
    cam.rotation.y += 0.5;
    cam.updateMatrixWorld(true);
    sprites.update(cam, null);
    assert.equal(spritePosAttr.version, svHidden, '全隐后旋转相机不应上传顶点');

    // Beams：PVS 不可见时置 visible=false 且零上传；可见且视角未变时零上传
    const beams = new Beams([{
      start: new THREE.Vector3(0, 0, 0),
      end: new THREE.Vector3(0, 100, 0),
      width: 4,
      color: new THREE.Color(1, 0.5, 0),
    }]);
    const beamMesh = beams.root.children[0];
    const beamPosAttr = beamMesh.geometry.getAttribute('position');

    let pvsVisible = true;
    const pvs = {
      getClusterAt: () => 1,
      isVisible: () => pvsVisible,
    };
    beams.update(cam, pvs);
    assert.equal(beamMesh.visible, true);
    const bv1 = beamPosAttr.version;
    beams.update(cam, pvs);
    assert.equal(beamPosAttr.version, bv1, 'Beams 视角未变时不应重传顶点');

    pvsVisible = false;
    beams.update(cam, pvs);
    assert.equal(beamMesh.visible, false, 'Beams 全被 PVS 剔除时应置 visible=false');
    const bvHidden = beamPosAttr.version;
    beams.update(cam, pvs);
    assert.equal(beamPosAttr.version, bvHidden, 'Beams 全隐后不应重传顶点');

    sprites.dispose();
    beams.dispose();
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('applyClusterIndex 无翻位跳过 GPU 上传、局部切片上传且跳过 LOD_FAR 块', () => {
  // 2 个三角形分别在 cluster 10 与 cluster 20，同一单 group 合并块（增量路径）
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,   10, 0, 0,   0, 10, 0,
    50, 0, 0,  60, 0, 0,   50, 10, 0,
  ], 3));
  geom.setAttribute('_vbsp_face', new THREE.Int32BufferAttribute([0, 0, 0, 1, 1, 1], 1));
  geom.setIndex([0, 1, 2, 3, 4, 5]);
  geom.addGroup(0, 6, 0);
  const mesh = new THREE.Mesh(geom, [new THREE.MeshBasicMaterial()]);
  mesh.userData.lodLevel = 0;
  mesh.updateMatrixWorld(true);

  const row = new Uint8Array(32);
  row[10] = 1;
  row[20] = 1;
  const pvs = {
    getFaceCluster: (f) => (f === 0 ? 10 : 20),
    isVisible: (c) => row[c] === 1,
    visibleRow: () => row,
  };

  const items = [{ mesh, clusterIds: [10, 20] }];
  const prep = prepareClusterIndex(items, pvs, 2);
  assert.equal(prep.prepared, 1, `prepareClusterIndex failed: ${JSON.stringify(prep)}`);

  // 第 1 次（cluster 1）：全量建出，visTris=2
  applyClusterIndex(items, pvs, 1);
  const attr = mesh.geometry.getAttribute('index') || mesh.geometry.index;
  const ver1 = attr.version;
  assert.equal(mesh.geometry.drawRange.count, 6);

  // 第 2 次（换到 cluster 2，但一个无关 cluster 30 翻位，本块 0 个三角翻位）：
  // 必须跳过 GPU 上传（attr.version 不变）！
  row[30] = 1;
  applyClusterIndex(items, pvs, 2);
  assert.equal(attr.version, ver1, '本块无三角翻位时不应触发 GPU index 上传');

  // 第 3 次（换到 cluster 3，cluster 10 隐藏）：仅翻位 1 个三角，上传范围必须收窄而不是整块
  row[10] = 0;
  applyClusterIndex(items, pvs, 3);
  assert.equal(mesh.geometry.drawRange.count, 3);
  assert.ok(attr.version > ver1, '有置换翻位时应触发上传');
  assert.ok(attr.updateRanges.length === 1 && attr.updateRanges[0].count === 3, `应只上传 3 索引切片，实际 ${JSON.stringify(attr.updateRanges)}`);

  // 第 4 次：LOD_FAR（lodLevel=2）块直接跳过，不改 lastCluster 也不上传
  mesh.userData.lodLevel = 2;
  row[10] = 1;
  const verBeforeFar = attr.version;
  applyClusterIndex(items, pvs, 4);
  assert.equal(attr.version, verBeforeFar, 'LOD_FAR 块不应在场外重建或上传');
});

test('PlaneInspector 仅对可见网格做射线包围盒前向排序，跳过隐藏块', () => {
  const inspector = new PlaneInspector();
  const root = new THREE.Group();

  // 前方 z=-20 放一个隐藏组内的块（模拟 PVS 隐藏块）
  const hiddenGroup = new THREE.Group();
  hiddenGroup.visible = false;
  const frontMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 2), new THREE.MeshBasicMaterial());
  frontMesh.position.set(0, 0, -20);
  frontMesh.name = 'hidden-front';
  frontMesh.updateMatrixWorld(true);
  hiddenGroup.add(frontMesh);

  // 后方 z=-50 放一个可见块
  const backMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 2), new THREE.MeshBasicMaterial());
  backMesh.position.set(0, 0, -50);
  backMesh.name = 'visible-back';
  backMesh.updateMatrixWorld(true);

  root.add(hiddenGroup, backMesh);
  root.updateMatrixWorld(true);

  const hit = inspector.cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), root, [], [], [], 1000);
  assert.ok(hit !== null, '应命中后方可见块');
  assert.equal(hit.meshName, 'visible-back', `应跳过隐藏前块并命中 visible-back，实际 ${hit.meshName}`);
});

test('EntitySystem 活跃 think 集合按序号触发且支持 useEntities / O(1) getEntity', () => {
  const { host } = createRecordingHost();
  const sys = new EntitySystem({ host });
  sys.load({
    entities_text: [
      '{\n"classname" "func_button"\n"targetname" "btn_a"\n}',
      '{\n"classname" "info_target"\n"targetname" "tgt_b"\n}',
      '{\n"classname" "info_target"\n"targetname" "tgt_c"\n}',
    ].join('\n'),
    volumes: [
      { index: 0, origin: [0, 0, 0], brushes: [{ mins: [-10, -10, -10], maxs: [10, 10, 10], planes: [] }] },
    ],
  });

  assert.equal(sys.useEntities.length, 1);
  assert.equal(sys.useEntities[0].index, 0);
  assert.equal(sys.getEntity(0)?.targetname, 'btn_a');
  assert.equal(sys.getEntity(2)?.targetname, 'tgt_c');
  assert.equal(sys.getEntity(999), undefined);

  const picked = sys.pickUseFromView([0, 0, 30], [0, 0, -1], 80);
  assert.equal(picked?.index, 0);

  const order = [];
  const e2 = sys.getEntity(2);
  const e1 = sys.getEntity(1);
  e2.setThink((ent) => order.push(ent.index), 0.05);
  e1.setThink((ent) => order.push(ent.index), 0.05);
  sys.frame(0.02);
  assert.deepEqual(order, [], '未到 nextThink 不应触发');
  e2.clearThink();
  sys.frame(0.04);
  assert.deepEqual(order, [1], 'clearThink 后不应再触发 e2，仅触发 e1');

  e2.setThink((ent) => order.push(ent.index), 0.01);
  e1.setThink((ent) => order.push(ent.index), 0.01);
  sys.frame(0.02);
  assert.deepEqual(order, [1, 1, 2], '同 tick 多个活跃 think 必须按 entity.index 升序执行');
  sys.dispose();
});

test('EntityGameplay update 复用传入 state 且预索引同步 trigger_teleport', () => {
  let stateReads = 0;
  const teleportCalls = [];
  const phys = {
    set_teleport_enabled: (idx, enabled) => teleportCalls.push([idx, enabled]),
  };
  const gp = new EntityGameplay({
    getPlayerState: () => {
      stateReads++;
      return { posX: 0, posY: 0, posZ: 0, onGround: true };
    },
    getPhys: () => phys,
  });

  gp.load(JSON.stringify({
    entities_text: '{\n"classname" "trigger_teleport"\n"targetname" "tp1"\n"StartDisabled" "1"\n}\n{\n"classname" "info_target"\n"targetname" "dummy"\n}',
    volumes: [],
  }));

  const readsAfterLoad = stateReads;
  gp.update(1 / 1000, { posX: 10, posY: 20, posZ: 30, velX: 0, velY: 0, velZ: 0, onGround: true });
  assert.equal(stateReads, readsAfterLoad, '传入 rawState 时不应重复回调 getPlayerState()');
  assert.deepEqual(teleportCalls, [[0, false]], 'StartDisabled=1 的 trigger_teleport 应同步为 false');

  gp.system.getEntity(0).disabled = false;
  gp.update(1 / 1000, { posX: 10, posY: 20, posZ: 30, velX: 0, velY: 0, velZ: 0, onGround: true });
  assert.deepEqual(teleportCalls, [[0, false], [0, true]], 'Enable 后应同步为 true');
  gp.dispose();
});

test('water.ts 帧间冷却门控避免折射与多层镜面连续三帧扎堆', () => {
  resetWaterShaders();
  const scene = new THREE.Scene();
  for (const y of [0, 50]) {
    const mat = new THREE.MeshBasicMaterial({ name: `water_${y}` });
    mat.userData.vbsp_water = { fog: [0.1, 0.2, 0.3], aboveWater: true };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(200, 2, 200), mat);
    mesh.position.set(0, y, -200);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
  }
  const injected = applyWaterShaders(scene);
  assert.equal(injected, 2);

  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 1, 5000);
  camera.position.set(0, 120, 100);
  camera.lookAt(0, 25, -200);
  camera.updateMatrixWorld(true);

  let renderCallsThisFrame = 0;
  const mockRenderer = {
    getDrawingBufferSize: (v) => v.set(640, 360),
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getClearColor: (c) => c.set(0x000000),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    render: () => { renderCallsThisFrame++; },
  };

  const perFrameRenders = [];
  for (let f = 0; f < 6; f++) {
    camera.position.x = f * 10;
    camera.updateMatrixWorld(true);
    renderCallsThisFrame = 0;
    renderWaterFramePasses(mockRenderer, scene, camera);
    perFrameRenders.push(renderCallsThisFrame);
  }

  for (let f = 1; f < perFrameRenders.length; f++) {
    assert.ok(
      !(perFrameRenders[f - 1] > 0 && perFrameRenders[f] > 0),
      `不应连续两帧都触发整场景水面 RT 渲染，实际序列: ${JSON.stringify(perFrameRenders)}`,
    );
  }
  resetWaterShaders();
});

test('PlaneInspector.cast 无分配标量 rayAabbTmin / castTriggerAABB 保持精确命中与未命中', () => {
  const inspector = new PlaneInspector();
  const solid = {
    min: { x: -10, y: -10, z: -60 },
    max: { x: 10, y: 10, z: -40 },
    planes: [
      { normal: { x: 0, y: 0, z: 1 }, dist: -40 },
      { normal: { x: 0, y: 0, z: -1 }, dist: 60 },
      { normal: { x: 1, y: 0, z: 0 }, dist: 10 },
      { normal: { x: -1, y: 0, z: 0 }, dist: 10 },
      { normal: { x: 0, y: 1, z: 0 }, dist: 10 },
      { normal: { x: 0, y: -1, z: 0 }, dist: 10 },
    ],
  };
  const trigger = {
    mins: { x: -5, y: -5, z: -30 },
    maxs: { x: 5, y: 5, z: -20 },
    target: 'dest1',
    destIndex: 3,
    classname: 'trigger_teleport',
    spawnflags: 0,
    startDisabled: false,
  };

  const hitTrig = inspector.cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), null, [solid], [], [trigger], 1000);
  assert.equal(hitTrig?.type, 'trigger');
  assert.equal(hitTrig?.distance, 20);
  assert.deepEqual(hitTrig?.normal, [0, 0, 1]);

  const hitSolid = inspector.cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), null, [solid], [], [], 1000);
  assert.equal(hitSolid?.type, 'solid');
  assert.equal(hitSolid?.distance, 40);

  const miss = inspector.cast(new THREE.Vector3(100, 0, 0), new THREE.Vector3(0, 0, -1), null, [solid], [], [trigger], 1000);
  assert.equal(miss, null);
});

function buildSyntheticVdxt(width, height, format, mipCount) {
  const blockBytes = format === 1 || format === 2 ? 8 : 16;
  const mipSizes = [];
  let total = VDXT_HEADER_BYTES;
  for (let m = 0; m < mipCount; m++) {
    const mw = Math.max(1, width >> m);
    const mh = Math.max(1, height >> m);
    const sz = ((mw + 3) >> 2) * ((mh + 3) >> 2) * blockBytes;
    mipSizes.push(sz);
    total += sz;
  }
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint8(0, 0x56); // V
  view.setUint8(1, 0x44); // D
  view.setUint8(2, 0x58); // X
  view.setUint8(3, 0x54); // T
  view.setUint16(4, width, true);
  view.setUint16(6, height, true);
  view.setUint8(8, format);
  view.setUint8(9, mipCount);
  let cursor = VDXT_HEADER_BYTES;
  const u8 = new Uint8Array(buf);
  for (let m = 0; m < mipCount; m++) {
    u8.fill((m + 1) & 0xff, cursor, cursor + mipSizes[m]);
    cursor += mipSizes[m];
  }
  return buf;
}

test('dxt-texture: parseVdxtBuffer 校验头部、mip 切片与独立拷贝', () => {
  const ab = buildSyntheticVdxt(8, 8, 5, 4);
  const parsed = parseVdxtBuffer(ab);
  assert.ok(parsed);
  assert.equal(parsed.width, 8);
  assert.equal(parsed.height, 8);
  assert.equal(parsed.format, 5);
  assert.equal(parsed.mipmaps.length, 4);
  assert.equal(parsed.mipmaps[0].data.length, 4 * 16);
  assert.equal(parsed.mipmaps[3].width, 1);
  assert.equal(parsed.mipmaps[3].data.length, 16);
  // 拷贝与原 ArrayBuffer 隔离，不钉住整份 GLB 内存
  new Uint8Array(ab).fill(0);
  assert.equal(parsed.mipmaps[0].data[0], 1);

  assert.equal(parseVdxtBuffer(new ArrayBuffer(8)), null);
});

test('dxt-texture: createDxtTexture 支持 S3TC+SRGB 直通与缺扩展 CPU 回退', () => {
  const abMulti = buildSyntheticVdxt(8, 8, 1, 4);
  const parsedMulti = parseVdxtBuffer(abMulti);
  const { texture: compMulti, isCompressed: c1 } = createDxtTexture(parsedMulti, { s3tc: true, s3tcSrgb: true });
  assert.equal(c1, true);
  assert.equal(compMulti.isCompressedTexture, true);
  assert.equal(compMulti.format, THREE.RGB_S3TC_DXT1_Format);
  assert.equal(compMulti.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(compMulti.wrapS, THREE.RepeatWrapping);
  assert.equal(compMulti.flipY, false);
  assert.equal(compMulti.generateMipmaps, false);

  const abSingle = buildSyntheticVdxt(8, 8, 3, 1);
  const parsedSingle = parseVdxtBuffer(abSingle);
  const { texture: compSingle } = createDxtTexture(parsedSingle, { s3tc: true, s3tcSrgb: true });
  assert.equal(compSingle.minFilter, THREE.LinearFilter, '单层 mip 必须关 mipmap 采样以免 WebGL2 黑纹理');

  // 仅有 s3tc 但缺 s3tcSrgb 时必须回退 CPU 解码
  const { texture: fbTex, isCompressed: cFb } = createDxtTexture(parsedMulti, { s3tc: true, s3tcSrgb: false });
  assert.equal(cFb, false);
  assert.equal(fbTex.isDataTexture, true);

  // BC1 全白块 (c0=0xFFFF, c1=0x0000, sel=0) 与 BC3 alpha=0 检验
  const bc1 = new Uint8Array(VDXT_HEADER_BYTES + 8);
  bc1.set([0x56, 0x44, 0x58, 0x54, 4, 0, 4, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
  bc1[VDXT_HEADER_BYTES] = 0xff;
  bc1[VDXT_HEADER_BYTES + 1] = 0xff;
  const rgba = decodeDxtMip0ToRgba(parseVdxtBuffer(bc1.buffer));
  assert.equal(rgba.length, 4 * 4 * 4);
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [255, 255, 255, 255]);
});

test('texture-quality: CompressedTexture 切换 mini 与还原 original 不破坏原纹理', async () => {
  const ab = buildSyntheticVdxt(4, 4, 1, 1);
  const { texture: origComp } = createDxtTexture(parseVdxtBuffer(ab), { s3tc: true, s3tcSrgb: true });
  origComp.name = 'brick/wall01';
  const mat = new THREE.MeshBasicMaterial({ map: origComp });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const origImages = new Map();
  const prevCreateBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
  try {
    const manifest = { 'brick/wall01': 'M_TEST' };
    const deps = { decode: () => new Uint8Array([137, 80, 78, 71]) };
    const rMini = await applyTextureQuality(mesh, manifest, 'mini', origImages, deps);
    assert.equal(rMini.matched, 1);
    assert.notEqual(mat.map, origComp);
    assert.equal(mat.map.isCompressedTexture, undefined);
    assert.equal(origImages.get(mat.map), origComp);

    const rOrig = await applyTextureQuality(mesh, manifest, 'original', origImages, deps);
    assert.equal(rOrig.mapCount, 1);
    assert.equal(mat.map, origComp);
    assert.equal(origImages.size, 0);
  } finally {
    globalThis.createImageBitmap = prevCreateBitmap;
  }
});

test('instanced-props: 二进制 Float32Array 展开、天空/空间分桶、透明回退、可见性与近平面探测', async () => {
  const root = new THREE.Group();
  const geom = new THREE.BoxGeometry(10, 10, 10);
  const opaqueMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const transMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });

  const tplOpaque = new THREE.Mesh(geom, opaqueMat);
  tplOpaque.name = 'prop_pillar';
  // 3 个实例：2 个在同一空间桶 (100,0,0) & (200,0,0)，1 个在天空桶 (9000,0,0)
  const stride = INST_PROP_STRIDE_FLOATS;
  const f32 = new Float32Array(3 * stride);
  const writeInst = (idx, pos, hasCube, cubeVal) => {
    const b = idx * stride;
    f32[b] = pos[0]; f32[b + 1] = pos[1]; f32[b + 2] = pos[2];
    f32[b + 3] = 0; f32[b + 4] = 0; f32[b + 5] = 0; f32[b + 6] = 1;
    f32[b + 7] = 1; f32[b + 8] = 1; f32[b + 9] = 1;
    f32[b + 10] = hasCube ? 1 : 0;
    if (hasCube) f32.fill(cubeVal, b + 11, b + 29);
  };
  writeInst(0, [500, 0, 0], true, 0.4);
  writeInst(1, [600, 0, 0], true, 0.8);
  writeInst(2, [9000, 0, 0], false, 0);
  tplOpaque.userData.vbsp_instanced_props = { bufferView: 0, count: 3, strideFloats: stride, hasAnyCube: true };
  root.add(tplOpaque);

  const tplTrans = new THREE.Mesh(geom, transMat);
  tplTrans.userData.vbsp_instanced_props = { bufferView: 0, count: 3, strideFloats: stride, hasAnyCube: false };
  root.add(tplTrans);

  const mockGltf = {
    parser: {
      getDependency: async (_kind, idx) => (idx === 0 ? f32.buffer : null),
    },
  };
  const mockPvs = {
    enabled: true,
    currentClusterId: 1,
    update: () => {},
    isVisible: (c) => c === 1,
    getClusterAt: (p) => (p.x > 8000 ? 99 : 1),
  };

  const stats = await expandInstancedProps(root, mockGltf, { pvs: mockPvs, skyCluster: 99 });
  assert.equal(stats.templates, 2);
  assert.equal(stats.instancedMeshes, 1, '主世界 2 个不透明实例应合并为 1 个 InstancedMesh');
  assert.equal(stats.singleMeshes, 1, '天空区 1 个实例应单独成 Mesh');
  assert.equal(stats.uninstancedTranslucent, 3, '透明 prop 必须回退为独立 Mesh 保住排序');

  const inst = root.children.find((c) => c.isInstancedMesh);
  assert.ok(inst);
  assert.equal(inst.count, 2);
  assert.ok(inst.userData.__vbspInstancedAmbCubes instanceof Float32Array);
  assert.equal(inst.userData.__vbspInstancedAmbCubes.length, 36);
  assert.deepEqual(inst.userData.splitClusters, [1]);

  // VisibilityController 必须按 InstancedMesh 包围球/盒判定而非局部 (0,0,0) 几何
  root.updateMatrixWorld(true);
  const vis = new VisibilityController();
  vis.enablePvs = false;
  vis.collect(root, null);
  vis.setCullDistance(1000, 100);
  const resNear = vis.update({ position: new THREE.Vector3(500, 0, 0) }, null);
  assert.ok(resNear.visible >= 1);
  assert.equal(inst.visible, true);

  // NearPlaneController 必须能探测到远离原点的 InstancedMesh 实例表面
  const near = new NearPlaneController();
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 10000);
  cam.position.set(500, 0, 10); // 距 (500,0,0) 的 10x10x10 盒子表面 (+5) 只有 5 HU
  cam.updateMatrixWorld(true);
  near.setDefaultNear(8);
  near.update(cam, root, 500, 0, 10, { roots: [root] });
  assert.ok(cam.near < 4, `预期 InstancedMesh 触发 near 收缩 (<4), 实际 cam.near=${cam.near}`);

  // disposeObject 释放 __vbspAmbCubeTex 与 InstancedMesh
  let disposedTex = false;
  inst.material = new THREE.MeshBasicMaterial();
  inst.material.userData.__vbspAmbCubeTex = { isTexture: true, dispose: () => { disposedTex = true; } };
  disposeObject(root);
  assert.equal(disposedTex, true);
});

test('pvs-manager & visibility-controller: visibleRow 缓存、visibleRowVersion 失效与 __vbspPvsCullAll 切换', () => {
  // 2 个 cluster：cluster 0 仅可见 {0}，cluster 1 可见 {0, 1}
  const bits = new Uint8Array([0b01, 0b11]);
  const pvsData = {
    rootNode: 0,
    nodes: [{ normal: [1, 0, 0], dist: 0, children: [-1, -2] }],
    leaves: [
      { cluster: 1, mins: [0, -100, -100], maxs: [100, 100, 100], isSolid: false },
      { cluster: 0, mins: [-100, -100, -100], maxs: [0, 100, 100], isSolid: false },
    ],
    faceClusters: [],
    pvsBitsBase64: Buffer.from(bits).toString('base64'),
    clusterCount: 2,
    bytesPerRow: 1,
  };
  const pvs = new PvsManager(JSON.stringify(pvsData));
  assert.equal(pvs.update({ x: -10, y: 0, z: 0 }), true);
  const v0 = pvs.visibleRowVersion;
  const rowA = pvs.visibleRow();
  assert.ok(rowA);
  assert.equal(rowA[0], 1);
  assert.equal(rowA[1], 0);
  // 同一 cluster 再次调用必须复用同一缓冲且版本号不变
  const rowB = pvs.visibleRow();
  assert.equal(rowB, rowA);
  assert.equal(pvs.visibleRowVersion, v0);

  const root = new THREE.Group();
  const m0 = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial());
  m0.userData.splitClusters = [0];
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial());
  m1.userData.splitClusters = [1];
  root.add(m0, m1);
  root.updateMatrixWorld(true);

  const vis = new VisibilityController();
  vis.enablePvs = true;
  vis.collect(root, pvs);
  vis.setCullDistance(10000, 0);

  // 同 cluster 连跑两帧（第二帧命中 item 级 visibleRowVersion 缓存）
  vis.update({ position: new THREE.Vector3(-10, 0, 0) }, pvs);
  assert.equal(m0.visible, true);
  assert.equal(m1.visible, false);
  vis.update({ position: new THREE.Vector3(-12, 0, 0) }, pvs);
  assert.equal(m0.visible, true);
  assert.equal(m1.visible, false);

  // 切换到 cluster 1：version 递增，缓存失效，m1 变为可见
  vis.update({ position: new THREE.Vector3(10, 0, 0) }, pvs);
  assert.ok(pvs.visibleRowVersion > v0);
  assert.equal(m0.visible, true);
  assert.equal(m1.visible, true);

  // __vbspPvsCullAll 翻转时触发整剔与恢复
  const g = globalThis;
  const prevCullAll = g.__vbspPvsCullAll;
  try {
    g.__vbspPvsCullAll = true;
    vis.update({ position: new THREE.Vector3(10, 0, 0) }, pvs);
    assert.equal(m0.visible, false);
    assert.equal(m1.visible, false);
    g.__vbspPvsCullAll = false;
    vis.update({ position: new THREE.Vector3(10, 0, 0) }, pvs);
    assert.equal(m0.visible, true);
    assert.equal(m1.visible, true);
  } finally {
    g.__vbspPvsCullAll = prevCullAll;
  }
});

test('authority-calibrator: readAuthVersion 早退与 knownOnLadder=false 跳过 state() 并在离梯时补检', () => {
  let va = 1;
  let readAuthCalls = 0;
  let stateCalls = 0;
  let setVelCalls = 0;
  let syncCalls = 0;
  let onLadder = false;
  const phys = {
    state() {
      stateCalls++;
      return {
        posX: 0, posY: 0, posZ: 0, yaw: 0, pitch: 0,
        velX: 10, velY: 0, velZ: 0, onGround: false, onLadder, eyeHeight: 64,
      };
    },
    set_state() {},
    set_velocity() { setVelCalls++; },
  };
  const cal = new AuthorityCalibrator({
    readAuth: () => {
      readAuthCalls++;
      return {
        va,
        frame: {
          pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
          vel: { x: 10, y: 0, z: 0 }, onGround: false, eyeHeight: 64, timeMs: 100,
        },
      };
    },
    readAuthVersion: () => va,
    getPhys: () => phys,
    clearPendingInput: () => {},
    onSyncRenderState: () => { syncCalls++; },
  });

  // 首帧 va=1 读一次 readAuth
  cal.correctFromAuthority();
  assert.equal(readAuthCalls, 1);
  // 同一 va 连调 10 次不得再触发 readAuth
  for (let i = 0; i < 10; i++) cal.correctFromAuthority();
  assert.equal(readAuthCalls, 1);

  // knownOnLadder=false 时不调用 phys.state()
  stateCalls = 0;
  cal.calibrateVelocity(100, false);
  assert.equal(stateCalls, 0);
  assert.equal(setVelCalls, 1);

  // 上梯后（knownOnLadder=true）进入梯上分支并置 wasOnLadder
  onLadder = true;
  cal.calibrateVelocity(105, true);
  assert.equal(stateCalls, 1);

  // 刚离梯即使传 knownOnLadder=false，由于 wasOnLadder=true 仍必须读 state() 并触发 teleport 同步
  onLadder = false;
  cal.calibrateVelocity(110, false);
  assert.equal(stateCalls, 2);
  assert.equal(syncCalls, 1);
});

test('entity-system: stats() 结构缓存与删/增实体失效保持准确', () => {
  const { host } = createRecordingHost();
  const sys = new EntitySystem({ host });
  sys.load({
    entities_text: '{\n"classname" "worldspawn"\n}\n{\n"classname" "info_player_start"\n"targetname" "sp1"\n}',
    volumes: [],
  });
  const s1 = sys.stats();
  assert.equal(s1.entityCount, 3); // worldspawn + info_player_start + player
  assert.equal(s1.classCounts.info_player_start, 1);
  // 第二次调用直接命中缓存，classCounts 引用一致且结果相同
  const s2 = sys.stats();
  assert.equal(s2.classCounts, s1.classCounts);
  // 删除实体后缓存失效
  const sp = sys.entList.findFirstByName('sp1');
  assert.ok(sp);
  sys.removeEntity(sp);
  sys.frame(0.016);
  const s3 = sys.stats();
  assert.equal(s3.entityCount, 2);
  assert.equal(s3.classCounts.info_player_start, undefined);
});

test('TransparentSorter 分离面拓扑排序：宽水面+分裂玻璃、水下反转、门帘遮挡、异侧不反转', () => {
  const makeBoxMesh = (minX, minY, minZ, maxX, maxY, maxZ) => {
    const g = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
    g.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    g.computeBoundingBox();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true }));
    m.updateMatrixWorld(true);
    return m;
  };

  // 1. 宽水面 y=0 + 上方两块在 x=0 切开的玻璃 y=48
  const water = makeBoxMesh(-500, 0, -100, 500, 0, 100);
  const farGlass = makeBoxMesh(-500, 48, -100, 0, 48, 100);
  const nearGlass = makeBoxMesh(0, 48, -100, 500, 48, 100);

  const root = new THREE.Group();
  root.add(water, farGlass, nearGlass);
  const sorter = new TransparentSorter();
  sorter.collect(root);

  const cam = new THREE.PerspectiveCamera(75, 1, 1, 2000);
  // 相机在玻璃上方右侧：水面最近点在脚下 (dist² ≈ 94² = 8836)，比远端玻璃 (200²+46² ≈ 42116) 更近，
  // 但水面在 y=0、玻璃在 y=48、相机在 y=94，水面必须先于两块玻璃绘制。
  cam.position.set(200, 94, -66);
  sorter.update(cam, null, -1);
  assert.ok(water.renderOrder < farGlass.renderOrder, '水面上方视角：水面必须先于远端玻璃绘制');
  assert.ok(water.renderOrder < nearGlass.renderOrder, '水面上方视角：水面必须先于近端玻璃绘制');

  // 水下视角 (y=-50)：玻璃在 y=48 比水面 y=0 更远，拓扑顺序反转
  cam.position.set(200, -50, -66);
  sorter.update(cam, null, -1);
  assert.ok(farGlass.renderOrder < water.renderOrder, '水下视角：远端玻璃必须先于水面绘制');
  assert.ok(nearGlass.renderOrder < water.renderOrder, '水下视角：近端玻璃必须先于水面绘制');

  // 2. 门帘 vs 室内玻璃（z 分离）
  const curtain = makeBoxMesh(-100, 0, -100, 100, 200, -100);
  const roomGlass = makeBoxMesh(-100, 0, 100, 100, 0, 200);
  const root2 = new THREE.Group();
  root2.add(curtain, roomGlass);
  const sorter2 = new TransparentSorter();
  sorter2.collect(root2);
  cam.position.set(0, 120, -400);
  sorter2.update(cam, null, -1);
  assert.ok(roomGlass.renderOrder < curtain.renderOrder, '门帘后方玻璃必须先于门帘绘制');

  // 3. 相机严格夹在两块之间：互不遮挡，保持距离降序
  const leftNear = makeBoxMesh(-150, 0, -50, -50, 100, 50);
  const rightFar = makeBoxMesh(200, 0, -50, 400, 100, 50);
  const root3 = new THREE.Group();
  root3.add(leftNear, rightFar);
  const sorter3 = new TransparentSorter();
  sorter3.collect(root3);
  cam.position.set(0, 50, 0);
  sorter3.update(cam, null, -1);
  assert.ok(rightFar.renderOrder < leftNear.renderOrder, '相机在两块之间时保持距离降序');
});

test('mergeIntoChunks 隔离不同半透明材质，且 mergeWaterSurfaces 支持单材质水面块', () => {
  const makeQuad = (x0, y0, z0, x1, y1, z1, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      x0, y0, z0, x1, y0, z0, x1, y1, z1,
      x0, y0, z0, x1, y1, z1, x0, y1, z1,
    ], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    const m = new THREE.Mesh(g, mat);
    m.updateMatrixWorld(true);
    return m;
  };

  // 1. 同一 cell 内不同半透明材质不得合并成多材质块；同材质仍可合并
  const matA = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  const matB = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  const root = new THREE.Group();
  root.add(
    makeQuad(0, 0, 0, 10, 10, 0, matA),
    makeQuad(1, 0, 1, 11, 10, 1, matA),
    makeQuad(2, 0, 2, 12, 10, 2, matB),
  );
  const res = mergeIntoChunks(root, { translucentSplit: true, opaqueTargetCells: 128 });
  assert.equal(res.chunks.length, 2, '同一 cell 两种半透明材质应拆成 2 个单材质块');
  for (const ch of res.chunks) {
    assert.equal(Array.isArray(ch.material), false, '半透明合并块不得为多材质数组');
  }

  // 2. 单材质水面块（geometry.groups 为空）在 mergeWaterSurfaces 中正常归并
  const waterMat = new THREE.MeshBasicMaterial({ transparent: true });
  waterMat.userData.vbsp_water = { fog: [0.1, 0.1, 0.1] };
  const wRoot = new THREE.Group();
  wRoot.add(
    makeQuad(0, 100, 0, 100, 100, 100, waterMat),
    makeQuad(100, 100, 0, 200, 100, 100, waterMat),
  );
  const wStats = mergeWaterSurfaces(wRoot);
  assert.ok(wStats && wStats.mergedMeshes === 1 && wStats.removedMeshes === 2, '单材质水面应成功归并');
  assert.equal(wRoot.children.length, 1);
  const mergedWater = wRoot.children[0];
  assert.equal(Array.isArray(mergedWater.material), false, '单槽水面归并后应传单个 Material');
  assert.equal(mergedWater.geometry.attributes.position.count, 12);
});





