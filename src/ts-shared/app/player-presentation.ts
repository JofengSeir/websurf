/**
 * 主线程「预测呈现」同意循环（debug / game 共用一份；viewer 无物理不接）。
 *
 * 背景（2026-11-18，用户要求「三端最大程度共用一份物理与画面，仅保留各自特色」）：
 * 审计（.tmp/audit/REVIEW_VERDICT.md）显示主线程物理装配是最大结构重复——debug 与 game
 * 的 `renderer-main.ts` 各自维护一份「dt 时基 → 写输入共享槽 → 权威校准 → 推进预测物理
 * → 消费物理事件 → 写渲染采样 → 摆相机 → 推进实体运行期」的逐帧序列（顺序必须一致，
 * 否则权威插值/采样世代/相机插值会分叉）。本模块把这套顺序收成一份实现。
 *
 * 职责边界：
 * - 共享（本文件）：dt 时基（首帧 1/64、上限 0.1s）、输入写共享槽、物理 tick、
 *   物理事件消费、渲染采样写入（i0 序号由 app 提供）、相机摆放调用、实体运行期 update；
 *   顺序与原 debug/game `tick()` 逐条对齐。
 * - app 特色（全部走 hooks）：
 *   - debug：replay 步长/单步闸门、replayMode 跳过权威、pathRecorder、速度诊断、
 *     传送事件使采样世代失效、cameraController + poseHold 相机；
 *   - game：holdPoint 冻结（tick 后把物理写回存点位姿）、直接写 camera。
 * - 权威校准（`AuthorityCalibrator`）仍是 app 侧实例：它需要 app 的「是否重置」生命周期
 *   与回调，不随本模块搬家；本模块只负责在正确位置调用。
 *
 * 调用方契约：
 * - 每帧 rAF 调用一次 `update(now)`；物理未就绪或闸门跳过时返回 false，内部仍按
 *   `plan.stepTimebase` 决定是否推进墙钟基准（debug 的「闸门跳过也要推进时基」语义）。
 * - 换图/重建物理后调用 `resetTimebase()`（等价于原 `lastTickMs = 0`）。
 */

/** 预测物理实例的最小接口（`PhysWorld` 的子集；debug/game 的 wasm 实例都满足）。 */
export interface PredictionPhysLike {
  /** 推进一个物理步；dx/dy 为鼠标增量，keys 为按键掩码。 */
  tick(dt: number, keys: number, dx: number, dy: number): void;
  /** 读取当前玩家状态（脚底 origin + 眼高 + 角度 + 速度 + 着地）。 */
  state(): PredictionPhysState;
  /** 非阻塞取一个物理事件（teleport/death 等）；无事件返回 null。 */
  take_event?(): unknown | null;
}

/** `state()` 返回的字段子集（与 Rust `PhysWorld::state` 的 JS 形状一致）。 */
export interface PredictionPhysState {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  eyeHeight: number;
  velX: number;
  velY: number;
  velZ: number;
  onGround: boolean;
}

/** 本帧待喂输入（app 从输入桥/设备掩码读取；共享槽由本模块写入）。 */
export interface PredictionInput {
  keys: number;
  dx: number;
  dy: number;
}

/** 物理 tick 前后的 app 钩子；所有钩子都可缺省（缺省即无该端特色行为）。 */
export interface PredictionHooks {
  /**
   * 本帧是否推进物理 + 可选步长覆盖。
   * - `run=false`：本帧不推进物理；`stepTimebase`（默认 true）决定是否把墙钟基准推进到 now
   *   （debug 的单步闸门跳过要求 true，物理未就绪要求 false）。
   * - `dtOverride`：有值则用该步长代替墙钟 dt（debug 输入回放的一次性步长）。
   * - `skipAuthority`：true 时跳过 `beforeTick` 中的权威校准（debug replayMode 只关权威耦合）。
   */
  beginFrame?(now: number): { run: boolean; dtOverride?: number | null; skipAuthority?: boolean; stepTimebase?: boolean };
  /** 写共享输入槽之后、物理 tick 之前：权威校准与 app 诊断/记录。 */
  beforeTick?(now: number, dt: number, skipAuthority: boolean): void;
  /** 物理 tick 之后、读 state 之前：game 的 holdPoint 冻结、debug 的速度诊断。 */
  afterTick?(now: number, dt: number): void;
  /** 物理事件（teleport/death 等）；debug 用它在传送时 bumpSampleEpoch。 */
  onPhysEvent?(event: unknown): void;
  /** 读 state 之后、写渲染采样之前：debug 的 pathRecorder 渲染线记录。 */
  afterState?(state: PredictionPhysState, dt: number, now: number): void;
  /** 相机摆放（debug 走 cameraController + poseHold；game 直接写 camera）。 */
  applyCamera?(state: PredictionPhysState): void;
  /** 缺省钩子（可选）：供 app 在物理不推进时做自己的记账。 */
  onPhysicsSkipped?(now: number): void;
}

/** 渲染采样写入接口（`RenderSharedState` 的子集）。 */
export interface PredictionSampleSink {
  addInput(dx: number, dy: number, keys: number): void;
  writeRenderSample(tMs: number, x: number, y: number, z: number, i0: number): void;
}

/** 实体运行期宿主的最小接口（`EntityGameplay` 满足）。 */
export interface PredictionGameplayLike {
  update(dt: number): void;
}

