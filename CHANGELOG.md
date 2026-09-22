# 变更记录

本文件分两段：**§1 当前工作区状态**（只写能由当前代码核验的内容）+ **§2 归档历史**（压缩时间线，细节在 `.archive/CHANGELOG.md`）。

> 说明：工作区原有文档树已整树移入 `.archive/`（不作事实来源）。§2 用于追溯项目演进，不用于核验代码事实——需要证据请查归档原文或代码。

---

## §1 当前工作区状态（未发布，版本 0.1.0）

**受控范围**：三个应用工程 `apps/debug`（8080）、`apps/game`（8090）、`apps/viewer`（8100）与共享层 `src/`（`websurf-phys`、`websurf-wasm-core`、`src/ts-shared/**`）。`test/` 下只有本地夹具（`test/maps/`、`test/replay/`），**没有其它工程**；范围与入口见 `README.md`。

**版本声明**（均为 `0.1.0`，各自文件内可核验）：

| 包 | 声明处 |
|---|---|
| `websurf-debug` | `apps/debug/package.json:3` |
| `websurf-game` | `apps/game/package.json:3` |
| `websurf-viewer` | `apps/viewer/package.json:3` |
| `websurf-phys` | `src/Cargo.toml:3` |
| `websurf-wasm-core` | `src/wasm-core/Cargo.toml:11` |
| 三个工程的 wasm 导出层 | `apps/debug/crates/wasm/Cargo.toml:12`、`apps/game/crates/wasm/Cargo.toml:12`、`apps/viewer/crates/wasm/Cargo.toml:9` |

**构建链**：`wasm-pack` 构建各工程 `crates/wasm` → `pkg/` 并复制到 `web/`；esbuild 打包 worker 与 app；`scripts/build-dist.mjs` 生成 single 或 multi 形态的 `dist/`。命令与锚点见 `README.md`「构建链」。

**文档体系**：根 `README.md` 为入口；`documents/**` 按主题分篇（架构、物理、解析层、TS 共享层、材质、规范、计划台账），篇目见 `README.md`「文档地图」与 `documents/index.md`。

**验证**：共享层 `cargo test -p websurf-phys`；三工程 `npm run typecheck` 与各自 `test:*` 门禁；文档侧 `node src/scripts/check-doc-drift.mjs`。CI 三条 workflow 见 `README.md`「验证与 CI」。

**当前已知缺口**（逐条证据与处置状态见 `documents/plan/progress-log.md` §7.3）：输入录制链路未接线、零分配支路（`tick_into` / `state_out_ptr` / `seed_from`）与 `set_yaw_pitch` 无装配点、`.cmd` 的 wasm 新鲜度门与页面消费的产物不是同一份等。

> 注：更早的条目（含已退役工程 `test/dual-mode-harness`、`test/game-core` 的时期）见 §2 归档历史；当前受控工程只有 `apps/{debug,game,viewer}` 与 `src/`。

---

## §2 归档历史（压缩时间线）

细节、实测数字与论证见 `.archive/CHANGELOG.md`。

### 2026-09-22 · 文档与注释重编（进行中）

- 立项：以源码为唯一事实来源重写全部文档与代码注释；旧 `documents/**` 与根四份文档移入 `.archive/`。
- 产出 `documents/plan/` 三篇控制文件（读码事实基线 / 任务书 / 进度台账）；根 `AGENTS.md` 改为当前任务的行为规范与进度纪要。
- 文档树重组为 `architecture/ phys/ wasm-core/ ts-shared/ materials/ debug/ game/ viewer/ norms/ plan/`。

### 2026-09-21 · 光照与输入

- 光照模式改**运行期切换**（共享 `uniform vbspBakedMix`，三条烘焙路径各自分支）：切换 0.2~0.6 ms（旧实现 1.41 s / 2.54 s），零重建；viewer 接入同一套光照栈。
- `test/game-core` 转**本地工程不入库**（从 32 个未发布提交剥离）；`test:glb-contract` 标为 optional。
- game 新增 8 键 HUD 键位簇（标签取该动作第一个绑定键，面板改键即同步）；蹲/跳位置对调。
- 视角锁定改为点击 `document` 即锁（浮层不再吞点击）；debug「缺失纹理」弹窗点背板可关。
- debug 进图整屏空白根因修复：`InterleavedBufferAttribute.array` 是整段 stride 缓冲，按 `itemSize` 重建得非整数顶点数 ⇒ 包围盒 NaN ⇒ LOD 不渲染。
- tickRate 取消隐藏偏移（面板值 = 权威步长）。
- CI 拆分为 `deploy-pages.yml`（只部署，matrix 并行）与 `ci-gates.yml`（门禁），互不阻塞。

### 2026-09-20 · 共享层回并

- `test/game-core` 隔离副本回并：`src/wasm-core/**`（新增 `lightmap.rs`、`vhv.rs`）、`src/phys/world.rs`（`TriEntry.mesh` 改 `Rc<TriMesh>` ⇒ 权威线启动 4972 ms → 135 ms）、`src/ts-shared/phys/{world-builder,authority-calibrator}.ts`。
- 三工程渲染/物理栈迁移；新增跨工程 GLB 契约门禁 `test:glb-contract`（4/4 一致）。

### 2026-09-13 · 物理

- 蹲姿/起立对齐 Source `CanUnduck()`：移除"放脚被挡即原地起立"的非 Source 兜底；空中起立必须放脚（origin 下移 18）并扫掠判定。影响：贴坡 surf 松键保持蹲姿直到离坡或落地（原版行为）。新增 `duck_surf_tests.rs`。

### 2026-09-12 · 仓库规范

- 新增三份规范：`framework-audit.md`（`I-01..I-22`、`R-01..R-21`）、`framework-launch-structure.md`（启动/结构/产物、10 端口段槽位）、`framework-decoupling.md`（共享层上提裁决 `D-01..D-23`）。
- 78 个 LF-only 文本文件归一 CRLF（内容零变化）；清理约 25 MB 临时堆积（已备份仓库外）。
- 新增 `src/scripts/check-doc-drift.mjs`；`mouse-buffer` / `pointer-lock` 上提共享层。

### 2026-09-11 · 结构迁移

- debug / game / viewer 迁入 `apps/`；`test/game`、`test/instanced-diorama` 移除。

### 2026-09-08 · 查看器与回放

- `apps/viewer`：Shavit `.replay` 原生二进制回放（JSON 与规则脚本通道移除），保留坐标映射与人工变换；新增回放遥测 HUD；速度单位改 `u/s`。

### 2026-08 · 早期主线（摘要）

- BSP 支持 Source 1 **v19~v29**（v20/v21 lump 布局一致，放宽版本检查）；新增 sprp v11 静态道具。
- 材质低清压缩（mosaic v4 + MTZ）与画质切换；打包双模式 `single` / `--multi`。
- `src/ts-shared/` 收敛（SAB 512 B 权威双缓冲、权威循环、校准、输入层、地图管线）；去 LERP/外推，改预测物理直读 + 权威速度校准。
- 一批修复：斜坡接缝卡零速、贴墙近平面裁剪、地图重载内存泄漏、传送检测等。

---

## 0.1.0 — 2026-08-05

- 初始版本：BSP 解析、CS 移动物理、Three.js 渲染。
