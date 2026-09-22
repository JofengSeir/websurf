# implementation：web

主题对应 `apps/debug/web/**`：页面骨架 `index.html`、独立样式表 `styles.css`、跨源隔离补丁 `coi-serviceworker.js`，以及构建产物落点（`app.js` / `worker.js` / `websurf_wasm_bg.wasm` / `textures.mtz`）。

## 模块职责

**`apps/debug/web/index.html`（页面骨架与全部 DOM id）**

结构自 `apps/debug/web/index.html:283` 起：

| 区段 | 内容 | 锚点 |
|---|---|---|
| 顶栏 | 标题与全局按钮 | `apps/debug/web/index.html:283` |
| 主容器 / 侧边栏 | `#main` / `#sidebar`，侧边栏内 `#status` 与 `#error` | `apps/debug/web/index.html:290`、`:292` |
| 文件输入 | `#bspFile` 等 | `apps/debug/web/index.html:297` |
| 视角与操作 | 灵敏度 / Q-E / pitch 限位 | `apps/debug/web/index.html:305` |
| 渲染与视距 | 光照模式、环境光、近平面、视距剔除 | `apps/debug/web/index.html:325` |
| 路径记录 | 五个可见性复选框、导出按钮、`#pathCounts` | `apps/debug/web/index.html:380`、`:397` |
| 物理 | 物理模式、碰撞来源、tickRate、出生点、碰撞箱三围 | `apps/debug/web/index.html:428`、`:456` |
| 移动/力学参数（动态渲染） | `#physicsParamList` 由 `PARAM_DEFS` 生成 | `apps/debug/web/index.html:494` |
| 出生点 | `#spawnSelect` | `apps/debug/web/index.html:506` |
| 自定义传送点 | `#customTeleportDetails` / `#customTeleportList` | `apps/debug/web/index.html:516`、`:536` |
| 准星与 HUD | `#hudVisible` / `#showCrosshair` / `#chColor` 等 | `apps/debug/web/index.html:543` |
| 调试线框 | brush / 触发器 / 三角面 / chamfer 开关与视距 | `apps/debug/web/index.html:592` |
| 元数据 | `#metadata` | `apps/debug/web/index.html:643` |
| 权威健康 | `#health-count` / `#health-clear` / `#health-log` | `apps/debug/web/index.html:653` |
| 预览区与 HUD | `#previewArea` / `#preview` canvas / `#hud` / `#stats` / `#cullStats` / `#gameStats` / `#planeInfo` | `apps/debug/web/index.html:659`、`:660`、`:668`、`:669`、`:670`、`:671`、`:672` |
| 缺失材质纹理弹窗 | `#missingTexturesModal` 及三个子节点 | `apps/debug/web/index.html:681` |
| 脚本 | 先 classic 的隔离补丁，再 module 的应用入口 | `apps/debug/web/index.html:695`、`:696` |

页面自身带一段内联 `<style>`（`apps/debug/web/index.html:7` 起），大部分外观写在其中；页面的全部 id 共 106 个。

**`apps/debug/web/styles.css`**

全文只有一条规则：`apps/debug/web/styles.css:2` 的 `.health-log`（等宽字体、`pre-wrap`、`break-all`、灰色、限高 200px、纵向滚动）。

**`apps/debug/web/coi-serviceworker.js`（classic script，兼容静态托管）**

同一文件承担双重身份（`apps/debug/web/coi-serviceworker.js:1`）：页面上下文负责注册并在激活后 reload；Service Worker 上下文给响应补 `Cross-Origin-Embedder-Policy: require-corp` 与 `Cross-Origin-Opener-Policy: same-origin`（`apps/debug/web/coi-serviceworker.js:10`、`:11`）。预缓存清单与缓存名由构建注入（`__PRECACHE_MANIFEST__` / `__CACHE_NAME__`），未注入时两者都走 `typeof` 安全回退（`apps/debug/web/coi-serviceworker.js:2`、`:4`）。

**构建产物落点**（都由脚本生成，不是手写文件）

