# 任务前置项目概况书

> **本文定位**：文档重编 / 代码注释重编任务的**事实基线**。所有结论均由本次读码取得，标注 `文件:行号` 作为证据锚点。
> **事实来源**：仓库 `D:\code\projects\websurf` 的当前代码（2026-09-22 读码）。旧文档与旧注释**一律不作为依据**（旧文档已由 owner 从工作区删除，**仅存 git 历史、不存在可回读的归档副本**；本文不依赖其中任何内容），仅在 §10 记录"已确认的不一致"作为待修正项。
> **开工前必读**：§12（主流程与时序骨架）与 §13（必读源码清单）——任何文件重写前，先按 §13 顺序读源码建立骨架。
> **配套文件**：[doc-rewrite-taskbook.md](./doc-rewrite-taskbook.md)（重编任务书，含流程、规范、术语表与任务拆分）。
> **协作规范**：根 [AGENTS.md](../../AGENTS.md)（文件归属 / 临时区 / 生成物 / 文档格式）。

---

## 1. 读码方法与证据规范

| 项 | 约定 |
|---|---|
| 事实来源 | **只有代码**：源码 > 构建脚本 > 配置 > 文档。文档与代码冲突时以代码为准 |
| 证据标记 | 每条事实后附 `` `文件:行号` ``（相对仓库根），行号**必须可定位** |
| 规模统计口径 | 行数 = `(Get-Content <文件> -Encoding UTF8).Count`；注释行 = 以 `//`、`///`、`//!`、`*`、`/*` 开头的行 |
| 复核方式 | 漂移体检 `node src/scripts/check-doc-drift.mjs`；Rust `cargo test -p websurf-phys`；各工程 `npm run typecheck` |
| 不入库 / 不参与的目录 | `test/dual-mode-harness/`（**已退役**：已从工作区删除，不恢复、不重编、不作事实来源）、`test/game-core/`（本地实验工程，**当前不在工作区、不在版本库**，见 §7）、`node_modules/`、`target/`、各工程 `pkg/` `dist/` `web/*.js` `web/*.wasm` |

---

## 2. 仓库总览

| 路径 | 定位 | 职责（证据） |
|---|---|---|
| `src/` | 共享层 | `phys/` Rust CS 物理（crate `websurf-phys`）、`wasm-core/` BSP 解析与 GLB/模型/纹理导出（crate `websurf-wasm-core`）、`ts-shared/` TS 权威帧与校准、`materials/textures.mtz` 默认纹理包、`vendor/vmdl/` vendored 单副本、`serve.py` 共享 dev 服务器、`scripts/` 环境脚本（`src/lib.rs:1-12`、`src/wasm-core/lib.rs:1-13`） |
| `apps/debug/` | 主工程（Debug Build） | 全功能调试页：碰撞可视化、力学参数面板、自定义传送点、准星射线、仅 debug 导出的调试 API（模块清单见 §4.2） |
| `apps/game/` | WebSurf-game（Game Build） | 最小化游戏：主线程渲染预测线 + 单 Worker 权威帧、面板与录制改键、存点系统（模块清单见 §4.3） |
| `apps/viewer/` | WebSurf-viewer | 无物理自由视角查看器 + Shavit `.replay` 回放（模块清单见 §4.4） |
| `test/dual-mode-harness/` | **已退役工程（不部署）** | 原为三模式物理 + 渲染时序验证工程；**已从工作区删除，仅存 git 历史，不作事实来源**（见 §5） |
| `test/game-core/` | **本地实验工程（不在版本库，当前不在工作区）** | 光照/物理实验隔离工程，`.gitignore` 明确排除；磁盘上不存在，任何指向它的引用均不可定位（见 §7） |
| `.github/workflows/` | CI | `deploy-pages.yml`（部署矩阵）、`ci-gates.yml`（门禁）、`doc-drift.yml`（文档漂移体检） |

**构建拓扑**：四个 Cargo workspace（根只收两个共享 crate —— `websurf-phys` 与 `websurf-wasm-core`，三工程的模块 wasm crate 分属各工程自己的 workspace）；四份 `Cargo.lock`（根 + 三工程各一份）统一锁 wasm-bindgen `0.2.128`；`apps/game/scripts/build-dist.mjs:4,11` 双模式（`single` 全内嵌 / `multi` 外置）。

---

## 3. 共享层 `src/`

### 3.1 `src/phys`（websurf-phys）

