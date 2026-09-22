# implementation / config（`apps/game/src/config.ts`）

## 模块职责

本工程的运行时配置模块：结构定义（七段）、默认值、段级部分更新与物理参数薄映射。导出清单：

| 导出 | 类型 | 职责 | 锚点 |
|---|---|---|---|
| `PhysicsConfig` | 接口 | 物理段（14 个字段：模式、tickRate、重力、跳跃、速度、摩擦、加速、连跳、蹲走、传送门槛） | `apps/game/src/config.ts:22` |
| `InputConfig` | 接口 | 输入段（灵敏度、pitch 限位、Q/E 转向速度、noclip 速度） | `apps/game/src/config.ts:62` |
| `PlayerConfig` | 接口 | 碰撞箱三尺寸（三项都走 `set_hull`，不是 `set_params` 的键） | `apps/game/src/config.ts:83` |
| `CrosshairConfig` | 接口 | 准星风格（颜色、长度、粗细、间隙、描边、中心点） | `apps/game/src/config.ts:92` |
| `HudConfig` | 接口 | HUD 段（准星开关、速度模式、准星风格、FOV、渲染距离） | `apps/game/src/config.ts:107` |
| `TextureConfig` | 接口 | 画质段（`original` / `mini`） | `apps/game/src/config.ts:125` |
| `LightingConfig` | 接口 | 光照段（曝光、γ、模型光照、逐顶点重建两档、光照模式） | `apps/game/src/config.ts:131` |
| `RuntimeConfig` | 接口 | 顶层：`lockTickRate` + 七段 | `apps/game/src/config.ts:163` |
| `DEFAULT_CONFIG` | 常量 | 唯一默认值来源 | `apps/game/src/config.ts:176` |
| `createConfig` | 函数 | `structuredClone(DEFAULT_CONFIG)`，两端各建一份副本 | `apps/game/src/config.ts:239` |
| `applyConfigPatch` | 函数 | 按段 `Object.assign` 合入 patch | `apps/game/src/config.ts:245` |
| `buildPhysicsParams` | 函数 | 把 `RuntimeConfig` 映成 Rust `set_params` 的 snake_case 参数对象 | `apps/game/src/config.ts:259` |

## 关键流程与不变量

- **两份副本**：主线程在 `apps/game/src/app.ts:41` 建一份，Worker 在 `apps/game/src/worker/main.ts:77` 另建一份；两端各自映射参数，由同一份下发消息保证同值（`apps/game/src/input/input-bridge.ts:58`、`apps/game/src/worker/main.ts:88`）。
- **默认值只写一处**：`createConfig` 用 `structuredClone` 复制 `DEFAULT_CONFIG`（`apps/game/src/config.ts:240`），避免面板改动污染默认值。
- **映射是薄层**：`buildPhysicsParams` 只做字段名搬运，键名归一与 `jump_height = jumpSpeed² / (2 × gravity)` 的换算都在共享层（`src/ts-shared/phys/params.ts:49`、`src/ts-shared/phys/params.ts:58`）；`sensitivity` 在共享层被写死为 1（`src/ts-shared/phys/params.ts:67`），真实灵敏度由输入层乘入（`src/ts-shared/input/input-layer.ts:25`）。
- **段级更新不做校验**：`applyConfigPatch` 在段不存在或不是对象时静默返回，patch 里出现段中不存在的键时照写（`apps/game/src/config.ts:250`、`apps/game/src/config.ts:252`）。
- **只发四段**：`syncFullConfig` 的段表是 `physics` / `input` / `player` / `hud`（`apps/game/src/app.ts:642`）；`texture` 与 `lighting` 段不下发 Worker——本工程内这两段的读取点全部在主线程（`apps/game/src/renderer/renderer-main.ts:451`、`apps/game/src/renderer/renderer-main.ts:266`）。
- **面板量程与默认值一致的两处**：`lightGamma` 默认 2.2 与页面滑块初值 2.2 同值（`apps/game/src/config.ts:228`、`apps/game/web/index.html:228`），`fov` 默认 73.6 与滑块初值 73.6 同值（`apps/game/src/config.ts:209`、`apps/game/web/index.html:222`）。

## 已知缺口

- **`physics.mode` 零读取点**：字段只有声明与默认值（`apps/game/src/config.ts:27`），本工程内没有读取者。权威侧的模式判定读的是消息里的 `patch.mode`（`src/ts-shared/auth/worker-dispatch.ts:385`），不是这份 config 的字段。
- **`input.pitchLimit` 零读取点**：只有声明与默认值 89（`apps/game/src/config.ts:70`、`apps/game/src/config.ts:197`），`apps/game/src` 内无读取者；pitch 限幅实际由 Rust 侧承担。
- **`lighting.lightGamma` 的默认值落在着色器接受窗口之外**：默认 2.2（`apps/game/src/config.ts:228`），而 `setLightGamma` 只接受 `(0, 1]`，窗口外的值直接返回、不写共享 uniform（`apps/game/src/renderer/lightmap-shader.ts:1789`）。因此 `init` 阶段那次初始化写入被忽略（`apps/game/src/renderer/renderer-main.ts:270`），共享 uniform 保持其自身初值（`apps/game/src/renderer/lightmap-shader.ts:1556`）。
- **面板滑块量程与该接受窗口不一致**：滑块量程 0.5..6（`apps/game/src/panel/panel-controller.ts:471`、`apps/game/web/index.html:228`），拖到大于 1 时 `config.lighting.lightGamma` 变了、画面不变。
- **`applyConfigPatch` 照写未知键的副作用**：把非 `physics` / `input` 段的消息载荷原样写入对应段（`apps/game/src/config.ts:252`、`src/ts-shared/auth/worker-dispatch.ts:351`）；本工程对 `hud` 段下发的其实是全量物理参数（`apps/game/src/input/input-bridge.ts:65`），于是 Worker 的 `config.hud` 会被并入 `gravity` / `run_speed` 等键（`src/ts-shared/phys/params.ts:49`）。Worker 不读 `hud` 段，静态看无行为影响。
- **段表与 `RuntimeConfig` 的段数不等**：顶层有七段（`apps/game/src/config.ts:163`），下发表只有四段（`apps/game/src/app.ts:642`）；`texture` / `lighting` / `lockTickRate` 不进 `config` 消息，改这三处的效果只在本端可见。
- **`lockTickRate` 的写死值分布两处**：`syncFullConfig` 覆写 `config.physics.tickRate = 64`（`apps/game/src/app.ts:640`），面板构造时也写死 64 并禁用两个控件（`apps/game/src/panel/panel-controller.ts:286`、`apps/game/src/panel/panel-controller.ts:290`）；两处都硬编码 64，改默认值需同时改三处（含 `DEFAULT_CONFIG` 的 `tickRate: 64`，`apps/game/src/config.ts:181`）。
