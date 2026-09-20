# WebSurf-viewer — BSP 地图游览 + 录像回放

> 定位：**两个核心功能**——① BSP 地图导入 → GLB 场景 + 自由飞行游览（无物理/碰撞）；
> ② 导入 Shavit `.replay` 录像（二进制原生解析），以帧自身坐标回放（纯观察，不做物理重演）。
> 其他一切以这两者为取舍标准：不做的功能直接不存在。
>
> 地图导入构筑场景为最小实现：无 physics Worker、无 mosaic/默认纹理包、无 PVS/LOD、无传送点。

| 文件 | 说明 |
|---|---|
| `crates/wasm/src/lib.rs` | WASM 薄导出层：`BspProcessor` 最小集（metadata / parse_spawn_points / export_glb_with_pakfile_models），**不含 websurf-phys** |
| `src/app.ts` | 主线程装配：BSP → GLB 场景 + 飞行相机 + 侧栏面板 + 录像回放驱动 + `window.viewer.replay` 接口 |
| `src/core/` | 通用层：场景 / 飞行相机 / 位姿类型 / BSP 加载 / DOM 工具 / 常量 |
| `src/ui/` | 地图页（信息 · 出生点）+ HUD/引导层/帮助浮层 + 录像信息条（`.replay` 头部元信息） |
| `src/replay/` | 录像子系统：`.replay` 原生解析（含坐标定标映射）/ 导入 / 播放 / 可视化 / 时间轴 / 轨迹列表 / 坐标映射切换 / 调整工具 |
| `../../documents/viewer/implementation/shavit-replay-format.md` | Shavit `.replay` 二进制格式规格（replay-file.inc 对齐 + 真实文件逐字节验证） |
| `../../documents/viewer/replay-rule-ai.md` | 历史注记：`.js` 规则脚本通道已于 2026-09 移除（原稿已移出版本库，见 git 历史） |
| `test/replay-selftest.ts` | 录像管线 Node 自检（`npm run test:replay`） |

共享 `src/wasm-core/`（BSP 解析/GLB 导出），vmdl patch 同 debug/game/test。

## 快速上手（三步）

