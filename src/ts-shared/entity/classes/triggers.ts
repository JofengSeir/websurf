/**
 * 触发器家族。对照 `game/server/triggers.cpp`：
 * - `CTriggerMultiple` `:924-1007`、`CTriggerOnce` `:1012-1027`
 * - `CTriggerHurt` `:656-900`
 * - `CTriggerTeleport` `:2349-2455`、`CTriggerTeleportRelative` `:2461-2477`
 * - `CTriggerPush` `:2207-2341`
 * - `CTriggerRemove` `:607-653`、`CTriggerGravity` `:2661-2693`
 * - `CTriggerImpact` `:4119-4203`
 *
 * 全部走 `BaseTriggerClass` 的 StartTouch/Touch/EndTouch 生命周期；这里只声明
 * 「这个类多了哪些输入/输出/键」以及它自己的 Touch 行为，没有任何地图专有分支。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_FLOAT, FIELD_VOID } from '../variant.js';
import { fire, findByName, fireValue, input, scheduleRemove } from './common.js';
import {
  SF_TRIGGER,
  baseTriggerEndTouch,
  defaultWait,
  passesTriggerFilters,
  removeSoon,
} from './base.js';
import { registerClass } from './registry.js';
import { bspYawToCsYaw } from '../../phys/angles.js';
import type { Vec3 } from '../types.js';

const DEG2RAD = Math.PI / 180;

/** Source `AngleVectors(pushdir)` → Y-up 世界方向（BSP `[x,y,z] → [y,z,x]`）。 */
export function pushDirToYup(angles: Vec3): Vec3 {
  const pitch = angles[0] * DEG2RAD;
  const yaw = angles[1] * DEG2RAD;
  const cp = Math.cos(pitch);
  const fx = cp * Math.cos(yaw);
  const fy = cp * Math.sin(yaw);
  const fz = -Math.sin(pitch);
  return [fy, fz, fx];
}

// ── trigger_multiple / trigger_once ────────────────────────────────────────
/** `CTriggerMultiple::ActivateMultiTrigger`（triggers.cpp:973-998）。 */
function activateMultiTrigger(entity: Entity, activator: Entity): void {
  if (entity.hasPendingThink()) return; // 唯一的冷却判据：GetNextThink() > curtime
  entity.set('__activator', activator);
  fire(entity, 'OnTrigger', activator);

  const wait = entity.getNumber('wait', 0);
  if (wait > 0) {
    entity.setThink(() => entity.clearThink(), wait);
  } else {
    // 不在 touch 回调里直接删自己；SetTouch(NULL) + 0.1s 后 SUB_Remove
    entity.set('touchDisabled', true);
    scheduleRemove(entity, 0.1);
  }
}

export const TriggerMultipleClass: EntityClass = {
  name: 'trigger_multiple',
  base: 'trigger',
  outputs: [{ name: 'OnTrigger', kind: 'event' }],
  spawn: (e) => {
    e.set('wait', defaultWait(e, 0.2));
  },
  touch: (e, other) => {
    if (e.getBool('touchDisabled', false)) return;
    if (!passesTriggerFilters(e, other)) return;
    activateMultiTrigger(e, other);
  },
};

export const TriggerOnceClass: EntityClass = {
  name: 'trigger_once',
  base: 'trigger_multiple',
  // SDK 2013 没有 CTriggerOnce::MultiTouch 重写，只是把 m_flWait 强制 -1
  // ⇒ 继承 MultiTouch → 走 m_flWait <= 0 分支 → 0.1s 后 SUB_Remove。
  spawn: (e) => {
    e.set('wait', -1);
  },
};

// ── trigger_hurt ───────────────────────────────────────────────────────────
const TRIGGER_HURT_FORGIVE_TIME = 3.0;

function hurtEntity(entity: Entity, other: Entity, damage: number): boolean {
  if (!other.isAlive() || !passesTriggerFilters(entity, other)) return false;
  const host = entity.runtime.host;
  host.damagePlayer(damage, entity.getNumber('damagetype', 0));
  if (other.isPlayer()) fire(entity, 'OnHurtPlayer', other);
  else fire(entity, 'OnHurt', other);
  const hurt = entity.get<Set<Entity>>('__hurtEntities') ?? new Set<Entity>();
  hurt.add(other);
  entity.set('__hurtEntities', hurt);
  return true;
}

