/**
 * 主线程权威校准器：把 Worker 权威帧折算成渲染物理的速度耦合与起跳门槛，
 * 并提供「渲染主线 → 权威」的反向同步出口与权威位姿外推纯函数。
 *
 * 定位：共享层 `src/ts-shared/` 的物理侧模块。它不产生权威帧、不持有物理世界、
 * 不接触渲染与相机：权威帧经 `CalibratorDeps` 的 `readAuth` 注入（两端实现是
 * `src/ts-shared/auth/shared-state.ts` 的 `readAuthoritative`），渲染物理经
 * `CalibratorDeps` 的 `getPhys` 注入，渲染 → 权威的出口是 `CalibratorDeps` 的
 * `onSyncRenderState`。
 *
 * 上下游各一个调用点：
 * - 上游（喂入）：`apps/game/src/renderer/renderer-main.ts` 的 `RendererMain.tick`
 *   —— 每渲染帧在推进物理前依次调 `correctFromAuthority` 与 `calibrateVelocity`；
 *   `apps/debug/src/renderer/renderer-main.ts` 的 `RendererMain.tick` 同序调用，且这两次
 *   调用带 `!this.replayMode` 守卫（debug 独有的回放模式；game 侧无回放分支）。
 *   两端的 `RendererMain` 构造函数各构造一份本类实例。
 * - 下游（喂出）：`src/ts-shared/auth/worker-dispatch.ts` 的 `sync-render-state`
 *   分支 —— 消费 `onSyncRenderState` 发出的渲染主线全状态；两端 `app.ts` 负责把
 *   回调接成 `postMessage`。
 *
 * 关键不变量（每条都能在代码里逐行核对）：
 * 1. 单向读权威：权威帧只经 `readAuth` 读入，本文件从不写权威；唯一的
 *    渲染 → 权威出口是 `onSyncRenderState`（`emitTeleportSync` 与
 *    `routineReanchor` 各调用一次）。
 * 2. 稳态不改渲染位置：`phys.set_state` 在本文件只出现三处 —— `resetTo`（写调用方
 *    传入的位置/角度、速度清零、`onGround` 置真）、`correctFromAuthority` 的
 *    `predStarted === false` 首帧分支（以权威帧全状态作渲染起点）、
 *    `applyCollisionCorrection` 的 `land` 分支（写回刚从 `phys.state()` 读到的
 *    同一组位置/角度，位置与角度都零变化）。
 * 3. 帧龄基准是同线程时钟：`authArrivedAtMs` 记主线程 `performance.now()`，
 *    `calibrateVelocity(now)` 的 `now` 由调用方传 rAF 时间戳；不使用
 *    `AuthFrame.timeMs`（Worker 与主线程的时钟基准不同）。
 * 4. 权威对渲染的稳态影响只有速度：`calibrateVelocity` 每渲染帧覆盖速度，
 *    `applyCollisionCorrection` 的 `land` 分支覆盖落地速度；稳态下角度不被本文件
 *    改写。
 * 5. 每个公开方法都能空跑：`getPhys()` 或 `readAuth()` 返回 null 时立即返回，
 *    不产生任何副作用。
 *
 * 边界与容错：
 * - `onSyncRenderState` 是可选成员，缺省时经 `?.` 退化为空操作（本地状态照常推进）。
 * - `readAuth()` 返回的 `va` 与 `lastVa` 相等即早退：同一权威帧被重复读到不产生动作。
 * - 传送/重置豁免期（`performance.now() < teleportExemptUntilMs`）走独立分支，
 *   不参与 `va` 递增判定，也不用权威帧的位置/角度覆盖渲染物理。
 * - `computeAuthAccel` 在首帧、差分基准缺失（`prevAuthTimeMs <= 0`）、
 *   `dt < 0.001s`、`dt > 0.5s` 或重锚抑制窗内返回零加速度；结果按分量 clamp 到
 *   ±20000。
 * - `calibrateVelocity` 在 `dt <= 0` 或 `dt > 0.1s` 时退化为直接写权威原始速度，
 *   不做加速度外推。
 * - `applyCollisionCorrection` 在 `kind !== 'land'` 或渲染自己 `onGround` 为假时
 *   零写入（连速度也不写）。
 * - `extrapolateAuthPose` 把外推时长 clamp 到 `[0, EXTRAP_MAX_MS]`：超限后输出不再
 *   随 `nowMs` 变化，等于冻结在「权威帧位置 + 该上限对应的位移」。
 *
 * 测试归属：本文件无测试（`src/ts-shared/` 下的 `*.test.ts` 均不覆盖它）。唯一的
 * 自动化消费方是 `apps/debug/scripts/jump-apex-verify.mjs`（由 `apps/debug` 的
 * `test:jump-apex` 脚本用 esbuild 打包本文件后驱动）：它注入桩 `deps` 构造
 * `AuthorityCalibrator`，并在关闭加速度外推的档位下覆写 `computeAuthAccel`。
 *
 * 与相邻文件的边界：物理常量与碰撞解算在 `src/phys/**`；碰撞事件种类的判定在
 * `src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics`；`teleport` 标志在 Worker 侧的
 * 落地语义在 `src/ts-shared/auth/worker-dispatch.ts` 的 `sync-render-state` 分支；
 * 渲染、相机与输入采样在两端 `renderer-main.ts`。本文件三者都不涉及。
 */

import type { AuthFrame } from '../auth/shared-state.js';

/**
 * 主线程渲染物理的最小结构面：本文件只用下面三个方法。
 *
 * 满足者：两端 `renderer-main.ts` 的 `RendererMain.predPhys`（wasm `PhysWorld`，
 * 见 `src/phys/mod.rs`），测试侧由桩对象满足。
 */
