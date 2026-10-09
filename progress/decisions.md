# 待裁决分批清单（供 owner 批量答复）

> **性质**：过程记录（不作事实来源）。状态仍以根 `TODO.md` 为准。

> **用法**：每组一段「这批是什么 + 建议的答法 + 明细」。可以直接回「第 N 组：全部按建议」或「第 N 组的 T-0xx 我要保留」。

> 本清单生成于 2026-10-07，覆盖 `TODO.md` 中**全部 133 条待裁决**；未结项其余为 待修 39 / 已取证待立项 2。

---

## 第 1 组 · 缺陷（58 条）

**这批是什么**：**无法批量**：属行为/正确性问题，需逐条看。建议按归属小批过（每批 10–15 条），本页已按归属排好。

### game（16）

| ID | 事项 | 证据 |
|---|---|---|
| T-005 | apps/game 的 favicon.ico 被同一批删除波及：该文件在库中唯一，而 apps/game/web/index.html… | apps/game/web/index.html:19 |
| T-021 | game 面板 4 条（γ 量程 vs 接受窗口 / 数值框不回写 / 死变量 / 默认 γ=2.2 被忽略） | 见详情 |
| T-024 | game 类型面/配置面 3 条（worker-types.ts 落后实际载荷等） | 见详情 |
| T-031 | game phys-rate-parity 4 条（混合分区时长/结果、flatTop AABB） | 见详情 |
| T-055 | game 审查登记（P1×3 + P2×9）：P1——导航 .mod 与 .key-chip/.x 是无 tabindex 的 div（… | 见详情 |
| T-056 | 多轮对话遗留待办合并（owner 逐轮提出、未裁决）：① 关闭确认已上线但 F5 / 刷新同样弹框，若嫌烦改条件化（仅在有地图 / 对局… | 见详情 |
| T-201 | 主线程 wasm 初始化失败被 `.catch` 吞掉、不阻断加载，缺失纹理降级为占位色 | apps/game/src/app.ts:507 |
| T-203 | 未选图／未锁定前点击画布直接返回，不请求指针锁定也无任何反馈 | apps/game/src/app.ts:249 |
| T-204 | `hud` 段下发的是全量物理参数、被 Worker 并入 `config.hud`（app-entry／config／input／worker 四篇同指） | apps/game/src/input/input-bridge.ts:65 |
| T-209 | M 键与 ESC 两条全局监听不校验 `sceneReady`，加载覆盖层显示期间同样触发 | apps/game/src/panel/panel-controller.ts:265 |
| T-212 | `loadScene` 入口先调 `disposeScene`，换图失败时场景已释放、只能重新选图 | apps/game/src/renderer/renderer-main.ts:254 |
| T-213 | 删除存点无二次确认：按钮回调直接调 `onSavePointDelete`，`delete` 立即 `persist`；越界索引不报错 | apps/game/src/savepoint.ts:92 |
| T-214 | 存点不含蹲伏态：读点的 `eyeHeight` 取渲染物理当前值，蹲伏中读点会把当前眼高带入新状态 | apps/game/src/savepoint.ts:21 |
| T-216 | `persist` 每次整表序列化，`add`／`delete`／`clear` 各触发一次、写入量随条数线性增长 | apps/game/src/savepoint.ts:112 |
| T-218 | `.mdl` 配对名用大小写敏感的 `replace`，zip 条目名非全小写时 `.vvd`／`.dx90.vtx` 取回同一份 `.mdl` | apps/game/crates/wasm/src/lib.rs:117 |
| T-220 | `world-parse-ms` 的两段 `JSON.parse` 与 `build_world` 内部解析重复、开销叠加 | apps/game/src/worker/main.ts:513 |

### debug（7）

