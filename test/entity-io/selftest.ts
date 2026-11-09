/**
 * Source 实体 I/O 运行期自测。
 *
 * 两部分：
 *  A. SDK 硬语义用例（对照 `test/project/source-sdk-2013-master` 的权威实现）
 *  B. 真实地图夹具（直接读 `test/maps/*.bsp` 的 entities lump，不依赖 wasm）
 *
 * 由 `src/scripts/check-entity-io.mjs` 用 esbuild 打成单文件 ESM 后由 Node 执行。
 * 本文件不依赖 three / DOM，故可在纯 Node 下跑完整套逻辑。
 */
import { EntityOutput, EventAction, EVENT_FIRE_ALWAYS } from '../../src/ts-shared/entity/entity-io.js';
import { namesMatch } from '../../src/ts-shared/entity/entity-list.js';
import {
  FIELD_BOOLEAN, FIELD_COLOR32, FIELD_FLOAT, FIELD_INPUT, FIELD_INTEGER,
  FIELD_STRING, FIELD_VECTOR, FIELD_VOID, Variant,
} from '../../src/ts-shared/entity/variant.js';
import { g_Runtime } from '../../src/ts-shared/entity/runtime.js';
import {
  EntitySystem, brushIntersectsAabb, createRecordingHost,
  type EntitySystemOptions,
} from '../../src/ts-shared/entity/entity-system.js';
import type { EntityIoPayload, EntityVolume, Vec3 } from '../../src/ts-shared/entity/types.js';
import { parseEntityBlocks } from '../../src/ts-shared/entity/map-data.js';

declare const process: { exitCode?: number; argv: string[] };

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 夹具构造 ───────────────────────────────────────────────────────────────
function block(classname: string, pairs: Array<[string, string]> = []): string {
  const lines = [`"classname" "${classname}"`, ...pairs.map(([k, v]) => `"${k}" "${v}"`)];
  return `{\n${lines.join('\n')}\n}\n`;
}
function makePayload(blocks: string[], volumes: EntityVolume[] = []): EntityIoPayload {
  return { entities_text: blocks.join('\n'), volumes };
}
function volumeAt(blocks: string[], classname: string, brushes: EntityVolume['brushes']): EntityVolume[] {
  const parsed = parseEntityBlocks(blocks.join('\n'));
  const index = parsed.findIndex((p) => p.some((kv) => kv.key.toLowerCase() === 'classname' && kv.value === classname));
  assert(index >= 0, `找不到 ${classname} 的实体块`);
  return [{ index, model: '*1', origin: [0, 0, 0], brushes }];
}
function box(mins: Vec3, maxs: Vec3, withPlanes = false): EntityVolume['brushes'][number] {
  if (!withPlanes) return { mins, maxs, planes: [] };
  return {
    mins, maxs,
    planes: [
      [1, 0, 0, maxs[0]], [-1, 0, 0, -mins[0]],
      [0, 1, 0, maxs[1]], [0, -1, 0, -mins[1]],
      [0, 0, 1, maxs[2]], [0, 0, -1, -mins[2]],
    ],
  };
}

interface Fixture { sys: EntitySystem; host: ReturnType<typeof createRecordingHost> }
function fixture(blocks: string[], opts: Partial<EntitySystemOptions> = {}, volumes: EntityVolume[] = []): Fixture {
  const host = createRecordingHost();
  const sys = new EntitySystem({ host: host.host, maxEventsPerService: 50_000, ...opts });
  sys.load(makePayload(blocks, volumes));
  return { sys, host };
}

// ── A. SDK 硬语义 ──────────────────────────────────────────────────────────
check('A1 CEventAction：ESC 优先分隔，参数可带逗号', () => {
  const a = new EventAction('t1\x1bTrigger\x1bfoo,bar\x1b2.5\x1b0');
  eq(a.target, 't1', 'target');
  eq(a.targetInput, 'Trigger', 'input');
  eq(a.parameter, 'foo,bar', 'parameter');
  eq(a.delay, 2.5, 'delay');
  eq(a.timesToFire, EVENT_FIRE_ALWAYS, 'timesToFire(0 → -1)');
});

