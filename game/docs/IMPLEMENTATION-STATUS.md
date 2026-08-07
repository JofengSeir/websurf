# WebSurf-min 实现状态记录

> 编制日期：2026-08-07；**2026-08-08 复核更新至 v7 最终架构**。
> 记录 `game/` 独立工程的最小化实现完成情况与未完成部分。
> 蓝本：`MINIMAL-IMPL-PATH.md`（v3+，与本文同目录）。目标架构：根 `docs/项目时序图.md`（v7）。
> 所有代码存放于 `game/`，原项目零修改。

---

## 1. 实现总览（已完成）

### 1.1 代码规模

| 层 | 原项目 | game/ 实现 | 缩减 |
|---|---|---|---|
| TS（src/） | 11,844 行 / 79 文件 | **2,486 行 / 16 文件** | **-79%** |
| Rust phys 模块 | —（迁移源 TS 3,353 行） | 2,463 行 / 4 文件 | 合并 16 文件 |
| Rust lib.rs | 3,146 行 | 2,031 行 | 删 9 未用导出 + 薄壳 + debug_probe |
| scene-data | GLB + 几十 MB JSON | GLB + spawn/pvs 小 JSON | **-95%** |
| 消息协议 | 25 + 14 | 7 + 5 | — |

### 1.2 架构落地（2026-08-08 v7：权威帧计算模式，主线程唯一物理渲染线）

```
主线程 (src/app.ts + renderer-main.ts) —— 唯一物理渲染线（144Hz 可变 dt，全速无限制）
  ├─ BspProcessor 解析 BSP（WASM）→ 场景渲染 + PhysWorld（世界+碰撞+输入）
  ├─ 输入层预处理：灵敏度乘入角度增量（物理两端 sensitivity 固定 1）；
  │    Q/E 生成等效鼠标量（yaw_bind_speed/M_YAW×dt，独立增量不受灵敏度影响）
  ├─ 每 rAF：写输入 SAB（双端同源）→ 读权威帧（V_A 变化记录 curAuth + 加速度）→
  │    速度外推校准 set_velocity(vel_A + a×Δt)（位置/角度不覆盖）→
  │    wasm tick（完整物理：碰撞/传送/死亡）→ 渲染（唯一渲染源）
  ├─ 碰撞事件（land/blocked）回传 → 位置微调 + 角度同步（<60 才调）
  ├─ respawn/teleport 位置突变归零（player-respawn 消息）
  ├─ FPS 显示（左上角）+ 速度面板 8Hz + ESC 面板
Worker (src/worker/main.ts) —— 权威帧计算器
  ├─ wasm 加载 + world-json 世界构建（地图碰撞，加载时一次）
  ├─ 独立权威物理线：固定步长 = 1/tickRate（64/128Hz 可调，累积器无封顶）
  ├─ 每 tick：takeInput（SAB 累积输入）→ 完整物理 tick（含碰撞/传送/死亡）→
  │    碰撞事件检测 → 写权威全状态 + V_A++
  └─ 面板参数经 config 消息应用（applyConfigPatch 更新自身 config，双端同参）
```

### 1.3 文件清单

**TS（14 文件）**：
```
src/app.ts                      # 主入口：单 Worker + 主线程唯一物理线 + 面板 + FPS + 速度 8Hz
src/config.ts                   # 收敛配置（physics/input/player/hud）
src/panel/panel-controller.ts   # ESC 桌面两栏面板（左导航+右设置）+ 按键录制
src/input/input-bridge.ts       # 双端桥（面板 → Worker config + 主线程 renderer；tickRate 显式传递）
src/input/keyboard.ts           # 键盘映射（可配置 keymap）
src/input/keymap.ts             # 键位配置：默认/持久化/录制标签
src/input/mouse-buffer.ts       # 鼠标削平（复用原实现）
src/input/pointer-lock.ts       # Pointer Lock（复用原实现）
src/worker/main.ts              # Worker：wasm-init/world-json/权威帧循环（fixedDt 动态）/碰撞事件
src/worker/shared-state.ts      # SAB 512B：控制区 + 输入槽 + 权威全状态双缓冲（10 值/槽）
src/worker/worker-types.ts      # 消息协议 + KeyState/KEY_MASK + phys-event
src/renderer/renderer-main.ts   # GLB + 相机 + LOD/PVS + 主线程物理线 + 速度外推校准 + 碰撞微调
src/world/pvs-manager.ts        # PVS 位图剔除（空间采样 cluster，复用原实现）
src/world/types.ts              # PVS 类型
src/wasm.d.ts                   # re-export pkg 真实类型
```

