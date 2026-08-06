# 模型导出工作流解析（Model Export Pipeline）

> 本文档基于 `crates/wasm` 模型导出链路的完整代码审查整理，目标是**细化模型导出工作流**：
> 搞清「模型的详细信息从哪来、能拿到什么、现在用了什么、还缺什么」。
> 覆盖：显示网格（GLB）、材质与透明度（VMT/VTF）、碰撞网格（可视网格 / 薄壳 brush / 模型自带 `.phy`）。
>
> 涉及文件：
> - `crates/wasm/src/lib.rs` — WASM 导出入口（`export_model_*` 系列）
> - `crates/wasm/src/model_integrator/mod.rs` — GLB 显示导出 + 放置解析
> - `crates/wasm/src/pakfile_models.rs` — VMT 解析、PAKFILE 索引、碰撞体生成
> - `vendor/vmdl/src/` — vendored 的 Source `.mdl/.vvd/.vtx` 解析器（含条带展开修复）
> - `src/worker/physics-worker.ts`、`src/physics/…`、`src/renderer/collider-debug.ts` — 前端消费

---

## 1. 总览与调用链

### 1.1 前端 worker 的加载顺序（`physics-worker.ts`）

模型相关导出都发生在 **GLB 消费 BSP 之前**（`export_glb_with_pakfile_models` 会 `take()` 掉内部 BSP）：

```
stage('导出碰撞体')  export_brushes_planes(...)            // 地图 brush 碰撞（与模型无关）
   ↓
stage('模型碰撞')    export_model_tri_colliders()          // ① 模型可视网格三角形（当前默认）
                    （失败回退 export_model_colliders()）  // ② 模型薄壳 brush（历史方案）
   ↓
stage('导出 GLB')    export_glb_with_pakfile_models()      // ③ 模型显示网格 + 地图几何
```

### 1.2 WASM 导出方法一览

| 方法 | 位置 | 作用 | 消费 BSP？ |
|---|---|---|---|
| `export_glb_with_pakfile_models()` | `lib.rs:456` | 地图 + PAKFILE 模型合并导出 GLB（显示） | **是**（take） |
| `export_model_tri_colliders()` | `lib.rs:697` | 模型**可视网格**原样导出为世界空间三角形（碰撞） | 否（借用） |
| `export_model_colliders()` | `lib.rs:533` | 模型逐三角**挤出薄壳 brush**（碰撞，历史方案/回退） | 否（借用） |
| `export_brushes_planes()` | 见 vbsp | 地图 brush 平面导出 | 否（借用） |
| `parse_entities()` | `lib.rs:952` | 实体 lump 解析 | 否 |

**BSP 生命周期约束**：`export_model_tri_colliders` / `export_model_colliders` 必须**先于** `export_glb_with_pakfile_models` 调用，否则报「BSP 未解析或已被导出消费」。

### 1.3 一次导出中的数据流

```
BSP PAKFILE (zip)
  ├─ .mdl / .vvd / .dx90.vtx ──→ vmdl::Model ──→ 顶点/索引/材质表
  ├─ .vmt ──→ VmtInfo{ basetexture, alpha_mode, include }
  ├─ .vtf ──→ decode_vtf_to_png() ──→ PNG 字节
  └─ .phy ──→ ❌ 当前未解析（见 §7.3）
BSP static_props lump ──→ StaticProp{ model, origin, angles, solid }
                         └─→ resolve_placements() ──→ Placement{ translation, rotation, scale, solid }
```

---

## 2. 资源来源：BSP PAKFILE

Source BSP 会把地图引用的资源打进 `PAKFILE` lump（BSP lump 40）。本项目**仅凭 BSP 字节**在浏览器内还原模型，不依赖外部游戏资源。

### 2.1 surf_666 实测资源分布（1500 个条目）

| 扩展名 | 数量 | 用途 |
|---|---|---|
| `.vhv` | 633 | 地形/其他（未用） |
| `.vtx` | 317 | 模型三角形数据（含 `dx90.vtx`） |
| `.vmt` | 149 | 材质（含透明度标注） |
| `.mdl` | 107 | 模型头文件 |
| `.vvd` | 107 | 模型顶点数据 |
| **`.phy`** | **89** | **模型自带物理碰撞体（当前未解析！）** |
| `.vtf` | 76 | 贴图（解码为 PNG） |
| 其他 | 22 | `.ppl/.pcf/.txt` |

