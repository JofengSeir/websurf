/**
 * 装饰 / 特效实体：`env_sprite`、`prop_dynamic`、`info_particle_system`、`point_worldtext`。
 *
 * 这四类在 Source 里都只有很薄的状态机，但它们的 I/O 是地图演出链的常见终点：
 * 光晕要能被 `ShowSprite` / `HideSprite` 开关，道具要能被 `TurnOn` / `TurnOff`
 * 显隐，粒子要能被 `Start` / `Stop` 启停。过去它们没有注册类，输入全部落到
 * `unhandled input`，渲染侧也就永远停在「载入即全亮」。这里按 SDK 的 DATADESC
 * 补齐声明，并把可见性变化转给宿主钩子（`setSpriteVisible` / `setParticleActive`）。
 *
 * 口径（逐类核实，勿凭印象）：
 * - `game/shared/Sprite.cpp:190-227`：CSprite::Spawn 只有在「有 targetname 且
 *   spawnflags bit0 (`SF_SPRITE_STARTON`) 未置位」时才 TurnOff，无 targetname
 *   的 sprite 一律恒亮；I/O 名是 ShowSprite / HideSprite / ToggleSprite（:590-602）。
 * - `game/server/props.cpp:1830/1927-1930/1838-1843`：CDynamicProp 的 `StartDisabled`
 *   非零只加 `EF_NODRAW`（隐形但仍占碰撞），I/O 是 TurnOn / TurnOff，且
 *   Enable / Disable 分别是二者的别名。
 * - `game/server/particle_system.cpp:36/163-175/117-118`：CParticleSystem 的键名是
 *   **小写** `start_active`，缺省 false；`Activate()` 只在它为真时启动一次，
 *   运行期 I/O 是 Start / Stop。
 * - `game/server/point_worldtext.cpp` / `client/c_point_worldtext.cpp`：没有
 *   StartDisabled、没有 spawnflags、没有 Show/Hide —— 永远可见；只有 SetText 等
 *   内容输入。因此这里**不**给它套显隐门控（套了就是无中生有）。
 */
import type { Entity, EntityClass } from '../base-entity.js';
import { FIELD_FLOAT, FIELD_STRING, FIELD_VOID } from '../variant.js';
import { input } from './common.js';
import { registerClass } from './registry.js';

/**
 * `Sprite.h:17` 的 spawnflags 位。
 *
 * 名字刻意与 renderer 侧 `entity-extras/entity-state.ts` 的同义常量区分开：两端都会进
 * app.js，esbuild 遇到同名顶层声明会给其中一份加数字后缀，而 debug/game 的模块顺序不同，
 * 后缀落在哪一侧也不同（`check-shared-artifacts` 会判为产物分叉）。同一个语义只留一处
 * 真源不现实（entity 层不能反向 import renderer-shared），因此用不同名字避开重命名。
 */
const SPRITE_STARTON_BIT = 0x0001;
const SF_SPRITE_ONCE = 0x0002;
const SF_SPRITE_TEMPORARY = 0x8000;

/** CSprite::Spawn 的初始可见性：无 targetname 恒亮；有名字则看 bit0。 */
function spriteSpawnsVisible(entity: Entity): boolean {
  if (!entity.targetname) return true;
  return (entity.spawnflags & SPRITE_STARTON_BIT) !== 0;
}

function setSpriteVisible(entity: Entity, visible: boolean): void {
  if (entity.getBool('spritevisible', true) === visible) return;
  entity.set('spritevisible', visible);
  entity.runtime.host.setSpriteVisible?.(entity.index, visible);
}

