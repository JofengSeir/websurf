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
import { entityStartSolidRaw } from '../start-solid.js';
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

/** 移动 brush 的动画步长（秒）：20ms 一次，与 tick 对齐；只影响平滑度，不影响总时长。 */
const MOVE_STEP_SECONDS = 0.02;


// ── func_door 平移换算（Source SDK 2013 `game/server/doors.cpp`）──────────────
// `CBaseDoor::Spawn`：`AngleVectors(movedir)` → `position2 = position1 + dir *
// (DotProductAbs(dir, OBBSize) - lip)`；`spawnpos=OPEN` / `spawnflags 512` 出生即 pos2；
// `speed == 0` → 100。
//
// 纯算术留在本文件而不是独立模块：独立模块会随 brush.ts 一起进入 debug 端动态 import 的
// `__esm` 包装差异，被 shared-artifacts 门禁判成「跨端文本分叉」（白名单不在 T-N4 范围）；
// 而这些函数零依赖，`test-ts-shared.mjs` 用 esbuild 打包本文件即可单测。
//
// 与 SDK 的一处刻意差异：Source 先 `vecOBB -= Vector(2, 2, 2)`（引擎 bbox 每轴撑 1 HU 的
// 补偿）；本仓 brush 凸包平面没有这层膨胀，照抄会平白少走 2 HU，故用真实并集尺寸。

/** 三维向量（只读入参；返回值为新数组）。 */
export type DoorVec3 = readonly [number, number, number];

/** `EntityBrushVolume` 的结构子集：Y-up 世界 AABB（这里只用 AABB）。 */
export interface DoorBrushBox {
  readonly mins: DoorVec3;
  readonly maxs: DoorVec3;
}

/**
 * BSP `movedir` 角度（`pitch yaw roll`，度）→ Y-up 单位向量。
 *
 * SDK 的 `AngleVectors` 只用 pitch/yaw 决定 forward（roll 不参与）：
 * `forward = (cp*cy, cp*sy, -sp)`；再按本项目 `map_coords`（`[y, z, x]`）转 Y-up。
 * 实测：`-90 0 0` → +Y、`90 0 0` → -Y、`0 90 0` → +X、`0 0 0` → +Z。
 *
 * 缺键 / 长度不足 / 非有限值返回 `null`：调用方据此回退旧的隐藏近似，而不是拿 0 角度
 * 当「+Z 门」瞎移（`0 0 0` 本身也是合法方向，不能当缺省哨兵）。
 */
export function doorMoveDirection(angles: readonly number[] | null | undefined): [number, number, number] | null {
  if (!angles || angles.length < 3) return null;
  const pitchDeg = angles[0];
  const yawDeg = angles[1];
  if (!Number.isFinite(pitchDeg) || !Number.isFinite(yawDeg)) return null;
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const forward: [number, number, number] = [cp * cy, cp * sy, -sp];
  return [forward[1], forward[2], forward[0]];
}

/**
 * 实体全部 brush 的并集尺寸（Y-up 世界 AABB 的 `max - min`）。
 *
 * 平移不变，所以世界坐标的凸包 AABB 并集与 SDK 的 `CollisionProp()->OBBSize()` 同值；
 * 无 volume / 数值非法返回 `null`（`render_bundle::export_entity_io` 对无凸包的 model
 * 会回退 model 总包围盒，所以正常地图实体都有值）。
 */
