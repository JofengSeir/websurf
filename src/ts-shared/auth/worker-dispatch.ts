/**
 * Worker 消息分发（公共化 v1）— init / wasm-init / world-json / config / respawn /
 * teleport / teleport-to-pos / set-spawn-points / set-death-threshold / sync-render-state
 * + 双模式扩展（phys-mode-port §3.4.A/C/D/E）：set-mode / mode-ack / set-hold、
 * tickRate 模式感知、config patch 键名归一（W-GAP-1 修复）、respawn/teleport 双实例化。
 *
 * 两端消息集已对齐（debug 补充 teleport-to-pos / set-death-threshold，game 同步协议
 * 后共用）。工程特有消息（debug 物理面板 set-physics-param/set-hull 等）经
 * onExtraMessage 扩展点注入；工程特有副作用经 onInit/onWasmInit/onWorldBuilt/
 * onConfigApplied 钩子注入（debug 的 mtz 内嵌、ready 回执、面板参数覆盖等）。
 */

import { createWorkerSharedState, type ShmState, type MsgState } from './shared-state.js';
import { AUTH_EVT } from './shared-state.js';
import type { AuthLoop, PhysWorldLike } from './auth-loop.js';
import type { ComputeMode } from './compute-mode.js';
import type {
  DecoupledLoop,
  HoldState,
  SavePointLike,
  SyncRenderStateLike,
} from '../decoupled/decoupled-loop.js';

/** W-GAP-1 键名归一表：InputBridge buildPhysicsParams snake_case patch →
 * game config camelCase 字段（snake 与 camel 同名键自动穿透，无需列出）。
 * 归一只改键名不改值——debug 端 patch 全 camel，本表零命中零影响（additive 安全）。
 * ⚠️ 唯一值语义例外 = jump_height（下方 normalizeConfigPatchKeys 值反演）：
 * 表内条目仅作存在性登记，实际转换走专用分支。 */
const SNAKE_TO_CAMEL_PATCH_KEYS: Record<string, string> = {
  stop_speed: 'stopSpeed',
  jump_height: 'jumpSpeed',
  air_accelerate: 'airAccel',
  run_speed: 'maxSpeed',
  walk_speed: 'walkSpeed',
  crouch_speed: 'crouchSpeed',
  bhop_speed_clamp: 'bhopSpeedClamp',
  no_prestrafe: 'noPrestrafe',
  teleport_gate_ticks: 'teleportGateTicks',
  yaw_bind_speed: 'yawBindSpeed',
  noclip_speed: 'noclipSpeed',
};

/** config patch 键名归一（physics/input 段）：snake → camel，未知键原样保留。
 * jump_height 值反演（跳跃回归修复）：patch 的 jump_height 是 Rust 语义
 * （起跳跳高 HU，= v²/2g），config.jumpSpeed 是起跳速度 HU/s——纯改名会把
 * 「已换算的跳高」当「速度」存入 config，worker 侧 syncParamsToWasm 再走一次
 * v²/2g → 跳高 57²/2g=2.03 → Rust 脉冲 √(2·800·2.03)=57 < NON_JUMP_VELOCITY(180)
 * → categorize_position 永不判空中、贴地回吸，解耦模式跳不起来。
 * 反演 v=√(2·g·h) 后与主线程同参（302 → 脉冲 302 > 180 正常离地）。
 * gravity 取 patch 自带值（buildPhysicsParams 恒发），缺省回退 800（createConfig 默认）。 */
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

