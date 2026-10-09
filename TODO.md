# 待办看板（TODO Board）

> **唯一事实来源**：所有待裁决 / 待修 / 已取证待立项 / 进行中事项的**状态只在本页登记**。
> 其余文档只写技术事实，不复述状态；代码注释只允许写「见 TODO.md T-###」。
> 规则：一行一条；ID 永不复用；结案保留 ID；**改代码或裁决的同一提交必须更新对应行**。
> 台账号（原 AGENTS §7.3 的「N 条」聚合行）在底层条目细化后**保留原行**、置 `已记录` 并在事项前标「【台账号·已细化】」，只作编号追溯，不再承载状态；未完全细化者保留原状态并标注已细化部分。
> **体量策略**：本表超过 **96 KB 或 300 条**时，按两级处理——①把「已记录 + 已结案」整段移入 `progress/board/archive-<年-月>.md`（**未结项永不分卷**；2026-10-07、2026-10-09 各触发一次）；②若已分卷后仍超限，则**逐行精简**：`证据`/`判据` 超长的改写为「见详情」并把全文移入该行详情页，`事项` 一律 ≤ 120 字符。体检 `[H]` 硬查 96 KB。**分卷/归档前先取许可**：`node src/scripts/docflow.mjs approve --path TODO.md --by <谁> --reason 分卷`，移完再 `sync`（本表不许 agent 删行，无许可 `sync` 会保留旧钉、体检逐条报「单元被删除」）。
> **ID 分配**：新条目取**所属区段的下一个未用号**——viewer `T-1xx`、game `T-2xx`、debug `T-3xx`、shared `T-4xx`、取证项 `T-5xx`、跨区/文档治理 `T-6xx`；**已出现过的号永不复用**。
> **下一可用号（实测，含 `progress/board/archive-2026-10.md` 的历史行；只写数字部分）**：viewer **171**；game **240**；debug **325**；shared **454**；取证项 **508**；跨区/文档治理 **611**。分配新条目后同步更新本行。
> **ID 引用纪律**：全仓任何 `T-###` 写法都必须对应表里**真实存在**的行（体检 `[G]` 硬查）；**不要写「未来号 / 预留号」**——2026-10-07 实测：把头注里的「下一可用号」写成 `T-1xx` 的具体号后，门禁立即报 6 条悬空 ID。所以「下一可用号」只写数字部分，区段前缀由上两行给出。
> **两份表示同源**：「未结项」列表由总表按状态生成；**改状态/证据只改总表**，两者必须一致（体检 `[G]` 把关）。
> **验收判据（D-001 起必填）**：`待修` 行的「判据」列必须给出**可执行命令 + 期望输出**（**行为要求见 `AGENTS §0.1` 第 3 条**）；体检 `[G]` 现在只**计数**（`[待补]` 的条数），补齐后转硬门。
> **认领（D-004 起）**：`进行中` 行的状态要写成 `进行中 · <agent> · <YYYY-MM-DD>`。（行为要求见 `AGENTS §0.1` 第 2 条）
> **阻塞（D-003 起）**：卡住等 owner / 等外部条件时置 `阻塞`（`阻塞：等 owner` / `阻塞：等外部`），文件保持未提交，并按 `AGENTS §0.3` 登记 `OWNER.md`。（行为要求见 `AGENTS §0.1` 第 2 条）


## 状态口径

| 状态 | 含义 |
|---|---|
| 待裁决 | 修法有分歧，或改动会动到行为契约，需要 owner 定 |
| 待修 | 修法明确、改动局部，可直接排期 |
| 已取证待立项 | 根因清楚但工作量超出一次改动，需要单独任务书 |
| 进行中 | 已开工，尚未收口 |
| 阻塞 | 卡住：等 owner 裁决 / 等外部条件；文件保持未提交，已登记 OWNER.md |
| 已记录 | 已知事实 / 工具边界，无需行动，仅备查 |
| 已结案 | 已按结论改完，或已判定无需行动 |

## 未结项（74 条）
### 待裁决（0）


