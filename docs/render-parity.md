# 渲染归属与三端等价（2026-10-23 收口）

## 0. 规则速览

**一句话**：渲染步骤只允许存在于 `src/renderer-shared/scene/render-session.ts`；apps 只保留数据源、输入、端特有 overlay。

| 必须 | 禁止 |
|---|---|
| 新渲染步骤先进 `RenderSession` / `assembleScene` | 在 `apps/<app>/src` 里构造 renderer / 相面、写 `scene.background/fog`、做装配 / 合并 / 天空 / 可见性 / 画质步骤 |
| 端特有对象挂到 `session.scene` | 修一处只在某一个端生效（根因都是「接线没共享」） |
| 改渲染后跑 `node src/scripts/check-render-parity.mjs` + 三端 `npm run typecheck` | 用像素脚本代替人工判断 |

> 事故背景：回退 VMT 表最初只在 viewer 的 `core/bsp.ts` 里 `fetch('vmts.json')`，debug/game 没装 ⇒ debug 水层被判缺 VMT、`alpha=0` 不绘制。同类问题还有：`meshInCluster` 三份、`loadScene` 三份、环境/天空/可见性/画质注册三份。修一处只在某一个端看起来有效果，根因都是「接线没共享」。

## 1. 共享会话负责什么

`src/renderer-shared/scene/render-session.ts` 的 `RenderSession` 是**三端唯一**的：

| 阶段 | 内容 |
|---|---|
| `init` | `createRenderer` + `applyRenderPrefs` + Scene/Camera + 只读渲染探针 |
| `loadScene` | `assembleScene`（含主模型合并）→ 挂根/天空层 → `precompileScene` → `applySceneCamera` → 可见性收集/剔除距离 → 环境（背景/反射/雾）→ 贴图画质 |
| `frame` | 可见性判定（距离优先 → PVS）→ 近平面贴墙（隔帧）→ `renderSkyPass`（天空相机 + 主世界） |
| `disposeScene` | 根/天空组/环境/渲染列表/PVS/可见性释放 |

`assembleScene` 仍是「GLB → 终扫」的 7 步契约；`RenderSession` 负责它之后的全部接线，并把 `mergeIntoNewRoot` 作为三端唯一合并入口（game/debug 旧的原地 `optimizeScene` 已删除）。

## 2. 三端保留什么

| 端 | 保留 |
|---|---|
| `apps/viewer` | 本地 BSP/深链装载、自由飞行、回放轨道与 HUD、`worldBox`/拾取 |
| `apps/game` | 物理（主线程 `PhysWorld` + Worker 权威帧）、面板/HUD/存档点/输入 |
| `apps/debug` | 物理、碰撞体/触发器/准星/路径等**可视网格**、A/B 排查开关、按需渲染 |

端特有对象只能挂到 `session.scene`；**不得**再构造 renderer/相机、写 `scene.background/fog`、做装配/合并/天空/可见性/画质步骤。

## 3. 可执行门禁

```bash
node src/scripts/check-render-parity.mjs
```

判据：

1. `apps/<app>/src` 下不得出现渲染器构造、`assembleScene/mergeIntoChunks/renderSkyPass/createSkyCamera/setSceneEnvironment/applySceneCamera/shrinkNearPlane/new VisibilityController/new PvsManager/applySceneTextureQuality` 等调用；
2. 三端渲染入口（viewer `core/scene.ts`、game/debug `renderer-main.ts`）必须引用 `RenderSession` 且调用 `session.loadScene`；
3. 共享会话必须真的包含装配/天空/可见性/dispose 步骤（防被掏空后仍过关）。

CI 里对应 `.github/workflows/ci-gates.yml` 的 `render-parity` job（纯源码、秒级）。

## 4. 同机位看图（本地，不作为 CI 判据）

**看图为准**（owner 规则）：不要用像素统计代替判断。本仓提供一个只负责「同图、同机位、关 HUD、截 canvas」的本地工具：

```bash
# 1) 起本地静态服务（仓库根）
python src/scripts/serve.py 8123 .

# 2) 起带远程调试端口的 Edge（headless + SwiftShader）
msedge.exe --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\edge-cdp ^
  --no-first-run --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1600,900 about:blank

# 3) 三端各截一张（viewer 用 ?bsp= 深链；game/debug 传 --map）
node src/scripts/capture-render.mjs ^
  --url "http://127.0.0.1:8123/apps/viewer/web/index.html?bsp=/test/maps/surf_666.bsp" ^
  --pose "-13214.7,15396.9,-11623.6,164.7,-41" --out .tmp/666-viewer.png

node src/scripts/capture-render.mjs ^
  --url "http://127.0.0.1:8123/apps/game/web/index.html" ^
  --map "<仓库根>\test\maps\surf_666.bsp" ^
  --pose "-13214.7,15396.9,-11623.6,164.7,-41" --out .tmp/666-game.png
```

注意：

1. `--pose` 是**相机位姿**（HU + 度），经各端共享 `globalThis.__vbspPose` 钉住；game/debug 需要约 2.5s 等物理 hold 生效。
2. 三端 canvas 比例可能不同（debug 是布局内画布，game/viewer 整窗）；**先看内容是否一致，再讨论裁切/比例**。
3. 控制台里 `THREE.BufferGeometryUtils: mergeGeometries() failed ... normal attribute` 是**既有**的合批回退告警（合并失败会保留独立几何），不是本次收口引入的渲染错误。

## 5. 已实测的结构等价（2026-10-23，headless Edge）

同一张图、同一档（`?prefs=default` 语义）、同一相机位姿下：

| 指标 | viewer | game | debug |
|---|---|---|---|
| `surf_concretejungle_fix` 合并 | 8705 → 742 块 / 194 天空块 | 同左 | 同左 |
| `surf_666` 合并 | 35287 → 2063 块 | 同左 | 同左 |
| `surf_666` 相机（同 pose） | near 14.6679 / far 3262400 / fov 73.6 | 同左 | 同左 |
| `surf_666` 水面注入（debug 侧读数） | — | — | 4 个 VMT / 290 个材质，含模型内水体 |

同机位截图（666 的坡面机位）三端画面内容一致；差异只剩 canvas 比例与端特有 HUD/overlay。

## 6. 可见性剔除：默认全加载（2026-10-23 owner 决定 D-123）

`src/renderer-shared/scene/visibility-controller.ts`：

1. **默认（档值 0）= 全加载**：`cullDistance = Infinity`，不按距离藏任何块；只靠 three 的相机视锥。
2. **显式正值**才按**块表面**距离剔除（`dist > 视距 + 块半径`）——避免大合并块「中心在视距外、几何贴在脸上」被整块误杀（main `79cff4b` 实测 666 有 44/108 个机位误杀，最近面距到过 0）。
3. 旧行为（块中心距离、默认 `maxDim × 0.5`）已删除。

未采用：rebuild `19b1d4a` 同批的「近裁面 10 射线」（tag `safety-19b1d4a`）。全加载先只解决「块被整块藏掉」；若仍有贴脸几何被 near 裁掉，再单独做近裁面 A/B，不把它混进这次决定。

## 7. 加新渲染特性时的检查清单

1. 能放进 `assembleScene` 的放 `assembleScene`（装配顺序契约）；
2. 属于 load/环境/天空/相机/可见性/画质/每帧 draw 的放 `RenderSession`；
3. 只有端特有数据（本地 BSP、回放、物理、可视网格）留在 `apps`；
4. 跑 `node src/scripts/check-render-parity.mjs` + 三端 `npm run typecheck`；
5. 同机位三张图给 owner 看，不以像素脚本代替判断。
