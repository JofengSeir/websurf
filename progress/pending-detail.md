# 待决与已知项明细（原 `AGENTS.md` §7.3）

> 来源：根 `AGENTS.md` §7.3 的编号行，**逐字搬运**（含原状态列）。本页为过程记录；**状态以 `TODO.md` 为准**。
> #94 在原表缺尾竖线、#88/#90 无状态列、#92 原状态列被内容里的裸竖线污染，均已按正文判定；编号沿用原台账号以便追溯。

## T-001（原 #1） — 已结案

~~根 README 已删除，仓库暂无 README~~ **已处置（2026-09-22）**：WG10 已重建 `README.md`；随后 owner 要求「根文档不齐全」⇒ 由 `.archive/` 合并重建四篇根文档（README / CHANGELOG / CONTRIBUTING / SECURITY），均已过漂移体检（锚点越界 0、路径失效 0）

原状态列：**已结案**

## T-002（原 #2） — 已结案

~~导航 index 已删除~~ **已处置**：`documents/index.md` 已由 WG10 按实际文件树重建（49 篇、51 条链接全可解析）

原状态列：**已结案**

## T-003（原 #3） — 待裁决

旧 `AGENTS.md` 的通用工程规范（文件归属 / 临时区 / 产物 / 文档格式）**未在本文件复述** —— 重编期间以任务书为准；是否重建由 owner 在 WG10 决定

原状态列：**待 owner 裁决**

## T-004（原 #4） — 已结案

~~CI 与共享脚本仍引用已退役的 harness~~ **已处置（owner 裁决「清掉这些残留引用」）**：**6 个文件**全部清完 —— `ci-gates.yml` 删 4 步并把 job 改名为 `debug-gates`（steps 35→31、YAML 实测可解析）、`deploy-pages.yml` 去掉不可复核的旧实测数字、`PULL_REQUEST_TEMPLATE.md` 范围/测试项改写、`apps/debug/scripts/jump-apex-verify.mjs` 改读**本工程** `apps/debug/pkg/`（该门由「必然 SKIP 空转」变为**实跑**：`npm run test:jump-apex` exit 0、198 行、`[SKIP]` 0 次、跑满 25 格）、`src/scripts/{check-doc-drift,check-shared-sync}.mjs` 去掉退役路径（后者门禁由**恒失败转为四项全过**）。**全仓复扫 321 个文件**后仅剩根 `.gitignore` 的 `test/game-core/` 规则（配置项而非注释，按「只改注释」口径**刻意保留**）

原状态列：**已结案**（本轮唯一的代码 / CI 改动，均经 owner 授权；逐件判据见台账两行）

## T-005（原 #5） — 待裁决

**apps/game 的 favicon.ico 被同一批删除波及**：该文件在库中唯一，而 `apps/game/web/index.html:22-23` 仍声明 `./favicon.ico` 与 `/favicon.ico` 两条链接（行号本轮实测复校）（同处注释承诺"两条路径都不 404"），现两条均落空

原状态列：**待 owner 裁决**是否恢复（与 harness 退役无逻辑关联，仅同批被删）

## T-006（原 #7） — 已记录

**零分配支路已实现但未接线**：`tick_into` / `state_out_ptr` / `seed_from` 只被 `src/ts-shared/` 的 `tick-authority.ts`、`decoupled-loop.ts` 调用，而这两个控制器在三个工程内均无装配点（`createTickAuthority` 仅被其单测调用）→ 线上路径实际走 `tick()` 返回对象

原状态列：已知，须在文档中如实写"已实现、未接线"，不得写成线上热路径

## T-007（原 #8） — 待裁决

`apps/debug/src/wasm.d.ts:67-119` 的 `PhysWorld` 类型落后源码 7 个方法（缺 `tick_into` / `state_out_ptr` / `set_state_ex` / `state_full_json` / `seed_from` / `gate_veto_count` / `debug_trace`），debug 侧只能运行时 cast（`renderer-main.ts:1268`、`:1285`）

原状态列：**待 owner 裁决**（改 .d.ts 属代码改动，未擅改）

## T-008（原 #9） — 待裁决

`apps/game/scripts/check-wasm-api.mjs:52-70` 的 `PHYS_API` 只列 **17 项**，缺 `new` / `state_full_json` / `set_state_ex` / `seed_from` / `gate_veto_count` / `debug_trace` → 对 24 个导出的契约覆盖不完整

原状态列：**待 owner 裁决**（门禁脚本改动，未擅改）

## T-009（原 #10） — 已记录

`set_yaw_pitch` 在 `apps/**` 与 `src/**` 内**零调用点**；`predict` 仅被 `apps/game/scripts` 两个脚本调用

原状态列：已知；注释已如实标注，是否保留导出由 owner 决定

## T-010（原 #11） — 已记录

`teleport_gate_ticks` 参数链已死：`set_params` 的 JSON 键可写、`player.rs` 有该字段（默认 3）、`step_core` 的传送检测调用点确实传入，但 `teleport.rs` 的 `check` 形参名为 `_gate_ticks` 且函数体从不读它

原状态列：已知；注释已标注"该键不改变行为"，是否删字段由 owner 决定

## T-011（原 #26） — 已记录

BSP 导出未把 `KHR_texture_transform` 登记进 `extensionsUsed`

原状态列：只记录不修

## T-012（原 #27） — 已记录

`vtf.rs` 4 条读写不一致 + 5 处死代码

原状态列：只记录不修

## T-013（原 #28） — 待裁决

`lightmap.rs` 错误串含外部实现引用 `Lightmap.cs:64`

原状态列：待裁决（改文案属代码）

## T-014（原 #30） — 已记录

`mosaic/mtz.rs` 8 条编解码不一致

原状态列：只记录不修

## T-015（原 #31） — 待裁决

`vbsp/data/entity.rs` 6 条（含 `start_disabled` 恒 false 的跨工程实锤）

原状态列：待裁决（第①条）

## T-016（原 #36） — 待裁决

`compute-mode.ts` 的 `summary` 字面量含已删文档编号

原状态列：待裁决（改字面量属代码）

## T-017（原 #38） — 已记录

`jump-apex-verify.mjs` 内嵌「修复前行为」复刻；`jump-apex-serve.mjs` 依赖两处代码文本切片锚点

原状态列：已知（切片锚点已实测未破坏）

## T-018（原 #40） — 待裁决

`tick-authority.test.ts` 断言标签含 `Q1` / `§8.5`

原状态列：待裁决（属代码）

## T-019（原 #41） — 已记录

