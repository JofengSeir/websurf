# game 实现：五项控制台问题的 r1 实施契约（test/game-core，:8190）

> 本文是**需求/契约**件（t1 交付物），供 `fix-engineer`（t2）直接实施、`fix-verifier`（t3）独立复核、`fix-reviewer`（t4）评审、`doc-integrator`（t5）收口。
> 事实基准：`HEAD = a5cd4c2`（2026-09-18 实测，`git rev-parse HEAD` = `a5cd4c2589544fccc8981fa1e4d6ff2b9578fdbb`），`test/game-core/**` **已由本批 `git add` 暂存为新增（入库形态 `A`）**，故它在**索引**中已存在（`git ls-files -- test/game-core` 计数 = **84**），但在 **`HEAD` 提交**中仍不存在（`git ls-tree -r HEAD -- test/game-core` 计数 = **0**）——本副本尚未进入任何提交，故本文所有行号都是**盘上工作区行号**，不是历史版本行号。（**按实订正，2026-09-18 t5**：初稿「当前全部为工作区未追踪/已暂存新增文件」在暂存后已不准确。）
> 上游冻结件：`documents/game/implementation/lighting-merge-plan.md`（§9 实施契约，冻结摘要 `ddeaf6e6c688daf8a36de19de0d3a15d81c7a7e5cc1f1531d8bd598949b54865`）。**本文只补充该冻结件未覆盖的处置政策，不改写其任何历史结论与数字。**
> 本文所有行数/计数/摘要均由探针实测并注明口径；文档内 `npm run *`、`node *`、`python *` 属命令而非文件引用。
> 地图语料：`test/maps/{surf_666.bsp,surf_null.bsp,ze_cursed_bear_tales_v1_2.bsp}`（**不入库**，本地资产）。

## 1. 范围与不变量

### 1.1 inScope（唯一允许的改动落点）

`test/game-core/**`，具体为：

| 落点 | 用途 |
|---|---|
| `test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs` | 图集打包政策（③） |
| `test/game-core/crates/wasm/src/lib.rs` | BSP 生命周期（④）、`[BrushPlanes]` 日志（⑤） |
| `test/game-core/src/worker/main.ts` | `initSync` 注入形态（①） |
| `test/game-core/web/index.html`（+ 如需 `test/game-core/favicon.ico`） | favicon（②） |
| `test/game-core/scripts/lightmap-gltf-assert.mjs` | 随政策更新的断言（③，**必须同步，见 §4.3**） |
| 重建产物 `test/game-core/pkg/**`、`test/game-core/web/{app.js,worker.js,websurf_wasm_bg.wasm}` | ①③④ 的构建产物 |
| `documents/**` | 本契约 + 收口登记（t5） |

### 1.2 outOfScope

- 根 `src/**`、`apps/**`（逐字节不变，见 §1.3）。
- `content_main.js:5258` 的 `LanguageDetector` 提示——**浏览器扩展噪声，不在范围**（用户已裁定）。
- 阶段 4（实体光源 `with_lights` 接入）、置换面 lightmap、光照样式/bump/env_cubemap（沿用冻结件 §9.7）。
- 渲染端多纹理分页（见 §4.2 政策裁定：本轮**不改渲染端**）。

### 1.3 不变量（非污染，合取式，沿用冻结件 §9.8.1）

```
⓪ git rev-parse HEAD:src  == e3c910a031c7e8c23f825631a79236b19e00e1e9
  git rev-parse HEAD:apps == 082d1a8255d685732e516a2023bd656e4b5a5daa
  git write-tree --prefix=src 与 HEAD:src 相同
(b) git status --short --untracked-files=all -- src apps 恰为 3 行 D：
      D  apps/debug/README.md / D  apps/game/README.md / D  apps/viewer/README.md
      （0 个 ??、0 个  M、0 个 A ）
(a) 【可选项，只作同口径自比】git ls-files --cached -- src apps 的 247 文件清单摘要
      == 63aba1ce406dc36bf0cda29576ae46fd4458e3c851e786bd8aafbb93661db623
(c) (a) 或 (b) 任一变化 ⇒ 立即判不变量失败，停止施工并回报 Captain；本轮无豁免项
```

开工与收工各测一次；`D  apps/*/README.md` 三条是开工前就存在的收拢残留，**不得** restore/重建/提交。

---

## 2. 五项问题的复现、根因与证据（逐条，均本会话实测）

### ① `worker.js:915 using deprecated parameters for initSync(); pass a single object instead`

**复现（产物侧，逐字）**：`test/game-core/web/worker.js:939-957` 是 wasm-bindgen 胶水的 `initSync`（`fn initSync` 在 `:939`、`defined` 在 `:957`），其 `:915` 逐字为
`console.warn("using deprecated parameters for `initSync()`; pass a single object instead");`；
触发条件在 `:911-916`：**实参不是「普通对象」**（`Object.getPrototypeOf(x) !== Object.prototype`）时才告警。

**调用侧（真正的病灶，且在共享层）**：

| 位置 | 形态 | 是否告警 |
|---|---|---|
| `test/game-core/web/worker.js:1915` | `env.initSync(base64ToBytes(m.wasmB64).buffer)` —— 传 **ArrayBuffer** | **告警** |
| `test/game-core/web/worker.js:1917` | `env.initSync((await fetchWasmBytes(m.wasmUrl)).buffer)` —— 传 **ArrayBuffer** | **告警** |
| `test/game-core/web/app.js:27319 / :27324` | `initSync({ module: … })` | 不告警 |

`test/game-core/web/worker.js:1908-1920` 是 `src/ts-shared/auth/worker-dispatch.ts` 的 `initWasm` 被 esbuild 打包后的形态（派发调用点在 `:1915` / `:1917`）；源码为
`src/ts-shared/auth/worker-dispatch.ts:164` 与 `:166`：

```ts
env.initSync(base64ToBytes(m.wasmB64).buffer as ArrayBuffer);
env.initSync((await fetchWasmBytes(m.wasmUrl)).buffer as ArrayBuffer);
```

`env.initSync` 由 `test/game-core/src/worker/main.ts:436` 注入（`initSync` 来自 `test/game-core/pkg/websurf_wasm.js`，见同文件 `:20`）。
**结论：源码侧的 5 处 `initSync({module})`（`:527/:532` 等）确实已是对象形式；告警 100% 来自共享层 dispatch 注入点的 ArrayBuffer 形态**——共享层不在本轮范围（§1.2），故修复点在**本副本的注入处**，而不是产物「过旧」。

**旁证（口径）**：`test/game-core/pkg/websurf_wasm.d.ts:413` 声明为 `initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;`——ArrayBuffer 属**类型合法但运行时告警**的旧形态；`test/game-core/pkg/websurf_wasm.js:1047-1057` 与两份产物内嵌胶水（`test/game-core/web/worker.js:939-957`、`test/game-core/web/app.js:1044-1052`）逐字一致；`test/game-core/pkg/websurf_wasm_bg.wasm` 与 `test/game-core/web/websurf_wasm_bg.wasm` SHA-256 相同 ⇒ **不是胶水/版本错配**。

**受控层溯源与边界（t3 复核已独立确认，本契约据此定 inScope）**：

