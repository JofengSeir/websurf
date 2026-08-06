# 模型自带碰撞体（.phy）实现方案 + 碰撞来源选项

> 状态：**已实现**（Rust 解析+导出 + 前端选项切换全部落地）。
> - Rust：`crates/wasm/src/phyfile.rs` + `BspProcessor::export_model_phy_colliders`
> - 前端：`config.physics.colliderSource`（auto/visual/phy）+ 物理面板 `#colliderSource`
>   选择（对齐 `#physicsMode`）+ worker 按选项选择导出 + 可视化分组着色（可视=青 / .phy=黄）
> 格式依据：Valve 官方 PHY 文档 + TAServers/source-parsers phyparser
> （triangledata_t 布局等官方文档未覆盖部分，已实测验证）。
>
> 目标：让模型碰撞网格**可选** —— 像「物理模式」（`#physicsMode`：noclip/physics）那样，
> 用户可在 **可视模型网格** 与 **模型自带碰撞网格（.phy）** 之间切换。
> 相关背景见 `docs/model-export.md` §7。

---

## 1. Valve 文档审查结论（有没有用？）

**有用**，可支撑解析器的主体骨架；**但不完整**，有 4 处需要对照 Valve 源码/开源实现补全：

| 内容 | 文档覆盖 | 可用性 |
|---|---|---|
| 文件整体布局（主头 + N 个 solid 段 + 顶点/三角 + 文本段） | ✅ | 直接可用 |
| `phyheader_t` 主头（size/id/solidCount/checkSum，16 字节） | ✅ | 直接可用 |
| 新版表面头 `compactsurfaceheader_t`（含 `"VPHY"` 标识、modelType） | ✅ | 直接可用 |
| 旧版表面头 `legacysurfaceheader_t`（质量中心/惯性矩/ledge tree 偏移） | ✅ | 可用 |
| 凸体头 `convexsolidheader_t`（vertices_offset/bone_index/flags/triangles_count） | ✅ | 直接可用 |
| 顶点 `phyvertex_t`（vec4，**米制**，`v / 0.0254` 转 HU） | ✅ | 直接可用 |
| 文本段 `solid{index, name, parent, mass, surfaceprop, …}` / `editparams` | ✅ | 直接可用（surfaceprop 是碰撞材质） |
| 三角形 `triangledata_t`（12+12+7+1 位域 + 3×edge 字段） | ⚠️ 文档未给字节数/对齐 | **官方开源仓库亦无定义（闭源 IVP）→ 参考 Crowbar/SourceIO 或实测** |
| 凸体寻址（`vertices_offset` 是相对文件还是相对段？） | ⚠️ 含糊 | **同上：官方开源仓库不可见 → 参考开源逆向实现或实测** |
| 坐标系统（IVP 空间、静态/非静态模型差异） | ⚠️ 文档自注"may differ" | **已实测定论：PHY 顶点为 IVP 坐标系（Y-up），Source 为 Z-up —— 转换 = y↔z 交换 `(x,z,y)`（79/87 模型暴力搜索验证）**；顶点相对骨骼，非 STATIC_PROP 需再应用 `apply_root_transform` |
| modelType 各取值含义（box/sphere/mesh…） | ❌ 未列枚举 | **引擎侧未定义（vphysics 私有头）→ 参考开源逆向实现或实测** |

> 结论：**格式可解析、方案可行**。文档给了 70% 的结构定义；剩余 30%（triangledata_t 布局、
> 凸体寻址、modelType 枚举、坐标约定）**无法从 Valve 官方开源仓库补齐** —— 需参考
> Crowbar / SourceIO 等逆向实现，或按 §4 第 1 步用 Python 实测推断。

### 1.1 引擎开源侧的可获得性（DeepWiki：source-engine-2018-hl2_src 审查补充）

**核心结论**：`triangledata_t` 位域、`vertices_offset` 语义、`modelType` 枚举在
**Valve 官方开源仓库中也看不到** —— 因为 `.phy` 的二进制本体（凸体/ledge tree/三角形/顶点）
由**闭源 IVP/vphysics 库**（`IPhysicsCollision::VCollideLoad`）解析，引擎侧只做文件加载与
头部预处理。这直接改变了实现策略：**不要指望查 Valve 开源源码拿到这些定义**。

引擎侧的相关代码路径（source-engine-2018-hl2_src）：

