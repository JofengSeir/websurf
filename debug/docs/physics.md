# debug 物理模块

> 物理核心为共享层 Rust 物理（`src/phys/`，websurf-phys），Worker 内驱动。
> 公共时序见 `docs/timing-debug.md`。本文档：debug 侧的物理接入细节、循环、共享内存、参数面板链路。

## 1. 物理世界构建（`physics-worker.ts` handleLoadBsp）

```
PhysWorld 实例（WASM）
  ├─ build_world(brushJson, triJson ?? '[]', teleportJson, spawn.x, spawn.y, spawn.z, spawn.yaw)
  │     brushJson = export_brushes_planes（colliderSource: auto/visual/phy 三方案合并）
  │     triJson   = export_model_tri_colliders / _phy_colliders（失败回退薄壳 brush 并入 brushJson）
  │     teleportJson = parse_teleports
  ├─ set_params({ sensitivity: 1 })   ← 灵敏度在 TS 输入层乘入，Rust 端固定 1
  ├─ set_spawn_points([[x,y,z,yaw],...])  ← spawn 下拉切换用
  └─ set_death_y(sceneMinY - 1000)    ← 主线程场景包围盒回传
```

## 2. 物理循环（`physics-loop.ts`）

```
frame 信号（主线程每帧）
  → takeInput（SAB 环形缓冲批量聚合）→ maskToKeys
  → 鼠标增量 × 灵敏度（frameDx/frameDy，每帧一次）
  → 固定步长累积器（1/tickRate，MAX_FIXED_STEPS=10）
      └─ 每步 stepFixed(dt, frameDx, frameDy)：
           physics 模式：Q/E 等效像素（yawBindSpeed·dt/M_YAW）并入 dx
                         → phys.tick(dt, keysMask, dx, dy)（首步含鼠标增量）
           noclip 模式：TS noclipStep（noclipView 自由飞行，不进入 Rust）
  → writeFrame（输出 seqlock）
  → onAfterPhysics（事件/游戏状态/stats）
```

**输入键位掩码**（与共享层 `apply_input` 一致）：forward=1/back=2/left=4/right=8/jump=16/duck=32/sprint(walk)=64/reset=128/wheelJump=256/yawLeft=512/yawRight=1024（wheelJump 并入 jump）。

**noclip**：TS 侧 noclipView（位置/视角权威源），切回 physics 时 `phys.set_state(noclipView 位置/视角, 速度清零)`。

## 3. 共享内存（`shared-state.ts`）

见 `docs/timing-debug.md` §2（输入环形缓冲 SPSC + 输出 seqlock）；`MsgState`（postMessage）为无 SAB 环境的功能等价回退。

## 4. 物理事件（`take_event`）

Rust `tick` 内部触发传送/死亡时记录事件，TS 每帧消费：
- `teleport` → `GameState.onTeleport`（记录检查点 / 终点完成）
- `death` → `GameState.onDeath` + 检查点回退（`getRespawnPos` → `phys.teleport_to`）

## 5. 面板参数链路（`src/physics/`）

```
面板 set-physics-param / reset-physics-param / set-hull / reset-hull 消息
  → PhysicsParams（physics-params.ts）
      ├─ PARAM_TO_RUST 映射 → set_params(snake_case JSON patch)
      ├─ set_hull(halfWidth, standHeight, duckHeight)
      └─ tickRate → onTickRateChange → physicsLoop.setTickRate（固定步长）
  → physics-snapshot 回传面板（值 + 来源 mode-default/manual/map）
```

参数定义（`param-defs.ts`）：maxSpeed/walkSpeed/crouchSpeed/airAccelerate/gravity/accelerate/friction/stopSpeed/jumpHeight/autobhop/bhopSpeedClamp/noPrestrafe/tickRate（13 项，与 Rust PhysParams 对应子集）。

## 6. 物理模式切换

- `set-physics-mode`（noclip ↔ physics）：`physicsLoop.setPhysicsMode` 双向继承位置/视角（noclip→physics 经 set_state 清零速度；physics→noclip 从 Rust state 快照）。
- 传送/重生：`teleport_to_spawn(idx)` / `teleport_to(x,y,z,yaw)` / `respawn()`——noclip 模式同步 noclipView。
