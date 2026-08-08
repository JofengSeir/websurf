# game 物理模块（双物理线 + 权威帧）

> 公共时序见 `docs/timing-game.md`。本文档：双物理线架构、SAB/MsgState 双通道、校准与兜底、输入层细节。

## 1. 架构（v7 定案：权威帧计算模式）

```
主线程 = 唯一物理渲染线（144Hz 可变 dt，全速无限制）
  ├─ PhysWorld（渲染物理）：BSP 解析 + build_world + 每帧 tick + 渲染
  ├─ 输入层：灵敏度乘入角度增量 / Q/E 等效鼠标量（双端同源输入）
  └─ 读权威帧 → set_velocity 校准（只动速度）→ tick → 渲染

Worker = 权威帧计算器（独立固定步长 = 1/tickRate，64/128Hz，累积器无封顶）
  ├─ PhysWorld（权威物理）：world-json 构建（含地图碰撞）
  ├─ 每 tick：takeInput（SAB 累积输入）→ 完整物理 → 碰撞事件检测 → 写权威全状态 + V_A++
  └─ 不反写位置、不渲染
```

## 2. 双通道（`shared-state.ts`）

### ShmState（SAB，crossOriginIsolated）

| 区 | 内容 | 内存序 |
|---|---|---|
| 控制区 | V_A + gen_A + keys + onGround | release 写 / acquire 读 |
| 输入槽 | dx/dy（BigInt64 原子累加，绝不丢）+ keys | 主线程 add；Worker exchange 消耗 |
| 权威全状态双缓冲 | pos/yaw/pitch/vel/eyeHeight/timeMs（每槽 10 值定点：pos/vel×100、角度×1000） | Worker 写槽后 release 递增 V_A |

- **双缓冲**（S_A[0]/S_A[1]）：读侧按 `(V_A-1)&1` 选槽，防多字段撕裂。
- **代际校验**（gen_A）：防主线程读到写入中状态。
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
| 位置突变 | respawn/teleport：双端同执行 + `player-respawn` 回传归零（清输入缓冲） |
| 兜底同步反转 | 渲染主线 → 权威反向同步（渲染 144Hz 精度更高）：dist>500 或（dist>300 且 yaw 同向小差）或 yaw>45° 分叉；250ms 冷却；同步中再分叉回滚以权威为准。通道 `sync-render-state`（Worker `set_state` + resetInput） |
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
  ├─ tickRate：显式传 Worker（fixedDt = 1/tickRate，改档即时生效）
  └─ mode（noclip）：单独立即同步（不随全量下发，防误退 noclip）
```

## 6. noclip（`set_noclip`）

- 面板「自由视角」→ 双端 `set_noclip(true)`（Rust 侧 noclip_step，单一物理源）；noclip 速度 `noclipSpeed`（默认 800，sprint ×4）。
- 渲染切权威直读（防止双管道撕裂）。

## 7. 防穿墙与时间守恒

- 单 tick 输入增量上限（`MAX_INPUT_PER_STEP` 随步长缩放）。
- 固定步长累积器**无封顶**：低帧率不丢物理时间（曾修复"250 速地面一直滑行"= keysMask 残留 + 累积器覆盖式丢时间两个根因）。