| 环节 | 位置 | 说明 |
|---|---|---|
| PHY 加载入口 | `datacache/mdlcache.cpp` `CMDLCache::UnserializeVCollide` | `MakeFilename(handle, ".phy")` → 异步/同步读文件 → 交 `VCollideLoad` |
| **唯一展开 PHY 头部的地方** | `common/studiobyteswap.cpp` `ByteswapPHY` | X360 字节序交换工具：解析 `phyheader_t`（4×int）、`swapcompactsurfaceheader_t`（含 `short modelType`，**枚举取值未在引擎侧定义**）、`legacysurfaceheader_t`（`max_deviation:8 + byte_size:24` 位域）；头部之后的凸体数据靠 `VCollideLoad(swapEndian=true)` 由 IVP 内部完成字节交换 —— 印证结构布局在闭源库 |
| 物理对象创建 | `game/shared/physics_shared.cpp` `PhysModelCreate` | `modelinfo->GetVCollide(modelIndex)` → `physenv->CreatePolyObject(pCollide->solids[index], surfaceProp, origin, angles, …)` —— **坐标转换（模型局部 → 世界）发生在该边界**，PHY 顶点本身是模型局部/骨骼空间（米制） |
| surfaceprop 使用 | 同上 | `solid_t.surfaceprop` → `physprops->GetSurfaceIndex(surfaceprop)` —— **确认文本段的 `surfaceprop` 就是引擎碰撞材质来源**，与 §2.7 关联成立 |
| 模型类型区分 | `engine/ModelInfo.cpp` `GetModelContents` | 引擎层 `model_t::type`（`mod_brush`/`mod_studio`）**≠** PHY 内部 `modelType`（vphysics 枚举），勿混淆 |

> 对实现的启示：
> 1. 解析器主体（主头 + 表面头 + 凸体头）可完全按官方文档写；
> 2. `triangledata_t` / `vertices_offset` / `modelType` 优先**参考开源逆向实现**
>    （Crowbar 的 `PhyParser`、SourceIO），再以 Python 实测（§4 第 1 步）交叉验证；
> 3. 顶点坐标：模型局部/骨骼空间、米制 —— 与 `export_model_tri_colliders` 的
>    `map_coords(apply_root_transform(v))` + `place_point` 搬移路径天然兼容（STATIC_PROP 骨骼 0）。

---

## 2. PHY 二进制格式提炼（依据官方文档）

### 2.1 整体布局

```
┌─────────────────────────────┐
│ phyheader_t（16B 主头）      │  solidCount
├─────────────────────────────┤
│ surface[0] 头（VPHY/legacy） │ ┐
│   ├─ convexsolidheader_t…   │ │ 每个 solid 一个碰撞段，
│   ├─ 顶点列表（vec4, 米制）  │ │ 段与段背靠背连续存放
│   └─ 三角形列表（triangle…） │ ┘
│ surface[1] 头               │
│ …                          │
├─────────────────────────────┤
│ 文本段：single string        │  solid{...}/ragdollconstraint/
│ （无 size 头，文件末尾）      │  editparams{...}/break{...}
└─────────────────────────────┘
```

### 2.2 主头 `phyheader_t`（16 字节）

```c
typedef struct phyheader_s {
    int  size;        // 0x00 本头大小，一般 16
    int  id;          // 0x04 常为 0，用途未知
    int  solidCount;  // 0x08 solid 数量
    long checkSum;    // 0x0C 源 .mdl 的 checksum（32 位）
} phyheader_t;
```

### 2.3 表面头（两种版本，按 `vphysicsID` 区分）

```c
// 新版（vphysicsID = "VPHY"，即 0x59504856）
struct compactsurfaceheader_t {
    int    size;          // 0x00 本头之后的内容大小
    int    vphysicsID;    // 0x04 ASCII "VPHY"
    short  version;       // 0x08
    short  modelType;     // 0x0A 碰撞体类型（枚举需查 vphysics）
    int    surfaceSize;   // 0x0C
    Vector dragAxisAreas; // 0x10 12B
    int    axisMapSize;   // 0x1C
    // 0x20 起：axisMap… 再后是凸体数据
};

// 旧版
struct legacysurfaceheader_t {
    int   size;
    float mass_center[3];        // 0x04
    float rotation_inertia[3];   // 0x10
    float upper_limit_radius;    // 0x1C
    int   max_deviation : 8;     // 0x20
    int   byte_size     : 24;
    int   offset_ledgetree_root; // 0x24
    int   dummy[3];              // 0x28（dummy[2] = "IVPS" 或 0）
};
```

