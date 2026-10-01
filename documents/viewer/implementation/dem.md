# implementation/dem：Source `.dem` 录像解析

> 覆盖 `apps/viewer/src/replay/demo/` 下四个模块与 `apps/viewer/src/replay/democlip.ts`：位流原语、发送表与类别表、网络消息与实体属性解码、录像顶层解析，以及 DEM→`Clip` 桥接。
> 上游格式依据：本地参考实现 `test/project/source-sdk-2013-master/src/public/`（`dt_common.h` 的标志与类型枚举、`demofile/demoformat.h` 的消息号与头布局）；行为判据全部来自本工程自检（`apps/viewer/test/replay-selftest.ts` 的 `.dem` 段）与真实夹具实测（`test/replay/auto-20261001-050330-surf_gigapede.dem`，对照工具 `test/replay/dem-probe.html`）。

---

## 模块职责

| 模块 | 职责 | 导出清单 |
|---|---|---|
| `apps/viewer/src/replay/demo/bits.ts` | 位流读写原语：小端优先的 `bf_read` 等价物，含 `uBitVar`、逐轴定点坐标、法线、变长整数 | `BitReader`（`apps/viewer/src/replay/demo/bits.ts:35`） |
| `apps/viewer/src/replay/demo/tables.ts` | `dem_datatables` 载荷：发送表、服务器类别表，以及「类别 → 展平属性序列」 | `PropType`（`apps/viewer/src/replay/demo/tables.ts:42`）、`SPROP`（`apps/viewer/src/replay/demo/tables.ts:53`）、`SendProp`（`apps/viewer/src/replay/demo/tables.ts:73`）、`SendTable`（`apps/viewer/src/replay/demo/tables.ts:93`）、`ServerClass`（`apps/viewer/src/replay/demo/tables.ts:99`）、`DataTables`（`apps/viewer/src/replay/demo/tables.ts:108`）、`classIdBitsFor`（`apps/viewer/src/replay/demo/tables.ts:116`）、`readSendTables`（`apps/viewer/src/replay/demo/tables.ts:144`）、`readServerClasses`（`apps/viewer/src/replay/demo/tables.ts:188`）、`readDataTables`（`apps/viewer/src/replay/demo/tables.ts:203`）、`FlatProp`（`apps/viewer/src/replay/demo/tables.ts:212`）、`FlattenOptions`（`apps/viewer/src/replay/demo/tables.ts:232`）、`flattenSendTable`（`apps/viewer/src/replay/demo/tables.ts:325`） |
| `apps/viewer/src/replay/demo/net.ts` | 网络消息流：消息号表、`svc_*` 各消息体（含 `svc_UserMessage` 的 SayText2 聊天解码）、`svc_PacketEntities` 的实体流与属性位图、属性值解码、类别基线 | `NetMsgType`（`apps/viewer/src/replay/demo/net.ts:51`）、`EntityProps`（`apps/viewer/src/replay/demo/net.ts:111`）、`DemoParseStats`（`apps/viewer/src/replay/demo/net.ts:113`）、`NetContext`（`apps/viewer/src/replay/demo/net.ts:170`）、`parsePacket`（`apps/viewer/src/replay/demo/net.ts:309`）、`readPropList`（`apps/viewer/src/replay/demo/net.ts:1378`）、`decodeProp`（`apps/viewer/src/replay/demo/net.ts:1431`）、`varIntMode`（`apps/viewer/src/replay/demo/net.ts:1536`）、`setVarIntMode`（`apps/viewer/src/replay/demo/net.ts:1539`） |
| `apps/viewer/src/replay/demo/demo.ts` | 录像顶层：文件头、消息链扫描、`dem_stringtables`、玩家名、位姿采样 | `DemoHeader`（`apps/viewer/src/replay/demo/demo.ts:30`）、`PlayerSample`（`apps/viewer/src/replay/demo/demo.ts:44`）、`PlayerTrack`（`apps/viewer/src/replay/demo/demo.ts:61`）、`DemoParseResult`（`apps/viewer/src/replay/demo/demo.ts:72`）、`DEMO_HEADER_BYTES`（`apps/viewer/src/replay/demo/demo.ts:115`）、`looksLikeSourceDemo`（`apps/viewer/src/replay/demo/demo.ts:131`）、`fileLooksLikeSourceDemo`（`apps/viewer/src/replay/demo/demo.ts:139`）、`readDemoHeader`（`apps/viewer/src/replay/demo/demo.ts:149`）、`DemoParseOptions`（`apps/viewer/src/replay/demo/demo.ts:179`）、`parseSourceDemo`（`apps/viewer/src/replay/demo/demo.ts:214`）、`readDemoStringTables`（`apps/viewer/src/replay/demo/demo.ts:450`）、`readPlayerNames`（`apps/viewer/src/replay/demo/demo.ts:638`）、`DemoStringTable`（`apps/viewer/src/replay/demo/demo.ts:648`）、`isPlayerClass`（`apps/viewer/src/replay/demo/demo.ts:743`）、`PlayerSampleDiag`（`apps/viewer/src/replay/demo/demo.ts:749`）、`newPlayerSampleDiag`（`apps/viewer/src/replay/demo/demo.ts:775`）、`samplePlayers`（`apps/viewer/src/replay/demo/demo.ts:849`） |
| `apps/viewer/src/replay/democlip.ts` | DEM→`Clip` 桥接：轨迹转 viewer 契约（含坐标/朝向口径、差分速度与元信息；`buttons` 恒为 null） | `DemoClipOptions`（`apps/viewer/src/replay/democlip.ts:29`）、`demoTracksToClips`（`apps/viewer/src/replay/democlip.ts:39`）、`trackToClip`（`apps/viewer/src/replay/democlip.ts:63`） |

