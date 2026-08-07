# BSP 地图实际导出情况（websurf 项目实现现状）

> 压缩自 `docs/bsp-export.md` + `docs/model-export.md` + `docs/phy-collision.md`，
> 已对照 `crates/wasm/src/lib.rs`、`src/worker/physics-worker.ts`、`src/config.ts` 等代码核实（2026-08-07 复核）。
> BSP 文件格式本身见 `docs/bsp-architecture.md`。

---

## 1. 导出链路总览

```
BSP
 ├─ 地图几何/纹理 ──→ GLB（export_glb*）
 ├─ 地图碰撞 ──→ WasmBrush[] JSON（export_brushes_planes）
 ├─ 模型显示 ──→ GLB 节点（PAKFILE 三件套 + StaticProps 放置）
 ├─ 模型碰撞 ──→ TriMesh[] JSON（visual / phy / 薄壳 brush 三方案）
 ├─ 实体/出生点/传送 ──→ JSON（parse_entities / spawn / teleports）
 ├─ PVS ──→ JSON + base64 位图（parse_pvs_data）
 └─ PAKFILE ──→ 文件清单 / 单文件字节 / 脚本（list / read_pakfile*）
```

### 1.1 WASM 导出 API（`lib.rs`，已核实）

| 方法 | 输出 | 消费 BSP？ |
|---|---|---|
| `metadata()` | 元数据 JSON | 否 |
| `export_glb()` / `export_glb_with_models()` / `export_glb_with_pakfile_models()` | GLB 字节 | **是（take）** |
| `export_brushes_planes(filter_json)` | 地图碰撞 `WasmBrush[]` | 否（借用） |
| `export_colliders()` / `export_colliders_with_filter()` | 碰撞（另一入口） | 否 |
| `export_model_tri_colliders()` | 模型可视网格三角形（默认） | 否 |
| `export_model_phy_colliders()` | 模型自带 .phy 凸包（已实现） | 否 |
| `export_model_colliders()` | 薄壳 brush（回退方案） | 否 |
| `parse_entities()` / `parse_spawn_points()` / `parse_teleports()` | 实体 JSON | 否 |
| `parse_pvs_data()` / 独立 `export_visleaf_pvs()` | PVS/BSP 树 JSON | 否 |
| `list_pakfile()` / `read_pakfile_file()` / `read_pakfile_scripts()` | PAKFILE 访问 | 否 |
| `is_alive()` | BSP 是否仍持有（生命周期检查） | — |
| 独立：`parse_bsp()` / `decode_vtf_to_png()` | 元数据 / PNG | — |

**生命周期约束**：`export_glb*` 会 `take()` 消费 Bsp 实例，其余借用方法必须先于它调用。
Worker 实际顺序（`physics-worker.ts`，已核实）：
`parse_spawn_points → parse_teleports → parse_pvs_data → export_brushes_planes
→ 模型碰撞（按 colliderSource）→ export_glb_with_pakfile_models（失败回退 export_glb）`。

## 2. 地图显示导出（GLB）

- 入口 `bsp_to_gltf_core::export_bsp*`（`ConvertOptions{ textures, texture_scale, generate_missing_list }`）；
- 按 **Model** 分组枚举 faces，每个 model 一个 mesh + 一个 glTF Node（translation = model origin）；
- face → `BspVertexData{ position, uv }`（20B）+ 索引，`map_coords` Z-up→Y-up；
- `face.is_visible()` 过滤；`extras.faceIndex` 写全局 face 索引供前端 PVS 按面剔除；
- displacement 由 vbsp 展开后走同一 face 路径；无贴图时按材质名哈希生成占位色。

## 3. 地图碰撞导出（`export_brushes_planes`）

输出 `WasmBrush[]`：`{ planes:[{normal,dist}], min, max, is_ladder, is_solid }`。

关键处理：
1. **法线翻转**：vbsp 读入平面法线朝内，导出时先旋转 Y-up 再取负（cs-movement 需要朝外）；
   三平面求交顶点不足 4 个时翻转全部法线重算；
