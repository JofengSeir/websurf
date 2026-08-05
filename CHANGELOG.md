# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [0.2.0] - 未发布

### 新增

- 共享内存**输入环形缓冲**（SPSC 无锁，64 槽 SOA，每样本带 `performance.now()` 时间戳）替换单槽累加器：
  批量消费聚合（增量求和保留 + 最新按键 + 首末时间戳）、满则覆盖最旧（自动降采样）、
  积压 ≥ 8 时 `Atomics.notify` 唤醒（为 Worker 自驱循环铺路）
- HUD 帧率显示拆分：**真实渲染帧率**（主线程 rAF 统计）与 Worker 处理频率
  （墙钟统计——修复物理 dt 含 Worker 抖动导致显示值虚低的问题）

### 变更

- `frame` 信号改为纯触发（去除主线程时间戳），物理 dt 由 Worker 侧 `performance.now()`
  计算（与主线程同源时钟，LERP 插值基准不变）
- 共享内存布局重设计：输入区由单槽 `inDx/inDy` 累加器改为 `inHead/inTail` 环形缓冲
  （`SHARED_BUFFER_SIZE` 144B → 1904B）

## [0.1.0] - 2026-08-05

### 新增

- 初始版本：BSP 解析、CS 移动物理、Three.js 渲染