`app.js` 由 esbuild 从 `apps/debug/src/app.ts` 打包（`apps/debug/package.json:11`）；`worker.js` 同理来自 `apps/debug/src/worker/main.ts`（`apps/debug/package.json:10`）；`websurf_wasm_bg.wasm` 是 `wasm-pack` 产物从 `apps/debug/pkg/` 复制过来（`apps/debug/package.json:8`）；`textures.mtz` 是离线纹理包资产。页面注释面也写明 `app.js` 不是本目录的手写文件（`apps/debug/web/index.html:694`）。

## 关键流程与不变量

**页面加载顺序**：先执行 classic 的隔离补丁，再执行 module 形式的应用入口（`apps/debug/web/index.html:695`、`apps/debug/web/index.html:696`）。补丁在 Service Worker 取得页面控制权后写一次 `sessionStorage` 标记并 `window.location.reload()`（`apps/debug/web/coi-serviceworker.js:68`）。隔离成功与否直接决定 `main` 走 SAB 通道还是 postMessage 回退（`apps/debug/src/app.ts:286`）。

**id 与句柄的对照关系**：所有控件句柄都由 `apps/debug/src/app.ts:61` 起的 `dom` 表经 `getElementById` 取得，取不到即 `null`，消费点一律用可选链判空。

**面板行动态生成**：`#physicsParamList` 的内容由 `PARAM_DEFS` 逐项渲染（`apps/debug/src/physics/param-defs.ts:47`、`apps/debug/src/app.ts:2137`），因此页面本身不列参数行。

**不变量**：

- `#cullStats` 的初始文本与运行期文本是同一口径（可见数 / PVS / LOD 三段，`apps/debug/web/index.html:670`、`apps/debug/src/app.ts:621`）。
- 权威健康控制台的条数上限 30 由脚本保证，页面只提供容器与计数位（`apps/debug/src/app.ts:2502`）。
- 预览 canvas 带 `tabindex`，键盘事件实际绑在 `window` 上（`apps/debug/web/index.html:660`、`apps/debug/src/app.ts:1192`）。
- 隔离补丁注册失败或浏览器不支持时静默跳过，调用方已有 postMessage 回退通道兜底（`apps/debug/web/coi-serviceworker.js:4`）。

## 已知缺口

1. **`apps/debug/web/styles.css` 在全工程零引用**：它定义的 `.health-log` 规则没有任何加载路径——`apps/debug/web/index.html` 既不 `<link>` 该文件，内联 `<style>` 段里也没有 `.health-log` 规则；`apps/debug/scripts/build-dist.mjs:63` 的 `KEEP_SINGLE` 与 `:64` 的 `KEEP_MULTI` 也都不含 `styles.css`。页面上的 `#health-log` 元素带 `class="health-log"`（`apps/debug/web/index.html:653`），但该类在本页无任何样式生效。
2. **页面缺少被查询的九个 id**：`apps/debug/src/app.ts` 会查询 `inputRecStatus`、`inputRecToggleBtn`、`inputRecClearBtn`、`inputRecExportBtn`、`inputRecLoadBtn`、`inputRecStopPlayBtn`、`inputRecFile`、`pathVisibleChk`、`pvsEnabled` 九个 id（`apps/debug/src/app.ts:119` 起、`apps/debug/src/app.ts:112`、`apps/debug/src/app.ts:95`），页面的 106 个 id 中一个都没有，因此对应控件在页面上不存在（「输入录制」区整块缺失、路径总开关与 PVS 开关缺失）。
3. **两个 id 无任何代码读写**：`lightingModeHint`（说明段，`apps/debug/web/index.html:353`）与 `pathBuildTag`（构建标签，`apps/debug/web/index.html:392`）在 `apps/debug/src` 与 `apps/debug/scripts` 内零命中。其中构建标签不做构建版本校验，与产物不符时页面不会提示。
4. **`#health-log` 的实际外观依赖内联样式之外的东西**：由于 1 中所述原因，该元素当前只有浏览器默认的 `<pre>` 外观。
5. **PVS 开关不在本区**：页面「渲染与视距」区不提供 PVS 复选框（`apps/debug/web/index.html:333`），而脚本仍在查询 `pvsEnabled`（`apps/debug/src/app.ts:95`）。
6. **`title` 属性与实际实现的口径**：`pathBuildTag` 所在区段的注释说明本页不校验构建版本（`apps/debug/web/index.html:392`），页面上也没有比较机制。
