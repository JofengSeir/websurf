/**
 * Worker 消息分发（公共化 v1）— init / wasm-init / world-json / config / respawn /
 * teleport / teleport-to-pos / set-spawn-points / set-death-threshold / sync-render-state。
 *
 * 两端消息集已对齐（debug 补充 teleport-to-pos / set-death-threshold，game 同步协议
 * 后共用）。工程特有消息（debug 物理面板 set-physics-param/set-hull 等）经
 * onExtraMessage 扩展点注入；工程特有副作用经 onInit/onWasmInit/onWorldBuilt/
 * onConfigApplied 钩子注入（debug 的 mtz 内嵌、ready 回执、面板参数覆盖等）。
 */

import { createWorkerSharedState, type ShmState, type MsgState } from './shared-state.js';
import type { AuthLoop, PhysWorldLike } from './auth-loop.js';

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
      const d = msg as { dx?: number; dy?: number; keys?: number };
      if (env.shared.current && !env.shared.current.isShared) {
        env.shared.current.recvInput(d.dx ?? 0, d.dy ?? 0, d.keys ?? 0);
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
      const p = env.createPhysWorld();
      p.build_world(w.brushJson, w.triJson, w.teleportJson, w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.yawDeg);
      env.phys.current = p;
      env.syncParamsToWasm();
      env.authLoop.setFixedDt(env.getConfigTickRate()); // 面板 tickRate 生效
      env.authLoop.reset();
      env.onWorldBuilt?.(p);
      return;
    }
    if (type === 'config') {
      const c = msg as { section: string; patch: Record<string, unknown> };
      if (!env.phys.current) return;
      // 更新自身 config（v7 隐藏 bug 修复：之前从不应用 patch，权威一直用默认参数，
      // 面板改任何参数（含灵敏度）双端都分叉）
      env.applyConfigPatch(c.section, c.patch);
      // tickRate → 权威固定步长即时生效（面板 64↔128 切换真正改变物理采样率）
      if (c.section === 'physics' && typeof c.patch.tickRate === 'number') {
        env.authLoop.setFixedDt(env.getConfigTickRate());
        env.authLoop.reset(); // 清累积器，防新旧步长错配
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
        }
      } else {
        env.syncParamsToWasm();
      }
      // noclip 模式：与主线程渲染物理同步
      if (typeof c.patch.mode === 'string') {
        env.phys.current.set_noclip(c.patch.mode === 'noclip');
      }
      env.onConfigApplied?.(c.section, c.patch);
      return;
    }
    if (type === 'respawn') {
      // 纯 Rust 重生到初始出生点（计时挑战检查点回退已移主线程）
      env.phys.current?.respawn();
      // 显式重置类消息同步清权威步进基准，防止旧欠步在新状态上“狂奔”补算
      env.authLoop?.reset();
      return;
    }
    if (type === 'sync-render-state') {
      // 渲染主线 → 权威同步（用户定调：渲染 144Hz 预测物理精度更高，大偏差时
      // 以渲染主线为准反向校准权威）。同步瞬间清空权威侧未消费输入增量，
      // 防止同步前的旧鼠标/按键残留注入新状态（键位保留——按住状态是实时的）。
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
      };
      if (!env.phys.current || !sm.state) return;
      const s = sm.state;
      env.phys.current.set_state(
        s.posX, s.posY, s.posZ, s.yaw, s.pitch,
        s.velX, s.velY, s.velZ, s.onGround,
      );
      env.shared.current?.resetInput();
      // 风险2：同步后清权威累积器与墙钟基准，避免旧欠步追赶导致再次分叉/来回拉扯。
      // reset() 幂等，且与 P4-B1 的 pause(true) → sync-render-state → pause(false) 兼容。
      env.authLoop?.reset();
      return;
    }
    if (type === 'set-spawn-points') {
      // 权威物理出生点列表（spawn 下拉切换用；world-json 只设了初始 spawn，
      // 缺此列表时 teleport_to_spawn 索引为空 → 静默忽略 → 传送被权威帧拉回）
      const sm = msg as { json?: string };
      if (typeof sm.json === 'string' && env.phys.current) {
        env.phys.current.set_spawn_points(sm.json);
      }
      return;
    }
    if (type === 'teleport') {
      const tm = msg as { target?: number };
      if (typeof tm.target === 'number') {
        env.phys.current?.teleport_to_spawn(tm.target);
      }
      env.authLoop?.reset();
      return;
    }
    if (type === 'teleport-to-pos') {
      // 自定义传送点/检查点回退（yaw 缺省 = 保持当前朝向）
      const tm = msg as { pos?: [number, number, number]; yaw?: number };
      if (!env.phys.current || !tm.pos) return;
      const cur = env.phys.current.state() as { yaw: number };
      env.phys.current.teleport_to(tm.pos[0], tm.pos[1], tm.pos[2], tm.yaw !== undefined ? tm.yaw : cur.yaw);
      env.authLoop?.reset();
      return;
    }
    if (type === 'set-death-threshold') {
      // 主线程传场景包围盒 minY，直接作为 Rust 死亡阈值（check_death: pos.y < death_y），
      // 与主线程渲染物理 setDeathY 同值——双端判定不因阈值差异分叉。
      const dm = msg as { value?: number };
      if (typeof dm.value === 'number') {
        env.phys.current?.set_death_y(dm.value);
      }
      return;
    }
    if (type === 'pause') {
      // P4-B1：后台标签页时序黑洞根治——暂停/恢复权威自驱链。
      // 消息 FIFO 保证顺序：pause(true) → sync-render-state → pause(false)，
      // 恢复时权威已对齐渲染线当前状态后才重启步进。
      const pm = msg as { paused?: boolean };
      env.authLoop.setPaused(pm.paused === true);
      return;
    }
    // 工程特有消息（物理面板等）
    env.onExtraMessage?.(msg);
  };
}