export function doorModelSize(volumes: readonly DoorBrushBox[] | null | undefined): [number, number, number] | null {
  if (!volumes || volumes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const volume of volumes) {
    const mins = volume?.mins;
    const maxs = volume?.maxs;
    if (!mins || !maxs) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = mins[axis];
      const b = maxs[axis];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (axis === 0) {
        if (lo < minX) minX = lo;
        if (hi > maxX) maxX = hi;
      } else if (axis === 1) {
        if (lo < minY) minY = lo;
        if (hi > maxY) maxY = hi;
      } else {
        if (lo < minZ) minZ = lo;
        if (hi > maxZ) maxZ = hi;
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null;
  return [maxX - minX, maxY - minY, maxZ - minZ];
}

/**
 * Source 的 `DotProductAbs(m_vecMoveDir, vecOBB) - m_flLip`，结果钳到 `>= 0`。
 *
 * 斜向门（ze 图有 15°/75°/45°）靠这个点积把盒尺寸投到 movement 轴上；`lip` 是门板与
 * 门框保留的重叠量（Source 用它让门只开一条人能过的缝）。`lip` 大于投影时 Source 会
 * 算出负距离（往反方向走，属于地图错误），这里钳 0 让调用方回退旧行为。
 */
export function doorMoveDistance(
  size: DoorVec3 | null | undefined,
  direction: DoorVec3 | null | undefined,
  lip: number,
): number {
  if (!size || !direction) return 0;
  const projection = Math.abs(direction[0] * size[0] + direction[1] * size[1] + direction[2] * size[2]);
  const lipValue = Number.isFinite(lip) ? lip : 0;
  const distance = projection - lipValue;
  return distance > 0 ? distance : 0;
}

/** Source `if (m_flSpeed == 0) m_flSpeed = 100`；非有限/负数同样回落到 100（HU/s）。 */
export function doorMoveSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 100;
}

/**
 * 走一段进度需要的秒数：`distance * |deltaProgress| / speed`。
 *
 * `deltaProgress` 让中途反向的门（Open→Close 打断）只按剩余行程计时，与 Source 的
 * `LinearMove` 从当前 origin 起算一致；`speed <= 0` 走 100 的兜底，避免除零/永不完成。
 */
export function doorTravelSeconds(distance: number, speed: number, deltaProgress = 1): number {
  const travel = Number.isFinite(distance) ? Math.abs(distance) : 0;
  const delta = Number.isFinite(deltaProgress) ? Math.min(1, Math.max(0, Math.abs(deltaProgress))) : 1;
  return (travel * delta) / doorMoveSpeed(speed);
}

/**
 * `progress`（0 = BSP 出生位 pos1，1 = pos2）对应的绝对位移（Y-up，HU）。
 *
 * 与 `func_movelinear` 的 `moveLinearApplyOffset` 同一约定：BSP 几何固定在出生位，
 * 事件携带的是「相对出生位的位移」，所以渲染/物理都直接用 `dir * distance * progress`。
 */
export function doorMoveOffset(
  direction: DoorVec3 | null | undefined,
  distance: number,
  progress: number,
): [number, number, number] {
  if (!direction) return [0, 0, 0];
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const travel = (Number.isFinite(distance) ? distance : 0) * p;
  return [direction[0] * travel, direction[1] * travel, direction[2] * travel];
}

/**
 * 把门板移到 `progress`（0 = 门洞 pos1，1 = 开位 pos2）。
 *
 * 渲染与物理共用同一偏移：`host.setBrushOffset` → `EntityGameplay.applyBrushOffset`
 * → `PhysWorld::set_brush_offset`（T-P1-5b 已含载客）+ 渲染组平移；BSP 几何本身不动。
 */
function doorApplyOffset(entity: Entity, progress: number): void {
  const direction = entity.get<[number, number, number]>('doorMoveDir');
  const distance = entity.getNumber('doorMoveDistance', 0);
  entity.set('doorProgress', progress);
  entity.runtime.host.setBrushOffset?.(entity.index, doorMoveOffset(direction, distance, progress));
}

/**
 * 20ms 步进推门，走完调用 `done`（Source `LinearMove` + `SetMoveDone`）。
 *
 * 时长 = 剩余行程 / speed。中途反向（Open 途中 Close）时 `from` 取当前 progress、
 * 只按剩余距离计时，与 Source 从当前 origin 起算一致；行程短于 0.05s 直接落位，
 * 避免地图加载期生成零时长 think 链。
 */
function doorAnimate(entity: Entity, to: number, done: () => void): void {
  const from = entity.getNumber('doorProgress', 0);
  const duration = doorTravelSeconds(
    entity.getNumber('doorMoveDistance', 0),
    entity.getNumber('speed', 100),
    to - from,
  );
  if (!(duration > 0.05)) {
    doorApplyOffset(entity, to);
    done();
    return;
  }
  const startTime = entity.runtime.now();
  const step = (self: Entity): void => {
    const elapsed = self.runtime.now() - startTime;
    const t = Math.min(1, Math.max(0, Number.isFinite(elapsed) ? elapsed / duration : 1));
    doorApplyOffset(self, from + (to - from) * t);
    if (t < 1) self.setThink(step, MOVE_STEP_SECONDS);
    else done();
  };
  entity.setThink(step, 0);
}

/**
 * `func_door` 的平移参数（Source `CBaseDoor::Spawn`，doors.cpp:1005-1130）。
 *
 * `movedir` 角度 → Y-up 单位向量；`OBBSize` 取 Rust `export_entity_io` 导出的 brush
 * 凸包 AABB 并集；行程 `|dir·OBB| - lip`。成功时写
 * `doorMotionReady/doorMoveDir/doorMoveDistance/doorProgress`，并把 brush 设成实心
 * （`spawnpos=1` 的门在 Rust 初态里是 `start_solid=false`，运行期不补这一步，
 * 可见的门板就形同虚设）；`startOpen` 的门同时把几何移到 pos2。
 *
 * 返回 false（缺 movedir / 无体积 / 行程 <= 0）时调用方保持旧行为：整块 0.1s 后隐藏，
 * 并由 `EntityGameplay` 在出生时隐藏。`func_door_rotating` / `func_water_analog`
 * 共用本类实现，但不在 T-N4 范围内，直接跳过（旋转门见 T-N5）。
 */
function doorSetupMotion(entity: Entity, startOpen: boolean): boolean {
  entity.set('doorMotionReady', false);
  if (entity.classname !== 'func_door') return false;
  const label = `func_door #${entity.index}${entity.targetname ? ` (${entity.targetname})` : ''}`;
  const rawMovedir = entity.getRaw('movedir');
  if (rawMovedir === undefined || rawMovedir.trim() === '') {
    entity.runtime.log(`${label} 缺 movedir，回退 0.1s 隐藏近似`);
    return false;
  }
  const direction = doorMoveDirection(entity.get<[number, number, number]>('movedir'));
  if (!direction) {
    entity.runtime.log(`${label} movedir 非法，回退 0.1s 隐藏近似`);
    return false;
  }
  const size = doorModelSize(entity.volumes);
  if (!size || (size[0] === 0 && size[1] === 0 && size[2] === 0)) {
    entity.runtime.log(`${label} 无 brush 体积，回退 0.1s 隐藏近似`);
    return false;
  }
  const lip = entity.getNumber('lip', 0);
  const distance = doorMoveDistance(size, direction, lip);
  if (!(distance > 0)) {
    entity.runtime.log(`${label} 行程为 0（size=${size.join(',')} lip=${lip}），回退 0.1s 隐藏近似`);
    return false;
  }
  entity.set('doorMoveDir', direction);
  entity.set('doorMoveDistance', distance);
  entity.set('doorMotionReady', true);
  entity.set('doorProgress', startOpen ? 1 : 0);
  entity.runtime.host.setBrushEnabled?.(entity.index, true);
  if (startOpen) doorApplyOffset(entity, 1);
  return true;
}

function doorHitBottom(entity: Entity): void {
  entity.set('toggleState', TS_AT_BOTTOM);
  if (entity.hasSpawnFlags(SF_DOOR_START_OPEN_OBSOLETE)) fire(entity, 'OnFullyOpen', entity.get<Entity | null>('activator') ?? null);
  else fire(entity, 'OnFullyClosed', entity.get<Entity | null>('activator') ?? null);
}

function doorGoDown(entity: Entity): void {
  entity.set('toggleState', TS_GOING_DOWN);
  fire(entity, 'OnClose', entity);
  if (entity.getBool('doorMotionReady', false)) {
    doorAnimate(entity, 0, () => doorHitBottom(entity));
    return;
  }
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
  // 真实平移的门到顶后仍然实心（碰撞 brush 已随位移走），只有旧近似才需要「隐藏」。
  if (!entity.getBool('doorMotionReady', false)) entity.runtime.host.setBrushEnabled?.(entity.index, false);
}

function doorGoUp(entity: Entity): void {
  entity.set('toggleState', TS_GOING_UP);
  fire(entity, 'OnOpen', entity);
  if (entity.getBool('doorMotionReady', false)) doorAnimate(entity, 1, () => doorHitTop(entity));
  else entity.setThink(doorHitTop, 0.1);
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
    // Source 的 `movedir` 是角度（`pitch yaw roll`），不是位移向量；由本文件的
    // `doorMoveDirection` 用 `AngleVectors` 的 forward 转成 Y-up 单位向量。默认值只为让 `get` 有形状，
    // 是否真的平移以 `getRaw('movedir')` 是否存在为准（缺键的门回退旧隐藏近似）。
    { name: 'movedir', type: 'vec3', defaultValue: [0, 0, 0] as [number, number, number] },
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
    // 出生位置（Source `CBaseDoor::Spawn`）：`spawnpos=1` 与 START_OPEN_OBSOLETE=512
    // 都让门出生在 pos2（开位）并停在 TS_AT_TOP；`spawnpos=0` 出生在 pos1（BSP 几何原位）。
    // `spawnpos` 是未声明的 raw 键（value 以字符串保存），`getNumber` 只认 number 字段，
    // 所以必须先按原文解析，否则永远读到 0（实测 #565/#566 被误判为「初始关」）。
    const rawSpawnpos = e.getRaw('spawnpos');
    const spawnpos = rawSpawnpos === undefined ? e.getNumber('spawnpos', 0) : Number.parseFloat(rawSpawnpos) || 0;
    const startOpen = spawnpos !== 0 || e.hasSpawnFlags(SF_DOOR_START_OPEN_OBSOLETE);
    e.set('toggleState', startOpen ? TS_AT_TOP : TS_AT_BOTTOM);
    e.set('locked', e.getBool('locked', false));
    // `func_door`：按 movedir/lip/speed 真实平移，出生即实心（开着的门也看得见、有碰撞）；
    // 拿不到方向或体积时回退旧的「0.1s 后整块隐藏/显形」，并由 EntityGameplay 在出生时隐藏。
    // `func_door_rotating` / `func_water_analog` 共用本类的 spawn 与 inputs，但不参与平移（T-N5）。
    doorSetupMotion(e, startOpen);
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
    // 出生即关的规则只有一份：`src/ts-shared/entity/start-solid.ts`（逐字镜像 Rust
    // `render_bundle::eval_entity_start_solid`）。`func_brush` 只看 StartDisabled，
    // `func_wall_toggle` 只看 spawnflags bit0（START_OFF），互不吃对方的键。派生类
    // （func_wall_toggle）的 spawn 也走这里，避免基类再按另一套键设回 true。
    brushSetEnabled(e, entityStartSolidRaw(e.classname, {
      spawnflags: e.getRaw('spawnflags'),
      startdisabled: e.getRaw('startdisabled'),
      spawnpos: e.getRaw('spawnpos'),
    }), false);
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

/**
 * func_movelinear 一个完整行程的时长（秒）。
 *
 * Source（`func_movelinear.cpp`）在 Open/Close 时把 brush 按 `speed` 移动
 * `movedistance`，**走完才 fire OnFullyOpen / OnFullyClosed**；engine 之前统一用
 * 0.1s 假定时，导致「电梯还没动、机关链已到终点」（ze 图 5 个 movelinear 的
 * OnFullyOpen 挂着传送/开门/放 boss，真实时长 3.5–36.6s）。
 *
 * 没有位移数据（自制 selftest 实体）时退回 0.1s 的旧行为，保证既有测试不变。
 */
function moveLinearDuration(entity: Entity): number {
  const distance = entity.getNumber('movedistance', 0);
  const speed = entity.getNumber('speed', 0);
  if (distance > 0 && speed > 0) return distance / speed;
  return 0.1;
}

/**
 * `func_movelinear` 的移动方向（Y-up，单位向量）。
 *
 * SDK 里 `movedir` 是 Source 角度 `"pitch yaw roll"`，`Spawn` 用 `AngleVectors` 取 forward：
 * `forward = (cp*cy, cp*sy, -sp)`；再按源码的坐标映射 `map_coords`（= `[y, z, x]`）转 Y-up。
 * ze 图的实际取值：`-90 0 0` → 向上、`90 0 0` → 向下、`0 90 0` → +X、`0 0 0` → +Z。
 */
function moveLinearDirection(entity: Entity): [number, number, number] {
  const stored = entity.get<[number, number, number]>('movedir');
  const angles: [number, number, number] = stored && stored.length === 3 && stored.every(Number.isFinite)
    ? stored
    : [0, 0, 0];
  const pitch = (angles[0] * Math.PI) / 180;
  const yaw = (angles[1] * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const forward: [number, number, number] = [cp * cy, cp * sy, -sp];
  return [forward[1], forward[2], forward[0]];
}

/**
 * 把 `progress`（0 = 关闭端 pos1，1 = 打开端 pos2）写成实体 brush 的绝对位移。
 *
 * Source（`func_movelinear.cpp:87-89`）：`pos1 = origin - dir*dist*startPosition`、
 * `pos2 = pos1 + dir*dist`；BSP 几何固定在 `origin`，所以相对几何的位移是
 * `dir*dist*(progress - startPosition)`。本图 5 个 movelinear 都是 `startposition=0`，
 * 也就是出生在 pos1（电梯停在井底）。
 */
function moveLinearApplyOffset(entity: Entity, progress: number): void {
  const distance = entity.getNumber('movedistance', 0);
  const startPosition = entity.getNumber('startposition', 0);
  const [dx, dy, dz] = moveLinearDirection(entity);
  const offset = distance * (progress - startPosition);
  entity.set('moveLinearProgress', progress);
  entity.runtime.host.setBrushOffset?.(entity.index, [dx * offset, dy * offset, dz * offset]);
}

/** 用 `setThink` 每 20ms 推进一步；到点调用 `done`（Source `SetMoveDone` 的定时器语义）。 */
function moveLinearAnimate(entity: Entity, from: number, to: number, done: () => void): void {
  const duration = moveLinearDuration(entity);
  if (!(duration > 0.05)) {
    moveLinearApplyOffset(entity, to);
    done();
    return;
  }
  const startTime = entity.runtime.now();
  const step = (self: Entity): void => {
    const elapsed = self.runtime.now() - startTime;
    const t = Math.min(1, Math.max(0, Number.isFinite(elapsed) ? elapsed / duration : 1));
    moveLinearApplyOffset(self, from + (to - from) * t);
    if (t < 1) self.setThink(step, MOVE_STEP_SECONDS);
    else done();
  };
  entity.setThink(step, 0);
}

/** Open：状态机 TS_GOING_UP → TS_AT_TOP，走完才 fire OnFullyOpen（Source MoveDone 语义）。 */
function moveLinearOpen(entity: Entity, activator: Entity | null): void {
  const state = entity.getNumber('toggleState', TS_AT_BOTTOM);
  if (state === TS_AT_TOP || state === TS_GOING_UP) return; // 重复 Open 被 MoveTo 忽略
  entity.set('toggleState', TS_GOING_UP);
  entity.set('activator', activator);
  fire(entity, 'OnOpen', activator);
  const from = entity.getNumber('moveLinearProgress', entity.getNumber('startposition', 0));
  moveLinearAnimate(entity, from, 1, () => {
    entity.set('toggleState', TS_AT_TOP);
    fire(entity, 'OnFullyOpen', activator);
  });
}

/** Close：状态机 TS_GOING_DOWN → TS_AT_BOTTOM，走完才 fire OnFullyClosed。 */
function moveLinearClose(entity: Entity, activator: Entity | null): void {
  const state = entity.getNumber('toggleState', TS_AT_BOTTOM);
  if (state === TS_AT_BOTTOM || state === TS_GOING_DOWN) return;
  entity.set('toggleState', TS_GOING_DOWN);
  entity.set('activator', activator);
  fire(entity, 'OnClose', activator);
  const from = entity.getNumber('moveLinearProgress', entity.getNumber('startposition', 0));
  moveLinearAnimate(entity, from, 0, () => {
    entity.set('toggleState', TS_AT_BOTTOM);
    fire(entity, 'OnFullyClosed', activator);
  });
}

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
    input('Open', FIELD_VOID, (e, d) => moveLinearOpen(e, d.activator as Entity | null)),
    input('Close', FIELD_VOID, (e, d) => moveLinearClose(e, d.activator as Entity | null)),
    input('Toggle', FIELD_VOID, (e, d) => {
      const state = e.getNumber('toggleState', TS_AT_BOTTOM);
      if (state === TS_AT_BOTTOM) moveLinearOpen(e, d.activator as Entity | null);
      else if (state === TS_AT_TOP) moveLinearClose(e, d.activator as Entity | null);
    }),
    { name: 'SetSpeed', type: FIELD_FLOAT, key: 'speed' },
    {
      name: 'SetPosition',
      type: FIELD_FLOAT,
      handler: (e, data) => {
        const value = Math.min(1, Math.max(0, data.value.float()));
        e.set('startposition', value);
        moveLinearApplyOffset(e, value);
        e.set('toggleState', value >= 1 ? TS_AT_TOP : TS_AT_BOTTOM);
      },
    },
  ],
  outputs: [
    { name: 'OnFullyOpen', kind: 'event' },
    { name: 'OnFullyClosed', kind: 'event' },
    { name: 'OnOpen', kind: 'event' },
    { name: 'OnClose', kind: 'event' },
  ],
  spawn: (e) => {
    // 出生姿态：BSP 几何固定在实体 origin；`StartPosition` 决定实体出生在 pos1(0) 还是
    // pos2(1)（本图 5 个 movelinear 全是 0 ⇒ 出生在关闭端，电梯平台停井底）。
    // 无 `movedistance` 的自定义实体在这里是 0 偏移，不会产生额外几何写入。
    const startPosition = Math.min(1, Math.max(0, e.getNumber('startposition', 0)));
    e.set('moveLinearProgress', startPosition);
    e.set('toggleState', startPosition >= 0.5 ? TS_AT_TOP : TS_AT_BOTTOM);
    if (e.getNumber('movedistance', 0) > 0) moveLinearApplyOffset(e, startPosition);
  },
};

// ── 旋转驱动换算（Source SDK 2013）───────────────────────────────────────────
// «func_rotating»：game/server/bmodels.cpp:673-692（轴）/ 718-731（maxspeed、START_ON）/ 971
//   （SetLocalAngularVelocity）/ 1097-1131（常速 think）/ 1229-1337（输入）。
// «func_door_rotating»：game/server/doors.cpp:944-1130（开关状态机）/ 1354-1400（CRotDoor::Spawn），
//   «CBaseToggle::AxisDir»（game/server/subs.cpp:326-334）、«AngularMove»（subs.cpp:268-301）。
//
// **轴旗标的命名陷阱**：util.h:518-522 写的是 «Z_AXIS 4 / X_AXIS 8»，但 bmodels.cpp:673-684 把
// flag4 映射成 «QAngle(0,0,1)»、flag8 成 «QAngle(1,0,0)»；而 QAngle 在
// physics_main.cpp:794-797 是**按欧拉分量积分**的（angles += angularVelocity*dt），
// «QAngleToAngularImpulse»（public/mathlib/vector.h:2191-2196）也确认 QAngle.z 是绕 X 的 roll、
// QAngle.x 是绕 Y 的 pitch、QAngle.y 是绕 Z 的 yaw。因此实际语义是：
//   bit4 → 绕 Source **X** 轴；bit8 → 绕 Source **Y** 轴；无旗标 → 绕 Source **Z** 轴（竖直）。
// Hammer 的旗标文案（X Axis [4] / Y Axis [8]）与这一实际行为一致。
// 经 «map_coords([x,y,z])=[y,z,x]» 换到 three（Y-up）：Source X→three Z、Source Y→three X、
// Source Z→three Y，故本文件的轴函数直接返回 three 轴向量。
export type RotatingVec3 = readonly [number, number, number];

const SF_ROTATE_START_ON = 1;
const SF_ROTATE_BACKWARDS = 2;
/** 名叫 Z_AXIS，实际是绕 Source **X** 轴（见上方说明）。 */
const SF_ROTATE_Z_AXIS = 4;
/** 名叫 X_AXIS，实际是绕 Source **Y** 轴。 */
const SF_ROTATE_X_AXIS = 8;
const SF_ROTATE_ACCDCC = 16;
const SF_ROTATE_HURT = 32;
const SF_ROTATE_NOT_SOLID = 64;

const SF_ROTDOOR_START_OPEN_OBSOLETE = 1;
const SF_ROTDOOR_BACKWARDS = 2;
const SF_ROTDOOR_NONSOLID_TO_PLAYER = 4;
const SF_ROTDOOR_PASSABLE = 8;
const SF_ROTDOOR_ONEWAY = 16;
const SF_ROTDOOR_NO_AUTO_RETURN = 32;
const SF_ROTDOOR_ROLL = 64;
const SF_ROTDOOR_PITCH = 128;
const SF_ROTDOOR_PUSE = 256;
const SF_ROTDOOR_PTOUCH = 1024;
const SF_ROTDOOR_LOCKED = 2048;

/**
 * «func_rotating» 的旋转轴（three 轴序，单位向量；BACKWARDS 已取负）。
 *
 * 见文件内「轴旗标的命名陷阱」：bit4 → three [0,0,1]、bit8 → three [1,0,0]、
 * 无轴旗标 → three [0,1,0]（竖直）。
 */
export function funcRotatingAxis(spawnflags: number): [number, number, number] {
  const flags = Number.isFinite(spawnflags) ? spawnflags | 0 : 0;
  let axis: [number, number, number];
  if ((flags & SF_ROTATE_Z_AXIS) !== 0) axis = [0, 0, 1];
  else if ((flags & SF_ROTATE_X_AXIS) !== 0) axis = [1, 0, 0];
  else axis = [0, 1, 0];
  return (flags & SF_ROTATE_BACKWARDS) !== 0 ? [-axis[0], -axis[1], -axis[2]] : axis;
}

/** Source «fabs(maxspeed); if (== 0) 100»（bmodels.cpp:718-722）；非有限值同样回落 100（度/秒）。 */
export function rotatingSpeedLimit(maxspeed: number): number {
  if (!Number.isFinite(maxspeed) || maxspeed === 0) return 100;
  return Math.abs(maxspeed);
}

/** 累计角度（度）转弧度；非有限值按 0（避免把 NaN 写进渲染组）。 */
export function rotatingDegreesToRadians(degrees: number): number {
  return (Number.isFinite(degrees) ? degrees : 0) * (Math.PI / 180);
}

/**
 * 单轴角位移 → three 欧拉角三元组（弧度）。
 *
 * 本仓所有旋转实体都只有一个轴（X/Y/Z），three 的 «rotation.x/y/z» 即绕对应轴的角度；
 * 用「轴向量 × 角度」写出三分量，未选中的分量严格为 0，避免欧拉组合顺序引入额外旋转。
 */
export function axisAngleEuler(
  axis: RotatingVec3 | null | undefined,
  radians: number,
): [number, number, number] {
  const angle = Number.isFinite(radians) ? radians : 0;
  if (!axis) return [0, 0, 0];
  return [
    (Number.isFinite(axis[0]) ? axis[0] : 0) * angle,
    (Number.isFinite(axis[1]) ? axis[1] : 0) * angle,
    (Number.isFinite(axis[2]) ? axis[2] : 0) * angle,
  ];
}

/**
 * «func_door_rotating» 的旋转轴（three 轴序；BACKWARDS 已取负）。
 *
 * «CBaseToggle::AxisDir»（subs.cpp:326-334）：ROLL(64) → QAngle(0,0,1)（绕 Source X）、
 * PITCH(128) → QAngle(1,0,0)（绕 Source Y）、默认 YAW → QAngle(0,1,0)（绕 Source Z，竖直）。
 * 换到 three 后分别为 [0,0,1] / [1,0,0] / [0,1,0]。
 */
export function rotDoorAxis(spawnflags: number): [number, number, number] {
  const flags = Number.isFinite(spawnflags) ? spawnflags | 0 : 0;
  let axis: [number, number, number];
  if ((flags & SF_ROTDOOR_ROLL) !== 0) axis = [0, 0, 1];
  else if ((flags & SF_ROTDOOR_PITCH) !== 0) axis = [1, 0, 0];
  else axis = [0, 1, 0];
  return (flags & SF_ROTDOOR_BACKWARDS) !== 0 ? [-axis[0], -axis[1], -axis[2]] : axis;
}

/** 旋转门速度（度/秒）：SDK «if (m_flSpeed == 0) 100»（doors.cpp:293-296）；负值/非有限回落 100。 */
export function rotDoorSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 100;
}

