# viewer 整体架构（BSP 地图游览 + 录像回放）

> 本文是 viewer 工程的**总览篇**。内容全部按当前代码核验落笔，关键论断标注来源（`文件:行号`）；
> 核心时序见 [sequences.md](sequences.md)，细分实现见 [implementation/](implementation/)，
> 与 debug/game/test 及共享层的取舍差异见 [differences.md](differences.md)，
> .replay 二进制格式规格见 [implementation/shavit-replay-format.md](implementation/shavit-replay-format.md)。
> 使用说明（操作键位 / 打包部署 / 故障排查）见工程根 [../../viewer/README.md](../../viewer/README.md)。

## 1. 定位：无物理的"看"工程

viewer 是 WebSurf 四工程里**唯一不含物理系统**的工程，只做两件事：

1. **BSP 地图导入 → GLB 场景 + 自由飞行相机**（纯视觉，无碰撞）；
2. **导入 Shavit `.replay` 录像，二进制原生解析后回放**（纯观察，不重演物理；播放基准 = 帧自身坐标）。

代码自证：

- `apps/viewer/package.json:4`——工程描述："WebSurf-viewer — 最小 BSP 自由视角查看器：BSP → GLB 场景 + 自由飞行相机 + Shavit .replay 录像回放（帧自身坐标直读 + 坐标映射切换 + 变换调整 + 播放控制 API）"。
- `apps/viewer/src/worker/main.ts:1-8`（Worker 头注）："Shavit `.replay` 原生解析，产出定型数组零拷贝回传……t4 起 JSON 解析通道已移除——这是唯一的录像导入路径：先按魔数嗅探（在 file.text() 之前），非 `.replay` 明确报错"。
- `apps/viewer/src/replay/types.ts:1-6`（数据契约头注）："管线：Shavit `.replay`（原生解析，t4 起 JSON 通道已移除）→ Clip（定型数组）→ 播放器。播放基准 = 帧自身坐标"。
- `apps/viewer/crates/wasm/Cargo.toml:5`（WASM crate 头部注释）："不含 websurf-phys（无物理）、不含 mosaic/缺失纹理/默认纹理包（纯视觉查看器）"；`:19` 依赖只有 `websurf-wasm-core = { path = "../../../../src/wasm-core" }`。
- `apps/viewer/crates/wasm/src/lib.rs:1-9`（crate 头注）：运行时最小集 = `metadata()` / `parse_spawn_points()` / `export_glb_with_pakfile_models()` 三个方法，"自由视角查看器不需要 brush/模型碰撞/teleport/PVS/mosaic/默认纹理包，均不导出"。
- TS 侧无 SAB/原子：`grep SharedArrayBuffer|Atomics apps/viewer/src apps/viewer/crates` → 空（对比 debug/game 的权威帧双线，见 [differences.md](differences.md) §2）。
- TS 侧不引 ts-shared：`apps/viewer/src` 无任何 `ts-shared` import（唯一出现是 `apps/viewer/src/core/pose.ts:11` 注释里"与 ts-shared bspYawToCsYaw 一致"的对照说明——该函数仅服务 BSP 出生点路径，与 .replay 无关）。

一切取舍以这两件事为标准：不做的功能直接不存在（如 fog、PVS、LOD、传送点、存点、计时）。

## 2. 运行形态与构建链

