# 录像转化脚本（.js）规范 — 给 AI 的说明

> 你（AI 助手）会收到一段**任意结构的录像 JSON 样例**，任务是产出一份 viewer 可用的
> **.js 转化脚本**。把本规范全文 + 用户样例交给任何 AI，即可得到可用脚本；用户把 `.js`
> **拖进 viewer 窗口**（或录像页「载入规则脚本…」、深链 `?rule=`）即可播放。
>
> 本文按当前代码核验重写（2026-09 重编纂版）；上一版见 `archive/replay-rule-ai.md`（仅背景）。
> 每条契约都标注来源代码位置；工程侧入口引用见 `src/replay/panel.ts:111,126`、
> `src/replay/timeline.ts:156`、`web/index.html:69`、`README.md` 与根 `docs/`（本文即被这些位置引用）。

## 1. 你要产出的东西

一个**只包含单个 JS 表达式的文本文件**，表达式求值为帧映射函数 `(raw, i, H) => Frame`：

```js
(raw, i, H) => ({
  t:   /* 秒，number，单调不减（相等合法）*/,
  pos: /* [x, y, z] 三个 number —— viewer 世界坐标脚底位（Y-up，见 §2）*/,
  ang: /* [yaw, pitch, roll] 三个 number，单位度（见 §2）*/,
  vel: /* [vx, vy, vz] 世界速度 HU/s，或 null */,
})
```

编译契约（`viewer/src/replay/codegen.ts:14-22`，原样）：

```ts
const body = src.trim().replace(/;+\s*$/, '');            // 剥尾分号只是容错
const factory = new Function('H', '"use strict";\nreturn (' + body + ');');
return factory(REPLAY_HELPERS);
```

由此推出硬性要求：

- 文件内容 = `return (你的表达式)` 能合法求值——**不要写 `const`/`export`/`module.exports`/IIFE**；
- **结尾不要写分号**（`codegen.ts:16` 的剥离只是容错，不要依赖）；
- 可以带前置 `//` 注释（trim 后整体包进 `return (…)`）；
- `H` 在编译期固定为 `REPLAY_HELPERS`（`codegen.ts:7,22`），见 §3。

**帧数组定位**：viewer 自动在 JSON 里找「元素为对象的最长数组」当帧序列（`viewer/src/replay/helpers.ts:93-145`：广度遍历深度 ≤4、遍历中候选 >60 停止、排序后取前 30）。帧数组藏得特殊（如 `data.ticks`）时不要硬凑——用规则 JSON 的 `framePath` 显式指定（§6）。

## 2. 标准帧约定（映射目标，必须严格遵守）

来源：`viewer/src/replay/types.ts:96-105`（Frame 字段注释即契约，97-104）、`viewer/src/core/pose.ts:5-9`、`viewer/src/core/constants.ts:6-7`。

| 项 | 约定 |
|---|---|
| 单位 | HU（Hammer Unit），**不缩放**（源数据是米/英寸先换算） |
| 轴向 | **Y-up**：`pos[1]` 是高度 |
| `pos` | **人物脚底**（不是眼位；眼位数据减 `H.EYE` = 64.09，同值见共享物理 `src/phys/player.rs:34`） |
| `ang[0]` | **yaw**，度，0 = 面朝 −Z、**逆时针为正**（第一人称相机写法 `rotation.set(pitch, yaw, roll, 'YXZ')`，`viewer/src/core/fly.ts:174-177`），输出前用 `H.wrap` 归一 |
| `ang[1]` | **pitch**，度，**正 = 仰视**，用 `H.clampPitch` 限幅 ±89° |
| `ang[2]` | roll，度，没有就 0 |
| `t` | **秒**，单调不减。tick 数据 → `i / tickrate`；毫秒 → `/ 1000` |
| `vel` | **世界速度** `[vx,vy,vz]`（HU/s）或 `null`。⚠ Shavit 的 `vel` 字段是按键命令打包，**不是世界速度——输出 null**（`viewer/README.md:205` 故障排查表；`viewer/test/replay-selftest.ts:178` 的 Source 示例即输出 `vel: null`） |

## 3. H 助手集（`viewer/src/replay/helpers.ts:21-74`）

