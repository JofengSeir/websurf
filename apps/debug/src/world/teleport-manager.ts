/**
 * 传送门数据在 TS 侧的解析与判定实现：把 `BspProcessor::parse_teleports`
 *（`apps/debug/crates/wasm/src/lib.rs`）产出的 JSON 拆成「目的地表 + 触发器表」，
 * 并给出三种触发模式的进入判定。
 *
 * ## 上下游
 * - 上游：`src/ts-shared/phys/world-builder.ts` 的 `buildWorldBundle` 调 `proc.parse_teleports()`，
 *   JSON 经 `SceneDataMessage.teleportJson` 到主线程；本类的唯一构造点是
 *   `apps/debug/src/renderer/renderer-main.ts` 的 `loadScene`。
 * - 下游：`getTriggers()` 是本类**唯一**被调用的成员，产出交给
 *   `apps/debug/src/renderer/collider-debug.ts` 的 `setTriggers`（触发区线框）与
 *   `apps/debug/src/renderer/plane-inspector.ts`（准星拾取触发器 AABB）。
 * - 运行期传送不在这里：`src/phys/teleport.rs` 的 `TeleportManager::from_json` 吃同一份 JSON，
 *   由 `PhysWorld::step_core` 调 `check` 判定并瞬移玩家，事件再经
 *   `apps/debug/src/renderer/renderer-main.ts` 的 `take_event` → `onPhysEvent` 交给
 *   `apps/debug/src/app.ts` 的 `onRenderPhysEvent`。
 *
 * ## 本文件成员的调用现状（grep 实测，范围 `apps/debug/src` 与 `src`）
 * `checkTeleport` / `setTriggerMode` / `setGroundedFramesRequired` / `onTeleported` /
 * `resetCooldown` / `triggerCount` / `destCount` 零调用点；`getTriggers` 一处调用点
 *（`loadScene`）。故本类当前只承担「解析 JSON + 暴露触发器列表」，
 * 三种触发模式的判定与冷却状态机在本工作区内不参与运行。
 *
 * ## 解析期不变量
 * - 两张表的顺序与 JSON 数组顺序一致。
 * - `destinations[i].index` 直接取 JSON 的 `index`（上游写的是 BSP 实体编号，不是数组下标）；
 *   链接用的是 `destByName` 的值（真正的数组下标）。
 * - 同名目的地出现多次时后写入的覆盖先写入的（`Map.set` 语义）；
 *   `links` / `total_*` / `orphan_*` 三个键本文件不读，`destIndex` 由 `target` 与
 *   `targetname` 的逐字符比较得到。
 * - 字段缺省只在两处兜底：`spawnflags ?? 1`、`start_disabled ?? false`。
 * - 构造器不校验 JSON 结构：`JSON.parse` 的异常与 `data.teleports` / `data.triggers`
 *   缺失导致的迭代异常都直接向外抛。
 */

import type { Vec3 } from '../physics/math/vec3.js';
import { type WasmTeleportReport } from './types.js';
import { bspYawToCsYaw } from '../../../../src/ts-shared/phys/angles.js';

// ---------------------------------------------------------------------------
// 触发器配置
// ---------------------------------------------------------------------------

/** 球形回退判定半径（HU）：只在该触发器既无凸包平面、也无 AABB 时使用，
 *  判据是闭球 `distSq <= TRIGGER_RADIUS²`。 */
const TRIGGER_RADIUS = 64;

/** 一次命中后写入 `cooldown` 的秒数。`checkTeleport` 在 `cooldown > 0` 期间只递减并返回 null。 */
const TRIGGER_COOLDOWN = 0.5;

/**
 * 触发判定档位，决定「当前帧在触发区内」如何折算成本帧是否触发：
 * - `every-frame`：在区域内即触发，不看上一帧状态；
 * - `start-touch`：只在 `insideStates` 由 false 变 true 的那一帧触发；
 * - `start-touch-grounded`：在区域内，且本帧恰好是「连续着地帧数首次达到阈值」的那一帧。
 * 默认档是 `start-touch`，切换由 `setTriggerMode` 完成（换档会清空全部 `inside` 位与冷却）。
 */
export type TeleportTriggerMode =
  | 'every-frame'
  | 'start-touch'
  | 'start-touch-grounded';

