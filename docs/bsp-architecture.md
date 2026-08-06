# BSP 地图架构（Source 引擎 v20 格式解析）

> 压缩自 `docs/bsp-format.md`，已对照 `crates/wasm/src/vbsp/` 代码核实（2026-08-06）。
> 本文讲「BSP 文件本身长什么样」；项目实际导出消费见 `docs/bsp-export-status.md`。

---

## 1. 文件总体结构

```
dheader_t（1036 字节）
  ├─ ident "VBSP" (4B) + version (4B，19-21，CS:S 用 20)
  ├─ lumps[64]：lump_t × 64（每个 16B：offset / length / version / fourCC）
  └─ mapRevision (4B)
lump 数据区（偏移由 lumps[i].offset 指向，顺序任意）
```

- `lump_t.fourCC == 'LZMA'`（CS:GO+）→ 数据区前跟 `lzma_header_t`
  （`id` + 解压后大小 + 压缩大小 + 5 字节属性，共 13B 头），需解压后按版本解析；
  `XzipPakFile`（#57）为整包 LZMA 压缩的 ZIP。
- 全部小端、C 风格结构；`Vector = {float x,y,z}`，BSP 原始坐标系为 **Z-up**。

## 2. 64 个 lump 编号速查

| # | 名称 | # | 名称 | # | 名称 | # | 名称 |
|---|---|---|---|---|---|---|---|
| 0 | Entities | 16 | LeafFaces | 32 | DispLightmapAlphas | 48 | DisplacementTriangles |
| 1 | Planes | 17 | LeafBrushes | 33 | DisplacementVertices | 49 | PhysCollideSurface |
| 2 | TextureData | 18 | Brushes | 34 | DispLightmapSamplePos | 50 | WaterOverlays |
| 3 | Vertices | 19 | BrushSides | 35 | GameLump | 51 | LightmapPages |
| 4 | Visibility | 20 | Areas | 36 | LeafWaterData | 52 | LightmapPageInfos |
| 5 | Nodes | 21 | AreaPortals | 37 | Primitives | 53 | LightingHdr |
| 6 | TextureInfo | 22 | Portals / PropCollision | 38 | PrimitiveVertices | 54 | WorldLightsHdr |
| 7 | Faces | 23 | Clusters / PropHulls | 39 | PrimitiveIndices | 55 | LeafAmbientLightingHdr |
| 8 | Lighting | 24 | PortalVertices / PropHullVerts | 40 | **PakFile** | 56 | LeafAmbientLighting |
| 9 | Occlusion | 25 | ClusterPortals / PropTris | 41 | ClipPortalVertices | 57 | XzipPakFile |
| 10 | Leaves | 26 | DisplacementInfo | 42 | Cubemaps | 58 | FacesHdr |
| 11 | FaceIds | 27 | OriginalFaces | 43 | TextureDataStringData | 59 | MapFlags |
| 12 | Edges | 28 | PhysDisplacements | 44 | TextureDataStringTable | 60 | OverlayFades |
| 13 | SurfaceEdges | 29 | PhysCollide | 45 | Overlays | 61 | OverlaySystemLevels |
| 14 | Models | 30 | VertexNormals | 46 | LeafMinDistanceToWater | 62 | PhysLevel |
| 15 | WorldLights | 31 | VertexNormalIndices | 47 | FaceMacroTextureInfo | 63 | DisplacementMultiblend |

> #22-25 为 Portal/Prop 分区的重名 alias，按游戏/引擎版本解释。

## 3. 核心 lump 二进制布局

### 3.1 Entities（#0）
连续 NUL 结尾文本块：`{ "classname" "worldspawn" "origin" "0 0 0" ... }`，每实体一对花括号。

### 3.2 Planes（#1）
```c
struct dplane_t { Vector normal; float dist; int type; };  // 20B
```

