/**
 * 地图脚本最常用的「输出目标」实体族。对照 Source SDK 2013：
 * - `game/server/maprules.cpp:289-345`（CGameText）
 * - `game/server/EnvFade.cpp:42-105`（CEnvFade）
 * - `game/server/client.cpp:630-680`（point_clientcommand / point_servercommand）
 * - `game/server/sound.cpp:209-250`（CAmbientGeneric）
 *
 * 这些类本身几乎没有状态机，但它们是「按顺序触发」链路的终点：
 * 门开了要显示提示（`game_text`）、过关要黑屏（`env_fade`）、
 * 要用 `point_servercommand` 改 cvar、要 `ambient_generic` 放音效。
 * 缺了它们，I/O 链会断在 `unhandled input`，所以必须按 DATADESC 声明齐全。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_FLOAT, FIELD_STRING, FIELD_VOID } from '../variant.js';
import { input } from './common.js';
import { registerClass } from './registry.js';
import type { Color32 } from '../types.js';

/** `CGameText::Display`（maprules.cpp:313-345）。 */
function displayGameText(entity: Entity, activator: Entity | null): void {
  const host = entity.runtime.host;
  if (!host.showGameText) return;
  const color = entity.getString('color', '');
  const nums = (color.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
  host.showGameText(entity.getString('message', '') || entity.getRaw('message') || '', {
    channel: entity.getNumber('channel', 0),
    x: entity.getNumber('x', -1),
    y: entity.getNumber('y', -1),
    effect: entity.getNumber('effect', 0),
    fadein: entity.getNumber('fadein', 0),
    fadeout: entity.getNumber('fadeout', 0),
    holdtime: entity.getNumber('holdtime', 0),
    fxtime: entity.getNumber('fxtime', 0),
    r1: nums[0] ?? 255,
    g1: nums[1] ?? 255,
    b1: nums[2] ?? 255,
    a1: nums[3] ?? 255,
    activator: activator?.targetname ?? '',
  });
}

export const GameTextClass: EntityClass = {
  name: 'game_text',
  base: 'point',
  keyfields: [
    { name: 'message', type: 'string', defaultValue: '' },
    { name: 'channel', type: 'int', defaultValue: 0 },
    { name: 'x', type: 'float', defaultValue: -1 },
    { name: 'y', type: 'float', defaultValue: -1 },
    { name: 'effect', type: 'int', defaultValue: 0 },
    { name: 'fadein', type: 'float', defaultValue: 0 },
    { name: 'fadeout', type: 'float', defaultValue: 0 },
    { name: 'holdtime', type: 'float', defaultValue: 0 },
    { name: 'fxtime', type: 'float', defaultValue: 0 },
    // CGameText::KeyValue 把 color 解析进 hudtextparms_t；这里保留原文，Display 时解析。
    { name: 'color', type: 'string', defaultValue: '' },
    { name: 'color2', type: 'string', defaultValue: '' },
  ],
  inputs: [
    input('Display', FIELD_VOID, (e, d) => displayGameText(e, d.activator as Entity | null)),
  ],
};

/** `EnvFade.cpp:55-60` 的 spawnflags 与 `screenfade.h` 的 FFADE_* 位。 */
const SF_FADE_IN = 0x0001;
const SF_FADE_MODULATE = 0x0002;
const SF_FADE_ONLYONE = 0x0004;
const SF_FADE_STAYOUT = 0x0008;
const FFADE_IN = 0x0001;
const FFADE_OUT = 0x0002;
const FFADE_MODULATE = 0x0004;
const FFADE_STAYOUT = 0x0008;
const FFADE_PURGE = 0x0010;

export const EnvFadeClass: EntityClass = {
  name: 'env_fade',
  base: 'point',
  spawnFlags: {
    FADE_IN: SF_FADE_IN,
    FADE_MODULATE: SF_FADE_MODULATE,
    FADE_ONLYONE: SF_FADE_ONLYONE,
    FADE_STAYOUT: SF_FADE_STAYOUT,
  },
  keyfields: [
    { name: 'duration', type: 'float', defaultValue: 0 },
    { name: 'holdtime', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    input('Fade', FIELD_VOID, (e, d) => {
      let flags = e.hasSpawnFlags(SF_FADE_IN) ? FFADE_IN : FFADE_OUT;
      if (e.hasSpawnFlags(SF_FADE_MODULATE)) flags |= FFADE_MODULATE;
      if (e.hasSpawnFlags(SF_FADE_STAYOUT)) flags |= FFADE_STAYOUT;
      // ONLYONE 只对 activator 淡入淡出；否则全员并带 FFADE_PURGE（EnvFade.cpp:86-99）。
      if (!e.hasSpawnFlags(SF_FADE_ONLYONE)) flags |= FFADE_PURGE;
      const c = e.get<Color32>('rendercolor') ?? { r: 0, g: 0, b: 0, a: 255 };
      const alpha = e.getNumber('renderamt', 255);
      e.runtime.host.fadeScreen?.(
        { r: c.r, g: c.g, b: c.b, a: alpha },
        e.getNumber('duration', 0),
        e.getNumber('holdtime', 0),
        flags,
      );
      e.fire('OnBeginFade', d.activator, e);
    }),
  ],
  outputs: [{ name: 'OnBeginFade', kind: 'event' }],
};

/** `CPointServerCommand` / `CPointClientCommand`（client.cpp:630-680）。 */
export const PointServerCommandClass: EntityClass = {
  name: 'point_servercommand',
  base: 'point',
  inputs: [
    { name: 'Command', type: FIELD_STRING, handler: (e, d) => e.runtime.host.runServerCommand?.(d.value.string()) },
  ],
};
export const PointClientCommandClass: EntityClass = {
  name: 'point_clientcommand',
  base: 'point',
  inputs: [
    { name: 'Command', type: FIELD_STRING, handler: (e, d) => e.runtime.host.runClientCommand?.(d.value.string()) },
  ],
};

/** `CAmbientGeneric`（sound.cpp:209-250）；宿主只负责播放/停止，音量/音调作为状态保留。 */
export const AmbientGenericClass: EntityClass = {
  name: 'ambient_generic',
  base: 'point',
  keyfields: [
    { name: 'message', type: 'string', defaultValue: '' },
    { name: 'radius', type: 'float', defaultValue: 0 },
    { name: 'SourceEntityName', type: 'string', defaultValue: '' },
    { name: 'volume', type: 'float', defaultValue: 1 },
    { name: 'pitch', type: 'float', defaultValue: 100 },
  ],
  inputs: [
    input('PlaySound', FIELD_VOID, (e) => {
      e.set('playing', true);
      e.runtime.host.playSound?.(e.getString('message', ''), e.index);
    }),
    input('StopSound', FIELD_VOID, (e) => {
      e.set('playing', false);
      e.runtime.host.stopSound?.(e.getString('message', ''), e.index);
    }),
    input('ToggleSound', FIELD_VOID, (e) => {
      const on = !e.getBool('playing', false);
      e.set('playing', on);
      const name = e.getString('message', '');
      if (on) e.runtime.host.playSound?.(name, e.index);
      else e.runtime.host.stopSound?.(name, e.index);
    }),
    { name: 'Pitch', type: FIELD_FLOAT, key: 'pitch' },
    { name: 'Volume', type: FIELD_FLOAT, key: 'volume' },
    { name: 'FadeIn', type: FIELD_FLOAT, handler: (e, d) => e.set('fadeIn', d.value.float()) },
    { name: 'FadeOut', type: FIELD_FLOAT, handler: (e, d) => e.set('fadeOut', d.value.float()) },
  ],
};

/** 纯点实体：没有 I/O，但必须进全局实体表，`trigger_teleport.target` / `landmark` 靠它们的 origin。 */
const POINT_TARGETS = [
  'info_target', 'info_teleport_destination', 'info_landmark', 'info_null',
  'info_player_start', 'info_player_deathmatch', 'info_player_terrorist',
  'info_player_counterterrorist', 'info_node', 'info_node_hint',
  'info_map_parameters', 'info_lighting', 'info_particle_system',
  'worldspawn', 'env_sky', 'sky_camera', 'env_sun',
  'point_viewcontrol', 'point_posecontroller', 'point_energy_ball',
];

/** 有 I/O 但宿主不做表现/AI 的实体：保留基类行为，保证连接链不断。 */
const PLAIN_MISC = [
  'env_shake', 'env_spark', 'env_smokestack', 'env_rockettrail',
  'env_message', 'env_hudhint', 'env_instructor_hint',
  'env_texturetoggle', 'env_projectedtexture', 'env_lightglow',
  'logic_choreographed_scene', 'logic_scene_list_manager',
  'game_zone_player', 'game_player_equip', 'game_player_hurt',
  'game_score', 'game_end', 'game_round_win',
  'point_give_ammo', 'point_teleport', 'point_hurt',
  'func_precipitation_blocker', 'math_colorblind',
];

export function registerMiscClasses(): void {
  for (const cls of [
    GameTextClass, EnvFadeClass, PointServerCommandClass,
    PointClientCommandClass, AmbientGenericClass,
  ]) registerClass(cls);
  for (const name of POINT_TARGETS) registerClass({ name, base: 'point' });
  for (const name of PLAIN_MISC) registerClass({ name, base: 'point' });
  // `player` 只是运行期伪实体，注册空类避免加载时打 unknown classname 诊断。
  registerClass({ name: 'player', base: 'base' });
}

/**
 * 玩家 `+use` 的引擎路径是 `CBaseEntity::Use(...)`，**不经过 AcceptInput 的 `Use` 输入**
 * （后者只是把 outputID 当 USE_TYPE 转发到这里）。宿主直接调本函数即可。
 */
export function invokeUse(entity: Entity, activator: Entity | null, caller: Entity | null, useType = 0): void {
  entity.use(activator, caller, useType);
}