| 环节 | 命令 | 产物 | 来源 |
|---|---|---|---|
| WASM 构建 | `npm run build:wasm` | `viewer/pkg/websurf_viewer_wasm.*`（wasm-pack release、target web），并把 `*_bg.wasm` 拷到 `web/` | `apps/viewer/package.json:8` |
| TS 检查 | `npm run typecheck` | `tsc --noEmit`（strict，`tsconfig.json:1-16`） | `apps/viewer/package.json:9` |
| 自检（Node） | `npm run test:replay` | esbuild bundle → `temp/replay-selftest.mjs` → 运行（153 项断言） | `apps/viewer/package.json:10` |
| 冒烟（真浏览器） | `npm run test:smoke` | CDP 驱动本机 Edge headless（需 dev server） | `apps/viewer/package.json:11` |
| Worker 产物 | `npm run build:worker` | `web/worker.js`（esbuild ESM bundle） | `apps/viewer/package.json:12` |
| TS 产物 | `npm run build:ts` | `web/app.js`（esbuild bundle；前置 typecheck 与 worker bundle） | `apps/viewer/package.json:13` |
| 单文件打包 | `npm run build:dist` | `viewer/dist/`：IIFE `app.js` 内嵌 WASM(base64)+Worker 代码、classic `index.html`、`assets/maps/surf_null_4.replay` 示例、serve.py、play.cmd/play.sh | `apps/viewer/package.json:15`、`apps/viewer/scripts/build-dist.mjs:1-16` |
| 本地开发 | `npm run dev` | `python ../src/serve.py 8080 .`（共享 dev 服务器） | `apps/viewer/package.json:16` |

- **唯一产物形态是 single**：dist-multi 分支已于 2026-09 移除（`apps/viewer/scripts/build-dist.mjs:13`"dist-multi / --multi / --bsp 分支已移除（2026-09：单一 dist 策略）"）。
- **产物不入库**：`apps/viewer/web/app.js`、`apps/viewer/web/worker.js`、`apps/viewer/web/websurf_viewer_wasm_bg.wasm`、`pkg/`、自检中间产物 `temp/` 均被 ignore（`apps/viewer/.gitignore:1-7`）；git 只跟踪 `apps/viewer/web/index.html`、`apps/viewer/web/styles.css`（`git ls-files apps/viewer/web`）。打开 `web/index.html` 前必须先构建。
- **示例录像入库例外**：`maps/surf_null_4.replay`（原生 Shavit 录像，53 KB）是 dist 示例深链资产 + `test:replay` fixture，根 `.gitignore:32-39` 加了 `!maps/surf_null_4.replay` 例外强制入库（其余 `maps/*` 与 `*.replay` 仍忽略）；`maps/surf_null_4.replay.json`/`.rule.json` 已删且**不再需要**（JSON 通道已移除）。
- **资源兜底**：`web/index.html:91-107` 有一个 capture-phase 的 `window.error` 监听——`app.js`/wasm 缺失（未构建就打开页面）时直接把"请先运行 npm install → npm run build:wasm → npm run build:ts"写进 `#fatal` 兜底卡。
- **file:// 双击可用**的实现要点：WASM 以 base64 内嵌 `globalThis.__VBSP_WASM_B64__`（`apps/viewer/src/core/bsp.ts:44-51`）、Worker 代码内嵌 `globalThis.__VBSP_WORKER_JS__` 经 Blob URL 启动（`apps/viewer/src/replay/importer.ts:42-52`）、入口用 classic script（module script 会被 file:// CORS 拦截，`apps/viewer/scripts/build-dist.mjs:5`）。断言见冒烟自检 `apps/viewer/test/smoke-cdp.mjs:127-166`（dist 结构静态断言节）。

## 3. 分层架构