2. **实体性判定**：contents SOLID|WINDOW|GRATE|PLAYERCLIP|MOVEABLE → is_solid；LADDER → is_ladder；
3. **无碰撞实体过滤**：`trigger_*` / `func_illusionary` 等的 brush 不导出；
4. **实体 brush 原点修正**：局部坐标平面按模型 origin 平移回世界坐标；
5. **AABB**：三平面 Cramer 求交 → 空间哈希去重（0.1 HU）→ 正侧校验 → min/max；
6. 过滤参数 `ColliderFilter`（前端 `DEFAULT_COLLIDER_FILTER` 与 Rust 默认一致）：

   | 字段 | 默认 | 含义 |
   |---|---|---|
   | `include_ladder` | true | 导出梯子 brush |
   | `include_solid` | true | 导出实体 brush |
   | `min_brush_volume` | 0 | AABB 体积下限（过滤碎片） |
   | `skip_sky` | true | 跳过天空材质 brush |
   | `skip_nodraw` | false | 跳过 nodraw 材质 brush |

   护栏 `MAX_BRUSHES = 8000`。

前端：`collider-adapter.ts` `adaptBrushes` → `world.solids/ladders` + `BrushGrid` 空间索引。

## 4. 模型导出（PAKFILE → GLB + 碰撞）

### 4.1 资源来源
仅凭 BSP 内嵌 PAKFILE（zip）还原模型，不依赖外部游戏资源。
surf_666 实测 1500 条目：`.vtx`317 / `.vmt`149 / `.mdl`107 / `.vvd`107 / **`.phy`89** /
`.vtf`76 / `.vhv`633（未用）/ `.ppl`20 / `.pcf`1 / `.txt`1（未用）。

`collect_pakfile_models()`：收集 static_props 引用 → 仅提取三件套（`.mdl+.vvd+.dx90.vtx`）齐全
且被引用的模型 → `InMemoryModel`。

### 4.2 三件套解析（vendored `vendor/vmdl`）
- `.mdl`（body_parts/meshes/材质表/骨骼/surface_prop/mass）+ `.vvd`（顶点 48B）+ `.vtx`（条带）；
- **条带展开修复**：上游 vmdl-0.2.0 公式两处错误（奇位退化三角 + 越界），已 vendor 修复并单测
  （surf_666 实测 212 个 dx90.vtx、522 条带全是 TRI_LIST，修复保证其他条带图正确）；
- 关键 API：`meshes()`、`skin_tables()`、`apply_root_transform()`、`surface_prop()`。

### 4.3 放置解析 `resolve_placements()`
优先级：static_props 完整路径匹配 → 文件名包含 → 实体 `model` 字段。
`Placement{ translation(Y-up), rotation(yaw*pitch*roll 四元数), scale, solid }`；
`solid==0`（SOLID_NONE）碰撞导出时过滤。
⚠️ 已知限制：碰撞导出传空实体表，`prop_dynamic` 放置的模型实例**不生成碰撞**（扩展点）。

### 4.4 显示网格（`add_models_to_gltf`）
`ModelVertex{ position, uv, normal }`（32B）一次上传、多实例共享 mesh；
position 经 `map_coords(apply_root_transform(v))`；每 Placement 一个 glTF 节点。

### 4.5 材质与透明度
- VMT 扁平扫描：`$translucent`/`$alpha<0.999` → Blend；`$alphatest` → Mask(cutoff 0.5)；否则 Opaque；
  patch 材质跟一层 `include` 并继承透明度；
- VTF → PNG（`decode_vtf_to_png` 第一帧）；PakIndex 大小写不敏感、自动补 `materials/` 前缀；
- glTF 映射：Blend 双面、Mask 单面；无贴图按材质名哈希上色；metallic=0/roughness=1；
- **碰撞门控（保守）**：仅当模型所有材质都 Blend 才跳过碰撞；alphatest 保留；无 VMT 保留。

### 4.6 模型碰撞三方案（`colliderSource: auto/visual/phy`，config.ts 已核实默认 auto）

| 方案 | 方法 | 说明 |
|---|---|---|
| **A. 可视网格三角形（默认回退）** | `export_model_tri_colliders` | 零转化，与 GLB 逐位一致；护栏 `MAX_TRI_TOTAL=200k` |
| **B. .phy 模型自带凸包（已实现）** | `export_model_phy_colliders` | 引擎权威碰撞，三角形更少；无 .phy 时 auto 回退 A |
| C. 薄壳 brush（历史/兜底） | `export_model_colliders` | 逐三角挤 4.0 薄壳；>4096 三角回退整体 OBB；上限 24k brush |

worker 逻辑（已核实）：`visual`→A；`phy/auto`→B（auto 为空回退 A）；抛异常回退 C。

⚠️ **数据格式陷阱**：TriMeshOut 的 `vertices/min/max` 是紧凑数组 `[x,y,z]` 非对象，
前端须用 `va[0..2]` 访问（曾因按对象访问全 NaN，已修复+冒烟测试）。

