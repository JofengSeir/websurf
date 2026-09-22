/**
 * Worker 侧消息分发的共享实现：把 `wasm-init` / `init` / `world-json` / `config` / `respawn` /
 * `sync-render-state` / `teleport` 等消息协议翻译成权威物理实例调用与注入钩子回调。
 *
 * ## 定位
 * 本文件是 Worker 线程的消息入口：`createWorkerDispatch` 的返回值直接挂到 `self.onmessage`
 * （或在工程侧包一层转发后再转交），主线程与权威物理实例之间的翻译全部收敛在这里。
 * 本文件不持有时钟、也不推进任何实例（全文没有 `tick` 调用）——推进属
 * `src/ts-shared/auth/auth-loop.ts` 的 `createAuthLoop` 与
 * `src/ts-shared/decoupled/decoupled-loop.ts`。
 *
 * ## 上下游
 * - 上游调用点：`apps/debug/src/worker/main.ts` 与 `apps/game/src/worker/main.ts` 各自在
 *   `self.onmessage` 装配处调用 `createWorkerDispatch`，并按工程注入 `WorkerDispatchEnv`。
 * - 下游被驱动方：权威实例方法（`build_world` / `set_params` / `set_hull` / `set_state` /
 *   `teleport_to` 等，结构面由 `src/ts-shared/auth/auth-loop.ts` 的 `PhysWorldLike` 声明）、
 *   `src/ts-shared/auth/auth-loop.ts` 的 `AuthLoop`（`start` / `reset` / `setFixedDt`）、
 *   `src/ts-shared/auth/shared-state.ts` 的 `createWorkerSharedState` 与 `AUTH_EVT` 事件位、
 *   `src/ts-shared/wasm/loader.ts` 的字节获取原语。
 *
 * ## 关键不变量
 * 1. **wasm 先行**：`ready` 只由 `initWasm` 成功置位，`world-json` 在 `ready` 之前一律丢弃；
 *    两工程都在加载地图之前发出 `wasm-init` 消息。
 * 2. **主实例恒在**：`env.phys` 是唯一必选实例槽；`tickPhys` / `scratch` 是可选并列槽，
 *    凡改动实例参数或状态的分支都在 `phys` 之后按同一实参同步它们，避免同一世界出现参数分叉。
 * 3. **死亡阈值跨世界重建存续**：`set-death-threshold` 的值由闭包变量记忆，`world-json`
 *    重建实例后经 `reapplyDeathY` 重放（Rust 侧该字段不在种子面，重建即回默认值）。
 * 4. **幂等**：`authLoop.start()` 由 `loopStarted` 守卫只执行一次；`set-mode` 与当前模式
 *    相同时不调用 `onSetMode`，只回 `mode-ack`。
 * 5. 未识别消息不抛错：落到 `onExtraMessage`，未注入即静默丢弃。
 *
 * ## 边界与容错
 * - 非对象消息（`null` / 原始值）在入口直接返回。
 * - 每个分支先做前置守卫（`ready` / `env.phys.current` / `typeof` 判定）再动实例，缺失即
 *   静默 return，没有错误回执。
 * - 可选槽与可选钩子统一走可选链，未注入即对应能力面整体不激活。
 * - `initWasm` 是唯一异步分支：其 rejection 由 `wasm-init` 分支的 `.catch` 收敛为
 *   `{ type: 'error' }` 消息回传主线程，失败后 `ready` 保持 false。
 *
 * ## 测试归属
 * `src/ts-shared/auth/` 下没有与本文件同名的单测；行为覆盖落在 `apps/debug/scripts/` 的两个
 * 脚本：`auth-clock-verify.mjs` 用 esbuild 打包本文件，以桩 `WorkerDispatchEnv` 驱动
 * `createWorkerDispatch`（覆盖 `config` 分支的 tickRate 接线）；`jump-apex-verify.mjs` 与
 * `jump-apex-serve.mjs` 以本文件的 `sync-render-state` 分支为对照面（后者按源码文本切片生成
 * 回退版，故该分支的代码行文本形态被脚本依赖）。
 *
 * ## 与相邻文件的边界
 * - `src/ts-shared/auth/shared-state.ts`：定义共享槽本体与读写语义；本文件只决定哪条消息
 *   触发哪种读写。
 * - `src/ts-shared/auth/auth-loop.ts`：定义权威时钟；本文件只透传 `setFixedDt` / `reset` /
 *   `start`。
 * - `src/ts-shared/auth/compute-mode.ts`：定义模式取值与交接矩阵；本文件只校验 `set-mode`
 *   的值域并透传。
 * - `src/ts-shared/decoupled/decoupled-loop.ts`：定义解耦循环本体；本文件只在世界重建、
 *   respawn、tickRate 变化三处调用它的方法。
 * - `src/ts-shared/wasm/loader.ts`：负责字节解码与 HTTP 取字节；本文件负责选分支并调用
 *   `initSync`。
 */

