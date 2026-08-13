# WebSurf 代码审查报告

- 审查日期：2026-08-13
- 审查对象：工作区未提交变更（`extract/`→`test/extract/`、`test/`→`test/dual-mode-harness/` 大规模重命名 + 内容修改 + 未跟踪 `test/map-min-export/`）+ 近期提交 9aab20b、647ff07、f3662c8、b019115、2325f07
- 审查方式：只读审查（未修改/删除/移动任何文件，未执行 git add/commit/push；构建产物仅 target/、pkg/ 等被 gitignore 的目录）

---

## 一、审查范围与验证记录

### 1.1 工作区状态检查

| 命令 | 结果 |
|---|---|
| `git status --short` | 见下：50 个 R（rename）状态文件 + 11 个 M 修改 + `?? test/map-min-export/` |
| `git diff HEAD -M --summary` | 重命名全部被 git 识别（历史保留）；伴随内容修改（RM）的文件：dual-mode-harness 的 Cargo.toml、crates/wasm/Cargo.toml、README.md、mini/README.md、mini-verify.mjs、package.json、play.cmd、build-dist.mjs、perf-bench.mjs、phys-smoke.mjs、race-wakeup.mjs、surf-e2e-verify.mjs、worker-a.ts；extract 的 README.md、serve.py、view-glb.cmd |
| `git diff HEAD`（非重命名文件） | 已逐个审阅（PR 模板/CONTRIBUTING/CHANGELOG/README/docs×3/game/README/renderer-main.ts/ts-shared trace README） |
| 根目录 `Cargo.toml` | **不存在**（仓库根无 workspace 清单；`extract/` 本就声明为独立 workspace，本次重命名不影响 workspace 成员关系） |
| 残留根目录 `extract/` | 仅剩 gitignored 构建产物（`.cargo-home/`、`pkg/`、`target/`），无任何源码/跟踪文件（`git ls-files extract/` 为空） |

### 1.2 构建 / 测试 / 静态检查

| 命令 | 结果 |
|---|---|
| `cd test/extract && cargo check`（cargo 1.93.0） | **通过**（0 警告输出） |
| `cd test/extract && cargo test` | **通过**：2 integration tests + 全部单元测试 PASS（bsp/lzma/pak/scene/displacement/glb 各模块单测） |
| `cd test/map-min-export && cargo check` | **通过** |
| `cd test/map-min-export && node scripts/verify.mjs out/surf_666` | **18/18 PASS**（GLB 107617 三角形与 manifest 交叉校验一致、26 PNG 校验合法） |
| `cd test/extract && node test-wasm.mjs ../../maps/surf_666.bsp` | **PASS**：wasm 端到端 bsp_info（322851 顶点/107617 三角形/1500 PAK 条目）+ bsp_to_glb（9697968 字节，GLB 头 magic/version/totalLen 合法） |
| `cd test/dual-mode-harness && npx --no-install tsc --noEmit` | **失败**：5 处 TS2307（`../../src/ts-shared/trace/*.js` 无法解析）+ 3 处级联 TS7006（见问题 H1） |
| `cd test/dual-mode-harness && node scripts/phys-smoke.mjs` | **191/191 PASS**（与更新后的 README 声明一致；HEAD 时声明为 192/192，本次实测确认为 191） |
| `test/dual-mode-harness` 的 `npm run build:wasm` / `build:ts` | **未运行**：目录无 node_modules、未安装 wasm-pack；但 tsc 失败 + worker-a/b 的值导入路径错误可直接证明 build:ts 必然失败（见 H1） |
| `test/map-min-export` 对 `maps/ze_cursed_bear_tales_v1_2.bsp` 的完整导出 | 未重新运行（151MB、耗时），以仓库内已落盘 `out/` 数据 + README 记录 + verify 脚本实测为据 |
| 旧路径 grep（`test/scripts`、`test/mini`、`test/CONCLUSION`、`extract/README` 等模式） | 发现残留：game/README.md:94、CHANGELOG.md:39（见 L4） |
| CI（`.github/workflows/*.yml`）grep | 无 `extract/`、`test/scripts` 引用（CI 不涉及测试合集，无破坏） |
| 编码检查（`file` + xxd） | 全部 UTF-8 正常（审查过程中个别命令输出的乱码为控制台渲染问题，非文件问题） |

审查结束后 `git status --short` 与开始时完全一致——未改变任何跟踪文件状态。

