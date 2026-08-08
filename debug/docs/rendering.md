# debug 渲染 / 调试 / 游戏化模块

## 1. 场景构建（`renderer-main.ts` loadScene）

```
scene-data（GLB 字节 transfer + 各 JSON）
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

## 2. 渲染循环

- 每帧：`readFrame`（锁占用→复用缓存）→ 双快照 LERP → 相机同步（含近平面自适应，每 2 帧探测）→ LOD/PVS 剔除 → 渲染。
- 无人为帧率上限；`needsRender` 脏标记（配置/场景变更触发）。
- 外推插帧（dead-reckoning）：`alpha > 1` 时按快照速度一阶外推（限 1/64s，防跑飞）；速度门限 500（低速不外推）。

## 3. 渲染特性

| 特性 | 说明 |
|---|---|
| PVS 剔除 | `PvsManager`（cluster 位图）+ `LodManager`（**2 级 LOD**：近/远 + PVS 隐藏，距离剔除） |
| Lightmap | 图集化 + RGBExp32 解码（`lightmap-shader.ts` 注入 onBeforeCompile） |
| 雾 | `FogManager`（场景半径/中心自适应） |
| 近平面自适应 | 6 方向探测（4 水平正交 + 上下 2，距离 100）× 收缩系数 0.3，面板实时可调 |
| 准星 | CSS 变量驱动 4 线 + 中心点（颜色/线长/粗细/间隙/描边），localStorage 持久化 |

## 4. 调试可视化

| 开关 | 内容 |
|---|---|
| showSolids | 附近 512 HU 实体 brush 凸包线框（地面绿/斜坡黄/墙红） |
| showTriggers | 传送触发器线框（青=已链接/紫=孤儿/灰=禁用/橙=非玩家） |
| showPlaneInfo | 准星射线检测（mesh Raycaster / brush Ray-Convex / trigger Ray-AABB，HUD 显示名称与属性） |
| 模型碰撞来源 | visual=紫 / phy=橙线框（colliderDebug） |

实现：`collider-debug.ts`、`plane-inspector.ts`（数据来自 scene-data 的 brushJson/triJson/teleportJson——主线程自建只读可视化副本，与物理解耦）。

## 5. 游戏化（计时挑战，`src/game/game-state.ts`）

- 状态机：`idle →(移动)→ running →(终点)→ finished`；死亡回退检查点。
- 检查点：传送事件（`take_event` teleport）记录（位置/名称/时间），**同名检查点去重**（只记首个；finished 后不再记录）；终点 = targetname 以 `end` 结尾（`level_end` 等）。
- 死亡：Rust 物理内部判定（Y < 阈值）→ `take_event` death 事件 → `onDeath` + `getRespawnPos` 回退；阈值 = 主线程回传场景 `boundingBox.min.y`，Worker 侧 `set_death_y(minY - 1000)`。
- HUD：计时/检查点数/死亡次数（10Hz game-stats）。

## 6. 自定义传送点

- 「保存当前位置」（`get-player-pos` 消息）→ localStorage 持久化（按地图名）；坐标传送（`teleport-to-pos`）、清空。

## 7. 内存管理

- 地图重载：`disposeScene()` 递归释放旧 BSP 模型 GPU 资源（geometry/material/纹理 + renderLists/LOD/PVS/碰撞可视化/插值缓存）。
- 画质切换：`map.dispose()`（见 materials 文档）。
