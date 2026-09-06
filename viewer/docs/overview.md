# viewer（WebSurf-viewer）总览

> 最后核对：2026-09-06。以实际代码为准（`viewer/src/` + `viewer/crates/wasm/` + 共享 `src/wasm-core/`）。
>
> BSP 地图游览 + 录像回放器：纯视觉——BSP 导入 → GLB 场景 + 自由飞行（无物理/碰撞），
> 并支持导入 JSON 录像、用**规则脚本**把它映射成标准帧后回放。
> 功能取舍以「地图游览 + 录像播放」两核心为准（量测/位姿 API/交互式标定/朝向诊断/
> 规则表单编辑器已按 core-simplify-plan 物理删除）。
> 公共架构见 `../../docs/architecture.md`；使用说明见 `../README.md`；
> 第三方格式转化脚本规范见 `replay-rule-ai.md`。

## 1. 定位与工程结构

| 目录/文件 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 薄导出层（唯一文件）：`BspProcessor` 最小集——metadata / parse_spawn_points / export_glb_with_pakfile_models；**不含 websurf-phys**（无物理） |
| `src/app.ts` | 主线程装配：BSP 加载 → GLB 场景 → 飞行相机 → 侧栏标签页 → 录像回放驱动 → `window.viewer.replay`（内省 + 播放控制） |
| `src/core/` | 与录像无关的通用层：`scene`（渲染/GLB 挂载/分块合并）、`fly`（飞行相机状态机）、`pose`（位姿类型/角度转换）、`bsp`（BSP 加载 + 人话级错误）、`dom`（构建小工具）、`constants` |
| `src/ui/` | 地图页（`mapinfo` 信息分层/出生点跳转/「更换地图」、`reference` 参考显示：地面网格+世界坐标轴）+ `hud`（三行状态角色行 / 引导层 / 拖拽反馈 / 兜底卡 / 帮助浮层） |
| `src/replay/` | 录像子系统：`codegen` 脚本编译与试跑校验、`default-rule` 内置默认规则（自家格式）、`rule-file` 规则文件双形态解析（.js / 规则 JSON）、`importer` 导入、`build` 帧映射+transform 后处理、`tracks` 多轨道、`player` 播放（`sampling` 采样）、`visuals` 可视化、`timeline` 时间轴、`panel`·`trackpanel` 面板 |
| `src/worker/parse-worker.ts` | 录像解析 Worker；esbuild 产物 `web/parse-worker.js`（构建生成，已 gitignore） |
| `test/replay-selftest.ts` | 录像管线 Node 自检（`npm run test:replay`），覆盖路径取值/帧探测/规则编译/transform 后处理/规则文件双形态/时间轴/容错/多轨道 |
| `index.html` | 入口页（canvas + 引导层 + 拖拽层 + HUD 状态行 + 帮助浮层 + 顶栏〔?帮助 / 面板〕+ 侧栏两标签页 + 底部时间轴） |
| `package.json` | 脚本：build:wasm / build:worker / build:ts / build / test:replay / test:smoke / build:dist（单一 dist）/ dev（复用 `../src/serve.py`） |

**共享实现**（`../../src/wasm-core/`）：BSP 解析 / GLB 导出 / PAKFILE 模型整合——与 debug/game/test
同一解析层，改一处全部生效。**不消费** ts-shared（无物理/权威帧/输入层需要）。

## 2. 功能模块（地图游览）

| 模块 | 说明 |
|---|---|
| 地图导入 | 引导层按钮（无地图时）/ 全窗拖拽 `.bsp` / 地图页顶部「更换地图」（已加载后）→ 主线程 BspProcessor；解析互斥（进行中忽略新触发），失败人话级错误回显 |
| 场景构建 | GLB 挂载 + 空间分块合并（数万 primitive Mesh → ~数百块）+ 相机 near/far 按地图尺寸自适应 + 近平面贴墙自适应（与 game 同法）；无 PVS/LOD/mosaic/默认纹理包/雾 |
| 自由视角 | 指针锁定鼠标视角 + WASD 平移 + 空格上升 / C 下降 + Shift ×4；**人物 = 相机**（pos 脚底 + 眼高 64.09） |
| 地图信息 | 侧栏「地图」页：默认 文件 / 出生点数 / 世界尺寸，「统计明细」折叠收纳 magic / brushes / faces / … / 包围盒 min·max；出生点单行列表（★ = 推荐点），点「跳转」即传送 |
| 参考显示 | 地图页底部：地面网格（512 HU 一格，按地图尺寸自适应）与世界坐标轴开关，自量测页迁入 |