| 事实 | 证据 |
|---|---|
| 触发点是**胶水自身的兼容分支**，不是产物过旧 | `test/game-core/web/worker.js:909-917`：`Object.getPrototypeOf(module) === Object.prototype` 时解构 `{module}`，否则 `:915` 告警 |
| 真实病灶在**受控共享层**（本副本只注入） | `src/ts-shared/auth/worker-dispatch.ts:87`（接口签名 `initSync(module: ArrayBuffer): void`）、`:164`、`:166`；`test/game-core/src/worker/main.ts:436` 仅注入 |
| 主线程渲染路径**不告警**（与现场「只有 worker 告警」一致） | `test/game-core/src/renderer/renderer-main.ts:527`、`:532` 已是 `initSync({ module })` |
| `dist` 也会告警 | `test/game-core/dist/app.js` 内嵌同一弃用串（`test/game-core/scripts/build-dist.mjs` 把 worker 内联进 app.js） |

⇒ **契约的硬性表述：重建产物不消除该警告；消除点＝副本侧调用适配**（`test/game-core/src/worker/main.ts:436` 注入处包成 `(m) => pkgInitSync({ module: m })`）。`src/ts-shared/auth/worker-dispatch.ts` 在根 `src/` 内、**必须逐字节不变**，故 t2 **不得**改它；t3 的 after 判据必须同时覆盖 **dev worker 无警告 / dist 无警告 / 主线程渲染路径零变化** 三面。

### ② `:8190/favicon.ico 404`

**复现**：`test/game-core/web/index.html` 全文（254 行）只有一处 `<link rel="stylesheet" href="./styles.css" />`（`:17`），**无任何 `<link rel="icon">`**；`test/game-core/web/` 目录清单（实测）为 `app.js / coi-serviceworker.js / index.html / styles.css / textures.mtz / websurf_wasm_bg.wasm / worker.js`——**无 `favicon.ico`**。

**根因（路径口径，容易修错）**：dev 服务器为 `python ../../src/serve.py 8190 .`（`test/game-core/package.json:15`），服务根 = **`test/game-core/`**；页面在 `/web/index.html`。浏览器在缺声明时对 **origin 根**隐式请求 `/favicon.ico` ⇒ 映射到盘上 `test/game-core/favicon.ico`——**该文件不存在**（`test/game-core` 顶层实测无此文件）⇒ 404。把文件只放到 `web/` 下**不足以**消掉这个 404，必须在 `test/game-core/web/index.html` 里显式声明 `rel="icon"` 才能改变请求路径（或同时在 origin 根放文件）。

### ③ 光照打包溢出：`Unable to pack lightmap! 打包面积 6598518 px 超过单页 2048×2048`

**复现（源码路径）**：`test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs:378-421`（原引用 `:324-341`，随 t2 落地改动位移，按实测重定位） 的尺寸序列上探循环在
`:327` 命中 `size_width(size_index) > MAX_ATLAS_SIDE || size_height(size_index) > MAX_ATLAS_SIDE`（`MAX_ATLAS_SIDE = 2048`，`:27`）后
在 `:328-339` 报错并中止；`:346-350` 与 `:356-363` 是另两条失败分支。该错误经 `test/game-core/crates/wasm-core/bsp_to_gltf_core/convert.rs:35`（`build_lightmap_export` 的 `?`）→ `test/game-core/crates/wasm/src/lib.rs` 的 `GLB 导出失败` 上抛。

**独立复算（本会话探针，口径见 §6.1；与实现日志 `Σluxel=4935532 容量=7261110` 逐值一致）**：

| 量 | 实测值 | 独立来源 |
|---|---|---|
| `LIGHTING`(8) 目录 `len` | **29,044,440**（`ident=0`，raw） | BSP 目录项 @`off+8+8*16` |
| `cap` / `capSamples` | 29,044,440 / **7,261,110** | = `ident!=0?ident:len`，÷4 |
| 面表 `FACES`(7)：`recs` / `live` / `lightofs==-1` | 39,034 / **33,716** / **5,318** | 56 B/面，`lightofs@+20` |
| `Σ(sx+1)(sy+1)` | **4,935,532** | `sizes@+36` |
| `maxByteEnd` = max(`lightofs+4(sx+1)(sy+1)`) | **29,044,440** = `cap`（残差 **0**，恰好触底） | 同上 |
| 单面最大 luxel / 越 256 的面 | 4,400 / **0** | 同上 |
| **打包面积 Σ(sx+3)(sy+3)** | **6,598,518 px** = 单页 2048² 的 **157.3%** | 同上（两级换算见冻结件 §9.6.2 第 7 项） |
| 单面最大矩形面积 | 4,692 px | 同上 |

**关键可行性实测（本会话，决定 §4.2 的政策）**：沿用既有尺寸序列（`LightmapLayout.cs:74-82`，`GetWidth=1<<((i+1)>>1)`、`GetHeight=1<<(i>>1)`）**只把单边上限从 2048 放宽到 4096**（即序列多走一步），`6,598,518` px 可**完整装入单个 4096×2048 页**（二叉分割打包成功，本会话按 `test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs:269-287`（`try_pack`，原引用 `:160-230`，随 t2 落地改动位移，按实测重定位）同一算法复现）；`surf_null` → 单页 **2048×2048**（2,781,987 px，66.3%），`ze_cursed` → 单页 **2048×2048**（3,692,068 px，88.0%）——**后两张图的页形状不变**。⇒ **「一图一页」在本轮全部本地语料上可达，且不需要改渲染端。**

### ④ 级联失败：`[app] BSP 解析失败: BSP 未解析或已被导出消费，请重新 new`

**复现（产物侧，逐字）**：`test/game-core/web/app.js:2298-2304`

```js
let glbBytes;
try {
  glbBytes = proc.export_glb_with_pakfile_models_with_defaults(defaultsJson);
} catch (e) {
  console.warn("[load-bsp] 带默认纹理回退的 GLB 导出失败，回退无回退导出:", e);
  glbBytes = proc.export_glb_with_pakfile_models();   // ← 第二次导出：此时 BSP 已被 take()
}
```

该段是共享层 `src/ts-shared/phys/world-builder.ts:200-206` 的打包形态；外层 catch 在 `test/game-core/src/app.ts:480-485`（`BSP 解析失败: ${err.message}`）。

**根因（消费点）**：`test/game-core/crates/wasm/src/lib.rs` 的导出入口一律**先 `take()` 再干活**：

| 行 | 代码 | 失败时后果 |
|---|---|---|
| `:414-421` | `let bsp = self.bsp.take().ok_or_else(…"BSP 未解析或已被导出消费")?; let result = export_bsp(bsp, …)?;` | `take()` 已生效，`export_bsp` 失败 ⇒ 实例状态被毒化 |
| `:442-445` | `export_glb_with_pakfile_models_with_defaults` 同上（本次告警的那一条，报 `…，请重新 new`） | 同上 |
| `:505-508` | `export_glb_with_pakfile_models` 同上 | ⇒ **第二次导出必然报「已消费」** |
| `:565-566` / `:634` / `:775` | 另三条导出/借用入口同形 | 同族风险 |
| `:405` / `:966` / `:1082` / `:1535` / `:1678` | 借用入口报 `BSP 未解析或已导出` | 借用类错误文本与消费类混用 |

