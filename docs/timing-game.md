# WebSurf game 工程时序图

> 对应 `game/`（WebSurf-game，Game Build）。实际实现（v7 定案）：**主线程 = 唯一物理渲染线**
> （PhysWorld tick + 渲染同频，rAF 帧率可变 dt、dt 钳制 0.1s）；**Worker = 权威帧计算器**
> （独立固定步长 = 1/tickRate，默认 64Hz、面板 48-128 可调，含地图碰撞）。无 Worker-B——预测已在主线程（v4 起删除双 Worker 预测）。
> debug 时序见 `docs/timing-debug.md`。

```mermaid
sequenceDiagram
    participant Hardware as 硬件层 (1ms 输入)
    participant Kernel as 浏览器内核 (蓄水池)
    participant Main as 主线程 (唯一物理渲染线: 输入层 + PhysWorld tick + 渲染)
    participant SharedMem as 共享内存 (输入槽 + 权威全状态双缓冲)
    participant Worker as Worker (权威帧计算器: wasm 世界 + 固定步长)
    participant GPU as 图形硬件

    Note over SharedMem: *** 布局与内存序约束 ***<br/>控制区: V_A + keys + onGround<br/>输入槽: dx/dy (BigInt64 原子累加, 防溢出绝不丢)<br/>权威全状态双缓冲 S_A[0] & S_A[1] (10 值/槽: pos/yaw/pitch/vel/eyeHeight/timeMs, 定点)<br/>防撕裂: 双缓冲槽选择 (V_A-1)&1 (无代际校验)<br/><br/>*** 同步内容 (v7) ***<br/>权威全状态: pos + yaw/pitch + vel + eyeHeight + onGround + timeMs<br/>用途: 主线程每帧速度外推校准 (vel_A + a×Δt) + 异常兜底<br/><br/>无 Worker-B: 预测 = 主线程渲染物理本身 (唯一物理渲染线)

    Note over Hardware, GPU: === 第一阶段：输入捕获 ===
    loop 每 1ms 硬件信号
        Hardware->>Kernel: 推送原始增量位移
        Kernel->>Kernel: 内核级队列缓存
    end

    Note over Hardware, GPU: === 第二阶段：帧起始 —— 输入层化 (双端同源) ===
    Main->>Main: 记录 lastFrameTime, now = performance.now()
    Main->>Kernel: 提取全部未取输入 (无上限)
    Kernel-->>Main: 全部原始信号
    Main->>Main: 清洗、合并、限幅 (CLAMP 1000)
    Main->>Main: 输入层: 灵敏度乘入角度增量 (物理两端 sensitivity 固定 1)<br/>Q/E 生成等效鼠标量 (yaw_bind_speed/M_YAW × dt, 不受灵敏度影响)
    Main->>SharedMem: Atomics.add(输入槽, 总增量) + store keys
    Main->>Local: 同一份输入喂主线程物理缓冲 (双端同源 → 无分叉)

    Note over Hardware, GPU: === 第三阶段：渲染帧 —— 主线程唯一物理渲染线 (rAF, 零等待) ===
    Main->>SharedMem: acquire 读取 V_A
    alt V_A 已刷新 (权威新帧)
        Main->>SharedMem: 根据 (V_A-1)&1 选择双缓冲槽, acquire 读权威全状态
        Main->>Main: 记录 curAuth (只读, 不反写权威) + 权威加速度 a
    end
    Main->>Main: 校准: set_velocity(vel_A + a×(t_now − t_A)) —— 权威速度外推反馈<br/>(位置/角度不覆盖; 渲染帧永远是主线程物理的连续输出)
    Main->>Main: PhysWorld.tick(dt, keys, dx, dy) —— 完整物理 (碰撞/传送/死亡)
    Main->>Main: 渲染物理状态 (相机 = pos + eyeHeight; 角度 度→弧度)
    Main->>GPU: 提交渲染指令
    GPU->>GPU: 光栅化 & 像素处理
    GPU-->>Main: 渲染完成

    Note over Hardware, GPU: === 第四阶段：权威帧计算 (固定步长 = 1/tickRate, 默认 64Hz, 面板 48-128 可调) ===
    loop 自驱循环 (setTimeout 4ms 轮询; 固定步长累积器无封顶, 不丢物理时间)
        Worker->>SharedMem: exchange 消耗输入 (maxStep 防穿墙, 随步长缩放)
        Worker->>Worker: PhysWorld.tick (完整物理: 碰撞/传送/死亡; 独立权威演化)
        Worker->>Worker: 碰撞事件检测 (落地上升沿 / 撞墙速度骤降+位移受阻)
        Worker->>SharedMem: 写权威全状态到双缓冲槽 (V_A&1)
        Worker->>SharedMem: Atomics.store 递增 V_A (内存屏障语义; 状态先于版本号可见)
    end

    Note over Hardware, GPU: === 第五阶段：权威碰撞事件回传 (低频, 位置微调+角度同步) ===
    Worker-->>Main: phys-event (land/blocked: pos + yawDeg/pitchDeg)
    Main->>Main: 渲染位置与权威差 <60 → set_state 微调 (含权威角度)<br/>差 ≥60 → 跳过防跳变

    Note over Hardware, GPU: === 第六阶段：位置突变事件 (respawn / teleport) ===
    Main->>Worker: respawn / teleport 消息 (双端同执行)
    Main->>Main: 渲染物理本地 respawn / teleport (无回传归零; 权威帧校准随后收敛)

    Note over Hardware, GPU: === 第七阶段：兜底同步反转 (渲染主线 → 权威) ===
    Main->>Worker: sync-render-state (三条件 OR: ①dist>500 ②dist>300 且 yaw 差≤3° 且转动方向相同 ③dist≤300 且 yaw 差>45°)
    Worker->>Worker: phys.set_state + resetInput (清未消费增量, 键位保留)
    Note over Worker: 250ms 冷却防抖; 同步在途再分叉 → 回滚以权威为准

    Note over Main: 循环回到第二阶段
```

## 关键决策点

| 决策点 | 逻辑 |
|---|---|
| 权威读取 | 只读不反写；位置/角度不覆盖——每帧仅 `set_velocity` 速度校准 |
| 角度隔离 | 权威帧不得影响渲染角度（输入层化后双端同源 → 天然一致）；仅碰撞事件可同步角度 |
| 输入双通道 | 同一份输入同时喂 SAB（权威）与主线程本地缓冲——无分叉 |
| 无 Worker-B | 预测即主线程渲染物理本身（v4 起删除双 Worker 预测：双 Worker 同步复杂易卡） |

## MsgState 回退（无 SAB 环境：file:// / GitHub Pages）

- 输入：主线程每帧 `input` 消息（dx/dy/keys）→ Worker 累积（takeInput 语义同 SAB）。
- 权威帧：Worker 每 tick `phys-frame` 消息 → 主线程 `recvFrame` 缓存（readAuthoritative 返回）。
- 功能等价、性能降级（消息拷贝 vs 共享内存）。
