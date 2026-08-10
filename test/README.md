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

    Note over SharedMem: 布局: TICK_RATE / WAKEUP / 输入槽(dx/dy/keysMask) / 双缓冲 S[2] / V(版本号)

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
        Main->>SharedMem: Atomics.store(WAKEUP,1) + Atomics.notify(WAKEUP,1)  （唤醒 WorkerA）
        Main->>WorkerB: postMessage({type:'frame'})   （帧信号驱动渲染）
    end

    rect rgb(240, 255, 240)
        Note over WorkerA, SharedMem: === 阶段2: 单模 1ms 物理循环 (自驱) ===
        loop 自驱循环 (setTimeout 0, 永不阻塞主线程)
            WorkerA->>WorkerA: delta = clamp(实际间隔, 0, 50ms)
            WorkerA->>WorkerA: 累加器 += delta
            alt 累加器 >= 1ms
                loop 最多执行 8 次
                    WorkerA->>SharedMem: CAS 消耗输入 (限幅 ±1000 防穿墙)
                    WorkerA->>WorkerA: WASM 物理步进 (1ms 子步) phys.tick(0.001, ...)
                    WorkerA->>SharedMem: 写入空闲槽 (S[V&1^1]，不覆盖读槽)
                    WorkerA->>SharedMem: Atomics.add(V, 1)
                    WorkerA->>WorkerA: 累加器 -= 1ms
                end
            alt 剩余空闲时间 > 1ms
                WorkerA->>SharedMem: Atomics.wait(WAKEUP, 0, 剩余时间)  （可被阶段1 notify 唤醒）
                WorkerA->>SharedMem: Atomics.store(WAKEUP, 0)  （复位）
            else 剩余时间 <= 1ms
                Note over WorkerA: 继续自旋
            end
        end
    end

    rect rgb(255, 240, 245)
        Note over WorkerB, GPU: === 阶段3: 渲染采样与抽帧 (OffscreenCanvas) ===
        loop 每收到 {type:'frame'}（主线程 rAF 驱动，WorkerB 无自身 rAF）
            WorkerB->>SharedMem: Atomics.load(V)
            alt V 已更新
                WorkerB->>SharedMem: 读当前槽 S[V&1] 最新物理状态
                WorkerB->>WorkerB: 更新本地缓存
            end
            WorkerB->>SharedMem: Atomics.load(TICK_RATE)  （抽帧间隔 = 1/TICK_RATE）
            alt 距离上次采样 >= 抽帧间隔
                WorkerB->>WorkerB: 渲染目标 = 本地缓存 + 标记需要重绘
            end
            opt 需要重绘
                WorkerB->>WorkerB: 构建 Draw Calls
                WorkerB->>GPU: OffscreenCanvas 提交命令
                WorkerB->>WorkerB: 清除重绘标记
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
        Note over Main: 不支持 → 显示错误面板并停止
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
    shared-state.ts   SAB 布局：TICK_RATE / WAKEUP / 输入槽(dxAcc/dyAcc/keysMask) /
                      双缓冲 S[2]（每槽 pos×3/vel×3/yaw/pitch）+ V；wake/waitWakeup/
                      consumeInput(限幅)/writeState(写空闲槽)/readState(读当前槽)
    main.ts           主线程：前置条件检测 → 输入捕获（mousemove/键盘累积）→ rAF 输入转发
                      + wake() + frame 帧信号；写 TICK_RATE（仅 store）；respawn；
                      BSP 加载（文件选择 → BspProcessor 导出 → world-json → WorkerA / glb transfer → WorkerB）
    worker-a.ts       WorkerA 单模 1ms 物理核心（delta clamp 0~50ms / 8 次子步上限 /
                      输入限幅 ±1000 / 背压 wait(WAKEUP) + 复位）；world-json → build_world
                      （set_hull 16/72/54 + set_death_y(brush minY−100)）
    worker-b.ts       WorkerB three.js 第一人称渲染（完全 frame 驱动：采样 → 抽帧(1/TICK_RATE) →
                      重绘（相机 = pos + 眼高 64.09，rotation = pitch/yaw 度→弧度 YXZ）→ WebGL 提交；
                      GLB 挂载 + status 摘要回传 main DOM HUD）
  scripts/
    build-dist.mjs    构建（multi 外置，HTTP 运行）
    phys-smoke.mjs    node 冒烟测试（时序协议 + BspProcessor 导出 + surf_666 真实世界构建/物理）