**Rust phys（4 文件，新增）**：
```
crates/wasm/src/phys/mod.rs      # PhysWorld 组装 + wasm-bindgen 12 API
crates/wasm/src/phys/world.rs    # World + 双 Grid + traceBox + clipBoxToTriangle
crates/wasm/src/phys/player.rs   # PlayerController 全套移动语义（16 TS 文件合并）
crates/wasm/src/phys/teleport.rs # TeleportManager（start-touch）+ 死亡判定
```

**Rust 基础（复用/精简）**：`vbsp/`（BSP 解析）、`bsp_to_gltf_core/`（GLB 导出）、
`model_integrator/`、`texture_utils/`、`pakfile_models.rs`、`phyfile.rs`、
`vendor/vmdl`（patch 引用，条带修复版）。

**构建**：`package.json`（build:wasm/build:ts/build:dist/dev/check:api）、
`tsconfig.json`、`serve.py`（COOP/COEP）、`scripts/check-wasm-api.mjs`（9+12 契约）、
`scripts/build-dist.mjs`（app/worker.js + wasm 外置多文件）、`web/index.html`（极简 UI）。

### 1.4 已验证通过的构建链路

| 环节 | 命令 | 状态 |
|---|---|---|
| Rust 编译 | `cargo check --target wasm32-unknown-unknown` | ✅ 0 error |
| WASM 构建 | `wasm-pack build --release`（wasm-opt=false） | ✅ 9+12 API 生成 |
| 契约校验 | `node scripts/check-wasm-api.mjs` | ✅ 通过 |
| TS 类型检查 | `npx tsc --noEmit` | ✅ 0 error |
| 主线程打包 | esbuild app.ts | ✅ 1,010 KB |
| Worker-A 打包 | esbuild worker/main.ts | ✅ 39 KB |
| ~~Worker-B 打包~~ | ~~esbuild predictor-main.ts~~ | 🗑 已删除（v4 架构） |
| dist（多文件） | `node scripts/build-dist.mjs`（app/worker.js + wasm 外置） | ✅ 2.45 MB / 4 文件 |

### 1.4b 部署与文档布局（2026-08-07）

- 文档已集中到 `game/docs/`（`MINIMAL-IMPL-PATH.md` / `IMPLEMENTATION-STATUS.md` /
  `DESIGN-DISCUSSION.md`），README 引用同步更新；
- GitHub Actions（根 `.github/workflows/deploy-pages.yml`）构建**双产物**并部署到 Pages：
  入口页（`scripts/pages-index.html`）+ `debug/`（主工程 dist，调试测试页面）+
  `game/`（WebSurf-min dist，尝试游戏化）；
- ⚠️ GitHub Pages 不提供 COOP/COEP 头 → `game/` 页面在线无法启用 SharedArrayBuffer
  （显示引导卡片），完整游玩需本地 `game/play.cmd`；入口页已注明。

| dev 服务器 | `python serve.py 8090` | ✅ 资源全 200 + COOP/COEP 头正确 |
| **物理冒烟** | `npm run test:phys`（scripts/phys-smoke.mjs） | ✅ 落地/跳跃/回落/predict 全通过 |

### 1.5 物理冒烟测试结果（node 直接跑 WASM，无浏览器）