## 3. 加载流程（主线程）

```
选择/拖入 .bsp → BspProcessor（主线程 wasm 懒初始化；解析互斥）
  → metadata()（状态行：magic/brushes/...）
  → parse_spawn_points()（初始视角默认位；借用导出须在 GLB 之前）
  → export_glb_with_pakfile_models()（消费 Bsp；GLB 含 PAKFILE 模型，未打包则回退纯地图导出）
  → GLTFLoader.loadAsync（Blob URL）→ 场景挂载
  → optimizeScene()（空间分块合并）→ 相机 near/far 按地图尺寸自适应（near=maxDim/1000、far=maxDim×100，与 game 同法）
  → 世界包围盒下发：地图信息面板 + 参考显示网格 + 录像贴合检查
  → 初始视角：推荐出生点（bspYawToCsYaw 转换）
  → 渲染循环（rAF）
```

**关键约定**：`export_glb_with_pakfile_models` 消费内部 Bsp 实例，必须最后调用
（与 debug/game/test 同约束）。

**失败路径**：加载任一步失败——无地图时回引导层展示人话级错误卡（原始信息小字折叠），
已有地图时仅状态行闪现、画面保留；启动期异常（WebGL 构造失败 / `app.js`·wasm 缺失）
由 `#fatal` 兜底卡给出构建指引（wasm 404 指向 `npm run build:wasm`）。

## 4. JS 接口：window.viewer.replay

只读内省 + 播放控制（外部脚本 / 自动化用；不存在位姿三通道——相机只受飞行控制与录像驱动）：

| 成员 | 说明 |
|---|---|
| `trackCount` / `duration` / `time` / `playing` / `speed` / `mode` / `followId` | 状态快照（秒，主时钟） |
| `sceneObjects` | 场景根对象数 |
| `tracks()` | 各轨道只读信息 `{ id, name, frames, duration, offset, visible, color, firstPos }` |
| `play()` / `pause()` / `seek(sec)` | 播放控制（seek 被 A-B 区间夹取） |
| `setSpeed(x)` / `setMode('first'\|'third')` / `follow(trackId\|null)` | 倍速 / 视角 / 跟随目标（null = 第一条） |

## 5. 录像回放子系统

设计前提：录像 JSON **结构千奇百怪**（帧数组藏在哪一层不确定；XYZ 可能是 Z-up、可能要换轴、
可能要取反、单位可能是米/英寸；朝向可能是度或弧度、yaw 零点各异、pitch 正方向可能相反）。
所以不试图「猜格式」：**自家标准格式内置默认规则直接播；第三方格式交給 AI 按规范写 .js**
（`docs/replay-rule-ai.md`，含提示词模板）。

### 5.1 管线

```
任意 JSON ──自动探测──▶ 「元素为对象的最长数组」当帧序列（特殊结构走 rule.framePath）
      │
      ├─ 规则层：scriptSrc（内置默认 / .js 文件 / 深链 ?rule= / localStorage）
      │            (raw, i, H) => { t, pos:[x,y,z], ang:[yaw,pitch,roll], vel:[x,y,z]|null }
      │
      └─ buildClip ──▶ transform 后处理（offset + yawDeg，人工微调）──▶
                       Clip（Float64Array t / Float32Array pos·ang·vel，定型数组）
                              │
                              ├─ TrackSet（多轨道：配色 / 显隐 / 时间偏移 / 跟随目标）
                              │     └─ 主时钟 t → 各轨道 local = t − offset
                              ├─ ReplayPlayer（主时钟：倍速 / A-B / 循环 / 逐帧）
                              ├─ ReplayVisuals（每轨道一套轨迹线 / 幽灵 / 起终点标记）
                              └─ Timeline（主时钟控制条）
```