---

## 二、问题清单

> 按严重级别排序。行号以当前工作区文件为准。

### High

#### H1. 重命名后 dual-mode-harness 对共享层 ts-shared 的相对导入断裂，类型检查与构建失败

- **位置**：
  - `test/dual-mode-harness/src/main.ts:19` — `import type { TraceState } from '../../src/ts-shared/trace/trace-types.js';`
  - `test/dual-mode-harness/src/worker-a.ts:42-43` — `import { TraceRecorder } from '../../src/ts-shared/trace/trace-recorder.js';` / `import type { TraceControlMessage } from '../../src/ts-shared/trace/trace-types.js';`
  - `test/dual-mode-harness/src/worker-b.ts:50-51` — `import { TraceRenderer } from '../../src/ts-shared/trace/trace-renderer.js';` / `import type { TracePoint } from '../../src/ts-shared/trace/trace-types.js';`
- **问题描述**：`test/` → `test/dual-mode-harness/` 后目录加深一级，`../../src/ts-shared/...` 现解析到不存在的 `test/src/ts-shared/`，正确路径应为 `../../../src/ts-shared/...`。本次重命名只更新了 Rust path 依赖（`crates/wasm/Cargo.toml`、`[patch.crates-io]`）、npm 脚本与 maps 路径，**漏掉了这些 TS 导入**。
- **影响**：实测 `npx tsc --noEmit` 报 5 个 TS2307（+3 个级联 TS7006 `pt`/`pts`/`p` 隐式 any）。worker-a.ts:42 与 worker-b.ts:50 是**值导入**（非 type-only），esbuild 打包同样无法解析 → `npm run typecheck` 与 `npm run build`（build:ts）在验证工程中全部失败。trace 链路（2325f07 恢复的功能）在重命名后完全不可用。
- **建议修复**：将上述 5 处导入统一改为 `../../../src/ts-shared/...`；同步修正 `test/dual-mode-harness/README.md:99` 中记录的旧导入路径（`../../src/ts-shared/trace/trace-recorder.js`）。修复后在 `test/dual-mode-harness` 重跑 `npx tsc --noEmit` 验证（TS7006 应为级联错误，路径修好后大概率消失）。

### Medium

#### M1. scene.rs「无 MODELS lump」退化路径静默导出空场景（9aab20b 引入）

- **位置**：`test/extract/src/scene.rs:121-128`
- **问题描述**：退化分支（`models.is_empty()`）先用单区间 `(0, faces.len())` 遍历并**把所有面都置为 `face_seen=true`**（包括因不可见/非法 texinfo 被 `continue` 跳过的面），随后 `if !has_models` 又用 `filter_map(|(i,&seen)| (!seen).then_some(i))` **覆盖** `model_faces`——此时 `!seen` 恒为空，最终 `groups` 为空 → 输出**零 primitive 的空 GLB**。注释「无 MODELS lump 时 model_faces 已是全量」与代码行为相反。
- **影响**：对缺失/损坏 MODELS lump（lump 14）的 BSP，`bsp-to-glb`/`bsp_to_glb`/map-min-export 静默产出空几何而非完整场景或明确报错（遮蔽错误）。
- **建议修复**：删除 121-128 行的覆盖逻辑，直接使用第一轮循环已收集的 `model_faces`（首个 `(0, faces.len())` 组即全量有效可见面）。

#### M2. bsp.rs raw_lump 的加法在 wasm32 上可溢出环绕，绕过边界检查后切片 panic

- **位置**：`test/extract/src/bsp.rs:220-221`（`let end = start + entry.length as usize; if end > data.len() || start > data.len()`）
- **问题描述**：wasm32 目标 usize=u32，恶意 lump 目录项（如 offset=5、length=0xFFFFFFFF）使 `start + length` 环绕为小值，`end > data.len()` 与 `start > data.len()` 均不成立 → 检查通过 → `data[start..end]`（start > end）panic → wasm trap（不可恢复）。原生 64 位无此问题（u32+u32 不会溢出 usize）。
- **影响**：浏览器端（`bsp_info`/`bsp_to_glb`/viewer）用特制 BSP 可稳定触发 wasm trap，页面功能崩溃（DoS）。
- **建议修复**：`let end = start.checked_add(entry.length as usize).ok_or(BspError::LumpOutOfBounds{..})?;` 或改用 u64 中间计算后再比较。

