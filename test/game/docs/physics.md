# game 物理模块（双物理线 + 权威帧）

> 最后核对：2026-08-13。以实际代码为准（`game/src/` + 共享 `src/ts-shared/`）。

> 公共时序见 `../../game/docs/timing-game.md`。本文档：双物理线架构、SAB/MsgState 双通道、校准与兜底、输入层细节。

## 1. 架构（v7 定案：权威帧计算模式）

```
主线程 = 唯一物理渲染线（144Hz 可变 dt，全速无限制）
  ├─ PhysWorld（渲染物理）：BSP 解析 + build_world + 每帧 tick + 渲染
  ├─ 输入层：灵敏度乘入角度增量 / Q/E 等效鼠标量（双端同源输入）
  └─ 读权威帧 → set_velocity 校准（只动速度）→ tick → 渲染

Worker = 权威帧计算器（独立固定步长 = 1/tickRate，48-128Hz（默认 64Hz），累积器无封顶）
  ├─ PhysWorld（权威物理）：world-json 构建（含地图碰撞）
  ├─ 每 tick：takeInput（SAB 累积输入）→ 完整物理 → 碰撞事件检测 → 写权威全状态 + V_A++
  └─ 不反写位置、不渲染
```

## 2. 双通道（`shared-state.ts`）

### ShmState（SAB，crossOriginIsolated）

| 区 | 内容 | 内存序 |
|---|---|---|
| 控制区 | V_A + keys + onGround | Atomics.store / load（seq_cst，语义近似 release/acquire） |
| 输入槽 | dx/dy（BigInt64 原子累加，绝不丢） | 主线程 add；Worker exchange 消耗 |
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
| 碰撞事件 | `phys-event`（land/blocked）→ **位置兜底驳回**：不再写回渲染位置，改为把权威位置拉到渲染当前帧（差 <60 才处理；land 仍保留“接近着地”门限） |
| 位置突变 | respawn/teleport：双端同执行（渲染物理本地重生 + Worker 同步），无回传归零——由权威帧校准后续收敛 |
| 兜底同步反转 | 渲染主线 → 权威反向同步（渲染 rAF 精度更高）：三条件 OR（①dist>500 ②dist>300 且 yaw 差≤3° 且转动方向相同 ③dist≤300 且 yaw 差>45°）；**63ms 冷却**；同步中再分叉不再回滚渲染，而是按 63ms 冷却继续把权威拉回渲染。通道 `sync-render-state`（Worker `set_state` + resetInput + authLoop.reset） |
| 位置兜底矢量修正 | 权威被拉回渲染位置时，速度按 `authVel + (renderPos - authPos)/dt` 矢量修正（钳 ±20000，不做碰撞检测） |
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

- 面板「自由视角」→ `config` 消息 mode 字段（`bridge.sendConfig('physics', { mode })`）→ 双端 `set_noclip`（Rust 侧 noclip_step，单一物理源）；noclip 速度 `noclipSpeed`（默认 800，sprint ×4）。
- 无独立权威直读路径（noclip 由渲染物理单线处理）。

## 7. 防穿墙与时间守恒

- 单 tick 输入增量上限 `MAX_INPUT_PER_STEP_BASE`（1200，随步长缩放：base × dt × 64）。
- 固定步长累积器无封顶（每轮询 while 有 `guard < 64` 步数上限，剩余时间留在 acc 不丢失）——低帧率不丢物理时间（曾修复"250 速地面一直滑行"= keysMask 残留 + 累积器覆盖式丢时间两个根因）。

## 8. 已知现状（如实记录）

- **`teleport_gate_ticks` 已删除（P6）**：`config.ts` 字段、面板项、`params.ts` 映射、
  Rust `set_params`/`teleport.check` 签名均已清理；传送触发由 A/B 双路径 + 冷却决定。
- **碰撞事件检测基准**：`land` = onGround 上升沿；`blocked` = 速度骤降（>250 u/s）且
  位移 < 速度对应位移的 0.3，且当前速度 > 80（`curSpeed > 80` 附加门槛，`auth-loop.ts`）。
- **死亡阈值双端已对齐（P5）**：场景加载后 `app.ts` 经 `InputBridge.sendSetDeathThreshold`
  向 Worker 下发 `set-death-threshold`；`renderer-main.ts` 回传 `bbox.min.y - 1000`
  （与注释语义一致）。权威侧 `death_y` 与渲染侧一致，掉落死亡/重生双端生效。
- **反向同步会重置权威步进基准（风险2）**：`sync-render-state`、`respawn`、`teleport`、
  `teleport-to-pos` 后调用 `authLoop.reset()` 清累积器/墙钟基准，防止旧欠步在新状态上
  “狂奔”补算导致再次分叉/来回拉扯。
- **渲染线子步进（风险5）**：渲染 `tick` 将单帧 dt 拆成 ≤1/64s 子步，输入按时间比例
  分摊；避免卡顿恢复首帧（最多 0.1s）在高速 surf 下单步位移过大穿薄墙。
- **跨线程时钟（风险4）**：校准直接比较 Worker `performance.now()` 与主线程时间；
  现代浏览器同 time origin，旧环境常数偏移由 `dt≤0`/`dt>0.1s` 兜底为原始速度注入，
  无累积错误，记录为已知限制。
- **Rust 移动语义细节**（`src/phys/player.rs`，两端共享）：nopre 落地钳制**仅平地**
  （`ground_normal.y > 0.999` 才钳，坡面滑行/冲坡保留速度）；categorize 贴地投影
  （落地的法向速度分量 <0 时移除——平地等价 vy 清零，坡面保留沿坡分量 → 出坡带
  斜上速度）；`contact_ticks` 仅 `normal.y ≥ 0.7`（STANDABLE_NORMAL）计数（斜面滑行
  不计落地 → 传送 gate 防 surf 误触）。