export interface CreatePlayerPresentationOptions {
  phys(): PredictionPhysLike | null;
  shared: PredictionSampleSink;
  gameplay(): PredictionGameplayLike | null;
  /** 读本帧输入（调用后共享槽写入完成，app 侧才清 dx/dy）。 */
  input(): PredictionInput;
  /** 物理 tick 后清零鼠标增量（按键掩码保留为按住状态）。 */
  clearInputDeltas(): void;
  /** 渲染采样序号（app 持有自增游标；每次调用返回当前值并 +1）。 */
  nextRenderSampleIndex(): number;
  hooks?: PredictionHooks;
}

export interface PlayerPresentation {
  /** 推进一帧物理/呈现；返回本帧是否真的推进了物理。 */
  update(now: number): boolean;
  /**
   * 推进一个**固定步长**物理步（供 `sim-clock` 使用，与 rAF 解耦）。
   * - `dtSeconds` 由时钟的 1/频率 给出，不再读墙钟间隔；
   * - `now` 可缺省（缺省取 `performance.now()`），用于 app 钩子的诊断/采样时间戳；
   * - 与 `update()` 互斥：启用固定步长时钟时，rAF 里不要再调 `update()`。
   */
  step(dtSeconds: number, now?: number): boolean;
  /** 复位墙钟时基（换图/重建物理后调用，等价于原 `lastTickMs = 0`）。 */
  resetTimebase(): void;
  /** 当前时基（诊断用；无历史返回 0）。 */
  timebaseMs(): number;
}

/**
 * 创建主线程「预测呈现」循环。
 *
 * 使用时把 `update(now)` 放在 rAF 的物理段位置（debug 在飞行回放推进之后、可见性之前；
 * game 在 tick 开头），其余步骤（可见性/剔除/渲染）仍由各自 `tick()` 负责。
 */
export function createPlayerPresentation(options: CreatePlayerPresentationOptions): PlayerPresentation {
  const hooks = options.hooks ?? {};
  let lastTickMs = 0;

  /** 墙钟步长：首帧 1/64 秒，之后取与上一物理步的间隔，上限 0.1 秒。 */
  const wallDt = (now: number): number =>
    lastTickMs === 0 ? 1 / 64 : Math.min((now - lastTickMs) / 1000, 0.1);

  /** 一次物理步的共同实现：`dt` 由调用方决定（rAF 变步长 / 固定步长时钟）。 */
  const runStep = (now: number, dt: number, skipAuthorityHint: boolean | null): boolean => {
    const phys = options.phys();
    if (!phys) return false;

    const plan = hooks.beginFrame ? hooks.beginFrame(now) : { run: true };
    // 固定步长模式下 skipAuthority 由 step() 传入（时钟模式下无回放语义，默认 false）。
    const skipAuthority = skipAuthorityHint ?? plan.skipAuthority === true;
    if (!plan.run) {
      // 物理未推进：只有单步闸门这类「本帧跳过但时基要继续走」的场景才推进基准。
      if (plan.stepTimebase !== false) lastTickMs = now;
      hooks.onPhysicsSkipped?.(now);
      return false;
    }

    lastTickMs = now;

    // 输入 → 共享槽（Worker 权威模拟与主线程消费同一份输入）。
    const input = options.input();
    options.shared.addInput(input.dx, input.dy, input.keys);

    // 权威帧消费 + 速度外推校准（debug 的 replayMode 经 skipAuthority 跳过）。
    hooks.beforeTick?.(now, dt, skipAuthority);

    // 推进本地预测物理：碰撞/传送/死亡判定都在物理内部。
    phys.tick(dt, input.keys, input.dx, input.dy);
    hooks.afterTick?.(now, dt);

    // 鼠标增量是一次性的；按键掩码保留为「按住」状态。
    options.clearInputDeltas();

    // 物理事件：传送/死亡等；app 在 onPhysEvent 里做采样世代失效与状态机回调。
    if (hooks.onPhysEvent && typeof phys.take_event === 'function') {
      for (;;) {
        const event = phys.take_event();
        if (!event) break;
        hooks.onPhysEvent(event);
      }
    }

    // 读状态：渲染、采样、相机、实体都基于同一份状态（同拍同源）。
    const state = phys.state();
    hooks.afterState?.(state, dt, now);
    options.shared.writeRenderSample(now, state.posX, state.posY, state.posZ, options.nextRenderSampleIndex());
    hooks.applyCamera?.(state);

    // 实体运行期与物理同帧推进（touch 用本帧 state，0 延迟输出当帧消费）。
    options.gameplay()?.update(dt);
    return true;
  };

  return {
    update(now: number): boolean {
      const plan = hooks.beginFrame ? hooks.beginFrame(now) : { run: true };
      if (!plan.run) {
        const phys = options.phys();
        if (!phys) return false;
        if (plan.stepTimebase !== false) lastTickMs = now;
        hooks.onPhysicsSkipped?.(now);
        return false;
      }
      const dt = plan.dtOverride ?? wallDt(now);
      return runStep(now, dt, plan.skipAuthority === true ? true : null);
    },

    step(dtSeconds: number, now?: number): boolean {
      if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) return false;
      return runStep(now ?? performance.now(), dtSeconds, null);
    },

    resetTimebase(): void {
      lastTickMs = 0;
    },

    timebaseMs(): number {
      return lastTickMs;
    },
  };
}
