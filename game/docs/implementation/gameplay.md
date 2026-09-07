# game 实现：游戏化子系统（存点 / 出生点 / 渲染体验）（I）

> 核对基准：当前 `game/src/savepoint.ts`、`game/src/app.ts`、`game/src/renderer/renderer-main.ts`、`game/src/world/*`。总览见 [../overview.md](../overview.md)，输入/面板见 [panel-and-input.md](panel-and-input.md)。

## 1. 存点系统（X 存点 / C 按住冻结）

### 1.1 存储（`game/src/savepoint.ts`）

- `SavePoint = {x,y,z,yaw,pitch,vx,vy,vz,onGround,t}`——完整物理快照（含速度与着地态）。
- `SavePointStore`：按地图 localStorage 键 `websurf-game.savepoints.{mapName}`（`:7`）；`SAVEPOINT_MAX = 50`（`:27`），`add` 超限移除最旧（`:68`）；`load(mapName)` 换图切换列表（`:38`，`app.ts:393-395` 调用）；`latest()` 供 C 键读最近存点（`:93`）；`delete(i)` 直接删除无确认（`:78`）。

### 1.2 X 键存点（`game/src/app.ts:205-213,482-489`）

仅锁定时响应：`renderer.getFullState()`（读主线程物理实例完整状态，`renderer-main.ts:551-573`）→ `savePointStore.add({...s, t})` → 面板列表刷新。

### 1.3 C 键按住 = 定在最近存点（`game/src/app.ts:210-220,491-510`）

- 按下：`startHoldPoint()` → 取 `latest()` → `renderer.setHoldPoint(sp)`（`renderer-main.ts:601-608`）→ 渲染线 tick 每帧强制 `set_state(存点位置/朝向, 速度=0, 存点着地态)`（`renderer-main.ts:713-718`）——"按住定在点的那一刻不要给速度"，空中存点悬空、地面存点站定。
- 松开：`endHoldPoint()` → `renderer.releaseHoldPoint(sp)`（`renderer-main.ts:610-633`）——全量恢复存点状态（含存点速度）+ 反向同步权威（防权威旧位置把玩家拉回）。

### 1.4 面板读取任意存点

`loadSavepoint(sp)`（`renderer-main.ts:575-597`）：`clearPendingInput` + `set_state` 全量恢复 + 权威同步；列表行按钮触发（`app.ts:162-170`）。

## 2. 出生点选择（spawn 下拉）

- 地图加载后 `spawnSelect` 填充 `{i}: classname (origin)`（`app.ts:457-468`）。
- 选择 → `bridge.sendTeleport(idx)` **双端**传送（`app.ts:276-290`）：主线程 `renderer.teleportToSpawn`（`renderer-main.ts:525-528`，内部 `teleport_to_spawn` + 反向同步豁免）+ Worker `teleport` 消息（`worker-dispatch.ts:191-197` → `teleport_to_spawn`）。
- 去重：`lastTeleportIdx` 防同值重选重复触发（`app.ts:279-290`）。
- ⚠️ 不能只调 `renderer.teleportToSpawn`：权威侧缺 set-spawn-points/teleport 同步时，权威帧 >500 兜底会把玩家拉回旧位（`app.ts:276-278` 注释记录"传送初始点出现问题"根因；对照 [../sequences.md](../sequences.md) §5 豁免机制）。

## 3. 渲染体验子系统

### 3.1 分块合并 optimizeScene（`renderer-main.ts:824-1005`）

- 动机：GLB 挂载后 3.4 万 mesh（每帧遍历/剔除开销）→ 空间分块合并为 ~300-800 块（`:808-816` 头注；实测数字移植自 test/dual-mode-harness worker-b optimizeScene）。
- 流程：① 收集 Mesh（多材质/无材质防御性烘焙保留）② cell 自适应 = 世界对角线/cbrt(目标块数)，微调收敛到 `[OPT_MIN_CELLS=300, OPT_MAX_CELLS=800]`，cell 尺寸钳制 `[OPT_CELL_MIN=128, OPT_CELL_MAX=4096]`（`:36-42,862-871`；`OPT_TARGET_CELLS=512`）③ 按 Mesh 包围盒中心分桶 ④ 块内按材质子合并 → `mergeGeometries(useGroups=true)` 终合并（材质索引 groups 保留，`:893-971`）；单 mesh cell 保留原 mesh（世界空间烘焙 + 变换清零）。
- 替换：块 mesh 直接挂 BSP 根（`bspRoot.userData.isBspModel` 保留），移除原 gltf 子树（`:974-980`）。
- 包围球重算 + `FRUSTUM_PAD=1.6` 膨胀（视锥外保一圈防快速移动边缘闪现，`:49,982-992`；克隆残留 GLB 局部空间旧球必须强制 `computeBoundingSphere`）。

### 3.2 LOD 距离剔除 + PVS 现状（`renderer-main.ts:738-764`）

