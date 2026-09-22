# implementation / scripts（`apps/game/scripts/**`）

## 模块职责

本目录 20 个 `.mjs`，分三类：一个发行打包脚本、一个 wasm 契约检查脚本、十八个 node 直跑 wasm 产物的物理脚本。其中只有五个有 `package.json` 入口（`apps/game/package.json:13` 与 `:16`-`:19`），其余靠手工命令行调用。

| 脚本 | 职责 | 入口 |
|---|---|---|
| `apps/game/scripts/build-dist.mjs` | 发行打包：single（缺省）或 multi（`--multi`） | `apps/game/package.json:13` |
| `apps/game/scripts/check-wasm-api.mjs` | wasm 契约检查：声明面 + 导入面两级 | `apps/game/package.json:16` |
| `apps/game/scripts/phys-smoke.mjs` | 九段物理冒烟（逐段打印 OK / FAIL，任一段失败即退出码 1） | `apps/game/package.json:17` |
| `apps/game/scripts/phys-seed-smoke.mjs` | 种子面回归：A–G 七段，含 `tick_into` 写出的 22 槽逐槽核对 | `apps/game/package.json:18` |
| `apps/game/scripts/phys-surf-crouch-smoke.mjs` | surf 蹲伏冒烟 | `apps/game/package.json:19` |
| `apps/game/scripts/phys-teleport-gate.mjs` | 传送门槛场景 | 手工 |
| `apps/game/scripts/phys-p2-regression.mjs` | P2「4 档脚底高度 × 3 档 vz」速率一致性参考矩阵 | 手工 |
| `apps/game/scripts/phys-p2-ground.mjs` / `phys-p2-trace.mjs` / `phys-gate-probe2.mjs` / `phys-diag-flat.mjs` | P2 相关诊断：地面速率、单次轨迹、门否决计数、平地基准 | 手工 |
| `apps/game/scripts/phys-rate-parity.mjs` / `phys-rate-parity-v2.mjs` / `phys-dual-pipe.mjs` | 速率一致性对照与双管道复现 | 手工 |
| `apps/game/scripts/wasm-hash-pin.mjs` | wasm 产物哈希固定 | 手工 |
| `apps/game/scripts/t13-literal-sweep.mjs` / `t13-ulp-sensitivity-control.mjs` / `t13-input-surface-probe.mjs` | 字面量扫描、ULP 敏感性对照、输入面探测 | 手工 |
| `apps/game/scripts/_dbg_keys.mjs` / `_dbg_floor.mjs` | 调试脚本（被 `.gitignore` 的 `scripts/_*.mjs` 规则排除） | 手工 |

## 关键流程与不变量

- **物理脚本的装载方式一致**：直接 `import { initSync, PhysWorld } from '../pkg/websurf_wasm.js'` 并 `initSync({ module: readFileSync(...) })`（`apps/game/scripts/phys-p2-regression.mjs:23`、`:28`）；断言在 node 侧做，不经浏览器。
- **发行打包的两形态由一份保留名单固定**：single 5 项（`apps/game/scripts/build-dist.mjs:60`）、multi 9 项（`apps/game/scripts/build-dist.mjs:62`）；形态开关是命令行 `--multi`（`apps/game/scripts/build-dist.mjs:74`）。
- **打包内核收敛在共享层**：`cleanDist` / `bundleIife` / `bundleEsm` / `writeEmbeddedPreamble` / `rewriteIndexToClassicScript` / `cleanStale` / `copyLicensePair` / `printTree` 全部来自 `src/scripts/lib/dist-pack.mjs`（`apps/game/scripts/build-dist.mjs:37`）；本脚本只负责输入校验与形态编排。
- **输入缺失即抛错**：`requireInputs` 校验 pkg 的 wasm 与仓库根的默认纹理包（`apps/game/scripts/build-dist.mjs:78`、`:80`、`:83`），顶层 `main().catch` 打印错误后以退出码 1 结束（`apps/game/scripts/build-dist.mjs:236`）。
- **multi 形态的 SW 占位符必须被替换**：构建后若仍含占位符特征串即抛错（`apps/game/scripts/build-dist.mjs:199`、`:203`），避免发出未注入清单的 Service Worker。
- **契约检查的两级判据**：声明面逐项断言 `.d.ts` 里有同名成员（`apps/game/scripts/check-wasm-api.mjs:82`），导入面断言 `src` 下全部 `.ts` 的 pkg 导入符号是声明面的子集（`apps/game/scripts/check-wasm-api.mjs:83`）；两级都过才打印通过行并以 0 退出（`apps/game/scripts/check-wasm-api.mjs:90`、`:91`）。
- **判定行的可见性**：物理脚本把结论打在末行（例 `apps/game/scripts/phys-p2-regression.mjs:91`），是否把它映射到退出码因脚本而异。

