# viewer 整体架构（BSP 地图游览 + 录像回放）

> 本文是 viewer 工程的**总览篇**。内容全部按当前代码核验落笔，关键论断标注来源（`文件:行号`）；
> 核心时序见 [sequences.md](sequences.md)，细分实现见 [implementation/](implementation/)，
> 与 debug/game/test 及共享层的取舍差异见 [differences.md](differences.md)，
> AI 转化脚本规范见 [replay-rule-ai.md](replay-rule-ai.md)。
> 使用说明（操作键位 / 打包部署 / 故障排查）见工程根 [../README.md](../README.md)。

## 1. 定位：无物理的"看"工程

viewer 是 WebSurf 五工程里**唯一不含物理系统**的工程，只做两件事：

1. **BSP 地图导入 → GLB 场景 + 自由飞行相机**（纯视觉，无碰撞）；
2. **导入 JSON 录像，按规则脚本映射成标准帧后回放**（纯观察，不重演物理）。

代码自证：

- `viewer/package.json:4`——工程描述："最小 BSP 自由视角查看器：BSP → GLB 场景 + 自由飞行相机 + 录像回放（规则脚本 + 变换调整 + 播放控制 API）"。
- `viewer/crates/wasm/Cargo.toml:5`（WASM crate 头部注释）："不含 websurf-phys（无物理）、不含 mosaic/缺失纹理/默认纹理包（纯视觉查看器）"；`:19` 依赖只有 `websurf-wasm-core = { path = "../../../src/wasm-core" }`。
- `viewer/crates/wasm/src/lib.rs:1-9`（crate 头注）：运行时最小集 = `metadata()` / `parse_spawn_points()` / `export_glb_with_pakfile_models()` 三个方法，"自由视角查看器不需要 brush/模型碰撞/teleport/PVS/mosaic/默认纹理包，均不导出"。
- TS 侧无 SAB/原子：`grep SharedArrayBuffer|Atomics viewer/src viewer/crates` → 空（对比 debug/game 的权威帧双线，见 [differences.md](differences.md) §2）。
- TS 侧不引 ts-shared：`viewer/src` 无任何 `ts-shared` import（唯一出现是 `viewer/src/core/pose.ts:11` 注释里"与 ts-shared bspYawToCsYaw 一致"的对照说明）。

一切取舍以这两件事为标准：不做的功能直接不存在（如 fog、PVS、LOD、传送点、存点、计时）。

## 2. 运行形态与构建链

| 环节 | 命令 | 产物 | 来源 |
|---|---|---|---|
| WASM 构建 | `npm run build:wasm` | `viewer/pkg/websurf_viewer_wasm.*`（wasm-pack release、target web），并把 `*_bg.wasm` 拷到 `web/` | `viewer/package.json:8` |
| TS 检查 | `npm run typecheck` | `tsc --noEmit`（strict，`tsconfig.json:1-16`） | `viewer/package.json:9` |
| Worker 产物 | `npm run build:worker` | `web/parse-worker.js`（esbuild ESM bundle） | `viewer/package.json:12` |
| TS 产物 | `npm run build:ts` | `web/app.js`（esbuild bundle；前置 typecheck 与 worker bundle） | `viewer/package.json:13` |
| 单文件打包 | `npm run build:dist` | `viewer/dist/`：IIFE `app.js` 内嵌 WASM(base64)+Worker 代码、classic `index.html`、serve.py、play.cmd/play.sh | `viewer/package.json:15`、`viewer/scripts/build-dist.mjs:1-16` |
| 本地开发 | `npm run dev` | `python ../src/serve.py 8080 .`（共享 dev 服务器） | `viewer/package.json:16` |

