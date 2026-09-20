# 亮面发黑（hasLightmap=false 图元被错误施加 lightmap）—— 根因与修复

> 状态：**已修复并验证（构建级 + 断言级 + 数值级 + 真实浏览器运行期级）**。
> 缺陷现象：用户第 15 轮原话「**亮面依旧还是黑的**」；第 18 轮追加线索「**默认传送底下那块地方，
> 疑似模型或者水体相关的，还是黑的**」；第 23 轮「**模型还是看不见，完全看不到，完全透明的，
> 但是有碰撞**」。本文件记录**三轮**根因的完整判据链。
>
> ⚠️ **先看 [§8](#8-第三轮根因最终2026-09-20注入单元漏声明-uniform--fragment-编译失败--模型整批不渲染)** ——
> 那才是「模型完全透明」的根因（GLSL 编译失败 ⇒ 整批 mesh 一个像素都不画），
> 前两轮（§0 零灯 Standard 材质恒黑、§1 中性占位 UV 采到图集原点）是**发黑**，
> 本轮是**不渲染**，症状与判据都不同。

## 0. 第二轮根因（2026-09-20 追加）

**`MeshStandardMaterial` + 零灯 ⇒ 恒渲染纯黑。**

- 本工程**刻意不加任何灯**：三点光 `LEGACY_THREE_POINT_LIGHTS = false`，GLB 携带的 2000+ 盏
  punctual 灯全部从场景树摘除（`renderer-main.ts` §1.1，理由见
  [scene-brightness-and-lights.md](scene-brightness-and-lights.md) §2）。
- 而 GLTFLoader 对**没有 `KHR_materials_unlit` 的 PBR 材质**一律给 `MeshStandardMaterial`；
  这类材质在零灯/无环境贴图下只剩 `emissive`，GLB 里是 `[0,0,0]` ⇒ **黑**。
- `applyLightmapToMeshes` 的分支只覆盖三种情况（`hasLightmap === false` / `=== true` 且带 uv1 /
  无 uv1&uv2）；**`extras.hasLightmap` 缺失（`undefined`）且带 uv1** 的图元会从三条分支
  **全部漏下去**，原样保留 `MeshStandardMaterial`。
- 实测受害（surf_666 运行期清单）：**122 个图元 / 20180 顶点**，其中 47 个 `extras.unlit=true`
  的自发光 prop —— `blue_neon`×8、`neon666_01_krazyneon_00041v`×18、`glow_red_001`×5、
  `glow_yellow_008`×5、`purple_dev_neon`×4、`blue_dev_neon`×4、`69_red01`、
  `tree_deciduous_01a_branches`×2（共 16211 顶点）；外加 75 个水系/线框/派生网格
  （`dev/dev_water2`×22、`dev/dev_waterbeneath2`×23、`watersource/*`×14、
  `dev_nyro/blends/wire_white`×2 …）。**用户说的「疑似模型或者水体相关」两类都在其中。**
- 修法：`lightmap-shader.ts` 新增导出 `fullbrightUnlitLitMaterials(scene)`，在
  `renderer-main.ts` 的 `optimizeScene` **之后**、`compile` **之前**对整棵 `this.scene`
  做一次终扫：任何仍非 `MeshBasicMaterial` 的 mesh 一律收敛为 fullbright 贴图原色
  （保留 `map`/`color`/`transparent`/`opacity`/`userData.unlit`；多材质块按数组逐项替换）。
- **验证（真实浏览器运行期，非推断）**：无头 Edge + CDP 加载 surf_666，遍历 `renderer.scene`
  归类材质 —— 修复前「仍非 Basic 的 mesh = 122」，修复后 **= 0**。

### 0.1 复现取证的完整链路（沙箱内可复跑）

1. `python scripts/serve.py 8191 .` 起 dev 静态服务（`web/` 面，含 `#bspFile` 文件选择器）；
2. 无头 Edge：`msedge.exe --headless=new --remote-debugging-port=9500 --user-data-dir=<temp>`
   （**本沙箱需更宽权限**：受限模式下 Chromium 报 `FATAL: mojo platform_channel.cc:183 拒绝访问`）；
3. **一次性临时驱动**（`temp/` 下，不入库；等价在库工具 `npm run test:lightmap-frame` 在本沙箱对 CDP 无响应）：
   `node temp/real-shot.mjs --port 9500 --url http://127.0.0.1:8191/web/index.html \
   --map ../maps/surf_666.bsp --evalfile temp/eval-mat-names.js --out temp/shots/x.png`
   —— 走真实用户链路（`DOM.setFileInputFiles` 塞 `.bsp`）→ 等 `__vbspFrameProbe.ready` → 截图 + 运行期清单。

> ⚠️ 取证期间曾临时在 `installFrameProbe` 暴露 `__vbspSceneRef`，**已撤除**（当前源码不含该句柄）。

## 1. 第一轮根因：契约被违反（文件头与既有断言早已写明）

- `src/renderer/lightmap-shader.ts` 文件头：图元 `extras.hasLightmap === false` 表示该图元
  **只有中性占位 UV（无真实 luxel）**，不得施加 lightmap。
- `scripts/lightmap-gltf-assert.mjs:16`：`hasLightmap` 为 `false` 的图元其 `TEXCOORD_1`
  **必须全为中性常量 (0,0)**；`:1146` 的既有提示原本就写着「渲染端跳过」——但**它当时并没有跳过**。

## 2. 数据面事实（无头真实导出，非推断）

工具：`temp/probe-glb-materials.mjs`（`initSync` + `BspProcessor`，走前端同序
`export_mosaic_manifest` → `export_glb_with_pakfile_models_with_defaults_and_lights('{}')`），
产物 `temp/probe-glb/surf_666.glb`（162,130,364 B，导出耗时 5.6 s）。

| 项 | 实测 |
|---|---|
| `hasLightmap=true` / `uv1=true` | 33,716 |
| **`hasLightmap=false` / `uv1=true`** | **440** ← 缺陷集 |
| `hasLightmap=undefined` / `uv1=false` | 253 |
| `extras.unlit=true` 材质 | 12 个，**全部有贴图且贴图非黑**（200 张内嵌图 `maxLuma=0` 的有 0 张） |

⇒ **贴图链路与 `unlit` 标注本身是好的**（前两轮修复有效），缺陷在 lightmap 施加路径。

`hasLightmap=false` 的 440 个图元分布：`dev/dev_water2` 176、`dev/dev_waterbeneath2` 175、
`watersource/waterfall/waterfallsoft_1024_nrm_clear` 21、`metal/citadel_tilefloor016a` 15、
`watersource/river/river_clear` 15、`de_train/train_cement_floor_01` 9、
`dev_nyro/blends/wire_white` 8、`nature/water_canals03*` 12 等。

## 3. 根因（两侧对照）

| 侧 | 位置 | 行为 |
|---|---|---|
| 导出 | `crates/wasm-core/bsp_to_gltf_core/convert.rs:1004-1014` | `lightmap_region == None`（`light_offset == -1`，判定见 `lightmap.rs:326`）时**仍写 `TEXCOORD_1`**，但每个顶点值都是**中性常量 `[0,0]`**（为保住 `mergeGeometries(geoms, true)` 的属性集一致），同时置 `extras.hasLightmap=false` |
| 消费 | `src/renderer/lightmap-shader.ts`（修前） | `hasLightmap === false` 的防护**只写在「无 uv1」分支内**；而上述 440 个图元**全部带 `TEXCOORD_1`** ⇒ 防护**一次都没命中** ⇒ 它们全部以 `uv=(0,0)` 采图集 |

**决定性数值**（`temp/probe-atlas-origin.mjs`，图集 4096×2048 RGBA）：

```
★ 图集原点 (0,0) 像素 = 0,0,0   luma=0.0     ← 纯黑
       (1,1)         = 145,116,65 luma=118.9
  图集整体 mean=70.8；luma<8 的像素占 43.7%
```

⇒ 修前这 440 个图元（含**整片水面**）**每个顶点都采到纯黑**，整面塌成 `albedo × 0 = 黑`。
这就是「亮面发黑」：亮面（水面/霓虹线框/发光金属）被 lightmap 路径整片压黑。

## 4. 修复

`src/renderer/lightmap-shader.ts`：

1. 把 `hasLightmap === false` 的判定**提到 `scene.traverse` 内「检测 uv1 / uv2」之前**
   （`:401`：`if (hasLightmap === false || hasLightmap === undefined)`），命中即走 fullbright
   并 `return`，不再进入 lightmap 注入；
2. 抽出 **fullbright 唯一收敛点** `routeFullbright(mesh)`（定义 `:339`，调用 `:426`/`:436`），
   三个 fullbright 入口共用，`extras.unlit` 的「跳过 ambient cube」语义保持不变；
3. 诊断口径：新增计数 `noLightmapRouted`，日志追加
   `；其中 hasLightmap=false（中性占位 UV，必须跳过 lightmap 注入）=N`（`:528`）。

**未改 wasm、未改导出侧**：`TEXCOORD_1` 仍写中性常量（属性集一致性约束不变），
由消费侧按契约跳过——不引入几何合并回归。

## 5. 验证

| 类别 | 证据 |
|---|---|
| 语法/类型 | `npm run typecheck` exit 0 |
| 守卫（含 3 条新回归） | `test:lightmap-guard` **31/31 通过**：判定存在且在 `const hasUv1` **之前**、该分支不构造带 `lightMap` 槽的材质、收敛点定义 1 + 调用恰 2 |
| 既有 GLB 断言 | `test:lightmap-gltf` 82 条全过，自带提示「440 个图元为中性占位 UV（light_offset=-1），已置 hasLightmap=false，渲染端跳过」——**数字与本轮实测 440 完全一致** |
| 其它回归 | `check:api`（导出 17 + 物理 17 全存在）、`test:lightmap-decode`、`test:phys`、`test:seed-smoke`（7 组）、`test:surf-crouch`（3/3）全通过 |
| 产物 | `web/app.js`、`dist/app.js` 均已含修复与新增日志（`dist` 经 IIFE 压缩改名，故以日志串判定；`temp/verify-bundle.mjs`） |
| 出帧（浏览器） | **本沙箱不可用**：`lightmap-frame-capture.mjs` 两次均 `Runtime.enable 超时`（CDP 可达但渲染器无响应，与本次改动无关）。故改由数值证据（§3 图集原点 luma=0）替代，并请用户在实机复看 |

## 6. 复现与复看

```bash
cd test/game-core
npm run build:ts        # 仅 TS 改动，wasm 无需重编（本次未改 Rust）
npm run build:dist
npm run dev             # 或直接开 dist/index.html
```

预期：水面（`dev/dev_water2`）与 `dev_nyro/blends/wire_white` 等恢复为**贴图原色（fullbright）**；
控制台可见 `[lightmap] fullbright（…）mesh=N；其中 hasLightmap=false（中性占位 UV，必须跳过 lightmap 注入）=440`。

## 7. 沙箱边界（供后续自动化参考）

- `npm run build:dist` 在本沙箱内**必失败**：其打包走 esbuild **JS API** + `write:false`
  （`scripts/lib/dist-pack.mjs` 的 `bundleIife` 读 `outputFiles[0].text`，即捕获子进程管道 stdio），
  沙箱禁止 ⇒ `spawn EPERM (errno -4048)`；且 `cleanDist` 先删后建 ⇒ **`dist/` 会被清空**。
  本次用等权重建脚本 `temp/rebuild-dist.mjs` 复原：打包改由**外部** esbuild CLI 写盘
  （`--bundle --format=iife --target=es2022 --minify --legal-comments=eof "--define:import.meta.url=\"about:blank\""`），
  其余步骤原样复用 `scripts/lib/dist-pack.mjs` 的官方 helper，顺序同 `build-dist.mjs` 的 `main()`。
  **未修改任何被追踪的构建脚本**。
- Node 侧边界：脚本内再 `execFileSync` spawn 孙进程会 EPERM；由 PowerShell 直接调用则正常。
- 等价的 TS 重出（`npm run build:ts` 的产物部分）在沙箱内可直接跑：
  `node_modules/@esbuild/win32-x64/esbuild.exe src/app.ts --bundle --outfile=web/app.js --format=esm --target=es2022`
  （`npm run build:app` 因 npm→node→esbuild 三级 spawn 会 EPERM；typecheck 单独可跑）。

## 8. 第三轮根因（最终，2026-09-20）：注入单元漏声明 uniform ⇒ fragment 编译失败 ⇒ 模型整批不渲染

> 症状（用户原话）：「**模型还是看不见，完全看不到，完全透明的，但是有碰撞**」。
>
> 结论：**不是亮度、不是贴图、不是合并丢几何** —— 是 **GLSL 编译失败**：
> 该批 mesh 的 program 无效 ⇒ three 照样每帧发 draw call，但 `drawArrays` 被 GL 全部拒绝
> ⇒ **一个像素都不画**（画面里透出的是 clear color）。几何与碰撞由 Rust 侧独立生成
> ⇒ 正好是「看不见，但碰撞正常」。

### 8.1 铁证（`renderer.info.programs[].diagnostics` + 真实出帧，非推断）

```
"fragLog": "ERROR: 0:90: 'vbspLightFloor' : undeclared identifier"
"progLog": "Fragment shader is not compiled."
```

同一帧的旁证（无头 Edge + CDP 走真实加载链路，surf_666）：

| 观测 | 修前 | 修后 |
|---|---|---|
| program 总数 / 失败数 | 14 / **8** | 14 / **0** |
| `WebGL: INVALID_OPERATION: drawArrays: no valid shader program in use` | **数百条** | **0** |
| `FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)` | 4 条 | 0 |
| 控制台总条数（同一条加载链路） | 585 | 320 |
| 屏幕拾取命中材质 program 状态（画面中心下方的黑区） | **FAILED** | `ok` |
| `[ambient-cube]` 注入统计 | 全部编译失败 | **applied=1046 失败=0** |

⇒ 那块「黑」不是"画黑了"，是**根本没画**。

### 8.2 为什么会漏（结构原因）

`src/renderer/lightmap-shader.ts` 的 GLSL 注入是**两条互相独立的路径**，各自拼自己的片段：

| 路径 | 入口 | 修前的声明来源 | 是否用到 `vbspLightFloor` |
|---|---|---|---|
| world lightmap | `injectLightmapShader` | 前置声明串（**已加**） | 是（`vbsp_ApplyLightmap`） |
| ambient cube / fullbright | `applyAmbientCubeIfAny` 的 `ambFn` | 手写 3 条声明（**漏加**） | 是（`vbspAmbientWeight`） |

`vbspLightFloor` 是本轮为「暗部纯黑」新增的 uniform，只加进了 world 路径。
命中面 = **全部带 `ambientCube` 的 prop（模型本体）+ 走 fullbright 的水面/远地面**
（实测 1046 个 mesh 材质），正是用户说的「模型 + 水体」。

### 8.3 修法：单一事实来源 + 回归断言（不是"再补一行"）

1. `lightmap-shader.ts` 新增两个导出常量 `VBSP_LIGHTMAP_UNIFORM_DECLS` /
   `VBSP_AMBIENT_UNIFORM_DECLS`；两条路径**都从同一常量取声明**
   （`ambFn` 用 `...VBSP_LIGHTMAP_UNIFORM_DECLS` 展开）⇒ 结构上消除"新增 uniform 漏改一条路径"。
2. `scripts/lightmap-inject-guard-selftest.mjs` 新增 §10（5 条断言），核心一条：
   **每个注入单元自己用到的 `vbsp*` 标识符，必须能在同一单元里找到声明**
   （附反面对照：删掉声明后该断言**必须**报出来 ⇒ 证明不是恒真断言）。
   该断言在修前为**红**，修后 **38/38 绿**。

### 8.4 附带修正：punctual 光源中和的**时机**与**手段**

`renderer-main.ts` 原先把中和写在 `applyLightmap` **之后**（且只置 `visible = false`、循环体里
漏了 `push` ⇒ 后面的 `removeFromParent()` 是空转）。真实出帧显示这条路有两个坑：

- **时机**：rAF 渲染循环在 `loadScene` 之前已启动，`this.scene.add(scene)` 之后、中和之前
  的那一帧会带着 **2118 盏灯**去编译世界面的 `MeshStandardMaterial` ⇒ 直接撞 1024 uniform 上限
  （实测 +149.29s 一波 `uniforms count exceeds` + 数百条 `no valid shader program`）。
  故中和**必须移到 `this.scene.add(scene)` 之前**（现为 §1.1）。
- **手段**：改 `removeFromParent()` 真正摘掉。只置 `visible=false` 虽也能让 three 跳过灯光收集
  （`three.module.js:29584`：`if ( object.visible === false ) return;`），但 2000+ 节点仍留在
  场景树里被反复 traverse，且任何一处未来置回 `true` 就会立刻炸掉全部受光材质的 program。

### 8.5 验证（真实浏览器运行期，索引感知计数）

工具：无头 Edge + CDP 的**一次性临时驱动**（`temp/` 下，不入库；等价在库工具是
`npm run test:lightmap-frame`，本沙箱内它对 CDP 无响应，故改用临时驱动）+
运行期清单 eval（同样临时）。

| 判据 | 实测 |
|---|---|
| program 失败数 | **0**（14 个 program 全部 `runnable`） |
| prop mesh（带 ambient cube 注入） | 1046 个，`progOk=1046 / progBad=0`；当前帧视锥内 300、可见 156、实测绘制 10324 三角形 |
| 灯 | 场景内 `isLight` 节点 **0** |
| **几何守恒** | 场景三角形实例总数 **148048 == GLB 逐节点实例展开总数 148048（delta 0）**；prop 40431 + world 107617 |
| 非 Basic 材质残留 | 0（`fullbrightUnlitLitMaterials` 终扫生效） |

> ⚠️ **计数口径**：三角形数必须走 `index.count/3`。GLB 几何是**索引化**的，用
> `position.count/3` 会把顶点数当三角形数、虚高约 14%（168714 vs 148048）——本批量测
> 先踩过这个坑，一度误以为合并丢了 2 万个三角形。

### 8.6 用户复看

```bash
cd test/game-core
build-dist.cmd      # 内含 build:ts（重出 web/app.js + dist/）；wasm 未改动，存在即跳过
start-dev.cmd       # 服务 web/，浏览器开 http://localhost:8190/web/index.html
```

预期：控制台**没有** `Shader Error` / `no valid shader program`；
有 `[ambient-cube] 命中=… 未命中=… 节点=…` + `[ambient-cube] applied=… 失败=0`；
模型与水面恢复渲染（亮度语义仍受曝露/γ/模型亮度三个旋钮控制）。
