# CSGO BSP 解包机制分析 + Rust/WASM 移植可行性报告

> 分析对象:VPKEdit(shell)+ sourcepp(核心库,bsppp 模块)
> 结论日期:2026-08-12
> 最后核对:2026-08-13
> 分析方法:Three Minds 三人协作(架构师 / 工程师 / 审核员)达成共识
>
> **修订(2026-08-13)**:本文 §4 的"移植方案"当时是可行性提案。实际实现
> (提交 f3662c8 + 647ff07)走了不同路径——**落地为独立 `test/extract/` crate(bsp-extract)**,
> 未按提案在 game/crates/wasm 上加 4 个 API、未新建 /extract 面板。详见 §1/§4/§5 修订注
> 与 `test/extract/README.md`。（注:2026-08-13 仓库重组后 `extract/` 位于 `test/extract/`；
> **2026-08-14 bsp-extract 已移除**,其 CS:GO 版 BSP 解析逻辑以最小实现并入
> `test/map-min-export/` 自包含 lib——本文历史引用仅作记录。）

---

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| VPKEdit 如何解包 CSGO BSP? | 把 BSP 当"VBSP 头 + 64 个 lump 目录 + 内嵌 zip(PAKFILE lump)"处理,先切 lump 再解 LZMA,PAKFILE 原样是 zip |
| 能否转为 Rust 实现? | **已实现**。独立 `test/extract/` crate(bsp-extract)已完整落地(CLI + wasm + 网页),见 `test/extract/README.md` |
| 移植成本 | 实际为**独立 crate**(非"约 300 行小改"):`test/extract/` 自带独立 workspace,不依赖 websurf-wasm-core |
| 网页 wasm 场景重建? | **已实现为独立 `test/extract/` crate + `test/extract/web/` 网页**,非原提案的 game/crates/wasm 4 API + /extract 面板 |

---

## 2. VPKEdit 解包机制(架构师分析)

### 2.1 总体调用链

```
CLI extract() → PackFile::open(path)
  → (按 .bsp 扩展名路由) PakLump::open(path)
      → bsppp::BSP reader(path)          # 解析 VBSP 头
      → reader.getLumpData(PAKFILE)      # 按 lump[40].offset/length 切字节
      → 若 uncompressedLength>0 → Valve LZMA 解压
      → 把 PAKFILE 字节写盘为 <tmp>.zip
      → openZIP(<tmp>.zip)               # miniz 打开,当普通 zip 遍历
      → entries 表:路径/长度/crc/压缩方法
CLI extractAll/extractDirectory/extractEntry 从内存 zip 解出文件写盘
```

### 2.2 BSP 文件格式要点

- **Header 布局**:`"VBSP"`(4B)+ version(u32)+ 64×16B lump 目录 + mapRevision(u32)
- **lump 目录项 16B**:`offset(u32) + length(u32) + version(u32) + uncompressedLength(u32)`;
  `uncompressedLength > 0` 即表示该 lump 被 LZMA 压缩
- **v19/v20/v21**:仅版本号不同,布局一致;v21 ≈ CSGO/L4D2/Portal2
- **L4D2 特例**:lump 目录字段错位,用启发式判断——64 项 offset 全部 ≤1024 则判定 L4D2,交换 offset/length/version 字段
- **console 变体**:签名 `"PSBV"`(大端),整文件按大端解析
- **结构版本升级**:FACES v1→v2、EDGES v0→v1、NODES v0→v1 有 `upgrade()` 路径

### 2.3 CSGO 关键点

- **PAKFILE(lump 40)本身就是一段完整、合法的 zip**——拿到 offset/length 直接切片即得 zip,无需组装
- 引擎写 PAKFILE 时**不套 LZMA**(zip 内 deflate 负责压缩),故 `setLump(PAKFILE)` 强制 `compressLevel=0`
- 通常被 LZMA 压缩的 lump:VISIBILITY、LIGHTING、TEXDATA、BRUSHSIDES 等大静态数据

### 2.4 Valve LZMA 格式(17B 头)

| 字段 | 大小 | 说明 |
|---|---|---|
| `"LZMA"` | 4B | 固定签名 |
| uncompressedLength | 4B | 解压后字节数 |
| compressedLength | 4B | 压缩段长度(可跳过) |
| props(属性字节) | 1B | lc/lp/pb |
| dictionarySize | 4B | 字典大小 |

之后是 LZMA 原始压缩流。与标准 `lzma_alone`(13B 头 = props 1B + dict 4B + 解压长度 u64 8B)转换:
**解压**时跳过签名,重写 `props + dictSize + u64 解压长度` 为 alone 头,喂给 `lzma_alone_decoder`。