### 3.3 纹理系（#2/#6/#43/#44）
- `dtexdata_t`（32B）：reflectivity + `nameStringTableID`（→ StringTable → StringData 材质路径）+ 宽高（width/height/view_width/view_height）；
- `texinfo_t`（72B）：贴图 s/t 基向量 `textureVecs[2]`（Vector4×2）+ 光照基向量 `lightmapVecs[2]` + `flags`（SURF_*）+ `texdata` 索引；
- `TextureDataStringTable` = int32 偏移数组 → `TextureDataStringData` 连续字符串；
- 完整 `SURF_*` 标志：`LIGHT 0x1 / SKY2D 0x2 / SKY 0x4 / WARP 0x8 / TRANSPARENT 0x10 /
  NOPORTAL 0x20 / TRIGGER 0x40 / NODRAW 0x80 / HINT 0x100 / SKIP 0x200 / NOLIGHT 0x400 /
  BUMPLIGHT 0x800 / NOSHADOWS 0x1000 / NODECALS 0x2000 / NOCHOP 0x4000 / HITBOX 0x8000`。

### 3.4 面几何（#3/#12/#13）
- `dvertex_t`（12B）xyz；`dedge_t`（4B）两个 u16 顶点索引；
- `dsurfedge_t`（4B）int：≥0 正向取 Edges[edge]，<0 反向（取反后边索引）。

### 3.5 Visibility（#4）— PVS 位图
`dvis_t{ int numclusters; int byteofs[numclusters]; }`，之后每 cluster 一段位图
（bit = 可见 cluster，字节数 = ceil(n/8)）。

### 3.6 BSP 树（#5/#10）
```c
struct dnode_t {  // 24B
    int planenum; short children[2];   // ≥0=node，<0=leaf（~index）
    short mins[3], maxs[3]; unsigned short firstface, numfaces; short area;
};
struct dleaf_t {  // 56B（v19+）
    int contents;        // CONTENTS_*；-1 = 固体 leaf
    short cluster, area, flags;
    short mins[3], maxs[3];
    unsigned short firstleafface, numleaffaces, firstleafbrush, numleafbrushes;
    short leafWaterDataID;
};
```

### 3.7 Faces（#7/#27）
`dface_t`（56B，v19+ 含 smoothingGroups）：planenum / side（1=平面翻转）/ onnode /
firstedge+numedges（→SurfaceEdges 逐边展开顶点）/ texinfo（-1 无材质）/
dispinfo（-1 普通面）/ surfaceFogVolumeID / styles[4] / lightofs（→Lighting）/ area /
lightmaptexturemins[2] / lightmaptexturesizeinluxels[2] / origFace / numPrims / firstPrimID。

### 3.8 Models（#14）— 子模型
`dmodel_t`（40B）：mins/maxs/origin/headnode/firstface+numfaces。
`models[0]` = world；实体 brush 模型由实体 `"model" "*N"` 引用 `models[N]`。

### 3.9 碰撞 brush（#18/#19）
```c
struct dbrush_t { int firstside, numsides, contents; };            // 12B
struct dbrushside_t { unsigned short planenum; short texinfo, dispinfo, bevel; };  // 8B
```
contents 含 SOLID/WINDOW/GRATE/LADDER 等 CONTENTS_* 标志。

### 3.10 位移地形（#26/#33/#48）
`ddispinfo_t`（176B）：startPosition / dispVertStart / dispTriStart / power（2-4 →
网格 (2^power+1)²）/ minTess / smoothingAngle / contents / mapFace +
edgeNeighbours[4]（每边 2 子邻接）/ cornerNeighbours[4] / allowedVerts[10]；
`ddispvert_t`（20B）= vec + dist + alpha；`ddisptri_t` = 3×u16 顶点索引（#48 为新版位置）。

### 3.10a Areas / AreaPortals（#20/#21）
`darea_t{ int numareaportals, firstareaportal }`；
`dareaportal_t{ unsigned short portalnum, otherarea }`。

