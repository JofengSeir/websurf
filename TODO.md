# 待办看板（TODO Board）

> **唯一事实来源**：所有待裁决 / 待修 / 已取证待立项 / 进行中事项的**状态只在本页登记**。
> 其余文档只写技术事实，不复述状态；代码注释只允许写「见 TODO.md T-###」。
> 规则：一行一条；ID 永不复用；结案保留 ID；**改代码或裁决的同一提交必须更新对应行**。
> 台账号（原 AGENTS §7.3 的「N 条」聚合行）在底层条目细化后**保留原行**、置 `已记录` 并在事项前标「【台账号·已细化】」，只作编号追溯，不再承载状态；未完全细化者保留原状态并标注已细化部分。
> **体量策略**：本表超过 **96 KB 或 300 条**时，按两级处理——①把「已记录 + 已结案」整段移入 `progress/board/archive-<年-月>.md`（**未结项永不分卷**；2026-10-07 已触发一次）；②若已分卷后仍超限，则**逐行精简**：`证据`/`判据` 超长的改写为「见详情」并把全文移入该行详情页，`事项` 一律 ≤ 120 字符。体检 `[H]` 硬查 96 KB。**分卷/归档前先取许可**：`node src/scripts/docflow.mjs approve --path TODO.md --by <谁> --reason 分卷`，移完再 `sync`（本表不许 agent 删行，无许可 `sync` 会保留旧钉、体检逐条报「单元被删除」）。
> **ID 分配**：新条目取**所属区段的下一个未用号**——viewer `T-1xx`、game `T-2xx`、debug `T-3xx`、shared `T-4xx`、取证项 `T-5xx`、跨区/文档治理 `T-6xx`；**已出现过的号永不复用**。
> **下一可用号（实测，含 `progress/board/archive-2026-10.md` 的历史行；只写数字部分）**：viewer **170**；game **240**；debug **325**；shared **441**；取证项 **508**；跨区/文档治理 **606**。分配新条目后同步更新本行。
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

## 未结项（173 条）

### 待裁决（64）

- **T-005** apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html…　`game`
- **T-007** apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into…　`debug`
- **T-013** lightmap.rs 错误串含外部实现引用 Lightmap.cs:64　`shared`
- **T-015** vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤）　`shared`
- **T-016** compute-mode.ts 的 summary 字面量含已删文档编号　`shared`
- **T-018** tick-authority.test.ts 断言标签含 Q1 / §8.5　`shared`
- **T-021** game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略）　`game`
- **T-024** game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等）　`game`
- **T-031** game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB）　`game`
- **T-033** 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等）　`repo`
- **T-048** worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea…　`debug`
- **T-053** viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/…　`viewer`
- **T-054** debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g…　`debug`
- **T-055** game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（…　`game`
- **T-056** 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局…　`game`
- **T-060** .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01　`viewer`
- **T-064** 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d…　`docs`
- **T-066** .phy 凸包表达不了曲面坡（progress/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实…　`shared`
- **T-067** 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner …　`shared`
- **T-101** 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错）　`viewer`
- **T-103** ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动）　`viewer`
- **T-106** numField 把空串当合法 0 写入变换　`viewer`
- **T-107** 分块选块包围盒只统计部分 Mesh，块边长由子集推出　`shared`
- **T-110** 包内 svc_CreateStringTable 只稳定解出第一张表　`viewer`
- **T-111** svc_CreateStringTable 的压缩标志未实现　`viewer`
- **T-112** svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过　`viewer`
- **T-113** svc_GameEvent 只按长度跳过，事件描述符表未保存　`viewer`
- **T-116** 注入期 throw 不在本工程调用方 catch 覆盖范围内　`shared`
- **T-117** broken 阶段对照靠失配字面量维持，three 升级需同步　`shared`
- **T-119** 时间轴两条 title 文案与默认播放窗口矛盾　`viewer`
- **T-124** Track.offset 只有下界没有上界，可拉长主时钟总长　`viewer`
- **T-125** 零帧轨道的口径不一致（列表面板有卡片、3D 无对象）　`viewer`
- **T-128** dist 里的示例记录无法由当前源码路径重新产出　`viewer`
- **T-129** 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080　`viewer`
- **T-137** 端口占用分支假定占用者服务的是 dist　`viewer`
- **T-139** 导航缺「卸载地图」入口，载入过地图后回不到空态　`viewer`
- **T-142** 信息条重找跟随轨道，与 TrackSet.follow 策略重复　`viewer`
- **T-143** el() 属性写入限制了 id 型契约（undefined 静默无 id）　`viewer`
- **T-145** 模型名匹配与材质查找的大小写口径不一致　`viewer`
- **T-147** 材质去重键是材质名，同名材质被后续模型复用　`viewer`
- **T-148** packed_files 构造期缓存而 num_static_props 每次现算　`viewer`
- **T-149** map_name 两端都拿不到值，字段保留但无内容　`viewer`
- **T-151** BspMetadata 与 TS 契约靠约定对齐，无编译期校验　`viewer`
- **T-152** Worker 没有心跳，请求侧无法区分「在解析」与「已失联」　`viewer`
- **T-153** WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker）　`viewer`
- **T-201** 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色　`game`
- **T-203** 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈　`game`
- **T-204** `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指）　`game`
- **T-209** M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发　`game`
- **T-210** 分块 cell 尺寸只在单材质分支累计包围盒，仅有多材质网格时并集为空、整个分块直接返回　`shared`
- **T-212** `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图　`game`
- **T-213** 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错　`game`
- **T-214** 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态　`game`
- **T-216** `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长　`game`
- **T-218** `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl`　`game`
- **T-220** `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加　`game`
- **T-302** 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`）　`debug`
- **T-303** 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1　`debug`
- **T-306** lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform　`debug`
- **T-308** 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套　`debug`
- **T-309** 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24）　`debug`
- **T-409** `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI）　`共享`
- **T-433** prop 逐顶点光照（`sp_<i>.vhv`）数据极暗：黑块 / 紫斑的**唯一**来源（关掉该路径黑像素 4.94%→0.00%），解析已对齐 SDK（checksum 1503/1503），收口口径待定　`shared`
- **T-504** 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉　`shared`
- **T-506** 站立时的真卡死不再被处理（修法 A 的既定代价，未构造场景验证后果）　`shared`
- **T-507** check_stuck 的修法 D / C 未实施　`shared`
- **T-601** 注释瘦身 · 共享层：20 处超长注释 + 3 个超长文件头（含 lightmap-shader.ts / player.rs / vbsp / gltf_builder.rs / authority-calibrator.ts 等）　`shared`
- **T-602** 注释瘦身 · debug：4 处超长注释 + 0 个超长文件头（debug 脚本与 app.ts / teleport-manager.ts / path-recorder.ts / crates/wasm 等）　`debug`
- **T-603** 注释瘦身 · game：2 处超长注释 + 1 个超长文件头（worker/main.ts 与 crates/wasm/src/lib.rs 等）　`game`
- **T-604** 注释瘦身 · viewer：1 处超长注释　`viewer`

### 待修（108）

