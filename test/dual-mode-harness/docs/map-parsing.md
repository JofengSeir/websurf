# 地图解析（BSP）

> 地图解析由主线程 `main.ts` 调用 WASM 薄导出层 `crates/wasm/src/lib.rs` 完成。
> 解析核心复用仓库根 `src/wasm-core/`（`websurf-wasm-core`）中的 `vbsp` 模块。
> 本工程不加载真实地图编辑器，BSP 是唯一玩法。
>
> **当前运行时最小集**：只导出 brush 碰撞结构、模型碰撞结构（.phy 优先/可视网格回退）、
> 出生点、GLB（基本几何 + 材质纹理 + 模型）。**teleport/PVS 已从主线程导出流程排除**，
> 不作为核心移动逻辑之外的运行时影响源。

## 1. 支持的版本

- 文件头：`VBSP`（4 字节魔术字 `V B S P`）。
- 版本范围：**19 ..= 29**（Source 1 家族）。
  - CSS / HL2：v19-v20；
  - CS:GO：v20-v21；
  - L4D2 / Portal2 等：v21+。
- 已知兼容性说明：
  - v20 与 v21 的 lump version 分布实测一致（NODES v0 / LEAFS v1 / FACES v1 / 其余 v0），记录大小相同（32/32/56B），共用同一布局；
  - **v19 早期 CSS 图的 FACES 可能是 v0（28B），当前解析器未实现按 lump version 分派**，这类图可能解析失败；
  - leaves 记录大小做了自适应：不只看 lump version，而是以 BSP 树实际引用的最大 leaf 索引判断按 56B 还是 32B 读取。
- 其他限制：
  - 未实现 Source 2（v30+ / `2013` 等）地图；
  - 只读 `PAKFILE` 内嵌资源，不读取外部文件系统。

## 2. 解析出的数据（Bsp 对象）

`vbsp::Bsp::read()` 会读取以下 lump 并构建完整 `Bsp` 结构：

| 数据 | 说明 |
|---|---|
| `header` | 文件头 / 版本 |
| `entities` | 实体表（keyvalue 解析） |
| `textures_data` / `textures_info` / `texture_string_tables` / `texture_string_data` | 纹理数据与字符串表 |
| `planes` | 分割/brush 平面 |
| `nodes` / `leaves` | BSP 树节点与叶子（含 cluster） |
| `leaf_faces` / `leaf_brushes` | leaf → face/brush 索引 |
| `models` | 子模型（worldspawn + 实体 brush 模型 + static prop 模型引用） |
| `brushes` / `brush_sides` | brush 与 brush side |
| `vertices` / `edges` / `surface_edges` | 网格拓扑 |
| `faces` / `original_faces` | 面（渲染面） |
| `vis_data` | PVS/PAS 可见性位图（RLE 压缩） |
| `displacements` / `displacement_vertices` / `displacement_triangles` | displacement 地表 |
| `vertex_normals` / `vertex_normal_indices` | 顶点法线 |
| `static_props` | static prop game lump |
| `pack` | PAKFILE（zip，内嵌模型/材质/VMT/VTF/PHY 等） |

## 3. 导出集合（BspProcessor 方法）

`BspProcessor` 是 WASM 对外的“最小游玩导出集”：

| 方法 | 输出 | 消费方 |
|---|---|---|
| `metadata()` | 元数据 JSON（magic/各 lump 计数/packed_files） | 主线程 HUD 状态 |
| `export_brushes_planes(filterJson)` | brush 凸包碰撞体 JSON（planes/min/max/is_ladder/is_solid） | WorkerA `build_world` |
| `export_model_phy_colliders()` | PAKFILE 模型 `.phy` 物理碰撞体 JSON | WorkerA `build_world` |
| `export_model_tri_colliders()` | PAKFILE 模型可视网格碰撞 JSON（.phy 缺失时回退） | WorkerA `build_world` |
| `parse_teleports()` | 传送目标 / trigger / 链接 JSON | **运行时最小集不调用**；保留在 WASM API |
| `parse_spawn_points()` | 出生点 JSON（含 primary） | 主线程选出生点 → WorkerA |
| `parse_pvs_data()` | BSP 树 + PVS 位图 JSON | **运行时最小集不调用**；保留在 WASM API |
| `export_glb_with_pakfile_models()` | GLB 二进制（含 PAKFILE 模型） | WorkerB GLTFLoader |