**因果链（与用户现场逐条对齐；t3 已用真机基线独立复现）**：③ 的 `Unable to pack lightmap!`（`test/game-core/web/app.js` 的 warn）→ `src/ts-shared/phys/world-builder.ts:204-205` 的**回退在「同一实例」上二次导出** → **修复前**该实例的 BSP 已被 `take()` 消费，故 `test/game-core/crates/wasm/src/lib.rs` 的二次导出入口报「已消费」（**结构性不可能成功**）→ `test/game-core/src/app.ts:481` 打印 `BSP 解析失败: BSP 未解析或已被导出消费，请重新 new`。**修复后**：`take_bsp()` 为借用式移交、成功与失败均不消费 ⇒ 该误导文案路径**不再可达**（全仓「已被导出消费 / 请重新 new」只剩 `lib.rs:381-382` 的类型级文档说明与 `:423` 的**临时负控**文本，后者待 t2 移除）。**行号口径**：本段原引用的 `lib.rs:508` / `:445` / `:417` 系 t1 采集时的**修复前**行号，t2 落地后 `lib.rs` 结构已变（现「不消费」语义见 `:405-410`），引修复前行号时一律标注**「修复前位置」**。

**文案对撞（可事后定位失败发生在哪一次导出）**：现场文案带「**请重新 new**」⇒ 命中 `test/game-core/crates/wasm/src/lib.rs:445`（`with_defaults` 的 take 已生效），而不是 `:417`（`export_glb` 的短文案「BSP 未解析或已被导出消费」，无「请重新 new」）。

**修复目标的精确边界（Captain 裁定 A，2026-09-18 订正）**：**原「成功即消费」条款作废**。t2 的实现把**全部**消费型导出入口统一改为 `take_bsp()` **借用式移交**（`test/game-core/crates/wasm/src/lib.rs:410`；交出 `Arc::clone`），于是**成功与失败均不消费实例**，实例在处理器生命周期内保持可用、可**重复导出且字节一致**。**Captain 裁定：采纳现状（A）** —— 理由：收益（消除状态毒化、可恢复性、成功路径也可重复导出）显著，且改动最小；**不是**实现方自行放宽。原条款的本意（区分「缺陷」与「既有设计」）在新表述下由「**失败不消费**」承担：本轮缺陷专指 `take()` 发生在可失败工作**之前**使**失败**路径也毒化实例（已修）；成功路径的可重复导出属**新增能力**，不是回归。

> 说明（避免夸大）：`test/game-core/src/app.ts:413` 每次加载都 `new BspProcessor(...)`，所以「毒化」不是常驻锁；本条的可判据危害是**错误保真度与可恢复性**——失败后实例不可再导出、借用类元数据被同一错误文本遮蔽、回退路径会把真实根因替换成误导性文本。

### ⑤ `[BrushPlanes] skipped=830` 是否需要核实

**日志来源**：`test/game-core/crates/wasm/src/lib.rs:2110-2115`（`export_brushes_planes` 结尾），由 `web_sys::console::log_1` 打到浏览器控制台（TS 侧无同名字符串；全仓 `grep BrushPlanes` 仅 3 处 Rust 源码：本副本 `:2111`、`apps/game/crates/wasm/src/lib.rs:2108`、`apps/debug/crates/wasm/src/lib.rs:2748`，逻辑同形）。参数给定时 `skip_sky=true`（`test/game-core/src/app.ts` 走共享 `buildWorldBundle` 的 `DEFAULT_BRUSH_FILTER`，`src/ts-shared/phys/world-builder.ts:86-92`）。

**per-map 期望值表（t3 的 oracle；口径见下方「唯一入口」声明）**：

| 地图 | `total` | `exported` | `skipped` | `sky` | `nonPlayerSolid` | `planesLt4` | `vertsLt4` | `breakdownSum` | `cover` |
|---|---|---|---|---|---|---|---|---|---|
| `surf_666` | **7,730** | **6,900** | **830** | **165** | **665** | **0** | **0** | **830** | **ok** |
| `surf_null` | 6,495 | 5,838 | 657 | 106 | 551 | 0 | 0 | 657 | ok |
| `ze_cursed` | 5,123 | 2,011 | 3,112 | 42 | 305 | 2,722 | 43 | 3,112 | ok |

> 三个 `total` 与 `pkg/websurf_wasm_bg.wasm` 里 `LUMP_BRUSHES`(**lump 18**) 的 `filelen/12` 逐图相等（字节口径：`surf_666` 92,760/12=**7,730**、`ze_cursed` 61,476/12=**5,123**、`surf_null` 该 lump 为 LZMA 封装 `ident=77,940` ⇒ 解压后 77,940/12=**6,495**）；`exported`/`skipped` 与实现入口的返回长度及自报计数逐值相等。

**现场对应（用户 console 的三元组）**：`surf_666` 的 `total=7730, exported=6900, skipped=830` 与本副本**当前代码 + 当前地图 + 正式入口**逐值相同 ⇒ 该日志来自**当前可复现真值**；⑤ 的结论是「**预期过滤语义**」，既不是缺陷，**也不是**「陈旧/异构读数」。（`ze_cursed` 的 `planesLt4=2722`、`vertsLt4=43` 说明分支分解对不同地图确有区分度。）

**唯一入口声明（口径纪律，t3 必须遵守）**：上表与「跳过是否预期」的判定**只以** `BspProcessor.export_brushes_planes(默认 filter)`（含其内部 `metadata().num_brushes` 与自身打印的 `[BrushPlanes]` 行）为**唯一入口**。任何**不经该入口**的对撞口径（自写探针、按 lump 字节推算、另一 filter/planes 判定）**一律作废**，不得作为 oracle 或反例。本会话已按此纪律作废一个早期探针（§10 E-1）。

**分支日志（实现已落地，本会话实测逐字）**：

```
[BrushPlanes] total=7730, exported=6900, skipped=830, sky=165, nonPlayerSolid=665, planesLt4=0,
  ladderExcluded=0, solidExcluded=0, nodraw=0, vertsLt4=0, volume=0, earlyExit=0,
  breakdownSum=830, bevelSidesDropped=17063, cover=ok
```

其中 `breakdownSum == skipped` 与 `cover=ok`（`exported + skipped == total`）是**实现自带的自检**——取代初稿要求的「人手四分支求和」，判据更强。

**读数口径与时点（必读）**：上表由本副本产物（`test/game-core/pkg/websurf_wasm.js` + `pkg/websurf_wasm_bg.wasm`）+ 正式入口实测；该产物在本会话内被 t2 重建过。`metadata().num_brushes` 是**实现自报**的权威口径；本会话早期那次自写探针（**错读了 lump 16**，而 `LUMP_BRUSHES` 实为 **lump 18**）给出 8,204/2/8,202，**该口径已作废**（§10 E-1）。

