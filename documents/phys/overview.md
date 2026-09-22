# 共享物理层（`src/phys`，crate `websurf-phys`）

> 本文是**共享层文档**（P2）的一篇，内容全部来自当前源码实测；锚点为「相对仓库根路径:行号」，由 `node src/scripts/check-doc-drift.mjs` 校验。
> 依赖方向与三工程关系见 `documents/architecture/overview.md`；TS 侧消费方见 `documents/ts-shared/overview.md`。

---

## 1. 定位与边界

`src/phys/` 是三个工程共用的 **CS 运动物理层**，以 Rust crate `websurf-phys` 形式提供（`src/Cargo.toml` 声明 `crate-type = ["rlib"]`、`[lib] path = "lib.rs"`）。

| 事实 | 依据 |
|---|---|
| 只有 `apps/debug` 与 `apps/game` 的 wasm crate 依赖它；**`apps/viewer` 不依赖**（viewer 无物理） | 三份 `apps/*/crates/wasm/Cargo.toml`；viewer 那份只声明 `websurf-wasm-core` |
| 对外边界是 `#[wasm_bindgen] impl PhysWorld`（`src/phys/mod.rs:111`），导出 **24 个 `pub fn`** | `src/phys/mod.rs` 的导出面 |
| 世界几何与碰撞、玩家运动、传送触发都在本层内实现，**不含** BSP 解析与渲染 | `src/phys/mod.rs:51` 起的 `pub mod player` / `pub mod teleport` / `pub mod world` |

## 2. 文件与职责

| 文件 | 职责 |
|---|---|
| `src/phys/mod.rs` | wasm-bindgen 绑定层：`PhysWorld` 实例、参数写入、状态导出、零分配支路、事件槽 |
| `src/phys/world.rs` | 世界几何与碰撞：brush / 三角网格双空间索引、射线与包围盒查询（`pub struct World`，`src/phys/world.rs:956`） |
| `src/phys/player.rs` | 玩家运动语义与参数结构（`pub struct PhysParams`，`src/phys/player.rs:171`；步进入口 `player_tick`，`src/phys/player.rs:1446`） |
| `src/phys/teleport.rs` | 传送触发与冷却（入口 `pub fn check`，`src/phys/teleport.rs:267`） |
| `src/phys/seed.rs` | 种子/确定性支持（私有模块，不对外导出） |
| `src/phys/p2_gate_tests.rs` | 门禁测试：P2 幽灵面一类的物理回归（`#[cfg(test)]`，`src/phys/mod.rs:61`） |
| `src/phys/duck_surf_tests.rs` | 门禁测试：蹲姿与 surf 相关语义（`#[cfg(test)]`，`src/phys/mod.rs:64`） |

## 3. 导出面（24 个 `pub fn`）

| 分组 | 导出 | 锚点 |
|---|---|---|
| 构造与世界装配 | `new`、`build_world` | `src/phys/mod.rs:157`、`src/phys/mod.rs:188` |
| 步进 | `tick`（返回状态对象）、`tick_into`（写固定缓冲，零分配） | `src/phys/mod.rs:251`、`src/phys/mod.rs:274` |
| 状态导出 | `state`、`state_full_json`、`state_out_ptr`、`set_state_ex`、`seed_from` | `src/phys/mod.rs:644`、`src/phys/mod.rs:327`、`src/phys/mod.rs:295`、`src/phys/mod.rs:314`、`src/phys/mod.rs:342` |
| 调试与门禁 | `gate_veto_count`、`debug_trace`、`predict` | `src/phys/mod.rs:351`、`src/phys/mod.rs:360`、`src/phys/mod.rs:437` |
| 玩家动作 | `respawn`、`teleport_to`、`teleport_to_spawn`、`set_spawn_points`、`set_state`、`set_velocity`、`set_yaw_pitch`、`set_death_y` | 同名导出（见 `src/phys/mod.rs` 的 `#[wasm_bindgen] impl` 段） |
| 参数与形态 | `set_params`、`set_hull`、`set_noclip` | `src/phys/mod.rs:553` 等 |
| 事件 | `take_event`（一次性取走最近事件） | `src/phys/mod.rs:658` |

## 4. 契约

### 4.1 参数（`set_params`）

`set_params` 接一个 JSON 补丁，反序列化到函数内的 `Patch` 结构体，**共 15 个可选字段**（`src/phys/mod.rs:553` 起的函数体）：

