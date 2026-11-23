/**
 * 逻辑实体家族。对照 Source SDK 2013：
 * - `game/server/logicrelay.cpp:22-161`（CLogicRelay）
 * - `game/server/logicentities.cpp:1415-1780`（CMathCounter）、`:1791-2023`（CLogicCase）、
 *   `:2030-2143`（CLogicCompare）、`:2174-2355`（CLogicBranch）、
 *   `:252-553`（CTimerEntity = logic_timer）、`:2639-2840`（CLogicBranchList）、
 *   `:970-1176`（CEnvGlobal）、`:1221-1409`（CMultiSource）
 * - `game/server/logicauto.cpp:19-126`（CLogicAuto）
 *
 * 家族共同点（SDK 的 `CLogicalEntity`）：无物理、无模型，只有 I/O 与内部状态。
 * 这里全部按 DATADESC 声明 inputs / outputs / keyfields，分派由 `AcceptInput` 统一做，
 * 不存在「为某张地图的关卡顺序写 if」的情况 —— 顺序是地图自己的 I/O 连接图决定的。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_BOOLEAN, FIELD_FLOAT, FIELD_INTEGER, FIELD_INPUT, FIELD_VOID } from '../variant.js';
import { OutputTyped } from '../entity-io.js';
import { g_Runtime } from '../runtime.js';
import type { InputData } from '../types.js';
import { findAllByName, fire, fireValue, input } from './common.js';
import { registerClass } from './registry.js';

// ── 引擎全局状态（对应 gGlobalState / GlobalEntity_*） ──────────────────────
export interface GlobalStateEntry {
  state: 'on' | 'off' | 'dead';
  counter: number;
}
/** 每个地图加载时由 EntitySystem 清空（logic_auto 不跨关卡保存）。 */
export const globalStates = new Map<string, GlobalStateEntry>();

function globalState(name: string): GlobalStateEntry {
  let s = globalStates.get(name);
  if (!s) {
    s = { state: 'off', counter: 0 };
    globalStates.set(name, s);
  }
  return s;
}

// ── logic_relay ────────────────────────────────────────────────────────────
const SF_REMOVE_ON_FIRE = 0x001;
const SF_ALLOW_FAST_RETRIGGER = 0x002;

export const LogicRelayClass: EntityClass = {
  name: 'logic_relay',
  base: 'logical',
  spawnFlags: { REMOVE_ON_FIRE: SF_REMOVE_ON_FIRE, ALLOW_FAST_RETRIGGER: SF_ALLOW_FAST_RETRIGGER },
  keyfields: [{ name: 'StartDisabled', type: 'bool', defaultValue: false }],
  inputs: [
    { name: 'Enable', type: FIELD_VOID, handler: (e) => e.set('disabled', false) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => e.set('disabled', true) },
    input('Toggle', FIELD_VOID, (e) => e.set('disabled', !e.getBool('disabled', false))),
    { name: 'EnableRefire', type: FIELD_VOID, handler: (e) => e.set('waitForRefire', false) },
    input('CancelPending', FIELD_VOID, (e) => {
      g_Runtime.eventQueue?.cancelEvents(e);
      e.set('waitForRefire', false);
    }),
    input('Trigger', FIELD_VOID, (e, d) => {
      if (e.getBool('disabled', false) || e.getBool('waitForRefire', false)) return;
      e.fire('OnTrigger', d.activator, e);
      if (e.hasSpawnFlags(SF_REMOVE_ON_FIRE)) {
        e.remove();
      } else if (!e.hasSpawnFlags(SF_ALLOW_FAST_RETRIGGER)) {
        e.set('waitForRefire', true);
        const delay = (e.output('OnTrigger')?.getMaxDelay() ?? 0) + 0.001;
        g_Runtime.eventQueue?.addEventForEntityVoid(e, 'EnableRefire', delay, e, e);
      }
    }),
  ],
  outputs: [
    { name: 'OnTrigger', kind: 'event' },
    { name: 'OnSpawn', kind: 'event' },
  ],
  spawn: (e) => {
    e.set('waitForRefire', false);
    e.set('disabled', e.getBool('startdisabled', false));
  },
  activate: (e) => {
    // Activate：只有 OnSpawn 有连接才排一次 +0.01s 的 think（logicrelay.cpp:60-87）
    if ((e.output('OnSpawn')?.numberOfElements() ?? 0) > 0) {
      e.setThink((self) => {
        self.fire('OnSpawn', self, self);
        if (self.hasSpawnFlags(SF_REMOVE_ON_FIRE)) self.remove();
      }, 0.01);
    }
  },
};