/** `CTriggerHurt::HurtAllTouchers`（triggers.cpp:835-888）：遍历 touchlink，不是 touchingEntities。 */
function hurtAllTouchers(entity: Entity, dt: number): number {
  const damage = entity.getNumber('damage', 0) * dt;
  entity.get<Set<Entity>>('__hurtEntities')?.clear();
  let count = 0;
  for (const other of entity.touchLinks.keys()) {
    if (!other || other.markedForDeletion) continue;
    if (hurtEntity(entity, other, damage)) count++;
  }
  if (entity.getNumber('damagemodel', 0) === 1) {
    if (count === 0) {
      if (entity.runtime.now() > entity.getNumber('__dmgResetTime', 0)) {
        entity.set('damage', entity.getNumber('__originalDamage', 0));
      }
    } else {
      const cap = entity.getNumber('damagecap', 20);
      entity.set('damage', Math.min(entity.getNumber('damage', 0) * 2, cap));
      entity.set('__dmgResetTime', entity.runtime.now() + TRIGGER_HURT_FORGIVE_TIME);
    }
  }
  return count;
}

export const TriggerHurtClass: EntityClass = {
  name: 'trigger_hurt',
  base: 'trigger',
  keyfields: [
    { name: 'damage', type: 'float', defaultValue: 0 },
    { name: 'damagecap', type: 'float', defaultValue: 20 },
    { name: 'damagetype', type: 'int', defaultValue: 0 },
    { name: 'damagemodel', type: 'int', defaultValue: 0 },
    { name: 'nodmgforce', type: 'bool', defaultValue: false },
  ],
  inputs: [
    { name: 'SetDamage', type: FIELD_FLOAT, key: 'damage' },
  ],
  outputs: [
    { name: 'OnHurt', kind: 'event' },
    { name: 'OnHurtPlayer', kind: 'event' },
  ],
  spawn: (e) => {
    e.set('__originalDamage', e.getNumber('damage', 0));
    e.set('__hurtEntities', new Set<Entity>());
    e.clearThink();
  },
  touch: (e) => {
    // Touch 不直接伤害，只启动 0.5s 的 think（triggers.cpp:893-900）
    if (e.thinkFn !== null) return;
    const tick = (self: Entity): void => {
      const n = hurtAllTouchers(self, 0.5);
      if (n > 0) self.setThink(tick, 0.5);
      else self.clearThink();
    };
    e.setThink(tick, 0);
  },
  endTouch: (e, other) => {
    // 从未受伤的实体离开时补一次半额伤害，然后才调 BaseClass::EndTouch
    if (passesTriggerFilters(e, other)) {
      const hurt = e.get<Set<Entity>>('__hurtEntities');
      if (!hurt?.has(other)) hurtEntity(e, other, e.getNumber('damage', 0) * 0.5);
    }
    baseTriggerEndTouch(e, other);
  },
};

// ── trigger_teleport ───────────────────────────────────────────────────────
const SF_TELEPORT_PRESERVE_ANGLES = 0x20;

/** `CTriggerTeleport::Touch`（triggers.cpp:2388-2452）。 */
function teleportTouch(entity: Entity, other: Entity): void {
  if (!passesTriggerFilters(entity, other)) return;
  if (!other.isPlayer()) return;

  const targetName = entity.getString('target', '') || entity.getRaw('target') || '';
  const target = findByName(targetName);
  if (!target) return;

  const landmarkName = entity.getString('landmark', '') || entity.getRaw('landmark') || '';
  const landmark = landmarkName ? findByName(landmarkName) : null;

  const state = entity.runtime.host.getPlayerState();
  const pos: Vec3 = [target.origin[0], target.origin[1], target.origin[2]];

  if (landmark) {
    // 保持相对 landmark 的偏移，角度与速度都不改
    pos[0] += state.origin[0] - landmark.origin[0];
    pos[1] += state.origin[1] - landmark.origin[1];
    pos[2] += state.origin[2] - landmark.origin[2];
  } else {
    // "origin in center, not at feet": tmp.z -= WorldAlignMins().z（Y-up 用 hullMins[1]）
    pos[1] -= state.hullMins[1];
  }

  const preserve = !landmark && entity.hasSpawnFlags(SF_TELEPORT_PRESERVE_ANGLES);
  // target.angles 是 Source `[pitch,yaw,roll]`；宿主 yaw 走项目唯一换算
  // （src/ts-shared/phys/angles.ts::bspYawToCsYaw = wrap(yaw + 180)）。
  const angles: Vec3 | null = landmark || preserve
    ? null
    : [target.angles[0], bspYawToCsYaw(target.angles[1]), target.angles[2]];
  // BUGBUG: SDK 明确注释 pVelocity = NULL，不清零速度
  entity.runtime.host.teleportPlayer(pos, angles, null);
  entity.runtime.emit({ kind: 'teleport', detail: target.targetname || target.classname });
}