| ID | 事项 | 证据 |
|---|---|---|
| T-007 | apps/debug/src/wasm.d.ts:67-119 的 PhysWorld 类型落后源码 7 个方法（缺 tick_into… | apps/debug/src/wasm.d.ts:67-119 |
| T-035 | input-replay-verify.mjs 5 条（inputRecorder 永不落样本、f.dt 字段不存在、页面缺 7 个 i… | 见详情 |
| T-054 | debug 审查登记（P1×4 + P2×9）：P1——全局 :focus-visible 与 ::selection 规则整体缺失（g… | apps/debug/src/app.ts:1992 |
| T-302 | 面板 `PARAM_DEFS` 与 `config.ts` 两套默认值来源、无交叉校验（`jumpHeight` 57 与 `jumpSpeed` 302 同写 `jump_height`） | apps/debug/src/physics/param-defs.ts:47 |
| T-303 | 剔除/PVS 统计口径失真：`pvsHidden` 恒写 0 却按「隐藏 N」打印，`PvsManager.update` 从不调用 ⇒ `cluster` 恒 -1 | apps/debug/src/renderer/lod-manager.ts:257 |
| T-306 | lightmap 诊断覆盖只在模块初始化时固化为 uniform 初值，运行期注入不改变已创建 uniform | src/renderer-shared/shader/lightmap-shader.ts:1539 |
| T-309 | 手写 `.d.ts` 的 `BspProcessor` 侧落后 Rust 导出面 11 项（13 vs 24） | apps/debug/src/wasm.d.ts:34 |

### shared（11）

| ID | 事项 | 证据 |
|---|---|---|
| T-013 | lightmap.rs 错误串含外部实现引用 Lightmap.cs:64 | src/wasm-core/bsp_to_gltf_core/lightmap.rs:207 |
| T-015 | vbsp/data/entity.rs 6 条（含 start_disabled 恒 false 的跨工程实锤） | 见详情 |
| T-018 | tick-authority.test.ts 断言标签含 Q1 / §8.5 | src/ts-shared/auth/tick-authority.test.ts:625 |
| T-066 | .phy 凸包表达不了曲面坡（progress/open-issues/06 §3.3 / §7.4 的遗留）：s1_ramp1b 实… | 见详情 |
| T-067 | 修好卡死后暴露的两 tick 跳变（成因未定位）：修法 A 生效后，玩家在 surf_666 的 s1_ramp1b 上从 owner … | 见详情 |
| T-107 | 分块选块包围盒只统计部分 Mesh，块边长由子集推出 | src/renderer-shared/scene/scene-optimizer.ts:250 |
| T-116 | 注入期 throw 不在本工程调用方 catch 覆盖范围内 | src/renderer-shared/shader/lightmap-shader.ts:1104 |
| T-210 | 分块 cell 尺寸只在单材质分支累计包围盒，仅有多材质网格时并集为空、整个分块直接返回 | src/renderer-shared/scene/scene-optimizer.ts:250 |
| T-504 | 无 $basetexture 的面按 $color 上色，大片无纹理面呈平白 / 粉 | 见详情 |
| T-506 | 站立时的真卡死不再被处理（修法 A 的既定代价，未构造场景验证后果） | 见详情 |
| T-507 | check_stuck 的修法 D / C 未实施 | 见详情 |

### repo（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-033 | 【台账号·部分细化】夹具路径失效 → T-127；其余仍待裁 WG6b 6 条（test/maps/surf_null_4.replay 跨 3 文件失效等） | 见详情 |

### viewer（23）