owner 指令：子代理并发 ≤3（含 19 并发被掐断的复盘）

原状态列：已生效

## T-020（原 #43） — 待裁决

旧文档篇数口径对撞（68 篇 vs 实测 56 篇）

原状态列：待终审

## T-021（原 #50） — 待裁决

game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略）

原状态列：待裁决

## T-022（原 #51） — 已记录

规范篇里的禁用词是「引用对象」（全仓唯一允许出现处）

原状态列：已说明，非缺陷

## T-023（原 #52） — 待裁决

`check-wasm-api.mjs` 输出标签 `F4` 无出处

原状态列：待裁决

## T-024（原 #53） — 待裁决

game 类型面/配置面 3 条（`worker-types.ts` 落后实际载荷等）

原状态列：待裁决

## T-025（原 #54） — 待裁决

viewer `timeline.ts` 的 `title` 文案与 prerun 负段口径矛盾

原状态列：待裁决（属代码）

## T-026（原 #55） — 待裁决

viewer 死支路 4 条（A-B 区间带恒不显示 / 零调用点 / 混基宽度）

原状态列：待裁决

## T-027（原 #58） — 待裁决

viewer `core` + `ui` 9 条（含 `ensureWasm` 永久缓存失败）

原状态列：待裁决

## T-028（原 #59） — 待裁决

viewer `replay/` 10 条（含 GPU 资源不释放、blob URL 泄漏）

原状态列：待裁决

## T-029（原 #60） — 待裁决

debug 脚本 10 条（**jump-apex 采样链链路级**仍待裁决；其中「`test:jump-apex` 空转」**已于本轮处置**——该脚本改读本工程 `apps/debug/pkg/`，门由空转变实跑：exit 0 / 198 行 / 0 SKIP）

原状态列：待裁决（①属代码）

## T-030（原 #61） — 待裁决

viewer `crates/wasm` 6 条（`.MDL` 三件套替换隐患等）

原状态列：待裁决

## T-031（原 #62） — 待裁决

game `phys-rate-parity` 4 条（混合分区时长/结果、`flatTop` AABB）

原状态列：待裁决

## T-032（原 #63） — 待裁决

game 脚本 11 件 7 条（`_dbg_floor` 的 `onGround` 恒 undefined 等）

原状态列：待裁决（④属代码）

## T-033（原 #64） — 待裁决

WG6b 6 条（`test/maps/surf_null_4.replay` 跨 3 文件失效等）

原状态列：待裁决

## T-034（原 #65） — 已结案

范围盘点（coverage-scan）+ **配置面口径冲突（已结案）**：件数实测更正为 **9 `Cargo.toml` / 5 `.gitignore`**（含 `src/.gitignore`，此前记 4 个时漏了它）、`tsconfig.json` 3 个 0 注释＝无对象；配置面 14 件已按 owner 裁决纳入并完成（`config-proof` 全部「配置文本逐字符相同」，见台账）。另：根 `.gitignore` 的 `.ak/` 规则注释已改写为「当前工作区无该目录，规则保留作归档位」（原注释声称旧 md 已移入该目录，而该目录不存在）

原状态列：**已结案**

## T-035（原 #66） — 待裁决

`input-replay-verify.mjs` 5 条（`inputRecorder` 永不落样本、`f.dt` 字段不存在、页面缺 7 个 id 等）

原状态列：待裁决

## T-036（原 #67） — 待裁决

WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 `coi-serviceworker.js` 等）

原状态列：待裁决

## T-037（原 #68） — 已结案

WG12 `src/` 侧 10 条（`check-shared-sync` 门禁恒失败**已于本轮处置**：退役路径出清单后四项子检查全过；余 `bytes=text.length` 等 9 条仍待裁决）

原状态列：待裁决（①已结案）

## T-038（原 #69） — 待裁决

~~9 个 `.cmd` 5 条~~ **部分已消除（2026-09-24）**：三工程入口已统一改为 `dev.cmd` / `build.cmd` / `start.cmd`（旧的 `start-dev` / `play` / `build-dist` 九个文件删除）；`dev` / `build` 改为**无条件** `build:wasm` ⇒ 「门/消费方 wasm 路径错配」与「工具链守卫不全」两类已消除（见 `documents/debug/implementation/scripts.md` 已知缺口 8–10 与 `documents/viewer/implementation/scripts-and-test.md` 9/11）。**仍待裁决**：viewer `start.cmd` 的 python 守卫使 `dist/play.cmd` 的 Node 兜底不可达（viewer 已知缺口 10）、`build.cmd` single-only 与底层 `--multi` 不一致（viewer 已知缺口 8）、端口占用分支假定占用者服务的是 `dist/`（viewer 已知缺口 13）

原状态列：待裁决（3 条）

## T-039（原 #70） — 待裁决

**依赖表「本 crate 无引用点」清单**（两法一致：源码引用面扫描 + `cargo check` 的 `-W unused-crate-dependencies`）：debug `websurf-wasm` **26 项**、game **29 项**、viewer **1 项**（`gltf`）；另 `websurf-wasm-core` **3 项**、vendored `vmdl` **1 项**（`tracing`，上游 manifest 同样声明）。判读：**无引用点 ≠ 可删**（`getrandom` / `getrandom_03` / `path_dedot` 是 **feature 开关**），故未动任何配置行；如需瘦身建议**逐项删 + 每次跑 `cargo check` 与 `npm run build:wasm`** 验证

原状态列：待裁决（本轮只测不改）

## T-040（原 #71） — 待修

debug `renderer-main.ts` optimizeScene 调用链注释「其又源自 harness worker-b」与 game 侧同构注释措辞不一致（2026-09-23 验收审查新发现；字面判据 0 违规——未写完整工程名，完整记录见 2026-09-23 验收审查行——原台账已退役删除，git 历史 commit `6e0ecf6` 可查）

原状态列：待处理（1 行注释对齐，属注释重编范围）

## T-041（原 #72） — 已结案

~~debug 输入录制/回放面板整组控件不存在~~ **已处置（2026-09-26，owner 裁定删链）**：删除 `inputRecorder` 与七个 `#inputRec*` 句柄、`updateInputRecUi`、`startRecording` / `stopRecording`、`buildReplayMeta`、面板六个按钮监听、`__wsInput` 的 `start` / `stop` / `clear` / `isRecording` / `exportJson` / `status`（新增 `progress`），以及 `loadedSpawnList`。**回放能力保留**（`load` / `play` / `stopPlay` / `captureText` / `progress`）。debug typecheck exit 0；审计 A1 只剩 `clearTeleportsBtn`（动态生成，非缺陷）。**遗留**：`apps/debug/scripts/input-replay-verify.mjs` 依赖已删除 API ⇒ 脚本不可用（本就必然失败）