export interface CalibratorPhys {
  /** 取当前全状态。声明为 `unknown` 是因为这是 wasm 绑定的返回类型；本文件统一
   *  cast 到 `SyncPhysState` 后按字段读取。 */
  state(): unknown;
  /** 用 9 个分量整体覆盖状态：位置、yaw、pitch、速度、着地。
   *  调用点仅 `resetTo`、`correctFromAuthority` 的首帧分支、
   *  `applyCollisionCorrection` 的 `land` 分支。
   *  `src/phys/mod.rs` 的 `PhysWorld::set_state` 还会把 `prev_origin` 一并对齐到新
   *  位置。 */
  set_state(
    posX: number,
    posY: number,
    posZ: number,
    yaw: number,
    pitch: number,
    velX: number,
    velY: number,
    velZ: number,
    onGround: boolean,
  ): void;
  /** 只覆盖速度三分量（HU/s），位置/朝向/着地不动。
   *  调用点：`calibrateVelocity`（每渲染帧）与 `correctFromAuthority` 的同步在途
   *  撤回分支。 */
  set_velocity(x: number, y: number, z: number): void;
}

/**
 * 反向同步载荷：渲染主线的 10 个字段。
 *
 * 由 `emitTeleportSync` / `routineReanchor` 从 `phys.state()` 逐字段拷贝构造
 * （只取这 10 个键，渲染状态的其它字段不过线），经 `onSyncRenderState` 交给调用方；
 * 两端 `app.ts` 把它作为 `sync-render-state` 消息的 `state` 发出。
 * 无缺省字段：构造方必须给出全部 10 项（`eyeHeight` 由两端 `RendererMain`
 * 从渲染物理状态里取）。
 */
export interface SyncRenderState {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  velX: number;
  velY: number;
  velZ: number;
  onGround: boolean;
  eyeHeight: number;
}

/**
 * `CalibratorPhys.state()` 返回值的结构性解读 —— 与 `SyncRenderState` 是同一个
 * 类型（别名，不新声明接口），字段与含义完全一致。
 *
 * 别名的理由：两者描述同一份数据，区别只在角色 —— 此处指「本类刚从渲染物理读到的
 * 状态」，`SyncRenderState` 指「要发给权威的同步载荷」。本类用它作 `emitTeleportSync`
 * 与 `routineReanchor` 的形参类型，以及 `correctFromAuthority` 里两处 cast 的目标。
 */
export type SyncPhysState = SyncRenderState;

/** 本类的全部外部依赖（构造函数注入，无默认实现、无缺省分支）。 */
export interface CalibratorDeps {
  /** 取最新权威帧与版本号 `va`；尚无可用帧时返回 null。
   *  调用点：`correctFromAuthority` 每次被调用时读一次。 */
  readAuth(): { frame: AuthFrame; va: number } | null;
  /** 取当前渲染物理；未就绪（场景未加载/已销毁）时返回 null。
   *  调用点：`correctFromAuthority`、`calibrateVelocity`、`resetTo`、
   *  `applyCollisionCorrection`。 */
  getPhys(): CalibratorPhys | null;
  /** 丢弃主线程待喂输入（鼠标增量 + 按键位）。
   *  调用点：`resetTo`（位置突变后残留方向/跳跃无意义）与 `correctFromAuthority` 的
   *  yaw 分叉兜底分支。 */
  clearPendingInput(): void;
  /**
   * 渲染主线全状态 → 权威；可选成员，未注册时调用方经 `?.` 静默跳过。
   *
   * @param s 渲染主线当前状态（10 字段）。
   * @param teleport true = 真位置突变口径（`resetTo` 之后的豁免期同步、yaw 分叉兜底
   *   同步）—— Worker 侧允许丢弃未消费输入增量；false = 常规反向重锚口径
   *   （`routineReanchor`）—— Worker 侧保留输入增量，并保留权威自身的速度与着地。
   *   消费点：`src/ts-shared/auth/worker-dispatch.ts` 的 `sync-render-state` 分支
   *   （`teleport === false` 与其余值走两条不同分支）。
   */
  onSyncRenderState?(s: SyncRenderState, teleport: boolean): void;
}

/** 本类内部持有的权威帧快照：`AuthFrame` 的字段，再加差分算出的 `accel`。 */
interface AuthSnap {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  vel: { x: number; y: number; z: number };
  /** 权威最近加速度（u/s²）：`computeAuthAccel` 用相邻两条权威帧的速度差除以两条帧
   *  `timeMs` 之差得出；取不到基准时为零向量。 */
  accel: { x: number; y: number; z: number };
  eyeHeight: number;
  /** 权威帧自带的产生时刻（Worker 时钟，ms）。只用于加速度差分，不作帧龄
   *  （帧龄见 `authArrivedAtMs`）。 */
  timeMs: number;
}

/**
 * 角度（度）归一化到 `[-180, 180)`：先 `(a + 180) % 360`，再 `+360`，再 `% 360`，
 * 最后 `-180`。`%` 对负数保留符号，三步取模把负输入也拉回区间。
 *
 * 输入输出：数值进、数值出；`NaN` 进 `NaN` 出（实现无分支）。
 * 端点行为：`normalizeAngleDeg(180)` 与 `normalizeAngleDeg(-180)` 都返回 -180，故
 * +180 不会作为返回值出现；`-0` 归一为 `0`。等值输入（相差 360 的整数倍）得到同一
 * 结果，故本函数可直接用于最小角差。
 * 副作用：无（纯函数）。
 * 调用点：`correctFromAuthority` —— 算渲染 yaw 与权威 yaw 的最小角差（取绝对值后与
 * `YAW_FAULT_DEG` 比较），以及相邻两次消费之间渲染 yaw 的变化量（与 `YAW_STILL_DEG`
 * 比较）。本仓其它文件不引用它。
 */
export function normalizeAngleDeg(a: number): number {
  return ((a + 180) % 360 + 360) % 360 - 180;
}

// ── 权威位姿外推（纯函数）─────────────────────────────────────────────

