# WebSurf 代码审查修复总结

- 修复日期：2026-08-13
- 修复者：独立修复工程师（全权修复权行使）
- 审查报告：`.code-review/report.md`（未改动）
- 结论：报告 21 条意见（H1、M1-M5、L1-L9、I1-I8）**全部经代码事实核验属实**，无打回；已修复 20 条，延期 1 条（I7）。

## 处理总览

| ID | 结论 |
|---|---|
| H1 | 已修复：dual-mode-harness 对 ts-shared 的 5 处导入路径加深一级，tsc 通过 |
| M1 | 已修复：删除「无 MODELS lump」退化路径的错误覆盖逻辑，空场景导出问题消除 |
| M2 | 已修复：raw_lump 用 checked_add 防 wasm32 加法环绕 |
| M3 | 已修复：displacement power 范围校验（0..=6） |
| M4 | 已修复：start_position/角点非有限值防护 + total_cmp 替代 unwrap |
| M5 | 已修复：face.first_edge/num_edges 先验负值 + checked_add；连带加固 MODELS 区间 i32 溢出 |
| L1 | 已修复：lzma 声明长度上限 + LimitedWriter 对流膨胀封顶 |
| L2 | 已修复：pak_extract 与 CLI pak extract 的单条目/累计解压上限 |
| L3 | 已修复：VTF 宽高上限 4096 校验 |
| L4 | 已修复：game/README.md、CHANGELOG.md 旧路径更新 |
| L5 | 已修复：architecture.md「不消费 ts-shared」改为消费 trace 公共模块 |
| L6 | 已修复：test-wasm.mjs 默认路径改为脚本相对 URL |
| L7 | 已修复：verify.mjs 两个恒真校验改为真实结构校验 + 新增 collision 交叉校验 |
| L8 | 已修复：serve.py 绑定 127.0.0.1 |
| L9 | 已修复：viewer ensureWasm 共享 Promise + 失败复位重试 |
| I1 | 已修复：bsp_info 新增 pakError 字段，不再吞错 |
| I2 | 已修复：bbox 空顶点集/非有限值返回 None，accessor 不再输出非法 min/max |
| I3 | 已修复：pak.rs 注释「保留顺序」改为「按 key 字典序」 |
| I4 | 已修复：scene.rs parse_faces 注释「按 56 尝试」改为「直接报错拒绝」 |
| I5 | 已修复：删除根目录 extract/ 下 394MB 陈旧构建产物（空目录壳被外部进程占用暂无法移除，git 不跟踪空目录） |
| I6 | 已修复：extract README 声明 MSRV Rust ≥ 1.87 |
| I7 | 延期：主线程同步解析为 UX 增强而非缺陷，Worker 化重构风险大，见下 |
| I8 | 已修复：extract README 与 glb.rs 注释补充「Y+90° 与 [y,z,x] 映射组合为 (x,z,-y)」 |

## 已修复

### H1 — 重命名后 ts-shared 相对导入断裂
- 修改：`test/dual-mode-harness/src/main.ts:19`、`src/worker-a.ts:42-43`、`src/worker-b.ts:50-51` 的 5 处导入由 `../../src/ts-shared/...` 改为 `../../../src/ts-shared/...`。
- 同步更新 `test/dual-mode-harness/README.md:99` 记录的旧导入路径（`../../src/ts-shared/trace/trace-recorder.js` → `../../../src/ts-shared/trace/trace-recorder.js`）。
- 验证：`npx --no-install tsc --noEmit` 退出码 0（原 5 个 TS2307 + 3 个级联 TS7006 全部消失）。

### M1 — scene.rs 无 MODELS lump 退化路径导出空场景
- 修改：`test/extract/src/scene.rs` 删除原 121-128 行的覆盖逻辑（`model_faces = vec![!seen 面]`——此时全部面已置 seen，覆盖后恒为空）。
- 现在直接使用第一轮循环已收集的 `model_faces`（首个 `(0, faces.len())` 组即全量有效可见面），与注释语义一致。
- 新增集成测试 `scene_without_models_lump_exports_all_valid_faces`（tests/integration.rs）：合成不含 MODELS lump 的 BSP，断言合法面被导出（修复前该测试得到空 primitive 列表而失败）。

### M2 — bsp.rs raw_lump 加法在 wasm32 上可溢出环绕
- 修改：`test/extract/src/bsp.rs:227`（原 220）`let end = start + entry.length as usize` 改为 `start.checked_add(...)`，溢出返回 `BspError::LumpOutOfBounds`。
- 新增单测 `raw_lump_rejects_wrapping_offset_length`（offset=5、length=0xFFFFFFFF）。

### M3 — displacement power 未校验
- 修改：`test/extract/src/displacement.rs:77,89` 新增 `MAX_POWER: i32 = 6`，`power < 0 || power > 6` 直接返回空（Source 实际上限 4，放宽余量）。
- 新增单测 `power_out_of_range_returns_empty`（覆盖 -1、16、i32::MAX）。

