# viewer（WebSurf-viewer）总览

> 最后核对：2026-09-02。以实际代码为准（`viewer/src/` + `viewer/crates/wasm/` + 共享 `src/wasm-core/`）。
>
> BSP 地图预览 + 录像回放器：纯视觉——BSP 导入 → GLB 场景 + 自由视角（无物理/碰撞），
> 支持外部传入**人物位置 + 视角**（位姿）实时应用，并支持导入**任意结构 JSON 录像**、
> 用**可自编写的规则脚本**把它映射成标准帧后回放。
> 公共架构见 `../../docs/architecture.md`；使用说明见 `../README.md`。

## 1. 定位与工程结构

| 目录/文件 | 内容 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 薄导出层（唯一文件）：`BspProcessor` 最小集——metadata / parse_spawn_points / export_glb_with_pakfile_models；**不含 websurf-phys**（无物理） |
| `src/app.ts` | 主线程装配：BSP 加载 → GLB 场景 → 飞行相机 → 位姿三通道 → 侧栏标签页 → 录像回放驱动 |
| `src/core/` | 与录像无关的通用层：`scene`（渲染/GLB 挂载/分块合并）、`fly`（飞行相机状态机）、`pose`（位姿解析/归一化）、`bsp`（BSP 加载 + 人话级错误）、`dom`（构建小工具）、`constants` |
| `src/ui/` | 侧栏面板 + HUD 域：`mapinfo`（地图信息分层 / 出生点跳转 / 顶部「更换地图」）、`measure`（两点量测单区）、`hud`（HUD 三行状态角色行 / 引导层 / 拖拽反馈 / 兜底卡 / 帮助浮层） |
| `src/replay/` | 录像子系统：`codegen` 规则编译 / `importer` 导入 / `tracks` 多轨道 / `player` 播放（`sampling` 采样）/ `calib` 标定 / `orientation` 朝向一致性诊断 / `visuals` 可视化 / `timeline` 时间轴 / `panel`·`trackpanel`·`calibpanel` 面板 |
| `src/worker/parse-worker.ts` | 录像解析 Worker；esbuild 产物 `parse-worker.js`（构建生成，已 gitignore） |
| `test/replay-selftest.ts` | 录像管线 Node 自检（`npm run test:replay`），覆盖路径取值/帧探测/规则编译/时间轴/坐标系预设/容错/朝向一致性 |
| `index.html` | 入口页（canvas + 引导层 + 拖拽层 + HUD 状态行 + 帮助浮层 + 顶栏〔?帮助 / 面板〕+ 侧栏三标签页 + 底部时间轴） |
| `package.json` | 脚本：build:wasm / build:worker / build:ts / build / test:replay / build:dist（单一 dist）/ dev（复用 `../src/serve.py`） |

**共享实现**（`../../src/wasm-core/`）：BSP 解析 / GLB 导出 / PAKFILE 模型整合——与 debug/game/test
同一解析层，改一处全部生效。**不消费** ts-shared（无物理/权威帧/输入层需要）。

## 2. 功能模块（地图预览）

| 模块 | 说明 |
|---|---|
| 地图导入 | 引导层按钮（无地图时）/ 全窗拖拽 `.bsp` / 地图页顶部「更换地图」（已加载后）→ 主线程 BspProcessor；解析互斥（进行中忽略新触发），失败人话级错误回显 |
| 场景构建 | GLB 挂载 + 空间分块合并（数万 primitive Mesh → ~数百块）+ 相机 near/far 按地图尺寸自适应 + 近平面贴墙自适应（与 game 同法）；无 PVS/LOD/mosaic/默认纹理包/雾 |
| 自由视角 | 指针锁定鼠标视角 + WASD 平移 + 空格上升 / C 下降 + Shift ×4；**人物 = 相机**（pos 脚底 + 眼高 64.09） |
| 地图信息 | 侧栏「地图」页：默认 文件 / 出生点数 / 世界尺寸，「统计明细」折叠收纳 magic / brushes / faces / … / 包围盒 min·max；顶部「更换地图」；出生点单行列表（★ = 推荐点），点「跳转」即传送 |
| 量测 | 侧栏「量测」页：两次点击取点（射线拾取），输出两点距离与轴向分量；拾取期间自动让出指针锁定 |
| 位姿通道 | URL 查询参数 / URL hash / `window.viewer` JS API——三通道应用即生效（见 §4） |