> 结论：**模型自带的实际碰撞网格（.phy）就在 PAKFILE 里**，89 个模型有物理碰撞体，具备解析条件（详见 §7.3）。

### 2.2 `collect_pakfile_models()`（`lib.rs:66`）

1. 收集 `static_props` 引用的模型路径集合（`referenced`）；
2. 枚举 PAKFILE 全部条目名（zip 只锁一次），供 `PakIndex` 复用；
3. 仅提取**被引用且三件套齐全**（`.mdl` + `.vvd` + `.dx90.vtx`）的模型 → `InMemoryModel{ name, mdl, vvd, vtx }`；
4. 收集全部 `static_props` → `Vec<StaticProp>`（GLB 节点与碰撞体共用）。

---

## 3. 模型三件套解析（vendored vmdl）

`vendor/vmdl/` 是 crates.io `vmdl-0.2.0` 的 vendor（`Cargo.toml` 中 `[patch.crates-io]` 指向本地），并修复了**条带展开算法**（见 §3.3）。

### 3.1 文件结构

| 模块 | 内容 |
|---|---|
| `mdl/` | `.mdl` 头文件：body_parts → models → meshes、材质表、骨骼、动画、`surface_prop`、`mass`、`contents` |
| `vvd/` | `.vvd` 顶点数据：`Vertex{ position, normal, texture_coordinates, … }`（48 字节） |
| `vtx/` | `.dx90.vtx` 三角形数据：body_parts → models → lod → meshes → strip_groups → strips |

### 3.2 `vmdl::Model` 关键 API（`vendor/vmdl/src/lib.rs`）

| API | 签名 | 说明 |
|---|---|---|
| `from_parts(mdl, vtx, vvd)` | — | 由三件套字节构建（本项目内存路径） |
| `vertices()` | `&[Vertex]` | 全部 VVD 顶点（position/normal/uv） |
| `meshes()` | `Iterator<Item = Mesh>` | MDL 与 VTX 按序配对（bodypart → model → mesh） |
| `skin_tables()` | `Iterator<Item = SkinTable>` | 皮肤表（材质索引 → `TextureInfo`） |
| `textures()` | `&[TextureInfo]` | 模型材质清单（`name` + `search_paths`） |
| `texture_directories()` | `&[String]` | MDL 的材质搜索目录 |
| `bounding_box()` | `(Vector, Vector)` | MDL header 自带包围盒 |
| `apply_root_transform(v)` | `Vector → Vector` | `idle_transform * root_transform`（骨骼 0 旋转；STATIC_PROP 时为恒等） |
| `surface_prop()` | `&str` | 表面材质属性（如 `concrete`/`metal`，可映射碰撞材质/音效） |
| `name()` | `&str` | 模型名 |
| `bones()` / `animations()` / `poses()` | — | 骨骼/动画/姿态参数 |

`Mesh`（`lib.rs:201`）：
- `material_index()` → 材质索引（配合 `SkinTable::texture_info()` 取材质名）
- `vertex_strip_indices()` → 迭代出**模型顶点表索引**（已含 `model.vertex_offset` 偏移）

`SkinTable::texture_info(i)` → `TextureInfo{ name: String, search_paths: Vec<String> }`。

### 3.3 条带（triangle strip）展开修复（重要）

Source VTX 的三角形有两种存储：**三角形列表**（`IS_TRI_LIST`）和**三角形条带**（`IS_TRI_STRIP`）。GLB 只支持列表，必须展开。

原 `vmdl-0.2.0` 的展开有两处数学错误（**已在本项目 vendor 中修复**，`vendor/vmdl/src/vtx/mod.rs`）：

```rust
// 修复前（错误）：奇数位生成退化三角形 [i,i,i+1]，且循环多走 2 次越界
// (0..len).flat_map(|i| { let cw = i & 1; let idx = offset + i;
//     [idx, idx + 1 - cw, idx + 2 - cw].into_iter().rev() })
// 修复后（正确）：
(0..self.indices.len().saturating_sub(2)).flat_map(move |i| {
    let cw = i & 1;
    let idx = offset + i;
    [idx, idx + 1 + cw, idx + 2 - cw].into_iter().rev()
})
```

