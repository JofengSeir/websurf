/**
 * 解耦模式物理循环（WorkerA 编排移植，phys-mode-port t10）。
 *
 * 移植源：test/dual-mode-harness/src/worker-a.ts（§2 移植面清单〔整体移植〕核心），
 * 归宿：game Worker 内与 v7 权威线（auth-loop）**双线共存、mode gate 互斥**——
 * - 耦合模式：本循环 gate 早退（setTimeout 4ms 空转等待），v7 权威线照旧；
 * - 解耦模式：本循环驱动 phys（1ms 无限制真理源）+ tickPhys（64t 速度校准线），
 *   S_D 槽唯一写入者；v7 auth-loop gate 早退（写槽权移交本线）。
 *
 * 全序（harness worker-a.ts:213-308 顺序硬约束，逐段移植）：
 * delta clamp → tickPhys 激活判定 → 停用↔激活边沿（清采样器 + alignTickPhys）→
 * 【第一步 tick 计算】边界到达才执行：peekKeys 快照 + tickDx/tickDy 窗口限幅 →
 * 分叉锚定（TICK_ANCHOR_DIST 拉回）→ tickPhys.tick(tickDt) → phys.set_velocity 校准
 * →【第二步 无限制】consumeInput 不限幅 → phys.tick_into(1ms) → S_D 零分配发布
 * → 背压 waitWakeup（idle ≥1ms 挂起，上限 4ms）→ setTimeout(0) 让出事件循环。
 *
 * 热路径（§3.2 ④ A5 落款）：`phys.tick_into` + `state_out_ptr` Float64Array 直读
 * （pos×3/vel×3/yaw/pitch 8 值）→ 定点转换写 S_D——消 `phys.state()` 的 wasm→JS
 * 对象分配；wasm 内存增长后按 memory.buffer 更换重建视图。
 * eyeHeight/onGround 不在 state_out 8 值内：以 16ms（≈60Hz，与 DUCK_LERP_TIME
 * 0.1s 的视觉粒度对齐）低频 phys.state() 刷新缓存 + publishCurrentState 即时刷新
 * ——热路径零 wasm 编组分配，慢字段跟随缓存。
 *
 * 性能判据（沿用 harness）：p95 < 1000µs/子步（t5 验收参考）。
 */

import type { ShmState, MsgState, AuthFrame } from '../auth/shared-state.js';
import type { PhysWorldLike } from '../auth/auth-loop.js';

/** 计算模式（worker 侧真相源；set-mode 消息翻转，§3.4.C）。 */
export type ComputeMode = 'coupled' | 'decoupled';

/** 主线程同步渲染态（10 字段；game authority-calibrator.ts:37-48 的结构等价声明
 * ——ts-shared 不反向依赖 game，两端按结构兼容消费）。 */
export interface SyncRenderStateLike {
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

/** 存点全量恢复形状（game SavePoint 的结构等价声明；t 为时间戳可选）。 */
export interface SavePointLike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  t?: number;
}

/** 解耦 hold 冻结态（set-hold 消息注入；worker 侧逐轮强制 set_state）。 */
export interface HoldState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

/** 解耦线 wasm 扩展面（PhysWorldLike 之上：零分配热路径 + 校准通道；
 * game/debug 两端 wasm PhysWorld 结构性满足——mod.rs:179-200/347）。 */
export interface DecoupledPhysWorld extends PhysWorldLike {
  /** 零分配热路径 tick：状态写实例固定缓冲 state_out（pos×3/vel×3/yaw/pitch）。 */
  tick_into(dt: number, keysMask: number, dx: number, dy: number): void;
  /** state_out 缓冲在线性内存中的字节地址（Float64Array 视图用）。 */
  state_out_ptr(): number;
  /** 速度注入（tickPhys → phys 唯一校准通道；位置/角度绝不触碰）。 */
  set_velocity(vx: number, vy: number, vz: number): void;
}