## 3. 加载流程（主线程）

```
选择/拖入 .bsp → BspProcessor（主线程 wasm 懒初始化；解析互斥）
  → metadata()（状态行：magic/brushes/...）
  → parse_spawn_points()（初始视角默认位；借用导出须在 GLB 之前）
  → export_glb_with_pakfile_models()（消费 Bsp；GLB 含 PAKFILE 模型，未打包则回退纯地图导出）
  → GLTFLoader.loadAsync（Blob URL）→ 场景挂载
  → optimizeScene()（空间分块合并）→ 相机 near/far 按地图尺寸自适应（near=maxDim/1000、far=maxDim×100，与 game 同法）
  → 世界包围盒下发：地图信息面板 + 量测网格 + 录像贴合检查
  → 初始视角：外部位姿（URL/API）优先，否则推荐出生点（bspYawToCsYaw 转换）
  → 渲染循环（rAF）
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
- **录像第一人称回放期间位姿通道被忽略**（相机由播放器驱动），切回第三人称/清空录像即恢复

## 5. 录像回放子系统

设计前提：录像 JSON **结构千奇百怪**（帧数组藏在哪一层不确定；XYZ 可能是 Z-up、可能要换轴、
可能要取反、单位可能是米/英寸；朝向可能是度或弧度、yaw 零点各异、pitch 正方向可能相反）。
所以不试图「猜格式」，而是把**映射规则的编写权交给用户**。

### 5.1 管线

```
任意 JSON ──probe──▶ 候选帧数组路径 + 首帧样例
      │
      ├─ 规则层：RuleConfig（表单） ⇄ 规则脚本（可手改，改后即为权威）
      │            (raw, i, H) => { t, pos:[x,y,z], ang:[yaw,pitch,roll], vel:[x,y,z]|null }
      │
      └─ buildClip ──▶ Clip（Float64Array t / Float32Array pos·ang·vel，定型数组）
                              │
                              ├─ TrackSet（多轨道：配色 / 显隐 / 时间偏移 / 跟随目标）
                              │     └─ 主时钟 t → 各轨道 local = t − offset
                              ├─ ReplayPlayer（主时钟：倍速 / A-B / 循环 / 逐帧）
                              ├─ ReplayVisuals（每轨道一套轨迹线 / 幽灵 / 起终点标记）
                              └─ Timeline（主时钟控制条）