- n 个索引 → n−2 个三角形，绕序交替；
- 修复前：隔一个丢一个三角形（菱形洞）+ 末尾越界读到下一条带（边角杂散"四角面"）；
- 附带单测 `cargo test --manifest-path vendor/vmdl/Cargo.toml`（3/3 通过）。
- **注意**：surf_666 实测 264 条 strip 全部是 `IS_TRI_LIST`，该修复对该图不产生行为差异，但保证其他使用条带的 Source 图正确。

---

## 4. 放置解析：`resolve_placements()`（`model_integrator/mod.rs:907`）

一个 `.mdl` 在地图中常被**多次实例化**（surf 图斜坡尤甚），必须返回全部实例。

### 4.1 匹配优先级

1. `static_props` **完整路径**精确匹配（忽略大小写、`\`/`/` 差异）——最可靠；
2. 回退到**文件名包含**匹配；
3. 再回退到实体（`prop_dynamic` 等）的 `model` 字段匹配。

> ⚠️ **当前限制**：`export_model_tri_colliders` / `export_model_colliders` 调用时传的是空实体表
> `no_entities = Vec::new()`，**实体放置的模型实例不会生成碰撞**（显示端 `add_models_to_gltf`
> 同样传空实体）。若地图模型主要由 `prop_dynamic` 等实体放置，碰撞会缺失 —— 需在
> `collect_pakfile_models` 或导出方法中解析实体 lump（`bsp.entities`，`parse_entities()` 已有现成解析）。

### 4.2 `Placement` 结构

```rust
pub struct Placement {
    pub translation: [f32; 3],          // map_coords(origin)
    pub rotation: Option<[f32; 4]>,     // angles_to_quat(pitch, yaw, roll) → [x,y,z,w]
    pub scale: Option<[f32; 3]>,
    pub solid: Option<u8>,              // static_prop 的 solid；0 = SOLID_NONE（无碰撞）
}
```

- `angles_to_quat(pitch, yaw, roll)`：组合顺序 `yaw * pitch * roll`（`mod.rs:890`），与 Source `QAngle` 语义一致；
- `solid == 0`（`SOLID_NONE`）的实例在碰撞导出时被过滤（`lib.rs:738` / `lib.rs:560`）；
- `map_coords([x,y,z]) -> [y,z,x]`：Source **Z-up → glTF Y-up** 坐标转换（det=+1）。

### 4.3 世界空间变换（碰撞端）

```rust
// pakfile_models::place_point（lib.rs 导出三角形碰撞的顶点变换）
// v' = translation + quat_rotate(q, scale ⊙ v)
```

与 GLB 显示端**逐位一致**：显示端把 `Placement` 直接写入 glTF 节点 `translation/rotation/scale`，
由 glTF 加载器应用 `T · R · S · v` —— 两者数学等价，因此碰撞几何与显示几何重合。

---

## 5. 显示网格导出（GLB）

入口 `add_models_to_gltf()`（`model_integrator/mod.rs:86`），由 `export_glb_with_pakfile_models` 经
`bsp_to_gltf_core::export_bsp_with_models` 调用。

### 5.1 流程

1. 对每个 `InMemoryModel`：`load_model_from_bytes` → `vmdl::Model`（单个失败仅跳过该模型）；
2. `resolve_placements` 取全部实例，无实例则跳过（不放垃圾几何到世界原点）；
3. `push_model`：**一次上传顶点**（同一模型多实例共享 mesh）：
   - `push_vertices`：`ModelVertex{ position, uv, normal }`（`mod.rs:1021`，bytemuck 打包）+
     3 个 accessor（POSITION / TEXCOORD_0 / NORMAL）；position 已做
     `map_coords(apply_root_transform(v.position))`；
   - `push_primitive`：`vertex_strip_indices().flatten()` → 32 位索引 accessor；
4. 每个 `Placement` 生成一个 glTF 节点（`rotation: p.rotation.map(UnitQuaternion)` 等），引用同一 mesh；
5. `push_material` / `push_texture`：材质与贴图（见 §6）。

### 5.2 顶点结构（`ModelVertex`，48 字节）

```rust
#[repr(C)]
pub struct ModelVertex {
    position: [f32; 3],   // offset 0  (POSITION)
    uv:       [f32; 2],   // offset 12 (TEXCOORD_0)
    normal:   [f32; 3],   // offset 20 (NORMAL)
}
```

---

## 6. 材质与透明度

### 6.1 VMT 解析（`pakfile_models.rs:94` `parse_vmt`）

扁平扫描 KeyValues（不建树），提取：

| VMT 键 | 含义 | alpha_mode |
|---|---|---|
| `$translucent 1` | 逐像素混合半透明（玻璃、水幕） | **1 = Blend** |
| `$alpha < 0.999` | 整体透明度 | **1 = Blend** |
| `$alphatest 1` | 二值镂空（铁丝网、树叶） | **2 = Mask** |
| 均未出现 | 不透明 | **0 = Opaque** |

同时提取 `$basetexture`（贴图路径）与 `include`（patch 材质引用）。

**patch 材质链**（`lib.rs:193`）：`patch` 材质本身无 `$basetexture`，跟一层 `include` 取真正的
`$basetexture`；母材质半透明时透明度**继承**到 patch 材质。

### 6.2 VMT/VTF 查找：`PakIndex`（`pakfile_models.rs:179`）

- 大小写不敏感（`by_path` 小写全路径 + `by_stem` 基名）；
- `find(path_no_ext, ext)` 自动补 `materials/`、`models/` 等前缀，兜底按基名匹配。

### 6.3 VTF → PNG（`lib.rs:2971` `decode_vtf_to_png`）

`texture_utils::from_bytes` → `highres_image.decode(0)`（第一帧）→ 编码 PNG。

### 6.4 GLB 材质映射（`model_integrator/mod.rs:359` `push_material`）

| alpha_mode | glTF 设置 |
|---|---|
| 0 Opaque | `AlphaMode::Opaque`，`double_sided=false` |
| 1 Blend | `AlphaMode::Blend`，`double_sided=true` |
| 2 Mask | `AlphaMode::Mask`，`alphaCutoff=0.5`，`double_sided=false` |

- 有贴图 → `base_color_factor = [1,1,1,1]`（防染色）；无贴图 → 材质名哈希生成可区分色；
- `metallic=0`、`roughness=1`（Source 材质无 PBR 数据）。

### 6.5 透明度的**碰撞门控**（保守策略，`pakfile_models.rs` 模块注释）

- 仅当模型**所有**材质都是 Blend（真半透明）时才跳过碰撞；
- `$alphatest` 镂空（铁丝网/栅栏）在 Source 里本是实体，**保留碰撞**；
- 未找到 VMT 按不透明处理，**保留碰撞**；
- `static_prop.solid == 0`（SOLID_NONE）明确无碰撞，跳过。

---

## 7. 碰撞网格：三种方案

### 7.1 A. 可视网格三角形（当前默认，`export_model_tri_colliders`，`lib.rs:697`）

**零转化**：不挤出、不共面合并、不凸包、不 OBB 回退。输出与 GLB 显示**逐位一致**。

输出 JSON 结构（`TriMeshOut`）：

```json
[{
  "name": "models/xxx.mdl",
  "vertices": [[x,y,z], ...],     // 世界空间，紧凑数组！
  "indices":  [[a,b,c], ...],
  "min": [x,y,z], "max": [x,y,z]
}]
```

流程：`collect_pakfile_models` → `resolve_placements`（过滤 `solid==0`）→ `load_vmdl` →
本地顶点 `map_coords(apply_root_transform(v.position))` → 逐 mesh 透明度门控（Blend 跳过）→
`place_point` 搬到世界空间 → 输出。

护栏：`MAX_TRI_TOTAL = 200_000`（总三角形上限，防超大图拖垮 trace）。

前端消费：`physics-worker.ts` → `world.triMeshes` → `TriangleGrid`（空间索引）→
`traceBoxTriEntries`（clip）→ `traceBoxTriangles`（线性对照）。

> ⚠️ **数据格式陷阱**：`vertices/min/max` 是**紧凑数组 `[x,y,z]`**（Rust serde 序列化），
> **不是** `{x,y,z}` 对象。前端必须用 `va[0]/va[1]/va[2]` 访问 —— 曾因按对象访问导致
> 所有模型碰撞 NaN 失效（仅地图 brush 正常），已修复并加 12/12 冒烟测试。

### 7.2 B. 薄壳 brush（历史/回退，`export_model_colliders`，`lib.rs:533`）

每个三角形沿法线挤出 `COLLIDER_THICKNESS = 4.0` 的薄壳 brush，输出与地图 brush 同构的
`WasmBrush[]`。三角数 > `MAX_MODEL_TRIS = 4096` 时回退**整体 OBB** 粗碰撞
（`placed_obb` + `obb_to_brush`）。总 brush 数上限 `MAX_MODEL_BRUSHES = 24_000`。

关键函数（`pakfile_models.rs`）：
- `push_oriented_tri`：用 **VVD 顶点法线**定三角形朝向（studiomdl 版本间缠绕不统一，几何法线不可靠）；
- `transform_face`：非等比缩放下用 `R·(S⁻¹·n)` 重算朝外法线（负缩放/镜像也正确）；
- `face_to_brush`：凸多边形沿法线反向挤出薄壳。

> 历史教训：早期 `build_convex_faces` 把共面三角合并成凸多边形，导致薄斜坡被撑成实心块、
> 边角多出"四角面"，已废弃（该路径删除）。

### 7.3 C. 模型自带物理碰撞体（`.phy`）—— **未实现，扩展点**

**Source 引擎中模型"实际碰撞网格"的权威来源是 `.phy` 文件**（vphysics 数据），
与可视网格完全独立 —— 通常更简化、按凸体分解（`KEYFIELDS`：`box` / `sphere` / `cylinder` /
`mesh`（凸包三角） / `convex`），并可带多个 `hull`（玩家/子弹/飞行物用不同 hull）。

**当前状态**：
- ✅ `surf_666` PAKFILE 内有 **89 个 `.phy`**（如 `models/thespectator/cow.phy`、
  `models/props/666/s2_pillbig.phy`），数据可用；
- ❌ `vendor/vmdl` **没有 `.phy` 解析模块**（源码仅注释提及"碰撞在关联 PHY 文件"）；
- ✅ MDL header 已解析部分物理元数据：`mass`（质量）、`contents`（ContentFlags）、
  keyvalues 字符串（`key_value_index/size`，可能含 vphysics 参数）；
- ✅ `Model::surface_prop()` 可提供材质表面属性。

**实现建议**（若需"模型自带实际碰撞"）：
1. 新增 `vendor/vmdl/src/phy/` 或独立 `phyfile` 模块，按 Source `phy` 格式
   （`phyheader_t` + `vphysics_save_cphysicsslod_t` + 各 solid 类型）解析；
2. `collect_pakfile_models` 增加 `.phy` 提取（`name.replace(".mdl", ".phy")`，PAKFILE 已有）；
3. 导出方法输出"凸体列表"（box/sphere/mesh），前端按凸体做碰撞；
4. 与现方案取舍：`.phy` 是引擎实际使用的碰撞，但 surf 图斜坡可能依赖可视网格更精细的形状
   —— 可做成可切换（`config` 开关）。

> ✅ **完整实现方案已产出**：见 `docs/phy-collision.md` —— 含 Valve 官方 PHY 格式提炼
> （主头/表面头/凸体/顶点/三角/文本段）、Rust 解析与导出设计、以及**「碰撞来源选项」
> （auto/visual/phy，对齐物理模式 `#physicsMode`）**的前端切换实现。