- **唯一产物形态是 single**：dist-multi 分支已于 2026-09 移除（`viewer/scripts/build-dist.mjs:13`"dist-multi / --multi / --bsp 分支已移除（2026-09：单一 dist 策略）"）。
- **产物不入库**：`viewer/web/app.js`、`viewer/web/parse-worker.js`、`viewer/web/websurf_viewer_wasm_bg.wasm`、`pkg/` 均被 ignore（`viewer/.gitignore:1-5`、根 `.gitignore:9-12`）；git 只跟踪 `viewer/web/index.html`、`viewer/web/styles.css`（`git ls-files viewer/web`）。打开 `web/index.html` 前必须先构建。
- **资源兜底**：`web/index.html:91-107` 有一个 capture-phase 的 `window.error` 监听——`app.js`/wasm 缺失（未构建就打开页面）时直接把"请先运行 npm install → npm run build:wasm → npm run build:ts"写进 `#fatal` 兜底卡。
- **file:// 双击可用**的实现要点：WASM 以 base64 内嵌 `globalThis.__VBSP_WASM_B64__`（`viewer/src/core/bsp.ts:44-51`）、Worker 代码内嵌 `globalThis.__VBSP_WORKER_JS__` 经 Blob URL 启动（`viewer/src/replay/importer.ts:41-50`）、入口用 classic script（module script 会被 file:// CORS 拦截，`viewer/scripts/build-dist.mjs:5`）。断言见冒烟自检 `viewer/test/smoke-cdp.mjs:128-143`。

## 3. 分层架构

```
┌─ 浏览器页面（viewer/web/index.html，仅 DOM 骨架 + 样式，git 跟踪）─┐
│  #game canvas / #hud / #sidebar(地图|录像) / #timeline / 引导层·兜底卡 │
└───────────────┬──────────────────────────────────────────┘
                │ <script src="./app.js">（esbuild 产物）
┌───────────────▼ TS 主线程（viewer/src）────────────────────────────┐
│ app.ts（495 行）  装配 + 事件接线 + 深链 + window.viewer.replay + 帧循环 │
│ ├─ core/  scene(渲染·分块合并·near/far) fly(飞行相机) pose bsp(加载)  │
│ │         constants dom(DOM 工具)                                    │
│ ├─ ui/    hud(三行状态域·引导·帮助) mapinfo(地图信息·出生点) reference │
│ ├─ replay/ 16 个模块：规则脚本→标准帧→Clip→播放·多轨迹·可视化·面板     │
│ └─ worker/parse-worker.ts ──(esbuild)──> web/parse-worker.js         │
└───────┬──────────────────────────────────────────────┬──────────────┘
        │ fetch wasm + initSync（core/bsp.ts:41-68）     │ Worker 消息
┌───────▼ Rust WASM（viewer/crates/wasm，薄导出层）─────▼──────────────┐
│ BspProcessor：metadata / parse_spawn_points / export_glb_with_pakfile │
│ （解析本体全部来自共享 crate websurf-wasm-core，见 §5）               │
└──────────────────────────────────────────────────────────────────────┘
```

- 渲染循环是**单线程**的：`viewer/src/app.ts:447-483`（`frame`）每帧做「主时钟推进 → 相机驱动 → 可视化更新 → `scene.render()`」，没有物理 tick、没有权威 Worker（对比 debug/game 的双线时序见根架构篇）。
- 唯一的 Web Worker 是**录像解析 Worker**（`viewer/src/worker/parse-worker.ts:1-6`："录像解析 Worker：JSON.parse + 帧数组定位 + 应用规则脚本，产出定型数组零拷贝回传"），起不来会自动回退主线程（`viewer/src/replay/importer.ts:104-107`）。

## 4. 模块划分（实测行数）