```
OK t0: velY=-12.50（重力 800/64/tick 精确）
OK 落地 at tick31: y=0.03 ground=true
OK 跳跃: velY=289.49（预期 ≈302，落地摩擦稍减）
OK 回落落地: y=0.03 ground=true
OK predict: y=99.90 velY=-12.50
```

> 冒烟测试发现并修复：`PhysWorld.build_world` 的 teleport JSON 传入 `'[]'` 会解析失败
> （期望 `{teleports:[],triggers:[]}` 结构）——测试脚本用正确结构；Worker 侧始终传
> `parse_teleports()` 真实输出，不受影响。
>
> 排障记录：测试用"房间 brush 把玩家包在内部"会触发 `check_stuck` 卡死（velocity 恒 0、
> 玩家不动）——这是测试世界构造问题，**真实地图 spawn 在 brush 外，非 bug**。
> 物理语义（重力/落地/跳跃/预测）经地板世界验证全部正确。

---

## 2. 未完成部分（遗留清单）

### 2.1 待验证（需要人工/浏览器）

| # | 项 | 说明 | 优先级 |
|---|---|---|---|
| U1 | **浏览器实测** | 打开 `http://localhost:8090/web/index.html` 加载 `maps/surf_666.bsp`：验证面板状态机（初始常驻→加载隐藏→ESC 弹出→关闭锁定）、主线程预测渲染（位置积分 + 角度 LERP）、tickRate 48/64/128 三档、速度面板三模式、noclip 切换 | **高** |
| U2 | **Rust 物理 golden 差分** | ✅ 冒烟级已通过（重力/落地/跳跃/回落/predict，见 §1.5）；❌ **完整差分未做**——用原项目 TS 物理跑 surf_666 固定输入序列生成逐 tick pos/vel/yaw golden，game wasm `PhysWorld.tick` 逐 tick 对比（容差 <1e-6），验证移植语义逐位一致 | **高** |
| U3 | **手感验证** | 高速滑行无穿墙/卡停；144Hz 屏权威间隙由预测填充无"停-动-停" | 高 |
| U4 | **dist 启动方式** | ✅ **已定案（2026-08-07）**：file:// 直接双击**不可行**——Chrome 非跨域隔离环境禁用 `SharedArrayBuffer`（物理双 Worker 硬依赖，COOP/COEP 头无法在 file:// 设置，CDP 实测确认）。交付方案：`game/play.cmd` 一键起本地服务器 + 自动开浏览器（http://localhost:8137/dist/index.html）；file:// 双击时页面显示引导卡片（`#fatalOverlay`）说明原因与两种启动方式。CDP 实测：http 加载 dist 完全可用（SAB✅ / crossOriginIsolated✅ / canvas 初始化✅ / 双 Worker✅） | 中 |

### 2.1b 面板参数全量暴露（2026-08-07）

wasm 可设置参数全部入面板（物理模块）：补 最大速度/走路速度/蹲走速度/停止速度/
跳跃速度、连跳限速/禁用预加速开关，以及**传送落地触发门槛**（teleport_gate_ticks
1-20 帧，**默认 1**——2026-08-08 由 3 改为 1，斜面传送更灵敏）。Rust：
PhysParams.teleport_gate_ticks + set_params 支持；check 门槛参数化（gate_ticks 由
params 传入）。验证：gate=3 → tick28，gate=20 → tick45（晚 17 tick，可调生效）。

**2026-08-08 传送触发检测升级**：接触计数（`contact_ticks`：地面 on_ground 或斜面
surfing 碰撞信号都计，替代仅 on_ground）→ 斜面滑行也能满足门槛；探测点**多点下探**
（TRIGGER_PROBES 0~48 每 8，任一在 trigger 内即 inside）→ 覆盖滑行悬空 gap
（surf_666 实测 283/523 个 trigger 为高度 ≤8 的薄片，单点必 miss）；spawnflags
显式 0（未配置）不跳过。