| 调用 | 行为 |
|---|---|
| `H.get(root, "a.b[0].c")` | 按 `.` / `[n]` 路径取值，缺失返回 `undefined`（`helpers.ts:21-38`） |
| `H.num(v)` | 转数字；无效值 → `NaN`（`helpers.ts:41-45`；NaN 会被 build 层兜底并告警，但应自己保证有效） |
| `H.wrap(d)` | 角度归一 [0,360)（`helpers.ts:48-50`） |
| `H.clampPitch(d)` | pitch 限幅 ±89°（`helpers.ts:53-56`） |
| `H.deg(rad)` | 弧度 → 度（`helpers.ts:59-61`） |
| `H.EYE` | 站立眼高 64.09（`helpers.ts:71`，复用 `core/constants.ts:7`） |
| `H.clamp(v, lo, hi)` | 通用限幅 |

## 4. 校验与容错（了解即可，别依赖兜底）

- **三帧试跑**：导入前对第 0 / 中间 / 最后帧各执行一次（`viewer/src/replay/codegen.ts:36-74`）。语法错、字段路径错、产出 NaN/非法结构都会被抓到，报错带帧号与原始值（如 `第 0 帧的位置不是三个有效数字（[null,null,null]）——检查位置字段路径与轴映射`）。
- **逐帧兜底**：试跑只抽三帧，个别坏帧漏网时 build 层接住——`t` 回退沿用上一帧、`pos/ang` 出 NaN 沿用上一帧并计告警（`viewer/src/replay/build.ts:64-99`）。告警会在导入摘要里看到；**有告警 = 映射有字段性问题，应修脚本而不是视而不见**。
- 脚本抛异常 = 导入失败（probe 阶段即报），对可能缺失的字段做好防御。

## 5. 坐标系换算（Source 系数据必读）

**viewer 的地图坐标系**（GLB 顶点与出生点共用的变换）：

- `map_coords`：`[x, y, z]_Source(Z-up) → [y, z, x]_viewer(Y-up)`，无符号翻转（`src/wasm-core/bsp_to_gltf_core/convert.rs:813-816`、`src/wasm-core/model_integrator/mod.rs:1041-1045`）；
- 出生点同变换：`rotate_yup`（`viewer/crates/wasm/src/lib.rs:339-342`）。

**录像必须走同一变换，否则轨迹相对地图整体绕竖直轴旋转 90°**。Source 系录像的定标结论以**可执行断言**固化在自检里（`viewer/test/replay-selftest.ts:164-196`）：

- 位置：`[x, y, z] → [y, z, x]`（断言：Source +X 位移 → viewer +Z、Source 竖直 Z → viewer Y，`replay-selftest.ts:183-186`）；
- 朝向：`viewerYaw = srcYaw + 180`（断言：yaw=0 → viewerYaw=180（面朝 +Z），且视角方向与运动方向 cos > 0.999，`replay-selftest.ts:187-192`）；
- pitch：Source 正 = 俯视 → viewer **取反**（断言：Source pitch +30 → viewer −30，`replay-selftest.ts:193-195`）。

> 出生点实体用的是另一套换算（BSP 方位角顺时针 → viewer 逆时针：`bspYawToCsYaw = (270 − yaw) mod 360`，`viewer/src/core/pose.ts:12-14`）。写**录像**脚本时用上面 `+180` 那套（以 selftest 断言为准），不要混用。

## 6. 两种交付形态（`viewer/src/replay/rule-file.ts:17-31`）

判定：文本 trim 后以 `{` 开头 → 按规则 JSON 解析（须 `version: 1` + `scriptSrc` 字符串，否则报错**不会**当脚本）；否则整段按裸脚本文本处理。

1. **裸 .js 文件**（推荐）：内容 = §1 表达式，拖进窗口即用。
2. **规则 JSON**（需要 `framePath` / 想附带 `transform` / 想给规则命名时）：

```json
{
  "version": 1,
  "name": "某某录像格式",
  "scriptSrc": "(raw, i, H) => ({ /* §1 表达式 */ })",
  "framePath": "data.ticks",
  "transform": { "offset": [0, 0, 0], "yawDeg": 0 }
}
```

- `transform` 是**人工微调**：viewer 在脚本输出之后统一施加（平移 + 绕 Y 旋转 pos/vel/yaw 同步，`viewer/src/replay/build.ts:157-205`）。AI 一般填全零或省略——对齐是给人用的「变换调整」面板（500ms 防抖重导 + 一键锚定，`viewer/src/replay/panel.ts:344-385, 462-485`）。
- 其余声明式字段（posX/axisX/sign…）是给"不写脚本"场景的旋钮（`types.ts:29-92`），AI 产码统一用 `scriptSrc`，不要混用两套。