// ── math_counter ───────────────────────────────────────────────────────────
/** `CMathCounter::UpdateOutValue`（logicentities.cpp:1740-1780）。 */
function updateOutValue(entity: Entity, activator: Entity | null, newValue: number): void {
  const min = entity.getNumber('min', 0);
  const max = entity.getNumber('max', 0);
  const clampEnabled = min !== 0 || max !== 0;
  if (clampEnabled) {
    // hit 判定用**未 clamp** 的 newValue，且是边沿锁存
    if (newValue >= max) {
      if (!entity.getBool('hitMax', false)) {
        entity.set('hitMax', true);
        fire(entity, 'OnHitMax', activator);
      }
    } else entity.set('hitMax', false);
    if (newValue <= min) {
      if (!entity.getBool('hitMin', false)) {
        entity.set('hitMin', true);
        fire(entity, 'OnHitMin', activator);
      }
    } else entity.set('hitMin', false);
    newValue = Math.min(Math.max(newValue, min), max);
  }
  fireValue(entity, 'OutValue', newValue, activator);
}

function counterValue(entity: Entity): number {
  const out = entity.output('OutValue');
  if (out instanceof OutputTyped) return (out.get() as number) ?? 0;
  return 0;
}

function counterArithmetic(op: 'add' | 'sub' | 'mul' | 'div' | 'set') {
  return (entity: Entity, d: InputData): void => {
    if (entity.getBool('disabled', false)) return;
    const cur = counterValue(entity);
    const v = d.value.float();
    let next = cur;
    switch (op) {
      case 'add': next = cur + v; break;
      case 'sub': next = cur - v; break;
      case 'mul': next = cur * v; break;
      case 'div': next = v !== 0 ? cur / v : cur; break;
      case 'set': next = v; break;
    }
    updateOutValue(entity, d.activator as Entity | null, next);
  };
}

export const MathCounterClass: EntityClass = {
  name: 'math_counter',
  base: 'logical',
  keyfields: [
    { name: 'min', type: 'float', defaultValue: 0 },
    { name: 'max', type: 'float', defaultValue: 0 },
    { name: 'StartDisabled', type: 'bool', defaultValue: false },
    // `startvalue` 由 KeyValue 用 **atoi** 解析（logicentities.cpp:1496-1503）
    { name: 'startvalue', type: 'int', defaultValue: 0 },
  ],
  inputs: [
    { name: 'Add', type: FIELD_FLOAT, handler: counterArithmetic('add') },
    { name: 'Subtract', type: FIELD_FLOAT, handler: counterArithmetic('sub') },
    { name: 'Multiply', type: FIELD_FLOAT, handler: counterArithmetic('mul') },
    { name: 'Divide', type: FIELD_FLOAT, handler: counterArithmetic('div') },
    input('SetValue', FIELD_FLOAT, (e, d) => {
      // Source/CS:GO 语义：SetValue 更新值并触发 OutValue（含 hit 判定）**以及 OnGetValue**；
      // SetValueNoFire 才是不触发任何输出。CS:GO ze 图的关卡阶段机依赖这一条
      // （ze_cursed: warmup relay `SetValue 2` → OnGetValue → logic_case InValue → Stage01）。
      if (e.getBool('disabled', false)) return;
      updateOutValue(e, d.activator as Entity | null, d.value.float());
      const out = e.output('OnGetValue');
      if (out instanceof OutputTyped) out.set(counterValue(e), d.activator, d.caller);
    }),
    input('SetValueNoFire', FIELD_FLOAT, (e, d) => {
      if (e.getBool('disabled', false)) return;
      const min = e.getNumber('min', 0);
      const max = e.getNumber('max', 0);
      let v = d.value.float();
      if (min !== 0 || max !== 0) v = Math.min(Math.max(v, min), max);
      const out = e.output('OutValue');
      if (out instanceof OutputTyped) out.init(v); // Init：不 fire、不更新 hit 标志
    }),
    input('SetHitMax', FIELD_FLOAT, (e, d) => {
      const v = d.value.float();
      if (v < e.getNumber('min', 0)) e.set('min', v);
      e.set('max', v);
      updateOutValue(e, d.activator as Entity | null, counterValue(e));
    }),
    input('SetHitMin', FIELD_FLOAT, (e, d) => {
      const v = d.value.float();
      if (e.getNumber('max', 0) < v) e.set('max', v);
      e.set('min', v);
      updateOutValue(e, d.activator as Entity | null, counterValue(e));
    }),
    input('GetValue', FIELD_VOID, (e, d) => {
      // 唯一用 inputdata.pCaller 作 caller 的输出（logicentities.cpp:1716-1720）
      const out = e.output('OnGetValue');
      if (out instanceof OutputTyped) out.set(counterValue(e), d.activator, d.caller);
    }),
    { name: 'Enable', type: FIELD_VOID, handler: (e) => e.set('disabled', false) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => e.set('disabled', true) },
  ],
  outputs: [
    { name: 'OutValue', kind: 'float' },
    { name: 'OnGetValue', kind: 'float' },
    { name: 'OnHitMin', kind: 'event' },
    { name: 'OnHitMax', kind: 'event' },
  ],
  spawn: (e) => {
    let min = e.getNumber('min', 0);
    let max = e.getNumber('max', 0);
    if (min > max) { const t = max; max = min; min = t; }
    e.set('min', min);
    e.set('max', max);
    let start = e.getNumber('startvalue', 0);
    if (min !== 0 || max !== 0) start = Math.min(Math.max(start, min), max);
    const out = e.output('OutValue');
    if (out instanceof OutputTyped) out.init(start);
    e.set('disabled', e.getBool('startdisabled', false));
    e.set('hitMin', false);
    e.set('hitMax', false);
  },
};