### 2.5 实体解析(ENTITIES, lump 0)

纯文本 `{ "key" "value" ... }` 块,每实体一个 `{ }`,支持 `//` 单行注释。
转义开关由 lump version 决定(v0 无转义、v1 启用)。

### 2.6 Game Lump 结构(GAME_LUMP, lump 35)

u32 条目数 + 每项 16B 头(`signature 4B + isCompressed u16 + version u16 + offset u32 + uncompressedLength u32`)+ 数据区。
任一子 lump 压缩时,表尾追加空头(signature=0),用 `next.offset - cur.offset` 推算压缩大小。
常见签名:`sprp`=静态模型、`dprp`=detail props、`dplt`/`dplh`=LDR/HDR 光照。

---

## 3. Rust 移植差距分析(工程师分析)

### 3.1 差距清单

| 能力 | sourcepp | websurf 现状 | 判定 |
|---|---|---|---|
| BSP 版本 | v19/v20/v21/v27 + console | 仅 v20(`src/wasm-core/vbsp/bspfile.rs:21` 硬编码 `0x14`) | **缺失,小改** |
| Valve LZMA 解压 | liblzma | lzma-rs `lzma_decompress_with_options` | **已有,等价** |
| PAKFILE 提取 | miniz | `zip-lzma` 的 `ZipArchive` | **已有** |
| 实体解析 | 结构化 KV + 转义 | 仅整段 UTF-8 文本 | **部分** |
| game lump | 多 lump + per-lump 压缩 | `GameLumpHeader::find` 完整实现 | **已有** |
| static props | 多版本 | v6/v7/v10 | **已有** |
| L4D2 v21 布局 | 检测 + swap 字段 | 无 | **缺失,小改** |
| console 大端 | 支持 | 无(结构改动大) | **不建议做** |

### 3.2 移植结论

**已具备(零改动)**:v20 header/lump 全量读取、Valve LZMA、PAK zip 提取、static props v6/7/10、leaves 32/56B 自适应、PVS 解码。

**小改即可(约 300 行)**:
1. 版本分派——`BspFile::new` 读 version 后改 `match`,删除 `EXPECTED_VERSION` 硬编码
2. 实体 KV——新增 `parse_entities()` 结构化解析(移除 `to_ascii_lowercase()` 有损转换)
3. 结构体版本适配——Faces v1/v2、Nodes v0/v1 按 `LumpReader::version()` 分派
4. L4D2 swap——`BspFile` 增 `l4d2: bool`,标准化 lump 字段顺序(约 30 行)

**需要重写(不建议)**:console 大端(binrw 字节序贯通,结构性改动),除非目标含主机版地图。

### 3.3 wasm32 目标风险

- lzma-rs / binrw / bitflags:纯 Rust,无 C 依赖,wasm32 无问题
- **zip-lzma 的 deflate 后端需确认**:BSP pak 条目以 deflate 为主,要启用纯 Rust 后端(`miniz_oxide`),避开 C zlib
- lzma-rs 性能弱于 liblzma,大 lump 解压建议放 web worker,且 `memlimit` 需加 cap 防恶意地图

---

## 4. 网页 wasm 解包 + 场景重建方案(审核员审核)

> **修订(2026-08-13)**:本节是 2026-08-12 的可行性提案。实际实现(f3662c8 + 647ff07)
> 未按此提案执行——**未**在 game/crates/wasm 上加 4 个 API、**未**新建 /extract 面板;
> 而是创建了**独立 `test/extract/` crate(bsp-extract)**:独立 workspace、不依赖 websurf-wasm-core,
> 模块 bsp/lzma/pak/scene/glb/wasm,CLI(info/entities/pak list/pak get/pak extract/glb),
> wasm API(bsp_to_glb/bsp_info)+ 最小网页(test/extract/web/)。以下提案内容仅作历史参考。

### 4.1 方案定位:与现有能力互补

| 维度 | 现有 game 面板 | 新建解包器面板 `/extract` |
|---|---|---|
| 粒度 | 场景级(BSP→GLB→three.js) | 素材级(PAK 内单文件浏览/导出) |
| 覆盖 | 几何 + static_props + 材质贴图整合 | 任意扩展文件:VMT/音频/脚本/未引用素材 |

**底层几乎零新增解析代码**:`collect_pakfile_models`(game lib.rs:55)已实现枚举 PAK 全部条目、按路径取字节、VTF→PNG、VMT 解析;`PakIndex` 已做大小写不敏感 + 前缀补全匹配。缺的只是**显式暴露为独立 wasm API**。

### 4.2 新面板建议