#### M3. displacement.rs power 未校验，恶意 DISPINFO 触发容量溢出 panic / 巨额计算

- **位置**：`test/extract/src/displacement.rs:85`（`2usize.pow(disp.power as u32) + 1`）→ `:108`（`Vec::with_capacity(steps * steps)`）
- **问题描述**：`power` 来自不可信二进制（i32）。power≥16 时 steps≥65537，`steps*steps` 容量按元素大小溢出 → `Vec::with_capacity` 在 **debug 与 release 下都直接 panic**（"capacity overflow"）；power 为负值转 u32 后 2^32 同样异常（wasm32 下 `pow` 环绕得 0 → steps=1 侥幸早退，行为不可预测）。原生 CLI 与 wasm 均可被触发。
- **影响**：特制 BSP 即可使 CLI/wasm 崩溃（DoS）。真实地图 power≤4 不受影响。
- **建议修复**：解析时校验 `power` 在合法范围（Source 实际上限 4，放宽到 0..=6 足够），超范围直接返回错误或 clamp；`steps.checked_mul(steps)` 后再分配。

#### M4. displacement.rs start_position 含 NaN 时 partial_cmp().unwrap() panic

- **位置**：`test/extract/src/displacement.rs:96`（`min_by(|(_,a),(_,b)| dist2(**a,start).partial_cmp(&dist2(**b,start)).unwrap())`）
- **问题描述**：`start_position` 与角点均为不可信 f32；任一为 NaN 时 `partial_cmp` 返回 None → `unwrap()` panic。真实地图数值有限，特制文件可稳定触发。
- **影响**：与 M3 同类：不可信输入路径上的 panic（原生 + wasm）。
- **建议修复**：用 `total_cmp`（NaN 有全序）或先过滤非有限值（`if !start.iter().all(|v| v.is_finite()) { return Vec::new(); }`）。

#### M5. scene.rs 负 first_edge 在 wasm32 上加法环绕可绕过顶点链校验

- **位置**：`test/extract/src/scene.rs:110-113`（校验）、`195` 与 `245`（`&surfedges[fr.first_edge..fr.first_edge + fr.num_edges]` 切片）
- **问题描述**：`face.first_edge` 为不可信 i32。负值转 usize 后在 wasm32 上与 `num_edges` 相加可环绕为小值，使 `start + count > surfedges.len()` 检查通过 → 后续第 195/245 行切片以巨大 start panic（trap）。原生 64 位 `-1 as usize` 为 2^64-1，加法不环绕，检查必然拦截（安全）。
- **影响**：同 M2——wasm 端特制 BSP DoS。
- **建议修复**：先做 `face.first_edge < 0 → continue`（或 `u32::try_from` 校验），再 checked_add。

### Low

#### L1. lzma.rs 按头部声明的解压长度预分配，无上限

- **位置**：`test/extract/src/lzma.rs:55`（`Vec::with_capacity(uncompressed_len)`）
- **问题描述**：恶意 LZMA 头声明 uncompressed_len=0xFFFFFFFF → 立即尝试分配 ~4GB（wasm32 上容量溢出 panic；64 位 OOM abort）。
- **建议**：预分配前加合理性上限（如与压缩段长度的倍数关系或固定上限），超限返回错误。

#### L2. pak.rs / main.rs 按 zip 中央目录声明大小预分配 + zip 炸弹无解压上限

- **位置**：`test/extract/src/pak.rs:78`、`test/extract/src/main.rs:203`（`Vec::with_capacity(file.size() as usize)`）
- **问题描述**：特制 PAKFILE 内条目 size 声明巨大 → 大额分配；`read_to_end` 解压也无总字节上限（zip 炸弹）。对本地测试工具风险有限，但对「网页拖入任意 .bsp」场景属于输入面。
- **建议**：解压时设置累计字节上限（如 512MB）与 size 合理性校验。

#### L3. vtf.rs 恶意宽高触发 ~17GB 分配

- **位置**：`test/map-min-export/src/vtf.rs:233`（`vec![0u8; w * h * 4]`，w/h 来自 VTF 头 u16）
- **问题描述**：特制 VTF 头 65535×65535 RGBA → 立即尝试分配 ~17GB，OOM abort。
- **建议**：解码前校验 `w*h` 上限（如 ≤ 4096×4096）并返回 Err，与现有「数据不足」错误路径一致。

#### L4. 旧路径残留：`test/CONCLUSION.md`

