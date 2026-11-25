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
  // 旋转门 / 移动门是 func_door 的子类（SDK 里 LINK_ENTITY_TO_CLASS 到同一实现族）
  registerClass({ ...FuncDoorClass, name: 'func_door_rotating' });
  registerClass({ ...FuncDoorClass, name: 'func_water_analog' });
  registerClass({ ...FuncButtonClass, name: 'func_rot_button' });
  registerClass({ ...FuncButtonClass, name: 'momentary_rot_button' });
  for (const name of PLAIN_BRUSH) registerClass({ name, base: 'base', brush: true });
}