原状态列：**已结案**（附 1 项脚本遗留）

## T-042（原 #73） — 已结案

~~debug 路径可见开关不存在~~ **已处置（2026-09-26，删链）**：删除 `dom.pathVisibleChk` 绑定与其 change 监听、`RendererMain.setPathVisible`、`PathRecorder.setVisible`——页面无该 id，且四个分量开关（`index.html:410`、`:413`、`:417`、`:421`）已覆盖其语义。debug typecheck exit 0

原状态列：**已结案**

## T-043（原 #74） — 已结案

~~debug PVS 开关双断~~ **已处置（2026-09-26，删链）**：删除 `dom.pvsEnabledChk` 绑定 + 三处消费者（初始同步 / 场景就绪同步 / change 监听）+ `config.lod.pvsEnabled` 字段与其默认值；`syncFullConfig` 段清单收敛。剔除行为不变（只按距离判据）。debug typecheck exit 0；`documents/debug/implementation/{app,web}.md`、`documents/architecture/overview.md` 已同步

原状态列：**已结案**

## T-044（原 #75） — 已结案

~~debug 四个配置字段纯死~~ **已处置（2026-09-26，删字段）**：`physics.duckScale` 与三个整段 `MovementConfig` / `SmoothingConfig` / `TeleportConfig`（`speed` / `sprintMultiplier` / `triggerRadius` / `cooldownMs`）已从 `RuntimeConfig` 与 `DEFAULT_CONFIG` 移除，`syncFullConfig` 不再下发；传送判定仍用 `teleport-manager.ts` 的模块常量。debug typecheck exit 0

原状态列：**已结案**

## T-045（原 #76） — 已结案

~~game `pitchLimit` 死字段~~ **已处置（2026-09-26，删字段）**：已从 `InputConfig` 与 `DEFAULT_CONFIG` 移除（pitch 限幅由 Rust 承担）；`documents/game/implementation/{config,panel}.md` 已同步。game typecheck exit 0

原状态列：**已结案**

## T-046（原 #78） — 待裁决

**debug / game 的 `RendererMain.getLightingMode()` 零调用点**：debug 与 game 各有一份（转发给 `renderer/lightmap-shader.ts` 的 `getLightingMode`），`apps/<app>/src` + `src/ts-shared` + 工程 `scripts` 内均无调用者（同族的 `setLightingMode` 有调用）。属"有实现未接线"——保留还是删除未定

原状态列：待裁决

## T-047（原 #79） — 待裁决

**game `RendererMain.resetTo()` 与 `stop()` 零调用点**：`start()` 由 `apps/game/src/app.ts:170` 调用、`stop()` 无人调用 ⇒ rAF 循环启动后没有停止路径（换图走 `disposeScene`，循环照跑；页面卸载才自然结束）。对比 debug 的 `resetTo` 有 7 处调用（传送/重置/检查点回退）

原状态列：待裁决

## T-048（原 #80） — 待裁决

**worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）**：debug/game 的 `worker-types.ts` 里 `ready` / `bsp-metadata` / `stats` / `player-respawn` 等成员既无发送方也无接收方；分发层的 `set-mode` / `mode-ack` 在本仓无发送/接收点（harness 退役后）。明细见 `documents/debug/implementation/worker.md`、 `documents/game/implementation/worker.md`、 `documents/debug/sequences.md:127`、 `documents/game/sequences.md:99`

原状态列：待裁决（仅类型面，无运行时影响）

## T-049（原 #82） — 已记录

**v5 面板绑定审计：命中全为间接下发（非缺陷）**：`apps/game/src/panel/panel-controller.ts` 有 11 个绑定（`showCrosshair` / `chSize` / `chThickness` / `chGap` / `chOutline` / `chDot` / `fov` / `renderDistance` / `exposure` / `lightGamma` / `ambientScale`）的回调不含显式下发动词，但都走 `ch()` → `applyCrosshair` + `savePanelPrefs`，或 `this.onSyncXxx?.(v)`；五个 `onSync*` 钩子在 `apps/game/src/app.ts:193-197` 全部接到 `renderer.setFov` / `setRenderDistance` / `setExposure` / `setLightGamma` / `setAmbientScale` ⇒ 面板改动确实生效。**初筛正则（`.tmp/audit/page-chain-audit5.mjs`）认不出间接下发，判读必须追到被调函数**

原状态列：已知（工具边界，非缺陷）

## T-050（原 #81） — 已记录

**v4 审计工具边界（留档）**：`.tmp/audit/page-chain-audit4.mjs` 会误报两类 —— ① 动态生成的 class（game 的 `.key-chip` / `.key-add` 由 `renderKeyList` 的 innerHTML 产出，H 会判"页面不存在"）；② `worker-types.ts` 里的**联合类型声明**（`type: 'x'` 字面量不是发出点，E 会判"无处理分支"）。均需回源码确认

原状态列：已知（工具边界，非缺陷）

## T-051（原 #77） — 已记录

**审计脚本的口径边界（留档）**：`.tmp/audit/page-chain-audit3.mjs` 的 id 提取不覆盖 `qs<T>('x')` 泛型写法与事件委托 ⇒ viewer 的 `#guideBtn` / `#helpBtn` / `#sidebarToggle` 等被误报为死 id（实测均由 `qs<T>()` 正常取用，`apps/viewer/src/app.ts:71`、`:228`、`apps/viewer/src/ui/hud.ts:31`）；同类漏检方向也适用于 debug/game

原状态列：已知（工具边界，非缺陷）

## T-052（原 #83） — 已结案

**viewer 三条 P0 级接线缺陷（三子代理独立审查实锤 + 主控抽查确认，只记录待修）**：① 拖拽只认 .bsp / .replay（`apps/viewer/src/app.ts` 的 drop 处理），拖入 .dem 落到「不是 .bsp / .replay」报错，而 `#dropzone` 文案与引导卡第一步都承诺「.dem 导入录像」；② 遥测 HUD 永不显示——`#telemetry` 初始带 `hidden` 类（`apps/viewer/web/index.html:72`），`apps/viewer/src/ui/telemetry.ts:102` 的 setTracks 只切内层 span 的 hidden、根元素无人移除 ⇒ 速度读数 + 电平表整组常隐；③ 收起面板后点「记录」tab 的回位逻辑删错元素——`apps/viewer/src/app.ts:96` 应 `dockEl.classList.remove('full')` 却删 `timelineEl`，`#dock.full` 残留使 dock 与重新出现的侧栏在右下角重叠