/** 旋转门在进度 «progress»（0 = 出生角，1 = 目标角）时的 three 欧拉角（弧度）。 */
export function rotDoorAngleEuler(
  axis: RotatingVec3 | null | undefined,
  distanceDegrees: number,
  progress: number,
): [number, number, number] {
  const distance = Number.isFinite(distanceDegrees) ? distanceDegrees : 0;
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return axisAngleEuler(axis, rotatingDegreesToRadians(distance * p));
}

// ── func_rotating（持续旋转） ─────────────────────────────────────────────────

function rotatingApply(entity: Entity): void {
  const axis = entity.get<[number, number, number]>('rotatingAxis') ?? [0, 1, 0];
  const degrees = entity.getNumber('rotatingDegrees', 0);
  entity.runtime.host.setBrushRotation?.(entity.index, axisAngleEuler(axis, rotatingDegreesToRadians(degrees)));
}

/**
 * 20ms 步进：先按「瞬时 / ACCDCC」语义推进速度，再按 speed*dt 积分角度。
 *
 * Source 由引擎每帧积分 SetLocalAngularVelocity（physics_main.cpp:794-797），这里用固定步长
 * think 复刻。角度取模 360 只为防长时间运行的浮点精度流失（单轴欧拉角视觉等价）。
 * 非 ACCDCC 时速度瞬时到目标；ACCDCC 时按 0.2/0.1 * maxspeed * fanfriction 每 0.1s 线性逼近
 * （bmodels.cpp SpinUp/SpinDown）。反向中途的「先减速到 0 再反向」在此简化为按当前差值减速，
 * 对 ze_cursed 的常速旋转无可见差异（该图旋转实体均无 ACCDCC）。
 */
