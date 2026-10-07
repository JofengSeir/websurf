# implementation：world

主题对应 `apps/debug/src/world/**`，共五个模块：WASM JSON 类型面 `types.ts`、brush 映射层 `collider-adapter.ts`、传送点数据层 `teleport-manager.ts`、自定义传送点 `custom-teleports.ts`、出生点加载器 `spawn-loader.ts`。

## 模块职责

**`apps/debug/src/world/types.ts`**

标注 `BspProcessor` 各导出方法的返回形状。导出：`WasmTriMesh`（`apps/debug/src/world/types.ts:34`）、`WasmBrushPlane`（`:48`）、`WasmBrush`（`:57`）、`WasmSpawnPoint`（`:77`）、`WasmSpawnReport`（`:93`）、`WasmTeleportDest`（`:108`）、`WasmTeleportTrigger`（`:128`）、`WasmTeleportLink`（`:163`）、`WasmTeleportReport`（`:171`）、PVS 三类转出（`:200`）、`WasmBspMetadata`（`:207`）、`ColliderFilter`（`:252`）、`DEFAULT_COLLIDER_FILTER`（`:269`）。

命名与坐标约定：除 PVS 外全是 snake_case（Rust 结构体没有 `rename_all`）；所有向量在导出路径上已做过 `[x,y,z] → [y,z,x]` 循环置换，JSON 里已是 Y-up（`apps/debug/src/world/types.ts:7` 起）。

**`apps/debug/src/world/collider-adapter.ts`**

导出 `BrushNormalCheck`（`apps/debug/src/world/collider-adapter.ts:48`）、`NormalCheckReport`（`:66`）、`AdaptedBrushes`（`:132`）、`AdaptBrushStats`（`:142`）、`adaptBrushes`（`:182`）、`verifyOutwardNormals`（`:269`）、`formatAdaptStats`（`:330`）。阈值常量 `MIN_PLANES_PER_BRUSH`（`:167`）与 `MIN_AABB_SIZE`（`:170`）。

它把 `export_brushes_planes` 的 `WasmBrush[]` JSON 映射成 cs-movement 形状的 `Brush[]` / `LadderVolume[]`，供 `apps/debug/src/renderer/collider-debug.ts` 画 brush 线框、`apps/debug/src/renderer/plane-inspector.ts` 做准星拾取。物理侧另有一份同源解析：Worker 的 `PhysWorld::build_world` 吃同一份 `brushJson`（`apps/debug/src/world/collider-adapter.ts:6` 起）。

**`apps/debug/src/world/teleport-manager.ts`**

导出 `TeleportTriggerMode`（`apps/debug/src/world/teleport-manager.ts:58`）、`TeleportDestination`（`:68`）、`TeleportTrigger`（`:89`）、`TeleportManager`（`:135`）。类内成员：构造（`:160`）、`setTriggerMode`（`:209`）、`setGroundedFramesRequired`（`:226`）、`onTeleported`（`:235`）、`checkTeleport`（`:265`）、`triggerCount`（`:371`）、`getTriggers`（`:377`）、`destCount`（`:382`）、`resetCooldown`（`:387`）。两个模块常量：`TRIGGER_RADIUS`（`:46`）、`TRIGGER_COOLDOWN`（`:49`）。

**`apps/debug/src/world/custom-teleports.ts`**

导出 `CustomTeleport`（`apps/debug/src/world/custom-teleports.ts:13`）、`loadCustomTeleports`（`:42`）、`saveCustomTeleports`（`:63`）、`addCustomTeleport`（`:72`）、`removeCustomTeleport`（`:88`）、`clearCustomTeleports`（`:97`）。持久化键前缀 `STORAGE_PREFIX`（`:27`）、每图上限 `MAX_PER_MAP`（`:30`）。每个函数各自 `try/catch`，存储不可用时降级为空列表或忽略写入（`apps/debug/src/world/custom-teleports.ts:5`）。

**`apps/debug/src/world/spawn-loader.ts`**

导出 `SpawnLoadResult`（`apps/debug/src/world/spawn-loader.ts:24`）、`LoadedSpawnPoint`（`:36`）、`loadSpawnPoints`（`:64`）、`getSpawnPointByIndex`（`:105`），另有默认 yaw 常量 `DEFAULT_YAW`（`:53`）。yaw 换算直接调共享层 `bspYawToCsYaw`（`apps/debug/src/world/spawn-loader.ts:17`）。

## 关键流程与不变量

**brush 映射的输入约定（上游已做，本层不做几何变换）**（`apps/debug/src/world/collider-adapter.ts:14` 起）：