### 4.7 .phy 解析（`crates/wasm/src/phyfile.rs`，已实现）
- 布局：`phyheader_t`(16B: size/id/solidCount/checkSum) → 每 solid 表面头
  （新版 compactsurfaceheader "VPHY" / 旧版 legacysurfaceheader）→ 凸体头
  `convexsolidheader_t`（ledge，16B：vertices_offset / bone_index / 保留 / triangles_count(u16)）→
  顶点 `phyvertex_t`(vec4，**米制 ×39.3701 转 HU**) → 三角形 `triangledata_t`（取 3 条边的
  start_point_index）→
  文件末尾文本段 `solid{index, surfaceprop}` / `editparams{rootname,totalmass}` /
  `ragdollconstraint`（仅 ragdoll）/ `break`（碎裂 gib，未用）；
- `triangledata_t`（16B）= 首 u32 位域 `tri_index:12 / pierce_index:12 / material_index:7 /
  is_virtual:1` + 3 条边各 u32（`start_point_index:16 / opposite_index:15 / is_virtual:1`）；
  碰撞导出取 3 条边的 `start_point_index` 组成三角形（首 u32 的 tri_index 未用）；
- **闭源 IVP 背景**：`triangledata_t` 布局 / `vertices_offset` 基准 / `modelType` 枚举在
  Valve 官方开源仓库同样不可见 —— .phy 二进制本体由闭源 IVP/vphysics 库
  （`IPhysicsCollision::VCollideLoad`）解析，引擎侧仅在 `studiobyteswap.cpp ByteswapPHY`
  展开头部、在 `PhysModelCreate → CreatePolyObject` 边界做坐标转换；本项目依据
  TAServers phyparser 逆向 + Python/Rust 实测交叉验证（`probe_phy_stats` 实测：
  static_props 引用模型 104 个、其中 88 个带 .phy，**88/88 解析成功**、
  906 凸体 / 11,878 三角）；
- **坐标**：PHY 顶点为 IVP 空间（Y-up 左手），转 Source = 绕 x 轴 90° `(x, z, -y)`
  （det=+1 纯旋转；仅 y↔z 交换为镜像会上下颠倒 —— 实测定论，验证须同时比尺寸和符号）；
  顶点相对骨骼，非 STATIC_PROP 需再 `apply_root_transform`；
- 当前仅支持 bone 0 静态模型；凸包三角形与可视网格同构 TriMesh，物理层零新增代码，
  复用 `TriangleGrid`（`src/physics/physics/Collision/triangle-grid.ts`）+ `clipBoxToTriangle`；
- 文本段 `surfaceprop` 即引擎碰撞材质来源（`physprops->GetSurfaceIndex`），
  与 `Model::surface_prop()` 互证；
- 可视化：visual=紫色 / phy=橙色线框。

## 5. 实体 / 传送 / PVS

- `parse_entities()`：全部实体
  `[{ index, classname, targetname, props(BTreeMap), outputs, origin_raw, model_raw }]`
  （`On*` 开头 key 归入 outputs；**未做坐标转换**，origin_raw 保持 BSP 文本原样）；
- `parse_spawn_points()`：
  `{ spawn_points:[{ classname, origin(Y-up), angles, origin_raw, angles_raw }], total, primary }`，
  `[x,y,z]→[y,z,x]` 转 Y-up，primary 优先 `info_player_start`；
- `parse_teleports()`：
  ```
  { teleports:[{ index, targetname, origin(Y-up), angles, origin_raw, angles_raw }],
    triggers:[{ index, classname, target, origin, model, model_mins, model_maxs,
                model_planes, spawnflags, start_disabled, origin_raw, model_raw }],
    links:[{ trigger_idx, dest_idx }], total_triggers, total_dests, total_links,
    orphan_triggers, orphan_dests }
  ```
  触发区 = 实体 model 引用 brush → **凸包平面**（世界坐标 Y-up，`[nx,ny,nz,dist]` 朝外），
  楔形/斜面触发区不能用 AABB 代替；前端 TeleportManager 用 `model_planes` 做准星/包含检测；
  - `spawnflags`：1=Clients，2=NPCs，8=PhysicsObjects，16=Only players，64=Everything；
  - `start_disabled`（StartDisabled 1）不触发传送；