export const TriggerTeleportClass: EntityClass = {
  name: 'trigger_teleport',
  base: 'trigger',
  keyfields: [
    { name: 'landmark', type: 'string', defaultValue: '' },
    { name: 'teleportoffset', type: 'vec3', defaultValue: [0, 0, 0] as Vec3 },
  ],
  // SDK 里 CTriggerTeleport::Spawn 只调 InitTrigger()，不调 BaseClass::Spawn()
  touch: teleportTouch,
};

/** `trigger_teleport_relative` / `_random`：几何与家族一致，目标解析由宿主按需扩展。 */
export const TriggerTeleportRelativeClass: EntityClass = {
  name: 'trigger_teleport_relative',
  base: 'trigger_teleport',
};
export const TriggerTeleportRandomClass: EntityClass = {
  name: 'trigger_teleport_random',
  base: 'trigger_teleport',
};

// ── trigger_push ───────────────────────────────────────────────────────────
export const TriggerPushClass: EntityClass = {
  name: 'trigger_push',
  base: 'trigger',
  keyfields: [
    { name: 'pushdir', type: 'vec3', defaultValue: [0, 0, 0] as Vec3 },
    { name: 'alternateticksfix', type: 'float', defaultValue: 1 },
  ],
  spawn: (e) => {
    if (e.getNumber('speed', 0) === 0) e.set('speed', 100);
    const dir = e.get<Vec3>('pushdir') ?? [0, 0, 0];
    e.set('__pushDir', pushDirToYup(dir));
  },
  // 接触「回合」开始：清掉上一次接触留下的已施加标记（离开后再进板会重新给一次）。
  startTouch: (e) => {
    e.set('__pushApplied', false);
  },
  touch: (e, other) => {
    if (e.getBool('touchDisabled', false)) return;
    if (!passesTriggerFilters(e, other)) return;
    if (!other.isPlayer()) return;
    const dir = e.get<Vec3>('__pushDir') ?? [0, 0, 0];
    // `alternateticksfix` 只在 `sv_alternateticks` 开启时才是缩放系数
    // （Source SDK `triggers.cpp:2230-2242` `CTriggerPush::Activate`：否则 `m_flPushSpeed = m_flSpeed`）。
    // 本引擎固定 64Hz、没有 alternate ticks，所以直接用 `speed`；早期版本无条件相乘，
    // 把 surf_666 起点 4 块 `alternateticksfix 0` + `speed 3000` 的加速板乘成了 0（完全不弹）。
    const speed = e.getNumber('speed', 100);
    const v: Vec3 = [dir[0] * speed, dir[1] * speed, dir[2] * speed];
    if (e.hasSpawnFlags(SF_TRIGGER.PUSH_ONCE)) {
      e.runtime.host.addPlayerVelocity(v);
      // Source 在 Touch 内直接 `UTIL_Remove(this)`（triggers.cpp:2277）；本实现不在 touch 回调里
      // 直接删自己，等价做法是先断 touch（`touchDisabled`）再 0.1s 后移除——否则这 0.1s 内
      // 每帧 Touch 都会再叠一次 3000 HU/s（实测一帧 +3000、连叠数帧直接飞出地图）。
      e.set('touchDisabled', true);
      removeSoon(e);
      return;
    }
    // 非 ONCE：按 owner 2026-11-20 的口径——**接触触发区当下就立刻叠加一次
    // `pushdir*speed` 冲量**（Source 的 `ApplyAbsVelocityImpulse` 语义：纯叠加，保留进板动量与
    // 方向，不把速度定死），同一次接触里不再重复施加；离开后再次接触会重新给一次。
    if (e.getBool('__pushApplied', false)) return;
    e.set('__pushApplied', true);
    e.runtime.host.addPlayerVelocity(v);
  },
  endTouch: (e, other) => {
    e.set('__pushApplied', null);
    baseTriggerEndTouch(e, other);
  },
};