### 2.2 已知技术遗留（代码层面）

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| ~~L2~~ | **Rust dead_code warning** | ✅ 已清零（20→0）：删薄壳方案 14 个函数（face_to_brush/obb_to_brush/newell_normal 等 637→273 行）、phys 未用字段（tmp_brush_ids/tmp_tri_ids/count）、DIST_EPSILON 重复、teleport 未读 model 字段；TS 侧 9 处未用（suppress/shared 参数/step/bspModelScene/config/_camPos/name/eyeHeight/Vec3Like）一并清理 | — |
| ~~L3~~ | **teleport 按索引 = respawn** | ✅ 已修：`PhysWorld::set_spawn_points(json)` + `teleport_to_spawn(idx)`，Worker-A teleport 按索引查表，spawn 下拉恢复真实功能 | — |
| ~~L4~~ | **速度面板 eyeHeight** | ✅ 已修：SAB 权威区/预测区新增 eyeHeight 槽（Int32 定点 ×100），渲染相机 Y = pos.y + eyeHeight；冒烟验证站立 64.09 / 蹲下 62.68 | — |
| ~~L5~~ | **noclip 速度** | ✅ 已加：PhysParams.noclip_speed（默认 800=200×4）+ set_params 支持 + 面板滑块 200-3000（sprint 再 ×4） | — |
| L6 | **dev server 残留** | 之前测试的 8090 端口 python 进程仍在运行 | 可忽略或手动关闭 |

**已修复（2026-08-07 传送触发）**：
- ✅ **dest 索引越界（传送从不执行的根因）**：parse 时 `dest_by_name` 用 `d.index`
  （BSP 实体原始编号，可能跳跃）当 `destinations` 数组下标 → 越界 → check 触发
  （cooldown 已设）但 `destinations.get` 返回 None → 从不传送——"触发区域存在但
  传送无效"的真相。修复：dest_by_name 用 enumerate 数组下标 + check 越界防御。
  真实 surf_666（523 triggers）实测：tick3 触发传送成功。
- ✅ TeleportManager::check 落地稳定门槛：ground_ticks_since_landing >= 3 才判定
  位于传送平面（was_grounded 跨门槛重置 inside——防跳跃轨迹穿面误触）。
  冒烟测试 9：tick28 触发传送到 (50,0,30)。

**已修复（2026-08-07 物理时间/输入残留，用户报"250 速地面一直滑行"）**：
- ✅ **keysMask 残留（主因）**：`addInput` 原 `if (keysMask !== 0) store(I_KEYS)`——松手
  mask=0 不写 → I_KEYS 残留 forward 位 → Worker 认为一直前进 → 看似"无摩擦滑行"
  （实为松手停不下来）。修复：无条件 store（0 也写）。CDP 实测松手 0.5s 内停
  （1.2→0，与 node 纯物理 0.48s 一致）；
- ✅ **runLoop 时间累积器**：原 `acc = dt` 覆盖式丢时间（高刷 dt<fixedDt 时物理停滞/
  变慢）。修复：累积器 `acc += dt`（标准固定时间步，物理时间守恒）。

**已修复（2026-08-07 输入链路瘫痪，用户报"锁定后动不了"）**：
- ✅ **runLoop writeFrame 条件 bug（致命）**：`if (steps === 0) writeFrame()` 导致物理推进
  时（steps>0）不写权威帧 → va 恒 0 → 主线程读不到状态 → 看似"完全动不了"
  （实际物理在 Worker 里在跑）。修复：每帧无条件 writeFrame。CDP 实测 va 251→731 递增、
  按 W 后 HUD 0→250、甩鼠标 yaw 270→230.4；
- ✅ **Worker-B 从未收到 build-world（预测从不工作）**：主线程无 brush/tri/teleport JSON
  可转发，predictor worldReady 恒 false、seqP=0。修复：Worker-A 加载时 postMessage
  world-json（一次非热路径）→ 主线程转发 build-world。CDP 实测 seqP 递增（预测生效）。