原状态列：#83② 遥测 HUD 永隐已修（2026-09-30：setTracks 改切宿主自身）；#83①③ 已处置（2026-10-01：拖拽增加 .dem 分支转发 `DemoPanel.load`；记录页回位改删 `dockEl`）⇒ **已结案**

## T-053（原 #84） — 待裁决

**viewer P1×3 + P2 批（同轮审查登记）**：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（`apps/viewer/web/styles.css:555-578` 注释明言改色须同步帮助文本）；DemoPanel 包 sec 后 dmp 系 border-top + 纵向 padding 落进 sec-body 成双重间距；`#help` 有切角 + 滚动但无 scrollbar-gutter（滚动条右上角被切角裁掉）。P2——孤儿规则两族（.tl-pmark 系 7 条、.dmp-axis/.dmp-lane/.dmp-jsonlist/.dmp-events 等旧 lane 看板 12 条）+ .mono；.tl-marks 死链三件套（`apps/viewer/src/replay/timeline.ts:110` 建、CSS 无规则、`apps/viewer/src/replay/demopanel.ts` 的 `occupancyMarks` 无调用点、时间轴侧的 `setMarks` 从未实现）；更名残留（`apps/viewer/web/styles.css:172` 及 `:561`、`:562`、`:900` 与 `apps/viewer/src/app.ts:575`、`:615` 用户可见文案仍以 .replay 为「录像」）；令牌注释失真 3 处；头注「radius 一律 0」与三处 50% 失真、「两个 tabpane 编号」实为三个；.tl-slider 18px/20px 双高声明；键盘可达性（label.filebtn 均不可键盘触发、help-close 为 span）；VW-02/03 编号随滚动滚出视口；sidebarToggle 初始 active 缺同步；guide 注释首行重复；`web/coi-serviceworker.js` 为 viewer 死资产（全仓无引用）

原状态列：待 owner 裁决

## T-054（原 #85） — 待裁决

**debug 审查登记（P1×4 + P2×9）**：P1——全局 `:focus-visible` 与 `::selection` 规则整体缺失（game / viewer 均有，键盘走查只剩浏览器默认环）；禁用态仅 button 有 0.45、select / input 缺；`#error` 一旦显示永不清除（全仓无 setError('') 调用点），失败后再成功加载旧红字仍挂、#status 不同步。P2——select 箭头 data-URI 残留旧天青调色板 %238593a6（注释称 muted）；`apps/debug/src/app.ts:1992` 单位 span 硬编码 #6a6f8a（旧主题蓝灰）；SOURCE_LABEL 三色复制令牌值（宜用 var()）；#error 背景硬编码 err 的 RGB（宜提 --err-weak）；`web/styles.css` 为死文件（页面不 link、构建不含，与头注矛盾）；滚动条注释提「帧时间列表」与实际元素名不符；路径图例 tooltip 写三档着色实为两档（与 #71 同源）；#missingTexturesOk 死钩子；窄窗侧栏挤压属可接受

原状态列：待 owner 裁决

## T-055（原 #86） — 待裁决

**game 审查登记（P1×3 + P2×9）**：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（键盘用户无法切 pane / 删键，:focus-visible 对其永不触发）；checkbox / color 行引导线 left:176px / right:96px 未随 640px 媒体查询联动（窄屏两端脱节）；「权威健康」行 label + #health-count + button.small 三元素被 grid 自动放置挤成两行。P2——#crosshair:empty 孤儿规则；头注口径漂移（首条 bullet「螺丝（2 处）」应为一颗 + 服务孔一、「七 pane」实为八、「琥珀全屏 5 类」少计交互态）；令牌外硬编码 5 处（#eceee6 等）；#panel::before 切角边线窄窗脱离实际切角（注释已自认定宽）；#status 无 max-width 长文案换行会压住 #error；coi 首访 reload 撕一次初始化（模式固有代价，可接受）

原状态列：待 owner 裁决

## T-056（原 #87） — 待裁决

**多轮对话遗留待办合并（owner 逐轮提出、未裁决）**：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局时启用）；② 全屏场景可用 Keyboard Lock API（navigator.keyboard.lock）捕获 Ctrl+W 根治误关——需全屏前提，未实现；③ 三工程 dist 内部资产固定名，重部署 ≤10 min 旧资产窗口未消除（需资产指纹化，动三工程 build-dist）；④ game 导航服务孔是否随装饰螺丝一并撤除（owner 仅裁了螺丝）；⑤ tl-slider 撤外扩后 0% / 100% 端点可点范围缩回 thumb 半径（「两端易点中」诉求的回归，若要兼得需 zone 坐标系重构）；⑥ favicon.ico 缺失（§7.3 #5 既有，仍开放）

原状态列：待 owner 裁决

## T-057（原 #88） — 已记录

