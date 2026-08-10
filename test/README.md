# WebSurf-test — 单模 1ms 物理 + OffscreenCanvas 渲染时序验证工程

> 目的：按"主线程仅输入转发/UI → SAB 无锁（含 WAKEUP 唤醒 + 双缓冲状态槽）→ WorkerA 单模
> 1ms 物理（自驱）→ WorkerB OffscreenCanvas 渲染（frame 驱动 + 抽帧）"的最新时序图，
> 验证一套独立的输入→物理→渲染循环。
> 仅保留基本 WASD + 鼠标视角，无面板/功能扩展。

---

## 一、当前实际核心操作渲染时序（2026-08-09 现状，debug/game v7）

从用户输入到实际画面的完整循环（当前实现）：

```
硬件(mousemove/按键) → 浏览器事件 → 主线程:
  rAF 每帧:
    1. 输入采集: mousemove → MouseBuffer.process(discardNext + CLAMP@1000)
       → 灵敏度输入层 layerMouseDelta(dx,dy,sensitivity) → Q/E 等效像素并入
    2. shared.addInput(dx, dy, keysMask)  → SAB 输入槽（BigInt64 原子累加）
    3. correctFromAuthority(): 读权威帧（V_A 双缓冲 (V_A-1)&1）→ 首次 set_state /
       大偏差（三条件 OR + 250ms 冷却 + 在途回滚）兜底
    4. calibrateVelocity(): set_velocity(权威速度 + 加速度×Δt) 外推（只动速度不动角度）
    5. predPhys.tick(dt, keys, dx, dy)  ← 主线程唯一物理渲染线（可变 dt 单步，上限 0.1s）
    6. take_event(): 传送/死亡事件消费（计时挑战检查点/回退）
    7. 渲染: 相机 = state().pos + eyeHeight（度→弧度）→ LOD/PVS/Fog → renderer.render()

Worker（权威帧计算器, 共享 ts-shared/auth）:
  setTimeout(4ms) 自驱:
    acc += 墙钟差; while (acc >= 1/tickRate && guard<64):
      takeInput(maxStep) → PhysWorld.tick(固定步长) → 碰撞事件(land/blocked) → 写权威双缓冲 V_A++
```

**当前关键点**：物理在主线程（渲染用同一实例），Worker 提供权威校准；主线程同时做输入+物理+渲染。

## 二、各部分功能与踩过的坑

| 部分 | 功能 | 踩过的坑 |
|---|---|---|
| 共享内存 SAB（512B） | 控制区 V_A/keys/A_GROUND + BigInt64 输入槽 dxAcc/dyAcc + 权威双缓冲 | ①早期 lock/seq 协议 → 改 V_A 双缓冲 release/acquire 免锁；②MsgState 回退（file:// 无 COOP/COEP） |
| 主线程物理线 | 每 rAF 真 tick 渲染直读 | ①可变 dt 单步在 rAF 长帧（视频卡顿）下重力/加速漂移——试改固定步长累积器**用户实测更卡**（长帧补步拖慢渲染）已撤回；②输入 dx/dy 需在累积器拆步时均分（未采用） |
| 权威校准 | 速度外推 set_velocity、三条件兜底同步、碰撞事件微调 | ①三条件/250ms 冷却/在途回滚防抖动；②权威角度仅经碰撞事件回传（角度隔离） |
| Worker 权威 | setTimeout 4ms 自驱固定步长 | 4ms 轮询粒度 > 1ms 物理子步，高帧率下权威滞后 |
| 传送检测 | A 竖直线段-凸包区间 + B 落地脚底 8 | 多轮迭代：StartTouch 边沿/竖直射线/凸包顶点/AABB/投影全废弃，最终简化 A+B；斜面 gap=落地&&斜面?64:0；surfing 不触发 |
| 近平面/准星 | 4 方向探测、CSS transform 对称 | 6 方向→4 方向（性能）；准星不居中/歪斜（容器 transform 缺失 + 半像素） |
| 碰撞可视化 | 4 开关+4 距离滑块 | 透明材质 alpha 混合染绿 → 不透明+depthTest:false |
| 空中蹲 | 收脚 origin±18、duck_frac 空中预置 | 多轮：origin 位移方向、落地相位、跨斜面 origin 提升 |