check('A2 CEventAction：逗号格式、空 input→Use、空 parameter→NULL', () => {
  // 字段顺序严格是 target,input,parameter,delay,times；空 parameter 要占一个字段位。
  const a = new EventAction('t2,,,1.5,3');
  eq(a.targetInput, 'Use', 'input');
  eq(a.parameter, null, 'parameter');
  eq(a.delay, 1.5, 'delay');
  eq(a.timesToFire, 3, 'timesToFire');
  // 少一个逗号时 1.5 会被当成 parameter，3 被当成 delay（不是「自动右对齐」）。
  const shifted = new EventAction('t2,,1.5,3');
  eq(shifted.parameter, '1.5', '字段不右对齐');
  eq(shifted.delay, 3, 'delay 取第 4 段');
  const b = new EventAction('t3,Trigger');
  eq(b.delay, 0, '缺失 delay');
  eq(b.timesToFire, EVENT_FIRE_ALWAYS, '缺失 times');
});

check('A3 AddEventAction 是头插（触发顺序与书写顺序相反）', () => {
  const out = new EntityOutput();
  out.parseEventAction('first,Trigger,,0,-1');
  out.parseEventAction('second,Trigger,,0,-1');
  eq(out.numberOfElements(), 2, '连接数');
  eq(out.getFirstAction()?.target, 'second', '链表头');
});

check('A4 FireOutput：参数覆盖分支不加 fDelay；无覆盖分支加 fDelay', () => {
  const { sys } = fixture([]);
  const out = new EntityOutput();
  out.parseEventAction('noOverride,InValue,,1,1');
  out.parseEventAction('override,InValue,X,2,1');
  out.fireOutput(Variant.fromFloat(7), null, null, 0.5);
  const snap = sys.eventQueue.snapshot();
  eq(snap.length, 2, '入队事件数');
  const noOv = snap.find((e) => e.targetName === 'noOverride');
  const ov = snap.find((e) => e.targetName === 'override');
  assert(noOv && ov, '两类事件都应在队列');
  eq(noOv.fireTime, 1.5, '无覆盖 delay = ev.delay + fDelay');
  eq(noOv.value.fieldType(), FIELD_FLOAT, '无覆盖传原值');
  eq(noOv.value.float(), 7, '无覆盖值');
  eq(ov.fireTime, 2, '参数覆盖 delay 只取 ev.delay');
  eq(ov.value.fieldType(), FIELD_STRING, '覆盖值恒为 FIELD_STRING');
  eq(ov.value.string(), 'X', '覆盖值');
  sys.dispose();
});

check('A5 FireOutput：timesToFire 递减到 0 当场删除 action', () => {
  const { sys } = fixture([]);
  const out = new EntityOutput();
  out.parseEventAction('t,Trigger,,0,2');
  out.fireOutput(Variant.void(), null, null);
  eq(out.numberOfElements(), 1, '第一次后仍在');
  out.fireOutput(Variant.void(), null, null);
  eq(out.numberOfElements(), 0, '第二次后删除');
  sys.dispose();
});

check('A6 NamesMatch：大小写不敏感 / * 退化成前缀匹配（SDK 既有行为）', () => {
  assert(namesMatch('Foo', 'foo'), '大小写');
  assert(namesMatch('door*', 'door_main_01'), '末尾通配');
  // SDK baseentity.cpp:3477-3480 只判断「break 处 query 字符是 *」，不校验在末尾；
  // 因此 'd*r' 对 'door' 为 true，'r' 被静默忽略。注释写着 "only trailing *"，实现并非如此。
  assert(namesMatch('d*r', 'door'), '中间 * 被当前缀通配（1:1 复刻）');
  assert(!namesMatch('door', 'd*r'), '反向不成立');
  assert(namesMatch('', null), 'NULL_STRING 匹配空 query');
  assert(namesMatch('*', null), 'NULL_STRING 匹配 *');
  assert(!namesMatch('x', null), 'NULL_STRING 不匹配非空');
});

