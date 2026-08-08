// WebSurf 共享物理系统（websurf-phys）
//
// 提取自 game/（WebSurf-game）的 Rust 物理模块，供 debug/ 与 game/ 两个独立工程
// 通过 path 依赖共享编译（消除双副本分叉）。仅含物理处理逻辑：
//   - phys::PhysWorld  — wasm-bindgen 绑定层（build_world/tick/predict/...）
//   - phys::world      — 世界碰撞容器（brush/tri 双空间索引 + Minkowski 扫掠）
//   - phys::player     — 玩家移动语义（全套 CS 移动）
//   - phys::teleport   — 传送检测 + 死亡判定
//
// 两工程 cdylib 各自 `pub use websurf_phys::PhysWorld;` re-export 导出 WASM API。

pub mod phys;