`gravity`、`accelerate`、`friction`、`stop_speed`、`jump_height`、`air_accelerate`、`run_speed`、`walk_speed`、`crouch_speed`、`autobhop`、`bhop_speed_clamp`、`sensitivity`、`yaw_bind_speed`、`noclip_speed`、`teleport_gate_ticks`。

而 `PhysParams` 结构体有 **18 个字段**（`src/phys/player.rs:171`）——多出的 3 个是碰撞箱三项（`hull_half_width`、`hull_stand_height`、`hull_duck_height`），它们只经 `set_hull` 写入，不在补丁键里。补丁里**缺的键保持原值**。

### 4.2 状态导出

| 出口 | 语义 |
|---|---|
| `state()` | 返回**新建** JS 对象，**固定 11 个键**：`posX/posY/posZ`（HU）、`yaw`/`pitch`（度）、`velX/velY/velZ`（HU/s）、`onGround`、`contactTicks`、`eyeHeight`（HU）；不含时间戳 |
| `state_js()` | 上面那个对象的唯一构造点（`src/phys/mod.rs:702`），同时供 `tick` / `predict` 复用 |
| `state_out_ptr()` | 返回固定缓冲 `state_out: [f64; 22]` 的 wasm 线性内存指针（字段声明 `src/phys/mod.rs:146`）；JS 侧以 `Float64Array` 视图直读，**不构造对象** |
| `state_full_json()` | 完整状态 JSON 出口（可含事件），供回放/诊断 |
| `set_state_ex()` / `seed_from()` | 由 JSON / 由另一个实例播种状态 |

**零分配支路的两个使用约束**（注释与 TS 侧一致）：① 缓冲按 **22 槽**读取，其中 0-7 由 `tick_into` 直写、其余由玩家/世界侧填充；TS 侧 `src/ts-shared/auth/tick-authority.ts` 按 22 槽建视图，而 `src/ts-shared/decoupled/decoupled-loop.ts` 只取前 8 槽；② wasm 内存增长后 `memory.buffer` 会更换，**视图必须按 `state_out_ptr()` 重建**，不得长期缓存。

### 4.3 事件

`take_event()` 一次性消费：同一事件不会被取到两次，未被取走的事件会被后续事件覆盖；返回 `{ kind: 'teleport', targetname, origin, yaw }` 或 `{ kind: 'death' }`。

## 5. 关键不变量

1. **两个实例互不共享可变状态**：同一 wasm 模块里的多个 `PhysWorld` 各自持有自己的 `World` / `Player`。
2. **传送的唯一写入口是内部方法**：落点、清零速度、离地、朝向、同步 `prev_origin`、复位冷却都在同一处完成，保证「传送后字段集」一致；`set_state` 一类的直接写入不经过它。
3. **地面判据是法线阈值**：`normal.y >= 0.7`（`src/phys/player.rs` 的 `STANDABLE_NORMAL`）；更陡的面按 surf 处理。
4. **时间推进由调用方驱动**：本层不做定时；固定步长、欠账排空都在 TS 侧 `src/ts-shared/auth/auth-loop.ts`。
5. **`teleport_gate_ticks` 当前不影响行为**：键可写、结构体有该字段，但 `src/phys/teleport.rs:267` 的 `check` 形参名为 `_gate_ticks` 且函数体从不读它。

## 6. 测试

`cargo test -p websurf-phys` 实测 **10 passed / 0 failed**，全部由两个 `#[cfg(test)]` 模块提供：P2 幽灵面一类的门禁回归（4 项），以及蹲姿与 surf 语义（6 项，对齐 Source 的 `CanUnduck`）。两个模块的声明分别是 `src/phys/mod.rs:61` 与 `src/phys/mod.rs:64`。

## 7. 已知遗留（如实登记，未改代码）

| 项 | 事实 |
|---|---|
| `set_yaw_pitch` | 在 `apps/**` 与 `src/**` 内**零调用点** |
| `predict` | 仅被 `apps/game/scripts` 下的两个脚本调用 |
| 零分配支路 | `tick_into` / `state_out_ptr` / `seed_from` 的调用方只有 `src/ts-shared/auth/tick-authority.ts` 与 `src/ts-shared/decoupled/decoupled-loop.ts`，而这两个控制器在三个工程内**都没有装配点**——线上路径走 `tick()` 返回对象 |
| `contactTicks` | 属调试/回归用计数，随 `state()` 一并导出 |
