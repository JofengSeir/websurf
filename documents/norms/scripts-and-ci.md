# 三工程脚本、Windows 入口与部署链的约束

> **适用面**：`apps/{debug,game,viewer}/scripts/**`、三工程的 `*.cmd`（Windows 入口）、`.github/workflows/**`（尤其部署链）。
> **体检硬查**：`[N]`（脚本引用面 / 部署链 app 列表同源 / `.cmd` 形状）。改这三类资产时同读本篇。
> **定位**：本篇只写**约束**；具体脚本逐个的用途与已知缺口在各工程 `documents/<工程>/implementation/scripts*.md`。

## 1. 三工程 `scripts/` 的准入契约

1. **引用面必须非零**：每个入库脚本至少要被下列之一引用——① 本工程 `package.json` 的 `scripts`；② `.github/workflows/**`；③ 同族脚本（被 import 或被显式调用）。**引用面为 0 即孤儿，不许入库**（体检 `[N]` 硬查）。
2. **豁免必须写在明面上**：确实只作本地一次性验收、无法接线的工具，要在 §1.1 豁免表里登记（脚本 + 理由 + 对应 `T-###`）；没登记仍判孤儿。**豁免不是"忘了接线"的后门**。
3. **命名族**：构建 `build-dist.mjs`；契约检查 `check-*`；验收 `*-verify` / `*-smoke` / `*-acceptance`；数据产出 `*-count` / `bench-*` / `plot-*`。新脚本必须落进现有族，不再新增同义族。
4. **本地一次性脚本不入库**：临时探针以 `_` 前缀命名并进 `.gitignore`（先例见根 `.gitignore` 的「一次性实验 / 诊断脚本」块）。**入库即被当作要维护的资产**。
5. **每个脚本在文档里有一行**：登记在 `documents/<工程>/implementation/scripts*.md`（用途 / 调用方式 / 判据 / 已知缺口）；改脚本同改文档。
6. **不许留恒红工具**：脚本的通过条件不得与实现的既定行为矛盾。实例：本仓曾有一个 59 KB 的无头验收工具要求逐帧 `dt > 0`，而实现注释明确写「本仓唯一 `record` 调用点不传 `dtS`，故写进样本的步长恒为 0」（`apps/debug/src/input/input-recorder.ts:10`）⇒ 它**必然失败**；该工具已依 `T-035` 退回本地实验件（不入库）。**规则**：契约若该成立就修实现，若不成立就删掉那条断言或退役工具——不许留一个永远红的门。

### 1.1 豁免表（无法接线的本地一次性验收工具）

| 脚本 | 理由 | 状态 |
|---|---|---|
| （暂无） | — | 2026-10-07：原 `apps/debug/scripts/input-replay-verify.mjs` 已依 `T-035` 退回本地实验件（不入库），豁免表清空 |

## 2. 三工程 `*.cmd`（Windows 入口）契约

三工程各 4 个：`build.cmd` / `dev.cmd` / `start.cmd` / `stop.cmd`。

1. **形状**：`@echo off` + `chcp 65001`；每个失败分支 `exit /b <非 0>`，成功 `exit /b 0`。**不得用裸 `exit`**（会连调用方一起结束，日志汇总行可能丢失）。
2. **参数透传**：`build.cmd` 必须把 `%*` 透传给 `npm run build:dist`，使 `build.cmd --multi` 等价于 `npm run build:dist -- --multi`；不得只接受 `single` 而拒绝其它参数（`apps/viewer/build.cmd` 曾只接受 `single`，2026-10-07 依 `T-134` 对齐为与底层一致）。
3. **启动链三级优先**：`start.cmd`（跑 dist 产物）必须**先用产物自带的启动器**（各工程 `dist/play.cmd`，由 `build-dist.mjs` 内联生成，自带 python → `npx serve` 回退），它不存在才回落到 `python src/serve.py`，再落到 `npx serve`；三级都不可用才报错退出。**守卫不得遮蔽更优路径**（反例：`apps/viewer/start.cmd` 顶部的 python 守卫曾使 `dist/play.cmd` 委派不可达，2026-10-07 依 `T-135` 下移）。`dev.cmd` 可用 `python ../../src/serve.py <port>`，缺 python 必须给出**可操作提示并回退**。
4. **端口分两档，不得混用**：`dev.cmd` 跑 dev server 用 **8080 / 8090 / 8100**（与各工程 `package.json` 的 `dev` 一致，实测）；`start.cmd` 服务已打包的 `dist/` 用**相邻端口**（`apps/viewer/start.cmd:7` 实测缺省 `8101`），避免 dev 与 dist 互相抢占。占用时只许 `[WARN]` + 提示换端口，**不得假定占用者在服务本工程 `dist/`、不得自动开浏览器**（反例：三工程 `start.cmd` 原「[SKIP] … opening the browser」分支，2026-10-07 依 `T-038` 修）。
5. **不写死用户路径**：不得出现 `C:\Users\<名>\…`（换机器即失效）。外部工具（浏览器等）走环境变量 + 常见安装路径探测。
6. **不改全局状态**：不改系统 PATH / 注册表，不装依赖（依赖由 `npm ci` 负责）。

## 3. `.github/workflows/**` 部署链契约

1. **app 列表同源**：`deploy-pages.yml` 的 `strategy.matrix.app`、装配段的 `for app in …`、以及 `apps/` 下的工程目录**三者必须一致**（体检 `[N]` 硬查）。
2. **产物形态**：部署产物一律 `--multi`（`npm run build:dist -- --multi`）；单产物分支只服务本地。
3. **入口页归属**：Pages 首页是 `apps/debug/scripts/pages-index.html`（装配段复制为 `deploy/index.html`）——改它要同改部署链的占位符替换与断言。
4. **宁可硬失败**：产物缺 `index.html`、占位符 `__DEPLOY_*__` 未替换干净时必须 `exit 1`，不许静默发布残缺站点（现有实现已如此，见 `.github/workflows/deploy-pages.yml:164` 起）。
5. **权限与并发**：`permissions` 最小化（`pages: write` / `id-token: write`）；`concurrency` 必须限制到同一 environment，避免并发发布互相覆盖。
6. **不引入新 secret**：静态产物不得依赖仓库 secret；确需时先登记 `OWNER.md`。
## 4. 共享门禁清单（`src/scripts/**`）

> 本节同时满足「公开面必须有文档登记」：`src/scripts/**` 的每个工具都要在这里有一行，否则体检的覆盖率项会点名它。

| 工具 | 作用 | 接线 |
|---|---|---|
| `check-doc-drift.mjs` | 文档漂移体检 A–O（含体积/分卷/注释纪律/上级覆盖/缺口↔看板/假结案/脚本契约/文档契约） | `.github/workflows/doc-drift.yml`；`AGENTS §5` |
| `check-board-touch.mjs` | 看板触碰**软提示**（改了 src/apps/documents 却没动 TODO.md） | CI（`continue-on-error`） |
| `docflow.mjs` | 文档契约：只读钉 / 单元级字段权限 / 锚点内容指纹（按 `目标:行号` 对位，含 TODO·OWNER 证据列的裸锚点）/ 强绑定 | 体检 `[O]` 直接调用（变更基线：CI 下 `HEAD^`，可 `--base` 指定） |
| `check-glb-parity.mjs` | debug 与 game 的**材质口径一致性**（同一张图必须产出同一套材质） | **未接线** ⇒ 见 `TODO.md` T-409 |