```
┌─ 浏览器页面（apps/viewer/web/index.html，仅 DOM 骨架 + 样式，git 跟踪）─┐
│  #game canvas / #hud / #sidebar(地图|录像) / #dock(录像信息条+时间轴) │
└───────────────┬─────────────────────────────────────────────────────┘
                │ <script src="./app.js">（esbuild 产物）
┌───────────────▼ TS 主线程（apps/viewer/src）────────────────────────────┐
│ app.ts（496 行）  装配 + 事件接线 + 深链 + window.viewer.replay + 帧循环 │
│ ├─ core/  scene(渲染·分块合并·near/far) fly(飞行相机) pose bsp(加载)  │
│ │         constants dom(DOM 工具)                                    │
│ ├─ ui/    hud(三行状态域·引导·帮助) mapinfo(地图信息·出生点)          │
│ │          replaymeta(录像信息条：Clip.meta 渲染)                     │
│ │          telemetry(速度 HUD[可视区中心]+timeline 右列按键)        │
│ ├─ replay/ 13 个模块：.replay 原生解析→Clip→播放·多轨迹·可视化·面板    │
│ └─ worker/main.ts ──(esbuild)──> web/worker.js         │
└───────┬──────────────────────────────────────────────┬──────────────┘
        │ fetch wasm + initSync（core/bsp.ts:41-68）     │ Worker 消息
┌───────▼ Rust WASM（apps/viewer/crates/wasm，薄导出层）─────▼──────────────┐
│ BspProcessor：metadata / parse_spawn_points / export_glb_with_pakfile │
│ （解析本体全部来自共享 crate websurf-wasm-core，见 §5）               │
└──────────────────────────────────────────────────────────────────────┘
```

- 渲染循环是**单线程**的：`apps/viewer/src/app.ts:413-449`（`frame`）每帧做「主时钟推进 → 相机驱动 → 可视化更新 → `scene.render()`」，没有物理 tick、没有权威 Worker（对比 debug/game 的双线时序见根架构篇）。
- 唯一的 Web Worker 是**录像解析 Worker**（`apps/viewer/src/worker/main.ts:1-8` 头注，上引），起不来会自动回退主线程同源链路（`apps/viewer/src/replay/importer.ts:106-109`）。

## 4. 模块划分（实测行数）

