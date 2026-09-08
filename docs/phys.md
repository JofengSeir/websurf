# 共享层①：websurf-phys（Rust 物理系统）

> 定位：仓库唯一的物理实现——CS 移动语义（走/跳/蹲/梯/滑坡）+ 凸 brush 与三角形网格扫掠碰撞 + 传送/死亡判定，
> 以 rlib 形式被 4 个 WASM 工程 re-export，在各自 Worker 中实例化为权威/预测物理。
> 本文所有论断均标注来源（`相对路径:行号` 或 `路径::函数名`），写作基线为当前工作区代码。

---

## 1. 整体架构

### 1.1 crate 身份与依赖

| 项 | 值 | 来源 |
|---|---|---|
| 包名/版本 | `websurf-phys 0.1.0`，`crate-type = ["rlib"]` | `src/Cargo.toml:2-12` |
| 根 workspace 成员 | `[workspace] members = ["src", "src/wasm-core"]`（全仓仅此两个 Rust crate 入 workspace） | `Cargo.toml:20-28` |
| 直接依赖 | `wasm-bindgen 0.2`、`js-sys`、`serde`、`serde_json`（无其他运行时依赖） | `src/Cargo.toml:13-17` |
| 入口 | `pub mod phys;` 单模块入口（crate 根共 12 行） | `src/lib.rs` |

### 1.2 模块地图（4 个实现文件 + 1 个回归测试）

| 文件 | 职责 | 关键类型/入口 |
|---|---|---|
| `src/phys/mod.rs` | wasm-bindgen 绑定层：组装 World + Player + TeleportManager，导出 21 个方法 | `PhysWorld`（`mod.rs:55`） |
| `src/phys/world.rs` | 世界碰撞容器：brush 凸体 + TriMesh 双表示、双均匀网格空间索引、扫掠求交；**纯计算，无 wasm-bindgen**（移植自 @unsurf/cs-movement 的 Collision.ts/World.ts/brush-grid.ts/triangle-grid.ts） | `World`（`world.rs:728`）、`BrushGrid`/`TriangleGrid`、`trace_box` |
| `src/phys/player.rs` | 玩家移动语义：原 16 个 TS 子模块合并单文件化；纯计算 | `Player`（`player.rs:132`）、`player_tick`（`player.rs:1011` 附近主入口）、`PhysParams`（`player.rs:59`） |
| `src/phys/teleport.rs` | 触发传送双路径检测 + 死亡判定 | `TeleportManager`（`teleport.rs:65` 附近）、`check`（`teleport.rs:172`）、`check_death`（`teleport.rs:361`） |
| `src/phys/p2_gate_tests.rs` | `cfg(test)` 回归：P2 坡顶幻影碰撞的盒-AABB 门校验 4 用例 | `p2_gate_tests.rs:1-103` |

### 1.3 线程模型与实例约定

- **Worker-A 权威 + Worker-B 预测各持一个 `PhysWorld` 实例**（同一 wasm 模块各自线性内存；输入输出经标量传值，无 SAB 直写）：crate 头注（`src/phys/mod.rs:1-9`）。
  权威实例跑固定步长 `tick`；预测实例走 `predict`/`set_state` 基线同步（见 §2）。
- 实例由**各消费工程的 cdylib re-export 后在 JS 侧构造**（`new PhysWorld()`），本 crate 不含任何 Worker/JS 编排代码——编排统一在共享 TS 层（见 [ts-shared.md](./ts-shared.md)）。
- 坐标约定：**Y-up**（与 glTF/渲染一致），brush 平面法线**朝外**，实体判定为 `dot(n,p) - dist <= 0`（`src/phys/world.rs:1-8`、`world.rs::clip_planes` 注释 `world.rs:157-158`）。BSP 的 Z-up→Y-up 映射在解析/导出层完成（见 [wasm-core.md](./wasm-core.md)），物理端只消费已映射数据。

### 1.4 被引用关系（grep `pub use websurf_phys` 实测）