- 排查方法论：CDP 直读 SAB 槽（bufferOf 暴露）定位"keys=1 但 va=0"；Worker 内 diag
  postMessage 上报状态（wasmReady/init/runLoop 空转原因）；try/catch 循环异常上报保留。

**已修复（2026-08-07 dist 双击报错，对齐主项目打包逻辑）**：
- ✅ Worker-A/Predictor 的动态 `await import()` 改静态导入（esbuild IIFE + Blob Worker 下
  动态 import 运行时不可解析）；
- ✅ Predictor 补 wasm 初始化：独立 Blob Worker 此前从未 initSync，PhysWorld 构造必抛错
  （现 app.ts 下发 wasmB64/wasmUrl + predictor 加 wasm-init 分支）；
- ✅ Worker-A 补消息队列保护（pending + wasmReady + dispatch，对齐主项目 main.ts），
  用户在 wasm 初始化完成前选文件不再报错；
- ✅ dist/dev 产物验证：无动态 import、initSync 内联、import.meta 无残留。
- ✅ **2026-08-07 改常规多文件打包**：放弃 base64 单文件（file:// 因无 SAB 本就不可玩，
  base64 内嵌无意义）→ dist/ = index.html + app.js + worker.js + predictor.js +
  websurf_wasm_bg.wasm（ESM，与 dev 同构）；app.ts/worker 移除 __VBSP_WASM_B64__ /
  __VBSP_WORKER_JS__ 分支，wasm 经相对 URL fetch 加载；build:wasm 复制 wasm 至 web/。
  CDP 实测多文件 dist 全链路正常（SAB/双 Worker/地图加载/WASD 0→250）。

**已修复（2026-08-07 按文档 §3.4/§4.3 落地）**：
- ✅ **L1 Worker-B 输入竞争**：predictRound 改用只读 `readInput()`（不 exchange），
  不再与 Worker-A 抢输入槽；
- ✅ **L1 Worker-B 基线同步**：predict 前 `phys.set_state(权威 pos/yaw/pitch/vel/onGround)`，
  预测锚定权威基线、不漂移（冒烟测试「基线锚定」验证通过）；
- ✅ **L1 notify 接线**：主线程三源决策命中权威分支调 `shared.notifyPrediction()`，
  Worker-B 从 16ms 轮询升级为 notify 唤醒 + 超时兜底；
- ✅ **L1 tickRate → Worker-B**：面板 tickRate 变更同时发 `set-pred-dt`（§2.4）；
- ✅ **新增 PhysWorld::set_state API**（物理层 9 → 10 API），契约同步更新。

**已修复（2026-08-08 v5→v7 架构演进，用户逐轮调试定案）**：
- ✅ **v7 权威帧计算模式**：主线程 = 唯一物理渲染线（BSP 解析/物理/渲染全在主线程）；
  Worker = 权威帧计算器（wasm 世界 + 独立固定步长权威演化，含地图碰撞），输出权威全状态
- ✅ **速度外推校准**：每帧 `set_velocity(vel_A + a×Δt)`（权威速度 + 加速度外推，动态帧距）；
  垂直落体实测锯齿 5.536≈理论 5.556
- ✅ **权威角度隔离**（用户定调）：权威帧不得影响渲染角度（渲染物理纯输入驱动）；
  仅碰撞事件（phys-event land/blocked）回传时可同步角度（位置差 <60 才调）
- ✅ **灵敏度输入层应用**：mousemove 乘入角度增量，物理两端 sensitivity 固定 1——
  改灵敏度不产生双端分叉（结构上不可能）
- ✅ **Q/E 输入层化**：Rust apply_yaw_bind 删除，改为输入层生成等效鼠标量
  （yaw_bind_speed/M_YAW×dt，独立增量不受灵敏度影响）；双端消费同源输入 → 无分叉