| 层 | 文件 | 行数 | 职责（一句话） | 详见 |
|---|---|---|---|---|
| 装配 | `src/app.ts` | 496 | 顶层装配：场景/相机/HUD/侧栏、BSP 与录像事件接线、拖拽与深链、`window.viewer.replay`（含 `meta()`）、帧循环 | [sequences.md](sequences.md) §1-§5 |
| core | `src/core/scene.ts` | 416 | three.js renderer/scene/camera、GLB 挂载、空间分块合并、近平面贴墙自适应 | [implementation/scene-core.md](implementation/scene-core.md) §1 |
| core | `src/core/fly.ts` | 220 | 自由飞行相机：指针锁定 + 键鼠输入 + 位姿状态 | 同上 §2 |
| core | `src/core/pose.ts` | 36 | 位姿契约（脚底 + yaw/pitch 度）与 BSP 出生点 yaw 换算（wrap(src+180)，与 .replay 定标同口径；t1 修正 F6 镜像） | 同上 §3 |
| core | `src/core/spawn.ts` | 101 | 出生点解析与初始视角回退（P2-4）：spawn 实体 → bbox 内传送目标 → bbox 俯瞰，单点换算 spawnPointAng | 同上 §3.1 |
| core | `src/core/bsp.ts` | 111 | WASM 懒初始化 + `BspProcessor` 三步调用链 + 错误人话化 | [sequences.md](sequences.md) §2 |
| core | `src/core/constants.ts` | 35 | 与 game 对齐的渲染/飞行常量（EYE_STAND=64.09 等） | 同上 §3 |
| core | `src/core/dom.ts` | 136 | 面板 DOM 工具（qs/el/section/foldBox/numField…） | [implementation/scene-core.md](implementation/scene-core.md) §4 |
| ui | `src/ui/hud.ts` | 143 | 三行状态域（位姿/地图/录像）+ flash 语义 + 引导层/兜底卡/帮助浮层 | 同上 §5 |
| ui | `src/ui/mapinfo.ts` | 171 | 地图信息面板 + 出生点导航（跳转即换位姿） | 同上 §6 |
| ui | `src/ui/replaymeta.ts` | 107 | 录像信息条：`.replay` 头部元信息常驻展示（Clip.meta → 成绩/玩家/地图/tick/帧段/日期/格式） | [implementation/replay-system.md](implementation/replay-system.md) §7.4 |
| ui | `src/ui/telemetry.ts` | 93 | 遥测：速度 HUD（game 同款距底 24%，单行 横向｜竖向，Clip.vel 差分）+ 按键簇（#timeline 右列，Clip.buttons IN_* 位掩码） | 同上 §7.5 |
| replay | `src/replay/types.ts` | 164 | 数据契约：RuleConfig v2（映射切换）/ ReplayHeaderMeta / Clip（含 buttons+meta）/ Track | 同上 §1 |
| replay | `src/replay/shavit-replay.ts` | 585 | `.replay` 原生解析：嗅探/头部/帧解码/坐标定标映射/世界速度差分/V2 兼容 | 同上 §2 |
| replay | `src/replay/helpers.ts` | 17 | 角度纯函数（wrapDeg / clampPitch） | 同上 §3.1 |
| replay | `src/replay/build.ts` | 72 | transform 人工变换后处理（恒等直跳）+ LARGE_CLIP_FRAMES | 同上 §3.2 |
| replay | `src/replay/protocol.ts` | 35 | 主线程 ↔ Worker 消息协议（ClipPayload 含 buttons/meta，定型数组可转移） | 同上 §4.1 |
| replay | `src/replay/importer.ts` | 176 | 导入器：Worker 优先（Blob URL 兜底）+ 主线程同源回退（嗅探→字节缓存→原生解析） | 同上 §4.3 |
| replay | `src/replay/sampling.ts` | 80 | Clip 采样纯函数（二分定位 + 线性插值 + 最短弧） | 同上 §5.3 |
| replay | `src/replay/tracks.ts` | 110 | 多轨道容器（配色/显隐/偏移/跟随/原位替换） | 同上 §5.1 |
| replay | `src/replay/player.ts` | 206 | 播放器：主时钟 + A-B/循环/倍速/逐帧 + 采样出口 | 同上 §5.2 |
| replay | `src/replay/visuals.ts` | 174 | 3D 呈现：轨迹线（抽稀 4 万点）+ 幽灵 + 起终点标记 | 同上 §6 |
| replay | `src/replay/panel.ts` | 318 | 录像面板：导入 + 坐标映射切换 + 轨迹列表 + 调整工具（仅显式叠加） | 同上 §7.1 |
| replay | `src/replay/timeline.ts` | 330 | 底部时间轴（三行 grid：进度条+正式跑段高亮 / 主控制 / 显示开关；右列为遥测按键簇；默认窗口 = 整条 clip 含 prerun） | 同上 §7.3 |
| replay | `src/replay/trackpanel.ts` | 214 | 轨迹列表（每轨两行卡 + 批量操作） | 同上 §7.2 |
| worker | `src/worker/main.ts` | 110 | 解析 Worker：魔数嗅探（text() 前）→ 字节缓存 → 原生解析 → 零拷贝回传 | 同上 §4.2 |
| rust | `crates/wasm/src/lib.rs` | 466 | WASM 薄导出层：BspProcessor 三方法 + PAKFILE 模型/材质提取 | [sequences.md](sequences.md) §2.1 |
| 测试 | `test/replay-selftest.ts` | 831 | 录像管线 Node 自检（无 DOM，153 项断言） | 同上 §8.1 |
| 测试 | `test/smoke-cdp.mjs` | 690 | CDP 驱动真浏览器（Edge headless + SwiftShader）冒烟 | 同上 §8.2 |
| 构建 | `scripts/build-dist.mjs` | 255 | single 打包（IIFE + 内嵌 wasm/worker + 原生示例录像 + serve.py + play.cmd） | 本文 §2 |

（行数来自 `wc -l` 实测；目录中另有 `scripts/dist-README.md`——打包产物的逐文件说明，随构建入 dist。）

## 5. 与共享层的关系