export interface DecoupledLoopEnv {
  /** 跨线程状态通道（动态读取——init 消息后注入）。 */
  shared: ShmState | MsgState | null;
  /** 模式A 真理源（1ms 无限制；S_D 唯一写入者）。 */
  getPhys(): DecoupledPhysWorld | null;
  /** 模式B 64t 速度校准线（raw rate 步长；对 phys 唯一影响 = set_velocity）。 */
  getTickPhys(): DecoupledPhysWorld | null;
  /** tickPhys 步长源：config.physics.tickRate 原值（raw，无 +3 偏移，§3.4.D）。 */
  getTickPhysRate(): number;
  /** 模式门（双线互斥；set-mode 翻转 worker 侧 computeMode）。 */
  isDecoupled(): boolean;
  /** wasm 线性内存（state_out 视图宿主；initSync 的 InitOutput.memory）。
   * 缺省 null = 退化 phys.state() 发布路径（node 测试/无内存注入场景）。 */
  getWasmMemory?(): WebAssembly.Memory | null;
  /** 解耦 hold 冻结态（set-hold 注入；null = 无冻结）。 */
  getHold?(): HoldState | null;
}

export interface DecoupledLoop {
  /** tickPhys 速率变更（decoupled 模式下 config.tickRate 变更，§3.4.D）：
   * 清 loAcc/tickDx/tickDy + alignTickPhys（harness 边沿语义平移；速率值
   * 变化不 reset 主累积器——网格相位按新步长自然延续）。 */
  onTickRateChanged(): void;
  /** 采样器全清（set-mode 交接/respawn）：acc/loAcc/tickDx/tickDy/modeBWasActive
   * 清零 + 墙钟基准刷新；align=true 时同时 alignTickPhys。 */
  resetSamplers(align?: boolean): void;
  /** 立即发布当前 phys 状态一帧（respawn/world-json/set-mode 后首帧可见；
   * harness applyWorld:150/respawn:335 的 writeStateFromPhys 语义）。 */
  publishCurrentState(): void;
  /** 启动自驱循环（幂等；可 wasm 就绪前调用——未就绪轮次为 4ms 空转等待）。 */
  start(): void;
}

// ── 移植常量（harness worker-a.ts:43-61, :177；GRAVITY/DEFAULT_WASM_URL/
//    EMPTY_TELEPORT_JSON〔不移植〕——game 重力走 params 链、wasm/世界走 dispatch）──
/** 模式A：1ms 固定子步（无限制真理源）。 */
const RENDER_DT = 0.001;
/** delta 限幅防炸：clamp(实际间隔, 0, 50ms)。 */
const MAX_DELTA = 0.05;
/** 每轮最多执行的 1ms 子步数（大 delta 防死亡螺旋；超限保留剩余累加防时间丢失）。 */
const MAX_STEPS_PER_ROUND = 8;
/** 累加器封顶（秒）：8 次上限耗尽后的残留上限，防无限追赶。 */
const MAX_ACC = 0.02;
/** 单次 mousemove 事件削平阈值基数（主线程已按事件 CLAMP；此处用于 tick 边界窗口上限）。 */
const MAX_INPUT_DELTA = 1000;
/** 背压休眠阈值：距下次子步剩余 >= 1ms 才挂起（WAKEUP 槽），否则自旋。 */
const WAIT_THRESHOLD_MS = 1;
/** 单次最长休眠（ms）：限制 respawn/world-json/set-mode 等消息最坏延迟。 */
const MAX_WAIT_MS = 4;
/** 分叉兜底锚定距离阈值（units）：tick 实例与模式A 位置偏差超过此值视为
 * "极限操作分叉"（死亡/传送/卡墙/坡缘），全量拉回；正常演化偏差有界不触发。 */
const TICK_ANCHOR_DIST = 64;
/** 眼高/着地慢字段刷新间隔（ms）：≈60Hz——与 DUCK_LERP_TIME 0.1s 蹲伏插值的
 * 视觉粒度对齐；热路径（每子步）零 wasm 编组分配的关键。 */
const SLOW_FIELD_REFRESH_MS = 16;

/** tick 边界鼠标增量上限：按 tick 窗口放大（1000/ms × tickDt），防极端甩视角穿墙。 */
function tickInputMax(tickDt: number): number {
  return MAX_INPUT_DELTA * (tickDt / RENDER_DT);
}

