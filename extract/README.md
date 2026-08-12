# bsp-extract

独立实现的 **Source 1 (CS:GO) BSP 解包器**——Rust 版,功能对齐 VPKEdit/sourcepp 的 `bsppp` 模块。

> 本 crate **完全独立**于仓库其他工程(不依赖 `websurf-wasm-core`、不修改任何外部文件),
> 全部依赖为纯 Rust crate,可编译到 `wasm32-unknown-unknown`。

## 背景

VPKEdit 解包 CS:GO BSP 的本质是:**VBSP 切片器 + zip 适配器**:

```
VBSP 头(签名 + 版本 + 64×16B lump 目录 + mapRevision)
        │
        ├─ lump 目录项:offset / length / version / uncompressedLength
        │               └─ uncompressedLength>0 ⇒ 该 lump 被 Valve LZMA 压缩
        │
        └─ lump[40] PAKFILE = 一段完整合法的 zip → 直接切片打开
```

- **Valve LZMA 头(17B)**:`"LZMA" + 解压长度(u32) + 压缩长度(u32) + props(1B) + dictSize(u32)`,
  数据段即标准 LZMA alone 流,剥头重写后交给 `lzma-rs` 解压。
- **PAKFILE(lump 40)**:CS:GO 引擎写入时不套 LZMA,zip 内 deflate 负责压缩。

## 模块

| 模块 | 说明 |
|---|---|
| `bsp.rs` | VBSP 头解析、64 lump 目录、版本分派、lump 切片/越界防护 |
| `lzma.rs` | Valve LZMA 17B 头格式解压(转 alone 流) |
| `pak.rs` | PAKFILE zip 枚举/提取(大小写不敏感、`\`/`/` 兼容)、实体 KV 文本解析 |
| `scene.rs` | 场景几何重建:面→三角形(扇形三角化)+ UV + 坐标映射 + 材质名分组 |
| `glb.rs` | glTF 2.0 二进制(GLB)写入器,零依赖手写实现 |
| `wasm.rs` | wasm-bindgen 导出层(`--features wasm`):`bsp_to_glb` / `bsp_info` |
| `lib.rs` | `BspFile` 高层 API(持有字节,按需解压/打开 zip/解析实体) |
| `main.rs` | CLI:`info` / `entities` / `pak list` / `pak get` / `pak extract` / `glb` |
| `web/` | 最小网页:拖入/选择 `.bsp` → wasm 解析显示信息 → 下载 GLB |

## 用法

```bash
# 显示 BSP 头 + lump 目录
bsp-extract info maps/surf_666.bsp

# 解析实体 KV
bsp-extract entities maps/surf_666.bsp

# 列出 PAKFILE 全部条目
bsp-extract pak list maps/surf_666.bsp

# 按路径提取单个文件(输出原始字节到 stdout)
bsp-extract pak get maps/surf_666.bsp "materials/devneons/blue_neon.vmt"

# 全量解包到目录(自动防路径穿越)
bsp-extract pak extract maps/surf_666.bsp ./out

# 重建 BSP 场景并导出 GLB(含材质分组与 UV)
bsp-extract glb maps/ze_cursed_bear_tales_v1_2.bsp maps/ze_cursed_bear_tales_v1_2.glb
```

## 库用法

```rust
use bsp_extract::BspFile;

let bsp = BspFile::from_path("maps/surf_666.bsp")?;

// 任意 lump(自动 Valve LZMA 解压)
let vis = bsp.lump_data(bsp_extract::lumps::VISIBILITY, false)?;

// PAKFILE 条目列表 / 按路径提取(大小写不敏感)
for entry in bsp.pak_entries()? { println!("{} ({}B)", entry.name, entry.size); }
let vmt = bsp.pak_extract("materials/devneons/blue_neon.vmt")?;

// 实体
for ent in bsp.entities()? {
    println!("{:?}", ent.get("classname"));
}
```

## 网页(最小导入导出)

```bash
# 1. 构建 wasm 产物到 pkg/(cargo + wasm-bindgen CLI,见 build-wasm.cmd)
build-wasm.cmd

# 2. 启动本地服务器(COOP/COEP 头,wasm 必需)
python serve.py          # http://localhost:8280/web/

# 3. Node 端到端验证(无需浏览器)
node test-wasm.mjs [bsp路径]   # bsp_info + bsp_to_glb + GLB 头校验
```

网页功能:拖入/选择 `.bsp` → wasm 解析显示元数据(版本/lump/实体/PAK/几何)→ 导出 GLB 下载。
wasm API:`bsp_to_glb(bytes) -> Uint8Array`、`bsp_info(bytes) -> JSON string`。

## 构建与测试

```bash
cargo build                 # 原生
cargo build --release
cargo build --target wasm32-unknown-unknown   # 纯 Rust 依赖,零障碍
cargo test                  # 单元 + 合成 BSP 全链路集成
cargo clippy --all-targets  # 零警告
```

## 测试覆盖

- 单元:头解析(签名/版本/越界)、Valve LZMA roundtrip(含空数据/坏签名/过短)、
  实体解析(注释/转义/NUL 结尾)、zip 大小写不敏感提取、路径穿越防护
- 集成:`tests/integration.rs` 合成完整 BSP(头 + LZMA 压缩 lump + 内嵌 zip + NUL 结尾实体),
  走 `BspFile` 全链路验证
- 真实地图冒烟:`maps/surf_666.bsp`(v20,79MB)— 解析 60+ lump、2700 实体、
  PAKFILE 1500 个文件列表 + 全量解包 30MB,内容校验通过
- GLB 导出冒烟(three.js GLTFLoader 实测可加载):
  - `maps/ze_cursed_bear_tales_v1_2.bsp`(v21 CS:GO,151MB)→ 6421 材质组、48769 三角形、133 材质,bbox ≈ 320×90×300
  - `maps/surf_666.bsp`(v20)→ 3436 材质组、89057 三角形、60 材质
- wasm 端到端(`node test-wasm.mjs`):wasm 产出 GLB 字节数与 CLI 完全一致
  (ze:6991960B / surf_666:8279180B),GLB 头校验通过

## 已知限制

- 仅 Source 1 家族(v19~v29);console 大端变体(`PSBV`)不支持
- L4D2 的 lump 字段错位布局未做启发式 swap(当前只覆盖标准 CS:GO 布局)
- 只做"读 + 提取 + 几何导出",不含 PAKFILE 写入/重打包(那是 VPKEdit `bake` 的范围)
- GLB 导出暂不含:displacement 地形(disp_info>=0 的面跳过)、光照贴图、纹理贴图(仅材质名分组)