// ---------------------------------------------------------------------------
// 运行时类型
// ---------------------------------------------------------------------------

/** 目的地表的一项（JSON `teleports[]` 的逐字段映射）。 */
export interface TeleportDestination {
  /** BSP 实体编号：上游写的是 `bsp.entities` 的 enumerate 下标，跳跃、非连续，
   *  不是本表下标。本工程内无读取点 —— 消费方 `apps/debug/src/game-state.ts` 的
   *  `onTeleport` 只读 `targetname` / `origin` / `yaw`，且其入参由
   *  `apps/debug/src/app.ts` 的就地字面量给出。 */
  index: number;
  /** 目标实体名；建表后作为 `destByName` 的键，与 `TeleportTrigger.target` 逐字符比较。 */
  targetname: string;
  /** 目标坐标（Y-up，上游已旋转）。 */
  origin: Vec3;
  /** BSP 原始角度 `[pitch, yaw, roll]`（未旋转、未换算）。本工程内无读取点。 */
  angles: [number, number, number];
  /** cs-movement yaw（度，`[0,360)`，0 = 朝 −Z）：`bspYawToCsYaw(angles[1])`
   *（`src/ts-shared/phys/angles.ts`，即 `wrap(angles[1] + 180)`）。
   *  消费方 `game-state.onTeleport` 取该值后换算成弧度存进检查点。 */
  yaw: number;
}

/** 触发器表的一项。上游对「一个触发实体绑定的每个 brush 区域」各产出一条，
 *  故同一实体的多条记录会共享 `index` / `classname` / `target` / `origin` /
 *  `spawnflags` / `startDisabled`，只有几何三字段不同。 */
export interface TeleportTrigger {
  /** BSP 实体编号（同 `TeleportDestination.index`，非本表下标）；同一实体的多个区域取同一值。
   *  本工程内无读取点（`PlaneInspector` 用的是表的遍历下标）。 */
  index: number;
  /** 实体 classname；上游只收 `trigger_teleport` / `trigger_teleport_random` /
   *  `trigger_teleport_relative` 三种（`trigger_multiple` 等通用触发器不入表）。 */
  classname: string;
  /** 实体 `target`；解析期用它查 `destByName` 得到 `destIndex`，此后只在调试展示里被读。 */
  target: string;
  /** 实体 origin（Y-up）。区域判定用 `planes` 或 `mins` + `maxs`，本字段只在球形回退里当球心。 */
  origin: Vec3;
  /** 实体 `model` 键原串（如 `*5`）。上游已按它算出区域几何，本文件不再解析该串。 */
  model: string | null;
  /** 该 brush 区域的世界空间 AABB 下界（Y-up）。null = 上游未给区域，判定回退球形。 */
  mins: Vec3 | null;
  /** 该 brush 区域的世界空间 AABB 上界（Y-up）。null 同上。 */
  maxs: Vec3 | null;
  /**
   * 触发区域凸包平面（世界坐标 Y-up，法线朝外，内部满足 `dot(n, p) - dist <= 0`；
   * 上游把每项写成 `[nx, ny, nz, dist]` 四元组）。
   * 数组非空时 `isPlayerInTrigger` 优先用它（楔形/斜面触发区不能用 AABB 代替）；
   * 缺省、null 或空数组时回退 AABB。
   */
  planes?: { normal: Vec3; dist: number }[] | null;
  /** `destinations` 表的**数组下标**（由 targetname 查表得到）；-1 = 无同名目的地（孤儿触发器）。
   *  判定与返回都用它当下标，越界由 `checkTeleport` 的 `?? null` 兜住。 */
  destIndex: number;
  /** `spawnflags` 原值（位掩码）。本文件只读两位：0x01 = Clients、0x40 = Everything；
   *  两位都不含时 `checkTeleport` 跳过该触发器。 */
  spawnflags: number;
  /** 上游 JSON 的 `start_disabled`；为真时 `checkTeleport` 的第一道 `continue` 跳过该触发器。
   *  上游取值键写作 `StartDisabled`，而实体文本已被整体小写
   *（`src/wasm-core/vbsp/reader.rs` 的 `read_entities`）、`RawEntity::prop` 逐字节比较键名，
   *  该键取不到 ⇒ 当前工况下 JSON 里该字段恒为 false，本分支不会被走到。 */
  startDisabled: boolean;
}

