# WebSurf debug 工程时序图

> 对应 `debug/`（WebSurf-debug，Debug Build）。实际实现：**渲染在主线程，物理在 Worker**
> （WASM Rust 物理，固定步长，frame 信号驱动）。无预测 Worker——物理单一权威源。
> game 时序见 `docs/timing-game.md`。

```mermaid
sequenceDiagram
    participant Hardware as 硬件层 (1ms 输入)
    participant Kernel as 浏览器内核 (蓄水池)
    participant Main as 主线程 (输入采集 + LERP 渲染)
    participant SharedMem as 共享内存 (SPSC 环形缓冲 + 输出 seqlock)
    participant Worker as Worker (物理循环: WASM 解析 + PhysWorld)
    participant GPU as 图形硬件

    Note over SharedMem: *** 布局与内存序约束 ***<br/>Int32 控制区: lock / outSeq / inHead / inTail / onGround / mode<br/>Float64 输出区: pos / yaw / pitch / vel / timeMs / eyeHeight<br/>环形缓冲 (SPSC, 64 槽 SOA): dxs / dys / tss (Float64) + keys (Int32)<br/><br/>写者: 槽数据(普通写) → Atomics.store(tail)<br/>读者: Atomics.load(tail) → 批量读快照<br/>满则覆盖最旧 (自动降采样); 积压 ≥8 → Atomics.notify<br/>输出 seqlock: lock=1 → 写数据 → seq++ → lock=0<br/>读侧: 锁占用 → 复用上一帧缓存; seq 校验<br/>(注: JS Atomics.store/load 均为 seq_cst——"release/acquire"为语义近似)

    Note over Hardware, GPU: === 第一阶段：输入捕获 ===
    loop 每 1ms 硬件信号
        Hardware->>Kernel: 推送原始增量位移
        Kernel->>Kernel: 内核级队列缓存
    end

    Note over Hardware, GPU: === 第二阶段：帧起始 —— 输入写入 (SPSC 无锁) ===
    Main->>Main: 读取全部未取输入 (mousemove / 键盘)
    Main->>Kernel: 提取输入
    Kernel-->>Main: 原始信号
    Main->>Main: 清洗、合并 (键位掩码 KEY_MASK; 灵敏度在 TS 侧乘入)
    Main->>SharedMem: 写环形缓冲样本 (dx/dy/keys/ts) → Atomics.store(tail)
    Main->>SharedMem: 积压 ≥ NOTIFY_THRESHOLD → Atomics.notify (仅信号)
    Main->>Worker: frame 触发信号 (纯触发, 无数据; dt 由 Worker 计算)

    Note over Hardware, GPU: === 第三阶段：Worker 物理循环 (固定步长) ===
    Worker->>SharedMem: takeInput (acquire 批量读 [head,tail) 聚合 sumDx/sumDy + keys)
    Worker->>Worker: 固定步长累积器 (fixedDt = 1/tickRate; MAX_FIXED_STEPS=10)
    loop 每步 (acc >= fixedDt)
        Worker->>Worker: Q/E 等效像素 (yawBindSpeed·dt/M_YAW) 并入 dx
        Worker->>Worker: PhysWorld.tick(dt, keysMask, dx, dy)
        Note over Worker: 完整物理: 移动/碰撞/传送检测/死亡判定<br/>传送 = StartTouch 边沿 + 落地脚底 OR
        Worker->>Worker: take_event 消费 (传送/死亡 → 计时挑战/检查点)
    end
    Worker->>SharedMem: writeFrame (加写锁 → 写输出区 → seq++ → 解锁)

    Note over Hardware, GPU: === 第四阶段：主线程渲染 (零等待) ===
    Main->>SharedMem: readFrame (安全检查点)
    alt 锁被占用 (Worker 写中)
        Main->>Local: 复用上一帧缓存
    else 锁释放且 seq 校验通过
        Main->>Main: 双快照 LERP 插值 (渲染/物理帧率解耦)
        Main->>Main: 相机同步 (pos.y + eyeHeight) + 近平面自适应
        Main->>GPU: 提交渲染指令 (基于插值后状态)
    end
    GPU->>GPU: 光栅化 & 像素处理
    GPU-->>Main: 渲染完成

    Note over Hardware, GPU: === 第五阶段：物理后处理与统计 ===
    Worker->>Worker: 游戏计时/传送事件/死亡回退 (onAfterPhysics)
    Worker->>Main: stats / game-stats (10Hz 周期) + physics-snapshot (参数/碰撞箱变更时事件式回传)

    Note over Main: 循环回到第二阶段
```

## 关键决策点

| 决策点 | 逻辑 |
|---|---|
| 输入满环 | 消费者跟不上 → 覆盖最旧（自动降采样），保留最新 64 样本 |
| 输出读取 | 锁占用 → 复用上一帧缓存（不阻塞）；锁释放 + seq 不变 → 新帧可用 |
| 鼠标增量 | 每帧应用一次（首步 tick），Q/E 每步计入——与旧 applyMouseDelta 语义一致 |
| noclip | 不进 Rust：TS noclipView 自由飞行；切回 physics 时 set_state 继承位置/视角（速度清零） |

## 无 Worker-B 说明

debug 物理为**单一权威源**（Worker 内 PhysWorld），主线程只做 LERP 插值——无预测 Worker-B、无预测管线；帧率解耦靠双快照插值 + 外推插帧（dead-reckoning，速度门限 500）。