| ID | 事项 | 证据 |
|---|---|---|
| T-053 | viewer P1×3 + P2 批（同轮审查登记）：P1——帮助文案「淡金带 / 金框」与区间带现行灰白斜纹 / 白框不符（apps/… | apps/viewer/src/replay/timeline.ts:110 |
| T-060 | .dem 玩家输入可得性重审（owner 质疑「表示无法获取玩家的输入，但实际上应该可以」，2026-10-01 | 见详情 |
| T-101 | 面板容器缺失时静默降级为脱离文档的元素（需决定是否显式报错） | apps/viewer/src/app.ts:210 |
| T-103 | ?replay= 深链仍按参数名定类型，.dem 会被拒（统一为内容分派属独立改动） | apps/viewer/src/app.ts:807 |
| T-106 | numField 把空串当合法 0 写入变换 | apps/viewer/src/core/dom.ts:107 |
| T-110 | 包内 svc_CreateStringTable 只稳定解出第一张表 | apps/viewer/src/replay/demo/net.ts:693 |
| T-111 | svc_CreateStringTable 的压缩标志未实现 | apps/viewer/src/replay/demo/net.ts:709 |
| T-112 | svc_UpdateStringTable 只对 userinfo 解条目，其它表只按长度跳过 | apps/viewer/src/replay/demo/net.ts:730 |
| T-113 | svc_GameEvent 只按长度跳过，事件描述符表未保存 | apps/viewer/src/replay/demo/net.ts:563 |
| T-124 | Track.offset 只有下界没有上界，可拉长主时钟总长 | apps/viewer/src/replay/trackpanel.ts:204 |
| T-125 | 零帧轨道的口径不一致（列表面板有卡片、3D 无对象） | apps/viewer/src/replay/visuals.ts:96 |
| T-128 | dist 里的示例记录无法由当前源码路径重新产出 | apps/viewer/scripts/build-dist.mjs:238 |
| T-137 | 端口占用分支假定占用者服务的是 dist | apps/viewer/start.cmd:26 |
| T-139 | 导航缺「卸载地图」入口，载入过地图后回不到空态 | apps/viewer/src/ui/mapinfo.ts:125 |
| T-142 | 信息条重找跟随轨道，与 TrackSet.follow 策略重复 | apps/viewer/src/ui/replaymeta.ts:25 |
| T-143 | el() 属性写入限制了 id 型契约（undefined 静默无 id） | apps/viewer/src/core/dom.ts:39 |
| T-145 | 模型名匹配与材质查找的大小写口径不一致 | apps/viewer/crates/wasm/src/lib.rs:606 |
| T-147 | 材质去重键是材质名，同名材质被后续模型复用 | apps/viewer/crates/wasm/src/lib.rs:216 |
| T-148 | packed_files 构造期缓存而 num_static_props 每次现算 | apps/viewer/crates/wasm/src/lib.rs:381 |
| T-149 | map_name 两端都拿不到值，字段保留但无内容 | apps/viewer/crates/wasm/src/lib.rs:389 |
| T-151 | BspMetadata 与 TS 契约靠约定对齐，无编译期校验 | apps/viewer/crates/wasm/src/lib.rs:362 |
| T-152 | Worker 没有心跳，请求侧无法区分「在解析」与「已失联」 | apps/viewer/src/worker/main.ts:91 |
| T-153 | WorkerCtx 是手写的全局面（tsconfig lib 缺 WebWorker） | apps/viewer/src/worker/main.ts:33 |

## 第 2 组 · 未接线·死代码（58 条）

**这批是什么**：**建议默认删除**（零调用点/未接线 = 无主负债，删了 git 里可复原）。owner 只需**点名保留**的（例如预留接口）。

### repo（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-036 | WG5b 末批 15 条（死常量/死判据/不可达分支/404 的 coi-serviceworker.js 等） | 见详情 |

### debug（16）

