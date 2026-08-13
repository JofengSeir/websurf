# map-min-export — 地图最小导出测试

> `test/` 合集内关于**地图最小导出**的测试功能：从 `.bsp` 导出下游（渲染/物理/材质）
> 所需的最小数据三件套，验证数据契约与端到端链路。
>
> 定位：**实验/测试工程**，非生产管线——产出明确的最小数据契约，供
> `test/extract`（解包）、`game`（渲染/物理）参考或对接。

## 目的

surf 地图（如 surf_666，79MB BSP）体积大、几何多（10 万+ 三角形）。实际运行只需要：
**看得见的几何 + 走得了的碰撞 + 贴得上的纹理**。本工程验证把这三者独立导出的最小集合：

| 产物 | 内容 | 契约 |
|---|---|---|
| `geometry.glb` | **最小可视几何** | `scene::rebuild_scene`：世界模型 + brush 实体 + displacement 地形，**已剔除** SKY/SKY2D/TRIGGER/NODRAW/HINT/SKIP 不可见面（引擎 flags）；按材质分组 + UV；Source Z-up → glTF Y-up |
| `collision.json` | **碰撞** | `WasmBrush[]`：BRUSHES/BRUSHSIDES/PLANES → 每 brush 一组半空间平面 `{normal,dist}` + 半空间交点 AABB `{min,max}` + `{is_ladder,is_solid}`——**与 game `export_brushes_planes` 的 brushJson 契约同构**（可被 `buildWorldBundle` 直接消费） |
| `materials/` + `manifest.json` | **材质纹理** | 逐材质：VMT 文本（PAKFILE）+ $basetexture → VTF → **PNG 解码**（DXT1/DXT3/DXT5/BC 解压 + RGBA8888/ABGR/ARGB/BGRA/BGRX/RGB888/BGR888/RGB565/I8/A8）；解码失败兜底保存原始 `.vtf`；manifest 记录宽高/格式/缺失备注 |

## 用法

```bash
# 构建（复用 test/extract 的 BspFile 解析层，path 依赖；首次构建会顺带编译 bsp-extract）
cargo build --release

# 导出（默认输出到 out/）
cargo run --release -- ../../maps/surf_666.bsp --out out/surf_666

# 验证产物（纯 Node，无依赖）
node scripts/verify.mjs out/surf_666
```

`manifest.json` 结构：

```jsonc
{
  "tool": "map-min-export",
  "bsp": "...surf_666.bsp",
  "bspVersion": 20,
  "geometry": { "file": "geometry.glb", "bytes": ..., "materialGroups": 66, "vertices": ..., "triangles": ... },
  "collision": { "file": "collision.json", "brushes": ..., "planes": ... },
  "materials": [
    { "name": "materials/devneons/blue_neon", "rel": "devneons/blue_neon",
      "vmt": "materials/devneons/blue_neon.vmt", "vtf": "materials/devneons/blue_neon.vtf",
      "files": ["devneons/blue_neon.vmt", "devneons/blue_neon.png"],
      "width": 512, "height": 512, "format": "DXT1", "note": null }
  ]
}
```

## 实现要点

- **几何复用**：`bsp_extract::scene::rebuild_scene` 已实现可见性过滤（flags）+ 三角化 +
  UV + 材质分组；`glb::build_glb` 零依赖写 GLB。本工程零几何重写。
- **碰撞独立解析**：BRUSHES(18)/BRUSHSIDES(19)/PLANES(1) 三 lump（BspFile::lump_data 自动
  Valve LZMA 解压）；AABB 由半空间三面求交（Cramer 法则）+ 全部平面内侧验证计算 +
  **空间哈希去重**（3×3×3 邻域，距离²<0.01——去重后的顶点数决定翻转回退触发，与 game 逐字对齐）；
  实体 brush 经 `model="*N"` + `origin`（head_node 子树遍历 LEAFBRUSHES 归属）做 dist 平移；
  **NODES/LEAFS 结构大小按 lump version 分派**（v0 = 32B Quake 风格 dleaf_t，
  `firstleafbrush` 偏移 24；v1 = 56B / v2 = 60B，偏移 12）；
  导出 = 旋转 [y,z,x] + 取负（cs-movement 朝外约定），struct 序列化输出 f32 最短十进制
  （与 game brushJson **文本级**可比）。
