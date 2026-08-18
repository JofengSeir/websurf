# 鼠标输入事件差异分析（`src` 丝滑 vs `test/dual-mode-harness` 不丝滑）

> 说明：根目录 `src/` 只有共享输入工具 `src/ts-shared/input/input-layer.ts`，不包含浏览器事件绑定。
> 你所说的“\src 视角拖拽非常丝滑”，我按实际包含鼠标事件处理的 **`game/src`（`debug/src` 同款）** 实现来对比。

## 结论

`test/dual-mode-harness` 的鼠标视角不丝滑，主要不是灵敏度问题，而是**输入链路设计不同**：

1. **关键差异**：`src` 的主线程渲染物理直接消费每帧完整鼠标增量；`test` 的 WorkerA 用 `consumeInput(±1000)` 按 1ms 子步消费，而 SAB 累加器是一次性排空，导致**单帧快速移动超过 1000px 的部分被截断丢弃**。
2. `src` 使用 `PointerLockController` + `{ unadjustedMovement: true }` 禁用 OS 鼠标加速；`test` 只是裸 `canvas.requestPointerLock()`，OS 加速会让像素增量非线性。
3. `src` 在 Pointer Lock 后丢弃首个 mousemove（`discardNext`），避免锁定瞬间的大跳变；`test` 没有。
4. `src` 是主线程即时物理 + 渲染同帧；`test` 是主线程 → SAB → WorkerA → SAB → WorkerB 的跨线程链路，存在额外的调度/相位抖动。

## 对比表

| 维度 | `game/src`（丝滑） | `test/dual-mode-harness`（不丝滑） |
|---|---|---|
| 鼠标事件处理 | `MouseBuffer.process()` 每事件过滤 | 裸累加 `mouseDx += e.movementX` |
| Pointer Lock | `PointerLockController` + `unadjustedMovement: true` | `canvas.requestPointerLock()` 无选项 |
| 锁定后首事件 | `discardNext` 丢弃 | 无丢弃，可能瞬间跳变 |
| 单事件削平 | `MouseBuffer` 每事件 `clamp(±1000)` | 无 |
| 灵敏度 | 主线程 `layerMouseDelta` 乘入 | 不显式乘入（依赖 Rust 默认 sensitivity=1.5） |
| 每帧消费 | 主线程 `predPhys.tick(dt, pendingDx, pendingDy)` 直通完整增量 | WorkerA `consumeInput(MAX_INPUT_DELTA=1000)` 排空并削平 |
| 物理位置 | 主线程（渲染同一 rAF） | WorkerA（跨线程，WorkerB 再采样） |
| 输入到渲染延迟 | 同帧、相位固定 | 至少跨线程 + 1ms 子步边界，相位可变 |

## 详细差异

### 1. 每帧鼠标增量是否会被截断（最关键）

`game/src`：

```ts
// game/src/renderer/renderer-main.ts tick()
this.shared.addInput(this.pendingDx, this.pendingDy, this.pendingKeys);
this.predPhys.tick(dt, this.pendingKeys, this.pendingDx, this.pendingDy);
this.pendingDx = 0;
this.pendingDy = 0;
```

`predPhys.tick` 直接把这一帧累积的完整 `pendingDx/Dy` 交给 Rust 物理：

```rust
// src/phys/mod.rs step_core()
self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
```

Rust 侧对 `dx/dy` **没有再次削平**，所以快速甩动时完整增量都会变成视角旋转。

`test/dual-mode-harness`：

```ts
// test/dual-mode-harness/src/shared-state.ts consumeInput()
const dxFixed = this.exchangeZero(this.b64, B_DX_ACC); // 排空整个累加器
...
dx = Math.max(-maxDelta, Math.min(maxDelta, dx));      // 削平到 ±1000
```

```ts
// test/dual-mode-harness/src/worker-a.ts
const inp = shared.consumeInput(MAX_INPUT_DELTA);      // MAX_INPUT_DELTA = 1000
```

主线程每个 rAF 把这一帧所有 mousemove 增量一次性 `addInput` 进 SAB；WorkerA 的第一个 1ms 子步调用 `consumeInput` 时，会把整个累加器排空并削平到 ±1000。于是：

- 若单帧鼠标增量 ≤ 1000px：不丢，但整帧增量在一个 1ms 子步内突然施加；
- 若单帧鼠标增量 > 1000px（快速甩动/高回报率鼠标很常见）：**超出 1000px 的部分直接丢失**，视角跟不上手，表现为“发飘/卡顿/不跟手”。

### 2. Pointer Lock 是否禁用 OS 鼠标加速

`game/src/input/pointer-lock.ts`：

```ts
const p = callRequestPointerLock(target, { unadjustedMovement: true });
```

`unadjustedMovement: true` 会禁用 OS 级鼠标加速，让 `movementX/Y` 与物理位移线性对应。高回报率鼠标 + OS 加速开启时，单次 `movementX` 可能出现异常大的脉冲，导致视角瞬间跳变。

`test/dual-mode-harness/src/main.ts`：

```ts
canvas.addEventListener('click', () => {
  if (!locked) void canvas.requestPointerLock();
});
```

没有传 `{ unadjustedMovement: true }`，也没有 `pointerlockerror` 处理。这会让鼠标移动的“手感”非线性，快速拖动时更容易出现跳变/不跟手。

### 3. Pointer Lock 后首事件是否丢弃

`game/src/input/mouse-buffer.ts`：