function rotatingStep(entity: Entity): void {
  const now = entity.runtime.now();
  const last = entity.getNumber('rotatingLastTime', now);
  const dt = Math.min(0.25, Math.max(0, now - last));
  entity.set('rotatingLastTime', now);
  const maxspeed = entity.getNumber('rotatingMaxSpeed', 100);
  const friction = entity.getNumber('rotatingFanFriction', 1);
  let speed = entity.getNumber('rotatingSpeed', 0);
  const target = entity.getNumber('rotatingTarget', 0);
  if (entity.hasSpawnFlags(SF_ROTATE_ACCDCC)) {
    const sameDirection = speed === 0 || target === 0 || (speed > 0) === (target > 0);
    const perSecond = (sameDirection ? 0.2 : 0.1) * maxspeed * friction * 10;
    const delta = perSecond * dt;
    if (speed < target) speed = Math.min(target, speed + delta);
    else if (speed > target) speed = Math.max(target, speed - delta);
  } else {
    speed = target;
  }
  entity.set('rotatingSpeed', speed);
  const degrees = entity.getNumber('rotatingDegrees', 0) + speed * dt;
  entity.set('rotatingDegrees', ((degrees % 360) + 360) % 360);
  rotatingApply(entity);
  if (speed !== 0 || target !== 0) entity.setThink(rotatingStep, MOVE_STEP_SECONDS);
}