export interface WorkerDispatchEnv {
  /** 跨线程状态通道槽（init 消息写入；authLoop/同步共用）。 */
  shared: { current: ShmState | MsgState | null };
  /** 权威 PhysWorld 槽（world-json 构建后写入）。 */
  phys: { current: PhysWorldLike | null };
  authLoop: AuthLoop;
  /** 当前 config.physics.tickRate（config 消息 applyConfigPatch 之后读）。 */
  getConfigTickRate(): number;
  /** 部分更新自身 config 副本（applyConfigPatch，来自两端 config.ts）。 */
  applyConfigPatch(section: string, patch: Record<string, unknown>): void;
  /** 面板参数 → 权威 set_params/set_hull（经共享 buildPhysicsParams 映射）。 */
  syncParamsToWasm(): void;
  /** 新建权威 PhysWorld（两端 pkg 导入注入）。 */
  createPhysWorld(): PhysWorldLike;
  /** wasm 模块同步初始化（initSync，两端 pkg 导入注入）。 */
  initSync(module: ArrayBuffer): void;
  /** 消息发送（Worker → 主线程）。 */
  post(msg: unknown): void;
  // ── 双模式扩展（phys-mode-port §3.7 t10；全部可选——debug 不注入 = 解耦面整体不激活）──
  /** 解耦第二实例槽（tickPhys 64t 校准线；world-json 与 phys 同建同参，G3/P9）。 */
  tickPhys?: { current: PhysWorldLike | null };
  /** F4-C scratch 第三实例槽（可选，t4 · t6 §10.1 主案：worker 内乐观评估
   * 执行体；world-json 与 phys 同建同参 G3；仅 tick 模式被驱动，耦合/解耦
   * 零触碰——debug 不注入 = F4-C 整面不激活）。 */
  scratch?: { current: PhysWorldLike | null };
  /** 解耦循环句柄（respawn 首帧/publish、config tickRate 边沿处理用）。 */
  decoupledLoop?: DecoupledLoop;
  /** 当前计算模式（worker 侧真相源；set-mode 翻转。三值——plan-v2 §1.1 新增
   * tick。缺省恒 'coupled'——debug 零感知）。 */
  getComputeMode?(): ComputeMode;
  /** set-mode 执行钩子（§3.4.C 步骤 a-f：gate 翻转 + set_state 状态注入 +
   * tickPhys 对齐 + 采样器清零 + resetInput）。三值——tick 支路
   * 交接语义见 auth/compute-mode.ts MODE_HANDOVER_MATRIX（t3-memo §2.2）。
   * **装配侧实现**：当前唯一注入方 = `test/dual-mode-harness/src/worker-a.ts`
   * 的 `applyModeSwitch`（game 侧注入随 c4824e9 回退移除，debug 未注入）。 */
  onSetMode?(mode: ComputeMode, state?: SyncRenderStateLike): void;
  /** set-hold 执行钩子（解耦 hold 冻结注入/解除（带存点全量恢复））。
   * **装配侧实现**：当前唯一注入方 = harness `worker-a.ts` 的 `applySetHold`。 */
  onSetHold?(hold: HoldState | null, release?: SavePointLike): void;
  /** tick 模式外部断点钩子（可选，t4）：dispatch 侧 respawn/teleport/load 消息
   * → 段序号 +1 + 事件位编码进下一帧（Rust 事件槽不含外部驱动断点——t3-memo
   * §3.4.1 触发清单的 dispatch 面）。实现侧自查 tick 模式（非 tick no-op），
   * 耦合/解耦零回归。 */
  tickExternalBreak?(evtBit: number): void;
  /** 健康护栏：世界构建完成 → 上报本图出生点 Y（越界地板基准）与已记忆的死亡阈值。 */
  onWorldSpawn?(spawnY: number, deathY: number | null): void;
  /** 健康护栏：死亡阈值到达 → 记忆（无出生点信息时当地板用）。 */
  onDeathThreshold?(value: number): void;
  /** world-json 重建钩子（可选，t4）：tick 模式下 tick 标号归零 + 段 +1 +
   * worldRebuild 位 + 排序门重建。非 tick 模式 no-op（实现侧自查）。 */
  onWorldRebuilt?(): void;
  /** init 消息处理钩子（debug：回执 `ready`；game 无）。 */
  onInit?(msg: unknown): void;
  /** wasm-init 消息处理钩子（debug：内嵌默认纹理包 mtzB64 存取）。 */
  onWasmInit?(msg: { wasmB64?: string; wasmUrl?: string; mtzB64?: string }): void;
  /** world-json 世界构建完成钩子（debug：物理面板 attachWorld）。 */
  onWorldBuilt?(phys: PhysWorldLike): void;
  /** config 消息处理完成钩子（debug：面板手动参数覆盖重应用）。 */
  onConfigApplied?(section: string, patch: Record<string, unknown>): void;
  /** 未识别消息扩展点（debug：物理面板消息；返回是否已处理）。 */
  onExtraMessage?(msg: unknown): boolean;
}