| 消费工程 | 引用方式 | 证据 |
|---|---|---|
| debug | `pub use websurf_phys::phys::PhysWorld;`（cdylib 顶层 re-export） | `debug/crates/wasm/src/lib.rs:22` |
| game | 同上 | `game/crates/wasm/src/lib.rs:23` |
| test/dual-mode-harness | 同上 | `test/dual-mode-harness/crates/wasm/src/lib.rs:35` |
| test/instanced-diorama | 同上（仅 Rust 侧声明 re-export；其 TS 运行时未调用 PhysWorld） | `test/instanced-diorama/crates/wasm/src/lib.rs:23` |
| viewer | **不依赖**（Cargo.toml 无 `websurf-phys`，查看器无物理） | `viewer/crates/wasm/Cargo.toml`（deps 仅 websurf-wasm-core）；`viewer/crates/wasm/src/lib.rs:1-9` 头注 |

依赖关系声明（各工程 `crates/wasm/Cargo.toml` 的 `path = "../../../src"`）与总览矩阵另见 [ts-shared.md](./ts-shared.md) §4。

---

## 2. 核心时序

### 2.1 构建时序：`build_world`

`PhysWorld::build_world(brush_json, tri_json, teleport_json, spawn_x, spawn_y, spawn_z, yaw)`（`src/phys/mod.rs:103`）五步：

1. **brush JSON → World**：`parse_brushes`（`mod.rs:587`）解析紧凑 `WasmBrush{planes,min,max,is_ladder,is_solid}`；`is_ladder` 走 `compute_ladder_facing`（`mod.rs:648`，取水平分量最大的平面法线归一为攀爬朝向）入 `world.ladders`，`is_solid` 入 `world.solids`（`mod.rs:126-137`）。
   数据来源：消费工程 `BspProcessor::export_brushes_planes` 产出的 Y-up/法线朝外 brush JSON（`debug/crates/wasm/src/lib.rs` / `game/crates/wasm/src/lib.rs:1671`），主线程经 ts-shared world-builder 汇入 `WorldBundle` 后以 `world-json` 消息送达 Worker（见 [ts-shared.md](./ts-shared.md) §2）。
2. **tri JSON → `world.tri_meshes`**：`parse_tri_meshes`（`mod.rs:623`）解析 `TriMesh{vertices,indices,min,max}`（模型碰撞三角形，空串 = 空）。
3. **建空间索引**：`world.build_index()`（`mod.rs:144`，实现 `world.rs:748-753`）。
4. **teleport**：`TeleportManager::from_json`（`mod.rs:147`；解析 `teleport.rs:79`）。
5. **出生点 + 玩家**：`create_player(spawn, params)`、`player.yaw = spawn_yaw`、`ready = true`（`mod.rs:151-156`）。

### 2.2 每 tick 步进：`step_core`（`src/phys/mod.rs:222`）

`tick` / `tick_into` 共用核心，顺序固定：

1. **输入应用**：`apply_input(mask)`（`mod.rs:545`）把 11 位键掩码转 `InputState`（0x01 前/0x02 后/0x04 左/0x08 右/0x10|0x100 跳——滚轮跳并入 jump/0x20 蹲/0x40 走/0x80 reset/0x200|0x400 Q·E 转向）；鼠标增量 `yaw -= dx·(sensitivity·M_YAW)`、`pitch` 钳 ±89°（`mod.rs:225-231`）。Q/E 不在 Rust 内旋转——JS 输入层已折算成等效鼠标像素走同一通道（`mod.rs:230-232` 注释；实现见 [ts-shared.md](./ts-shared.md) `input-layer.ts`）。
2. **noclip 分支**：`noclip_step`（`mod.rs:560`）自由视角直移（`noclip_speed`，Shift×4），无碰撞。
3. **正常分支**（`mod.rs:234-271`）：
   - `teleport.check(...)`（参数含 `contact_ticks`、`surfing`、身体高 `maxs()[1]`）命中 → `PhysEvent::Teleport` 暂存 + `apply_teleport`（置 origin/清速度/离地）+ `teleport.on_teleported()` + 冷却重置；
   - `check_death(origin, death_y, spawn)`（`teleport.rs:361`）→ `PhysEvent::Death` + `player.respawn(spawn)`；
   - reset 键 → `player.respawn(&self.spawn)`；
   - `player_tick(&mut world, &mut player, &params, dt)`（§3.2）。