/** 启动 think 链；重复调用不会叠加（setThink 覆盖同一 thinkFn）。 */
function rotatingWake(entity: Entity): void {
  entity.set('rotatingLastTime', entity.runtime.now());
  entity.setThink(rotatingStep, 0);
}

function rotatingStart(entity: Entity): void {
  entity.set('rotatingTarget', entity.getNumber('rotatingMaxSpeed', 100));
  rotatingWake(entity);
}

function rotatingStop(entity: Entity): void {
  entity.set('rotatingTarget', 0);
  rotatingWake(entity);
}

/** Source 的 m_bReversed 落到轴上：翻转旋转方向，不改速度大小。 */
function rotatingSetDirection(entity: Entity, forward: boolean): void {
  const base = entity.get<[number, number, number]>('rotatingBaseAxis') ?? [0, 1, 0];
  entity.set('rotatingAxis', forward ? base : [-base[0], -base[1], -base[2]]);
}

export const FuncRotatingClass: EntityClass = {
  name: 'func_rotating',
  base: 'base',
  brush: true,
  spawnFlags: {
    START_ON: SF_ROTATE_START_ON,
    BACKWARDS: SF_ROTATE_BACKWARDS,
    Z_AXIS: SF_ROTATE_Z_AXIS,
    X_AXIS: SF_ROTATE_X_AXIS,
    ACCDCC: SF_ROTATE_ACCDCC,
    HURT: SF_ROTATE_HURT,
    NOT_SOLID: SF_ROTATE_NOT_SOLID,
  },
  keyfields: [
    // Source 的 speed 键在 spawn 期被无条件清零（bmodels.cpp:744），真正的速度上限是 maxspeed；
    // fanfriction 按百分比 /100（0 → 1，bmodels.cpp:665-668）。
    { name: 'maxspeed', type: 'float', defaultValue: 0 },
    { name: 'fanfriction', type: 'float', defaultValue: 0 },
  ],
  inputs: [
    input('Start', FIELD_VOID, (e) => rotatingStart(e)),
    input('Stop', FIELD_VOID, (e) => rotatingStop(e)),
    input('Reverse', FIELD_VOID, (e) => {
      const axis = e.get<[number, number, number]>('rotatingAxis') ?? [0, 1, 0];
      e.set('rotatingAxis', [-axis[0], -axis[1], -axis[2]]);
      e.set('rotatingTarget', Math.abs(e.getNumber('rotatingSpeed', 0)));
      rotatingWake(e);
    }),
    input('Toggle', FIELD_VOID, (e) => {
      // bmodels.cpp:1327-1337：m_flSpeed > 0 才停；反向旋转时 Toggle 仍走「启动」。
      if (e.getNumber('rotatingSpeed', 0) > 0) rotatingStop(e);
      else rotatingStart(e);
    }),
    input('StartForward', FIELD_VOID, (e) => {
      rotatingSetDirection(e, true);
      rotatingStart(e);
    }),
    input('StartBackward', FIELD_VOID, (e) => {
      rotatingSetDirection(e, false);
      rotatingStart(e);
    }),
    input('SetSpeed', FIELD_FLOAT, (e, d) => {
      // bmodels.cpp:1300-1337：value 是比例（0..1），负值表示反向；clamp 后乘 maxspeed。
      const value = d.value.float();
      rotatingSetDirection(e, !(value < 0));
      const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, Math.abs(value))) : 0;
      e.set('rotatingTarget', ratio * e.getNumber('rotatingMaxSpeed', 100));
      rotatingWake(e);
    }),
  ],
  spawn: (e) => {
    const maxspeed = rotatingSpeedLimit(e.getNumber('maxspeed', 0));
    const rawFan = e.getRaw('fanfriction');
    const fan = rawFan === undefined ? 0 : Number.parseFloat(rawFan);
    e.set('rotatingMaxSpeed', maxspeed);
    e.set('rotatingFanFriction', Number.isFinite(fan) && fan > 0 ? fan / 100 : 1);
    // base 轴不含 BACKWARDS，供 StartForward/StartBackward/SetSpeed 切方向时复用。
    e.set('rotatingBaseAxis', funcRotatingAxis(e.spawnflags & ~SF_ROTATE_BACKWARDS));
    e.set('rotatingAxis', funcRotatingAxis(e.spawnflags));
    e.set('rotatingSpeed', 0);
    e.set('rotatingTarget', 0);
    e.set('rotatingDegrees', 0);
    e.set('rotatingLastTime', e.runtime.now());
    // START_ON：SDK 在 0.2s 后调一次 Use（bmodels.cpp:727-731），即从静止启动；
    // 无该旗标的实体保持静止，等 Start / Toggle 输入。
    if (e.hasSpawnFlags(SF_ROTATE_START_ON)) e.setThink(rotatingStart, 0.2);
  },
  use: (e) => {
    if (e.getNumber('rotatingSpeed', 0) > 0) rotatingStop(e);
    else rotatingStart(e);
  },
};