/** `env_sprite`（CSprite）；`env_sprite_clientside` 在 SDK 里复用同一份实现。 */
export const EnvSpriteClass: EntityClass = {
  name: 'env_sprite',
  base: 'point',
  spawnFlags: { STARTON: SPRITE_STARTON_BIT, ONCE: SF_SPRITE_ONCE, TEMPORARY: SF_SPRITE_TEMPORARY },
  keyfields: [
    { name: 'model', type: 'string', defaultValue: '' },
    { name: 'scale', type: 'float', defaultValue: 1 },
    { name: 'rendercolor', type: 'string', defaultValue: '255 255 255' },
    { name: 'renderamt', type: 'int', defaultValue: 255 },
    { name: 'framerate', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    { name: 'ShowSprite', type: FIELD_VOID, handler: (e) => setSpriteVisible(e, true) },
    { name: 'HideSprite', type: FIELD_VOID, handler: (e) => setSpriteVisible(e, false) },
    input('ToggleSprite', FIELD_VOID, (e) => setSpriteVisible(e, !e.getBool('spritevisible', true))),
  ],
  spawn: (e) => {
    // 只记录状态：渲染侧的初态由 KV 直接判定（`spriteStartsVisible`），
    // 这里再调宿主会在装配顺序上产生一次无意义的「先关后开」。
    e.set('spritevisible', spriteSpawnsVisible(e));
  },
};

export const EnvSpriteClientsideClass: EntityClass = {
  ...EnvSpriteClass,
  name: 'env_sprite_clientside',
};

/** `props.cpp:1830` 的 StartDisabled；`Enable`/`Disable` 即 TurnOn/TurnOff。 */
function setPropDynamicVisible(entity: Entity, visible: boolean): void {
  if (entity.getBool('propvisible', true) === visible) return;
  entity.set('propvisible', visible);
  entity.disabled = !visible;
  // 只动可见性：`StartDisabled` 的 prop 在 Source 里仍占碰撞（EF_NODRAW 不改 solid）。
  entity.runtime.host.setPropVisible?.(entity.index, visible);
}

export const PropDynamicClass: EntityClass = {
  name: 'prop_dynamic',
  base: 'point',
  keyfields: [
    { name: 'model', type: 'string', defaultValue: '' },
    { name: 'StartDisabled', type: 'bool', defaultValue: false },
    { name: 'solid', type: 'int', defaultValue: 6 },
    { name: 'rendercolor', type: 'string', defaultValue: '255 255 255' },
    { name: 'renderamt', type: 'int', defaultValue: 255 },
    { name: 'skin', type: 'int', defaultValue: 0 },
    { name: 'disablereceiveshadows', type: 'bool', defaultValue: false },
  ],
  inputs: [
    { name: 'TurnOn', type: FIELD_VOID, handler: (e) => setPropDynamicVisible(e, true) },
    { name: 'TurnOff', type: FIELD_VOID, handler: (e) => setPropDynamicVisible(e, false) },
    // props.cpp:1838-1843：Enable → InputTurnOn，Disable → InputTurnOff。
    { name: 'Enable', type: FIELD_VOID, handler: (e) => setPropDynamicVisible(e, true) },
    { name: 'Disable', type: FIELD_VOID, handler: (e) => setPropDynamicVisible(e, false) },
    { name: 'EnableCollision', type: FIELD_VOID, handler: (e) => e.set('collisionEnabled', true) },
    { name: 'DisableCollision', type: FIELD_VOID, handler: (e) => e.set('collisionEnabled', false) },
  ],
  spawn: (e) => {
    // StartDisabled 只影响可见性（EF_NODRAW），不影响碰撞；初态的渲染隐藏由
    // EntityGameplay 复用 brush 事件链交给宿主（BrushEntityVisibility 支持 `prop_<i>`）。
    e.set('propvisible', !e.getBool('startdisabled', false));
  },
};

/** `particle_system.cpp:36` 的键名是小写 `start_active`，不是 `StartActive`。 */
function setParticleActive(entity: Entity, active: boolean): void {
  if (entity.getBool('particleactive', false) === active) return;
  entity.set('particleactive', active);
  entity.runtime.host.setParticleActive?.(entity.index, active);
}

export const InfoParticleSystemClass: EntityClass = {
  name: 'info_particle_system',
  base: 'point',
  keyfields: [
    { name: 'effect_name', type: 'string', defaultValue: '' },
    { name: 'start_active', type: 'bool', defaultValue: false },
    { name: 'cpoint1', type: 'string', defaultValue: '' },
    { name: 'cpoint2', type: 'string', defaultValue: '' },
    { name: 'cpoint3', type: 'string', defaultValue: '' },
    { name: 'cpoint4', type: 'string', defaultValue: '' },
  ],
  inputs: [
    { name: 'Start', type: FIELD_VOID, handler: (e) => setParticleActive(e, true) },
    { name: 'Stop', type: FIELD_VOID, handler: (e) => setParticleActive(e, false) },
  ],
  spawn: (e) => {
    // Activate() 只在 start_active 为真时启动一次。运行期状态必须与初始发射一致，
    // 否则开局就发射的系统收到第一个 Stop 时会因「状态没变」被早退掉。
    e.set('particleactive', e.getBool('start_active', false));
  },
};

/**
 * `point_worldtext`：没有显隐/启停语义（SDK 里就恒可见），这里只声明内容键与
 * Set* 输入，保证 I/O 链不再落 unhandled。渲染侧的更新通道本卡不改（OUT）。
 */
export const PointWorldTextClass: EntityClass = {
  name: 'point_worldtext',
  base: 'point',
  keyfields: [
    { name: 'message', type: 'string', defaultValue: '' },
    { name: 'textsize', type: 'float', defaultValue: 32 },
    { name: 'textspacingX', type: 'float', defaultValue: 0 },
    { name: 'textspacingY', type: 'float', defaultValue: 0 },
    { name: 'orientation', type: 'int', defaultValue: 0 },
    { name: 'font', type: 'int', defaultValue: 0 },
    { name: 'rainbow', type: 'bool', defaultValue: false },
    { name: 'color', type: 'string', defaultValue: '255 255 255' },
  ],
  inputs: [
    input('SetText', FIELD_STRING, (e, d) => e.set('message', d.value.string())),
    input('SetTextSize', FIELD_FLOAT, (e, d) => e.set('textsize', d.value.float())),
    input('SetTextSpacingX', FIELD_FLOAT, (e, d) => e.set('textspacingX', d.value.float())),
    input('SetTextSpacingY', FIELD_FLOAT, (e, d) => e.set('textspacingY', d.value.float())),
    input('SetOrientation', FIELD_STRING, (e, d) => e.set('orientation', d.value.string())),
    input('SetFont', FIELD_STRING, (e, d) => e.set('font', d.value.string())),
    input('SetRainbow', FIELD_VOID, (e) => e.set('rainbow', true)),
    input('SetColor', FIELD_STRING, (e, d) => e.set('color', d.value.string())),
  ],
};

/** 注册四类装饰/特效实体；由 `classes/index.ts` 在 Misc 之后调用（后者不再注册同名类）。 */
export function registerExtrasClasses(): void {
  registerClass(EnvSpriteClass);
  registerClass(EnvSpriteClientsideClass);
  registerClass(PropDynamicClass);
  registerClass(InfoParticleSystemClass);
  registerClass(PointWorldTextClass);
}