**viewer 录像（`.dem`）按键可视化（Key Overlay）—— 拟以「反推」实现，本轮只登记不动手**（owner 提出，2026-09-30）。**现状（已实测，三条锚点）**：① 类型留位而 `.dem` 未填——`Clip.buttons` 声明允许 null（`apps/viewer/src/replay/protocol.ts`），Shavit 记录侧**已解**（`shavit-replay.ts` 的 `buttons[i] = dv.getInt32(base + 20, true)`），而 `.dem` 侧**硬编码 `buttons: null`**（`democlip.ts` 的 `toClip`），于是 `app.ts` 帧循环里 `follow?.clip.buttons ?? null` 恒为 null ⇒ 遥测按键显示在录像模式下是死的；② 解析器**看得见 `dem_usercmd`（cmd 5）却只记载荷长度**做诊断（`demo/demo.ts` 的 `usercmdDiag`，注释自陈「用来判断按键信息是否存在」），从未解出按位；③ **本仓现有录像实测 `usercmdDiag.count = 0`**——`dem_usercmd` 只记录**录制者本人**的输入流，而该录像由**观察者机器人**录制 ⇒ 文件里本就没有按键数据，**即便实现了解码器此录像也全空**。**拟采用的路子（owner 给定方向）**：**不依赖原始 usercmd，改为按结果反推**——与主流比赛 HUD 的 Key Overlay 同法：由**速度矢量在视角左右方向的加速度**点亮 A / D、前后分量点 W / S、`FL_DUCKING` 标志点 CTRL、`weapon_fire` 事件或弹匣数减少点 MOUSE1；该法对**任何**玩家（含观察者录像里的第三人）都成立，恰好绕开「引擎只广播录制者输入」这一硬约束。**待定**：HUD 落位（画面角落 vs 遥测区）、是否同屏显示多人、反推置信度是否需要在 UI 上标注（避免与真实按键混淆）。**已于 2026-09-30 落地**（owner 追加指示）：新增 `apps/viewer/src/replay/keyguess.ts`（`guessKeys` 按位置差分投影到视角基、轴死区按当前速率的 45%、瞬移过滤 5000 u/s；`keyNames` 供 HUD 命名），`app.ts` 帧循环在 `clip.buttons` 为 null 时改喂反推值（`.replay` 仍用真实 `buttons`，两条路互不影响）。**判据落位取「画面角落 vs 遥测区」中的后者**——`telemetry.ts` 本就有一套完整的键簇 UI（`.tm-key` 八键），只是 `.dem` 路径从不供 `buttons` 才一直是死的，接线成本为零。**反推能力边界（模块内已写明）**：只得方向键与（不可靠的）跳跃，**得不出鼠标键**（不改变速度矢量）、**得不出 DUCK**（无该标志可用，DUCK 位恒不亮）。**实测**：五时间点三样同时亮（`sp="3195｜317" meter=12 keys="W"` 等，见 §7.1 本日两行） **已完成 → 已终裁收口（2026-10-01）**：owner 裁定「.dem 不做按键显示、宁缺勿猜」——keyguess.ts 整文件删除、帧循环只认 `clip.buttons` 真值，按键簇在 `.dem` 路径整组熄灭（反推路线废止，#91③ 的 dem_usercmd 解码随之无消费点）；`.replay` 真值路径不变

## T-058（原 #89） — 待裁决

**`DemoParseResult` 里「已解码但应用面为零」的字段清单**（owner 要求记录，2026-09-30；判据 = 在 `apps/viewer/src/app.ts` 与 `src/replay/demopanel.ts` 中 grep `\.<字段>` 命中 0 次，逐个实测）。**分三类，性质不同，处置口径也不同**：**㈠ 冗余（解了、但上层另有一套实现）**——`playerNames`（实体号→名字）：看板自己从 `userinfoTimeline` 解名（`demopanel.ts` 的 `nameAtSlot`），**同一份数据被解了两遍**，属重复而非单纯废弃；**㈡ 内部用过、结果对象上无人取**——`packetStringTables`（`svc_CreateStringTable` 收到的表）：它是解出 `userinfo` 的**必经中间产物**（表名→表号映射靠它），「没用」只对结果对象成立，**不可删**；**㈢ 诊断留档（存在目的就是排查，不算废弃但当前确实无消费者）**——`playerDiag`（玩家采样诊断，定位「为什么没有轨迹」）、`indexHistogram`（「类别 id:扁平下标」→ 引擎实际下发次数）、`playerSnapshots`（解析结束时各玩家属性快照）、`playerPropNames`（玩家类实体上解出的属性名）、`usercmdDiag`（`dem_usercmd` 载荷长度分布，见 #88③）、`legacyPropOrder`（属性位图极性标志）；**㈣ 计数类，无人读**——`entityCount`（解析结束时实体表内实体数）、`classCounts`（各服务器类别实体数）；**㈤ 文本消息**——`chatLines`（`svc_Print` / `svc_StringCmd` / `svc_Disconnect`，上限 4000 条，见 `demo/net.ts` 的 `CHAT_LINE_LIMIT`）：**UI 零消费者**，但注意 **㈢ 那批我在本会话早期排查「轨迹出不来」「`playerInfos` 只有 1 条」时很可能读过其输出**（那正是它们的目的），不可与 `chatLines` 混为一谈打包成「全是死数据」；**`chatLines` 的内容本会话一次都未引用**。**另有 2 个字段各只有 1 处引用、未逐个开箱确认是「真读」还是「顺手透传」**：`dataTables`、`stringTables`。**该字段集的来源锚点**：`apps/viewer/src/replay/demo/demo.ts` 的 `DemoParseResult` 接口（16 个字段，其中真正进入 UI 的仅 `header` / `players` / `playerInfos` / `stats` 四个）

原状态列：待 owner 裁决（是否清 ㈢㈣㈤ 与冗余地合并 `playerNames`）

## T-059（原 #90） — 已记录

**录像「对话」只能显示服务端文本，玩家聊天看不到（本轮新增分节的边界，2026-09-30）**：已在录像 tab 加第三节「对话」并接上 `chatLines`（即 #89 ㈤ 那批），但**本仓现有录像实测该字段长 0** —— 该录像里 `svc_Print` / `svc_StringCmd` / `svc_Disconnect` **一条都没有**（这三类正是 `chatLines` 的唯一来源）。**玩家聊天在 Source 里走的是另一条路**：`svc_UserMessage` 内嵌的 **`SayText2`**（usermessage 号 4），解析器**尚未解它**；本轮实测该录像的 `svc_UserMessage` 有 3664 条，即载荷是有的、缺的是解码。**⇒ 要让「对话」分节真正有内容，必须先解 `SayText2`**：需要按 `userinfo` 里的 **`userid` → 槽位/名字** 回查（`playerInfos` 已有 `slot` / `userId` / `name` 三列可对），并按 `chat` / `name` 两个索引取串。**当前分节的空态已如实写明这一点**（`demopanel.ts` 的 `renderChat`），不让看的人误以为「那局没人说话」。**未做**：SayText2 解码（属解析器改动，未擅动）。另：同轮 `chatLines` 已从「UI 零消费者」变为**有消费者**（§7.3 #89 的 ㈤ 判读据此更新，其余四类的判读不变） **已处置（2026-10-01）**：SayText2 解码已接（net.ts 新增 `decodeSayText2`，实测 40 条聊天可读），「对话」分节有内容 ⇒ **已结案**

## T-060（原 #91） — 待裁决

