# WebSurf debug 工程时序图

> 最后核对：2026-08-11。以实际代码为准（`debug/src/renderer/renderer-main.ts` + 共享 `src/ts-shared/`）。

> 对应 `debug/`（WebSurf-debug，Debug Build）。**渲染时序已与 game 同模式**（主线程唯一物理渲染线 + Worker 权威帧计算器），共享实现位于 `src/ts-shared/`（auth/shared-state、auth-loop、worker-dispatch、authority-calibrator）。
> game 时序见 `docs/timing-game.md`（两图结构相同；差异仅在工程特有逻辑：debug 的计时挑战/物理面板/调试可视化等，完整差异清单见文末）。

```mermaid
sequenceDiagram
    participant Hardware as 硬件层 (1ms 输入)
    participant Kernel as 浏览器内核 (蓄水池)
    participant Main as 主线程 (唯一物理渲染线: 输入层 + BspProcessor + PhysWorld tick + 渲染 + 计时挑战)
    participant SharedMem as 共享内存 (SAB: 输入槽 + 权威全状态双缓冲)
    participant Worker as Worker (权威帧计算器: 共享 auth-loop + worker-dispatch)
    participant GPU as 图形硬件

    Note over SharedMem: *** 布局与内存序约束 (共享 ts-shared/auth/shared-state) ***<br/>控制区: V_A + keys + onGround<br/>输入槽: dx/dy (BigInt64 原子累加, 防溢出绝不丢)<br/>权威全状态双缓冲 S_A[0] & S_A[1] (10 值/槽, 定点: pos/vel×100, 角度×1000)<br/>防撕裂: 双缓冲槽选择 (V_A-1)&1<br/>无 SAB 环境 → MsgState postMessage 回退 (input/phys-frame 消息, 接口等价)

    Note over Hardware, GPU: === 第一阶段：输入捕获 ===
    loop 每 1ms 硬件信号
        Hardware->>Kernel: 推送原始增量位移
        Kernel->>Kernel: 内核级队列缓存
    end

    Note over Hardware, GPU: === 第二阶段：帧起始 —— 输入层化 (双端同源) ===
    Main->>Main: 提取全部输入 (mousemove / 键盘), 清洗合并 (CLAMP 1000)
    Main->>Main: 灵敏度乘入 dx/dy (layerMouseDelta); Q/E 等效像素 (qeEquivalentDx, 不受灵敏度影响)
    Main->>Main: 未锁定强制 mask=0; 滚轮跳并入 (锁定门控)
    Main->>SharedMem: Atomics.add(输入槽, 总增量) + store keys
    Main->>Main: 同一份输入喂主线程物理缓冲 (feedInput → pending)

    Note over Hardware, GPU: === 第三阶段：渲染帧 —— 主线程唯一物理渲染线 (rAF, 零等待) ===
    Main->>SharedMem: acquire 读 V_A (双缓冲槽 (V_A-1)&1 读权威全状态)
    Main->>Main: AuthorityCalibrator.correctFromAuthority (三条件兜底+冷却+回滚)
    Main->>Main: calibrateVelocity: set_velocity(vel_A + a×(now-t_A)) (只动速度, 位置/角度不覆盖)
    Main->>Main: PhysWorld.tick(dt, keys, dx, dy) —— 完整物理 (碰撞/传送/死亡)
    Main->>Main: take_event 消费 (传送→计时挑战检查点; 死亡→onDeath+检查点回退, 双端通知)
    Main->>Main: 渲染物理状态 (相机 = pos + eyeHeight; 度→弧度)
    Main->>GPU: 提交渲染指令
    GPU->>GPU: 光栅化 & 像素处理
    GPU-->>Main: 渲染完成

    Note over Hardware, GPU: === 第四阶段：权威帧计算 (共享 auth-loop, 固定步长 = 1/tickRate) ===
    loop 自驱循环 (setTimeout 4ms 轮询; 固定步长累积器无封顶, 每轮 ≤64 步 guard)
        Worker->>SharedMem: exchange 消耗输入 (maxStep 防穿墙, 随步长缩放)
        Worker->>Worker: PhysWorld.tick (完整物理, 独立权威演化)
        Worker->>Worker: 碰撞事件检测 (落地上升沿 / 撞墙速度骤降>250 u/s 且位移<预期 30% 且当前速度>80)
        Worker->>SharedMem: 写权威全状态双缓冲 (V_A&1) → store 递增 V_A
    end

    Note over Hardware, GPU: === 第五阶段：权威碰撞事件与位置突变 ===
    Worker-->>Main: phys-event (land/blocked: pos + yawDeg/pitchDeg)
    Main->>Main: 渲染位置与权威差 <60 → set_state 微调 (含角度)
    Main->>Worker: respawn / teleport / teleport-to-pos / set-spawn-points / set-death-threshold (双端同执行)
    Main->>Main: 本地同执行 + resetTo (清校准状态, 防权威帧拉回)

    Note over Hardware, GPU: === 第六阶段：兜底同步反转 (渲染主线 → 权威) ===
    Main->>Worker: sync-render-state (三条件 OR: dist>500 / dist>300 且 yaw 差≤3° 同向 / dist≤300 且 yaw 差>45°)
    Worker->>Worker: phys.set_state + resetInput (清增量, 键位保留); 250ms 冷却 + 在途回滚

    Note over Main: 循环回到第二阶段
```

## 关键决策点

| 决策点 | 逻辑 |
|---|---|
| 输入双通道 | 同一份已层化输入喂 SAB（权威）与主线程物理缓冲——双端同源，改灵敏度不产生分叉（Rust sensitivity 恒 1） |
| 权威读取 | 只读不反写；每帧仅 `set_velocity` 速度校准；位置/角度由渲染物理连续输出 |
| 角度隔离 | 权威帧不影响渲染角度；仅碰撞事件/兜底同步可写 |
| 计时挑战 | 主线程消费 `take_event`（权威 Worker 侧不消费，防双端重复记录）；死亡回退检查点后双端通知 |
| 传送/重生 | 所有位置突变双端同执行 + `resetTo`（防"权威帧拉回"） |

## 与 game 的差异（仅工程特有逻辑）

共享：解析/导出（ts-shared world-builder）、物理渲染线、权威帧、校准、输入层、近平面自适应。
debug 特有：计时挑战（GameState 主线程 take_event）、物理面板参数（physics-snapshot 镜像 predPhys）、调试可视化、自定义传送点、缺失纹理弹窗、colliderSource 三档、PAKFILE 调试 API。
game 特有（debug 无）：改键（keymap）、speedMode、lockTickRate（64Hz 公平锁定）、teleportGateTicks 滑块；noclipSpeed 为双端 config 层共有（game 面板有滑块，debug 面板无控件）。
