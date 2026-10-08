# 待办看板（TODO Board）

> **唯一事实来源**：所有待裁决 / 待修 / 已取证待立项 / 进行中事项的**状态只在本页登记**。
> 其余文档只写技术事实，不复述状态；代码注释只允许写「见 TODO.md T-###」。
> 规则：一行一条；ID 永不复用；结案保留 ID；**改代码或裁决的同一提交必须更新对应行**。
> 台账号（原 AGENTS §7.3 的「N 条」聚合行）在底层条目细化后**保留原行**、置 `已记录` 并在事项前标「【台账号·已细化】」，只作编号追溯，不再承载状态；未完全细化者保留原状态并标注已细化部分。
> **体量策略**：本表超过 **96 KB 或 300 条**时，按两级处理——①把「已记录 + 已结案」整段移入 `progress/board/archive-<年-月>.md`（**未结项永不分卷**；2026-10-07、2026-10-09 各触发一次）；②若已分卷后仍超限，则**逐行精简**：`证据`/`判据` 超长的改写为「见详情」并把全文移入该行详情页，`事项` 一律 ≤ 120 字符。体检 `[H]` 硬查 96 KB。**分卷/归档前先取许可**：`node src/scripts/docflow.mjs approve --path TODO.md --by <谁> --reason 分卷`，移完再 `sync`（本表不许 agent 删行，无许可 `sync` 会保留旧钉、体检逐条报「单元被删除」）。
> **ID 分配**：新条目取**所属区段的下一个未用号**——viewer `T-1xx`、game `T-2xx`、debug `T-3xx`、shared `T-4xx`、取证项 `T-5xx`、跨区/文档治理 `T-6xx`；**已出现过的号永不复用**。
> **下一可用号（实测，含 `progress/board/archive-2026-10.md` 的历史行；只写数字部分）**：viewer **170**；game **240**；debug **325**；shared **450**；取证项 **508**；跨区/文档治理 **610**。分配新条目后同步更新本行。
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

## 未结项（155 条）
### 待裁决（29）
- **T-015** vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤）　`shared`
- **T-024** game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等）　`game`
- **T-031** game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB）　`game`
- **T-053** viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/…　`viewer`
- **T-054** debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g…　`debug`
- **T-055** game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（…　`game`
- **T-056** 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局…　`game`
- **T-060** .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01　`viewer`
- **T-101** 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错）　`viewer`
- **T-103** ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动）　`viewer`
- **T-110** 包内 svc_CreateStringTable 只稳定解出第一张表　`viewer`
- **T-111** svc_CreateStringTable 的压缩标志未实现　`viewer`
- **T-112** svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过　`viewer`
- **T-113** svc_GameEvent 只按长度跳过，事件描述符表未保存　`viewer`
- **T-116** 注入期 throw 不在本工程调用方 catch 覆盖范围内　`shared`
- **T-117** broken 阶段对照靠失配字面量维持，three 升级需同步　`shared`
- **T-125** 零帧轨道的口径不一致（列表面板有卡片、3D 无对象）　`viewer`
- **T-139** 导航缺「卸载地图」入口，载入过地图后回不到空态　`viewer`
- **T-143** el() 属性写入限制了 id 型契约（undefined 静默无 id）　`viewer`
- **T-149** map_name 两端都拿不到值，字段保留但无内容　`viewer`
- **T-201** 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色　`game`
- **T-203** 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈　`game`
- **T-204** `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指）　`game`
- **T-212** `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图　`game`
- **T-213** 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错　`game`
- **T-214** 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态　`game`
- **T-303** 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1　`debug`
- **T-306** lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform　`debug`
- **T-504** 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉　`shared`