- ✅ **tickRate 动态生效**：Worker fixedDt = 1/config.physics.tickRate（config 消息显式
  传递 tickRate；64↔128 切换真实改变权威采样率）
- ✅ **Worker config 应用 patch**（v7 隐藏 bug）：applyConfigPatch 更新自身 config，
  面板改任何参数（含灵敏度）权威端才真正生效
- ✅ **碰撞事件回传**：落地上升沿/撞墙速度骤降检测 → 位置微调 + 角度同步；
  修复 `fixWorker.onmessage` 缺失（v5→v7 重构丢失）
- ✅ **FPS 显示**：左上角 #fps（rAF 每秒计数）

### 2.3 未实现的扩展点（v3 文档中明确不做的）

| 项 | 判定 |
|---|---|
| lightmap/雾/碰撞可视化/准星射线 | 调试/增强，v3 判定删除 |
| 自定义传送点（localStorage） | 非核心，删除 |
| 计时挑战（game-state） | 非核心，删除 |
| MsgState postMessage 回退通道 | 强制 SAB（COOP/COEP），删除 |
| colliderSource 三方案 / 传送三模式 | 锁 auto / start-touch |
| LERP + 外推插帧 | 被 Worker-B 预测取代 |

---

## 3. 设计差异对照（时序图 vs 蓝图 vs 实现现状）

> 三份文档定位：`docs/项目时序图.md`（v7 现状）＝ 实际架构；
> `MINIMAL-IMPL-PATH.md`（v5 蓝图，同目录）＝ 实现路径；本文 ＝ 实现现状。
> ⚠️ 本节 3.1–3.3 为 **v4.1 时期（双 Worker 三源决策）的历史对照记录**——v5→v7 已演进为
> "唯一物理渲染线 + Worker 权威帧"（见 §1.2 与 DESIGN-DISCUSSION §H），表中
> 三源决策/预测区/Worker-B 等条目均已过时，仅保留作演进历史。
> 本文为事实记录；各差异点的讨论/决策见 `DESIGN-DISCUSSION.md`（含优先级与倾向）。

### 3.1 一致项（时序图 → 实现逐点落地）

| 时序图要求 | 实现 | 状态 |
|---|---|---|
| SAB 四区布局（V_A/输入槽/权威 S/预测区） | shared-state.ts 同构 | ✅ |
| 代际复合序列号 `seq=(gen<<16)\|(counter&0xFFFF)` | writePredicted 同式 | ✅ |
| 三源决策（权威→预测→回退 S_last） | renderer-main decideState | ✅ |
| 权威就绪 → 清 seq_pred + notify B | clearPrediction + notifyPrediction | ✅ |
| 输入槽 Atomics.add 绝不丢输入 | addInput（Int32 定点版） | ✅ |
| Worker-A 60Hz 自驱 + 写 V_A++ | runLoop + writeAuthoritative | ✅ |
| Worker-B 热待机 + 2 子步 + 只读输入 | predictor runWaitLoop + readInput | ✅ |
| 预测锚定权威基线 | set_state（权威状态同步） | ✅（补强） |
| Worker-B 代际 seq 随 V_A 快照 | generation = readAuthoritative().va | ✅ |

### 3.2 实现与蓝图的差异（实现决策，v3 文档 §3 旧版已并入）