`Clip` 是播放层唯一认识的东西——规则怎么改都不影响播放器。

**替换 vs 追加**：换文件导入 = 追加一条轨道；改规则/改变换后的重新导入 =
`TrackSet.replaceClip()` 替换当前那条（保留配色/显隐/偏移/名字）。少了这条，
每次改规则都会刷出一条重复轨迹。

### 5.2 规则脚本

- **编译契约**：`scriptSrc` 是「求值为 `(raw, i, H) => Frame` 的单表达式」，
  `compileScript` 以 `new Function('H', '"use strict"; return (' + src + ');')` 编译
  （源码会先剥掉 AI 产码常见的尾分号再编译）
- **来源**：内置默认（`default-rule.ts`，自家格式直通 tick 128）｜`.js` 文件（AI 按
  `replay-rule-ai.md` 产出）｜深链 `?rule=`（JSON 或裸 .js）｜localStorage 持久化
- **双形态判定**（`rule-file.ts`）：文本 trim 后以 `{` 开头按规则 JSON 解析
  （须 `version:1` + `scriptSrc`），否则按裸脚本文本处理；坏输入报人话错误
- 脚本能用的全部能力都在 `helpers.REPLAY_HELPERS`：

| H 成员 | 作用 |
|---|---|
| `H.get(raw, path)` | 按 `a.b[0].c` 路径取值，取不到返回 undefined（不抛） |
| `H.num(v)` | 转数字，转不成返回 NaN（会被校验阶段抓出） |
| `H.wrap(deg)` | 角度归一 [0,360) |
| `H.clampPitch(deg)` | ±89° 限幅 |
| `H.deg(rad)` | 弧度 → 度 |
| `H.clamp(v, lo, hi)` | 区间夹取 |
| `H.EYE` | 站立眼高 64.09（输入是眼位时减它换算回脚底） |

- Source/Shavit 系映射的定标结论（`(x,y,z)→(y,z,x)`、`yaw+180`、pitch 取反）固化在
  `replay-rule-ai.md` §7 示例与 selftest [6] 用例中，改动前先读定标依据

### 5.3 transform 后处理（变换调整）

`RuleConfig.transform = { offset: [x,y,z], yawDeg: n }` 在 `buildClip` 输出之后统一施加
（`build.ts applyClipTransform`）：

- 绕 Y 旋转 θ：pos/vel 用标准 Y 旋转，与「yaw 直接加 θ」自洽（viewer yaw 0 = −Z、逆时针为正）
- bbox 全量重算；速度模长不变（刚体变换）；恒等变换直接跳过
- 面板「变换调整」：平移 X/Y/Z + yaw 输入（0.5s 防抖重导）+ `yaw ±90°` 快捷 + 重置 +
  「一键锚定到出生点」（起点偏差叠加进 offset）；改动随规则持久化

### 5.4 解析位置与回退

优先走 `src/worker/parse-worker.ts`（不卡 UI + 缓存已解析 JSON，调规则不重解析几十 MB 文件），
定型数组零拷贝回传。`ReplayImporter` 在 Worker 起不来时自动回退主线程同源路径
（`importer.ts` 的 `importOnMain`），行为一致。

### 5.5 容错

- **probe 前置校验**：拿首/中/末三帧试跑脚本，语法错误、字段取不到、NaN 都在导入前报错，
  并附上原始帧摘要，避免「导入成功但一片空白」
- **buildClip 兜底**：整段扫描时个别帧 NaN 或时间回退，沿用上一帧值并汇总成警告条数
  （时间必须单调不减，否则二分查找失效）
- **地图贴合检查**：任一轨道的 bbox 整段落在地图包围盒外时，HUD 录像提醒行给出跨面提示
  （用户不在录像页也能看到）；「录像起点离最近出生点远」的细节与处理只在录像页
  「变换调整」分区呈现——HUD 不重复同因告警，≤128 / ≥1024 阈值口径见帮助浮层