| 层 | 文件 | 行数 | 职责（一句话） | 详见 |
|---|---|---|---|---|
| 装配 | `src/app.ts` | 495 | 顶层装配：场景/相机/HUD/侧栏、BSP 与录像事件接线、拖拽与深链、`window.viewer.replay`、帧循环 | [sequences.md](sequences.md) §1-§4 |
| core | `src/core/scene.ts` | 416 | three.js renderer/scene/camera、GLB 挂载、空间分块合并、近平面贴墙自适应 | [implementation/scene-core.md](implementation/scene-core.md) §1 |
| core | `src/core/fly.ts` | 220 | 自由飞行相机：指针锁定 + 键鼠输入 + 位姿状态 | 同上 §2 |
| core | `src/core/pose.ts` | 25 | 位姿契约（脚底 + yaw/pitch 度）与 BSP yaw 换算 | 同上 §3 |
| core | `src/core/bsp.ts` | 111 | WASM 懒初始化 + `BspProcessor` 三步调用链 + 错误人话化 | [sequences.md](sequences.md) §2 |
| core | `src/core/constants.ts` | 35 | 与 game 对齐的渲染/飞行常量（EYE_STAND=64.09 等） | 同上 §3 |
| core | `src/core/dom.ts` | 136 | 面板 DOM 工具（qs/el/section/foldBox/numField…） | [implementation/scene-core.md](implementation/scene-core.md) §4 |
| ui | `src/ui/hud.ts` | 143 | 三行状态域（位姿/地图/录像）+ flash 语义 + 引导层/兜底卡/帮助浮层 | 同上 §5 |
| ui | `src/ui/mapinfo.ts` | 165 | 地图信息面板 + 出生点导航（跳转即换位姿） | 同上 §6 |
| ui | `src/ui/reference.ts` | 77 | 地面网格（512 HU 一格）+ 世界坐标轴开关 | 同上 §6 |
| replay | `src/replay/types.ts` | 205 | 数据契约：RuleConfig / Frame / Clip / Track + 默认值 | [implementation/replay-system.md](implementation/replay-system.md) §1 |
| replay | `src/replay/helpers.ts` | 145 | 规则脚本助手 H（get/num/wrap…）+ 帧数组自动探测 | 同上 §2 |
| replay | `src/replay/codegen.ts` | 74 | 规则脚本编译（new Function 单表达式）+ 三帧试跑校验 | 同上 §3 |
| replay | `src/replay/build.ts` | 230 | 帧序列 → Clip（定型数组）+ transform 后处理 | 同上 §4 |
| replay | `src/replay/default-rule.ts` | 31 | 内置默认规则脚本（自家标准格式直通，tick 128） | [replay-rule-ai.md](replay-rule-ai.md) §7 |
| replay | `src/replay/rule-file.ts` | 32 | 规则文件双形态判定（规则 JSON / 裸 .js） | 同上 §6 |
| replay | `src/replay/protocol.ts` | 31 | 主线程 ↔ Worker 消息协议（定型数组可转移） | 同上 §6 |
| replay | `src/replay/sample.ts` | 59 | 合成示例录像（走完整导入管线的自测/演示） | 同上 §9 |
| replay | `src/replay/visuals.ts` | 174 | 3D 呈现：轨迹线（抽稀 4 万点）+ 幽灵 + 起终点标记 | 同上 §7 |
| replay | `src/replay/sampling.ts` | 80 | Clip 采样纯函数（二分定位 + 线性插值 + 最短弧） | 同上 §5 |
| replay | `src/replay/tracks.ts` | 110 | 多轨道容器（配色/显隐/偏移/跟随） | 同上 §5 |
| replay | `src/replay/player.ts` | 206 | 播放器：主时钟 + A-B/循环/倍速/逐帧 + 采样出口 | 同上 §5 |
| replay | `src/replay/panel.ts` | 486 | 录像面板：导入 + 规则脚本 + 轨迹列表 + 变换调整 | 同上 §8 |
| replay | `src/replay/timeline.ts` | 251 | 底部时间轴（播放控制/倍速/视角/A-B/速度读数） | 同上 §8 |
| replay | `src/replay/trackpanel.ts` | 214 | 轨迹列表（每轨两行卡 + 批量操作） | 同上 §8 |
| worker | `src/worker/parse-worker.ts` | 130 | 解析 Worker：缓存 JSON 根 → 定位帧 → 规则映射 → 零拷贝回传 | 同上 §6 |
| rust | `crates/wasm/src/lib.rs` | 466 | WASM 薄导出层：BspProcessor 三方法 + PAKFILE 模型/材质提取 | [sequences.md](sequences.md) §2.1 |
| 测试 | `test/replay-selftest.ts` | 421 | 录像管线 Node 自检（无 DOM，11 节） | 同上 §9 |
| 测试 | `test/smoke-cdp.mjs` | 613 | CDP 驱动真浏览器（Edge headless + SwiftShader）冒烟 | 同上 §9 |
| 构建 | `scripts/build-dist.mjs` | 258 | single 打包（IIFE + 内嵌 wasm/worker + serve.py + play.cmd） | 本文 §2 |