### 2.4 凸体头 `convexsolidheader_t`（16 字节，可多个）

```c
struct convexsolidheader_t {
    int   vertices_offset;  // 顶点列表位置（文档：指向"文件中的同一地址"——需确认相对基准）
    int   bone_index;       // 顶点相对该骨骼
    int   flags;
    short triangles_count;
    short reserved;         // 应为 0
};
```

### 2.5 顶点 `phyvertex_t`（16 字节，从 `vertices_offset` 连续存放）

```c
struct phyvertex_t {
    Vector3 pos;     // 相对 bone，**米制**：转 Source 单位 ×39.3701（v / 0.0254）
    float   unknown; // 常为 0
};
```

### 2.6 三角形 `triangledata_t`（位域紧凑格式，⚠️ 布局待核实）

```c
struct triangledata_t {
    unsigned int  tri_index        : 12;  // 顶点索引（低 12 位即该凸体的顶点索引）
    unsigned int  pierce_index     : 12;
    unsigned int  material_index   : 7;
    bool          is_virtual       : 1;
    // 3 组边：edgeN_start_point_index / edgeN_opposite_index:15 / edgeN_is_virtual:1
    // 对碰撞导出：只需取每组 tri_index → 3 个顶点组成三角形
    unsigned short edge1_start_point_index;
    int edge1_opposite_index : 15;
    bool edge1_is_virtual    : 1;
    unsigned short edge2_start_point_index;
    int edge2_opposite_index : 15;
    bool edge2_is_virtual    : 1;
    unsigned short edge3_start_point_index;
    int edge3_opposite_index : 15;
    bool edge3_is_virtual    : 1;
};
```

### 2.7 文本段（文件末尾，单字符串）

```
solid { "index" "0" "name" "prop_xxx.body_bone" "mass" "137.7" "surfaceprop" "concrete" … }
editparams { "rootname" "xxx.body_bone" "totalmass" "2000" }
ragdollconstraint { … }  // 仅 ragdoll 模型
break { … }              // 碎裂 gib 模型（本文档不需要）
```

**对碰撞网格最有用的字段**：`solid.index`（关联到第几个碰撞段）、`solid.surfaceprop`
（碰撞材质，可与 `Model::surface_prop()` 互证）。

---

## 3. 实现方案

### 3.1 总体架构

```
Rust（crates/wasm）
  vendor/vmdl/src/phy.rs（或 crates/wasm/src/phyfile.rs）   ← 新增：PHY 解析
    phyheader_t → 每 solid：表面头 → 凸体列表 → 顶点（米→HU）→ 三角形
    文本段 → solid.index ↔ surfaceprop 关联
  lib.rs: export_model_phy_colliders()                       ← 新增：导出方法
    输入：BSP（借用），与 export_model_tri_colliders 同生命周期
    流程：collect_pakfile_models → 提取 .phy（name.replace(".mdl",".phy")）
          → 解析 → 按 resolve_placements 搬移世界空间
    输出：与 TriMeshOut 同构的 JSON（凸包三角形网格）+ surfaceprop 标注

前端（src）
  config.ts：colliderSource: 'auto' | 'visual' | 'phy'        ← 新选项
  HTML 物理面板：#colliderSource <select>（对齐 #physicsMode 模式）
  app.ts：change 监听 → postMessage({type:'config', patch})
  physics-worker.ts：按 colliderSource 调 export_model_tri_colliders /
                     export_model_phy_colliders
  physics：凸包三角形直接复用 TriMesh[] + TriangleGrid + clipBoxToTriangle
           （box/sphere 等基础体可转 6/三角化 或走专用 clip）
  collider-debug.ts：按来源着色（visual=青 / phy=黄）
```

### 3.2 Rust 端：PHY 解析（`phyfile` 模块）