```

**世界构建**：WorkerA 用简单手工 brush JSON（地面 + 少量斜坡）调用 `PhysWorld.build_world`，
不依赖 BSP 地图文件（聚焦时序验证）。视角 = 鼠标增量 → 输入槽 dy/dx → WorkerA 物理 tick
内 apply_input（yaw/pitch 由物理更新）→ 状态槽输出角度 → WorkerB 相机。

## 五、实现状态（2026-08-10 按最新时序图改造，46/46 PASS 校验）

| 校验点 | 实现 | 状态 |
|---|---|---|
| 前置条件：crossOriginIsolated + SAB 支持 | main.ts 启动检测，失败显示错误面板并停止（throw 前动态注入 DOM） | ✅ |
| SAB 布局：TICK_RATE / WAKEUP / 输入槽 / 双缓冲 S[2] / V | shared-state.ts 偏移常量 + SHARED_BUFFER_SIZE=192B（V 递增用 add） | ✅ |
| 阶段0 动态难度（仅 store 无 notify） | writeTickRate 仅 Atomics.store；唤醒职责移交 WAKEUP 槽 | ✅（旧 store+notify 已移除） |
| 阶段1 输入转发：add → wake() → frame 帧信号 | main.ts rAF：addInput → wake()（store+notify WAKEUP）→ workerB.postMessage({type:'frame'}) | ✅ |
| 阶段2 单模 1ms（删除旧模式B 双模） | worker-a.ts：delta clamp 0~50ms；acc>=1ms 时 loop 最多 8 次子步；上限耗尽丢弃剩余防死亡螺旋 | ✅ |
| 消耗输入限幅（±1000 防穿墙） | consumeInput(maxDelta=±1000) 与 game 输入层 CLAMP 一致，注释说明防穿墙 | ✅ |
| 双缓冲写空闲槽（S[V&1^1]）+ V add | writeState 写当前 V 的另一槽（不覆盖读槽）→ Atomics.add(V,1) | ✅ |
| 背压：wait(WAKEUP,0,timeout) + 复位 | waitWakeup 挂起 WAKEUP 槽（可被阶段1 唤醒），返回后 store(WAKEUP,0)；剩余<=1ms 自旋 | ✅ |
| 阶段3 frame 驱动（WorkerB 无自身 rAF） | worker-b.ts onmessage {type:'frame'}：读 V→缓存；读 TICK_RATE→抽帧间隔；距上次采样>=间隔→渲染目标更新+标记重绘；重绘后清除 | ✅ |
| 抽帧间隔 = 1/TICK_RATE | TICK_RATE=64 → 15.625ms；128 → 7.8125ms（HUD 显示当前间隔） | ✅ |
| 阶段4 Respawn | R 键 postMessage → phys.respawn() → writeStateFromPhys（写空闲槽 + add(V,1)） | ✅ |
| 读状态防撕裂（double-check） | readState 读当前槽 S[V&1]，重读 V 校验，不一致以新版本重读（最多 2 次） | ✅ |

**测试**：`node scripts/phys-smoke.mjs` — **46/46 PASS**，覆盖：双缓冲槽切换与交替写 /
V 递增用 add（写 N 次 V 增 N）/ WAKEUP 协议（wake 后立即返回、超时返回、复位、writeTickRate
不触碰 WAKEUP）/ 8 次子步上限（delta=20ms → 8 次）/ 输入限幅 ±1000 / 抽帧逻辑（64Hz 间隔
15.625ms，frame + 距离>=间隔 → 更新，< 间隔 → 复用）/ 基本物理（落地/跳跃/respawn/世界构建）。
`npm run build`（wasm+ts）与 `npm run build:dist`（5 文件 0.26MB）通过。

**运行**：`python ../src/serve.py 8080 dist` → 访问 `http://localhost:8080/dist/index.html`
（需 HTTP + COOP/COEP 启用 SharedArrayBuffer，否则显示错误面板；pointer lock 后 WASD/鼠标
操作，R 重生，按钮切换 64/128/256/1000Hz 观察 HUD 中 V 版本、TICK 与抽帧间隔变化）。

**校验点（实现完成后逐条核对）**：
1. 主线程不碰物理/渲染（仅输入转发 + wake + frame 帧信号 + 难度调节 + respawn），单帧耗时 < 0.1ms
2. SAB 布局含 WAKEUP 槽与双缓冲 S[2]（每槽 pos×3/vel×3/yaw/pitch）+ 共用 V（add 递增）
3. 阶段0 writeTickRate 仅 store（无 notify）；阶段1 wake() = store+notify WAKEUP + frame 帧信号
4. WorkerA 单模：1ms 子步、delta clamp 0~50ms、每轮最多 8 次、输入限幅 ±1000、写空闲槽 + V add
5. 背压：剩余 >1ms 时 wait(WAKEUP)+复位，<=1ms 自旋
6. WorkerB 完全 frame 驱动（无自身 rAF）；抽帧间隔 = 1/TICK_RATE；距上次采样 >= 间隔才更新渲染目标
7. Respawn：postMessage → 立即重置 → 写空闲槽 + add(V,1)
8. 前置条件：crossOriginIsolated + SharedArrayBuffer 不满足时错误面板提示并停止