### M4 — start_position 含 NaN 时 partial_cmp().unwrap() panic
- 修改：`test/extract/src/displacement.rs:102` 新增有限性防护（start 与 4 个角点任一非有限即返回空）；`:105` `partial_cmp().unwrap()` 改为 `total_cmp`（NaN 全序，永不 None）。
- 新增单测 `nan_start_position_returns_empty`（含 NaN 角点分支）。

### M5 — 负 first_edge 在 wasm32 上绕过顶点链校验
- 修改：`test/extract/src/scene.rs:119-127`（原 110-113）先验 `first_edge < 0 || num_edges < 3` 再转 usize，`start.checked_add(count)` 替换裸加法；195/245 行切片从此只消费已验证索引。
- 连带加固（额外发现）：`:83-97` MODELS lump 的 `(m.first_face + m.num_faces) as usize` 存在同类 i32 加法溢出（debug panic / release 环绕），改为 i64 中间计算 + 负值过滤，越界 model 直接剔除。
- 由 M1 的集成测试一并覆盖（恶意面 first_edge=-1 被跳过而非 panic）。

### L1 — lzma.rs 按声明长度无上限预分配
- 修改：`test/extract/src/lzma.rs:22` 新增 `MAX_LZMA_OUTPUT = 1 GiB`；`:71` 声明长度超限直接报错；`:25-47` 新增 `LimitedWriter`（Write 适配器），lzma-rs 输出经其封顶，防流本身膨胀（不止预分配）。
- 新增单测 `rejects_oversized_declared_length`（声明 0xFFFFFFFF）。

### L2 — pak.rs / main.rs zip 炸弹
- 修改：`test/extract/src/pak.rs:19` 新增 `pub const MAX_PAK_FILE_BYTES = 512 MiB`；`pak_extract`（:83-99）声明尺寸超限拒绝 + `Read::take` 封顶实际解压 + 解压后长度复查。
- 修改：`test/extract/src/main.rs:192-226` `cmd_pak_extract` 同法逐条目防护 + `MAX_PAK_TOTAL_BYTES = 2 GiB` 累计上限。

### L3 — vtf.rs 恶意宽高触发 ~17GB 分配
- 修改：`test/map-min-export/src/vtf.rs:149-152` parse_header 在解析头字段后立即校验 `0 < 宽/高 ≤ 4096`，超限返回 Err。
- 新增单测 `rejects_huge_dimensions`（65535×65535 头）。

### L4 — 旧路径残留 test/CONCLUSION.md
- 修改：`game/README.md:94`（同一句中 `test/CONCLUSION.md` → `../test/dual-mode-harness/CONCLUSION.md`，与前半句 `../test/dual-mode-harness/README.md` 对齐）；`CHANGELOG.md:39` → `test/dual-mode-harness/CONCLUSION.md`。

### L5 — architecture.md「不消费 ts-shared」与代码矛盾
- 修改：`docs/architecture.md:77-78` 改为「并消费 ts-shared 的 trace 公共模块（TraceRecorder/TraceRenderer/TraceState，见 src/ts-shared/trace/）；其共享状态协议为 test 自研的 SAB 双缓冲 + WAKEUP/RENDER_WAKEUP 布局」。

### L6 — test-wasm.mjs 硬编码本机绝对路径
- 修改：`test/extract/test-wasm.mjs:6` 默认值改为 `new URL('../../maps/ze_cursed_bear_tales_v1_2.bsp', import.meta.url)`（相对脚本本身，换机可用），注释同步更新。

### L7 — verify.mjs 两个恒真校验
- 修改：`test/map-min-export/scripts/verify.mjs:92-96` 两条恒真表达式替换为真实结构校验（`manifest.geometry.triangles`、`manifest.collision.brushes` 均为合法正数）；第 4 节新增 `collision.json 项数 == manifest.collision.brushes` 交叉校验。

### L8 — serve.py 绑定 0.0.0.0
- 修改：`test/extract/serve.py:43` 绑定 `"127.0.0.1"`（原 `""` 全网卡），并加注释说明原因（服务根=仓库根，仅本机预览用途）。

### L9 — viewer ensureWasm 失败后无限轮询
- 修改：`test/extract/viewer/index.html:173-204` 重写为共享 `wasmPromise`：并发等待者 await 同一 Promise；失败时在 finally 中复位 `wasmPromise = null`（允许重试）并 rethrow，等待方收到 rejection 而非 50ms 无限轮询。

### I1 — bsp_info 吞掉 PAKFILE 错误
- 修改：`test/extract/src/wasm.rs:50-54,68` `pak_entries()` 的 Err 不再 `unwrap_or(0)`，JSON 新增 `"pakError"` 字段（成功为 null）。

### I2 — 空 primitive 的非法 accessor
- 修改：`test/extract/src/glb.rs` `bbox` 返回 `Option`：空顶点集返回 None；非有限 min/max 亦返回 None（serde_json 序列化非有限浮点会 panic）。accessor 仅在 Some 时输出 min/max。
- 新增单测 `empty_primitive_has_no_min_max`。

### I3 — pak.rs「保留顺序」注释误导
- 修改：`test/extract/src/pak.rs` Entity 文档注释改为「按 key 字典序存储，BTreeMap 保证；Source 实体 KV 读取不依赖原始顺序」。