## 关键流程与不变量

| 流程 / 不变量 | 说明 | 锚点 |
|---|---|---|
| 嗅探只看魔数 | `HL2DEMO\0` 八字节比较，是二进制判定、不做文本解码；导入器据此分流，未命中则走 `.replay` 路径 | `apps/viewer/src/replay/demo/demo.ts:131`、`apps/viewer/src/replay/importer.ts:189` |
| 文件头固定 1072 字节 | 协议 `demoprotocol` 与网络协议 `networkprotocol` 都在头里；头不足即报错 | `apps/viewer/src/replay/demo/demo.ts:115`、`apps/viewer/src/replay/demo/demo.ts:149` |
| 消息链分帧 | `[cmd u8][tick i32]`；`dem_signon`/`dem_packet` 再带 76 字节 `democmdinfo` + `seqIn i32` + `seqOut i32` + `len i32` + `len` 字节（协议 24 **没有**玩家槽字节）；`dem_datatables`/`dem_stringtables` 是 `len i32` + 载荷 | `apps/viewer/src/replay/demo/demo.ts:214` |
| 发送表位布局 | `[more 1][needsDecoder 1][名 串][numProps u10]`，属性 `[type u5][名 串][flags u16]` + 分支字段；`more = 0` 结束 | `apps/viewer/src/replay/demo/tables.ts:144` |
| 类别表位布局 | `[numClasses u16]` 后逐项 `[classId u16][类名 串][数据表名 串]` | `apps/viewer/src/replay/demo/tables.ts:188` |
| 展平顺序 | 先按表内顺序收集（子表在声明位置就地展开），再对 `SPROP_CHANGES_OFTEN` 做**引擎式交换**前置——交换式实测优于稳定分区 | `apps/viewer/src/replay/demo/tables.ts:325` |
| 排除对与数组模板 | `SPROP_EXCLUDE` 按「表名 + 属性名」成对排除；`SPROP_INSIDEARRAY` 的属性不占位，作为紧邻数组属性的元素模板挂在 `FlatProp.elementProp` | `apps/viewer/src/replay/demo/tables.ts:212`、`apps/viewer/src/replay/demo/tables.ts:325` |
| 包尾填充不算消息 | 剩余不足 6 位或剩余位全为 0 即视为包结束；漏掉这一条会把填充读成垃圾消息并放弃整包（实测：包成功率由 832/3438 提升到 3435/3438） | `apps/viewer/src/replay/demo/net.ts:309` |
| PE 后**没有**显式删除表 | `svc_PacketEntities` 的实体载荷恰好结束在头部声明的 `dataBits` 上，其后是字节对齐填充或下一条消息；此前按 tf2 系解析器恢复的「`1`+11 位实体号、遇 `0` 结束」删除表在本协议上是净多读——真实夹具 59,951 包实测：读表 24,378 包中止、不读 2 包。实体删除由记录内 `FHDR_DELETE` / LeavePVS 标志表达 | `apps/viewer/src/replay/demo/net.ts:1205` |
| 文本消息两条来源 | `svc_Print` / `svc_StringCmd` / `svc_Disconnect` 一条；`svc_UserMessage` 的 **SayText2**（CS:S 用户消息号 4，玩家聊天与 SourceMod 的连接/掉线/计时播报走它）另一条——按「控制字节边界 + UTF-8」解出可读文本（`\x07`+6 字节颜色码丢弃），进同一个 `chatLines`（上限 4000）。实测 surf_gigapede 夹具：前一类 0 条、SayText2 40 条 | `apps/viewer/src/replay/demo/net.ts:355`、`apps/viewer/src/replay/demo/net.ts:103` |
| 实体流头 | 实体号 = `基准 + 1 + uBitVar`（基准初值 −1，每条更新）；随后 1 位 `0` = 非 LeavePVS → 再 1 位（`1` = EnterPVS），`1` = LeavePVS → 再 1 位（`1` = 删除） | `apps/viewer/src/replay/demo/net.ts:1022` |
| 进入 PVS 两段式 | 先读 `classId`（`Q_log2(类别数) + 1` 位）与序号（10 位），再把该类 `instancebaseline` **整表**套给实体，最后叠本帧 delta | `apps/viewer/src/replay/demo/net.ts:1022` |
| 属性位图 | 每项：`1` 位「还有属性」+ `uBitVar`（下标推进 `1 + 差值`）；读到 `0` 位结束。文档里的「3 位 0 游程」是 CS:GO 方案，协议 24 没有 | `apps/viewer/src/replay/demo/net.ts:1378` |
| `SPROP_VARINT` 是 LEB128 | 逐字节 7 位小端变长整数，**不是** `uBitVar`。判据：7 条类别基线全部逐位吻合、`m_iHealth` 解出 100 量级；换 `uBitVar` 则只剩 6/7 且生命值变成 20 亿量级 | `apps/viewer/src/replay/demo/net.ts:1536`、`apps/viewer/src/replay/demo/net.ts:1431` |
| `SPROP_COORD` 向量逐轴 | `DPT_Vector` 带 `SPROP_COORD` 时是三轴各一次定点坐标，**没有**「三轴存在位」——与 `WriteBitVec3Coord` 不同，逐轴用类别基线实测判定 | `apps/viewer/src/replay/demo/net.ts:1431` |
| 量化浮点 | `low + raw / (iHigh / (high − low))`；`numBits <= 0` 或 `>= 32` 表示不量化、直读 32 位浮点 | `apps/viewer/src/replay/demo/net.ts:1431` |
| 同名属性双写 | 玩家类有两份 `m_vecOrigin`（`DT_CSLocalPlayerExclusive` 的 `SPROP_NOSCALE` 版只发给本人、`DT_CSNonLocalPlayerExclusive` 的 `SPROP_COORD` 版发给其他观察者），故同时按「名」与「名#扁平下标」存，取值优先选带 `SPROP_COORD` 的那份 | `apps/viewer/src/replay/demo/net.ts:1378`、`apps/viewer/src/replay/demo/demo.ts:849` |
| 字符串表是独立位流 | `dem_stringtables` 不是网络消息：`[u8 表数]` + 每表 `[名 串][u16 条目数]` + 每条目 `[键 串][1 位 有无值][有值则 u16 字节数 + 原始位]` + 表尾 1 位 | `apps/viewer/src/replay/demo/demo.ts:450` |
| 玩家名映射 | `userinfo` 条目键是**槽号**十进制串，值是 `player_info_s`（名字在偏移 0、NUL 结尾、最长 32 字节）；实体号 = 槽号 + 1 | `apps/viewer/src/replay/demo/demo.ts:638` |
| 位姿采样两种口径 | `'players'` 只采玩家类且必须有朝向；`'posed'` 采任何有世界坐标的实体、朝向缺失记 0 | `apps/viewer/src/replay/demo/demo.ts:849` |
| 桥接坐标与朝向口径 | 与 Shavit 路径一致：`[x,y,z] → [y,z,x]`、`yaw = wrap(yaw + 180)`、`pitch = −pitch` 并限幅、`roll = 0` | `apps/viewer/src/replay/democlip.ts:63` |
| tick 间隔来源 | 头部不记 tick 率，由「播放时长 ÷ 总 tick 数」推出 | `apps/viewer/src/replay/democlip.ts:63` |
| `.dem` 无按键显示 | `Clip.buttons` 恒为 null 且**不做运动学反推**（owner 裁定）：`dem_usercmd` 只含录制者本人的输入（观察者/SourceTV 录像实测 0 条），其他玩家的原始按键不在文件里；按键簇只在 `.replay`（真实按键）路径点亮 | `apps/viewer/src/replay/democlip.ts:63`、`apps/viewer/src/app.ts:756` |
| 多 clip 导入 | `ImportResult.clips` 可承载多份；面板逐份建轨道（首份替换、其余追加）；DEM 分支在主线程执行、不经 Worker | `apps/viewer/src/replay/democlip.ts:39`、`apps/viewer/src/replay/importer.ts:189` |

