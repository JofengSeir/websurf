# game 物理模块（双物理线 + 权威帧）

> 最后核对：2026-08-24。以实际代码为准（`game/src/` + 共享 `src/ts-shared/`）。

> 公共时序见 `./timing-game.md`。本文档：双物理线架构、SAB/MsgState 双通道、校准与兜底、输入层细节。

## 1. 架构（v7 定案：权威帧计算模式）

```
主线程 = 唯一物理渲染线（144Hz 可变 dt，全速无限制）
  ├─ PhysWorld（渲染物理）：BSP 解析 + build_world + 每帧 tick + 渲染
  ├─ 输入层：灵敏度乘入角度增量 / Q/E 等效鼠标量（双端同源输入）
  └─ 读权威帧 → set_velocity 校准（只动速度）→ tick → 渲染

Worker = 权威帧计算器（独立固定步长 = 1/(tickRate+3)——TICK_RATE_OFFSET=3 隐藏偏移，面板显示原值不体现：面板 64 即权威实际 67Hz。面板 48-128 可调，累积器无封顶）
  ├─ PhysWorld（权威物理）：world-json 构建（含地图碰撞）
  ├─ 每 tick：takeInput（SAB 累积输入）→ 完整物理 → 碰撞事件检测 → 写权威全状态 + V_A++
  └─ 不反写位置、不渲染
```

物理世界护栏：`MAX_BRUSHES=8000`、`MAX_TRI_TOTAL=200_000`（WASM 导出层常量，超限静默截断不报错）。

## 2. 双通道（`shared-state.ts`）

### ShmState（SAB，crossOriginIsolated）

| 区 | 内容 | 内存序 |
|---|---|---|
| 控制区 | V_A + keys + onGround | Atomics.store / load（seq_cst，语义近似 release/acquire） |
| 输入槽 | dx/dy（BigInt64 原子累加——并发不丢失 ≠ 数值不削：写入按 round(dx×1000) 定点量化（shared-state.ts:246-249），Worker takeInput 按 maxStep 饱和截断（shared-state.ts:292-304），单 tick 上限 1200°×dt×64（auth-loop.ts:118-119）） | 主线程 add；Worker exchange 消耗 |
| 权威全状态双缓冲 | pos/yaw/pitch/vel/eyeHeight/timeMs（每槽 10 值定点：pos/vel×100、角度×1000） | Worker 写槽后 store 递增 V_A |

- **双缓冲**（S_A[0]/S_A[1]）：读侧按 `(V_A-1)&1` 选槽，防多字段撕裂（无代际校验字段）。
- **定点精度**：位置 0.01 HU、角度 0.001°（Atomics 仅支持整数 TypedArray）。

### MsgState（postMessage 回退，file:// / 静态部署无 COOP/COEP）

- 输入：主线程每帧 `input` 消息（dx/dy/keys）→ Worker 累积（takeInput 语义同 SAB）。
- 权威帧：Worker 每 tick `phys-frame` 消息 → 主线程 `recvFrame` 缓存（readAuthoritative 返回）。
- 功能等价、性能降级。

## 3. 校准与兜底（`renderer-main.ts`）

| 机制 | 规则 |
|---|---|
| 每帧校准 | `set_velocity(vel_A + a×Δt)`：权威速度 + 两帧加速度差外推（考虑中途地图碰撞）；**位置/角度不覆盖** |
| 碰撞事件 | `phys-event`（land/blocked）→ 位置微调（差 <60）+ 角度同步（仅碰撞时可影响渲染角度） |
| 位置突变 | respawn/teleport：双端同执行（渲染物理本地重生 + Worker 同步），无回传归零——由权威帧校准后续收敛 |
| 传送/重置豁免窗口 | 共享校准器 `TELEPORT_EXEMPT_MS=200`（authority-calibrator.ts:107）：`resetTo` 设置豁免截止 `teleportExemptUntilMs`（:99、:328）；豁免期内只读权威速度供外推、绝不覆盖渲染位置，并每帧 `onSyncRenderState` 反向推送让权威追平（:139-168，推送 :159-164）。**game 当前休眠**：`resetTo` 无调用方（仅 renderer-main.ts:636 定义） |
| 兜底同步反转 | 渲染主线 → 权威反向同步（渲染 rAF 精度更高）：三条件 OR（①dist>500 ②dist>300 且 yaw 差≤3° 且转动方向相同 ③dist≤300 且 yaw 差>45°）；250ms 冷却；同步中再分叉回滚以权威为准。通道 `sync-render-state`（Worker `set_state` + resetInput） |
| 角度隔离 | 权威帧不得影响渲染角度（输入层化后双端同源 → 天然一致） |