## 6. 多轨迹对比（Q2）

`TrackSet` 持有 N 条 `Track`（clip + 配色 + 显隐 + `offset` + 名字），
`ReplayPlayer` 只持有一个**主时钟**，各轨道按 `localTime = t − offset` 映射到自己的内部时间。

| 语义 | 行为 |
|---|---|
| 主时钟总长 | `max(offset + 各轨道时长)` |
| 轨道还没开始（`local < 0`） | 采样 `null`，幽灵不显示 |
| 轨道已播完（`local > duration`） | 夹到末帧，**停在终点**而不是消失 |
| 跟随目标（`followId`） | 第一人称相机与速度读数取自它；第一人称下只隐藏它的幽灵，其余保留 |
| 可见性 | 只影响渲染（`ReplayVisuals`），不影响 `sampleAll()` |

`offset` 是对比的核心：起跑时刻不同的两次跑法，靠它对齐到同一条时间轴。

## 7. 规模与性能（Q5）

| 场景 | 帧数（67 tick/s） | 定型数组内存 | JSON 文本（估） |
|---|---|---|---|
| 40 分钟 | 160,800 | ~7 MB | ~24 MB |
| 12 小时 | 289,440 | ~13 MB | ~43 MB |

结论：**不需要分块流式**。已做的三处适配：

- 解析全程在 Worker，定型数组零拷贝回传，不卡 UI
- 轨迹线抽稀到 `MAX_TRAIL_POINTS = 40000`（29 万帧 → stride 8）
- 进度回调节流为「约每 2%，且至少隔 4096 帧」（原来是每 131072 帧，29 万帧只报 2 次）

## 8. 渲染循环时序

```
rAF
 ├─ dt = clamp(now − last, 0.05)
 ├─ player.update(dt)（播放推进 / 循环 / A-B 区间回绕）
 ├─ 分支：
 │   ├─ 录像第一人称：fly.drivesCamera=false, allowMove=false
 │   │   fly.setWorld(pos, yaw, pitch, roll) → fly.applyToWithRoll(camera)
 │   ├─ 其余：fly.roll=0（清 roll 残留）→ 鼠标增量（削平 ±1000px）→ yaw/pitch（±89°）
 │   │   → 按键位移（forward=(−sin yaw,0,−cos yaw)；right=(cos yaw,0,−sin yaw)；Shift ×4）
 │   │   → fly.applyTo(camera)：rotation.set(pitch, yaw, 0, 'YXZ')；position = pos + (0,64.09,0)
 ├─ visuals.update(player.sampleAll(), mode, followId)：
 │      每条轨道的幽灵位姿；第一人称下只隐藏被跟随的那条（贴在相机上会挡视线）
 ├─ renderer.render
 └─ 10Hz（80ms）：HUD 位姿行 + 时间轴读数刷新
```

## 9. 与 debug/game/test 的差异速览

| 项 | viewer | debug / game / test |
|---|---|---|
| WASM 依赖 | **仅 websurf-wasm-core**（无物理） | 均含 websurf-phys（PhysWorld） |
| 导出集 | metadata / spawn / GLB | + brush/模型碰撞/teleport/PVS/mosaic/默认纹理包/调试 API |
| 物理 | 无（纯飞行相机） | 主线程物理 + 权威 Worker（debug/game）；双模物理（test） |
| 渲染 | GLB + 分块合并 + 近平面自适应（同 game；无雾） | + PVS/LOD/lightmap/画质切换/碰撞可视化/trace 路径 |
| 面板/功能 | 地图信息 / 出生点跳转 / 参考显示 / **录像回放** | 计时挑战/存点/键位/参数面板等 |
| 位姿输入 | 无外部通道（飞行相机 + 录像驱动 + 出生点跳转） | 无（游戏内传送/存点/出生点） |

**不共享**（工程特有）：渲染层（相机/分块合并/近平面自适应——方法已与 game 对齐）、录像子系统、HUD——均各自维护。