## 7. 两个可直接引用的脚本形态

**A. viewer 自家标准格式**——无需脚本（内置默认规则直通；源码 `viewer/src/replay/default-rule.ts:10-31`，此处摘录其主体）：

```js
(raw, i, H) => {
  const _ix = H.num(H.get(raw, "pos[0]"));
  const _iy = H.num(H.get(raw, "pos[1]"));
  const _iz = H.num(H.get(raw, "pos[2]"));
  const _yaw = H.num(H.get(raw, "ang[0]"));
  const _pitch = H.num(H.get(raw, "ang[1]"));
  return {
    t: i / 128,
    pos: [_ix, _iy, _iz],
    ang: [H.wrap(_yaw), H.clampPitch(_pitch), 0],
    vel: [H.num(H.get(raw, "vel[0]")), H.num(H.get(raw, "vel[1]")), H.num(H.get(raw, "vel[2]"))],
  };
}
```

（自家格式 raw 帧 `ang = [yaw, pitch]` 与标准帧同序，见 `default-rule.ts:4-6`。）

**B. Source / Shavit 系录像**——与自检 §[6] 的可执行示例同构（`viewer/test/replay-selftest.ts:170-180` 原样，该脚本被 §5 三条断言验证）：

```js
(raw, i, H) => {
  const p = H.get(raw, 'pos');
  const yaw = H.num(H.get(raw, 'ang[1]'));
  const pitch = H.num(H.get(raw, 'ang[0]'));
  return {
    t: i / 128,
    pos: [H.num(p[1]), H.num(p[2]), H.num(p[0])],
    ang: [H.wrap(yaw + 180), H.clampPitch(-pitch), 0],
    vel: null,
  };
}
```

（Shavit 帧字段名 `ang = [pitch, yaw]`；你的源数据字段名若不同，按实际样例取路径。）

## 8. 提示词模板（用户复制粘贴用）

> 我是 WebSurf-viewer 的用户。请严格按下面的规范，为我提供的录像 JSON 写一个转化脚本（.js 文件）：
> 1. 文件内容是**求值为 `(raw, i, H) => ({t, pos, ang, vel})` 的单个 JS 表达式**，可带 `//` 注释；不要 const/export/IIFE；结尾不要分号。
> 2. 严格遵守标准帧约定：HU、Y-up、脚底坐标、yaw 0 = −Z 逆时针为正（`H.wrap` 归一）、pitch 正 = 仰视（`H.clampPitch` 限幅 ±89°）、t 为秒且单调不减。
> 3. Source/Shavit 系数据按定标结论映射：位置 `(x,y,z)→(y,z,x)`、`viewerYaw = yaw + 180`、pitch 取反；`vel` 若是按键打包则输出 `null`，是世界速度才直通。
> 4. 对缺失字段做防御（`H.num` 兜 NaN 也会告警，尽量直接取对）。
> 5. 只输出 .js 文件内容本身，不要任何解释或代码围栏。
>
> 【规范】（粘贴本文件 §1–§7）
> 【我的录像 JSON 样例】（粘贴首帧或前几帧 + 整体结构说明，如帧数组在哪个字段下）

## 9. 产出后如何自检

1. 把 `.js` 拖进 viewer 窗口（先载一份该格式的 `.json`，或先拖 .js 再拖录像均可——**改规则 = 替换当前轨道**，不会刷出重复轨迹，`viewer/src/replay/panel.ts:413-423` + `viewer/src/replay/tracks.ts:49-54`）。
2. 看录像页「起点对齐」note：录像起点距最近出生点 ≤128 HU 即基本贴合（`panel.ts:443-460`；阈值口径见帮助浮层 `web/index.html:72-74`）。
3. 还差整体偏移/侧转 → 「变换调整」区平移 / `yaw ±90°` / 一键锚定（这是给人用的，不用改脚本）。
4. 报「第 N 帧的 X 不是三个有效数字」→ 按报错里的原始值检查对应字段路径（§4）。
5. Node 环境可跑 `npm run test:replay` 验证管线与定标断言（`viewer/test/replay-selftest.ts`，11 节）。