### 待修（71）
- **T-008** apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new …　`game`
- **T-046** debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份…　`debug`
- **T-047** game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap…　`debug`
- **T-062** 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径…　`viewer`
- **T-114** 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems）　`viewer`
- **T-118** A-B 区间带恒不显示（宽度算式分子恒等于分母）　`viewer`
- **T-147** 材质去重键是材质名，同名材质被后续模型复用　`viewer`
- **T-166** `ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点　`viewer`
- **T-206** `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃　`game`
- **T-211** `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造　`game`
- **T-225** `physics.mode` 零读取点　`game`
- **T-226** `sendSetDeathThreshold` 零调用点　`game`
- **T-227** 共享层的累积路径无消费方　`game`
- **T-228** `sampleEpoch` 字段只写不读　`game`
- **T-229** `applyCollisionCorrection` 的入参有三个不被读取　`game`
- **T-230** 光照模块内多个导出在本工程零导入点　`game`
- **T-231** `SavePoint.t` 只写不读　`game`
- **T-232** `getMap()` 零调用点　`game`
- **T-233** `clear()` 零调用点　`game`
- **T-234** `mtzB64` 与契约清单都指向了没有直接调用点的字段　`game`
- **T-235** `apps/game/src/world/types.ts` 在本工程零导入点　`game`
- **T-236** `export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点：…　`game`
- **T-239** `worker-types.ts` 里多条声明在本工程无发送方且无接收点　`game`
- **T-308** 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套　`debug`
- **T-312** `tsconfig.json` 的五个路径别名零导入点　`debug`
- **T-313** `keysFromMask` 无调用点　`debug`
- **T-314** `InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄　`debug`
- **T-315** `vec3.ts` 的 13 个函数零调用点　`debug`
- **T-316** `setParamFromMap` 零调用点　`debug`
- **T-317** `TraceResult` 与 `V3Tuple` 的消费面不在本目录　`debug`
- **T-319** `assignClusterIds` 的结果无消费方　`debug`
- **T-320** 默认导出与 `parse_bsp` 在本工程零调用点　`debug`
- **T-322** `TeleportManager` 的六项成员零调用点　`debug`
- **T-323** `spawn-loader.ts` 整模块零调用点　`debug`
- **T-324** `types.ts` 里有一批零引用类型　`debug`
- **T-402** `compute-mode` 的三模式接线　`shared`
- **T-403** `MouseBuffer.push` / `drain`　`shared`
- **T-404** `ShmState.wake`　`shared`
- **T-405** `maskToKeys`　`shared`
- **T-406** `PvsManager.getFaceCluster` / `visibleClusterCount`　`shared`
- **T-407** `world/types.ts` 的 `rootNode` 字段　`shared`
- **T-408** `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de…　`shared`
- **T-409** `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI）　`共享`
- **T-443** 帧探针补 `applyPoseAt(pos, yaw, pitch)`（现只有 spawn/surface 预设），脚本才能钉任意位姿出图　`debug`
- **T-441** 置换面碰撞**分块懒加载**（D-017 裁决）：避免一次性 ~13MB JSON / 13 万三角形入物理　`shared`
- **T-607** GitHub Pages 站点会被「从分支构建」的内部 Jekyll 构建静默顶掉（站点根变 README 渲染页），部署链无断言/告警　`repo`
- **T-609** 终态行的「判据」列按行态保护（改终态判据须先 approve）　`repo`
- **T-433** prop 逐顶点光照（`sp_<i>.vhv`）与 leaf ambient cube 的组合口径：D-016 已决「相加」，而现实现是 either/or + 乘法　`shared`
- **T-103** ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动）　`viewer`
- **T-139** 导航缺「卸载地图」入口，载入过地图后回不到空态　`viewer`
- **T-214** 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态　`game`
- **T-306** lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform　`debug`
- **T-053** viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/…　`viewer`
- **T-056** 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局…　`game`
- **T-111** svc_CreateStringTable 的压缩标志未实现　`viewer`
- **T-116** 注入期 throw 不在本工程调用方 catch 覆盖范围内　`shared`
- **T-117** broken 阶段对照靠失配字面量维持，three 升级需同步　`shared`
- **T-125** 零帧轨道的口径不一致（列表面板有卡片、3D 无对象）　`viewer`
- **T-203** 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈　`game`
- **T-204** `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指）　`game`
- **T-212** `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图　`game`


- **T-611** 文档锚点「行号陈旧」体检抓不到：docflow 钉的是「该行当前内容」而非「文档所称符号所在行」，故行号已指错、只要内容稳定就永远绿灯（2026-10-09 实测：`documents/viewer/implementation/core.md` 的 `apps/viewer/src/core/scene.ts:168` 实际指向 `this.pvs = …` 而非 `mountGlb`，体检仍全绿；同篇另有 8 处行号整体偏离 5–15 行）　`owner`
- **T-618** 氛围机制剩余缺口（tonemap/color_correction、env_sun、粒子 .pcf、env_fade、fogcolor2/fogblend）　`shared`
- **T-619** owner 反馈：雪盖疑似消失（未复现，待视点）+ 石头模型偏黑（30 个 rock03 报警疑假阳性）　`shared`
- **T-624** viewer 无 LOD/PVS 剔除（全量绘制）　`viewer`
- **T-627** `$bumpmap` 法线贴图未接线（冰面缺凹凸高光细节）　`shared`
- **T-170** viewer 不导出实体放置模型（`entities` 恒空）⇒ 实体模型完全不渲染　`viewer`
- **T-450** 实体放置模型无烘焙光照（无 `_VBSP_VLIGHT`/`extras.ambientCube`）⇒ 恒 fullbright　`shared`
- **T-451** 三端 GLB 门禁只覆盖 debug↔game 且只比材质/图片（viewer、属性、extras 全盲）　`shared`
- **T-452** `s1_ramp1b` 逐顶点光照条纹（三端数据相同；疑在合并期 + 反条纹档默认关）　`shared`
- **T-453** 三端呈现/画质档不同源（game 面板档 + 画质；debug 只默认档；viewer 皆无）⇒ 见 T-454 P1（D-108 已决 2026-10-09）　`shared`
- **T-454** 渲染链三端统一（任务书见详情；除 debug 调试绘制外全部收敛到共享层）　`shared`
### 已取证待立项（2）
- **T-109** 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正　`viewer`
- **T-115** untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查　`viewer`

> 已记录 / 已结案 **183 条已分卷**（`progress/board/archive-2026-10.md` 等 3 卷）；2026-10-09 再分卷 32 条 ⇒ [`archive-2026-10-4.md`](progress/board/archive-2026-10-4.md) / [`archive-2026-10-5.md`](progress/board/archive-2026-10-5.md)（ID 与状态保留；编号不复用，取新号时连同这些页一起数）。

| T-618 | 氛围机制剩余缺口（tonemap/color_correction、env_sun、粒子 .pcf、env_fade、fogcolor2/fogblend） | 缺失 | shared | 待修 | **待修（2026-10-09 登记）**。T-617 的完整性矩阵（`documents/debug/implementation/renderer.md` 的「环境氛围机制完整性矩阵」）里仍未实现的四项：① `env_tonemap_controller` / `color_correction` —— `surf_boreas` 没有这两个实体（故不属 T-617 缺口），但 `surf_null` / `surf_sedona` / `tsurf_concretejungle_b16` 有（后者还带 `color_correction`）⇒ 那三张图的 HDR 曝光与颜色查找表未复现；② `env_sun` 光晕 sprite（`sprites/light_glow02_add_noz` 不在 pakfile，需兜底或跳过）；③ 粒子：本图用 `info_particle_system` + 自定义 `tendies_alch01`，复现需 CS:GO `.pcf` 粒子格式；④ `env_fade` 过场淡出、`fogcolor2`/`fogblend` 朝日雾色渐变（后者全部夹具图 `fogblend = 0`）。 | progress/pending-detail.md | ① 对 `surf_null`/`surf_sedona`/`tsurf_concretejungle_b16`：解析 `env_tonemap_controller`（`tonemap` 键）与 `color_correction`（LUT 名），并在渲染端接线 ⇒ 同一视点与不接线时的像素对比有可量化差异；② `.pcf`：`pakfile` 内是否存在 `particles/*.pcf`（`python -c` 列 zip 名）与格式可行性报告；③ 三端 `npm run typecheck` exit 0 | 新 |
| T-619 | owner 反馈两项：雪盖疑似消失（未复现，待视点）+ 石头模型偏黑（30 个 rock03 报警疑假阳性） | 缺陷 | shared | 待修 | **待修（2026-10-09 登记，owner 反馈「雪盖消失 / 石头模型有点黑」）**。**① 雪盖**：在 game 同一次加载内做双档 A/B（默认 `exposure 2.0 / lightGamma 1.0` vs 旧档 `2.3 / 2.2`，同视点、隐藏面板）：全帧均值 178.6 → 199.5、**上 40%（天空+雪）两档逐像素相同（均值 204.3 / 近白 49.9%）**、差异只在下 60% 的暗部（161.6 → 196.3）⇒ 雪**在位且亮部无变化**，当前视点复现不出「消失」；控制台 `[world-transition] 双贴图地形混合：登记贴图 1 张，注入材质 359 个` 证明雪混合链路在工作。**待 owner 给视点/出生点**才能定位是哪个区域。**② 石头偏黑**：控制台 `[vertex-lighting] 真漏网=30`，逐名打印后全部是 **`rock03_giantmdl#4/#5/#6/#15/#18…@rock03`**（`MeshBasicMaterial｜hl=undefined｜cb=0｜uv1=0`）；新增的 `fullbright 路由分诊` 显示 `带 vlight 且已注入=173 / 无 vlight=928 / unlit=1182`（合计 2283 = 全部 fullbright 图元）⇒ **这 30 个不在任何一桶**，是在装配/几何合并后从兄弟图元**继承**了 `_VBSP_VLIGHT` 属性而材质仍是 fullbright ⇒ 该报警**疑为统计假阳性**（口径需收窄到「无注入记录 且 该 mesh 自己的材质不是 fullbright 材质」）。巨石变黑的**真因尚未钉死**：候选是 `.vhv` 的 per-mesh 附着/strip 重排在该模型上部分失败，或 fullbright+cube 兜底本身偏暗。**③** 另需注意：`lightGamma 1.0` 使 prop 项的指数由 `^1` 变 `^(2.2/g)=^2.2`（把 lightmap 空间的 `.vhv` 还原成线性，SDK 口径正确），这本身会让岩石比旧档更暗。 | progress/pending-detail.md | ① 雪：owner 给出视点（出生点名或坐标）后，同视点与旧档 A/B ⇒ 该区域雪面亮度两档差 ≤ 5% 即判「雪未丢」，否则定位该区域的混合权重/材质；② 石头：`rock03_giantmdl` 在 `.vhv` 侧的依附检查 —— 导出该 prop 的 `sp_<i>.vhv` 的 mesh 数与模型 mesh 数对比，找出缺失的那个 mesh（缺则补，不成立则改兜底口径）；③ game 载入 `test/maps/surf_boreas.bsp` ⇒ 控制台「真漏网」计数在口径收窄后由 30 变为 0 或列出真阳性；`apps/{debug,game,viewer} npm run typecheck` exit 0 | 新 |
| T-624 | viewer 无 LOD/PVS 剔除（全量绘制；debug 距离剔除、game 距离+PVS） | 缺失 | viewer | 待修 | **待修（2026-10-09，第 3 轮全链条分析发现）**。三端剔除链不一致：debug 用 `apps/debug/src/renderer/lod-manager.ts`（只按距离 `cullDistance`，默认 12800）；game 在 `apps/game/src/renderer/renderer-main.ts` 内联「距离 + 可选 PVS」；**viewer 在 `apps/viewer/src` 里没有任何剔除逻辑**（grep `lod`/`cullDistance` 只命中 replay 面板的 `visible` 开关）⇒ viewer 全量绘制所有块。属可见性/性能差异，**不是光照链分歧**（debug HUD 在同视点显示 `隐藏 0`，即未剔任何块）。 | progress/pending-detail.md | viewer 载入 `test/maps/surf_boreas.bsp` ⇒ 控制台出现与另两端同口径的剔除统计（可见/剔除块数）；三端 `npm run typecheck` + `build:app` exit 0；`node src/scripts/check-doc-drift.mjs` A–P 全 0 | 新 |
| T-627 | `$bumpmap` 法线贴图未接线（冰面缺凹凸高光细节） | 缺失 | shared | 待修 | **待修（2026-10-09，第 8 轮从 VMT 对照发现）**。`materials/project_tendies/models/ice_transparent.vmt` 声明 `$bumpmap surf_lt_alpine/alpine_snow01_normal`，但我们的材质管线既不解析也不渲染法线贴图（`parse_vmt` 无 `$bumpmap`、`MeshBasicMaterial` 无 tangent/normal 通路）⇒ 冰面只有平面反射、没有凹凸细节。T-626 修复的是「异常黑」（`$envmap`），本条是配套的细节保真缺口。 | progress/pending-detail.md | 导出侧保留 `$bumpmap` 并接线（three 侧 Basic 材质不支持法线 ⇒ 需换受光材质或自定义注入）；修复后同机位冰坡出现凹凸高光细节；三端 typecheck + build:app exit 0；`node src/scripts/check-doc-drift.mjs` A–P 全 0 | 新 |
## 总表（74 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 判据 | 原号 |
|---|---|---|---|---|---|---|---|---|
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | 配置·门禁 | game | 待修 | apps/game/scripts/check-wasm-api.mjs:52-70 | progress/pending-detail.md | 判据：跑 @BT@node apps/game/scripts/check-wasm-api.mjs@BT@ ⇒ exit 0，且 PHYS_API 列出的项 ≥ crates/wasm 实际导出数（不再缺 @BT@new@BT@ 等） | #9 |
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:478 | progress/pending-detail.md | 判据：@BT@getLightingMode@BT@ 清点调用点（@BT@apps/debug/src/renderer/renderer-main.ts:478@BT@ 疑有一处）⇒ 真零调用则删，否则结案并改状态 | #78 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | 未接线·死代码 | debug | 待修 | apps/game/src/app.ts:170 | progress/pending-detail.md | 判据：@BT@git grep -n "resetTo\ | \.stop(" -- src apps@BT@ ⇒ 无外部调用点则删；有则接线并补调用 | #79 |
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:110 | progress/pending-detail.md | 判据：帮助文案与 `apps/viewer/src/replay/timeline.ts` 现行类名/样式一致（无「淡金带 / 金框」残留） | #84 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 缺陷 | game | 待修 | 见详情 | progress/pending-detail.md | 判据：F5 / 刷新不弹关闭确认，仅在有地图 / 对局中弹（条件化） | #87 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/panel.ts:283 | progress/pending-detail.md | 判据：@BT@git grep -n "importer" -- apps/viewer/src@BT@ ⇒ Source .dem 分支无 UI 调用路径 ⇒ 删或接线 | #93 |
| T-103 | ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动） | 缺陷 | viewer | 待修 | apps/viewer/src/app.ts:807 | documents/viewer/implementation/app.md | 判据：`?replay=x.dem` ⇒ 按内容（魔数）分派并载入成功（不再按参数名拒收） | — |
| T-109 | 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/net.ts:325 | documents/viewer/implementation/dem.md | — | — |
| T-111 | `svc_CreateStringTable` 的压缩标志未实现（**待确认**：缺省 `readCompressedFlag = false`，代码根本不去读那一位 ⇒ 现有 4 份夹具「无压缩」这一结论**无法由探针证实**） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/demo/net.ts:709 | documents/viewer/implementation/dem.md | **需要一份压缩位置位的样本**才能开工：`test/replay/auto-20260929-192716-surf_sedona.dem` 及其余 3 份夹具均未触发压缩告警，但缺省关闭时该位不读、故不能反证不存在；判据维持「压缩标志分支解出（不再跳过）」 | — |
| T-114 | 一组逆向期诊断开关仍留在生产代码里（**实测仍在**：`mergeVectorElems` + 10 个 `NetContext` 开关；判据的 `git grep` 非 0） | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/demo/net.ts:269 | documents/viewer/implementation/dem.md | `git grep -n "mergeVectorElems" -- apps src` ⇒ 仍 3 处（`apps/viewer/src/replay/demo/tables.ts:253` / `:447` / `:450`）；10 个诊断开关仍分布在 `apps/viewer/src/replay/demo/net.ts` 与 `demo.ts` | — |
| T-115 | untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/demo.ts:866 | documents/viewer/implementation/dem.md | — | — |
| T-116 | 注入期 throw 不在本工程调用方 catch 覆盖范围内 | 缺陷 | shared | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1104 | documents/viewer/implementation/renderer.md | 判据：注入期抛错 ⇒ 调用方 catch 覆盖（探针构造 throw 路径） | — |
| T-117 | broken 阶段对照靠失配字面量维持，three 升级需同步 | 工具·流程 | shared | 待修 | src/renderer-shared/shader/lightmap-shader.ts:346 | documents/viewer/implementation/renderer.md | 判据：three 升级后 broken 阶段对照仍有效（对失配字面量加断言，缺失即失败） | — |
| T-118 | A-B 区间带是冗余死 UI（窗口恒等于区间 ⇒ 永不显示）⇒ 删除 band + `.tl-zone-ab` + `profile.abRange` | 缺陷 | viewer | 待修 | **2026-10-09 重新取证：原断言（「宽度算式分子恒等于分母」是缺陷）被推翻**。`rangeStart`/`rangeEnd` **就是** A-B 区间（`apps/viewer/src/replay/player.ts:32` 到 `apps/viewer/src/replay/player.ts:34`，由「A 起点 / B 终点」按钮按当前时间写入，`apps/viewer/src/replay/timeline.ts:317` 到 `apps/viewer/src/replay/timeline.ts:329`），`rangeStop` 由 `min(rangeEnd, duration)` 推出（`apps/viewer/src/replay/player.ts:83` 到 `apps/viewer/src/replay/player.ts:85`），且**播放窗口就是该区间**（没有第二个窗口旋钮）⇒ 区间带分支里 `winStart = rangeStart`、`winLen = rangeStop − rangeStart`，宽度恒等于 100，落不进 `width < 99.95` ⇒ **按设计**被抑制。区间本身可见（滑杆跨度 + `t0 → t1` 读数，`apps/viewer/src/replay/timeline.ts:448` 到 `apps/viewer/src/replay/timeline.ts:450`）。⇒ 该行重定性为「**区间带是冗余死 UI**」（D-103：死代码不就地删、先登记），修法 = 删除 band 元素 + `.tl-zone-ab` 样式 + `profile.abRange` 开关 | documents/viewer/implementation/replay.md | `git grep -n "abBand\|tl-zone-ab\|abRange" -- apps/viewer/src apps/viewer/web` ⇒ 0 命中（band 已删）；`cd apps/viewer && npm run typecheck` ⇒ exit 0；冒烟段 `[5] A-B 区间` 仍通过（区间读数与滑杆跨度照常，`cd apps/viewer && npm run local:smoke`） | — |
| T-125 | 零帧轨道的口径不一致（列表面板有卡片、3D 无对象） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/visuals.ts:96 | documents/viewer/implementation/replay.md | 判据：零帧轨道 ⇒ 列表与 3D 口径一致（要么都无卡片、要么都有对象） | — |
| T-139 | 导航缺「卸载地图」入口，载入过地图后回不到空态 | 缺陷 | viewer | 待修 | apps/viewer/src/ui/mapinfo.ts:125 | documents/viewer/implementation/ui.md | 判据：点导航「卸载地图」⇒ 回到空态且可再次载入 | — |
| T-147 | 材质去重键是材质名，同名材质被后续模型复用 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:216 | documents/viewer/implementation/wasm.md | 判据：同名材质来自不同模型 ⇒ 各自独立实例（去重键含 search_path/模型作用域） | — |
| T-166 | `ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/shavit-replay.ts:507 | documents/viewer/implementation/replay.md | 判据：`git grep -n "ShavitParseResult.flags" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-203 | 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈 | 缺陷 | game | 待修 | apps/game/src/app.ts:249 | documents/game/implementation/app-entry.md | 判据：未选图 / 未锁定前点击画布 ⇒ 有可见反馈（不再静默返回） | — |
| T-204 | `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指） | 缺陷 | game | 待修 | apps/game/src/input/input-bridge.ts:65 | documents/game/implementation/input.md | 判据：`hud` 段只含 hud 字段（探针比对 `input-bridge.ts` 下发与 `config.hud`） | — |
| T-206 | `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃 | 未接线·死代码 | game | 待修 | apps/game/src/input/input-bridge.ts:30 | documents/game/implementation/input.md | 判据：`git grep -n "InputBridge.addInput" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-211 | `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:77 | documents/game/implementation/renderer.md | 判据：`git grep -n "ENABLE_PVS" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-212 | `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图 | 缺陷 | game | 待修 | apps/game/src/renderer/renderer-main.ts:257 | documents/game/implementation/renderer.md | 判据：换图失败 ⇒ 场景仍可用（不再入口先 `disposeScene`） | — |
| T-214 | 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态 | 缺陷 | game | 待修 | apps/game/src/savepoint.ts:21 | documents/game/implementation/savepoint.md | 判据：蹲伏中存点、站立后读点 ⇒ 读到站立眼高（存点含蹲伏态） | — |
| T-225 | `physics.mode` 零读取点 | 未接线·死代码 | game | 待修 | apps/game/src/config.ts:27 | documents/game/implementation/config.md | 判据：`git grep -n "physics.mode" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-226 | `sendSetDeathThreshold` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/input/input-bridge.ts:83 | documents/game/implementation/input.md | 判据：`git grep -n "sendSetDeathThreshold" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-227 | 共享层的累积路径无消费方 | 未接线·死代码 | game | 待修 | src/ts-shared/input/mouse-buffer.ts:81 | documents/game/implementation/input.md | 判据：@BT@git grep -n "<累积路径符号>" -- apps src@BT@ ⇒ 无消费方 ⇒ 删除 | — |
| T-228 | `sampleEpoch` 字段只写不读 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:130 | documents/game/implementation/renderer.md | 判据：`git grep -n "sampleEpoch" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-229 | `applyCollisionCorrection` 的入参有三个不被读取 | 未接线·死代码 | game | 待修 | src/ts-shared/phys/authority-calibrator.ts:735 | documents/game/implementation/renderer.md | 判据：`git grep -n "applyCollisionCorrection" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-230 | 光照模块内多个导出在本工程零导入点 | 未接线·死代码 | game | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1742 | documents/game/implementation/renderer.md | 判据：光照模块导出逐个 @BT@git grep -n "import" -- apps/game/src@BT@ ⇒ 零导入者 ⇒ 删除 | — |
| T-231 | `SavePoint.t` 只写不读 | 未接线·死代码 | game | 待修 | apps/game/src/app.ts:610 | documents/game/implementation/savepoint.md | 判据：`git grep -n "SavePoint.t" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-232 | `getMap()` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/savepoint.ts:69 | documents/game/implementation/savepoint.md | 判据：`git grep -n "getMap()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-233 | `clear()` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/savepoint.ts:98 | documents/game/implementation/savepoint.md | 判据：`git grep -n "clear()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-234 | `mtzB64` 与契约清单都指向了没有直接调用点的字段 | 未接线·死代码 | game | 待修 | src/ts-shared/auth/worker-dispatch.ts:297 | documents/game/implementation/scripts.md | 判据：`git grep -n "mtzB64" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-235 | `apps/game/src/world/types.ts` 在本工程零导入点 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:42 | documents/game/implementation/types.md | 判据：`git grep -n "apps/game/src/world/types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-236 | `export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点：… | 未接线·死代码 | game | 待修 | apps/game/crates/wasm/src/lib.rs:577 | documents/game/implementation/wasm-crate.md | 判据：`git grep -n "export_glb_with_pakfile_models_with_defaults_and_atlas_limit" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-239 | `worker-types.ts` 里多条声明在本工程无发送方且无接收点 | 未接线·死代码 | game | 待修 | src/ts-shared/auth/worker-dispatch.ts:265 | documents/game/implementation/worker.md | 判据：`git grep -n "worker-types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-306 | lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform | 缺陷 | debug | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1539 | documents/debug/implementation/renderer.md | 判据：运行期改诊断开关 ⇒ 覆盖生效（不再固化于模块初始化时的 uniform 初值） | — |
| T-308 | 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套 | 工具·流程 | debug | 待修 | apps/debug/package.json:7 | documents/debug/implementation/scripts.md | 判据：`apps/debug/package.json` 有指向 dev/build/start/stop 的 script，`.cmd` 只做薄包装（环境准备只留一处） | — |
| T-312 | `tsconfig.json` 的五个路径别名零导入点 | 未接线·死代码 | debug | 待修 | apps/debug/tsconfig.json:19 | documents/debug/implementation/app.md | 判据：`git grep -n "tsconfig.json" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-313 | `keysFromMask` 无调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/input/input-recorder.ts:772 | documents/debug/implementation/input.md | 判据：`git grep -n "keysFromMask" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-314 | `InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄 | 未接线·死代码 | debug | 待修 | apps/debug/src/input/input-recorder.ts:541 | documents/debug/implementation/input.md | 判据：`git grep -n "InputPlayer.adopt" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-315 | `vec3.ts` 的 13 个函数零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/math/vec3.ts:11 | documents/debug/implementation/physics.md | 判据：`git grep -n "vec3.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-316 | `setParamFromMap` 零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/physics-params.ts:110 | documents/debug/implementation/physics.md | 判据：`git grep -n "setParamFromMap" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-317 | `TraceResult` 与 `V3Tuple` 的消费面不在本目录 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/physics/Collision/Collision.types.ts:49 | documents/debug/implementation/physics.md | 判据：`git grep -n "TraceResult" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-319 | `assignClusterIds` 的结果无消费方 | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/lod-manager.ts:181 | documents/debug/implementation/renderer.md | 判据：`git grep -n "assignClusterIds" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-320 | 默认导出与 `parse_bsp` 在本工程零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/wasm.d.ts:20 | documents/debug/implementation/wasm-bindings.md | 判据：`git grep -n "parse_bsp" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-322 | `TeleportManager` 的六项成员零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/teleport-manager.ts:18 | documents/debug/implementation/world.md | 判据：`git grep -n "TeleportManager" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-323 | `spawn-loader.ts` 整模块零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/spawn-loader.ts:11 | documents/debug/implementation/world.md | 判据：`git grep -n "spawn-loader.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-324 | `types.ts` 里有一批零引用类型 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/types.ts:18 | documents/debug/implementation/world.md | 判据：`git grep -n "types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-402 | `compute-mode` 的三模式接线 | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/auth-loop.ts:160 | documents/ts-shared/overview.md | 判据：`git grep -n "compute-mode" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-403 | `MouseBuffer.push` / `drain` | 未接线·死代码 | shared | 待修 | src/ts-shared/input/mouse-buffer.ts:81 | documents/ts-shared/overview.md | 判据：`git grep -n "MouseBuffer.push" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-404 | `ShmState.wake` | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/shared-state.ts:447 | documents/ts-shared/overview.md | 判据：`git grep -n "ShmState.wake" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-405 | `maskToKeys` | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/shared-state.ts:98 | documents/ts-shared/overview.md | 判据：`git grep -n "maskToKeys" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-406 | `PvsManager.getFaceCluster` / `visibleClusterCount` | 未接线·死代码 | shared | 待修 | apps/game/src/renderer/renderer-main.ts:326 | documents/ts-shared/overview.md | 判据：`git grep -n "PvsManager.getFaceCluster" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-407 | `world/types.ts` 的 `rootNode` 字段 | 未接线·死代码 | shared | 待修 | apps/game/crates/wasm/src/lib.rs:1732 | documents/ts-shared/overview.md | 判据：`git grep -n "world/types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-408 | `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de… | 未接线·死代码 | shared | 待修 | src/wasm-core/bsp_to_gltf_core/convert.rs:367 | documents/wasm-core/overview.md | 判据：`git grep -n "bsp_to_gltf_core/convert.rs" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-409 | `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI，谁都不跑它） | 配置·门禁 | 共享 | 待修 | src/scripts/check-glb-parity.mjs:2 | documents/norms/scripts-and-ci.md | 判据：@BT@git grep -l "check-glb-parity" -- **/package.json .github@BT@ ⇒ 至少 1 个文件命中（已接线） | #409 |
| T-433 | 【S12·残留黑块的真实层级】owner 参考截图里的黑块 / 紫斑**全部**来自 prop 的逐顶点预烘焙光照路径（几何属性 `_VBSP_VLIGHT`，源文件是 pakfile 的 `sp_<i>.vhv`）：关闭该路径后同一视点纯黑像素 **4.94% → 0.00%**、均值 63.9 → 70.6。解析侧已逐字段对齐 SDK——`vradstaticprops.cpp:1563-1593` 写 `flags=4` / `vertexSize=4` 且顶点为 **B,G,R,A** 顺序，`gamebspfile.h:206-225` 的 `StaticPropLump_t` **没有** ambient cube 字段，与本仓 72 B 记录逐字段吻合；prop→文件的 checksum 校验 **1503 匹配 / 0 不符**。但**数据本身极暗**：1587 个 prop 全图最大字节仅 ~95/255、prop 均值亮度中位数 6.8/255、298 个 prop 全 0。VRAD 侧 `m_Color = direct + indirect`（`vradstaticprops.cpp:1427`）与世界面同一物理量 ⇒「world 亮、prop 近黑」是数据 + 兜底口径问题，**不是**解析错 | 缺陷 | shared | 阻塞（待 owner 目视，见 OWNER.md D-023） | src/renderer-shared/shader/lightmap-shader.ts ⇒ cube 项按顶点烘成 `_VBSP_VCUBE`（`Σ c_i·n_i²`，含 gain），第 1 级片元改成 `(direct + indirect) * vbspExposure`（9 处 1:1 + EOF 新函数，锚点零漂移）；探针：注入后片元含 `+ pow(max(vbspVCube…`、顶点属性逐面与片元同式（1.22 = 0.5×2.44）；三工程 typecheck 通过。**判据的像素指标需浏览器 ⇒ 待目视** **2026-10-09 补（本机浏览器可用，已实跑）**：Edge headless + CDP（探针走 `change` 事件投喂 `#bspFile`）实测 `surf_666` 约 10 秒加载完成；关掉缺失纹理弹窗后**默认视点纯黑像素 0.00%**（截图无黑块/紫斑，亮度 18~214）；**玩家出生点 20~100 仍 21~29% 纯黑**（虚空还是未受光几何未判定）⇒ 详见 `OWNER.md` D-023，截图在 `.tmp/t433/` | progress/pending-detail.md | 见详情 | — |
| T-443 | 【S17·debug】帧探针 `applyPose` 只有 `spawn`/`surface` 两个预设 ⇒ 脚本无法钉任意位姿出图；补 `applyPoseAt(pos, yawDeg, pitchDeg)`（走现成 `setHoldPoint`） | 缺失 | debug | 待修 | apps/game/src/renderer/renderer-main.ts:997 | progress/monthly/2026-10-6.md | 判据：脚本调用后 `cameraPose()` 返回同一 pos/yaw/pitch，两次运行像素 diff≈0 | — |
| T-441 | 【S16】置换面碰撞**分块懒加载**（落实 D-017：owner 2026-10-08 裁决，避免一次性 ~13MB JSON / 13 万三角形入物理） | 缺陷 | shared | 待修 | src/ts-shared/phys/world-builder.ts:203 | progress/monthly/2026-10-6.md | 判据：置换面按块分批构建；`triJson` 单次体积显著下降且洞穴壁仍全有碰撞 | — |
| T-607 | 【S19·Pages 站点守卫】站点源被切成「从分支构建」后，GitHub 内部 `pages-build-deployment` 会在**每次推送**（含纯文档推送）把仓库根按 Jekyll 发布、顶掉 Actions 产物，而部署链无任何断言/告警（2026-10-08 设置被切走；2026-10-09 02:40 的纯文档推送把站点顶掉，35 分钟后才发现） | 配置·门禁 | repo | 待修 | .github/workflows/deploy-pages.yml:200 | progress/monthly/2026-10-7.md | 判据：站点源被改成「从分支构建」时自检报错（定时 workflow 红或部署后断言失败）；正常时 `curl -s https://jofengseir.github.io/websurf/version.json` 的 id 与本次部署一致 | — |
| T-609 | 体检 `[O]` 对**终态行**（已记录 / 已结案）的「判据」列按行态保护：改终态行判据须先 approve，未结行改判据不拦 | 工具·流程 | repo | 待修 | src/scripts/docflow.mjs:201 | documents/norms/annotation-and-verification.md | 判据：改一条终态行的判据 ⇒ `node src/scripts/docflow.mjs check` 报「受保护列」；改未结行的判据不报 | — |
| T-611 | 文档锚点「行号陈旧」体检抓不到 | 缺陷 | 工具 | 待修 | `documents/viewer/implementation/core.md:29`、`documents/viewer/implementation/core.md:31` | documents/norms/annotation-and-verification.md | 判据：先建 `src/scripts/check-doc-anchor-target.mjs`（逐锚点断言「文档所称符号名出现在该行」，不符 exit 1）；负向用例 = 上述 `apps/viewer/src/core/scene.ts:168` ⇒ exit 1，修好后的 `core.md` 全篇 ⇒ exit 0 | — |
| T-170 | viewer 不导出实体放置模型（`entities` 恒空）⇒ `prop_dynamic` 等实体模型完全不渲染 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:703 | progress/monthly/2026-10-10.md | 判据：GLB 门禁扩到三端后跑 `surf_boreas` ⇒ exit 0 且 viewer 段出现 `buk01.mdl` | 新 |
| T-450 | 实体放置模型无任何烘焙光照（无 `_VBSP_VLIGHT`、无 `extras.ambientCube`）⇒ 恒 fullbright 贴图原色 | 缺陷 | shared | 待修 | src/wasm-core/model_integrator/mod.rs:1368 | progress/monthly/2026-10-10.md | 判据：探针列「有 mesh 无 `extras.ambientCube`」节点 ⇒ 只剩世界面 `bsp` | 新 |
| T-451 | 三端 GLB 一致性门禁只覆盖 debug↔game 且只比材质/图片（viewer、图元属性、节点 extras 全盲） | 配置·门禁 | shared | 待修 | src/scripts/check-glb-parity.mjs:41 | progress/monthly/2026-10-10.md | 判据：`APPS` 含 viewer + 断言节点名/属性键/ambientCube 三项；门禁 exit 0 | 新 |
| T-452 | `s1_ramp1b` 逐顶点光照条纹（三端导出数据相同；疑点在合并期差异 + 反条纹档 `propVertexFlatten` 默认 0） | 缺陷 | shared | 待修 | src/renderer-shared/shader/lightmap-shader.ts:728（对照 apps/debug/src/renderer/renderer-main.ts:144） | progress/monthly/2026-10-10.md | 判据：同视点三端 × `__vbspPropVertexRelax=0/1` × `__vbspPropVertexFlatten=1` + 转储 ⇒ 条纹消失 | 新 |
| T-453 | 三端呈现/画质档不同源（game 持久化面板五档 + mosaic 画质；debug 只默认档但有画质档；viewer 两者皆无） | 缺陷 | shared | 待修 | apps/game/src/renderer/renderer-main.ts:221 | progress/monthly/2026-10-10.md | 见 T-454 P1 | 新 |
| T-454 | 渲染链三端统一（任务书 `.tmp/task-unify-render/TASK.md`）：除 debug 调试绘制外全部收敛共享层 | 缺陷 | shared | 进行中 · DSH · 2026-10-09 | 见详情（P0 仪器/基线在 `.tmp/unify/`；P1 呈现档 `config/render-prefs.ts`、P2 渲染器工厂 `render/create-renderer.ts`、P3a 位姿入口 `camera/pose-entry.ts` 已收口） | progress/monthly/2026-10-10.md | 判据：三端 GLB 门禁 exit 0 + 新 `check-render-parity` exit 0（apps/ 无渲染实现符号）+ P0 基线不劣化 | 新 |
