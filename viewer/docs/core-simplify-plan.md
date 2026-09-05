# viewer 核心化简化方案（地图游览 + 录像播放）

> 状态：方向已由用户逐项拍板（2026-09-06，两轮 grill 确认），本文为实现基线。
> 本方案**取代** `docs/ui-simplify-requirements.md`（旧基线"不砍任何功能"的底线已按用户决定推翻；
> 旧文档保留作历史记录，文首已加 superseded 标记）。
> 对象：`D:\code\projects\websurf\viewer`（~9,000 行 TS + index.html/styles.css + 测试 + 文档）。

---

## 0. 决策记录（用户原话裁决）

| # | 议题 | 裁决 |
|---|---|---|
| D1 | 录像格式支持 | 保留自家规则脚本机制 + 暴露播放接口；**允许传入 .js 文件做中间态转化**；转化脚本交给 AI 写——"给个规则让 AI 看得懂怎么做就行"（需产出 AI 转化规范文档 + 提示词模板） |
| D2 | 不要的功能 | **物理删除**源码，同步收缩 smoke 断言与 README/docs（保留功能的断言不弱化，可从 git 历史找回） |
| D3 | 轨迹模式 | **多轨迹必要**，但轨迹列表 UI 需要优化（两行式轨道卡、空态收敛） |
| D4 | 地图游览扩展 | 保留**出生点跳转 + 地图摘要**、**网格/坐标轴参考显示**（从量测页拆出）；位姿三通道 API 不保留 |
| D5 | 对齐工具 | 删交互式标定与朝向诊断；**至少提供简化方案让人调整录像的位置与朝向**（变换调整：偏移 + yaw + 一键锚定） |
| D6 | 接口边界 | **删位姿 API**（?pos=&ang= / hash / window.viewer.setPose/getPose）；**保留 ?bsp=&replay=&rule= 深链**；window.viewer.replay 保留并**补播放控制**（play/pause/seek/倍速/切轨道） |

**量测（两点拾取测距）明确完全不需要**（D2 物理删除）。

---

## 1. 最终形态（简化后的产品面）

### 1.1 用户可见面

- **侧栏两页**：
  - **「地图」页** = 更换地图 / 摘要（文件名、出生点数、世界尺寸）+ 统计明细折叠 / 出生点列表（单行 pill + 跳转）/ 参考显示（地面网格 + 世界坐标轴两个开关，自量测页迁入）。
  - **「录像」页** = 三个分区：
    1. **导入**：选择录像文件 / 拖拽 / 载入示例 + 规则区（当前生效规则只读展示 + 复制；「载入规则脚本 (.js)」按钮；拖 .js 进窗口=换规则）。
    2. **轨迹列表**：多轨迹（显隐 / 偏移 / 跟随 / 重命名 / 移除），两行式轨道卡，空态隐藏批量按钮（沿用旧基线 S4 设计）。
    3. **变换调整**：位置偏移 X/Y/Z + 朝向 yaw（±90° 快捷 + 自由角度）+ 「锚定到最近出生点」+ 「重置」；改动即重导当前轨道（沿用"改规则=替换当前轨道"语义）；面板 note 常显"首帧距最近出生点距离"。
- **底部时间轴**：播放/停止/逐帧 + 时间/帧号 + 进度条 + 倍速 + 循环 + 视角（第一/第三人称）+ 轨迹线/幽灵 + 速度读数 + A-B 区间（全部保留，布局沿用已落地的 S5）。
- **HUD**：三行角色行（位姿读数 / 地图状态 / 录像提醒）+ 「?」帮助浮层（键位 / 载入 / 变换调整说明 / **AI 转化指引入口**；删位姿三通道、HU 换算主题）。
- **引导层**：无地图时首访卡（选文件 / 拖拽 .bsp 与 .json）。

### 1.2 外部接口（简化后全集）

- 深链 `?bsp=&replay=&rule=`：rule 接受 RuleConfig JSON **或裸 .js 文本**（fetch 后先试 JSON.parse，失败按脚本源码处理）。
- `window.viewer.replay`：
  - 内省（保留）：trackCount / duration / time / playing / mode / followId / sceneObjects（**删 orientation 字段**）。
  - 控制（新增）：`play()` / `pause()` / `seek(sec)` / `setSpeed(x)` / `setMode('first'|'third')` / `follow(trackId|null)` / `tracks()`（只读轨道信息数组）。
- localStorage `websurf-viewer.replay-rule.v1`（RuleConfig v1，**新增可选 `transform` 字段**，见 §3.3）。
- 拖拽：`.bsp`=换图、`.json`=导入录像、**`.js`=换规则脚本**（新增）。

### 1.3 AI 转化规范（新文档 `docs/replay-rule-ai.md`）