## 已知缺口

- **契约检查的 `PHYS_API` 覆盖不完整**：清单 17 项（`apps/game/scripts/check-wasm-api.mjs:55` 起），而 `PhysWorld` 的 wasm 导出面共 24 个方法（含构造器）。逐条对照后缺 7 项：`new`（构造器，`src/phys/mod.rs:157`）、`set_state_ex`（`src/phys/mod.rs:314`）、`state_full_json`（`:327`）、`seed_from`（`:342`）、`gate_veto_count`（`:351`）、`debug_trace`（`:360`）、`take_event`（`:658`）。其中 `take_event` 被写在 `EXPORT_API` 里（`apps/game/scripts/check-wasm-api.mjs:47`），而它是 `PhysWorld` 的方法、不是 `BspProcessor` 的方法——两级清单的分类与实现不同源；两级合并后仍缺 `new` 一项。
- **`phys-p2-regression.mjs` 的 `ALL PASS` 分支在当前产物下不可达**：本次实跑该脚本，12 组里 5 组判发散（`apps/game/scripts/phys-p2-regression.mjs:81` 的判据是 `dv < 10`），末行输出为「参考矩阵：5/12 发散」，退出码 0。
- **脚本的判定不总是退出码**：本次实测 20 个脚本里只有 7 个出现 `process.exit` / `process.exitCode`（`build-dist`、`check-wasm-api`、`phys-seed-smoke`、`phys-smoke`、`phys-surf-crouch-smoke`、`phys-teleport-gate`、`wasm-hash-pin`）；其余 13 个的结论只体现在 stdout 的末行，其中包含 `phys-p2-regression`、`phys-rate-parity`、`phys-rate-parity-v2`、`phys-dual-pipe`、`phys-gate-probe2`、`phys-p2-ground`、`phys-p2-trace`、`phys-diag-flat` 与三个 `t13-*`。把这类脚本接进 CI 时，判定不会被退出码带出。
- **single 产物引用了不在保留名单里的 `coi-serviceworker.js`**：页面声明该脚本（`apps/game/web/index.html:290`），single 的保留名单不含它（`apps/game/scripts/build-dist.mjs:60`），而改写后的产物页 `apps/game/dist/index.html` 仍保留这行引用（本次实测第 276 行；该文件是构建产物、不入版本库），同目录下没有对应的脚本文件（本次实测 `apps/game/dist/` 只有 5 个条目）。后果是单文件产物在静态托管下少一条「用 Service Worker 补 COOP/COEP」的路径，页面的 `crossOriginIsolated` 由托管方的响应头决定（`apps/game/src/app.ts:102`）。
- **`mtzB64` 与契约清单都指向了没有直接调用点的字段**：`wasm-init` 的 `mtzB64`（`src/ts-shared/auth/worker-dispatch.ts:297`）在本工程无发送方；默认纹理包实际在主线程经 `buildWorldBundle` 的 `decompressMtz` 注入读取（`src/ts-shared/phys/world-builder.ts:230`、`apps/game/src/app.ts:516`），因此 `mtzB64` 这条 Worker 通道在本工程内是闲置的。
- **`PHYS_API` 里的零调用点条目**：`set_yaw_pitch` 只出现在清单里（`apps/game/scripts/check-wasm-api.mjs:72`），`apps/**` 与 `src/**` 内零调用点（本次实测）；契约检查只验声明存在，不验是否有消费者。
- **`build-dist.mjs` 的输出标签是固定文本**：single 与 multi 两条路径都打印同一组 `[5/5]` 前缀（`apps/game/scripts/build-dist.mjs:90`、`:130`），该前缀与步骤序号无关，读日志时不能按它判断当前处于第几步。