| ID | 事项 | 证据 |
|---|---|---|
| T-046 | debug / game 的 RendererMain.getLightingMode() 零调用点：debug 与 game 各有一份… | apps/debug/src/renderer/renderer-main.ts:460 |
| T-047 | game RendererMain.resetTo() 与 stop() 零调用点：start() 由 apps/game/src/ap… | apps/game/src/app.ts:170 |
| T-310 | `set-auto-restore-hull` 只改面板侧标记，`src/phys/**` 无对应参数与读取点，开关不写物理实例 | apps/debug/src/worker/worker-types.ts:146 |
| T-312 | `tsconfig.json` 的五个路径别名零导入点 | apps/debug/tsconfig.json:19 |
| T-313 | `keysFromMask` 无调用点 | apps/debug/src/input/input-recorder.ts:772 |
| T-314 | `InputPlayer.adopt` / `seekTo` / `setRealtime` 的调用面窄 | apps/debug/src/input/input-recorder.ts:541 |
| T-315 | `vec3.ts` 的 13 个函数零调用点 | apps/debug/src/physics/math/vec3.ts:11 |
| T-316 | `setParamFromMap` 零调用点 | apps/debug/src/physics/physics-params.ts:110 |
| T-317 | `TraceResult` 与 `V3Tuple` 的消费面不在本目录 | apps/debug/src/physics/physics/Collision/Collision.types.ts:49 |
| T-318 | `LOD_LEVEL.PVS_HIDDEN` 是预留档位 | apps/debug/src/renderer/lod-manager.ts:26 |
| T-319 | `assignClusterIds` 的结果无消费方 | apps/debug/src/renderer/lod-manager.ts:181 |
| T-320 | 默认导出与 `parse_bsp` 在本工程零调用点 | apps/debug/src/wasm.d.ts:20 |
| T-321 | `apps/debug/web/styles.css` 在全工程零引用 | apps/debug/scripts/build-dist.mjs:63 |
| T-322 | `TeleportManager` 的六项成员零调用点 | apps/debug/src/world/teleport-manager.ts:18 |
| T-323 | `spawn-loader.ts` 整模块零调用点 | apps/debug/src/world/spawn-loader.ts:11 |
| T-324 | `types.ts` 里有一批零引用类型 | apps/debug/src/world/types.ts:18 |

### viewer（17）

| ID | 事项 | 证据 |
|---|---|---|
| T-058 | DemoParseResult 里「已解码但应用面为零」的字段清单（owner 要求记录，2026-09-30 | 见详情 |
| T-062 | 本轮入口收敛的两条留档待裁（2026-10-01）：① importer.ts 的 Source .dem 分支在 UI 层已无调用路径… | apps/viewer/src/replay/panel.ts:283 |
| T-114 | 一组逆向期诊断开关仍留在生产代码里（含已被驳回的 mergeVectorElems） | apps/viewer/src/replay/demo/net.ts:269 |
| T-140 | 遥测 HUD 自算水平速度，与 sampling/player 的现成实现重复 | apps/viewer/src/ui/telemetry.ts:122 |
| T-156 | `wasm.d.ts` 是零导入点的类型面 | apps/viewer/src/wasm.d.ts:13 |
| T-157 | `viewer.replay.setSpeed` 的钳制下限在正常入参下不可达 | apps/viewer/src/app.ts:726 |
| T-158 | `core/pose.ts` 的两个函数零调用点 | apps/viewer/src/core/pose.ts（2026-10-09 T-158 已删除该函数） |
| T-159 | `RAD2DEG` 在 `apps/viewer/src` 内零调用点 | apps/viewer/src/core/constants.ts:25 |
| T-160 | `ViewerScene.model` getter 零调用点 | apps/viewer/src/core/scene.ts:85 |
| T-161 | 六个导出在本工程内零调用点 | src/renderer-shared/shader/lightmap-shader.ts（2026-10-09 已删 5 个，留 3 个） |
| T-162 | `setLightFloor` 在本工程内零调用点 | src/renderer-shared/shader/lightmap-shader.ts:1742 |
| T-163 | `ReplayPlayer` 两个成员零调用点 | apps/viewer/src/replay/player.ts（2026-10-09 已删） |
| T-164 | `ReplayImporter.dispose()` 零调用点 | apps/viewer/src/replay/importer.ts（2026-10-09 已删） |
| T-165 | `ReplayVisuals.hasTracks()` 零调用点 | apps/viewer/src/replay/visuals.ts（2026-10-09 已删） |
| T-166 | `ShavitParseResult.flags` 与 `frameStart` 在运行期无消费点 | apps/viewer/src/replay/shavit-replay.ts:507 |
| T-167 | 进度回调里的 `'map'` 分支不可达 | apps/viewer/src/replay/panel.ts:329 |
| T-168 | `MapPanel.spawnPoints` getter 零调用点 | apps/viewer/src/ui/mapinfo.ts（2026-10-09 已删） |