| 项 | 事实 | 证据 |
|---|---|---|
| crate 身份 | `websurf-phys` v0.1.0，rlib，`[lib] path = "lib.rs"`，被 debug/game 的 cdylib re-export | `src/Cargo.toml:2,12-13`；`src/lib.rs:10` |
| 依赖 | wasm-bindgen 0.2 / js-sys 0.3 / serde 1.0 / serde_json（**`float_roundtrip`** 特性） | `src/Cargo.toml:16-21` |
| 模块 | `phys::PhysWorld`（绑定层）、`phys::world`（碰撞容器）、`phys::player`（移动语义）、`phys::teleport`（传送+死亡）、`phys::seed`（种子面 v2，私有）、两个 `#[cfg(test)]` 模块 | `src/phys/mod.rs:16-27` |
| 导出面 | `#[wasm_bindgen] impl PhysWorld` 现有 **24 个公开方法**（含 `new`）：new / build_world / tick / tick_into / state_out_ptr / set_state_ex / state_full_json / seed_from / gate_veto_count / debug_trace / predict / respawn / teleport_to / set_spawn_points / teleport_to_spawn / set_state / set_velocity / set_yaw_pitch / set_death_y / set_params / set_hull / set_noclip / state / take_event | `src/phys/mod.rs:92-548`（本次实测：该 impl 块内 `pub fn` 共 24 个） |
| 零分配热路径 | `state_out: [f64; 22]`：槽 0-7 = pos×3/vel×3/yaw/pitch（既有）；8-19 = B5 十字段；20 = eye_height；21 = on_ground；JS 侧经 `state_out_ptr` 建 `Float64Array` 直读 | `src/phys/mod.rs:83-89` |
| 碰撞结构 | `Plane{normal,dist}`、`Brush{planes,min,max}`、`LadderVolume{planes,min,max,facing}`、`TriMesh{vertices,indices,min,max}`、`TraceResult{fraction,end_pos,normal,start_solid,all_solid}`、`BrushGrid`、`TriEntry{mesh: Rc<TriMesh>, a,b,c, min_x...}` | `src/phys/world.rs:18-63,517,601-612` |
| 物理参数 | `PhysParams` **18 字段**（gravity/accelerate/friction/stop_speed/jump_height/air_accelerate/run_speed/walk_speed/crouch_speed/autobhop/bhop_speed_clamp/sensitivity/yaw_bind_speed/noclip_speed/teleport_gate_ticks/hull_half_width/hull_stand_height/hull_duck_height） | `src/phys/player.rs:70-92`（本次实测：该结构 `pub` 字段共 18 个） |
| 关键常量 | hull 16/72/54、`EYE_STAND=64.09`、`EYE_DUCK=46.04`、`DUCK_LERP_TIME=0.2`、`AIR_DUCK_VIEW_LIFT=9`、`JUMP_HEIGHT=57`、`AIR_SPEED_CAP=30`、`GROUND_TRACE_DIST=2`、`MAX_CLIP_PLANES=8` | `src/phys/player.rs:31-60` |
| 蹲姿语义 | 地面蹲=换箱不挪 origin；**空中蹲=收脚**（origin 上移 18，头顶不动）；**空中起立=放脚**并以站立箱扫掠判定，被挡即不起立；空中蹲视角额外 +9u | `src/phys/player.rs:581-621`、`src/phys/player.rs:191-206` |
| 测试 | `p2_gate_tests`（P2 幽灵面门禁）、`duck_surf_tests`（surf/蹲姿，对齐 Source `CanUnduck`）；`cargo test -p websurf-phys` 实测 **10 passed / 0 failed** | `src/phys/mod.rs:23-27`；本次实测 |

### 3.2 `src/wasm-core`（websurf-wasm-core）

| 项 | 事实 | 证据 |
|---|---|---|
| crate 身份 | `websurf-wasm-core`，**不含 wasm-bindgen 导出**（由各工程 cdylib 提供） | `src/wasm-core/lib.rs:5`、`src/wasm-core/Cargo.toml:13` |
| 模块 | `vbsp`（BSP 解析，含 LZMA）、`bsp_to_gltf_core`（GLB 导出）、`model_integrator`（MDL 整合）、`pakfile_models`（PAKFILE 索引 + VMT）、`phyfile`（`.phy` 碰撞）、`texture_utils`（VTF 解码）、`mosaic`（mosaic v4 DSL + MTZ 容器）、`vhv` | `src/wasm-core/lib.rs:15-22` |
| 依赖 | serde/serde_json、vmdl 0.2、vtf 0.3、vmt-parser 0.2、tf-asset-loader 0.1.7（zip） | `src/wasm-core/Cargo.toml:21-28` |
| BSP 版本 | 接受 **v19–v29**（`VBSP` 魔数 + 版本区间校验）；v20/v21 lump version 分布与记录大小一致（NODES 32 / LEAFS 32 / FACES 56B） | `src/wasm-core/vbsp/bspfile.rs:14-33` |
| LZMA | lump `ident` 非 0 时为 LZMA 封装，`length` 是盘上长度、`ident` 是解压后长度 | `src/wasm-core/vbsp/bspfile.rs:55-56` |
| Leaves 不排序 | 排序会破坏 BSP 树 `node.children` 的 leaf 索引；另存 `sorted_leaves` 仅供 `clusters()` | `src/wasm-core/vbsp/mod.rs:32-52` |
| RGBExp32 解码 | lightmap：`mantissa/255 × 2^exp`；leaf ambient cube：`mantissa × 2^exp`（**不除 255**），两者**不可混用** | `src/wasm-core/vbsp/data/game.rs:394`、`game.rs:407` |
| 量级旋钮 | `AMBIENT_SCALE: f32 = 1.0`（prop ambient cube 唯一量级旋钮） | `src/wasm-core/vbsp/mod.rs:16-18` |
| sprp（static props） | V10 记录 **72B**、V11 **80B**（V11 多 GPU 等级/调制色/unknown）；game lump fourCC 在文件里按小端 int 落地 ⇒ 读出反写 `prps`；布局含**独立的 propCount int** | 本次读码实测（surf_666 v10/653 条、ze_cursed_bear_tales v11/359 条） |
| 默认纹理包 | `src/materials/textures.mtz` + 各工程 `web/textures.mtz`；经 `decompress_mtz` 解压为 defaultsJson 注入导出 | `src/materials/textures.mtz`（存在）；`apps/game/src/app.ts:418` |