/** 外推输入帧的结构最小面：位置、速度、yaw、pitch、`eyeHeight`、`timeMs`。
 *  `src/ts-shared/auth/shared-state.ts` 的 `AuthFrame` 与本文的 `AuthSnap` 都
 *  结构性地满足它（多出的 `onGround` / `accel` 不参与外推）。 */
export interface ExtrapolatableFrame {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  eyeHeight: number;
  /** 权威帧产生时刻（ms），与 `nowMs` 必须同基准。 */
  timeMs: number;
}

/** 外推输出位姿：世界坐标 + 角度（度）+ 眼高。本函数不做弧度换算：`yaw` / `pitch`
 *  与输入同为度，`eyeHeight` 原样透传。 */
export interface ExtrapolatedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  eyeHeight: number;
}

/** 外推时长上限（ms）：`extrapolateAuthPose` 把 `nowMs - frame.timeMs` 先 clamp 到
 *  `[0, 本值]`，因此权威帧停更后输出位姿不再随时间变化。 */
export const EXTRAP_MAX_MS = 250;

/**
 * 权威位姿一阶外推（纯函数，无副作用）：
 *
 *   t   = clamp(nowMs − frame.timeMs, 0, EXTRAP_MAX_MS) / 1000
 *   pos = frame.pos + frame.vel × t
 *   yaw / pitch / eyeHeight = frame 的对应字段（不做任何变换）
 *
 * 输入：`frame`（`ExtrapolatableFrame`）与 `nowMs`（毫秒时刻，需与 `frame.timeMs`
 * 同基准）。输出：新对象，不修改 `frame`。
 * 退化：`nowMs <= frame.timeMs` → `t = 0`，输出等于权威帧原位姿；
 * `nowMs - frame.timeMs > EXTRAP_MAX_MS` → `t` 固定为 `EXTRAP_MAX_MS / 1000`，输出
 * 成为常量，不再随 `nowMs` 增长。
 * 无加速度项：位移只含 `frame.vel × t` 这一项（`frame` 上也没有加速度字段）。
 * 调用点：本仓无调用点 —— `extrapolateAuthPose`、`EXTRAP_MAX_MS`、
 * `ExtrapolatedPose`、`ExtrapolatableFrame` 四个导出只出现在本文件内。
 */
export function extrapolateAuthPose(frame: ExtrapolatableFrame, nowMs: number): ExtrapolatedPose {
  const dtS = Math.max(0, Math.min(EXTRAP_MAX_MS, nowMs - frame.timeMs)) / 1000;
  return {
    x: frame.pos.x + frame.vel.x * dtS,
    y: frame.pos.y + frame.vel.y * dtS,
    z: frame.pos.z + frame.vel.z * dtS,
    yaw: frame.yaw,
    pitch: frame.pitch,
    eyeHeight: frame.eyeHeight,
  };
}

/**
 * 权威校准器：每个主线程渲染帧调用一次，把权威帧转成渲染物理的速度耦合，并在判定
 * 双端视角走散时经 `onSyncRenderState` 反向同步权威。
 *
 * 状态全部是本实例私有字段（权威帧快照、版本号、各类时间戳与计数）；`clear()` 把
 * 它们整体复位，因此换图或重装物理实例之后必须调它。
 * 不持有物理实例、不持有渲染资源：两者经 `CalibratorDeps` 注入，`getPhys()` 返回
 * null 时全部方法空跑。
 * 调用点：`apps/debug` 与 `apps/game` 的 `RendererMain` 各构造一份实例
 * （`apps/viewer` 不引用本文件）。
 */
export class AuthorityCalibrator {
  private lastVa = -1;
  private curAuth: AuthSnap | null = null;
  private prevAuthVel: { x: number; y: number; z: number } | null = null;
  private prevAuthTimeMs = 0;
  /** 反向同步在途标志：置真后 `correctFromAuthority` 只做追平判定与撤回监视，不再
   *  触发新的兜底同步。 */
  private syncInFlight = false;
  /** 上次同步或撤回的时刻（`performance.now()`，ms）；`SYNC_COOLDOWN_MS` 冷却以此为
   *  基准。0 = 本实例还没同步过。 */
  private lastSyncAt = 0;
  /** 首帧诊断日志只打印一次的哨兵；不参与任何状态迁移。 */
  private authFirstFrameLogged = false;
  /** 渲染物理是否已确立起点：false 时 `correctFromAuthority` 用权威帧全状态写渲染
   *  起点，true 时权威帧不再决定渲染位置。 */
  private predStarted = false;
  /**
   * 传送/重置豁免窗口的截止时刻（`performance.now()`，ms）；`resetTo` 把它设为
   * `now + TELEPORT_EXEMPT_MS`。
   *
   * 窗口内 `correctFromAuthority` 走独立分支：照常记录权威帧（供 `calibrateVelocity`
   * 外推速度）、把渲染当前状态以 `teleport = true` 反向同步给权威、置
   * `predStarted = true`、把 `prevFrameRenderYaw` 对齐到渲染当前 yaw 并把
   * `yawDivergedFrames` 清零；不使用权威帧的位置/角度覆盖渲染物理。
   */
  private teleportExemptUntilMs = 0;

  /** 保存依赖引用；构造本身不读权威、不取物理、不注册回调。 */
  constructor(private readonly deps: CalibratorDeps) {}

  /** 兜底同步冷却（ms）：`lastSyncAt` 之后这么久内不触发新的兜底同步；同步在途的
   *  追平与撤回判定不受它限制。 */
  static readonly SYNC_COOLDOWN_MS = 250;

  /**
   * 主线程读到最近一条权威帧的时刻（`performance.now()`，ms）。
   *
   * `calibrateVelocity` 以 `now - authArrivedAtMs` 作为帧龄做加速度外推；不使用
   * `AuthFrame.timeMs`（Worker 与主线程的时钟基准不同）。
   */
  private authArrivedAtMs = 0;

