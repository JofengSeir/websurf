# 录像转化脚本（.js）规范 — 给 AI 的完整说明

> 用途：你（AI 助手）收到一段**任意结构的录像 JSON 样例**，需要产出一份 viewer 可用的
> **.js 转化脚本**。把本规范全文 + 用户的 JSON 样例喂给任何 AI，即可得到可用脚本。
> 产出后用户把 `.js` 文件**拖进 viewer 窗口**（或录像页「载入规则脚本…」、深链 `?rule=`）即可播放。

---

## 1. 你要产出的东西

一个**只包含单个 JS 表达式的文本文件**。这个表达式求值为一个帧映射函数：

```js
(raw, i, H) => ({
  t:    /* 秒，单调递增（number）*/,
  pos:  /* [x, y, z] 三个 number，viewer 世界坐标（见 §2）*/,
  ang:  /* [yaw, pitch, roll] 三个 number，单位度（见 §2）*/,
  vel:  /* [vx, vy, vz] 或 null */,
})
```

- `raw`：帧数组里的一个原始帧对象（结构以用户的 JSON 样例为准）
- `i`：帧序号，从 0 开始
- `H`：辅助函数集（见 §3）
- **文件内容就是这个表达式**（可带前置 `//` 注释）。不要写 `const`/`module.exports`/`export`，
  不要 IIFE 包裹——viewer 用 `new Function('H', 'return (' + 源码 + ');')` 编译它。

### 帧数组定位

viewer 会自动在 JSON 里找「元素为对象的最长数组」当帧序列。如果帧数组藏得特殊
（如 `data.ticks`、`recording.frames[0].ticks`），不要硬凑——在规则 JSON 里写 `framePath`
（见 §5），或在给你的说明里让用户改用「规则 JSON」方式载入。

## 2. 目标坐标约定（必须严格遵守）

viewer 世界坐标与 Source/Hammer 完全不同，映射错了会看到轨迹穿墙/悬空/侧转 90°：

| 项 | 约定 |
|---|---|
| 单位 | HU（Hammer Unit），**不缩放**（源数据若是米/英寸，先换算成 HU） |
| 轴向 | **Y-up**：`pos[1]` 是高度。Source 的 Z-up 数据 → `(x, y, z)_源 → (y, z, x)_viewer` |
| `pos` | **人物脚底**（不是眼位；眼位数据要减 `H.EYE` = 64.09） |
| `ang[0]` | pitch，度，**正 = 仰视**，会被限幅 ±89°。Source pitch 正 = 俯视，**要取反** |
| `ang[1]` | yaw，度，**0 = 面朝 −Z，逆时针为正**，归一到 [0,360)。Source 世界坐标下 `viewerYaw = yaw + 180` |
| `ang[2]` | roll，度，一般源数据没有就填 0 |
| `t` | **秒**。tick 数据 → `i / tickrate`；毫秒 → `/ 1000`；必须单调不减 |
| `vel` | **世界速度** `[vx,vy,vz]`（HU/s），没有就 `null`。⚠ Shavit 的 `vel` 字段是按键命令打包（forwardmove \| sidemove<<16），**不是世界速度——不要映射** |

> Source/Shavit 定标结论（2026-09-03 用 surf_null.bsp + surf_null_4.replay 实测）：
> 位置 `(x,y,z) → (y,z,x)`（与 GLB 导出、出生点解析同一变换）、`viewerYaw = yaw + 180`、
> pitch 取反。按这个映射，录像首帧距最近出生点 191 HU；用 `(x,z,−y)` 则是 5706 HU。

## 3. H 辅助函数集

| 调用 | 作用 |
|---|---|
| `H.get(raw, "a.b[0].c")` | 按 `.` / `[n]` 路径取值，缺失返回 `undefined` |
| `H.num(v)` | 转数字；`undefined`/`null`/NaN 等无效值返回 `NaN`（build 层会兜底并计数告警，但应尽量自己保证有效） |
| `H.wrap(deg)` | 角度归一到 [0,360) |
| `H.clampPitch(deg)` | pitch 限幅 ±89° |
| `H.deg(rad)` | 弧度 → 度 |
| `H.EYE` | 站立眼高 64.09（输入是眼位时减它） |
| `H.clamp(v, lo, hi)` | 通用限幅 |

## 4. 校验与容错（了解即可）

- viewer 会对**第 0 / 中间 / 最后一帧**试跑你的函数（probe）：语法错、字段路径错、产出 NaN
  都会被抓到并报「第 N 帧的 X 不是三个有效数字……」，不会静默吞掉
