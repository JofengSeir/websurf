# WebSurf 整体架构

> 最后核对：2026-08-24（基线 main @ `2a6e9fb`）。以实际代码为准：共享层 `src/` + 三个独立工程
> `debug/`、`game/`、`viewer/` + 验证工程合集 `test/`（dual-mode-harness / instanced-diorama）。

浏览器中的 Counter-Strike 滑翔（Surf）地图游玩器：BSP 解析（Rust/WASM）+ CS 移动物理 + Three.js 渲染。

仓库由**三个同级独立工程**（各自完整前端与打包链，互不引用）、一个**共享层**（仓库根 `src/`）与一个
**测试合集**（`test/`，不入 Pages 部署；内含 dual-mode-harness 与 instanced-diorama 两个验证工程）组成。
（历史注：2026-08-14 地图最小导出实验 map-min-export 的结论——v20 与 v21 共用 lump 布局——已合并进共享层
vbsp 并随之移除实验工程；2026-08-19 后 test/game 试验田工程整体移除（654d2ef），新增 viewer 查看器（349ee26）。）

文档地图：公共架构见本文；公共材质技术见 `materials.md`；物理与时序修复方向见 `phys-fix-directions.md`；
chamfer 切角与 P2 幻影碰撞机制分析见 `chamfer-physics/`；两端时序见 `../debug/docs/timing-debug.md`（debug）、
`../game/docs/timing-game.md` + `../game/docs/timing-game-analysis.md`（game）；各工程特色功能见
`debug/docs/`、`game/docs/`、`viewer/docs/overview.md`；验证工程见 `test/dual-mode-harness/README.md` +
`CONCLUSION.md`、`test/instanced-diorama/README.md`。

---

## 1. 仓库布局

```
websurf/
├── maps/                      BSP 地图资源（*.bsp 全 gitignore，仅本地存放）
├── src/                       ← 共享层（归属仓库根 Cargo workspace + TS 共享 + 资源）
│   ├── Cargo.toml + phys/       websurf-phys：Rust 物理（wasm-bindgen 绑定层，5 文件共 3,018 行，
│   │                            含 cfg(test) 回归 p2_gate_tests.rs）
│   ├── wasm-core/               websurf-wasm-core：BSP 解析/GLB/模型/纹理/mosaic/mtz（纯 rlib，
│   │                            24 个 .rs 文件共 9,134 行）
│   ├── ts-shared/               TS 物理渲染共享（7 文件共约 1,540 行）：auth/{shared-state,
│   │                            auth-loop,worker-dispatch}、phys/{authority-calibrator,params,
│   │                            world-builder}、input/input-layer
│   ├── materials/textures.mtz   默认纹理包（MTZ6，9,448 条，5,942,995 B ≈5.67MB，三处副本同步）
│   ├── vendor/vmdl/             vendored vmdl 0.2.0（15 个 .rs 文件共 3,262 行；唯一 patch：VTX 条带展开修复）
│   └── serve.py                 共享开发服务器（COOP/COEP + CORS + WASM MIME + no-store；
│                                注：game/serve.py 为被跟踪的陈旧重复副本，全仓无任何引用）
├── debug/                     WebSurf-debug（Debug Build）：全功能调试测试页面
│   ├── crates/wasm/src/         lib.rs（导出层 3,218 行：顶层 pub fn 共 8 个——wasm_bindgen
│   │                            面向 JS 导出 6（parse_bsp / export_visleaf_pvs /
│   │                            decode_vtf_to_png / mosaic_encode / mosaic_decode /
│   │                            decompress_mtz）+ start 入口 + 内部辅助 init_panic_hook；
│   │                            另有 BspProcessor 21 方法——debug 特有 parse_entities/
│   │                            list_pakfile/read_pakfile_*/export_colliders*/
│   │                            export_visleaf_pvs/parse_bsp 等）
│   ├── src/                     TS：app/renderer/worker/world/physics(参数)/input/game +
│   │                            main-wasm/default-pack
│   └── web/                     dev 页面（index.html + 构建产物）
├── game/                      WebSurf-game（Game Build）：最小化游戏实现
│   ├── crates/wasm/src/         lib.rs（导出层 2,326 行：3 自由函数 + BspProcessor 15 方法，
│   │                            game 特有 export_glb_with_pakfile_models_with_lights 灯光导出）
│   ├── src/                     TS：app/renderer/worker/panel/input(含 keymap 录制改键)/world +
│   │                            savepoint(存点)
│   └── web/                     dev 页面
├── viewer/                    WebSurf-viewer：最小 BSP 自由视角查看器（349ee26 新增，无物理）
│   ├── crates/wasm/src/         lib.rs 薄导出层：metadata / parse_spawn_points /
│   │                            export_glb_with_pakfile_models——仅依赖 websurf-wasm-core
│   │                            （无 websurf-phys、无 mosaic/默认纹理包）
│   ├── index.html + src/        入口页在根目录；src/ 仅 app.ts（飞行相机 + 位姿三通道）+ wasm.d.ts
│   └── docs/                    overview.md
├── test/                      验证工程合集（不入 Pages 部署）
│   ├── dual-mode-harness/       WebSurf-test（2026-08-11 收尾）：双模物理 + 帧信号渲染时序验证
│   │    ├── crates/wasm/src/      lib.rs 薄导出层（PhysWorld + BspProcessor 最小集，
│   │    │                          无 mosaic/默认包）
│   │    ├── src/                  main / shared-state（自研 SAB 双缓冲 + WAKEUP 布局）/
│   │    │                          worker-a（双模物理）/ worker-b（渲染）
│   │    ├── docs/                 README 索引/architecture/map-parsing/runtime-sequence/
│   │    │                          mouse-input-analysis 五篇
│   │    └── scripts/              11 个 .mjs：phys-smoke(192 断言调用点) / perf-bench /
│   │                              race-wakeup / render-loop-verify / surf-e2e-verify /
│   │                              trace-verify / dual-compare / flicker-debug /
│   │                              workerb-isolated / check-wasm-api / build-dist(multi-only)
│   └── instanced-diorama/       WebSurf-instanced-diorama：实例化绘制 + PBR 光照渲染测试
│                                 （wasm 导出含 with_lights 灯光 GLB；自带 serve.py 增加 /maps/ 别名）
├── docs/                      仓库级文档（本文 / materials / phys-fix-directions /
│                                chamfer-physics/ + archive/）
└── .github/workflows/deploy-pages.yml    CI：debug + game 构建 + Pages 部署
```