  // ── yaw 分叉兜底判据的状态 ────────────────────────────────────────────
  /** 上一条权威帧被消费时渲染物理的 yaw（度）；「渲染 yaw 是否已静止」判据的左端。 */
  private prevFrameRenderYaw = 0;
  /** 连续满足「渲染 yaw 静止且与权威 yaw 分叉超阈值」的权威帧计数；任一帧不满足即
   *  清零。 */
  private yawDivergedFrames = 0;

  /** yaw 分叉兜底的连续帧数门限：计数达到它才置 `syncInFlight` 并反向同步。 */
  static readonly YAW_FAULT_FRAMES = 8;
  /** yaw 分叉阈值（度）：渲染 yaw 与权威 yaw 的最小角差绝对值超过它才算分叉。 */
  static readonly YAW_FAULT_DEG = 45;
  /** 「渲染 yaw 已静止」阈值（度）：相邻两次消费之间渲染 yaw 的变化量绝对值小于它
   *  才算静止。 */
  static readonly YAW_STILL_DEG = 1;

  /** 位置残差通道不存在：本类没有位置校正的量值、门限或计时字段，稳态下渲染位置
   *  不由本类改写（见 `resetTo` 与 `correctFromAuthority` 的首帧分支）。 */

  /** 传送/重置豁免时长（ms）：`resetTo` 用它把 `teleportExemptUntilMs` 推到当前时刻
   *  之后。 */
  static readonly TELEPORT_EXEMPT_MS = 200;

  // ── 常规反向重锚 ──────────────────────────────────────────────────────
  /**
   * 常规重锚的位置门限（HU）。
   *
   * 判定量是 `routineReanchor` 用 `Math.hypot` 算出的「渲染当前位置 − 权威帧 `pos`」
   * 三维距离。权威帧的 `pos` 是权威侧**发布**的位置，渲染主线在同一时刻已经又推进了
   * 一段距离，因此这个差里含一部分**时钟滞后**而不全是几何漂移；门限取值即「只有
   * 超出这一量级的偏移才值得立刻对齐」。
   *
   * 重锚只经 `onSyncRenderState` 改权威侧的位置与角度，不触碰渲染物理：渲染速度仍由
   * 渲染物理自身推进，权威速度仍由权威自己产出并逐帧经 `calibrateVelocity` 写进渲染。
   */
  static readonly ROUTINE_ANCHOR_HU = 16;
  /** 两次常规重锚之间的最小间隔（ms）：间隔不足时 `routineReanchor` 直接返回。 */
  static readonly ROUTINE_ANCHOR_MIN_GAP_MS = 50;
  /** 常规重锚的兜底间隔（ms）：偏移未超门限但距上次重锚已达该间隔时，仍执行一次对齐。 */
  static readonly ROUTINE_ANCHOR_MAX_GAP_MS = 250;

  /** 上次常规重锚的时刻（`performance.now()`，ms）。初值 -Infinity 使首次调用必定通过
   *  间隔判定。 */
  private lastRoutineAnchorAtMs = Number.NEGATIVE_INFINITY;
  /**
   * 重锚后需要抑制加速度输出的次数（`routineReanchor` 置 2，`computeAuthAccel` 每被
   *  调用一次减 1）。
   *
   * 重锚把权威位置瞬移，下一条权威帧算出的速度差里含这段瞬移；不抑制的话
   * `computeAuthAccel` 会把瞬移折算成加速度，再由 `calibrateVelocity` 写进渲染速度。
   * 抑制期间 `computeAuthAccel` 照常刷新差分基准，只返回零加速度。
   */
  private accelSuppressFrames = 0;

  /** 以 `teleport = true` 发出渲染主线全状态（真位置突变口径）。
   *  只调 `onSyncRenderState`，不触碰 `phys`；该回调未注册时整个调用经 `?.` 退化为
   *  空操作。调用点：`correctFromAuthority` 的豁免期分支与 yaw 分叉兜底分支。 */
  private emitTeleportSync(st: SyncPhysState): void {
    this.deps.onSyncRenderState?.(
      {
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround, eyeHeight: st.eyeHeight,
      },
      true, // teleport = true：真位置突变口径（Worker 侧允许丢弃未消费输入增量）
    );
  }

  /**
   * 常规反向重锚：按 `ROUTINE_ANCHOR_*` 节拍把渲染当前位置与角度推给权威。
   *
   * 两道门（任一命中即返回，不写任何状态）：距上次重锚不足
   * `ROUTINE_ANCHOR_MIN_GAP_MS`；或 `drift`（渲染当前位置与权威帧 `pos` 的三维距离）
   * 未超 `ROUTINE_ANCHOR_HU` 且距上次重锚不足 `ROUTINE_ANCHOR_MAX_GAP_MS`。
   *
   * 通过门后依次：记下重锚时刻、清空速度差分基准（`prevAuthVel` / `prevAuthTimeMs`）、
   * 把 `accelSuppressFrames` 置 2，然后以 `teleport = false` 发 `onSyncRenderState`。
   *
   * 副作用：写 `lastRoutineAnchorAtMs` / `prevAuthVel` / `prevAuthTimeMs` /
   * `accelSuppressFrames`，并调一次回调。不触碰 `phys`，也不改 `predStarted`。
   * 调用点：`correctFromAuthority`（每个渲染帧一次，在同步在途与冷却判定之前）。
   */
  private routineReanchor(st: SyncPhysState, authPos: { x: number; y: number; z: number }): void {
    const now = performance.now();
    const since = now - this.lastRoutineAnchorAtMs;
    if (since < AuthorityCalibrator.ROUTINE_ANCHOR_MIN_GAP_MS) return;
    const drift = Math.hypot(st.posX - authPos.x, st.posY - authPos.y, st.posZ - authPos.z);
    if (drift <= AuthorityCalibrator.ROUTINE_ANCHOR_HU &&
        since < AuthorityCalibrator.ROUTINE_ANCHOR_MAX_GAP_MS) {
      return;
    }
    this.lastRoutineAnchorAtMs = now;
    // 清差分基准 + 抑制两次：重锚瞬移不折算成加速度（见 accelSuppressFrames）
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.accelSuppressFrames = 2;
    this.deps.onSyncRenderState?.(
      {
        posX: st.posX, posY: st.posY, posZ: st.posZ,
        yaw: st.yaw, pitch: st.pitch,
        velX: st.velX, velY: st.velY, velZ: st.velZ,
        onGround: st.onGround, eyeHeight: st.eyeHeight,
      },
      false, // teleport = false：常规重锚口径（Worker 侧保留未消费输入增量）
    );
  }