### 2.3 三个状态出口

| 出口 | 语义 | 实现 |
|---|---|---|
| `tick(dt,mask,dx,dy) -> JsValue` | 权威一步，返回状态对象（posX…eyeHeight/contactTicks 共 11 键） | `mod.rs:160`、`state_js`（`mod.rs:501`） |
| `tick_into(dt,mask,dx,dy)` | **零分配热路径**：同语义步进后把 pos×3/vel×3/yaw/pitch 写入固定缓冲 `state_out:[f64;8]`；JS 经 `state_out_ptr()` 建 `Float64Array` 直读线性内存，再原子写 SAB——每子步零 JS 对象分配。wasm 内存增长后须按新 `state_out_ptr` 重建视图 | `mod.rs:179-200` |
| `predict(dt,mask,dx,dy)` | Worker-B 预测微步：与 `tick` 同输入/角度/移动，但**禁用传送与死亡副作用**（`teleport.check` 传入 `predict=true` 直接返回 None；不判死亡） | `mod.rs:275-295`、`teleport.rs:182-184` |

预测基线同步：`set_state(pos,yaw,pitch,vel,on_ground)`（`mod.rs:325`，不重置速度/着地以延续运动）、`set_velocity`（只拟合速度防位置跳变，`mod.rs:347`）、`set_yaw_pitch`（Q/E 时序分叉软校准，`mod.rs:354`）。消费侧协议见 [ts-shared.md](./ts-shared.md) §3（authority-calibrator）。

### 2.4 事件出口：`take_event`

`PhysEvent::{Teleport{targetname,origin,yaw}, Death}`（`mod.rs:44-52`）每步至多暂存一个，`take_event()` 一次性取走（`mod.rs:460`）。**消费方是主线程的预测实例**：debug 渲染物理线每 tick 后 `predPhys.take_event()`（`debug/src/renderer/renderer-main.ts:901`，类型 `RenderPhysEvent`），喂给计时挑战状态机（检查点/死亡统计，`debug/src/app.ts:262`、`:1467`——注释明示「主线程消费，权威侧不消费」）。权威 Worker 侧不读此通道：land/blocked 由 TS 层 auth-loop 从权威状态差分推导（`auth-loop.ts:160-189`），传送/重生由主线程消息直接驱动（`worker-dispatch.ts` `teleport`/`respawn` 分支）。

---

## 3. 具体实现

### 3.1 世界与碰撞（`src/phys/world.rs`）

**数据模型**：`Plane{n,d}`（`world.rs:18`）、`Brush{planes,min,max}`（`:25`，凸体 = 平面半空间交集 + 预算 AABB）、`LadderVolume{planes,min,max,facing}`（`:34`）、`TriMesh{vertices,indices,min,max}`（`:44`）、`TraceResult{fraction,end_pos,normal,start_solid,all_solid}`（`:53`）。

**扫掠求交核心 `clip_planes`**（`world.rs:159`，对应原 CS `clipBoxToBrush` 循环）：