// ── func_door_rotating（按角度插值的旋转门） ─────────────────────────────────

function rotDoorApply(entity: Entity, progress: number): void {
  const a = entity.get<[number, number, number]>('rotDoorAngleA') ?? [0, 0, 0];
  const b = entity.get<[number, number, number]>('rotDoorAngleB') ?? [0, 0, 0];
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  entity.set('rotDoorProgress', p);
  entity.runtime.host.setBrushRotation?.(entity.index, [
    a[0] + (b[0] - a[0]) * p,
    a[1] + (b[1] - a[1]) * p,
    a[2] + (b[2] - a[2]) * p,
  ]);
}

/** 20ms 角度插值（SDK AngularMove：时长 = 角行程 / speed，subs.cpp:268-301）。 */
function rotDoorAnimate(entity: Entity, to: number, done: () => void): void {
  const from = entity.getNumber('rotDoorProgress', 0);
  const duration = doorTravelSeconds(
    entity.getNumber('rotDoorDistance', 0),
    rotDoorSpeed(entity.getNumber('speed', 100)),
    to - from,
  );
  if (!(duration > 0.05)) {
    rotDoorApply(entity, to);
    done();
    return;
  }
  const startTime = entity.runtime.now();
  const step = (self: Entity): void => {
    const elapsed = self.runtime.now() - startTime;
    const t = Math.min(1, Math.max(0, Number.isFinite(elapsed) ? elapsed / duration : 1));
    rotDoorApply(self, from + (to - from) * t);
    if (t < 1) self.setThink(step, MOVE_STEP_SECONDS);
    else done();
  };
  entity.setThink(step, 0);
}