> 注：本节树内行数与 §3.1 / §3.2 表内行数均为 `wc -l` 实测（2026-08-24，含空行；与
> `Get-Content .Count` 口径对无末行换行的文件可能相差 1）。共享层 TS 模块表口径见其表头注。

### Rust workspace 引用关系（共享层 + 各工程 wasm 导出层）

> 构建拓扑（2026-09-06 收敛）：仓库根 `Cargo.toml` 为共享层 workspace（websurf-phys +
> websurf-wasm-core 两成员）；五个模块 wasm crate 保留各自 workspace（debug/game/viewer/
> test 双模 各自根 Cargo.toml，instanced-diorama 同日补齐根——此前缺失导致其用 crates.io
> 原版 vmdl）。仓库根 `.cargo/config.toml` 把 `build.target-dir` 统一到根 `target/`——
> **所有** cargo/wasm-pack 构建共享一份编译缓存，共享 crate 与三方依赖全仓库只编译一份。
> 模块 crate 未并入根 workspace 的原因：debug/game/instanced 三者同名 `websurf-wasm`
>（导出层有意各自维护），Cargo 不允许同 workspace 同名成员，而改名会连锁 40+ 处
> 产物名引用（pkg/websurf_wasm_bg.*）。五份 Cargo.lock 的 wasm-bindgen/js-sys/web-sys
> 已统一锁到 0.2.128/0.3.105/0.3.105（与 CI 的 wasm-bindgen-cli 0.2.128 精确匹配）。

| crate | 角色 | 被谁引用 |
|---|---|---|
| `src/`（websurf-phys） | 物理核心 + wasm 绑定（`PhysWorld` 类，**21 个 pub 方法，含 `new`**） | debug / game / dual-mode-harness / instanced-diorama 的 `crates/wasm`（path 依赖，经 `pub use` re-export 进各自 WASM）；**viewer 不依赖**（纯视觉无物理） |
| `src/wasm-core/`（websurf-wasm-core） | BSP 解析（**v19~v29**）/GLB/模型/纹理解析 + mosaic 编解码 + MTZ 容器（纯 rlib，无 wasm 导出） | 全部五个 wasm crate path 依赖（debug/game/viewer/dual-mode-harness/instanced-diorama），内部模块直接调用 |
| `src/vendor/vmdl/` | vendored vmdl 0.2.0（唯一 patch：VTX 条带展开修复） | 全部五个 workspace 经各自 `[patch.crates-io]` 引用（根 workspace 管共享层；debug/game/viewer/双模/instanced 五处同款声明） |