export function createWorkerDispatch(env: WorkerDispatchEnv): (e: MessageEvent<unknown>) => void {
  /**
   * 最近一次收到的死亡阈值（`set-death-threshold` 记忆）。
   *
   * 为什么必须记忆：`world-json` 重建物理世界会 `authLoop.reset()` 并新建 PhysWorld，
   * 而 Rust 的 `death_y` 默认是 -100_000（`src/phys/mod.rs`）——重建后若不重放，
   * 判定阈值就退回默认值。故此处记忆 + `reapplyDeathY()` 重放。
   */
  let lastDeathY: number | null = null;
  /** 把记忆的死亡阈值重放到当前全部物理实例（world 重建 / 循环 reset 之后调用）。 */
  const reapplyDeathY = (): void => {
    if (lastDeathY === null) return;
    env.phys.current?.set_death_y(lastDeathY);
    env.tickPhys?.current?.set_death_y(lastDeathY);
    env.scratch?.current?.set_death_y(lastDeathY);
  };

  /** wasm 就绪（wasm-init 成功；world-json 早于 wasm-init 则忽略——主线程 init
   * 顺序保证 wasm 先行）。 */
  let ready = false;
  let loopStarted = false;

  const initWasm = async (m: { wasmB64?: string; wasmUrl?: string; mtzB64?: string }): Promise<void> => {
    env.onWasmInit?.(m);
    // 注意：必须用 initSync({module})——async init() 解构的是 {module_or_path}，
    // 传 {module} 会解构出 undefined → 走 new URL(import.meta.url) 路径，
    // dist 下 import.meta.url 被 define 为 about:blank → "Failed to construct 'URL'"。
    if (m.wasmB64) {
      // dist 内嵌模式（file:// 双击）：base64 → initSync
      const bin = atob(m.wasmB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      env.initSync(bytes.buffer as ArrayBuffer);
    } else if (m.wasmUrl) {
      const resp = await fetch(m.wasmUrl);
      const buf = await resp.arrayBuffer();
      env.initSync(buf);
    } else {
      return;
    }
    ready = true;
    if (!loopStarted) {
      loopStarted = true;
      env.authLoop.start();
    }
  };

  return (e: MessageEvent<unknown>): void => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as { type?: string }).type;
    if (type === 'init') {
      const init = msg as { shared?: SharedArrayBuffer | null };
      // shared 为 null（线上静态无 COOP/COEP）→ MsgState 消息回退通道
      env.shared.current = createWorkerSharedState(init.shared ?? null);
      env.onInit?.(msg);
      return;
    }
    if (type === 'input') {
      // MsgState 回退：主线程每帧消息输入（SAB 模式无此消息）
      // 修复 1：原分支把消息窄化为 {dx?,dy?,keys?}，丢弃 addInput 同拍携带的
      // 6 个渲染采样字段（rt/rx/ry/rz/ri0/repoch）→ 非 COOP/COEP 部署（Pages）
      // 下 Worker 侧 renderSample 恒 null、渲染轨迹投影静默失效。此处补齐全部
      // 字段；recvInput 对 rt===undefined 天然 no-op → 旧形态消息零回归。
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
      if (!ready) return; // wasm 未就绪则忽略（主线程 init 顺序保证 wasm 先行）
      // P5（phys-mode-port 前置修复）：重建前释放旧实例（wasm free）——世界
      // 反复加载时旧 PhysWorld 泄漏，双实例时代泄漏翻倍
      env.phys.current?.free?.();
      env.tickPhys?.current?.free?.();
      env.scratch?.current?.free?.(); // t4 G3 三实例：scratch 随世界重建同步重建
      const p = env.createPhysWorld();
      p.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
      env.phys.current = p;
      // G3/P9（phys-mode-port §3.2）：tickPhys 与 phys 同建同参（harness
      // applyWorld:132-135 双构建先例）——热切零延迟、双实例同步重建
      if (env.tickPhys) {
        const t = env.createPhysWorld();
        t.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
        env.tickPhys.current = t;
      }
      // t4 G3 三实例：scratch 同建同参（F4-C 乐观评估执行体；仅 tick 模式驱动）
      if (env.scratch) {
        const sc = env.createPhysWorld();
        sc.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
        env.scratch.current = sc;
      }
      env.syncParamsToWasm(); // 双/三实例同参（注入实现按槽内全部实例同步）
      env.authLoop.setFixedDt(env.getConfigTickRate()); // 面板 tickRate 生效
      env.authLoop.reset();
      reapplyDeathY(); // world 重建 → 重放记忆的死亡阈值（否则退回 Rust 默认 -100_000）
      env.decoupledLoop?.publishCurrentState(); // 首帧状态即刻可见（harness applyWorld:150 语义）
      env.onWorldBuilt?.(p);
      env.onWorldSpawn?.(w.spawn.y, lastDeathY); // 健康护栏：本图出生点 Y + 已记忆阈值
      env.onWorldRebuilt?.(); // t4：tick 模式标号归零 + 段 +1 + worldRebuild 位（非 tick no-op）
      return;
    }
    if (type === 'config') {
      const c = msg as { section: string; patch: Record<string, unknown> };
      if (!env.phys.current) return;
      // W-GAP-1（phys-mode-port 前置修复）：InputBridge 以 buildPhysicsParams 的
      // snake_case 键下发 patch，而 config/worker 全 camelCase——此前 Object.assign
      // 直入，仅 gravity/accelerate/friction/autobhop/tickRate 五键同构生效，
      // 其余 11 键在权威侧永远陈旧。归一后 patch 键与 config 字段对齐。
      const normalizedPatch =
        c.section === 'physics' || c.section === 'input'
          ? normalizeConfigPatchKeys(c.patch)
          : c.patch;
      // 更新自身 config（v7 隐藏 bug 修复：之前从不应用 patch，权威一直用默认参数，
      // 面板改任何参数（含灵敏度）双端都分叉）
      env.applyConfigPatch(c.section, normalizedPatch);
      // tickRate → 模式感知生效（§3.4.D）：耦合 = 权威固定步长（+3 偏移）即时生效；
      // 解耦 = tickPhys raw 速率 + 激活边沿处理（清 loAcc/tickDx/tickDy + align，
      // 速率值变化不 reset 主累积器——网格相位按新步长自然延续）
      if (c.section === 'physics' && typeof normalizedPatch.tickRate === 'number') {
        if ((env.getComputeMode?.() ?? 'coupled') === 'decoupled') {
          env.decoupledLoop?.onTickRateChanged();
        } else {
          // 修复 2：原支路无条件 setFixedDt + reset，而 input-bridge 把 tickRate
          // 塞进每一条 physics config → 每条都清累积器、丢仿真时间（"tick 计算滑落"）。
          // 正确范式（debug/src/worker/main.ts）：setFixedDt 步长未变返回 false，
          // 此时跳过 reset()，仅步长真变化才清累积器（防新旧步长错配）。
          if (env.authLoop.setFixedDt(env.getConfigTickRate())) {
            env.authLoop.reset(); // 仅步长真变化才清累积器（防新旧步长错配）
          }
        }
      }
      if (c.section === 'player') {
        // 两端碰撞箱字段名差异：game 用 halfWidth，debug 用 radius —— 统一归一化
        const pl = c.patch as {
          halfWidth?: number;
          radius?: number;
          standHeight?: number;
          duckHeight?: number;
        };
        const hw = pl.halfWidth ?? pl.radius;
        if (hw !== undefined && pl.standHeight !== undefined && pl.duckHeight !== undefined) {
          env.phys.current.set_hull(hw, pl.standHeight, pl.duckHeight);
          // G3 双实例同参（t14 修复 r1b-G1，G1 终裁定案 option 2 · 议题已关闭）：
          // player fast-path 原漏同步 tickPhys hull——解耦会话内 64t 校准线持续以
          // 旧 hull 算校准速度（alignTickPhys 只同步状态不同步参数）。纯 additive：
          // 耦合期 tickPhys 闲置零影响、debug 不注入 tickPhys 时 optional chain
          // 跳过、halfWidth/radius 归一与 partial-patch 三字段守卫原样保留
          env.tickPhys?.current?.set_hull(hw, pl.standHeight, pl.duckHeight);
          env.scratch?.current?.set_hull(hw, pl.standHeight, pl.duckHeight); // t4 G3 三实例
        }
      } else {
        env.syncParamsToWasm();
      }
      // noclip 模式：与主线程渲染物理同步（G3：scratch 同步——noclip 不在种子面
      // （§11.1 排除面「转换窗不可变」），双实例状态由 G3 同步保持恒等）
      if (typeof c.patch.mode === 'string') {
        env.phys.current.set_noclip(c.patch.mode === 'noclip');
        env.scratch?.current?.set_noclip(c.patch.mode === 'noclip');
      }
      env.onConfigApplied?.(c.section, c.patch);
      return;
    }
    if (type === 'respawn') {
      // 纯 Rust 重生到初始出生点（计时挑战检查点回退已移主线程）
      if ((env.getComputeMode?.() ?? 'coupled') === 'decoupled') {
        // §3.4.E：解耦模式升级为双实例同步重置（respawn 同建同参 → 两实例同落
        // 出生点天然对齐）+ 采样器清零 + writeDecoupled 首帧
        env.phys.current?.respawn();
        env.tickPhys?.current?.respawn();
        env.decoupledLoop?.resetSamplers(false);
        env.decoupledLoop?.publishCurrentState();
      } else {
        // 耦合模式维持 v7 单实例现状（tickPhys 空闲；复入解耦时 set-mode 对齐）
        env.phys.current?.respawn();
        env.scratch?.current?.respawn(); // t4 G3：scratch 同落出生点（tick 模式种子等价）
      }
      env.tickExternalBreak?.(AUTH_EVT.respawn); // tick 模式段 +1 + respawn 位（非 tick no-op）
      return;
    }
    if (type === 'sync-render-state') {
      // 渲染主线 → 权威同步（用户定调：渲染 144Hz 预测物理精度更高，大偏差时
      // 以渲染主线为准反向校准权威）。同步瞬间清空权威侧未消费输入增量，
      // 防止同步前的旧鼠标/按键残留注入新状态（键位保留——按住状态是实时的）。
      // phys-mode-port §3.4.C/§3.5 升级：本消息原样保留并升级为**模式无关的
      // 「主→worker 全态注入」通道**——解耦下 = phys.set_state + tickPhys 对齐
      //（loop 采样器不清：仅热切才清，set-mode 分支负责）。
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
        // ── 常规反向重锚 = 位置 + 角度取渲染侧（`routineReanchor`）─────────────
        // 位置**和 yaw/pitch** 一律以渲染为准；权威保留自己的**速度**与 on_ground。
        //
        // 角度为什么必须取渲染侧：移动方向由**权威速度**决定（`calibrateVelocity`
        // 每帧把权威速度写进渲染——用户定调"权威是速度之主"），而画面朝向是渲染
        // yaw（renderer-main: `cc.setYawPitch(st.yaw …)`）。两侧 yaw 一旦分叉 δ，
        // 玩家就会"只按 W/S、视角不动，却斜着走"，δ 就是偏角。
        // 实测（debug/scripts/input-replay-verify.mjs 移动方向自检，同协议 A/B）：
        // 修复前稳定偏差 **-3.115°/-3.444°**，补上 yaw/pitch 后 **0.000°**。
        // 此前 yaw 分叉只有两条纠正路径——传送豁免期（`emitTeleportSync`），或
        // `>45° 且渲染静止 8 帧`（authority-calibrator YAW_FAULT_DEG）——**0°~45°
        // 区间无人纠正**，长时间按 W 就一直偏着。
        //
        // 绝不可把渲染的 onGround / 速度写进权威：
        //  · 写 onGround 会在权威**实际腾空**时打开 `check_jump` 的唯一硬门
        //    （player.rs:537 `if !p.on_ground { return; }`），而紧随其后的
        //    `p.velocity[1] = jump_velocity`（≈302）是**赋值**而非累加——
        //    于空中重赋即等于"中途再跳一次"，顶点附近触发会让顶高 57→≈114 **翻倍**。
        //  · 写速度会**反转速度主从**（用户硬性要求：权威速度为准），
        //    并构成"渲染被膨胀的速度 → 权威 → 再写回渲染"的正反馈。
        // 回归门禁：`npm run test:jump-apex`（Fix A 的验收）+ `test:auth-clock`。
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
        // tickPhys 同注入（避免边界锚定把注入态拉走；§3.4.C-c 对齐语义）
        env.tickPhys?.current?.set_state(
          s.posX, s.posY, s.posZ, s.yaw, s.pitch,
          s.velX, s.velY, s.velZ, s.onGround,
        );
      }
      // t4：tick 模式存点 load = 断点（§3.4.1 存点 load 触发——LOAD 位 + 段 +1；
      // 非 tick 模式 no-op——耦合大偏差校准不是断点）
      env.tickExternalBreak?.(AUTH_EVT.load);
      env.shared.current?.resetInput();
      return;
    }
    if (type === 'set-spawn-points') {
      // 权威物理出生点列表（spawn 下拉切换用；world-json 只设了初始 spawn，
      // 缺此列表时 teleport_to_spawn 索引为空 → 静默忽略 → 传送被权威帧拉回）
      const sm = msg as { json?: string };
      if (typeof sm.json === 'string' && env.phys.current) {
        env.phys.current.set_spawn_points(sm.json);
        env.tickPhys?.current?.set_spawn_points(sm.json); // G3 双实例同参
        env.scratch?.current?.set_spawn_points(sm.json); // t4 G3 三实例
      }
      return;
    }
    if (type === 'teleport') {
      const tm = msg as { target?: number };
      if (typeof tm.target === 'number') {
        env.phys.current?.teleport_to_spawn(tm.target);
        env.tickPhys?.current?.teleport_to_spawn(tm.target); // G3 双实例同步
        env.scratch?.current?.teleport_to_spawn(tm.target); // t4 G3 三实例
        env.tickExternalBreak?.(AUTH_EVT.teleport); // t4：tick 模式段 +1 + teleport 位
      }
      return;
    }
    if (type === 'teleport-to-pos') {
      // 自定义传送点/检查点回退（yaw 缺省 = 保持当前朝向）
      const tm = msg as { pos?: [number, number, number]; yaw?: number };
      if (!env.phys.current || !tm.pos) return;
      const cur = env.phys.current.state() as { yaw: number };
      const yaw = tm.yaw !== undefined ? tm.yaw : cur.yaw;
      env.phys.current.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw);
      env.tickPhys?.current?.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw); // G3 双实例同步
      env.scratch?.current?.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], yaw); // t4 G3 三实例
      env.tickExternalBreak?.(AUTH_EVT.teleport); // t4：tick 模式段 +1 + teleport 位
      return;
    }
    if (type === 'set-death-threshold') {
      // 主线程传场景包围盒 minY，直接作为 Rust 死亡阈值（check_death: pos.y < death_y），
      // 与主线程渲染物理 setDeathY 同值——双端判定不因阈值差异分叉。G3 双实例同参。
      const dm = msg as { value?: number };
      if (typeof dm.value === 'number') {
        lastDeathY = dm.value; // 记忆：world 重建后由 reapplyDeathY() 重放
        env.onDeathThreshold?.(dm.value); // 健康护栏：无出生点信息时当地板用
        env.phys.current?.set_death_y(dm.value);
        env.tickPhys?.current?.set_death_y(dm.value);
        env.scratch?.current?.set_death_y(dm.value); // t4 G3 三实例
      }
      return;
    }
    if (type === 'set-mode') {
      // 热切握手（§3.4.C/G2）：UI 触发 → worker 翻转 gate + 状态注入 → mode-ack。
      // 幂等：同 mode 的 set-mode 直接回 ack（不重复执行步骤 a-f）——主线程
      // 500ms 超时重发的兜底回执。
      // tick 模式注册（任务 t2）：mode 联合类型三值化——四向交接矩阵
      // （coupled↔decoupled 既有两向 + coupled→tick/decoupled→tick/tick→coupled/
      // tick→decoupled 四向 tick 行，auth/compute-mode.ts MODE_HANDOVER_MATRIX）
      // 全部经本入口；coupled→tick 必带 state（主线程 predPhys 全态 9 字段，
      // 复用 coupled→decoupled 同款通道，t3-memo §2.2）。
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
      // 解耦模式 C 键 hold 冻结（worker 侧执行，§3.4.A）：hold=null = 解除
      //（release 非空 = 按 loadSavepoint 全量恢复该存点，双实例 + 采样器清零）。
      const hm = msg as { hold?: HoldState | null; release?: SavePointLike };
      if (env.onSetHold) env.onSetHold(hm.hold ?? null, hm.release);
      return;
    }
    // 工程特有消息（物理面板等）
    env.onExtraMessage?.(msg);
  };
}
