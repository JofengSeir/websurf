# WebSurf-game（最小化实现）

> 最后核对：2026-08-13。以实际代码为准（`game/src/` + 共享 `src/ts-shared/`）。

WebSurf 的激进最小化实现（独立工程 `game/`）。物理栈整体下沉 Rust WASM，
v7 定案：**主线程唯一物理渲染线 + 单 Worker 权威帧计算器**。

## 架构

```
主线程 (src/app.ts + src/renderer/renderer-main.ts)
  ├─ 输入采集（MouseBuffer CLAMP 1000）→ 灵敏度输入层 → SAB 输入槽（BigInt64 原子累加）
  ├─ 每 rAF：写输入 → 读权威帧 → set_velocity 外推校准 → PhysWorld.tick（可变 dt 单步，上限 0.1s）→ 渲染直读 state()
  ├─ ESC 两栏面板（左导航 + 右设置，七模块）＋ 按键自定义录制；lockTickRate 可锁定 64Hz（公平模式）
  ├─ 渲染：LOD/PVS 距离剔除（cullDistance=maxDim×0.5）+ 近平面贴墙自适应（4 水平方向探测，每 2 帧）
  └─ 速度 HUD 8Hz（PhysWorld.state().vel 采样，纯数字，居中偏下 24%）
Worker (src/worker/main.ts，共享 ts-shared/auth)
  ├─ setTimeout 4ms 自驱权威循环（auth-loop）
  ├─ 固定步长 1/tickRate（默认 64Hz，面板 48-128）
  ├─ 消费 SAB 输入槽 → 完整物理（Rust PhysWorld）→ 碰撞事件（land/blocked）→ 写权威双缓冲 + V_A++
  └─ 兜底同步（sync-render-state 三条件 + 250ms 冷却 + 在途回滚）
```

## SAB 布局（512B，src/ts-shared/auth/shared-state.ts）

| 区 | 内容 |
|---|---|
| Int32 控制区 | V_A / keys / A_GROUND |
| BigInt64 输入槽 | dxAcc / dyAcc（原子累加，永不溢出） |
| 权威双缓冲 | S_A[0] / S_A[1]（每槽 10 值定点：pos/vel×100、角度×1000；Worker 写空闲槽 → V_A++ → 主线程读 (V_A-1)&1） |

> 关键设计：**双缓冲消除多字段撕裂**；权威帧只读（位置/角度由主线程预测物理线
> 权威，Worker 角度仅经 phys-event 碰撞事件回传）；**无预测 Worker**（v3 时代的
> 预测热待机已随 v7 移除）。无 COOP/COEP 时自动降级 MsgState（input/phys-frame 消息）。

## 构建

```bash
npm install
npm run build:wasm   # wasm-pack release（wasm-opt=false：本机 NODE_OPTIONS 污染 wasm-opt；并拷贝 wasm 到 web/）
npm run build:ts     # typecheck + esbuild（app/worker 两产物）
node scripts/check-wasm-api.mjs  # 契约校验（导出 16 + 物理 17 API）
npm run test:phys                # Rust 物理冒烟（node 跑 WASM）
npm run build:dist   # 默认 single（base64 内嵌 + Blob worker，file:// 可玩）；--multi 多文件（HTTP）
```

**一键脚本**：
- `build-dist.cmd`（双击）：wasm → 契约 → typecheck → dist，全分支 pause 防闪退
- `play.cmd`（双击即玩）：起本地服务器（COOP/COEP 头）→ 自动打开 `dist/index.html`

> dist 默认 **single 内嵌打包**（WASM base64 + Worker Blob URL），专门支持 file:// 双击
> （无 fetch 能力；无 SAB 自动 MsgState 降级）。`--multi` 为多文件（app.js + worker.js +
> wasm + textures.mtz），用于 GitHub Pages / HTTP 部署（SAB 高性能需 COOP/COEP）。

## 运行

- **推荐**：双击 `play.cmd`（本地 HTTP + COOP/COEP，SAB 高性能）
- **或**：`python ..\src\serve.py 8080 .` 后访问 `http://localhost:8080/dist/index.html`（dev 页面 `web/index.html`）
- `file://` 双击 single 构建也可玩（MsgState 降级；SAB 高性能需 HTTP）

> **注意（如实记录）**：仓库内 `web/*.js` 与 `dist/*` 为 2026-08-07 旧架构（v3：load-bsp
> 协议、Worker-B 预测）构建产物，与当前 `src/`（v7 公共化）不匹配——**运行前请先
> `npm run build:ts`（dev）或 `build-dist.cmd`（dist）重建**；`play.cmd` 不自动构建。
> 另：`game/web/predictor.js` 为旧双 Worker 时代 gitignored 残留产物（build-dist 清理列表
> 含之）；`src/worker/worker-types.ts` 协议类型落后于实现（头注释仍为 v3 旧协议、联合
> 类型缺 world-json/set-spawn-points/sync-render-state/teleport-to-pos/input——运行时
> 协议以 `src/ts-shared/auth/worker-dispatch.ts` 为准）。

## 控制

- WASD 移动 · 空格跳 · Ctrl 蹲 · Shift 慢走 · Q/E 转视角 · R 重生（**全部可自定义**，面板「按键」模块录制 + localStorage 持久化）
- 点击画布锁定；ESC 打开面板（未锁定时）；M 手动开关；面板「关闭」仅隐藏不锁定
- 面板（两栏七模块）：**通用**（加载地图/重生/出生点）、物理（tickRate 48-128 联动、
  重力/加速/空加/摩擦/autobhop）、体型（半宽/站高/蹲高）、按键、操作（灵敏度/Q-E）、
  显示（准星/速度模式/纹理画质/近平面参数）、视角（noclip 切换 + 速度 200-3000，Shift 再 ×4）

## 规模

| 层 | 说明 |
|---|---|
| TS | ~3,062 行 / 14 文件（不含共享 src/ts-shared ~1,480 行，2026-08-11 实测） |
| Rust 物理 | 2,821 行 / 4 文件（world/player/teleport/mod，共享仓库根 src/phys，2026-08-13 实测） |
| scene-data | GLB + spawn/pvs 小 JSON（-95%） |
| 消息协议 | 约 14 种（init/wasm-init/world-json/config/respawn/sync-render-state/set-spawn-points/teleport/teleport-to-pos/set-death-threshold/input/phys-frame/phys-event/error）——其中 `set-death-threshold`/`teleport-to-pos` 为共享层已定义但 **game 主线程实际未发送**（权威 Worker 死亡阈值恒为 Rust 默认 -100000，见 physics.md §8） |

## 文档（`game/docs/`）

- `overview.md` — 总览与工程结构
- `physics.md` — 物理时序（主线程物理线 + 权威帧校准）
- `panel.md` — 面板控件与持久化
- `materials.md` — 画质切换与缺失纹理回退

> 公共架构见根 `docs/architecture.md`；时序见 `docs/timing-game.md`、`docs/timing-debug.md`；
> 验证工程（双模物理 + 帧信号渲染时序）见 `../test/README.md` + `test/CONCLUSION.md`。