### 共享层 TS 模块（`src/ts-shared/`，两端 import 共享，改一处双端生效）

行数为实测（`Get-Content .Count`，含空行）。

| 模块 | 行数 | 主要导出 | 说明 |
|---|---:|---|---|
| `auth/shared-state.ts` | 356 | `KeyState` / `KEY_MASK`(11 位含 wheelJump/yawLeft/yawRight) / `keysToMask` / `maskToKeys` / `SHARED_BUFFER_SIZE=512` / `AuthFrame` / `InputSample` / `MsgState` / `ShmState` / 工厂 `createMainSharedState`·`createWorkerSharedState` | 权威帧共享内存布局（SAB 双缓冲 V_A 版本号协议）与消息回退通道（无 crossOriginIsolated 时 postMessage 等价实现） |
| `auth/auth-loop.ts` | 226 | `createAuthLoop`（setTimeout 4ms 自驱 + 固定步长累积器 guard<64 步 + land/blocked 碰撞事件；`MAX_INPUT_PER_STEP_BASE=1200°/tick@64Hz` 随步长缩放） | Worker 权威帧计算器主循环 |
| `auth/worker-dispatch.ts` | 218 | `createWorkerDispatch`（init/**input**(MsgState 回退输入)/wasm-init/world-json/config/respawn/sync-render-state/set-spawn-points/teleport/teleport-to-pos/set-death-threshold + 扩展点钩子 onInit/onWasmInit/onWorldBuilt/onConfigApplied/onExtraMessage） | Worker 消息分发（两端差异经钩子注入；config patch 含 tickRate→setFixedDt+reset、mode→set_noclip、字段名归一化） |
| `phys/authority-calibrator.ts` | 385 | `AuthorityCalibrator`（correctFromAuthority 三条件兜底+冷却+在途回滚 / calibrateVelocity 加速度外推 / applyCollisionCorrection / resetTo / clear）/ `normalizeAngleDeg` | 主线程渲染物理的权威校准（**只读权威，绝不反写**；大偏差反向同步兜底；`SYNC_COOLDOWN_MS=250`、`TELEPORT_EXEMPT_MS=200`；角度不校准） |
| `input/input-layer.ts` | 40 | `INPUT_CLAMP=1000` / `M_YAW=0.022`（与 Rust player.rs 一致） / `layerMouseDelta` / `qeEquivalentDx` | 输入层（灵敏度只在输入层乘一次 → 物理两端 sensitivity 恒 1 不分叉；Q/E 等效像素换算） |
| `phys/params.ts` | 64 | `buildPhysicsParams`（camelCase config → Rust snake_case 全量、`jump_height = jumpSpeed²/2g`、`sensitivity:1` 硬编码、输出 teleport_gate_ticks） | 面板参数 → Rust set_params |
| `phys/world-builder.ts` | 254 | `buildWorldBundle`（bytes → WorldBundle 含 spawnList：colliderSource auto/visual/phy 三档 + 可视网格回退 + 缺失纹理收集 + 默认纹理包加载 + GLB with defaults + onProgress） | 地图导入导出统一管线（两端 handleLoadBsp 收敛于此）；出生点 yaw 换算 `(270−bspYaw)%360` |

> 注：原 `trace/*` 三模块（运动路径采集/显示）全仓库零运行时引用，已于 2026-09-06 删除（git 历史可找回）。
> harness 运行时的共享状态协议为其自研的 SAB 双缓冲 + WAKEUP/RENDER_WAKEUP
> 布局（`test/dual-mode-harness/src/shared-state.ts`），与 ts-shared shared-state 不同源。

**共享原则**：物理/解析/物理渲染（Rust + TS）单副本——**修改一处，两端编译即同步生效**；各工程
`crates/wasm/src/lib.rs`（wasm 导出层与特色函数）与 TS 前端（面板 UI、调试可视化、计时挑战、存点系统、
渲染层）保持各自。viewer 复用同一 `wasm-core` 解析层但**不引入物理**。

---

## 2. 数据流总览（地图加载 → 双侧物理世界）

```
.bsp 文件（本地文件选择 / maps/）
  │
  ▼
WASM BspProcessor（主线程解析；两端均走 ts-shared world-builder 的 buildWorldBundle 统一管线）
  ├─ metadata / parse_spawn_points                → 元数据 + primary 出生点 + spawnList 全列表
  ├─ parse_teleports / parse_pvs_data(debug)      → 传送点 JSON（teleports/triggers/links）/ PVS
  ├─ export_brushes_planes                        → 地图碰撞 brush 平面 JSON
  ├─ export_model_tri_colliders / _phy_colliders  → 模型三角形/.phy 凸包碰撞 JSON（colliderSource 三档）
  ├─ export_mosaic_manifest / export_missing_textures → 画质切换 manifest / 缺失纹理列表
  ├─ 默认纹理包（内嵌 __VBSP_TEXTURES_MTZ_B64__ 或 fetch ./textures.mtz → decompress_mtz）
  ├─ export_glb_with_pakfile_models_with_defaults → GLB（几何 + PAKFILE 模型 + 缺失纹理导出期回退；
  │                                                 game 用 _with_lights 变体注入 KHR_lights_punctual）
  └─ WorldBundle { glb, colliders, teleports, spawnList, … }
  │
  ├──────────────► 主线程渲染侧（three.js，唯一物理渲染线）
  │                   PhysWorld.build_world(...) → predPhys.tick(dt,keys,dx,dy) 每 rAF 完整预测物理
  │                   + AuthorityCalibrator 只读权威校准（correctFromAuthority/calibrateVelocity/
  │                     applyCollisionCorrection）→ state() 直读驱动相机 → GLTFLoader 场景渲染
  │                   （PVS/LOD 剔除、lightmap、雾、碰撞可视化——按工程而异）
  │
  └──────────────► 权威 Worker（ts-shared worker-dispatch world-json 消息）
                      PhysWorld.build_world(...) + setFixedDt(1/tickRate[+3 game]) + reset
                      auth-loop setTimeout 4ms 自驱固定步长：takeInput → tick → writeAuthoritative
                      （SAB 双缓冲；land/blocked 事件经 phys-event postMessage 回流主线程微调）
```

**关键时序约定**：
- `export_mosaic_manifest` / `export_missing_textures` 必须在消费 BSP 的 `export_glb*` **之前**生成
  （借用 vs take——GLB 导出会消耗内部 Bsp）。
- 缺失纹理回退在 **GLB 导出期**完成（`with_defaults`）——渲染端零后期处理，避免中途替换
  （曾引发 `RESULT_CODE_HUNG`）；默认包解压失败则回退为无回退导出（占位色）。
- 输入双通道：同一份层化输入（灵敏度乘入 + 键位掩码）既喂主线程预测物理，也写 SAB 给权威 Worker；
  Worker 写空闲槽后 release 递增版本号 V_A，主线程读 `(V_A−1)&1` 无撕裂；无 crossOriginIsolated 时
  自动降级 MsgState（postMessage 等价实现，性能下降功能不变）。
- 权威校准只读不反写；兜底方向反转（三条件 OR 触发 sync-render-state 反向同步权威）+ 传送豁免窗口。
- 两端解析/导出/物理逻辑全部收敛于共享管线（world-builder + websurf-phys）——**改一处即双端生效**。

---

## 3. 共享层详解

### 3.1 websurf-phys（src/phys/，3,018 行 / 5 文件；行数 `wc -l` 实测，2026-08-24）

CS 移动物理的 Rust 实现（原 @unsurf/cs-movement TS 移植，game 中诞生后共享）：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `mod.rs` | 672 | `PhysWorld` wasm 绑定层，**21 个 pub 方法（含 `new`）**：`build_world` / `tick` / `tick_into`（状态写实例内 [f64;8] 固定缓冲，零 wasm→JS 分配热路径）/ `state_out_ptr` / `gate_veto_count`（P2 门校验否决计数诊断探针）/ `debug_trace` / `predict`（预测微步：应用输入+角度+player_tick，禁用传送/死亡副作用——debug/game 前端未消费，由 test 工程脚本使用）/ `respawn` / `teleport_to(_spawn)` / `set_spawn_points` / `set_state`(9 参) / `set_velocity` / `set_yaw_pitch` / `set_death_y` / `set_params`(16 项 Patch) / `set_hull`(3 项) / `set_noclip` / `state` / `take_event`（teleport/death 事件一次性消费）。`teleport_gate_ticks` 参数可写入但 check 已不消费（no-op，默认 3） |
| `world.rs` | 824 | 世界碰撞：brush/tri **双空间索引**（BrushGrid cell 512 / TriangleGrid cell 256 / 大对象 BIG_CELL_LIMIT=512 兜底恒参与 + epoch 去重零分配热路径）+ Minkowski 扫掠盒（DIST_EPSILON=0.03125）+ **P2 盒-AABB 必要校验**（进入平面门/start_solid 门在真实接触分数 f_true 处判三轴重叠，EPS=DIST_EPSILON/8；否决计数 GATE_VETO_COUNT） |
| `player.rs` | 1,057 | 全套 CS 移动语义（Accelerate/AirAccelerate 刻意不对称/Friction/ClipVelocity 二次修正/TryPlayerMove 4 次 bump/Jump/Duck 空中缩脚/Ladder/StepMove/StuckCheck/BlockedMove…）+ `PhysParams` **19 项运行时可调**（set_params JSON Patch 16 项 + set_hull 3 项）。关键常量：GRAVITY=800、RUN_SPEED=250、AIR_ACCELERATE=150、HULL 16/72/54、EYE_STAND=64.09、STEP_HEIGHT=18 等 |
| `teleport.rs` | 362 | 传送检测 A/B 双路径（A：竖直线段 [脚底,脚底+身高] 与凸包区间相交，gap=落地&&斜面?64:0；B：仅落地，脚底往下 8 区间相交；surfing 滑行不触发；冷却 0.5s）+ 死亡判定——**唯一死亡机制 = Y 阈值坠落**（pos.y < death_y → respawn 到初始出生点 + PhysEvent::Death）。`links` 字段仅为导出信息，物理不消费 |
| `p2_gate_tests.rs` | 103 | cfg(test) 回归测试（60° 下坡 z=0 端盖幻影否决等 P2 用例） |

`build_world` 输入为 JSON 字符串 + 出生点标量（与 BspProcessor 的导出输出**同构**，零转换）：
`brushJson`（WasmBrush[]）、`triJson`（TriMesh[]）、`teleportJson`（{teleports,triggers,links}——
**物理只消费 teleports+triggers 两字段**）+ `spawn_x/y/z` 与 `spawn_yaw`（4 个独立 f64 标量，非 JSON）。

### 3.2 websurf-wasm-core（src/wasm-core/，24 个 .rs 文件共 9,134 行；行数 `wc -l` 实测，2026-08-24）

| 模块 | 行数 | 职责 |
|---|---:|---|
| `vbsp/` | 3,777 | 本地修复版 BSP 解析（基于 crates.io vbsp 0.6.0）：版本范围 **v19~v29**（"VBSP" 魔术字校验；v19 早期 CSS 图 FACES lump-version 分派未实现）；LumpType 枚举 64 项、`Bsp::read` **实际解析 26 个 lump**；Source LZMA（主 lump ident≠0 即压缩 + game lump 独立压缩路径）；Leaves 保持文件原始顺序修复；自适应 leaf 记录（56B v1 含 ambient / 32B v0）；VisData bitofs 相对 lump 起点修复；sprp 静态道具 **v6/v7/v10/v11**；displacement 三 lump 解析 + Handle 层几何展开（2^power+1 网格插值，每 quad 2 三角形）；实体读入即小写化 |
| `bsp_to_gltf_core/` | 1,735 | BSP → GLB（`export_bsp` / `export_bsp_with_models`）：只导出可见 face、坐标 Z-up→Y-up（[x,y,z]→[y,z,x]）、face_index 写入 extras 供 Worker PVS 遮挡剔除、`ConvertOptions.missing_fallback` **缺失纹理回退表**（值 = mosaic 字节码） |
| `model_integrator/` | 1,045 | MDL/静态道具整合：纯内存路径、多实例共享 mesh（节点 name / name#i）、未被引用模型跳过、`KHR_lights_punctual` 灯光注入（`add_lighting_to_gltf_json` 字符串级注入；灯实体收集在 game/instanced-diorama 导出层） |
| `pakfile_models.rs` | 271 | PAKFILE 索引（大小写不敏感 by_path/by_stem + 多前缀候选 + 基名回退）、VMT 解析（$basetexture/$translucent/$alphatest/$alpha/include）、透明门控保守策略（全 Blend 才可穿过、alphatest 保留碰撞、sprp solid=0 明确无碰撞被尊重） |
| `phyfile.rs` | 305 | .phy 模型碰撞解析：VPHY 头校验 + IVPCompactSurface ledge tree 遍历、顶点米制→HU（×1/0.0254）；仅支持静态模型 bone_index=0 |
| `texture_utils/` | 632 | VTF 解码（VTF → PNG） |
| `mosaic/` | 1,348 | 材质低清压缩体系（详见 `docs/materials.md`）：`encode.rs`（PNG → #mosaic v4 字节码）、`decode.rs`（字节码 → 低清 PNG，长边×scale 取 2 次幂、短边独立对齐）、`manifest.rs`（可见 face 纹理收集/全纹理 mosaic 表/缺失列表）、`mtz.rs`（textures.json ↔ MTZ 容器：**写 MTZ6、读 MTZ5+MTZ6**） |

### 3.3 公共资源

| 资源 | 说明 |
|---|---|
| `src/materials/textures.mtz` | 默认纹理包（MTZ6，**9,448 条**（容器头 count 实测），5,942,995 B ≈5.67MB）：缺失纹理回退与比对的数据源；三处副本（src/materials/ + debug/web/ + game/web/）SHA256 逐字节一致且均被 git 跟踪（`.gitignore` 明确豁免注释）；**构建期真正输入源是 src/materials/ 这份**（两份 build-dist.mjs 只读它），web/ 两份仅供 dev 页面直开，存在漂移风险 |
| 根 `maps/` | BSP 地图（gitignored）：本地现两图 surf_666.bsp ≈75MB、ze_cursed_bear_tales_v1_2.bsp ≈144MB（后者超 GitHub 100MB 硬限不可推送）；`game/maps/`、`src/maps/` 均不存在（旧文档表述已过时） |
| `src/serve.py` | dev 服务器：`python src/serve.py <port> <root>`（root = 工程目录；CORS * + COOP same-origin + COEP require-corp → crossOriginIsolated → SAB 可用；no-store + .wasm/.bsp MIME）。debug/game/dual-mode-harness/viewer 四个工程的 package.json 与 cmd 脚本均引用它；`game/serve.py` 为陈旧重复副本（47 行、硬编码 ROOT，全仓无引用）；`test/instanced-diorama/serve.py` 为增强变体（+/maps/ 别名），非重复品 |

---

## 4. 构建与打包（双模式）

五个工程的构建骨架同款：`npm run build:wasm`（cd crates/wasm && wasm-pack build --release
--target web，`wasm-opt=false`；LTO+opt3 指 workspace `[profile.release]` 的 opt-level=3/lto/codegen-units
定制——debug / game / dual-mode-harness / viewer 四工程成立，instanced-diorama 为单 crate 工程、无任何
`[profile]` 定制，用 Cargo 默认 release 即 opt3、无 LTO）→ typecheck（tsc --noEmit）→ esbuild bundle。
其中 **debug / game / dual-mode-harness** 三者再有 dist 打包环节 `node scripts/build-dist.mjs [--multi]`；
viewer 与 instanced-diorama 无 build-dist 脚本（viewer 仅 build:wasm/build:ts/dev）。
dev 命令全部复用共享 `src/serve.py`（唯独 instanced-diorama 用自己的增强版）。

| 模式 | 产物 | 用途 |
|---|---|---|
| **single**（默认，无参数；debug/game `build-dist.cmd`） | 单文件 IIFE：WASM + Worker 代码 + **默认纹理包**全部 base64 内嵌，classic index.html；并清理 dist 内旧多文件产物 | 本地双击 file://（无 fetch 能力，全内嵌；无 SAB 自动 MsgState 回退） |
| **multi**（`--multi`） | 多文件 ESM 5 文件：index.html + app.js + worker.js + websurf_wasm_bg.wasm + textures.mtz 外置 | GitHub Pages / HTTP 部署（fetch 正常） |

**两端打包行为分叉**（有意为之，重编时注意口径）：
- debug multi 版 app.js 前缀额外注入第 4 个全局 `__VBSP_WASM_URL__='./websurf_wasm_bg.wasm'`；
  **game 不注入**——其运行时统一硬编码 fetch 该路径。
- 许可文件（LICENSE.cs-movement / NOTICE.cs-movement）与上游 Apache-2.0 许可头**仅 debug 版拷贝/携带**；
  game 版两者皆无——法务口径不一致点，已知悉。
- single 打包读取的 WASM 与纹理包都取自共享层（`pkg/websurf_wasm_bg.wasm` + `../src/materials/textures.mtz`）。

**运行时内嵌消费约定**（构建注入的全局变量及真实读者）：

| 变量 | 注入模式 | 读取处 |
|---|---|---|
| `__VBSP_WASM_B64__` | single | debug `main-wasm.ts`（initSync）/ `app.ts`（postMessage 给 worker）、game `app.ts` |
| `__VBSP_WORKER_JS__` | single | debug/game `app.ts`（Blob URL 起 module worker；Blob worker 读不到主线程 global，数据一律 postMessage） |
| `__VBSP_TEXTURES_MTZ_B64__` | single | debug `default-pack.ts`/`app.ts`、ts-shared `world-builder.ts`（默认包加载）、game `web/app.js`（构建产物） |
| `__VBSP_WASM_URL__` | 仅 debug multi | debug `main-wasm.ts`（缺省 fallback `../pkg/websurf_wasm_bg.wasm`） |

> 以上变量均为只读构建注入常量——两个工程的运行时代码**不向 window/globalThis 暴露任何调试 API**
> （game 仅有 `globalThis.__keyboardInput` 作为面板改键入口）。

**test 工程**：dual-mode-harness 仅 multi 多文件（app/worker-a/worker-b/wasm/index.html），无 single 内嵌
（仅 HTTP 运行，SAB 恒定可用）；instanced-diorama 无 dist 打包环节。

**CI（deploy-pages.yml，2026-09-06 起全模块覆盖）**：push main / 手动触发；并发组 `pages-deploy-websurf`
（默认 "pages" 并发组会被 GH 内部 cancel，实测过）。build job（ubuntu-latest，timeout 45min）：Node **22** +
wasm-pack action + **手工下载预编译 wasm-bindgen-cli 0.2.128**（与五份 Cargo.lock 统一版本精确匹配）→
debug 四连（npm ci → build:wasm → build:ts → `node scripts/build-dist.mjs --multi`）→ game 同款四连 →
viewer 五步（npm ci → build:wasm → build:ts → build:dist(single) → test:replay）→ dual/instanced 各
「npm ci → build:wasm → build:ts」构建验证 → 组装 `deploy/{debug,game,viewer}` +
入口页（pages-index.html：Debug / Game / Viewer 三入口 + SAB 受限提示）→ upload-pages-artifact →
deploy-pages。

> 备注：`debug/package.json` 的 `verify:chamfer` 脚本指向 `scripts/verify-chamfer.mjs`——该类脚本按根
> `.gitignore` 的 `**/scripts/verify-*` 约定为本地工具不入库，克隆后直接执行会 ENOENT（断链引用）。

---

## 5. 两端差异一览（详见各自工程 docs）

| 维度 | debug | game |
|---|---|---|
| 定位 | 全功能调试测试页面 | 最小化游戏实现 |
| 解析/导出/物理渲染 | 主线程（与 game 同模式，共享 ts-shared） | 主线程 |
| 权威帧 Worker | 共享 auth-loop / worker-dispatch（debug 扩展：物理面板参数、ready 回执、onExtraMessage 物理面板消息） | 共享 auth-loop / worker-dispatch；**权威固定步长 = 1/(面板 tickRate + 3)**（`TICK_RATE_OFFSET=3`，b16a1c3 有意为之的面板显示/实际步长偏移：面板 64 → 权威实际 67Hz，主线程预测不受影响） |
| 面板 | 侧边栏手风琴（HTML 静态 + app.ts 绑定；UI 偏好持久化 `vbsp:uiPrefs` v2） | ESC 弹出面板（`panel-controller.ts` **7 模块导航**：通用/物理/体型/按键/操作/显示/视角 + 录制改键 + 偏好持久化 `vbsp:panelPrefs` v2） |
| 特色功能 | 计时挑战（idle→running→finished，targetname 正则 `end$` 匹配，检查点/死亡计数 HUD 10Hz）、自定义传送点（localStorage 上限 50 条）、准星射线 PlaneInspector（每 6 帧限流，mesh>solid/ladder>trigger）、缺失纹理弹窗、调试 API（parse_entities/list_pakfile/read_pakfile_file/read_pakfile_scripts/export_colliders(_with_filter)/export_visleaf_pvs/parse_bsp/decode_vtf_to_png 等，仅 debug 导出）、**碰撞可视化 5 开关 + 5 距离滑块**（brush 绿黄红/trigger 青紫灰橙/phy 橙/vis 紫/**chamfer 黄 0xfffb14** + showPlaneInfo 信息开关） | **存点系统**（X 键存完整状态 / C 键读最近存点 / 面板列表读删、按地图 localStorage 持久化上限 50）、**C 读点按住冻结松开恢复**（按住=速度 0 悬停冻结、松开=恢复存点速度，e86eb7b）、键位录制重绑（10 动作多键冲突自动移除）、noclip 面板切换、速度面板三模式（lateral/lateral-vertical/total，8Hz 门控）、**加载进度覆盖层**（阶段→百分比映射 + rAF ease-out 补间 + 伪漂移 + 失败红态，961b867/d55593a）、空间分块合并 optimizeScene（~3.4 万 primitive mesh → 300~800 空间块）、PVS 禁用（ENABLE_PVS=false，surf_666 平均可见率 1.6% 负收益实证）、灯光 GLB 导出 |

**近期提交补档**（此前文档缺口）：
- `d0cd4e9` — debug 新增 chamfer 切角平面黄色显示（collider-debug.ts 第 5 组调试线框：WASM 导出层
  运行时生成的 bevel 平面中「只过棱、不构成面」者单独标黄，四边形外推 CHAMFER_QUAD_LEN=16 HU、
  depthTest:false 恒可见、WeakMap 缓存随地图重载失效重建）。
- `b16a1c3` — game 存点系统 + TICK_RATE_OFFSET=3（同提交曾把 player.halfWidth 改 15，
  **已被 961b867 改回 16**，现行值与 debug 一致）。
- `e86eb7b` — C 读点改为「按住冻结 / 松开恢复」语义。
- `961b867` + `d55593a` — game 加载进度条初版 → 平滑补间（ease-out 逼近 + 区间伪漂移）+ 失败红态
  （overlay `.error`、进度拉满、错误消息展示，不自动消失）。
- `7c33a58`/`4f11e5a`/`0b08a61` — P2 坡顶幻影碰撞根治三部曲（盒-AABB 必要校验 + 实证文档 + 端盖否决单测），
  详见 `docs/chamfer-physics/p2-remaining-task.md`。

**两端共有功能**（共享实现，改一处双端生效）：物理（websurf-phys）、地图导入导出（wasm-core + world-builder）、
物理渲染/权威帧/校准（ts-shared auth 系）、画质切换、缺失纹理回退、双模式打包、死亡判定（Y 阈值；通道双端就绪——debug 双端同值下发生效，game 侧调用方暂缺、运行时恒用默认 −100000 兜底即场景包围盒。基线 @2026-08-24 工作区，接线后更新本注）。

**工程特有**（各自维护）：面板 UI、调试可视化（含 chamfer 显示）、计时挑战、自定义传送点、存点系统、
渲染层细节（debug：light/fog/lightmap/LOD 管理器；game：固定三点光 + 内置 LOD 两级 + optimizeScene）、
wasm 导出层与特色函数（debug 调试 API、game 灯光导出）。

**第三形态 viewer/**：纯视觉最小集——仅 websurf-wasm-core（无物理、无 mosaic/默认包、无 PVS/LOD），
自由飞行相机 + 位姿三通道（URL/hash/window.viewer），详见 `viewer/README.md`。

**验证工程定位**：
- `test/dual-mode-harness/`：独立验证「输入 → 双模物理 → 帧信号渲染」时序——主线程不做物理/渲染
  （负责 BSP 解析导出 + 输入转发 + rAF wake）；WorkerA 双模（模式A 1ms 无限制真理源 + 模式B 独立 64t
  权威速度线，tick 先行 + set_velocity 三轴唯一校准 + 分叉兜底锚定 64）；WorkerB 帧信号驱动渲染
  （RENDER_WAKEUP = 主线程 rAF，50ms 超时兜底）；trace 公共模块仅其 scripts 验证脚本文本提及（运行时零引用，历史注记）。
  scripts/ 11 个验证脚本，核心 phys-smoke 含 **192 个 check() 断言调用点**（静态实测计数；
  历史数字曾有分歧——README 曾写 191/191、CHANGELOG 写 192/192，本轮已全部统一为脚本实数）。
- `test/instanced-diorama/`：实例化绘制 + PBR 材质 + 影棚光照 + SSAO/DOF/FXAA 电影级后处理的渲染侧
  测试用例，兼验证 wasm 光照导出（with_lights → KHR_lights_punctual；实测 ze 499 灯 / surf_666 2118 灯）；
  支持 `?bsp=` 直载与 `?ssao=0` 等对照开关、`scripts/check-lights.mjs` node 冒烟。