import { createWorkerSharedState, type ShmState, type MsgState } from './shared-state.js';
import { AUTH_EVT } from './shared-state.js';
import { base64ToBytes, fetchWasmBytes } from '../wasm/loader.js';
import type { AuthLoop, PhysWorldLike } from './auth-loop.js';
import type { ComputeMode } from './compute-mode.js';
import type {
  DecoupledLoop,
  HoldState,
  SavePointLike,
  SyncRenderStateLike,
} from '../decoupled/decoupled-loop.js';

/** 物理参数键名归一表：`src/ts-shared/phys/params.ts` 的 `buildPhysicsParams` 产出的
 * snake_case 键 → 工程 config 的 camelCase 字段。
 * 表内 10 项即两侧**不同形**的键；余下 5 个（`gravity` / `accelerate` / `friction` /
 * `autobhop` / `sensitivity`）与 game 侧桥追加的 `tickRate` 两侧同形，不登记也能由未命中
 * 分支原样穿透。
 * 命中只换键名、值原样搬运；`jump_height` 一项只服务「值不是 number」的兜底路径——值形态
 * 由 `normalizeConfigPatchKeys` 的专用分支先行接管。 */
const SNAKE_TO_CAMEL_PATCH_KEYS: Record<string, string> = {
  stop_speed: 'stopSpeed',
  jump_height: 'jumpSpeed',
  air_accelerate: 'airAccel',
  run_speed: 'maxSpeed',
  walk_speed: 'walkSpeed',
  crouch_speed: 'crouchSpeed',
  bhop_speed_clamp: 'bhopSpeedClamp',
  teleport_gate_ticks: 'teleportGateTicks',
  yaw_bind_speed: 'yawBindSpeed',
  noclip_speed: 'noclipSpeed',
};

/**
 * `config` 消息里 physics / input 段的键名归一：snake_case → camelCase。
 *
 * 输入是注入方下发的 patch，输出是可直接喂 `applyConfigPatch` 的对象。未知键原样保留，
 * 因此非 physics 语义的键（如 `mode`）也能安全穿过；同名键不查表、直接拷贝。
 *
 * `jump_height` 是唯一的**值语义**转换：patch 给的是跳高（HU），config 存的是起跳速度
 * （HU/s），换算为 v = √(2·g·h)——与 `src/phys/player.rs` 的 `check_jump` 由
 * `params.jump_height` 反推 `velocity[1]` 的算式互为逆运算，故纯改名会让权威端把「已换算
 * 的跳高」再当速度算一次。重力取同一 patch 的 `gravity`，缺失或非 number 时回退 800
 * （与 `apps/debug/src/config.ts`、`apps/game/src/config.ts` 的 `physics.gravity` 默认值同值）。
 *
 * 副作用：无——不触碰任何实例、不改入参。返回值有两种形态：发生过改名时是新对象，一个键都
 * 没改时**返回入参本身**，调用方不应假定拿到副本。
 *
 * 退化行为：不做合法性校验——`gravity` 为 0 / 负值或跳高为负时算出 0 / NaN，同样写进
 * `jumpSpeed`；patch 为 `undefined` 时 `Object.keys` 直接抛 TypeError。
 *
 * 调用点：本文件的 `config` 分支（`section` 为 `physics` 或 `input` 时）。
 */