## 已知缺口

1. **实体流的「条数」与「记录边界」尚未定死**（当前最大缺口）。实测链条（夹具 `test/replay/auto-20260925-171855-surf_fornax.dem`）：
   - 头部那个 11 位字段在一条 64 位载荷上读出 1，而该载荷穷举后恰好是**四条实体头 + 1 位收尾 = 64 位**；大消息上按该字段只能读约 5 条、按声明长度能读约 65 条 ⇒ **它不是实体条数**。
   - 按「读到声明长度为止」（`NetContext.entityLoopMode = 'untilEnd'`，收尾判据为「剩余位不足一条最小实体头 8 位」）后，残差从 `1139 位 / 585 种` 塌缩到 `±1～6 位 / 52 种`，恰好用尽的消息从 0 条升到 354 条 —— 但包解析率会从 3435/3438 掉到 1377/3438，故该口径**不能直接转正**（缺省仍是 `'count'` + 越界中断）。
   - 首次实体号越界定位到「包 4 消息第 43 条，实体号 640」；其前 42 条记录实体号 **0→152 严格递增**、位区间自洽；`26137..26303` 共 167 位经逐位对账**缺口为 0**（含 EnterPVS 的类别号 8 位 + 序号 10 位、属性下标编码 7 位）；152 号处位确为 `000000 1 0`（LeavePVS、不删除）；实体 150/151 的 `m_vecOrigin` 位宽（42 / 52 位）与 `coord()` 规则逐位算得上。
   - **`length`（20 位）的单位是「位」而非「字节」**：该消息载荷 42930 位、不是 8 的倍数；64 位样本上 `length = 64`、载荷恰 64 位、走完恰好 64 位，三方自洽。
   - 载荷尾部只有 **3 个连续 0**，几乎没有对齐填充 ⇒ 不存在「尾部大段 padding、循环应早停」这类解释。
   ⇒ **位消耗已接近正确，实体头字段构成仍未定**（它决定实体号，而位消耗对多读/少读几位不敏感，会被属性列表的「读到 0 结束」吸收）。诊断入口：`DemoParseStats.entityResidual` / `entityResidualFull` / `entityResidualUpd1` / `entityPayloadExact`；逐项留痕为 `[OVF]`（首次越界，保留最后 12 条记录）与 `[ITEMS]`（越界附近的属性位区间）。
