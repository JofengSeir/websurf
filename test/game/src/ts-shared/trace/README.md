# ts-shared/trace — 运动路径采集与显示（公共模块）

由 /test 的 trace 功能提升而来，供 **game / debug / test** 复用：记录物理运动的空间路径线（双线对照：无限制基准 vs tick 实际），在 3D 场景中以线条显示。

## 文件

| 文件 | 职责 |
|---|---|
| `trace-types.ts` | 协议（消息类型）+ 状态机类型 + 点数据结构 + 转换工具 |
| `trace-recorder.ts` | 采集端状态机（物理 Worker 侧：开关/节流采样/滚动窗口/双实例位置） |
| `trace-renderer.ts` | 显示端（渲染引擎无关，依赖注入 `lineFactory`；任意渲染 Worker 可挂载） |

## 架构（数据流）

```
[物理 Worker]                    [main]                    [渲染 Worker]
TraceRecorder.tick(base,tick)                         TraceRenderer.addPoint(pt)
      │  onPoint → trace-data        转发 trace-point       │ 3D 双线
      └─────────── postMessage ────────────────┐            │
                        trace-clear ───────────┴───────────► clear()
```

## 用法

### 采集端（物理 Worker，如 test worker-a）

```ts
import { TraceRecorder } from '../../src/ts-shared/trace/trace-recorder.js';

const traceRecorder = new TraceRecorder({
  sampleEvery: 16, // 每 16 子步一点（1ms 子步 ≈ 16ms/点 ≈ 62.5Hz）
  onPoint: (pt) => self.postMessage({ type: 'trace-data', ...pt.base, ...pt.tick }),
});

// 子步循环内：
traceRecorder.tick(phys.state(), tickPhys?.state() ?? phys.state());
// 消息处理：
case 'trace': traceRecorder.setEnabled(msg.enabled); break;
```

### 显示端（渲染 Worker，如 test worker-b）

```ts
import { TraceRenderer } from '../../src/ts-shared/trace/trace-renderer.js';
// 渲染引擎无关：线条由 lineFactory 注入（three 或其他引擎适配）
const traceRenderer = new TraceRenderer({
  baseColor: 0x4ade80, // 绿=无限制基准
  tickColor: 0xf87171, // 红=tick 实际
  lineFactory: (color) => { /* 创建/更新/销毁一条指定颜色的路径线 */ },
});

case 'trace-point': traceRenderer.addPoint(pt); break;
case 'trace-clear': traceRenderer.clear(); break;
```

### 主线程（按钮状态机，UI 层保留在各端）

```ts
import type { TraceState } from '../../src/ts-shared/trace/trace-types.js';
// 状态机 off → recording → saved → off，转发 trace/trace-data/trace-clear 消息
```

## 协议

- `{type:'trace', enabled:boolean}`：采集启停（main → 物理 Worker）
- `{type:'trace-data', baseX..baseZ, tickX..tickZ}`：采样点（物理 Worker → main）
- `{type:'trace-point', baseX..baseZ, tickX..tickZ}`：转发点（main → 渲染 Worker）
- `{type:'trace-clear'}`：清空路径（main → 渲染 Worker）

## 配置

- `sampleEvery`：采样节流（子步数）；默认 16
- `maxPoints`：滚动窗口上限；默认 2000（`TRACE_MAX_POINTS`）
- `baseColor` / `tickColor`：线颜色（默认绿 0x4ade80 / 红 0xf87171）

## 验证

- test 端到端：`test/dual-mode-harness/scripts/trace-verify.mjs`（Chrome headless + CDP）——点击"开始" →
  WorkerA `TraceRecorder` 采样 → main 转发 → WorkerB `TraceRenderer` 渲染 3D 路径线，
  断言无控制台错误（无独立 Node 单测）
