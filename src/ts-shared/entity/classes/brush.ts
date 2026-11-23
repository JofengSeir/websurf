/**
 * brush 实体与可交互实体家族。对照 Source SDK 2013：
 * - `game/server/buttons.cpp:24-32 / 63-74 / 210-263 / 359-455 / 704-773`（CBaseButton）
 * - `game/server/doors.cpp:66-82 / 821-883 / 1005-1130 / 1173-1186`（CBaseDoor）
 * - `game/server/modelentities.cpp:20-197`（CFuncBrush）
 * - `game/server/bmodels.cpp:95-189`（func_wall_toggle）
 *
 * 按钮与门共用 `CBaseToggle` 的 TS_* 状态机：
 * `OnPressed → OnIn → (wait) → OnOut`（按钮）、
 * `OnOpen → OnFullyOpen → (wait) → OnClose → OnFullyClosed`（门）。
 * 这正是「按顺序触发才能前往下一个地方」的引擎侧机制：门不会自己开，
 * 由地图的 I/O 连接图决定谁在什么时候给它 `Open`。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_FLOAT, FIELD_STRING, FIELD_VOID } from '../variant.js';
import { fire, input } from './common.js';
import { registerClass } from './registry.js';

const SF_BUTTON = {
  DONTMOVE: 1,
  TOGGLE: 32,
  TOUCH_ACTIVATES: 256,
  DAMAGE_ACTIVATES: 512,
  USE_ACTIVATES: 1024,
  LOCKED: 2048,
  SPARK_IF_OFF: 4096,
  JIGGLE_ON_USE_LOCKED: 8192,
};

const TS_AT_BOTTOM = 0;
const TS_GOING_UP = 1;
const TS_AT_TOP = 2;
const TS_GOING_DOWN = 3;

// ── func_button ────────────────────────────────────────────────────────────
function buttonReturn(entity: Entity): void {
  entity.set('toggleState', TS_GOING_DOWN);
  entity.setThink((e) => {
    e.set('toggleState', TS_AT_BOTTOM);
    fire(e, 'OnOut', e.get<Entity | null>('activator') ?? null);
  }, Math.max(entity.getNumber('speed', 0) > 0 ? entity.getNumber('distance', 0) / entity.getNumber('speed', 40) : 0.1, 0));
}

function buttonActivate(entity: Entity, activator: Entity | null): void {
  entity.set('activator', activator);
  entity.set('toggleState', TS_GOING_UP);
  entity.setThink((e) => {
    e.set('toggleState', TS_AT_TOP);
    fire(e, 'OnIn', e.get<Entity | null>('activator') ?? null);
    const stayPushed = e.getNumber('wait', 1) === -1 || e.hasSpawnFlags(SF_BUTTON.TOGGLE);
    if (!stayPushed) e.setThink(buttonReturn, e.getNumber('wait', 1));
  }, 0.1);
}

/** `CBaseButton::Press`（buttons.cpp:210-263）。 */
function press(entity: Entity, activator: Entity | null, code: 'press' | 'activate' | 'return'): void {
  const state = entity.getNumber('toggleState', TS_AT_BOTTOM);
  if (code === 'press' && (state === TS_GOING_UP || state === TS_GOING_DOWN)) return;
  if (code === 'activate' && (state === TS_GOING_UP || state === TS_AT_TOP)) return;
  if (code === 'return' && (state === TS_GOING_DOWN || state === TS_AT_BOTTOM)) return;
  if (entity.getBool('locked', false)) return; // locked 只播音，不发输出

  if ((code === 'press' && state === TS_AT_TOP) || (code === 'return' && (state === TS_AT_TOP || state === TS_GOING_UP))) {
    fire(entity, 'OnPressed', activator);
    buttonReturn(entity);
  } else if (code === 'press' || (code === 'activate' && (state === TS_AT_BOTTOM || state === TS_GOING_DOWN))) {
    fire(entity, 'OnPressed', activator);
    buttonActivate(entity, activator);
  }
}