**跳过来源（源码口径，逐条）**：`test/game-core/crates/wasm/src/lib.rs` 的 skip 分支为 `:1837-1840`（既非 SOLID 族亦非 LADDER）、`:1842-1849`（`entity_is_non_solid`）、`:1851-1858`（`include_*` 关闭时）、`:1890-1893`（SKY，`:1815` 的 `SKY|SKY2D`）、`:1894-1897`（NODRAW，默认不跳过）、`:1898-1901`（剔除 bevel 后平面 < 4）、`:1959-1962`（`verts_bsp.len() < 4`，含法线翻转重算后的复检）、`:1965-1971`（`min_brush_volume`，默认 0 不参与）。默认 filter（`DEFAULT_BRUSH_FILTER`，`src/ts-shared/phys/world-builder.ts:86-92`）下只有「非玩家固体 / SKY / 平面<4 / 顶点<4」四条会命中。**`total` 的来源**＝实现读入的 brush 记录数（`LUMP_BRUSHES` = **lump 18**，12 B/记录；`surf_null` 该 lump 为 LZMA 封装，须解压后再计数）。

**结论（依据已按要求改写）**：跳过是**内容标志（非玩家固体）+ SKY + 凸包退化（平面<4 / 顶点<4）**四类过滤的**预期**行为，`exported + skipped == total` 逐图成立、且实现的 `breakdownSum` 自检等于 `skipped`；用户报出的 `7730 / 6900 / 830` 与**当前代码 + 当前地图 + 正式入口**的读数**逐值一致** ⇒ 这是**当前可复现真值 + 预期过滤语义**，不是缺陷。保留的唯一批评是**可核验性**：初稿时该日志只有单一 `skipped` 计数器、无法区分原因——本轮已要求并落地带分解日志（§3.1 ⑤），把「预期」从判断变成**读数 + 自检**。

---

## 3. 裁定：五项问题的处置政策与可断言契约形式

### 3.1 逐项处置

| # | 处置（必须做） | 落地断言（可红） |
|---|---|---|
| ① | 在**本副本注入处**把 ArrayBuffer 改成对象形态：`initSync: (module) => pkgInitSync({ module })`（或等价包装），使 dispatch 的两次调用都以对象形态进入胶水。**不得改** `src/ts-shared/**`。 | 重建产物后，`test/game-core/web/worker.js` 中**不存在**「胶水的 `initSync` 收到非普通对象」的静态形态：源码级判据 = `test/game-core/web/worker.js` 内所有指向胶水 `initSync` 的调用点，**调用形态均为 `{ module: … }`**；动态判据见 §7.1 探针。 |
| ② | `test/game-core/web/index.html` 的 `<head>` 增加 `<link rel="icon" …>`（推荐 `href="./favicon.ico"` 或内联 SVG data-URI，二者任选其一并显式声明）；**同时**在 `test/game-core/`（origin 根）放 `favicon.ico`（或使 `test/game-core/web/index.html` 的显式声明能被浏览器采纳而不再请求 origin 根）。 | 起服后 `GET /favicon.ico` 返回 200（或页面声明生效后浏览器不再发起该请求——须给出实际证据，二选一）。 |
| ③ | 按 §4.2 政策：**优先一图一页**——把尺寸序列的单边上限放宽到 **4096**（页形状仍取既有序列的允许档，按面积升序取最小可行），任何图只要存在可行的单页形状就必须导出成功；若连允许的最大形状都装不下，**显式报错**并自报所需页数/面积，**禁止**静默截断、降采样、部分写入。 | `surf_666` 导出**成功**且 atlas 与全部在册面一致（§4.3 判据）；同一输入两次导出字节全等；错误路径可红（§7.3 负控）。 |
| ④ | `test/game-core/crates/wasm/src/lib.rs` 的消费型导出入口改为**借用式移交**：`take_bsp()`（`:410`）交出 `Arc::clone`，**成功与失败均不消费**实例（`self.bsp` 始终保持 `Some`）。**Captain 裁定 A（2026-09-18）：原「成功即消费」条款作废，采纳现状** —— 成功路径亦不消费属有意采纳的新增能力；本轮缺陷（`take()` 在可失败工作之前 ⇒ 失败也毒化）已修，修复须覆盖**所有**导出入口，而非单个负控样例。 | **失败路径**：同一实例上 `export_*` 再次失败的原因必须是**同一根因**（不得出现「已被导出消费」/「请重新 new」），且 `metadata()` / `parse_spawn_points()` / `export_brushes_planes()` 仍可用；**成功路径**：同一实例可**重复导出且字节一致**（`test/game-core/crates/wasm/src/lib.rs:405-410` 的类型级文档与「不消费」表述按实更新）。见 §7.4。 |
| ⑤ | 把 `[BrushPlanes]` 日志升级为**带分支分解**：`total` / `exported` / `skipped` / `sky` / `nonPlayerSolid` / `planesLt4` / `vertsLt4`，并在同一行保证「各分支之和 == `skipped`」且 `exported + skipped == total`。**不改过滤语义**（本轮不改行为，只让计数自证）。 | 对任一本地地图，新日志四分支之和 == `skipped` 且与 `total - exported` 相等（§7.5；期望值 §2 ⑤ 表）。 |

### 3.2 五项的共同硬约束

1. **不得静默**：任何失败必须在控制台可见（错误文本或 warn），不得产出「合法但内容缺失」的 GLB。
2. **不得降采样/截断**：③ 若走不出单页，必须报错；**不允许**把 luxel 网格缩放过采样、不允许丢面。
3. **共享层隔离**：① 的修复必须落在副本注入处；③ 的打包政策落在副本 `crates/wasm-core/**`；不得为了修 ① 就改根 `src/ts-shared/auth/worker-dispatch.ts`。若实现过程中确认**非改共享层不可**，停下回报 Captain（沿用冻结件 §9.5 的纪律）。

---

## 4. ③ 的政策裁定（本契约的核心裁定）

### 4.1 候选与取舍

| 方案 | 内容 | 代价 | 本轮裁定 |
|---|---|---|---|
| A. 维持现状（报错） | `surf_666` 永远打不开（整体导出失败） | 一张真实地图不可用；`test:lightmap-gltf` 在「全部候选图都失败」时 **exit 1**（`test/game-core/scripts/lightmap-gltf-assert.mjs:319-331`），门禁长期红 | ❌ 不采纳（用户报的就是这个） |
| B. **非方形单页扩容**（采纳） | 沿用既有尺寸序列，单边上限 2048 → **4096**；面积按最小可行页选择 | 一行级上限放宽 + 两处守卫同步；最大页 4096×2048 = 8,388,608 px（32 MB RGBA/页） | ✅ **采纳** |
| C. 多纹理分页 | 同一图集拆多张纹理，逐图元选页 | 需新增逐面页归属、材质级分页、渲染端着色器兼容（本轮渲染端不可动，风险外溢） | ❌ 本轮不做（登记为后续项） |
| D. 显式声明式降级（降采样） | 缩小 luxel 网格 | 用户在裁定里明确禁止降采样；且会改变采样口径与观感 | ❌ 禁止 |

**B 的可行性由实测封口**（§2 ③ 表）：`surf_666` 6,598,518 px → **单个 4096×2048 页装得下**；`surf_null`/`ze_cursed` 的页形状**保持不变（2048×2048）** ⇒ 无既有场景纹理翻新、无渲染端改动、无契约字段破坏。

### 4.2 政策条文（实施者照此写）