- 坐标已是 Y-up；法线已翻成朝外（上游对每个平面取 `normal = -rotate_yup(n)`、`dist = -dist`），使内部满足 `dot(normal, p) - dist <= 0`，与 `Collision.types.ts` 的 `Plane` 同口径。
- `planes` = 该 brush 的**真实面 + BSP 原生 bevel side**（`side.bevel != 0`，编译器为"盒子别卡在棱上"生成的过棱小平面）。运行时合成切角平面的旧机制已整段撤除（owner 裁决，见 `progress/open-issues/01` §9）：bevel 平面过棱、与斜面的半空间交集在脊下方完全重合 ⇒ 不放大实体体积；`surf_666` 实测 bevel side 18157 条（4278 个 brush），撤合成改保留后平面总数 124939 → 58575，刀刃脊站立与三出生点行为逐位不变。
- 每个平面另带 `is_bevel`（是否来自 bevel side，随平面透传）。bevel 的**生成原理**（VBSP `AddBrushBevels`，SDK `src/utils/vbsp/map.cpp`）：box bevel 补齐 brush 缺失的轴向包围面、edge bevel 沿非轴向棱的每条边试六个"斜切轴面"、要求凸包全部顶点落在面内侧（容差 0.1 HU）；且 `MakeBrushWindings` 在算各侧 winding 时**跳过 bevel 侧** ⇒ 它们不裁剪几何、不构成实体表面，只服务引擎按盒体扩张碰撞凸包时在棱处的贴合支撑（本仓 `src/phys/bevel_rest_tests.rs` 钉住：撤掉 bevel 盒底虚浮到脊线上方 ≈20.5 HU）。`is_bevel` 与 `is_real_face` 正交：bevel 平面大多不构成有面积的面，少数照实构成。
- 每个平面另带 `is_real_face`（该平面在凸包上是否构成有面积的真实面，判据见 `apps/debug/crates/wasm/src/lib.rs` 的 `plane_is_real_face`：面上凸包顶点 ≥ 3 且不共线，取直径最远一对作基线、其余点垂距最大值 ≥ `MIN_FACE_WIDTH = 0.5` HU）。**不能用 Newell 多边形面积判**——它要求顶点按边界环序排列，而顶点是 `compute_vertices` 按平面三元组下标枚举产出的、不是环序，叉积互相抵消使面积恒算成 0（实测五棱柱 7 张真实面被误判 5 张）。bevel 平面大多不与凸包顶点构成有面积的面而判 `false`（显示端不画），少数构成可量多边形的照实判 `true`——它们确实参与逐平面裁剪，显示与物理一致。`min` / `max` = 凸包顶点旋转到 Y-up 后逐轴极值。

**映射的分支与不变量**：顺序固定——既非 solid 又非 ladder 的 brush 直接跳过；平面数组为空或平面数低于 `MIN_PLANES_PER_BRUSH` 时跳过；AABB 任一边小于 `MIN_AABB_SIZE` 时跳过（`apps/debug/src/world/collider-adapter.ts:167` 起）。`verifyOutwardNormals` 提供独立的正反校验并输出 `NormalCheckReport`（`apps/debug/src/world/collider-adapter.ts:269`）。

**传送点的实际运行路径不在本模块**：运行期传送由 `src/phys/teleport.rs` 的判定在权威物理内完成，主线程收事件的唯一入口是共享层 `src/phys/mod.rs` 的 `take_event`（`apps/debug/src/world/teleport-manager.ts:13` 起）。本模块当前只承担「解析 JSON + 暴露触发器列表」：`getTriggers()` 是唯一被外部调用的成员，消费点是 `RendererMain.loadScene`（`apps/debug/src/renderer/renderer-main.ts:484` 起），产出交给 `ColliderDebug.setTriggers`（触发区线框）与 `PlaneInspector`（准星拾取触发器 AABB）。

**自定义传送点的数据流**：列表按地图名分组存在 `localStorage`，主线程的列表渲染、新增、删除、清空与「传送到该点」按钮由 `apps/debug/src/app.ts` 承担（`apps/debug/src/world/custom-teleports.ts:8`）；其中 `saveCustomTeleports` 只被本文件的 `addCustomTeleport` 与 `removeCustomTeleport` 调用（`apps/debug/src/world/custom-teleports.ts:9`）。

**不变量**：

- `adaptBrushes` 的输出只填 `RendererMain` 的本地数组（`solids` / `ladders` / `colliders`），不影响权威物理（`apps/debug/src/world/collider-adapter.ts:9`）。
- `CustomTeleport.yaw` 为 `null` 表示传送时保持当前朝向（`apps/debug/src/world/custom-teleports.ts:20`）。
- 出生点向量的 Y-up 置换由上游完成，TS 端不二次映射（`apps/debug/src/world/spawn-loader.ts:5`）。

## 已知缺口（状态见 TODO.md）

1. **`TeleportManager` 的六项成员零调用点**：`checkTeleport`、`setTriggerMode`、`setGroundedFramesRequired`、`onTeleported`、`resetCooldown`、`triggerCount`、`destCount` 在 `apps/debug/src` 与 `src` 内只出现在本文件的定义与注释里，没有外部调用点（`apps/debug/src/world/teleport-manager.ts:18` 起）。三种触发模式的判定与冷却状态机在本工作区内不参与运行。 （见 TODO.md T-322）
2. **`spawn-loader.ts` 整模块零调用点**：全仓无模块 import 它（`apps/debug/src/world/spawn-loader.ts:11`、`:64`、`:105`）；出生点加载的实际链路是共享层 `src/ts-shared/phys/world-builder.ts` 直接消费 `parse_spawn_points` 的 JSON。 （见 TODO.md T-323）
3. **`types.ts` 里有一批零引用类型**：`WasmTriMesh`、`WasmTeleportLink`、`WasmBspMetadata`、`ColliderFilter`、`DEFAULT_COLLIDER_FILTER` 在 `apps/debug/src` 与 `src` 内零引用（`apps/debug/src/world/types.ts:18`）。`triJson` 的实际消费方用的是 `apps/debug/src/physics/physics/Collision/Collision.types.ts` 的 `TriMesh`（比 `WasmTriMesh` 多一个可选 `surfaceprop`）。 （见 TODO.md T-324）
4. **`formatAdaptStats` 与 `verifyOutwardNormals` 的消费面窄**：两者都只在诊断调用点使用（`apps/debug/src/world/collider-adapter.ts:269`、`:330`），运行期映射只走 `adaptBrushes`。
5. **`MAX_PER_MAP` 与 `STORAGE_PREFIX` 的可用性受浏览器存储限制**：写入失败时被静默忽略，调用方拿不到失败信号（`apps/debug/src/world/custom-teleports.ts:5`、`:63`）。（见 TODO.md T-311）
