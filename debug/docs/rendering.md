# debug 渲染 / 调试 / 游戏化模块

> 最后核对：2026-08-11。以实际代码为准（`debug/src/renderer/`、`debug/src/game/`）。

## 1. 场景构建（`renderer-main.ts` loadScene）

```
scene-data（GLB 字节 + 各 JSON，同线程本地传递，无 postMessage/transfer）
  → GLTFLoader 加载 GLB（Blob URL）
  → resetRootRotations（根节点 Y 旋转归一）
  → collectMetadata（材质/贴图名索引，平面信息用）
  → loadLightmapAtlas + applyLightmapToMeshes（RGBExp32 解码着色器 + lightMap 注入）
  → 相机 near/far（near 自适应：maxDim/1000）
  → LodManager.setup + PvsManager + assignClusterIds
  → TeleportManager（可视化 + 准星检测用）
  → colliderDebug.setTriMeshes（模型三角形碰撞线框）
  → mosaicManifest 保存 + 按当前画质应用
```

## 2. 渲染循环（主线程唯一物理渲染线）

- 每 rAF：输入层 → `shared.addInput`（权威同源）→ 权威校准（correctFromAuthority + calibrateVelocity）→ `predPhys.tick(dt, keys, dx, dy)` → `take_event` 消费（计时挑战）→ **`state()` 直读渲染**（相机 = pos + eyeHeight，度→弧度）→ 近平面自适应（相机同步内，每 2 帧探测）→ LOD/PVS 剔除 → 渲染。
- 无人为帧率上限；`needsRender` 脏标记（配置/场景变更触发）。
- **无插值**：渲染帧 = 主线程物理本帧输出（物理与渲染同频，权威帧仅做速度校准与异常兜底）。

## 3. 渲染特性

| 特性 | 说明 |
|---|---|
| PVS 剔除 | `PvsManager`（cluster 位图）+ `LodManager`（**2 级 LOD**：近/远 + PVS 隐藏，距离剔除） |
| Lightmap | 图集化 + RGBExp32 解码（`lightmap-shader.ts` 注入 onBeforeCompile） |
| 雾 | `FogManager`（场景半径/中心自适应） |
| 近平面自适应 | 4 方向探测（4 水平正交，距离 100）× 收缩系数 0.3，面板实时可调 |
| 准星 | CSS 变量驱动 4 线 + 中心点（颜色/线长/粗细/间隙/描边），localStorage 持久化 |

## 4. 调试可视化

四个开关相互独立（config.debug 段，localStorage 持久化），各配独立可视距离滑块（0 = 全量）：

| 开关 | 颜色 | 内容 | 距离字段（默认） |
|---|---|---|---|
| 显示brush碰撞 | 地面绿/斜坡黄/墙红 | 实体 brush 凸包线框（凸包退化回退 AABB） | `brushViewDistance`（512） |
| 显示触发区域 | 青=已链接/紫=孤儿/灰=禁用/橙=非玩家 | 传送触发器线框（凸包或 AABB） | `triggerViewDistance`（0=全量） |
| 显示模型phy碰撞 | 橙 | 模型自带 .phy 凸包三角形线框（无上限截断） | `phyViewDistance`（4096） |
| 显示模型可视碰撞 | 紫 | 模型可视网格三角形线框（贴合显示网格，12k 上限） | `visViewDistance`（1024） |

- 判定来源：`mesh.surfaceprop !== undefined` = .phy（橙），否则可视网格（紫）。
- 渲染：线框材质**不透明 + depthTest:false**（opaque 恒在透明 brush 线框之后渲染，不被绿色混合染色/遮挡；三.js 透明材质按深度排序，透明混合会把橙色染绿）。
- 距离筛选按 mesh/brush AABB 的 XZ 距离（玩家相机为圆心）；phy 距离变更立即重建（phyDirty），常规 30 帧限流。
- showPlaneInfo：准星射线检测（mesh Raycaster / brush Ray-Convex / trigger Ray-AABB，HUD 显示名称与属性）。

实现：`collider-debug.ts`（phy/vis 独立 Group）、`plane-inspector.ts`（数据来自 scene-data 的 brushJson/triJson/teleportJson——主线程自建只读可视化副本，与物理解耦）。

## 5. 游戏化（计时挑战，`src/game/game-state.ts`）

- 状态机：`idle →(移动)→ running →(终点)→ finished`；死亡回退检查点。
- 检查点：传送事件（`take_event` teleport，主线程每 tick 消费）记录（位置/名称/时间），**同名检查点去重**（只记首个；finished 后不再记录）；终点 = targetname 以 `end` 结尾（`level_end` 等）。
- 死亡：Rust 物理内部判定（Y < 阈值）→ `take_event` death 事件 → `onDeath` + `getRespawnPos` 回退（双端 teleport-to-pos + resetTo）；阈值 = 主线程回传场景 `boundingBox.min.y`（双端同值 `set_death_y`）。
- HUD：计时/检查点数/死亡次数（主线程 10Hz 本地采样）。

## 6. 自定义传送点

- 「保存当前位置」（主线程本地 `rendererMain.getCurrentState()`）→ localStorage 持久化（按地图名）；坐标传送（`teleport-to-pos`）、清空。

## 7. 内存管理

- 地图重载：`disposeScene()` 递归释放旧 BSP 模型 GPU 资源（geometry/material/纹理 + renderLists/LOD/PVS/碰撞可视化）。
- 画质切换：`map.dispose()`（见 materials 文档）。