export const FuncButtonClass: EntityClass = {
  name: 'func_button',
  base: 'base_toggle',
  brush: true,
  spawnFlags: SF_BUTTON,
  keyfields: [
    { name: 'wait', type: 'float', defaultValue: 0 },
    { name: 'speed', type: 'float', defaultValue: 0 },
    { name: 'lip', type: 'float', defaultValue: 0 },
    { name: 'health', type: 'int', defaultValue: 0 },
    { name: 'locked', type: 'bool', defaultValue: false },
  ],
  inputs: [
    { name: 'Lock', type: FIELD_VOID, handler: (e) => e.set('locked', true) },
    { name: 'Unlock', type: FIELD_VOID, handler: (e) => e.set('locked', false) },
    input('Press', FIELD_VOID, (e, d) => press(e, d.activator as Entity | null, 'press')),
    input('PressIn', FIELD_VOID, (e, d) => press(e, d.activator as Entity | null, 'activate')),
    input('PressOut', FIELD_VOID, (e, d) => press(e, d.activator as Entity | null, 'return')),
  ],
  outputs: [
    { name: 'OnDamaged', kind: 'event' },
    { name: 'OnPressed', kind: 'event' },
    { name: 'OnUseLocked', kind: 'event' },
    { name: 'OnIn', kind: 'event' },
    { name: 'OnOut', kind: 'event' },
  ],
  spawn: (e) => {
    if (e.getNumber('speed', 0) === 0) e.set('speed', 40);
    if (e.getNumber('wait', 0) === 0) e.set('wait', 1);
    if (e.getNumber('lip', 0) === 0) e.set('lip', 4);
    e.set('toggleState', TS_AT_BOTTOM);
    e.set('locked', e.hasSpawnFlags(SF_BUTTON.LOCKED));
  },
  use: (e, activator) => {
    if (e.getBool('locked', false)) {
      // OnUseLocked 带 0.5s 节流（buttons.cpp:495-507）
      const last = e.getNumber('lastUseLocked', -1);
      if (e.runtime.now() - last > 0.5) {
        e.set('lastUseLocked', e.runtime.now());
        fire(e, 'OnUseLocked', activator);
      }
      return;
    }
    press(e, activator, 'press');
  },
  // CBaseButton::Spawn 里 SetTouch(&CBaseButton::ButtonTouch)：只有 Touch，
  // 没有 StartTouch/EndTouch。touch 引擎每帧对接触中的实体调它，press 自带状态去重。
  touch: (e, other) => {
    if (!e.hasSpawnFlags(SF_BUTTON.TOUCH_ACTIVATES)) return;
    if (!other.isPlayer()) return;
    press(e, other, 'press');
  },
};

// ── func_door ──────────────────────────────────────────────────────────────
const SF_DOOR_NO_AUTO_RETURN = 32;
const SF_DOOR_START_OPEN_OBSOLETE = 512;

function doorHitBottom(entity: Entity): void {
  entity.set('toggleState', TS_AT_BOTTOM);
  if (entity.hasSpawnFlags(SF_DOOR_START_OPEN_OBSOLETE)) fire(entity, 'OnFullyOpen', entity.get<Entity | null>('activator') ?? null);
  else fire(entity, 'OnFullyClosed', entity.get<Entity | null>('activator') ?? null);
}

function doorGoDown(entity: Entity): void {
  entity.set('toggleState', TS_GOING_DOWN);
  fire(entity, 'OnClose', entity);
  entity.setThink(doorHitBottom, 0.1);
  entity.runtime.host.setBrushEnabled?.(entity.index, true);
}

function doorHitTop(entity: Entity): void {
  entity.set('toggleState', TS_AT_TOP);
  if (!entity.hasSpawnFlags(SF_DOOR_NO_AUTO_RETURN)) {
    const wait = entity.getNumber('wait', 3);
    if (wait !== -1) entity.setThink(doorGoDown, wait);
  }
  if (entity.hasSpawnFlags(SF_DOOR_START_OPEN_OBSOLETE)) fire(entity, 'OnFullyClosed', entity);
  else fire(entity, 'OnFullyOpen', entity);
  entity.runtime.host.setBrushEnabled?.(entity.index, false);
}

function doorGoUp(entity: Entity): void {
  entity.set('toggleState', TS_GOING_UP);
  fire(entity, 'OnOpen', entity);
  entity.setThink(doorHitTop, 0.1);
}