## 4. 输入层（`app.ts`）

- **灵敏度输入层应用**：mousemove 增量 × sens（CLAMP 1000）→ 物理两端 `sensitivity` 固定 1（`buildPhysicsParams`）——改灵敏度不产生双端分叉（角度永不因灵敏度分叉）。
- **Q/E**：`yawBindSpeed / M_YAW × dt` 等效像素量并入 dx（独立增量，不受灵敏度影响）。
- 同一份输入同时写 SAB 输入槽与主线程本地缓冲（`feedInput`）——双端消费同源。

## 5. 参数链路（`input-bridge.ts`）

```
面板 → sendConfig(section, patch)
  ├─ applyConfigPatch（本地 config）
  ├─ physics/input：buildPhysicsParams → snake_case 全量
  │     → renderer.setPredictionParams（渲染物理即时生效）
  │     → Worker config 消息 → applyConfigPatch（权威参数）→ set_params
  ├─ player：setPredictionHull + Worker set_hull
  ├─ tickRate：显式传 Worker（fixedDt = 1/(tickRate+3)，改档即时生效）
  └─ mode（noclip）：单独立即同步（不随全量下发，防误退 noclip）
```

## 6. noclip（`set_noclip`）

- 面板「自由视角」→ `config` 消息 mode 字段（`bridge.sendConfig('physics', { mode })`）→ 双端 `set_noclip`（Rust 侧 noclip_step，单一物理源）；noclip 速度 `noclipSpeed`（默认 800，sprint ×4）。
- **sprint ×4 的跨语言字段映射**：TS 键位的 Shift 写入 keysMask.sprint 位；共享层同名字段双语义——noclip 模式 = 冲刺倍率，physics 模式映射到 Rust `input.walk`（慢走）（shared-state.ts:43-44 注释）；Rust noclip_step 读 `input.walk` 位 ×4（mod.rs:574）。同一键位按模式分流，无双端分叉。
- 无独立权威直读路径（noclip 由渲染物理单线处理）。

## 7. 防穿墙与时间守恒

- 单 tick 输入增量上限 `MAX_INPUT_PER_STEP_BASE`（1200，随步长缩放：base × dt × 64）。
- 固定步长累积器无封顶（每轮询 while 有 `guard < 64` 步数上限，剩余时间留在 acc 不丢失）——低帧率不丢物理时间（曾修复"250 速地面一直滑行"= keysMask 残留 + 累积器覆盖式丢时间两个根因）。

## 8. 已知现状（如实记录）

- **`teleport_gate_ticks` 已失效**：面板仍可调（1-20，默认 3——961b867 对齐面板与 Rust 默认）
  并下发 `set_params`，但
  Rust `teleport.check` 不再使用该参数（`src/phys/mod.rs` 注释明示"仅保留签名兼容"）；
  传送触发由 A/B 双路径 + 冷却决定（见 `docs/architecture.md` §3.1）。
- **碰撞事件检测基准**：`land` = onGround 上升沿；`blocked` = 速度骤降（>250 u/s）且
  位移 < 速度对应位移的 0.3，且当前速度 > 80（`curSpeed > 80` 附加门槛，`auth-loop.ts`）。
- **死亡阈值双端不对称**：主线程预测物理收到 `set_death_y(bbox.min.y)`（`renderer-main.ts`
  回传场景最低 Y，注释虽写"最低 Y - 1000"但实传未减）；权威 Worker **运行时收不到**
  `set-death-threshold`——桥方法 `sendSetDeathThreshold` 已具备完整双发通道
  （本地 `setDeathY` + `worker.postMessage`，`input-bridge.ts:68-74`，对齐 debug 桥模式），
  但无任何调用方（无 UI 入口）、运行时不发送 → 权威侧 `death_y` 恒为
  Rust 默认 -100000 → **权威物理掉落永不死亡重生**，双端死亡判定分叉（与 debug 双端
  同值回传不同）。
- **Rust 移动语义细节**（`src/phys/player.rs`，两端共享）：nopre 落地钳制**仅平地**
  （`ground_normal.y > 0.999` 才钳，坡面滑行/冲坡保留速度）；categorize 贴地投影
  （落地的法向速度分量 <0 时移除——平地等价 vy 清零，坡面保留沿坡分量 → 出坡带
  斜上速度）；`contact_ticks` 仅 `normal.y ≥ 0.7`（STANDABLE_NORMAL）计数（斜面滑行
  不计落地 → 传送 gate 防 surf 误触）。
