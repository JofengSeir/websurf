# WorkerA 双模物理（实现篇 · 维度 I）

> **事实基准**：本文所有论断核对自当前工作区代码（核对日期 2026-09-07）。未注明前缀的相对路径均相对 `test/dual-mode-harness/`；仓库根共享层以 `仓库根 src/…` 标注。循环骨架与唤醒协议的时序视角见 [../sequences.md](../sequences.md)。
> 设计动机的历史推导（「64t 坡速 ≈ 无限制」会审、旧单实例实现的缺陷、四条用户要求）见工程根 [../../CONCLUSION.md](../../CONCLUSION.md)；本文只记录**当前代码**如何落地这些结论。

## 1. 双实例架构：两个 PhysWorld

WorkerA 持有两个独立的 `PhysWorld` 实例（`src/worker-a.ts:103-107`），均来自共享 crate `websurf-phys` 的 re-export（`crates/wasm/src/lib.rs:35` `pub use websurf_phys::phys::PhysWorld`）：

| 实例 | 变量 | 步长 | 输入 | 职责 | 出处 |
|---|---|---|---|---|---|
| 模式A（无限制真理源） | `phys` | 1ms 固定子步（`RENDER_DT = 0.001`，`:45`） | 逐子步实时消费（`consumeInput`，缺省不限幅） | 推进位置/角度；**共享状态槽唯一写入者**；WorkerB 渲染参数唯一来源 | `:21-22,104,153-164,292-293` |
| 模式B（独立 64t 权威速度线） | `tickPhys` | 仅 `tickDt = 1/tickRate` 步长 | tick 边界快照（键位当前掩码 + 鼠标窗口累积） | 真实 64t 离散物理演化；对模式A 的唯一影响 = `set_velocity` 三轴速度校准 | `:11-19,105-107,240-270` |

两条线**各自独立演化**：模式B 保留自己的 64t 离散相位（摩擦/加速/碰撞/bhop 钳制相位都在 tickDt 网格上），只在两处被「拉回」模式A——停用→激活边沿的全量对齐（`:228-238`）与分叉兜底锚定（§5）。

## 2. 常量表（src/worker-a.ts:43-67）

| 常量 | 值 | 作用 |
|---|---|---|
| `RENDER_DT` | 0.001 s | 模式A 固定 1ms 子步（`:45`） |
| `MAX_DELTA` | 0.05 s | 轮间隔 clamp 上限，防炸（`:47`；clamp 在 `:218-221`） |
| `MAX_STEPS_PER_ROUND` | 8 | 每轮最多 1ms 子步数；超限保留剩余累加防时间丢失（`:48-49`） |
| `MAX_ACC` | 0.02 s | 累加器封顶——8 次上限耗尽后的残留上限，防无限追赶（`:50-51`，封顶在 `:295-296`） |
| `MAX_INPUT_DELTA` | 1000 px | 单次 mousemove 事件削平阈值（主线程已按事件 CLAMP；WorkerA 侧用于 tick 边界窗口上限）（`:52-53`） |
| `tickInputMax(tickDt)` | 1000 × (tickDt/0.001) | tick 边界鼠标增量上限：按 tick 窗口放大，防极端甩视角穿墙（`:54-57`） |
| `WAIT_THRESHOLD_MS` | 1 ms | 距下次子步剩余 ≥1ms 才挂起，否则自旋（`:58-59`） |
| `MAX_WAIT_MS` | 4 ms | 单次最长休眠，限制 respawn/init-wasm 等消息最坏延迟（`:60-61`） |
| `GRAVITY` | 800 | 默认 PhysParams.gravity（test 无重力调节面板）（`:62-63`） |
| `DEFAULT_WASM_URL` | './websurf_test_wasm_bg.wasm' | wasm 文件（build:wasm 已复制到工程根）（`:64-65`） |
| `EMPTY_TELEPORT_JSON` | '{"teleports":[],"triggers":[]}' | 空传送 report：最小集明确排除传送区域，`build_world` 必须接收该参数（`:66-67`） |
| `TICK_ANCHOR_DIST` | 64 units | 分叉兜底锚定距离阈值（`:174-177`） |

## 3. 先 tick、后无限制：每轮循环

循环整体在 [../sequences.md](../sequences.md) §4 已逐字给出；本节补齐实现要点。

### 3.1 模式B 激活判定与边沿