**`.dem` 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01；子代理独立评审 + 主控钉死关键锚点，本轮只记录不修）**。**裁决：双方各对一半**——keyguess.ts 头注对「观察者录像里没有第三方玩家的原始 W/A/S/D/JUMP 按位」成立；但「无法获取玩家输入」作为绝对命题过头，存在**两条未被利用的真实输入通道** + **一条对客户端录制录像的完整通道**：**① `m_fFlags`（公共网络属性，真值）**——SDK 2013 `player.cpp` 的 `DT_BasePlayer` 公共发送表里有 `SendPropInt(SENDINFO(m_fFlags), 0, SPROP_UNSIGNED|SPROP_CHANGES_OFTEN)`（8183 行，在 8168 行 `DT_BasePlayer` 块内、8199 行 `SendProxy_SendLocalDataTable` 之前，主控亲自钉死）；`FL_ONGROUND=1<<0`、`FL_DUCKING=1<<1`（`const.h`）⇒ 观察者录像里其他玩家的**下蹲状态与落地/离地沿**是文件里的真实数据；本解析器按发送表通用展平解码任意属性（`m_iHealth` 等已在采），m_fFlags 只需进 WATCH 列表即可——全仓 0 处引用它，纯属性没人去看；**② 游戏事件 `svc_GameEvent`（weapon_fire 等，真值）**——事件广播含 SourceTV；本解析器对 GameEventList 已解结构但丢弃描述符（`demo/net.ts`），补存「事件名→字段类型」即可解出 `weapon_fire.userid` ⇒ 鼠标开火真值（CS:S 专用解析器 demboyz 实证该路可行）；**③ `dem_usercmd` 解码（仅对玩家客户端本地 `record` 的录像）**——CUserCmd 位流为逐字段 presence-bit delta 编码（SDK `usercmd.cpp` 与 dem.nekz.me `/classes/usercmdinfo` 逐字段吻合），含真实 **Buttons(i32)**；解码器约 100–150 行、BitReader 现成、`scanMessages` 已能定位载荷——但**观察者录像此消息为 0 条**（#88③ 实测），需 owner 提供一份本人录制的 .dem 才值得做，且基线是否跨消息链式需对拍确认；**反面钉死**：`m_nButtons` 在 Source 1/CS:S **不是网络属性**（player.cpp 仅 datadesc `DEFINE_FIELD`、无任何 SendProp；`DT_LocalPlayerExclusive` 只发本机）⇒ CS:GO/CS2 那套「公共 m_nButtons 直接读所有玩家按键」在本工程不适用。**建议最小方案（子代理给出、按性价比）**：① m_fFlags → DUCK/ONGROUND（半天，顺带让 JUMP 用 ONGROUND 下降沿替代现有垂直速度边沿、更可靠）；② GameEventList → weapon_fire（1 天内）；③ dem_usercmd buttons 解码（视 owner 夹具而定）；④ keyguess 保留为 W/A/S/D 的观察者路径，头注措辞随实现更新。**遗留不可知项**：CS:S 实机 send table 的 m_fFlags 最终实证需任一真实 .dem 夹具（工作区现无）；dem_usercmd 基线链式行为需客户端录制夹具

原状态列：待 owner 裁决（①②属解析器改动，未擅动）

## T-061（原 #92） — 已记录

**真实 `.dem` 夹具首扫（`test/replay/auto-20261001-050330-surf_gigapede.dem`，11.8 MB，2026-10-01；自包含探针 `test/replay/dem-probe.html`——gitignore 区、镜像工程位流规范、纯浏览器运行，无 node/python 环境故走浏览器 + 本地 HttpListener）**。**容器层全量走读 59,951 包 / 392 ms / 中止仅 24（0.04%）**，实测事实：① `dem_usercmd`（cmd 5）**0 条**——该录像 clientName=`SourceTV Demo`（观察者录制），#88③/#91③ 的「观察者录像无原始输入」再获实锤；② 聊天**不在** `svc_Print`/`svc_StringCmd`（全录像 0 条）而在 `svc_UserMessage` **id 4（SayText2）39 条**，可打印样例含玩家名 `LuoXuan`、`[ Timer ]` 前缀 ⇒ #90 的「对话要解 SayText2」成立且内容确在文件里；另 id 28 ×1,790 条重复结构二进制载荷（疑似计时器/插件推送，需 mod 的 usermsg 表解码）；③ `userinfo` 签入期仅槽 0（录制机器人 `ERDY-SURF Recorder`/guid=BOT），但 `userinfo` 更新消息 **134 次**——名字靠更新条目并入（与工程现行为一致）；④ `svc_GameEvent` 232 条（事件真实存在），但 `svc_GameEventList` 描述符本轮未采到（signon 段在 2 个 `svc_CreateStringTable` 处仍有失步，待解）；⑤ **重大发现（工程解析器疑似缺陷）**：本录像 CS:S networkprotocol=24 的 `svc_PacketEntities` 之后**没有**显式删除表——实测 `demo/net.ts` 的 `decodePacketEntities` 末尾按 tf2-demo-parser 恢复的「isDelta 时逐条 1+11 位删除表」在本录像上是**净多读**：变体矩阵实测，读删除表 = 24,378 包中止 / 不读 = **24 包**中止（其余全同）——5 万余包在 PE 后紧跟字节对齐填充或下一条消息（如类型 32，疑 `svc_CmdKeyValues`，5,082 次高度一致）；该缺陷在旧夹具上被「残差 ±N 位」口径掩盖。**探针遗留**：signon 段 2 处失步（第 2 个 created table 名为乱码）、`svc_HLTV`(16) 按 0 跳过、类型 32 按 u32 位长跳过（两法同效）、`democmdinfo` 全 0（SourceTV 机位不落此字段）。**第二轮（同日，owner 要求「对话人名也要进玩家表」）**：给探针补 `userinfo` 更新条目解码——不猜条目框架，直接在更新载荷里做 **`BOT`/`STEAM_` 特征位扫描**（guid 在 `player_info_s` 偏移 36，回退 288 位取整条 132 字节记录，`net.ts` 诊断段同法），从 134 条更新解出 **12 个 Shavit 回放机器人名**（`主关卡 1:41.112

