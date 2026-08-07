# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [0.2.0] - 未发布

### 新增

- 共享内存**输入环形缓冲**（SPSC 无锁，64 槽 SOA，每样本带 `performance.now()` 时间戳）替换单槽累加器：
  批量消费聚合（增量求和保留 + 最新按键 + 首末时间戳）、满则覆盖最旧（自动降采样）、
  积压 ≥ 8 时 `Atomics.notify` 唤醒（为 Worker 自驱循环铺路）
- HUD 帧率显示拆分：**真实渲染帧率**（主线程 rAF 统计）与 Worker 处理频率
  （墙钟统计——修复物理 dt 含 Worker 抖动导致显示值虚低的问题）
- **渲染端外推插帧**（dead-reckoning）：物理 64Hz 固定步但快照随渲染频率写入，
  存在"空快照"（位置不变、时间前进）窗口 + Worker 写帧延迟抖动 → 旧 LERP 的
  `alpha` 被 clamp 到 1 时画面"停等"物理，高速滑行呈"停-动-停"微卡顿。
  修复：`alpha > 1` 时用快照**真实速度一阶外推**位置（上限 `EXTRAPOLATE_MAX_S`
  = 1/64s，防外推跑飞穿墙），中间渲染帧保持连续运动；yaw/pitch 保持 cur；
  **速度门限** `EXTRAPOLATE_MIN_SPEED = 500`：横向(xz)与竖向(y)速度**均** < 500
  时不外推（起步拉地速阶段运动不可预测，退回停等最新快照）。
  **低速门限**：横向(xz)或纵向(y)速度任一 < 500 u/s 时物理帧间位置变化小且
  运动不可预测（站立/起步/贴墙/垂直下落），外推只会引入微漂移——**禁用外推**
  等待物理快照；仅横向与纵向都 ≥ 500（高速对角运动）时启用外推平滑
- **面板可用性**：所有数值控件（灵敏度/QE 转速/视距/落地帧数/碰撞倍率/物理参数）
  增加**数字输入框**（step=any 精确输入，滑块步进统一为 1）；**物理模式/碰撞来源/
  PVS 剔除/视距**改为**进入地图前即可设置**（碰撞来源修改后提示"重新加载地图生效"，
  不再需要先进地图再改再重进）

### 变更

- `frame` 信号改为纯触发（去除主线程时间戳），物理 dt 由 Worker 侧 `performance.now()`
  计算（与主线程同源时钟，LERP 插值基准不变）
- 共享内存布局重设计：输入区由单槽 `inDx/inDy` 累加器改为 `inHead/inTail` 环形缓冲
  （`SHARED_BUFFER_SIZE` 144B → 1904B）
- 重建 WASM：pkg 补全模型三角形碰撞导出 API（`export_model_tri_colliders` /
  `export_model_phy_colliders`），`colliderSource`（auto/visual/phy）路径真正生效
  （此前 pkg 过期，模型碰撞体始终回退薄壳 brush）

### 修复

- **地图重载内存泄漏**：`loadScene` 移除旧 BSP 模型只 `remove()` 不 `dispose()`，
  GPU 侧 geometry/material/纹理（含 lightmap atlas）累积导致帧率下降。新增
  `RendererMain.disposeScene()`（递归释放 + renderLists/LOD/PVS/碰撞可视化/插值
  缓存清空），`handleBspFile` 触发文件输入即重置内存，`loadScene` 开头防御调用；
  `ColliderDebug` 新增 `clearAll()`（保留 scene/group 引用），`dispose()` 补 triGroup
- **贴墙透视（近平面裁剪）**：近平面自适应探测距离 `NEAR_PROBE_DIST` 4 → 32——
  相机距墙最小距离 = 碰撞箱半宽 16，原射线 far=4 永远探测不到面前的墙，贴墙时
  near 保持默认大值（大地图 50+）→ 墙被近平面裁剪，透视看到地图外面。已与上游
  cs-movement 逐项核对（碰撞箱 16/72/54、眼睛 64.09/46.04、DIST_EPSILON、brush
  碰撞逻辑全一致），物理层无差异，纯渲染层 bug
  - **垂直墙增强**：探测方向 6 → 10（水平 8 方向：正交 + 4 对角，任意贴墙角度
    与墙夹角 ≥ 22.5°）、探测距离 32 → **72**、收缩系数默认 **0.3**（near =
    最近距离 × 0.3，更保守不易裁墙）
  - **面板可调（实时生效）**：显示设置新增「近平面探测距离」「近平面收缩系数」
    滑块 + 输入框，`RendererMain.setNearParams()` 下一帧生效，无需重载地图

- **出生点下拉无反应**（select 重选当前值/部分浏览器只触发 input 不触发 change）：
  input + change 双监听 + 去重（换地图重置去重索引）；解析失败 status 可见提示

- **game/ 双端同步**（websurf-min 预测 + 权威双线架构）：
  - 近平面自适应全套同步（10 方向探测 + 面板实时可调 + 默认 72/0.3）
  - spawnSelect/respawnBtn 改走 `bridge.sendTeleport/sendRespawn` 双端同步
    （此前直接调 renderer 绕过 Worker 权威物理 → 传送被权威帧 >200 兜底拉回）
  - **`set-spawn-points` 消息**：出生点列表同步到 Worker 权威物理（此前只设
    预测物理，权威侧 `teleport_to_spawn` 索引为空静默忽略 → "一瞬间传送过去
    又被拉回"根因）

- **斜坡接缝卡零速**（surf 高速滑行在垂直转横线折角带/密集接缝处速度归零）：
  - `TryPlayerMove` 振荡检测宽容化：剪裁后速度反向不再整体归零，保留沿最后撞击
    平面的切向速度（Quake 风格沿墙滑动）；多平面（≥2）沿前两平面交线滑动
  - 多平面围角（≥3 平面）优先用平均法线剪裁（等效接缝平滑），失败才回退归零
  - `MAX_CLIP_PLANES` 5 → 8（密集接缝区一 tick 触及多平面的容忍度）
  - **撞击后沿法线推开 `PUSH_OUT=0.1`**（贴面解死锁）：surf 滑行时 AABB 表面停在
    距坡面 DIST_EPSILON 处，重力每 tick 注入垂直分量 → trace fraction≈0 微撞击 →
    origin 不更新（移动量≈0）→ `blocked×3` 误判归零；推开使下一 tick 有正常
    "进入距离"，切向滑行不再被 fraction≈0 吞掉（Source/Quake 的 hitpos 惯例）
  - `BlockedMove` 冻结检测阈值 3 → 6（给推开收敛时间，减少误判）
  - **夹缝特殊逻辑**：检测到相对平面（V 形槽/墙缝，法线 dot < -0.5）时不再推开
    （推开会来回撞墙、前后都卡死），改为沿两平面交线滑出夹缝
  - **速度骤降校验**：未归零但大幅减速（空中 + 撞击接触 + 降幅 >30%）记录
    `slowdown-XX% c[法线@fraction...]` 诊断——HUD 显示减速来源（多平面剪裁/
    夹缝转向），便于针对性修复
  - **归零诊断**：所有归零路径记录原因（allSolid/planes≥8/cornered×N/blocked×6/
    stuck×N），经 stats 回传，HUD 显示"卡因[xxx]"

## [0.1.0] - 2026-08-05

### 新增

- 初始版本：BSP 解析、CS 移动物理、Three.js 渲染