- 个别帧缺字段：`pos`/`ang` 无效时沿用上一帧值并告警；`t` 回退时按上一帧时间兜底
- 脚本抛异常会直接报导入失败——对可能缺失的字段做防御（`H.num` 已兜底为 NaN，NaN 会被兜底）

## 5. 两种交付形态

1. **裸 .js 文件**（推荐）：文件内容 = §1 的表达式。拖进窗口即用。
2. **规则 JSON**（需要 `framePath` 或想附带 `transform` 时用）：

```json
{
  "version": 1,
  "name": "某某录像格式",
  "scriptSrc": "(raw, i, H) => ({ /* 同上 */ })",
  "framePath": "data.ticks",
  "transform": { "offset": [0, 0, 0], "yawDeg": 0 }
}
```

- `transform` 是**人工微调**（viewer 侧在脚本输出之后统一施加：平移 + 绕 Y 旋转），
  给用户在「变换调整」面板里对齐地图用——AI 一般填全零或干脆省略
- 判定规则：文本 trim 后以 `{` 开头按规则 JSON 解析（须有 `version:1` + `scriptSrc`），
  否则一律按裸脚本文本处理

## 6. 完整示例 A：viewer 自家标准格式

自家格式无需脚本（内置默认规则），这里作为最小范例：

```js
// 自家标准格式：pos/ang/vel 直通，tick 128
(raw, i, H) => ({
  t: i / 128,
  pos: [H.num(H.get(raw, "pos[0]")), H.num(H.get(raw, "pos[1]")), H.num(H.get(raw, "pos[2]"))],
  ang: [H.wrap(H.num(H.get(raw, "ang[1]"))), H.clampPitch(H.num(H.get(raw, "ang[0]"))), 0],
  vel: [H.num(H.get(raw, "vel[0]")), H.num(H.get(raw, "vel[1]")), H.num(H.get(raw, "vel[2]"))],
})
```

注意自家帧的 `ang` 是 `[pitch, yaw]` 序（pitch 在前）——映射时别接反。

## 7. 完整示例 B：Source / Shavit 系录像（Z-up → viewer）

```js
// Source 系（Shavit .replay / Source demo / BSP 实体）→ viewer
// 位置 (x,y,z)→(y,z,x)，viewerYaw = yaw + 180，pitch 取反（Source 正=俯视）
// ⚠ Shavit 帧里的 vel 是按键命令打包，不是世界速度——输出 null
(raw, i, H) => ({
  t: i / 128,
  pos: [H.num(H.get(raw, "pos[1]")), H.num(H.get(raw, "pos[2]")), H.num(H.get(raw, "pos[0]"))],
  ang: [H.wrap(H.num(H.get(raw, "ang[1]")) + 180), H.clampPitch(-H.num(H.get(raw, "ang[0]"))), 0],
  vel: null,
})
```

（Shavit 帧 `ang = [pitch, yaw]`；若你的源数据 yaw/pitch 字段名不同，按实际样例取路径。）

## 8. 提示词模板（用户复制粘贴用）

> 我是 WebSurf-viewer 的用户。请严格按下面的规范，为我提供的录像 JSON 写一个转化脚本
> （.js 文件）。要求：
> 1. 文件内容是**求值为 `(raw, i, H) => ({t, pos, ang, vel})` 的单个 JS 表达式**，可带 `//` 注释，
>    不要 const/export/IIFE；
> 2. 严格遵守目标坐标约定：HU、Y-up、脚底坐标、yaw 0=−Z 逆时针为正、pitch 正=仰视 ±89°、
>    t 为秒且单调不减；
> 3. Source/Shavit 系数据用 `(x,y,z)→(y,z,x)`、`yaw+180`、pitch 取反，vel 若是按键打包则输出 null；
> 4. 对缺失字段做防御，输出 `[vx,vy,vz]` 世界速度或 null；
> 5. 只输出 .js 文件内容本身，不要任何解释或代码围栏。
>
> 【规范】（粘贴本文件 §1–§7）
> 【我的录像 JSON 样例】（粘贴首帧或前几帧 + 整体结构说明）

## 9. 产出后如何自检

1. 把 `.js` 拖进 viewer 窗口（先载入一份该格式的 `.json` 录像，或先拖 .js 再拖录像均可——
   改规则会自动重新导入当前轨道）
2. 看「起点对齐」note：录像起点距最近出生点 ≤128 HU 即基本正确
3. 还差整体偏移/侧转 → 「变换调整」区平移 / `yaw ±90°` 微调（这是给人用的，不用改脚本）
4. 报「第 N 帧的 X 不是三个有效数字」→ 检查对应字段的取值路径与 NaN 防御