// ── logic_case ─────────────────────────────────────────────────────────────
const MAX_LOGIC_CASES = 16;
const caseOutputs = Array.from({ length: MAX_LOGIC_CASES }, (_, i) => ({
  name: `OnCase${String(i + 1).padStart(2, '0')}`,
  kind: 'event' as const,
}));

/** `BuildCaseMap`：候选集是**有输出连接**的 OnCaseNN，与 CaseXX 键是否有值无关。 */
function buildCaseMap(entity: Entity): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_LOGIC_CASES; i++) {
    if ((entity.output(caseOutputs[i].name)?.numberOfElements() ?? 0) > 0) out.push(i);
  }
  return out;
}

export const LogicCaseClass: EntityClass = {
  name: 'logic_case',
  base: 'logical',
  keyfields: caseOutputs.map((_, i) => ({
    name: `Case${String(i + 1).padStart(2, '0')}`,
    type: 'string' as const,
    defaultValue: '',
  })),
  inputs: [
    input('InValue', FIELD_INPUT, (e, d) => {
      const s = d.value.string();
      for (let i = 0; i < MAX_LOGIC_CASES; i++) {
        const c = e.getString(`case${String(i + 1).padStart(2, '0')}`, '');
        if (c && c.toLowerCase() === s.toLowerCase()) {
          fire(e, caseOutputs[i].name, d.activator as Entity | null);
          return; // 只触发第一个匹配
        }
      }
      // OnDefault 携带原 variant；SDK 2013 的 COutputVariant 实际会把它变成 VOID（见 entity-io.ts）
      e.fireValue('OnDefault', d.value, d.activator, e);
    }),
    input('PickRandom', FIELD_VOID, (e, d) => {
      const map = buildCaseMap(e);
      if (map.length > 0) {
        const i = map[Math.floor(Math.random() * map.length)];
        fire(e, caseOutputs[i].name, d.activator as Entity | null);
      }
    }),
    input('PickRandomShuffle', FIELD_VOID, (e, d) => {
      let remaining = e.get<number[]>('shuffleMap') ?? [];
      let caseCount = remaining.length;
      let avoid = -1;
      if (caseCount === 0) {
        remaining = buildCaseMap(e);
        const last = e.getNumber('lastShuffleCase', -1);
        if (remaining.length > 1 && last !== -1) {
          avoid = last;
          const at = remaining.indexOf(avoid);
          if (at >= 0) {
            [remaining[at], remaining[remaining.length - 1]] = [remaining[remaining.length - 1], remaining[at]];
            caseCount = remaining.length - 1;
          } else caseCount = remaining.length;
        } else caseCount = remaining.length;
      }
      if (caseCount > 0) {
        const pick = Math.floor(Math.random() * caseCount);
        const chosen = remaining[pick];
        fire(e, caseOutputs[chosen].name, d.activator as Entity | null);
        remaining[pick] = remaining[remaining.length - 1];
        remaining.pop();
        e.set('shuffleMap', remaining);
        e.set('lastShuffleCase', chosen);
      }
    }),
  ],
  outputs: [...caseOutputs, { name: 'OnDefault', kind: 'variant' }],
  spawn: (e) => {
    e.set('lastShuffleCase', -1);
    e.set('shuffleMap', []);
  },
};