- **纹理链路**：材质名归一化（去 `materials/` 前缀/`.vmt` 后缀）→ PAKFILE 提取（大小写
  不敏感、`\`/`/` 兼容）→ VMT 解析 `$basetexture`（防 `$basetexturetransform` 误配）→
  VTF 头解析（v7.x，**双布局自动探测**：标准「头+低清(4B size 前缀)+缩略图目录+高清」与
  实测 CS:GO vtex 产物「头+低清(无前缀)+高清 mip 降序至 EOF、无目录」）→ BC1/BC2/BC3
  块解码 → 最小 PNG 写入器（flate2 zlib + CRC32，零图片 crate）。
- **坐标**：全链路 Source Z-up → glTF Y-up（[x,y,z]→[y,z,x]，det=+1）。

## 验证

`scripts/verify.mjs`（纯 Node 内置模块）逐项校验：

- GLB：magic/version/totalLen、JSON chunk 三角形数 > 0、材质分组数
- collision.json：数组、每项 planes ≥ 4 且 `{normal[3],dist}` 合法、min ≤ max、布尔标志
- materials/：VMT 落盘或注明缺失；PNG 魔数 + IHDR 宽高与 manifest 一致
- 交叉校验：GLB 实际三角形数 == manifest.geometry.triangles

## 测试记录

| 地图 | 几何（三角形/顶点/材质组） | 碰撞（brush/平面） | 材质（PNG/缺失） | 验证 |
|---|---|---|---|---|
| `maps/surf_666.bsp`（v20，79MB） | 107617 / 322851 / 3481（**与 extract 参考导出完全一致**） | 7729 / 64770（7730 全部触发法线翻转回退；含实体 brush origin 平移；7294 solid / 216 ladder） | 26 / 40（缺失为默认/外部 vpk 材质） | **18/18 PASS** |
| `maps/ze_cursed_bear_tales_v1_2.bsp`（v21，151MB） | 267777 / 803331 / 8079（**与 extract 参考导出完全一致**） | 5123 / 49869（5123 全部触发法线翻转回退；退化 0） | 73 / 98（IA88 格式已支持，零解码失败） | **18/18 PASS** |

> 两张图（v20/v21）的 brush 平面均存储为「法线朝外」约定 → 原始约定下 `compute_vertices`
> 无顶点，**法线翻转回退是主路径**（与 game 的 fallback 语义一致，导出的仍是 cs-movement
> 朝外契约）。PNG 内容抽查：CREDITS 纹理 962 色组 + 26% 透明、砖墙 260 色组——真实纹理非垃圾数据。

### 与 game 契约交叉验证（2026-08-13 审查）

用 game 的 wasm `export_brushes_planes`（同图、无过滤配置）对拍：

| 项 | 结果 |
|---|---|
| **GLB 几何** | 与 extract wasm `bsp_to_glb` 输出**逐字节一致**（仅 mesh 名 `min` vs `bsp` 6 字节差异——场景标注） |
| **碰撞 f32 数值**（f32 round-trip 签名，含平面顺序） | surf_666：**7053/7065 = 99.8%** 逐项全等（剩余 12 个为 f32 ULP 内尾数 + 1 个边角） |
| **碰撞文本级**（JSON 全等） | surf_666：94.6%（余差为 <0.01 HU 浮点尾数，对碰撞无影响） |
| 数量差（mine 7729 vs game 7065） | 策略差异：mine **全量导出**（含 trigger/非 solid 实体 brush），game 过滤 665 个（`entity_is_non_solid`）；ze 无法对拍（game wasm 仅支持 v20） |

> 对拍结论：**碰撞数据契约与 game brushJson 一致**（数值同构、文本同格式、坐标同约定）；
> 剩余差异全部为设计性策略（全量 vs 过滤）或 f32 ULP 级浮点尾数。

## 边界与已知限制

- VTF 解码支持 CS:GO 常见格式（DXT1/DXT3/DXT5 + 常见未压缩）；罕见格式（RGBA16161616F、
  UV88 等）返回备注并兜底存 `.vtf` 原样
- 碰撞仅 brush（世界模型 + brush 实体共用 BRUSHES lump）；模型（MDL/static_prop）三角
  碰撞不在本测试范围（属 game 的 export_model_tri_colliders）
- VMT 若缺失 `$basetexture`（如纯 color 材质），回退取同名 `.vtf`
- 不产出光照贴图（lightmap）；不含 PAKFILE 模型几何