> 前置：Node.js ≥ 18；Rust 工具链 + **wasm-pack**（WASM 构建必需，`cargo install wasm-pack`
> 安装，或参考 [官方安装器](https://rustwasm.github.io/wasm-pack/installer/)）。

1. **安装依赖**：`npm install`
2. **构建产物**：`npm run build:wasm`（wasm-pack release → `pkg/`，并拷贝 wasm 到 `web/`）
   + `npm run build:ts`（typecheck + esbuild 出 `web/app.js` 与 `web/worker.js`）；两步可合并为 `npm run build`
3. **启动**：`npm run dev`（即 `python ../../src/serve.py 8080 .`）→ 打开 <http://localhost:8080/web/>；
   或者打包后**双击 `play.cmd`**（自动起服务器 + 开浏览器，见下节）

自检（可选，改录像链路时建议跑）：

| 命令 | 覆盖 |
|---|---|
| `npm run test:replay` | 录像管线 Node 自检（153 项断言）：真实 `.replay`（本地 `test/maps/surf_null_4.replay`）逐字节解析 / 头部元信息与 zoneOffset 闭环 / 坐标定标与朝向自洽（run 段 view·motion cos）/ 坐标映射切换 / transform 后处理 / 播放与 A-B / 多轨道 / 异常输入与版本护栏 |
| `npm run test:smoke` | 真浏览器冒烟（CDP 驱动本机 Edge headless）：页面加载 → 面板渲染 → 导入真实 `.replay` → 录像信息条 → 播放基准（帧自身坐标，坐标级断言）→ 播放 / A-B → 调整工具 → 多轨迹增删与跟随 → 拖入合成 V2 `.replay` → 坐标映射切换 → 播放控制 API（含 `meta()`）→ 地图页（参考显示已移除），并断言全程无 console error |

> `test:smoke` 需要另开一个终端跑着 `npm run dev`，并需要 `ws`（`npm i ws`）与 Edge/Chromium；
> 路径可用 `EDGE_PATH` / `WS_PATH` / `SMOKE_URL` / `SMOKE_PORT` 覆盖。

加载地图：还没有地图时点引导层「选择 BSP 地图…」按钮，或直接把 `.bsp` 文件**拖进窗口**
（多文件取首个；解析进行中忽略重复触发）。地图加载后，换图入口在侧栏「地图」页顶部的
「更换地图」（拖拽 `.bsp` 仍全局可用）。本地地图副本统一放 **`test/maps/`**（仓库根 `maps/` 已废弃，见根 [README.md](../../README.md) §4）。

> 只想验证录像链路、手头没有 BSP？直接把 `test/maps/surf_null_4.replay`（原生 Shavit 示例录像，
> 本地未跟踪）拖进窗口；打包后的 dist 则有内置示例深链（见下节「深链示例」）。

## 打包与部署（单一 dist，双击即用）

| 命令 | 产物 | 用途 |
|---|---|---|
| `npm run build:dist` | `dist/`（唯一产物） | **本地双击 `dist/index.html` 直接打开（file://）**：IIFE 打包 + 内嵌 WASM(base64) + 录像 Worker（Blob URL）；同一份产物也可 HTTP 服务 / 部署 |

- **双击启动**：Windows 双击 `apps/viewer/play.cmd`（或构建后 `dist/play.cmd`）；macOS/Linux
  python 缺失 → 中文提示 + 自动改用 `npx serve` 备选）。
- **纯双击（file://）**：直接双击 `dist/index.html` 即可；WASM/Worker 已内嵌，地图/录像用
  页面文件选择或拖入。
- **深链示例（HTTP）**（免点选文件，可分享）：
  `index.html?bsp=assets/maps/<地图>.bsp&replay=assets/maps/surf_null_4.replay`
  （原生 Shavit `.replay` 直入，帧自身坐标播放；`file://` 下浏览器拦截 fetch，深链仅 HTTP 可用）。
- **部署**：整包上传 `dist/` 到任意静态托管（GitHub Pages 已含 `.nojekyll`；
  Cloudflare Pages / Netlify / nginx 发布目录指向 `dist/`）。跨域引用远端 BSP/录像时资源方需返回 CORS 头。
  逐份说明见 `dist/README.md`。

## 操作（自由视角）

| 输入 | 动作 |
|---|---|
| 点击画布 | 指针锁定（鼠标视角） |
| `W` `A` `S` `D` | 水平平移（相机相对方向） |
| `空格` | 上升 |
| `Ctrl` / `C` | 下降（推荐 `C`：`Ctrl`+`W` 会被部分浏览器保留为关标签，页面拦不住） |
| `Shift` | 加速 ×4 |
| `Esc` | 解锁 |

## 侧栏两个标签页

| 标签页 | 内容 |
|---|---|
| 地图 | 顶部「更换地图」文件行；地图信息默认 文件 / 出生点数 / 世界尺寸，「统计明细」折叠收纳 magic / brushes / faces / … / 包围盒 min·max；出生点单行列表（★ = 推荐点），点「跳转」即传送 |
| 录像 | 导入 + 坐标映射 + 轨迹列表 + 调整工具（见下节） |

右上角「?」可随时打开操作帮助（键位 / 载入 / 播放基准，Esc 或 × 关闭）；
「面板」按钮折叠侧栏，时间轴会自动拉通。

## 录像导入与回放

录像页自上而下三个分区：**导入**（「选择录像文件…」）、**坐标映射**（轴序 / 朝向轴两档切换对照）、
**轨迹列表**（多轨迹对比）+ **调整工具**（默认折叠，仅用户显式设置时叠加）。
导入完成后，底部 dock 显示**录像信息条**——`.replay` 头部元信息常驻：成绩 / 玩家（`[U:1:<id>]`）/
地图（Bonus 轨道后缀 `_N`）/ 风格 / tick / 帧段（起跑前 + 正式跑 + 结束后）/ 日期 / 格式版本。

### 导入

三种方式等效：侧栏「录像」页点「选择录像文件…」（`.replay`）、把 `.replay` 拖进窗口、或 URL 深链
`?replay=`（HTTP，见「深链示例」）。导入即解析回放，**零配置**（不需要任何规则脚本）。

**换文件 = 追加一条新轨道**（多轨迹对比）；**改映射 / 改变换后的重新导入 = 更新当前那条**，
不会刷出一堆重复轨迹。

- **载入录像即默认第一人称**跟随（要自由观察再切第三人称）
- 导入只接受 Shavit 原生 `.replay`（FINAL v1–v12 + V2 旧格式）；先按魔数嗅探，非 `.replay`
  明确报错——JSON/规则脚本通道已移除（远古文本/btimes 格式同样明确拒绝）
- 解析跑在 Worker 里（不卡 UI，且缓存文件字节，改映射/变换不重读盘），定型数组零拷贝回传；
  Worker 起不来会自动回退主线程，行为一致
- 主时钟 **0 = 起跑帧**：起跑前（prerun）帧在负时间轴、不在播放区间；时间轴进度条上
  淡蓝带 = 正式跑段（按头部 `frameCount` 定位）

### 坐标映射（对不上地图时的对照开关）

`.replay` 帧已是绝对世界坐标，默认直读即可与地图对齐（标准轴序 + 实测定标朝向）。
轨迹与地图对不上时（悬空 / 侧转 90° / 落在地图外），在「坐标映射」分区切换两档对照项：

| 开关 | 默认 | 对照档 | 用途 |
|---|---|---|---|
| 坐标轴映射 | 标准（Source `[x,y,z]` → viewer `[y,z,x]`，与地图 GLB 导出同一变换） | 直读 `[x,y,z]` | 轨迹整体轴错位 / 侧转 90° 时对照 |
| 朝向轴映射 | 实测定标（`yaw = wrap(src+180)`、`pitch` 取反） | 角度直读 | 朝向反了 / 镜像时对照 |

切换即重新导入**当前轨道**（不用改任何平移）；HUD「轨迹整段落在地图包围盒外」提醒出现时，
优先修这里的映射，而不是平移锚定。

### 轨迹列表（多轨迹对比）

一次可以加载多条轨迹，同屏对比两次跑法。每条轨迹一张两行轨道卡：

| 控件 | 说明 |
|---|---|
| 色块 | 该轨迹的配色，按加载顺序自动分配 |
| 名称 + `帧数 / 时长` | 可直接改名（回车生效） |
| `◉` / `◌` | 显示 / 隐藏这条轨迹 |
| 偏移（秒） | 这条的第 0 帧对应主时钟的哪一刻。**用来对齐起跑时刻不同的跑法** |
| `◎` | 设为跟随目标——第一人称相机、速度读数与录像信息条取自这条 |
| `×` | 移除 |

- 底部时间轴是**主时钟**，统一驱动所有轨道；总长取 `max(偏移 + 各轨道时长)`
- 短的轨道播完会**停在终点**而不是消失，方便看谁先到、差多少
- 第一人称下只隐藏**被跟随**的那条幽灵（它就贴在相机上），其余照常显示——那正是要对比的东西
- 批量操作（全部显示 / 全部隐藏 / 偏移归零 / 清空全部）只在有轨道时出现

### 调整工具（仅显式微调）

映射切换之后仍差一点（残余整体偏移 / 小角度侧转）时，在这一区人工微调：

| 控件 | 说明 |
|---|---|
| 平移 X / Y / Z | 整条轨迹平移（HU），作用在解码输出之后 |
| 旋转 yaw（度） | 绕竖直轴整体旋转：pos 与 vel 同步旋转、yaw 同步加该角（正 = 逆时针） |
| `yaw +90°` / `yaw −90°` | 常见「轨迹相对地图侧转 90°」的一键修正 |
| 重置变换 | 清零平移与旋转，回到帧自身坐标 |

- **没有"起点对齐 / 一键锚定"**：`.replay` 帧坐标本身是准确的（与地图 GLB 同一世界系），
  锚定只会把正确的轨迹平移错位；工具只在你显式设置时生效（默认折叠，不再自动展开）
- 改动即重新导入**当前轨道**（0.5s 防抖）；变换持久化在 localStorage（`websurf-viewer.replay-rule.v2`）

### 播放控制（底部时间轴）

| 控件 | 说明 |
|---|---|
| 播放/暂停、停止 | `K` 键也可切换播放 |
| `◀ 帧` / `帧 ▶` | 逐帧步进，快捷键 `,` / `.`；帧读数标注 `pre` / `run k/总` / `post` 段位 |
| 进度条 | 拖动定位；淡蓝带 = 正式跑段，金框 = A-B 区间 |
| 倍速 | 0.1× ~ 16× |
| 循环 | 默认开 |
| 视角 | 第一人称（跟随被设为 `◎` 的那条轨道，相机完全由它驱动；载入录像后默认）/ 第三人称（自由观察） |
| 轨迹线 / 幽灵 | 显示开关；第一人称下只隐藏**被跟随**的那条幽灵，其余保留以便对比 |
| A-B 区间 | 「A 起点」/「B 终点」（快捷键 `I` / `O`）框定一段循环播放，「整段」清除 |
| 速度读数 | 被跟随轨道的总速 / 水平 / 垂直（HU/s，按相邻帧位置差分）；单帧录像无差分时显示「速度 —」 |

> 快捷键在输入框内自动失效——在输入框里打 `k` `,` `.` `i` `o` 不会被吞。

### JS 接口：window.viewer.replay

只读内省 + 播放控制，供外部脚本与自动化使用：

| 成员 | 说明 |
|---|---|
| `trackCount` / `duration` / `time` / `playing` / `speed` / `mode` / `followId` | 当前状态快照（duration = `max(偏移 + 各轨道时长)`，秒） |
| `sceneObjects` | 场景根对象数（轨迹线/幽灵是否真挂进去了） |
| `tracks()` | 各轨道只读信息数组：`{ id, name, frames, duration, offset, visible, color, firstPos }`（firstPos = 首帧坐标，调试对齐用） |
| `meta()` | 跟随轨道的 `.replay` 头部元信息（成绩/玩家/地图/轨道/tick/帧段/日期/格式；无轨道或 V2 无成绩等字段为 null） |
| `play()` / `pause()` | 播放 / 暂停 |
| `seek(sec)` | 定位到主时钟第几秒（会被 A-B 区间夹取） |
| `setSpeed(x)` | 倍速（0.1~16，夹取） |
| `setMode('first'\|'third')` | 第一人称 / 第三人称 |
| `follow(trackId\|null)` | 切换跟随目标；`null` = 回第一条轨道 |

```js
const r = window.viewer.replay;
r.setMode('third'); r.seek(12.5); r.setSpeed(2); r.play();
console.log(r.tracks(), r.meta());  // [{ id: 'track-1', … }], { time: 16.2, map: 'surf_null', … }
```

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 页面显示「viewer 初始化失败」，提示缺 `app.js` / wasm | 未构建就打开了页面：在 `viewer/` 目录依次运行 `npm install` → `npm run build:wasm` → `npm run build:ts` 后刷新 |
| 状态行报 `fetch wasm → 404` 或「缺少 WASM 产物」 | 缺 WASM 产物：先运行 `npm run build:wasm`（生成 `pkg/` 并拷贝 wasm 到 `web/`）再刷新 |
| 「无法创建 WebGL 渲染上下文」 | 浏览器不支持/禁用了 WebGL、硬件加速关闭或显卡驱动过旧——换最新版 Chrome / Edge / Firefox 并开启硬件加速 |
| `npm run dev` 报端口占用 | 8080 被其他进程占用：结束占用进程，或换端口启动 `python ../../src/serve.py 8090 .` 后访问对应端口 |
| 按 `Ctrl` 下降时误触浏览器关闭标签页（Ctrl+W） | 浏览器级快捷键页面无法拦截：下降改用 `C` 键，或在 Firefox 中使用（按键拦截更宽松） |
| 状态行闪现「鼠标锁定失败，请再点击一次画布重试」 | 指针锁定偶发失败（如 Esc 后立即点击）：按提示再点一次画布即可 |
| 引导层报「这不是有效的（或暂不支持的）BSP 地图文件」 | 文件损坏或为暂不支持的 BSP 版本；确认选择的是 `.bsp`（拖入 `.bsp`/`.replay` 以外的文件也会被拒绝并提示） |
| 导入报「不是 Shavit .replay 录像文件——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）」 | 选错文件（JSON / 其他格式）：Shavit 服务器的 `*.replay` 才是合法输入；远古文本/btimes 格式也不支持（明确报错） |
| 导入报「Shavit .replay 格式版本 N 高于 viewer 支持的最高版本 12」 | 新版 shavit 落盘格式（>0x0C）：更新 viewer 后再试 |
| 导入成功但轨迹悬空 / 侧转 90° / 落在地图外 | 坐标系映射不对：录像页「坐标映射」切换对照（轴序 / 朝向轴）；确认坐标无误后仍有残余，才用「调整工具」显式平移 / 旋转（没有自动锚定） |
| 播放起点不在出生点 | 属正常：帧坐标即真实路径（含起跑前 prerun 段）；主时钟 0 = 起跑帧，不需要对齐出生点 |
| 导入报「文件被截断」「前 64 字节内没有换行符」等解析错误 | 文件损坏 / 下载不完整：换一份完整的 `.replay`；尾部多出的字节会以 warning 忽略 |
| 录像里有速度但时间轴显示「速度 —」 | 单帧录像无法差分出速度：正常（速度按相邻帧位置差分计算） |
| 播放时画面不动 / 时间轴不推进 | 检查是否暂停（`K` 切换）、A-B 区间是否被框成了极短的一段、倍速是否 0.1× |
| 改一次映射/变换就多出一条轨迹 | 不该发生——改映射/变换是**替换**当前轨道。若出现，说明这份文件被当成新文件重新载入了（换文件才追加） |
| 两条轨迹对不齐 | 用轨迹列表里的「偏移」把后起步的那条往后挪；偏移单位是秒 |
| 长时间录像导入后进度条不动 | `.replay` 是定长二进制（44 B/帧），53 KB→1211 帧毫秒级、12 小时 ≈ 12 MB 也就数秒；进度按解析阶段上报，属正常 |

## 规模参考

| 场景 | 帧数（67 tick/s） | `.replay` 文件（44 B/帧） | 定型数组内存 |
|---|---|---|---|
| 40 分钟 | 160,800 | ~6.8 MB | ~7.7 MB |
| 12 小时 | 289,440 | ~12.2 MB | ~13.9 MB |

这个量级**不需要分块流式**：解析跑在 Worker 里不卡 UI（单帧毫秒级，10 MB 级也就数秒），
轨迹线自动抽稀到 4 万点，进度按解析阶段回传。

## 位姿与坐标约定（回放侧）

- 标准帧 `pos` = **人物脚底位置**（viewer 世界坐标 **Y-up**）；相机眼位 = `pos + 眼高 64.09`
- 标准帧 `ang` = `[yawDeg, pitchDeg, rollDeg]`：yaw 0 = 面朝 −Z，正方向逆时针（俯视），
  归一 [0,360)；pitch 正 = 仰视，±89° 限幅
- `.replay` 换算定标（以可执行断言固化，`test/replay-selftest.ts`）：`pos: [x,y,z] → [y,z,x]`（与地图
  GLB 导出同一变换）、`yaw = wrap(srcYaw + 180)`（run 段「视角·运动方向」平均 cos = 0.9992 实测定标）、
  `pitch = −srcPitch`、`vel` = 位置差分；帧内 packed vel（wishmove）不映射
- `t`：秒，单调递增；**主时钟 0 = 起跑帧**（prerun 为负、不在播放区间）
- 初始视角 = 推荐出生点（`info_player_start` 优先）；出生点跳转沿用同一约定
  （出生点实体角走 `pose.ts` 的 270− 换算，仅 BSP 出生点路径使用，与 `.replay` 无关）
- **第一人称回放期间相机完全由录像驱动**；切回第三人称或清空录像即恢复自由飞行

## 与 debug/game/test 的差异（运行时最小集）

| 项 | viewer | 参考工程 |
|---|---|---|
| WASM 依赖 | **仅 websurf-wasm-core**（无物理） | debug/game/test 均含 websurf-phys |
| 导出集 | metadata / spawn / GLB | + brush/模型碰撞/teleport/PVS/mosaic/默认纹理包 |
| 渲染 | GLB + 空间分块合并 + 近平面自适应/相机 near-far 自适应（与 game 同法，无雾） | + PVS/LOD/lightmap/画质切换/碰撞可视化 |
| 物理 | 无（纯飞行相机） | 主线程物理 + 权威 Worker |
| 面板/功能 | 地图信息 / 出生点跳转 / 录像回放（原生 `.replay` 直入 + 信息条 + 时间轴） | 计时挑战/存点/参数面板等 |