### 3.10b LeafFaces / LeafBrushes（#16/#17）
`unsigned short[]`：leaf 的面/brush 索引表，配合 `dleaf_t.firstleafface/numleaffaces`
（及 brush 同名字段）使用。

### 3.10c Lighting / Cubemaps / Overlays / Primitives（#8/#42/#45/#37-39）
- `Lighting`：RGBExp32 光照样本（`{r,g,b,exponent}`），由 face 的 `lightofs` 索引；
- `Cubemaps`：`dcubemapsample_t`（origin + size）；
- `Overlays`：覆盖贴花（材质 + UV + 顶点列表）；
- `Primitives`/`PrimitiveVertices`/`PrimitiveIndices`：新版贴花几何（CS:GO）。

### 3.11 GameLump（#35）— StaticProps
`gamedlumpheader_t{id FourCC, flags(bit0=LZMA), version, fileofs, filelen}`，关键子区 **"sprp"**：
- `static_prop_dict_t`：`char name[128]` 模型路径表；
- `static_prop_t`（V4→V13+ 逐版追加字段）：origin / angles(pitch,yaw,roll) / propType /
  firstLeaf+leafCount / **solid（0=SOLID_NONE 无碰撞）** / flags（STATIC_PROP_*）/ skin /
  fadeMinDist+fadeMaxDist / lightingOrigin；
  版本追加：V5+ flForcedFadeScale、V6+ min/maxDXLevel、V7+ lightingOriginHDR、后续 disableX360 等。

### 3.12 PakFile（#40/#57）
标准 ZIP（`PK\x03\x04`），内嵌地图引用的模型/纹理/脚本；#57 XzipPakFile = 整包 LZMA 的 ZIP。

### 3.13 内嵌物理（#28/#29，扩展点）
`PhysCollide` = 每个 brush 子模型一条 `physmodelheader_t` + **内嵌 .phy 字节**
（与外部 `.phy` 文件同格式）。

## 4. websurf 覆盖矩阵（对照 `vbsp/mod.rs` 核实）

| 分类 | 已解析 ✅ | 未解析 ❌（扩展点） |
|---|---|---|
| 实体/几何 | Entities、Planes、Vertices、Edges、SurfaceEdges、Faces、OriginalFaces、Models、TextureData/Info/String* | — |
| 树/PVS | Nodes、Leaves、Visibility、LeafFaces、LeafBrushes | Occlusion(9)、Areas/Portals(20-25) |
| 碰撞 | Brushes、BrushSides | PhysDisplacements(28)、**PhysCollide(29)** |
| 地形 | DisplacementInfo、DisplacementVertices | DispLightmap*(32/34) |
| 资源 | GameLump(头/sprp)、PakFile | XzipPakFile(57) |
| 光照/贴花 | （读入未用：VertexNormals 30/31） | Lighting(8)、WorldLights(15)、Cubemaps(42)、Overlays(45)、Primitives(37-39)、HDR 系(51-56) |

**统计：解析 21 个核心 lump**；未利用的主要是光照系、Portal 系、内嵌物理、贴花系、CS:GO 新增。

## 5. 版本差异要点

1. lump #22-25 / #49 / #51-52 有版本别名，须按 BSP version + 游戏判断；
2. CS:GO+ 的 LZMA 压缩 lump 与 XzipPakFile；
3. StaticProp V4→V13+ 字段递增，须按 GameLump version 分支（vbsp 已处理常见版本）；
4. v19 起 `dface_t` 固定 56B；`DisplacementTriangles`(#48) 为新版位移三角索引位置。

## 6. 参考

- TAServers/source-parsers `packages/bspparser`（结构定义来源）
- Valve Developer Community《BSP (Source)》
- 本项目 `crates/wasm/src/vbsp/`（含 Leaves 排序修复、LZMA 支持）；实测 `maps/surf_666.bsp`（CS:S v20）