- **位置**：`game/README.md:94`、`CHANGELOG.md:39`
- **问题描述**：重命名后应为 `test/dual-mode-harness/CONCLUSION.md`。game/README.md:94 是**同一句话里新旧路径并存**（前半已更新为 `../test/dual-mode-harness/README.md`，后半漏改）。CHANGELOG.md:39 属于 2026-08-11 历史条目，未随重组更新。
- **建议**：两处改为 `test/dual-mode-harness/CONCLUSION.md`。

#### L5. docs/architecture.md 与代码矛盾：「不消费 ts-shared」

- **位置**：`docs/architecture.md:77`
- **问题描述**：文档声称 test/dual-mode-harness「**不消费 ts-shared**」，但 2325f07 后 main.ts/worker-a.ts/worker-b.ts 均已导入 `src/ts-shared/trace/*`（trace 链路已恢复）。文档与代码双重不一致（路径也断了，见 H1）。
- **建议**：改为「消费 ts-shared 的 trace 公共模块（trace-recorder/trace-renderer/trace-types），其余协议自研」。

#### L6. test-wasm.mjs 硬编码本机绝对路径

- **位置**：`test/extract/test-wasm.mjs:6`（默认 `'D:/code/project/websurf/maps/ze_cursed_bear_tales_v1_2.bsp'`）
- **问题描述**：机器相关的绝对路径作为默认参数，换机即失效（README 示例不传参时会误导）。
- **建议**：默认改为相对本脚本的 `../../maps/...` 或要求必须显式传参。

#### L7. verify.mjs 两个恒真校验

- **位置**：`test/map-min-export/scripts/verify.mjs:92-93`
- **问题描述**：`check('manifest.geometry 与 GLB 一致', ... || existsSync(glbPath) || true)` 恒为真；`check('manifest.collision 与 collision.json 一致', Array.isArray(man.collision) || man.collision?.brushes !== undefined)` 对对象恒真。这两条是无效校验（真正的交叉校验在第 140 行）。删除或改为实际比对，避免「18/18 PASS」数字虚高。

#### L8. serve.py 绑定 0.0.0.0 且服务整个仓库根

- **位置**：`test/extract/serve.py:16`（`SERVE_ROOT = REPO`）、`:41`（`socketserver.TCPServer(("", port), ...)`）
- **问题描述**：服务根=仓库根（为暴露 /maps/ 与 /test/extract/），监听所有网卡——局域网内可拉取 79-151MB 的 BSP、全部源码与 docs。COOP/COEP 头不构成访问控制。（仓库根 `src/serve.py` 同款行为，属既有设计，此处仅提示。）
- **建议**：绑定 `"127.0.0.1"`。

#### L9. viewer ensureWasm 首次加载失败时并发等待者无限轮询

- **位置**：`test/extract/viewer/index.html:178`（`while (!wasmReady) await new Promise(r => setTimeout(r, 50));`）
- **问题描述**：若 wasm 加载失败（wasmLoading 复位、wasmReady 保持 false），已进入等待循环的调用方将永远轮询（50ms 间隔，非忙等但永不退出），状态停留在「加载 wasm…」。
- **建议**：共享同一 Promise（`wasmPromise`），失败后复位以允许重试，等待方 await 该 Promise 并在失败时抛出。

### Info

- **I1 错误吞掉**：`test/extract/src/wasm.rs:50` `pak_entries().map(|v| v.len()).unwrap_or(0)` — PAKFILE 损坏/解析失败时 bsp_info 静默报 0 条目，掩盖真实错误；建议透传或在 JSON 中加 `pakError` 字段。
- **I2 空 primitive 的非法 accessor**：`test/extract/src/glb.rs:202-212` 对空顶点集产生 min=[+inf,+inf,+inf]/max=[-inf,-inf,-inf]（min>max 违反 glTF 规范）。当前调用方保证非空（scene.rs:228 空组不入 output），属防御性缺口。
- **I3 注释与实现不符**：`test/extract/src/pak.rs:92`「保留顺序」但用 `BTreeMap`（字典序）。实体 KV 顺序不影响功能，仅注释误导。
- **I4 注释与实现不符**：`test/extract/src/scene.rs:401-405` 注释称「按 56 尝试」但代码对非 56 倍数直接 `Err`（并不尝试）。
- **I5 残留根目录 `extract/`**：`extract/target/`、`extract/pkg/`、`extract/.cargo-home/` 为搬移前的陈旧构建产物（全部被 .gitignore 覆盖、不进入 git），但会占用磁盘并可能误导（例如有人继续 `cd extract && cargo build` 时 Cargo.toml 已不在）。建议确认无用后删除。
- **I6 MSRV 隐性要求**：`usize::is_multiple_of`（Rust ≥1.87）、`div_ceil`（≥1.73）多处使用；当前工具链 1.93 实测通过，但 README 未声明 MSRV。
- **I7 主线程同步解析**：web/app.js 与 viewer 的 `bsp_info`/`bsp_to_glb` 在 79-151MB BSP 上同步执行会冻结 UI 数秒（无 Worker 分流）；功能正确，UX 层面提示。
- **I8 文档注释笔误**：`test/extract/README.md`「根节点 Y+90°」的描述单独看并不等于 Z-up→Y-up（需与顶点 [y,z,x] 映射组合才成立），建议注释补充「与 scene map_coords 组合后为 (x,z,-y)」以免后续维护者误删其一。