function rotDoorHitTop(entity: Entity): void {
  entity.set('toggleState', TS_AT_TOP);
  // doors.cpp:1052-1059：START_OPEN_OBSOLETE 的物理开位在角度的「低端」，输出语义相反。
  const inverted = entity.hasSpawnFlags(SF_ROTDOOR_START_OPEN_OBSOLETE);
  fire(entity, inverted ? 'OnFullyClosed' : 'OnFullyOpen', entity);
  if (!entity.hasSpawnFlags(SF_ROTDOOR_NO_AUTO_RETURN)) {
    const wait = entity.getNumber('wait', 3);
    if (wait !== -1) entity.setThink(rotDoorGoDown, wait);
  }
}

function rotDoorHitBottom(entity: Entity): void {
  entity.set('toggleState', TS_AT_BOTTOM);
  const inverted = entity.hasSpawnFlags(SF_ROTDOOR_START_OPEN_OBSOLETE);
  fire(entity, inverted ? 'OnFullyOpen' : 'OnFullyClosed', entity);
}

function rotDoorGoUp(entity: Entity): void {
  if (entity.getNumber('toggleState', TS_AT_BOTTOM) === TS_AT_TOP) return;
  entity.set('toggleState', TS_GOING_UP);
  fire(entity, 'OnOpen', entity);
  rotDoorAnimate(entity, 1, () => rotDoorHitTop(entity));
}

function rotDoorGoDown(entity: Entity): void {
  entity.set('toggleState', TS_GOING_DOWN);
  fire(entity, 'OnClose', entity);
  rotDoorAnimate(entity, 0, () => rotDoorHitBottom(entity));
}