> 注意：`export_glb_with_pakfile_models()` 会**消费内部 `Bsp` 实例**（`self.bsp.take()`），
> 必须在其他借用方法（brush / 模型碰撞 / spawn）之后调用。
> `main.ts` 的调用顺序与此一致。

## 4. 解析流程（主线程视角）

```
用户选择 .bsp 文件
   │
   ▼
main.loadBsp(file)
   │ 1. ensureMainWasm()：fetch ./websurf_test_wasm_bg.wasm → initSync
   │ 2. new BspProcessor(new Uint8Array(file.arrayBuffer()))
   │    └─ vbsp::Bsp::read(bytes)：解析全部 lump + 校验
   │
   ├─ 3. proc.metadata()                       → HUD 元数据
   ├─ 4. proc.export_brushes_planes(filter)    → brushJson（碰撞世界）
   ├─ 5. proc.export_model_phy_colliders()
   │      └─ 若返回 [] → proc.export_model_tri_colliders()  → triJson
   ├─ 6. proc.parse_spawn_points()             → spawnJson
   │      └─ 主线程取 primary 出生点，yaw 转 cs-movement
   │      （teleport/PVS 明确排除：不调用 parse_teleports / parse_pvs_data）
   ├─ 7. 发 workerA.postMessage({type:'world-json', brushJson, triJson, spawn})
   ├─ 8. proc.export_glb_with_pakfile_models() → glbBuffer
   │      └─ 发 workerB.postMessage({type:'glb', bytes}, [glbBuffer])
   │
   └─ WorkerA applyWorld：
        set_hull(16,72,54)
        build_world(brushJson, triJson, 空 teleport report, spawn)
        死亡阈值 = brushJson 最小 min[1] - 100
        writeStateFromPhys()  // 首帧状态
```

## 5. 关键导出细节

### 5.1 brush 碰撞体（`export_brushes_planes`）

- 过滤参数（`BRUSH_FILTER_JSON`）：
  ```json
  { "include_ladder": true, "include_solid": true, "min_brush_volume": 0,
    "skip_sky": true, "skip_nodraw": false }
  ```
- 只导出玩家实体可碰撞的 brush：
  - `MASK_PLAYERSOLID` = `SOLID | WINDOW | GRATE | PLAYERCLIP | MOVEABLE`；
  - `LADDER` 单独标记；
  - `trigger_*` / `func_illusionary` / `func_occluder` / `func_dustmotes` / `func_areaportal` / `func_precipitation` 的 brush 不导出碰撞体。
- 每个 brush：
  - 从 brush sides 收集平面；
  - 三平面求交（Cramer）计算凸包顶点，空间哈希去重；
  - 顶点 < 4 时翻转法线重算（兼容法线朝内 brush）；
  - 计算 AABB；
  - 坐标从 BSP Z-up 旋转到 Three.js Y-up（`[x,y,z]→[y,z,x]`）；
  - 法线方向取反（vbsp 内部“法线朝内” → cs-movement “法线朝外”）。
- 性能保护：最多 8000 个 brush。

### 5.2 模型碰撞（`.phy` / 可视网格回退）

- 优先 `export_model_phy_colliders()`：
  - 从 PAKFILE 提取被 static_props 引用的模型三件套 `.mdl/.vvd/.dx90.vtx`；
  - 解析 `.phy`（vphysics 碰撞体）；
  - 仅支持 `modelType == 0`（IVPCompactSurface 凸包）与 `bone_index == 0` 的凸体；
  - IVP 坐标系 → Source 坐标（`[x,y,z]→[x,z,-y]`）→ root transform → `map_coords`（Z-up→Y-up）→ `place_point`（世界摆放）。