### game（17）

| ID | 事项 | 证据 |
|---|---|---|
| T-206 | `InputBridge.addInput` 是显式空实现，三个实参全部被丢弃 | apps/game/src/input/input-bridge.ts:30 |
| T-211 | `ENABLE_PVS` 常量关死：`pvs.update` 与按 cluster 隐藏均不执行，`pvsManager`／`clusterIds` 仍构造 | apps/game/src/renderer/renderer-main.ts:74 |
| T-225 | `physics.mode` 零读取点 | apps/game/src/config.ts:27 |
| T-226 | `sendSetDeathThreshold` 零调用点 | apps/game/src/input/input-bridge.ts:83 |
| T-227 | 共享层的累积路径无消费方 | src/ts-shared/input/mouse-buffer.ts:81 |
| T-228 | `sampleEpoch` 字段只写不读 | apps/game/src/renderer/renderer-main.ts:127 |
| T-229 | `applyCollisionCorrection` 的入参有三个不被读取 | src/ts-shared/phys/authority-calibrator.ts:735 |
| T-230 | 光照模块内多个导出在本工程零导入点 | src/renderer-shared/shader/lightmap-shader.ts:1742 |
| T-231 | `SavePoint.t` 只写不读 | apps/game/src/app.ts:610 |
| T-232 | `getMap()` 零调用点 | apps/game/src/savepoint.ts:69 |
| T-233 | `clear()` 零调用点 | apps/game/src/savepoint.ts:98 |
| T-234 | `mtzB64` 与契约清单都指向了没有直接调用点的字段 | src/ts-shared/auth/worker-dispatch.ts:297 |
| T-235 | `apps/game/src/world/types.ts` 在本工程零导入点 | apps/game/src/renderer/renderer-main.ts:42 |
| T-236 | `export_glb_with_pakfile_models_with_defaults_and_atlas_limit` 在本工程无调用点：… | apps/game/crates/wasm/src/lib.rs:577 |
| T-237 | `map_name` 恒为空串 | apps/game/crates/wasm/src/lib.rs:457 |
| T-238 | `InitMessage` 有三个字段既无发送方也无读取点 | apps/game/src/worker/worker-types.ts:36 |
| T-239 | `worker-types.ts` 里多条声明在本工程无发送方且无接收点 | src/ts-shared/auth/worker-dispatch.ts:265 |

### shared（7）

