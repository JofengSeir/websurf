/**
 * 角度换算共享单点（D-08，级别 A′）。
 *
 * 上提来源（原 4 份副本）：
 * - `src/ts-shared/phys/world-builder.ts`（私有 `bspYawToCsYaw`）
 * - `apps/debug/src/world/spawn-loader.ts`（私有 `bspYawToCsYaw`）
 * - `apps/debug/src/world/teleport-manager.ts`（私有 `bspYawToCsYaw`）
 * - `apps/viewer/src/core/pose.ts`（`bspYawToCsYaw` + `wrapDeg`）
 *
 * **语义归一口径（A′ 档必写，见 framework-decoupling §2.3 边界 4 末条）**：
 * 采纳 **viewer 版**，即 `wrapDeg` **带 `|| 0`**。两支的差异只有 1 个语义 token：
 * 纯模运算版 `(((d % 360) + 360) % 360)` 对归一结果为 `-0` 的输入（如 `d = -180`、
 * `d = -0`）返回 `-0`；`|| 0` 版返回 `+0`。`-0 === 0` 为真，故既有调用方的等值/排序
 * 语义零回归，`+0` 只是覆盖 `-0` 取值域的超集，不引入新行为。
 * 更早的第三条分支写法（`bspYawToCsYaw` 原来只做模运算、不调用 `wrapDeg`）与
 * 「`wrapDeg` 带 `|| 0`」在浮点意义下强等价：`(((x % 360) + 360) % 360)` 的非零结果
 * 与 `(((x % 360) + 360) % 360) || 0` 逐位相同（仅 `-0` → `+0`）。故本单点可同时
 * 替换 4 处而不改变任何一处的非零输出。
 *
 * 注意：服务端/渲染端约定的**同一地图出生朝向**是跨工程契约，本文件是该契约唯一实现。
 */

/** 角度归一到 [0,360)。0 结果归一为 `+0`（`-0` → `0`，避免 `Object.is` / 序列化差异）。 */
export function wrapDeg(d: number): number {
  return (((d % 360) + 360) % 360) || 0;
}

/**
 * BSP 出生点实体 Source yaw → cs-movement yaw：`wrap(src + 180)`。
 *
 * 推导：本轴映射 `[x,y,z] → [y,z,x]` 为 det=+1 循环置换，Source 前向
 * `(cos yaw, sin yaw)` 置换后 → `(sin yaw, cos yaw)`；消费端 yaw 0 = 朝 −Z
 * （fwd = `(−sin, −cos)`），恒等式即 +180。旧式 `(270 − yaw)` 是 det=−1 镜像映射
 * （surf_null primary spawn Source yaw=180 应为 0°，旧式给 90°），2026-09 已废弃。
 */
export function bspYawToCsYaw(bspYaw: number): number {
  return wrapDeg(bspYaw + 180);
}