```rust
/// 解析 PHY 主头（16 字节）
struct PhyHeader { size: i32, id: i32, solid_count: i32, checksum: u32 }

/// 单 solid 的碰撞数据（凸包三角网格，模型局部空间，HU）
struct PhySolid {
    index: u32,                  // 文本段关联索引
    bone_index: i32,             // 顶点相对骨骼（STATIC_PROP 一般为 0）
    surfaceprop: Option<String>, // 来自文本段
    vertices: Vec<[f32; 3]>,     // 米 → HU（×39.3701）
    triangles: Vec<[u32; 3]>,    // triangledata_t 的 tri_index
}

fn parse_phy(data: &[u8]) -> Result<Vec<PhySolid>, PhyError> {
    // 1. 主头 → solid_count
    // 2. 循环 solid_count 次：
    //    - 读表面头，检测 vphysicsID == "VPHY" 选新/旧格式
    //    - 读凸体列表（convexsolidheader_t，直到 vertices_offset）
    //    - 从 vertices_offset 读顶点（vec4，米制 → ×39.3701）
    //    - 读 triangles_count 个 triangledata_t → 三角形
    // 3. 文本段（从末尾往前找 "solid\n{" 或按 editparams 定位）：
    //    - 解析 solid{index, surfaceprop} → 关联
}
```

**待核实实现细节**（编码前必查）：
1. `triangledata_t` 实际字节数与对齐 —— **官方开源仓库无定义（闭源 IVP，见 §1.1）**，
   优先参考 Crowbar 的 `PhyParser` / SourceIO，并用 Python 实测多个 .phy 交叉验证；
2. `vertices_offset` 相对基准（相对文件头 or 相对表面段起点）—— 用多个 .phy 实测；
3. `modelType` 枚举（判断该 solid 是凸包 mesh / box / sphere / cylinder）——
   **引擎侧未定义（vphysics 私有头）**，参考开源逆向实现；首版可只按"凸包 mesh"处理
   （surf 图 prop_static 主流），box/sphere 由 modelType 或 flags 兜底转三角化；
4. 非静态模型（骨骼非 0）需要骨骼变换 —— surf 图 prop_static 场景骨骼 0（恒等），
   与 `apply_root_transform` 一致的路径可复用。

### 3.3 Rust 端：导出方法 `export_model_phy_colliders()`

```rust
pub fn export_model_phy_colliders(&self) -> Result<String, JsValue> {
    // 1. collect_pakfile_models（与 export_model_tri_colliders 相同入口）
    // 2. 对每个 InMemoryModel：
    //    - bsp.pack.get(name.replace(".mdl", ".phy")) → 解析 PhySolid 列表
    //    - 无 .phy → 跳过（由前端 auto 模式回退可视网格）
    // 3. resolve_placements（含实体来源，若启用）→ 每实例 place_point 搬移
    //    （顶点相对骨骼 0 → 模型原点；直接复用 quat_rotate/place_point）
    // 4. 输出：与 TriMeshOut 同构 + surfaceprop 标注
    //    [{ name, surfaceprop, vertices, indices, min, max }]
}
```

护栏复用：`MAX_TRI_TOTAL`（凸包三角通常远小于可视网格，预算更宽松）。

### 3.4 前端：碰撞来源选项（对齐「物理模式」）

**config.ts**：

```ts
export interface PhysicsConfig {
  mode: 'noclip' | 'physics';
  /** 模型碰撞来源：auto=phy 优先、visual=可视网格、phy=模型自带碰撞体 */
  colliderSource: 'auto' | 'visual' | 'phy';
  // …既有字段
}
```

**HTML（物理面板，对齐 `#physicsMode`）**：

```html
<label>碰撞来源
  <select id="colliderSource">
    <option value="auto">自动（模型自带优先）</option>
    <option value="visual">可视模型网格</option>
    <option value="phy">模型自带碰撞体(.phy)</option>
  </select>
</label>
```

**app.ts**（照抄 `physicsMode` 的监听模式）：

```ts
dom.colliderSourceSelect?.addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value as 'auto' | 'visual' | 'phy';
  worker.postMessage({ type: 'config', patch: { colliderSource: v } });
});
```

**physics-worker.ts**（加载时按选项选择导出路径）：

```ts
// 模型碰撞导出（替换现有固定调 export_model_tri_colliders 的段落）
let brushJson = mapBrushJson;
let triJsonRaw: string | undefined;
const src = settings.colliderSource ?? 'auto';
try {
  if (src === 'visual') {
    triJsonRaw = processor.export_model_tri_colliders();
  } else {
    // 'auto' | 'phy'：先试模型自带碰撞，失败/为空回退可视网格
    triJsonRaw = processor.export_model_phy_colliders();
    if (src === 'auto' && (!triJsonRaw || JSON.parse(triJsonRaw).length === 0)) {
      triJsonRaw = processor.export_model_tri_colliders();
    }
  }
  this.world.triMeshes = JSON.parse(triJsonRaw);
} catch (e) {
  console.warn('[load-bsp] 模型碰撞导出失败，回退薄壳 brush:', e);
  // …既有回退到 export_model_colliders
}
```