- Minkowski 扩张：`dist -= plane_offset(normal, mins, maxs)`（按平面法线符号取盒半边投影和，`world.rs::plane_offset`）；
- 进入/离开分数：`f = (d1 - DIST_EPSILON)/(d1 - d2)`，`DIST_EPSILON = 0.03125`（`world.rs:113-114`，注释「与 Collision.config.ts 的 DIST_EPSILON 一致」）；
- **平行/贴面守卫**：`d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1 || d1 - d2 < 1e-6)` 直接返回，防浮点噪声把物体钉在平面上（`world.rs:186-191` 注释）；
- **P2 盒-AABB 门校验**（`aabb_overlaps_at`，`world.rs:136`）：在**真实接触分数** `f_true = d1/(d1-d2)`（盒表面恰贴平面）处判盒 AABB 与实体 AABB 三轴重叠（容差 `EPS = DIST_EPSILON/8`），不重叠即判为无限平面造成的幻影进入，**仅否决该平面**（保留更晚的真实接触，避免整实体否决穿模）；起点判内（`start_solid`）同样过此门（`world.rs:220-234`）。否决计数器 `GATE_VETO_COUNT: AtomicU32` 供 `PhysWorld::gate_veto_count()` 诊断（`world.rs` 常量区、`mod.rs:203`）。设计文档：`docs/archive/chamfer-physics/`（背景材料）。

**空间索引**（`BrushGrid` `world.rs:517` / `TriangleGrid` `:615`）：均匀网格（brush 格边 512、tri 格边 256，`World::build_index` `world.rs:748-753`）+ epoch 去重 + **大对象兜底**（跨越格数 span 超限者进 `push_big` 列表，查询时并入候选：`world.rs:475-482`（push_big）、`:692`（query_entries 去重合并））。

**查询入口**：

- `World::trace(start,end,mins,maxs)`（`world.rs:755`）：按扫掠包围盒（±1 pad）收集 brush 与 tri 候选，`trace_box` 与 `trace_box_tri_entries` 分算，**取 fraction 更早者**（`world.rs:778-781`）；
- `World::is_position_free`（`world.rs:786`）：静止盒无交判定（蹲/站切换可行性用）；
- `World::ladder_at`（`world.rs:816`）：返回梯子索引 `Option<usize>`（避免热路径克隆 LadderVolume，`player.rs:142-144` 注释）。

### 3.2 玩家移动（`src/phys/player.rs`）

**常量表**（`player.rs:16-53`）：`STANDABLE_NORMAL=0.7`、`GRAVITY=800`、`RUN_SPEED=250`、`WALK_SPEED=130`、`CROUCH_SPEED=85`、`AIR_ACCELERATE=150`、`AIR_SPEED_CAP=30`、`OVERBOUNCE_SURF=1.0`/`OVERBOUNCE_DEFAULT=1.001`、`M_YAW=0.022`、`PITCH_CLAMP=89`、hull 半宽/站高/蹲高 `16/72/54`、`EYE_STAND=64.09`、`EYE_DUCK=46.04`、`DUCK_LERP_TIME=0.1`、`JUMP_HEIGHT=57`、`BHOP_MAX_SPEED_FACTOR=1.1`、`LADDER_SPEED=200`、`LADDER_JUMP_OFF_SPEED=270`、`STEP_HEIGHT=18`、`MAX_CLIP_PLANES=8`、`PUSH_OUT=0.1`、`NON_JUMP_VELOCITY=180`、`GROUND_TRACE_DIST=2`。
运行时可调项在 `PhysParams`（`player.rs:60`）：默认 `autobhop=true`、`bhop_speed_clamp=true`、`no_prestrafe=true`、`teleport_gate_ticks=3`（现 check 不再使用，仅签名兼容，`teleport.rs:176`）、`noclip_speed=800`、`sensitivity=1.5`（TS 层 `set_params` 时固定传 1，见 [ts-shared.md](./ts-shared.md) §3 params）。

**基础公式**（`player.rs:262-345`）：

- `accelerate`：地面加速，`addspeed = wishspeed - dot(vel, wishdir)` 决定地速上限；
- `air_accelerate`：**刻意不对称**——`addspeed` 用钳到 `AIR_SPEED_CAP` 的 wishspeed，`accelspeed` 用未钳 wishspeed（bhop/surf 增速核心，`player.rs:281-302`）；
- `apply_friction`：只消耗水平分量，`control = max(speed, stopspeed)`；
- `clip_velocity`：沿平面滑行；`overbounce_for`（`player.rs:338`）：法线 y∈(0.05, 0.7)（斜面）取 `OVERBOUNCE_SURF=1.0` 保留速度，其余 `1.001` 防重穿；附 CS:GO 二次修正步清残留法向分量（`player.rs:328-334`）。