export function normalizeConfigPatchKeys(patch: Record<string, unknown>): Record<string, unknown> {
  let renamed = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (key === 'jump_height' && typeof patch[key] === 'number') {
      const g = typeof patch.gravity === 'number' ? patch.gravity : 800;
      out.jumpSpeed = Math.sqrt(2 * g * (patch[key] as number));
      renamed = true;
      continue;
    }
    const mapped = SNAKE_TO_CAMEL_PATCH_KEYS[key];
    if (mapped !== undefined) {
      out[mapped] = patch[key];
      renamed = true;
    } else {
      out[key] = patch[key];
    }
  }
  return renamed ? out : patch;
}

/** 装配面：本文件需要的全部外部能力都由调用方以槽对象与钩子的形式注入。 */
export interface WorkerDispatchEnv {
  /** 跨线程状态通道槽：`init` 消息写入 `createWorkerSharedState` 的结果，收到 `init` 之前为 `null`。 */
  shared: { current: ShmState | MsgState | null };
  /** 权威 PhysWorld 槽：`world-json` 构建后写入；多个分支以它作前置真值判断。 */
  phys: { current: PhysWorldLike | null };
  /** 权威时钟：`world-json` 设步长并 reset，`initWasm` 成功后 start。 */
  authLoop: AuthLoop;
  /** 当前权威固定步长（Hz）。`config` 消息应用 patch **之后**读取，故面板改值即时生效。 */
  getConfigTickRate(): number;
  /** 部分更新自身 config 副本。physics / input 段收到的是**归一后**的 patch，其余段是原 patch。 */
  applyConfigPatch(section: string, patch: Record<string, unknown>): void;
  /** 面板参数 → 权威 `set_params` / `set_hull`（经 `src/ts-shared/phys/params.ts` 的
   * `buildPhysicsParams` 映射）。调用点：`world-json` 尾部，以及非 `player` 段的 `config`。 */
  syncParamsToWasm(): void;
  /** 新建权威实例（注入方 `new PhysWorld()`）。`world-json` 按已注入的槽调用一至三次。 */
  createPhysWorld(): PhysWorldLike;
  /** wasm 同步实例化。实参是字节缓冲（`Uint8Array.buffer`），不是胶水期望的 `{ module }`。 */
  initSync(module: ArrayBuffer): void;
  /** 消息发送（Worker → 主线程）。本文件只用它发 `error` 与 `mode-ack` 两种消息。 */
  post(msg: unknown): void;
  // ── 可选扩展槽与钩子（未注入 = 对应能力面整体不激活）────────────────────
  /** 并列第二实例槽：`world-json` 与 `phys` 同建同参，状态与参数分支同步它。 */
  tickPhys?: { current: PhysWorldLike | null };
  /** 并列第三实例槽：`world-json` 与 `phys` 同建同参，状态与参数分支同步它。
   * 本文件从不推进它（无 tick 调用），只按 `phys` 的同一实参同步。 */
  scratch?: { current: PhysWorldLike | null };
  /** 解耦循环句柄：本文件调它的 `publishCurrentState` / `resetSamplers` / `onTickRateChanged`。 */
  decoupledLoop?: DecoupledLoop;
  /** 当前计算模式（worker 侧真相源）。缺省时本文件的模式判断一律按 `'coupled'` 处理。 */
  getComputeMode?(): ComputeMode;
  /** `set-mode` 执行钩子：仅在消息 mode 通过三值校验**且与当前模式不同**时调用（同 mode
   * 幂等跳过）；未注入时模式只影响本文件内部的判断分支。当前工作区内两个工程的注入对象都
   * 未提供该钩子，故模式下发只产生 `mode-ack` 回执。 */
  onSetMode?(mode: ComputeMode, state?: SyncRenderStateLike): void;
  /** `set-hold` 执行钩子：`hold` 缺省归 `null`（解除冻结），`release` 非空时由实现做存点
   * 全量恢复。未注入时整条消息被丢弃（该分支不做其他事）。当前工作区内无注入点。 */
  onSetHold?(hold: HoldState | null, release?: SavePointLike): void;
  /** 外部断点钩子：`respawn` / `teleport` / `teleport-to-pos` 分别传 `AUTH_EVT.respawn` /
   * `AUTH_EVT.teleport`，`sync-render-state` 的全态注入支路传 `AUTH_EVT.load`；
   * `teleport === false` 的常规重锚支路不调用。未注入 = no-op。当前工作区内无注入点。 */
  tickExternalBreak?(evtBit: number): void;
  /** `world-json` 尾部：上报本图出生点 Y 与已记忆的死亡阈值（无记忆时为 `null`）。 */
  onWorldSpawn?(spawnY: number, deathY: number | null): void;
  /** `set-death-threshold` 收到数值时触发一次，早于写实例。 */
  onDeathThreshold?(value: number): void;
  /** `world-json` 尾部触发一次（在 `onWorldSpawn` 之后）。未注入 = no-op。 */
  onWorldRebuilt?(): void;
  /** `init` 分支：写完 `shared` 槽之后调用，入参是原始消息。 */
  onInit?(msg: unknown): void;
  /** `wasm-init` 分支：`initWasm` 的第一步，早于解码与 `initSync`。入参是原始消息，故
   * 与 wasm 无关的载荷（如内嵌纹理包字段）也能在此取用。 */
  onWasmInit?(msg: { wasmB64?: string; wasmUrl?: string; mtzB64?: string }): void;
  /** `world-json` 尾部：入参是**主实例**（`tickPhys` / `scratch` 不回调）。 */
  onWorldBuilt?(phys: PhysWorldLike): void;
  /** `config` 分支末尾：入参是 `section` 与**未归一**的原始 patch。 */
  onConfigApplied?(section: string, patch: Record<string, unknown>): void;
  /** 未识别消息的扩展点。返回值本文件**不使用**：是否已处理不反馈给调用方。 */
  onExtraMessage?(msg: unknown): boolean;
}

