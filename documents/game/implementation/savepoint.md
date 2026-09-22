# implementation / savepoint（`apps/game/src/savepoint.ts`）

## 模块职责

存点（SavePoint）模块：一个数据结构、一个容量常量与一个存储类。

| 导出 | 职责 | 锚点 |
|---|---|---|
| `SavePoint` 接口 | 存点字段：位置三轴、朝向两轴、速度三轴、着地状态与时间戳 | `apps/game/src/savepoint.ts:21`、`:32` |
| `SAVEPOINT_MAX` | 存点列表上限 50 | `apps/game/src/savepoint.ts:36` |
| `SavePointStore` 类 | `load` / `getMap` / `all` / `add` / `delete` / `clear` / `latest` / `persist` | `apps/game/src/savepoint.ts:42`、`:49`、`:69`、`:74`、`:79`、`:89`、`:98`、`:104`、`:109` |

## 关键流程与不变量

- **按地图分键持久化**：localStorage 键 = 固定前缀 + 地图名（`apps/game/src/savepoint.ts:39`、`:54`、`:112`）；地图名来自 BSP 文件名去掉后缀（`apps/game/src/app.ts:501`），换图即换键。
- **容量上限的两种截断**：`add` 超出时遗弃最早一条（`apps/game/src/savepoint.ts:81`），`load` 载入时只保留末尾 `SAVEPOINT_MAX` 条（`apps/game/src/savepoint.ts:58`）。
- **读写失败都不抛出**：读失败打 `console.error` 并清空内存列表（`apps/game/src/savepoint.ts:61`）；写失败打 `console.error`、内存列表不受影响（`apps/game/src/savepoint.ts:113`）。
- **`load('')` 与空地图名不落盘**：地图名为空时 `load` 只清内存不读存储（`apps/game/src/savepoint.ts:52`），`persist` 直接返回（`apps/game/src/savepoint.ts:111`）。
- **读取路径**：X 键存点写完整状态加时间戳（`apps/game/src/app.ts:610`）；按住 C 取 `latest()` 并冻结（`apps/game/src/app.ts:619`、`apps/game/src/app.ts:625`），松开 C 恢复速度并向权威同步（`apps/game/src/app.ts:632`）；面板列表的「读」按索引取 `all()` 的第 i 项（`apps/game/src/app.ts:209`）。
- **状态来源单一**：存点字段直接来自渲染物理的 `state()`（`apps/game/src/renderer/renderer-main.ts:757`），读点时经 `set_state` 全量写回（`apps/game/src/renderer/renderer-main.ts:789`）。

## 已知缺口

- **`SavePoint.t` 只写不读**：字段由存点构造时写入（`apps/game/src/app.ts:610`），本工程内没有读取点——面板列表按插入顺序渲染（`apps/game/src/panel/panel-controller.ts:791`），不按时间排序。
- **`getMap()` 零调用点**：方法有完整实现（`apps/game/src/savepoint.ts:69`），`apps/game/src` 内无调用者（面板与加载流程都不需要回读地图名）。
- **`clear()` 零调用点**：方法会清空列表并落盘（`apps/game/src/savepoint.ts:98`），`apps/game/src` 内无调用者；换图走的是 `load`（`apps/game/src/app.ts:502`），它同样会清空内存列表但**不写存储**（`apps/game/src/savepoint.ts:51`），因此被换掉的地图存档保留在 localStorage 里。
- **删除无二次确认**：面板删除按钮的回调直接调用 `onSavePointDelete`（`apps/game/src/panel/panel-controller.ts:812`），`delete` 立即 `persist`（`apps/game/src/savepoint.ts:92`）；越界索引既不报错也不写存储（`apps/game/src/savepoint.ts:90`）。
- **存点不含蹲伏态**：字段集没有蹲下高度或姿态标记（`apps/game/src/savepoint.ts:21`），读点时的 `eyeHeight` 取渲染物理的**当前**值（`apps/game/src/renderer/renderer-main.ts:794`、`:803`），在蹲伏中读点会把当前眼高带进新状态。
- **解析结果不是数组时静默保持空列表**：`load` 只在 `Array.isArray` 为真时赋值（`apps/game/src/savepoint.ts:57`），存档被写成对象或字符串时不会报错，表现为该地图没有存点。
- **写入量随存点条数线性增长**：`persist` 每次整表序列化（`apps/game/src/savepoint.ts:112`），`add` / `delete` / `clear` 都各自触发一次整表写入。