| 共享层 | viewer 是否使用 | 证据 |
|---|---|---|
| `src/wasm-core`（websurf-wasm-core） | **是**：BSP 解析 / GLB 导出 / 模型与纹理解析全部来自这里，viewer crate 只是 wasm-bindgen 薄导出层 | `apps/viewer/crates/wasm/src/lib.rs:16-17`（`use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, texture_utils, vbsp}`）、`apps/viewer/crates/wasm/Cargo.toml:18-19` |
| `src/phys`（websurf-phys） | **否**：无物理 | `apps/viewer/crates/wasm/Cargo.toml:3-5` 注释 + 依赖表无此项；对比 `apps/debug/crates/wasm`、`apps/game/crates/wasm` 均 path 依赖 `../../../../src` |
| `src/ts-shared` | **否**：TS 侧零 import | `grep ts-shared apps/viewer/src` → 仅 `core/pose.ts:11` 注释提及对齐（且该式仅 BSP 路径使用） |
| `src/vendor/vmdl`（VTX 条带修复） | **是**（同款 patch） | `apps/viewer/Cargo.toml:11-13`（`[patch.crates-io] vmdl = { path = "../src/vendor/vmdl" }`，与根 `Cargo.toml:27-28` 同源） |
| `src/serve.py` | **是**（dev 服务器 + dist 内置服务器） | `apps/viewer/package.json:16`、`apps/viewer/scripts/build-dist.mjs:32-95`（打包内嵌 serve.py 文本） |

共享层自身的职责划分见根导航（[../index.md](../index.md)）与架构总篇（[../architecture.md](../architecture.md)）；websurf-wasm-core 的实现细节见其共享层文档（`documents/wasm-core.md`）。

## 6. 两条数据主线（速览）

1. **地图线**：`.bsp` 文件 → `BspProcessor`（metadata → spawn → GLB，**消费顺序固定**，`apps/viewer/src/core/bsp.ts:1,78`）→ Blob URL → GLTFLoader → 空间分块合并 → 相机自适应 → 渲染。逐帧细节见 [sequences.md](sequences.md) §2。
2. **录像线**：Shavit `.replay`（二进制）→ 三入口先魔数嗅探（文件选择 / 拖拽 / 深链；在 `file.text()` 之前）→ `parseShavitReplay` 原生解析（头部 14 字段元信息 + 帧解码 + 坐标定标映射 + 世界速度差分）→ `Clip`（定型数组，Worker 零拷贝回传）→ 播放器主时钟采样（主时钟 0 = 起跑帧）→ 轨迹线/幽灵/第一人称相机 + 录像信息条/时间轴。**播放基准 = 帧自身坐标**（无起点锚定；平移/映射切换仅用户显式叠加）。逐帧细节见 [sequences.md](sequences.md) §3-§4，规格见 [implementation/shavit-replay-format.md](implementation/shavit-replay-format.md)。

两条线在 **viewer 世界坐标**上会合：BSP 出生的 GLB 与出生点都落在 `map_coords` 的 Y-up 空间（`src/wasm-core/bsp_to_gltf_core/convert.rs:813-816`、`src/wasm-core/model_integrator/mod.rs:1041-1045`），录像帧坐标走同一 `[y,z,x]` 映射（`apps/viewer/src/replay/shavit-replay.ts:481`）——所以 Shavit 帧的绝对世界坐标可直接与场景对齐（HUD 包围盒外提醒 `apps/viewer/src/app.ts:157-188` 只用于暴露映射错误）。

## 7. 文档树

```
documents/viewer/
├── overview.md                        ← 本文（总览）
├── sequences.md                       ← 核心时序
├── implementation/
│   ├── scene-core.md                  ← 场景/相机/常量/面板基建
│   ├── replay-system.md               ← 录像回放全系统（原生 .replay 管线）
│   └── shavit-replay-format.md        ← Shavit .replay 二进制格式规格（t2 研究 + 实测）
├── differences.md                     ← 核心差异
├── replay-rule-ai.md                  ← 历史注记（.js 规则脚本通道已于 2026-09 移除）
└── archive/                           ← 旧版文档（2026-09 重编纂归档，仅背景参考）
```
