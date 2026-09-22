# implementation：physics

主题对应 `apps/debug/src/physics/**`，共四个模块 + 一个类型子目录：参数定义表 `param-defs.ts`、参数管理器 `physics-params.ts`、config → Rust 参数映射 `prediction-params.ts`、向量工具 `math/vec3.ts`、cs-movement 碰撞类型 `physics/Collision/Collision.types.ts`。

本目录内没有物理算法：物理在 wasm 里（共享层 `websurf-phys`），这里只有「参数定义与下发」「类型面」两类内容。

## 模块职责

**`apps/debug/src/physics/param-defs.ts`**

导出 `ParamSource`（`apps/debug/src/physics/param-defs.ts:14`）、`ParamDef`（`:17`）、`ParamState`（`:39`）、`PARAM_DEFS`（`:47`）、`findParamDef`（`:111`）。`PARAM_DEFS` 是 12 项参数定义（11 个物理参数 + `tickRate`），每项含 `name` / `label` / `kind` / `default` / `min` / `max` / `step` / `description`。默认值与 `src/phys/player.rs` 的 `PhysParams::default` 逐项同值（`apps/debug/src/physics/param-defs.ts:8`）。

**`apps/debug/src/physics/physics-params.ts`**

导出 `DEFAULT_HULL`（模块私有，`apps/debug/src/physics/physics-params.ts:20`）、`PARAM_TO_RUST`（`:31`）、`HullState`（`:46`）、`PhysicsParams`（`:54`）。`PARAM_TO_RUST` 是 11 条「面板参数名 → snake_case」映射，不含 `tickRate`（`apps/debug/src/physics/physics-params.ts:24`）。

`PhysicsParams` 公开面：`onTickRateChange`（`:72`）、`attach`（`:75`）、`setParam`（`:96`）、`setParamFromMap`（`:110`）、`resetParam`（`:116`）、`setHull`（`:127`）、`resetHull`（`:134`）、`getHullState`（`:141`）、`snapshot`（`:153`），私有 `applyOverride`（`:169`）。

**`apps/debug/src/physics/prediction-params.ts`**

只导出 `buildDebugPredictionParams`（`apps/debug/src/physics/prediction-params.ts:23`）：把 debug 的 config 字段摊成共享层 `buildPhysicsParams` 的入参，产出全量 15 键的 `set_params` 载荷。两个消费点必须取同一份结果——`RendererMain.captureReplayState` 与 `apps/debug/src/app.ts` 的 `buildPredictionParams`（`apps/debug/src/physics/prediction-params.ts:8`）。

**`apps/debug/src/physics/math/vec3.ts`**

导出 `Vec3`（`apps/debug/src/physics/math/vec3.ts:17`）与 13 个写入型函数：`vec3`（`:24`）、`copy`（`:29`）、`set`（`:37`）、`add`（`:45`）、`sub`（`:53`）、`addScaled`（`:61`）、`scale`（`:69`）、`dot`（`:77`）、`cross`（`:82`）、`length`（`:90`）、`lengthSq`（`:95`）、`length2D`（`:100`）、`normalize`（`:105`）、`clone`（`:117`）。坐标约定 Y 轴朝上。

**`apps/debug/src/physics/physics/Collision/Collision.types.ts`**

导出 `Plane`（`apps/debug/src/physics/physics/Collision/Collision.types.ts:12`）、`Brush`（`:18`）、`LadderVolume`（`:26`）、`V3Tuple`（`:32`）、`TriMesh`（`:35`）、`TraceResult`（`:49`）。`Plane` 的口径是半空间 `dot(normal, p) - dist <= 0` 为内侧。

## 关键流程与不变量

**参数的写入通路（两条互不重叠）**：

- 面板可调项：`setParam` 先按 `ParamDef` 的 `min` / `max` 钳制数值型，再写覆盖表并立即下发（`apps/debug/src/physics/physics-params.ts:96`）；单点下发查 `PARAM_TO_RUST`，查不到就不发（`apps/debug/src/physics/physics-params.ts:175`）。
- 全量参数：共享层 `buildPhysicsParams` 一次写全 15 键，调用点是 Worker 的 `syncParamsToWasm` 与主线程的 `buildDebugPredictionParams`（`apps/debug/src/physics/physics-params.ts:26` 起）。