export function createDecoupledLoop(env: DecoupledLoopEnv): DecoupledLoop {
  // ── 运行时状态（harness worker-a.ts:113-123 平移）───────────────
  /** 模式A 累加器（秒）。 */
  let acc = 0;
  /** 模式B 累加器（秒；保留余数——64t 网格对齐真实时间轴的相位来源）。 */
  let loAcc = 0;
  /** tick 边界鼠标窗口累积（自上一边界模式A 实时消耗的增量）。 */
  let tickDxAcc = 0;
  let tickDyAcc = 0;
  /** 模式B 上一轮是否激活（激活边沿重置采样器 + 对齐 tickPhys）。 */
  let modeBWasActive = false;
  let lastNow = performance.now();
  let started = false;

  // ── 慢字段缓存（eyeHeight/onGround；16ms 低频 state() 刷新）───────
  let slowEyeHeight = 64.09; // EYE_STAND 兜底；首帧 publishCurrentState 即刷新
  let slowOnGround = false;
  let lastSlowMs = 0;

  // ── state_out 零分配视图（wasm 内存增长后重建）──────────────────
  let outView: Float64Array | null = null;
  let outBuffer: ArrayBuffer | null = null;

  const clampAbs = (v: number, max: number): number =>
    v > max ? max : v < -max ? -max : v;

  /** tickPhys 对齐模式A 当前全状态（激活边沿/分叉锚定/热切交接共用原语）。 */
  function alignTickPhys(): void {
    const phys = env.getPhys();
    const tickPhys = env.getTickPhys();
    if (!phys || !tickPhys) return;
    const s = phys.state() as {
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
    tickPhys.set_state(s.posX, s.posY, s.posZ, s.yaw, s.pitch, s.velX, s.velY, s.velZ, s.onGround);
  }

  /** tick 实例与模式A 位置是否已分叉（超 TICK_ANCHOR_DIST）。 */
  function tickDiverged(): boolean {
    const phys = env.getPhys();
    const tickPhys = env.getTickPhys();
    if (!phys || !tickPhys) return false;
    const s = phys.state() as { posX: number; posY: number; posZ: number };
    const t = tickPhys.state() as { posX: number; posY: number; posZ: number };
    const dx = s.posX - t.posX;
    const dy = s.posY - t.posY;
    const dz = s.posZ - t.posZ;
    return dx * dx + dy * dy + dz * dz > TICK_ANCHOR_DIST * TICK_ANCHOR_DIST;
  }

  /** 眼高/着地慢字段刷新（≥16ms 一次；publishCurrentState 强制刷新）。 */
  function refreshSlowFields(nowMs: number, force: boolean): void {
    if (!force && nowMs - lastSlowMs < SLOW_FIELD_REFRESH_MS) return;
    const phys = env.getPhys();
    if (!phys) return;
    const s = phys.state() as { eyeHeight: number; onGround: boolean };
    slowEyeHeight = s.eyeHeight;
    slowOnGround = s.onGround;
    lastSlowMs = nowMs;
  }

  /** 零分配发布（热路径）：tick_into 后 state_out[8] 直读 → S_D 定点写。
   * @returns 是否走了零分配路径（false = 退化 state() 路径）。 */
  function publishFromStateOut(nowMs: number): boolean {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return false;
    const memory = env.getWasmMemory?.() ?? null;
    if (!memory) return false;
    if (!outView || outBuffer !== memory.buffer) {
      // wasm 内存增长（memory.buffer 更换）后按 state_out_ptr 重建视图
      outBuffer = memory.buffer;
      outView = new Float64Array(outBuffer, phys.state_out_ptr(), 8);
    }
    refreshSlowFields(nowMs, false);
    const v = outView;
    shared.writeDecoupled({
      pos: { x: v[0], y: v[1], z: v[2] },
      yaw: v[6],
      pitch: v[7],
      vel: { x: v[3], y: v[4], z: v[5] },
      eyeHeight: slowEyeHeight,
      onGround: slowOnGround,
      timeMs: nowMs,
    });
    return true;
  }

  /** 兜底发布（无 wasm 内存注入/显式首帧）：phys.state() → writeDecoupled。 */
  function publishFromState(nowMs: number): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const s = phys.state() as {
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
    };
    slowEyeHeight = s.eyeHeight;
    slowOnGround = s.onGround;
    lastSlowMs = nowMs;
    shared.writeDecoupled({
      pos: { x: s.posX, y: s.posY, z: s.posZ },
      yaw: s.yaw,
      pitch: s.pitch,
      vel: { x: s.velX, y: s.velY, z: s.velZ },
      eyeHeight: s.eyeHeight,
      onGround: s.onGround,
      timeMs: nowMs,
    });
  }

  /** hold 冻结轮：物理完全静止（时间丢弃、输入丢弃、tickPhys 同步冻结）。
   * 逐轮 set_state(held, vel=0) → 发布 held 帧（速度稳定 0，位置精确）。 */
  function runHeldRound(): void {
    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const hold = env.getHold?.() ?? null;
    if (!hold) return; // 竞态兜底：hold 已解除则本轮照常（下轮 gate 判定）
    acc = 0; // 冻结即暂停：时间不积累（plain 解除从静止续跑；带存点解除走全量恢复）
    loAcc = 0;
    shared.consumeInput(); // 丢弃输入增量（键位保留）
    alignTickPhys(); // tickPhys 冻结到 held 态（vel=0）——解除后从静止续跑
    phys.set_state(hold.x, hold.y, hold.z, hold.yaw, hold.pitch, 0, 0, 0, hold.onGround);
    const nowMs = performance.now();
    shared.writeDecoupled({
      pos: { x: hold.x, y: hold.y, z: hold.z },
      yaw: hold.yaw,
      pitch: hold.pitch,
      vel: { x: 0, y: 0, z: 0 },
      eyeHeight: slowEyeHeight,
      onGround: hold.onGround,
      timeMs: nowMs,
    });
  }

  /** 主循环（harness worker-a.ts:213-308 全序移植 + mode gate）。 */
  function loop(): void {
    const active = env.isDecoupled() && !!env.shared && !!env.getPhys();
    // 让出事件循环（投递 respawn/world-json/set-mode 消息；active 时 0ms 急轮询，
    // 门关时 4ms 与 auth-loop 同节奏空转等待）
    setTimeout(loop, active ? 0 : 4);
    if (!active) {
      lastNow = performance.now(); // 防复入首轮 delta 爆量（clamped 兜底之外的双保险）
      return;
    }

    const shared = env.shared;
    const phys = env.getPhys();
    if (!shared || !phys) return;
    const hold = env.getHold?.() ?? null;

    // 真实时间片 delta（clamp 0~50ms 防炸）
    const now = performance.now();
    let delta = (now - lastNow) / 1000;
    lastNow = now;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    if (delta < 0) delta = 0;

    // ── hold 冻结轮（worker 侧执行，§3.4.A）：时间/输入丢弃，物理静止 ──
    if (hold) {
      runHeldRound();
      // 背压照常（hold 期间空转挂起，不占 CPU）
      shared.waitWakeup(MAX_WAIT_MS);
      return;
    }

    // ── tickPhys 激活判定（raw rate；0 或 ≥1000Hz 与模式A 等价 → 跳过）──
    let tickRate = env.getTickPhysRate();
    if (!Number.isFinite(tickRate) || tickRate < 0) tickRate = 0;
    const modeBActive = tickRate > 0 && 1 / tickRate > RENDER_DT;
    // 停用→激活边沿：重置采样累积器 + tickPhys 对齐模式A（防陈旧输入/错位起点）；
    // 激活→停用：仅清采样（§3.4.D 边沿语义，harness :228-238 平移）
    if (modeBActive && !modeBWasActive) {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      alignTickPhys();
    } else if (!modeBActive && modeBWasActive) {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
    }
    modeBWasActive = modeBActive;

    // ── 第一步：tick 计算（先——tick 节点到达才执行；未到达越过直达无限制计算）──
    const tickPhys = env.getTickPhys();
    if (modeBActive && tickPhys) {
      const tickDt = 1 / tickRate;
      loAcc += delta;
      while (loAcc >= tickDt) {
        loAcc -= tickDt;
        // 输入采样（tick 边界快照）：键位 = 当前掩码（64t 粒度——bhop/转向台阶）；
        // 鼠标 = 自上一边界模式A 实时消耗的累积增量（限幅防极端甩视角穿墙）
        const tickKeys = shared.peekKeys();
        const tickMax = tickInputMax(tickDt);
        const tickDx = clampAbs(tickDxAcc, tickMax);
        const tickDy = clampAbs(tickDyAcc, tickMax);
        tickDxAcc = 0;
        tickDyAcc = 0;
        // 分叉兜底锚定（极限操作防护）：位置偏差 > TICK_ANCHOR_DIST → 全量
        // set_state 拉回模式A；正常演化不干预（tick 保持自身 64t 离散演化，
        // 无锚定引入的相位伪差）。先检查后推进（顺序硬约束）
        if (tickDiverged()) {
          alignTickPhys();
        }
        // 独立实例推进（真实 64t 物理——摩擦/加速/碰撞/bhop 钳制相位全在 64t
        // 网格上；状态时刻 = 边界时刻 → 校准速度与模式A 位置同刻）
        tickPhys.tick(tickDt, tickKeys, tickDx, tickDy);
        // 速度校准（唯一 tick 影响通道）：三轴速度写回模式A（含 vy——独立实例
        // 自身 64t 重力演化，无重复推进问题）；位置/角度绝不触碰
        const st = tickPhys.state() as { velX: number; velY: number; velZ: number };
        phys.set_velocity(st.velX, st.velY, st.velZ);
      }
    } else {
      loAcc = 0; // 关闭难度修正 / 与模式A 等价：纯 1ms 无限制实时输入
    }

    // ── 第二步：无限制计算（后——1ms 子步 + 实时输入；位置/角度只由模式A 推进）──
    acc += delta;
    if (acc >= RENDER_DT) {
      const nowMs = performance.now();
      let steps = 0;
      while (acc >= RENDER_DT && steps < MAX_STEPS_PER_ROUND) {
        acc -= RENDER_DT;
        steps++;
        // 实时输入（模式A 是唯一消费路径）：consumeInput CAS 清零不限幅——
        // 必须消费完整帧增量，避免快速甩动丢失（harness :285 语义）
        const inp = shared.consumeInput();
        // tick 边界采样累积（模式B 专用：下一边界一次性注入 tick 实例）
        if (modeBActive) {
          tickDxAcc += inp.dx;
          tickDyAcc += inp.dy;
        }
        // 零分配热路径：tick_into 写 wasm state_out → Float64Array 直读 → S_D
        phys.tick_into(RENDER_DT, inp.keysMask, inp.dx, inp.dy);
        if (!publishFromStateOut(nowMs)) {
          // 退化路径（无 wasm 内存注入）：state() 发布（node 测试/兜底）
          publishFromState(nowMs);
        }
      }
      // 8 次上限耗尽：保留剩余累加（时间不丢失，下轮继续补跑），仅封顶防无限追赶
      if (acc > MAX_ACC) acc = MAX_ACC;
    }

    // 背压：距下次 1ms 子步剩余时间 >= 1ms → 挂起 WAKEUP 槽（可被主线程 rAF
    // wake 提前唤醒）；否则自旋直接继续。MsgState 回退 waitWakeup 立即返回。
    const idleMs = (RENDER_DT - acc) * 1000;
    if (idleMs >= WAIT_THRESHOLD_MS) {
      shared.waitWakeup(Math.min(idleMs, MAX_WAIT_MS));
    }
  }

  return {
    onTickRateChanged(): void {
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      alignTickPhys();
    },
    resetSamplers(align?: boolean): void {
      acc = 0;
      loAcc = 0;
      tickDxAcc = 0;
      tickDyAcc = 0;
      modeBWasActive = false; // 复入时按激活边沿重新对齐
      lastNow = performance.now(); // 墙钟基准刷新（交接瞬间重新起算）
      if (align) alignTickPhys();
    },
    publishCurrentState(): void {
      refreshSlowFields(performance.now(), true);
      publishFromState(performance.now());
    },
    start(): void {
      if (started) return;
      started = true;
      lastNow = performance.now();
      loop();
    },
  };
}

/** AuthFrame 类型再导出（消费端零分支；SharedState 联合类型的解耦帧读写签名）。 */
export type { AuthFrame };