// ── 其余常见 trigger ──────────────────────────────────────────────────────
export const TriggerRemoveClass: EntityClass = {
  name: 'trigger_remove',
  base: 'trigger',
  // m_OnRemove 在 SDK 2013 里注册了但从不 fire（triggers.cpp:618/624）
  outputs: [{ name: 'OnRemove', kind: 'event' }],
  touch: (e, other) => {
    if (!passesTriggerFilters(e, other)) return;
    if (other.isPlayer()) e.runtime.host.removePlayer?.();
    else other.remove();
  },
};

export const TriggerGravityClass: EntityClass = {
  name: 'trigger_gravity',
  base: 'trigger',
  touch: (e, other) => {
    if (!other.isPlayer()) return;
    const g = e.getNumber('gravity', 1);
    e.runtime.host.setPlayerBaseVelocity?.(null);
    e.runtime.host.log?.(`gravity=${g}`);
    e.set('__gravityApplied', g);
    // 宿主可通过 `setPlayerGravity` 覆盖；缺省时只记录状态。
    e.runtime.host.setPlayerGravity?.(g);
  },
};

export const TriggerImpactClass: EntityClass = {
  name: 'trigger_impact',
  base: 'trigger',
  keyfields: [
    { name: 'Magnitude', type: 'float', defaultValue: 0 },
    { name: 'Noise', type: 'float', defaultValue: 0 },
    { name: 'Viewkick', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    { name: 'SetMagnitude', type: FIELD_FLOAT, key: 'magnitude' },
    input('Impact', FIELD_VOID, (e, d) => {
      const dir = pushDirToYup(e.angles);
      const mag = e.getNumber('magnitude', 0);
      fireValue(e, 'ImpactForce', [dir[0] * mag, dir[1] * mag, dir[2] * mag], d.activator as Entity | null);
      if (e.runtime.host.addPlayerVelocity) {
        e.runtime.host.addPlayerVelocity([dir[0] * mag, dir[1] * mag, dir[2] * mag]);
      }
      const on = (self: Entity): void => {
        self.disabled = true;
        self.triggerSolidFlag = false;
      };
      e.disabled = false;
      e.triggerSolidFlag = true;
      e.setThink(on, 0.1);
    }),
  ],
  outputs: [{ name: 'ImpactForce', kind: 'vector' }],
  spawn: (e) => {
    e.disabled = true;
    e.triggerSolidFlag = false;
  },
};

/** 只带通用 touch 输出的 trigger：SDK 里它们各有专门行为，这里至少保证 I/O 连接不丢。 */
const PLAIN_TRIGGERS = [
  'trigger_changelevel',
  'trigger_autosave',
  'trigger_togglesave',
  'trigger_playermovement',
  'trigger_proximity',
  'trigger_look',
  'trigger_cdaudio',
  'trigger_waterydeath',
  'trigger_vphysics_motion',
  'trigger_apply_impulse',
  'trigger_serverragdoll',
  'trigger_soundscape',
  'trigger_tracktrain',
];

export function registerTriggerClasses(): void {
  registerClass(TriggerMultipleClass);
  registerClass(TriggerOnceClass);
  registerClass(TriggerHurtClass);
  registerClass(TriggerTeleportClass);
  registerClass(TriggerTeleportRelativeClass);
  registerClass(TriggerTeleportRandomClass);
  registerClass(TriggerPushClass);
  registerClass(TriggerRemoveClass);
  registerClass(TriggerGravityClass);
  registerClass(TriggerImpactClass);

  for (const name of PLAIN_TRIGGERS) {
    registerClass({ name, base: 'trigger', brush: true });
  }
  // `trigger` 本身由 base.ts 注册为 BaseTriggerClass（LINK_ENTITY_TO_CLASS(trigger, CBaseTrigger)）。
}
