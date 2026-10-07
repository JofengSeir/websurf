# 待办看板（TODO Board）

> **唯一事实来源**：所有待裁决 / 待修 / 已取证待立项 / 进行中事项的**状态只在本页登记**。
> 其余文档只写技术事实，不复述状态；代码注释只允许写「见 TODO.md T-###」。
> 规则：一行一条；ID 永不复用；结案保留 ID；**改代码或裁决的同一提交必须更新对应行**。
> 台账号（原 AGENTS §7.3 的「N 条」聚合行）在底层条目细化后**保留原行**、置 `已记录` 并在事项前标「【台账号·已细化】」，只作编号追溯，不再承载状态；未完全细化者保留原状态并标注已细化部分。

## 状态口径

| 状态 | 含义 |
|---|---|
| 待裁决 | 修法有分歧，或改动会动到行为契约，需要 owner 定 |
| 待修 | 修法明确、改动局部，可直接排期 |
| 已取证待立项 | 根因清楚但工作量超出一次改动，需要单独任务书 |
| 进行中 | 已开工，尚未收口 |
| 已记录 | 已知事实 / 工具边界，无需行动，仅备查 |
| 已结案 | 已按结论改完，或已判定无需行动 |

## 未结项（130 条）

### 待裁决（88）

- **T-003** 旧 AGENTS.md 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）未在本文件复述 —— 重编期间以任务书为准　`docs`
- **T-005** apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html…　`game`
- **T-007** apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into…　`debug`
- **T-008** apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new …　`game`
- **T-013** lightmap.rs 错误串含外部实现引用 Lightmap.cs:64　`shared`
- **T-015** vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤）　`shared`
- **T-016** compute-mode.ts 的 summary 字面量含已删文档编号　`shared`
- **T-018** tick-authority.test.ts 断言标签含 Q1 / §8.5　`shared`
- **T-020** 旧文档篇数口径对撞（68 篇 vs 实测 56 篇）　`docs`
- **T-021** game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略）　`game`
- **T-023** check-wasm-api.mjs 输出标签 F4 无出处　`game`
- **T-024** game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等）　`game`
- **T-029** debug 脚本 10 条（jump-apex 采样链链路级仍待裁决　`debug`
- **T-031** game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB）　`game`
- **T-032** game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等）　`game`
- **T-033** 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等）　`repo`
- **T-035** input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i…　`debug`
- **T-036** WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等）　`repo`
- **T-038** 9 个 .cmd 的 5 条遗留（viewer start.cmd 守卫与 dist/play.cmd 等）　`repo`
- **T-039** 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep…　`repo`
- **T-046** debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份…　`debug`
- **T-047** game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap…　`debug`
- **T-048** worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea…　`debug`
- **T-053** viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/…　`viewer`
- **T-054** debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g…　`debug`
- **T-055** game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（…　`game`
- **T-056** 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局…　`game`
- **T-058** DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30　`viewer`
- **T-060** .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01　`viewer`
- **T-062** 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径…　`viewer`
- **T-064** 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d…　`docs`
- **T-066** .phy 凸包表达不了曲面坡（progress/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实…　`shared`
- **T-067** 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner …　`shared`
- **T-068** AGENTS.md 是全仓最大的文本文件，本轮起已超过 234 KB（301 行、最长单行 4031 字符 —— §7.1 的进度行本身…　`docs`
- **T-101** 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错）　`viewer`
- **T-103** ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动）　`viewer`
- **T-106** numField 把空串当合法 0 写入变换　`viewer`
- **T-107** 分块选块包围盒只统计部分 Mesh，块边长由子集推出　`shared`
- **T-110** 包内 svc_CreateStringTable 只稳定解出第一张表　`viewer`
- **T-111** svc_CreateStringTable 的压缩标志未实现　`viewer`
- **T-112** svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过　`viewer`
- **T-113** svc_GameEvent 只按长度跳过，事件描述符表未保存　`viewer`
- **T-114** 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems）　`viewer`
- **T-116** 注入期 throw 不在本工程调用方 catch 覆盖范围内　`shared`
- **T-117** broken 阶段对照靠失配字面量维持，three 升级需同步　`shared`
- **T-119** 时间轴两条 title 文案与默认播放窗口矛盾　`viewer`
- **T-124** Track.offset 只有下界没有上界，可拉长主时钟总长　`viewer`
- **T-125** 零帧轨道的口径不一致（列表面板有卡片、3D 无对象）　`viewer`
- **T-128** dist 里的示例记录无法由当前源码路径重新产出　`viewer`
- **T-131** 冒烟三条静态断言只对 single 产物成立　`viewer`
- **T-134** build.cmd 无法产出 multi 产物　`viewer`
- **T-137** 端口占用分支假定占用者服务的是 dist　`viewer`
- **T-139** 导航缺「卸载地图」入口，载入过地图后回不到空态　`viewer`
- **T-140** 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复　`viewer`
- **T-142** 信息条重找跟随轨道，与 TrackSet.follow 策略重复　`viewer`
- **T-143** el() 属性写入限制了 id 型契约（undefined 静默无 id）　`viewer`
- **T-145** 模型名匹配与材质查找的大小写口径不一致　`viewer`
- **T-147** 材质去重键是材质名，同名材质被后续模型复用　`viewer`
- **T-148** packed_files 构造期缓存而 num_static_props 每次现算　`viewer`
- **T-149** map_name 两端都拿不到值，字段保留但无内容　`viewer`
- **T-150** Cargo.toml 说明把已不在工作区的 test 列为同款 patch 持有方　`viewer`
- **T-151** BspMetadata 与 TS 契约靠约定对齐，无编译期校验　`viewer`
- **T-152** Worker 没有心跳，请求侧无法区分「在解析」与「已失联」　`viewer`
- **T-153** WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker）　`viewer`
- **T-201** 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色　`game`
- **T-203** 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈　`game`
- **T-204** `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指）　`game`
- **T-206** `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃　`game`
- **T-209** M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发　`game`
- **T-210** 分块 cell 尺寸只在单材质分支累计包围盒，仅有多材质网格时并集为空、整个分块直接返回　`shared`
- **T-211** `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造　`game`
- **T-212** `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图　`game`
- **T-213** 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错　`game`
- **T-214** 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态　`game`
- **T-216** `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长　`game`
- **T-218** `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl`　`game`
- **T-220** `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加　`game`
- **T-222** 20 个脚本里仅 7 个设退出码，其余 13 个结论只在 stdout 末行、接入 CI 时判定不带出　`game`
- **T-223** single 产物引用了不在保留名单里的 `coi-serviceworker.js`、dist 同目录无该文件　`game`
- **T-302** 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`）　`debug`
- **T-303** 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1　`debug`
- **T-306** lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform　`debug`
- **T-308** 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套　`debug`
- **T-309** 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24）　`debug`
- **T-310** `set-auto-restore-hull` 只改面板侧标记，`src/phys/**` 无对应参数与读取点，开关不写物理实例　`debug`
- **T-504** 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉　`shared`
- **T-506** 站立时的真卡死不再被处理（修法 A 的既定代价，未构造场景验证后果）　`shared`
- **T-507** check_stuck 的修法 D / C 未实施　`shared`

### 待修（40）

- **T-040** debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g…　`debug`
- **T-065** check_stuck 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死　`shared`
- **T-102** 贴合检查提示串的 bbox 只取第一条越界轨道　`viewer`
- **T-104** 构造期 setLightGamma(2.2) 落在着色器接受窗口外被忽略　`viewer`
- **T-105** ensureWasm 把首次失败永久缓存，一次瞬时失败后本会话不自愈　`viewer`
- **T-108** 回退脚本加载无超时且成功路径不移除 script 标签　`viewer`
- **T-118** A-B 区间带恒不显示（宽度算式分子恒等于分母）　`viewer`
- **T-120** 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏　`viewer`
- **T-121** disposeTree 不释放轨迹线（Line）与 tick 点（Points）　`viewer`
- **T-122** createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL　`viewer`
- **T-123** 导入无超时与取消，Worker 不回消息时 Promise 永不结算　`viewer`
- **T-126** panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU　`viewer`
- **T-127** 真实夹具路径跨三处失效（指向 test/maps 而非 test/replay）　`viewer`
- **T-129** 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080　`viewer`
- **T-130** 冒烟按键断言（6 键）与当前 UI 八键不一致　`viewer`
- **T-132** WS_PATH 兜底是本机绝对路径，换机器不可用　`viewer`
- **T-133** .gitignore 中间产物目录与 test:replay 实际输出不一致　`viewer`
- **T-135** start.cmd 的 python 守卫让 dist/play.cmd 的 Node 兜底不可达　`viewer`
- **T-136** single 分支四段日志都写 [5/5] 步骤编号　`viewer`
- **T-138** 光照模式下拉只写不回填，与运行期真实模式脱节　`viewer`
- **T-141** setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError　`viewer`
- **T-144** .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节　`viewer`
- **T-146** 锁中毒会 panic，与本文件其它失败形态不一致　`viewer`
- **T-154** clipToPayload 没有显式返回类型，字段写错的报错落在调用点　`viewer`
- **T-155** req.rule 缺少防御，缺字段时抛 TypeError 并被 catch 成 error　`viewer`
- **T-202** 可选 DOM 依赖（`#loadMapBtn`/`#bspFile`/`#respawnBtn`/`#spawnSelect`）缺失时静默降级、无报错无提示　`game`
- **T-205** `lockTickRate` 的 64 在 `syncFullConfig`、面板构造与 `DEFAULT_CONFIG` 三处硬编码、需同步修改　`game`
- **T-207** `requestLock` 的 `p instanceof Promise` 判门在当前签名下恒真、失败提示恒挂 promise 回调　`game`
- **T-208** `bindSlider`／`bindCheckbox` 取不到元素时静默返回，控件缺失不报错　`game`
- **T-215** 存档解析结果不是数组时静默保持空列表、不报错，表现为该地图没有存点　`game`
- **T-217** `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方）　`game`
- **T-219** `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组　`game`
- **T-224** `build-dist.mjs` 两条路径都打印同一组 `[5/5]` 前缀、与步骤序号无关　`game`
- **T-301** 回放捕获 `replayCapture.record` 未传 `dtS`，样本 `dt` 恒 0；`InputFrame` 亦无 `dt` 字段　`debug`
- **T-304** tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源　`debug`
- **T-305** 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0　`debug`
- **T-307** `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2　`debug`
- **T-311** `custom-teleports` 的 localStorage 写入失败被静默忽略，调用方拿不到失败信号　`debug`
- **T-401** mosaic/decode.rs 的 code_to_img 不校验宽高下界、也不校验解码索引落在调色板色数内　`shared`
- **T-503** mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效　`shared`

### 已取证待立项（2）

- **T-109** 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正　`viewer`
- **T-115** untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查　`viewer`

> 另有 已记录 21 条、已结案 15 条见下表（保留 ID 供追溯，编号不复用）。

## 总表（166 条）

| ID | 事项 | 类型 | 归属 | 状态 | 证据 | 详情 | 原号 |
|---|---|---|---|---|---|---|---|
| T-001 | 根 README 已删除，仓库暂无 README | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | #1 |
| T-002 | 导航 index 已删除 | 文档口径 | docs | 已结案 | — | progress/pending-detail.md | #2 |
| T-003 | 旧 AGENTS.md 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）未在本文件复述 —— 重编期间以任务书为准 | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #3 |
| T-004 | CI 与共享脚本仍引用已退役的 harness | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | #4 |
| T-005 | apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #5 |
| T-006 | 零分配支路已实现但未接线：tick_into / state_out_ptr / seed_from 只被 src/ts-shared/… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #7 |
| T-007 | apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into… | 缺陷 | debug | 待裁决 | apps/debug/src/wasm.d.ts:67-119 | progress/pending-detail.md | #8 |
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | 配置·门禁 | game | 待裁决 | apps/game/scripts/check-wasm-api.mjs:52-70 | progress/pending-detail.md | #9 |
| T-009 | set_yaw_pitch 在 apps/ 与 src/ 内零调用点 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #10 |
| T-010 | teleport_gate_ticks 参数链已死：set_params 的 JSON 键可写、player.rs 有该字段（默认 3）… | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #11 |
| T-011 | BSP 导出未把 KHR_texture_transform 登记进 extensionsUsed | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | #26 |
| T-012 | vtf.rs 4 条读写不一致 + 5 处死代码 | 未接线·死代码 | shared | 已记录 | — | progress/pending-detail.md | #27 |
| T-013 | lightmap.rs 错误串含外部实现引用 Lightmap.cs:64 | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #28 |
| T-014 | mosaic/mtz.rs 8 条编解码不一致 | 缺陷 | shared | 已记录 | — | progress/pending-detail.md | #30 |
| T-015 | vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤） | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #31 |
| T-016 | compute-mode.ts 的 summary 字面量含已删文档编号 | 文档口径 | shared | 待裁决 | — | progress/pending-detail.md | #36 |
| T-017 | jump-apex-verify.mjs 内嵌「修复前行为」复刻 | 配置·门禁 | debug | 已记录 | — | progress/pending-detail.md | #38 |
| T-018 | tick-authority.test.ts 断言标签含 Q1 / §8.5 | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #40 |
| T-019 | owner 指令：子代理并发 ≤3（含 19 并发被掐断的复盘） | 工具·流程 | repo | 已记录 | — | progress/pending-detail.md | #41 |
| T-020 | 旧文档篇数口径对撞（68 篇 vs 实测 56 篇） | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #43 |
| T-021 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #50 |
| T-022 | 规范篇里的禁用词是「引用对象」（全仓唯一允许出现处） | 文档口径 | docs | 已记录 | — | progress/pending-detail.md | #51 |
| T-023 | check-wasm-api.mjs 输出标签 F4 无出处 | 配置·门禁 | game | 待裁决 | — | progress/pending-detail.md | #52 |
| T-024 | game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #53 |
| T-025 | 【台账号·已细化】→ T-119 viewer timeline.ts 的 title 文案与 prerun 负段口径矛盾 | 文档口径 | viewer | 已记录 | — | progress/pending-detail.md | #54 |
| T-026 | 【台账号·已细化】→ T-118、T-120 viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度） | 未接线·死代码 | viewer | 已记录 | — | progress/pending-detail.md | #55 |
| T-027 | 【台账号·已细化】→ T-104..T-108、T-138..T-143 viewer core + ui 9 条（含 ensureWasm 永久缓存失败） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | #58 |
| T-028 | 【台账号·已细化】→ T-121..T-123 viewer replay/ 10 条（含 GPU 资源不释放、blob URL 泄漏） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | #59 |
| T-029 | debug 脚本 10 条（jump-apex 采样链链路级仍待裁决 | 配置·门禁 | debug | 待裁决 | — | progress/pending-detail.md | #60 |
| T-030 | 【台账号·已细化】→ T-144..T-151 viewer crates/wasm 6 条（.MDL 三件套替换隐患等） | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | #61 |
| T-031 | game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB） | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #62 |
| T-032 | game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等） | 配置·门禁 | game | 待裁决 | — | progress/pending-detail.md | #63 |
| T-033 | 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等） | 缺陷 | repo | 待裁决 | — | progress/pending-detail.md | #64 |
| T-034 | 范围盘点（coverage-scan）+ 配置面口径冲突（已结案）：件数实测更正为 9 Cargo.toml / 5 .gitignor… | 配置·门禁 | repo | 已结案 | — | progress/pending-detail.md | #65 |
| T-035 | input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i… | 缺陷 | debug | 待裁决 | — | progress/pending-detail.md | #66 |
| T-036 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等） | 未接线·死代码 | repo | 待裁决 | — | progress/pending-detail.md | #67 |
| T-037 | WG12 src/ 侧 10 条（check-shared-sync 门禁恒失败已于本轮处置：退役路径出清单后四项子检查全过 | 配置·门禁 | shared | 已结案 | — | progress/pending-detail.md | #68 |
| T-038 | 9 个 .cmd 的 5 条遗留（viewer start.cmd 守卫与 dist/play.cmd 等） | 配置·门禁 | repo | 待裁决 | — | progress/pending-detail.md | #69 |
| T-039 | 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep… | 配置·门禁 | repo | 待裁决 | — | progress/pending-detail.md | #70 |
| T-040 | debug renderer-main.ts optimizeScene 调用链注释「其又源自 harness worker-b」与 g… | 缺陷 | debug | 待修 | — | progress/pending-detail.md | #71 |
| T-041 | debug 输入录制/回放面板整组控件不存在 | 配置·门禁 | debug | 已结案 | — | progress/pending-detail.md | #72 |
| T-042 | debug 路径可见开关不存在 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | #73 |
| T-043 | debug PVS 开关双断 | 缺陷 | debug | 已结案 | — | progress/pending-detail.md | #74 |
| T-044 | debug 四个配置字段纯死 | 未接线·死代码 | debug | 已结案 | — | progress/pending-detail.md | #75 |
| T-045 | game pitchLimit 死字段 | 未接线·死代码 | game | 已结案 | — | progress/pending-detail.md | #76 |
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | 未接线·死代码 | debug | 待裁决 | — | progress/pending-detail.md | #78 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | 未接线·死代码 | debug | 待裁决 | apps/game/src/app.ts:170 | progress/pending-detail.md | #79 |
| T-048 | worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea… | 文档口径 | debug | 待裁决 | — | progress/pending-detail.md | #80 |
| T-049 | v5 面板绑定审计：命中全为间接下发（非缺陷）：apps/game/src/panel/panel-controller.ts 有 11… | 工具·流程 | game | 已记录 | apps/game/src/app.ts:193-197 | progress/pending-detail.md | #82 |
| T-050 | v4 审计工具边界（留档）：.tmp/audit/page-chain-audit4.mjs 会误报两类 —— ① 动态生成的 clas… | 工具·流程 | game | 已记录 | — | progress/pending-detail.md | #81 |
| T-051 | 审计脚本的口径边界（留档）：.tmp/audit/page-chain-audit3.mjs 的 id 提取不覆盖 qs<T>('x')… | 工具·流程 | repo | 已记录 | apps/viewer/src/app.ts:71 | progress/pending-detail.md | #77 |
| T-052 | viewer 三条 P0 接线缺陷（① 拖拽 .dem ② 遥测 HUD 常隐 ③ 记录 tab 回位）—— ①②③ 均已在后续轮处置 | 缺陷 | viewer | 已结案 | apps/viewer/src/ui/telemetry.ts:102 | progress/pending-detail.md | #83 |
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:110 | progress/pending-detail.md | #84 |
| T-054 | debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g… | 缺陷 | debug | 待裁决 | apps/debug/src/app.ts:1992 | progress/pending-detail.md | #85 |
| T-055 | game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #86 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 缺陷 | game | 待裁决 | — | progress/pending-detail.md | #87 |
| T-057 | viewer 录像（.dem）按键可视化（Key Overlay）—— 拟以「反推」实现，本轮只登记不动手（owner 提出，2026-… | 未接线·死代码 | viewer | 已记录 | — | progress/pending-detail.md | #88 |
| T-058 | DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30 | 未接线·死代码 | viewer | 待裁决 | — | progress/pending-detail.md | #89 |
| T-059 | 录像「对话」只能显示服务端文本，玩家聊天看不到（本轮新增分节的边界，2026-09-30）：已在录像 tab 加第三节「对话」并接上 c… | 缺陷 | viewer | 已记录 | — | progress/pending-detail.md | #90 |
| T-060 | .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01 | 缺陷 | viewer | 待裁决 | — | progress/pending-detail.md | #91 |
| T-061 | 真实 .dem 夹具首扫（test/replay/auto-20261001-050330-surf_gigapede.dem，11.8… | 工具·流程 | viewer | 已记录 | — | progress/pending-detail.md | #92 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | 未接线·死代码 | viewer | 待裁决 | apps/viewer/src/replay/panel.ts:283 | progress/pending-detail.md | #93 |
| T-063 | .dem 实体流：只有 1 个玩家实体采到位姿 | 缺陷 | viewer | 已结案 | — | progress/pending-detail.md | #94 |
| T-064 | 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d… | 文档口径 | docs | 待裁决 | apps/debug/src/worker/main.ts:483 | progress/pending-detail.md | #95 |
| T-065 | check_stuck 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死 | 缺陷 | shared | 待修 | — | progress/open-issues/07-is-position-free-vs-trace.md | #96 |
| T-066 | .phy 凸包表达不了曲面坡（progress/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实… | 缺陷 | shared | 待裁决 | — | progress/open-issues/06-phy-hull-facet-jump.md | #97 |
| T-067 | 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner … | 缺陷 | shared | 待裁决 | — | progress/pending-detail.md | #98 |
| T-068 | AGENTS.md 是全仓最大的文本文件，本轮起已超过 234 KB（301 行、最长单行 4031 字符 —— §7.1 的进度行本身… | 文档口径 | docs | 待裁决 | — | progress/pending-detail.md | #99 |
| T-101 | 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:210 | documents/viewer/implementation/app.md | — |
| T-102 | 贴合检查提示串的 bbox 只取第一条越界轨道 | 缺陷 | viewer | 待修 | apps/viewer/src/app.ts:267 | documents/viewer/implementation/app.md | — |
| T-103 | ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动） | 缺陷 | viewer | 待裁决 | apps/viewer/src/app.ts:807 | documents/viewer/implementation/app.md | — |
| T-104 | 构造期 setLightGamma(2.2) 落在着色器接受窗口外被忽略 | 缺陷 | viewer | 待修 | apps/viewer/src/core/scene.ts:65 | documents/viewer/implementation/core.md | — |
| T-105 | ensureWasm 把首次失败永久缓存，一次瞬时失败后本会话不自愈 | 缺陷 | viewer | 待修 | apps/viewer/src/core/bsp.ts:82 | documents/viewer/implementation/core.md | — |
| T-106 | numField 把空串当合法 0 写入变换 | 缺陷 | viewer | 待裁决 | apps/viewer/src/core/dom.ts:107 | documents/viewer/implementation/core.md | — |
| T-107 | 分块选块包围盒只统计部分 Mesh，块边长由子集推出 | 缺陷 | shared | 待裁决 | src/renderer-shared/scene/scene-optimizer.ts:250 | documents/viewer/implementation/core.md | — |
| T-108 | 回退脚本加载无超时且成功路径不移除 script 标签 | 缺陷 | viewer | 待修 | apps/viewer/src/core/bsp.ts:59 | documents/viewer/implementation/core.md | — |
| T-109 | 实体流的「条数」与「记录边界」尚未定死，untilEnd 口径不能直接转正 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/net.ts:325 | documents/viewer/implementation/dem.md | — |
| T-110 | 包内 svc_CreateStringTable 只稳定解出第一张表 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:693 | documents/viewer/implementation/dem.md | — |
| T-111 | svc_CreateStringTable 的压缩标志未实现 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:709 | documents/viewer/implementation/dem.md | — |
| T-112 | svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:730 | documents/viewer/implementation/dem.md | — |
| T-113 | svc_GameEvent 只按长度跳过，事件描述符表未保存 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:563 | documents/viewer/implementation/dem.md | — |
| T-114 | 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems） | 未接线·死代码 | viewer | 待裁决 | apps/viewer/src/replay/demo/net.ts:269 | documents/viewer/implementation/dem.md | — |
| T-115 | untilEnd 口径性能：真录像前 4 MB 约 75 秒，瓶颈待查 | 缺陷 | viewer | 已取证待立项 | apps/viewer/src/replay/demo/demo.ts:866 | documents/viewer/implementation/dem.md | — |
| T-116 | 注入期 throw 不在本工程调用方 catch 覆盖范围内 | 缺陷 | shared | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1114 | documents/viewer/implementation/renderer.md | — |
| T-117 | broken 阶段对照靠失配字面量维持，three 升级需同步 | 工具·流程 | shared | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:351 | documents/viewer/implementation/renderer.md | — |
| T-118 | A-B 区间带恒不显示（宽度算式分子恒等于分母） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:525 | documents/viewer/implementation/replay.md | — |
| T-119 | 时间轴两条 title 文案与默认播放窗口矛盾 | 文档口径 | viewer | 待裁决 | apps/viewer/src/replay/timeline.ts:108 | documents/viewer/implementation/replay.md | — |
| T-120 | 正式跑段高亮宽度混基，Track.offset 非 0 时位置与宽度偏 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/timeline.ts:551 | documents/viewer/implementation/replay.md | — |
| T-121 | disposeTree 不释放轨迹线（Line）与 tick 点（Points） | 缺陷 | viewer | 待修 | apps/viewer/src/replay/visuals.ts:168 | documents/viewer/implementation/replay.md | — |
| T-122 | createObjectURL 未配对 revokeObjectURL，重起 Worker 泄漏 blob URL | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:101 | documents/viewer/implementation/replay.md | — |
| T-123 | 导入无超时与取消，Worker 不回消息时 Promise 永不结算 | 缺陷 | viewer | 待修 | apps/viewer/src/replay/importer.ts:137 | documents/viewer/implementation/replay.md | — |
| T-124 | Track.offset 只有下界没有上界，可拉长主时钟总长 | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/trackpanel.ts:204 | documents/viewer/implementation/replay.md | — |
| T-125 | 零帧轨道的口径不一致（列表面板有卡片、3D 无对象） | 缺陷 | viewer | 待裁决 | apps/viewer/src/replay/visuals.ts:96 | documents/viewer/implementation/replay.md | — |
| T-126 | panel.ts 平移输入框 hint 写「默认 0」而 step 为 10 HU | 文档口径 | viewer | 待修 | apps/viewer/src/replay/panel.ts:154 | documents/viewer/implementation/replay.md | — |
| T-127 | 真实夹具路径跨三处失效（指向 test/maps 而非 test/replay） | 缺陷 | viewer | 待修 | apps/viewer/test/replay-selftest.ts:75 | documents/viewer/implementation/scripts-and-test.md | — |
| T-128 | dist 里的示例记录无法由当前源码路径重新产出 | 缺陷 | viewer | 待裁决 | apps/viewer/scripts/build-dist.mjs:238 | documents/viewer/implementation/scripts-and-test.md | — |
| T-129 | 冒烟缺省 SMOKE_URL 指向另一工程的 dev 端口 8080 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:32 | documents/viewer/implementation/scripts-and-test.md | — |
| T-130 | 冒烟按键断言（6 键）与当前 UI 八键不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:415 | documents/viewer/implementation/scripts-and-test.md | — |
| T-131 | 冒烟三条静态断言只对 single 产物成立 | 配置·门禁 | viewer | 待裁决 | apps/viewer/test/smoke-cdp.mjs:138 | documents/viewer/implementation/scripts-and-test.md | — |
| T-132 | WS_PATH 兜底是本机绝对路径，换机器不可用 | 配置·门禁 | viewer | 待修 | apps/viewer/test/smoke-cdp.mjs:45 | documents/viewer/implementation/scripts-and-test.md | — |
| T-133 | .gitignore 中间产物目录与 test:replay 实际输出不一致 | 配置·门禁 | viewer | 待修 | apps/viewer/package.json:10 | documents/viewer/implementation/scripts-and-test.md | — |
| T-134 | build.cmd 无法产出 multi 产物 | 工具·流程 | viewer | 待裁决 | apps/viewer/build.cmd:8 | documents/viewer/implementation/scripts-and-test.md | — |
| T-135 | start.cmd 的 python 守卫让 dist/play.cmd 的 Node 兜底不可达 | 缺陷 | viewer | 待修 | apps/viewer/start.cmd:11 | documents/viewer/implementation/scripts-and-test.md | — |
| T-136 | single 分支四段日志都写 [5/5] 步骤编号 | 工具·流程 | viewer | 待修 | apps/viewer/scripts/build-dist.mjs:315 | documents/viewer/implementation/scripts-and-test.md | — |
| T-137 | 端口占用分支假定占用者服务的是 dist | 缺陷 | viewer | 待裁决 | apps/viewer/start.cmd:26 | documents/viewer/implementation/scripts-and-test.md | — |
| T-138 | 光照模式下拉只写不回填，与运行期真实模式脱节 | 缺陷 | viewer | 待修 | apps/viewer/src/ui/mapinfo.ts:98 | documents/viewer/implementation/ui.md | — |
| T-139 | 导航缺「卸载地图」入口，载入过地图后回不到空态 | 缺陷 | viewer | 待裁决 | apps/viewer/src/ui/mapinfo.ts:130 | documents/viewer/implementation/ui.md | — |
| T-140 | 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复 | 未接线·死代码 | viewer | 待裁决 | apps/viewer/src/ui/telemetry.ts:122 | documents/viewer/implementation/ui.md | — |
| T-141 | setTracks 把父元素强转为 HTMLElement，null 时抛 TypeError | 缺陷 | viewer | 待修 | apps/viewer/src/ui/telemetry.ts:110 | documents/viewer/implementation/ui.md | — |
| T-142 | 信息条重找跟随轨道，与 TrackSet.follow 策略重复 | 缺陷 | viewer | 待裁决 | apps/viewer/src/ui/replaymeta.ts:25 | documents/viewer/implementation/ui.md | — |
| T-143 | el() 属性写入限制了 id 型契约（undefined 静默无 id） | 缺陷 | viewer | 待裁决 | apps/viewer/src/core/dom.ts:39 | documents/viewer/implementation/ui.md | — |
| T-144 | .MDL 大小写让「三件齐」检查失效，vvd/vtx 槽位填进 .mdl 字节 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:119 | documents/viewer/implementation/wasm.md | — |
| T-145 | 模型名匹配与材质查找的大小写口径不一致 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:606 | documents/viewer/implementation/wasm.md | — |
| T-146 | 锁中毒会 panic，与本文件其它失败形态不一致 | 缺陷 | viewer | 待修 | apps/viewer/crates/wasm/src/lib.rs:429 | documents/viewer/implementation/wasm.md | — |
| T-147 | 材质去重键是材质名，同名材质被后续模型复用 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:216 | documents/viewer/implementation/wasm.md | — |
| T-148 | packed_files 构造期缓存而 num_static_props 每次现算 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:381 | documents/viewer/implementation/wasm.md | — |
| T-149 | map_name 两端都拿不到值，字段保留但无内容 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:389 | documents/viewer/implementation/wasm.md | — |
| T-150 | Cargo.toml 说明把已不在工作区的 test 列为同款 patch 持有方 | 配置·门禁 | viewer | 待裁决 | apps/viewer/Cargo.toml:11 | documents/viewer/implementation/wasm.md | — |
| T-151 | BspMetadata 与 TS 契约靠约定对齐，无编译期校验 | 缺陷 | viewer | 待裁决 | apps/viewer/crates/wasm/src/lib.rs:362 | documents/viewer/implementation/wasm.md | — |
| T-152 | Worker 没有心跳，请求侧无法区分「在解析」与「已失联」 | 缺陷 | viewer | 待裁决 | apps/viewer/src/worker/main.ts:91 | documents/viewer/implementation/worker.md | — |
| T-153 | WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker） | 缺陷 | viewer | 待裁决 | apps/viewer/src/worker/main.ts:33 | documents/viewer/implementation/worker.md | — |
| T-154 | clipToPayload 没有显式返回类型，字段写错的报错落在调用点 | 缺陷 | viewer | 待修 | apps/viewer/src/worker/main.ts:113 | documents/viewer/implementation/worker.md | — |
| T-155 | req.rule 缺少防御，缺字段时抛 TypeError 并被 catch 成 error | 缺陷 | viewer | 待修 | apps/viewer/src/worker/main.ts:82 | documents/viewer/implementation/worker.md | — |
| T-201 | 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:507 | documents/game/implementation/app-entry.md | — |
| T-202 | 可选 DOM 依赖（`#loadMapBtn`/`#bspFile`/`#respawnBtn`/`#spawnSelect`）缺失时静默降级、无报错无提示 | 缺陷 | game | 待修 | apps/game/src/app.ts:317 | documents/game/implementation/app-entry.md | — |
| T-203 | 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈 | 缺陷 | game | 待裁决 | apps/game/src/app.ts:249 | documents/game/implementation/app-entry.md | — |
| T-204 | `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指） | 缺陷 | game | 待裁决 | apps/game/src/input/input-bridge.ts:65 | documents/game/implementation/input.md | — |
| T-205 | `lockTickRate` 的 64 在 `syncFullConfig`、面板构造与 `DEFAULT_CONFIG` 三处硬编码、需同步修改 | 配置·门禁 | game | 待修 | apps/game/src/app.ts:640 | documents/game/implementation/config.md | — |
| T-206 | `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃 | 未接线·死代码 | game | 待裁决 | apps/game/src/input/input-bridge.ts:30 | documents/game/implementation/input.md | — |
| T-207 | `requestLock` 的 `p instanceof Promise` 判门在当前签名下恒真、失败提示恒挂 promise 回调 | 缺陷 | game | 待修 | apps/game/src/app.ts:253 | documents/game/implementation/input.md | — |
| T-208 | `bindSlider`／`bindCheckbox` 取不到元素时静默返回，控件缺失不报错 | 缺陷 | game | 待修 | apps/game/src/panel/panel-controller.ts:572 | documents/game/implementation/panel.md | — |
| T-209 | M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发 | 缺陷 | game | 待裁决 | apps/game/src/panel/panel-controller.ts:265 | documents/game/implementation/panel.md | — |
| T-210 | 分块 cell 尺寸只在单材质分支累计包围盒，仅有多材质网格时并集为空、整个分块直接返回 | 缺陷 | shared | 待裁决 | src/renderer-shared/scene/scene-optimizer.ts:250 | documents/game/implementation/renderer.md | — |
| T-211 | `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造 | 未接线·死代码 | game | 待裁决 | apps/game/src/renderer/renderer-main.ts:77 | documents/game/implementation/renderer.md | — |
| T-212 | `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图 | 缺陷 | game | 待裁决 | apps/game/src/renderer/renderer-main.ts:264 | documents/game/implementation/renderer.md | — |
| T-213 | 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:92 | documents/game/implementation/savepoint.md | — |
| T-214 | 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:21 | documents/game/implementation/savepoint.md | — |
| T-215 | 存档解析结果不是数组时静默保持空列表、不报错，表现为该地图没有存点 | 缺陷 | game | 待修 | apps/game/src/savepoint.ts:57 | documents/game/implementation/savepoint.md | — |
| T-216 | `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长 | 缺陷 | game | 待裁决 | apps/game/src/savepoint.ts:112 | documents/game/implementation/savepoint.md | — |
| T-217 | `BspProcessor` 上叠两个 `#[wasm_bindgen]` 属性（一处悬空在注释块上方） | 缺陷 | game | 待修 | apps/game/crates/wasm/src/lib.rs:480 | documents/game/implementation/wasm-crate.md | — |
| T-218 | `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl` | 缺陷 | game | 待裁决 | apps/game/crates/wasm/src/lib.rs:117 | documents/game/implementation/wasm-crate.md | — |
| T-219 | `SceneDataMessage` 是主线程 `loadScene` 形参、不是跨线程消息，却声明在「Worker → 主线程」分组 | 文档口径 | game | 待修 | apps/game/src/worker/worker-types.ts:110 | documents/game/implementation/worker.md | — |
| T-220 | `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加 | 缺陷 | game | 待裁决 | apps/game/src/worker/main.ts:513 | documents/game/implementation/worker.md | — |
| T-221 | `phys-p2-regression.mjs` 的 `ALL PASS` 分支在当前产物下不可达（本地脚本未入库） | 工具·流程 | game | 已记录 | — | documents/game/implementation/scripts.md | — |
| T-222 | 20 个脚本里仅 7 个设退出码，其余 13 个结论只在 stdout 末行、接入 CI 时判定不带出 | 配置·门禁 | game | 待裁决 | — | documents/game/implementation/scripts.md | — |
| T-223 | single 产物引用了不在保留名单里的 `coi-serviceworker.js`、dist 同目录无该文件 | 配置·门禁 | game | 待裁决 | apps/game/scripts/build-dist.mjs:60 | documents/game/implementation/scripts.md | — |
| T-224 | `build-dist.mjs` 两条路径都打印同一组 `[5/5]` 前缀、与步骤序号无关 | 工具·流程 | game | 待修 | apps/game/scripts/build-dist.mjs:90 | documents/game/implementation/scripts.md | — |
| T-301 | 回放捕获 `replayCapture.record` 未传 `dtS`，样本 `dt` 恒 0；`InputFrame` 亦无 `dt` 字段 | 缺陷 | debug | 待修 | apps/debug/src/app.ts:2241 | documents/debug/implementation/input.md | — |
| T-302 | 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`） | 缺陷 | debug | 待裁决 | apps/debug/src/physics/param-defs.ts:47 | documents/debug/implementation/physics.md | — |
| T-303 | 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1 | 缺陷 | debug | 待裁决 | apps/debug/src/renderer/lod-manager.ts:262 | documents/debug/implementation/renderer.md | — |
| T-304 | tick 线时间戳在 `readPublishedTau()` 返回 0 时回落墙钟 `now`，两条线时间基准不同源 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:650 | documents/debug/implementation/renderer.md | — |
| T-305 | 权威 post-tick 位置差（residual）固定传 `undefined`，该组统计样本数恒 0 | 缺陷 | debug | 待修 | apps/debug/src/renderer/renderer-main.ts:654 | documents/debug/implementation/renderer.md | — |
| T-306 | lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform | 缺陷 | debug | 待裁决 | src/renderer-shared/shader/lightmap-shader.ts:1549 | documents/debug/implementation/renderer.md | — |
| T-307 | `frame-bench.mjs` 缺省地图路径 `<仓库根>/maps/surf_666.bsp` 不在工作区，不传第 4 参即打印「地图不存在」并 exit 2 | 缺陷 | debug | 待修 | apps/debug/scripts/frame-bench.mjs:37 | documents/debug/implementation/scripts.md | — |
| T-308 | 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套 | 工具·流程 | debug | 待裁决 | apps/debug/dev.cmd:17 | documents/debug/implementation/scripts.md | — |
| T-309 | 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24） | 缺陷 | debug | 待裁决 | apps/debug/src/wasm.d.ts:34 | documents/debug/implementation/wasm-bindings.md | — |
| T-310 | `set-auto-restore-hull` 只改面板侧标记，`src/phys/**` 无对应参数与读取点，开关不写物理实例 | 未接线·死代码 | debug | 待裁决 | apps/debug/src/worker/worker-types.ts:146 | documents/debug/implementation/worker.md | — |
| T-311 | `custom-teleports` 的 localStorage 写入失败被静默忽略，调用方拿不到失败信号 | 缺陷 | debug | 待修 | apps/debug/src/world/custom-teleports.ts:66 | documents/debug/implementation/world.md | — |
| T-401 | mosaic/decode.rs 的 code_to_img 不校验宽高下界、也不校验解码索引落在调色板色数内 | 缺陷 | shared | 待修 | src/wasm-core/mosaic/decode.rs:146 | documents/materials/overview.md；documents/wasm-core/overview.md | — |
| T-501 | debug 的 chamfer 平面削减体积为零却决定地面法线 ⇒ 坡顶站不住 / 被弹飞 | 缺陷 | debug | 已结案 | — | progress/open-issues/01-chamfer-is-not-a-bevel.md | 原 01 |
| T-502 | chamfer 黄线框靠重新猜平面得到，与物理侧平面表不是同一套判据 | 缺陷 | debug | 已结案 | — | progress/open-issues/02-chamfer-visualization-guesswork.md | 原 02 |
| T-503 | mergeGeometries 因 normal 属性不一致失败，三应用合批静默失效 | 缺陷 | shared | 待修 | — | progress/open-issues/03-renderer-merge-normal-attribute.md | 原 03 |
| T-504 | 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉 | 缺陷 | shared | 待裁决 | — | progress/open-issues/04-wasm-untextured-surface-color.md | 原 04 |
| T-505 | src/wasm-core 侧 bevel / brushes 无消费者，注释却称导出层会用 | 文档口径 | shared | 已结案 | — | progress/open-issues/05-wasmcore-bevel-doc-vs-code.md | 原 05 |
| T-506 | 站立时的真卡死不再被处理（修法 A 的既定代价，未构造场景验证后果） | 缺陷 | shared | 待裁决 | — | progress/open-issues/07-is-position-free-vs-trace.md | 原 07 §8.4-2 |
| T-507 | check_stuck 的修法 D / C 未实施 | 缺陷 | shared | 待裁决 | — | progress/open-issues/07-is-position-free-vs-trace.md | 原 07 §8.4-3 |