// ---------------------------------------------------------------------------
// TeleportManager
// ---------------------------------------------------------------------------

/**
 * 触发器表 / 目的地表的容器与判定入口。
 * 构造时解析 JSON 建两张表；判定入口是 `checkTeleport`，边沿状态由 `insideStates` 承载，
 * 冷却由 `cooldown` 承载（本工程内无调用点，见文件头）。
 */
export class TeleportManager {
  private readonly triggers: TeleportTrigger[] = [];
  private readonly destinations: TeleportDestination[] = [];
  /** 冷却剩余秒数。写路径三条：命中时写 `TRIGGER_COOLDOWN`；`setTriggerMode` 与
   *  `resetCooldown` 写 0；`checkTeleport` 在 `> 0` 时按 `dt` 递减（可越过 0 变负值）。 */
  private cooldown = 0;
  /** 每个触发器的「上一帧是否在区域内」位，下标与 `triggers` 对齐，长度在构造末尾固定；
   *  `every-frame` 档不读它，另外两档靠它做边沿判定。 */
  private readonly insideStates: boolean[];
  /** 当前档位；构造后为 `start-touch`，只由 `setTriggerMode` 改写。 */
  private triggerMode: TeleportTriggerMode = 'start-touch';
  /** 连续着地帧数计数器。写路径只有 `checkTeleport`：`onGround` 为真时写
   *  `min(当前值 + 1, groundedFramesRequired + 1)`，为假时写 0；
   *  `setTriggerMode` / `setGroundedFramesRequired` / `onTeleported` / `resetCooldown` 都不动它。 */
  private groundedFrames = 0;
  /** 触发所需的连续着地帧数；构造后为 1，只由 `setGroundedFramesRequired` 改写。 */
  private groundedFramesRequired = 1;

  /**
   * 解析 `parse_teleports` 的 JSON 建两张表。
   * 顺序：先建目的地表，再用它建 `targetname → 数组下标` 的映射（同名后者覆盖前者），
   * 然后逐条建触发器（用 `target` 查映射得 `destIndex`，查不到写 -1），
   * 最后把 `insideStates` 建成长度 = 触发器数、全 false 的数组。
   * @param wasmJson `BspProcessor::parse_teleports` 返回的 JSON 文本。
   */
  constructor(wasmJson: string) {
    const data: WasmTeleportReport = JSON.parse(wasmJson);

    // 目的地表：逐字段搬运，yaw 在此处换算
    for (const d of data.teleports) {
      this.destinations.push({
        index: d.index,
        targetname: d.targetname,
        origin: { x: d.origin[0], y: d.origin[1], z: d.origin[2] },
        angles: d.angles,
        yaw: bspYawToCsYaw(d.angles[1]),
      });
    }

    // targetname → 本表下标（不是实体的 index）
    const destByName = new Map<string, number>();
    this.destinations.forEach((d, i) => {
      destByName.set(d.targetname, i);
    });

    // 触发器表：逐条查表定 destIndex（-1 = 孤儿）
    for (const t of data.triggers) {
      const destIdx = destByName.has(t.target) ? destByName.get(t.target)! : -1;
      this.triggers.push({
        index: t.index,
        classname: t.classname,
        target: t.target,
        origin: { x: t.origin[0], y: t.origin[1], z: t.origin[2] },
        model: t.model,
        mins: t.model_mins ? { x: t.model_mins[0], y: t.model_mins[1], z: t.model_mins[2] } : null,
        maxs: t.model_maxs ? { x: t.model_maxs[0], y: t.model_maxs[1], z: t.model_maxs[2] } : null,
        planes: t.model_planes
          ? t.model_planes.map((p) => ({
              normal: { x: p[0], y: p[1], z: p[2] },
              dist: p[3],
            }))
          : null,
        destIndex: destIdx,
        spawnflags: t.spawnflags ?? 1,
        startDisabled: t.start_disabled ?? false,
      });
    }

    // inside 位与触发器表等长，初值全 false
    this.insideStates = new Array(this.triggers.length).fill(false);
  }