/**
 * 创建消息处理器。
 *
 * 返回值是可直接挂到 `self.onmessage` 的同步函数：内部持有闭包状态（死亡阈值记忆、wasm
 * 就绪标志、时钟启动守卫），因此**一次装配只应创建一个**。
 *
 * 副作用：全部落在注入对象上——`env.shared.current` / `env.phys.current` / `env.tickPhys.current` /
 * `env.scratch.current` 四个槽的写入、config 副本的部分更新、实例方法调用、`post` 发送、
 * 以及各钩子回调。
 *
 * 失败行为：除 `initWasm` 的异步 rejection 被收敛为 error 消息外，处理函数不抛错；前置条件
 * 不满足的消息被静默丢弃。
 */
export function createWorkerDispatch(env: WorkerDispatchEnv): (e: MessageEvent<unknown>) => void {
  /**
   * 最近一次收到的死亡阈值（`set-death-threshold` 记忆）。
   *
   * 必须记忆的原因：`world-json` 会重建全部实例，而 Rust 侧 `death_y` 不在种子面，重建后回到
   * 初值（`src/phys/mod.rs` 的 `death_y` 初值为 -100_000.0）；不重放则判定阈值退回默认。
   */
  let lastDeathY: number | null = null;
  /** 把记忆的死亡阈值重放到全部已注入实例（世界重建之后调用）。`lastDeathY` 为 `null` 时
   * 不调用任何实例；`tickPhys` / `scratch` 未注入时跳过。 */
  const reapplyDeathY = (): void => {
    if (lastDeathY === null) return;
    env.phys.current?.set_death_y(lastDeathY);
    env.tickPhys?.current?.set_death_y(lastDeathY);
    env.scratch?.current?.set_death_y(lastDeathY);
  };

  /** wasm 就绪标志：仅 `initWasm` 成功置位；`world-json` 以它作前置守卫。 */
  let ready = false;
  /** `authLoop.start()` 只允许执行一次的守卫。 */
  let loopStarted = false;

  /**
   * wasm 实例化：先回调 `onWasmInit`，再按「内嵌 base64 → fetch URL」的顺序择一实例化。
   *
   * 两条分支都走 `env.initSync`（同步实例化），实参统一为 `Uint8Array.buffer`。把裸
   * `ArrayBuffer` 转成胶水期望的 `{ module }` 形态是注入方的职责：`apps/game/src/worker/main.ts`
   * 的注入为此包了一层，`apps/debug/src/worker/main.ts` 直接注入胶水的 `initSync`。
   * 本文件不调用胶水的异步 `init`，该路径缺省依赖 `import.meta.url` 解析模块 URL，而内嵌
   * 构建把它置换为 `about:blank`（`src/scripts/lib/dist-pack.mjs` 的 `define`）。
   *
   * 分支边界：`wasmB64` 为真值时走解码分支（同步）；否则 `wasmUrl` 为真值时走 HTTP 分支
   * （`await`，非 2xx 由 `src/ts-shared/wasm/loader.ts` 的 `fetchWasmBytes` 抛错）；两者都
   * 缺席则直接返回，`ready` 保持 false。
   *
   * 成功后才置 `ready` 并启动权威时钟一次。`initSync` 抛错或取字节失败时异常向上冒泡，
   * 由 `wasm-init` 分支的 `.catch` 转成 error 消息。
   */
  const initWasm = async (m: { wasmB64?: string; wasmUrl?: string; mtzB64?: string }): Promise<void> => {
    env.onWasmInit?.(m);
    if (m.wasmB64) {
      // 内嵌 base64 分支：解码走 src/ts-shared/wasm/loader.ts 的 base64ToBytes
      env.initSync(base64ToBytes(m.wasmB64).buffer as ArrayBuffer);
    } else if (m.wasmUrl) {
      env.initSync((await fetchWasmBytes(m.wasmUrl)).buffer as ArrayBuffer);
    } else {
      return;
    }
    ready = true;
    if (!loopStarted) {
      loopStarted = true;
      env.authLoop.start();
    }
  };

  /**
   * 消息处理器：按 `msg.type` 分派。无返回值；未识别类型最后交给 `onExtraMessage`。
   */
  return (e: MessageEvent<unknown>): void => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as { type?: string }).type;
    if (type === 'init') {
      const init = msg as { shared?: SharedArrayBuffer | null };
      // 无共享内存（主线程拿不到 SAB，如线上静态部署无 COOP/COEP）→ MsgState 消息回退通道
      env.shared.current = createWorkerSharedState(init.shared ?? null);
      env.onInit?.(msg);
      return;
    }
    if (type === 'input') {
      // MsgState 回退通道的每帧输入（SAB 模式不走此消息）。除三个必填字段外还承载可选的
      // 渲染采样六字段：它们由 src/ts-shared/auth/shared-state.ts 的 MsgState.addInput 附带，
      // 而 recvInput 只在 rt 有值时才写采样槽 ⇒ 旧形态消息（无该字段）天然零影响。
      const d = msg as {
        dx?: number;
        dy?: number;
        keys?: number;
        rt?: number;
        rx?: number;
        ry?: number;
        rz?: number;
        ri0?: number;
        repoch?: number;
      };
      if (env.shared.current && !env.shared.current.isShared) {
        env.shared.current.recvInput(d.dx ?? 0, d.dy ?? 0, d.keys ?? 0, d.rt, d.rx, d.ry, d.rz, d.ri0, d.repoch);
      }
      return;
    }
    if (type === 'wasm-init') {
      const m = msg as { wasmB64?: string; wasmUrl?: string; mtzB64?: string };
      // 异步实例化：失败不抛出到消息循环，转成 error 消息回主线程（ready 保持 false）
      initWasm(m).catch((err) =>
        env.post({ type: 'error', message: `Worker wasm 加载失败: ${err}` }),
      );
      return;
    }
    if (type === 'world-json') {
      const w = msg as unknown as {
        brushJson: string;
        triJson: string;
        teleportJson: string;
        spawn: { x: number; y: number; z: number; yawDeg: number };
      };
      if (!ready) return; // wasm 未就绪：丢弃本消息（两工程都在加载地图前发 wasm-init）
      // 重建前释放旧实例：free 在 PhysWorldLike 上是可选成员，缺省的注入实现自然跳过
      env.phys.current?.free?.();
      env.tickPhys?.current?.free?.();
      env.scratch?.current?.free?.(); // 第三实例随世界重建同步释放
      const p = env.createPhysWorld();
      p.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
      env.phys.current = p;
      // 并列实例与主实例同建同参：同一份世界 JSON、同一出生点 ⇒ 切换时无需补建
      if (env.tickPhys) {
        const t = env.createPhysWorld();
        t.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
        env.tickPhys.current = t;
      }
      // 第三实例同上（本文件不推进它，只保证参数与状态同源）
      if (env.scratch) {
        const sc = env.createPhysWorld();
        sc.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
        env.scratch.current = sc;
      }
      env.syncParamsToWasm(); // 实例建好后重放参数（遍历范围由注入实现决定）
      env.authLoop.setFixedDt(env.getConfigTickRate()); // 重建后同步当前面板步长
      env.authLoop.reset();
      reapplyDeathY(); // 重放记忆的死亡阈值，避免退回 Rust 侧默认值
      env.decoupledLoop?.publishCurrentState(); // 立刻发布一帧，首帧状态即刻可见
      env.onWorldBuilt?.(p);
      env.onWorldSpawn?.(w.spawn.y, lastDeathY); // 出生点 Y + 已记忆的阈值（可为 null）
      env.onWorldRebuilt?.(); // 世界重建完成（非 tick 场景由实现自行忽略）
      return;
    }
    if (type === 'config') {
      const c = msg as { section: string; patch: Record<string, unknown> };
      if (!env.phys.current) return;
      // physics / input 段的 patch 来自 buildPhysicsParams（snake_case），需归一成 config 的
      // camelCase 字段名；其余段原样透传。归一只做键名与 jump_height 的值换算。
      const normalizedPatch =
        c.section === 'physics' || c.section === 'input'
          ? normalizeConfigPatchKeys(c.patch)
          : c.patch;
      // 先更新自身 config 副本：面板值必须落在 worker 侧，否则后续读 tickRate 等字段会读到旧值
      env.applyConfigPatch(c.section, normalizedPatch);
      // tickRate 的处理按模式分叉：解耦模式交给解耦循环处理激活边沿；其余模式改权威固定步长，
      // 且只在步长**真变化**时清累积器——setFixedDt 步长未变返回 false，此时 reset 会丢掉
      // 累积器余量。同一范式见 apps/debug/src/worker/main.ts 的 onTickRateChange。
      if (c.section === 'physics' && typeof normalizedPatch.tickRate === 'number') {
        if ((env.getComputeMode?.() ?? 'coupled') === 'decoupled') {
          env.decoupledLoop?.onTickRateChanged();
        } else {
          if (env.authLoop.setFixedDt(env.getConfigTickRate())) {
            env.authLoop.reset(); // 仅步长真变化才清累积器（防新旧步长错配）
          }
        }
      }
      if (c.section === 'player') {
        // 碰撞箱字段名两工程不同形：game 的 patch 用 halfWidth（apps/game/src/input/input-bridge.ts），
        // debug 的 config 用 radius（apps/debug/src/config.ts）——统一归一成半宽后再写实例
        const pl = c.patch as {
          halfWidth?: number;
          radius?: number;
          standHeight?: number;
          duckHeight?: number;
        };
        const hw = pl.halfWidth ?? pl.radius;
        if (hw !== undefined && pl.standHeight !== undefined && pl.duckHeight !== undefined) {
          env.phys.current.set_hull(hw, pl.standHeight, pl.duckHeight);
          // 并列实例同步同一个 hull：否则会话内两侧会按不同碰撞箱算校准速度。
          // 纯 additive——未注入的槽由可选链跳过，partial patch 的三字段守卫原样保留
          env.tickPhys?.current?.set_hull(hw, pl.standHeight, pl.duckHeight);
          env.scratch?.current?.set_hull(hw, pl.standHeight, pl.duckHeight); // 第三实例同一实参
        }
      } else {
        env.syncParamsToWasm();
      }
      // noclip：只写主实例与第三实例（第二实例不参与本支路）
      if (typeof c.patch.mode === 'string') {
        env.phys.current.set_noclip(c.patch.mode === 'noclip');
        env.scratch?.current?.set_noclip(c.patch.mode === 'noclip');
      }
      env.onConfigApplied?.(c.section, c.patch);
      return;
    }
    if (type === 'respawn') {
      // 重生到 build_world 时给定的初始出生点；检查点回退是独立消息（teleport-to-pos）
      if ((env.getComputeMode?.() ?? 'coupled') === 'decoupled') {
        // 解耦模式：主实例与第二实例一起重置（同建同参 ⇒ 同落出生点），并清采样器、发首帧
        env.phys.current?.respawn();
        env.tickPhys?.current?.respawn();
        env.decoupledLoop?.resetSamplers(false);
        env.decoupledLoop?.publishCurrentState();
      } else {
        // 其余模式：主实例 + 第三实例（第二实例留待模式切换时对齐）
        env.phys.current?.respawn();
        env.scratch?.current?.respawn(); // 第三实例同落出生点，保证种子同源
      }
      env.tickExternalBreak?.(AUTH_EVT.respawn); // 外部驱动断点（非 tick 场景由实现忽略）
      return;
    }
    if (type === 'sync-render-state') {
      // 主线程 → 权威的全态注入通道。本消息按 `teleport` 分两支：显式 false 走「常规重锚」
      // （见下），缺省或 true 走全态注入。写入前先清掉未消费的输入增量，避免同步前的旧鼠标 /
      // 按键残留注入新状态（键位保留——按住状态是实时的）。
      const sm = msg as {
        state?: {
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
        teleport?: boolean;
      };
      if (!env.phys.current || !sm.state) return;
      const s = sm.state;
      if (sm.teleport === false) {
        // ── 常规重锚：位置与角度取渲染侧，速度与 on_ground 保留权威自身 ──────────────
        // 位置**和 yaw/pitch** 一律以渲染状态为准；速度与 on_ground 从权威现读后原样写回
        // （set_state 是全量覆盖接口，必须补齐这两项）。
        //
        // 角度为什么必须取渲染侧：画面朝向来自渲染状态（`apps/debug/src/renderer/renderer-main.ts`
        // 的 `setYawPitch`），而移动方向由**权威速度**决定（`src/ts-shared/phys/authority-calibrator.ts`
        // 的 `calibrateVelocity` 每渲染帧把权威速度写进渲染）——两侧 yaw 分叉即表现为
        // 「视角不动却斜着走」。除本支路外，角度纠正只发生在传送豁免与兜底两处
        // （authority-calibrator 的 `emitTeleportSync`、`YAW_FAULT_DEG` + `YAW_FAULT_FRAMES`）。
        //
        // 绝不可把渲染的 on_ground / 速度写进权威：
        //  · 写 on_ground 会在权威**实际腾空**时打开 `src/phys/player.rs` 的 `check_jump`
        //    硬门（该函数以 `if !p.on_ground { return; }` 开头），而紧随其后的
        //    `p.velocity[1] = jump_velocity` 是**赋值**而非累加，空中重赋即等于再跳一次。
        //  · 写速度会反转「权威是速度之主」的主从关系，并构成「渲染被膨胀的速度 → 权威 →
        //    再写回渲染」的正反馈。
        // 回归门禁：`apps/debug` 的 `test:jump-apex`（`apps/debug/scripts/jump-apex-verify.mjs`）
        // 与 `test:auth-clock`（`apps/debug/scripts/auth-clock-verify.mjs`）。
        const cur = env.phys.current.state() as {
          velX: number;
          velY: number;
          velZ: number;
          onGround: boolean;
        };
        env.phys.current.set_state(
          s.posX, s.posY, s.posZ,
          s.yaw, s.pitch,
          cur.velX, cur.velY, cur.velZ,
          cur.onGround,
        );
        return;
      }
      env.phys.current.set_state(
        s.posX, s.posY, s.posZ, s.yaw, s.pitch,
        s.velX, s.velY, s.velZ, s.onGround,
      );
      if ((env.getComputeMode?.() ?? 'coupled') === 'decoupled') {
        // 解耦：第二实例同注入，避免边界锚定把注入态拉走
        env.tickPhys?.current?.set_state(
          s.posX, s.posY, s.posZ, s.yaw, s.pitch,
          s.velX, s.velY, s.velZ, s.onGround,
        );
      }
      // 全态注入 = 存点 load 语义的外部断点（非 tick 场景由实现忽略）
      env.tickExternalBreak?.(AUTH_EVT.load);
      env.shared.current?.resetInput();
      return;
    }
    if (type === 'set-spawn-points') {
      // 权威出生点列表（JSON 文本），只影响 teleport_to_spawn 的可选目标：缺此列表时索引
      // 越界会被静默忽略（`src/phys/mod.rs` 的 `teleport_to_spawn`）。它不改初始出生点——
      // respawn 与掉落死亡重生仍回 build_world 给出的那个 spawn。
      const sm = msg as { json?: string };
      if (typeof sm.json === 'string' && env.phys.current) {
        env.phys.current.set_spawn_points(sm.json);
        env.tickPhys?.current?.set_spawn_points(sm.json); // 第二实例同一 JSON
        env.scratch?.current?.set_spawn_points(sm.json); // 第三实例同一 JSON
      }
      return;
    }
    if (type === 'teleport') {
      const tm = msg as { target?: number };
      if (typeof tm.target === 'number') {
        env.phys.current?.teleport_to_spawn(tm.target);
        env.tickPhys?.current?.teleport_to_spawn(tm.target); // 第二实例同一索引
        env.scratch?.current?.teleport_to_spawn(tm.target); // 第三实例同一索引
        env.tickExternalBreak?.(AUTH_EVT.teleport); // 外部驱动断点
      }
      return;
    }
    if (type === 'teleport-to-pos') {
      // 按坐标传送（自定义传送点 / 检查点回退）：yaw 缺省时保持**权威当前朝向**，
      // 该朝向从主实例现读，再以同一组实参写给并列实例
      const tm = msg as { pos?: [number, number, number]; yaw?: number };
      if (!env.phys.current || !tm.pos) return;
      const cur = env.phys.current.state() as { yaw: number };
      const yaw = tm.yaw !== undefined ? tm.yaw : cur.yaw;
      env.phys.current.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw);
      env.tickPhys?.current?.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw); // 第二实例同一实参
      env.scratch?.current?.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw); // 第三实例同一实参
      env.tickExternalBreak?.(AUTH_EVT.teleport); // 外部驱动断点
      return;
    }
    if (type === 'set-death-threshold') {
      // 掉落死亡阈值：权威与主线程渲染侧同值，避免双端判定因阈值差异分叉
      //（`src/phys/teleport.rs` 的 `check_death` 判 `pos.y < death_y`）。全部实例写同一值。
      const dm = msg as { value?: number };
      if (typeof dm.value === 'number') {
        lastDeathY = dm.value; // 记忆：世界重建后由 reapplyDeathY 重放
        env.onDeathThreshold?.(dm.value);
        env.phys.current?.set_death_y(dm.value);
        env.tickPhys?.current?.set_death_y(dm.value);
        env.scratch?.current?.set_death_y(dm.value); // 第三实例同一阈值
      }
      return;
    }
    if (type === 'set-mode') {
      // 模式握手：值域白名单校验（三值）→ 与当前模式不同才执行钩子 → 无条件回 mode-ack。
      // 同 mode 重复到达只回 ack、不重复执行钩子；切换所需的状态载荷随消息一并透传给钩子。
      const sm = msg as { mode?: string; state?: SyncRenderStateLike };
      const mode = sm.mode;
      if (mode !== 'coupled' && mode !== 'decoupled' && mode !== 'tick') return;
      if (mode !== (env.getComputeMode?.() ?? 'coupled')) {
        env.onSetMode?.(mode, sm.state);
      }
      env.post({ type: 'mode-ack', mode, appliedAtMs: performance.now() });
      return;
    }
    if (type === 'set-hold') {
      // 解耦 hold 冻结：hold 缺省归 null = 解除；release 非空时由钩子做存点全量恢复
      const hm = msg as { hold?: HoldState | null; release?: SavePointLike };
      if (env.onSetHold) env.onSetHold(hm.hold ?? null, hm.release);
      return;
    }
    // 未识别消息的扩展点：工程特有消息（物理面板等）在此接管
    env.onExtraMessage?.(msg);
  };
}