check('A7 !self / !player 只在 startEntity=null 返回一次', () => {
  const { sys } = fixture([block('logic_relay', [['targetname', 'self1']])]);
  const target = sys.getEntity(0)!;
  const first = sys.entList.findEntityByName(null, '!self', target, null, null);
  eq(first, target, '!self 解析为 searchingEntity');
  eq(sys.entList.findEntityByName(first, '!self', target, null, null), null, '第二次不返回');
  eq(sys.entList.findEntityByName(null, '!player', null, null, null), sys.player, '!player');
  sys.dispose();
});

check('A8 variant_t：STRING 主力转换矩阵 / FIELD_INPUT 落 VOID', () => {
  const i = Variant.fromString('12abc'); assert(i.convert(FIELD_INTEGER)); eq(i.int(), 12, 'atoi');
  const f = Variant.fromString('1.5'); assert(f.convert(FIELD_FLOAT)); eq(f.float(), 1.5, 'atof');
  const b = Variant.fromString('0'); assert(b.convert(FIELD_BOOLEAN)); eq(b.bool(), false, 'bool');
  const v = Variant.fromString('1 2 3'); assert(v.convert(FIELD_VECTOR));
  eq(JSON.stringify(v.vector3D()), '[1,2,3]', 'vector');
  const c = Variant.fromString('255 128 0'); assert(c.convert(FIELD_COLOR32));
  eq(c.color32().g, 128, 'color32');
  eq(new Variant().setFromField(FIELD_INPUT, 1).fieldType(), FIELD_VOID, 'FIELD_INPUT → VOID');
  assert(!Variant.fromFloat(1).convert(FIELD_STRING), 'SDK 不支持 FLOAT → STRING');
});