- LOD：`cullDistance = max(maxDim×0.5, 1000)`（`:276`）；超距 mesh `visible=false`（LOD_FAR）。
- PVS：`PvsManager` 完整实现（`game/src/world/pvs-manager.ts` 281 行：findLeaf/decodePvsRow/isVisible）但 **`ENABLE_PVS = false` 整体禁用**（`renderer-main.ts:82`）。禁用理由就在代码注释里（`:75-81`）：实证 surf_666 PVS 数据不可用——8269 cluster 平均可见率仅 1.6%（中位 1.3%、最大 5.1%）、spawn 点 cluster=-1（开放 surf 图 BSP leaf/PVS 划分失效，可见集几乎为空 → 相邻区域被错误全剔 + 晃动穿越 cluster 边界边缘消失）；分块合并后渲染量已由 FRUSTUM_PAD 视锥剔除 + 距离 LOD 控制，PVS 为负收益，数据修复后可置 true 恢复。
- 安全保护仍保留：相机不在任何 cluster 时跳过 PVS 只按距离（`:744-745`）。

### 3.3 近平面贴墙自适应（`renderer-main.ts:127-147,387-454`）

- 问题：固定 near = maxDim/1000（大地图 50+）贴墙时墙被近平面裁剪、透视看穿地图。
- 方案：每 2 帧沿相机局部 4 个水平正交方向（前/后/左/右）`Raycaster` 探测 `nearProbeDist`（默认 100 HU）内最近 mesh，`camera.near = max(最近距离×nearRatio(0.3), 0.05)`；空旷恢复 `defaultNear`。面板可实时调两参数（`setNearParams`，`app.ts:293-323` 绑定滑条/输入框双向同步）。

### 3.4 纹理画质切换（mosaic 低清档）

- 地图加载时 `bundle.mosaicManifest` 存入 `this.mosaicManifest`（`renderer-main.ts:282-286`）。
- `applyTextureQuality('mini')`：遍历场景全部材质贴图，按 `(map.name).toLowerCase()` 查 manifest → `mosaic_decode(code, 8)` → PNG → ImageBitmap 替换 `map.image`；**替换前必须 `map.dispose()`**——three r152+ 对同 texture 换 image 走增量上传，尺寸不符会 GL_INVALID_VALUE（`:289-343` 注释）。
- `'original'`：恢复 `origTextureImages` 缓存原图（`:311-320`）。切换即时生效、无需重载地图。
- 共享 mosaic/MTZ 技术详见 [`../../../docs/wasm-core.md`](../../../docs/wasm-core.md) §3.7（根解析层文档，系统承载 mosaic 字节码与 MTZ 容器；differences.md §4 同一指法）。

### 3.5 固定三点光（`renderer-main.ts:197-204`）

Ambient 0.6 + Hemisphere(0xb0c4de/0x404030) 0.4 + Directional(0xfff4e0) 0.5——替代 debug 的 LightManager/环境光烘焙，最小化取舍。

## 4. 死亡阈值与重生

- 渲染线：`onSceneLoaded(bbox.min.y)`（`renderer-main.ts:279-286`）→ `renderer.setDeathY(deathY)`（`app.ts:129`）→ 主线程 `predPhys.set_death_y`。低于阈值 → `check_death` 返回初始出生点 → `player.respawn`（`src/phys/teleport.rs:356-362`、`src/phys/mod.rs:260-264`）。
- ⚠️ **权威侧未同步**：`bridge.sendSetDeathThreshold` 在 game 无调用点（grep 证实），Worker 权威 `death_y` 恒 Rust 默认 −100000（`src/phys/mod.rs:92`）。掉图死亡只发生在渲染线；权威位置若已掉出地图，由 `correctFromAuthority` 大偏差兜底（>500 强制反向同步）把权威拉回——自愈但依赖兜底路径（见 [../sequences.md](../sequences.md) §5）。
- 手动重生：R/按钮 → `bridge.sendRespawn` 双端 `respawn()`（`input-bridge.ts:57-61`）。
- `renderer-main.ts:279` 注释写"场景最低 Y - 1000"，实际代码传 `bbox.min.y` 原值（`:280`）——注释与代码不符，以代码为准。

## 5. PVS 数据与世界类型（`game/src/world/`）

- `types.ts`（34 行）：仅保留主线程渲染需要的 `WasmPvsNode/WasmPvsLeaf/WasmPvsData/Vec3`——对照 `debug/src/world/types.ts` 231 行的最小化裁剪（差异见 [../differences.md](../differences.md)）。
- `pvs-manager.ts`：`getClusterAt`（叶子点定位）→ `decodePvsRow`（RLE 位行解码，与 Rust `vbsp::decode_pvs_row` 权威实现一致，`game/crates/wasm/src/lib.rs:1643-1644` 注释）→ `isVisible(cluster)`。因 `ENABLE_PVS=false`，运行时不生效，但数据链路（pvsJson）仍随地图加载。

## 6. 无计时挑战（与 debug 的关键差异）

grep `game/src` 全量检索 `game-state|计时|challenge|checkpoint|timer`：仅命中 `config.lockTickRate` 的注释（"计时玩法公平性"预留开关，`game/src/config.ts:81-93`）与面板注释（`panel-controller.ts:222`）——**game 当前没有计时挑战/检查点系统**；`worker-dispatch.ts:151-155` respawn 注释明示"计时挑战检查点回退已移主线程"是 debug 侧设计。debug 的 `game-state.ts` 计时系统未移植到 game（对照证据见 [../differences.md](../differences.md) §2）。