- `parse_pvs_data()`：
  ```
  { rootNode, nodes:[{ normal, dist, children:[c0,c1] }],
    leaves:[{ cluster, mins(i16), maxs(i16), isSolid }],
    faceClusters:[i32], pvsBitsBase64, clusterCount, bytesPerRow }
  ```
  nodes/leaves 保持 BSP 顺序（vbsp 已修 leaf 排序 bug）；`children` 负数 → `!index` 为 leaf；
  cluster<0 = 固体 leaf（isSolid）；坐标全部 Y-up；前端 PvsManager 按 cluster 遮挡剔除。

## 6. 前端消费链路（已核实）

```
physics-worker.ts（load-bsp）
  ├─ export_brushes_planes → adaptBrushes → world.solids/ladders（BrushGrid）
  ├─ 模型碰撞（colliderSource）→ world.triMeshes（TriangleGrid）
  ├─ export_glb_with_pakfile_models（最后消费 BSP，失败回退纯地图）
  ├─ parse_spawn/teleports/pvs → JSON
  └─ scene-data 一次 transfer 主线程
Worker 物理 World.trace：brush trace（traceBox）与 clipBoxToTriangle（traceBoxTriEntries）
取更早命中（fraction 更小者胜）
主线程 renderer-main.ts
  ├─ GLTFLoader 建场景（extras.faceIndex → PVS 剔除）
  └─ colliderDebug.setTriMeshes（相机半径 512 + 线框上限 1.2 万）
```

## 7. 关键常量

| 常量 | 值 | 用途 |
|---|---|---|
| `MAX_BRUSHES` | 8000 | 地图碰撞护栏 |
| `MAX_TRI_TOTAL` | 200_000 | 模型三角形碰撞总上限 |
| `MAX_MODEL_TRIS` / `MAX_MODEL_BRUSHES` | 4096 / 24_000 | 薄壳方案上限（超限回退 OBB） |
| `COLLIDER_THICKNESS` | 4.0 | 薄壳挤出厚度 |
| `M_TO_HU` | 1/0.0254 | .phy 米制转 HU |
| `DEBUG_RADIUS` / `MAX_TRI_LINES` | 512 / 12_000 | 碰撞可视化 |

## 8. 扩展点（尚未利用）

1. `prop_dynamic` 等实体放置的模型参与碰撞（传 `bsp.entities` 解析结果即可，工作量小）；
2. BSP 内嵌 PhysCollide（lump #29）→ brush 模型的 .phy 碰撞；
3. 导出 `surface_prop` / `mass` / `contents`（脚步音效、物理元数据）；
4. 非静态（骨骼非 0）模型的 .phy 碰撞（需骨骼变换，vmdl 已有 bones/root_transform）；
5. 光照系 lump（8/15/53-56）、Overlays/贴花、XzipPakFile；
6. 模型碰撞 LOD/距离裁剪（200k 上限附近的图）；
7. 逐材质/逐 mesh 的 alpha 标注细化（当前按"整模型全 Blend"判定）；
8. VMT 解析扩展键（`$surfaceprop`、`$selfillum`、`$envmap` 等，材质外观细节）。

## 9. 历史沿革（为什么是现在这样）

1. **早期共面合并**：`build_convex_faces` 把共面三角合并成凸多边形 → 薄斜坡被撑成实心块、
   边角多出"四角面" → **废弃**（路径已删除）；
2. **薄壳 brush**（`export_model_colliders`）：逐三角挤出 4.0 薄壳，拓扑与显示一致，但每个
   三角一个 brush（4 个四边形侧面），brush 数量爆炸、调试视图观感差 → 降为兜底回退；
3. **可视网格三角形**（`export_model_tri_colliders`）：零转化与显示逐位一致，前端三角形
   clip + 空间索引；曾因 serde 紧凑数组被前端按对象访问导致全 NaN 静默失效，已修复 +
   12/12 冒烟测试；
4. **.phy 模型自带碰撞**（`export_model_phy_colliders`）：参考 phyparser 逆向实现，
   IVP→Source 坐标经两轮修正（先误判 y↔z 交换 det=-1 镜像上下颠倒，最终绕 x 轴 90°
   `(x,z,-y)` det=+1），surf_666 88/88 模型解析成功；
5. **条带展开修复**（vendor vmdl）：上游 vmdl-0.2.0 展开公式两处错误（奇位生成退化三角形
   + 循环越界读下一条带），已修复并附 3/3 单测；正确公式：n 索引 → n−2 三角形、绕序交替
   `[idx, idx+1+cw, idx+2-cw].rev()`（cw = i&1）。
