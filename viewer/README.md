# WebSurf-viewer — 最小 BSP 自由视角查看器

> 定位：纯视觉查看器——BSP 地图导入 → GLB 场景 + **仅自由视角**（无物理/碰撞/面板），
> 支持外部传入**人物位置 + 视角**（位姿）并实时应用。地图导入构筑场景为最小实现，
> 无任何多余功能（无 physics Worker、无 mosaic/默认纹理包、无 PVS/LOD、无传送点）。

| 文件 | 说明 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 薄导出层：`BspProcessor` 最小集（metadata / parse_spawn_points / export_glb_with_pakfile_models），**不含 websurf-phys** |
| `src/app.ts` | 主线程入口：BSP → GLB 场景 + 飞行相机 + 位姿三通道（URL/hash/window.viewer） |
| `index.html` | 入口页（canvas + 首访引导层 + 拖拽/文件选择 + HUD） |

共享 `src/wasm-core/`（BSP 解析/GLB 导出），vmdl patch 同 debug/game/test。

## 快速上手（三步）

> 前置：Node.js ≥ 18；Rust 工具链 + **wasm-pack**（WASM 构建必需，`cargo install wasm-pack`
> 安装，或参考 [官方安装器](https://rustwasm.github.io/wasm-pack/installer/)）。

1. **安装依赖**：`npm install`
2. **构建产物**：`npm run build:wasm`（wasm-pack release → `pkg/`，并拷贝 wasm 到 viewer 根）
   + `npm run build:ts`（typecheck + esbuild 出 `app.js`）；两步可合并为 `npm run build`
3. **启动**：`npm run dev`（即 `python ../src/serve.py 8080 .`）→ 打开 <http://localhost:8080/>

加载地图：首访引导层点「选择 BSP 地图…」按钮，或直接把 `.bsp` 文件**拖进窗口**
（多文件取首个；解析进行中忽略重复触发）；右上角「加载 BSP 地图」等效。
本地地图副本放仓库根 `maps/`（gitignored）。

## 操作（仅自由视角）

| 输入 | 动作 |
|---|---|
| 点击画布 | 指针锁定（鼠标视角） |
| `W` `A` `S` `D` | 水平平移（相机相对方向） |
| `空格` | 上升 |
| `Ctrl` / `C` | 下降（推荐 `C`：`Ctrl`+`W` 会被部分浏览器保留为关标签，页面拦不住） |
| `Shift` | 加速 ×4 |
| `Esc` | 解锁 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 页面显示「viewer 初始化失败」，提示缺 `app.js` / wasm | 未构建就打开了页面：在 `viewer/` 目录依次运行 `npm install` → `npm run build:wasm` → `npm run build:ts` 后刷新 |
| 状态行报 `fetch wasm → 404` 或「缺少 WASM 产物」 | 缺 WASM 产物：先运行 `npm run build:wasm`（生成 `pkg/` 并拷贝 wasm 到 viewer 根）再刷新 |
| 「无法创建 WebGL 渲染上下文」 | 浏览器不支持/禁用了 WebGL、硬件加速关闭或显卡驱动过旧——换最新版 Chrome / Edge / Firefox 并开启硬件加速 |
| `npm run dev` 报端口占用 | 8080 被其他进程占用：结束占用进程，或换端口启动 `python ../src/serve.py 8090 .` 后访问对应端口 |
| 按 `Ctrl` 下降时误触浏览器关闭标签页（Ctrl+W） | 浏览器级快捷键页面无法拦截：下降改用 `C` 键，或在 Firefox 中使用（按键拦截更宽松） |
| 状态行闪现「鼠标锁定失败，请再点击一次画布重试」 | 指针锁定偶发失败（如 Esc 后立即点击）：按提示再点一次画布即可，约 3s 自动恢复原文本 |
| 引导层报「这不是有效的（或暂不支持的）BSP 地图文件」 | 文件损坏或为暂不支持的 BSP 版本；确认选择的是 `.bsp`（拖入非 `.bsp` 文件也会被拒绝并提示） |

## 位姿（人物位置 + 视角）传入三通道——应用即生效

1. **URL 查询参数**（页面加载即应用）：
   `index.html?pos=100,50,200&ang=45,10`
2. **URL hash**（`hashchange` 实时应用，外部脚本改 `location.hash` 即响应）：
   `#pos=100,50,200&ang=45,10`
3. **JS API**（直接调用，响应最快）：
   ```js
   window.viewer.setPose({ pos: [x, y, z], ang: [yaw, pitch] });   // 数组或 {x,y,z}/{yaw,pitch} 对象均可
   const p = window.viewer.getPose();                              // { pos: [x,y,z], ang: [yaw,pitch] }
   ```

### 位姿约定（与 game 一致）

- `pos` = **人物脚底位置**（Y-up 世界坐标，GLB 空间）；相机眼位 = `pos + 眼高 64.09`
- `ang` = `[yawDeg, pitchDeg]`：yaw 0 = 面朝 −Z，正方向逆时针（俯视），即 game 的
  cs-movement yaw 约定（BSP yaw 经 `bspYawToCsYaw = (270 - yaw) % 360` 转换，出生点初始视角已自动转换）；
  pitch 正 = 仰视，±89° 限幅
- 无外部位姿时初始视角 = 推荐出生点（`info_player_start` 优先）

## 与 debug/game/test 的差异（运行时最小集）

| 项 | viewer | 参考工程 |
|---|---|---|
| WASM 依赖 | **仅 websurf-wasm-core**（无物理） | debug/game/test 均含 websurf-phys |
| 导出集 | metadata / spawn / GLB | + brush/模型碰撞/teleport/PVS/mosaic/默认纹理包 |
| 渲染 | GLB + 空间分块合并 + 雾（视距自适应） | + PVS/LOD/lightmap/画质切换/碰撞可视化 |
| 物理 | 无（纯飞行相机） | 主线程物理 + 权威 Worker |
| 面板/功能 | 无 | 计时挑战/存点/参数面板等 |