**主流程 `player_tick`**（`player.rs:1009` 起；主体步骤 `:1013-1039`，收尾杂项 `:1040-1057`）：

1. `ladder_cooldown` 递减 → `update_duck`（`player.rs:569`：空中蹲**从脚部往上缩** origin 上移 18 并以 `is_position_free` 守卫；地面起立头顶被挡则保持蹲）；
2. `check_stuck`（卡住推出 `PUSH_OUT`）失败则跳过本帧移动；
3. `check_ladder`（`player.rs:605`：冷却中不上梯；空中必抓，地面需 forward 且视线与梯面朝向点积 > 0.3）命中 → `ladder_move`（`player.rs:628`：完整 3D 视角基攀爬、双轴输入不归一化、上限 `LADDER_SPEED×√2`、垂直墙分量重定向到攀爬方向；jump 跳离 = facing×`LADDER_JUMP_OFF_SPEED` 270 + 冷却 0.25s）；
4. 否则 `check_jump`（`player.rs:536`：`jump_velocity = sqrt(2·g·jump_height)`；非 autobhop 时要求落地新按（`old_jump` 边沿）；`bhop_speed_clamp` 时起跳水平速钳 `1.1×maxspeed`）→ 在地 `walk_move` / 空中 `air_move`（空中先记 `fall_velocity`）；
5. `categorize_position`（贴地/离地归类，`GROUND_TRACE_DIST=2`）；
6. 尾部杂项：`detect_blocked_move`、落地冲击 `land_punch` 衰减、`old_jump = input.jump` 边沿记录、**duck_frac 插值**（空中/落地 tick 即时置位、地面按 `DUCK_LERP_TIME=0.1s` 渐变）。

视角高度 `Player::eye_height`（`player.rs:193`）：按 `duck_frac` 在 `EYE_STAND`(64.09)/`EYE_DUCK`(46.04) 间插值，站/蹲箱高不同比例换算——空中蹲视角自然连续无跳变（`player.rs:191-197` 注释）。

### 3.3 传送与死亡（`src/phys/teleport.rs`）

- **数据**：`from_json`（`teleport.rs:79`）解析 `WasmTeleportReport` → `TeleportDestination`（origin/yaw）与 `TeleportTrigger`（`model_planes:[nx,ny,nz,dist]` 凸包平面 + `model_mins/maxs` AABB 兜底、`spawnflags`、`dest_index` 按 targetname 关联；孤儿触发器（无目标）跳过，`teleport.rs:120-153`；`TeleportManager` 结构 `teleport.rs:71`）。
- **yaw 换算**：`bsp_yaw_to_cs_yaw = wrap(bsp_yaw + 180.0)`（`teleport.rs:31-38`，t2 统一口径；旧式 (270 - bsp_yaw) 为 det=−1 镜像已废弃）。
- **双路径检测 `check`**（`teleport.rs:172`，头注 165-171 为设计定调）：
  - 前置否决：`predict` 不检测；冷却（`TRIGGER_COOLDOWN=0.5s`，`teleport.rs:18`）中不检测；**surfing（贴坡滑行）不触发**；
  - spawnflags 过滤：仅认 Clients(0x01)/Everything(0x40)，**显式 0 视为默认全客户端**（`teleport.rs:199-202`）；
  - **A 路径 `in_trigger_zone`**（`teleport.rs:315`）：竖直线段 [脚底, 脚底+body_top] 与凸包求交——竖直平面做 XZ 内侧约束，水平/斜平面解出 y 区间；**gap = 落地且站在斜面时脚底允许高出凸包顶 `TRIGGER_FACE_GAP=64`**（覆盖跨斜面 origin 提升；空中/平面 gap=0 严格相交，`teleport.rs:300`、`311-314` 注释）；
  - **B 路径 `probe_below_foot`**（`teleport.rs:241`）：落地时脚底往下 `FOOT_PROBE_DEPTH=8` 区间与 trigger AABB 相交即触发（落地是启用条件，非触发本身）。