// ── logic_compare ──────────────────────────────────────────────────────────
function doCompare(entity: Entity, activator: Entity | null, inValue: number): void {
  const cmp = entity.getNumber('comparevalue', 0);
  if (inValue === cmp) {
    fireValue(entity, 'OnEqualTo', inValue, activator);
  } else {
    fireValue(entity, 'OnNotEqualTo', inValue, activator);
    if (inValue > cmp) fireValue(entity, 'OnGreaterThan', inValue, activator);
    else fireValue(entity, 'OnLessThan', inValue, activator);
  }
}

export const LogicCompareClass: EntityClass = {
  name: 'logic_compare',
  base: 'logical',
  keyfields: [
    { name: 'CompareValue', type: 'float', defaultValue: 0 },
    { name: 'InitialValue', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    { name: 'SetValue', type: FIELD_FLOAT, key: 'invalue' },
    input('SetValueCompare', FIELD_FLOAT, (e, d) => {
      e.set('invalue', d.value.float());
      doCompare(e, d.activator as Entity | null, d.value.float());
    }),
    { name: 'SetCompareValue', type: FIELD_FLOAT, key: 'comparevalue' },
    input('Compare', FIELD_VOID, (e, d) => doCompare(e, d.activator as Entity | null, e.getNumber('invalue', 0))),
  ],
  outputs: [
    { name: 'OnEqualTo', kind: 'float' },
    { name: 'OnNotEqualTo', kind: 'float' },
    { name: 'OnGreaterThan', kind: 'float' },
    { name: 'OnLessThan', kind: 'float' },
  ],
  spawn: (e) => e.set('invalue', e.getNumber('initialvalue', 0)),
};

// ── logic_branch / logic_branch_listener ───────────────────────────────────
function updateBranchValue(entity: Entity, newValue: boolean, activator: Entity | null, fireOutputs: boolean): void {
  if (entity.getBool('invalue', false) !== newValue) {
    entity.set('invalue', newValue);
    // 只有值真的变了才通知 listeners（logicentities.cpp:2308-2322）
    for (const listener of entity.get<Entity[]>('listeners') ?? []) {
      g_Runtime.eventQueue?.addEventForEntityVoid(listener, '_OnLogicBranchChanged', 0, entity, entity);
    }
  }
  if (fireOutputs) fire(entity, newValue ? 'OnTrue' : 'OnFalse', activator);
}

export const LogicBranchClass: EntityClass = {
  name: 'logic_branch',
  base: 'logical',
  keyfields: [{ name: 'InitialValue', type: 'bool', defaultValue: false }],
  inputs: [
    input('SetValue', FIELD_BOOLEAN, (e, d) => updateBranchValue(e, d.value.bool(), d.activator as Entity | null, false)),
    input('SetValueTest', FIELD_BOOLEAN, (e, d) => updateBranchValue(e, d.value.bool(), d.activator as Entity | null, true)),
    input('Toggle', FIELD_VOID, (e, d) => updateBranchValue(e, !e.getBool('invalue', false), d.activator as Entity | null, false)),
    input('ToggleTest', FIELD_VOID, (e, d) => updateBranchValue(e, !e.getBool('invalue', false), d.activator as Entity | null, true)),
    input('Test', FIELD_VOID, (e, d) => fire(e, e.getBool('invalue', false) ? 'OnTrue' : 'OnFalse', d.activator as Entity | null)),
  ],
  outputs: [
    { name: 'OnTrue', kind: 'event' },
    { name: 'OnFalse', kind: 'event' },
  ],
  spawn: (e) => {
    e.set('invalue', e.getBool('initialvalue', false));
    e.set('listeners', [] as Entity[]);
  },
};

const LOGIC_BRANCH_NOT_INIT = 0;
const LOGIC_BRANCH_ALL_TRUE = 1;
const LOGIC_BRANCH_ALL_FALSE = 2;
const LOGIC_BRANCH_MIXED = 3;

function doBranchTest(entity: Entity, activator: Entity | null): void {
  const branches = entity.get<Entity[]>('branchList') ?? [];
  let oneTrue = false;
  let oneFalse = false;
  for (const b of branches) {
    if (b && !b.markedForDeletion && b.getBool('invalue', false)) oneTrue = true;
    else oneFalse = true;
  }
  const last = entity.getNumber('lastState', LOGIC_BRANCH_NOT_INIT);
  if (oneTrue && !oneFalse) {
    if (last !== LOGIC_BRANCH_ALL_TRUE) {
      fire(entity, 'OnAllTrue', activator);
      entity.set('lastState', LOGIC_BRANCH_ALL_TRUE);
    }
  } else if (oneFalse && !oneTrue) {
    if (last !== LOGIC_BRANCH_ALL_FALSE) {
      fire(entity, 'OnAllFalse', activator);
      entity.set('lastState', LOGIC_BRANCH_ALL_FALSE);
    }
  } else if (last !== LOGIC_BRANCH_MIXED) {
    fire(entity, 'OnMixed', activator);
    entity.set('lastState', LOGIC_BRANCH_MIXED);
  }
}

export const LogicBranchListenerClass: EntityClass = {
  name: 'logic_branch_listener',
  base: 'logical',
  keyfields: Array.from({ length: 16 }, (_, i) => ({
    name: `Branch${String(i + 1).padStart(2, '0')}`,
    type: 'string' as const,
    defaultValue: '',
  })),
  inputs: [
    input('Test', FIELD_INPUT, (e, d) => {
      e.set('lastState', LOGIC_BRANCH_NOT_INIT); // 强制下次一定 fire
      doBranchTest(e, d.activator as Entity | null);
    }),
    input('_OnLogicBranchChanged', FIELD_INPUT, (e, d) => doBranchTest(e, d.activator as Entity | null)),
    input('_OnLogicBranchRemoved', FIELD_INPUT, (e, d) => {
      const list = e.get<Entity[]>('branchList') ?? [];
      const i = list.indexOf(d.activator as Entity);
      if (i >= 0) list.splice(i, 1);
      doBranchTest(e, d.activator as Entity | null);
    }),
  ],
  outputs: [
    { name: 'OnAllTrue', kind: 'event' },
    { name: 'OnAllFalse', kind: 'event' },
    { name: 'OnMixed', kind: 'event' },
  ],
  activate: (e) => {
    const list: Entity[] = [];
    for (let i = 1; i <= 16; i++) {
      const name = e.getString(`branch${String(i).padStart(2, '0')}`, '');
      if (!name) continue;
      for (const ent of findAllByName(name)) {
        if (ent.classname !== 'logic_branch') continue;
        const listeners = ent.get<Entity[]>('listeners') ?? [];
        if (!listeners.includes(e)) listeners.push(e);
        ent.set('listeners', listeners);
        if (!list.includes(ent)) list.push(ent);
      }
    }
    e.set('branchList', list);
    e.set('lastState', LOGIC_BRANCH_NOT_INIT);
  },
};

// ── logic_timer (CTimerEntity) ─────────────────────────────────────────────
const SF_TIMER_UPDOWN = 1;
const LOGIC_TIMER_MIN_INTERVAL = 0.01;

function resetTimer(entity: Entity): void {
  if (entity.getNumber('disabled', 0) !== 0) return;
  let refire = entity.getNumber('refiretime', 0);
  if (entity.getNumber('userandomtime', 0) !== 0) {
    const lo = entity.getNumber('lowerrandombound', 0);
    const hi = entity.getNumber('upperrandombound', 0);
    refire = lo + Math.random() * (hi - lo);
    entity.set('refiretime', refire);
  }
  entity.setThink(fireTimer, refire);
}

function fireTimer(entity: Entity): void {
  if (entity.getNumber('disabled', 0) !== 0) return;
  if (entity.hasSpawnFlags(SF_TIMER_UPDOWN)) {
    if (entity.getBool('updownstate', false)) fire(entity, 'OnTimerHigh', entity);
    else fire(entity, 'OnTimerLow', entity);
    entity.set('updownstate', !entity.getBool('updownstate', false));
  } else {
    fire(entity, 'OnTimer', entity);
  }
  resetTimer(entity);
}

function setTimerDisabled(entity: Entity, disabled: boolean): void {
  entity.set('disabled', disabled ? 1 : 0);
  if (disabled) entity.clearThink();
  else resetTimer(entity);
}

export const LogicTimerClass: EntityClass = {
  name: 'logic_timer',
  base: 'logical',
  spawnFlags: { UPDOWN: SF_TIMER_UPDOWN },
  keyfields: [
    { name: 'StartDisabled', type: 'int', defaultValue: 0 },
    { name: 'RefireTime', type: 'float', defaultValue: 0 },
    { name: 'UseRandomTime', type: 'int', defaultValue: 0 },
    { name: 'LowerRandomBound', type: 'float', defaultValue: 0 },
    { name: 'UpperRandomBound', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    input('RefireTime', FIELD_FLOAT, (e, d) => {
      const v = Math.max(d.value.float(), LOGIC_TIMER_MIN_INTERVAL);
      if (e.getNumber('refiretime', 0) !== v) {
        e.set('refiretime', v);
        resetTimer(e);
      }
    }),
    { name: 'FireTimer', type: FIELD_VOID, handler: (e) => fireTimer(e) },
    { name: 'Enable', type: FIELD_VOID, handler: (e) => setTimerDisabled(e, false) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => setTimerDisabled(e, true) },
    input('Toggle', FIELD_VOID, (e) => setTimerDisabled(e, e.getNumber('disabled', 0) === 0)),
    input('AddToTimer', FIELD_FLOAT, (e, d) => {
      if (e.getNumber('disabled', 0) !== 0) return;
      e.nextThink += d.value.float();
    }),
    input('SubtractFromTimer', FIELD_FLOAT, (e, d) => {
      if (e.getNumber('disabled', 0) !== 0) return;
      const v = d.value.float();
      if (e.nextThink - e.runtime.now() <= v) e.nextThink = e.runtime.now();
      else e.nextThink -= v;
    }),
    input('ResetTimer', FIELD_VOID, (e) => resetTimer(e)),
    { name: 'UseRandomTime', type: FIELD_INTEGER, key: 'userandomtime' },
    { name: 'LowerRandomBound', type: FIELD_FLOAT, key: 'lowerrandombound' },
    { name: 'UpperRandomBound', type: FIELD_FLOAT, key: 'upperrandombound' },
  ],
  outputs: [
    { name: 'OnTimer', kind: 'event' },
    { name: 'OnTimerHigh', kind: 'event' },
    { name: 'OnTimerLow', kind: 'event' },
  ],
  spawn: (e) => {
    let refire = e.getNumber('refiretime', 0);
    if (e.getNumber('userandomtime', 0) === 0 && refire < LOGIC_TIMER_MIN_INTERVAL) {
      refire = LOGIC_TIMER_MIN_INTERVAL;
      e.set('refiretime', refire);
    }
    e.set('disabled', e.getNumber('startdisabled', 0));
    setTimerDisabled(e, e.getNumber('disabled', 0) !== 0 || !(refire > 0 || e.getNumber('userandomtime', 0) !== 0));
  },
};

// ── logic_auto ─────────────────────────────────────────────────────────────
const SF_AUTO_FIREONCE = 0x01;

/** 地图加载类型；宿主可设置。浏览器里固定 NewGame + MultiNewMap。 */
export type MapLoadType = 'newgame' | 'loadgame' | 'transition' | 'background';
export const mapLoad: { type: MapLoadType; multiplayer: boolean; roundRestart: boolean } = {
  type: 'newgame',
  multiplayer: true,
  roundRestart: false,
};

export const LogicAutoClass: EntityClass = {
  name: 'logic_auto',
  base: 'base',
  spawnFlags: { FIREONCE: SF_AUTO_FIREONCE },
  keyfields: [{ name: 'globalstate', type: 'string', defaultValue: '' }],
  outputs: [
    { name: 'OnMapSpawn', kind: 'event' },
    { name: 'OnNewGame', kind: 'event' },
    { name: 'OnLoadGame', kind: 'event' },
    { name: 'OnMapTransition', kind: 'event' },
    { name: 'OnBackgroundMap', kind: 'event' },
    { name: 'OnMultiNewMap', kind: 'event' },
    { name: 'OnMultiNewRound', kind: 'event' },
  ],
  activate: (e) => {
    e.setThink((self) => {
      const gs = self.getString('globalstate', '');
      if (gs && globalStates.get(gs)?.state !== 'on') return;
      switch (mapLoad.type) {
        case 'transition': self.fire('OnMapTransition', null, self); break;
        case 'newgame': self.fire('OnNewGame', null, self); break;
        case 'loadgame': self.fire('OnLoadGame', null, self); break;
        case 'background': self.fire('OnBackgroundMap', null, self); break;
      }
      self.fire('OnMapSpawn', null, self);
      if (mapLoad.multiplayer) {
        self.fire(mapLoad.roundRestart ? 'OnMultiNewRound' : 'OnMultiNewMap', null, self);
      }
      if (self.hasSpawnFlags(SF_AUTO_FIREONCE)) self.remove();
    }, 0.2);
  },
};

// ── env_global ─────────────────────────────────────────────────────────────
export const EnvGlobalClass: EntityClass = {
  name: 'env_global',
  base: 'logical',
  keyfields: [
    { name: 'globalstate', type: 'string', defaultValue: '' },
    { name: 'initialstate', type: 'int', defaultValue: 0 },
    { name: 'counter', type: 'int', defaultValue: 0 },
  ],
  inputs: [
    input('TurnOn', FIELD_VOID, (e) => { const n = e.getString('globalstate', ''); if (n) globalState(n).state = 'on'; }),
    input('TurnOff', FIELD_VOID, (e) => { const n = e.getString('globalstate', ''); if (n) globalState(n).state = 'off'; }),
    input('Remove', FIELD_VOID, (e) => { const n = e.getString('globalstate', ''); if (n) globalState(n).state = 'dead'; }),
    input('Toggle', FIELD_VOID, (e) => {
      const n = e.getString('globalstate', '');
      if (!n) return;
      const s = globalState(n);
      if (s.state === 'dead') return;
      s.state = s.state === 'on' ? 'off' : 'on';
    }),
    input('SetCounter', FIELD_INTEGER, (e, d) => { const n = e.getString('globalstate', ''); if (n) globalState(n).counter = d.value.int(); }),
    input('AddToCounter', FIELD_INTEGER, (e, d) => { const n = e.getString('globalstate', ''); if (n) globalState(n).counter += d.value.int(); }),
    input('GetCounter', FIELD_VOID, (e, d) => {
      const n = e.getString('globalstate', '');
      fireValue(e, 'Counter', n ? globalState(n).counter : 0, d.activator as Entity | null);
    }),
  ],
  outputs: [{ name: 'Counter', kind: 'int' }],
  spawn: (e) => {
    const n = e.getString('globalstate', '');
    if (!n) { e.remove(); return; }
    if (!globalStates.has(n)) {
      globalStates.set(n, {
        state: e.hasSpawnFlags(1) ? (e.getNumber('initialstate', 0) === 1 ? 'on' : 'off') : 'off',
        counter: 0,
      });
    }
    if (e.getNumber('counter', 0) !== 0) globalState(n).counter = e.getNumber('counter', 0);
  },
};

// ── multisource（旧式「全部触发」主实体） ──────────────────────────────────
export const MultiSourceClass: EntityClass = {
  name: 'multisource',
  base: 'logical',
  keyfields: [{ name: 'globalstate', type: 'string', defaultValue: '' }],
  outputs: [{ name: 'OnTrigger', kind: 'event' }],
  use: (e, activator, caller) => {
    const members = e.get<Entity[]>('members') ?? [];
    let idx = members.indexOf(caller as Entity);
    if (idx < 0) { members.push(caller as Entity); idx = members.length - 1; e.set('members', members); }
    const triggered = e.get<boolean[]>('triggered') ?? [];
    triggered[idx] = !triggered[idx]; // Use 总是翻转（logicentities.cpp:1312-1321）
    e.set('triggered', triggered);
    const all = members.length > 0 && triggered.slice(0, members.length).every(Boolean);
    const gs = e.getString('globalstate', '');
    if (all && (!gs || globalStates.get(gs)?.state === 'on')) {
      fire(e, 'OnTrigger', (activator as Entity) ?? null);
    }
  },
  spawn: (e) => {
    e.set('members', [] as Entity[]);
    e.set('triggered', [] as boolean[]);
  },
};

// ── 其余有 I/O 的逻辑实体 ──────────────────────────────────────────────────
export const LogicMulticompareClass: EntityClass = {
  name: 'logic_multicompare',
  base: 'logical',
  keyfields: [
    { name: 'IntegerValue', type: 'int', defaultValue: 0 },
    { name: 'ShouldComparetoValue', type: 'int', defaultValue: 0 },
  ],
  inputs: [
    input('InputValue', FIELD_INPUT, (e, d) => {
      const vals = e.get<number[]>('values') ?? [];
      vals.push(d.value.int());
      e.set('values', vals);
      if (!e.getBool('updatedThisFrame', false)) {
        e.set('updatedThisFrame', true);
        g_Runtime.eventQueue?.addEventForEntityVoid(e, 'CompareValues', 0, d.activator as Entity, e);
      }
    }),
    input('CompareValues', FIELD_VOID, (e, d) => {
      e.set('updatedThisFrame', false);
      const vals = e.get<number[]>('values') ?? [];
      e.set('values', []);
      let base = e.getNumber('integervalue', 0);
      if (e.getNumber('shouldcomparetovalue', 0) === 0 && vals.length > 0) base = vals[0];
      const equal = vals.every((v) => v === base);
      fire(e, equal ? 'OnEqual' : 'OnNotEqual', d.activator as Entity | null);
    }),
  ],
  outputs: [
    { name: 'OnEqual', kind: 'event' },
    { name: 'OnNotEqual', kind: 'event' },
  ],
};

export const LogicEventListenerClass: EntityClass = {
  name: 'logic_eventlistener',
  base: 'logical',
  keyfields: [
    { name: 'EventName', type: 'string', defaultValue: '' },
    { name: 'FetchEventData', type: 'bool', defaultValue: false },
    { name: 'IsEnabled', type: 'bool', defaultValue: true },
    { name: 'TeamNum', type: 'int', defaultValue: 0 },
  ],
  inputs: [
    { name: 'Enable', type: FIELD_VOID, handler: (e) => e.set('isenabled', true) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => e.set('isenabled', false) },
  ],
  outputs: [{ name: 'OnEventFired', kind: 'event' }],
};

export const PointTemplateClass: EntityClass = {
  name: 'point_template',
  base: 'point',
  keyfields: Array.from({ length: 16 }, (_, i) => ({
    name: `Template${String(i + 1).padStart(2, '0')}`,
    type: 'string' as const,
    defaultValue: '',
  })),
  inputs: [
    input('ForceSpawn', FIELD_VOID, (e, d) => {
      // 浏览器宿主不做实体模板实例化；输出与事件仍按 SDK 触发，宿主可据此自行 spawn。
      e.runtime.emit({ kind: 'templateSpawn', detail: e.targetname });
      fire(e, 'OnEntitySpawned', d.activator as Entity | null);
    }),
  ],
  outputs: [{ name: 'OnEntitySpawned', kind: 'event' }],
};

/** 通用"有 I/O 但不建模内部状态"的逻辑实体：保证连接不丢、可被 fire。 */
const PLAIN_LOGIC = [
  'logic_achievement', 'logic_navigation', 'logic_mirror_movement',
  'logic_measure_movement', 'logic_playerproxy', 'logic_script',
  'logic_game_event_listener', 'logic_collision_pair',
];

export function registerLogicClasses(): void {
  const list: EntityClass[] = [
    LogicRelayClass, MathCounterClass, LogicCaseClass, LogicCompareClass,
    LogicBranchClass, LogicBranchListenerClass, LogicTimerClass, LogicAutoClass,
    EnvGlobalClass, MultiSourceClass, LogicMulticompareClass,
    LogicEventListenerClass, PointTemplateClass,
  ];
  for (const cls of list) registerClass(cls);
  for (const name of PLAIN_LOGIC) registerClass({ name, base: 'logical' });
  // 常见别名：Source 不同分支的注册名差异，统一映射到已实现的类族。
  registerClass({ ...LogicBranchListenerClass, name: 'logic_branch_list' });
}