### I4 — scene.rs「按 56 尝试」注释与实现不符
- 修改：`test/extract/src/scene.rs` parse_faces 注释改为「直接报错拒绝（不做启发式拆分）」，与 `return Err` 行为一致。

### I5 — 残留根目录 extract/ 陈旧产物
- 操作：删除根 `extract/` 下全部内容（`.cargo-home/`、`pkg/`、`target/` 等 394MB 陈旧构建产物 + 已搬空的 src/tests/viewer/web 空目录）。根目录空壳 `extract/` 被外部进程（疑似编辑器/终端 CWD 句柄）占用暂时无法 rmdir，内容已全空、git 不跟踪空目录，无影响。

### I6 — MSRV 未声明
- 修改：`test/extract/README.md:7` 增加「构建要求：Rust ≥ 1.87（usize::is_multiple_of，另 div_ceil 需 ≥1.73）」。

### I8 — 「根节点 Y+90°」注释不完整
- 修改：`test/extract/README.md:154-156` 与 `test/extract/src/glb.rs` 根旋转注释补充：该旋转必须与 scene map_coords 的顶点重映射 `[x,y,z]→[y,z,x]` 组合才等于整体 Z-up→Y-up，组合结果为 `(x,z,-y)`，两处缺一不可。

## 打回

无。报告 21 条意见均经逐条打开代码核验属实（行号、行为、影响面一致），全部采纳执行。

## 延期

### I7 — 主线程同步解析（web/app.js 与 viewer 的 bsp_info/bsp_to_glb 冻结 UI）
- 理由：报告自身定性为「功能正确，UX 层面提示」。将大 BSP 解析迁入 Web Worker 需要同时改造 `test/extract/web/app.js` 与 `viewer/index.html` 的加载链路（wasm 实例在 Worker 侧初始化、结果 transfer 回主线程），改动面大且与本次缺陷修复（H1/M/L 系列）无耦合，独立成项更利于回归审查；本地预览工具（serve.py 已限 127.0.0.1）实际影响有限。
- 建议后续动作：单独任务实现 Worker 化解析（参照 dual-mode-harness 的 BspProcessor 主线程 + 双 Worker 分发模式），并把大文件解析进度条一并纳入。

## 额外发现并修复

1. **scene.rs MODELS 区间 i32 溢出**（报告未提及，与 M5 同类）：`(m.first_face + m.num_faces) as usize` 在恶意目录项下 debug 溢出 panic / release 环绕；已并入 M5 修复（i64 中间计算 + 负值过滤）。
2. **glb.rs 非有限包围盒会 panic**（I2 的延伸）：即使顶点非空，若位置含 NaN/inf，serde_json 序列化 accessor min/max 会 panic；bbox 改为 Option 后一并防护。
3. **verify.mjs collision 交叉校验缺失**：原第 4 节只有 GLB 交叉校验；随 L7 一并补上 collision.json 项数与 manifest.collision.brushes 的交叉校验（18/18 → 19/19 检查项，全部真实有效）。

## 验证记录

| 命令 | 结果 |
|---|---|
| `cd test/extract && cargo check` | 通过（0 警告） |
| `cd test/extract && cargo test` | 通过：30 lib 单测 + 1 main 单测 + 3 集成测试（含新增 M1/M5 集成测试） |
| `cd test/extract && cargo check --target wasm32-unknown-unknown --features wasm` | 通过（wasm32 目标 + wasm 特性编译验证） |
| `cd test/map-min-export && cargo check` | 通过 |
| `cd test/map-min-export && cargo test` | 通过：10 单测（含新增 rejects_huge_dimensions） |
| `cd test/map-min-export && node scripts/verify.mjs out/surf_666` | 19/19 PASS（两条恒真校验已替换为真实校验，新增 collision 交叉校验通过） |
| `cd test/dual-mode-harness && npx --no-install tsc --noEmit` | 通过（退出码 0；H1 修复前为 5×TS2307 + 3×TS7006） |
| `cd test/extract && cargo build --release --target wasm32-unknown-unknown --features wasm && wasm-bindgen ... pkg/` | 通过（用修复后代码重建 pkg） |
| `cd test/extract && node test-wasm.mjs ../../maps/surf_666.bsp` | PASS：bsp_info（1500 PAK 条目、pakError:null）+ GLB 9697968B 头校验通过 |
| `cd test/extract && node test-wasm.mjs`（无参，验证 L6 默认相对路径） | PASS：自动解析 `../../maps/ze_cursed_bear_tales_v1_2.bsp`，GLB 23872448B 头校验通过 |
| `python -m py_compile test/extract/serve.py` | 通过 |
| viewer/index.html 内联脚本语法检查（node --check 抽取 block） | 通过（block 0 为 importmap JSON，非 JS） |
| `node scripts/phys-smoke.mjs` 等 dual-mode-harness 脚本 | 未运行：本次改动不触及（tsc 全量类型检查已覆盖 TS 侧） |

修复全程未执行 git add/commit/push；审查报告 `.code-review/report.md` 未改动。