内容契约（"让 AI 看得懂"的完整规范）：

1. 输入侧：probe 探测结果格式（帧数组路径 / 首帧样例）、常见 JSON 形态示例。
2. 脚本契约：函数签名、入参（原始 JSON、H.* 工具集）、出参（标准帧：pos/ang/time/vel，单位与角度约定：HU、Y-up、yaw 0=−Z）。
3. `H.*` 工具速查（helpers.ts 现有 API，保持不变）。
4. `transform` 字段说明（offset/yawDeg，脚本输出后的后处理，供人工微调，AI 一般不用管）。
5. 两个完整示例：自家标准格式 + 一个第三方格式（以现 Shavit 预设逻辑改写为独立 .js 作范例）。
6. **提示词模板**：用户把「本规范全文 + 自己的 JSON 样例」粘贴给任意 AI 即可产出可用 .js。

---

## 2. 删除清单（物理删除，含证据落点）

| # | 删除对象 | 落点 | 约行数 |
|---|---|---|---|
| R1 | 量测工具（两点拾取/距离/清空交换） | `src/ui/measure.ts` 拾取部分、index.html 量测 tab/pane、app.ts:103-108 装配、styles | ~250 |
| R2 | 坐标系标定（对应点求解 UI + 纯函数） | `src/replay/calibpanel.ts`(320)、`src/replay/calib.ts`(211)、panel.ts 标定分区、app.ts getWorldRefs spawns 供给 | ~600 |
| R3 | 朝向诊断 + 一键修正（Shavit 专用） | `src/replay/orientation.ts`(437)、panel.ts 诊断 UI（运行朝向诊断/一键修正朝向）、`window.viewer.replay.orientation` 钩子、docs/overview.md:173 的 `tools/verify-replay-orient.mjs` **死引用**（审查确认：该文件与对应 npm script 实际不存在，无需删文件只须清文档） | ~450 |
| R4 | 规则表单编辑器（数据定位/位置/朝向/速度/时间表单 + 表单↔脚本生成 + customized 让权机制） | panel.ts 表单分区主体、codegen.ts 的 **generateScript / PRESETS / applyPreset**（⚠ `compileScript`/`probeScript` 是 parse-worker.ts:7 与 importer.ts:3 的活依赖，**必须保留**）、规则 JSON 导入导出 UI | ~1,400 |
| R5 | 规则脚本编辑器（textarea + 0.5s 防抖重导） | panel.ts 规则脚本分区（434-474、665-674）——替换为只读展示 + 复制 + 载入 .js | （含于 R4 面） |
| R6 | probe 探测 UI 分区（路径下拉/首帧样例表单） | panel.ts 探测分区；importer 内部探测逻辑保留用于错误提示 | ~120 |
| R7 | 位姿三通道 | `?pos=&ang=` query（app.ts:393-397）、hash/hashchange（385-391）、`window.viewer.setPose/getPose`（360-368）、`parsePoseParams`（core/pose.ts）；mapinfo 内部 applyPose 跳转保留 | ~80 |
| R8 | 坐标系预设下拉（表单的一部分） | panel.ts:224-236——第三方适配改走 .js 文件 + AI 文档范例；自家格式为内置默认规则 | ~80 |

预计净删源码 **~2,400 行**（panel.ts 从 1,036 行收敛到 ~450 行）。

**保留不动的核心**：`core/`（scene/fly/bsp/dom/constants/pose 剩余部分）、replay 播放管线（player/timeline/tracks/visuals/sampling/build/importer/worker/helpers/types）、**codegen.ts 收缩保留 `compileScript`/`probeScript`（~90 行，worker 与 importer 依赖）**、Hud、示例录像链路、WASM/Rust 层零接触。

---

## 3. 新增 / 改造

### 3.1 参考显示迁入地图页（自 measure.ts 拆出）

- 新 `src/ui/reference.ts`（~80 行）：地面网格 + 世界坐标轴两个开关，尺寸按地图包围盒自适应（搬 measure.ts:88-112 逻辑）；挂地图页底部小节。
- app.ts 换图时 `reference.setWorld(box)`（替代原 `measure.setWorld`）。

### 3.2 规则以 .js 文件为一等公民