## 三、最新时序设计（本工程实现目标，2026-08-10 全面改造）

```mermaid
sequenceDiagram
    participant Hardware as 硬件层 (1ms 输入)
    participant Kernel as 浏览器内核 (蓄水池)
    participant Main as 主线程 (仅输入转发/UI)
    participant SharedMem as 共享内存 (SAB无锁通信)
    participant WorkerA as WorkerA (单模 1ms 物理)
    participant WorkerB as WorkerB (渲染/OffscreenCanvas)
    participant GPU as GPU硬件

    Note over SharedMem: 布局: TICK_RATE / WAKEUP(物理背压) / RENDER_WAKEUP(渲染帧对齐) / 输入槽(dx/dy/keysMask) / 双缓冲 S[2] / V(版本号)

    rect rgb(240, 248, 255)
        Note over Main, WorkerA: === 阶段0: 动态难度调节 ===
        Main->>SharedMem: Atomics.store(TICK_RATE, 新值)   （仅 store，无 notify）
        Note over WorkerA: 下一轮循环自动识别新 DT
    end

    rect rgb(255, 248, 240)
        Note over Hardware, Main: === 阶段1: 输入转发 (每 rAF) ===
        loop 每1ms硬件信号
            Hardware->>Kernel: 推送原始增量位移
            Kernel->>Kernel: 内核级队列缓存 (不触发JS)
        end
        Main->>Main: 提取全部未处理输入 (无上限)
        Main->>SharedMem: Atomics.add(输入槽, 总增量)
        Main->>SharedMem: store(WAKEUP,1)+notify(WAKEUP,1)   （WorkerA 物理背压唤醒——专用槽）
        Main->>SharedMem: store(RENDER_WAKEUP,1)+notify(RENDER_WAKEUP,1)   （WorkerB 渲染唤醒——主驱动为 WorkerA 发布 notify，此处为帧对齐冗余）
    end

    rect rgb(240, 255, 240)
        Note over WorkerA, SharedMem: === 阶段2: 单模 1ms 物理循环 (自驱) ===
        loop 自驱循环 (MessageChannel 自投递续环, 永不阻塞主线程)
            WorkerA->>WorkerA: delta = clamp(实际间隔, 0, 50ms)
            WorkerA->>WorkerA: 累加器 += delta
            alt 累加器 >= 1ms
                loop 最多执行 8 次
                    WorkerA->>SharedMem: CAS 消耗输入 (限幅 ±1000 防穿墙)
                    WorkerA->>WorkerA: WASM 物理步进 (1ms 子步) phys.tick(0.001, ...)（tick_into 零分配）
                    WorkerA->>SharedMem: 写入空闲槽 (S[V&1^1]，不覆盖读槽) + Atomics.add(V,1)
                    WorkerA->>SharedMem: Atomics.notify(RENDER_WAKEUP,1)  （发布驱动：唤醒 WorkerB 渲染循环——渲染率 = 物理发布率）
                    WorkerA->>WorkerA: 累加器 -= 1ms
                end
                Note over WorkerA: 上限耗尽**保留剩余累加**（时间不丢失下轮补跑），仅封顶 50ms 防无限追赶
            alt 剩余空闲时间 > 1ms
                WorkerA->>SharedMem: Atomics.wait(WAKEUP, 0, 剩余时间)  （物理背压专用槽——与 RENDER_WAKEUP 分离，可被阶段1 notify 唤醒）
                WorkerA->>SharedMem: Atomics.store(WAKEUP, 0)  （复位）
            else 剩余时间 <= 1ms
                Note over WorkerA: 继续自旋
            end
        end
    end

    rect rgb(255, 240, 245)
        Note over WorkerB, GPU: === 阶段3: 渲染采样与重绘 (OffscreenCanvas, 发布驱动) ===
        loop 自驱（MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)）
            Note over WorkerB: 主驱动 = WorkerA 每发布状态 notify → 立即采样/重绘
            Note over WorkerB: 渲染率 = 物理发布率（无 BSP 全速 1kHz；重场景渲染耗时自然节流）
            Note over WorkerB: 主线程 wake 为帧对齐冗余；20ms 超时兜底（物理/主线程停摆不冻结）
            WorkerB->>SharedMem: Atomics.load(V)
            alt V 已更新
                WorkerB->>SharedMem: 读当前槽 S[V&1] 最新物理状态
                WorkerB->>WorkerB: 更新本地缓存 + 标记需要重绘
            end
            opt 需要重绘（V 未变不重绘——高频屏不重复渲染相同状态）
                WorkerB->>WorkerB: 构建 Draw Calls（相机 = 本地缓存）
                WorkerB->>GPU: OffscreenCanvas 提交命令
            end
        end
    end

    rect rgb(245, 245, 255)
        Note over Main, WorkerA: === 阶段4: 特殊事件 (Respawn) ===
        Main->>WorkerA: postMessage({type:'respawn'})
        WorkerA->>WorkerA: WASM 立即重置物理状态
        WorkerA->>SharedMem: 写入新状态到空闲槽 (S[V&1^1])
        WorkerA->>SharedMem: Atomics.add(V, 1)
    end

    rect rgb(255, 250, 240)
        Note over Main, SharedMem: === 前置条件 (启动前) ===
        Note over Main: crossOriginIsolated && SharedArrayBuffer 支持
        Note over Main: 满足 → 共享内存模式（上图全部通道）
        Note over Main: 不满足 → **消息回退模式**：输入/难度经 postMessage（main→WorkerA）、
        Note over Main: 状态发布经 WorkerA↔WorkerB 直连 MessageChannel（shared-state 载荷）；
        Note over Main: V 版本/仅状态更新重绘/限幅语义全部等价，功能不停摆（HUD 提示通道模式）
    end
```