  /**
   * 每个渲染帧消费一次权威帧 —— 只读权威 + 速度耦合，稳态下不写渲染位置。
   *
   * 分支顺序：
   * ① 豁免期（`performance.now() < teleportExemptUntilMs`）：记录权威帧快照、
   *    取渲染当前状态、以 `teleport = true` 反向同步、置 `predStarted`、把
   *    `prevFrameRenderYaw` 对齐到渲染当前 yaw 并清零 `yawDivergedFrames`，随后返回；
   * ② `va` 与 `lastVa` 相等 → 没有新权威帧，返回；
   * ③ 首帧（`predStarted === false`）：用权威帧全状态写渲染物理起点，随后返回；
   * ④ 常规路径：算 `dist` 与 `yawDiff` → `routineReanchor` → 同步在途的追平/撤回 →
   *    冷却判定 → yaw 分叉判据。
   *
   * 副作用：写 `lastVa` / `curAuth` / `authArrivedAtMs` / `predStarted` /
   * `prevFrameRenderYaw` / `yawDivergedFrames` / `syncInFlight` / `lastSyncAt`；
   * 按分支调 `phys.set_state`（只在前两处的首帧分支）、`phys.set_velocity`（只在同步
   * 在途的撤回分支）、`routineReanchor`、`onSyncRenderState`、`clearPendingInput`。
   * `getPhys()` 或 `readAuth()` 返回 null 时整体空跑。
   * 调用点：两端 `RendererMain.tick`（每渲染帧，在 `calibrateVelocity` 与物理推进
   * 之前；回放模式下跳过）。
   */
  correctFromAuthority(): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    const auth = this.deps.readAuth();
    if (!auth) return;

    // ── 豁免期（resetTo 之后的 TELEPORT_EXEMPT_MS 窗口）──
    // 不把权威帧的位置/角度写进渲染物理；只刷新权威帧快照供 calibrateVelocity 外推
    // 速度，并把渲染当前状态以 teleport=true 同步给权威，让权威侧在新位置追平。
    if (performance.now() < this.teleportExemptUntilMs) {
      // 记录权威帧快照（供 calibrateVelocity 外推速度），不写渲染物理
      this.lastVa = auth.va;
      const f = auth.frame;
      this.curAuth = {
        pos: { ...f.pos },
        yaw: f.yaw,
        pitch: f.pitch,
        vel: { ...f.vel },
        accel: this.computeAuthAccel(f.vel, f.timeMs),
        eyeHeight: f.eyeHeight,
        timeMs: f.timeMs,
      };
      // 渲染当前状态 → 权威（teleport=true：允许 Worker 丢弃未消费输入增量）
      const st = phys.state() as unknown as SyncPhysState;
      this.emitTeleportSync(st);
      // 置 predStarted：窗口结束后不再走首帧分支，权威帧不会覆盖渲染位置
      this.predStarted = true;
      // 分叉状态对齐到渲染当前值：窗口内权威 yaw 不参与分叉累计
      this.prevFrameRenderYaw = st.yaw;
      this.yawDivergedFrames = 0;
      return;
    }

    if (auth.va === this.lastVa) return;
    this.lastVa = auth.va;
    // 诊断：首帧到达时刻（只打印一次，不改变任何状态迁移）。与两端 app.ts 的
    // `[authority] world-json 已发送 @T` 相减 = Worker 侧「构建碰撞世界 + 首个 tick」
    // 的端到端耗时（两者同为 performance.now 基准）。
    if (!this.authFirstFrameLogged) {
      this.authFirstFrameLogged = true;
      console.info(`[authority] 首个权威帧 @${performance.now().toFixed(0)}ms（va=${auth.va}）`);
    }
    // 帧龄基准 = 主线程读到这一帧的时刻（同线程时钟）。
    // 不用 frame.timeMs：那是 Worker 的 performance.now，与主线程不同基准。
    this.authArrivedAtMs = performance.now();
    const f = auth.frame;
    this.curAuth = {
      pos: { ...f.pos },
      yaw: f.yaw,
      pitch: f.pitch,
      vel: { ...f.vel },
      accel: this.computeAuthAccel(f.vel, f.timeMs),
      eyeHeight: f.eyeHeight,
      timeMs: f.timeMs,
    };

    // 首帧分支（含 clear() 之后）：以权威帧全状态作渲染物理起点
    if (!this.predStarted) {
      this.predStarted = true;
      phys.set_state(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.vel.x, f.vel.y, f.vel.z, f.onGround);
      this.prevFrameRenderYaw = f.yaw;
      return;
    }

    const st = phys.state() as unknown as SyncPhysState;
    // dist 只用于同步在途的追平与撤回判定；它不参与下方的兜底触发条件。
    const dist = Math.hypot(st.posX - f.pos.x, st.posY - f.pos.y, st.posZ - f.pos.z);

    const yawDiff = Math.abs(normalizeAngleDeg(st.yaw - f.yaw));
    const now = performance.now();