> **状态（2026-09-18 本会话）**：本节政策**已被 t2 落地**到 `test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs`（`MAX_ATLAS_SIDE = 4096`、`MAX_ATLAS_PAGE_AREA = 4096×2048`、`is_allowed_page_shape()` 与显式失败文本）。下面的条文保留为**判据**（t3/t4 依此核对实现），不再要求 t2 重做。
>
> **若认为「多页（多纹理）」更好 ⇒ 必须先回报 Captain**：多页需要逐图元页归属 + 材质级分页 + 渲染端着色器兼容（本轮渲染端在 outOfScope），代价与风险都超出本契约；当前政策的优势是**三张本地语料全部单页可达、渲染端零改动**，且 `surf_666` 已实测导出成功（§10 E-3）。

1. 页形状取既有序列 `(W,H) = (1<<((i+1)>>1), 1<<(i>>1))`（`test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs:148-154`）；**允许形状** = 序列中满足 `W ≤ 4096 && H ≤ 4096 && W*H ≤ 8,388,608` 的形状（即：既有 ≤2048 的 12 档 + **4096×2048** + **2048×4096**；4096×4096 = 16,777,216 px > 上限，**不允许**）。
2. 选择规则：**按页面积升序取第一个能成功打包全部矩形的形状**（保持「能单页就单页」）。⇒ `surf_null`/`ze_cursed` 仍得 2048×2048（形状零变化），`surf_666` 得 4096×2048。
3. 页内布局与 UV 口径**完全不变**：打包矩形 = `(sx+3, sy+3)`、内缩 2 px、UV 用该页的 `W/H`（`test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs:366-374`、`:428-455`）——**非方形页不需要改 UV 公式**，因为它已按 `atlas.width/height` 归一化。
4. 全部允许形状都装不下时：**显式失败**，错误文本须含 `packedArea`、允许的最大形状、以及「所需页数下界 = ceil(packedArea / 8,388,608)」。
5. `MAX_ATLAS_SIDE` 的语义随之从「单页边长」变为「尺寸序列上探的边长上限」；`:346-350`、`:356-363` 两条守卫须与 `:327` 使用同一常量/同一判据，**不得**只放宽一处（否则会出现「面积上探通过、落位守卫立刻拒绝」的自相矛盾失败）。
6. **禁止**：丢面、降采样、部分写入、把超限面塞进边界像素。

### 4.3 必须同步更新的断言（跨工件耦合，漏了就是「改测试而不是修因」）

`test/game-core/scripts/lightmap-gltf-assert.mjs` 内已有硬编码上限，实施 ③ 时**必须**同步：

| 位置 | 现判据 | 改后要求 |
|---|---|---|
| `:530` | `atlasPng.width <= 2048 && atlasPng.height <= 2048` | 改为 §4.2 第 1 条的允许形状判据（单边 ≤ 4096 且 `W*H ≤ 8,388,608`） |
| `:528-529` | 宽高为 2 的幂（不变） | 保留 |
| `:532-533` | `W*H ≥ packedArea` | 保留（仍是必要的弱判据） |
| `:319-331` | 「所有候选地图都无法导出」时 `exit 1` + 「均为契约要求的显式失败」文案 | ③ 修好后 `surf_666` 必须能导出，该分支在本地语料下**不再触发**；文案不得再宣称 2048 单页是硬上限 |
| `:261-317` | fail-visible 路径（捕获 `Unable to pack lightmap` 并做统计量对撞） | **不得删除**：改为用**仍会失败**的输入触发（见 §7.3 负控），否则该分支退化为恒真 |
| `KNOWN_MAP_ORACLES`（含 `litFaceCount/luxelCount/capacitySamples/faceTable/lumpIndex/byteLength`） | 冻结件的逐图期望值 | 保留并与 §6.2 实测值对齐（本会话已逐值验证一致） |

---

## 5. 验收判据（可失败；具名失败模式 + 双侧有界）

### 5.1 ① initSync

- **正控**：重建后静态检查 + 动态触发（§7.1）均无 `using deprecated parameters for` 输出。
- **双侧有界**：`(a)` `test/game-core/web/worker.js` 内**零**「指向胶水 `initSync` 的非对象调用形态」；`(b)` `test/game-core/web/worker.js` 内**至少 2 处** `initSync` 调用点（`:1886/:1888` 对应位置）——**不得**用「删掉 wasm-init 处理」这类删除来换取 (a)。
- **负控（必须能红）**：把注入改回 `initSync: pkgInitSync`（即 ArrayBuffer 形态）重建一次，动态触发**必须**打印 `using deprecated parameters`（本会话已在当前产物上证明该触发为真：`test/game-core/web/worker.js:915` 与 `:1915/:1917`）。

### 5.2 ② favicon

- **正控**：`GET /favicon.ico` → 200 **或**「index.html 显式声明生效、浏览器不再请求」的实测证据（二选一，须写明是哪一种）。
- **双侧有界**：`(a)` 声明/文件至少存在一种；`(b)` **不得**为消除 404 而改动无关页面结构（DOM/ID/类名不变，见 `test/game-core/web/index.html:7-16` 的自述约定）。
- **负控**：删除新增的 `<link rel="icon">`（及文件）后，同一检查必须回落为 404 / 隐式请求。

### 5.3 ③ surf_666 的期望（**已裁定为「成功产出」这一支**，判据如下）

> **裁定（明确择一）**：选 **(A) 成功产出**——**单个非方形页**（`4096×2048`）。不选 (B)「仍显式失败但可重试」，因为 (A) 已实测可达（§10 E-3：GLB 161,418,152 B、`asset.extras.lightmap` 自报 `4096×2048`）。「仍显式失败但可重试」的判据**保留在 §5.4**，作为**负控输入**（任何允许形状都装不下的构造输入）下的行为要求，而不是 `surf_666` 的期望。
>
> **若实现最终选择多页（多纹理）而非单页**：必须在 GLB 里给出**页数表征**——`asset.extras.lightmap.pageCount`（整数 ≥ 1）、`pages[i].textureIndex/atlasWidth/atlasHeight/pageArea`，并保证每个图元的 `TEXCOORD_1` 落在其页内、`materials[*].extensions.__vbsp_lightmap__.textureIndex` 指向该页；此时 `asset.extras.lightmap.textureIndex` 保留为**第 0 页**（向后兼容）。**两者选一后必须写进 t3 报告**，不得既无页数表征又声称多页。

- **正控（`surf_666`）**：`new BspProcessor(bytes).export_glb_with_pakfile_models_with_defaults('{}')` **成功返回**，且：
  - GLB `asset.extras.lightmap`：`textureIndex` 为整数且在 `textures` 范围内；`atlasWidth/atlasHeight` 属 §4.2 允许形状；`packedArea == 6,598,518`；`litFaceCount == 33,716`；`lumpBytes == 29,044,440`；`source.lumpIndex == 8`、`source.hdrNonEmpty == false`；
  - **无静默截断/降采样**：该页内 `Σ(图表元有效 texel) == Σ(sx+1)(sy+1) == 4,935,532`（逐面等值，允许的差只有页内 padding），且 `W*H ≥ 6,598,518`；
  - 同一输入**连续两次导出 SHA-256 相同**。