### 3.3 `src/ts-shared`（TS 共享层）

| 子模块 | 内容 | 证据 |
|---|---|---|
| `auth/shared-state.ts` | **SAB 512B 布局**（槽位按 8B 计，共 64 槽）：i32 控制区 字节 0-63（槽 0-8 = V_A / I_KEYS / A_GROUND / V_D / WAKEUP / I_A_SEG / I_A_TICK / I_A_EVT / I_A_PSEQ，槽 9-15 保留）；输入槽 字节 64-79（i64 槽 B_DX_ACC=8、B_DY_ACC=9）；权威帧双缓冲 字节 128-287（B_A0=16、B_A1=26，各 10 值）；解耦帧双缓冲 字节 288-447（B_D0=36、B_D1=46）；渲染/采样尾槽 字节 448-511（RT_X=56 / RT_Y=57 / RT_Z=58 / RT_T=59 / RT_SEQ=60 / RT_I0=61 / RT_EPOCH=62 / RT_PUB_TAU=63）。帧 10 值定标：pos×100、yaw/pitch×1000、vel×100、eyeHeight×100、timeMs×1 | 常量 `src/ts-shared/auth/shared-state.ts:119-221`；整缓冲视图 `:583-585`；定标写 `:910-942`、读 `:604-630` |
| `auth/` | auth-loop（权威循环）、tick-authority、compute-mode、worker-dispatch、protocol/tick 测试 | 目录与文件头 |
| `tick/` | ordering-gate（顺序闸门，含测试）、tick-consumer | 目录 |
| `decoupled/` | decoupled-loop（解耦线） | 目录 |
| `input/` | input-layer、mouse-buffer、pointer-lock | 目录 |
| `phys/` | params、world-builder（BSP→GLB→物理世界管线）、authority-calibrator（校准）、angles、constants | 目录 |
| `world/` | pvs-manager、types | 目录 |
| `wasm/loader` | wasm 与默认纹理包（`textures.mtz`）内嵌字节加载单点 | `src/ts-shared/wasm/loader.ts:32` |

**KeyState / KEY_MASK**：11 个布尔字段（forward/backward/left/right/jump/duck/sprint/reset/wheelJump/yawLeft/yawRight），与 Rust `KEY_MASK` 一致（`shared-state.ts:51-68`）。

### 3.4 其他共享资产

| 资产 | 事实 |
|---|---|
| `src/vendor/vmdl` | vendored Source 模型解析（MDL/VVD/VTX），15 文件；根 `Cargo.toml` 以 `[patch.crates-io] vmdl = { path = "src/vendor/vmdl" }` 定向 |
| `src/materials/textures.mtz` | 默认纹理包（mosaic 容器），工程侧另有 `web/textures.mtz` 副本 |
| `src/scripts/` | `cargo-env.cmd`、`install-wasm-bindgen.cmd`、`ensure-node-deps.cmd`、`check-doc-drift.mjs`、`check-shared-sync.mjs`、`wasm-stale-check.mjs` |
| `src/serve.py` | 三工程共用的 dev 静态服务器（COOP/COEP 头） |

---

## 4. 三个应用工程

### 4.1 通用形态（三工程同构）

```
apps/<app>/
├─ crates/wasm/src/lib.rs     # 唯一 Rust 侧：wasm-bindgen 导出层（re-export 共享 crate）
├─ src/                       # TS：app.ts（主线程入口）+ worker/main.ts（Worker 入口）+ 子模块
├─ scripts/                   # build-dist.mjs、check-wasm-api.mjs、各 test:* 脚本
├─ web/                       # index.html / styles.css（入库）；app.js / worker.js / *.wasm（产物）
├─ Cargo.toml / package.json / tsconfig.json
└─ start-dev.cmd / build-dist.cmd / play.cmd
```