## 四、工程结构

```
test/
  index.html          入口（canvas 转发 + file input 加载 .bsp + 难度按钮 + HUD）
  package.json        构建脚本（wasm + esbuild，依赖 three）
  crates/wasm/        薄导出层（path 依赖共享 src/phys + src/wasm-core：
                      PhysWorld + BspProcessor（metadata/brushes/tri/phy/teleport/spawn/GLB））
  pkg/                wasm-pack 产物
  src/
    shared-state.ts   SAB 布局：TICK_RATE / WAKEUP(物理背压) / RENDER_WAKEUP(渲染帧对齐) /
                      输入槽(dxAcc/dyAcc/keysMask) / 双缓冲 S[2]（每槽 pos×3/vel×3/yaw/pitch）+
                      V；wake（双槽 store+notify）/ waitWakeup / waitRenderWakeup /
                      consumeInput(限幅) / writeStateRaw(零分配标量直写) / readState(读当前槽)；
                      **消息回退模式**（无 SAB：createMessaging/initMessaging/
                      initMessagingRender——同一 API 双实现，输入/难度/状态经 postMessage）
    main.ts           主线程：前置条件检测（满足 → SAB 模式；不满足 → 消息回退模式，
                      不再停止）→ 输入捕获（mousemove/键盘累积）→ rAF 输入转发
                      + wake()（双槽通知：WAKEUP→WorkerA 物理背压 + RENDER_WAKEUP→WorkerB
                      帧对齐）+ frame 帧信号；写 TICK_RATE（仅 store）；respawn；
                      BSP 加载（文件选择 → BspProcessor 导出 → world-json → WorkerA / glb transfer → WorkerB）；
                      **路径记录按钮（trace）**：状态机 开始 → 保存（路径保留显示）→ 删除
                      （清空）→ 开始 循环——WorkerA 回传 3D 节点 → 转发 WorkerB **3D 场景
                      绘制两条空间路径线（绿=无限制基准 / 红=tick 实际）**；兜底事件计数显示
    worker-a.ts       WorkerA 单模 1ms 物理核心（delta clamp 0~50ms / 8 次子步上限 /
                       上限耗尽保留累加（时间不丢失）仅封顶 50ms / **tick_into 零分配热路径**
                       （状态写 wasm 固定缓冲 → state_out_ptr 的 Float64Array 视图直读 8 标量
                       → writeStateRaw 直写 SAB，每子步零 JS 对象）/ **模式B 64t 键位采样 +
                       1ms 物理**（phys 本身即"64t 键位采样 + 1ms 物理 + 实时鼠标"：键位输入
                       按 1/TICK_RATE 采样快照（起跳/移动/松键延迟 ≤1 tick——连跳显著低于
                       基准）、鼠标 dx/dy 实时（角度平滑）；**无独立权威实例/无速度拟合/
                       无兜底**——快照 dx 导致角度/速度方向每 tickDt 突变 → 移动抽动卡顿
                        （physAuth 方案已弃用）；**TICK_RATE≥1000 跳过防双倍物理**）/
                        **路径记录（trace）**：记录模式下维护 physBase 对照实例（实时键位=
                        无限制基准）与 phys（采样键位=tick 实际）同输入推进，每 100ms 回传
                        位置节点（按钮开启才记录/发送）/
                        输入限幅 ±1000 /
                       背压 wait(WAKEUP 专用槽) + CAS 复位 / MessageChannel 自投递续环——
                       免 setTimeout 嵌套 4ms 钳制，轮询率回 1ms 设计频率；
                       **消息回退模式**（init-msg：renderPort 直连 WorkerB，shared-input/
                       shared-tick-rate 消息 → 本地累加，waitWakeup 立即超时返回）；
                       world-json → build_world（set_hull 16/72/54 + set_death_y(brush minY−100)）
    worker-b.ts       WorkerB three.js 第一人称渲染（自驱：**发布驱动**——MessageChannel
                       自投递 + waitRenderWakeup(RENDER_WAKEUP)，主驱动 = WorkerA 每发布
                       状态 notify（渲染率 = 物理发布率，无 BSP 全速 1kHz；重场景渲染耗时
                       自然节流），主线程 wake 帧对齐冗余，20ms 超时兜底）；
                       采样 → 仅状态更新时重绘（V 未变不提交 Draw）→ 相机 = pos + 眼高 64.09，
                       rotation = pitch/yaw 度→弧度 YXZ → WebGL 提交；GLB 挂载 + status 摘要回传
                       main DOM HUD；**消息回退模式**（init-msg：renderPort 直连 WorkerA，
                       shared-state 到达即缓存，readState 消费））
  scripts/
    build-dist.mjs    构建（multi 外置，HTTP 运行）
    phys-smoke.mjs    node 冒烟测试（时序协议 + BspProcessor 导出 + surf_666 真实世界构建/物理）
```