check('A9 AcceptInput：FireOutput 无条件入队，不经同步调用', () => {
  // spawnflags=2（ALLOW_FAST_RETRIGGER）避免 relay 额外排一条 EnableRefire 事件，
  // 让「队列里正好 1 条」成为可通约的判据。
  const { sys, host } = fixture([
    block('logic_relay', [['targetname', 'r1'], ['spawnflags', '2'], ['OnTrigger', 'cmd,Command,HELLO,0,-1']]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  sys.acceptInputOn('r1', 'Trigger');
  eq(host.calls.commands.length, 0, '入队后尚未执行');
  eq(sys.eventQueue.pendingCount, 1, '队列里有 1 条');
  sys.serviceEventsNow();
  eq(JSON.stringify(host.calls.commands), '["HELLO"]', 'ServiceEvents 后执行');
  sys.dispose();

  // 不带 flag 时多出的那条就是 EnableRefire（SDK 的重触发锁实现）。
  const slow = fixture([
    block('logic_relay', [['targetname', 'r1'], ['OnTrigger', 'cmd,Command,HELLO,0,-1']]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  slow.sys.acceptInputOn('r1', 'Trigger');
  eq(slow.sys.eventQueue.pendingCount, 2, 'OnTrigger + EnableRefire');
  const extra = slow.sys.eventQueue.snapshot().find((e) => e.targetInput === 'EnableRefire');
  assert(extra, 'EnableRefire 事件存在');
  slow.sys.dispose();
});

check('A10 ServiceEvents：同 tick 内 0 延迟链当帧跑完', () => {
  const { sys, host } = fixture([
    block('logic_relay', [['targetname', 'a'], ['spawnflags', '2'], ['OnTrigger', 'b,Trigger,,0,-1']]),
    block('logic_relay', [['targetname', 'b'], ['spawnflags', '2'], ['OnTrigger', 'c,Trigger,,0,-1']]),
    block('logic_relay', [['targetname', 'c'], ['spawnflags', '2'], ['OnTrigger', 'cmd,Command,DONE,0,-1']]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  sys.acceptInputOn('a', 'Trigger');
  const n = sys.serviceEventsNow();
  assert(n >= 3, `一次调用应处理整条链，实际 ${n}`);
  eq(JSON.stringify(host.calls.commands), '["DONE"]', '链尾输入');
  eq(sys.eventQueue.pendingCount, 0, '无残留事件');
  sys.dispose();
});

check('A11 AddOutput：冒号还原成逗号后走 KeyValue', () => {
  const { sys, host } = fixture([
    block('point_servercommand', [['targetname', 'src']]),
    block('point_servercommand', [['targetname', 'dst']]),
  ]);
  sys.acceptInputOn('src', 'AddOutput', Variant.fromString('OnUser1 dst:Command:ADDED:0:-1'));
  sys.acceptInputOn('src', 'FireUser1');
  sys.serviceEventsNow();
  eq(JSON.stringify(host.calls.commands), '["ADDED"]', '动态加的输出');
  sys.dispose();
});

check('A12 logic_relay：快速重触发由 waitForRefire + 事件队列控制', () => {
  const slow = fixture([
    block('logic_relay', [['targetname', 'r'], ['OnTrigger', 'cmd,Command,X,0,-1']]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  slow.sys.acceptInputOn('r', 'Trigger');
  slow.sys.acceptInputOn('r', 'Trigger');
  slow.sys.serviceEventsNow();
  eq(slow.host.calls.commands.length, 1, '不带 ALLOW_FAST_RETRIGGER 只 fire 一次');
  slow.sys.dispose();

  const fast = fixture([
    block('logic_relay', [['targetname', 'r'], ['spawnflags', '2'], ['OnTrigger', 'cmd,Command,X,0,-1']]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  fast.sys.acceptInputOn('r', 'Trigger');
  fast.sys.acceptInputOn('r', 'Trigger');
  fast.sys.serviceEventsNow();
  eq(fast.host.calls.commands.length, 2, '带 flag 可连续 fire');
  fast.sys.dispose();
});

check('A13 math_counter：OutValue 存值，OnHitMax 边沿锁存', () => {
  const { sys, host } = fixture([
    block('math_counter', [
      ['targetname', 'mc'], ['min', '0'], ['max', '2'], ['startvalue', '0'],
      ['OnHitMax', 'cmd,Command,MAX,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  sys.acceptInputOn('mc', 'Add', Variant.fromFloat(5));
  sys.serviceEventsNow();
  eq(host.calls.commands.filter((c) => c === 'MAX').length, 1, '第一次到 max');
  sys.acceptInputOn('mc', 'Add', Variant.fromFloat(5));
  sys.serviceEventsNow();
  eq(host.calls.commands.filter((c) => c === 'MAX').length, 1, '锁存后不再 fire');
  const mc = sys.getEntity(0)!;
  eq(mc.output('OutValue')?.currentValue().float(), 2, 'clamp 到 max');
  sys.dispose();
});

check('A14 logic_case：InValue 只触发第一个匹配 CaseNN', () => {
  const { sys, host } = fixture([
    block('logic_case', [
      ['targetname', 'lc'], ['Case01', 'foo'], ['Case02', 'foo'],
      ['OnCase01', 'cmd,Command,ONE,0,-1'],
      ['OnCase02', 'cmd,Command,TWO,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  sys.acceptInputOn('lc', 'InValue', Variant.fromString('FOO'));
  sys.serviceEventsNow();
  eq(JSON.stringify(host.calls.commands), '["ONE"]', '大小写不敏感 + 首个匹配');
  sys.dispose();
});

check('A15 logic_auto：一帧内按加载类型 fire 全部输出', () => {
  const { sys, host } = fixture([
    block('logic_auto', [
      ['OnNewGame', 'cmd,Command,NEWGAME,0,-1'],
      ['OnMapSpawn', 'cmd,Command,SPAWN,0,-1'],
      ['OnMultiNewMap', 'cmd,Command,MULTI,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  sys.frame(0.25);
  eq(host.calls.commands.length, 3, '三条输出');
  assert(host.calls.commands.includes('NEWGAME') && host.calls.commands.includes('SPAWN') && host.calls.commands.includes('MULTI'), '输出集合');
  sys.dispose();
});

check('A16 trigger touch：StartTouch / Touch / EndTouch 边沿与 touchlink 心跳', () => {
  const blocks = [
    block('trigger_once', [
      ['targetname', 'tr'],
      ['OnStartTouch', 'cmd,Command,START,0,-1'],
      ['OnEndTouch', 'cmd,Command,END,0,-1'],
      ['OnEndTouchAll', 'cmd,Command,ENDALL,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ];
  const volumes = volumeAt(blocks, 'trigger_once', [box([0, 0, 0], [10, 10, 10], true)]);
  const { sys, host } = fixture(blocks, {}, volumes);
  host.player.origin = [5, 5, 5];
  sys.frame(0.016);
  assert(host.calls.commands.includes('START'), '进入时 OnStartTouch');
  eq(host.calls.commands.filter((c) => c === 'START').length, 1, '不重复 StartTouch');
  sys.frame(0.016);
  eq(host.calls.commands.filter((c) => c === 'START').length, 1, '持续接触不重复');
  host.player.origin = [100, 100, 100];
  sys.frame(0.016);
  assert(host.calls.commands.includes('END'), '离开时 OnEndTouch');
  assert(host.calls.commands.includes('ENDALL'), '最后一个离开时 OnEndTouchAll');
  sys.dispose();
});

check('A17 filter：Negated 在最外层，filter_multi 的 AND/OR', () => {
  const blocks = [
    block('filter_activator_name', [['targetname', 'f1'], ['filtername', '!player']]),
    block('filter_activator_name', [['targetname', 'f2'], ['filtername', 'nobody*'], ['Negated', '1']]),
    block('filter_multi', [
      ['targetname', 'and'], ['FilterType', '0'], ['Filter01', 'f1'], ['Filter02', 'f2'],
    ]),
    block('filter_multi', [
      ['targetname', 'or'], ['FilterType', '1'], ['Filter01', 'f1'], ['Filter02', 'f2'],
    ]),
    block('trigger_multiple', [
      ['targetname', 'tand'], ['filtername', 'and'], ['OnTrigger', 'cmd,Command,AND,0,-1'],
    ]),
    block('trigger_multiple', [
      ['targetname', 'tor'], ['filtername', 'or'], ['OnTrigger', 'cmd,Command,OR,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ];
  const volumes = volumeAt(blocks, 'trigger_multiple', [box([0, 0, 0], [10, 10, 10])]);
  // 两个 trigger 共用同一份体积（只验 filter 语义，不验几何区分）
  const second = parseEntityBlocks(blocks.join('\n')).findIndex((p, i) => i > volumes[0].index && p.some((kv) => kv.value === 'tor'));
  volumes.push({ index: second, model: '*2', origin: [0, 0, 0], brushes: volumes[0].brushes });
  const { sys, host } = fixture(blocks, {}, volumes);
  host.player.origin = [5, 5, 5];
  sys.frame(0.016);
  assert(host.calls.commands.includes('AND'), 'AND 全通过');
  assert(host.calls.commands.includes('OR'), 'OR 任一通过');
  sys.dispose();
});

check('A18 RunScriptCode：反引号还原成双引号（InputRunScript）', () => {
  const { sys, host } = fixture([block('logic_relay', [['targetname', 'r']])]);
  sys.acceptInputOn('r', 'RunScriptCode', Variant.fromString('EntFire(`cmd`, `Command`, `x`)'));
  eq(JSON.stringify(host.calls.scripts), '["EntFire(\\"cmd\\", \\"Command\\", \\"x\\")"]', '反引号替换');
  sys.dispose();
});

check('A19 brushIntersectsAabb：分离轴用最小投影点', () => {
  const brush = box([0, 0, 0], [10, 10, 10], true);
  // 玩家碰撞盒比 brush 大，但中心在内部 ⇒ 必须判为接触（不能要求包含）
  assert(brushIntersectsAabb(brush, [-16, -36, -16], [16, 36, 16]), '大 AABB 覆盖凸包算接触');
  assert(!brushIntersectsAabb(brush, [20, 0, 0], [30, 10, 10]), '完全在 +X 外侧');
  assert(!brushIntersectsAabb(brush, [-30, 0, 0], [-20, 10, 10]), '完全在 -X 外侧');
  assert(brushIntersectsAabb(box([0, 0, 0], [10, 10, 10]), [9, 9, 9], [20, 20, 20]), '无平面时纯 AABB');
});

check('A20 重复键 / Hammer # 后缀：同名 output 全部保留', () => {
  const { sys, host } = fixture([
    block('logic_relay', [
      ['targetname', 'r'],
      ['OnTrigger', 'cmd,Command,A,0,-1'],
      ['OnTrigger#1', 'cmd,Command,B,0,-1'],
    ]),
    block('point_servercommand', [['targetname', 'cmd']]),
  ]);
  eq(sys.getEntity(0)?.output('OnTrigger')?.numberOfElements(), 2, '两条连接');
  sys.acceptInputOn('r', 'Trigger');
  sys.serviceEventsNow();
  eq(host.calls.commands.length, 2, '两条都 fire');
  // 头插 ⇒ 后写的 B 先入队先执行
  eq(host.calls.commands[0], 'B', '头插顺序');
  sys.dispose();
});

// ── B. 真实地图夹具 ────────────────────────────────────────────────────────
/**
 * 读 VBSP header 的 lump 0（entities）由 runner 用 node:fs 注入；本文件保持
 * 「零 Node 内置模块」，将来同一套用例也能在浏览器 / worker 里跑。
 */
const runner = globalThis as unknown as {
  __websurfReadEntities?: (path: string) => string;
  __websurfEntityIoFromBsp?: (path: string) => string;
  __websurfMapDir?: string;
  __websurfPathJoin?: (a: string, b: string) => string;
  __websurfMapNames?: string[];
};
function readEntitiesLump(path: string): string {
  if (!runner.__websurfReadEntities) throw new Error('runner 未注入 __websurfReadEntities');
  return runner.__websurfReadEntities(path);
}
const mapDir = runner.__websurfMapDir ?? 'test/maps';
const pathJoin = runner.__websurfPathJoin;
// 地图是本地自备夹具，不入库；runner 只注入实际存在的，缺失时判 SKIP 而非 FAIL。
const mapNames = runner.__websurfMapNames ?? [];
if (mapNames.length === 0) {
  results.push({ name: 'B 真实地图夹具', ok: true, detail: 'SKIP：test/maps 下无地图（本地自备，不入库）' });
}

for (const name of mapNames) {
  check(`B 真实地图 ${name}`, () => {
    assert(pathJoin, 'runner 未注入 __websurfPathJoin');
    const text = readEntitiesLump(pathJoin!(mapDir, name));
    const blocks = parseEntityBlocks(text);
    assert(blocks.length > 100, `实体块过少: ${blocks.length}`);
    const host = createRecordingHost();
    const sys = new EntitySystem({
      host: host.host, maxEventsPerService: 20_000,
      log: () => { /* 地图里有大量未建模类，静默 */ },
    });
    sys.load({ entities_text: text, volumes: [] });
    const stats = sys.stats();
    eq(stats.entityCount, blocks.length + 1, '实体数 = 块数 + 玩家');
    assert(stats.outputConnections > 0, '至少解析出一条 output 连接');
    // 跑几帧让 logic_auto / logic_timer / 延迟输出走一遍，验证不会抛错或死循环。
    for (let i = 0; i < 8; i++) sys.frame(0.1);
    const escCount = (text.match(/\x1b/g) ?? []).length;
    results.push({
      name: `B 统计 ${name}`,
      ok: true,
      detail: `blocks=${blocks.length} outputs=${stats.outputConnections} ESC=${escCount} classes=${Object.keys(stats.classCounts).length} 8帧后pending=${stats.pendingEvents}`,
    });
    sys.dispose();
  });
}

// ── C. 新 wasm 产物探针 ────────────────────────────────────────────────────
/** 验证 `export_entity_io()` 真的存在于运行时产物里，且 TS 侧能吃下完整数据（含 volumes）。 */
const wasmExport = runner.__websurfEntityIoFromBsp;
const probeMaps = mapNames.filter(
  (n) => n === 'surf_666.bsp' || n === 'ze_cursed_bear_tales_v1_2.bsp',
);
if (!wasmExport || probeMaps.length === 0) {
  results.push({
    name: 'C wasm 产物探针', ok: true,
    detail: 'SKIP：需先 npm run build:wasm，且 test/maps 下有本地地图夹具',
  });
} else {
  for (const name of probeMaps) {
    check(`C wasm 产物 ${name}`, () => {
      assert(pathJoin, 'runner 未注入 __websurfPathJoin');
      const json = wasmExport(pathJoin!(mapDir, name));
      const data = JSON.parse(json) as EntityIoPayload;
      const raw = readEntitiesLump(pathJoin!(mapDir, name));
      // 解码口径差异（Rust UTF-8 / 夹具 latin1）：只比对可通约量，避免「判据假结案」。
      eq(parseEntityBlocks(data.entities_text).length, parseEntityBlocks(raw).length, '实体块数');
      eq((data.entities_text.match(/\x1b/g) ?? []).length, (raw.match(/\x1b/g) ?? []).length, 'ESC 分隔串数');
      assert(/[A-Z]/.test(data.entities_text), '大小写未被小写化');
      assert(data.volumes.length > 0, '导出 brush 体积');
      const withPlanes = data.volumes.reduce((n, v) => n + v.brushes.filter((b) => b.planes.length > 0).length, 0);
      assert(withPlanes > 0, '凸包平面非空');

      const rec = createRecordingHost();
      const sys = new EntitySystem({ host: rec.host, maxEventsPerService: 20_000, log: () => {} });
      sys.load(data);
      // 取**加载瞬间**的快照：跑帧后 timesToFire 会删连接、Kill 会删实体，
      // 那时的计数与 B 组不可通约（判据假结案的另一个坑）。
      const loaded = sys.stats();
      eq(loaded.volumeEntities, data.volumes.length, '体积全部挂回实体');
      // 把玩家放进第一个 brush 的 AABB 中心，跑几帧走完整 touch → I/O 链。
      const first = data.volumes[0].brushes[0];
      rec.player.origin = [
        (first.mins[0] + first.maxs[0]) / 2,
        (first.mins[1] + first.maxs[1]) / 2,
        (first.mins[2] + first.maxs[2]) / 2,
      ];
      for (let i = 0; i < 5; i++) sys.frame(0.016);
      assert(sys.stats().pendingEvents < 20_000, '事件队列有界');
      results.push({
        name: `C 统计 ${name}`, ok: true,
        detail: `json=${(json.length / 1024).toFixed(0)}KB 实体=${loaded.entityCount} 连接=${loaded.outputConnections} 体积=${data.volumes.length}/${withPlanes}带平面`,
      });
      sys.dispose();
    });
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`  PASS  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  else console.log(`  FAIL  ${r.name}\n${r.detail}`);
}
console.log(`\n实体 I/O 自测：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