- **死亡**：`check_death`（`teleport.rs:361`）：`pos.y < death_y` → 返回出生点（默认 `death_y = -100_000.0`，`mod.rs` 结构定义；`set_death_y` 可改，`mod.rs:360`）。

### 3.4 回归测试（`src/phys/p2_gate_tests.rs`）

4 个 `cfg(test)` 用例针对 §3.1 的盒-AABB 门校验：坡顶端盖幻影被否决、斜面合法落地保留、`start_solid` 幻影否决、悬停滑行边缘幻影否决；场景与 `game/scripts/phys-p2-regression.mjs` 的 64Hz、H=2.5、vz=300 复现参数一致（`p2_gate_tests.rs` 文件头注与各用例）。

---

## 4. 核心差异与边界

### 4.1 与消费工程的边界

- **本 crate 不含 wasm-bindgen 导出层以外的任何工程逻辑**：GLB/解析归 [wasm-core.md](./wasm-core.md)，Worker 编排/输入/SAB 归 [ts-shared.md](./ts-shared.md)。各工程 cdylib 一行 `pub use websurf_phys::phys::PhysWorld;` 即获得同一物理（§1.4 证据行）。
- **brush/tri 数据由消费工程的 `BspProcessor` 导出**：`export_brushes_planes`（brush JSON）、`export_model_tri_colliders`/`export_model_phy_colliders`（模型三角形/凸包 JSON），`build_world` 只消费 JSON 字符串（`mod.rs:103` 签名）。`mod.rs:81` 头注提到的 `collect_phys_brushes` 为历史名称，现库中不存在——现名即各工程 `export_brushes_planes`（`game/crates/wasm/src/lib.rs:1671`）。
- **五个模块 crate 有意不进根 workspace**（均需同名 `websurf-wasm`，见根 `Cargo.toml:5-18` 头注），但都经 path 依赖共享本 crate，构建共享根 `target/`（`.cargo/config.toml:12-13`）。

### 4.2 与 ts-shared 的接口契约

`PhysWorld` 以**结构化类型**（无需 trait）满足 `auth-loop.ts` 的 `PhysWorldLike` 接口（`src/ts-shared/auth/auth-loop.ts:19-50`）：`state/tick/build_world/set_params/set_hull/set_noclip/set_state/respawn/teleport_to_spawn/teleport_to/set_spawn_points/set_death_y`——方法名与 §1.1 的 21 个导出一一对应（camelCase 由 wasm-bindgen 自动转换）。

### 4.3 与 dual-mode-harness 的关系

harness 的双模物理（WorkerA 内两个 PhysWorld 实例 + `set_velocity` 速度校准通道）完全构建在本 crate 的 `tick/set_state/set_velocity` 原语上，不改动物理本身；其私有 SAB 协议（192B）与 ts-shared 权威帧协议（512B）是两套并存方案，对照见 [ts-shared.md](./ts-shared.md) §4.3 与 `test/dual-mode-harness/docs/`（另篇）。

### 4.4 已知口径偏差

- `src/phys/mod.rs:4` 头注称"导出 12 个 API"，为早期口径；实际 `#[wasm_bindgen]` 导出方法 **21 个**（`mod.rs:84-460` 逐个 `pub fn`）：`new/build_world/tick/tick_into/state_out_ptr/gate_veto_count/debug_trace/predict/respawn/teleport_to/set_spawn_points/teleport_to_spawn/set_state/set_velocity/set_yaw_pitch/set_death_y/set_params/set_hull/set_noclip/state/take_event`。本文以代码实测为准。
- `teleport_gate_ticks` 参数仍存在于 `PhysParams` 与 `set_params`，但 `TeleportManager::check` 已不使用（仅签名兼容，`teleport.rs:176` `_gate_ticks` 下划线参数）。