**世界构建**：WorkerA 用简单手工 brush JSON（地面 + 少量斜坡）调用 `PhysWorld.build_world`，
不依赖 BSP 地图文件（聚焦时序验证）。视角 = 鼠标增量 → 输入槽 dy/dx → WorkerA 物理 tick
内 apply_input（yaw/pitch 由物理更新）→ 状态槽输出角度 → WorkerB 相机。

## 五、实现状态（2026-08-10 性能修复 + 消息回退 + 发布驱动 + WorkerB 节流 + trace 3D + 出坡修复 + surf/垂直落坡动量转换/运动差别统计校验后，184/184 PASS 校验）

| 校验点 | 实现 | 状态 |
|---|---|---|
| 前置条件：crossOriginIsolated + SAB 支持 | main.ts 启动检测：满足 → 共享内存模式（SAB 无锁通道）；**不满足 → 消息回退模式**（postMessage 等价传输，功能不停摆，HUD 提示通道模式） | ✅ |
| SAB 布局：TICK_RATE / WAKEUP / RENDER_WAKEUP / 输入槽 / 双缓冲 S[2] / V | shared-state.ts 偏移常量 + SHARED_BUFFER_SIZE=192B（V 递增用 add；RENDER_WAKEUP 占原保留槽 Int32 [7]） | ✅ |
| **消息回退模式（无 SAB 环境自适应）** | TestShared 同一 API 双实现：msg-main（主线程 addInput/writeTickRate → postMessage）+ msg-physics（consumeInput 本地累加 / writeStateRaw 本地 V++ → 直连端口投递 shared-state）+ msg-render（readState 返回缓存，V 未变返回 null——重绘判定与 SAB 一致）；waitWakeup/waitRenderWakeup 立即超时返回（MessageChannel 自投递自驱）；wake 无操作 | ✅ |
| 阶段0 动态难度（仅 store 无 notify） | writeTickRate 仅 Atomics.store（消息回退 → shared-tick-rate 投递）；唤醒职责移交 WAKEUP/RENDER_WAKEUP 双槽 | ✅（旧 store+notify 已移除） |
| 阶段1 输入转发：add → wake()（**双槽分离**） | main.ts rAF：addInput → wake()（store(WAKEUP,1)+notify(WAKEUP,1) 唤醒 WorkerA 物理背压；store(RENDER_WAKEUP,1)+notify(RENDER_WAKEUP,1) 唤醒 WorkerB 帧对齐——两槽独立，物理背压的 CAS 复位不再抢渲染唤醒/拖延帧边界） | ✅ |
| 阶段2 单模 1ms（删除旧模式B 双模） | worker-a.ts：delta clamp 0~50ms；acc>=1ms 时 loop 最多 8 次子步；**上限耗尽保留剩余累加（时间不丢失、下轮补跑），仅封顶 50ms 防无限追赶**（原 acc=0 丢弃会永久丢失模拟时间，V 发布率跌穿 1kHz 无法回升） | ✅ |
| 子步热路径**零分配**（tick_into 直写 wasm 缓冲 → SAB） | phys.tick_into() 把状态写进 wasm 固定缓冲 state_out（不构造 wasm→JS 对象）→ state_out_ptr 的 Float64Array 视图直读 8 标量 → shared.writeStateRaw 标量直写 SAB——每子步零 JS 对象分配（原每子步构造 1 个 11 属性 JS 对象 + GC 压力） | ✅ |
| 模式B **64t 跳跃采样 + 移动实时 + 1ms 物理** + **去重**（TICK_RATE≥1000 跳过） | **键位分离采样**：跳跃位（0x10）按 1/TICK_RATE 采样快照（起跳延迟 ∈(0, tickDt]，loAcc **保留余数**网格精确对齐——32/64/128 延迟单调；落地后起跳延迟 → 摩擦损失累积 → **连跳速度显著低于基准 = 真实低 tick 难度**）；**移动位（WASD 0x0F）保持实时**——持续移动方向即时响应，随机运动下无方向错位累积漂移（整键位采样会延迟 WASD ≤1 tick → 每次输入切换产生位置偏差且累积——"拟合漂移"根因）；鼠标 dx/dy 保持 1ms 实时（角度平滑）；**随机运动拟合校验**（大平面 + 不定时同时转向/WASD/偶发跳跃）：32tick 平均偏差 3.59（无限制基准 vs tick 实际）、无系统性漂移（前 3.07/后 7.22）、**位置兜底仅偶发触发（30s 内 3 次）**——路径拟合良好；单跳顶点 57.03 全档一致；**出坡校验（可调水平速度）**：速度标定单调、各 tick 档位与基准严格一致；tickDt ≤ 1ms 时跳过防双倍物理 | ✅ |
| 消耗输入限幅（±1000 防穿墙） | consumeInput(maxDelta=±1000) 与 game 输入层 CLAMP 一致，注释说明防穿墙 | ✅ |
| 双缓冲写空闲槽（S[V&1^1]）+ V add | writeStateRaw/writeState 写当前 V 的另一槽（不覆盖读槽）→ Atomics.add(V,1) | ✅ |
| 背压：wait(WAKEUP,0,timeout) + 复位（**WorkerA 专用槽**） | waitWakeup 挂起 WAKEUP 槽（与 RENDER_WAKEUP 分离，物理背压不干扰渲染帧对齐），'ok'/'not-equal' 时 CAS 消费复位，'timed-out' 保留窗口内新唤醒给下轮；剩余<=1ms 自旋 | ✅ |
| 自驱续环：MessageChannel 自投递消息（免定时器嵌套 4ms 钳制） | WorkerA loop() 末尾 port2.postMessage(null) → port1.onmessage → loop()；消息任务无 4ms 最小延迟，轮询率回 1ms 设计频率（V 连续发布），respawn/world-json 消息照常投递。**WorkerB fallback 帧循环同法**（见下行） | ✅ |
| 阶段3 渲染自驱（**发布驱动** + **自适应超时节流**） | worker-b.ts：MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)——①主驱动 = WorkerA 每发布状态 notify（writeStateRaw → V++ → notify；无 BSP 轻负载全速 1kHz，**不受显示刷新率限制**；有 BSP 重场景渲染耗时自然节流——渲染期间错过的 notify 不积压，醒后只渲染最新状态）②主线程 wake 帧对齐冗余 ③超时兜底**自适应**：有数据（重绘）→ 20ms；无数据/重复参数（V 未变不重绘）→ **100ms 长超时**（降低无效唤醒/空转——性能优化；**发布 notify 不受超时影响，数据源源不断更新时立即唤醒全力渲染**）；消息回退模式无数据 → **100ms 低频自检**（shared-state 到达时立即触发循环——响应及时）→ readState：V 更新 → 刷新本地副本 + 重绘；**V 未变不重绘**（HUD「重绘/s」= 真实渲染帧率） | ✅ |
| 渲染帧率（不受 TICK_RATE / 显示刷新率限制） | 仅随状态更新重绘：物理 1kHz 发布时渲染 1kHz（HUD 重绘/s ≈ 1000，无 BSP 时页面显示帧率可跑满物理发布率；120Hz 屏实际 present 受 vsync 封顶但渲染提交不再被限 120）；TICK_RATE 只影响 WorkerA 手感速度修正 | ✅ |
| 阶段4 Respawn | R 键 postMessage → phys.respawn() → writeStateFromPhys（写空闲槽 + add(V,1)） | ✅ |
| 读状态防撕裂（double-check） | readState 读当前槽 S[V&1]，重读 V 校验，不一致以新版本重读（最多 2 次） | ✅ |
| **路径记录（trace）**——3D 场景路径线 + 状态机循环 + **软硬双级校正** | 按钮状态机 **开始 → 保存（路径保留显示）→ 删除（清空）→ 开始** 循环（防内存溢出：仅"开始"记录时 WorkerA 发送节点，节点滚动窗口上限 2000）：WorkerA 记录模式下维护**对照实例 physBase**（实时键位 = 纯 1ms 无限制基准）与 phys（跳跃采样键位 = tick 实际）同输入推进，每 100ms 回传**3D 世界坐标节点**（x/y/z）→ main 转发 → **WorkerB 场景中绘制两条空间路径线（绿=无限制基准、红=tick 实际）**；**偏差双级管理**（数据分析迭代）：①**软校正**——偏差 ∈(20,50] 时 physBase 位置向 phys 渐进收敛 50%（消除跳跃采样延迟的偏差累积）②**硬兜底**——偏差 >50 时 physBase 拉回 phys + 兜底事件（图例计数）——**复杂运动兜底压缩至 1% 内（实测 0.1%：1 次/1200 节点）**；关闭难度两路径完全重合、32tick 平均偏差 18.4（有界拟合） | ✅ |