| ID | 事项 | 证据 |
|---|---|---|
| T-402 | `compute-mode` 的三模式接线 | src/ts-shared/auth/auth-loop.ts:160 |
| T-403 | `MouseBuffer.push` / `drain` | src/ts-shared/input/mouse-buffer.ts:81 |
| T-404 | `ShmState.wake` | src/ts-shared/auth/shared-state.ts:447 |
| T-405 | `maskToKeys` | src/ts-shared/auth/shared-state.ts:98 |
| T-406 | `PvsManager.getFaceCluster` / `visibleClusterCount` | apps/game/src/renderer/renderer-main.ts:274 |
| T-407 | `world/types.ts` 的 `rootNode` 字段 | apps/game/crates/wasm/src/lib.rs:1704 |
| T-408 | `bsp_to_gltf_core/convert.rs` 内三份 GLTF 合并实现零调用点（合计约 500 行，各带 `#[allow(de… | src/wasm-core/bsp_to_gltf_core/convert.rs:367 |

## 第 3 组 · 文档口径（4 条）

**这批是什么**：**建议一律接受当前口径**（文档已按源码重写，判据是可定位）。owner 只需**点名不接受**的。

### shared（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-016 | compute-mode.ts 的 summary 字面量含已删文档编号 | src/ts-shared/auth/compute-mode.ts:89 |

### debug（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-048 | worker 消息联合类型与实际收发不符（历史遗留，已由文档记录）：debug/game 的 worker-types.ts 里 rea… | 见详情 |

### docs（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-064 | 8 篇 debug 文档存在「在界内但内容偏旧」的锚点簇（2026-10-03 本轮量化，未改）：src/scripts/check-d… | apps/debug/src/worker/main.ts:483 |

### viewer（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-119 | 时间轴两条 title 文案与默认播放窗口矛盾 | apps/viewer/src/replay/timeline.ts:108 |

## 第 4 组 · 配置·门禁（10 条）

**这批是什么**：**建议按证据列逐条批准**；这批大多是「脚本结论不带退出码 / 路径失效 / 标签无出处」这类机械项。

### game（5）

| ID | 事项 | 证据 |
|---|---|---|
| T-008 | apps/game/scripts/check-wasm-api.mjs:52-70 的 PHYS_API 只列 17 项，缺 new … | apps/game/scripts/check-wasm-api.mjs:52-70 |
| T-023 | check-wasm-api.mjs 输出标签 F4 无出处 | 见详情 |
| T-032 | game 脚本 11 件 7 条（_dbg_floor 的 onGround 恒 undefined 等） | 见详情 |
| T-222 | 20 个脚本里仅 7 个设退出码，其余 13 个结论只在 stdout 末行、接入 CI 时判定不带出 | 见详情 |
| T-223 | single 产物引用了不在保留名单里的 `coi-serviceworker.js`、dist 同目录无该文件 | apps/game/scripts/build-dist.mjs:60 |

### debug（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-029 | debug 脚本 10 条（jump-apex 采样链链路级仍待裁决 | 见详情 |

### repo（2）

| ID | 事项 | 证据 |
|---|---|---|
| T-038 | 9 个 .cmd 的 5 条遗留（viewer start.cmd 守卫与 dist/play.cmd 等） | 见详情 |
| T-039 | 依赖表「本 crate 无引用点」清单（两法一致：源码引用面扫描 + cargo check 的 -W unused-crate-dep… | 见详情 |

### viewer（2）

| ID | 事项 | 证据 |
|---|---|---|
| T-131 | 冒烟三条静态断言只对 single 产物成立 | apps/viewer/test/smoke-cdp.mjs:138 |
| T-150 | Cargo.toml 说明把已不在工作区的 test 列为同款 patch 持有方 | apps/viewer/Cargo.toml:11 |

## 第 5 组 · 工具·流程（3 条）

**这批是什么**：**建议接受**（流程与工具边界类，无行为影响）。

### shared（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-117 | broken 阶段对照靠失配字面量维持，three 升级需同步 | src/renderer-shared/shader/lightmap-shader.ts:346 |

### viewer（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-134 | build.cmd 无法产出 multi 产物 | apps/viewer/build.cmd:8 |

### debug（1）

| ID | 事项 | 证据 |
|---|---|---|
| T-308 | 四个 `.cmd`（dev/build/start/stop）无 npm script、互不转发，双击入口与命令行入口的环境准备各写一套 | apps/debug/dev.cmd:17 |

---

## 附：需要先细化才能裁决的吗？

看板里标「【台账号·已细化】」的行是**聚合壳**：其底层条目已各自建号（见各行「详情」列所指的 `progress/pending-detail.md` 节）。
裁决时**只答底层条目**，台账号行本身无需表决。标「部分细化」的行（如 T-033）剩余部分仍需裁决。