    // ── 常规反向重锚 ────────────────────────────────────────────────────
    // 放在 syncInFlight 与冷却早退之前：位置对齐与 yaw 兜底互不影响，而重锚每个渲染
    // 帧都要有机会执行，否则同步在途或冷却期间权威会持续跑偏。
    // 本调用只把渲染状态推给权威，不碰 phys。
    this.routineReanchor(st, f.pos);

    // 追平判定（结束同步在途）：dist < 300 且 yawDiff <= 45°
    if (this.syncInFlight && dist < 300 && yawDiff <= 45) {
      this.syncInFlight = false;
    }
    if (this.syncInFlight) {
      // 撤回监视：同步在途期间若 dist > 500 或 yawDiff > 45°，视为同步未生效或渲染侧
      // 继续漂移 → 结束在途状态并记冷却。
      //
      // 这里只重述速度（phys.set_velocity），不写位置：AuthFrame.pos 是权威侧发布的
      // 位置，把它写回渲染物理等于把渲染拉向另一个时刻的采样点，并且会被 Worker 正在
      // 采样的那条折线再次读走（自反馈）。速度重述与 calibrateVelocity 同值同语义，
      // 只是立即生效而非等下一帧外推。
      //
      // 这里不调 clearPendingInput()：清掉的会是渲染当帧的鼠标增量。输入清空只发生在
      // 下方的 yaw 分叉兜底分支。
      if (dist > 500 || yawDiff > 45) {
        phys.set_velocity(f.vel.x, f.vel.y, f.vel.z);
        this.syncInFlight = false;
        this.lastSyncAt = now;
        this.prevFrameRenderYaw = st.yaw;
        this.yawDivergedFrames = 0;
      }
      return;
    }

    // 冷却门：上次同步或撤回之后 SYNC_COOLDOWN_MS 内不触发新的兜底同步。
    if (now - this.lastSyncAt < AuthorityCalibrator.SYNC_COOLDOWN_MS) return;

    // ── 位置校正：本类不做 ───────────────────────────────────────────────
    // 稳态下不把渲染位置朝权威拉：那会消耗渲染物理的前瞻量，直接表现为输入到显示的
    // 延迟。位置偏差由本文件之外的两处收敛 —— `src/ts-shared/auth/auth-loop.ts` 的
    // `setFixedDt` 在步长未变时返回 false，调用方据此跳过 `reset()`，权威时钟不再每次
    // 物理配置消息都丢时间；以及 `calibrateVelocity` 的帧龄取主线程到达时刻，使写进
    // 渲染的速度是外推后的新值。