**测试**：`node scripts/phys-smoke.mjs` — **176/176 PASS**（不含工作区梯子 WIP 测试），覆盖：双缓冲槽切换与交替写 /
writeStateRaw 零分配直写（与 writeState 同语义）/ V 递增用 add（写 N 次 V 增 N）/
WAKEUP 协议（wake 后立即返回、超时返回、复位、双槽残留消费、writeTickRate 不触碰）/
**RENDER_WAKEUP 协议（wake 双槽同置位、waitRenderWakeup 立即返回/超时/复位、双槽隔离——
WorkerA 消费 WAKEUP 后渲染唤醒仍保留）** / **发布驱动（worker_threads 真线程：writeStateRaw
发布 → V++ → notify 唤醒挂起渲染循环，非超时——渲染率 = 物理发布率）** /
8 次子步上限（delta=20ms → 8 次；上限耗尽保留剩余累加 12ms、累加器封顶 50ms）/
热路径（tick() 返回值直写状态槽）/ **tick_into 零分配热路径（state_out 视图与 state() 一致；
tick_into→writeStateRaw 全链路）** / **物理引擎数值校验（方向对称性、重力精确 ½gt²、摩擦
指数衰减、加速稳态、autobhop、bhop_speed_clamp、空中加速、蹲伏、急停、参数化 gravity、
noclip）** / **WorkerB 节流校验（自适应超时 V 未变 20→100ms 降空转、数据不断每轮重绘全力
渲染、消息回退无数据低频自检 + 数据到达立即触发）** / **trace 状态机 + 节点管理（开始→保存
→删除→开始循环；3D 坐标累积/窗口上限/删除清空）** / **复杂随机运动校验（8 行为池——加速/
大幅转向/绕圈/连跳/快速点按/斜向/后退/急停随机组合：关闭难度两路径完全重合、32tick 平均
偏差有界 <25、无系统性漂移、**位置兜底压缩至 1% 内（软校正 + 硬兜底双级）**、多种子兜底 <3
（1% 内））** / **斜坡滑行（surf）速度加成校验（贴坡 + F+A 斜向滑动 → **贴坡投影修复后**：
贴坡沿坡面匀速 ≈265（速度平行坡面 v=(−177,+88,−177)）→ 出坡带 vy 斜上飞出 → 空中抛物峰值
≈560（窗口峰值 >400 大幅加成）；tick 无影响——各档位与基准一致、偏差 0；上坡贴坡爬升受引擎
walk_move 限制不成立——如实记录）** / **垂直落坡 + 视角从外往里收 → 动量转换 → 离坡飞行统计
（600 高垂直落 → 空中峰值 vy≈−917（垂直动量）→ 撞坡 clip 转坡面切向（vz 弹射 +344、vy −172
——平行坡面 0.894vy+0.447vz≈0）→ yaw 30→0 收拢斜上爬 → 出坡瞬间 vy≈+125=0.5|vz|（**引擎
修复：walk_move 贴坡 vy 强制 0 改为 categorize 贴地投影（CS:GO 模型）——平地法线 y>0.999
等价原行为零回归、坡面保留沿坡分量——修复前出坡必水平/飞行高度恒 0/坡顶尖角钉死）** → 斜上
飞出：飞行高度 +9.8、水平距离 259.5；tick 无影响——输入仅移动位实时 + 鼠标实时、无跳跃采样，
32/64/128/256 与基准离坡速度/飞行距离/高度逐项 Δ<0.001）** / **无限制 vs tick 运动差别统计
（用户定调：理论上必须存在运动差别——模式B = 64t **全输入采样**（键位全位+鼠标，worker-a
已改全采样），快照相位（∈[0,tickDt]）传导到运动：①输入延迟：起跳 = 按下 + 快照边界等待 +
1ms 响应——无限制 0ms、32t≈31/64t≈15/128t≈7/256t≈3ms（单调、符合理论均值 tickDt/2）；
②轨迹累积差：**非对齐周期点按连跳**（237ms 点按 40ms——237 非 tickDt 整数倍 → 相位漂移
逐跳累积，理论 Δ≈tickDt/2×速度×跳数）3s 末位 Δ：32t=7.5/64t=3.5/128t=1.5/256t=0.5
（单调递减）；③极端相位：250ms 周期 30ms 短按——32t 快照窗口与按键周期对齐 → 跳跃位
被采样丢失、跳数 0 vs 无限制 4；④按住 autobhop 对照：jump 快照恒 1 → 落地瞬间立即起跳
无延迟 → Δ <5（差别来源是点按相位非按住）；⑤输入变化率决定差别：慢变输入（forward 恒按
+yaw 慢收拢）全采样 ≈实时（台阶差 = tickDt×斜率 ≤0.6°）→ 差别微小；快变输入（yaw 每
100ms 步进 90°）→ 差别显著（Δ位置 7~26））** / **模式B 64t 跳跃采样 + 移动实时（跳跃位采样——起跳延迟 ≤1 tick；移动位
实时——无方向错位漂移；**32tick 极端校验：惯性连跳平均速度 = 基准 0.58（显著低于）、难度
梯度单调 32<64<128<256（完整）、单跳高度与基准一致；出坡校验（可调水平速度 V=200→2000
自由演算）：速度标定单调、出坡物理规律（Δh 随 V 超线性增长——nopre 坡面钳制异常修复回归）、
各 tick 档位与基准严格一致；nopre 边界校验（坡面不钳/平地仍钳）；随机运动拟合校验（32tick
平均偏差 <15、无系统性漂移、位置兜底仅偶发、多种子稳定）；模式B 状态机；地面稳态一致性；
模式B 发布率；消息回退+模式B 兼容；连跳跳跃高度**；TICK_RATE≥1000 跳过；256 正常；
0 关闭）** / 输入限幅 ±1000 / 渲染采样与重绘（V 更新即重绘、V 未变不重绘）/
**消息回退模式（main→WorkerA 输入/难度投递、WorkerA→WorkerB 状态直连、限幅/松手清零/
V 版本/仅状态更新重绘语义与 SAB 一致、wait 立即超时返回、isMessageMode 标记、与模式B 兼容）** /
基本物理（落地/跳跃/respawn/世界构建）/ PVS 全量断言（findLeaf/可见集/对称性/边界）。
`npm run build`（wasm+ts）与 `npm run build:dist`（5 文件 3.91MB，含 wasm）通过。