export const FuncDoorClass: EntityClass = {
  name: 'func_door',
  base: 'base_toggle',
  brush: true,
  spawnFlags: {
    NO_AUTO_RETURN: SF_DOOR_NO_AUTO_RETURN,
    START_OPEN_OBSOLETE: SF_DOOR_START_OPEN_OBSOLETE,
    PTOUCH: 256,
    PUSE: 1024,
  },
  keyfields: [
    { name: 'wait', type: 'float', defaultValue: 3 },
    { name: 'speed', type: 'float', defaultValue: 100 },
    { name: 'lip', type: 'float', defaultValue: 0 },
    { name: 'locked', type: 'bool', defaultValue: false },
  ],
  inputs: [
    input('Open', FIELD_VOID, (e, d) => {
      const state = e.getNumber('toggleState', TS_AT_BOTTOM);
      if (state === TS_AT_TOP || state === TS_GOING_UP) return;
      if (e.getBool('locked', false)) return;
      e.set('activator', d.activator as Entity | null);
      doorGoUp(e);
    }),
    input('Close', FIELD_VOID, (e, d) => {
      // Close 不受锁限制（doors.cpp:821-825）
      if (e.getNumber('toggleState', TS_AT_BOTTOM) !== TS_AT_BOTTOM) {
        e.set('activator', d.activator as Entity | null);
        doorGoDown(e);
      }
    }),
    input('Toggle', FIELD_VOID, (e, d) => {
      if (e.getBool('locked', false)) return;
      const state = e.getNumber('toggleState', TS_AT_BOTTOM);
      e.set('activator', d.activator as Entity | null);
      if (state === TS_AT_BOTTOM) doorGoUp(e);
      else if (state === TS_AT_TOP) doorGoDown(e);
    }),
    { name: 'Lock', type: FIELD_VOID, handler: (e) => e.set('locked', true) },
    { name: 'Unlock', type: FIELD_VOID, handler: (e) => e.set('locked', false) },
    { name: 'SetSpeed', type: FIELD_FLOAT, key: 'speed' },
    { name: 'SetToggleState', type: FIELD_FLOAT, key: 'toggleState' },
  ],
  outputs: [
    { name: 'OnBlockedOpening', kind: 'event' },
    { name: 'OnBlockedClosing', kind: 'event' },
    { name: 'OnUnblockedOpening', kind: 'event' },
    { name: 'OnUnblockedClosing', kind: 'event' },
    { name: 'OnFullyClosed', kind: 'event' },
    { name: 'OnFullyOpen', kind: 'event' },
    { name: 'OnClose', kind: 'event' },
    { name: 'OnOpen', kind: 'event' },
    { name: 'OnLockedUse', kind: 'event' },
  ],
  spawn: (e) => {
    e.set('toggleState', TS_AT_BOTTOM);
    e.set('locked', e.getBool('locked', false));
  },
  use: (e, activator) => {
    if (e.getBool('locked', false)) { fire(e, 'OnLockedUse', activator); return; }
    // DoorTouch：按当前状态走 Open / Close
    const state = e.getNumber('toggleState', TS_AT_BOTTOM);
    e.set('activator', activator);
    if (state === TS_AT_BOTTOM) doorGoUp(e);
    else if (state === TS_AT_TOP) doorGoDown(e);
  },
};

// ── func_brush / func_wall_toggle（Enable/Disable/Toggle 三件套） ────────────
function brushSetEnabled(entity: Entity, enabled: boolean, applyHost = true): void {
  if (entity.getBool('brushOn', true) === enabled) return;
  entity.set('brushOn', enabled);
  entity.disabled = !enabled;
  if (applyHost) entity.runtime.host.setBrushEnabled?.(entity.index, enabled);
}

export const FuncBrushClass: EntityClass = {
  name: 'func_brush',
  base: 'base',
  brush: true,
  keyfields: [
    { name: 'StartDisabled', type: 'int', defaultValue: 0 },
    { name: 'Solidity', type: 'int', defaultValue: 0 },
    { name: 'solidbsp', type: 'bool', defaultValue: false },
    { name: 'excludednpc', type: 'string', defaultValue: '' },
    { name: 'invert_exclusion', type: 'bool', defaultValue: false },
  ],
  inputs: [
    { name: 'Enable', type: FIELD_VOID, handler: (e) => brushSetEnabled(e, true) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => brushSetEnabled(e, false) },
    input('Toggle', FIELD_VOID, (e) => brushSetEnabled(e, !e.getBool('brushOn', true))),
    { name: 'SetExcluded', type: FIELD_STRING, key: 'excludednpc' },
  ],
  spawn: (e) => {
    // SDK 语义：`StartDisabled`（键值）与 spawnflags 的 `START_OFF` 都表示出生即关闭。
    // START_OFF 之前只有声明、没有消费点（ze_cursed 的 lvl3_wt03 就是这种实体），
    // 结果本应「要开了才出现」的墙载图时就可见。派生类 spawn 先于基类执行，
    // 所以两件事必须写在同一处，避免子类先设 false、基类又按 StartDisabled 设回 true。
    const startOffBit = e.spawnFlagOf('START_OFF');
    const startOff = startOffBit !== 0 && e.hasSpawnFlags(startOffBit);
    brushSetEnabled(e, e.getNumber('startdisabled', 0) === 0 && !startOff, false);
  },
};

export const FuncWallToggleClass: EntityClass = {
  name: 'func_wall_toggle',
  base: 'func_brush',
  brush: true,
  spawnFlags: { START_OFF: 1 },
  inputs: [{ name: 'Toggle', type: FIELD_VOID, handler: (e) => brushSetEnabled(e, !e.getBool('brushOn', true)) }],
};