（行数来自 `wc -l` 实测；目录中另有 `scripts/dist-README.md`——打包产物的逐文件说明，随构建入 dist。）

## 5. 与共享层的关系

| 共享层 | viewer 是否使用 | 证据 |
|---|---|---|
| `src/wasm-core`（websurf-wasm-core） | **是**：BSP 解析 / GLB 导出 / 模型与纹理解析全部来自这里，viewer crate 只是 wasm-bindgen 薄导出层 | `viewer/crates/wasm/src/lib.rs:16-17`（`use websurf_wasm_core::{bsp_to_gltf_core, model_integrator, pakfile_models, texture_utils, vbsp}`）、`viewer/crates/wasm/Cargo.toml:18-19` |
| `src/phys`（websurf-phys） | **否**：无物理 | `viewer/crates/wasm/Cargo.toml:3-5` 注释 + 依赖表无此项；对比 `debug/crates/wasm`、`game/crates/wasm` 均 path 依赖 `../../../src` |
| `src/ts-shared` | **否**：TS 侧零 import | `grep ts-shared viewer/src` → 仅 `core/pose.ts:11` 注释提及对齐 |
| `src/vendor/vmdl`（VTX 条带修复） | **是**（同款 patch） | `viewer/Cargo.toml:11-13`（`[patch.crates-io] vmdl = { path = "../src/vendor/vmdl" }`，与根 `Cargo.toml:27-28` 同源） |
| `src/serve.py` | **是**（dev 服务器 + dist 内置服务器） | `viewer/package.json:16`、`viewer/scripts/build-dist.mjs:31-95`（打包内嵌 serve.py 文本） |

共享层自身的职责划分见根导航（[../../docs/index.md](../../docs/index.md)，集成任务产出）与架构总篇（[../../docs/architecture.md](../../docs/architecture.md)，同上）；websurf-wasm-core 的实现细节将随其共享层文档（`docs/wasm-core.md`）更新。

## 6. 两条数据主线（速览）

1. **地图线**：`.bsp` 文件 → `BspProcessor`（metadata → spawn → GLB，**消费顺序固定**，`viewer/src/core/bsp.ts:1,78`）→ Blob URL → GLTFLoader → 空间分块合并 → 相机自适应 → 渲染。逐帧细节见 [sequences.md](sequences.md) §2。
2. **录像线**：任意 JSON → 规则脚本（`.js` 单表达式 / 规则 JSON）→ 标准帧 `Frame` → `Clip`（定型数组，Worker 零拷贝回传）→ 播放器主时钟采样 → 轨迹线/幽灵/第一人称相机。逐帧细节见 [sequences.md](sequences.md) §3-§4。

两条线在 **viewer 世界坐标**上会合：BSP 出生的 GLB 与出生点都落在 `map_coords` 的 Y-up 空间（`src/wasm-core/bsp_to_gltf_core/convert.rs:813-816`、`src/wasm-core/model_integrator/mod.rs:1041-1045`），录像标准帧直接使用同一坐标语义（`viewer/src/replay/types.ts:96-105`），所以"起点对齐"检测（`viewer/src/app.ts:196-222`）才能用欧氏距离判断录像是否贴合地图。

## 7. 文档树

```
viewer/docs/
├── overview.md            ← 本文（总览）
├── sequences.md           ← 核心时序
├── implementation/
│   ├── scene-core.md      ← 场景/相机/常量/面板基建
│   └── replay-system.md   ← 录像回放全系统
├── differences.md         ← 核心差异
├── replay-rule-ai.md      ← AI 转化脚本规范（代码 tooltip 引用的入口）
└── archive/               ← 旧版文档（2026-09 重编纂归档，仅背景参考）
```