```

`Clip` 是播放层唯一认识的东西——规则怎么改都不影响播放器。

**替换 vs 追加**：换文件导入 = 追加一条轨道；改规则后的重新导入 =
`TrackSet.replaceClip()` 替换当前那条（保留配色/显隐/偏移/名字）。少了这条，
每次改规则都会刷出一条重复轨迹。

### 5.2 规则：表单与脚本不是两套机制

表单**只负责生成**一段可读的规则脚本（见 `codegen.generateScript`）。用户一旦手改脚本，
就打上 `customized` 标记，表单改动不再覆盖；想回到表单驱动点「从表单重新生成」。
两者能力完全对等，因为脚本能用的全部能力都在 `helpers.REPLAY_HELPERS`：

| H 成员 | 作用 |
|---|---|
| `H.get(raw, path)` | 按 `a.b[0].c` 路径取值，取不到返回 undefined（不抛） |
| `H.num(v)` | 转数字，不可转为 NaN（会被校验阶段抓出） |
| `H.wrap(deg)` | 角度归一 [0,360) |
| `H.clampPitch(deg)` | ±89° 限幅 |
| `H.deg(rad)` | 弧度 → 度 |
| `H.clamp(v, lo, hi)` | 区间夹取 |
| `H.EYE` | 站立眼高 64.09（输入是眼位时减它换算回脚底） |

坐标系差异由表单这几项覆盖，不够就在脚本里直接算：

| 表单项 | 说明 |
|---|---|
| 轴映射 + 符号 | 输出 X/Y/Z 各自取自输入哪个轴、是否取反（位置与速度共用同一套） |
| 单位缩放 | 位置与速度同乘（英寸/米 → HU） |
| 输入是眼位 | 输出 Y 减 64.09 换算回脚底 |
| 角度单位 | 度 / 弧度 |
| yaw 系数 + 偏移 | `yaw_out = wrap(yaw_in × 系数 + 偏移)` |
| pitch / roll 符号 | Source 系 pitch 正为俯视，需取反 |
| 时间来源 | 等间隔 tick（t = 序号 / tickrate）或帧内时间字段（秒 / 毫秒 / tick 数） |

内置四个坐标系**预设**作起点（viewer 原生 Y-up / BSP·Hammer 实体 Z-up / Source demo Z-up /
Shavit 录像 .replay），导入后仍需对照地图目视确认；Source 系录像的朝向可用「朝向诊断」（§5.5）
量化验证。`tools/shavit-replay-to-json.mjs` 可把
Shavit/SurfTimer 二进制 `.replay` 直接转成可导入 JSON + 配套规则（Source Z-up 映射，含 tickrate）。

### 5.3 解析位置与回退

优先走 `src/worker/parse-worker.ts`（不卡 UI + 缓存已解析 JSON，调规则不重解析几十 MB 文件），
定型数组零拷贝回传。`ReplayImporter` 在 Worker 起不来时自动回退主线程同源路径
（`importer.ts` 的 `probeOnMain` / `importOnMain`），行为一致。

### 5.4 容错

- **probe 前置校验**：拿首/中/末三帧试跑脚本，语法错误、字段取不到、NaN 都在导入前报错，
  并附上原始帧摘要，避免「导入成功但一片空白」
- **buildClip 兜底**：整段扫描时个别帧 NaN 或时间回退，沿用上一帧值并汇总成警告条数
  （时间必须单调不减，否则二分查找失效）
- **地图贴合检查**：任一轨道的 bbox 整段落在地图包围盒外时，HUD 录像提醒行给出跨面提示
  （用户不在录像页也能看到）；「录像起点离最近出生点远」的细节与处理只在录像页「起点对齐」
  分区呈现——HUD 不重复同因告警，≤128 / ≥1024 阈值口径见帮助浮层

### 5.5 朝向诊断与一键修正（只用录像自身数据）

Source 系录像（Shavit .replay 等）的「朝向反了/方向不对」问题很难目视量化，面板块
「录像」→「朝向诊断」用**首段轨迹移动方向 vs 首帧朝向夹角**做确定性判定（算法实现
`src/replay/orientation.ts`，参数与推导见 `notes/requirements.md` §1/§2）：

- 判据（**保角自洽**）：首段移动方向与首帧朝向的夹角在源空间与 viewer 空间**分别**计算，
  相等（|θ_view − θ_src| ≤ 1°）即判定 yaw 补偿与轴映射配套（PASS）；绝对夹角大小不作失败条件
  （surf 起跑常侧身蹭速，正身夹角可 >35°）。源空间位移 < 24 HU 或起跑即转向（|Δyaw| ≥ 45° 且
  收缩后 < 10 帧）→ SKIP（数据不足，不算失败）；录像头部带 `preFrames` 时自动用 run 起点
  附加窗口复核。
- 保角意义：|θ_view − θ_src| ≤ 1° 说明映射链是**纯旋转粘合**（本项目唯一正确的是
  位置 `(y,z,x)`（含 GLB/出生点 rotate_yup）+ viewerYaw = srcYaw + 180 + pitch 取反；
  旧的 glTF 风格 `(x,z,−y)+yaw−90` 与它差 90°，回放会整体侧转/穿墙——已降级为「gltf-zup」预设并标注不匹配）。
- 一键修正：候选 = 当前输出 yaw 施加 {0°, +90°, −90°, +180°}（≡ yawOffset 平移），取与源空间
  自洽（|θ_view − θ_src| ≤ 1°）者应用并重新导入；所有候选都不自洽 → 提示目视确认 / 坐标系标定。
  **pitch 不参与自动修正**（Source pitch 正=俯视、viewer 正=仰视是约定固化项，由映射单测锁定；
  水平移动无法验证 pitch）。
- 自动化钩子：`window.viewer.replay.orientation`（最近诊断结果；未运行过为 `null`）；
  CLI `node tools/verify-replay-orient.mjs <replay.json> [rule.json]`（退出码 0=PASS / 1=FAIL / 2=SKIP）。

> 位置正确性（轨迹是否与地图贴合）不属于本断言——由「起点对齐」与「坐标系标定」负责，二者独立。

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

## 7. 坐标系标定（Q4）

`calib.ts` 是纯函数模块（配 Node 自检）。搜 `out = scale · S · P · in + T`：

- 轴置换 6 种 × 符号 8 种 = 48 个候选
- 给定 (P, S) 后，scale 与 T 有**闭式最小二乘解**：
  先对两侧各自去均值消掉 T，再 `scale = Σa·b / Σb·b`，最后 `T = w̄ − scale·ū`
- 负 scale 与「符号全取反」等价（后者已在枚举里），跳过以免重复解
- 输出最大残差，并对这些情况给出警告：对应点不足 3 组（无冗余）、
  残差相对点位跨度 > 2%、解为镜像（det −1）、次优解与最优接近

世界侧坐标两个来路：`MapPanel.spawnPoints`（出生点）与 `fly.getPose().pos`（当前脚底位置）。
录像侧原始坐标走 `importer.readRawPos()`，在 Worker 里从已解析的 JSON 上按 posX/posY/posZ 路径取值，
不触发二次解析。

## 8. 规模与性能（Q5）

| 场景 | 帧数（67 tick/s） | 定型数组内存 | JSON 文本（估） |
|---|---|---|---|
| 40 分钟 | 160,800 | ~7 MB | ~24 MB |
| 12 小时 | 289,440 | ~13 MB | ~43 MB |

结论：**不需要分块流式**。已做的三处适配：

- 解析全程在 Worker，定型数组零拷贝回传，不卡 UI
- 轨迹线抽稀到 `MAX_TRAIL_POINTS = 40000`（29 万帧 → stride 8）
- 进度回调节流为「约每 2%，且至少隔 4096 帧」（原来是每 131072 帧，29 万帧只报 2 次）
- 帧数 ≥ `LARGE_CLIP_FRAMES = 100_000` 时面板提示关掉「改完自动重新导入」

## 9. 渲染循环时序

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

## 10. 与 debug/game/test 的差异速览

| 项 | viewer | debug / game / test |
|---|---|---|
| WASM 依赖 | **仅 websurf-wasm-core**（无物理） | 均含 websurf-phys（PhysWorld） |
| 导出集 | metadata / spawn / GLB | + brush/模型碰撞/teleport/PVS/mosaic/默认纹理包/调试 API |
| 物理 | 无（纯飞行相机） | 主线程物理 + 权威 Worker（debug/game）；双模物理（test） |
| 渲染 | GLB + 分块合并 + 近平面自适应（同 game；无雾） | + PVS/LOD/lightmap/画质切换/碰撞可视化/trace 路径 |
| 面板/功能 | 地图信息 / 出生点跳转 / 量测 / **录像回放** | 计时挑战/存点/键位/参数面板等 |
| 位姿输入 | URL/hash/JS API | 无（游戏内传送/存点/出生点） |

**不共享**（工程特有）：渲染层（相机/分块合并/近平面自适应——方法已与 game 对齐）、位姿通道、录像子系统、HUD——均各自维护。