- **双侧有界**：`(a)` atlas 面积 ≥ `packedArea`；`(b)` atlas 面积 ≤ 8,388,608 且单边 ≤ 4096；`(c)` 页内每面矩形**不重叠**（渲染正确性的必要条件）。
- **负控（必须能红）**：构造「任何允许形状都装不下」的输入（例如临时把允许边长上限降到 2048/1024 的构建，或用 `WEBSURF_MAP` 指向人工构造的超限面表）⇒ 必须**抛错**且错误文本含 `packedArea`、允许最大形状、所需页数下界；**不得**产出「少面的成功 GLB」，且**失败后同一实例可重试**（§5.4）。**判定红 = 该断言在负控下失败/抛错**。
- **不得**把 `surf_666` 的通过建立在放宽到 4096×4096 之上（>`W*H ≤ 8,388,608` 即违反）。

### 5.4 ④ 失败不消费 BSP

- **正控**：对**仍会失败的输入**（negative control，例如把 ③ 的允许形状上限在测试构建中调小）：
  1. 第一次 `export_*` 抛错（原因 = 打包溢出）；
  2. **同一实例**第二次 `export_*` 抛错的原因**必须仍是打包溢出**（逐字不含「已被导出消费」/"请重新 new"）；
  3. 同一实例的借用类接口（`metadata()` / `parse_spawn_points()` / `parse_teleports()` / `export_brushes_planes(…)`）**仍返回合法结果**。
- **双侧有界**：`(a)` 失败后 `bsp` 仍在（借用可用）；`(b)` **成功**导出后实例仍可用、可重复导出且**字节一致**（Captain 裁定 A：原「允许消费」条款作废；文档 `test/game-core/crates/wasm/src/lib.rs:405-410` 的表述按实更新）——**不得**为此改成整份克隆。
- **负控**：把 `take()` 放回失败点之前（保持现状）重建 ⇒ 断言 2/3 必须变红（报「已消费」）。
- **端到端**：`src/ts-shared/phys/world-builder.ts:204-206` 的回退**只有在「回退真的可能成功」时**才允许执行；当第一次失败是**不可恢复**类型（打包溢出/单面越界/面表口径错）时，必须**原样重抛第一次的错误**，不得用第二次调用的错误覆盖根因。判据：控制台**不得**出现 `BSP 未解析或已被导出消费`（`test/game-core/web/app.js` 侧可 grep 逐字字符串），且 `[app] BSP 解析失败:` 后的文本必须是真实根因。

### 5.5 ⑤ skipped 结论

- **正控**：新日志的 `breakdownSum == skipped` 且 `cover=ok`（即 `exported + skipped == total`），对三张本地地图逐图成立；期望值见 §2 ⑤ / §7.5 的逐字日志。
- **双侧有界**：`(a)` 计数自洽（`breakdownSum == skipped` 与 `exported + skipped == total` 双向相等）；`(b)` **过滤语义不变**——`exported` 必须保持 §2 ⑤ 表的实测值（**7,730 / 6,495 / 5,123 三个 total 与 6,900 / 5,838 / 2,011 三个 exported 都是实现自报的活体读数**；任一改变即为改了语义，属越界）。
- **负控**：从日志删掉任一分支字段 ⇒ 解析断言红；或把某分支计数置 0（如 SKY 判定写死 false）⇒ `breakdownSum` 与 `skipped` 自检必须失配（可红）。
- **结论性表述（依据已改写）**：`skipped` 属**预期过滤语义**（非玩家固体 665 + SKY 165，`planes<4` 命中 0 / `verts<4` 命中 0；三图分别见 §2 ⑤ 表）；用户报的 `7730/6900/830` 是**当前代码 + 当前地图 + 正式入口可复现的真值**，**不追认其为缺陷**。保留的唯一要求是把单一计数器升级为**带分解的可核验日志**（§3.1 ⑤）。**勘误**：本契约初稿曾据一次口径错误的字节探针（§10 E-1）把该三元组判为「不可复现的陈旧读数」，该结论**已撤回**；判定口径现固定为 `export_brushes_planes(默认 filter)`（§2 ⑤「唯一入口声明」）。

---

## 6. 独立复算口径（t3 复算必须用同口径，或给出更强的独立口径）

### 6.1 探针方法（本会话实测，可复现）

```
① 读 VBSP 头：off=0 "VBSP"、u32 version@4；64 项 lump 目录每项 16 B @8+16i
   （fileofs@+0 / filelen@+4 / version@+8 / ident@+12）
② cap = ident!=0 ? ident : len ；capSamples = cap/4
③ 面表按 §9.8.3 的 auto_pair：HDR-lump 非空 ⇒ FacesHdr(58)+LightingHdr(53)，否则 Faces(7)+Lighting(8)；
   FacesHdr 缺席时退回 Faces(7)（本语料三图不发生）
④ ident!=0 ⇒ 该 lump 为 Source LZMA 封装：4 B "LZMA" + u32 actualSize + u32 lzmaSize + 5 B props + 裸 LZMA1 流
   （surf_null 的 FacesHdr(58) 走此路：盘上 328,056 B → 解压 1,868,104 B = ident）
⑤ 面记录 56 B：lightofs@+20(i32)、sizes(sx,sy)@+36(i32,i32)
⑥ 打包矩形 = (sx+3, sy+3)；packedArea = Σ(sx+3)(sy+3)；页形状序列 = (1<<((i+1)>>1), 1<<(i>>1))
```

**对撞证据（两种独立实现，本会话）**：Python（`test/game-core/scripts/verify/map_table.py`）与 Node 探针解出的面表字节 **SHA-256 前 16 位逐图相同**：
`surf_666 b093788f0993f66c`（2,185,904 B，raw）、`surf_null b276ebe7e7d9b437`（1,868,104 B，LZMA 解压）、`ze_cursed a9ff0b7d63e88e8a`（1,219,344 B，raw）。

### 6.2 三图实测（与冻结件 §9.6.2/§9.8.3 期望值逐值一致）

| 地图 | 面表/lump | cap(capSamples) | recs/live/-1 | Σluxel | maxByteEnd(残差) | packedArea(单页占比) | 单页可行形状 |
|---|---|---|---|---|---|---|---|
| `surf_666` | Faces(7)/LDR(8) | 29,044,440(7,261,110) | 39,034/**33,716**/**5,318** | **4,935,532** | 29,044,440(0) | **6,598,518**(157.3%) | **4096×2048**（2048² 不可） |
| `surf_null` | FacesHdr(58)/HDR(53) | 22,961,620(5,740,405) | 33,359/**26,509**/**6,850** | **1,920,921** | 22,961,620(0) | **2,781,987**(66.3%) | 2048×2048 |
| `ze_cursed` | FacesHdr(58)/HDR(53) | 23,581,252(5,895,313) | 21,774/**18,643**/**3,131** | **2,760,528** | 23,581,108(**144**) | **3,692,068**(88.0%) | 2048×2048 |

> `ze_cursed` 的 `Faces(7)` 是**坏表**（`lightofs` 全 0、live=21,774、Σluxel=2,791,391、maxByteEnd=34,928）——若实现报出这些数即为**未切面表**的确证（冻结件 §9.6.2 第 12 项）。本轮探针实测 `Faces(7)` 确实给出 21,774 / 2,791,391，与该「坏表指纹」逐值吻合。

