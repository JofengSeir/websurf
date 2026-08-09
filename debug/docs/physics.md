# debug 物理模块

> 物理核心为共享层（Rust `src/phys/` + TS `src/ts-shared/`），与 game 同模式：
> **主线程唯一物理渲染线** + **Worker 权威帧计算器**。公共时序见 `docs/timing-debug.md`。
> 本文档：debug 侧的物理接入、校准、面板参数链路、事件消费。

## 1. 物理世界构建（主线程）

```
PhysWorld 实例（主线程渲染物理）
  ├─ build_world(brushJson, triJson ?? '[]', teleportJson, spawn.x, spawn.y, spawn.z, spawn.yaw)
  │     brushJson = world-builder 导出（colliderSource: auto/visual/phy 三方案互斥单选）
  │     triJson   = 按 colliderSource 选 export_model_phy_colliders（auto/phy）或 export_model_tri_colliders（visual）；导出失败回退可视网格
  ├─ set_params(buildPhysicsParams(config))   ← 共享 ts-shared/phys/params（sensitivity: 1）
  ├─ set_spawn_points([[x,y,z,yaw],...])
  └─ set_death_y(sceneMinY)                   ← 主线程场景包围盒 min.y（双端同值，无减量）
```

权威 Worker：收 `world-json`（同一导出数据）构建独立 PhysWorld（共享 auth-loop 驱动）。

## 2. 渲染帧（主线程唯一物理渲染线，rAF 可变 dt 钳 0.1s）

```
每 rAF：
  → shared.addInput(pendingDx, pendingDy, pendingKeys)   （SAB 输入槽，权威同源）
  → calibrator.correctFromAuthority()                      （读权威帧 V_A，三条件兜底+冷却+回滚）
  → calibrator.calibrateVelocity(now)                      （set_velocity(vel_A + a×Δt)，只动速度）
  → predPhys.tick(dt, keys, dx, dy)                        （完整物理：碰撞/传送/死亡）
  → take_event 消费（传送/死亡 → 计时挑战）
  → state() 直读渲染（相机 = pos + eyeHeight，度→弧度）
```

共享实现：`AuthorityCalibrator`（`src/ts-shared/phys/authority-calibrator.ts`）。

## 3. 权威帧（Worker，共享 auth-loop）

```
setTimeout 4ms 自驱；固定步长累积器无封顶（guard<64）
  → exchange 消耗输入（maxStep 防穿墙，随步长缩放）
  → PhysWorld.tick（独立权威演化，含地图碰撞）
  → 碰撞事件检测（落地上升沿 / 撞墙速度骤降+位移受阻）
  → 写权威全状态双缓冲 + V_A++
  → phys-event（land/blocked）低频回传
```

共享实现：`createAuthLoop` / `createWorkerDispatch`（`src/ts-shared/auth/`）。

## 4. 校准与兜底

| 机制 | 规则 |
|---|---|
| 每帧校准 | `set_velocity(vel_A + a×Δt)`（权威速度 + 两帧加速度差外推，clamp±20000）；位置/角度不覆盖 |
| 碰撞事件 | `phys-event` → 渲染位置与权威差 <60 → `set_state` 微调（含角度） |
| 位置突变 | respawn/teleport/teleport-to-pos：双端同执行 + `resetTo`（清校准状态，防"权威帧拉回"） |
| 兜底同步反转 | 渲染主线 → 权威：三条件 OR（dist>500 / dist>300 且 yaw 差≤3° 同向 / dist≤300 且 yaw 差>45°）；250ms 冷却；在途再分叉回滚以权威为准。通道 `sync-render-state`（Worker `set_state` + resetInput） |
| 角度隔离 | 权威帧不影响渲染角度（输入层化后双端同源 → 天然一致） |

## 5. 输入链路（共享 input-layer）

- 灵敏度：主线程 mousemove 乘入角度增量（`layerMouseDelta`，CLAMP 1000），物理两端 `sensitivity` 固定 1。
- Q/E：`qeEquivalentDx`（`yawBindSpeed/M_YAW × dt` 等效像素，不受灵敏度影响）。
- 双端同源：同一份已层化输入喂 SAB（权威）与主线程物理缓冲。
- 未锁定强制 mask=0；滚轮跳锁定门控；退锁/失焦清双端输入。

## 6. 面板参数链路（debug 特有）

```
面板 set-physics-param / set-hull / reset 消息
  → 权威 Worker（physics-worker.ts PhysicsParams → set_params / set_hull）
  → physics-snapshot 回传 → 主线程镜像 predPhys（PARAM_TO_RUST 映射，双端同参）
  → tickRate：面板变更 → 权威 Worker fixedDt（共享 worker-dispatch config 处理）；
    渲染线为 rAF 可变 dt，无需步长
```

参数定义（`param-defs.ts`）：maxSpeed/walkSpeed/crouchSpeed/airAccelerate/gravity/accelerate/friction/stopSpeed/jumpHeight/autobhop/bhopSpeedClamp/noPrestrafe/tickRate（13 项，与 Rust PhysParams 对应子集）。

## 7. noclip

- 面板切换 → `config { physics: { mode } }` 消息双端 → Rust `set_noclip`（noclip_step 无碰撞纯移动，`noclipSpeed` 默认 800，sprint ×4）。
- 位置/视角继承在 Rust 内部（无 TS 双视图）。