**物理层**：`.phy` 凸包三角形与可视网格同构（`TriMesh`），直接复用
`TriangleGrid` + `clipBoxToTriangle`，零新增物理代码；box/sphere/cylinder 基础体
（若 modelType 指示）可三角化后走同一条路，或后续加专用 clip。

**可视化**：`collider-debug.ts` 的 `rebuildTriangles` 按来源分组着色
（`mesh.surfaceprop` 存在即 .phy 来源），phy 用橙色线框、visual 用紫色，
一眼区分当前用的哪种碰撞。

### 3.5 数据流总览

```
选择 colliderSource (HTML select)
   ↓ config patch
worker 加载地图
   ├─ visual → export_model_tri_colliders()  → world.triMeshes（可视网格）
   ├─ phy    → export_model_phy_colliders()  → world.triMeshes（模型自带凸包）
   └─ auto   → phy 优先，空/失败回退 visual
World.trace → TriangleGrid.query → clipBoxToTriangle（两者共用）
collider-debug：紫色=visual / 橙色=phy
```

---

## 4. 建议实施顺序

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 核实 `triangledata_t` 布局 / `vertices_offset` 基准 / `modelType` 枚举（Valve studio.h + 实测 3~5 个 surf_666 的 .phy） | Python 快速原型解析出 cow.phy、s2_pillbig.phy 的凸包三角形数与形状 |
| 2 | Rust `phyfile` 模块 + 单测 | `cargo test`；对比 Python 原型结果 |
| 3 | `export_model_phy_colliders()` + wasm 构建 | 与 `export_model_tri_colliders` 输出对比（同一模型三角数应更少） |
| 4 | 前端选项（config/HTML/app/worker）+ 可视化着色 | `tsc` + 冒烟：phy 与 visual 分别加载，斜坡都能站 |
| 5 | `auto` 回退逻辑 + 面板文案 | 实测无 .phy 的模型回退正常 |

## 5. 风险与取舍

- **`.phy` 更简化的凸包**：surf 图斜坡若作者只给了粗凸包（而可视网格更精细），切 phy 后
  玩家可能"悬空"或"卡台阶"。这就是**保留选项**的原因 —— 两种来源并存，用户按手感选择；
- **坐标/单位风险**：文档自注坐标系统可能因版本/静态与否而异，步骤 1 的实测必须覆盖
  静态与动态模型各若干；
- **非静态模型**（带骨骼）：顶点相对 bone，需要骨骼变换矩阵（vmdl 已有 bones/root_transform，
  可复用）；首版可只支持 STATIC_PROP（surf 图主场景），非静态回退可视网格；
- **体积/性能**：凸包三角通常比可视网格少一个量级（cow.phy vs cow 可视网格），
  对 `MAX_TRI_TOTAL` 预算更友好。

---

## 附：相关参考

- ✅ **已实现**：`crates/wasm/src/phyfile.rs`（PHY 解析）+ `BspProcessor::export_model_phy_colliders`（导出）
- Valve 官方 PHY 文档（格式依据）：`PHY - Valve Developer Community.mhtml`
- Valve 源码（引擎侧加载/字节交换路径，**不含 triangledata_t 等闭源布局**，见 §1.1）：
  - `common/studiobyteswap.cpp` `ByteswapPHY`（唯一展开 PHY 头部处：phyheader_t / compactsurfaceheader_t / legacysurfaceheader_t）
  - `datacache/mdlcache.cpp` `UnserializeVCollide`（.phy 加载入口）
  - `game/shared/physics_shared.cpp` `PhysModelCreate`（坐标转换与 surfaceprop 使用边界）
  - `public/phyfile.h`、`public/studio.h`、`vphysics_interface.h`（头部定义；凸体本体布局在闭源 IVP）
- 开源逆向参考（**triangledata_t / vertices_offset / modelType 的主要来源**）：
  - `tasbox-org/source-parsers` `packages/phyparser`（布局与解析逻辑权威参考，已实测验证）
  - Crowbar / SourceIO / HLLib
- DeepWiki Q&A：`source-engine-2018-hl2_src`（PHY 加载与字节交换流程梳理，用户提供）
- 本项目现状：`docs/model-export.md` §7（三种碰撞方案 + 常量 + 数据格式陷阱）