### 6.3 不得使用的口径（本会话已踩过，登记以免后人重犯）

- **不得**把「面积和」当成「单页容量」以外的判据：`Σluxel×4 / cap` 实测仅 0.68/0.335/0.468（冻结件 §9.8.3），差额是容器内未被面表覆盖的填充；**禁止**写 `Σluxel == cap` 之类等式。
- **不得**用 2048² 之外的自造形状序列（例如直接跳 4096×4096）来「修好」③——那会超出 §4.2 的页面积上限。
- **不得**用 `dirLen` 当 luxel 分母（`surf_null` 低估 3.8 倍）。
- **不得**在未解压面表的情况下复算 `surf_null`（`ident=1,868,104`）。

---

## 7. 验证规程（t3 用；t2 自测同规程）

### 7.1 ① initSync 动态复现（Node 侧，产物字节级）

```
① 从 web/worker.js 抽出胶水 `initSync` + `__wbg_get_imports` 一线所需片段，或在 Node 中直接
   起一个 worker 等价 harness：用 web/worker.js 的实际调用形态传入 wasm 字节
② 期望：捕获到的 console.warn 中不含 "using deprecated parameters"
负控：把注入还原为 ArrayBuffer 形态 ⇒ 同一 harness 必须打出该告警
```

> 更稳妥的等价口径（无需浏览器）：把 `test/game-core/web/worker.js` 中胶水的 `initSync` 与环境注入**原样**在 Node 里 eval，然后调用 `env.initSync(<ArrayBuffer>)` 与 `env.initSync({module:<ArrayBuffer>})` 各一次，比较 console.warn 命中数（前者 1、后者 0）。**这是判据的可红形态，必须在 t3 报告中贴出两次运行的逐字输出。**

### 7.2 ② favicon

```
cd test/game-core && python ../../src/serve.py 8190 .
# 浏览器/等价客户端：GET http://localhost:8190/favicon.ico → 期望 200
# 或：在页面声明生效的前提下证明不再发起 origin 根请求（附证据形式）
```

### 7.3 ③ 光照导出（Node 侧）

```
node -e "…" 或仓库脚本：initSync({module: readFileSync('pkg/websurf_wasm_bg.wasm')})
  → new BspProcessor(readFileSync('test/maps/surf_666.bsp'))
  → export_glb_with_pakfile_models_with_defaults('{}') 期望成功；抽 GLB JSON chunk 断言 §5.3 各字段
负控：构造装不下的输入 ⇒ 期望抛错 + 错误文本含 packedArea/允许最大形状/所需页数下界
```

### 7.4 ④ 失败不消费

```
同一实例两次调用失败路径（负控输入）：
  第 1 次 err.message → 打包溢出类文本
  第 2 次 err.message → 必须同族，且不得匹配 /已被导出消费|请重新 new/
  之后 metadata() / parse_spawn_points() / export_brushes_planes(filter) 期望均成功
```

### 7.5 ⑤ BrushPlanes 计数

```
对三张地图各跑一次 export_brushes_planes(默认 filter)，解析新日志：
  期望（本会话活体实测，逐字格式见 §2 ⑤）：
    surf_666  total=7730 exported=6900 skipped=830  sky=165 nonPlayerSolid=665 planesLt4=0  vertsLt4=0  breakdownSum=830  cover=ok
    surf_null total=6495 exported=5838 skipped=657  sky=106 nonPlayerSolid=551 planesLt4=0  vertsLt4=0  breakdownSum=657  cover=ok
    ze_cursed total=5123 exported=2011 skipped=3112 sky=42  nonPlayerSolid=305 planesLt4=2722 vertsLt4=43 breakdownSum=3112 cover=ok
  断言：breakdownSum == skipped 且 exported + skipped == total（实现自报自检，必须为 ok）
  负控：任一分支计数被置 0（或自检被绕过）⇒ breakdownSum 与 skipped 必须失配（可红）
```

### 7.6 修复前预检（t2/t3 开工前必做，源自 §10 E-2）

```
# 目的：确保「after 判据」挂在与源码同时点的产物对上（pkg/** 会被反复重建）
1) 取同一时刻的产物对：test/game-core/pkg/websurf_wasm_bg.wasm 与 web/websurf_wasm_bg.wasm
   必须 SHA-256 相同（否则 web 未随 pkg 同步）
2) 产物必须晚于源码改动：pkg/web 的 mtime ≥ 被改源码（lightmap.rs / crates/wasm/src/lib.rs / src/worker/main.ts）的 mtime
3) 行为自证（不依赖 mtime）：用 pkg 直接跑 §5.3 正控 —— 若 surf_666 仍报「超过单页 2048×2048」，
   说明产物是 §4.2 政策之前的版本，**不得**据此判 t2 失败，先重建
4) 基线对照必须标注口径：修复前读数（含 t3 的修复前基线）只对其采集时刻的产物对成立，
   使用时要同时给出同文件当前的 sha256 与 mtime
```

### 7.7 门禁（t2/t3 必跑，全部 `exit 0`）

```
cd test/game-core
npm run typecheck
npm run build:ts
npm run check:api
npm run test:lightmap-gltf      # ③ 修好后必须能跑到「有地图 = 完整断言」分支
npm run test:lightmap-decode
```

**基线对照**：修复前的读数必须在同口径下先采一次。**已在会话内实测到的基线事实**：t3 采集的修复前产物对（`test/game-core/web/worker.js` sha256=`062eee3c…`、bytes=88506、mtime=`2026-09-18T02:32:21Z`）上，`surf_666` 的导出**失败**（`Unable to pack lightmap! 打包面积 6598518 px 超过单页 2048×2048`），而 `test/game-core/scripts/lightmap-gltf-assert.mjs:319-331` 的「全部候选图都失败 ⇒ exit 1」分支会因此长期红。t2/t3 复跑门禁时若 `pkg/**`、`web/**` 已被重建（含 §4.2 政策），该分支**不应再触发**；凡引用任何修复前读数，必须同时给出该文件的**当前** sha256 与 mtime（§7.6 预检、§10 E-2）。

### 7.8 非污染（每轮开工/收工各一次）

```
git rev-parse HEAD:src ; git rev-parse HEAD:apps ; git write-tree --prefix=src
git status --short --untracked-files=all -- src apps     # 恰 3 行 D
# (a) 可选：git ls-files --cached -- src apps → 247 条 → 清单摘要
# 陷阱：不得 Sort-Object；不得用工作树原始字节算 blob sha1；不得用 Compare-Object 验顺序
```

---

## 8. 非目标（本轮不做，登记以免误判为漏做）