**`tickRate` 的特殊路径**：它不是 Rust 键，`applyOverride` 对它改走 `onTickRateChange` 回调；`attach` 在重放覆盖表时最后补一次该回调，使进图前调好的值覆盖 `world-json` 构建时按 config 设下的固定步长（`apps/debug/src/physics/physics-params.ts:24`、`:87`）。

**碰撞箱**：`DEFAULT_HULL` 三围与 `src/phys/player.rs` 的三个默认常量同值（16 / 72 / 54）；`setHull` 与 `resetHull` 都立即写 Rust，来源分别记 `manual` / `mode-default`（`apps/debug/src/physics/physics-params.ts:19`、`:127`、`:134`）。

**快照口径**：`snapshot` 按 `PARAM_DEFS` 顺序逐项产出，有覆盖取覆盖值与来源，否则取定义默认值 + `mode-default`（`apps/debug/src/physics/physics-params.ts:152`）。

**debug 没有独立的走路 / 蹲走配置项**：`walkSpeed` / `crouchSpeed` 写死 130 / 85，`autobhop` 与 `bhopSpeedClamp` 写死 true，与 `PARAM_DEFS` 的定义默认值一致（`apps/debug/src/physics/prediction-params.ts:13`、`:35` 起）。

**不变量**：

- `PARAM_DEFS` 的顺序即面板行顺序，也是 `snapshot` 的顺序（`apps/debug/src/physics/param-defs.ts:46`）。
- `setParamFromMap` 不钳制、不查 `PARAM_DEFS`，与 `setParam` 的语义不同（`apps/debug/src/physics/physics-params.ts:109`）。
- `PhysicsParams` 的覆盖表是每实例一份；`attach(null)` 只解绑，不写任何物理（`apps/debug/src/physics/physics-params.ts:76`）。
- `prediction-params.ts` 的两处消费点取同一函数、同一份 config，保证主线程与 Worker 用同一份参数（`apps/debug/src/physics/prediction-params.ts:8`）。

## 已知缺口

1. **`vec3.ts` 的 13 个函数零调用点**：`vec3` / `copy` / `set` / `add` / `sub` / `addScaled` / `scale` / `dot` / `cross` / `length` / `lengthSq` / `length2D` / `normalize` / `clone` 在 `apps/debug/src` 与 `src` 内都只有本文件的定义；被引用的是 `Vec3` 接口，由 5 个文件以 `import type` 取用（`apps/debug/src/physics/math/vec3.ts:11` 起）。
2. **`setParamFromMap` 零调用点**：`apps/debug/src/physics/physics-params.ts:110` 的导出在仓内无调用点，`map` 来源的覆盖只能在 `snapshot` 的类型面里出现（`apps/debug/src/physics/param-defs.ts:14`）。
3. **`TraceResult` 与 `V3Tuple` 的消费面不在本目录**：`TraceResult`（`apps/debug/src/physics/physics/Collision/Collision.types.ts:49`）在本工程内无消费点；`TriMesh` 的实际消费方是 `apps/debug/src/renderer/collider-debug.ts:29`。
4. **`PARAM_DEFS` 的定义默认值与 config 的默认值存在两套来源**：面板侧默认值来自 `PARAM_DEFS`（`apps/debug/src/physics/param-defs.ts:47`），配置侧默认值来自 `apps/debug/src/config.ts:205`；两侧同名量的数值由代码各自写死，没有交叉校验。其中 `jumpHeight`（面板键，默认 57）与 `config.physics.jumpSpeed`（默认 302）分别经 `PARAM_TO_RUST` 与共享层映射写进同一个 Rust 键 `jump_height`（`apps/debug/src/physics/physics-params.ts:40`、`apps/debug/src/physics/prediction-params.ts:31`）。
5. **`teleportGateTicks` 不改变行为**：面板参数表不含该键，它只从 config 经 `buildDebugPredictionParams` 写进 `set_params` 的 `teleport_gate_ticks`（`apps/debug/src/physics/prediction-params.ts:39`），而该键在 Rust 判定侧未被读取。