2. **包内 `svc_CreateStringTable` 只稳定解出第一张表**：`dem_stringtables` 那份是完整可信的（19 张表、终点距载荷末尾 5 位），但网络消息流里的同名消息在第二张表起偏移（`NetContext.stringTables` 实测只拿到 `downloadables`）。玩家名与类别基线都取自 `dem_stringtables`，因此该缺口不影响位姿与命名。
3. **`svc_CreateStringTable` 的压缩标志未实现**：`NetContext.readCompressedFlag` 缺省关闭（实测 CS:S 的报文里没有该位），若将来遇到置位样本会整段跳过并记 warning。
4. **`svc_UpdateStringTable` 只对 `userinfo` 解条目**：条目流布局在 `userinfo` 上按实测钉死（下标 1+4 位、有无文本 1 位、签入段建的表多 5 位、有无值 1 位、长度 10 位），并入前经「像玩家名」校验防污染；**其它表仍只按长度跳过**。真人玩家名依赖这批更新（签入期 `userinfo` 通常只有 SourceTV 录制机器人一个槽位）；部分条目 userdata 整体错位，展示层按「最长可打印段」清洗（`apps/viewer/src/replay/demo/demo.ts` 的 `cleanPlayerName`）。
5. **`svc_GameEvent` 只按长度跳过**：游戏事件真实存在（真实夹具 232 条），但描述符表（`svc_GameEventList`）未保存、事件内容不解——`weapon_fire` 之类的输入/战斗事件拿不到。对照工具 `test/replay/dem-probe.html` 里已验证描述符表的位布局可行，接上即可解。
6. **诊断开关仍留在代码里**：`NetContext` 上有一组用于逆向期对照的开关（`classIdBitsOverride` / `enterSerialBits` / `preClassBits` / `postClassBits` / `maxEntriesBits` / `updatedEntriesBits` / `headerBaseInit` / `entityIndexPlusOne` / `breakOnEntityOverflow` / `entityLoopMode` / `flattenOptions.mergeVectorElems` 等），生产路径全走缺省值；其中 `mergeVectorElems` 已被判据**驳回**（开启后玩家实体的 `m_iHealth` 解不出），保留作对照。
7. **`untilEnd` 口径的性能**：真录像前 4 MB 需要约 75 秒（缺省 `count` 口径约 0.3 秒），因为前者要解约 100 万条实体、后者只解 7.6 万条。单条约 27 µs 落在属性值解码上；已把「基线整表复制」改为惰性兜底（`effectiveProp`），但实测总耗时未变，瓶颈待查。
8. **无玩家运动样本已解决**：`test/replay/auto-20260925-171855-surf_fornax.dem`（32 MB / 3598 s）里 `CCSPlayer` 确实在下发 `m_vecOrigin`（扁平下标 13/14）与 `m_angEyeAngles`（15/16）；`'players'` 口径因朝向极少下发常常采不到轨迹，导入器逐级回退 `'playerPosed'` / `'posed'` 后可采出（自检 `.dem` 段「采出轨迹 ≥ 1」即按此验证，真实夹具 surf_gigapede 采出多条并播放入 UI）。