1. **渲染端多纹理分页**（§4.1/C）：不在本轮；`test/game-core/src/renderer/**` 除既有 lightmap 接线外不改。若实施 ③ 后发现必须改渲染端，停下回报 Captain。
2. 阶段 4（实体光源）、置换面 lightmap、光照样式/bump/env_cubemap、`dispPages` 等 page 面（沿用冻结件 §9.7）。
3. 不改根 `src/**`、`apps/**`；不改 `src/ts-shared/auth/worker-dispatch.ts`（① 在副本注入处修）。
4. 不改 `content_main.js` 相关（浏览器扩展噪声）。
5. 不为「消掉 404/告警」而改变页面 DOM 结构、`data-*`、ID/类名（`test/game-core/web/index.html:7-16` 的自述约定）。
6. 不追认 `[BrushPlanes] skipped=830` 为缺陷（结论：**当前可复现真值 + 预期过滤语义**——`sky=165 + nonPlayerSolid=665`，`planes<4`/`verts<4` 均命中 0；与用户现场逐值一致。本轮只把它升级为带分支分解的可核验读数）。

---

## 9. 交付物与责任

| 交付物 | 责任 | 判据 |
|---|---|---|
| 本文 `documents/game/implementation/console-fix-contract.md` | t1（本文） | 五项复现 + 政策裁定 + 可失败判据 + 不变量 |
| 代码与产物改动（§1.1 表） | t2 | §5 各项正控/负控 + §7.7 门禁 exit 0 |
| 独立复核报告 | t3 | §7 规程逐条，含负控红色输出与「同一数组原子读」口径 |
| 评审结论 | t4 | 冻结件 `ddeaf6e6…` 未被改写；不变量成立；证据充分性 |
| `CHANGELOG.md` 纯追加 + 文档同步 | t5 | 政策裁定与落地方式、关键 hash/pin 与时点 |

---

## 10. 勘误与测量纪律（t1 自校正，2026-09-18 会话内）

### E-1 【已撤回】「`skipped=830` 是陈旧/异构读数」——错，根因是**探针读错了 lump 索引**

- **初稿错在哪（两处叠加）**：
  1. 自写探针把 `LUMP_BRUSHES` 当成了 **lump 16** 去读（该索引在本 BSP 里并非 Brushes），于是 brush 数被算成 `98454/12 = 8,204.5`；
  2. 又用「跳过率」这个**自造比值**去论证「不可复现」，而该比值不是任何正式入口的输出。
  合起来得出 `surf_666` total=8,204 / exported=2 / skipped=8,202，并据此把用户现场的 `7730/6900/830` 判为「当前构建 + 当前地图无法复现」。
- **正确口径（可核验，两次独立成立）**：
  - **`LUMP_BRUSHES` = lump 18**（12 B/记录）。实测 `filelen/12`：`surf_666` 92,760/12 = **7,730**、`ze_cursed` 61,476/12 = **5,123**、`surf_null` 该 lump 为 LZMA 封装（`ident=77,940`）⇒ 解压后 77,940/12 = **6,495** —— 与实现自报的三个 `total` 逐图相等。
  - **正式入口读数**：`test/game-core/pkg/websurf_wasm.js` 的 `BspProcessor.export_brushes_planes(默认 filter)`（修复前后同一读数）：`7730/6900/830`、`6495/5838/657`、`5123/2011/3112` —— **与用户现场逐值一致**；`total` = `BspMetadata::num_brushes`（实现自报），`exported` = 该入口返回数组长度。
- **判定**：**以正式入口 `export_brushes_planes(默认 filter)` 为唯一口径**；初稿的自写探针与本会话早期的字节比值口径**一律作废**，其「8,204/2/8,202」与「跳过率 99.97%」**作废**。相关结论已在 §2 ⑤、§5.5、§8.6 就地改正。
- **同源勘误（对 t3 早期基线「`skipped=830` 全部来自 `verts_bsp.len() < 4`」的表述）**：正式入口的分支分解实测 `vertsLt4=0`、`planesLt4=0`，`skipped=830` 实为 `sky=165 + nonPlayerSolid=665`。该早期表述自述为「独立观察 + 源码口径，**非逐 brush 归因证明**」，**不再是当前实现的归因**；请以 §2 ⑤ / §7.5 的逐字日志为准。

### E-2 测量纪律（本轮新增，源自 E-1）

1. **唯一入口纪律**：「跳过是否预期 / brush 计数」只以 `BspProcessor.export_brushes_planes(默认 filter)`（含其自报 `metadata().num_brushes` 与 `[BrushPlanes]` 行）为准；**任何不经该入口**的对撞口径（自写探针、按 lump 字节推算、另一 filter/planes 判定）**作废**，不得作为 oracle 或反例（§2 ⑤「唯一入口声明」）。
2. **探针先自查 lump 索引与记录尺寸**：本 BSP 的 lump 目录**不是** enum 顺序的简单映射（`LUMP_BRUSHES` 在索引 **18**，而 16/17 是别的表），且不同地图同一 lump 可能为 LZMA 封装（`ident != 0` ⇒ 必须先解压再按记录尺寸计数）。凡「按字节推的数」与实现自报冲突，**先复核探针**，不得用它否定实现读数。
3. **`pkg/**` 是构建产物，可能比源码旧**：本会话实测到 `test/game-core/pkg/websurf_wasm_bg.wasm` 与 `web/websurf_wasm_bg.wasm` 在数分钟内被 t2 重建（长度/摘要变化），故任何「产物 vs 源码」的对撞必须**同一时刻同一数组**采样，并标注时点。判据只能挂**同一时点的产物对**。
4. **凡「修复前基线」都要标注它是用哪一版产物测的**：t3 的修复前基线是在 t2 落盘前采集的（记 `test/game-core/web/worker.js` sha256=`062eee3c…`、`bytes=88506`、mtime=`2026-09-18T02:32:21Z`），只对「当时那一对产物」成立；用它做 after 对照时，必须同时给出**同文件当前的摘要**再谈差异。

### E-3 落地状态快照（2026-09-18 本次会话读到的源码状态，仅供参考）

- `test/game-core/crates/wasm-core/bsp_to_gltf_core/lightmap.rs` **已含本契约 §4.2 的政策**：`MAX_ATLAS_SIDE = 4096`、`MAX_ATLAS_PAGE_AREA = 4096×2048`、`is_allowed_page_shape()`、以及「连允许形状都装不下 ⇒ 显式报错（自报 packedArea / 允许最大形状 / 所需页数下界）」。
- `test/game-core/crates/wasm/src/lib.rs` **已含** §3.1 ⑤ 的跳过分支分解（`sky` / `nonPlayerSolid` / `planesLt4` / `vertsLt4`）。
- **本会话探针的 after 侧读数（时点：见 §2 ⑤ 注）**：以当前源码的**裸构建**（未改任何文件，构建到 `仓库外临时目录/` 外挂目录）执行 `surf_666` 的 `export_glb_with_pakfile_models_with_defaults('{}')` ⇒ **成功**，GLB=**161,418,152 B**，`asset.extras.lightmap = { textureIndex:0, atlasWidth:4096, atlasHeight:2048, packedArea:6598518, litFaceCount:33716, lumpBytes:29044440, source:{lumpIndex:8, byteLength:29044440, hdrNonEmpty:false} }`；同一实例**连续两次导出均成功**。
- **判据提醒**：上条只证明「裸构建 at that time」的行为，**不替代** t3 对**交付产物对**（`pkg/**` + `web/**` 同一时点）的复核；`asset.extras.lightmap.textureIndex/degradation` 与 §4.3 的全部断言仍须在交付产物上复跑。