---

## 8. 关键数据结构与常量

### 8.1 核心结构

| 结构 | 位置 | 说明 |
|---|---|---|
| `InMemoryModel{ name, mdl, vvd, vtx }` | `lib.rs` | PAKFILE 提取的三件套 |
| `StaticProp{ model, origin, angles, solid }` | `model_integrator/mod.rs:862` | static_props lump |
| `Placement{ translation, rotation, scale, solid }` | `model_integrator/mod.rs:876` | 统一放置信息 |
| `VmtInfo{ basetexture, alpha_mode, include }` | `pakfile_models.rs:40` | VMT 解析结果 |
| `PakMaterials{ textures, alpha_modes }` | `lib.rs` | 材质汇总（纹理 PNG + 透明度标注） |
| `TriMeshOut{ name, vertices, indices, min, max }` | `lib.rs:714` | 三角形碰撞输出 |
| `BrushOut{ planes, min, max, is_ladder, is_solid }` | `pakfile_models.rs:241` | brush 碰撞输出 |

### 8.2 常量表

| 常量 | 值 | 位置 | 用途 |
|---|---|---|---|
| `MAX_TRI_TOTAL` | 200_000 | `lib.rs:724` | 三角形碰撞总上限 |
| `MAX_MODEL_TRIS` | 4_096 | `lib.rs:45` | 薄壳方案单模型三角上限（超限回退 OBB） |
| `MAX_MODEL_BRUSHES` | 24_000 | `lib.rs:48` | 薄壳方案总 brush 上限 |
| `COLLIDER_THICKNESS` | 4.0 | `lib.rs:51` | 薄壳挤出厚度 |
| `DEBUG_RADIUS` | 512 | `collider-debug.ts:15` | 三角形线框显示半径 |
| `MAX_TRI_LINES` | 12_000 | `collider-debug.ts:563` | 可视化线框上限 |
| `BIG_CELL_LIMIT` | 512 | `triangle-grid.ts:163` | 大三角形进 big 列表阈值 |