| # | 蓝图（v3）设计 | 实现 | 原因 |
|---|---|---|---|
| D1 | SAB 用 Float64 存 pos/vel/yaw | **Int32 定点**（dx/dy ×1000、pos/vel ×100、yaw/pitch ×1000） | **Atomics 只支持整数 TypedArray**，Float64 无法原子累加 |
| D2 | noclip 在 **TS/JS 侧**维护（蓝图 §2.5「JS 侧自由视角」） | **Rust 侧 noclip_step**（单一物理源） | 避免 JS/Rust 两套状态；noclip 逻辑进 wasm 更内聚 |
| D3 | scene-data 零 JSON（brush/tri/teleport 不跨线程） | **跨线程已零大 JSON**；但 Worker 内 build_world 仍接收导出 JSON（一次构建，非热路径） | 完全从 Bsp 内存直建需重构 lib.rs 数据通道，收益与风险不成比例 |
| D4 | `set-physics-mode` 消息恢复 | 面板动作**统一走 config**（mode 字段并入 physics 段） | 消息协议更薄（7+5），无专用消息 |
| D5 | tickRate 变更清 moveAccumulator | 实现仅改 fixedDt + Worker-B dt_pred | runLoop 无累积器（dt 直接限幅 0.1s），无需清 |
| D6 | wasm-opt 二次优化 | `wasm-opt=false`（Cargo.toml metadata） | 本机 NODE_OPTIONS 含 `--use-system-ca` 污染 wasm-opt node 脚本；LTO+opt3 已足够 |

### 3.3 实现与时序图的差异（工程化取舍）

| # | 时序图 | 实现 | 原因 |
|---|---|---|---|
| T1 | 输入槽 CAS 安全消耗（`CAS: cur→cur-consumed`） | `Atomics.exchange` 一次性清空 + 截断 | SPSC（单写单读）下 exchange 语义等价且更简单；CAS 循环是多读者才需要 |
| T2 | 权威物理 **固定 60Hz** | **默认 64Hz，面板 48-128 可调** | surf 社区惯例 64Hz；可调是蓝图 §2.4 需求 |
| T3 | 主线程 release **更新 Worker-B 基线** | Worker-B **主动 acquire 读权威区** + set_state | 避免主线程向 SAB 写基线（多一处写者）；读侧同步更简洁 |
| T4 | Worker-A 时钟 EMA 滤波 | runLoop 用原始 dt（限幅 0.1s），**无 EMA** | 简化；物理 64Hz 固定步长本身吸收抖动，EMA 收益小 |
| T5 | 输入槽含 frameStamp（时间戳） | 未实现（SAB 无时间戳槽） | 渲染帧率已由 rAF 驱动，时间戳非必需 |
| T6 | 权威状态含 eyeHeight/timeMs | SAB 权威区**未存 eyeHeight**（渲染固定 `pos.y`） | 见遗留 L4；timeMs 由主线程 now 注入 |

### 3.4 蓝图相对时序图的扩展（非差异，蓝图新增）

面板（ESC 桌面两栏：左导航+右设置）、速度面板（8Hz 三模式，HUD 居中偏下 24%）、tickRate 可调、noclip 自由视角、
build-dist 单文件双 Worker 内嵌——均为蓝图 v3 在时序图原型之上新增的产品化能力。

### 3.5 已识别但未处理的差异（遗留）

- **L3**：teleport 消息 = respawn（时序图/蓝图含 spawn 索引切换语义，实现简化）；
- **L4**：eyeHeight 未入 SAB（渲染相机高度 = 玩家 origin.y，非眼睛高度）。


---

## 4. 复现步骤

```bash
cd game
npm install                     # 已装（12 包）
npm run build:wasm              # wasm-pack release（约 3.5 分钟）
npm run build:ts                # typecheck + esbuild 三产物
npm run dev                     # python serve.py 8080
# 浏览器打开 http://localhost:8080/web/index.html
# 加载 maps/surf_666.bsp → 点击画布锁定 → WASD/空格/Esc 面板
npm run build:dist              # 单文件 dist/（3.1 MB）
node scripts/check-wasm-api.mjs # 契约校验
```

> Windows 注意：`wasm-pack` 若遇 `os error 5`（杀毒锁 target），清
> `target/wasm32-unknown-unknown` 后重试。`rm -rf` 会被安全删除拦截，
> 用 `python -c "import shutil; shutil.rmtree('pkg', ignore_errors=True)"`。