---

## 三、事实澄清 / 正面发现

- **重命名工程本身质量高**：全部 50 个文件经 git 识别为 rename（历史保留）；Rust path 依赖（`crates/wasm/Cargo.toml:19,21` → `../../../../src`）、`[patch.crates-io]` vmdl（`Cargo.toml:16` → `../../src/vendor/vmdl`）、npm `dev` 脚本、play.cmd、build-dist.mjs、phys-smoke/perf-bench/surf-e2e 的 maps 路径（`../../maps/surf_666.bsp`）**全部正确加深一级**；serve.py 的 `REPO = ROOT.parent.parent` 上溯与 view-glb.cmd 的 `/test/extract/viewer/` URL 均正确。
- **race-wakeup.mjs 的 1 行新增是真实缺陷修复**：HEAD 版本在该块内 `await donePhys` 但变量未定义（运行时 ReferenceError，脚本最后一段必崩）；工作区补上定义后实测正常。
- **9aab20b 声称的 GLB 修复已逐项验证落实**：bufferView `byteStride=20`（glb.rs:60）、UV accessor `byteOffset=12`、根节点四元数 [0,sin45,0,cos45] 与共享层参考实现 `src/wasm-core/bsp_to_gltf_core/convert.rs:34`（`from_angle_y(Deg(90.0))`）及 `map_coords`（convert.rs:813）逐字一致；wasm 端到端实测 surf_666 输出 9697968B GLB 且头校验通过。
- **测试链路全部可运行且通过**：bsp-extract `cargo check`/`cargo test`（2 integration + 全模块单测）通过；map-min-export `cargo check` 通过、verify.mjs **18/18 PASS**；phys-smoke **191/191 PASS**（与更新后的 README 声明一致）。
- **不可信输入的防护整体到位**：pak extract 的 `sanitize_rel_path` 防路径穿越（含盘符/`..`，有单测）；parse_entities 对 NUL 终止/注释/转义/未闭合均有显式处理与测试；collision.rs 对 first_side+num_sides 越界、坏 plane 引用、非法 AABB 均有防护；所有 lump 解析都有长度倍数校验与 get() 边界访问。
- **map-min-export 未跟踪目录内容干净**：仅源码（4 个 rs + main）、README、verify 脚本、Cargo.toml/lock、.gitignore（`/out/` 排除产物）；`out/` 导出数据（.glb/.json/.vtf/.vmt/.png）全部被忽略规则覆盖（根 `*.glb` + 本地 `/out/`）；无临时调试代码、无硬编码本机路径（README 用法为相对路径）、VTF/PNG 解码器为自研且 BC1/BC2/BC3 调色板公式、RGB565 位扩展、PNG CRC/zlib 实现经审阅正确。
- **提交 b019115 / 2325f07 审阅结论**：b019115 的 trace-renderer 依赖注入重构干净（接口/工厂/懒创建/资源释放语义保留）；2325f07 的碰撞校准改动合理（land 采用权威速度、blocked 保留渲染侧速度，`vel?` 可选兼容两端 worker-types）。
- **XSS 防护**：app.js 渲染文件名经 `esc()` 转义、其余均为数值字段；viewer 全部用 textContent。
- **.gitignore 覆盖无缺口**：`*.glb`、`**/target/`、`**/pkg/`、`**/.cargo-home/`、`**/node_modules/` 覆盖新目录结构下所有产物（含 map-min-export/out）。