```ts
process(movementX, movementY) {
  if (!this.locked) return null;
  if (this.discardNext) {
    this.discardNext = false;
    return null; // 丢弃锁定后首个事件
  }
  ...
}
```

`test/dual-mode-harness/src/main.ts` 只在 `pointerlockchange` 里清空累积值，但**没有丢弃锁定后的第一个 mousemove**。Pointer Lock 初始跳变通常有 2000-5000+ px，这会让刚锁定时视角猛跳一下，观感上很不“丝滑”。

### 4. 物理与渲染是否同帧

`game/src`：

- mousemove → `feedInput` → `pendingDx/Dy`；
- 同一个 rAF 回调里 `predPhys.tick(dt, pendingDx, pendingDy)` → 立即用结果设置相机。
- 输入到渲染的相位固定，延迟接近 0。

`test/dual-mode-harness`：

- 主线程 rAF 写 SAB + wake；
- WorkerA 被唤醒后，先处理 tick 边界，再按 1ms 累加器消费输入；
- WorkerA 写状态槽；
- WorkerB 下一次 rAF 信号采样并渲染。

即使不丢增量，这条链路也会引入：
- 至少一次跨线程调度延迟；
- WorkerA 不一定恰好在主线程 rAF 的同一相位消费输入，可能产生**帧与帧之间的相位抖动**；
- 快速连续拖动时，视角更新可能偶尔“这一帧没变、下一帧跳一大格”。

### 5. 灵敏度应用位置（等效，但可配置性不同）

- `game/src` 在 mousemove 事件里用 `layerMouseDelta(rawDx, rawDy, config.input.sensitivity)` 乘入灵敏度，并把物理两端 sensitivity 固定为 1；
- `test/dual-mode-harness` 不显式乘入，直接传原始像素，依赖 Rust 默认 `sensitivity=1.5`。

默认数值下两者有效灵敏度相同（`1.5 × 0.022 = 0.033 deg/px`），所以灵敏度本身不是“不丝滑”的主因；但 `test` 没有统一输入层，后续调灵敏度容易不一致。

## 修复建议

1. **在 `test/dual-mode-harness` 主线程引入 `MouseBuffer` 同款处理**：
   - 使用 `PointerLockController`（或至少 `requestPointerLock({ unadjustedMovement: true })`）；
   - 锁定后 `discardNext` 丢弃首事件；
   - 每个 mousemove 事件先 `clamp(±1000)` 再累加。
2. **不要用 `consumeInput(MAX_INPUT_DELTA)` 作为每帧鼠标的唯一消费路径**：
   - 要么像 `game` 一样在主线程增加一个渲染物理实例，直接消费完整 `pendingDx/Dy`；
   - 要么把 SAB 输入改为“只累加不排空/按窗口消费”的方式，让 WorkerA 在 1ms 子步内只消费该子步应得的增量，而不是一次性排空整帧并削平。
3. **统一使用 `src/ts-shared/input/input-layer.ts`**：
   - 主线程 `layerMouseDelta` 乘入灵敏度；
   - 物理两端 sensitivity 固定 1，避免双端参数分叉。
4. 如果只想快速改善：把 `MAX_INPUT_DELTA` 调大并改为“每帧只消费一次、不按 1ms 子步排空”，或直接让 WorkerA 的 `consumeInput` 支持“保留超出部分到下个子步”。

## 已实施改动（本仓库当前代码）

1. `test/dual-mode-harness/src/main.ts`
   - 新增 `MOUSE_MAX_DELTA` / `clampMouseDelta`：每个 mousemove 事件先削平到 ±1000；
   - 新增 `discardNextMouse`：Pointer Lock 变化后丢弃下一个 mousemove；
   - 新增 `requestPointerLockWithUnadjusted`：优先 `{ unadjustedMovement: true }` 禁用 OS 鼠标加速，不支持时降级普通锁定；
   - 增加 `pointerlockerror` 日志。
2. `test/dual-mode-harness/src/worker-a.ts`
   - 模式A 子步不再调用 `consumeInput(MAX_INPUT_DELTA)`，改为 `consumeInput()`；
   - 因此 SAB 累加器中的完整帧增量不再被“排空 + 削平到 ±1000”截断；
   - 单次事件削平已由主线程负责，快速甩动不再丢量。

> 说明：`test/dual-mode-harness` 的物理仍按设计在 WorkerA、渲染在 WorkerB；本次改动把鼠标输入链路从“WorkerA 1ms 子步削平丢量”修正为“主线程按事件削平 + WorkerA 完整增量直通”，在保留双模验证架构的前提下对齐 `src` 的鼠标手感。

## 参考代码位置

- `game/src/app.ts`：mousemove 绑定（约 L176-185）、`startInputLoop`（L315-350）
- `game/src/input/mouse-buffer.ts`：`process/push/drain/onLockChange`
- `game/src/input/pointer-lock.ts`：`unadjustedMovement`
- `game/src/renderer/renderer-main.ts`：`feedInput`（L506-510）、`tick`（L693-712）
- `src/ts-shared/input/input-layer.ts`：`layerMouseDelta`
- `src/phys/mod.rs`：`step_core` 中 yaw/pitch 应用（L200-204）
- `test/dual-mode-harness/src/main.ts`：鼠标累积与 rAF（L213-250、L378-387）
- `test/dual-mode-harness/src/shared-state.ts`：`consumeInput`（L410-437）
- `test/dual-mode-harness/src/worker-a.ts`：`MAX_INPUT_DELTA`（L54-55）、子步消费（L285）