export const FuncDoorRotatingClass: EntityClass = {
  name: 'func_door_rotating',
  base: 'base_toggle',
  brush: true,
  spawnFlags: {
    START_OPEN_OBSOLETE: SF_ROTDOOR_START_OPEN_OBSOLETE,
    BACKWARDS: SF_ROTDOOR_BACKWARDS,
    NONSOLID_TO_PLAYER: SF_ROTDOOR_NONSOLID_TO_PLAYER,
    PASSABLE: SF_ROTDOOR_PASSABLE,
    ONEWAY: SF_ROTDOOR_ONEWAY,
    NO_AUTO_RETURN: SF_ROTDOOR_NO_AUTO_RETURN,
    ROTATE_ROLL: SF_ROTDOOR_ROLL,
    ROTATE_PITCH: SF_ROTDOOR_PITCH,
    PUSE: SF_ROTDOOR_PUSE,
    PTOUCH: SF_ROTDOOR_PTOUCH,
    LOCKED: SF_ROTDOOR_LOCKED,
  },
  keyfields: [
    { name: 'distance', type: 'float', defaultValue: 90 },
    { name: 'speed', type: 'float', defaultValue: 100 },
    { name: 'wait', type: 'float', defaultValue: 3 },
    { name: 'locked', type: 'bool', defaultValue: false },
  ],
  inputs: [
    input('Open', FIELD_VOID, (e, d) => {
      const state = e.getNumber('toggleState', TS_AT_BOTTOM);
      if (state === TS_AT_TOP || state === TS_GOING_UP) return;
      if (e.getBool('locked', false)) return;
      e.set('activator', d.activator as Entity | null);
      rotDoorGoUp(e);
    }),
    input('Close', FIELD_VOID, (e, d) => {
      // Close 不受锁限制（doors.cpp:821-825）。
      if (e.getNumber('toggleState', TS_AT_BOTTOM) === TS_AT_BOTTOM) return;
      e.set('activator', d.activator as Entity | null);
      rotDoorGoDown(e);
    }),
    input('Toggle', FIELD_VOID, (e, d) => {
      if (e.getBool('locked', false)) return;
      const state = e.getNumber('toggleState', TS_AT_BOTTOM);
      e.set('activator', d.activator as Entity | null);
      if (state === TS_AT_BOTTOM) rotDoorGoUp(e);
      else if (state === TS_AT_TOP) rotDoorGoDown(e);
    }),
    { name: 'Lock', type: FIELD_VOID, handler: (e) => e.set('locked', true) },
    { name: 'Unlock', type: FIELD_VOID, handler: (e) => e.set('locked', false) },
    // doors.cpp:888-891：InputSetSpeed 直接赋值（度/秒），负值同样写入。
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
    const flags = e.spawnflags;
    const axis = rotDoorAxis(flags);
    const rawDistance = e.getNumber('distance', 90);
    // 缺 distance 时 Source 会 angle1==angle2；这里 90° 兜底，保证开合有可见行程
    // （ze_cursed 的 7 个旋转门 7/7 都写了 distance）。
    const distance = Number.isFinite(rawDistance) && rawDistance !== 0 ? Math.abs(rawDistance) : 90;
    e.set('rotDoorDistance', distance);
    e.set('speed', rotDoorSpeed(e.getNumber('speed', 0)));
    e.set('locked', e.getBool('locked', false) || e.hasSpawnFlags(SF_ROTDOOR_LOCKED));
    const angle = axisAngleEuler(axis, rotatingDegreesToRadians(distance));
    const rawSpawnpos = e.getRaw('spawnpos');
    const spawnpos = rawSpawnpos === undefined ? e.getNumber('spawnpos', 0) : Number.parseFloat(rawSpawnpos) || 0;
    if (e.hasSpawnFlags(SF_ROTDOOR_START_OPEN_OBSOLETE)) {
      // doors.cpp:1376-1389：交换 angle1/angle2 并翻转 moveAng；AT_BOTTOM 落在物理开位，
      // Open 反而朝 angle2=出生角走（旧旗标的反转语义，按 SDK 原样复刻）。
      e.set('rotDoorAngleA', angle);
      e.set('rotDoorAngleB', [0, 0, 0]);
      e.set('toggleState', TS_AT_BOTTOM);
      e.set('rotDoorProgress', 0);
    } else if (spawnpos !== 0) {
      // doors.cpp:1390-1396：spawnpos=1 直接 Teleport 到 angle2 并停在 AT_TOP。
      e.set('rotDoorAngleA', [0, 0, 0]);
      e.set('rotDoorAngleB', angle);
      e.set('toggleState', TS_AT_TOP);
      e.set('rotDoorProgress', 1);
    } else {
      e.set('rotDoorAngleA', [0, 0, 0]);
      e.set('rotDoorAngleB', angle);
      e.set('toggleState', TS_AT_BOTTOM);
      e.set('rotDoorProgress', 0);
    }
    // 旋转门几何始终可见（不参与 T-N4 的 0.1s 隐藏近似），EntityGameplay 据此跳过初态隐藏。
    e.set('brushRotationReady', true);
    e.set('activator', null);
    rotDoorApply(e, e.getNumber('rotDoorProgress', 0));
  },
  use: (e, activator) => {
    if (e.getBool('locked', false)) {
      fire(e, 'OnLockedUse', activator);
      return;
    }
    const state = e.getNumber('toggleState', TS_AT_BOTTOM);
    e.set('activator', activator);
    if (state === TS_AT_BOTTOM) rotDoorGoUp(e);
    else if (state === TS_AT_TOP) rotDoorGoDown(e);
  },
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
      if (e.getBool('broken', false)) return;
      e.set('broken', true);
      // 落地副作用（SDK `CBreakable::Break` 会 Eject + 隐藏/移除实体）：本引擎的 brush 几何与
      // 碰撞体是载图时静态导出的，Break 若只 fire OnBreak，玩家仍会被一块「已经碎了」的墙挡住
      // （ze_cursed 的 lvl1_break02 就是这种：counter 满后 Break，结果路被堵）。
      // 这里把「非实心 + 渲染隐藏」交给既有 brush 事件链：setBrushEnabled(false) →
      // `brush` 事件 → EntityGameplay 的 `phys.set_brush_solid` + `onBrushSolidChange`。
      e.runtime.host.setBrushEnabled?.(e.index, false);
      fire(e, 'OnBreak', d.activator as Entity | null);
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
  // 旋转门有独立的角度状态机（doors.cpp CRotDoor），不能复用 func_door 的平移/0.1s 隐藏近似。
  registerClass(FuncDoorRotatingClass);
  registerClass({ ...FuncDoorClass, name: 'func_water_analog' });
  registerClass({ ...FuncButtonClass, name: 'func_rot_button' });
  registerClass({ ...FuncButtonClass, name: 'momentary_rot_button' });
  for (const name of PLAIN_BRUSH) registerClass({ name, base: 'base', brush: true });
}