### 待修（124）
- **T-008** apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new …　`game`
- **T-013** lightmap.rs 错误串含外部实现引用 Lightmap.cs:64　`shared`
- **T-021** game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略）　`game`
- **T-029** debug 脚本 10 条（jump-apex 采样链链路级仍待裁决　`debug`
- **T-032** game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等）　`game`
- **T-036** WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等）　`repo`
- **T-039** 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep…　`repo`
- **T-040** debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g…　`debug`
- **T-046** debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份…　`debug`
- **T-047** game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap…　`debug`
- **T-058** DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30　`viewer`
- **T-062** 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径…　`viewer`
- **T-102** 贴合检查提示串的 bbox 只取第一条越界轨道　`viewer`
- **T-105** ensureWasm 把首次失败永久缓存，一次瞬时失败后本会话不自愈　`viewer`
- **T-107** 分块选块包围盒只统计部分 Mesh，块边长由子集推出　`shared`
- **T-108** 回退脚本加载无超时且成功路径不移除 script 标签　`viewer`
- **T-114** 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems）　`viewer`
- **T-118** A-B 区间带恒不显示（宽度算式分子恒等于分母）　`viewer`
- **T-120** 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏　`viewer`
- **T-121** disposeTree 不释放轨迹线（Line）与 tick 点（Points）　`viewer`
- **T-122** createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL　`viewer`
- **T-123** 导入无超时与取消，Worker 不回消息时 Promise 永不结算　`viewer`
- **T-126** panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU　`viewer`
- **T-129** 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080　`viewer`
- **T-130** 冒烟按键断言（6 键）与当前 UI 八键不一致　`viewer`
- **T-131** 冒烟三条静态断言只对 single 产物成立　`viewer`
- **T-133** .gitignore 中间产物目录与 test:replay 实际输出不一致　`viewer`
- **T-136** single 分支四段日志都写 [5/5] 步骤编号　`viewer`
- **T-138** 光照模式下拉只写不回填，与运行期真实模式脱节　`viewer`
- **T-140** 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复　`viewer`
- **T-141** setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError　`viewer`
- **T-144** .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节　`viewer`
- **T-145** 模型名匹配与材质查找的大小写口径不一致　`viewer`
- **T-146** 锁中毒会 panic，与本文件其它失败形态不一致　`viewer`
- **T-147** 材质去重键是材质名，同名材质被后续模型复用　`viewer`
- **T-148** packed_files 构造期缓存而 num_static_props 每次现算　`viewer`
- **T-151** BspMetadata 与 TS 契约靠约定对齐，无编译期校验　`viewer`
- **T-154** clipToPayload 没有显式返回类型，字段写错的报错落在调用点　`viewer`
- **T-155** req.rule 缺少防御，缺字段时抛 TypeError 并被 catch 成 error　`viewer`
- **T-156** `wasm.d.ts` 是零导入点的类型面　`viewer`
- **T-157** `viewer.replay.setSpeed` 的钳制下限在正常入参下不可达　`viewer`
- **T-158** `core/pose.ts` 的两个函数零调用点　`viewer`
- **T-159** `RAD2DEG` 在 `apps/viewer/src` 内零调用点　`viewer`
- **T-160** `ViewerScene.model` getter 零调用点　`viewer`
- **T-161** 六个导出在本工程内零调用点　`viewer`
- **T-162** `setLightFloor` 在本工程内零调用点　`viewer`
- **T-163** `ReplayPlayer` 两个成员零调用点　`viewer`
- **T-164** `ReplayImporter.dispose()` 零调用点　`viewer`
- **T-165** `ReplayVisuals.hasTracks()` 零调用点　`viewer`
- **T-166** `ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点　`viewer`
- **T-167** 进度回调里的 `'map'` 分支不可达　`viewer`
- **T-168** `MapPanel.spawnPoints` getter 零调用点　`viewer`
- **T-202** 可选 DOM 依赖（`#loadMapBtn`/`#bspFile`/`#respawnBtn`/`#spawnSelect`）缺失时静默降级、无报错无提示　`game`
- **T-205** `lockTickRate` 的 64 在 `syncFullConfig`、面板构造与 `DEFAULT_CONFIG` 三处硬编码、需同步修改　`game`
- **T-206** `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃　`game`
- **T-207** `requestLock` 的 `p instanceof Promise` 判门在当前签名下恒真、失败提示恒挂 promise 回调　`game`
- **T-208** `bindSlider`／`bindCheckbox` 取不到元素时静默返回，控件缺失不报错　`game`
- **T-211** `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造　`game`
- **T-215** 存档解析结果不是数组时静默保持空列表、不报错，表现为该地图没有存点　`game`
- **T-216** `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长　`game`
- **T-217** `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方）　`game`
- **T-218** `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl`　`game`
- **T-219** `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组　`game`
- **T-220** `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加　`game`
- **T-222** 20 个脚本里仅 7 个设退出码，其余 13 个结论只在 stdout 末行、接入 CI 时判定不带出　`game`
- **T-223** single 产物引用了不在保留名单里的 `coi-serviceworker.js`、dist 同目录无该文件　`game`
- **T-224** `build-dist.mjs` 两条路径都打印同一组 `[5/5]` 前缀、与步骤序号无关　`game`
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
- **T-237** `map_name` 恒为空串　`game`
- **T-238** `InitMessage` 有三个字段既无发送方也无读取点　`game`
- **T-239** `worker-types.ts` 里多条声明在本工程无发送方且无接收点　`game`
- **T-301** 回放捕获 `replayCapture.record` 未传 `dtS`，样本 `dt` 恒 0；`InputFrame` 亦无 `dt` 字段　`debug`
- **T-302** 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`）　`debug`
- **T-304** tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源　`debug`
- **T-305** 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0　`debug`
- **T-307** `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2　`debug`
- **T-308** 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套　`debug`
- **T-310** `set-auto-restore-hull` 只改面板侧标记，`src/phys/**` 无对应参数与读取点，开关不写物理实例　`debug`
- **T-311** `custom-teleports` 的 localStorage 写入失败被静默忽略，调用方拿不到失败信号　`debug`
- **T-312** `tsconfig.json` 的五个路径别名零导入点　`debug`
- **T-313** `keysFromMask` 无调用点　`debug`
- **T-314** `InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄　`debug`
- **T-315** `vec3.ts` 的 13 个函数零调用点　`debug`
- **T-316** `setParamFromMap` 零调用点　`debug`
- **T-317** `TraceResult` 与 `V3Tuple` 的消费面不在本目录　`debug`
- **T-318** `LOD_LEVEL.PVS_HIDDEN` 是预留档位　`debug`
- **T-319** `assignClusterIds` 的结果无消费方　`debug`
- **T-320** 默认导出与 `parse_bsp` 在本工程零调用点　`debug`
- **T-321** `apps/debug/web/styles.css` 在全工程零引用　`debug`
- **T-322** `TeleportManager` 的六项成员零调用点　`debug`
- **T-323** `spawn-loader.ts` 整模块零调用点　`debug`
- **T-324** `types.ts` 里有一批零引用类型　`debug`
- **T-401** mosaic/decode.rs 的 code_to_img 不校验宽高下界、也不校验解码索引落在调色板色数内　`shared`
- **T-402** `compute-mode` 的三模式接线　`shared`
- **T-403** `MouseBuffer.push` / `drain`　`shared`
- **T-404** `ShmState.wake`　`shared`
- **T-405** `maskToKeys`　`shared`
- **T-406** `PvsManager.getFaceCluster` / `visibleClusterCount`　`shared`
- **T-407** `world/types.ts` 的 `rootNode` 字段　`shared`
- **T-408** `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de…　`shared`
- **T-409** `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI）　`共享`
- **T-433** prop 逐顶点光照（`sp_<i>.vhv`）数据极暗：黑块 / 紫斑的**唯一**来源（关掉该路径黑像素 4.94%→0.00%），解析已对齐 SDK（checksum 1503/1503），收口口径待定　`shared`
- **T-443** 帧探针补 `applyPoseAt(pos, yaw, pitch)`（现只有 spawn/surface 预设），脚本才能钉任意位姿出图　`debug`
- **T-446** 盒**起点落在道具 `.phy` 凸壳内部**时该道具整块被跳过（`start_solid` 分支不出接触、又不做退嵌）⇒ 如图 `1600,7600` 处的 `ramp_c1m`（AABB x[-1475,2534] y[99,1536] z[6666,10508]，678 三角、y≈339 有朝上面）下达 500 HU 扫掠一次都不命中、人穿坡落到 -38；真图复核脚本 `.tmp/mapsurvey/spot1600b.mjs`　`shared`
- **T-441** 置换面碰撞**分块懒加载**（D-017 裁决）：避免一次性 ~13MB JSON / 13 万三角形入物理　`shared`
- **T-503** mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效　`shared`
- **T-601** 注释瘦身 · 共享层：20 处超长注释 + 3 个超长文件头（含 lightmap-shader.ts / player.rs / vbsp / gltf_builder.rs / authority-calibrator.ts 等）　`shared`
- **T-602** 注释瘦身 · debug：4 处超长注释 + 0 个超长文件头（debug 脚本与 app.ts / teleport-manager.ts / path-recorder.ts / crates/wasm 等）　`debug`
- **T-603** 注释瘦身 · game：2 处超长注释 + 1 个超长文件头（worker/main.ts 与 crates/wasm/src/lib.rs 等）　`game`
- **T-604** 注释瘦身 · viewer：1 处超长注释　`viewer`
- **T-607** GitHub Pages 站点会被「从分支构建」的内部 Jekyll 构建静默顶掉（站点根变 README 渲染页），部署链无断言/告警　`repo`
- **T-608** 核实「单入口」假设（Copilot / Gemini CLI 是否读根 `AGENTS.md`）并写进规范篇　`docs`
- **T-609** 终态行的「判据」列按行态保护（改终态判据须先 approve）　`repo`


### 已取证待立项（2）
- **T-109** 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正　`viewer`
- **T-115** untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查　`viewer`

> 已记录 / 已结案 **93 条已分卷**到 `progress/board/archive-2026-10.md`（ID 与状态保留；编号不复用，取新号时连同该页一起数）。

## 总表（170 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 判据 | 原号 |
|---|---|---|---|---|---|---|---|---|
| T-005 | apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html… | 缺陷 | game | 已结案 | apps/game/web/index.html:22 ⇒ 只留相对路径；`apps/game/web/favicon.ico`（168 B，blob fccb749）已恢复并加进 KEEP_SINGLE/KEEP_MULTI + 两形态拷贝；`npm run build:dist` 与 `-- --multi` ⇒ dist/favicon.ico 168 B 且 dist/index.html 引用它 | documents/game/implementation/app-entry.md | 见详情 | #5 |
| T-007 | apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into… | 缺陷 | debug | 已结案 | apps/debug/src/wasm.d.ts:145 起 ⇒ 文末同名 interface 声明合并补 16 个成员；`node .tmp/t007/probe.mjs` ⇒ PhysWorld 33/33 缺 0；收窄已删、`apps/debug` typecheck 通过 | documents/debug/implementation/wasm-bindings.md | 见详情 | #8 |
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | 配置·门禁 | game | 待修 | apps/game/scripts/check-wasm-api.mjs:52-70 | progress/pending-detail.md | 判据：跑 @BT@node apps/game/scripts/check-wasm-api.mjs@BT@ ⇒ exit 0，且 PHYS_API 列出的项 ≥ crates/wasm 实际导出数（不再缺 @BT@new@BT@ 等） | #9 |
| T-013 | lightmap.rs 错误串含外部实现引用 Lightmap.cs:64 | 缺陷 | shared | 待修 | src/wasm-core/bsp_to_gltf_core/lightmap.rs:219 | documents/wasm-core/overview.md | 判据：`git grep -n "Lightmap.cs" -- src` ⇒ 0 命中（错误串不再引用外部实现） | #28 |
| T-015 | vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤） | 缺陷 | shared | 待裁决 | 见详情 | progress/pending-detail.md | — | #31 |
| T-016 | compute-mode.ts 的 summary 字面量含已删文档编号 | 文档口径 | shared | 已结案 | src/ts-shared/auth/compute-mode.ts:106 ⇒ summary 不再含 §3.4.C；`git grep -n "§3.4" -- src` ⇒ 0 命中 | documents/ts-shared/overview.md | 见详情 | #36 |
| T-018 | tick-authority.test.ts 断言标签含 Q1 / §8.5 | 缺陷 | shared | 已结案 | src/ts-shared/auth/tick-authority.test.ts:446 ⇒ 断言标签已去掉 Q1 / §8.5；`npx esbuild … && node .tmp/t018/tick-authority.test.mjs` ⇒ 全例通过（exit 0） | documents/ts-shared/overview.md | 见详情 | §8.5" -- src/ts-shared/auth/tick-authority.test.ts` ⇒ 0 命中（断言标签不再含旧编号） | #40 |
| T-021 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 缺陷 | game | 待修 | apps/game/src/panel/panel-controller.ts:583 | documents/game/implementation/panel.md | 判据：数值框回写自身文本；`dot` 死变量清掉（`git grep -n "dot" -- apps/game/src/panel/panel-controller.ts` 无声明未用） | #50 |
| T-024 | game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等） | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #53 |
| T-029 | debug 脚本 10 条（jump-apex 采样链链路级仍待裁决 | 配置·门禁 | debug | 待修 | 见详情 | progress/pending-detail.md | 判据：10 条子项逐条处置完毕；每条子项脚本跑通 exit 0，并在 @BT@progress/pending-detail.md@BT@ 对应条目标注处置结果 | #60 |
| T-031 | game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB） | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #62 |
| T-032 | game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等） | 配置·门禁 | game | 待修 | 见详情 | progress/pending-detail.md | 判据：7 条子项逐条处置；@BT@_dbg_floor@BT@ 的 onGround 不再恒 undefined（脚本输出该字段有真值） | #63 |
| T-033 | 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等） | 缺陷 | repo | 已结案 | 台账号 6 条已全部细化到独立 T-12x 行（T-127 夹具路径 + T-128..T-132） | progress/pending-detail.md | 见详情 | #64 |
| T-036 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等） | 未接线·死代码 | repo | 待修 | 见详情 | progress/pending-detail.md | 判据：剩余 15 条逐条 @BT@git grep -n "<符号>" -- src apps@BT@ ⇒ 只剩定义处 ⇒ 删除；删后体检 exit 0 且构建通过 | #67 |
| T-039 | 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep… | 配置·门禁 | repo | 待修 | 见详情 | progress/pending-detail.md | 判据：@BT@cargo check -p websurf-phys@BT@ 等各 crate 无 @BT@unused_crate_dependencies@BT@ 警告 ⇒ 依赖表与源码引用面一致 | #70 |
| T-040 | debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g… | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:1517 | progress/pending-detail.md | 判据：@BT@git grep -n "worker-b" apps/debug/src apps/game/src@BT@ ⇒ 两处措辞一致，或都改为不带外部实现引用的写法 | #71 |
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:486 | progress/pending-detail.md | 判据：@BT@getLightingMode@BT@ 清点调用点（@BT@apps/debug/src/renderer/renderer-main.ts:486@BT@ 疑有一处）⇒ 真零调用则删，否则结案并改状态 | #78 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | 未接线·死代码 | debug | 待修 | apps/game/src/app.ts:170 | progress/pending-detail.md | 判据：@BT@git grep -n "resetTo\ | \.stop(" -- src apps@BT@ ⇒ 无外部调用点则删；有则接线并补调用 | #79 |
| T-048 | worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea… | 文档口径 | debug | 已结案 | apps/game/src/worker/worker-types.ts:78 ⇒ 联合补齐（WorkerMessage 13 条 / MainMessage 12 条 + 8 个新接口）；`node .tmp/t048/probe.mjs` ⇒ 运行时 15 条字面量未覆盖 0；`apps/game` typecheck 通过 | documents/game/implementation/worker.md | 见详情 | #80 |
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:110 | progress/pending-detail.md | — | #84 |
| T-054 | debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g… | 缺陷 | debug | 待裁决 | apps/debug/src/app.ts:1992 | progress/pending-detail.md | — | #85 |
| T-055 | game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（… | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #86 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #87 |
| T-058 | DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30 | 未接线·死代码 | viewer | 待修 | 见详情 | progress/pending-detail.md | 判据：零应用字段逐条 @BT@git grep -n "<字段>" -- src apps@BT@ ⇒ 只剩定义处则删字段，否则接线 | #89 |
| T-060 | .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01 | 缺陷 | viewer | 待裁决 | 见详情 | progress/pending-detail.md | — | #91 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/panel.ts:283 | progress/pending-detail.md | 判据：@BT@git grep -n "importer" -- apps/viewer/src@BT@ ⇒ Source .dem 分支无 UI 调用路径 ⇒ 删或接线 | #93 |
| T-064 | 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d… | 文档口径 | docs | 已结案 | documents/debug/sequences.md:24 与 documents/debug/overview.md:91 ⇒ `ready` 发送点锚点按符号重定位为 apps/debug/src/worker/main.ts:484（原 483 是 `onInit` 行） | documents/debug/sequences.md | 见详情 | #95 |
| T-101 | 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:210 | documents/viewer/implementation/app.md | — | — |
| T-102 | 贴合检查提示串的 bbox 只取第一条越界轨道 | 缺陷 | viewer | 待修 | apps/viewer/src/app.ts:267 | documents/viewer/implementation/app.md | 判据：构造 2 条以上越界轨道 ⇒ 提示串 bbox 覆盖全部（不再只取第一条） | — |
| T-103 | ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:807 | documents/viewer/implementation/app.md | — | — |
| T-105 | ensureWasm 把首次失败永久缓存，一次瞬时失败后本会话不自愈 | 缺陷 | viewer | 待修 | apps/viewer/src/core/bsp.ts:82 | documents/viewer/implementation/core.md | 判据：首次 @BT@ensureWasm@BT@ 失败后再次调用会重试（断网→联网后可自愈） | — |
| T-106 | numField 把空串当合法 0 写入变换 | 缺陷 | viewer | 已结案 | apps/viewer/src/core/dom.ts:106 ⇒ 空串 / 纯空白 trim 后判 invalid、不写变换（DOM 桩探针：`""` ⇒ onInput(NaN,false) + invalid 类） | documents/viewer/implementation/core.md | 见详情 | — |
| T-107 | 分块选块包围盒只统计部分 Mesh，块边长由子集推出 | 缺陷 | shared | 待修 | src/renderer-shared/scene/scene-optimizer.ts:250 | documents/viewer/implementation/core.md | 判据：构造仅含多材质网格的分块 ⇒ 分块边长含全部 Mesh 的并集（`worldBox` 不再只在单材质分支累计） | — |
| T-108 | 回退脚本加载无超时且成功路径不移除 script 标签 | 缺陷 | viewer | 待修 | apps/viewer/src/core/bsp.ts:59 | documents/viewer/implementation/core.md | 判据：回退脚本加载有超时；成功路径移除 @BT@script@BT@ 标签（@BT@document.querySelectorAll("script")@BT@ 不残留） | — |
| T-109 | 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/net.ts:325 | documents/viewer/implementation/dem.md | — | — |
| T-110 | 包内 svc_CreateStringTable 只稳定解出第一张表 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:693 | documents/viewer/implementation/dem.md | — | — |
| T-111 | svc_CreateStringTable 的压缩标志未实现 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:709 | documents/viewer/implementation/dem.md | — | — |
| T-112 | svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:730 | documents/viewer/implementation/dem.md | — | — |
| T-113 | svc_GameEvent 只按长度跳过，事件描述符表未保存 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:563 | documents/viewer/implementation/dem.md | — | — |
| T-114 | 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems） | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/demo/net.ts:269 | documents/viewer/implementation/dem.md | 判据：@BT@git grep -n "mergeVectorElems" -- apps src@BT@ ⇒ 0 命中（诊断开关已从生产代码移除） | — |
| T-115 | untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/demo.ts:866 | documents/viewer/implementation/dem.md | — | — |
| T-116 | 注入期 throw 不在本工程调用方 catch 覆盖范围内 | 缺陷 | shared | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1114 | documents/viewer/implementation/renderer.md | — | — |
| T-117 | broken 阶段对照靠失配字面量维持，three 升级需同步 | 工具·流程 | shared | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:351 | documents/viewer/implementation/renderer.md | — | — |
| T-118 | A-B 区间带恒不显示（宽度算式分子恒等于分母） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:525 | documents/viewer/implementation/replay.md | 判据：A-B 区间带可见（宽度算式分子≠分母）：构造 A≠B ⇒ 带出现且宽度随区间变化 | — |
| T-119 | 时间轴两条 title 文案与默认播放窗口矛盾 | 文档口径 | viewer | 已结案 | apps/viewer/src/replay/timeline.ts:185 ⇒ 文案改为「prerun 帧计入区间（读数可为负）」，与 apps/viewer/src/replay/player.ts:180 的 Math.min(0,t0) 窗口一致 | documents/viewer/implementation/replay.md | 见详情 | — |
| T-120 | 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:551 | documents/viewer/implementation/replay.md | 判据：构造 @BT@Track.offset ≠ 0@BT@ 的轨道 ⇒ 正式跑段高亮的位置与宽度同基对齐 | — |
| T-121 | disposeTree 不释放轨迹线（Line）与 tick 点（Points） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/visuals.ts:168 | documents/viewer/implementation/replay.md | 判据：反复载入/卸载场景 ⇒ 轨迹线（Line）与 tick 点（Points）被释放（@BT@renderer.info.memory@BT@ 回落） | — |
| T-122 | createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:101 | documents/viewer/implementation/replay.md | 判据：重起 Worker 后 blob URL 不累积（@BT@createObjectURL@BT@ 与 @BT@revokeObjectURL@BT@ 配对） | — |
| T-123 | 导入无超时与取消，Worker 不回消息时 Promise 永不结算 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:137 | documents/viewer/implementation/replay.md | 判据：Worker 不回消息时导入 Promise 以超时结算（不再永不 settle），并可取消 | — |
| T-124 | Track.offset 只有下界没有上界，可拉长主时钟总长 | 缺陷 | viewer | 已结案 | apps/viewer/src/replay/trackpanel.ts:209 ⇒ `Math.min(3600, Math.max(0, n))`（上限 1 h），提示语写明 0~3600；`npm run typecheck` 通过 | documents/viewer/implementation/replay.md | 见详情 | — |
| T-125 | 零帧轨道的口径不一致（列表面板有卡片、3D 无对象） | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/visuals.ts:96 | documents/viewer/implementation/replay.md | — | — |
| T-126 | panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU | 文档口径 | viewer | 待修 | apps/viewer/src/replay/panel.ts:154 | documents/viewer/implementation/replay.md | 判据：@BT@git grep -n "默认 0" -- apps/viewer/src/replay/panel.ts@BT@ ⇒ hint 与 @BT@step=10 HU@BT@ 一致 | — |
| T-127 | 真实夹具路径跨三处失效（指向 test/maps 而非 test/replay） | 缺陷 | viewer | 已结案 | apps/viewer/test/replay-selftest.ts:77 ⇒ 夹具路径改指 test/replay（4 层，与 :912 同口径）；`npm run test:replay` ⇒ fixture 可读 / 53365 B / 字节闭合 全 ok | documents/viewer/implementation/scripts-and-test.md | 见详情 | — |
| T-128 | dist 里的示例记录无法由当前源码路径重新产出 | 缺陷 | viewer | 已结案 | apps/viewer/scripts/build-dist.mjs:239 ⇒ 示例记录源改指 test/replay；`npm run build:dist -- --multi` ⇒ dist/assets/maps/surf_null_4.replay 53365 B 已打包 | documents/viewer/implementation/scripts-and-test.md | 见详情 | — |
| T-129 | 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:32 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "8080" -- apps/viewer/test/smoke-cdp.mjs@BT@ ⇒ 0 命中（缺省 SMOKE_URL 指向本工程端口 8100） | — |
| T-130 | 冒烟按键断言（6 键）与当前 UI 八键不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:415 | documents/viewer/implementation/scripts-and-test.md | 判据：跑 viewer 冒烟脚本 ⇒ 按键断言条数与当前 UI 八键一致 | — |
| T-131 | 冒烟三条静态断言只对 single 产物成立 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:138 | documents/viewer/implementation/scripts-and-test.md | 判据：冒烟三条静态断言在 single 与多产物两种形态下都成立 ⇒ 各跑一次 exit 0 | — |
| T-133 | .gitignore 中间产物目录与 test:replay 实际输出不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/package.json:10 | documents/viewer/implementation/scripts-and-test.md | 判据：跑 @BT@npm run test:replay@BT@ 后 @BT@git status --short@BT@ 无未忽略产物 ⇒ .gitignore 与实际输出目录一致 | — |
| T-136 | single 分支四段日志都写 [5/5] 步骤编号 | 工具·流程 | viewer | 待修 | apps/viewer/scripts/build-dist.mjs:315 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "\[5/5\]" -- apps/viewer/scripts@BT@ ⇒ single 分支四段日志编号与步骤序号一致 | — |
| T-138 | 光照模式下拉只写不回填，与运行期真实模式脱节 | 缺陷 | viewer | 待修 | apps/viewer/src/ui/mapinfo.ts:98 | documents/viewer/implementation/ui.md | 判据：切换光照模式后下拉框回填值与 @BT@getLightingMode()@BT@ 一致（不再只写不回填） | — |
| T-139 | 导航缺「卸载地图」入口，载入过地图后回不到空态 | 缺陷 | viewer | 待裁决 | apps/viewer/src/ui/mapinfo.ts:130 | documents/viewer/implementation/ui.md | — | — |
| T-140 | 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/ui/telemetry.ts:122 | documents/viewer/implementation/ui.md | 判据：@BT@git grep -rn "水平速度\ | horizontalSpeed" -- apps/viewer/src@BT@ ⇒ 只剩 sampling/player 一处实现 | — |
| T-141 | setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError | 缺陷 | viewer | 待修 | apps/viewer/src/ui/telemetry.ts:110 | documents/viewer/implementation/ui.md | 判据：@BT@setTracks(null)@BT@ ⇒ 不抛 TypeError（有明确容错） | — |
| T-142 | 信息条重找跟随轨道，与 TrackSet.follow 策略重复 | 缺陷 | viewer | 已结案 | apps/viewer/src/ui/replaymeta.ts:24 ⇒ `setTracks(follow: Track | null)`，面板内不再重查；调用点改传 `TrackSet.follow`；`npm run typecheck` 通过，`tracks.find((t) => t.id === followId)` 在 apps/viewer/src 内 0 命中 | documents/viewer/implementation/ui.md | 见详情 | null` 决定，面板内不再重查 | — |
| T-143 | el() 属性写入限制了 id 型契约（undefined 静默无 id） | 缺陷 | viewer | 待裁决 | apps/viewer/src/core/dom.ts:39 | documents/viewer/implementation/ui.md | — | — |
| T-144 | .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:119 | documents/viewer/implementation/wasm.md | 判据：@BT@.MDL@BT@ 大小写不敏感匹配 ⇒ vvd/vtx 槽位不再填入 .mdl 字节，三件齐检查有效 | — |
| T-145 | 模型名匹配与材质查找的大小写口径不一致 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:119 | documents/viewer/implementation/wasm.md | 判据：模型名与材质查找同走小写基准 ⇒ 大小写不一致的模型名仍能配对（`cargo test` 覆盖） | — |
| T-146 | 锁中毒会 panic，与本文件其它失败形态不一致 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:429 | documents/viewer/implementation/wasm.md | 判据：构造锁中毒场景 ⇒ 返回错误而非 panic（@BT@cargo test@BT@ 覆盖该路径） | — |
| T-147 | 材质去重键是材质名，同名材质被后续模型复用 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:216 | documents/viewer/implementation/wasm.md | 判据：同名材质来自不同模型 ⇒ 各自独立实例（去重键含 search_path/模型作用域） | — |
| T-148 | packed_files 构造期缓存而 num_static_props 每次现算 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:429 | documents/viewer/implementation/wasm.md | 判据：`git grep -n "num_static_props" -- apps/viewer/crates/wasm/src/lib.rs` ⇒ 只在构造期算一次，`metadata()` 复用缓存 | — |
| T-149 | map_name 两端都拿不到值，字段保留但无内容 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:389 | documents/viewer/implementation/wasm.md | — | — |
| T-151 | BspMetadata 与 TS 契约靠约定对齐，无编译期校验 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:362 | documents/viewer/implementation/wasm.md | 判据：`BspMetadata` 字段名与 TS 契约有编译期或测试期校验（字段名不一致时 `npm run typecheck`/测试失败） | — |
| T-152 | Worker 没有心跳，请求侧无法区分「在解析」与「已失联」 | 缺陷 | viewer | 已结案 | apps/viewer/src/replay/importer.ts:141 ⇒ `send` 建 30 s 看门狗、新增 `onWorkerTimeout`；假 Worker 永不回包的探针实测 30.0 s 后拒绝（`workerBroken=true`、`pending=0`）；`npm run typecheck` 通过 | documents/viewer/implementation/worker.md | 见详情 | — |
| T-153 | WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker） | 缺陷 | viewer | 已结案 | apps/viewer/tsconfig.json:6 ⇒ `lib` 加 `WebWorker`；手写 `WorkerCtx` 删除、`ctx = self`（无断言）；`npm run typecheck` 与 `build:worker` 均通过 | documents/viewer/implementation/worker.md | 见详情 | — |
| T-154 | clipToPayload 没有显式返回类型，字段写错的报错落在调用点 | 缺陷 | viewer | 待修 | apps/viewer/src/worker/main.ts:113 | documents/viewer/implementation/worker.md | 判据：@BT@clipToPayload@BT@ 有显式返回类型 ⇒ 字段写错时 @BT@npm run typecheck@BT@ 在定义处报错（不在调用点） | — |
| T-155 | req.rule 缺少防御，缺字段时抛 TypeError 并被 catch 成 error | 缺陷 | viewer | 待修 | apps/viewer/src/worker/main.ts:82 | documents/viewer/implementation/worker.md | 判据：@BT@req.rule@BT@ 缺字段时给出明确错误（不再抛 TypeError 且被 catch 成笼统 error） | — |
| T-156 | `wasm.d.ts` 是零导入点的类型面 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/wasm.d.ts:13 | documents/viewer/implementation/app.md | 判据：`git grep -n "wasm.d.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-157 | `viewer.replay.setSpeed` 的钳制下限在正常入参下不可达 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/app.ts:726 | documents/viewer/implementation/app.md | 判据：`git grep -n "viewer.replay.setSpeed" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-158 | `core/pose.ts` 的两个函数零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/core/pose.ts:36 | documents/viewer/implementation/core.md | 判据：`git grep -n "core/pose.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-159 | `RAD2DEG` 在 `apps/viewer/src` 内零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/core/constants.ts:25 | documents/viewer/implementation/core.md | 判据：`git grep -n "RAD2DEG" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-160 | `ViewerScene.model` getter 零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/core/scene.ts:92 | documents/viewer/implementation/core.md | 判据：`git grep -n "ViewerScene.model" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-161 | 六个导出在本工程内零调用点 | 未接线·死代码 | viewer | 待修 | src/renderer-shared/shader/lightmap-shader.ts:313 | documents/viewer/implementation/renderer.md | 判据：六个导出逐个 @BT@git grep -n "<符号>" -- apps/viewer src@BT@ ⇒ 只剩定义处 ⇒ 删除 | — |
| T-162 | `setLightFloor` 在本工程内零调用点 | 未接线·死代码 | viewer | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1752 | documents/viewer/implementation/renderer.md | 判据：`git grep -n "setLightFloor" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-163 | `ReplayPlayer` 两个成员零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/player.ts:295 | documents/viewer/implementation/replay.md | 判据：`git grep -n "ReplayPlayer" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-164 | `ReplayImporter.dispose()` 零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/importer.ts:175 | documents/viewer/implementation/replay.md | 判据：`git grep -n "ReplayImporter.dispose()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-165 | `ReplayVisuals.hasTracks()` 零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/visuals.ts:162 | documents/viewer/implementation/replay.md | 判据：`git grep -n "ReplayVisuals.hasTracks()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-166 | `ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/shavit-replay.ts:507 | documents/viewer/implementation/replay.md | 判据：`git grep -n "ShavitParseResult.flags" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-167 | 进度回调里的 `'map'` 分支不可达 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/panel.ts:329 | documents/viewer/implementation/replay.md | 判据：`git grep -n "'map'" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-168 | `MapPanel.spawnPoints` getter 零调用点 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/ui/mapinfo.ts:114 | documents/viewer/implementation/ui.md | 判据：`git grep -n "MapPanel.spawnPoints" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-201 | 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:507 | documents/game/implementation/app-entry.md | — | — |
| T-202 | 可选 DOM 依赖（`#loadMapBtn`/`#bspFile`/`#respawnBtn`/`#spawnSelect`）缺失时静默降级、无报错无提示 | 缺陷 | game | 待修 | apps/game/src/app.ts:317 | documents/game/implementation/app-entry.md | 判据：移除任一可选 DOM（如 @BT@#loadMapBtn@BT@）⇒ 页面/控制台出现可读提示，不静默降级 | — |
| T-203 | 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:249 | documents/game/implementation/app-entry.md | — | — |
| T-204 | `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指） | 缺陷 | game | 待裁决 | apps/game/src/input/input-bridge.ts:65 | documents/game/implementation/input.md | — | — |
| T-205 | `lockTickRate` 的 64 在 `syncFullConfig`、面板构造与 `DEFAULT_CONFIG` 三处硬编码、需同步修改 | 配置·门禁 | game | 待修 | apps/game/src/app.ts:640 | documents/game/implementation/config.md | 判据：@BT@git grep -n "lockTickRate" -- apps/game/src@BT@ ⇒ 64 只在一处定义、他处引用（改一处即生效） | — |
| T-206 | `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃 | 未接线·死代码 | game | 待修 | apps/game/src/input/input-bridge.ts:30 | documents/game/implementation/input.md | 判据：`git grep -n "InputBridge.addInput" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-207 | `requestLock` 的 `p instanceof Promise` 判门在当前签名下恒真、失败提示恒挂 promise 回调 | 缺陷 | game | 待修 | apps/game/src/app.ts:253 | documents/game/implementation/input.md | 判据：@BT@requestLock@BT@ 判门与当前签名一致（不再恒真）；失败提示走正确的回调分支 | — |
| T-208 | `bindSlider`／`bindCheckbox` 取不到元素时静默返回，控件缺失不报错 | 缺陷 | game | 待修 | apps/game/src/panel/panel-controller.ts:572 | documents/game/implementation/panel.md | 判据：@BT@bindSlider@BT@/@BT@bindCheckbox@BT@ 取不到元素时报错或告警（不静默 return） | — |
| T-209 | M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发 | 缺陷 | game | 已结案 | apps/game/src/panel/panel-controller.ts:265 ⇒ 两处监听均带 `this.sceneReady` 守卫（`updateVisibility` 写入、`hide()` 加载期复位）；`apps/game` typecheck 通过 | documents/game/implementation/panel.md | 见详情 | — |
| T-211 | `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:77 | documents/game/implementation/renderer.md | 判据：`git grep -n "ENABLE_PVS" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-212 | `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图 | 缺陷 | game | 待裁决 | apps/game/src/renderer/renderer-main.ts:264 | documents/game/implementation/renderer.md | — | — |
| T-213 | 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:92 | documents/game/implementation/savepoint.md | — | — |
| T-214 | 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:21 | documents/game/implementation/savepoint.md | — | — |
| T-215 | 存档解析结果不是数组时静默保持空列表、不报错，表现为该地图没有存点 | 缺陷 | game | 待修 | apps/game/src/savepoint.ts:57 | documents/game/implementation/savepoint.md | 判据：喂入非数组存档 ⇒ 有错误信号，而非静默保持空列表（表现为「该地图没有存点」） | — |
| T-216 | `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长 | 缺陷 | game | 待修 | apps/game/src/savepoint.ts:112 | documents/game/implementation/savepoint.md | 判据：连续 `add`/`delete` ⇒ 序列化次数不随条数线性增长（合并写入或防抖） | — |
| T-217 | `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方） | 缺陷 | game | 待修 | apps/game/crates/wasm/src/lib.rs:480 | documents/game/implementation/wasm-crate.md | 判据：@BT@BspProcessor@BT@ 上 @BT@#[wasm_bindgen]@BT@ 只出现一次且归属正确（不再悬空在注释块上方） | — |
| T-218 | `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl` | 缺陷 | game | 待修 | apps/game/crates/wasm/src/lib.rs:117 | documents/game/implementation/wasm-crate.md | 判据：zip 条目名非全小写时 `.vvd`/`.dx90.vtx` 仍取回正确文件（配对名按同一小写基准生成） | — |
| T-219 | `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组 | 文档口径 | game | 待修 | apps/game/src/worker/worker-types.ts:110 | documents/game/implementation/worker.md | 判据：文档中 @BT@SceneDataMessage@BT@ 归到「主线程 loadScene 形参」处，不再列在「Worker → 主线程」分组 | — |
| T-220 | `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加 | 缺陷 | game | 待修 | apps/game/src/worker/main.ts:513 | documents/game/implementation/worker.md | 判据：`world-parse-ms` 诊断不再重复解析（复用 `build_world` 的解析结果或降级移除该诊断） | — |
| T-222 | 20 个脚本里仅 7 个设退出码，其余 13 个结论只在 stdout 末行、接入 CI 时判定不带出 | 配置·门禁 | game | 待修 | 见详情 | documents/game/implementation/scripts.md | 判据：13 个脚本补 @BT@process.exitCode@BT@ 后逐个跑失败路径 ⇒ exit ≠ 0（结论能被 CI 带出） | — |
| T-223 | single 产物引用了不在保留名单里的 `coi-serviceworker.js`、dist 同目录无该文件 | 配置·门禁 | game | 待修 | apps/game/scripts/build-dist.mjs:60 | documents/game/implementation/scripts.md | 判据：构建 single 产物后 @BT@ls apps/game/dist/coi-serviceworker.js@BT@ 存在，或产物中不再引用它 | — |
| T-224 | `build-dist.mjs` 两条路径都打印同一组 `[5/5]` 前缀、与步骤序号无关 | 工具·流程 | game | 待修 | apps/game/scripts/build-dist.mjs:90 | documents/game/implementation/scripts.md | 判据：@BT@git grep -n "\[5/5\]" -- apps/game/scripts/build-dist.mjs@BT@ ⇒ 两条路径的前缀与步骤序号对应 | — |
| T-225 | `physics.mode` 零读取点 | 未接线·死代码 | game | 待修 | apps/game/src/config.ts:27 | documents/game/implementation/config.md | 判据：`git grep -n "physics.mode" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-226 | `sendSetDeathThreshold` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/input/input-bridge.ts:83 | documents/game/implementation/input.md | 判据：`git grep -n "sendSetDeathThreshold" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-227 | 共享层的累积路径无消费方 | 未接线·死代码 | game | 待修 | src/ts-shared/input/mouse-buffer.ts:81 | documents/game/implementation/input.md | 判据：@BT@git grep -n "<累积路径符号>" -- apps src@BT@ ⇒ 无消费方 ⇒ 删除 | — |
| T-228 | `sampleEpoch` 字段只写不读 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:130 | documents/game/implementation/renderer.md | 判据：`git grep -n "sampleEpoch" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-229 | `applyCollisionCorrection` 的入参有三个不被读取 | 未接线·死代码 | game | 待修 | src/ts-shared/phys/authority-calibrator.ts:735 | documents/game/implementation/renderer.md | 判据：`git grep -n "applyCollisionCorrection" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-230 | 光照模块内多个导出在本工程零导入点 | 未接线·死代码 | game | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1752 | documents/game/implementation/renderer.md | 判据：光照模块导出逐个 @BT@git grep -n "import" -- apps/game/src@BT@ ⇒ 零导入者 ⇒ 删除 | — |
| T-231 | `SavePoint.t` 只写不读 | 未接线·死代码 | game | 待修 | apps/game/src/app.ts:610 | documents/game/implementation/savepoint.md | 判据：`git grep -n "SavePoint.t" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-232 | `getMap()` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/savepoint.ts:69 | documents/game/implementation/savepoint.md | 判据：`git grep -n "getMap()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-233 | `clear()` 零调用点 | 未接线·死代码 | game | 待修 | apps/game/src/savepoint.ts:98 | documents/game/implementation/savepoint.md | 判据：`git grep -n "clear()" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-234 | `mtzB64` 与契约清单都指向了没有直接调用点的字段 | 未接线·死代码 | game | 待修 | src/ts-shared/auth/worker-dispatch.ts:297 | documents/game/implementation/scripts.md | 判据：`git grep -n "mtzB64" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-235 | `apps/game/src/world/types.ts` 在本工程零导入点 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:42 | documents/game/implementation/types.md | 判据：`git grep -n "apps/game/src/world/types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-236 | `export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点：… | 未接线·死代码 | game | 待修 | apps/game/crates/wasm/src/lib.rs:579 | documents/game/implementation/wasm-crate.md | 判据：`git grep -n "export_glb_with_pakfile_models_with_defaults_and_atlas_limit" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-237 | `map_name` 恒为空串 | 未接线·死代码 | game | 待修 | apps/game/crates/wasm/src/lib.rs:457 | documents/game/implementation/wasm-crate.md | 判据：`git grep -n "map_name" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-238 | `InitMessage` 有三个字段既无发送方也无读取点 | 未接线·死代码 | game | 待修 | apps/game/src/worker/worker-types.ts:36 | documents/game/implementation/worker.md | 判据：`git grep -n "InitMessage" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-239 | `worker-types.ts` 里多条声明在本工程无发送方且无接收点 | 未接线·死代码 | game | 待修 | src/ts-shared/auth/worker-dispatch.ts:265 | documents/game/implementation/worker.md | 判据：`git grep -n "worker-types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-301 | 回放捕获 `replayCapture.record` 未传 `dtS`，样本 `dt` 恒 0；`InputFrame` 亦无 `dt` 字段 | 缺陷 | debug | 待修 | apps/debug/src/app.ts:2241 | documents/debug/implementation/input.md | 判据：@BT@replayCapture.record@BT@ 传 @BT@dtS@BT@ ⇒ 样本 @BT@dt@BT@ 非 0（@BT@InputFrame@BT@ 增 @BT@dt@BT@ 字段） | — |
| T-302 | 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`） | 缺陷 | debug | 待修 | apps/debug/src/physics/param-defs.ts:89 | documents/debug/implementation/physics.md | 判据：`PARAM_DEFS` 与 `config.ts` 默认值有交叉校验（两处不一致时脚本/测试报错） | — |
| T-303 | 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1 | 缺陷 | debug | 待裁决 | apps/debug/src/renderer/lod-manager.ts:262 | documents/debug/implementation/renderer.md | — | — |
| T-304 | tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:708 | documents/debug/implementation/renderer.md | 判据：@BT@readPublishedTau()@BT@ 返回 0 时不再回落墙钟 ⇒ tick 线与另一条线时间同源可比 | — |
| T-305 | 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:712 | documents/debug/implementation/renderer.md | 判据：residual 传真实位置差 ⇒ 该组统计样本数 > 0（不再恒 0） | — |
| T-306 | lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform | 缺陷 | debug | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1549 | documents/debug/implementation/renderer.md | — | — |
| T-307 | `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2 | 缺陷 | debug | 待修 | apps/debug/scripts/frame-bench.mjs:37 | documents/debug/implementation/scripts.md | 判据：不传第 4 参跑 @BT@frame-bench.mjs@BT@ ⇒ 不再打印「地图不存在」并 exit 2（缺省路径可用或改为必填报错） | — |
| T-308 | 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套 | 工具·流程 | debug | 待修 | apps/debug/package.json:7 | documents/debug/implementation/scripts.md | 判据：`apps/debug/package.json` 有指向 dev/build/start/stop 的 script，`.cmd` 只做薄包装（环境准备只留一处） | — |
| T-309 | 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24） | 缺陷 | debug | 已结案 | apps/debug/src/wasm.d.ts:145 起 ⇒ 同块补 BspProcessor 12 个成员；`node .tmp/t007/probe.mjs` ⇒ BspProcessor 26/26 缺 0 | documents/debug/implementation/wasm-bindings.md | 见详情 | — |
| T-310 | `set-auto-restore-hull` 只改面板侧标记，`src/phys/**` 无对应参数与读取点，开关不写物理实例 | 未接线·死代码 | debug | 待修 | apps/debug/src/worker/worker-types.ts:146 | documents/debug/implementation/worker.md | 判据：`git grep -n "set-auto-restore-hull" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-311 | `custom-teleports` 的 localStorage 写入失败被静默忽略，调用方拿不到失败信号 | 缺陷 | debug | 待修 | apps/debug/src/world/custom-teleports.ts:66 | documents/debug/implementation/world.md | 判据：模拟 localStorage 写失败 ⇒ 调用方拿到失败信号（不再静默忽略） | — |
| T-312 | `tsconfig.json` 的五个路径别名零导入点 | 未接线·死代码 | debug | 待修 | apps/debug/tsconfig.json:19 | documents/debug/implementation/app.md | 判据：`git grep -n "tsconfig.json" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-313 | `keysFromMask` 无调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/input/input-recorder.ts:772 | documents/debug/implementation/input.md | 判据：`git grep -n "keysFromMask" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-314 | `InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄 | 未接线·死代码 | debug | 待修 | apps/debug/src/input/input-recorder.ts:541 | documents/debug/implementation/input.md | 判据：`git grep -n "InputPlayer.adopt" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-315 | `vec3.ts` 的 13 个函数零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/math/vec3.ts:11 | documents/debug/implementation/physics.md | 判据：`git grep -n "vec3.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-316 | `setParamFromMap` 零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/physics-params.ts:110 | documents/debug/implementation/physics.md | 判据：`git grep -n "setParamFromMap" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-317 | `TraceResult` 与 `V3Tuple` 的消费面不在本目录 | 未接线·死代码 | debug | 待修 | apps/debug/src/physics/physics/Collision/Collision.types.ts:49 | documents/debug/implementation/physics.md | 判据：`git grep -n "TraceResult" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-318 | `LOD_LEVEL.PVS_HIDDEN` 是预留档位 | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/lod-manager.ts:26 | documents/debug/implementation/renderer.md | 判据：`git grep -n "LOD_LEVEL.PVS_HIDDEN" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-319 | `assignClusterIds` 的结果无消费方 | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/lod-manager.ts:181 | documents/debug/implementation/renderer.md | 判据：`git grep -n "assignClusterIds" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-320 | 默认导出与 `parse_bsp` 在本工程零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/wasm.d.ts:20 | documents/debug/implementation/wasm-bindings.md | 判据：`git grep -n "parse_bsp" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-321 | `apps/debug/web/styles.css` 在全工程零引用 | 未接线·死代码 | debug | 待修 | apps/debug/scripts/build-dist.mjs:63 | documents/debug/implementation/web.md | 判据：`git grep -n "apps/debug/web/styles.css" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-322 | `TeleportManager` 的六项成员零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/teleport-manager.ts:18 | documents/debug/implementation/world.md | 判据：`git grep -n "TeleportManager" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-323 | `spawn-loader.ts` 整模块零调用点 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/spawn-loader.ts:11 | documents/debug/implementation/world.md | 判据：`git grep -n "spawn-loader.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-324 | `types.ts` 里有一批零引用类型 | 未接线·死代码 | debug | 待修 | apps/debug/src/world/types.ts:18 | documents/debug/implementation/world.md | 判据：`git grep -n "types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-401 | mosaic/decode.rs 的 code_to_img 不校验宽高下界、也不校验解码索引落在调色板色数内 | 缺陷 | shared | 待修 | src/wasm-core/mosaic/decode.rs:146 | documents/materials/overview.md；documents/wasm-core/overview.md | 判据：@BT@cargo test -p websurf-phys@BT@ 覆盖越界输入 ⇒ @BT@code_to_img@BT@ 返回错误，不越界读取调色板 | — |
| T-402 | `compute-mode` 的三模式接线 | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/auth-loop.ts:160 | documents/ts-shared/overview.md | 判据：`git grep -n "compute-mode" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-403 | `MouseBuffer.push` / `drain` | 未接线·死代码 | shared | 待修 | src/ts-shared/input/mouse-buffer.ts:81 | documents/ts-shared/overview.md | 判据：`git grep -n "MouseBuffer.push" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-404 | `ShmState.wake` | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/shared-state.ts:447 | documents/ts-shared/overview.md | 判据：`git grep -n "ShmState.wake" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-405 | `maskToKeys` | 未接线·死代码 | shared | 待修 | src/ts-shared/auth/shared-state.ts:98 | documents/ts-shared/overview.md | 判据：`git grep -n "maskToKeys" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-406 | `PvsManager.getFaceCluster` / `visibleClusterCount` | 未接线·死代码 | shared | 待修 | apps/game/src/renderer/renderer-main.ts:333 | documents/ts-shared/overview.md | 判据：`git grep -n "PvsManager.getFaceCluster" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-407 | `world/types.ts` 的 `rootNode` 字段 | 未接线·死代码 | shared | 待修 | apps/game/crates/wasm/src/lib.rs:1734 | documents/ts-shared/overview.md | 判据：`git grep -n "world/types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-408 | `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de… | 未接线·死代码 | shared | 待修 | src/wasm-core/bsp_to_gltf_core/convert.rs:367 | documents/wasm-core/overview.md | 判据：`git grep -n "bsp_to_gltf_core/convert.rs" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-409 | `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI，谁都不跑它） | 配置·门禁 | 共享 | 待修 | src/scripts/check-glb-parity.mjs:2 | documents/norms/scripts-and-ci.md | 判据：@BT@git grep -l "check-glb-parity" -- **/package.json .github@BT@ ⇒ 至少 1 个文件命中（已接线） | #409 |
| T-433 | 【S12·残留黑块的真实层级】owner 参考截图里的黑块 / 紫斑**全部**来自 prop 的逐顶点预烘焙光照路径（几何属性 `_VBSP_VLIGHT`，源文件是 pakfile 的 `sp_<i>.vhv`）：关闭该路径后同一视点纯黑像素 **4.94% → 0.00%**、均值 63.9 → 70.6。解析侧已逐字段对齐 SDK——`vradstaticprops.cpp:1563-1593` 写 `flags=4` / `vertexSize=4` 且顶点为 **B,G,R,A** 顺序，`gamebspfile.h:206-225` 的 `StaticPropLump_t` **没有** ambient cube 字段，与本仓 72 B 记录逐字段吻合；prop→文件的 checksum 校验 **1503 匹配 / 0 不符**。但**数据本身极暗**：1587 个 prop 全图最大字节仅 ~95/255、prop 均值亮度中位数 6.8/255、298 个 prop 全 0。VRAD 侧 `m_Color = direct + indirect`（`vradstaticprops.cpp:1427`）与世界面同一物理量 ⇒「world 亮、prop 近黑」是数据 + 兜底口径问题，**不是**解析错 | 缺陷 | shared | 待修 | src/wasm-core/vhv.rs:90 | progress/pending-detail.md | 判据：prop 逐顶点光照与 leaf ambient cube **相加**（引擎 2013 口径）⇒ owner 截图里的黑块 / 紫斑消除（黑像素占比 4.94% → 0.00%） | — |
| T-443 | 【S17·debug】帧探针 `applyPose` 只有 `spawn`/`surface` 两个预设 ⇒ 脚本无法钉任意位姿出图；补 `applyPoseAt(pos, yawDeg, pitchDeg)`（走现成 `setHoldPoint`） | 缺失 | debug | 待修 | apps/game/src/renderer/renderer-main.ts:1020 | progress/monthly/2026-10-6.md | 判据：脚本调用后 `cameraPose()` 返回同一 pos/yaw/pitch，两次运行像素 diff≈0 | — |
| T-446 | 盒**起点落在道具 `.phy` 凸壳内部**时该道具整块被跳过（`start_solid` 分支既不出接触、也不做退嵌）⇒ boreas `1600,7600` 的 `ramp_c1m`（678 三角、y≈339 有朝上面）自上而下 500 HU 扫掠一次都不命中、玩家穿坡落到 -38；同点位换 `dx/dz ±48` 复现一致 | 缺陷 | shared | 待修 | 见详情 | progress/monthly/2026-10-6.md | 判据：@BT@node .tmp/mapsurvey/spot1600b.mjs@BT@ ⇒ `从 y=340 向下 frac=0.688 命中y=-4.0`（未命中 y≈339 的坡面） | — |
| T-441 | 【S16】置换面碰撞**分块懒加载**（落实 D-017：owner 2026-10-08 裁决，避免一次性 ~13MB JSON / 13 万三角形入物理） | 缺陷 | shared | 待修 | src/ts-shared/phys/world-builder.ts:203 | progress/monthly/2026-10-6.md | 判据：置换面按块分批构建；`triJson` 单次体积显著下降且洞穴壁仍全有碰撞 | — |
| T-503 | mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效 | 缺陷 | shared | 待修 | src/renderer-shared/scene/scene-optimizer.ts:258 | progress/open-issues/03-renderer-merge-normal-attribute.md | 判据：三应用合批生效（合批 Mesh 数 > 0，日志无「normal 属性不一致」失败） | 原 03 |
| T-504 | 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉 | 缺陷 | shared | 待裁决 | 见详情 | progress/open-issues/04-wasm-untextured-surface-color.md | — | 原 04 |
| T-601 | 注释瘦身 · 共享层：20 处超长注释 + 3 个超长文件头（含 lightmap-shader.ts / player.rs / vbsp / gltf_builder.rs / authority-calibrator.ts 等） | 文档口径 | shared | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1582 | documents/architecture/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-602 | 注释瘦身 · debug：4 处超长注释 + 0 个超长文件头（debug 脚本与 app.ts / teleport-manager.ts / path-recorder.ts / crates/wasm 等） | 文档口径 | debug | 待修 | apps/debug/scripts/jump-apex-verify.mjs:1 | documents/debug/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-603 | 注释瘦身 · game：2 处超长注释 + 1 个超长文件头（worker/main.ts 与 crates/wasm/src/lib.rs 等） | 文档口径 | game | 待修 | apps/game/src/worker/main.ts:1 | documents/game/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-604 | 注释瘦身 · viewer：1 处超长注释 | 文档口径 | viewer | 待修 | apps/viewer/src/replay/demopanel.ts:1238 | documents/viewer/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-607 | 【S19·Pages 站点守卫】站点源被切成「从分支构建」后，GitHub 内部 `pages-build-deployment` 会在**每次推送**（含纯文档推送）把仓库根按 Jekyll 发布、顶掉 Actions 产物，而部署链无任何断言/告警（2026-10-08 设置被切走；2026-10-09 02:40 的纯文档推送把站点顶掉，35 分钟后才发现） | 配置·门禁 | repo | 待修 | .github/workflows/deploy-pages.yml:200 | progress/monthly/2026-10-7.md | 判据：站点源被改成「从分支构建」时自检报错（定时 workflow 红或部署后断言失败）；正常时 `curl -s https://jofengseir.github.io/websurf/version.json` 的 id 与本次部署一致 | — |
| T-608 | 核实「单入口」假设：Copilot / Gemini CLI 是否真的读根 `AGENTS.md`（目前只是通行约定），结论与出处写进规范篇 | 文档口径 | docs | 待修 | AGENTS.md:5 | documents/norms/annotation-and-verification.md | 判据：逐字核实两个工具是否读根 `AGENTS.md`（官方文档或实测）⇒ 结论与出处落进 `documents/norms/**`（只读，须 owner 许可 + sync） | — |
| T-609 | 体检 `[O]` 对**终态行**（已记录 / 已结案）的「判据」列按行态保护：改终态行判据须先 approve，未结行改判据不拦 | 工具·流程 | repo | 待修 | src/scripts/docflow.mjs:201 | documents/norms/annotation-and-verification.md | 判据：改一条终态行的判据 ⇒ `node src/scripts/docflow.mjs check` 报「受保护列」；改未结行的判据不报 | — |