| 工程 | dev 端口 | npm dev 命令 | 依赖 |
|---|---|---|---|
| debug | **8080** | `python ../../src/serve.py 8080 .` | `apps/debug/package.json:15` |
| game | **8090** | `python ../../src/serve.py 8090 .` | `apps/game/package.json:15` |
| viewer | **8100** | `python ../../src/serve.py 8100 .` | `apps/viewer/package.json:18` |

（原 `dual-mode-harness` 的 8110 端口行随该工程退役一并移除。）

通用 scripts（三工程同名）：`build:wasm`（wasm-pack + wasm 拷贝到 `web/`）、`typecheck`、`build:worker`、`build:app`、`build:ts`、`build:dist`、`build`、`dev`、`check:api`。

### 4.2 `apps/debug`（32 文件 / 13321 行 / 注释 28%）

- 模块：`app.ts`、`config.ts`、`game-state.ts`、`default-pack.ts`、`main-wasm.ts`、`input/{input-bridge,keyboard,input-recorder}`、`renderer/{renderer-main,camera-controller,collider-debug,light-manager,plane-inspector,fog-manager,lod-manager,path-recorder,lightmap-shader}`、`physics/{param-defs,physics-params,prediction-params,math/vec3,physics/Collision/Collision.types}`、`world/{collider-adapter,custom-teleports,spawn-loader,teleport-manager,types}`、`worker/{main,physics-worker,worker-types,mtz-data}`、`wasm.d.ts`
- 测试门禁（CI）：`test:optimize-scene`、`test:auth-clock`、`test:path-acceptance`（**故意失败**基线夹具 `fixtures/path/tick-on-render-prefix.json`）、`test:jump-apex`、`test:surf-crouch`
- 依赖：three ^0.165.0；devDeps esbuild/typescript/@types/*

### 4.3 `apps/game`（13 文件 / 6617 行 / 注释 29%）

- 模块：`app.ts`、`config.ts`、`savepoint.ts`、`input/{input-bridge,keyboard,keymap}`、`panel/panel-controller`、`renderer/{renderer-main,lightmap-shader}`、`worker/{main,worker-types}`、`world/types`、`wasm.d.ts`
- 导出层：`crates/wasm/src/lib.rs` 的 `BspProcessor`（18 个方法）+ 自由函数 `mosaic_encode` / `mosaic_decode` / `decompress_mtz`（`apps/game/crates/wasm/src/lib.rs:233-1856`）
- 键位：`keymap.ts`（默认键位表、localStorage 持久化、`isBindableCode`——Ctrl/Shift/Alt 可绑，Escape/Meta 不可绑；空数组=禁用动作）
- 运行时配置：`config.ts` 的 `RuntimeConfig`（lockTickRate / physics / input / player / hud / texture / **lighting{exposure, lightGamma}**）
- 测试门禁：`test:phys`（五指纹）、`test:seed-smoke`、`test:surf-crouch`

### 4.4 `apps/viewer`（28 文件 / 6719 行 / 注释 23%）

- 模块：`app.ts`、`core/{constants,dom,fly,pose,spawn,bsp,scene}`、`replay/{shavit-replay,types,protocol,importer,build,sampling,player,panel,trackpanel,tracks,timeline,visuals,helpers}`、`ui/{hud,mapinfo,telemetry,replaymeta}`、`renderer/lightmap-shader`、`worker/main`、`wasm.d.ts`
- 回放契约：`RuleConfig{version:2, name, axesMode, yawMode, transform}`；`axesMode='shavit'` = `[x,y,z] → [y,z,x]`；`yawMode='shavit'` = `yaw = wrap(srcYaw+180)`、`pitch = −srcPitch`；JSON 与规则脚本通道已移除（`apps/viewer/src/replay/types.ts:1-46`）
- 测试门禁：`test:replay`（esbuild + node 自检）、`local:smoke`（CDP）

---

## 5. 已退役工程 `test/dual-mode-harness`

> **状态：已退役（owner 定调）**——该工程已从工作区整体删除（39 个文件：其 src 子树、自带 wasm crate、构建脚本、包与 Cargo 清单、锁文件、tsconfig、index.html 与工程内 docs）。**不恢复、不重编、不作事实来源**，也不参与 Pages 部署。

- 它只存在于 **git 历史**中；工作区与版本库当前均无该目录，**不存在可回读的归档副本**。
- 原工程内的 11 文件 / 4679 行 / 注释 22%、192B TestShared 布局、三模式（coupled / decoupled / tick）运行时热切等描述，**一律只作历史记录**，不得作为新稿的事实依据。
- 后续文档与注释重写不得引用该工程下的任何路径（自检见任务书 §9.3 的 grep 门禁）。

---

## 6. 依赖关系矩阵

| 关系 | 事实 | 证据 |
|---|---|---|
| Rust workspace | 根 workspace 收 `src`（websurf-phys）与 `src/wasm-core`；三工程的模块 wasm crate 分属各工程自己的 workspace（各工程 `Cargo.toml` 的 `[workspace] members = ["crates/wasm"]`）；`target/` 不跨 workspace 复用 | `Cargo.toml:20-28`；本次实测（`apps/debug/Cargo.toml:6-7`、`apps/game/Cargo.toml:6-7`、`apps/viewer/Cargo.toml:7-8`） |
| crate patch | `[patch.crates-io] vmdl = { path = "src/vendor/vmdl" }` | `Cargo.toml:27-28` |
| 版本锁步 | 四份 `Cargo.lock`（根 + 三工程各一份）统一锁 wasm-bindgen `0.2.128` | 本次实测（仓库内 4 份锁文件；原 harness 那份已随工程删除） |
| 三应用互不引用 | apps/debug、game、viewer **互不引用**（共享逻辑上提 `src/ts-shared/`） | 本次实测（三工程 `src/**` 无相互 import）；`AGENTS.md` §2 |
| 共享层禁止反向依赖 | 工程内不得复制共享实现（仅 `test/*` 允许副本化） | `AGENTS.md` §2（目录现状） |
| `test/*` 隔离铁律 | 不得引用仓库根 `src/`；需要则逐字节副本化；验收=移走 `src/` 后 typecheck/build:ts/cargo check 通过 | 任务书 §7.3 |
| 产物 | `pkg/`、`dist/`、`web/app.js`、`web/worker.js`、`web/*.wasm` 均为产物，不入库 | `AGENTS.md` §4 |
| npm | three ^0.165.0（三工程一致）、esbuild ^0.23、typescript ~5.7.2、`ws`（viewer 冒烟用 `@types/node`） | 各 `package.json` |

---

## 7. `test/game-core`（本地实验工程，**不在版本库、当前不在工作区**）

- 规模：**113 文件 / 40385 行**（**历史统计口径**），含自带 `crates/{phys,wasm-core,wasm}` 副本与 `web/`、`scripts/`；该工程当前**不在磁盘上**，上述数字无法复测
- `.gitignore` 明确排除，并注明"如需重新入库，删掉下面这行并 `git add test/game-core`"
- 与仓库的关系：光照/物理实验的隔离副本；任务书 §7.3 的"隔离铁律"对其本地形态仍有效
- **对文档的影响**：旧文档树中曾有多篇引用 `test/game-core/**`（旧文档已全部删除）；现行控制文件与后续新稿一律不得出现该路径（详见 §10、任务书 §3.3）

---

## 8. 核心入口清单

| 层 | 入口 | 文件 |
|---|---|---|
| 主线程 | 应用装配、面板、渲染循环 | `apps/<app>/src/app.ts` |
| Worker | 权威帧计算 / BSP 解析 | `apps/<app>/src/worker/main.ts` |
| WASM 导出 | `PhysWorld`（物理）、`BspProcessor`（解析导出） | `src/phys/mod.rs:92+`、`apps/game/crates/wasm/src/lib.rs:501+`（另两工程同构） |
| 渲染 | 场景/相机/材质/光照注入 | `apps/<app>/src/renderer/renderer-main.ts` |
| 光照 | lightmap 解码注入 + 曝光/gamma 共享 uniform | `apps/<app>/src/renderer/lightmap-shader.ts` |
| 输入 | 键位表 / 键盘 / 鼠标缓冲 / PointerLock | `apps/game/src/input/*`、`src/ts-shared/input/*` |
| 配置 | 运行时可调项 | `apps/<app>/src/config.ts` |
| 构建 | wasm-pack / esbuild / dist 打包 | `apps/<app>/package.json` scripts、`scripts/build-dist.mjs` |
| 门禁 | 文档漂移体检 | `src/scripts/check-doc-drift.mjs` |

---

## 9. 规模基线（重编工作量依据）

| 区域 | 文件 | 行数 | 注释行 | 注释密度 |
|---|---|---|---|---|
| `src/phys` | 7 | 3946 | 755 | 19% |
| `src/wasm-core` | 26 | 11166 | 1191 | 11% |
| `src/ts-shared` | 23 | 7109 | 2170 | 31% |
| `apps/debug/src` | 32 | 13321 | 3678 | 28% |
| `apps/game/src` | 13 | 6617 | 1921 | 29% |
| `apps/viewer/src` | 28 | 6719 | 1542 | 23% |
| `test/dual-mode-harness/src`（**已退役**） | — | — | — | 工程已从工作区删除（原 11 文件 / 4679 行 / 1018 注释行 / 22%），不参与重编 |
| 现存文档树（全仓 `.md`） | 9 | — | — | 本次实测：根 `AGENTS.md` 1 篇 + `documents/plan/` 2 篇 + 工程构建脚本资产 2 篇 + `.github/` 模板 4 篇；旧文档树（原 68 篇）已从工作区删除 |
| `test/game-core`（本地工程，**不在工作区**） | 113（历史） | 40385（历史） | — | 排除：该工程当前不在磁盘上，数字为历史统计、无法复测 |

> **统计口径（本次复测注明）**：行数 = `(Get-Content <文件> -Encoding UTF8).Count`（**含空行**，与 §1 口径一致）；注释行 = `TrimStart()` 后以 `//`、`/*`、`*` 开头的行；密度 = 注释行 / 行数。
> 复测结果：`src/wasm-core` 11166 / 1191 / 11%、`src/ts-shared` 7109 / 2170 / 31%、`apps/debug/src` 13321 / 3678 / 28%、`apps/game/src` 6617 / 1921 / 29%、`apps/viewer/src` 6719 / 1542 / 23% —— 与上表逐项一致，未改动。
> 仅 `src/phys` 一行因 WG1 首件（`mod.rs` 注释重写）由 3763 / 587 / 16% 变为 **3946 / 755 / 19%**，已按实测更新。
> 注意陷阱：`Get-Content | Measure-Object -Line` **不统计空行**，同一文件可比 `.Count` 少约 7%（实测 `shared-state.ts`：`.Count` 1033 vs `-Line` 956）。规模数字一律用 `.Count`。

---

## 10. 已确认的不一致事实（重编必须修正）

| # | 类型 | 事实 | 证据 |
|---|---|---|---|
| 1 | 文档 ↔ 文档（**历史**） | 旧根 README 与旧导航索引的篇数口径互相冲突：前者称 24 篇（顶层 6 篇、debug 6 / game 5 / viewer 7），后者称 47 篇（根 11 + debug 7 + game 14 + viewer 8 + 已退役 harness 7）。两文件均已从工作区删除，冲突随之消灭——**新导航由 WG10 按最终实际文件重建**，不得沿用旧口径 | 历史记录（两文件已删除，仅存 git 历史，无法回读） |
| 2 | 代码 ↔ 注释 | `src/phys/mod.rs` 头注称"导出 **12 个 API**"，实际 `#[wasm_bindgen] impl PhysWorld` 有 **24 个公开方法**（含 `new`），且未提 `state_out_ptr` / `gate_veto_count` / `debug_trace` / `set_spawn_points` / `teleport_to_spawn` / `set_state` / `set_velocity` / `set_yaw_pitch` | `src/phys/mod.rs:4-6` vs `src/phys/mod.rs:92-548` |
| 3 | 文档 ↔ 仓库（**历史**） | 旧工程实现文档曾大量引用 `test/game-core/**`（该本地工程不在版本库、当前也不在工作区），是当时路径失效的主要来源之一。旧文档已删除；现行控制文件与后续新稿不得再出现该路径 | 历史记录（相关旧文档已删除，仅存 git 历史） |
| 4 | 文档 ↔ 路径（**历史**） | 旧文档多处引用**已迁移的 wasm-bindgen 安装脚本**：旧路径在 debug 工程的 scripts 目录下，实际现位于共享层 `src/scripts/`。引用它的旧文档（CHANGELOG 与框架审计篇）均已删除 | `src/scripts/install-wasm-bindgen.cmd`（存在）；历史记录见 git 历史 |
| 5 | 锚点健康 | 现存文档树漂移体检（**本次实测**，全仓 9 篇 md）：**行数声明 0（漂移 0）/ 锚点 80（越界 0）/ 路径失效 0 / 歧义未判 15**（其中本文件 63 锚点、歧义 12）。历史口径（旧文档树尚在时）：68 篇 md / 行数声明 159 / 锚点 2230 / 路径失效 171 / 歧义 456 —— **该口径已失效**，不得再作基线 | `node src/scripts/check-doc-drift.mjs` 本次实测 |
| 6 | 路径失效重灾区（**历史**） | 旧文档树曾有 5 篇计划/实现篇集中出现路径失效（单篇 15–55 条），根因是指向已删除或已迁移的旧文件。旧文档已全部删除，本项仅作历史记录，不再需要逐条修正 | 历史记录（旧文档已删除，无法回指） |

---

## 11. 术语基线（详见任务书 §6）

| 术语 | 含义（本次读码确认） |
|---|---|
| 权威帧 | Worker 侧固定 64Hz 模拟输出的状态帧（位置/朝向/速度/眼高/着地/时间戳），经 SAB 双缓冲发布 |
| 预测线 | 主线程全速物理 + 渲染，读权威帧做速度对齐（位置不强制同步） |
| SAB | SharedArrayBuffer：game/debug 512B（原 harness 的 192B 布局随工程退役，不再作为口径） |
| 解耦线 / 耦合线 / tick 线（**已退役**） | 原为 harness 三模式对照的术语，消费方随退役工程删除；共享层 `src/ts-shared/decoupled/decoupled-loop.ts` 仍在，其语义需另行读码取证 |
| 槽 / slot | SAB 内按 `i32`/`i64`/`f64` 索引的字段位置（如 `state_out` 22 槽） |
| HU | Hammer Unit，Source 地图单位（hull 16/72/54、eye 64.09/46.04 均为 HU） |
| BSP lump | BSP 文件的 64 个目录项；`ident` 非 0 表示 LZMA |
| sprp | static props game lump（V10 72B / V11 80B） |
| lightmap / ambient cube | world 面烘焙光照（lump8 LDR / lump53 HDR）与 leaf ambient cube（prop 静态光照） |
| RGBExp32 | Source 的颜色指数编码：RGB=mantissa、A=exp+128 |
| mosaic / MTZ | 纹理压缩 DSL（v4）与其容器格式（默认纹理包 `textures.mtz`） |

---

## 12. 主流程与时序骨架（**源码取证；开工前必读**）

> 本节全部来自源码阅读，用以建立"地图 → 显示"的整体骨架；重编任何文件前先按 §13 顺序读码，再动笔。
> 以 `apps/game`（唯一物理线在主线程 + Worker 仅权威帧）为主线；viewer 的支线差异见 §12.3，原 harness 已退役（见 §5）。

### 12.1 地图 → 显示（apps/game 主线）

| # | 阶段 | 代码落点 |
|---|---|---|
| 1 | 用户选本地 `.bsp` → `handleLoadBsp(fileName, bytes)`；按地图名加载存点、隐藏面板 | `apps/game/src/app.ts:483-493` |
| 2 | 等主线程 wasm 就绪（`decompress_mtz` 依赖）→ 释放旧场景 | `apps/game/src/app.ts:495-497` |
| 3 | **解析**：`buildWorldBundle(new BspProcessor(bytes), {decompressMtz, onProgress})` —— 元数据 → spawn/teleport/PVS → 碰撞体（brush + 模型三角形）→ mosaic manifest → 缺失纹理（debug）→ 默认纹理包回退 → **GLB 导出** → 出生点解析 | `apps/game/src/app.ts:502-505`；`src/ts-shared/phys/world-builder.ts:4-9,22-35` |
| 4 | **建渲染场景**：`renderer.loadScene({glb, spawnJson, pvsJson, mosaicManifest, metadata, spawn, ...})` | `apps/game/src/app.ts:509-520` |
| 4.1 | GLTFLoader 解析 → **先中和 `KHR_lights_punctual`**（挂场景前） | `apps/game/src/renderer/renderer-main.ts:306` |
| 4.2 | **离线烘焙光照施加**（lightmap atlas）—— 必须在 `optimizeScene` **之前** | `renderer-main.ts:335` |
| 4.3 | `optimizeScene` 空间分块合并（117 meshes / 34409 primitives / 377385 顶点 → 按材质聚类） | `renderer-main.ts:346`、`renderer-main.ts:44-48` |
| 4.4 | 合并后终扫：仍带受光材质的 mesh 统一转 Basic / 全亮兜底（合并会重建材质数组） | `renderer-main.ts:348-352` |
| 4.5 | mosaic 画质 manifest 应用 | `renderer-main.ts:379-380` |
| 5 | **建主线程物理世界**（渲染线）：`renderer.buildPredictionWorld({brushJson, triJson, teleportJson, spawn})` | `apps/game/src/app.ts:524-529`；`renderer-main.ts:656` |
| 6 | **发权威世界给 Worker**：`postMessage({type:'world-json', ...})`；顺序为"主线程世界建完再发"（并行反而更慢，实测） | `apps/game/src/app.ts:532-552` |
| 7 | 双端出生点列表 + 参数同步（防两端分叉）→ `sceneReady = true` | `apps/game/src/app.ts:558-563` |
| 8 | **帧循环**（rAF）：主线程 `startInputLoop` 取 `keyState → keysToMask`，Q/E 转等效鼠标增量，`renderer.feedInput(dx, dy, mask)` | `apps/game/src/app.ts:371-408`（尤其 `:388-401`） |
| 9 | `RendererMain.tick`：输入写 SAB → `correctFromAuthority()`（读权威帧）→ `calibrateVelocity()` → `predPhys.tick(dt, keys, dx, dy)` → 读 `state()` → 写渲染采样 → 相机 `rotation/position`（**y+eyeHeight**）→ 更新 near plane | `apps/game/src/renderer/renderer-main.ts:880-925` |
| 10 | 绘制：three `render()`（相机高度 = `posY + eyeHeight`，眼高由物理侧 `eye_height()` 给出） | `renderer-main.ts:919-925`；`src/phys/player.rs:191-206` |

### 12.2 权威帧 ↔ 预测线时序（v7）

```
主线程 rAF ── feedInput ──▶ SAB 输入槽（keys/dx/dy 累加）
                              │
Worker（权威，固定 64Hz）──────┘ 消费输入 → tick → 写 S_A[V_A&1] → release V_A++
                              │
主线程 ◀── 读 S_A[(V_A-1)&1] ──┘ correctFromAuthority → calibrateVelocity（速度对齐，位置不覆盖）
      → predPhys.tick（本地全速）→ 渲染
```

- 权威侧：固定 64Hz 模拟，输出 pos/yaw/pitch/vel/eyeHeight/onGround/timeMs（定标见 §3.3）
- 预测侧：全速渲染；**位置不强制同步**，仅速度渐进对齐（`renderer-main.ts:885-899`）
- 解耦线 / tick 线原为 harness 的扩展模式，随该工程退役；game 只用权威/预测双线

### 12.3 另两条支线

| 工程 | 主线差异 |
|---|---|
| `apps/viewer` | 无物理：BSP → GLB → 场景 → 自由飞行相机；`.replay` 导入后按帧序列播放（坐标映射 + 人工变换），播放控制 API `window.viewer.replay` |
| `apps/debug` | 与 game 同构的加载/帧循环，另加权威帧计算器工作台、碰撞可视化、参数面板、路径记录 |
| `test/dual-mode-harness` | **已退役**：原为三模式（coupled / decoupled / tick）热切 + 192B 共享区对照；工程已从工作区删除，仅存 git 历史 |

---

## 13. 必读源码清单（重编开工顺序，共 **11** 个入口，禁止跳过）

| 序 | 文件 | 读它要回答什么 |
|---|---|---|
| 1 | `apps/game/src/app.ts` | 装配顺序、加载流程、输入循环、快捷键与面板状态机 |
| 2 | `src/ts-shared/phys/world-builder.ts` | BSP 字节 → WorldBundle 的阶段划分与产物字段 |
| 3 | `apps/game/src/worker/main.ts` | Worker 只做什么（权威帧）、消息协议 |
| 4 | `apps/game/src/renderer/renderer-main.ts` | 场景挂载、光照施加顺序、optimizeScene、帧循环与相机 |
| 5 | `src/ts-shared/auth/shared-state.ts` | SAB 512B 布局、定标、读写协议 |
| 6 | `src/phys/mod.rs` + `src/phys/player.rs` + `src/phys/world.rs` | 物理导出面、移动语义、碰撞结构 |
| 7 | `apps/game/crates/wasm/src/lib.rs` | `BspProcessor` 导出面（解析/导出 API） |
| 8 | `src/wasm-core/lib.rs` 与 `vbsp/`、`bsp_to_gltf_core/` | 解析与 GLB 导出的模块边界 |
| 9 | `apps/game/src/panel/panel-controller.ts` + `apps/game/src/input/keymap.ts` | 面板模块与键位持久化 |
| 10 | `apps/viewer/src/app.ts` + `apps/viewer/src/replay/*` | viewer 主线与回放管线 |
| 11 | 各工程 `package.json` / `scripts/*` / `.github/workflows/*` | 构建、门禁、部署（配置说明的事实来源） |

> 本清单共 **11 个入口**。原第 11 项（已退役 harness 工程的入口文件）已随工程退役移除；原第 12 项顺延为第 11 项，其余序号不变。

---

## 14. 给重编任务的直接结论

1. **先修代码注释，再修文档**：注释是文档的事实底座，§10 第 2 条说明注释已明显落后于代码。
2. **共享层优先**：`src/phys`、`src/wasm-core` 注释密度最低（16% / 11%）且被两工程共用，错误会双向放大。
3. **`test/game-core` 相关引用必须处置**：该工程不在版本库、**当前也不在工作区**（磁盘上不存在），任何文档都不得出现指向它的路径；新稿一律不引用（任务书 §3.3）。
4. **导航篇数无需再对齐旧口径**：旧根 README 与旧导航索引的篇数冲突已随两文件删除而消灭；**导航将在 WG10 按最终实际文件重建**，届时同步根 README、导航索引与各工程 README 的口径。
5. **每个文件改完即跑漂移体检**：当前基线为 9 篇 md、行数声明 0、锚点 80（**越界 0**）、路径失效 0（本文件自身 63 锚点 / 0 失效）；重编后不得低于此标准（数字见 §10 第 5 条）。