- `modeBActive = tickRate > 0 && 1/tickRate > RENDER_DT`（`src/worker-a.ts:226`）——`TICK_RATE=0`（难度关闭）或 ≥1000Hz（tickDt ≤ 1ms，与模式A 等价）时**跳过 tick 块**，纯 1ms 无限制实时输入（`:23-24`、`:271-273` `loAcc = 0`）。
- **停用→激活边沿**（`:228-232`）：清零 loAcc/tickDxAcc/tickDyAcc（防陈旧输入）+ `alignTickPhys()`——`tickPhys.set_state(phys.state() 的位置/朝向/速度/着地)` 对齐起点（`:166-172`），之后 tickPhys 独立演化。
- **激活→停用边沿**（`:233-237`）：同样清零采样器。

### 3.2 tick 边界输入采样（模式B 的输入语义）

模式B 的输入与模式A 不同源，刻意模拟真实 64t 服务器语义（`src/worker-a.ts:9-10,246-253`）：

- **键位** = `shared.peekKeys()`（`src/shared-state.ts:290-297`）——非消耗读当前键位掩码。「键位是『当前状态』覆盖写，读边界时刻的当前值 = 真实 64t 服务器语义」。
- **鼠标** = `tickDxAcc/tickDyAcc`——**自上一 tick 边界以来模式A 实时消耗掉的累积增量**：模式A 每个 1ms 子步 `consumeInput()` 后，若模式B 激活则把该子步消费到的 dx/dy 累加进窗口累积器（`:288-291`）；tick 边界到达时一次性注入 tick 实例（限幅 `tickInputMax(tickDt)`）并清零（`:249-253`）。「与真实 64t 服务器『边界消费整窗口』等价」。
- 该采样设计使 tick 边界观察到的输入与模式A 同步演进，避免双线因输入割裂而分叉。

### 3.3 模式A 无限制子步

- `consumeInput()` 缺省**不限幅**（`src/shared-state.ts:404-410` 注释：主线程已按单次 mousemove 事件 CLAMP，这里必须消费完整帧增量，避免「整帧累加器被排空 + 削平到 ±1000」导致快速甩动丢失，`src/worker-a.ts:282-284`）。
- 每子步：`phys.tick(RENDER_DT, keys, dx, dy)` → `writeStateFromPhys()`（每子步发布一次状态，1kHz 发布率）。
- 大 delta（如隐藏标签页恢复）：每轮最多 8 个子步 + `MAX_ACC` 封顶——**时间不丢失**（剩余累加下轮继续补跑），只防死亡螺旋（`:47-51,295-296`）。

## 4. 速度校准：唯一 tick 影响通道

```ts
// src/worker-a.ts:268-269
const st = tickPhys.state();
phys.set_velocity(st.velX, st.velY, st.velZ);
```

- **每 tick 边界执行**，三轴全写（含 vy）——独立实例的 vy 是自身 64t 重力演化结果，不存在「重复推进时间」问题，无需旧实现「vy 用模式A」的补救 hack（`src/worker-a.ts:18-20` 头注）。
- **位置/角度绝不触碰**（`:267` 注释「位置/角度绝不触碰（用户要求 3）」）——模式A 的位置/角度只由自己推进。
- **时刻对齐**：tick 实例只在边界推进，其状态时刻 = 边界时刻，校准注入的速度与模式A 位置**同刻**（消除旧单实例实现「在模式A 末端状态上再走 15.6ms、其速度对应 T+15.6ms 却注入 T 时刻」的「未来速度」伪差；`src/worker-a.ts:16-17` 头注、[../../CONCLUSION.md](../../CONCLUSION.md) §一.3）。

## 5. 分叉兜底锚定（TICK_ANCHOR_DIST = 64）

```ts
// src/worker-a.ts:180-188
function tickDiverged(): boolean {
  const s = phys.state(); const t = tickPhys.state();
  const dx = s.posX - t.posX; const dy = s.posY - t.posY; const dz = s.posZ - t.posZ;
  return dx*dx + dy*dy + dz*dz > TICK_ANCHOR_DIST * TICK_ANCHOR_DIST;
}
```

- tick 边界**先检查后推进**：`if (tickDiverged()) alignTickPhys()`（`:259-261`）——与模式A 位置偏差平方 > 64² 视为「极限操作分叉」（死亡/传送/卡墙/坡缘等极限操作后校准速度脱离渲染上下文的「渲染混乱」根因），**全量 set_state 拉回模式A**（`:254-258` 注释）。
- 正常演化偏差有界（≤ 数十 units）**不干预**——tick 保持自身 64t 离散演化，避免每边界强制锚定引入相位伪差（试错记录：强制锚定会导致 tick 着地判定错位 → 空中二次起跳/落地延迟/连跳梯度崩塌，已废弃，[../../CONCLUSION.md](../../CONCLUSION.md) §二「关键语义」末条）。

## 6. 世界构建（world-json）

**来源**：BSP 是唯一玩法。主线程解析 BSP 后发 `world-json`（`src/main.ts:231`；导出流程见 [../sequences.md](../sequences.md) §8）。