  /** 切换触发档位。与当前档相同时直接返回（不碰任何状态）；换档时写档位、
   *  清空全部 `inside` 位、把冷却写 0；`groundedFrames` 保持不动。 */
  setTriggerMode(mode: TeleportTriggerMode): void {
    if (this.triggerMode === mode) return;
    this.triggerMode = mode;
    // 换档后旧边沿状态失去意义，逐位清零
    for (let i = 0; i < this.insideStates.length; i++) {
      this.insideStates[i] = false;
    }
    // 清零冷却，让新档位立即参与判定
    this.cooldown = 0;
  }

  /**
   * 设置连续着地帧数阈值（只在 `start-touch-grounded` 档参与判定）。
   * 写入前先 `Math.floor` 再夹紧到 `[1, 30]`；夹紧后与现值相同则直接返回。
   * 不重置 `groundedFrames`，故换阈值后判定立即按当前累积帧数比较。
   * @param frames 阈值；小于 1 取 1，大于 30 取 30。
   */
  setGroundedFramesRequired(frames: number): void {
    const clamped = Math.max(1, Math.min(30, Math.floor(frames)));
    if (this.groundedFramesRequired === clamped) return;
    this.groundedFramesRequired = clamped;
    // groundedFrames 不动，保留已累积的着地帧数
  }

  /** 传送完成后清空全部 `inside` 位，使玩家必须重新经历一次「从外到内」的跳变；
   *  不清冷却、不动 `groundedFrames`。 */
  onTeleported(): void {
    for (let i = 0; i < this.insideStates.length; i++) {
      this.insideStates[i] = false;
    }
  }

  /**
   * 判定本帧是否触发传送，命中则返回目的地对象。
   *
   * 分支顺序即语义：
   * 1. 先按**更新前**的计数器记下 `wasGrounded = groundedFrames >= groundedFramesRequired`，
   *    再按 `onGround` 更新计数器（真：`min(+1, required + 1)`；假：0）；
   * 2. `cooldown > 0` 时按 `dt` 递减并直接返回 null；此分支在非 `every-frame` 档
   *    还会先调 `updateInsideStates` 刷新全部 `inside` 位；
   * 3. 逐触发器跳过三类：`startDisabled`、`spawnflags` 的 0x01 与 0x40 两位都不含、
   *    `destIndex < 0`；
   * 4. 用 `isPlayerInTrigger` 求本帧包含关系 `nowInside`，再按档位定 `shouldFire`：
   *    `every-frame` 用 `nowInside`；`start-touch` 用 `nowInside && !insideStates[i]`；
   *    `start-touch-grounded` 用 `nowInside && !wasGrounded` 且更新后的计数器已达阈值
   *    —— 即「进入区域」与「连续着地首次达阈值」必须落在同一帧，
   *    先落地、后走进区域的那一帧不触发；
   * 5. 无论是否触发都把 `insideStates[i]` 写成 `nowInside`；
   * 6. 触发时写冷却并返回 `destinations[destIndex]`，**立即结束遍历**，
   *    故一次调用最多命中一个触发器，其余触发器本帧的 `inside` 位不更新。
   * 遍历完未命中返回 null。
   * @param pos 玩家当前坐标（Y-up）。
   * @param dt 距上次调用的秒数；只用于冷却递减。
   * @param onGround 本帧是否着地；只影响计数器与 `start-touch-grounded` 档。
   * @returns 命中的目的地对象（`destinations` 内的原对象）；未命中为 null。
   */
  checkTeleport(pos: Vec3, dt: number, onGround: boolean = false): TeleportDestination | null {
    // 更新前取阈值比较结果，供着地边沿判定使用
    const wasGrounded = this.groundedFrames >= this.groundedFramesRequired;

    // 计数器先行更新（冷却期同样更新）；上限 required + 1 保住「已达阈值」的单调性
    if (onGround) {
      this.groundedFrames = Math.min(this.groundedFrames + 1, this.groundedFramesRequired + 1);
    } else {
      this.groundedFrames = 0;
    }

    if (this.cooldown > 0) {
      this.cooldown -= dt;
      // 冷却期照常刷新 inside 位，否则冷却结束那一帧会被当成「刚进入」
      if (this.triggerMode !== 'every-frame') {
        this.updateInsideStates(pos);
      }
      return null;
    }

    // 玩家资格两位常量
    const SPAWNFLAG_CLIENTS = 0x01;
    const SPAWNFLAG_EVERYTHING = 0x40;

    for (let i = 0; i < this.triggers.length; i++) {
      const trigger = this.triggers[i];
      // 跳过被标为禁用的触发器
      if (trigger.startDisabled) {
        continue;
      }
      // 跳过不对玩家生效的触发器（0x01 与 0x40 两位都不含）
      const sf = trigger.spawnflags;
      if ((sf & SPAWNFLAG_CLIENTS) === 0 && (sf & SPAWNFLAG_EVERYTHING) === 0) {
        continue;
      }
      if (trigger.destIndex < 0) {
        continue; // 孤儿触发器：没有同名目的地
      }

      const nowInside = this.isPlayerInTrigger(pos, trigger);

      // 档位判定
      let shouldFire = false;
      if (this.triggerMode === 'every-frame') {
        // 每帧包含判定
        shouldFire = nowInside;
      } else if (this.triggerMode === 'start-touch') {
        // 仅在 false → true 的那一帧触发
        const wasInside = this.insideStates[i];
        shouldFire = nowInside && !wasInside;
      } else {
        // 区域内 + 本帧是着地边沿 + 更新后已达阈值
        const grounded = this.groundedFrames >= this.groundedFramesRequired;
        shouldFire = nowInside && !wasGrounded && grounded;
      }

      // 无论是否触发都刷新 inside 位
      this.insideStates[i] = nowInside;

      if (shouldFire) {
        this.cooldown = TRIGGER_COOLDOWN;
        return this.destinations[trigger.destIndex] ?? null;
      }
    }
    return null;
  }