**形态**:新增独立 `/extract` 面板(参照 /debug 独立入口),复用同一 wasm crate(game/crates/wasm),不新 crate、不新构建脚本。

**UI 结构**(复用 game 的 Fluent 深色变量体系):
- 顶部工具条:加载 BSP、搜索过滤框、全部导出(zip)
- 左:文件树(按 `/` 目录分组,懒渲染 + 折叠)
- 右:预览区(文本/VMT 高亮、VTF 图片、音频降级下载)+ 导出按钮

**wasm API 设计**(BspProcessor 加 4 个方法):
1. `pak_entries() -> JSON` — 路径/大小/压缩标志,懒索引不读内容
2. `pak_extract(index) -> Vec<u8>` — 按索引取单文件字节
3. `pak_preview_vtf(index) -> Vec<u8>(PNG)` — 内部走现有 `decode_vtf_to_png`
4. `entities_json()` — 实体列表

### 4.3 技术风险清单

1. **大文件传输**:`BspProcessor::new(data: &[u8])` 是拷贝语义,500MB 会 JS heap + wasm 内存双倍。规避:worker 内一次读入、解析后由 worker 持有实例
2. **内存回收**:wasm 线性内存只增不减,**必须提供显式 `free()` 或"重建 worker 即释放"机制**
3. **路径处理**:zip `by_name` 大小写敏感、`\`/`/` 不归一——**必须复用 `PakIndex` 匹配逻辑**;导出文件名防路径注入
4. **VTF 预览**:PAK 内 VTF 往往不全,大量素材在外部 vpk,预览缺失需 UI 标注
5. **单线程阻塞**:解析必须放 worker(项目已有 worker.js + COOP/COEP/SAB)
6. **版本硬编码**:解包器范围锁定 CS:GO/Source1(v20 兼容已好)
7. **契约检查**:新增 wasm 导出必须同步更新 build-dist.cmd 的 check-wasm-api.mjs
8. **多文件导出**:用 fflate 前端打包 zip 下载

---

## 5. 共识结论

1. **VPKEdit 解包 = "VBSP 切片器 + zip 适配器"**:bsppp::BSP 解析 header/定位/解压任意 lump,bsppp::PakLump 把 PAKFILE 切出来当 zip 打开
2. **Rust 移植成本小**:websurf 已有等价核心(header/lump/LZMA/PAK/static props),缺口仅版本分派、L4D2、实体 KV,约 300 行小改
3. **网页场景重建已实现(路径与提案不同)**:落地为**独立 `test/extract/` crate(bsp-extract)**——独立 workspace、不依赖 websurf-wasm-core;模块 bsp/lzma/pak/scene/glb/wasm;CLI(info/entities/pak list/pak get/pak extract/glb)+ wasm API(bsp_to_glb/bsp_info)+ 最小网页(test/extract/web/)。非原提案的"game 面板 4 API"(见 test/extract/README.md)
4. **内存是第一风险**:worker 内加载持有、按需取文件、显式释放/重建 worker 回收
5. **范围锁定**:只做"读 + 预览 + 导出",不做写入/编辑;版本锁 Source1/v20+

---

## 附:参考文件索引

| 文件 | 说明 |
|---|---|
| `.tmp/VPKEdit-main/src/cli/Main.cpp` | CLI 入口,extract 调用链 |
| `.tmp/VPKEdit-main/src/gui/Window.cpp` | GUI 入口,`using BSP = bsppp::PakLump` |
| `.tmp/sourcepp/include/bsppp/BSP.h` | BSP 类、64 lump 枚举、Header/Lump 结构 |
| `.tmp/sourcepp/src/bsppp/BSP.cpp` | readHeader / getLumpData / parseEntities / parseGameLumps / bake |
| `.tmp/sourcepp/src/bsppp/PakLump.cpp` | PAKFILE 提取为 zip 的核心 |
| `.tmp/sourcepp/include/bsppp/LumpData.h` | 全部 POD 结构体定义 |
| `.tmp/sourcepp/src/sourcepp/compression/LZMA.cpp` | Valve LZMA 格式转换 |
| `src/wasm-core/vbsp/bspfile.rs` | websurf 现有 BSP 解析(BspFile) |
| `src/wasm-core/vbsp/mod.rs` | websurf 现有 Bsp::read 全流程 + lzma 解压 |
| `src/wasm-core/vbsp/reader.rs` | LumpReader(实体/固定条目读取) |
| `src/wasm-core/vbsp/data/mod.rs` | Packfile(zip 提取)等数据结构 |
| `game/crates/wasm/src/lib.rs` | wasm-bindgen 导出层(parse_bsp / BspProcessor) |