- 录像页导入区：「载入规则脚本 (.js)」+ 当前规则只读展示（mono 小字 + 复制按钮 + 规则来源标记：内置默认 / 文件名 / 深链）。
- 拖拽 `.js` → 换规则并按现有语义（改规则=替换当前轨道）重导。
- 深链 `?rule=` 同样接受裸 .js。
- localStorage 持久化最近规则（schema 不变，scriptSrc 存脚本源码）。
- 自家标准格式内置默认规则（实现时核对现有 sample 导入链路的默认映射，作为内置脚本常量）。
- **scriptSrc 契约（审查确认）**：脚本是**求值为映射函数的单表达式**，编译方式 `new Function('H', '"use strict"; return (' + src + ');')`（codegen.ts:140-146），入参 `(frame, i, H)`、返回 `{t, pos[3], ang[3], vel|null}`——AI 规范文档必须按此书写（.js 文件 ≠ 任意脚本，是单个箭头函数表达式）；文件输入 accept 两处（panel.ts:161、550）扩为 `.json,.js`。
- **自家默认规则（审查确认现状）**：全新用户无 localStorage 时 `scriptSrc=''` 导入必失败；"示例可直播"来自 defaultRule() 表单字段经 generateScript 生成（sample.ts:6 头注）。**P2 删 generateScript 前**，先把 `generateScript(defaultRule())` 的输出固化为内置 `DEFAULT_RULE_SRC` 常量（或手写等价 identity 脚本），无规则时自动套用。

### 3.3 变换调整（替代标定/朝向诊断/一键锚定的简化人工方案）

- RuleConfig v1 新增可选字段 `transform?: { offset: [number,number,number]; yawDeg: number }`，在 build.ts 脚本输出后统一后处理（绕 Y 旋转 + 平移，同时作用于 pos/ang/vel/bbox）。
- UI（录像页第三分区）：偏移 X/Y/Z 数字输入 + yaw 数字输入 +「±90°」快捷钮 +「锚定到最近出生点」（computeStartAid 的 Δ 写入 offset，保留）+「重置」。
- 改动 → 重导当前轨道（复用现有 replaceClip 链路，保配色/显隐/时间偏移）。
- 自动检测保留：首帧 vs 最近出生点距离 note（128 贴合 / 1024 需处理口径不变）+ 轨迹 bbox 落地图外 HUD 提醒（app.ts updateReplayMapStatus 原样）。

### 3.4 播放控制 API

- `window.viewer.replay` 按 §1.2 扩展控制方法；全部走 player/tracks 现有公共方法，不新开状态。

### 3.5 轨迹列表 UI 优化（D3）

- 沿用旧基线 S4：两行式轨道卡（行 1 = 色点 + 改名 + 帧数/时长；行 2 = 显隐 + 偏移 + 跟随 + 移除）；空态隐藏批量按钮；`.track-*` class 与按钮顺序 [显隐,跟随,移除] 不变。

---

## 4. 测试与文档同步（D2 要求，断言不弱化）

### 4.1 smoke（test/smoke-cdp.mjs）

- **删**：8 个旧分区标题断言（smoke:277）、朝向诊断流程 [3b]（smoke:332-377）与 file:// 规则注入的朝向前置（smoke:219-240）、标定全流程 [9]（smoke:458-532+）、`replay.orientation`。（审查确认：smoke 并不断言位姿 API/`setPose`/`?pos=`，R7 的 smoke 删改量为零。）
- **改**：分区标题断言集合换为新三区（导入/轨迹列表/变换调整）；B2/B4/B5/B6 表相应重写。
- **增**：拖/选 .js 换规则、变换调整（改 offset → 轨道坐标变化 + 轨道属性保留）、`viewer.replay.play/pause/seek/setSpeed/setMode/follow`、地图页网格/坐标轴开关存在且可切换、`.js` 深链模式。
- **时序（审查修正，P0）**：上述「删/改」必须与 P2 的 UI 删除**同一提交**——否则 P2→P3 之间 smoke 必红，违反 D2「同步收缩」；「增」随 P3。

### 4.2 Node 自检（test/replay-selftest.ts）

- 删 calib/orientation/codegen 表单生成相关用例——**必须与 P2 模块删除同提交**（replay-selftest.ts:18-21 直接 import calib.js / orientation.js / codegen 的 generateScript，模块一删自检即编译失败）；**增** transform 后处理用例（旋转+平移对 pos/ang/bbox 的正确性、缺省字段向后兼容、**yaw 旋转符号对照「yaw 0=−Z、逆时针为正」约定**）、裸 .js 规则解析用例。

### 4.3 文档

- 新增 `docs/replay-rule-ai.md`（§1.3）。
- README：删量测/标定/朝向诊断/位姿三通道/表单编辑章节；新增 .js 规则载入、变换调整、播放控制 API、AI 指引指引。
- 同步文案（审查补充）：package.json description（现含「位置/朝向 API」）、index.html 引导卡第③步（现提「量测距离」）与帮助浮层（删「位姿三通道」「量测与单位换算」两节；「起点对齐阈值」节的修正工具清单改为「变换调整」）、dist/README.md 与 scripts/dist-README.md 如提及被删功能一并清理。
- docs/overview.md：模块表与回放管线图同步（含删除 verify-replay-orient 死引用）；`docs/ui-simplify-requirements.md` 文首加 superseded 标记。

