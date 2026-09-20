# 权威线启动慢（根因：逐三角形深克隆网格）

> 落点：`test/game-core`（绝对隔离工程）。事实基准：2026-09-20 实测（headless + CDP）。
> 用户口径：「权威计算之前就位速度非常快，只有 200~300ms；你慢了 10 倍肯定有问题」。

## 1. 症状与量测方法

客户端（主线程预测线）在地图加载后立刻开始跑，而权威线（Worker）迟迟不出第一个帧；
这段窗口里权威状态仍是"出生点静止"，会经速度耦合拖住预测线的下坠（用户："落地一次后才正常"）。

三段拆分计时（零行为改动，`app.ts` + `worker/main.ts`）：

- `[authority] world-json 已发送 @T` / `postMessage 结构化克隆耗时`
- `[authority] JSON 解析（JS 代理）`（Worker 内 `JSON.parse` 计时）
- `[authority] Worker 内 world-json 处理`（Worker 收到消息 -> `onWorldBuilt`，**Worker 内自计时**，
  规避两端 `performance.now` 基准偏移约 1132ms）
- `[authority] 首个权威帧 @T（va=N）`

## 2. 定位过程（每一步都用实测排除）

| 假设 | 实测 | 结论 |
|---|---|---|
| 传输太慢 | 结构化克隆 **4.3~6.7ms**（载荷 8.37MB） | 排除 |
| JSON 解析太慢 | JS 侧 `JSON.parse` **34.9ms(brush) + 6ms(tri)** | 排除 |
| 是本会话改动引入 | `git log --name-only`：本会话只碰 `wasm-core/{lib,model_integrator,vhv}.rs` + 渲染 TS，未碰 brush 导出/`build_world` | 排除 |
| brush 网格构建是主因 | 临时跳过 `grid.build`：4972ms -> **3995ms** | 只占约 1s，不是主因 |
| **`TriangleGrid::build` 逐三角形 `mesh.clone()`** | 见 §3 | **主因** |

## 3. 根因（`crates/phys/phys/world.rs`）

```rust
// 修复前（TriangleGrid::build）
for [a, b, c] in &mesh.indices {
    self.entries.push(TriEntry { mesh: mesh.clone(), ... });   // 每三角形深克隆整份 vertices+indices
}
```

复杂度 = **O(三角形数 x 网格大小)**：一个 1 万三角形的网格、6 千顶点，
每三角形克隆约 264KB，累计**数 GB memcpy**。这解释了全部观测：

- surf_666 4972ms vs surf_null 785ms（载荷只差 12%，耗时差 6 倍）=> **超线性**；
- 与「权威以前很快」的记忆一致——这条克隆是纯浪费，不影响任何物理语义。

## 4. 修法（共享引用，语义零变化）

`TriEntry.mesh` 由按值 `TriMesh` 改为 `std::rc::Rc<TriMesh>`，`build()` 里**每个网格只深克隆一次**，
逐三角形只 `Rc::clone`（引用计数 +1）。wasm 单线程 => `Rc` 足够（无需 `Arc`）。
碰撞查询读的是同一份数据，**物理语义与数值完全不变**（`test:phys` 五指纹全绿）。

## 5. 实测收益

| 地图 | 修复前 Worker 内 | 修复后 | 首个权威帧（发送后） |
|---|---|---|---|
| surf_666（75.5MB，7730 brush / 64776 面） | 2367~4972ms | **134.9ms** | **163ms** |
| surf_null（29MB） | 785~966ms | **96.3ms** | **128ms** |

=> **20~37 倍**，落回用户记忆的 200~300ms 区间。回归：`test:phys` 五指纹全绿、`typecheck` 0。

## 6. 教训（写给后续）

- 只测"端到端"会一直以为瓶颈在解析/传输；**三段拆分**（传输 / 解析 / 构建）才把它钉在一行 `clone()` 上。
- 先做**零风险对照实验**（临时跳过 `grid.build`）再动手改，避免又一次"改错地方"。
- 控制耦合（速度写入 / 首帧对齐）**不要再动**：本轮修的是源头耗时，客户端一行未改。