`applyWorld`（`src/worker-a.ts:126-151`）：

1. `phys.set_hull(16, 72, 54)` + `phys.build_world(brushJson, triJson, EMPTY_TELEPORT_JSON, sx, sy, sz, yaw)`（`:129-130`）——碰撞箱固定 16/72/54（cs-movement 基准体型；debug 同值但可经面板调整，仓库根 `debug/src/physics/physics-params.ts:17` DEFAULT_HULL = {16, 72, 54}）。
2. tick 实例同步构建同世界（同出生点同世界，`:132-135`）。
3. **死亡阈值**：解析 brushJson 取全部 brush `min[1]` 最小值 − 100 → `set_death_y`（双实例；解析失败仅告警并保持默认，`:137-149`）。
4. `writeStateFromPhys()`——首帧状态即刻对 WorkerB 可见（`:150`）。

**到达时序容错**：`world-json` 先于 wasm 初始化到达 → 暂存 `pendingWorld`，`startInit` 完成后应用（`:110-111,338-343,202-205`）。

**PhysWorld API 使用面**：worker-a 只用 `set_hull / build_world / set_death_y / tick / set_velocity / set_state / state / respawn`（grep `phys.` 于 `src/worker-a.ts`）；`scripts/check-wasm-api.mjs:26-39` 固化的 12 API 契约（另含 predict/teleport_to/set_params/set_yaw_pitch/take_event）全部由共享 `websurf-phys` 提供（仓库根 `src/phys/mod.rs` 21 个导出方法，见 [../../../../docs/phys.md](../../../../docs/phys.md)）。

## 7. 消息协议（WorkerA 侧）

| 消息 | 处理（`src/worker-a.ts:311-354`） |
|---|---|
| `init-shared` | `TestShared.init(SAB)` → `startInit()`（`:314-317`） |
| `init-msg` | `TestShared.initMessaging(renderPort)`（状态发布直连 WorkerB 端口）→ `startInit()`（`:318-322`） |
| `init-wasm` | 记录 `wasmUrl`（可覆盖 DEFAULT_WASM_URL）；shared 已就绪且未启动则 `startInit()`（`:323-326`） |
| `respawn` | `phys.respawn()` + `tickPhys.respawn()` + 清 loAcc/tickDxAcc/tickDyAcc + `writeStateFromPhys()`（`:327-337`） |
| `world-json` | phys 就绪 → `applyWorld`；否则暂存 `pendingWorld`（`:338-344`） |
| `shared-input` | 消息回退：`shared.onInputMessage(dx,dy,keysMask)`（本地累加，`:345-348`；等价 SAB addInput，`src/shared-state.ts:373-397`） |
| `shared-tick-rate` | 消息回退：`shared.onTickRateMessage(rate)`（`:349-352`） |

## 8. 设计动机（当前结论的代码落点）

「为什么双模、为什么稳态速度 tick 无关」的完整推导见 [../../CONCLUSION.md](../../CONCLUSION.md)；其物理层依据在共享 crate 中可逐条核对（仓库根 `src/phys/player.rs`）——摩擦 `drop = control × friction × dt`（`player.rs:312`）、地面/空中加速 `accelspeed = accel|airaccel × wishspeed × dt`（`player.rs:272,295`）、半隐式重力 `½g·dt` ×2（`player.rs:946-948`）、`clip_velocity` 精确剪裁（`player.rs:323`）：算子全部按 dt 标定 ⇒ sustained surf 稳态速度是 **tick 不变量**，64t 与 1ms 必然收敛到同一平衡速度。因此 harness 的双模价值不在稳态速度，而在**输入采样相位 + 离散施加点**（bhop 起跳延迟 ∈(0, tickDt]、转向台阶、碰撞/钳制相位）——这些正是 tick 边界采样（§3.2）与独立实例演化（§1）所承载的（预期行为声明：`src/worker-a.ts:28-29` 头注）。

## 9. 验证覆盖

- `scripts/phys-smoke.mjs`（3585 行，53 断言）：`ModeAB` 驱动器逐字镜像 worker-a loop 语义（`scripts/phys-smoke.mjs:405-486`），覆盖模式A 起跳即时/tick 线起跳延迟、稳态速度、累加器上限、消息回退等；断言 #24-29 直接针对 §3.3 的子步上限/封顶。
- `scripts/dual-compare.mjs`：相同输入序列下 game 双线（可变 dt）vs test 双模数据对照（`scripts/dual-compare.mjs:1-12`）。
- `scripts/perf-bench.mjs`：1ms 子步耗时分布，判据 p95 < 1000µs（`scripts/perf-bench.mjs:6-8`）。