// ── func_movelinear / func_rotating / func_breakable ────────────────────────
export const FuncMovelinearClass: EntityClass = {
  name: 'func_movelinear',
  base: 'base_toggle',
  brush: true,
  keyfields: [
    { name: 'movedir', type: 'vec3', defaultValue: [0, 0, 0] as [number, number, number] },
    { name: 'movedistance', type: 'float', defaultValue: 0 },
    { name: 'speed', type: 'float', defaultValue: 0 },
    { name: 'StartPosition', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    input('Open', FIELD_VOID, (e, d) => {
      fire(e, 'OnOpen', d.activator as Entity | null);
      e.setThink((self) => fire(self, 'OnFullyOpen', d.activator as Entity | null), 0.1);
    }),
    input('Close', FIELD_VOID, (e, d) => {
      fire(e, 'OnClose', d.activator as Entity | null);
      e.setThink((self) => fire(self, 'OnFullyClosed', d.activator as Entity | null), 0.1);
    }),
    { name: 'SetSpeed', type: FIELD_FLOAT, key: 'speed' },
    { name: 'SetPosition', type: FIELD_FLOAT, key: 'startposition' },
  ],
  outputs: [
    { name: 'OnFullyOpen', kind: 'event' },
    { name: 'OnFullyClosed', kind: 'event' },
    { name: 'OnOpen', kind: 'event' },
    { name: 'OnClose', kind: 'event' },
  ],
};

export const FuncRotatingClass: EntityClass = {
  name: 'func_rotating',
  base: 'base',
  brush: true,
  keyfields: [
    { name: 'spawnorigin', type: 'vec3', defaultValue: [0, 0, 0] as [number, number, number] },
    { name: 'speed', type: 'float', defaultValue: 0 },
    { name: 'fanfriction', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    { name: 'Start', type: FIELD_VOID, handler: (e) => e.set('rotating', true) },
    { name: 'Stop', type: FIELD_VOID, handler: (e) => e.set('rotating', false) },
    { name: 'SetSpeed', type: FIELD_FLOAT, key: 'speed' },
    input('Toggle', FIELD_VOID, (e) => e.set('rotating', !e.getBool('rotating', false))),
  ],
};

export const FuncBreakableClass: EntityClass = {
  name: 'func_breakable',
  base: 'base',
  brush: true,
  keyfields: [
    { name: 'health', type: 'int', defaultValue: 1 },
    { name: 'material', type: 'int', defaultValue: 0 },
    { name: 'explodemagnitude', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    input('Break', FIELD_VOID, (e, d) => {
      fire(e, 'OnBreak', d.activator as Entity | null);
      e.set('broken', true);
    }),
    { name: 'SetHealth', type: FIELD_FLOAT, key: 'health' },
    { name: 'AddHealth', type: FIELD_FLOAT, handler: (e, d) => e.set('health', e.getNumber('health', 0) + d.value.float()) },
    { name: 'RemoveHealth', type: FIELD_FLOAT, handler: (e, d) => e.set('health', e.getNumber('health', 0) - d.value.float()) },
  ],
  outputs: [
    { name: 'OnBreak', kind: 'event' },
    { name: 'OnHealthChanged', kind: 'float' },
    { name: 'OnTakeDamage', kind: 'event' },
  ],
};

/** 纯几何 / 无 I/O 的 brush 实体：仍注册为 brush 类，保证体积可查询。 */
const PLAIN_BRUSH = [
  'func_wall', 'func_illusionary', 'func_physbox', 'func_physbox_multiplayer',
  'func_areaportal', 'func_occluder', 'func_dustmotes', 'func_dustcloud',
  'func_precipitation', 'func_lod', 'func_ladderendpoint', 'func_buyzone',
  'func_bomb_target', 'func_hostage_rescue', 'func_nobuild', 'func_nogrenades',
  'func_smokevolume', 'func_soundscape', 'func_detail', 'func_viscluster',
  'func_instance', 'func_vehicleclip', 'func_clip_vphysics', 'func_guntarget',
];

export function registerBrushClasses(): void {
  for (const cls of [
    FuncButtonClass, FuncDoorClass, FuncBrushClass, FuncWallToggleClass,
    FuncMovelinearClass, FuncRotatingClass, FuncBreakableClass,
  ]) registerClass(cls);
  // 旋转门 / 移动门是 func_door 的子类（SDK 里 LINK_ENTITY_TO_CLASS 到同一实现族）
  registerClass({ ...FuncDoorClass, name: 'func_door_rotating' });
  registerClass({ ...FuncDoorClass, name: 'func_water_analog' });
  registerClass({ ...FuncButtonClass, name: 'func_rot_button' });
  registerClass({ ...FuncButtonClass, name: 'momentary_rot_button' });
  for (const name of PLAIN_BRUSH) registerClass({ name, base: 'base', brush: true });
}