**运行**：`python ../src/serve.py 8080 dist` → 访问 `http://localhost:8080/dist/index.html`
（需 HTTP + COOP/COEP 启用 SharedArrayBuffer，否则显示错误面板；pointer lock 后 WASD/鼠标
操作，R 重生，按钮切换 64/128/256/1000Hz 观察 HUD 中 V 版本、TICK 与渲染帧率（重绘/s）变化）。

**校验点（实现完成后逐条核对）**：
1. 主线程不碰物理/渲染（仅输入转发 + wake + 难度调节 + respawn），单帧耗时 < 0.1ms
2. SAB 布局含 WAKEUP/RENDER_WAKEUP 双唤醒槽与双缓冲 S[2]（每槽 pos×3/vel×3/yaw/pitch）+ 共用 V（add 递增）
3. 阶段0 writeTickRate 仅 store（无 notify）；阶段1 wake() = 双槽 store+notify：
   WAKEUP（WorkerA 物理背压）+ RENDER_WAKEUP（WorkerB 渲染帧对齐）——**双槽分离，
   物理背压不抢渲染唤醒**（帧边界抖动根因消除）
4. WorkerA 单模：1ms 子步、delta clamp 0~50ms、每轮最多 8 次、输入限幅 ±1000、写空闲槽 + V add；
   **上限耗尽保留剩余累加（时间不丢失）仅封顶 50ms**；热路径 = tick_into 零分配
   （状态写 wasm 固定缓冲 → Float64Array 视图直读 → writeStateRaw 标量直写 SAB）；
   **模式B = 64t 键位采样 + 1ms 物理：phys 键位输入按 1/TICK_RATE 采样快照（loAcc 保留
   余数——起跳/移动/松键延迟 ≤1 tick，连跳显著低于基准、梯度单调）；鼠标 dx/dy 实时
   （角度平滑）；无独立权威实例/无速度拟合/无兜底（快照 dx 导致移动方向抽动卡顿——
   physAuth 方案已弃用）；跳跃顶点与基准一致、出坡纯物理各 tick 一致（运动学不随 tick
   改变）；TICK_RATE≥1000 跳过防双倍物理**
5. 背压：剩余 >1ms 时 wait(WAKEUP)+复位，<=1ms 自旋（WAKEUP 为 WorkerA 专用槽）
6. WorkerB 自驱渲染（**发布驱动**）：MessageChannel 自投递 + waitRenderWakeup(RENDER_WAKEUP)
   ——主驱动 = WorkerA 每发布状态 notify（writeStateRaw → V++ → notify），渲染率 = 物理发布率
   （无 BSP 全速 1kHz，不受显示刷新率限制；重场景渲染耗时自然节流）；主线程 wake 帧对齐冗余；
   20ms 超时兜底（物理/主线程停摆渲染不冻结）；仅状态更新时重绘（V 未变不提交 Draw）
7. Respawn：postMessage → 立即重置 → 写空闲槽 + add(V,1)
8. 前置条件：crossOriginIsolated + SharedArrayBuffer 满足 → 共享内存模式；
   **不满足 → 消息回退模式（postMessage 等价通道，功能不停摆，HUD 提示）**