- **T-440** 置换面碰撞：1351 张 disp 面此前零碰撞；`export_displacement_colliders` ⇒ 132,480 三角形，待 TS 接入　`shared`
- **T-008** apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new …　`game`
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
- **T-108** 回退脚本加载无超时且成功路径不移除 script 标签　`viewer`
- **T-114** 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems）　`viewer`
- **T-118** A-B 区间带恒不显示（宽度算式分子恒等于分母）　`viewer`
- **T-120** 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏　`viewer`
- **T-121** disposeTree 不释放轨迹线（Line）与 tick 点（Points）　`viewer`
- **T-122** createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL　`viewer`
- **T-123** 导入无超时与取消，Worker 不回消息时 Promise 永不结算　`viewer`
- **T-126** panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU　`viewer`
- **T-127** 真实夹具路径跨三处失效（指向 test/maps 而非 test/replay）　`viewer`
- **T-130** 冒烟按键断言（6 键）与当前 UI 八键不一致　`viewer`
- **T-131** 冒烟三条静态断言只对 single 产物成立　`viewer`
- **T-133** .gitignore 中间产物目录与 test:replay 实际输出不一致　`viewer`
- **T-136** single 分支四段日志都写 [5/5] 步骤编号　`viewer`
- **T-138** 光照模式下拉只写不回填，与运行期真实模式脱节　`viewer`
- **T-140** 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复　`viewer`
- **T-141** setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError　`viewer`
- **T-144** .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节　`viewer`
- **T-146** 锁中毒会 panic，与本文件其它失败形态不一致　`viewer`
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
- **T-217** `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方）　`game`
- **T-219** `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组　`game`
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
- **T-304** tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源　`debug`
- **T-305** 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0　`debug`
- **T-307** `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2　`debug`
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
- **T-503** mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效　`shared`

### 已取证待立项（2）

- **T-109** 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正　`viewer`
- **T-115** untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查　`viewer`

> 已记录 / 已结案 **40 条已分卷**到 `progress/board/archive-2026-10.md`（ID 与状态保留；编号不复用，取新号时连同该页一起数）。

## 总表（190 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 判据 | 原号 |
|---|---|---|---|---|---|---|---|---|
| T-005 | apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html… | 缺陷 | game | 待裁决 | apps/game/web/index.html:19 | progress/pending-detail.md | — | #5 |
| T-007 | apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into… | 缺陷 | debug | 待裁决 | apps/debug/src/wasm.d.ts:67-119 | progress/pending-detail.md | — | #8 |
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | 配置·门禁 | game | 待修 | apps/game/scripts/check-wasm-api.mjs:52-70 | progress/pending-detail.md | 判据：跑 @BT@node apps/game/scripts/check-wasm-api.mjs@BT@ ⇒ exit 0，且 PHYS_API 列出的项 ≥ crates/wasm 实际导出数（不再缺 @BT@new@BT@ 等） | #9 |
| T-013 | lightmap.rs 错误串含外部实现引用 Lightmap.cs:64 | 缺陷 | shared | 待裁决 | src/wasm-core/bsp_to_gltf_core/lightmap.rs:219 | progress/pending-detail.md | — | #28 |
| T-015 | vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤） | 缺陷 | shared | 待裁决 | 见详情 | progress/pending-detail.md | — | #31 |
| T-016 | compute-mode.ts 的 summary 字面量含已删文档编号 | 文档口径 | shared | 待裁决 | src/ts-shared/auth/compute-mode.ts:89 | progress/pending-detail.md | — | #36 |
| T-018 | tick-authority.test.ts 断言标签含 Q1 / §8.5 | 缺陷 | shared | 待裁决 | src/ts-shared/auth/tick-authority.test.ts:625 | progress/pending-detail.md | — | #40 |
| T-021 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 缺陷 | game | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1789 | progress/pending-detail.md | — | #50 |
| T-023 | check-wasm-api.mjs 输出标签 F4 无出处 | 配置·门禁 | game | 已结案 | git grep -n "F4" -- apps/game/scripts ⇒ 0 命中（2026-10-07 复核；标签已改为无编号输出） | progress/pending-detail.md | 判据：@BT@git grep -n "F4" -- apps/game/scripts@BT@ ⇒ 标签有出处（指向规范/文档的编号体系）或已改为无编号输出 | #52 |
| T-024 | game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等） | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #53 |
| T-029 | debug 脚本 10 条（jump-apex 采样链链路级仍待裁决 | 配置·门禁 | debug | 待修 | 见详情 | progress/pending-detail.md | 判据：10 条子项逐条处置完毕；每条子项脚本跑通 exit 0，并在 @BT@progress/pending-detail.md@BT@ 对应条目标注处置结果 | #60 |
| T-031 | game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB） | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #62 |
| T-032 | game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等） | 配置·门禁 | game | 待修 | 见详情 | progress/pending-detail.md | 判据：7 条子项逐条处置；@BT@_dbg_floor@BT@ 的 onGround 不再恒 undefined（脚本输出该字段有真值） | #63 |
| T-033 | 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等） | 缺陷 | repo | 待裁决 | 见详情 | progress/pending-detail.md | — | #64 |
| T-035 | input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i… | 缺陷 | debug | 已结案 | documents/debug/implementation/scripts.md | progress/pending-detail.md | 判据：@BT@git ls-files -- apps/debug/scripts/input-replay-verify.mjs@BT@ ⇒ 0 命中（已退役、不进版本库）；@BT@git grep -n "input-replay-verify" -- apps/debug/src@BT@ ⇒ 0 命中（源码注释不再引用） | #66 |
| T-036 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等） | 未接线·死代码 | repo | 待修 | 见详情 | progress/pending-detail.md | 判据：剩余 15 条逐条 @BT@git grep -n "<符号>" -- src apps@BT@ ⇒ 只剩定义处 ⇒ 删除；删后体检 exit 0 且构建通过 | #67 |
| T-038 | 三工程入口 .cmd 的 2 条遗留（viewer build.cmd single-only 与底层 --multi 不一致、端口占用分支假定占用者服务 dist/） | 配置·门禁 | repo | 已结案 | apps/viewer/build.cmd:81 / 三工程 start.cmd | progress/pending-detail.md | 判据：@BT@git grep -n "opening the browser to the running server" -- apps/debug/start.cmd apps/game/start.cmd apps/viewer/start.cmd@BT@ ⇒ 0 命中；@BT@git grep -n "single-only" -- apps/viewer/build.cmd@BT@ ⇒ 0 命中 | #69 |
| T-039 | 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep… | 配置·门禁 | repo | 待修 | 见详情 | progress/pending-detail.md | 判据：@BT@cargo check -p websurf-phys@BT@ 等各 crate 无 @BT@unused_crate_dependencies@BT@ 警告 ⇒ 依赖表与源码引用面一致 | #70 |
| T-040 | debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g… | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:1517 | progress/pending-detail.md | 判据：@BT@git grep -n "worker-b" apps/debug/src apps/game/src@BT@ ⇒ 两处措辞一致，或都改为不带外部实现引用的写法 | #71 |
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | 未接线·死代码 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:486 | progress/pending-detail.md | 判据：@BT@getLightingMode@BT@ 清点调用点（@BT@apps/debug/src/renderer/renderer-main.ts:486@BT@ 疑有一处）⇒ 真零调用则删，否则结案并改状态 | #78 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | 未接线·死代码 | debug | 待修 | apps/game/src/app.ts:170 | progress/pending-detail.md | 判据：@BT@git grep -n "resetTo\ | \.stop(" -- src apps@BT@ ⇒ 无外部调用点则删；有则接线并补调用 | #79 |
| T-048 | worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea… | 文档口径 | debug | 待裁决 | 见详情 | progress/pending-detail.md | — | #80 |
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:110 | progress/pending-detail.md | — | #84 |
| T-054 | debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g… | 缺陷 | debug | 待裁决 | apps/debug/src/app.ts:1992 | progress/pending-detail.md | — | #85 |
| T-055 | game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（… | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #86 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 缺陷 | game | 待裁决 | 见详情 | progress/pending-detail.md | — | #87 |
| T-058 | DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30 | 未接线·死代码 | viewer | 待修 | 见详情 | progress/pending-detail.md | 判据：零应用字段逐条 @BT@git grep -n "<字段>" -- src apps@BT@ ⇒ 只剩定义处则删字段，否则接线 | #89 |
| T-060 | .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01 | 缺陷 | viewer | 待裁决 | 见详情 | progress/pending-detail.md | — | #91 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | 未接线·死代码 | viewer | 待修 | apps/viewer/src/replay/panel.ts:283 | progress/pending-detail.md | 判据：@BT@git grep -n "importer" -- apps/viewer/src@BT@ ⇒ Source .dem 分支无 UI 调用路径 ⇒ 删或接线 | #93 |
| T-064 | 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d… | 文档口径 | docs | 待裁决 | apps/debug/src/worker/main.ts:483 | progress/pending-detail.md | — | #95 |
| T-066 | .phy 凸包表达不了曲面坡（progress/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实… | 缺陷 | shared | 待裁决 | 见详情 | progress/open-issues/06-phy-hull-facet-jump.md | — | #97 |
| T-067 | 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner … | 缺陷 | shared | 待裁决 | 见详情 | progress/pending-detail.md | — | #98 |
| T-101 | 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:210 | documents/viewer/implementation/app.md | — | — |
| T-102 | 贴合检查提示串的 bbox 只取第一条越界轨道 | 缺陷 | viewer | 待修 | apps/viewer/src/app.ts:267 | documents/viewer/implementation/app.md | 判据：构造 2 条以上越界轨道 ⇒ 提示串 bbox 覆盖全部（不再只取第一条） | — |
| T-103 | ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:807 | documents/viewer/implementation/app.md | — | — |
| T-104 | 构造期 setLightGamma(2.2) 落在着色器接受窗口外被忽略 | 缺陷 | viewer | 已结案 | src/renderer-shared/shader/lightmap-shader.ts:1789 | 本行即全部 | 判据：页面加载后控制台无「γ 落在接受窗口外被忽略」告警，且模式切换后 γ 生效 | — |
| T-105 | ensureWasm 把首次失败永久缓存，一次瞬时失败后本会话不自愈 | 缺陷 | viewer | 待修 | apps/viewer/src/core/bsp.ts:82 | documents/viewer/implementation/core.md | 判据：首次 @BT@ensureWasm@BT@ 失败后再次调用会重试（断网→联网后可自愈） | — |
| T-106 | numField 把空串当合法 0 写入变换 | 缺陷 | viewer | 待裁决 | apps/viewer/src/core/dom.ts:107 | documents/viewer/implementation/core.md | — | — |
| T-107 | 分块选块包围盒只统计部分 Mesh，块边长由子集推出 | 缺陷 | shared | 待裁决 | src/renderer-shared/scene/scene-optimizer.ts:250 | documents/viewer/implementation/core.md | — | — |
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
| T-119 | 时间轴两条 title 文案与默认播放窗口矛盾 | 文档口径 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:108 | documents/viewer/implementation/replay.md | — | — |
| T-120 | 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:551 | documents/viewer/implementation/replay.md | 判据：构造 @BT@Track.offset ≠ 0@BT@ 的轨道 ⇒ 正式跑段高亮的位置与宽度同基对齐 | — |
| T-121 | disposeTree 不释放轨迹线（Line）与 tick 点（Points） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/visuals.ts:168 | documents/viewer/implementation/replay.md | 判据：反复载入/卸载场景 ⇒ 轨迹线（Line）与 tick 点（Points）被释放（@BT@renderer.info.memory@BT@ 回落） | — |
| T-122 | createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:101 | documents/viewer/implementation/replay.md | 判据：重起 Worker 后 blob URL 不累积（@BT@createObjectURL@BT@ 与 @BT@revokeObjectURL@BT@ 配对） | — |
| T-123 | 导入无超时与取消，Worker 不回消息时 Promise 永不结算 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:137 | documents/viewer/implementation/replay.md | 判据：Worker 不回消息时导入 Promise 以超时结算（不再永不 settle），并可取消 | — |
| T-124 | Track.offset 只有下界没有上界，可拉长主时钟总长 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/trackpanel.ts:204 | documents/viewer/implementation/replay.md | — | — |
| T-125 | 零帧轨道的口径不一致（列表面板有卡片、3D 无对象） | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/visuals.ts:96 | documents/viewer/implementation/replay.md | — | — |
| T-126 | panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU | 文档口径 | viewer | 待修 | apps/viewer/src/replay/panel.ts:154 | documents/viewer/implementation/replay.md | 判据：@BT@git grep -n "默认 0" -- apps/viewer/src/replay/panel.ts@BT@ ⇒ hint 与 @BT@step=10 HU@BT@ 一致 | — |
| T-127 | 真实夹具路径跨三处失效（指向 test/maps 而非 test/replay） | 缺陷 | viewer | 待修 | apps/viewer/test/replay-selftest.ts:75 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "test/maps" -- apps/viewer@BT@ ⇒ 0 命中（夹具路径指向 test/replay） | — |
| T-128 | dist 里的示例记录无法由当前源码路径重新产出 | 缺陷 | viewer | 待裁决 | apps/viewer/scripts/build-dist.mjs:238 | documents/viewer/implementation/scripts-and-test.md | — | — |
| T-129 | 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:32 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "8080" -- apps/viewer/test/smoke-cdp.mjs@BT@ ⇒ 0 命中（缺省 SMOKE_URL 指向本工程端口 8100） | — |
| T-130 | 冒烟按键断言（6 键）与当前 UI 八键不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:415 | documents/viewer/implementation/scripts-and-test.md | 判据：跑 viewer 冒烟脚本 ⇒ 按键断言条数与当前 UI 八键一致 | — |
| T-131 | 冒烟三条静态断言只对 single 产物成立 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:138 | documents/viewer/implementation/scripts-and-test.md | 判据：冒烟三条静态断言在 single 与多产物两种形态下都成立 ⇒ 各跑一次 exit 0 | — |
| T-132 | WS_PATH 兜底是本机绝对路径，换机器不可用 | 配置·门禁 | viewer | 已结案 | apps/viewer/test/smoke-cdp.mjs:43 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "C:/Users/" -- apps/viewer/test/smoke-cdp.mjs@BT@ ⇒ 0 命中（兜底只认 WS_PATH 或本工程 node_modules/ws） | — |
| T-133 | .gitignore 中间产物目录与 test:replay 实际输出不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/package.json:10 | documents/viewer/implementation/scripts-and-test.md | 判据：跑 @BT@npm run test:replay@BT@ 后 @BT@git status --short@BT@ 无未忽略产物 ⇒ .gitignore 与实际输出目录一致 | — |
| T-134 | build.cmd 无法产出 multi 产物 | 工具·流程 | viewer | 已结案 | apps/viewer/build.cmd:81 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "single-only" -- apps/viewer/build.cmd@BT@ ⇒ 0 命中；@BT@git grep -n "DIST_ARG" -- apps/viewer/build.cmd@BT@ ⇒ 命中（模式透传到 build-dist） | — |
| T-135 | start.cmd 的 python 守卫让 dist/play.cmd 的 Node 兜底不可达 | 缺陷 | viewer | 已结案 | apps/viewer/start.cmd:35 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "play.cmd" -- apps/viewer/start.cmd@BT@ 的行号 < @BT@git grep -n "where python" -- apps/viewer/start.cmd@BT@ 的行号；桩测试（PATH 无 python + 桩 dist\play.cmd）⇒ 输出 [STUB] 且无解析错误 | — |
| T-136 | single 分支四段日志都写 [5/5] 步骤编号 | 工具·流程 | viewer | 待修 | apps/viewer/scripts/build-dist.mjs:315 | documents/viewer/implementation/scripts-and-test.md | 判据：@BT@git grep -n "\[5/5\]" -- apps/viewer/scripts@BT@ ⇒ single 分支四段日志编号与步骤序号一致 | — |
| T-137 | 端口占用分支假定占用者服务的是 dist | 缺陷 | viewer | 待裁决 | apps/viewer/start.cmd:26 | documents/viewer/implementation/scripts-and-test.md | — | — |
| T-138 | 光照模式下拉只写不回填，与运行期真实模式脱节 | 缺陷 | viewer | 待修 | apps/viewer/src/ui/mapinfo.ts:98 | documents/viewer/implementation/ui.md | 判据：切换光照模式后下拉框回填值与 @BT@getLightingMode()@BT@ 一致（不再只写不回填） | — |
| T-139 | 导航缺「卸载地图」入口，载入过地图后回不到空态 | 缺陷 | viewer | 待裁决 | apps/viewer/src/ui/mapinfo.ts:130 | documents/viewer/implementation/ui.md | — | — |
| T-140 | 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复 | 未接线·死代码 | viewer | 待修 | apps/viewer/src/ui/telemetry.ts:122 | documents/viewer/implementation/ui.md | 判据：@BT@git grep -rn "水平速度\ | horizontalSpeed" -- apps/viewer/src@BT@ ⇒ 只剩 sampling/player 一处实现 | — |
| T-141 | setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError | 缺陷 | viewer | 待修 | apps/viewer/src/ui/telemetry.ts:110 | documents/viewer/implementation/ui.md | 判据：@BT@setTracks(null)@BT@ ⇒ 不抛 TypeError（有明确容错） | — |
| T-142 | 信息条重找跟随轨道，与 TrackSet.follow 策略重复 | 缺陷 | viewer | 待裁决 | apps/viewer/src/ui/replaymeta.ts:25 | documents/viewer/implementation/ui.md | — | — |
| T-143 | el() 属性写入限制了 id 型契约（undefined 静默无 id） | 缺陷 | viewer | 待裁决 | apps/viewer/src/core/dom.ts:39 | documents/viewer/implementation/ui.md | — | — |
| T-144 | .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:119 | documents/viewer/implementation/wasm.md | 判据：@BT@.MDL@BT@ 大小写不敏感匹配 ⇒ vvd/vtx 槽位不再填入 .mdl 字节，三件齐检查有效 | — |
| T-145 | 模型名匹配与材质查找的大小写口径不一致 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:606 | documents/viewer/implementation/wasm.md | — | — |
| T-146 | 锁中毒会 panic，与本文件其它失败形态不一致 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:429 | documents/viewer/implementation/wasm.md | 判据：构造锁中毒场景 ⇒ 返回错误而非 panic（@BT@cargo test@BT@ 覆盖该路径） | — |
| T-147 | 材质去重键是材质名，同名材质被后续模型复用 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:216 | documents/viewer/implementation/wasm.md | — | — |
| T-148 | packed_files 构造期缓存而 num_static_props 每次现算 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:381 | documents/viewer/implementation/wasm.md | — | — |
| T-149 | map_name 两端都拿不到值，字段保留但无内容 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:389 | documents/viewer/implementation/wasm.md | — | — |
| T-150 | Cargo.toml 说明把已不在工作区的 test 列为同款 patch 持有方 | 配置·门禁 | viewer | 已结案 | git grep -n "test" -- apps/viewer/Cargo.toml ⇒ 0 命中（2026-10-07 复核；patch 持有方只列 vmdl） | documents/viewer/implementation/wasm.md | 判据：@BT@git grep -n "test" -- apps/viewer/Cargo.toml@BT@ ⇒ 不再把已退役的 @BT@test@BT@ 列为 patch 持有方 | — |
| T-151 | BspMetadata 与 TS 契约靠约定对齐，无编译期校验 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:362 | documents/viewer/implementation/wasm.md | — | — |
| T-152 | Worker 没有心跳，请求侧无法区分「在解析」与「已失联」 | 缺陷 | viewer | 待裁决 | apps/viewer/src/worker/main.ts:91 | documents/viewer/implementation/worker.md | — | — |
| T-153 | WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker） | 缺陷 | viewer | 待裁决 | apps/viewer/src/worker/main.ts:33 | documents/viewer/implementation/worker.md | — | — |
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
| T-169 | viewer 记录链路不认 KSF/gokz `.rec`（ksf.surf 回放文件：i32 魔数 2/3 纯二进制头，非 shavit 文本头格式）⇒ 嗅探落 unknown 被拒 | 缺陷 | viewer | 已结案 | apps/viewer/src/replay/gokz-rec.ts:130 | documents/viewer/implementation/replay.md | 判据：`cd apps/viewer && npm run test:replay` ⇒ 新增 gokz .rec 合成夹具组（嗅探 / 头解析与闭合 / 坐标映射 / Clip 装配 / v2 分支）全 ok 且 exit 0；`cd apps/viewer && npm run typecheck` ⇒ 0 错；`node src/scripts/check-doc-drift.mjs` ⇒ A–G 全 0（agent 沙箱 git EBUSY 跑不了时由 CI/owner 复跑） | — |
| T-201 | 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:507 | documents/game/implementation/app-entry.md | — | — |
| T-202 | 可选 DOM 依赖（`#loadMapBtn`/`#bspFile`/`#respawnBtn`/`#spawnSelect`）缺失时静默降级、无报错无提示 | 缺陷 | game | 待修 | apps/game/src/app.ts:317 | documents/game/implementation/app-entry.md | 判据：移除任一可选 DOM（如 @BT@#loadMapBtn@BT@）⇒ 页面/控制台出现可读提示，不静默降级 | — |
| T-203 | 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:249 | documents/game/implementation/app-entry.md | — | — |
| T-204 | `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指） | 缺陷 | game | 待裁决 | apps/game/src/input/input-bridge.ts:65 | documents/game/implementation/input.md | — | — |
| T-205 | `lockTickRate` 的 64 在 `syncFullConfig`、面板构造与 `DEFAULT_CONFIG` 三处硬编码、需同步修改 | 配置·门禁 | game | 待修 | apps/game/src/app.ts:640 | documents/game/implementation/config.md | 判据：@BT@git grep -n "lockTickRate" -- apps/game/src@BT@ ⇒ 64 只在一处定义、他处引用（改一处即生效） | — |
| T-206 | `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃 | 未接线·死代码 | game | 待修 | apps/game/src/input/input-bridge.ts:30 | documents/game/implementation/input.md | 判据：`git grep -n "InputBridge.addInput" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-207 | `requestLock` 的 `p instanceof Promise` 判门在当前签名下恒真、失败提示恒挂 promise 回调 | 缺陷 | game | 待修 | apps/game/src/app.ts:253 | documents/game/implementation/input.md | 判据：@BT@requestLock@BT@ 判门与当前签名一致（不再恒真）；失败提示走正确的回调分支 | — |
| T-208 | `bindSlider`／`bindCheckbox` 取不到元素时静默返回，控件缺失不报错 | 缺陷 | game | 待修 | apps/game/src/panel/panel-controller.ts:572 | documents/game/implementation/panel.md | 判据：@BT@bindSlider@BT@/@BT@bindCheckbox@BT@ 取不到元素时报错或告警（不静默 return） | — |
| T-209 | M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发 | 缺陷 | game | 待裁决 | apps/game/src/panel/panel-controller.ts:265 | documents/game/implementation/panel.md | — | — |
| T-210 | 分块 cell 尺寸只在单材质分支累计包围盒，仅有多材质网格时并集为空、整个分块直接返回 | 缺陷 | shared | 待裁决 | src/renderer-shared/scene/scene-optimizer.ts:250 | documents/game/implementation/renderer.md | — | — |
| T-211 | `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造 | 未接线·死代码 | game | 待修 | apps/game/src/renderer/renderer-main.ts:77 | documents/game/implementation/renderer.md | 判据：`git grep -n "ENABLE_PVS" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-212 | `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图 | 缺陷 | game | 待裁决 | apps/game/src/renderer/renderer-main.ts:264 | documents/game/implementation/renderer.md | — | — |
| T-213 | 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:92 | documents/game/implementation/savepoint.md | — | — |
| T-214 | 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:21 | documents/game/implementation/savepoint.md | — | — |
| T-215 | 存档解析结果不是数组时静默保持空列表、不报错，表现为该地图没有存点 | 缺陷 | game | 待修 | apps/game/src/savepoint.ts:57 | documents/game/implementation/savepoint.md | 判据：喂入非数组存档 ⇒ 有错误信号，而非静默保持空列表（表现为「该地图没有存点」） | — |
| T-216 | `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:112 | documents/game/implementation/savepoint.md | — | — |
| T-217 | `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方） | 缺陷 | game | 待修 | apps/game/crates/wasm/src/lib.rs:480 | documents/game/implementation/wasm-crate.md | 判据：@BT@BspProcessor@BT@ 上 @BT@#[wasm_bindgen]@BT@ 只出现一次且归属正确（不再悬空在注释块上方） | — |
| T-218 | `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl` | 缺陷 | game | 待裁决 | apps/game/crates/wasm/src/lib.rs:117 | documents/game/implementation/wasm-crate.md | — | — |
| T-219 | `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组 | 文档口径 | game | 待修 | apps/game/src/worker/worker-types.ts:110 | documents/game/implementation/worker.md | 判据：文档中 @BT@SceneDataMessage@BT@ 归到「主线程 loadScene 形参」处，不再列在「Worker → 主线程」分组 | — |
| T-220 | `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加 | 缺陷 | game | 待裁决 | apps/game/src/worker/main.ts:513 | documents/game/implementation/worker.md | — | — |
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
| T-302 | 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`） | 缺陷 | debug | 待裁决 | apps/debug/src/physics/param-defs.ts:47 | documents/debug/implementation/physics.md | — | — |
| T-303 | 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1 | 缺陷 | debug | 待裁决 | apps/debug/src/renderer/lod-manager.ts:262 | documents/debug/implementation/renderer.md | — | — |
| T-304 | tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:708 | documents/debug/implementation/renderer.md | 判据：@BT@readPublishedTau()@BT@ 返回 0 时不再回落墙钟 ⇒ tick 线与另一条线时间同源可比 | — |
| T-305 | 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:712 | documents/debug/implementation/renderer.md | 判据：residual 传真实位置差 ⇒ 该组统计样本数 > 0（不再恒 0） | — |
| T-306 | lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform | 缺陷 | debug | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1549 | documents/debug/implementation/renderer.md | — | — |
| T-307 | `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2 | 缺陷 | debug | 待修 | apps/debug/scripts/frame-bench.mjs:37 | documents/debug/implementation/scripts.md | 判据：不传第 4 参跑 @BT@frame-bench.mjs@BT@ ⇒ 不再打印「地图不存在」并 exit 2（缺省路径可用或改为必填报错） | — |
| T-308 | 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套 | 工具·流程 | debug | 待裁决 | apps/debug/dev.cmd:17 | documents/debug/implementation/scripts.md | — | — |
| T-309 | 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24） | 缺陷 | debug | 待裁决 | apps/debug/src/wasm.d.ts:34 | documents/debug/implementation/wasm-bindings.md | — | — |
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
| T-407 | `world/types.ts` 的 `rootNode` 字段 | 未接线·死代码 | shared | 待修 | apps/game/crates/wasm/src/lib.rs:1706 | documents/ts-shared/overview.md | 判据：`git grep -n "world/types.ts" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-408 | `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de… | 未接线·死代码 | shared | 待修 | src/wasm-core/bsp_to_gltf_core/convert.rs:367 | documents/wasm-core/overview.md | 判据：`git grep -n "bsp_to_gltf_core/convert.rs" -- src apps` 只剩定义处（无调用点）⇒ 删除；删后体检 exit 0 且涉及工程 `npm run typecheck` 通过 | — |
| T-409 | `check-glb-parity.mjs` 门禁零接线（未进 package.json / CI，谁都不跑它） | 配置·门禁 | 共享 | 待修 | src/scripts/check-glb-parity.mjs:2 | documents/norms/scripts-and-ci.md | 判据：@BT@git grep -l "check-glb-parity" -- **/package.json .github@BT@ ⇒ 至少 1 个文件命中（已接线） | #409 |
| T-410 | surf_boreas 的 patch 材质 include 前缀被叠加两次（本地又补 materials/ 而未剥 include 自带前缀）⇒ 21 个材质解析失败、539/1716 世界图元无贴图 | 缺陷 | shared | 已结案 | src/wasm-core/bsp_to_gltf_core/materials.rs:448 | 本行即全部 | 判据：修前/修后同测 @BT@node .tmp/mapsurvey/probe2.mjs test/maps/surf_boreas.bsp@BT@ ⇒ missing 21 → 0；@BT@node .tmp/mapsurvey/probe2.mjs test/maps/surf_666.bsp@BT@ ⇒ 46 不变（证明只减不增）；@BT@git grep -n "trim_start_matches(\"materials/\")" -- src/wasm-core/bsp_to_gltf_core/materials.rs@BT@ ⇒ 1 命中。探针与原始输出在 .tmp/mapsurvey/（gitignored） | — |
| T-411 | Water 材质无 $basetexture 时被画成不透明纯白（缺上游的 Water 特判）⇒ surf_boreas 320/1716 世界图元（18.6%）水面观感错误 | 缺陷 | shared | 已结案 | src/wasm-core/bsp_to_gltf_core/materials.rs:475 | 本行即全部 | 判据：@BT@node .tmp/mapsurvey/probe10.mjs test/maps/surf_boreas.bsp@BT@ ⇒ water_pure_beneath 与 water01_* 两个材质由 alphaMode OPAQUE / [1,1,1,1] 变为 BLEND / [0.3216,0.7059,0.851,0.502]（=[82,180,217,128]/255）；不回归 @BT@node .tmp/mapsurvey/probe2.mjs test/maps/surf_boreas.bsp@BT@ ⇒ missing 0、@BT@...surf_666.bsp@BT@ ⇒ 46。探针与原始输出在 .tmp/mapsurvey/（gitignored） | — |
| T-412 | 地图渲染端没有天空盒背景（SKY 面被 is_visible 过滤、LightManager 只设纯色）⇒ 抬头只见纯深色；新增 2D cubemap 天空盒（skyname → 6 面 VTF → CubeTexture） | 缺陷 | shared | 已结案 | src/renderer-shared/environment/skybox.ts:1 | 本行即全部 | 判据：@BT@node .tmp/mapsurvey/verify-skybox.mjs test/maps/surf_boreas.bsp@BT@ ⇒ faces=6 且全为合法 PNG；运行时 CDP 取 background 为 @BT@CubeTexture imgs=6@BT@（修前为 Color）；@BT@npm run typecheck@BT@（apps/debug）exit 0。探针与截图见 .tmp/mapsurvey/（gitignored） | — |
| T-413 | 地图雾（env_fog_controller）未施加（renderer-main 明说不设 scene.fog）⇒ 远景无空气衰减 | 缺陷 | shared | 已结案 | src/renderer-shared/environment/fog-controller.ts:1 | 本行即全部 | 判据：@BT@node .tmp/mapsurvey/verify-fog.mjs test/maps/surf_boreas.bsp@BT@ ⇒ color=0xe8fffe / start=500 / end=43420，且合成用例 on / off / end<start 正确；运行时 CDP ⇒ scene.fog = Fog(500,43420,0xe8fffe)，@BT@setFogEnabled(false)@BT@ ⇒ null、再开 ⇒ 恢复；@BT@npm run typecheck@BT@ exit 0。探针与截图见 .tmp/mapsurvey/ | — |
| T-414 | 动态道具（prop_dynamic / prop_dynamic_override）不进 GLB：模型枚举只收 static_props 引用、且装配点 entities 恒空 | 缺陷 | shared | 已结案 | src/wasm-core/model_integrator/mod.rs:1352 | 本行即全部 | 判据：@BT@node .tmp/mapsurvey/prop-node.mjs test/maps/surf_boreas.bsp buk01@BT@ ⇒ nodes 1513→1514、命中 @BT@buk01.mdl@BT@；@BT@node .tmp/mapsurvey/prop-node.mjs test/maps/surf_666.bsp zzz@BT@ ⇒ 516/484（原 515/483，+1 = @BT@cow.mdl@BT@）；@BT@node .tmp/mapsurvey/mdl-entities.mjs <map>@BT@ ⇒ boreas 1(prop_dynamic) / 666 1(prop_dynamic_override)。探针与改动说明见 .tmp/mapsurvey/ | — |
| T-415 | 【W7 核查】3D 天空盒（sky_camera 缩放区）在 surf_boreas 无几何可渲染：sky_camera three=(1840,-16064,-6208) 在世界包围盒 y≥-14783 之外 1281 HU，且 3000 HU 内 0 个网格中心 ⇒ 无需行动（2D 天空盒已由 T-412 覆盖） | 缺陷 | shared | 已结案 | progress/monthly/2026-10-5.md:17 | 本行即全部 | 判据：@BT@sky_camera@BT@ 存在且实测「3000 HU 内 0 网格中心 + 包围盒外 1281 HU」；对照 surf_null / surf_666 无 sky_camera、surf_concretejungle_fix 的相机在包围盒内（几何与地图原点混同 ⇒ 无法区分）。其它图若要 3D 天空盒需另立启发式切分任务 | — |
| T-416 | 【W2b/game】game 工程无天空盒（`scene.background` 恒为纯色 0x222222）：game wasm 未导出 parse_entities / read_pakfile_file / decode_vtf_to_png ⇒ 无法复用 renderer-shared 的 skybox 逻辑 | 缺陷 | shared | 已结案 | apps/game/src/app.ts:514 | 本行即全部 | 判据：@BT@node .tmp/mapsurvey/verify-game-skybox.mjs test/maps/surf_boreas.bsp@BT@ ⇒ faces=6 且 slots=px,nx,py,ny,pz,nz；@BT@cd apps/game && npm run typecheck@BT@ exit 0；@BT@cd apps/game && npm run build:wasm@BT@ exit 0（新导出已现于 pkg d.ts）。viewer 侧（W2c）待做 | — |
| T-417 | 【W2c】viewer 工程无天空盒：背景恒为纯色，且 viewer 的 wasm 未导出 parse_entities / read_pakfile_file / decode_vtf_to_png | 缺陷 | viewer | 已结案 | apps/viewer/src/core/bsp.ts:131 | 本行即全部 | 判据：① viewer pkg 的 d.ts 出现三导出；② @BT@node .tmp/mapsurvey/verify-viewer-skybox.mjs test/maps/surf_boreas.bsp@BT@ ⇒ faces=6 且槽序 px,nx,py,ny,pz,nz；③ @BT@cd apps/viewer && npm run typecheck@BT@ exit 0。做法可直接照 T-416（EOF 独立 impl 块保锚点） | — |
| T-418 | 【W9·补强】`collect_missing_textures` 只报 VMT 解析 `Err`：「VMT 解析成功但 .vtf 不在包内」在 materials.rs 静默回退、不计缺失 ⇒ 缺失观测有盲区（详见任务书 W9） | 缺陷 | shared | 已结案 | src/wasm-core/mosaic/manifest.rs:49 | 本行即全部 | 判据：修后 @BT@collect_missing_textures@BT@ 把「basetexture 指向的 .vtf 不在 pakfile」也计入缺失；@BT@node .tmp/mapsurvey/probe2.mjs test/maps/surf_boreas.bsp@BT@ 缺失数 ≥ 修前且新增项可逐条回溯到具体材质；surf_666 不回归 | — |
| T-419 | 贴图仍取不到的 5 个材质（surf_boreas）：4 个 VTF 格式不受支持（Bgra4444 / Ia88）、1 个 VTF 未打包；另有 surf_666 的 pk02_floor10_a 被 texture_utils 解出而 GLB 路径（load_texture_bsp 走 vtf crate）取不到 ⇒ 两条 VTF 解码路径判定不一致 | 缺陷 | shared | 已结案 | src/wasm-core/texture_utils/image.rs:151 | progress/monthly/2026-10-5.md | 见详情 | — |
| T-420 | 【S1】天空盒六面槽位映射错误：up/dn 落在 ±X、四个侧面互串（`SUFFIX_SLOT` 写成 up→px…），且极面未按 GL 约定做面内旋转 ⇒ 天空被错误拼接 | 缺陷 | shared | 已结案 | src/renderer-shared/environment/skybox.ts:29 | 本行即全部 | 判据：① 轴约定读码确认（世界顶点 `map_coords`=[y,z,x]，渲染端清根旋转）⇒ 应为 ft→pz/bk→nz/lf→px/rt→nx/up→py/dn→ny；② `node .tmp/mapsurvey/seamtest.mjs` ⇒ 四侧面在 ft→lf→bk→rt 环序下平均缝差 0.82（错误环序 28~35）；③ `node .tmp/mapsurvey/polerot-verify.mjs` ⇒ up 转 90°CW、dn 转 90°CCW 后 0° 为最低分；④ debug `npm run typecheck`/`build:app` 通过，截图 .tmp/mapsurvey/cj-horizon.png、cj-up.png | — |
| T-421 | 【S2】Source 3D 天空盒（微缩景观）未实现：`sky_camera` 只被读作雾参数，微缩几何未按 scale 分离渲染 ⇒ 地图外景缺失 | 缺陷 | shared | 已结案 | src/renderer-shared/environment/miniature-sky.ts:1 | 判据：① `node .tmp/mapsurvey/mini-recon.mjs <map>` 证明夹具无可分离微缩区（boreas：相机在包围盒外 1281 HU、3000 HU 内 0 网格；concretejungle：2000 HU 内 26%、分布平滑）；② 隐藏地图后 A/B（`mini-ab.mjs ... 0 hidemap` + `mini-diff.mjs`）⇒ 差异 9.26%（分带 6~9 = 山脊）；③ 带地图、在 owner 指定视点（-12048,14736,12768）⇒ 0.17%（山脊从地形上方露一条带）。**实现**：`src/renderer-shared/environment/miniature-sky.ts` 合成三层山脊，挂场景根（`userData.isMiniatureSky`），随图释放；**限制**：该视点显著性不足，要更明显需调高度/距离或做第二相机视差 | 见详情 | — |
| T-422 | 【S3】surf_boreas 无雪盖：`worldspawn.skyname=tendies_sky`、雾色偏冬，但世界几何未体现雪覆盖 | 缺陷 | shared | 已结案 | src/renderer-shared/shader/world-transition.ts:1 | 本行即全部 | 判据：先取证——surf_boreas 世界材质里是否存在雪贴图/雪材质（雪盖在贴图还是几何层面）；再给出可见方案，且不影响非雪图 | — |
| T-423 | 【S4】surf_boreas 渲染整体偏暗：实测场景 1492 个 mesh 全为 MeshBasicMaterial，其中 **131 个无贴图**（water_pure_beneath 36 / water01 36 / alch_symbols 7 / tendies_endsmoke 6 / 无名 38）；日志 `[lightmap]` 显示 1976 个 mesh 无 lightmap 走 fullbright、960 个落「漏网兜底」 | 缺陷 | shared | 已结案 | src/renderer-shared/shader/lightmap-shader.ts:1789 | 本行即全部 | 判据：对照 owner 给的参考外观 —— ① 树/岩石不再纯黑（至少显示贴图原色或受光）；② 131 个无贴图 mesh 归零，或明确列入缺失观测（含 **prop 贴图**缺失，当前 `collect_missing_textures` 只覆盖世界面材质）；③ 同视点截图与参考图逐区对比 | — |
| T-424 | 【S2】3D 天空盒（Source 微缩景观）按正统做法接入：取 `sky_camera` 半径 `maxDim/scale` 内的微缩 mesh，复制后**绕 `sky_camera` 缩放** `scale` 倍（平移量 `CAM*(1-scale)`，锚点=相机本身；T-428 修正，锚点取世界原点会偏 21.6°~77.1°）；副本以 `renderOrder=-1` 当天空层 ⇒ 玩家视点处能看到地图自带的微缩外景 | 缺陷 | shared | 已结案 | src/renderer-shared/environment/miniature-sky.ts:1 | 本行即全部 | 判据：① owner 指认微缩区 (-3475,-11710,-3158)（实测该点 4000 HU 内有 101 个图元、距 `sky_camera` 7517）；② 站位 (-12048,14779.9,12768) 截图 ⇒ 背景出现灰色岩脊 + 雪斑 + 松树；③ A/B（`node .tmp/mapsurvey/mini-ab.mjs` 隐藏同名组）⇒ 隐藏后背景只剩纯色天空（`.tmp/mapsurvey/real-ab.png` vs `-nomini.png`）；④ debug `npm run typecheck`/`build:app` 通过。无 `sky_camera` 的图仍回退合成山脊（T-421） | — |
| T-425 | 【S5】道具/树木光照偏暗：树贴图 `Arbre01` 本身暗（2048²，均值 RGB≈[72,70,56]）；场景 1562 mesh 中仅 356 带 `_vbsp_vlight`（采样值 0.05~0.33 偏暗），747 个 `Arbre01` 树 mesh 抽样数个既无 `_vbsp_vlight` 也无 node extras 立方体 ⇒ 只能按贴图原色渲染成黑剪影 | 缺陷 | shared | 已结案 | src/renderer-shared/shader/lightmap-shader.ts:1500 | 本行即全部 | 判据：先分类统计 props 三类（有 vhv / 只有 cube / 两者都无）各多少，并让「两者都无」的那类有可见兜底；再在同视点与 owner 参考图对比，树/岩石不再是纯黑 | — |
| T-426 | 【S6】prop 光照数据：场景 1562 mesh 中 982 个既无 vhv 也探不到 cube ⇒ 走 fullbright；能探到的 cube 仅 ~0.08、vhv 0.05~0.33 ⇒ 整体偏暗。我们的 `StaticPropLump`（V6/V10/V11）**未读 `m_AmbientCube[6]`** —— 那是 Source 给静态道具的作者烘光 | 缺陷 | shared | 已结案 | src/renderer-shared/shader/lightmap-shader.ts:1516 | 本行即全部 | 判据：先加临时导出验证 sprp 记录布局（boreas 的 sprp 在压缩 lump 内、raw 读取无效）确认记录里是否含 6×RGBExp32；据此让 prop 用作者烘光，再在同视点与 owner 参考图对比树/岩石不再是黑剪影 | — |
| T-427 | 【S7·雪盖】地图的雪在 `WorldVertexTransition` 的**第二贴图**里：`materials/surf_lt_alpine/alpine_blendrocksnow.vmt` 的 `$basetexture2 = surf_lt_alpine/alpine_snow01`；而本仓**全链路都没有 `$basetexture2` / `WorldVertexTransition`**（Rust + TS 搜不到）⇒ 混合地形只画岩石那一半，雪永远不出现。混合系数在 `dface.lightmap_alpha_start` 指向的 **lightmap-alpha 数据**里：该字段我们解析进 `Face` 却**从未读取对应 lump** | 缺陷 | shared | 已结案 | src/renderer-shared/shader/world-transition.ts:1 | 本行即全部 | 判据：① 读 lightmap-alpha lump 并逐 face 取到混合 alpha（探针能打印非零占比）；② 材质带第二贴图并在渲染端按该 alpha 混合（自定义 shader，glTF 核心表达不了）；③ 同视点截图地面出现雪色，与 owner 参考图的雪线一致 | — |
| T-428 | 【S8】3D 天空盒外景**锚点错**：T-424 按「把 `sky_camera` 点搬到世界原点」放置（锚点=原点），而起源引擎是把天空相机放到 `CAM + (player-CAM)/scale` 再渲染微缩几何 —— 两者对同一微缩点的**方向**实测差 **21.6°~77.1°**，外景整体错位（owner 目视发现「偏了」）。已改为**绕 `sky_camera` 缩放**（平移量 `CAM*(1-scale)`），与引擎方向夹角 **0.00°** | 缺陷 | shared | 已结案 | 见 T-430 | 本行即全部；本行的静态缩放近似已被 T-430 的第二相机两遍法删除（其相机公式推导有误，见 T-430） | 判据：① 数值——引擎相机公式 vs 本实现，对 3 个采样微缩点的方向夹角 = 0.00°（锚点取原点时 21.6°~77.1°）；② 目视——同视点 yaw240 远处山脊落在与主图一致的地平高度（`.tmp/mapsurvey/anchor-yaw240.png`）；③ debug `npm run typecheck` + `build:app` 通过 | — |
| T-429 | 【S9】3D 天空盒外景**被切掉大半**：`buildMiniatureOutside` 原先只取「距 `sky_camera` 半径 `maxDim/scale` 内」的 mesh，实测只拿到 **102/361** 个图元（微缩区与地图本体之间的空腔之外还有一整圈）⇒ 前面/左边的山整块丢失（owner 目视发现「少了一块」）。改为**种子 + 包围盒间距扩张**（gap=256）取完整簇 | 缺陷 | shared | 已结案 | 见 T-430 | 本行即全部；取全簇结论仍成立（与 cluster 判据同批 361 个图元），实现已并入 T-430 的 meshInCluster | 判据：① 数值——簇扩张取到 361 个图元（原半径法 102），包围盒 32512×8106×31592；② 目视——同视点三个朝向外景齐全（`.tmp/mapsurvey/full-yaw0/120/240.png`）；③ `npm run typecheck`/`build:app` 通过 | — |
| T-430 | 【S10】3D 天空盒改用起源正统的**第二相机**两遍法：天空相机 = `sky_camera` 原点 + 主相机位置 / scale，天空区图元摘到独立层，清深度后主相机再画主世界；并纠正 T-415「无几何可渲染」与 T-428「锚点=相机」两条已结案结论 | 缺陷 | shared | 已结案 | src/renderer-shared/environment/miniature-sky.ts:177 | 见 progress/monthly/2026-10-6.md:9、:10 | 见详情 | — |
| T-431 | 【S11】地图上的「黑带」：lightmap 图集的**空纹素**（每面 1 px 边距 + 打包未用空间）是 `(0,0,0,0)`，解码成纯黑，而面边缘的取样会踩进去 ⇒ 每个面的边界上画出一条黑带（owner 目视报「这些地图纹理有问题 有莫名其妙的黑带」）。改为落位填像素后做**膨胀**填满空纹素 | 缺陷 | shared | 已结案 | src/wasm-core/bsp_to_gltf_core/lightmap.rs:545 | 见 progress/monthly/2026-10-6.md:11、:12；根因由 T-432 定位（位移面 UV 必须是细分网格，不是投影） | 见详情 | — |
| T-432 | 【S11·根因】位移面的 lightmap UV **不能用投影**：起源 SDK 要求位移面按**细分网格**插值——四角 luxel 坐标恒为 `(0.5,0.5)…(U+0.5,V+0.5)`（`builddisp.cpp` 的 `CalcLuxelCoords` / `CalcDispSurfCoords`），归一化后就是**单位方格** `u=j/2^power`、`v=i/2^power`。我们此前把（已被位移推走的）顶点投影到 lightmap 轴 ⇒ 漂出本面矩形，采到相邻面的光照贴图（owner 说的「混进其他光照贴图」）或图集空白（黑带） | 缺陷 | shared | 已结案 | src/wasm-core/vbsp/handle/mod.rs:391 | 见 progress/monthly/2026-10-6.md:13、:14 | 判据：@BT@node .tmp/mapsurvey/uvrect.mjs test/maps/surf_boreas.bsp .tmp/mapsurvey/pre-surf_boreas-atlas.png@BT@ ⇒ 逐面 uv 盒落在自己矩形内 **1351/1351、越界 0**（改前 **931/1351 = 68.9%**，最大越界 49 纹素、39 个整块落到图集外）；8 张图同法全部 0 越界 | — |
| T-433 | 【S12·残留黑块的真实层级】owner 参考截图里的黑块 / 紫斑**全部**来自 prop 的逐顶点预烘焙光照路径（几何属性 `_VBSP_VLIGHT`，源文件是 pakfile 的 `sp_<i>.vhv`）：关闭该路径后同一视点纯黑像素 **4.94% → 0.00%**、均值 63.9 → 70.6。解析侧已逐字段对齐 SDK——`vradstaticprops.cpp:1563-1593` 写 `flags=4` / `vertexSize=4` 且顶点为 **B,G,R,A** 顺序，`gamebspfile.h:206-225` 的 `StaticPropLump_t` **没有** ambient cube 字段，与本仓 72 B 记录逐字段吻合；prop→文件的 checksum 校验 **1503 匹配 / 0 不符**。但**数据本身极暗**：1587 个 prop 全图最大字节仅 ~95/255、prop 均值亮度中位数 6.8/255、298 个 prop 全 0。VRAD 侧 `m_Color = direct + indirect`（`vradstaticprops.cpp:1427`）与世界面同一物理量 ⇒「world 亮、prop 近黑」是数据 + 兜底口径问题，**不是**解析错 | 缺陷 | shared | 待裁决 | src/wasm-core/vhv.rs:90 | progress/pending-detail.md | 口径见 OWNER.md **D-016** | — |
| T-434 | 【S13】碰撞与材质透明度**无关**：`export_model_tri_colliders` 逐 mesh 用 `alpha_mode == 1`（`$translucent`）**剔除**该 mesh 的碰撞三角形 ⇒ 半透明/透明道具整件没有碰撞（实测 `surf_666` 的 `kr_windows` / `details69_window01m`、`surf_sedona` 的 16 个含 `surf_sedona_ramp03` 与 `naz_curve*`：在 `.phy` 输出里存在、在可视输出里被整件剔掉）。另 `world-builder` 的 `auto` 只在**整表为空**时回退可视网格 ⇒ `.phy` 缺失的个别模型静默无碰撞（`surf_666` 5 个、`ze_cursed_bear` 3 个 TRI-ONLY 模型） | 缺陷 | shared | 已结案 | src/ts-shared/phys/world-builder.ts:196 | 本行即全部 | 见详情 | — |
| T-435 | 【S14·洋红/方向】owner 指出「洋红是**魔法元素自带光源**，要考虑它的方向，例如 13539,1284,9884 中央大坑四周的石头模型」。**已定位光源**：`LUMP_WORLDLIGHTS` 第 #352 条 = Source `[13332,628,12251]`、强度 `[690.1, 0.5, 1896.6]`（G≈0，纯洋红），距该视点 2465 HU；近处的 leaf ambient 实测**最亮面是 +Z（上）**（0.123 vs +Y 0.065）⇒ 方向光来自**正上方**。**已定位实现缺陷**：`src/wasm-core/model_integrator/mod.rs:1331` 的**位置**经 `map_coords` 转成 Y-up，而 `:1333` 的**法线**是 `vertex.normal.into()` **原样（Source Z-up）**；引擎口径见 `common_vertexlitgeneric_dx9.h` 的 `VertexShaderAmbientLight`（cube 槽 0/1=±X、2/3=±Y、4/5=±Z，按世界法线加权）。⇒ 渲染端 `vbspAmbCube` 的加权式虽与引擎同形，却因「法线未转、cube 亦未转」而**只对纯 yaw 旋转的道具偶然成立**；带 pitch/roll 的 prop（冲浪坡正是）方向会错 | 缺陷 | shared | 已结案 | src/wasm-core/model_integrator/mod.rs:1333 | progress/pending-detail.md | 见详情 | — |
| T-436 | 【S15·缺材质占位】声明**半透明**的材质在贴图整条拿不到时，此前占位色是 `[255,255,255,255]` ⇒ glTF 是 `alphaMode=BLEND` **且 alpha=1**，等于把 `$additive` 的烟/雾画成**不透明白幕**（owner 截图中央那块白墙：HUD 写 `project_tendies/tendies_endsmoke（半透明）`）。**实证**：pakfile 里有该 VMT（`$basetexture project_tendies/tendies_smoke` + `$translucent 1` + `$additive 1`），但那张 VTF **不在包内** ⇒ 走占位分支 | 缺陷 | shared | 已结案 | src/wasm-core/bsp_to_gltf_core/materials.rs:529 | progress/monthly/2026-10-6.md | 见详情 | — |
| T-437 | 【S14·光照乱序】`.vhv` 一个 strip group 一块、块内按该 strip group 的局部顶点序，我们当成模型顶点序用 ⇒ 逐顶点光照整体错位（`rock04_epic` 等实测） | 缺陷 | shared | 已结案 | src/wasm-core/vhv.rs:44 | progress/monthly/2026-10-6.md | 见详情 | — |
| T-438 | 【S14】`.vhv` 只含 direct+bounce、43.7% 顶点全 0；level 1 纯乘法无 cube ⇒ 纯黑；按暗占比退 cube | 缺陷 | shared | 已结案 | src/wasm-core/model_integrator/mod.rs:225 | progress/monthly/2026-10-6.md | 见详情 | — |
| T-439 | 【S14】`vbspLightFloor` 未接进 level 1（逐顶点道具）⇒ 光照下限旋钮对其静默无效；现补上并用于 `max(vlight, floor)`，floor=0 时行为不变 | 缺陷 | shared | 已结案 | src/renderer-shared/shader/lightmap-shader.ts:1342 | progress/monthly/2026-10-6.md | 见详情 | — |
| T-440 | 【S16·置换面碰撞】洞穴壁/地形是**置换面**（1351 张面 / 84,405 顶点），而笔刷碰撞只有 159 个凸包 ⇒ 置换面此前**完全没有碰撞**。新增 `export_displacement_colliders`（debug+game），复用渲染端 `triangulated_displaced_vertices` 输出三角形汤（132,480 三角形，Y-up 世界坐标） | 缺陷 | shared | 进行中 · dsh · 2026-10-08 | apps/debug/crates/wasm/src/lib.rs | progress/monthly/2026-10-6.md | 判据：@BT@node .tmp/mapsurvey/dispcoll.mjs@BT@ ⇒ 三角形数 = 132480、AABB 覆盖全图；接入 TS 后世界里三角形碰撞面数应 +132480 | — |
| T-503 | mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效 | 缺陷 | shared | 待修 | src/renderer-shared/scene/scene-optimizer.ts:258 | progress/open-issues/03-renderer-merge-normal-attribute.md | 判据：三应用合批生效（合批 Mesh 数 > 0，日志无「normal 属性不一致」失败） | 原 03 |
| T-504 | 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉 | 缺陷 | shared | 待裁决 | 见详情 | progress/open-issues/04-wasm-untextured-surface-color.md | — | 原 04 |
| T-506 | 站立时的真卡死不再被处理（修法 A 的既定代价，未构造场景验证后果） | 缺陷 | shared | 待裁决 | 见详情 | progress/open-issues/07-is-position-free-vs-trace.md | — | 原 07 §8.4-2 |
| T-507 | check_stuck 的修法 D / C 未实施 | 缺陷 | shared | 待裁决 | 见详情 | progress/open-issues/07-is-position-free-vs-trace.md | — | 原 07 §8.4-3 |
| T-601 | 注释瘦身 · 共享层：20 处超长注释 + 3 个超长文件头（含 lightmap-shader.ts / player.rs / vbsp / gltf_builder.rs / authority-calibrator.ts 等） | 文档口径 | shared | 待修 | src/renderer-shared/shader/lightmap-shader.ts:1582 | documents/architecture/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-602 | 注释瘦身 · debug：4 处超长注释 + 0 个超长文件头（debug 脚本与 app.ts / teleport-manager.ts / path-recorder.ts / crates/wasm 等） | 文档口径 | debug | 待修 | apps/debug/scripts/jump-apex-verify.mjs:1 | documents/debug/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-603 | 注释瘦身 · game：2 处超长注释 + 1 个超长文件头（worker/main.ts 与 crates/wasm/src/lib.rs 等） | 文档口径 | game | 待修 | apps/game/src/worker/main.ts:1 | documents/game/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-604 | 注释瘦身 · viewer：1 处超长注释 | 文档口径 | viewer | 待修 | apps/viewer/src/replay/demopanel.ts:1238 | documents/viewer/overview.md | 判据：`node src/scripts/check-doc-drift.mjs` 的 `[J]` 输出里不再有该区域的条目（in-file 注释块 ≤ 20 行、文件头 ≤ 60 行）；超长机理按 `AGENTS §3.1` 第 4 条移入 `documents/` 并留一句指针 | — |
| T-605 | 门禁自审 P1 全修：锚点指纹改按「目标:行号」存比、sync 点名重钉且留痕、控制层裸锚点纳入、CI 变更基线、@BT@[C]@BT@ 转硬门、覆盖率按相对路径、分卷前取许可 | 工具·流程 | 共享 | 已结案 | src/scripts/docflow.mjs:201 | progress/monthly/2026-10-5.md:9 | 判据：@BT@node src/scripts/docflow.mjs check --all@BT@ ⇒ exit 0 且无输出；@BT@node src/scripts/check-doc-drift.mjs@BT@ ⇒ A–O 全 0 | — |
| T-606 | 全历史脱敏重写（公开仓库不留本机路径）：filter-branch 索引过滤 417 提交 + 文档 73 处短 SHA 重映射 + 新增规范篇与体检 [P] + 强推 main/tag（owner：强推脱敏处理） | 工具·流程 | 共享 | 已结案 | src/scripts/check-doc-drift.mjs:442 | progress/monthly/2026-10-5.md:11 | 判据：@BT@node src/scripts/check-doc-drift.mjs@BT@ 的 @BT@[P]@BT@ 本机路径 = 0；且 main+tag 可达 blob 全扫 0 命中 | — |
