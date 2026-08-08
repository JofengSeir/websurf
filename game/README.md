# WebSurf-game（最小化实现）

WebSurf 的激进最小化实现（独立工程 `game/`，不修改原项目）。物理栈整体下沉 Rust WASM，
双 Worker（权威 64Hz 自驱 + 预测热待机）三源决策零等待渲染。

## 架构

```
主线程 (src/app.ts)
  ├─ 输入采集 → SAB 输入槽（BigInt64 原子累加，永不溢出）
  ├─ 三源决策（权威 V_A → 预测 gen_P 校验 → 回退 S_last）→ 渲染
  ├─ ESC 两栏面板（左导航 + 右设置，七模块）＋ 按键自定义录制
  └─ 速度 HUD 8Hz（S_used.vel 采样，纯数字，居中偏下 24%）
Worker-A (src/worker/main.ts)          Worker-B (src/worker/predictor-main.ts)
  ├─ WASM: BspProcessor 解析/导出      ├─ 同 wasm 模块第二 PhysWorld 实例
  ├─ WASM: PhysWorld（Rust 物理）       ├─ Atomics.wait 热待机 + 2 子步 predict
  ├─ 64Hz 自驱（Atomics.wait 16ms）    ├─ 基线 = 读权威 + set_state 锚定（防漂移）
  └─ 写权威双缓冲 + V_A++/gen_A        ├─ 动态步长 = min(now-lastStep, 1/64)
                                        └─ 写预测双缓冲 + gen_P（代际校验）
```

## SAB 布局（512B）

| 区 | 内容 |
|---|---|
| Int32 控制区 | V_A / gen_A / seq_P / gen_P / keys / A_GROUND / P_GROUND |
| BigInt64 输入槽 | dxAcc / dyAcc（原子累加，V6 永不溢出） |
| 权威双缓冲 | S_A[0] / S_A[1]（写空闲槽 → V_A++ → 主线程读 (V_A-1)&1，V2 无撕裂） |
| 预测双缓冲 | S_P[0] / S_P[1]（同构） |

> 关键设计：**双缓冲消除多字段撕裂（V2）**；**代际校验取代主线程清零
> （V3，gen_P==gen_A 才接受预测）**；Worker-B **只读输入 + 权威基线锚定**
> （绝不与 Worker-A 抢输入，预测不漂移）。

## 构建

```bash
npm install
npm run build:wasm   # wasm-pack release（wasm-opt=false：本机 NODE_OPTIONS 污染 wasm-opt）
npm run build:ts     # typecheck + esbuild（app/worker/predictor 三产物）
node scripts/check-wasm-api.mjs  # 契约校验（导出 9 + 物理 12 API）
npm run test:phys                # Rust 物理冒烟（node 跑 WASM：落地/跳跃/预测/基线锚定/teleport）
npm run build:dist   # 常规多文件 dist/（index.html + app.js + worker.js + predictor.js + wasm）
```

**一键脚本**：
- `build-dist.cmd`（双击）：wasm → 契约 → typecheck → dist（多文件），全分支 pause 防闪退
- `play.cmd`（双击即玩）：起本地服务器（COOP/COEP 头）→ 自动打开 `dist/index.html`

> dist 为**常规多文件打包**（无 base64 内嵌）：wasm 外置 + 双 Worker 独立文件 + ESM，
> 与 dev（web/）同构——因物理双 Worker 依赖 SharedArrayBuffer 本就必须经 HTTP 服务器
> 运行（file:// 双击显示引导卡片），单文件内嵌无意义。

## 运行

> **必须通过本地 HTTP 服务器**：物理双 Worker 依赖 SharedArrayBuffer，
> 需要 COOP/COEP 跨域隔离头——`file://` 双击无法启用（页面会显示引导卡片）。
> 推荐直接双击 `play.cmd`；或工程根目录下 `python ..\src\serve.py 8137 .` 后访问
> `http://localhost:8137/dist/index.html`（开发用 `8090/web/index.html`）。

## 控制

- WASD 移动 · 空格跳 · Ctrl 蹲 · Shift 慢走 · Q/E 转视角 · R 重生（**全部可自定义**，面板「按键」模块录制 + localStorage 持久化）
- 点击画布锁定；ESC 打开面板（未锁定时）；M 手动开关；面板「关闭」仅隐藏不锁定
- 面板（两栏七模块）：**通用**（加载地图/重生/出生点）、物理（tickRate 48-128 联动、
  重力/加速/空加/摩擦/autobhop）、体型（半宽/站高/蹲高）、按键、操作（灵敏度/Q-E）、
  显示（准星/速度模式）、视角（noclip 切换 + 速度 200-3000，Shift 再 ×4）

## 规模

| 层 | 原项目 | 本实现 |
|---|---|---|
| TS | 11,844 行 / 79 文件 | ~2,900 行 / 17 文件（-75%） |
| Rust 物理 | TS 3,353 行（迁移源） | 2,400+ 行 / 4 文件（world/player/teleport/mod） |
| scene-data | GLB + 几十 MB JSON | GLB + spawn/pvs 小 JSON（-95%） |
| 消息协议 | 25+14 | 7+5 |

## 文档（`game/docs/`）

- `MINIMAL-IMPL-PATH.md` — 实现蓝图（v3）
- `IMPLEMENTATION-STATUS.md` — 实现现状 + 三方差异对照（时序图/蓝图/现状，D1-D6/T1-T6）
- `DESIGN-DISCUSSION.md` — 差异点讨论（含优先级与已实施记录）

> 目标架构参照根 `docs/项目时序图.md`（终版：双缓冲 + 代际校验 + 预测链防滥用；规划蓝图，现状以本工程 docs 为准）。
