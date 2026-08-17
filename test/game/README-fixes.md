# WebSurf-test/game — 修复版移植说明

> 2026-08-17。本目录是 `game/` 的完整自包含移植（含共享层），并按
> `docs/phys-fix-directions.md` 实施了修复。根因分析见仓根 `docs/timing-game-analysis.md`。

## 目录结构（相对本目录）

```
test/game/
  crates/
    wasm/        WASM 导出层（原 game/crates/wasm，path 依赖改写为本地 ../phys ../wasm-core）
    phys/        websurf-phys 共享物理 crate（拷贝自仓根 src/，含 P2 bevel）
    wasm-core/   websurf-wasm-core 共享解析 crate（拷贝自仓根 src/wasm-core）
  src/
    app/panel/renderer/worker/input/...   原 game/src（相对路径改写为本地 ts-shared）
    ts-shared/   共享 TS 层（拷贝自仓根 src/ts-shared）
    vendor/      vmdl vendor（Cargo.toml [patch] 指向此处）
  web/, scripts/, pkg/, serve.py, ...     同原 game 布局
```

移植改动（除修复外）：
- TS 导入路径：`../../src/ts-shared` → `./ts-shared`、`../../../src/ts-shared` → `../ts-shared`；
  `../pkg/websurf_wasm.js` 相对位置不变。
- Cargo path 依赖：`../../../src` → `../phys`、`../../../src/wasm-core` → `../wasm-core`；
  `[patch.crates-io] vmdl` 指向 `./src/vendor/vmdl`。
- phys / wasm-core 由"独立 workspace root"改为本工程 workspace 成员
  （`Cargo.toml members` 含 `crates/wasm`,`crates/phys`,`crates/wasm-core`）。

## 已实施修复（对应 docs/phys-fix-directions.md）

| 项 | 文件 | 内容 |
|---|---|---|
| P2 bevel | `crates/phys/phys/world.rs` + `mod.rs` | brush 构建期生成轴向 bevel 平面（Quake QBSP 同款：凸棱顶点枚举 → 6 轴向过棱平面 → 不切实体且不与两棱面平行者入 planes）；`mod.rs` build_world 固体分支调用 `add_axial_bevels` |
| P3-A1 | `mod.rs` state_js | 状态增加 `surfing` 字段（渲染侧坡上滑行判定） |
| P3 灌入门控 | `src/ts-shared/phys/authority-calibrator.ts` | `calibrateVelocity`：权威 grounded 且渲染线 `state().surfing === true` 时跳过 `set_velocity`（A2 位置差启发式由 A1 精确化替代）；`applyCollisionCorrection` land 分支增加前置条件（渲染线已接近着地才 snap） |
| P4-B1 | `app.ts`, `shared-state.ts`, `auth-loop.ts`, `worker-dispatch.ts`, `renderer-main.ts` | visibilitychange：隐藏 → `pause` 消息停权威自驱链 + `clearKeys()` 键位清零；可见 → 先 `sync-render-state` 对齐权威到渲染线 + 清校准器，再 `pause(false)` 恢复（清累积器防欠步狂奔） |
| P5 | `app.ts`, `input-bridge.ts`, `renderer-main.ts` | 场景加载后死亡阈值双端下发：`sendSetDeathThreshold` 补发 `set-death-threshold` 到 Worker；renderer 传 `bbox.min.y - 1000`（贴合注释语义） |
| P6 | `config.ts`, `panel-controller.ts`, `params.ts`, `worker/main.ts`, `player.rs`, `mod.rs`, `teleport.rs` | 删除死参数 `teleportGateTicks`（Rust check 签名、set_params、TS 字段/映射/面板项全清） |

## 追加风险项修复（依据 docs/timing-game-analysis.md §4）

| 风险 | 文件 | 内容 |
|---|---|---|
| 2 反向同步 vs 权威追赶竞争 | `src/ts-shared/auth/worker-dispatch.ts` | `sync-render-state`、`respawn`、`teleport`、`teleport-to-pos` 后调用 `authLoop.reset()`，清权威累积器/墙钟基准，防止旧欠步在新状态上“狂奔”补算导致再次分叉 |
| 5 渲染 dt 0.1s 无 CCD | `src/renderer/renderer-main.ts` | 渲染 tick 拆 ≤1/64s 子步，输入按时间比例分摊；消除卡顿恢复首帧高速穿薄墙风险 |
| 4 跨线程时钟裸减 | `src/ts-shared/phys/authority-calibrator.ts`（注释） | 记录为已知限制：现代浏览器同 time origin；旧环境常数偏移由 dt≤0/>0.1s 兜底为原始速度注入，无累积错误 |

## 位置兜底驳回策略（渲染位置永不被权威覆盖）

| 改动 | 文件 | 内容 |
|---|---|---|
| 位置兜底驳回 | `src/ts-shared/phys/authority-calibrator.ts` | 首帧、碰撞事件（land/blocked）、同步在途撤回全部不再 `set_state` 写回渲染；改为 `pushRenderToAuthority` 把权威位置强制跃迁到上一个渲染帧位置，并用矢量计算修正权威速度（`authVel + (renderPos - authPos)/dt`，钳 ±20000，不做碰撞检测） |
| 反向同步冷却 250→63ms | `src/ts-shared/phys/authority-calibrator.ts` | `SYNC_COOLDOWN_MS=63`；在途不再“撤回渲染”，改为 63ms 冷却反复拉权威回渲染 |

## 未实施（明确不修，按文档评估）

- P1 无终端速度钳制（sv_maxvelocity）：`[候选·可选]`，会改变长落差超速行为，由产品定。
- P7 跳跃冲量补偿：`[候选·低优先级]`，量级 1~3u 感知可忽略。
- P3 双线软锁兜底：`[观察项]`，预期 P2 根治后消失，回归未见复现。
- 反预速规则默认值（noPrestrafe / bhopSpeedClamp）：规则设计而非缺陷，配置开关已存在，默认保持 true；如需宽松 surf 手感由产品决定改 false。
- 64Hz 权威主导速度增益：双管道固有代价，不修（P3 灌入门控已缓解坡底场景）。

## 验证

```bash
npm ci
npm run build:wasm   # wasm-pack release（~8 分钟首次）
npm run build:ts     # typecheck + esbuild app/worker
node scripts/check-wasm-api.mjs
node scripts/phys-smoke.mjs
node scripts/phys-rate-parity.mjs
node scripts/phys-rate-parity-v2.mjs   # P2/P3 回归基线
node scripts/phys-teleport-gate.mjs
node scripts/phys-dual-pipe.mjs
```

结果：场景 B 幻影墙（原 Δvel 2242/2422 量级）已消除；H=2.1 全部 <10，
H=2.5 残余 43~47、H=3 vz800 残余 536 为 64Hz 粗步长接坡采样/弹道越坡差
（不是幻影碰撞；真实游玩中渲染线 144Hz 先接坡，权威由正向同步收敛）。
实验⑥（双管道"规律归零"）速度序列单调增长、仅落地后按摩擦衰减，无归零/软锁。

本地游玩：`python serve.py 8080 .` → `http://localhost:8080/web/index.html`
（需 COOP/COEP 头以启用 SAB；serve 已带）。