---

## 5. 阶段划分与验证门

| 阶段 | 内容 | 验证门 |
|---|---|---|
| P1 地图侧 | R1 量测删除 + 3.1 参考显示迁地图页 + R7 位姿 API 删除 | typecheck → build:ts → 手工：换图/出生点跳转/网格开关 |
| P2 录像侧删 | R2 标定 + R3 朝向诊断 + R4 表单编辑器（codegen 只删 generateScript/PRESETS/applyPreset，保留 compile/probe）+ R5 脚本编辑器 + R6 probe UI + R8 预设；panel.ts 重组为新三区；**同提交**固化 DEFAULT_RULE_SRC、同步 test:replay 删用例与 smoke 删改断言 | typecheck → test:replay → test:smoke（收缩后）→ 手工：示例录像导入/播放/多轨迹 |
| P3 录像侧增 | 3.2 .js 规则 + 3.3 变换调整 + 3.4 播放控制 API + 3.5 轨迹卡优化 | test:replay（新增用例）→ smoke（同步改造后全绿，含 file:// 与深链） |
| P4 文档 | replay-rule-ai.md + README/overview 重写 + 旧基线 superseded 标记 | 人工复核 + smoke 终跑 + build:dist 产物验证（file:// 双击可用） |

每阶段独立提交；P2/P3 是风险集中段（panel.ts 大改），P3 结束前 smoke 保持改造后等价强度。

---

## 6. 风险与边界

1. **panel.ts 结构性重写**（1,036 → ~450 行）：一次到位风险高，P2 先删后重组、P3 再补新分区，两步各自可回滚。
2. **transform 后处理作用域**：按 RuleConfig 全局（导入时套用），已导入旧轨道不追溯——UI 提供"调整即重导当前轨道"，多轨道场景逐条重导；此语义写入帮助浮层与 AI 文档。
3. **裸 .js 与 RuleConfig JSON 的判定**：`JSON.parse` 成功且 `version===1` 走 JSON，否则按脚本源码；畸形输入报人话错误（沿用错误卡设计）。
4. **自家默认规则**：P3 实现时核对现有 sample 链路（panel.ts loadSample / probe）后固化为内置脚本常量，避免"无规则时自家录像导不进"回归。
5. **不新增功能红线之外**：播放控制 API 与 .js 载入属 D1/D6 明确要求的能力，其余不加（不做主题/向导/新持久化）。
6. **codegen 删除边界（审查 P0）**：只删 generateScript/PRESETS/applyPreset；`compileScript`/`probeScript` 被 parse-worker.ts:7 与 importer.ts:3 引用，整文件删除会断掉导入管线与 Worker。
7. **pose.ts 清理（审查补充）**：R7 后 `normalizePose` 失去唯一调用方（window.viewer.setPose），与 parsePoseParams 一并随删；`fly.setPose`（相机内部）与 `hud.setPose`（HUD 状态行）是不同符号，不受影响。
8. **transform.yawDeg 符号（审查补充）**：绕 Y 旋转对 pos/vel 的旋转方向与 ang yaw 增量必须对照 viewer 角度约定（yaw 0=−Z、逆时针为正）验证符号一致，test:replay 用例覆盖。
9. **播放控制 API 底层（审查确认无缺口）**：play/pause/stop、seek(秒，夹在 A-B 区间内 player.ts:125-130)、speed/mode/loop 公共字段、followTrack(id)（player.ts:88）均已存在，API 层薄封装即可；seek 的 A-B 夹取语义写入帮助与 API 注释。

---

## 7. 验收清单

- [ ] 量测相关代码/UI/断言全删，网格与坐标轴开关在地图页可用
- [ ] codegen.ts 保留 compileScript/probeScript，Worker 与导入链路完好；generateScript/PRESETS 已删
- [ ] `?pos=`/hash/`setPose`/`getPose` 全删且无残留引用（normalizePose/parsePoseParams 随删）；出生点跳转、初始出生点视角不受影响
- [ ] 标定/朝向诊断/表单编辑器/脚本编辑器/probe UI/预设下拉全删；录像页仅三区
- [ ] 拖/选/深链三种方式均可载入 .js 规则；自家格式无规则可导
- [ ] 变换调整：offset/yaw 生效、锚定到出生点生效、重导保轨道属性
- [ ] `viewer.replay` 控制方法全部可用且被 smoke 断言
- [ ] 多轨迹能力与两行式轨道卡共存；track-* 契约不破
- [ ] test:replay / test:smoke / build:dist 全绿；file:// 双击可用
- [ ] docs/replay-rule-ai.md 存在且含提示词模板；README/overview 与实际行为一致