  /** 冷却期用的批量刷新：把每个触发器的 `inside` 位写成当前位置的包含关系，
   *  不触发、不写冷却。 */
  private updateInsideStates(pos: Vec3): void {
    for (let i = 0; i < this.triggers.length; i++) {
      this.insideStates[i] = this.isPlayerInTrigger(pos, this.triggers[i]);
    }
  }

  /** 三级判据按序短路：凸包平面（`planes` 非空）> AABB（`mins` 与 `maxs` 同时非 null）
   *  > 球形回退（`origin` 为球心、`TRIGGER_RADIUS` 为半径的闭球）。
   *  平面级：任一平面算得 `dot(n, pos) - dist > 0.001` 即判在外，全部通过才算在内；
   *  AABB 级：三轴闭区间包含；球级：`distSq <= TRIGGER_RADIUS²`。 */
  private isPlayerInTrigger(pos: Vec3, trigger: TeleportTrigger): boolean {
    // 凸包精准判定（法线朝外：内部 dot(n, pos) - dist <= 0）
    if (trigger.planes && trigger.planes.length > 0) {
      for (const p of trigger.planes) {
        const d =
          p.normal.x * pos.x + p.normal.y * pos.y + p.normal.z * pos.z - p.dist;
        if (d > 0.001) return false;
      }
      return true;
    }
    if (trigger.mins && trigger.maxs) {
      // AABB 包含（三轴闭区间）
      return (
        pos.x >= trigger.mins.x && pos.x <= trigger.maxs.x &&
        pos.y >= trigger.mins.y && pos.y <= trigger.maxs.y &&
        pos.z >= trigger.mins.z && pos.z <= trigger.maxs.z
      );
    }
    // 球形回退
    const dx = pos.x - trigger.origin.x;
    const dy = pos.y - trigger.origin.y;
    const dz = pos.z - trigger.origin.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq <= TRIGGER_RADIUS * TRIGGER_RADIUS;
  }

  /** 触发器表长度（含孤儿与禁用项）。本工程内无调用点。 */
  get triggerCount(): number {
    return this.triggers.length;
  }

  /** 触发器表本体（`readonly` 只是类型约束，数组本身仍是内部那个）。
   *  调用方 `loadScene` 用展开复制后再交给 `ColliderDebug`；`PlaneInspector` 也读它。 */
  getTriggers(): readonly TeleportTrigger[] {
    return this.triggers;
  }

  /** 目的地表长度。本工程内无调用点。 */
  get destCount(): number {
    return this.destinations.length;
  }

  /** 把冷却写 0，使下一次 `checkTeleport` 立即参与判定（不动 `inside` 位与着地计数）。 */
  resetCooldown(): void {
    this.cooldown = 0;
  }
}