    // 兜底判据只有一条 —— yaw 分叉（位置类判据在本文件不存在）：
    // 「渲染 yaw 连续 YAW_FAULT_FRAMES 条权威帧静止不动，却仍与权威 yaw 分叉超过
    // YAW_FAULT_DEG 度」。
    //
    // 判据为什么先看「渲染 yaw 还动不动」：权威 yaw 落后渲染 yaw 一个 tick 的未消费
    // 鼠标增量，因此只要渲染 yaw 仍在被输入推动，分叉就是双线相位的正常滞后；渲染
    // yaw 静止（相邻两次消费之间变化 < YAW_STILL_DEG 度）而权威仍分叉，才是双端视角
    // 真的走散（权威侧丢输入或被卡住）。连续帧数门限用于滤掉落地/撞墙瞬间的单帧抖动。
    //
    // 未被采用的做法（记录备查）：直接判断跨线程鼠标累加器在权威 tick 后是否已排空
    // ——那需要 Worker 侧回传「已排空」信号，接口不在本文件。现判据只用已注入的 deps
    // （getPhys / readAuth / clearPendingInput），零新增接口。
    // 渲染 yaw 是否仍在被输入推动（相邻两次消费之间变化小于阈值 = 已静止）
    const yawStill =
      Math.abs(normalizeAngleDeg(st.yaw - this.prevFrameRenderYaw)) <
      AuthorityCalibrator.YAW_STILL_DEG;
    this.prevFrameRenderYaw = st.yaw;
    if (yawDiff > AuthorityCalibrator.YAW_FAULT_DEG && yawStill) {
      this.yawDivergedFrames++;
    } else {
      this.yawDivergedFrames = 0;
    }
    const shouldSync = this.yawDivergedFrames >= AuthorityCalibrator.YAW_FAULT_FRAMES;
    if (shouldSync) {
      this.syncInFlight = true;
      this.lastSyncAt = now;
      // 分叉兜底按传送口径发（teleport=true）：此时渲染视角已静止，未消费的鼠标增量
      // 对新状态无意义。
      this.emitTeleportSync(st);
      // 清主线程待喂输入（同步瞬间的旧增量不注入新状态）
      this.deps.clearPendingInput();
      // 计数不复位：它只由上方抽样逻辑（不满足分叉时）或同步在途的撤回分支清零。
    }
  }

  /**
   * 权威最近加速度（u/s²）：相邻两条权威帧的速度差除以两条帧 `timeMs` 之差。
   *
   * 差分基准是 `prevAuthVel` / `prevAuthTimeMs`，且本方法**每次调用都刷新基准**
   * （即使本次不输出加速度），因此基准的推进节奏由 `correctFromAuthority` 的调用
   * 节奏决定。
   * 返回零向量的场景：重锚抑制窗内（`accelSuppressFrames > 0`）、尚无基准
   * （`prevAuthVel` 为 null 或 `prevAuthTimeMs <= 0`）、帧间隔 `< 0.001s` 或 `> 0.5s`。
   * 非零时按分量 clamp 到 ±20000 u/s²。
   * 副作用：写 `prevAuthVel` / `prevAuthTimeMs`，并在抑制窗内递减
   * `accelSuppressFrames`。调用点：`correctFromAuthority` 的两处快照构造。
   * 注意：方法名是外部脚本的接口 —— `apps/debug/scripts/jump-apex-verify.mjs` 会把它
   * 整体替换成返回零向量的桩函数。
   */
  private computeAuthAccel(
    vel: { x: number; y: number; z: number },
    timeMs: number,
  ): { x: number; y: number; z: number } {
    // 抑制窗（见 accelSuppressFrames）：重锚瞬移会污染一帧速度差，期间照常刷新基准
    // （prevAuthVel / prevAuthTimeMs）但不产出加速度。
    const suppress = this.accelSuppressFrames > 0;
    if (suppress) this.accelSuppressFrames--;
    const prev = this.prevAuthVel;
    const prevT = this.prevAuthTimeMs;
    this.prevAuthVel = { ...vel };
    this.prevAuthTimeMs = timeMs;
    if (suppress || !prev || prevT <= 0) return { x: 0, y: 0, z: 0 };
    const dt = (timeMs - prevT) / 1000;
    if (dt < 0.001 || dt > 0.5) return { x: 0, y: 0, z: 0 };
    // 上下限 ±20000 u/s²：帧间隔最小 0.001s，故该上限等于「1ms 内速度变化 ±20 HU/s」；
    // 超出这一量级的差分来自碰撞瞬间的速度跳变或帧间隔抖动，直接截断以防外推发散。
    const clamp = (v: number): number => Math.max(-20000, Math.min(20000, v));
    return {
      x: clamp((vel.x - prev.x) / dt),
      y: clamp((vel.y - prev.y) / dt),
      z: clamp((vel.z - prev.z) / dt),
    };
  }

  /**
   * 每渲染帧的速度耦合：把权威帧速度 + 加速度外推写进渲染物理。
   *
   * 算式（`dt = (now - authArrivedAtMs) / 1000`，`a = curAuth`）：
   *   vel = a.vel + a.accel × dt
   * 命中条件：`dt > 0 && dt <= 0.1`。取不到 `curAuth` 或 `getPhys()` 返回 null 时直接
   * 返回；`dt <= 0`（时间戳异常）或 `dt > 0.1s`（权威帧长时间未更新）时退化为直接写
   * `a.vel`，不做外推。
   *
   * 副作用：经 `phys.set_velocity` 覆盖渲染物理速度三分量；不改位置、不改角度、不改
   * 着地。
   * 调用点：两端 `RendererMain.tick`（每渲染帧，紧接 `correctFromAuthority`、在渲染
   * 物理推进之前；回放模式下跳过）。`now` 必须与 `authArrivedAtMs` 同源，即调用方的
   * rAF 时间戳。
   */
  calibrateVelocity(now: number): void {
    const phys = this.deps.getPhys();
    if (!phys || !this.curAuth) return;
    const a = this.curAuth;
    // 帧龄基准是主线程读到该权威帧的时刻（同线程时钟）。
    // 若改用 a.timeMs（Worker 的 performance.now），两个时钟基准不同，dt 会被一个固定
    // 偏移顶到上限之外，加速度外推随之失效，速度退化为权威帧的原始速度。
    const dt = (now - this.authArrivedAtMs) / 1000;
    let v = a.vel;
    if (dt > 0 && dt <= 0.1) {
      v = {
        x: a.vel.x + a.accel.x * dt,
        y: a.vel.y + a.accel.y * dt,
        z: a.vel.z + a.accel.z * dt,
      };
    }
    // dt<=0（时间戳异常）或 >0.1s（权威停更/暂停恢复）→ 直接用权威速度，不外推防漂移
    phys.set_velocity(v.x, v.y, v.z);
  }

  /**
   * 显式位置突变：把渲染物理写到指定位置与角度（速度清零、`onGround` 置真），清空
   * 权威校准状态，并把权威豁免窗口推到 `performance.now() + TELEPORT_EXEMPT_MS`。
   *
   * 入参：`pos` 取下标 0..2 作世界坐标（多余元素被忽略）；`yawDeg` / `pitchDeg` 为度，
   * `pitchDeg` 缺省 0。出参：无。
   * 副作用：`phys.set_state`（本文件唯一以新位置写渲染物理的入口）、
   * `clearPendingInput()`、`clear()`、写 `teleportExemptUntilMs`。
   * 失败/退化：`getPhys()` 返回 null 时整体空跑 —— 连 `clear()` 与豁免窗口都不设置。
   * 调用点：本仓只有 `apps/debug` 侧经 `RendererMain.resetTo` 调用它（地图载入起点、
   * 重生按钮的检查点回退与纯 Rust 重生、spawn 下拉切换、自定义传送点、死亡回退）；
   * `apps/game` 的 `RendererMain.resetTo` 包装器在本仓无调用点。
   */
  resetTo(pos: number[], yawDeg: number, pitchDeg = 0): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    phys.set_state(pos[0], pos[1], pos[2], yawDeg, pitchDeg, 0, 0, 0, true);
    // 清待喂输入，防突变后残留方向/跳跃
    this.deps.clearPendingInput();
    this.clear();
    // 开豁免窗口：窗口内由 correctFromAuthority 的豁免分支负责把渲染新状态同步给权威，
    // 且权威帧的位置/角度不会写进渲染物理。
    this.teleportExemptUntilMs = performance.now() + AuthorityCalibrator.TELEPORT_EXEMPT_MS;
  }

  /**
   * 复位权威校准状态：`prevAuthVel` / `prevAuthTimeMs` / `prevFrameRenderYaw` /
   * `yawDivergedFrames` / `syncInFlight` / `lastSyncAt` / `predStarted` / `curAuth` /
   * `lastVa` / `lastRoutineAnchorAtMs` / `accelSuppressFrames` 回到构造时的值。
   *
   * 副作用：只写本实例字段 —— 不触碰物理、不发回调、不改 `teleportExemptUntilMs`。
   * 未复位的字段：`authArrivedAtMs`（下一帧被覆写）、`authFirstFrameLogged`、
   * `teleportExemptUntilMs`（后两者跨 `clear()` 保留）。
   * 调用点：两端 `RendererMain` 的 `disposeScene` 与安装新 `predPhys` 的路径，以及本
   * 文件的 `resetTo`。
   */
  clear(): void {
    this.prevAuthVel = null;
    this.prevAuthTimeMs = 0;
    this.prevFrameRenderYaw = 0;
    this.yawDivergedFrames = 0;
    this.syncInFlight = false;
    this.lastSyncAt = 0;
    this.predStarted = false;
    this.curAuth = null;
    this.lastVa = -1;
    // 重锚节拍与加速度抑制窗一并清零（新世界/新轨迹下两者都已无意义）
    this.lastRoutineAnchorAtMs = Number.NEGATIVE_INFINITY;
    this.accelSuppressFrames = 0;
  }

  /**
   * 权威碰撞事件入口 —— 只处理 `land`，且只写速度与着地。
   *
   * 入参：`kind` 为事件种类；`_pos` / `_yawDeg` / `_pitchDeg` 三个入参**未被读取**
   * （它们仍由 `phys-event` 协议携带，调用方按原签名传参；`_` 前缀是 `apps/debug` 的
   * `noUnusedParameters` 要求，`apps/game` 的 tsconfig 未开该选项）；`vel` 为权威碰撞
   * 瞬间速度，缺省时回落渲染自身速度。
   *
   * 分支：
   * - `getPhys()` 返回 null → 返回，零写入。
   * - `kind !== 'land'`（即 `blocked`）→ 返回，零写入。
   * - 渲染自己 `onGround` 为假 → 返回，零写入（连速度也不写）。
   * - 否则 `phys.set_state(st.posX, st.posY, st.posZ, st.yaw, st.pitch, vx, vy, vz, true)`：
   *   位置与角度写回的是刚从 `phys.state()` 读到的同一组值（两者零变化），速度取
   *   `vel`（缺省用渲染自身速度），`onGround` 被置真。
   *
   * 副作用：仅一次 `phys.set_state`；不发回调、不改本类任何字段。
   *
   * 为什么 `onGround` 必须由渲染自己的 `onGround` 把关：`src/phys/player.rs` 的
   * `check_jump` 第一道门就是 `!p.on_ground` 即返回，随后把 `p.velocity[1]`
   * **赋值**为 `sqrt(2 × gravity × jump_height)`（默认 800 / 57 → ≈302 HU/s，不是
   * 叠加），且 `autobhop` 为真时连 `old_jump` 的边沿检查也跳过。因此渲染仍在空中时把
   * `onGround` 写真的，等于在半空重赋一次完整起跳初速。权威侧的 `land` 判据
   * （`src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics`：`!prevOnGround && onGround`，
   * 着地上升沿）与渲染自己的着地时刻不同源，两个条件不可互换。
   *
   * `blocked` 分支在此零写入：权威速度是权威侧碰撞解算的产物，与渲染侧同一时刻的
   * 速度不同源；渲染速度的收敛由逐帧 `calibrateVelocity` 承担。该分支保留在签名里是
   * 为了让事件仍可被调用方观测。
   *
   * 调用点：两端 `app.ts` 的 `phys-event` 消息处理（`kind` 由
   * `src/ts-shared/auth/auth-loop.ts` 的 `emitCollision` 给出：`land` = 着地上升沿；
   * `blocked` = 速度骤降且实际位移远小于速度对应的位移）。`apps/viewer` 不调用它。
   */
  applyCollisionCorrection(
    kind: 'land' | 'blocked',
    _pos: number[],
    _yawDeg: number,
    _pitchDeg: number,
    vel?: number[],
  ): void {
    const phys = this.deps.getPhys();
    if (!phys) return;
    // blocked：本文件不处理（零写入）。
    if (kind !== 'land') return;

    const st = phys.state() as {
      posX: number;
      posY: number;
      posZ: number;
      yaw: number;
      pitch: number;
      velX: number;
      velY: number;
      velZ: number;
      onGround: boolean;
    };
    // ── 门：渲染自己未着地时不采纳 land 事件 ─────────────────────────────
    //
    // 事件判据在权威侧（`src/ts-shared/auth/auth-loop.ts` 的 `stepPhysics`：
    // `!prevOnGround && onGround`），而双线并不重合：`AuthFrame.pos` 是权威侧发布的
    // 位置（耦合模式下由 `renderTrajectory` 投影到渲染折线上），权威自持的碰撞解算
    // 位置与之不同源。权威判定的落地时刻对渲染没有意义 —— 渲染的着地由渲染自己的
    // 碰撞解算决定。此时若把 onGround 置真，`src/phys/player.rs` 的 `check_jump` 硬门
    // 就被打开，`p.velocity[1]` 会被赋值成完整起跳初速（`autobhop` 为真时连
    // `old_jump` 边沿也不检查）→ 半空重新起跳。
    //
    // 本门不削弱合法语义：渲染自己已着地时照常重述（此时 st.onGround 本就是真，写入
    // 幂等），落地速度耦合照常生效；渲染腾空时本调用退化为与 blocked 同级的零写入。
    if (!st.onGround) return;
    // 权威落地瞬间的速度（权威侧已过碰撞解算）；vel 缺省时回落渲染自身速度。
    const vx = vel?.[0] ?? st.velX;
    const vy = vel?.[1] ?? st.velY;
    const vz = vel?.[2] ?? st.velZ;
    // 位置与角度全部写回渲染自己的当前值（不用 _pos / _yawDeg / _pitchDeg 这三个入参）：
    // 本调用的唯一目的是把 onGround 置真，位置与角度都零变化。
    // `src/phys/mod.rs` 的 `PhysWorld` 没有单独的置着地方法，set_state 是唯一入口。
    phys.set_state(st.posX, st.posY, st.posZ, st.yaw, st.pitch, vx, vy, vz, true);
  }
}