---

## 9. 前端消费链路

```
physics-worker.ts
  processor.export_model_tri_colliders() → triJsonRaw
  world.triMeshes = JSON.parse(triJsonRaw)
  sceneData.triJson = triJsonRaw（原始字符串直传主线程，避免二次序列化）

physics（worker 内）
  World.trace / isPositionFree
    → TriangleGrid.query(扫描体 AABB) → traceBoxTriEntries → clipBoxToTriangle
    （clipBoxToTriangle：三角形面 ±法线 + 3 条边平面，Minkowski 展开后与 brush 同法裁剪；
      边平面用质心校准方向，顶点顺序无关、双面碰撞；退化三角形跳过）
  → 与地图 brush trace 结果取更早命中

renderer（主线程）
  renderer-main.ts: JSON.parse(data.triJson) → colliderDebug.setTriMeshes()
  collider-debug.ts rebuildTriangles(cameraPos)：相机半径 512 + 线框上限 1.2 万，
    青色 LineSegments 显示模型碰撞 = 显示网格
```

---

## 10. 细化工作流建议（扩展点清单）

| # | 建议 | 价值 | 工作量参考 |
|---|---|---|---|
| 1 | **解析 `.phy` 模型自带碰撞体**（§7.3） | 获得引擎权威碰撞（凸体分解、多 hull），替代可视网格碰撞 | 中（新增 vmdl phy 模块 + 导出） |
| 2 | **实体放置的模型参与碰撞**（§4.1 限制） | 修复 `prop_dynamic` 等实体模型无碰撞的问题 | 小（导出方法传 `bsp.entities` 解析结果） |
| 3 | 导出 `Model::surface_prop()` / `mass` / `contents` | 碰撞材质（脚步音效、子弹响应）、物理属性元数据 | 小 |
| 4 | 逐材质/逐 mesh 的 alpha 标注细化 | 半透明门控更精确（当前按"整模型全 Blend"判定） | 小 |
| 5 | VMT 解析扩展键（`$surfaceprop`、`$selfillum`、`$envmap` 等） | 材质外观细节（自发光/反射） | 小-中 |
| 6 | 碰撞可视化按物理类型着色（可视网格 / 薄壳 / .phy 凸体） | 调试区分来源 | 小 |
| 7 | 模型碰撞的 LOD/距离裁剪（复用 brush 的 cull 体系） | 性能（200k 三角形上限附近的图） | 中 |

---

## 附：历史沿革（为什么是现在这样）

1. **早期**：`build_convex_faces` 共面合并 → 薄斜坡被撑成实心块、边角四角面 → **废弃**；
2. **薄壳 brush**（`export_model_colliders`）：逐三角挤出 4.0 薄壳，拓扑与显示一致，但每个
   三角一个 brush（4 个四边形侧面），调试视图"边角四角面"观感差、brush 数量爆炸；
3. **可视网格三角形**（`export_model_tri_colliders`，当前默认）：零转化，与显示逐位一致，
   前端三角形 clip + 空间索引；曾因格式陷阱（数组 vs 对象）全 NaN 失效，已修复；
4. **条带展开修复**（vendor vmdl）：上游 `vmdl-0.2.0` 展开公式两处错误，已 vendor 修复并单测。
