# viewer（WebSurf-viewer）总览

> 最后核对：2026-08-24。以实际代码为准（`viewer/src/` + `viewer/crates/wasm/` + 共享 `src/wasm-core/`）。
>
> 最小 BSP 自由视角查看器：纯视觉——BSP 导入 → GLB 场景 + **仅自由视角**（无物理/碰撞/面板），
> 支持外部传入**人物位置 + 视角**（位姿）并实时应用。公共架构见 `../../docs/architecture.md`；
> 使用说明见 `../README.md`。

## 1. 定位与工程结构

| 目录/文件 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 薄导出层（唯一文件）：`BspProcessor` 最小集——metadata / parse_spawn_points / export_glb_with_pakfile_models；**不含 websurf-phys**（无物理） |
| `src/app.ts` | 主线程入口（唯一 TS）：BSP 解析 → GLB 场景（分块合并/雾/视距自适应）→ 飞行相机 → 位姿三通道 |
| `index.html` | 入口页（canvas + 首访引导层 + 拖拽/文件选择 + 启动兜底卡 + HUD） |
| `Cargo.toml` | Rust workspace（单一 crate + vmdl patch，同 debug/game/test） |
| `package.json` | 构建脚本（build:wasm / build:ts / dev，复用 `../src/serve.py`） |

**共享实现**（`../../src/wasm-core/`）：BSP 解析 / GLB 导出 / PAKFILE 模型整合——与 debug/game/test
同一解析层，改一处全部生效。**不消费** ts-shared（无物理/权威帧/输入层需要）。

## 2. 功能模块

| 模块 | 说明 |
|---|---|
| 地图导入 | 引导层按钮 / 全窗拖拽 / 右上角按钮选 `.bsp` → 主线程 BspProcessor：metadata → spawn → GLB（消费顺序；GLB 导出须最后）；解析互斥（进行中忽略新触发），失败人话级错误回显（无地图回引导层，有地图状态行闪现） |
| 场景构建 | GLB 挂载 + 空间分块合并（数万 primitive Mesh → ~数百块，移植自 test worker-b，已验证）+ 视距/雾按世界包围盒自适应；无 PVS/LOD/mosaic/默认纹理包 |
| 自由视角 | 指针锁定鼠标视角 + WASD 平移 + 空格上升 / Ctrl·C 下降 + Shift ×4；**人物 = 相机**（pos 脚底 + 眼高 64.09） |
| 位姿通道 | URL 查询参数 / URL hash / `window.viewer` JS API——三通道应用即生效（见 §4） |

## 3. 加载流程（主线程）

```
选择/拖入 .bsp → BspProcessor（主线程 wasm 懒初始化；解析互斥）
  → metadata()（状态行：magic/brushes/...）
  → parse_spawn_points()（初始视角默认位；借用导出须在 GLB 之前）
  → export_glb_with_pakfile_models()（消费 Bsp；GLB 含 PAKFILE 模型，未打包则回退纯地图导出）
  → GLTFLoader.loadAsync（Blob URL）→ 场景挂载
  → optimizeScene()（空间分块合并）→ 视距 far/fog 按世界包围盒自适应
  → 初始视角：外部位姿（URL/API）优先，否则推荐出生点（bspYawToCsYaw 转换）
  → 渲染循环（rAF：鼠标/飞行 → 相机同步 → renderer.render）
```

**关键约定**：`export_glb_with_pakfile_models` 消费内部 Bsp 实例，必须最后调用
（与 debug/game/test 同约束）。

**失败路径**：加载任一步失败——无地图时回引导层展示人话级错误卡（原始信息小字折叠），
已有地图时仅状态行闪现、画面保留；启动期异常（WebGL 构造失败 / `app.js`·wasm 缺失）
由 `#fatal` 兜底卡给出构建指引（wasm 404 指向 `npm run build:wasm`）。

## 4. 位姿（人物位置 + 视角）三通道——应用即生效

| 通道 | 形式 | 时机 |
|---|---|---|
| URL 查询参数 | `?pos=x,y,z&ang=yaw,pitch` | 页面加载即应用 |
| URL hash | `#pos=x,y,z&ang=yaw,pitch` | `hashchange` 实时应用（外部脚本改 `location.hash` 即响应） |
| JS API | `window.viewer.setPose({pos, ang})` / `getPose()` | 直接调用（响应最快） |

**位姿约定**（与 game 一致）：
- `pos` = **人物脚底位置**（Y-up 世界坐标，GLB 空间）；相机眼位 = `pos + 64.09`
- `ang` = `[yawDeg, pitchDeg]`：yaw 0 = 面朝 −Z，正方向逆时针（俯视）= game 的 cs-movement yaw
  约定（BSP yaw 经 `bspYawToCsYaw = (270 − yaw) % 360` 转换，出生点初始视角已自动转换）；
  pitch 正 = 仰视，±89° 限幅
- setPose 兼容数组与对象形式（`{x,y,z}` / `{yaw,pitch}`）；getPose 返回数组形式
- 无外部位姿时初始视角 = 推荐出生点（`info_player_start` 优先）

## 5. 渲染循环时序

```
rAF
 ├─ dt = clamp(now − last, 0.05)（首帧起步）
 ├─ 锁定中：鼠标增量（削平 ±1000px）→ yaw/pitch（pitch ±89° 限幅）
 ├─ 锁定中：按键 → 相机相对方向移动（forward = (−sin yaw, 0, −cos yaw)；
 │   right = (cos yaw, 0, −sin yaw)；空格 +Y / Ctrl·C −Y；Shift ×4）
 ├─ syncCamera：rotation.set(pitch, yaw, 0, 'YXZ')；position = pos + (0, 64.09, 0)
 ├─ renderer.render（three.js 视锥剔除；分块合并后 draw call = 块数 × 材质）
 └─ HUD 位姿行 10Hz 刷新（getPose 同源）
```

## 6. 与 debug/game/test 的差异速览（运行时最小集）

| 项 | viewer | debug / game / test |
|---|---|---|
| WASM 依赖 | **仅 websurf-wasm-core**（无物理） | 均含 websurf-phys（PhysWorld） |
| 导出集 | metadata / spawn / GLB | + brush/模型碰撞/teleport/PVS/mosaic/默认纹理包/调试 API |
| 物理 | 无（纯飞行相机） | 主线程物理 + 权威 Worker（debug/game）；双模物理（test） |
| 渲染 | GLB + 分块合并 + 雾 | + PVS/LOD/lightmap/画质切换/碰撞可视化/trace 路径 |
| 面板/功能 | 无 | 计时挑战/存点/键位/参数面板等 |
| 位姿输入 | URL/hash/JS API（本工程核心） | 无（游戏内传送/存点/出生点） |

**不共享**（工程特有）：渲染层（相机/分块合并/雾）、位姿通道、HUD——均各自维护。