- 若 `.phy` 导出为空，主线程回退到 `export_model_tri_colliders()`：
  - 用模型可视网格作为碰撞网格；
  - 真半透明材质（alpha=1）跳过；
  - `static_prop.solid == 0` 实例跳过。
- 三角形总数护栏：`MAX_TRI_TOTAL = 200_000`。

### 5.3 出生点（`parse_spawn_points`）

- 识别 `info_player_start` / `info_player_terrorist` / `info_player_counterterrorist` / `info_player_deathmatch` / `info_player_teamspawn` / `info_player_axis` / `info_player_allied` / `info_player_coop` / `info_teleport_destination` 等；
- 也匹配 `info_player_*` 通配；
- `primary` 优先 `info_player_start`，否则第一个出生点；
- `origin` 已旋转为 Y-up；`angles` 保持 BSP 原始 `[pitch,yaw,roll]`。
- 主线程把出生点 yaw 用 `bspYawToCsYaw(bspYaw) = (270 - bspYaw) mod 360` 转成 cs-movement yaw。

### 5.4 传送（`parse_teleports`）— 非最小集，运行时已排除

- 目标：`info_teleport_destination*`；
- 触发器：`trigger_teleport` / `trigger_teleport_random` / `trigger_teleport_relative`；
- 触发器几何：遍历 `model.head_node` 收集 brush，每个 brush 单独计算局部 AABB + 凸包平面，再平移到世界空间并旋转 Y-up；
  - 这样避免 Hammer “Tie to entity” 多个分散 brush 共用总包围盒导致的误触发；
- 支持 `spawnflags`（Clients 位）与 `StartDisabled` 过滤；
- 输出 `teleports/triggers/links` 以及 orphan 统计。

### 5.5 PVS（`parse_pvs_data`）— 非最小集，运行时已排除

- 导出 BSP 树 nodes/leaves、`face_clusters`、RLE 解码后的 PVS 位图（Base64）；
- 坐标旋转到 Y-up；
- `pvs_bits[cluster * bytes_per_row + (target/8)]` 第 `(target%8)` 位表示可见；
- **WorkerB 已移除 PvsManager**，运行时不再消费 PVS；该方法仅保留在 WASM API 供脚本/扩展使用。

### 5.6 GLB（`export_glb_with_pakfile_models`）

- 若 PAKFILE 中没有被 static_props 引用的模型三件套，自动回退为纯地图导出；
- 否则：
  1. 收集被引用模型三件套；
  2. 解析 PAKFILE 内 VMT/VTF 为 PNG 贴图与 alpha_mode；
  3. 用 `ModelIntegrator` 合并静态道具；
  4. `bsp_to_gltf_core::export_bsp_with_models` 生成 GLB。
- 该调用消费 Bsp 实例，必须最后调用。

## 6. 坐标系统

| 系统 | 轴向 |
|---|---|
| BSP / Source 原始 | Z-up（右手系） |
| Three.js / PhysWorld 世界 | Y-up（`[x,y,z]→[y,z,x]`，det=+1） |
| 相机 | 第一人称 FPS：`pos + (0, EYE_STAND, 0)`，`rotation.set(pitch,yaw,0,'YXZ')` |
| 出生点 yaw | BSP 顺时针 → cs-movement 逆时针：`(270 - yaw) mod 360` |

## 7. 已知限制

- v19 早期 CSS FACES v0 未实现；
- 不支持 Source 2 / 更高版本；
- 不导出 mosaic / 缺失纹理 / 默认纹理包；
- 模型 `.phy` 只支持静态凸包子集；
- 运行时最小集不导出/不消费 teleport 与 PVS；WASM API 与脚本仍保留这些方法供独立验证。
