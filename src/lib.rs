// WebSurf 共享物理系统（crate `websurf-phys`）
//
// 本 crate 只含物理处理逻辑，由仓库根 `Cargo.toml` 的 [workspace] members 收录（成员名 `src`）。
// `apps/debug` 与 `apps/game` 的 `crates/wasm/Cargo.toml` 各以一行
// `websurf-phys = { path = "../../../../src" }` 依赖本目录；两工程的 `crates/wasm/src/lib.rs`
// 又各有一行 `pub use websurf_phys::phys::PhysWorld;`，把物理侧导出面并入各自的 WASM API。
// `apps/viewer` 是纯查看器：其 `crates/wasm` 不含本 crate，解析层走共享的 `websurf-wasm-core`。
//
// 模块构成（全部在 `src/phys/` 下）：
//   - `phys::PhysWorld`  — wasm-bindgen 绑定层（`src/phys/mod.rs`）：建世界、步进、
//                          状态读写、参数与碰撞箱设置
//   - `phys::world`      — 世界碰撞容器（`src/phys/world.rs`）：凸 brush / 三角网格的
//                          扫掠盒平面裁剪 + `BrushGrid` / `TriangleGrid` 两套均匀网格
//   - `phys::player`     — 玩家移动语义（`src/phys/player.rs`）：CS 风格地面/空中移动、
//                          台阶、蹲伏、梯子、卡死挤出
//   - `phys::teleport`   — 传送触发检测 + 掉落死亡判定（`src/phys/teleport.rs`）
//   - `phys::seed`       — 种子面 v2 的可序列化投影（`src/phys/seed.rs`，crate 私有 `mod`）

pub mod phys;