原状态列：unknown` 等，guid 全 BOT）；SayText2 全量捕获（40 条、带 tick、控制字节作边界按 **UTF-8** 解码——中文聊天与颜文字完整可读，`\x07`+6 字节为颜色码）；聊天文本回填真人身份 `LuoXuan <STEAM_0:1:98170324>`（Owner，IP 115.238.116.155，来自「connected from China」公告）⇒ 玩家表 14 人全齐；真人本人的 `player_info_s`（含 STEAM guid）在全部 134 条可见更新载荷中 **0 命中**（其加入更新疑落在长尾中止包，身份只能从聊天公告拿）；采样读取后按消息头位长**绝对收尾**（`seek(pos0+sizeBits)`）后中止数进一步降到 **2/59,951**。工程侧启示：viewer 的名字来源（`userinfoTimeline` 并入）与探针互补，`SayText2` 解码可按「控制字节边界 + UTF-8」口径实现（#90） **主体已处置（2026-10-01 清账轮，见 §7.1）**：删除表已按实测从 net.ts 撤除、SayText2 已接、按键显示已撤；探针留 `test/replay/dem-probe.html`（gitignore 区，不入库）；dem_usercmd 解码随按键显示撤除失去消费点、不再做

## T-062（原 #93） — 待裁决

**本轮入口收敛的两条留档待裁（2026-10-01）**：① **`importer.ts` 的 Source `.dem` 分支在 UI 层已无调用路径**——四个交互入口都按内容分派，`.dem` 一律进录像页，而 `ReplayPanel.loadFile` 嗅探后只放行 `.replay`（`apps/viewer/src/replay/panel.ts:283` 到 `apps/viewer/src/replay/panel.ts:293`）⇒ `ReplayImporter.import` 的 `.dem` 分流（`apps/viewer/src/replay/importer.ts:182`）连同 `importDemoOnMain`、`ImportResult.demo` 与面板里的「Source 录像」摘要分支（`apps/viewer/src/replay/panel.ts:346` 到 `apps/viewer/src/replay/panel.ts:358`）当前不可达；本轮**保留为解析层防御**（`ReplayImporter.import` 的对外契约仍是「传什么都能正确解析」），是否清账待裁；② **URL 深链 `?replay=` 仍按参数名只收 Shavit**——取到字节后先嗅探 `{SHAVITREPLAYFORMAT}`，不命中即报错（`apps/viewer/src/app.ts:685` 到 `apps/viewer/src/app.ts:689`），即 `?replay=<一份 .dem>` 会被拒；参数名本身即类型声明，故本轮未把它并进内容分派。两处的完整记述见 `documents/viewer/implementation/app.md` 已知缺口 6 与 `documents/viewer/implementation/replay.md` 第 20 条

原状态列：待 owner 裁决

## T-063（原 #94） — 已结案

~~**`.dem` 实体流：只有 1 个玩家实体采到位姿**~~ **已结案（2026-10-01，见 §7.1 同日条目）**。根因不在实体流：`readUpdateStringTable` 对非 `userinfo` 表硬解条目流读越界 ⇒ 整包放弃 ⇒ 丢掉同包之后的 `svc_PacketEntities` ⇒ 该 tick EnterPVS 的实体永远没有类别 ⇒ 后续增量记录跳过属性位而失步。修后 `entityPayloadExact = 59,948 / mismatch = 0`、`unknownClass = 0`、`overflow = 0`，玩家轨迹 5 条（修前 1 条）。

## T-064（原 #95） — 待裁决

**8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）**：`src/scripts/check-doc-drift.mjs` 的 B 规则只校验越界、不校验「锚点处内容是否为文档所命名的那行」（脚本头注已写明），故这类漂移不报错、也不会让门禁失败。本轮修 3d 锚点时逐条核对，已使 `apps/debug/src/renderer/renderer-main.ts` 的全部 100 处锚点对齐当前代码；**其余文件的锚点仍待核**（`app.ts` / `worker-types.ts` / `lod-manager.ts` / `lightmap-shader.ts` / `crates/wasm/src/lib.rs` / `config.ts` / `web/index.html` 等），最集中的一处是 `documents/debug/overview.md` 的启动序列（第 82–92 行，约 20 处 `app.ts` 锚点系统性偏旧）。**已实测确证的样例（文档值 vs 实际行）**：`mainWasmReady` 记 362、实际 261；`bindInput` 记 367、实际 1054；`bindUI` 记 369、实际 1248；`startInputLoop` 记 380、实际 2189；`ready` 记 `apps/debug/src/worker/main.ts:483`、实际 484；`updateStatsUI` 在 `documents/debug/sequences.md` 记 `apps/debug/src/app.ts:2302`、实际 537。**做法建议**：逐锚点按**符号名**重定位（不要按行号差值平移 —— 不同位置的增删量不同，本轮 3d 就是前段 -2、其后 -5）。**未做**：其余锚点的全量核对（8 篇 debug 文档的完整路径锚点共 534 处，需单独一轮）

原状态列：待 owner 裁决（属文档维护，非代码缺陷）

## T-065（原 #96） — 待修

**~~`check_stuck` 探测盒前探 16 HU 戳进前方上翘的坡 ⇒ 误报卡死~~ **主体已修（修法 A）**（`progress/open-issues/07` §8；回归 `src/phys/stuck_gate_tests.rs` 2 项）**：owner 在 `s1_ramp1b` 坡上 `z≈-9789` 卡死 3.5 秒、每采样抖 ±0.1 HU。**根因（已实测钉死）**：判据问「整盒是否实心」，而盒**故意**前探 16 HU 防穿墙 ⇒ **前方地面只要比脚下高**就误报"卡住"；盒尺寸扫描证实 **盒高 0→90 九行完全相同（高度零影响）**、分界落在 z 半伸 **13/14**，盒前缘 `z=-9805.06` 与命中三角形 z 上界 `-9802.85` 重叠 2.2 HU。**归属** = `models/props/666/s1_ramp1b.mdl`（tri_meshes 下标 205，`brush` 命中 0 / `tri` 命中 2）。**修法**：A —— `check_stuck` 开头 `if p.on_ground { p.stuck_ticks = 0; return false }`。**效果实测**：净 −z 行程 约196 HU（冻结）→ **914 HU**；朝 +z 位移 tick 每 tick 都有 → **1/540**；`stuck_ticks` 300 tick 内 0 次越界；站立 200 tick 水平漂移 **0.00 HU**（owner 观察到的横向推力消失）。**对照实验**：撤掉门后 `walking_into_a_higher_ledge_must_not_wiggle_in_place` **FAIL**，报 `381/400 tick 出现后退，最大单 tick +0.09 HU`，与真实场景抖动量级一致。**该夹具补上了原回归缺口**：证实「前方地面更高 ⇒ 判据误报」可用**手搓 brush** 复现（低地 + 12 HU 平台），不必依赖真实地图三角网格路径。**已否的修法**：**B**（挤出沿速度反方向）—— 本例速度就是 −z、反方向正是 +z 与现状相同，站立场景速度为零无方向可用；**E**（改用 `World::trace`）—— 实测在实心材料**内部 4 HU** 处 `trace frac` 仍全为 1.000（只 clip 穿过的平面，嵌入时一个平面都没穿过）⇒ `trace` 结构上测不出嵌入；且沿 ground_normal 脱身最小距离 卡死点 12 HU vs 真嵌入 16 HU，只差 4 HU 不区分，且 12 HU 抬升正是 `6050e88` 修掉的弹飞那一类瞬移。**顺带纠正**：真实身体盒 **32×72×32** —— `set_hull` 第三参是**蹲下高度**、`apply_hull` 把 z 半伸取成 `half_width`，此前把 54 当 z 半伸是错的（`debug_hull` 给出真值）。**遗留（§8.4）**：① t≈115 出现 −18.00 / +33.90 HU 相邻两 tick 跳变，形态与 `6050e88` 修掉的弹飞不同（净 +15.9），**成因未定位**；② A 的既定代价 —— 站立时的真卡死不再处理，未构造该场景验证后果；③ D / C 未实施

原状态列：卡死主体已修；遗留 3 条待处理

## T-066（原 #97） — 待裁决

**`.phy` 凸包表达不了曲面坡（`progress/open-issues/06` §3.3 / §7.4 的遗留）**：`s1_ramp1b` 实例 AABB `x -13984..-13088, y 13952..15148, z -11136..-9803`、108 顶点，坡面沿 −z 由 14558(z=-9800) 升到 14592(z=-10050)，约 8~12°（owner 描述的「逐渐上翘」成立）。相邻凸包 facet 之间存在十几 HU 落差，地面追踪只认「赢得 `enter_frac` 的那一张」。**弹飞本身已修**（`6050e88`）；**未决**：修后玩家在 facet 交界处停在低地不再前进。候选 **A** 保持现状 / **B** 收紧 `STEP_HEIGHT` / **C** 模型碰撞改用可视网格三角（能真正解决「坡顶能不能站」，代价是三角形数量与碰撞成本上升）

原状态列：待 owner 裁决

## T-067（原 #98） — 待裁决

**修好卡死后暴露的两 tick 跳变（成因未定位）**：修法 A 生效后，玩家在 `surf_666` 的 `s1_ramp1b` 上从 owner 起点朝 −z 走 600 tick 能一路走上坡（净 914 HU、比出发点高 267 HU，几何事实非缺陷），但 **t=115 掉 −18.00 HU（正好一个 `STEP_HEIGHT`）、t=116 立刻回弹 +33.90 HU**，两 tick 净 +15.9 HU（约 +1000 HU/s）。**与 `6050e88` 修掉的弹飞形态不同**：那次是「无条件抬 18」单 tick 一次；这次是「先掉 18 再回弹 34」两 tick 交替。**成因未实测**，需单独一轮（候选：`stay_on_ground` 的落回扫掠与 `step_move` 的抬升在相邻两 tick 互相抵消/叠加）。注意它发生在玩家**离开世界 brush 脊顶、进入模型坡面**的时刻（t≈115，`y` 从 14560.03 变到 14542.03 再到 14575.93）

原状态列：待 owner 裁决（是否单开一轮定位）

## T-068（原 #99） — 待裁决

**`AGENTS.md` 是全仓最大的文本文件，本轮起已超过 234 KB**（301 行、最长单行 4031 字符 —— §7.1 的进度行本身就是超长单行）。**实测增长**：`origin/main` 上的 blob 为 233,979 字节、本轮 `HEAD` 为 240,246 字节（本轮 +6.3 KB）；`git log --follow` 计 35 个提交碰过它。内容上是「唯一生效的 Agent 工作规范 + 进度纪要 + 待决索引」三合一；按现行口径拆分会破坏 §3 六步法与 §7 的自指引用（§7.3 的索引行指代 §7.1 的台账语义）。**是否拆分、拆成几份，留 owner 裁决**。若维持现状，可控增长的最小改动是把 §7.1 的超长进度行改成「一行摘要 + 指向详细文档」——本轮的两条 2026-10-05 进度行合计约 9 KB，其中绝大部分是实测数字，本可下沉到 `progress/open-issues/07` 一类专题文档

原状态列：待 owner 裁决


## T-435 详情（预烘焙光照方向 / 洋红魔法光源）

- **光源定位**：`LUMP_WORLDLIGHTS`（lump 15，记录 88 B）共 384 条；第 **#352** 条 = `origin [13332, 628, 12251]`、`intensity [690.1, 0.5, 1896.6]`（G≈0 ⇒ 纯洋红）、type=`emit_point`、style=0，距 owner 视点 `13539,1284,9884` **2465 HU**。全图洋红点光 20 条，其余最近的在 10056 HU 外。
- **方向基准**：该处近处 prop 的 leaf ambient cube 六面实测（`extras.ambientCube`）——槽 4（Source **+Z = 上**）最亮 `0.123~0.131`，槽 2（+Y）`0.065~0.078`，槽 5（-Z）最暗 `0.019~0.031` ⇒ 方向光**来自正上方**，洋红/亮度应落在**朝上**的面。
- **实现缺陷**：`src/wasm-core/model_integrator/mod.rs:1326` 位置走 `map_coords(model.apply_root_transform(...))`（Source Z-up → glTF Y-up），而 `:1333` 法线是 `vertex.normal.into()`，**既不做 `map_coords` 也不做根变换**。
- **引擎口径**：`common_vertexlitgeneric_dx9.h` 的 `VertexShaderAmbientLight`：`linearColor = n².x·cube[neg.x] + n².y·cube[neg.y+2] + n².z·cube[neg.z+4]`，`worldNormal` 是 **Source 世界轴**。本仓 `lightmap-shader.ts:1457-1459` 与它同形，且 cube 槽序也是 `[+X,-X,+Y,-Y,+Z,-Z]`（Source）⇒ 因为**法线也没转**，两侧"错得一致"，对**纯 yaw** 旋转的道具偶然成立；带 pitch/roll 的 prop（冲浪坡）会把"上方的光"贴到别的朝向。
- **一次被否定的改动（留痕避免重犯）**：曾直接把 shader 加权式改成 Three 序（`nz²·cube[0/1] + nx²·cube[2/3] + ny²·cube[4/5]`），用「按位置反算的 Y-up 法线」测 corr(朝向光源, ambient 亮度) 得 **-0.0541**，而原式得 **0.5297** ⇒ 单独改一侧会打坏。这也**反证**了未转的是法线一侧。
- **下一步（修法 + 判据）**：① `ModelVertex::from` 的法线改为 `map_coords(model.apply_root_transform(vertex.normal))`；② 同步把 shader 加权式改成 Three 序；③ 判据用 **GLB 的 `NORMAL` 属性**（不是从位置反算）重测相关系数应显著高于改前，并在 `13539,1284,9884` 同点截帧看洋红是否落在朝上的面。
